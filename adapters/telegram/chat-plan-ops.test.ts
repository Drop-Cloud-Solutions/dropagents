/**
 * P-CPTO-007 — unit tests for the `decompose_plan` content-loading fix in
 * {@link ChatPlanOps}.
 *
 * A Telegram-initiated decompose used to dispatch `DecomposePlan` with
 * `approvedContent: ''` — the decomposer then ran against nothing while the
 * classifier's reply told the operator it was working. These tests pin the
 * two halves of the fix:
 *
 *   1. The approved body is loaded from the injected {@link PlanContentReader}
 *      and threaded onto the `DecomposePlan` command verbatim.
 *   2. A missing / empty plan is NOT decomposed silently — no command is
 *      dispatched and the drop is surfaced back to the operator's chat.
 *
 * Trait category: Unit. Each test stands up an in-memory SQLite handle purely
 * so a real `CommandBus` can route the command; there is no external service,
 * no network, and no spawned process.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import Database from 'better-sqlite3';

import { CommandBus } from '../../core/commands/bus';
import type { Command } from '../../core/commands/command';
import { EventBus } from '../../core/events/bus';
import { EventStore } from '../../core/events/store';
import type { Db } from '../../core/state/migrations';
import type { ChatGateway, Logger } from '../../core/ports';
import { PlanLifecycleCommands } from '../../core/commands';

import { ChatPlanOps, type PlanContentReader } from './chat-plan-ops';

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
    readonly db: Db;
    readonly commandBus: CommandBus<unknown>;
    readonly sent: Command[];
}

function makeHarness(): Harness {
    const db = makeDb();
    const logger = new SilentLogger();
    const commandBus = new CommandBus<unknown>(new EventBus(new EventStore(db), logger), () => undefined);
    const sent: Command[] = [];
    // Record every DecomposePlan the ops module dispatches. Returning [] keeps
    // the handler a pure no-op so no event has to be persisted.
    commandBus.register(PlanLifecycleCommands.DECOMPOSE_PLAN, async (cmd) => {
        sent.push(cmd);
        return [];
    });
    return { db, commandBus, sent };
}

/** A reader that always returns `content` regardless of plan id. */
function readerReturning(content: string | null): PlanContentReader {
    return { getApprovedContent: () => content };
}

// ---------------------------------------------------------------------------
// AC — the loaded plan content is threaded into the DecomposePlan command
// ---------------------------------------------------------------------------

test('[Unit] decompose_plan loads approved content and threads it into DecomposePlan', async () => {
    const h = makeHarness();
    try {
        const seenPlanIds: string[] = [];
        const planReader: PlanContentReader = {
            getApprovedContent: (planId) => {
                seenPlanIds.push(planId);
                return '# Approved plan\n\nDo the work.';
            },
        };
        const ops = new ChatPlanOps({
            commandBus: h.commandBus,
            logger: new SilentLogger(),
            idGen: { newId: () => 'brief-1' },
            defaultProjectId: 'proj-a',
            planReader,
        });

        const r = await ops.dispatch({ action: 'decompose_plan', target: 'plan-42' });

        assert.equal(r.dispatched, true);
        assert.equal(r.commandType, PlanLifecycleCommands.DECOMPOSE_PLAN);
        assert.deepEqual(seenPlanIds, ['plan-42'], 'reader queried by the plan id');
        assert.equal(h.sent.length, 1, 'exactly one DecomposePlan dispatched');
        assert.deepEqual(h.sent[0]!.payload, {
            planId: 'plan-42',
            projectId: 'proj-a',
            approvedContent: '# Approved plan\n\nDo the work.',
            conventions: {},
        });
    } finally {
        h.db.close();
    }
});

// ---------------------------------------------------------------------------
// AC — a missing plan surfaces a visible error instead of an empty decompose
// ---------------------------------------------------------------------------

test('[Unit] decompose_plan on a missing plan does NOT dispatch and notifies the operator', async () => {
    const h = makeHarness();
    try {
        const chatGateway = new RecordingChatGateway();
        const ops = new ChatPlanOps({
            commandBus: h.commandBus,
            logger: new SilentLogger(),
            idGen: { newId: () => 'brief-1' },
            defaultProjectId: 'proj-a',
            planReader: readerReturning(null),
            chatGateway,
        });

        const r = await ops.dispatch({
            action: 'decompose_plan',
            target: 'ghost-plan',
            chatId: 12345,
        });

        assert.equal(r.dispatched, false, 'no DecomposePlan dispatched');
        assert.equal(h.sent.length, 0, 'command bus saw no empty decomposition');
        assert.match(r.skipReason ?? '', /no approved content/i);
        assert.equal(chatGateway.notifications.length, 1, 'operator was told the drop happened');
        assert.equal(chatGateway.notifications[0]!.channel, '12345');
        assert.match(chatGateway.notifications[0]!.message, /ghost-plan/);
    } finally {
        h.db.close();
    }
});

// ---------------------------------------------------------------------------
// AC — an empty / whitespace body is treated the same as "no content"
// ---------------------------------------------------------------------------

test('[Unit] decompose_plan on an empty-body plan is blocked (no empty-string decompose)', async () => {
    const h = makeHarness();
    try {
        const chatGateway = new RecordingChatGateway();
        const ops = new ChatPlanOps({
            commandBus: h.commandBus,
            logger: new SilentLogger(),
            idGen: { newId: () => 'brief-1' },
            defaultProjectId: 'proj-a',
            planReader: readerReturning('   \n  '),
            chatGateway,
        });

        const r = await ops.dispatch({
            action: 'decompose_plan',
            target: 'blank-plan',
            chatId: 999,
        });

        assert.equal(r.dispatched, false);
        assert.equal(h.sent.length, 0, 'whitespace body never routes as approvedContent');
        assert.equal(chatGateway.notifications.length, 1);
    } finally {
        h.db.close();
    }
});

// ---------------------------------------------------------------------------
// The block is recorded even when no chat surface / chat id is available.
// ---------------------------------------------------------------------------

test('[Unit] decompose_plan block is recorded on the result without a chatGateway', async () => {
    const h = makeHarness();
    try {
        const ops = new ChatPlanOps({
            commandBus: h.commandBus,
            logger: new SilentLogger(),
            idGen: { newId: () => 'brief-1' },
            defaultProjectId: 'proj-a',
            planReader: readerReturning(null),
        });

        const r = await ops.dispatch({ action: 'decompose_plan', target: 'plan-1' });

        assert.equal(r.dispatched, false);
        assert.equal(h.sent.length, 0);
        assert.match(r.skipReason ?? '', /no approved content/i);
    } finally {
        h.db.close();
    }
});
