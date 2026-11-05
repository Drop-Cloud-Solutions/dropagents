import { test } from 'node:test';
import assert from 'node:assert/strict';

import Database from 'better-sqlite3';

import { CommandBus } from '../../core/commands/bus';
import type { Command } from '../../core/commands/command';
import { EventBus } from '../../core/events/bus';
import { EventStore } from '../../core/events/store';
import type { Db } from '../../core/state/migrations';
import type { Logger } from '../../core/ports';

import { TaskOpsCommands, TaskParkingCommands } from '../../core/commands';

import {
    CHAT_UNAVAILABLE_TEXT,
    CHAT_NO_REPO_TEXT,
    COMMAND_NOT_SUPPORTED_TEXT,
    PROPOSAL_CONFIRM_UNAVAILABLE_TEXT,
    PROPOSAL_DISMISSED_TEXT,
    PROPOSAL_EXPIRED_TEXT,
    SLASH_COMMAND_NEEDS_TARGET_TEXT,
    TelegramGateway,
    TelegramInboundCommands,
    TelegramOutboundEvents,
    mapSlashCommand,
    parseCallbackData,
    parseClarifyCallback,
    parsePendingCallback,
    readTelegramEnv,
    renderProposalPrompt,
    type ConfirmedProposalContext,
    type ProposalConfirmOutcome,
    type TelegramChatService,
    type TelegramEnv,
} from './TelegramGateway';
import type {
    GetUpdatesOptions,
    SendMessageOptions,
    TelegramApi,
    TelegramMessage,
    TelegramUpdate,
} from './api';
import type {
    ChannelSessionSeed,
    ChatTurnResult,
    Proposal,
    RunTurnArgs,
} from '../../hosts/worker-api/chat-service';

// ---------------------------------------------------------------------------
// Test scaffolding
// ---------------------------------------------------------------------------

class SilentLogger implements Logger {
    info(): void {}
    warn(): void {}
    error(): void {}
    debug(): void {}
}

interface RecordingCommandBus {
    readonly bus: CommandBus<unknown>;
    readonly sent: Command[];
}

function makeBus(db: Db): EventBus {
    const store = new EventStore(db);
    return new EventBus(store, new SilentLogger());
}

function makeRecordingCommandBus(eventBus: EventBus): RecordingCommandBus {
    const sent: Command[] = [];
    const cb = new CommandBus<unknown>(eventBus, () => undefined);
    for (const type of [
        TelegramInboundCommands.APPROVE_TASK,
        TelegramInboundCommands.SKIP_TASK,
        TelegramInboundCommands.RETRY_TASK,
    ]) {
        cb.register(type, async (cmd) => {
            sent.push(cmd);
            return [];
        });
    }
    return { bus: cb, sent };
}

function makeDb(): Db {
    const db = new Database(':memory:') as Db;
    db.pragma('foreign_keys = ON');
    // The events / subscriber_offsets tables are all the test path needs;
    // the gateway creates its own telegram_state table via ensureSchema.
    db.exec(`
        CREATE TABLE events (
            seq             INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
            type            TEXT    NOT NULL,
            v               INTEGER NOT NULL,
            occurred_at     INTEGER NOT NULL,
            idempotency_key TEXT    NOT NULL UNIQUE,
            payload         TEXT    NOT NULL
        );
        CREATE TABLE subscriber_offsets (
            subscriber TEXT    NOT NULL PRIMARY KEY,
            last_seq   INTEGER NOT NULL
        );
    `);
    return db;
}

class FakeTelegramApi implements TelegramApi {
    readonly sent: SendMessageOptions[] = [];
    readonly acknowledged: string[] = [];
    readonly getUpdatesCalls: GetUpdatesOptions[] = [];
    private callIdx = 0;
    private nextMessageId = 1;

    constructor(private readonly batches: readonly TelegramUpdate[][] = []) {}

    async getUpdates(opts: GetUpdatesOptions): Promise<TelegramUpdate[]> {
        this.getUpdatesCalls.push(opts);
        const batch = this.batches[this.callIdx] ?? [];
        this.callIdx += 1;
        return batch;
    }

    async sendMessage(opts: SendMessageOptions): Promise<TelegramMessage> {
        this.sent.push(opts);
        const chatIdNum =
            typeof opts.chat_id === 'number' ? opts.chat_id : Number(opts.chat_id);
        const messageId = this.nextMessageId++;
        return {
            chat: { id: Number.isFinite(chatIdNum) ? chatIdNum : 0 },
            message_id: messageId,
            text: opts.text,
        };
    }

    async answerCallbackQuery(opts: { readonly callback_query_id: string }): Promise<void> {
        this.acknowledged.push(opts.callback_query_id);
    }
}

interface Harness {
    readonly db: Db;
    readonly eventBus: EventBus;
    readonly commandBus: CommandBus<unknown>;
    readonly sentCommands: Command[];
    readonly api: FakeTelegramApi;
    readonly gateway: TelegramGateway;
}

function makeHarness(opts: {
    env: TelegramEnv;
    apiFactoryCalls?: string[];
    batches?: readonly TelegramUpdate[][];
}): Harness {
    const db = makeDb();
    const eventBus = makeBus(db);
    const { bus: commandBus, sent: sentCommands } = makeRecordingCommandBus(eventBus);
    const api = new FakeTelegramApi(opts.batches ?? []);

    const gateway = new TelegramGateway({
        bus: eventBus,
        commandBus,
        db,
        logger: new SilentLogger(),
        clock: (): number => 1_700_000_000_000,
        envProvider: (): TelegramEnv => opts.env,
        apiFactory: (token: string): TelegramApi => {
            if (opts.apiFactoryCalls) opts.apiFactoryCalls.push(token);
            return api;
        },
    });

    return { db, eventBus, commandBus, sentCommands, api, gateway };
}

function callbackUpdate(
    updateId: number,
    userId: number,
    data: string,
): TelegramUpdate {
    return {
        update_id: updateId,
        callback_query: {
            id: `cb-${updateId}`,
            from: { id: userId },
            data,
            message: { chat: { id: userId }, message_id: 1 },
        },
    };
}

async function publishStored(eventBus: EventBus, type: string, payload: unknown): Promise<void> {
    await eventBus.publish({
        type,
        v: 1,
        occurredAt: 1_700_000_000_000,
        idempotencyKey: `test:${type}:${Math.random().toString(36).slice(2)}`,
        payload,
    });
}

// ---------------------------------------------------------------------------
// parseCallbackData unit
// ---------------------------------------------------------------------------

test('parseCallbackData: approve requires taskId and flowId', () => {
    assert.deepEqual(parseCallbackData('approve:t1:flowA'), {
        commandType: TelegramInboundCommands.APPROVE_TASK,
        payload: { taskId: 't1', flowId: 'flowA' },
        verb: 'approve',
    });
    assert.equal(parseCallbackData('approve:t1'), undefined);
});

test('parseCallbackData: skip and retry require only taskId', () => {
    assert.deepEqual(parseCallbackData('skip:t9'), {
        commandType: TelegramInboundCommands.SKIP_TASK,
        payload: { taskId: 't9' },
        verb: 'skip',
    });
    assert.deepEqual(parseCallbackData('retry:t3'), {
        commandType: TelegramInboundCommands.RETRY_TASK,
        payload: { taskId: 't3' },
        verb: 'retry',
    });
});

test('parseCallbackData: unknown verb and empty input are rejected', () => {
    assert.equal(parseCallbackData(undefined), undefined);
    assert.equal(parseCallbackData(''), undefined);
    assert.equal(parseCallbackData('frobnicate:t1'), undefined);
});

// ---------------------------------------------------------------------------
// AC #3 — Inbound callback_query routes to the matching command
// ---------------------------------------------------------------------------

test('inbound callback_query is parsed and dispatched as the matching command', async () => {
    const h = makeHarness({
        env: { token: 'tok', allowedUserIds: [42] },
        batches: [
            [
                callbackUpdate(1, 42, 'approve:task-1:flow-A'),
                callbackUpdate(2, 42, 'skip:task-2'),
                callbackUpdate(3, 42, 'retry:task-3'),
            ],
        ],
    });

    await h.gateway.pollOnce();

    assert.equal(h.sentCommands.length, 3);
    assert.equal(h.sentCommands[0].type, TelegramInboundCommands.APPROVE_TASK);
    assert.deepEqual(h.sentCommands[0].payload, {
        taskId: 'task-1',
        flowId: 'flow-A',
    });
    assert.equal(h.sentCommands[0].actor, 'telegram');

    assert.equal(h.sentCommands[1].type, TelegramInboundCommands.SKIP_TASK);
    assert.deepEqual(h.sentCommands[1].payload, { taskId: 'task-2' });

    assert.equal(h.sentCommands[2].type, TelegramInboundCommands.RETRY_TASK);
    assert.deepEqual(h.sentCommands[2].payload, { taskId: 'task-3' });

    // Telegram callbacks were acknowledged so the operator's UI clears.
    assert.deepEqual(h.api.acknowledged, ['cb-1', 'cb-2', 'cb-3']);
});

// ---------------------------------------------------------------------------
// Denied callbacks are rejected deny-by-default and warned (numeric id only)
// ---------------------------------------------------------------------------

interface WarnEntry {
    readonly msg: string;
    readonly meta: Record<string, unknown> | undefined;
}

function makeCapturingLogger(): {
    logger: Logger;
    warned: WarnEntry[];
    errored: string[];
} {
    const warned: WarnEntry[] = [];
    const errored: string[] = [];
    const logger: Logger = {
        info: () => {},
        debug: () => {},
        warn: (msg, meta) => warned.push({ msg, meta: meta as Record<string, unknown> | undefined }),
        error: (msg) => errored.push(msg),
    };
    return { logger, warned, errored };
}

test('callbacks from disallowed user IDs are rejected and warned with only the numeric id', async () => {
    const { logger, warned, errored } = makeCapturingLogger();

    const db = makeDb();
    const eventBus = makeBus(db);
    const { bus: commandBus, sent } = makeRecordingCommandBus(eventBus);
    const api = new FakeTelegramApi([
        [callbackUpdate(7, 9999 /* not allowed */, 'approve:task-1:flow-A')],
    ]);

    const gateway = new TelegramGateway({
        bus: eventBus,
        commandBus,
        db,
        logger,
        envProvider: () => ({ token: 'tok', allowedUserIds: [42] }),
        apiFactory: () => api,
    });

    await gateway.pollOnce();

    assert.equal(sent.length, 0, 'no command should be sent for disallowed user');
    assert.deepEqual(api.acknowledged, [], 'no callback ack for disallowed user');
    assert.equal(warned.length, 1, 'the denied callback surfaces exactly one warn');
    assert.equal(errored.length, 0, 'a denied sender is a warn, not an error');
    // The warn carries only the numeric sender id — never the callback data
    // (which could carry task/flow context) or the bot token.
    assert.deepEqual(warned[0].meta, { senderId: 9999 });
    const serialized = warned[0].msg + JSON.stringify(warned[0].meta);
    assert.ok(!serialized.includes('approve:task-1:flow-A'), 'callback data must not leak into the warn');
    assert.ok(!serialized.includes('tok'), 'the bot token must not leak into the warn');
});

// ---------------------------------------------------------------------------
// AC #5 — No-op when TELEGRAM_BOT_TOKEN_V2 is unset
// ---------------------------------------------------------------------------

test('gateway becomes a no-op when token env var is unset', async () => {
    const apiFactoryCalls: string[] = [];
    const h = makeHarness({
        env: { token: undefined, allowedUserIds: [42] },
        apiFactoryCalls,
        batches: [[callbackUpdate(1, 42, 'approve:task-1:flow-A')]],
    });

    await h.gateway.start();
    try {
        // notify is a no-op
        await h.gateway.notify('any', 'hello');

        // outbound subscribers are wired (start succeeds) but emit no traffic
        await publishStored(h.eventBus, TelegramOutboundEvents.TASK_FINISHED, {
            taskId: 't1',
        });
        await publishStored(h.eventBus, TelegramOutboundEvents.TASK_FAILED, {
            taskId: 't1',
            reason: 'boom',
        });

        // explicit pollOnce skips getUpdates entirely when no token is set
        await h.gateway.pollOnce();
    } finally {
        await h.gateway.stop();
    }

    assert.deepEqual(apiFactoryCalls, [], 'apiFactory must not be invoked with no token');
    assert.equal(h.api.sent.length, 0, 'no outbound sendMessage when token unset');
    assert.equal(h.api.getUpdatesCalls.length, 0, 'no getUpdates when token unset');
    assert.equal(h.sentCommands.length, 0, 'no inbound dispatch when token unset');
});

// ---------------------------------------------------------------------------
// AC #6 — Outbound subscriber translates the four event types to sendMessage
// ---------------------------------------------------------------------------

test('outbound subscriber translates the four event types to sendMessage calls', async () => {
    const h = makeHarness({
        env: { token: 'tok', allowedUserIds: [42] },
    });

    await h.gateway.start();
    try {
        await publishStored(h.eventBus, TelegramOutboundEvents.OPERATOR_ACTION_REQUIRED, {
            taskId: 'task-A',
            flowId: 'flow-X',
            reason: 'manual review',
        });
        await publishStored(h.eventBus, TelegramOutboundEvents.TASK_FINISHED, {
            taskId: 'task-B',
        });
        await publishStored(h.eventBus, TelegramOutboundEvents.TASK_FAILED, {
            taskId: 'task-C',
            reason: 'build broke',
        });
        await publishStored(h.eventBus, TelegramOutboundEvents.AGENT_QUESTION, {
            taskId: 'task-D',
            question: 'which env?',
        });
    } finally {
        await h.gateway.stop();
    }

    assert.equal(h.api.sent.length, 4, 'one sendMessage per outbound event');

    const byTaskMention = (id: string): SendMessageOptions | undefined =>
        h.api.sent.find((m) => m.text.includes(id));

    const actionMsg = byTaskMention('task-A');
    assert.ok(actionMsg, 'OperatorActionRequired produced a message');
    assert.match(actionMsg!.text, /manual review/);
    assert.ok(
        actionMsg!.reply_markup?.inline_keyboard,
        'OperatorActionRequired uses an inline keyboard',
    );
    // The approve button must carry the flowId in callback_data so the
    // inbound parser can reconstruct ApproveTask's payload.
    const buttons = actionMsg!.reply_markup!.inline_keyboard.flat();
    assert.ok(buttons.some((b) => b.callback_data === 'approve:task-A:flow-X'));

    const finishedMsg = byTaskMention('task-B');
    assert.ok(finishedMsg, 'TaskFinished produced a message');
    assert.equal(
        finishedMsg!.reply_markup,
        undefined,
        'TaskFinished is informational — no buttons',
    );

    const failedMsg = byTaskMention('task-C');
    assert.ok(failedMsg, 'TaskFailed produced a message');
    assert.match(failedMsg!.text, /build broke/);
    const failedButtons = failedMsg!.reply_markup!.inline_keyboard.flat();
    assert.ok(failedButtons.some((b) => b.callback_data === 'retry:task-C'));

    const questionMsg = byTaskMention('task-D');
    assert.ok(questionMsg, 'AgentQuestion produced a message');
    assert.match(questionMsg!.text, /which env\?/);
});

test('outbound subscriber broadcasts to every allowed user id', async () => {
    const h = makeHarness({
        env: { token: 'tok', allowedUserIds: [42, 43] },
    });

    await h.gateway.start();
    try {
        await publishStored(h.eventBus, TelegramOutboundEvents.TASK_FINISHED, {
            taskId: 'task-A',
        });
    } finally {
        await h.gateway.stop();
    }

    assert.equal(h.api.sent.length, 2);
    assert.deepEqual(
        h.api.sent.map((m) => m.chat_id).sort(),
        [42, 43],
    );
});

// ---------------------------------------------------------------------------
// AC #2 — Offset is tracked and persisted across restarts
// ---------------------------------------------------------------------------

test('long-poll offset is persisted in SQLite and survives restart', async () => {
    const db = makeDb();
    const eventBus = makeBus(db);
    const { bus: commandBus } = makeRecordingCommandBus(eventBus);

    const env: TelegramEnv = { token: 'tok', allowedUserIds: [42] };
    const api1 = new FakeTelegramApi([
        [callbackUpdate(100, 42, 'skip:t-100'), callbackUpdate(101, 42, 'skip:t-101')],
    ]);
    const gateway1 = new TelegramGateway({
        bus: eventBus,
        commandBus,
        db,
        logger: new SilentLogger(),
        envProvider: (): TelegramEnv => env,
        apiFactory: (): TelegramApi => api1,
    });

    await gateway1.start();
    await gateway1.pollOnce();
    await gateway1.stop();

    // After processing update_id=101 the next offset must be 102.
    const row = db
        .prepare("SELECT value FROM telegram_state WHERE key = 'update_offset'")
        .get() as { value: string } | undefined;
    assert.equal(row?.value, '102');

    // Restart against the same db file: the new instance must call getUpdates
    // with offset=102, not 0.
    const api2 = new FakeTelegramApi([[]]);
    const gateway2 = new TelegramGateway({
        bus: eventBus,
        commandBus,
        db,
        logger: new SilentLogger(),
        envProvider: (): TelegramEnv => env,
        apiFactory: (): TelegramApi => api2,
    });

    await gateway2.start();
    await gateway2.pollOnce();
    await gateway2.stop();

    assert.ok(api2.getUpdatesCalls.length >= 1);
    assert.equal(api2.getUpdatesCalls[0].offset, 102);
});

// ---------------------------------------------------------------------------
// notify() — ChatGateway port surface
// ---------------------------------------------------------------------------

test('notify(channel, message) sends a plain message to the supplied chat id', async () => {
    const h = makeHarness({
        env: { token: 'tok', allowedUserIds: [42] },
    });

    await h.gateway.notify('99999', 'hello operator');

    assert.equal(h.api.sent.length, 1);
    assert.equal(h.api.sent[0].chat_id, '99999');
    assert.equal(h.api.sent[0].text, 'hello operator');
    assert.equal(h.api.sent[0].reply_markup, undefined);
});

// ---------------------------------------------------------------------------
// AC #1 / AC #5 — Inbound text long-poll path + allow-list silent drop
// ---------------------------------------------------------------------------

function textUpdate(opts: {
    updateId: number;
    userId: number;
    chatId: number;
    text: string;
    replyToMessageId?: number;
}): TelegramUpdate {
    return {
        update_id: opts.updateId,
        message: {
            chat: { id: opts.chatId },
            message_id: opts.updateId,
            from: { id: opts.userId },
            text: opts.text,
            ...(opts.replyToMessageId !== undefined
                ? { reply_to_message: { message_id: opts.replyToMessageId } }
                : {}),
        },
    };
}

interface CapturedRoute {
    readonly chatId: number | string;
    readonly text: string;
    readonly replyToMessageId?: number;
}

interface FakeRouter {
    readonly routed: CapturedRoute[];
}

function makeFakeRouter(): {
    router: { route: (input: CapturedRoute) => Promise<void> };
    state: FakeRouter;
} {
    const routed: CapturedRoute[] = [];
    return {
        state: { routed },
        router: {
            async route(input) {
                routed.push(input);
            },
        },
    };
}

test('inbound text from an allowed user is delivered to the chat router', async () => {
    const { router, state } = makeFakeRouter();
    const db = makeDb();
    const eventBus = makeBus(db);
    const { bus: commandBus, sent } = makeRecordingCommandBus(eventBus);
    const api = new FakeTelegramApi([
        [
            textUpdate({
                updateId: 10,
                userId: 42,
                chatId: 99,
                text: 'try again',
                replyToMessageId: 7,
            }),
        ],
    ]);

    const gateway = new TelegramGateway({
        bus: eventBus,
        commandBus,
        db,
        logger: new SilentLogger(),
        envProvider: () => ({ token: 'tok', allowedUserIds: [42] }),
        apiFactory: () => api,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        chatRouter: router as any,
    });

    await gateway.pollOnce();

    assert.equal(state.routed.length, 1);
    assert.equal(state.routed[0].chatId, 99);
    assert.equal(state.routed[0].text, 'try again');
    assert.equal(state.routed[0].replyToMessageId, 7);
    // No keyboard callback was issued — the inbound text path is distinct
    // from the inline-keyboard one.
    assert.equal(sent.length, 0);
});

test('inbound text from a disallowed user is denied and warned without leaking content', async () => {
    const { logger, warned, errored } = makeCapturingLogger();

    const { router, state } = makeFakeRouter();
    const db = makeDb();
    const eventBus = makeBus(db);
    const { bus: commandBus } = makeRecordingCommandBus(eventBus);
    const api = new FakeTelegramApi([
        [
            textUpdate({
                updateId: 50,
                userId: 9999, // not allowed
                chatId: 99,
                text: 'restart it',
            }),
        ],
    ]);

    const gateway = new TelegramGateway({
        bus: eventBus,
        commandBus,
        db,
        logger,
        envProvider: () => ({ token: 'tok', allowedUserIds: [42] }),
        apiFactory: () => api,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        chatRouter: router as any,
    });

    await gateway.pollOnce();

    assert.equal(state.routed.length, 0, 'router must not be invoked for disallowed user');
    assert.equal(warned.length, 1, 'the denied message surfaces exactly one warn');
    assert.equal(errored.length, 0, 'a denied sender is a warn, not an error');
    // Only the numeric id is logged — the message text ("restart it") and the
    // bot token must never appear in the warn line.
    assert.deepEqual(warned[0].meta, { senderId: 9999 });
    const serialized = warned[0].msg + JSON.stringify(warned[0].meta);
    assert.ok(!serialized.includes('restart it'), 'message text must not leak into the warn');
    assert.ok(!serialized.includes('tok'), 'the bot token must not leak into the warn');
});

test('outbound AgentQuestion records (taskId, chatId, messageId) into the correlator', async () => {
    const db = makeDb();
    const eventBus = makeBus(db);
    const { bus: commandBus } = makeRecordingCommandBus(eventBus);
    const api = new FakeTelegramApi();

    // Build a ChatClarify against the same db so we can observe persistence.
    // Lazy import to avoid circular type complaints in this file.
    const { ChatClarify } = await import('./chat-clarify');
    const clarify = new ChatClarify({
        db,
        logger: new SilentLogger(),
        commandBus,
    });

    const gateway = new TelegramGateway({
        bus: eventBus,
        commandBus,
        db,
        logger: new SilentLogger(),
        envProvider: () => ({ token: 'tok', allowedUserIds: [42, 43] }),
        apiFactory: () => api,
        clarify,
    });

    await gateway.start();
    try {
        await publishStored(eventBus, TelegramOutboundEvents.AGENT_QUESTION, {
            taskId: 'task-7',
            question: 'which bucket?',
        });
    } finally {
        await gateway.stop();
    }

    // Two outbound messages (one per allowed user). The most recent
    // recordQuestion wins — that's by design (only one outstanding
    // pointer per taskId).
    assert.equal(api.sent.length, 2);
    const lastSent = api.sent[api.sent.length - 1];
    assert.equal(typeof lastSent.chat_id, 'number');

    // Confirm correlation actually persisted: replying to the recorded
    // message_id of one of the sent messages must resolve back to task-7.
    // FakeTelegramApi assigns message_ids 1..N in send order.
    const handled = await clarify.tryHandleReply({
        chatId: 43,
        replyToMessageId: 2,
        text: 'staging please',
    });
    assert.equal(handled, true, 'reply to the second question message must correlate');
});

// ---------------------------------------------------------------------------
// Deny-by-default — an unset allow-list rejects every sender
// ---------------------------------------------------------------------------

test('an empty allow-list denies a legitimate-looking sender by default', async () => {
    const { logger, warned, errored } = makeCapturingLogger();

    const { router, state } = makeFakeRouter();
    const db = makeDb();
    const eventBus = makeBus(db);
    const { bus: commandBus, sent } = makeRecordingCommandBus(eventBus);
    const api = new FakeTelegramApi([
        [
            // A callback and a text message, both from a real-looking id, but
            // the allow-list is empty so deny-by-default rejects both.
            callbackUpdate(1, 42, 'approve:task-1:flow-A'),
            textUpdate({ updateId: 2, userId: 42, chatId: 99, text: 'hi' }),
        ],
    ]);

    const gateway = new TelegramGateway({
        bus: eventBus,
        commandBus,
        db,
        logger,
        envProvider: () => ({ token: 'tok', allowedUserIds: [] }),
        apiFactory: () => api,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        chatRouter: router as any,
    });

    await gateway.pollOnce();

    assert.equal(sent.length, 0, 'deny-all: no command dispatched');
    assert.equal(state.routed.length, 0, 'deny-all: router never invoked');
    assert.deepEqual(api.acknowledged, [], 'deny-all: no callback ack');
    assert.equal(warned.length, 2, 'both denied senders surface a warn');
    assert.equal(errored.length, 0);
    assert.deepEqual(
        warned.map((w) => w.meta),
        [{ senderId: 42 }, { senderId: 42 }],
        'each warn carries only the numeric sender id',
    );
});

// ---------------------------------------------------------------------------
// P-CPTO-004 — slash-command fast path in handleTextMessage
// ---------------------------------------------------------------------------

/**
 * Command bus registering exactly the three verbs the orchestrator wires a
 * handler for (ResumeTask / SkipTask / RetryTask) — the set the slash fast
 * path is allowed to dispatch. Deliberately does NOT register CancelTask, so
 * a test that erroneously dispatched it would fail with "no handler
 * registered" rather than passing silently.
 */
function makeSlashCommandBus(eventBus: EventBus): RecordingCommandBus {
    const sent: Command[] = [];
    const cb = new CommandBus<unknown>(eventBus, () => undefined);
    for (const type of [
        TaskParkingCommands.RESUME_TASK,
        TaskOpsCommands.SKIP_TASK,
        TaskOpsCommands.RETRY_TASK,
    ]) {
        cb.register(type, async (cmd) => {
            sent.push(cmd);
            return [];
        });
    }
    return { bus: cb, sent };
}

interface SlashHarness {
    readonly gateway: TelegramGateway;
    readonly api: FakeTelegramApi;
    readonly sent: Command[];
    readonly routed: CapturedRoute[];
}

function makeSlashHarness(opts: {
    resolveTaskId?: (input: {
        readonly chatId: number | string;
        readonly replyToMessageId?: number;
    }) => string | undefined;
    batches?: readonly TelegramUpdate[][];
    withRouter?: boolean;
}): SlashHarness {
    const db = makeDb();
    const eventBus = makeBus(db);
    const { bus: commandBus, sent } = makeSlashCommandBus(eventBus);
    const api = new FakeTelegramApi(opts.batches ?? []);
    const { router, state } = makeFakeRouter();

    const gateway = new TelegramGateway({
        bus: eventBus,
        commandBus,
        db,
        logger: new SilentLogger(),
        clock: (): number => 1_700_000_000_000,
        envProvider: (): TelegramEnv => ({ token: 'tok', allowedUserIds: [42] }),
        apiFactory: (): TelegramApi => api,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        chatRouter: (opts.withRouter === false ? undefined : (router as any)),
        ...(opts.resolveTaskId ? { resolveTaskId: opts.resolveTaskId } : {}),
    });

    return { gateway, api, sent, routed: state.routed };
}

test('AC1: slash /approve dispatches ResumeTask{approve} before the NL router runs', async () => {
    const h = makeSlashHarness({
        resolveTaskId: () => 'task-42',
        batches: [[textUpdate({ updateId: 1, userId: 42, chatId: 99, text: '/approve' })]],
    });

    await h.gateway.pollOnce();

    assert.equal(h.sent.length, 1);
    assert.equal(h.sent[0].type, TaskParkingCommands.RESUME_TASK);
    assert.equal(h.sent[0].actor, 'telegram');
    assert.deepEqual(h.sent[0].payload, { taskId: 'task-42', decision: 'approve' });
    assert.equal(h.routed.length, 0, 'the NL router is skipped for a slash command');
    assert.equal(h.api.sent.length, 0, 'a successful dispatch sends no operator reply');
});

test('AC1: slash /skip and /retry dispatch their task-ops commands', async () => {
    const h = makeSlashHarness({
        resolveTaskId: () => 'task-7',
        batches: [
            [
                textUpdate({ updateId: 1, userId: 42, chatId: 99, text: '/skip' }),
                textUpdate({ updateId: 2, userId: 42, chatId: 99, text: '/retry' }),
            ],
        ],
    });

    await h.gateway.pollOnce();

    assert.equal(h.sent.length, 2);
    assert.equal(h.sent[0].type, TaskOpsCommands.SKIP_TASK);
    assert.deepEqual(h.sent[0].payload, { taskId: 'task-7' });
    assert.equal(h.sent[1].type, TaskOpsCommands.RETRY_TASK);
    assert.deepEqual(h.sent[1].payload, { taskId: 'task-7' });
});

test('AC1: slash /reject threads feedback and /clarify threads the answer', async () => {
    const h = makeSlashHarness({
        resolveTaskId: () => 'task-9',
        batches: [
            [
                textUpdate({
                    updateId: 1,
                    userId: 42,
                    chatId: 99,
                    text: '/reject needs more tests',
                }),
                textUpdate({
                    updateId: 2,
                    userId: 42,
                    chatId: 99,
                    text: '/clarify use staging',
                }),
            ],
        ],
    });

    await h.gateway.pollOnce();

    assert.equal(h.sent.length, 2);
    assert.equal(h.sent[0].type, TaskParkingCommands.RESUME_TASK);
    assert.deepEqual(h.sent[0].payload, {
        taskId: 'task-9',
        decision: 'reject',
        feedback: 'needs more tests',
    });
    assert.equal(h.sent[1].type, TaskParkingCommands.RESUME_TASK);
    assert.deepEqual(h.sent[1].payload, {
        taskId: 'task-9',
        decision: 'approve',
        answer: 'use staging',
    });
});

test('AC2: an unrecognized slash command replies not-supported and dispatches nothing', async () => {
    const h = makeSlashHarness({
        resolveTaskId: () => 'task-1',
        batches: [[textUpdate({ updateId: 1, userId: 42, chatId: 99, text: '/frobnicate' })]],
    });

    await h.gateway.pollOnce();

    assert.equal(h.sent.length, 0, 'unknown verb dispatches no command');
    assert.equal(h.routed.length, 0, 'unknown verb does not fall through to the NL router');
    assert.equal(h.api.sent.length, 1, 'the sender gets an explicit reply');
    assert.equal(h.api.sent[0].chat_id, '99');
    assert.equal(h.api.sent[0].text, COMMAND_NOT_SUPPORTED_TEXT);
});

test('AC4: slash /cancel replies not-supported because CancelTask has no registered handler', async () => {
    const h = makeSlashHarness({
        resolveTaskId: () => 'task-1',
        batches: [[textUpdate({ updateId: 1, userId: 42, chatId: 99, text: '/cancel' })]],
    });

    await h.gateway.pollOnce();

    assert.equal(h.sent.length, 0, 'CancelTask is never dispatched — the bus has no handler for it');
    assert.equal(h.routed.length, 0);
    assert.equal(h.api.sent.length, 1);
    assert.equal(h.api.sent[0].text, COMMAND_NOT_SUPPORTED_TEXT);
});

test('AC3: non-slash free text falls through to the NL router unchanged', async () => {
    const h = makeSlashHarness({
        resolveTaskId: () => 'task-1',
        batches: [
            [
                textUpdate({
                    updateId: 1,
                    userId: 42,
                    chatId: 99,
                    text: 'restart it',
                    replyToMessageId: 5,
                }),
            ],
        ],
    });

    await h.gateway.pollOnce();

    assert.equal(h.sent.length, 0, 'free text does not hit the command bus directly');
    assert.equal(h.routed.length, 1);
    assert.equal(h.routed[0].chatId, 99);
    assert.equal(h.routed[0].text, 'restart it');
    assert.equal(h.routed[0].replyToMessageId, 5);
    assert.equal(h.api.sent.length, 0, 'no not-supported reply for free text');
});

test('a wired slash command with no resolvable target asks the operator to reply to the task', async () => {
    const h = makeSlashHarness({
        // No resolveTaskId and no clarify → the target cannot be resolved.
        batches: [[textUpdate({ updateId: 1, userId: 42, chatId: 99, text: '/approve' })]],
    });

    await h.gateway.pollOnce();

    assert.equal(h.sent.length, 0, 'a target-less command is not dispatched');
    assert.equal(h.api.sent.length, 1);
    assert.equal(h.api.sent[0].text, SLASH_COMMAND_NEEDS_TARGET_TEXT);
});

test('slash command resolves its target via reply-to correlation when no resolver is injected', async () => {
    const db = makeDb();
    const eventBus = makeBus(db);
    const { bus: commandBus, sent } = makeSlashCommandBus(eventBus);
    const api = new FakeTelegramApi([
        [
            textUpdate({
                updateId: 1,
                userId: 42,
                chatId: 99,
                text: '/approve',
                replyToMessageId: 500,
            }),
        ],
    ]);

    const { ChatClarify } = await import('./chat-clarify');
    const clarify = new ChatClarify({ db, logger: new SilentLogger(), commandBus });
    // The operator is replying to a question message the bot sent for task-corr.
    clarify.recordQuestion('task-corr', 99, 500);

    const gateway = new TelegramGateway({
        bus: eventBus,
        commandBus,
        db,
        logger: new SilentLogger(),
        clock: (): number => 1_700_000_000_000,
        envProvider: () => ({ token: 'tok', allowedUserIds: [42] }),
        apiFactory: () => api,
        clarify,
    });

    await gateway.pollOnce();

    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, TaskParkingCommands.RESUME_TASK);
    assert.deepEqual(sent[0].payload, { taskId: 'task-corr', decision: 'approve' });
});

test('AC4: mapSlashCommand only maps handler-backed verbs; /cancel is unmapped', () => {
    // Every mapped command type is one the orchestrator registers a handler for.
    const registered = new Set<string>([
        TaskParkingCommands.RESUME_TASK,
        TaskOpsCommands.SKIP_TASK,
        TaskOpsCommands.RETRY_TASK,
    ]);

    assert.equal(mapSlashCommand({ kind: 'CancelTask' }), undefined);
    assert.deepEqual(mapSlashCommand({ kind: 'SkipTask' }), {
        commandType: TaskOpsCommands.SKIP_TASK,
        payload: {},
    });
    assert.deepEqual(mapSlashCommand({ kind: 'RetryTask' }), {
        commandType: TaskOpsCommands.RETRY_TASK,
        payload: {},
    });
    assert.deepEqual(mapSlashCommand({ kind: 'ResumeTask', decision: 'approve' }), {
        commandType: TaskParkingCommands.RESUME_TASK,
        payload: { decision: 'approve' },
    });

    for (const cmd of [
        { kind: 'ResumeTask', decision: 'approve' },
        { kind: 'ResumeTask', decision: 'reject' },
        { kind: 'ResumeTask', decision: 'reject', feedback: 'x' },
        { kind: 'ResumeTask', decision: 'approve', answer: 'y' },
        { kind: 'SkipTask' },
        { kind: 'RetryTask' },
    ] as const) {
        const m = mapSlashCommand(cmd);
        assert.ok(m, `${cmd.kind} must map to a bus command`);
        assert.ok(
            registered.has(m!.commandType),
            `${m!.commandType} must have a registered handler`,
        );
    }
});

// ---------------------------------------------------------------------------
// readTelegramEnv — canonical token first, deprecated V2 fallback
// ---------------------------------------------------------------------------

test('readTelegramEnv resolves TELEGRAM_BOT_TOKEN first, then falls back to _V2', () => {
    const saved = {
        canonical: process.env.TELEGRAM_BOT_TOKEN,
        v2: process.env.TELEGRAM_BOT_TOKEN_V2,
        ids: process.env.TELEGRAM_ALLOWED_USER_IDS,
    };
    try {
        // Canonical present → canonical wins even when the fallback is set.
        process.env.TELEGRAM_BOT_TOKEN = 'canonical-token';
        process.env.TELEGRAM_BOT_TOKEN_V2 = 'legacy-token';
        assert.equal(readTelegramEnv().token, 'canonical-token');

        // Canonical unset (or whitespace-only) → fall back to the V2 key.
        process.env.TELEGRAM_BOT_TOKEN = '   ';
        assert.equal(readTelegramEnv().token, 'legacy-token');

        // Neither set → undefined (gateway becomes a no-op).
        delete process.env.TELEGRAM_BOT_TOKEN;
        delete process.env.TELEGRAM_BOT_TOKEN_V2;
        assert.equal(readTelegramEnv().token, undefined);
    } finally {
        restoreEnv('TELEGRAM_BOT_TOKEN', saved.canonical);
        restoreEnv('TELEGRAM_BOT_TOKEN_V2', saved.v2);
        restoreEnv('TELEGRAM_ALLOWED_USER_IDS', saved.ids);
    }
});

test('readTelegramEnv parses the allow-list through the hardened deny-by-default parser', () => {
    const saved = process.env.TELEGRAM_ALLOWED_USER_IDS;
    try {
        // Garbage tokens are dropped (not coerced), valid ids are kept.
        process.env.TELEGRAM_ALLOWED_USER_IDS = '42, notanid, 43';
        assert.deepEqual([...readTelegramEnv().allowedUserIds].sort(), [42, 43]);

        // Unset → deny-all resolves to an empty id list.
        delete process.env.TELEGRAM_ALLOWED_USER_IDS;
        assert.deepEqual(readTelegramEnv().allowedUserIds, []);
    } finally {
        restoreEnv('TELEGRAM_ALLOWED_USER_IDS', saved);
    }
});

function restoreEnv(key: string, value: string | undefined): void {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
}

// ---------------------------------------------------------------------------
// P-CPTO-010 — free text routes through the shared chat service, and only a
// Confirm tap dispatches the underlying command (propose-then-confirm)
// ---------------------------------------------------------------------------

interface FakeChatService {
    readonly service: TelegramChatService;
    readonly calls: RunTurnArgs[];
}

/**
 * A ChatService stand-in whose `runTurn` records its args and returns the given
 * proposals + reply body. `throwErr` makes the turn reject so the fallback path
 * can be exercised.
 */
function makeFakeChatService(opts: {
    proposals?: Proposal[];
    replyBody?: string;
    warnings?: string[];
    throwErr?: boolean;
    errMessage?: string;
}): FakeChatService {
    const calls: RunTurnArgs[] = [];
    const service: TelegramChatService = {
        async runTurn(args: RunTurnArgs): Promise<ChatTurnResult> {
            calls.push(args);
            if (opts.throwErr) throw new Error(opts.errMessage ?? 'chat service down');
            const result = {
                channelId: args.channelId,
                session: { id: args.channelId, projectId: 'proj' },
                reply: { id: 'm1', role: 'assistant', body: opts.replyBody ?? '' },
                proposals: opts.proposals ?? [],
                warnings: opts.warnings ?? [],
            };
            return result as unknown as ChatTurnResult;
        },
    };
    return { service, calls };
}

const SEED: ChannelSessionSeed = { projectId: 'proj-1', cwd: 'C:/repo/pinned' };

const TASK_PROPOSAL: Proposal = {
    kind: 'task',
    title: 'Add a healthcheck',
    type: 'implement',
    description: 'Expose /health returning 200.',
};

interface RecordedConfirm {
    readonly proposal: Proposal;
    readonly ctx: ConfirmedProposalContext;
}

/** Extract the Confirm button's callback_data from the sent proposal keyboard. */
function confirmDataFromSent(api: FakeTelegramApi): string | undefined {
    for (const m of api.sent) {
        const buttons = m.reply_markup?.inline_keyboard?.flat() ?? [];
        const confirm = buttons.find((b) => b.text === 'Confirm');
        if (confirm) return confirm.callback_data;
    }
    return undefined;
}

test('parsePendingCallback maps only the chat-confirm/chat-dismiss verbs', () => {
    assert.deepEqual(parsePendingCallback('chat-confirm:7'), { verb: 'confirm', id: '7' });
    assert.deepEqual(parsePendingCallback('chat-dismiss:7'), { verb: 'dismiss', id: '7' });
    assert.equal(parsePendingCallback('approve:t1:flow'), undefined);
    assert.equal(parsePendingCallback('chat-confirm:'), undefined);
    assert.equal(parsePendingCallback(''), undefined);
    assert.equal(parsePendingCallback(undefined), undefined);
});

test('renderProposalPrompt summarises each proposal kind', () => {
    assert.match(renderProposalPrompt(TASK_PROPOSAL), /Add a healthcheck/);
    assert.match(
        renderProposalPrompt({ kind: 'action', action: 'merge', taskId: 't-9' }),
        /merge on task t-9/,
    );
});

test('AC1/AC2: free text runs one chat-service turn and renders a Confirm/Dismiss keyboard without dispatching', async () => {
    const db = makeDb();
    const eventBus = makeBus(db);
    const { bus: commandBus, sent: sentCommands } = makeRecordingCommandBus(eventBus);
    const api = new FakeTelegramApi([
        [textUpdate({ updateId: 1, userId: 42, chatId: 42, text: 'add a healthcheck endpoint' })],
    ]);
    const chat = makeFakeChatService({ proposals: [TASK_PROPOSAL], replyBody: "Here's a plan." });
    const confirmed: RecordedConfirm[] = [];

    const gateway = new TelegramGateway({
        bus: eventBus,
        commandBus,
        db,
        logger: new SilentLogger(),
        clock: (): number => 1_700_000_000_000,
        envProvider: () => ({ token: 'tok', allowedUserIds: [42] }),
        apiFactory: () => api,
        chatService: chat.service,
        chatSessionSeed: () => SEED,
        confirmProposal: async (proposal, ctx): Promise<ProposalConfirmOutcome> => {
            confirmed.push({ proposal, ctx });
            return { dispatched: true, reply: 'Task created ✓' };
        },
    });

    await gateway.pollOnce();

    // The turn ran on channel telegram:42 with the operator's message + seed.
    assert.equal(chat.calls.length, 1);
    assert.equal(chat.calls[0].channelId, 'telegram:42');
    assert.equal(chat.calls[0].content, 'add a healthcheck endpoint');
    assert.deepEqual(chat.calls[0].seed, SEED);

    // The assistant reply and a Confirm/Dismiss keyboard were sent; NO command
    // was dispatched and the confirmer was NOT invoked by the free-text turn.
    const confirmData = confirmDataFromSent(api);
    assert.ok(confirmData, 'a Confirm keyboard was rendered');
    assert.equal(confirmData, 'chat-confirm:1', 'first proposal gets id 1');
    assert.ok(api.sent.some((m) => m.text.includes("Here's a plan.")), 'reply relayed');
    assert.equal(sentCommands.length, 0, 'the free-text turn dispatches no command');
    assert.equal(confirmed.length, 0, 'the confirmer is not called from the free-text turn');
});

test('AC2: tapping Confirm dispatches the proposal via the confirmer exactly once', async () => {
    const db = makeDb();
    const eventBus = makeBus(db);
    const { bus: commandBus } = makeRecordingCommandBus(eventBus);
    const api = new FakeTelegramApi([
        [textUpdate({ updateId: 1, userId: 42, chatId: 42, text: 'add a healthcheck' })],
        [callbackUpdate(2, 42, 'chat-confirm:1')],
        // A second Confirm on the now-consumed proposal must be surfaced, not
        // re-dispatched.
        [callbackUpdate(3, 42, 'chat-confirm:1')],
    ]);
    const chat = makeFakeChatService({ proposals: [TASK_PROPOSAL] });
    const confirmed: RecordedConfirm[] = [];

    const gateway = new TelegramGateway({
        bus: eventBus,
        commandBus,
        db,
        logger: new SilentLogger(),
        clock: (): number => 1_700_000_000_000,
        envProvider: () => ({ token: 'tok', allowedUserIds: [42] }),
        apiFactory: () => api,
        chatService: chat.service,
        chatSessionSeed: () => SEED,
        confirmProposal: async (proposal, ctx): Promise<ProposalConfirmOutcome> => {
            confirmed.push({ proposal, ctx });
            return { dispatched: true, reply: 'Task created ✓' };
        },
    });

    await gateway.pollOnce(); // free text → store proposal + keyboard
    await gateway.pollOnce(); // Confirm tap → dispatch
    await gateway.pollOnce(); // Confirm again → expired

    assert.equal(confirmed.length, 1, 'Confirm dispatches exactly once');
    assert.deepEqual(confirmed[0].proposal, TASK_PROPOSAL);
    // projectId rides along so a confirmed task proposal can be filed as a
    // plan without a project picker Telegram doesn't have.
    assert.deepEqual(confirmed[0].ctx, {
        chatId: 42,
        userId: 42,
        projectId: SEED.projectId,
    });
    assert.ok(api.sent.some((m) => m.text === 'Task created ✓'), 'confirm reply sent');
    assert.ok(
        api.sent.some((m) => m.text === PROPOSAL_EXPIRED_TEXT),
        'a second Confirm on the consumed proposal is surfaced, not re-dispatched',
    );
    // Both callbacks were acknowledged so the operator's spinner clears.
    assert.deepEqual(api.acknowledged, ['cb-2', 'cb-3']);
});

test('AC2: tapping Dismiss discards the proposal and never dispatches', async () => {
    const db = makeDb();
    const eventBus = makeBus(db);
    const { bus: commandBus } = makeRecordingCommandBus(eventBus);
    const api = new FakeTelegramApi([
        [textUpdate({ updateId: 1, userId: 42, chatId: 42, text: 'add a healthcheck' })],
        [callbackUpdate(2, 42, 'chat-dismiss:1')],
    ]);
    const chat = makeFakeChatService({ proposals: [TASK_PROPOSAL] });
    const confirmed: RecordedConfirm[] = [];

    const gateway = new TelegramGateway({
        bus: eventBus,
        commandBus,
        db,
        logger: new SilentLogger(),
        envProvider: () => ({ token: 'tok', allowedUserIds: [42] }),
        apiFactory: () => api,
        chatService: chat.service,
        chatSessionSeed: () => SEED,
        confirmProposal: async (proposal, ctx): Promise<ProposalConfirmOutcome> => {
            confirmed.push({ proposal, ctx });
            return { dispatched: true, reply: 'nope' };
        },
    });

    await gateway.pollOnce();
    await gateway.pollOnce();

    assert.equal(confirmed.length, 0, 'Dismiss never dispatches');
    assert.ok(api.sent.some((m) => m.text === PROPOSAL_DISMISSED_TEXT), 'dismiss acknowledged');
});

test('AC2: a Confirm tap with no confirmer seam is surfaced, never silently dropped', async () => {
    const db = makeDb();
    const eventBus = makeBus(db);
    const { bus: commandBus } = makeRecordingCommandBus(eventBus);
    const api = new FakeTelegramApi([
        [textUpdate({ updateId: 1, userId: 42, chatId: 42, text: 'add a healthcheck' })],
        [callbackUpdate(2, 42, 'chat-confirm:1')],
    ]);
    const chat = makeFakeChatService({ proposals: [TASK_PROPOSAL] });

    const gateway = new TelegramGateway({
        bus: eventBus,
        commandBus,
        db,
        logger: new SilentLogger(),
        envProvider: () => ({ token: 'tok', allowedUserIds: [42] }),
        apiFactory: () => api,
        chatService: chat.service,
        chatSessionSeed: () => SEED,
        // No confirmProposal seam wired.
    });

    await gateway.pollOnce();
    await gateway.pollOnce();

    assert.ok(
        api.sent.some((m) => m.text === PROPOSAL_CONFIRM_UNAVAILABLE_TEXT),
        'the operator is told confirmation is unavailable',
    );
});

// ---------------------------------------------------------------------------
// AC3 — degraded fallback to the chat-intents classifier
// ---------------------------------------------------------------------------

test('AC3: when the chat service turn throws, free text degrades to the classifier', async () => {
    const { router, state } = makeFakeRouter();
    const db = makeDb();
    const eventBus = makeBus(db);
    const { bus: commandBus } = makeRecordingCommandBus(eventBus);
    const api = new FakeTelegramApi([
        [textUpdate({ updateId: 1, userId: 42, chatId: 99, text: 'restart it' })],
    ]);
    const chat = makeFakeChatService({ throwErr: true });

    const gateway = new TelegramGateway({
        bus: eventBus,
        commandBus,
        db,
        logger: new SilentLogger(),
        envProvider: () => ({ token: 'tok', allowedUserIds: [42] }),
        apiFactory: () => api,
        chatService: chat.service,
        chatSessionSeed: () => SEED,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        chatRouter: router as any,
    });

    await gateway.pollOnce();

    assert.equal(chat.calls.length, 1, 'the chat service was attempted first');
    assert.equal(state.routed.length, 1, 'then the classifier handled the message');
    assert.equal(state.routed[0].text, 'restart it');
    assert.ok(
        !api.sent.some((m) => m.reply_markup),
        'a failed chat turn renders no proposal keyboard',
    );
});

test('AC3: chat service without a pinned cwd seed degrades to the classifier', async () => {
    const { router, state } = makeFakeRouter();
    const db = makeDb();
    const eventBus = makeBus(db);
    const { bus: commandBus } = makeRecordingCommandBus(eventBus);
    const api = new FakeTelegramApi([
        [textUpdate({ updateId: 1, userId: 42, chatId: 99, text: 'status?' })],
    ]);
    const chat = makeFakeChatService({ proposals: [TASK_PROPOSAL] });

    const gateway = new TelegramGateway({
        bus: eventBus,
        commandBus,
        db,
        logger: new SilentLogger(),
        envProvider: () => ({ token: 'tok', allowedUserIds: [42] }),
        apiFactory: () => api,
        chatService: chat.service,
        chatSessionSeed: () => undefined, // no pinned repo → cannot start a turn
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        chatRouter: router as any,
    });

    await gateway.pollOnce();

    assert.equal(chat.calls.length, 0, 'no turn runs without a pinned cwd');
    assert.equal(state.routed.length, 1, 'the classifier handled the message instead');
});

test('AC3: with neither chat service nor classifier wired, free text is surfaced not dropped', async () => {
    const db = makeDb();
    const eventBus = makeBus(db);
    const { bus: commandBus } = makeRecordingCommandBus(eventBus);
    const api = new FakeTelegramApi([
        [textUpdate({ updateId: 1, userId: 42, chatId: 99, text: 'hello?' })],
    ]);

    const gateway = new TelegramGateway({
        bus: eventBus,
        commandBus,
        db,
        logger: new SilentLogger(),
        envProvider: () => ({ token: 'tok', allowedUserIds: [42] }),
        apiFactory: () => api,
    });

    await gateway.pollOnce();

    assert.equal(api.sent.length, 1, 'the message is answered, not dropped');
    assert.equal(api.sent[0].text, CHAT_UNAVAILABLE_TEXT);
});

test('a chat turn is ACKNOWLEDGED before the agent runs', async () => {
    // Field report: asking the bot to investigate something showed nothing
    // at all until the agent finished (minutes), so the operator could not
    // tell whether the message had even been received.
    const db = makeDb();
    const eventBus = makeBus(db);
    const { bus: commandBus } = makeRecordingCommandBus(eventBus);
    const api = new FakeTelegramApi([
        [textUpdate({ updateId: 1, userId: 42, chatId: 42, text: 'why does the build fail?' })],
    ]);
    // Records how many messages were already sent when the turn started.
    let sentWhenTurnStarted = -1;
    const chat = makeFakeChatService({ replyBody: 'Because of X.' });
    const wrapped: TelegramChatService = {
        runTurn: async (args) => {
            sentWhenTurnStarted = api.sent.length;
            return chat.service.runTurn(args);
        },
    };

    const gateway = new TelegramGateway({
        bus: eventBus,
        commandBus,
        db,
        logger: new SilentLogger(),
        clock: (): number => 1_700_000_000_000,
        envProvider: () => ({ token: 'tok', allowedUserIds: [42] }),
        apiFactory: () => api,
        chatService: wrapped,
        chatSessionSeed: () => SEED,
    });

    await gateway.pollOnce();

    assert.equal(sentWhenTurnStarted, 1, 'exactly one message (the ack) precedes the turn');
    const ack = api.sent[0]!;
    assert.match(ack.text, /On it/, 'ack tells the operator work started');
    assert.match(ack.text, new RegExp(SEED.repoId ?? 'workspace'), 'ack names the context');
    assert.ok(
        api.sent.some((m) => m.text.includes('Because of X.')),
        'the real answer still arrives afterwards',
    );
});

test('confirming a task proposal carries the projectId to the confirmer', async () => {
    // Field report: the Telegram agent proposed a plan, but tapping Confirm
    // replied "only from the board". The confirmer can only file the plan if
    // it knows which project the raising turn ran against — Telegram has no
    // project picker, so the seed's projectId rides with the stored proposal.
    const db = makeDb();
    const eventBus = makeBus(db);
    const { bus: commandBus } = makeRecordingCommandBus(eventBus);
    const api = new FakeTelegramApi([
        [textUpdate({ updateId: 1, userId: 42, chatId: 42, text: 'add a healthcheck endpoint' })],
        [callbackUpdate(2, 42, 'chat-confirm:1')],
    ]);
    const chat = makeFakeChatService({ proposals: [TASK_PROPOSAL], replyBody: 'Proposing.' });
    const seen: ConfirmedProposalContext[] = [];

    const gateway = new TelegramGateway({
        bus: eventBus,
        commandBus,
        db,
        logger: new SilentLogger(),
        clock: (): number => 1_700_000_000_000,
        envProvider: () => ({ token: 'tok', allowedUserIds: [42] }),
        apiFactory: () => api,
        chatService: chat.service,
        chatSessionSeed: () => SEED,
        confirmProposal: async (_p, ctx): Promise<ProposalConfirmOutcome> => {
            seen.push(ctx);
            return { dispatched: true, reply: 'Plan created ✓' };
        },
    });

    await gateway.pollOnce(); // free text -> proposal + keyboard
    await gateway.pollOnce(); // Confirm tap -> confirmer

    assert.equal(seen.length, 1, 'the confirmer ran exactly once');
    assert.equal(
        seen[0]!.projectId,
        SEED.projectId,
        "the raising turn's project must reach the confirmer so the plan can be filed",
    );
    assert.ok(api.sent.some((m) => m.text.includes('Plan created')), 'outcome relayed');
});

// ---------------------------------------------------------------------------
// Clarification questions reach Telegram, and can be answered there
//
// Field report: "the question showed on the board, but I got no Telegram
// message". `onTaskParked` skips reason==='clarification' on the belief
// that the AgentQuestion subscriber covers it — but the runner's
// AgentQuestion payload carries `agentId`, never `taskId`, so that
// handler returned early every time. The event that actually carries the
// question is `ClarificationRequested`, which nothing listened for.
// ---------------------------------------------------------------------------

function makeTasksTable(db: Db): void {
    db.exec(`
        CREATE TABLE tasks (
            id             TEXT PRIMARY KEY,
            title          TEXT,
            plan_id        TEXT,
            type           TEXT,
            description    TEXT,
            ticket_details TEXT,
            parked_choices TEXT
        );
    `);
}

function registerResume(h: Harness): Command[] {
    const seen: Command[] = [];
    h.commandBus.register(TaskParkingCommands.RESUME_TASK, async (cmd) => {
        seen.push(cmd);
        return [];
    });
    return seen;
}

const CLARIFY_ENV: TelegramEnv = {
    token: 'tok',
    allowedUserIds: [42],
} as TelegramEnv;

test('ClarificationRequested ships the question, its options, and BOTH answer routes', async () => {
    const h = makeHarness({ env: CLARIFY_ENV });
    makeTasksTable(h.db);
    h.db.prepare("INSERT INTO tasks(id, title) VALUES ('T-1', 'Bump handler')").run();
    h.gateway.start();
    try {
        await publishStored(h.eventBus, TelegramOutboundEvents.CLARIFICATION_REQUESTED, {
            taskId: 'T-1',
            question: 'The ticket says bump the version, but it is already current — bump anyway?',
            choices: ['Bump it anyway', 'Leave the version alone'],
        });

        assert.equal(h.api.sent.length, 1, 'the operator must hear about the question');
        const msg = h.api.sent[0]!;
        assert.match(msg.text, /Agent question/);
        assert.match(msg.text, /bump anyway\?/);
        assert.match(msg.text, /A\) Bump it anyway/);
        assert.match(msg.text, /B\) Leave the version alone/);
        assert.match(msg.text, /Tap an option below, or reply/);

        const keyboard = msg.reply_markup?.inline_keyboard ?? [];
        assert.equal(keyboard.length, 2, 'one button per option');
        assert.equal(keyboard[0]![0]!.callback_data, 'clarify:T-1:0');
        assert.equal(keyboard[1]![0]!.callback_data, 'clarify:T-1:1');
    } finally {
        h.gateway.stop();
    }
});

test('a question with no options asks for a reply and shows no buttons', async () => {
    const h = makeHarness({ env: CLARIFY_ENV });
    makeTasksTable(h.db);
    h.gateway.start();
    try {
        await publishStored(h.eventBus, TelegramOutboundEvents.CLARIFICATION_REQUESTED, {
            taskId: 'T-2',
            question: 'Which storage account should this target?',
            choices: [],
        });
        const msg = h.api.sent[0]!;
        assert.match(msg.text, /Reply to this message to answer\./);
        assert.equal(msg.reply_markup, undefined);
    } finally {
        h.gateway.stop();
    }
});

test('tapping an option resumes the task with the option TEXT, not its index', async () => {
    // The pipeline stores the answer verbatim and shows it to every later
    // agent. "1" would be worse than useless in a reviewer's prompt.
    const h = makeHarness({
        env: CLARIFY_ENV,
        batches: [[callbackUpdate(1, 42, 'clarify:T-1:1')]],
    });
    makeTasksTable(h.db);
    h.db.prepare(
        `INSERT INTO tasks(id, title, parked_choices)
         VALUES ('T-1', 'Bump handler', ?)`,
    ).run(JSON.stringify(['Bump it anyway', 'Leave the version alone']));
    const resumes = registerResume(h);

    await h.gateway.pollOnce();

    assert.equal(resumes.length, 1, 'the tap must dispatch an answer');
    assert.deepEqual(resumes[0]!.payload, {
        taskId: 'T-1',
        decision: 'approve',
        answer: 'Leave the version alone',
        optionKey: 'B',
    });
    assert.ok(
        h.api.sent.some((m) => /Answered B\) Leave the version alone/.test(m.text)),
        'the operator must see which answer landed',
    );
});

test('tapping an option on an already-answered task says so instead of resuming blank', async () => {
    const h = makeHarness({
        env: CLARIFY_ENV,
        batches: [[callbackUpdate(1, 42, 'clarify:T-1:0')]],
    });
    makeTasksTable(h.db);
    // Parked choices cleared — the task was answered on the board.
    h.db.prepare("INSERT INTO tasks(id, title) VALUES ('T-1', 'Bump handler')").run();
    const resumes = registerResume(h);

    await h.gateway.pollOnce();

    assert.equal(resumes.length, 0, 'never resume a task with an empty answer');
    assert.ok(
        h.api.sent.some((m) => /No pending question for T-1/.test(m.text)),
        'silence would read as a dead button',
    );
});

test('parseClarifyCallback rejects anything that is not a clarify tap', () => {
    assert.deepEqual(parseClarifyCallback('clarify:T-1:2'), { taskId: 'T-1', index: 2 });
    assert.equal(parseClarifyCallback('clarify:T-1'), undefined);
    assert.equal(parseClarifyCallback('clarify::0'), undefined);
    assert.equal(parseClarifyCallback('clarify:T-1:x'), undefined);
    assert.equal(parseClarifyCallback('clarify:T-1:-1'), undefined);
    assert.equal(parseClarifyCallback('approve:T-1:flow'), undefined);
    assert.equal(parseClarifyCallback(undefined), undefined);
});

/**
 * Field report: "I asked the telegram agent to do an investigation and it
 * replied it can't process free-text chat — I thought we added that."
 *
 * We had, a month earlier. What actually happened was that the operator's
 * Claude CLI credentials had expired, so the agent could not spawn, the
 * turn threw, and the caller turned every failure into one message:
 * "chat isn't configured on this bot". That sentence is true for exactly
 * one of the four outcomes and a lie for the rest — it sent the operator
 * looking for missing code instead of an expired token.
 */
test('an expired credential says SO, instead of blaming the configuration', async () => {
    const db = makeDb();
    const eventBus = makeBus(db);
    const { bus: commandBus } = makeRecordingCommandBus(eventBus);
    const api = new FakeTelegramApi([
        [textUpdate({ updateId: 1, userId: 42, chatId: 99, text: 'investigate the login bug' })],
    ]);
    const chat = makeFakeChatService({
        throwErr: true,
        errMessage: 'spawn failed: OAuth token expired',
    });

    const gateway = new TelegramGateway({
        bus: eventBus,
        commandBus,
        db,
        logger: new SilentLogger(),
        envProvider: () => ({ token: 'tok', allowedUserIds: [42] }),
        apiFactory: () => api,
        chatService: chat.service,
        chatSessionSeed: () => SEED,
    });

    await gateway.pollOnce();

    // Ack first, then the failure explanation.
    const last = api.sent[api.sent.length - 1]!.text;
    assert.match(last, /authentication|OAuth token expired/i);
    assert.match(last, /Re-authenticate the Claude CLI/);
    // The misleading sentence must NOT appear.
    assert.doesNotMatch(last, /chat isn't configured/);
});

test('the auth state seam catches an expiry the error text does not name', async () => {
    // A spawn can fail with an unhelpful message ("exit code 1") while the
    // credentials file plainly says expired. The seam is what turns that
    // into an actionable reply rather than a raw errno.
    const db = makeDb();
    const eventBus = makeBus(db);
    const { bus: commandBus } = makeRecordingCommandBus(eventBus);
    const api = new FakeTelegramApi([
        [textUpdate({ updateId: 1, userId: 42, chatId: 99, text: 'hello?' })],
    ]);
    const chat = makeFakeChatService({ throwErr: true, errMessage: 'exit code 1' });

    const gateway = new TelegramGateway({
        bus: eventBus,
        commandBus,
        db,
        logger: new SilentLogger(),
        envProvider: () => ({ token: 'tok', allowedUserIds: [42] }),
        apiFactory: () => api,
        chatService: chat.service,
        chatSessionSeed: () => SEED,
        agentAuthState: () => 'expired',
    });

    await gateway.pollOnce();

    assert.match(api.sent[api.sent.length - 1]!.text, /Re-authenticate the Claude CLI/);
});

test('a non-auth failure reports the ACTUAL error', async () => {
    // A generic apology leaves the operator with nothing to act on or
    // report — which is how a working feature got mistaken for a missing one.
    const db = makeDb();
    const eventBus = makeBus(db);
    const { bus: commandBus } = makeRecordingCommandBus(eventBus);
    const api = new FakeTelegramApi([
        [textUpdate({ updateId: 1, userId: 42, chatId: 99, text: 'hello?' })],
    ]);
    const chat = makeFakeChatService({ throwErr: true, errMessage: 'ENOENT: no such worktree' });

    const gateway = new TelegramGateway({
        bus: eventBus,
        commandBus,
        db,
        logger: new SilentLogger(),
        envProvider: () => ({ token: 'tok', allowedUserIds: [42] }),
        apiFactory: () => api,
        chatService: chat.service,
        chatSessionSeed: () => SEED,
        agentAuthState: () => 'ok',
    });

    await gateway.pollOnce();

    const last = api.sent[api.sent.length - 1]!.text;
    assert.match(last, /ENOENT: no such worktree/);
    assert.doesNotMatch(last, /chat isn't configured/);
});

test('a genuinely unconfigured bot still gets the original message', async () => {
    // The one case the old wording actually fit must keep it.
    const db = makeDb();
    const eventBus = makeBus(db);
    const { bus: commandBus } = makeRecordingCommandBus(eventBus);
    const api = new FakeTelegramApi([
        [textUpdate({ updateId: 1, userId: 42, chatId: 99, text: 'hello?' })],
    ]);

    const gateway = new TelegramGateway({
        bus: eventBus,
        commandBus,
        db,
        logger: new SilentLogger(),
        envProvider: () => ({ token: 'tok', allowedUserIds: [42] }),
        apiFactory: () => api,
    });

    await gateway.pollOnce();

    assert.equal(api.sent[api.sent.length - 1]!.text, CHAT_UNAVAILABLE_TEXT);
});

test('chat wired but no resolvable repo asks for one instead of claiming misconfiguration', async () => {
    // The operator can fix this themselves in one message, so the reply
    // has to say which message to send.
    const db = makeDb();
    const eventBus = makeBus(db);
    const { bus: commandBus } = makeRecordingCommandBus(eventBus);
    const api = new FakeTelegramApi([
        [textUpdate({ updateId: 1, userId: 42, chatId: 99, text: 'hello?' })],
    ]);
    const chat = makeFakeChatService({});

    const gateway = new TelegramGateway({
        bus: eventBus,
        commandBus,
        db,
        logger: new SilentLogger(),
        envProvider: () => ({ token: 'tok', allowedUserIds: [42] }),
        apiFactory: () => api,
        chatService: chat.service,
        // No seed and no resolver — the un-pinned, un-resolvable case.
    });

    await gateway.pollOnce();

    const last = api.sent[api.sent.length - 1]!.text;
    assert.equal(last, CHAT_NO_REPO_TEXT);
    assert.match(last, /use <repo>/);
});
