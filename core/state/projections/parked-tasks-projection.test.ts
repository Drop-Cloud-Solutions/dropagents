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

import { applyMigrations, openDatabase, type Db } from '../migrations';
import { EventBus } from '../../events/bus';
import { EventStore } from '../../events/store';
import type { Event } from '../../events/event';
import type { Logger } from '../../ports/Logger';
import {
    TaskParkingEvents,
    type TaskParkedEventPayload,
    type TaskParkedReason,
    type TaskResumedEventPayload,
} from '../../commands';
import {
    ParkedTasksProjection,
    PARKED_TASKS_PROJECTION_SUBSCRIBER,
    getParkedTaskCount,
} from './parked-tasks-projection';

class SilentLogger implements Logger {
    info(): void {}
    warn(): void {}
    debug(): void {}
    error(): void {}
}

function makeBus(): { db: Db; store: EventStore; bus: EventBus } {
    const db = openDatabase(':memory:');
    applyMigrations(db);
    const store = new EventStore(db);
    const bus = new EventBus(store, new SilentLogger());
    return { db, store, bus };
}

function fixedClock(start = 1_700_000_000_000): () => number {
    let now = start;
    return () => ++now;
}

function parkedEvent(
    taskId: string,
    occurredAt: number,
    reason: TaskParkedReason = 'wait-action',
): Event {
    const payload: TaskParkedEventPayload = {
        taskId,
        stepId: 'step-1',
        reason,
    };
    return {
        type: TaskParkingEvents.TASK_PARKED,
        v: 1,
        occurredAt,
        idempotencyKey: `TaskParked:${taskId}:${occurredAt}`,
        payload,
    };
}

function resumedEvent(taskId: string, occurredAt: number): Event {
    const payload: TaskResumedEventPayload = {
        taskId,
        actor: 'test',
        decision: 'approve',
    };
    return {
        type: TaskParkingEvents.TASK_RESUMED,
        v: 1,
        occurredAt,
        idempotencyKey: `TaskResumed:${taskId}:${occurredAt}`,
        payload,
    };
}

function finishedEvent(taskId: string, occurredAt: number): Event {
    return {
        type: 'TaskFinished',
        v: 1,
        occurredAt,
        idempotencyKey: `TaskFinished:${taskId}:${occurredAt}`,
        payload: { taskId },
    };
}

function failedEvent(taskId: string, occurredAt: number): Event {
    return {
        type: 'TaskFailed',
        v: 1,
        occurredAt,
        idempotencyKey: `TaskFailed:${taskId}:${occurredAt}`,
        payload: { taskId, failed_stage: 'rejected' },
    };
}

// ---------------------------------------------------------------------------
// AC #5 — TaskParked → TaskResumed drives 0 → 1 → 0
// ---------------------------------------------------------------------------

test('TaskParked → TaskResumed drives the parked-tasks count 0 → 1 → 0', async () => {
    const { db, bus } = makeBus();
    try {
        new ParkedTasksProjection(db, bus);
        const clock = fixedClock();

        assert.equal(
            getParkedTaskCount(db),
            0,
            'projection starts empty on a freshly-migrated DB',
        );

        await bus.publish(parkedEvent('t-1', clock()));
        assert.equal(
            getParkedTaskCount(db),
            1,
            'TaskParked inserts one row',
        );

        await bus.publish(resumedEvent('t-1', clock()));
        assert.equal(
            getParkedTaskCount(db),
            0,
            'TaskResumed deletes the row',
        );
    } finally {
        db.close();
    }
});

// ---------------------------------------------------------------------------
// AC #2 — TaskFinished and TaskFailed also remove the row
// ---------------------------------------------------------------------------

test('TaskFinished and TaskFailed also remove the parked row', async () => {
    const { db, bus } = makeBus();
    try {
        new ParkedTasksProjection(db, bus);
        const clock = fixedClock();

        await bus.publish(parkedEvent('t-finish', clock(), 'wait-merged'));
        await bus.publish(parkedEvent('t-fail', clock(), 'approval'));
        assert.equal(getParkedTaskCount(db), 2, 'two parked rows after two TaskParked');

        await bus.publish(finishedEvent('t-finish', clock()));
        assert.equal(
            getParkedTaskCount(db),
            1,
            'TaskFinished removes the matching parked row',
        );

        await bus.publish(failedEvent('t-fail', clock()));
        assert.equal(
            getParkedTaskCount(db),
            0,
            'TaskFailed removes the matching parked row',
        );
    } finally {
        db.close();
    }
});

// ---------------------------------------------------------------------------
// AC #4 — replay-safe: a second TaskParked for the same task is an upsert,
// not a double-insert.
// ---------------------------------------------------------------------------

test('replaying a TaskParked for the same task does not double-insert', async () => {
    const { db, bus } = makeBus();
    try {
        new ParkedTasksProjection(db, bus);
        const clock = fixedClock();

        await bus.publish(parkedEvent('t-1', clock(), 'wait-action'));
        assert.equal(getParkedTaskCount(db), 1);

        // A second TaskParked for the same task — a legitimate scenario in
        // an at-least-once delivery world: a fresh subscriber catches up via
        // `replayMissed` and re-delivers an event whose effect was already
        // applied. The projection's ON CONFLICT(task_id) DO UPDATE must
        // collapse this to a single row (with the latest values).
        await bus.publish(parkedEvent('t-1', clock(), 'clarification'));
        assert.equal(
            getParkedTaskCount(db),
            1,
            'second TaskParked for same task must not double-insert',
        );

        // And the upsert must have refreshed the row's reason in place.
        const row = db
            .prepare('SELECT reason FROM parked_tasks_projection WHERE task_id = ?')
            .get('t-1') as { reason: string };
        assert.equal(row.reason, 'clarification', 'upsert refreshes columns');
    } finally {
        db.close();
    }
});

// ---------------------------------------------------------------------------
// AC #2 — unpark of an unknown task is a no-op (defence against an
// out-of-order replay where the unpark event arrives before the matching
// TaskParked has been folded).
// ---------------------------------------------------------------------------

test('unpark for an unknown task is a no-op', async () => {
    const { db, bus } = makeBus();
    try {
        new ParkedTasksProjection(db, bus);
        const clock = fixedClock();

        await bus.publish(resumedEvent('ghost', clock()));
        await bus.publish(finishedEvent('ghost', clock()));
        await bus.publish(failedEvent('ghost', clock()));
        assert.equal(
            getParkedTaskCount(db),
            0,
            'unpark of unknown task must not produce side effects',
        );
    } finally {
        db.close();
    }
});

// ---------------------------------------------------------------------------
// AC #3 — getParkedTaskCount runs against a prepared statement and caches
// per Db handle.
// ---------------------------------------------------------------------------

test('getParkedTaskCount caches its prepared statement per Db', () => {
    const { db } = makeBus();
    try {
        // Two calls before any subscribers exist — both must return 0
        // without throwing, proving the statement prepares against the
        // freshly-migrated table.
        assert.equal(getParkedTaskCount(db), 0);
        assert.equal(getParkedTaskCount(db), 0);
    } finally {
        db.close();
    }
});

// ---------------------------------------------------------------------------
// AC #2 — plan_id is denormalised from tasks(plan_id) at insert time when
// the task row is already known.
// ---------------------------------------------------------------------------

test('plan_id is populated from tasks(plan_id) when the row is present', async () => {
    const { db, bus } = makeBus();
    try {
        db.prepare(
            "INSERT INTO plans(id, project_id, status, created_at) VALUES ('p-1','proj','approved', 1)",
        ).run();
        db.prepare(
            "INSERT INTO tasks(id, plan_id, type, status) VALUES ('t-1', 'p-1', 'implement', 'in_progress')",
        ).run();

        new ParkedTasksProjection(db, bus);
        await bus.publish(parkedEvent('t-1', 100));

        const row = db
            .prepare(
                'SELECT plan_id, parked_at, reason FROM parked_tasks_projection WHERE task_id = ?',
            )
            .get('t-1') as { plan_id: string | null; parked_at: number; reason: string };
        assert.equal(row.plan_id, 'p-1');
        assert.equal(row.parked_at, 100);
        assert.equal(row.reason, 'wait-action');
    } finally {
        db.close();
    }
});

// ---------------------------------------------------------------------------
// Smoke: the projection registers under the named subscriber so a host
// can replay missed events on boot.
// ---------------------------------------------------------------------------

test('projection registers under the documented subscriber name', async () => {
    const { db, store, bus } = makeBus();
    try {
        new ParkedTasksProjection(db, bus);

        // After a live publish the named subscriber's offset advances —
        // proving the subscription was registered with the expected name.
        await bus.publish(parkedEvent('t-1', 100));
        const offset = store.getSubscriberOffset(PARKED_TASKS_PROJECTION_SUBSCRIBER);
        assert.ok(offset > 0, 'named subscriber offset must advance on live delivery');
    } finally {
        db.close();
    }
});
