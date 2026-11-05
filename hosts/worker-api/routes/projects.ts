/**
 * AP-FP-004 — read-only worker-api routes that back the operator board's
 * project sidebar.
 *
 * Endpoints:
 *
 *   GET /api/projects
 *        Returns every active row from the `projects` projection table —
 *        i.e. rows where `archived_at IS NULL`. Response body:
 *        `{ projects: ProjectRecord[] }`. Empty projection ⇒
 *        `{ projects: [] }`. The wrapper key matches the v1 board
 *        convention — the SPA destructures `json.projects` on every
 *        CRUD reload. No Linear fallback is performed here.
 *
 *   GET /api/projects/:pid/plans
 *        Returns every active plan (`archived_at IS NULL`) whose `pid`
 *        column matches the path parameter. Response body:
 *        `{ plans: PlanRecord[] }`. An unknown pid returns 200 with
 *        `{ plans: [] }`, NOT 404 — "no plans for this project" is a
 *        valid steady state and the board's polling loop should not
 *        treat it as an error.
 *
 * Architectural rule (mirrors `decompose-status.ts`): reads come from a
 * projection port — never the event log directly. The port surface is
 * intentionally tiny so a unit test can swap in a fake or wire a real
 * in-memory SQLite handle without dragging the rest of the host along.
 *
 * Production wiring lives in {@link SqliteProjectsReadStore}, also in
 * this file because the adapter is a thin two-statement shim and lives
 * in lockstep with the route. It is exported so `hosts/worker-api/main.ts`
 * can construct it against the orchestrator's SQLite handle.
 */

import * as http from 'node:http';

import type Database from 'better-sqlite3';

import type { Db } from '../../../core/state/migrations';
import type { Logger } from '../../../core/ports/Logger';

type SqliteStatement = Database.Statement<unknown[], unknown>;

/**
 * Wire shape of one row in the `GET /api/projects` response. `name` and
 * `linearInitiativeId` are nullable because the projection columns are —
 * a project created before the operator typed a label still has a row
 * with `name = NULL`, and a standalone project never gets a Linear id.
 */
export interface ProjectRecord {
    readonly id: string;
    readonly name: string | null;
    readonly linearInitiativeId: string | null;
    /**
     * Operator-supplied project extras (abbr / color / description /
     * repos) folded into a JSON blob on the projection row. Parsed at
     * the route boundary so the SPA narrows to its own typed shape on
     * read. `null` when the row has no metadata recorded yet.
     */
    readonly metadata: Readonly<Record<string, unknown>> | null;
    readonly updatedAt: number | null;
}

/**
 * Wire shape of one row in the `GET /api/projects/:pid/plans` response.
 * `status` mirrors the operator-facing vocabulary documented in
 * `shared/plan-linear.ts`; the projection populates it from plan
 * lifecycle events.
 */
export interface PlanRecord {
    readonly planId: string;
    readonly pid: string;
    readonly name: string | null;
    readonly status: string | null;
    readonly updatedAt: number | null;
}

/**
 * Wire shape of `GET /api/projects/:pid/plans/:planId` — the per-plan
 * read endpoint the edit-plan modal hits on open so it pre-fills with
 * the projection's latest data, not whatever the row list happened to
 * carry. Superset of {@link PlanRecord} (adds `body` + `metadata`).
 *
 * `metadata` is the parsed JSON blob from the `sidebar_plans.metadata`
 * column. The wire shape is intentionally `Readonly<Record<string,
 * unknown>>` so the projection can grow new knobs without coordinating
 * a route bump — the modal narrows to its own typed shape on read.
 */
export interface PlanDetailRecord {
    readonly planId: string;
    readonly pid: string;
    readonly name: string | null;
    readonly body: string | null;
    readonly metadata: Readonly<Record<string, unknown>> | null;
    readonly status: string | null;
    readonly updatedAt: number | null;
}

/**
 * Read-side port over the projections that back the sidebar. Returns
 * synchronous arrays — the underlying SQLite reads are cheap and the
 * board's polling cadence (seconds, not milliseconds) does not need an
 * async hop. Tests pass in-memory fakes; production wires
 * {@link SqliteProjectsReadStore}.
 */
export interface ProjectsReadStore {
    listActiveProjects(): readonly ProjectRecord[];
    listActivePlansForProject(pid: string): readonly PlanRecord[];
    /**
     * Fetch one plan by its composite (pid, planId) key. Returns
     * `null` when the row is missing or archived — the edit-modal
     * caller treats that as a 404 and falls back to opening the
     * modal in create mode.
     */
    getPlanDetail(pid: string, planId: string): PlanDetailRecord | null;
}

export interface ProjectsRoutesDeps {
    readonly store: ProjectsReadStore;
    readonly logger?: Logger;
}

export interface RouteResult {
    readonly status: number;
    readonly body: unknown;
}

// ---------------------------------------------------------------------------
// Pure handlers
// ---------------------------------------------------------------------------

/**
 * `GET /api/projects` — list every active project the projection knows
 * about. Always returns 200 with `{ projects: [...] }`; an empty
 * projection ⇒ `{ projects: [] }`. The wrapper key matches the v1 board
 * convention (also used by the notes route) — the SPA destructures
 * `json.projects` on every CRUD reload.
 */
export function listProjects(deps: ProjectsRoutesDeps): RouteResult {
    const projects = deps.store.listActiveProjects();
    deps.logger?.info('projects: list', { count: projects.length });
    return { status: 200, body: { projects } };
}

/**
 * `GET /api/projects/:pid/plans` — list every active plan under the
 * supplied project id. An unknown pid resolves to `{ plans: [] }`, not
 * 404 — the sidebar treats "no plans yet" as a valid state and the
 * polling loop stays trivial.
 */
export function listPlansForProject(
    deps: ProjectsRoutesDeps,
    pid: string,
): RouteResult {
    const plans = deps.store.listActivePlansForProject(pid);
    deps.logger?.info('projects: list-plans', { pid, count: plans.length });
    return { status: 200, body: { plans } };
}

/**
 * `GET /api/projects/:pid/plans/:planId` — fetch one plan including
 * its `body` so the edit-plan modal pre-fills with up-to-date data.
 * Returns 200 with `{ plan: PlanDetailRecord }` on hit, 404 with
 * `{ error: 'not found' }` when the projection has no row for the
 * (pid, planId) key. The single-key wrapper matches the rest of the
 * /api/projects family.
 */
export function getPlanDetail(
    deps: ProjectsRoutesDeps,
    pid: string,
    planId: string,
): RouteResult {
    const plan = deps.store.getPlanDetail(pid, planId);
    if (plan === null) {
        deps.logger?.info('projects: get-plan miss', { pid, planId });
        return { status: 404, body: { error: 'not found' } };
    }
    deps.logger?.info('projects: get-plan', { pid, planId });
    return { status: 200, body: { plan } };
}

// ---------------------------------------------------------------------------
// HTTP wrapper
// ---------------------------------------------------------------------------

export const PROJECTS_LIST_ROUTE_PATTERN = /^\/api\/projects\/?$/;
export const PROJECTS_PLANS_ROUTE_PATTERN =
    /^\/api\/projects\/([^/]+)\/plans\/?$/;
export const PROJECT_PLAN_DETAIL_ROUTE_PATTERN =
    /^\/api\/projects\/([^/]+)\/plans\/([^/]+)\/?$/;

export interface ProjectsRouter {
    /**
     * Attempt to handle the request. Returns `true` when the URL matched
     * one of the projects routes (a response was sent), `false` otherwise
     * so a parent server can fall through to its own routes.
     */
    handle(req: http.IncomingMessage, res: http.ServerResponse): boolean;
}

export function createProjectsRouter(deps: ProjectsRoutesDeps): ProjectsRouter {
    return {
        handle(req, res): boolean {
            const url = req.url ?? '/';
            const pathname = url.split('?', 1)[0];
            const method = req.method ?? 'GET';

            if (PROJECTS_LIST_ROUTE_PATTERN.test(pathname)) {
                if (method !== 'GET') {
                    respond(
                        res,
                        405,
                        { error: 'method not allowed' },
                        { Allow: 'GET' },
                    );
                    return true;
                }
                try {
                    const r = listProjects(deps);
                    respond(res, r.status, r.body);
                } catch (err) {
                    fail(deps, res, 'list', undefined, err);
                }
                return true;
            }

            const plansMatch = PROJECTS_PLANS_ROUTE_PATTERN.exec(pathname);
            if (plansMatch) {
                if (method !== 'GET') {
                    respond(
                        res,
                        405,
                        { error: 'method not allowed' },
                        { Allow: 'GET' },
                    );
                    return true;
                }
                let pid: string;
                try {
                    pid = decodeURIComponent(plansMatch[1]);
                } catch {
                    respond(res, 404, { error: 'not found' });
                    return true;
                }
                try {
                    const r = listPlansForProject(deps, pid);
                    respond(res, r.status, r.body);
                } catch (err) {
                    fail(deps, res, 'list-plans', pid, err);
                }
                return true;
            }

            // Plan detail: `/api/projects/:pid/plans/:planId`. The
            // existing plan-review / decompose-status / task-diff
            // patterns require a trailing path segment after planId,
            // so this pattern is checked last and only matches when
            // there is no further segment.
            const detailMatch = PROJECT_PLAN_DETAIL_ROUTE_PATTERN.exec(pathname);
            if (detailMatch) {
                if (method !== 'GET') {
                    respond(
                        res,
                        405,
                        { error: 'method not allowed' },
                        { Allow: 'GET' },
                    );
                    return true;
                }
                let pid: string;
                let planId: string;
                try {
                    pid = decodeURIComponent(detailMatch[1]);
                    planId = decodeURIComponent(detailMatch[2]);
                } catch {
                    respond(res, 404, { error: 'not found' });
                    return true;
                }
                try {
                    const r = getPlanDetail(deps, pid, planId);
                    respond(res, r.status, r.body);
                } catch (err) {
                    fail(deps, res, 'get-plan', pid, err);
                }
                return true;
            }

            return false;
        },
    };
}

function fail(
    deps: ProjectsRoutesDeps,
    res: http.ServerResponse,
    action: string,
    pid: string | undefined,
    err: unknown,
): void {
    deps.logger?.error(`projects: ${action} failed`, {
        pid,
        error: err instanceof Error ? err.message : String(err),
    });
    respond(res, 500, {
        error: `projects ${action} failed`,
        message: err instanceof Error ? err.message : String(err),
    });
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

// ---------------------------------------------------------------------------
// Production adapter (SqliteProjectsReadStore)
// ---------------------------------------------------------------------------

interface ProjectRow {
    readonly id: string;
    readonly name: string | null;
    readonly linear_initiative_id: string | null;
    readonly metadata: string | null;
    readonly updated_at: number | null;
}

interface PlanRow {
    readonly plan_id: string;
    readonly pid: string;
    readonly name: string | null;
    readonly status: string | null;
    readonly updated_at: number | null;
}

interface PlanDetailRow extends PlanRow {
    readonly body: string | null;
    readonly metadata: string | null;
}

/**
 * Production `ProjectsReadStore` over the AP-FP-001 projection tables.
 *
 * Statement preparation is deferred to the first call so the route module
 * stays decoupled from the schema-application step. In production the
 * projection schema is part of the regular migrations runner
 * (`core/state/migrations/006_sidebar_projections.sql`), but lazy-prep
 * keeps the adapter usable against a freshly-opened DB that has not yet
 * had migrations applied (mirrors the test bootstrap convention).
 *
 * Stable ordering: projects sort by `id ASC`, plans by `plan_id ASC`. Both
 * are deterministic regardless of clock skew on `updated_at`, which keeps
 * the operator board's row order stable across polls and lets tests
 * assert on a fixed order without sleeping between seed inserts.
 */
export class SqliteProjectsReadStore implements ProjectsReadStore {
    private listProjectsStmt: SqliteStatement | undefined;
    private listPlansStmt: SqliteStatement | undefined;
    private getPlanDetailStmt: SqliteStatement | undefined;

    constructor(private readonly db: Db) {}

    listActiveProjects(): readonly ProjectRecord[] {
        if (!this.listProjectsStmt) {
            this.listProjectsStmt = this.db.prepare(
                `SELECT id, name, linear_initiative_id, metadata, updated_at
                 FROM projects
                 WHERE archived_at IS NULL
                 ORDER BY id ASC`,
            );
        }
        const rows = this.listProjectsStmt.all() as ReadonlyArray<ProjectRow>;
        return rows.map(toProjectRecord);
    }

    listActivePlansForProject(pid: string): readonly PlanRecord[] {
        if (!this.listPlansStmt) {
            this.listPlansStmt = this.db.prepare(
                `SELECT plan_id, pid, name, status, updated_at
                 FROM sidebar_plans
                 WHERE pid = ? AND archived_at IS NULL
                 ORDER BY plan_id ASC`,
            );
        }
        const rows = this.listPlansStmt.all(pid) as ReadonlyArray<PlanRow>;
        return rows.map(toPlanRecord);
    }

    getPlanDetail(pid: string, planId: string): PlanDetailRecord | null {
        if (!this.getPlanDetailStmt) {
            this.getPlanDetailStmt = this.db.prepare(
                `SELECT plan_id, pid, name, body, metadata, status, updated_at
                 FROM sidebar_plans
                 WHERE pid = ? AND plan_id = ? AND archived_at IS NULL`,
            );
        }
        const row = this.getPlanDetailStmt.get(pid, planId) as
            | PlanDetailRow
            | undefined;
        return row ? toPlanDetailRecord(row) : null;
    }
}

function toProjectRecord(row: ProjectRow): ProjectRecord {
    return {
        id: row.id,
        name: row.name,
        linearInitiativeId: row.linear_initiative_id,
        metadata: parseMetadata(row.metadata),
        updatedAt: row.updated_at,
    };
}

function toPlanRecord(row: PlanRow): PlanRecord {
    return {
        planId: row.plan_id,
        pid: row.pid,
        name: row.name,
        status: row.status,
        updatedAt: row.updated_at,
    };
}

function toPlanDetailRecord(row: PlanDetailRow): PlanDetailRecord {
    return {
        planId: row.plan_id,
        pid: row.pid,
        name: row.name,
        body: row.body,
        metadata: parseMetadata(row.metadata),
        status: row.status,
        updatedAt: row.updated_at,
    };
}

/**
 * Parse the JSON metadata blob persisted on a sidebar_plans row.
 * Returns `null` for an empty column or a malformed payload — the
 * modal renders the absence as "no captured values" and re-emits a
 * fresh object on save, so we never propagate a broken blob.
 */
function parseMetadata(
    raw: string | null,
): Readonly<Record<string, unknown>> | null {
    if (typeof raw !== 'string' || raw.length === 0) return null;
    try {
        const parsed = JSON.parse(raw);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return null;
        }
        return parsed as Readonly<Record<string, unknown>>;
    } catch {
        return null;
    }
}
