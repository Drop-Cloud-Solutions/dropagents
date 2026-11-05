/**
 * Telling a PR blocked by CHECKS apart from a PR with CONFLICTS.
 *
 * Both of gh's messages begin "is not mergeable", which is why the
 * pipeline reported a PR whose checks had not yet finished as having
 * merge conflicts — and dispatched a merge-resolver agent at a branch
 * with nothing to resolve.
 *
 * The messages below are gh's actual wording (gh 2.89); keeping them
 * verbatim is the point of the test.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import {
    describeAutoMergeUnavailable,
    describeMergeAbandoned,
    describeMergeEnqueued,
    isAutoMergeUnavailable,
    isMergeBlockedByRequirements,
} from './merge-classify';
import { isMergeConflictFailure } from './merge-conflict-resolver';

// --- the field message ------------------------------------------------

const POLICY = 'Pull request #42 is not mergeable: the base branch policy '
    + 'prohibits the merge.\nTo have the pull request merged after all the '
    + 'requirements have been met, add the `--auto` flag.';

const CONFLICT = 'Pull request #42 is not mergeable: the merge commit cannot '
    + 'be cleanly created.\nRun the following to resolve the merge conflicts '
    + 'locally:\ngh pr checkout 42 && git fetch origin main && git merge '
    + 'origin/main';

test('the real "checks have not passed" message classifies as requirements', () => {
    assert.equal(isMergeBlockedByRequirements(POLICY), true);
});

test('the real conflict message does NOT classify as requirements', () => {
    // Waiting would never clear a conflict, so `--auto` must not be
    // offered for one.
    assert.equal(isMergeBlockedByRequirements(CONFLICT), false);
});

test('a requirements block is no longer treated as a merge conflict', () => {
    // THE BUG. `isMergeConflictFailure` matched /not mergeable/, so a
    // pending check sent a merge-resolver agent to a clean branch.
    assert.equal(isMergeConflictFailure(POLICY), false);
});

test('a real conflict still dispatches the resolver', () => {
    // The guard must not cost the feature it sits in front of.
    assert.equal(isMergeConflictFailure(CONFLICT), true);
    assert.equal(isMergeConflictFailure('CONFLICT (content): Merge conflict in a.cs'), true);
    assert.equal(isMergeConflictFailure('conflicts must be resolved before merging'), true);
});

// --- the other requirement shapes ------------------------------------

test('the GraphQL variants classify as requirements', () => {
    // Seen when gh passes the API error through rather than formatting
    // it, which happens on the merge-queue and review-policy paths.
    for (const raw of [
        'GraphQL: 4 of 5 required status checks are expected. (mergePullRequest)',
        'GraphQL: Changes requested by reviewers (mergePullRequest)',
        'GraphQL: At least 2 approving reviews are required by reviewers with write access.',
        'Pull request #7 is not mergeable: it is in an unstable state.',
        'GraphQL: Pull request is in a merge queue (mergePullRequest)',
        'GraphQL: Protected branch rules not satisfied',
    ]) {
        assert.equal(isMergeBlockedByRequirements(raw), true, raw);
    }
});

test('unrelated failures classify as neither', () => {
    // Auth, network and PATH failures must keep the plain error path:
    // queueing an auto-merge would hide a broken credential behind an
    // hour of polling.
    for (const raw of [
        'gh: Bad credentials (HTTP 401)',
        'failed to run gh: not found on PATH',
        'GraphQL: Could not resolve to a PullRequest with the number of 42.',
        'fatal: unable to access https://github.com/acme/shop.git',
    ]) {
        assert.equal(isMergeBlockedByRequirements(raw), false, raw);
        assert.equal(isMergeConflictFailure(raw), false, raw);
    }
});

test('empty input is not a requirements block', () => {
    assert.equal(isMergeBlockedByRequirements(undefined), false);
    assert.equal(isMergeBlockedByRequirements(null), false);
    assert.equal(isMergeBlockedByRequirements(''), false);
});

// --- auto-merge being unavailable ------------------------------------

test('a repo with auto-merge switched off is recognised', () => {
    // "Allow auto-merge" is a repository setting and OFF by default, so
    // this is the likely outcome on a repo nobody has configured.
    for (const raw of [
        'GraphQL: Pull request Auto merge is not allowed for this repository '
        + '(enablePullRequestAutoMerge)',
        'GraphQL: Can not enable auto-merge for this pull request',
        'auto-merge is not enabled for this repository',
    ]) {
        assert.equal(isAutoMergeUnavailable(raw), true, raw);
    }
});

test('a conflict is not mistaken for auto-merge being unavailable', () => {
    assert.equal(isAutoMergeUnavailable(CONFLICT), false);
    assert.equal(isAutoMergeUnavailable('gh: Bad credentials (HTTP 401)'), false);
});

// --- the operator-facing sentences -----------------------------------

test('the enqueued note says the pipeline will finish the task itself', () => {
    // The whole point of --auto is that the operator does nothing. If
    // the note does not say so they will sit and watch a parked card.
    const note = describeMergeEnqueued(42, POLICY);
    assert.match(note, /#42/);
    assert.match(note, /watching/i);
    assert.match(note, /Merge PR/, 'the manual fallback must still be named');
});

test('the unavailable note names the setting, not the mutation', () => {
    const note = describeAutoMergeUnavailable(42, 'GraphQL: ... (enablePullRequestAutoMerge)');
    assert.match(note, /Allow auto-merge/);
    assert.ok(
        note.indexOf('Allow auto-merge') < note.indexOf('enablePullRequestAutoMerge'),
        'the actionable sentence comes before the raw GraphQL text',
    );
});

test('every note carries GitHub\'s own words through', () => {
    // The raw message is what an operator pastes into a search, so it
    // must survive the rewrite rather than being replaced by our prose.
    assert.match(describeMergeEnqueued(42, POLICY), /base branch policy/);
    assert.match(
        describeAutoMergeUnavailable(42, 'Auto merge is not allowed'),
        /Auto merge is not allowed/,
    );
    assert.match(describeMergeAbandoned(42, 'It was still unmerged.'), /still unmerged/);
});

test('the notes stay short enough to read in a chip tooltip', () => {
    // They land in `parked_question`, which renders as a card tooltip
    // and a modal paragraph. A 4KB GraphQL dump there is unreadable.
    const huge = 'x'.repeat(5_000);
    for (const note of [
        describeMergeEnqueued(42, huge),
        describeAutoMergeUnavailable(42, huge),
        describeMergeAbandoned(42, huge.slice(0, 300)),
    ]) {
        assert.ok(note.length < 800, `too long: ${note.length}`);
    }
});

// --- "Require branches to be up to date" ------------------------------
//
// The second field incident, and the one that proved the first fix
// incomplete. Verbatim stderr from gh (Suitsupply/DescartesAPI#46), the
// run that dispatched a merge-resolver agent at a PR GitHub went on to
// merge by itself five minutes later.

const NOT_UP_TO_DATE = 'X Pull request Suitsupply/DescartesAPI#46 is not '
    + 'mergeable: the head branch is not up to date with the base branch.\n'
    + 'To have the pull request merged after all the requirements have been '
    + 'met, add the `--auto` flag.\nTo use administrator privileges to '
    + 'immediately merge the pull request, add the `--admin` flag.';

test('a branch that is merely BEHIND the base is a requirements block', () => {
    assert.equal(isMergeBlockedByRequirements(NOT_UP_TO_DATE), true);
    assert.equal(isMergeConflictFailure(NOT_UP_TO_DATE), false);
});

test('it classifies even when the `--auto` hint is cut off', () => {
    // THE BUG. `runCommand` truncated stderr at 200 characters and the
    // first line alone is 117, so the classifier only ever saw up to
    // "add the `-". Matching on gh's own wording rather than on the hint
    // is what makes this robust; the truncation is raised as well, but a
    // classifier that depends on a byte budget is a classifier that will
    // break again.
    const cut = NOT_UP_TO_DATE.slice(0, 200);
    assert.ok(!/add the `?--auto`? flag/i.test(cut), 'the hint really is gone');
    assert.equal(isMergeBlockedByRequirements(cut), true);
    assert.equal(isMergeConflictFailure(cut), false);
});

test('the ruleset wrapper is a requirements block', () => {
    // How GitHub reports a ruleset rather than classic branch protection.
    const ruleset = 'GraphQL: Repository rule violations found\n\n'
        + '2 of 2 required status checks are queued.\n\n (mergePullRequest)';
    assert.equal(isMergeBlockedByRequirements(ruleset), true);
    assert.equal(isMergeConflictFailure(ruleset), false);
});

test('a real conflict reported through the same GraphQL shape IS a conflict', () => {
    // Verbatim from the field (PR #47, same repo, same minute). This one
    // SHOULD reach the resolver — the guard must not blunt it.
    const real = 'GraphQL: Pull Request has merge conflicts (mergePullRequest)';
    assert.equal(isMergeConflictFailure(real), true);
    assert.equal(isMergeBlockedByRequirements(real), false);
});
