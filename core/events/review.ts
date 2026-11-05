/**
 * Review lifecycle events.
 *
 * A code-review task transitions through three discrete bus events:
 *
 *   ReviewRequested  — emitted before the reviewer agent starts. Carries the
 *                      role chosen by the flow (always `reviewer` today, but
 *                      held as a field so future flows can target a different
 *                      role without breaking subscribers) and the branch the
 *                      reviewer should look at.
 *   ReviewApproved   — emitted when the reviewer signals "ship it".
 *   ReviewRejected   — emitted when the reviewer rejects, carrying a list of
 *                      reasons so the chat bridge and downstream subscribers
 *                      can render them without re-parsing the agent stream.
 *
 * Factories below stamp `v: 1` and a deterministic idempotency key derived
 * from `taskId`. Re-publishing the same event for the same task is a no-op
 * at the EventStore level (UNIQUE constraint on idempotency_key), so callers
 * never need to dedupe themselves.
 */

import type { Event } from './event';

export const ReviewEvents = {
    REQUESTED: 'ReviewRequested',
    APPROVED: 'ReviewApproved',
    REJECTED: 'ReviewRejected',
} as const;

export interface ReviewRequestedPayload {
    readonly taskId: string;
    readonly reviewerRole: string;
    readonly sourceBranch: string;
}

export interface ReviewApprovedPayload {
    readonly taskId: string;
    readonly reviewerRole: string;
}

export interface ReviewRejectedPayload {
    readonly taskId: string;
    readonly reviewerRole: string;
    readonly reasons: readonly string[];
}

export function reviewRequested(
    payload: ReviewRequestedPayload,
    occurredAt: number,
): Event {
    return {
        type: ReviewEvents.REQUESTED,
        v: 1,
        occurredAt,
        idempotencyKey: `${ReviewEvents.REQUESTED}:${payload.taskId}`,
        payload,
    };
}

export function reviewApproved(
    payload: ReviewApprovedPayload,
    occurredAt: number,
): Event {
    return {
        type: ReviewEvents.APPROVED,
        v: 1,
        occurredAt,
        idempotencyKey: `${ReviewEvents.APPROVED}:${payload.taskId}`,
        payload,
    };
}

export function reviewRejected(
    payload: ReviewRejectedPayload,
    occurredAt: number,
): Event {
    return {
        type: ReviewEvents.REJECTED,
        v: 1,
        occurredAt,
        idempotencyKey: `${ReviewEvents.REJECTED}:${payload.taskId}`,
        payload,
    };
}
