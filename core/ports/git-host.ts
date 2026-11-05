/**
 * Port: pull-request operations against a remote git host (GitHub, ...).
 *
 * This is the AP-VP6-shaped surface for the merge half of the flow
 * engine. It is intentionally narrower than the legacy
 * {@link import('./pull-request-gateway').PullRequestGateway}: that
 * port carries `push`, `openPullRequest`, `mergePullRequest`, and
 * `addComment` with v1-style method names and untyped errors; this one
 * keeps `openPr` / `commentOnPr` / `mergePr` plus a discriminated
 * {@link GitHostError} union so callers can react structurally to the
 * four failure modes the flow engine actually has to handle.
 *
 * Implementations are expected to throw a value satisfying
 * {@link GitHostError} on failure. The discriminator (`kind`) is the
 * primary narrowing field; the `message` field carries human-readable
 * detail to surface in operator-facing UI and logs.
 *
 * All values are pure types — no runtime code, no implementations.
 */

/** Method by which a PR is merged on the host side. */
export type MergeMethod = 'squash' | 'merge' | 'rebase';

/** Inputs to {@link GitHostPort.openPr}. */
export interface OpenPrSpec {
  readonly title: string;
  readonly body?: string;
  /** Target branch (usually `main` / `master`). */
  readonly base: string;
  /** Source branch carrying the changes. */
  readonly head: string;
  /** Optional draft flag — adapters that do not support drafts may ignore. */
  readonly draft?: boolean;
}

/** Identity of a pull request that exists on the host. */
export interface PrRef {
  readonly number: number;
  readonly url: string;
}

/** Options for {@link GitHostPort.mergePr}. */
export interface MergePrOptions {
  readonly method: MergeMethod;
  /** Optional commit subject for `squash` / `merge` strategies. */
  readonly commitSubject?: string;
  /** Optional commit body for `squash` / `merge` strategies. */
  readonly commitBody?: string;
}

/**
 * Auth credentials (token, gh CLI session, ...) the adapter needs are
 * missing or have expired. The flow engine surfaces this as a parked
 * task awaiting operator action — no retry is attempted because retrying
 * without fresh credentials will keep failing in the same way.
 */
export interface GitHostAuthMissingError {
  readonly kind: 'AuthMissing';
  readonly message: string;
}

/**
 * The local branch the caller wants to operate on has not been pushed
 * to the remote. Distinguished from a generic transport failure so the
 * flow engine can re-dispatch a push step instead of bouncing the task
 * into operator-action.
 */
export interface GitHostBranchNotPushedError {
  readonly kind: 'BranchNotPushed';
  readonly branch: string;
  readonly message: string;
}

/**
 * The host rejected a merge because the PR conflicts with its base
 * branch. `prNumber` is included so operator-facing UI can deep-link
 * back to the PR for resolution.
 */
export interface GitHostMergeConflictError {
  readonly kind: 'MergeConflict';
  readonly prNumber: number;
  readonly message: string;
}

/**
 * The host rejected a merge because one or more required status checks
 * are still failing or pending. `failingChecks` lists the check names
 * the host returned so the operator (and the flow engine) can decide
 * whether to wait, re-run, or escalate.
 */
export interface GitHostRequiredChecksBlockingError {
  readonly kind: 'RequiredChecksBlocking';
  readonly prNumber: number;
  readonly failingChecks: readonly string[];
  readonly message: string;
}

/**
 * Discriminated union of every typed failure a {@link GitHostPort}
 * implementation may surface. Callers narrow on `kind`; adapters are
 * expected to wrap any provider-specific error (HTTP body, `gh` CLI
 * stderr, octokit exception) into one of these four variants before it
 * crosses the port boundary.
 */
export type GitHostError =
  | GitHostAuthMissingError
  | GitHostBranchNotPushedError
  | GitHostMergeConflictError
  | GitHostRequiredChecksBlockingError;

export interface GitHostPort {
  /** Open a pull request and return its host-assigned number + URL. */
  openPr(spec: OpenPrSpec): Promise<PrRef>;

  /** Post a free-form comment onto a PR's timeline. */
  commentOnPr(prRef: PrRef, body: string): Promise<void>;

  /**
   * Merge a PR using the requested method. Throws a {@link GitHostError}
   * when the host rejects the merge — callers narrow on `kind` to react
   * (re-push on `BranchNotPushed`, park on `MergeConflict` /
   * `RequiredChecksBlocking`, escalate on `AuthMissing`).
   */
  mergePr(prRef: PrRef, options: MergePrOptions): Promise<void>;
}
