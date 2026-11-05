/**
 * Structured ticket fields (goal / acceptance criteria / file impact) —
 * migration 027. Covers the agent-facing rendering seams: the assembled
 * prompt and the tasks-row read that feeds it.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { applyMigrations, openDatabase } from '../../core/state/migrations';
import { assembleTaskAgentPrompt, readTaskAgentContext } from './handlers';

const BASE_CTX = {
    role: 'developer',
    taskId: 'T-X-001',
    stepId: 'develop',
    title: 'Rework handler',
    description: 'The brief paragraphs stay verbatim.',
    type: 'implement',
    planId: 'plan-x',
    planName: 'Plan X',
    latestPlanContent: null,
} as const;

test('prompt renders Goal / File impact / Acceptance criteria around the untouched brief', () => {
    const prompt = assembleTaskAgentPrompt({
        ...BASE_CTX,
        ticketDetails: {
            goal: 'Orders can be paid in several transactions.',
            acceptanceCriteria: ['criterion A', 'criterion B'],
            filesToCreate: ['src/New.cs'],
            filesToModify: ['src/Old.cs'],
            filesToDelete: ['src/Gone.cs'],
        },
    });
    assert.ok(prompt.includes('# Goal\nOrders can be paid in several transactions.'));
    assert.ok(prompt.includes('# Task\nThe brief paragraphs stay verbatim.'));
    assert.ok(prompt.includes('# File impact'));
    assert.ok(prompt.includes('Create:\n- src/New.cs'));
    assert.ok(prompt.includes('Modify:\n- src/Old.cs'));
    assert.ok(prompt.includes('Delete:\n- src/Gone.cs'));
    assert.ok(prompt.includes('# Acceptance criteria'));
    assert.ok(prompt.includes('- [ ] criterion A'));
    assert.ok(prompt.includes('- [ ] criterion B'));
    // Goal precedes the brief; criteria follow it.
    assert.ok(prompt.indexOf('# Goal') < prompt.indexOf('# Task'));
    assert.ok(prompt.indexOf('# Task') < prompt.indexOf('# Acceptance criteria'));
});

test('prompt without ticketDetails is byte-identical to the pre-027 shape', () => {
    const prompt = assembleTaskAgentPrompt({ ...BASE_CTX });
    assert.ok(!prompt.includes('# Goal'));
    assert.ok(!prompt.includes('# File impact'));
    assert.ok(!prompt.includes('# Acceptance criteria'));
    assert.ok(prompt.includes('# Task\nThe brief paragraphs stay verbatim.'));
});

test('readTaskAgentContext parses tasks.ticket_details and tolerates NULL / garbage', () => {
    const db = openDatabase(':memory:');
    try {
        applyMigrations(db);
        const insert = db.prepare(
            `INSERT INTO tasks(id, plan_id, type, status, title, description, ticket_details)
             VALUES (?, 'plan-x', 'implement', 'created', 'T', 'D', ?)`,
        );
        insert.run('T-1', JSON.stringify({
            goal: 'G',
            acceptanceCriteria: ['a'],
        }));
        insert.run('T-2', null);
        insert.run('T-3', '{not json');

        const withDetails = readTaskAgentContext(db, 'developer', 'T-1', 'develop');
        assert.equal(withDetails?.ticketDetails?.goal, 'G');
        assert.deepEqual(withDetails?.ticketDetails?.acceptanceCriteria, ['a']);

        const withoutDetails = readTaskAgentContext(db, 'developer', 'T-2', 'develop');
        assert.equal(withoutDetails?.ticketDetails, undefined);

        const garbage = readTaskAgentContext(db, 'developer', 'T-3', 'develop');
        assert.equal(garbage?.ticketDetails, undefined);
    } finally {
        db.close();
    }
});
