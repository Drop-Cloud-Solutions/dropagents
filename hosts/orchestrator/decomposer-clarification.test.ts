/**
 * The decomposer's own `NEEDS_HUMAN_INPUT` escape hatch.
 *
 * Field case this pins: the decomposer hit an ambiguity, emitted the shared
 * escape-hatch block (its persona carries it, like every other persona) and
 * stopped. `emitPlanDecomposed` looked for JSON, found prose, and failed the
 * run with "decomposer output contains no JSON object". The operator got a
 * parser error on a red card — no sign that an agent had asked them
 * something, and no way to answer it.
 *
 * What must hold now:
 *   1. A question is recognised BEFORE the JSON extraction and raises
 *      PlanDecomposeQuestionRaised, never PlanDecomposeFailed.
 *   2. The question is durable, so the board can paint the Answer button
 *      after a reload and the command can verify the question is still open.
 *   3. AnswerDecomposerQuestion emits an answer only for a question that is
 *      actually pending — answering twice is refused rather than re-run.
 *   4. The answer re-spawns the decomposer with the plan's answers in a
 *      `# Human clarification` block AND the original approved plan.
 *   5. Every answer on the plan survives a second question — a later
 *      decision must not erase an earlier one.
 *   6. The cap fails the run instead of looping forever.
 *   7. Real JSON output is untouched by any of this.
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
    registerCommandHandlers,
    registerPlanLifecycleAgentHandlers,
    type LifecycleAgentContext,
} from './handlers';

/** Newline, named so the multi-line agent fixtures below stay readable. */
const LF = '\n';

const PLAN_ID = 'plan-q';
const PROJECT_ID = 'proj-q';

const QUESTION_OUTPUT = [
    'I read the approved plan and the repo. One thing I cannot decide safely.',
    '',
    'NEEDS_HUMAN_INPUT',
    'Question: Should the new endpoint live in the existing Orders API or in a',
    'new Billing API?',
    'Options:',
    '  A) Extend the Orders API — fastest, but couples billing to orders',
    '  B) Stand up a new Billing API',
    '  C) cancel the task',
].join('\n');

const VALID_JSON_OUTPUT = JSON.stringify({
    plan: {
        id: PLAN_ID,
        title: 'A plan',
        description: 'Add an endpoint.',
        tasks: [
            {
                id: 'task-001',
                title: 'Add the endpoint',
                type: 'implement',
                status: 'pending',
                agent: 'developer',
                dependencies: [],
                context: { description: 'Add the endpoint to the API host.', files_to_modify: [] },
            },
        ],
    },
});

class SilentLogger implements Logger {
    info(): void {}
    warn(): void {}
    error(): void {}
    debug(): void {}
}

class CapturingRunner implements AgentRunner {
    readonly specs: AgentSpec[] = [];
    private counter = 0;
    start(spec: AgentSpec): AgentHandle {
        this.specs.push(spec);
        this.counter += 1;
        return { id: `agent-${this.counter}`, spec };
    }
    async interrupt(): Promise<void> {}
}

interface Harness {
    readonly db: Db;
    readonly bus: EventBus;
    readonly cmdBus: CommandBus<unknown>;
    readonly runner: CapturingRunner;
    readonly lifecycleAgents: Map<string, LifecycleAgentContext>;
    /** Drive one decomposer run to completion with `output` as its answer. */
    finishDecomposer(agentId: string, output: string): Promise<void>;
    /** Every event of `type` in the log, oldest first. */
    events(type: string): ReadonlyArray<Record<string, unknown>>;
    cleanup(): void;
}

function makeHarness(): Harness {
    const db = openDatabase(':memory:');
    applyMigrations(db);
    const logger = new SilentLogger();
    const store = new EventStore(db);
    const bus = new EventBus(store, logger);
    const cmdBus = new CommandBus<unknown>(bus, () => undefined);
    const idGen: IdGen = { newId: (): string => 'task-x' };
    const runner = new CapturingRunner();
    const lifecycleAgents = new Map<string, LifecycleAgentContext>();
    let now = 1_700_000_000_000;
    const clock = (): number => (now += 1000);

    // Minimal stand-in for the production projection (main.ts
    // attachPlanProjection). Same statements, so the SQL that the read
    // helpers depend on is exercised rather than mocked around.
    bus.subscribe<Record<string, unknown>>(
        'PlanDecomposeQuestionRaised',
        async (event) => {
            const p = event.payload;
            db.prepare(
                `INSERT OR IGNORE INTO decomposer_clarifications
                     (event_seq, plan_id, project_id, question, options, asked_at)
                 VALUES (?, ?, ?, ?, ?, ?)`,
            ).run(
                event.seq,
                p.planId as string,
                (p.projectId as string) ?? '',
                p.question as string,
                Array.isArray(p.options) && p.options.length > 0
                    ? JSON.stringify(p.options)
                    : null,
                (p.askedAt as number) ?? event.occurredAt,
            );
        },
        { subscriber: 'test-projection' },
    );
    bus.subscribe<Record<string, unknown>>(
        'PlanDecomposeQuestionAnswered',
        async (event) => {
            const p = event.payload;
            db.prepare(
                `UPDATE decomposer_clarifications
                    SET answer = ?, answered_at = ?
                  WHERE event_seq = (
                      SELECT event_seq FROM decomposer_clarifications
                       WHERE plan_id = ? AND (answer IS NULL OR TRIM(answer) = '')
                       ORDER BY event_seq ASC
                       LIMIT 1
                  )`,
            ).run(p.answer as string, (p.answeredAt as number) ?? event.occurredAt, p.planId as string);
        },
        { subscriber: 'test-projection' },
    );

    const shared = {
        clock,
        logger,
        agentRunner: runner,
        registerAgent: (): void => {},
        deferAgentStart: (run: () => void): void => run(),
        lifecycleAgents,
        db,
    };

    registerCommandHandlers(cmdBus, {
        ...shared,
        idGen,
        defaultFlowId: 'echo',
        defaultProjectId: PROJECT_ID,
        defaultTaskType: 'echo',
    });
    registerPlanLifecycleAgentHandlers(bus, shared);

    return {
        db,
        bus,
        cmdBus,
        runner,
        lifecycleAgents,
        async finishDecomposer(agentId, output): Promise<void> {
            await bus.publish({
                type: 'AgentFinished',
                v: 1,
                occurredAt: clock(),
                idempotencyKey: `finished:${agentId}:${String(clock())}`,
                payload: { agentId, role: 'decomposer', outcome: 'success', content: output },
            });
        },
        events(type): ReadonlyArray<Record<string, unknown>> {
            const rows = db
                .prepare('SELECT payload FROM events WHERE type = ? ORDER BY seq ASC')
                .all(type) as ReadonlyArray<{ payload: string }>;
            return rows.map((r) => JSON.parse(r.payload) as Record<string, unknown>);
        },
        cleanup(): void { db.close(); },
    };
}

/** Dispatch DecomposePlan and return the agentId of the spawned run. */
async function startDecompose(h: Harness, approvedContent = 'THE APPROVED PLAN'): Promise<string> {
    const before = h.runner.specs.length;
    await h.cmdBus.send({
        type: 'DecomposePlan',
        actor: 'operator',
        issuedAt: 1,
        payload: {
            planId: PLAN_ID,
            projectId: PROJECT_ID,
            approvedContent,
            conventions: {},
        },
    });
    assert.equal(h.runner.specs.length, before + 1, 'DecomposePlan must spawn a decomposer');
    // The lifecycleAgents map is keyed by the handle id the runner minted.
    const ids = Array.from(h.lifecycleAgents.keys());
    return ids[ids.length - 1]!;
}

test('a NEEDS_HUMAN_INPUT block raises a question instead of failing the decompose', async () => {
    const h = makeHarness();
    try {
        const agentId = await startDecompose(h);
        await h.finishDecomposer(agentId, QUESTION_OUTPUT);

        const failures = h.events('PlanDecomposeFailed');
        assert.deepEqual(
            failures,
            [],
            'a question is not a failure — this is the regression: it used to '
            + 'surface as "decomposer output contains no JSON object"',
        );

        const raised = h.events('PlanDecomposeQuestionRaised');
        assert.equal(raised.length, 1);
        assert.equal(raised[0]!.planId, PLAN_ID);
        assert.equal(raised[0]!.projectId, PROJECT_ID);
        assert.match(
            raised[0]!.question as string,
            /Should the new endpoint live in the existing Orders API/,
        );
        // Hard-wrapped question lines are re-joined, not truncated at the
        // first newline.
        assert.match(raised[0]!.question as string, /new Billing API\?$/);
        const options = raised[0]!.options as ReadonlyArray<{ key: string; label: string }>;
        assert.deepEqual(options.map((o) => o.key), ['A', 'B', 'C']);
        assert.match(options[0]!.label, /Extend the Orders API/);
    } finally { h.cleanup(); }
});

test('the question is recorded durably and readable as the pending one', async () => {
    const h = makeHarness();
    try {
        const agentId = await startDecompose(h);
        await h.finishDecomposer(agentId, QUESTION_OUTPUT);

        const row = h.db
            .prepare(
                `SELECT plan_id, project_id, question, options, answer
                   FROM decomposer_clarifications WHERE plan_id = ?`,
            )
            .get(PLAN_ID) as {
                plan_id: string;
                project_id: string;
                question: string;
                options: string | null;
                answer: string | null;
            } | undefined;
        assert.ok(row, 'the raise must project a row');
        assert.equal(row!.project_id, PROJECT_ID);
        assert.equal(row!.answer, null, 'unanswered until the operator answers');
        assert.ok(row!.options, 'enumerated options are stored for the Answer modal');
    } finally { h.cleanup(); }
});

test('answering re-spawns the decomposer with the answer and the approved plan', async () => {
    const h = makeHarness();
    try {
        const agentId = await startDecompose(h);
        await h.finishDecomposer(agentId, QUESTION_OUTPUT);
        const spawnsBefore = h.runner.specs.length;

        await h.cmdBus.send({
            type: 'AnswerDecomposerQuestion',
            actor: 'operator',
            issuedAt: 2,
            payload: { planId: PLAN_ID, answer: 'B) Stand up a new Billing API' },
        });

        assert.equal(
            h.runner.specs.length,
            spawnsBefore + 1,
            'the answer must re-spawn the decomposer — "continues once answered"',
        );
        const prompt = h.runner.specs[h.runner.specs.length - 1]!.prompt ?? '';
        assert.match(prompt, /^# Human clarification$/m, 'the answer rides the block every persona names');
        assert.match(prompt, /Stand up a new Billing API/);
        assert.match(
            prompt,
            /Should the new endpoint live in the existing Orders API/,
            'the question is carried with the answer — a bare answer means nothing',
        );
        assert.match(
            prompt,
            /THE APPROVED PLAN/,
            'the re-spawn still decomposes the approved plan, not just the answer',
        );

        const row = h.db
            .prepare('SELECT answer FROM decomposer_clarifications WHERE plan_id = ?')
            .get(PLAN_ID) as { answer: string | null };
        assert.match(row.answer ?? '', /Billing API/);
    } finally { h.cleanup(); }
});

test('answering a question that is not pending is refused, not silently re-run', async () => {
    const h = makeHarness();
    try {
        const agentId = await startDecompose(h);
        await h.finishDecomposer(agentId, QUESTION_OUTPUT);
        await h.cmdBus.send({
            type: 'AnswerDecomposerQuestion',
            actor: 'operator',
            issuedAt: 2,
            payload: { planId: PLAN_ID, answer: 'B' },
        });
        const spawnsAfterFirst = h.runner.specs.length;

        await assert.rejects(
            () => h.cmdBus.send({
                type: 'AnswerDecomposerQuestion',
                actor: 'operator',
                issuedAt: 3,
                payload: { planId: PLAN_ID, answer: 'A' },
            }),
            /no unanswered decomposer question/,
        );
        assert.equal(h.runner.specs.length, spawnsAfterFirst, 'no second re-spawn');
    } finally { h.cleanup(); }
});

test('a second question keeps the first answer — decisions accumulate', async () => {
    const h = makeHarness();
    try {
        const first = await startDecompose(h);
        await h.finishDecomposer(first, QUESTION_OUTPUT);
        await h.cmdBus.send({
            type: 'AnswerDecomposerQuestion',
            actor: 'operator',
            issuedAt: 2,
            payload: { planId: PLAN_ID, answer: 'Use a new Billing API' },
        });

        // The re-spawned run asks something else.
        const secondId = Array.from(h.lifecycleAgents.keys()).pop()!;
        await h.finishDecomposer(secondId, [
            'NEEDS_HUMAN_INPUT',
            'Question: Which repo owns the Billing API?',
            'Options:',
            '  A) billing',
            '  B) orders',
        ].join('\n'));
        await h.cmdBus.send({
            type: 'AnswerDecomposerQuestion',
            actor: 'operator',
            issuedAt: 4,
            payload: { planId: PLAN_ID, answer: 'The billing repo' },
        });

        const prompt = h.runner.specs[h.runner.specs.length - 1]!.prompt ?? '';
        assert.match(prompt, /Use a new Billing API/, 'the FIRST decision must survive');
        assert.match(prompt, /The billing repo/);
        assert.match(prompt, /Which repo owns the Billing API\?/);
    } finally { h.cleanup(); }
});

test('the fourth question fails the decomposition instead of looping', async () => {
    const h = makeHarness();
    try {
        let agentId = await startDecompose(h);
        for (let i = 0; i < 3; i++) {
            await h.finishDecomposer(agentId, [
                'NEEDS_HUMAN_INPUT',
                `Question: Question number ${String(i + 1)}?`,
            ].join('\n'));
            await h.cmdBus.send({
                type: 'AnswerDecomposerQuestion',
                actor: 'operator',
                issuedAt: 10 + i,
                payload: { planId: PLAN_ID, answer: `answer ${String(i + 1)}` },
            });
            agentId = Array.from(h.lifecycleAgents.keys()).pop()!;
        }
        assert.equal(h.events('PlanDecomposeQuestionRaised').length, 3);

        await h.finishDecomposer(agentId, [
            'NEEDS_HUMAN_INPUT',
            'Question: Question number 4?',
        ].join('\n'));

        assert.equal(
            h.events('PlanDecomposeQuestionRaised').length,
            3,
            'the cap holds — no fourth question reaches the operator',
        );
        const failures = h.events('PlanDecomposeFailed');
        assert.equal(failures.length, 1);
        assert.match(failures[0]!.error as string, /not converging/);
        assert.match(
            failures[0]!.error as string,
            /Question number 4\?/,
            'the failure names what it kept asking, so the operator can act on it',
        );
    } finally { h.cleanup(); }
});

test('ordinary JSON output still decomposes — the question check is not in the way', async () => {
    const h = makeHarness();
    try {
        const agentId = await startDecompose(h);
        await h.finishDecomposer(agentId, VALID_JSON_OUTPUT);
        assert.deepEqual(h.events('PlanDecomposeQuestionRaised'), []);
        assert.deepEqual(h.events('PlanDecomposeFailed'), []);
        // Two PlanDecomposed events by design: the command handler emits
        // one synchronously and the agent bridge emits the one carrying the
        // validated task document. Assert on the latter.
        const withTasks = h.events('PlanDecomposed').filter((e) => e.tasks !== undefined);
        assert.equal(withTasks.length, 1);
    } finally { h.cleanup(); }
});

test('a marker with no Question: line still fails loudly rather than vanishing', async () => {
    const h = makeHarness();
    try {
        const agentId = await startDecompose(h);
        // Unparseable escape hatch: the marker is there but there is nothing
        // to put in front of an operator. It must NOT hold the run on an
        // empty question — it falls through and fails with the real error.
        await h.finishDecomposer(agentId, 'NEEDS_HUMAN_INPUT\n\nI am stuck.');
        assert.deepEqual(h.events('PlanDecomposeQuestionRaised'), []);
        assert.equal(h.events('PlanDecomposeFailed').length, 1);
    } finally { h.cleanup(); }
});

test('the Answer button still works when the projection missed the row', async () => {
    // Field report: "nothing happens when I click submit".
    //
    // The card is painted by folding the EVENT LOG
    // (`/api/active-decomposers`), and the command used to validate only
    // against the projection TABLE. When those disagree — the table was not
    // yet migrated when the event landed, or a subscriber error the bus
    // logged and swallowed — the operator gets an Answer button whose
    // command refuses every click. A permanently dead control, with no way
    // to un-hold the plan and nothing on screen explaining why.
    //
    // Simulated by deleting the projected row after the question is raised:
    // the event stays, the table forgets. The answer must still land.
    const h = makeHarness();
    try {
        const agentId = await startDecompose(h);
        await h.finishDecomposer(agentId, QUESTION_OUTPUT);
        assert.equal(h.events('PlanDecomposeQuestionRaised').length, 1);

        h.db.prepare('DELETE FROM decomposer_clarifications').run();
        const spawnsBefore = h.runner.specs.length;

        await h.cmdBus.send({
            type: 'AnswerDecomposerQuestion',
            actor: 'operator',
            issuedAt: 2,
            payload: { planId: PLAN_ID, answer: 'B) Stand up a new Billing API' },
        });

        assert.equal(
            h.runner.specs.length,
            spawnsBefore + 1,
            'the answer must still re-spawn the decomposer',
        );
        const prompt = h.runner.specs[h.runner.specs.length - 1]!.prompt ?? '';
        assert.match(prompt, /^# Human clarification$/m);
        assert.match(prompt, /Stand up a new Billing API/);
    } finally { h.cleanup(); }
});

test('the cap counts emitted questions even when the projection is empty', async () => {
    // Same gap, other direction: a read-side gap must not silently RAISE
    // the cap and let the decomposer ask forever.
    const h = makeHarness();
    try {
        let agentId = await startDecompose(h);
        for (let i = 0; i < 3; i++) {
            await h.finishDecomposer(agentId, [
                'NEEDS_HUMAN_INPUT',
                `Question: Question number ${String(i + 1)}?`,
            ].join(LF));
            await h.cmdBus.send({
                type: 'AnswerDecomposerQuestion',
                actor: 'operator',
                issuedAt: 10 + i,
                payload: { planId: PLAN_ID, answer: `answer ${String(i + 1)}` },
            });
            agentId = Array.from(h.lifecycleAgents.keys()).pop()!;
        }
        h.db.prepare('DELETE FROM decomposer_clarifications').run();

        await h.finishDecomposer(agentId, [
            'NEEDS_HUMAN_INPUT',
            'Question: Question number 4?',
        ].join(LF));

        assert.equal(
            h.events('PlanDecomposeQuestionRaised').length,
            3,
            'the cap holds off the event log, not the projection',
        );
        assert.equal(h.events('PlanDecomposeFailed').length, 1);
    } finally { h.cleanup(); }
});
