-- AP-FP-001 — projection tables backing the operator sidebar (projects + plans).
--
-- This file is loaded on projection-store startup and applied against the
-- projection database. It MUST stay additive and idempotent: operator
-- machines already run with populated projection DBs from earlier tasks
-- (task-projection-store / decompose-status-store), so re-running this
-- script on boot must be a no-op rather than a rewrite. Every statement
-- below therefore uses `CREATE ... IF NOT EXISTS`.
--
-- All timestamps are stored as INTEGER unix-epoch milliseconds, matching the
-- convention documented in core/state/schema.sql. `archived_at` is NULL while
-- the row is active and stamped with the archive timestamp when the operator
-- hides it; the sidebar filters on `archived_at IS NULL`, which the indexes
-- below support directly.

-- Projects: one row per pipeline project the operator has created. Mirrors
-- a Linear Initiative when `linear_initiative_id` is set; standalone
-- projects leave that column NULL. `name` is the operator-facing label.
CREATE TABLE IF NOT EXISTS projects (
    id                   TEXT    NOT NULL PRIMARY KEY,
    name                 TEXT,
    linear_initiative_id TEXT,
    archived_at          INTEGER,
    updated_at           INTEGER
);

-- Plans: one row per plan inside a project. Composite primary key
-- (pid, plan_id) so the same `plan_id` can appear under multiple projects
-- without collision (legacy data, copied templates) and so per-project
-- lookups hit the PK index directly. `status` carries the operator-facing
-- vocabulary documented in shared/plan-linear.ts.
CREATE TABLE IF NOT EXISTS plans (
    plan_id     TEXT    NOT NULL,
    pid         TEXT    NOT NULL,
    name        TEXT,
    status      TEXT,
    archived_at INTEGER,
    updated_at  INTEGER,
    PRIMARY KEY (pid, plan_id)
);

-- Sidebar filters on `archived_at IS NULL` to show only active rows. An
-- index on `archived_at` alone is enough for the projects list; plans are
-- always scoped to a project first, so the plans index is composite over
-- (pid, archived_at) to keep the per-project active-filter query covered
-- by a single index seek.
CREATE INDEX IF NOT EXISTS idx_projects_active ON projects(archived_at);
CREATE INDEX IF NOT EXISTS idx_plans_active ON plans(pid, archived_at);

-- Agents: read model backing GET /agents, folded from the manager-api
-- AgentCreated/AgentUpdated/AgentDeleted events. Mirrored from
-- core/state/migrations/025_agents_projection.sql so a projection DB stood up
-- directly from this file carries the table too (same as `projects` above).
-- `deleted_at` is NULL while active; the DeleteAgent path emits AgentDeleted
-- and hard-deletes stamp it. The active-agents read filters on
-- `deleted_at IS NULL`, covered by the index below.
CREATE TABLE IF NOT EXISTS agents (
    agent_id   TEXT    NOT NULL PRIMARY KEY,
    name       TEXT,
    role       TEXT,
    provider   TEXT,
    model      TEXT,
    prompt     TEXT,
    deleted_at INTEGER,
    updated_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_agents_active ON agents(deleted_at);
