import { test as nodeTest } from 'node:test';
import * as assert from 'node:assert/strict';

// Dual-runner test registration. The repo's primary runner is
// `node --test --import tsx` (see package.json#scripts.test); the review
// pipeline however runs `npx vitest run` against changed test files.
// Under vitest with `globals: true` (see vitest.config.ts) the `test`
// registration function lives on `globalThis`; under `node --test` we
// fall back to the `node:test` export. Assertions stay on `node:assert`,
// which behaves identically under both runners.
type TestFn = (name: string, fn: () => void | Promise<void>) => void;
const test: TestFn = (globalThis as { test?: TestFn }).test ?? nodeTest;

import { applyMigrations, openDatabase, type Db } from '../../core/state/migrations';
import { BoardHttpServer } from '../../adapters/board-http/server';
import type { Command } from '../../core/commands/command';
import type { StoredEvent } from '../../core/events/event';
import type { Logger } from '../../core/ports/Logger';

import { createWorkerApiHealthCheck, type HealthCheckBody } from './health';

class SilentLogger implements Logger {
    info(): void {}
    warn(): void {}
    error(): void {}
    debug(): void {}
}

function makeDb(): Db {
    const db = openDatabase(':memory:');
    applyMigrations(db);
    return db;
}

function insertEvent(db: Db, idempotencyKey: string): number {
    const info = db
        .prepare(
            `INSERT INTO events(type, v, occurred_at, idempotency_key, payload)
             VALUES ('Test', 1, 0, ?, '{}')`,
        )
        .run(idempotencyKey);
    return Number(info.lastInsertRowid);
}

function setOffset(db: Db, subscriber: string, lastSeq: number): void {
    db.prepare(
        `INSERT OR REPLACE INTO subscriber_offsets(subscriber, last_seq)
         VALUES (?, ?)`,
    ).run(subscriber, lastSeq);
}

/** Promise that never resolves — used to force the timeout branch. */
function never<T>(): Promise<T> {
    return new Promise<T>(() => {});
}

test('health body has the shape required by AP-NVP-032', async () => {
    const db = makeDb();
    try {
        const check = createWorkerApiHealthCheck({
            db,
            uptime: () => 12.5,
        });
        const body = await check();
        assert.equal(body.ok, true);
        assert.equal(body.uptime, 12.5);
        // No events, no subscribers -> 0, not null.
        assert.equal(body.pendingProjections, 0);
    } finally {
        db.close();
    }
});

test('uptime defaults to process.uptime() in seconds when not injected', async () => {
    const db = makeDb();
    try {
        const before = process.uptime();
        const check = createWorkerApiHealthCheck({ db });
        const body = await check();
        const after = process.uptime();
        assert.ok(
            body.uptime >= before && body.uptime <= after,
            `expected uptime in [${before}, ${after}], got ${body.uptime}`,
        );
    } finally {
        db.close();
    }
});

test('pendingProjections = max(events.seq) - min(subscriber_offsets.last_seq) when both rows exist', async () => {
    const db = makeDb();
    try {
        for (let i = 0; i < 10; i++) insertEvent(db, `e-${i}`);
        setOffset(db, 'projection-plans', 7);
        setOffset(db, 'projection-tasks', 4); // slowest — drives the gauge

        const check = createWorkerApiHealthCheck({ db, uptime: () => 0 });
        const body = await check();
        assert.equal(body.pendingProjections, 10 - 4);
    } finally {
        db.close();
    }
});

test('pendingProjections is 0 when there are no subscriber_offsets rows (AC #4)', async () => {
    const db = makeDb();
    try {
        for (let i = 0; i < 5; i++) insertEvent(db, `e-${i}`);
        // Intentionally no setOffset calls.
        const check = createWorkerApiHealthCheck({ db, uptime: () => 0 });
        const body = await check();
        assert.equal(body.pendingProjections, 0);
    } finally {
        db.close();
    }
});

test('pendingProjections is 0 when the slowest subscriber is caught up past the head', async () => {
    // Defensive: max(seq) - min(last_seq) can briefly go negative if a
    // subscriber writes its offset between the two sub-selects, or if a
    // subscriber is seeded ahead during recovery. The gauge clamps to 0
    // rather than reporting a nonsensical negative lag.
    const db = makeDb();
    try {
        insertEvent(db, 'e-1');
        setOffset(db, 'projection-plans', 99);
        const check = createWorkerApiHealthCheck({ db, uptime: () => 0 });
        const body = await check();
        assert.equal(body.pendingProjections, 0);
    } finally {
        db.close();
    }
});

test('pendingProjections falls back to null when the query times out (AC #7)', async () => {
    const db = makeDb();
    try {
        const check = createWorkerApiHealthCheck({
            db,
            uptime: () => 1,
            timeoutMs: 10,
            queryPendingProjections: () => never<number>(),
        });
        const t0 = Date.now();
        const body = await check();
        const elapsed = Date.now() - t0;
        assert.equal(body.ok, true);
        assert.equal(body.pendingProjections, null);
        assert.ok(
            elapsed < 200,
            `expected timeout under 200ms (p99 budget), got ${elapsed}ms`,
        );
    } finally {
        db.close();
    }
});

test('pendingProjections falls back to null when the query throws', async () => {
    const db = makeDb();
    try {
        const check = createWorkerApiHealthCheck({
            db,
            uptime: () => 0,
            queryPendingProjections: (): number => {
                throw new Error('store explosion');
            },
        });
        const body = await check();
        assert.equal(body.ok, true);
        assert.equal(body.pendingProjections, null);
    } finally {
        db.close();
    }
});

test('AP-VP7-003: body carries adapters / lastEventAt / parkedTasks on the happy path (AC #1, #4)', async () => {
    const db = makeDb();
    try {
        const check = createWorkerApiHealthCheck({
            db,
            uptime: () => 0,
            getAdapterStatuses: () => ({
                telegram: { wired: true },
                linear: { wired: false },
            }),
            getLastEventAt: () => '2026-05-18T10:00:00.000Z',
            getParkedTaskCount: () => 7,
        });
        const body = await check();

        assert.deepEqual(body.adapters, {
            telegram: { wired: true },
            linear: { wired: false },
        });
        assert.equal(body.lastEventAt, '2026-05-18T10:00:00.000Z');
        assert.equal(body.parkedTasks, 7);
        assert.deepEqual(body.degraded, {
            adapters: false,
            lastEventAt: false,
            parkedTasks: false,
        });
    } finally {
        db.close();
    }
});

test('AP-IFV-002: approvalOverrideWarnings is populated from the injected reader', async () => {
    const db = makeDb();
    try {
        const check = createWorkerApiHealthCheck({
            db,
            uptime: () => 0,
            getApprovalOverrideWarnings: () => [
                {
                    projectId: 'alpha',
                    flowName: 'commit',
                    stepId: 'ghost',
                    reason: 'approval_override references step id "ghost" under flow "commit" but the supplied flow has no such step — this override will silently no-op until the flow declares "ghost".',
                },
            ],
        });
        const body = await check();
        assert.equal(body.approvalOverrideWarnings.length, 1);
        const [warning] = body.approvalOverrideWarnings;
        assert.equal(warning.projectId, 'alpha');
        assert.equal(warning.flowName, 'commit');
        assert.equal(warning.stepId, 'ghost');
        assert.match(warning.reason, /silently no-op/);
    } finally {
        db.close();
    }
});

test('AP-IFV-002: approvalOverrideWarnings defaults to [] when no reader is injected and existing fields are unchanged', async () => {
    const db = makeDb();
    try {
        const check = createWorkerApiHealthCheck({ db, uptime: () => 1 });
        const body = await check();
        assert.deepEqual(body.approvalOverrideWarnings, []);
        // Pre-existing fields untouched — purely additive (AC #4).
        assert.equal(body.ok, true);
        assert.equal(body.uptime, 1);
        assert.deepEqual(body.adapters, {});
        assert.equal(body.lastEventAt, null);
        assert.equal(body.parkedTasks, 0);
        assert.deepEqual(body.degraded, {
            adapters: false,
            lastEventAt: false,
            parkedTasks: false,
        });
    } finally {
        db.close();
    }
});

test('AP-IFV-002: a throwing approvalOverrideWarnings reader degrades to [] without affecting other fields', async () => {
    const db = makeDb();
    try {
        const check = createWorkerApiHealthCheck({
            db,
            uptime: () => 0,
            getAdapterStatuses: () => ({ telegram: { wired: true } }),
            getApprovalOverrideWarnings: () => {
                throw new Error('registry exploded');
            },
        });
        const body = await check();
        assert.equal(body.ok, true);
        assert.deepEqual(body.approvalOverrideWarnings, []);
        assert.deepEqual(body.adapters, { telegram: { wired: true } });
    } finally {
        db.close();
    }
});

test('AP-VP7-003: new fields default to {} / null / 0 when no readers are injected (AC #2)', async () => {
    // Production hosts/worker-api/main.ts currently passes only `db`. The
    // body shape must stay stable for that caller — empty defaults, no
    // degraded flags raised.
    const db = makeDb();
    try {
        const check = createWorkerApiHealthCheck({ db, uptime: () => 0 });
        const body = await check();
        assert.deepEqual(body.adapters, {});
        assert.equal(body.lastEventAt, null);
        assert.equal(body.parkedTasks, 0);
        assert.deepEqual(body.degraded, {
            adapters: false,
            lastEventAt: false,
            parkedTasks: false,
        });
    } finally {
        db.close();
    }
});

test('AP-VP7-003: a slow parkedTasks reader degrades independently — adapters + lastEventAt still resolve (AC #3, #5)', async () => {
    const db = makeDb();
    try {
        const check = createWorkerApiHealthCheck({
            db,
            uptime: () => 0,
            timeoutMs: 25,
            getAdapterStatuses: () => ({ telegram: { wired: true } }),
            getLastEventAt: () => '2026-05-18T09:00:00.000Z',
            getParkedTaskCount: () => never<number>(), // exceeds the budget
        });
        const t0 = Date.now();
        const body = await check();
        const elapsed = Date.now() - t0;

        assert.equal(body.ok, true);
        assert.deepEqual(body.adapters, { telegram: { wired: true } });
        assert.equal(body.lastEventAt, '2026-05-18T09:00:00.000Z');
        assert.equal(body.parkedTasks, 0);
        assert.equal(body.degraded.parkedTasks, true);
        assert.equal(body.degraded.adapters, false);
        assert.equal(body.degraded.lastEventAt, false);
        assert.ok(
            elapsed < 200,
            `expected timeout under 200ms (p99 budget), got ${elapsed}ms`,
        );
    } finally {
        db.close();
    }
});

test('AP-VP7-003: a slow adapters reader degrades independently — parkedTasks + lastEventAt still resolve (AC #3, #5)', async () => {
    const db = makeDb();
    try {
        const check = createWorkerApiHealthCheck({
            db,
            uptime: () => 0,
            timeoutMs: 25,
            getAdapterStatuses: () => never<Record<string, { wired: boolean }>>(),
            getLastEventAt: () => '2026-05-18T08:00:00.000Z',
            getParkedTaskCount: () => 3,
        });
        const body = await check();

        assert.deepEqual(body.adapters, {});
        assert.equal(body.lastEventAt, '2026-05-18T08:00:00.000Z');
        assert.equal(body.parkedTasks, 3);
        assert.equal(body.degraded.adapters, true);
        assert.equal(body.degraded.lastEventAt, false);
        assert.equal(body.degraded.parkedTasks, false);
    } finally {
        db.close();
    }
});

test('AP-VP7-003: a slow lastEventAt reader degrades independently (AC #3, #5)', async () => {
    const db = makeDb();
    try {
        const check = createWorkerApiHealthCheck({
            db,
            uptime: () => 0,
            timeoutMs: 25,
            getAdapterStatuses: () => ({ linear: { wired: true } }),
            getLastEventAt: () => never<string | null>(),
            getParkedTaskCount: () => 1,
        });
        const body = await check();

        assert.deepEqual(body.adapters, { linear: { wired: true } });
        assert.equal(body.lastEventAt, null);
        assert.equal(body.parkedTasks, 1);
        assert.equal(body.degraded.lastEventAt, true);
        assert.equal(body.degraded.adapters, false);
        assert.equal(body.degraded.parkedTasks, false);
    } finally {
        db.close();
    }
});

test('AP-VP7-003: a throwing reader degrades to the default with degraded flag raised', async () => {
    const db = makeDb();
    try {
        const check = createWorkerApiHealthCheck({
            db,
            uptime: () => 0,
            getAdapterStatuses: (): Record<string, { wired: boolean }> => {
                throw new Error('adapter registry exploded');
            },
            getLastEventAt: (): string | null => {
                throw new Error('event store exploded');
            },
            getParkedTaskCount: (): number => {
                throw new Error('projection exploded');
            },
        });
        const body = await check();

        assert.equal(body.ok, true);
        assert.deepEqual(body.adapters, {});
        assert.equal(body.lastEventAt, null);
        assert.equal(body.parkedTasks, 0);
        assert.deepEqual(body.degraded, {
            adapters: true,
            lastEventAt: true,
            parkedTasks: true,
        });
    } finally {
        db.close();
    }
});

test('AP-VP7-003: all three readers running in parallel still finish within one shared budget', async () => {
    // Each reader sleeps for ~60ms. Sequential execution would take ~180ms
    // — comfortably over the 100ms budget. Running them in parallel must
    // keep the whole /health response well under the p99 budget.
    const sleep = (ms: number): Promise<void> =>
        new Promise((r) => setTimeout(r, ms));
    const db = makeDb();
    try {
        const check = createWorkerApiHealthCheck({
            db,
            uptime: () => 0,
            timeoutMs: 100,
            getAdapterStatuses: async () => {
                await sleep(60);
                return { telegram: { wired: true } };
            },
            getLastEventAt: async () => {
                await sleep(60);
                return '2026-05-18T07:00:00.000Z';
            },
            getParkedTaskCount: async () => {
                await sleep(60);
                return 2;
            },
        });
        const t0 = Date.now();
        const body = await check();
        const elapsed = Date.now() - t0;

        assert.equal(body.degraded.adapters, false);
        assert.equal(body.degraded.lastEventAt, false);
        assert.equal(body.degraded.parkedTasks, false);
        assert.ok(
            elapsed < 150,
            `expected parallel execution under ~100ms budget, got ${elapsed}ms`,
        );
    } finally {
        db.close();
    }
});

interface HttpHarness {
    readonly baseUrl: string;
    close(): Promise<void>;
}

async function makeHttpHarness(
    healthCheck: () => Promise<HealthCheckBody>,
    token = 'shh',
): Promise<HttpHarness> {
    const noopBus = {
        async send(_cmd: Command): Promise<readonly StoredEvent[]> {
            return [];
        },
    };
    const server = new BoardHttpServer({
        commandBus: noopBus,
        subscribeAll: () => () => {},
        authToken: token,
        healthCheck,
        logger: new SilentLogger(),
    });
    const { port } = await server.listen(0);
    return {
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => server.close(),
    };
}

test('GET /health does not require Bearer auth and returns the worker-api body (AC #1, #5)', async () => {
    const db = makeDb();
    insertEvent(db, 'e-1');
    insertEvent(db, 'e-2');
    setOffset(db, 'projection-plans', 1);

    const check = createWorkerApiHealthCheck({ db, uptime: () => 3.14 });
    const h = await makeHttpHarness(check);
    try {
        const res = await fetch(`${h.baseUrl}/health`);
        assert.equal(res.status, 200);
        const body = (await res.json()) as HealthCheckBody;
        assert.equal(body.ok, true);
        assert.equal(body.uptime, 3.14);
        assert.equal(body.pendingProjections, 1); // 2 - 1
    } finally {
        await h.close();
        db.close();
    }
});

test('GET /health responds in under 200ms p99 even with a slow store (AC #6, #7)', async () => {
    const check = createWorkerApiHealthCheck({
        db: makeDb(), // unused — query is overridden
        uptime: () => 0,
        timeoutMs: 50,
        queryPendingProjections: () => never<number>(),
    });
    const h = await makeHttpHarness(check);
    try {
        const samples: number[] = [];
        for (let i = 0; i < 20; i++) {
            const t0 = Date.now();
            const res = await fetch(`${h.baseUrl}/health`);
            const elapsed = Date.now() - t0;
            assert.equal(res.status, 200);
            const body = (await res.json()) as HealthCheckBody;
            assert.equal(body.ok, true);
            assert.equal(body.pendingProjections, null);
            samples.push(elapsed);
        }
        samples.sort((a, b) => a - b);
        // 20 samples — index 19 is the maximum; use it as the p99 proxy.
        const p99 = samples[samples.length - 1];
        assert.ok(p99 < 200, `expected p99 under 200ms, got ${p99}ms (samples=${samples.join(',')})`);
    } finally {
        await h.close();
    }
});

test('pendingProjections ignores live-only subscribers when the host names its projectors', async () => {
    // Field case: /health reported 13803 pending on a worker whose
    // projections were fully caught up. Action subscribers (auto-merge,
    // fan-out, verify-gate, merge-conflict-resolver) never replay, so
    // their offsets sit wherever the last live event left them and
    // dragged MIN(last_seq) — the gauge measured them, not the projectors.
    const db = makeDb();
    try {
        for (let i = 0; i < 100; i++) insertEvent(db, `e-${i}`);
        setOffset(db, 'projection-tasks', 98);
        setOffset(db, 'projection-plans', 100);
        setOffset(db, 'auto-merge', 3);           // live-only, far behind
        setOffset(db, 'merge-conflict-resolver', 1);

        const unscoped = await createWorkerApiHealthCheck({ db })();
        assert.equal(unscoped.pendingProjections, 99, 'legacy behaviour: the straggler wins');

        const scoped = await createWorkerApiHealthCheck({
            db,
            projectionSubscribers: ['projection-tasks', 'projection-plans'],
        })();
        assert.equal(scoped.pendingProjections, 2, 'only the replaying projectors count');
    } finally {
        db.close();
    }
});
