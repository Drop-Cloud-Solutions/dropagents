/**
 * Integration suite for the v1-compatible REST routes (AP-IFG-009).
 *
 * Every test boots the real `board-ui` server against a fake worker-api
 * upstream that records each incoming request. The assertions then
 * walk the captured Command bodies to verify:
 *
 *   - The right `Command.type` was emitted for each (method, path).
 *   - Path-extracted ids land on the payload (and override any
 *     same-named id field in the JSON body).
 *   - Malformed JSON / missing required fields short-circuit with 400
 *     and never touch the upstream (the no-mutation-outside-the-bus
 *     invariant — AC #3).
 *   - The whitelist `BOARD_UI_REST_ROUTES` is exported and round-trips
 *     a representative happy-path request for every entry (AC #4).
 *
 * Dual-runner discovery
 * ---------------------
 * The repo's own test command (`npm test` → `node --test --import tsx`,
 * see package.json) uses Node's built-in `node:test` runner. The review
 * pipeline however runs `npx vitest run` on the changed test file. A
 * file written against only one of those APIs gets reported as
 * "no tests" by the other and the pipeline rejects the run. The shim
 * below picks the right `test()` at module load: vitest sets
 * `process.env.VITEST=true` in its worker, so we route through vitest's
 * API there (via `globalThis.test`, enabled by `test.globals = true` in
 * vitest.config.ts) and through `node:test`'s API everywhere else. The
 * same pattern is documented in `commands.test.ts`.
 */
import * as assert from 'node:assert/strict';
import * as http from 'node:http';

import {
    BOARD_UI_REST_ROUTES,
    start,
    type BoardUiServerHandle,
} from './server';

// ---------------------------------------------------------------------------
// Dual-runner test() shim — see file header for rationale.
// ---------------------------------------------------------------------------

type TestFn = (name: string, fn: () => void | Promise<void>) => void;

const test: TestFn = (((): TestFn => {
    if (process.env.VITEST) {
        const gt = (globalThis as { test?: TestFn }).test;
        if (typeof gt !== 'function') {
            throw new Error(
                'server.crud.test.ts: VITEST=true but globalThis.test is missing — '
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
// Fake worker-api harness — same shape as investigation-routes.test.ts so the
// two suites are obviously cut from the same cloth.
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
    close(): Promise<void>;
}

interface FakeUpstreamOptions {
    readonly statusCode?: number;
}

async function startFakeUpstream(
    options: FakeUpstreamOptions = {},
): Promise<FakeUpstream> {
    const statusCode = options.statusCode ?? 202;
    const captured: CapturedRequest[] = [];
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
            res.writeHead(statusCode, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ events: [] }));
        });
    });
    await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', () => resolve()),
    );
    const addr = server.address() as { port: number };
    return {
        url: `http://127.0.0.1:${addr.port}`,
        captured,
        close: () =>
            new Promise<void>((resolve) => {
                server.close(() => resolve());
            }),
    };
}

interface HarnessOptions {
    readonly workerApiToken?: string;
    readonly upstreamStatusCode?: number;
}

async function withHarness(
    fn: (board: BoardUiServerHandle, upstream: FakeUpstream) => Promise<void>,
    options: HarnessOptions = {},
): Promise<void> {
    const upstream = await startFakeUpstream({
        statusCode: options.upstreamStatusCode,
    });
    const board = await start({
        port: 0,
        workerApiUrl: upstream.url,
        workerApiToken: options.workerApiToken,
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

interface CapturedCommand {
    readonly type: string;
    readonly actor: string;
    readonly issuedAt: number;
    readonly payload: Record<string, unknown>;
}

function parseCommand(req: CapturedRequest): CapturedCommand {
    return JSON.parse(req.body) as CapturedCommand;
}

// ---------------------------------------------------------------------------
// AC #4 — the whitelist is exported and complete.
// ---------------------------------------------------------------------------

test('BOARD_UI_REST_ROUTES covers every v1 mutating route shape', () => {
    const signatures = BOARD_UI_REST_ROUTES.map((r) => `${r.method} ${r.pattern}`);
    const expected = [
        'POST /api/projects',
        'PATCH /api/projects/:pid',
        'POST /api/projects/:pid/plans',
        'PATCH /api/projects/:pid/plans/:file',
        'DELETE /api/projects/:pid/plans/:file',
        'PUT /api/projects/:pid/plans/:file/tasks/:tid',
        'DELETE /api/projects/:pid/plans/:file/tasks/:tid',
        'POST /api/projects/:pid/investigations',
        'POST /api/projects/:pid/notes',
        'POST /api/projects/:pid/plans/:file/notes',
        'POST /api/projects/:pid/plans/:file/tasks/:tid/notes',
        'PATCH /api/notes/:nid',
        'DELETE /api/notes/:nid',
    ];
    for (const sig of expected) {
        assert.ok(
            signatures.includes(sig),
            `expected BOARD_UI_REST_ROUTES to include "${sig}", got: ${signatures.join(', ')}`,
        );
    }
});

// ---------------------------------------------------------------------------
// AC #1 / #2 — every REST route translates to exactly one Command dispatch.
// ---------------------------------------------------------------------------

test('POST /api/projects emits CreateProject with the JSON body as payload', async () => {
    await withHarness(async (board, upstream) => {
        const res = await fetch(boardUrl(board, '/api/projects'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Pipeline v2', description: 'note' }),
        });
        assert.equal(res.status, 202);
        assert.equal(upstream.captured.length, 1);
        assert.equal(upstream.captured[0].url, '/commands');
        const cmd = parseCommand(upstream.captured[0]);
        assert.equal(cmd.type, 'CreateProject');
        assert.equal(cmd.actor, 'operator');
        assert.deepEqual(cmd.payload, {
            name: 'Pipeline v2',
            description: 'note',
        });
    });
});

test('PATCH /api/projects/:pid emits UpdateProject with projectId from the URL', async () => {
    await withHarness(async (board, upstream) => {
        const res = await fetch(boardUrl(board, '/api/projects/p-42'), {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'renamed' }),
        });
        assert.equal(res.status, 202);
        const cmd = parseCommand(upstream.captured[0]);
        assert.equal(cmd.type, 'UpdateProject');
        assert.equal(cmd.payload.projectId, 'p-42');
        assert.equal(cmd.payload.name, 'renamed');
    });
});

test('PATCH /api/projects/:pid: URL projectId wins over a same-name body field', async () => {
    await withHarness(async (board, upstream) => {
        const res = await fetch(boardUrl(board, '/api/projects/p-url'), {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectId: 'p-body', name: 'renamed' }),
        });
        assert.equal(res.status, 202);
        const cmd = parseCommand(upstream.captured[0]);
        assert.equal(cmd.payload.projectId, 'p-url');
    });
});

test('POST /api/projects/:pid/plans emits CreatePlan with projectId from the URL', async () => {
    await withHarness(async (board, upstream) => {
        const res = await fetch(boardUrl(board, '/api/projects/p-1/plans'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: 'first plan' }),
        });
        assert.equal(res.status, 202);
        const cmd = parseCommand(upstream.captured[0]);
        assert.equal(cmd.type, 'CreatePlan');
        assert.equal(cmd.payload.projectId, 'p-1');
        assert.equal(cmd.payload.title, 'first plan');
    });
});

test('PATCH /api/projects/:pid/plans/:file emits UpdatePlan with planId from the URL', async () => {
    await withHarness(async (board, upstream) => {
        const res = await fetch(
            boardUrl(board, '/api/projects/p-1/plans/plan-7'),
            {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ title: 'updated' }),
            },
        );
        assert.equal(res.status, 202);
        const cmd = parseCommand(upstream.captured[0]);
        assert.equal(cmd.type, 'UpdatePlan');
        assert.equal(cmd.payload.planId, 'plan-7');
        assert.equal(cmd.payload.title, 'updated');
    });
});

test('DELETE /api/projects/:pid/plans/:file emits DeletePlan with planId from the URL', async () => {
    await withHarness(async (board, upstream) => {
        const res = await fetch(
            boardUrl(board, '/api/projects/p-1/plans/plan-7'),
            { method: 'DELETE' },
        );
        assert.equal(res.status, 202);
        const cmd = parseCommand(upstream.captured[0]);
        assert.equal(cmd.type, 'DeletePlan');
        assert.deepEqual(cmd.payload, { planId: 'plan-7' });
    });
});

test('PUT /api/projects/:pid/plans/:file/tasks/:tid emits EditTask with taskId from the URL', async () => {
    await withHarness(async (board, upstream) => {
        const res = await fetch(
            boardUrl(board, '/api/projects/p-1/plans/plan-7/tasks/t-99'),
            {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ title: 'new title', type: 'docs' }),
            },
        );
        assert.equal(res.status, 202);
        const cmd = parseCommand(upstream.captured[0]);
        assert.equal(cmd.type, 'EditTask');
        assert.equal(cmd.payload.taskId, 't-99');
        assert.equal(cmd.payload.title, 'new title');
        assert.equal(cmd.payload.type, 'docs');
    });
});

test('DELETE /api/projects/:pid/plans/:file/tasks/:tid emits DeleteTask', async () => {
    await withHarness(async (board, upstream) => {
        const res = await fetch(
            boardUrl(board, '/api/projects/p-1/plans/plan-7/tasks/t-99'),
            { method: 'DELETE' },
        );
        assert.equal(res.status, 202);
        const cmd = parseCommand(upstream.captured[0]);
        assert.equal(cmd.type, 'DeleteTask');
        assert.deepEqual(cmd.payload, { taskId: 't-99' });
    });
});

test('POST /api/projects/:pid/investigations emits CreateInvestigation from the JSON body', async () => {
    await withHarness(async (board, upstream) => {
        const res = await fetch(
            boardUrl(board, '/api/projects/p-1/investigations'),
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ taskId: 't-9', question: 'why?' }),
            },
        );
        assert.equal(res.status, 202);
        const cmd = parseCommand(upstream.captured[0]);
        assert.equal(cmd.type, 'CreateInvestigation');
        assert.deepEqual(cmd.payload, { taskId: 't-9', question: 'why?' });
    });
});

test('POST /api/projects/:pid/notes emits CreateNote with targetType=project and targetId from the URL', async () => {
    await withHarness(async (board, upstream) => {
        const res = await fetch(boardUrl(board, '/api/projects/p-1/notes'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ body: 'hello' }),
        });
        assert.equal(res.status, 202);
        const cmd = parseCommand(upstream.captured[0]);
        assert.equal(cmd.type, 'CreateNote');
        assert.equal(cmd.payload.targetType, 'project');
        assert.equal(cmd.payload.targetId, 'p-1');
        assert.equal(cmd.payload.body, 'hello');
    });
});

test('POST /api/projects/:pid/plans/:file/notes emits CreateNote with targetType=plan', async () => {
    await withHarness(async (board, upstream) => {
        const res = await fetch(
            boardUrl(board, '/api/projects/p-1/plans/plan-7/notes'),
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ body: 'plan note' }),
            },
        );
        assert.equal(res.status, 202);
        const cmd = parseCommand(upstream.captured[0]);
        assert.equal(cmd.type, 'CreateNote');
        assert.equal(cmd.payload.targetType, 'plan');
        assert.equal(cmd.payload.targetId, 'plan-7');
    });
});

test('POST /api/projects/:pid/plans/:file/tasks/:tid/notes emits CreateNote with targetType=task', async () => {
    await withHarness(async (board, upstream) => {
        const res = await fetch(
            boardUrl(board, '/api/projects/p-1/plans/plan-7/tasks/t-99/notes'),
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ body: 'task note' }),
            },
        );
        assert.equal(res.status, 202);
        const cmd = parseCommand(upstream.captured[0]);
        assert.equal(cmd.type, 'CreateNote');
        assert.equal(cmd.payload.targetType, 'task');
        assert.equal(cmd.payload.targetId, 't-99');
    });
});

test('PATCH /api/notes/:nid emits UpdateNote with noteId from the URL', async () => {
    await withHarness(async (board, upstream) => {
        const res = await fetch(boardUrl(board, '/api/notes/n-3'), {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ body: 'edited' }),
        });
        assert.equal(res.status, 202);
        const cmd = parseCommand(upstream.captured[0]);
        assert.equal(cmd.type, 'UpdateNote');
        assert.equal(cmd.payload.noteId, 'n-3');
        assert.equal(cmd.payload.body, 'edited');
    });
});

test('DELETE /api/notes/:nid emits DeleteNote', async () => {
    await withHarness(async (board, upstream) => {
        const res = await fetch(boardUrl(board, '/api/notes/n-3'), {
            method: 'DELETE',
        });
        assert.equal(res.status, 202);
        const cmd = parseCommand(upstream.captured[0]);
        assert.equal(cmd.type, 'DeleteNote');
        assert.deepEqual(cmd.payload, { noteId: 'n-3' });
    });
});

// ---------------------------------------------------------------------------
// AC #3 — body validation rejects malformed requests with 400 and never
// reaches the upstream.
// ---------------------------------------------------------------------------

test('POST /api/projects with invalid JSON returns 400 and never touches upstream', async () => {
    await withHarness(async (board, upstream) => {
        const res = await fetch(boardUrl(board, '/api/projects'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: 'not json',
        });
        assert.equal(res.status, 400);
        assert.equal(upstream.captured.length, 0);
    });
});

test('POST /api/projects without required name returns 400', async () => {
    await withHarness(async (board, upstream) => {
        const res = await fetch(boardUrl(board, '/api/projects'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ description: 'no name field' }),
        });
        assert.equal(res.status, 400);
        const body = (await res.json()) as { error: string; commandType: string };
        assert.equal(body.error, 'invalid payload shape');
        assert.equal(body.commandType, 'CreateProject');
        assert.equal(upstream.captured.length, 0);
    });
});

test('POST /api/projects/:pid/plans without required title returns 400', async () => {
    await withHarness(async (board, upstream) => {
        const res = await fetch(boardUrl(board, '/api/projects/p-1/plans'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        });
        assert.equal(res.status, 400);
        assert.equal(upstream.captured.length, 0);
    });
});

test('POST /api/projects/:pid/investigations without question returns 400', async () => {
    await withHarness(async (board, upstream) => {
        const res = await fetch(
            boardUrl(board, '/api/projects/p-1/investigations'),
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ taskId: 't-1' }),
            },
        );
        assert.equal(res.status, 400);
        assert.equal(upstream.captured.length, 0);
    });
});

test('PUT task with non-string title in body returns 400', async () => {
    await withHarness(async (board, upstream) => {
        const res = await fetch(
            boardUrl(board, '/api/projects/p-1/plans/plan-7/tasks/t-99'),
            {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ title: 42 }),
            },
        );
        assert.equal(res.status, 400);
        assert.equal(upstream.captured.length, 0);
    });
});

// ---------------------------------------------------------------------------
// 404 on unmatched paths — guards against accidental wildcard matching by
// the regex compiler.
// ---------------------------------------------------------------------------

test('GET on a REST-only route falls through to the static handler (404)', async () => {
    await withHarness(async (board, upstream) => {
        // `/api/projects/:pid` has PATCH + DELETE REST routes today
        // (Update / Archive), no GET — and no matching proxy pattern.
        // A GET against the path should fall through to the static
        // handler's 404, not accidentally hit upstream. (Earlier this
        // test used `/api/projects` — but AP-FP-005 added that as a
        // GET proxy for the projects list, so the original path no
        // longer makes the same guarantee.)
        const res = await fetch(boardUrl(board, '/api/projects/some-project'), {
            method: 'GET',
        });
        assert.equal(res.status, 404);
        assert.equal(upstream.captured.length, 0);
    });
});

test('Unmatched /api/foo path does not reach upstream', async () => {
    await withHarness(async (board, upstream) => {
        const res = await fetch(boardUrl(board, '/api/foo/bar'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
        });
        // A POST to an unmatched path falls through to the static handler,
        // which rejects non-GET/HEAD methods with 405. Either way the
        // important guarantee — that the path didn't accidentally match a
        // REST route and dispatch a Command — is captured by the upstream
        // assertion: nothing reached the worker-api.
        assert.ok(
            res.status >= 400 && res.status < 500,
            `expected 4xx for unmatched path, got ${res.status}`,
        );
        assert.equal(upstream.captured.length, 0);
    });
});

// ---------------------------------------------------------------------------
// URL encoding — percent-encoded path params round-trip through decodeURIComponent.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Upstream auth — when `workerApiToken` is configured, the board-ui must
// inject `Authorization: Bearer <token>` on the proxied /commands request,
// and any upstream auth failure (401) must propagate back to the caller
// unchanged so the operator sees the real reason their request was denied.
// ---------------------------------------------------------------------------

test('REST command proxies Authorization: Bearer <token> when workerApiToken is configured', async () => {
    await withHarness(
        async (board, upstream) => {
            const res = await fetch(boardUrl(board, '/api/projects'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'authed' }),
            });
            assert.equal(res.status, 202);
            assert.equal(upstream.captured.length, 1);
            assert.equal(upstream.captured[0].url, '/commands');
            assert.equal(
                upstream.captured[0].headers.authorization,
                'Bearer s3cret-token',
            );
        },
        { workerApiToken: 's3cret-token' },
    );
});

test('Upstream 401 on a REST command propagates back to the caller as 401', async () => {
    await withHarness(
        async (board, upstream) => {
            const res = await fetch(boardUrl(board, '/api/projects'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'authed' }),
            });
            assert.equal(res.status, 401);
            // Upstream was reached — proxy didn't swallow the request.
            assert.equal(upstream.captured.length, 1);
            assert.equal(
                upstream.captured[0].headers.authorization,
                'Bearer wrong-token',
            );
        },
        { workerApiToken: 'wrong-token', upstreamStatusCode: 401 },
    );
});

test('Percent-encoded path params are decoded onto the command payload', async () => {
    await withHarness(async (board, upstream) => {
        const res = await fetch(boardUrl(board, '/api/projects/p%2D42'), {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'x' }),
        });
        assert.equal(res.status, 202);
        const cmd = parseCommand(upstream.captured[0]);
        // %2D decodes to '-' regardless of parser quirks around reserved chars.
        assert.equal(cmd.payload.projectId, 'p-42');
    });
});
