/**
 * Operator action dispatch for the Telegram chat surface.
 *
 * Translates the {@link ActionKind} values that `chat-intents.converse`
 * returns into commands on the pipeline's {@link CommandBus}. Plain-task
 * verbs (approve / skip / retry / restart / cancel) land here; PR
 * operations live in `chat-pr-actions.ts` and plan-lifecycle operations
 * in `chat-plan-ops.ts`. The intent router (`chat-routing.ts`) picks the
 * right module per action.
 *
 * Each handler emits one command. The command names are kept aligned with
 * `TelegramInboundCommands` from `TelegramGateway.ts` so the callback-
 * button path and the NL path produce the same audit trail. Actions
 * whose v2 commands do not exist yet — `cancel`, `restart` — are
 * surfaced as warn-level logs rather than being silently dropped; the
 * intent classifier's reply already informed the operator that the action
 * was understood.
 */

import type { CommandBus } from '../../core/commands/bus';
import type { Command } from '../../core/commands/command';
import type { Logger } from '../../core/ports';
import { TelegramInboundCommands } from './TelegramGateway';

export const ACTOR_NL = 'telegram-nl';

/**
 * Commands dispatched from chat that do not have a corresponding inbound
 * keyboard verb. Listed explicitly so the orchestrator can `register` a
 * handler at boot rather than discovering the command type from a string
 * literal at first dispatch.
 */
export const ChatNlCommands = {
    /** Operator pressed cancel from chat (commit gate or post-interrupt). */
    CANCEL_TASK: 'CancelTask',
    /** Operator asked to throw away progress and start the task from scratch. */
    RESTART_TASK: 'RestartTask',
} as const;

export interface ChatActionsDeps {
    readonly commandBus: CommandBus<unknown>;
    readonly logger: Logger;
    readonly clock?: () => number;
}

export interface ChatActionInput {
    /** The intent the classifier returned. */
    readonly action: string;
    /** Resolved target identifier — typically a taskId. */
    readonly target?: string;
    /** Action argument (reason, etc.). Empty when unused. */
    readonly payload?: string;
    /** Audit trail actor. Defaults to `telegram-nl`. */
    readonly actor?: string;
}

/**
 * Outcome of an action dispatch. `dispatched` is true when a command was
 * sent on the bus; `false` indicates the action is not wired for chat
 * (yet) or required a target the input did not carry. The router uses
 * this to decide whether to amend the operator-facing reply.
 */
export interface ChatActionResult {
    readonly dispatched: boolean;
    /** Command type sent, when one was. Useful for tests and audit logs. */
    readonly commandType?: string;
    /**
     * Reason the action was not dispatched, when `dispatched` is false.
     * Free-form for now — the router renders this back to the operator
     * verbatim.
     */
    readonly skipReason?: string;
}

export class ChatActions {
    private readonly clock: () => number;

    constructor(private readonly deps: ChatActionsDeps) {
        this.clock = deps.clock ?? ((): number => Date.now());
    }

    /** Dispatch the action onto the command bus. Idempotent in the sense
     *  that downstream handlers are expected to de-dupe on the command's
     *  semantic key (taskId + verb); this method does not deduplicate
     *  in-process. */
    async dispatch(input: ChatActionInput): Promise<ChatActionResult> {
        switch (input.action) {
            case 'approve':
                return this.simpleTaskCommand(input, TelegramInboundCommands.APPROVE_TASK);
            case 'skip':
                return this.simpleTaskCommand(input, TelegramInboundCommands.SKIP_TASK);
            case 'retry':
                return this.simpleTaskCommand(input, TelegramInboundCommands.RETRY_TASK);
            case 'cancel':
                return this.simpleTaskCommand(input, ChatNlCommands.CANCEL_TASK);
            case 'restart':
                return this.simpleTaskCommand(input, ChatNlCommands.RESTART_TASK);
            default:
                return {
                    dispatched: false,
                    skipReason: `chat-actions: unknown action "${input.action}"`,
                };
        }
    }

    private async simpleTaskCommand(
        input: ChatActionInput,
        commandType: string,
    ): Promise<ChatActionResult> {
        if (!input.target || input.target.length === 0) {
            return {
                dispatched: false,
                skipReason: `${commandType}: no target taskId resolved from message`,
            };
        }
        const payload: Record<string, unknown> = { taskId: input.target };
        if (input.payload && input.payload.length > 0) payload.reason = input.payload;
        const command: Command = {
            type: commandType,
            actor: input.actor ?? ACTOR_NL,
            issuedAt: this.clock(),
            payload,
        };
        try {
            await this.deps.commandBus.send(command);
            return { dispatched: true, commandType };
        } catch (err) {
            this.deps.logger.warn('chat-actions: command dispatch failed', {
                command: commandType,
                error: err instanceof Error ? err.message : String(err),
            });
            return {
                dispatched: false,
                commandType,
                skipReason: `dispatch failed: ${err instanceof Error ? err.message : String(err)}`,
            };
        }
    }
}
