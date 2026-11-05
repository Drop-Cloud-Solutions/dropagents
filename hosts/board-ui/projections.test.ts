/**
 * Board-UI read projection tests (AP-IFG-010).
 *
 * Covers happy path + 404 for each of the five GET endpoints, plus the
 * cursor-based pagination contract on `/api/projects/:pid/plans`. The
 * suite drives the handler through HTTP — a real `http.Server` is
 * spun up per case so route compilation, query-string parsing, and
 * status-code wiring are exercised end to end.
 *
 * Dual-runner discovery
 * ---------------------
 * Same pattern as `commands.test.ts` and `server.crud.test.ts`: vitest
 * sets `process.env.VITEST=true` in its worker, so we route through
 * `globalThis.test` there and `require('node:test').test` everywhere
 * else. See those files for the full rationale.
 */
import * as assert from 'node:assert/strict';
import * as http from 'node:http';

import {
    BOARD_UI_PROJECTION_ROUTES,
    DEFAULT_PAGE_LIMIT,
    MAX_PAGE_LIMIT,
    createProjectionsHandler,
    matchProjectionRoute,
    parsePaginationQuery,
    type PaginatedPlans,
    type StatePlanDetail,
    type StatePlanSummary,
    type StatePort,
    type StateProjectDetail,
    type StateProjectSummary,
    type StateTaskRecord,
} from './projections';

// ---------------------------------------------------------------------------
// Dual-runner test() shim
// ---------------------------------------------------------------------------

type TestFn = (name: string, fn: () => void | Promise<void>) => void;

const test: TestFn = (((): TestFn => {
    if (process.env.VITEST) {
        const gt = (globalThis as { test?: TestFn }).test;
        if (typeof gt !== 'function') {
            throw new Error(
                'projections.test.ts: VITEST=true but globalThis.test is missing — '
                    + 'ensure vitest.config.ts sets test.globals = true',
            );
        }
        return gt;
    }
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    const nt = require('node:test') as { test: TestFn };
    return nt.test;
})());

// ---------------------------------------------------------------------------
// Fake StatePort + HTTP harness
// ---------------------------------------------------------------------------

interface FakeData {
    readonly projects: Readonly<Record<string, StateProjectDetail>>;
    readonly planLists: Readonly<Record<string, ReadonlyArray<StatePlanSummary>>>;
    readonly plans: Readonly<Record<string, StatePlanDetail>>;
    readonly tasks: Readonly<Record<string, StateTaskRecord>>;
}

function planListKey(projectId: string): string {
    return projectId;
}

function planKey(projectId: string, file: string): string {
    return `${projectId}::${file}`;
}

function taskKey(projectId: string, planFile: string, taskId: string): string {
    return `${projectId}::${planFile}::${taskId}`;
}

function makeStatePort(data: FakeData): StatePort {
    return {
        async readProjects(): Promise<ReadonlyArray<StateProjectSummary>> {
            return Object.values(data.projects)
                .map((p): StateProjectSummary => ({
                    id: p.id,
                    name: p.name,
                    description: p.description,
                    archivedAt: p.archivedAt,
                }))
                .sort((a, b) => a.name.localeCompare(b.name));
        },
        async readProject(projectId): Promise<StateProjectDetail | null> {
            return data.projects[projectId] ?? null;
        },
        async readPlans(projectId, { cursor, limit }): Promise<PaginatedPlans> {
            const all = data.planLists[planListKey(projectId)] ?? [];
            const startIdx = cursor ? Number(cursor) : 0;
            if (!Number.isFinite(startIdx) || startIdx < 0) {
                return { plans: [], nextCursor: null };
            }
            const slice = all.slice(startIdx, startIdx + limit);
            const nextIdx = startIdx + slice.length;
            const nextCursor = nextIdx < all.length ? String(nextIdx) : null;
            return { plans: slice, nextCursor };
        },
        async readPlan(projectId, planFile): Promise<StatePlanDetail | null> {
            return data.plans[planKey(projectId, planFile)] ?? null;
        },
        async readTask(projectId, planFile, taskId): Promise<StateTaskRecord | null> {
            return data.tasks[taskKey(projectId, planFile, taskId)] ?? null;
        },
    };
}

interface ServerHandle {
    readonly url: string;
    close(): Promise<void>;
}

async function startServer(statePort: StatePort): Promise<ServerHandle> {
    const handler = createProjectionsHandler({ statePort });
    const server = http.createServer((req, res) => {
        void handler(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address() as { port: number };
    return {
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
}

async function withServer(
    data: FakeData,
    fn: (server: ServerHandle, statePort: StatePort) => Promise<void>,
): Promise<void> {
    const statePort = makeStatePort(data);
    const server = await startServer(statePort);
    try {
        await fn(server, statePort);
    } finally {
        await server.close();
    }
}

const EMPTY_DATA: FakeData = {
    projects: {},
    planLists: {},
    plans: {},
    tasks: {},
};

function makeTask(overrides: Partial<StateTaskRecord> & { id: string; planId: string }): StateTaskRecord {
    return {
        type: 'implement',
        status: 'open',
        flowId: 'dev-review-test-commit',
        parent_task_id: null,
        spawn_reason: null,
        source_investigation_id: null,
        investigation_thread: [],
        followup_inflight: false,
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// AC #1 — exports a router with five GET endpoints
// ---------------------------------------------------------------------------

test('BOARD_UI_PROJECTION_ROUTES exposes exactly the five v1 GET endpoints', () => {
    const signatures = BOARD_UI_PROJECTION_ROUTES.map((r) => `${r.method} ${r.pattern}`);
    const expected = [
        'GET /api/projects',
        'GET /api/projects/:pid',
        'GET /api/projects/:pid/plans',
        'GET /api/projects/:pid/plans/:file',
        'GET /api/projects/:pid/plans/:file/tasks/:tid',
    ];
    assert.deepEqual(signatures.sort(), expected.sort());
});

// ---------------------------------------------------------------------------
// AC #2 / #4 — happy path + 404 per endpoint
// ---------------------------------------------------------------------------

test('GET /api/projects returns the projection ordered by name', async () => {
    const data: FakeData = {
        ...EMPTY_DATA,
        projects: {
            'p-1': { id: 'p-1', name: 'Beta' },
            'p-2': { id: 'p-2', name: 'Alpha', description: 'first' },
        },
    };
    await withServer(data, async (server) => {
        const res = await fetch(`${server.url}/api/projects`);
        assert.equal(res.status, 200);
        const body = (await res.json()) as { projects: StateProjectSummary[] };
        assert.deepEqual(body.projects.map((p) => p.name), ['Alpha', 'Beta']);
        assert.equal(body.projects[0].description, 'first');
    });
});

test('GET /api/projects/:pid returns the project record for a known id', async () => {
    const data: FakeData = {
        ...EMPTY_DATA,
        projects: {
            'p-1': { id: 'p-1', name: 'Pipeline', description: 'v2' },
        },
    };
    await withServer(data, async (server) => {
        const res = await fetch(`${server.url}/api/projects/p-1`);
        assert.equal(res.status, 200);
        const body = (await res.json()) as StateProjectDetail;
        assert.equal(body.id, 'p-1');
        assert.equal(body.name, 'Pipeline');
        assert.equal(body.description, 'v2');
    });
});

test('GET /api/projects/:pid returns 404 for an unknown project', async () => {
    await withServer(EMPTY_DATA, async (server) => {
        const res = await fetch(`${server.url}/api/projects/missing`);
        assert.equal(res.status, 404);
        const body = (await res.json()) as { error: string };
        assert.equal(body.error, 'not found');
    });
});

test('GET /api/projects/:pid/plans returns the first page and nextCursor', async () => {
    const plans: StatePlanSummary[] = Array.from({ length: 3 }, (_, i) => ({
        id: `pl-${i}`,
        file: `plan-${i}`,
        projectId: 'p-1',
        title: `Plan ${i}`,
        status: 'approved',
        createdAt: 1_700_000_000_000 + i,
    }));
    const data: FakeData = {
        ...EMPTY_DATA,
        projects: { 'p-1': { id: 'p-1', name: 'P' } },
        planLists: { 'p-1': plans },
    };
    await withServer(data, async (server) => {
        const res = await fetch(`${server.url}/api/projects/p-1/plans?limit=2`);
        assert.equal(res.status, 200);
        const body = (await res.json()) as PaginatedPlans;
        assert.equal(body.plans.length, 2);
        assert.equal(body.plans[0].file, 'plan-0');
        assert.equal(body.plans[1].file, 'plan-1');
        assert.equal(body.nextCursor, '2');

        // Echo the cursor back to fetch the next page; the final page
        // returns nextCursor=null to signal end of stream.
        const res2 = await fetch(
            `${server.url}/api/projects/p-1/plans?limit=2&cursor=2`,
        );
        const body2 = (await res2.json()) as PaginatedPlans;
        assert.equal(body2.plans.length, 1);
        assert.equal(body2.plans[0].file, 'plan-2');
        assert.equal(body2.nextCursor, null);
    });
});

test('GET /api/projects/:pid/plans returns 404 for an unknown project', async () => {
    await withServer(EMPTY_DATA, async (server) => {
        const res = await fetch(`${server.url}/api/projects/missing/plans`);
        assert.equal(res.status, 404);
    });
});

test('GET /api/projects/:pid/plans/:file returns the plan detail', async () => {
    const plan: StatePlanDetail = {
        id: 'pl-7',
        file: 'plan-7',
        projectId: 'p-1',
        title: 'Plan seven',
        status: 'approved',
        createdAt: 1,
        body: '# heading',
        tasks: ['t-1', 't-2'],
    };
    const data: FakeData = {
        ...EMPTY_DATA,
        projects: { 'p-1': { id: 'p-1', name: 'P' } },
        plans: { [planKey('p-1', 'plan-7')]: plan },
    };
    await withServer(data, async (server) => {
        const res = await fetch(`${server.url}/api/projects/p-1/plans/plan-7`);
        assert.equal(res.status, 200);
        const body = (await res.json()) as StatePlanDetail;
        assert.equal(body.id, 'pl-7');
        assert.equal(body.body, '# heading');
        assert.deepEqual(body.tasks, ['t-1', 't-2']);
    });
});

test('GET /api/projects/:pid/plans/:file returns 404 for an unknown plan', async () => {
    const data: FakeData = {
        ...EMPTY_DATA,
        projects: { 'p-1': { id: 'p-1', name: 'P' } },
    };
    await withServer(data, async (server) => {
        const res = await fetch(`${server.url}/api/projects/p-1/plans/nope`);
        assert.equal(res.status, 404);
    });
});

test('GET task returns the full lineage shape (AC #3)', async () => {
    const task: StateTaskRecord = makeTask({
        id: 't-99',
        planId: 'pl-7',
        parent_task_id: 't-parent',
        spawn_reason: 'followup',
        source_investigation_id: 'inv-1',
        investigation_thread: [
            { role: 'operator', content: 'why?', timestamp: 1 },
            { role: 'investigator', content: 'because', timestamp: 2 },
        ],
        followup_inflight: true,
    });
    const data: FakeData = {
        ...EMPTY_DATA,
        tasks: { [taskKey('p-1', 'plan-7', 't-99')]: task },
    };
    await withServer(data, async (server) => {
        const res = await fetch(
            `${server.url}/api/projects/p-1/plans/plan-7/tasks/t-99`,
        );
        assert.equal(res.status, 200);
        const body = (await res.json()) as StateTaskRecord;
        assert.equal(body.id, 't-99');
        assert.equal(body.parent_task_id, 't-parent');
        assert.equal(body.spawn_reason, 'followup');
        assert.equal(body.source_investigation_id, 'inv-1');
        assert.equal(body.followup_inflight, true);
        assert.equal(body.investigation_thread.length, 2);
        assert.equal(body.investigation_thread[0].role, 'operator');
    });
});

test('GET task returns 404 for an unknown task', async () => {
    await withServer(EMPTY_DATA, async (server) => {
        const res = await fetch(
            `${server.url}/api/projects/p-1/plans/plan-7/tasks/missing`,
        );
        assert.equal(res.status, 404);
    });
});

// ---------------------------------------------------------------------------
// Pagination contract — query-parsing edge cases live next to the
// handler-level tests so a single read tells the whole pagination story.
// ---------------------------------------------------------------------------

test('parsePaginationQuery defaults limit when missing or non-numeric', () => {
    assert.deepEqual(parsePaginationQuery(new URLSearchParams()), {
        cursor: null,
        limit: DEFAULT_PAGE_LIMIT,
    });
    assert.deepEqual(parsePaginationQuery(new URLSearchParams('limit=abc')), {
        cursor: null,
        limit: DEFAULT_PAGE_LIMIT,
    });
    assert.deepEqual(parsePaginationQuery(new URLSearchParams('limit=0')), {
        cursor: null,
        limit: DEFAULT_PAGE_LIMIT,
    });
});

test('parsePaginationQuery clamps limit at MAX_PAGE_LIMIT', () => {
    const result = parsePaginationQuery(
        new URLSearchParams(`limit=${MAX_PAGE_LIMIT + 100}`),
    );
    assert.equal(result.limit, MAX_PAGE_LIMIT);
});

test('parsePaginationQuery normalises an empty cursor to null', () => {
    assert.equal(parsePaginationQuery(new URLSearchParams('cursor=')).cursor, null);
    assert.equal(
        parsePaginationQuery(new URLSearchParams('cursor=abc123')).cursor,
        'abc123',
    );
});

// ---------------------------------------------------------------------------
// Route matching — guard against accidental wildcard collapse in the
// regex compiler, mirroring the parallel test in server.crud.test.ts.
// ---------------------------------------------------------------------------

test('matchProjectionRoute decodes percent-encoded path params', () => {
    const match = matchProjectionRoute('GET', '/api/projects/p%2D42');
    assert.ok(match);
    if (!match) throw new Error('unreachable'); // narrow for tsc
    assert.equal(match.params.pid, 'p-42');
});

test('matchProjectionRoute rejects non-GET methods', () => {
    assert.equal(matchProjectionRoute('POST', '/api/projects'), null);
    assert.equal(matchProjectionRoute('PATCH', '/api/projects/p-1'), null);
});

test('matchProjectionRoute returns null for unrelated paths', () => {
    assert.equal(matchProjectionRoute('GET', '/api/projects/p-1/plans/pl/extra'), null);
    assert.equal(matchProjectionRoute('GET', '/api/foo'), null);
});

// ---------------------------------------------------------------------------
// Error surfacing — a thrown adapter is funnelled into a 500 with a
// useful message, never a partial 200.
// ---------------------------------------------------------------------------

test('handler returns 500 when the state port throws', async () => {
    const explodingPort: StatePort = {
        async readProjects() {
            throw new Error('boom');
        },
        async readProject() {
            return null;
        },
        async readPlans() {
            return { plans: [], nextCursor: null };
        },
        async readPlan() {
            return null;
        },
        async readTask() {
            return null;
        },
    };
    const handler = createProjectionsHandler({ statePort: explodingPort });
    const server = http.createServer((req, res) => {
        void handler(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address() as { port: number };
    try {
        const res = await fetch(`http://127.0.0.1:${addr.port}/api/projects`);
        assert.equal(res.status, 500);
        const body = (await res.json()) as { error: string; message: string };
        assert.equal(body.error, 'projection failed');
        assert.equal(body.message, 'boom');
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});
