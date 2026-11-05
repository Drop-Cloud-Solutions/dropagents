-- 0002-project-id — namespace every row in the storage adapter by project.
--
-- AP-NVP-040 (AP-IFW-013). One pipeline now drives many projects; rows from
-- project A must never bleed into reads scoped to project B. Each of
-- event_log, subscriber_offsets, and claims gains a `project_id TEXT NOT
-- NULL` column.
--
-- Backfill for rows that pre-date this migration uses the single
-- DEFAULT_PROJECT_ID known at migration time. The applyStorageMigrations
-- runner in adapters/storage/sqlite.ts substitutes the `{{DEFAULT_PROJECT_ID}}`
-- placeholder with that value (read from env DEFAULT_PROJECT_ID or supplied
-- explicitly by the caller) before executing the file. The default also
-- survives on the column so that future ALTERs of a fresh DB don't fail —
-- production inserts always supply project_id explicitly through the
-- ProjectScopedStore API.
--
-- subscriber_offsets is rebuilt rather than ALTER'd: its prior primary key
-- was just `subscriber`, but offsets are inherently per-project, so the new
-- primary key is the composite (project_id, subscriber). SQLite cannot
-- redefine a PRIMARY KEY in place, so the table is rewritten.

ALTER TABLE event_log
    ADD COLUMN project_id TEXT NOT NULL DEFAULT '{{DEFAULT_PROJECT_ID}}';

CREATE INDEX idx_event_log_project ON event_log(project_id, seq);

-- Rebuild subscriber_offsets with a project-scoped primary key.
CREATE TABLE subscriber_offsets_new (
    project_id TEXT    NOT NULL,
    subscriber TEXT    NOT NULL,
    last_seq   INTEGER NOT NULL,
    PRIMARY KEY (project_id, subscriber)
);

INSERT INTO subscriber_offsets_new (project_id, subscriber, last_seq)
SELECT '{{DEFAULT_PROJECT_ID}}', subscriber, last_seq FROM subscriber_offsets;

DROP TABLE subscriber_offsets;
ALTER TABLE subscriber_offsets_new RENAME TO subscriber_offsets;

-- Rebuild claims so the uniqueness of `subject` becomes per-project rather
-- than global. A claim for "foo" in project A must not block a claim for
-- "foo" in project B.
CREATE TABLE claims_new (
    project_id TEXT    NOT NULL,
    subject    TEXT    NOT NULL,
    owner      TEXT    NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (project_id, subject)
);

INSERT INTO claims_new (project_id, subject, owner, created_at)
SELECT '{{DEFAULT_PROJECT_ID}}', subject, owner, created_at FROM claims;

DROP INDEX IF EXISTS idx_claims_subject;
DROP TABLE claims;
ALTER TABLE claims_new RENAME TO claims;
