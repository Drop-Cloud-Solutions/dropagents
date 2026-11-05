/**
 * Port: issue tracker contract for the AP-VP6 surface.
 *
 * This is a thin, AP-VP6-shaped surface intended to be satisfied by both
 * the in-memory fake and the real Linear adapter introduced in the same
 * track. It is intentionally orthogonal to the legacy
 * {@link import('./IssueTracker').IssueTracker} port: that one models
 * terminal lifecycle operations against a v1 tracker; this one models
 * the four verbs the v6 flow engine actually drives on a per-task basis
 * (create, status-label flip, comment, lookup by pipeline task id).
 *
 * Method shapes mirror the names listed in the AP-VP6-002 plan:
 *
 *   createIssue(task)                 — register a new issue for a task
 *   updateStatusLabel(issueRef, label) — flip a single status label
 *   comment(issueRef, body)            — post a free-form comment
 *   getIssueByTaskId(taskId)           — look up an existing issue
 *
 * All values are pure types — no runtime code, no implementations.
 */

/**
 * Inputs required to register a new tracker issue for a pipeline task.
 *
 * `taskId` is the pipeline-side identifier the adapter is expected to
 * persist alongside the created issue so {@link IssueTracker.getIssueByTaskId}
 * can resolve it back later. The remaining fields are surfaced on the
 * tracker UI.
 */
export interface TaskIssueSpec {
  readonly taskId: string;
  readonly title: string;
  readonly description?: string;
  /** Optional initial labels applied at creation time. */
  readonly labels?: readonly string[];
  /** Optional project / initiative the issue should live under. */
  readonly projectId?: string;
}

/**
 * Reference to an issue that exists on the tracker. Adapters are free to
 * carry additional provider-specific fields, but the port only commits
 * to id + title.
 */
export interface IssueRef {
  readonly id: string;
  readonly title: string;
}

/**
 * Status label flipped by {@link IssueTracker.updateStatusLabel}. The
 * vocabulary is the operator-facing `pipeline:human:*` slug (created,
 * approved, in_progress, review, testing, ready_to_commit,
 * ready_for_action, ready_to_merge, done) — the adapter is responsible
 * for mapping the slug onto whatever native label / state the underlying
 * tracker exposes.
 */
export type StatusLabel = string;

export interface IssueTracker {
  /** Create a new issue on the tracker for the supplied pipeline task. */
  createIssue(task: TaskIssueSpec): Promise<IssueRef>;

  /**
   * Replace the issue's pipeline status label with {@link label}. The
   * adapter is expected to clear any prior `pipeline:human:*` label on
   * the issue before applying the new one so a single human_status is
   * visible at any time.
   */
  updateStatusLabel(issueRef: IssueRef, label: StatusLabel): Promise<void>;

  /**
   * Post a free-form comment onto the issue. Idempotency is the
   * caller's responsibility: a second call with the same body produces
   * a second comment by design.
   */
  comment(issueRef: IssueRef, body: string): Promise<void>;

  /**
   * Resolve an existing tracker issue by the pipeline task id it was
   * created against. Returns `null` when no issue is recorded for the
   * task — callers must treat absence as "not yet created" rather than
   * an error condition.
   */
  getIssueByTaskId(taskId: string): Promise<IssueRef | null>;
}
