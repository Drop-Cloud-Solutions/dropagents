/**
 * Unit tests for the snapshot-job adapter. Each test runs against a
 * scratch on-disk SQLite database in `os.tmpdir()` and writes snapshots
 * to a sibling temp directory, so no test ever touches the real
 * `shared/.cache/snapshots/` tree.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import Database from 'better-sqlite3';

import type { EventBus } from '../../core/events/bus';
import type { Logger } from '../../core/ports/Logger';

import { register } from './snapshot-job';

function tempDir(prefix = 'snapshot-job-'): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

interface LogEntry {
    readonly level: 'info' | 'warn' | 'error' | 'debug';
    readonly msg: string;
    readonly meta?: Readonly<Record<string, unknown>>;
}

function makeLogger(): { records: LogEntry[]; logger: Logger } {
    const records: LogEntry[] = [];
    const push = (level: LogEntry['level']) =>
        (msg: string, meta?: Readonly<Record<string, unknown>>): void => {
            records.push({ level, msg, meta });
        };
    return {
        records,
        logger: {
            info: push('info'),
            warn: push('warn'),
            error: push('error'),
            debug: push('debug'),
        },
    };
}

function makeDb(dir: string, file = 'state.db'): Database.Database {
    const dbPath = path.join(dir, file);
    const db = new Database(dbPath);
    db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, payload TEXT)");
    db.prepare('INSERT INTO t(payload) VALUES (?)').run('hello');
    return db;
}

const FAKE_BUS = {} as EventBus;

// ---------------------------------------------------------------------------
// AC #1: snapshot-job exposes a register(eventBus, store, logger) function
// ---------------------------------------------------------------------------

test('register returns a handle with runOnce + stop', () => {
    const dir = tempDir();
    try {
        const db = makeDb(dir);
        try {
            const { logger } = makeLogger();
            const handle = register(FAKE_BUS, db, logger, {
                snapshotsDir: path.join(dir, 'snapshots'),
                runOnStart: false,
                startTimer: false,
            });
            assert.equal(typeof handle.runOnce, 'function');
            assert.equal(typeof handle.stop, 'function');
            handle.stop();
            // stop() is idempotent.
            assert.doesNotThrow(() => handle.stop());
        } finally {
            db.close();
        }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// AC #2: runOnce creates state-YYYY-MM-DD.db via VACUUM INTO
// ---------------------------------------------------------------------------

test('runOnce writes state-YYYY-MM-DD.db with the source data', async () => {
    const dir = tempDir();
    try {
        const db = makeDb(dir);
        try {
            const snapshotsDir = path.join(dir, 'snapshots');
            const { logger } = makeLogger();
            const fakeNow = new Date('2026-05-14T12:00:00Z');
            const handle = register(FAKE_BUS, db, logger, {
                snapshotsDir,
                now: () => fakeNow,
                runOnStart: false,
                startTimer: false,
            });

            await handle.runOnce();

            const target = path.join(snapshotsDir, 'state-2026-05-14.db');
            assert.ok(fs.existsSync(target), `expected snapshot at ${target}`);

            // Open the snapshot and verify it contains the source row.
            const snap = new Database(target, { readonly: true });
            try {
                const rows = snap.prepare('SELECT payload FROM t').all() as {
                    payload: string;
                }[];
                assert.deepEqual(rows, [{ payload: 'hello' }]);
            } finally {
                snap.close();
            }
        } finally {
            db.close();
        }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// AC #3: if today's snapshot already exists, log and skip — no crash
// ---------------------------------------------------------------------------

test('runOnce skips and logs when today’s snapshot already exists', async () => {
    const dir = tempDir();
    try {
        const db = makeDb(dir);
        try {
            const snapshotsDir = path.join(dir, 'snapshots');
            fs.mkdirSync(snapshotsDir, { recursive: true });
            const target = path.join(snapshotsDir, 'state-2026-05-14.db');
            fs.writeFileSync(target, 'sentinel-bytes');

            const { records, logger } = makeLogger();
            const handle = register(FAKE_BUS, db, logger, {
                snapshotsDir,
                now: () => new Date('2026-05-14T12:00:00Z'),
                runOnStart: false,
                startTimer: false,
            });

            await handle.runOnce();

            // File untouched — VACUUM INTO would have failed if attempted.
            assert.equal(
                fs.readFileSync(target, 'utf8'),
                'sentinel-bytes',
                'existing snapshot must not be overwritten',
            );

            const skipped = records.find(
                (r) => r.level === 'info' && r.msg.includes('already exists'),
            );
            assert.ok(skipped, `expected a skip log line; got: ${JSON.stringify(records)}`);

            // No error was logged.
            const errors = records.filter((r) => r.level === 'error');
            assert.deepEqual(errors, []);
        } finally {
            db.close();
        }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// AC #4: retention prunes oldest snapshots so count <= SNAPSHOT_RETAIN
// AC #5: default retention is 7
// ---------------------------------------------------------------------------

test('prunes oldest snapshots down to the retain count (explicit retain=3)', async () => {
    const dir = tempDir();
    try {
        const db = makeDb(dir);
        try {
            const snapshotsDir = path.join(dir, 'snapshots');
            fs.mkdirSync(snapshotsDir, { recursive: true });

            // Pre-seed 5 historical snapshots, oldest first.
            const seeded = [
                'state-2026-05-08.db',
                'state-2026-05-09.db',
                'state-2026-05-10.db',
                'state-2026-05-11.db',
                'state-2026-05-12.db',
            ];
            for (const name of seeded) {
                fs.writeFileSync(path.join(snapshotsDir, name), 'old');
            }
            // Drop an unrelated file in too — it must be left alone.
            fs.writeFileSync(path.join(snapshotsDir, 'README.txt'), 'keep me');

            const { logger } = makeLogger();
            const handle = register(FAKE_BUS, db, logger, {
                snapshotsDir,
                retain: 3,
                now: () => new Date('2026-05-14T12:00:00Z'),
                runOnStart: false,
                startTimer: false,
            });

            await handle.runOnce();

            const remaining = fs
                .readdirSync(snapshotsDir)
                .filter((n) => /^state-\d{4}-\d{2}-\d{2}\.db$/.test(n))
                .sort();
            assert.deepEqual(
                remaining,
                ['state-2026-05-11.db', 'state-2026-05-12.db', 'state-2026-05-14.db'],
                'must keep the 3 newest snapshots and drop the older ones',
            );
            assert.ok(
                fs.existsSync(path.join(snapshotsDir, 'README.txt')),
                'unrelated files must not be pruned',
            );
        } finally {
            db.close();
        }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('default retention is 7 when SNAPSHOT_RETAIN env is unset', async () => {
    const dir = tempDir();
    const prev = process.env.SNAPSHOT_RETAIN;
    delete process.env.SNAPSHOT_RETAIN;
    try {
        const db = makeDb(dir);
        try {
            const snapshotsDir = path.join(dir, 'snapshots');
            fs.mkdirSync(snapshotsDir, { recursive: true });

            // Seed 9 historical snapshots; today's run adds a 10th. After
            // pruning with default retain=7 only 7 should remain.
            for (let i = 1; i <= 9; i++) {
                const day = i.toString().padStart(2, '0');
                fs.writeFileSync(
                    path.join(snapshotsDir, `state-2026-05-${day}.db`),
                    'old',
                );
            }

            const { logger } = makeLogger();
            const handle = register(FAKE_BUS, db, logger, {
                snapshotsDir,
                now: () => new Date('2026-05-14T12:00:00Z'),
                runOnStart: false,
                startTimer: false,
            });

            await handle.runOnce();

            const remaining = fs
                .readdirSync(snapshotsDir)
                .filter((n) => /^state-\d{4}-\d{2}-\d{2}\.db$/.test(n))
                .sort();
            assert.equal(remaining.length, 7, `expected 7 snapshots, got ${remaining.join(', ')}`);
            // Sorted ascending the resulting set is 04..09 plus 14; the
            // three oldest (01, 02, 03) must have been pruned.
            assert.ok(
                !remaining.includes('state-2026-05-01.db'),
                'oldest snapshot must be pruned',
            );
            assert.ok(
                remaining.includes('state-2026-05-14.db'),
                'today’s snapshot must be retained',
            );
        } finally {
            db.close();
        }
    } finally {
        if (prev === undefined) {
            delete process.env.SNAPSHOT_RETAIN;
        } else {
            process.env.SNAPSHOT_RETAIN = prev;
        }
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('SNAPSHOT_RETAIN env override is honoured', async () => {
    const dir = tempDir();
    const prev = process.env.SNAPSHOT_RETAIN;
    process.env.SNAPSHOT_RETAIN = '2';
    try {
        const db = makeDb(dir);
        try {
            const snapshotsDir = path.join(dir, 'snapshots');
            fs.mkdirSync(snapshotsDir, { recursive: true });
            for (const name of ['state-2026-05-10.db', 'state-2026-05-11.db', 'state-2026-05-12.db']) {
                fs.writeFileSync(path.join(snapshotsDir, name), 'old');
            }

            const { logger } = makeLogger();
            const handle = register(FAKE_BUS, db, logger, {
                snapshotsDir,
                now: () => new Date('2026-05-14T12:00:00Z'),
                runOnStart: false,
                startTimer: false,
            });
            await handle.runOnce();

            const remaining = fs
                .readdirSync(snapshotsDir)
                .filter((n) => /^state-\d{4}-\d{2}-\d{2}\.db$/.test(n))
                .sort();
            assert.deepEqual(remaining, ['state-2026-05-12.db', 'state-2026-05-14.db']);
        } finally {
            db.close();
        }
    } finally {
        if (prev === undefined) {
            delete process.env.SNAPSHOT_RETAIN;
        } else {
            process.env.SNAPSHOT_RETAIN = prev;
        }
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// Reviewer requirement: prune order is decided by mtime, not by the date
// embedded in the filename. Seed files whose mtimes deliberately disagree
// with their filename stamps and assert mtime decides what gets pruned.
// ---------------------------------------------------------------------------

test('prune deletes by mtime ascending, not by filename date stamp', async () => {
    const dir = tempDir();
    try {
        const db = makeDb(dir);
        try {
            const snapshotsDir = path.join(dir, 'snapshots');
            fs.mkdirSync(snapshotsDir, { recursive: true });

            // Create four snapshots whose filename order and mtime order
            // are deliberately inverted. By filename stamp the oldest is
            // 2026-05-08; by mtime the oldest is 2026-05-11.
            const seed = [
                { name: 'state-2026-05-08.db', mtimeMs: 4_000 },
                { name: 'state-2026-05-09.db', mtimeMs: 3_000 },
                { name: 'state-2026-05-10.db', mtimeMs: 2_000 },
                { name: 'state-2026-05-11.db', mtimeMs: 1_000 },
            ];
            for (const s of seed) {
                const p = path.join(snapshotsDir, s.name);
                fs.writeFileSync(p, 'old');
                const t = new Date(s.mtimeMs);
                fs.utimesSync(p, t, t);
            }

            const { logger } = makeLogger();
            const handle = register(FAKE_BUS, db, logger, {
                snapshotsDir,
                // retain=3, plus today's run adds state-2026-05-14.db whose
                // mtime is "now" — by far the most recent. So after prune
                // we should keep today + the two newest-by-mtime seeds:
                // 2026-05-08 (mtime 4000) and 2026-05-09 (mtime 3000).
                // The two oldest-by-mtime (10 and 11) should be deleted
                // even though their filename stamps look newest.
                retain: 3,
                now: () => new Date('2026-05-14T12:00:00Z'),
                runOnStart: false,
                startTimer: false,
            });

            await handle.runOnce();

            const remaining = fs
                .readdirSync(snapshotsDir)
                .filter((n) => /^state-\d{4}-\d{2}-\d{2}\.db$/.test(n))
                .sort();
            assert.deepEqual(
                remaining,
                ['state-2026-05-08.db', 'state-2026-05-09.db', 'state-2026-05-14.db'],
                'prune must keep newest-by-mtime even when filenames disagree',
            );
        } finally {
            db.close();
        }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// AC #6: failures are logged through Logger and do NOT crash the host
// ---------------------------------------------------------------------------

test('VACUUM failure is caught and logged via logger.error', async () => {
    const dir = tempDir();
    try {
        const db = makeDb(dir);
        // Close the db BEFORE running so VACUUM INTO throws.
        db.close();

        const { records, logger } = makeLogger();
        const handle = register(FAKE_BUS, db, logger, {
            snapshotsDir: path.join(dir, 'snapshots'),
            now: () => new Date('2026-05-14T12:00:00Z'),
            runOnStart: false,
            startTimer: false,
        });

        // Must not throw.
        await assert.doesNotReject(() => handle.runOnce());

        const errors = records.filter((r) => r.level === 'error');
        assert.ok(errors.length >= 1, `expected at least one error log, got: ${JSON.stringify(records)}`);
        assert.match(errors[0].msg, /snapshot-job/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// runOnStart smoke test: register fires its first cycle synchronously enough
// that a subsequent runOnce sees the file already on disk.
// ---------------------------------------------------------------------------

test('runOnStart=true triggers an initial cycle', async () => {
    const dir = tempDir();
    try {
        const db = makeDb(dir);
        try {
            const snapshotsDir = path.join(dir, 'snapshots');
            const { logger } = makeLogger();
            const handle = register(FAKE_BUS, db, logger, {
                snapshotsDir,
                now: () => new Date('2026-05-14T12:00:00Z'),
                runOnStart: true,
                startTimer: false,
            });
            // Yield to let the fire-and-forget runOnce resolve.
            await new Promise<void>((resolve) => setImmediate(resolve));
            handle.stop();

            assert.ok(
                fs.existsSync(path.join(snapshotsDir, 'state-2026-05-14.db')),
                'runOnStart=true must produce today’s snapshot',
            );
        } finally {
            db.close();
        }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
