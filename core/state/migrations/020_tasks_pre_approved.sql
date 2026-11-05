-- 020_tasks_pre_approved — operator pre-approval for dependency-gated tasks.
--
-- A task with unmet dependencies parks with parked_reason='waiting-deps'
-- and never reaches the engine until its upstreams merge, at which point
-- the unblock pass re-dispatches it and it parks AGAIN at the approval
-- gate — so the operator has to come back and approve it a second time.
--
-- pre_approved lets the operator approve a waiting-deps task up front:
-- the flag is set when they click Approve while it's still blocked, and
-- the engine's approval gate (resolveApproval) consumes it to auto-start
-- the task the moment its dependencies clear. One-shot — cleared on use
-- so a later retry re-prompts.
--
-- Existing rows backfill to 0 (not pre-approved) via the DEFAULT.

ALTER TABLE tasks ADD COLUMN pre_approved INTEGER NOT NULL DEFAULT 0;
