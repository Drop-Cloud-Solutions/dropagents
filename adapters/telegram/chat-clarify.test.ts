import { test } from 'node:test';
import assert from 'node:assert/strict';

import Database from 'better-sqlite3';

import { CommandBus } from '../../core/commands/bus';
import type { Command } from '../../core/commands/command';
import { EventBus } from '../../core/events/bus';
import { EventStore } from '../../core/events/store';
import type { Db } from '../../core/state/migrations';
import type { Logger } from '../../core/ports';
import { TaskParkingCommands } from '../../core/commands';

import { ChatClarify } from './chat-clarify';

class SilentLogger implements Logger {
    info(): void {}
    warn(): void {}
    error(): void {}
    debug(): void {}
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

function makeHarness(): {
    db: Db;
    sent: Command[];
    clarify: ChatClarify;
} {
    const db = makeDb();
    const logger = new SilentLogger();
    const eventBus = new EventBus(new EventStore(db), logger);
    const commandBus = new CommandBus<unknown>(eventBus, () => undefined);
    const sent: Command[] = [];
    commandBus.register(TaskParkingCommands.RESUME_TASK, async (cmd) => {
        sent.push(cmd);
        return [];
    });
    const clarify = new ChatClarify({
        db,
        logger,
        commandBus,
        clock: () => 1_700_000_000_000,
    });
    return { db, sent, clarify };
}

// ---------------------------------------------------------------------------
// AC #3 — Clarification reply correlation
// ---------------------------------------------------------------------------

test('recordQuestion + tryHandleReply: free-text reply resumes the parked task', async () => {
    const h = makeHarness();

    // Outbound: the gateway sent a question on chat 42, message_id 100,
    // for task t-7.
    h.clarify.recordQuestion('t-7', 42, 100);

    const handled = await h.clarify.tryHandleReply({
        chatId: 42,
        replyToMessageId: 100,
        text: 'use staging',
    });

    assert.equal(handled, true);
    assert.equal(h.sent.length, 1);
    assert.equal(h.sent[0]!.type, TaskParkingCommands.RESUME_TASK);
    assert.deepEqual(h.sent[0]!.payload, {
        taskId: 't-7',
        decision: 'approve',
        answer: 'use staging',
    });
});

test('tryHandleReply: message without replyToMessageId is not handled', async () => {
    const h = makeHarness();
    h.clarify.recordQuestion('t-7', 42, 100);

    const handled = await h.clarify.tryHandleReply({
        chatId: 42,
        text: 'hello',
    });

    assert.equal(handled, false);
    assert.equal(h.sent.length, 0);
});

test('tryHandleReply: reply to a different chat does not correlate', async () => {
    const h = makeHarness();
    h.clarify.recordQuestion('t-7', 42, 100);

    const handled = await h.clarify.tryHandleReply({
        chatId: 999,
        replyToMessageId: 100,
        text: 'use staging',
    });

    assert.equal(handled, false);
    assert.equal(h.sent.length, 0);
});

test('tryHandleReply: replies do not double-resume after clear', async () => {
    const h = makeHarness();
    h.clarify.recordQuestion('t-7', 42, 100);

    await h.clarify.tryHandleReply({
        chatId: 42,
        replyToMessageId: 100,
        text: 'first answer',
    });
    const second = await h.clarify.tryHandleReply({
        chatId: 42,
        replyToMessageId: 100,
        text: 'oops, no, the other answer',
    });

    assert.equal(second, false, 'second reply must not produce another ResumeTask');
    assert.equal(h.sent.length, 1);
});

test('recordQuestion: a second question for the same task overwrites the pointer', async () => {
    const h = makeHarness();
    h.clarify.recordQuestion('t-7', 42, 100);
    h.clarify.recordQuestion('t-7', 42, 200);

    // Reply to the older message: nothing (stale).
    const stale = await h.clarify.tryHandleReply({
        chatId: 42,
        replyToMessageId: 100,
        text: 'too late',
    });
    assert.equal(stale, false);
    assert.equal(h.sent.length, 0);

    // Reply to the newer message: dispatches.
    const fresh = await h.clarify.tryHandleReply({
        chatId: 42,
        replyToMessageId: 200,
        text: 'on time',
    });
    assert.equal(fresh, true);
    assert.equal(h.sent.length, 1);
    assert.deepEqual(h.sent[0]!.payload, {
        taskId: 't-7',
        decision: 'approve',
        answer: 'on time',
    });
});

test('recordQuestion: correlation table survives a fresh ChatClarify on the same db', async () => {
    const db = makeDb();
    const logger = new SilentLogger();
    const eventBus = new EventBus(new EventStore(db), logger);
    const commandBus = new CommandBus<unknown>(eventBus, () => undefined);
    const sent: Command[] = [];
    commandBus.register(TaskParkingCommands.RESUME_TASK, async (cmd) => {
        sent.push(cmd);
        return [];
    });

    const first = new ChatClarify({ db, logger, commandBus });
    first.recordQuestion('t-7', 42, 100);

    // Simulating a host restart: brand-new ChatClarify on the same db file
    // must see the prior record through SQLite, not via in-process state.
    const second = new ChatClarify({ db, logger, commandBus });
    const handled = await second.tryHandleReply({
        chatId: 42,
        replyToMessageId: 100,
        text: 'survived restart',
    });
    assert.equal(handled, true);
    assert.equal(sent.length, 1);
});
