/**
 * AP-VP4-015 — end-to-end phase-4 plan-flow integration test.
 *
 * Exercises the full operator-driven plan lifecycle in-process with the
 * FakeAgentRunner path (no real `claude` CLI subprocess is spawned). The
 * test drives the orchestrator through the CommandBus — HTTP routes have
 * their own unit tests — and asserts the relevant projection snapshots at
 * each step:
 *
 *   Happy path:
 *     SubmitBrief    -> BriefSubmitted          plannerPhase = 'planning'
 *     (planner fake) -> PlanGenerated{rev=1}    plannerPhase = 'awaiting-approval'
 *     ApprovePlan    -> PlanApproved
 *     DecomposePlan  -> PlanDecomposed
 *     (decomposer fake schema-valid JSON of 3 tasks)
 *                    -> task-projection snapshot has exactly 3 tasks
 *
 *   Regenerate path (continuing from rev=1):
 *     GeneratePlan(rev=2, feedback)
 *                    -> PlanGenerated{rev=2}, previousRevision=1
 *                       plannerPhase = 'awaiting-approval' again
 *     ApprovePlan + DecomposePlan land the second cycle.
 *
 * The plan archetype validated end-to-end here is `feature` only (single-
 * repo, scaffold-then-implement shape).
 *
 * Run with `node --test --import tsx test/integration/phase4-plan-flow.test.ts`.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { CommandBus } from '../../core/commands/bus';
import { EventBus } from '../../core/events/bus';
import { EventStore } from '../../core/events/store';
import { applyMigrations, openDatabase, type Db } from '../../core/state/migrations';
import type {
    AgentHandle,
    AgentRunner,
    AgentSpec,
    IdGen,
    Logger,
} from '../../core/ports';
import {
    PlanLifecycleCommands,
    PlanLifecycleEvents,
    type DecomposePlanPayload,
    type GeneratePlanPayload,
    type PlanConventions,
    type SubmitBriefPayload,
} from '../../core/commands';
import {
    Commands,
    buildPlanGenerationGateWiring,
    registerCommandHandlers,
    registerPlanLifecycleAgentHandlers,
    type ApprovePlanPayload,
    type LifecycleAgentContext,
    type PlanDecomposedAgentEventPayload,
    type PlanGeneratedAgentEventPayload,
} from '../../hosts/orchestrator/handlers';
import { PlanReviewStore } from '../../adapters/projections/plan-review-store';
import {
    initialState,
    step as planLifecycleStep,
    type EventInput as PlanLifecycleEventInput,
    type State as PlanLifecycleState,
} from '../../core/flow/plan-lifecycle';

// ---------------------------------------------------------------------------
// Test fakes and harness
// ---------------------------------------------------------------------------

class SilentLogger implements Logger {
    info(): void {}
    warn(): void {}
    error(): void {}
    debug(): void {}
}

/**
 * Per-role scripted fake agent runner. Returns a synchronous handle (as
 * the port demands) and asynchronously publishes `AgentStarted` followed
 * by `AgentFinished` with role-keyed content. `flush()` awaits every
 * pending publish so assertions can observe quiescence.
 *
 * The planner role emits a static markdown plan body; the decomposer role
 * emits a static, schema-valid JSON document of N tasks. Both are driven
 * by callbacks so the regenerate test can hand back a different body on
 * the second planner call without re-wiring the runner.
 */
type ContentFn = (call: number) => string;

class ScriptedFakeRunner implements AgentRunner {
    readonly starts: ReadonlyArray<{ readonly spec: AgentSpec; readonly id: string }> =
        [] as ReadonlyArray<{ spec: AgentSpec; id: string }>;
    private readonly _starts: { spec: AgentSpec; id: string }[] = this
        .starts as { spec: AgentSpec; id: string }[];
    private readonly pending = new Set<Promise<unknown>>();
    private readonly callsByRole = new Map<string, number>();
    private counter = 0;

    constructor(
        private readonly bus: EventBus,
        private readonly clock: () => number,
        private readonly contents: Readonly<Record<string, ContentFn>>,
    ) {}

    start(spec: AgentSpec): AgentHandle {
        this.counter += 1;
        const id = `runner-${this.counter}`;
        this._starts.push({ spec, id });
        const callIdx = (this.callsByRole.get(spec.role) ?? 0) + 1;
        this.callsByRole.set(spec.role, callIdx);
        const contentFn = this.contents[spec.role];
        const content = contentFn ? contentFn(callIdx) : '';
        const work = (async (): Promise<void> => {
            await this.bus.publish({
                type: 'AgentStarted',
                v: 1,
                occurredAt: this.clock(),
                idempotencyKey: `runner:AgentStarted:${id}`,
                payload: { agentId: id, role: spec.role },
            });
            await this.bus.publish({
                type: 'AgentFinished',
                v: 1,
                occurredAt: this.clock(),
                idempotencyKey: `runner:AgentFinished:${id}`,
                payload: {
                    agentId: id,
                    role: spec.role,
                    outcome: 'success',
                    content,
                },
            });
        })();
        this.pending.add(work);
        work.finally(() => this.pending.delete(work));
        return { id, spec };
    }

    async interrupt(): Promise<void> {
        // No-op; the lifecycle path under test never interrupts.
    }

    async flush(): Promise<void> {
        while (this.pending.size > 0) {
            await Promise.all(Array.from(this.pending));
        }
    }
}

interface Harness {
    readonly db: Db;
    readonly bus: EventBus;
    readonly cmdBus: CommandBus<unknown>;
    readonly runner: ScriptedFakeRunner;
    readonly planReview: PlanReviewStore;
    /** Live plan-lifecycle states, keyed by planId. */
    readonly planStates: Map<string, PlanLifecycleState>;
    /** Tasks projected from agent-emitted PlanDecomposed events, keyed by planId. */
    readonly taskProjection: Map<string, ReadonlyArray<{
        readonly id: string;
        readonly title: string;
        readonly type: string;
    }>>;
    /** Unsubscribe lifecycle / projection wires. */
    readonly stop: () => void;
    /** Feed a manual transition into the plan-lifecycle reducer. */
    readonly advancePlanState: (
        planId: string,
        event: PlanLifecycleEventInput,
    ) => void;
}

interface MakeHarnessOpts {
    readonly plannerContent: ContentFn;
    readonly decomposerContent: ContentFn;
}

function makeHarness(opts: MakeHarnessOpts): Harness {
    const db = openDatabase(':memory:');
    applyMigrations(db);
    const logger = new SilentLogger();
    const bus = new EventBus(new EventStore(db), logger);
    const cmdBus = new CommandBus<unknown>(bus, () => undefined);

    let now = 1_700_000_000_000;
    const clock = (): number => {
        now += 1;
        return now;
    };
    const idGen: IdGen = ((): IdGen => {
        let n = 0;
        return { newId: (): string => `task-${++n}` };
    })();

    const runner = new ScriptedFakeRunner(bus, clock, {
        planner: opts.plannerContent,
        decomposer: opts.decomposerContent,
    });
    const lifecycleAgents = new Map<string, LifecycleAgentContext>();

    // Gate that survives the SubmitBrief -> agent-emitted PlanGenerated path:
    // record on every PlanGenerated so ApprovePlan after an agent-driven
    // generation does not throw `no PlanGenerated event recorded`.
    const gateWiring = buildPlanGenerationGateWiring();
    const offGate = bus.subscribe(
        PlanLifecycleEvents.PLAN_GENERATED,
        async (event) => {
            const payload = event.payload as { planId: string };
            gateWiring.gate.record(payload.planId);
        },
    );

    // `setImmediate`-based deferral matches production wiring's intent: the
    // planner / decomposer spawn happens on the next macrotask, AFTER the
    // current await chain (and every microtask continuation chained off it)
    // drains. That lets the test observe the `plannerPhase = 'planning'`
    // snapshot in the gap between BriefSubmitted being persisted and the
    // planner agent actually starting — synchronous deferral collapses that
    // gap because the runner's IIFE microtasks would interleave straight
    // into the dispatch loop.
    const deferAgentStart = (run: () => void): void => {
        setImmediate(run);
    };

    registerCommandHandlers(cmdBus, {
        clock,
        idGen,
        logger,
        defaultFlowId: 'feature',
        defaultProjectId: 'proj-it',
        defaultTaskType: 'implement',
        agentRunner: runner,
        registerAgent: () => undefined,
        deferAgentStart,
        planGenerationGate: gateWiring.gate,
        lifecycleAgents,
    });

    const offLifecycle = registerPlanLifecycleAgentHandlers(bus, {
        clock,
        logger,
        agentRunner: runner,
        registerAgent: () => undefined,
        deferAgentStart,
        lifecycleAgents,
    });

    // ---- plan-lifecycle state machine fold ---------------------------------
    const planStates = new Map<string, PlanLifecycleState>();
    const advancePlanState = (
        planId: string,
        event: PlanLifecycleEventInput,
    ): void => {
        const before = planStates.get(planId) ?? initialState;
        planStates.set(planId, planLifecycleStep(before, event));
    };

    const offBrief = bus.subscribe(
        PlanLifecycleEvents.BRIEF_SUBMITTED,
        async (event) => {
            const planId = `plan-${(event.payload as { briefId: string }).briefId}`;
            advancePlanState(planId, { type: 'BriefSubmitted' });
        },
    );
    // Only the agent-emitted PlanGenerated (carries `content`) advances the
    // state machine to awaiting-approval. The synchronous one emitted by
    // the GeneratePlan command handler has no content and is treated as
    // the operator-side intent (handled by manual advancePlanState calls
    // before dispatching GeneratePlan).
    const offPlanGen = bus.subscribe(
        PlanLifecycleEvents.PLAN_GENERATED,
        async (event) => {
            const payload = event.payload as { planId: string; content?: string };
            if (typeof payload.content !== 'string') return;
            advancePlanState(payload.planId, { type: 'PlanGenerated' });
        },
    );
    // Only the agent-emitted PlanDecomposed (carries the nested validated
    // document on `tasks`) advances the state machine to `ready`. The
    // synchronous one from the DecomposePlan command handler omits `tasks`.
    const offPlanDec = bus.subscribe(
        PlanLifecycleEvents.PLAN_DECOMPOSED,
        async (event) => {
            const payload = event.payload as {
                planId: string;
                tasks?: unknown;
            };
            if (payload.tasks === undefined) return;
            advancePlanState(payload.planId, { type: 'PlanDecomposed' });
        },
    );

    // ---- plan-review-store -------------------------------------------------
    // The store wires its own PlanGenerated / PlanDecomposed
    // subscriptions when handed a bus. The named subscriber overlaps
    // with the orchestrator-level wiring in production, but in this
    // self-contained harness the only bus is the one created above so
    // a second subscription would never get the chance to fire.
    const planReview = new PlanReviewStore(db, bus);
    const offReview = (): void => {
        // No-op — the store's subscriptions live for the test lifetime
        // and the bus is torn down at the end of the run.
    };

    // ---- task-projection fold over the agent-emitted PlanDecomposed -------
    //
    // The production emit now lifts the agent's nested `plan.tasks`
    // into a flat `PlanDecomposedTask[]` on `payload.tasks`, so this
    // test subscriber reads the same shape the production
    // `TaskProjectionStore` consumes.
    const taskProjection = new Map<
        string,
        ReadonlyArray<{ id: string; title: string; type: string }>
    >();
    const offTaskProj = bus.subscribe(
        PlanLifecycleEvents.PLAN_DECOMPOSED,
        async (event) => {
            const payload = event.payload as {
                planId: string;
                tasks?: ReadonlyArray<Record<string, unknown>>;
            };
            const list = payload.tasks;
            if (!Array.isArray(list) || list.length === 0) return;
            const projected = list.map((t) => ({
                id: String(t['id']),
                title: String(t['title']),
                type: String(t['type']),
            }));
            taskProjection.set(payload.planId, projected);
        },
    );

    const stop = (): void => {
        offGate();
        offLifecycle();
        offBrief();
        offPlanGen();
        offPlanDec();
        offReview();
        offTaskProj();
        db.close();
    };

    return {
        db,
        bus,
        cmdBus,
        runner,
        planReview,
        planStates,
        taskProjection,
        stop,
        advancePlanState,
    };
}

// ---------------------------------------------------------------------------
// Static fake agent output bodies
// ---------------------------------------------------------------------------

const PLANNER_DRAFT_V1 =
    '## Goals\nShip the feature flag toggle\n\ncontext_impact: low';
const PLANNER_DRAFT_V2 =
    '## Goals\nShip the feature flag toggle (revised)\n\ncontext_impact: low';

const DECOMPOSER_TASK_IDS = ['task-001', 'task-002', 'task-003'] as const;

function decomposerOutputJson(planId: string): string {
    return JSON.stringify({
        plan: {
            id: planId,
            title: 'Feature flag toggle',
            description: 'Single-repo feature archetype.',
            tasks: [
                {
                    id: DECOMPOSER_TASK_IDS[0],
                    title: 'Scaffold feature module',
                    type: 'scaffold',
                    status: 'pending',
                    dependencies: [],
                    agent: { role: 'developer' },
                    context: { description: 'Create the feature module folder.' },
                },
                {
                    id: DECOMPOSER_TASK_IDS[1],
                    title: 'Implement toggle service',
                    type: 'implement',
                    status: 'pending',
                    dependencies: [DECOMPOSER_TASK_IDS[0]],
                    agent: { role: 'developer' },
                    context: { description: 'Wire the toggle service.' },
                },
                {
                    id: DECOMPOSER_TASK_IDS[2],
                    title: 'Integration test for toggle',
                    type: 'integration-test',
                    status: 'pending',
                    dependencies: [DECOMPOSER_TASK_IDS[1]],
                    agent: { role: 'tester' },
                    context: { description: 'Smoke-test the toggle service.' },
                },
            ],
        },
    });
}

const FEATURE_CONVENTIONS: PlanConventions = { namespace_root: 'feature' };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function eventPayloads<T = unknown>(db: Db, type: string): T[] {
    const rows = db
        .prepare('SELECT payload FROM events WHERE type = ? ORDER BY seq ASC')
        .all(type) as { payload: string }[];
    return rows.map((r) => JSON.parse(r.payload) as T);
}

function eventTypes(db: Db): string[] {
    const rows = db
        .prepare('SELECT type FROM events ORDER BY seq ASC')
        .all() as { type: string }[];
    return rows.map((r) => r.type);
}

/**
 * Drain the macrotask queue (so `setImmediate`-deferred agent spawns fire)
 * and then await every pending agent publish + downstream subscriber.
 *
 * Loops until both the macrotask queue and the runner's pending set are
 * empty in the same iteration, because each AgentFinished publish can
 * cause `registerPlanLifecycleAgentHandlers` to emit a PlanGenerated /
 * PlanDecomposed event that may itself fan back through subscribers that
 * queue more work.
 */
async function drainAgents(runner: ScriptedFakeRunner): Promise<void> {
    for (let i = 0; i < 8; i += 1) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        await runner.flush();
    }
}

// ---------------------------------------------------------------------------
// Test 1 — happy path
// ---------------------------------------------------------------------------

test('AP-VP4-015 happy path: brief -> planner -> approve -> decomposer -> 3 TaskCreated', async () => {
    const planId = 'plan-b-1';
    const h = makeHarness({
        plannerContent: () => PLANNER_DRAFT_V1,
        decomposerContent: () => decomposerOutputJson(planId),
    });
    try {
        // -- 1. SubmitBrief --------------------------------------------------
        await h.cmdBus.send<SubmitBriefPayload>({
            type: PlanLifecycleCommands.SUBMIT_BRIEF,
            actor: 'op',
            issuedAt: 1,
            payload: {
                briefId: 'b-1',
                projectId: 'proj-it',
                content: 'Build a feature flag toggle',
            },
        });

        // BriefSubmitted is on the log; the planner agent has been spawned
        // (deferAgentStart is synchronous) but its AgentStarted/Finished
        // publishes are still pending — so the projection snapshot must
        // show plannerPhase = 'planning' at revision 1.
        const briefRows = eventPayloads<{ briefId: string }>(
            h.db,
            PlanLifecycleEvents.BRIEF_SUBMITTED,
        );
        assert.equal(briefRows.length, 1, 'BriefSubmitted persisted once');
        assert.equal(briefRows[0]!.briefId, 'b-1');

        const stateAfterBrief = h.planStates.get(planId);
        assert.ok(stateAfterBrief, 'plan-lifecycle state recorded for planId');
        assert.equal(stateAfterBrief!.kind, 'planning');
        assert.equal(
            (stateAfterBrief as { revision: number }).revision,
            1,
            'plannerPhase = planning at revision 1',
        );

        // PlanReview snapshot should be empty at this point — the planner
        // has not yet finished.
        assert.equal(
            h.planReview.listRevisions(planId).length,
            0,
            'plan-review snapshot empty before planner finish',
        );

        // -- 2. Planner finish ----------------------------------------------
        await drainAgents(h.runner);

        const planGenAfterPlanner = eventPayloads<PlanGeneratedAgentEventPayload>(
            h.db,
            PlanLifecycleEvents.PLAN_GENERATED,
        );
        const agentGen1 = planGenAfterPlanner.find(
            (p) => typeof (p as { content?: string }).content === 'string',
        );
        assert.ok(agentGen1, 'agent-emitted PlanGenerated lands');
        assert.equal(agentGen1!.planId, planId);
        assert.equal(agentGen1!.revision, 1);
        assert.equal(agentGen1!.content, PLANNER_DRAFT_V1);

        const stateAfterPlanner = h.planStates.get(planId);
        assert.equal(stateAfterPlanner!.kind, 'awaiting-approval');
        assert.equal((stateAfterPlanner as { revision: number }).revision, 1);

        const latestRev1 = h.planReview.getLatest(planId);
        assert.ok(latestRev1, 'PlanReviewStore has a revision');
        assert.equal(latestRev1!.revision, 1);
        assert.equal(latestRev1!.content, PLANNER_DRAFT_V1);

        // -- 3. ApprovePlan + DecomposePlan ---------------------------------
        await h.cmdBus.send<ApprovePlanPayload>({
            type: Commands.APPROVE_PLAN,
            actor: 'op',
            issuedAt: 2,
            payload: { planId, projectId: 'proj-it' },
        });

        const approvedRows = eventPayloads<{ planId: string; actor: string }>(
            h.db,
            'PlanApproved',
        );
        assert.equal(approvedRows.length, 1);
        assert.equal(approvedRows[0]!.planId, planId);

        // The plan-lifecycle reducer treats DecomposePlan as the
        // approve-marker input; advance it explicitly so the snapshot
        // captures the brief moment between approve and the decomposer's
        // terminal PlanDecomposed.
        h.advancePlanState(planId, { type: 'DecomposePlan' });
        const stateAfterApprove = h.planStates.get(planId);
        assert.equal(stateAfterApprove!.kind, 'decomposing');
        assert.equal((stateAfterApprove as { revision: number }).revision, 1);

        await h.cmdBus.send<DecomposePlanPayload>({
            type: PlanLifecycleCommands.DECOMPOSE_PLAN,
            actor: 'op',
            issuedAt: 3,
            payload: {
                planId,
                projectId: 'proj-it',
                approvedContent: PLANNER_DRAFT_V1,
                conventions: FEATURE_CONVENTIONS,
            },
        });

        // -- 4. Decomposer finish -------------------------------------------
        await drainAgents(h.runner);

        const decomposedRows = eventPayloads<PlanDecomposedAgentEventPayload>(
            h.db,
            PlanLifecycleEvents.PLAN_DECOMPOSED,
        );
        const agentDecomposed = decomposedRows.find(
            (p) => (p as { tasks?: unknown }).tasks !== undefined,
        );
        assert.ok(agentDecomposed, 'agent-emitted PlanDecomposed lands');
        assert.equal(agentDecomposed!.planId, planId);

        const stateAfterDecompose = h.planStates.get(planId);
        assert.equal(stateAfterDecompose!.kind, 'ready');

        const taskRows = h.taskProjection.get(planId);
        assert.ok(taskRows, 'task-projection has rows for the plan');
        assert.equal(
            taskRows!.length,
            DECOMPOSER_TASK_IDS.length,
            'task-projection has exactly N tasks',
        );
        assert.deepEqual(
            taskRows!.map((t) => t.id),
            [...DECOMPOSER_TASK_IDS],
            'task ids round-trip from the fake decomposer JSON',
        );
        assert.equal(taskRows![0]!.type, 'scaffold');
        assert.equal(taskRows![1]!.type, 'implement');
        assert.equal(taskRows![2]!.type, 'integration-test');

        // Sanity: the persisted event trail contains the canonical happy-path
        // sequence (interleaved with runner / handler internals).
        const trail = eventTypes(h.db);
        assert.ok(trail.includes(PlanLifecycleEvents.BRIEF_SUBMITTED));
        assert.ok(trail.includes('AgentStarted'));
        assert.ok(trail.includes('AgentFinished'));
        assert.ok(trail.includes(PlanLifecycleEvents.PLAN_GENERATED));
        assert.ok(trail.includes('PlanApproved'));
        assert.ok(trail.includes(PlanLifecycleEvents.PLAN_DECOMPOSED));
    } finally {
        h.stop();
    }
});

// ---------------------------------------------------------------------------
// Test 2 — regenerate path: rev=1 -> GeneratePlan(rev=2, feedback) -> rev=2 -> approve
// ---------------------------------------------------------------------------

test('AP-VP4-015 regenerate path: rev=1 -> GeneratePlan(rev=2, feedback) -> approve -> decomposer', async () => {
    const planId = 'plan-b-2';
    const h = makeHarness({
        plannerContent: (call): string =>
            call === 1 ? PLANNER_DRAFT_V1 : PLANNER_DRAFT_V2,
        decomposerContent: () => decomposerOutputJson(planId),
    });
    try {
        // -- 1. Seed: SubmitBrief -> planner rev=1 --------------------------
        await h.cmdBus.send<SubmitBriefPayload>({
            type: PlanLifecycleCommands.SUBMIT_BRIEF,
            actor: 'op',
            issuedAt: 1,
            payload: {
                briefId: 'b-2',
                projectId: 'proj-it',
                content: 'Regenerate scenario brief',
            },
        });
        await drainAgents(h.runner);

        const stateAfterRev1 = h.planStates.get(planId);
        assert.equal(stateAfterRev1!.kind, 'awaiting-approval');
        assert.equal((stateAfterRev1 as { revision: number }).revision, 1);
        assert.equal(h.planReview.getLatest(planId)!.revision, 1);
        assert.equal(h.planReview.getLatest(planId)!.content, PLANNER_DRAFT_V1);

        // -- 2. GeneratePlan(rev=2, feedback) -------------------------------
        // From awaiting-approval, the reducer expects a `GeneratePlan`
        // input to bump revision and re-enter planning.
        h.advancePlanState(planId, { type: 'GeneratePlan' });
        const stateAfterRegenIntent = h.planStates.get(planId);
        assert.equal(stateAfterRegenIntent!.kind, 'planning');
        assert.equal(
            (stateAfterRegenIntent as { revision: number }).revision,
            2,
            'reducer bumps revision on regenerate',
        );

        await h.cmdBus.send<GeneratePlanPayload>({
            type: PlanLifecycleCommands.GENERATE_PLAN,
            actor: 'op',
            issuedAt: 2,
            payload: {
                planId,
                projectId: 'proj-it',
                revision: 2,
                feedback: 'simplify the toggle service',
                previousContent: PLANNER_DRAFT_V1,
            },
        });

        // Drain the macrotask-deferred spawn before inspecting the runner's
        // recorded starts. The planner agent for revision 2 must have been
        // spawned with the feedback and previous content threaded onto its
        // prompt.
        await drainAgents(h.runner);

        const plannerStarts = h.runner.starts.filter(
            (s) => s.spec.role === 'planner',
        );
        assert.equal(plannerStarts.length, 2);
        assert.ok(
            plannerStarts[1]!.spec.prompt.includes('simplify the toggle service'),
            'planner #2 prompt carries the feedback',
        );
        assert.ok(
            plannerStarts[1]!.spec.prompt.includes(PLANNER_DRAFT_V1),
            'planner #2 prompt carries the previous content',
        );

        // -- 3. PlanGenerated rev=2 with previousRevision=1 -----------------
        const gen = eventPayloads<PlanGeneratedAgentEventPayload>(
            h.db,
            PlanLifecycleEvents.PLAN_GENERATED,
        );
        const agentEmitted = gen.filter(
            (p) => typeof (p as { content?: string }).content === 'string',
        );
        assert.equal(agentEmitted.length, 2, 'two agent-driven PlanGenerated rows');
        const rev2 = agentEmitted.find((p) => p.revision === 2);
        assert.ok(rev2, 'rev=2 PlanGenerated landed');
        assert.equal(rev2!.content, PLANNER_DRAFT_V2);
        assert.equal(rev2!.feedback, 'simplify the toggle service');
        assert.equal(
            (rev2 as { previousRevision?: number }).previousRevision,
            1,
            'rev=2 references previousRevision=1',
        );

        const stateAfterRev2 = h.planStates.get(planId);
        assert.equal(stateAfterRev2!.kind, 'awaiting-approval');
        assert.equal((stateAfterRev2 as { revision: number }).revision, 2);

        const reviewRevisions = h.planReview.listRevisions(planId);
        assert.equal(reviewRevisions.length, 2, 'PlanReviewStore has both revisions');
        assert.equal(reviewRevisions[0]!.revision, 1);
        assert.equal(reviewRevisions[1]!.revision, 2);
        assert.equal(reviewRevisions[1]!.content, PLANNER_DRAFT_V2);
        assert.equal(reviewRevisions[1]!.feedback, 'simplify the toggle service');

        // -- 4. Second approval + decomposer -------------------------------
        await h.cmdBus.send<ApprovePlanPayload>({
            type: Commands.APPROVE_PLAN,
            actor: 'op',
            issuedAt: 3,
            payload: { planId, projectId: 'proj-it' },
        });
        h.advancePlanState(planId, { type: 'DecomposePlan' });

        await h.cmdBus.send<DecomposePlanPayload>({
            type: PlanLifecycleCommands.DECOMPOSE_PLAN,
            actor: 'op',
            issuedAt: 4,
            payload: {
                planId,
                projectId: 'proj-it',
                approvedContent: PLANNER_DRAFT_V2,
                conventions: FEATURE_CONVENTIONS,
            },
        });
        await drainAgents(h.runner);

        const stateAfterDecompose = h.planStates.get(planId);
        assert.equal(stateAfterDecompose!.kind, 'ready');

        const taskRows = h.taskProjection.get(planId);
        assert.ok(taskRows);
        assert.equal(taskRows!.length, DECOMPOSER_TASK_IDS.length);
        assert.deepEqual(
            taskRows!.map((t) => t.id),
            [...DECOMPOSER_TASK_IDS],
        );
    } finally {
        h.stop();
    }
});
