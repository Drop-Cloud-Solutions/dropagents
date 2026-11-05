import * as http from 'node:http';

import { authorize } from '../../../adapters/board-http/auth';
import type { Command } from '../../../core/commands/command';
import { PlanLifecycleCommands } from '../../../core/commands/index';
import type { StoredEvent } from '../../../core/events/event';
import type { Logger } from '../../../core/ports/Logger';

/**
 * Plan-review route module.
 *
 * Three endpoints behind one regex:
 *
 *   GET  /api/projects/:pid/plans/:planId/plan-review
 *        Read the current draft (markdown + generatedAt) from the
 *        projection store, or 404 when no review has been projected yet.
 *
 *   POST /api/projects/:pid/plans/:planId/plan-review/approve
 *        Body `{ conventions? }`. Reads the latest revision out of the
 *        plan-review-store and dispatches a `DecomposePlan` command
 *        carrying the approved content + conventions. Returns 202.
 *
 *   POST /api/projects/:pid/plans/:planId/plan-review/regenerate
 *        Body `{ feedback? }`. Reads the latest revision, dispatches a
 *        `GeneratePlan` command with `revision = latest.revision + 1`,
 *        the operator feedback and the previous content for context.
 *        Returns 202.
 *
 * The POST endpoints honour the worker-api Bearer-token auth pattern:
 * when {@link PlanReviewRoutesDeps.authToken} is set, requests without a
 * matching `Authorization: Bearer <token>` header are rejected with 401
 * and a `WWW-Authenticate: Bearer` header. When `authToken` is unset the
 * endpoints are wide open — matching the rest of worker-api, which falls
 * back to localhost-only deployments without a shared secret.
 */

export const APPROVE_PLAN_ACTION = 'approve';
export const REGENERATE_PLAN_ACTION = 'regenerate';

export interface PlanReviewDraft {
    readonly markdown: string;
    readonly generatedAt: number;
}

/**
 * Per-plan revision row. Matches the shape produced by
 * `adapters/projections/plan-review-store.ts#PlanReviewRevision` — declared
 * locally so the route owns its own port contract rather than reaching
 * back into the projection module.
 */
export interface PlanReviewRevision {
    readonly revision: number;
    readonly content: string;
    readonly feedback?: string;
    readonly generatedAt: number;
}

/**
 * Single entry returned by {@link PlanReviewStore.listPending}.
 * Mirrors the projection's `PendingPlanReview` shape so the route can
 * forward the list straight to the wire without further mapping.
 */
export interface PendingPlanReviewEntry {
    readonly planId: string;
    readonly projectId: string;
    readonly revision: number;
    readonly content: string;
    readonly generatedAt: number;
}

/**
 * Read-side port over the plan-review projection. `get` powers the GET
 * draft endpoint; `getLatestRevision` powers /approve and /regenerate.
 * `listPending` powers the boot-time hydration the board does to
 * re-paint active-planner cards across a page reload — without it the
 * cards vanish until the next live event.
 *
 * Methods may be sync or async — production wires a SQLite-backed
 * adapter, tests pass in-memory fakes.
 */
export interface PlanReviewStore {
    get(
        projectId: string,
        planId: string,
    ): Promise<PlanReviewDraft | null> | PlanReviewDraft | null;
    getLatestRevision(
        projectId: string,
        planId: string,
    ): Promise<PlanReviewRevision | null> | PlanReviewRevision | null;
    /**
     * Highest revision whose content is non-empty. Optional so test
     * fakes and older wirings keep compiling; when absent, regenerate
     * falls back to the latest revision even if its content is empty.
     */
    getLatestNonEmptyRevision?(
        projectId: string,
        planId: string,
    ): Promise<PlanReviewRevision | null> | PlanReviewRevision | null;
    listPending(): Promise<readonly PendingPlanReviewEntry[]>
        | readonly PendingPlanReviewEntry[];
}

/**
 * Minimal command-bus surface the route needs. Matches the structural
 * subset already used by `adapters/board-http/server.ts#CommandSink`.
 */
export interface PlanReviewCommandSink {
    send(command: Command): Promise<readonly StoredEvent[]>;
}

export interface ApprovePlanBody {
    /** Optional opaque conventions blob passed straight through to the
     *  decomposer. Shape is project-defined; the route does not validate. */
    readonly conventions?: unknown;
}

export interface RegeneratePlanBody {
    /** Optional operator feedback that motivated the regeneration. */
    readonly feedback?: string;
}

export interface DecomposePlanDispatchPayload {
    readonly projectId: string;
    readonly planId: string;
    readonly approvedContent: string;
    readonly conventions?: unknown;
}

export interface GeneratePlanDispatchPayload {
    readonly projectId: string;
    readonly planId: string;
    readonly previousContent: string;
    readonly revision: number;
    readonly feedback?: string;
}

export interface PlanReviewRoutesDeps {
    readonly store: PlanReviewStore;
    readonly bus: PlanReviewCommandSink;
    /** Clock used for `Command.issuedAt`. Defaults to `Date.now`. */
    readonly clock?: () => number;
    readonly logger?: Logger;
    /** Fallback actor when the request body omits one. */
    readonly defaultActor?: string;
    /**
     * Bearer token enforced on POST endpoints. When undefined the HTTP
     * wrapper skips auth — matching the worker-api wide-open fallback
     * for localhost-only setups without a shared secret.
     */
    readonly authToken?: string;
}

const DEFAULT_ACTOR = 'operator';

/**
 * Path pattern. Captures `[, projectId, planId, action?]` where `action`
 * is `'approve'` | `'regenerate'` | `undefined`. A single regex covers
 * all three endpoints; the wrapper branches on method + action.
 */
export const PLAN_REVIEW_ROUTE_PATTERN =
    /^\/api\/projects\/([^/]+)\/plans\/([^/]+)\/plan-review(?:\/(approve|regenerate))?$/;

/**
 * Pending-list endpoint. Sits outside the per-plan pattern above so a
 * single literal-string match is enough to dispatch. The board hits
 * this once on boot — no path params, no body.
 */
export const PLAN_REVIEW_LIST_PATH = '/api/plan-reviews';

// ---------------------------------------------------------------------------
// Pure handler results
// ---------------------------------------------------------------------------

export type PlanReviewHandlerResult<TBody> = {
    readonly status: number;
    readonly body: TBody;
};

export interface PlanReviewNotFoundBody {
    readonly error: 'plan-review not found';
    readonly projectId: string;
    readonly planId: string;
}

export interface PlanNotFoundBody {
    readonly error: 'plan not found';
    readonly projectId: string;
    readonly planId: string;
}

export interface AcceptedBody {
    readonly accepted: true;
    readonly commandType: string;
    readonly revision: number;
    readonly events: readonly StoredEvent[];
}

// ---------------------------------------------------------------------------
// Pure handlers
// ---------------------------------------------------------------------------

/** GET — read the current plan-review draft. */
export async function getPlanReview(
    deps: PlanReviewRoutesDeps,
    projectId: string,
    planId: string,
): Promise<PlanReviewHandlerResult<PlanReviewDraft | PlanReviewNotFoundBody>> {
    const draft = await deps.store.get(projectId, planId);
    if (!draft) {
        deps.logger?.info('plan-review: GET miss', { projectId, planId });
        return {
            status: 404,
            body: {
                error: 'plan-review not found',
                projectId,
                planId,
            },
        };
    }
    deps.logger?.info('plan-review: GET hit', {
        projectId,
        planId,
        generatedAt: draft.generatedAt,
    });
    return { status: 200, body: draft };
}

/**
 * POST /approve — dispatch `DecomposePlan` with the latest revision's
 * content. Returns 404 when no revision has ever been projected for the
 * plan so an early click cannot trigger a decompose against an empty
 * content blob.
 */
export async function approvePlan(
    deps: PlanReviewRoutesDeps,
    projectId: string,
    planId: string,
    body: ApprovePlanBody,
    actor: string = deps.defaultActor ?? DEFAULT_ACTOR,
): Promise<PlanReviewHandlerResult<AcceptedBody | PlanNotFoundBody>> {
    const latest = await deps.store.getLatestRevision(projectId, planId);
    if (latest === null) {
        deps.logger?.warn('plan-review: approve hit unknown plan', {
            projectId,
            planId,
        });
        return {
            status: 404,
            body: { error: 'plan not found', projectId, planId },
        };
    }
    const clock = deps.clock ?? ((): number => Date.now());
    // DecomposePlan's payload validator (`isDecomposePlanPayload`)
    // requires `conventions` to be present — an empty object satisfies
    // the contract. Without this default the bus would reject every
    // approve call whose request body omitted conventions (which is
    // the common case for the Ready-plan Decompose button and the
    // modal's no-conventions approve path).
    const payload: DecomposePlanDispatchPayload = {
        projectId,
        planId,
        approvedContent: latest.content,
        conventions: body.conventions ?? {},
    };
    const command: Command<DecomposePlanDispatchPayload> = {
        type: PlanLifecycleCommands.DECOMPOSE_PLAN,
        actor,
        issuedAt: clock(),
        payload,
    };
    deps.logger?.info('plan-review: approve dispatched', {
        projectId,
        planId,
        revision: latest.revision,
        actor,
    });
    const events = await deps.bus.send(command);
    return {
        status: 202,
        body: {
            accepted: true,
            commandType: PlanLifecycleCommands.DECOMPOSE_PLAN,
            revision: latest.revision,
            events,
        },
    };
}

/**
 * POST /regenerate — dispatch `GeneratePlan` with the next revision
 * number and the operator's feedback. Returns 404 when no prior revision
 * exists; the operator must let the initial generation finish before
 * asking for a re-roll.
 */
export async function regeneratePlan(
    deps: PlanReviewRoutesDeps,
    projectId: string,
    planId: string,
    body: RegeneratePlanBody,
    actor: string = deps.defaultActor ?? DEFAULT_ACTOR,
): Promise<PlanReviewHandlerResult<AcceptedBody | PlanNotFoundBody>> {
    const latest = await deps.store.getLatestRevision(projectId, planId);
    if (latest === null) {
        deps.logger?.warn('plan-review: regenerate hit unknown plan', {
            projectId,
            planId,
        });
        return {
            status: 404,
            body: { error: 'plan not found', projectId, planId },
        };
    }
    const clock = deps.clock ?? ((): number => Date.now());
    const nextRevision = latest.revision + 1;
    // A revision row is minted (empty) at dispatch time and only filled
    // when the planner finishes — so after a failed run the LATEST
    // revision has no content. Walk back to the newest revision that
    // actually holds a plan; the revision counter still advances from
    // the true latest so numbering stays monotonic.
    let previousContent = latest.content;
    if (previousContent.length === 0 && deps.store.getLatestNonEmptyRevision) {
        const nonEmpty = await deps.store.getLatestNonEmptyRevision(projectId, planId);
        if (nonEmpty !== null) {
            previousContent = nonEmpty.content;
            deps.logger?.info('plan-review: regenerate fell back to last non-empty revision', {
                projectId,
                planId,
                latestRevision: latest.revision,
                contentRevision: nonEmpty.revision,
            });
        }
    }
    const payload: GeneratePlanDispatchPayload =
        body.feedback !== undefined
            ? {
                  projectId,
                  planId,
                  previousContent,
                  revision: nextRevision,
                  feedback: body.feedback,
              }
            : {
                  projectId,
                  planId,
                  previousContent,
                  revision: nextRevision,
              };
    const command: Command<GeneratePlanDispatchPayload> = {
        type: PlanLifecycleCommands.GENERATE_PLAN,
        actor,
        issuedAt: clock(),
        payload,
    };
    deps.logger?.info('plan-review: regenerate dispatched', {
        projectId,
        planId,
        revision: nextRevision,
        actor,
    });
    const events = await deps.bus.send(command);
    return {
        status: 202,
        body: {
            accepted: true,
            commandType: PlanLifecycleCommands.GENERATE_PLAN,
            revision: nextRevision,
            events,
        },
    };
}

// ---------------------------------------------------------------------------
// HTTP wrapper
// ---------------------------------------------------------------------------

export interface PlanReviewRouter {
    /**
     * Attempt to handle the request. Returns `true` when the URL matched
     * one of the plan-review routes (a response was sent), `false`
     * otherwise so a parent server can chain other routers.
     */
    handle(req: http.IncomingMessage, res: http.ServerResponse): boolean;
}

const MAX_BODY_BYTES = 64 * 1024;

export function createPlanReviewRouter(deps: PlanReviewRoutesDeps): PlanReviewRouter {
    return {
        handle(req, res): boolean {
            const url = req.url ?? '/';
            const pathname = url.split('?', 1)[0];

            if (pathname === PLAN_REVIEW_LIST_PATH) {
                const method = req.method ?? 'GET';
                if (method !== 'GET') {
                    respond(res, 405, { error: 'method not allowed' }, { Allow: 'GET' });
                    return true;
                }
                handleListPendingRequest(deps, res);
                return true;
            }

            const match = PLAN_REVIEW_ROUTE_PATTERN.exec(pathname);
            if (!match) return false;

            const [, projectId, planId, action] = match;
            const method = req.method ?? 'GET';

            if (action === undefined && method === 'GET') {
                handleGetRequest(deps, res, projectId, planId);
                return true;
            }
            if (action === APPROVE_PLAN_ACTION && method === 'POST') {
                if (!checkAuth(deps, req, res)) return true;
                handleApproveRequest(deps, req, res, projectId, planId);
                return true;
            }
            if (action === REGENERATE_PLAN_ACTION && method === 'POST') {
                if (!checkAuth(deps, req, res)) return true;
                handleRegenerateRequest(deps, req, res, projectId, planId);
                return true;
            }

            // Path matched but method did not — surface 405 so a typo
            // (`PUT`, `DELETE`) is not silently swallowed as 404.
            const allow = action === undefined ? 'GET' : 'POST';
            respond(res, 405, { error: 'method not allowed' }, { Allow: allow });
            return true;
        },
    };
}

/**
 * Enforce Bearer auth on POST endpoints. Returns `true` when the request
 * is allowed to proceed, `false` when a 401 response has already been
 * written. When `deps.authToken` is undefined the check is a no-op.
 */
function checkAuth(
    deps: PlanReviewRoutesDeps,
    req: http.IncomingMessage,
    res: http.ServerResponse,
): boolean {
    if (deps.authToken === undefined) return true;
    if (authorize(req.headers.authorization, deps.authToken)) return true;
    res.writeHead(401, {
        'WWW-Authenticate': 'Bearer',
        'Content-Type': 'application/json',
    });
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return false;
}

function handleGetRequest(
    deps: PlanReviewRoutesDeps,
    res: http.ServerResponse,
    projectId: string,
    planId: string,
): void {
    getPlanReview(deps, projectId, planId)
        .then((result) => respond(res, result.status, result.body))
        .catch((err) => {
            deps.logger?.error('plan-review: GET handler threw', {
                projectId,
                planId,
                error: err instanceof Error ? err.message : String(err),
            });
            respond(res, 500, { error: 'plan-review read failed' });
        });
}

function handleListPendingRequest(
    deps: PlanReviewRoutesDeps,
    res: http.ServerResponse,
): void {
    Promise.resolve(deps.store.listPending())
        .then((entries) => {
            respond(res, 200, { entries });
        })
        .catch((err) => {
            deps.logger?.error('plan-review: list handler threw', {
                error: err instanceof Error ? err.message : String(err),
            });
            respond(res, 500, { error: 'plan-review list failed' });
        });
}

function handleApproveRequest(
    deps: PlanReviewRoutesDeps,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    projectId: string,
    planId: string,
): void {
    readJsonBody(req)
        .then(async (raw) => {
            const body = parseApproveBody(raw);
            const actor = extractActor(raw) ?? deps.defaultActor ?? DEFAULT_ACTOR;
            const result = await approvePlan(deps, projectId, planId, body, actor);
            respond(res, result.status, result.body);
        })
        .catch((err) => {
            handlePostError(deps, res, projectId, planId, 'approve', err);
        });
}

function handleRegenerateRequest(
    deps: PlanReviewRoutesDeps,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    projectId: string,
    planId: string,
): void {
    readJsonBody(req)
        .then(async (raw) => {
            const body = parseRegenerateBody(raw);
            const actor = extractActor(raw) ?? deps.defaultActor ?? DEFAULT_ACTOR;
            const result = await regeneratePlan(deps, projectId, planId, body, actor);
            respond(res, result.status, result.body);
        })
        .catch((err) => {
            handlePostError(deps, res, projectId, planId, 'regenerate', err);
        });
}

function handlePostError(
    deps: PlanReviewRoutesDeps,
    res: http.ServerResponse,
    projectId: string,
    planId: string,
    action: 'approve' | 'regenerate',
    err: unknown,
): void {
    if (err instanceof BodyTooLargeError) {
        respond(res, 413, { error: 'request body too large' });
        return;
    }
    if (err instanceof InvalidJsonError) {
        respond(res, 400, { error: 'invalid JSON body' });
        return;
    }
    deps.logger?.error(`plan-review: ${action} dispatch failed`, {
        projectId,
        planId,
        error: err instanceof Error ? err.message : String(err),
    });
    respond(res, 500, {
        error: `plan-review ${action} failed`,
        message: err instanceof Error ? err.message : String(err),
    });
}

function parseApproveBody(raw: unknown): ApprovePlanBody {
    if (!raw || typeof raw !== 'object') return {};
    const v = raw as Record<string, unknown>;
    if (!('conventions' in v)) return {};
    return { conventions: v.conventions };
}

function parseRegenerateBody(raw: unknown): RegeneratePlanBody {
    if (!raw || typeof raw !== 'object') return {};
    const v = raw as Record<string, unknown>;
    if (typeof v.feedback === 'string') return { feedback: v.feedback };
    return {};
}

function extractActor(body: unknown): string | undefined {
    if (!body || typeof body !== 'object') return undefined;
    const actor = (body as Record<string, unknown>).actor;
    return typeof actor === 'string' && actor.length > 0 ? actor : undefined;
}

class InvalidJsonError extends Error {}
class BodyTooLargeError extends Error {}

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let total = 0;
        let aborted = false;

        req.on('data', (chunk: Buffer) => {
            if (aborted) return;
            total += chunk.length;
            if (total > MAX_BODY_BYTES) {
                aborted = true;
                req.destroy();
                reject(new BodyTooLargeError());
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            if (aborted) return;
            const raw = Buffer.concat(chunks).toString('utf8');
            if (raw.length === 0) {
                resolve({});
                return;
            }
            try {
                resolve(JSON.parse(raw));
            } catch {
                reject(new InvalidJsonError());
            }
        });
        req.on('error', reject);
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
