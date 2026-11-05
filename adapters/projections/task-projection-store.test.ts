import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { applyMigrations, openDatabase, type Db } from '../../core/state/migrations';
import { EventBus } from '../../core/events/bus';
import { EventStore } from '../../core/events/store';
import type {
    Event,
    PlanDecomposed,
    StoredEvent,
} from '../../core/events/event';
import type { Logger } from '../../core/ports/Logger';
import {
    TASK_CREATED_EVENT_TYPE,
    TaskProjectionStore,
    taskCreatedIdempotencyKey,
    type ProjectedTaskCreatedPayload,
} from './task-projection-store';

class FakeLogger implements Logger {
    readonly errors: Array<{ message: string; meta?: unknown }> = [];
    info(): void {}
    warn(): void {}
    debug(): void {}
    error(message: string, meta?: Readonly<Record<string, unknown>>): void {
        this.errors.push({ message, meta });
    }
}

function makeBus(): { db: Db; store: EventStore; bus: EventBus; logger: FakeLogger } {
    const db = openDatabase(':memory:');
    applyMigrations(db);
    const store = new EventStore(db);
    const logger = new FakeLogger();
    const bus = new EventBus(store, logger);
    return { db, store, bus, logger };
}

function fixedClock(start = 1_700_000_000_000): () => number {
    let now = start;
    return () => {
        now += 1;
        return now;
    };
}

function planDecomposed(
    planId: string,
    tasks: PlanDecomposed['payload']['tasks'],
    idempotencyKey = `DecomposePlan:${planId}`,
): Event {
    return {
        type: 'PlanDecomposed',
        v: 1,
        occurredAt: 1_700_000_000_000,
        idempotencyKey,
        payload: { planId, tasks },
    };
}

function readTaskCreatedRows(store: EventStore): StoredEvent[] {
    return store
        .readAfter(0, 1000)
        .filter((e) => e.type === TASK_CREATED_EVENT_TYPE);
}

// ---------------------------------------------------------------------------
// AC #1, #5 — fold one PlanDecomposed into N TaskCreated, preserving fields
// ---------------------------------------------------------------------------

test('PlanDecomposed produces one TaskCreated per task with the preserved fields', async () => {
    const { db, store, bus } = makeBus();
    try {
        new TaskProjectionStore(bus, fixedClock());

        const event = planDecomposed('plan-1', [
            {
                id: 't-1',
                title: 'Write the thing',
                type: 'implement',
                dependencies: [],
                description: 'do the work',
            },
            {
                id: 't-2',
                title: 'Test the thing',
                type: 'test',
                dependencies: ['t-1'],
                description: 'verify the work',
                archetype: 'unit-tests',
            },
        ]);

        await bus.publish(event);

        const rows = readTaskCreatedRows(store);
        assert.equal(rows.length, 2, 'one TaskCreated per task in the payload');

        const payloads = rows.map(
            (r) => r.payload as unknown as ProjectedTaskCreatedPayload,
        );

        // Field-by-field check — preserve id/title/type/dependencies/description
        // (AC #5). `archetype` is intentionally not promoted; the brief lists
        // the five fields explicitly and we keep the projection narrow.
        assert.equal(payloads[0].taskId, 't-1');
        assert.equal(payloads[0].planId, 'plan-1');
        assert.equal(payloads[0].title, 'Write the thing');
        assert.equal(payloads[0].type, 'implement');
        assert.deepEqual(payloads[0].dependencies, []);
        assert.equal(payloads[0].description, 'do the work');

        assert.equal(payloads[1].taskId, 't-2');
        assert.equal(payloads[1].planId, 'plan-1');
        assert.equal(payloads[1].title, 'Test the thing');
        assert.equal(payloads[1].type, 'test');
        assert.deepEqual(payloads[1].dependencies, ['t-1']);
        assert.equal(payloads[1].description, 'verify the work');
    } finally {
        db.close();
    }
});

// ---------------------------------------------------------------------------
// AC #2 — replaying PlanDecomposed must not duplicate TaskCreated rows
// ---------------------------------------------------------------------------

test('republishing the same PlanDecomposed leaves the TaskCreated row count unchanged', async () => {
    const { db, store, bus } = makeBus();
    try {
        new TaskProjectionStore(bus, fixedClock());

        const ev = planDecomposed('plan-1', [
            { id: 't-1', title: 'a', type: 'implement', dependencies: [], description: 'x' },
            { id: 't-2', title: 'b', type: 'test', dependencies: ['t-1'], description: 'y' },
        ]);

        await bus.publish(ev);
        // Republish with the SAME idempotency_key — the EventStore dedupes
        // the row but still fans out to subscribers. The projection's
        // in-memory `processedPlans` set must short-circuit and not emit
        // a second batch of TaskCreated events.
        await bus.publish(ev);

        const rows = readTaskCreatedRows(store);
        assert.equal(rows.length, 2, 'no duplicates from a same-key republish');
    } finally {
        db.close();
    }
});

test('a second PlanDecomposed for the same planId (different key) does not duplicate', async () => {
    const { db, store, bus } = makeBus();
    try {
        new TaskProjectionStore(bus, fixedClock());

        const task = {
            id: 't-1',
            title: 'a',
            type: 'implement',
            dependencies: [] as readonly string[],
            description: 'x',
        };

        // Two distinct PlanDecomposed events with the same planId but
        // different idempotency keys — both are persisted. The
        // projection must still emit `TaskCreated` only once: the hint
        // says "gate on the planId".
        await bus.publish(planDecomposed('plan-1', [task], 'DecomposePlan:plan-1:rev-1'));
        await bus.publish(planDecomposed('plan-1', [task], 'DecomposePlan:plan-1:rev-2'));

        const rows = readTaskCreatedRows(store);
        assert.equal(rows.length, 1, 'planId gate suppresses the second fold');
    } finally {
        db.close();
    }
});

test('a parallel projection on the same bus cannot insert duplicate TaskCreated rows', async () => {
    // Models the post-restart situation: a second projection instance
    // with an empty in-memory `processedPlans` set sees the same
    // `PlanDecomposed` event and tries to emit `TaskCreated` again.
    // The durable `idempotency_key` on every emitted `TaskCreated`
    // collides with the first projection's row at the EventStore's
    // UNIQUE constraint, so the second emission silently de-dupes —
    // the projected row count remains the per-task count, not 2× it.
    const { db, store, bus } = makeBus();
    try {
        new TaskProjectionStore(bus, fixedClock());
        new TaskProjectionStore(bus, fixedClock());

        const ev = planDecomposed('plan-1', [
            { id: 't-1', title: 'a', type: 'implement', dependencies: [], description: 'x' },
            { id: 't-2', title: 'b', type: 'test', dependencies: ['t-1'], description: 'y' },
        ]);
        await bus.publish(ev);

        const rows = readTaskCreatedRows(store);
        assert.equal(
            rows.length,
            2,
            'idempotency_key on TaskCreated keeps the durable row count at 2 even with two folders firing',
        );

        // The idempotency keys are exactly the ones the helper builds —
        // proof that the projection used the documented scheme and a
        // future audit can reconstruct them.
        const keys = rows.map((r) => r.idempotencyKey).sort();
        assert.deepEqual(keys, [
            taskCreatedIdempotencyKey('plan-1', 't-1'),
            taskCreatedIdempotencyKey('plan-1', 't-2'),
        ]);
    } finally {
        db.close();
    }
});

// ---------------------------------------------------------------------------
// AC #3 — existing folds keep working (legacy / empty payload path)
// ---------------------------------------------------------------------------

test('PlanDecomposed without tasks is folded into zero TaskCreated rows and leaves the plan unprocessed', async () => {
    const { db, store, bus } = makeBus();
    try {
        const projection = new TaskProjectionStore(bus, fixedClock());

        // Two `PlanDecomposed` events flow per plan in production:
        // a synchronous one from the DecomposePlan command handler
        // (no `tasks` payload — just records the operator's
        // approval) and an async one from the lifecycle subscriber
        // once the decomposer agent finishes (carries the actual
        // tasks). Marking the plan as processed on the first
        // empty event would silently drop the task-bearing second
        // event — the bug this test guards against.
        const empty: Event = {
            type: 'PlanDecomposed',
            v: 1,
            occurredAt: 1_700_000_000_000,
            idempotencyKey: 'DecomposePlan:plan-pending',
            payload: { planId: 'plan-pending', projectId: 'proj-A', actor: 'op-1' },
        };
        await bus.publish(empty);

        assert.equal(readTaskCreatedRows(store).length, 0);
        assert.equal(
            projection.hasProcessed('plan-pending'),
            false,
            'an empty PlanDecomposed must NOT mark the plan as processed — a later task-bearing event must still fold',
        );
    } finally {
        db.close();
    }
});

test('a no-tasks PlanDecomposed followed by a tasks-bearing one for the same plan emits TaskCreated rows', async () => {
    const { db, store, bus } = makeBus();
    try {
        new TaskProjectionStore(bus, fixedClock());

        // 1. Synchronous DecomposePlan handler — no tasks.
        await bus.publish({
            type: 'PlanDecomposed',
            v: 1,
            occurredAt: 1_700_000_000_000,
            idempotencyKey: 'DecomposePlan:plan-z',
            payload: { planId: 'plan-z', projectId: 'proj-A', actor: 'op-1' },
        });

        assert.equal(readTaskCreatedRows(store).length, 0);

        // 2. Agent-driven emit — carries the task list. This is the
        //    one that must actually fan out.
        await bus.publish(
            planDecomposed(
                'plan-z',
                [
                    { id: 't-1', title: 'one', type: 'implement', dependencies: [], description: 'x' },
                    { id: 't-2', title: 'two', type: 'scaffold', dependencies: ['t-1'], description: 'y' },
                ],
                'agent:PlanDecomposed:plan-z',
            ),
        );

        const rows = readTaskCreatedRows(store);
        assert.equal(rows.length, 2);
        const taskIds = rows
            .map((r) => (r.payload as ProjectedTaskCreatedPayload).taskId)
            .sort();
        assert.deepEqual(taskIds, ['t-1', 't-2']);
    } finally {
        db.close();
    }
});

test('PlanDecomposed for one planId does not interfere with another', async () => {
    const { db, store, bus } = makeBus();
    try {
        new TaskProjectionStore(bus, fixedClock());

        await bus.publish(
            planDecomposed(
                'plan-A',
                [{ id: 't-1', title: 'a', type: 'implement', dependencies: [], description: 'x' }],
                'DecomposePlan:plan-A',
            ),
        );
        await bus.publish(
            planDecomposed(
                'plan-B',
                [{ id: 't-1', title: 'b', type: 'implement', dependencies: [], description: 'y' }],
                'DecomposePlan:plan-B',
            ),
        );

        const rows = readTaskCreatedRows(store);
        assert.equal(rows.length, 2, 'both plans get their own TaskCreated');

        const keys = rows.map((r) => r.idempotencyKey).sort();
        assert.deepEqual(keys, [
            taskCreatedIdempotencyKey('plan-A', 't-1'),
            taskCreatedIdempotencyKey('plan-B', 't-1'),
        ]);
    } finally {
        db.close();
    }
});
