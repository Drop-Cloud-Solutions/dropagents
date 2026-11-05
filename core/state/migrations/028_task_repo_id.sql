-- Per-task repo (resolved from the decomposer's context.repo_path).
-- Worktree creation previously used ONLY the plan's metadata.targetRepo;
-- when the planner discovered the change lives in a different repo, the
-- task's agent got a worktree for the wrong repo and edited the right
-- repo's SHARED CLONE directly (which the pre-step refresh then wipes).
-- NULL falls back to the plan's targetRepo — pre-028 behaviour.
ALTER TABLE tasks ADD COLUMN repo_id TEXT;
