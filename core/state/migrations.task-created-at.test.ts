/**
 * Migration 036 — `tasks.created_at`, backfilled from the event log.
 *
 * The operator asked to see when a plan or task was created. Plans
 * already had it (`plans.created_at`, folded from `PlanCreated` since
 * 001); tasks never did.
 *
 * The property worth pinning is that historical rows get their REAL
 * creation date, not the time of the upgrade. Stamping `now` on every
 * existing task would have been a one-line migration and would have told
 * the operator that a task from two months ago was created today — on a
 * screen whose whole purpose is judging how long work has been sitting.
 * The event log already had the answer.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { applyMigrations, openDatabase, type Db } from './migrations';

const JULY = Date.UTC(2026, 6, 4, 9, 0, 0);
const AUGUST = Date.UTC(2026, 7, 20, 14, 30, 0);

function seedPlan(db: Db, planId: string): void {
    db.prepare(
        `INSERT OR IGNORE INTO plans(id, project_id, status, created_at)
         VALUES (?, 'proj', 'created', ?)`,
    ).run(planId, JULY);
}

function seedTaskCreatedEvent(
    db: Db,
    args: { seq: number; taskId: string; at: number },
): void {
    db.prepare(
        `INSERT INTO events(seq, type, v, idempotency_key, payload, occurred_at)
         VALUES (@seq, 'TaskCreated', 1, @key, @payload, @at)`,
    ).run({
        seq: args.seq,
        key: `TaskCreated:plan-1:${args.taskId}:${args.seq}`,
        payload: JSON.stringify({ taskId: args.taskId, planId: 'plan-1' }),
        at: args.at,
    });
}

function seedTaskRow(db: Db, taskId: string): void {
    db.prepare(
        `INSERT INTO tasks(id, plan_id, type, status, flow_id)
         VALUES (?, 'plan-1', 'implement', 'done', 'implement')`,
    ).run(taskId);
}

function createdAt(db: Db, taskId: string): number | null {
    const row = db
        .prepare('SELECT created_at FROM tasks WHERE id = ?')
        .get(taskId) as { created_at: number | null } | undefined;
    return row?.created_at ?? null;
}

/**
 * Build a pre-036 database, then migrate. Migrations run in one pass at
 * boot, so the only way to test the backfill is to seed the rows the
 * migration will find — done here by applying everything, then using the
 * already-migrated schema to write the historical rows and re-running
 * the UPDATE the migration performs.
 */
function freshDb(): Db {
    const db = openDatabase(':memory:');
    applyMigrations(db);
    return db;
}

/** The backfill statement from 036, replayed against seeded history. */
function runBackfill(db: Db): void {
    db.exec(`
        UPDATE tasks
           SET created_at = (
               SELECT MIN(e.occurred_at)
                 FROM events e
                WHERE e.type = 'TaskCreated'
                  AND json_valid(e.payload)
                  AND json_extract(e.payload, '$.taskId') = tasks.id
           )
         WHERE created_at IS NULL;
    `);
}

test('the column exists after migrating', () => {
    const db = freshDb();
    try {
        const cols = (
            db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]
        ).map((c) => c.name);
        assert.ok(cols.includes('created_at'), `tasks columns: ${cols.join(', ')}`);
    } finally {
        db.close();
    }
});

test('a historical task gets its REAL date from the event log', () => {
    const db = freshDb();
    try {
        seedPlan(db, 'plan-1');
        seedTaskRow(db, 'T-1');
        seedTaskCreatedEvent(db, { seq: 1, taskId: 'T-1', at: JULY });
        runBackfill(db);

        assert.equal(createdAt(db, 'T-1'), JULY, 'not the migration time');
    } finally {
        db.close();
    }
});

test('a re-decomposed task keeps its FIRST creation date', () => {
    // A re-decompose emits a second TaskCreated for the same id. The
    // operator wants to know how long this work has been around, not
    // when it was last regenerated — hence MIN, not MAX.
    const db = freshDb();
    try {
        seedPlan(db, 'plan-1');
        seedTaskRow(db, 'T-1');
        seedTaskCreatedEvent(db, { seq: 1, taskId: 'T-1', at: JULY });
        seedTaskCreatedEvent(db, { seq: 2, taskId: 'T-1', at: AUGUST });
        runBackfill(db);

        assert.equal(createdAt(db, 'T-1'), JULY);
    } finally {
        db.close();
    }
});

test('a task whose creation event is gone stays NULL, not invented', () => {
    // Telemetry pruning and hand-built rows both produce this. An absent
    // date renders as no line; a fabricated one is a lie on a screen
    // people use to judge how stale something is.
    const db = freshDb();
    try {
        seedPlan(db, 'plan-1');
        seedTaskRow(db, 'T-orphan');
        runBackfill(db);

        assert.equal(createdAt(db, 'T-orphan'), null);
    } finally {
        db.close();
    }
});

test('one task does not pick up another task\'s event', () => {
    const db = freshDb();
    try {
        seedPlan(db, 'plan-1');
        seedTaskRow(db, 'T-1');
        seedTaskRow(db, 'T-2');
        seedTaskCreatedEvent(db, { seq: 1, taskId: 'T-1', at: JULY });
        seedTaskCreatedEvent(db, { seq: 2, taskId: 'T-2', at: AUGUST });
        runBackfill(db);

        assert.equal(createdAt(db, 'T-1'), JULY);
        assert.equal(createdAt(db, 'T-2'), AUGUST);
    } finally {
        db.close();
    }
});

test('a poisoned payload does not abort the backfill', () => {
    // The events table is append-only and long-lived; one unparseable
    // row must not cost every other task its date.
    const db = freshDb();
    try {
        seedPlan(db, 'plan-1');
        seedTaskRow(db, 'T-1');
        db.prepare(
            `INSERT INTO events(seq, type, v, idempotency_key, payload, occurred_at)
             VALUES (99, 'TaskCreated', 1, 'poison', 'not json at all', 1)`,
        ).run();
        seedTaskCreatedEvent(db, { seq: 1, taskId: 'T-1', at: JULY });

        assert.doesNotThrow(() => runBackfill(db));
        assert.equal(createdAt(db, 'T-1'), JULY);
    } finally {
        db.close();
    }
});

test('plans already carry a creation date — nothing to add there', () => {
    // Pinned so the asymmetry is deliberate rather than an oversight:
    // `plans.created_at` has existed since 001 and the PlanCreated
    // subscriber folds `occurredAt` into it.
    const db = freshDb();
    try {
        const cols = (
            db.prepare('PRAGMA table_info(plans)').all() as { name: string }[]
        ).map((c) => c.name);
        assert.ok(cols.includes('created_at'));
    } finally {
        db.close();
    }
});
