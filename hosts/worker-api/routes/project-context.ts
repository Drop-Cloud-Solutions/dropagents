/**
 * `GET` / `PUT /api/projects/:projectId/context-md` — the board's window
 * onto the project's architecture context.
 *
 * A PROXY to the manager-api, deliberately: the manager-api is the single
 * config-writing authority, and duplicating its validation, integrity
 * guard, atomic write and lock in a second process is exactly how two
 * writers drift. The board talks to worker-api, so the hop lives here —
 * the same shape `chat-config-apply` uses for the same reason.
 *
 * The shared bearer token authenticates the hop and never reaches the
 * browser.
 */
import * as http from 'node:http';

import type { Logger } from '../../../core/ports/Logger';

export const PROJECT_CONTEXT_ROUTE_PATTERN =
    /^\/api\/projects\/([^/]+)\/context-md\/?$/;

const MAX_BODY_BYTES = 1_000_000;

interface FetchResponseLike {
    readonly ok: boolean;
    readonly status: number;
    json(): Promise<unknown>;
}

type FetchLike = (
    url: string,
    init?: {
        method?: string;
        headers?: Record<string, string>;
        body?: string;
    },
) => Promise<FetchResponseLike>;

export interface ProjectContextProxyDeps {
    /** Base URL of the manager-api, e.g. `http://127.0.0.1:4102`. */
    readonly managerApiUrl: string;
    readonly managerApiToken?: string;
    readonly logger?: Logger;
    /** Injectable for tests — defaults to global fetch. */
    readonly fetchImpl?: FetchLike;
}

export interface ProjectContextRouter {
    handle(req: http.IncomingMessage, res: http.ServerResponse): boolean;
}

export function createProjectContextRouter(
    deps: ProjectContextProxyDeps,
): ProjectContextRouter {
    return {
        handle(req, res): boolean {
            const pathname = (req.url ?? '/').split('?', 1)[0] ?? '/';
            const match = PROJECT_CONTEXT_ROUTE_PATTERN.exec(pathname);
            if (!match) return false;

            const projectId = decodeURIComponent(match[1] ?? '');
            const method = (req.method ?? 'GET').toUpperCase();
            if (method !== 'GET' && method !== 'PUT') {
                respond(res, 405, { error: 'method not allowed' }, { Allow: 'GET, PUT' });
                return true;
            }

            void (async (): Promise<void> => {
                try {
                    const body = method === 'PUT' ? await readBody(req) : undefined;
                    const result = await forward(deps, projectId, method, body);
                    respond(res, result.status, result.body);
                } catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    deps.logger?.warn('project-context: proxy to manager-api failed', {
                        projectId,
                        method,
                        error: message,
                    });
                    // 502, not 500: the failure is the hop, and saying so
                    // tells the operator to check the manager-api rather
                    // than their own markdown.
                    respond(res, 502, {
                        error: `manager-api unreachable: ${message}`,
                    });
                }
            })();
            return true;
        },
    };
}

async function forward(
    deps: ProjectContextProxyDeps,
    projectId: string,
    method: 'GET' | 'PUT',
    body: string | undefined,
): Promise<{ status: number; body: Record<string, unknown> }> {
    const fetchImpl: FetchLike = deps.fetchImpl
        ?? ((url, init) => fetch(url, init as RequestInit) as unknown as Promise<FetchResponseLike>);
    const base = deps.managerApiUrl.replace(/\/+$/, '');
    const url = `${base}/projects/${encodeURIComponent(projectId)}/context-md`;
    const headers: Record<string, string> = {};
    if (deps.managerApiToken) headers.Authorization = `Bearer ${deps.managerApiToken}`;
    if (method === 'PUT') headers['Content-Type'] = 'application/json';

    const res = await fetchImpl(url, {
        method,
        headers,
        ...(body !== undefined ? { body } : {}),
    });
    let parsed: unknown = {};
    try {
        parsed = await res.json();
    } catch {
        parsed = {};
    }
    // Pass the manager-api's status through verbatim — the 422 from the
    // integrity guard and the 409 from a concurrent save are the two
    // answers the editor needs, and flattening them to 200/500 would
    // strip the reason.
    return {
        status: res.status,
        body: (parsed ?? {}) as Record<string, unknown>,
    };
}

function readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        let total = 0;
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => {
            total += chunk.length;
            if (total > MAX_BODY_BYTES) {
                reject(new Error('request body too large'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', (err) => reject(err));
    });
}

function respond(
    res: http.ServerResponse,
    status: number,
    body: unknown,
    headers?: Record<string, string>,
): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(payload),
        ...(headers ?? {}),
    });
    res.end(payload);
}
