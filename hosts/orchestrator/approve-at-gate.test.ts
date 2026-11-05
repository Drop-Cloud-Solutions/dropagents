/**
 * Approving a task that is HELD AT THE APPROVAL GATE must start it.
 *
 * Field report: "I've had a few times now that I approved a task in the
 * telegram app but that didn't start the task."
 *
 * "Approve" names two different operator intentions, and the pipeline
 * needs a different event for each:
 *
 *   not started yet            TaskApproved  — starts the flow
 *   held at the approval gate  TaskResumed   — releases the parked step
 *
 * The board sends the right one for each state (`onApproveParked` →
 * ResumeTask). The Telegram keyboard sent `ApproveTask` for BOTH, and
 * the engine's `onTaskApproved` discards a TaskApproved for a task that
 * already has flow_state — without a log line. So every gate approval
 * made from the phone vanished, leaving rows with status='approved' AND
 * parked_reason='approval' (69 tasks parked at the gate on the live
 * board when this was found, 9 of them already "approved").
 *
 * Fixed at the ApproveTask command handler, the one choke point every
 * producer shares — the board's own race when its in-memory
 * parkedReason is stale, the chat assistant, the HTTP API, and the
 * Approve buttons already sitting in the operator's Telegram history,
 * which keep sending the old callback forever.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';

import { openDatabase, applyMigrations, type Db } from '../../core/state/migrations';
import { approvalGateParkedStep } from './handlers';
import { Orchestrator } from './main';
import type { Logger } from '../../core/ports/Logger';

class SilentLogger implements Logger {
    info(): void {}
    warn(): void {}
    error(): void {}
    debug(): void {}
}

const FLOWS_DIR = path.resolve(__dirname, '..', '..', 'config', 'flows');

function makeOrchestrator(): Orchestrator {
    return new Orchestrator({
        dbPath: ':memory:',
        flowsDir: FLOWS_DIR,
        logger: new SilentLogger(),
        idGen: (() => {
            let n = 0;
            return { newId: (): string => `task-${++n}` };
        })(),
    });
}

/** A task sitting where the engine's approval gate leaves it. */
function seedGateParkedTask(db: Db, taskId: string, stepId = 'develop'): void {
    db.prepare(
        "INSERT INTO plans(id, project_id, status, created_at) VALUES (?, 'p', 'approved', 1)",
    ).run(`pl-${taskId}`);
    db.prepare(
        'INSERT INTO tasks(id, plan_id, type, status, flow_id, parked_reason)'
        + " VALUES (?, ?, 'implement', 'approved', 'implement', 'approval')",
    ).run(taskId, `pl-${taskId}`);
    // What the gate itself writes: the step is persisted and marked
    // parked, pending a decision.
    db.prepare(
        // last_event_seq 0: the engine's replay guard drops any event
        // whose seq is <= it, and a fresh in-memory log starts at 1.
        'INSERT INTO flow_state(task_id, current_step, last_event_seq, parked_step_id)'
        + ' VALUES (?, ?, 0, ?)',
    ).run(taskId, stepId, stepId);
}

function eventTypes(db: Db, taskId: string): string[] {
    return (
        db
            .prepare(
                "SELECT type, payload FROM events WHERE payload LIKE '%' || ? || '%'"
                + ' ORDER BY seq',
            )
            .all(taskId) as Array<{ type: string }>
    ).map((r) => r.type);
}

// --- the helper -------------------------------------------------------

test('approvalGateParkedStep reports the step a task is held at', () => {
    const db = openDatabase(':memory:');
    applyMigrations(db);
    try {
        seedGateParkedTask(db, 'T-GATE', 'develop');
        assert.equal(approvalGateParkedStep(db, 'T-GATE'), 'develop');
    } finally {
        db.close();
    }
});

test('a task that is not at the gate reports null', () => {
    const db = openDatabase(':memory:');
    applyMigrations(db);
    try {
        db.prepare(
            "INSERT INTO plans(id, project_id, status, created_at) VALUES ('pl', 'p', 'approved', 1)",
        ).run();
        db.prepare(
            "INSERT INTO tasks(id, plan_id, type, status) VALUES ('T-RUN', 'pl', 'implement', 'in-progress')",
        ).run();
        // Running: flow_state exists but nothing is parked.
        db.prepare(
            'INSERT INTO flow_state(task_id, current_step, last_event_seq)'
            + " VALUES ('T-RUN', 'develop', 5)",
        ).run();

        assert.equal(approvalGateParkedStep(db, 'T-RUN'), null);
        assert.equal(approvalGateParkedStep(db, 'T-NEVER-HEARD-OF'), null);
    } finally {
        db.close();
    }
});

test('no db wired degrades to null rather than guessing', () => {
    // Thin hosts and unit tests keep the start-of-flow behaviour.
    assert.equal(approvalGateParkedStep(undefined, 'T-1'), null);
});

// --- the field bug ----------------------------------------------------

test('ApproveTask on a gate-parked task emits TaskResumed, not TaskApproved', async () => {
    const orch = makeOrchestrator();
    await orch.start();
    try {
        const db = orch.getDb();
        seedGateParkedTask(db, 'T-TG-1');

        await orch.getCommandBus().send({
            type: 'ApproveTask',
            actor: 'telegram',
            issuedAt: 1_700_000_000_000,
            payload: { taskId: 'T-TG-1', flowId: 'implement' },
        });

        const types = eventTypes(db, 'T-TG-1');
        assert.ok(
            types.includes('TaskResumed'),
            `the gate needs a TaskResumed to release; got ${types.join(', ')}`,
        );
        assert.ok(
            !types.includes('TaskApproved'),
            'TaskApproved would be discarded by the engine — it must not be emitted',
        );
    } finally {
        // stop() closes the DB and clears the subscribers, so a deferred
        // agent spawn cannot fire against a closed connection.
        await orch.stop();
    }
});

test('the approval actually RELEASES the step, and does not re-park it', async () => {
    // The whole point. Asserting on the emitted event alone would pass
    // even if the engine ignored it, which is how the bug survived: the
    // projection recorded the approval while the step stayed parked.
    //
    // `parked_step_id` going null IS the proof the step went down the
    // dispatch path: the gate writes that column every time it holds a
    // step, so a released-then-re-parked step would still have it set.
    const orch = makeOrchestrator();
    await orch.start();
    try {
        const db = orch.getDb();
        seedGateParkedTask(db, 'T-TG-2');

        await orch.getCommandBus().send({
            type: 'ApproveTask',
            actor: 'telegram',
            issuedAt: 1_700_000_000_001,
            payload: { taskId: 'T-TG-2', flowId: 'implement' },
        });

        const row = db
            .prepare('SELECT parked_step_id, last_event_seq FROM flow_state WHERE task_id = ?')
            .get('T-TG-2') as { parked_step_id: string | null; last_event_seq: number };
        assert.equal(
            row.parked_step_id,
            null,
            'the gate must be cleared, or the task is still parked',
        );
        assert.ok(
            row.last_event_seq > 0,
            'the step must have been dispatched and persisted',
        );

        const reparked = db
            .prepare(
                "SELECT COUNT(*) AS n FROM events WHERE type = 'TaskParked'"
                + " AND payload LIKE '%T-TG-2%' AND payload LIKE '%approval%'",
            )
            .get() as { n: number };
        assert.equal(reparked.n, 0, 'the released step must not land back at the gate');
    } finally {
        // stop() closes the DB and clears the subscribers, so a deferred
        // agent spawn cannot fire against a closed connection.
        await orch.stop();
    }
});

test('the parked state is cleared on the task row too', async () => {
    // `status='approved'` with `parked_reason='approval'` was the live
    // fingerprint of the bug: the projection recorded the approval while
    // the task stayed parked. The resume path clears both.
    const orch = makeOrchestrator();
    await orch.start();
    try {
        const db = orch.getDb();
        seedGateParkedTask(db, 'T-TG-3');

        await orch.getCommandBus().send({
            type: 'ApproveTask',
            actor: 'telegram',
            issuedAt: 1_700_000_000_002,
            payload: { taskId: 'T-TG-3', flowId: 'implement' },
        });

        const row = db
            .prepare('SELECT parked_reason FROM tasks WHERE id = ?')
            .get('T-TG-3') as { parked_reason: string | null };
        assert.equal(row.parked_reason, null, 'the card must stop showing "Awaiting approval"');
    } finally {
        // stop() closes the DB and clears the subscribers, so a deferred
        // agent spawn cannot fire against a closed connection.
        await orch.stop();
    }
});

// --- the other state still works -------------------------------------

test('ApproveTask on a NOT-yet-started task still starts the flow', async () => {
    // The fix must not cost the original behaviour: a task with no
    // flow_state is started by TaskApproved, as before.
    const orch = makeOrchestrator();
    await orch.start();
    try {
        const db = orch.getDb();
        db.prepare(
            "INSERT INTO plans(id, project_id, status, created_at) VALUES ('pl-new', 'p', 'approved', 1)",
        ).run();
        db.prepare(
            'INSERT INTO tasks(id, plan_id, type, status, flow_id)'
            + " VALUES ('T-NEW', 'pl-new', 'implement', 'approved', 'implement')",
        ).run();

        await orch.getCommandBus().send({
            type: 'ApproveTask',
            actor: 'operator',
            issuedAt: 1_700_000_000_003,
            payload: { taskId: 'T-NEW', flowId: 'implement' },
        });

        const types = eventTypes(db, 'T-NEW');
        assert.ok(
            types.includes('TaskApproved'),
            `a fresh task is started by TaskApproved; got ${types.join(', ')}`,
        );
    } finally {
        // stop() closes the DB and clears the subscribers, so a deferred
        // agent spawn cannot fire against a closed connection.
        await orch.stop();
    }
});

// --- the second silent drop ------------------------------------------

test('two TaskApproved events bridge as TWO events, not one deduped one', async () => {
    // The `task.approved` bridge keyed on the taskId ALONE, so a second
    // TaskApproved deduped to the original row, came back carrying its
    // OLD seq, and the engine's `alreadyApplied(taskId, seq)` then
    // discarded it because flow_state had advanced past that seq. No
    // event, no log, no work — exactly the footgun CLAUDE.md records for
    // DecomposePlan, and one the ApproveTask handler already guards
    // against in its own key, undone a layer later.
    //
    // Driven by publishing the raw events rather than through the
    // command, because the command now (correctly) turns the second
    // approval of a gate-parked task into a resume — which would hide
    // what the bridge does.
    const orch = makeOrchestrator();
    await orch.start();
    try {
        const db = orch.getDb();
        const bus = orch.getEventBus();
        db.prepare(
            "INSERT INTO plans(id, project_id, status, created_at) VALUES ('pl-2x', 'p', 'approved', 1)",
        ).run();
        db.prepare(
            'INSERT INTO tasks(id, plan_id, type, status, flow_id)'
            + " VALUES ('T-2X', 'pl-2x', 'implement', 'approved', 'implement')",
        ).run();

        for (const n of [1, 2]) {
            await bus.publish({
                type: 'TaskApproved',
                v: 1,
                occurredAt: 1_700_000_000_000,
                // Distinct, as the real handler's `ApproveTask:<id>:<issuedAt>`
                // keys are — so the only thing that can collapse them is
                // the bridge.
                idempotencyKey: `approve-twice-${n}`,
                payload: { taskId: 'T-2X', flowId: 'implement' },
            });
        }

        const bridged = db
            .prepare(
                "SELECT COUNT(*) AS n FROM events WHERE type = 'task.approved'"
                + " AND payload LIKE '%T-2X%'",
            )
            .get() as { n: number };
        assert.equal(bridged.n, 2, 'both approvals must land as their own event');
    } finally {
        // stop() closes the DB and clears the subscribers, so a deferred
        // agent spawn cannot fire against a closed connection.
        await orch.stop();
    }
});

// --- the queued-merge retry -------------------------------------------

test('MergeTaskPr does not re-attempt a merge already queued for auto-merge', async () => {
    // Field sequence (D-LRCA-001, PR #46):
    //   14:15:44  queued PR for auto-merge
    //   14:17:46  gh pr merge #46 again -> "the head branch is not up to
    //             date with the base branch" -> read as a conflict ->
    //             merge-resolver agent dispatched, worktree re-created
    //   14:22:49  GitHub merged the PR on its own
    // The retry could not help and cost an agent run plus an operator
    // question, so a task with a watch in flight short-circuits.
    const orch = makeOrchestrator();
    await orch.start();
    try {
        const db = orch.getDb();
        db.prepare(
            "INSERT INTO plans(id, project_id, status, created_at) VALUES ('pl-q', 'p', 'approved', 1)",
        ).run();
        db.prepare(
            'INSERT INTO tasks(id, plan_id, type, status, flow_id)'
            + " VALUES ('T-Q', 'pl-q', 'implement', 'in-progress', 'implement')",
        ).run();
        // Stand in for a watch already running for this task.
        (orch as unknown as { enqueuedMergeWatches: Set<string> })
            .enqueuedMergeWatches.add('T-Q');

        const produced = await orch.getCommandBus().send({
            type: 'MergeTaskPr',
            actor: 'auto-merge',
            issuedAt: 1_700_000_000_100,
            payload: { taskId: 'T-Q' },
        });

        assert.deepEqual(produced, [], 'a queued merge produces no further events');
        const conflicts = db
            .prepare(
                "SELECT COUNT(*) AS n FROM events WHERE type = 'MergeConflictDetected'"
                + " AND payload LIKE '%T-Q%'",
            )
            .get() as { n: number };
        assert.equal(conflicts.n, 0, 'and must not look like a conflict');
    } finally {
        // stop() closes the DB and clears the subscribers, so a deferred
        // agent spawn cannot fire against a closed connection.
        await orch.stop();
    }
});

// --- only an OPERATOR may satisfy the gate ----------------------------
//
// Regression from the fix above, caught in the field within the hour:
// "the decomposer just finished, created the tasks and the first task
// started without my approval".
//
// `TaskCreated -> ApproveTask` is an automatic cascade. Every task a
// decomposition produces gets an ApproveTask a few hundred milliseconds
// after the engine parks its first step at the gate — the live log shows
// the park at 15:12:49.999 and the approval at 15:12:50.448. Routing
// THAT to a resume approves the gate the pipeline itself just raised.
//
// The engine's old silent `flowStateExists` return was load-bearing for
// exactly this cascade, which is what made removing it dangerous.

test('the TaskCreated cascade does NOT release the approval gate', async () => {
    const orch = makeOrchestrator();
    await orch.start();
    try {
        const db = orch.getDb();
        seedGateParkedTask(db, 'T-CASCADE');

        await orch.getCommandBus().send({
            type: 'ApproveTask',
            // The cascade's actor — see attachCommandCascades.
            actor: 'orchestrator',
            issuedAt: 1_700_000_000_200,
            payload: { taskId: 'T-CASCADE', flowId: 'implement' },
        });

        const parked = db
            .prepare('SELECT parked_step_id FROM flow_state WHERE task_id = ?')
            .get('T-CASCADE') as { parked_step_id: string | null };
        assert.equal(
            parked.parked_step_id,
            'develop',
            'the gate must still be holding — nobody approved anything',
        );
        const types = eventTypes(db, 'T-CASCADE');
        assert.ok(
            !types.includes('TaskResumed'),
            `a cascade must not resume; got ${types.join(', ')}`,
        );
    } finally {
        await orch.stop();
    }
});

test('no agent is started by the cascade on a gated task', async () => {
    // The consequence that matters: an agent run costs money and writes
    // code against a repo nobody approved.
    const orch = makeOrchestrator();
    await orch.start();
    try {
        const db = orch.getDb();
        seedGateParkedTask(db, 'T-CASCADE-2');

        await orch.getCommandBus().send({
            type: 'ApproveTask',
            actor: 'orchestrator',
            issuedAt: 1_700_000_000_201,
            payload: { taskId: 'T-CASCADE-2', flowId: 'implement' },
        });

        const types = eventTypes(db, 'T-CASCADE-2');
        assert.ok(
            !types.some((t) => t.startsWith('Agent')),
            `no agent may start; got ${types.join(', ')}`,
        );
    } finally {
        await orch.stop();
    }
});

test('the operator surfaces DO release the gate', async () => {
    // Both of them, named explicitly: the whole point of the fix is that
    // a Telegram tap works like a board click.
    for (const [i, actor] of ['operator', 'telegram'].entries()) {
        const orch = makeOrchestrator();
        await orch.start();
        try {
            const db = orch.getDb();
            const taskId = `T-OP-${i}`;
            seedGateParkedTask(db, taskId);

            await orch.getCommandBus().send({
                type: 'ApproveTask',
                actor,
                issuedAt: 1_700_000_000_300 + i,
                payload: { taskId, flowId: 'implement' },
            });

            assert.ok(
                eventTypes(db, taskId).includes('TaskResumed'),
                `actor '${actor}' must release the gate`,
            );
        } finally {
            await orch.stop();
        }
    }
});

test('an UNKNOWN actor fails closed — parked, not started', async () => {
    // The whitelist's direction. A new operator surface that forgets to
    // name itself leaves the task parked: visible, and one more click.
    // The opposite default would run an agent nobody approved.
    const orch = makeOrchestrator();
    await orch.start();
    try {
        const db = orch.getDb();
        seedGateParkedTask(db, 'T-UNKNOWN');

        await orch.getCommandBus().send({
            type: 'ApproveTask',
            actor: 'some-new-surface',
            issuedAt: 1_700_000_000_400,
            payload: { taskId: 'T-UNKNOWN', flowId: 'implement' },
        });

        const parked = db
            .prepare('SELECT parked_step_id FROM flow_state WHERE task_id = ?')
            .get('T-UNKNOWN') as { parked_step_id: string | null };
        assert.equal(parked.parked_step_id, 'develop', 'fail closed');
    } finally {
        await orch.stop();
    }
});

test('a NOT-yet-started task is still started by the cascade', async () => {
    // The cascade's real job. It must keep working: this is how every
    // auto-approval flow (`approval: auto`) starts at all.
    const orch = makeOrchestrator();
    await orch.start();
    try {
        const db = orch.getDb();
        db.prepare(
            "INSERT INTO plans(id, project_id, status, created_at) VALUES ('pl-c', 'p', 'approved', 1)",
        ).run();
        db.prepare(
            'INSERT INTO tasks(id, plan_id, type, status, flow_id)'
            + " VALUES ('T-CASC-NEW', 'pl-c', 'implement', 'approved', 'implement')",
        ).run();

        await orch.getCommandBus().send({
            type: 'ApproveTask',
            actor: 'orchestrator',
            issuedAt: 1_700_000_000_500,
            payload: { taskId: 'T-CASC-NEW', flowId: 'implement' },
        });

        assert.ok(
            eventTypes(db, 'T-CASC-NEW').includes('TaskApproved'),
            'the cascade must still emit the start-of-flow event',
        );
    } finally {
        await orch.stop();
    }
});
