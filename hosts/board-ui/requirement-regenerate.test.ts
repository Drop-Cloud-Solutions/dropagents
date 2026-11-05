/**
 * The architect modal's regenerate control.
 *
 * It used to be a button that opened `window.prompt()`. The operator
 * asked for the textbox to live on the modal instead, ten rows, with the
 * button beside it — because guidance for the architect is a paragraph,
 * and a prompt gives one unstyled line that covers the very design you
 * are trying to comment on.
 *
 * What is asserted here is the part with rules in it: WHICH statuses
 * offer a regenerate, what it is called in each, and the revision it
 * dispatches against. The DOM assembly stays in board.ts — it needs a
 * real document and the modal's close hook, and a shim for it would test
 * the shim.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import {
    describeRegenerateSection,
    nextRegenerateRevision,
    REGENERATE_FEEDBACK_CLASS,
    REGENERATE_ROWS,
} from './requirement-regenerate';

// --- which statuses offer it -----------------------------------------

test('a proposed design can be regenerated', () => {
    const spec = describeRegenerateSection('proposed');
    assert.ok(spec);
    assert.match(spec!.buttonLabel, /^Regenerate$/);
});

test('a stuck architecting run can be re-run', () => {
    // The architect finished but emitted nothing usable; without this
    // the requirement sits in `architecting` forever.
    const spec = describeRegenerateSection('architecting');
    assert.ok(spec);
    assert.match(spec!.buttonLabel, /Re-run/);
});

test('the two cases are worded differently', () => {
    // Both bump the revision and re-spawn the agent, so the wording is
    // the only thing telling the operator which situation they are in.
    const proposed = describeRegenerateSection('proposed')!;
    const stuck = describeRegenerateSection('architecting')!;
    assert.notEqual(proposed.heading, stuck.heading);
    assert.notEqual(proposed.buttonLabel, stuck.buttonLabel);
    assert.notEqual(proposed.hint, stuck.hint);
});

test('no other status offers a regenerate', () => {
    // An approved requirement has already fanned out into plans and a
    // regenerate would strand them; an archived one is closed. A button
    // that would do damage is worse than no button.
    for (const status of ['approved', 'archived', 'draft', 'verifying', '', 'PROPOSED']) {
        assert.equal(describeRegenerateSection(status), null, status);
    }
});

// --- the textarea ----------------------------------------------------

test('the textarea is ten rows', () => {
    // The operator asked for ten. A three-row box is what made the
    // prompt feel like the lesser evil.
    assert.equal(REGENERATE_ROWS, 10);
});

test('both cases carry a placeholder that says the text is optional', () => {
    // Regenerating with no feedback is legitimate — "try again" is a
    // valid instruction — and the box must not read as required.
    for (const status of ['proposed', 'architecting']) {
        assert.match(describeRegenerateSection(status)!.placeholder, /optional/i, status);
    }
});

test('the feedback class is a single shared constant', () => {
    // It is both the style hook and the selector the modal refresh uses
    // to carry typed-but-unsent text across a rebuild. Two literals that
    // drifted apart would silently stop preserving the operator's text.
    assert.equal(REGENERATE_FEEDBACK_CLASS, 'requirement-modal__regenerate-feedback');
});

// --- the revision ----------------------------------------------------

test('a regenerate always dispatches against the NEXT revision', () => {
    // RegenerateArchitecture keys on it to decide whether to re-spawn;
    // re-sending the current revision is a no-op that reads to the
    // operator as a dead button.
    assert.equal(nextRegenerateRevision(1), 2);
    assert.equal(nextRegenerateRevision(7), 8);
});

test('a missing or nonsense revision degrades to 2, never NaN', () => {
    // NaN crosses the wire as null and fails validation server-side,
    // with nothing useful on screen to explain it.
    for (const bad of [null, undefined, NaN, 0, -3, Infinity]) {
        assert.equal(nextRegenerateRevision(bad as number | null), 2, String(bad));
    }
    assert.equal(nextRegenerateRevision(3.7), 4, 'a fractional revision is floored first');
});
