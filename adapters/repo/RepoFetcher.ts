/**
 * RepoFetcher — resolves the on-disk path of a `Project` repo and auto-clones
 * it via the `gh` CLI when the working tree is missing. Port of v1's
 * `pipeline/worker/repo-fetch.ts`.
 *
 * Path resolution order (highest priority first):
 *
 *   1. `config/repo-paths.json` override. Keys are `"<projectId>/<repoId>"`,
 *      values are absolute paths. This file is worker-local — committed empty
 *      so machine-specific overrides do not leak into shared configuration.
 *   2. The `path` field on the registry's `RepoSpec`. Lets a project declare
 *      a non-default location when it lives outside the workspace tree.
 *   3. Convention: `<PIPELINE_WORKSPACE>/<projectId>/<repoId>`.
 *      `PIPELINE_WORKSPACE` defaults to a per-host workspace root supplied
 *      at construction time; the env var is read at call time so a host's
 *      .env loader (which runs after import resolution) wins over any
 *      cached value.
 *
 * Auto-clone: `ensureCloned()` runs `gh repo clone <owner>/<name> <path>`
 * when the resolved path is not yet a directory. The clone url is derived
 * from the repo's `url`, or from `<owner>/<name>` (falling back to the
 * project-level `gitHubOwner` and the repo id) when no explicit url is set.
 * A directory that already exists is left alone — the fetcher does not pull
 * or rebase. That responsibility lives in the worktree-manager / stage code.
 */
import { execFile, type ExecFileException } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import type { Logger } from '../../core/ports/Logger';
import type { Project, ProjectRegistry, RepoSpec } from '../../core/projects/registry';

export interface RepoFetcherExecResult {
    readonly stdout: string;
    readonly stderr: string;
}

export type RepoFetcherExec = (
    command: string,
    args: readonly string[],
    options: { readonly cwd: string },
) => Promise<RepoFetcherExecResult>;

export interface RepoFetcherFs {
    /** True iff the path exists. Defaults to `fs.existsSync`. */
    readonly existsSync?: (p: string) => boolean;
    /** Stat — defaults to `fs.statSync`. */
    readonly statSync?: (p: string) => { isDirectory(): boolean };
    /** Recursive mkdir — defaults to `fs.mkdirSync(p, { recursive: true })`. */
    readonly mkdirpSync?: (p: string) => void;
    /** Read text file — defaults to `fs.readFileSync(p, 'utf8')`. */
    readonly readFileSync?: (p: string) => string;
}

export interface RepoFetcherOptions {
    readonly projects: ProjectRegistry;
    readonly logger: Logger;
    /**
     * Default workspace root used when neither the override file nor the
     * `RepoSpec.path` field supplies an explicit location. The
     * `PIPELINE_WORKSPACE` env var, when set and non-empty, takes
     * precedence — matching v1's behaviour.
     */
    readonly pipelineWorkspace: string;
    /**
     * Absolute path to the optional `config/repo-paths.json` override file.
     * Missing file is treated as empty (no entries). Malformed JSON throws
     * on first read — operators see the problem instead of silently falling
     * through to the convention.
     */
    readonly repoPathsFile?: string;
    /** gh binary. Defaults to `'gh'`. */
    readonly ghBin?: string;
    /** Injectable command runner. Defaults to a child_process.execFile wrapper. */
    readonly exec?: RepoFetcherExec;
    /** Filesystem seam — defaults route to `fs`. */
    readonly fs?: RepoFetcherFs;
    /** Reader for `PIPELINE_WORKSPACE` (or any other env var). Defaults to `process.env`. */
    readonly env?: () => NodeJS.ProcessEnv;
}

export class UnknownRepoError extends Error {
    override readonly name = 'UnknownRepoError';
    readonly projectId: string;
    readonly repoId: string;
    constructor(projectId: string, repoId: string) {
        super(
            `UnknownRepoError: project "${projectId}" has no repo with id "${repoId}"`,
        );
        this.projectId = projectId;
        this.repoId = repoId;
    }
}

export class RepoCloneError extends Error {
    override readonly name = 'RepoCloneError';
    constructor(message: string) {
        super(message);
    }
}

const MAX_BUFFER = 64 * 1024 * 1024;

function defaultExec(): RepoFetcherExec {
    return (command, args, options) =>
        new Promise<RepoFetcherExecResult>((resolve, reject) => {
            execFile(
                command,
                args.slice(),
                { cwd: options.cwd, encoding: 'utf8', maxBuffer: MAX_BUFFER },
                (err, stdout, stderr) => {
                    const out = typeof stdout === 'string' ? stdout : String(stdout ?? '');
                    const errOut = typeof stderr === 'string' ? stderr : String(stderr ?? '');
                    if (err) {
                        const code = (err as ExecFileException).code;
                        const exit = typeof code === 'number' ? code : Number(code) || 1;
                        const detail = (errOut.trim() || out.trim() || '').slice(0, 400);
                        reject(
                            new RepoCloneError(
                                `repo-fetcher: \`${command} ${args.join(' ')}\` exit ${exit}${
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

export class RepoFetcher {
    private readonly projects: ProjectRegistry;
    private readonly logger: Logger;
    private readonly pipelineWorkspace: string;
    private readonly repoPathsFile?: string;
    private readonly ghBin: string;
    private readonly exec: RepoFetcherExec;
    private readonly existsSync: (p: string) => boolean;
    private readonly statSync: (p: string) => { isDirectory(): boolean };
    private readonly mkdirpSync: (p: string) => void;
    private readonly readFileSync: (p: string) => string;
    private readonly env: () => NodeJS.ProcessEnv;

    constructor(options: RepoFetcherOptions) {
        this.projects = options.projects;
        this.logger = options.logger;
        this.pipelineWorkspace = options.pipelineWorkspace;
        this.repoPathsFile = options.repoPathsFile;
        this.ghBin = options.ghBin ?? 'gh';
        this.exec = options.exec ?? defaultExec();
        const harness = options.fs ?? {};
        this.existsSync = harness.existsSync ?? ((p): boolean => fs.existsSync(p));
        this.statSync =
            harness.statSync ?? ((p): { isDirectory(): boolean } => fs.statSync(p));
        this.mkdirpSync =
            harness.mkdirpSync ??
            ((p): void => {
                fs.mkdirSync(p, { recursive: true });
            });
        this.readFileSync =
            harness.readFileSync ?? ((p): string => fs.readFileSync(p, 'utf8'));
        this.env = options.env ?? ((): NodeJS.ProcessEnv => process.env);
    }

    /**
     * Resolve the on-disk path for `<projectId>/<repoId>` without touching the
     * filesystem beyond reading the optional override file.
     */
    resolvePath(projectId: string, repoId: string): string {
        const repo = this.lookupRepo(projectId, repoId);

        const override = this.readOverride(projectId, repoId);
        if (override) return override;

        if (repo.path) return repo.path;

        return path.join(this.workspaceRoot(), projectId, repoId);
    }

    /**
     * Resolve the path and clone the repo if its working tree does not yet
     * exist. A path that already exists as a directory is returned unchanged —
     * `RepoFetcher` does not refresh or rebase existing checkouts.
     *
     * Auto-clone runs `gh repo clone <owner>/<name> <target>` from the
     * workspace root (`<PIPELINE_WORKSPACE>` or the override that resolved
     * the path). The target's parent directory is created with
     * `mkdir -p` so a fresh project workspace boots cleanly.
     */
    async ensureCloned(projectId: string, repoId: string): Promise<string> {
        const project = this.projects.get(projectId);
        const repo = pickRepo(project, repoId);
        if (!repo) throw new UnknownRepoError(projectId, repoId);

        const target = this.resolvePath(projectId, repoId);
        if (this.dirExists(target)) {
            return target;
        }

        const parent = path.dirname(target);
        this.mkdirpSync(parent);

        const repoSlug = repoSlugFor(project, repo);
        const cloneArgs = repo.url
            ? ['repo', 'clone', repo.url, target]
            : ['repo', 'clone', repoSlug, target];

        this.logger.info('repo-fetcher: cloning missing repo', {
            projectId,
            repoId,
            target,
            slug: repoSlug,
        });

        await this.exec(this.ghBin, cloneArgs, { cwd: parent });
        return target;
    }

    /**
     * Look up the resolved path for every repo declared on `projectId`,
     * without cloning. Returned in registry order.
     */
    listRepoPaths(projectId: string): ReadonlyArray<{ readonly repoId: string; readonly path: string }> {
        const project = this.projects.get(projectId);
        return project.repos.map((repo) => ({
            repoId: repo.id,
            path: this.resolvePath(projectId, repo.id),
        }));
    }

    private lookupRepo(projectId: string, repoId: string): RepoSpec {
        const project = this.projects.get(projectId);
        const repo = pickRepo(project, repoId);
        if (!repo) throw new UnknownRepoError(projectId, repoId);
        return repo;
    }

    private workspaceRoot(): string {
        const fromEnv = this.env().PIPELINE_WORKSPACE;
        if (typeof fromEnv === 'string') {
            const trimmed = fromEnv.trim();
            if (trimmed !== '') return trimmed;
        }
        return this.pipelineWorkspace;
    }

    private readOverride(projectId: string, repoId: string): string | undefined {
        if (!this.repoPathsFile) return undefined;
        if (!this.existsSync(this.repoPathsFile)) return undefined;

        let raw: string;
        try {
            raw = this.readFileSync(this.repoPathsFile);
        } catch (err) {
            this.logger.warn('repo-fetcher: override file unreadable', {
                path: this.repoPathsFile,
                error: err instanceof Error ? err.message : String(err),
            });
            return undefined;
        }
        const trimmed = raw.trim();
        if (trimmed === '') return undefined;

        let parsed: unknown;
        try {
            parsed = JSON.parse(trimmed);
        } catch (err) {
            throw new Error(
                `repo-fetcher: ${this.repoPathsFile} is not valid JSON: ${
                    err instanceof Error ? err.message : String(err)
                }`,
            );
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error(
                `repo-fetcher: ${this.repoPathsFile} must contain a JSON object`,
            );
        }
        const map = parsed as Record<string, unknown>;
        const key = `${projectId}/${repoId}`;
        const value = map[key];
        if (value === undefined) return undefined;
        if (typeof value !== 'string' || value.trim() === '') {
            throw new Error(
                `repo-fetcher: ${this.repoPathsFile} entry "${key}" must be a non-empty string path`,
            );
        }
        return value;
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

function pickRepo(project: Project, repoId: string): RepoSpec | undefined {
    for (const r of project.repos) {
        if (r.id === repoId) return r;
    }
    return undefined;
}

/**
 * Compose the `<owner>/<name>` slug `gh repo clone` accepts. Repo-level
 * `owner` / `name` override the project-level `gitHubOwner` / repo id.
 * Throws when no owner can be resolved: cloning without an owner is an
 * operator misconfiguration, not a runtime fallback path.
 */
function repoSlugFor(project: Project, repo: RepoSpec): string {
    const owner = repo.owner ?? project.gitHubOwner;
    if (!owner) {
        throw new RepoCloneError(
            `repo-fetcher: cannot clone "${project.id}/${repo.id}" — no owner set on the repo or project (declare \`gitHubOwner\` on the project or \`owner\` on the repo)`,
        );
    }
    const name = repo.name ?? repo.id;
    return `${owner}/${name}`;
}
