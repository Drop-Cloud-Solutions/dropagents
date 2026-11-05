-- 009_projects_metadata — store the operator-supplied project extras on
-- the sidebar `projects` projection.
--
-- The new-project / edit-project modal collects name + abbr + slug + a
-- colour swatch + a description + zero-or-more repos. The 006 schema
-- only carried name + linear_initiative_id; abbr/color/description/repos
-- had no column, so the Create/Update commands silently dropped them on
-- the floor (board accepted them, projection never saw them, edit modal
-- opened blank).
--
-- Stored as TEXT holding a JSON object — same pattern as plans (008) so
-- a future operator-facing project field doesn't require a column bump.
-- The projection store serialises on write; the read route parses on
-- output. Existing rows materialise the new column as NULL.

ALTER TABLE projects ADD COLUMN metadata TEXT;
