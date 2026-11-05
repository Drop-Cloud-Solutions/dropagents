/**
 * Workspace-level repo registry commands.
 *
 * Repos are first-class entities at the workspace root (not nested
 * under projects). The operator manages them through the Repos modal
 * on the board; this module defines the command vocabulary the modal
 * dispatches through {@link CommandBus.send}.
 *
 * Lifecycle:
 *   RegisterRepo   -> RepoRegistered      (write side)
 *   UpdateRepo     -> RepoUpdated
 *   ArchiveRepo    -> RepoArchived
 *   RefreshRepo    -> (fire-and-forget; RepoSynced / RepoSyncFailed
 *                      emitted by the sync subscriber once the git
 *                      fetch+reset returns)
 *   RefreshAllRepos -> same, fanned out across the active repos.
 *
 * Repo ids are derived from the URL on RegisterRepo so two operators
 * registering the same GitHub repo land on the same row without
 * coordination. The handler accepts an operator-supplied id as an
 * override for the rare case where the derived form clashes.
 */

import type {
    Event,
    RepoArchivedPayload,
    RepoLifecyclePayload,
} from '../events/event';
import type { CommandHandler } from './bus';
import type { Command } from './command';

export const RepoCommands = {
    REGISTER_REPO: 'RegisterRepo',
    /**
     * Create a brand-new GitHub repo + clone it + seed CLAUDE.md from
     * the operator's description + emit `RepoRegistered`. Distinct from
     * `RegisterRepo` (which only points at an existing remote) so the
     * worker-api can validate the create-specific fields (`owner`,
     * `description`, `visibility`) and the orchestrator handler can
     * drive the gh / git sequence. Emits the same `RepoRegistered`
     * event as the register path so the projection / sidebar / refresh
     * machinery doesn't need to know how the repo got there.
     */
    CREATE_REPO: 'CreateRepo',
    UPDATE_REPO: 'UpdateRepo',
    ARCHIVE_REPO: 'ArchiveRepo',
    REFRESH_REPO: 'RefreshRepo',
    REFRESH_ALL_REPOS: 'RefreshAllRepos',
} as const;

export const RepoEvents = {
    REPO_REGISTERED: 'RepoRegistered',
    REPO_UPDATED: 'RepoUpdated',
    REPO_ARCHIVED: 'RepoArchived',
    REPO_ENSURED: 'RepoEnsured',
    REPO_ENSURE_FAILED: 'RepoEnsureFailed',
    REPO_SYNCED: 'RepoSynced',
    REPO_SYNC_FAILED: 'RepoSyncFailed',
} as const;

// ---------------------------------------------------------------------------
// Command payloads
// ---------------------------------------------------------------------------

export interface RegisterRepoPayload {
    /** Display name. The Repos modal shows this in the table; the
     *  planner sees it via {@link RepoLifecyclePayload.name}. */
    readonly name: string;
    /** Canonical clone URL. The handler derives the `repoId` from this
     *  when {@link repoId} is omitted. */
    readonly url: string;
    /** Optional default branch. Falls back to `'main'` on the event. */
    readonly defaultBranch?: string;
    /** Override for the derived id. Useful when the derived form
     *  would collide with an existing repoId. */
    readonly repoId?: string;
    /**
     * Declared GitHub account this repo is reached with
     * (`github_accounts:` in pipeline.yaml). Omitted means the
     * machine's ambient `gh` identity.
     */
    readonly githubAccount?: string;
}

export interface CreateRepoPayload {
    /**
     * Repo name. The handler runs `gh repo create <owner>/<name>` —
     * the form that GitHub accepts as a slug (lowercase alphanumerics,
     * hyphens). Display name on the projection uses this value
     * verbatim; the operator can rename via `UpdateRepo` later.
     */
    readonly name: string;
    /** GitHub owner (user or org). Defaults to the gh-authenticated
     *  user in the UI, but the field is required on the wire so the
     *  handler does not have to call `gh api user` mid-create. */
    readonly owner: string;
    /** Operator-supplied description of the repo's purpose. Seeded
     *  into the `## Purpose` section of the new repo's `CLAUDE.md`. */
    readonly description: string;
    /** `'private'` or `'public'`. Defaults to private in the UI. */
    readonly visibility: 'private' | 'public';
    /** Optional default branch for the initial commit. Falls back to
     *  `'main'` on the event. */
    readonly defaultBranch?: string;
    /**
     * Declared GitHub account to create the repo UNDER, and to record on
     * the repo so every later clone, fetch, push and PR uses the same
     * one. Omitted means the machine's ambient identity.
     */
    readonly githubAccount?: string;
}

export interface UpdateRepoPayload {
    readonly repoId: string;
    readonly name?: string;
    readonly url?: string;
    readonly defaultBranch?: string;
    /**
     * Re-point the repo at a different declared GitHub account.
     *
     * Omitted leaves the mapping alone; the EMPTY STRING clears it,
     * back to the ambient identity. Those have to differ or there
     * is no way to un-map a repo, and every rename would wipe the
     * mapping.
     */
    readonly githubAccount?: string;
}

export interface ArchiveRepoPayload {
    readonly repoId: string;
}

export interface RefreshRepoPayload {
    readonly repoId: string;
}

// `RefreshAllRepos` carries no payload — the handler reads the active
// set out of the projection at dispatch time. An empty object on the
// wire keeps the validator predicate uniform with the rest.
export interface RefreshAllReposPayload {
    readonly _?: never;
}

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

export function isRegisterRepoPayload(value: unknown): value is RegisterRepoPayload {
    if (!value || typeof value !== 'object') return false;
    const v = value as Record<string, unknown>;
    if (typeof v.name !== 'string' || v.name.length === 0) return false;
    if (typeof v.url !== 'string' || v.url.length === 0) return false;
    if (v.defaultBranch !== undefined && typeof v.defaultBranch !== 'string') return false;
    if (v.repoId !== undefined && typeof v.repoId !== 'string') return false;
    if (v.githubAccount !== undefined && typeof v.githubAccount !== 'string') return false;
    return true;
}

export function isCreateRepoPayload(value: unknown): value is CreateRepoPayload {
    if (!value || typeof value !== 'object') return false;
    const v = value as Record<string, unknown>;
    if (typeof v.name !== 'string' || v.name.length === 0) return false;
    if (typeof v.owner !== 'string' || v.owner.length === 0) return false;
    if (typeof v.description !== 'string' || v.description.length === 0) return false;
    if (v.visibility !== 'private' && v.visibility !== 'public') return false;
    if (v.defaultBranch !== undefined && typeof v.defaultBranch !== 'string') return false;
    if (v.githubAccount !== undefined && typeof v.githubAccount !== 'string') return false;
    return true;
}

export function isUpdateRepoPayload(value: unknown): value is UpdateRepoPayload {
    if (!value || typeof value !== 'object') return false;
    const v = value as Record<string, unknown>;
    if (typeof v.repoId !== 'string' || v.repoId.length === 0) return false;
    if (v.name !== undefined && typeof v.name !== 'string') return false;
    if (v.url !== undefined && typeof v.url !== 'string') return false;
    if (v.defaultBranch !== undefined && typeof v.defaultBranch !== 'string') return false;
    if (v.githubAccount !== undefined && typeof v.githubAccount !== 'string') return false;
    return true;
}

export function isArchiveRepoPayload(value: unknown): value is ArchiveRepoPayload {
    if (!value || typeof value !== 'object') return false;
    const v = value as Record<string, unknown>;
    return typeof v.repoId === 'string' && v.repoId.length > 0;
}

export function isRefreshRepoPayload(value: unknown): value is RefreshRepoPayload {
    if (!value || typeof value !== 'object') return false;
    const v = value as Record<string, unknown>;
    return typeof v.repoId === 'string' && v.repoId.length > 0;
}

export function isRefreshAllReposPayload(value: unknown): value is RefreshAllReposPayload {
    // Tolerant — operator-fired with `{}`; reject only if a non-object
    // sneaks through.
    return value !== null && typeof value === 'object';
}

// ---------------------------------------------------------------------------
// repoId derivation
// ---------------------------------------------------------------------------

/**
 * Derive a stable repoId from a clone URL.
 *
 * Rules (apply in order):
 *   1. Strip trailing `.git`.
 *   2. Strip trailing slashes.
 *   3. Use the last path segment as the id (after `/` or `:`).
 *   4. Lowercase + replace any non-alphanumeric-or-hyphen with `-`.
 *
 * Examples:
 *   `https://github.com/example/configservice.git` -> `configservice`
 *   `https://github.com/example/Order-Hub`            -> `order-hub`
 *   `git@github.com:example/products.git`             -> `products`
 *
 * Returns `null` when the input is empty or has no usable segment —
 * the caller should fall back to an operator-supplied id (or 400).
 */
export function deriveRepoIdFromUrl(url: string): string | null {
    if (typeof url !== 'string') return null;
    let trimmed = url.trim();
    if (trimmed.length === 0) return null;
    if (trimmed.endsWith('.git')) trimmed = trimmed.slice(0, -4);
    while (trimmed.endsWith('/')) trimmed = trimmed.slice(0, -1);
    // The repo name is the segment after the last `/` or `:` (the
    // SSH form uses a colon between host and path).
    const slashIdx = trimmed.lastIndexOf('/');
    const colonIdx = trimmed.lastIndexOf(':');
    const cut = Math.max(slashIdx, colonIdx);
    const segment = cut === -1 ? trimmed : trimmed.slice(cut + 1);
    if (segment.length === 0) return null;
    const slug = segment.toLowerCase().replace(/[^a-z0-9-]+/g, '-');
    return slug.length === 0 ? null : slug;
}

// ---------------------------------------------------------------------------
// Handler factories
// ---------------------------------------------------------------------------

export interface RepoHandlerDeps {
    readonly clock: () => number;
}

const DEFAULT_BRANCH = 'main';

export function createRegisterRepoHandler(
    deps: RepoHandlerDeps,
): CommandHandler<Command<RegisterRepoPayload>> {
    return async (cmd) => {
        if (!isRegisterRepoPayload(cmd.payload)) {
            throw new Error('RegisterRepo: invalid payload');
        }
        const repoId =
            cmd.payload.repoId && cmd.payload.repoId.length > 0
                ? cmd.payload.repoId
                : deriveRepoIdFromUrl(cmd.payload.url);
        if (!repoId) {
            throw new Error(`RegisterRepo: could not derive repoId from url="${cmd.payload.url}"`);
        }
        const payload: RepoLifecyclePayload = {
            repoId,
            name: cmd.payload.name,
            url: cmd.payload.url,
            actor: cmd.actor,
            ...(cmd.payload.defaultBranch !== undefined
                ? { defaultBranch: cmd.payload.defaultBranch }
                : { defaultBranch: DEFAULT_BRANCH }),
            // Omitted rather than null when absent: the projection
            // COALESCEs on the incoming side, so an omitted account
            // on a RE-register keeps whatever mapping the operator
            // already set.
            ...(cmd.payload.githubAccount !== undefined
                ? { githubAccount: cmd.payload.githubAccount }
                : {}),
        };
        const event: Event = {
            type: RepoEvents.REPO_REGISTERED,
            v: 1,
            occurredAt: deps.clock(),
            // Keyed on repoId — a duplicate Register collapses to a
            // single row in the event log. The projection's UPSERT
            // handles concurrent re-register cleanly.
            idempotencyKey: `${RepoCommands.REGISTER_REPO}:${repoId}`,
            payload,
        };
        return [event];
    };
}

export function createUpdateRepoHandler(
    deps: RepoHandlerDeps,
): CommandHandler<Command<UpdateRepoPayload>> {
    return async (cmd) => {
        if (!isUpdateRepoPayload(cmd.payload)) {
            throw new Error('UpdateRepo: invalid payload');
        }
        // Update events carry name/url/defaultBranch — at least one
        // must change for the command to make sense, but we don't
        // enforce strictly: a no-op Update is harmless given the
        // projection's monotonicity guard.
        const at = deps.clock();
        const payload: RepoLifecyclePayload = {
            repoId: cmd.payload.repoId,
            name: cmd.payload.name ?? '',
            url: cmd.payload.url ?? '',
            actor: cmd.actor,
            ...(cmd.payload.defaultBranch !== undefined
                ? { defaultBranch: cmd.payload.defaultBranch }
                : {}),
            // Forwarded verbatim, INCLUDING the empty string: '' is how
            // the operator clears a mapping, and collapsing it to
            // "omitted" here would make un-mapping a repo impossible.
            ...(cmd.payload.githubAccount !== undefined
                ? { githubAccount: cmd.payload.githubAccount }
                : {}),
        };
        const event: Event = {
            type: RepoEvents.REPO_UPDATED,
            v: 1,
            occurredAt: at,
            // Allow N updates per repo over time — key on the
            // timestamp so each Update lands as a distinct event.
            idempotencyKey: `${RepoCommands.UPDATE_REPO}:${cmd.payload.repoId}:${at}`,
            payload,
        };
        return [event];
    };
}

export function createArchiveRepoHandler(
    deps: RepoHandlerDeps,
): CommandHandler<Command<ArchiveRepoPayload>> {
    return async (cmd) => {
        if (!isArchiveRepoPayload(cmd.payload)) {
            throw new Error('ArchiveRepo: invalid payload');
        }
        const payload: RepoArchivedPayload = {
            repoId: cmd.payload.repoId,
            actor: cmd.actor,
        };
        const event: Event = {
            type: RepoEvents.REPO_ARCHIVED,
            v: 1,
            occurredAt: deps.clock(),
            idempotencyKey: `${RepoCommands.ARCHIVE_REPO}:${cmd.payload.repoId}`,
            payload,
        };
        return [event];
    };
}

/**
 * `RefreshRepo` / `RefreshAllRepos` are fire-and-forget. The handler
 * delegates to the supplied {@link triggerRefresh} closure (which the
 * orchestrator host wires against {@link RepoFetcher.refresh}); the
 * async work emits `RepoSynced` / `RepoSyncFailed` once `git fetch &&
 * git reset --hard` returns. Returning `[]` here keeps the command
 * envelope on the event log without polluting it with an intermediate
 * "refresh requested" event.
 */
export interface RefreshRepoHandlerDeps extends RepoHandlerDeps {
    readonly triggerRefresh: (repoId: string) => void | Promise<void>;
}

export function createRefreshRepoHandler(
    deps: RefreshRepoHandlerDeps,
): CommandHandler<Command<RefreshRepoPayload>> {
    return async (cmd) => {
        if (!isRefreshRepoPayload(cmd.payload)) {
            throw new Error('RefreshRepo: invalid payload');
        }
        // Don't await — refresh can take several seconds against a
        // slow network and the operator's click should return
        // immediately. The work emits its own events.
        void deps.triggerRefresh(cmd.payload.repoId);
        return [];
    };
}

export interface RefreshAllReposHandlerDeps extends RepoHandlerDeps {
    readonly triggerRefreshAll: () => void | Promise<void>;
}

export function createRefreshAllReposHandler(
    deps: RefreshAllReposHandlerDeps,
): CommandHandler<Command<RefreshAllReposPayload>> {
    return async (cmd) => {
        if (!isRefreshAllReposPayload(cmd.payload)) {
            throw new Error('RefreshAllRepos: invalid payload');
        }
        void deps.triggerRefreshAll();
        return [];
    };
}
