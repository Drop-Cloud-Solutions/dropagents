/**
 * Field report: "the home page shows the open tasks per plan; when a lot
 * of plans are running tasks it is hard to see when a task needs
 * attention (approval, failure, answer)."
 *
 * The counts row (`3 done · 2 in-progress · 1 todo`) folds "an agent is
 * working" and "this has been waiting on you for an hour" into the same
 * number, so the operator had to open plans one by one to find the stuck
 * one.
 *
 * The badge is only worth having if it is accurate. One that lights up on
 * `waiting-deps` — which resolves itself the moment its upstream finishes
 * — would be lit on most of a healthy board and ignored within a day, so
 * the exclusions below matter as much as the inclusions.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import {
    planAttention,
    taskAttentionKind,
    type AttentionTaskLike,
} from './plan-attention';

function task(over: Partial<AttentionTaskLike> = {}): AttentionTaskLike {
    return { planId: 'pl-1', status: 'in_progress', parkedReason: null, ...over };
}

test('an approval gate needs attention', () => {
    assert.equal(taskAttentionKind(task({ parkedReason: 'approval' })), 'approval');
});

test('an unanswered question needs attention', () => {
    assert.equal(taskAttentionKind(task({ parkedReason: 'clarification' })), 'question');
});

test('a failed task needs attention', () => {
    assert.equal(taskAttentionKind(task({ status: 'failed' })), 'failed');
});

test('an operator REJECTION counts as failed', () => {
    // Rejecting leaves the task failed with the reason in `feedback`, and
    // Retry is the way out — same affordance, same badge.
    assert.equal(
        taskAttentionKind(task({ status: 'failed', feedback: 'wrong approach' })),
        'failed',
    );
});

test('a diff review and a mergeable PR both need attention', () => {
    assert.equal(taskAttentionKind(task({ parkedReason: 'worktree-diff-review' })), 'review');
    assert.equal(
        taskAttentionKind(task({ parkedReason: 'wait-merged', prUrl: 'https://gh/pr/1' })),
        'merge',
    );
});

test('a commit that never reached GitHub is FAILED, not "awaiting merge"', () => {
    // Such a task IS parked at wait-merged, but "merge the PR" is the
    // wrong prompt when there is no PR — its card says "Retry push & PR".
    // A badge that disagrees with the card's own button is worse than no
    // badge.
    assert.equal(
        taskAttentionKind(task({ parkedReason: 'wait-merged', prUrl: null })),
        'failed',
    );
    assert.equal(
        taskAttentionKind(task({
            parkedReason: 'wait-merged',
            prUrl: 'https://gh/pr/1',
            commitError: 'push rejected',
        })),
        'failed',
    );
});

test('waiting-deps does NOT need attention', () => {
    // It starts itself when its upstream finishes. Flagging it would
    // light up most of a healthy board.
    assert.equal(taskAttentionKind(task({ parkedReason: 'waiting-deps' })), null);
});

test('a working agent does NOT need attention', () => {
    for (const status of ['in_progress', 'review', 'test', 'commit', 'merge', 'pending']) {
        assert.equal(taskAttentionKind(task({ status })), null, status);
    }
});

test('closed tasks need nothing, even if they were parked when they closed', () => {
    for (const status of ['done', 'skipped', 'archived']) {
        assert.equal(taskAttentionKind(task({ status })), null, status);
        // A stale parkedReason on a finished task must not resurrect it.
        assert.equal(
            taskAttentionKind(task({ status, parkedReason: 'approval' })),
            null,
            `${status} + stale park`,
        );
    }
});

test('planAttention ignores tasks belonging to other plans', () => {
    // Callers pass the whole board's task list unfiltered.
    const out = planAttention('pl-1', [
        task({ planId: 'pl-2', parkedReason: 'approval' }),
        task({ planId: 'pl-3', status: 'failed' }),
    ]);
    assert.equal(out.needsAttention, false);
    assert.equal(out.severity, 'none');
    assert.deepEqual(out.reasons, []);
});

test('a plan with nothing waiting reports no attention', () => {
    const out = planAttention('pl-1', [
        task({ status: 'in_progress' }),
        task({ status: 'done' }),
        task({ parkedReason: 'waiting-deps' }),
    ]);
    assert.equal(out.needsAttention, false);
    assert.equal(out.summary, '');
});

test('a failure outranks a waiting gate for the badge colour', () => {
    // Red vs amber: an approval gate is the pipeline working as designed,
    // and colouring it like a fault trains the operator to ignore both.
    const out = planAttention('pl-1', [
        task({ parkedReason: 'approval' }),
        task({ status: 'failed' }),
    ]);
    assert.equal(out.severity, 'failed');
});

test('only-waiting tasks get the amber severity', () => {
    const out = planAttention('pl-1', [task({ parkedReason: 'clarification' })]);
    assert.equal(out.severity, 'waiting');
});

test('the summary counts each kind and leads with the worst', () => {
    // The tooltip is the whole point: it tells the operator WHICH plan to
    // open without opening any of them.
    const out = planAttention('pl-1', [
        task({ parkedReason: 'approval' }),
        task({ parkedReason: 'approval' }),
        task({ status: 'failed' }),
        task({ parkedReason: 'clarification' }),
    ]);

    assert.equal(out.needsAttention, true);
    assert.deepEqual(out.reasons, [
        { kind: 'failed', count: 1 },
        { kind: 'question', count: 1 },
        { kind: 'approval', count: 2 },
    ]);
    assert.equal(
        out.summary,
        '4 tasks need you: 1 failed, 1 awaiting an answer, 2 awaiting approval',
    );
});

test('a single task reads in the singular', () => {
    const out = planAttention('pl-1', [task({ parkedReason: 'approval' })]);
    assert.equal(out.summary, '1 task needs you: 1 awaiting approval');
});

test('an empty board is handled', () => {
    assert.equal(planAttention('pl-1', []).needsAttention, false);
});
