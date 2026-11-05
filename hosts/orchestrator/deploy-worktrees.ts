/**
 * Long-lived, PER-REPO deploy worktrees.
 *
 * Why this exists
 * ---------------
 * Every task normally gets its own feature-branch worktree
 * (`TaskWorktreeStore`) because the agent COMMITS, and because the
 * workspace clone is the shared sync target — `git fetch && git reset
 * --hard` runs on it before every agent spawn, so an agent working
 * there loses its edits to a sibling task's refresh.
 *
 * A `deploy-azure` task is different: it commits nothing. It only needs
 * the merged tip of the default branch plus the repo's `Deploy/*.ps1`.
 * Giving it a throwaway per-task worktree is correct but wasteful — a
 * fresh checkout has no `obj/` or `bin/`, so every deploy pays a full
 * restore + rebuild (the dominant cost for a WASM publish).
 *
 * So deploys get ONE reusable worktree per repo, on a detached HEAD at
 * `origin/<default>`, reset before each deploy. Tracked files always
 * match origin; UNTRACKED build output survives on purpose — that is
 * the entire point (`git reset --hard` does not touch untracked files).
 * Isolation from the shared clone and from concurrent tasks is
 * preserved; only the throwaway-ness is given up.
 *
 * Concurrency
 * -----------
 * Two deploys of the same repo must never share the directory (their
 * builds would interleave). `acquire` hands the shared worktree to one
 * task at a time and returns `null` for anyone else, meaning "use your
 * own per-task worktree". The holder is released lazily: the next
 * caller asks `isTaskInFlight(holder)` and takes over once the previous
 * deploy reached a terminal status. Nothing to unwind on crash, and a
 * worker restart starts with no holders — any agent that was mid-deploy
 * died with the process.
 *
 * Failure policy: every error here degrades to `null` (per-task
 * worktree, i.e. today's behaviour) with a warning naming the repo and
 * the actual git error. A deploy is never blocked by this optimisation.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { Logger } from '../../core/ports/Logger';
import { detectDefaultBranch, runCommand, type GitEnvOverlay } from './task-worktrees';

/**
 * Injectable `git` seam so tests run without a real repository.
 *
 * `env` is the GitHub-account overlay for the remote-touching calls;
 * purely local ones (`status`, `reset`, `rev-parse`) pass nothing.
 */
export type GitRunner = (
    args: readonly string[],
    cwd: string,
    env?: GitEnvOverlay,
) => Promise<{ stdout: string; stderr: string }>;

export interface DeployWorktreeStoreOptions {
    /**
     * Same root the per-task worktrees live under. Deploy worktrees
     * land in a `_deploy/` subfolder so they are obviously not task
     * worktrees when an operator looks at the directory listing, and so
     * a taskId can never collide with a repoId.
     */
    readonly worktreeRoot: string;
    readonly logger: Logger;
    /**
     * Is this task still running? Used to release the shared worktree
     * from a previous holder. Terminal (done / failed / skipped / …)
     * means the directory is free.
     */
    readonly isTaskInFlight: (taskId: string) => boolean;
    readonly runGit?: GitRunner;
    readonly defaultBranchFor?: (repoPath: string) => Promise<string>;
    /**
     * Env overlay for the GitHub account a REPO is reached with.
     *
     * Keyed by repoId, not taskId: a deploy worktree is shared per
     * repo, and the account belongs to the repo either way.
     *
     * Needed because this store runs its own `git fetch origin`. On
     * the machine's ambient identity a private repo that identity
     * cannot see fails as "Repository not found", which reads as a
     * missing repo rather than a wrong credential — the same
     * misdiagnosis the task worktrees produced before they were
     * threaded.
     *
     * Absent, or an empty result, leaves the child ambient.
     */
    readonly githubEnvForRepo?: (repoId: string) => GitEnvOverlay;
}

/**
 * Directory name for a repo's deploy worktree. RepoIds are usually
 * plain slugs, but they are not guaranteed to be path-safe, and two
 * different ids must never sanitise to the same directory (that would
 * silently point two repos at one checkout). When sanitising changes
 * anything, a short deterministic hash of the ORIGINAL id is appended
 * so distinct ids stay distinct.
 */
export function deployWorktreeDirName(repoId: string): string {
    const sanitized = repoId
        .replace(/[^A-Za-z0-9._-]+/g, '-')
        .replace(/^[-.]+|-+$/g, '');
    if (sanitized === repoId && sanitized.length > 0) return sanitized;
    // djb2 — not cryptographic, just a collision break for the rare
    // repoId that needs sanitising.
    let hash = 5381;
    for (let i = 0; i < repoId.length; i += 1) {
        hash = ((hash * 33) ^ repoId.charCodeAt(i)) >>> 0;
    }
    const suffix = hash.toString(36);
    return sanitized.length > 0 ? `${sanitized}-${suffix}` : `repo-${suffix}`;
}

export class DeployWorktreeStore {
    private readonly worktreeRoot: string;
    private readonly logger: Logger;
    private readonly isTaskInFlight: (taskId: string) => boolean;
    private readonly runGit: GitRunner;
    private readonly defaultBranchFor: (repoPath: string) => Promise<string>;
    private readonly githubEnvForRepo?: (repoId: string) => GitEnvOverlay;

    /** repoId -> taskId currently using the shared deploy worktree. */
    private readonly holders = new Map<string, string>();

    constructor(options: DeployWorktreeStoreOptions) {
        this.worktreeRoot = options.worktreeRoot;
        this.logger = options.logger;
        this.isTaskInFlight = options.isTaskInFlight;
        this.runGit = options.runGit
            ?? ((args, cwd, env): Promise<{ stdout: string; stderr: string }> =>
                runCommand('git', args, cwd, this.logger, env));
        this.githubEnvForRepo = options.githubEnvForRepo;
        this.defaultBranchFor = options.defaultBranchFor
            ?? ((repoPath: string): Promise<string> =>
                detectDefaultBranch(repoPath, this.logger));
    }

    /** Absolute path this repo's deploy worktree would occupy. */
    pathFor(repoId: string): string {
        return path.join(this.worktreeRoot, '_deploy', deployWorktreeDirName(repoId));
    }

    /**
     * Claim the repo's shared deploy worktree for `taskId` and return
     * its path, refreshed to `origin/<default>`.
     *
     * Returns `null` when the caller must fall back to a per-task
     * worktree: another deploy of the same repo is still in flight, the
     * repo is unknown, or git failed. `null` is always SAFE — it is the
     * pre-existing behaviour.
     */
    async acquire(
        taskId: string,
        repoId: string,
        repoPath: string,
    ): Promise<string | null> {
        if (repoId.length === 0 || repoPath.length === 0) return null;

        const holder = this.holders.get(repoId);
        if (holder && holder !== taskId && this.isTaskInFlight(holder)) {
            this.logger.info(
                'deploy-worktrees: shared worktree busy — falling back to a per-task worktree',
                { taskId, repoId, heldBy: holder },
            );
            return null;
        }

        const target = this.pathFor(repoId);
        try {
            if (fs.existsSync(target) && await this.metadataValid(target)) {
                await this.refresh(target, repoPath, repoId);
            } else {
                await this.create(target, repoPath, repoId);
            }
        } catch (err) {
            this.logger.warn(
                'deploy-worktrees: could not prepare the shared deploy worktree'
                + ' — falling back to a per-task worktree',
                {
                    taskId,
                    repoId,
                    path: target,
                    error: err instanceof Error ? err.message : String(err),
                },
            );
            return null;
        }

        this.holders.set(repoId, taskId);
        return target;
    }

    /**
     * Build the worktree from scratch on a DETACHED HEAD at the origin
     * tip. Detached on purpose: a deploy produces no commits, so there
     * is no branch to own, and a detached checkout can never be
     * mistaken for a task's feature branch by the push / PR paths.
     */
    private async create(
        target: string,
        repoPath: string,
        repoId: string,
    ): Promise<void> {
        if (fs.existsSync(target)) {
            // Directory exists but git no longer recognises it (pruned
            // metadata, half-finished teardown). Junk it and rebuild
            // rather than running a deploy from a checkout whose every
            // git command errors.
            this.logger.warn(
                'deploy-worktrees: existing directory has broken .git metadata — rebuilding',
                { repoId, path: target },
            );
            fs.rmSync(target, { recursive: true, force: true });
        }
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const base = await this.defaultBranchFor(repoPath);
        await this.runGit(
            ['worktree', 'add', '--detach', target, `origin/${base}`],
            repoPath,
        );
        this.logger.info('deploy-worktrees: created shared deploy worktree', {
            repoId, path: target, base,
        });
    }

    /**
     * Reset the existing worktree to the current origin tip.
     *
     * `git reset --hard` deliberately leaves untracked files alone, so
     * `obj/` and `bin/` carry over and the next build is incremental.
     * Tracked modifications ARE discarded — nothing should be editing
     * this checkout — but they are logged first, because a silently
     * reverted edit is exactly the kind of thing that costs an
     * afternoon.
     */
    private async refresh(
        target: string,
        repoPath: string,
        repoId: string,
    ): Promise<void> {
        // The only call here that talks to the remote, so the only one
        // that needs the repo's GitHub account.
        await this.runGit(['fetch', 'origin'], target, this.githubEnvForRepo?.(repoId));
        const base = await this.defaultBranchFor(repoPath);

        const { stdout } = await this.runGit(['status', '--porcelain'], target);
        // Untracked ('??') entries are the build output we are keeping;
        // only tracked changes are worth reporting.
        const trackedChanges = stdout
            .split(/\r?\n/)
            .filter((line) => line.trim().length > 0 && !line.startsWith('??'));
        if (trackedChanges.length > 0) {
            this.logger.warn(
                'deploy-worktrees: discarding local changes in the shared deploy worktree',
                {
                    repoId,
                    path: target,
                    files: trackedChanges.slice(0, 10).map((l) => l.slice(3)),
                    totalChanged: trackedChanges.length,
                },
            );
        }

        await this.runGit(['reset', '--hard', `origin/${base}`], target);
        this.logger.info('deploy-worktrees: reused shared deploy worktree', {
            repoId, path: target, base,
        });
    }

    /**
     * Cheapest probe that the checkout's `.git` pointer still resolves.
     * Mirrors `TaskWorktreeStore.worktreeMetadataValid`.
     */
    private async metadataValid(target: string): Promise<boolean> {
        try {
            await this.runGit(['rev-parse', '--git-dir'], target);
            return true;
        } catch {
            return false;
        }
    }
}
