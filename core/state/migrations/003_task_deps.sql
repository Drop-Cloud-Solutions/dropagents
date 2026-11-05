-- 003_task_deps — task DAG and scheduling primitives (AP-IFW-006).
--
-- Two changes land together because they are both inputs to the eligibleTasks
-- scheduler in core/flow/scheduler.ts:
--
--   1. tasks.parked_reason — nullable text column. Set when a task is parked
--      pending an external signal (operator action, PR merge, etc.). The
--      scheduler treats any non-NULL/non-empty value as "do not pick up".
--      Existing rows backfill to NULL automatically because no DEFAULT is set
--      and the column is nullable; that is the entire backward-compatibility
--      story for this column.
--
--   2. task_deps — directed dependency edges between tasks. status tracks the
--      merge state of the *edge* (not the upstream task) so the scheduler can
--      gate eligibility with a single per-task aggregate without joining back
--      through tasks. The edge is keyed (task_id, depends_on_task_id) so a
--      duplicate edge is a constraint violation rather than silent fan-out.
--
-- Cut-list note: v2 does not support a bump-package-reference task type, so
-- there is no scheduler-level special case here. Every task is gated by the
-- same "all deps merged AND not parked" rule.

ALTER TABLE tasks ADD COLUMN parked_reason TEXT;

CREATE TABLE task_deps (
    task_id            TEXT NOT NULL REFERENCES tasks(id),
    depends_on_task_id TEXT NOT NULL REFERENCES tasks(id),
    status             TEXT NOT NULL DEFAULT 'pending',
    PRIMARY KEY (task_id, depends_on_task_id)
);

CREATE INDEX idx_task_deps_depends_on ON task_deps(depends_on_task_id);
