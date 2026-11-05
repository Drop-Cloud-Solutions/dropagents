/**
 * Worker-api read-only route for every plan across every project.
 *
 * `GET /api/plans`
 *   Returns the full `sidebar_plans` projection so the operator board
 *   can paint Draft / Progress / Completed / Archived sections directly
 *   from a single hydration call. Sister to `/api/tasks` — the board
 *   already issues that on boot to seed task state; this endpoint plays
 *   the same role for plans.
 *
 * Response shape mirrors the in-memory `PlanRow` the board's reducer
 * keeps, plus the `body` + parsed `metadata` blob (needed for the plan
 * modal's body view + the `planType` / `abbr` chips). Archived rows
 * are included with their `archivedAt` timestamp populated; the board
 * routes them into the Archived plans section.
 */

import * as http from 'node:http';

import type { Db } from '../../../core/state/migrations';
import type { Logger } from '../../../core/ports/Logger';

export const PLANS_LIST_ROUTE_PATTERN = /^\/api\/plans\/?$/;

export interface PlanRecord {
    readonly planId: string;
    readonly projectId: string;
    readonly name: string | null;
    readonly status: string | null;
    readonly body: string | null;
    /** Parsed JSON object — empty when the column is null/invalid. */
    readonly metadata: Readonly<Record<string, unknown>>;
    readonly archivedAt: number | null;
    readonly updatedAt: number | null;
    /**
     * When the plan was created, from the core `plans` table.
     *
     * Not on `sidebar_plans`: that projection has only ever carried
     * `updated_at`, which moves on every edit and so cannot answer "how
     * long has this been open?". `plans.created_at` has held the
     * `PlanCreated` timestamp since migration 001 — the value existed
     * all along, it was simply never joined onto the read the board
     * uses. Null for a plan with no core row.
     */
    readonly createdAt: number | null;
}

interface PlanRow {
    plan_id: string;
    pid: string;
    name: string | null;
    status: string | null;
    body: string | null;
    metadata: string | null;
    archived_at: number | null;
    updated_at: number | null;
    /** From the joined `plans` row; null when there is none. */
    created_at: number | null;
}

export interface PlansReadDeps {
    readonly db: Db;
    readonly logger?: Logger;
}

export interface PlansReadRouter {
    handle(req: http.IncomingMessage, res: http.ServerResponse): boolean;
}

export function createPlansReadRouter(deps: PlansReadDeps): PlansReadRouter {
    const stmt = deps.db.prepare(
        // LEFT JOIN, not INNER: a sidebar row whose core `plans` row is
        // missing must still list. Losing a plan from the board to gain a
        // date on it would be a poor trade.
        `SELECT sp.plan_id, sp.pid, sp.name, sp.status, sp.body, sp.metadata,
                sp.archived_at, sp.updated_at, p.created_at
           FROM sidebar_plans sp
           LEFT JOIN plans p ON p.id = sp.plan_id
          ORDER BY sp.pid ASC, sp.plan_id ASC`,
    );

    return {
        handle(req, res): boolean {
            const url = req.url ?? '/';
            const pathname = url.split('?', 1)[0];
            if (!PLANS_LIST_ROUTE_PATTERN.test(pathname)) return false;

            const method = req.method ?? 'GET';
            if (method !== 'GET') {
                respond(res, 405, { error: 'method not allowed' }, { Allow: 'GET' });
                return true;
            }

            try {
                const rows = stmt.all() as PlanRow[];
                const plans: PlanRecord[] = rows.map((r) => ({
                    planId: r.plan_id,
                    projectId: r.pid,
                    name: r.name,
                    status: r.status,
                    body: r.body,
                    metadata: parseMetadata(r.metadata),
                    archivedAt: r.archived_at,
                    updatedAt: r.updated_at,
                    createdAt: r.created_at,
                }));
                respond(res, 200, { plans });
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                deps.logger?.error('plans-read: list failed', { error: message });
                respond(res, 500, { error: 'plans list failed', message });
            }
            return true;
        },
    };
}

function parseMetadata(raw: string | null): Readonly<Record<string, unknown>> {
    if (raw === null || raw.length === 0) return {};
    try {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed as Record<string, unknown>;
        }
    } catch {
        // Tolerate a malformed metadata blob — the board falls back to
        // showing the plan with empty metadata rather than 500-ing the
        // whole list.
    }
    return {};
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
