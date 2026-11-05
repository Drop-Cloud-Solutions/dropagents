/**
 * Proposal blocks must not be shown as prose when they already have a card.
 *
 * Field report: "there is always first a complete description of the task
 * and then the create task card with the create button at the end — only
 * show the card." Both chat surfaces rendered `msg.body` verbatim and then
 * appended a card per parsed proposal, so the description arrived twice.
 *
 * The stripper mirrors the worker's `splitProposalBlocks`. These tests
 * pin that agreement: strip less than was parsed and the duplication
 * returns; strip more and prose vanishes with no card to replace it.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { stripProposalBlocks } from './chat-body';

test('the prose survives and the block goes', () => {
    const body = [
        'I looked at OrderService and the null check is missing on line 42.',
        '',
        'PROPOSE_TASK',
        'Title: Add the null check',
        'Type: implement',
        'Description: Guard the lookup in OrderService.',
        'It currently throws on an unknown id.',
    ].join('\n');

    assert.equal(
        stripProposalBlocks(body),
        'I looked at OrderService and the null check is missing on line 42.',
    );
});

test('a reply that is ONLY a proposal renders as nothing', () => {
    // The caller skips the bubble entirely — an empty one is a grey box
    // above the card.
    const body = [
        'PROPOSE_TASK',
        'Title: Add the null check',
        'Type: implement',
        'Description: Guard the lookup.',
    ].join('\n');
    assert.equal(stripProposalBlocks(body), '');
});

test('a fenced block takes its fences with it', () => {
    // The model glues the marker to the fence often enough that the
    // parser tolerates it; leaving the fences behind renders a stray ```
    // where the block used to be.
    const body = [
        'Here is what I found.',
        '',
        '```',
        'PROPOSE_ACTION',
        'Action: merge',
        'Task: T-ABCD-002',
        '```',
        '',
        'Let me know if you want anything else.',
    ].join('\n');

    const out = stripProposalBlocks(body);
    assert.ok(!out.includes('```'), `stray fence: ${JSON.stringify(out)}`);
    assert.ok(!out.includes('PROPOSE_ACTION'));
    assert.ok(out.includes('Here is what I found.'));
    assert.ok(out.includes('Let me know if you want anything else.'));
});

test('the marker glued to the fence is recognised', () => {
    const body = ['Findings above.', '```PROPOSE_ACTION', 'Action: retry', 'Task: T-1', '```']
        .join('\n');
    const out = stripProposalBlocks(body);
    assert.equal(out, 'Findings above.');
});

test('two blocks in one reply both go', () => {
    const body = [
        'Two things worth doing.',
        '',
        'PROPOSE_TASK',
        'Title: First',
        'Description: one',
        'PROPOSE_TASK',
        'Title: Second',
        'Description: two',
    ].join('\n');
    assert.equal(stripProposalBlocks(body), 'Two things worth doing.');
});

test('prose AFTER a block survives', () => {
    // A block bounded by the closing fence, with a closing remark under
    // it — the remark is the agent talking to the operator and must stay.
    const body = [
        'PROPOSE_TASK',
        'Title: Do the thing',
        'Description: details',
        '```',
        'Say the word and I will add it.',
    ].join('\n');
    assert.equal(stripProposalBlocks(body), 'Say the word and I will add it.');
});

test('a reply with no proposal is returned untouched', () => {
    const body = 'Just an answer.\n\nWith two paragraphs.\n';
    assert.equal(stripProposalBlocks(body), body);
});

test('the word PROPOSE_ inside prose does not eat the reply', () => {
    // Only a whole marker LINE starts a block — same rule the parser
    // uses, so an explanation mentioning the mechanism stays readable.
    const body = 'Emit a PROPOSE_TASK block when you want work created.';
    assert.equal(stripProposalBlocks(body), body);
});

test('blank-line runs left by the removal are collapsed', () => {
    const body = [
        'Line one.',
        '',
        'PROPOSE_TASK',
        'Title: x',
        '```',
        '',
        '',
        'Line two.',
    ].join('\n');
    assert.equal(stripProposalBlocks(body), 'Line one.\n\nLine two.');
});

test('empty and non-string input degrade quietly', () => {
    assert.equal(stripProposalBlocks(''), '');
    assert.equal(stripProposalBlocks(undefined as unknown as string), '');
    assert.equal(stripProposalBlocks(null as unknown as string), '');
});

test('a fenced sample inside a description is stripped WITH the block', () => {
    // The stripper must consume exactly what the parser consumed. When it
    // stopped at the inner fence, the code sample and everything after it
    // stayed behind as prose — rendered in the bubble beside the card that
    // was supposed to have replaced it.
    const F = '`'.repeat(3);
    const body = [
        'Here is the task:',
        'PROPOSE_TASK',
        'Title: T',
        'Description: reports Succeeded when never deployed.',
        '',
        'From a real `tst` run:',
        F,
        'app: a  status: Succeeded',
        F,
        'Acceptance: attribute per-app.',
    ].join('\n');

    assert.equal(stripProposalBlocks(body), 'Here is the task:');
});
