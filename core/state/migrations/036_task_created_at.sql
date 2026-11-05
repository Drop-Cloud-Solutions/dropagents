-- 036_task_created_at — when a task was created, on the task row.
--
-- The operator asked to see a creation date on the plan and task modals.
-- For plans it was already there: `plans.created_at` has existed since
-- 001 and the `PlanCreated` subscriber has been folding `occurredAt`
-- into it all along. Tasks had nothing — the `tasks` table carried id,
-- plan, type, status and flow position, and every later migration added
-- content columns, never a timestamp.
--
-- The information was never lost, only unprojected: every task row comes
-- from a `TaskCreated` event and the event log keeps `occurred_at`. So
-- this backfills from the log rather than stamping "now" on historical
-- rows, which would have told the operator that a task from July was
-- created the day they upgraded.
--
-- Nullable on purpose. A task whose `TaskCreated` event has been pruned,
-- or one written by a path that never emitted one, gets NULL and the UI
-- omits the line. An invented date is worse than an absent one on a
-- screen people use to reason about how long work has been sitting.
ALTER TABLE tasks ADD COLUMN created_at INTEGER;

-- MIN(), not MAX(): a re-decomposition can emit a second `TaskCreated`
-- for the same id (the projection upserts on conflict), and the first
-- one is when the task actually came into existence.
--
-- `json_valid` first: `json_extract` RAISES on a malformed payload, and
-- a single poisoned row in an append-only log that has been running for
-- months would abort the migration and take the whole boot with it. One
-- bad event must cost that one task its date, nothing more. (Found by
-- the test, not by inspection — the naive version threw.)
UPDATE tasks
   SET created_at = (
       SELECT MIN(e.occurred_at)
         FROM events e
        WHERE e.type = 'TaskCreated'
          AND json_valid(e.payload)
          AND json_extract(e.payload, '$.taskId') = tasks.id
   )
 WHERE created_at IS NULL;
