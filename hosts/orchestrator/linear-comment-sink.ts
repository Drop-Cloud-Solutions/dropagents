/**
 * AP-IFG-020 — linear-comment-sink.
 *
 * Cross-cutting subscriber that records a one-line narrative comment on
 * the mapped Linear issue for each lifecycle event in the seven-event
 * vocabulary v1's `pipeline/worker/chat-notify.ts` advertised:
 *
 *   TaskCreated · PlanReady · CommitReady · TaskFinished · TaskFailed
 *   · ContextUpdated · InvestigationDone
 *
 * The wording is byte-for-byte parity with v1 so the Linear audit trail
 * stays continuous across the v1 → v2 cutover. The icon glyphs match
 * `NOTIFICATION_ICON_BY_KIND` in `adapters/telegram/TelegramGateway.ts`
 * — that table is itself "lifted verbatim from v1's chat-notify.ts" so a
 * single edit there is the source of truth for both surfaces.
 *
 * # Idempotency
 *
 * `IssueTracker.postCommentToIssue` is intentionally NOT deduplicated:
 * the same body posted twice yields two comments (matches v1, which
 * already posts duplicates on retry). Each comment built here starts
 * with a stable prefix (the kind-specific icon or verb) so an operator
 * scanning the issue can spot a duplicate emission visually without
 * needing automated dedup.
 *
 * # Failure isolation
 *
 * Each handler wraps the tracker call in try/catch and logs a single
 * `warn` line on failure. The `EventBus` already isolates handler
 * exceptions (see `core/events/bus.ts#dispatch`), but catching here
 * lets us attach the source event type + local id to the log without
 * polluting the bus-level error message. AC #4: a tracker failure must
 * never crash the orchestrator.
 *
 * # External-ref resolution
 *
 * Comments need a Linear *external* issue id; events carry the v2
 * *local* task id. The host wires an `ExternalRefsReader` scoped to
 * `system='linear'` so the same projection the lifecycle subscriber
 * uses also feeds the comment sink. When the local id has no mapping
 * (event arrived before `createIssue` resolved, or in a non-Linear
 * routing mode), the sink silently drops the comment — surfacing the
 * miss as a `LinearWriteFailed` event would risk drowning the system
 * on bursty replays. The lifecycle subscriber already raises that
 * signal where it matters.
 */
import type { EventBus } from '../../core/events/bus';
import type { StoredEvent } from '../../core/events/event';
import type { IssueTracker, Logger } from '../../core/ports';

/** Named subscriber id under which every comment handler registers. */
export const LINEAR_COMMENT_SINK_SUBSCRIBER = 'linear-comment-sink';

/**
 * The seven lifecycle event types the sink subscribes to. Names match
 * the PascalCase event types published on the EventBus — same vocabulary
 * the Track 4 lifecycle subscriber and the TelegramGateway outbound path
 * use, so wiring one new sink does not require a translation table.
 */
export const LinearCommentSinkEvents = {
    TASK_CREATED:       'TaskCreated',
    PLAN_READY:         'PlanReady',
    COMMIT_READY:       'CommitReady',
    TASK_FINISHED:      'TaskFinished',
    TASK_FAILED:        'TaskFailed',
    CONTEXT_UPDATED:    'ContextUpdated',
    INVESTIGATION_DONE: 'InvestigationDone',
} as const;

export type LinearCommentSinkEventType =
    (typeof LinearCommentSinkEvents)[keyof typeof LinearCommentSinkEvents];

/** Every supported type as an iterable for adapter constructors and tests. */
export const ALL_LINEAR_COMMENT_SINK_EVENTS: readonly LinearCommentSinkEventType[] = [
    LinearCommentSinkEvents.TASK_CREATED,
    LinearCommentSinkEvents.PLAN_READY,
    LinearCommentSinkEvents.COMMIT_READY,
    LinearCommentSinkEvents.TASK_FINISHED,
    LinearCommentSinkEvents.TASK_FAILED,
    LinearCommentSinkEvents.CONTEXT_UPDATED,
    LinearCommentSinkEvents.INVESTIGATION_DONE,
];

/**
 * Read side of the `external_refs` table scoped to `system='linear'`.
 * Mirrors the shape `adapters/linear/subscriber.ts` already uses so the
 * host can pass the same reader instance.
 */
export interface ExternalRefsReader {
    read(localId: string): string | undefined;
}

/**
 * Loose payload shape — every field optional so a missing `taskId` or
 * `reason` produces a sensible terse comment rather than throwing. The
 * type union of the seven specific payloads would be more precise but
 * adds friction for a sink that is fundamentally formatting + delegating.
 */
export interface LinearCommentSinkPayload {
    readonly taskId?: string;
    readonly planId?: string;
    readonly title?: string;
    readonly reason?: string;
    readonly prNumber?: number;
}

export interface LinearCommentSinkDeps {
    readonly bus: EventBus;
    readonly tracker: IssueTracker;
    readonly externalRefs: ExternalRefsReader;
    readonly logger?: Logger;
    /** Override subscriber name — tests use this to isolate offset rows. */
    readonly subscriberName?: string;
}

/**
 * Attach the seven lifecycle handlers under a single named subscriber so
 * a host restart replays anything posted while the process was down.
 * Returns an unsubscribe closure (tests call it on teardown so listener
 * counts stay bounded across cases).
 */
export function registerLinearCommentSink(deps: LinearCommentSinkDeps): () => void {
    const subscriberName = deps.subscriberName ?? LINEAR_COMMENT_SINK_SUBSCRIBER;
    const unsubs: Array<() => void> = [];
    for (const type of ALL_LINEAR_COMMENT_SINK_EVENTS) {
        unsubs.push(
            deps.bus.subscribe<LinearCommentSinkPayload>(
                type,
                (event) => handleEvent(type, event, deps),
                { subscriber: subscriberName },
            ),
        );
    }
    return (): void => {
        for (const u of unsubs) u();
    };
}

async function handleEvent(
    type: LinearCommentSinkEventType,
    event: StoredEvent & { payload: LinearCommentSinkPayload },
    deps: LinearCommentSinkDeps,
): Promise<void> {
    const localId = resolveLocalId(type, event.payload);
    if (!localId) return;
    const issueId = deps.externalRefs.read(localId);
    if (!issueId) return;
    const body = buildCommentBody(type, event.payload);
    try {
        await deps.tracker.postCommentToIssue(issueId, body);
    } catch (err) {
        deps.logger?.warn('linear-comment-sink: postCommentToIssue failed', {
            type,
            issueId,
            error: err instanceof Error ? err.message : String(err),
        });
    }
}

/**
 * Pick the local id whose Linear-side mapping we should comment against.
 * For task-scoped events that's `taskId`; for `PlanReady` we currently
 * have no plan-as-issue mapping in Linear, so the sink falls back to
 * `taskId` (v1's plan-ready event carries one — see the parity fixture
 * at `test/parity/chat/fixtures/chat-events.jsonl`) and drops the
 * comment silently when neither is present.
 */
function resolveLocalId(
    type: LinearCommentSinkEventType,
    payload: LinearCommentSinkPayload,
): string | undefined {
    if (type === LinearCommentSinkEvents.PLAN_READY) {
        return payload.taskId ?? payload.planId;
    }
    return payload.taskId;
}

/**
 * Render the one-line comment body. Per-kind shape is pinned by the
 * unit tests in `./linear-comment-sink.test.ts` — any drift breaks v1
 * parity, which is exactly what the tests guard against.
 *
 * The leading icon (or leading verb for the icon-less `Task*` kinds)
 * is the "stable prefix" the task brief refers to: an operator can
 * visually spot a duplicate emission without automated dedup.
 */
export function buildCommentBody(
    type: LinearCommentSinkEventType,
    payload: LinearCommentSinkPayload,
): string {
    switch (type) {
        case LinearCommentSinkEvents.TASK_CREATED:
            return `Task created: ${payload.taskId ?? ''}`;
        case LinearCommentSinkEvents.PLAN_READY: {
            const idPart = payload.planId ?? payload.taskId;
            return idPart ? `📋 Plan ready: ${idPart}` : '📋 Plan ready';
        }
        case LinearCommentSinkEvents.COMMIT_READY:
            return `💾 Commit ready: ${payload.taskId ?? ''}`;
        case LinearCommentSinkEvents.TASK_FINISHED:
            return `Task finished: ${payload.taskId ?? ''}`;
        case LinearCommentSinkEvents.TASK_FAILED:
            return payload.reason
                ? `Task failed: ${payload.taskId ?? ''} — ${payload.reason}`
                : `Task failed: ${payload.taskId ?? ''}`;
        case LinearCommentSinkEvents.CONTEXT_UPDATED:
            return typeof payload.prNumber === 'number'
                ? `📝 Context updated: ${payload.taskId ?? ''} · PR #${payload.prNumber}`
                : `📝 Context updated: ${payload.taskId ?? ''}`;
        case LinearCommentSinkEvents.INVESTIGATION_DONE:
            return `🔍 Investigation done: ${payload.taskId ?? ''}`;
    }
}
