-- 016_task_deps_drop_fk — remove the `task_id` / `depends_on_task_id`
-- foreign-key constraints on task_deps so the orchestrator can persist
-- decomposer-declared edges in arrival order without forward-reference
-- failures.
--
-- The bridge subscriber that inserts edges fires per TaskCreated event.
-- When task-003 carries dependencies=['task-005'] and task-005 hasn't
-- arrived yet (decomposer occasionally emits out-of-order), the original
-- FK would reject the INSERT and the edge would silently vanish from
-- task_deps — leaving task-003 ungated even though the decomposer said
-- otherwise.
--
-- The relation is still documented and the helper methods on
-- SqliteTaskDependencyStore validate against the live tasks table at
-- read time. Dropping the FK trades schema-level enforcement for
-- arrival-order robustness; the trade is the same one migration 013
-- made for tasks.plan_id.
--
-- SQLite has no DROP CONSTRAINT, so we recreate the table without FKs
-- and copy rows across. defer_foreign_keys (transaction-scoped) is used
-- instead of foreign_keys because the migration runner wraps each file
-- in a transaction and PRAGMA foreign_keys is ignored inside one.

PRAGMA defer_foreign_keys = ON;

CREATE TABLE task_deps_new (
    task_id            TEXT NOT NULL,
    depends_on_task_id TEXT NOT NULL,
    status             TEXT NOT NULL DEFAULT 'pending',
    PRIMARY KEY (task_id, depends_on_task_id)
);

INSERT INTO task_deps_new (task_id, depends_on_task_id, status)
SELECT task_id, depends_on_task_id, status FROM task_deps;

DROP TABLE task_deps;
ALTER TABLE task_deps_new RENAME TO task_deps;

CREATE INDEX idx_task_deps_depends_on ON task_deps(depends_on_task_id);
