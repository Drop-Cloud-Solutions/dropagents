/**
 * Worker-api route for answering a decomposer's question.
 *
 *   POST /plans/:planId/decomposer-answer
 *        Body `{ answer: string, remember?: boolean, actor? }`.
 *        Dispatches `AnswerDecomposerQuestion{ planId, answer, remember }`
 *        and returns 202.
 *   POST /plans/:planId/decomposer-abandon
 *        Body `{ reason?: string, actor? }`. Retires the question
 *        WITHOUT re-spawning the decomposer, and returns 202.
 *
 * The second route exists because an answer can never be an action.
 * Field report: the decomposer offered "cancel the task" as one of its
 * own options, the operator picked it, and the decomposer was
 * re-spawned with that text and asked again — with no Dismiss on the
 * card while a question is pending, there was no way out at all.
 *
 * The plan-lifecycle twin of `POST /tasks/:id/clarify` (routes/tasks.ts).
 * It is a separate route rather than another action on the tasks router
 * because a decomposer run is plan-scoped: there is no task row to resume,
 * no worktree to write a sidecar into, and no flow state to re-dispatch.
 * The command's subscriber re-spawns the decomposer instead.
 *
 * The command handler — not this route — is what rejects an answer to a
 * question that is already answered or was never asked. That check has to
 * happen against the projection at dispatch time, so it lives on the write
 * side; here a rejected command surfaces as a 409 with the handler's own
 * message, which the board turns into a toast the operator can act on.
 *
 * Auth: mounted behind {@link BoardHttpServer}, which enforces the
 * `WORKER_API_TOKEN_V2` bearer on every non-/health request before this
 * router sees the URL — same as every sibling route module.
 */
import * as http from 'node:http';

import type { Command } from '../../../core/commands/command';
import type { StoredEvent } from '../../../core/events/event';
import type { Logger } from '../../../core/ports/Logger';
import {
    PlanLifecycleCommands,
    type AbandonDecomposerQuestionPayload,
    type AnswerDecomposerQuestionPayload,
} from '../../../core/commands/index';

export const DECOMPOSER_ANSWER_ROUTE_PATTERN =
    /^\/plans\/([^/]+)\/decomposer-answer\/?$/;

export const DECOMPOSER_ABANDON_ROUTE_PATTERN =
    /^\/plans\/([^/]+)\/decomposer-abandon\/?$/;

const DEFAULT_ACTOR = 'operator';
const MAX_BODY_BYTES = 64 * 1024;

/** Structural command sink — the production CommandBus and a fake both fit. */
export interface DecomposerClarifyCommandSink {
    send(command: Command): Promise<readonly StoredEvent[]>;
}

export interface DecomposerClarifyDeps {
    readonly bus: DecomposerClarifyCommandSink;
    /** Clock for `Command.issuedAt`. Defaults to `Date.now`. */
    readonly clock?: () => number;
    readonly logger?: Logger;
    readonly defaultActor?: string;
}

export interface DecomposerClarifyRouter {
    handle(req: http.IncomingMessage, res: http.ServerResponse): boolean;
}

export interface DecomposerAnswerBody {
    readonly answer: string;
    readonly remember?: boolean;
}

export interface RouteResult {
    readonly status: number;
    readonly body: Readonly<Record<string, unknown>>;
}

/**
 * Pure dispatcher — no HTTP. Exported so the unit tests can pin the
 * command shape without standing up a server.
 */
export async function dispatchDecomposerAnswer(
    deps: DecomposerClarifyDeps,
    planId: string,
    body: DecomposerAnswerBody,
    actor: string,
): Promise<RouteResult> {
    const payload: AnswerDecomposerQuestionPayload = {
        planId,
        answer: body.answer,
        ...(body.remember !== undefined ? { remember: body.remember } : {}),
    };
    const command: Command<AnswerDecomposerQuestionPayload> = {
        type: PlanLifecycleCommands.ANSWER_DECOMPOSER_QUESTION,
        actor,
        issuedAt: (deps.clock ?? Date.now)(),
        payload,
    };
    deps.logger?.info('decomposer-clarify: answer dispatched', { planId, actor });
    const events = await deps.bus.send(command);
    return {
        status: 202,
        body: {
            accepted: true,
            commandType: PlanLifecycleCommands.ANSWER_DECOMPOSER_QUESTION,
            planId,
            events,
        },
    };
}

/**
 * Pure dispatcher for abandoning the question. Same shape as
 * {@link dispatchDecomposerAnswer} so both share the router below.
 */
export async function dispatchDecomposerAbandon(
    deps: DecomposerClarifyDeps,
    planId: string,
    reason: string | undefined,
    actor: string,
): Promise<RouteResult> {
    const payload: AbandonDecomposerQuestionPayload = {
        planId,
        ...(reason !== undefined && reason.length > 0 ? { reason } : {}),
    };
    const command: Command<AbandonDecomposerQuestionPayload> = {
        type: PlanLifecycleCommands.ABANDON_DECOMPOSER_QUESTION,
        actor,
        issuedAt: (deps.clock ?? Date.now)(),
        payload,
    };
    deps.logger?.info('decomposer-clarify: abandon dispatched', { planId, actor });
    const events = await deps.bus.send(command);
    return {
        status: 202,
        body: {
            accepted: true,
            commandType: PlanLifecycleCommands.ABANDON_DECOMPOSER_QUESTION,
            planId,
            events,
        },
    };
}

export function createDecomposerClarifyRouter(
    deps: DecomposerClarifyDeps,
): DecomposerClarifyRouter {
    return {
        handle(req, res): boolean {
            const url = req.url ?? '/';
            const pathname = url.split('?', 1)[0];
            const match = DECOMPOSER_ANSWER_ROUTE_PATTERN.exec(pathname);
            const abandonMatch = match
                ? null
                : DECOMPOSER_ABANDON_ROUTE_PATTERN.exec(pathname);
            if (!match && !abandonMatch) return false;
            const abandoning = abandonMatch !== null;
            const matched = match ?? abandonMatch!;

            let planId: string;
            try {
                planId = decodeURIComponent(matched[1]);
            } catch {
                respond(res, 404, { error: 'not found' });
                return true;
            }

            if ((req.method ?? 'GET') !== 'POST') {
                respond(res, 405, { error: 'method not allowed' }, { Allow: 'POST' });
                return true;
            }

            readJsonBody(req, (err, parsed) => {
                if (err) {
                    respond(res, err.status, { error: err.message });
                    return;
                }
                const body = parsed as Record<string, unknown>;
                const bodyActor
                    = typeof body.actor === 'string' && body.actor.length > 0
                        ? body.actor
                        : (deps.defaultActor ?? DEFAULT_ACTOR);
                if (abandoning) {
                    // No answer to validate — giving up needs no words.
                    const rawReason = typeof body.reason === 'string'
                        ? body.reason.trim()
                        : undefined;
                    void dispatchDecomposerAbandon(
                        deps,
                        planId,
                        rawReason,
                        bodyActor,
                    )
                        .then((result) => respond(res, result.status, result.body))
                        .catch((dispatchErr: unknown) => {
                            const message = dispatchErr instanceof Error
                                ? dispatchErr.message
                                : String(dispatchErr);
                            deps.logger?.warn('decomposer-clarify: abandon rejected', {
                                planId,
                                error: message,
                            });
                            respond(res, 409, { error: 'abandon rejected', message });
                        });
                    return;
                }
                const answer = body.answer;
                if (typeof answer !== 'string' || answer.trim().length === 0) {
                    respond(res, 400, {
                        error: 'answer is required',
                        message: 'body.answer must be a non-empty string',
                    });
                    return;
                }
                const remember = body.remember;
                if (remember !== undefined && typeof remember !== 'boolean') {
                    respond(res, 400, {
                        error: 'remember must be a boolean',
                    });
                    return;
                }
                const actor = bodyActor;
                void dispatchDecomposerAnswer(
                    deps,
                    planId,
                    {
                        answer: answer.trim(),
                        ...(remember !== undefined ? { remember } : {}),
                    },
                    actor,
                )
                    .then((result) => respond(res, result.status, result.body))
                    .catch((dispatchErr: unknown) => {
                        // A rejected command is the "question already
                        // answered / never asked" case. 409 (not 500) so the
                        // board can say so plainly instead of reporting a
                        // server fault, and the handler's own message is
                        // passed through verbatim — it names the plan.
                        const message = dispatchErr instanceof Error
                            ? dispatchErr.message
                            : String(dispatchErr);
                        deps.logger?.warn('decomposer-clarify: dispatch rejected', {
                            planId,
                            error: message,
                        });
                        respond(res, 409, { error: 'answer rejected', message });
                    });
            });
            return true;
        },
    };
}

interface BodyError {
    readonly status: number;
    readonly message: string;
}

function readJsonBody(
    req: http.IncomingMessage,
    done: (err: BodyError | null, body: unknown) => void,
): void {
    const chunks: Buffer[] = [];
    let size = 0;
    let finished = false;
    const fail = (status: number, message: string): void => {
        if (finished) return;
        finished = true;
        done({ status, message }, null);
    };
    req.on('data', (chunk: Buffer) => {
        if (finished) return;
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
            fail(413, 'request body too large');
            req.destroy();
            return;
        }
        chunks.push(chunk);
    });
    req.on('error', () => fail(400, 'request body read failed'));
    req.on('end', () => {
        if (finished) return;
        finished = true;
        const raw = Buffer.concat(chunks).toString('utf8').trim();
        if (raw.length === 0) {
            done(null, {});
            return;
        }
        try {
            const parsed = JSON.parse(raw) as unknown;
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                done({ status: 400, message: 'body must be a JSON object' }, null);
                return;
            }
            done(null, parsed);
        } catch {
            done({ status: 400, message: 'body must be valid JSON' }, null);
        }
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
