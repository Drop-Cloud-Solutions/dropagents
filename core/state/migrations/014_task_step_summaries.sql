-- 014_task_step_summaries — per-step agent run records for the operator
-- board's stage-bar chips. One row per (task_id, step_id) captures the
-- start/finish timestamps, the agent role, the terminal status, and the
-- assistant text the agent emitted during its run. The board reads this
-- to colour the stage chips (todo / active / done / failed) and to
-- populate the per-step summary modal the operator opens by clicking a
-- chip.
--
-- The summary is the concatenated `AgentProgress.chunk` text the agent
-- emitted. Held in-memory under the spawn's agentId while the run is
-- in flight; flushed to this row on the agent's terminal event so the
-- summary is durable across reloads and worker restarts. (A
-- mid-restart agent loses its in-flight chunks; subsequent runs after
-- the restart work normally.)

CREATE TABLE IF NOT EXISTS task_step_summaries (
    task_id     TEXT    NOT NULL,
    step_id     TEXT    NOT NULL,
    role        TEXT,
    status      TEXT    NOT NULL,    -- 'running' | 'complete' | 'failed'
    started_at  INTEGER NOT NULL,
    finished_at INTEGER,
    summary     TEXT,
    PRIMARY KEY (task_id, step_id)
);

CREATE INDEX IF NOT EXISTS idx_task_step_summaries_task
    ON task_step_summaries(task_id, started_at);
