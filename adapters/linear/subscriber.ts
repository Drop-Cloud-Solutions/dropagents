/**
 * Linear lifecycle subscriber.
 *
 * Translates the four pipeline lifecycle events into IssueTracker calls,
 * registered under the named subscriber `linear-tracker` so its offset is
 * persisted and a restart replays anything published while the process
 * was down.
 *
 *   PlanApproved   → tracker.createProject(...)
 *   TaskCreated    → tracker.createIssue(...)
 *   TaskFinished   → tracker.closeIssue(id, summary)
 *   TaskSkipped    → tracker.skipIssue(id, reason)
 *
 * Local→Linear resolution goes through the supplied `ExternalRefs`
 * reader/writer; the tracker writes mappings on successful create, the
 * subscriber reads them on subsequent events.
 *
 * Failure handling: when an adapter call throws (after the transport's
 * own retry budget has been exhausted), the subscriber publishes a
 * `LinearWriteFailed` event and SWALLOWS the original error. Re-throwing
 * would stall the subscriber's offset and cause the same event to be
 * re-delivered on every replay, drowning the system. Recording the
 * failure as an event keeps the loop moving while still surfacing the
 * problem to anything monitoring `LinearWriteFailed`.
 */
import type { EventBus } from '../../core/events/bus';
import type { Event, StoredEvent } from '../../core/events/event';
import type { IssueStatusSync, IssueTracker, Logger } from '../../core/ports';

import type { ExternalRefsWriter } from './LinearTracker';

/** Named subscriber id under which all four handlers register. */
export const LINEAR_SUBSCRIBER = 'linear-tracker';

/** Event-type constants the subscriber subscribes to / publishes. */
export const LinearEvents = {
  PLAN_APPROVED: 'PlanApproved',
  TASK_CREATED: 'TaskCreated',
  TASK_FINISHED: 'TaskFinished',
  TASK_SKIPPED: 'TaskSkipped',
  /**
   * Track 4 — same TaskParked event the flow engine publishes from both
   * the wait-* steps and the clarification path. The subscriber flips
   * the issue's `pipeline:human:ready_for_action` label regardless of
   * which `reason` discriminator the payload carries.
   */
  TASK_PARKED: 'TaskParked',
  LINEAR_WRITE_FAILED: 'LinearWriteFailed'
} as const;

export interface TaskParkedPayload {
  readonly taskId: string;
  readonly stepId?: string;
  /** Discriminator from the flow engine — informational only here. */
  readonly reason?: 'wait-action' | 'wait-merged' | 'clarification';
  readonly question?: string;
}

/** Read side of the `external_refs` table, scoped to system='linear'. */
export interface ExternalRefsReader {
  read(localId: string): string | undefined;
}

export interface PlanApprovedPayload {
  readonly planId: string;
  readonly projectId?: string;
  readonly name?: string;
  readonly description?: string;
}

export interface TaskCreatedPayload {
  readonly taskId: string;
  readonly planId: string;
  readonly type: string;
  readonly flowId?: string;
  readonly title?: string;
  readonly description?: string;
  readonly labels?: ReadonlyArray<string>;
}

/**
 * The TaskFinished payload may carry a free-form summary string OR a richer
 * `{ prUrl, text }` shape — the subscriber accepts both and composes the
 * description fragment passed to closeIssue.
 */
export interface TaskFinishedPayload {
  readonly taskId: string;
  readonly summary?: TaskFinishedSummary | string;
  readonly prUrl?: string;
}

export interface TaskFinishedSummary {
  readonly text?: string;
  readonly prUrl?: string;
}

export interface TaskSkippedPayload {
  readonly taskId: string;
  readonly reason?: string;
}

export interface LinearWriteFailedPayload {
  readonly sourceEventType: string;
  readonly sourceEventSeq: number;
  readonly localId?: string;
  readonly error: string;
}

export interface LinearSubscriberDeps {
  readonly bus: EventBus;
  readonly tracker: IssueTracker;
  readonly externalRefs: ExternalRefsReader & ExternalRefsWriter;
  readonly clock: () => number;
  readonly logger?: Logger;
  /**
   * Optional status-sync surface. When supplied, the subscriber also
   * subscribes to `TaskParked` and flips `pipeline:human:ready_for_action`
   * on the mapped issue. Omitted in tests that only exercise the
   * lifecycle path; the four core handlers (PlanApproved / TaskCreated /
   * TaskFinished / TaskSkipped) keep working without it.
   */
  readonly statusSync?: IssueStatusSync;
}

/**
 * Attach the four lifecycle handlers to the bus. Returns an `unsubscribe`
 * that detaches every handler — useful for tests and graceful shutdown.
 */
export function registerLinearSubscriber(deps: LinearSubscriberDeps): () => void {
  const { bus } = deps;
  const unsubs = [
    bus.subscribe<PlanApprovedPayload>(
      LinearEvents.PLAN_APPROVED,
      (event) => handlePlanApproved(event, deps),
      { subscriber: LINEAR_SUBSCRIBER }
    ),
    bus.subscribe<TaskCreatedPayload>(
      LinearEvents.TASK_CREATED,
      (event) => handleTaskCreated(event, deps),
      { subscriber: LINEAR_SUBSCRIBER }
    ),
    bus.subscribe<TaskFinishedPayload>(
      LinearEvents.TASK_FINISHED,
      (event) => handleTaskFinished(event, deps),
      { subscriber: LINEAR_SUBSCRIBER }
    ),
    bus.subscribe<TaskSkippedPayload>(
      LinearEvents.TASK_SKIPPED,
      (event) => handleTaskSkipped(event, deps),
      { subscriber: LINEAR_SUBSCRIBER }
    )
  ];
  if (deps.statusSync) {
    unsubs.push(
      bus.subscribe<TaskParkedPayload>(
        LinearEvents.TASK_PARKED,
        (event) => handleTaskParked(event, deps),
        { subscriber: LINEAR_SUBSCRIBER }
      )
    );
  }
  return () => unsubs.forEach((u) => u());
}

async function handleTaskParked(
  event: StoredEvent & { payload: TaskParkedPayload },
  deps: LinearSubscriberDeps
): Promise<void> {
  const { taskId } = event.payload;
  const issueId = deps.externalRefs.read(taskId);
  if (!issueId) {
    // No Linear issue mapped yet — nothing to flip. Surface as a
    // write-failed event so it stays visible, but don't stall the offset.
    await publishWriteFailed(
      event,
      taskId,
      new Error(`No Linear issue mapped for task ${taskId}`),
      deps
    );
    return;
  }
  try {
    // Reason is intentionally ignored: any parking reason gets the same
    // ready_for_action flag so the board shows a single "needs action" lane.
    await deps.statusSync!.writeHumanStatus(issueId, 'ready_for_action');
  } catch (err) {
    await publishWriteFailed(event, taskId, err, deps);
  }
}

async function handlePlanApproved(
  event: StoredEvent & { payload: PlanApprovedPayload },
  deps: LinearSubscriberDeps
): Promise<void> {
  const { planId } = event.payload;
  // Idempotent: if the plan is already mapped, the previous create succeeded
  // (possibly in a prior process) and we must not create a duplicate project.
  if (deps.externalRefs.read(planId)) return;
  try {
    await deps.tracker.createProject({
      name: event.payload.name ?? `Plan ${planId}`,
      description: event.payload.description,
      key: planId
    });
  } catch (err) {
    await publishWriteFailed(event, planId, err, deps);
  }
}

async function handleTaskCreated(
  event: StoredEvent & { payload: TaskCreatedPayload },
  deps: LinearSubscriberDeps
): Promise<void> {
  const { taskId, planId } = event.payload;
  if (deps.externalRefs.read(taskId)) return;
  const projectId = deps.externalRefs.read(planId);
  if (!projectId) {
    await publishWriteFailed(event, taskId, new Error(`No Linear project mapped for plan ${planId}`), deps);
    return;
  }
  try {
    const ref = await deps.tracker.createIssue({
      title: event.payload.title ?? `Task ${taskId}`,
      description: event.payload.description,
      projectId,
      labels: event.payload.labels
    });
    // Tracker may also write the ref when localId is supplied via the
    // LinearIssueSpec extension, but the port-level signature doesn't
    // require it — so the subscriber writes here too as the canonical record.
    deps.externalRefs.write(taskId, ref.id);
  } catch (err) {
    await publishWriteFailed(event, taskId, err, deps);
  }
}

async function handleTaskFinished(
  event: StoredEvent & { payload: TaskFinishedPayload },
  deps: LinearSubscriberDeps
): Promise<void> {
  const { taskId } = event.payload;
  const issueId = deps.externalRefs.read(taskId);
  if (!issueId) {
    await publishWriteFailed(event, taskId, new Error(`No Linear issue mapped for task ${taskId}`), deps);
    return;
  }
  try {
    await deps.tracker.closeIssue(issueId, composeSummary(event.payload));
  } catch (err) {
    await publishWriteFailed(event, taskId, err, deps);
  }
}

async function handleTaskSkipped(
  event: StoredEvent & { payload: TaskSkippedPayload },
  deps: LinearSubscriberDeps
): Promise<void> {
  const { taskId } = event.payload;
  const issueId = deps.externalRefs.read(taskId);
  if (!issueId) {
    await publishWriteFailed(event, taskId, new Error(`No Linear issue mapped for task ${taskId}`), deps);
    return;
  }
  try {
    await deps.tracker.skipIssue(issueId, event.payload.reason ?? 'Skipped');
  } catch (err) {
    await publishWriteFailed(event, taskId, err, deps);
  }
}

/**
 * Build the description-fragment string that closeIssue appends to the
 * Linear issue's description. Accepts both the rich `{ prUrl, text }`
 * shape and the flat string fallback so the subscriber stays robust to
 * payload-format drift.
 */
function composeSummary(payload: TaskFinishedPayload): string {
  const summary = payload.summary;
  if (typeof summary === 'string') {
    return payload.prUrl ? `${summary}\n\nPR: ${payload.prUrl}` : summary;
  }
  const parts: string[] = [];
  if (summary?.text) parts.push(summary.text);
  const prUrl = summary?.prUrl ?? payload.prUrl;
  if (prUrl) parts.push(`PR: ${prUrl}`);
  return parts.join('\n\n');
}

async function publishWriteFailed(
  source: StoredEvent,
  localId: string | undefined,
  err: unknown,
  deps: LinearSubscriberDeps
): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  deps.logger?.error('linear-tracker: write failed', {
    sourceEventType: source.type,
    sourceEventSeq: source.seq,
    localId: localId ?? null,
    error: message
  });
  const payload: LinearWriteFailedPayload = {
    sourceEventType: source.type,
    sourceEventSeq: source.seq,
    localId,
    error: message
  };
  const failure: Event = {
    type: LinearEvents.LINEAR_WRITE_FAILED,
    v: 1,
    occurredAt: deps.clock(),
    // Deterministic per source event so replay is a true no-op at the store.
    idempotencyKey: `linear-write-failed:${source.type}:${source.seq}`,
    payload
  };
  await deps.bus.publish(failure);
}
