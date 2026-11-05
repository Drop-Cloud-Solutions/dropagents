import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { CommandBus } from '../../core/commands/bus';
import { EventBus } from '../../core/events/bus';
import { EventStore } from '../../core/events/store';
import type { Event } from '../../core/events/event';
import { FlowEngine, FlowEvents } from '../../core/flow/engine';
import { loadAllFlows } from '../../core/flow/loader';
import { applyMigrations, openDatabase, type Db } from '../../core/state/migrations';
import type {
    IssueRef,
    IssueSpec,
    IssueTracker,
    Logger,
    ProjectRef,
    ProjectSpec,
} from '../../core/ports';

import { FakeAgentRunner } from '../../adapters/fakes/FakeAgentRunner';
import { JiraApiError } from '../../adapters/jira/client';
import {
    JIRA_SHADOW_SUBSCRIBER,
    createFileShadowDiffLog,
    registerJiraShadowSubscriber,
    type JiraExternalRefs,
    type ShadowDiffEntry,
} from '../../adapters/jira/subscriber';
import {
    LinearEvents,
    registerLinearSubscriber,
    type ExternalRefsReader,
} from '../../adapters/linear/subscriber';
import type { ExternalRefsWriter } from '../../adapters/linear/LinearTracker';

import {
    Commands,
    Events,
    registerCommandHandlers,
    type ApprovePlanPayload,
    type PlanApprovedPayload,
    type TaskApprovedPayload,
    type TaskCreatedPayload,
} from '../../hosts/orchestrator/handlers';
import {
    PlanLifecycleCommands,
    TaskParkingEvents,
    type GeneratePlanPayload,
    type TaskParkedEventPayload,
    type TaskResumedEventPayload,
} from '../../core/commands';

// ---------------------------------------------------------------------------
// Phase 4 exit criterion: shadow-mode Jira writes mirror Linear without
// interrupting the flow, and divergences land in jira-shadow-diff.log.
//
// This test drives a scaffold task end-to-end with TWO trackers wired:
//
//   linear-tracker  -> recording tracker (authoritative; never fails here)
//   jira-shadow     -> recording tracker (best-effort; may fake a 500)
//
// Both subscribers see the same lifecycle events, so the assertions in this
// file all reduce to "for every kind of Linear call, there's a matching Jira
// call carrying the same semantic payload" (modulo the external project /
// issue id, which is intentionally per-system).
//
// Two scenarios:
//
//   1. Happy path           — Linear and Jira both receive the full
//                             createProject -> createIssue -> closeIssue
//                             trio for the same logical task; diff log
//                             stays empty.
//   2. Simulated Jira 500   — Jira's createIssue throws JiraApiError(500).
//                             The Linear flow still reaches TaskFinished,
//                             no failure event is published from the
//                             jira-shadow path, and the divergence lands
//                             in jira-shadow-diff.log on disk with a
//                             clear `operation` marker.
// ---------------------------------------------------------------------------

const FLOWS_DIR = path.resolve(__dirname, '..', '..', 'config', 'flows');

class SilentLogger implements Logger {
    info(): void {}
    warn(): void {}
    error(): void {}
    debug(): void {}
}

// ---------------------------------------------------------------------------
// Recording tracker — captures every call AND writes the local->external
// mapping into the supplied refs store, the way the real LinearTracker /
// JiraTracker do. The shadow subscriber also writes the Jira mapping after a
// successful create, but the Linear subscriber relies on the tracker to do
// it for createProject, so the writer here is the canonical way both paths
// behave identically in production.
// ---------------------------------------------------------------------------

type TrackerCall =
    | { readonly kind: 'createProject'; readonly spec: ProjectSpec; readonly result: ProjectRef }
    | { readonly kind: 'createIssue'; readonly spec: IssueSpec; readonly result: IssueRef }
    | { readonly kind: 'closeIssue'; readonly id: string; readonly summary: string }
    | { readonly kind: 'skipIssue'; readonly id: string; readonly reason: string }
    | { readonly kind: 'postCommentToIssue'; readonly issueId: string; readonly body: string };

interface RecordingTrackerOptions {
    readonly idPrefix: string;
    readonly externalRefs: { write(localId: string, externalId: string): void };
    /**
     * Optional fault injector — invoked once per createIssue call. When it
     * returns an Error, that error is thrown instead of completing the
     * create; otherwise the create proceeds normally. Used to simulate the
     * Jira 500 outage in the second scenario without coupling the test to
     * any specific HTTP transport.
     */
    readonly createIssueFault?: () => Error | undefined;
}

class RecordingTracker implements IssueTracker {
    readonly calls: TrackerCall[] = [];
    private projectCounter = 0;
    private issueCounter = 0;

    constructor(private readonly opts: RecordingTrackerOptions) {}

    async createProject(spec: ProjectSpec): Promise<ProjectRef> {
        const result: ProjectRef = {
            id: `${this.opts.idPrefix}-proj-${++this.projectCounter}`,
            name: spec.name,
        };
        this.calls.push({ kind: 'createProject', spec, result });
        const localId = spec.key ?? result.id;
        this.opts.externalRefs.write(localId, result.id);
        return result;
    }

    async createIssue(spec: IssueSpec): Promise<IssueRef> {
        const fault = this.opts.createIssueFault?.();
        if (fault) throw fault;
        const result: IssueRef = {
            id: `${this.opts.idPrefix}-iss-${++this.issueCounter}`,
            title: spec.title,
        };
        this.calls.push({ kind: 'createIssue', spec, result });
        return result;
    }

    async closeIssue(id: string, summary: string): Promise<void> {
        this.calls.push({ kind: 'closeIssue', id, summary });
    }

    async skipIssue(id: string, reason: string): Promise<void> {
        this.calls.push({ kind: 'skipIssue', id, reason });
    }

    async postCommentToIssue(issueId: string, body: string): Promise<void> {
        this.calls.push({ kind: 'postCommentToIssue', issueId, body });
    }
}

class MemoryRefs implements JiraExternalRefs, ExternalRefsReader, ExternalRefsWriter {
    readonly rows = new Map<string, string>();
    read(localId: string): string | undefined {
        return this.rows.get(localId);
    }
    write(localId: string, externalId: string): void {
        this.rows.set(localId, externalId);
    }
}

interface Harness {
    readonly workspace: string;
    readonly diffLogPath: string;
    readonly db: Db;
    readonly bus: EventBus;
    readonly commandBus: CommandBus<unknown>;
    readonly engine: FlowEngine;
    readonly runner: FakeAgentRunner;
    readonly linearTracker: RecordingTracker;
    readonly jiraTracker: RecordingTracker;
    readonly linearRefs: MemoryRefs;
    readonly jiraRefs: MemoryRefs;
    readonly taskFinished: Promise<{ taskId: string }>;
    waitForQuiescence(): Promise<void>;
    teardown(): void;
}

interface HarnessOptions {
    readonly tmpPrefix: string;
    readonly jiraCreateIssueFault?: () => Error | undefined;
}

function buildHarness(opts: HarnessOptions): Harness {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), opts.tmpPrefix));
    const dbPath = path.join(workspace, 'state.db');
    // Mirrors shared/.cache/jira-shadow-diff.log in production — same filename
    // so the on-disk artefact the operator looks for in either world has the
    // same shape.
    const diffLogPath = path.join(workspace, 'shared', '.cache', 'jira-shadow-diff.log');

    const db = openDatabase(dbPath);
    applyMigrations(db);

    const logger = new SilentLogger();
    const store = new EventStore(db);
    const bus = new EventBus(store, logger);
    const commandBus = new CommandBus<unknown>(bus, () => undefined);

    const runner = new FakeAgentRunner({ bus });
    const agentToTask = new Map<string, string>();

    const linearRefs = new MemoryRefs();
    const jiraRefs = new MemoryRefs();
    const linearTracker = new RecordingTracker({
        idPrefix: 'linear',
        externalRefs: linearRefs,
    });
    const jiraTracker = new RecordingTracker({
        idPrefix: 'jira',
        externalRefs: jiraRefs,
        createIssueFault: opts.jiraCreateIssueFault,
    });

    // ---- projections ------------------------------------------------------
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

    // ---- Linear FIRST, then Jira shadow ----------------------------------
    // EventEmitter dispatches in registration order. The shadow subscriber's
    // whole contract is "run after Linear has already done the authoritative
    // write" — registering jira-shadow first would invert that.
    registerLinearSubscriber({
        bus,
        tracker: linearTracker,
        externalRefs: linearRefs,
        clock: Date.now,
        logger,
    });

    registerJiraShadowSubscriber({
        bus,
        tracker: jiraTracker,
        externalRefs: jiraRefs,
        shadowDiffLog: createFileShadowDiffLog(diffLogPath),
        clock: Date.now,
        logger,
    });

    // ---- bridges PascalCase -> dotted-lowercase engine vocabulary --------
    bus.subscribe<TaskApprovedPayload>(
        Events.TASK_APPROVED,
        async (ev): Promise<void> => {
            const bridged: Event = {
                type: FlowEvents.TASK_APPROVED,
                v: 1,
                occurredAt: Date.now(),
                idempotencyKey: `bridge:${FlowEvents.TASK_APPROVED}:${ev.payload.taskId}`,
                payload: { taskId: ev.payload.taskId, flowId: ev.payload.flowId },
            };
            await bus.publish(bridged);
        },
        { subscriber: 'bridge-task-approved' },
    );

    bus.subscribe<{ agentId: string }>(
        'AgentFinished',
        async (ev): Promise<void> => {
            const taskId = agentToTask.get(ev.payload.agentId);
            if (!taskId) return;
            const bridged: Event = {
                type: FlowEvents.AGENT_FINISHED,
                v: 1,
                occurredAt: Date.now(),
                idempotencyKey: `bridge:${FlowEvents.AGENT_FINISHED}:${ev.payload.agentId}`,
                payload: { taskId },
            };
            await bus.publish(bridged);
        },
        { subscriber: 'bridge-agent-finished' },
    );

    // ---- command handlers + flow engine ----------------------------------
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

    registerCommandHandlers(commandBus, {
        clock: Date.now,
        idGen: ((): { newId: () => string } => {
            let n = 0;
            return { newId: (): string => `task-${++n}` };
        })(),
        logger,
        defaultFlowId: 'scaffold',
        defaultProjectId: 'phase4-project',
        defaultTaskType: 'scaffold',
        agentRunner: runner,
        registerAgent: (agentId, taskId): void => {
            agentToTask.set(agentId, taskId);
        },
        deferAgentStart,
    });

    const flows = loadAllFlows(FLOWS_DIR);
    const engine = FlowEngine.start(bus, commandBus, flows, {
        db,
        logger,
        clock: Date.now,
    });

    // ---- cascade (live-only, anonymous so a replay does not re-fire) -----
    bus.subscribe<PlanApprovedPayload>(Events.PLAN_APPROVED, async (ev): Promise<void> => {
        await commandBus.send({
            type: Commands.CREATE_TASK,
            actor: 'phase4-test',
            issuedAt: Date.now(),
            payload: { planId: ev.payload.planId },
        });
    });
    bus.subscribe<TaskCreatedPayload>(Events.TASK_CREATED, async (ev): Promise<void> => {
        await commandBus.send({
            type: Commands.APPROVE_TASK,
            actor: 'phase4-test',
            issuedAt: Date.now(),
            payload: { taskId: ev.payload.taskId, flowId: ev.payload.flowId },
        });
    });

    // ---- operator gates: approve every park ------------------------------
    // The scaffold flow parks THREE times before TaskFinished: `develop`
    // carries `approval: required`, `human-review` is a
    // `worktree-diff-review` lifecycle park, and `merge` is `merge-auto`
    // (parked as wait-merged). In production an operator clears the first
    // two and the auto-merge path clears the third. This harness had
    // nobody, so the task sat at the first gate and `taskFinished` never
    // resolved — the flow engine was behaving correctly, the test simply
    // never drove it. Those gates were added to scaffold.yaml after this
    // test was written, and because the wait below had no deadline the
    // regression showed up as a 30s hang rather than a failure.
    //
    // Every resume needs its OWN idempotencyKey: three parks on one task
    // would otherwise collapse into a single deduped event and the flow
    // would stall again at the second gate.
    let parkSeq = 0;
    bus.subscribe<TaskParkedEventPayload>(
        TaskParkingEvents.TASK_PARKED,
        async (ev): Promise<void> => {
            parkSeq += 1;
            const resumed: Event = {
                type: TaskParkingEvents.TASK_RESUMED,
                v: 1,
                occurredAt: Date.now(),
                idempotencyKey: `phase4-resume:${ev.payload.taskId}:${parkSeq}`,
                payload: {
                    taskId: ev.payload.taskId,
                    actor: 'phase4-test',
                    decision: 'approve',
                } satisfies TaskResumedEventPayload,
            };
            await bus.publish(resumed);
        },
        { subscriber: 'phase4-resume-parks' },
    );

    // ---- TaskFinished latch ----------------------------------------------
    let resolveDone!: (payload: { taskId: string }) => void;
    const taskFinished = new Promise<{ taskId: string }>((resolve) => {
        resolveDone = resolve;
    });
    bus.subscribe<{ taskId: string }>('TaskFinished', async (ev): Promise<void> => {
        resolveDone({ taskId: ev.payload.taskId });
    });

    async function waitForQuiescence(): Promise<void> {
        const MAX_CYCLES = 256;
        let confirmedIdle = 0;
        for (let i = 0; i < MAX_CYCLES && confirmedIdle < 2; i++) {
            await new Promise<void>((resolve) => setImmediate(resolve));
            await runner.flush();
            confirmedIdle = pendingDeferred === 0 ? confirmedIdle + 1 : 0;
        }
    }

    function teardown(): void {
        engine.stop();
        try {
            db.close();
        } catch {
            // ignore
        }
        try {
            fs.rmSync(workspace, { recursive: true, force: true });
        } catch {
            // Best-effort on Windows where a stray handle may briefly hold
            // the file — swallow so a teardown error does not mask a real
            // assertion failure.
        }
    }

    return {
        workspace,
        diffLogPath,
        db,
        bus,
        commandBus,
        engine,
        runner,
        linearTracker,
        jiraTracker,
        linearRefs,
        jiraRefs,
        taskFinished,
        waitForQuiescence,
        teardown,
    };
}

/**
 * Await the TaskFinished latch with a DEADLINE.
 *
 * The bare `await h.taskFinished` these tests used had no timeout, and the
 * `Promise.race` above it includes `waitForQuiescence()` — which is bounded
 * and resolves almost immediately — so the race never guarded anything. A
 * stalled flow therefore hung until node's 30s harness limit and reported
 * `cancelled` with no clue which gate it died at. Now it fails in ten
 * seconds saying so.
 */
async function awaitFinished(h: Harness): Promise<{ taskId: string }> {
    return Promise.race([
        h.taskFinished,
        new Promise<never>((_resolve, reject) =>
            setTimeout(
                () =>
                    reject(
                        new Error(
                            'TaskFinished never fired within 10s — the flow is parked at a '
                            + 'gate nobody resumed, or a step failed. Check TaskParked events.',
                        ),
                    ),
                10_000,
            ),
        ),
    ]);
}

function readDiffLog(filePath: string): ShadowDiffEntry[] {
    if (!fs.existsSync(filePath)) return [];
    return fs
        .readFileSync(filePath, 'utf8')
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as ShadowDiffEntry);
}

// ===========================================================================
// Scenario 1 — Happy path: every Linear write has a matching Jira write
// ===========================================================================

test(
    'integration: phase4-jira-shadow mirrors every Linear write into Jira with a semantically equivalent payload',
    { timeout: 30_000 },
    async () => {
        const h = buildHarness({ tmpPrefix: 'ap-nvp-027-phase4-happy-' });
        try {
            // Plan gate (AP-IFW-003): GeneratePlan precedes ApprovePlan.
            await h.commandBus.send({
                type: PlanLifecycleCommands.GENERATE_PLAN,
                actor: 'phase4-test',
                issuedAt: Date.now(),
                payload: { planId: 'phase4-plan-happy', projectId: 'phase4-project', revision: 1 },
            } satisfies { type: string; actor: string; issuedAt: number; payload: GeneratePlanPayload });
            await h.commandBus.send({
                type: Commands.APPROVE_PLAN,
                actor: 'phase4-test',
                issuedAt: Date.now(),
                payload: { planId: 'phase4-plan-happy', projectId: 'phase4-project' },
            } satisfies { type: string; actor: string; issuedAt: number; payload: ApprovePlanPayload });

            await Promise.race([
                h.taskFinished,
                new Promise<void>((_resolve, reject) =>
                    setTimeout(() => reject(new Error('timed out waiting for TaskFinished')), 10_000),
                ),
                h.waitForQuiescence(),
            ]);
            // Make sure any tail subscribers (jira-shadow on TaskFinished) finish.
            await h.waitForQuiescence();
            const finished = await awaitFinished(h);

            // ---- AC2: every Linear call has a matching Jira call -----------
            const linearKinds = h.linearTracker.calls.map((c) => c.kind);
            const jiraKinds = h.jiraTracker.calls.map((c) => c.kind);
            assert.deepEqual(
                linearKinds,
                ['createProject', 'createIssue', 'closeIssue'],
                `Linear must have seen the full lifecycle, got: ${linearKinds.join(',')}`,
            );
            assert.deepEqual(
                jiraKinds,
                linearKinds,
                'jira-shadow must mirror every Linear call kind in the same order',
            );

            // Semantic equivalence: createProject — both received the same
            // logical project (name, description, key are derived from the
            // PlanApproved event the two subscribers shared).
            const lp = h.linearTracker.calls[0];
            const jp = h.jiraTracker.calls[0];
            assert.equal(lp.kind, 'createProject');
            assert.equal(jp.kind, 'createProject');
            if (lp.kind === 'createProject' && jp.kind === 'createProject') {
                assert.equal(lp.spec.name, jp.spec.name);
                assert.equal(lp.spec.description, jp.spec.description);
                assert.equal(lp.spec.key, jp.spec.key);
            }

            // createIssue — same title/description/labels. projectId is
            // intentionally per-system (Linear's project id vs. Jira's
            // project id resolved through their respective external_refs).
            const li = h.linearTracker.calls[1];
            const ji = h.jiraTracker.calls[1];
            if (li.kind === 'createIssue' && ji.kind === 'createIssue') {
                assert.equal(li.spec.title, ji.spec.title);
                assert.equal(li.spec.description, ji.spec.description);
                assert.deepEqual(li.spec.labels ?? [], ji.spec.labels ?? []);
                assert.equal(
                    li.spec.projectId,
                    h.linearRefs.read('phase4-plan-happy'),
                    'Linear createIssue must resolve to the Linear project id',
                );
                assert.equal(
                    ji.spec.projectId,
                    h.jiraRefs.read('phase4-plan-happy'),
                    'Jira createIssue must resolve to the Jira project id',
                );
            }

            // closeIssue — same summary text; ids point at each system's
            // own issue. (The taskId resolves to linear-iss-1 / jira-iss-1
            // via the two refs tables.)
            const lc = h.linearTracker.calls[2];
            const jc = h.jiraTracker.calls[2];
            if (lc.kind === 'closeIssue' && jc.kind === 'closeIssue') {
                assert.equal(lc.summary, jc.summary);
                assert.equal(lc.id, h.linearRefs.read(finished.taskId));
                assert.equal(jc.id, h.jiraRefs.read(finished.taskId));
            }

            // No divergence -> diff log file is either absent or empty.
            assert.deepEqual(
                readDiffLog(h.diffLogPath),
                [],
                'happy path must produce no shadow-diff entries',
            );

            // Linear authoritative path published nothing failure-y either.
            const stored = new EventStore(h.db).readAfter(0, 200);
            const linearFailures = stored.filter(
                (e) => e.type === LinearEvents.LINEAR_WRITE_FAILED,
            );
            assert.deepEqual(linearFailures, [], 'Linear must not have failed in the happy path');
        } finally {
            h.teardown();
        }
    },
);

// ===========================================================================
// Scenario 2 — Simulated Jira 500: Linear flow still reaches TaskFinished,
// divergence lands in jira-shadow-diff.log on disk.
// ===========================================================================

test(
    'integration: phase4-jira-shadow — simulated Jira 500 does not interrupt the flow; divergence lands in jira-shadow-diff.log',
    { timeout: 30_000 },
    async () => {
        // Fault injection: ONLY the first createIssue call fails (so the
        // happy-path branches of the same harness are still exercised on the
        // rest of the lifecycle).
        let issueCalls = 0;
        const h = buildHarness({
            tmpPrefix: 'ap-nvp-027-phase4-outage-',
            jiraCreateIssueFault: () => {
                issueCalls++;
                return issueCalls === 1
                    ? new JiraApiError('Jira HTTP 500: kaboom', 500)
                    : undefined;
            },
        });
        try {
            // Plan gate (AP-IFW-003): GeneratePlan precedes ApprovePlan.
            await h.commandBus.send({
                type: PlanLifecycleCommands.GENERATE_PLAN,
                actor: 'phase4-test',
                issuedAt: Date.now(),
                payload: { planId: 'phase4-plan-outage', projectId: 'phase4-project', revision: 1 },
            } satisfies { type: string; actor: string; issuedAt: number; payload: GeneratePlanPayload });
            await h.commandBus.send({
                type: Commands.APPROVE_PLAN,
                actor: 'phase4-test',
                issuedAt: Date.now(),
                payload: { planId: 'phase4-plan-outage', projectId: 'phase4-project' },
            } satisfies { type: string; actor: string; issuedAt: number; payload: ApprovePlanPayload });

            await Promise.race([
                h.taskFinished,
                new Promise<void>((_resolve, reject) =>
                    setTimeout(
                        () =>
                            reject(
                                new Error(
                                    'timed out waiting for TaskFinished — a Jira 500 must NOT block the Linear flow',
                                ),
                            ),
                        10_000,
                    ),
                ),
                h.waitForQuiescence(),
            ]);
            await h.waitForQuiescence();
            const finished = await awaitFinished(h);
            assert.ok(finished.taskId, 'TaskFinished must fire even when the shadow tracker errors');

            // ---- AC3: Linear flow completed end-to-end ----------------------
            const linearKinds = h.linearTracker.calls.map((c) => c.kind);
            assert.deepEqual(
                linearKinds,
                ['createProject', 'createIssue', 'closeIssue'],
                'Linear lifecycle must still complete despite the Jira outage',
            );

            // ---- AC3: shadow failures must not surface as bus events --------
            // The Jira subscriber's whole point is that a Jira outage stays
            // off the event log. Any `*Failed` event whose source is the
            // jira-shadow handler would be a regression.
            const stored = new EventStore(h.db).readAfter(0, 500);
            const jiraFailureEvents = stored.filter((e) =>
                /jira.*fail|jirawritefailed/i.test(e.type),
            );
            assert.deepEqual(
                jiraFailureEvents,
                [],
                'jira-shadow must never publish a failure event onto the bus',
            );

            // ---- AC4: divergence appears in jira-shadow-diff.log on disk ----
            assert.ok(
                fs.existsSync(h.diffLogPath),
                `expected diff log file at ${h.diffLogPath} after a Jira write diverged`,
            );
            const entries = readDiffLog(h.diffLogPath);
            assert.ok(
                entries.length > 0,
                'jira-shadow-diff.log must contain at least one entry for the divergent write',
            );

            // Clear marker #1: the createIssue divergence is tagged
            // operation='createIssue' and the original 500 error message is
            // preserved in the entry.
            const createIssueDivergence = entries.find((e) => e.operation === 'createIssue');
            assert.ok(
                createIssueDivergence,
                'expected an entry with operation="createIssue" for the simulated 500',
            );
            assert.match(
                createIssueDivergence!.error,
                /Jira HTTP 500/,
                'divergence entry must preserve the original error as the marker',
            );
            assert.equal(
                createIssueDivergence!.sourceEventType,
                'TaskCreated',
                'createIssue divergence must reference the TaskCreated source event',
            );
            assert.equal(createIssueDivergence!.localId, finished.taskId);

            // Clear marker #2: because createIssue failed, the local->Jira
            // task mapping is missing — the TaskFinished handler then
            // records a `resolve` divergence rather than silently
            // swallowing the unmappable close.
            const resolveDivergence = entries.find((e) => e.operation === 'resolve');
            assert.ok(
                resolveDivergence,
                'expected a follow-on entry with operation="resolve" when no Jira issue was ever created',
            );

            // ---- AC2 (partial): the Linear authoritative write happened
            // even though the Jira mirror diverged.
            const linearIssueId = h.linearRefs.read(finished.taskId);
            assert.ok(linearIssueId, 'Linear must have created an issue for the task');
            assert.equal(
                h.jiraRefs.read(finished.taskId),
                undefined,
                'Jira mapping for the failed createIssue must NOT have been written',
            );

            // ---- AC5 (sanity): subscriber offset still advanced past the
            // diverging event, otherwise replay would loop forever on it.
            const offsetRow = h.db
                .prepare(`SELECT last_seq FROM subscriber_offsets WHERE subscriber = ?`)
                .get(JIRA_SHADOW_SUBSCRIBER) as { last_seq: number } | undefined;
            assert.ok(offsetRow, 'jira-shadow subscriber offset row must exist');
            assert.ok(
                offsetRow!.last_seq >= createIssueDivergence!.sourceEventSeq,
                'jira-shadow offset must advance past the diverging event so replay does not re-fire it',
            );
        } finally {
            // ---- AC5: harness teardown removes the workspace, which
            // includes the jira-shadow-diff.log file artefact.
            h.teardown();
            assert.equal(
                fs.existsSync(h.diffLogPath),
                false,
                'shadow-diff log artefact must be cleaned up after the test',
            );
        }
    },
);
