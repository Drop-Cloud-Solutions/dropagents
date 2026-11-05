import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
    openSqliteStore,
    applyStorageMigrations,
    ProjectScopedStore,
    MissingProjectIdError,
    type Db,
} from './sqlite';
import type { Event } from '../../core/events/event';

const DEFAULT_PID = 'project-default';

function freshDb(defaultProjectId: string = DEFAULT_PID): Db {
    return openSqliteStore(':memory:', { defaultProjectId });
}

function freshFileDb(defaultProjectId: string = DEFAULT_PID): { db: Db; dbPath: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-ifw-013-storage-'));
    const dbPath = path.join(dir, 'state.db');
    return { db: openSqliteStore(dbPath, { defaultProjectId }), dbPath };
}

function makeEvent(overrides: Partial<Event> = {}): Event {
    return {
        type: 'test.event',
        v: 1,
        occurredAt: 1_700_000_000_000,
        idempotencyKey: `key-${Math.random().toString(36).slice(2)}`,
        payload: { hello: 'world' },
        ...overrides,
    };
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

function columnNames(db: Db, table: string): string[] {
    return (
        db.prepare(`PRAGMA table_info(${table})`).all() as {
            name: string;
            notnull: number;
        }[]
    ).map((r) => r.name);
}

function columnIsNotNull(db: Db, table: string, column: string): boolean {
    const row = (
        db.prepare(`PRAGMA table_info(${table})`).all() as {
            name: string;
            notnull: number;
        }[]
    ).find((c) => c.name === column);
    return row !== undefined && row.notnull === 1;
}

// ---------------------------------------------------------------------------
// Migration shape (AC #4, #5)
// ---------------------------------------------------------------------------

test('migrations bootstrap event_log, subscriber_offsets, claims', () => {
    const db = freshDb();
    try {
        const tables = listTables(db);
        for (const t of ['event_log', 'subscriber_offsets', 'claims']) {
            assert.ok(tables.includes(t), `expected table "${t}" — got: ${tables.join(', ')}`);
        }
    } finally {
        db.close();
    }
});

test('migration 0002 adds project_id NOT NULL to event_log, subscriber_offsets, claims', () => {
    const db = freshDb();
    try {
        for (const t of ['event_log', 'subscriber_offsets', 'claims']) {
            const cols = columnNames(db, t);
            assert.ok(cols.includes('project_id'), `${t}.project_id missing`);
            assert.equal(
                columnIsNotNull(db, t, 'project_id'),
                true,
                `${t}.project_id must be NOT NULL`,
            );
        }
    } finally {
        db.close();
    }
});

test('applyStorageMigrations is idempotent', () => {
    const { db } = freshFileDb();
    try {
        const second = applyStorageMigrations(db, { defaultProjectId: DEFAULT_PID });
        assert.deepEqual(second, [], 'second apply must report zero migrations');
    } finally {
        db.close();
    }
});

test('migration 0002 backfills pre-existing rows with DEFAULT_PROJECT_ID', () => {
    // Apply only migration 0001 first, insert some legacy rows, then apply 0002.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-ifw-013-backfill-'));
    const migrationsDir = path.join(dir, 'migrations');
    fs.mkdirSync(migrationsDir);

    const repoMigrations = path.resolve(__dirname, 'migrations');
    fs.copyFileSync(
        path.join(repoMigrations, '0001-init.sql'),
        path.join(migrationsDir, '0001-init.sql'),
    );

    const dbPath = path.join(dir, 'state.db');
    const db = openSqliteStore(dbPath, { migrationsDir, defaultProjectId: DEFAULT_PID });
    try {
        db.prepare(
            `INSERT INTO event_log(type, v, occurred_at, idempotency_key, payload)
             VALUES (?, ?, ?, ?, ?)`,
        ).run('legacy.event', 1, 123, 'legacy-key-1', '{}');
        db.prepare(
            `INSERT INTO subscriber_offsets(subscriber, last_seq) VALUES (?, ?)`,
        ).run('legacy-subscriber', 42);
        db.prepare(
            `INSERT INTO claims(subject, owner, created_at) VALUES (?, ?, ?)`,
        ).run('legacy-subject', 'v2', 999);

        fs.copyFileSync(
            path.join(repoMigrations, '0002-project-id.sql'),
            path.join(migrationsDir, '0002-project-id.sql'),
        );
        const applied = applyStorageMigrations(db, {
            migrationsDir,
            defaultProjectId: 'backfill-target',
        });
        assert.deepEqual(applied, ['0002-project-id.sql']);

        const ev = db
            .prepare('SELECT project_id FROM event_log WHERE idempotency_key = ?')
            .get('legacy-key-1') as { project_id: string };
        assert.equal(ev.project_id, 'backfill-target');

        const off = db
            .prepare('SELECT project_id, last_seq FROM subscriber_offsets WHERE subscriber = ?')
            .get('legacy-subscriber') as { project_id: string; last_seq: number };
        assert.equal(off.project_id, 'backfill-target');
        assert.equal(off.last_seq, 42);

        const cl = db
            .prepare('SELECT project_id, owner FROM claims WHERE subject = ?')
            .get('legacy-subject') as { project_id: string; owner: string };
        assert.equal(cl.project_id, 'backfill-target');
        assert.equal(cl.owner, 'v2');
    } finally {
        db.close();
    }
});

test('migration runner fails when DEFAULT_PROJECT_ID is missing and 0002 is unapplied', () => {
    const prior = process.env.DEFAULT_PROJECT_ID;
    delete process.env.DEFAULT_PROJECT_ID;
    try {
        assert.throws(
            () => openSqliteStore(':memory:'),
            /DEFAULT_PROJECT_ID/,
        );
    } finally {
        if (prior !== undefined) process.env.DEFAULT_PROJECT_ID = prior;
    }
});

test('migration runner reads DEFAULT_PROJECT_ID from env when no explicit option is supplied', () => {
    const prior = process.env.DEFAULT_PROJECT_ID;
    process.env.DEFAULT_PROJECT_ID = 'env-supplied';
    try {
        const db = openSqliteStore(':memory:');
        try {
            const store = new ProjectScopedStore(db);
            // A direct INSERT without project_id should pick up the column DEFAULT.
            db.prepare(
                `INSERT INTO event_log(type, v, occurred_at, idempotency_key, payload)
                 VALUES (?, ?, ?, ?, ?)`,
            ).run('legacy.event', 1, 1, 'env-default-1', '{}');
            const row = db
                .prepare('SELECT project_id FROM event_log WHERE idempotency_key = ?')
                .get('env-default-1') as { project_id: string };
            assert.equal(row.project_id, 'env-supplied');
            // The store API still works normally.
            store.appendEvent('explicit-project', makeEvent({ idempotencyKey: 'explicit-1' }));
        } finally {
            db.close();
        }
    } finally {
        if (prior === undefined) delete process.env.DEFAULT_PROJECT_ID;
        else process.env.DEFAULT_PROJECT_ID = prior;
    }
});

// ---------------------------------------------------------------------------
// Store API (AC #6)
// ---------------------------------------------------------------------------

test('appendEvent rejects calls without a projectId', () => {
    const db = freshDb();
    try {
        const store = new ProjectScopedStore(db);
        assert.throws(
            () => store.appendEvent('', makeEvent()),
            (err: unknown) => err instanceof MissingProjectIdError,
        );
        assert.throws(
            () => store.appendEvent('   ', makeEvent()),
            (err: unknown) => err instanceof MissingProjectIdError,
        );
        // @ts-expect-error — runtime guard for non-string callers
        assert.throws(() => store.appendEvent(undefined, makeEvent()), MissingProjectIdError);
    } finally {
        db.close();
    }
});

test('readAfter, getSubscriberOffset, advanceSubscriberOffset, putClaim, readClaim, removeClaim all require projectId', () => {
    const db = freshDb();
    try {
        const store = new ProjectScopedStore(db);
        assert.throws(() => store.readAfter('', 0, 10), MissingProjectIdError);
        assert.throws(() => store.getSubscriberOffset('', 'sub'), MissingProjectIdError);
        assert.throws(() => store.advanceSubscriberOffset('', 'sub', 1), MissingProjectIdError);
        assert.throws(() => store.putClaim('', 'subj', 'v2', 1), MissingProjectIdError);
        assert.throws(() => store.readClaim('', 'subj'), MissingProjectIdError);
        assert.throws(() => store.removeClaim('', 'subj'), MissingProjectIdError);
    } finally {
        db.close();
    }
});

test('appendEvent returns positive seq and stores project_id on the row', () => {
    const db = freshDb();
    try {
        const store = new ProjectScopedStore(db);
        const seq = store.appendEvent('proj-a', makeEvent({ idempotencyKey: 'p-a-1' }));
        assert.ok(seq > 0);
        const row = db
            .prepare('SELECT project_id, type FROM event_log WHERE idempotency_key = ?')
            .get('p-a-1') as { project_id: string; type: string };
        assert.equal(row.project_id, 'proj-a');
    } finally {
        db.close();
    }
});

test('duplicate idempotencyKey within a project returns the original seq', () => {
    const db = freshDb();
    try {
        const store = new ProjectScopedStore(db);
        const first = store.appendEvent('proj-a', makeEvent({ idempotencyKey: 'dup' }));
        const second = store.appendEvent('proj-a', makeEvent({ idempotencyKey: 'dup' }));
        assert.equal(first, second);
    } finally {
        db.close();
    }
});

test('reusing the same idempotencyKey across projects fails loudly', () => {
    const db = freshDb();
    try {
        const store = new ProjectScopedStore(db);
        store.appendEvent('proj-a', makeEvent({ idempotencyKey: 'shared-key' }));
        assert.throws(
            () => store.appendEvent('proj-b', makeEvent({ idempotencyKey: 'shared-key' })),
            /already used by project "proj-a"/,
        );
    } finally {
        db.close();
    }
});

test('subscriber offsets are independent per (projectId, subscriber)', () => {
    const db = freshDb();
    try {
        const store = new ProjectScopedStore(db);
        store.advanceSubscriberOffset('proj-a', 'sub-x', 10);
        store.advanceSubscriberOffset('proj-b', 'sub-x', 99);
        assert.equal(store.getSubscriberOffset('proj-a', 'sub-x'), 10);
        assert.equal(store.getSubscriberOffset('proj-b', 'sub-x'), 99);
        // Unknown project: 0, never sees other projects' offset.
        assert.equal(store.getSubscriberOffset('proj-c', 'sub-x'), 0);

        // Monotonic per pair.
        assert.equal(store.advanceSubscriberOffset('proj-a', 'sub-x', 5), false);
        assert.equal(store.getSubscriberOffset('proj-a', 'sub-x'), 10);
        assert.equal(store.advanceSubscriberOffset('proj-a', 'sub-x', 20), true);
        assert.equal(store.getSubscriberOffset('proj-a', 'sub-x'), 20);
    } finally {
        db.close();
    }
});

test('claims are scoped per project — same subject in two projects does not collide', () => {
    const db = freshDb();
    try {
        const store = new ProjectScopedStore(db);
        assert.equal(store.putClaim('proj-a', 'subject-1', 'v2', 1), true);
        assert.equal(store.putClaim('proj-b', 'subject-1', 'v1', 1), true);

        assert.equal(store.readClaim('proj-a', 'subject-1'), 'v2');
        assert.equal(store.readClaim('proj-b', 'subject-1'), 'v1');

        // Re-claim inside the same project returns false (existing wins).
        assert.equal(store.putClaim('proj-a', 'subject-1', 'v1', 2), false);
        assert.equal(store.readClaim('proj-a', 'subject-1'), 'v2');

        // Remove is scoped.
        assert.equal(store.removeClaim('proj-a', 'subject-1'), true);
        assert.equal(store.readClaim('proj-a', 'subject-1'), undefined);
        assert.equal(
            store.readClaim('proj-b', 'subject-1'),
            'v1',
            'removing proj-a claim must NOT touch proj-b',
        );
    } finally {
        db.close();
    }
});

// ---------------------------------------------------------------------------
// Concurrent two-project test (AC #7)
// ---------------------------------------------------------------------------

test('two projects writing concurrently never see each other\'s rows', async () => {
    const db = freshDb();
    try {
        const store = new ProjectScopedStore(db);
        const PROJECTS = ['alpha', 'beta'] as const;
        const PER_PROJECT = 50;

        // Interleave appends from both projects via Promise.all. better-sqlite3
        // is synchronous internally, but each callback is queued through the
        // microtask system here so the order alternates non-deterministically
        // from JS's perspective — a fair stand-in for two host loops sharing
        // a DB handle.
        const ops: Promise<{ project: string; seq: number }>[] = [];
        for (let i = 0; i < PER_PROJECT; i++) {
            for (const project of PROJECTS) {
                ops.push(
                    Promise.resolve().then(() => {
                        const seq = store.appendEvent(project, {
                            type: 'work',
                            v: 1,
                            occurredAt: 1_000_000 + i,
                            idempotencyKey: `${project}-${i}`,
                            payload: { project, i },
                        });
                        store.advanceSubscriberOffset(project, 'worker', seq);
                        store.putClaim(project, `task-${i}`, project, i);
                        return { project, seq };
                    }),
                );
            }
        }
        const results = await Promise.all(ops);
        assert.equal(results.length, PROJECTS.length * PER_PROJECT);

        for (const project of PROJECTS) {
            const events = store.readAfter(project, 0, PER_PROJECT * 4);
            assert.equal(
                events.length,
                PER_PROJECT,
                `${project} must see exactly its own ${PER_PROJECT} events`,
            );
            for (const ev of events) {
                const p = (ev.payload as { project: string }).project;
                assert.equal(
                    p,
                    project,
                    `event seq=${ev.seq} leaked from project "${p}" into reads scoped to "${project}"`,
                );
            }

            // Subscriber offsets: must equal the last seq for this project alone,
            // never the global max across both projects.
            const lastForProject = events[events.length - 1].seq;
            assert.equal(
                store.getSubscriberOffset(project, 'worker'),
                lastForProject,
                `offset for ${project} must track its own last seq, not the global max`,
            );

            // Claims: all PER_PROJECT subjects exist and belong to this project.
            for (let i = 0; i < PER_PROJECT; i++) {
                assert.equal(store.readClaim(project, `task-${i}`), project);
            }
        }

        // Global table counts: 2 * PER_PROJECT rows, split evenly.
        const totals = db
            .prepare(
                'SELECT project_id, COUNT(*) AS n FROM event_log GROUP BY project_id ORDER BY project_id',
            )
            .all() as { project_id: string; n: number }[];
        assert.deepEqual(
            totals,
            [
                { project_id: 'alpha', n: PER_PROJECT },
                { project_id: 'beta', n: PER_PROJECT },
            ],
            'each project must own exactly PER_PROJECT rows in event_log',
        );

        const claimTotals = db
            .prepare(
                'SELECT project_id, COUNT(*) AS n FROM claims GROUP BY project_id ORDER BY project_id',
            )
            .all() as { project_id: string; n: number }[];
        assert.deepEqual(claimTotals, [
            { project_id: 'alpha', n: PER_PROJECT },
            { project_id: 'beta', n: PER_PROJECT },
        ]);
    } finally {
        db.close();
    }
});

test('a NULL or empty project_id direct insert is rejected by the schema constraint', () => {
    const db = freshDb();
    try {
        // The DEFAULT clause means omitting project_id picks up the backfill
        // value rather than triggering NOT NULL — but explicitly passing NULL
        // must still fail. That's the schema's last line of defence.
        assert.throws(
            () =>
                db
                    .prepare(
                        `INSERT INTO event_log(project_id, type, v, occurred_at, idempotency_key, payload)
                         VALUES (NULL, ?, ?, ?, ?, ?)`,
                    )
                    .run('x', 1, 1, 'null-pid-key', '{}'),
            /NOT NULL/i,
        );
    } finally {
        db.close();
    }
});
