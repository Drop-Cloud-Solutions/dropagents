-- 021_attachments — image/document attachments on tasks and plans.
--
-- The operator attaches screenshots ("here's what went wrong"), mockups
-- ("here's how it should look"), sequence diagrams, or spec documents to a
-- task or plan from the board. The bytes live on disk behind an
-- AttachmentBlobStore port (filesystem today, swappable for Azure Blob);
-- this table is the projection of attachment METADATA, folded from
-- AttachmentAdded / AttachmentRemoved events by the orchestrator's
-- attachments-projection subscriber.
--
-- owner_type is 'task' | 'plan'; owner_id is the task id or plan id. A
-- single (owner_type, owner_id) index backs the per-owner list the board
-- modal and the agent-context builder both read. storage_path is the
-- opaque key the blob store handed back (the on-disk path today) — never
-- surfaced to the browser, which addresses attachments by id.
--
-- caption is the operator's note on the attachment ("login button is
-- misaligned", "target layout") so the agent has the intent, not just the
-- pixels.

CREATE TABLE IF NOT EXISTS attachments (
    id           TEXT    NOT NULL PRIMARY KEY,
    owner_type   TEXT    NOT NULL,
    owner_id     TEXT    NOT NULL,
    file_name    TEXT    NOT NULL,
    content_type TEXT    NOT NULL,
    size_bytes   INTEGER NOT NULL,
    storage_path TEXT    NOT NULL,
    caption      TEXT,
    created_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_attachments_owner
    ON attachments (owner_type, owner_id);
