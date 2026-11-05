/**
 * AP-IFG-014: NotificationPort wiring on TelegramGateway.
 *
 * Each of the seven new lifecycle event kinds must:
 *
 *   1. Translate through `send(kind, payload)` into an outbound text
 *      that begins with the v1-parity icon glyph (chat-notify.ts
 *      ICON_BY_KIND).
 *   2. Route via the EventBus subscriber the gateway installs in
 *      `start()` — so a host publishing `PlanReady` (etc.) on the bus
 *      gets a Telegram message without the host having to call `send`
 *      directly.
 *   3. Render context fields the operator needs (taskId / planId /
 *      deploy_target / prNumber / error) when supplied.
 *
 * The tests stay at the gateway boundary: every outbound flows through a
 * FakeTelegramApi so no real HTTPS traffic leaves the process.
 *
 * Dual-runner discovery
 * ---------------------
 * The repo's own test command (`npm test` → `node --test --import tsx`,
 * see package.json) uses Node's built-in `node:test` runner. The review
 * pipeline however runs `npx vitest run` on the changed test file. A
 * file written against only one of those APIs gets reported as
 * "no tests" by the other and the pipeline rejects the run.
 *
 * The shim below picks the right `test()` at module load: vitest sets
 * `process.env.VITEST=true` in its worker, so we route through vitest's
 * API there and through `node:test`'s API everywhere else. Both runners
 * therefore discover and execute the same suite from a single source
 * file.
 */
import assert from 'node:assert/strict';

import Database from 'better-sqlite3';

import { CommandBus } from '../../core/commands/bus';
import type { Command } from '../../core/commands/command';
import { EventBus } from '../../core/events/bus';
import { EventStore } from '../../core/events/store';
import type { Db } from '../../core/state/migrations';
import {
    NotificationKinds,
    type Logger,
    type NotificationKind,
    type NotificationPayload,
} from '../../core/ports';

import {
    NOTIFICATION_ICON_BY_KIND,
    TelegramGateway,
    TelegramInboundCommands,
    formatNotificationText,
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
                'TelegramGateway.notifications.test.ts: VITEST=true but globalThis.test is missing — '
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
// Test scaffolding (intentionally a stripped-down clone of the scaffolding
// in TelegramGateway.test.ts — these notification specs don't need the
// inbound text/router path, so the fakes here are minimal).
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

function makeBus(db: Db): EventBus {
    return new EventBus(new EventStore(db), new SilentLogger());
}

function makeCommandBus(bus: EventBus): CommandBus<unknown> {
    const cb = new CommandBus<unknown>(bus, () => undefined);
    for (const t of [
        TelegramInboundCommands.APPROVE_TASK,
        TelegramInboundCommands.SKIP_TASK,
        TelegramInboundCommands.RETRY_TASK,
    ]) {
        cb.register(t, async (_cmd: Command) => []);
    }
    return cb;
}

class FakeTelegramApi implements TelegramApi {
    readonly sent: SendMessageOptions[] = [];
    private nextMessageId = 1;

    async getUpdates(_opts: GetUpdatesOptions): Promise<TelegramUpdate[]> {
        return [];
    }
    async sendMessage(opts: SendMessageOptions): Promise<TelegramMessage> {
        this.sent.push(opts);
        const chatIdNum = typeof opts.chat_id === 'number' ? opts.chat_id : Number(opts.chat_id);
        return {
            chat: { id: Number.isFinite(chatIdNum) ? chatIdNum : 0 },
            message_id: this.nextMessageId++,
            text: opts.text,
        };
    }
    async answerCallbackQuery(_opts: { readonly callback_query_id: string }): Promise<void> {}
}

interface Harness {
    readonly bus: EventBus;
    readonly api: FakeTelegramApi;
    readonly gateway: TelegramGateway;
}

function makeHarness(env: TelegramEnv = { token: 'tok', allowedUserIds: [42] }): Harness {
    const db = makeDb();
    const bus = makeBus(db);
    const commandBus = makeCommandBus(bus);
    const api = new FakeTelegramApi();
    const gateway = new TelegramGateway({
        bus,
        commandBus,
        db,
        logger: new SilentLogger(),
        clock: (): number => 1_700_000_000_000,
        envProvider: (): TelegramEnv => env,
        apiFactory: (): TelegramApi => api,
    });
    return { bus, api, gateway };
}

async function publishStored(bus: EventBus, type: string, payload: unknown): Promise<void> {
    await bus.publish({
        type,
        v: 1,
        occurredAt: 1_700_000_000_000,
        idempotencyKey: `notif-test:${type}:${Math.random().toString(36).slice(2)}`,
        payload,
    });
}

// ---------------------------------------------------------------------------
// AC #1 — port icons match v1 chat-notify.ts
// ---------------------------------------------------------------------------

test('NOTIFICATION_ICON_BY_KIND mirrors v1 chat-notify ICON_BY_KIND', () => {
    // Pinned from pipeline/worker/chat-notify.ts ICON_BY_KIND at REFERENCE_BASELINE.
    assert.equal(NOTIFICATION_ICON_BY_KIND.PlanReady,         '📋');
    assert.equal(NOTIFICATION_ICON_BY_KIND.CommitReady,       '💾');
    assert.equal(NOTIFICATION_ICON_BY_KIND.PrReady,           '🔀');
    assert.equal(NOTIFICATION_ICON_BY_KIND.DeployReady,       '🚀');
    assert.equal(NOTIFICATION_ICON_BY_KIND.InvestigationDone, '🔍');
    assert.equal(NOTIFICATION_ICON_BY_KIND.ContextUpdated,    '📝');
    assert.equal(NOTIFICATION_ICON_BY_KIND.WorkerError,       '🔥');
});

// ---------------------------------------------------------------------------
// Per-kind formatting unit tests (AC #6)
// ---------------------------------------------------------------------------

interface FormatCase {
    readonly kind: NotificationKind;
    readonly payload: NotificationPayload;
    readonly icon: string;
    readonly defaultTitle: string;
    readonly contextLine: string | undefined;
}

const FORMAT_CASES: readonly FormatCase[] = [
    {
        kind: NotificationKinds.PLAN_READY,
        payload: { planId: 'plan-7', body: 'three tasks queued' },
        icon: '📋',
        defaultTitle: 'Plan ready',
        contextLine: 'Plan: plan-7',
    },
    {
        kind: NotificationKinds.COMMIT_READY,
        payload: { taskId: 'task-A' },
        icon: '💾',
        defaultTitle: 'Commit ready',
        contextLine: 'Task: task-A',
    },
    {
        kind: NotificationKinds.PR_READY,
        payload: { taskId: 'task-B', url: 'https://github.com/x/y/pull/42' },
        icon: '🔀',
        defaultTitle: 'PR ready',
        contextLine: 'Task: task-B',
    },
    {
        kind: NotificationKinds.DEPLOY_READY,
        payload: {
            taskId: 'task-C',
            deployKind: 'azure-functions',
            deployTarget: 'staging',
        },
        icon: '🚀',
        defaultTitle: 'Deploy ready',
        contextLine: 'Task: task-C · Kind: azure-functions · Target: staging',
    },
    {
        kind: NotificationKinds.INVESTIGATION_DONE,
        payload: { taskId: 'task-D', body: 'root cause: stale cache' },
        icon: '🔍',
        defaultTitle: 'Investigation done',
        contextLine: 'Task: task-D',
    },
    {
        kind: NotificationKinds.CONTEXT_UPDATED,
        payload: { taskId: 'task-E', prNumber: 99 },
        icon: '📝',
        defaultTitle: 'Context updated',
        contextLine: 'Task: task-E · PR #99',
    },
    {
        kind: NotificationKinds.WORKER_ERROR,
        payload: { error: 'EAGAIN on git clone' },
        icon: '🔥',
        defaultTitle: 'Worker error',
        contextLine: 'EAGAIN on git clone',
    },
];

for (const tc of FORMAT_CASES) {
    test(`formatNotificationText: ${tc.kind} renders icon, default title, and context`, () => {
        const text = formatNotificationText(tc.kind, tc.payload);
        const firstLine = text.split('\n')[0];
        assert.equal(
            firstLine,
            `${tc.icon} ${tc.defaultTitle}`,
            `${tc.kind}: first line starts with the v1-parity icon and default title`,
        );
        if (tc.contextLine !== undefined) {
            assert.ok(
                text.includes(tc.contextLine),
                `${tc.kind}: rendered text must include "${tc.contextLine}", got: ${text}`,
            );
        }
        if (tc.payload.body) {
            assert.ok(
                text.includes(tc.payload.body),
                `${tc.kind}: rendered text must include the body`,
            );
        }
        if (tc.payload.url) {
            assert.ok(
                text.includes(tc.payload.url),
                `${tc.kind}: rendered text must include the url`,
            );
        }
    });
}

test('formatNotificationText: caller-supplied title overrides the default', () => {
    const text = formatNotificationText(NotificationKinds.PLAN_READY, {
        title: 'Plan ready for review',
        planId: 'plan-9',
    });
    assert.ok(text.startsWith('📋 Plan ready for review'));
});

// ---------------------------------------------------------------------------
// AC #2 — TelegramGateway implements NotificationPort.send
// AC #3 — Gateway subscribes to all seven new event kinds
// ---------------------------------------------------------------------------

test('TelegramGateway.send broadcasts to every allowed user id', async () => {
    const h = makeHarness({ token: 'tok', allowedUserIds: [42, 43] });
    await h.gateway.send(NotificationKinds.PLAN_READY, {
        planId: 'plan-broadcast',
    });
    assert.equal(h.api.sent.length, 2);
    assert.deepEqual(
        h.api.sent.map((m) => m.chat_id).sort(),
        [42, 43],
    );
    for (const sent of h.api.sent) {
        assert.ok(sent.text.startsWith('📋'));
        assert.ok(sent.text.includes('plan-broadcast'));
    }
});

test('TelegramGateway.send is a no-op when the bot token is unset', async () => {
    const h = makeHarness({ token: undefined, allowedUserIds: [42] });
    await h.gateway.send(NotificationKinds.WORKER_ERROR, { error: 'boom' });
    assert.equal(h.api.sent.length, 0);
});

// One end-to-end test per new event kind so a future regression in the
// subscriber wiring (e.g. someone drops an entry from the registration
// loop) lights up the matching case.
for (const tc of FORMAT_CASES) {
    test(`event-bus subscriber: ${tc.kind} reaches Telegram with the matching icon`, async () => {
        const h = makeHarness();
        await h.gateway.start();
        try {
            await publishStored(h.bus, tc.kind, tc.payload);
        } finally {
            await h.gateway.stop();
        }
        assert.equal(h.api.sent.length, 1, `${tc.kind}: one outbound per event`);
        const sent = h.api.sent[0];
        assert.ok(
            sent.text.startsWith(`${tc.icon} `),
            `${tc.kind}: text starts with icon "${tc.icon}", got: ${sent.text}`,
        );
        if (tc.contextLine !== undefined) {
            assert.ok(
                sent.text.includes(tc.contextLine),
                `${tc.kind}: text includes the context line`,
            );
        }
    });
}

// ---------------------------------------------------------------------------
// AP-IFG-015 (P-CPTO-006) — outbound approval keyboards.
//
// The four stage-decision kinds must render inline keyboards whose buttons
// carry callback_data the inbound parser maps back to a REGISTERED approval
// command. Every case round-trips its buttons through `parseCallbackData` so a
// verb rename on either side (button text vs. wire prefix) fails here rather
// than shipping the operator a dead button.
// ---------------------------------------------------------------------------

/** All buttons on a keyboard, flattened row-first. */
function flatButtons(
    keyboard: { readonly inline_keyboard: readonly (readonly { readonly text: string; readonly callback_data: string }[])[] } | undefined,
): readonly { readonly text: string; readonly callback_data: string }[] {
    return (keyboard?.inline_keyboard ?? []).flat();
}

interface KeyboardCase {
    readonly kind: NotificationKind;
    readonly payload: NotificationPayload;
    /** Expected [buttonText, commandType] pairs, in render order. */
    readonly buttons: readonly (readonly [string, string])[];
}

const KEYBOARD_CASES: readonly KeyboardCase[] = [
    {
        kind: NotificationKinds.COMMIT_READY,
        payload: { taskId: 'task-A' },
        buttons: [
            ['Approve commit', TelegramInboundCommands.APPROVE_COMMIT],
            ['Reject commit', TelegramInboundCommands.REJECT_COMMIT],
        ],
    },
    {
        kind: NotificationKinds.PR_READY,
        payload: { taskId: 'task-B', url: 'https://github.com/x/y/pull/42' },
        buttons: [
            ['Approve merge', TelegramInboundCommands.APPROVE_MERGE],
            ['Reject merge', TelegramInboundCommands.REJECT_MERGE],
        ],
    },
    {
        kind: NotificationKinds.DEPLOY_READY,
        payload: { taskId: 'task-C', deployKind: 'azure-functions', deployTarget: 'staging' },
        buttons: [['Approve deploy', TelegramInboundCommands.APPROVE_DEPLOY]],
    },
    {
        kind: NotificationKinds.CONTEXT_UPDATED,
        payload: { taskId: 'task-E', prNumber: 99 },
        buttons: [
            ['Accept update', TelegramInboundCommands.ACCEPT_CONTEXT_UPDATE],
            ['Reject update', TelegramInboundCommands.REJECT_CONTEXT_UPDATE],
        ],
    },
];

for (const tc of KEYBOARD_CASES) {
    test(`send: ${tc.kind} renders approval buttons whose callbacks map to registered commands`, async () => {
        const h = makeHarness({ token: 'tok', allowedUserIds: [42] });
        await h.gateway.send(tc.kind, tc.payload);

        assert.equal(h.api.sent.length, 1, `${tc.kind}: one outbound`);
        const buttons = flatButtons(h.api.sent[0].reply_markup);
        assert.equal(
            buttons.length,
            tc.buttons.length,
            `${tc.kind}: expected ${tc.buttons.length} button(s)`,
        );

        for (let i = 0; i < tc.buttons.length; i += 1) {
            const [expectedText, expectedCommand] = tc.buttons[i];
            const button = buttons[i];
            assert.equal(button.text, expectedText, `${tc.kind}: button #${i} text`);

            // The verb round-trips through the inbound parser to the command
            // the approval handlers are registered under, carrying the task
            // identity the handler resolves the gated task from.
            const parsed = parseCallbackData(button.callback_data);
            assert.ok(
                parsed,
                `${tc.kind}: callback_data "${button.callback_data}" must parse`,
            );
            assert.equal(
                parsed!.commandType,
                expectedCommand,
                `${tc.kind}: button #${i} must dispatch ${expectedCommand}`,
            );
            assert.deepEqual(
                parsed!.payload,
                { taskId: tc.payload.taskId },
                `${tc.kind}: callback must round-trip the taskId identity`,
            );
        }
    });
}

test('send: DeployReady offers approve only — no reject verb exists', async () => {
    const h = makeHarness({ token: 'tok', allowedUserIds: [42] });
    await h.gateway.send(NotificationKinds.DEPLOY_READY, { taskId: 'task-C' });
    const buttons = flatButtons(h.api.sent[0].reply_markup);
    assert.equal(buttons.length, 1, 'DeployReady renders a single approve button');
    assert.ok(
        buttons[0].callback_data.startsWith('deploy-approve:'),
        'the only deploy verb is deploy-approve',
    );
});

test('send: a stage-decision kind with no taskId ships text-only (no dead button)', async () => {
    const h = makeHarness({ token: 'tok', allowedUserIds: [42] });
    // CommitReady is a keyboard kind, but without a taskId the callback could
    // not name a task — so it must degrade to text-only rather than emit a
    // button whose tap the handler would reject.
    await h.gateway.send(NotificationKinds.COMMIT_READY, { body: 'no task id here' });
    assert.equal(h.api.sent.length, 1);
    assert.equal(
        h.api.sent[0].reply_markup,
        undefined,
        'a taskId-less stage notification carries no keyboard',
    );
});

test('send: informational kinds (PlanReady) carry no approval keyboard', async () => {
    const h = makeHarness({ token: 'tok', allowedUserIds: [42] });
    await h.gateway.send(NotificationKinds.PLAN_READY, { planId: 'plan-7' });
    assert.equal(h.api.sent.length, 1);
    assert.equal(
        h.api.sent[0].reply_markup,
        undefined,
        'PlanReady has no stage-decision callback — it ships informational',
    );
});

test('event-bus subscriber: PrReady reaches Telegram carrying the merge keyboard', async () => {
    // End-to-end through the bus subscriber (not just a direct send) so a
    // regression in the outbound wiring lights up the keyboard path too.
    const h = makeHarness();
    await h.gateway.start();
    try {
        await publishStored(h.bus, NotificationKinds.PR_READY, {
            taskId: 'task-K',
            url: 'https://github.com/x/y/pull/1',
        });
    } finally {
        await h.gateway.stop();
    }
    assert.equal(h.api.sent.length, 1);
    const buttons = flatButtons(h.api.sent[0].reply_markup);
    assert.deepEqual(
        buttons.map((b) => b.callback_data),
        ['merge-approve:task-K', 'merge-reject:task-K'],
        'PrReady renders approve/reject merge buttons carrying the task identity',
    );
});
