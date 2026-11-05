/**
 * Port: persistence surface for the task DAG (AP-IFW-006).
 *
 * Backs the eligibleTasks scheduler in core/flow/scheduler.ts. The scheduler
 * itself is pure — it works against a {@link TaskGraphSnapshot} that callers
 * compose from this store via `snapshotFromStore`. Keeping the store and the
 * scheduler decoupled means tests can drive eligibility logic against POJO
 * snapshots without booting SQLite.
 *
 * The closed `TaskDepStatus` union is load-bearing: only `'pending'` and
 * `'merged'` are recognised by the scheduler. Adding a third status is a
 * deliberate port change rather than an adapter convention.
 */

/** Merge state of a single dependency edge. */
export type TaskDepStatus = 'pending' | 'merged';

/** A directed edge "task_id depends on depends_on_task_id". */
export interface TaskDependency {
  readonly taskId: string;
  readonly dependsOnTaskId: string;
  readonly status: TaskDepStatus;
}

/**
 * Minimal task projection the scheduler needs: identity plus parked_reason.
 * `parkedReason === null` (or empty string) means the task is not parked.
 */
export interface SchedulableTask {
  readonly id: string;
  readonly parkedReason: string | null;
}

/**
 * Persistence port for task dependencies and parked state. Adapters
 * (SQLite-backed in production, in-memory in tests) implement this surface;
 * the scheduler consumes the read-side via {@link TaskGraphSnapshot}.
 */
export interface TaskDependencyStore {
  /**
   * Insert a dependency edge. Defaults to status `'pending'`. Re-inserting
   * the same `(taskId, dependsOnTaskId)` pair is a constraint violation —
   * use {@link setDependencyStatus} to update.
   */
  addDependency(
    taskId: string,
    dependsOnTaskId: string,
    status?: TaskDepStatus,
  ): void;

  /** Update the status of an existing edge. */
  setDependencyStatus(
    taskId: string,
    dependsOnTaskId: string,
    status: TaskDepStatus,
  ): void;

  /**
   * All dependency edges, optionally filtered to those originating at
   * `taskId`. Returned order is adapter-defined.
   */
  listDependencies(taskId?: string): readonly TaskDependency[];

  /**
   * Every task the scheduler should consider, with its current parked_reason.
   * In production this is typically every row in `tasks` whose `status` is
   * not yet terminal; the scheduler does not re-filter by status.
   */
  listSchedulableTasks(): readonly SchedulableTask[];

  /**
   * Mark a task as parked with a human-readable reason
   * (e.g. `'wait-action'`, `'wait-merged'`). Persists to `tasks.parked_reason`.
   */
  parkTask(taskId: string, reason: string): void;

  /** Clear `tasks.parked_reason` for `taskId`. No-op if it was already NULL. */
  unparkTask(taskId: string): void;
}
