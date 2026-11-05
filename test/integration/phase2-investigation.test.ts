import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { CommandBus } from '../../core/commands/bus';
import type { Command } from '../../core/commands/command';
import { EventBus } from '../../core/events/bus';
import { EventStore } from '../../core/events/store';
import type { Event } from '../../core/events/event';
import {
    FlowEngine,
    FlowEvents,
    FlowCommands,
    type FailTaskPayload,
    type RequestInvestigationPayload,
    type StartAgentPayload,
} from '../../core/flow/engine';
import { loadAllFlows } from '../../core/flow/loader';
import { applyMigrations, openDatabase } from '../../core/state/migrations';
import type { AgentHandle, AgentSpec, Logger } from '../../core/ports';
import {
    TaskParkingCommands,
    TaskParkingEvents,
    createResumeTaskHandler,
    type ResumeTaskPayload,
    type TaskParkedEventPayload,
} from '../../core/commands';

import {
    Commands,
    Events,
    type ApprovePlanPayload,
    type ApproveTaskPayload,
    type CreateTaskPayload,
    type PlanApprovedPayload,
    type TaskApprovedPayload,
    type TaskCreatedPayload,
} from '../../hosts/orchestrator/handlers';

// ---------------------------------------------------------------------------
// Phase 2 integration: drive a real scaffold task through the investigation
// branch and back. A scripted FakeAgentRunner emits AgentQuestion mid-developer,
// then InvestigationCompleted from a scripted investigator agent, then
// AgentFinished when the resumed developer fires again.
//
// What this exercises end-to-end:
//   - YAML scaffold flow resolution + per-step transitions
//   - PascalCase domain events bridged to the engine's dotted-lowercase
//     vocabulary (TaskApproved, AgentFinished, AgentQuestion,
//     InvestigationCompleted)
//   - FlowEngine.paused_step write on question and clear on resume
//   - investigation answer threading via StartAgent.context →
//     AgentSpec.metadata.investigationAnswer
// ---------------------------------------------------------------------------

const FLOWS_DIR = path.resolve(__dirname, '..', '..', 'config', 'flows');
const INVESTIGATION_ANSWER = 'use sqitch for migrations';

class SilentLogger implements Logger {
    info(): void {}
    warn(): void {}
    error(): void {}
    debug(): void {}
}

interface EventPublisher {
    publish(event: Event): Promise<unknown>;
}

/**
 * Scripted runner. Routes per role and call index:
 *   developer #1   -> AgentStarted, AgentQuestion (no AgentFinished — pauses the flow)
 *   investigator   -> AgentStarted, InvestigationCompleted (carries answer)
 *   developer #2+  -> AgentStarted, AgentFinished (resumes; completes normally)
 *   any other role -> AgentStarted, AgentFinished
 *
 * Every spec passed to `start` is recorded so the test can later assert that
 * `metadata.investigationAnswer` reached the resumed developer step.
 */
class ScriptedAgentRunner {
    private readonly pending = new Set<Promise<unknown>>();
    private readonly specs: AgentSpec[] = [];
    private counter = 0;
    private developerStarts = 0;

    constructor(
        private readonly bus: EventPublisher,
        private readonly answer: string,
        private readonly clock: () => number = Date.now,
    ) {}

    start(spec: AgentSpec): AgentHandle {
        const handle: AgentHandle = { id: `scripted-agent-${++this.counter}`, spec };
        this.specs.push(spec);

        const started = this.publish('AgentStarted', handle);
        let tail: Promise<unknown>;
        if (spec.role === 'developer') {
            this.developerStarts++;
            if (this.developerStarts === 1) {
                tail = started.then(() =>
                    this.publish('AgentQuestion', handle, { question: 'which migration tool?' }),
                );
            } else {
                tail = started.then(() => this.publish('AgentFinished', handle));
            }
        } else if (spec.role === 'investigator') {
            tail = started.then(() =>
                this.publish('InvestigationCompleted', handle, { answer: this.answer }),
            );
        } else {
            tail = started.then(() => this.publish('AgentFinished', handle));
        }
        this.track(started);
        this.track(tail);
        return handle;
    }

    async flush(): Promise<void> {
        while (this.pending.size > 0) {
            await Promise.all(Array.from(this.pending));
        }
    }

    specsByRole(role: string): readonly AgentSpec[] {
        return this.specs.filter((s) => s.role === role);
    }

    private publish(
        type: string,
        handle: AgentHandle,
        extra: Record<string, unknown> = {},
    ): Promise<unknown> {
        return this.bus.publish({
            type,
            v: 1,
            occurredAt: this.clock(),
            idempotencyKey: `scripted:${type}:${handle.id}`,
            payload: { agentId: handle.id, role: handle.spec.role, ...extra },
        });
    }

    private track(p: Promise<unknown>): void {
        this.pending.add(p);
        p.finally(() => this.pending.delete(p));
    }
}

interface TrailEntry {
    readonly type: string;
    readonly role?: string;
}

function readTrail(db: ReturnType<typeof openDatabase>): TrailEntry[] {
    const rows = db
        .prepare('SELECT type, payload FROM events ORDER BY seq ASC')
        .all() as { type: string; payload: string }[];
    return rows.map((r) => {
        let role: string | undefined;
        try {
            const parsed = JSON.parse(r.payload) as { role?: unknown };
            if (typeof parsed.role === 'string') role = parsed.role;
        } catch {
            // Non-JSON payloads are not in the v2 vocabulary; ignore.
        }
        return { type: r.type, role };
    });
}

function assertSequence(actual: readonly TrailEntry[], expected: readonly TrailEntry[]): void {
    let cursor = -1;
    for (const want of expected) {
        const idx = actual.findIndex(
            (e, i) => i > cursor && e.type === want.type && e.role === want.role,
        );
        const label = want.role ? `${want.type}(${want.role})` : want.type;
        assert.ok(
            idx > cursor,
            `expected "${label}" after position ${cursor}; got trail: ` +
                actual
                    .map((e) => (e.role ? `${e.type}(${e.role})` : e.type))
                    .join(' -> '),
        );
        cursor = idx;
    }
}

test(
    'integration: investigation round-trip pauses developer and resumes with the answer threaded in',
    { timeout: 30_000 },
    async () => {
        const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-nvp-023-phase2-'));
        const dbPath = path.join(workspace, 'state.db');

        const db = openDatabase(dbPath);
        applyMigrations(db);

        const logger = new SilentLogger();
        const store = new EventStore(db);
        const bus = new EventBus(store, logger);
        const commandBus = new CommandBus<unknown>(bus, () => undefined);

        const runner = new ScriptedAgentRunner(bus, INVESTIGATION_ANSWER);
        const agentToTask = new Map<string, string>();
        const flows = loadAllFlows(FLOWS_DIR);

        let pendingDeferred = 0;
        const deferAgentStart = (run: () => void): void => {
            pendingDeferred++;
            setImmediate(() => {
                try {
                    run();
                } finally {
                    pendingDeferred--;
                }
            });
        };

        // ---- projections ----------------------------------------------------
        bus.subscribe<PlanApprovedPayload>(
            Events.PLAN_APPROVED,
            async (ev): Promise<void> => {
                db.prepare(
                    `INSERT OR IGNORE INTO plans(id, project_id, status, created_at)
                     VALUES (?, ?, 'approved', ?)`,
                ).run(ev.payload.planId, ev.payload.projectId, ev.occurredAt);
            },
            { subscriber: 'projection-plans' },
        );

        bus.subscribe<TaskCreatedPayload>(
            Events.TASK_CREATED,
            async (ev): Promise<void> => {
                db.prepare(
                    `INSERT OR IGNORE INTO tasks(id, plan_id, type, status, flow_id)
                     VALUES (?, ?, ?, 'created', ?)`,
                ).run(
                    ev.payload.taskId,
                    ev.payload.planId,
                    ev.payload.type,
                    ev.payload.flowId,
                );
            },
            { subscriber: 'projection-tasks' },
        );

        // ---- bridges PascalCase -> dotted-lowercase engine vocabulary -------
        bus.subscribe<TaskApprovedPayload>(
            Events.TASK_APPROVED,
            async (ev): Promise<void> => {
                await bus.publish({
                    type: FlowEvents.TASK_APPROVED,
                    v: 1,
                    occurredAt: Date.now(),
                    idempotencyKey: `bridge:${FlowEvents.TASK_APPROVED}:${ev.payload.taskId}`,
                    payload: { taskId: ev.payload.taskId, flowId: ev.payload.flowId },
                });
            },
            { subscriber: 'bridge-task-approved' },
        );

        bus.subscribe<{ agentId: string }>(
            'AgentFinished',
            async (ev): Promise<void> => {
                const taskId = agentToTask.get(ev.payload.agentId);
                if (!taskId) return;
                await bus.publish({
                    type: FlowEvents.AGENT_FINISHED,
                    v: 1,
                    occurredAt: Date.now(),
                    idempotencyKey: `bridge:${FlowEvents.AGENT_FINISHED}:${ev.payload.agentId}`,
                    payload: { taskId },
                });
            },
            { subscriber: 'bridge-agent-finished' },
        );

        bus.subscribe<{ agentId: string; question?: string }>(
            'AgentQuestion',
            async (ev): Promise<void> => {
                const taskId = agentToTask.get(ev.payload.agentId);
                if (!taskId) return;
                await bus.publish({
                    type: FlowEvents.AGENT_QUESTION,
                    v: 1,
                    occurredAt: Date.now(),
                    idempotencyKey: `bridge:${FlowEvents.AGENT_QUESTION}:${ev.payload.agentId}`,
                    payload: { taskId, question: ev.payload.question },
                });
            },
            { subscriber: 'bridge-agent-question' },
        );

        bus.subscribe<{ agentId: string; answer?: string }>(
            'InvestigationCompleted',
            async (ev): Promise<void> => {
                const taskId = agentToTask.get(ev.payload.agentId);
                if (!taskId) return;
                await bus.publish({
                    type: FlowEvents.INVESTIGATION_COMPLETED,
                    v: 1,
                    occurredAt: Date.now(),
                    idempotencyKey: `bridge:${FlowEvents.INVESTIGATION_COMPLETED}:${ev.payload.agentId}`,
                    payload: { taskId, answer: ev.payload.answer },
                });
            },
            { subscriber: 'bridge-investigation-completed' },
        );

        // ---- command handlers ----------------------------------------------
        // Inlined (rather than using registerCommandHandlers) so that the
        // REQUEST_INVESTIGATION handler can actually spawn an investigator
        // agent — the default no-op would never produce the
        // "investigator AgentStarted -> InvestigationCompleted" half of the
        // trail this test asserts.
        let taskCounter = 0;
        const newTaskId = (): string => `task-${++taskCounter}`;

        commandBus.register<ApprovePlanPayload>(Commands.APPROVE_PLAN, async (cmd) => {
            const payload: PlanApprovedPayload = {
                planId: cmd.payload.planId,
                projectId: cmd.payload.projectId ?? 'inv-rt-project',
                actor: cmd.actor,
            };
            return [
                {
                    type: Events.PLAN_APPROVED,
                    v: 1,
                    occurredAt: Date.now(),
                    idempotencyKey: `${Commands.APPROVE_PLAN}:${cmd.payload.planId}`,
                    payload,
                },
            ];
        });

        commandBus.register<CreateTaskPayload>(Commands.CREATE_TASK, async (cmd) => {
            const taskId = newTaskId();
            const payload: TaskCreatedPayload = {
                taskId,
                planId: cmd.payload.planId,
                type: cmd.payload.taskType ?? 'scaffold',
                flowId: cmd.payload.flowId ?? 'scaffold',
            };
            return [
                {
                    type: Events.TASK_CREATED,
                    v: 1,
                    occurredAt: Date.now(),
                    idempotencyKey: `${Commands.CREATE_TASK}:${taskId}`,
                    payload,
                },
            ];
        });

        commandBus.register<ApproveTaskPayload>(Commands.APPROVE_TASK, async (cmd) => {
            const payload: TaskApprovedPayload = {
                taskId: cmd.payload.taskId,
                flowId: cmd.payload.flowId,
            };
            return [
                {
                    type: Events.TASK_APPROVED,
                    v: 1,
                    occurredAt: Date.now(),
                    idempotencyKey: `${Commands.APPROVE_TASK}:${cmd.payload.taskId}`,
                    payload,
                },
            ];
        });

        commandBus.register<StartAgentPayload>(FlowCommands.START_AGENT, async (cmd) => {
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
            deferAgentStart(() => {
                const handle = runner.start(spec);
                agentToTask.set(handle.id, cmd.payload.taskId);
            });
            return [];
        });

        commandBus.register<FailTaskPayload>(FlowCommands.FAIL_TASK, async (cmd) => {
            // Fail loudly: the engine only sends this on an unknown flow id, which
            // would silently break this test's assumptions about scaffold flow.
            throw new Error(
                `FAIL_TASK fired for task ${cmd.payload.taskId}: ${cmd.payload.reason}`,
            );
        });

        commandBus.register<RequestInvestigationPayload>(
            FlowCommands.REQUEST_INVESTIGATION,
            async (cmd) => {
                const spec: AgentSpec = {
                    role: 'investigator',
                    prompt: `investigate question for task ${cmd.payload.taskId}`,
                    metadata: {
                        taskId: cmd.payload.taskId,
                        resumeStep: cmd.payload.resumeStep,
                        question: cmd.payload.question,
                    },
                };
                deferAgentStart(() => {
                    const handle = runner.start(spec);
                    // Map back to the PARENT task so InvestigationCompleted
                    // resumes the parent flow rather than getting dropped.
                    agentToTask.set(handle.id, cmd.payload.taskId);
                });
                return [];
            },
        );

        commandBus.register(FlowCommands.FINISH_TASK, async () => []);

        // ---- cascade (live-only, anonymous so a replay does not re-fire) ----
        bus.subscribe<PlanApprovedPayload>(Events.PLAN_APPROVED, async (ev): Promise<void> => {
            await commandBus.send({
                type: Commands.CREATE_TASK,
                actor: 'phase2-test',
                issuedAt: Date.now(),
                payload: { planId: ev.payload.planId },
            });
        });
        bus.subscribe<TaskCreatedPayload>(Events.TASK_CREATED, async (ev): Promise<void> => {
            await commandBus.send({
                type: Commands.APPROVE_TASK,
                actor: 'phase2-test',
                issuedAt: Date.now(),
                payload: { taskId: ev.payload.taskId, flowId: ev.payload.flowId },
            });
        });

        // ---- TaskFinished latch --------------------------------------------
        // Stand in for the operator at the flow's gates. `scaffold.yaml`
        // grew a `worktree-diff-review` park and a `merge-auto` park after
        // this test was written; both are lifecycle step kinds the engine
        // handles itself rather than agent roles, so the scripted runner
        // never saw them and the flow sat parked at the diff review until
        // the 5s timeout. That is why this test had been red. Approving
        // here keeps the assertion end-to-end and covers the gates too.
        commandBus.register<ResumeTaskPayload>(
            TaskParkingCommands.RESUME_TASK,
            createResumeTaskHandler({ clock: () => 1_700_000_000_000 }),
        );
        // Each resume needs its OWN `issuedAt`: the handler keys the event
        // on `ResumeTask:<taskId>:<issuedAt>`, so a fixed timestamp makes
        // every later resume a duplicate the store drops on
        // UNIQUE(idempotency_key) — silently. Writing this harness with a
        // constant reproduced the exact bug shape CLAUDE.md records for
        // DecomposePlan, and cost an hour before the trail gave it away.
        let resumeIssuedAt = 1_700_000_000_000;
        // Guarded per (task, step) so a park that re-parks the same step
        // fails on the timeout instead of spinning forever.
        const resumedSteps = new Set<string>();
        bus.subscribe<TaskParkedEventPayload>(
            TaskParkingEvents.TASK_PARKED,
            async (ev): Promise<void> => {
                const { taskId, stepId } = ev.payload;
                const key = `${taskId}:${stepId}`;
                if (resumedSteps.has(key)) return;
                resumedSteps.add(key);
                resumeIssuedAt += 1_000;
                await commandBus.send<ResumeTaskPayload>({
                    type: TaskParkingCommands.RESUME_TASK,
                    actor: 'test-operator',
                    issuedAt: resumeIssuedAt,
                    payload: { taskId, decision: 'approve' },
                });
            },
        );

        let resolveDone!: () => void;
        let rejectDone!: (err: unknown) => void;
        const taskFinishedDone = new Promise<void>((resolve, reject) => {
            resolveDone = resolve;
            rejectDone = reject;
        });
        bus.subscribe('TaskFinished', async (): Promise<void> => {
            resolveDone();
        });

        // ---- engine ---------------------------------------------------------
        const engine = FlowEngine.start(bus, commandBus, flows, {
            db,
            logger,
            clock: Date.now,
        });

        // ---- drive ----------------------------------------------------------
        try {
            await commandBus.send<ApprovePlanPayload>({
                type: Commands.APPROVE_PLAN,
                actor: 'phase2-test',
                issuedAt: Date.now(),
                payload: { planId: 'phase2-plan-1', projectId: 'inv-rt-project' },
            } as Command<ApprovePlanPayload>);

            // Pump the chain: each setImmediate-deferred runner.start adds a
            // macrotask boundary; runner.flush awaits the publish promises that
            // start enqueues. Loop until two consecutive idle cycles confirm
            // quiescence OR TaskFinished arrives.
            const MAX_CYCLES = 256;
            let finished = false;
            taskFinishedDone.then(() => {
                finished = true;
            });
            let confirmedIdle = 0;
            for (let i = 0; i < MAX_CYCLES && !finished && confirmedIdle < 2; i++) {
                await new Promise<void>((resolve) => setImmediate(resolve));
                await runner.flush();
                confirmedIdle = pendingDeferred === 0 ? confirmedIdle + 1 : 0;
            }

            // Final await with a generous safety timeout so a missed wake-up
            // surfaces as an explicit failure rather than a hang.
            await Promise.race([
                taskFinishedDone,
                new Promise<void>((_resolve, reject) =>
                    setTimeout(
                        () => reject(new Error('timed out waiting for TaskFinished')),
                        5_000,
                    ),
                ),
            ]);

            // ---- AC2: assert the full event trail order --------------------
            const trail = readTrail(db);
            assertSequence(trail, [
                { type: 'AgentStarted', role: 'developer' },
                { type: 'AgentQuestion', role: 'developer' },
                { type: 'AgentStarted', role: 'investigator' },
                { type: 'InvestigationCompleted', role: 'investigator' },
                { type: 'AgentStarted', role: 'developer' },
                { type: 'AgentFinished', role: 'developer' },
                { type: 'AgentStarted', role: 'reviewer' },
            ]);

            // ---- AC3: investigation answer threaded into resumed AgentSpec --
            const developerSpecs = runner.specsByRole('developer');
            assert.equal(
                developerSpecs.length >= 2,
                true,
                `expected at least two developer specs, got ${developerSpecs.length}`,
            );
            const resumedSpec = developerSpecs[1];
            assert.equal(
                (resumedSpec.metadata as { investigationAnswer?: string } | undefined)
                    ?.investigationAnswer,
                INVESTIGATION_ANSWER,
                'resumed developer AgentSpec.metadata.investigationAnswer must carry the answer',
            );
            // First developer call must NOT carry an investigation answer —
            // otherwise the threading check above could pass by coincidence.
            assert.equal(
                (developerSpecs[0].metadata as { investigationAnswer?: string } | undefined)
                    ?.investigationAnswer,
                undefined,
                'first developer call must not have an investigation answer in its context',
            );

            // Sanity: paused_step was cleared on resume (the engine's contract
            // for InvestigationCompleted). Looking it up by the single task we
            // created keeps the assertion id-agnostic.
            const fsRow = db
                .prepare('SELECT paused_step FROM flow_state LIMIT 1')
                .get() as { paused_step: string | null } | undefined;
            assert.ok(fsRow, 'expected a flow_state row for the driven task');
            assert.equal(
                fsRow.paused_step,
                null,
                'paused_step must be cleared once the resume StartAgent has dispatched',
            );
        } finally {
            // ---- AC4: cleanup ----------------------------------------------
            engine.stop();
            rejectDone(new Error('cleanup')); // resolve the latch if not yet hit
            try {
                db.close();
            } catch {
                // ignore
            }
            try {
                fs.rmSync(workspace, { recursive: true, force: true });
            } catch {
                // Best-effort on Windows where a stray handle may briefly hold
                // the file. Swallowing here so a teardown error does not mask
                // a real assertion failure.
            }
        }
    },
);
