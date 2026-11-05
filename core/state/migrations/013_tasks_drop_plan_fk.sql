-- 013_tasks_drop_plan_fk — remove the legacy `tasks.plan_id REFERENCES
-- plans(id)` foreign-key constraint that blocks the v2 task projection.
--
-- The v1 `plans` table from `001_initial.sql` is only written by
-- `attachPlanProjection` on `PlanApproved` events. The v2 plan
-- lifecycle (PlanCreated / PlanUpdated / PlanArchived) writes to a
-- separate `sidebar_plans` table (migration 006), so no v2-created
-- plan ever lands in the legacy `plans` table. With `foreign_keys = ON`
-- enforced by the runner, every `attachTaskProjection` INSERT for a
-- v2-created plan failed silently — `TaskCreated` events arrived on
-- the bus but the durable projection couldn't store them.
--
-- SQLite doesn't support `ALTER TABLE DROP CONSTRAINT`, so we recreate
-- the table without the FK and copy rows across. `defer_foreign_keys`
-- is used (instead of `foreign_keys`) because the migration runner
-- wraps each file in a transaction and SQLite ignores `PRAGMA
-- foreign_keys` inside transactions — `defer_foreign_keys` is the
-- transaction-aware equivalent that defers FK enforcement to the
-- COMMIT boundary. By then the rename in step 5 has restored a
-- `tasks` table for any FK references in `agent_runs` / `flow_state`
-- to resolve against (SQLite auto-updates those references to the
-- new name).

PRAGMA defer_foreign_keys = ON;

CREATE TABLE tasks_new (
    id            TEXT    NOT NULL PRIMARY KEY,
    plan_id       TEXT    NOT NULL,
    type          TEXT    NOT NULL,
    status        TEXT    NOT NULL,
    flow_id       TEXT,
    flow_position INTEGER,
    parked_reason TEXT,
    feedback      TEXT,
    title         TEXT,
    description   TEXT
);

INSERT INTO tasks_new (
    id, plan_id, type, status, flow_id, flow_position,
    parked_reason, feedback, title, description
)
SELECT
    id, plan_id, type, status, flow_id, flow_position,
    parked_reason, feedback, title, description
FROM tasks;

DROP TABLE tasks;
ALTER TABLE tasks_new RENAME TO tasks;

CREATE INDEX idx_tasks_plan_id ON tasks(plan_id);
