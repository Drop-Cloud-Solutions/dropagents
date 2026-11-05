/**
 * The plan modal's document sections.
 *
 * Field report: "when a plan goes to ready I can no longer see my
 * original request."
 *
 * It was deliberate — the code said "render that in place of the
 * operator's original brief" — and wrong at exactly the moment it
 * matters: a Ready plan is the one you review against the request it
 * came from, and the request was the thing that had gone.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import {
    planBodySections,
    shouldCollapseRequest,
    REQUEST_COLLAPSE_LINES,
} from './plan-body-sections';

const BRIEF = 'Add an import for the FW26 loan capping quantities.';
const PLAN = '## Approach\n\n1. Parse the CSV\n2. Validate\n';

// --- the reported bug -------------------------------------------------

test('a Ready plan shows the request AND the plan', () => {
    // Was: only the implementation plan, with the request replaced.
    const sections = planBodySections(PLAN, BRIEF);

    assert.equal(sections.length, 2);
    assert.deepEqual(sections.map((s) => s.kind), ['request', 'plan']);
});

test('the request comes FIRST — input then output', () => {
    // The order they are checked in: "this is what I asked for, this is
    // what came back."
    const [first, second] = planBodySections(PLAN, BRIEF);

    assert.equal(first?.kind, 'request');
    assert.equal(first?.markdown, BRIEF);
    assert.equal(second?.markdown, PLAN);
});

test('the request heading is the operator\'s word for it', () => {
    // `Brief` is this project's internal term — the `# Brief` header in
    // the planner prompt. The operator went looking for their "original
    // request", and this is the screen they looked on.
    assert.equal(planBodySections(PLAN, BRIEF)[0]?.heading, 'Original request');
    assert.equal(planBodySections(PLAN, BRIEF)[1]?.heading, 'Implementation plan');
});

// --- the other states -------------------------------------------------

test('a Draft plan shows the request alone', () => {
    // No planner output yet. Unchanged behaviour, except the heading.
    const sections = planBodySections(null, BRIEF);

    assert.equal(sections.length, 1);
    assert.equal(sections[0]?.kind, 'request');
});

test('a plan with no recorded brief shows the plan alone', () => {
    // Some creation paths record no brief; the modal must not render an
    // empty "Original request" heading over nothing.
    const sections = planBodySections(PLAN, null);

    assert.equal(sections.length, 1);
    assert.equal(sections[0]?.kind, 'plan');
});

test('neither present renders nothing', () => {
    assert.deepEqual(planBodySections(null, null), []);
    assert.deepEqual(planBodySections(undefined, undefined), []);
});

test('whitespace-only text counts as absent', () => {
    // A brief of "\n\n" would otherwise produce a heading with an empty
    // body under it.
    for (const blank of ['', '   ', '\n\n', '\t']) {
        assert.deepEqual(planBodySections(null, blank), [], JSON.stringify(blank));
        assert.deepEqual(planBodySections(blank, null), [], JSON.stringify(blank));
    }
});

test('markdown is passed through untouched', () => {
    // It goes to the same markdown+mermaid renderer as before; trimming
    // or reflowing it here would change how fenced blocks parse.
    const fenced = '```json\n{"a": 1}\n```\n';
    assert.equal(planBodySections(fenced, null)[0]?.markdown, fenced);
});

// --- collapsing a long request ---------------------------------------

test('a short request is NOT collapsed', () => {
    // The common case, and the whole point of the change: the operator
    // should SEE it without a click.
    assert.equal(shouldCollapseRequest(BRIEF), false);
    assert.equal(shouldCollapseRequest('one\ntwo\nthree'), false);
});

test('a long pasted request IS collapsed', () => {
    // Otherwise a page of requirements pushes the plan — the thing
    // actually under review — off the screen.
    const long = Array.from({ length: REQUEST_COLLAPSE_LINES + 1 }, (_, i) => `line ${i}`)
        .join('\n');
    assert.equal(shouldCollapseRequest(long), true);
});

test('the threshold counts LINES, not characters', () => {
    // A long single paragraph wraps to far fewer lines than its
    // character count suggests, so collapsing on length would hide
    // requests that cost almost no vertical space.
    const oneLongLine = 'x'.repeat(5000);
    assert.equal(shouldCollapseRequest(oneLongLine), false);
});

test('an absent request is never collapsed', () => {
    // There is no section to collapse.
    assert.equal(shouldCollapseRequest(null), false);
    assert.equal(shouldCollapseRequest(''), false);
});
