/**
 * `SetPlanRepo` — re-point a plan at a different repo.
 *
 * `sidebar_plans.metadata.targetRepo` picks the git worktree for every task
 * under the plan that carries no repo of its own, so a wrong value sends
 * agents at the wrong codebase. It was only settable through the edit-plan
 * form; the plan modal did not even show it, and the chat agent — often the
 * one who spots the mismatch — had no channel for it at all.
 *
 * The reason this is its own command rather than a plain `UpdatePlan`: the
 * plans projection does `metadata = COALESCE(@metadata, metadata)`, so a
 * supplied blob REPLACES the stored one. A caller sending `{targetRepo}`
 * alone would silently wipe planType, conventions, techStack and the
 * impact-check warnings. These tests pin the merge.
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { CommandBus } from '../../core/commands/bus';
import { EventBus } from '../../core/events/bus';
import { EventStore } from '../../core/events/store';
import { applyMigrations, openDatabase, type Db } from '../../core/state/migrations';
import type { AgentHandle, AgentRunner, AgentSpec, IdGen, Logger } from '../../core/ports';
import { PlanLifecycleCommands } from '../../core/commands';
import { AgentMemoryStore } from '../../core/projects/agent-memory';

import { PlanProjectionStore } from '../../adapters/projections/plan-projection-store';

import { registerCommandHandlers, type LifecycleAgentContext } from './handlers';

type TestFn = (name: string, fn: () => void | Promise<void>) => void;

const test: TestFn = (((): TestFn => {
    if (process.env.VITEST) {
        const gt = (globalThis as { test?: TestFn }).test;
        if (typeof gt !== 'function') {
            throw new Error('set-plan-repo.test.ts: VITEST=true but globalThis.test is missing');
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

class NoopRunner implements AgentRunner {
    start(spec: AgentSpec): AgentHandle {
        return { id: 'agent-1', spec };
    }
    async interrupt(): Promise<void> {}
}

interface Harness {
    readonly db: Db;
    readonly cmdBus: CommandBus<unknown>;
    readonly cleanup: () => void;
}

const CLOCK = 1_700_000_000_000;

function makeHarness(): Harness {
    const db = openDatabase(':memory:');
    applyMigrations(db);
    const logger = new SilentLogger();
    const bus = new EventBus(new EventStore(db), logger);
    const cmdBus = new CommandBus<unknown>(bus, () => undefined);
    const projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'set-plan-repo-'));
    const idGen: IdGen = { newId: (): string => 'task-1' };
    registerCommandHandlers(cmdBus, {
        clock: () => CLOCK,
        idGen,
        logger,
        defaultFlowId: 'echo',
        defaultProjectId: 'proj-test',
        defaultTaskType: 'echo',
        agentRunner: new NoopRunner(),
        registerAgent: () => undefined,
        deferAgentStart: (run): void => run(),
        agentMemory: new AgentMemoryStore(projectsRoot),
        lifecycleAgents: new Map<string, LifecycleAgentContext>(),
        db,
    });
    // The projection is what turns the emitted PlanUpdated into a row —
    // without it these tests would pass against an unchanged table.
    new PlanProjectionStore(db, bus, logger);
    return {
        db,
        cmdBus,
        cleanup: (): void => {
            db.close();
            fs.rmSync(projectsRoot, { recursive: true, force: true });
        },
    };
}

function seedPlan(db: Db, planId: string, metadata: Record<string, unknown>): void {
    db.prepare(
        `INSERT INTO sidebar_plans(plan_id, pid, name, metadata, updated_at)
         VALUES (?, 'proj-test', 'A plan', ?, 1)`,
    ).run(planId, JSON.stringify(metadata));
}

function storedMetadata(db: Db, planId: string): Record<string, unknown> {
    const row = db
        .prepare('SELECT metadata FROM sidebar_plans WHERE plan_id = ?')
        .get(planId) as { metadata: string | null };
    return JSON.parse(row.metadata ?? '{}') as Record<string, unknown>;
}

async function send(h: Harness, planId: string, repoId: string, issuedAt = 1): Promise<void> {
    await h.cmdBus.send({
        type: PlanLifecycleCommands.SET_PLAN_REPO,
        actor: 'operator',
        issuedAt,
        payload: { planId, repoId },
    } as never);
}

test('setting the repo keeps every other metadata key', async () => {
    // The bug this command exists to avoid. planType and conventions are
    // read by the planner; impactWarnings is the post-decompose scan the
    // operator reviews before approving tasks. Losing any of them to a
    // repo change would be silent.
    const h = makeHarness();
    try {
        seedPlan(h.db, 'pl-1', {
            planType: 'feature',
            techStack: 'dotnet10',
            targetRepo: 'shop',
            impactWarnings: ['src/Foo.cs'],
        });

        await send(h, 'pl-1', 'catalog');

        assert.deepEqual(storedMetadata(h.db, 'pl-1'), {
            planType: 'feature',
            techStack: 'dotnet10',
            targetRepo: 'catalog',
            impactWarnings: ['src/Foo.cs'],
        });
    } finally {
        h.cleanup();
    }
});

test('an empty repo id CLEARS the target repo rather than storing an empty string', async () => {
    // "" would satisfy `typeof md.targetRepo === 'string'` in some readers
    // and fail the `.length > 0` check in others — the key has to go.
    const h = makeHarness();
    try {
        seedPlan(h.db, 'pl-2', { planType: 'feature', targetRepo: 'shop' });

        await send(h, 'pl-2', '');

        assert.deepEqual(storedMetadata(h.db, 'pl-2'), { planType: 'feature' });
    } finally {
        h.cleanup();
    }
});

test('a plan with no metadata at all gets a repo without exploding', async () => {
    const h = makeHarness();
    try {
        h.db.prepare(
            `INSERT INTO sidebar_plans(plan_id, pid, name, updated_at)
             VALUES ('pl-3', 'proj-test', 'Bare', 1)`,
        ).run();

        await send(h, 'pl-3', 'catalog');

        assert.deepEqual(storedMetadata(h.db, 'pl-3'), { targetRepo: 'catalog' });
    } finally {
        h.cleanup();
    }
});

test('an unknown plan id is REJECTED, not quietly turned into a no-op event', async () => {
    // A chat agent naming a plan that does not exist, or a stale board tab.
    // A no-op would show a green toast for a change that never happened.
    const h = makeHarness();
    try {
        await assert.rejects(
            () => send(h, 'pl-missing', 'catalog'),
            /unknown plan pl-missing/,
        );
    } finally {
        h.cleanup();
    }
});

test('a second change to the same plan lands instead of de-duping away', async () => {
    // The idempotency key carries issuedAt: without it, correcting a
    // wrong pick would be swallowed by the events table's UNIQUE
    // constraint and the operator would be stuck with the first choice.
    const h = makeHarness();
    try {
        seedPlan(h.db, 'pl-4', {});

        await send(h, 'pl-4', 'catalog', 1);
        await send(h, 'pl-4', 'shop', 2);

        assert.deepEqual(storedMetadata(h.db, 'pl-4'), { targetRepo: 'shop' });
    } finally {
        h.cleanup();
    }
});

test('an invalid payload is rejected', async () => {
    const h = makeHarness();
    try {
        await assert.rejects(
            () => h.cmdBus.send({
                type: PlanLifecycleCommands.SET_PLAN_REPO,
                actor: 'operator',
                issuedAt: 1,
                payload: { planId: 'pl-1' },
            } as never),
            /invalid payload/,
        );
    } finally {
        h.cleanup();
    }
});
