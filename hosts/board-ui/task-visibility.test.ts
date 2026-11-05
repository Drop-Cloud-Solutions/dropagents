/**
 * Active-Tasks-section membership.
 *
 * Field case DF-BRBS-014: a document task whose reviewer rejected the
 * changes went to `failed` and DISAPPEARED from the board — the filter
 * treated failed like done/skipped, so the only way to find it was to
 * open its project. A failed task is the one most likely to need the
 * operator.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { isActiveBoardTaskStatus } from './task-visibility';

test('failed tasks stay on the board (regression)', () => {
    assert.equal(isActiveBoardTaskStatus('failed', null), true);
    assert.equal(isActiveBoardTaskStatus('failed', undefined), true);
});

test('terminal states leave the active surface, even with a stale parked reason', () => {
    for (const s of ['done', 'skipped', 'archived']) {
        assert.equal(isActiveBoardTaskStatus(s, null), false, s);
        assert.equal(
            isActiveBoardTaskStatus(s, 'worktree-diff-review'),
            false,
            `${s} with a stale parkedReason must stay off the board`,
        );
    }
});

test('running, parked, approved and created tasks are visible', () => {
    for (const s of ['in_progress', 'review', 'test', 'commit', 'merge']) {
        assert.equal(isActiveBoardTaskStatus(s, null), true, s);
    }
    assert.equal(isActiveBoardTaskStatus('approved', null), true);
    assert.equal(isActiveBoardTaskStatus('created', null), true);
    assert.equal(isActiveBoardTaskStatus(undefined, null), true, 'missing status = created');
    assert.equal(isActiveBoardTaskStatus('waiting', 'waiting-deps'), true, 'any park is visible');
});

test('an unknown non-terminal status without a park is not shown', () => {
    assert.equal(isActiveBoardTaskStatus('something-else', null), false);
});
