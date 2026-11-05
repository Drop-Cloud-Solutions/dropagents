import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDatabase, applyMigrations, type Db } from '../state/migrations';
import { EventStore } from '../events/store';
import { EventBus } from '../events/bus';
import { CommandBus } from '../commands/bus';
import type { Command } from '../commands/command';
import type { Event, StoredEvent } from '../events/event';
import type { Logger } from '../ports/Logger';
import type { FlowDefinition } from './types';
import { FLOW_STEP_KINDS } from './types';
import {
    FlowEngine,
    FlowEvents,
    FlowCommands,
    type StartAgentPayload,
} from './engine';
import type {
    TaskParkedEventPayload,
    TaskResumedEventPayload,
} from '../commands';
import { TaskParkingEvents } from '../commands';

// ---------------------------------------------------------------------------
// Fixtures (mirror engine.test.ts)
// ---------------------------------------------------------------------------

class FakeLogger implements Logger {
    readonly entries: Array<{ level: string; message: string; meta?: unknown }> = [];
    info(message: string, meta?: Readonly<Record<string, unknown>>): void {
        this.entries.push({ level: 'info', message, meta });
    }
    warn(message: string, meta?: Readonly<Record<string, unknown>>): void {
        this.entries.push({ level: 'warn', message, meta });
    }
    error(message: string, meta?: Readonly<Record<string, unknown>>): void {
        this.entries.push({ level: 'error', message, meta });
    }
    debug(message: string, meta?: Readonly<Record<string, unknown>>): void {
        this.entries.push({ level: 'debug', message, meta });
    }
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
        idempotencyKey: `parking-${process.pid}-${evCounter}`,
        payload,
    };
}

function seedTask(db: Db, taskId: string): void {
    const planId = `plan-${taskId}`;
    db.prepare(
        'INSERT INTO plans(id, project_id, status, created_at) VALUES (?, ?, ?, ?)',
    ).run(planId, 'proj-parking', 'approved', 1_700_000_000_000);
    db.prepare(
        'INSERT INTO tasks(id, plan_id, type, status) VALUES (?, ?, ?, ?)',
    ).run(taskId, planId, 'feature', 'approved');
}

interface Harness {
    db: Db;
    bus: EventBus;
    logger: FakeLogger;
    commands: Command[];
    parked: StoredEvent[];
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
    const logger = new FakeLogger();
    const store = new EventStore(db);
    const bus = new EventBus(store, logger);
    const cmdBus = new CommandBus<unknown>(bus, () => undefined);

    const commands: Command[] = [];
    cmdBus.register(FlowCommands.START_AGENT, recorder(commands));
    cmdBus.register(FlowCommands.FINISH_TASK, recorder(commands));
    cmdBus.register(FlowCommands.FAIL_TASK, recorder(commands));
    cmdBus.register(FlowCommands.REQUEST_INVESTIGATION, recorder(commands));

    const parked: StoredEvent[] = [];
    bus.subscribe<TaskParkedEventPayload>(TaskParkingEvents.TASK_PARKED, (e) => {
        parked.push(e);
    });

    const engine = FlowEngine.start(bus, cmdBus, flows, { db, logger });
    return { db, bus, logger, commands, parked, engine };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('AgentQuestion emits a TaskParked event with reason=clarification alongside RequestInvestigation', async () => {
    const flow: FlowDefinition = {
        on: 'task.approved',
        steps: [
            { id: 'plan', agent: 'planner', model: 'opus', on_success: 'develop' },
            { id: 'develop', agent: 'developer', model: 'sonnet', on_success: 'emit:task.finished' },
        ],
    };
    const flows = new Map<string, FlowDefinition>([['linear', flow]]);
    const { db, bus, commands, parked, engine } = makeHarness(flows);
    try {
        seedTask(db, 'task-CQ');
        await bus.publish(
            makeEvent(FlowEvents.TASK_APPROVED, { taskId: 'task-CQ', flowId: 'linear' }),
        );
        await bus.publish(makeEvent(FlowEvents.AGENT_FINISHED, { taskId: 'task-CQ' }));
        assert.equal(commands.length, 2, 'planner + developer StartAgent commands so far');

        await bus.publish(
            makeEvent(FlowEvents.AGENT_QUESTION, {
                taskId: 'task-CQ',
                question: 'which library?',
            }),
        );

        // RequestInvestigation still fires (existing default path).
        const lastCmd = commands[commands.length - 1];
        assert.equal(lastCmd.type, FlowCommands.REQUEST_INVESTIGATION);

        // TaskParked must also fire, carrying reason=clarification.
        assert.equal(parked.length, 1, 'expected exactly one TaskParked event');
        const payload = parked[0].payload as TaskParkedEventPayload;
        assert.equal(payload.taskId, 'task-CQ');
        assert.equal(payload.stepId, 'develop');
        assert.equal(payload.reason, 'clarification');
        assert.equal(payload.question, 'which library?');

        engine.stop();
    } finally {
        db.close();
    }
});

test('wait-action step parks the task: emits TaskParked(reason=wait-action), no StartAgent', async () => {
    const flow: FlowDefinition = {
        on: 'task.approved',
        steps: [
            {
                id: 'wait',
                agent: FLOW_STEP_KINDS.WAIT_ACTION,
                model: 'none',
                on_success: 'emit:task.finished',
            },
        ],
    };
    const flows = new Map<string, FlowDefinition>([['wait-only', flow]]);
    const { db, bus, commands, parked, engine } = makeHarness(flows);
    try {
        seedTask(db, 'task-W');
        await bus.publish(
            makeEvent(FlowEvents.TASK_APPROVED, { taskId: 'task-W', flowId: 'wait-only' }),
        );

        assert.equal(
            commands.filter((c) => c.type === FlowCommands.START_AGENT).length,
            0,
            'wait-action must not dispatch StartAgent',
        );
        assert.equal(parked.length, 1);
        const payload = parked[0].payload as TaskParkedEventPayload;
        assert.equal(payload.taskId, 'task-W');
        assert.equal(payload.stepId, 'wait');
        assert.equal(payload.reason, 'wait-action');

        // The step is persisted as current_step so TaskResumed can find it.
        const row = db
            .prepare('SELECT current_step FROM flow_state WHERE task_id = ?')
            .get('task-W') as { current_step: string };
        assert.equal(row.current_step, 'wait');

        engine.stop();
    } finally {
        db.close();
    }
});

test('wait-merged step uses reason=wait-merged on the TaskParked event', async () => {
    const flow: FlowDefinition = {
        on: 'task.approved',
        steps: [
            {
                id: 'wait-pr',
                agent: FLOW_STEP_KINDS.WAIT_MERGED,
                model: 'none',
                on_success: 'emit:task.finished',
            },
        ],
    };
    const flows = new Map<string, FlowDefinition>([['wm', flow]]);
    const { db, bus, parked, engine } = makeHarness(flows);
    try {
        seedTask(db, 'task-WM');
        await bus.publish(
            makeEvent(FlowEvents.TASK_APPROVED, { taskId: 'task-WM', flowId: 'wm' }),
        );

        assert.equal(parked.length, 1);
        const payload = parked[0].payload as TaskParkedEventPayload;
        assert.equal(payload.reason, 'wait-merged');

        engine.stop();
    } finally {
        db.close();
    }
});

test('TaskResumed for a wait-action step advances through on_success', async () => {
    const flow: FlowDefinition = {
        on: 'task.approved',
        steps: [
            {
                id: 'wait',
                agent: FLOW_STEP_KINDS.WAIT_ACTION,
                model: 'none',
                on_success: 'finish-agent',
            },
            {
                id: 'finish-agent',
                agent: 'developer',
                model: 'sonnet',
                on_success: 'emit:task.finished',
            },
        ],
    };
    const flows = new Map<string, FlowDefinition>([['wait-then', flow]]);
    const { db, bus, commands, parked, engine } = makeHarness(flows);
    try {
        seedTask(db, 'task-RW');
        await bus.publish(
            makeEvent(FlowEvents.TASK_APPROVED, { taskId: 'task-RW', flowId: 'wait-then' }),
        );
        assert.equal(parked.length, 1, 'parked after entering wait-action');
        assert.equal(
            commands.filter((c) => c.type === FlowCommands.START_AGENT).length,
            0,
        );

        await bus.publish(
            makeEvent(TaskParkingEvents.TASK_RESUMED, {
                taskId: 'task-RW',
                actor: 'operator-1',
                decision: 'approve',
                answer: 'go',
            } satisfies TaskResumedEventPayload),
        );

        // Engine now dispatches the developer step that follows the wait.
        const starts = commands.filter((c) => c.type === FlowCommands.START_AGENT);
        assert.equal(starts.length, 1);
        assert.equal((starts[0].payload as StartAgentPayload).stepId, 'finish-agent');

        const row = db
            .prepare('SELECT current_step FROM flow_state WHERE task_id = ?')
            .get('task-RW') as { current_step: string };
        assert.equal(row.current_step, 'finish-agent');

        engine.stop();
    } finally {
        db.close();
    }
});

test('TaskResumed after AgentQuestion re-issues StartAgent for the parked agent step with humanAnswer context', async () => {
    const flow: FlowDefinition = {
        on: 'task.approved',
        steps: [
            { id: 'plan', agent: 'planner', model: 'opus', on_success: 'develop' },
            { id: 'develop', agent: 'developer', model: 'sonnet', on_success: 'emit:task.finished' },
        ],
    };
    const flows = new Map<string, FlowDefinition>([['l', flow]]);
    const { db, bus, commands, engine } = makeHarness(flows);
    try {
        seedTask(db, 'task-CR');
        await bus.publish(
            makeEvent(FlowEvents.TASK_APPROVED, { taskId: 'task-CR', flowId: 'l' }),
        );
        await bus.publish(makeEvent(FlowEvents.AGENT_FINISHED, { taskId: 'task-CR' }));
        await bus.publish(makeEvent(FlowEvents.AGENT_QUESTION, { taskId: 'task-CR' }));
        const before = commands.length;

        await bus.publish(
            makeEvent(TaskParkingEvents.TASK_RESUMED, {
                taskId: 'task-CR',
                actor: 'op',
                decision: 'approve',
                answer: 'go with option A',
                optionKey: 'A',
            } satisfies TaskResumedEventPayload),
        );

        assert.equal(commands.length, before + 1);
        const issued = commands[commands.length - 1];
        assert.equal(issued.type, FlowCommands.START_AGENT);
        const payload = issued.payload as StartAgentPayload;
        assert.equal(payload.stepId, 'develop');
        assert.deepEqual(payload.context, {
            humanAnswer: 'go with option A',
            humanAnswerOption: 'A',
        });

        engine.stop();
    } finally {
        db.close();
    }
});

test('report-only pass-through step chains straight to on_success without StartAgent', async () => {
    // AP-VP-010: run-script and verify are no longer pass-throughs — they
    // dispatch via the ScriptRunner / HealthProbe ports. report-only is the
    // only built-in step kind that still chains through synchronously.
    const flow: FlowDefinition = {
        on: 'task.approved',
        steps: [
            {
                id: 'publish',
                agent: FLOW_STEP_KINDS.REPORT_ONLY,
                model: 'none',
                on_success: 'emit:task.finished',
            },
        ],
    };
    const flows = new Map<string, FlowDefinition>([['p', flow]]);
    const { db, bus, commands, parked, engine } = makeHarness(flows);
    try {
        seedTask(db, 'task-P');

        const finished: StoredEvent[] = [];
        bus.subscribe('task.finished', (e) => {
            finished.push(e);
        });

        await bus.publish(
            makeEvent(FlowEvents.TASK_APPROVED, { taskId: 'task-P', flowId: 'p' }),
        );

        // No StartAgent. No park.
        assert.equal(
            commands.filter((c) => c.type === FlowCommands.START_AGENT).length,
            0,
        );
        assert.equal(parked.length, 0);
        // Flow ran straight through the pass-through to the emit:.
        assert.equal(finished.length, 1);

        engine.stop();
    } finally {
        db.close();
    }
});
