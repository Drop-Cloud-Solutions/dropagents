/**
 * Port: pull-request operations against a remote hosting provider.
 *
 * This is a narrower companion to {@link SourceControl}. SourceControl
 * owns the local git lifecycle (branch, commit, diff) and produces an
 * initial PR; PullRequestGateway carries the long tail of operations the
 * flow engine drives after a PR exists — pushing follow-up commits,
 * merging when checks pass, and posting comments back onto the PR
 * timeline.
 *
 * The shape mirrors what the v1 pipeline shelled out for, with `push`
 * intentionally kept on the port even though it is technically a git
 * operation — keeping the four PR-related verbs on one surface keeps
 * the flow engine's dispatch table simple. Push is also the only one
 * an adapter cannot satisfy through `gh` alone.
 *
 * Errors raised by an implementation should preserve any captured
 * provider output (stderr from the CLI, response body from a REST
 * client) so the flow engine can surface a usable failure reason.
 */

/** Method by which a PR is merged on the provider side. */
export type MergeMethod = 'squash' | 'merge' | 'rebase';

/** Inputs to {@link PullRequestGateway.openPullRequest}. */
export interface OpenPullRequestSpec {
  readonly title: string;
  readonly body?: string;
  /** Target branch (usually `main` / `master`). */
  readonly base: string;
  /** Source branch carrying the changes. */
  readonly head: string;
}

/** Identity of a freshly opened pull request. */
export interface OpenedPullRequest {
  readonly number: number;
  readonly url: string;
}

/** Options for {@link PullRequestGateway.mergePullRequest}. */
export interface MergePullRequestOptions {
  readonly method: MergeMethod;
}

export interface PullRequestGateway {
  /**
   * Push the local branch to the upstream remote. Sets up tracking on
   * first push so subsequent pushes do not need the `-u` flag.
   */
  push(branch: string): Promise<void>;

  /** Open a pull request and return its provider-assigned number + URL. */
  openPullRequest(spec: OpenPullRequestSpec): Promise<OpenedPullRequest>;

  /**
   * Merge a PR using the requested method. Implementations are free to
   * trust the provider's eligibility rules (required checks, approvals,
   * branch protection) and surface any rejection as a typed error.
   */
  mergePullRequest(
    number: number,
    options: MergePullRequestOptions,
  ): Promise<void>;

  /** Post a free-form comment onto a PR's timeline. */
  addComment(number: number, body: string): Promise<void>;
}
