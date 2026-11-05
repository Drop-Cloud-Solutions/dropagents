-- 015_task_worktrees — per-task feature-branch worktree registry.
--
-- One row per task, recording the worktree directory the developer /
-- reviewer / tester / committer agents share for a single task run.
-- Created lazily when the StartAgent handler first resolves a repo
-- spec for the task; cleaned up either when the PR merges or via the
-- existing daily worktree-gc job.
--
-- `branch` is the feature branch name (e.g. `task/task-001`) checked
-- out in the worktree. `path` is the absolute filesystem path the
-- agents use as their cwd. `pushed_at` / `pr_url` / `pr_number` are
-- populated by the post-commit hook that runs `git push` and
-- `gh pr create` after the committer agent finishes.

CREATE TABLE IF NOT EXISTS task_worktrees (
    task_id     TEXT    NOT NULL PRIMARY KEY,
    repo_id     TEXT    NOT NULL,
    branch      TEXT    NOT NULL,
    path        TEXT    NOT NULL,
    created_at  INTEGER NOT NULL,
    pushed_at   INTEGER,
    pr_url      TEXT,
    pr_number   INTEGER
);
