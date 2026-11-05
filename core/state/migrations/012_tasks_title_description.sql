-- 012_tasks_title_description — extend the legacy `tasks` table with the
-- two fields the decomposer-projected `TaskCreated` events carry but the
-- 001_initial schema lacked: a human-readable `title` and a free-form
-- `description`. Without these, the operator board's task cards lose
-- their labels the moment a worker-api restart drops the in-memory
-- `tasks` Map — the durable projection had nothing to rebuild them
-- from.
--
-- Both columns are nullable: legacy rows authored before this migration
-- (or by callers that don't supply the fields, such as the
-- `CreateTask` command emitting a `TaskCreated` without title) read
-- back as `NULL` and the renderer falls through to its empty-string
-- fallback.

ALTER TABLE tasks ADD COLUMN title       TEXT;
ALTER TABLE tasks ADD COLUMN description TEXT;
