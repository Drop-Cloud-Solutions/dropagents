import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { Command } from '../../core/commands/command';
import type { Logger } from '../../core/ports/Logger';

import { BoardUiCommands, BoardUiEvents } from '../board-ui/commands';
import type {
    AgentRunKiller,
    InterruptTaskPayload,
    TaskInterruptedPayload,
} from '../board-ui/commands';

import {
    createInterruptTaskHandler,
    registerInterruptTaskHandler,
    type KilledSidecarBody,
} from './handlers';

import { EventBus } from '../../core/events/bus';
import { EventStore } from '../../core/events/store';
import { CommandBus } from '../../core/commands/bus';
import { applyMigrations, openDatabase } from '../../core/state/migrations';

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

function makeTmpDir(label: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), `ap-vp-013-${label}-`));
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

function sidecarPathIn(dir: string): (agentId: string) => string {
    return (agentId): string => path.join(dir, `${agentId}.killed`);
}

test('writes the .killed sidecar BEFORE invoking the killer, with at least a timestamp', async () => {
    const sidecarDir = makeTmpDir('order');
    const sidecarFor = sidecarPathIn(sidecarDir);

    // Killer mock asserts fs state *at the moment* kill is invoked. If the
    // handler had written the sidecar asynchronously (or after the kill),
    // this `existsSync` would be `false` and the test would fail BEFORE
    // any post-hoc inspection of the filesystem.
    const observed: { existedAtKill: boolean; bodyAtKill: KilledSidecarBody | null } = {
        existedAtKill: false,
        bodyAtKill: null,
    };
    const killer: AgentRunKiller = {
        async kill(runId: string): Promise<void> {
            const p = sidecarFor(runId);
            observed.existedAtKill = fs.existsSync(p);
            if (observed.existedAtKill) {
                observed.bodyAtKill = JSON.parse(fs.readFileSync(p, 'utf8'));
            }
        },
    };

    const { logger } = makeLogger();
    const handler = createInterruptTaskHandler({
        clock: () => 1_700_000_000_555,
        agentRunKiller: killer,
        getAgentForTask: (taskId) => (taskId === 'task-A' ? 'claude-cli-7' : undefined),
        sidecarPathForAgent: sidecarFor,
        logger,
    });

    const events = await handler(
        makeCmd({ taskId: 'task-A', reason: 'operator cancel' }),
        undefined,
    );

    // AC #1 — sidecar exists at the moment kill is invoked.
    assert.equal(
        observed.existedAtKill,
        true,
        'sidecar must be on disk when AgentRunKiller.kill is invoked',
    );

    // AC #3 — sidecar carries at least a timestamp; bonus: also names the
    // agent + task + actor + reason so post-mortems can correlate.
    assert.ok(observed.bodyAtKill);
    assert.equal(typeof observed.bodyAtKill?.killedAt, 'number');
    assert.equal(observed.bodyAtKill?.killedAt, 1_700_000_000_555);
    assert.equal(observed.bodyAtKill?.agentId, 'claude-cli-7');
    assert.equal(observed.bodyAtKill?.taskId, 'task-A');
    assert.equal(observed.bodyAtKill?.actor, 'operator-1');
    assert.equal(observed.bodyAtKill?.reason, 'operator cancel');

    // TaskInterrupted is emitted after the kill — same ordering rule the
    // worker-api handler and CancelAgentRun already enforce.
    assert.equal(events.length, 1);
    const ev = events[0];
    assert.equal(ev.type, BoardUiEvents.TASK_INTERRUPTED);
    const payload = ev.payload as TaskInterruptedPayload;
    assert.equal(payload.taskId, 'task-A');
    assert.equal(payload.actor, 'operator-1');
    assert.equal(payload.reason, 'operator cancel');
});

test('sidecar path matches the runner-supplied scheme (sidecarPathForAgent)', async () => {
    // AC #2 — sidecar landing site must be the path the runner's close
    // handler will inspect. We assert by handing the handler a function
    // that returns a unique, traceable path and confirming THAT exact
    // path is the one written to.
    const sidecarDir = makeTmpDir('path');
    const uniqueFile = path.join(sidecarDir, 'sentinel-agent-99.killed');

    let pathPassed: string | undefined;
    const killer: AgentRunKiller = {
        async kill(): Promise<void> {
            /* no-op */
        },
    };
    const handler = createInterruptTaskHandler({
        clock: () => 42,
        agentRunKiller: killer,
        getAgentForTask: () => 'sentinel-agent-99',
        sidecarPathForAgent: (agentId): string => {
            const p = path.join(sidecarDir, `${agentId}.killed`);
            pathPassed = p;
            return p;
        },
        logger: makeLogger().logger,
    });

    await handler(makeCmd({ taskId: 'task-B' }), undefined);

    assert.equal(pathPassed, uniqueFile);
    assert.ok(fs.existsSync(uniqueFile), 'sidecar must land at the runner-supplied path');
});

test('returns [] and skips the sidecar write when no live agent is mapped to the task', async () => {
    const sidecarDir = makeTmpDir('not-found');
    const sidecarFor = sidecarPathIn(sidecarDir);

    let killCount = 0;
    const killer: AgentRunKiller = {
        async kill(): Promise<void> {
            killCount += 1;
        },
    };
    const { logger, records } = makeLogger();
    const handler = createInterruptTaskHandler({
        clock: () => 0,
        agentRunKiller: killer,
        getAgentForTask: () => undefined,
        sidecarPathForAgent: sidecarFor,
        logger,
    });

    const events = await handler(makeCmd({ taskId: 'task-missing' }), undefined);

    assert.deepEqual(events, []);
    assert.equal(killCount, 0);
    assert.deepEqual(fs.readdirSync(sidecarDir), []);
    assert.ok(
        records.find((r) => r.level === 'warn' && (r.meta as { taskId?: string }).taskId === 'task-missing'),
        'expected a warn log naming the unknown taskId',
    );
});

test('rejects malformed payloads without writing the sidecar or invoking the killer', async () => {
    const sidecarDir = makeTmpDir('bad-payload');
    let killCount = 0;
    const killer: AgentRunKiller = {
        async kill(): Promise<void> {
            killCount += 1;
        },
    };
    const handler = createInterruptTaskHandler({
        clock: () => 0,
        agentRunKiller: killer,
        getAgentForTask: () => 'a1',
        sidecarPathForAgent: sidecarPathIn(sidecarDir),
        logger: makeLogger().logger,
    });

    await assert.rejects(
        handler(
            {
                type: BoardUiCommands.INTERRUPT_TASK,
                actor: 'op',
                issuedAt: 0,
                payload: { taskId: '' } as InterruptTaskPayload,
            },
            undefined,
        ),
        /invalid payload/,
    );
    assert.equal(killCount, 0);
    assert.deepEqual(fs.readdirSync(sidecarDir), []);
});

test('propagates killer failures and still leaves the sidecar on disk', async () => {
    // If the kill fails after the sidecar was written, the file MUST
    // remain. A retry (operator clicks Interrupt again) would re-write
    // the sidecar with a fresh timestamp; the close handler's only
    // invariant is "sidecar present ⇒ operator intent".
    const sidecarDir = makeTmpDir('kill-fail');
    const sidecarFor = sidecarPathIn(sidecarDir);
    const killer: AgentRunKiller = {
        async kill(): Promise<void> {
            throw new Error('EBUSY: process busy');
        },
    };
    const { logger, records } = makeLogger();
    const handler = createInterruptTaskHandler({
        clock: () => 9,
        agentRunKiller: killer,
        getAgentForTask: () => 'a-busy',
        sidecarPathForAgent: sidecarFor,
        logger,
    });

    await assert.rejects(
        handler(makeCmd({ taskId: 'task-busy' }), undefined),
        /EBUSY/,
    );

    assert.ok(
        fs.existsSync(sidecarFor('a-busy')),
        'sidecar must remain on disk after a killer failure',
    );
    assert.ok(records.find((r) => r.level === 'error'), 'expected an error log');
});

test('idempotencyKey is deterministic per (taskId, issuedAt)', async () => {
    const sidecarDir = makeTmpDir('idempotent');
    const handler = createInterruptTaskHandler({
        clock: () => Date.now(),
        agentRunKiller: { async kill(): Promise<void> {} },
        getAgentForTask: () => 'a-id',
        sidecarPathForAgent: sidecarPathIn(sidecarDir),
        logger: makeLogger().logger,
    });
    const a = await handler(makeCmd({ taskId: 'task-F' }, { issuedAt: 111 }), undefined);
    const b = await handler(makeCmd({ taskId: 'task-F' }, { issuedAt: 111 }), undefined);
    assert.equal(a[0].idempotencyKey, b[0].idempotencyKey);
    assert.match(a[0].idempotencyKey, /^InterruptTask:task-F:111$/);
});

test('omits reason from sidecar body and event payload when not supplied', async () => {
    const sidecarDir = makeTmpDir('no-reason');
    const sidecarFor = sidecarPathIn(sidecarDir);
    const handler = createInterruptTaskHandler({
        clock: () => 1,
        agentRunKiller: { async kill(): Promise<void> {} },
        getAgentForTask: () => 'a-noreason',
        sidecarPathForAgent: sidecarFor,
        logger: makeLogger().logger,
    });

    const events = await handler(makeCmd({ taskId: 'task-NR' }), undefined);

    const body = JSON.parse(fs.readFileSync(sidecarFor('a-noreason'), 'utf8')) as Record<
        string,
        unknown
    >;
    assert.ok(!('reason' in body), 'reason must not be present in sidecar when not supplied');
    assert.ok(
        !('reason' in (events[0].payload as Record<string, unknown>)),
        'reason must not be present in event payload when not supplied',
    );
});

test('registerInterruptTaskHandler wires the handler onto a real CommandBus', async () => {
    const sidecarDir = makeTmpDir('registration');
    const sidecarFor = sidecarPathIn(sidecarDir);

    const db = openDatabase(':memory:');
    applyMigrations(db);
    const { logger } = makeLogger();
    const bus = new EventBus(new EventStore(db), logger);
    const cmdBus = new CommandBus<unknown>(bus, () => undefined);

    let killed: string | undefined;
    const killer: AgentRunKiller = {
        async kill(runId: string): Promise<void> {
            killed = runId;
            // Asserts the BEFORE-kill ordering end-to-end through the bus.
            assert.ok(
                fs.existsSync(sidecarFor(runId)),
                'sidecar must already exist by the time kill is dispatched through the CommandBus',
            );
        },
    };

    registerInterruptTaskHandler(cmdBus, {
        clock: () => 9_999,
        agentRunKiller: killer,
        getAgentForTask: (taskId) => (taskId === 'task-G' ? 'a-wired' : undefined),
        sidecarPathForAgent: sidecarFor,
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
    assert.equal(killed, 'a-wired');

    // Re-registering against the same bus is a programmer error — proves
    // the registration string is canonical.
    assert.throws(
        () =>
            registerInterruptTaskHandler(cmdBus, {
                clock: () => 0,
                agentRunKiller: killer,
                getAgentForTask: () => undefined,
                sidecarPathForAgent: sidecarFor,
                logger,
            }),
        /already registered/,
    );

    db.close();
});
