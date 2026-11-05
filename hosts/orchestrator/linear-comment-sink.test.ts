/**
 * Unit tests for AP-IFG-020 — `linear-comment-sink`.
 *
 *   AC #1 — subscribes to all seven lifecycle events.
 *   AC #2 — per-kind comment wording is pinned byte-for-byte (one test
 *           per kind so a drift on any single one fails loudly).
 *   AC #4 — a tracker failure is logged and isolated; the bus offset
 *           still advances so subsequent events keep flowing.
 *   AC #5 — coverage per event kind lives in the per-kind tests below.
 *
 * AC #3 (sink registered during orchestrator startup) is covered by
 * `./main.test.ts` — booting the host advances the sink's offset row.
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
 * file. Vitest v4 forbids `require('vitest')` from CJS (and tsc emits
 * CJS here per the project's tsconfig), so the vitest branch reads the
 * `test` global that `vitest.config.ts` exposes via `globals: true`.
 */
import * as assert from 'node:assert/strict';

import { CommandBus } from '../../core/commands/bus';
import { EventBus } from '../../core/events/bus';
import { EventStore } from '../../core/events/store';
import type { Event } from '../../core/events/event';
import { applyMigrations, openDatabase, type Db } from '../../core/state/migrations';
import type {
    IssueRef,
    IssueSpec,
    IssueTracker,
    Logger,
    ProjectRef,
    ProjectSpec,
} from '../../core/ports';

import {
    ALL_LINEAR_COMMENT_SINK_EVENTS,
    LINEAR_COMMENT_SINK_SUBSCRIBER,
    LinearCommentSinkEvents,
    buildCommentBody,
    registerLinearCommentSink,
    type ExternalRefsReader,
} from './linear-comment-sink';

// ---------------------------------------------------------------------------
// Dual-runner test() shim — see file header for rationale.
// ---------------------------------------------------------------------------

type TestFn = (name: string, fn: () => void | Promise<void>) => void;

const test: TestFn = (((): TestFn => {
    if (process.env.VITEST) {
        const gt = (globalThis as { test?: TestFn }).test;
        if (typeof gt !== 'function') {
            throw new Error(
                'linear-comment-sink.test.ts: VITEST=true but globalThis.test is missing — '
                    + 'ensure vitest.config.ts sets test.globals = true',
            );
        }
        return gt;
    }
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    const nt = require('node:test') as { test: TestFn };
    return nt.test;
})());

// ---------------------------------------------------------------------------
// Test fakes
// ---------------------------------------------------------------------------

class SilentLogger implements Logger {
    readonly warnings: Array<{ message: string; meta?: unknown }> = [];
    info(): void {}
    warn(message: string, meta?: unknown): void {
        this.warnings.push({ message, meta });
    }
    error(): void {}
    debug(): void {}
}

interface CommentCall {
    readonly issueId: string;
    readonly body: string;
}

class RecordingTracker implements IssueTracker {
    readonly comments: CommentCall[] = [];
    private failNext = false;

    failNextComment(): void {
        this.failNext = true;
    }

    async createProject(spec: ProjectSpec): Promise<ProjectRef> {
        return { id: 'project', name: spec.name };
    }
    async createIssue(spec: IssueSpec): Promise<IssueRef> {
        return { id: 'issue', title: spec.title };
    }
    async closeIssue(): Promise<void> {}
    async skipIssue(): Promise<void> {}
    async postCommentToIssue(issueId: string, body: string): Promise<void> {
        if (this.failNext) {
            this.failNext = false;
            throw new Error('simulated tracker outage');
        }
        this.comments.push({ issueId, body });
    }
}

class MapExternalRefs implements ExternalRefsReader {
    constructor(private readonly entries: Record<string, string>) {}
    read(localId: string): string | undefined {
        return this.entries[localId];
    }
}

interface Harness {
    readonly db: Db;
    readonly bus: EventBus;
    readonly tracker: RecordingTracker;
    readonly logger: SilentLogger;
    readonly cleanup: () => void;
    readonly unsubscribe: () => void;
}

function makeHarness(opts: { externalRefs?: Record<string, string> } = {}): Harness {
    const db = openDatabase(':memory:');
    applyMigrations(db);
    const logger = new SilentLogger();
    const store = new EventStore(db);
    const bus = new EventBus(store, logger);
    // Construct a CommandBus only to keep parity with how the bus is
    // typically wired; the sink does not use it.
    new CommandBus<unknown>(bus, () => undefined);
    const tracker = new RecordingTracker();
    const externalRefs = new MapExternalRefs(
        opts.externalRefs ?? { 'task-1': 'linear-issue-1', 'plan-1': 'linear-project-1' },
    );
    const unsubscribe = registerLinearCommentSink({
        bus,
        tracker,
        externalRefs,
        logger,
    });
    return {
        db,
        bus,
        tracker,
        logger,
        unsubscribe,
        cleanup: (): void => {
            unsubscribe();
            db.close();
        },
    };
}

let counter = 0;
async function publish(bus: EventBus, type: string, payload: unknown): Promise<void> {
    counter += 1;
    const event: Event = {
        type,
        v: 1,
        occurredAt: 1_700_000_000_000,
        idempotencyKey: `linear-comment-sink-test:${type}:${counter}`,
        payload,
    };
    await bus.publish(event);
}

// ---------------------------------------------------------------------------
// AC #1 — every supported event type is wired through a single named
//          subscriber so a host restart can replay each kind exactly once.
// ---------------------------------------------------------------------------

test('registers exactly the seven lifecycle event types', () => {
    assert.deepEqual(
        [...ALL_LINEAR_COMMENT_SINK_EVENTS].sort(),
        [
            'CommitReady',
            'ContextUpdated',
            'InvestigationDone',
            'PlanReady',
            'TaskCreated',
            'TaskFailed',
            'TaskFinished',
        ],
    );
});

test('every supported event kind advances the sink subscriber offset', async () => {
    const h = makeHarness();
    try {
        await publish(h.bus, LinearCommentSinkEvents.TASK_CREATED, { taskId: 'task-1' });
        await publish(h.bus, LinearCommentSinkEvents.PLAN_READY, { planId: 'plan-1' });
        await publish(h.bus, LinearCommentSinkEvents.COMMIT_READY, { taskId: 'task-1' });
        await publish(h.bus, LinearCommentSinkEvents.TASK_FINISHED, { taskId: 'task-1' });
        await publish(h.bus, LinearCommentSinkEvents.TASK_FAILED, {
            taskId: 'task-1',
            reason: 'build broke on dotnet restore',
        });
        await publish(h.bus, LinearCommentSinkEvents.CONTEXT_UPDATED, {
            taskId: 'task-1',
            prNumber: 42,
        });
        await publish(h.bus, LinearCommentSinkEvents.INVESTIGATION_DONE, { taskId: 'task-1' });

        const row = h.db
            .prepare('SELECT last_seq FROM subscriber_offsets WHERE subscriber = ?')
            .get(LINEAR_COMMENT_SINK_SUBSCRIBER) as { last_seq: number } | undefined;
        assert.ok(row && row.last_seq > 0, 'sink subscriber must have a persisted offset');
        // One comment per event (taskId is mapped for all of them).
        assert.equal(h.tracker.comments.length, 7);
    } finally {
        h.cleanup();
    }
});

// ---------------------------------------------------------------------------
// AC #2 + AC #5 — per-kind comment wording (byte-for-byte parity)
// ---------------------------------------------------------------------------

test('TaskCreated → "Task created: <taskId>"', () => {
    assert.equal(
        buildCommentBody(LinearCommentSinkEvents.TASK_CREATED, { taskId: 'DRO-101' }),
        'Task created: DRO-101',
    );
});

test('PlanReady → "📋 Plan ready: <planId>" (planId preferred)', () => {
    assert.equal(
        buildCommentBody(LinearCommentSinkEvents.PLAN_READY, {
            planId: 'plan-7',
            taskId: 'DRO-101',
        }),
        '📋 Plan ready: plan-7',
    );
});

test('PlanReady falls back to taskId when planId is absent', () => {
    assert.equal(
        buildCommentBody(LinearCommentSinkEvents.PLAN_READY, { taskId: 'DRO-101' }),
        '📋 Plan ready: DRO-101',
    );
});

test('PlanReady → "📋 Plan ready" when neither identifier is present', () => {
    assert.equal(buildCommentBody(LinearCommentSinkEvents.PLAN_READY, {}), '📋 Plan ready');
});

test('CommitReady → "💾 Commit ready: <taskId>"', () => {
    assert.equal(
        buildCommentBody(LinearCommentSinkEvents.COMMIT_READY, { taskId: 'DRO-102' }),
        '💾 Commit ready: DRO-102',
    );
});

test('TaskFinished → "Task finished: <taskId>" (matches TelegramGateway wording)', () => {
    assert.equal(
        buildCommentBody(LinearCommentSinkEvents.TASK_FINISHED, { taskId: 'DRO-103' }),
        'Task finished: DRO-103',
    );
});

test('TaskFailed with reason → "Task failed: <taskId> — <reason>"', () => {
    assert.equal(
        buildCommentBody(LinearCommentSinkEvents.TASK_FAILED, {
            taskId: 'DRO-103',
            reason: 'build broke on dotnet restore',
        }),
        'Task failed: DRO-103 — build broke on dotnet restore',
    );
});

test('TaskFailed without reason → "Task failed: <taskId>"', () => {
    assert.equal(
        buildCommentBody(LinearCommentSinkEvents.TASK_FAILED, { taskId: 'DRO-103' }),
        'Task failed: DRO-103',
    );
});

test('ContextUpdated with prNumber → "📝 Context updated: <taskId> · PR #<n>"', () => {
    assert.equal(
        buildCommentBody(LinearCommentSinkEvents.CONTEXT_UPDATED, {
            taskId: 'DRO-104',
            prNumber: 42,
        }),
        '📝 Context updated: DRO-104 · PR #42',
    );
});

test('ContextUpdated without prNumber → "📝 Context updated: <taskId>"', () => {
    assert.equal(
        buildCommentBody(LinearCommentSinkEvents.CONTEXT_UPDATED, { taskId: 'DRO-104' }),
        '📝 Context updated: DRO-104',
    );
});

test('InvestigationDone → "🔍 Investigation done: <taskId>"', () => {
    assert.equal(
        buildCommentBody(LinearCommentSinkEvents.INVESTIGATION_DONE, { taskId: 'DRO-105' }),
        '🔍 Investigation done: DRO-105',
    );
});

// ---------------------------------------------------------------------------
// Stable-prefix invariant: every kind's body starts with a deterministic
// leading token (the icon for icon-based kinds, the verb for icon-less
// kinds). The brief calls this prefix the "duplicate-detection" hook; it
// must survive payload variation.
// ---------------------------------------------------------------------------

test('every kind emits a stable leading prefix regardless of payload presence', () => {
    const cases: ReadonlyArray<[string, string]> = [
        [LinearCommentSinkEvents.TASK_CREATED, 'Task created:'],
        [LinearCommentSinkEvents.PLAN_READY, '📋 Plan ready'],
        [LinearCommentSinkEvents.COMMIT_READY, '💾 Commit ready:'],
        [LinearCommentSinkEvents.TASK_FINISHED, 'Task finished:'],
        [LinearCommentSinkEvents.TASK_FAILED, 'Task failed:'],
        [LinearCommentSinkEvents.CONTEXT_UPDATED, '📝 Context updated:'],
        [LinearCommentSinkEvents.INVESTIGATION_DONE, '🔍 Investigation done:'],
    ];
    for (const [type, prefix] of cases) {
        const body = buildCommentBody(
            type as (typeof ALL_LINEAR_COMMENT_SINK_EVENTS)[number],
            { taskId: 'X' },
        );
        assert.ok(
            body.startsWith(prefix),
            `expected "${type}" body "${body}" to start with "${prefix}"`,
        );
    }
});

// ---------------------------------------------------------------------------
// AC #1 — handlers fire end-to-end through the EventBus and translate
//          local→external ids via the supplied ExternalRefsReader.
// ---------------------------------------------------------------------------

test('TaskCreated → tracker.postCommentToIssue with the mapped Linear issue id', async () => {
    const h = makeHarness();
    try {
        await publish(h.bus, LinearCommentSinkEvents.TASK_CREATED, { taskId: 'task-1' });
        assert.deepEqual(h.tracker.comments, [
            { issueId: 'linear-issue-1', body: 'Task created: task-1' },
        ]);
    } finally {
        h.cleanup();
    }
});

test('event for an unmapped local id is silently dropped (no tracker call, no warn)', async () => {
    const h = makeHarness({ externalRefs: {} });
    try {
        await publish(h.bus, LinearCommentSinkEvents.TASK_FINISHED, { taskId: 'task-unmapped' });
        assert.equal(h.tracker.comments.length, 0);
        assert.equal(h.logger.warnings.length, 0);
    } finally {
        h.cleanup();
    }
});

// ---------------------------------------------------------------------------
// AC #4 — a tracker failure is logged but does not propagate. The
//          subscriber's offset still advances so subsequent events flow.
// ---------------------------------------------------------------------------

test('tracker failure is caught, logged, and does not crash subsequent events', async () => {
    const h = makeHarness();
    try {
        h.tracker.failNextComment();
        await publish(h.bus, LinearCommentSinkEvents.TASK_FINISHED, { taskId: 'task-1' });
        // First call threw; a warn line was emitted.
        assert.equal(h.logger.warnings.length, 1);
        assert.match(h.logger.warnings[0].message, /linear-comment-sink/);
        // Second event posts normally.
        await publish(h.bus, LinearCommentSinkEvents.COMMIT_READY, { taskId: 'task-1' });
        assert.deepEqual(h.tracker.comments, [
            { issueId: 'linear-issue-1', body: '💾 Commit ready: task-1' },
        ]);
    } finally {
        h.cleanup();
    }
});
