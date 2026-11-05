/**
 * Does a task belong on the board's active Tasks section?
 *
 * The section is the operator's "what needs me / what's running" surface;
 * the plan-status sections own the full lifecycle view. Terminal states
 * (done / skipped / archived) live behind the plan card.
 *
 * `failed` is NOT terminal for this purpose — a failed task is precisely
 * one that wants the operator (Retry / Dismiss / read the report). It was
 * excluded, so a task whose reviewer rejected it vanished from the board
 * and could only be found by opening its project (field case
 * DF-BRBS-014).
 *
 * Pure + separately testable (same pattern as `task-tags.ts` /
 * `report-availability.ts`).
 */

/** Statuses that mean an agent is actively working the task. */
export const TASK_IN_PROGRESS_STATUSES: ReadonlySet<string> = new Set([
    'in_progress',
    'review',
    'test',
    'commit',
    'merge',
]);

/** Terminal for the active surface — reachable via the plan card. */
export const TASK_TERMINAL_STATUSES: ReadonlySet<string> = new Set([
    'done',
    'skipped',
    'archived',
]);

export function isActiveBoardTaskStatus(
    status: string | null | undefined,
    parkedReason: string | null | undefined,
): boolean {
    const s = status || 'created';
    // Terminal wins even when a stale parkedReason is still on the row
    // (a task parked at human-review and then Dismissed keeps its old
    // reason in the in-memory cache).
    if (TASK_TERMINAL_STATUSES.has(s)) return false;
    if (TASK_IN_PROGRESS_STATUSES.has(s)) return true;
    if (parkedReason) return true;
    // Failed: actionable, and the operator must be able to SEE it.
    if (s === 'failed') return true;
    // Approved-but-not-running: normally a blip, but a flow that dies at
    // dispatch leaves the task here forever — keep it visible.
    if (s === 'approved') return true;
    // Awaiting the operator's first Approve.
    if (s === 'created') return true;
    return false;
}
