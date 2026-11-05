-- 004_parked_step_id_and_feedback — resume marker for parked tasks and a
-- reject-feedback channel between agent runs (AP-VP-005).
--
-- Two nullable text columns, both backfill to NULL on existing rows because
-- no DEFAULT is set:
--
--   1. flow_state.parked_step_id — the step id where a task is currently
--      parked. Resume routes back to this step directly instead of replaying
--      the event log to derive it. Distinct from `paused_step` (added in
--      002), which is the resume marker for AgentQuestion investigation
--      sub-flows; `parked_step_id` is for tasks parked pending an external
--      signal (operator action, PR merge) and is paired with tasks.parked_reason.
--
--   2. tasks.feedback — operator feedback captured on reject. The next agent
--      run consumes the value and the run-success handler clears it back to
--      NULL. Keeping it on the task (not flow_state) means the value survives
--      flow_state resets and is naturally scoped to the task lifetime.
--
-- Idempotency is provided by the migration runner ledger (__migrations); this
-- file matches the bare-ALTER pattern used by 002 and 003.

ALTER TABLE flow_state ADD COLUMN parked_step_id TEXT;
ALTER TABLE tasks ADD COLUMN feedback TEXT;
