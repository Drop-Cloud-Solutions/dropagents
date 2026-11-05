/**
 * Telemetry retention.
 *
 *   1. Deletes AgentActivity/AgentProgress older than the window; keeps
 *      newer telemetry and ALL non-telemetry events of any age.
 *   2. retentionDays 0 disables (nothing deleted).
 *   3. Env resolution: default 7, explicit value, 0-disable, garbage → 7.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { EventStore } from '../events/store';
import { applyMigrations, openDatabase } from './migrations';
import {
    pruneTelemetryEvents,
    resolveTelemetryRetentionDays,
} from './telemetry-prune';

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_900_000_000_000;

let n = 0;
function seed(store: EventStore, type: string, occurredAt: number): void {
    n += 1;
    store.append({
        type,
        v: 1,
        occurredAt,
        idempotencyKey: `prune-test:${n}`,
        payload: { n },
    });
}

function counts(db: ReturnType<typeof openDatabase>): Record<string, number> {
    const rows = db
        .prepare('SELECT type, COUNT(*) AS c FROM events GROUP BY type')
        .all() as Array<{ type: string; c: number }>;
    return Object.fromEntries(rows.map((r) => [r.type, r.c]));
}

test('deletes only old telemetry; keeps recent telemetry and all real events', () => {
    const db = openDatabase(':memory:');
    try {
        applyMigrations(db);
        const store = new EventStore(db);
        seed(store, 'AgentProgress', NOW - 30 * DAY);
        seed(store, 'AgentActivity', NOW - 30 * DAY);
        seed(store, 'AgentProgress', NOW - 1 * DAY);
        seed(store, 'TaskCreated', NOW - 365 * DAY);
        seed(store, 'TaskFinished', NOW - 30 * DAY);

        const result = pruneTelemetryEvents(db, { retentionDays: 7, now: NOW });
        assert.equal(result.deleted, 2);
        assert.deepEqual(counts(db), {
            AgentProgress: 1,
            TaskCreated: 1,
            TaskFinished: 1,
        });
    } finally {
        db.close();
    }
});

test('retentionDays 0 disables pruning', () => {
    const db = openDatabase(':memory:');
    try {
        applyMigrations(db);
        const store = new EventStore(db);
        seed(store, 'AgentProgress', NOW - 400 * DAY);
        const result = pruneTelemetryEvents(db, { retentionDays: 0, now: NOW });
        assert.equal(result.deleted, 0);
        assert.equal(counts(db).AgentProgress, 1);
    } finally {
        db.close();
    }
});

test('env resolution: default, explicit, disable, garbage', () => {
    assert.equal(resolveTelemetryRetentionDays({}), 7);
    assert.equal(resolveTelemetryRetentionDays({ PIPELINE_TELEMETRY_RETENTION_DAYS: '30' }), 30);
    assert.equal(resolveTelemetryRetentionDays({ PIPELINE_TELEMETRY_RETENTION_DAYS: '0' }), 0);
    assert.equal(resolveTelemetryRetentionDays({ PIPELINE_TELEMETRY_RETENTION_DAYS: 'soon' }), 7);
    assert.equal(resolveTelemetryRetentionDays({ PIPELINE_TELEMETRY_RETENTION_DAYS: '-3' }), 7);
});
