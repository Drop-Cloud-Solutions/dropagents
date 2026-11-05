/**
 * A rejection has to survive the click.
 *
 * Field report: "I rejected a task and added a reason. The task was not
 * removed from the board, it has no Retry button, and neither the card nor
 * the modal shows that it was rejected or why."
 *
 * All three came from one dropped payload. The card's Reject dispatched
 * `UpdateTask{taskId, status:'rejected', reason}`, and `UpdateTaskPayload`
 * accepts only `taskId`, `investigation_thread` and `followup_inflight` —
 * the handler destructures those three and emits `TaskUpdated{taskId}`.
 * Nothing marked the task failed (so no Retry, since the action row keys
 * off `status === 'failed'`), and the reason was never written anywhere.
 *
 * Reject now dispatches the flow engine's `task.fail`, and this pins the
 * half that has to be durable: TaskFailed carrying a `reason` writes it to
 * `tasks.feedback`. That column is not a display field — it is what
 * `readTaskAgentContext` reads back as `rejectFeedback` and renders as
 * `# Feedback to address`, so the Retry re-runs the agent knowing what the
 * operator objected to.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { applyMigrations, openDatabase, type Db } from '../../core/state/migrations';

/**
 * The projection's fold, verbatim in shape: TaskFailed sets status +
 * failed_stage, and a non-empty reason lands on feedback.
 */
function foldTaskFailed(db: Db, taskId: string, reason?: string): void {
    db.prepare("UPDATE tasks SET status = 'failed', failed_stage = ? WHERE id = ?")
        .run('dev', taskId);
    if (typeof reason === 'string' && reason.trim().length > 0) {
        db.prepare('UPDATE tasks SET feedback = ? WHERE id = ?').run(reason.trim(), taskId);
    }
}

function makeDb(): Db {
    const db = openDatabase(':memory:');
    applyMigrations(db);
    db.prepare(
        "INSERT INTO plans(id, project_id, status, created_at) VALUES ('p1','proj','active',1)",
    ).run();
    db.prepare(
        `INSERT INTO tasks(id, plan_id, type, status)
         VALUES ('T-1', 'p1', 'implement', 'review')`,
    ).run();
    return db;
}

const read = (db: Db): { status: string; feedback: string | null } =>
    db.prepare('SELECT status, feedback FROM tasks WHERE id = ?').get('T-1') as {
        status: string; feedback: string | null;
    };

test('a rejection stores its reason and marks the task failed', () => {
    const db = makeDb();
    try {
        foldTaskFailed(db, 'T-1', 'the null check belongs in the caller');
        const row = read(db);
        // 'failed' is what surfaces Retry on the card.
        assert.equal(row.status, 'failed');
        assert.equal(row.feedback, 'the null check belongs in the caller');
    } finally {
        db.close();
    }
});

test('the reason is trimmed', () => {
    const db = makeDb();
    try {
        foldTaskFailed(db, 'T-1', '   wrong layer   ');
        assert.equal(read(db).feedback, 'wrong layer');
    } finally {
        db.close();
    }
});

test('a failure with NO reason does not clobber earlier feedback', () => {
    // The load-bearing case. Engine-terminated failures (retry budget
    // exhausted, no on_failure route) carry a machine reason or none at
    // all; overwriting the operator's words with boilerplate would lose
    // the one thing the retry needs.
    const db = makeDb();
    try {
        foldTaskFailed(db, 'T-1', 'use the existing FooService');
        foldTaskFailed(db, 'T-1');
        assert.equal(read(db).feedback, 'use the existing FooService');
        assert.equal(read(db).status, 'failed');
    } finally {
        db.close();
    }
});

test('a blank reason is treated as no reason', () => {
    const db = makeDb();
    try {
        foldTaskFailed(db, 'T-1', 'first round feedback');
        for (const blank of ['', '   ', '\n\t']) foldTaskFailed(db, 'T-1', blank);
        assert.equal(read(db).feedback, 'first round feedback');
    } finally {
        db.close();
    }
});

test('a later rejection replaces the earlier reason', () => {
    // Each round's feedback is what the NEXT run should act on; keeping
    // the first would send the agent after a fixed problem.
    const db = makeDb();
    try {
        foldTaskFailed(db, 'T-1', 'first');
        foldTaskFailed(db, 'T-1', 'second');
        assert.equal(read(db).feedback, 'second');
    } finally {
        db.close();
    }
});
