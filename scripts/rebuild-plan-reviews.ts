/**
 * Rebuild the `plan_review_drafts` projection from the event log.
 *
 * Recovery for plans whose revisions were destroyed by the archive
 * cascade: `PlanArchived` used to run
 * `DELETE FROM plan_review_drafts WHERE plan_id = ?` so an archived plan
 * would stop appearing in `listPending()`. Archiving is reversible and
 * that delete was not, so unarchiving gave back a plan the board called
 * ready with no revision behind it — Regenerate answered 404, and after a
 * reload the plan fell back to Draft with the operator's only way out
 * being to run the planner again.
 *
 * Nothing was actually lost. `plan_review_drafts` is a PROJECTION; the
 * `PlanGenerated` events that built it are still in the log, because
 * nothing deletes events. So the fix for the damage is to fold them
 * again.
 *
 * Run it against a stopped worker (or accept that a concurrently running
 * one may fold the same events — the UPSERT is idempotent either way).
 *
 *   npx tsx scripts/rebuild-plan-reviews.ts [--db <path>] [--dry-run]
 *
 * Only re-folds `PlanGenerated`. It never deletes, so a plan whose draft
 * is intact keeps it; a plan whose draft is missing gets it back at the
 * revision and content the planner actually produced.
 */
import { openDatabase, type Db } from '../core/state/migrations';
import { getStateDbPath } from '../config/env';
import { PlanReviewStore } from '../adapters/projections/plan-review-store';
import type { Event } from '../core/events/event';

interface EventRow {
    readonly seq: number;
    readonly type: string;
    readonly v: number;
    readonly occurred_at: number;
    readonly idempotency_key: string;
    readonly payload: string;
}

function parseArgs(argv: readonly string[]): { dbPath?: string; dryRun: boolean } {
    let dbPath: string | undefined;
    let dryRun = false;
    for (let i = 0; i < argv.length; i += 1) {
        if (argv[i] === '--db' && argv[i + 1] !== undefined) {
            dbPath = argv[i + 1];
            i += 1;
        } else if (argv[i] === '--dry-run') {
            dryRun = true;
        }
    }
    return { ...(dbPath !== undefined ? { dbPath } : {}), dryRun };
}

/**
 * Plans that have a content-carrying `PlanGenerated` in the log but no
 * surviving draft row — i.e. exactly the ones the archive cascade ate.
 */
export function findMissingDrafts(db: Db): Array<{ planId: string; revisions: number }> {
    const rows = db
        .prepare(
            `SELECT json_extract(e.payload, '$.planId') AS plan_id,
                    COUNT(*)                            AS revisions
               FROM events e
              WHERE e.type = 'PlanGenerated'
                AND json_extract(e.payload, '$.planId') IS NOT NULL
                AND COALESCE(json_extract(e.payload, '$.content'), '') <> ''
                AND NOT EXISTS (
                    SELECT 1 FROM plan_review_drafts d
                     WHERE d.plan_id = json_extract(e.payload, '$.planId')
                       AND d.content <> ''
                )
              GROUP BY plan_id
              ORDER BY plan_id`,
        )
        .all() as Array<{ plan_id: string; revisions: number }>;
    return rows.map((r) => ({ planId: r.plan_id, revisions: r.revisions }));
}

function main(): void {
    const { dbPath, dryRun } = parseArgs(process.argv.slice(2));
    const resolved = dbPath ?? getStateDbPath();
    const db = openDatabase(resolved);
    try {
        console.log(`state db: ${resolved}`);
        const missing = findMissingDrafts(db);
        if (missing.length === 0) {
            console.log('every plan with a PlanGenerated already has its draft — nothing to do.');
            return;
        }
        console.log(`plans missing their draft: ${missing.length}`);
        for (const m of missing) {
            console.log(`  ${m.planId}  (${m.revisions} revision(s) in the log)`);
        }
        if (dryRun) {
            console.log('\n--dry-run: nothing written.');
            return;
        }

        // Fold every PlanGenerated back through the real projection, in
        // seq order. Using the store rather than hand-written SQL keeps
        // the revision/generated_at guards identical to the live path.
        const store = new PlanReviewStore(db);
        const rows = db
            .prepare(
                `SELECT seq, type, v, occurred_at, idempotency_key, payload
                   FROM events
                  WHERE type = 'PlanGenerated'
                  ORDER BY seq ASC`,
            )
            .all() as EventRow[];
        let folded = 0;
        for (const row of rows) {
            let payload: unknown;
            try {
                payload = JSON.parse(row.payload);
            } catch {
                continue;
            }
            const event = {
                type: row.type,
                v: row.v,
                occurredAt: row.occurred_at,
                idempotencyKey: row.idempotency_key,
                payload,
                seq: row.seq,
            } as unknown as Event;
            if (store.fold(event) !== null) folded += 1;
        }
        console.log(`\nfolded ${folded} PlanGenerated event(s) of ${rows.length} in the log.`);
        const still = findMissingDrafts(db);
        console.log(
            still.length === 0
                ? 'all drafts restored.'
                : `${still.length} plan(s) still missing — their PlanGenerated carried no content.`,
        );
    } finally {
        db.close();
    }
}

if (require.main === module) main();
