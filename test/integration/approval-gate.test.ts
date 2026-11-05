/**
 * AP-VP-017 — end-to-end integration test for the Phase 3 approval gate.
 *
 * Drives the {@link FlowEngine} through a real YAML flow (developer step
 * with `approval: required`, followed by a `pr.open` step that is also
 * `approval: required`) using:
 *
 *   - the real flow loader (`loadFlow`),
 *   - the real approval evaluator (wired into the engine itself), and
 *   - the real `ResumeTask` command handler.
 *
 * Adapter-side dependencies are stubbed with minimal fakes (FakeScriptRunner,
 * FakeHealthProbe, FakeClaudeCliRunner) — the flow under test never reaches
 * a run-script / verify / context-update step, so the script and health
 * probe fakes exist purely to satisfy the engine wiring. The "Claude" fake
 * is wired through the `StartAgent` command handler and records every
 * dispatched step so we can assert that approve actually replays the parked
 * developer step.
 *
 * Two scenarios, each with its own task + DB cleanup:
 *
 *   1. approve — TaskParked{ reason: 'approval', stepId: 'developer' }
 *      fires on entry; ResumeTask{ approve } dispatches the developer step
 *      through the fake; once the test publishes the developer's
 *      AgentFinished the engine advances to `pr.open`, which gates again
 *      and produces a second TaskParked{ reason: 'approval' }.
 *
 *   2. reject — same entry sequence, but ResumeTask{ reject, feedback }
 *      terminates the flow with TaskFailed{ failed_stage: 'rejected' } and
 *      persists the operator's feedback verbatim onto `tasks.feedback`.
 *
 * No board, no HTTP, no real Claude/PR/script runtime — the test exercises
 * the engine + adapter layer only.
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { CommandBus } from '../../core/commands/bus';
import { EventBus } from '../../core/events/bus';
import { EventStore } from '../../core/events/store';
import type { Event, StoredEvent } from '../../core/events/event';
import {
    FlowEngine,
    FlowEvents,
    FlowCommands,
    type FailTaskPayload,
    type StartAgentPayload,
} from '../../core/flow/engine';
import { loadFlow } from '../../core/flow/loader';
import {
    applyMigrations,
    openDatabase,
    type Db,
} from '../../core/state/migrations';
import type {
    AgentHandle,
    AgentRunner,
    AgentSpec,
    Logger,
} from '../../core/ports';
import type {
    HealthProbe,
    HealthProbeResult,
} from '../../core/ports/HealthProbe';
import type {
    ScriptRunner,
    ScriptRunResult,
} from '../../core/ports/ScriptRunner';
import {
    TaskParkingCommands,
    TaskParkingEvents,
    createResumeTaskHandler,
    type ResumeTaskPayload,
    type TaskParkedEventPayload,
} from '../../core/commands';
import type { Command } from '../../core/commands/command';

// ---------------------------------------------------------------------------
// Dual-runner shim — keeps the file discoverable under both `node --test`
// (the repo's `npm test`) and `vitest run <path>`. Same pattern as
// core/flow/engine.approval-gate.test.ts.
// ---------------------------------------------------------------------------

type TestFn = (
    name: string,
    optionsOrFn: unknown,
    maybeFn?: () => void | Promise<void>,
) => void;
type DescribeFn = (name: string, fn: () => void) => void;

const { test, describe } = ((): { test: TestFn; describe: DescribeFn } => {
    if (process.env.VITEST) {
        const g = globalThis as {
            test?: TestFn;
            describe?: DescribeFn;
        };
        if (typeof g.test !== 'function' || typeof g.describe !== 'function') {
            throw new Error(
                'approval-gate.test.ts: VITEST=true but globalThis.{test,describe} are missing — '
                    + 'ensure vitest.config.ts sets test.globals = true',
            );
        }
        return { test: g.test, describe: g.describe };
    }
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    const nt = require('node:test') as {
        test: TestFn;
        describe: DescribeFn;
    };
    return { test: nt.test, describe: nt.describe };
})();

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FLOW_ID = 'approval-gate-integration';
const REJECTION_FEEDBACK = 'wrong file';
const TEST_TIMEOUT_MS = 10_000;

class SilentLogger implements Logger {
    info(): void {}
    warn(): void {}
    error(): void {}
    debug(): void {}
}

/**
 * Records every `start` call so the test can assert the engine actually
 * dispatched the parked step through the runner port after approve.
 * Stays inert otherwise: lifecycle events (AgentStarted / AgentFinished)
 * are published by the test driver, not the fake, so each scenario can
 * choreograph the timing without races.
 */
class FakeClaudeCliRunner implements AgentRunner {
    readonly calls: AgentSpec[] = [];
    private counter = 0;

    start(spec: AgentSpec): AgentHandle {
        this.calls.push(spec);
        return { id: `fake-claude-${++this.counter}`, spec };
    }

    async interrupt(): Promise<void> {
        // No process to cancel.
    }
}

class FakeScriptRunner implements ScriptRunner {
    readonly calls: Array<{
        scriptPath: string;
        args: readonly string[];
        cwd: string;
    }> = [];

    async run(
        scriptPath: string,
        args: readonly string[],
        cwd: string,
    ): Promise<ScriptRunResult> {
        this.calls.push({ scriptPath, args, cwd });
        return { exitCode: 0, stdoutPath: '', stderrPath: '' };
    }
}

class FakeHealthProbe implements HealthProbe {
    readonly calls: string[] = [];

    async probe(url: string): Promise<HealthProbeResult> {
        this.calls.push(url);
        return { ok: true, status: 200 };
    }
}

interface Harness {
    readonly workspace: string;
    readonly db: Db;
    readonly bus: EventBus;
    readonly commandBus: CommandBus<unknown>;
    readonly engine: FlowEngine;
    readonly claudeRunner: FakeClaudeCliRunner;
    readonly scriptRunner: FakeScriptRunner;
    readonly healthProbe: FakeHealthProbe;
    readonly parked: StoredEvent[];
    readonly failed: StoredEvent[];
    readonly agentToTask: Map<string, string>;
    teardown(): void;
}

/**
 * Write the approval-gate flow YAML to a tmp dir and return the file path.
 * The flow's `on` field matches the engine's TASK_APPROVED event type so
 * the YAML round-trips through the real loader and the engine's resolved
 * flow map keys off `FLOW_ID`.
 */
function writeFlowYaml(workspace: string): string {
    const file = path.join(workspace, `${FLOW_ID}.yaml`);
    fs.writeFileSync(
        file,
        [
            '# Integration fixture — developer + pr.open, both approval: required.',
            'on: task.approved',
            'steps:',
            '  - id: developer',
            '    agent: developer',
            '    model: claude-opus-4-7',
            '    on_success: open-pr',
            '    approval: required',
            '  - id: open-pr',
            '    agent: pr.open',
            '    model: none',
            '    on_success: emit:TaskFinished',
            '    approval: required',
            '    params:',
            '      title: integration PR',
            '      base: main',
            '      head: feature/integration',
            '',
        ].join('\n'),
        'utf8',
    );
    return file;
}

function seedTask(db: Db, taskId: string): void {
    const planId = `plan-${taskId}`;
    db.prepare(
        'INSERT INTO plans(id, project_id, status, created_at) VALUES (?, ?, ?, ?)',
    ).run(planId, 'proj-vp-017', 'approved', 1_700_000_000_000);
    db.prepare(
        'INSERT INTO tasks(id, plan_id, type, status) VALUES (?, ?, ?, ?)',
    ).run(taskId, planId, 'feature', 'approved');
}

function flowState(
    db: Db,
    taskId: string,
):
    | { current_step: string; parked_step_id: string | null }
    | undefined {
    return db
        .prepare(
            'SELECT current_step, parked_step_id FROM flow_state WHERE task_id = ?',
        )
        .get(taskId) as
        | { current_step: string; parked_step_id: string | null }
        | undefined;
}

function readFeedback(db: Db, taskId: string): string | null {
    const row = db
        .prepare('SELECT feedback FROM tasks WHERE id = ?')
        .get(taskId) as { feedback: string | null } | undefined;
    return row?.feedback ?? null;
}

let harnessCounter = 0;

/**
 * Stand up the engine + fakes against a fresh in-memory SQLite, write the
 * fixture YAML, and load it via the real loader. Each scenario calls this
 * once so its assertions are insulated from sibling state.
 */
function makeHarness(): Harness {
    harnessCounter++;
    const workspace = fs.mkdtempSync(
        path.join(os.tmpdir(), `ap-vp-017-approval-gate-${harnessCounter}-`),
    );

    const db = openDatabase(':memory:');
    applyMigrations(db);

    const logger = new SilentLogger();
    const store = new EventStore(db);
    const bus = new EventBus(store, logger);
    const commandBus = new CommandBus<unknown>(bus, () => undefined);

    const claudeRunner = new FakeClaudeCliRunner();
    const scriptRunner = new FakeScriptRunner();
    const healthProbe = new FakeHealthProbe();

    // Map fake agent id → task id so the test can publish a follow-up
    // AgentFinished bridged to FlowEvents.AGENT_FINISHED with the right
    // task id (mirroring how a real host wires the ClaudeCliRunner).
    const agentToTask = new Map<string, string>();

    // ---- command handlers -------------------------------------------------
    commandBus.register<StartAgentPayload>(
        FlowCommands.START_AGENT,
        async (cmd) => {
            const spec: AgentSpec = {
                role: cmd.payload.agent,
                prompt: `step ${cmd.payload.stepId} for task ${cmd.payload.taskId}`,
                metadata: {
                    taskId: cmd.payload.taskId,
                    stepId: cmd.payload.stepId,
                    model: cmd.payload.model,
                    ...(cmd.payload.context ?? {}),
                },
            };
            const handle = claudeRunner.start(spec);
            agentToTask.set(handle.id, cmd.payload.taskId);
            return [];
        },
    );

    commandBus.register<FailTaskPayload>(FlowCommands.FAIL_TASK, async (cmd) => {
        // The flow under test never reaches a FailTask dispatch — surfacing
        // it loudly catches accidental routing regressions.
        throw new Error(
            `FAIL_TASK fired for task ${cmd.payload.taskId}: ${cmd.payload.reason}`,
        );
    });
    commandBus.register(FlowCommands.FINISH_TASK, async () => []);
    commandBus.register(FlowCommands.REQUEST_INVESTIGATION, async () => []);

    // Real ResumeTask handler so the resume path exercises the same
    // command → event translation the operator would use through the board.
    commandBus.register<ResumeTaskPayload>(
        TaskParkingCommands.RESUME_TASK,
        createResumeTaskHandler({ clock: () => 1_700_000_000_000 }),
    );

    // ---- event capture ----------------------------------------------------
    const parked: StoredEvent[] = [];
    bus.subscribe<TaskParkedEventPayload>(TaskParkingEvents.TASK_PARKED, (e) => {
        parked.push(e);
    });
    const failed: StoredEvent[] = [];
    bus.subscribe('TaskFailed', (e) => {
        failed.push(e);
    });

    // ---- engine -----------------------------------------------------------
    const flowFile = writeFlowYaml(workspace);
    const flowDef = loadFlow(flowFile);
    const flows = new Map([[FLOW_ID, flowDef]]);

    const engine = FlowEngine.start(bus, commandBus, flows, {
        db,
        logger,
        clock: () => 1_700_000_000_000,
        scriptRunner,
        healthProbe,
        // No prGateway: the test never reaches a dispatched pr.open — the
        // second approval gate parks the task before the gateway is invoked.
    });

    const teardown = (): void => {
        try {
            engine.stop();
        } catch {
            // ignore
        }
        try {
            db.close();
        } catch {
            // ignore
        }
        try {
            fs.rmSync(workspace, { recursive: true, force: true });
        } catch {
            // Best-effort on Windows where a stray handle may briefly hold
            // the file. Swallowing here so a teardown failure does not mask
            // a real assertion failure.
        }
    };

    return {
        workspace,
        db,
        bus,
        commandBus,
        engine,
        claudeRunner,
        scriptRunner,
        healthProbe,
        parked,
        failed,
        agentToTask,
        teardown,
    };
}

let evCounter = 0;
function makeEvent(type: string, payload: unknown): Event {
    evCounter++;
    return {
        type,
        v: 1,
        occurredAt: 1_700_000_000_000,
        idempotencyKey: `ap-vp-017-${process.pid}-${evCounter}`,
        payload,
    };
}

// ---------------------------------------------------------------------------
// Integration scenarios
// ---------------------------------------------------------------------------

describe('Integration — approval gate, full engine path (AP-VP-017)', () => {
    test(
        'approve: parks developer, dispatches on resume, then parks again at pr.open',
        { timeout: TEST_TIMEOUT_MS },
        async () => {
            const h = makeHarness();
            const taskId = 'task-approve';
            try {
                seedTask(h.db, taskId);

                // ---- 1. Entry: TaskApproved drives the first park -------
                await h.bus.publish(
                    makeEvent(FlowEvents.TASK_APPROVED, {
                        taskId,
                        flowId: FLOW_ID,
                    }),
                );

                assert.equal(
                    h.claudeRunner.calls.length,
                    0,
                    'developer must NOT run before the operator approves',
                );
                assert.equal(
                    h.parked.length,
                    1,
                    'expected one TaskParked on the developer gate',
                );
                const firstPark = h.parked[0]
                    .payload as TaskParkedEventPayload;
                assert.equal(firstPark.taskId, taskId);
                assert.equal(firstPark.stepId, 'developer');
                assert.equal(firstPark.reason, 'approval');

                const stateBeforeResume = flowState(h.db, taskId);
                assert.ok(
                    stateBeforeResume,
                    'flow_state must be created on park',
                );
                assert.equal(stateBeforeResume!.current_step, 'developer');
                assert.equal(stateBeforeResume!.parked_step_id, 'developer');

                // ---- 2. Resume(approve) dispatches the developer step ----
                const resumeCmd: Command<ResumeTaskPayload> = {
                    type: TaskParkingCommands.RESUME_TASK,
                    actor: 'operator-1',
                    issuedAt: 1_700_000_000_000,
                    payload: { taskId, decision: 'approve' },
                };
                await h.commandBus.send(resumeCmd);

                assert.equal(
                    h.claudeRunner.calls.length,
                    1,
                    'approve must dispatch the parked developer step exactly once',
                );
                const developerSpec = h.claudeRunner.calls[0];
                assert.equal(developerSpec.role, 'developer');
                assert.equal(
                    (developerSpec.metadata as { stepId?: string }).stepId,
                    'developer',
                );

                const stateAfterResume = flowState(h.db, taskId);
                assert.equal(
                    stateAfterResume?.parked_step_id,
                    null,
                    'parked_step_id must clear when approve dispatches',
                );

                // ---- 3. AgentFinished routes to the next gate -----------
                const developerHandleId =
                    h.claudeRunner.calls.length > 0
                        ? `fake-claude-${h.claudeRunner.calls.length}`
                        : '';
                const mappedTaskId = h.agentToTask.get(developerHandleId);
                assert.equal(
                    mappedTaskId,
                    taskId,
                    'fake runner handle must be mapped back to the task id',
                );

                await h.bus.publish(
                    makeEvent(FlowEvents.AGENT_FINISHED, { taskId }),
                );

                assert.equal(
                    h.claudeRunner.calls.length,
                    1,
                    'pr.open is gateway-dispatched — no second StartAgent call',
                );
                assert.equal(
                    h.parked.length,
                    2,
                    'pr.open must publish a second TaskParked on its approval gate',
                );
                const secondPark = h.parked[1]
                    .payload as TaskParkedEventPayload;
                assert.equal(secondPark.taskId, taskId);
                assert.equal(secondPark.stepId, 'open-pr');
                assert.equal(secondPark.reason, 'approval');

                const stateAtPrPark = flowState(h.db, taskId);
                assert.equal(stateAtPrPark?.current_step, 'open-pr');
                assert.equal(stateAtPrPark?.parked_step_id, 'open-pr');

                assert.equal(
                    h.failed.length,
                    0,
                    'no TaskFailed on the happy path',
                );
                assert.equal(
                    h.scriptRunner.calls.length,
                    0,
                    'flow has no run-script steps',
                );
                assert.equal(
                    h.healthProbe.calls.length,
                    0,
                    'flow has no verify steps',
                );
            } finally {
                h.teardown();
            }
        },
    );

    test(
        'reject with feedback: emits TaskFailed{ failed_stage: rejected } and persists tasks.feedback',
        { timeout: TEST_TIMEOUT_MS },
        async () => {
            const h = makeHarness();
            const taskId = 'task-reject';
            try {
                seedTask(h.db, taskId);

                await h.bus.publish(
                    makeEvent(FlowEvents.TASK_APPROVED, {
                        taskId,
                        flowId: FLOW_ID,
                    }),
                );
                assert.equal(
                    h.parked.length,
                    1,
                    'precondition: developer must be parked on the approval gate',
                );
                assert.equal(
                    readFeedback(h.db, taskId),
                    null,
                    'precondition: tasks.feedback starts NULL',
                );

                const resumeCmd: Command<ResumeTaskPayload> = {
                    type: TaskParkingCommands.RESUME_TASK,
                    actor: 'operator-1',
                    issuedAt: 1_700_000_000_000,
                    payload: {
                        taskId,
                        decision: 'reject',
                        feedback: REJECTION_FEEDBACK,
                    },
                };
                await h.commandBus.send(resumeCmd);

                assert.equal(
                    h.claudeRunner.calls.length,
                    0,
                    'reject must NOT dispatch the parked developer step',
                );
                assert.equal(
                    h.failed.length,
                    1,
                    'reject without on_failure must emit exactly one TaskFailed',
                );
                assert.deepEqual(h.failed[0].payload, {
                    taskId,
                    failed_stage: 'rejected',
                });

                assert.equal(
                    readFeedback(h.db, taskId),
                    REJECTION_FEEDBACK,
                    'tasks.feedback must carry the operator string verbatim',
                );

                const stateAfterReject = flowState(h.db, taskId);
                assert.equal(
                    stateAfterReject?.parked_step_id,
                    null,
                    'parked_step_id must clear on reject',
                );
                assert.equal(
                    h.parked.length,
                    1,
                    'no second TaskParked on the rejection terminal',
                );
            } finally {
                h.teardown();
            }
        },
    );
});
