-- Plan/requirement-scoped chat (side-by-side review chat). A scoped
-- session is pinned to one artifact; the chat turn prompt carries that
-- artifact's full context and the proposal confirms target it.
--   scope_kind: 'plan' | 'requirement' | NULL (unscoped chats unchanged)
--   scope_id:   planId / requirementId
ALTER TABLE chat_sessions ADD COLUMN scope_kind TEXT;
ALTER TABLE chat_sessions ADD COLUMN scope_id TEXT;
