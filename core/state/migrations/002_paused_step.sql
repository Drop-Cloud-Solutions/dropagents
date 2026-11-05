-- 002_paused_step — record where a paused parent flow should resume after an
-- investigation sub-flow completes.
--
-- The flow engine's existing on_question handler keeps `current_step` as a
-- resume marker, but `current_step` is also the column the engine reads to
-- know where the task *is* — it cannot also represent "where the parent flow
-- left off" without conflating the two roles. `paused_step` is the explicit
-- pointer: written when an AgentQuestion enters the default investigation
-- branch, read when InvestigationCompleted arrives.

ALTER TABLE flow_state ADD COLUMN paused_step TEXT;
