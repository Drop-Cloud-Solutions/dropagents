/**
 * Searching the archived-plans section.
 *
 * The archive is browsed by recency — a 7-day window, extended a week
 * per "Show older" click. That answers "what did I just archive" and is
 * useless for "where is that plan about loan capping", which is what an
 * operator brings to an archive months later.
 *
 * Project scoping is deliberately absent from this module: the board
 * filters every plan through `isVisibleForCurrentProject` before
 * sectioning, so a search on a project page sees that project only and a
 * search on All projects sees everything. A second copy of that rule
 * here could disagree with the first.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import {
    filterPlansByQuery,
    isSearching,
    planHaystack,
    planMatches,
    queryTerms,
    type SearchablePlan,
} from './archived-search';

function plan(over: Partial<SearchablePlan> = {}): SearchablePlan {
    return {
        planId: 'id-1788007743262-434002',
        title: 'Import fixes',
        body: 'Add an import for the FW26 loan capping quantities CSV.',
        ...over,
    };
}

// --- terms -----------------------------------------------------------

test('a blank query yields no terms — the caller reads that as "not searching"', () => {
    // Load-bearing: an empty query must restore the recency window, not
    // match everything in a flat list.
    for (const raw of ['', '   ', '\t\n', null, undefined]) {
        assert.deepEqual(queryTerms(raw as string | null), [], JSON.stringify(raw));
        assert.equal(isSearching(raw as string | null), false);
    }
});

test('terms are lowercased and split on any whitespace', () => {
    assert.deepEqual(queryTerms('  Loan   CAPPING\tcsv '), ['loan', 'capping', 'csv']);
    assert.equal(isSearching('loan'), true);
});

// --- what is searched ------------------------------------------------

test('the BRIEF is searched, not just the title', () => {
    // The whole point: titles get shortened ("Import fixes") while the
    // brief names the actual topic.
    assert.equal(planMatches(plan(), queryTerms('capping')), true);
    assert.equal(planMatches(plan(), queryTerms('fw26')), true);
});

test('the title is searched', () => {
    assert.equal(planMatches(plan({ body: null }), queryTerms('import')), true);
});

test('the plan id is searched, so a pasted id finds its plan', () => {
    // Operators quote ids to each other; pasting one into the box should
    // land on that plan rather than nothing.
    assert.equal(planMatches(plan(), queryTerms('id-1788007743262-434002')), true);
    assert.equal(planMatches(plan(), queryTerms('434002')), true);
});

test('the plan type is searched', () => {
    const p = plan({ title: 'Nightly job', body: null, metadata: { planType: 'investigate' } });
    assert.equal(planMatches(p, queryTerms('investigate')), true);
});

test('a plan with no title and no brief simply does not match', () => {
    // Live-SSE rows can arrive before hydration fills the body. Matching
    // nothing is correct; throwing is not.
    const bare = plan({ title: null, body: null });
    assert.doesNotThrow(() => planMatches(bare, queryTerms('capping')));
    assert.equal(planMatches(bare, queryTerms('capping')), false);
    assert.equal(planMatches(bare, queryTerms('id-1788007743262')), true, 'id still matches');
});

// --- matching semantics ----------------------------------------------

test('every term must match — AND, not OR', () => {
    // OR across a long brief matches almost everything, which reads as
    // the filter being broken.
    assert.equal(planMatches(plan(), queryTerms('loan capping')), true);
    assert.equal(planMatches(plan(), queryTerms('loan tailoring')), false);
});

test('terms match in any order', () => {
    assert.equal(planMatches(plan(), queryTerms('capping loan')), true);
});

test('matching is substring, so a half-typed word narrows as you go', () => {
    for (const q of ['c', 'cap', 'cappi', 'capping']) {
        assert.equal(planMatches(plan(), queryTerms(q)), true, q);
    }
});

test('matching is case-insensitive in both directions', () => {
    assert.equal(planMatches(plan({ title: 'LOAN Capping' }), queryTerms('loan')), true);
    assert.equal(planMatches(plan(), queryTerms('LOAN')), true);
});

test('a single term cannot match across a field boundary', () => {
    // Fields are joined with a newline, not concatenated, so one term
    // cannot straddle two of them and produce a hit the operator has no
    // way to explain. Separate TERMS matching separate fields is
    // correct, and is covered above.
    const p = plan({ title: 'alpha', body: 'beta', planId: 'gamma', metadata: {} });
    assert.match(planHaystack(p), /\n/);
    assert.equal(planMatches(p, queryTerms('alphagamma')), false, 'no straddling');
    assert.equal(planMatches(p, queryTerms('alpha gamma')), true, 'both present');
});

// --- filtering a list ------------------------------------------------

const LIST: SearchablePlan[] = [
    plan({ planId: 'p-1', title: 'Loan capping import', body: 'CSV quantities.' }),
    plan({ planId: 'p-2', title: 'Tailor workflow', body: 'Unrelated.' }),
    plan({ planId: 'p-3', title: 'Capping audit', body: 'Investigate loan caps.' }),
];

test('a blank query returns everything, untouched', () => {
    // The caller then applies its recency window; returning [] here
    // would blank the archive whenever the box is empty.
    assert.equal(filterPlansByQuery(LIST, '').length, 3);
    assert.equal(filterPlansByQuery(LIST, null).length, 3);
});

test('filtering keeps only the matches, in the given order', () => {
    const out = filterPlansByQuery(LIST, 'capping');
    assert.deepEqual(out.map((p) => p.planId), ['p-1', 'p-3']);
});

test('filtering does not mutate the input', () => {
    // The caller sorts and windows the same array.
    const copy = LIST.slice();
    filterPlansByQuery(LIST, 'capping');
    assert.deepEqual(LIST, copy);
});

test('a query matching nothing returns empty, not everything', () => {
    // The fail-open bug: a filter that gives up and shows all results
    // looks like it worked and hides that there was no match.
    assert.deepEqual(filterPlansByQuery(LIST, 'zzz-no-such-topic'), []);
});
