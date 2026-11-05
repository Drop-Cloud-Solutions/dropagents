import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { openDatabase, applyMigrations, Db } from './migrations';

const EXPECTED_TABLES = [
    'plans',
    'tasks',
    'task_deps',
    'agent_runs',
    'events',
    'flow_state',
    'external_refs',
    'subscriber_offsets',
    '__migrations',
];

function freshDbPath(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-nvp-004-state-'));
    return path.join(dir, 'state.db');
}

function listTables(db: Db): string[] {
    return (
        db
            .prepare(
                "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
            )
            .all() as { name: string }[]
    ).map((r) => r.name);
}

test('fresh DB has all expected tables after applyMigrations', () => {
    const db = openDatabase(freshDbPath());
    try {
        applyMigrations(db);
        const tables = listTables(db);
        for (const expected of EXPECTED_TABLES) {
            assert.ok(
                tables.includes(expected),
                `expected table "${expected}" to exist after applyMigrations, got: ${tables.join(', ')}`,
            );
        }
    } finally {
        db.close();
    }
});

test('applying migrations twice is a no-op', () => {
    const dbPath = freshDbPath();
    const db = openDatabase(dbPath);
    try {
        const first = applyMigrations(db);
        const second = applyMigrations(db);

        assert.ok(
            first.length > 0,
            'first apply should report at least one migration',
        );
        assert.deepEqual(
            second,
            [],
            'second apply must report no migrations applied',
        );

        const ledgerCount = (
            db.prepare('SELECT COUNT(*) AS n FROM __migrations').get() as {
                n: number;
            }
        ).n;
        assert.equal(
            ledgerCount,
            first.length,
            'ledger row count must match first-call applied count',
        );
    } finally {
        db.close();
    }
});

test('openDatabase enables WAL journal mode', () => {
    const db = openDatabase(freshDbPath());
    try {
        applyMigrations(db);
        const mode = db.pragma('journal_mode', { simple: true }) as string;
        assert.equal(
            mode.toLowerCase(),
            'wal',
            `expected journal_mode=wal, got "${mode}"`,
        );
    } finally {
        db.close();
    }
});

test('openDatabase enables foreign_keys', () => {
    const db = openDatabase(freshDbPath());
    try {
        applyMigrations(db);
        const fk = db.pragma('foreign_keys', { simple: true });
        assert.equal(Number(fk), 1, 'foreign_keys pragma must be ON');
    } finally {
        db.close();
    }
});

test('events.idempotency_key UNIQUE rejects duplicate inserts', () => {
    const db = openDatabase(freshDbPath());
    try {
        applyMigrations(db);
        const insert = db.prepare(
            'INSERT INTO events(type, v, occurred_at, idempotency_key, payload) VALUES (?, ?, ?, ?, ?)',
        );
        insert.run('test.event', 1, Date.now(), 'dup-key-1', '{}');
        assert.throws(
            () => insert.run('test.event', 1, Date.now(), 'dup-key-1', '{}'),
            /UNIQUE/i,
            'second insert with same idempotency_key must throw a UNIQUE error',
        );
    } finally {
        db.close();
    }
});

test('tasks.parked_reason is a nullable text column added by 003_task_deps', () => {
    const db = openDatabase(freshDbPath());
    try {
        applyMigrations(db);
        const cols = db
            .prepare("PRAGMA table_info('tasks')")
            .all() as { name: string; type: string; notnull: number }[];
        const parked = cols.find((c) => c.name === 'parked_reason');
        assert.ok(parked, 'expected tasks.parked_reason column to exist');
        assert.equal(
            parked!.notnull,
            0,
            'parked_reason must be nullable so existing rows backfill to NULL',
        );
        assert.match(
            parked!.type.toUpperCase(),
            /TEXT/,
            `expected parked_reason to be TEXT, got ${parked!.type}`,
        );
    } finally {
        db.close();
    }
});

test('task_deps table has the expected columns and primary key', () => {
    const db = openDatabase(freshDbPath());
    try {
        applyMigrations(db);
        const cols = db
            .prepare("PRAGMA table_info('task_deps')")
            .all() as { name: string; notnull: number; pk: number }[];

        const names = cols.map((c) => c.name).sort();
        assert.deepEqual(
            names,
            ['depends_on_task_id', 'status', 'task_id'],
            `unexpected task_deps columns: ${names.join(',')}`,
        );

        const pkCols = cols
            .filter((c) => c.pk > 0)
            .sort((a, b) => a.pk - b.pk)
            .map((c) => c.name);
        assert.deepEqual(
            pkCols,
            ['task_id', 'depends_on_task_id'],
            `task_deps PK must be (task_id, depends_on_task_id), got: ${pkCols.join(',')}`,
        );

        const status = cols.find((c) => c.name === 'status')!;
        assert.equal(status.notnull, 1, 'status must be NOT NULL');
    } finally {
        db.close();
    }
});

test('task_deps.status defaults to pending and a duplicate edge is rejected', () => {
    const db = openDatabase(freshDbPath());
    try {
        applyMigrations(db);
        // Seed parent rows so the FK is satisfiable.
        db.prepare(
            'INSERT INTO plans(id, project_id, status, created_at) VALUES (?, ?, ?, ?)',
        ).run('plan-1', 'proj', 'approved', 1_700_000_000_000);
        db.prepare(
            'INSERT INTO tasks(id, plan_id, type, status) VALUES (?, ?, ?, ?)',
        ).run('a', 'plan-1', 'feature', 'approved');
        db.prepare(
            'INSERT INTO tasks(id, plan_id, type, status) VALUES (?, ?, ?, ?)',
        ).run('b', 'plan-1', 'feature', 'approved');

        db.prepare(
            'INSERT INTO task_deps(task_id, depends_on_task_id) VALUES (?, ?)',
        ).run('b', 'a');

        const status = (
            db.prepare(
                "SELECT status FROM task_deps WHERE task_id = 'b' AND depends_on_task_id = 'a'",
            ).get() as { status: string }
        ).status;
        assert.equal(status, 'pending', 'default status must be "pending"');

        assert.throws(
            () =>
                db
                    .prepare(
                        'INSERT INTO task_deps(task_id, depends_on_task_id) VALUES (?, ?)',
                    )
                    .run('b', 'a'),
            /UNIQUE|PRIMARY KEY/i,
            'duplicate (task_id, depends_on_task_id) must be rejected by the PK',
        );
    } finally {
        db.close();
    }
});

test('upgrading a database that pre-dates 003 keeps existing rows intact', () => {
    // Simulate a v2 DB that only has migrations 001+002 applied: copy just
    // those files into a temp dir, run migrations against it, seed data, then
    // run the full set and confirm 003 applies cleanly without disturbing the
    // pre-existing rows.
    const dbPath = freshDbPath();
    const db = openDatabase(dbPath);
    try {
        const stagedDir = fs.mkdtempSync(
            path.join(os.tmpdir(), 'ap-ifw-006-staged-'),
        );
        const fullDir = path.join(__dirname, 'migrations');
        for (const f of ['001_initial.sql', '002_paused_step.sql']) {
            fs.copyFileSync(path.join(fullDir, f), path.join(stagedDir, f));
        }
        const stagedApplied = applyMigrations(db, stagedDir);
        assert.deepEqual(stagedApplied.sort(), [
            '001_initial.sql',
            '002_paused_step.sql',
        ]);

        db.prepare(
            'INSERT INTO plans(id, project_id, status, created_at) VALUES (?, ?, ?, ?)',
        ).run('plan-old', 'proj-old', 'approved', 1_700_000_000_000);
        db.prepare(
            'INSERT INTO tasks(id, plan_id, type, status) VALUES (?, ?, ?, ?)',
        ).run('task-old', 'plan-old', 'feature', 'approved');

        const fullApplied = applyMigrations(db);
        assert.ok(
            fullApplied.includes('003_task_deps.sql'),
            `expected 003_task_deps.sql to apply on upgrade, got: ${fullApplied.join(',')}`,
        );

        const row = db
            .prepare(
                "SELECT id, parked_reason FROM tasks WHERE id = 'task-old'",
            )
            .get() as { id: string; parked_reason: string | null };
        assert.equal(row.id, 'task-old');
        assert.equal(
            row.parked_reason,
            null,
            'existing rows must backfill parked_reason to NULL',
        );
    } finally {
        db.close();
    }
});

test('external_refs.claim_owner has an index', () => {
    const db = openDatabase(freshDbPath());
    try {
        applyMigrations(db);
        const indexes = db
            .prepare("PRAGMA index_list('external_refs')")
            .all() as { name: string }[];
        const hasClaimOwnerIndex = indexes.some((ix) => {
            const cols = db.prepare(`PRAGMA index_info('${ix.name}')`).all() as {
                name: string;
            }[];
            return cols.some((c) => c.name === 'claim_owner');
        });
        assert.ok(
            hasClaimOwnerIndex,
            'expected an index covering external_refs.claim_owner',
        );
    } finally {
        db.close();
    }
});

// ---------------------------------------------------------------------------
// 025_agents_projection.sql
// ---------------------------------------------------------------------------

test('025_agents_projection.sql creates the agents table', () => {
    const db = openDatabase(freshDbPath());
    try {
        applyMigrations(db);
        const tables = listTables(db);
        assert.ok(
            tables.includes('agents'),
            `expected "agents" table after applyMigrations, got: ${tables.join(', ')}`,
        );
    } finally {
        db.close();
    }
});

test('agents table has the expected columns with correct constraints', () => {
    const db = openDatabase(freshDbPath());
    try {
        applyMigrations(db);
        const cols = db
            .prepare("PRAGMA table_info('agents')")
            .all() as { name: string; type: string; notnull: number; pk: number }[];

        const names = cols.map((c) => c.name).sort();
        assert.deepEqual(
            names,
            ['agent_id', 'deleted_at', 'model', 'name', 'prompt', 'provider', 'role', 'updated_at'],
            `unexpected agents columns: ${names.join(',')}`,
        );

        const agentId = cols.find((c) => c.name === 'agent_id')!;
        assert.equal(agentId.notnull, 1, 'agent_id must be NOT NULL');
        assert.equal(agentId.pk, 1, 'agent_id must be PRIMARY KEY');
        assert.match(agentId.type.toUpperCase(), /TEXT/, 'agent_id must be TEXT');

        const deletedAt = cols.find((c) => c.name === 'deleted_at')!;
        assert.equal(deletedAt.notnull, 0, 'deleted_at must be nullable (NULL while active)');
        assert.match(deletedAt.type.toUpperCase(), /INTEGER/, 'deleted_at must be INTEGER');

        const updatedAt = cols.find((c) => c.name === 'updated_at')!;
        assert.equal(updatedAt.notnull, 0, 'updated_at must be nullable');
        assert.match(updatedAt.type.toUpperCase(), /INTEGER/, 'updated_at must be INTEGER');
    } finally {
        db.close();
    }
});

test('idx_agents_active index covers agents.deleted_at', () => {
    const db = openDatabase(freshDbPath());
    try {
        applyMigrations(db);
        const indexes = db
            .prepare("PRAGMA index_list('agents')")
            .all() as { name: string }[];
        const hasActiveIndex = indexes.some((ix) => {
            const cols = db
                .prepare(`PRAGMA index_info('${ix.name}')`)
                .all() as { name: string }[];
            return cols.some((c) => c.name === 'deleted_at');
        });
        assert.ok(
            hasActiveIndex,
            'expected an index on agents(deleted_at) — idx_agents_active',
        );
    } finally {
        db.close();
    }
});

test('025_agents_projection.sql is idempotent (applying migrations twice leaves agents intact)', () => {
    const dbPath = freshDbPath();
    const db = openDatabase(dbPath);
    try {
        applyMigrations(db);
        // Seed a row before the second apply to confirm no destructive DDL.
        db.prepare(
            'INSERT INTO agents(agent_id, name, role, updated_at) VALUES (?, ?, ?, ?)',
        ).run('agent-1', 'Dev', 'developer', 1_700_000_000_000);

        applyMigrations(db); // second apply must be a no-op

        const row = db
            .prepare("SELECT agent_id, name FROM agents WHERE agent_id = 'agent-1'")
            .get() as { agent_id: string; name: string } | undefined;
        assert.ok(row, 'seeded row must survive second applyMigrations call');
        assert.equal(row!.name, 'Dev');
    } finally {
        db.close();
    }
});
