/**
 * Boot hydration for the decomposer roster.
 *
 * The case worth pinning: a decomposer held on a `NEEDS_HUMAN_INPUT`
 * question has ALREADY emitted a clean `AgentFinished` — it finished by
 * asking. The started-minus-terminated pairing therefore drops it, and a
 * board reload lost the card, the question, and the Answer button with it:
 * the plan just sat there with nothing to click. The question-event overlay
 * is what brings it back.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { foldRowsToActiveDecomposers } from './active-decomposers';

interface Row { type: string; occurred_at: number; payload: string }

function row(type: string, occurredAt: number, payload: unknown): Row {
    return { type, occurred_at: occurredAt, payload: JSON.stringify(payload) };
}

const started = (agentId: string, planId: string, at: number): Row =>
    row('AgentStarted', at, {
        agentId,
        metadata: { kind: 'decomposer', planId, projectId: 'proj-1' },
    });

const finished = (agentId: string, at: number): Row =>
    row('AgentFinished', at, { agentId, outcome: 'success' });

const raised = (planId: string, at: number, question: string, options?: unknown): Row =>
    row('PlanDecomposeQuestionRaised', at, {
        planId,
        projectId: 'proj-1',
        question,
        options: options ?? [],
        askedAt: at,
    });

const answered = (planId: string, at: number): Row =>
    row('PlanDecomposeQuestionAnswered', at, { planId, answer: 'yes', answeredAt: at });

test('a live run comes back as running', () => {
    const out = foldRowsToActiveDecomposers([started('a-1', 'plan-1', 100)]);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.planId, 'plan-1');
    assert.equal(out[0]!.status, 'running');
});

test('a finished run drops out', () => {
    const out = foldRowsToActiveDecomposers([
        started('a-1', 'plan-1', 100),
        finished('a-1', 200),
    ]);
    assert.deepEqual(out, []);
});

test('a run held on a question survives its own AgentFinished', () => {
    const out = foldRowsToActiveDecomposers([
        started('a-1', 'plan-1', 100),
        finished('a-1', 200),
        raised('plan-1', 210, 'Orders API or a new Billing API?', [
            { key: 'A', label: 'Extend Orders' },
            { key: 'B', label: 'New Billing API' },
        ]),
    ]);
    assert.equal(out.length, 1, 'the card must survive a reload — this is the regression');
    assert.equal(out[0]!.status, 'awaiting');
    assert.equal(out[0]!.question, 'Orders API or a new Billing API?');
    assert.equal(out[0]!.agentId, 'a-1', 'Show agent still opens the run that asked');
    assert.deepEqual(out[0]!.options, ['A) Extend Orders', 'B) New Billing API']);
    assert.equal(out[0]!.askedAt, 210);
});

test('an answered question drops the awaiting entry; the re-spawn stands on its own', () => {
    const answeredOnly = foldRowsToActiveDecomposers([
        started('a-1', 'plan-1', 100),
        finished('a-1', 200),
        raised('plan-1', 210, 'Q?'),
        answered('plan-1', 220),
    ]);
    assert.deepEqual(answeredOnly, [], 'nothing is pending once the answer lands');

    const withRespawn = foldRowsToActiveDecomposers([
        started('a-1', 'plan-1', 100),
        finished('a-1', 200),
        raised('plan-1', 210, 'Q?'),
        answered('plan-1', 220),
        started('a-2', 'plan-1', 230),
    ]);
    assert.equal(withRespawn.length, 1);
    assert.equal(withRespawn[0]!.status, 'running');
    assert.equal(withRespawn[0]!.agentId, 'a-2');
});

test('a second question after an answer is pending again', () => {
    const out = foldRowsToActiveDecomposers([
        started('a-1', 'plan-1', 100),
        finished('a-1', 200),
        raised('plan-1', 210, 'First?'),
        answered('plan-1', 220),
        started('a-2', 'plan-1', 230),
        finished('a-2', 300),
        raised('plan-1', 310, 'Second?'),
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.status, 'awaiting');
    assert.equal(out[0]!.question, 'Second?');
});

test('an awaiting overlay wins over a stale running entry for the same plan', () => {
    // The terminal event for the asking run never landed (crash between the
    // two). The question is still the truth about what the operator must do.
    const out = foldRowsToActiveDecomposers([
        started('a-1', 'plan-1', 100),
        raised('plan-1', 210, 'Q?'),
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.status, 'awaiting');
});

test('malformed option entries are skipped, not fatal', () => {
    const out = foldRowsToActiveDecomposers([
        started('a-1', 'plan-1', 100),
        finished('a-1', 200),
        raised('plan-1', 210, 'Q?', [null, 'a string', { key: 'A' }, { label: 'ok' }]),
    ]);
    assert.deepEqual(out[0]!.options, ['ok']);
});

// --- abandoning the question ------------------------------------------
//
// Field report: "I have the decomposer asking a question, one of the
// options is cancel the task, which is what I selected but the question
// keeps coming back and I have no way to dismiss the decomposer."
//
// The decomposer writes its own options, so "cancel the task" was only
// text: answering re-spawned the decomposer and it asked again. The
// escape hatch is `PlanDecomposeQuestionAbandoned`, and it has to be
// folded HERE as well as live — a reload re-derives the card from these
// rows, and without it the question comes straight back, which is the
// literal symptom.

const abandoned = (planId: string, at: number, reason?: string): Row =>
    row('PlanDecomposeQuestionAbandoned', at, {
        planId,
        projectId: 'proj-1',
        question: 'which one?',
        ...(reason !== undefined ? { reason } : {}),
        abandonedAt: at,
    });

test('an abandoned question does NOT come back on reload', () => {
    const out = foldRowsToActiveDecomposers([
        started('a-1', 'PL-1', 1),
        finished('a-1', 2),
        raised('PL-1', 3, 'which one?'),
        abandoned('PL-1', 4),
    ]);
    const mine = out.filter((d) => d.planId === 'PL-1');
    assert.ok(
        !mine.some((d) => d.status === 'awaiting'),
        `the plan must not still be awaiting; got ${JSON.stringify(mine)}`,
    );
    assert.ok(
        !mine.some((d) => typeof d.question === 'string' && d.question.length > 0),
        'and the question must not be handed back to the board',
    );
});

test('a reason on the abandon changes nothing about the fold', () => {
    const out = foldRowsToActiveDecomposers([
        started('a-1', 'PL-1', 1),
        raised('PL-1', 3, 'which one?'),
        abandoned('PL-1', 4, 'not worth decomposing'),
    ]);
    assert.ok(!out.some((d) => d.status === 'awaiting'));
});

test('abandoning one plan leaves another plan still awaiting', () => {
    // The scoping that matters: giving up on one question must not
    // silently clear every other plan held on one.
    const out = foldRowsToActiveDecomposers([
        started('a-1', 'PL-1', 1),
        raised('PL-1', 2, 'first?'),
        abandoned('PL-1', 3),
        started('a-2', 'PL-2', 4),
        raised('PL-2', 5, 'second?'),
    ]);
    assert.ok(
        out.some((d) => d.planId === 'PL-2' && d.status === 'awaiting'),
        'PL-2 is still waiting on its operator',
    );
    assert.ok(!out.some((d) => d.planId === 'PL-1' && d.status === 'awaiting'));
});

test('a question raised AFTER an abandon is pending again', () => {
    // Abandoning retires one question, not the plan's ability to ask
    // another: re-decomposing is exactly what the operator does next.
    const out = foldRowsToActiveDecomposers([
        started('a-1', 'PL-1', 1),
        raised('PL-1', 2, 'first?'),
        abandoned('PL-1', 3),
        started('a-2', 'PL-1', 4),
        raised('PL-1', 5, 'second?'),
    ]);
    const mine = out.find((d) => d.planId === 'PL-1');
    assert.equal(mine?.status, 'awaiting');
    assert.equal(mine?.question, 'second?');
});
