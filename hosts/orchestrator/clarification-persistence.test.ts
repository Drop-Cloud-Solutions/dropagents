/**
 * The reviewer must see the operator's clarification answer.
 *
 * Field case: an agent asked the operator to decide something that
 * conflicted with the task statement. The operator answered, the
 * developer implemented the answer, and the reviewer rejected the
 * change — the engine threads `humanAnswer` onto the ONE step it
 * resumes, and TASK.md is regenerated per step, so by the time the
 * reviewer ran, the decision was gone from both the prompt and the
 * file.
 *
 * These tests drive the durable path (migration 033) through the real
 * read used at every StartAgent.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { applyMigrations, openDatabase, type Db } from '../../core/state/migrations';
import { assembleTaskAgentPrompt, readTaskAgentContext } from './handlers';

/**
 * The assembled prompt embeds the persona, and the reviewer/tester
 * personas now MENTION `# Human clarification` in their precedence
 * rules. A bare /# Human clarification/ therefore matches even when the
 * block is absent — a placebo. Anchor to the heading at line start,
 * which only the rendered block produces.
 */
const CLARIFICATION_HEADING = /^# Human clarification$/m;

function seed(db: Db): void {
    applyMigrations(db);
    db.prepare(
        `INSERT INTO tasks(id, plan_id, type, status, title, description)
         VALUES ('T-1', 'plan-x', 'implement', 'in_progress', 'Bump handler',
                 'Bump Example.UiLib to 0.0.12 and update consumers.')`,
    ).run();
}

function storeAnswer(
    db: Db,
    seq: number,
    question: string | null,
    answer: string,
): void {
    db.prepare(
        `INSERT INTO task_clarifications(event_seq, task_id, question, answer, answered_at)
         VALUES (?, 'T-1', ?, ?, 1)`,
    ).run(seq, question, answer);
}

test('the REVIEWER step sees an answer given during the develop step', () => {
    // The regression in one assertion: the reviewer is dispatched with
    // no humanAnswer context at all.
    const db = openDatabase(':memory:');
    try {
        seed(db);
        storeAnswer(
            db,
            10,
            'The ticket says bump the version, but it is already at 0.0.12 — bump anyway?',
            'No. Leave the version alone, the bump was already done.',
        );

        const ctx = readTaskAgentContext(db, 'reviewer', 'T-1', 'review');
        assert.ok(ctx, 'context must resolve');
        assert.equal(ctx!.clarifications?.length, 1);

        const prompt = assembleTaskAgentPrompt(ctx!);
        assert.match(prompt, CLARIFICATION_HEADING);
        assert.match(prompt, /Leave the version alone/);
        assert.match(prompt, /bump anyway\?/, 'the question gives the answer meaning');
        assert.match(prompt, /BINDING/);
    } finally {
        db.close();
    }
});

test('the answer is not duplicated for the step that was actually resumed', () => {
    // The developer's re-dispatch carries the same answer as the stored
    // row; it must appear once.
    const db = openDatabase(':memory:');
    try {
        seed(db);
        storeAnswer(db, 10, 'Bump anyway?', 'No, leave it alone.');
        const ctx = readTaskAgentContext(db, 'developer', 'T-1', 'develop', {
            humanAnswer: 'No, leave it alone.',
        });
        assert.equal(ctx!.clarifications?.length, 1);
        const prompt = assembleTaskAgentPrompt(ctx!);
        assert.equal(
            prompt.match(/No, leave it alone\./g)?.length,
            1,
            'the same decision must not be rendered twice',
        );
    } finally {
        db.close();
    }
});

test('an answer that has not been projected yet still reaches the resumed step', () => {
    // ClarificationAnswered and TaskResumed are different events; the
    // projection row may not exist when the StartAgent prompt is built.
    const db = openDatabase(':memory:');
    try {
        seed(db);
        const ctx = readTaskAgentContext(db, 'developer', 'T-1', 'develop', {
            humanAnswer: 'Go with option B.',
        });
        assert.match(assembleTaskAgentPrompt(ctx!), /Go with option B\./);
    } finally {
        db.close();
    }
});

test('every answer on the task accumulates — a later one does not replace the first', () => {
    const db = openDatabase(':memory:');
    try {
        seed(db);
        storeAnswer(db, 10, 'Q1?', 'Leave the version alone.');
        storeAnswer(db, 20, 'Q2?', 'Target net10.0 only.');
        const prompt = assembleTaskAgentPrompt(
            readTaskAgentContext(db, 'tester', 'T-1', 'test')!,
        );
        assert.match(prompt, /Leave the version alone\./);
        assert.match(prompt, /Target net10\.0 only\./);
    } finally {
        db.close();
    }
});

test('a task with no clarifications renders no block', () => {
    const db = openDatabase(':memory:');
    try {
        seed(db);
        const prompt = assembleTaskAgentPrompt(
            readTaskAgentContext(db, 'reviewer', 'T-1', 'review')!,
        );
        assert.doesNotMatch(prompt, CLARIFICATION_HEADING);
    } finally {
        db.close();
    }
});

test('re-inserting the same source event is a no-op (replay safety)', () => {
    // The projection folds ClarificationAnswered keyed on the event seq,
    // so a subscriber replay must not multiply the block.
    const db = openDatabase(':memory:');
    try {
        seed(db);
        const insert = (): void => {
            db.prepare(
                `INSERT OR IGNORE INTO task_clarifications
                     (event_seq, task_id, question, answer, answered_at)
                 VALUES (10, 'T-1', 'Q?', 'A.', 1)`,
            ).run();
        };
        insert();
        insert();
        const ctx = readTaskAgentContext(db, 'reviewer', 'T-1', 'review');
        assert.equal(ctx!.clarifications?.length, 1);
    } finally {
        db.close();
    }
});
