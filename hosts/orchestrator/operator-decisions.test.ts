/**
 * Clarification answers must outlive the step that asked the question.
 *
 * Field case: an agent asked the operator to settle something that
 * conflicted with the task statement. The operator answered, the
 * developer implemented the answer, and the reviewer rejected the work
 * for not matching the task statement — it had never been told.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import {
    mergeClarifications,
    renderClarificationBlock,
} from './operator-decisions';

test('the durable rows and the step-scoped answer merge without duplicating', () => {
    // Both sources describe the same answer: the projection row and the
    // `humanAnswer` the engine threaded onto the resumed step. Their
    // arrival order is not guaranteed, so both are read — but the agent
    // must not see the same decision twice.
    const merged = mergeClarifications(
        [{ question: 'Bump the version?', answer: 'No — leave it alone' }],
        'No — leave it alone',
    );
    assert.equal(merged.length, 1);
    assert.equal(merged[0]!.question, 'Bump the version?');
});

test('a live answer with no row yet still reaches the prompt', () => {
    const merged = mergeClarifications([], 'go with option B');
    assert.deepEqual(merged, [{ question: null, answer: 'go with option B' }]);
});

test('a stored answer survives with no live answer — the whole point', () => {
    // This is the reviewer's case: it was handed no humanAnswer at all.
    const merged = mergeClarifications(
        [{ question: 'Bump the version?', answer: 'No' }],
        undefined,
    );
    assert.equal(merged.length, 1);
    assert.equal(merged[0]!.answer, 'No');
});

test('every answer accumulates, oldest first', () => {
    const merged = mergeClarifications(
        [
            { question: 'Q1', answer: 'A1' },
            { question: 'Q2', answer: 'A2' },
        ],
        'A3',
    );
    assert.deepEqual(merged.map((m) => m.answer), ['A1', 'A2', 'A3']);
});

test('blank and whitespace answers are dropped', () => {
    assert.deepEqual(mergeClarifications([{ question: 'Q', answer: '  ' }], ''), []);
    assert.deepEqual(mergeClarifications([], '   '), []);
});

// ---------------------------------------------------------------------------

test('the block states that the answer beats the ticket', () => {
    const block = renderClarificationBlock(
        [{ question: 'Bump the version?', answer: 'No — leave it alone' }],
    );
    assert.match(block, /^# Human clarification/);
    assert.match(block, /BINDING/);
    // The precedence sentence is the payload: without it the reviewer
    // sees the answer and still measures against the criteria.
    assert.match(block, /acceptance criteria/i);
    assert.match(block, /Bump the version\?/);
    assert.match(block, /No — leave it alone/);
});

test('the heading stays "Human clarification" — every persona promises it', () => {
    // agents/_shared/clarification-block.md tells every agent the answer
    // arrives "in a HUMAN CLARIFICATION section". Renaming the heading
    // would silently break that contract for all 20 personas.
    assert.match(
        renderClarificationBlock([{ question: null, answer: 'x' }], '#'),
        /^# Human clarification/,
    );
    assert.match(
        renderClarificationBlock([{ question: null, answer: 'x' }], '##'),
        /^## Human clarification/,
    );
});

test('multiple answers are numbered; a single one is not', () => {
    const one = renderClarificationBlock([{ question: 'Q', answer: 'A' }]);
    assert.doesNotMatch(one, /^1\. /m);
    const many = renderClarificationBlock([
        { question: 'Q1', answer: 'A1' },
        { question: 'Q2', answer: 'A2' },
    ]);
    assert.match(many, /1\. \*\*Q:\*\* Q1/);
    assert.match(many, /2\. \*\*Q:\*\* Q2/);
});

test('an answer with no recorded question still renders', () => {
    const block = renderClarificationBlock([{ question: null, answer: 'option B' }]);
    assert.match(block, /\*\*Operator's answer:\*\* option B/);
});

test('nothing to say renders nothing', () => {
    assert.equal(renderClarificationBlock([]), '');
});
