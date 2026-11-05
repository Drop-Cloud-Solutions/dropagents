import * as fs from 'node:fs';
import * as http from 'node:http';
import * as https from 'node:https';
import * as path from 'node:path';

import { authorize } from '../../adapters/board-http/auth';
import {
    InvestigationCommands,
    PlanLifecycleCommands,
    isDismissInvestigationPayload,
    isGeneratePlanPayload,
    isImplementFromInvestigationPayload,
} from '../../core/commands/index';
import {
    RepoCommands,
    isArchiveRepoPayload,
    isRefreshAllReposPayload,
    isRefreshRepoPayload,
    isCreateRepoPayload,
    isRegisterRepoPayload,
    isUpdateRepoPayload,
} from '../../core/commands/repos';
import { decideRemoteBind } from '../bind-guard';
import { loadDotenv } from '../loadDotenv';
import {
    BOARD_UI_COMMAND_ROUTES,
    BoardUiCommands,
    isArchiveProjectPayload,
    isCreateInvestigationPayload,
    isCreateNotePayload,
    isCreatePlanPayload,
    isCreateProjectPayload,
    isDeleteNotePayload,
    isDeletePlanPayload,
    isDeleteTaskPayload,
    isUpdateNotePayload,
    isUpdatePlanPayload,
    isUpdateProjectPayload,
    isUpdateTaskPayload,
} from './commands';
import {
    createProjectionsHandler,
    matchProjectionRoute,
    type StatePort,
} from './projections';

/**
 * Static-file server for the operator board SPA, with a same-origin
 * reverse proxy for the two worker-api endpoints the board talks to.
 *
 * Serves the three assets that live next to this file â€” `index.html`,
 * `board.js`, `board.css` â€” over HTTP. `GET /` resolves to `index.html`;
 * any other static path is looked up by name inside this same directory.
 *
 * `GET /events` (Server-Sent Events) and `POST /commands` are proxied
 * to the worker-api (default `http://127.0.0.1:4101`, override with the
 * `WORKER_API_URL` env var or the `workerApiUrl` option). Request bodies
 * and SSE response chunks stream through unchanged. When
 * `WORKER_API_TOKEN_V2` is set the proxy injects
 * `Authorization: Bearer <token>` on the upstream request so the browser
 * never sees the token â€” EventSource can't send custom headers anyway,
 * and a same-origin board with a server-side proxy is the only sane way
 * to authenticate SSE traffic.
 *
 * Path-traversal defence: the resolved static path must stay underneath
 * this directory. Symlinks aren't followed.
 */

const DEFAULT_PORT = 4100;
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_WORKER_API_URL = 'http://127.0.0.1:4101';
const ASSET_DIR = __dirname;
const INDEX_FILE = 'index.html';

const ALLOWED_FILES = new Set<string>([INDEX_FILE, 'board.js', 'board.css']);
// AP-IFG-022: `/context-updates/pending` is a read-side projection owned by
// the worker-api (the parked-task index). Proxying it here keeps a single
// source of truth on the worker side without standing up another StatePort
// method — the board only needs the pending list and the run/skip routes
// below to drive the panel.
//
// AP-IFF-007: wave 1 projection routes (`decompose-status`, `plan-review`,
// `plan-review/regenerate`) are also owned by the worker-api. They are not
// listed here because they carry `:projectId` and `:planId` path segments —
// see {@link PROXY_PATH_PATTERNS} below for the regex form used by the
// match step.
//
// AP-IFF-018: `/api/worker-log/snapshot` and `/api/worker-log/tail` are the
// worker-api routes shipped in AP-IFF-017. The worker-log modal hits both
// from the browser; proxying them here lets the modal use same-origin URLs
// and keeps the worker-api auth token off the client.
const PROXY_PATHS = new Set<string>([
    '/events',
    '/commands',
    '/context-updates/pending',
    '/api/worker-log/snapshot',
    '/api/worker-log/tail',
    // Plan-review pending list — the board hits this once on boot to
    // re-hydrate the active-planner cards after a page reload.
    '/api/plan-reviews',
    // Durable tasks list. The board hits this on boot so task cards
    // survive a worker-api restart / browser reload.
    '/api/tasks',
    // Active decomposers — boot hydration so the decomposer card stays
    // on screen across a page reload while the underlying agent runs.
    '/api/active-decomposers',
    // Full plan list — backs the Draft / Progress / Completed /
    // Archived sections on the main board.
    '/api/plans',
    // Architect Tier (Phase 2): the Requirements lane hydration.
    '/api/requirements',
    // Flow-stage catalog — the board fetches this once on boot to render the
    // task-card stage-bar chips (hydrateFlowStages in board.ts).
    '/api/flow-stages',
    // Task types + plan archetypes for the Add-task menu and the new-plan
    // "Plan type" dropdown (hydrateTaskTypes in board.ts).
    '/api/task-types',
    // Declared GitHub accounts, for the account picker on the repo
    // forms. Ids only; the manager UI owns creating and testing them.
    '/api/github-accounts',
]);

// AP-IFF-007: wildcard proxy paths. These carry `:projectId`/`:planId` so a
// plain Set lookup will not match. The board stays a thin proxy — the
// upstream worker-api owns the projection logic; the regexes only need to
// recognise that a path *should* be forwarded.
//
// AP-IFF-010: the task-diff route (`/api/projects/:pid/plans/:planId/tasks/
// :taskId/diff`) is also a worker-api projection — the diff-review modal
// fetches parsed hunks through this proxy entry.
//
// AP-FP-005: `/api/projects` (project list) and `/api/projects/:pid/plans`
// (per-project plan list) are the read-side projections shipped in
// AP-FP-004. They share the `/api/projects` prefix with REST write routes
// (POST /api/projects → CreateProject, POST /api/projects/:pid/plans →
// CreatePlan), so the dispatcher matches REST routes BEFORE the proxy
// fallback — `matchRestRoute` is method-aware and only fires for the write
// methods, leaving GETs to fall through here.
const PROXY_PATH_PATTERNS: ReadonlyArray<RegExp> = [
    // Workspace repo registry — list + per-repo detail. Writes
    // (POST/PATCH/DELETE + /refresh + /refresh-all) hit the REST
    // translator below.
    /^\/api\/repos\/?$/,
    /^\/api\/repos\/[^/]+$/,
    /^\/api\/gh\/auth-user\/?$/,
    /^\/api\/projects$/,
    /^\/api\/projects\/[^/]+\/plans$/,
    // Project architecture context (GET + PUT). The board's Context modal
    // reads and writes it through the worker-api, which proxies on to the
    // manager-api. Without this entry the request never leaves the board
    // server: it falls through to the static handler and 404s, which is
    // exactly how it shipped — the modal opened, failed to load, and left
    // the textarea disabled with a save button that could do nothing.
    // The proxy is method-agnostic once matched, so one pattern covers
    // both verbs; `matchRestRoute` above claims no /context-md path.
    /^\/api\/projects\/[^/]+\/context-md$/,
    // Architect Tier (Phase 2): per-requirement detail (design, contracts,
    // sub-briefs, rollout, fanned-out plans).
    /^\/api\/requirements\/[^/]+$/,
    // Per-plan detail read (edit-plan modal calls this on open so it
    // pre-fills with up-to-date data). Matches only when there is no
    // trailing segment after the planId — the sibling patterns below
    // claim the `/decompose-status` / `/plan-review` etc. suffixes.
    /^\/api\/projects\/[^/]+\/plans\/[^/]+$/,
    /^\/api\/projects\/[^/]+\/plans\/[^/]+\/decompose-status$/,
    /^\/api\/projects\/[^/]+\/plans\/[^/]+\/plan-review$/,
    /^\/api\/projects\/[^/]+\/plans\/[^/]+\/plan-review\/regenerate$/,
    /^\/api\/projects\/[^/]+\/plans\/[^/]+\/plan-review\/approve$/,
    /^\/api\/projects\/[^/]+\/plans\/[^/]+\/tasks\/[^/]+\/diff$/,
    // Per-step agent run records used by the stage-bar chips + the
    // per-stage summary modal on a task card.
    /^\/api\/tasks\/[^/]+\/step-summaries\/?$/,
    // Lazy task detail — description + ticketDetails, withheld from the
    // /api/tasks list for closed tasks so boot hydration does not ship
    // megabytes of prose nothing renders. The task modal fetches one row
    // when it opens.
    /^\/api\/tasks\/[^/]+\/detail\/?$/,
    // Chat surface — sessions (list/create/read/delete/messages/stop/
    // notes/pr) and the durable plan-link table (/api/chat/links). One
    // regex covers the whole /api/chat prefix.
    /^\/api\/chat\/.*$/,
    // Attachments (migration 021): upload (POST), list (GET ?ownerType=),
    // download (GET /:id), delete (DELETE /:id). The opaque proxy streams
    // the raw binary body up and the bytes back down unchanged, so images
    // and documents pass through verbatim — no JSON re-encoding.
    /^\/api\/attachments\/?$/,
    /^\/api\/attachments\/[^/]+$/,
    // AP-VP5-008 task action endpoints — POSTed by the clarify /
    // reject / investigation-followup modals. The worker-api owns the
    // command-dispatch logic; the board's modal hits these paths on
    // the same origin and we forward them verbatim.
    /^\/tasks\/[^/]+\/clarify\/?$/,
    /^\/tasks\/[^/]+\/reject\/?$/,
    /^\/tasks\/[^/]+\/investigation-followup\/?$/,
    // The READ side of the same modal. It was missing: board.ts fetches
    // `/tasks/:id/investigation-thread` and the worker-api serves it, but
    // without an entry here the GET never left the board server — it fell
    // through to the static handler and 404'd, so the follow-up modal
    // opened with an empty thread and no error.
    /^\/tasks\/[^/]+\/investigation-thread\/?$/,
    // The plan-lifecycle twin of /tasks/:id/clarify — the Answer button on
    // a decomposer card held on a question POSTs here.
    /^\/plans\/[^/]+\/decomposer-answer\/?$/,
    // Giving up on the question rather than answering it. A separate path
    // because an answer can never be an ACTION: the decomposer offered
    // "cancel the task" among its own options, and answering with it
    // re-spawned the decomposer, which asked the same question again.
    /^\/plans\/[^/]+\/decomposer-abandon\/?$/,
    // AP-VP5-009: worker-api notes read route. The router serves under
    // `/projects/:projectId/notes` (no `/api/` prefix) to match v1, and the
    // notes panel polls that path directly. Writes use a different
    // mechanism — the `/api/projects/:pid/notes` POST/PATCH/DELETE routes
    // are translated into commands by the board-ui server itself.
    /^\/projects\/[^/]+\/notes\/?$/,
];

/**
 * Exported for tests: the allowlist is the reason a new worker-api route
 * can be live, reachable with curl, and still 404 in the browser — the
 * board server serves anything unmatched as a static file. That failure
 * looks like a broken API, not a missing proxy entry.
 */
export function matchesProxyPath(pathname: string): boolean {
    if (PROXY_PATHS.has(pathname)) return true;
    for (const pattern of PROXY_PATH_PATTERNS) {
        if (pattern.test(pathname)) return true;
    }
    return false;
}

const MAX_BODY_BYTES = 1_000_000;

/**
 * Worker-log endpoints (AP-IFG-021). Both routes read the same v2 log
 * file at `<repo-root>/shared/.cache/worker.log` — the location written
 * by `adapters/logging/file-logger.ts`. The snapshot endpoint returns
 * the current content (optionally sliced from a byte offset); the SSE
 * endpoint tails the file and emits each newly-appended line as a
 * `data:` frame. Both endpoints honour the `workerApiToken` Bearer
 * auth check when one is configured (AC #3).
 *
 * Rotation handling (AC #4): the on-disk file is replaced when
 * `FileLogger` rolls the day, which means a follow-up `?since=N` may
 * arrive with an `N` that exceeds the current file size. We treat that
 * as a truncation event and return the whole new file plus a
 * `truncated: true` flag so the client can resync its offset rather
 * than silently drop the rollover boundary.
 */
const WORKER_LOG_SNAPSHOT_PATH = '/api/worker/log';
const WORKER_LOG_SSE_PATH = '/events/worker-log';
const WORKER_LOG_POLL_MS = 500;
const WORKER_LOG_HEARTBEAT_MS = 15_000;
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_WORKER_LOG_PATH = path.join(
    REPO_ROOT,
    'shared',
    '.cache',
    'worker.log',
);

/**
 * Investigation-action POST routes (AP-NVP-031 / AP-IFW-004). Each
 * translates a small request body â€” `{taskId, reportId, reason?}` â€”
 * into a fully formed `Command` object and forwards it to the
 * worker-api's existing `/commands` endpoint. The SPA hits these
 * instead of crafting Command JSON itself, so the command vocabulary
 * stays owned by the orchestrator-side command bus. The validators are
 * the same type guards exported by `core/commands/index.ts`, so the
 * board can't fall out of sync with the handler's accepted shapes.
 */
interface InvestigationRoute {
    readonly commandType: string;
    readonly validate: (payload: unknown) => boolean;
}

const INVESTIGATION_ROUTES: Readonly<Record<string, InvestigationRoute>> = {
    '/commands/implement-from-investigation': {
        commandType: InvestigationCommands.IMPLEMENT_FROM_INVESTIGATION,
        validate: isImplementFromInvestigationPayload,
    },
    '/commands/dismiss-investigation': {
        commandType: InvestigationCommands.DISMISS_INVESTIGATION,
        validate: isDismissInvestigationPayload,
    },
    // AP-IFG-008: the 13 board-ui CRUD + agent-cancellation routes share the
    // same translation mechanism as the investigation routes above. Their
    // command type + validator pairs live next to the handlers in
    // `./commands.ts` so the URL â†’ Command vocabulary stays single-sourced.
    ...BOARD_UI_COMMAND_ROUTES,
};

/**
 * v1-compatible REST surface (AP-IFG-009). Mirrors the v1 board's
 * `/api/projects/...` routes so operators trained on v1 keep the same
 * URLs. Each entry is a thin translator: extract path params, parse the
 * optional JSON body, merge the two into a command payload, validate
 * it, and forward a `Command` envelope to the worker-api's
 * `POST /commands` endpoint. No mutation happens inline â€” the
 * no-mutation-outside-the-bus invariant is preserved.
 *
 * Path-extracted ids always win over any same-named field in the JSON
 * body (the URL is the authoritative id), which is why every `build`
 * for a PATCH/PUT spreads the body first and then overlays the path id.
 *
 * The `BOARD_UI_REST_ROUTES` table is exported (AC #4) so the
 * integration suite can iterate every (method, pattern) pair and assert
 * each one round-trips through `/commands` with the expected command
 * type â€” that's the parity contract with v1.
 */
export interface BoardUiRestRoute {
    readonly method: 'POST' | 'PATCH' | 'PUT' | 'DELETE';
    readonly pattern: string;
    readonly commandType: string;
    readonly validate: (payload: unknown) => boolean;
    /**
     * Combine path params + parsed JSON body into the command payload.
     * `body` is `{}` when the request had no body (DELETE) or an empty
     * body (POST with `Content-Length: 0`). The result is then handed
     * to `validate` â€” a malformed result returns 400 to the caller and
     * the upstream `/commands` endpoint is never hit.
     */
    readonly build: (
        params: Readonly<Record<string, string>>,
        body: unknown,
    ) => unknown;
}

function bodyObject(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
}

// AP-IFG-022: command types dispatched by the two context-update routes
// below. Defined inline (rather than in `./commands.ts`) because the
// handlers live host-side — the orchestrator's existing
// `context-update-curator` flow already owns the side effects; this surface
// just translates an operator click into a `Command` envelope the bus can
// route by `type`.
const RUN_CONTEXT_UPDATE_COMMAND = 'RunContextUpdate';
const SKIP_CONTEXT_UPDATE_COMMAND = 'SkipContextUpdate';

function isContextUpdatePayload(value: unknown): boolean {
    if (!value || typeof value !== 'object') return false;
    const v = value as Record<string, unknown>;
    return typeof v.taskId === 'string' && v.taskId.length > 0;
}

export const BOARD_UI_REST_ROUTES: ReadonlyArray<BoardUiRestRoute> = [
    // Workspace repo registry — write side. Reads fall through to the
    // proxy entries above. Pattern: POST /api/repos to register a new
    // one, PATCH /api/repos/:id to rename / change url, DELETE
    // /api/repos/:id to archive, POST /api/repos/:id/refresh to sync
    // one, POST /api/repos/refresh-all to sync the whole active set.
    {
        method: 'POST',
        pattern: '/api/repos',
        commandType: RepoCommands.REGISTER_REPO,
        validate: isRegisterRepoPayload,
        build: (_params, body) => bodyObject(body),
    },
    {
        // Dedicated create route. Distinct from POST /api/repos so the
        // form's body shape (name + owner + description + visibility)
        // doesn't compete with the register payload validator.
        method: 'POST',
        pattern: '/api/repos/create',
        commandType: RepoCommands.CREATE_REPO,
        validate: isCreateRepoPayload,
        build: (_params, body) => bodyObject(body),
    },
    {
        method: 'PATCH',
        pattern: '/api/repos/:repoId',
        commandType: RepoCommands.UPDATE_REPO,
        validate: isUpdateRepoPayload,
        build: (params, body) => ({ ...bodyObject(body), repoId: params.repoId }),
    },
    {
        method: 'DELETE',
        pattern: '/api/repos/:repoId',
        commandType: RepoCommands.ARCHIVE_REPO,
        validate: isArchiveRepoPayload,
        build: (params) => ({ repoId: params.repoId }),
    },
    {
        method: 'POST',
        pattern: '/api/repos/:repoId/refresh',
        commandType: RepoCommands.REFRESH_REPO,
        validate: isRefreshRepoPayload,
        build: (params) => ({ repoId: params.repoId }),
    },
    {
        method: 'POST',
        pattern: '/api/repos/refresh-all',
        commandType: RepoCommands.REFRESH_ALL_REPOS,
        validate: isRefreshAllReposPayload,
        build: () => ({}),
    },
    {
        method: 'POST',
        pattern: '/api/projects',
        commandType: BoardUiCommands.CREATE_PROJECT,
        validate: isCreateProjectPayload,
        build: (_params, body) => bodyObject(body),
    },
    {
        method: 'PATCH',
        pattern: '/api/projects/:pid',
        commandType: BoardUiCommands.UPDATE_PROJECT,
        validate: isUpdateProjectPayload,
        build: (params, body) => ({ ...bodyObject(body), projectId: params.pid }),
    },
    {
        // DELETE on a project is a soft-delete (archive). The PATCH
        // route above can't carry the intent — the Update handler
        // ignores extra keys, so the previous `{ archived: true }`
        // body silently no-op'd. Mirrors the DeletePlan pattern.
        method: 'DELETE',
        pattern: '/api/projects/:pid',
        commandType: BoardUiCommands.ARCHIVE_PROJECT,
        validate: isArchiveProjectPayload,
        build: (params) => ({ projectId: params.pid }),
    },
    {
        method: 'POST',
        pattern: '/api/projects/:pid/plans',
        commandType: BoardUiCommands.CREATE_PLAN,
        validate: isCreatePlanPayload,
        build: (params, body) => ({ ...bodyObject(body), projectId: params.pid }),
    },
    {
        method: 'PATCH',
        pattern: '/api/projects/:pid/plans/:file',
        commandType: BoardUiCommands.UPDATE_PLAN,
        validate: isUpdatePlanPayload,
        build: (params, body) => ({ ...bodyObject(body), planId: params.file }),
    },
    {
        // Operator-fired planner run. Translates into a `GeneratePlan`
        // command — the orchestrator's plan-lifecycle handler dispatches
        // the Claude CLI planner against the plan brief and emits
        // `PlanGenerated` once the agent finishes. Body keys mirror the
        // GeneratePlan payload (revision required; feedback +
        // previousContent optional for regenerate flows).
        method: 'POST',
        pattern: '/api/projects/:pid/plans/:file/generate-plan',
        commandType: PlanLifecycleCommands.GENERATE_PLAN,
        validate: isGeneratePlanPayload,
        build: (params, body) => ({
            ...bodyObject(body),
            projectId: params.pid,
            planId: params.file,
        }),
    },
    {
        method: 'DELETE',
        pattern: '/api/projects/:pid/plans/:file',
        commandType: BoardUiCommands.DELETE_PLAN,
        validate: isDeletePlanPayload,
        build: (params) => ({ planId: params.file }),
    },
    {
        method: 'PUT',
        pattern: '/api/projects/:pid/plans/:file/tasks/:tid',
        commandType: BoardUiCommands.EDIT_TASK,
        validate: isUpdateTaskPayload,
        build: (params, body) => ({ ...bodyObject(body), taskId: params.tid }),
    },
    {
        method: 'DELETE',
        pattern: '/api/projects/:pid/plans/:file/tasks/:tid',
        commandType: BoardUiCommands.DELETE_TASK,
        validate: isDeleteTaskPayload,
        build: (params) => ({ taskId: params.tid }),
    },
    {
        method: 'POST',
        pattern: '/api/projects/:pid/investigations',
        commandType: BoardUiCommands.CREATE_INVESTIGATION,
        validate: isCreateInvestigationPayload,
        build: (_params, body) => bodyObject(body),
    },
    {
        method: 'POST',
        pattern: '/api/projects/:pid/notes',
        commandType: BoardUiCommands.CREATE_NOTE,
        validate: isCreateNotePayload,
        build: (params, body) => ({
            ...bodyObject(body),
            targetType: 'project',
            targetId: params.pid,
        }),
    },
    {
        method: 'POST',
        pattern: '/api/projects/:pid/plans/:file/notes',
        commandType: BoardUiCommands.CREATE_NOTE,
        validate: isCreateNotePayload,
        build: (params, body) => ({
            ...bodyObject(body),
            targetType: 'plan',
            targetId: params.file,
        }),
    },
    {
        method: 'POST',
        pattern: '/api/projects/:pid/plans/:file/tasks/:tid/notes',
        commandType: BoardUiCommands.CREATE_NOTE,
        validate: isCreateNotePayload,
        build: (params, body) => ({
            ...bodyObject(body),
            targetType: 'task',
            targetId: params.tid,
        }),
    },
    {
        method: 'PATCH',
        pattern: '/api/notes/:nid',
        commandType: BoardUiCommands.UPDATE_NOTE,
        validate: isUpdateNotePayload,
        build: (params, body) => ({ ...bodyObject(body), noteId: params.nid }),
    },
    {
        method: 'DELETE',
        pattern: '/api/notes/:nid',
        commandType: BoardUiCommands.DELETE_NOTE,
        validate: isDeleteNotePayload,
        build: (params) => ({ noteId: params.nid }),
    },
    // AP-IFG-022: context-update curator surfaces. Both routes carry the
    // task id in the URL and translate to a fixed command whose payload is
    // just `{ taskId }`. The handler is the existing `context-update-curator`
    // flow on the orchestrator side — `run` resumes the parked task to
    // accept the curator's CLAUDE.md PR; `skip` resumes it onto the
    // skip-flow path.
    {
        method: 'POST',
        pattern: '/tasks/:tid/context-update/run',
        commandType: RUN_CONTEXT_UPDATE_COMMAND,
        validate: isContextUpdatePayload,
        build: (params) => ({ taskId: params.tid }),
    },
    {
        method: 'POST',
        pattern: '/tasks/:tid/context-update/skip',
        commandType: SKIP_CONTEXT_UPDATE_COMMAND,
        validate: isContextUpdatePayload,
        build: (params) => ({ taskId: params.tid }),
    },
];

interface CompiledRestRoute extends BoardUiRestRoute {
    readonly regex: RegExp;
    readonly paramNames: readonly string[];
}

function compileRestRoute(route: BoardUiRestRoute): CompiledRestRoute {
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

const COMPILED_REST_ROUTES: ReadonlyArray<CompiledRestRoute> =
    BOARD_UI_REST_ROUTES.map(compileRestRoute);

interface MatchedRestRoute {
    readonly route: CompiledRestRoute;
    readonly params: Readonly<Record<string, string>>;
}

function matchRestRoute(method: string, pathname: string): MatchedRestRoute | null {
    for (const route of COMPILED_REST_ROUTES) {
        if (route.method !== method) continue;
        const m = route.regex.exec(pathname);
        if (!m) continue;
        const params: Record<string, string> = {};
        for (let i = 0; i < route.paramNames.length; i++) {
            try {
                params[route.paramNames[i]] = decodeURIComponent(m[i + 1]);
            } catch {
                // Malformed percent-encoding in the URL â€” fall through to 404
                return null;
            }
        }
        return { route, params };
    }
    return null;
}

const MIME_TYPES: Readonly<Record<string, string>> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
};

export interface BoardUiServerOptions {
    readonly port?: number;
    readonly host?: string;
    /**
     * Origin of the worker-api the board proxies `/events` and
     * `/commands` to. Defaults to `http://127.0.0.1:4101`. Trailing
     * slashes are stripped.
     */
    readonly workerApiUrl?: string;
    /**
     * Bearer token injected on every proxied upstream request. When
     * set, the worker-api must be configured with the same value.
     * Defaults to undefined (no Authorization header is added).
     */
    readonly workerApiToken?: string;
    /**
     * Read-side projection port (AP-IFG-010). When supplied, the board
     * server serves the v1-compatible GET endpoints declared in
     * {@link ./projections#BOARD_UI_PROJECTION_ROUTES} from this port.
     * When `undefined`, the projection routes fall through to the
     * static handler (404), which keeps the host runnable in
     * configurations that do not yet have a projection adapter wired.
     */
    readonly statePort?: StatePort;
    /**
     * Worker log file the `/api/worker/log` snapshot and
     * `/events/worker-log` SSE tail endpoints read from
     * (AP-IFG-021). Defaults to `<repo-root>/shared/.cache/worker.log`,
     * matching the path written by `adapters/logging/file-logger.ts`.
     * Tests inject a tempdir path here.
     */
    readonly workerLogPath?: string;
}

export interface BoardUiServerHandle {
    readonly port: number;
    stop(): Promise<void>;
}

export async function start(
    options: BoardUiServerOptions = {},
): Promise<BoardUiServerHandle> {
    const port = options.port ?? DEFAULT_PORT;
    const host = options.host ?? DEFAULT_HOST;
    const workerApiUrl = (options.workerApiUrl ?? DEFAULT_WORKER_API_URL).replace(/\/+$/, '');
    const workerApiToken = options.workerApiToken;
    // This server has NO auth of its own, and its /events + /commands proxy
    // INJECTS `workerApiToken` on every upstream request. So a non-loopback
    // bind hands anyone who can reach this port authenticated access to the
    // worker-api — the token makes that worse, not safer (confused deputy:
    // the browser never holds the credential, this process does). Unlike
    // worker-api/manager-api, there is no token that can make this safe,
    // which is why the warning is unconditional on a non-loopback host.
    if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
        // eslint-disable-next-line no-console
        console.warn(
            `board-ui: binding non-loopback host "${host}" — this server is UNAUTHENTICATED `
                + 'and its proxy adds the worker-api token to every forwarded request. Reach it '
                + 'over a private network (e.g. Tailscale/VPN) or put an authenticating reverse '
                + 'proxy in front; never expose this port to an untrusted network.',
        );
    }
    const workerLogPath = options.workerLogPath ?? DEFAULT_WORKER_LOG_PATH;
    const projectionsHandler = options.statePort
        ? createProjectionsHandler({ statePort: options.statePort })
        : undefined;

    const server = http.createServer((req, res) => {
        const pathname = (req.url ?? '/').split('?', 1)[0];
        const investigationRoute = INVESTIGATION_ROUTES[pathname];
        if (investigationRoute) {
            handleInvestigationCommand(
                req,
                res,
                investigationRoute,
                workerApiUrl,
                workerApiToken,
            );
            return;
        }
        if (req.method === 'GET' && pathname === WORKER_LOG_SNAPSHOT_PATH) {
            if (!requireAuth(req, res, workerApiToken)) return;
            handleWorkerLogSnapshot(req, res, workerLogPath);
            return;
        }
        if (req.method === 'GET' && pathname === WORKER_LOG_SSE_PATH) {
            if (!requireAuth(req, res, workerApiToken)) return;
            handleWorkerLogSse(req, res, workerLogPath);
            return;
        }
        // REST routes are method-aware, so they only fire for the write
        // verbs they enumerate (POST/PATCH/PUT/DELETE). Matching them
        // before the opaque proxy fallback is what keeps the AP-FP-005
        // GET proxy entries for `/api/projects` and
        // `/api/projects/:pid/plans` from swallowing the same-path POST
        // routes that translate into CommandBus envelopes.
        const restMatch = matchRestRoute(req.method ?? '', pathname);
        if (restMatch) {
            handleRestCommand(
                req,
                res,
                restMatch.route,
                restMatch.params,
                workerApiUrl,
                workerApiToken,
            );
            return;
        }
        if (matchesProxyPath(pathname)) {
            proxyToWorkerApi(req, res, workerApiUrl, workerApiToken);
            return;
        }
        // Read-side projections (AP-IFG-010). Routed only when a
        // StatePort was supplied — otherwise the GET URLs fall through
        // to the static handler, which 404s.
        if (projectionsHandler && matchProjectionRoute(req.method ?? '', pathname)) {
            void projectionsHandler(req, res);
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
                reject(new Error('board-ui: listen returned no address'));
                return;
            }
            resolve(addr.port);
        });
    });

    // eslint-disable-next-line no-console
    console.log(
        `board-ui: serving ${ASSET_DIR} on http://${host}:${bound} ` +
            `(proxying /events and /commands to ${workerApiUrl})`,
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
        },
    };
}

/**
 * Forward `/events` and `/commands` to the worker-api. Bodies and SSE
 * response chunks stream through. `host` and `connection` are stripped
 * because they're hop-by-hop; `authorization` is rewritten when an
 * upstream token is configured.
 */
function proxyToWorkerApi(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    targetBase: string,
    authToken: string | undefined,
): void {
    let target: URL;
    try {
        target = new URL(req.url ?? '/', targetBase);
    } catch {
        respondPlain(res, 502, `bad gateway: invalid target ${targetBase}`);
        return;
    }

    const headers: http.OutgoingHttpHeaders = { ...req.headers };
    delete headers.host;
    delete headers.connection;
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
        headers,
    });

    upstream.on('response', (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
    });

    upstream.on('error', (err) => {
        // eslint-disable-next-line no-console
        console.error(
            `board-ui: proxy ${req.method} ${req.url} -> ${target.href} failed: ${err.message}`,
        );
        if (!res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(
                JSON.stringify({
                    error: 'bad gateway',
                    target: target.href,
                    message: err.message,
                }),
            );
            return;
        }
        res.destroy();
    });

    // Tear the upstream down when the *response* socket closes (client
    // disconnect). Listening on `req.close` was wrong: for a body-less
    // method the request stream closes immediately after the headers,
    // and pipe-driven `end` on the upstream raced ahead of worker-api's
    // first response chunk, killing the SSE socket before any headers
    // arrived.
    res.on('close', () => {
        if (!upstream.destroyed) upstream.destroy();
    });

    if (req.method === 'GET' || req.method === 'HEAD') {
        upstream.end();
    } else {
        req.pipe(upstream);
    }
}

/**
 * Buffer a small JSON body from the incoming request, validate its
 * shape, build a `Command` object, and forward it to the worker-api's
 * `/commands` endpoint. Upstream status and body stream back unchanged
 * so the operator board sees the same 202/4xx envelope it would have
 * gotten from a direct POST to `/commands`.
 *
 * `actor` is hard-coded to `'operator'` because the proxy has no other
 * identity to attach; if a real auth layer lands later, derive it from
 * the request's authenticated principal instead.
 */
function handleInvestigationCommand(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    route: InvestigationRoute,
    targetBase: string,
    authToken: string | undefined,
): void {
    if (req.method !== 'POST') {
        respondJson(res, 405, { error: 'method not allowed' });
        return;
    }

    const chunks: Buffer[] = [];
    let total = 0;
    let aborted = false;

    req.on('data', (chunk: Buffer) => {
        if (aborted) return;
        total += chunk.length;
        if (total > MAX_BODY_BYTES) {
            aborted = true;
            respondJson(res, 413, { error: 'request body too large' });
            req.destroy();
            return;
        }
        chunks.push(chunk);
    });

    req.on('end', () => {
        if (aborted) return;
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed: unknown;
        try {
            parsed = JSON.parse(raw);
        } catch {
            respondJson(res, 400, { error: 'invalid JSON body' });
            return;
        }
        if (!route.validate(parsed)) {
            respondJson(res, 400, {
                error: 'invalid payload shape',
                commandType: route.commandType,
            });
            return;
        }
        const command = {
            type: route.commandType,
            actor: 'operator',
            issuedAt: Date.now(),
            payload: parsed,
        };
        forwardCommandToWorkerApi(command, targetBase, authToken, res);
    });

    req.on('error', (err) => {
        if (!res.headersSent) {
            respondJson(res, 400, { error: 'request error', message: err.message });
        } else {
            res.destroy();
        }
    });
}

/**
 * Handle a v1-compatible REST request matched against
 * {@link BOARD_UI_REST_ROUTES}. Buffer the optional JSON body (capped
 * at {@link MAX_BODY_BYTES}), merge it with the path params via the
 * route's `build`, validate the result, and forward a `Command`
 * envelope to the worker-api's `POST /commands` endpoint. The upstream
 * response status and body stream back unchanged.
 *
 * Bodies are only parsed for POST / PATCH / PUT â€” a DELETE request
 * skips the parse so a stray `Content-Type` header on a body-less
 * client request doesn't cause spurious 400s. `actor` is hard-coded to
 * `'operator'`, matching the investigation routes; a real auth layer
 * would derive it from the authenticated principal instead.
 */
function handleRestCommand(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    route: BoardUiRestRoute,
    params: Readonly<Record<string, string>>,
    targetBase: string,
    authToken: string | undefined,
): void {
    const method = req.method ?? '';
    const expectsBody = method === 'POST' || method === 'PATCH' || method === 'PUT';

    // eslint-disable-next-line no-console
    console.log(
        `board-ui: REST ${method} ${route.pattern} -> ${route.commandType}`,
    );

    const chunks: Buffer[] = [];
    let total = 0;
    let aborted = false;

    req.on('data', (chunk: Buffer) => {
        if (aborted) return;
        total += chunk.length;
        if (total > MAX_BODY_BYTES) {
            aborted = true;
            respondJson(res, 413, { error: 'request body too large' });
            req.destroy();
            return;
        }
        chunks.push(chunk);
    });

    req.on('end', () => {
        if (aborted) return;
        const raw = Buffer.concat(chunks).toString('utf8');
        let body: unknown = {};
        if (expectsBody && raw.length > 0) {
            try {
                body = JSON.parse(raw);
            } catch {
                // eslint-disable-next-line no-console
                console.warn(
                    `board-ui: REST ${route.commandType} validation failed: invalid JSON body`,
                );
                respondJson(res, 400, { error: 'invalid JSON body' });
                return;
            }
        }
        const payload = route.build(params, body);
        if (!route.validate(payload)) {
            // eslint-disable-next-line no-console
            console.warn(
                `board-ui: REST ${route.commandType} validation failed: invalid payload shape`,
            );
            respondJson(res, 400, {
                error: 'invalid payload shape',
                commandType: route.commandType,
            });
            return;
        }
        const command = {
            type: route.commandType,
            actor: 'operator',
            issuedAt: Date.now(),
            payload,
        };
        forwardCommandToWorkerApi(command, targetBase, authToken, res);
    });

    req.on('error', (err) => {
        if (!res.headersSent) {
            respondJson(res, 400, { error: 'request error', message: err.message });
        } else {
            res.destroy();
        }
    });
}

function forwardCommandToWorkerApi(
    command: { readonly type: string; readonly actor: string; readonly issuedAt: number; readonly payload: unknown },
    targetBase: string,
    authToken: string | undefined,
    res: http.ServerResponse,
): void {
    let target: URL;
    try {
        target = new URL('/commands', targetBase);
    } catch {
        respondJson(res, 502, { error: 'bad gateway', target: targetBase });
        return;
    }

    const bodyStr = JSON.stringify(command);
    const headers: http.OutgoingHttpHeaders = {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
    };
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
        method: 'POST',
        headers,
    });

    upstream.on('response', (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
    });

    upstream.on('error', (err) => {
        if (!res.headersSent) {
            respondJson(res, 502, {
                error: 'bad gateway',
                target: target.href,
                message: err.message,
            });
        } else {
            res.destroy();
        }
    });

    res.on('close', () => {
        if (!upstream.destroyed) upstream.destroy();
    });

    upstream.end(bodyStr);
}

function respondJson(
    res: http.ServerResponse,
    status: number,
    body: Readonly<Record<string, unknown>>,
): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
}

/**
 * Bearer-token gate shared by both worker-log endpoints. When the
 * server is configured with a `workerApiToken`, every request must
 * carry a matching `Authorization: Bearer <token>` header (constant-
 * time compare via `adapters/board-http/auth`). On failure we return
 * 401 with `WWW-Authenticate: Bearer` to advertise the scheme. When
 * the token is unset the server runs unauthenticated, matching the
 * worker-api's localhost-only-mode behaviour.
 */
function requireAuth(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    token: string | undefined,
): boolean {
    if (!token) return true;
    if (authorize(req.headers.authorization, token)) return true;
    res.writeHead(401, {
        'WWW-Authenticate': 'Bearer',
        'Content-Type': 'application/json',
    });
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return false;
}

interface WorkerLogSnapshot {
    readonly size: number;
    readonly content: string;
    readonly truncated: boolean;
}

/**
 * Read a slice of the worker log starting at `since` (byte offset).
 * When `since` is past the current end of file we treat it as
 * truncation/rotation (AC #4) and return the whole current file with
 * `truncated: true` so the client can drop its stale offset and start
 * over.
 *
 * `since=0` (or absent) returns the full current content. Missing log
 * file is treated as empty — the file is only created on first write
 * by `FileLogger`, and a freshly-deployed board should not 500 just
 * because the orchestrator hasn't logged anything yet.
 */
async function readWorkerLogSlice(
    logPath: string,
    since: number,
): Promise<WorkerLogSnapshot> {
    let size = 0;
    try {
        const stat = await fs.promises.stat(logPath);
        size = stat.size;
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            return { size: 0, content: '', truncated: false };
        }
        throw err;
    }

    const truncated = since > size;
    const start = truncated ? 0 : since;
    if (size === 0 || start >= size) {
        return { size, content: '', truncated };
    }

    const fd = await fs.promises.open(logPath, 'r');
    try {
        const length = size - start;
        const buf = Buffer.allocUnsafe(length);
        await fd.read(buf, 0, length, start);
        return { size, content: buf.toString('utf8'), truncated };
    } finally {
        await fd.close();
    }
}

/**
 * `GET /api/worker/log` — snapshot endpoint. Returns
 * `{ size, content, truncated }` JSON so a caller can use `size` as
 * the next `?since=` value and detect rotation via the `truncated`
 * flag. Lines inside `content` are the raw JSON-encoded entries
 * `FileLogger` wrote (the v1 line format), preserved exactly so
 * `worker-log-helpers.js` can parse them unchanged.
 */
function handleWorkerLogSnapshot(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    logPath: string,
): void {
    const query = new URLSearchParams((req.url ?? '').split('?')[1] ?? '');
    const sinceRaw = query.get('since');
    let since = 0;
    if (sinceRaw !== null && sinceRaw !== '') {
        const n = Number(sinceRaw);
        if (!Number.isFinite(n) || n < 0) {
            respondJson(res, 400, { error: 'invalid since' });
            return;
        }
        since = Math.floor(n);
    }
    readWorkerLogSlice(logPath, since).then(
        (snap) => respondJson(res, 200, { ...snap }),
        (err) => {
            // eslint-disable-next-line no-console
            console.error(
                `board-ui: worker-log snapshot failed for ${logPath}: ${err instanceof Error ? err.message : String(err)}`,
            );
            respondJson(res, 500, {
                error: 'failed to read worker log',
                message: err instanceof Error ? err.message : String(err),
            });
        },
    );
}

/**
 * `GET /events/worker-log` — SSE tail. Polls `logPath` every
 * {@link WORKER_LOG_POLL_MS} ms; on growth, reads the appended bytes
 * and emits each complete line as `data: <line>\n\n` (matching v1's
 * SSE framing so the helper can be ported drop-in). Partial trailing
 * lines (no terminating newline yet) are buffered for the next tick.
 *
 * Rotation (AC #4): when the file shrinks below the tracked offset
 * we emit `event: rotated` with the new size and reset the offset to
 * the new EOF — the SSE stream resumes at the start of the rolled
 * file so the next line written there is delivered as a fresh
 * `data:` frame. A periodic comment heartbeat keeps proxies from
 * closing idle connections.
 */
function handleWorkerLogSse(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    logPath: string,
): void {
    const query = new URLSearchParams((req.url ?? '').split('?')[1] ?? '');
    const sinceRaw = query.get('since');
    let offset = 0;
    if (sinceRaw !== null && sinceRaw !== '') {
        const n = Number(sinceRaw);
        if (Number.isFinite(n) && n >= 0) {
            offset = Math.floor(n);
        }
    }

    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
    });
    if (typeof res.flushHeaders === 'function') {
        res.flushHeaders();
    }

    let closed = false;
    let pending = false;
    let buffer = '';

    const emitLines = (chunk: string): void => {
        buffer += chunk;
        let nl = buffer.indexOf('\n');
        while (nl !== -1) {
            const line = buffer.slice(0, nl);
            buffer = buffer.slice(nl + 1);
            // Strip a trailing CR so Windows-style \r\n logs render
            // cleanly under EventSource (which itself uses \n framing).
            const clean = line.endsWith('\r') ? line.slice(0, -1) : line;
            res.write(`data: ${clean}\n\n`);
            nl = buffer.indexOf('\n');
        }
    };

    const poll = async (): Promise<void> => {
        if (closed || pending) return;
        pending = true;
        try {
            let size = 0;
            try {
                const stat = await fs.promises.stat(logPath);
                size = stat.size;
            } catch (err) {
                if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
                // Missing file: nothing to read yet. Reset state and
                // wait for the file to appear on a subsequent tick.
                offset = 0;
                buffer = '';
                return;
            }
            if (size < offset) {
                buffer = '';
                offset = 0;
                if (!closed) {
                    res.write('event: rotated\n');
                    res.write(`data: ${JSON.stringify({ size })}\n\n`);
                }
            }
            if (size > offset) {
                const fd = await fs.promises.open(logPath, 'r');
                try {
                    const length = size - offset;
                    const buf = Buffer.allocUnsafe(length);
                    await fd.read(buf, 0, length, offset);
                    offset = size;
                    if (!closed) emitLines(buf.toString('utf8'));
                } finally {
                    await fd.close();
                }
            }
        } catch (err) {
            // eslint-disable-next-line no-console
            console.warn(
                `board-ui: worker-log SSE poll error for ${logPath}: ${err instanceof Error ? err.message : String(err)}`,
            );
        } finally {
            pending = false;
        }
    };

    const pollInterval = setInterval(() => void poll(), WORKER_LOG_POLL_MS);
    const heartbeat = setInterval(() => {
        if (!closed) res.write(': hb\n\n');
    }, WORKER_LOG_HEARTBEAT_MS);

    // Kick off an immediate poll so first-paint doesn't wait a full
    // tick for already-present content.
    void poll();

    const teardown = (): void => {
        if (closed) return;
        closed = true;
        clearInterval(pollInterval);
        clearInterval(heartbeat);
    };
    req.on('close', teardown);
    req.on('aborted', teardown);
    res.on('close', teardown);
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
    // Belt-and-braces: the allow-list above already rules out traversal,
    // but a defence-in-depth check guards against future loosening.
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
            'Cache-Control': 'no-cache',
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
    const portRaw = process.env.BOARD_UI_PORT;
    const port = portRaw ? Number(portRaw) : DEFAULT_PORT;
    if (!Number.isFinite(port) || port < 0 || port > 65535) {
        // eslint-disable-next-line no-console
        console.error(`board-ui: invalid BOARD_UI_PORT="${portRaw}"`);
        process.exit(1);
    }
    const host = process.env.BOARD_UI_HOST ?? DEFAULT_HOST;
    // A non-loopback bind has to be deliberate. start() warns, but this
    // runs as a Windows service where nobody reads stdout — see
    // hosts/bind-guard.ts.
    const bind = decideRemoteBind({
        service: 'board-ui',
        host,
        allowFlagName: 'BOARD_UI_ALLOW_REMOTE',
        allowFlagValue: process.env.BOARD_UI_ALLOW_REMOTE,
        exposes:
            'its proxy adds your worker-api token to every forwarded request,'
            + ' which grants full control of the pipeline.',
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
    const workerApiUrl = process.env.WORKER_API_URL ?? DEFAULT_WORKER_API_URL;
    const workerApiToken = process.env.WORKER_API_TOKEN_V2;

    const handle = await start({ port, host, workerApiUrl, workerApiToken });

    const shutdown = (signal: NodeJS.Signals): void => {
        // eslint-disable-next-line no-console
        console.log(`board-ui: received ${signal}, shutting down`);
        handle
            .stop()
            .then(() => process.exit(0))
            .catch((err) => {
                // eslint-disable-next-line no-console
                console.error('board-ui: error during shutdown', err);
                process.exit(1);
            });
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

if (require.main === module) {
    main().catch((err) => {
        // eslint-disable-next-line no-console
        console.error('board-ui: fatal startup error', err);
        process.exit(1);
    });
}
