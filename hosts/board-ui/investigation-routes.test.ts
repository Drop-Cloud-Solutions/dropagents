import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as http from 'node:http';

import { start, type BoardUiServerHandle } from './server';

// ---------------------------------------------------------------------------
// Fake worker-api used as the proxy upstream. Captures every request so the
// tests can assert the translated Command shape; configurable next-response
// lets a single test exercise both happy-path and upstream-failure branches.
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
    let next = { status: 202, body: JSON.stringify({ events: [] }) };
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
// AC #2 — POST /commands/implement-from-investigation returns 202 and
// dispatches a fully-formed ImplementFromInvestigation Command upstream.
// ---------------------------------------------------------------------------

test('POST /commands/implement-from-investigation builds a Command and proxies it to /commands, returning 202', async () => {
    await withHarness({}, async (board, upstream) => {
        const res = await fetch(
            boardUrl(board, '/commands/implement-from-investigation'),
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ taskId: 'task-1', reportId: 'r-7' }),
            },
        );

        assert.equal(res.status, 202);
        assert.equal(upstream.captured.length, 1);
        assert.equal(upstream.captured[0].method, 'POST');
        assert.equal(upstream.captured[0].url, '/commands');

        const cmd = JSON.parse(upstream.captured[0].body) as {
            type: string;
            actor: string;
            issuedAt: number;
            payload: unknown;
        };
        assert.equal(cmd.type, 'ImplementFromInvestigation');
        assert.equal(typeof cmd.actor, 'string');
        assert.equal(cmd.actor.length > 0, true);
        assert.equal(typeof cmd.issuedAt, 'number');
        assert.deepEqual(cmd.payload, { taskId: 'task-1', reportId: 'r-7' });
    });
});

// ---------------------------------------------------------------------------
// AC #3 + AC #7 — Dismiss with a reason persists it on the dispatched
// command payload (the orchestrator-side handler then copies it onto the
// emitted InvestigationDismissed event).
// ---------------------------------------------------------------------------

test('POST /commands/dismiss-investigation forwards the reason on the Command payload', async () => {
    await withHarness({}, async (board, upstream) => {
        const res = await fetch(
            boardUrl(board, '/commands/dismiss-investigation'),
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    taskId: 't1',
                    reportId: 'r1',
                    reason: 'duplicate',
                }),
            },
        );

        assert.equal(res.status, 202);
        assert.equal(upstream.captured.length, 1);
        const cmd = JSON.parse(upstream.captured[0].body) as {
            type: string;
            payload: { taskId: string; reportId: string; reason?: string };
        };
        assert.equal(cmd.type, 'DismissInvestigation');
        assert.deepEqual(cmd.payload, {
            taskId: 't1',
            reportId: 'r1',
            reason: 'duplicate',
        });
    });
});

test('POST /commands/dismiss-investigation works without a reason and omits it from the payload', async () => {
    await withHarness({}, async (board, upstream) => {
        const res = await fetch(
            boardUrl(board, '/commands/dismiss-investigation'),
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ taskId: 't1', reportId: 'r1' }),
            },
        );
        assert.equal(res.status, 202);
        const cmd = JSON.parse(upstream.captured[0].body) as {
            payload: Record<string, unknown>;
        };
        assert.equal(
            Object.prototype.hasOwnProperty.call(cmd.payload, 'reason'),
            false,
        );
    });
});

// ---------------------------------------------------------------------------
// Validation — invalid bodies return 400 and never reach the upstream.
// ---------------------------------------------------------------------------

test('invalid JSON body on the implement route returns 400 without touching upstream', async () => {
    await withHarness({}, async (board, upstream) => {
        const res = await fetch(
            boardUrl(board, '/commands/implement-from-investigation'),
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: 'not json',
            },
        );
        assert.equal(res.status, 400);
        assert.equal(upstream.captured.length, 0);
    });
});

test('missing reportId on the implement route returns 400 without touching upstream', async () => {
    await withHarness({}, async (board, upstream) => {
        const res = await fetch(
            boardUrl(board, '/commands/implement-from-investigation'),
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ taskId: 'only-task' }),
            },
        );
        assert.equal(res.status, 400);
        assert.equal(upstream.captured.length, 0);
    });
});

test('non-string reason on the dismiss route returns 400 without touching upstream', async () => {
    await withHarness({}, async (board, upstream) => {
        const res = await fetch(
            boardUrl(board, '/commands/dismiss-investigation'),
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ taskId: 't', reportId: 'r', reason: 9 }),
            },
        );
        assert.equal(res.status, 400);
        assert.equal(upstream.captured.length, 0);
    });
});

// ---------------------------------------------------------------------------
// Method handling + auth header pass-through.
// ---------------------------------------------------------------------------

test('GET on an investigation route returns 405', async () => {
    await withHarness({}, async (board, upstream) => {
        const res = await fetch(
            boardUrl(board, '/commands/implement-from-investigation'),
            { method: 'GET' },
        );
        assert.equal(res.status, 405);
        assert.equal(upstream.captured.length, 0);
    });
});

test('Authorization: Bearer header is injected upstream when workerApiToken is configured', async () => {
    await withHarness({ token: 'shh' }, async (board, upstream) => {
        await fetch(
            boardUrl(board, '/commands/implement-from-investigation'),
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ taskId: 't', reportId: 'r' }),
            },
        );
        assert.equal(upstream.captured.length, 1);
        assert.equal(upstream.captured[0].headers.authorization, 'Bearer shh');
    });
});

test('upstream response status (not just 202) is mirrored back to the client', async () => {
    await withHarness({}, async (board, upstream) => {
        upstream.setNextResponse(500, JSON.stringify({ error: 'boom' }));
        const res = await fetch(
            boardUrl(board, '/commands/implement-from-investigation'),
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ taskId: 't', reportId: 'r' }),
            },
        );
        assert.equal(res.status, 500);
        const body = (await res.json()) as { error: string };
        assert.equal(body.error, 'boom');
    });
});
