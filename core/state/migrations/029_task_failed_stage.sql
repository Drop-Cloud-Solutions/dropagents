-- Which step a task failed at ('dev' | 'review' | 'test' | 'commit', or a
-- raw step id for non-standard flows). The AP-PAO-009 card matrix derives
-- its failed:<stage> tag — and therefore the Retry/Restart action row —
-- from this field; v1 carried it in meta, v2 never persisted it, so a
-- failed task rendered with NO actions after a reload (field case:
-- L-IAED-002, tester output failure). NULL = not failed / stage unknown.
ALTER TABLE tasks ADD COLUMN failed_stage TEXT;
