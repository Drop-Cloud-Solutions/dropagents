/**
 * Recovery for the archive cascade: `PlanArchived` used to delete a
 * plan's `plan_review_drafts` rows, and unarchiving could not bring them
 * back — so the board showed the plan as Draft and the only way forward
 * was to run the planner again.
 *
 * Nothing was lost, though: drafts are a PROJECTION and the
 * `PlanGenerated` events that built them are still in the log. These pin
 * that the detection query finds exactly the damaged plans and no others.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { applyMigrations, openDatabase, type Db } from '../core/state/migrations';
import { PlanReviewStore } from '../adapters/projections/plan-review-store';
import { findMissingDrafts } from './rebuild-plan-reviews';

function makeDb(): Db {
    const db = openDatabase(':memory:');
    applyMigrations(db);
    return db;
}

let seq = 0;
function appendPlanGenerated(
    db: Db,
    planId: string,
    revision: number,
    content: string,
): void {
    seq += 1;
    db.prepare(
        `INSERT INTO events(type, v, occurred_at, idempotency_key, payload)
         VALUES ('PlanGenerated', 1, ?, ?, ?)`,
    ).run(
        1000 + seq,
        `gen:${planId}:${revision}:${seq}`,
        JSON.stringify({ planId, projectId: 'proj-A', revision, content }),
    );
}

test('a plan whose draft was deleted is detected as missing', () => {
    const db = makeDb();
    try {
        appendPlanGenerated(db, 'plan-1', 1, 'the plan body');
        // The archive cascade: the event stays, the projection row goes.
        assert.deepEqual(
            findMissingDrafts(db).map((m) => m.planId),
            ['plan-1'],
        );
    } finally {
        db.close();
    }
});

test('a plan whose draft survived is NOT reported', () => {
    // The script must be safe to run repeatedly — it is a repair, not a
    // rebuild-everything.
    const db = makeDb();
    try {
        appendPlanGenerated(db, 'plan-2', 1, 'the plan body');
        const store = new PlanReviewStore(db);
        store.fold({
            type: 'PlanGenerated',
            v: 1,
            occurredAt: 1001,
            idempotencyKey: 'x',
            payload: { planId: 'plan-2', projectId: 'proj-A', revision: 1, content: 'the plan body' },
        } as never);

        assert.deepEqual(findMissingDrafts(db), []);
    } finally {
        db.close();
    }
});

test('an EMPTY dispatch-time PlanGenerated is not mistaken for a lost draft', () => {
    // GeneratePlan mints a content-less revision at dispatch, before the
    // agent runs. Counting it would have the script report every plan
    // whose planner never finished as recoverable, and "restore" a blank
    // revision that flips the board to Ready.
    const db = makeDb();
    try {
        appendPlanGenerated(db, 'plan-3', 1, '');
        assert.deepEqual(findMissingDrafts(db), []);
    } finally {
        db.close();
    }
});

test('folding the log back restores the draft at its real revision', () => {
    // The end-to-end point: after the repair, getLatest returns what the
    // planner actually produced, so Regenerate has a revision to build on
    // and the board classifies the plan Ready again.
    const db = makeDb();
    try {
        appendPlanGenerated(db, 'plan-4', 1, 'first');
        appendPlanGenerated(db, 'plan-4', 2, 'second');
        assert.equal(findMissingDrafts(db).length, 1);

        const store = new PlanReviewStore(db);
        for (const row of db
            .prepare("SELECT * FROM events WHERE type = 'PlanGenerated' ORDER BY seq ASC")
            .all() as Array<Record<string, unknown>>) {
            store.fold({
                type: 'PlanGenerated',
                v: 1,
                occurredAt: Number(row.occurred_at),
                idempotencyKey: String(row.idempotency_key),
                payload: JSON.parse(String(row.payload)),
            } as never);
        }

        assert.deepEqual(findMissingDrafts(db), []);
        const latest = store.getLatest('plan-4');
        assert.equal(latest?.revision, 2);
        assert.equal(latest?.content, 'second');
    } finally {
        db.close();
    }
});
