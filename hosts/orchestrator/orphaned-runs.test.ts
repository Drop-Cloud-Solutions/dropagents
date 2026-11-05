/**
 * Agent runs stranded by a worker restart.
 *
 * Field report: "there was another agent running, the Get-Process query
 * now returns no results, but Tester still shows running". The worker
 * had restarted 77 seconds after that tester spawned, taking the child
 * process AND the `close` handler that publishes a run's terminal event.
 * So the step row read `running` forever, flow_state never advanced, and
 * the board spun on a process that no longer existed.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { openDatabase, applyMigrations, type Db } from '../../core/state/migrations';
import {
    describeOrphanedRun,
    findOrphanedRuns,
    needsOperatorPark,
    type OrphanedRun,
} from './orphaned-runs';

function freshDb(): Db {
    const db = openDatabase(':memory:');
    applyMigrations(db);
    db.prepare(
        "INSERT INTO plans(id, project_id, status, created_at) VALUES ('pl', 'p', 'approved', 1)",
    ).run();
    return db;
}

function addTask(
    db: Db,
    taskId: string,
    opts: { status?: string; parkedReason?: string | null } = {},
): void {
    db.prepare(
        'INSERT INTO tasks(id, plan_id, type, status, parked_reason)'
        + " VALUES (?, 'pl', 'implement', ?, ?)",
    ).run(taskId, opts.status ?? 'in-progress', opts.parkedReason ?? null);
}

function addStep(
    db: Db,
    taskId: string,
    stepId: string,
    status: string,
    role = 'tester',
    startedAt = 1_000,
): void {
    db.prepare(
        `INSERT INTO task_step_summaries
            (task_id, step_id, role, status, started_at, finished_at, summary)
         VALUES (?, ?, ?, ?, ?, NULL, NULL)`,
    ).run(taskId, stepId, role, status, startedAt);
}

const run = (over: Partial<OrphanedRun> = {}): OrphanedRun => ({
    taskId: 'T-1',
    stepId: 'test',
    role: 'tester',
    startedAt: 1_000,
    taskStatus: 'in-progress',
    parkedReason: null,
    ...over,
});

// --- finding them -----------------------------------------------------

test('a step left running is found', () => {
    const db = freshDb();
    try {
        addTask(db, 'D-AHCW-001');
        addStep(db, 'D-AHCW-001', 'test', 'running');

        const found = findOrphanedRuns(db);
        assert.equal(found.length, 1);
        assert.equal(found[0]!.stepId, 'test');
        assert.equal(found[0]!.role, 'tester');
    } finally {
        db.close();
    }
});

test('finished steps are left alone', () => {
    // The two that completed before the restart must not be touched —
    // their summaries are the only record of what the agents did.
    const db = freshDb();
    try {
        addTask(db, 'D-AHCW-001');
        addStep(db, 'D-AHCW-001', 'develop', 'complete', 'developer', 900);
        addStep(db, 'D-AHCW-001', 'review', 'failed', 'reviewer', 950);
        addStep(db, 'D-AHCW-001', 'test', 'running', 'tester', 1_000);

        assert.deepEqual(findOrphanedRuns(db).map((r) => r.stepId), ['test']);
    } finally {
        db.close();
    }
});

test('a row whose task row is gone is not returned', () => {
    // The JOIN is deliberate: without a task there is nothing to park
    // and no card to fix.
    const db = freshDb();
    try {
        addStep(db, 'T-GONE', 'test', 'running');
        assert.deepEqual(findOrphanedRuns(db), []);
    } finally {
        db.close();
    }
});

test('nothing running means nothing to do', () => {
    const db = freshDb();
    try {
        addTask(db, 'T-1');
        addStep(db, 'T-1', 'develop', 'complete');
        assert.deepEqual(findOrphanedRuns(db), []);
    } finally {
        db.close();
    }
});

test('rows come back in the order the work happened', () => {
    // The log prints them; out-of-order would make a multi-task restart
    // harder to read than it needs to be.
    const db = freshDb();
    try {
        addTask(db, 'T-1');
        addTask(db, 'T-2');
        addStep(db, 'T-2', 'develop', 'running', 'developer', 2_000);
        addStep(db, 'T-1', 'test', 'running', 'tester', 1_500);
        addStep(db, 'T-1', 'develop', 'running', 'developer', 1_000);

        assert.deepEqual(
            findOrphanedRuns(db).map((r) => `${r.taskId}/${r.stepId}`),
            ['T-1/develop', 'T-1/test', 'T-2/develop'],
        );
    } finally {
        db.close();
    }
});

// --- whose problem is it ---------------------------------------------

test('a live task is parked for the operator', () => {
    assert.equal(needsOperatorPark(run()), true);
});

test('a TERMINAL task is not parked', () => {
    // Parking would resurrect a finished card for a run that no longer
    // matters.
    for (const status of ['done', 'failed', 'skipped', 'cancelled', 'archived']) {
        assert.equal(needsOperatorPark(run({ taskStatus: status })), false, status);
    }
});

test('an existing park is never overwritten', () => {
    // A clarification or an approval is a MORE specific thing to be
    // waiting for, and the park carries the question text.
    for (const reason of ['clarification', 'approval', 'wait-merged', 'worktree-diff-review']) {
        assert.equal(needsOperatorPark(run({ parkedReason: reason })), false, reason);
    }
});

test('the dependency gate does not count as a park', () => {
    // `waiting-deps` is re-applied automatically by the gate, carries no
    // operator question, and would otherwise hide a stranded run behind
    // a task that looks merely blocked.
    assert.equal(needsOperatorPark(run({ parkedReason: 'waiting-deps' })), true);
});

test('an empty parked_reason is treated as unparked', () => {
    assert.equal(needsOperatorPark(run({ parkedReason: '' })), true);
});

// --- what the operator reads -----------------------------------------

test('the note names the role, the loss, and the way out', () => {
    // "interrupted" alone sends them hunting for an agent error that was
    // never written — there is no transcript, because the process that
    // would have flushed it is gone.
    const note = describeOrphanedRun(run({ role: 'tester' }));
    assert.match(note, /tester/);
    assert.match(note, /worker restarted/i);
    assert.match(note, /Resume/);
    assert.match(note, /Retry/);
});

test('the note reassures that nothing was committed', () => {
    // The first question on seeing a lost run is whether half of it
    // landed somewhere.
    assert.match(describeOrphanedRun(run()), /Nothing was committed/i);
});

test('a missing role still reads as a sentence', () => {
    for (const role of [null, '']) {
        const note = describeOrphanedRun(run({ role }));
        assert.match(note, /the agent was running/);
        assert.ok(!note.includes('  '), 'no double space from an empty role');
    }
});
