-- 022_tasks_instructions — operator instructions / remarks on a task.
--
-- Free-text guidance the operator adds to a task BEFORE it starts (a
-- screenshot caption in prose form: "use the existing FooService, don't add
-- a new DI registration", "match the table layout in the attached mockup").
-- Distinct from the decomposer-authored `description` (which it never
-- overwrites) and from `feedback` (post-run reject reason). Set via the
-- SetTaskInstructions command; folded into the agent prompt + TASK.md as an
-- `# Operator instructions` block so the developer/reviewer/etc. follow it.
--
-- Existing rows backfill to NULL (no instructions).

ALTER TABLE tasks ADD COLUMN instructions TEXT;
