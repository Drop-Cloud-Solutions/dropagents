-- 019_chat_plan_links — durable plan → chat-session link.
--
-- When the operator confirms a task proposal from chat, the board
-- creates a plan and links it to the originating chat session so the
-- SSE loop can narrate pipeline progress back into that thread. That
-- link was in-memory only, so a page reload dropped it and progress
-- narration stopped for in-flight work.
--
-- This table persists the link. The board POSTs it on plan creation
-- and rehydrates the full set on boot, so narration resumes after a
-- reload. One row per plan (a plan has exactly one originating
-- session); session_id is indexed for the rare reverse lookup.

CREATE TABLE chat_plan_links (
    plan_id    TEXT    NOT NULL PRIMARY KEY,
    session_id TEXT    NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE INDEX idx_chat_plan_links_session ON chat_plan_links(session_id);
