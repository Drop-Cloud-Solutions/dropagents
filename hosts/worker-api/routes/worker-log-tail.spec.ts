/**
 * Spec for AP-IFF-017 — worker log snapshot + SSE tail.
 *
 * Coverage matches the four acceptance criteria:
 *   1. snapshot returns the last 500 lines filtered by level,
 *   2. tail emits each newly-appended line as a `data:` SSE frame,
 *   3. the level filter recognises info / warn / error (and rejects
 *      anything else with a 400 from the request handler),
 *   4. all three behaviours are unit-tested against a fixture log file.
 *
 * The tail loop is exercised with `autoPoll: false` and the
 * `tick()` seam exposed by {@link startWorkerLogTail}. That makes the
 * suite deterministic — no timer races — while still driving the same
 * code path the production handler runs (polling state machine, line
 * buffering, rotation reset, frame format).
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    DEFAULT_SNAPSHOT_LIMIT,
    WORKER_LOG_SNAPSHOT_ROUTE,
    WORKER_LOG_TAIL_ROUTE,
    extractLineLevel,
    formatSseDataFrame,
    handleSnapshotRequest,
    handleTailRequest,
    lineMatchesLevel,
    parseLevelParam,
    readSnapshot,
    selectSnapshotLines,
    startWorkerLogTail,
    type SseSink,
    type WorkerLogLevel,
} from './worker-log-tail';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonLine(level: string, msg: string, extra?: Record<string, unknown>): string {
    return JSON.stringify({
        ts: new Date().toISOString(),
        level,
        msg,
        ...(extra ?? {}),
    });
}

function withTempLog(initial: string | null = null): { dir: string; logPath: string; cleanup: () => void } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-log-tail-'));
    const logPath = path.join(dir, 'worker.log');
    if (initial !== null) fs.writeFileSync(logPath, initial, 'utf8');
    return {
        dir,
        logPath,
        cleanup(): void {
            try {
                fs.rmSync(dir, { recursive: true, force: true });
            } catch {
                // best-effort
            }
        },
    };
}

/**
 * Minimal {@link SseSink} for the tail tests. Records every write so
 * the spec can assert on the literal byte stream (frames in order,
 * heartbeats, rotation markers).
 */
class RecordingSink implements SseSink {
    public head: { status: number; headers: Readonly<Record<string, string>> } | null = null;
    public chunks: string[] = [];
    public ended = false;
    writeHead(status: number, headers: Readonly<Record<string, string>>): void {
        this.head = { status, headers };
    }
    write(chunk: string): void {
        this.chunks.push(chunk);
    }
    end(): void {
        this.ended = true;
    }
    /** All `data: …\n\n` payloads in arrival order — heartbeats / event lines filtered out. */
    dataFrames(): string[] {
        const out: string[] = [];
        for (const c of this.chunks) {
            if (c.startsWith('data: ') && c.endsWith('\n\n')) {
                out.push(c.slice('data: '.length, -2));
            }
        }
        return out;
    }
}

/**
 * Hand-rolled fake `http.ServerResponse` so the spec can drive the
 * snapshot handler without standing up a real server. Captures the
 * status, headers, and concatenated body so the assertions match what
 * a fetched response would see.
 */
class FakeResponse {
    public status = 0;
    public headers: Record<string, string> = {};
    public body = '';
    private ended = false;
    writeHead(status: number, headers: Record<string, string>): void {
        this.status = status;
        this.headers = { ...headers };
    }
    write(_chunk: string): void {
        // Snapshot handler does not stream — kept for shape parity.
    }
    end(chunk?: string): void {
        if (chunk) this.body += chunk;
        this.ended = true;
    }
    flushHeaders(): void {
        /* no-op */
    }
    on(_event: string, _listener: () => void): this {
        return this;
    }
    isEnded(): boolean {
        return this.ended;
    }
}

function fakeReq(url: string): { url: string; on(event: string, listener: () => void): unknown } {
    return {
        url,
        on(_event: string, _listener: () => void): unknown {
            return this;
        },
    };
}

// ---------------------------------------------------------------------------
// Route pattern contract
// ---------------------------------------------------------------------------

test('route patterns match the URL surface documented in the brief', () => {
    assert.equal(WORKER_LOG_SNAPSHOT_ROUTE, '/api/worker-log/snapshot');
    assert.equal(WORKER_LOG_TAIL_ROUTE, '/api/worker-log/tail');
});

// ---------------------------------------------------------------------------
// AC #3 — level filter recognises info / warn / error
// ---------------------------------------------------------------------------

test('AC #3 — parseLevelParam accepts info / warn / error and returns null for absent', () => {
    assert.equal(parseLevelParam(null), null);
    assert.equal(parseLevelParam(undefined), null);
    assert.equal(parseLevelParam(''), null);
    assert.equal(parseLevelParam('info'), 'info');
    assert.equal(parseLevelParam('warn'), 'warn');
    assert.equal(parseLevelParam('error'), 'error');
});

test('AC #3 — parseLevelParam is case-insensitive and normalises to the canonical lowercase form', () => {
    // Per the review checklist item "Level filter case-insensitive":
    // every casing of a valid level normalises to its lowercase form.
    assert.equal(parseLevelParam('INFO'), 'info');
    assert.equal(parseLevelParam('Info'), 'info');
    assert.equal(parseLevelParam('iNfO'), 'info');
    assert.equal(parseLevelParam('Warn'), 'warn');
    assert.equal(parseLevelParam('WARN'), 'warn');
    assert.equal(parseLevelParam('ERROR'), 'error');
    assert.equal(parseLevelParam('Error'), 'error');
});

test('AC #3 — parseLevelParam throws on an unknown level (so the route returns 400 instead of widening)', () => {
    assert.throws(() => parseLevelParam('debug'), RangeError);
    assert.throws(() => parseLevelParam('fatal'), RangeError);
    // Unknown levels stay rejected regardless of casing — only the set of
    // accepted names is case-insensitive, not the set itself.
    assert.throws(() => parseLevelParam('DEBUG'), RangeError);
    assert.throws(() => parseLevelParam('Trace'), RangeError);
});

test('extractLineLevel pulls the level field out of a FileLogger-shaped JSON line', () => {
    assert.equal(extractLineLevel(jsonLine('info', 'hi')), 'info');
    assert.equal(extractLineLevel(jsonLine('warn', 'careful')), 'warn');
    assert.equal(extractLineLevel(jsonLine('error', 'boom')), 'error');
    assert.equal(extractLineLevel(jsonLine('debug', 'verbose')), 'debug');
    assert.equal(extractLineLevel('not json'), null);
    assert.equal(extractLineLevel(''), null);
    assert.equal(extractLineLevel(JSON.stringify({ ts: 't', msg: 'no level' })), null);
});

test('AC #3 — lineMatchesLevel only admits same-level lines when a filter is set', () => {
    const info = jsonLine('info', 'a');
    const warn = jsonLine('warn', 'b');
    const error = jsonLine('error', 'c');
    const debug = jsonLine('debug', 'd');

    assert.equal(lineMatchesLevel(info, 'info'), true);
    assert.equal(lineMatchesLevel(warn, 'info'), false);
    assert.equal(lineMatchesLevel(error, 'warn'), false);
    assert.equal(lineMatchesLevel(error, 'error'), true);
    // No filter → every line passes (including non-matching debug).
    assert.equal(lineMatchesLevel(debug, null), true);
    assert.equal(lineMatchesLevel(info, null), true);
    // Explicit filter excludes unknown levels — see module docstring.
    assert.equal(lineMatchesLevel(debug, 'info'), false);
});

// ---------------------------------------------------------------------------
// AC #1 — snapshot: last 500 lines, filtered
// ---------------------------------------------------------------------------

test('AC #1 — selectSnapshotLines returns the last DEFAULT_SNAPSHOT_LIMIT lines when no filter is set', () => {
    const lines: string[] = [];
    for (let i = 0; i < 750; i++) lines.push(jsonLine('info', `m${i}`));
    const content = lines.join('\n') + '\n';
    const out = selectSnapshotLines(content, null);
    assert.equal(out.length, DEFAULT_SNAPSHOT_LIMIT);
    // Slice is from the tail of the input — first surviving line is at index 250.
    assert.equal(out[0], lines[250]);
    assert.equal(out[out.length - 1], lines[749]);
});

test('AC #1 — selectSnapshotLines filters by level before taking the last 500', () => {
    // 600 info lines interleaved with 600 warn lines → 1200 total.
    // Requesting `warn` should yield the last 500 warn lines only,
    // never an info line.
    const raw: string[] = [];
    const warns: string[] = [];
    for (let i = 0; i < 600; i++) {
        raw.push(jsonLine('info', `i${i}`));
        const w = jsonLine('warn', `w${i}`);
        raw.push(w);
        warns.push(w);
    }
    const content = raw.join('\n') + '\n';
    const out = selectSnapshotLines(content, 'warn');
    assert.equal(out.length, 500);
    // Every surviving line is `warn`.
    for (const line of out) assert.equal(extractLineLevel(line), 'warn');
    // The tail of the filtered set matches the last 500 warn lines.
    assert.deepEqual(out, warns.slice(warns.length - 500));
});

test('AC #1 — selectSnapshotLines handles short files without padding or empty entries', () => {
    const content = [
        jsonLine('info', 'a'),
        jsonLine('warn', 'b'),
        jsonLine('error', 'c'),
        '', // stray trailing blank from a final `\n`
    ].join('\n');
    const all = selectSnapshotLines(content, null);
    assert.equal(all.length, 3);
    const onlyError = selectSnapshotLines(content, 'error');
    assert.equal(onlyError.length, 1);
    assert.equal(extractLineLevel(onlyError[0]), 'error');
});

test('AC #1 — readSnapshot against a fixture log file returns the documented body shape', async () => {
    const fix = withTempLog(
        [
            jsonLine('info', 'one'),
            jsonLine('warn', 'two'),
            jsonLine('error', 'three'),
            jsonLine('info', 'four'),
        ].join('\n') + '\n',
    );
    try {
        const all = await readSnapshot(fix.logPath, null);
        assert.equal(all.status, 200);
        assert.equal((all.body.lines as string[]).length, 4);

        const warns = await readSnapshot(fix.logPath, 'warn');
        const warnLines = warns.body.lines as string[];
        assert.equal(warnLines.length, 1);
        assert.equal(extractLineLevel(warnLines[0]), 'warn');
    } finally {
        fix.cleanup();
    }
});

test('readSnapshot on a missing log file returns 200 with an empty lines array', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-log-tail-missing-'));
    try {
        const result = await readSnapshot(path.join(dir, 'never-written.log'), null);
        assert.equal(result.status, 200);
        assert.deepEqual(result.body, { lines: [] });
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// AC #2 — SSE tail emits newly-appended lines as `data: …\n\n` frames
// ---------------------------------------------------------------------------

test('AC #2 — startWorkerLogTail writes the SSE preamble headers up front', () => {
    const fix = withTempLog('');
    try {
        const sink = new RecordingSink();
        const handle = startWorkerLogTail({
            filePath: fix.logPath,
            level: null,
            sink,
            autoPoll: false,
        });
        try {
            assert.ok(sink.head, 'expected writeHead to fire on start');
            assert.equal(sink.head?.status, 200);
            assert.equal(sink.head?.headers['Content-Type'], 'text/event-stream');
            assert.equal(sink.head?.headers['Cache-Control'], 'no-cache, no-transform');
        } finally {
            handle.stop();
        }
    } finally {
        fix.cleanup();
    }
});

test('AC #2 / brief "SSE event format" — formatSseDataFrame emits exactly `data: <line>\\n\\n`', () => {
    const line = jsonLine('info', 'frame me');
    assert.equal(formatSseDataFrame(line), `data: ${line}\n\n`);
    // Embedded newlines are folded so the framing stays intact.
    assert.equal(formatSseDataFrame('a\nb'), 'data: a b\n\n');
});

/** A real newline — kept in a const so no escaping survives an edit. */
const LF = String.fromCharCode(10);

test('the first tick PRIMES: content already in the file is never replayed', async () => {
    // The behaviour four specs in this file were silently written against
    // and none asserted. A tail that replays the existing file SSE-frames
    // every line at once; on a busy log the board ran through thousands of
    // onmessage -> DOM appends and locked up for 10-15 seconds. The
    // snapshot endpoint owns the backlog; the tail owns what comes after.
    const existing = jsonLine('info', 'was here before the connection');
    const fix = withTempLog(existing + LF);
    try {
        const sink = new RecordingSink();
        const handle = startWorkerLogTail({
            filePath: fix.logPath,
            level: null,
            sink,
            autoPoll: false,
        });
        try {
            await handle.tick();
            assert.deepEqual(
                sink.dataFrames(), [],
                'the priming tick must not replay what was already there',
            );
            const fresh = jsonLine('info', 'arrived after');
            fs.appendFileSync(fix.logPath, fresh + LF, 'utf8');
            await handle.tick();
            assert.deepEqual(
                sink.dataFrames(), [fresh],
                'only the appended line is streamed',
            );
        } finally {
            handle.stop();
        }
    } finally {
        fix.cleanup();
    }
});

test('AC #2 — tail emits each newly-appended line as a single data frame, in order', async () => {
    const fix = withTempLog('');
    try {
        const sink = new RecordingSink();
        const handle = startWorkerLogTail({
            filePath: fix.logPath,
            level: null,
            sink,
            autoPoll: false,
        });
        try {
            // Prime. The FIRST tick sets the offset to the file's current
            // size and emits nothing — the tail's job is the live extension
            // from the moment the SSE connection settles, because the
            // snapshot endpoint already delivered the last 500 lines.
            // Without this skip the first poll SSE-framed the entire file
            // and the board froze for 10-15s on a busy log. These specs
            // predate that change and called tick() once, expecting frames.
            await handle.tick();
            const a = jsonLine('info', 'a');
            const b = jsonLine('warn', 'b');
            fs.appendFileSync(fix.logPath, a + '\n' + b + '\n', 'utf8');
            await handle.tick();
            assert.deepEqual(sink.dataFrames(), [a, b]);
            // Each frame is wrapped exactly as `data: <line>\n\n`.
            const frames = sink.chunks.filter((c) => c.startsWith('data: '));
            assert.equal(frames[0], `data: ${a}\n\n`);
            assert.equal(frames[1], `data: ${b}\n\n`);
        } finally {
            handle.stop();
        }
    } finally {
        fix.cleanup();
    }
});

test('AC #2 — tail buffers a partial trailing line and emits it once the newline arrives', async () => {
    const fix = withTempLog('');
    try {
        const sink = new RecordingSink();
        const handle = startWorkerLogTail({
            filePath: fix.logPath,
            level: null,
            sink,
            autoPoll: false,
        });
        try {
            // Prime. The FIRST tick sets the offset to the file's current
            // size and emits nothing — the tail's job is the live extension
            // from the moment the SSE connection settles, because the
            // snapshot endpoint already delivered the last 500 lines.
            // Without this skip the first poll SSE-framed the entire file
            // and the board froze for 10-15s on a busy log. These specs
            // predate that change and called tick() once, expecting frames.
            await handle.tick();
            const a = jsonLine('info', 'partial');
            // First write has no trailing newline — frame should NOT fire yet.
            fs.appendFileSync(fix.logPath, a, 'utf8');
            await handle.tick();
            assert.deepEqual(sink.dataFrames(), []);
            // Finishing the line releases the buffered frame.
            fs.appendFileSync(fix.logPath, '\n', 'utf8');
            await handle.tick();
            assert.deepEqual(sink.dataFrames(), [a]);
        } finally {
            handle.stop();
        }
    } finally {
        fix.cleanup();
    }
});

test('AC #2 + AC #3 — tail with level=error filters out non-matching lines on the live stream', async () => {
    const fix = withTempLog('');
    try {
        const sink = new RecordingSink();
        const handle = startWorkerLogTail({
            filePath: fix.logPath,
            level: 'error',
            sink,
            autoPoll: false,
        });
        try {
            // Prime. The FIRST tick sets the offset to the file's current
            // size and emits nothing — the tail's job is the live extension
            // from the moment the SSE connection settles, because the
            // snapshot endpoint already delivered the last 500 lines.
            // Without this skip the first poll SSE-framed the entire file
            // and the board froze for 10-15s on a busy log. These specs
            // predate that change and called tick() once, expecting frames.
            await handle.tick();
            const info = jsonLine('info', 'noise');
            const warn = jsonLine('warn', 'caution');
            const error = jsonLine('error', 'boom');
            fs.appendFileSync(
                fix.logPath,
                [info, warn, error, info, error].join('\n') + '\n',
                'utf8',
            );
            await handle.tick();
            const got = sink.dataFrames();
            assert.equal(got.length, 2);
            for (const line of got) assert.equal(extractLineLevel(line), 'error');
        } finally {
            handle.stop();
        }
    } finally {
        fix.cleanup();
    }
});

test('tail resets and emits an `event: rotated` frame when the file shrinks below the tracked offset', async () => {
    const fix = withTempLog('');
    try {
        const sink = new RecordingSink();
        const handle = startWorkerLogTail({
            filePath: fix.logPath,
            level: null,
            sink,
            autoPoll: false,
        });
        try {
            // Prime. The FIRST tick sets the offset to the file's current
            // size and emits nothing — the tail's job is the live extension
            // from the moment the SSE connection settles, because the
            // snapshot endpoint already delivered the last 500 lines.
            // Without this skip the first poll SSE-framed the entire file
            // and the board froze for 10-15s on a busy log. These specs
            // predate that change and called tick() once, expecting frames.
            await handle.tick();
            const a = jsonLine('info', 'before');
            fs.appendFileSync(fix.logPath, a + '\n', 'utf8');
            await handle.tick();
            assert.deepEqual(sink.dataFrames(), [a]);

            // Simulate rotation: replace the file with a smaller one.
            fs.writeFileSync(fix.logPath, '', 'utf8');
            await handle.tick();
            assert.ok(
                sink.chunks.some((c) => c.startsWith('event: rotated')),
                'expected a `event: rotated` frame after the file shrank',
            );

            const b = jsonLine('info', 'after');
            fs.appendFileSync(fix.logPath, b + '\n', 'utf8');
            await handle.tick();
            // The post-rotation line still arrives as a data frame.
            assert.ok(sink.dataFrames().includes(b));
        } finally {
            handle.stop();
        }
    } finally {
        fix.cleanup();
    }
});

// ---------------------------------------------------------------------------
// Request handler — wiring around the building blocks above
// ---------------------------------------------------------------------------

test('handleSnapshotRequest returns 400 on an unrecognised level', async () => {
    const res = new FakeResponse();
    await handleSnapshotRequest(
        fakeReq('/api/worker-log/snapshot?level=verbose') as never,
        res as never,
    );
    assert.equal(res.status, 400);
    const body = JSON.parse(res.body) as { error: string };
    assert.equal(body.error, 'invalid level');
});

test('handleSnapshotRequest with level=info returns only info lines from the fixture file', async () => {
    const fix = withTempLog(
        [
            jsonLine('info', 'i1'),
            jsonLine('warn', 'w1'),
            jsonLine('error', 'e1'),
            jsonLine('info', 'i2'),
        ].join('\n') + '\n',
    );
    try {
        const res = new FakeResponse();
        await handleSnapshotRequest(
            fakeReq('/api/worker-log/snapshot?level=info') as never,
            res as never,
            { filePath: fix.logPath },
        );
        assert.equal(res.status, 200);
        const body = JSON.parse(res.body) as { lines: string[] };
        assert.equal(body.lines.length, 2);
        for (const line of body.lines) assert.equal(extractLineLevel(line), 'info');
    } finally {
        fix.cleanup();
    }
});

test('handleTailRequest returns 400 on an unrecognised level (without opening the stream)', () => {
    const res = new FakeResponse();
    handleTailRequest(
        fakeReq('/api/worker-log/tail?level=trace') as never,
        res as never,
    );
    assert.equal(res.status, 400);
    const body = JSON.parse(res.body) as { error: string };
    assert.equal(body.error, 'invalid level');
});

// ---------------------------------------------------------------------------
// Constants the brief documents
// ---------------------------------------------------------------------------

test('snapshot default limit is 500 (AC #1)', () => {
    assert.equal(DEFAULT_SNAPSHOT_LIMIT, 500);
});

// Compile-time assertion that the level union stays the documented three.
// If a future change widens it, this assignment block forces a review.
{
    const accepted: WorkerLogLevel[] = ['info', 'warn', 'error'];
    void accepted;
}
