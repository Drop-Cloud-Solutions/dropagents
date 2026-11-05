/**
 * WorkspaceRepoFetcher — clones and refreshes repos against the
 * workspace-level repo registry (migration 011's `repos` table).
 *
 * Unlike the legacy `RepoFetcher` (which keys on `<projectId>/<repoId>`
 * and reads from `ProjectRegistry`), this fetcher operates on a single
 * `{ repoId, url, defaultBranch }` triple — the shape stored on the
 * `repos` projection row. One clone per repoId at a stable path under
 * `<reposRoot>/<repoId>`, shared across every project that links to
 * the repo.
 *
 * Three operations, all idempotent:
 *
 *   - `resolvePath(repoId)` — pure: returns `<reposRoot>/<repoId>`.
 *   - `ensureCloned({repoId, url, ...})` — clones via `gh repo clone`
 *     when the working tree is missing. No-op when the directory
 *     already exists. Throws `RepoCloneError` on failure so the
 *     EnsureSubscriber can publish `RepoEnsureFailed`.
 *   - `refresh({repoId, defaultBranch, ...})` — `git fetch origin` +
 *     `git reset --hard origin/<defaultBranch>`. Used by both the
 *     operator-fired "Sync now" command and the planner's pre-spawn
 *     pull. Throws `RepoRefreshError` on failure; the caller emits
 *     `RepoSyncFailed` and (per the operator's choice) proceeds with
 *     stale content.
 *
 * `ensureCloned` is also called pre-flight inside `refresh` so an
 * operator running "Sync now" against a repo that was never cloned
 * (e.g. registered before the EnsureSubscriber was wired) clones
 * lazily.
 */
import { execFile, type ExecFileException } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import type { Logger } from '../../core/ports/Logger';

export interface WorkspaceRepoFetcherExecResult {
    readonly stdout: string;
    readonly stderr: string;
}

export type WorkspaceRepoFetcherExec = (
    command: string,
    args: readonly string[],
    options: {
        readonly cwd: string;
        /**
         * Extra environment for this one call, overlaid on the
         * parent's. Carries the GitHub account the repo is reached
         * with; empty for an unmapped repo, which leaves the child
         * on the machine's ambient identity.
         */
        readonly env?: Readonly<Record<string, string>>;
    },
) => Promise<WorkspaceRepoFetcherExecResult>;

export interface WorkspaceRepoFetcherFs {
    readonly existsSync?: (p: string) => boolean;
    readonly statSync?: (p: string) => { isDirectory(): boolean };
    readonly mkdirpSync?: (p: string) => void;
}

export interface WorkspaceRepoSpec {
    readonly repoId: string;
    readonly url: string;
    readonly defaultBranch?: string;
    /**
     * Env overlay for the GitHub account this repo is reached with.
     *
     * Load-bearing for the whole feature: a repo the primary account
     * cannot SEE has to be cloned and fetched as the account that
     * can, and `gh repo clone` / `git fetch` are where that
     * first happens. Resolved by the caller, which owns the account
     * registry. Empty for an unmapped repo.
     */
    readonly githubEnv?: Readonly<Record<string, string>>;
}

export interface WorkspaceRepoFetcherOptions {
    readonly logger: Logger;
    /**
     * Root directory all repos land under. Path layout:
     *   `<reposRoot>/<repoId>`. Override via the `REPOS_ROOT` env var
     *   (read at call time so a host's .env loader can win).
     */
    readonly reposRoot: string;
    /** gh binary. Defaults to `'gh'`. */
    readonly ghBin?: string;
    /** git binary. Defaults to `'git'`. */
    readonly gitBin?: string;
    readonly exec?: WorkspaceRepoFetcherExec;
    readonly fs?: WorkspaceRepoFetcherFs;
    /** Env reader — defaults to `process.env`. */
    readonly env?: () => NodeJS.ProcessEnv;
}

export class RepoCloneError extends Error {
    override readonly name = 'RepoCloneError';
    readonly repoId: string;
    constructor(repoId: string, message: string) {
        super(message);
        this.repoId = repoId;
    }
}

export class RepoRefreshError extends Error {
    override readonly name = 'RepoRefreshError';
    readonly repoId: string;
    constructor(repoId: string, message: string) {
        super(message);
        this.repoId = repoId;
    }
}

const MAX_BUFFER = 64 * 1024 * 1024;
const DEFAULT_BRANCH = 'main';

function defaultExec(): WorkspaceRepoFetcherExec {
    return (command, args, options) =>
        new Promise<WorkspaceRepoFetcherExecResult>((resolve, reject) => {
            execFile(
                command,
                args.slice(),
                {
                    cwd: options.cwd,
                    // Overlaid, never replacing: gh and git still need
                    // PATH, and on Windows SystemRoot and friends.
                    ...(options.env
                        ? { env: { ...process.env, ...options.env } }
                        : {}),
                    encoding: 'utf8',
                    maxBuffer: MAX_BUFFER,
                },
                (err, stdout, stderr) => {
                    const out = typeof stdout === 'string' ? stdout : String(stdout ?? '');
                    const errOut
                        = typeof stderr === 'string' ? stderr : String(stderr ?? '');
                    if (err) {
                        const code = (err as ExecFileException).code;
                        const exit = typeof code === 'number' ? code : Number(code) || 1;
                        const detail = (errOut.trim() || out.trim() || '').slice(0, 400);
                        reject(
                            new Error(
                                `\`${command} ${args.join(' ')}\` exit ${exit}${
                                    detail ? `: ${detail}` : ''
                                }`,
                            ),
                        );
                        return;
                    }
                    resolve({ stdout: out, stderr: errOut });
                },
            );
        });
}

export class WorkspaceRepoFetcher {
    private readonly logger: Logger;
    private readonly reposRoot: string;
    private readonly ghBin: string;
    private readonly gitBin: string;
    private readonly exec: WorkspaceRepoFetcherExec;
    private readonly existsSync: (p: string) => boolean;
    private readonly statSync: (p: string) => { isDirectory(): boolean };
    private readonly mkdirpSync: (p: string) => void;
    private readonly env: () => NodeJS.ProcessEnv;

    constructor(options: WorkspaceRepoFetcherOptions) {
        this.logger = options.logger;
        this.reposRoot = options.reposRoot;
        this.ghBin = options.ghBin ?? 'gh';
        this.gitBin = options.gitBin ?? 'git';
        this.exec = options.exec ?? defaultExec();
        const harness = options.fs ?? {};
        this.existsSync = harness.existsSync ?? ((p): boolean => fs.existsSync(p));
        this.statSync =
            harness.statSync ?? ((p): { isDirectory(): boolean } => fs.statSync(p));
        this.mkdirpSync =
            harness.mkdirpSync
            ?? ((p): void => {
                fs.mkdirSync(p, { recursive: true });
            });
        this.env = options.env ?? ((): NodeJS.ProcessEnv => process.env);
    }

    /** Pure path resolution. Does not touch the filesystem. */
    resolvePath(repoId: string): string {
        return path.join(this.workspaceRoot(), repoId);
    }

    /** True iff the resolved path exists as a directory. */
    isCloned(repoId: string): boolean {
        return this.dirExists(this.resolvePath(repoId));
    }

    /**
     * Clone the repo via `gh repo clone <url> <target>` when the
     * working tree is missing. No-op when the directory already
     * exists. Returns the absolute path either way.
     *
     * Throws {@link RepoCloneError} on gh failure so the caller can
     * surface a `RepoEnsureFailed` event with the wrapped message.
     */
    async ensureCloned(spec: WorkspaceRepoSpec): Promise<string> {
        const target = this.resolvePath(spec.repoId);
        if (this.dirExists(target)) return target;

        const parent = path.dirname(target);
        this.mkdirpSync(parent);

        this.logger.info('workspace-repo-fetcher: cloning missing repo', {
            repoId: spec.repoId,
            target,
            url: spec.url,
        });

        try {
            await this.exec(this.ghBin, ['repo', 'clone', spec.url, target], {
                cwd: parent,
                // The first place the account matters: a repo the
                // primary account cannot see does not clone at all
                // without it.
                ...(spec.githubEnv ? { env: spec.githubEnv } : {}),
            });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            throw new RepoCloneError(spec.repoId, message);
        }
        return target;
    }

    /**
     * Fetch from origin, then `git reset --hard origin/<defaultBranch>`.
     * Idempotent: a noop when there are no new commits and the local
     * working tree is already at origin/<branch>. Auto-clones first if
     * the working tree is missing (cheap test: directory check), so
     * callers don't need to ensure first.
     *
     * Hard reset is intentional — these clones are read-only agent
     * workspaces. `git pull --ff-only` would fail if any process left
     * the local state diverged from origin (a previous interrupted
     * agent run, an accidental local commit, etc.).
     *
     * Throws {@link RepoRefreshError} on any failure; caller emits
     * `RepoSyncFailed` and proceeds with stale per the operator-chosen
     * policy.
     */
    async refresh(spec: WorkspaceRepoSpec): Promise<string> {
        const target = await this.ensureCloned(spec);

        try {
            await this.exec(this.gitBin, ['fetch', 'origin'], {
                cwd: target,
                ...(spec.githubEnv ? { env: spec.githubEnv } : {}),
            });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            throw new RepoRefreshError(spec.repoId, `fetch failed: ${message}`);
        }

        // Resolve the default branch BY ASKING THE CLONE rather than
        // trusting spec.defaultBranch. The projection's
        // `default_branch` column defaults to `main` for any repo
        // registered without an explicit branch — that's wrong for
        // master-default repos and the reset below fails with
        // `unknown revision 'origin/main'`. `git symbolic-ref --short
        // refs/remotes/origin/HEAD` returns `origin/<actual-branch>`
        // straight from the freshly-fetched clone, so detection is
        // authoritative. Falls back to spec / `DEFAULT_BRANCH` only
        // when origin/HEAD isn't set (rare; some bare clones).
        const branch = await this.resolveDefaultBranch(target, spec);
        try {
            await this.exec(
                this.gitBin,
                ['reset', '--hard', `origin/${branch}`],
                { cwd: target },
            );
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            throw new RepoRefreshError(
                spec.repoId,
                `reset --hard origin/${branch} failed: ${message}`,
            );
        }
        return target;
    }

    /**
     * Pull the upstream's default branch out of the freshly-fetched
     * clone. Tries `git symbolic-ref --short refs/remotes/origin/HEAD`
     * first (authoritative — populated by `git clone` from the remote
     * symref). Falls back to `spec.defaultBranch` then to the global
     * default. Best-effort: any error returns the fallback rather
     * than throwing, so a partial detection doesn't fail the whole
     * refresh.
     */
    private async resolveDefaultBranch(
        cwd: string,
        spec: WorkspaceRepoSpec,
    ): Promise<string> {
        try {
            const { stdout } = await this.exec(
                this.gitBin,
                ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
                { cwd },
            );
            const ref = (typeof stdout === 'string' ? stdout : '').trim();
            if (ref.startsWith('origin/')) {
                const branch = ref.slice('origin/'.length);
                if (branch.length > 0) return branch;
            }
            if (ref.length > 0) return ref;
        } catch {
            // origin/HEAD not set or rev-parse failed — fall through.
        }
        return spec.defaultBranch ?? DEFAULT_BRANCH;
    }

    private workspaceRoot(): string {
        const fromEnv = this.env().REPOS_ROOT;
        if (typeof fromEnv === 'string') {
            const trimmed = fromEnv.trim();
            if (trimmed !== '') return trimmed;
        }
        return this.reposRoot;
    }

    private dirExists(p: string): boolean {
        if (!this.existsSync(p)) return false;
        try {
            return this.statSync(p).isDirectory();
        } catch {
            return false;
        }
    }
}
