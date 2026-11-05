import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { applyMigrations, openDatabase, type Db } from '../../core/state/migrations';
import {
    DECOMPOSE_EVENT_TYPES,
    SqliteDecomposeStatusStore,
    foldRowsToSnapshot,
} from './decompose-status-store';

function makeDb(): Db {
    const db = openDatabase(':memory:');
    applyMigrations(db);
    return db;
}

function insertEvent(
    db: Db,
    type: string,
    payload: Record<string, unknown>,
    options: { readonly occurredAt?: number; readonly idempotencyKey?: string } = {},
): void {
    db.prepare(
        `INSERT INTO events(type, v, occurred_at, idempotency_key, payload)
         VALUES (?, 1, ?, ?, ?)`,
    ).run(
        type,
        options.occurredAt ?? 0,
        options.idempotencyKey ?? `${type}:${Math.random()}`,
        JSON.stringify(payload),
    );
}

test('SqliteDecomposeStatusStore returns blank snapshot when no PlanDecomposed event exists', async () => {
    const db = makeDb();
    try {
        const store = new SqliteDecomposeStatusStore(db);
        const snap = await store.readDecomposeStatus('proj-A', 'plan-1');
        assert.equal(snap.startedAt, null);
        assert.equal(snap.finishedAt, null);
        assert.equal(snap.errorMessage, null);
        assert.equal(snap.currentStep, 0);
        assert.equal(snap.totalSteps, 0);
    } finally {
        db.close();
    }
});

test('SqliteDecomposeStatusStore reports startedAt from a PlanDecomposed event', async () => {
    const db = makeDb();
    try {
        insertEvent(
            db,
            DECOMPOSE_EVENT_TYPES.STARTED,
            { planId: 'plan-1', projectId: 'proj-A', actor: 'operator' },
            { occurredAt: 1_700_000_000_000 },
        );
        const store = new SqliteDecomposeStatusStore(db);
        const snap = await store.readDecomposeStatus('proj-A', 'plan-1');
        assert.equal(snap.startedAt, 1_700_000_000_000);
        assert.equal(snap.finishedAt, null);
        assert.equal(snap.errorMessage, null);
    } finally {
        db.close();
    }
});

test('SqliteDecomposeStatusStore scopes by both projectId and planId', async () => {
    const db = makeDb();
    try {
        // Same planId in two projects — must not leak across.
        insertEvent(
            db,
            DECOMPOSE_EVENT_TYPES.STARTED,
            { planId: 'plan-1', projectId: 'proj-A' },
            { occurredAt: 100, idempotencyKey: 'a' },
        );
        insertEvent(
            db,
            DECOMPOSE_EVENT_TYPES.STARTED,
            { planId: 'plan-1', projectId: 'proj-B' },
            { occurredAt: 200, idempotencyKey: 'b' },
        );
        const store = new SqliteDecomposeStatusStore(db);
        const snapA = await store.readDecomposeStatus('proj-A', 'plan-1');
        const snapB = await store.readDecomposeStatus('proj-B', 'plan-1');
        assert.equal(snapA.startedAt, 100);
        assert.equal(snapB.startedAt, 200);
    } finally {
        db.close();
    }
});

test('SqliteDecomposeStatusStore ignores events for other plans', async () => {
    const db = makeDb();
    try {
        insertEvent(
            db,
            DECOMPOSE_EVENT_TYPES.STARTED,
            { planId: 'plan-other', projectId: 'proj-A' },
            { occurredAt: 1, idempotencyKey: 'other' },
        );
        const store = new SqliteDecomposeStatusStore(db);
        const snap = await store.readDecomposeStatus('proj-A', 'plan-1');
        assert.equal(snap.startedAt, null);
    } finally {
        db.close();
    }
});

// ---------------------------------------------------------------------------
// foldRowsToSnapshot — pure derivation rules
// ---------------------------------------------------------------------------

test('foldRowsToSnapshot reports complete when a Finished event lands after Started', () => {
    const snap = foldRowsToSnapshot(
        [
            {
                type: DECOMPOSE_EVENT_TYPES.STARTED,
                occurred_at: 10,
                payload: JSON.stringify({ planId: 'p', projectId: 'pr' }),
            },
            {
                type: DECOMPOSE_EVENT_TYPES.FINISHED,
                occurred_at: 50,
                payload: JSON.stringify({
                    planId: 'p',
                    projectId: 'pr',
                    currentStep: 5,
                    totalSteps: 5,
                }),
            },
        ],
        'pr',
        'p',
    );
    assert.equal(snap.startedAt, 10);
    assert.equal(snap.finishedAt, 50);
    assert.equal(snap.errorMessage, null);
    assert.equal(snap.currentStep, 5);
    assert.equal(snap.totalSteps, 5);
});

test('foldRowsToSnapshot reads the reason from `error` (emitPlanDecomposeFailed shape)', () => {
    const snap = foldRowsToSnapshot(
        [
            {
                type: DECOMPOSE_EVENT_TYPES.STARTED,
                occurred_at: 10,
                payload: JSON.stringify({ planId: 'p', projectId: 'pr' }),
            },
            {
                type: DECOMPOSE_EVENT_TYPES.FAILED,
                occurred_at: 60,
                payload: JSON.stringify({
                    planId: 'p',
                    projectId: 'pr',
                    error: 'decomposer output is not valid JSON: Unexpected token x',
                }),
            },
        ],
        'pr',
        'p',
    );
    assert.equal(
        snap.errorMessage,
        'decomposer output is not valid JSON: Unexpected token x',
    );
});

test('foldRowsToSnapshot: a retry Started AFTER a failure resets to running', () => {
    const snap = foldRowsToSnapshot(
        [
            {
                type: DECOMPOSE_EVENT_TYPES.STARTED,
                occurred_at: 10,
                payload: JSON.stringify({ planId: 'p', projectId: 'pr' }),
            },
            {
                type: DECOMPOSE_EVENT_TYPES.FAILED,
                occurred_at: 60,
                payload: JSON.stringify({ planId: 'p', projectId: 'pr', error: 'bad JSON' }),
            },
            // Operator clicks approve/decompose again — new attempt.
            {
                type: DECOMPOSE_EVENT_TYPES.STARTED,
                occurred_at: 100,
                payload: JSON.stringify({ planId: 'p', projectId: 'pr' }),
            },
        ],
        'pr',
        'p',
    );
    assert.equal(snap.startedAt, 100);
    assert.equal(snap.finishedAt, null);
    assert.equal(snap.errorMessage, null, 'stale error must not survive a retry');
});

test('foldRowsToSnapshot: agent success emit (PlanDecomposed WITH tasks) supersedes an earlier failure', () => {
    const snap = foldRowsToSnapshot(
        [
            {
                type: DECOMPOSE_EVENT_TYPES.STARTED,
                occurred_at: 10,
                payload: JSON.stringify({ planId: 'p', projectId: 'pr' }),
            },
            {
                type: DECOMPOSE_EVENT_TYPES.FAILED,
                occurred_at: 60,
                payload: JSON.stringify({ planId: 'p', projectId: 'pr', error: 'bad JSON' }),
            },
            {
                type: DECOMPOSE_EVENT_TYPES.STARTED,
                occurred_at: 100,
                payload: JSON.stringify({ planId: 'p', projectId: 'pr' }),
            },
            // The retry's decomposer finished: agent-driven PlanDecomposed
            // carrying the task list is the success terminal.
            {
                type: DECOMPOSE_EVENT_TYPES.STARTED,
                occurred_at: 500,
                payload: JSON.stringify({
                    planId: 'p',
                    projectId: 'pr',
                    tasks: [{ id: 'T-1' }, { id: 'T-2' }],
                }),
            },
        ],
        'pr',
        'p',
    );
    assert.equal(snap.finishedAt, 500);
    assert.equal(snap.errorMessage, null);
});

test('foldRowsToSnapshot reports error when a Failed event carries errorMessage', () => {
    const snap = foldRowsToSnapshot(
        [
            {
                type: DECOMPOSE_EVENT_TYPES.STARTED,
                occurred_at: 10,
                payload: JSON.stringify({ planId: 'p', projectId: 'pr' }),
            },
            {
                type: DECOMPOSE_EVENT_TYPES.FAILED,
                occurred_at: 60,
                payload: JSON.stringify({
                    planId: 'p',
                    projectId: 'pr',
                    errorMessage: 'decomposer crashed',
                    currentStep: 2,
                    totalSteps: 5,
                }),
            },
        ],
        'pr',
        'p',
    );
    assert.equal(snap.startedAt, 10);
    assert.equal(snap.finishedAt, 60);
    assert.equal(snap.errorMessage, 'decomposer crashed');
    assert.equal(snap.currentStep, 2);
    assert.equal(snap.totalSteps, 5);
});

test('foldRowsToSnapshot defaults Failed events with no message to a sentinel string', () => {
    const snap = foldRowsToSnapshot(
        [
            {
                type: DECOMPOSE_EVENT_TYPES.STARTED,
                occurred_at: 10,
                payload: JSON.stringify({ planId: 'p', projectId: 'pr' }),
            },
            {
                type: DECOMPOSE_EVENT_TYPES.FAILED,
                occurred_at: 60,
                payload: JSON.stringify({ planId: 'p', projectId: 'pr' }),
            },
        ],
        'pr',
        'p',
    );
    assert.equal(snap.errorMessage, 'decompose failed');
});

test('foldRowsToSnapshot skips malformed JSON payloads without throwing', () => {
    const snap = foldRowsToSnapshot(
        [
            {
                type: DECOMPOSE_EVENT_TYPES.STARTED,
                occurred_at: 5,
                payload: '{not json',
            },
            {
                type: DECOMPOSE_EVENT_TYPES.STARTED,
                occurred_at: 10,
                payload: JSON.stringify({ planId: 'p', projectId: 'pr' }),
            },
        ],
        'pr',
        'p',
    );
    assert.equal(snap.startedAt, 10);
});

test('foldRowsToSnapshot keeps the earliest startedAt when a duplicate Started lands', () => {
    const snap = foldRowsToSnapshot(
        [
            {
                type: DECOMPOSE_EVENT_TYPES.STARTED,
                occurred_at: 10,
                payload: JSON.stringify({ planId: 'p', projectId: 'pr' }),
            },
            {
                type: DECOMPOSE_EVENT_TYPES.STARTED,
                occurred_at: 99,
                payload: JSON.stringify({ planId: 'p', projectId: 'pr' }),
            },
        ],
        'pr',
        'p',
    );
    assert.equal(snap.startedAt, 10);
});
