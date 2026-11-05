/**
 * Clarification reply correlation for the Telegram chat surface.
 *
 * Telegram chat is conversational, not request/response: when an agent
 * parks a task on a clarification question the bot sends a message and
 * the operator answers it later (sometimes minutes later, sometimes after
 * other tasks have parked their own questions in between). Without
 * correlation an operator's free-text reply has no unambiguous owner.
 *
 * The correlation key is the `(chatId, questionMessageId)` tuple that
 * Telegram echoes back on every reply as `reply_to_message`. When the
 * adapter sends a question message it records the triple
 * `(taskId, chatId, messageId)` here; when an inbound message carries a
 * `reply_to_message.message_id` matching a record, the adapter dispatches
 * `ResumeTask` against that taskId with the message text threaded onto
 * `answer`.
 *
 * Storage is a small SQLite table — same convention as `telegram_state`
 * in `TelegramGateway`. The schema is bootstrapped lazily in the
 * constructor so tests can hand the correlator a fresh in-memory db
 * without running the migration suite.
 */

import type { Command } from '../../core/commands/command';
import type { CommandBus } from '../../core/commands/bus';
import type { ClarificationReplyCorrelator, Logger } from '../../core/ports';
import type { Db } from '../../core/state/migrations';
import { TaskParkingCommands, type ResumeTaskPayload } from '../../core/commands';

const RESUME_ACTOR = 'telegram-chat-clarify';

export interface ChatClarifyDeps {
    readonly db: Db;
    readonly logger: Logger;
    readonly commandBus: CommandBus<unknown>;
    readonly clock?: () => number;
}

/**
 * Persistence + reply-dispatch surface for clarification questions.
 *
 * The same instance plays two roles: the outbound side (`recordQuestion`)
 * called by the outbound subscriber when an AgentQuestion / TaskParked
 * event is rendered to chat, and the inbound side (`tryHandleReply`)
 * called by the long-poll loop when a free-text message arrives. Keeping
 * both surfaces on one class means the SQLite handle and the schema
 * bootstrap live in one place.
 */
export class ChatClarify implements ClarificationReplyCorrelator {
    private readonly clock: () => number;

    constructor(private readonly deps: ChatClarifyDeps) {
        this.clock = deps.clock ?? ((): number => Date.now());
        this.ensureSchema();
    }

    recordQuestion(taskId: string, chatId: number | string, messageId: number): void {
        // Upsert keyed on taskId: only the most recent outstanding question
        // for a task correlates back. A second question on the same task
        // overwrites the prior pointer because answering the older one is
        // ambiguous — the operator is replying to whichever is on screen.
        this.deps.db
            .prepare(
                `INSERT INTO telegram_clarify(task_id, chat_id, message_id)
                 VALUES (?, ?, ?)
                 ON CONFLICT(task_id) DO UPDATE SET
                     chat_id    = excluded.chat_id,
                     message_id = excluded.message_id`,
            )
            .run(taskId, String(chatId), messageId);
    }

    lookupByQuestionMessageId(
        chatId: number | string,
        messageId: number,
    ): string | undefined {
        const row = this.deps.db
            .prepare(
                `SELECT task_id FROM telegram_clarify
                 WHERE chat_id = ? AND message_id = ?`,
            )
            .get(String(chatId), messageId) as { task_id: string } | undefined;
        return row?.task_id;
    }

    clearForTask(taskId: string): void {
        this.deps.db
            .prepare('DELETE FROM telegram_clarify WHERE task_id = ?')
            .run(taskId);
    }

    /**
     * Attempt to route a free-text reply through the clarification path.
     *
     * Returns `true` when a matching `(chatId, replyToMessageId)` record
     * exists and a `ResumeTask` command was dispatched. The caller should
     * skip the NL intent classifier in that case.
     *
     * Returns `false` when no matching record exists or the reply lacks a
     * `replyToMessageId` (top-level message). The caller falls back to the
     * intent classifier.
     *
     * Command-bus failures are caught and logged at warn-level — the
     * correlation record is preserved so the operator can resend the
     * reply. We do not throw because the long-poll loop is the only call
     * site and it advances its offset regardless.
     */
    async tryHandleReply(input: {
        readonly chatId: number | string;
        readonly replyToMessageId?: number;
        readonly text: string;
    }): Promise<boolean> {
        if (input.replyToMessageId === undefined) return false;
        const taskId = this.lookupByQuestionMessageId(input.chatId, input.replyToMessageId);
        if (!taskId) return false;

        const payload: ResumeTaskPayload = {
            taskId,
            decision: 'approve',
            answer: input.text,
        };
        const command: Command<ResumeTaskPayload> = {
            type: TaskParkingCommands.RESUME_TASK,
            actor: RESUME_ACTOR,
            issuedAt: this.clock(),
            payload,
        };
        try {
            await this.deps.commandBus.send(command);
            // Clear after a successful dispatch so a duplicate reply to the
            // same question message doesn't double-resume. The flow engine
            // de-dupes via event idempotency keys too, but clearing here
            // avoids re-issuing commands the engine will then suppress.
            this.clearForTask(taskId);
            return true;
        } catch (err) {
            this.deps.logger.warn('chat-clarify: ResumeTask dispatch failed', {
                taskId,
                error: err instanceof Error ? err.message : String(err),
            });
            // Treat as "handled" so the loop does not fall through to the
            // NL classifier — the operator's intent is unambiguous; better
            // to surface the failure on the next poll than to silently
            // start a different command.
            return true;
        }
    }

    private ensureSchema(): void {
        this.deps.db.exec(
            `CREATE TABLE IF NOT EXISTS telegram_clarify (
                task_id    TEXT NOT NULL PRIMARY KEY,
                chat_id    TEXT NOT NULL,
                message_id INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_telegram_clarify_chat_msg
                ON telegram_clarify(chat_id, message_id);`,
        );
    }
}
