-- 006_sidebar_projections — projection tables backing the operator board
-- sidebar (projects column + per-project plan list). Promotes the AP-FP-001
-- schema (formerly adapters/projections/schema.sql) into the migrations
-- runner so the tables exist on every boot. Idempotent: every CREATE uses
-- IF NOT EXISTS so a second application is a no-op.
--
-- Naming choice: `projects` is unclaimed in the v1 schema, so it lands as-is.
-- The plan projection is named `sidebar_plans` to avoid colliding with the
-- v1 `plans` table from 001_initial.sql (single PK `id`, written by
-- `attachPlanProjection` on PLAN_APPROVED). The two tables hold different
-- shapes and serve different readers; renaming the new one is the smallest
-- change that lets them coexist while we untangle the legacy table later.
--
-- Column conventions match the rest of the v2 schema: integer epoch-ms
-- timestamps, soft delete via `archived_at IS NULL`. The sidebar filters on
-- that predicate, so the indexes below cover the active-row queries
-- (`SELECT ... WHERE archived_at IS NULL` for projects, plus a `pid`
-- equality for the plans variant) with a single index seek.

CREATE TABLE IF NOT EXISTS projects (
    id                   TEXT    NOT NULL PRIMARY KEY,
    name                 TEXT,
    linear_initiative_id TEXT,
    archived_at          INTEGER,
    updated_at           INTEGER
);

CREATE TABLE IF NOT EXISTS sidebar_plans (
    plan_id     TEXT    NOT NULL,
    pid         TEXT    NOT NULL,
    name        TEXT,
    status      TEXT,
    archived_at INTEGER,
    updated_at  INTEGER,
    PRIMARY KEY (pid, plan_id)
);

CREATE INDEX IF NOT EXISTS idx_projects_active ON projects(archived_at);
CREATE INDEX IF NOT EXISTS idx_sidebar_plans_active ON sidebar_plans(pid, archived_at);
