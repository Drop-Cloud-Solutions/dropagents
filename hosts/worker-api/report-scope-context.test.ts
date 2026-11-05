/**
 * What a report-scoped chat session puts in front of the agent.
 *
 * A scoped chat gets its specificity from the CONTEXT BLOCK, not from a
 * persona — plan and design chats both run on `agents/chat.CLAUDE.md`
 * and differ only in what this function hands them. So for a report chat
 * this block is the whole feature: get it wrong and the agent answers
 * confidently about the project at large while the operator reads a
 * report on screen and assumes it is being discussed.
 *
 * Two properties matter most:
 *  - the report has to be found the SAME way the View-report modal and
 *    the Implement button find it (event first, step summary second),
 *    or the chat discusses a different report than the one displayed;
 *  - a task with no report must yield NO block, so the session falls
 *    back to the generic state block rather than pretending.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { applyMigrations, openDatabase, type Db } from '../../core/state/migrations';
import { buildScopeContextBlock } from './main';

function freshDb(): Db {
    const db = openDatabase(':memory:');
    applyMigrations(db);
    return db;
}

function seedTask(db: Db, row: {
    id: string;
    type?: string;
    title?: string;
    description?: string;
    planId?: string;
    repoId?: string;
}): void {
    db.prepare(
        `INSERT INTO tasks(id, plan_id, type, flow_id, status, title, description, repo_id)
         VALUES (@id, @planId, @type, @type, 'done', @title, @description, @repoId)`,
    ).run({
        id: row.id,
        planId: row.planId ?? 'plan-1',
        type: row.type ?? 'investigate',
        title: row.title ?? 'Why is the import slow?',
        description: row.description ?? null,
        repoId: row.repoId ?? null,
    });
}

function seedReportEvent(db: Db, taskId: string, answer: string, seq = 1): void {
    db.prepare(
        `INSERT INTO events(seq, type, v, idempotency_key, payload, occurred_at)
         VALUES (@seq, 'InvestigationCompleted', 1, @key, @payload, 1)`,
    ).run({
        seq,
        key: `investigation:${taskId}:${seq}`,
        payload: JSON.stringify({ taskId, answer }),
    });
}

const scope = (taskId: string): { scopeKind: string; scopeId: string } =>
    ({ scopeKind: 'report', scopeId: taskId });

// --- finding the report ----------------------------------------------

test('the report body reaches the agent', () => {
    const db = freshDb();
    seedTask(db, { id: 'T-1' });
    seedReportEvent(db, 'T-1', '# Findings\nThe cache key omits the tenant id.');

    const block = buildScopeContextBlock(db, scope('T-1'));

    assert.ok(block, 'a block was built');
    assert.match(block, /The cache key omits the tenant id/);
    assert.match(block, /T-1/, 'names the task it is scoped to');
});

test('the NEWEST report wins when a task was re-run', () => {
    // reportId is an event seq and changes on re-run; the task id is what
    // survives, so the lookup must order by seq like the read-side store.
    const db = freshDb();
    seedTask(db, { id: 'T-1' });
    seedReportEvent(db, 'T-1', 'stale finding', 1);
    seedReportEvent(db, 'T-1', 'current finding', 2);

    const block = buildScopeContextBlock(db, scope('T-1'))!;

    assert.match(block, /current finding/);
    assert.doesNotMatch(block, /stale finding/);
});

test('a report recorded only as a step summary is still found', () => {
    // review-codebase / code-review tasks never emit
    // InvestigationCompleted — their report lives only here. Without this
    // fallback their chat would open with no report at all.
    const db = freshDb();
    seedTask(db, { id: 'T-2', type: 'review-codebase' });
    db.prepare(
        `INSERT INTO task_step_summaries(
             task_id, step_id, role, status, started_at, finished_at, summary)
         VALUES ('T-2', 'review', 'codebase-reviewer', 'complete', 1, 5,
                 'Three layering violations.')`,
    ).run();

    const block = buildScopeContextBlock(db, scope('T-2'));

    assert.ok(block);
    assert.match(block, /Three layering violations/);
});

test('another task\'s report is never picked up', () => {
    const db = freshDb();
    seedTask(db, { id: 'T-1' });
    seedReportEvent(db, 'T-OTHER', 'someone else\'s findings', 1);

    assert.equal(buildScopeContextBlock(db, scope('T-1')), undefined);
});

// --- failing closed ---------------------------------------------------

test('a task with no report yields NO block', () => {
    // Better the generic state block than a scoped frame with nothing in
    // it, which reads to the model as "the report is empty".
    const db = freshDb();
    seedTask(db, { id: 'T-3' });

    assert.equal(buildScopeContextBlock(db, scope('T-3')), undefined);
});

test('an unknown task yields NO block', () => {
    assert.equal(buildScopeContextBlock(freshDb(), scope('nope')), undefined);
});

test('an unknown scope kind yields NO block', () => {
    const db = freshDb();
    seedTask(db, { id: 'T-1' });
    seedReportEvent(db, 'T-1', 'findings');

    assert.equal(
        buildScopeContextBlock(db, { scopeKind: 'nonsense', scopeId: 'T-1' }),
        undefined,
    );
});

// --- what the block TELLS the agent ----------------------------------

test('the agent is told the report is a record it cannot revise', () => {
    // The plan and design scopes both invite an edit proposal. A report
    // is finished output — there is no document here to rewrite, and an
    // agent that proposes one produces a chip the pane never renders.
    const db = freshDb();
    seedTask(db, { id: 'T-1' });
    seedReportEvent(db, 'T-1', 'findings');

    const block = buildScopeContextBlock(db, scope('T-1'))!;

    assert.match(block, /cannot/i);
    assert.match(block, /no document here to revise/i);
});

test('the agent is told how to act on a finding, and to wait to be asked', () => {
    // PROPOSE_TASK is the route, but a report that RECOMMENDS work is not
    // an operator who ASKED for it — proposing on sight would put a chip
    // under every answer.
    const db = freshDb();
    seedTask(db, { id: 'T-1' });
    seedReportEvent(db, 'T-1', 'findings');

    const block = buildScopeContextBlock(db, scope('T-1'))!;

    assert.match(block, /PROPOSE_TASK/);
    assert.match(block, /not merely because the report recommends it/i);
});

test('the original question travels with the report', () => {
    // "Did it actually answer what I asked?" is a question the operator
    // brings to a report, and it needs both halves.
    const db = freshDb();
    seedTask(db, {
        id: 'T-1',
        description: 'Find out why the nightly import takes 40 minutes.',
    });
    seedReportEvent(db, 'T-1', 'findings');

    const block = buildScopeContextBlock(db, scope('T-1'))!;

    assert.match(block, /nightly import takes 40 minutes/);
});

test('an earlier follow-up exchange is included exactly once', () => {
    // readThread appends the report as the last assistant turn; without
    // the dedup the model reads the whole report twice.
    const db = freshDb();
    seedTask(db, { id: 'T-1' });
    const answer = 'UNIQUE-REPORT-BODY';
    seedReportEvent(db, 'T-1', answer);

    const block = buildScopeContextBlock(db, scope('T-1'))!;
    const occurrences = block.split(answer).length - 1;

    assert.equal(occurrences, 1, 'the report body appears once, not twice');
});
