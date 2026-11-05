/**
 * Jira shadow-mode subscriber.
 *
 * Mirrors the four pipeline lifecycle events into best-effort Jira writes
 * AFTER the authoritative Linear handler has run. Registered under the
 * named subscriber `jira-shadow` so its offset is persisted across
 * restarts the same way `linear-tracker` is.
 *
 *   PlanApproved   → tracker.createProject(...)
 *   TaskCreated    → tracker.createIssue(...)
 *   TaskFinished   → tracker.closeIssue(id, summary)
 *   TaskSkipped    → tracker.skipIssue(id, reason)  ← always throws NotImplemented
 *
 * Shadow-mode invariants:
 *
 *   1. Linear remains authoritative. The subscriber NEVER publishes a
 *      "JiraWriteFailed"-style event onto the bus — that would let a Jira
 *      outage cascade into the event log and downstream consumers.
 *   2. Failures are caught at the handler boundary, written to a
 *      shadow-diff log file, and swallowed. The subscriber's offset
 *      advances normally so a restart does not replay the same failing
 *      event.
 *   3. Ordering — register `linear-tracker` first, then this subscriber.
 *      Node's EventEmitter dispatches listeners in registration order, so
 *      the Linear write completes (or fails) before the Jira mirror is
 *      attempted.
 *
 * Local→Jira id resolution goes through the supplied `externalRefs`
 * reader/writer; the subscriber writes mappings on successful create and
 * reads them on subsequent lifecycle events.
 */
import * as fs from 'fs';
import * as path from 'path';

import type { EventBus } from '../../core/events/bus';
import type { StoredEvent } from '../../core/events/event';
import type { IssueTracker, Logger } from '../../core/ports';

/** Named subscriber id under which all four handlers register. */
export const JIRA_SHADOW_SUBSCRIBER = 'jira-shadow';

/** Default path for the shadow-diff log, relative to the repo root. */
export const DEFAULT_SHADOW_DIFF_LOG_RELPATH = 'shared/.cache/jira-shadow-diff.log';

/** Event-type constants the subscriber subscribes to. */
export const JiraShadowEvents = {
  PLAN_APPROVED: 'PlanApproved',
  TASK_CREATED: 'TaskCreated',
  TASK_FINISHED: 'TaskFinished',
  TASK_SKIPPED: 'TaskSkipped'
} as const;

export interface PlanApprovedPayload {
  readonly planId: string;
  readonly projectId?: string;
  readonly name?: string;
  readonly description?: string;
}

export interface TaskCreatedPayload {
  readonly taskId: string;
  readonly planId: string;
  readonly type?: string;
  readonly flowId?: string;
  readonly title?: string;
  readonly description?: string;
  readonly labels?: ReadonlyArray<string>;
}

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

/** Read+write surface over the Jira-system rows of `external_refs`. */
export interface JiraExternalRefs {
  read(localId: string): string | undefined;
  write(localId: string, externalId: string): void;
}

export type ShadowDiffOperation =
  | 'createProject'
  | 'createIssue'
  | 'closeIssue'
  | 'skipIssue'
  | 'resolve';

export interface ShadowDiffEntry {
  readonly at: number;
  readonly sourceEventType: string;
  readonly sourceEventSeq: number;
  readonly operation: ShadowDiffOperation;
  readonly localId?: string;
  readonly error: string;
}

export interface ShadowDiffLog {
  write(entry: ShadowDiffEntry): void;
}

/**
 * File-backed shadow-diff sink. Creates the parent directory on demand and
 * appends one JSON object per line. Any I/O failure is swallowed — the diff
 * log is a debug aid, not a correctness gate.
 */
export function createFileShadowDiffLog(filePath: string): ShadowDiffLog {
  const dir = path.dirname(filePath);
  return {
    write(entry: ShadowDiffEntry): void {
      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.appendFileSync(filePath, JSON.stringify(entry) + '\n', { encoding: 'utf8' });
      } catch {
        // intentional: a broken diff log must not crash the subscriber.
      }
    }
  };
}

export interface JiraShadowSubscriberDeps {
  readonly bus: EventBus;
  readonly tracker: IssueTracker;
  readonly externalRefs: JiraExternalRefs;
  readonly shadowDiffLog: ShadowDiffLog;
  readonly clock: () => number;
  readonly logger?: Logger;
  /**
   * Named subscriber identity used for offset persistence. Defaults to
   * `JIRA_SHADOW_SUBSCRIBER` ('jira-shadow'). Override when reusing the
   * generic shadow plumbing for a different tracker — e.g. the Linear
   * shadow path registers the same handlers under 'linear-shadow' when
   * `pipeline.yaml` has `issue_tracker: jira, issue_tracker_shadow: linear`.
   */
  readonly subscriberName?: string;
}

/**
 * Attach the four shadow handlers to the bus. Returns an `unsubscribe`
 * that detaches every handler — useful for tests and graceful shutdown.
 *
 * Must be called AFTER `registerLinearSubscriber` so Linear's listener
 * runs first within Node's EventEmitter dispatch loop.
 */
export function registerJiraShadowSubscriber(deps: JiraShadowSubscriberDeps): () => void {
  const { bus } = deps;
  const subscriberName = deps.subscriberName ?? JIRA_SHADOW_SUBSCRIBER;
  const unsubs = [
    bus.subscribe<PlanApprovedPayload>(
      JiraShadowEvents.PLAN_APPROVED,
      (event) => handlePlanApproved(event, deps),
      { subscriber: subscriberName }
    ),
    bus.subscribe<TaskCreatedPayload>(
      JiraShadowEvents.TASK_CREATED,
      (event) => handleTaskCreated(event, deps),
      { subscriber: subscriberName }
    ),
    bus.subscribe<TaskFinishedPayload>(
      JiraShadowEvents.TASK_FINISHED,
      (event) => handleTaskFinished(event, deps),
      { subscriber: subscriberName }
    ),
    bus.subscribe<TaskSkippedPayload>(
      JiraShadowEvents.TASK_SKIPPED,
      (event) => handleTaskSkipped(event, deps),
      { subscriber: subscriberName }
    )
  ];
  return () => unsubs.forEach((u) => u());
}

async function handlePlanApproved(
  event: StoredEvent & { payload: PlanApprovedPayload },
  deps: JiraShadowSubscriberDeps
): Promise<void> {
  const { planId, name, description } = event.payload;
  if (deps.externalRefs.read(planId)) return;
  try {
    const ref = await deps.tracker.createProject({
      name: name ?? `Plan ${planId}`,
      description,
      key: planId
    });
    deps.externalRefs.write(planId, ref.id);
  } catch (err) {
    recordDiff(event, 'createProject', planId, err, deps);
  }
}

async function handleTaskCreated(
  event: StoredEvent & { payload: TaskCreatedPayload },
  deps: JiraShadowSubscriberDeps
): Promise<void> {
  const { taskId, planId } = event.payload;
  if (deps.externalRefs.read(taskId)) return;
  const projectId = deps.externalRefs.read(planId);
  if (!projectId) {
    recordDiff(
      event,
      'resolve',
      taskId,
      new Error(`No Jira project mapped for plan ${planId}`),
      deps
    );
    return;
  }
  try {
    const ref = await deps.tracker.createIssue({
      title: event.payload.title ?? `Task ${taskId}`,
      description: event.payload.description,
      projectId,
      labels: event.payload.labels
    });
    deps.externalRefs.write(taskId, ref.id);
  } catch (err) {
    recordDiff(event, 'createIssue', taskId, err, deps);
  }
}

async function handleTaskFinished(
  event: StoredEvent & { payload: TaskFinishedPayload },
  deps: JiraShadowSubscriberDeps
): Promise<void> {
  const { taskId } = event.payload;
  const issueId = deps.externalRefs.read(taskId);
  if (!issueId) {
    recordDiff(
      event,
      'resolve',
      taskId,
      new Error(`No Jira issue mapped for task ${taskId}`),
      deps
    );
    return;
  }
  try {
    await deps.tracker.closeIssue(issueId, composeSummary(event.payload));
  } catch (err) {
    recordDiff(event, 'closeIssue', taskId, err, deps);
  }
}

async function handleTaskSkipped(
  event: StoredEvent & { payload: TaskSkippedPayload },
  deps: JiraShadowSubscriberDeps
): Promise<void> {
  const { taskId } = event.payload;
  const issueId = deps.externalRefs.read(taskId);
  if (!issueId) {
    recordDiff(
      event,
      'resolve',
      taskId,
      new Error(`No Jira issue mapped for task ${taskId}`),
      deps
    );
    return;
  }
  try {
    // Expected to throw NotImplementedError — the catch below records the
    // diff and swallows. The point is to surface the abstraction leak in
    // the diff log without letting it stall the event chain.
    await deps.tracker.skipIssue(issueId, event.payload.reason ?? 'Skipped');
  } catch (err) {
    recordDiff(event, 'skipIssue', taskId, err, deps);
  }
}

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

function recordDiff(
  source: StoredEvent,
  operation: ShadowDiffOperation,
  localId: string | undefined,
  err: unknown,
  deps: JiraShadowSubscriberDeps
): void {
  const message = err instanceof Error ? err.message : String(err);
  deps.logger?.warn('jira-shadow: write diverged from Linear', {
    sourceEventType: source.type,
    sourceEventSeq: source.seq,
    operation,
    localId: localId ?? null,
    error: message
  });
  deps.shadowDiffLog.write({
    at: deps.clock(),
    sourceEventType: source.type,
    sourceEventSeq: source.seq,
    operation,
    localId,
    error: message
  });
}
