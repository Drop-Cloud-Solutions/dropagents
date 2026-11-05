/**
 * Integration suite for the worker-log endpoints (AP-IFG-021).
 *
 * Two routes under test, both on the board-ui server:
 *   - `GET /api/worker/log` — snapshot, optionally sliced by `?since=`.
 *   - `GET /events/worker-log` — SSE tail that emits each newly-appended
 *     line as a `data:` frame.
 *
 * Each test boots the real `start()` against a temp-dir log file so we
 * can drive `fs.write` directly and observe the wire-level effect on
 * the endpoints. The log file is the same on-disk format produced by
 * `adapters/logging/file-logger.ts` — one JSON entry per newline — so
 * tests assert on that exact line format, matching the v1 contract the
 * later `worker-log-helpers.js` port will rely on.
 *
 * Dual-runner discovery
 * ---------------------
 * Same shim as `server.crud.test.ts`: vitest exposes its `test()` on
 * `globalThis` when `VITEST=true`, and `node --test` provides it via
 * `node:test`. Picking at module load lets a single file work under
 * both the local (`npm test`) and review-pipeline (`vitest run`) runs.
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { start, type BoardUiServerHandle } from './server';

// ---------------------------------------------------------------------------
// Dual-runner test() shim — see file header for rationale.
// ---------------------------------------------------------------------------

type TestFn = (name: string, fn: () => void | Promise<void>) => void;

const test: TestFn = (((): TestFn => {
    if (process.env.VITEST) {
        const gt = (globalThis as { test?: TestFn }).test;
        if (typeof gt !== 'function') {
            throw new Error(
                'server.worker-log.test.ts: VITEST=true but globalThis.test is missing — '
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
// Harness — temp-dir log file + booted server. The `workerApiUrl` is set to
// an unreachable origin because none of these tests hit the proxy; if a
// regression accidentally routes a worker-log request through the proxy the
// upstream-error fall-through would produce a 502 rather than the JSON shape
// we assert, making the regression obvious.
// ---------------------------------------------------------------------------

interface Harness {
    readonly board: BoardUiServerHandle;
    readonly logPath: string;
    readonly tmpDir: string;
    appendLog(text: string): void;
    rotateLog(newContent?: string): void;
    cleanup(): Promise<void>;
}

interface HarnessOptions {
    readonly workerApiToken?: string;
    /** Initial content written to the log before the server starts. */
    readonly initial?: string;
}

async function withHarness(
    fn: (h: Harness) => Promise<void>,
    options: HarnessOptions = {},
): Promise<void> {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-ui-worker-log-'));
    const logPath = path.join(tmpDir, 'worker.log');
    if (options.initial !== undefined) {
        fs.writeFileSync(logPath, options.initial, 'utf8');
    }
    const board = await start({
        port: 0,
        workerApiUrl: 'http://127.0.0.1:1', // intentionally unreachable
        workerApiToken: options.workerApiToken,
        workerLogPath: logPath,
    });
    const harness: Harness = {
        board,
        logPath,
        tmpDir,
        appendLog(text: string): void {
            fs.appendFileSync(logPath, text, 'utf8');
        },
        rotateLog(newContent = ''): void {
            // Mirror FileLogger's rotation: rename the active file and
            // open a fresh one in its place. The tests only need to
            // observe the inode/size flip, so the simpler shape works.
            const ext = path.extname(logPath);
            const base = ext ? logPath.slice(0, -ext.length) : logPath;
            const rotated = `${base}-rotated${ext}`;
            try {
                fs.renameSync(logPath, rotated);
            } catch (err) {
                if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
            }
            fs.writeFileSync(logPath, newContent, 'utf8');
        },
        async cleanup(): Promise<void> {
            await board.stop();
            try {
                fs.rmSync(tmpDir, { recursive: true, force: true });
            } catch {
                // best-effort
            }
        },
    };
    try {
        await fn(harness);
    } finally {
        await harness.cleanup();
    }
}

function boardUrl(board: BoardUiServerHandle, p: string): string {
    return `http://127.0.0.1:${board.port}${p}`;
}

interface SnapshotBody {
    readonly size: number;
    readonly content: string;
    readonly truncated: boolean;
}

async function getSnapshot(
    board: BoardUiServerHandle,
    qs = '',
    token?: string,
): Promise<{ status: number; body: SnapshotBody | { error: string } }> {
    const headers: Record<string, string> = {};
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetch(boardUrl(board, `/api/worker/log${qs}`), {
        method: 'GET',
        headers,
    });
    const body = (await res.json()) as SnapshotBody | { error: string };
    return { status: res.status, body };
}

// ---------------------------------------------------------------------------
// AC #1 — snapshot returns the current log content.
// ---------------------------------------------------------------------------

test('GET /api/worker/log returns the full current log content', async () => {
    const lines = [
        JSON.stringify({ ts: '2026-05-15T00:00:00.000Z', level: 'info', msg: 'one' }),
        JSON.stringify({ ts: '2026-05-15T00:00:01.000Z', level: 'info', msg: 'two' }),
    ].join('\n') + '\n';

    await withHarness(
        async ({ board }) => {
            const { status, body } = await getSnapshot(board);
            assert.equal(status, 200);
            const snap = body as SnapshotBody;
            assert.equal(snap.content, lines);
            assert.equal(snap.size, Buffer.byteLength(lines, 'utf8'));
            assert.equal(snap.truncated, false);
        },
        { initial: lines },
    );
});

test('GET /api/worker/log on a missing log file returns an empty snapshot', async () => {
    await withHarness(async ({ board }) => {
        const { status, body } = await getSnapshot(board);
        assert.equal(status, 200);
        const snap = body as SnapshotBody;
        assert.equal(snap.size, 0);
        assert.equal(snap.content, '');
        assert.equal(snap.truncated, false);
    });
});

// ---------------------------------------------------------------------------
// AC #1 / hint — ?since slices the log so a client can poll incrementally.
// ---------------------------------------------------------------------------

test('GET /api/worker/log?since=<offset> returns only the bytes past the offset', async () => {
    const head = JSON.stringify({ ts: 't1', level: 'info', msg: 'head' }) + '\n';
    const tail = JSON.stringify({ ts: 't2', level: 'info', msg: 'tail' }) + '\n';

    await withHarness(
        async ({ board, appendLog }) => {
            const first = await getSnapshot(board);
            const firstBody = first.body as SnapshotBody;
            assert.equal(firstBody.content, head);
            assert.equal(firstBody.size, Buffer.byteLength(head, 'utf8'));

            appendLog(tail);
            const second = await getSnapshot(board, `?since=${firstBody.size}`);
            const secondBody = second.body as SnapshotBody;
            assert.equal(second.status, 200);
            assert.equal(secondBody.content, tail);
            assert.equal(secondBody.truncated, false);
            assert.equal(
                secondBody.size,
                Buffer.byteLength(head + tail, 'utf8'),
            );
        },
        { initial: head },
    );
});

test('GET /api/worker/log?since past EOF returns the whole file with truncated=true', async () => {
    // Models rotation: `since` carries over from a previous (larger) file
    // but the active file is now shorter, so the offset is stale.
    const fresh = JSON.stringify({ ts: 'tnew', level: 'info', msg: 'after rotate' }) + '\n';
    await withHarness(
        async ({ board }) => {
            const { status, body } = await getSnapshot(board, '?since=999999');
            assert.equal(status, 200);
            const snap = body as SnapshotBody;
            assert.equal(snap.truncated, true);
            assert.equal(snap.content, fresh);
            assert.equal(snap.size, Buffer.byteLength(fresh, 'utf8'));
        },
        { initial: fresh },
    );
});

test('GET /api/worker/log?since=<negative> returns 400', async () => {
    await withHarness(async ({ board }) => {
        const res = await fetch(boardUrl(board, '/api/worker/log?since=-1'));
        assert.equal(res.status, 400);
    });
});

// ---------------------------------------------------------------------------
// AC #3 — authentication.
// ---------------------------------------------------------------------------

test('GET /api/worker/log returns 401 with WWW-Authenticate when token is set and header is missing', async () => {
    await withHarness(
        async ({ board }) => {
            const res = await fetch(boardUrl(board, '/api/worker/log'));
            assert.equal(res.status, 401);
            assert.equal(res.headers.get('www-authenticate'), 'Bearer');
        },
        { workerApiToken: 's3cret', initial: 'x\n' },
    );
});

test('GET /api/worker/log returns 401 when the Bearer token is wrong', async () => {
    await withHarness(
        async ({ board }) => {
            const res = await fetch(boardUrl(board, '/api/worker/log'), {
                headers: { authorization: 'Bearer not-the-token' },
            });
            assert.equal(res.status, 401);
        },
        { workerApiToken: 's3cret', initial: 'x\n' },
    );
});

test('GET /api/worker/log accepts the request when the Bearer token matches', async () => {
    const line = JSON.stringify({ ts: 't', level: 'info', msg: 'authed' }) + '\n';
    await withHarness(
        async ({ board }) => {
            const { status, body } = await getSnapshot(board, '', 's3cret');
            assert.equal(status, 200);
            assert.equal((body as SnapshotBody).content, line);
        },
        { workerApiToken: 's3cret', initial: line },
    );
});

test('GET /events/worker-log returns 401 without the Bearer token', async () => {
    await withHarness(
        async ({ board }) => {
            const res = await fetch(boardUrl(board, '/events/worker-log'));
            assert.equal(res.status, 401);
            // Drain the body so the socket can be reused / closed cleanly.
            await res.text();
        },
        { workerApiToken: 's3cret' },
    );
});

// ---------------------------------------------------------------------------
// AC #2 — SSE tail streams newly-appended lines.
// ---------------------------------------------------------------------------

/**
 * Consume up to `count` `data:` events from an SSE response. Times out
 * after `timeoutMs` so a regression that never emits doesn't hang the
 * suite. Comment-prefixed heartbeats (`: hb`) and `event:` lines are
 * ignored — only payload frames count toward `count`.
 */
async function readSseDataEvents(
    res: Response,
    count: number,
    timeoutMs = 5000,
): Promise<string[]> {
    assert.ok(res.body, 'SSE response missing body');
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const collected: string[] = [];
    let pending = '';
    const deadline = Date.now() + timeoutMs;
    try {
        while (collected.length < count) {
            const remaining = deadline - Date.now();
            if (remaining <= 0) {
                throw new Error(
                    `SSE timeout: collected ${collected.length} of ${count} expected events`,
                );
            }
            const read = await Promise.race([
                reader.read(),
                new Promise<{ value: undefined; done: true }>((resolve) =>
                    setTimeout(() => resolve({ value: undefined, done: true }), remaining),
                ),
            ]);
            if (read.done) break;
            pending += decoder.decode(read.value as Uint8Array, { stream: true });
            // SSE frames are double-newline delimited.
            let sep = pending.indexOf('\n\n');
            while (sep !== -1 && collected.length < count) {
                const frame = pending.slice(0, sep);
                pending = pending.slice(sep + 2);
                for (const fline of frame.split('\n')) {
                    if (fline.startsWith('data: ')) {
                        collected.push(fline.slice('data: '.length));
                    }
                }
                sep = pending.indexOf('\n\n');
            }
        }
    } finally {
        await reader.cancel().catch(() => undefined);
    }
    return collected;
}

test('GET /events/worker-log streams each newly-appended line as a data frame', async () => {
    await withHarness(async ({ board, appendLog }) => {
        const controller = new AbortController();
        const res = await fetch(boardUrl(board, '/events/worker-log'), {
            signal: controller.signal,
        });
        assert.equal(res.status, 200);
        assert.match(
            res.headers.get('content-type') ?? '',
            /text\/event-stream/,
        );

        // Give the server a moment to install its poll loop, then write.
        await new Promise((r) => setTimeout(r, 50));
        const line1 = JSON.stringify({ ts: 's1', level: 'info', msg: 'first' });
        const line2 = JSON.stringify({ ts: 's2', level: 'info', msg: 'second' });
        appendLog(line1 + '\n' + line2 + '\n');

        const events = await readSseDataEvents(res, 2);
        assert.deepEqual(events, [line1, line2]);
        controller.abort();
    });
});
