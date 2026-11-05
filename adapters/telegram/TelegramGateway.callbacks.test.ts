/**
 * AP-IFG-015 — inline-keyboard callback parser tests.
 *
 * The gateway grew seven stage-decision callbacks (commit-approve, commit-
 * reject, merge-approve, merge-reject, deploy-approve, context-update-
 * accept, context-update-reject) on top of the original three verbs
 * (approve / skip / retry). This file covers the parsing surface and the
 * dispatch path for the new verbs; existing verbs are already covered by
 * `TelegramGateway.test.ts`.
 *
 * The test scaffolding mirrors `TelegramGateway.test.ts` deliberately — the
 * same `FakeTelegramApi`, in-memory db, recording CommandBus — so a future
 * reader can compare the two files side by side without context-switching
 * across two harnesses.
 *
 * Dual-runner discovery
 * ---------------------
 * The repo's own test command (`npm test` → `node --test --import tsx`,
 * see package.json) uses Node's built-in `node:test` runner. The review
 * pipeline however runs `npx vitest run` on the changed test file. A
 * file written against only one of those APIs gets reported as
 * "no tests" by the other and the pipeline rejects the run. The shim
 * below picks the right `test()` at module load — vitest sets
 * `process.env.VITEST=true` in its worker, so we route through vitest's
 * globals there and fall back to `node:test`'s `test()` everywhere else.
 * Pattern is borrowed verbatim from `TelegramGateway.notifications.test.ts`.
 */

import assert from 'node:assert/strict';

import Database from 'better-sqlite3';

import { CommandBus } from '../../core/commands/bus';
import type { Command } from '../../core/commands/command';
import { EventBus } from '../../core/events/bus';
import { EventStore } from '../../core/events/store';
import type { Db } from '../../core/state/migrations';
import type { Logger } from '../../core/ports';

import {
    TelegramGateway,
    TelegramInboundCommands,
    parseCallbackData,
    type TelegramEnv,
} from './TelegramGateway';
import type {
    GetUpdatesOptions,
    SendMessageOptions,
    TelegramApi,
    TelegramMessage,
    TelegramUpdate,
} from './api';

// ---------------------------------------------------------------------------
// Dual-runner test() shim — see file header for rationale.
//
// Vitest v4 forbids `require('vitest')` from CJS modules (see
// node_modules/vitest/index.cjs:1), and tsc compiles this file to CJS
// per the project's tsconfig (`module: CommonJS`). Static `import` from
// 'vitest' therefore also breaks under `node --test`. The workaround is
// to rely on vitest's `globals: true` config (see ../../vitest.config.ts)
// which puts `test` on `globalThis` inside vitest workers; outside
// vitest we fall back to `node:test`'s `test()` via plain `require`.
// ---------------------------------------------------------------------------

type TestFn = (name: string, fn: () => void | Promise<void>) => void;

const test: TestFn = (((): TestFn => {
    if (process.env.VITEST) {
        const gt = (globalThis as { test?: TestFn }).test;
        if (typeof gt !== 'function') {
            throw new Error(
                'TelegramGateway.callbacks.test.ts: VITEST=true but globalThis.test is missing — '
                    + 'ensure vitest.config.ts sets test.globals = true',
            );
        }
        return gt;
    }
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    const nt = require('node:test') as { test: TestFn };
    return nt.test;
})());

// ---------------------------------------------------------------------------
// Test scaffolding (intentionally aligned with TelegramGateway.test.ts).
// ---------------------------------------------------------------------------

class SilentLogger implements Logger {
    info(): void {}
    warn(): void {}
    error(): void {}
    debug(): void {}
}

interface RecordingLogger extends Logger {
    readonly warned: string[];
    readonly errored: string[];
    readonly debugged: string[];
}

function makeRecordingLogger(): RecordingLogger {
    const warned: string[] = [];
    const errored: string[] = [];
    const debugged: string[] = [];
    return {
        info: () => {},
        warn: (msg) => warned.push(msg),
        error: (msg) => errored.push(msg),
        debug: (msg) => debugged.push(msg),
        warned,
        errored,
        debugged,
    };
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

/**
 * Records every command the gateway dispatches. The handler set covers all
 * inbound command types so an unregistered-type regression would surface as
 * a CommandBus error rather than a silent drop.
 */
function makeRecordingCommandBus(eventBus: EventBus): {
    bus: CommandBus<unknown>;
    sent: Command[];
} {
    const sent: Command[] = [];
    const bus = new CommandBus<unknown>(eventBus, () => undefined);
    const handler = async (cmd: Command): Promise<[]> => {
        sent.push(cmd);
        return [];
    };
    for (const type of Object.values(TelegramInboundCommands)) {
        bus.register(type, handler);
    }
    return { bus, sent };
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

interface Harness {
    readonly api: FakeTelegramApi;
    readonly gateway: TelegramGateway;
    readonly sentCommands: Command[];
    readonly logger: RecordingLogger;
}

function makeHarness(opts: {
    readonly env: TelegramEnv;
    readonly batches: readonly TelegramUpdate[][];
    readonly logger?: RecordingLogger;
}): Harness {
    const db = makeDb();
    const eventBus = makeEventBus(db);
    const { bus: commandBus, sent: sentCommands } = makeRecordingCommandBus(eventBus);
    const api = new FakeTelegramApi(opts.batches);
    const logger = opts.logger ?? makeRecordingLogger();

    const gateway = new TelegramGateway({
        bus: eventBus,
        commandBus,
        db,
        logger,
        clock: (): number => 1_700_000_000_000,
        envProvider: (): TelegramEnv => opts.env,
        apiFactory: (): TelegramApi => api,
    });

    return { api, gateway, sentCommands, logger };
}

// ---------------------------------------------------------------------------
// AC #5 — callback_data format is fixed and parses byte-for-byte. The table
// here is the canonical wire spec; any drift in the parser must show up as a
// failure of one of these rows.
// ---------------------------------------------------------------------------

interface PrefixCase {
    readonly callbackData: string;
    readonly commandType: string;
    readonly taskId: string;
}

const NEW_PREFIX_CASES: readonly PrefixCase[] = [
    {
        callbackData: 'commit-approve:task-1',
        commandType: TelegramInboundCommands.APPROVE_COMMIT,
        taskId: 'task-1',
    },
    {
        callbackData: 'commit-reject:task-2',
        commandType: TelegramInboundCommands.REJECT_COMMIT,
        taskId: 'task-2',
    },
    {
        callbackData: 'merge-approve:task-3',
        commandType: TelegramInboundCommands.APPROVE_MERGE,
        taskId: 'task-3',
    },
    {
        callbackData: 'merge-reject:task-4',
        commandType: TelegramInboundCommands.REJECT_MERGE,
        taskId: 'task-4',
    },
    {
        callbackData: 'deploy-approve:task-5',
        commandType: TelegramInboundCommands.APPROVE_DEPLOY,
        taskId: 'task-5',
    },
    {
        callbackData: 'context-update-accept:task-6',
        commandType: TelegramInboundCommands.ACCEPT_CONTEXT_UPDATE,
        taskId: 'task-6',
    },
    {
        callbackData: 'context-update-reject:task-7',
        commandType: TelegramInboundCommands.REJECT_CONTEXT_UPDATE,
        taskId: 'task-7',
    },
];

// ---------------------------------------------------------------------------
// AC #1 — parseCallbackData recognises every new prefix and returns the
// matching command type + a `{ taskId }` payload. The legacy `approve` verb
// retains its mandatory flowId; the seven new verbs never carry one.
// ---------------------------------------------------------------------------

test('AC1: parseCallbackData recognises every AP-IFG-015 prefix', () => {
    for (const c of NEW_PREFIX_CASES) {
        const parsed = parseCallbackData(c.callbackData);
        assert.ok(
            parsed,
            `${c.callbackData} should parse to a ParsedCallback`,
        );
        assert.equal(
            parsed!.commandType,
            c.commandType,
            `${c.callbackData} should map to ${c.commandType}`,
        );
        assert.deepEqual(
            parsed!.payload,
            { taskId: c.taskId },
            `${c.callbackData} payload should be {taskId}`,
        );
    }
});

test('AC1: AP-IFG-015 prefixes reject a missing taskId', () => {
    // The taskId is positional — a bare prefix with no taskId is malformed
    // and must drop, the same as `skip` / `retry`.
    for (const c of NEW_PREFIX_CASES) {
        const verb = c.callbackData.split(':')[0];
        assert.equal(
            parseCallbackData(verb),
            undefined,
            `bare prefix "${verb}" with no taskId should not parse`,
        );
        assert.equal(
            parseCallbackData(`${verb}:`),
            undefined,
            `"${verb}:" (trailing colon, empty taskId) should not parse`,
        );
    }
});

test('AC1: parseCallbackData rejects close-but-wrong prefixes', () => {
    // Guard against fat-finger drift between the gateway and the orchestrator
    // builder (e.g. underscore vs hyphen, "accept" vs "approve" mismatch). If
    // any of these were ever accepted by parseCallbackData, the operator's
    // muscle-memory callback would land on the wrong command type.
    assert.equal(parseCallbackData('commit_approve:t1'), undefined);
    assert.equal(parseCallbackData('commitapprove:t1'), undefined);
    assert.equal(parseCallbackData('context-update:t1'), undefined);
    assert.equal(parseCallbackData('contextupdate-accept:t1'), undefined);
    assert.equal(parseCallbackData('deploy-reject:t1'), undefined);
});

test('AC1: existing approve/skip/retry verbs still parse (no regression)', () => {
    // Sanity check that adding seven entries to the verb map didn't disturb
    // the original three. The full assertion of their shapes lives in
    // TelegramGateway.test.ts; here we just spot-check the dispatch surface.
    assert.deepEqual(parseCallbackData('approve:tA:flowZ'), {
        commandType: TelegramInboundCommands.APPROVE_TASK,
        payload: { taskId: 'tA', flowId: 'flowZ' },
        verb: 'approve',
    });
    assert.deepEqual(parseCallbackData('skip:tB'), {
        commandType: TelegramInboundCommands.SKIP_TASK,
        payload: { taskId: 'tB' },
        verb: 'skip',
    });
    assert.deepEqual(parseCallbackData('retry:tC'), {
        commandType: TelegramInboundCommands.RETRY_TASK,
        payload: { taskId: 'tC' },
        verb: 'retry',
    });
});

// ---------------------------------------------------------------------------
// AC #2 — Each recognised callback dispatches exactly one command on the bus,
// carrying the actor + clock the gateway was wired with.
// ---------------------------------------------------------------------------

test('AC2: each new callback dispatches exactly one command', async () => {
    // Feed all seven prefixes through pollOnce as a single batch so the test
    // also pins ordering (gateway must dispatch in update_id order, no
    // interleaving). The recording command bus appends in handler order.
    const batch: TelegramUpdate[] = NEW_PREFIX_CASES.map((c, idx) =>
        callbackUpdate(100 + idx, 42, c.callbackData),
    );
    const h = makeHarness({
        env: { token: 'tok', allowedUserIds: [42] },
        batches: [batch],
    });

    await h.gateway.pollOnce();

    assert.equal(
        h.sentCommands.length,
        NEW_PREFIX_CASES.length,
        'one command per callback, no duplicates',
    );
    for (let i = 0; i < NEW_PREFIX_CASES.length; i += 1) {
        const expected = NEW_PREFIX_CASES[i];
        const cmd = h.sentCommands[i];
        assert.equal(
            cmd.type,
            expected.commandType,
            `command #${i}: expected type ${expected.commandType}`,
        );
        assert.deepEqual(
            cmd.payload,
            { taskId: expected.taskId },
            `command #${i}: payload mismatch`,
        );
        assert.equal(cmd.actor, 'telegram', `command #${i}: actor must be 'telegram'`);
        assert.equal(
            cmd.issuedAt,
            1_700_000_000_000,
            `command #${i}: issuedAt must come from the injected clock`,
        );
    }

    // Every callback got acknowledged so the operator's Telegram client
    // clears the inline-button spinner.
    assert.deepEqual(
        h.api.acknowledged.sort(),
        NEW_PREFIX_CASES.map((_, idx) => `cb-${100 + idx}`).sort(),
        'every callback_query must be ack-ed back to Telegram',
    );
});

// ---------------------------------------------------------------------------
// AC #3 — Unknown callback prefixes are logged (at debug level) and dropped.
// No exception escapes, no command is dispatched, but the offset must still
// advance so the gateway doesn't spin on the malformed update forever.
// ---------------------------------------------------------------------------

test('AC3: unknown callback prefixes are logged and dropped, not crashed', async () => {
    const logger = makeRecordingLogger();
    const h = makeHarness({
        env: { token: 'tok', allowedUserIds: [42] },
        batches: [
            [
                callbackUpdate(1, 42, 'frobnicate:task-1'),
                // A known new prefix follows so we also assert the parser
                // didn't bail the whole batch on the bogus first entry.
                callbackUpdate(2, 42, 'commit-approve:task-2'),
            ],
        ],
        logger,
    });

    await h.gateway.pollOnce();

    assert.equal(
        h.sentCommands.length,
        1,
        'only the recognised callback should produce a command',
    );
    assert.equal(h.sentCommands[0].type, TelegramInboundCommands.APPROVE_COMMIT);

    // The unrecognised prefix produced a debug-level breadcrumb (not warn /
    // error — those are reserved for true failures so the operator's logs
    // stay quiet when a v1 client sends a stray verb during the cutover).
    assert.ok(
        logger.debugged.some((m) => m.includes('unparseable callback_data')),
        'unknown prefix should produce a debug-level log line',
    );
    assert.equal(
        logger.warned.length,
        0,
        'unknown prefix must not warn (would spam during v1→v2 cutover)',
    );
    assert.equal(logger.errored.length, 0, 'unknown prefix must not error');

    // The unknown button is no longer SILENT: the operator gets a visible
    // "not supported" reply (a tapped button that does nothing reads as
    // broken - field report) and the spinner is cleared for BOTH taps.
    const acknowledgedCount = h.api.acknowledged.length;
    assert.equal(
        acknowledgedCount,
        2,
        'both callbacks are ack-ed so no spinner is left hanging',
    );
    assert.ok(
        h.api.sent.some((m) => m.text.includes("isn't supported")),
        'unknown button must produce a visible not-supported reply',
    );
});

test('AC3: empty / undefined callback_data drops without crashing', async () => {
    const logger = makeRecordingLogger();
    const h = makeHarness({
        env: { token: 'tok', allowedUserIds: [42] },
        batches: [
            [
                // update_id 5: callback with no data field at all
                {
                    update_id: 5,
                    callback_query: {
                        id: 'cb-5',
                        from: { id: 42 },
                        message: { chat: { id: 42 }, message_id: 1 },
                    },
                },
                // update_id 6: empty-string data
                callbackUpdate(6, 42, ''),
            ],
        ],
        logger,
    });

    await h.gateway.pollOnce();

    assert.equal(h.sentCommands.length, 0, 'no command for missing/empty data');
    assert.equal(logger.warned.length, 0);
    assert.equal(logger.errored.length, 0);
});

// ---------------------------------------------------------------------------
// AC #4 — Callbacks from user IDs outside the allow-list are rejected
// deny-by-default. The check fires BEFORE parsing, so even a well-formed
// callback from a stranger produces no command and no ack — but the rejection
// is surfaced to the operator as a warn (numeric id only), never a silent drop.
// ---------------------------------------------------------------------------

test('AC4: callbacks from disallowed user IDs are rejected and warned', async () => {
    const logger = makeRecordingLogger();
    const h = makeHarness({
        env: { token: 'tok', allowedUserIds: [42] },
        batches: [
            [
                // One stranger callback per new prefix. None should land.
                ...NEW_PREFIX_CASES.map((c, idx) =>
                    callbackUpdate(200 + idx, 9999 /* not allowed */, c.callbackData),
                ),
            ],
        ],
        logger,
    });

    await h.gateway.pollOnce();

    assert.equal(
        h.sentCommands.length,
        0,
        'no command should be dispatched for disallowed users',
    );
    assert.deepEqual(
        h.api.acknowledged,
        [],
        'no answerCallbackQuery for disallowed users (avoids confirming the bot exists)',
    );
    // Deny-by-default now surfaces each rejection to the operator: one warn
    // per denied callback, carrying only the numeric sender id.
    assert.equal(
        logger.warned.length,
        NEW_PREFIX_CASES.length,
        'AC4: each disallowed callback surfaces exactly one warn',
    );
    assert.equal(
        logger.errored.length,
        0,
        'AC4: a denied sender is a warn, not an error',
    );
    assert.equal(
        logger.debugged.length,
        0,
        'AC4: the allow-list short-circuit runs before parseCallbackData so no debug line',
    );
});

test('AC4: allow-list filters per-update, not per-batch', async () => {
    // One allowed update sandwiched between two disallowed ones. Only the
    // middle one should produce a command; the offset advancement and the
    // dispatch for the allowed update must not be tainted by the strangers.
    const h = makeHarness({
        env: { token: 'tok', allowedUserIds: [42] },
        batches: [
            [
                callbackUpdate(1, 9999, 'commit-approve:bad-A'),
                callbackUpdate(2, 42, 'merge-approve:good-B'),
                callbackUpdate(3, 9999, 'deploy-approve:bad-C'),
            ],
        ],
    });

    await h.gateway.pollOnce();

    assert.equal(h.sentCommands.length, 1);
    assert.equal(h.sentCommands[0].type, TelegramInboundCommands.APPROVE_MERGE);
    assert.deepEqual(h.sentCommands[0].payload, { taskId: 'good-B' });
    assert.deepEqual(h.api.acknowledged, ['cb-2']);
});

// ---------------------------------------------------------------------------
// AC #5 — Wire format pinned. The keyboard builders the gateway already
// ships (approvalKeyboard / retryKeyboard) emit `approve:taskId:flowId` and
// friends; the AP-IFG-015 wire format is asserted here against the verb
// table so a future rename of e.g. `commit-approve` → `commit_approve`
// fails this file rather than silently breaking the operator's muscle
// memory after cutover.
// ---------------------------------------------------------------------------

test('AC5: AP-IFG-015 callback_data format is verb-then-taskId with hyphenated verbs', () => {
    for (const c of NEW_PREFIX_CASES) {
        const [verb, taskId, ...rest] = c.callbackData.split(':');
        assert.ok(
            verb.length > 0,
            `${c.callbackData}: verb must be non-empty`,
        );
        assert.ok(
            verb.includes('-') || verb === 'approve' || verb === 'skip' || verb === 'retry',
            `${c.callbackData}: AP-IFG-015 verbs are hyphenated to disambiguate from legacy approve/skip/retry`,
        );
        assert.equal(
            taskId,
            c.taskId,
            `${c.callbackData}: taskId must follow the verb`,
        );
        assert.deepEqual(
            rest,
            [],
            `${c.callbackData}: no extra colon-separated segments — the seven new prefixes never carry a flowId`,
        );
    }
});

test('AC5: callback_data fits within Telegram\'s 64-byte cap with realistic taskIds', () => {
    // Telegram rejects callback_data > 64 bytes. The longest legitimate
    // taskId in v2 is a Linear-style identifier like "AP-IFG-099" plus a
    // small numeric suffix; assert the worst-case prefix + a 32-char taskId
    // still fits so a future Linear key-space expansion doesn't blow the cap.
    const worstPrefix = 'context-update-accept'; // 21 chars
    const taskId = 'X'.repeat(32);
    const data = `${worstPrefix}:${taskId}`;
    assert.ok(
        Buffer.byteLength(data, 'utf8') <= 64,
        `${data} (${Buffer.byteLength(data, 'utf8')} bytes) exceeds Telegram's 64-byte callback_data cap`,
    );
    const parsed = parseCallbackData(data);
    assert.ok(parsed, 'longest-prefix + 32-char taskId still parses');
    assert.equal(parsed!.commandType, TelegramInboundCommands.ACCEPT_CONTEXT_UPDATE);
    assert.deepEqual(parsed!.payload, { taskId });
});

// ---------------------------------------------------------------------------
// AC #6 — covered by the targeted tests above:
//
//   - AC #1 parses every callback type (8 cases inside one test + close-
//     but-wrong negatives + legacy non-regression).
//   - AC #2 dispatches one command per new callback (7 cases in one batch).
//   - AC #4 covers allow-list rejection on its own + an interleaved variant.
//
// This file lives next to TelegramGateway.test.ts; together they exercise
// the parser, the dispatcher, the allow-list, and the wire format.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Tap feedback — every button tap gets a visible ✅/⚠️ reply (field report:
// "when I click a button there is no feedback").
// ---------------------------------------------------------------------------

test('a successful tap replies with a short confirmation naming the action', async () => {
    const h = makeHarness({
        env: { token: 'tok', allowedUserIds: [42] },
        batches: [[callbackUpdate(1, 42, 'commit-approve:task-9')]],
    });

    await h.gateway.pollOnce();

    assert.equal(h.sentCommands.length, 1);
    const confirmations = h.api.sent.filter((m) => m.text.startsWith('✅'));
    assert.equal(confirmations.length, 1, 'exactly one success reply');
    // Operator asked for exactly "<action> - done", no task summary noise.
    assert.equal(confirmations[0].text, '✅ Approve commit — done');
});

test('a failed dispatch replies with the failure reason', async () => {
    const db = makeDb();
    const eventBus = makeEventBus(db);
    const bus = new CommandBus<unknown>(eventBus, () => undefined);
    for (const type of Object.values(TelegramInboundCommands)) {
        bus.register(type, async () => {
            throw new Error('merge failed for task-3: PR is not mergeable');
        });
    }
    const api = new FakeTelegramApi([[callbackUpdate(1, 42, 'merge-pr:task-3')]]);
    const gateway = new TelegramGateway({
        bus: eventBus,
        commandBus: bus,
        db,
        logger: makeRecordingLogger(),
        clock: (): number => 1_700_000_000_000,
        envProvider: (): TelegramEnv => ({ token: 'tok', allowedUserIds: [42] }),
        apiFactory: (): TelegramApi => api,
    });

    await gateway.pollOnce();

    const failures = api.sent.filter((m) => m.text.startsWith('⚠️'));
    assert.equal(failures.length, 1, 'exactly one failure reply');
    assert.ok(failures[0].text.includes('Merge PR failed for task-3'));
    assert.ok(
        failures[0].text.includes('PR is not mergeable'),
        'the reply must carry the actual failure reason',
    );
    // Spinner still cleared even on failure.
    assert.deepEqual(api.acknowledged, ['cb-1']);
});
