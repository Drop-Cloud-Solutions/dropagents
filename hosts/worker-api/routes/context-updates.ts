/**
 * Worker-api context-updates router — stub until the post-merge context
 * curator lands.
 *
 * Endpoints:
 *
 *   GET /context-updates/pending
 *        Returns the list of pending CLAUDE.md context-update PRs the
 *        operator board's sidebar polls every few seconds. Until the
 *        curator subscriber + projection are built, this responds with
 *        `200 []` so the board's polling loop treats it as a steady
 *        empty state rather than a 404. The board already special-cases
 *        the empty array as "no pending updates"; no client change is
 *        needed once the real projection arrives.
 *
 * Router shape mirrors `plan-review.ts` / `projects.ts`: a headless
 * `handle(req, res) -> boolean` that the parent {@link BoardHttpServer}
 * folds in via `extraRouters`. The Bearer-token gate is enforced by the
 * parent server, the same as every other extra router on this surface.
 */
import * as http from 'node:http';

import type { Logger } from '../../../core/ports/Logger';

export const CONTEXT_UPDATES_PENDING_PATTERN = /^\/context-updates\/pending\/?$/;

export interface ContextUpdatesRoutesDeps {
    readonly logger?: Logger;
}

export interface ContextUpdatesRouter {
    /**
     * Attempt to handle the request. Returns `true` when the URL matched
     * one of the context-updates routes (a response was sent), `false`
     * otherwise so the parent server can fall through to its own routes.
     */
    handle(req: http.IncomingMessage, res: http.ServerResponse): boolean;
}

export function createContextUpdatesRouter(
    deps: ContextUpdatesRoutesDeps = {},
): ContextUpdatesRouter {
    return {
        handle(req, res): boolean {
            const url = req.url ?? '/';
            const pathname = url.split('?', 1)[0];
            const method = req.method ?? 'GET';

            if (CONTEXT_UPDATES_PENDING_PATTERN.test(pathname)) {
                if (method !== 'GET') {
                    res.writeHead(405, {
                        'Content-Type': 'application/json',
                        Allow: 'GET',
                    });
                    res.end(JSON.stringify({ error: 'method not allowed' }));
                    return true;
                }
                deps.logger?.info('context-updates: pending', { count: 0 });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify([]));
                return true;
            }

            return false;
        },
    };
}
