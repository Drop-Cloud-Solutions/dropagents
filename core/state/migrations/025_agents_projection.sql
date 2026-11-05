-- 025_agents_projection — read-model table backing GET /agents.
--
-- The manager-api agent CRUD path emits AgentCreated/AgentUpdated/AgentDeleted
-- events; this table is the projection those events fold into so the operator
-- UI can list and edit agents without replaying the event stream. It is a read
-- model only — the event store remains the source of truth.
--
-- Idempotent: operator machines already run with populated projection DBs from
-- earlier tasks, so every statement uses `CREATE ... IF NOT EXISTS` and this
-- migration is a no-op when the table is already present. The same CREATE TABLE
-- block is mirrored in adapters/projections/schema.sql so a projection DB stood
-- up directly from that file carries the table too, matching how `projects`
-- appears in both places.
--
-- Column conventions match the rest of the v2 schema: integer epoch-ms
-- timestamps. `deleted_at` is NULL while the agent is active; the DeleteAgent
-- path emits AgentDeleted and hard-deletes stamp it with the deletion time. The
-- active-agents read filters on `deleted_at IS NULL`, which the index below
-- covers with a single seek.

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
