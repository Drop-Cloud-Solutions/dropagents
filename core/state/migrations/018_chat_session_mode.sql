-- 018_chat_session_mode — Phase 2 scratch-edit mode for chat.
--
-- Adds four columns to chat_sessions:
--
--   mode       'read-only' (Phase 1 default — cwd = bare clone, no
--              file writes) or 'scratch-edit' (per-session worktree
--              + branch, claude can Edit/Write/Bash, operator can
--              Commit & open PR).
--   branch     The git branch name for scratch-edit sessions
--              (`chat/<session-id>`). NULL for read-only.
--   pr_url     URL of the PR opened from this chat session, if any.
--   pr_number  Matching PR number for the gh CLI to act on.
--
-- All four are NULLable / defaulted so existing rows from Phase 1
-- continue to read back as read-only.

ALTER TABLE chat_sessions ADD COLUMN mode TEXT NOT NULL DEFAULT 'read-only';
ALTER TABLE chat_sessions ADD COLUMN branch TEXT;
ALTER TABLE chat_sessions ADD COLUMN pr_url TEXT;
ALTER TABLE chat_sessions ADD COLUMN pr_number INTEGER;
