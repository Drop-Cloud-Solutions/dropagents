/**
 * Repo sync subscribers — bridge the Repo domain events to the actual
 * `gh repo clone` / `git fetch + reset --hard` operations on disk, and
 * publish the outcome back onto the bus so the projection sees the
 * `RepoEnsured` / `RepoEnsureFailed` / `RepoSynced` / `RepoSyncFailed`
 * follow-up events.
 *
 * Two surfaces:
 *
 *   `attachRepoEnsureSubscriber(bus, deps)` — listens to
 *       `RepoRegistered` (and `RepoUpdated`, in case the url changed)
 *       and calls `WorkspaceRepoFetcher.ensureCloned()`. Success →
 *       publishes `RepoEnsured` with the ensured path. Failure →
 *       publishes `RepoEnsureFailed` with the wrapped error so the
 *       Repos modal can show the operator why.
 *
 *   `createRepoRefreshTrigger(deps)` — returned closures the Repo
 *       command handlers call from their fire-and-forget paths:
 *         - `refreshOne(repoId)` — fetch+reset against a single repo
 *         - `refreshAll()` — same, fanned out across the active set
 *       Both publish `RepoSynced` / `RepoSyncFailed` to the bus when
 *       the git work completes.
 *
 * Idempotency: ensure is naturally idempotent (the fetcher no-ops
 * when the directory exists); refresh emits one event per (repoId,
 * occurredAt) so a replay re-uses the same idempotency keys and the
 * event store dedups.
 */

import type { EventBus } from '../../core/events/bus';
import type {
    Event,
    RepoLifecyclePayload,
} from '../../core/events/event';
import type { Logger } from '../../core/ports/Logger';

import { ensureClaudeWorkspaceTrust } from '../claude-cli/claude-trust';
import type { RepoProjectionStore } from '../projections/repo-projection-store';
import type { WorkspaceRepoFetcher, WorkspaceRepoSpec } from './WorkspaceRepoFetcher';

export const REPO_ENSURE_SUBSCRIBER = 'repo-ensure-subscriber';

export interface RepoSyncDeps {
    readonly bus: EventBus;
    readonly clock: () => number;
    readonly logger: Logger;
    readonly fetcher: WorkspaceRepoFetcher;
    readonly projection: RepoProjectionStore;
    /**
     * Env overlay for a declared GitHub account id, or `{}` when the
     * id is absent or unknown. Supplied by the host, which owns the
     * account registry; absent here means every clone and fetch uses
     * the machine's ambient identity, i.e. the behaviour from before
     * accounts existed.
     */
    readonly resolveGithubEnv?: (
        accountId: string | null,
    ) => Readonly<Record<string, string>>;
}

/**
 * Subscribe to `RepoRegistered` / `RepoUpdated` and ensure the
 * corresponding working tree is on disk. Each call is fire-and-forget
 * from the bus's point of view — the actual clone happens in the
 * background and emits its own `RepoEnsured` / `RepoEnsureFailed`
 * event when the gh process returns. Returns the unsubscribe closure.
 */
export function attachRepoEnsureSubscriber(deps: RepoSyncDeps): () => void {
    const { bus } = deps;
    const sub = { subscriber: REPO_ENSURE_SUBSCRIBER };

    const handler = (event: { payload: RepoLifecyclePayload }): void => {
        const p = event.payload;
        if (!p || typeof p.repoId !== 'string' || p.repoId.length === 0) return;
        // Resolved from the EVENT rather than the projection: this
        // subscriber runs before the projection's upsert for the same
        // event is guaranteed to have landed, and the event is the
        // authority for what the operator just saved.
        const githubEnv = deps.resolveGithubEnv?.(p.githubAccount ?? null) ?? {};
        const spec: WorkspaceRepoSpec = {
            repoId: p.repoId,
            url: p.url,
            ...(p.defaultBranch !== undefined ? { defaultBranch: p.defaultBranch } : {}),
            ...(Object.keys(githubEnv).length > 0 ? { githubEnv } : {}),
        };
        // Run ensure on the next tick so the projection's UPSERT for
        // the triggering event commits first — the EnsureSubscriber's
        // RepoEnsured publish goes through the bus and folds into the
        // same row.
        void runEnsure(deps, spec);
    };

    const offRegistered = bus.subscribe<RepoLifecyclePayload>(
        'RepoRegistered',
        async (event) => handler(event),
        sub,
    );
    const offUpdated = bus.subscribe<RepoLifecyclePayload>(
        'RepoUpdated',
        async (event) => handler(event),
        sub,
    );

    return (): void => {
        offRegistered();
        offUpdated();
    };
}

async function runEnsure(deps: RepoSyncDeps, spec: WorkspaceRepoSpec): Promise<void> {
    const at = deps.clock();
    try {
        const ensuredPath = await deps.fetcher.ensureCloned(spec);
        // Trust the fresh clone in Claude Code's config so headless agents
        // don't warn that the workspace is untrusted. Best-effort + awaited
        // so the trust write lands before the first agent runs in the clone.
        await ensureClaudeWorkspaceTrust([ensuredPath], deps.logger);
        const event: Event = {
            type: 'RepoEnsured',
            v: 1,
            occurredAt: at,
            // Key on (repoId, at) so retries land as new events; the
            // projection's monotonicity guard collapses old-vs-new on
            // read.
            idempotencyKey: `RepoEnsured:${spec.repoId}:${at}`,
            payload: { repoId: spec.repoId, ensuredPath, at },
        };
        await deps.bus.publish(event);
        deps.logger.info('repo-ensure: cloned', {
            repoId: spec.repoId,
            ensuredPath,
        });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const event: Event = {
            type: 'RepoEnsureFailed',
            v: 1,
            occurredAt: at,
            idempotencyKey: `RepoEnsureFailed:${spec.repoId}:${at}`,
            payload: { repoId: spec.repoId, error: message, at },
        };
        await deps.bus.publish(event);
        deps.logger.warn('repo-ensure: clone failed', {
            repoId: spec.repoId,
            error: message,
        });
    }
}

/**
 * Returns the two closures the Repo command handlers fire when the
 * operator clicks "Sync now" / "Refresh all". Both close over the
 * projection (to look up url/branch by repoId) and the fetcher; the
 * resulting events go back through the bus and update the projection.
 */
export function createRepoRefreshTrigger(deps: RepoSyncDeps): {
    refreshOne: (repoId: string) => Promise<void>;
    refreshAll: () => Promise<void>;
} {
    return {
        refreshOne: (repoId): Promise<void> => runRefresh(deps, repoId),
        refreshAll: async (): Promise<void> => {
            const active = deps.projection.listActive();
            // Sequential rather than parallel — the operator-fired
            // "Refresh all" is a batch operation, and a serial pull
            // avoids hammering both `gh` auth state and the network
            // when the list is long. Each repo's outcome is published
            // independently so the board updates row-by-row.
            for (const repo of active) {
                await runRefresh(deps, repo.repoId);
            }
        },
    };
}

async function runRefresh(deps: RepoSyncDeps, repoId: string): Promise<void> {
    const repo = deps.projection.get(repoId);
    if (!repo) {
        deps.logger.warn('repo-refresh: skipped, unknown repoId', { repoId });
        return;
    }
    const githubEnv = deps.resolveGithubEnv?.(repo.githubAccount) ?? {};
    const spec: WorkspaceRepoSpec = {
        repoId: repo.repoId,
        url: repo.url,
        defaultBranch: repo.defaultBranch,
        ...(Object.keys(githubEnv).length > 0 ? { githubEnv } : {}),
    };
    const at = deps.clock();
    try {
        const refreshedPath = await deps.fetcher.refresh(spec);
        // Self-heal a stale `ensured_path`. `refresh()` resolves the clone
        // at the CURRENT workspace root (`<reposRoot>/<repoId>`) and syncs
        // it there — but the registry's `ensured_path` is only ever written
        // by `RepoEnsured` (the INITIAL clone). After the workspace root
        // moves (e.g. `…\.pipeline-workspace\repos` → `C:\Drop-AI\Source\
        // repos` via PIPELINE_WORKSPACE_ROOT), the recorded path goes stale
        // and `resolveRepoSpec` hands every planner / developer agent the
        // OLD cwd. When the path the refresh actually used differs from
        // what's recorded, re-emit `RepoEnsured` so the projection points
        // at where the clone really is now. This runs on the pre-spawn
        // refresh before every agent, so the registry self-corrects on the
        // next run with no operator action.
        if (
            typeof refreshedPath === 'string'
            && refreshedPath.length > 0
            && refreshedPath !== repo.ensuredPath
        ) {
            const ensured: Event = {
                type: 'RepoEnsured',
                v: 1,
                occurredAt: at,
                idempotencyKey: `RepoEnsured:${repoId}:reconcile:${at}`,
                payload: { repoId, ensuredPath: refreshedPath, at },
            };
            await deps.bus.publish(ensured);
            deps.logger.info('repo-refresh: reconciled stale ensured_path', {
                repoId,
                from: repo.ensuredPath,
                to: refreshedPath,
            });
            // RepoEnsured already records last_synced_at + status='ok' for
            // this `at`, so a same-timestamp RepoSynced would no-op against
            // the projection's monotonicity guard — skip it.
            return;
        }
        const event: Event = {
            type: 'RepoSynced',
            v: 1,
            occurredAt: at,
            idempotencyKey: `RepoSynced:${repoId}:${at}`,
            payload: { repoId, at },
        };
        await deps.bus.publish(event);
        deps.logger.info('repo-refresh: synced', { repoId });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const event: Event = {
            type: 'RepoSyncFailed',
            v: 1,
            occurredAt: at,
            idempotencyKey: `RepoSyncFailed:${repoId}:${at}`,
            payload: { repoId, error: message, at },
        };
        await deps.bus.publish(event);
        deps.logger.warn('repo-refresh: failed', { repoId, error: message });
    }
}
