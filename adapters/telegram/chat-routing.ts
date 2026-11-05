/**
 * Top-level intent router for the Telegram chat surface.
 *
 * `route(message, ctx)` is the entry point the long-poll loop calls for
 * every inbound text message:
 *
 *   1. If the message is a reply to a previously-recorded clarification
 *      question, dispatch `ResumeTask` and stop. This skips the NL
 *      classifier — the operator's reply is unambiguously the answer to
 *      a parked task.
 *   2. Otherwise run `chat-intents.converse` to classify the intent,
 *      then dispatch through the right sub-module:
 *      `chat-actions` for plain-task verbs (approve / skip / retry /
 *      restart / cancel), `chat-pr-actions` for PR verbs, `chat-plan-ops`
 *      for plan-lifecycle verbs. `start_investigation`, `dismiss_review`
 *      and the note actions are recognised but not yet wired — the
 *      classifier's reply still flows back to the operator, the action
 *      is recorded as a `not-wired` skip.
 *   3. Always send the classifier's `reply` text back to the operator
 *      via the supplied chat gateway. The action's success/failure is
 *      not appended — v1 behaviour is that the model's reply already
 *      summarises what happened.
 */

import type { ChatGateway, Logger } from '../../core/ports';
import { converse, type ConverseContext, type ConverseResult } from './chat-intents';
import { ChatActions } from './chat-actions';
import { ChatPrActions } from './chat-pr-actions';
import { ChatPlanOps } from './chat-plan-ops';
import { ChatClarify } from './chat-clarify';

const PLAIN_TASK_ACTIONS: ReadonlySet<string> = new Set([
    'approve',
    'skip',
    'retry',
    'restart',
    'cancel',
]);

const PR_ACTIONS: ReadonlySet<string> = new Set(['merge', 'mark_merged', 'show_diff']);

const PLAN_ACTIONS: ReadonlySet<string> = new Set([
    'create_plan',
    'run_planner',
    'decompose_plan',
    'archive_plan',
    'delete_plan',
]);

/** Result of routing a single inbound message. Aimed at tests. */
export interface ChatRouteResult {
    /** Source of the dispatch decision. */
    readonly path: 'clarification' | 'nl' | 'dropped';
    /** Classifier output, when the NL path ran. */
    readonly converse?: ConverseResult;
    /** Action that was actually attempted, when any. */
    readonly action?: string;
    /** True when a command was sent on the bus. */
    readonly dispatched: boolean;
    /** Free-form reason when no command was dispatched. */
    readonly skipReason?: string;
}

export interface ChatRoutingDeps {
    readonly clarify: ChatClarify;
    readonly actions: ChatActions;
    readonly prActions: ChatPrActions;
    readonly planOps: ChatPlanOps;
    readonly chatGateway: ChatGateway;
    readonly logger: Logger;
}

export interface RouteInput {
    readonly chatId: number | string;
    readonly text: string;
    readonly replyToMessageId?: number;
    /** Context passed to the classifier when the clarification path misses. */
    readonly converseContext?: ConverseContext;
    /**
     * PR-context resolver — given the classifier's target identifier
     * (taskId / PR number string) the router asks the host for a PR
     * number to act on. Optional; PR actions skip when absent.
     */
    readonly resolvePrNumber?: (target: string | undefined) => number | undefined;
}

/**
 * Inbound text router. One call per message, top-to-bottom: clarification
 * first, then NL classification + dispatch. The result is purely for
 * tests / audit; the loop ignores it after firing the reply.
 */
export class ChatRouting {
    constructor(private readonly deps: ChatRoutingDeps) {}

    async route(input: RouteInput): Promise<ChatRouteResult> {
        // 1. Clarification correlation. Replies to a known question are
        //    unambiguous and skip the NL classifier entirely.
        const handled = await this.deps.clarify.tryHandleReply({
            chatId: input.chatId,
            ...(input.replyToMessageId !== undefined
                ? { replyToMessageId: input.replyToMessageId }
                : {}),
            text: input.text,
        });
        if (handled) {
            return {
                path: 'clarification',
                action: 'resume_task',
                dispatched: true,
            };
        }

        // 2. NL classification + dispatch.
        const converseResult = await converse(input.text, input.converseContext);
        const dispatched = await this.dispatchAction(converseResult, input);

        // 3. Always relay the classifier's reply back to the operator.
        if (converseResult.reply.length > 0) {
            await this.deps.chatGateway
                .notify(String(input.chatId), converseResult.reply)
                .catch((err: unknown) => {
                    this.deps.logger.warn('chat-routing: reply notify failed', {
                        error: err instanceof Error ? err.message : String(err),
                    });
                });
        }

        return {
            path: 'nl',
            converse: converseResult,
            action: converseResult.action,
            dispatched: dispatched.dispatched,
            ...(dispatched.skipReason !== undefined
                ? { skipReason: dispatched.skipReason }
                : {}),
        };
    }

    private async dispatchAction(
        result: ConverseResult,
        input: RouteInput,
    ): Promise<{ dispatched: boolean; skipReason?: string }> {
        if (result.action === 'none') {
            return { dispatched: false, skipReason: 'classifier returned none' };
        }
        if (PLAIN_TASK_ACTIONS.has(result.action)) {
            const r = await this.deps.actions.dispatch({
                action: result.action,
                ...(result.target !== undefined ? { target: result.target } : {}),
                payload: result.payload,
            });
            return r.skipReason !== undefined
                ? { dispatched: r.dispatched, skipReason: r.skipReason }
                : { dispatched: r.dispatched };
        }
        if (PR_ACTIONS.has(result.action)) {
            const prNumber = input.resolvePrNumber?.(result.target);
            const r = await this.deps.prActions.dispatch({
                action: result.action,
                payload: result.payload,
                ...(prNumber !== undefined ? { prNumber } : {}),
            });
            return r.skipReason !== undefined
                ? { dispatched: r.dispatched, skipReason: r.skipReason }
                : { dispatched: r.dispatched };
        }
        if (PLAN_ACTIONS.has(result.action)) {
            const r = await this.deps.planOps.dispatch({
                action: result.action,
                ...(result.target !== undefined ? { target: result.target } : {}),
                payload: result.payload,
            });
            return r.skipReason !== undefined
                ? { dispatched: r.dispatched, skipReason: r.skipReason }
                : { dispatched: r.dispatched };
        }
        // Everything else (start_investigation, dismiss_review, notes, …)
        // is recognised by the classifier but not yet wired to a v2
        // command surface. Log + return skip; the model's reply still
        // tells the operator what was understood.
        this.deps.logger.info('chat-routing: action recognised but not wired', {
            action: result.action,
            target: result.target ?? null,
        });
        return {
            dispatched: false,
            skipReason: `${result.action}: not yet wired in v2`,
        };
    }
}
