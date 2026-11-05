-- 024_requirement_design_md — Architect Tier (Phase 2).
--
-- The design-document Markdown (narrative + inline Mermaid diagrams) the
-- architect emits before the JSON proposal. Carried on ArchitectureProposed
-- and folded here so the board's requirement modal can render it (via the
-- markdown + Mermaid path) and a follow-on step can commit it to the
-- architecture repo. Existing rows backfill to NULL.

ALTER TABLE requirements ADD COLUMN design_md TEXT;
