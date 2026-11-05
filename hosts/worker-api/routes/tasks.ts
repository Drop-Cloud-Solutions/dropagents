/**
 * AP-VP5-008 — worker-api task action routes (Phase 5).
 *
 * Three POST endpoints translate operator clicks on a parked task into a
 * single CommandBus dispatch — thin command-dispatchers that validate the
 * body, build the command, push to the bus, and return 202.
 *
 *   POST /tasks/:id/clarify
 *        Body `{ answer: string, remember?: boolean, optionKey?: string,
 *                actor? }`. Dispatches
 *        `ResumeTask{ taskId, decision: 'approve', answer, remember,
 *                     optionKey }`. The `decision: 'approve'` is hard-wired
 *        — clarify is the "operator answered the agent's question, resume"
 *        path; rejection of a clarification flows through the separate
 *        /reject endpoint below.
 *
 *   POST /tasks/:id/reject
 *        Body `{ feedback: string, actor? }`. Dispatches
 *        `ResumeTask{ taskId, decision: 'reject', feedback }`. The engine
 *        routes the rejection through the parked step's `on_failure` (see
 *        AP-VP5-003).
 *
 *   POST /tasks/:id/investigation-followup
 *        Body `{ question: string, actor? }`. Dispatches
 *        `AskInvestigationFollowup{ taskId, question }`. A downstream
 *        subscriber translates this into the existing follow-up flow.
 *
 * Auth: when mounted behind the {@link BoardHttpServer} the parent
 * enforces `WORKER_API_TOKEN_V2` Bearer auth on every non-/health request
 * before this router is given the chance to claim the URL. The router
 * therefore does not duplicate that gate; the unit tests cover the auth
 * boundary end-to-end by mounting this module behind a real
 * BoardHttpServer.
 *
 * Architectural note: the router exposes
 * `createTasksRouter(...) -> { handle }` — the same headless shape as
 * `plan-review.ts` and `notes.ts` — so the host folds it into the wider
 * server via `extraRouters`, and the tests can also drive it through a
 * hand-rolled `http.createServer` without the rest of the worker-api
 * scaffolding.
 */
import * as http from 'node:http';

import type { Command } from '../../../core/commands/command';
import type { StoredEvent } from '../../../core/events/event';
import type { InvestigationThreadEntry } from '../../../core/flow/engine';
import type { Logger } from '../../../core/ports/Logger';
import {
    NoteOpsCommands,
    TaskParkingCommands,
    type AskInvestigationFollowupPayload,
    type ResumeTaskPayload,
} from '../../../core/commands/index';

export const CLARIFY_ACTION = 'clarify';
export const REJECT_ACTION = 'reject';
export const INVESTIGATION_FOLLOWUP_ACTION = 'investigation-followup';
export const INVESTIGATION_THREAD_ACTION = 'investigation-thread';

const DEFAULT_ACTOR = 'operator';
const MAX_BODY_BYTES = 64 * 1024;

/**
 * Minimal command-sink surface — matches the structural subset used by
 * `adapters/board-http/server.ts#CommandSink` so the production CommandBus
 * and a hand-rolled fake both satisfy it without an import cycle.
 */
export interface TasksCommandSink {
    send(command: Command): Promise<readonly StoredEvent[]>;
}

/**
 * Read-side port for `GET /tasks/:id/investigation-thread` (AP-VP5-011).
 *
 * Returns the task's `investigation_thread` array. Resolving to `null`
 * signals "no lineage record for this task id" → the route returns 404.
 * An empty array (`[]`) means "task exists, no follow-ups yet" → the
 * route returns 200 with an empty thread; the board UI renders the
 * "no follow-ups yet" placeholder. Splitting those two cases keeps the
 * board UI free from "treat a 404 as empty" guesswork.
 *
 * Production wires this to the orchestrator's `TaskLineageStore`; tests
 * pass a recording fake.
 */
export interface TaskThreadReader {
    readThread(
        taskId: string,
    ): Promise<ReadonlyArray<InvestigationThreadEntry> | null>
        | ReadonlyArray<InvestigationThreadEntry>
        | null;
}

export interface TasksRoutesDeps {
    readonly bus: TasksCommandSink;
    /** Clock used for `Command.issuedAt`. Defaults to `Date.now`. */
    readonly clock?: () => number;
    readonly logger?: Logger;
    /** Fallback actor when the request body omits one. */
    readonly defaultActor?: string;
    /**
     * Optional read-side port for `GET /tasks/:id/investigation-thread`.
     * When omitted the GET route returns 501 so the board UI can degrade
     * to a "thread reader not configured" toast rather than a confusing
     * 404 — every legitimate task is a valid (empty-thread) match here,
     * so 404 would be misleading.
     */
    readonly threadReader?: TaskThreadReader;
}

export interface TasksRouter {
    /**
     * Attempt to handle the request. Returns `true` when the URL matched
     * one of the task action routes (a response was sent), `false`
     * otherwise so a parent server can fall through to its own routes.
     */
    handle(req: http.IncomingMessage, res: http.ServerResponse): boolean;
}

/**
 * Matches `/tasks/:id/(clarify|reject|investigation-followup)` with an
 * optional trailing slash. The action symbol is anchored to the closed
 * set so an unknown verb (e.g. `/tasks/t/foo`) is a 404, not a 405.
 */
export const TASKS_ROUTE_PATTERN =
    /^\/tasks\/([^/]+)\/(clarify|reject|investigation-followup)\/?$/;

/**
 * Matches the AP-VP5-011 read route `GET /tasks/:id/investigation-thread`.
 * Kept as a separate regex (rather than folded into the POST-only
 * {@link TASKS_ROUTE_PATTERN}) so the closed-set behaviour of the
 * existing pattern — "unknown POST verb → 404, never 405" — is preserved
 * verbatim. The router below dispatches on `method` first, so a POST to
 * this path falls through to a 405.
 */
export const TASKS_THREAD_ROUTE_PATTERN =
    /^\/tasks\/([^/]+)\/(investigation-thread)\/?$/;

export interface AcceptedBody {
    readonly accepted: true;
    readonly commandType: string;
    readonly taskId: string;
    readonly events: readonly StoredEvent[];
}

export interface RouteResult {
    readonly status: number;
    readonly body: Readonly<Record<string, unknown>>;
}

interface ClarifyBody {
    readonly answer: string;
    readonly remember?: boolean;
    readonly optionKey?: string;
}

interface RejectBody {
    readonly feedback: string;
}

interface FollowupBody {
    readonly question: string;
}

// ---------------------------------------------------------------------------
// Pure dispatchers (no HTTP)
// ---------------------------------------------------------------------------

export async function dispatchClarify(
    deps: TasksRoutesDeps,
    taskId: string,
    body: ClarifyBody,
    actor: string,
): Promise<RouteResult> {
    const payload: ResumeTaskPayload = {
        taskId,
        decision: 'approve',
        answer: body.answer,
        ...(body.remember !== undefined ? { remember: body.remember } : {}),
        ...(body.optionKey !== undefined ? { optionKey: body.optionKey } : {}),
    };
    const command: Command<ResumeTaskPayload> = {
        type: TaskParkingCommands.RESUME_TASK,
        actor,
        issuedAt: (deps.clock ?? Date.now)(),
        payload,
    };
    deps.logger?.info('tasks: clarify dispatched', { taskId, actor });
    const events = await deps.bus.send(command);
    return accepted(TaskParkingCommands.RESUME_TASK, taskId, events);
}

export async function dispatchReject(
    deps: TasksRoutesDeps,
    taskId: string,
    body: RejectBody,
    actor: string,
): Promise<RouteResult> {
    const payload: ResumeTaskPayload = {
        taskId,
        decision: 'reject',
        feedback: body.feedback,
    };
    const command: Command<ResumeTaskPayload> = {
        type: TaskParkingCommands.RESUME_TASK,
        actor,
        issuedAt: (deps.clock ?? Date.now)(),
        payload,
    };
    deps.logger?.info('tasks: reject dispatched', { taskId, actor });
    const events = await deps.bus.send(command);
    return accepted(TaskParkingCommands.RESUME_TASK, taskId, events);
}

export async function dispatchInvestigationFollowup(
    deps: TasksRoutesDeps,
    taskId: string,
    body: FollowupBody,
    actor: string,
): Promise<RouteResult> {
    const payload: AskInvestigationFollowupPayload = {
        taskId,
        question: body.question,
    };
    const command: Command<AskInvestigationFollowupPayload> = {
        type: NoteOpsCommands.ASK_INVESTIGATION_FOLLOWUP,
        actor,
        issuedAt: (deps.clock ?? Date.now)(),
        payload,
    };
    deps.logger?.info('tasks: investigation-followup dispatched', {
        taskId,
        actor,
    });
    const events = await deps.bus.send(command);
    return accepted(NoteOpsCommands.ASK_INVESTIGATION_FOLLOWUP, taskId, events);
}

function accepted(
    commandType: string,
    taskId: string,
    events: readonly StoredEvent[],
): RouteResult {
    const body: AcceptedBody = { accepted: true, commandType, taskId, events };
    return {
        status: 202,
        body: body as unknown as Readonly<Record<string, unknown>>,
    };
}

// ---------------------------------------------------------------------------
// HTTP wrapper
// ---------------------------------------------------------------------------

export function createTasksRouter(deps: TasksRoutesDeps): TasksRouter {
    return {
        handle(req, res): boolean {
            const url = req.url ?? '/';
            const pathname = url.split('?', 1)[0];
            const method = req.method ?? 'GET';

            const threadMatch = TASKS_THREAD_ROUTE_PATTERN.exec(pathname);
            if (threadMatch) {
                let taskId: string;
                try {
                    taskId = decodeURIComponent(threadMatch[1]);
                } catch {
                    respond(res, 404, { error: 'not found' });
                    return true;
                }
                if (method !== 'GET') {
                    respond(
                        res,
                        405,
                        { error: 'method not allowed' },
                        { Allow: 'GET' },
                    );
                    return true;
                }
                handleReadThread(deps, res, taskId);
                return true;
            }

            const match = TASKS_ROUTE_PATTERN.exec(pathname);
            if (!match) return false;

            const [, rawTaskId, action] = match;
            let taskId: string;
            try {
                taskId = decodeURIComponent(rawTaskId);
            } catch {
                respond(res, 404, { error: 'not found' });
                return true;
            }

            if (method !== 'POST') {
                respond(
                    res,
                    405,
                    { error: 'method not allowed' },
                    { Allow: 'POST' },
                );
                return true;
            }

            if (action === CLARIFY_ACTION) {
                handleClarify(deps, req, res, taskId);
                return true;
            }
            if (action === REJECT_ACTION) {
                handleReject(deps, req, res, taskId);
                return true;
            }
            if (action === INVESTIGATION_FOLLOWUP_ACTION) {
                handleFollowup(deps, req, res, taskId);
                return true;
            }

            // Unreachable given the closed-set action regex above — defensive 404.
            respond(res, 404, { error: 'not found' });
            return true;
        },
    };
}

function handleReadThread(
    deps: TasksRoutesDeps,
    res: http.ServerResponse,
    taskId: string,
): void {
    if (!deps.threadReader) {
        respond(res, 501, {
            error: 'investigation-thread reader not configured',
        });
        return;
    }
    Promise.resolve()
        .then(() => deps.threadReader!.readThread(taskId))
        .then((thread) => {
            if (thread === null) {
                respond(res, 404, { error: 'not found' });
                return;
            }
            respond(res, 200, { taskId, thread });
        })
        .catch((err) => {
            deps.logger?.error('tasks: investigation-thread read failed', {
                taskId,
                error: err instanceof Error ? err.message : String(err),
            });
            respond(res, 500, {
                error: 'tasks investigation-thread failed',
                message: err instanceof Error ? err.message : String(err),
            });
        });
}

function handleClarify(
    deps: TasksRoutesDeps,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    taskId: string,
): void {
    readJsonBody(req)
        .then(async (raw) => {
            const body = parseClarifyBody(raw);
            const actor = extractActor(raw, deps.defaultActor ?? DEFAULT_ACTOR);
            const r = await dispatchClarify(deps, taskId, body, actor);
            respond(res, r.status, r.body);
        })
        .catch((err) => fail(deps, res, 'clarify', taskId, err));
}

function handleReject(
    deps: TasksRoutesDeps,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    taskId: string,
): void {
    readJsonBody(req)
        .then(async (raw) => {
            const body = parseRejectBody(raw);
            const actor = extractActor(raw, deps.defaultActor ?? DEFAULT_ACTOR);
            const r = await dispatchReject(deps, taskId, body, actor);
            respond(res, r.status, r.body);
        })
        .catch((err) => fail(deps, res, 'reject', taskId, err));
}

function handleFollowup(
    deps: TasksRoutesDeps,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    taskId: string,
): void {
    readJsonBody(req)
        .then(async (raw) => {
            const body = parseFollowupBody(raw);
            const actor = extractActor(raw, deps.defaultActor ?? DEFAULT_ACTOR);
            const r = await dispatchInvestigationFollowup(
                deps,
                taskId,
                body,
                actor,
            );
            respond(res, r.status, r.body);
        })
        .catch((err) =>
            fail(deps, res, 'investigation-followup', taskId, err),
        );
}

function fail(
    deps: TasksRoutesDeps,
    res: http.ServerResponse,
    action: string,
    taskId: string,
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
    if (err instanceof InvalidBodyError) {
        respond(res, 400, { error: err.message });
        return;
    }
    deps.logger?.error(`tasks: ${action} failed`, {
        taskId,
        error: err instanceof Error ? err.message : String(err),
    });
    respond(res, 500, {
        error: `tasks ${action} failed`,
        message: err instanceof Error ? err.message : String(err),
    });
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function parseClarifyBody(raw: unknown): ClarifyBody {
    if (
        !isObject(raw) ||
        typeof raw.answer !== 'string' ||
        raw.answer.length === 0
    ) {
        throw new InvalidBodyError('answer (non-empty string) is required');
    }
    const body: { answer: string; remember?: boolean; optionKey?: string } = {
        answer: raw.answer,
    };
    if (raw.remember !== undefined) {
        if (typeof raw.remember !== 'boolean') {
            throw new InvalidBodyError(
                'remember must be a boolean when present',
            );
        }
        body.remember = raw.remember;
    }
    if (raw.optionKey !== undefined) {
        if (typeof raw.optionKey !== 'string' || raw.optionKey.length === 0) {
            throw new InvalidBodyError(
                'optionKey must be a non-empty string when present',
            );
        }
        body.optionKey = raw.optionKey;
    }
    return body;
}

function parseRejectBody(raw: unknown): RejectBody {
    if (
        !isObject(raw) ||
        typeof raw.feedback !== 'string' ||
        raw.feedback.length === 0
    ) {
        throw new InvalidBodyError('feedback (non-empty string) is required');
    }
    return { feedback: raw.feedback };
}

function parseFollowupBody(raw: unknown): FollowupBody {
    if (
        !isObject(raw) ||
        typeof raw.question !== 'string' ||
        raw.question.length === 0
    ) {
        throw new InvalidBodyError('question (non-empty string) is required');
    }
    return { question: raw.question };
}

function extractActor(raw: unknown, fallback: string): string {
    if (!isObject(raw)) return fallback;
    const actor = raw.actor;
    return typeof actor === 'string' && actor.length > 0 ? actor : fallback;
}

class InvalidJsonError extends Error {}
class InvalidBodyError extends Error {}
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
    res.writeHead(status, {
        'Content-Type': 'application/json',
        ...extraHeaders,
    });
    res.end(JSON.stringify(body));
}
