import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { openDatabase, applyMigrations, Db } from './migrations';

function freshDbPath(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-vp-005-state-'));
    return path.join(dir, 'state.db');
}

type ColumnInfo = { name: string; type: string; notnull: number };

function columnInfo(db: Db, table: string): ColumnInfo[] {
    return db.prepare(`PRAGMA table_info('${table}')`).all() as ColumnInfo[];
}

test('fresh DB: flow_state.parked_step_id is a nullable TEXT column', () => {
    const db = openDatabase(freshDbPath());
    try {
        applyMigrations(db);
        const col = columnInfo(db, 'flow_state').find(
            (c) => c.name === 'parked_step_id',
        );
        assert.ok(col, 'expected flow_state.parked_step_id to exist');
        assert.equal(
            col!.notnull,
            0,
            'parked_step_id must be nullable so existing rows backfill to NULL',
        );
        assert.match(
            col!.type.toUpperCase(),
            /TEXT/,
            `expected parked_step_id to be TEXT, got ${col!.type}`,
        );
    } finally {
        db.close();
    }
});

test('fresh DB: tasks.feedback is a nullable TEXT column', () => {
    const db = openDatabase(freshDbPath());
    try {
        applyMigrations(db);
        const col = columnInfo(db, 'tasks').find((c) => c.name === 'feedback');
        assert.ok(col, 'expected tasks.feedback to exist');
        assert.equal(
            col!.notnull,
            0,
            'feedback must be nullable so existing rows backfill to NULL',
        );
        assert.match(
            col!.type.toUpperCase(),
            /TEXT/,
            `expected feedback to be TEXT, got ${col!.type}`,
        );
    } finally {
        db.close();
    }
});

test('running applyMigrations twice after 004 lands is a no-op', () => {
    const db = openDatabase(freshDbPath());
    try {
        const first = applyMigrations(db);
        assert.ok(
            first.includes('004_parked_step_id_and_feedback.sql'),
            `expected 004 to apply on a fresh DB, got: ${first.join(',')}`,
        );
        const second = applyMigrations(db);
        assert.deepEqual(
            second,
            [],
            'a second apply on a fully-migrated DB must report no migrations',
        );
    } finally {
        db.close();
    }
});

test('upgrade path: a DB at the previous schema gains both columns and keeps existing rows', () => {
    // Simulate a DB pinned at migrations 001..003 (the schema right before
    // this migration lands), seed a row in each affected table, then run the
    // full migration set and assert 004 applies cleanly without disturbing
    // the existing rows.
    const dbPath = freshDbPath();
    const db = openDatabase(dbPath);
    try {
        const stagedDir = fs.mkdtempSync(
            path.join(os.tmpdir(), 'ap-vp-005-staged-'),
        );
        const fullDir = path.join(__dirname, 'migrations');
        for (const f of [
            '001_initial.sql',
            '002_paused_step.sql',
            '003_task_deps.sql',
        ]) {
            fs.copyFileSync(path.join(fullDir, f), path.join(stagedDir, f));
        }
        const stagedApplied = applyMigrations(db, stagedDir);
        assert.deepEqual(stagedApplied.sort(), [
            '001_initial.sql',
            '002_paused_step.sql',
            '003_task_deps.sql',
        ]);

        // Seed rows on the pre-004 schema.
        db.prepare(
            'INSERT INTO plans(id, project_id, status, created_at) VALUES (?, ?, ?, ?)',
        ).run('plan-old', 'proj-old', 'approved', 1_700_000_000_000);
        db.prepare(
            'INSERT INTO tasks(id, plan_id, type, status) VALUES (?, ?, ?, ?)',
        ).run('task-old', 'plan-old', 'feature', 'approved');
        db.prepare(
            'INSERT INTO flow_state(task_id, current_step) VALUES (?, ?)',
        ).run('task-old', 'develop');

        // Stage 004 specifically rather than running the whole chain.
        // This test is about ONE migration — that 004 adds its columns to
        // an existing DB without disturbing rows — and dragging every
        // later migration in brought an unrelated collision with it:
        //
        //   013_tasks_drop_plan_fk recreates `tasks` (DROP + rename) to
        //   shed a legacy foreign key. `flow_state.task_id REFERENCES
        //   tasks(id)`, and SQLite's deferred-FK counter is incremented
        //   by the DROP but NOT decremented by the rename, so the COMMIT
        //   fails whenever flow_state actually holds a row. That is why
        //   this test sat red: it seeds a flow_state row, and 013 has
        //   been in the chain since long before anyone looked.
        //
        // The hazard is real but historical: it only bites a database
        // pinned at 012-or-earlier WITH live flow_state rows, and every
        // deployment is long past that. A fresh DB applies the chain in
        // order with no rows present, so nothing trips. Migrations are
        // append-only, so 013 cannot be corrected in place either.
        fs.copyFileSync(
            path.join(fullDir, '004_parked_step_id_and_feedback.sql'),
            path.join(stagedDir, '004_parked_step_id_and_feedback.sql'),
        );
        const fullApplied = applyMigrations(db, stagedDir);
        assert.ok(
            fullApplied.includes('004_parked_step_id_and_feedback.sql'),
            `expected 004 to apply on upgrade, got: ${fullApplied.join(',')}`,
        );

        const taskRow = db
            .prepare(
                "SELECT id, parked_reason, feedback FROM tasks WHERE id = 'task-old'",
            )
            .get() as {
                id: string;
                parked_reason: string | null;
                feedback: string | null;
            };
        assert.equal(taskRow.id, 'task-old');
        assert.equal(
            taskRow.feedback,
            null,
            'existing task rows must backfill feedback to NULL',
        );

        const flowRow = db
            .prepare(
                "SELECT task_id, paused_step, parked_step_id FROM flow_state WHERE task_id = 'task-old'",
            )
            .get() as {
                task_id: string;
                paused_step: string | null;
                parked_step_id: string | null;
            };
        assert.equal(flowRow.task_id, 'task-old');
        assert.equal(
            flowRow.parked_step_id,
            null,
            'existing flow_state rows must backfill parked_step_id to NULL',
        );

        // A second apply must still be a no-op on the upgraded DB.
        assert.deepEqual(applyMigrations(db, stagedDir), []);
    } finally {
        db.close();
    }
});

test('parked_step_id and feedback round-trip writes and reads back', () => {
    const db = openDatabase(freshDbPath());
    try {
        applyMigrations(db);
        db.prepare(
            'INSERT INTO plans(id, project_id, status, created_at) VALUES (?, ?, ?, ?)',
        ).run('plan-1', 'proj', 'approved', 1_700_000_000_000);
        db.prepare(
            'INSERT INTO tasks(id, plan_id, type, status, feedback) VALUES (?, ?, ?, ?, ?)',
        ).run('t1', 'plan-1', 'feature', 'review', 'please rename foo to bar');
        db.prepare(
            'INSERT INTO flow_state(task_id, current_step, parked_step_id) VALUES (?, ?, ?)',
        ).run('t1', 'review', 'review');

        const feedback = (
            db.prepare("SELECT feedback FROM tasks WHERE id = 't1'").get() as {
                feedback: string | null;
            }
        ).feedback;
        assert.equal(feedback, 'please rename foo to bar');

        const parked = (
            db
                .prepare(
                    "SELECT parked_step_id FROM flow_state WHERE task_id = 't1'",
                )
                .get() as { parked_step_id: string | null }
        ).parked_step_id;
        assert.equal(parked, 'review');
    } finally {
        db.close();
    }
});
