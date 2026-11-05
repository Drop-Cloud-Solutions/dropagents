/**
 * AP-VP4-010 — unit tests for the agent-driven half of the plan lifecycle.
 *
 * Coverage (one test per acceptance criterion):
 *
 *   AC #1 — BriefSubmitted spawns the planner agent; an AgentFinished
 *           publish with the agent's markdown body produces a PlanGenerated
 *           event whose payload carries `revision === 1` and the markdown
 *           verbatim as `content`.
 *
 *   AC #2 — GeneratePlan with `revision: 2`, `feedback`, and
 *           `previousContent` spawns the planner with all three values
 *           spliced into the prompt; the agent's AgentFinished body lands
 *           as a PlanGenerated event with `revision === 2` and
 *           `previousRevision === 1`.
 *
 *   AC #3 — DecomposePlan + valid decomposer JSON output → PlanDecomposed
 *           carrying the parsed `tasks` document.
 *
 *   AC #4 — Invalid decomposer JSON → PlanDecomposeFailed; NO retry spawn
 *           is started by the handler (operator owns Regenerate).
 *
 *   AC #5 — When PlanDecomposeFailed lands, the validation error is
 *           appended to the project's agent-memory.jsonl as a
 *           `clarification` entry tagged against the planId.
 *
 *   AC #6 — When a RepoReader is supplied the planner prompt picks up the
 *           rendered repo block (file tree + CLAUDE.md), pinning the
 *           contract that the orchestrator uses the port rather than
 *           re-walking the filesystem on its own.
 *
 *   AC #8 — Every test uses a FakeAgentRunner; no real `claude` CLI is
 *           spawned (asserted indirectly by the runner's `starts` array
 *           being the only place agent specs surface).
 *
 * Dual-runner discovery: see handlers.test.ts for the rationale behind
 * the `test` shim. Same pattern is used here so the suite runs under both
 * `node --test` and `vitest` without forking the file.
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { CommandBus } from '../../core/commands/bus';
import { EventBus } from '../../core/events/bus';
import { EventStore } from '../../core/events/store';
import type { Event } from '../../core/events/event';
import { applyMigrations, openDatabase, type Db } from '../../core/state/migrations';
import type {
    AgentHandle,
    AgentRunner,
    AgentSpec,
    IdGen,
    Logger,
} from '../../core/ports';
import type {
    RepoReader,
    RepoReadResult,
    RepoSpec,
} from '../../core/ports/RepoReader';
import {
    PlanLifecycleCommands,
    PlanLifecycleEvents,
    type DecomposePlanPayload,
    type GeneratePlanPayload,
    type SubmitBriefPayload,
} from '../../core/commands';
import { AgentMemoryStore } from '../../core/projects/agent-memory';

import {
    PlanLifecycleAgentEvents,
    derivePlanAbbr,
    registerCommandHandlers,
    registerPlanLifecycleAgentHandlers,
    sanitizeIdFragment,
    type LifecycleAgentContext,
    type PlanDecomposeFailedPayload,
    type PlanDecomposedAgentEventPayload,
    type PlanGenerateFailedPayload,
    type PlanGeneratedAgentEventPayload,
} from './handlers';
import { renderProjectContextBlock } from './project-context';

type TestFn = (name: string, fn: () => void | Promise<void>) => void;

const test: TestFn = (((): TestFn => {
    if (process.env.VITEST) {
        const gt = (globalThis as { test?: TestFn }).test;
        if (typeof gt !== 'function') {
            throw new Error(
                'plan-lifecycle-handlers.test.ts: VITEST=true but globalThis.test is missing',
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

class FakeAgentRunner implements AgentRunner {
    readonly starts: RecordedStart[] = [];
    private counter = 0;

    start(spec: AgentSpec): AgentHandle {
        this.counter += 1;
        const id = `agent-${this.counter}`;
        this.starts.push({ spec, handleId: id });
        return { id, spec };
    }

    async interrupt(): Promise<void> {
        // Lifecycle agents in these tests never get interrupted.
    }

    /** Last allocated handleId, useful for publishing AgentFinished afterwards. */
    lastHandleId(): string {
        return `agent-${this.counter}`;
    }
}

interface Harness {
    readonly db: Db;
    readonly bus: EventBus;
    readonly cmdBus: CommandBus<unknown>;
    readonly runner: FakeAgentRunner;
    readonly lifecycleAgents: Map<string, LifecycleAgentContext>;
    readonly memory: AgentMemoryStore;
    readonly projectsRoot: string;
    readonly cleanup: () => void;
}

interface MakeHarnessOpts {
    readonly repoReader?: RepoReader;
    readonly repoSpec?: RepoSpec;
    readonly getPlanArchetype?: (planId: string) => string | undefined;
    readonly getBriefContent?: (planId: string) => string | undefined;
    readonly resolveAgentPrompt?: (role: string) => string | undefined;
    readonly listWorkspaceRepos?: () => ReadonlyArray<{
        repoId: string;
        name: string;
        path: string;
    }>;
    readonly getRequirement?: (
        requirementId: string,
    ) => { title: string; description: string } | null;
    readonly getStackContextBlock?: () => string;
    readonly getProjectContextBlock?: (projectId: string) => string;
    readonly getRequirementDesign?: (requirementId: string) => {
        designDoc?: string;
        subBriefs: Array<{ systemId: string; title?: string; brief: string }>;
        rollout?: string;
    } | undefined;
}

function makeHarness(opts: MakeHarnessOpts = {}): Harness {
    const db = openDatabase(':memory:');
    applyMigrations(db);
    const logger = new SilentLogger();
    const store = new EventStore(db);
    const bus = new EventBus(store, logger);
    const cmdBus = new CommandBus<unknown>(bus, () => undefined);
    const runner = new FakeAgentRunner();
    const lifecycleAgents = new Map<string, LifecycleAgentContext>();
    const projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-vp4-010-h-'));
    const memory = new AgentMemoryStore(projectsRoot);
    const idGen: IdGen = ((): IdGen => {
        let n = 0;
        return { newId: (): string => `task-${++n}` };
    })();

    registerCommandHandlers(cmdBus, {
        clock: () => 1_700_000_000_000,
        idGen,
        logger,
        defaultFlowId: 'echo',
        defaultProjectId: 'proj-test',
        defaultTaskType: 'echo',
        agentRunner: runner,
        registerAgent: () => undefined,
        // Synchronous deferral so the assertions can read `runner.starts`
        // immediately after dispatching a command.
        deferAgentStart: (run): void => run(),
        agentMemory: memory,
        lifecycleAgents,
        repoReader: opts.repoReader,
        repoSpec: opts.repoSpec,
        db,
        ...(opts.getPlanArchetype ? { getPlanArchetype: opts.getPlanArchetype } : {}),
        ...(opts.getBriefContent ? { getBriefContent: opts.getBriefContent } : {}),
        ...(opts.getStackContextBlock
            ? { getStackContextBlock: opts.getStackContextBlock }
            : {}),
        ...(opts.getProjectContextBlock
            ? { getProjectContextBlock: opts.getProjectContextBlock }
            : {}),
        ...(opts.resolveAgentPrompt ? { resolveAgentPrompt: opts.resolveAgentPrompt } : {}),
    });

    registerPlanLifecycleAgentHandlers(bus, {
        clock: () => 1_700_000_000_000,
        logger,
        agentRunner: runner,
        registerAgent: () => undefined,
        deferAgentStart: (run): void => run(),
        lifecycleAgents,
        agentMemory: memory,
        repoReader: opts.repoReader,
        repoSpec: opts.repoSpec,
        ...(opts.resolveAgentPrompt ? { resolveAgentPrompt: opts.resolveAgentPrompt } : {}),
        ...(opts.listWorkspaceRepos ? { listWorkspaceRepos: opts.listWorkspaceRepos } : {}),
        ...(opts.getStackContextBlock
            ? { getStackContextBlock: opts.getStackContextBlock }
            : {}),
        ...(opts.getProjectContextBlock
            ? { getProjectContextBlock: opts.getProjectContextBlock }
            : {}),
        ...(opts.getRequirement ? { getRequirement: opts.getRequirement } : {}),
        ...(opts.getRequirementDesign
            ? { getRequirementDesign: opts.getRequirementDesign }
            : {}),
    });

    return {
        db,
        bus,
        cmdBus,
        runner,
        lifecycleAgents,
        memory,
        projectsRoot,
        cleanup: (): void => {
            db.close();
            fs.rmSync(projectsRoot, { recursive: true, force: true });
        },
    };
}

function readPayloads<T = unknown>(db: Db, type: string): T[] {
    return (
        db.prepare('SELECT payload FROM events WHERE type = ? ORDER BY seq').all(type) as {
            payload: string;
        }[]
    ).map((r) => JSON.parse(r.payload) as T);
}

async function publishAgentFinished(
    bus: EventBus,
    agentId: string,
    role: string,
    content: string,
): Promise<void> {
    const event: Event = {
        type: 'AgentFinished',
        v: 1,
        occurredAt: 1_700_000_000_000,
        idempotencyKey: `test:AgentFinished:${agentId}`,
        payload: { agentId, role, outcome: 'success', content },
    };
    await bus.publish(event);
}

async function publishAgentFailed(
    bus: EventBus,
    agentId: string,
    role: string,
    stderrTail: string,
): Promise<void> {
    const event: Event = {
        type: 'AgentFailed',
        v: 1,
        occurredAt: 1_700_000_000_000,
        idempotencyKey: `test:AgentFailed:${agentId}`,
        payload: { agentId, role, exitCode: 1, stderrTail },
    };
    await bus.publish(event);
}

// ---------------------------------------------------------------------------
// AC #1 — BriefSubmitted → planner spawn → AgentFinished → PlanGenerated rev=1
// ---------------------------------------------------------------------------

test('BriefSubmitted spawns the planner and AgentFinished emits PlanGenerated with revision === 1', async () => {
    const h = makeHarness();
    try {
        await h.cmdBus.send<SubmitBriefPayload>({
            type: PlanLifecycleCommands.SUBMIT_BRIEF,
            actor: 'op',
            issuedAt: 1,
            payload: {
                briefId: 'b-1',
                projectId: 'proj-test',
                content: 'Build a feature flag toggle',
            },
        });

        // Planner agent must have been spawned synchronously off the
        // BriefSubmitted subscriber.
        const plannerStart = h.runner.starts.find((s) => s.spec.role === 'planner');
        assert.ok(plannerStart, 'planner agent must have been started');
        assert.equal(plannerStart!.spec.metadata?.revision, 1);
        assert.ok(
            plannerStart!.spec.prompt.includes('Build a feature flag toggle'),
            'planner prompt must carry the brief content',
        );

        // Simulate the runner publishing AgentFinished with a rendered plan body.
        await publishAgentFinished(
            h.bus,
            plannerStart!.handleId,
            'planner',
            '## Goals\nShip the feature\n\ncontext_impact: possible',
        );

        const generated = readPayloads<PlanGeneratedAgentEventPayload>(
            h.db,
            PlanLifecycleEvents.PLAN_GENERATED,
        );
        // Find the agent-emitted one (carries content); synchronous handler
        // is not invoked for BriefSubmitted, so there is only one row.
        const agentEmitted = generated.find((p) => 'content' in p);
        assert.ok(agentEmitted, 'agent-driven PlanGenerated must be in the event log');
        assert.equal(agentEmitted!.planId, 'plan-b-1');
        assert.equal(agentEmitted!.revision, 1);
        assert.ok(
            (agentEmitted!.content as string).includes('Ship the feature'),
            'content must round-trip from AgentFinished',
        );
    } finally {
        h.cleanup();
    }
});

// ---------------------------------------------------------------------------
// Plan-type routing — a non-feature archetype skips the planner and
// decomposes the brief directly (documentation / review-* / deploy / investigate).
// ---------------------------------------------------------------------------

test('BriefSubmitted with a non-feature archetype spawns the decomposer, not the planner', async () => {
    const h = makeHarness();
    try {
        await h.cmdBus.send<SubmitBriefPayload>({
            type: PlanLifecycleCommands.SUBMIT_BRIEF,
            actor: 'op',
            issuedAt: 1,
            payload: {
                briefId: 'b-inv',
                projectId: 'proj-test',
                content: 'Why does the loan total drift by a cent?',
                archetype: 'investigate',
            },
        });
        assert.ok(!h.runner.starts.some((s) => s.spec.role === 'planner'),
            'planner must NOT be spawned for a non-feature archetype');
        const dec = h.runner.starts.find((s) => s.spec.role === 'decomposer');
        assert.ok(dec, 'decomposer must be spawned directly');
        assert.equal(dec!.spec.metadata?.kind, 'decomposer');
        assert.ok(dec!.spec.prompt.includes('Plan archetype: investigate'),
            'decomposer prompt must carry the archetype');
        assert.ok(dec!.spec.prompt.includes('loan total drift'),
            'decomposer prompt must carry the brief as the approved content');
    } finally {
        h.cleanup();
    }
});

test('GeneratePlan for a non-feature plan skips the planner and decomposes; no PlanGenerated', async () => {
    const h = makeHarness({ getPlanArchetype: () => 'documentation' });
    try {
        await h.cmdBus.send<GeneratePlanPayload>({
            type: PlanLifecycleCommands.GENERATE_PLAN,
            actor: 'op',
            issuedAt: 1,
            payload: {
                planId: 'plan-doc',
                projectId: 'proj-test',
                revision: 1,
                briefContent: 'Document the new alterations API',
            },
        });
        assert.ok(!h.runner.starts.some((s) => s.spec.role === 'planner'),
            'planner must NOT run for a documentation plan');
        const dec = h.runner.starts.find((s) => s.spec.role === 'decomposer');
        assert.ok(dec, 'decomposer must be spawned');
        assert.ok(dec!.spec.prompt.includes('Plan archetype: documentation'));
        // No PlanGenerated — the decomposer emits PlanDecomposed on finish.
        assert.equal(
            readPayloads(h.db, PlanLifecycleEvents.PLAN_GENERATED).length,
            0,
        );
    } finally {
        h.cleanup();
    }
});

test('GeneratePlan for a feature plan still runs the planner', async () => {
    const h = makeHarness({ getPlanArchetype: () => 'feature' });
    try {
        await h.cmdBus.send<GeneratePlanPayload>({
            type: PlanLifecycleCommands.GENERATE_PLAN,
            actor: 'op',
            issuedAt: 1,
            payload: { planId: 'plan-f', projectId: 'proj-test', revision: 1 },
        });
        assert.ok(h.runner.starts.some((s) => s.spec.role === 'planner'),
            'feature plans still run the planner');
    } finally {
        h.cleanup();
    }
});

test('a per-role Agent.prompt (management UI, Option B) replaces the persona in the spawned prompt', async () => {
    const h = makeHarness({
        resolveAgentPrompt: (role) => (role === 'planner' ? 'CUSTOM-PLANNER-PERSONA-XYZ' : undefined),
    });
    try {
        await h.cmdBus.send<SubmitBriefPayload>({
            type: PlanLifecycleCommands.SUBMIT_BRIEF,
            actor: 'op',
            issuedAt: 1,
            payload: { briefId: 'b-persona', projectId: 'proj-test', content: 'do the thing' },
        });
        const plannerStart = h.runner.starts.find((s) => s.spec.role === 'planner');
        assert.ok(plannerStart, 'planner spawned');
        assert.ok(
            plannerStart!.spec.prompt.includes('CUSTOM-PLANNER-PERSONA-XYZ'),
            'the Agent.prompt override must appear in the lifecycle prompt',
        );
    } finally {
        h.cleanup();
    }
});

test('GeneratePlan without briefContent recovers the original brief via getBriefContent (regenerate path)', async () => {
    const h = makeHarness({
        getBriefContent: (planId) =>
            planId === 'plan-x' ? 'Original brief: build the alterations API' : undefined,
    });
    try {
        // Mirrors an operator Regenerate after failed runs: no
        // briefContent, and previousContent empty because the latest
        // revision rows never got planner output.
        await h.cmdBus.send<GeneratePlanPayload>({
            type: PlanLifecycleCommands.GENERATE_PLAN,
            actor: 'op',
            issuedAt: 1,
            payload: {
                planId: 'plan-x',
                projectId: 'proj-test',
                revision: 8,
                previousContent: '',
            },
        });

        const plannerStart = h.runner.starts.find((s) => s.spec.role === 'planner');
        assert.ok(plannerStart);
        assert.ok(
            plannerStart!.spec.prompt.includes('Original brief: build the alterations API'),
            'regenerated planner prompt must carry the recovered brief',
        );
    } finally {
        h.cleanup();
    }
});

// ---------------------------------------------------------------------------
// AC #2 — GeneratePlan with revision N spawns planner with feedback + previousContent
// ---------------------------------------------------------------------------

test('GeneratePlan with revision 2 spawns planner with feedback + previousContent and emits PlanGenerated rev=2', async () => {
    const h = makeHarness();
    try {
        await h.cmdBus.send<GeneratePlanPayload>({
            type: PlanLifecycleCommands.GENERATE_PLAN,
            actor: 'op',
            issuedAt: 1,
            payload: {
                planId: 'plan-x',
                projectId: 'proj-test',
                revision: 2,
                feedback: 'simplify the diagram',
                previousContent: '## Goals\nDraft 1 here',
            },
        });

        const plannerStart = h.runner.starts.find((s) => s.spec.role === 'planner');
        assert.ok(plannerStart);
        assert.equal(plannerStart!.spec.metadata?.revision, 2);
        assert.ok(plannerStart!.spec.prompt.includes('simplify the diagram'));
        assert.ok(plannerStart!.spec.prompt.includes('Draft 1 here'));

        await publishAgentFinished(
            h.bus,
            plannerStart!.handleId,
            'planner',
            '## Goals\nRevised draft',
        );

        const generated = readPayloads<PlanGeneratedAgentEventPayload>(
            h.db,
            PlanLifecycleEvents.PLAN_GENERATED,
        );
        const agentEmitted = generated.find((p) => 'content' in p);
        assert.ok(agentEmitted);
        assert.equal(agentEmitted!.revision, 2);
        assert.equal(
            (agentEmitted as { previousRevision?: number }).previousRevision,
            1,
        );
        assert.equal(agentEmitted!.feedback, 'simplify the diagram');
    } finally {
        h.cleanup();
    }
});

// ---------------------------------------------------------------------------
// AC #3 — DecomposePlan + valid JSON → PlanDecomposed
// ---------------------------------------------------------------------------

test('structured ticket fields (goal / AC / files) survive the flatten into PlanDecomposed', async () => {
    const h = makeHarness();
    try {
        await h.cmdBus.send<DecomposePlanPayload>({
            type: PlanLifecycleCommands.DECOMPOSE_PLAN,
            actor: 'op',
            issuedAt: 1,
            payload: {
                planId: 'plan-ticket',
                projectId: 'proj-test',
                approvedContent: 'body',
                conventions: {},
            },
        });
        const start = h.runner.starts.find((s) => s.spec.role === 'decomposer');
        assert.ok(start);
        await publishAgentFinished(h.bus, start!.handleId, 'decomposer', JSON.stringify({
            plan: {
                id: 'plan-ticket',
                title: 'T',
                description: 'd',
                tasks: [{
                    id: 'task-001',
                    title: 'Rework handler',
                    type: 'implement',
                    status: 'pending',
                    dependencies: [],
                    agent: { role: 'developer' },
                    context: {
                        goal: 'Orders can be paid in several transactions.',
                        description: 'The brief paragraphs stay verbatim.',
                        acceptance_criteria: ['criterion A', 'criterion B'],
                        files_to_create: ['src/New.cs'],
                        files_to_modify: ['src/Old.cs'],
                        files_to_delete: [],
                    },
                }],
            },
        }));
        const decomposed = readPayloads<PlanDecomposedAgentEventPayload>(
            h.db,
            PlanLifecycleEvents.PLAN_DECOMPOSED,
        );
        const agentEmitted = decomposed.find((p) => 'tasks' in p);
        assert.ok(agentEmitted);
        const t = (agentEmitted!.tasks as ReadonlyArray<Record<string, unknown>>)[0]!;
        assert.equal(t.goal, 'Orders can be paid in several transactions.');
        assert.deepEqual(t.acceptanceCriteria, ['criterion A', 'criterion B']);
        assert.deepEqual(t.filesToCreate, ['src/New.cs']);
        assert.deepEqual(t.filesToModify, ['src/Old.cs']);
        assert.equal('filesToDelete' in t, false, 'empty lists are omitted');
        assert.equal(t.description, 'The brief paragraphs stay verbatim.');
    } finally {
        h.cleanup();
    }
});

test('ImplementFromInvestigation creates a fresh plan and fans the report out via the decomposer', async () => {
    const h = makeHarness();
    try {
        // Source review task + its durable reviewer summary (the report
        // the operator read), and its plan with a targetRepo to inherit.
        h.db.prepare(
            `INSERT INTO tasks(id, plan_id, type, status) VALUES ('L-AF-001', 'plan-inv', 'review-codebase', 'done')`,
        ).run();
        h.db.prepare(
            `INSERT INTO sidebar_plans(plan_id, pid, name, metadata, updated_at)
             VALUES ('plan-inv', 'shop', 'Review plan', '{"targetRepo":"catalog"}', 1)`,
        ).run();
        h.db.prepare(
            `INSERT INTO task_step_summaries(task_id, step_id, role, status, started_at, finished_at, summary)
             VALUES ('L-AF-001', 'review', 'codebase-reviewer', 'complete', 1, 2, '# Findings\nfix the filter')`,
        ).run();

        const events = await h.cmdBus.send({
            type: 'ImplementFromInvestigation',
            actor: 'operator',
            issuedAt: 10,
            payload: { taskId: 'L-AF-001', reportId: 'step:L-AF-001:review' },
        });

        // A fresh plan is created (inheriting project + targetRepo)…
        assert.equal(events.length, 1);
        assert.equal(events[0]!.type, 'PlanCreated');
        const p = events[0]!.payload as Record<string, unknown>;
        assert.ok(String(p.planId).startsWith('plan-impl-L-AF-001-'));
        assert.equal(p.projectId, 'shop');
        assert.ok(String(p.title).includes('L-AF-001'));
        assert.equal(p.body, '# Findings\nfix the filter');
        const md = p.metadata as Record<string, unknown>;
        assert.equal(md.targetRepo, 'catalog');
        assert.equal(md.sourceTaskId, 'L-AF-001');

        // …and the decomposer is spawned over the report content.
        const dec = h.runner.starts.find((s) => s.spec.role === 'decomposer');
        assert.ok(dec, 'decomposer spawned');
        assert.ok(dec!.spec.prompt.includes('fix the filter'));
        assert.ok(dec!.spec.prompt.includes('Implement the findings below'));
    } finally {
        h.cleanup();
    }
});

test('AskInvestigationFollowup spawns a follow-up investigate task carrying the Q&A thread', async () => {
    const h = makeHarness();
    try {
        h.db.prepare(
            `INSERT INTO tasks(id, plan_id, type, status) VALUES ('L-AF-001', 'plan-inv', 'investigate', 'done')`,
        ).run();
        h.db.prepare(
            `INSERT INTO task_step_summaries(task_id, step_id, role, status, started_at, finished_at, summary)
             VALUES ('L-AF-001', 'investigate', 'investigator', 'complete', 1, 2, 'The cause is X.')`,
        ).run();

        const events = await h.cmdBus.send({
            type: 'AskInvestigationFollowup',
            actor: 'operator',
            issuedAt: 10,
            payload: { taskId: 'L-AF-001', question: 'What about the Y case?' },
        });

        assert.equal(events.length, 1);
        assert.equal(events[0]!.type, 'TaskCreated');
        const p = events[0]!.payload as Record<string, unknown>;
        assert.equal(p.planId, 'plan-inv', 'same plan as the source task');
        assert.equal(p.type, 'investigate');
        assert.equal(p.flowId, 'investigate');
        assert.ok(String(p.title).startsWith('Follow-up:'));
        assert.ok(String(p.description).includes('What about the Y case?'));
        assert.ok(String(p.description).includes('The cause is X.'), 'prior report threaded in');
        assert.equal(p.parent_task_id, 'L-AF-001');
        assert.equal(p.spawn_reason, 'investigation-followup');
        const thread = p.investigation_thread as Array<{ role: string; content: string }>;
        assert.equal(thread.length, 2);
        assert.equal(thread[0]!.role, 'assistant');
        assert.equal(thread[0]!.content, 'The cause is X.');
        assert.equal(thread[1]!.role, 'user');
        assert.equal(thread[1]!.content, 'What about the Y case?');
    } finally {
        h.cleanup();
    }
});

test('DismissInvestigation is registered and records the dismissal', async () => {
    const h = makeHarness();
    try {
        const events = await h.cmdBus.send({
            type: 'DismissInvestigation',
            actor: 'operator',
            issuedAt: 10,
            payload: { taskId: 'L-AF-001', reportId: 'r1', reason: 'not needed' },
        });
        assert.equal(events.length, 1);
        assert.equal(events[0]!.type, 'InvestigationDismissed');
        assert.equal((events[0]!.payload as { reason?: string }).reason, 'not needed');
    } finally {
        h.cleanup();
    }
});

test('plan abbreviations never carry punctuation (Windows-path / git-ref safety)', () => {
    // Field case: a quoted word in the plan name leaked `"` into the
    // derived abbreviation → task id `P-CF"A-001` → worktree creation
    // impossible (`"` is an illegal Windows filename char) → Review
    // changes 404'd forever.
    assert.equal(derivePlanAbbr('Configure "FA" allowance'), 'CFA');
    assert.equal(derivePlanAbbr('fix (urgent) bug #42'), 'FUB4');
    assert.equal(derivePlanAbbr('"quoted"'), 'QUOT');
    assert.equal(derivePlanAbbr('!!! ---'), 'PLN');
    for (const abbr of [
        derivePlanAbbr('Configure "FA" allowance'),
        derivePlanAbbr('a/b\\c:d'),
        sanitizeIdFragment('P!', 'PRJ'),
        sanitizeIdFragment('"', 'PRJ'),
    ]) {
        assert.match(abbr, /^[A-Za-z0-9]+$/, `"${abbr}" must be path/ref/url safe`);
    }
    assert.equal(sanitizeIdFragment('P!', 'PRJ'), 'P');
    assert.equal(sanitizeIdFragment('"', 'PRJ'), 'PRJ');
});

test('per-task repo_path resolves to a registry repoId and rides PlanDecomposed', async () => {
    const h = makeHarness({
        listWorkspaceRepos: () => [
            { repoId: 'catalog', name: 'catalog', path: 'C:\\Drop-AI\\Source\\repos\\catalog' },
            { repoId: 'shop-orders', name: 'shop.orders', path: 'C:\\Drop-AI\\Source\\repos\\shop-orders' },
        ],
    });
    try {
        await h.cmdBus.send<DecomposePlanPayload>({
            type: PlanLifecycleCommands.DECOMPOSE_PLAN,
            actor: 'op',
            issuedAt: 1,
            payload: {
                planId: 'plan-repo',
                projectId: 'proj-test',
                approvedContent: 'body',
                conventions: {},
            },
        });
        const start = h.runner.starts.find((s) => s.spec.role === 'decomposer');
        assert.ok(start);
        await publishAgentFinished(h.bus, start!.handleId, 'decomposer', JSON.stringify({
            plan: {
                id: 'plan-repo',
                title: 'T',
                description: 'd',
                tasks: [
                    {
                        id: 'task-001',
                        title: 'Fix look list in CreationApp',
                        type: 'implement',
                        status: 'pending',
                        dependencies: [],
                        agent: { role: 'developer' },
                        // Exact ensured-path match (different separators/case).
                        context: {
                            description: 'x',
                            repo_path: 'c:/drop-ai/source/repos/CATALOG/',
                        },
                    },
                    {
                        id: 'task-002',
                        title: 'Event contract update',
                        type: 'implement',
                        status: 'pending',
                        dependencies: [],
                        agent: { role: 'developer' },
                        // Basename fallback with separator tolerance.
                        context: {
                            description: 'y',
                            repo_path: 'D:\\somewhere\\else\\shop.orders',
                        },
                    },
                    {
                        id: 'task-003',
                        title: 'Unmatched repo path',
                        type: 'implement',
                        status: 'pending',
                        dependencies: [],
                        agent: { role: 'developer' },
                        context: {
                            description: 'z',
                            repo_path: 'C:\\nothing\\matches\\this',
                        },
                    },
                ],
            },
        }));
        const decomposed = readPayloads<PlanDecomposedAgentEventPayload>(
            h.db,
            PlanLifecycleEvents.PLAN_DECOMPOSED,
        );
        const tasks = (decomposed.find((p) => 'tasks' in p)!.tasks
            ?? []) as ReadonlyArray<Record<string, unknown>>;
        assert.equal(tasks[0]!.repoId, 'catalog');
        assert.equal(tasks[1]!.repoId, 'shop-orders');
        assert.equal('repoId' in tasks[2]!, false, 'unmatched path falls back to plan repo');
    } finally {
        h.cleanup();
    }
});

test('DecomposePlan + valid decomposer JSON emits PlanDecomposed carrying the parsed tasks', async () => {
    const h = makeHarness();
    try {
        await h.cmdBus.send<DecomposePlanPayload>({
            type: PlanLifecycleCommands.DECOMPOSE_PLAN,
            actor: 'op',
            issuedAt: 1,
            payload: {
                planId: 'plan-y',
                projectId: 'proj-test',
                approvedContent: '## Goals\nApproved body',
                conventions: { namespace_root: 'Foo' },
            },
        });

        const decomposerStart = h.runner.starts.find((s) => s.spec.role === 'decomposer');
        assert.ok(decomposerStart);
        assert.ok(decomposerStart!.spec.prompt.includes('Approved body'));
        assert.ok(decomposerStart!.spec.prompt.includes('Foo'));

        const validJson = JSON.stringify({
            plan: {
                id: 'plan-y',
                title: 'Y',
                description: 'desc',
                tasks: [
                    {
                        id: 'task-001',
                        title: 'Implement Foo',
                        type: 'implement',
                        status: 'pending',
                        dependencies: [],
                        agent: { role: 'developer' },
                        context: { description: 'Build the foo service' },
                    },
                ],
            },
        });

        await publishAgentFinished(h.bus, decomposerStart!.handleId, 'decomposer', validJson);

        const decomposed = readPayloads<PlanDecomposedAgentEventPayload>(
            h.db,
            PlanLifecycleEvents.PLAN_DECOMPOSED,
        );
        const agentEmitted = decomposed.find((p) => 'tasks' in p);
        assert.ok(agentEmitted, 'agent-driven PlanDecomposed must be present');
        assert.equal(agentEmitted!.planId, 'plan-y');
        // The agent-driven emission lifts the decomposer's nested
        // `plan.tasks` into a flat `PlanDecomposedTask[]` so the
        // downstream `TaskProjectionStore` can fold one TaskCreated
        // per task without re-parsing the wrapper document.
        const tasks = agentEmitted!.tasks as ReadonlyArray<{
            id: string;
            title: string;
            type: string;
            description: string;
            dependencies: readonly string[];
        }>;
        assert.equal(tasks.length, 1);
        assert.equal(tasks[0].id, 'task-001');
        assert.equal(tasks[0].title, 'Implement Foo');
        assert.equal(tasks[0].type, 'implement');
        // `description` is lifted out of the nested `context.description`
        // so downstream consumers (TaskProjectionStore, board cards)
        // see a flat field.
        assert.equal(tasks[0].description, 'Build the foo service');
        assert.deepEqual(tasks[0].dependencies, []);
    } finally {
        h.cleanup();
    }
});

// ---------------------------------------------------------------------------
// AC #4 — Invalid decomposer JSON → PlanDecomposeFailed + NO auto-retry
// ---------------------------------------------------------------------------

test('DecomposePlan + invalid JSON emits PlanDecomposeFailed and does not auto-retry the decomposer', async () => {
    const h = makeHarness();
    try {
        await h.cmdBus.send<DecomposePlanPayload>({
            type: PlanLifecycleCommands.DECOMPOSE_PLAN,
            actor: 'op',
            issuedAt: 1,
            payload: {
                planId: 'plan-bad',
                projectId: 'proj-test',
                approvedContent: '## Goals\nApproved',
                conventions: {},
            },
        });

        const decomposerStart = h.runner.starts.find((s) => s.spec.role === 'decomposer');
        assert.ok(decomposerStart);

        // Output is JSON-valid but schema-invalid (missing tasks array entirely).
        const badJson = JSON.stringify({ plan: { id: 'p', title: 't', description: 'd' } });
        await publishAgentFinished(h.bus, decomposerStart!.handleId, 'decomposer', badJson);

        const failed = readPayloads<PlanDecomposeFailedPayload>(
            h.db,
            PlanLifecycleAgentEvents.PLAN_DECOMPOSE_FAILED,
        );
        assert.equal(failed.length, 1, 'exactly one PlanDecomposeFailed event must land');
        assert.equal(failed[0]!.planId, 'plan-bad');
        assert.ok(failed[0]!.error.includes('tasks'), 'error mentions the failing field');

        // AC #4 — no second decomposer spawn.
        const decomposerSpawns = h.runner.starts.filter((s) => s.spec.role === 'decomposer');
        assert.equal(decomposerSpawns.length, 1, 'handler must NOT auto-retry the decomposer');
    } finally {
        h.cleanup();
    }
});

// ---------------------------------------------------------------------------
// AC #5 — Rejection feedback is appended to projects/<pid>/agent-memory.jsonl
// ---------------------------------------------------------------------------

test('PlanDecomposeFailed appends rejection feedback to agent-memory.jsonl', async () => {
    const h = makeHarness();
    try {
        await h.cmdBus.send<DecomposePlanPayload>({
            type: PlanLifecycleCommands.DECOMPOSE_PLAN,
            actor: 'op',
            issuedAt: 1,
            payload: {
                planId: 'plan-mem',
                projectId: 'proj-test',
                approvedContent: 'approved',
                conventions: {},
            },
        });
        const decomposerStart = h.runner.starts.find((s) => s.spec.role === 'decomposer');
        assert.ok(decomposerStart);

        // Garbage stdout — not even JSON.
        await publishAgentFinished(
            h.bus,
            decomposerStart!.handleId,
            'decomposer',
            'not really json',
        );

        const entries = h.memory.read('proj-test');
        const planMemoryEntry = entries.find((e) => e.taskIdentifier === 'plan-mem');
        assert.ok(planMemoryEntry, 'rejection feedback must land in agent memory');
        assert.equal(planMemoryEntry!.source, 'clarification');
        assert.ok(planMemoryEntry!.feedback.includes('JSON'));
    } finally {
        h.cleanup();
    }
});

// ---------------------------------------------------------------------------
// AC #6 — RepoReader port is invoked (no fs walk in the handler)
// ---------------------------------------------------------------------------

test('Planner spawn invokes RepoReader.read and splices the result into the prompt', async () => {
    let reads = 0;
    const repoReader: RepoReader = {
        async read(_spec: RepoSpec): Promise<RepoReadResult> {
            reads += 1;
            return {
                claudeMd: '# CLAUDE.md sentinel',
                tree: ['Program.cs', 'src/Foo.cs'],
                sampleFiles: { 'Program.cs': 'public static void Main() {}' },
            };
        },
    };
    const repoSpec: RepoSpec = { repoPath: '/tmp/fake-repo' };
    const h = makeHarness({ repoReader, repoSpec });
    try {
        await h.cmdBus.send<SubmitBriefPayload>({
            type: PlanLifecycleCommands.SUBMIT_BRIEF,
            actor: 'op',
            issuedAt: 1,
            payload: { briefId: 'b-repo', projectId: 'proj-test', content: 'Build X' },
        });

        // RepoReader is awaited inside startLifecycleAgent; let the
        // microtask queue drain so the spawn lands before we assert.
        await new Promise<void>((resolve) => setImmediate(resolve));

        assert.equal(reads, 1, 'RepoReader.read must be called exactly once per spawn');
        const plannerStart = h.runner.starts.find((s) => s.spec.role === 'planner');
        assert.ok(plannerStart);
        assert.ok(plannerStart!.spec.prompt.includes('CLAUDE.md sentinel'));
        assert.ok(plannerStart!.spec.prompt.includes('Program.cs'));
    } finally {
        h.cleanup();
    }
});

// ---------------------------------------------------------------------------
// AgentFailed → Plan*Failed (paired with AC #4 — planner-side variant)
// ---------------------------------------------------------------------------

test('AgentFailed for a planner agent emits PlanGenerateFailed carrying the stderr tail', async () => {
    const h = makeHarness();
    try {
        await h.cmdBus.send<GeneratePlanPayload>({
            type: PlanLifecycleCommands.GENERATE_PLAN,
            actor: 'op',
            issuedAt: 1,
            payload: { planId: 'plan-z', projectId: 'proj-test', revision: 1 },
        });
        const plannerStart = h.runner.starts.find((s) => s.spec.role === 'planner');
        assert.ok(plannerStart);

        await publishAgentFailed(h.bus, plannerStart!.handleId, 'planner', 'rate limited');

        const failed = readPayloads<PlanGenerateFailedPayload>(
            h.db,
            PlanLifecycleAgentEvents.PLAN_GENERATE_FAILED,
        );
        assert.equal(failed.length, 1);
        assert.equal(failed[0]!.planId, 'plan-z');
        assert.equal(failed[0]!.revision, 1);
        assert.equal(failed[0]!.error, 'rate limited');
    } finally {
        h.cleanup();
    }
});

// ---------------------------------------------------------------------------
// AC #8 — Fake runner: no real ClaudeCliRunner spawn occurs
// ---------------------------------------------------------------------------

test('No real ClaudeCliRunner is constructed — every spawn lands on the FakeAgentRunner', async () => {
    const h = makeHarness();
    try {
        await h.cmdBus.send<GeneratePlanPayload>({
            type: PlanLifecycleCommands.GENERATE_PLAN,
            actor: 'op',
            issuedAt: 1,
            payload: { planId: 'plan-fake', projectId: 'proj-test', revision: 1 },
        });
        // FakeAgentRunner.start is the only path that pushes into `starts`,
        // so its non-empty state proves the orchestrator did not bypass the
        // injected port.
        assert.ok(h.runner.starts.length > 0);
        // The runner exposes a sentinel id scheme. A real spawn would have
        // produced a `claude-cli-N` id; the fake produces `agent-N`.
        for (const s of h.runner.starts) {
            assert.match(s.handleId, /^agent-\d+$/);
        }
    } finally {
        h.cleanup();
    }
});

// ---------------------------------------------------------------------------
// Architect auto-retry — invalid output re-runs ONCE with corrective feedback
// ---------------------------------------------------------------------------

test('invalid architect output auto-retries once, then parks for the operator', async () => {
    const h = makeHarness();
    try {
        const recorded: Array<{ type: string; payload: Record<string, unknown> }> = [];
        h.bus.subscribeAll((e) => {
            recorded.push({ type: e.type, payload: e.payload as Record<string, unknown> });
        });

        // Unique requirement id — the auto-retry once-guard is module-level,
        // so reusing ids across tests would consume the retry budget.
        const reqId = `REQ-RETRY-${Date.now()}`;
        await h.bus.publish({
            type: 'RequirementSubmitted', v: 1, occurredAt: 1,
            idempotencyKey: `SubmitRequirement:${reqId}:r1`,
            payload: {
                requirementId: reqId, title: 'Cross-system ask',
                description: 'Do the thing', actor: 'operator', revision: 1,
            },
        });
        assert.equal(h.runner.starts.length, 1, 'architect spawned for rev 1');

        // Architect finishes WITHOUT a proposal (ended mid-exploration).
        await h.bus.publish({
            type: 'AgentFinished', v: 1, occurredAt: 2,
            idempotencyKey: `fin:${reqId}:1`,
            payload: {
                agentId: h.runner.lastHandleId(), role: 'architect',
                outcome: 'success', content: 'Still exploring... let me wait for it.',
            },
        });

        const retries = recorded.filter(
            (e) => e.type === 'RequirementSubmitted' && e.payload.actor === 'architect-auto-retry',
        );
        assert.equal(retries.length, 1, 'one automatic re-submit');
        assert.equal(retries[0].payload.revision, 2);
        assert.match(String(retries[0].payload.feedback), /DISCARDED/);
        assert.equal(h.runner.starts.length, 2, 'auto-retry spawned a second architect');

        // Second invalid finish: no further auto-retry — operator's turn.
        await h.bus.publish({
            type: 'AgentFinished', v: 1, occurredAt: 3,
            idempotencyKey: `fin:${reqId}:2`,
            payload: {
                agentId: h.runner.lastHandleId(), role: 'architect',
                outcome: 'success', content: 'Still no JSON, sorry.',
            },
        });
        const retriesAfter = recorded.filter(
            (e) => e.type === 'RequirementSubmitted' && e.payload.actor === 'architect-auto-retry',
        );
        assert.equal(retriesAfter.length, 1, 'no second auto-retry');
        assert.equal(h.runner.starts.length, 2);
    } finally {
        h.cleanup();
    }
});

// ---------------------------------------------------------------------------
// Architect regenerate threads the PREVIOUS design (adjust, don't redesign)
// ---------------------------------------------------------------------------

test('architect regenerate (revision > 1) carries previous design + fan-out + feedback', async () => {
    const h = makeHarness({
        getRequirement: () => ({ title: 'Req title', description: 'Req desc' }),
        getRequirementDesign: () => ({
            designDoc: '# Design v1\nMove pricing into LookService.',
            subBriefs: [
                { systemId: 'catalog', title: 'Catalog slice', brief: 'Add LookService.' },
                { systemId: 'products', brief: 'Expose price endpoint.' },
            ],
            rollout: '- catalog after products — needs the endpoint',
        }),
    });
    try {
        await h.bus.publish({
            type: 'RequirementSubmitted', v: 1, occurredAt: 1,
            idempotencyKey: 'regen:req-9:r2',
            payload: {
                requirementId: 'req-9', title: '', description: '',
                actor: 'operator', revision: 2,
                feedback: 'Design verification found these problems: missing NuGet publish chain',
            },
        });
        assert.equal(h.runner.starts.length, 1, 'architect spawned');
        const prompt = h.runner.starts[0]!.spec.prompt ?? '';
        assert.ok(
            prompt.includes('# Previous design + fan-out (adjust minimally — do not redesign)'),
            'previous-design section present with the adjust heading',
        );
        assert.ok(prompt.includes('# Design v1'));
        assert.ok(prompt.includes('### System: catalog — Catalog slice'));
        assert.ok(prompt.includes('Expose price endpoint.'));
        assert.ok(prompt.includes('## Previous rollout order'));
        assert.ok(prompt.includes('missing NuGet publish chain'), 'findings ride as feedback');
    } finally {
        h.cleanup();
    }
});

test('first architect run (revision 1) has NO previous-design section', async () => {
    const h = makeHarness({
        getRequirement: () => ({ title: 'T', description: 'D' }),
        getRequirementDesign: () => ({
            designDoc: 'stale doc that must not leak into a first run',
            subBriefs: [],
        }),
    });
    try {
        await h.bus.publish({
            type: 'RequirementSubmitted', v: 1, occurredAt: 1,
            idempotencyKey: 'first:req-10:r1',
            payload: {
                requirementId: 'req-10', title: 'T', description: 'D',
                actor: 'operator', revision: 1,
            },
        });
        assert.equal(h.runner.starts.length, 1);
        const prompt = h.runner.starts[0]!.spec.prompt ?? '';
        // Newline-anchored: the persona rule MENTIONS the heading inline
        // (backticked); only a real section starts at column 0.
        assert.ok(!prompt.includes('\n# Previous design + fan-out'));
        assert.ok(!prompt.includes('stale doc'));
    } finally {
        h.cleanup();
    }
});

// ---------------------------------------------------------------------------
// The NuGet package graph must REACH the design-side agents.
//
// It was computed, passed by both call sites and declared on the args —
// and then never appended to the prompt. The decomposer's persona names
// that block as the authority for cross-repo bump chains ("Source of
// truth: the per-publisher chain block in the package graph context. Do
// not invent your own bump chain"), so it was being told to copy from
// something that never arrived. These tests assert the block through the
// real dispatch path, which is where the drop happened.
// ---------------------------------------------------------------------------

const GRAPH_BLOCK = [
    '# NuGet package graph (workspace)',
    '',
    '## Example.UiLib.HttpClientHandler (publisher: uilib)',
    'Consumers: shop, workshop',
    'Bump chain: uilib -> catalog -> shop',
].join('\n');

test('the decomposer prompt carries the package graph block', async () => {
    const h = makeHarness({ getStackContextBlock: (): string => GRAPH_BLOCK });
    try {
        await h.cmdBus.send<SubmitBriefPayload>({
            type: PlanLifecycleCommands.SUBMIT_BRIEF,
            actor: 'op',
            issuedAt: 1,
            payload: {
                briefId: 'b-pkg',
                projectId: 'proj-test',
                content: 'Bump Example.UiLib.HttpClientHandler to 0.0.12 everywhere.',
                archetype: 'investigate',
            },
        });
        const dec = h.runner.starts.find((s) => s.spec.role === 'decomposer');
        assert.ok(dec, 'decomposer must be spawned');
        assert.ok(
            dec!.spec.prompt.includes('# NuGet package graph (workspace)'),
            'the decomposer is told to copy bump chains out of this block',
        );
        assert.ok(
            dec!.spec.prompt.includes('Bump chain: uilib -> catalog -> shop'),
            'the chain itself must survive, not just the heading',
        );
    } finally {
        h.cleanup();
    }
});

test('the planner prompt carries the package graph block', async () => {
    const h = makeHarness({ getStackContextBlock: (): string => GRAPH_BLOCK });
    try {
        await h.cmdBus.send<SubmitBriefPayload>({
            type: PlanLifecycleCommands.SUBMIT_BRIEF,
            actor: 'op',
            issuedAt: 1,
            payload: {
                briefId: 'b-pkg2',
                projectId: 'proj-test',
                content: 'Add a feature flag toggle.',
            },
        });
        const planner = h.runner.starts.find((s) => s.spec.role === 'planner');
        assert.ok(planner, 'planner must be spawned');
        assert.ok(planner!.spec.prompt.includes('# NuGet package graph (workspace)'));
    } finally {
        h.cleanup();
    }
});

test('an empty package graph adds nothing to the prompt', async () => {
    // The provider returns '' when the workspace scan finds no packages
    // or fails outright — that must not leave a dangling heading or a
    // stray blank block.
    const h = makeHarness({ getStackContextBlock: (): string => '' });
    try {
        await h.cmdBus.send<SubmitBriefPayload>({
            type: PlanLifecycleCommands.SUBMIT_BRIEF,
            actor: 'op',
            issuedAt: 1,
            payload: {
                briefId: 'b-pkg3',
                projectId: 'proj-test',
                content: 'Add a feature flag toggle.',
            },
        });
        const planner = h.runner.starts.find((s) => s.spec.role === 'planner');
        assert.ok(planner);
        assert.ok(!planner!.spec.prompt.includes('NuGet package graph'));
    } finally {
        h.cleanup();
    }
});

// ---------------------------------------------------------------------------
// Project context reaches the design-side agents.
//
// `ProjectConfig.metadata.context_md` was storage with nothing attached to
// either end: both ConfigStore adapters persisted it, no route wrote it,
// no UI showed it, and no agent was handed it. This is the read half.
// ---------------------------------------------------------------------------

const PROJECT_CONTEXT = [
    '# How this project fits together',
    '',
    'shop.orders owns pricing; the WASM apps consume it as a NuGet package.',
].join('\n');

test('the planner prompt carries the project context block', async () => {
    const h = makeHarness({
        getProjectContextBlock: (projectId: string): string =>
            projectId === 'proj-test' ? renderProjectContextBlock(PROJECT_CONTEXT) : '',
    });
    try {
        await h.cmdBus.send<SubmitBriefPayload>({
            type: PlanLifecycleCommands.SUBMIT_BRIEF,
            actor: 'op',
            issuedAt: 1,
            payload: {
                briefId: 'b-ctx',
                projectId: 'proj-test',
                content: 'Add a feature flag toggle.',
            },
        });
        const planner = h.runner.starts.find((s) => s.spec.role === 'planner');
        assert.ok(planner, 'planner must be spawned');
        assert.match(planner!.spec.prompt, /^# Project context$/m);
        assert.match(planner!.spec.prompt, /shop\.orders owns pricing/);
    } finally {
        h.cleanup();
    }
});

test('the decomposer prompt carries it too', async () => {
    const h = makeHarness({
        getProjectContextBlock: (): string => renderProjectContextBlock(PROJECT_CONTEXT),
    });
    try {
        await h.cmdBus.send<SubmitBriefPayload>({
            type: PlanLifecycleCommands.SUBMIT_BRIEF,
            actor: 'op',
            issuedAt: 1,
            payload: {
                briefId: 'b-ctx2',
                projectId: 'proj-test',
                content: 'Why does the loan total drift?',
                archetype: 'investigate',
            },
        });
        const dec = h.runner.starts.find((s) => s.spec.role === 'decomposer');
        assert.ok(dec, 'decomposer must be spawned');
        assert.match(dec!.spec.prompt, /^# Project context$/m);
    } finally {
        h.cleanup();
    }
});

test('a project with no context adds no block', async () => {
    const h = makeHarness({ getProjectContextBlock: (): string => '' });
    try {
        await h.cmdBus.send<SubmitBriefPayload>({
            type: PlanLifecycleCommands.SUBMIT_BRIEF,
            actor: 'op',
            issuedAt: 1,
            payload: {
                briefId: 'b-ctx3',
                projectId: 'proj-test',
                content: 'Add a feature flag toggle.',
            },
        });
        const planner = h.runner.starts.find((s) => s.spec.role === 'planner');
        assert.ok(planner);
        assert.doesNotMatch(planner!.spec.prompt, /# Project context/);
    } finally {
        h.cleanup();
    }
});

test('the block frames the context as background, not instructions', async () => {
    // Without this the planner reads an architecture description as a
    // request and starts designing changes to it.
    const rendered = renderProjectContextBlock(PROJECT_CONTEXT);
    assert.match(rendered, /^# Project context$/m);
    assert.match(rendered, /background, not an instruction/);
    assert.match(rendered, /does not\s*\n?override the brief/);
    assert.equal(renderProjectContextBlock('   '), '', 'blank context renders nothing');
});
