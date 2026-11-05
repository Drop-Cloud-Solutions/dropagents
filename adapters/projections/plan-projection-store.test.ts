/**
 * AP-FP-003 — unit tests for the plan-projection-store subscriber.
 *
 * Trait category: Unit. Every test in this file stands up an in-memory
 * SQLite handle, applies the core migrations + an inlined projection
 * `plans` table, and exercises the subscriber against a real
 * `EventBus` — no external services, no filesystem state, no spawned
 * processes. The harness is symmetric with
 * `project-projection-store.test.ts` so the two read together.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import {
    applyMigrations,
    openDatabase,
    type Db,
} from '../../core/state/migrations';
import { EventBus } from '../../core/events/bus';
import { EventStore } from '../../core/events/store';
import type { Event } from '../../core/events/event';
import type { Logger } from '../../core/ports/Logger';
import {
    PLAN_PROJECTION_EVENT_TYPES,
    PLAN_PROJECTION_SUBSCRIBER,
    PlanProjectionStore,
} from './plan-projection-store';

/**
 * Create the `sidebar_plans` projection table that backs the operator
 * sidebar's plan list. The production schema lives in
 * `core/state/migrations/006_sidebar_projections.sql`; mirroring it
 * inline here keeps the test harness narrow (no migration runner, no
 * other tables) and avoids any coupling with the v1 `plans` table
 * created by `001_initial.sql` — they coexist under different names
 * for exactly this reason.
 */
function installPlansProjectionTable(db: Db): void {
    db.exec(`
        CREATE TABLE IF NOT EXISTS sidebar_plans (
            plan_id     TEXT    NOT NULL,
            pid         TEXT    NOT NULL,
            name        TEXT,
            status      TEXT,
            archived_at INTEGER,
            updated_at  INTEGER,
            PRIMARY KEY (pid, plan_id)
        );
    `);
}

class SilentLogger implements Logger {
    info(): void {}
    warn(): void {}
    debug(): void {}
    error(): void {}
}

interface Harness {
    readonly db: Db;
    readonly store: EventStore;
    readonly bus: EventBus;
}

function makeHarness(): Harness {
    const db = openDatabase(':memory:');
    applyMigrations(db);
    installPlansProjectionTable(db);
    const store = new EventStore(db);
    const bus = new EventBus(store, new SilentLogger());
    return { db, store, bus };
}

interface PlanRow {
    readonly plan_id: string;
    readonly pid: string;
    readonly name: string | null;
    readonly archived_at: number | null;
    readonly updated_at: number | null;
}

function readPlan(db: Db, pid: string, planId: string): PlanRow | undefined {
    return db
        .prepare(
            'SELECT plan_id, pid, name, archived_at, updated_at FROM sidebar_plans WHERE pid = ? AND plan_id = ?',
        )
        .get(pid, planId) as PlanRow | undefined;
}

function countPlans(db: Db): number {
    const row = db
        .prepare('SELECT COUNT(*) AS c FROM sidebar_plans')
        .get() as { c: number };
    return row.c;
}

function planCreated(
    planId: string,
    projectId: string,
    title: string,
    occurredAt: number,
    idempotencyKey: string = `CreatePlan:${projectId}:${planId}`,
): Event {
    return {
        type: PLAN_PROJECTION_EVENT_TYPES.CREATED,
        v: 1,
        occurredAt,
        idempotencyKey,
        payload: { planId, projectId, title, actor: 'op-1' },
    };
}

function planUpdated(
    planId: string,
    title: string | undefined,
    occurredAt: number,
    idempotencyKey: string = `UpdatePlan:${planId}:${occurredAt}`,
): Event {
    return {
        type: PLAN_PROJECTION_EVENT_TYPES.UPDATED,
        v: 1,
        occurredAt,
        idempotencyKey,
        payload: { planId, title, actor: 'op-1' },
    };
}

function planArchived(
    planId: string,
    occurredAt: number,
    idempotencyKey: string = `ArchivePlan:${planId}`,
): Event {
    return {
        type: PLAN_PROJECTION_EVENT_TYPES.ARCHIVED,
        v: 1,
        occurredAt,
        idempotencyKey,
        payload: { planId },
    };
}

// ---------------------------------------------------------------------------
// AC #1, #2 — Created inserts a row keyed on (pid, plan_id)
// ---------------------------------------------------------------------------

test('[Unit] PlanCreated inserts a row keyed on (pid, plan_id)', async () => {
    // Arrange
    const { db, bus } = makeHarness();
    try {
        new PlanProjectionStore(db, bus);

        // Act
        await bus.publish(planCreated('plan-1', 'proj-1', 'Initial draft', 1000));

        // Assert
        const row = readPlan(db, 'proj-1', 'plan-1');
        assert.ok(row, 'plan row was inserted');
        assert.equal(row!.plan_id, 'plan-1');
        assert.equal(row!.pid, 'proj-1');
        assert.equal(row!.name, 'Initial draft');
        assert.equal(row!.archived_at, null);
        assert.equal(row!.updated_at, 1000);
    } finally {
        db.close();
    }
});

// ---------------------------------------------------------------------------
// AC #2 — Updated mutates the existing row in place
// ---------------------------------------------------------------------------

test('[Unit] PlanUpdated mutates the existing row in place', async () => {
    // Arrange
    const { db, bus } = makeHarness();
    try {
        new PlanProjectionStore(db, bus);
        await bus.publish(planCreated('plan-1', 'proj-1', 'Draft v1', 1000));

        // Act — newer event renames the plan
        await bus.publish(planUpdated('plan-1', 'Draft v2', 2000));

        // Assert
        const row = readPlan(db, 'proj-1', 'plan-1');
        assert.ok(row, 'plan row still exists');
        assert.equal(row!.name, 'Draft v2');
        assert.equal(row!.updated_at, 2000);
        assert.equal(row!.archived_at, null);
        assert.equal(countPlans(db), 1, 'no duplicate row from update');
    } finally {
        db.close();
    }
});

test('[Unit] PlanUpdated without a title preserves the existing name', async () => {
    // Arrange — board-ui's UpdatePlanPayload makes `title` optional;
    // when the operator edits only the body the projection must not
    // overwrite the stored name with NULL.
    const { db, bus } = makeHarness();
    try {
        new PlanProjectionStore(db, bus);
        await bus.publish(planCreated('plan-1', 'proj-1', 'Draft v1', 1000));

        // Act
        await bus.publish(planUpdated('plan-1', undefined, 2000));

        // Assert
        const row = readPlan(db, 'proj-1', 'plan-1');
        assert.equal(row!.name, 'Draft v1', 'name preserved when not in payload');
        assert.equal(row!.updated_at, 2000);
    } finally {
        db.close();
    }
});

// ---------------------------------------------------------------------------
// AC #4 — Archived path sets archived_at without deleting the row
// ---------------------------------------------------------------------------

test('[Unit] PlanArchived stamps archived_at and leaves the row intact (soft delete)', async () => {
    // Arrange
    const { db, bus } = makeHarness();
    try {
        new PlanProjectionStore(db, bus);
        await bus.publish(planCreated('plan-1', 'proj-1', 'Draft v1', 1000));

        // Act
        await bus.publish(planArchived('plan-1', 3000));

        // Assert
        const row = readPlan(db, 'proj-1', 'plan-1');
        assert.ok(row, 'row is NOT hard-deleted');
        assert.equal(row!.archived_at, 3000, 'archived_at equals event.occurredAt');
        assert.equal(row!.name, 'Draft v1', 'unrelated columns are unchanged');
        assert.equal(countPlans(db), 1);
    } finally {
        db.close();
    }
});

test('[Unit] PlanUnarchived clears archived_at so the plan re-enters active views', async () => {
    const { db, bus } = makeHarness();
    try {
        new PlanProjectionStore(db, bus);
        await bus.publish(planCreated('plan-1', 'proj-1', 'Draft v1', 1000));
        await bus.publish(planArchived('plan-1', 3000));

        await bus.publish({
            type: PLAN_PROJECTION_EVENT_TYPES.UNARCHIVED,
            v: 1,
            occurredAt: 5000,
            idempotencyKey: 'UnarchivePlan:plan-1',
            payload: { planId: 'plan-1' },
        });

        const row = readPlan(db, 'proj-1', 'plan-1');
        assert.ok(row);
        assert.equal(row!.archived_at, null, 'archived_at cleared');
        assert.equal(row!.updated_at, 5000);
        assert.equal(row!.name, 'Draft v1', 'unrelated columns unchanged');
    } finally {
        db.close();
    }
});

// ---------------------------------------------------------------------------
// AC #5 — re-applying the same event is a no-op (idempotency)
// ---------------------------------------------------------------------------

test('[Unit] republishing the same PlanCreated is a no-op (idempotent replay)', async () => {
    // Arrange
    const { db, bus } = makeHarness();
    try {
        new PlanProjectionStore(db, bus);
        const event = planCreated('plan-1', 'proj-1', 'Draft v1', 1000);

        // Act — same idempotency key, fired twice
        await bus.publish(event);
        await bus.publish(event);

        // Assert: a single row, with updated_at unchanged.
        assert.equal(countPlans(db), 1, 'no duplicate row from replay');
        const row = readPlan(db, 'proj-1', 'plan-1');
        assert.equal(
            row!.updated_at,
            1000,
            'updated_at does not move on replay of the same event',
        );
    } finally {
        db.close();
    }
});

test('[Unit] a stale PlanUpdated never moves updated_at backwards', async () => {
    // Arrange — newer event lands first; an older replay must not
    // overwrite the fresher state.
    const { db, bus } = makeHarness();
    try {
        new PlanProjectionStore(db, bus);
        await bus.publish(planCreated('plan-1', 'proj-1', 'Draft v1', 2000));

        // Act — same planId, OLDER occurredAt, different idempotencyKey
        await bus.publish(
            planUpdated('plan-1', 'Stale Title', 1500, 'UpdatePlan:plan-1:stale'),
        );

        // Assert
        const row = readPlan(db, 'proj-1', 'plan-1');
        assert.equal(row!.name, 'Draft v1', 'newer name retained');
        assert.equal(row!.updated_at, 2000, 'updated_at did not move backwards');
    } finally {
        db.close();
    }
});

test('[Unit] replaying PlanArchived does not move archived_at backwards', async () => {
    // Arrange
    const { db, bus } = makeHarness();
    try {
        new PlanProjectionStore(db, bus);
        await bus.publish(planCreated('plan-1', 'proj-1', 'Draft v1', 1000));
        await bus.publish(planArchived('plan-1', 3000));

        // Act — replay the same archive event (same idempotency key)
        await bus.publish(planArchived('plan-1', 3000));

        // Assert
        const row = readPlan(db, 'proj-1', 'plan-1');
        assert.equal(row!.archived_at, 3000);
        assert.equal(row!.updated_at, 3000);
        assert.equal(countPlans(db), 1);
    } finally {
        db.close();
    }
});

// ---------------------------------------------------------------------------
// AC #3 — composite key isolates plans that share a plan_id across pids
// ---------------------------------------------------------------------------

test('[Unit] two plans with the same plan_id under different pids are independent rows', async () => {
    // Arrange — both events use plan_id "plan-X" but with different
    // projectIds. The composite (pid, plan_id) PK must place them in
    // separate rows so the sidebar can render them under each project.
    const { db, bus } = makeHarness();
    try {
        new PlanProjectionStore(db, bus);

        // Act
        await bus.publish(
            planCreated(
                'plan-X',
                'proj-A',
                'Plan in A',
                1000,
                'CreatePlan:proj-A:plan-X',
            ),
        );
        await bus.publish(
            planCreated(
                'plan-X',
                'proj-B',
                'Plan in B',
                1000,
                'CreatePlan:proj-B:plan-X',
            ),
        );

        // Assert
        assert.equal(countPlans(db), 2, 'composite PK kept both rows');
        const rowA = readPlan(db, 'proj-A', 'plan-X');
        const rowB = readPlan(db, 'proj-B', 'plan-X');
        assert.ok(rowA, 'row under proj-A exists');
        assert.ok(rowB, 'row under proj-B exists');
        assert.equal(rowA!.name, 'Plan in A');
        assert.equal(rowB!.name, 'Plan in B');
        assert.equal(rowA!.pid, 'proj-A');
        assert.equal(rowB!.pid, 'proj-B');
    } finally {
        db.close();
    }
});

test('[Unit] updates to one of two same-pid plans do not bleed into the other', async () => {
    // Arrange — two plans with DIFFERENT plan_ids under the SAME pid.
    // Exercising the per-row isolation guarantee from the other angle:
    // an event targeting plan-1 must not perturb plan-2's row.
    const { db, bus } = makeHarness();
    try {
        new PlanProjectionStore(db, bus);
        await bus.publish(planCreated('plan-1', 'proj-1', 'Plan one', 1000));
        await bus.publish(planCreated('plan-2', 'proj-1', 'Plan two', 1000));

        // Act — rename plan-1 only
        await bus.publish(planUpdated('plan-1', 'Plan one v2', 2000));

        // Assert
        const row1 = readPlan(db, 'proj-1', 'plan-1');
        const row2 = readPlan(db, 'proj-1', 'plan-2');
        assert.equal(row1!.name, 'Plan one v2', 'targeted plan was updated');
        assert.equal(row1!.updated_at, 2000);
        assert.equal(row2!.name, 'Plan two', 'sibling plan was untouched');
        assert.equal(row2!.updated_at, 1000, 'sibling updated_at unchanged');
    } finally {
        db.close();
    }
});

// ---------------------------------------------------------------------------
// P-CPTO-007 — getApprovedContent read-side lookup (backs PlanContentReader)
// ---------------------------------------------------------------------------

test('[Unit] getApprovedContent returns the stored body and null for unknown plans', async () => {
    const { db, bus } = makeHarness();
    try {
        const store = new PlanProjectionStore(db, bus);
        // PlanCreated carries the plan body onto the projection row.
        await bus.publish({
            type: PLAN_PROJECTION_EVENT_TYPES.CREATED,
            v: 1,
            occurredAt: 1000,
            idempotencyKey: 'CreatePlan:proj-1:plan-1',
            payload: {
                planId: 'plan-1',
                projectId: 'proj-1',
                title: 'Draft',
                body: '# Approved body',
                actor: 'op-1',
            },
        });

        assert.equal(store.getApprovedContent('plan-1'), '# Approved body');
        assert.equal(store.getApprovedContent('missing'), null, 'unknown plan → null');
    } finally {
        db.close();
    }
});

test('[Unit] getApprovedContent treats an empty stored body as null', async () => {
    const { db, bus } = makeHarness();
    try {
        const store = new PlanProjectionStore(db, bus);
        await bus.publish({
            type: PLAN_PROJECTION_EVENT_TYPES.CREATED,
            v: 1,
            occurredAt: 1000,
            idempotencyKey: 'CreatePlan:proj-1:plan-empty',
            payload: { planId: 'plan-empty', projectId: 'proj-1', title: 'No body', actor: 'op-1' },
        });

        // No body was supplied, so the column is NULL — the reader reports
        // "no content" rather than handing back an empty string.
        assert.equal(store.getApprovedContent('plan-empty'), null);
    } finally {
        db.close();
    }
});

// ---------------------------------------------------------------------------
// AC #6 — subscriber registers against the event bus on construction
// ---------------------------------------------------------------------------

test('[Unit] constructor registers the subscriber against all three event types', async () => {
    // Arrange — persist events directly through the EventStore BEFORE
    // wiring the projection. With no subscribers attached the bus
    // delivers nothing live; replayMissed should then drive the events
    // through the constructor-registered handlers.
    const { db, store, bus } = makeHarness();
    try {
        store.append(planCreated('plan-1', 'proj-1', 'Draft v1', 1000));
        store.append(planUpdated('plan-1', 'Draft v2', 2000));
        store.append(planArchived('plan-1', 3000));

        // Act — construct the projection AFTER the events are
        // persisted, then replay.
        new PlanProjectionStore(db, bus);
        await bus.replayMissed(PLAN_PROJECTION_SUBSCRIBER);

        // Assert: all three event handlers ran in order against the
        // projection's SQLite handle.
        const row = readPlan(db, 'proj-1', 'plan-1');
        assert.ok(row, 'replay delivered events to constructor-registered handlers');
        assert.equal(row!.name, 'Draft v2');
        assert.equal(row!.archived_at, 3000);
        assert.equal(row!.updated_at, 3000);
    } finally {
        db.close();
    }
});
