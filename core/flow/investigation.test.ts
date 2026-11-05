import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'path';

import { openDatabase, applyMigrations, type Db } from '../state/migrations';
import { EventStore } from '../events/store';
import { EventBus } from '../events/bus';
import { CommandBus } from '../commands/bus';
import type { Command } from '../commands/command';
import type { Event } from '../events/event';
import type { Logger } from '../ports/Logger';
import { loadFlow } from './loader';
import type { FlowDefinition } from './types';
import {
    FlowEngine,
    FlowEvents,
    FlowCommands,
    type StartAgentPayload,
    type RequestInvestigationPayload,
} from './engine';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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
        idempotencyKey: `inv-${process.pid}-${evCounter}`,
        payload,
    };
}

function seedTask(db: Db, taskId: string): void {
    const planId = `plan-${taskId}`;
    db.prepare(
        'INSERT INTO plans(id, project_id, status, created_at) VALUES (?, ?, ?, ?)',
    ).run(planId, 'proj-1', 'approved', 1_700_000_000_000);
    db.prepare(
        'INSERT INTO tasks(id, plan_id, type, status) VALUES (?, ?, ?, ?)',
    ).run(taskId, planId, 'feature', 'approved');
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

const PARENT_FLOW: FlowDefinition = {
    on: 'TaskApproved',
    steps: [
        { id: 'plan', agent: 'planner', model: 'opus', on_success: 'develop' },
        { id: 'develop', agent: 'developer', model: 'sonnet', on_success: 'review' },
        { id: 'review', agent: 'reviewer', model: 'haiku', on_success: 'emit:TaskFinished' },
    ],
};

// ---------------------------------------------------------------------------
// 1. YAML shape — investigation.yaml is itself a one-step flow
// ---------------------------------------------------------------------------

test('investigation.yaml: single investigator step that emits InvestigationCompleted', () => {
    const flow = loadFlow(
        path.resolve(__dirname, '..', '..', 'config', 'flows', 'investigation.yaml'),
    );

    assert.equal(flow.steps.length, 1, 'investigation flow must have exactly one step');
    const [only] = flow.steps;
    assert.equal(only.id, 'investigator');
    assert.equal(only.agent, 'investigator');
    // The step carries a DELIBERATE per-step model pin (the operator bumps it
    // over time — e.g. commit 472811d set it to `fable`); assert the shape,
    // not the exact id, so a model bump doesn't break this flow-shape test.
    assert.equal(typeof only.model, 'string');
    assert.notEqual(only.model, '');
    assert.equal(only.on_success, 'emit:InvestigationCompleted');
});

// ---------------------------------------------------------------------------
// 2. Pause: AgentQuestion (default branch) writes paused_step
// ---------------------------------------------------------------------------

test('AgentQuestion default branch records paused_step in flow_state', async () => {
    const flows = new Map<string, FlowDefinition>([['parent', PARENT_FLOW]]);
    const { db, bus, commands, engine } = makeHarness(flows);
    try {
        seedTask(db, 'task-pause');
        await bus.publish(
            makeEvent(FlowEvents.TASK_APPROVED, {
                taskId: 'task-pause',
                flowId: 'parent',
            }),
        );
        await bus.publish(
            makeEvent(FlowEvents.AGENT_FINISHED, { taskId: 'task-pause' }),
        );
        // Now sitting on 'develop'.

        await bus.publish(
            makeEvent(FlowEvents.AGENT_QUESTION, {
                taskId: 'task-pause',
                question: 'which schema?',
            }),
        );

        // Engine emits RequestInvestigation with develop as resume target.
        const inv = commands.find(
            (c) => c.type === FlowCommands.REQUEST_INVESTIGATION,
        );
        assert.ok(inv, 'engine must emit RequestInvestigation');
        assert.equal(
            (inv!.payload as RequestInvestigationPayload).resumeStep,
            'develop',
        );

        const fs = db
            .prepare(
                'SELECT current_step, paused_step FROM flow_state WHERE task_id = ?',
            )
            .get('task-pause') as { current_step: string; paused_step: string | null };
        assert.equal(fs.paused_step, 'develop', 'paused_step must record the parent step');
        assert.equal(
            fs.current_step,
            'develop',
            'current_step also unchanged so legacy resume still works',
        );

        engine.stop();
    } finally {
        db.close();
    }
});

// ---------------------------------------------------------------------------
// 3. Resume: InvestigationCompleted reads paused_step
// ---------------------------------------------------------------------------

test('InvestigationCompleted reads paused_step and re-emits the parent step', async () => {
    const flows = new Map<string, FlowDefinition>([['parent', PARENT_FLOW]]);
    const { db, bus, commands, engine } = makeHarness(flows);
    try {
        seedTask(db, 'task-resume');
        await bus.publish(
            makeEvent(FlowEvents.TASK_APPROVED, {
                taskId: 'task-resume',
                flowId: 'parent',
            }),
        );
        await bus.publish(
            makeEvent(FlowEvents.AGENT_FINISHED, { taskId: 'task-resume' }),
        );
        await bus.publish(
            makeEvent(FlowEvents.AGENT_QUESTION, { taskId: 'task-resume' }),
        );

        // Simulate something else having advanced current_step while the
        // sub-flow ran. The resume must still target paused_step ('develop'),
        // not current_step. Use 'review' so it's a valid step in the parent
        // flow — invalid current_step would short-circuit readActive entirely
        // and mask the assertion under test.
        db.prepare(
            'UPDATE flow_state SET current_step = ? WHERE task_id = ?',
        ).run('review', 'task-resume');

        const before = commands.length;
        await bus.publish(
            makeEvent(FlowEvents.INVESTIGATION_COMPLETED, {
                taskId: 'task-resume',
            }),
        );

        assert.equal(commands.length, before + 1);
        const resumeCmd = commands[commands.length - 1];
        assert.equal(resumeCmd.type, FlowCommands.START_AGENT);
        const payload = resumeCmd.payload as StartAgentPayload;
        assert.equal(payload.stepId, 'develop', 'resume must use paused_step');
        assert.equal(payload.agent, 'developer');

        const fs = db
            .prepare(
                'SELECT current_step, paused_step FROM flow_state WHERE task_id = ?',
            )
            .get('task-resume') as { current_step: string; paused_step: string | null };
        assert.equal(
            fs.paused_step,
            null,
            'paused_step must be cleared once the resume StartAgent is dispatched',
        );
        assert.equal(fs.current_step, 'develop');

        engine.stop();
    } finally {
        db.close();
    }
});

// ---------------------------------------------------------------------------
// 4. Answer threading
// ---------------------------------------------------------------------------

test('investigation answer is threaded into the resumed StartAgent context', async () => {
    const flows = new Map<string, FlowDefinition>([['parent', PARENT_FLOW]]);
    const { db, bus, commands, engine } = makeHarness(flows);
    try {
        seedTask(db, 'task-answer');
        await bus.publish(
            makeEvent(FlowEvents.TASK_APPROVED, {
                taskId: 'task-answer',
                flowId: 'parent',
            }),
        );
        await bus.publish(
            makeEvent(FlowEvents.AGENT_FINISHED, { taskId: 'task-answer' }),
        );
        await bus.publish(
            makeEvent(FlowEvents.AGENT_QUESTION, {
                taskId: 'task-answer',
                question: 'which migration tool?',
            }),
        );

        const before = commands.length;
        await bus.publish(
            makeEvent(FlowEvents.INVESTIGATION_COMPLETED, {
                taskId: 'task-answer',
                answer: 'use sqitch',
            }),
        );

        assert.equal(commands.length, before + 1);
        const payload = commands[commands.length - 1].payload as StartAgentPayload;
        assert.deepEqual(payload.context, { investigationAnswer: 'use sqitch' });
        assert.equal(payload.stepId, 'develop');

        engine.stop();
    } finally {
        db.close();
    }
});

test('InvestigationCompleted without an answer omits context (no empty object)', async () => {
    const flows = new Map<string, FlowDefinition>([['parent', PARENT_FLOW]]);
    const { db, bus, commands, engine } = makeHarness(flows);
    try {
        seedTask(db, 'task-noctx');
        await bus.publish(
            makeEvent(FlowEvents.TASK_APPROVED, {
                taskId: 'task-noctx',
                flowId: 'parent',
            }),
        );
        await bus.publish(
            makeEvent(FlowEvents.AGENT_FINISHED, { taskId: 'task-noctx' }),
        );
        await bus.publish(
            makeEvent(FlowEvents.AGENT_QUESTION, { taskId: 'task-noctx' }),
        );
        await bus.publish(
            makeEvent(FlowEvents.INVESTIGATION_COMPLETED, { taskId: 'task-noctx' }),
        );

        const resumeCmd = commands[commands.length - 1];
        const payload = resumeCmd.payload as StartAgentPayload;
        assert.equal(
            payload.context,
            undefined,
            'no answer means no context — older consumers stay unaffected',
        );

        engine.stop();
    } finally {
        db.close();
    }
});

// ---------------------------------------------------------------------------
// 5. Sequential investigations from the same task
// ---------------------------------------------------------------------------

test('two AgentQuestion → InvestigationCompleted cycles in a row resume cleanly', async () => {
    const flows = new Map<string, FlowDefinition>([['parent', PARENT_FLOW]]);
    const { db, bus, commands, engine } = makeHarness(flows);
    try {
        seedTask(db, 'task-seq');
        await bus.publish(
            makeEvent(FlowEvents.TASK_APPROVED, {
                taskId: 'task-seq',
                flowId: 'parent',
            }),
        );
        await bus.publish(
            makeEvent(FlowEvents.AGENT_FINISHED, { taskId: 'task-seq' }),
        );
        // Sitting on 'develop'.

        // First investigation cycle.
        await bus.publish(
            makeEvent(FlowEvents.AGENT_QUESTION, {
                taskId: 'task-seq',
                question: 'q1',
            }),
        );
        await bus.publish(
            makeEvent(FlowEvents.INVESTIGATION_COMPLETED, {
                taskId: 'task-seq',
                answer: 'a1',
            }),
        );

        // Second investigation cycle (still on develop after resume).
        await bus.publish(
            makeEvent(FlowEvents.AGENT_QUESTION, {
                taskId: 'task-seq',
                question: 'q2',
            }),
        );
        await bus.publish(
            makeEvent(FlowEvents.INVESTIGATION_COMPLETED, {
                taskId: 'task-seq',
                answer: 'a2',
            }),
        );

        // Two RequestInvestigation commands, one per question.
        const investigations = commands.filter(
            (c) => c.type === FlowCommands.REQUEST_INVESTIGATION,
        );
        assert.equal(investigations.length, 2);
        for (const inv of investigations) {
            assert.equal(
                (inv.payload as RequestInvestigationPayload).resumeStep,
                'develop',
                'each pause records develop as the resume target',
            );
        }

        // Two resume StartAgents for develop, each carrying its own answer.
        const resumes = commands.filter(
            (c) =>
                c.type === FlowCommands.START_AGENT &&
                (c.payload as StartAgentPayload).stepId === 'develop' &&
                (c.payload as StartAgentPayload).context !== undefined,
        );
        assert.equal(resumes.length, 2);
        assert.deepEqual(
            (resumes[0].payload as StartAgentPayload).context,
            { investigationAnswer: 'a1' },
        );
        assert.deepEqual(
            (resumes[1].payload as StartAgentPayload).context,
            { investigationAnswer: 'a2' },
        );

        const fs = db
            .prepare(
                'SELECT current_step, paused_step FROM flow_state WHERE task_id = ?',
            )
            .get('task-seq') as { current_step: string; paused_step: string | null };
        assert.equal(
            fs.paused_step,
            null,
            'final resume must leave paused_step NULL so a stale marker cannot leak into later flows',
        );
        assert.equal(fs.current_step, 'develop');

        engine.stop();
    } finally {
        db.close();
    }
});

// ---------------------------------------------------------------------------
// 6. Explicit resumeStep override still wins (regression guard)
// ---------------------------------------------------------------------------

test('explicit payload.resumeStep overrides paused_step on resume', async () => {
    const flows = new Map<string, FlowDefinition>([['parent', PARENT_FLOW]]);
    const { db, bus, commands, engine } = makeHarness(flows);
    try {
        seedTask(db, 'task-override');
        await bus.publish(
            makeEvent(FlowEvents.TASK_APPROVED, {
                taskId: 'task-override',
                flowId: 'parent',
            }),
        );
        await bus.publish(
            makeEvent(FlowEvents.AGENT_FINISHED, { taskId: 'task-override' }),
        );
        await bus.publish(
            makeEvent(FlowEvents.AGENT_QUESTION, { taskId: 'task-override' }),
        );

        await bus.publish(
            makeEvent(FlowEvents.INVESTIGATION_COMPLETED, {
                taskId: 'task-override',
                resumeStep: 'plan',
                answer: 'go back to planning',
            }),
        );

        const last = commands[commands.length - 1];
        const payload = last.payload as StartAgentPayload;
        assert.equal(payload.stepId, 'plan');
        assert.deepEqual(payload.context, {
            investigationAnswer: 'go back to planning',
        });

        engine.stop();
    } finally {
        db.close();
    }
});
