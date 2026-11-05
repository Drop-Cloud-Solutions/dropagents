/**
 * GitHubPrAdapter — `gh` CLI implementation of {@link GitHostPort}.
 *
 * Companion to (and not replacement for) the older
 * `GhPullRequestGateway` in `./pr-gateway.ts`, which still satisfies the
 * legacy `PullRequestGateway` port wired into the flow engine. The two
 * adapters coexist for the duration of the AP-VP6 cutover: callers that
 * have migrated to the typed-error `GitHostPort` surface use this class;
 * everything else continues to use the legacy gateway.
 *
 * Failure mapping (see {@link mapStderr}) translates known `gh` stderr
 * signatures into one of the four discriminated `GitHostError` kinds:
 *
 * | gh stderr signature              | mapped kind             |
 * |----------------------------------|-------------------------|
 * | "not logged into" / 401          | AuthMissing             |
 * | "no upstream" / "must first push"| BranchNotPushed         |
 * | "required status check" / branch protection | RequiredChecksBlocking |
 * | "merge conflict" / not mergeable | MergeConflict           |
 *
 * Any other non-zero exit is re-thrown as a plain `Error` carrying the
 * raw stderr. The {@link GitHostError} union does not currently include
 * an `Unknown` kind; extending it belongs in the port's package
 * (task-002), not here.
 */

import { execFile, type ExecFileException } from 'child_process';

import type {
  GitHostError,
  GitHostPort,
  MergePrOptions,
  OpenPrSpec,
  PrRef,
} from '../../core/ports/git-host';

/** Stdout + stderr + exit code of a single shellout. */
export interface GhExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/**
 * Injectable command runner. Unlike the legacy `PrGatewayExecResult`,
 * this contract resolves (never rejects) for non-zero exits so the
 * adapter can inspect stderr and dispatch into the typed-error union.
 */
export type GhExecRunner = (
  command: string,
  args: readonly string[],
  options: { readonly cwd: string },
) => Promise<GhExecResult>;

export interface GitHubPrAdapterOptions {
  /**
   * Working directory passed to `gh`. `gh` resolves the target
   * repository from this directory's git remote, so it must be a
   * checkout of the repo whose PRs are being driven.
   */
  readonly cwd: string;
  /**
   * Source of environment variables — defaults to `process.env`. Read
   * at call time so a worker that loads `.env` after the adapter is
   * constructed still picks up `GH_PATH`.
   */
  readonly env?: NodeJS.ProcessEnv | (() => NodeJS.ProcessEnv);
  /** Injectable command runner. Defaults to a child_process.execFile wrapper. */
  readonly exec?: GhExecRunner;
}

const MAX_BUFFER = 64 * 1024 * 1024;

function defaultExec(): GhExecRunner {
  return (command, args, options) =>
    new Promise<GhExecResult>((resolve) => {
      execFile(
        command,
        args.slice(),
        { cwd: options.cwd, encoding: 'utf8', maxBuffer: MAX_BUFFER },
        (err, stdout, stderr) => {
          const out = typeof stdout === 'string' ? stdout : String(stdout ?? '');
          const errOut =
            typeof stderr === 'string' ? stderr : String(stderr ?? '');
          let exitCode = 0;
          if (err) {
            const raw = (err as ExecFileException).code;
            exitCode = typeof raw === 'number' ? raw : Number(raw) || 1;
          }
          resolve({ stdout: out, stderr: errOut, exitCode });
        },
      );
    });
}

export class GitHubPrAdapter implements GitHostPort {
  private readonly cwd: string;
  private readonly envSource: () => NodeJS.ProcessEnv;
  private readonly exec: GhExecRunner;

  constructor(options: GitHubPrAdapterOptions) {
    this.cwd = options.cwd;
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

  async openPr(spec: OpenPrSpec): Promise<PrRef> {
    const args: string[] = [
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
    if (spec.draft) args.push('--draft');

    const result = await this.runGh(args);
    if (result.exitCode !== 0) {
      this.throwMapped(result.stderr, { branch: spec.head });
    }

    const url = parsePullRequestUrl(result.stdout);
    if (!url) {
      throw new Error(
        `GitHubPrAdapter.openPr: could not parse a pull-request URL from gh output: ${result.stdout.trim()}`,
      );
    }
    return { number: parsePullRequestNumber(url), url };
  }

  async commentOnPr(prRef: PrRef, body: string): Promise<void> {
    const result = await this.runGh([
      'pr',
      'comment',
      String(prRef.number),
      '--body',
      body,
    ]);
    if (result.exitCode !== 0) {
      this.throwMapped(result.stderr, { prNumber: prRef.number });
    }
  }

  async mergePr(prRef: PrRef, _options: MergePrOptions): Promise<void> {
    // AP-VP6-010: GitHub adapter always merges with --squash. The port
    // surfaces `options.method` for adapters that do honour it, but on
    // the GitHub side the pipeline only uses squash merges. The arg is
    // intentionally ignored.
    const result = await this.runGh([
      'pr',
      'merge',
      String(prRef.number),
      '--squash',
    ]);
    if (result.exitCode !== 0) {
      this.throwMapped(result.stderr, { prNumber: prRef.number });
    }
  }

  private throwMapped(
    stderr: string,
    context: { branch?: string; prNumber?: number },
  ): never {
    const mapped = mapStderr(stderr, context);
    if (mapped) throw mapped;
    throw new Error(
      `GitHubPrAdapter: gh failed with unmapped stderr: ${stderr.trim()}`,
    );
  }

  private resolveGhBin(): string {
    const env = this.envSource();
    const fromEnv = env.GH_PATH;
    return fromEnv && fromEnv.length > 0 ? fromEnv : 'gh';
  }

  private runGh(args: readonly string[]): Promise<GhExecResult> {
    return this.exec(this.resolveGhBin(), args, { cwd: this.cwd });
  }
}

/**
 * Translate a `gh` stderr blob into a {@link GitHostError}, or undefined
 * when no signature matches. Exported for direct testing.
 *
 * Order matters: RequiredChecksBlocking is checked before MergeConflict
 * because gh's "required status checks" message can also contain the
 * word "merge".
 */
export function mapStderr(
  stderr: string,
  context: { branch?: string; prNumber?: number },
): GitHostError | undefined {
  const text = stderr.toLowerCase();
  const message = stderr.trim();

  if (
    text.includes('not logged into')
    || text.includes('bad credentials')
    || text.includes('http 401')
    || text.includes('gh auth login')
    || (text.includes('authentication')
      && (text.includes('required') || text.includes('failed')))
  ) {
    return { kind: 'AuthMissing', message };
  }

  if (
    text.includes('no upstream')
    || text.includes('must first push')
    || text.includes('branch not pushed')
    || text.includes('src refspec')
  ) {
    return {
      kind: 'BranchNotPushed',
      branch: context.branch ?? '',
      message,
    };
  }

  if (
    text.includes('required status check')
    || text.includes('branch protection')
  ) {
    return {
      kind: 'RequiredChecksBlocking',
      prNumber: context.prNumber ?? 0,
      failingChecks: extractFailingChecks(stderr),
      message,
    };
  }

  if (text.includes('merge conflict') || text.includes('not mergeable')) {
    return {
      kind: 'MergeConflict',
      prNumber: context.prNumber ?? 0,
      message,
    };
  }

  return undefined;
}

/**
 * Best-effort extraction of failing-check names from gh stderr. gh's
 * merge-blocked output typically lists checks one per line as
 * `- check-name`. Anything we cannot parse confidently is omitted; the
 * full stderr is still preserved in `message`.
 */
function extractFailingChecks(stderr: string): readonly string[] {
  const checks: string[] = [];
  const lineRe = /^\s*[-*•]\s+([A-Za-z0-9][\w./-]*)\s*(?::|$)/gm;
  let match: RegExpExecArray | null;
  while ((match = lineRe.exec(stderr)) !== null) {
    checks.push(match[1]);
  }
  return checks;
}

function parsePullRequestUrl(stdout: string): string | undefined {
  const match = stdout.match(/https?:\/\/\S+?\/pull\/\d+/);
  return match?.[0];
}

function parsePullRequestNumber(url: string): number {
  const match = url.match(/\/pull\/(\d+)/);
  return match ? Number(match[1]) : NaN;
}
