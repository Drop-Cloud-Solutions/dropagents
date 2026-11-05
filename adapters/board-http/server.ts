import * as http from 'node:http';

import type { Command } from '../../core/commands/command';
import type { StoredEvent } from '../../core/events/event';
import type { Logger } from '../../core/ports/Logger';
import {
    DECOMPOSE_STATUS_ROUTE_PATTERN,
    getDecomposeStatus,
    type DecomposeStatusPort,
} from '../../hosts/worker-api/routes/decompose-status';

import { authorize } from './auth';

/**
 * Minimal CommandBus surface the HTTP server needs. Typed as a
 * structural subset of `core/commands/bus#CommandBus` so the server stays
 * testable with a hand-rolled fake.
 */
export interface CommandSink {
    send(command: Command): Promise<readonly StoredEvent[]>;
}

/**
 * Subscribes the supplied handler to every event published on the bus.
 * Returns an unsubscribe function. Wired in production from
 * `EventBus.subscribeAll`; the test suite passes a fake.
 */
export type SubscribeAll = (
    handler: (event: StoredEvent) => void,
) => () => void;

export interface BoardHttpServerDeps {
    readonly commandBus: CommandSink;
    readonly subscribeAll: SubscribeAll;
    /**
     * When unset, every endpoint other than `/health` runs without
     * authentication. The server logs a warning at construction so this
     * is not silently misconfigured. Intended for localhost-only setups.
     */
    readonly authToken?: string;
    /**
     * Optional body-producer for `GET /health`. When unset the server
     * returns the historical `{ status: 'ok' }` liveness response. Hosts
     * that need a richer probe (uptime, projection-lag gauge, etc.)
     * inject their own provider here. The function is awaited per
     * request; throws are caught and surfaced as 500 so a buggy probe
     * cannot wedge the route.
     */
    readonly healthCheck?: () => Promise<Readonly<Record<string, unknown>>>;
    /**
     * Read-side port for the decompose-status projection
     * (`GET /api/projects/:pid/plans/:planId/decompose-status`). When
     * unset the route returns 404 — keeps tests that don't exercise the
     * projection path unaffected. Wired in production from the
     * worker-api host (see `hosts/worker-api/main.ts`).
     */
    readonly decomposeStatusPort?: DecomposeStatusPort;
    /**
     * Optional list of additional routers given a shot at every request
     * AFTER the Bearer-auth gate but BEFORE the built-in routes' 404
     * fallback. Each entry's `handle(req, res)` returns `true` when it
     * claimed the request (response already written), `false` when the
     * URL was not its concern. Used by `hosts/worker-api/main.ts` to
     * fold per-feature routers (notes, future projection reads, ...)
     * into the same server without growing this module's switch.
     */
    readonly extraRouters?: ReadonlyArray<{
        handle(req: http.IncomingMessage, res: http.ServerResponse): boolean;
    }>;
    readonly logger: Logger;
}

const MAX_BODY_BYTES = 1_000_000;

/**
 * Pre-compiled matcher for the decompose-status projection route. The
 * pattern itself is owned by `routes/decompose-status.ts` (single source
 * of truth — see {@link DECOMPOSE_STATUS_ROUTE_PATTERN}); we just turn its
 * `:pid` / `:planId` placeholders into capturing groups for runtime use.
 *
 * Compiled once at module load so the per-request hot path is a single
 * regex execution, not a per-call pattern parse.
 */
const DECOMPOSE_STATUS_ROUTE_REGEX = (() => {
    const escaped = DECOMPOSE_STATUS_ROUTE_PATTERN.replace(
        /[.+*?^${}()|[\]\\]/g,
        '\\$&',
    );
    const src = escaped.replace(/:[a-zA-Z][a-zA-Z0-9_]*/g, '([^/]+)');
    return new RegExp('^' + src + '$');
})();

/**
 * HTTP layer that fronts the orchestrator for the operator board.
 *
 * Endpoints:
 *   - `POST /commands` — accepts a JSON command body, validates it
 *     against the `Command` shape, and submits it through the injected
 *     CommandBus. Returns 202 with the resulting stored events.
 *   - `GET /events` — Server-Sent Events. Subscribes to every published
 *     event and writes each as `data: <json>\n\n` until the client
 *     disconnects.
 *   - `GET /health` — auth-exempt liveness probe. Returns 200.
 *
 * Auth: when `authToken` is set, every non-/health request must carry a
 * matching `Authorization: Bearer <token>` header. The compare runs in
 * constant time. On failure the server responds 401 with
 * `WWW-Authenticate: Bearer`. When `authToken` is unset the server
 * accepts every request unauthenticated and logs a warning at startup.
 *
 * Built on Node's `http` module — no Express dependency.
 */
export class BoardHttpServer {
    private readonly server: http.Server;

    constructor(private readonly deps: BoardHttpServerDeps) {
        if (!deps.authToken) {
            deps.logger.warn(
                'board-http: WORKER_API_TOKEN_V2 unset — running unauthenticated (localhost-only mode)',
            );
        }
        this.server = http.createServer((req, res) => {
            this.handle(req, res);
        });
    }

    /**
     * Bind to the supplied port (use 0 for an ephemeral port). Returns
     * the actually bound port so callers can address the server in tests.
     */
    listen(port: number, host = '127.0.0.1'): Promise<{ port: number }> {
        return new Promise((resolve, reject) => {
            const onError = (err: Error): void => {
                reject(err);
            };
            this.server.once('error', onError);
            this.server.listen(port, host, () => {
                this.server.removeListener('error', onError);
                const addr = this.server.address();
                if (!addr || typeof addr === 'string') {
                    reject(new Error('board-http: listen returned no address'));
                    return;
                }
                resolve({ port: addr.port });
            });
        });
    }

    /**
     * Stop accepting new connections and tear down active ones. The SSE
     * stream holds connections open indefinitely, so we explicitly call
     * `closeAllConnections` to unblock close. Idempotent.
     */
    close(): Promise<void> {
        return new Promise((resolve) => {
            this.server.close(() => resolve());
            const closeAll = (
                this.server as { closeAllConnections?: () => void }
            ).closeAllConnections;
            if (typeof closeAll === 'function') {
                closeAll.call(this.server);
            }
        });
    }

    private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
        const method = req.method ?? 'GET';
        const url = req.url ?? '/';
        // Strip query string for routing — none of the endpoints use one,
        // but a stray ?cb=... from a curious client should not 404.
        const pathname = url.split('?', 1)[0];

        if (method === 'GET' && pathname === '/health') {
            this.handleHealth(res);
            return;
        }

        if (this.deps.authToken !== undefined) {
            if (!authorize(req.headers.authorization, this.deps.authToken)) {
                res.writeHead(401, {
                    'WWW-Authenticate': 'Bearer',
                    'Content-Type': 'application/json',
                });
                res.end(JSON.stringify({ error: 'unauthorized' }));
                return;
            }
        }

        if (method === 'POST' && pathname === '/commands') {
            this.handleCommand(req, res);
            return;
        }

        if (method === 'GET' && pathname === '/events') {
            this.handleEvents(req, res);
            return;
        }

        if (method === 'GET') {
            const match = DECOMPOSE_STATUS_ROUTE_REGEX.exec(pathname);
            if (match) {
                this.handleDecomposeStatus(res, match[1], match[2]);
                return;
            }
        }

        // Extra routers run AFTER the built-in routes so a per-feature
        // module cannot accidentally shadow `/commands`, `/events`, or
        // the decompose-status projection, and BEFORE the catch-all 404
        // so they can claim every other path the host wires them for.
        const extras = this.deps.extraRouters;
        if (extras !== undefined) {
            for (const router of extras) {
                if (router.handle(req, res)) return;
            }
        }

        this.respond(res, 404, { error: 'not found' });
    }

    /**
     * `GET /api/projects/:pid/plans/:planId/decompose-status` — the read-only
     * projection that surfaces decompose progress to the operator board.
     *
     * Behind the same auth gate as `POST /commands` and `GET /events` (the
     * authorize() check above runs before this dispatch). When the host
     * wasn't wired with a port the route returns 404 so the surface is
     * "off" rather than "exists but always errors" — keeps a partially
     * wired host from leaking misleading status to a polling board.
     */
    private handleDecomposeStatus(
        res: http.ServerResponse,
        rawPid: string,
        rawPlanId: string,
    ): void {
        const port = this.deps.decomposeStatusPort;
        if (!port) {
            this.respond(res, 404, { error: 'not found' });
            return;
        }
        let pid: string;
        let planId: string;
        try {
            pid = decodeURIComponent(rawPid);
            planId = decodeURIComponent(rawPlanId);
        } catch {
            this.respond(res, 404, { error: 'not found' });
            return;
        }
        getDecomposeStatus(port, pid, planId).then(
            (result) => this.respond(res, result.status, result.body),
            (err) => {
                const message = err instanceof Error ? err.message : String(err);
                this.deps.logger.error(
                    'board-http: decompose-status handler threw',
                    { pid, planId, error: message },
                );
                this.respond(res, 500, {
                    error: 'projection failed',
                    message,
                });
            },
        );
    }

    private handleHealth(res: http.ServerResponse): void {
        const provider = this.deps.healthCheck;
        if (!provider) {
            this.respond(res, 200, { status: 'ok' });
            return;
        }
        provider().then(
            (body) => this.respond(res, 200, body),
            (err) => {
                this.deps.logger.error('board-http: health probe threw', {
                    error: err instanceof Error ? err.message : String(err),
                });
                this.respond(res, 500, { error: 'health check failed' });
            },
        );
    }

    private handleCommand(req: http.IncomingMessage, res: http.ServerResponse): void {
        const chunks: Buffer[] = [];
        let total = 0;
        let aborted = false;

        req.on('data', (chunk: Buffer) => {
            if (aborted) return;
            total += chunk.length;
            if (total > MAX_BODY_BYTES) {
                aborted = true;
                this.respond(res, 413, { error: 'request body too large' });
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });

        req.on('end', async () => {
            if (aborted) return;
            const raw = Buffer.concat(chunks).toString('utf8');
            let parsed: unknown;
            try {
                parsed = JSON.parse(raw);
            } catch {
                this.respond(res, 400, { error: 'invalid JSON body' });
                return;
            }
            if (!isCommand(parsed)) {
                this.respond(res, 400, {
                    error: 'invalid command shape',
                    expected: { type: 'string', actor: 'string', issuedAt: 'number', payload: 'any' },
                });
                return;
            }
            try {
                const stored = await this.deps.commandBus.send(parsed);
                this.respond(res, 202, { events: stored });
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                this.deps.logger.error('board-http: command handler threw', {
                    type: parsed.type,
                    error: message,
                });
                this.respond(res, 500, { error: 'command failed', message });
            }
        });

        req.on('error', (err) => {
            this.deps.logger.warn('board-http: POST /commands request errored', {
                error: err.message,
            });
        });
    }

    private handleEvents(req: http.IncomingMessage, res: http.ServerResponse): void {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            // Defeat proxy buffering (nginx, IIS ARR) so events arrive
            // promptly instead of being held until the buffer fills.
            'X-Accel-Buffering': 'no',
        });
        if (typeof res.flushHeaders === 'function') {
            res.flushHeaders();
        }

        const unsubscribe = this.deps.subscribeAll((event) => {
            // `res.write` returns false on backpressure; we do not pause
            // the bus on our account — dropped frames would mean missed
            // events, which is worse than buffer growth on a long-lived
            // connection. The handler stays synchronous so it never
            // blocks the publisher.
            try {
                res.write(`data: ${JSON.stringify(event)}\n\n`);
            } catch (err) {
                this.deps.logger.warn('board-http: SSE write failed', {
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        });

        const teardown = (): void => {
            unsubscribe();
        };
        req.on('close', teardown);
        req.on('aborted', teardown);
    }

    private respond(
        res: http.ServerResponse,
        status: number,
        body: Readonly<Record<string, unknown>>,
    ): void {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
    }
}

function isCommand(value: unknown): value is Command {
    if (!value || typeof value !== 'object') return false;
    const v = value as Record<string, unknown>;
    return (
        typeof v.type === 'string' &&
        typeof v.actor === 'string' &&
        typeof v.issuedAt === 'number' &&
        Number.isFinite(v.issuedAt) &&
        'payload' in v
    );
}
