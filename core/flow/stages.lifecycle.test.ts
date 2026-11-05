/**
 * AP-IFG-004: lifecycle stage tests for commit-approval and pr-ready.
 *
 * Both flows are loaded from their YAML at config/flows/, so this test
 * exercises the loader, the registered stage handlers in `engine.ts`,
 * and the corresponding emit: terminals end-to-end:
 *
 *   commit-approval — TaskCreated parks the task (TaskParked, reason
 *                     wait-action) at the `commit-approval` step. A
 *                     subsequent TaskResumed drives on_success → emit
 *                     `CommitReady`.
 *   pr-ready        — TaskCreated chains synchronously through the
 *                     `pr-ready` pass-through step to emit `PrReady`.
 *
 * Dual-runner discovery
 * ---------------------
 * Mirrors the shim used by engine.start-mode.test.ts so the file is
 * discoverable by both `node --test` (the repo's `npm test`) and vitest
 * (the review pipeline). See engine.start-mode.test.ts header for the
 * rationale.
 */

import * as assert from 'node:assert/strict';
import * as path from 'path';

import { openDatabase, applyMigrations, type Db } from '../state/migrations';
import { EventStore } from '../events/store';
import { EventBus } from '../events/bus';
import { CommandBus } from '../commands/bus';
import type { Command } from '../commands/command';
import type { Event, StoredEvent } from '../events/event';
import type { Logger } from '../ports/Logger';
import { loadFlow } from './loader';
import type { FlowDefinition } from './types';
import {
    FlowEngine,
    FlowEvents,
    FlowCommands,
    LifecycleEvents,
    LIFECYCLE_STEP_KINDS,
} from './engine';
import { TaskParkingEvents } from '../commands';
import type { TaskParkedEventPayload } from '../commands';

// ---------------------------------------------------------------------------
// Dual-runner test() shim
// ---------------------------------------------------------------------------

type TestFn = (name: string, fn: () => void | Promise<void>) => void;

const test: TestFn = (((): TestFn => {
    if (process.env.VITEST) {
        const gt = (globalThis as { test?: TestFn }).test;
        if (typeof gt !== 'function') {
            throw new Error(
                'stages.lifecycle.test.ts: VITEST=true but globalThis.test is missing — '
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
// Fixtures
// ---------------------------------------------------------------------------

const FLOWS_DIR = path.join(__dirname, '..', '..', 'config', 'flows');
const COMMIT_APPROVAL_FLOW_ID = 'commit-approval';
const PR_READY_FLOW_ID = 'pr-ready';

class SilentLogger implements Logger {
    info(): void {}
    warn(): void {}
    error(): void {}
    debug(): void {}
}

function freshDb(): Db {
    const db = openDatabase(':memory:');
    applyMigrations(db);
    return db;
}

let evCounter = 0;
function makeEvent(type: string, payload: unknown): Event {
    evCounter++;
    return {
        type,
        v: 1,
        occurredAt: 1_700_000_000_000,
        idempotencyKey: `lc-${process.pid}-${evCounter}`,
        payload,
    };
}

function seedTask(db: Db, taskId: string): void {
    const planId = `plan-${taskId}`;
    db.prepare(
        'INSERT INTO plans(id, project_id, status, created_at) VALUES (?, ?, ?, ?)',
    ).run(planId, 'proj-lifecycle', 'approved', 1_700_000_000_000);
    db.prepare(
        'INSERT INTO tasks(id, plan_id, type, status) VALUES (?, ?, ?, ?)',
    ).run(taskId, planId, 'feature', 'created');
}

interface Harness {
    db: Db;
    bus: EventBus;
    commands: Command[];
    engine: FlowEngine;
}

function recorder(commands: Command[]): (cmd: Command) => Promise<Event[]> {
    return async (cmd) => {
        commands.push(cmd);
        return [];
    };
}

function makeHarness(flows: ReadonlyMap<string, FlowDefinition>): Harness {
    const db = freshDb();
    const logger = new SilentLogger();
    const store = new EventStore(db);
    const bus = new EventBus(store, logger);
    const cmdBus = new CommandBus<unknown>(bus, () => undefined);
    const commands: Command[] = [];
    cmdBus.register(FlowCommands.START_AGENT, recorder(commands));
    cmdBus.register(FlowCommands.FINISH_TASK, recorder(commands));
    cmdBus.register(FlowCommands.FAIL_TASK, recorder(commands));
    cmdBus.register(FlowCommands.REQUEST_INVESTIGATION, recorder(commands));
    const engine = FlowEngine.start(bus, cmdBus, flows, { db, logger });
    return { db, bus, commands, engine };
}

// ---------------------------------------------------------------------------
// 1. YAML shape — both flows load and have the expected structure
// ---------------------------------------------------------------------------

test('commit-approval.yaml: start_mode auto, single commit-approval step emitting CommitReady', () => {
    const flow = loadFlow(path.join(FLOWS_DIR, 'commit-approval.yaml'));
    assert.equal(flow.start_mode, 'auto');
    assert.equal(flow.steps.length, 1);
    assert.equal(flow.steps[0].agent, LIFECYCLE_STEP_KINDS.COMMIT_APPROVAL);
    assert.equal(flow.steps[0].on_success, `emit:${LifecycleEvents.COMMIT_READY}`);
});

test('pr-ready.yaml: start_mode auto, single pr-ready step emitting PrReady', () => {
    const flow = loadFlow(path.join(FLOWS_DIR, 'pr-ready.yaml'));
    assert.equal(flow.start_mode, 'auto');
    assert.equal(flow.steps.length, 1);
    assert.equal(flow.steps[0].agent, LIFECYCLE_STEP_KINDS.PR_READY);
    assert.equal(flow.steps[0].on_success, `emit:${LifecycleEvents.PR_READY}`);
});

// ---------------------------------------------------------------------------
// 2. commit-approval: TaskCreated parks, TaskResumed emits CommitReady
// ---------------------------------------------------------------------------

test('commit-approval flow: TaskCreated parks the task; TaskResumed emits CommitReady', async () => {
    const flow = loadFlow(path.join(FLOWS_DIR, 'commit-approval.yaml'));
    const flows = new Map<string, FlowDefinition>([[COMMIT_APPROVAL_FLOW_ID, flow]]);
    const { db, bus, commands, engine } = makeHarness(flows);
    try {
        seedTask(db, 'task-CA');

        const parked: StoredEvent[] = [];
        bus.subscribe<TaskParkedEventPayload>(TaskParkingEvents.TASK_PARKED, (e) => {
            parked.push(e);
        });
        const commitReady: StoredEvent[] = [];
        bus.subscribe(LifecycleEvents.COMMIT_READY, (e) => {
            commitReady.push(e);
        });

        await bus.publish(
            makeEvent(FlowEvents.TASK_CREATED, {
                taskId: 'task-CA',
                flowId: COMMIT_APPROVAL_FLOW_ID,
            }),
        );

        // Stage parked the task — no StartAgent, no CommitReady yet.
        const starts = commands.filter((c) => c.type === FlowCommands.START_AGENT);
        assert.equal(starts.length, 0, 'commit-approval is not an agent step');
        assert.equal(parked.length, 1, 'TaskParked must be published on entry');
        const parkedPayload = parked[0].payload as TaskParkedEventPayload;
        assert.equal(parkedPayload.taskId, 'task-CA');
        assert.equal(parkedPayload.stepId, flow.steps[0].id);
        assert.equal(parkedPayload.reason, 'wait-action');
        assert.equal(commitReady.length, 0, 'CommitReady must not fire before resume');

        // flow_state captures the parked step.
        const fsRow = db
            .prepare('SELECT current_step FROM flow_state WHERE task_id = ?')
            .get('task-CA') as { current_step: string } | undefined;
        assert.equal(fsRow?.current_step, flow.steps[0].id);

        // Operator resumes — engine chains through on_success and emits.
        await bus.publish(
            makeEvent(TaskParkingEvents.TASK_RESUMED, {
                taskId: 'task-CA',
                actor: 'operator-1',
            }),
        );

        assert.equal(commitReady.length, 1, 'CommitReady must be emitted on resume');
        assert.deepEqual(commitReady[0].payload, { taskId: 'task-CA' });

        engine.stop();
    } finally {
        db.close();
    }
});

// ---------------------------------------------------------------------------
// 3. pr-ready: TaskCreated chains synchronously to emit PrReady
// ---------------------------------------------------------------------------

test('pr-ready flow: TaskCreated drives the pass-through stage and emits PrReady', async () => {
    const flow = loadFlow(path.join(FLOWS_DIR, 'pr-ready.yaml'));
    const flows = new Map<string, FlowDefinition>([[PR_READY_FLOW_ID, flow]]);
    const { db, bus, commands, engine } = makeHarness(flows);
    try {
        seedTask(db, 'task-PR');

        const prReady: StoredEvent[] = [];
        bus.subscribe(LifecycleEvents.PR_READY, (e) => {
            prReady.push(e);
        });
        const parked: StoredEvent[] = [];
        bus.subscribe(TaskParkingEvents.TASK_PARKED, (e) => {
            parked.push(e);
        });

        await bus.publish(
            makeEvent(FlowEvents.TASK_CREATED, {
                taskId: 'task-PR',
                flowId: PR_READY_FLOW_ID,
            }),
        );

        const starts = commands.filter((c) => c.type === FlowCommands.START_AGENT);
        assert.equal(starts.length, 0, 'pr-ready is not an agent step');
        assert.equal(parked.length, 0, 'pr-ready must not park the task');
        assert.equal(prReady.length, 1, 'PrReady must be emitted on TaskCreated');
        assert.deepEqual(prReady[0].payload, { taskId: 'task-PR' });

        const fsRow = db
            .prepare('SELECT current_step FROM flow_state WHERE task_id = ?')
            .get('task-PR') as { current_step: string } | undefined;
        assert.equal(fsRow?.current_step, flow.steps[0].id);

        engine.stop();
    } finally {
        db.close();
    }
});

// ---------------------------------------------------------------------------
// 4. Approval-required start_mode: TaskCreated is a no-op for both flows
//    (regression guard — these flows are explicitly auto)
// ---------------------------------------------------------------------------

test('commit-approval flow with start_mode auto fires on TaskCreated, not TaskApproved', async () => {
    const flow = loadFlow(path.join(FLOWS_DIR, 'commit-approval.yaml'));
    const flows = new Map<string, FlowDefinition>([[COMMIT_APPROVAL_FLOW_ID, flow]]);
    const { db, bus, engine } = makeHarness(flows);
    try {
        seedTask(db, 'task-CA2');

        const parked: StoredEvent[] = [];
        bus.subscribe(TaskParkingEvents.TASK_PARKED, (e) => {
            parked.push(e);
        });

        // A duplicate TaskApproved arriving after TaskCreated must not
        // double-park the task — same guarantee start_mode auto gives
        // to existing flows.
        await bus.publish(
            makeEvent(FlowEvents.TASK_CREATED, {
                taskId: 'task-CA2',
                flowId: COMMIT_APPROVAL_FLOW_ID,
            }),
        );
        assert.equal(parked.length, 1);

        await bus.publish(
            makeEvent(FlowEvents.TASK_APPROVED, {
                taskId: 'task-CA2',
                flowId: COMMIT_APPROVAL_FLOW_ID,
            }),
        );
        assert.equal(parked.length, 1, 'TaskApproved must not double-park an auto flow');

        engine.stop();
    } finally {
        db.close();
    }
});
