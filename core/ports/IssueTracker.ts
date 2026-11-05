/**
 * Port: external issue tracker (Linear, Jira, GitHub Issues, ...).
 *
 * The lifecycle interface ({@link IssueTracker}) is intentionally limited
 * to **terminal operations** — the adapter creates, closes, or skips
 * issues, and that's it. There are no `setInProgress` / `updateStatus` /
 * `setLabels` / `moveToColumn` methods on this interface.
 *
 * This is a structural guarantee, not a stylistic choice: in-flight task
 * state lives in the pipeline's own store. The tracker is treated as a
 * write-once-at-the-edges system so that swapping Linear for Jira (or any
 * future tracker) cannot accidentally start carrying mid-task state that
 * the pipeline must then keep in sync.
 *
 * **Status sync** is the one exception, and it's carved out into its own
 * port ({@link IssueStatusSync}) for the same reason. Track 4 needs the
 * adapter to surface a single human_status label so the operator board
 * stays in step with parked / ready_for_action tasks — but only the
 * label, not the full state machine. Keeping it as a separate port means
 * a tracker that doesn't support labels at all can still implement
 * {@link IssueTracker} without lying about its status-sync surface.
 *
 * Inbound webhooks / polling from a tracker are handled by the adapter
 * pushing events onto the event bus or invoking the CommandBus directly;
 * they do NOT come back through this interface.
 */
import type { DerivedStatus, HumanStatus } from '../projects/issue-status';

/** Minimal description of a project/initiative to create on the tracker. */
export interface ProjectSpec {
  readonly name: string;
  readonly description?: string;
  /** Optional short key/slug (e.g. Jira project key). */
  readonly key?: string;
}

/** Reference to a project that exists on the tracker. */
export interface ProjectRef {
  readonly id: string;
  readonly name: string;
}

/** Minimal description of an issue/task to create. */
export interface IssueSpec {
  readonly title: string;
  readonly description?: string;
  readonly projectId: string;
  readonly labels?: readonly string[];
}

/** Reference to an issue that exists on the tracker. */
export interface IssueRef {
  readonly id: string;
  readonly title: string;
}

/**
 * Error raised by an IssueTracker adapter when a write fails for a reason the
 * caller can reasonably observe (network/transport, GraphQL rejection, …).
 *
 * Adapter-specific error types (`LinearApiError`, Jira HTTP errors, …) are
 * wrapped in this class before crossing the port boundary so callers can
 * catch a single domain type without leaking infrastructure into core code.
 * The original error is preserved on {@link cause} for debugging.
 */
export class IssueTrackerError extends Error {
  override readonly name = 'IssueTrackerError';
  override readonly cause: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.cause = cause;
  }
}

export interface IssueTracker {
  /** Create a project / initiative on the tracker. */
  createProject(project: ProjectSpec): Promise<ProjectRef>;

  /** Create an issue under an existing project. */
  createIssue(issue: IssueSpec): Promise<IssueRef>;

  /**
   * Mark an issue as completed. `summary` is the human-readable wrap-up
   * (PR link, what shipped, etc.) recorded on the tracker.
   */
  closeIssue(id: string, summary: string): Promise<void>;

  /**
   * Mark an issue as skipped / won't-do. `reason` is recorded on the
   * tracker for posterity.
   */
  skipIssue(id: string, reason: string): Promise<void>;

  /**
   * Post a free-form comment onto an issue. Used by callers that want to
   * record progress / clarification / agent output on the tracker without
   * driving a state transition.
   *
   * Idempotency is the caller's responsibility: posting the same body
   * twice produces two comments by design (matches v1 behaviour). Adapter
   * failures (transport, GraphQL rejection, …) cross the port boundary as
   * {@link IssueTrackerError} so core code never has to type-check on
   * adapter-specific error classes.
   */
  postCommentToIssue(issueId: string, body: string): Promise<void>;
}

/**
 * Companion port for the narrow status-sync surface introduced in Track 4.
 *
 * Adapters that back a label-aware tracker (Linear, Jira, …) implement
 * this alongside {@link IssueTracker}. Read paths return `null` for issues
 * the adapter has filtered out (e.g. v1-era cut-list issues — see
 * `core/projects/issue-status.ts#isCutListIssue`); callers MUST treat
 * `null` as "not ours" and avoid further writes.
 *
 * Write paths are intentionally scoped to a single human_status flip per
 * call — bulk transitions are the orchestrator's job, not the tracker's.
 */
export interface IssueStatusSync {
  /**
   * Read the derived (status, human_status) for an issue from its current
   * labels + workflow state. Returns `null` when the issue is on the v1
   * cut-list and v2 should ignore it.
   */
  readIssueStatus(id: string): Promise<DerivedStatus | null>;

  /**
   * Add the `pipeline:human:<status>` label corresponding to {@link status}.
   * No-op when {@link status} has no dedicated human-flag label (e.g.
   * the stage-derived statuses — see `humanStatusLabel` in core).
   *
   * Designed for the TaskParked → `ready_for_action` flip in Track 4: the
   * adapter receives one transition at a time and is free to debounce /
   * coalesce internally if needed.
   */
  writeHumanStatus(id: string, status: HumanStatus): Promise<void>;
}
