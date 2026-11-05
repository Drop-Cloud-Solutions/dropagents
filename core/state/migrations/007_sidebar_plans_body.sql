-- 007_sidebar_plans_body — add `body` column to the sidebar_plans projection.
--
-- The edit-plan modal (AP-IFB-005's wiring on top of new-plan) pre-fills the
-- operator's existing body when reopening a plan; 006 carried name + status
-- only, leaving the body sourced from the event log. Folding the body into
-- the projection keeps the modal's open path a single bounded SELECT
-- (`GET /api/projects/:pid/plans/:planId`) rather than a scan of every
-- PlanCreated / PlanUpdated event payload.
--
-- ALTER TABLE … ADD COLUMN is non-destructive: existing rows materialise the
-- new column as NULL, which the modal treats as "no body yet" (the body
-- textarea opens empty exactly as it did before this migration).

ALTER TABLE sidebar_plans ADD COLUMN body TEXT;
