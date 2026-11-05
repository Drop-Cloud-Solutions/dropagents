import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import type { Command } from '../../../core/commands/command';
import type { AgentHandle, AgentRunner, AgentSpec } from '../../../core/ports/AgentRunner';
import type { Logger } from '../../../core/ports/Logger';

import { BoardUiCommands, BoardUiEvents } from '../../board-ui/commands';
import type {
    InterruptTaskPayload,
    TaskInterruptedPayload,
} from '../../board-ui/commands';
import {
    createInterruptTaskHandler,
    registerInterruptTaskHandler,
} from './interrupt-task';

import { EventBus } from '../../../core/events/bus';
import { EventStore } from '../../../core/events/store';
import { CommandBus } from '../../../core/commands/bus';
import { applyMigrations, openDatabase } from '../../../core/state/migrations';

interface LogRecord {
    readonly level: 'info' | 'warn' | 'error' | 'debug';
    readonly message: string;
    readonly meta?: Readonly<Record<string, unknown>>;
}

function makeLogger(): { records: LogRecord[]; logger: Logger } {
    const records: LogRecord[] = [];
    const push =
        (level: LogRecord['level']) =>
        (message: string, meta?: Readonly<Record<string, unknown>>): void => {
            records.push({ level, message, meta });
        };
    return {
        records,
        logger: {
            info: push('info'),
            warn: push('warn'),
            error: push('error'),
            debug: push('debug'),
        },
    };
}

function makeHandle(id: string): AgentHandle {
    const spec: AgentSpec = { role: 'developer', prompt: 'p' };
    return { id, spec };
}

interface RecordingRunner extends Pick<AgentRunner, 'interrupt'> {
    readonly interrupted: AgentHandle[];
}

function makeRunner(throws?: Error): RecordingRunner {
    const interrupted: AgentHandle[] = [];
    return {
        interrupted,
        async interrupt(handle: AgentHandle): Promise<void> {
            interrupted.push(handle);
            if (throws) throw throws;
        },
    };
}

function makeLookup(map: Record<string, AgentHandle>) {
    return (taskId: string): AgentHandle | undefined =>
        Object.prototype.hasOwnProperty.call(map, taskId) ? map[taskId] : undefined;
}

function makeCmd(
    payload: InterruptTaskPayload,
    overrides: Partial<Command<InterruptTaskPayload>> = {},
): Command<InterruptTaskPayload> {
    return {
        type: BoardUiCommands.INTERRUPT_TASK,
        actor: 'operator-1',
        issuedAt: 1_700_000_000_000,
        payload,
        ...overrides,
    };
}

test('resolves taskId to AgentHandle, calls interrupt, and emits TaskInterrupted', async () => {
    const { logger, records } = makeLogger();
    const runner = makeRunner();
    const handle = makeHandle('claude-cli-7');
    const handler = createInterruptTaskHandler({
        clock: () => 1_700_000_000_555,
        agentRunner: runner,
        getAgentForTask: makeLookup({ 'task-A': handle }),
        logger,
    });

    const events = await handler(
        makeCmd({ taskId: 'task-A', reason: 'operator cancel' }),
        undefined,
    );

    // Exactly one interrupt call, against the resolved handle.
    assert.equal(runner.interrupted.length, 1);
    assert.strictEqual(runner.interrupted[0], handle);

    // Single TaskInterrupted event carrying taskId + actor + reason.
    assert.equal(events.length, 1);
    const ev = events[0];
    assert.equal(ev.type, BoardUiEvents.TASK_INTERRUPTED);
    assert.equal(ev.v, 1);
    assert.equal(ev.occurredAt, 1_700_000_000_555);
    assert.equal(
        ev.idempotencyKey,
        `${BoardUiCommands.INTERRUPT_TASK}:task-A:1700000000000`,
    );
    const payload = ev.payload as TaskInterruptedPayload;
    assert.equal(payload.taskId, 'task-A');
    assert.equal(payload.actor, 'operator-1');
    assert.equal(payload.reason, 'operator cancel');

    // One info line tagged with the resolved agentId + deterministic key.
    const accepted = records.find((r) => r.message.endsWith('accepted'));
    assert.ok(accepted, 'expected an "accepted" info log');
    assert.equal(accepted?.level, 'info');
    const meta = accepted?.meta as
        | { idempotencyKey?: string; agentId?: string }
        | undefined;
    assert.equal(
        meta?.idempotencyKey,
        `${BoardUiCommands.INTERRUPT_TASK}:task-A:1700000000000`,
    );
    assert.equal(meta?.agentId, 'claude-cli-7');
});

test('omits reason from the event payload when not supplied', async () => {
    const { logger } = makeLogger();
    const runner = makeRunner();
    const handler = createInterruptTaskHandler({
        clock: () => 1,
        agentRunner: runner,
        getAgentForTask: makeLookup({ 'task-B': makeHandle('a1') }),
        logger,
    });

    const events = await handler(makeCmd({ taskId: 'task-B' }), undefined);
    assert.equal(events.length, 1);
    const payload = events[0].payload as Record<string, unknown>;
    assert.equal(payload.taskId, 'task-B');
    assert.equal(payload.actor, 'operator-1');
    assert.ok(!('reason' in payload), 'reason must not be present when not supplied');
});

test('returns the typed not-found result (empty event list + warn log) for unknown taskId', async () => {
    const { logger, records } = makeLogger();
    const runner = makeRunner();
    const handler = createInterruptTaskHandler({
        clock: () => 0,
        agentRunner: runner,
        getAgentForTask: makeLookup({ 'task-known': makeHandle('a-known') }),
        logger,
    });

    // Does NOT throw — the contract is "return a not-found result".
    const events = await handler(makeCmd({ taskId: 'task-missing' }), undefined);

    // No event emitted, no interrupt call.
    assert.deepEqual(events, []);
    assert.equal(runner.interrupted.length, 0);

    // One warn line names the unknown taskId.
    const warned = records.find((r) => r.level === 'warn');
    assert.ok(warned, 'expected a warn log for the unknown taskId');
    assert.equal(
        (warned?.meta as { taskId?: string } | undefined)?.taskId,
        'task-missing',
    );
});

test('calls agentRunner.interrupt BEFORE reading the event-time clock (ordering parity with CancelAgentRun)', async () => {
    // If the event landed before the runner was signalled a subscriber
    // could observe TaskInterrupted while the underlying process is still
    // live — same ordering rule the CancelAgentRun handler enforces.
    const order: string[] = [];
    const runner: Pick<AgentRunner, 'interrupt'> = {
        async interrupt(handle: AgentHandle): Promise<void> {
            order.push(`interrupt:${handle.id}`);
        },
    };
    const handler = createInterruptTaskHandler({
        clock: () => {
            order.push('clock');
            return 42;
        },
        agentRunner: runner,
        getAgentForTask: makeLookup({ 'task-D': makeHandle('a-D') }),
        logger: makeLogger().logger,
    });

    await handler(makeCmd({ taskId: 'task-D' }), undefined);

    const interruptIdx = order.indexOf('interrupt:a-D');
    const clockIdx = order.indexOf('clock');
    assert.ok(interruptIdx >= 0 && clockIdx >= 0);
    assert.ok(
        interruptIdx < clockIdx,
        `expected runner.interrupt before event-time clock read, got ${order.join(', ')}`,
    );
});

test('rejects malformed payloads (empty taskId, wrong shape) and emits no event', async () => {
    const runner = makeRunner();
    const handler = createInterruptTaskHandler({
        clock: () => 0,
        agentRunner: runner,
        getAgentForTask: makeLookup({}),
        logger: makeLogger().logger,
    });
    await assert.rejects(
        handler(
            {
                type: BoardUiCommands.INTERRUPT_TASK,
                actor: 'o',
                issuedAt: 0,
                payload: { taskId: '' } as InterruptTaskPayload,
            },
            undefined,
        ),
        /invalid payload/,
    );
    assert.equal(runner.interrupted.length, 0);
});

test('propagates agentRunner.interrupt failures and emits no event', async () => {
    const { logger, records } = makeLogger();
    const runner = makeRunner(new Error('EBUSY: process busy'));
    const handler = createInterruptTaskHandler({
        clock: () => 0,
        agentRunner: runner,
        getAgentForTask: makeLookup({ 'task-E': makeHandle('a-E') }),
        logger,
    });

    await assert.rejects(
        handler(makeCmd({ taskId: 'task-E' }), undefined),
        /EBUSY/,
    );

    const errored = records.find((r) => r.level === 'error');
    assert.ok(errored, 'expected an error log for the failed interrupt');
    const meta = errored?.meta as { taskId?: string; agentId?: string } | undefined;
    assert.equal(meta?.taskId, 'task-E');
    assert.equal(meta?.agentId, 'a-E');
});

test('idempotencyKey is deterministic per (taskId, issuedAt)', async () => {
    const handler = createInterruptTaskHandler({
        clock: () => Date.now(),
        agentRunner: makeRunner(),
        getAgentForTask: makeLookup({ 'task-F': makeHandle('a-F') }),
        logger: makeLogger().logger,
    });
    const a = await handler(
        makeCmd({ taskId: 'task-F' }, { issuedAt: 111 }),
        undefined,
    );
    const b = await handler(
        makeCmd({ taskId: 'task-F' }, { issuedAt: 111 }),
        undefined,
    );
    assert.equal(a[0].idempotencyKey, b[0].idempotencyKey);
    assert.match(a[0].idempotencyKey, /^InterruptTask:task-F:111$/);
});

test('registerInterruptTaskHandler wires the handler onto a real CommandBus', async () => {
    // End-to-end: route a command through CommandBus.send and verify the
    // TaskInterrupted event lands on the EventStore. Catches regressions
    // where the registration string drifts from BoardUiCommands.INTERRUPT_TASK.
    const db = openDatabase(':memory:');
    applyMigrations(db);
    const { logger } = makeLogger();
    const bus = new EventBus(new EventStore(db), logger);
    const cmdBus = new CommandBus<unknown>(bus, () => undefined);
    const runner = makeRunner();
    const handle = makeHandle('a-wired');

    registerInterruptTaskHandler(cmdBus, {
        clock: () => 9_999,
        agentRunner: runner,
        getAgentForTask: makeLookup({ 'task-G': handle }),
        logger,
    });

    const stored = await cmdBus.send<InterruptTaskPayload>({
        type: BoardUiCommands.INTERRUPT_TASK,
        actor: 'operator-2',
        issuedAt: 2_000_000_000_000,
        payload: { taskId: 'task-G' },
    });

    assert.equal(stored.length, 1);
    assert.equal(stored[0].type, BoardUiEvents.TASK_INTERRUPTED);
    assert.equal(runner.interrupted.length, 1);
    assert.strictEqual(runner.interrupted[0], handle);

    // Re-registering against the same bus is a programmer error — proves the
    // registration string is canonical.
    assert.throws(
        () =>
            registerInterruptTaskHandler(cmdBus, {
                clock: () => 0,
                agentRunner: runner,
                getAgentForTask: makeLookup({}),
                logger,
            }),
        /already registered/,
    );

    db.close();
});

test('not-found path through CommandBus emits zero events (no TaskInterrupted)', async () => {
    const db = openDatabase(':memory:');
    applyMigrations(db);
    const { logger } = makeLogger();
    const bus = new EventBus(new EventStore(db), logger);
    const cmdBus = new CommandBus<unknown>(bus, () => undefined);
    const runner = makeRunner();

    registerInterruptTaskHandler(cmdBus, {
        clock: () => 0,
        agentRunner: runner,
        getAgentForTask: makeLookup({}),
        logger,
    });

    const stored = await cmdBus.send<InterruptTaskPayload>({
        type: BoardUiCommands.INTERRUPT_TASK,
        actor: 'operator-3',
        issuedAt: 1,
        payload: { taskId: 'no-such-task' },
    });

    assert.deepEqual(stored, []);
    assert.equal(runner.interrupted.length, 0);

    db.close();
});
