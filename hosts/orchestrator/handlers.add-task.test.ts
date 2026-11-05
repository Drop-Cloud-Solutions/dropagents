/**
 * Operator "Add task" — CreateTask carrying operator-authored fields.
 *
 *   1. `title` / `description` / `repoId` / `dependencies` supplied on the
 *      command ride the emitted `TaskCreated` payload verbatim, so the
 *      existing folds pick them up (tasks projection, TaskCreated
 *      dependency bridge, per-task worktree resolution).
 *   2. A command without those fields emits a sparse payload — none of
 *      the keys appear, keeping decomposer-era and operator-era events
 *      distinguishable in the log.
 *   3. Task-id allocation continues the plan's sibling numbering
 *      (`L-IAED-001..003` → `L-IAED-004`) when a `db` seam is wired,
 *      skips ids that already exist, and falls back to `idGen.newId()`
 *      when the plan has no numbered siblings.
 *
 * Dual-runner shim: same rationale as handlers.lineage.test.ts — vitest
 * discovers via globals, `node --test` via require('node:test').
 */
import * as assert from 'node:assert/strict';

import { CommandBus } from '../../core/commands/bus';
import { EventBus } from '../../core/events/bus';
import { EventStore } from '../../core/events/store';
import { applyMigrations, openDatabase, type Db } from '../../core/state/migrations';
import type { AgentHandle, AgentRunner, AgentSpec, IdGen, Logger } from '../../core/ports';

import {
    Commands,
    Events,
    registerCommandHandlers,
    type TaskCreatedPayload,
} from './handlers';

type TestFn = (name: string, fn: () => void | Promise<void>) => void;

const test: TestFn = (((): TestFn => {
    if (process.env.VITEST) {
        const gt = (globalThis as { test?: TestFn }).test;
        if (typeof gt !== 'function') {
            throw new Error(
                'add-task.test.ts: VITEST=true but globalThis.test is missing — '
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

class StubAgentRunner implements AgentRunner {
    private counter = 0;
    start(spec: AgentSpec): AgentHandle {
        this.counter += 1;
        return { id: `agent-${this.counter}`, spec };
    }
    async interrupt(): Promise<void> {}
}

interface Harness {
    readonly db: Db;
    readonly cmdBus: CommandBus<unknown>;
    readonly cleanup: () => void;
}

function makeHarness(opts?: { withDb?: boolean }): Harness {
    const db = openDatabase(':memory:');
    applyMigrations(db);
    const logger = new SilentLogger();
    const store = new EventStore(db);
    const bus = new EventBus(store, logger);
    const cmdBus = new CommandBus<unknown>(bus, () => undefined);
    const idGen: IdGen = ((): IdGen => {
        let n = 0;
        return { newId: (): string => `task-${++n}` };
    })();

    registerCommandHandlers(cmdBus, {
        clock: () => 1_700_000_000_000,
        idGen,
        logger,
        defaultFlowId: 'echo',
        defaultProjectId: 'proj-add-task',
        defaultTaskType: 'echo',
        agentRunner: new StubAgentRunner(),
        registerAgent: (): void => {},
        deferAgentStart: (run): void => run(),
        ...(opts?.withDb ? { db } : {}),
    });

    return {
        db,
        cmdBus,
        cleanup: (): void => {
            db.close();
        },
    };
}

function readEventPayload<T>(db: Db, type: string): T {
    const row = db
        .prepare('SELECT payload FROM events WHERE type = ? ORDER BY seq DESC LIMIT 1')
        .get(type) as { payload: string } | undefined;
    assert.ok(row, `no event of type "${type}" persisted`);
    return JSON.parse(row!.payload) as T;
}

function seedTask(db: Db, id: string, planId: string): void {
    db.prepare(
        `INSERT INTO tasks(id, plan_id, type, status, flow_id)
         VALUES (?, ?, 'implement', 'done', 'implement')`,
    ).run(id, planId);
}

test('CREATE_TASK threads title/description/repoId/dependencies onto TaskCreated', async () => {
    const h = makeHarness();
    try {
        await h.cmdBus.send({
            type: Commands.CREATE_TASK,
            actor: 'operator',
            issuedAt: 1,
            payload: {
                planId: 'plan-op',
                taskType: 'implement',
                flowId: 'implement',
                title: '  Handle missing price rows  ',
                description: 'The importer crashes when a price row is absent.',
                repoId: 'prices',
                dependencies: ['L-XX-001', 'L-XX-002'],
            },
        });

        const payload = readEventPayload<TaskCreatedPayload & {
            title?: string;
            description?: string;
            repoId?: string;
            dependencies?: string[];
        }>(h.db, Events.TASK_CREATED);
        assert.equal(payload.planId, 'plan-op');
        assert.equal(payload.type, 'implement');
        assert.equal(payload.flowId, 'implement');
        assert.equal(payload.title, 'Handle missing price rows');
        assert.equal(payload.description, 'The importer crashes when a price row is absent.');
        assert.equal(payload.repoId, 'prices');
        assert.deepEqual(payload.dependencies, ['L-XX-001', 'L-XX-002']);
    } finally {
        h.cleanup();
    }
});

test('CREATE_TASK without operator fields emits a sparse payload', async () => {
    const h = makeHarness();
    try {
        await h.cmdBus.send({
            type: Commands.CREATE_TASK,
            actor: 'operator',
            issuedAt: 1,
            payload: { planId: 'plan-sparse' },
        });

        const payload = readEventPayload<TaskCreatedPayload>(h.db, Events.TASK_CREATED);
        assert.equal('title' in payload, false);
        assert.equal('description' in payload, false);
        assert.equal('repoId' in payload, false);
        assert.equal('dependencies' in payload, false);
    } finally {
        h.cleanup();
    }
});

test('CREATE_TASK continues the plan sibling numbering when a db is wired', async () => {
    const h = makeHarness({ withDb: true });
    try {
        seedTask(h.db, 'L-IAED-001', 'plan-sib');
        seedTask(h.db, 'L-IAED-002', 'plan-sib');
        seedTask(h.db, 'L-IAED-003', 'plan-sib');
        // A stray non-numbered id must not derail the vote.
        seedTask(h.db, 'task-manual', 'plan-sib');

        await h.cmdBus.send({
            type: Commands.CREATE_TASK,
            actor: 'operator',
            issuedAt: 1,
            payload: { planId: 'plan-sib', taskType: 'implement', flowId: 'implement' },
        });

        const payload = readEventPayload<TaskCreatedPayload>(h.db, Events.TASK_CREATED);
        assert.equal(payload.taskId, 'L-IAED-004');
    } finally {
        h.cleanup();
    }
});

test('CREATE_TASK sibling numbering skips ids already taken in other plans', async () => {
    const h = makeHarness({ withDb: true });
    try {
        seedTask(h.db, 'L-SIB-001', 'plan-a');
        // The natural next id for plan-a is L-SIB-002, but another plan
        // already claimed it — ids are global (worktree paths, routes).
        seedTask(h.db, 'L-SIB-002', 'plan-other');

        await h.cmdBus.send({
            type: Commands.CREATE_TASK,
            actor: 'operator',
            issuedAt: 1,
            payload: { planId: 'plan-a', taskType: 'implement', flowId: 'implement' },
        });

        const payload = readEventPayload<TaskCreatedPayload>(h.db, Events.TASK_CREATED);
        assert.equal(payload.taskId, 'L-SIB-003');
    } finally {
        h.cleanup();
    }
});

test('CREATE_TASK falls back to idGen when the plan has no numbered siblings', async () => {
    const h = makeHarness({ withDb: true });
    try {
        await h.cmdBus.send({
            type: Commands.CREATE_TASK,
            actor: 'operator',
            issuedAt: 1,
            payload: { planId: 'plan-empty' },
        });

        const payload = readEventPayload<TaskCreatedPayload>(h.db, Events.TASK_CREATED);
        assert.equal(payload.taskId, 'task-1');
    } finally {
        h.cleanup();
    }
});
