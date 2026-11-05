/**
 * Field report: a task created from a plan chat had its description cut
 * off. What the operator saw on L-IIFD-025 ended at:
 *
 *     From a real `tst` run:
 *
 * — the very line before a fenced log sample. Everything from that fence
 * onward was gone: the evidence AND the acceptance criteria under it. The
 * agents then came back asking questions the description had answered.
 *
 * The block splitter ended a block at the first bare fence, which is
 * right for a block the model WRAPPED in one and wrong for a fence inside
 * the description. Both shapes are real, so the rule is fence parity: an
 * even number of fences pair up into code samples (content), an odd one
 * leaves a stray closer (a terminator).
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { splitProposalBlocks } from './proposal-blocks';

/** Built at runtime so the fixtures never contain a literal fence. */
const F = '`'.repeat(3);
const LF = '\n';

test('a fenced code sample inside an UNWRAPPED description is content', () => {
    const blocks = splitProposalBlocks([
        'PROPOSE_TASK',
        'Title: Fix environment summary attribution',
        'Description: reports Succeeded when never deployed.',
        '',
        'From a real `tst` run:',
        '',
        F,
        'app: a  status: Succeeded',
        F,
        '',
        'Acceptance: attribute per-app, not per-repo.',
    ].join(LF));

    assert.equal(blocks.length, 1);
    const body = blocks[0]!.lines.join(LF);
    assert.ok(body.includes('From a real'), 'the lead-in survives');
    assert.ok(body.includes('status: Succeeded'), 'the evidence survives');
    assert.ok(body.includes('Acceptance:'), 'the criteria under it survive');
});

test('a WRAPPED block still ends at its closing fence', () => {
    // The other real shape: prose after the block is the agent talking to
    // the operator and must not be swallowed into the task.
    const blocks = splitProposalBlocks([
        F,
        'PROPOSE_TASK',
        'Title: T',
        'Description: details',
        F,
        'Say the word and I will add it.',
    ].join(LF));

    assert.equal(blocks.length, 1);
    assert.equal(blocks[0]!.wrapped, true);
    assert.deepEqual(blocks[0]!.lines, ['Title: T', 'Description: details']);
});

test('a marker GLUED to its fence counts as wrapped', () => {
    const blocks = splitProposalBlocks([
        F + 'PROPOSE_TASK',
        'Title: T',
        'Description: details',
        F,
        'Trailing prose.',
    ].join(LF));

    assert.equal(blocks[0]!.wrapped, true);
    assert.deepEqual(blocks[0]!.lines, ['Title: T', 'Description: details']);
});

test('an UNWRAPPED block closed by a stray fence still ends there', () => {
    // One unmatched fence — the model closed a wrapper it never opened.
    // Odd parity, so it terminates and the closing remark stays prose.
    const blocks = splitProposalBlocks([
        'PROPOSE_TASK',
        'Title: T',
        'Description: details',
        F,
        'Say the word and I will add it.',
    ].join(LF));

    assert.equal(blocks[0]!.wrapped, false);
    assert.deepEqual(blocks[0]!.lines, ['Title: T', 'Description: details']);
});

test('a tagged fence opens a code sample the same way a bare one does', () => {
    // ```log ... ``` is two fences: even parity, so it is content.
    const blocks = splitProposalBlocks([
        'PROPOSE_TASK',
        'Description: see the output.',
        F + 'log',
        'line of output',
        F,
        'Acceptance: parse it.',
    ].join(LF));

    const body = blocks[0]!.lines.join(LF);
    assert.ok(body.includes('line of output'));
    assert.ok(body.includes('Acceptance:'));
});

test('a following marker ends the block regardless of fences', () => {
    // Multi-proposal replies must still split, and the first block must
    // not swallow the second.
    const blocks = splitProposalBlocks([
        'PROPOSE_TASK',
        'Description: first, with a sample:',
        F,
        'sample',
        F,
        'PROPOSE_TASK',
        'Description: second.',
    ].join(LF));

    assert.equal(blocks.length, 2);
    assert.ok(blocks[0]!.lines.join(LF).includes('sample'));
    assert.ok(blocks[1]!.lines.join(LF).includes('second.'));
});

test('endIndex points just past the block, at the wrapper fence', () => {
    // The stripper removes exactly what the parser consumed using this.
    const lines = [
        F,
        'PROPOSE_TASK',
        'Description: details',
        F,
        'after',
    ];
    const blocks = splitProposalBlocks(lines.join(LF));
    assert.equal(lines[blocks[0]!.endIndex], F);
});

test('a reply with no markers yields no blocks', () => {
    assert.deepEqual(splitProposalBlocks('Just prose.\n\nWith a paragraph.'), []);
});
