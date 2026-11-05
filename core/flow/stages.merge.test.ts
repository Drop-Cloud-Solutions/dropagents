/**
 * AP-IFG-005: lifecycle stage tests for merge and worktree-diff-review.
 *
 * Both flows are loaded from their YAML at config/flows/, so this test
 * exercises the loader, the registered stage handlers in `engine.ts`,
 * and the corresponding emit: terminals end-to-end:
 *
 *   merge                  — TaskCreated parks the task (TaskParked,
 *                            reason wait-action) at the `merge-approval`
 *                            step. A subsequent TaskResumed drives
 *                            on_success → emit `MergeReady`.
 *   worktree-diff-review   — TaskCreated parks the task (TaskParked,
 *                            reason wait-action) at the
 *                            `worktree-diff-review` step so the board
 *                            can render the diff. TaskResumed drives
 *                            on_success → emit `WorktreeDiffApproved`.
 *
 * Dual-runner discovery
 * ---------------------
 * Mirrors the shim used by stages.lifecycle.test.ts so the file is
 * discoverable by both `node --test` (the repo's `npm test`) and vitest
 * (the review pipeline). See engine.start-mode.test.ts header for the
 * rationale.
 */

import * as assert from 'node:assert/strict';
import * as path from 'path';

import { openDatabase, applyMigrations, type Db } from '../state/migrations';
import { EventStore } from '../events/store';
import { EventBus } from '../events/bus';
import { CommandBus } from '../commands/bus';
import type { Command } from '../commands/command';
import type { Event, StoredEvent } from '../events/event';
import type { Logger } from '../ports/Logger';
import { loadFlow } from './loader';
import type { FlowDefinition } from './types';
import {
    FlowEngine,
    FlowEvents,
    FlowCommands,
    LifecycleEvents,
    LIFECYCLE_STEP_KINDS,
    type MergeReadyEventPayload,
} from './engine';
import { TaskParkingEvents } from '../commands';
import type { TaskParkedEventPayload } from '../commands';

// ---------------------------------------------------------------------------
// Dual-runner test() shim
// ---------------------------------------------------------------------------

type TestFn = (name: string, fn: () => void | Promise<void>) => void;

const test: TestFn = (((): TestFn => {
    if (process.env.VITEST) {
        const gt = (globalThis as { test?: TestFn }).test;
        if (typeof gt !== 'function') {
            throw new Error(
                'stages.merge.test.ts: VITEST=true but globalThis.test is missing — '
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
// Fixtures
// ---------------------------------------------------------------------------

const FLOWS_DIR = path.join(__dirname, '..', '..', 'config', 'flows');
const MERGE_FLOW_ID = 'merge';
const WORKTREE_DIFF_REVIEW_FLOW_ID = 'worktree-diff-review';
const WORKTREE_DIFF_APPROVED_EVENT = 'WorktreeDiffApproved';

class SilentLogger implements Logger {
    info(): void {}
    warn(): void {}
    error(): void {}
    debug(): void {}
}

function freshDb(): Db {
    const db = openDatabase(':memory:');
    applyMigrations(db);
    return db;
}

let evCounter = 0;
function makeEvent(type: string, payload: unknown): Event {
    evCounter++;
    return {
        type,
        v: 1,
        occurredAt: 1_700_000_000_000,
        idempotencyKey: `mg-${process.pid}-${evCounter}`,
        payload,
    };
}

function seedTask(db: Db, taskId: string): void {
    const planId = `plan-${taskId}`;
    db.prepare(
        'INSERT INTO plans(id, project_id, status, created_at) VALUES (?, ?, ?, ?)',
    ).run(planId, 'proj-merge', 'approved', 1_700_000_000_000);
    db.prepare(
        'INSERT INTO tasks(id, plan_id, type, status) VALUES (?, ?, ?, ?)',
    ).run(taskId, planId, 'feature', 'created');
}

interface Harness {
    db: Db;
    bus: EventBus;
    commands: Command[];
    engine: FlowEngine;
}

function recorder(commands: Command[]): (cmd: Command) => Promise<Event[]> {
    return async (cmd) => {
        commands.push(cmd);
        return [];
    };
}

function makeHarness(flows: ReadonlyMap<string, FlowDefinition>): Harness {
    const db = freshDb();
    const logger = new SilentLogger();
    const store = new EventStore(db);
    const bus = new EventBus(store, logger);
    const cmdBus = new CommandBus<unknown>(bus, () => undefined);
    const commands: Command[] = [];
    cmdBus.register(FlowCommands.START_AGENT, recorder(commands));
    cmdBus.register(FlowCommands.FINISH_TASK, recorder(commands));
    cmdBus.register(FlowCommands.FAIL_TASK, recorder(commands));
    cmdBus.register(FlowCommands.REQUEST_INVESTIGATION, recorder(commands));
    const engine = FlowEngine.start(bus, cmdBus, flows, { db, logger });
    return { db, bus, commands, engine };
}

// ---------------------------------------------------------------------------
// 1. YAML shape — both flows load and have the expected structure
// ---------------------------------------------------------------------------

test('merge.yaml: start_mode auto, single merge-approval step emitting MergeReady', () => {
    const flow = loadFlow(path.join(FLOWS_DIR, 'merge.yaml'));
    assert.equal(flow.start_mode, 'auto');
    assert.equal(flow.on, 'TaskCreated');
    assert.equal(flow.steps.length, 1);
    assert.equal(flow.steps[0].agent, LIFECYCLE_STEP_KINDS.MERGE_APPROVAL);
    assert.equal(flow.steps[0].on_success, `emit:${LifecycleEvents.MERGE_READY}`);
});

test('worktree-diff-review.yaml: start_mode auto, single review step emitting WorktreeDiffApproved', () => {
    const flow = loadFlow(path.join(FLOWS_DIR, 'worktree-diff-review.yaml'));
    assert.equal(flow.start_mode, 'auto');
    assert.equal(flow.on, 'TaskCreated');
    assert.equal(flow.steps.length, 1);
    assert.equal(flow.steps[0].agent, LIFECYCLE_STEP_KINDS.WORKTREE_DIFF_REVIEW);
    assert.equal(flow.steps[0].on_success, `emit:${WORKTREE_DIFF_APPROVED_EVENT}`);
});

// ---------------------------------------------------------------------------
// 2. merge: TaskCreated parks, TaskResumed emits MergeReady
// ---------------------------------------------------------------------------

/**
 * Build a FlowDefinition keyed off `base` but with the merge-approval
 * step's `params` replaced. Hosts that template merge.yaml per task
 * follow this same shape — the engine reads prNumber/repoPath from the
 * step params at resume time, so a per-task override at registration
 * carries the right values onto the emitted MergeReady.
 */
function withMergeApprovalParams(
    base: FlowDefinition,
    params: { prNumber: number; repoPath: string },
): FlowDefinition {
    return {
        ...base,
        steps: base.steps.map((s, i) =>
            i === 0 ? { ...s, params: { ...(s.params ?? {}), ...params } } : s,
        ),
    };
}

test('merge flow: TaskCreated parks the task; TaskResumed emits MergeReady', async () => {
    const loaded = loadFlow(path.join(FLOWS_DIR, 'merge.yaml'));
    const flow = withMergeApprovalParams(loaded, {
        prNumber: 42,
        repoPath: '/work/repo-merge',
    });
    const flows = new Map<string, FlowDefinition>([[MERGE_FLOW_ID, flow]]);
    const { db, bus, commands, engine } = makeHarness(flows);
    try {
        seedTask(db, 'task-MG');

        const parked: StoredEvent[] = [];
        bus.subscribe<TaskParkedEventPayload>(TaskParkingEvents.TASK_PARKED, (e) => {
            parked.push(e);
        });
        const mergeReady: StoredEvent[] = [];
        bus.subscribe<MergeReadyEventPayload>(LifecycleEvents.MERGE_READY, (e) => {
            mergeReady.push(e);
        });

        await bus.publish(
            makeEvent(FlowEvents.TASK_CREATED, {
                taskId: 'task-MG',
                flowId: MERGE_FLOW_ID,
            }),
        );

        // Stage parked the task — no StartAgent, no MergeReady yet.
        const starts = commands.filter((c) => c.type === FlowCommands.START_AGENT);
        assert.equal(starts.length, 0, 'merge-approval is not an agent step');
        assert.equal(parked.length, 1, 'TaskParked must be published on entry');
        const parkedPayload = parked[0].payload as TaskParkedEventPayload;
        assert.equal(parkedPayload.taskId, 'task-MG');
        assert.equal(parkedPayload.stepId, flow.steps[0].id);
        assert.equal(parkedPayload.reason, 'wait-action');
        assert.equal(mergeReady.length, 0, 'MergeReady must not fire before resume');

        // flow_state captures the parked step.
        const fsRow = db
            .prepare('SELECT current_step FROM flow_state WHERE task_id = ?')
            .get('task-MG') as { current_step: string } | undefined;
        assert.equal(fsRow?.current_step, flow.steps[0].id);

        // Operator resumes — engine chains through on_success and emits
        // with prNumber + repoPath sourced from the step params.
        await bus.publish(
            makeEvent(TaskParkingEvents.TASK_RESUMED, {
                taskId: 'task-MG',
                actor: 'operator-1',
            }),
        );

        assert.equal(mergeReady.length, 1, 'MergeReady must be emitted on resume');
        const mergePayload = mergeReady[0].payload as MergeReadyEventPayload;
        assert.equal(mergePayload.taskId, 'task-MG');
        assert.equal(mergePayload.prNumber, 42);
        assert.equal(mergePayload.repoPath, '/work/repo-merge');

        engine.stop();
    } finally {
        db.close();
    }
});

// ---------------------------------------------------------------------------
// 3. worktree-diff-review: TaskCreated parks, TaskResumed emits
//    WorktreeDiffApproved
// ---------------------------------------------------------------------------

test('worktree-diff-review flow: TaskCreated parks the task; TaskResumed emits WorktreeDiffApproved', async () => {
    const flow = loadFlow(path.join(FLOWS_DIR, 'worktree-diff-review.yaml'));
    const flows = new Map<string, FlowDefinition>([
        [WORKTREE_DIFF_REVIEW_FLOW_ID, flow],
    ]);
    const { db, bus, commands, engine } = makeHarness(flows);
    try {
        seedTask(db, 'task-WD');

        const parked: StoredEvent[] = [];
        bus.subscribe<TaskParkedEventPayload>(TaskParkingEvents.TASK_PARKED, (e) => {
            parked.push(e);
        });
        const approved: StoredEvent[] = [];
        bus.subscribe(WORKTREE_DIFF_APPROVED_EVENT, (e) => {
            approved.push(e);
        });

        await bus.publish(
            makeEvent(FlowEvents.TASK_CREATED, {
                taskId: 'task-WD',
                flowId: WORKTREE_DIFF_REVIEW_FLOW_ID,
            }),
        );

        // Stage parked the task — board subscribes to TaskParked to render
        // the diff snapshot. No StartAgent, no approval event yet.
        const starts = commands.filter((c) => c.type === FlowCommands.START_AGENT);
        assert.equal(starts.length, 0, 'worktree-diff-review is not an agent step');
        assert.equal(parked.length, 1, 'TaskParked must be published on entry');
        const parkedPayload = parked[0].payload as TaskParkedEventPayload;
        assert.equal(parkedPayload.taskId, 'task-WD');
        assert.equal(parkedPayload.stepId, flow.steps[0].id);
        // worktree-diff-review carries its own reason discriminator so
        // the board can render the dedicated review modal — the other
        // lifecycle parking steps still emit 'wait-action'.
        assert.equal(parkedPayload.reason, 'worktree-diff-review');
        assert.equal(
            approved.length,
            0,
            'WorktreeDiffApproved must not fire before resume',
        );

        const fsRow = db
            .prepare('SELECT current_step FROM flow_state WHERE task_id = ?')
            .get('task-WD') as { current_step: string } | undefined;
        assert.equal(fsRow?.current_step, flow.steps[0].id);

        await bus.publish(
            makeEvent(TaskParkingEvents.TASK_RESUMED, {
                taskId: 'task-WD',
                actor: 'operator-2',
            }),
        );

        assert.equal(
            approved.length,
            1,
            'WorktreeDiffApproved must be emitted on resume',
        );
        assert.deepEqual(approved[0].payload, { taskId: 'task-WD' });

        engine.stop();
    } finally {
        db.close();
    }
});

// ---------------------------------------------------------------------------
// 3b. worktree-diff-review reject: TaskResumed{decision:reject, feedback}
//     follows on_failure with the operator's feedback threaded onto the
//     next StartAgent's rejectFeedback. This is the pre-commit human-review
//     gate (config/flows/implement.yaml `human-review` step).
// ---------------------------------------------------------------------------

test(
    'worktree-diff-review reject: TaskResumed{decision:reject, feedback} follows on_failure with feedback threaded',
    async () => {
        // Inline flow with worktree-diff-review → on_failure: dev so a
        // reject hits a real developer step and the recorded StartAgent
        // command carries the operator's feedback.
        const flowId = 'human-review-reject-test';
        const flow: FlowDefinition = {
            on: 'TaskCreated',
            start_mode: 'auto',
            steps: [
                {
                    id: 'human-review',
                    agent: LIFECYCLE_STEP_KINDS.WORKTREE_DIFF_REVIEW,
                    model: 'none',
                    on_success: 'commit',
                    on_failure: 'dev',
                },
                {
                    id: 'dev',
                    agent: 'developer',
                    model: 'claude-opus-4-7',
                    on_success: 'commit',
                },
                {
                    id: 'commit',
                    agent: 'committer',
                    model: 'claude-haiku-4-5',
                    on_success: 'emit:TaskFinished',
                },
            ],
        };
        const flows = new Map<string, FlowDefinition>([[flowId, flow]]);
        const { db, bus, commands, engine } = makeHarness(flows);
        try {
            seedTask(db, 'task-HR');
            await bus.publish(
                makeEvent(FlowEvents.TASK_CREATED, {
                    taskId: 'task-HR',
                    flowId,
                }),
            );

            // Engine should have parked at human-review; no agent
            // spawn yet, no commit.
            assert.equal(
                commands.filter((c) => c.type === FlowCommands.START_AGENT).length,
                0,
            );

            await bus.publish(
                makeEvent(TaskParkingEvents.TASK_RESUMED, {
                    taskId: 'task-HR',
                    actor: 'operator-3',
                    decision: 'reject',
                    feedback: 'please rename _roleIdFilter to roleIdQuery',
                }),
            );

            // The engine should have routed through on_failure → dev,
            // spawning the developer agent with rejectFeedback in the
            // command payload.
            const starts = commands.filter(
                (c) => c.type === FlowCommands.START_AGENT,
            );
            assert.equal(starts.length, 1, 'developer must be spawned on reject');
            const payload = starts[0].payload as {
                taskId: string;
                stepId?: string;
                context?: { rejectFeedback?: string };
            };
            assert.equal(payload.taskId, 'task-HR');
            assert.equal(payload.stepId, 'dev');
            assert.equal(
                payload.context?.rejectFeedback,
                'please rename _roleIdFilter to roleIdQuery',
            );

            // The feedback must ALSO persist to tasks.feedback — the
            // prompt builder's fallback reads that column for every later
            // step (reviewer/tester re-runs), not just the immediate
            // develop dispatch. Field incident: only the developer saw a
            // diff-review rejection; the reviewer then re-rejected the
            // developer's compliant undo because the ticket criteria
            // still said the opposite.
            const row = db
                .prepare('SELECT feedback FROM tasks WHERE id = ?')
                .get('task-HR') as { feedback: string | null };
            assert.equal(
                row.feedback,
                'please rename _roleIdFilter to roleIdQuery',
                'diff-review reject must persist operator feedback on tasks.feedback',
            );

            engine.stop();
        } finally {
            db.close();
        }
    },
);

// ---------------------------------------------------------------------------
// 4. start_mode: auto regression — a late TaskApproved must not
//    double-park either flow
// ---------------------------------------------------------------------------

test('merge flow with start_mode auto: late TaskApproved does not double-park', async () => {
    const flow = loadFlow(path.join(FLOWS_DIR, 'merge.yaml'));
    const flows = new Map<string, FlowDefinition>([[MERGE_FLOW_ID, flow]]);
    const { db, bus, engine } = makeHarness(flows);
    try {
        seedTask(db, 'task-MG2');

        const parked: StoredEvent[] = [];
        bus.subscribe(TaskParkingEvents.TASK_PARKED, (e) => {
            parked.push(e);
        });

        await bus.publish(
            makeEvent(FlowEvents.TASK_CREATED, {
                taskId: 'task-MG2',
                flowId: MERGE_FLOW_ID,
            }),
        );
        assert.equal(parked.length, 1);

        await bus.publish(
            makeEvent(FlowEvents.TASK_APPROVED, {
                taskId: 'task-MG2',
                flowId: MERGE_FLOW_ID,
            }),
        );
        assert.equal(
            parked.length,
            1,
            'TaskApproved must not double-park an auto flow',
        );

        engine.stop();
    } finally {
        db.close();
    }
});

test('worktree-diff-review flow with start_mode auto: late TaskApproved does not double-park', async () => {
    const flow = loadFlow(path.join(FLOWS_DIR, 'worktree-diff-review.yaml'));
    const flows = new Map<string, FlowDefinition>([
        [WORKTREE_DIFF_REVIEW_FLOW_ID, flow],
    ]);
    const { db, bus, engine } = makeHarness(flows);
    try {
        seedTask(db, 'task-WD2');

        const parked: StoredEvent[] = [];
        bus.subscribe(TaskParkingEvents.TASK_PARKED, (e) => {
            parked.push(e);
        });

        await bus.publish(
            makeEvent(FlowEvents.TASK_CREATED, {
                taskId: 'task-WD2',
                flowId: WORKTREE_DIFF_REVIEW_FLOW_ID,
            }),
        );
        assert.equal(parked.length, 1);

        await bus.publish(
            makeEvent(FlowEvents.TASK_APPROVED, {
                taskId: 'task-WD2',
                flowId: WORKTREE_DIFF_REVIEW_FLOW_ID,
            }),
        );
        assert.equal(
            parked.length,
            1,
            'TaskApproved must not double-park an auto flow',
        );

        engine.stop();
    } finally {
        db.close();
    }
});
