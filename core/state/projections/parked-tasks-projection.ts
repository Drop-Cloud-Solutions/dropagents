/**
 * AP-VP7-002 — parked-tasks projection.
 *
 * Folds the task-parking event vocabulary into a single SQLite table
 * (`parked_tasks_projection`, created by migration 005) that contains
 * exactly one row per task currently held in a parked state. The worker-api
 * /health body reads the row count via {@link getParkedTaskCount} so the
 * `parkedTasks` gauge resolves in a single prepared COUNT(*) and the whole
 * health response stays inside its 100ms budget.
 *
 * Event vocabulary
 * ----------------
 *   - `TaskParked`   → INSERT (upsert by `task_id`)
 *   - `TaskResumed`  → DELETE
 *   - `TaskFinished` → DELETE
 *   - `TaskFailed`   → DELETE
 *
 * Idempotency
 * -----------
 * Inserts use `ON CONFLICT(task_id) DO UPDATE`, so replaying the same
 * `TaskParked` does not double-insert: the row is overwritten in place with
 * the same values. Deletes are naturally idempotent — re-deleting a row
 * that is already gone is a no-op. The named subscriber
 * ({@link PARKED_TASKS_PROJECTION_SUBSCRIBER}) lets a host call
 * `bus.replayMissed` on boot to catch up any park/unpark events emitted
 * while the process was down without worrying about double-application.
 *
 * `plan_id` is denormalised at insert time from `tasks(plan_id)` via a
 * sub-select. When the task row is not yet present (e.g. a `TaskParked`
 * that fires before the orchestrator has persisted the task to its DAG)
 * the column stays NULL — the parkedTasks gauge does not depend on it.
 */

import type Database from 'better-sqlite3';

import type { EventBus } from '../../events/bus';
import type { StoredEvent } from '../../events/event';
import {
    TaskParkingEvents,
    type TaskParkedEventPayload,
} from '../../commands';
import type { Db } from '../migrations';

/**
 * Subscriber name registered with the EventBus. Exposed so a host can call
 * `bus.replayMissed(PARKED_TASKS_PROJECTION_SUBSCRIBER)` on boot to catch
 * up any park/unpark events emitted while the process was down.
 */
export const PARKED_TASKS_PROJECTION_SUBSCRIBER = 'parked-tasks-projection';

/**
 * Event types that REMOVE a task from the projection. All three carry
 * `taskId` in their payload and they are the only ways the flow engine
 * transitions a task out of a parked state.
 */
const UNPARK_EVENT_TYPES = [
    TaskParkingEvents.TASK_RESUMED,
    'TaskFinished',
    'TaskFailed',
] as const;

/**
 * Minimal payload shape every unpark event carries. The three unpark
 * variants have richer payloads at the source (`decision`, `feedback`,
 * `failed_stage`, ...) but the projection only needs the task id.
 */
interface TaskIdPayload {
    readonly taskId: string;
}

/** better-sqlite3 prepared statement with variadic bind parameters. */
type Statement = Database.Statement<unknown[]>;

/**
 * Per-Db cache of the COUNT(*) prepared statement used by
 * {@link getParkedTaskCount}. better-sqlite3 prepares cheaply but the brief
 * is explicit that the helper must execute a prepared statement, so the
 * /health hot path never re-parses SQL once the cache is warm.
 */
const COUNT_STMT_CACHE = new WeakMap<Db, Statement>();

/**
 * Returns the current count of parked tasks via a single prepared
 * COUNT(*). Safe to call from the /health hot path — typical execution
 * is well under a millisecond on an in-memory DB and stays comfortably
 * inside the 100ms /health budget on disk.
 */
export function getParkedTaskCount(db: Db): number {
    let stmt = COUNT_STMT_CACHE.get(db);
    if (!stmt) {
        stmt = db.prepare(
            'SELECT COUNT(*) AS n FROM parked_tasks_projection',
        );
        COUNT_STMT_CACHE.set(db, stmt);
    }
    const row = stmt.get() as { n: number };
    return row.n;
}

/**
 * Subscribe the parked-tasks projection to the supplied {@link EventBus}.
 *
 * The constructor wires four named subscriptions (TaskParked + the three
 * unpark variants) and prepares the two mutating SQL statements once.
 * Hosts normally retain the instance only so they can call
 * {@link getParkedTaskCount} through the bound `db` handle they already
 * own; the bus owns the subscription lifetime.
 */
export class ParkedTasksProjection {
    private readonly insertStmt: Statement;
    private readonly deleteStmt: Statement;

    constructor(
        private readonly db: Db,
        bus: EventBus,
    ) {
        this.insertStmt = db.prepare(
            `INSERT INTO parked_tasks_projection(task_id, plan_id, parked_at, reason)
             VALUES (?, (SELECT plan_id FROM tasks WHERE id = ?), ?, ?)
             ON CONFLICT(task_id) DO UPDATE SET
                 plan_id   = excluded.plan_id,
                 parked_at = excluded.parked_at,
                 reason    = excluded.reason`,
        );
        this.deleteStmt = db.prepare(
            'DELETE FROM parked_tasks_projection WHERE task_id = ?',
        );

        const opts = { subscriber: PARKED_TASKS_PROJECTION_SUBSCRIBER };

        bus.subscribe<TaskParkedEventPayload>(
            TaskParkingEvents.TASK_PARKED,
            (event) => this.onTaskParked(event),
            opts,
        );

        for (const type of UNPARK_EVENT_TYPES) {
            bus.subscribe<TaskIdPayload>(
                type,
                (event) => this.onUnpark(event.payload.taskId),
                opts,
            );
        }
    }

    /** Convenience wrapper around the module-level helper. */
    getParkedTaskCount(): number {
        return getParkedTaskCount(this.db);
    }

    private onTaskParked(
        event: StoredEvent & { payload: TaskParkedEventPayload },
    ): void {
        const { taskId, reason } = event.payload;
        this.insertStmt.run(taskId, taskId, event.occurredAt, reason);
    }

    private onUnpark(taskId: string | undefined): void {
        if (!taskId) return;
        this.deleteStmt.run(taskId);
    }
}
