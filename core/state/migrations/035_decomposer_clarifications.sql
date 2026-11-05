-- Questions the DECOMPOSER asked the operator, and the answers it got.
--
-- Field case: the decomposer hit an ambiguity it could not resolve, emitted
-- its `NEEDS_HUMAN_INPUT` escape hatch (every persona carries the block) and
-- stopped. `emitPlanDecomposed` then looked for JSON, found prose, and the
-- run died as "decomposer output contains no JSON object". The operator saw
-- a red card with a parser error and no hint that an agent had asked them
-- something, let alone a way to answer it.
--
-- Tasks have had this for a long time (`task_clarifications`, migration 033).
-- This is the same durability for the plan-lifecycle side: the question is
-- recorded when it is asked so the decomposer card can hold and render an
-- Answer button across a board reload or a worker restart, and the answer is
-- recorded next to it so the re-spawned decomposer is handed every prior
-- decision — not just the last one.
--
-- One row per question, keyed by the seq of the `PlanDecomposeQuestionRaised`
-- event so a projection replay re-inserts the same rows rather than
-- duplicating them. `answer` / `answered_at` stay NULL until the operator
-- answers: "the newest row for this plan with a NULL answer" IS the pending
-- question, which is what the Answer button resolves against.
CREATE TABLE IF NOT EXISTS decomposer_clarifications (
    event_seq   INTEGER PRIMARY KEY,
    plan_id     TEXT NOT NULL,
    project_id  TEXT NOT NULL DEFAULT '',
    question    TEXT NOT NULL,
    -- JSON array of {key,label} as the agent enumerated them, or NULL when
    -- it offered none. Rendered as radio buttons in the Answer modal.
    options     TEXT,
    asked_at    INTEGER NOT NULL,
    answer      TEXT,
    answered_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_decomposer_clarifications_plan
    ON decomposer_clarifications(plan_id, event_seq);
