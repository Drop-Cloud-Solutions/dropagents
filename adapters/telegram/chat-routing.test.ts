import { test } from 'node:test';
import assert from 'node:assert/strict';

import Database from 'better-sqlite3';

import { CommandBus } from '../../core/commands/bus';
import type { Command } from '../../core/commands/command';
import { EventBus } from '../../core/events/bus';
import { EventStore } from '../../core/events/store';
import type { Db } from '../../core/state/migrations';
import type { ChatGateway, Logger, PullRequestGateway } from '../../core/ports';
import { TaskParkingCommands } from '../../core/commands';

import { TelegramInboundCommands } from './TelegramGateway';
import { ChatClarify } from './chat-clarify';
import { ChatActions } from './chat-actions';
import { ChatPrActions } from './chat-pr-actions';
import { ChatPlanOps } from './chat-plan-ops';
import { ChatRouting } from './chat-routing';

class SilentLogger implements Logger {
    info(): void {}
    warn(): void {}
    error(): void {}
    debug(): void {}
}

class RecordingChatGateway implements ChatGateway {
    readonly notifications: Array<{ channel: string; message: string }> = [];
    async notify(channel: string, message: string): Promise<void> {
        this.notifications.push({ channel, message });
    }
}

function makeDb(): Db {
    const db = new Database(':memory:') as Db;
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

interface Harness {
    db: Db;
    sent: Command[];
    commandBus: CommandBus<unknown>;
    routing: ChatRouting;
    gateway: RecordingChatGateway;
    clarify: ChatClarify;
    actions: ChatActions;
    prActions: ChatPrActions;
    planOps: ChatPlanOps;
}

function makeHarness(opts: { prGateway?: PullRequestGateway } = {}): Harness {
    const db = makeDb();
    const logger = new SilentLogger();
    const eventBus = new EventBus(new EventStore(db), logger);
    const commandBus = new CommandBus<unknown>(eventBus, () => undefined);
    const sent: Command[] = [];
    for (const t of [
        TelegramInboundCommands.APPROVE_TASK,
        TelegramInboundCommands.SKIP_TASK,
        TelegramInboundCommands.RETRY_TASK,
        TaskParkingCommands.RESUME_TASK,
    ]) {
        commandBus.register(t, async (cmd) => {
            sent.push(cmd);
            return [];
        });
    }
    const clarify = new ChatClarify({ db, logger, commandBus });
    const actions = new ChatActions({ commandBus, logger });
    const prActions = new ChatPrActions({
        logger,
        ...(opts.prGateway ? { prGateway: opts.prGateway } : {}),
    });
    const planOps = new ChatPlanOps({
        commandBus,
        logger,
        idGen: { newId: () => 'brief-1' },
        planReader: { getApprovedContent: () => '# Approved plan body' },
    });
    const gateway = new RecordingChatGateway();
    const routing = new ChatRouting({
        clarify,
        actions,
        prActions,
        planOps,
        chatGateway: gateway,
        logger,
    });
    return {
        db,
        sent,
        commandBus,
        routing,
        gateway,
        clarify,
        actions,
        prActions,
        planOps,
    };
}

// ---------------------------------------------------------------------------
// AC #3 — Reply correlation skips the NL classifier
// ---------------------------------------------------------------------------

test('route: reply to a recorded clarification question dispatches ResumeTask, not NL', async () => {
    const h = makeHarness();
    h.clarify.recordQuestion('task-x', 42, 500);

    const r = await h.routing.route({
        chatId: 42,
        text: 'use the staging bucket',
        replyToMessageId: 500,
    });

    assert.equal(r.path, 'clarification');
    assert.equal(r.dispatched, true);
    assert.equal(h.sent.length, 1);
    assert.equal(h.sent[0]!.type, TaskParkingCommands.RESUME_TASK);
    assert.deepEqual(h.sent[0]!.payload, {
        taskId: 'task-x',
        decision: 'approve',
        answer: 'use the staging bucket',
    });
    // The classifier reply was NOT sent — the resume command is the
    // user-visible outcome.
    assert.equal(h.gateway.notifications.length, 0);
});

// ---------------------------------------------------------------------------
// AC #6 — plain-task verb dispatch
// ---------------------------------------------------------------------------

test('chat-actions: approve dispatches ApproveTask with the target taskId', async () => {
    const h = makeHarness();
    const r = await h.actions.dispatch({ action: 'approve', target: 't-1' });
    assert.equal(r.dispatched, true);
    assert.equal(r.commandType, TelegramInboundCommands.APPROVE_TASK);
    assert.equal(h.sent.length, 1);
    assert.equal(h.sent[0]!.type, TelegramInboundCommands.APPROVE_TASK);
    assert.deepEqual(h.sent[0]!.payload, { taskId: 't-1' });
});

test('chat-actions: skip / retry require a target taskId', async () => {
    const h = makeHarness();

    const skip = await h.actions.dispatch({ action: 'skip' });
    assert.equal(skip.dispatched, false);
    assert.match(skip.skipReason ?? '', /no target taskId/);

    const retry = await h.actions.dispatch({ action: 'retry' });
    assert.equal(retry.dispatched, false);

    assert.equal(h.sent.length, 0);
});

test('chat-actions: retry with a reason payload propagates onto the command', async () => {
    const h = makeHarness();
    const r = await h.actions.dispatch({
        action: 'retry',
        target: 't-2',
        payload: 'flaky build',
    });
    assert.equal(r.dispatched, true);
    assert.deepEqual(h.sent[0]!.payload, {
        taskId: 't-2',
        reason: 'flaky build',
    });
});

// ---------------------------------------------------------------------------
// AC #6 — PR verb dispatch
// ---------------------------------------------------------------------------

test('chat-pr-actions: merge skips when no PullRequestGateway is configured', async () => {
    const h = makeHarness();
    const r = await h.prActions.dispatch({ action: 'merge', prNumber: 7 });
    assert.equal(r.dispatched, false);
    assert.match(r.skipReason ?? '', /PullRequestGateway not configured/);
});

test('chat-pr-actions: merge with gateway dispatches via the port', async () => {
    const merges: Array<{ number: number; method: string }> = [];
    const prGateway: PullRequestGateway = {
        async push() {},
        async openPullRequest() {
            return { number: 0, url: '' };
        },
        async mergePullRequest(number, options) {
            merges.push({ number, method: options.method });
        },
        async addComment() {},
    };
    const h = makeHarness({ prGateway });
    const r = await h.prActions.dispatch({
        action: 'merge',
        prNumber: 42,
        payload: 'rebase',
    });
    assert.equal(r.dispatched, true);
    assert.deepEqual(merges, [{ number: 42, method: 'rebase' }]);
});

test('chat-pr-actions: mark_merged and show_diff are recognised but not wired yet', async () => {
    const h = makeHarness();
    const a = await h.prActions.dispatch({ action: 'mark_merged', prNumber: 7 });
    assert.equal(a.dispatched, false);
    const b = await h.prActions.dispatch({ action: 'show_diff', prNumber: 7 });
    assert.equal(b.dispatched, false);
});

// ---------------------------------------------------------------------------
// AC #6 — Plan-lifecycle dispatch
// ---------------------------------------------------------------------------

test('chat-plan-ops: decompose_plan requires a target', async () => {
    const h = makeHarness();
    const r = await h.planOps.dispatch({ action: 'decompose_plan' });
    assert.equal(r.dispatched, false);
});

test('chat-plan-ops: decompose_plan with target + defaultProjectId dispatches DecomposePlan', async () => {
    const h = makeHarness();
    // Re-build planOps with a defaultProjectId so the dispatch lands.
    const planOps = new ChatPlanOps({
        commandBus: h.commandBus,
        logger: new SilentLogger(),
        idGen: { newId: () => 'brief-1' },
        defaultProjectId: 'proj-a',
        planReader: { getApprovedContent: () => '# Approved plan body' },
    });
    h.commandBus.register('DecomposePlan', async (cmd) => {
        h.sent.push(cmd);
        return [];
    });

    const r = await planOps.dispatch({ action: 'decompose_plan', target: 'plan-1' });
    assert.equal(r.dispatched, true);
    assert.equal(h.sent[0]!.type, 'DecomposePlan');
    assert.deepEqual(h.sent[0]!.payload, {
        planId: 'plan-1',
        projectId: 'proj-a',
        approvedContent: '# Approved plan body',
        conventions: {},
    });
});
