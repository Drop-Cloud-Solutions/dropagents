-- 001_initial — bootstrap the v2 SQLite state schema.
--
-- The __migrations table is created by the runner before this file is read,
-- so it is intentionally omitted here. Every other table in schema.sql is
-- defined below.

CREATE TABLE plans (
    id          TEXT    NOT NULL PRIMARY KEY,
    project_id  TEXT    NOT NULL,
    status      TEXT    NOT NULL,
    created_at  INTEGER NOT NULL
);

CREATE TABLE tasks (
    id            TEXT    NOT NULL PRIMARY KEY,
    plan_id       TEXT    NOT NULL REFERENCES plans(id),
    type          TEXT    NOT NULL,
    status        TEXT    NOT NULL,
    flow_id       TEXT,
    flow_position INTEGER
);

CREATE INDEX idx_tasks_plan_id ON tasks(plan_id);

CREATE TABLE agent_runs (
    id          TEXT    NOT NULL PRIMARY KEY,
    task_id     TEXT    NOT NULL REFERENCES tasks(id),
    role        TEXT    NOT NULL,
    status      TEXT    NOT NULL,
    started_at  INTEGER NOT NULL,
    finished_at INTEGER,
    model       TEXT
);

CREATE INDEX idx_agent_runs_task_id ON agent_runs(task_id);

CREATE TABLE events (
    seq             INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    type            TEXT    NOT NULL,
    v               INTEGER NOT NULL,
    occurred_at     INTEGER NOT NULL,
    idempotency_key TEXT    NOT NULL UNIQUE,
    payload         TEXT    NOT NULL
);

CREATE INDEX idx_events_type ON events(type);

CREATE TABLE flow_state (
    task_id        TEXT    NOT NULL PRIMARY KEY REFERENCES tasks(id),
    current_step   TEXT    NOT NULL,
    last_event_seq INTEGER
);

CREATE TABLE external_refs (
    local_id     TEXT NOT NULL,
    system       TEXT NOT NULL,
    external_id  TEXT NOT NULL,
    claim_owner  TEXT,
    PRIMARY KEY (local_id, system)
);

CREATE INDEX idx_external_refs_claim_owner ON external_refs(claim_owner);
CREATE INDEX idx_external_refs_system_external ON external_refs(system, external_id);

CREATE TABLE subscriber_offsets (
    subscriber TEXT    NOT NULL PRIMARY KEY,
    last_seq   INTEGER NOT NULL
);
