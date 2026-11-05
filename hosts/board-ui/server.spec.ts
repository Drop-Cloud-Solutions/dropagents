/**
 * AP-IFF-007 — proxy-path test suite for the wave 1 projection routes.
 *
 * Boots the real `board-ui` server against a fake worker-api upstream that
 * captures every forwarded request, then asserts that:
 *
 *   - The three new projection paths (`decompose-status`, `plan-review`,
 *     `plan-review/regenerate`) reach the upstream with the same method,
 *     pathname, and query-string the client sent.
 *   - The existing `/events` (SSE) and `/commands` (POST) routes still
 *     proxy — adding the wave 1 entries did not regress the prior set.
 *   - When `workerApiToken` is configured the proxy injects
 *     `Authorization: Bearer <token>` on the upstream request
 *     (`withWorkerAuth` propagation, AC #3).
 *   - Paths that look adjacent but don't match (e.g. wrong trailing
 *     segment, extra path component) fall through to the static handler
 *     and 404 — so the new patterns can't accidentally swallow URLs the
 *     SPA owns.
 *
 * Dual-runner discovery — see `server.crud.test.ts` for rationale. The
 * shim picks vitest's `test` when `process.env.VITEST` is set and falls
 * back to `node:test` everywhere else.
 */
import * as assert from 'node:assert/strict';
import * as http from 'node:http';

import { start, type BoardUiServerHandle } from './server';

// ---------------------------------------------------------------------------
// Dual-runner test() shim
// ---------------------------------------------------------------------------

type TestFn = (name: string, fn: () => void | Promise<void>) => void;

const test: TestFn = (((): TestFn => {
    if (process.env.VITEST) {
        const gt = (globalThis as { test?: TestFn }).test;
        if (typeof gt !== 'function') {
            throw new Error(
                'server.spec.ts: VITEST=true but globalThis.test is missing — '
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
// Fake worker-api harness — same shape as `investigation-routes.test.ts` /
// `server.crud.test.ts` so the three suites are obviously cut from the same
// cloth.
// ---------------------------------------------------------------------------

interface CapturedRequest {
    readonly method: string;
    readonly url: string;
    readonly body: string;
    readonly headers: http.IncomingHttpHeaders;
}

interface FakeUpstream {
    readonly url: string;
    readonly captured: CapturedRequest[];
    setNextResponse(status: number, body: string): void;
    close(): Promise<void>;
}

async function startFakeUpstream(): Promise<FakeUpstream> {
    const captured: CapturedRequest[] = [];
    let next = { status: 200, body: JSON.stringify({ ok: true }) };
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
            captured.push({
                method: req.method ?? '',
                url: req.url ?? '',
                body: Buffer.concat(chunks).toString('utf8'),
                headers: req.headers,
            });
            res.writeHead(next.status, { 'Content-Type': 'application/json' });
            res.end(next.body);
        });
    });
    await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', () => resolve()),
    );
    const addr = server.address() as { port: number };
    return {
        url: `http://127.0.0.1:${addr.port}`,
        captured,
        setNextResponse(status, body): void {
            next = { status, body };
        },
        close: () =>
            new Promise<void>((resolve) => {
                server.close(() => resolve());
            }),
    };
}

async function withHarness(
    upstreamOpts: { token?: string } = {},
    fn: (board: BoardUiServerHandle, upstream: FakeUpstream) => Promise<void>,
): Promise<void> {
    const upstream = await startFakeUpstream();
    const board = await start({
        port: 0,
        workerApiUrl: upstream.url,
        workerApiToken: upstreamOpts.token,
    });
    try {
        await fn(board, upstream);
    } finally {
        await board.stop();
        await upstream.close();
    }
}

function boardUrl(board: BoardUiServerHandle, path: string): string {
    return `http://127.0.0.1:${board.port}${path}`;
}

// ---------------------------------------------------------------------------
// AC #1 — the three wave 1 projection routes proxy through to the upstream.
// ---------------------------------------------------------------------------

test('GET /api/projects/:pid/plans/:planId/decompose-status proxies to the worker-api', async () => {
    await withHarness({}, async (board, upstream) => {
        upstream.setNextResponse(
            200,
            JSON.stringify({ status: 'idle', progress: 0 }),
        );
        const res = await fetch(
            boardUrl(board, '/api/projects/proj-1/plans/plan-7/decompose-status'),
        );

        assert.equal(res.status, 200);
        assert.equal(upstream.captured.length, 1);
        assert.equal(upstream.captured[0].method, 'GET');
        assert.equal(
            upstream.captured[0].url,
            '/api/projects/proj-1/plans/plan-7/decompose-status',
        );
        const body = (await res.json()) as { status: string; progress: number };
        assert.equal(body.status, 'idle');
    });
});

test('GET /api/projects/:pid/plans/:planId/plan-review proxies to the worker-api', async () => {
    await withHarness({}, async (board, upstream) => {
        upstream.setNextResponse(
            200,
            JSON.stringify({ review: 'pending', notes: [] }),
        );
        const res = await fetch(
            boardUrl(board, '/api/projects/proj-2/plans/plan-9/plan-review'),
        );

        assert.equal(res.status, 200);
        assert.equal(upstream.captured.length, 1);
        assert.equal(upstream.captured[0].method, 'GET');
        assert.equal(
            upstream.captured[0].url,
            '/api/projects/proj-2/plans/plan-9/plan-review',
        );
    });
});

test('POST /api/projects/:pid/plans/:planId/plan-review/regenerate proxies to the worker-api with the request body', async () => {
    await withHarness({}, async (board, upstream) => {
        upstream.setNextResponse(202, JSON.stringify({ accepted: true }));
        const res = await fetch(
            boardUrl(
                board,
                '/api/projects/proj-3/plans/plan-42/plan-review/regenerate',
            ),
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ reason: 'stale' }),
            },
        );

        assert.equal(res.status, 202);
        assert.equal(upstream.captured.length, 1);
        assert.equal(upstream.captured[0].method, 'POST');
        assert.equal(
            upstream.captured[0].url,
            '/api/projects/proj-3/plans/plan-42/plan-review/regenerate',
        );
        assert.deepEqual(JSON.parse(upstream.captured[0].body), { reason: 'stale' });
    });
});

test('GET /api/flow-stages proxies to the worker-api (P-IFPC-001)', async () => {
    await withHarness({}, async (board, upstream) => {
        upstream.setNextResponse(
            200,
            JSON.stringify({ implement: [{ id: 'develop', label: 'Develop' }] }),
        );
        const res = await fetch(boardUrl(board, '/api/flow-stages'));

        assert.equal(res.status, 200);
        assert.equal(upstream.captured.length, 1);
        assert.equal(upstream.captured[0].method, 'GET');
        assert.equal(upstream.captured[0].url, '/api/flow-stages');
    });
});

test('GET /api/projects/:pid/plans/:planId/tasks/:taskId/diff proxies to the worker-api (AP-IFF-010)', async () => {
    await withHarness({}, async (board, upstream) => {
        upstream.setNextResponse(200, JSON.stringify({ files: [] }));
        const res = await fetch(
            boardUrl(
                board,
                '/api/projects/proj-5/plans/plan-3/tasks/task-7/diff',
            ),
        );

        assert.equal(res.status, 200);
        assert.equal(upstream.captured.length, 1);
        assert.equal(upstream.captured[0].method, 'GET');
        assert.equal(
            upstream.captured[0].url,
            '/api/projects/proj-5/plans/plan-3/tasks/task-7/diff',
        );
    });
});

test('proxy preserves the query string on the wave 1 routes', async () => {
    await withHarness({}, async (board, upstream) => {
        await fetch(
            boardUrl(
                board,
                '/api/projects/p/plans/q/decompose-status?since=42',
            ),
        );
        assert.equal(upstream.captured.length, 1);
        assert.equal(
            upstream.captured[0].url,
            '/api/projects/p/plans/q/decompose-status?since=42',
        );
    });
});

test('special-charactered ids in the path are forwarded URL-encoded', async () => {
    await withHarness({}, async (board, upstream) => {
        // `%2F`-encoded slash and a hyphen in the planId — the regex
        // matches because `[^/]+` covers everything except a literal
        // slash, and the encoded slash never reaches the path-split step.
        await fetch(
            boardUrl(
                board,
                '/api/projects/proj.with-dots/plans/plan%2Da/plan-review',
            ),
        );
        assert.equal(upstream.captured.length, 1);
        assert.equal(
            upstream.captured[0].url,
            '/api/projects/proj.with-dots/plans/plan%2Da/plan-review',
        );
    });
});

// ---------------------------------------------------------------------------
// AC #2 — existing /events SSE and /commands routes still work.
// ---------------------------------------------------------------------------

test('POST /commands still proxies after adding the wave 1 routes', async () => {
    await withHarness({}, async (board, upstream) => {
        upstream.setNextResponse(202, JSON.stringify({ events: [] }));
        const res = await fetch(boardUrl(board, '/commands'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                type: 'Noop',
                actor: 'operator',
                issuedAt: 1,
                payload: {},
            }),
        });

        assert.equal(res.status, 202);
        assert.equal(upstream.captured.length, 1);
        assert.equal(upstream.captured[0].method, 'POST');
        assert.equal(upstream.captured[0].url, '/commands');
        const cmd = JSON.parse(upstream.captured[0].body) as { type: string };
        assert.equal(cmd.type, 'Noop');
    });
});

test('GET /events still proxies as an SSE stream', async () => {
    await withHarness({}, async (board, upstream) => {
        // Configure the upstream to respond with an SSE content-type so we
        // can observe a real proxy round-trip rather than a JSON 200.
        upstream.setNextResponse(200, 'data: hello\n\n');
        const res = await fetch(boardUrl(board, '/events'));
        assert.equal(res.status, 200);
        assert.equal(upstream.captured.length, 1);
        assert.equal(upstream.captured[0].method, 'GET');
        assert.equal(upstream.captured[0].url, '/events');
        // Drain the body so the connection closes cleanly under both runners.
        await res.text();
    });
});

// ---------------------------------------------------------------------------
// AC #3 — `withWorkerAuth` propagates: the Bearer token is injected on the
// upstream request for every proxy-path family, not just for /commands.
// ---------------------------------------------------------------------------

test('Authorization: Bearer is injected upstream on the decompose-status route', async () => {
    await withHarness({ token: 'wave1-secret' }, async (board, upstream) => {
        await fetch(
            boardUrl(board, '/api/projects/p/plans/q/decompose-status'),
        );
        assert.equal(upstream.captured.length, 1);
        assert.equal(
            upstream.captured[0].headers.authorization,
            'Bearer wave1-secret',
        );
    });
});

test('Authorization: Bearer is injected upstream on the plan-review route', async () => {
    await withHarness({ token: 'wave1-secret' }, async (board, upstream) => {
        await fetch(boardUrl(board, '/api/projects/p/plans/q/plan-review'));
        assert.equal(upstream.captured.length, 1);
        assert.equal(
            upstream.captured[0].headers.authorization,
            'Bearer wave1-secret',
        );
    });
});

test('Authorization: Bearer is injected upstream on the plan-review/regenerate route', async () => {
    await withHarness({ token: 'wave1-secret' }, async (board, upstream) => {
        await fetch(
            boardUrl(
                board,
                '/api/projects/p/plans/q/plan-review/regenerate',
            ),
            { method: 'POST' },
        );
        assert.equal(upstream.captured.length, 1);
        assert.equal(
            upstream.captured[0].headers.authorization,
            'Bearer wave1-secret',
        );
    });
});

test('Authorization: Bearer is not added when no token is configured', async () => {
    await withHarness({}, async (board, upstream) => {
        await fetch(
            boardUrl(board, '/api/projects/p/plans/q/decompose-status'),
        );
        assert.equal(upstream.captured.length, 1);
        assert.equal(upstream.captured[0].headers.authorization, undefined);
    });
});

// ---------------------------------------------------------------------------
// Negative cases — adjacent paths that should NOT proxy. These would 404
// against the static handler (the allow-list rules out anything outside
// `index.html`, `board.js`, `board.css`), so the upstream must never see
// them.
// ---------------------------------------------------------------------------

test('paths that share a prefix but not the suffix do not proxy', async () => {
    await withHarness({}, async (board, upstream) => {
        const res = await fetch(
            boardUrl(
                board,
                '/api/projects/p/plans/q/something-else',
            ),
        );
        assert.equal(res.status, 404);
        assert.equal(upstream.captured.length, 0);
    });
});

test('paths with an extra trailing segment after plan-review do not proxy', async () => {
    await withHarness({}, async (board, upstream) => {
        const res = await fetch(
            boardUrl(
                board,
                '/api/projects/p/plans/q/plan-review/extra',
            ),
        );
        assert.equal(res.status, 404);
        assert.equal(upstream.captured.length, 0);
    });
});

test('paths missing the projectId or planId segment do not proxy', async () => {
    await withHarness({}, async (board, upstream) => {
        const res = await fetch(
            boardUrl(board, '/api/projects//plans//decompose-status'),
        );
        // The regex requires at least one non-slash char per id segment, so
        // empty ids must not match.
        assert.equal(res.status, 404);
        assert.equal(upstream.captured.length, 0);
    });
});

// ---------------------------------------------------------------------------
// AP-FP-005 — GET /api/projects and GET /api/projects/:pid/plans proxy to
// the AP-FP-004 read-side projections on the worker-api. The same paths
// already host write REST routes (POST /api/projects → CreateProject,
// POST /api/projects/:pid/plans → CreatePlan); the dispatcher must keep
// matching those before the proxy fallback fires for GETs.
// ---------------------------------------------------------------------------

test('GET /api/projects proxies to the worker-api (AP-FP-005)', async () => {
    await withHarness({}, async (board, upstream) => {
        upstream.setNextResponse(
            200,
            JSON.stringify({ projects: [{ id: 'proj-1', name: 'p1' }] }),
        );
        const res = await fetch(boardUrl(board, '/api/projects'));

        assert.equal(res.status, 200);
        assert.equal(upstream.captured.length, 1);
        assert.equal(upstream.captured[0].method, 'GET');
        assert.equal(upstream.captured[0].url, '/api/projects');
        const body = (await res.json()) as { projects: { id: string }[] };
        assert.equal(body.projects[0].id, 'proj-1');
    });
});

test('GET /api/projects/:pid/plans proxies to the worker-api (AP-FP-005)', async () => {
    await withHarness({}, async (board, upstream) => {
        upstream.setNextResponse(
            200,
            JSON.stringify({ plans: [{ id: 'plan-7', title: 't7' }] }),
        );
        const res = await fetch(
            boardUrl(board, '/api/projects/proj-1/plans'),
        );

        assert.equal(res.status, 200);
        assert.equal(upstream.captured.length, 1);
        assert.equal(upstream.captured[0].method, 'GET');
        assert.equal(upstream.captured[0].url, '/api/projects/proj-1/plans');
    });
});

test('GET /api/projects preserves the query string (AP-FP-005)', async () => {
    await withHarness({}, async (board, upstream) => {
        await fetch(boardUrl(board, '/api/projects?limit=10'));
        assert.equal(upstream.captured.length, 1);
        assert.equal(upstream.captured[0].url, '/api/projects?limit=10');
    });
});

test('Authorization: Bearer is injected upstream on GET /api/projects (AP-FP-005)', async () => {
    await withHarness({ token: 'fp005-secret' }, async (board, upstream) => {
        await fetch(boardUrl(board, '/api/projects'));
        assert.equal(upstream.captured.length, 1);
        assert.equal(
            upstream.captured[0].headers.authorization,
            'Bearer fp005-secret',
        );
    });
});

test('Authorization: Bearer is injected upstream on GET /api/projects/:pid/plans (AP-FP-005)', async () => {
    await withHarness({ token: 'fp005-secret' }, async (board, upstream) => {
        await fetch(boardUrl(board, '/api/projects/proj-1/plans'));
        assert.equal(upstream.captured.length, 1);
        assert.equal(
            upstream.captured[0].headers.authorization,
            'Bearer fp005-secret',
        );
    });
});

test('POST /api/projects still routes through the REST→CommandBus path, not the proxy (AP-FP-005 regression)', async () => {
    // The proxy regex /^\/api\/projects$/ matches POST as well as GET, so
    // the dispatcher MUST run the method-aware REST matcher first; otherwise
    // a POST here would be raw-forwarded and never become a CreateProject
    // command. We assert by shape: the upstream sees a `/commands` POST
    // carrying a `CreateProject` envelope, not a POST to `/api/projects`.
    await withHarness({}, async (board, upstream) => {
        upstream.setNextResponse(202, JSON.stringify({ ok: true }));
        const res = await fetch(boardUrl(board, '/api/projects'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectId: 'p1', name: 'P1' }),
        });

        assert.equal(res.status, 202);
        assert.equal(upstream.captured.length, 1);
        assert.equal(upstream.captured[0].method, 'POST');
        assert.equal(upstream.captured[0].url, '/commands');
        const envelope = JSON.parse(upstream.captured[0].body) as {
            type: string;
            payload: { projectId: string; name: string };
        };
        assert.equal(envelope.type, 'CreateProject');
        assert.equal(envelope.payload.projectId, 'p1');
        assert.equal(envelope.payload.name, 'P1');
    });
});

test('POST /api/projects/:pid/plans still routes through the REST→CommandBus path (AP-FP-005 regression)', async () => {
    await withHarness({}, async (board, upstream) => {
        upstream.setNextResponse(202, JSON.stringify({ ok: true }));
        const res = await fetch(
            boardUrl(board, '/api/projects/proj-1/plans'),
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    planId: 'plan-7',
                    title: 't',
                    tasks: [],
                }),
            },
        );

        assert.equal(res.status, 202);
        assert.equal(upstream.captured.length, 1);
        assert.equal(upstream.captured[0].method, 'POST');
        assert.equal(upstream.captured[0].url, '/commands');
        const envelope = JSON.parse(upstream.captured[0].body) as {
            type: string;
            payload: { projectId: string; planId: string };
        };
        assert.equal(envelope.type, 'CreatePlan');
        assert.equal(envelope.payload.projectId, 'proj-1');
        assert.equal(envelope.payload.planId, 'plan-7');
    });
});
