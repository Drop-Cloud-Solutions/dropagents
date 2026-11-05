import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    parseClarification,
    outputHasClarification,
} from './clarification-parser';

test('parseClarification: canonical NEEDS_HUMAN_INPUT block', () => {
    const input = [
        'Some report text up top.',
        '',
        'NEEDS_HUMAN_INPUT',
        'Question: Which schema do we follow?',
        'Options:',
        '  A) postgres existing — keep current names',
        '  B) snake_case — rename all columns',
        '  C) cancel the task',
        '',
    ].join('\n');

    const c = parseClarification(input);
    assert.ok(c, 'expected a clarification to be returned');
    assert.equal(c!.question, 'Which schema do we follow?');
    assert.equal(c!.options.length, 3);
    assert.deepEqual(
        c!.options.map((o) => o.key),
        ['A', 'B', 'C'],
    );
    assert.equal(c!.options[0].label, 'postgres existing — keep current names');
    assert.equal(c!.options[2].label, 'cancel the task');
    assert.match(c!.raw, /NEEDS_HUMAN_INPUT/);
    assert.match(c!.raw, /Question:/);
});

test('parseClarification: outputHasClarification fast-path agrees', () => {
    const input = 'foo\nNEEDS_HUMAN_INPUT\nQuestion: x\n';
    assert.equal(outputHasClarification(input), true);
    assert.equal(outputHasClarification('totally unrelated output'), false);
    assert.equal(outputHasClarification(''), false);
});

test('parseClarification: marker is case-insensitive and tolerates markdown wrapping', () => {
    const input = [
        '## needs_human_input',
        'question: ambiguous',
        'options:',
        '  1. yes',
        '  2. no',
    ].join('\n');
    const c = parseClarification(input);
    assert.ok(c);
    assert.equal(c!.question, 'ambiguous');
    assert.deepEqual(
        c!.options.map((o) => o.key),
        ['1', '2'],
    );
});

test('parseClarification: malformed — no Question line returns null even when marker matches', () => {
    const input = 'NEEDS_HUMAN_INPUT\n\nJust some prose, no question label.\n';
    assert.equal(parseClarification(input), null);
});

test('parseClarification: malformed — empty input returns null', () => {
    assert.equal(parseClarification(''), null);
});

test('a marker GLUED to the previous sentence is still found', () => {
    // The T-PKG-005 field case, verbatim from the worker's own
    // task_step_summaries row. The committer emitted a textbook block;
    // the step summary joins the agent's assistant text blocks with no
    // separator, so the marker arrived welded to the previous sentence.
    // The old leading-newline anchor missed it, the step counted as a
    // success, the flow advanced to merge, and the task parked at
    // wait-merged with a question the board would not offer an Answer
    // button for (that is gated on reason='clarification').
    const summary = [
        "I'll help you commit these changes. Let me start by reading TASK.md"
        + ' to understand what was done, then check the git status and create'
        + ' the commit.NEEDS_HUMAN_INPUT',
        '',
        'Question: The task describes publishing Acme.Widgets.Frontend'
        + ' version 0.0.12, but the worktree has been modified to change the'
        + ' version FROM 0.0.12 TO 0.0.13. Should I commit this version bump'
        + ' to 0.0.13?',
        '',
        'Options:',
        '  A) Revert the version back to 0.0.12 and commit that',
        '  B) Commit the version bump to 0.0.13 as-is',
        '  C) Do not commit any changes (skip this task)',
    ].join('\n');

    const parsed = parseClarification(summary);
    assert.ok(parsed, 'a glued marker must still park the task');
    assert.match(parsed!.question, /Should I commit this version bump to 0\.0\.13\?/);
    assert.equal(parsed!.options.length, 3);
    assert.deepEqual(parsed!.options.map((o) => o.key), ['A', 'B', 'C']);
    assert.ok(outputHasClarification(summary), 'the fast path has to agree');
});

test('prose ABOUT the escape hatch does NOT park a healthy task', () => {
    // The leading anchor is loose now, so the trailing one carries the
    // whole false-positive burden: the marker must still END its line.
    // A false positive here parks a task that was doing fine, which is
    // why this is pinned rather than left to the regex's good nature.
    const chatty = [
        'The persona says to emit NEEDS_HUMAN_INPUT as my final message if I',
        'get stuck, but I did not get stuck, so I am not emitting one.',
        '',
        'Question: rhetorical, ignore me',
    ].join('\n');
    assert.equal(parseClarification(chatty), null);
    assert.equal(outputHasClarification(chatty), false);

    // Nor does the marker glued INSIDE a word.
    assert.equal(
        parseClarification('XNEEDS_HUMAN_INPUT\nQuestion: nope'),
        null,
    );
});

test('parseClarification: malformed — no marker returns null', () => {
    assert.equal(parseClarification('Question: x\nOptions:\n A) y\n'), null);
});

test('parseClarification: duplicate option keys are de-duplicated (first one wins)', () => {
    const input = [
        'NEEDS_HUMAN_INPUT',
        'Question: dup?',
        'Options:',
        '  A) first',
        '  A) clobber attempt',
        '  B) second',
    ].join('\n');
    const c = parseClarification(input);
    assert.ok(c);
    assert.equal(c!.options.length, 2);
    assert.equal(c!.options[0].label, 'first');
    assert.equal(c!.options[1].key, 'B');
});

test('parseClarification: stops at section headings after options block', () => {
    const input = [
        'NEEDS_HUMAN_INPUT',
        'Question: q',
        'Options:',
        '  A) one',
        '  B) two',
        '',
        '## Some Other Section',
        '  C) should be excluded',
    ].join('\n');
    const c = parseClarification(input);
    assert.ok(c);
    assert.deepEqual(
        c!.options.map((o) => o.key),
        ['A', 'B'],
    );
});

test('hard-wrapped question lines are rejoined into one sentence', () => {
    // Field case: the model wraps its output at ~78 cols; the old parser
    // kept only the first line and the Answer modal showed a fragment.
    const out = [
        'NEEDS_HUMAN_INPUT',
        'Question: My git stash collision may have left',
        ' sibling task L-LRHC-002 (and possibly L-LRHC-005/006) missing work — should',
        ' I stop so you can verify their worktrees before this task is committed?',
        'Options:',
        // String.raw, because these are Windows paths: in a normal
        // single-quoted string `\D`, `\S`, `\_` and `\ ` are unknown
        // escapes that JS silently drops, so this fixture used to read as
        // a path and BE `C:Drop-AISource_stash-collision-recovery` — the
        // backslash-handling this case exists to cover never appeared in
        // the input at all.
        String.raw`  A) Pause L-LRHC-003; you verify the worktree and restore from C:\Drop-A`,
        String.raw`I\Source\_stash-collision-recovery\ if needed`,
        '  B) Proceed to commit as-is and handle the sibling tasks separately',
        '  C) Cancel the task',
    ].join('\n');
    const parsed = parseClarification(out);
    assert.ok(parsed);
    assert.equal(
        parsed!.question,
        'My git stash collision may have left sibling task L-LRHC-002 (and possibly '
        + 'L-LRHC-005/006) missing work — should I stop so you can verify their '
        + 'worktrees before this task is committed?',
    );
    assert.equal(parsed!.options.length, 3);
    // The wrapped continuation of option A is glued back on.
    assert.ok(parsed!.options[0]!.label.includes(
        String.raw`C:\Drop-A I\Source\_stash-collision-recovery\ if needed`,
    ));
    assert.equal(parsed!.options[2]!.label, 'Cancel the task');
});

test('a multi-paragraph question keeps its paragraph break', () => {
    const out = [
        'NEEDS_HUMAN_INPUT',
        'Question: First paragraph line one',
        'line two.',
        '',
        'Second paragraph.',
        'Options:',
        '  A) go',
        '  B) stop',
    ].join('\n');
    const parsed = parseClarification(out);
    assert.ok(parsed);
    assert.equal(parsed!.question, 'First paragraph line one line two.\n\nSecond paragraph.');
});
