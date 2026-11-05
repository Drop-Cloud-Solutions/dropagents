/**
 * AP-IFF-017 — worker log tail routes for the worker-api.
 *
 * Surfaces two endpoints over the shared worker log file:
 *
 *   GET /api/worker-log/snapshot?level=info|warn|error
 *     Returns the last {@link DEFAULT_SNAPSHOT_LIMIT} lines that match the
 *     requested level. When `level` is omitted every line is returned.
 *     Response body: `{ lines: string[] }` — each entry is the raw line
 *     verbatim from disk (the exact JSON produced by `FileLogger`) so
 *     the board / any other consumer can parse the structured shape
 *     itself without us re-projecting the line into a new envelope.
 *
 *   GET /api/worker-log/tail?level=info|warn|error
 *     Server-Sent Events. After flushing the SSE preamble the route
 *     polls the log file every {@link DEFAULT_POLL_MS}; when new bytes
 *     appear it splits them on newline and emits each *complete* line
 *     that matches the level filter as `data: <line>\n\n`. Partial
 *     trailing lines are buffered for the next tick. Rotation (the file
 *     shrinks below the tracked offset) resets the offset to 0 and
 *     emits an `event: rotated` frame so the client can resync.
 *
 * Mechanism parity: the file is the same v2 worker log written by
 * `adapters/logging/file-logger.ts` (one JSON object per line:
 * `{ ts, level, msg, ...fields }`). The v1 brief speaks of
 * `shared/worker-log.ts`; in v2 that role is owned by `FileLogger`, and
 * we read the file location the same way the board-ui worker-log
 * routes do — repo-rooted `shared/.cache/worker.log` by default, with a
 * test seam for an injected path.
 *
 * Testability: the level filter, the last-N selection, and the SSE
 * frame format are pure functions; the polling loop is driven by an
 * exposed `tick()` method on the handle so the spec can advance time
 * without an interval timer. That keeps the unit suite deterministic
 * — no `setTimeout`-based races to flake CI.
 */

import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';

/**
 * The three levels the operator board surfaces in its filter chip.
 * `FileLogger` writes a fourth level (`debug`) too, but that is
 * intentionally off-menu for this route — operators tail this stream
 * for incident triage, and `debug` would drown the signal. Lines that
 * carry an unknown level survive the filter only when no `?level` is
 * set; an explicit filter excludes them, which is the safer default.
 */
export type WorkerLogLevel = 'info' | 'warn' | 'error';

/**
 * Default maximum number of lines returned by the snapshot endpoint.
 * Surfaced as a constant so the spec can assert against the same
 * number the brief documents (AC #1: "last 500 lines").
 */
export const DEFAULT_SNAPSHOT_LIMIT = 500;

/** Default poll interval for the SSE tail. */
export const DEFAULT_POLL_MS = 500;

/** Default heartbeat interval — comment frames keep idle proxies from closing the connection. */
export const DEFAULT_HEARTBEAT_MS = 15_000;

/**
 * Route patterns the host's router matches against. Exported so the
 * wiring layer and the spec reference the same literal strings.
 */
export const WORKER_LOG_SNAPSHOT_ROUTE = '/api/worker-log/snapshot';
export const WORKER_LOG_TAIL_ROUTE = '/api/worker-log/tail';

/**
 * Default log file location — matches `adapters/logging/file-logger.ts`'s
 * `<repo-root>/shared/.cache/worker.log`. Resolved at module load.
 */
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
export const DEFAULT_WORKER_LOG_PATH = path.join(
    REPO_ROOT,
    'shared',
    '.cache',
    'worker.log',
);

const VALID_LEVELS: ReadonlySet<string> = new Set<string>(['info', 'warn', 'error']);

/**
 * Decode a `level` query value. Returns `null` for "no filter" (the
 * parameter was absent or empty); returns the parsed {@link WorkerLogLevel}
 * for one of the documented values; throws `RangeError` for anything
 * else so the HTTP layer can surface 400 instead of silently widening
 * to "all lines".
 *
 * Case-insensitive: `?level=INFO`, `Warn`, and `ERROR` all normalise to
 * their lowercase canonical form. The board's filter chips submit
 * lowercase values, but operators sometimes hand-craft URLs from
 * uppercase log-level constants — accepting both keeps the route
 * forgiving without widening the accepted set.
 */
export function parseLevelParam(raw: string | null | undefined): WorkerLogLevel | null {
    if (raw === null || raw === undefined || raw === '') return null;
    const normalised = raw.toLowerCase();
    if (!VALID_LEVELS.has(normalised)) {
        throw new RangeError(`invalid level: ${raw}`);
    }
    return normalised as WorkerLogLevel;
}

/**
 * Pull the `level` field out of a single log line. Lines are JSON
 * objects (per `FileLogger`); a non-JSON line — which shouldn't appear
 * in the v2 log but is cheap to defend against — returns `null`, which
 * the filter then treats as "level unknown" and excludes from every
 * level-specific view.
 */
export function extractLineLevel(line: string): string | null {
    if (line.length === 0) return null;
    try {
        const parsed = JSON.parse(line) as { level?: unknown };
        if (typeof parsed.level === 'string') return parsed.level;
        return null;
    } catch {
        return null;
    }
}

/**
 * Predicate used by both endpoints: does this raw log line satisfy the
 * caller's level filter?
 *
 * When `level` is `null` the predicate accepts every line (including
 * non-JSON / no-level lines) — the caller asked for the unfiltered
 * stream. When `level` is set we require an exact match on the line's
 * `level` field; unknown levels are excluded so an `?level=error`
 * subscriber never sees a stray `debug` line.
 */
export function lineMatchesLevel(line: string, level: WorkerLogLevel | null): boolean {
    if (level === null) return true;
    return extractLineLevel(line) === level;
}

/**
 * Apply the level filter and return the last `limit` matches in source
 * order. Empty trailing lines (the file ends with a newline) are
 * dropped. Pure function — no I/O — so the spec can pin the slicing
 * behaviour without a fixture file.
 */
export function selectSnapshotLines(
    rawContent: string,
    level: WorkerLogLevel | null,
    limit: number = DEFAULT_SNAPSHOT_LIMIT,
): string[] {
    if (rawContent.length === 0) return [];
    const all = rawContent.split('\n');
    const out: string[] = [];
    for (const line of all) {
        const clean = line.endsWith('\r') ? line.slice(0, -1) : line;
        if (clean.length === 0) continue;
        if (lineMatchesLevel(clean, level)) out.push(clean);
    }
    if (out.length <= limit) return out;
    return out.slice(out.length - limit);
}

/**
 * Frame a single line as an SSE `data:` event. Exposed so the spec can
 * assert on the exact byte sequence the tail emits (AC #2 / brief:
 * "SSE event format"). Newlines inside the line are escaped to spaces
 * — `FileLogger` already collapses them, but a stray `\n` in user
 * input would otherwise split the frame in two.
 */
export function formatSseDataFrame(line: string): string {
    const safe = line.replace(/\r?\n/g, ' ');
    return `data: ${safe}\n\n`;
}

export interface SnapshotResult {
    readonly status: number;
    readonly body: Readonly<Record<string, unknown>>;
}

/**
 * Read the configured log file and produce the snapshot response body.
 * Missing log file → 200 with an empty `lines` array; the file isn't
 * created until the first `FileLogger.write`, and a freshly-deployed
 * worker should not 500 just because nothing has been logged yet.
 */
export async function readSnapshot(
    logPath: string,
    level: WorkerLogLevel | null,
    limit: number = DEFAULT_SNAPSHOT_LIMIT,
): Promise<SnapshotResult> {
    let content: string;
    try {
        content = await fs.promises.readFile(logPath, 'utf8');
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            return { status: 200, body: { lines: [] } };
        }
        throw err;
    }
    const lines = selectSnapshotLines(content, level, limit);
    return { status: 200, body: { lines } };
}

/**
 * Test seam over the {@link http.ServerResponse} chunks the SSE tail
 * writes — narrower than the full Node interface so tests can hand in
 * an in-memory recorder. The production handler passes a thin shim
 * around `http.ServerResponse`.
 */
export interface SseSink {
    writeHead(status: number, headers: Readonly<Record<string, string>>): void;
    write(chunk: string): void;
    end(): void;
}

export interface WorkerLogTailOptions {
    readonly filePath: string;
    readonly level: WorkerLogLevel | null;
    readonly sink: SseSink;
    readonly pollIntervalMs?: number;
    readonly heartbeatIntervalMs?: number;
    /** When false the loop starts paused — only `tick()` advances state. Tests use this. */
    readonly autoPoll?: boolean;
}

export interface WorkerLogTailHandle {
    /**
     * Force one poll cycle. Resolves once the tick completes (any new
     * bytes have been read and forwarded to the sink). Safe to call
     * concurrently — overlapping calls collapse onto a single tick.
     */
    tick(): Promise<void>;
    /** Stop polling, clear the heartbeat, and tear down. Idempotent. */
    stop(): void;
}

/**
 * Start an SSE tail over `filePath` and write frames to `sink`. The
 * caller is responsible for owning the underlying response: this
 * function never closes the sink itself (production wires the close
 * handler against the http request lifecycle; tests do not need one).
 *
 * The poll loop is intentionally re-entrant-safe: if a previous tick is
 * still in flight when the interval fires we drop the new tick rather
 * than queue it, mirroring the board-ui worker-log SSE handler's
 * behaviour. Heartbeats are written as SSE comments (`: hb\n\n`) so
 * EventSource ignores them but proxies see traffic on the socket.
 */
export function startWorkerLogTail(opts: WorkerLogTailOptions): WorkerLogTailHandle {
    const {
        filePath,
        level,
        sink,
        pollIntervalMs = DEFAULT_POLL_MS,
        heartbeatIntervalMs = DEFAULT_HEARTBEAT_MS,
        autoPoll = true,
    } = opts;

    sink.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        // Defeat proxy buffering — same hack as the board-http SSE route.
        'X-Accel-Buffering': 'no',
    });

    // `offset` is initialised to the file's current size below so the
    // tail only delivers content APPENDED after the SSE connection
    // settles. Without this, the first poll reads the file from byte
    // 0 and SSE-frames every existing line — the operator's browser
    // then runs through hundreds (or thousands) of `onmessage` →
    // DOM append cycles and the board freezes for 10–15s on a busy
    // log. The snapshot endpoint already delivered the last 500
    // lines; the tail's job is the live extension from there.
    let offset = 0;
    let buffer = '';
    let closed = false;
    let pollPromise: Promise<void> | null = null;
    let pollInterval: NodeJS.Timeout | null = null;
    let heartbeat: NodeJS.Timeout | null = null;
    let primed = false;

    const emitChunk = (chunk: string): void => {
        buffer += chunk;
        let nl = buffer.indexOf('\n');
        while (nl !== -1) {
            const line = buffer.slice(0, nl);
            buffer = buffer.slice(nl + 1);
            const clean = line.endsWith('\r') ? line.slice(0, -1) : line;
            if (clean.length === 0) {
                nl = buffer.indexOf('\n');
                continue;
            }
            if (lineMatchesLevel(clean, level)) {
                sink.write(formatSseDataFrame(clean));
            }
            nl = buffer.indexOf('\n');
        }
    };

    const runTick = async (): Promise<void> => {
        if (closed) return;
        let size = 0;
        try {
            const stat = await fs.promises.stat(filePath);
            size = stat.size;
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
                offset = 0;
                buffer = '';
                primed = true;
                return;
            }
            throw err;
        }
        // First tick: skip whatever's already in the file. The
        // snapshot endpoint already delivered the tail context; from
        // here we only want lines APPENDED after this point.
        if (!primed) {
            offset = size;
            primed = true;
            return;
        }
        if (size < offset) {
            buffer = '';
            offset = 0;
            if (!closed) {
                sink.write('event: rotated\n');
                sink.write(`data: ${JSON.stringify({ size })}\n\n`);
            }
        }
        if (size > offset) {
            const fd = await fs.promises.open(filePath, 'r');
            try {
                const length = size - offset;
                const buf = Buffer.allocUnsafe(length);
                await fd.read(buf, 0, length, offset);
                offset = size;
                if (!closed) emitChunk(buf.toString('utf8'));
            } finally {
                await fd.close();
            }
        }
    };

    const tick = (): Promise<void> => {
        if (closed) return Promise.resolve();
        if (pollPromise !== null) return pollPromise;
        pollPromise = runTick().finally(() => {
            pollPromise = null;
        });
        return pollPromise;
    };

    if (autoPoll) {
        pollInterval = setInterval(() => {
            void tick();
        }, pollIntervalMs);
        // Don't make the timer keep the event loop alive — the request
        // lifecycle owns it.
        if (typeof pollInterval.unref === 'function') pollInterval.unref();
        heartbeat = setInterval(() => {
            if (!closed) sink.write(': hb\n\n');
        }, heartbeatIntervalMs);
        if (typeof heartbeat.unref === 'function') heartbeat.unref();
        // Kick off an immediate poll so first-paint doesn't wait a tick.
        void tick();
    }

    return {
        tick,
        stop(): void {
            if (closed) return;
            closed = true;
            if (pollInterval !== null) clearInterval(pollInterval);
            if (heartbeat !== null) clearInterval(heartbeat);
        },
    };
}

export interface WorkerLogTailDeps {
    /** Worker log file path. Defaults to {@link DEFAULT_WORKER_LOG_PATH}. */
    readonly filePath?: string;
}

/**
 * `GET /api/worker-log/snapshot?level=...` handler. Validates the
 * level query, reads the file, and writes the JSON body. Errors from
 * the file read (other than ENOENT, which `readSnapshot` already
 * absorbs) become 500.
 */
export async function handleSnapshotRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    deps: WorkerLogTailDeps = {},
): Promise<void> {
    const filePath = deps.filePath ?? DEFAULT_WORKER_LOG_PATH;
    const query = new URLSearchParams((req.url ?? '').split('?')[1] ?? '');
    let level: WorkerLogLevel | null;
    try {
        level = parseLevelParam(query.get('level'));
    } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(
            JSON.stringify({
                error: 'invalid level',
                message: err instanceof Error ? err.message : String(err),
            }),
        );
        return;
    }
    try {
        const result = await readSnapshot(filePath, level);
        res.writeHead(result.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result.body));
    } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(
            JSON.stringify({
                error: 'failed to read worker log',
                message: err instanceof Error ? err.message : String(err),
            }),
        );
    }
}

/**
 * `GET /api/worker-log/tail?level=...` handler. Validates the level,
 * sets up the SSE tail, and wires teardown against the request close
 * events so a disconnecting client tears down both timers.
 */
export function handleTailRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    deps: WorkerLogTailDeps = {},
): void {
    const filePath = deps.filePath ?? DEFAULT_WORKER_LOG_PATH;
    const query = new URLSearchParams((req.url ?? '').split('?')[1] ?? '');
    let level: WorkerLogLevel | null;
    try {
        level = parseLevelParam(query.get('level'));
    } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(
            JSON.stringify({
                error: 'invalid level',
                message: err instanceof Error ? err.message : String(err),
            }),
        );
        return;
    }

    const sink: SseSink = {
        writeHead(status, headers): void {
            res.writeHead(status, headers);
            if (typeof res.flushHeaders === 'function') res.flushHeaders();
        },
        write(chunk): void {
            res.write(chunk);
        },
        end(): void {
            res.end();
        },
    };

    const handle = startWorkerLogTail({ filePath, level, sink });

    const teardown = (): void => handle.stop();
    req.on('close', teardown);
    req.on('aborted', teardown);
    res.on('close', teardown);
}

// ---------------------------------------------------------------------------
// Router shim — folds the snapshot + tail handlers into the same
// `extraRouters` slot as `notes.ts`, `projects.ts`, and `context-updates.ts`.
// ---------------------------------------------------------------------------

export const WORKER_LOG_SNAPSHOT_PATTERN = /^\/api\/worker-log\/snapshot\/?$/;
export const WORKER_LOG_TAIL_PATTERN = /^\/api\/worker-log\/tail\/?$/;

export interface WorkerLogRouter {
    /**
     * Attempt to handle the request. Returns `true` when the URL matched
     * one of the worker-log routes (a response was sent or the SSE tail
     * was attached to the socket), `false` otherwise so a parent server
     * can fall through to its own routes.
     */
    handle(req: http.IncomingMessage, res: http.ServerResponse): boolean;
}

export function createWorkerLogRouter(
    deps: WorkerLogTailDeps = {},
): WorkerLogRouter {
    return {
        handle(req, res): boolean {
            const url = req.url ?? '/';
            const pathname = url.split('?', 1)[0];
            const method = req.method ?? 'GET';

            if (WORKER_LOG_SNAPSHOT_PATTERN.test(pathname)) {
                if (method !== 'GET') {
                    res.writeHead(405, {
                        'Content-Type': 'application/json',
                        Allow: 'GET',
                    });
                    res.end(JSON.stringify({ error: 'method not allowed' }));
                    return true;
                }
                void handleSnapshotRequest(req, res, deps);
                return true;
            }

            if (WORKER_LOG_TAIL_PATTERN.test(pathname)) {
                if (method !== 'GET') {
                    res.writeHead(405, {
                        'Content-Type': 'application/json',
                        Allow: 'GET',
                    });
                    res.end(JSON.stringify({ error: 'method not allowed' }));
                    return true;
                }
                handleTailRequest(req, res, deps);
                return true;
            }

            return false;
        },
    };
}
