/**
 * Watch a PR the pipeline QUEUED for auto-merge until GitHub runs it.
 *
 * `gh pr merge --auto` returns the moment GitHub accepts the request —
 * the PR is not merged yet, it is promised. Without something watching,
 * the task sits parked at `wait-merged` forever even though the merge
 * lands minutes later, and the operator has to come back and click
 * Merge PR for a PR that is already merged. Worse, the clone's
 * `origin/<default>` never advances, so a dependent task unblocked by
 * that merge branches off pre-merge code — the exact failure the
 * post-merge fetch in `mergeTaskPr` exists to prevent.
 *
 * So this is the other half of `--auto`: poll the PR, and when it
 * merges, run the same tail the immediate merge runs (fetch, tear down,
 * resume). Bounded, and it gives up LOUDLY: the task stays parked with
 * the manual Merge PR button, which is a degrade rather than a loss.
 *
 * Pure of gh and of the clock, so the loop is testable without a
 * network or a wait.
 */
import type { Logger } from '../../core/ports/Logger';

/** The PR states that matter here. Anything else is "still open". */
export type WatchedPrState = 'MERGED' | 'CLOSED' | 'OPEN';

/**
 * Read a PR state out of `gh pr view --json state,mergedAt`.
 *
 * LLM output is not the only hostile input — a CLI's stdout can carry a
 * deprecation banner, a login notice, or (on Windows) a BOM ahead of
 * the JSON, so the object is located rather than assumed to start at
 * byte 0. Anything unreadable is reported as OPEN: that keeps polling,
 * which is the safe answer. Treating a parse failure as MERGED would
 * finish a task whose PR never landed.
 */
export function parsePrState(stdout: string): WatchedPrState {
    const start = stdout.indexOf('{');
    const end = stdout.lastIndexOf('}');
    if (start < 0 || end <= start) return 'OPEN';
    let parsed: unknown;
    try {
        parsed = JSON.parse(stdout.slice(start, end + 1));
    } catch {
        return 'OPEN';
    }
    if (typeof parsed !== 'object' || parsed === null) return 'OPEN';
    const row = parsed as { state?: unknown; mergedAt?: unknown };
    // `mergedAt` is the stronger signal: a non-null timestamp means the
    // merge commit exists. `state` is checked too because gh has
    // reported MERGED with a null mergedAt on squash merges.
    if (typeof row.mergedAt === 'string' && row.mergedAt.length > 0) {
        return 'MERGED';
    }
    const state = typeof row.state === 'string' ? row.state.toUpperCase() : '';
    if (state === 'MERGED') return 'MERGED';
    if (state === 'CLOSED') return 'CLOSED';
    return 'OPEN';
}

export interface WatchEnqueuedMergeDeps {
    readonly taskId: string;
    readonly prNumber: number;
    /** Runs `gh pr view <n> --json state,mergedAt`; returns its stdout. */
    readonly viewPr: () => Promise<string>;
    /** The merge landed: fetch, tear the worktree down, resume the task. */
    readonly onMerged: () => Promise<void>;
    /** Gave up. `detail` is an operator-facing sentence, already final. */
    readonly onGaveUp: (detail: string) => Promise<void>;
    readonly sleep: (ms: number) => Promise<void>;
    readonly now: () => number;
    readonly pollMs: number;
    readonly timeoutMs: number;
    readonly logger: Logger;
}

export type WatchOutcome = 'merged' | 'closed' | 'timeout';

/**
 * Poll until the PR merges, is closed unmerged, or the deadline passes.
 *
 * Never throws: it is started fire-and-forget from a command handler,
 * so an unhandled rejection here would surface as a crash unrelated to
 * anything the operator did. A failing `gh pr view` is treated as
 * transient and polled again — a token hiccup or a rate limit must not
 * abandon a merge that is about to land.
 */
export async function watchEnqueuedMerge(
    deps: WatchEnqueuedMergeDeps,
): Promise<WatchOutcome> {
    const deadline = deps.now() + deps.timeoutMs;
    let consecutiveViewFailures = 0;
    for (;;) {
        await deps.sleep(deps.pollMs);
        let state: WatchedPrState;
        try {
            state = parsePrState(await deps.viewPr());
            consecutiveViewFailures = 0;
        } catch (err) {
            consecutiveViewFailures += 1;
            deps.logger.warn('auto-merge watch: gh pr view failed', {
                taskId: deps.taskId,
                prNumber: deps.prNumber,
                consecutiveFailures: consecutiveViewFailures,
                error: err instanceof Error ? err.message : String(err),
            });
            state = 'OPEN';
        }

        if (state === 'MERGED') {
            deps.logger.info('auto-merge watch: PR merged', {
                taskId: deps.taskId,
                prNumber: deps.prNumber,
            });
            await deps.onMerged();
            return 'merged';
        }
        if (state === 'CLOSED') {
            // Somebody closed it, or the auto-merge was cancelled.
            // Either way it will never merge on its own.
            await deps.onGaveUp(
                'GitHub reports it closed without merging, so the queued'
                + ' merge will not happen.',
            );
            return 'closed';
        }
        if (deps.now() >= deadline) {
            const mins = Math.round(deps.timeoutMs / 60_000);
            await deps.onGaveUp(
                `It was still unmerged ${mins} minute${mins === 1 ? '' : 's'}`
                + ' later, so the pipeline stopped watching'
                + (consecutiveViewFailures > 0
                    ? ' (and the last few status checks could not be read).'
                    : '.')
                + ' The auto-merge is still queued with GitHub and may yet'
                + ' land on its own.',
            );
            return 'timeout';
        }
    }
}

/**
 * `PIPELINE_AUTO_MERGE_POLL_SECONDS` — how often to ask GitHub whether
 * the queued merge has landed. Default 60s: required checks take
 * minutes, so a tighter poll only burns API quota. Floored at 5s so a
 * typo cannot spin.
 */
export function resolveAutoMergePollMs(env: NodeJS.ProcessEnv): number {
    const raw = env.PIPELINE_AUTO_MERGE_POLL_SECONDS;
    const parsed = raw === undefined ? NaN : Number(raw);
    const seconds = Number.isFinite(parsed) && parsed >= 5 ? parsed : 60;
    return seconds * 1000;
}

/**
 * `PIPELINE_AUTO_MERGE_TIMEOUT_MINUTES` — how long to keep watching.
 * Default 60: long enough for a slow .NET build-and-test suite plus a
 * queue, short enough that a watcher does not outlive the worker's
 * useful attention. On expiry the task stays parked with the manual
 * button, and the note says so.
 */
export function resolveAutoMergeTimeoutMs(env: NodeJS.ProcessEnv): number {
    const raw = env.PIPELINE_AUTO_MERGE_TIMEOUT_MINUTES;
    const parsed = raw === undefined ? NaN : Number(raw);
    const minutes = Number.isFinite(parsed) && parsed > 0 ? parsed : 60;
    return minutes * 60 * 1000;
}
