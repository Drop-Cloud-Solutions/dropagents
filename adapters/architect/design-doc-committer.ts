/**
 * Architect Tier (Phase 2) — best-effort commit of a requirement's design doc
 * to the workspace-wide `architecture` repo when its architecture is approved.
 *
 * Writes `requirements/<requirementId>/design.md` (+ `rollout.md`) into the
 * architecture repo's clone and commits + pushes them straight to the default
 * branch. Strictly best-effort: a missing clone, a git failure, or an
 * unconfigured architecture repo is logged and skipped — never fatal, and it
 * never blocks the fan-out that runs alongside it.
 *
 * The clone at `<workspace>/repos/<repoId>` is the shared working copy the
 * repo-sync keeps `git reset --hard origin/<branch>`-clean; committing then
 * pushing immediately means a concurrent sync reconverges on our commit via
 * the next fetch rather than dropping it.
 */

import { execFile, type ExecFileException } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface ExecResult {
    readonly stdout: string;
    readonly stderr: string;
}

export type ExecRunner = (
    command: string,
    args: readonly string[],
    options: {
        readonly cwd: string;
        /**
         * Env overlay, spread onto the inherited environment. Set
         * only for the call that talks to the remote.
         */
        readonly env?: Readonly<Record<string, string>>;
    },
) => Promise<ExecResult>;

export interface DesignDocCommitLogger {
    info(message: string, data?: unknown): void;
    warn(message: string, data?: unknown): void;
}

export interface CommitDesignDocArgs {
    /** The architecture repo's clone path (`<workspace>/repos/<repoId>`). */
    readonly repoPath: string;
    readonly requirementId: string;
    readonly designDoc: string;
    /** Optional rollout.md content. */
    readonly rollout?: string;
    readonly defaultBranch: string;
    /**
     * Env overlay for the GitHub account the ARCHITECTURE repo is
     * reached with.
     *
     * The push below is a remote call like every other, and the
     * architecture repo need not live on the machine's ambient
     * account. Without it a private architecture repo fails as
     * "Repository not found" - and since this whole path is
     * best-effort, the failure is a log line the operator never
     * reads, and the design doc silently never lands.
     *
     * Absent or empty leaves the child ambient.
     */
    readonly githubEnv?: Readonly<Record<string, string>>;
}

export interface CommitDesignDocDeps {
    readonly exec?: ExecRunner;
    readonly mkdir?: (dir: string) => Promise<void>;
    readonly writeFile?: (file: string, data: string) => Promise<void>;
    readonly env?: NodeJS.ProcessEnv;
    readonly logger?: DesignDocCommitLogger;
}

const MAX_BUFFER = 16 * 1024 * 1024;

function defaultExec(): ExecRunner {
    return (command, args, options) =>
        new Promise<ExecResult>((resolve, reject) => {
            execFile(
                command,
                args.slice(),
                {
                    cwd: options.cwd,
                    encoding: 'utf8',
                    maxBuffer: MAX_BUFFER,
                    // Spread, not replace: the child still needs PATH,
                    // HOME and the rest.
                    ...(options.env && Object.keys(options.env).length > 0
                        ? { env: { ...process.env, ...options.env } }
                        : {}),
                },
                (err, stdout, stderr) => {
                    const out = typeof stdout === 'string' ? stdout : String(stdout ?? '');
                    const errOut = typeof stderr === 'string' ? stderr : String(stderr ?? '');
                    if (err) {
                        const raw = (err as ExecFileException).code;
                        const exitCode = typeof raw === 'number' ? raw : Number(raw) || 1;
                        reject(Object.assign(new Error(`${command} exited ${exitCode}: ${errOut || out}`), {
                            exitCode,
                        }));
                        return;
                    }
                    resolve({ stdout: out, stderr: errOut });
                },
            );
        });
}

/**
 * Write + commit + push the design doc. Returns true when a commit was pushed,
 * false when there was nothing to commit or the attempt failed (best-effort;
 * never throws).
 */
export async function commitDesignDoc(
    args: CommitDesignDocArgs,
    deps: CommitDesignDocDeps = {},
): Promise<boolean> {
    const exec = deps.exec ?? defaultExec();
    const mkdir = deps.mkdir ?? ((dir) => fs.promises.mkdir(dir, { recursive: true }).then(() => undefined));
    const writeFile = deps.writeFile ?? ((file, data) => fs.promises.writeFile(file, data, 'utf8'));
    const { repoPath, requirementId, designDoc, rollout, defaultBranch } = args;
    const relDir = `requirements/${requirementId}`;
    const dir = path.join(repoPath, 'requirements', requirementId);

    try {
        await mkdir(dir);
        await writeFile(path.join(dir, 'design.md'), designDoc);
        if (typeof rollout === 'string' && rollout.length > 0) {
            await writeFile(path.join(dir, 'rollout.md'), rollout);
        }
        await exec('git', ['add', '--', relDir], { cwd: repoPath });

        // `git diff --cached --quiet` exits 0 when nothing is staged (a
        // re-approval that changed nothing) → treat as a no-op.
        let hasChanges = false;
        try {
            await exec('git', ['diff', '--cached', '--quiet'], { cwd: repoPath });
        } catch {
            hasChanges = true;
        }
        if (!hasChanges) {
            deps.logger?.info('design-doc-committer: nothing to commit', { requirementId });
            return false;
        }

        const env = deps.env ?? process.env;
        if (env.GIT_COMMIT_NAME) {
            await exec('git', ['config', '--local', 'user.name', env.GIT_COMMIT_NAME], { cwd: repoPath });
        }
        if (env.GIT_COMMIT_EMAIL) {
            await exec('git', ['config', '--local', 'user.email', env.GIT_COMMIT_EMAIL], { cwd: repoPath });
        }
        await exec('git', ['commit', '-m', `architecture: design for ${requirementId}`], { cwd: repoPath });
        // The one call that reaches GitHub, so the only one given the
        // account. The local `git config` writes above deliberately
        // stay ambient - they edit this clone's config, not a remote.
        await exec('git', ['push', 'origin', `HEAD:${defaultBranch}`], {
            cwd: repoPath,
            ...(args.githubEnv && Object.keys(args.githubEnv).length > 0
                ? { env: args.githubEnv }
                : {}),
        });
        deps.logger?.info('design-doc-committer: committed + pushed', { requirementId });
        return true;
    } catch (err) {
        deps.logger?.warn('design-doc-committer: failed (best-effort, skipped)', {
            requirementId,
            error: err instanceof Error ? err.message : String(err),
        });
        return false;
    }
}
