-- 008_sidebar_plans_metadata — store the V1 extra plan fields on the
-- sidebar_plans projection.
--
-- The new-plan / edit-plan modal collects a handful of fields beyond
-- title + body — conventions (4 named keys), plan type, target repo,
-- tech stack, deploy-after-merge / skip-plan-review / auto-trigger
-- booleans. Folding them into the projection as JSON keeps the schema
-- additive (no per-field column churn next time we add a knob) and
-- lets the read route surface the whole bag in one shot for the edit
-- modal's pre-fill.
--
-- Stored as TEXT holding a JSON object; the projection store serialises
-- on write and the read route returns the parsed object. Existing rows
-- materialise the new column as NULL, which the modal treats as "no
-- metadata captured" (every advanced / conventions input opens blank).

ALTER TABLE sidebar_plans ADD COLUMN metadata TEXT;
