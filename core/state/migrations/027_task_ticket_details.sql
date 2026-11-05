-- Structured "ticket" fields for decomposed tasks (goal, acceptance
-- criteria, file impact) — one JSON column rather than five sparse ones.
-- The decomposer has always produced these in its per-task context block;
-- until now the flattening step dropped them, so neither the board nor
-- the agents' TASK.md ever saw the acceptance criteria. NULL for tasks
-- created before this migration (and for non-decomposer paths), which the
-- readers treat as "render the plain description only".
ALTER TABLE tasks ADD COLUMN ticket_details TEXT;
