import { execFile, type ExecFileException } from 'child_process';

import type {
  MergePullRequestOptions,
  OpenPullRequestSpec,
  OpenedPullRequest,
  PullRequestGateway,
} from '../../core/ports';

/** Stdout + stderr of a single shellout. */
export interface PrGatewayExecResult {
  readonly stdout: string;
  readonly stderr: string;
}

/** Injectable command runner used by GhPullRequestGateway. */
export type GhExecRunner = (
  command: string,
  args: readonly string[],
  options: { readonly cwd: string },
) => Promise<PrGatewayExecResult>;

/** Thrown when a gh (or git) invocation exits with a non-zero status. */
export class PrGatewayError extends Error {
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
      `PrGateway: \`${command} ${args.join(' ')}\` failed with exit ${exitCode}${
        detail ? `: ${detail}` : ''
      }`,
    );
    this.name = 'PrGatewayError';
    this.command = command;
    this.args = args.slice();
    this.exitCode = exitCode;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

export interface GhPullRequestGatewayOptions {
  /**
   * Working directory passed to gh and git. gh resolves the target
   * repository from this directory's git remote, so it must be a path
   * inside a checkout of the repo whose PRs are being driven.
   */
  readonly cwd: string;
  /**
   * Source of environment variables — defaults to `process.env`. Read at
   * call time so a worker that loads .env after the gateway is constructed
   * still picks up `GH_PATH`.
   */
  readonly env?: NodeJS.ProcessEnv | (() => NodeJS.ProcessEnv);
  /** Injectable command runner. Defaults to a child_process.execFile wrapper. */
  readonly exec?: GhExecRunner;
  /** Git binary used by `push`. Defaults to `git`. */
  readonly gitBin?: string;
  /**
   * Remote name used by `push`. Defaults to `origin`. Adapters that need
   * to push to a fork can override this.
   */
  readonly remote?: string;
}

const MAX_BUFFER = 64 * 1024 * 1024;

function defaultExec(): GhExecRunner {
  return (command, args, options) =>
    new Promise<PrGatewayExecResult>((resolve, reject) => {
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
            reject(new PrGatewayError(command, args, exitCode, out, errOut));
            return;
          }
          resolve({ stdout: out, stderr: errOut });
        },
      );
    });
}

/**
 * PullRequestGateway adapter that shells out to `gh` and `git`.
 *
 * The `gh` binary path is resolved from the `GH_PATH` environment
 * variable at every call, defaulting to plain `gh`. This mirrors how
 * other v2 adapters (GitCli, ClaudeCliRunner) bind to their tools —
 * the host can override the binary without rebuilding the adapter.
 *
 * `push` is the one method that gh cannot satisfy: gh has no
 * push subcommand. The adapter shells to `git push -u <remote> <branch>`
 * for that single call.
 */
export class GhPullRequestGateway implements PullRequestGateway {
  private readonly cwd: string;
  private readonly gitBin: string;
  private readonly remote: string;
  private readonly envSource: () => NodeJS.ProcessEnv;
  private readonly exec: GhExecRunner;

  constructor(options: GhPullRequestGatewayOptions) {
    this.cwd = options.cwd;
    this.gitBin = options.gitBin ?? 'git';
    this.remote = options.remote ?? 'origin';
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

  async push(branch: string): Promise<void> {
    await this.runGit(['push', '-u', this.remote, branch]);
  }

  async openPullRequest(spec: OpenPullRequestSpec): Promise<OpenedPullRequest> {
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
    const { stdout } = await this.runGh(args);
    const url = parsePullRequestUrl(stdout);
    if (!url) {
      throw new Error(
        `GhPullRequestGateway.openPullRequest: could not parse a pull-request URL from gh output: ${stdout.trim()}`,
      );
    }
    return { number: parsePullRequestNumber(url), url };
  }

  async mergePullRequest(
    number: number,
    options: MergePullRequestOptions,
  ): Promise<void> {
    await this.runGh(['pr', 'merge', String(number), methodFlag(options.method)]);
  }

  async addComment(number: number, body: string): Promise<void> {
    await this.runGh(['pr', 'comment', String(number), '--body', body]);
  }

  private resolveGhBin(): string {
    const env = this.envSource();
    const fromEnv = env.GH_PATH;
    return fromEnv && fromEnv.length > 0 ? fromEnv : 'gh';
  }

  private runGh(args: readonly string[]): Promise<PrGatewayExecResult> {
    return this.exec(this.resolveGhBin(), args, { cwd: this.cwd });
  }

  private runGit(args: readonly string[]): Promise<PrGatewayExecResult> {
    return this.exec(this.gitBin, args, { cwd: this.cwd });
  }
}

function methodFlag(method: MergePullRequestOptions['method']): string {
  switch (method) {
    case 'squash':
      return '--squash';
    case 'merge':
      return '--merge';
    case 'rebase':
      return '--rebase';
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
