/**
 * A lifecycle run that fails must SAY SO.
 *
 * Field report: the decomposer started returning "API Error: Opus 5's
 * safeguards flagged this message" on one model while the same plan
 * succeeded on another. On the board that looked like nothing at all —
 * the decomposer card stopped and stayed stopped. The operator's only
 * evidence was one `info` line in worker.log.
 *
 * Three separate places dropped the error on the way out:
 *
 *  1. The stream parser kept only the terminal frame's `subtype`,
 *     discarding its message — so even a correctly-reported API
 *     rejection arrived as the bare string `error_during_execution`.
 *  2. The AgentFinished subscriber treated EVERY non-success outcome the
 *     way it treats an operator interrupt: log, return, emit nothing. No
 *     PlanDecomposeFailed, no plannerError on the card.
 *  3. When the CLI printed `API Error: …` as assistant text and exited 0
 *     the run counted as a success, and the failure surfaced downstream
 *     as "decomposer output contains no JSON object" — true, and useless
 *     for working out what to change.
 *
 * An interrupt is still not a failure: the operator asked for it, and
 * the modal owns the Regenerate decision.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { applyMigrations, openDatabase, type Db } from '../../core/state/migrations';
import { EventStore } from '../../core/events/store';
import { EventBus } from '../../core/events/bus';
import { CommandBus } from '../../core/commands/bus';
import { AgentMemoryStore } from '../../core/projects/agent-memory';
import type { Event } from '../../core/events/event';
import type { AgentHandle, AgentSpec, IdGen, Logger } from '../../core/ports';
import {
    PlanLifecycleAgentEvents,
    registerCommandHandlers,
    registerPlanLifecycleAgentHandlers,
    type LifecycleAgentContext,
} from './handlers';
import {
    PlanLifecycleCommands,
    PlanLifecycleEvents,
    type DecomposePlanPayload,
} from '../../core/commands';

const SILENT: Logger = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
} as unknown as Logger;

class FakeRunner {
    readonly starts: { spec: AgentSpec; handleId: string }[] = [];
    private counter = 0;
    start(spec: AgentSpec): AgentHandle {
        this.counter += 1;
        const id = `agent-${this.counter}`;
        this.starts.push({ spec, handleId: id });
        return { id, spec };
    }
    async interrupt(): Promise<void> { /* unused */ }
}

function makeHarness() {
    const db = openDatabase(':memory:');
    applyMigrations(db);
    const bus = new EventBus(new EventStore(db), SILENT);
    const cmdBus = new CommandBus<unknown>(bus, () => undefined);
    const runner = new FakeRunner();
    const lifecycleAgents = new Map<string, LifecycleAgentContext>();
    const projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-fail-'));
    const memory = new AgentMemoryStore(projectsRoot);
    let n = 0;
    const idGen: IdGen = { newId: (): string => `task-${++n}` };

    const common = {
        clock: () => 1_700_000_000_000,
        logger: SILENT,
        agentRunner: runner as never,
        registerAgent: () => undefined,
        deferAgentStart: (run: () => void): void => run(),
        lifecycleAgents,
        agentMemory: memory,
    };
    registerCommandHandlers(cmdBus, {
        ...common,
        idGen,
        defaultFlowId: 'echo',
        defaultProjectId: 'proj-test',
        defaultTaskType: 'echo',
        db,
    } as never);
    registerPlanLifecycleAgentHandlers(bus, common as never);

    return {
        db,
        bus,
        cmdBus,
        runner,
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

async function spawnDecomposer(h: ReturnType<typeof makeHarness>): Promise<string> {
    await h.cmdBus.send<DecomposePlanPayload>({
        type: PlanLifecycleCommands.DECOMPOSE_PLAN,
        actor: 'op',
        issuedAt: 1,
        payload: {
            planId: 'plan-1',
            projectId: 'proj-test',
            approvedContent: 'body',
            conventions: {},
        },
    });
    const start = h.runner.starts.find((s) => s.spec.role === 'decomposer');
    assert.ok(start, 'a decomposer was spawned');
    return start!.handleId;
}

async function finish(
    bus: EventBus,
    agentId: string,
    payload: Record<string, unknown>,
): Promise<void> {
    const event: Event = {
        type: 'AgentFinished',
        v: 1,
        occurredAt: 1_700_000_000_000,
        idempotencyKey: `test:AgentFinished:${agentId}:${JSON.stringify(payload).length}`,
        payload: { agentId, role: 'decomposer', ...payload },
    };
    await bus.publish(event);
}

function failures(db: Db): { error?: string }[] {
    return readPayloads<{ error?: string }>(
        db,
        PlanLifecycleAgentEvents.PLAN_DECOMPOSE_FAILED,
    );
}

// --- the reported bug -------------------------------------------------

test('a non-success outcome emits PlanDecomposeFailed carrying the API error', async () => {
    // Was: one info line, no event, a card that stops forever.
    const h = makeHarness();
    try {
        const agentId = await spawnDecomposer(h);
        await finish(h.bus, agentId, {
            outcome: 'error_during_execution',
            content: '',
            error: "API Error: Opus 5's safeguards flagged this message",
        });

        const failed = failures(h.db);
        assert.equal(failed.length, 1, 'the failure is on the event log');
        assert.match(failed[0]!.error ?? '', /safeguards flagged/);
    } finally {
        h.cleanup();
    }
});

test('an API error printed as OUTPUT is a failure, not an empty decomposition', async () => {
    // The other shape: the CLI writes the banner as assistant text and
    // exits 0. Downstream this became "decomposer output contains no
    // JSON object", which describes the symptom and hides the cause.
    const h = makeHarness();
    try {
        const agentId = await spawnDecomposer(h);
        await finish(h.bus, agentId, {
            outcome: 'success',
            content: "API Error: 400 Opus 5's safeguards flagged this message",
        });

        const failed = failures(h.db);
        assert.equal(failed.length, 1);
        assert.match(failed[0]!.error ?? '', /API Error: 400/);
        assert.doesNotMatch(failed[0]!.error ?? '', /no JSON object/);
    } finally {
        h.cleanup();
    }
});

test('the failure reason reaches agent memory, so the next run is not blind', async () => {
    const h = makeHarness();
    try {
        const agentId = await spawnDecomposer(h);
        await finish(h.bus, agentId, {
            outcome: 'error_during_execution',
            error: 'API Error: 400 flagged',
        });

        const file = path.join(h.projectsRoot, 'proj-test', 'agent-memory.jsonl');
        assert.match(fs.readFileSync(file, 'utf8'), /API Error: 400 flagged/);
    } finally {
        h.cleanup();
    }
});

// --- an interrupt is NOT a failure ------------------------------------

test('an operator interrupt still emits nothing', async () => {
    // The operator asked for it and the modal owns Regenerate. Reporting
    // it as a failure would put an error on a card the operator just
    // deliberately stopped.
    const h = makeHarness();
    try {
        const agentId = await spawnDecomposer(h);
        await finish(h.bus, agentId, { outcome: 'interrupted', content: 'partial' });

        assert.equal(failures(h.db).length, 0);
    } finally {
        h.cleanup();
    }
});

// --- degrading without a message --------------------------------------

test('a non-success outcome with NO detail still reports, naming the outcome', async () => {
    // The CLI does not always say why. An unhelpful reason beats silence:
    // the card has to stop showing "in progress" either way.
    const h = makeHarness();
    try {
        const agentId = await spawnDecomposer(h);
        await finish(h.bus, agentId, { outcome: 'error_max_turns', content: '' });

        const failed = failures(h.db);
        assert.equal(failed.length, 1);
        assert.match(failed[0]!.error ?? '', /error_max_turns/);
    } finally {
        h.cleanup();
    }
});

test('a successful decomposition is untouched by any of this', async () => {
    // The guard must not fire on ordinary output that happens to discuss
    // errors — only on the CLI's own banner.
    const h = makeHarness();
    try {
        const agentId = await spawnDecomposer(h);
        await finish(h.bus, agentId, {
            outcome: 'success',
            content: JSON.stringify({
                plan: {
                    id: 'plan-1',
                    title: 'T',
                    description: 'Handle the API error path when the upstream returns 400.',
                    tasks: [{
                        id: 'task-001',
                        title: 'Handle 400s',
                        type: 'implement',
                        status: 'pending',
                        dependencies: [],
                        agent: { role: 'developer' },
                        context: { description: 'd', acceptance_criteria: ['a'] },
                    }],
                },
            }),
        });

        assert.equal(failures(h.db).length, 0, 'prose about errors is not an error');
        assert.ok(
            readPayloads(h.db, PlanLifecycleEvents.PLAN_DECOMPOSED).length > 0,
            'the decomposition still landed',
        );
    } finally {
        h.cleanup();
    }
});
