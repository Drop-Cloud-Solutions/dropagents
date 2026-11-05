import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';

import type { Command } from '../../../core/commands/command';
import { PlanLifecycleCommands, isDecomposePlanPayload } from '../../../core/commands/index';
import type { StoredEvent } from '../../../core/events/event';

import {
    APPROVE_PLAN_ACTION,
    REGENERATE_PLAN_ACTION,
    PLAN_REVIEW_ROUTE_PATTERN,
    approvePlan,
    createPlanReviewRouter,
    getPlanReview,
    regeneratePlan,
    type AcceptedBody,
    type ApprovePlanBody,
    type DecomposePlanDispatchPayload,
    type GeneratePlanDispatchPayload,
    type PlanReviewCommandSink,
    type PlanReviewDraft,
    type PlanReviewRevision,
    type PlanReviewStore,
    type PlanNotFoundBody,
    type PlanReviewNotFoundBody,
} from './plan-review';

// ---------------------------------------------------------------------------
// Test fakes
// ---------------------------------------------------------------------------

interface FakeStore extends PlanReviewStore {
    readonly draftReads: Array<{ projectId: string; planId: string }>;
    readonly revisionReads: Array<{ projectId: string; planId: string }>;
    seedDraft(projectId: string, planId: string, draft: PlanReviewDraft): void;
    seedRevision(projectId: string, planId: string, revision: PlanReviewRevision): void;
}

function makeFakeStore(): FakeStore {
    const drafts = new Map<string, PlanReviewDraft>();
    const revisions = new Map<string, PlanReviewRevision[]>();
    const draftReads: Array<{ projectId: string; planId: string }> = [];
    const revisionReads: Array<{ projectId: string; planId: string }> = [];
    return {
        draftReads,
        revisionReads,
        seedDraft(projectId, planId, draft): void {
            drafts.set(`${projectId}::${planId}`, draft);
        },
        seedRevision(projectId, planId, revision): void {
            const key = `${projectId}::${planId}`;
            const arr = revisions.get(key) ?? [];
            arr.push(revision);
            arr.sort((a, b) => a.revision - b.revision);
            revisions.set(key, arr);
        },
        get(projectId, planId) {
            draftReads.push({ projectId, planId });
            return drafts.get(`${projectId}::${planId}`) ?? null;
        },
        getLatestRevision(projectId, planId) {
            revisionReads.push({ projectId, planId });
            const arr = revisions.get(`${projectId}::${planId}`);
            if (!arr || arr.length === 0) return null;
            return arr[arr.length - 1];
        },
        getLatestNonEmptyRevision(projectId, planId) {
            const arr = revisions.get(`${projectId}::${planId}`);
            if (!arr) return null;
            for (let i = arr.length - 1; i >= 0; i--) {
                const rev = arr[i];
                if (rev !== undefined && rev.content.length > 0) return rev;
            }
            return null;
        },
        listPending() {
            return [];
        },
    };
}

interface FakeBus extends PlanReviewCommandSink {
    readonly sent: ReadonlyArray<Command>;
    readonly stored: StoredEvent[];
}

function makeFakeBus(): FakeBus {
    const sent: Command[] = [];
    const stored: StoredEvent[] = [];
    return {
        get sent(): readonly Command[] {
            return sent;
        },
        stored,
        async send(command): Promise<readonly StoredEvent[]> {
            sent.push(command);
            return stored;
        },
    };
}

// ---------------------------------------------------------------------------
// Pure handlers — GET /plan-review
// ---------------------------------------------------------------------------

test('getPlanReview returns {markdown, generatedAt} from the projection store', async () => {
    const store = makeFakeStore();
    const bus = makeFakeBus();
    store.seedDraft('proj-1', 'plan-1', {
        markdown: '# Plan Review\nLooks good.',
        generatedAt: 1_700_000_000_000,
    });

    const result = await getPlanReview({ store, bus }, 'proj-1', 'plan-1');

    assert.equal(result.status, 200);
    assert.deepEqual(result.body, {
        markdown: '# Plan Review\nLooks good.',
        generatedAt: 1_700_000_000_000,
    });
    assert.equal(bus.sent.length, 0);
});

test('getPlanReview returns 404 when no draft exists for the plan', async () => {
    const store = makeFakeStore();
    const bus = makeFakeBus();
    store.seedDraft('proj-1', 'plan-other', { markdown: 'x', generatedAt: 1 });

    const result = await getPlanReview({ store, bus }, 'proj-1', 'plan-missing');

    assert.equal(result.status, 404);
    const body = result.body as PlanReviewNotFoundBody;
    assert.equal(body.error, 'plan-review not found');
    assert.equal(body.planId, 'plan-missing');
});

test('getPlanReview isolates draft lookup by projectId', async () => {
    const store = makeFakeStore();
    const bus = makeFakeBus();
    store.seedDraft('proj-A', 'plan-1', { markdown: 'A', generatedAt: 1 });

    const result = await getPlanReview({ store, bus }, 'proj-B', 'plan-1');
    assert.equal(result.status, 404);
});

test('getPlanReview awaits async stores', async () => {
    const bus = makeFakeBus();
    const asyncStore: PlanReviewStore = {
        async get(projectId, planId): Promise<PlanReviewDraft | null> {
            if (projectId === 'p' && planId === 'pl') {
                return { markdown: '# async', generatedAt: 42 };
            }
            return null;
        },
        async getLatestRevision(): Promise<PlanReviewRevision | null> {
            return null;
        },
        listPending() {
            return [];
        },
    };

    const hit = await getPlanReview({ store: asyncStore, bus }, 'p', 'pl');
    const miss = await getPlanReview({ store: asyncStore, bus }, 'p', 'nope');
    assert.equal(hit.status, 200);
    assert.deepEqual(hit.body, { markdown: '# async', generatedAt: 42 });
    assert.equal(miss.status, 404);
});

// ---------------------------------------------------------------------------
// Pure handlers — /approve
// ---------------------------------------------------------------------------

test('approvePlan dispatches DecomposePlan with the latest revision content (AC #1)', async () => {
    const store = makeFakeStore();
    const bus = makeFakeBus();
    store.seedRevision('proj-1', 'plan-1', {
        revision: 3,
        content: '# Plan v3',
        generatedAt: 1_700_000_000_000,
    });

    const result = await approvePlan(
        { store, bus, clock: () => 7_777 },
        'proj-1',
        'plan-1',
        { conventions: { lang: 'ts' } },
        'operator@example.com',
    );

    assert.equal(result.status, 202);
    const body = result.body as AcceptedBody;
    assert.equal(body.commandType, PlanLifecycleCommands.DECOMPOSE_PLAN);
    assert.equal(body.revision, 3);
    assert.equal(bus.sent.length, 1);
    const cmd = bus.sent[0] as Command<DecomposePlanDispatchPayload>;
    assert.equal(cmd.type, 'DecomposePlan');
    assert.equal(cmd.actor, 'operator@example.com');
    assert.equal(cmd.issuedAt, 7_777);
    assert.deepEqual(cmd.payload, {
        projectId: 'proj-1',
        planId: 'plan-1',
        approvedContent: '# Plan v3',
        conventions: { lang: 'ts' },
    });
});

test('approvePlan returns 404 when the plan has no revisions (AC #4)', async () => {
    const store = makeFakeStore();
    const bus = makeFakeBus();

    const result = await approvePlan(
        { store, bus, clock: () => 0 },
        'proj-1',
        'plan-missing',
        {},
        'op',
    );

    assert.equal(result.status, 404);
    const body = result.body as PlanNotFoundBody;
    assert.equal(body.error, 'plan not found');
    assert.equal(body.planId, 'plan-missing');
    // No command must reach the bus on the 404 path.
    assert.equal(bus.sent.length, 0);
});

test('approvePlan defaults conventions to {} so the payload passes validation', async () => {
    // This asserted the OPPOSITE ("omits conventions") until the default
    // was added. Omitting the key is not a harmless economy:
    // `isDecomposePlanPayload` runs `isPlanConventions(v.conventions)`,
    // which rejects undefined outright — so the bus refused every approve
    // whose body carried no conventions, i.e. the Ready-plan Decompose
    // button and the modal's plain approve. An empty object satisfies the
    // contract and means the same thing.
    const store = makeFakeStore();
    const bus = makeFakeBus();
    store.seedRevision('proj-1', 'plan-1', {
        revision: 1,
        content: '# v1',
        generatedAt: 0,
    });

    await approvePlan({ store, bus, clock: () => 1 }, 'proj-1', 'plan-1', {}, 'op');

    const cmd = bus.sent[0] as Command<DecomposePlanDispatchPayload>;
    assert.deepEqual(cmd.payload, {
        projectId: 'proj-1',
        planId: 'plan-1',
        approvedContent: '# v1',
        conventions: {},
    });
    // The point of the default, asserted against the real validator
    // rather than a shape this test hand-copies.
    assert.equal(
        isDecomposePlanPayload(cmd.payload),
        true,
        'a dispatched DecomposePlan must survive its own payload validator',
    );
});


// ---------------------------------------------------------------------------
// Pure handlers — /regenerate
// ---------------------------------------------------------------------------

test('regeneratePlan dispatches GeneratePlan with nextRevision = latest + 1 (AC #2)', async () => {
    const store = makeFakeStore();
    const bus = makeFakeBus();
    store.seedRevision('proj-1', 'plan-1', {
        revision: 2,
        content: '# v2',
        generatedAt: 100,
    });

    const result = await regeneratePlan(
        { store, bus, clock: () => 9_999 },
        'proj-1',
        'plan-1',
        { feedback: 'cut scope' },
        'operator',
    );

    assert.equal(result.status, 202);
    const body = result.body as AcceptedBody;
    assert.equal(body.commandType, PlanLifecycleCommands.GENERATE_PLAN);
    assert.equal(body.revision, 3);
    assert.equal(bus.sent.length, 1);
    const cmd = bus.sent[0] as Command<GeneratePlanDispatchPayload>;
    assert.equal(cmd.type, 'GeneratePlan');
    assert.equal(cmd.issuedAt, 9_999);
    assert.equal(cmd.actor, 'operator');
    assert.deepEqual(cmd.payload, {
        projectId: 'proj-1',
        planId: 'plan-1',
        previousContent: '# v2',
        revision: 3,
        feedback: 'cut scope',
    });
});

test('regeneratePlan falls back to the last NON-EMPTY revision when the latest is an empty failed-run residue', async () => {
    const store = makeFakeStore();
    const bus = makeFakeBus();
    store.seedRevision('proj-1', 'plan-1', {
        revision: 2,
        content: '# v2 real plan',
        generatedAt: 100,
    });
    // Revisions 3-4: dispatched but the planner died at spawn — rows
    // exist with empty content (minted by the dispatch-time
    // PlanGenerated fold and never overwritten).
    store.seedRevision('proj-1', 'plan-1', { revision: 3, content: '', generatedAt: 200 });
    store.seedRevision('proj-1', 'plan-1', { revision: 4, content: '', generatedAt: 300 });

    const result = await regeneratePlan(
        { store, bus, clock: () => 1 },
        'proj-1',
        'plan-1',
        {},
        'op',
    );

    assert.equal(result.status, 202);
    const cmd = bus.sent[0] as Command<GeneratePlanDispatchPayload>;
    // Revision numbering still advances from the TRUE latest (4 → 5)...
    assert.equal(cmd.payload.revision, 5);
    // ...but the planner sees the last plan that actually exists.
    assert.equal(cmd.payload.previousContent, '# v2 real plan');
});

test('regeneratePlan returns 404 when there is no prior revision', async () => {
    const store = makeFakeStore();
    const bus = makeFakeBus();

    const result = await regeneratePlan(
        { store, bus, clock: () => 0 },
        'proj-1',
        'plan-missing',
        { feedback: 'meh' },
        'op',
    );

    assert.equal(result.status, 404);
    assert.equal(bus.sent.length, 0);
});

test('regeneratePlan omits feedback from payload when caller did not supply one', async () => {
    const store = makeFakeStore();
    const bus = makeFakeBus();
    store.seedRevision('proj-1', 'plan-1', {
        revision: 1,
        content: '# v1',
        generatedAt: 0,
    });

    await regeneratePlan({ store, bus, clock: () => 1 }, 'proj-1', 'plan-1', {}, 'op');

    const cmd = bus.sent[0] as Command<GeneratePlanDispatchPayload>;
    assert.deepEqual(cmd.payload, {
        projectId: 'proj-1',
        planId: 'plan-1',
        previousContent: '# v1',
        revision: 2,
    });
    assert.equal('feedback' in cmd.payload, false);
});

test('regeneratePlan uses defaultActor when caller omits actor', async () => {
    const store = makeFakeStore();
    const bus = makeFakeBus();
    store.seedRevision('p', 'pl', { revision: 5, content: '#5', generatedAt: 0 });

    await regeneratePlan(
        { store, bus, clock: () => 1, defaultActor: 'system:board' },
        'p',
        'pl',
        {},
    );

    assert.equal(bus.sent[0].actor, 'system:board');
});

// ---------------------------------------------------------------------------
// Route pattern
// ---------------------------------------------------------------------------

test('route pattern captures projectId, planId, and optional action segment', () => {
    const m1 = PLAN_REVIEW_ROUTE_PATTERN.exec('/api/projects/proj-1/plans/plan-9/plan-review');
    assert.ok(m1);
    assert.equal(m1?.[1], 'proj-1');
    assert.equal(m1?.[2], 'plan-9');
    assert.equal(m1?.[3], undefined);

    const m2 = PLAN_REVIEW_ROUTE_PATTERN.exec(
        '/api/projects/proj-1/plans/plan-9/plan-review/approve',
    );
    assert.equal(m2?.[3], APPROVE_PLAN_ACTION);

    const m3 = PLAN_REVIEW_ROUTE_PATTERN.exec(
        '/api/projects/proj-1/plans/plan-9/plan-review/regenerate',
    );
    assert.equal(m3?.[3], REGENERATE_PLAN_ACTION);

    // Unknown actions do not match — keeps a typo'd URL from accidentally
    // dispatching the wrong command.
    assert.equal(
        PLAN_REVIEW_ROUTE_PATTERN.exec('/api/projects/p/plans/pl/plan-review/delete'),
        null,
    );
});

// ---------------------------------------------------------------------------
// HTTP wrapper — end-to-end through a real socket so the routing wiring
// (path parsing, method handling, JSON body parsing, auth) is exercised.
// ---------------------------------------------------------------------------

interface HarnessHandle {
    readonly baseUrl: string;
    readonly bus: FakeBus;
    readonly store: FakeStore;
    close(): Promise<void>;
}

async function makeHttpHarness(
    opts: { readonly authToken?: string } = {},
): Promise<HarnessHandle> {
    const store = makeFakeStore();
    const bus = makeFakeBus();
    const router = createPlanReviewRouter({
        store,
        bus,
        clock: () => 7_000,
        ...(opts.authToken !== undefined ? { authToken: opts.authToken } : {}),
    });
    const server = http.createServer((req: http.IncomingMessage, res: http.ServerResponse) => {
        if (router.handle(req, res)) return;
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    return {
        baseUrl: `http://127.0.0.1:${port}`,
        bus,
        store,
        close: () =>
            new Promise<void>((resolve, reject) =>
                server.close((err: Error | undefined) => (err ? reject(err) : resolve())),
            ),
    };
}

// ---------------------------------------------------------------------------
// HTTP — /approve success + missing-plan
// ---------------------------------------------------------------------------

test('HTTP: POST /approve returns 202 and dispatches DecomposePlan (AC #1, #6 success)', async () => {
    const h = await makeHttpHarness();
    try {
        h.store.seedRevision('proj-1', 'plan-1', {
            revision: 4,
            content: '# v4',
            generatedAt: 0,
        });
        const res = await fetch(
            `${h.baseUrl}/api/projects/proj-1/plans/plan-1/plan-review/approve`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    actor: 'op@x',
                    conventions: { lang: 'ts' },
                }),
            },
        );
        assert.equal(res.status, 202);
        const body = (await res.json()) as AcceptedBody;
        assert.equal(body.commandType, 'DecomposePlan');
        assert.equal(body.revision, 4);
        assert.equal(h.bus.sent.length, 1);
        const cmd = h.bus.sent[0] as Command<DecomposePlanDispatchPayload>;
        assert.equal(cmd.actor, 'op@x');
        assert.deepEqual(cmd.payload, {
            projectId: 'proj-1',
            planId: 'plan-1',
            approvedContent: '# v4',
            conventions: { lang: 'ts' },
        });
    } finally {
        await h.close();
    }
});

test('HTTP: POST /approve returns 404 when the plan is unknown (AC #4, #6 404)', async () => {
    const h = await makeHttpHarness();
    try {
        const res = await fetch(
            `${h.baseUrl}/api/projects/proj-1/plans/plan-missing/plan-review/approve`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({}),
            },
        );
        assert.equal(res.status, 404);
        const body = (await res.json()) as PlanNotFoundBody;
        assert.equal(body.error, 'plan not found');
        assert.equal(body.planId, 'plan-missing');
        // Unknown plans must not produce a dispatch.
        assert.equal(h.bus.sent.length, 0);
    } finally {
        await h.close();
    }
});

// ---------------------------------------------------------------------------
// HTTP — /regenerate success + missing-plan
// ---------------------------------------------------------------------------

test('HTTP: POST /regenerate returns 202 and dispatches GeneratePlan with incremented revision (AC #2)', async () => {
    const h = await makeHttpHarness();
    try {
        h.store.seedRevision('proj-1', 'plan-1', {
            revision: 7,
            content: '# v7',
            generatedAt: 0,
        });
        const res = await fetch(
            `${h.baseUrl}/api/projects/proj-1/plans/plan-1/plan-review/regenerate`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ actor: 'op@x', feedback: 'less yaml' }),
            },
        );
        assert.equal(res.status, 202);
        const body = (await res.json()) as AcceptedBody;
        assert.equal(body.commandType, 'GeneratePlan');
        assert.equal(body.revision, 8);
        assert.equal(h.bus.sent.length, 1);
        const cmd = h.bus.sent[0] as Command<GeneratePlanDispatchPayload>;
        assert.equal(cmd.actor, 'op@x');
        assert.deepEqual(cmd.payload, {
            projectId: 'proj-1',
            planId: 'plan-1',
            previousContent: '# v7',
            revision: 8,
            feedback: 'less yaml',
        });
    } finally {
        await h.close();
    }
});

test('HTTP: POST /regenerate returns 404 when the plan is unknown', async () => {
    const h = await makeHttpHarness();
    try {
        const res = await fetch(
            `${h.baseUrl}/api/projects/proj-1/plans/plan-missing/plan-review/regenerate`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ feedback: 'try again' }),
            },
        );
        assert.equal(res.status, 404);
        assert.equal(h.bus.sent.length, 0);
    } finally {
        await h.close();
    }
});

// ---------------------------------------------------------------------------
// HTTP — auth (AC #3, #6 401)
// ---------------------------------------------------------------------------

test('HTTP: POST /approve without a Bearer token returns 401 + WWW-Authenticate: Bearer (AC #3)', async () => {
    const h = await makeHttpHarness({ authToken: 'shh' });
    try {
        h.store.seedRevision('p', 'pl', { revision: 1, content: '#', generatedAt: 0 });
        const res = await fetch(
            `${h.baseUrl}/api/projects/p/plans/pl/plan-review/approve`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ conventions: {} }),
            },
        );
        assert.equal(res.status, 401);
        assert.equal(res.headers.get('www-authenticate'), 'Bearer');
        // Unauthorized requests must not reach the bus or the store's
        // revision reader — auth fires before any downstream work.
        assert.equal(h.bus.sent.length, 0);
        assert.equal(h.store.revisionReads.length, 0);
    } finally {
        await h.close();
    }
});

test('HTTP: POST /approve with a wrong Bearer token returns 401', async () => {
    const h = await makeHttpHarness({ authToken: 'shh' });
    try {
        const res = await fetch(
            `${h.baseUrl}/api/projects/p/plans/pl/plan-review/approve`,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: 'Bearer wrong',
                },
                body: JSON.stringify({}),
            },
        );
        assert.equal(res.status, 401);
        assert.equal(res.headers.get('www-authenticate'), 'Bearer');
        assert.equal(h.bus.sent.length, 0);
    } finally {
        await h.close();
    }
});

test('HTTP: POST /regenerate without a Bearer token returns 401 (AC #3)', async () => {
    const h = await makeHttpHarness({ authToken: 'shh' });
    try {
        h.store.seedRevision('p', 'pl', { revision: 1, content: '#', generatedAt: 0 });
        const res = await fetch(
            `${h.baseUrl}/api/projects/p/plans/pl/plan-review/regenerate`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ feedback: 'x' }),
            },
        );
        assert.equal(res.status, 401);
        assert.equal(res.headers.get('www-authenticate'), 'Bearer');
        assert.equal(h.bus.sent.length, 0);
        assert.equal(h.store.revisionReads.length, 0);
    } finally {
        await h.close();
    }
});

test('HTTP: POST /approve with the correct Bearer token succeeds', async () => {
    const h = await makeHttpHarness({ authToken: 'shh' });
    try {
        h.store.seedRevision('p', 'pl', { revision: 1, content: '#', generatedAt: 0 });
        const res = await fetch(
            `${h.baseUrl}/api/projects/p/plans/pl/plan-review/approve`,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: 'Bearer shh',
                },
                body: JSON.stringify({} as ApprovePlanBody),
            },
        );
        assert.equal(res.status, 202);
        assert.equal(h.bus.sent.length, 1);
    } finally {
        await h.close();
    }
});

test('HTTP: GET /plan-review is not gated by Bearer auth even when authToken is set', async () => {
    // The route's auth gate intentionally guards only POST endpoints —
    // matches the brief's AC #3 ("Both endpoints" = the two new POSTs)
    // and leaves the existing read path untouched.
    const h = await makeHttpHarness({ authToken: 'shh' });
    try {
        const res = await fetch(
            `${h.baseUrl}/api/projects/proj-1/plans/plan-1/plan-review`,
        );
        // The store is empty so we expect a 404 from the read path, not a
        // 401 from auth. The point is that auth does not fire on GET.
        assert.equal(res.status, 404);
    } finally {
        await h.close();
    }
});

// ---------------------------------------------------------------------------
// HTTP — method handling + body errors
// ---------------------------------------------------------------------------

test('HTTP: GET on /approve returns 405 with Allow: POST', async () => {
    const h = await makeHttpHarness();
    try {
        const res = await fetch(
            `${h.baseUrl}/api/projects/p/plans/pl/plan-review/approve`,
        );
        assert.equal(res.status, 405);
        assert.equal(res.headers.get('allow'), 'POST');
    } finally {
        await h.close();
    }
});

test('HTTP: POST with malformed JSON body returns 400', async () => {
    const h = await makeHttpHarness();
    try {
        const res = await fetch(
            `${h.baseUrl}/api/projects/p/plans/pl/plan-review/approve`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: '{not json',
            },
        );
        assert.equal(res.status, 400);
        assert.equal(h.bus.sent.length, 0);
    } finally {
        await h.close();
    }
});

test('HTTP: unrelated path falls through (router yields)', async () => {
    const h = await makeHttpHarness();
    try {
        const res = await fetch(`${h.baseUrl}/unrelated/path`);
        assert.equal(res.status, 404);
        const body = (await res.json()) as { error: string };
        assert.equal(body.error, 'not found');
    } finally {
        await h.close();
    }
});
