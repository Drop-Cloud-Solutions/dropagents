/**
 * TaskParked → Telegram decision messages.
 *
 * The operator previously only heard about finished/failed tasks; every
 * approval had to be discovered on the board. Each engine park is now a
 * message with a summary of the task and the matching decision keyboard:
 *
 *   1. `approval` park → 🟡 message with task summary (title, plan, goal)
 *      and Approve (`approve:<taskId>:<flowId>`) / Skip buttons.
 *   2. `worktree-diff-review` park → 💾 message with Approve commit /
 *      Reject buttons (`commit-approve` / `commit-reject`).
 *   3. `wait-merged` park → 🔀 message with the PR URL and Merge PR
 *      (`merge-pr` → MergeTaskPr, the REAL gh-pr-merge path) / Reject.
 *   4. `clarification` and `waiting-deps` parks send nothing (covered by
 *      AgentQuestion / pure noise respectively).
 *   5. `merge-pr` round-trips through parseCallbackData to MergeTaskPr.
 *   6. TaskFinished / TaskFailed messages carry the task summary.
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
    extractChangeSummary,
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

type TestFn = (name: string, fn: () => void | Promise<void>) => void;

const test: TestFn = (((): TestFn => {
    if (process.env.VITEST) {
        const gt = (globalThis as { test?: TestFn }).test;
        if (typeof gt !== 'function') {
            throw new Error(
                'TelegramGateway.parked.test.ts: VITEST=true but globalThis.test is missing',
            );
        }
        return gt;
    }
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    const nt = require('node:test') as { test: TestFn };
    return nt.test;
})());

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
        CREATE TABLE tasks (
            id             TEXT PRIMARY KEY,
            plan_id        TEXT,
            type           TEXT,
            flow_id        TEXT,
            title          TEXT,
            description    TEXT,
            ticket_details TEXT
        );
        CREATE TABLE sidebar_plans (
            plan_id TEXT PRIMARY KEY,
            name    TEXT
        );
        CREATE TABLE task_worktrees (
            task_id TEXT PRIMARY KEY,
            pr_url  TEXT
        );
    `);
    return db;
}

class FakeTelegramApi implements TelegramApi {
    readonly sent: SendMessageOptions[] = [];
    private nextMessageId = 1;

    async getUpdates(_opts: GetUpdatesOptions): Promise<TelegramUpdate[]> {
        return [];
    }
    async sendMessage(opts: SendMessageOptions): Promise<TelegramMessage> {
        this.sent.push(opts);
        return { chat: { id: 42 }, message_id: this.nextMessageId++, text: opts.text };
    }
    async answerCallbackQuery(_opts: { readonly callback_query_id: string }): Promise<void> {}
}

interface Harness {
    readonly db: Db;
    readonly bus: EventBus;
    readonly api: FakeTelegramApi;
    readonly gateway: TelegramGateway;
}

function makeHarness(): Harness {
    const db = makeDb();
    const bus = new EventBus(new EventStore(db), new SilentLogger());
    const commandBus = new CommandBus<unknown>(bus, () => undefined);
    commandBus.register(TelegramInboundCommands.APPROVE_TASK, async (_c: Command) => []);
    const api = new FakeTelegramApi();
    const gateway = new TelegramGateway({
        bus,
        commandBus,
        db,
        logger: new SilentLogger(),
        clock: (): number => 1_700_000_000_000,
        envProvider: (): TelegramEnv => ({ token: 'tok', allowedUserIds: [42] }),
        apiFactory: (): TelegramApi => api,
    });
    return { db, bus, api, gateway };
}

function seedTask(db: Db): void {
    db.prepare(
        `INSERT INTO tasks(id, plan_id, type, flow_id, title, description, ticket_details)
         VALUES ('L-IAED-002', 'plan-1', 'implement', 'implement',
                 'Fix the price importer',
                 'Long description body here',
                 '{"goal":"Importer must survive missing price rows"}')`,
    ).run();
    db.prepare(
        `INSERT INTO sidebar_plans(plan_id, name) VALUES ('plan-1', 'Products pricing plan')`,
    ).run();
    db.prepare(
        `INSERT INTO task_worktrees(task_id, pr_url)
         VALUES ('L-IAED-002', 'https://github.com/x/y/pull/9')`,
    ).run();
}

async function publishParked(
    h: Harness,
    reason: string,
    stepId = 'develop',
): Promise<void> {
    await h.gateway.start();
    try {
        await h.bus.publish({
            type: 'TaskParked',
            v: 1,
            occurredAt: 1_700_000_000_000,
            idempotencyKey: `parked-test:${reason}:${Math.random().toString(36).slice(2)}`,
            payload: { taskId: 'L-IAED-002', stepId, reason },
        });
    } finally {
        await h.gateway.stop();
    }
}

function buttons(sent: SendMessageOptions): string[] {
    const kb = sent.reply_markup?.inline_keyboard ?? [];
    return kb.flat().map((b) => b.callback_data ?? '');
}

test('approval park sends summary + Approve/Skip keyboard', async () => {
    const h = makeHarness();
    seedTask(h.db);
    await publishParked(h, 'approval');
    assert.equal(h.api.sent.length, 1);
    const msg = h.api.sent[0]!;
    assert.ok(msg.text.startsWith('🟡'));
    assert.ok(msg.text.includes('L-IAED-002 — Fix the price importer'));
    assert.ok(msg.text.includes('Plan: Products pricing plan'));
    assert.ok(msg.text.includes('Importer must survive missing price rows'));
    assert.deepEqual(buttons(msg), ['approve:L-IAED-002:implement', 'skip:L-IAED-002']);
});

test('worktree-diff-review park sends Approve commit / Reject keyboard', async () => {
    const h = makeHarness();
    seedTask(h.db);
    await publishParked(h, 'worktree-diff-review', 'human-review');
    assert.equal(h.api.sent.length, 1);
    const msg = h.api.sent[0]!;
    assert.ok(msg.text.startsWith('💾'));
    assert.deepEqual(buttons(msg), [
        'commit-approve:L-IAED-002',
        'commit-reject:L-IAED-002',
    ]);
});

test('wait-merged park sends PR url + Merge PR / Reject keyboard', async () => {
    const h = makeHarness();
    seedTask(h.db);
    await publishParked(h, 'wait-merged', 'merge');
    assert.equal(h.api.sent.length, 1);
    const msg = h.api.sent[0]!;
    assert.ok(msg.text.startsWith('🔀'));
    assert.ok(msg.text.includes('https://github.com/x/y/pull/9'));
    assert.deepEqual(buttons(msg), [
        'merge-pr:L-IAED-002',
        'merge-reject:L-IAED-002',
    ]);
});

test('clarification and waiting-deps parks send nothing', async () => {
    const h = makeHarness();
    seedTask(h.db);
    await publishParked(h, 'clarification');
    await publishParked(h, 'waiting-deps');
    assert.equal(h.api.sent.length, 0);
});

test('clarification park with notifyChat sends the question (merge-resolver path)', async () => {
    // Host-side parks (merge-conflict resolver) have no AgentQuestion event
    // to cover them, so they flag notifyChat to get the ❓ through the
    // usual clarification skip.
    const h = makeHarness();
    seedTask(h.db);
    await h.gateway.start();
    try {
        await h.bus.publish({
            type: 'TaskParked',
            v: 1,
            occurredAt: 1_700_000_000_000,
            idempotencyKey: 'parked-test:notify-chat',
            payload: {
                taskId: 'L-IAED-002',
                stepId: 'merge',
                reason: 'clarification',
                question: 'Both branches changed the importer — which side wins?',
                notifyChat: true,
            },
        });
    } finally {
        await h.gateway.stop();
    }
    assert.equal(h.api.sent.length, 1);
    const msg = h.api.sent[0]!;
    assert.ok(msg.text.startsWith('❓'));
    assert.ok(msg.text.includes('L-IAED-002 — Fix the price importer'));
    assert.ok(msg.text.includes('which side wins?'));
});

test('merge-pr callback maps to the MergeTaskPr command', () => {
    const parsed = parseCallbackData('merge-pr:L-IAED-002');
    assert.ok(parsed);
    assert.equal(parsed!.commandType, 'MergeTaskPr');
    assert.deepEqual(parsed!.payload, { taskId: 'L-IAED-002' });
});

test('TaskFinished / TaskFailed messages carry the task summary', async () => {
    const h = makeHarness();
    seedTask(h.db);
    await h.gateway.start();
    try {
        await h.bus.publish({
            type: 'TaskFinished',
            v: 1,
            occurredAt: 1,
            idempotencyKey: 'parked-test:finished',
            payload: { taskId: 'L-IAED-002' },
        });
        await h.bus.publish({
            type: 'TaskFailed',
            v: 1,
            occurredAt: 2,
            idempotencyKey: 'parked-test:failed',
            payload: { taskId: 'L-IAED-002', reason: 'tests exploded' },
        });
    } finally {
        await h.gateway.stop();
    }
    assert.equal(h.api.sent.length, 2);
    assert.ok(h.api.sent[0]!.text.startsWith('✅'));
    assert.ok(h.api.sent[0]!.text.includes('Fix the price importer'));
    assert.ok(h.api.sent[1]!.text.startsWith('❌'));
    assert.ok(h.api.sent[1]!.text.includes('tests exploded'));
    assert.ok(h.api.sent[1]!.text.includes('Plan: Products pricing plan'));
});

test('a task with no projection row degrades to the bare id', async () => {
    const h = makeHarness(); // no seed
    await publishParked(h, 'approval');
    assert.equal(h.api.sent.length, 1);
    assert.ok(h.api.sent[0]!.text.includes('L-IAED-002'));
});

test('ready-to-commit shows the developer report, not the task ticket', async () => {
    const h = makeHarness();
    seedTask(h.db);
    h.db.exec(
        `CREATE TABLE task_step_summaries (
            task_id TEXT, step_id TEXT, role TEXT, status TEXT,
            started_at INTEGER, finished_at INTEGER, summary TEXT
        )`,
    );
    h.db.prepare(
        `INSERT INTO task_step_summaries(task_id, step_id, role, status, started_at, finished_at, summary)
         VALUES ('L-IAED-002', 'develop', 'developer', 'complete', 1, 2,
                 'Added null-guard to PriceImporter.Parse and extended the row mapper.\nAll 14 importer tests pass.')`,
    ).run();

    await publishParked(h, 'worktree-diff-review', 'human-review');

    assert.equal(h.api.sent.length, 1);
    const msg = h.api.sent[0]!;
    assert.ok(msg.text.startsWith('💾'));
    assert.ok(msg.text.includes('L-IAED-002 — Fix the price importer'), 'id + title line');
    assert.ok(msg.text.includes('Added null-guard to PriceImporter.Parse'), 'developer report body');
    assert.ok(!msg.text.includes('Importer must survive missing price rows'), 'no ticket goal');
    assert.ok(!msg.text.includes('Plan: Products pricing plan'), 'no plan line');
});

test('ready-to-merge carries only id + title + PR link', async () => {
    const h = makeHarness();
    seedTask(h.db);
    await publishParked(h, 'wait-merged', 'merge');
    assert.equal(h.api.sent.length, 1);
    const msg = h.api.sent[0]!;
    assert.ok(msg.text.startsWith('🔀'));
    assert.ok(msg.text.includes('L-IAED-002 — Fix the price importer'));
    assert.ok(msg.text.includes('https://github.com/x/y/pull/9'));
    assert.ok(!msg.text.includes('Importer must survive missing price rows'), 'no ticket goal');
    assert.ok(!msg.text.includes('Plan:'), 'no plan line');
});

test('an auto (merge-auto) wait-merged park sends NO message', async () => {
    const h = makeHarness();
    seedTask(h.db);
    await h.gateway.start();
    try {
        await h.bus.publish({
            type: 'TaskParked',
            v: 1,
            occurredAt: 1_700_000_000_000,
            idempotencyKey: 'parked-test:auto-merge',
            payload: { taskId: 'L-IAED-002', stepId: 'merge', reason: 'wait-merged', auto: true },
        });
    } finally {
        await h.gateway.stop();
    }
    assert.equal(h.api.sent.length, 0, 'auto park must stay silent');
});

test('AutoMergeFailed sends a warning with the reason and manual merge buttons', async () => {
    const h = makeHarness();
    seedTask(h.db);
    await h.gateway.start();
    try {
        await h.bus.publish({
            type: 'AutoMergeFailed',
            v: 1,
            occurredAt: 1_700_000_000_000,
            idempotencyKey: 'parked-test:auto-merge-failed',
            payload: { taskId: 'L-IAED-002', reason: 'gh: HTTP 502 from api.github.com' },
        });
    } finally {
        await h.gateway.stop();
    }
    assert.equal(h.api.sent.length, 1);
    const msg = h.api.sent[0]!;
    assert.ok(msg.text.startsWith('⚠️ Auto-merge failed'));
    assert.ok(msg.text.includes('gh: HTTP 502'));
    assert.deepEqual(buttons(msg), ['merge-pr:L-IAED-002', 'merge-reject:L-IAED-002']);
});

test('extractChangeSummary prefers the Summary of changes block verbatim', () => {
    const report = [
        'I completed the task. Here is a detailed walkthrough of everything',
        'I looked at, including several files that turned out to be irrelevant.',
        '',
        '## Approach',
        'Lots of narrative the operator does not need on their phone.',
        '',
        '## Summary of changes',
        '- Importer now skips rows with a missing price instead of crashing',
        '- Retry logic added around the FTP fetch (3 attempts, backoff)',
        '- All 14 importer tests pass',
        '',
        '## Next steps',
        'None.',
    ].join('\n');
    const out = extractChangeSummary(report);
    assert.ok(out.startsWith('- Importer now skips rows'));
    assert.ok(out.includes('All 14 importer tests pass'));
    assert.ok(!out.includes('detailed walkthrough'), 'no preamble');
    assert.ok(!out.includes('Next steps'), 'stops at the next heading');
});

test('extractChangeSummary falls back to bullet lines for free-form reports', () => {
    const report = [
        'I have implemented the requested feature.',
        'First I read the existing code, then:',
        '- Added null-guard to PriceImporter.Parse',
        '- Extended the row mapper with the discount column',
        'Everything builds.',
    ].join('\n');
    const out = extractChangeSummary(report);
    assert.equal(out, '- Added null-guard to PriceImporter.Parse\n- Extended the row mapper with the discount column');
});

test('ready-to-commit message carries the extracted summary block', async () => {
    const h = makeHarness();
    seedTask(h.db);
    h.db.exec(
        `CREATE TABLE IF NOT EXISTS task_step_summaries (
            task_id TEXT, step_id TEXT, role TEXT, status TEXT,
            started_at INTEGER, finished_at INTEGER, summary TEXT
        )`,
    );
    h.db.prepare(
        `INSERT INTO task_step_summaries(task_id, step_id, role, status, started_at, finished_at, summary)
         VALUES ('L-IAED-002', 'develop', 'developer', 'complete', 1, 2,
                 'Long narrative preamble about the approach taken.' || char(10) ||
                 '## Summary of changes' || char(10) ||
                 '- Importer skips rows with missing prices' || char(10) ||
                 '- All importer tests pass')`,
    ).run();

    await publishParked(h, 'worktree-diff-review', 'human-review');

    assert.equal(h.api.sent.length, 1);
    const msg = h.api.sent[0]!;
    assert.ok(msg.text.includes('- Importer skips rows with missing prices'));
    assert.ok(msg.text.includes('- All importer tests pass'));
    assert.ok(!msg.text.includes('narrative preamble'), 'preamble stripped');
});
