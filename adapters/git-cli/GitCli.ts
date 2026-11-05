import { execFile, type ExecFileException } from 'child_process';
import * as path from 'path';

import type {
  CommitRef,
  CommitSpec,
  DiffOptions,
  PullRequestRef,
  PullRequestSpec,
  SourceControl,
} from '../../core/ports';

/**
 * Result of running git or gh once, normalised to strings regardless of
 * the underlying buffer encoding.
 */
export interface ExecResult {
  readonly stdout: string;
  readonly stderr: string;
}

/** Injectable command runner used by GitCli — defaults to child_process.execFile. */
export type ExecRunner = (
  command: string,
  args: readonly string[],
  options: { readonly cwd: string },
) => Promise<ExecResult>;

export interface GitCliOptions {
  /**
   * Path to the canonical git checkout — the directory git uses as the
   * worktree origin when adding new worktrees.
   */
  readonly repoRoot: string;
  /**
   * Configured worktree root from `config/pipeline.yaml`. All worktrees
   * created by this adapter live under `<worktreeRoot>/v2/<branch>` so
   * v2 worktrees never collide with a v1 pipeline working on the same
   * parent directory.
   */
  readonly worktreeRoot: string;
  /** Default base branch used by getDiff and openPullRequest. */
  readonly defaultBase?: string;
  /**
   * Source of environment variables — defaults to `process.env`. Read at
   * call time on every commit() so a worker that loads .env after the
   * adapter is constructed still picks up GIT_COMMIT_NAME / GIT_COMMIT_EMAIL.
   */
  readonly env?: NodeJS.ProcessEnv | (() => NodeJS.ProcessEnv);
  /** Injectable command runner. Defaults to a child_process.execFile wrapper. */
  readonly exec?: ExecRunner;
  /** Git binary. Defaults to 'git'. */
  readonly gitBin?: string;
  /** GitHub CLI binary. Defaults to 'gh'. */
  readonly ghBin?: string;
}

/** Thrown when a git or gh invocation exits with a non-zero status. */
export class GitCliError extends Error {
  readonly command: string;
  readonly args: readonly string[];
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;

  constructor(
    command: string,
    args: readonly string[],
    exitCode: number,
    stdout: string,
    stderr: string,
  ) {
    const detail = (stderr.trim() || stdout.trim() || '').slice(0, 400);
    super(
      `GitCli: \`${command} ${args.join(' ')}\` failed with exit ${exitCode}${
        detail ? `: ${detail}` : ''
      }`,
    );
    this.name = 'GitCliError';
    this.command = command;
    this.args = args.slice();
    this.exitCode = exitCode;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

/** Marker subdirectory under `worktreeRoot` — keeps v2 worktrees isolated. */
export const V2_WORKTREE_PREFIX = 'v2';

const MAX_BUFFER = 64 * 1024 * 1024;

function defaultExec(): ExecRunner {
  return (command, args, options) =>
    new Promise<ExecResult>((resolve, reject) => {
      execFile(
        command,
        args.slice(),
        { cwd: options.cwd, encoding: 'utf8', maxBuffer: MAX_BUFFER },
        (err, stdout, stderr) => {
          const out = typeof stdout === 'string' ? stdout : String(stdout ?? '');
          const errOut = typeof stderr === 'string' ? stderr : String(stderr ?? '');
          if (err) {
            const raw = (err as ExecFileException).code;
            const exitCode = typeof raw === 'number' ? raw : Number(raw) || 1;
            reject(new GitCliError(command, args, exitCode, out, errOut));
            return;
          }
          resolve({ stdout: out, stderr: errOut });
        },
      );
    });
}

/**
 * Branch names commonly contain `/` (feature/x, fix/123). Worktree
 * directories live on the filesystem, so flatten to a single segment
 * containing only characters that are safe on Windows + POSIX.
 */
function sanitizeForPath(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, '-');
}

/**
 * SourceControl adapter that shells out to `git` and `gh`.
 *
 * One instance drives one task: `createBranch` adds a git worktree under
 * `<worktreeRoot>/v2/<sanitized-branch>`, and `commit`, `getDiff`,
 * `openPullRequest` all target that worktree. Worktree-local
 * user.name / user.email are written from env vars on every commit so
 * the host process needs no global git config.
 */
export class GitCli implements SourceControl {
  private readonly repoRoot: string;
  private readonly worktreeRoot: string;
  private readonly defaultBase: string;
  private readonly gitBin: string;
  private readonly ghBin: string;
  private readonly envSource: () => NodeJS.ProcessEnv;
  private readonly exec: ExecRunner;

  private currentBranch?: string;
  private currentWorktree?: string;

  constructor(options: GitCliOptions) {
    this.repoRoot = options.repoRoot;
    this.worktreeRoot = options.worktreeRoot;
    this.defaultBase = options.defaultBase ?? 'main';
    this.gitBin = options.gitBin ?? 'git';
    this.ghBin = options.ghBin ?? 'gh';
    this.exec = options.exec ?? defaultExec();

    const env = options.env;
    if (typeof env === 'function') {
      this.envSource = env;
    } else if (env) {
      const snapshot = env;
      this.envSource = (): NodeJS.ProcessEnv => snapshot;
    } else {
      this.envSource = (): NodeJS.ProcessEnv => process.env;
    }
  }

  /** Filesystem path this adapter would use for a worktree of branch `name`. */
  worktreePathFor(name: string): string {
    return path.join(this.worktreeRoot, V2_WORKTREE_PREFIX, sanitizeForPath(name));
  }

  /** Active worktree path, or undefined if createBranch has not been called. */
  getWorktreePath(): string | undefined {
    return this.currentWorktree;
  }

  /** Active branch name, or undefined if createBranch has not been called. */
  getBranch(): string | undefined {
    return this.currentBranch;
  }

  async createBranch(name: string, from?: string): Promise<void> {
    const worktreePath = this.worktreePathFor(name);
    const args = ['worktree', 'add', '-b', name, worktreePath];
    if (from) args.push(from);
    await this.runGit(args, this.repoRoot);
    this.currentBranch = name;
    this.currentWorktree = worktreePath;
  }

  async commit(spec: CommitSpec): Promise<CommitRef> {
    const cwd = this.requireWorktree('commit');
    const env = this.envSource();
    const name = env.GIT_COMMIT_NAME;
    const email = env.GIT_COMMIT_EMAIL;
    if (!name || !email) {
      throw new Error(
        'GitCli.commit: GIT_COMMIT_NAME and GIT_COMMIT_EMAIL must be set in the environment',
      );
    }

    await this.runGit(['config', '--local', 'user.name', name], cwd);
    await this.runGit(['config', '--local', 'user.email', email], cwd);

    if (spec.files && spec.files.length > 0) {
      await this.runGit(['add', '--', ...spec.files], cwd);
    } else {
      await this.runGit(['add', '-A'], cwd);
    }

    await this.runGit(['commit', '-m', spec.message], cwd);
    const head = await this.runGit(['rev-parse', 'HEAD'], cwd);
    return { sha: head.stdout.trim() };
  }

  async openPullRequest(spec: PullRequestSpec): Promise<PullRequestRef> {
    const cwd = this.currentWorktree ?? this.repoRoot;
    const args = [
      'pr',
      'create',
      '--head',
      spec.head,
      '--base',
      spec.base,
      '--title',
      spec.title,
      '--body',
      spec.body ?? '',
    ];
    const { stdout } = await this.runGh(args, cwd);
    const url = parsePullRequestUrl(stdout);
    if (!url) {
      throw new Error(
        `GitCli.openPullRequest: could not parse a pull-request URL from gh output: ${stdout.trim()}`,
      );
    }
    return {
      id: url,
      number: parsePullRequestNumber(url),
      url,
    };
  }

  async getDiff(options?: DiffOptions): Promise<string> {
    const cwd = this.requireWorktree('getDiff');
    const base = options?.base ?? this.defaultBase;
    const head = options?.head ?? 'HEAD';
    const { stdout } = await this.runGit(['diff', `${base}...${head}`], cwd);
    return stdout;
  }

  private requireWorktree(op: string): string {
    if (!this.currentWorktree) {
      throw new Error(`GitCli.${op}: no active worktree — call createBranch first`);
    }
    return this.currentWorktree;
  }

  private runGit(args: readonly string[], cwd: string): Promise<ExecResult> {
    return this.exec(this.gitBin, args, { cwd });
  }

  private runGh(args: readonly string[], cwd: string): Promise<ExecResult> {
    return this.exec(this.ghBin, args, { cwd });
  }
}

function parsePullRequestUrl(stdout: string): string | undefined {
  const match = stdout.match(/https?:\/\/\S+?\/pull\/\d+/);
  return match?.[0];
}

function parsePullRequestNumber(url: string): number {
  const match = url.match(/\/pull\/(\d+)/);
  return match ? Number(match[1]) : NaN;
}
