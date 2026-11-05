/**
 * Field report: "Create PR" failed four times with
 *   "PR creation did not land — check the worker log for the gh pr create
 *    error (gh auth, branch already has an open PR, etc.)."
 * and the log contained no such error — because gh was never run. One
 * millisecond before each failure sat the real reason, at info level:
 *   "task-worktrees: no commits ahead of base — skipping push/PR".
 *
 * The committer had been cut off (a Claude usage limit) leaving
 * uncommitted work in the worktree, so the branch had nothing to PR. The
 * operator was sent to check gh auth for a problem that had nothing to do
 * with gh.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { describePostCommitOutcome } from './task-worktrees';

test('no commits names the branch, the base, and the likely cause', () => {
    const text = describePostCommitOutcome({
        kind: 'no-commits',
        branch: 'task/L-DNMS-004',
        base: 'main',
    });

    assert.match(text, /no commits/);
    assert.match(text, /task\/L-DNMS-004/);
    assert.match(text, /main/);
    // The operator's actual next step, which the old message never
    // mentioned: the work may still be sitting uncommitted.
    assert.match(text, /uncommitted/);
    // And it must NOT send them to gh, which was never invoked.
    assert.doesNotMatch(text, /gh auth/);
});

test('a real gh failure still names gh', () => {
    const text = describePostCommitOutcome({
        kind: 'pr-failed',
        error: 'GraphQL: A pull request already exists for task/L-1',
    });
    assert.match(text, /gh pr create failed/);
    assert.match(text, /already exists/);
});

test('a push failure is reported as a push failure', () => {
    const text = describePostCommitOutcome({
        kind: 'push-failed',
        error: 'permission denied',
    });
    assert.match(text, /[Pp]ush/);
    assert.match(text, /permission denied/);
});

test('a task with no worktree says so instead of blaming gh', () => {
    const text = describePostCommitOutcome({ kind: 'no-worktree' });
    assert.match(text, /no git worktree/);
    assert.doesNotMatch(text, /gh/);
});

test('an unparseable gh success is distinguishable from a gh failure', () => {
    // These need different operator responses: one is "gh broke", the
    // other is "gh worked but we could not read its output".
    const text = describePostCommitOutcome({
        kind: 'pr-url-unparseable',
        stdout: 'Warning: something\n',
    });
    assert.match(text, /no PR URL/);
});

test('the success case reports the PR number', () => {
    const text = describePostCommitOutcome({
        kind: 'pr-opened',
        prUrl: 'https://github.com/o/r/pull/12',
        prNumber: 12,
    });
    assert.match(text, /#12/);
});
