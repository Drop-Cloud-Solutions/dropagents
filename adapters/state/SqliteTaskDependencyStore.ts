/**
 * SQLite adapter for {@link TaskDependencyStore} (AP-IFW-006 Phase 1).
 *
 * Backs three roles:
 *   1. Inserting decomposer-declared edges as tasks land via TaskCreated.
 *   2. Gating the orchestrator's TaskCreated → task.created bridge: a task
 *      with any pending edge is parked with `parked_reason='waiting-deps'`
 *      instead of being dispatched to the engine.
 *   3. Flipping edges to `'merged'` when the upstream task finishes and
 *      returning the list of downstream tasks whose deps are now all
 *      merged — the host uses that list to unblock parked tasks.
 *
 * The scheduler in core/flow/scheduler.ts reads from this same store via
 * `snapshotFromStore`. The port-level methods (addDependency, …) match the
 * interface exactly; the helpers below (hasUnmetDeps, clearDependencies,
 * listDependents, listDependencies, taskStatusFor) are extensions used by
 * the orchestrator host.
 */

import type Database from 'better-sqlite3';

import type {
    SchedulableTask,
    TaskDepStatus,
    TaskDependency,
    TaskDependencyStore,
} from '../../core/ports/TaskDependencyStore';

type Statement = Database.Statement<unknown[]>;

interface DependencyRow {
    task_id: string;
    depends_on_task_id: string;
    status: string;
}

interface SchedulableRow {
    id: string;
    parked_reason: string | null;
}

/**
 * Task statuses the scheduler should NOT consider eligible. Tasks in any
 * of these states are terminal or operator-dismissed; the gating logic
 * treats them as either "already merged" (done) or "out of the way"
 * (skipped/failed).
 */
const TERMINAL_STATUSES = ['done', 'finished', 'skipped', 'failed'] as const;

export class SqliteTaskDependencyStore implements TaskDependencyStore {
    private readonly insertDepStmt: Statement;
    private readonly updateDepStatusStmt: Statement;
    private readonly listAllDepsStmt: Statement;
    private readonly listDepsForTaskStmt: Statement;
    private readonly listDependentsStmt: Statement;
    private readonly listSchedulableStmt: Statement;
    private readonly hasUnmetDepsStmt: Statement;
    private readonly clearDepsStmt: Statement;
    private readonly parkStmt: Statement;
    private readonly unparkStmt: Statement;
    private readonly taskStatusStmt: Statement;
    private readonly markMergedByUpstreamStmt: Statement;
    private readonly listDependentsWithoutUnmetStmt: Statement;

    constructor(private readonly db: Database.Database) {
        this.insertDepStmt = db.prepare(
            `INSERT OR IGNORE INTO task_deps(task_id, depends_on_task_id, status)
             VALUES (?, ?, ?)`,
        );
        this.updateDepStatusStmt = db.prepare(
            `UPDATE task_deps SET status = ?
              WHERE task_id = ? AND depends_on_task_id = ?`,
        );
        this.listAllDepsStmt = db.prepare(
            `SELECT task_id, depends_on_task_id, status FROM task_deps`,
        );
        this.listDepsForTaskStmt = db.prepare(
            `SELECT task_id, depends_on_task_id, status FROM task_deps
              WHERE task_id = ?`,
        );
        this.listDependentsStmt = db.prepare(
            `SELECT task_id FROM task_deps WHERE depends_on_task_id = ?`,
        );
        // Skip terminal-status tasks so the scheduler's snapshot stays
        // bounded over time. A `done` task is conceptually "merged into
        // the world" — keeping it in the schedulable set just bloats the
        // cycle-detection pass.
        this.listSchedulableStmt = db.prepare(
            `SELECT id, parked_reason FROM tasks
              WHERE status NOT IN (${TERMINAL_STATUSES.map(() => '?').join(',')})`,
        );
        this.hasUnmetDepsStmt = db.prepare(
            `SELECT 1 FROM task_deps
              WHERE task_id = ? AND status <> 'merged'
              LIMIT 1`,
        );
        this.clearDepsStmt = db.prepare(
            `DELETE FROM task_deps WHERE task_id = ?`,
        );
        this.parkStmt = db.prepare(
            `UPDATE tasks SET parked_reason = ? WHERE id = ?`,
        );
        this.unparkStmt = db.prepare(
            `UPDATE tasks SET parked_reason = NULL WHERE id = ?`,
        );
        this.taskStatusStmt = db.prepare(
            `SELECT status FROM tasks WHERE id = ?`,
        );
        this.markMergedByUpstreamStmt = db.prepare(
            `UPDATE task_deps SET status = 'merged'
              WHERE depends_on_task_id = ? AND status <> 'merged'`,
        );
        // Tasks blocked specifically on the supplied upstream that have
        // no remaining unmet edges after that upstream flips to merged.
        // Used by the post-TaskFinished unblock pass.
        this.listDependentsWithoutUnmetStmt = db.prepare(
            `SELECT DISTINCT d.task_id FROM task_deps d
              WHERE d.depends_on_task_id = ?
                AND NOT EXISTS (
                    SELECT 1 FROM task_deps d2
                     WHERE d2.task_id = d.task_id AND d2.status <> 'merged'
                )`,
        );
    }

    // ------- TaskDependencyStore (port) ------------------------------------

    addDependency(
        taskId: string,
        dependsOnTaskId: string,
        status: TaskDepStatus = 'pending',
    ): void {
        this.insertDepStmt.run(taskId, dependsOnTaskId, status);
    }

    setDependencyStatus(
        taskId: string,
        dependsOnTaskId: string,
        status: TaskDepStatus,
    ): void {
        this.updateDepStatusStmt.run(status, taskId, dependsOnTaskId);
    }

    listDependencies(taskId?: string): readonly TaskDependency[] {
        const rows = (taskId === undefined
            ? this.listAllDepsStmt.all()
            : this.listDepsForTaskStmt.all(taskId)) as DependencyRow[];
        return rows.map((r) => ({
            taskId: r.task_id,
            dependsOnTaskId: r.depends_on_task_id,
            status: r.status as TaskDepStatus,
        }));
    }

    listSchedulableTasks(): readonly SchedulableTask[] {
        const rows = this.listSchedulableStmt.all(
            ...TERMINAL_STATUSES,
        ) as SchedulableRow[];
        return rows.map((r) => ({
            id: r.id,
            parkedReason: r.parked_reason,
        }));
    }

    parkTask(taskId: string, reason: string): void {
        this.parkStmt.run(reason, taskId);
    }

    unparkTask(taskId: string): void {
        this.unparkStmt.run(taskId);
    }

    // ------- Extensions used by the orchestrator host ----------------------

    /**
     * True when `taskId` has at least one edge whose status is not yet
     * `'merged'`. The gating predicate the bridge subscriber consults
     * before forwarding TaskCreated to the engine.
     */
    hasUnmetDeps(taskId: string): boolean {
        return this.hasUnmetDepsStmt.get(taskId) !== undefined;
    }

    /**
     * Drop every edge originating at `taskId`. Used on re-decompose so the
     * fresh attempt starts from a clean DAG.
     */
    clearDependencies(taskId: string): void {
        this.clearDepsStmt.run(taskId);
    }

    /** Task ids whose outgoing edges include `dependsOnTaskId`. */
    listDependents(dependsOnTaskId: string): readonly string[] {
        const rows = this.listDependentsStmt.all(dependsOnTaskId) as Array<{
            task_id: string;
        }>;
        return rows.map((r) => r.task_id);
    }

    /**
     * Reads `tasks.status` for the supplied id. Returns `undefined` when
     * the row doesn't exist. Used by the bridge to short-circuit deps
     * whose upstream finished before the decomposer ran (rare but
     * possible for tasks added across plan revisions).
     */
    taskStatusFor(taskId: string): string | undefined {
        const row = this.taskStatusStmt.get(taskId) as
            | { status: string }
            | undefined;
        return row?.status;
    }

    /**
     * Atomically flip every edge whose upstream is `dependsOnTaskId` from
     * pending → merged, then return the downstream task ids whose entire
     * dep set is now satisfied. The caller unparks each.
     */
    markUpstreamMerged(dependsOnTaskId: string): readonly string[] {
        this.markMergedByUpstreamStmt.run(dependsOnTaskId);
        const rows = this.listDependentsWithoutUnmetStmt.all(
            dependsOnTaskId,
        ) as Array<{ task_id: string }>;
        return rows.map((r) => r.task_id);
    }

    /**
     * Flip every edge whose upstream is `dependsOnTaskId` from `'merged'`
     * back to `'pending'`. Used when an upstream task is restarted
     * (TaskRetried): downstream tasks that were unblocked by the previous
     * run must be re-blocked until the restarted upstream finishes again.
     * Returns the count of edges affected so the caller can log clearly
     * how many dependents were re-gated.
     */
    resetMergedEdgesPointingTo(dependsOnTaskId: string): number {
        const info = this.db
            .prepare(
                `UPDATE task_deps SET status = 'pending'
                  WHERE depends_on_task_id = ? AND status = 'merged'`,
            )
            .run(dependsOnTaskId);
        return info.changes;
    }
}
