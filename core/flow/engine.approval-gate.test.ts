/**
 * AP-VP-007: approval-gate tests.
 *
 * Covers the new gate the engine runs before every command-producing step
 * dispatch (StartAgent / OpenPullRequest / MergePullRequest). The gate is
 * driven by {@link evaluateApproval} over the step's resolved approval
 * value; when it returns `'required'` the engine parks the task at the
 * step (TaskParked reason=approval, parked_step_id persisted) and a
 * subsequent ResumeTask branches the resume on `decision`:
 *
 *   approve → dispatch the parked step (gate bypassed), clear parked_step_id.
 *   reject  → follow the step's on_failure or, when absent, emit
 *             `TaskFailed{ failed_stage: 'rejected' }`. `feedback` (when
 *             provided) is persisted on `tasks.feedback`.
 *
 * The file mirrors the dual-runner shim used by `engine.start-mode.test.ts`
 * so it is discoverable under both `node --test` (the repo's `npm test`)
 * and `vitest` (the review pipeline).
 */

import * as assert from 'node:assert/strict';

import { openDatabase, applyMigrations, type Db } from '../state/migrations';
import { EventStore } from '../events/store';
import { EventBus } from '../events/bus';
import { CommandBus } from '../commands/bus';
import type { Command } from '../commands/command';
import type { Event, StoredEvent } from '../events/event';
import type { Logger } from '../ports/Logger';
import type { FlowDefinition, FlowStep } from './types';
import {
    FlowEngine,
    FlowEvents,
    FlowCommands,
    type StartAgentPayload,
} from './engine';
import {
    TaskParkingEvents,
    type TaskParkedEventPayload,
    type TaskResumedEventPayload,
} from '../commands';
import { ProjectRegistry, type ApprovalOverride } from '../projects/registry';
import type {
    MergePullRequestOptions,
    OpenedPullRequest,
    OpenPullRequestSpec,
    PullRequestGateway,
} from '../ports/pull-request-gateway';

// ---------------------------------------------------------------------------
// Dual-runner test() shim — see engine.start-mode.test.ts header for rationale.
// ---------------------------------------------------------------------------

type TestFn = (name: string, fn: () => void | Promise<void>) => void;

const test: TestFn = (((): TestFn => {
    if (process.env.VITEST) {
        const gt = (globalThis as { test?: TestFn }).test;
        if (typeof gt !== 'function') {
            throw new Error(
                'engine.approval-gate.test.ts: VITEST=true but globalThis.test is missing — '
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
        idempotencyKey: `apgate-${process.pid}-${evCounter}`,
        payload,
    };
}

function seedTask(db: Db, taskId: string): void {
    const planId = `plan-${taskId}`;
    db.prepare(
        'INSERT INTO plans(id, project_id, status, created_at) VALUES (?, ?, ?, ?)',
    ).run(planId, 'proj-vp-007', 'approved', 1_700_000_000_000);
    db.prepare(
        'INSERT INTO tasks(id, plan_id, type, status) VALUES (?, ?, ?, ?)',
    ).run(taskId, planId, 'feature', 'approved');
}

interface Harness {
    db: Db;
    bus: EventBus;
    commands: Command[];
    parked: StoredEvent[];
    failed: StoredEvent[];
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
    extras?: {
        projectRegistry?: ProjectRegistry;
        prGateway?: PullRequestGateway;
    },
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

    const parked: StoredEvent[] = [];
    bus.subscribe<TaskParkedEventPayload>(TaskParkingEvents.TASK_PARKED, (e) => {
        parked.push(e);
    });
    const failed: StoredEvent[] = [];
    bus.subscribe('TaskFailed', (e) => {
        failed.push(e);
    });

    const engine = FlowEngine.start(bus, cmdBus, flows, {
        db,
        logger,
        ...(extras?.projectRegistry
            ? { projectRegistry: extras.projectRegistry }
            : {}),
        ...(extras?.prGateway ? { prGateway: extras.prGateway } : {}),
    });
    return { db, bus, commands, parked, failed, engine };
}

// ---------------------------------------------------------------------------
// AP-IFV-001: per-project approval_override precedence helpers.
//
// `writeRegistry` materialises a real ProjectRegistry on a tmp directory so
// the engine's DB-driven `tasks.plan_id → plans.project_id → registry.get`
// resolution chain is exercised end-to-end — a stubbed registry would skip
// the very lookup we want to cover.
// ---------------------------------------------------------------------------

const PRECEDENCE_PROJECT_ID = 'proj-vp-007';

/**
 * Build a registry carrying one project's approval overrides.
 *
 * Overrides live on the `projects` row (`metadata.approvalOverride`) now
 * that project config is worker state rather than
 * `config/projects/<id>/project.json`. The gate logic under test is
 * unchanged — only where the override is read from.
 */
function writeRegistry(approvalOverride: ApprovalOverride): ProjectRegistry {
    const db = openDatabase(':memory:');
    applyMigrations(db);
    db.prepare(
        `INSERT INTO projects(id, name, metadata, archived_at, updated_at)
         VALUES (?, 'Precedence Fixture', ?, NULL, 1)`,
    ).run(PRECEDENCE_PROJECT_ID, JSON.stringify({ approvalOverride }));
    return ProjectRegistry.fromDb(db);
}

/**
 * Test-double {@link PullRequestGateway}. Captures every call so the
 * precedence tests can assert that an `'auto'` override actually let the
 * step reach the gateway (proving the gate did NOT park).
 */
class RecordingPrGateway implements PullRequestGateway {
    readonly opens: OpenPullRequestSpec[] = [];
    readonly merges: Array<{ number: number; options: MergePullRequestOptions }> = [];

    async push(): Promise<void> {}

    async openPullRequest(spec: OpenPullRequestSpec): Promise<OpenedPullRequest> {
        this.opens.push(spec);
        return { number: this.opens.length, url: `https://example/pr/${this.opens.length}` };
    }

    async mergePullRequest(
        n: number,
        options: MergePullRequestOptions,
    ): Promise<void> {
        this.merges.push({ number: n, options });
    }

    async addComment(): Promise<void> {}
}

function startAgents(commands: ReadonlyArray<Command>): StartAgentPayload[] {
    return commands
        .filter((c) => c.type === FlowCommands.START_AGENT)
        .map((c) => c.payload as StartAgentPayload);
}

function flowState(
    db: Db,
    taskId: string,
): {
    current_step: string;
    parked_step_id: string | null;
} | undefined {
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
        .get(taskId) as { feedback: string | null };
    return row.feedback;
}

// A two-step flow:
//   step "review" — agent step with approval='required' (gate fires).
//                   on_success → "develop"; on_failure deliberately omitted
//                   in the base fixture so the reject-without-on_failure
//                   case can rely on the default TaskFailed emission.
//   step "develop" — auto agent step that follows on approve.
// Cloned per-test so tests can mutate on_failure without affecting siblings.
function reviewThenDevelopFlow(overrides?: {
    on_failure?: string;
}): FlowDefinition {
    const reviewStep: FlowStep = overrides?.on_failure !== undefined
        ? {
            id: 'review',
            agent: 'reviewer',
            model: 'sonnet',
            on_success: 'develop',
            on_failure: overrides.on_failure,
            approval: 'required',
        }
        : {
            id: 'review',
            agent: 'reviewer',
            model: 'sonnet',
            on_success: 'develop',
            approval: 'required',
        };
    return {
        on: 'task.approved',
        steps: [
            reviewStep,
            {
                id: 'develop',
                agent: 'developer',
                model: 'sonnet',
                on_success: 'emit:task.finished',
            },
        ],
    };
}

// ---------------------------------------------------------------------------
// 1. Gate fires: approval=required parks the task, no command dispatched.
// ---------------------------------------------------------------------------

test('approval gate: required parks the task with reason=approval and persists parked_step_id', async () => {
    const flows = new Map<string, FlowDefinition>([
        ['gated', reviewThenDevelopFlow()],
    ]);
    const { db, bus, commands, parked, engine } = makeHarness(flows);
    try {
        seedTask(db, 'task-gate');

        await bus.publish(
            makeEvent(FlowEvents.TASK_APPROVED, {
                taskId: 'task-gate',
                flowId: 'gated',
            }),
        );

        // Gate must short-circuit before any StartAgent is built.
        assert.equal(
            startAgents(commands).length,
            0,
            'approval=required must NOT dispatch a StartAgent',
        );

        // TaskParked with reason=approval was published.
        assert.equal(parked.length, 1, 'expected exactly one TaskParked event');
        const payload = parked[0].payload as TaskParkedEventPayload;
        assert.equal(payload.taskId, 'task-gate');
        assert.equal(payload.stepId, 'review');
        assert.equal(payload.reason, 'approval');

        // parked_step_id projected onto flow_state so resume routes back here.
        const fs = flowState(db, 'task-gate');
        assert.ok(fs, 'flow_state row must be created on park');
        assert.equal(fs!.current_step, 'review');
        assert.equal(fs!.parked_step_id, 'review');

        engine.stop();
    } finally {
        db.close();
    }
});

// ---------------------------------------------------------------------------
// 2. Gate skips: approval=auto dispatches normally.
// ---------------------------------------------------------------------------

test('approval gate: auto (default for agent steps) dispatches StartAgent without parking', async () => {
    const flow: FlowDefinition = {
        on: 'task.approved',
        steps: [
            {
                id: 'develop',
                agent: 'developer',
                model: 'sonnet',
                on_success: 'emit:task.finished',
                approval: 'auto',
            },
        ],
    };
    const flows = new Map<string, FlowDefinition>([['auto-step', flow]]);
    const { db, bus, commands, parked, engine } = makeHarness(flows);
    try {
        seedTask(db, 'task-auto');

        await bus.publish(
            makeEvent(FlowEvents.TASK_APPROVED, {
                taskId: 'task-auto',
                flowId: 'auto-step',
            }),
        );

        const starts = startAgents(commands);
        assert.equal(starts.length, 1, 'approval=auto must dispatch');
        assert.equal(starts[0].stepId, 'develop');

        assert.equal(parked.length, 0, 'no TaskParked must fire when approval=auto');

        const fs = flowState(db, 'task-auto');
        assert.equal(
            fs?.parked_step_id,
            null,
            'parked_step_id must stay NULL on an auto dispatch',
        );

        engine.stop();
    } finally {
        db.close();
    }
});

// ---------------------------------------------------------------------------
// 3. Resume(approve): dispatch the parked step and clear parked_step_id.
// ---------------------------------------------------------------------------

test('resume(approve): dispatches the parked step and clears parked_step_id', async () => {
    const flows = new Map<string, FlowDefinition>([
        ['gated', reviewThenDevelopFlow()],
    ]);
    const { db, bus, commands, parked, engine } = makeHarness(flows);
    try {
        seedTask(db, 'task-approve');

        await bus.publish(
            makeEvent(FlowEvents.TASK_APPROVED, {
                taskId: 'task-approve',
                flowId: 'gated',
            }),
        );
        assert.equal(parked.length, 1, 'precondition: parked on gate');
        assert.equal(startAgents(commands).length, 0);

        await bus.publish(
            makeEvent(TaskParkingEvents.TASK_RESUMED, {
                taskId: 'task-approve',
                actor: 'operator-1',
                decision: 'approve',
            } satisfies TaskResumedEventPayload),
        );

        // The parked agent step (`review`) is dispatched (gate bypassed on resume).
        const starts = startAgents(commands);
        assert.equal(starts.length, 1, 'approve must replay the parked step as StartAgent');
        assert.equal(starts[0].stepId, 'review');
        assert.equal(starts[0].agent, 'reviewer');

        const fs = flowState(db, 'task-approve');
        assert.equal(fs?.current_step, 'review');
        assert.equal(
            fs?.parked_step_id,
            null,
            'parked_step_id must be cleared on approve',
        );

        engine.stop();
    } finally {
        db.close();
    }
});

// ---------------------------------------------------------------------------
// 4. Resume(reject) WITHOUT on_failure: emit TaskFailed{ failed_stage='rejected' }.
// ---------------------------------------------------------------------------

test('resume(reject) without on_failure: emits TaskFailed{ failed_stage: "rejected" } and clears parked_step_id', async () => {
    const flows = new Map<string, FlowDefinition>([
        ['gated', reviewThenDevelopFlow()],
    ]);
    const { db, bus, commands, parked, failed, engine } = makeHarness(flows);
    try {
        seedTask(db, 'task-reject');

        await bus.publish(
            makeEvent(FlowEvents.TASK_APPROVED, {
                taskId: 'task-reject',
                flowId: 'gated',
            }),
        );
        assert.equal(parked.length, 1, 'precondition: parked on gate');

        await bus.publish(
            makeEvent(TaskParkingEvents.TASK_RESUMED, {
                taskId: 'task-reject',
                actor: 'operator-1',
                decision: 'reject',
            } satisfies TaskResumedEventPayload),
        );

        // No StartAgent issued — rejection terminates the flow.
        assert.equal(
            startAgents(commands).length,
            0,
            'reject must NOT dispatch the parked step',
        );

        // Default rejection terminal: TaskFailed{ taskId, failed_stage: 'rejected' }.
        assert.equal(failed.length, 1, 'expected exactly one TaskFailed event');
        assert.deepEqual(failed[0].payload, {
            taskId: 'task-reject',
            failed_stage: 'rejected',
        });

        const fs = flowState(db, 'task-reject');
        assert.equal(
            fs?.parked_step_id,
            null,
            'parked_step_id must be cleared on reject',
        );

        engine.stop();
    } finally {
        db.close();
    }
});

// ---------------------------------------------------------------------------
// 5. Resume(reject) WITH on_failure: route through the on_failure transition.
// ---------------------------------------------------------------------------

test('resume(reject) with on_failure: follows the on_failure transition (no default TaskFailed)', async () => {
    const flow: FlowDefinition = {
        on: 'task.approved',
        steps: [
            {
                id: 'review',
                agent: 'reviewer',
                model: 'sonnet',
                on_success: 'develop',
                on_failure: 'emit:ReviewRejected',
                approval: 'required',
            },
            {
                id: 'develop',
                agent: 'developer',
                model: 'sonnet',
                on_success: 'emit:task.finished',
            },
        ],
    };
    const flows = new Map<string, FlowDefinition>([['gated-onfail', flow]]);
    const { db, bus, commands, parked, failed, engine } = makeHarness(flows);
    try {
        const rejected: StoredEvent[] = [];
        bus.subscribe('ReviewRejected', (e) => {
            rejected.push(e);
        });

        seedTask(db, 'task-reject-onfail');
        await bus.publish(
            makeEvent(FlowEvents.TASK_APPROVED, {
                taskId: 'task-reject-onfail',
                flowId: 'gated-onfail',
            }),
        );
        assert.equal(parked.length, 1, 'precondition: parked on gate');

        await bus.publish(
            makeEvent(TaskParkingEvents.TASK_RESUMED, {
                taskId: 'task-reject-onfail',
                actor: 'operator-1',
                decision: 'reject',
            } satisfies TaskResumedEventPayload),
        );

        // The configured on_failure transition fired — NOT the default TaskFailed.
        assert.equal(rejected.length, 1, 'on_failure emit must fire on reject');
        assert.deepEqual(rejected[0].payload, { taskId: 'task-reject-onfail' });
        assert.equal(
            failed.length,
            0,
            'default TaskFailed must NOT fire when on_failure is set',
        );
        assert.equal(
            startAgents(commands).length,
            0,
            'reject must NOT dispatch the parked step',
        );

        const fs = flowState(db, 'task-reject-onfail');
        assert.equal(fs?.parked_step_id, null);

        engine.stop();
    } finally {
        db.close();
    }
});

// ---------------------------------------------------------------------------
// 6. Collapsed first-step behavior: start_mode is no longer a separate
//    branch — TaskCreated routes through the same approval gate. A flow
//    whose first step resolves to `approval='auto'` dispatches immediately;
//    a flow whose first step resolves to `approval='required'` parks on
//    TaskCreated and resumes via TaskResumed (NOT TaskApproved).
// ---------------------------------------------------------------------------

test('collapsed first-step: approval=auto dispatches immediately on TaskCreated', async () => {
    const flow: FlowDefinition = {
        on: 'task.created',
        start_mode: 'auto',
        steps: [
            {
                id: 'develop',
                agent: 'developer',
                model: 'sonnet',
                on_success: 'emit:task.finished',
                approval: 'auto',
            },
        ],
    };
    const flows = new Map<string, FlowDefinition>([['auto-first', flow]]);
    const { db, bus, commands, parked, engine } = makeHarness(flows);
    try {
        seedTask(db, 'task-tc-auto');

        await bus.publish(
            makeEvent(FlowEvents.TASK_CREATED, {
                taskId: 'task-tc-auto',
                flowId: 'auto-first',
            }),
        );

        const starts = startAgents(commands);
        assert.equal(
            starts.length,
            1,
            'TaskCreated must dispatch via the gate when approval=auto — no separate start_mode branch needed',
        );
        assert.equal(starts[0].stepId, 'develop');
        assert.equal(
            parked.length,
            0,
            'TaskCreated must NOT park when the first step resolves to approval=auto',
        );

        engine.stop();
    } finally {
        db.close();
    }
});

test('collapsed first-step: approval=required parks on TaskCreated and resumes via TaskResumed (not TaskApproved)', async () => {
    const flow: FlowDefinition = {
        on: 'task.created',
        start_mode: 'approval-required',
        steps: [
            {
                id: 'review',
                agent: 'reviewer',
                model: 'sonnet',
                on_success: 'emit:task.finished',
                approval: 'required',
            },
        ],
    };
    const flows = new Map<string, FlowDefinition>([['required-first', flow]]);
    const { db, bus, commands, parked, engine } = makeHarness(flows);
    try {
        seedTask(db, 'task-tc-req');

        await bus.publish(
            makeEvent(FlowEvents.TASK_CREATED, {
                taskId: 'task-tc-req',
                flowId: 'required-first',
            }),
        );

        assert.equal(
            startAgents(commands).length,
            0,
            'TaskCreated must NOT dispatch when first step resolves to approval=required',
        );
        assert.equal(parked.length, 1, 'TaskCreated must publish exactly one TaskParked');
        const parkedPayload = parked[0].payload as TaskParkedEventPayload;
        assert.equal(parkedPayload.reason, 'approval');
        assert.equal(parkedPayload.stepId, 'review');

        const fsBeforeResume = flowState(db, 'task-tc-req');
        assert.equal(fsBeforeResume?.parked_step_id, 'review');

        // Resume via TaskResumed (the new universal resume path). A
        // TaskApproved here would be a no-op because flow_state already
        // exists — verifying explicitly that resume routes through
        // TaskResumed, NOT TaskApproved.
        await bus.publish(
            makeEvent(FlowEvents.TASK_APPROVED, {
                taskId: 'task-tc-req',
                flowId: 'required-first',
            }),
        );
        assert.equal(
            startAgents(commands).length,
            0,
            'TaskApproved must NOT dispatch a parked-at-gate task — resume is owned by TaskResumed',
        );

        await bus.publish(
            makeEvent(TaskParkingEvents.TASK_RESUMED, {
                taskId: 'task-tc-req',
                actor: 'operator-1',
                decision: 'approve',
            } satisfies TaskResumedEventPayload),
        );

        const startsAfterResume = startAgents(commands);
        assert.equal(
            startsAfterResume.length,
            1,
            'TaskResumed(approve) must dispatch the parked first step',
        );
        assert.equal(startsAfterResume[0].stepId, 'review');

        const fsAfterResume = flowState(db, 'task-tc-req');
        assert.equal(fsAfterResume?.parked_step_id, null);

        engine.stop();
    } finally {
        db.close();
    }
});

// ---------------------------------------------------------------------------
// 7. feedback persists to tasks.feedback on reject.
// ---------------------------------------------------------------------------

test('resume(reject) with feedback: persists tasks.feedback verbatim', async () => {
    const flows = new Map<string, FlowDefinition>([
        ['gated', reviewThenDevelopFlow()],
    ]);
    const { db, bus, parked, engine } = makeHarness(flows);
    try {
        seedTask(db, 'task-feedback');
        await bus.publish(
            makeEvent(FlowEvents.TASK_APPROVED, {
                taskId: 'task-feedback',
                flowId: 'gated',
            }),
        );
        assert.equal(parked.length, 1, 'precondition: parked on gate');
        assert.equal(
            readFeedback(db, 'task-feedback'),
            null,
            'feedback is NULL before reject',
        );

        await bus.publish(
            makeEvent(TaskParkingEvents.TASK_RESUMED, {
                taskId: 'task-feedback',
                actor: 'operator-1',
                decision: 'reject',
                feedback: 'tighten the SQL guard before retrying',
            } satisfies TaskResumedEventPayload),
        );

        assert.equal(
            readFeedback(db, 'task-feedback'),
            'tighten the SQL guard before retrying',
            'tasks.feedback must carry the operator string verbatim',
        );

        engine.stop();
    } finally {
        db.close();
    }
});

// ---------------------------------------------------------------------------
// 8. AP-IFV-001: per-project approval_override precedence.
//
// The resolution chain `project override > flow YAML > built-in default` is
// covered by three tests:
//
//   8a. override-beats-YAML — override 'required' over YAML 'auto' parks.
//       The reverse: override 'auto' over YAML 'required' dispatches.
//   8b. override-beats-default — override 'required' on an agent step whose
//       YAML omits `approval` (default is 'auto' for free-form agent kinds)
//       parks. The reverse: override 'auto' on a `pr.open` step whose YAML
//       omits `approval` (default 'required') dispatches.
//   8c. fall-through — without an override for the flow, the gate respects
//       the YAML value when set, and the built-in default when YAML omits
//       the field. No registry-side state is touched in this case.
//
// Each test seeds a fresh tmp project directory so the engine's real
// `tasks.plan_id → plans.project_id → ProjectRegistry.get(...)` lookup
// path is exercised end-to-end — a hand-rolled registry stub would
// short-circuit the very chain we want to verify.
// ---------------------------------------------------------------------------

test('AP-IFV-001 precedence (a): project override beats YAML on agent and PR steps', async () => {
    // Agent step: YAML 'auto' would dispatch; override 'required' must park.
    const developerFlow: FlowDefinition = {
        on: 'task.approved',
        steps: [
            {
                id: 'develop',
                agent: 'developer',
                model: 'sonnet',
                on_success: 'emit:task.finished',
                approval: 'auto',
            },
        ],
    };
    // PR step: YAML 'required' would park; override 'auto' must dispatch
    // through the wired gateway.
    const prFlow: FlowDefinition = {
        on: 'task.approved',
        steps: [
            {
                id: 'open-pr',
                agent: 'pr.open',
                model: 'sonnet',
                on_success: 'emit:task.finished',
                approval: 'required',
                params: { title: 't', base: 'main', head: 'feature' },
            },
        ],
    };
    const flows = new Map<string, FlowDefinition>([
        ['developer-yaml-auto', developerFlow],
        ['pr-yaml-required', prFlow],
    ]);
    const registry = writeRegistry({
        'developer-yaml-auto': { develop: 'required' },
        'pr-yaml-required': { 'open-pr': 'auto' },
    });
    const prGateway = new RecordingPrGateway();
    const { db, bus, commands, parked, engine } = makeHarness(flows, {
        projectRegistry: registry,
        prGateway,
    });
    try {
        seedTask(db, 'task-prec-a-agent');
        await bus.publish(
            makeEvent(FlowEvents.TASK_APPROVED, {
                taskId: 'task-prec-a-agent',
                flowId: 'developer-yaml-auto',
            }),
        );
        assert.equal(
            startAgents(commands).length,
            0,
            'override "required" must beat YAML "auto" and park the step',
        );
        assert.equal(parked.length, 1, 'expected one TaskParked for the agent step');
        assert.equal(parked[0].payload && (parked[0].payload as TaskParkedEventPayload).stepId, 'develop');

        seedTask(db, 'task-prec-a-pr');
        await bus.publish(
            makeEvent(FlowEvents.TASK_APPROVED, {
                taskId: 'task-prec-a-pr',
                flowId: 'pr-yaml-required',
            }),
        );
        assert.equal(
            prGateway.opens.length,
            1,
            'override "auto" must beat YAML "required" and reach the PR gateway',
        );
        assert.equal(prGateway.opens[0].head, 'feature');
        // Only the first (agent) park fired; the pr.open step dispatched.
        assert.equal(parked.length, 1, 'pr.open step must NOT park when override="auto"');

        engine.stop();
    } finally {
        db.close();
    }
});

test('AP-IFV-001 precedence (b): project override beats built-in default when YAML omits approval', async () => {
    // Agent step with NO YAML approval → default for free-form agent kind
    // is 'auto'. Override 'required' must still park.
    const agentFlow: FlowDefinition = {
        on: 'task.approved',
        steps: [
            {
                id: 'develop',
                agent: 'developer',
                model: 'sonnet',
                on_success: 'emit:task.finished',
            },
        ],
    };
    // pr.open with NO YAML approval → built-in default 'required'. Override
    // 'auto' must dispatch through the gateway.
    const prFlow: FlowDefinition = {
        on: 'task.approved',
        steps: [
            {
                id: 'open-pr',
                agent: 'pr.open',
                model: 'sonnet',
                on_success: 'emit:task.finished',
                params: { title: 't', base: 'main', head: 'feature' },
            },
        ],
    };
    const flows = new Map<string, FlowDefinition>([
        ['developer-default-auto', agentFlow],
        ['pr-default-required', prFlow],
    ]);
    const registry = writeRegistry({
        'developer-default-auto': { develop: 'required' },
        'pr-default-required': { 'open-pr': 'auto' },
    });
    const prGateway = new RecordingPrGateway();
    const { db, bus, commands, parked, engine } = makeHarness(flows, {
        projectRegistry: registry,
        prGateway,
    });
    try {
        seedTask(db, 'task-prec-b-agent');
        await bus.publish(
            makeEvent(FlowEvents.TASK_APPROVED, {
                taskId: 'task-prec-b-agent',
                flowId: 'developer-default-auto',
            }),
        );
        assert.equal(
            startAgents(commands).length,
            0,
            'override "required" must beat the "auto" default for free-form agent kinds',
        );
        assert.equal(parked.length, 1);
        assert.equal(parked[0].payload && (parked[0].payload as TaskParkedEventPayload).stepId, 'develop');

        seedTask(db, 'task-prec-b-pr');
        await bus.publish(
            makeEvent(FlowEvents.TASK_APPROVED, {
                taskId: 'task-prec-b-pr',
                flowId: 'pr-default-required',
            }),
        );
        assert.equal(
            prGateway.opens.length,
            1,
            'override "auto" must beat the built-in "required" default for pr.open',
        );
        assert.equal(parked.length, 1, 'pr.open with override="auto" must NOT park');

        engine.stop();
    } finally {
        db.close();
    }
});

test('AP-IFV-001 precedence (c): missing override falls through to YAML, then to built-in default', async () => {
    // YAML 'auto' wins when override is absent → developer dispatches.
    const yamlAutoFlow: FlowDefinition = {
        on: 'task.approved',
        steps: [
            {
                id: 'develop',
                agent: 'developer',
                model: 'sonnet',
                on_success: 'emit:task.finished',
                approval: 'auto',
            },
        ],
    };
    // No YAML approval, no override → pr.open default 'required' parks.
    const defaultFlow: FlowDefinition = {
        on: 'task.approved',
        steps: [
            {
                id: 'open-pr',
                agent: 'pr.open',
                model: 'sonnet',
                on_success: 'emit:task.finished',
                params: { title: 't', base: 'main', head: 'feature' },
            },
        ],
    };
    const flows = new Map<string, FlowDefinition>([
        ['developer-yaml-auto', yamlAutoFlow],
        ['pr-default-required', defaultFlow],
    ]);
    // Registry exists but DOES NOT declare these flow names — fall-through
    // path must behave the same as "no registry at all".
    const registry = writeRegistry({
        'some-other-flow': { 'irrelevant-step': 'required' },
    });
    const prGateway = new RecordingPrGateway();
    const { db, bus, commands, parked, engine } = makeHarness(flows, {
        projectRegistry: registry,
        prGateway,
    });
    try {
        seedTask(db, 'task-prec-c-yaml');
        await bus.publish(
            makeEvent(FlowEvents.TASK_APPROVED, {
                taskId: 'task-prec-c-yaml',
                flowId: 'developer-yaml-auto',
            }),
        );
        const starts = startAgents(commands);
        assert.equal(
            starts.length,
            1,
            'fall-through: YAML "auto" must dispatch when no override is supplied',
        );
        assert.equal(starts[0].stepId, 'develop');
        assert.equal(parked.length, 0);

        seedTask(db, 'task-prec-c-default');
        await bus.publish(
            makeEvent(FlowEvents.TASK_APPROVED, {
                taskId: 'task-prec-c-default',
                flowId: 'pr-default-required',
            }),
        );
        assert.equal(
            prGateway.opens.length,
            0,
            'fall-through: built-in "required" default must park pr.open when neither YAML nor override is set',
        );
        assert.equal(parked.length, 1, 'one TaskParked for the pr.open fall-through');
        assert.equal(
            parked[0].payload && (parked[0].payload as TaskParkedEventPayload).stepId,
            'open-pr',
        );

        engine.stop();
    } finally {
        db.close();
    }
});

// AP-IFV-001 — bonus acceptance check: a shop-shaped flow whose project
// declares `approval_override.default.commit = 'auto'` dispatches the
// commit step without parking when the YAML/default would be 'required'.
// The reverse (override='required') parks even when YAML/default would
// auto-pass. AC #5 + #6 mapped onto this engine-level coverage.
test('AP-IFV-001: shop commit step honours override=auto / required around YAML/default', async () => {
    // Commit step modelled as a `pr.merge` (commit gate in production loan-
    // drop flows is gated by the merge approval). YAML omits `approval`,
    // so the default 'required' applies — without an override the step
    // would park.
    const commitFlow: FlowDefinition = {
        on: 'task.approved',
        steps: [
            {
                id: 'commit',
                agent: 'pr.merge',
                model: 'sonnet',
                on_success: 'emit:task.finished',
                params: { number: 42, method: 'squash' },
            },
        ],
    };
    const flows = new Map<string, FlowDefinition>([['shop-default', commitFlow]]);

    // Override='auto' → AC #5 path.
    {
        const registry = writeRegistry({
            'shop-default': { commit: 'auto' },
        });
        const prGateway = new RecordingPrGateway();
        const { db, bus, parked, engine } = makeHarness(flows, {
            projectRegistry: registry,
            prGateway,
        });
        try {
            seedTask(db, 'task-shop-auto');
            await bus.publish(
                makeEvent(FlowEvents.TASK_APPROVED, {
                    taskId: 'task-shop-auto',
                    flowId: 'shop-default',
                }),
            );
            assert.equal(
                prGateway.merges.length,
                1,
                'override "auto" must dispatch the commit step even when the built-in default would require approval',
            );
            assert.equal(prGateway.merges[0].number, 42);
            assert.equal(parked.length, 0, 'no TaskParked when override is "auto"');
            engine.stop();
        } finally {
            db.close();
        }
    }

    // Override='required' → AC #6 path.
    {
        // Force YAML to 'auto' so the only thing keeping the step parked is
        // the override — proves override='required' wins even when both
        // YAML and (by extension) the operator's intent would otherwise
        // auto-pass.
        const yamlAutoCommit: FlowDefinition = {
            on: 'task.approved',
            steps: [
                {
                    id: 'commit',
                    agent: 'pr.merge',
                    model: 'sonnet',
                    on_success: 'emit:task.finished',
                    approval: 'auto',
                    params: { number: 42, method: 'squash' },
                },
            ],
        };
        const yamlAutoFlows = new Map<string, FlowDefinition>([
            ['shop-yaml-auto', yamlAutoCommit],
        ]);
        const registry = writeRegistry({
            'shop-yaml-auto': { commit: 'required' },
        });
        const prGateway = new RecordingPrGateway();
        const { db, bus, parked, engine } = makeHarness(yamlAutoFlows, {
            projectRegistry: registry,
            prGateway,
        });
        try {
            seedTask(db, 'task-shop-required');
            await bus.publish(
                makeEvent(FlowEvents.TASK_APPROVED, {
                    taskId: 'task-shop-required',
                    flowId: 'shop-yaml-auto',
                }),
            );
            assert.equal(
                prGateway.merges.length,
                0,
                'override "required" must park the commit step even when YAML / default would auto-pass',
            );
            assert.equal(parked.length, 1);
            assert.equal(
                parked[0].payload && (parked[0].payload as TaskParkedEventPayload).stepId,
                'commit',
            );
            engine.stop();
        } finally {
            db.close();
        }
    }
});
