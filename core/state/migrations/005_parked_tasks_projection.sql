-- 005_parked_tasks_projection — projection table backing the worker-api
-- /health body's `parkedTasks` gauge (AP-VP7-002).
--
-- The flow engine publishes `TaskParked` when a task enters a wait /
-- clarification / approval step, and `TaskResumed` / `TaskFinished` /
-- `TaskFailed` when the task leaves that state. The parked-tasks projection
-- (core/state/projections/parked-tasks-projection.ts) folds those events into
-- exactly one row per task currently held in a parked state. /health reads
-- the row count via a single prepared COUNT(*) so the response stays well
-- inside the 100ms health-body budget instead of scanning the event log on
-- every probe.
--
-- Column notes:
--   * task_id is the PRIMARY KEY — a task can only be parked once at a time,
--     so a replayed `TaskParked` for the same task collapses to an upsert
--     rather than producing a duplicate row.
--   * plan_id is denormalised from `tasks(plan_id)` at insert time so
--     operator-facing lookups ("which plans have parked tasks?") avoid a
--     join back through `tasks`. NULL when the task row is not yet present
--     (TaskParked may fire before the orchestrator has persisted the task
--     to its DAG); the gauge does not depend on the value.
--   * parked_at carries the event's `occurredAt` so the column can later
--     drive an "oldest park" gauge without a second query.
--   * reason carries the `TaskParkedReason` discriminator verbatim from the
--     event payload (`wait-action`, `clarification`, `approval`, ...).
--
-- Idempotency: the projector uses ON CONFLICT(task_id) DO UPDATE for inserts
-- and a plain DELETE for the three unpark variants, so replaying any of the
-- folded events is a no-op at the SQL layer.

CREATE TABLE parked_tasks_projection (
    task_id   TEXT    NOT NULL PRIMARY KEY,
    plan_id   TEXT,
    parked_at INTEGER NOT NULL,
    reason    TEXT    NOT NULL
);
