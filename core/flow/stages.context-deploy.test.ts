/**
 * AP-VP-010: flow-engine dispatch tests for the three port-backed step
 * kinds — `run-script`, `verify`, `context-update`. Each step kind goes
 * through the same dispatch contract: pass through the approval gate
 * first, invoke the injected port, branch on success / failure.
 *
 *   run-script     — calls {@link ScriptRunner.run} with the script path,
 *                    args, cwd, and env from `step.params`; publishes
 *                    `ScriptFinished{ exitCode, stdoutPath }`; routes to
 *                    `on_success` on exit 0 else `on_failure`.
 *   verify         — calls {@link HealthProbe.probe} with the url +
 *                    predicate from `step.params`; publishes
 *                    `VerifyFinished{ ok }`; routes on `ok`.
 *   context-update — calls {@link AgentRunner.start} with role hard-coded
 *                    to `'curator'` and the prompt from `step.params`.
 *                    The runner publishes `AgentFinished` itself; the
 *                    engine's existing handler routes via `on_success`.
 *
 * Dual-runner discovery
 * ---------------------
 * Mirrors the shim used by the other stage tests so this file is
 * discoverable by both `node --test` (the repo's `npm test`) and vitest
 * (the review pipeline). See engine.start-mode.test.ts header for the
 * rationale.
 */

import * as assert from 'node:assert/strict';

import { openDatabase, applyMigrations, type Db } from '../state/migrations';
import { EventStore } from '../events/store';
import { EventBus } from '../events/bus';
import { CommandBus } from '../commands/bus';
import type { Command } from '../commands/command';
import type { Event, StoredEvent } from '../events/event';
import type { Logger } from '../ports/Logger';
import type {
    ScriptRunner,
    ScriptRunResult,
} from '../ports/ScriptRunner';
import type {
    HealthPredicate,
    HealthProbe,
    HealthProbeResult,
} from '../ports/HealthProbe';
import type {
    AgentHandle,
    AgentRunner,
    AgentSpec,
} from '../ports/AgentRunner';
import type { FlowDefinition } from './types';
import { FLOW_STEP_KINDS } from './types';
import {
    FlowEngine,
    FlowEvents,
    FlowCommands,
    ScriptEvents,
    type ScriptFinishedEventPayload,
    type StartAgentPayload,
    type VerifyFinishedEventPayload,
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
                'stages.context-deploy.test.ts: VITEST=true but globalThis.test is missing — '
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
        idempotencyKey: `vp010-${process.pid}-${evCounter}`,
        payload,
    };
}

function seedTask(db: Db, taskId: string): void {
    const planId = `plan-${taskId}`;
    db.prepare(
        'INSERT INTO plans(id, project_id, status, created_at) VALUES (?, ?, ?, ?)',
    ).run(planId, 'proj-vp-010', 'approved', 1_700_000_000_000);
    db.prepare(
        'INSERT INTO tasks(id, plan_id, type, status) VALUES (?, ?, ?, ?)',
    ).run(taskId, planId, 'feature', 'approved');
}

interface FakeScriptRunnerCall {
    readonly scriptPath: string;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
}

class FakeScriptRunner implements ScriptRunner {
    readonly calls: FakeScriptRunnerCall[] = [];
    constructor(private readonly nextResult: ScriptRunResult) {}
    async run(
        scriptPath: string,
        args: readonly string[],
        cwd: string,
        env: Readonly<Record<string, string>>,
    ): Promise<ScriptRunResult> {
        this.calls.push({ scriptPath, args, cwd, env });
        return this.nextResult;
    }
}

interface FakeHealthProbeCall {
    readonly url: string;
    readonly predicate: HealthPredicate;
}

class FakeHealthProbe implements HealthProbe {
    readonly calls: FakeHealthProbeCall[] = [];
    constructor(private readonly nextResult: HealthProbeResult) {}
    async probe(url: string, predicate: HealthPredicate): Promise<HealthProbeResult> {
        this.calls.push({ url, predicate });
        return this.nextResult;
    }
}

class FakeAgentRunner implements AgentRunner {
    readonly specs: AgentSpec[] = [];
    private counter = 0;
    start(spec: AgentSpec): AgentHandle {
        this.specs.push(spec);
        return { id: `fake-agent-${++this.counter}`, spec };
    }
    async interrupt(): Promise<void> {
        // no-op
    }
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

interface HarnessOptions {
    scriptRunner?: ScriptRunner;
    healthProbe?: HealthProbe;
    agentRunner?: AgentRunner;
}

function makeHarness(
    flows: ReadonlyMap<string, FlowDefinition>,
    ports: HarnessOptions = {},
): Harness {
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
    const engine = FlowEngine.start(bus, cmdBus, flows, {
        db,
        logger,
        scriptRunner: ports.scriptRunner,
        healthProbe: ports.healthProbe,
        agentRunner: ports.agentRunner,
    });
    return { db, bus, commands, engine };
}

function startAgents(commands: ReadonlyArray<Command>): StartAgentPayload[] {
    return commands
        .filter((c) => c.type === FlowCommands.START_AGENT)
        .map((c) => c.payload as StartAgentPayload);
}

// ---------------------------------------------------------------------------
// run-script
// ---------------------------------------------------------------------------

test('run-script: invokes ScriptRunner with step params, publishes ScriptFinished, routes on_success when exit code is 0', async () => {
    const flow: FlowDefinition = {
        on: 'task.approved',
        steps: [
            {
                id: 'build',
                agent: FLOW_STEP_KINDS.RUN_SCRIPT,
                model: 'none',
                on_success: 'finish',
                on_failure: 'recover',
                params: {
                    scriptPath: 'scripts/build.ps1',
                    args: ['--release', '--quiet'],
                    cwd: 'C:/repo/build',
                    env: { CI: '1', NODE_ENV: 'production' },
                },
            },
            {
                id: 'finish',
                agent: 'developer',
                model: 'sonnet',
                on_success: 'emit:task.finished',
            },
            {
                id: 'recover',
                agent: 'developer',
                model: 'sonnet',
                on_success: 'emit:task.failed',
            },
        ],
    };
    const flows = new Map<string, FlowDefinition>([['build-flow', flow]]);
    const scriptRunner = new FakeScriptRunner({
        exitCode: 0,
        stdoutPath: 'C:/tmp/runs/build/stdout.log',
        stderrPath: 'C:/tmp/runs/build/stderr.log',
    });
    const { db, bus, commands, engine } = makeHarness(flows, { scriptRunner });
    try {
        seedTask(db, 'task-RS-OK');

        const scriptFinished: StoredEvent[] = [];
        bus.subscribe<ScriptFinishedEventPayload>(
            ScriptEvents.SCRIPT_FINISHED,
            (e) => {
                scriptFinished.push(e);
            },
        );

        await bus.publish(
            makeEvent(FlowEvents.TASK_APPROVED, {
                taskId: 'task-RS-OK',
                flowId: 'build-flow',
            }),
        );

        // Port was called once with exactly the params declared on the step.
        assert.equal(scriptRunner.calls.length, 1);
        const call = scriptRunner.calls[0];
        assert.equal(call.scriptPath, 'scripts/build.ps1');
        assert.deepEqual([...call.args], ['--release', '--quiet']);
        assert.equal(call.cwd, 'C:/repo/build');
        assert.deepEqual(call.env, { CI: '1', NODE_ENV: 'production' });

        // ScriptFinished was published with the exit code + stdoutPath.
        assert.equal(scriptFinished.length, 1);
        const sfPayload = scriptFinished[0].payload as ScriptFinishedEventPayload;
        assert.equal(sfPayload.taskId, 'task-RS-OK');
        assert.equal(sfPayload.stepId, 'build');
        assert.equal(sfPayload.exitCode, 0);
        assert.equal(sfPayload.stdoutPath, 'C:/tmp/runs/build/stdout.log');

        // on_success routed to the next agent step.
        const starts = startAgents(commands);
        assert.equal(starts.length, 1);
        assert.equal(starts[0].stepId, 'finish');

        engine.stop();
    } finally {
        db.close();
    }
});

test('run-script: non-zero exit routes to on_failure', async () => {
    const flow: FlowDefinition = {
        on: 'task.approved',
        steps: [
            {
                id: 'build',
                agent: FLOW_STEP_KINDS.RUN_SCRIPT,
                model: 'none',
                on_success: 'finish',
                on_failure: 'recover',
                params: {
                    scriptPath: 'scripts/build.ps1',
                    cwd: 'C:/repo/build',
                },
            },
            {
                id: 'finish',
                agent: 'developer',
                model: 'sonnet',
                on_success: 'emit:task.finished',
            },
            {
                id: 'recover',
                agent: 'developer',
                model: 'sonnet',
                on_success: 'emit:task.failed',
            },
        ],
    };
    const flows = new Map<string, FlowDefinition>([['build-flow', flow]]);
    const scriptRunner = new FakeScriptRunner({
        exitCode: 2,
        stdoutPath: 'C:/tmp/runs/build/stdout.log',
        stderrPath: 'C:/tmp/runs/build/stderr.log',
    });
    const { db, bus, commands, engine } = makeHarness(flows, { scriptRunner });
    try {
        seedTask(db, 'task-RS-FAIL');

        const scriptFinished: StoredEvent[] = [];
        bus.subscribe<ScriptFinishedEventPayload>(
            ScriptEvents.SCRIPT_FINISHED,
            (e) => {
                scriptFinished.push(e);
            },
        );

        await bus.publish(
            makeEvent(FlowEvents.TASK_APPROVED, {
                taskId: 'task-RS-FAIL',
                flowId: 'build-flow',
            }),
        );

        assert.equal(scriptFinished.length, 1);
        assert.equal(
            (scriptFinished[0].payload as ScriptFinishedEventPayload).exitCode,
            2,
        );

        const starts = startAgents(commands);
        assert.equal(starts.length, 1);
        assert.equal(starts[0].stepId, 'recover');

        engine.stop();
    } finally {
        db.close();
    }
});

test('run-script: approval=required parks the task before invoking ScriptRunner', async () => {
    const flow: FlowDefinition = {
        on: 'task.approved',
        steps: [
            {
                id: 'build',
                agent: FLOW_STEP_KINDS.RUN_SCRIPT,
                model: 'none',
                on_success: 'emit:task.finished',
                approval: 'required',
                params: {
                    scriptPath: 'scripts/build.ps1',
                    cwd: 'C:/repo/build',
                },
            },
        ],
    };
    const flows = new Map<string, FlowDefinition>([['gated', flow]]);
    const scriptRunner = new FakeScriptRunner({
        exitCode: 0,
        stdoutPath: 'unused',
        stderrPath: 'unused',
    });
    const { db, bus, engine } = makeHarness(flows, { scriptRunner });
    try {
        seedTask(db, 'task-RS-GATED');

        const parked: StoredEvent[] = [];
        bus.subscribe<TaskParkedEventPayload>(
            TaskParkingEvents.TASK_PARKED,
            (e) => {
                parked.push(e);
            },
        );

        await bus.publish(
            makeEvent(FlowEvents.TASK_APPROVED, {
                taskId: 'task-RS-GATED',
                flowId: 'gated',
            }),
        );

        // Gate fires first — runner is never invoked while the task is parked.
        assert.equal(scriptRunner.calls.length, 0);
        assert.equal(parked.length, 1);
        const payload = parked[0].payload as TaskParkedEventPayload;
        assert.equal(payload.taskId, 'task-RS-GATED');
        assert.equal(payload.stepId, 'build');
        assert.equal(payload.reason, 'approval');

        engine.stop();
    } finally {
        db.close();
    }
});

// ---------------------------------------------------------------------------
// verify
// ---------------------------------------------------------------------------

test('verify: invokes HealthProbe with url + predicate, publishes VerifyFinished, routes on_success when ok', async () => {
    const flow: FlowDefinition = {
        on: 'task.approved',
        steps: [
            {
                id: 'probe',
                agent: FLOW_STEP_KINDS.VERIFY,
                model: 'none',
                on_success: 'celebrate',
                on_failure: 'rollback',
                params: {
                    url: 'https://api.example.com/health',
                    predicate: { kind: 'status', equals: 200 },
                },
            },
            {
                id: 'celebrate',
                agent: 'developer',
                model: 'sonnet',
                on_success: 'emit:task.finished',
            },
            {
                id: 'rollback',
                agent: 'developer',
                model: 'sonnet',
                on_success: 'emit:task.failed',
            },
        ],
    };
    const flows = new Map<string, FlowDefinition>([['verify-flow', flow]]);
    const healthProbe = new FakeHealthProbe({ ok: true, status: 200 });
    const { db, bus, commands, engine } = makeHarness(flows, { healthProbe });
    try {
        seedTask(db, 'task-V-OK');

        const verifyFinished: StoredEvent[] = [];
        bus.subscribe<VerifyFinishedEventPayload>(
            ScriptEvents.VERIFY_FINISHED,
            (e) => {
                verifyFinished.push(e);
            },
        );

        await bus.publish(
            makeEvent(FlowEvents.TASK_APPROVED, {
                taskId: 'task-V-OK',
                flowId: 'verify-flow',
            }),
        );

        assert.equal(healthProbe.calls.length, 1);
        assert.equal(healthProbe.calls[0].url, 'https://api.example.com/health');
        assert.deepEqual(healthProbe.calls[0].predicate, {
            kind: 'status',
            equals: 200,
        });

        assert.equal(verifyFinished.length, 1);
        const vfPayload = verifyFinished[0].payload as VerifyFinishedEventPayload;
        assert.equal(vfPayload.taskId, 'task-V-OK');
        assert.equal(vfPayload.stepId, 'probe');
        assert.equal(vfPayload.ok, true);

        const starts = startAgents(commands);
        assert.equal(starts.length, 1);
        assert.equal(starts[0].stepId, 'celebrate');

        engine.stop();
    } finally {
        db.close();
    }
});

test('verify: ok=false routes to on_failure', async () => {
    const flow: FlowDefinition = {
        on: 'task.approved',
        steps: [
            {
                id: 'probe',
                agent: FLOW_STEP_KINDS.VERIFY,
                model: 'none',
                on_success: 'celebrate',
                on_failure: 'rollback',
                params: {
                    url: 'https://api.example.com/health',
                    predicate: {
                        kind: 'json-path',
                        path: 'data.ready',
                        equals: true,
                    },
                },
            },
            {
                id: 'celebrate',
                agent: 'developer',
                model: 'sonnet',
                on_success: 'emit:task.finished',
            },
            {
                id: 'rollback',
                agent: 'developer',
                model: 'sonnet',
                on_success: 'emit:task.failed',
            },
        ],
    };
    const flows = new Map<string, FlowDefinition>([['verify-flow', flow]]);
    const healthProbe = new FakeHealthProbe({
        ok: false,
        status: 503,
        body: { data: { ready: false } },
    });
    const { db, bus, commands, engine } = makeHarness(flows, { healthProbe });
    try {
        seedTask(db, 'task-V-FAIL');

        const verifyFinished: StoredEvent[] = [];
        bus.subscribe<VerifyFinishedEventPayload>(
            ScriptEvents.VERIFY_FINISHED,
            (e) => {
                verifyFinished.push(e);
            },
        );

        await bus.publish(
            makeEvent(FlowEvents.TASK_APPROVED, {
                taskId: 'task-V-FAIL',
                flowId: 'verify-flow',
            }),
        );

        assert.deepEqual(healthProbe.calls[0].predicate, {
            kind: 'json-path',
            path: 'data.ready',
            equals: true,
        });

        assert.equal(verifyFinished.length, 1);
        assert.equal(
            (verifyFinished[0].payload as VerifyFinishedEventPayload).ok,
            false,
        );

        const starts = startAgents(commands);
        assert.equal(starts.length, 1);
        assert.equal(starts[0].stepId, 'rollback');

        engine.stop();
    } finally {
        db.close();
    }
});

// ---------------------------------------------------------------------------
// context-update
// ---------------------------------------------------------------------------

test('context-update: spawns AgentRunner with role=curator and routes on_success on the runner\'s AgentFinished', async () => {
    const flow: FlowDefinition = {
        on: 'task.approved',
        steps: [
            {
                id: 'curate',
                agent: FLOW_STEP_KINDS.CONTEXT_UPDATE,
                model: 'none',
                on_success: 'announce',
                on_failure: 'rollback',
                params: {
                    prompt: 'Update CLAUDE.md with the new lifecycle stages.',
                    cwd: 'C:/repo/docs',
                },
            },
            {
                id: 'announce',
                agent: 'developer',
                model: 'sonnet',
                on_success: 'emit:task.finished',
            },
            {
                id: 'rollback',
                agent: 'developer',
                model: 'sonnet',
                on_success: 'emit:task.failed',
            },
        ],
    };
    const flows = new Map<string, FlowDefinition>([['ctx-flow', flow]]);
    const agentRunner = new FakeAgentRunner();
    const { db, bus, commands, engine } = makeHarness(flows, { agentRunner });
    try {
        seedTask(db, 'task-CU');

        await bus.publish(
            makeEvent(FlowEvents.TASK_APPROVED, {
                taskId: 'task-CU',
                flowId: 'ctx-flow',
            }),
        );

        // AgentRunner.start was invoked once with role='curator'.
        assert.equal(agentRunner.specs.length, 1);
        assert.equal(agentRunner.specs[0].role, 'curator');
        assert.equal(
            agentRunner.specs[0].prompt,
            'Update CLAUDE.md with the new lifecycle stages.',
        );
        assert.equal(agentRunner.specs[0].cwd, 'C:/repo/docs');

        // No on_success routing yet — waiting for the runner's AgentFinished.
        let starts = startAgents(commands);
        assert.equal(
            starts.length,
            0,
            'on_success must NOT fire until the curator publishes AgentFinished',
        );

        // Simulate the runner finishing: an AgentFinished arrives for this task.
        // The engine's existing onAgentFinished routes via the current step's
        // on_success target.
        await bus.publish(
            makeEvent(FlowEvents.AGENT_FINISHED, { taskId: 'task-CU' }),
        );

        starts = startAgents(commands);
        assert.equal(starts.length, 1);
        assert.equal(starts[0].stepId, 'announce');

        engine.stop();
    } finally {
        db.close();
    }
});
