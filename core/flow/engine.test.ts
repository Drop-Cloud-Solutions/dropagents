import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { openDatabase, applyMigrations, type Db } from '../state/migrations';
import { EventStore } from '../events/store';
import { EventBus } from '../events/bus';
import { CommandBus } from '../commands/bus';
import type { Command } from '../commands/command';
import type { Event, StoredEvent } from '../events/event';
import type { Logger } from '../ports/Logger';
import type { FlowDefinition } from './types';
import type {
    MergePullRequestOptions,
    OpenPullRequestSpec,
    OpenedPullRequest,
    PullRequestGateway,
} from '../ports/pull-request-gateway';
import {
    FlowEngine,
    FlowEvents,
    FlowCommands,
    FLOW_ENGINE_SUBSCRIBER,
    PR_STEP_TYPES,
    buildTaskFailedPayload,
    type FlowEngineOptions,
    type StartAgentPayload,
    type RequestInvestigationPayload,
    type FailTaskPayload,
    type TaskFailedEventPayload,
} from './engine';

// ---------------------------------------------------------------------------
// Test fixtures
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
        idempotencyKey: `t-${process.pid}-${evCounter}`,
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
    logger: FakeLogger;
    cmdBus: CommandBus<unknown>;
    commands: Command[];
    engine: FlowEngine;
}

function recorder(commands: Command[]): (cmd: Command) => Promise<Event[]> {
    return async (cmd) => {
        commands.push(cmd);
        return [];
    };
}

function makeHarness(
    flows: ReadonlyMap<string, FlowDefinition>,
    extra: Partial<Pick<FlowEngineOptions, 'prGateway'>> = {},
): Harness {
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

    const engine = FlowEngine.start(bus, cmdBus, flows, {
        db,
        logger,
        prGateway: extra.prGateway,
    });

    return { db, bus, logger, cmdBus, commands, engine };
}

interface PrGatewayCall {
    readonly method: 'push' | 'openPullRequest' | 'mergePullRequest' | 'addComment';
    readonly args: unknown;
}

class FakePullRequestGateway implements PullRequestGateway {
    readonly calls: PrGatewayCall[] = [];
    private nextNumber = 100;

    async push(branch: string): Promise<void> {
        this.calls.push({ method: 'push', args: { branch } });
    }
    async openPullRequest(spec: OpenPullRequestSpec): Promise<OpenedPullRequest> {
        this.calls.push({ method: 'openPullRequest', args: spec });
        const number = this.nextNumber++;
        return { number, url: `https://fake.invalid/pull/${number}` };
    }
    async mergePullRequest(
        number: number,
        options: MergePullRequestOptions,
    ): Promise<void> {
        this.calls.push({ method: 'mergePullRequest', args: { number, options } });
    }
    async addComment(number: number, body: string): Promise<void> {
        this.calls.push({ method: 'addComment', args: { number, body } });
    }
}

const LINEAR_FLOW: FlowDefinition = {
    on: 'task.approved',
    steps: [
        { id: 'plan', agent: 'planner', model: 'opus', on_success: 'develop' },
        { id: 'develop', agent: 'developer', model: 'sonnet', on_success: 'review' },
        { id: 'review', agent: 'reviewer', model: 'haiku', on_success: 'emit:task.finished' },
    ],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('FlowEngine.start registers a named subscriber called "flow-engine"', async () => {
    const flows = new Map<string, FlowDefinition>([['linear', LINEAR_FLOW]]);
    const { db, bus, engine } = makeHarness(flows);
    try {
        seedTask(db, 'task-1');

        // After processing one event, the offset for our subscriber should
        // have advanced — which is only possible if the subscriber is named.
        const stored = await bus.publish(
            makeEvent(FlowEvents.TASK_APPROVED, { taskId: 'task-1', flowId: 'linear' }),
        );

        const store = new EventStore(db);
        assert.equal(store.getSubscriberOffset(FLOW_ENGINE_SUBSCRIBER), stored.seq);

        engine.stop();
    } finally {
        db.close();
    }
});

test('TaskApproved writes a flow_state row and emits StartAgent for step 1', async () => {
    const flows = new Map<string, FlowDefinition>([['linear', LINEAR_FLOW]]);
    const { db, bus, commands, engine } = makeHarness(flows);
    try {
        seedTask(db, 'task-A');

        await bus.publish(
            makeEvent(FlowEvents.TASK_APPROVED, { taskId: 'task-A', flowId: 'linear' }),
        );

        assert.equal(commands.length, 1);
        assert.equal(commands[0].type, FlowCommands.START_AGENT);
        const payload = commands[0].payload as StartAgentPayload;
        assert.deepEqual(payload, {
            taskId: 'task-A',
            stepId: 'plan',
            agent: 'planner',
            model: 'opus',
        });

        const row = db
            .prepare('SELECT current_step FROM flow_state WHERE task_id = ?')
            .get('task-A') as { current_step: string } | undefined;
        assert.ok(row, 'flow_state row must be inserted');
        assert.equal(row!.current_step, 'plan');

        // tasks.flow_id is the authoritative pointer for subsequent events.
        const t = db.prepare('SELECT flow_id FROM tasks WHERE id = ?').get('task-A') as {
            flow_id: string | null;
        };
        assert.equal(t.flow_id, 'linear');

        engine.stop();
    } finally {
        db.close();
    }
});

test('linear flow: each AgentFinished advances current_step and emits the next StartAgent', async () => {
    const flows = new Map<string, FlowDefinition>([['linear', LINEAR_FLOW]]);
    const { db, bus, commands, engine } = makeHarness(flows);
    try {
        seedTask(db, 'task-A');
        await bus.publish(
            makeEvent(FlowEvents.TASK_APPROVED, { taskId: 'task-A', flowId: 'linear' }),
        );

        await bus.publish(makeEvent(FlowEvents.AGENT_FINISHED, { taskId: 'task-A' }));
        assert.equal(commands.length, 2);
        assert.equal((commands[1].payload as StartAgentPayload).stepId, 'develop');
        assert.equal(
            (db.prepare('SELECT current_step FROM flow_state WHERE task_id = ?').get(
                'task-A',
            ) as { current_step: string }).current_step,
            'develop',
        );

        await bus.publish(makeEvent(FlowEvents.AGENT_FINISHED, { taskId: 'task-A' }));
        assert.equal(commands.length, 3);
        assert.equal((commands[2].payload as StartAgentPayload).stepId, 'review');
        assert.equal(
            (db.prepare('SELECT current_step FROM flow_state WHERE task_id = ?').get(
                'task-A',
            ) as { current_step: string }).current_step,
            'review',
        );

        engine.stop();
    } finally {
        db.close();
    }
});

test('flow with no remaining steps publishes the step\'s emit: directive instead of StartAgent', async () => {
    const shortFlow: FlowDefinition = {
        on: 'task.approved',
        steps: [
            { id: 'only', agent: 'agent', model: 'm', on_success: 'emit:task.finished' },
        ],
    };
    const flows = new Map<string, FlowDefinition>([['short', shortFlow]]);
    const { db, bus, commands, engine } = makeHarness(flows);
    try {
        seedTask(db, 'task-T');

        const finished: StoredEvent[] = [];
        bus.subscribe('task.finished', (e) => {
            finished.push(e);
        });

        await bus.publish(
            makeEvent(FlowEvents.TASK_APPROVED, { taskId: 'task-T', flowId: 'short' }),
        );
        assert.equal(commands.length, 1, 'one StartAgent for the entry step');

        await bus.publish(makeEvent(FlowEvents.AGENT_FINISHED, { taskId: 'task-T' }));

        assert.equal(commands.length, 1, 'no further StartAgent — flow terminated via emit:');
        assert.equal(finished.length, 1, 'terminal event was published');
        assert.deepEqual(finished[0].payload, { taskId: 'task-T' });

        engine.stop();
    } finally {
        db.close();
    }
});

test('AgentQuestion without on_question emits RequestInvestigation, keeping current_step as the resume marker', async () => {
    const flows = new Map<string, FlowDefinition>([['linear', LINEAR_FLOW]]);
    const { db, bus, commands, engine } = makeHarness(flows);
    try {
        seedTask(db, 'task-Q');
        await bus.publish(
            makeEvent(FlowEvents.TASK_APPROVED, { taskId: 'task-Q', flowId: 'linear' }),
        );
        await bus.publish(makeEvent(FlowEvents.AGENT_FINISHED, { taskId: 'task-Q' }));
        assert.equal(commands.length, 2);

        await bus.publish(
            makeEvent(FlowEvents.AGENT_QUESTION, {
                taskId: 'task-Q',
                question: 'which schema?',
            }),
        );

        assert.equal(commands.length, 3);
        const issued = commands[2];
        assert.equal(issued.type, FlowCommands.REQUEST_INVESTIGATION);
        const payload = issued.payload as RequestInvestigationPayload;
        assert.deepEqual(payload, {
            taskId: 'task-Q',
            resumeStep: 'develop',
            question: 'which schema?',
        });

        const fs = db
            .prepare('SELECT current_step FROM flow_state WHERE task_id = ?')
            .get('task-Q') as { current_step: string };
        assert.equal(fs.current_step, 'develop', 'current_step unchanged — it is the resume marker');

        engine.stop();
    } finally {
        db.close();
    }
});

test('AgentQuestion follows the step\'s on_question target when one is defined', async () => {
    const branching: FlowDefinition = {
        on: 'task.approved',
        steps: [
            { id: 'plan', agent: 'planner', model: 'opus', on_success: 'develop' },
            {
                id: 'develop',
                agent: 'developer',
                model: 'sonnet',
                on_success: 'emit:task.finished',
                on_question: 'plan',
            },
        ],
    };
    const flows = new Map<string, FlowDefinition>([['b', branching]]);
    const { db, bus, commands, engine } = makeHarness(flows);
    try {
        seedTask(db, 'task-B');
        await bus.publish(
            makeEvent(FlowEvents.TASK_APPROVED, { taskId: 'task-B', flowId: 'b' }),
        );
        await bus.publish(makeEvent(FlowEvents.AGENT_FINISHED, { taskId: 'task-B' }));
        assert.equal((commands[1].payload as StartAgentPayload).stepId, 'develop');

        await bus.publish(makeEvent(FlowEvents.AGENT_QUESTION, { taskId: 'task-B' }));

        assert.equal(commands.length, 3);
        const branched = commands[2];
        assert.equal(branched.type, FlowCommands.START_AGENT);
        assert.equal((branched.payload as StartAgentPayload).stepId, 'plan');

        const fs = db
            .prepare('SELECT current_step FROM flow_state WHERE task_id = ?')
            .get('task-B') as { current_step: string };
        assert.equal(fs.current_step, 'plan');

        engine.stop();
    } finally {
        db.close();
    }
});

test('InvestigationCompleted re-emits StartAgent for the saved current_step', async () => {
    const flows = new Map<string, FlowDefinition>([['linear', LINEAR_FLOW]]);
    const { db, bus, commands, engine } = makeHarness(flows);
    try {
        seedTask(db, 'task-R');
        await bus.publish(
            makeEvent(FlowEvents.TASK_APPROVED, { taskId: 'task-R', flowId: 'linear' }),
        );
        await bus.publish(makeEvent(FlowEvents.AGENT_FINISHED, { taskId: 'task-R' }));
        await bus.publish(makeEvent(FlowEvents.AGENT_QUESTION, { taskId: 'task-R' }));
        const beforeResume = commands.length;

        await bus.publish(
            makeEvent(FlowEvents.INVESTIGATION_COMPLETED, { taskId: 'task-R' }),
        );

        assert.equal(commands.length, beforeResume + 1);
        const resume = commands[commands.length - 1];
        assert.equal(resume.type, FlowCommands.START_AGENT);
        const payload = resume.payload as StartAgentPayload;
        assert.deepEqual(payload, {
            taskId: 'task-R',
            stepId: 'develop',
            agent: 'developer',
            model: 'sonnet',
        });

        engine.stop();
    } finally {
        db.close();
    }
});

test('InvestigationCompleted honours an explicit resumeStep override in the payload', async () => {
    const flows = new Map<string, FlowDefinition>([['linear', LINEAR_FLOW]]);
    const { db, bus, commands, engine } = makeHarness(flows);
    try {
        seedTask(db, 'task-O');
        await bus.publish(
            makeEvent(FlowEvents.TASK_APPROVED, { taskId: 'task-O', flowId: 'linear' }),
        );
        await bus.publish(makeEvent(FlowEvents.AGENT_FINISHED, { taskId: 'task-O' }));
        await bus.publish(makeEvent(FlowEvents.AGENT_QUESTION, { taskId: 'task-O' }));
        const before = commands.length;

        await bus.publish(
            makeEvent(FlowEvents.INVESTIGATION_COMPLETED, {
                taskId: 'task-O',
                resumeStep: 'plan',
            }),
        );

        assert.equal(commands.length, before + 1);
        const resume = commands[commands.length - 1];
        assert.equal((resume.payload as StartAgentPayload).stepId, 'plan');

        engine.stop();
    } finally {
        db.close();
    }
});

test('after restart, the engine resumes from flow_state and replayMissed does not double-emit', async () => {
    const flows = new Map<string, FlowDefinition>([['linear', LINEAR_FLOW]]);
    const { db, bus, commands, engine } = makeHarness(flows);
    try {
        seedTask(db, 'task-X');
        await bus.publish(
            makeEvent(FlowEvents.TASK_APPROVED, { taskId: 'task-X', flowId: 'linear' }),
        );
        await bus.publish(makeEvent(FlowEvents.AGENT_FINISHED, { taskId: 'task-X' }));
        assert.equal(commands.length, 2);
        assert.equal(
            (db.prepare('SELECT current_step FROM flow_state WHERE task_id = ?').get(
                'task-X',
            ) as { current_step: string }).current_step,
            'develop',
        );

        // Simulate a restart: detach the engine completely.
        engine.stop();

        // Bring up a fresh engine (and fresh command recorder) against the
        // same persistent DB + bus.
        const commands2: Command[] = [];
        const cmdBus2 = new CommandBus<unknown>(bus, () => undefined);
        cmdBus2.register(FlowCommands.START_AGENT, recorder(commands2));
        cmdBus2.register(FlowCommands.FINISH_TASK, recorder(commands2));
        cmdBus2.register(FlowCommands.FAIL_TASK, recorder(commands2));
        cmdBus2.register(FlowCommands.REQUEST_INVESTIGATION, recorder(commands2));
        const engine2 = FlowEngine.start(bus, cmdBus2, flows, {
            db,
            logger: new FakeLogger(),
        });

        // Replay finds no events past the persisted offset.
        await bus.replayMissed(FLOW_ENGINE_SUBSCRIBER);
        assert.equal(commands2.length, 0, 'no commands re-emitted on replay');

        // The next live event is processed against the resumed state.
        await bus.publish(makeEvent(FlowEvents.AGENT_FINISHED, { taskId: 'task-X' }));
        assert.equal(commands2.length, 1);
        assert.equal((commands2[0].payload as StartAgentPayload).stepId, 'review');

        engine2.stop();
    } finally {
        db.close();
    }
});

test('replayMissed delivers events that arrived while the engine was offline', async () => {
    const flows = new Map<string, FlowDefinition>([['linear', LINEAR_FLOW]]);
    const { db, bus, commands, engine } = makeHarness(flows);
    try {
        seedTask(db, 'task-D');
        await bus.publish(
            makeEvent(FlowEvents.TASK_APPROVED, { taskId: 'task-D', flowId: 'linear' }),
        );
        assert.equal(commands.length, 1);

        // Engine goes offline. Events keep landing in the store via direct
        // publish — no subscriber catches them, the offset stays put.
        engine.stop();
        await bus.publish(makeEvent(FlowEvents.AGENT_FINISHED, { taskId: 'task-D' }));

        const commands2: Command[] = [];
        const cmdBus2 = new CommandBus<unknown>(bus, () => undefined);
        cmdBus2.register(FlowCommands.START_AGENT, recorder(commands2));
        cmdBus2.register(FlowCommands.FINISH_TASK, recorder(commands2));
        cmdBus2.register(FlowCommands.FAIL_TASK, recorder(commands2));
        cmdBus2.register(FlowCommands.REQUEST_INVESTIGATION, recorder(commands2));
        const engine2 = FlowEngine.start(bus, cmdBus2, flows, {
            db,
            logger: new FakeLogger(),
        });

        await bus.replayMissed(FLOW_ENGINE_SUBSCRIBER);

        assert.equal(commands2.length, 1, 'missed AgentFinished is replayed exactly once');
        assert.equal((commands2[0].payload as StartAgentPayload).stepId, 'develop');
        assert.equal(
            (db.prepare('SELECT current_step FROM flow_state WHERE task_id = ?').get(
                'task-D',
            ) as { current_step: string }).current_step,
            'develop',
        );

        engine2.stop();
    } finally {
        db.close();
    }
});

test('TaskApproved for an unknown flowId fails the task instead of dropping it silently', async () => {
    const flows = new Map<string, FlowDefinition>([['linear', LINEAR_FLOW]]);
    const { db, bus, commands, logger, engine } = makeHarness(flows);
    try {
        seedTask(db, 'task-U');
        await bus.publish(
            makeEvent(FlowEvents.TASK_APPROVED, { taskId: 'task-U', flowId: 'nope' }),
        );

        // No StartAgent for the missing flow, but a FailTask must be emitted.
        assert.equal(
            commands.filter((c) => c.type === FlowCommands.START_AGENT).length,
            0,
            'no StartAgent for unknown flow',
        );
        const fail = commands.find((c) => c.type === FlowCommands.FAIL_TASK);
        assert.ok(fail, 'engine must emit a FailTask command for unknown flow');
        const failPayload = fail!.payload as FailTaskPayload;
        assert.equal(failPayload.taskId, 'task-U');
        assert.match(failPayload.reason, /unknown flow/i);

        // tasks.status must reflect the failure so downstream readers see it.
        const t = db
            .prepare('SELECT status FROM tasks WHERE id = ?')
            .get('task-U') as { status: string };
        assert.equal(t.status, 'failed');

        assert.ok(
            logger.entries.some(
                (e) => e.level === 'error' && /unknown flow/.test(e.message),
            ),
            'must log an error for the unknown flow id',
        );
        const fs = db
            .prepare('SELECT current_step FROM flow_state WHERE task_id = ?')
            .get('task-U');
        assert.equal(fs, undefined, 'no flow_state row written for unknown flow');

        engine.stop();
    } finally {
        db.close();
    }
});

test('AgentFinished for a task with no flow_state is logged and ignored', async () => {
    const flows = new Map<string, FlowDefinition>([['linear', LINEAR_FLOW]]);
    const { db, bus, commands, logger, engine } = makeHarness(flows);
    try {
        seedTask(db, 'task-N');
        await bus.publish(makeEvent(FlowEvents.AGENT_FINISHED, { taskId: 'task-N' }));

        assert.equal(commands.length, 0);
        assert.ok(
            logger.entries.some(
                (e) => e.level === 'warn' && /AgentFinished/.test(e.message),
            ),
        );

        engine.stop();
    } finally {
        db.close();
    }
});

// ---------------------------------------------------------------------------
// AP-IFW-011: pr.open and pr.merge step dispatch through PullRequestGateway
// ---------------------------------------------------------------------------

// AP-VP-007: pr.open and pr.merge default to approval='required' via
// BUILT_IN_APPROVAL_DEFAULTS, which would park these steps at the new
// engine gate. The tests below exercise direct gateway dispatch, so
// they opt out by setting approval: 'auto' on each PR step explicitly.
const PR_FLOW: FlowDefinition = {
    on: 'task.approved',
    steps: [
        {
            id: 'develop',
            agent: 'developer',
            model: 'sonnet',
            on_success: 'open-pr',
        },
        {
            id: 'open-pr',
            agent: PR_STEP_TYPES.OPEN,
            model: 'none',
            on_success: 'merge-pr',
            approval: 'auto',
            params: {
                title: 'auto: do the thing',
                body: 'opened by flow engine',
                base: 'main',
                head: 'feature/auto',
            },
        },
        {
            id: 'merge-pr',
            agent: PR_STEP_TYPES.MERGE,
            model: 'none',
            on_success: 'emit:task.finished',
            approval: 'auto',
            params: { method: 'squash' },
        },
    ],
};

test('AgentFinished targeting pr.open invokes PullRequestGateway.openPullRequest, then chains', async () => {
    const gateway = new FakePullRequestGateway();
    const flows = new Map<string, FlowDefinition>([['pr', PR_FLOW]]);
    const { db, bus, commands, engine } = makeHarness(flows, { prGateway: gateway });
    try {
        seedTask(db, 'task-PR');

        await bus.publish(
            makeEvent(FlowEvents.TASK_APPROVED, { taskId: 'task-PR', flowId: 'pr' }),
        );
        // step 1 (develop) issues StartAgent
        assert.equal(commands.length, 1);
        assert.equal((commands[0].payload as StartAgentPayload).stepId, 'develop');

        await bus.publish(makeEvent(FlowEvents.AGENT_FINISHED, { taskId: 'task-PR' }));

        // The pr.open step ran the gateway (NOT a StartAgent), then chained
        // to pr.merge which also ran through the gateway, then emit: fired.
        assert.equal(gateway.calls.length, 2);
        assert.equal(gateway.calls[0].method, 'openPullRequest');
        assert.deepEqual(gateway.calls[0].args, {
            title: 'auto: do the thing',
            body: 'opened by flow engine',
            base: 'main',
            head: 'feature/auto',
        });
        assert.equal(gateway.calls[1].method, 'mergePullRequest');
        assert.deepEqual(gateway.calls[1].args, {
            number: 100,
            options: { method: 'squash' },
        });

        // No StartAgent issued for the PR steps.
        const starts = commands.filter((c) => c.type === FlowCommands.START_AGENT);
        assert.equal(starts.length, 1, 'PR steps must not emit StartAgent');

        engine.stop();
    } finally {
        db.close();
    }
});

test('pr.open as the entry step dispatches through the gateway on TaskApproved', async () => {
    const gateway = new FakePullRequestGateway();
    const flow: FlowDefinition = {
        on: 'task.approved',
        steps: [
            {
                id: 'open-pr',
                agent: PR_STEP_TYPES.OPEN,
                model: 'none',
                on_success: 'emit:task.finished',
                approval: 'auto',
                params: {
                    title: 't',
                    base: 'main',
                    head: 'feature/entry',
                },
            },
        ],
    };
    const flows = new Map<string, FlowDefinition>([['entry-pr', flow]]);
    const { db, bus, commands, engine } = makeHarness(flows, { prGateway: gateway });
    try {
        seedTask(db, 'task-Entry');
        await bus.publish(
            makeEvent(FlowEvents.TASK_APPROVED, {
                taskId: 'task-Entry',
                flowId: 'entry-pr',
            }),
        );

        assert.equal(gateway.calls.length, 1);
        assert.equal(gateway.calls[0].method, 'openPullRequest');
        const starts = commands.filter((c) => c.type === FlowCommands.START_AGENT);
        assert.equal(starts.length, 0);

        const row = db
            .prepare('SELECT current_step FROM flow_state WHERE task_id = ?')
            .get('task-Entry') as { current_step: string } | undefined;
        assert.equal(row?.current_step, 'open-pr');

        engine.stop();
    } finally {
        db.close();
    }
});

test('pr.merge resolves its target PR number from a prior pr.open in the same flow', async () => {
    const gateway = new FakePullRequestGateway();
    const flow: FlowDefinition = {
        on: 'task.approved',
        steps: [
            {
                id: 'open',
                agent: PR_STEP_TYPES.OPEN,
                model: 'none',
                on_success: 'merge',
                approval: 'auto',
                params: { title: 't', base: 'main', head: 'feature/m' },
            },
            {
                id: 'merge',
                agent: PR_STEP_TYPES.MERGE,
                model: 'none',
                on_success: 'emit:task.finished',
                approval: 'auto',
                params: { method: 'rebase' },
            },
        ],
    };
    const flows = new Map<string, FlowDefinition>([['m', flow]]);
    const { db, bus, engine } = makeHarness(flows, { prGateway: gateway });
    try {
        seedTask(db, 'task-M');
        await bus.publish(
            makeEvent(FlowEvents.TASK_APPROVED, { taskId: 'task-M', flowId: 'm' }),
        );

        assert.equal(gateway.calls.length, 2);
        const merge = gateway.calls[1];
        assert.equal(merge.method, 'mergePullRequest');
        // openPullRequest returned 100 on the FakePullRequestGateway's first call.
        assert.deepEqual(merge.args, { number: 100, options: { method: 'rebase' } });

        engine.stop();
    } finally {
        db.close();
    }
});

test('pr.merge accepts an explicit "number" param overriding the cached value', async () => {
    const gateway = new FakePullRequestGateway();
    const flow: FlowDefinition = {
        on: 'task.approved',
        steps: [
            {
                id: 'merge',
                agent: PR_STEP_TYPES.MERGE,
                model: 'none',
                on_success: 'emit:task.finished',
                approval: 'auto',
                params: { method: 'merge', number: 999 },
            },
        ],
    };
    const flows = new Map<string, FlowDefinition>([['m2', flow]]);
    const { db, bus, engine } = makeHarness(flows, { prGateway: gateway });
    try {
        seedTask(db, 'task-M2');
        await bus.publish(
            makeEvent(FlowEvents.TASK_APPROVED, { taskId: 'task-M2', flowId: 'm2' }),
        );

        assert.equal(gateway.calls.length, 1);
        assert.deepEqual(gateway.calls[0].args, {
            number: 999,
            options: { method: 'merge' },
        });

        engine.stop();
    } finally {
        db.close();
    }
});

test('a pr step with no configured gateway is logged as a handler failure (offset not advanced)', async () => {
    const flow: FlowDefinition = {
        on: 'task.approved',
        steps: [
            {
                id: 'open',
                agent: PR_STEP_TYPES.OPEN,
                model: 'none',
                on_success: 'emit:task.finished',
                approval: 'auto',
                params: { title: 't', base: 'main', head: 'feature/x' },
            },
        ],
    };
    const flows = new Map<string, FlowDefinition>([['nogw', flow]]);
    const { db, bus, logger, engine } = makeHarness(flows);
    try {
        seedTask(db, 'task-NG');
        await bus.publish(
            makeEvent(FlowEvents.TASK_APPROVED, { taskId: 'task-NG', flowId: 'nogw' }),
        );

        assert.ok(
            logger.entries.some(
                (e) =>
                    e.level === 'error' &&
                    /event handler threw/.test(e.message) &&
                    /PullRequestGateway/.test(
                        (e.meta as { error?: string } | undefined)?.error ?? '',
                    ),
            ),
            'handler error from missing gateway must be surfaced via logger',
        );

        engine.stop();
    } finally {
        db.close();
    }
});

test('pr step failures from the gateway propagate as handler errors (no commands issued)', async () => {
    class BoomGateway implements PullRequestGateway {
        async push(): Promise<void> {
            throw new Error('boom-push');
        }
        async openPullRequest(): Promise<OpenedPullRequest> {
            throw new Error('boom-open: gh exit 1 stderr=HTTP 401');
        }
        async mergePullRequest(): Promise<void> {
            throw new Error('boom-merge');
        }
        async addComment(): Promise<void> {
            throw new Error('boom-comment');
        }
    }
    const flow: FlowDefinition = {
        on: 'task.approved',
        steps: [
            {
                id: 'open',
                agent: PR_STEP_TYPES.OPEN,
                model: 'none',
                on_success: 'emit:task.finished',
                approval: 'auto',
                params: { title: 't', base: 'main', head: 'feature/x' },
            },
        ],
    };
    const flows = new Map<string, FlowDefinition>([['boom', flow]]);
    const { db, bus, commands, logger, engine } = makeHarness(flows, {
        prGateway: new BoomGateway(),
    });
    try {
        seedTask(db, 'task-Boom');
        await bus.publish(
            makeEvent(FlowEvents.TASK_APPROVED, {
                taskId: 'task-Boom',
                flowId: 'boom',
            }),
        );

        assert.equal(commands.length, 0, 'no commands issued when PR step fails');
        assert.ok(
            logger.entries.some(
                (e) =>
                    e.level === 'error' &&
                    /HTTP 401/.test(
                        (e.meta as { error?: string } | undefined)?.error ?? '',
                    ),
            ),
            'gateway error message (containing captured stderr) must reach the logger',
        );

        engine.stop();
    } finally {
        db.close();
    }
});

// ---------------------------------------------------------------------------
// AP-VP7-001: TaskFailed payload — `finalAttempt` flag
// ---------------------------------------------------------------------------

test('buildTaskFailedPayload: terminal path — sets finalAttempt: true when retry_count >= max_retries', () => {
    const exhausted = buildTaskFailedPayload(
        { taskId: 'task-X', failed_stage: 'developer' },
        { retryCount: 2, maxRetries: 2 },
    );
    assert.equal(exhausted.finalAttempt, true);
    assert.equal(exhausted.taskId, 'task-X');
    assert.equal(exhausted.failed_stage, 'developer');

    // Strictly greater also flips the flag — guards against off-by-one
    // regressions in the threshold comparison.
    const overshot = buildTaskFailedPayload(
        { taskId: 'task-Y' },
        { retryCount: 5, maxRetries: 2 },
    );
    assert.equal(overshot.finalAttempt, true);
});

test('buildTaskFailedPayload: non-terminal path — omits finalAttempt when retry_count < max_retries', () => {
    const stillRetrying = buildTaskFailedPayload(
        { taskId: 'task-Z', failed_stage: 'developer' },
        { retryCount: 0, maxRetries: 2 },
    );
    // The key must be absent (not present-and-false) so the payload bytes
    // are identical to pre-AP-VP7-001 emissions.
    assert.equal(
        Object.prototype.hasOwnProperty.call(stillRetrying, 'finalAttempt'),
        false,
        'finalAttempt must be omitted, not set to false',
    );
    assert.deepEqual(stillRetrying, {
        taskId: 'task-Z',
        failed_stage: 'developer',
    });

    const oneShortOfBudget = buildTaskFailedPayload(
        { taskId: 'task-W' },
        { retryCount: 1, maxRetries: 2 },
    );
    assert.equal(
        Object.prototype.hasOwnProperty.call(oneShortOfBudget, 'finalAttempt'),
        false,
    );
});

test('buildTaskFailedPayload: backward compatibility — old consumers parse the payload unchanged when no retry context is supplied', () => {
    // Emission sites without retry context (e.g. operator-rejection) call
    // the helper with `retry` undefined. The payload must round-trip with
    // the exact pre-AP-VP7-001 shape so any consumer that reads only
    // `{taskId, failed_stage}` continues to parse without touching the
    // new field.
    const base: TaskFailedEventPayload = {
        taskId: 'task-legacy',
        failed_stage: 'rejected',
    };
    const result: TaskFailedEventPayload = buildTaskFailedPayload(base);

    // Read the optional field BEFORE any `deepEqual` against a literal —
    // node's strict assertions narrow `actual` to the literal type of
    // `expected`, which would hide the new optional field from later
    // accesses.
    assert.equal(Boolean(result.finalAttempt), false);
    assert.equal(
        Object.prototype.hasOwnProperty.call(result, 'finalAttempt'),
        false,
        'a missing retry context must NOT introduce the finalAttempt key',
    );

    // Simulate a legacy consumer that knows nothing about the new flag.
    // Destructuring with the old shape must still succeed.
    const { taskId, failed_stage } = result;
    assert.equal(taskId, 'task-legacy');
    assert.equal(failed_stage, 'rejected');

    assert.deepEqual(result, { taskId: 'task-legacy', failed_stage: 'rejected' });
});
