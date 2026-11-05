-- 023_requirements — Architect Tier (Phase 2) projections.
--
-- A requirement is the top-level initiative the architect agent turns into a
-- cross-system design + independent per-system sub-briefs. These tables are
-- projections folded from the requirement lifecycle events
-- (RequirementSubmitted / ArchitectureProposed / ArchitectureApproved /
-- RequirementArchived) plus BriefSubmitted (for the fan-out linkage). The
-- event log stays the source of truth; re-applying an event is idempotent
-- via the monotonic updated_at guard on the parent row.

CREATE TABLE IF NOT EXISTS requirements (
    requirement_id       TEXT PRIMARY KEY,
    title                TEXT NOT NULL DEFAULT '',
    description          TEXT NOT NULL DEFAULT '',
    -- submitted → architecting → proposed → approved → archived
    status               TEXT NOT NULL DEFAULT 'submitted',
    revision             INTEGER NOT NULL DEFAULT 1,
    design_doc_path      TEXT,
    architecture_repo_id TEXT,
    created_at           INTEGER NOT NULL DEFAULT 0,
    updated_at           INTEGER NOT NULL DEFAULT 0,
    archived_at          INTEGER
);

-- Shared contracts the architect defined (replaced wholesale on each new
-- ArchitectureProposed revision).
CREATE TABLE IF NOT EXISTS requirement_contracts (
    requirement_id      TEXT NOT NULL,
    contract_id         TEXT NOT NULL,
    kind                TEXT NOT NULL,
    name                TEXT NOT NULL,
    producer_system     TEXT NOT NULL,
    summary             TEXT NOT NULL DEFAULT '',
    schema_ref          TEXT NOT NULL,
    backward_compatible INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (requirement_id, contract_id)
);

CREATE TABLE IF NOT EXISTS requirement_contract_consumers (
    requirement_id TEXT NOT NULL,
    contract_id    TEXT NOT NULL,
    system_id      TEXT NOT NULL,
    PRIMARY KEY (requirement_id, contract_id, system_id)
);

-- The proposed per-system sub-briefs (independent). Produces/consumes are
-- JSON arrays of contractIds.
CREATE TABLE IF NOT EXISTS requirement_subbriefs (
    requirement_id TEXT NOT NULL,
    system_id      TEXT NOT NULL,
    title          TEXT NOT NULL DEFAULT '',
    brief          TEXT NOT NULL DEFAULT '',
    produces       TEXT NOT NULL DEFAULT '[]',
    consumes       TEXT NOT NULL DEFAULT '[]',
    PRIMARY KEY (requirement_id, system_id)
);

-- Deploy-time ordering only (system_id deploys AFTER deploy_after).
CREATE TABLE IF NOT EXISTS requirement_rollout (
    requirement_id TEXT NOT NULL,
    system_id      TEXT NOT NULL,
    deploy_after   TEXT NOT NULL,
    reason         TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (requirement_id, system_id, deploy_after)
);

-- Fan-out linkage: one row per child brief spawned from an approved
-- requirement. plan_id is filled in later if/when the plan id is reconciled;
-- system_id is the target project.
CREATE TABLE IF NOT EXISTS requirement_plans (
    requirement_id TEXT NOT NULL,
    brief_id       TEXT NOT NULL,
    system_id      TEXT NOT NULL,
    plan_id        TEXT,
    PRIMARY KEY (requirement_id, brief_id)
);
