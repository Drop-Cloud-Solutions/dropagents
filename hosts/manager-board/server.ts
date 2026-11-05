import * as fs from 'node:fs';
import * as http from 'node:http';
import * as https from 'node:https';
import * as path from 'node:path';

import { decideRemoteBind } from '../bind-guard';
import { loadDotenv } from '../loadDotenv';

/**
 * Static-file server for the operator manager-board SPA, with a
 * same-origin reverse proxy in front of the manager-api so the bearer
 * token never leaves this process.
 *
 * Mirrors hosts/board-ui/server.ts (AP-NVP-026): three static assets
 * (`index.html`, `manager.js`, `manager.css`) served from `public/`
 * under this directory, plus a `/api/*` proxy that forwards to the
 * manager-api host (default `http://127.0.0.1:4102`, override via
 * `MANAGER_API_URL` or the `managerApiUrl` option). The `/api` prefix
 * is stripped before the request is forwarded — `/api/pipeline`
 * upstream resolves to `/pipeline` on the manager-api.
 *
 * The browser sends no `Authorization` header — it can't be trusted
 * to hold a long-lived secret. The proxy injects
 * `Authorization: Bearer <token>` from `WORKER_API_TOKEN_V2` (the same
 * env var the manager-api authenticates against) on every upstream
 * request, overwriting whatever the client sent.
 *
 * Path-traversal defence: the resolved static path must stay
 * underneath the asset directory. Symlinks aren't followed.
 */

const DEFAULT_PORT = 4103;
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_MANAGER_API_URL = 'http://127.0.0.1:4102';
const ASSET_DIR = path.join(__dirname, 'public');
const INDEX_FILE = 'index.html';
const PROXY_PREFIX = '/api';

const ALLOWED_FILES = new Set<string>([INDEX_FILE, 'manager.js', 'manager.css']);

const MIME_TYPES: Readonly<Record<string, string>> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8'
};

export interface ManagerBoardServerOptions {
    readonly port?: number;
    readonly host?: string;
    /**
     * Origin of the manager-api this server proxies `/api/*` to.
     * Defaults to `http://127.0.0.1:4102`. Trailing slashes are
     * stripped.
     */
    readonly managerApiUrl?: string;
    /**
     * Bearer token injected on every proxied upstream request. When
     * set, the manager-api must be configured with the same value.
     * Defaults to undefined (no Authorization header is added).
     */
    readonly managerApiToken?: string;
}

export interface ManagerBoardServerHandle {
    readonly port: number;
    stop(): Promise<void>;
}

export async function start(
    options: ManagerBoardServerOptions = {}
): Promise<ManagerBoardServerHandle> {
    const port = options.port ?? DEFAULT_PORT;
    const host = options.host ?? DEFAULT_HOST;
    const managerApiUrl = (options.managerApiUrl ?? DEFAULT_MANAGER_API_URL).replace(/\/+$/, '');
    const managerApiToken = options.managerApiToken;
    // Same hazard as board-ui, and worse in consequence: this server is
    // UNAUTHENTICATED and its /api/* proxy injects `managerApiToken` upstream,
    // so a non-loopback bind gives anyone who can reach this port the
    // config-WRITING authority (the manager-api is the only process allowed to
    // write config). No token can make this safe, hence an unconditional warn.
    if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
        // eslint-disable-next-line no-console
        console.warn(
            `manager-board: binding non-loopback host "${host}" — this server is `
                + 'UNAUTHENTICATED and its proxy adds the manager-api token to every forwarded '
                + 'request, exposing config writes. Reach it over a private network (e.g. '
                + 'Tailscale/VPN) or put an authenticating reverse proxy in front; never expose '
                + 'this port to an untrusted network.',
        );
    }

    const server = http.createServer((req, res) => {
        const pathname = (req.url ?? '/').split('?', 1)[0];
        if (pathname === PROXY_PREFIX || pathname.startsWith(PROXY_PREFIX + '/')) {
            proxyToManagerApi(req, res, managerApiUrl, managerApiToken);
            return;
        }
        serveStatic(req, res);
    });

    const bound = await new Promise<number>((resolve, reject) => {
        const onError = (err: Error): void => reject(err);
        server.once('error', onError);
        server.listen(port, host, () => {
            server.removeListener('error', onError);
            const addr = server.address();
            if (!addr || typeof addr === 'string') {
                reject(new Error('manager-board: listen returned no address'));
                return;
            }
            resolve(addr.port);
        });
    });

    // eslint-disable-next-line no-console
    console.log(
        `manager-board: serving ${ASSET_DIR} on http://${host}:${bound} ` +
            `(proxying /api/* to ${managerApiUrl})`
    );

    return {
        port: bound,
        stop(): Promise<void> {
            return new Promise((resolve) => {
                server.close(() => resolve());
                const closeAll = (
                    server as { closeAllConnections?: () => void }
                ).closeAllConnections;
                if (typeof closeAll === 'function') {
                    closeAll.call(server);
                }
            });
        }
    };
}

/**
 * Forward `/api/*` to the manager-api. The `/api` prefix is stripped:
 * `/api/pipeline` becomes `/pipeline` upstream. Bodies stream through
 * unchanged. `host` and `connection` are stripped because they're
 * hop-by-hop; `authorization` is always rewritten — the browser can't
 * be trusted to hold the token, so whatever it sent is discarded
 * before the upstream request leaves this process.
 */
function proxyToManagerApi(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    targetBase: string,
    authToken: string | undefined
): void {
    const url = req.url ?? '/';
    const stripped = url.slice(PROXY_PREFIX.length);
    const upstreamPath = stripped.length === 0 ? '/' : stripped;

    let target: URL;
    try {
        target = new URL(upstreamPath, targetBase);
    } catch {
        respondPlain(res, 502, `bad gateway: invalid target ${targetBase}`);
        return;
    }

    const headers: http.OutgoingHttpHeaders = { ...req.headers };
    delete headers.host;
    delete headers.connection;
    delete headers.authorization;
    if (authToken) {
        headers.authorization = `Bearer ${authToken}`;
    }

    const isHttps = target.protocol === 'https:';
    const requestFn = isHttps ? https.request : http.request;
    const upstream = requestFn({
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (isHttps ? 443 : 80),
        path: target.pathname + target.search,
        method: req.method,
        headers
    });

    upstream.on('response', (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
    });

    upstream.on('error', (err) => {
        // eslint-disable-next-line no-console
        console.error(
            `manager-board: proxy ${req.method} ${req.url} -> ${target.href} failed: ${err.message}`
        );
        if (!res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(
                JSON.stringify({
                    error: 'bad gateway',
                    target: target.href,
                    message: err.message
                })
            );
            return;
        }
        res.destroy();
    });

    // Tear the upstream down when the response socket closes (client
    // disconnect). See board-ui/server.ts for the full rationale —
    // listening on `req.close` races with body-less methods.
    res.on('close', () => {
        if (!upstream.destroyed) upstream.destroy();
    });

    if (req.method === 'GET' || req.method === 'HEAD') {
        upstream.end();
    } else {
        req.pipe(upstream);
    }
}

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        respondPlain(res, 405, 'method not allowed');
        return;
    }

    const url = req.url ?? '/';
    const pathname = url.split('?', 1)[0];
    const requested = pathname === '/' ? INDEX_FILE : pathname.replace(/^\/+/, '');

    if (!ALLOWED_FILES.has(requested)) {
        respondPlain(res, 404, 'not found');
        return;
    }

    const filePath = path.join(ASSET_DIR, requested);
    // Belt-and-braces: the allow-list above already rules out
    // traversal, but a defence-in-depth check guards against future
    // loosening.
    const rel = path.relative(ASSET_DIR, filePath);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
        respondPlain(res, 404, 'not found');
        return;
    }

    fs.readFile(filePath, (err, data) => {
        if (err) {
            respondPlain(res, 404, 'not found');
            return;
        }
        const ext = path.extname(filePath).toLowerCase();
        const contentType = MIME_TYPES[ext] ?? 'application/octet-stream';
        res.writeHead(200, {
            'Content-Type': contentType,
            'Content-Length': data.length,
            'Cache-Control': 'no-cache'
        });
        if (req.method === 'HEAD') {
            res.end();
        } else {
            res.end(data);
        }
    });
}

function respondPlain(res: http.ServerResponse, status: number, body: string): void {
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(body);
}

async function main(): Promise<void> {
    loadDotenv();
    const portRaw = process.env.MANAGER_BOARD_PORT;
    const port = portRaw ? Number(portRaw) : DEFAULT_PORT;
    if (!Number.isFinite(port) || port < 0 || port > 65535) {
        // eslint-disable-next-line no-console
        console.error(`manager-board: invalid MANAGER_BOARD_PORT="${portRaw}"`);
        process.exit(1);
    }
    const host = process.env.MANAGER_BOARD_HOST ?? DEFAULT_HOST;
    // See hosts/bind-guard.ts. Worse in consequence than board-ui: the
    // manager-api is the only process allowed to WRITE config.
    const bind = decideRemoteBind({
        service: 'manager-board',
        host,
        allowFlagName: 'MANAGER_BOARD_ALLOW_REMOTE',
        allowFlagValue: process.env.MANAGER_BOARD_ALLOW_REMOTE,
        exposes:
            'its proxy adds your manager-api token to every forwarded request,'
            + ' which grants CONFIG WRITE access.',
    });
    if (!bind.allowed) {
        // eslint-disable-next-line no-console
        console.error(bind.message);
        process.exit(1);
    }
    if (bind.message.length > 0) {
        // eslint-disable-next-line no-console
        console.warn(bind.message);
    }
    const managerApiUrl = process.env.MANAGER_API_URL ?? DEFAULT_MANAGER_API_URL;
    const managerApiToken = process.env.WORKER_API_TOKEN_V2;

    const handle = await start({ port, host, managerApiUrl, managerApiToken });

    const shutdown = (signal: NodeJS.Signals): void => {
        // eslint-disable-next-line no-console
        console.log(`manager-board: received ${signal}, shutting down`);
        handle
            .stop()
            .then(() => process.exit(0))
            .catch((err) => {
                // eslint-disable-next-line no-console
                console.error('manager-board: error during shutdown', err);
                process.exit(1);
            });
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

if (require.main === module) {
    main().catch((err) => {
        // eslint-disable-next-line no-console
        console.error('manager-board: fatal startup error', err);
        process.exit(1);
    });
}
