/**
 * Unit-level tests for the orchestrator's command-handler wiring (AP-IFW-003):
 *
 *   1. ApprovePlan rejects until a PlanGenerated event has been recorded.
 *   2. GeneratePlan feeds the planner agent with the project's memory blob
 *      (so AC #5 — agent memory in planner/decomposer prompts — is honoured).
 *   3. ResumeTask is universally routed: the handler emits TaskResumed for
 *      tasks parked under different reasons without branching on agent role.
 *   4. AP-PAO-004 — SkipTask / RetryTask / ArchivePlan / DeletePlan /
 *      UpdateProjectApprovalOverride handlers (success path + idempotent
 *      double-dispatch).
 *
 * These tests stand up the minimum dependencies (a fake AgentRunner,
 * deferred-start that runs synchronously) so they exercise handlers.ts
 * without booting the full Orchestrator host.
 *
 * Dual-runner discovery
 * ---------------------
 * The repo's own test command (`npm test` → `node --test --import tsx`,
 * see package.json) uses Node's built-in `node:test` runner. The review
 * pipeline however runs `npx vitest run` on the changed test file. A
 * file written against only one of those APIs gets reported as
 * "no tests" by the other and the pipeline rejects the run.
 *
 * The shim below picks the right `test()` at module load: vitest sets
 * `process.env.VITEST=true` in its worker, so we route through vitest's
 * API there and through `node:test`'s API everywhere else. Both runners
 * therefore discover and execute the same suite from a single source
 * file. Vitest v4 forbids `require('vitest')` from CJS (and tsc emits
 * CJS here per the project's tsconfig), so the vitest branch reads the
 * `test` global that `vitest.config.ts` exposes via `globals: true`.
 */
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { CommandBus } from '../../core/commands/bus';
import { EventBus } from '../../core/events/bus';
import { EventStore } from '../../core/events/store';
import type { Event, StoredEvent } from '../../core/events/event';
import { applyMigrations, openDatabase, type Db } from '../../core/state/migrations';
import type {
    AgentHandle,
    AgentRunner,
    AgentSpec,
    IdGen,
    Logger,
} from '../../core/ports';
import {
    ApprovalCallbackCommands,
    InMemoryPlanGenerationGate,
    PlanLifecycleCommands,
    PlanLifecycleEvents,
    PlanOpsCommands,
    ProjectOpsCommands,
    TaskOpsCommands,
    TaskParkingCommands,
    TaskParkingEvents,
    type ArchivePlanPayload,
    type DeletePlanPayload,
    type PlanGenerationGate,
    type ResumeTaskPayload,
    type RetryTaskPayload,
    type SkipTaskPayload,
    type TaskResumedEventPayload,
    type UpdateProjectApprovalOverridePayload,
} from '../../core/commands';
import { AgentMemoryStore } from '../../core/projects/agent-memory';
import type { ApprovalOverride } from '../../core/projects/registry';

import {
    Commands,
    Events,
    registerCommandHandlers,
    type ProjectApprovalOverrideStore,
} from './handlers';

// ---------------------------------------------------------------------------
// Dual-runner test() shim — see file header for rationale.
// ---------------------------------------------------------------------------

type TestFn = (name: string, fn: () => void | Promise<void>) => void;

const test: TestFn = (((): TestFn => {
    if (process.env.VITEST) {
        const gt = (globalThis as { test?: TestFn }).test;
        if (typeof gt !== 'function') {
            throw new Error(
                'handlers.test.ts: VITEST=true but globalThis.test is missing — '
                    + 'ensure vitest.config.ts sets test.globals = true',
            );
        }
        return gt;
    }
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    const nt = require('node:test') as { test: TestFn };
    return nt.test;
})());

class SilentLogger implements Logger {
    info(): void {}
    warn(): void {}
    error(): void {}
    debug(): void {}
}

interface RecordedStart {
    readonly spec: AgentSpec;
    readonly handleId: string;
}

class RecordingAgentRunner implements AgentRunner {
    readonly starts: RecordedStart[] = [];
    private counter = 0;

    start(spec: AgentSpec): AgentHandle {
        this.counter += 1;
        const id = `agent-${this.counter}`;
        this.starts.push({ spec, handleId: id });
        return { id, spec };
    }

    async interrupt(): Promise<void> {
        // no-op
    }
}

interface Harness {
    readonly db: Db;
    readonly bus: EventBus;
    readonly cmdBus: CommandBus<unknown>;
    readonly runner: RecordingAgentRunner;
    readonly gate: PlanGenerationGate;
    readonly cleanup: () => void;
}

interface MakeHarnessOpts {
    readonly agentMemory?: AgentMemoryStore;
    /** When set, the harness records the agent→task pairings published via
     *  `deps.registerAgent` so callers can assert the lifecycle-agent path. */
    readonly captureAgentMap?: Map<string, string>;
    /** AP-PAO-004: opt-in approval-override store. Supplying it causes
     *  `registerCommandHandlers` to wire `UpdateProjectApprovalOverride`. */
    readonly approvalOverrideStore?: ProjectApprovalOverrideStore;
}

function makeHarness(opts: MakeHarnessOpts = {}): Harness {
    const db = openDatabase(':memory:');
    applyMigrations(db);
    const logger = new SilentLogger();
    const store = new EventStore(db);
    const bus = new EventBus(store, logger);
    const cmdBus = new CommandBus<unknown>(bus, () => undefined);
    const runner = new RecordingAgentRunner();
    const gate = new InMemoryPlanGenerationGate();
    const idGen: IdGen = ((): IdGen => {
        let n = 0;
        return { newId: (): string => `task-${++n}` };
    })();
    const agentMap = opts.captureAgentMap ?? new Map<string, string>();

    // Mirror PlanGenerated into the gate (analogue of the orchestrator's
    // bus subscriber).
    bus.subscribe(
        PlanLifecycleEvents.PLAN_GENERATED,
        async (event: StoredEvent & { payload: { planId: string } }) => {
            gate.record(event.payload.planId);
        },
    );

    registerCommandHandlers(cmdBus, {
        clock: () => 1_700_000_000_000,
        idGen,
        logger,
        defaultFlowId: 'echo',
        defaultProjectId: 'proj-test',
        defaultTaskType: 'echo',
        agentRunner: runner,
        registerAgent: (agentId, taskId) => {
            agentMap.set(agentId, taskId);
        },
        // Synchronous deferral keeps the assertions deterministic; the
        // host's setImmediate-based scheduling is exercised by phase0-echo.
        deferAgentStart: (run): void => run(),
        planGenerationGate: gate,
        agentMemory: opts.agentMemory,
        approvalOverrideStore: opts.approvalOverrideStore,
    });

    return {
        db,
        bus,
        cmdBus,
        runner,
        gate,
        cleanup: (): void => {
            db.close();
        },
    };
}

// ---------------------------------------------------------------------------
// AC #3 — ApprovePlan gating
// ---------------------------------------------------------------------------

test('ApprovePlan throws when no PlanGenerated has been recorded for the plan id', async () => {
    const h = makeHarness();
    try {
        await assert.rejects(
            h.cmdBus.send({
                type: Commands.APPROVE_PLAN,
                actor: 'op',
                issuedAt: 1,
                payload: { planId: 'plan-Z', projectId: 'proj-test' },
            }),
            /no PlanGenerated event recorded for plan "plan-Z"/,
        );

        // No PlanApproved event landed in the store.
        const types = (
            h.db.prepare('SELECT type FROM events ORDER BY seq').all() as { type: string }[]
        ).map((r) => r.type);
        assert.equal(types.includes(Events.PLAN_APPROVED), false);
    } finally {
        h.cleanup();
    }
});

test('ApprovePlan succeeds after GeneratePlan flips the gate for the same plan id', async () => {
    const h = makeHarness();
    try {
        await h.cmdBus.send({
            type: PlanLifecycleCommands.GENERATE_PLAN,
            actor: 'op',
            issuedAt: 1,
            payload: { planId: 'plan-1', projectId: 'proj-test', revision: 1 },
        });
        // Gate was flipped by the PlanGenerated subscriber.
        assert.equal(h.gate.has('plan-1'), true);

        await h.cmdBus.send({
            type: Commands.APPROVE_PLAN,
            actor: 'op',
            issuedAt: 2,
            payload: { planId: 'plan-1', projectId: 'proj-test' },
        });

        const types = (
            h.db.prepare('SELECT type FROM events ORDER BY seq').all() as { type: string }[]
        ).map((r) => r.type);
        assert.ok(types.includes(PlanLifecycleEvents.PLAN_GENERATED));
        assert.ok(types.includes(Events.PLAN_APPROVED));
    } finally {
        h.cleanup();
    }
});

test('ApprovePlan for plan-A is not granted by a PlanGenerated for plan-B (gate is per planId)', async () => {
    const h = makeHarness();
    try {
        await h.cmdBus.send({
            type: PlanLifecycleCommands.GENERATE_PLAN,
            actor: 'op',
            issuedAt: 1,
            payload: { planId: 'plan-B', projectId: 'proj-test', revision: 1 },
        });
        await assert.rejects(
            h.cmdBus.send({
                type: Commands.APPROVE_PLAN,
                actor: 'op',
                issuedAt: 2,
                payload: { planId: 'plan-A', projectId: 'proj-test' },
            }),
            /plan-A/,
        );
    } finally {
        h.cleanup();
    }
});

// ---------------------------------------------------------------------------
// AC #5 — Planner / decomposer prompts include agent-memory
// ---------------------------------------------------------------------------

test('GeneratePlan invokes the planner agent with the project agent-memory blob spliced in', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-ifw-003-h-'));
    try {
        const memory = new AgentMemoryStore(root);
        memory.append('proj-test', {
            source: 'commit-reject',
            taskIdentifier: 'AP-7',
            taskTitle: 'pick logger',
            feedback: 'always pino, never winston',
            recordedAt: 1,
        });

        const h = makeHarness({ agentMemory: memory });
        try {
            await h.cmdBus.send({
                type: PlanLifecycleCommands.GENERATE_PLAN,
                actor: 'op',
                issuedAt: 1,
                payload: { planId: 'plan-mem', projectId: 'proj-test', revision: 1 },
            });

            const plannerStart = h.runner.starts.find((s) => s.spec.role === 'planner');
            assert.ok(plannerStart, 'planner agent must have been started');
            assert.ok(
                plannerStart!.spec.prompt.includes('always pino, never winston'),
                `planner prompt must splice in memory; got: ${plannerStart!.spec.prompt}`,
            );
            assert.equal(plannerStart!.spec.metadata?.planId, 'plan-mem');
            assert.equal(plannerStart!.spec.metadata?.projectId, 'proj-test');
            assert.ok(
                typeof plannerStart!.spec.metadata?.agentMemory === 'string' &&
                    (plannerStart!.spec.metadata!.agentMemory as string).includes('AP-7'),
                'agentMemory must also be on metadata for adapters that read it programmatically',
            );
        } finally {
            h.cleanup();
        }
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('DecomposePlan invokes the decomposer agent and threads in agent-memory', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-ifw-003-h-'));
    try {
        const memory = new AgentMemoryStore(root);
        memory.append('proj-test', {
            source: 'clarification',
            taskIdentifier: 'AP-8',
            taskTitle: 'split tasks',
            feedback: 'never create tasks smaller than 1 hour',
            recordedAt: 1,
        });

        const h = makeHarness({ agentMemory: memory });
        try {
            await h.cmdBus.send({
                type: PlanLifecycleCommands.DECOMPOSE_PLAN,
                actor: 'op',
                issuedAt: 1,
                payload: {
                    planId: 'plan-mem',
                    projectId: 'proj-test',
                    approvedContent: '# Approved plan',
                    conventions: {},
                },
            });
            const decomposerStart = h.runner.starts.find((s) => s.spec.role === 'decomposer');
            assert.ok(decomposerStart);
            assert.ok(
                decomposerStart!.spec.prompt.includes('never create tasks smaller than 1 hour'),
            );
        } finally {
            h.cleanup();
        }
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('Planner is invoked even when no agent-memory is configured (empty block, no crash)', async () => {
    const h = makeHarness();
    try {
        await h.cmdBus.send({
            type: PlanLifecycleCommands.GENERATE_PLAN,
            actor: 'op',
            issuedAt: 1,
            payload: { planId: 'plan-empty', projectId: 'proj-test', revision: 1 },
        });
        const plannerStart = h.runner.starts.find((s) => s.spec.role === 'planner');
        assert.ok(plannerStart);
        assert.equal(plannerStart!.spec.metadata?.agentMemory, '');
    } finally {
        h.cleanup();
    }
});

// ---------------------------------------------------------------------------
// AC #4 — ResumeTask universal routing (no branch on agent role)
// ---------------------------------------------------------------------------

test('ResumeTask emits TaskResumed for a task parked under reason=clarification (developer agent)', async () => {
    const h = makeHarness();
    try {
        // Simulate a parked-task event from a developer agent so we can
        // verify the resume handler does not condition on agent role.
        await h.bus.publish({
            type: TaskParkingEvents.TASK_PARKED,
            v: 1,
            occurredAt: 1,
            idempotencyKey: 'parked:developer:T1',
            payload: {
                taskId: 'T1',
                stepId: 'develop',
                reason: 'clarification',
                question: 'which logger?',
            },
        } satisfies Event);

        await h.cmdBus.send({
            type: TaskParkingCommands.RESUME_TASK,
            actor: 'op',
            issuedAt: 2,
            payload: {
                taskId: 'T1',
                decision: 'approve',
                answer: 'pino',
                optionKey: 'A',
            } satisfies ResumeTaskPayload,
        });

        const resumed = (
            h.db
                .prepare("SELECT payload FROM events WHERE type = ? ORDER BY seq DESC LIMIT 1")
                .get(TaskParkingEvents.TASK_RESUMED) as { payload: string } | undefined
        );
        assert.ok(resumed, 'TaskResumed event must be persisted');
        const payload = JSON.parse(resumed!.payload) as TaskResumedEventPayload;
        assert.equal(payload.taskId, 'T1');
        assert.equal(payload.answer, 'pino');
        assert.equal(payload.optionKey, 'A');
        assert.equal(payload.actor, 'op');
    } finally {
        h.cleanup();
    }
});

test('ResumeTask emits TaskResumed for a task parked under reason=wait-action (no agent at all)', async () => {
    const h = makeHarness();
    try {
        // wait-action steps have no associated agent role — proving the
        // handler does NOT branch on agent type.
        await h.bus.publish({
            type: TaskParkingEvents.TASK_PARKED,
            v: 1,
            occurredAt: 1,
            idempotencyKey: 'parked:wait-action:T2',
            payload: { taskId: 'T2', stepId: 'wait', reason: 'wait-action' },
        } satisfies Event);

        await h.cmdBus.send({
            type: TaskParkingCommands.RESUME_TASK,
            actor: 'release-bot',
            issuedAt: 2,
            payload: { taskId: 'T2', decision: 'approve' } satisfies ResumeTaskPayload,
        });

        const resumedRows = (
            h.db
                .prepare("SELECT payload FROM events WHERE type = ? ORDER BY seq")
                .all(TaskParkingEvents.TASK_RESUMED) as { payload: string }[]
        ).map((r) => JSON.parse(r.payload) as TaskResumedEventPayload);
        assert.equal(resumedRows.length, 1);
        assert.equal(resumedRows[0].taskId, 'T2');
        assert.equal(resumedRows[0].actor, 'release-bot');
        assert.ok(!('answer' in resumedRows[0]), 'no answer when none supplied');
    } finally {
        h.cleanup();
    }
});

test('ResumeTask handler is one registration — same code path regardless of who parked the task', async () => {
    const h = makeHarness();
    try {
        // Two different parking reasons resolved by the SAME ResumeTask
        // command path. If the handler ever started branching on role we
        // would either need two handler registrations or see divergent
        // event shapes — this test pins both invariants.
        await h.bus.publish({
            type: TaskParkingEvents.TASK_PARKED,
            v: 1,
            occurredAt: 1,
            idempotencyKey: 'parked:wait-merged:T3',
            payload: { taskId: 'T3', stepId: 'wait-pr', reason: 'wait-merged' },
        });
        await h.bus.publish({
            type: TaskParkingEvents.TASK_PARKED,
            v: 1,
            occurredAt: 2,
            idempotencyKey: 'parked:clarification:T4',
            payload: {
                taskId: 'T4',
                stepId: 'review',
                reason: 'clarification',
                question: 'go ahead?',
            },
        });

        await h.cmdBus.send({
            type: TaskParkingCommands.RESUME_TASK,
            actor: 'op',
            issuedAt: 3,
            payload: { taskId: 'T3', decision: 'approve' } satisfies ResumeTaskPayload,
        });
        await h.cmdBus.send({
            type: TaskParkingCommands.RESUME_TASK,
            actor: 'op',
            issuedAt: 4,
            payload: {
                taskId: 'T4',
                decision: 'approve',
                answer: 'yes',
            } satisfies ResumeTaskPayload,
        });

        const resumed = (
            h.db
                .prepare("SELECT payload FROM events WHERE type = ? ORDER BY seq")
                .all(TaskParkingEvents.TASK_RESUMED) as { payload: string }[]
        ).map((r) => JSON.parse(r.payload) as TaskResumedEventPayload);
        assert.deepEqual(
            resumed.map((r) => r.taskId).sort(),
            ['T3', 'T4'],
            'both parked tasks must have produced TaskResumed via the same handler',
        );
    } finally {
        h.cleanup();
    }
});

// ---------------------------------------------------------------------------
// AP-PAO-004 — SkipTask / RetryTask / ArchivePlan / DeletePlan /
// UpdateProjectApprovalOverride handlers. Each test covers the success path
// + a double-dispatch idempotency case (the second dispatch must produce no
// extra event, courtesy of the deterministic idempotency key).
// ---------------------------------------------------------------------------

class RecordingApprovalOverrideStore implements ProjectApprovalOverrideStore {
    readonly calls: Array<{ projectId: string; override: ApprovalOverride }> = [];

    updateApprovalOverride(projectId: string, override: ApprovalOverride): void {
        this.calls.push({ projectId, override });
    }
}

function eventsOfType(db: Db, type: string): Array<{ payload: unknown; idempotency_key: string }> {
    return (
        db
            .prepare(
                'SELECT payload, idempotency_key FROM events WHERE type = ? ORDER BY seq',
            )
            .all(type) as { payload: string; idempotency_key: string }[]
    ).map((r) => ({ payload: JSON.parse(r.payload), idempotency_key: r.idempotency_key }));
}

test('SkipTask emits TaskSkipped, dispatches no agent, and is idempotent on double dispatch', async () => {
    const h = makeHarness();
    try {
        await h.cmdBus.send({
            type: TaskOpsCommands.SKIP_TASK,
            actor: 'op',
            issuedAt: 100,
            payload: { taskId: 'T-skip' } satisfies SkipTaskPayload,
        });

        // Double-dispatch with the same issuedAt: idempotency_key matches,
        // event store de-dupes.
        await h.cmdBus.send({
            type: TaskOpsCommands.SKIP_TASK,
            actor: 'op',
            issuedAt: 100,
            payload: { taskId: 'T-skip' } satisfies SkipTaskPayload,
        });

        const skipped = eventsOfType(h.db, Events.TASK_SKIPPED);
        assert.equal(skipped.length, 1, 'double-dispatch must collapse to one event');
        assert.deepEqual(skipped[0].payload, { taskId: 'T-skip' });

        // SkipTask must NOT spin up an agent — operators skip tasks
        // precisely to avoid the agent dispatch + PR.
        assert.equal(
            h.runner.starts.length,
            0,
            'SkipTask must not invoke the agent runner',
        );
    } finally {
        h.cleanup();
    }
});

test('RetryTask emits TaskRetried and is idempotent on double dispatch', async () => {
    const h = makeHarness();
    try {
        await h.cmdBus.send({
            type: TaskOpsCommands.RETRY_TASK,
            actor: 'op',
            issuedAt: 200,
            payload: { taskId: 'T-retry' } satisfies RetryTaskPayload,
        });
        await h.cmdBus.send({
            type: TaskOpsCommands.RETRY_TASK,
            actor: 'op',
            issuedAt: 200,
            payload: { taskId: 'T-retry' } satisfies RetryTaskPayload,
        });

        const retried = eventsOfType(h.db, Events.TASK_RETRIED);
        assert.equal(retried.length, 1);
        assert.deepEqual(retried[0].payload, { taskId: 'T-retry' });

        // A legitimate follow-up retry (different issuedAt) is NOT
        // collapsed — only same-instant double-dispatches dedupe.
        await h.cmdBus.send({
            type: TaskOpsCommands.RETRY_TASK,
            actor: 'op',
            issuedAt: 201,
            payload: { taskId: 'T-retry' } satisfies RetryTaskPayload,
        });
        assert.equal(eventsOfType(h.db, Events.TASK_RETRIED).length, 2);
    } finally {
        h.cleanup();
    }
});

test('ArchivePlan emits PlanArchived without emitting PlanDeleted (data preserved) and is idempotent', async () => {
    const h = makeHarness();
    try {
        await h.cmdBus.send({
            type: PlanOpsCommands.ARCHIVE_PLAN,
            actor: 'op',
            issuedAt: 300,
            payload: { planId: 'P-arch' } satisfies ArchivePlanPayload,
        });
        await h.cmdBus.send({
            type: PlanOpsCommands.ARCHIVE_PLAN,
            actor: 'op',
            issuedAt: 300,
            payload: { planId: 'P-arch' } satisfies ArchivePlanPayload,
        });

        const archived = eventsOfType(h.db, Events.PLAN_ARCHIVED);
        assert.equal(archived.length, 1);
        assert.deepEqual(archived[0].payload, { planId: 'P-arch' });

        // ArchivePlan must NOT emit a PlanDeleted — archival is the
        // non-destructive sibling. Asserts the two paths cannot bleed.
        assert.equal(eventsOfType(h.db, Events.PLAN_DELETED).length, 0);
    } finally {
        h.cleanup();
    }
});

test('DeletePlan emits PlanDeleted and is idempotent on double dispatch', async () => {
    const h = makeHarness();
    try {
        await h.cmdBus.send({
            type: PlanOpsCommands.DELETE_PLAN,
            actor: 'op',
            issuedAt: 400,
            payload: { planId: 'P-del' } satisfies DeletePlanPayload,
        });
        await h.cmdBus.send({
            type: PlanOpsCommands.DELETE_PLAN,
            actor: 'op',
            issuedAt: 400,
            payload: { planId: 'P-del' } satisfies DeletePlanPayload,
        });

        const deleted = eventsOfType(h.db, Events.PLAN_DELETED);
        assert.equal(deleted.length, 1);
        assert.deepEqual(deleted[0].payload, { planId: 'P-del' });
    } finally {
        h.cleanup();
    }
});

test('UpdateProjectApprovalOverride persists via the registry and emits ProjectApprovalOverrideUpdated; double dispatch yields one event', async () => {
    const store = new RecordingApprovalOverrideStore();
    const h = makeHarness({ approvalOverrideStore: store });
    try {
        const override: ApprovalOverride = {
            commit: { lint: 'auto', review: 'required' },
            test: { unit: 'default' },
        };
        await h.cmdBus.send({
            type: ProjectOpsCommands.UPDATE_PROJECT_APPROVAL_OVERRIDE,
            actor: 'op',
            issuedAt: 500,
            payload: {
                projectId: 'proj-test',
                approvalOverride: override,
            } satisfies UpdateProjectApprovalOverridePayload,
        });
        await h.cmdBus.send({
            type: ProjectOpsCommands.UPDATE_PROJECT_APPROVAL_OVERRIDE,
            actor: 'op',
            issuedAt: 500,
            payload: {
                projectId: 'proj-test',
                approvalOverride: override,
            } satisfies UpdateProjectApprovalOverridePayload,
        });

        // Both dispatches reach the registry — the registry's own write
        // is naturally idempotent — but the event store collapses the
        // pair into a single ProjectApprovalOverrideUpdated row.
        assert.equal(store.calls.length, 2);
        assert.equal(store.calls[0].projectId, 'proj-test');
        assert.deepEqual(store.calls[0].override, override);

        const events = eventsOfType(h.db, Events.PROJECT_APPROVAL_OVERRIDE_UPDATED);
        assert.equal(events.length, 1);
        assert.deepEqual(events[0].payload, {
            projectId: 'proj-test',
            approvalOverride: override,
        });
    } finally {
        h.cleanup();
    }
});

test('UpdateProjectApprovalOverride is NOT registered when no store is supplied', async () => {
    const h = makeHarness();
    try {
        await assert.rejects(
            h.cmdBus.send({
                type: ProjectOpsCommands.UPDATE_PROJECT_APPROVAL_OVERRIDE,
                actor: 'op',
                issuedAt: 1,
                payload: {
                    projectId: 'proj-test',
                    approvalOverride: {},
                } satisfies UpdateProjectApprovalOverridePayload,
            }),
            /no handler registered for command type "UpdateProjectApprovalOverride"/,
        );
    } finally {
        h.cleanup();
    }
});

// ---------------------------------------------------------------------------
// AP-IFG-015 — the seven Telegram stage-decision approval callbacks. Each
// callback verb the gateway parses MUST resolve to a registered handler (no
// "no handler registered"), and each translates onto the SAME TaskResumed
// gate path the board's Resume click drives — approve verbs emit
// decision='approve', reject verbs decision='reject'. The idempotency key
// carries the dispatch timestamp so two decisions on one task never collapse.
// ---------------------------------------------------------------------------

const APPROVAL_CALLBACK_CASES: ReadonlyArray<{
    readonly type: string;
    readonly decision: 'approve' | 'reject';
}> = [
    { type: ApprovalCallbackCommands.APPROVE_COMMIT, decision: 'approve' },
    { type: ApprovalCallbackCommands.REJECT_COMMIT, decision: 'reject' },
    { type: ApprovalCallbackCommands.APPROVE_MERGE, decision: 'approve' },
    { type: ApprovalCallbackCommands.REJECT_MERGE, decision: 'reject' },
    { type: ApprovalCallbackCommands.APPROVE_DEPLOY, decision: 'approve' },
    { type: ApprovalCallbackCommands.ACCEPT_CONTEXT_UPDATE, decision: 'approve' },
    { type: ApprovalCallbackCommands.REJECT_CONTEXT_UPDATE, decision: 'reject' },
];

test('AP-IFG-015: every approval callback has a registered handler and emits the matching TaskResumed gate event', async () => {
    const h = makeHarness();
    try {
        const issuedAt = 1_000;
        for (const [i, c] of APPROVAL_CALLBACK_CASES.entries()) {
            // No try/catch: a missing registration throws "no handler
            // registered for command type ..." out of CommandBus.send and
            // fails the test — which is exactly the gap this task closes.
            await h.cmdBus.send({
                type: c.type,
                actor: 'telegram',
                issuedAt: issuedAt + i,
                payload: { taskId: `AC-${i}` },
            });
        }

        const resumed = eventsOfType(h.db, TaskParkingEvents.TASK_RESUMED).map(
            (e) => ({
                payload: e.payload as TaskResumedEventPayload,
                idempotency_key: e.idempotency_key,
            }),
        );
        assert.equal(
            resumed.length,
            APPROVAL_CALLBACK_CASES.length,
            'each callback emits exactly one TaskResumed',
        );
        APPROVAL_CALLBACK_CASES.forEach((c, i) => {
            const { payload, idempotency_key } = resumed[i];
            assert.equal(payload.taskId, `AC-${i}`);
            assert.equal(payload.decision, c.decision);
            assert.equal(payload.actor, 'telegram');
            // idempotencyKey carries the dispatch timestamp so two decisions
            // on the same task at different instants stay distinct.
            assert.ok(
                idempotency_key.endsWith(`:${issuedAt + i}`),
                `idempotencyKey "${idempotency_key}" must carry the dispatch timestamp`,
            );
        });
    } finally {
        h.cleanup();
    }
});

test('AP-IFG-015: a rejected payload surfaces an error instead of dropping silently', async () => {
    const h = makeHarness();
    try {
        await assert.rejects(
            h.cmdBus.send({
                type: ApprovalCallbackCommands.APPROVE_COMMIT,
                actor: 'telegram',
                issuedAt: 2_000,
                payload: { taskId: '' },
            }),
            /ApproveCommit: invalid payload/,
        );
        // Nothing landed on the log — the invalid command produced no event.
        assert.equal(
            eventsOfType(h.db, TaskParkingEvents.TASK_RESUMED).length,
            0,
        );
    } finally {
        h.cleanup();
    }
});
