-- dropagents — SQLite state schema (reference snapshot)
--
-- This file is the authoritative reference for the full schema as it exists
-- after all migrations under core/state/migrations/ have been applied. It is
-- not executed directly by the migration runner; runtime bootstrap is driven
-- by the versioned files in migrations/ (see migrations.ts).
--
-- All timestamps are stored as INTEGER unix-epoch milliseconds (Date.now()).

-- Plans: an operator-approved unit of work for a project.
CREATE TABLE plans (
    id          TEXT    NOT NULL PRIMARY KEY,
    project_id  TEXT    NOT NULL,
    status      TEXT    NOT NULL,
    created_at  INTEGER NOT NULL
);

-- Tasks: individual issues that belong to a plan and follow a flow definition.
-- parked_reason is set by the flow engine / scheduler when a task is held
-- pending an external signal (operator action, PR merge). NULL means "not
-- parked"; eligibleTasks (core/flow/scheduler.ts) excludes any task with a
-- non-NULL/non-empty parked_reason from the eligible set.
CREATE TABLE tasks (
    id            TEXT    NOT NULL PRIMARY KEY,
    plan_id       TEXT    NOT NULL REFERENCES plans(id),
    type          TEXT    NOT NULL,
    status        TEXT    NOT NULL,
    flow_id       TEXT,
    flow_position INTEGER,
    parked_reason TEXT,
    feedback      TEXT
);

CREATE INDEX idx_tasks_plan_id ON tasks(plan_id);

-- Task dependencies: directed edges (task_id depends on depends_on_task_id).
-- status tracks the merge state of the edge — 'pending' until the upstream
-- task's PR has merged, then 'merged'. The scheduler gates eligibility on
-- "all of a task's edges are 'merged'", so the per-edge column avoids a join
-- back through tasks on the hot path.
CREATE TABLE task_deps (
    task_id            TEXT NOT NULL REFERENCES tasks(id),
    depends_on_task_id TEXT NOT NULL REFERENCES tasks(id),
    status             TEXT NOT NULL DEFAULT 'pending',
    PRIMARY KEY (task_id, depends_on_task_id)
);

CREATE INDEX idx_task_deps_depends_on ON task_deps(depends_on_task_id);

-- Agent runs: one row per spawned agent invocation against a task.
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

-- Events: append-only log. `seq` is the canonical ordering; `idempotency_key`
-- is the producer-supplied de-dup token (UNIQUE so duplicate publishes fail
-- atomically rather than corrupting downstream offsets).
CREATE TABLE events (
    seq             INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    type            TEXT    NOT NULL,
    v               INTEGER NOT NULL,
    occurred_at     INTEGER NOT NULL,
    idempotency_key TEXT    NOT NULL UNIQUE,
    payload         TEXT    NOT NULL
);

CREATE INDEX idx_events_type ON events(type);

-- Flow state: the projected current step for each task plus the seq of the
-- last event that mutated it. One row per task. `paused_step` is set when an
-- AgentQuestion fires an investigation sub-flow and the parent flow needs a
-- resume marker that survives the sub-flow run.
CREATE TABLE flow_state (
    task_id        TEXT    NOT NULL PRIMARY KEY REFERENCES tasks(id),
    current_step   TEXT    NOT NULL,
    last_event_seq INTEGER,
    paused_step    TEXT,
    parked_step_id TEXT
);

-- External refs: maps an internal id to an external system's id. claim_owner
-- carries the v1/v2 lockout marker so the same external resource is never
-- driven by two pipelines simultaneously.
CREATE TABLE external_refs (
    local_id     TEXT NOT NULL,
    system       TEXT NOT NULL,
    external_id  TEXT NOT NULL,
    claim_owner  TEXT,
    PRIMARY KEY (local_id, system)
);

CREATE INDEX idx_external_refs_claim_owner ON external_refs(claim_owner);
CREATE INDEX idx_external_refs_system_external ON external_refs(system, external_id);

-- Subscriber offsets: per-consumer high-water mark over the events log.
CREATE TABLE subscriber_offsets (
    subscriber TEXT    NOT NULL PRIMARY KEY,
    last_seq   INTEGER NOT NULL
);

-- Migration ledger: managed by the migration runner. Each row records a
-- successfully-applied migration file from core/state/migrations/.
CREATE TABLE __migrations (
    version    TEXT    NOT NULL PRIMARY KEY,
    applied_at INTEGER NOT NULL
);
