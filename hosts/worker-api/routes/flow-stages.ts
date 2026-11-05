/**
 * Worker-api read-only route for the flow-stage catalog.
 *
 * `GET /api/flow-stages`
 *   Returns `{ flows: Record<string, FlowStage[]> }` keyed by flow id (the
 *   same relative-path id {@link loadAllFlows} produces, e.g. `implement`,
 *   `deploy-azure`, `investigate`). Each value is the ordered
 *   {@link FlowStage} list a task of that flow runs, derived from the loaded
 *   {@link FlowDefinition} via {@link deriveFlowStages}.
 *
 * The board hits this once on boot so it can render a flow-accurate stage
 * strip per card — a `document` flow with no tester, a single-step
 * `deploy-azure`, or a lone `investigate` chip each show their own steps —
 * instead of embedding a stages array on every task payload.
 *
 * Read-only, no query params, no write side. The flow map is borrowed from
 * the orchestrator through a getter so the catalog reflects operator
 * hot-reloads (`reloadFlows`) rather than a boot-time snapshot. Shape mirrors
 * the sibling {@link createReposRouter} / {@link createTasksReadRouter}
 * routers: `handle()` returns `false` on a path miss so the parent
 * {@link BoardHttpServer} falls through to the next router.
 */

import * as http from 'node:http';

import { deriveFlowStages, type FlowStage } from '../../../core/flow/flow-stages';
import type { FlowDefinition } from '../../../core/flow/types';
import type { Logger } from '../../../core/ports/Logger';

export const FLOW_STAGES_ROUTE_PATTERN = /^\/api\/flow-stages\/?$/;

export interface FlowStagesDeps {
    /**
     * Getter for the orchestrator's live flow map. Called per request (not
     * snapshotted at construction) so the catalog reflects a hot-reload of
     * `config/flows` via the operator "Apply" path.
     */
    readonly getFlows: () => ReadonlyMap<string, FlowDefinition>;
    readonly logger?: Logger;
}

export interface FlowStagesRouter {
    handle(req: http.IncomingMessage, res: http.ServerResponse): boolean;
}

/** Wire shape of the `GET /api/flow-stages` response body. */
export interface FlowStagesResponse {
    readonly flows: Record<string, FlowStage[]>;
}

export function createFlowStagesRouter(deps: FlowStagesDeps): FlowStagesRouter {
    return {
        handle(req, res): boolean {
            const url = req.url ?? '/';
            const pathname = url.split('?', 1)[0];
            if (!FLOW_STAGES_ROUTE_PATTERN.test(pathname)) return false;

            const method = req.method ?? 'GET';
            if (method !== 'GET') {
                respond(res, 405, { error: 'method not allowed' }, { Allow: 'GET' });
                return true;
            }

            try {
                const flows: Record<string, FlowStage[]> = {};
                for (const [id, flow] of deps.getFlows()) {
                    flows[id] = deriveFlowStages(flow);
                }
                respond(res, 200, { flows });
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                deps.logger?.error('flow-stages: list failed', { error: message });
                respond(res, 500, { error: 'flow stages list failed', message });
            }
            return true;
        },
    };
}

function respond(
    res: http.ServerResponse,
    status: number,
    body: unknown,
    extraHeaders: Readonly<Record<string, string>> = {},
): void {
    res.writeHead(status, {
        'Content-Type': 'application/json',
        ...extraHeaders,
    });
    res.end(JSON.stringify(body));
}
