/**
 * Board-UI read projections (AP-IFG-010).
 *
 * Five v1-compatible GET endpoints that surface the state projection over
 * HTTP for the operator board. The routes mirror v1's `/api/projects/...`
 * surface so an operator (or integration test) trained on v1 sees the
 * same URLs and response shapes.
 *
 * Architectural rule: reads come from the projected state — never the
 * event log. The projection is read through {@link StatePort}, a thin
 * port that any adapter (sqlite, in-memory, fake) can satisfy. Writes
 * stay on the command bus (see `./commands.ts`); this module is purely a
 * read surface.
 *
 * Pagination on `GET /api/projects/:pid/plans` is cursor-based because
 * plans grow unbounded over the life of a project — an offset/page
 * scheme would re-scan everything on every page. The cursor is opaque
 * to the client: the port returns it and the client echoes it back via
 * `?cursor=<token>`. `limit` is clamped to {@link MAX_PAGE_LIMIT} so a
 * pathological client cannot ask the projection for the entire universe.
 *
 * Task responses include the five lineage fields recorded in
 * AP-IFG-001 (`parent_task_id`, `spawn_reason`,
 * `source_investigation_id`, `investigation_thread`,
 * `followup_inflight`). Legacy tasks that pre-date AP-IFG-001 round-trip
 * with the documented defaults — `null` for the three id/reason fields,
 * `[]` for the thread, `false` for the inflight gate — applied by the
 * adapter that produces the {@link StateTaskRecord}.
 */
import * as http from 'node:http';

import type { InvestigationThreadEntry } from '../../core/flow/engine';

/**
 * Maximum number of plans returned by a single page of
 * `GET /api/projects/:pid/plans`. A client may request a smaller page
 * via `?limit=<n>`; values above this cap are clamped down silently so
 * the projection's load profile stays bounded.
 */
export const MAX_PAGE_LIMIT = 100;

/** Default page size when the client does not specify `?limit=`. */
export const DEFAULT_PAGE_LIMIT = 50;

// ---------------------------------------------------------------------------
// Projection record shapes
// ---------------------------------------------------------------------------

/**
 * Summary view of a project as listed on `GET /api/projects`. Matches
 * the v1 board response: `id`, human-readable `name`, optional
 * `description`. `archivedAt` is surfaced so the SPA can show archived
 * projects in a separate sidebar section without a second round-trip.
 */
export interface StateProjectSummary {
    readonly id: string;
    readonly name: string;
    readonly description?: string;
    readonly archivedAt?: number;
}

/**
 * Detail view of a single project as returned by
 * `GET /api/projects/:pid`. Same fields as the summary today; the shape
 * is kept distinct so future per-project rollups (plan counts, last
 * activity timestamp) have a place to land without breaking the list
 * response.
 */
export interface StateProjectDetail {
    readonly id: string;
    readonly name: string;
    readonly description?: string;
    readonly archivedAt?: number;
}

/**
 * Summary row inside the `plans` array on
 * `GET /api/projects/:pid/plans`. The `file` field is the URL slug the
 * v1 board uses to address a plan — same naming as the `:file` path
 * parameter on the plan/task routes.
 */
export interface StatePlanSummary {
    readonly id: string;
    readonly file: string;
    readonly projectId: string;
    readonly title: string;
    readonly status: string;
    readonly createdAt: number;
}

/**
 * Full plan detail returned by `GET /api/projects/:pid/plans/:file`.
 * `body` is the plan's markdown content; `tasks` is the ordered list
 * of task ids the plan contains (not the full task records — those are
 * fetched separately to keep the plan response bounded).
 */
export interface StatePlanDetail extends StatePlanSummary {
    readonly body?: string;
    readonly tasks: ReadonlyArray<string>;
}

/**
 * Full task projection returned by
 * `GET /api/projects/:pid/plans/:file/tasks/:tid`. Mirrors
 * `TaskProjection` from `hosts/orchestrator/handlers.ts` with the
 * AP-IFG-001 lineage fields included verbatim — that is the v1
 * compatibility contract for this endpoint (AC #3).
 */
export interface StateTaskRecord {
    readonly id: string;
    readonly planId: string;
    readonly type: string;
    readonly status: string;
    readonly flowId: string | null;
    readonly parent_task_id: string | null;
    readonly spawn_reason: string | null;
    readonly source_investigation_id: string | null;
    readonly investigation_thread: ReadonlyArray<InvestigationThreadEntry>;
    readonly followup_inflight: boolean;
    /**
     * AP-IFB-001 v1-parity card fields. Surfaced so the board-ui task-card
     * renderer can populate the title row, the priority dot, the
     * type-coloured badge, and the `deps · criteria · files · iter` meta
     * row without reading any field as undefined at runtime. All optional
     * so legacy projection rows that pre-date AP-IFB-001 keep round-tripping
     * — the renderer falls back to `0` / empty string when the projection
     * has not supplied the field yet.
     */
    readonly title?: string;
    readonly priority?: string;
    readonly deps?: number;
    readonly criteria_count?: number;
    readonly files_touched?: number;
    readonly iter?: number;
}

/**
 * Result of a paginated plan listing. `nextCursor` is `null` when the
 * page returned drains the projection (no further pages); any other
 * value is an opaque continuation token the client echoes back on the
 * next request.
 */
export interface PaginatedPlans {
    readonly plans: ReadonlyArray<StatePlanSummary>;
    readonly nextCursor: string | null;
}

// ---------------------------------------------------------------------------
// Port
// ---------------------------------------------------------------------------

/**
 * Read-side port over the v2 state projection. Adapters (sqlite, fake,
 * in-memory) implement this surface; `projections.ts` consumes it
 * without caring how the rows landed there.
 *
 * Every method returns `null` / an empty list when the requested entity
 * is absent. The HTTP layer translates `null` into a 404 so unknown
 * project / plan / task ids never leak partial responses (AC #4).
 *
 * The port lives here rather than under `core/ports/` because it is a
 * board-ui-shaped read surface — the orchestrator and flow engine do
 * not consume it. A sqlite-backed adapter is intentionally deferred to
 * a follow-up task; tests in this module wire a small fake.
 */
export interface StatePort {
    /** List every project, ordered by `name` ascending. */
    readProjects(): Promise<ReadonlyArray<StateProjectSummary>>;

    /** Read a single project by id; resolves to `null` when unknown. */
    readProject(projectId: string): Promise<StateProjectDetail | null>;

    /**
     * Page through the plans owned by `projectId`. Returns an empty list
     * (NOT `null`) when the project itself is unknown — projection emptiness
     * is indistinguishable from "exists but has no plans" at this layer,
     * so the route handler issues a {@link readProject} probe first to
     * decide between 200 and 404.
     */
    readPlans(
        projectId: string,
        options: { readonly cursor: string | null; readonly limit: number },
    ): Promise<PaginatedPlans>;

    /**
     * Read a single plan by its `:file` slug under `projectId`. Resolves
     * to `null` when either the project or the plan is unknown.
     */
    readPlan(
        projectId: string,
        planFile: string,
    ): Promise<StatePlanDetail | null>;

    /**
     * Read a single task by id, scoped under the addressing plan. The
     * `projectId` / `planFile` parameters scope the lookup so URLs that
     * address a real task under the wrong plan return 404 rather than
     * leaking the record through.
     */
    readTask(
        projectId: string,
        planFile: string,
        taskId: string,
    ): Promise<StateTaskRecord | null>;
}

// ---------------------------------------------------------------------------
// Route table
// ---------------------------------------------------------------------------

/**
 * v1-shaped GET route entry. Mirrors {@link BoardUiRestRoute} from
 * `./server.ts` but for the read side. The `handle` builds the
 * response body from {@link StatePort}; the wrapping HTTP handler is
 * responsible for status codes (200 / 404 / 500) and serialisation.
 */
export interface BoardUiProjectionRoute {
    readonly method: 'GET';
    readonly pattern: string;
    /**
     * Build the response body. Resolves to `null` to signal a 404 — the
     * handler converts that into `{ error: 'not found' }`.
     */
    readonly handle: (
        statePort: StatePort,
        params: Readonly<Record<string, string>>,
        query: URLSearchParams,
    ) => Promise<unknown | null>;
}

export const BOARD_UI_PROJECTION_ROUTES: ReadonlyArray<BoardUiProjectionRoute> = [
    {
        method: 'GET',
        pattern: '/api/projects',
        handle: async (statePort) => {
            const projects = await statePort.readProjects();
            return { projects };
        },
    },
    {
        method: 'GET',
        pattern: '/api/projects/:pid',
        handle: async (statePort, params) => {
            const project = await statePort.readProject(params.pid);
            return project; // `null` → 404
        },
    },
    {
        method: 'GET',
        pattern: '/api/projects/:pid/plans',
        handle: async (statePort, params, query) => {
            // Probe project existence first so an unknown :pid returns 404
            // even when the plans projection happens to be empty for a
            // valid project.
            const project = await statePort.readProject(params.pid);
            if (project === null) return null;
            const { cursor, limit } = parsePaginationQuery(query);
            return statePort.readPlans(params.pid, { cursor, limit });
        },
    },
    {
        method: 'GET',
        pattern: '/api/projects/:pid/plans/:file',
        handle: async (statePort, params) => {
            const plan = await statePort.readPlan(params.pid, params.file);
            return plan;
        },
    },
    {
        method: 'GET',
        pattern: '/api/projects/:pid/plans/:file/tasks/:tid',
        handle: async (statePort, params) => {
            const task = await statePort.readTask(
                params.pid,
                params.file,
                params.tid,
            );
            return task;
        },
    },
];

// ---------------------------------------------------------------------------
// Pagination query parsing
// ---------------------------------------------------------------------------

/**
 * Pull `?cursor=` and `?limit=` off the URL. Unparseable / out-of-range
 * `limit` values fall back to {@link DEFAULT_PAGE_LIMIT}; the upper
 * bound is clamped to {@link MAX_PAGE_LIMIT} (see file header). A
 * missing or empty `cursor` becomes `null` for the port boundary so
 * adapters do not have to repeat the empty-string check.
 */
export function parsePaginationQuery(query: URLSearchParams): {
    cursor: string | null;
    limit: number;
} {
    const rawCursor = query.get('cursor');
    const cursor = rawCursor && rawCursor.length > 0 ? rawCursor : null;

    const rawLimit = query.get('limit');
    let limit = DEFAULT_PAGE_LIMIT;
    if (rawLimit !== null) {
        const parsed = Number(rawLimit);
        if (Number.isFinite(parsed) && parsed > 0) {
            limit = Math.min(Math.floor(parsed), MAX_PAGE_LIMIT);
        }
    }
    return { cursor, limit };
}

// ---------------------------------------------------------------------------
// Route compilation + matching (same regex strategy as ./server.ts)
// ---------------------------------------------------------------------------

interface CompiledProjectionRoute extends BoardUiProjectionRoute {
    readonly regex: RegExp;
    readonly paramNames: readonly string[];
}

function compileRoute(route: BoardUiProjectionRoute): CompiledProjectionRoute {
    const paramNames: string[] = [];
    const escaped = route.pattern.replace(/[.+*?^${}()|[\]\\]/g, '\\$&');
    const src = escaped.replace(/:([a-zA-Z][a-zA-Z0-9_]*)/g, (_, name) => {
        paramNames.push(name);
        return '([^/]+)';
    });
    return {
        ...route,
        regex: new RegExp('^' + src + '$'),
        paramNames,
    };
}

const COMPILED_ROUTES: ReadonlyArray<CompiledProjectionRoute> =
    BOARD_UI_PROJECTION_ROUTES.map(compileRoute);

interface MatchedProjectionRoute {
    readonly route: CompiledProjectionRoute;
    readonly params: Readonly<Record<string, string>>;
}

/**
 * Find the route entry that matches `(method, pathname)`. Returns
 * `null` when no route matches OR when a path parameter contains a
 * malformed percent-encoding sequence (the latter falls through to the
 * static handler, which yields 404).
 */
export function matchProjectionRoute(
    method: string,
    pathname: string,
): MatchedProjectionRoute | null {
    if (method !== 'GET') return null;
    for (const route of COMPILED_ROUTES) {
        const m = route.regex.exec(pathname);
        if (!m) continue;
        const params: Record<string, string> = {};
        let ok = true;
        for (let i = 0; i < route.paramNames.length; i++) {
            try {
                params[route.paramNames[i]] = decodeURIComponent(m[i + 1]);
            } catch {
                ok = false;
                break;
            }
        }
        if (!ok) return null;
        return { route, params };
    }
    return null;
}

// ---------------------------------------------------------------------------
// HTTP handler
// ---------------------------------------------------------------------------

/**
 * Build the read-side request handler for the board-ui server. The
 * server's `http.createServer` callback delegates here for any request
 * matched by {@link matchProjectionRoute}; everything else (proxy,
 * REST writes, static assets) is handled in `./server.ts`.
 *
 * The handler isolates two error categories from each other:
 *   - `null` from the route's `handle` → 404 `{ error: 'not found' }`.
 *   - thrown from the route's `handle` → 500 with the error message
 *     surfaced to the caller. The thrown error is also returned via
 *     the injected logger so a misbehaving adapter is observable
 *     without crawling the event log.
 *
 * `actor`/auth: this is a read-only surface, so no auth check is
 * performed here. The hosting `start()` may layer one in front if a
 * deployment exposes the projections beyond localhost.
 */
export interface ProjectionsHandlerDeps {
    readonly statePort: StatePort;
    readonly logger?: {
        error: (message: string, fields?: Record<string, unknown>) => void;
    };
}

export function createProjectionsHandler(
    deps: ProjectionsHandlerDeps,
): (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void> {
    return async (req, res): Promise<void> => {
        const url = req.url ?? '/';
        const [pathname, search = ''] = splitUrl(url);
        const match = matchProjectionRoute(req.method ?? '', pathname);
        if (!match) {
            respondJson(res, 404, { error: 'not found' });
            return;
        }

        const query = new URLSearchParams(search);
        try {
            const body = await match.route.handle(
                deps.statePort,
                match.params,
                query,
            );
            if (body === null || body === undefined) {
                respondJson(res, 404, { error: 'not found' });
                return;
            }
            respondJson(res, 200, body as Readonly<Record<string, unknown>>);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            deps.logger?.error('board-ui: projection handler threw', {
                pattern: match.route.pattern,
                error: message,
            });
            respondJson(res, 500, {
                error: 'projection failed',
                message,
            });
        }
    };
}

function splitUrl(url: string): readonly [string, string] {
    const i = url.indexOf('?');
    if (i < 0) return [url, ''];
    return [url.slice(0, i), url.slice(i + 1)];
}

function respondJson(
    res: http.ServerResponse,
    status: number,
    body: unknown,
): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
}
