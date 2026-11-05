-- 017_chat_sessions — board-side chat surface (Phase 1: read-only Q&A).
--
-- chat_sessions:  one row per chat thread the operator opens. The session
--                 owns the cwd the chat agent runs in (a workspace-repo
--                 clone path) and persists `cli_session` — the claude-cli
--                 `--resume <id>` token returned from the prior turn,
--                 which is what carries the conversational memory across
--                 turns. NULL on first turn; populated as soon as the
--                 first claude invocation returns its session_id.
--
-- chat_messages:  ordered message log per session. `role` is one of
--                 'user' | 'assistant'. `body` is the raw text; the UI
--                 renders it as Markdown. `metadata` is a JSON blob for
--                 future per-message extras (token counts, tool uses,
--                 etc.) so we don't need a migration to add fields.
--
-- Both tables are intentionally simple — Phase 1 is a thin wrapper
-- around claude-cli's own session store; we use SQLite only to surface
-- the conversation in the UI and to remember which cli-session token
-- belongs to which board chat row.

CREATE TABLE chat_sessions (
    id          TEXT    NOT NULL PRIMARY KEY,
    project_id  TEXT    NOT NULL,
    repo_id     TEXT,
    cli_session TEXT,
    cwd         TEXT    NOT NULL,
    title       TEXT,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);

CREATE INDEX idx_chat_sessions_project ON chat_sessions(project_id, updated_at DESC);

CREATE TABLE chat_messages (
    seq        INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    session_id TEXT    NOT NULL,
    role       TEXT    NOT NULL,
    body       TEXT    NOT NULL,
    metadata   TEXT,
    created_at INTEGER NOT NULL
);

CREATE INDEX idx_chat_messages_session ON chat_messages(session_id, seq);
