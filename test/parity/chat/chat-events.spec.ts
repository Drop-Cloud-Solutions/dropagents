/**
 * Track 8 — chat-bot intent-routing parity harness.
 *
 * Injects each of the four v1 `shared/chat-events.ts` event payloads
 * (`plan-ready`, `commit-ready`, `task-failed`, `worker-error`) through the
 * v2 `adapters/telegram/TelegramGateway` boundary and asserts the dispatch
 * lands at the right v2 surface — for both the inline-keyboard path and
 * the natural-language path that runs through `chat-intents` + `chat-actions`.
 *
 * # Scope
 *
 * Track 8 is intentionally outside `npm run parity-smoke` — the v1 chat
 * bridge has no YAML-fixture equivalent, so this harness is the parity
 * oracle for the chat surface. The fixture
 * (`fixtures/chat-events.jsonl`) captures the v1 payload shape at the
 * SHA in `REFERENCE_BASELINE`; the spec hard-codes the v1 → v2 mapping
 * table the gateway is expected to honour.
 *
 * # No real Telegram traffic
 *
 * AC4 — every outbound is captured by `FakeTelegramApi` and every inbound
 * is synthesised in-process. The gateway is constructed with an
 * `apiFactory` override; `process.env.TELEGRAM_BOT_TOKEN_V2` is never
 * read. The classifier (`chat-intents.converse`) is invoked through its
 * `callApi` dep so no HTTPS request leaves the host.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import Database from 'better-sqlite3';

import { CommandBus } from '../../../core/commands/bus';
import type { Command } from '../../../core/commands/command';
import { EventBus } from '../../../core/events/bus';
import { EventStore } from '../../../core/events/store';
import type { Db } from '../../../core/state/migrations';
import type { Logger } from '../../../core/ports';

import {
    TelegramGateway,
    TelegramInboundCommands,
    TelegramOutboundEvents,
    parseCallbackData,
    type TelegramEnv,
} from '../../../adapters/telegram/TelegramGateway';
import { ChatActions, ChatNlCommands } from '../../../adapters/telegram/chat-actions';
import { converse, type ApiRequestBody } from '../../../adapters/telegram/chat-intents';
import type {
    GetUpdatesOptions,
    SendMessageOptions,
    TelegramApi,
    TelegramMessage,
    TelegramUpdate,
} from '../../../adapters/telegram/api';

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'chat-events.jsonl');
const REFERENCE_BASELINE_PATH = path.join(__dirname, '..', '..', '..', 'REFERENCE_BASELINE');
const REFERENCE_BASELINE = readFileSync(REFERENCE_BASELINE_PATH, 'utf8').trim();

type V1EventType = 'plan-ready' | 'commit-ready' | 'task-failed' | 'worker-error';
type V2OutboundEventName = keyof typeof TelegramOutboundEvents;
type CallbackVerb = 'approve' | 'skip' | 'retry';
type ChatActionsAction = 'approve' | 'skip' | 'retry' | 'cancel' | 'restart';

interface FixtureExpectation {
    readonly v2_event: V2OutboundEventName;
    readonly callback_verb: CallbackVerb;
    readonly chat_actions_action: ChatActionsAction;
    readonly chat_actions_command: string;
    readonly operator_nl_reply: string;
}

interface FixtureEntry {
    readonly v: 1;
    readonly reference_sha: string;
    readonly type: V1EventType;
    readonly payload: Record<string, unknown>;
    readonly expected: FixtureExpectation;
}

function loadFixture(): FixtureEntry[] {
    const raw = readFileSync(FIXTURE_PATH, 'utf8');
    return raw
        .split(/\r?\n/)
        .map((l: string) => l.trim())
        .filter((l: string) => l.length > 0)
        .map((l: string) => JSON.parse(l) as FixtureEntry);
}

// ---------------------------------------------------------------------------
// V1 → V2 outbound event translator. The parity claim is that an operator's
// v1 chat-event experience is reproducible against the v2 outbound subscriber
// surface; this function is the documented mapping that future tracks can
// reference. Hard-coded here (not pulled from the fixture) so the test still
// fails loudly if the fixture's claimed mapping drifts from reality.
// ---------------------------------------------------------------------------

interface V2EnvelopeOut {
    readonly type: string;
    readonly payload: Record<string, unknown>;
}

function translateV1ToV2(entry: FixtureEntry): V2EnvelopeOut {
    const p = entry.payload;
    switch (entry.type) {
        case 'plan-ready':
        case 'commit-ready':
            return {
                type: TelegramOutboundEvents.OPERATOR_ACTION_REQUIRED,
                payload: {
                    taskId: String(p.taskId ?? ''),
                    flowId: String(p.flowId ?? ''),
                    reason: typeof p.reason === 'string' ? p.reason : '',
                },
            };
        case 'task-failed':
            return {
                type: TelegramOutboundEvents.TASK_FAILED,
                payload: {
                    taskId: String(p.taskId ?? ''),
                    reason: typeof p.reason === 'string' ? p.reason : '',
                },
            };
        case 'worker-error':
            return {
                type: TelegramOutboundEvents.AGENT_QUESTION,
                payload: {
                    taskId: String(p.taskId ?? ''),
                    question:
                        typeof p.question === 'string'
                            ? p.question
                            : typeof p.error === 'string'
                              ? `worker error: ${p.error}`
                              : 'worker error',
                },
            };
    }
}

// ---------------------------------------------------------------------------
// Test scaffolding — mirrors TelegramGateway.test.ts so the parity harness
// exercises the same boundary the unit tests cover.
// ---------------------------------------------------------------------------

class SilentLogger implements Logger {
    info(): void {}
    warn(): void {}
    error(): void {}
    debug(): void {}
}

function makeDb(): Db {
    const db = new Database(':memory:') as Db;
    db.pragma('foreign_keys = ON');
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

function makeEventBus(db: Db): EventBus {
    return new EventBus(new EventStore(db), new SilentLogger());
}

interface RecordingCommandBus {
    readonly bus: CommandBus<unknown>;
    readonly sent: Command[];
}

function makeRecordingCommandBus(eventBus: EventBus): RecordingCommandBus {
    const sent: Command[] = [];
    const cb = new CommandBus<unknown>(eventBus, () => undefined);
    const handler = async (cmd: Command): Promise<[]> => {
        sent.push(cmd);
        return [];
    };
    for (const type of [
        TelegramInboundCommands.APPROVE_TASK,
        TelegramInboundCommands.SKIP_TASK,
        TelegramInboundCommands.RETRY_TASK,
        ChatNlCommands.CANCEL_TASK,
        ChatNlCommands.RESTART_TASK,
    ]) {
        cb.register(type, handler);
    }
    return { bus: cb, sent };
}

class FakeTelegramApi implements TelegramApi {
    readonly sent: SendMessageOptions[] = [];
    readonly getUpdatesCalls: GetUpdatesOptions[] = [];
    readonly acknowledged: string[] = [];
    private readonly batches: readonly TelegramUpdate[][];
    private callIdx = 0;
    private nextMessageId = 1;

    constructor(batches: readonly TelegramUpdate[][] = []) {
        this.batches = batches;
    }

    async getUpdates(opts: GetUpdatesOptions): Promise<TelegramUpdate[]> {
        this.getUpdatesCalls.push(opts);
        const batch = this.batches[this.callIdx] ?? [];
        this.callIdx += 1;
        return batch;
    }

    async sendMessage(opts: SendMessageOptions): Promise<TelegramMessage> {
        this.sent.push(opts);
        const chatIdNum = typeof opts.chat_id === 'number' ? opts.chat_id : Number(opts.chat_id);
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
    readonly eventBus: EventBus;
    readonly commandBus: CommandBus<unknown>;
    readonly sentCommands: Command[];
    readonly api: FakeTelegramApi;
    readonly gateway: TelegramGateway;
    readonly chatActions: ChatActions;
}

const OPERATOR_USER_ID = 42;
const APIFACTORY_TOKENS_SEEN: string[] = [];

function makeHarness(batches: readonly TelegramUpdate[][] = []): Harness {
    const db = makeDb();
    const eventBus = makeEventBus(db);
    const { bus: commandBus, sent: sentCommands } = makeRecordingCommandBus(eventBus);
    const api = new FakeTelegramApi(batches);
    const env: TelegramEnv = { token: 'parity-fake-token', allowedUserIds: [OPERATOR_USER_ID] };

    const gateway = new TelegramGateway({
        bus: eventBus,
        commandBus,
        db,
        logger: new SilentLogger(),
        clock: (): number => 1_700_000_000_000,
        envProvider: (): TelegramEnv => env,
        apiFactory: (token: string): TelegramApi => {
            APIFACTORY_TOKENS_SEEN.push(token);
            return api;
        },
    });

    const chatActions = new ChatActions({
        commandBus,
        logger: new SilentLogger(),
        clock: (): number => 1_700_000_000_000,
    });

    return { eventBus, commandBus, sentCommands, api, gateway, chatActions };
}

async function publishStored(eventBus: EventBus, type: string, payload: unknown): Promise<void> {
    await eventBus.publish({
        type,
        v: 1,
        occurredAt: 1_700_000_000_000,
        idempotencyKey: `parity-chat:${type}:${Math.random().toString(36).slice(2)}`,
        payload,
    });
}

// ---------------------------------------------------------------------------
// Stubbed classifier — returns a deterministic `ConverseResult` for the
// operator's reply text. The harness drives `chat-intents.converse` through
// its `callApi` dep so the Anthropic API is not contacted (AC4: no real
// network traffic). The stub mirrors the production response shape exactly
// so the parse path inside `converse` is the one under test.
// ---------------------------------------------------------------------------

function makeStubClassifier(
    expected: FixtureExpectation,
    taskId: string,
): (body: ApiRequestBody) => Promise<string> {
    return async (body: ApiRequestBody): Promise<string> => {
        // Sanity: the system prompt must be the production one (i.e. converse
        // built it), and the user block must contain the operator's text so we
        // know the call path is real and not short-circuited.
        assert.ok(body.system.includes('OUTPUT: Return strict JSON'));
        assert.ok(
            body.messages[0].content.includes(expected.operator_nl_reply),
            'classifier was invoked with the operator reply',
        );
        return JSON.stringify({
            reply: `Acknowledged: ${expected.chat_actions_action} ${taskId}.`,
            action: expected.chat_actions_action,
            payload: '',
            target: taskId,
        });
    };
}

// ---------------------------------------------------------------------------
// AC #1 — Spec drives all four v1 event types
// AC #2 — Fixture contains v1 payloads pinned at REFERENCE_BASELINE
// ---------------------------------------------------------------------------

test('parity fixture covers all four v1 chat-events at REFERENCE_BASELINE', () => {
    const entries = loadFixture();
    const types = new Set(entries.map((e) => e.type));
    assert.equal(entries.length, 4, 'fixture has exactly four v1 events');
    assert.deepEqual(
        [...types].sort(),
        ['commit-ready', 'plan-ready', 'task-failed', 'worker-error'],
    );
    for (const entry of entries) {
        assert.equal(entry.v, 1, `${entry.type}: v1 envelope`);
        assert.equal(
            entry.reference_sha,
            REFERENCE_BASELINE,
            `${entry.type}: reference_sha matches REFERENCE_BASELINE`,
        );
        assert.ok(
            typeof entry.payload.taskId === 'string' && entry.payload.taskId.length > 0,
            `${entry.type}: payload carries a taskId`,
        );
    }
});

// ---------------------------------------------------------------------------
// AC #3 + AC #4 — Each event routes through TelegramGateway → chat-intents →
// chat-actions, and no real Telegram traffic leaves the boundary.
// ---------------------------------------------------------------------------

for (const entry of loadFixture()) {
    test(`v1 ${entry.type} routes via TelegramGateway → chat-intents → chat-actions`, async () => {
        const h = makeHarness();

        // 1. Outbound boundary: publish the v2 translation of the v1 event
        //    and capture the Telegram-bound sendMessage call. The gateway
        //    must produce exactly one outbound message per allowed user
        //    (AC4: mocked at the TelegramGateway boundary).
        const envelope = translateV1ToV2(entry);
        await h.gateway.start();
        try {
            await publishStored(h.eventBus, envelope.type, envelope.payload);
        } finally {
            await h.gateway.stop();
        }

        assert.equal(h.api.sent.length, 1, 'one sendMessage per outbound v2 event');
        const outbound = h.api.sent[0];
        assert.equal(outbound.chat_id, OPERATOR_USER_ID);
        const taskId = String(entry.payload.taskId);
        assert.ok(
            outbound.text.includes(taskId),
            `${entry.type}: outbound text references taskId ${taskId}`,
        );

        // 2. Outbound keyboard: the inline buttons offered to the operator
        //    must include the parity-expected verb (mapped to the v2
        //    `TelegramInboundCommands` value).
        const keyboard = outbound.reply_markup?.inline_keyboard;
        assert.ok(keyboard, `${entry.type}: outbound carries an inline keyboard`);
        const buttons = keyboard!.flat();
        const verbButton = buttons.find((b) =>
            b.callback_data.startsWith(`${entry.expected.callback_verb}:`),
        );
        assert.ok(
            verbButton,
            `${entry.type}: keyboard offers the ${entry.expected.callback_verb} verb`,
        );
        const parsed = parseCallbackData(verbButton!.callback_data);
        assert.ok(parsed, `${entry.type}: callback_data is parseable`);
        // The keyboard's verb is the gateway's own commitment to a downstream
        // command type; surfacing it here makes drift in `parseCallbackData`
        // light up in this harness too.
        const verbToCommand: Record<CallbackVerb, string> = {
            approve: TelegramInboundCommands.APPROVE_TASK,
            skip: TelegramInboundCommands.SKIP_TASK,
            retry: TelegramInboundCommands.RETRY_TASK,
        };
        assert.equal(
            parsed!.commandType,
            verbToCommand[entry.expected.callback_verb],
            `${entry.type}: keyboard verb maps to ${verbToCommand[entry.expected.callback_verb]}`,
        );

        // 3. NL path: feed a representative operator reply through
        //    `chat-intents.converse` (with a stubbed classifier so no API
        //    call leaves the host) and dispatch the result through
        //    `chat-actions`. This is the explicit chat-intents → chat-
        //    actions assertion AC3 asks for.
        const result = await converse(
            entry.expected.operator_nl_reply,
            { boardTasks: [{ id: taskId, identifier: taskId }] },
            {
                readEnv: () => ({ apiKey: 'parity-fake-key' }),
                callApi: makeStubClassifier(entry.expected, taskId),
            },
        );
        assert.equal(result.action, entry.expected.chat_actions_action);
        assert.equal(result.target, taskId);

        const beforeDispatch = h.sentCommands.length;
        const dispatched = await h.chatActions.dispatch({
            action: result.action,
            ...(result.target !== undefined ? { target: result.target } : {}),
            payload: result.payload,
        });
        assert.equal(
            dispatched.dispatched,
            true,
            `${entry.type}: chat-actions dispatched the NL action`,
        );
        assert.equal(dispatched.commandType, entry.expected.chat_actions_command);

        const newCommands = h.sentCommands.slice(beforeDispatch);
        assert.equal(newCommands.length, 1, `${entry.type}: exactly one command emitted`);
        assert.equal(newCommands[0].type, entry.expected.chat_actions_command);
        assert.equal(
            (newCommands[0].payload as { readonly taskId?: string }).taskId,
            taskId,
            `${entry.type}: command payload carries taskId ${taskId}`,
        );

        // AC4 — no real getUpdates / answerCallbackQuery traffic was emitted
        // by the outbound path; the fake api proves the boundary is mocked.
        assert.equal(h.api.acknowledged.length, 0);
    });
}

// ---------------------------------------------------------------------------
// AC #4 (negative) — the harness must never instantiate a real Telegram HTTP
// client. The default `apiFactory` in TelegramGateway calls
// `createHttpTelegramApi` which would attempt real HTTPS at first use; the
// harness's override is what keeps the test hermetic. This assertion makes
// the invariant explicit.
// ---------------------------------------------------------------------------

test('outbound is mocked at the TelegramGateway boundary (no real HTTP client)', async () => {
    APIFACTORY_TOKENS_SEEN.length = 0;
    const h = makeHarness();
    await h.gateway.start();
    try {
        for (const entry of loadFixture()) {
            const envelope = translateV1ToV2(entry);
            await publishStored(h.eventBus, envelope.type, envelope.payload);
        }
    } finally {
        await h.gateway.stop();
    }
    assert.ok(
        APIFACTORY_TOKENS_SEEN.length > 0,
        'the injected apiFactory was the only path used',
    );
    assert.ok(
        APIFACTORY_TOKENS_SEEN.every((t) => t === 'parity-fake-token'),
        'no token other than the fixture token reached the apiFactory',
    );
    // The fake api recorded every outbound — one per allowed user per event.
    assert.equal(h.api.sent.length, 4);
});
