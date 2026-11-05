/**
 * Unit tests for the SQLite-backed plan-review projection.
 *
 * Trait category: Unit. Every test stands up an in-memory SQLite handle,
 * applies the core migrations (which include
 * `010_plan_review_projection.sql`), and drives the store through its
 * `fold(event)` seam — no EventBus, no spawned processes, no network.
 * Tests that need to verify the bus subscription wiring stand one up
 * explicitly so the assertion stays close to the behaviour.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { EventBus } from '../../core/events/bus';
import type { PlanDecomposed, PlanGenerated } from '../../core/events/event';
import { EventStore } from '../../core/events/store';
import type { Logger } from '../../core/ports/Logger';
import {
    applyMigrations,
    openDatabase,
    type Db,
} from '../../core/state/migrations';
import {
    PLAN_REVIEW_EVENT_TYPES,
    PLAN_REVIEW_PROJECTION_SUBSCRIBER,
    PlanReviewStore,
} from './plan-review-store';

class SilentLogger implements Logger {
    info(): void {}
    warn(): void {}
    debug(): void {}
    error(): void {}
}

function makeDb(): Db {
    const db = openDatabase(':memory:');
    applyMigrations(db);
    return db;
}

function makeStore(): { db: Db; store: PlanReviewStore } {
    const db = makeDb();
    const store = new PlanReviewStore(db);
    return { db, store };
}

function makePlanGenerated(
    planId: string,
    revision: number | undefined,
    options: {
        readonly content?: string;
        readonly feedback?: string;
        readonly occurredAt?: number;
        readonly previousRevision?: number;
        readonly idempotencyKey?: string;
        readonly projectId?: string;
    } = {},
): PlanGenerated {
    return {
        type: PLAN_REVIEW_EVENT_TYPES.GENERATED,
        v: 1,
        occurredAt: options.occurredAt ?? 0,
        idempotencyKey:
            options.idempotencyKey ?? `${planId}:${revision ?? 'init'}`,
        payload: {
            planId,
            revision,
            content: options.content,
            feedback: options.feedback,
            previousRevision: options.previousRevision,
            ...(options.projectId !== undefined ? { projectId: options.projectId } : {}),
        },
    };
}

/**
 * `tasks` defaults to a single stub entry so the helper builds the
 * agent-driven `PlanDecomposed` shape — the one that actually means
 * "the decomposer ran and produced tasks". Pass an empty array
 * explicitly to model the synchronous DecomposePlan-command emission
 * (no tasks payload) used to test the projection's guard against
 * prematurely retiring a plan on the operator's Approve click.
 */
function makePlanDecomposed(
    planId: string,
    options: {
        readonly occurredAt?: number;
        readonly idempotencyKey?: string;
        readonly tasks?: ReadonlyArray<Record<string, unknown>>;
    } = {},
): PlanDecomposed {
    const tasks
        = options.tasks
            ?? [
                { id: 'task-1', title: 'stub', type: 'implement', dependencies: [], description: 'x' },
            ];
    return {
        type: PLAN_REVIEW_EVENT_TYPES.DECOMPOSED,
        v: 1,
        occurredAt: options.occurredAt ?? 0,
        idempotencyKey: options.idempotencyKey ?? `dec:${planId}`,
        payload: { planId, tasks } as unknown as PlanDecomposed['payload'],
    };
}

test('fold appends a single revision for a fresh plan', () => {
    const { store } = makeStore();
    store.fold(
        makePlanGenerated('plan-1', 1, { content: '# v1', occurredAt: 100 }),
    );
    const latest = store.getLatest('plan-1');
    assert.equal(latest?.revision, 1);
    assert.equal(latest?.content, '# v1');
    assert.equal(latest?.generatedAt, 100);
    assert.equal(latest?.feedback, undefined);
});

test('multiple revisions for one plan produce an ordered history', () => {
    const { store } = makeStore();
    store.fold(makePlanGenerated('plan-1', 1, { content: 'v1', occurredAt: 10 }));
    store.fold(
        makePlanGenerated('plan-1', 2, {
            content: 'v2',
            feedback: 'tighten scope',
            occurredAt: 20,
            previousRevision: 1,
        }),
    );
    store.fold(
        makePlanGenerated('plan-1', 3, {
            content: 'v3',
            feedback: 'split task A',
            occurredAt: 30,
            previousRevision: 2,
        }),
    );

    const all = store.listRevisions('plan-1');
    assert.equal(all.length, 3);
    assert.deepEqual(
        all.map((r) => r.revision),
        [1, 2, 3],
    );
    assert.equal(all[1].feedback, 'tighten scope');
});

test('getLatest returns the row with the highest revision even when events arrive out of order', () => {
    const { store } = makeStore();
    store.fold(makePlanGenerated('plan-1', 1, { content: 'v1', occurredAt: 10 }));
    store.fold(makePlanGenerated('plan-1', 3, { content: 'v3', occurredAt: 30 }));
    store.fold(makePlanGenerated('plan-1', 2, { content: 'v2', occurredAt: 20 }));

    const latest = store.getLatest('plan-1');
    assert.equal(latest?.revision, 3);
    assert.equal(latest?.content, 'v3');
});

test('getLatestNonEmpty skips empty dispatch-time revisions left by failed runs', () => {
    const { store } = makeStore();
    store.fold(makePlanGenerated('plan-1', 1, { content: '', occurredAt: 10 }));
    store.fold(makePlanGenerated('plan-1', 2, { content: 'v2 plan body', occurredAt: 20 }));
    // Revisions 3-4: dispatched but the agent died before producing
    // output — the rows keep their dispatch-time empty content.
    store.fold(makePlanGenerated('plan-1', 3, { content: '', occurredAt: 30 }));
    store.fold(makePlanGenerated('plan-1', 4, { content: '', occurredAt: 40 }));

    assert.equal(store.getLatest('plan-1')?.revision, 4);
    const nonEmpty = store.getLatestNonEmpty('plan-1');
    assert.equal(nonEmpty?.revision, 2);
    assert.equal(nonEmpty?.content, 'v2 plan body');
});

test('getLatestNonEmpty returns null when every revision is empty', () => {
    const { store } = makeStore();
    store.fold(makePlanGenerated('plan-1', 1, { content: '', occurredAt: 10 }));
    assert.equal(store.getLatestNonEmpty('plan-1'), null);
    assert.equal(store.getLatestNonEmpty('plan-unknown'), null);
});

test('getRevision returns the exact match by revision number', () => {
    const { store } = makeStore();
    store.fold(makePlanGenerated('plan-1', 1, { content: 'v1', occurredAt: 10 }));
    store.fold(makePlanGenerated('plan-1', 2, { content: 'v2', occurredAt: 20 }));

    assert.equal(store.getRevision('plan-1', 1)?.content, 'v1');
    assert.equal(store.getRevision('plan-1', 2)?.content, 'v2');
});

test('listRevisions returns chronological (revision-ascending) order', () => {
    const { store } = makeStore();
    store.fold(makePlanGenerated('plan-1', 3, { content: 'v3', occurredAt: 30 }));
    store.fold(makePlanGenerated('plan-1', 1, { content: 'v1', occurredAt: 10 }));
    store.fold(makePlanGenerated('plan-1', 2, { content: 'v2', occurredAt: 20 }));

    const all = store.listRevisions('plan-1');
    assert.deepEqual(
        all.map((r) => r.revision),
        [1, 2, 3],
    );
});

test('fold is idempotent — replaying the same event leaves state unchanged', () => {
    const { store } = makeStore();
    const event = makePlanGenerated('plan-1', 1, { content: 'v1', occurredAt: 10 });
    store.fold(event);
    const before = store.listRevisions('plan-1');
    store.fold(event);
    store.fold(event);
    const after = store.listRevisions('plan-1');
    assert.deepEqual(after, before);
    assert.equal(after.length, 1);
});

test('a strictly newer event with the same (planId, revision) overwrites the prior row', () => {
    const { store } = makeStore();
    store.fold(makePlanGenerated('plan-1', 1, { content: 'draft', occurredAt: 10 }));
    store.fold(
        makePlanGenerated('plan-1', 1, { content: 'corrected', occurredAt: 11 }),
    );
    assert.equal(store.listRevisions('plan-1').length, 1);
    assert.equal(store.getRevision('plan-1', 1)?.content, 'corrected');
    assert.equal(store.getRevision('plan-1', 1)?.generatedAt, 11);
});

test('a strictly older event with the same (planId, revision) is a no-op', () => {
    const { store } = makeStore();
    store.fold(makePlanGenerated('plan-1', 1, { content: 'current', occurredAt: 20 }));
    store.fold(makePlanGenerated('plan-1', 1, { content: 'stale', occurredAt: 5 }));
    assert.equal(store.getRevision('plan-1', 1)?.content, 'current');
    assert.equal(store.getRevision('plan-1', 1)?.generatedAt, 20);
});

test('plans are isolated — folding into plan A does not affect plan B', () => {
    const { store } = makeStore();
    store.fold(makePlanGenerated('plan-A', 1, { content: 'A1', occurredAt: 10 }));
    store.fold(makePlanGenerated('plan-B', 1, { content: 'B1', occurredAt: 20 }));
    store.fold(makePlanGenerated('plan-B', 2, { content: 'B2', occurredAt: 30 }));

    assert.equal(store.listRevisions('plan-A').length, 1);
    assert.equal(store.listRevisions('plan-B').length, 2);
    assert.equal(store.getLatest('plan-A')?.content, 'A1');
    assert.equal(store.getLatest('plan-B')?.content, 'B2');
});

test('missing-plan lookups return null / empty without throwing', () => {
    const { store } = makeStore();
    assert.equal(store.getLatest('nope'), null);
    assert.equal(store.getRevision('nope', 1), null);
    assert.deepEqual(store.listRevisions('nope'), []);
});

test('getRevision on a known plan but unknown revision returns null', () => {
    const { store } = makeStore();
    store.fold(makePlanGenerated('plan-1', 1, { content: 'v1', occurredAt: 10 }));
    assert.equal(store.getRevision('plan-1', 99), null);
});

test('legacy PlanGenerated events without a revision field are treated as revision 1', () => {
    const { store } = makeStore();
    const legacy: PlanGenerated = {
        type: PLAN_REVIEW_EVENT_TYPES.GENERATED,
        v: 1,
        occurredAt: 100,
        idempotencyKey: 'legacy',
        payload: { planId: 'plan-legacy', projectId: 'proj', briefId: 'b', actor: 'op' },
    };
    store.fold(legacy);
    const latest = store.getLatest('plan-legacy');
    assert.equal(latest?.revision, 1);
    assert.equal(latest?.content, '');
});

test('captures projectId from PlanGenerated payload', () => {
    const { store } = makeStore();
    store.fold(
        makePlanGenerated('plan-1', 1, {
            content: 'v1',
            occurredAt: 10,
            projectId: 'proj-A',
        }),
    );
    assert.equal(store.getLatest('plan-1')?.projectId, 'proj-A');
});

test('a later replay that omits projectId preserves the stored one', () => {
    const { store } = makeStore();
    store.fold(
        makePlanGenerated('plan-1', 1, {
            content: 'v1',
            occurredAt: 10,
            projectId: 'proj-A',
        }),
    );
    // Same revision arrives later without projectId (simulates an
    // old-shape replay landing on top of a new-shape row).
    store.fold(
        makePlanGenerated('plan-1', 1, {
            content: 'v1-corrected',
            occurredAt: 20,
        }),
    );
    assert.equal(store.getRevision('plan-1', 1)?.content, 'v1-corrected');
    assert.equal(store.getRevision('plan-1', 1)?.projectId, 'proj-A');
});

test('listPending excludes plans whose only revision is empty (failed planner run)', () => {
    // Field case: GeneratePlan emits a synchronous EMPTY PlanGenerated at
    // dispatch time; the agent then failed on auth. The empty placeholder
    // must not surface as a pending review — the board classified the
    // plan Ready with no content.
    const { store } = makeStore();
    store.fold(
        makePlanGenerated('plan-fail', 1, {
            content: '',
            occurredAt: 10,
            projectId: 'proj-A',
        }),
    );
    assert.equal(store.listPending().length, 0);
});

test('listPending falls back to the latest NON-empty revision when the newest is empty', () => {
    // Good r1, then a regenerate whose dispatch row (r2, empty) landed but
    // the agent failed: the plan still HAS a reviewable draft — r1.
    const { store } = makeStore();
    store.fold(
        makePlanGenerated('plan-regen', 1, {
            content: 'the good draft',
            occurredAt: 10,
            projectId: 'proj-A',
        }),
    );
    store.fold(
        makePlanGenerated('plan-regen', 2, {
            content: '',
            occurredAt: 20,
            projectId: 'proj-A',
        }),
    );
    const pending = store.listPending();
    assert.equal(pending.length, 1);
    assert.equal(pending[0]?.revision, 1);
    assert.equal(pending[0]?.content, 'the good draft');
});

test('PlanDecomposed flips isDecomposed and removes the plan from listPending', () => {
    const { store } = makeStore();
    store.fold(
        makePlanGenerated('plan-1', 1, {
            content: 'v1',
            occurredAt: 10,
            projectId: 'proj-A',
        }),
    );
    assert.equal(store.isDecomposed('plan-1'), false);
    assert.equal(store.listPending().length, 1);

    store.fold(makePlanDecomposed('plan-1', { occurredAt: 20 }));
    assert.equal(store.isDecomposed('plan-1'), true);
    assert.equal(store.listPending().length, 0);
});

test('a fresh PlanGenerated clears the decomposed flag so the card resurfaces', () => {
    const { store } = makeStore();
    store.fold(
        makePlanGenerated('plan-1', 1, {
            content: 'v1',
            occurredAt: 10,
            projectId: 'proj-A',
        }),
    );
    // First decompose runs to completion — plan retires.
    store.fold(makePlanDecomposed('plan-1', { occurredAt: 20 }));
    assert.equal(store.isDecomposed('plan-1'), true);
    assert.equal(store.listPending().length, 0);

    // Operator (or a Regenerate) produces a new revision. The
    // projection should treat that as "start over" — clear the
    // decomposed mark so the active-planner card comes back for the
    // new draft.
    store.fold(
        makePlanGenerated('plan-1', 2, {
            content: 'v2 — operator changed their mind',
            occurredAt: 30,
            projectId: 'proj-A',
        }),
    );
    assert.equal(store.isDecomposed('plan-1'), false);
    assert.equal(store.listPending().length, 1);
    assert.equal(store.listPending()[0].revision, 2);
});

test('a PlanDecomposed with no tasks does NOT mark the plan as decomposed', () => {
    const { store } = makeStore();
    store.fold(
        makePlanGenerated('plan-1', 1, {
            content: 'v1',
            occurredAt: 10,
            projectId: 'proj-A',
        }),
    );
    // Synchronous DecomposePlan-command emission — no tasks. The
    // operator just clicked Approve; the decomposer agent hasn't run
    // yet. The active-planner card must stay visible until the agent
    // produces actual tasks (or the operator discards the plan).
    store.fold(makePlanDecomposed('plan-1', { occurredAt: 20, tasks: [] }));
    assert.equal(store.isDecomposed('plan-1'), false);
    assert.equal(store.listPending().length, 1);

    // Now the agent-driven emit with the real task list — this is the
    // event that should retire the card.
    store.fold(
        makePlanDecomposed('plan-1', {
            occurredAt: 30,
            idempotencyKey: 'agent:dec:plan-1',
        }),
    );
    assert.equal(store.isDecomposed('plan-1'), true);
    assert.equal(store.listPending().length, 0);
});

test('isDecomposed is monotonic — replay of PlanDecomposed is a no-op', () => {
    const { store } = makeStore();
    store.fold(
        makePlanGenerated('plan-1', 1, {
            content: 'v1',
            occurredAt: 10,
            projectId: 'proj-A',
        }),
    );
    store.fold(makePlanDecomposed('plan-1', { occurredAt: 20 }));
    store.fold(makePlanDecomposed('plan-1', { occurredAt: 30 }));
    assert.equal(store.isDecomposed('plan-1'), true);
});

test('listPending omits plans without a projectId (the board cannot render those)', () => {
    const { store } = makeStore();
    store.fold(makePlanGenerated('plan-1', 1, { content: 'v1', occurredAt: 10 }));
    assert.equal(store.listPending().length, 0);
});

test('listPending returns one entry per plan with the latest revision content', () => {
    const { store } = makeStore();
    store.fold(
        makePlanGenerated('plan-1', 1, {
            content: 'v1',
            occurredAt: 10,
            projectId: 'proj-A',
        }),
    );
    store.fold(
        makePlanGenerated('plan-1', 2, {
            content: 'v2',
            occurredAt: 20,
            projectId: 'proj-A',
        }),
    );
    store.fold(
        makePlanGenerated('plan-2', 1, {
            content: 'p2v1',
            occurredAt: 30,
            projectId: 'proj-B',
        }),
    );
    const pending = store.listPending();
    assert.equal(pending.length, 2);
    const byPlanId = new Map(pending.map((p) => [p.planId, p]));
    assert.equal(byPlanId.get('plan-1')?.revision, 2);
    assert.equal(byPlanId.get('plan-1')?.content, 'v2');
    assert.equal(byPlanId.get('plan-2')?.revision, 1);
    assert.equal(byPlanId.get('plan-2')?.content, 'p2v1');
});

test('non-PlanGenerated/PlanDecomposed events are ignored', () => {
    const { store } = makeStore();
    const other = {
        type: 'TaskCreated',
        v: 1,
        occurredAt: 100,
        idempotencyKey: 'tc',
        payload: { taskId: 't', planId: 'plan-1' },
    } as const;
    const result = store.fold(other as unknown as PlanGenerated);
    assert.equal(result, null);
    assert.equal(store.getLatest('plan-1'), null);
});

test('listRevisions returns a defensive copy — caller mutations do not leak', () => {
    const { store } = makeStore();
    store.fold(makePlanGenerated('plan-1', 1, { content: 'v1', occurredAt: 10 }));
    const snapshot = store.listRevisions('plan-1') as unknown as unknown[];
    snapshot.length = 0;
    assert.equal(store.listRevisions('plan-1').length, 1);
});

test('PlanDeleted removes all draft revisions and the decomposed flag for the plan', () => {
    const { store } = makeStore();
    store.fold(
        makePlanGenerated('plan-1', 1, {
            content: 'v1',
            occurredAt: 10,
            projectId: 'proj-A',
        }),
    );
    store.fold(
        makePlanGenerated('plan-1', 2, {
            content: 'v2',
            occurredAt: 20,
            projectId: 'proj-A',
        }),
    );
    store.fold(makePlanDecomposed('plan-1', { occurredAt: 25 }));

    // PlanDeleted lands — drafts AND decomposed entries should vanish so
    // re-creating the same planId starts clean.
    store.fold({
        type: PLAN_REVIEW_EVENT_TYPES.DELETED,
        v: 1,
        occurredAt: 30,
        idempotencyKey: 'del:plan-1',
        payload: { planId: 'plan-1', actor: 'operator' },
    } as unknown as PlanGenerated);

    assert.deepEqual(store.listRevisions('plan-1'), []);
    assert.equal(store.getLatest('plan-1'), null);
    assert.equal(store.isDecomposed('plan-1'), false);
    assert.equal(store.listPending().length, 0);
});

/**
 * Field report: Regenerate answered 404 on plans the board showed as
 * ready, across a whole project. Cause: PlanArchived DELETED the plan's
 * revisions so an archived plan would stop appearing in listPending().
 * Archiving is reversible from the sidebar and the delete was not, so
 * unarchiving restored the plan row with nothing behind it — 14 of 17
 * live plans on one project were in that state.
 *
 * The card listPending() was hiding is now hidden by a query filter,
 * which is where a view concern belongs.
 */
test('PlanArchived KEEPS the revisions — archiving is reversible', () => {
    const { store } = makeStore();
    store.fold(
        makePlanGenerated('plan-1', 1, {
            content: 'v1',
            occurredAt: 10,
            projectId: 'proj-A',
        }),
    );
    store.fold({
        type: PLAN_REVIEW_EVENT_TYPES.ARCHIVED,
        v: 1,
        occurredAt: 20,
        idempotencyKey: 'arc:plan-1',
        payload: { planId: 'plan-1' },
    } as unknown as PlanGenerated);

    // The content survives, so Regenerate still has a revision to build
    // on after the operator unarchives.
    assert.equal(store.getLatest('plan-1')?.content, 'v1');
});

test('PlanDeleted still wipes the revisions', () => {
    // Delete has no undo in the UI, so the cascade stays.
    const { store } = makeStore();
    store.fold(
        makePlanGenerated('plan-2', 1, {
            content: 'v1',
            occurredAt: 10,
            projectId: 'proj-A',
        }),
    );
    store.fold({
        type: PLAN_REVIEW_EVENT_TYPES.DELETED,
        v: 1,
        occurredAt: 20,
        idempotencyKey: 'del:plan-2',
        payload: { planId: 'plan-2' },
    } as unknown as PlanGenerated);

    assert.equal(store.getLatest('plan-2'), null);
});

test('PlanDeleted for an unknown plan is a silent no-op', () => {
    const { store } = makeStore();
    assert.doesNotThrow(() =>
        store.fold({
            type: PLAN_REVIEW_EVENT_TYPES.DELETED,
            v: 1,
            occurredAt: 10,
            idempotencyKey: 'del:nope',
            payload: { planId: 'nope', actor: 'op' },
        } as unknown as PlanGenerated),
    );
});

test('state survives across a fresh PlanReviewStore instance over the same db', () => {
    const db = makeDb();
    const first = new PlanReviewStore(db);
    first.fold(
        makePlanGenerated('plan-1', 1, {
            content: 'v1',
            occurredAt: 10,
            projectId: 'proj-A',
        }),
    );
    first.fold(makePlanDecomposed('plan-2', { occurredAt: 20 }));

    // Second instance opens the same db handle — would not see the
    // earlier writes if persistence weren't SQLite-backed.
    const second = new PlanReviewStore(db);
    assert.equal(second.getLatest('plan-1')?.content, 'v1');
    assert.equal(second.isDecomposed('plan-2'), true);
});

test('bus subscription wiring routes PlanGenerated / PlanDecomposed into the store', async () => {
    const db = makeDb();
    const eventStore = new EventStore(db);
    const bus = new EventBus(eventStore, new SilentLogger());
    const store = new PlanReviewStore(db, bus);

    await bus.publish(
        makePlanGenerated('plan-1', 1, {
            content: 'v1',
            occurredAt: 10,
            projectId: 'proj-A',
        }),
    );
    await bus.publish(makePlanDecomposed('plan-2', { occurredAt: 20 }));

    assert.equal(store.getLatest('plan-1')?.content, 'v1');
    assert.equal(store.isDecomposed('plan-2'), true);
    // The subscriber name is the constant exported by the module so
    // hosts can target `bus.replayMissed(...)` against it.
    assert.equal(PLAN_REVIEW_PROJECTION_SUBSCRIBER, 'plan-review-projection');
});

test('listPending hides an ARCHIVED plan without touching its revisions', () => {
    // The behaviour the delete used to provide, now as a query filter:
    // the active-planner card must not resurrect an archived plan on
    // reload, but the plan's content has to survive so unarchiving gives
    // a working plan back.
    const { db, store } = makeStore();
    store.fold(
        makePlanGenerated('plan-arch', 1, {
            content: 'v1',
            occurredAt: 10,
            projectId: 'proj-A',
        }),
    );
    db.prepare(
        `INSERT INTO sidebar_plans(plan_id, pid, name, archived_at, updated_at)
         VALUES ('plan-arch', 'proj-A', 'Archived one', 999, 1)`,
    ).run();

    assert.deepEqual(store.listPending(), [], 'archived plans stay off the board');
    assert.equal(store.getLatest('plan-arch')?.content, 'v1', 'content survives');
});

test('UNARCHIVING brings the plan back with its revision intact', () => {
    // The whole bug in one test: archive, unarchive, and Regenerate must
    // still find a revision to build the next one from.
    const { db, store } = makeStore();
    store.fold(
        makePlanGenerated('plan-round', 3, {
            content: 'the plan body',
            occurredAt: 10,
            projectId: 'proj-A',
        }),
    );
    db.prepare(
        `INSERT INTO sidebar_plans(plan_id, pid, name, archived_at, updated_at)
         VALUES ('plan-round', 'proj-A', 'Round trip', 999, 1)`,
    ).run();
    assert.deepEqual(store.listPending(), []);

    // Unarchive.
    db.prepare("UPDATE sidebar_plans SET archived_at = NULL WHERE plan_id = 'plan-round'").run();

    assert.equal(store.listPending().length, 1, 'back on the board');
    const latest = store.getLatest('plan-round');
    assert.equal(latest?.revision, 3, 'the revision counter is unbroken');
    assert.equal(latest?.content, 'the plan body');
});

test('a plan with no sidebar row at all still lists (the filter is opt-out)', () => {
    // The projections are independent and can be folded in either order.
    // Requiring a sidebar_plans row would make listPending depend on
    // another projection having caught up first.
    const { store } = makeStore();
    store.fold(
        makePlanGenerated('plan-orphan', 1, {
            content: 'v1',
            occurredAt: 10,
            projectId: 'proj-A',
        }),
    );

    assert.equal(store.listPending().length, 1);
});
