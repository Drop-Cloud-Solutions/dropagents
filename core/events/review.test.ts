import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    ReviewEvents,
    reviewApproved,
    reviewRejected,
    reviewRequested,
    type ReviewApprovedPayload,
    type ReviewRejectedPayload,
    type ReviewRequestedPayload,
} from './review';

test('ReviewEvents declares the three lifecycle types as string literals', () => {
    assert.equal(ReviewEvents.REQUESTED, 'ReviewRequested');
    assert.equal(ReviewEvents.APPROVED, 'ReviewApproved');
    assert.equal(ReviewEvents.REJECTED, 'ReviewRejected');
});

test('reviewRequested produces an Event with taskId-derived idempotency key', () => {
    const payload: ReviewRequestedPayload = {
        taskId: 't-42',
        reviewerRole: 'reviewer',
        sourceBranch: 'feature/x',
    };
    const ev = reviewRequested(payload, 1_700_000_000_000);
    assert.equal(ev.type, 'ReviewRequested');
    assert.equal(ev.v, 1);
    assert.equal(ev.occurredAt, 1_700_000_000_000);
    assert.equal(ev.idempotencyKey, 'ReviewRequested:t-42');
    assert.deepEqual(ev.payload, payload);
});

test('reviewApproved produces an Event with role + taskId payload', () => {
    const payload: ReviewApprovedPayload = {
        taskId: 't-7',
        reviewerRole: 'reviewer',
    };
    const ev = reviewApproved(payload, 1_700_000_000_500);
    assert.equal(ev.type, 'ReviewApproved');
    assert.equal(ev.idempotencyKey, 'ReviewApproved:t-7');
    assert.deepEqual(ev.payload, payload);
});

test('reviewRejected carries the reasons array on its payload', () => {
    const payload: ReviewRejectedPayload = {
        taskId: 't-9',
        reviewerRole: 'reviewer',
        reasons: ['missing test', 'unsafe sql concat'],
    };
    const ev = reviewRejected(payload, 1_700_000_001_000);
    assert.equal(ev.type, 'ReviewRejected');
    assert.equal(ev.idempotencyKey, 'ReviewRejected:t-9');
    const got = ev.payload as ReviewRejectedPayload;
    assert.deepEqual(got.reasons, ['missing test', 'unsafe sql concat']);
});

test('idempotency keys collide on identical taskId so the store dedupes', () => {
    const a = reviewRequested(
        { taskId: 't-1', reviewerRole: 'reviewer', sourceBranch: 'b' },
        1,
    );
    const b = reviewRequested(
        { taskId: 't-1', reviewerRole: 'reviewer', sourceBranch: 'b2' },
        2,
    );
    assert.equal(a.idempotencyKey, b.idempotencyKey);
});
