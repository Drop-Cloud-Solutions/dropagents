/**
 * Applying several chat task proposals at once must create several tasks.
 *
 * The chat agent can now propose more than one task in a reply, each with
 * its own Apply button. The operator clicks them in quick succession, so
 * several `CreateTask` commands are in flight at the same time — and that
 * turned out to be broken:
 *
 * `allocateSiblingTaskId` reads the `tasks` PROJECTION to find the highest
 * sibling number, and projections are folded AFTER the handler returns. So
 * every concurrent dispatch saw the same high-water mark, minted the same
 * id, and the events table's `UNIQUE(idempotency_key)` swallowed all but
 * the first as duplicates. Three clicks, three "✓ Applied" chips, one task
 * — measured, not theorised.
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
import { AgentMemoryStore } from '../../core/projects/agent-memory';

import { registerCommandHandlers, Commands, type LifecycleAgentContext } from './handlers';

type TestFn = (name: string, fn: () => void | Promise<void>) => void;

const test: TestFn = (((): TestFn => {
    if (process.env.VITEST) {
        const gt = (globalThis as { test?: TestFn }).test;
        if (typeof gt !== 'function') {
            throw new Error('create-task-concurrency.test.ts: VITEST=true but globalThis.test is missing');
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

function makeHarness(): Harness {
    const db = openDatabase(':memory:');
    applyMigrations(db);
    const logger = new SilentLogger();
    const bus = new EventBus(new EventStore(db), logger);
    const cmdBus = new CommandBus<unknown>(bus, () => undefined);
    const projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'create-task-conc-'));
    let generated = 0;
    const idGen: IdGen = { newId: (): string => `gen-${++generated}` };
    registerCommandHandlers(cmdBus, {
        clock: () => Date.now(),
        idGen,
        logger,
        defaultFlowId: 'echo',
        defaultProjectId: 'proj-test',
        defaultTaskType: 'implement',
        agentRunner: new NoopRunner(),
        registerAgent: () => undefined,
        deferAgentStart: (run): void => run(),
        agentMemory: new AgentMemoryStore(projectsRoot),
        lifecycleAgents: new Map<string, LifecycleAgentContext>(),
        db,
    });
    // The tasks projection, reduced to the one column this cares about.
    // It has to be a real subscriber (folded after the handler returns)
    // or the race under test cannot occur.
    bus.subscribe<{ taskId?: string; planId?: string; type?: string }>(
        'TaskCreated',
        (event) => {
            const p = event.payload;
            if (typeof p.taskId !== 'string' || typeof p.planId !== 'string') return;
            db.prepare(
                'INSERT OR IGNORE INTO tasks(id, plan_id, type, status) VALUES (?,?,?,?)',
            ).run(p.taskId, p.planId, p.type ?? 'implement', 'pending');
        },
        { subscriber: 'test-tasks-projection' },
    );

    db.prepare(
        "INSERT INTO plans(id, project_id, status, created_at) VALUES ('pl-1','proj-test','active',1)",
    ).run();
    // One existing sibling establishes the id prefix the allocator follows.
    db.prepare(
        "INSERT INTO tasks(id, plan_id, type, status) VALUES ('L-ABCD-001','pl-1','implement','pending')",
    ).run();

    return {
        db,
        cmdBus,
        cleanup: (): void => {
            db.close();
            fs.rmSync(projectsRoot, { recursive: true, force: true });
        },
    };
}

function createTask(h: Harness, title: string): Promise<unknown> {
    return h.cmdBus.send({
        type: Commands.CREATE_TASK,
        actor: 'operator',
        issuedAt: Date.now(),
        payload: {
            planId: 'pl-1',
            taskType: 'implement',
            flowId: 'implement',
            title,
            description: `description for ${title}`,
        },
    } as never);
}

function taskIds(db: Db): string[] {
    return (db
        .prepare('SELECT id FROM tasks WHERE plan_id = ? ORDER BY id')
        .all('pl-1') as ReadonlyArray<{ id: string }>).map((r) => r.id);
}

test('three concurrent CreateTask dispatches create THREE tasks', async () => {
    // The exact shape of clicking Apply on three proposal cards.
    const h = makeHarness();
    try {
        await Promise.all([
            createTask(h, 'one'),
            createTask(h, 'two'),
            createTask(h, 'three'),
        ]);

        assert.deepEqual(
            taskIds(h.db),
            ['L-ABCD-001', 'L-ABCD-002', 'L-ABCD-003', 'L-ABCD-004'],
        );
    } finally {
        h.cleanup();
    }
});

test('every concurrently created task gets a DISTINCT id', async () => {
    // Stated separately from the count: a duplicate id is the mechanism,
    // and it could also surface as two tasks sharing one row.
    const h = makeHarness();
    try {
        await Promise.all(
            Array.from({ length: 6 }, (_unused, i) => createTask(h, `task ${i}`)),
        );

        const ids = taskIds(h.db);
        assert.equal(ids.length, 7, 'the seed task plus six new ones');
        assert.equal(new Set(ids).size, ids.length, 'no duplicates');
    } finally {
        h.cleanup();
    }
});

test('sequential creates still number consecutively', async () => {
    // The reservation set must not leave gaps in the ordinary case — the
    // ids are operator-facing.
    const h = makeHarness();
    try {
        await createTask(h, 'one');
        await createTask(h, 'two');

        assert.deepEqual(taskIds(h.db), ['L-ABCD-001', 'L-ABCD-002', 'L-ABCD-003']);
    } finally {
        h.cleanup();
    }
});

test('a later batch continues from the tasks table, not from stale reservations', async () => {
    // The reservation set is retired as the projection catches up. If it
    // were not, a long-lived worker would drift further from the table
    // with every batch.
    const h = makeHarness();
    try {
        await Promise.all([createTask(h, 'a'), createTask(h, 'b')]);
        await Promise.all([createTask(h, 'c'), createTask(h, 'd')]);

        assert.deepEqual(taskIds(h.db), [
            'L-ABCD-001', 'L-ABCD-002', 'L-ABCD-003', 'L-ABCD-004', 'L-ABCD-005',
        ]);
    } finally {
        h.cleanup();
    }
});
