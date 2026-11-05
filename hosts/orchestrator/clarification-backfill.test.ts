/**
 * Recovering operator answers that predate the projection.
 *
 * Without this, an answer given before the upgrade — including one on a
 * task still running — stays invisible to the reviewer forever, because
 * `projection-tasks` is long past those events' offsets.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { applyMigrations, openDatabase, type Db } from '../../core/state/migrations';
import { backfillClarifications } from './clarification-backfill';
import type { Logger } from '../../core/ports/Logger';

const silent: Logger = {
    info: (): void => {},
    warn: (): void => {},
    error: (): void => {},
    debug: (): void => {},
};

let key = 0;
function append(db: Db, type: string, payload: unknown, occurredAt = 1): void {
    key += 1;
    db.prepare(
        `INSERT INTO events(type, v, occurred_at, idempotency_key, payload)
         VALUES (?, 1, ?, ?, ?)`,
    ).run(type, occurredAt, `k-${key}`, JSON.stringify(payload));
}

function fresh(): Db {
    const db = openDatabase(':memory:');
    applyMigrations(db);
    return db;
}

test('an answer in the log is recovered WITH the question that preceded it', () => {
    const db = fresh();
    try {
        append(db, 'TaskParked', {
            taskId: 'T-1',
            stepId: 'develop',
            reason: 'clarification',
            question: 'The ticket says bump the version — bump anyway?',
        });
        append(db, 'TaskResumed', {
            taskId: 'T-1',
            actor: 'op',
            decision: 'approve',
            answer: 'No. Leave the version alone.',
        }, 99);

        assert.equal(backfillClarifications(db, silent), 1);
        const row = db
            .prepare('SELECT question, answer, answered_at FROM task_clarifications WHERE task_id = ?')
            .get('T-1') as { question: string; answer: string; answered_at: number };
        assert.match(row.question, /bump anyway/);
        assert.equal(row.answer, 'No. Leave the version alone.');
        assert.equal(row.answered_at, 99);
    } finally {
        db.close();
    }
});

test('running twice inserts nothing new', () => {
    const db = fresh();
    try {
        append(db, 'TaskParked', { taskId: 'T-1', reason: 'clarification', question: 'Q?' });
        append(db, 'TaskResumed', { taskId: 'T-1', decision: 'approve', answer: 'A.' });
        assert.equal(backfillClarifications(db, silent), 1);
        assert.equal(backfillClarifications(db, silent), 0, 'boot must be idempotent');
        const n = db
            .prepare('SELECT COUNT(*) AS n FROM task_clarifications')
            .get() as { n: number };
        assert.equal(n.n, 1);
    } finally {
        db.close();
    }
});

test('approval clicks and rejections are not answers', () => {
    const db = fresh();
    try {
        append(db, 'TaskParked', { taskId: 'T-1', reason: 'approval' });
        append(db, 'TaskResumed', { taskId: 'T-1', decision: 'approve' });
        append(db, 'TaskResumed', {
            taskId: 'T-1',
            decision: 'reject',
            feedback: 'undo the bump',
        });
        assert.equal(backfillClarifications(db, silent), 0);
    } finally {
        db.close();
    }
});

test("a rejection does not leave its question attached to a later task's answer", () => {
    const db = fresh();
    try {
        append(db, 'TaskParked', { taskId: 'T-1', reason: 'clarification', question: 'FIRST?' });
        append(db, 'TaskResumed', { taskId: 'T-1', decision: 'reject', feedback: 'no' });
        // A later answer with no park of its own must not inherit FIRST?.
        append(db, 'TaskResumed', { taskId: 'T-1', decision: 'approve', answer: 'later answer' });
        backfillClarifications(db, silent);
        const row = db
            .prepare('SELECT question FROM task_clarifications WHERE task_id = ?')
            .get('T-1') as { question: string | null };
        assert.equal(row.question, null, 'a stale question is worse than none');
    } finally {
        db.close();
    }
});

test('several answers on one task are each recovered in order', () => {
    const db = fresh();
    try {
        append(db, 'TaskParked', { taskId: 'T-1', reason: 'clarification', question: 'Q1?' });
        append(db, 'TaskResumed', { taskId: 'T-1', decision: 'approve', answer: 'A1' });
        append(db, 'ClarificationRequested', { taskId: 'T-1', question: 'Q2?' });
        append(db, 'TaskResumed', { taskId: 'T-1', decision: 'approve', answer: 'A2' });

        assert.equal(backfillClarifications(db, silent), 2);
        const rows = db
            .prepare('SELECT question, answer FROM task_clarifications ORDER BY event_seq')
            .all() as Array<{ question: string; answer: string }>;
        assert.deepEqual(rows.map((r) => [r.question, r.answer]), [
            ['Q1?', 'A1'],
            ['Q2?', 'A2'],
        ]);
    } finally {
        db.close();
    }
});

test('two tasks parked at once do not swap questions', () => {
    const db = fresh();
    try {
        append(db, 'TaskParked', { taskId: 'T-1', reason: 'clarification', question: 'Q-ONE?' });
        append(db, 'TaskParked', { taskId: 'T-2', reason: 'clarification', question: 'Q-TWO?' });
        append(db, 'TaskResumed', { taskId: 'T-2', decision: 'approve', answer: 'A-TWO' });
        append(db, 'TaskResumed', { taskId: 'T-1', decision: 'approve', answer: 'A-ONE' });
        backfillClarifications(db, silent);
        const rows = db
            .prepare('SELECT task_id, question FROM task_clarifications')
            .all() as Array<{ task_id: string; question: string }>;
        const byTask = new Map(rows.map((r) => [r.task_id, r.question]));
        assert.equal(byTask.get('T-1'), 'Q-ONE?');
        assert.equal(byTask.get('T-2'), 'Q-TWO?');
    } finally {
        db.close();
    }
});

test('unparseable payloads and blank answers are skipped, not fatal', () => {
    const db = fresh();
    try {
        db.prepare(
            `INSERT INTO events(type, v, occurred_at, idempotency_key, payload)
             VALUES ('TaskResumed', 1, 1, 'bad-json', '{not json')`,
        ).run();
        append(db, 'TaskResumed', { taskId: 'T-1', decision: 'approve', answer: '   ' });
        assert.equal(backfillClarifications(db, silent), 0);
    } finally {
        db.close();
    }
});
