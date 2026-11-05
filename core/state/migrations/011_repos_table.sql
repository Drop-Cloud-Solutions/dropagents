-- 011_repos_table — workspace-level repo registry.
--
-- Repos are first-class entities at the workspace root, not nested under
-- projects. A repo is a microservice-style git repository the planner /
-- decomposer agents read from; many repos are shared across projects, so
-- storing them globally avoids duplicate clones, duplicate sync logic,
-- and divergent branch/url config when two projects reference the same
-- underlying GitHub repo.
--
-- Lifecycle:
--   RepoRegistered   -> INSERT row
--   RepoUpdated      -> UPDATE name/url/default_branch
--   RepoArchived     -> stamp archived_at (soft-delete; clone on disk stays)
--   RepoEnsured      -> populate ensured_path + last_synced_at + ok status
--   RepoEnsureFailed -> stamp last_sync_status='clone-failed' + error
--   RepoSynced       -> stamp last_synced_at + ok status
--   RepoSyncFailed   -> stamp last_sync_status='sync-failed' + error
--
-- Idempotency: every UPDATE-style write is gated on
-- @occurredAt > COALESCE(updated_at, 0) so a replayed event never moves
-- state backwards. The Registered path is INSERT ... ON CONFLICT(repo_id)
-- DO UPDATE so a duplicate Register collapses safely.

CREATE TABLE IF NOT EXISTS repos (
    repo_id          TEXT    NOT NULL PRIMARY KEY,
    name             TEXT    NOT NULL,
    url              TEXT    NOT NULL,
    default_branch   TEXT    NOT NULL DEFAULT 'main',
    ensured_path     TEXT,
    last_synced_at   INTEGER,
    last_sync_status TEXT,
    last_sync_error  TEXT,
    archived_at      INTEGER,
    updated_at       INTEGER
);

-- Active-rows query — the Repos modal filters on `archived_at IS NULL`.
CREATE INDEX IF NOT EXISTS idx_repos_active ON repos(archived_at);
