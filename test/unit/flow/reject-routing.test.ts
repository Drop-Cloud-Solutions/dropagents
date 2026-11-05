/**
 * AP-VP5-003 — flow-engine reject-routing tests.
 *
 * Covers the generalised reject path the engine runs when a `ResumeTask`
 * arrives with `decision: 'reject'` against an approval-parked step:
 *
 *   1. on_failure declared → follow the named transition, threading the
 *      operator's `feedback` onto the dispatched payload (emit event
 *      payload or StartAgent context, depending on the target form).
 *   2. on_failure omitted   → emit `TaskFailed{ failed_stage: 'rejected' }`
 *      as the default rejection terminal (operator feedback is persisted on
 *      `tasks.feedback` but intentionally NOT widened onto this default
 *      payload — the integration test in `test/integration/approval-gate.test.ts`
 *      relies on the exact `{ taskId, failed_stage }` shape). The engine
 *      surfaces a load-time warning that names the offending step so this
 *      fallback is never silent.
 *   3. multi-step flows do not advance past a parked step until the
 *      operator resumes it — the gate must hold the task at the parked
 *      step regardless of subsequent unrelated events.
 *
 * Approve-path behaviour is asserted here as a regression: the existing
 * Phase-3 approval gate's approve branch must keep dispatching the parked
 * step exactly once when the operator resumes with `decision: 'approve'`.
 *
 * Tests use vitest (test/unit/ convention) and stand up an in-memory
 * SQLite db + real EventBus + CommandBus to exercise the engine end-to-end
 * without mocking its persistence surface.
 */

/**
 * Dual-runner discovery (see `adapters/git/worktree-gc-job.test.ts`):
 *
 * - `npm test` runs `node --test --import tsx`, i.e. Node's `node:test`.
 * - The review pipeline runs `npx vitest run` on changed test files.
 *
 * A static `import { test } from 'vitest'` breaks the first of those, and
 * that is exactly what this file used to carry — so it never ran under
 * `npm test` at all, and `npx tsx --test` on it died on the import. The
 * shim routes to `globalThis.test` under vitest (`vitest.config.ts` sets
 * `globals: true`) and to `node:test` everywhere else.
 */
type TestFn = (name: string, fn: () => void | Promise<void>) => void;

const test: TestFn = (((): TestFn => {
    if (process.env.VITEST) {
        const gt = (globalThis as { test?: TestFn }).test;
        if (typeof gt !== 'function') {
            throw new Error(
                'reject-routing.test.ts: VITEST=true but globalThis.test is missing — '
                    + 'ensure vitest.config.ts sets test.globals = true',
            );
        }
        return gt;
    }
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    const nt = require('node:test') as { test: TestFn };
    return nt.test;
})());
import assert from 'node:assert/strict';

import { applyMigrations, openDatabase, type Db } from '../../../core/state/migrations';
import { EventStore } from '../../../core/events/store';
import { EventBus } from '../../../core/events/bus';
import { CommandBus } from '../../../core/commands/bus';
import type { Command } from '../../../core/commands/command';
import type { Event, StoredEvent } from '../../../core/events/event';
import type { Logger } from '../../../core/ports/Logger';
import type { FlowDefinition, FlowStep } from '../../../core/flow/types';
import {
    FlowEngine,
    FlowEvents,
    FlowCommands,
    type StartAgentPayload,
} from '../../../core/flow/engine';
import {
    TaskParkingEvents,
    type TaskParkedEventPayload,
    type TaskResumedEventPayload,
} from '../../../core/commands';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface WarnEntry {
    readonly message: string;
    readonly context: unknown;
}

class RecordingLogger implements Logger {
    readonly warns: WarnEntry[] = [];
    info(): void {}
    warn(message: string, context?: unknown): void {
        this.warns.push({ message, context });
    }
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
        idempotencyKey: `reject-routing-${process.pid}-${evCounter}`,
        payload,
    };
}

function seedTask(db: Db, taskId: string): void {
    const planId = `plan-${taskId}`;
    db.prepare(
        'INSERT INTO plans(id, project_id, status, created_at) VALUES (?, ?, ?, ?)',
    ).run(planId, 'proj-vp5-003', 'approved', 1_700_000_000_000);
    db.prepare(
        'INSERT INTO tasks(id, plan_id, type, status) VALUES (?, ?, ?, ?)',
    ).run(taskId, planId, 'feature', 'approved');
}

interface Harness {
    db: Db;
    logger: RecordingLogger;
    bus: EventBus;
    commands: Command[];
    parked: StoredEvent[];
    failed: StoredEvent[];
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
    const logger = new RecordingLogger();
    const store = new EventStore(db);
    const bus = new EventBus(store, logger);
    const cmdBus = new CommandBus<unknown>(bus, () => undefined);

    const commands: Command[] = [];
    cmdBus.register(FlowCommands.START_AGENT, recorder(commands));
    cmdBus.register(FlowCommands.FINISH_TASK, recorder(commands));
    cmdBus.register(FlowCommands.FAIL_TASK, recorder(commands));
    cmdBus.register(FlowCommands.REQUEST_INVESTIGATION, recorder(commands));

    const parked: StoredEvent[] = [];
    bus.subscribe<TaskParkedEventPayload>(TaskParkingEvents.TASK_PARKED, (e) => {
        parked.push(e);
    });
    const failed: StoredEvent[] = [];
    bus.subscribe('TaskFailed', (e) => {
        failed.push(e);
    });

    const engine = FlowEngine.start(bus, cmdBus, flows, { db, logger });
    return { db, logger, bus, commands, parked, failed, engine };
}

function startAgents(commands: ReadonlyArray<Command>): StartAgentPayload[] {
    return commands
        .filter((c) => c.type === FlowCommands.START_AGENT)
        .map((c) => c.payload as StartAgentPayload);
}

function flowState(
    db: Db,
    taskId: string,
): {
    current_step: string;
    parked_step_id: string | null;
} | undefined {
    return db
        .prepare(
            'SELECT current_step, parked_step_id FROM flow_state WHERE task_id = ?',
        )
        .get(taskId) as
        | { current_step: string; parked_step_id: string | null }
        | undefined;
}

// Two-step flow whose first step parks at the approval gate and whose
// on_failure target is configurable per-test. The second step is an auto
// agent step the on_failure can route into to assert feedback context
// threading.
function gatedFlow(overrides: { on_failure?: string }): FlowDefinition {
    const reviewStep: FlowStep = overrides.on_failure !== undefined
        ? {
            id: 'review',
            agent: 'reviewer',
            model: 'sonnet',
            on_success: 'develop',
            on_failure: overrides.on_failure,
            approval: 'required',
        }
        : {
            id: 'review',
            agent: 'reviewer',
            model: 'sonnet',
            on_success: 'develop',
            approval: 'required',
        };
    return {
        on: 'task.approved',
        steps: [
            reviewStep,
            {
                id: 'develop',
                agent: 'developer',
                model: 'sonnet',
                on_success: 'emit:task.finished',
            },
            {
                id: 'rework',
                agent: 'developer',
                model: 'sonnet',
                on_success: 'emit:task.finished',
            },
        ],
    };
}

// ---------------------------------------------------------------------------
// 1. reject with on_failure → emit terminal: routes to the named target with
//    feedback threaded onto the published event payload.
// ---------------------------------------------------------------------------

test('reject with on_failure (emit terminal): routes to the named target and threads feedback onto the payload', async () => {
    const flows = new Map<string, FlowDefinition>([
        ['gated-emit', gatedFlow({ on_failure: 'emit:ReviewRejected' })],
    ]);
    const { db, bus, commands, parked, failed, engine } = makeHarness(flows);
    try {
        const rejectedEvents: StoredEvent[] = [];
        bus.subscribe('ReviewRejected', (e) => {
            rejectedEvents.push(e);
        });

        seedTask(db, 'task-emit');
        await bus.publish(
            makeEvent(FlowEvents.TASK_APPROVED, {
                taskId: 'task-emit',
                flowId: 'gated-emit',
            }),
        );
        assert.equal(parked.length, 1, 'precondition: parked on gate');

        await bus.publish(
            makeEvent(TaskParkingEvents.TASK_RESUMED, {
                taskId: 'task-emit',
                actor: 'operator-1',
                decision: 'reject',
                feedback: 'review pointed out a missing guard',
            } satisfies TaskResumedEventPayload),
        );

        assert.equal(rejectedEvents.length, 1, 'on_failure emit must fire on reject');
        const payload = rejectedEvents[0].payload as {
            taskId: string;
            feedback?: string;
        };
        assert.equal(payload.taskId, 'task-emit');
        assert.equal(
            payload.feedback,
            'review pointed out a missing guard',
            'feedback must be threaded onto the emitted on_failure payload',
        );

        assert.equal(failed.length, 0, 'default TaskFailed must NOT fire when on_failure is set');
        assert.equal(
            startAgents(commands).length,
            0,
            'reject must NOT dispatch the parked agent step',
        );

        const fs = flowState(db, 'task-emit');
        assert.equal(fs?.parked_step_id, null, 'parked_step_id must clear on reject');

        engine.stop();
    } finally {
        db.close();
    }
});

// ---------------------------------------------------------------------------
// 2. reject without on_failure → default TaskFailed + load-time warning.
// ---------------------------------------------------------------------------

test('reject without on_failure: emits TaskFailed and the engine surfaces a load-time warning naming the step', async () => {
    const flows = new Map<string, FlowDefinition>([
        ['gated-default', gatedFlow({})],
    ]);
    const { db, logger, bus, commands, parked, failed, engine } = makeHarness(flows);
    try {
        // Load-time warning: surfaced by FlowEngine.start for any
        // approval='required' step missing an on_failure target.
        const matching = logger.warns.filter((w) =>
            w.message.includes('approval-required step has no on_failure'),
        );
        assert.equal(
            matching.length,
            1,
            'engine must warn at start time for each approval-required step missing on_failure',
        );
        assert.deepEqual(matching[0].context, {
            flowId: 'gated-default',
            stepId: 'review',
            agent: 'reviewer',
        });

        seedTask(db, 'task-default');
        await bus.publish(
            makeEvent(FlowEvents.TASK_APPROVED, {
                taskId: 'task-default',
                flowId: 'gated-default',
            }),
        );
        assert.equal(parked.length, 1, 'precondition: parked on gate');

        await bus.publish(
            makeEvent(TaskParkingEvents.TASK_RESUMED, {
                taskId: 'task-default',
                actor: 'operator-1',
                decision: 'reject',
                feedback: 'try again with the corrected scope',
            } satisfies TaskResumedEventPayload),
        );

        assert.equal(failed.length, 1, 'default TaskFailed must fire when on_failure is omitted');
        // The default rejection terminal is intentionally NARROW — feedback
        // is persisted to tasks.feedback (asserted below) and is only
        // threaded onto the dispatch payload when on_failure is declared.
        // Widening the default terminal would break the regression assertion
        // in test/integration/approval-gate.test.ts which deepEquals the
        // exact { taskId, failed_stage } shape.
        assert.deepEqual(failed[0].payload, {
            taskId: 'task-default',
            failed_stage: 'rejected',
        });

        const feedbackRow = db
            .prepare('SELECT feedback FROM tasks WHERE id = ?')
            .get('task-default') as { feedback: string | null } | undefined;
        assert.equal(
            feedbackRow?.feedback,
            'try again with the corrected scope',
            'tasks.feedback must persist the operator feedback even when the default TaskFailed payload omits it',
        );

        assert.equal(
            startAgents(commands).length,
            0,
            'reject must NOT dispatch the parked agent step',
        );

        const fs = flowState(db, 'task-default');
        assert.equal(fs?.parked_step_id, null, 'parked_step_id must clear on reject');

        engine.stop();
    } finally {
        db.close();
    }
});

// ---------------------------------------------------------------------------
// 3. reject with on_failure → agent step: feedback threaded onto StartAgent
//    context so the downstream agent reads the operator's rationale.
// ---------------------------------------------------------------------------

test('reject with on_failure (agent step): feedback is threaded onto the dispatched StartAgent context', async () => {
    const flows = new Map<string, FlowDefinition>([
        ['gated-rework', gatedFlow({ on_failure: 'rework' })],
    ]);
    const { db, bus, commands, parked, engine } = makeHarness(flows);
    try {
        seedTask(db, 'task-rework');
        await bus.publish(
            makeEvent(FlowEvents.TASK_APPROVED, {
                taskId: 'task-rework',
                flowId: 'gated-rework',
            }),
        );
        assert.equal(parked.length, 1, 'precondition: parked on gate');
        assert.equal(startAgents(commands).length, 0, 'no agent dispatched before resume');

        await bus.publish(
            makeEvent(TaskParkingEvents.TASK_RESUMED, {
                taskId: 'task-rework',
                actor: 'operator-1',
                decision: 'reject',
                feedback: 'narrow scope to the migration only',
            } satisfies TaskResumedEventPayload),
        );

        const starts = startAgents(commands);
        assert.equal(
            starts.length,
            1,
            'reject with on_failure pointing at an agent step must dispatch that step',
        );
        assert.equal(starts[0].stepId, 'rework');
        assert.equal(starts[0].agent, 'developer');
        assert.deepEqual(
            starts[0].context,
            { rejectFeedback: 'narrow scope to the migration only' },
            'feedback must be threaded onto the on_failure step\'s StartAgent context',
        );

        const fs = flowState(db, 'task-rework');
        assert.equal(fs?.current_step, 'rework', 'flow_state must advance to the on_failure target');
        assert.equal(fs?.parked_step_id, null, 'parked_step_id must clear on reject');

        engine.stop();
    } finally {
        db.close();
    }
});

// ---------------------------------------------------------------------------
// 4. multi-step flow: the second step never dispatches until the operator
//    resumes the first (parked) step. Approve-path regression assertion
//    bundled in — approve must dispatch the parked step exactly once.
// ---------------------------------------------------------------------------

test('multi-step flow does not advance past a parked step until resumed (approve path still dispatches exactly once)', async () => {
    const flows = new Map<string, FlowDefinition>([
        ['gated-multi', gatedFlow({})],
    ]);
    const { db, bus, commands, parked, failed, engine } = makeHarness(flows);
    try {
        seedTask(db, 'task-multi');
        await bus.publish(
            makeEvent(FlowEvents.TASK_APPROVED, {
                taskId: 'task-multi',
                flowId: 'gated-multi',
            }),
        );

        // The gate must hold the task at the first step — no StartAgent for
        // 'review' (the parked step is held by the gate, not dispatched)
        // and no StartAgent for 'develop' (the on_success target which the
        // engine must never reach until resume).
        assert.equal(parked.length, 1, 'gate must publish exactly one TaskParked');
        const parkedPayload = parked[0].payload as TaskParkedEventPayload;
        assert.equal(parkedPayload.stepId, 'review');
        assert.equal(parkedPayload.reason, 'approval');
        assert.equal(
            startAgents(commands).length,
            0,
            'no StartAgent may be dispatched while the task is parked',
        );

        const fsParked = flowState(db, 'task-multi');
        assert.equal(fsParked?.current_step, 'review');
        assert.equal(fsParked?.parked_step_id, 'review');

        // Approve-path regression: resume(approve) dispatches the parked
        // step exactly once and clears parked_step_id. The second flow
        // step is still not dispatched (it waits for its own
        // AgentFinished on the 'review' agent).
        await bus.publish(
            makeEvent(TaskParkingEvents.TASK_RESUMED, {
                taskId: 'task-multi',
                actor: 'operator-1',
                decision: 'approve',
            } satisfies TaskResumedEventPayload),
        );

        const starts = startAgents(commands);
        assert.equal(
            starts.length,
            1,
            'approve must dispatch the parked step exactly once (Phase-3 regression)',
        );
        assert.equal(starts[0].stepId, 'review');
        assert.equal(starts[0].agent, 'reviewer');

        const fsResumed = flowState(db, 'task-multi');
        assert.equal(fsResumed?.current_step, 'review');
        assert.equal(fsResumed?.parked_step_id, null);
        assert.equal(failed.length, 0, 'approve path must not emit TaskFailed');

        engine.stop();
    } finally {
        db.close();
    }
});
