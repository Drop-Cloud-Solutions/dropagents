/**
 * Agent runs stranded by a worker restart.
 *
 * Field report: "there was another agent running, the Get-Process query
 * now returns no results, but Tester still shows running".
 *
 * The worker restarted 77 seconds after that tester spawned. The child
 * `claude.exe` went with it, and so did the `close` handler that would
 * have published the run's terminal event — so nothing ever resolved
 * the step:
 *
 *   task_step_summaries.status  stays 'running' forever
 *   flow_state                  never advances past the step
 *   the board                   spins on a process that no longer exists
 *
 * And because the task is left with no park and a stale flow_state, it
 * offers neither Resume nor a working start — the same shape as the
 * earlier L-MIBO-010 case recorded in `clearsDependencyPark`.
 *
 * `main.ts` already knew half of this: "a worker restart wipes [the
 * accumulator], so an agent mid-run at restart loses its accumulated
 * chunks. The row's status stays 'running' until the next terminal
 * event lands." No terminal event is ever coming.
 *
 * At boot, EVERY row still marked running is by definition orphaned: no
 * live agent can exist yet, so the process that owned it belonged to the
 * previous worker. That makes the reconciliation unambiguous, which is
 * why it belongs at boot rather than in a timeout somewhere.
 */
import type { Db } from '../../core/state/migrations';

/** A step row left mid-run by the previous worker process. */
export interface OrphanedRun {
    readonly taskId: string;
    readonly stepId: string;
    readonly role: string | null;
    readonly startedAt: number;
    /** `tasks.status` — a terminal task needs no park. */
    readonly taskStatus: string;
    /** `tasks.parked_reason` — an existing park is not overwritten. */
    readonly parkedReason: string | null;
}

/** Task statuses past the point where re-running a step means anything. */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
    'done', 'failed', 'skipped', 'cancelled', 'archived',
]);

/**
 * Every step row still marked `running`, with the task context needed to
 * decide what to do about it.
 *
 * Ordered by task then start time so the log reads in the order the work
 * actually happened.
 */
export function findOrphanedRuns(db: Db): OrphanedRun[] {
    const rows = db
        .prepare(
            `SELECT s.task_id   AS taskId,
                    s.step_id   AS stepId,
                    s.role      AS role,
                    s.started_at AS startedAt,
                    t.status    AS taskStatus,
                    t.parked_reason AS parkedReason
               FROM task_step_summaries s
               JOIN tasks t ON t.id = s.task_id
              WHERE s.status = 'running'
              ORDER BY s.task_id ASC, s.started_at ASC`,
        )
        .all() as Array<{
            taskId: string;
            stepId: string;
            role: string | null;
            startedAt: number;
            taskStatus: string | null;
            parkedReason: string | null;
        }>;
    return rows.map((r) => ({
        taskId: r.taskId,
        stepId: r.stepId,
        role: r.role,
        startedAt: r.startedAt,
        taskStatus: r.taskStatus ?? '',
        parkedReason: r.parkedReason,
    }));
}

/**
 * Should the operator be asked to deal with this one?
 *
 * No for a terminal task — the run is moot and a park would resurrect a
 * finished card. No for a task already parked for its own reason: a
 * clarification or an approval is a MORE specific thing to be waiting
 * for, and overwriting it would lose the question.
 *
 * `waiting-deps` is not a real park in this sense (it is the dependency
 * gate, re-applied automatically), so it does not protect a row.
 */
export function needsOperatorPark(run: OrphanedRun): boolean {
    if (TERMINAL_STATUSES.has(run.taskStatus)) return false;
    if (run.parkedReason !== null
        && run.parkedReason.length > 0
        && run.parkedReason !== 'waiting-deps') {
        return false;
    }
    return true;
}

/**
 * What the operator reads on the card, in the step summary and in the
 * parked question.
 *
 * Says the three things they need: what was running, that it did not
 * finish, and what to do. "interrupted" alone would leave them hunting
 * for an agent error that was never written.
 */
export function describeOrphanedRun(run: OrphanedRun): string {
    const who = run.role && run.role.length > 0 ? run.role : 'the agent';
    return `The worker restarted while ${who} was running this step, so the`
        + ' run was lost — its output was never captured and the step never'
        + ' finished. Nothing was committed from it. Resume to run the step'
        + ' again, or Retry to restart the task from its first step.';
}
