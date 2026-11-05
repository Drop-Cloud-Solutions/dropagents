/**
 * Worker-api read-only routes for the Architect Tier requirements (Phase 2).
 *
 *   GET /api/requirements        → list (the Requirements lane hydration).
 *   GET /api/requirements/:id    → detail: the requirement + its contracts,
 *                                  sub-briefs, rollout, and fanned-out plans.
 *
 * Sister to `plans-read.ts` — reads the projection tables from migration 023
 * directly so the board stays a thin proxy.
 */

import * as http from 'node:http';

import type { Db } from '../../../core/state/migrations';
import type { Logger } from '../../../core/ports/Logger';

export const REQUIREMENTS_LIST_ROUTE_PATTERN = /^\/api\/requirements\/?$/;
export const REQUIREMENT_DETAIL_ROUTE_PATTERN = /^\/api\/requirements\/([^/]+)$/;

export interface RequirementsReadDeps {
    readonly db: Db;
    readonly logger?: Logger;
}

export interface RequirementsReadRouter {
    handle(req: http.IncomingMessage, res: http.ServerResponse): boolean;
}

interface ReqRow {
    requirement_id: string;
    title: string;
    description: string;
    project_id: string | null;
    status: string;
    revision: number;
    design_doc_path: string | null;
    design_md: string | null;
    verification_status: string | null;
    verification_findings: string | null;
    created_at: number;
    updated_at: number;
    archived_at: number | null;
}

function mapReq(r: ReqRow): Record<string, unknown> {
    return {
        requirementId: r.requirement_id,
        title: r.title,
        description: r.description,
        projectId: r.project_id ?? null,
        status: r.status,
        revision: r.revision,
        designDocPath: r.design_doc_path,
        verificationStatus: r.verification_status ?? null,
        verificationFindings: r.verification_findings ?? null,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        archivedAt: r.archived_at,
    };
}

export function createRequirementsReadRouter(
    deps: RequirementsReadDeps,
): RequirementsReadRouter {
    const listStmt = deps.db.prepare(
        'SELECT * FROM requirements ORDER BY updated_at DESC',
    );
    const getStmt = deps.db.prepare(
        'SELECT * FROM requirements WHERE requirement_id = ?',
    );
    const contractsStmt = deps.db.prepare(
        'SELECT * FROM requirement_contracts WHERE requirement_id = ? ORDER BY contract_id',
    );
    const consumersStmt = deps.db.prepare(
        'SELECT contract_id, system_id FROM requirement_contract_consumers WHERE requirement_id = ?',
    );
    const subbriefsStmt = deps.db.prepare(
        'SELECT * FROM requirement_subbriefs WHERE requirement_id = ? ORDER BY system_id',
    );
    const rolloutStmt = deps.db.prepare(
        'SELECT * FROM requirement_rollout WHERE requirement_id = ?',
    );
    const plansStmt = deps.db.prepare(
        'SELECT * FROM requirement_plans WHERE requirement_id = ? ORDER BY system_id',
    );

    return {
        handle(req, res): boolean {
            const pathname = (req.url ?? '/').split('?', 1)[0];
            const isList = REQUIREMENTS_LIST_ROUTE_PATTERN.test(pathname);
            const detail = isList ? null : REQUIREMENT_DETAIL_ROUTE_PATTERN.exec(pathname);
            if (!isList && !detail) return false;

            const method = req.method ?? 'GET';
            if (method !== 'GET') {
                respond(res, 405, { error: 'method not allowed' }, { Allow: 'GET' });
                return true;
            }

            try {
                if (isList) {
                    const rows = listStmt.all() as ReqRow[];
                    respond(res, 200, { requirements: rows.map(mapReq) });
                    return true;
                }
                const id = decodeURIComponent(detail![1]);
                const row = getStmt.get(id) as ReqRow | undefined;
                if (!row) {
                    respond(res, 404, { error: 'requirement not found', requirementId: id });
                    return true;
                }
                // Group contract consumers under each contract.
                const consumers = consumersStmt.all(id) as Array<{ contract_id: string; system_id: string }>;
                const byContract = new Map<string, string[]>();
                for (const c of consumers) {
                    const list = byContract.get(c.contract_id) ?? [];
                    list.push(c.system_id);
                    byContract.set(c.contract_id, list);
                }
                const contracts = (contractsStmt.all(id) as Array<Record<string, unknown>>).map((c) => ({
                    contractId: c.contract_id,
                    kind: c.kind,
                    name: c.name,
                    producer: c.producer_system,
                    consumers: byContract.get(c.contract_id as string) ?? [],
                    summary: c.summary,
                    schemaRef: c.schema_ref,
                    backwardCompatible: c.backward_compatible === 1,
                }));
                const subBriefs = (subbriefsStmt.all(id) as Array<Record<string, unknown>>).map((s) => ({
                    systemId: s.system_id,
                    title: s.title,
                    brief: s.brief,
                    produces: parseArr(s.produces),
                    consumes: parseArr(s.consumes),
                }));
                const rollout = (rolloutStmt.all(id) as Array<Record<string, unknown>>).map((r) => ({
                    systemId: r.system_id,
                    deployAfter: r.deploy_after,
                    reason: r.reason,
                }));
                const plans = (plansStmt.all(id) as Array<Record<string, unknown>>).map((p) => ({
                    briefId: p.brief_id,
                    systemId: p.system_id,
                    planId: p.plan_id,
                }));
                respond(res, 200, {
                    // designDoc is detail-only (it can be large) — the list
                    // response from mapReq deliberately omits it.
                    requirement: { ...mapReq(row), designDoc: row.design_md },
                    contracts,
                    subBriefs,
                    rollout,
                    plans,
                });
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                deps.logger?.error('requirements-read: failed', { error: message });
                respond(res, 500, { error: 'requirements read failed', message });
            }
            return true;
        },
    };
}

function parseArr(raw: unknown): string[] {
    if (typeof raw !== 'string' || raw.length === 0) return [];
    try {
        const v = JSON.parse(raw) as unknown;
        return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
    } catch {
        return [];
    }
}

function respond(
    res: http.ServerResponse,
    status: number,
    body: unknown,
    extraHeaders: Readonly<Record<string, string>> = {},
): void {
    res.writeHead(status, { 'Content-Type': 'application/json', ...extraHeaders });
    res.end(JSON.stringify(body));
}
