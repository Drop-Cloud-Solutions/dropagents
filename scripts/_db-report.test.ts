/**
 * db-report: the measurements an operator acts on.
 *
 * Field question: "the sqlite database on the worker machine is now
 * 1.4 GB, that seems a bit big, should we do anything about that?" The
 * honest answer needed a measurement the worker could take — it has no
 * sqlite3 CLI — and the two possible causes have opposite fixes, so the
 * report has to tell them apart rather than print a pile of numbers.
 *
 * These pin the parts that would send someone to the wrong fix: the
 * free-page verdict, the prune dry run (including when pruning is OFF,
 * where reporting a reclaim would be a lie), and the promise that no
 * payload VALUE is ever printed.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { applyMigrations, openDatabase, type Db } from '../core/state/migrations';
import {
    VACUUM_WORTH_IT_RATIO,
    buildDbReport,
    formatDbReport,
} from './_db-report';
import { run } from './db-report';

function makeDb(): Db {
    const db = openDatabase(':memory:');
    applyMigrations(db);
    return db;
}

const NOW = Date.UTC(2026, 10, 3);
const DAY = 24 * 60 * 60 * 1000;

let seq = 0;
function append(db: Db, type: string, occurredAt: number, payload: unknown): void {
    seq += 1;
    db.prepare(
        `INSERT INTO events(type, v, occurred_at, idempotency_key, payload)
         VALUES (?, 1, ?, ?, ?)`,
    ).run(type, occurredAt, `${type}:${seq}`, JSON.stringify(payload));
}

const report = (db: Db, env?: Record<string, string | undefined>) =>
    buildDbReport(db, {
        dbPath: 'C:/worker/.pipeline-state.db',
        now: NOW,
        env: env ?? {},
        // Fixed sizes: the real stat would read a file that is not there
        // for an in-memory DB, and the figure under test is the ratio.
        sizeOf: (p) => (p.endsWith('-wal') ? 2 * 1024 * 1024 : 40 * 1024 * 1024),
    });

test('payload bytes are attributed to the event type that carries them', () => {
    const db = makeDb();
    try {
        append(db, 'AgentFinished', NOW - DAY, { content: 'x'.repeat(4000) });
        append(db, 'AgentFinished', NOW - DAY, { content: 'y'.repeat(2000) });
        append(db, 'AgentProgress', NOW - DAY, { chunk: 'z'.repeat(100) });
        const r = report(db);
        assert.equal(r.eventRows, 3);
        // Ordered by bytes, so the thing to look at is first.
        assert.equal(r.byType[0]?.type, 'AgentFinished');
        assert.equal(r.byType[0]?.rows, 2);
        assert.ok(r.byType[0]!.bytes > 6000);
        assert.ok(
            r.byType[0]!.maxBytes > 4000 && r.byType[0]!.maxBytes < 4200,
            'the largest single payload is reported, not just the average',
        );
        assert.equal(r.payloadBytes, r.byType.reduce((s, t) => s + t.bytes, 0));
    } finally {
        db.close();
    }
});

test('the prune dry run counts only telemetry PAST the window', () => {
    const db = makeDb();
    try {
        // Inside the 7-day window: a restart keeps these.
        append(db, 'AgentProgress', NOW - 2 * DAY, { chunk: 'recent' });
        // Past it: a restart deletes these.
        append(db, 'AgentProgress', NOW - 30 * DAY, { chunk: 'old' });
        append(db, 'AgentActivity', NOW - 30 * DAY, { extra: 'old' });
        // Not telemetry at any age — the historical record.
        append(db, 'AgentFinished', NOW - 30 * DAY, { content: 'kept' });

        const r = report(db, { PIPELINE_TELEMETRY_RETENTION_DAYS: '7' });
        assert.equal(r.telemetry.rows, 3, 'all telemetry, any age');
        assert.equal(r.telemetry.prunableRows, 2, 'only the two past the window');
        assert.ok(r.telemetry.prunableBytes > 0);
        assert.equal(r.telemetry.retentionDays, 7);

        const text = formatDbReport(r);
        assert.match(text, /restart would delete 2 rows/);
        assert.match(text, /BOOT ONLY/);
    } finally {
        db.close();
    }
});

test('with pruning disabled the report promises no reclaim', () => {
    // PIPELINE_TELEMETRY_RETENTION_DAYS=0 disables the prune. Printing a
    // cutoff here would tell an operator a restart reclaims something,
    // and it would not — they would restart the worker for nothing.
    const db = makeDb();
    try {
        append(db, 'AgentProgress', NOW - 400 * DAY, { chunk: 'ancient' });
        const r = report(db, { PIPELINE_TELEMETRY_RETENTION_DAYS: '0' });
        assert.equal(r.telemetry.rows, 1);
        assert.equal(r.telemetry.prunableRows, 0);
        const text = formatDbReport(r);
        assert.match(text, /DISABLED/);
        assert.doesNotMatch(text, /restart would delete/);
    } finally {
        db.close();
    }
});

test('the free-page verdict names the fix, and only when it applies', () => {
    // The whole point of the section: a big FILE and big DATA have
    // opposite fixes, and vacuuming a file with no slack is wasted
    // downtime on a machine the operator had to stop.
    const slack = formatDbReport({
        ...report(makeDb()),
        freeRatio: VACUUM_WORTH_IT_RATIO + 0.1,
        freeBytes: 900 * 1024 * 1024,
    });
    assert.match(slack, /mostly slack/);
    assert.match(slack, /vacuum:db/);
    assert.match(slack, /900\.0 MB to the OS/);

    const dense = formatDbReport({
        ...report(makeDb()),
        freeRatio: VACUUM_WORTH_IT_RATIO - 0.05,
    });
    assert.match(dense, /mostly live data/);
    assert.doesNotMatch(dense, /vacuum:db/);
});

test('the report prints no payload VALUE', () => {
    // It is meant to be pasted into a chat or a ticket. Payloads carry
    // prompts, agent output and operator feedback; a report that echoed
    // them could not be shared, which would make it useless.
    const db = makeDb();
    try {
        const secretish = 'SUPER-SECRET-PROMPT-TEXT';
        append(db, 'AgentFinished', NOW - DAY, { content: secretish });
        append(db, 'BriefSubmitted', NOW - DAY, { content: secretish });
        const text = formatDbReport(report(db));
        assert.ok(
            !text.includes(secretish),
            'a payload value reached the report output',
        );
        // The type names it DOES print are what makes it actionable.
        assert.match(text, /AgentFinished/);
        assert.match(text, /BriefSubmitted/);
    } finally {
        db.close();
    }
});

test('an empty log reports cleanly rather than dividing by zero', () => {
    const db = makeDb();
    try {
        const r = report(db);
        assert.equal(r.eventRows, 0);
        assert.equal(r.payloadBytes, 0);
        assert.equal(r.oldestEventAt, null);
        const text = formatDbReport(r);
        assert.match(text, /span {12}— \.\. —/);
        assert.doesNotMatch(text, /NaN/);
    } finally {
        db.close();
    }
});

// --- the CLI wrapper -------------------------------------------------

test('a bad --types is refused instead of silently ignored', async () => {
    const errs: string[] = [];
    const code = await run(['--types', 'lots'], {
        stderr: (l) => errs.push(l),
        openDb: () => {
            throw new Error('must not open the db for an invalid argument');
        },
    });
    assert.equal(code, 1);
    assert.match(errs.join(''), /--types must be a positive integer/);
});

test('an unopenable db reports the path and the reason, and exits non-zero', async () => {
    // Overwhelmingly the likely cause is a wrong path, and a size report
    // against the wrong file is worse than no report: it would be
    // confidently wrong about the machine the operator is deciding on.
    const errs: string[] = [];
    const code = await run(['--db', 'C:/nope/missing.db'], {
        stderr: (l) => errs.push(l),
        openDb: () => {
            throw new Error('unable to open database file');
        },
    });
    assert.equal(code, 1);
    const text = errs.join('');
    assert.match(text, /C:\/nope\/missing\.db/);
    assert.match(text, /unable to open database file/);
});

test('the CLI prints the report and closes the db it opened', async () => {
    const db = makeDb();
    append(db, 'AgentFinished', NOW - DAY, { content: 'x'.repeat(500) });
    let closed = false;
    const out: string[] = [];
    const code = await run(['--db', 'C:/worker/.pipeline-state.db'], {
        stdout: (l) => out.push(l),
        now: () => NOW,
        openDb: () => {
            const handle = db as unknown as { close: () => void };
            const realClose = handle.close.bind(handle);
            handle.close = (): void => {
                closed = true;
                realClose();
            };
            return db as never;
        },
    });
    assert.equal(code, 0);
    assert.match(out.join(''), /db-report: C:\/worker\/\.pipeline-state\.db/);
    assert.match(out.join(''), /AgentFinished/);
    assert.ok(closed, 'a readonly handle still has to be released');
});

test('types beyond the limit are rolled up so the totals still add up', () => {
    const db = makeDb();
    try {
        for (let i = 0; i < 5; i += 1) {
            append(db, `Type${i}`, NOW - DAY, { content: 'x'.repeat(100 * (5 - i)) });
        }
        const r = buildDbReport(db, {
            dbPath: 'x.db',
            now: NOW,
            env: {},
            typeLimit: 2,
            sizeOf: () => 0,
        });
        assert.equal(r.byType.length, 2);
        assert.equal(r.otherTypes.types, 3);
        assert.equal(
            r.byType.reduce((s, t) => s + t.bytes, 0) + r.otherTypes.bytes,
            r.payloadBytes,
            'listed + rolled up must equal the total, or the report misleads',
        );
        assert.match(formatDbReport(r), /\(\+3 smaller types\)/);
    } finally {
        db.close();
    }
});
