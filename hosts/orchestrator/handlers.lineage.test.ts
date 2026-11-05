/**
 * AP-IFG-001: TaskCreated lineage extension.
 *
 *   1. A fully-populated `TaskCreated` projects each lineage field
 *      verbatim and round-trips through the state-port write path
 *      with byte-identical contents.
 *   2. A legacy `TaskCreated` payload (no lineage fields at all)
 *      projects to documented defaults — `investigation_thread = []`,
 *      `followup_inflight = false`, the three id/reason fields `null`
 *      — and the projection is still safe to write to the state port.
 *   3. The CREATE_TASK handler threads any lineage fields supplied on
 *      the command into the emitted `TaskCreated` event payload, but
 *      omits the keys the caller did not set so legacy events stay
 *      sparse.
 *   4. `UpdateTask` emits a `TaskUpdated` event whose payload is what
 *      `applyTaskUpdated` consumes — mutating `followup_inflight` and
 *      `investigation_thread` without disturbing the immutable
 *      `parent_task_id` / `spawn_reason` / `source_investigation_id`.
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
 * file.
 */
import * as assert from 'node:assert/strict';

import { CommandBus } from '../../core/commands/bus';
import { EventBus } from '../../core/events/bus';
import { EventStore } from '../../core/events/store';
import {
    InMemoryTaskLineageStore,
    type InvestigationThreadEntry,
    type TaskLineage,
} from '../../core/flow/engine';
import { applyMigrations, openDatabase, type Db } from '../../core/state/migrations';
import type { AgentHandle, AgentRunner, AgentSpec, IdGen, Logger } from '../../core/ports';

import {
    Commands,
    Events,
    applyTaskUpdated,
    projectTaskCreated,
    registerCommandHandlers,
    type TaskCreatedPayload,
    type TaskProjection,
    type TaskUpdatedPayload,
    type UpdateTaskPayload,
} from './handlers';

// ---------------------------------------------------------------------------
// Dual-runner test() shim — see file header for rationale.
//
// Vitest v4 forbids `require('vitest')` from CJS modules (see
// node_modules/vitest/index.cjs:1), and tsc compiles this file to CJS
// per the project's tsconfig (`module: CommonJS`). Static `import` from
// 'vitest' therefore also breaks under `node --test`. The workaround is
// to rely on vitest's `globals: true` config (see ../../vitest.config.ts)
// which puts `test` on `globalThis` inside vitest workers; outside
// vitest we fall back to `node:test`'s `test()` via plain `require`.
// ---------------------------------------------------------------------------

type TestFn = (name: string, fn: () => void | Promise<void>) => void;

const test: TestFn = (((): TestFn => {
    if (process.env.VITEST) {
        const gt = (globalThis as { test?: TestFn }).test;
        if (typeof gt !== 'function') {
            throw new Error(
                'lineage.test.ts: VITEST=true but globalThis.test is missing — '
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
    readonly bus: EventBus;
    readonly cmdBus: CommandBus<unknown>;
    readonly cleanup: () => void;
}

function makeHarness(): Harness {
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
        defaultProjectId: 'proj-lineage',
        defaultTaskType: 'echo',
        agentRunner: new StubAgentRunner(),
        registerAgent: (): void => {},
        deferAgentStart: (run): void => run(),
    });

    return {
        db,
        bus,
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

// ---------------------------------------------------------------------------
// AC #1, AC #3 — fully-populated TaskCreated projects + round-trips verbatim
// ---------------------------------------------------------------------------

test('projectTaskCreated preserves every lineage field on a fully-populated payload', () => {
    const thread: InvestigationThreadEntry[] = [
        { role: 'operator', content: 'Why is build failing?', timestamp: 1_700_000_000_001 },
        { role: 'investigator', content: 'Missing dep.', timestamp: 1_700_000_000_002 },
    ];
    const payload: TaskCreatedPayload = {
        taskId: 'task-1',
        planId: 'plan-1',
        type: 'investigate',
        flowId: 'investigation',
        parent_task_id: 'task-0',
        spawn_reason: 'investigation-followup',
        source_investigation_id: 'inv-42',
        investigation_thread: thread,
        followup_inflight: true,
    };

    const projected = projectTaskCreated(payload);

    assert.equal(projected.taskId, 'task-1');
    assert.equal(projected.planId, 'plan-1');
    assert.equal(projected.type, 'investigate');
    assert.equal(projected.flowId, 'investigation');
    assert.equal(projected.parent_task_id, 'task-0');
    assert.equal(projected.spawn_reason, 'investigation-followup');
    assert.equal(projected.source_investigation_id, 'inv-42');
    assert.equal(projected.followup_inflight, true);
    assert.deepEqual(projected.investigation_thread, thread);
});

test('state-port round-trip preserves all five lineage fields verbatim', () => {
    const thread: InvestigationThreadEntry[] = [
        { role: 'operator', content: 'pick a logger', timestamp: 1 },
        { role: 'developer', content: 'pino it is', timestamp: 2 },
    ];
    const payload: TaskCreatedPayload = {
        taskId: 'task-rt',
        planId: 'plan-rt',
        type: 'implement',
        flowId: 'implement',
        parent_task_id: 'task-parent',
        spawn_reason: 'investigation-followup',
        source_investigation_id: 'inv-rt',
        investigation_thread: thread,
        followup_inflight: true,
    };
    const projected = projectTaskCreated(payload);

    const store = new InMemoryTaskLineageStore();
    const lineage: TaskLineage = {
        parent_task_id: projected.parent_task_id,
        spawn_reason: projected.spawn_reason,
        source_investigation_id: projected.source_investigation_id,
        investigation_thread: projected.investigation_thread,
        followup_inflight: projected.followup_inflight,
    };
    store.write('task-rt', lineage);

    const loaded = store.read('task-rt');
    assert.ok(loaded, 'lineage row must load back');
    assert.equal(loaded!.parent_task_id, 'task-parent');
    assert.equal(loaded!.spawn_reason, 'investigation-followup');
    assert.equal(loaded!.source_investigation_id, 'inv-rt');
    assert.equal(loaded!.followup_inflight, true);
    assert.deepEqual(loaded!.investigation_thread, thread);

    // The store deep-copies the thread on write, so a mutation to the
    // caller's array MUST NOT leak into the loaded record. This pins the
    // "verbatim" guarantee against accidental aliasing.
    thread.push({ role: 'noise', content: 'mutated after write', timestamp: 99 });
    const loadedAgain = store.read('task-rt');
    assert.equal(
        loadedAgain!.investigation_thread.length,
        2,
        'state-port read must remain pinned to the values present at write time',
    );
});

// ---------------------------------------------------------------------------
// AC #2 — legacy TaskCreated payload (no lineage fields) defaults safely
// ---------------------------------------------------------------------------

test('projectTaskCreated defaults every lineage field on a legacy payload', () => {
    const legacy: TaskCreatedPayload = {
        taskId: 'task-legacy',
        planId: 'plan-legacy',
        type: 'echo',
        flowId: 'echo',
    };

    const projected = projectTaskCreated(legacy);

    assert.equal(projected.parent_task_id, null);
    assert.equal(projected.spawn_reason, null);
    assert.equal(projected.source_investigation_id, null);
    assert.equal(projected.followup_inflight, false);
    assert.deepEqual(projected.investigation_thread, []);
});

test('legacy projection writes through the state port without losing the documented defaults', () => {
    const legacy: TaskCreatedPayload = {
        taskId: 'task-legacy-rt',
        planId: 'plan-legacy',
        type: 'echo',
        flowId: 'echo',
    };
    const projected: TaskProjection = projectTaskCreated(legacy);

    const store = new InMemoryTaskLineageStore();
    store.write('task-legacy-rt', {
        parent_task_id: projected.parent_task_id,
        spawn_reason: projected.spawn_reason,
        source_investigation_id: projected.source_investigation_id,
        investigation_thread: projected.investigation_thread,
        followup_inflight: projected.followup_inflight,
    });

    const loaded = store.read('task-legacy-rt');
    assert.ok(loaded);
    assert.equal(loaded!.parent_task_id, null);
    assert.equal(loaded!.spawn_reason, null);
    assert.equal(loaded!.source_investigation_id, null);
    assert.equal(loaded!.followup_inflight, false);
    assert.deepEqual(loaded!.investigation_thread, []);
});

// ---------------------------------------------------------------------------
// CREATE_TASK handler threads lineage through; legacy command emits sparse
// ---------------------------------------------------------------------------

test('CREATE_TASK with lineage emits a TaskCreated event carrying every lineage field', async () => {
    const h = makeHarness();
    try {
        const thread: InvestigationThreadEntry[] = [
            { role: 'operator', content: 'kick off followup', timestamp: 1 },
        ];
        await h.cmdBus.send({
            type: Commands.CREATE_TASK,
            actor: 'op',
            issuedAt: 1,
            payload: {
                planId: 'plan-x',
                taskType: 'investigate',
                flowId: 'investigation',
                parent_task_id: 'task-parent',
                spawn_reason: 'investigation-followup',
                source_investigation_id: 'inv-77',
                investigation_thread: thread,
                followup_inflight: true,
            },
        });

        const payload = readEventPayload<TaskCreatedPayload>(h.db, Events.TASK_CREATED);
        assert.equal(payload.planId, 'plan-x');
        assert.equal(payload.type, 'investigate');
        assert.equal(payload.flowId, 'investigation');
        assert.equal(payload.parent_task_id, 'task-parent');
        assert.equal(payload.spawn_reason, 'investigation-followup');
        assert.equal(payload.source_investigation_id, 'inv-77');
        assert.equal(payload.followup_inflight, true);
        assert.deepEqual(payload.investigation_thread, thread);
    } finally {
        h.cleanup();
    }
});

test('CREATE_TASK without lineage emits a sparse TaskCreated payload (legacy shape)', async () => {
    const h = makeHarness();
    try {
        await h.cmdBus.send({
            type: Commands.CREATE_TASK,
            actor: 'op',
            issuedAt: 1,
            payload: { planId: 'plan-old' },
        });

        const payload = readEventPayload<TaskCreatedPayload>(h.db, Events.TASK_CREATED);
        assert.equal(payload.planId, 'plan-old');
        // Lineage keys MUST NOT appear on a legacy payload — keeping the
        // event log sparse means old TaskCreated rows persisted before
        // AP-IFG-001 stay byte-identical to ones emitted today.
        assert.equal('parent_task_id' in payload, false);
        assert.equal('spawn_reason' in payload, false);
        assert.equal('source_investigation_id' in payload, false);
        assert.equal('investigation_thread' in payload, false);
        assert.equal('followup_inflight' in payload, false);

        // The projection still produces defaults so the read side stays
        // uniform between legacy and new events.
        const projected = projectTaskCreated(payload);
        assert.deepEqual(projected.investigation_thread, []);
        assert.equal(projected.followup_inflight, false);
    } finally {
        h.cleanup();
    }
});

// ---------------------------------------------------------------------------
// UPDATE_TASK mutates only followup_inflight + investigation_thread
// ---------------------------------------------------------------------------

test('UPDATE_TASK emits TaskUpdated and applyTaskUpdated mutates only the two non-immutable fields', async () => {
    const h = makeHarness();
    try {
        // Seed projection from a fully-populated TaskCreated so we can
        // assert the parent/spawn/source ids are untouched after update.
        const seed: TaskCreatedPayload = {
            taskId: 'T-mut',
            planId: 'plan-mut',
            type: 'investigate',
            flowId: 'investigation',
            parent_task_id: 'T-root',
            spawn_reason: 'investigation-followup',
            source_investigation_id: 'inv-mut',
            investigation_thread: [
                { role: 'operator', content: 'q1', timestamp: 1 },
            ],
            followup_inflight: false,
        };
        const projection = projectTaskCreated(seed);

        const newThread: InvestigationThreadEntry[] = [
            { role: 'operator', content: 'q1', timestamp: 1 },
            { role: 'investigator', content: 'a1', timestamp: 2 },
        ];
        await h.cmdBus.send<UpdateTaskPayload>({
            type: Commands.UPDATE_TASK,
            actor: 'op',
            issuedAt: 7,
            payload: {
                taskId: 'T-mut',
                investigation_thread: newThread,
                followup_inflight: true,
            },
        });

        const updated = readEventPayload<TaskUpdatedPayload>(h.db, Events.TASK_UPDATED);
        assert.equal(updated.taskId, 'T-mut');
        assert.equal(updated.followup_inflight, true);
        assert.deepEqual(updated.investigation_thread, newThread);

        const after = applyTaskUpdated(projection, updated);
        // Immutable fields preserved.
        assert.equal(after.parent_task_id, 'T-root');
        assert.equal(after.spawn_reason, 'investigation-followup');
        assert.equal(after.source_investigation_id, 'inv-mut');
        // Mutated fields applied.
        assert.equal(after.followup_inflight, true);
        assert.deepEqual(after.investigation_thread, newThread);
    } finally {
        h.cleanup();
    }
});

test('applyTaskUpdated leaves untouched fields alone (partial mutation)', () => {
    const projection: TaskProjection = projectTaskCreated({
        taskId: 'T-partial',
        planId: 'plan',
        type: 'investigate',
        flowId: 'investigation',
        parent_task_id: 'T-root',
        spawn_reason: 'investigation-followup',
        source_investigation_id: 'inv-1',
        investigation_thread: [
            { role: 'operator', content: 'kick off', timestamp: 1 },
        ],
        followup_inflight: true,
    });

    // Only flip followup_inflight; the thread must survive verbatim.
    const after = applyTaskUpdated(projection, {
        taskId: 'T-partial',
        followup_inflight: false,
    });
    assert.equal(after.followup_inflight, false);
    assert.deepEqual(after.investigation_thread, projection.investigation_thread);

    // Only replace the thread; followup_inflight must survive.
    const moreThread: InvestigationThreadEntry[] = [
        ...projection.investigation_thread,
        { role: 'developer', content: 'on it', timestamp: 5 },
    ];
    const after2 = applyTaskUpdated(after, {
        taskId: 'T-partial',
        investigation_thread: moreThread,
    });
    assert.equal(after2.followup_inflight, false);
    assert.deepEqual(after2.investigation_thread, moreThread);
});

test('UPDATE_TASK rejects payloads without a taskId', async () => {
    const h = makeHarness();
    try {
        await assert.rejects(
            h.cmdBus.send({
                type: Commands.UPDATE_TASK,
                actor: 'op',
                issuedAt: 1,
                payload: { taskId: '' },
            }),
            /UpdateTask: payload.taskId is required/,
        );
    } finally {
        h.cleanup();
    }
});

test('InMemoryTaskLineageStore.update mutates only the two non-immutable fields', () => {
    const store = new InMemoryTaskLineageStore();
    store.write('T1', {
        parent_task_id: 'P1',
        spawn_reason: 'investigation-followup',
        source_investigation_id: 'I1',
        investigation_thread: [{ role: 'operator', content: 'go', timestamp: 1 }],
        followup_inflight: false,
    });

    const next = store.update('T1', { followup_inflight: true });
    assert.equal(next.parent_task_id, 'P1');
    assert.equal(next.spawn_reason, 'investigation-followup');
    assert.equal(next.source_investigation_id, 'I1');
    assert.equal(next.followup_inflight, true);
    assert.equal(next.investigation_thread.length, 1);

    assert.throws(
        () => store.update('missing', { followup_inflight: true }),
        /no record for task "missing"/,
    );
});
