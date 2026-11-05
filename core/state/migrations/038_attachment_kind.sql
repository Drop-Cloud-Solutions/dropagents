-- 038_attachment_kind — an attachment is either operator INPUT or agent OUTPUT.
--
-- Migration 021 stored one kind of attachment: a file the operator pinned
-- to a task / plan / requirement as input for the agents. Tasks also
-- PRODUCE files — a findings CSV, a generated document — and the operator
-- wants those downloadable from the finished task instead of having to go
-- hunting for them on the worker's disk (field report: an investigation
-- wrote `mao-sgtin-discrepancies.csv` into a folder it invented under the
-- workspace root, and the only trace of it was a path quoted in the
-- report prose).
--
-- Outputs share the blob store, the download route and the board's
-- attachment card with inputs, so they share this table too — the one
-- thing that must never blur is the DIRECTION. An output copied back into
-- a later step's worktree would be handed to the agent as if the operator
-- had asked for it, and the committer stages what it finds: a harvested
-- CSV would end up in the repo. `kind` is what the worktree materialiser
-- filters on.
--
-- 'input' is the default so every row written before this migration (all
-- of them operator uploads) keeps its meaning without a backfill.

ALTER TABLE attachments ADD COLUMN kind TEXT NOT NULL DEFAULT 'input';

-- The per-owner list is now always read with a kind filter (the modal
-- shows inputs and outputs in separate sections), so the index carries
-- the column.
CREATE INDEX IF NOT EXISTS idx_attachments_owner_kind
    ON attachments (owner_type, owner_id, kind);
