-- 0001-init — bootstrap the project-aware storage adapter.
--
-- These tables are owned by adapters/storage/sqlite.ts and are independent
-- of the v1 core/state schema (events / external_refs). They exist so the
-- multi-project orchestrator can hold an append-only log, per-subscriber
-- offsets, and a claim ledger without re-using v1-shaped tables that v1
-- callers may still be reading.
--
-- project_id is intentionally NOT present here; migration 0002-project-id
-- adds it as a NOT NULL column with a backfill default. Splitting the
-- introduction across two files lets the project_id rollout reuse the same
-- migration step on a database that was bootstrapped before the multi-
-- project work landed.

CREATE TABLE event_log (
    seq             INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    type            TEXT    NOT NULL,
    v               INTEGER NOT NULL,
    occurred_at     INTEGER NOT NULL,
    idempotency_key TEXT    NOT NULL UNIQUE,
    payload         TEXT    NOT NULL
);

CREATE INDEX idx_event_log_type ON event_log(type);

CREATE TABLE subscriber_offsets (
    subscriber TEXT    NOT NULL PRIMARY KEY,
    last_seq   INTEGER NOT NULL
);

CREATE TABLE claims (
    subject    TEXT    NOT NULL,
    owner      TEXT    NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX idx_claims_subject ON claims(subject);
