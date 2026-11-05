/**
 * `GET /api/agent-auth` — proactive Claude-CLI auth health for the board.
 *
 * Returns the {@link AgentAuthStatus} snapshot from
 * adapters/claude-cli/auth-status: ok / expiring-soon / expired /
 * unknown, the expiry timestamp (never token material), the auth source
 * (OAuth credentials file vs env override), and an operator-facing
 * detail line. The board polls this every few minutes and renders a
 * banner when the state is anything but ok — so an expiring token is
 * visible BEFORE it kills a planner run (the field incident this
 * closes: an expired OAuth token surfaced only as a generic planner
 * failure).
 */
import * as http from 'node:http';

import type { AgentAuthStatus } from '../../../adapters/claude-cli/auth-status';

export const AGENT_AUTH_ROUTE_PATTERN = /^\/api\/agent-auth\/?$/;

export interface AgentAuthRouteDeps {
    readonly readStatus: () => AgentAuthStatus;
}

export interface AgentAuthRouter {
    handle(req: http.IncomingMessage, res: http.ServerResponse): boolean;
}

export function createAgentAuthRouter(deps: AgentAuthRouteDeps): AgentAuthRouter {
    return {
        handle(req, res): boolean {
            const pathname = (req.url ?? '/').split('?', 1)[0];
            if (!AGENT_AUTH_ROUTE_PATTERN.test(pathname)) return false;
            if ((req.method ?? 'GET') !== 'GET') {
                respond(res, 405, { error: 'method not allowed' }, { Allow: 'GET' });
                return true;
            }
            respond(res, 200, deps.readStatus());
            return true;
        },
    };
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
