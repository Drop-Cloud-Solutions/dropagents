/**
 * Port: reads a target repository for planner / decomposer prompt assembly.
 *
 * Returns the project's CLAUDE.md (if present), a flattened file tree, and
 * the contents of a small set of sample files chosen by `sampleGlobs`.
 * Pure interface — implementations live elsewhere (see task-003).
 */
export interface RepoSpec {
  /** Absolute path to the repository root. */
  repoPath: string;
  /** Maximum number of files to include in `tree`. Default: 500. */
  fileCap?: number;
  /**
   * Globs (relative to `repoPath`) whose matching file contents are returned
   * in `sampleFiles`. Default: ['Program.cs', '**\/*.csproj', 'CLAUDE.md'].
   */
  sampleGlobs?: string[];
}

export interface RepoReadResult {
  /** Contents of CLAUDE.md at the repo root, or null if absent. */
  claudeMd: string | null;
  /** Repo-relative file paths, capped at `RepoSpec.fileCap`. */
  tree: string[];
  /** Map of repo-relative path → file contents for sampled files. */
  sampleFiles: Record<string, string>;
}

export interface RepoReader {
  read(spec: RepoSpec): Promise<RepoReadResult>;
}
