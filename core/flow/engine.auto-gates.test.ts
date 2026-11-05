/**
 * commit-auto / merge-auto — the approval-skipping gate variants.
 *
 *   1. `merge-auto` parks exactly like wait-merged (reason=wait-merged, no
 *      StartAgent, step persisted for the resume path) AND publishes
 *      `AutoMergeRequested {taskId, stepId}` so the orchestrator can run
 *      the merge.
 *   2. `commit-auto` never parks: the flow chains straight through to
 *      on_success (a StartAgent for the next step fires immediately).
 *   3. Approval defaults: both kinds default to 'auto' — dropping one
 *      into a flow must not re-introduce the approval gate it removes.
 */
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
import {
    BUILT_IN_APPROVAL_DEFAULTS,
    FLOW_STEP_KINDS,
    isPassThroughStepKind,
    isWaitStepKind,
} from './types';
import { FlowCommands, FlowEngine, FlowEvents } from './engine';
import type { TaskParkedEventPayload } from '../commands';
import { TaskParkingEvents } from '../commands';

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
        idempotencyKey: `auto-gates-${process.pid}-${evCounter}`,
        payload,
    };
}

function seedTask(db: Db, taskId: string): void {
    const planId = `plan-${taskId}`;
    db.prepare(
        'INSERT INTO plans(id, project_id, status, created_at) VALUES (?, ?, ?, ?)',
    ).run(planId, 'proj-auto', 'approved', 1_700_000_000_000);
    db.prepare(
        'INSERT INTO tasks(id, plan_id, type, status) VALUES (?, ?, ?, ?)',
    ).run(taskId, planId, 'feature', 'approved');
}

interface Harness {
    db: Db;
    bus: EventBus;
    commands: Command[];
    parked: StoredEvent[];
    autoMerges: StoredEvent[];
    engine: FlowEngine;
}

function makeHarness(flows: ReadonlyMap<string, FlowDefinition>): Harness {
    const db = freshDb();
    const logger = new SilentLogger();
    const bus = new EventBus(new EventStore(db), logger);
    const cmdBus = new CommandBus<unknown>(bus, () => undefined);
    const commands: Command[] = [];
    const record = async (cmd: Command): Promise<Event[]> => {
        commands.push(cmd);
        return [];
    };
    cmdBus.register(FlowCommands.START_AGENT, record);
    cmdBus.register(FlowCommands.FINISH_TASK, record);
    cmdBus.register(FlowCommands.FAIL_TASK, record);
    cmdBus.register(FlowCommands.REQUEST_INVESTIGATION, record);

    const parked: StoredEvent[] = [];
    bus.subscribe<TaskParkedEventPayload>(TaskParkingEvents.TASK_PARKED, (e) => {
        parked.push(e);
    });
    const autoMerges: StoredEvent[] = [];
    bus.subscribe(FlowEvents.AUTO_MERGE_REQUESTED, (e) => {
        autoMerges.push(e);
    });

    const engine = FlowEngine.start(bus, cmdBus, flows, { db, logger });
    return { db, bus, commands, parked, autoMerges, engine };
}

test('merge-auto parks as wait-merged and publishes AutoMergeRequested', async () => {
    const flow: FlowDefinition = {
        on: 'task.approved',
        steps: [
            {
                id: 'merge',
                agent: FLOW_STEP_KINDS.MERGE_AUTO,
                model: 'none',
                on_success: 'emit:task.finished',
            },
        ],
    };
    const flows = new Map<string, FlowDefinition>([['auto-merge-flow', flow]]);
    const h = makeHarness(flows);
    try {
        seedTask(h.db, 'task-AM');
        await h.bus.publish(
            makeEvent(FlowEvents.TASK_APPROVED, {
                taskId: 'task-AM',
                flowId: 'auto-merge-flow',
            }),
        );

        assert.equal(
            h.commands.filter((c) => c.type === FlowCommands.START_AGENT).length,
            0,
            'merge-auto must not dispatch StartAgent',
        );
        assert.equal(h.parked.length, 1);
        const payload = h.parked[0]!.payload as TaskParkedEventPayload;
        assert.equal(payload.reason, 'wait-merged', 'same park state as wait-merged');
        assert.equal(payload.stepId, 'merge');

        assert.equal(h.autoMerges.length, 1, 'AutoMergeRequested published');
        const am = h.autoMerges[0]!.payload as { taskId?: string; stepId?: string };
        assert.equal(am.taskId, 'task-AM');
        assert.equal(am.stepId, 'merge');

        // Step persisted so MergeTaskPr's ResumeTask finds the park target.
        const row = h.db
            .prepare('SELECT current_step FROM flow_state WHERE task_id = ?')
            .get('task-AM') as { current_step: string };
        assert.equal(row.current_step, 'merge');
        h.engine.stop();
    } finally {
        h.db.close();
    }
});

test('plain wait-merged does NOT publish AutoMergeRequested', async () => {
    const flow: FlowDefinition = {
        on: 'task.approved',
        steps: [
            {
                id: 'merge',
                agent: FLOW_STEP_KINDS.WAIT_MERGED,
                model: 'none',
                on_success: 'emit:task.finished',
            },
        ],
    };
    const flows = new Map<string, FlowDefinition>([['manual-merge-flow', flow]]);
    const h = makeHarness(flows);
    try {
        seedTask(h.db, 'task-MM');
        await h.bus.publish(
            makeEvent(FlowEvents.TASK_APPROVED, {
                taskId: 'task-MM',
                flowId: 'manual-merge-flow',
            }),
        );
        assert.equal(h.parked.length, 1);
        assert.equal(h.autoMerges.length, 0);
        h.engine.stop();
    } finally {
        h.db.close();
    }
});

test('commit-auto chains straight through to the next step without parking', async () => {
    const flow: FlowDefinition = {
        on: 'task.approved',
        steps: [
            {
                id: 'human-review',
                agent: FLOW_STEP_KINDS.COMMIT_AUTO,
                model: 'none',
                on_success: 'commit',
            },
            {
                id: 'commit',
                agent: 'committer',
                model: 'haiku',
                on_success: 'emit:task.finished',
            },
        ],
    };
    const flows = new Map<string, FlowDefinition>([['auto-commit-flow', flow]]);
    const h = makeHarness(flows);
    try {
        seedTask(h.db, 'task-AC');
        await h.bus.publish(
            makeEvent(FlowEvents.TASK_APPROVED, {
                taskId: 'task-AC',
                flowId: 'auto-commit-flow',
            }),
        );
        assert.equal(h.parked.length, 0, 'commit-auto never parks');
        const starts = h.commands.filter((c) => c.type === FlowCommands.START_AGENT);
        assert.equal(starts.length, 1, 'chained straight into the committer');
        h.engine.stop();
    } finally {
        h.db.close();
    }
});

test('kind classification and approval defaults for the auto variants', () => {
    assert.equal(isWaitStepKind(FLOW_STEP_KINDS.MERGE_AUTO), true);
    assert.equal(isWaitStepKind(FLOW_STEP_KINDS.COMMIT_AUTO), false);
    assert.equal(isPassThroughStepKind(FLOW_STEP_KINDS.COMMIT_AUTO), true);
    assert.equal(BUILT_IN_APPROVAL_DEFAULTS[FLOW_STEP_KINDS.COMMIT_AUTO], 'auto');
    assert.equal(BUILT_IN_APPROVAL_DEFAULTS[FLOW_STEP_KINDS.MERGE_AUTO], 'auto');
});
