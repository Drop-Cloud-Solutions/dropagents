-- 010_plan_review_projection — durable projection over PlanGenerated /
-- PlanDecomposed events. Replaces the in-memory PlanReviewStore so the
-- operator board's active-planner card survives a worker-api restart
-- and a page reload while the operator still owes an approve /
-- regenerate / discard decision.
--
-- Tables:
--   plan_review_drafts      one row per (plan, revision); the planner
--                           emits a new revision each time the operator
--                           clicks Regenerate. The latest row per plan
--                           is what the board's Show-report modal reads
--                           and what /api/plan-reviews returns to seed
--                           the active-planner card.
--   plan_review_decomposed  one row per plan whose decomposer has
--                           fired. listPending() filters these out so
--                           a card never re-pops after the decompose
--                           has been kicked off.
--
-- Idempotency: PlanGenerated UPSERTs by (plan_id, revision) and gates
-- the conflict branch on `excluded.generated_at >= drafts.generated_at`
-- so a replay with the same timestamp is a no-op and a strictly older
-- one cannot move state backwards. PlanDecomposed uses INSERT OR IGNORE
-- so the decomposed flag is monotonic. Combined with the EventBus's
-- per-subscriber offset tracking, this lets `replayMissed()` after a
-- restart drive the projection to the same state as a fresh fold.

CREATE TABLE IF NOT EXISTS plan_review_drafts (
    plan_id      TEXT    NOT NULL,
    revision     INTEGER NOT NULL,
    content      TEXT    NOT NULL DEFAULT '',
    feedback     TEXT,
    project_id   TEXT,
    generated_at INTEGER NOT NULL,
    PRIMARY KEY (plan_id, revision)
);

CREATE TABLE IF NOT EXISTS plan_review_decomposed (
    plan_id       TEXT    NOT NULL PRIMARY KEY,
    decomposed_at INTEGER NOT NULL
);

-- Covers `getLatest(planId)` and `listPending()` — both filter by
-- plan_id and want the highest revision row.
CREATE INDEX IF NOT EXISTS idx_plan_review_drafts_plan_rev
    ON plan_review_drafts(plan_id, revision DESC);
