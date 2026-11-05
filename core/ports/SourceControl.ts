/**
 * Port: source control operations the pipeline needs to drive a task
 * (git + GitHub today; could be git + GitLab/Gitea/Bitbucket tomorrow).
 *
 * The surface is the smallest set the orchestrator actually invokes:
 * branch the work, commit it, open the PR, fetch the diff to feed the
 * reviewer. Lower-level plumbing (clone, fetch, prune, worktree create)
 * is the adapter's private concern.
 */

/** Inputs to a commit operation. */
export interface CommitSpec {
  readonly message: string;
  /**
   * Optional explicit file list to stage. If omitted, the adapter stages
   * everything currently tracked + modified in the working tree (the
   * usual `git add -A` semantics, scoped to the adapter's working dir).
   */
  readonly files?: readonly string[];
}

/** Reference to a created commit. */
export interface CommitRef {
  readonly sha: string;
}

/** Inputs to open a pull request. */
export interface PullRequestSpec {
  readonly title: string;
  readonly body?: string;
  /** Source branch (the branch with the changes). */
  readonly head: string;
  /** Target branch (usually `main` / `master`). */
  readonly base: string;
}

/** Reference to an opened pull request. */
export interface PullRequestRef {
  readonly id: string;
  readonly number: number;
  readonly url: string;
}

/** Optional bounds for `getDiff`. */
export interface DiffOptions {
  readonly base?: string;
  readonly head?: string;
}

export interface SourceControl {
  /**
   * Create a new branch named `name`. If `from` is given, branch from
   * that ref; otherwise branch from the adapter's current HEAD.
   */
  createBranch(name: string, from?: string): Promise<void>;

  /** Commit staged (or `spec.files`) changes. Returns the new commit. */
  commit(spec: CommitSpec): Promise<CommitRef>;

  /** Open a pull request on the upstream hosting provider. */
  openPullRequest(spec: PullRequestSpec): Promise<PullRequestRef>;

  /**
   * Return a unified diff. Defaults are adapter-specific (typically
   * current branch vs. its merge-base with the default branch).
   */
  getDiff(options?: DiffOptions): Promise<string>;
}
