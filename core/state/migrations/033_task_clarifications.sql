-- Operator answers to agent clarification questions, kept for the whole
-- task lifetime.
--
-- Field case: an agent asked the operator to decide something that
-- conflicted with the task statement. The operator answered, the
-- developer implemented the answer, and the REVIEWER then rejected the
-- change for not matching the task statement — because the answer had
-- never reached it. The engine threads the answer through as
-- `humanAnswer` context on the ONE re-dispatched step it resumed
-- (engine.ts onTaskResumed); the review / test / commit steps that
-- follow get a StartAgent with no such context, and TASK.md is
-- regenerated per step, so the `# Human clarification` section the
-- developer saw is actively erased for everyone after it.
--
-- Reject feedback already survives this way via `tasks.feedback`
-- ("scoped to the task lifetime" — engine.writeTaskFeedback). This is
-- the same durability for clarification answers, accumulating rather
-- than overwriting: a task may be clarified up to 3 times and every
-- answer stays binding.
--
-- Keyed by the source event seq so a projection replay re-inserts the
-- same rows instead of duplicating them.
CREATE TABLE IF NOT EXISTS task_clarifications (
    event_seq   INTEGER PRIMARY KEY,
    task_id     TEXT NOT NULL,
    question    TEXT,
    answer      TEXT NOT NULL,
    answered_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_task_clarifications_task
    ON task_clarifications(task_id, event_seq);
