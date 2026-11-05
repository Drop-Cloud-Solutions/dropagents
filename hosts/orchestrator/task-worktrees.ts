/**
 * Per-task feature-branch worktree registry + lifecycle.
 *
 * The developer agent must not write to the workspace clone's main
 * branch — every task gets its own `git worktree` checked out on a
 * fresh feature branch. The reviewer / tester / committer agents
 * inherit the same worktree so they all see (and amend) the developer's
 * changes. Once the committer finishes, the post-commit hook pushes
 * the branch and opens a PR via `gh`.
 *
 * State is persisted in `task_worktrees` (migration 015) so a worker
 * restart can resume a task's chain without re-cloning or losing the
 * branch identity.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';

import type { Db } from '../../core/state/migrations';
import type { Logger } from '../../core/ports/Logger';
import {
    describeAutoMergeUnavailable,
    describeMergeEnqueued,
    isAutoMergeUnavailable,
    isMergeBlockedByRequirements,
} from './merge-classify';
import { ensureClaudeWorkspaceTrust } from '../../adapters/claude-cli/claude-trust';

export interface TaskWorktreeRecord {
    readonly taskId: string;
    readonly repoId: string;
    readonly branch: string;
    readonly path: string;
    readonly createdAt: number;
    readonly pushedAt: number | null;
    readonly prUrl: string | null;
    readonly prNumber: number | null;
}

interface TaskWorktreeRow {
    task_id: string;
    repo_id: string;
    branch: string;
    path: string;
    created_at: number;
    pushed_at: number | null;
    pr_url: string | null;
    pr_number: number | null;
}

function recordFromRow(r: TaskWorktreeRow): TaskWorktreeRecord {
    return {
        taskId: r.task_id,
        repoId: r.repo_id,
        branch: r.branch,
        path: r.path,
        createdAt: r.created_at,
        pushedAt: r.pushed_at,
        prUrl: r.pr_url,
        prNumber: r.pr_number,
    };
}

/**
 * Wrap an argv string so cmd.exe treats it as one token. Without this,
 * `--title Add roleId filter to LoanAllowancesApi` is handed to gh as
 * seven separate arguments (`Add`, `roleId`, …) because Node's
 * `shell: true` on Windows joins args with spaces and cmd.exe re-parses
 * the line. Arguments without whitespace or quotes pass through
 * untouched so the quoted form is only paid where required.
 *
 * cmd.exe quoting rules differ from POSIX: backslashes are literal,
 * but `"` inside a quoted string is escaped by doubling it (`""`).
 * The check below covers the only metacharacters that come up in
 * gh / git args we build (the PR title is the only field that's not
 * already a path or fixed token).
 */
function quoteForWindowsShell(arg: string): string {
    if (!/[\s"]/.test(arg)) return arg;
    return `"${arg.replace(/"/g, '""')}"`;
}

/**
 * Normalise free text destined for a Windows `shell: true` command line.
 *
 * Embedded double quotes are the one case {@link quoteForWindowsShell}
 * cannot make safe: with `shell: true` the line is parsed TWICE — first
 * by cmd.exe (where any `"` toggles quote state) and then by the child's
 * own argv parser (gh is Go; its rules differ from cmd's `""` doubling),
 * and the two disagree. Observed failure (T-PNSO-001): a PR title
 * containing `"0"` flipped quote parity mid-line and `gh pr create`
 * exited 1 with `unknown arguments`, gluing the rest of the title and
 * the next flag into garbage tokens.
 *
 * The only free-text field we pass on a command line is the PR title, so
 * trade typographic fidelity for correctness: straight double quotes
 * become single quotes and newlines collapse to spaces (a title is one
 * line by definition). The PR BODY travels via --body-file and keeps
 * full fidelity.
 */
export function sanitizeCliText(text: string): string {
    return text.replace(/"/g, "'").replace(/\r?\n/g, ' ').trim();
}

/**
 * Runs `git` / `gh` as a child process and resolves with stdout +
 * stderr. Throws on non-zero exit so callers can surface the error
 * back to the operator. On Windows the runner runs under `shell: true`
 * (so `.cmd` shims like `gh.cmd` resolve) which means we hand-quote
 * args with whitespace before spawn — Node's auto-quoting only kicks
 * in for `shell: false`.
 */
/**
 * Read the repo's default branch from `git symbolic-ref --short
 * refs/remotes/origin/HEAD` (which `git clone` populates as
 * `origin/<default-branch>`). Strips the `origin/` prefix and returns
 * just the branch name. Falls back to `main` when the symbolic-ref
 * call fails — handles fresh clones whose origin/HEAD wasn't set, or
 * worktrees on a detached HEAD. Used by `runPostCommitHook` to pass
 * the correct `--base` to `gh pr create` instead of assuming `main`.
 */
export async function detectDefaultBranch(
    cwd: string,
    logger?: Logger,
): Promise<string> {
    try {
        const { stdout } = await runCommand(
            'git',
            ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
            cwd,
            logger,
        );
        const ref = stdout.trim();
        if (ref.length === 0) return 'main';
        // `git symbolic-ref --short` returns `origin/<branch>` — strip
        // the remote prefix so the result is a bare branch name `gh`
        // can use as `--base`.
        if (ref.startsWith('origin/')) return ref.slice('origin/'.length);
        return ref;
    } catch (err) {
        logger?.warn('task-worktrees: default-branch detect failed; falling back to main', {
            cwd,
            error: err instanceof Error ? err.message : String(err),
        });
        return 'main';
    }
}

/**
 * Extra environment for one git/gh invocation.
 *
 * Carries the GitHub account a repo is reached with: `GH_CONFIG_DIR`
 * for `gh`, `GIT_COMMIT_*` for the author line, and
 * `GIT_CONFIG_*` to point `git push` at the same credential.
 * Resolved by the orchestrator, which owns the repo registry, and
 * passed in - so this module stays free of config concerns.
 *
 * EMPTY for a repo with no account mapped, which leaves the child on
 * the machine's ambient identity: what every repo used before
 * accounts existed.
 */
export type GitEnvOverlay = Readonly<Record<string, string>>;

/**
 * How much of a failed command's stderr survives into the Error.
 *
 * It was 200 characters, and that silently cut the most important
 * sentence gh writes. A PR blocked by "Require branches to be up to
 * date" fails with:
 *
 *   X Pull request #46 is not mergeable: the head branch is not up to
 *     date with the base branch.
 *   To have the pull request merged after all the requirements have
 *     been met, add the `--auto` flag.
 *
 * The first line is 117 characters, so the 200-char cut landed on
 * "add the `-" and the `--auto` hint - which the classifier looks for
 * to recognise a requirements block - never reached it. The failure
 * was then read as "is not mergeable" = a CONFLICT, and a
 * merge-resolver agent was sent at a PR that only needed its branch
 * updated. It asked the operator what to do; GitHub merged the PR by
 * itself five minutes later.
 *
 * gh messages run to a few hundred characters, so there is room for
 * all of them. The limit exists only to stop a pathological tool dump
 * from filling an event payload.
 */
const STDERR_ERROR_LIMIT = 2_000;
/** Same, for the warn line - the operator reads this one. */
const STDERR_LOG_LIMIT = 1_200;

export async function runCommand(
    cmd: string,
    args: readonly string[],
    cwd: string,
    logger?: Logger,
    env?: GitEnvOverlay,
): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
        const onWindows = process.platform === 'win32';
        const spawnArgs = onWindows
            ? args.map((a) => quoteForWindowsShell(a))
            : args;
        const child = spawn(cmd, spawnArgs, {
            cwd,
            stdio: ['ignore', 'pipe', 'pipe'],
            shell: onWindows,
            // Overlaid on the parent env, never replacing it: git and
            // gh still need PATH, and on Windows SystemRoot and
            // friends. An absent overlay spreads to nothing.
            env: { ...process.env, ...(env ?? {}) },
        });
        let stdout = '';
        let stderr = '';
        child.stdout?.on('data', (d: Buffer) => { stdout += d.toString('utf8'); });
        child.stderr?.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
        child.on('error', (err) => reject(err));
        child.on('close', (code) => {
            if (code === 0) {
                resolve({ stdout, stderr });
                return;
            }
            logger?.warn('task-worktrees: command failed', {
                cmd: `${cmd} ${args.join(' ')}`,
                cwd,
                exitCode: code,
                stderr: stderr.trim().slice(0, STDERR_LOG_LIMIT),
            });
            reject(new Error(
                `${cmd} ${args.join(' ')} exited ${code}: `
                + stderr.trim().slice(0, STDERR_ERROR_LIMIT),
            ));
        });
    });
}

export interface TaskWorktreeStoreOptions {
    readonly db: Db;
    readonly worktreeRoot: string;
    readonly logger: Logger;
    readonly clock?: () => number;
    /** Branch-name generator — defaults to `task/<taskId>`. */
    readonly branchForTask?: (taskId: string) => string;
    /**
     * Resolves the workspace clone path for a repoId. Used by
     * `removeOnDisk` to find the superproject `git worktree remove` has
     * to run from. Returns `null` when the repo isn't in the registry
     * (the clone was deleted, the row predates the registry, …) — the
     * caller falls back to a filesystem-only delete in that case.
     */
    readonly resolveRepoPath?: (repoId: string) => string | null;
    /**
     * Env overlay for a task's GitHub account. See {@link GitEnvOverlay}.
     *
     * The store runs `git fetch` / `git reset --hard` inside a
     * worktree, which talks to the REMOTE and so needs the account
     * like every other remote call. Injected rather than resolved
     * here because the orchestrator owns the repo registry.
     *
     * Absent, or an empty result, leaves the child on the machine's
     * ambient identity.
     */
    readonly githubEnvForTask?: (taskId: string) => GitEnvOverlay;
}

export class TaskWorktreeStore {
    private readonly db: Db;
    private readonly worktreeRoot: string;
    private readonly logger: Logger;
    private readonly clock: () => number;
    private readonly branchForTask: (taskId: string) => string;
    private readonly resolveRepoPath?: (repoId: string) => string | null;
    private readonly githubEnvForTask?: (taskId: string) => GitEnvOverlay;

    private readonly selectStmt;
    private readonly selectTasksByPlanStmt;
    private readonly insertStmt;
    private readonly markPushedStmt;
    private readonly setPrStmt;
    private readonly deleteRowStmt;

    constructor(options: TaskWorktreeStoreOptions) {
        this.db = options.db;
        this.worktreeRoot = options.worktreeRoot;
        this.logger = options.logger;
        this.clock = options.clock ?? ((): number => Date.now());
        this.branchForTask = options.branchForTask
            ?? ((taskId: string): string => `task/${taskId}`);
        this.resolveRepoPath = options.resolveRepoPath;
        this.githubEnvForTask = options.githubEnvForTask;

        this.selectStmt = this.db.prepare(
            'SELECT * FROM task_worktrees WHERE task_id = ?',
        );
        // Enumeration key for `removeAllForPlan`. `tasks.plan_id` is the
        // column — the plan FK was dropped in migration 013 but the
        // column remains and is indexed (`idx_tasks_plan_id`).
        this.selectTasksByPlanStmt = this.db.prepare(
            'SELECT id FROM tasks WHERE plan_id = ?',
        );
        this.insertStmt = this.db.prepare(
            `INSERT INTO task_worktrees(task_id, repo_id, branch, path, created_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(task_id) DO NOTHING`,
        );
        this.markPushedStmt = this.db.prepare(
            'UPDATE task_worktrees SET pushed_at = ? WHERE task_id = ?',
        );
        this.setPrStmt = this.db.prepare(
            'UPDATE task_worktrees SET pr_url = ?, pr_number = ? WHERE task_id = ?',
        );
        this.deleteRowStmt = this.db.prepare(
            'DELETE FROM task_worktrees WHERE task_id = ?',
        );
    }

    get(taskId: string): TaskWorktreeRecord | null {
        const row = this.selectStmt.get(taskId) as TaskWorktreeRow | undefined;
        return row ? recordFromRow(row) : null;
    }

    /**
     * Resolve the on-disk bare-clone path for the task's repo. Used by
     * `mergeTaskPr` to run `gh pr merge --delete-branch` in a clone
     * that's on `main`, which avoids the "main is already used by
     * worktree" error gh otherwise hits when it runs the local
     * cleanup from inside the worktree. Returns `null` when the task
     * has no worktree row, the repoId is empty, or the repo registry
     * has no `ensuredPath` for the repoId (caller falls back to the
     * worktree path).
     */
    repoPathForTask(taskId: string): string | null {
        const rec = this.get(taskId);
        if (!rec || rec.repoId.length === 0) return null;
        return this.resolveRepoPath?.(rec.repoId) ?? null;
    }

    /**
     * Look up or create a worktree for the task. Idempotent: a second
     * call after the worktree already exists returns the existing
     * record without re-running `git worktree add`. The branch is
     * created off the repo's HEAD (origin/main when the workspace
     * clone is freshly fetched).
     *
     * The actual `git worktree add` is run in the repo clone at
     * `repoPath`. The worktree directory lands at
     * `<worktreeRoot>/<taskId>` so a multi-repo workspace doesn't
     * collide. When the directory already exists on disk (replay
     * after restart) it is adopted instead of re-created.
     */
    async ensureWorktree(
        taskId: string,
        repoId: string,
        repoPath: string,
    ): Promise<TaskWorktreeRecord> {
        const existing = this.get(taskId);
        /** PR + push state rescued from a row we are about to rebuild. */
        let carried: {
            pushedAt: number | null;
            prUrl: string | null;
            prNumber: number | null;
        } | null = null;
        if (existing) {
            // Validate the on-disk state before reusing. A row pointing
            // at a worktree whose `.git` metadata was wiped (the
            // canonical case: `git worktree prune` ran in the bare
            // clone while the checkout dir was transiently gone, or an
            // operator deleted `.git/worktrees/<name>` by hand) would
            // otherwise be returned as-is — every subsequent git
            // command in that checkout fails with `fatal: not a git
            // repository: <bare>/.git/worktrees/<name>` and the
            // operator can't review the diff or restart the task
            // without manual intervention.
            //
            // If the dir is missing OR the metadata link is broken,
            // wipe both the dir and the DB row and fall through to the
            // create path so a fresh worktree gets built from the
            // current `origin/<default>` tip.
            if (
                fs.existsSync(existing.path)
                && await this.worktreeMetadataValid(existing.path)
            ) {
                return existing;
            }
            this.logger.warn(
                'task-worktrees: existing worktree is broken — rebuilding',
                { taskId, path: existing.path, prNumber: existing.prNumber },
            );
            await this.removeOnDisk(taskId);
            this.deleteRowStmt.run(taskId);
            // Carry the PR across the rebuild. The row is keyed on the
            // TASK, and `pr_url` / `pr_number` are facts about its branch
            // on GitHub — a missing checkout directory says nothing about
            // whether the PR still exists.
            //
            // Field case (L-FADC-005 / L-FADC-007): `mergeTaskPr`
            // deliberately tears the worktree down BEFORE `gh pr merge` so
            // `--delete-branch` can run. On a conflicted merge the
            // merge-resolver then calls back in here to get the worktree
            // again — and found the directory gone, rebuilt the row, and
            // dropped the PR number with it. The agent went on to resolve
            // the conflict and push correctly, and the re-dispatched merge
            // then failed with "no PR open for this task — commit must
            // complete first". Every conflicted merge ended that way: the
            // hard part automated, the last step broken, and the operator
            // finishing by hand wondering why the resolver had not run.
            carried = {
                pushedAt: existing.pushedAt,
                prUrl: existing.prUrl,
                prNumber: existing.prNumber,
            };
        }

        const branch = this.branchForTask(taskId);
        const target = path.join(this.worktreeRoot, taskId);
        fs.mkdirSync(this.worktreeRoot, { recursive: true });

        if (fs.existsSync(target)) {
            // Adopt — earlier worker session left this directory in
            // place. But ONLY when git still considers it a valid
            // worktree. The bare clone's `.git/worktrees/<name>`
            // metadata can get out of sync with the checkout directory
            // — a previous `git worktree prune` ran while the dir was
            // transiently gone, an aborted teardown left the metadata
            // half-removed, an operator deleted the metadata folder
            // manually, etc. In those cases the checkout's `.git`
            // pointer file references a metadata path that no longer
            // resolves, and every `git` command inside the worktree
            // (status, diff, commit, …) errors with
            // `fatal: not a git repository: <bare>/.git/worktrees/<name>`.
            //
            // `git rev-parse --git-dir` inside the checkout dir is the
            // cheapest probe: it returns the resolved metadata path on
            // success and exits non-zero when the link is broken. On
            // success we proceed with the adoption (the metadata is
            // still valid and the new DB row just needs reconnecting).
            // On failure we treat the dir as junk: wipe it from disk
            // and fall through to the create path so a fresh worktree
            // is built from `origin/<default>`.
            const valid = await this.worktreeMetadataValid(target);
            if (valid) {
                this.logger.info('task-worktrees: adopting existing directory', {
                    taskId, repoId, branch, path: target,
                });
            } else {
                this.logger.warn(
                    'task-worktrees: existing directory has broken .git metadata — rebuilding',
                    { taskId, repoId, branch, path: target },
                );
                try {
                    fs.rmSync(target, { recursive: true, force: true });
                } catch (err) {
                    this.logger.warn(
                        'task-worktrees: fs.rm of broken worktree dir failed (continuing)',
                        {
                            taskId,
                            path: target,
                            error: err instanceof Error ? err.message : String(err),
                        },
                    );
                }
                // Fall through into the create-or-attach block below by
                // re-checking fs.existsSync at runtime. The simplest
                // way to express that is to run the create path inline
                // here (mirrors the else branch logic verbatim) —
                // restructuring the surrounding if/else for one rare
                // path would obscure the common case.
                await this.createOrAttachWorktree(
                    taskId, repoId, repoPath, branch, target,
                );
            }
        } else {
            await this.createOrAttachWorktree(
                taskId, repoId, repoPath, branch, target,
            );
        }

        // Trust the worktree in Claude Code's config before any agent
        // runs in it. This was the gap behind "this workspace has not
        // been trusted": trust is keyed by the EXACT cwd with no
        // inheritance from a parent, and a per-task worktree is a
        // brand-new directory no human has ever opened - so the clone
        // being trusted did nothing for the directory the agent
        // actually started in.
        //
        // Awaited so the write lands before the agent spawns, and
        // idempotent, so the repeated ensureWorktree calls for an
        // existing worktree cost nothing.
        await ensureClaudeWorkspaceTrust([target], this.logger);

        // Make sure the agent's scaffold files (TASK.md /
        // WORKSPACE_RULES.md) are excluded from git so the committer
        // never stages them. Cheap + idempotent — runs on every
        // ensureWorktree but only writes when the patterns aren't
        // already in the exclude file.
        await this.ensureScaffoldFilesExcluded(repoPath);

        const createdAt = this.clock();
        this.insertStmt.run(taskId, repoId, branch, target, createdAt);
        if (carried !== null) {
            // Restore before the re-read below, so callers never observe
            // the row without its PR.
            if (carried.prNumber !== null || carried.prUrl !== null) {
                this.setPrStmt.run(carried.prUrl, carried.prNumber, taskId);
            }
            if (carried.pushedAt !== null) {
                this.markPushedStmt.run(carried.pushedAt, taskId);
            }
        }
        // Re-read in case ON CONFLICT NO-OP'd because a sibling
        // process inserted first — the row's path is the authority.
        const rec = this.get(taskId);
        if (rec) return rec;
        return {
            taskId, repoId, branch, path: target, createdAt,
            pushedAt: carried?.pushedAt ?? null,
            prUrl: carried?.prUrl ?? null,
            prNumber: carried?.prNumber ?? null,
        };
    }

    /**
     * Append `TASK.md` and `WORKSPACE_RULES.md` to the bare clone's
     * `.git/info/exclude` so git treats them as untracked-and-ignored.
     * The committer agent inspects `git status` to decide what to
     * stage — with these entries in place the scaffold files never
     * appear there and never get committed. Merge conflicts on PR-to-
     * PR (caused by different tasks committing different TASK.md
     * content) go away.
     *
     * `.git/info/exclude` is repo-local (lives in the clone, not in
     * the repo's tree) so this never accidentally adds entries to the
     * project's checked-in `.gitignore`. Worktrees share the bare
     * clone's git dir, so one write covers every per-task worktree
     * branched off the same clone.
     *
     * Idempotent: reads the file first, only appends patterns that
     * aren't already present. Best-effort: any FS error is logged and
     * swallowed so a transient permissions issue doesn't block agent
     * spawn.
     */
    private async ensureScaffoldFilesExcluded(repoPath: string): Promise<void> {
        const excludePath = path.join(repoPath, '.git', 'info', 'exclude');
        // `/attachments/` (root-anchored) is the operator-attachment dir the
        // orchestrator materialises into the worktree for the agent to Read
        // (migration 021) — excluded for the same reason as the scaffold
        // files: it must never land in the task's commit / PR.
        // `clarification-answer.md` / `feedback.md` are the ResumeTask
        // sidecars (handlers/resume.ts). They land at the worktree root
        // like TASK.md and must be excluded for the same reason: the
        // committer decides what to stage from `git status`, and an
        // operator's answer has no business in the task's commit or PR.
        const patterns = [
            'TASK.md',
            'WORKSPACE_RULES.md',
            '/attachments/',
            'clarification-answer.md',
            'feedback.md',
        ];
        try {
            const existing = fs.existsSync(excludePath)
                ? fs.readFileSync(excludePath, 'utf8')
                : '';
            const existingLines = new Set(
                existing.split(/\r?\n/).map((l) => l.trim()),
            );
            const missing = patterns.filter((p) => !existingLines.has(p));
            if (missing.length === 0) return;
            const sep = existing.length === 0 || existing.endsWith('\n')
                ? ''
                : '\n';
            fs.mkdirSync(path.dirname(excludePath), { recursive: true });
            fs.appendFileSync(
                excludePath,
                `${sep}${missing.join('\n')}\n`,
                'utf8',
            );
            this.logger.info(
                'task-worktrees: added scaffold files to .git/info/exclude',
                { repoPath, patternsAdded: missing },
            );
        } catch (err) {
            this.logger.warn(
                'task-worktrees: failed to update .git/info/exclude (continuing)',
                {
                    repoPath,
                    excludePath,
                    error: err instanceof Error ? err.message : String(err),
                },
            );
        }
    }

    /**
     * Bring an existing worktree's feature branch up to date with
     * `origin/<defaultBranch>` WHEN IT IS SAFE TO DO SO.
     *
     * Refreshing the bare clone (`refreshOne` in resolveTaskRepoSpec)
     * advances the workspace clone to the latest origin tip, but the
     * worktree's `task/<id>` branch was branched off origin at the
     * moment of first creation — subsequent origin merges (a sibling
     * task's PR landing, an out-of-band commit) don't propagate into
     * the worktree's branch automatically. Without this helper the
     * developer agent reads stale code AFTER its upstream dependency
     * was already merged.
     *
     * "Safe" means: the worktree's branch has produced no commits of
     * its own AND has no uncommitted working-tree changes. Both checks
     * are conservative — if either fails we leave the worktree alone
     * so the developer's WIP across multi-step task pipelines (dev →
     * review → test → commit) is never clobbered.
     *
     * On a clean worktree we do `git fetch origin` + `git reset --hard
     * origin/<defaultBranch>`. All operations run inside the worktree
     * directory itself so the bare clone's HEAD is not touched.
     *
     * Best-effort: any git error is logged and swallowed so a
     * transient FS issue does not block agent spawn.
     */
    async freshenIfClean(taskId: string): Promise<void> {
        const rec = this.get(taskId);
        if (!rec) return;
        if (!fs.existsSync(rec.path)) return;

        // Uncommitted-changes check. `git status --porcelain` prints
        // one line per modified/untracked file; empty stdout means the
        // working tree is pristine.
        let dirty = false;
        try {
            const { stdout } = await runCommand(
                'git',
                ['status', '--porcelain'],
                rec.path,
            );
            dirty = stdout.trim().length > 0;
        } catch (err) {
            this.logger.warn('task-worktrees: status check failed', {
                taskId,
                error: err instanceof Error ? err.message : String(err),
            });
            return;
        }
        if (dirty) {
            this.logger.info(
                'task-worktrees: freshenIfClean — uncommitted WIP, leaving worktree as-is',
                { taskId, path: rec.path },
            );
            return;
        }

        // Detect the upstream default branch from the worktree itself.
        // `git symbolic-ref refs/remotes/origin/HEAD` resolves it via
        // the remote symref the clone inherited at `git clone` time.
        let defaultBranch = 'main';
        try {
            const { stdout } = await runCommand(
                'git',
                ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
                rec.path,
            );
            const ref = stdout.trim();
            if (ref.startsWith('origin/')) {
                defaultBranch = ref.slice('origin/'.length);
            }
        } catch {
            // origin/HEAD not set — fall back to 'main'.
        }

        // Local-commits check. `git rev-list HEAD ^origin/<default>
        // --count` returns the number of commits the worktree's branch
        // has that origin's default branch does not. >0 means the
        // developer has already committed and we must not clobber.
        let aheadCount = 0;
        try {
            const { stdout } = await runCommand(
                'git',
                ['rev-list', 'HEAD', `^origin/${defaultBranch}`, '--count'],
                rec.path,
            );
            const parsed = Number.parseInt(stdout.trim(), 10);
            if (Number.isFinite(parsed)) aheadCount = parsed;
        } catch (err) {
            this.logger.warn('task-worktrees: rev-list check failed', {
                taskId,
                error: err instanceof Error ? err.message : String(err),
            });
            return;
        }
        if (aheadCount > 0) {
            this.logger.info(
                'task-worktrees: freshenIfClean — local commits present, leaving worktree as-is',
                { taskId, path: rec.path, aheadCount },
            );
            return;
        }

        // Clean worktree — safe to advance to the latest origin tip.
        // `git fetch origin` is cheap (the bare clone's refresh already
        // populated the local object store for the same remote, but
        // git's refs/remotes/origin/* are per-clone, and this worktree
        // shares the bare clone's `.git/` — so the fetch is mostly a
        // no-op verifying we're synced).
        // The account the repo is reached with. Without it this fetch
        // runs as the machine's ambient identity, and a private repo
        // that identity cannot see fails as "Repository not found" -
        // which reads as a missing repo rather than a wrong
        // credential, and leaves the worktree stuck at the base
        // branch without the commit under review.
        const githubEnv = this.githubEnvForTask?.(taskId) ?? {};
        try {
            await runCommand(
                'git',
                ['fetch', 'origin'],
                rec.path,
                this.logger,
                githubEnv,
            );
            await runCommand(
                'git',
                ['reset', '--hard', `origin/${defaultBranch}`],
                rec.path,
                this.logger,
                githubEnv,
            );
            this.logger.info(
                'task-worktrees: freshenIfClean — worktree reset to origin tip',
                { taskId, path: rec.path, defaultBranch },
            );
        } catch (err) {
            this.logger.warn('task-worktrees: freshenIfClean reset failed', {
                taskId,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    /**
     * Probe whether the directory at `target` is a usable git worktree.
     * Runs `git rev-parse --git-dir` inside `target` — git succeeds
     * iff the `.git` pointer file resolves to an existing metadata
     * directory in the bare clone. Returns `false` for any failure
     * (missing pointer, dangling metadata path, permissions, ENOENT on
     * the dir itself, …) so the adopt path can safely treat a falsey
     * result as "rebuild from scratch".
     */
    private async worktreeMetadataValid(target: string): Promise<boolean> {
        try {
            await runCommand('git', ['rev-parse', '--git-dir'], target);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Create or attach the worktree at `target`. Encapsulates the
     * three-case legacy-state matrix:
     *   A) Branch + worktree registered in `.git/worktrees` but the
     *      directory was removed → `git worktree prune` clears the
     *      stale registration so we can re-add.
     *   B) Branch exists but no worktree references it (re-decompose
     *      case — operator wiped the directory; git remembers the
     *      branch). `git worktree add` without `-b` adopts the
     *      existing branch.
     *   C) No local branch, but the REMOTE has one → create the local
     *      branch at `origin/<branch>` so the pushed work comes back.
     *   D) Neither exists → create both with `-b`, branched off the
     *      repo's default branch.
     *
     * Extracted from `ensureWorktree` so the orphan-recovery path can
     * call it after wiping a broken adoption candidate without
     * duplicating logic.
     */
    private async createOrAttachWorktree(
        taskId: string,
        repoId: string,
        repoPath: string,
        branch: string,
        target: string,
    ): Promise<void> {
        await this.pruneStaleWorktreeRegistrations(repoPath);

        const branchExists = await this.branchExists(repoPath, branch);
        if (branchExists) {
            await runCommand(
                'git',
                ['worktree', 'add', target, branch],
                repoPath,
                this.logger,
            );
            // Adopting the LOCAL branch verbatim. If the remote is ahead
            // the agent silently gets an older tree, which is the same
            // confusion the create path produced - so say it rather than
            // leaving the next report to guess.
            const remoteTip = await this.remoteBranchTip(repoPath, branch, taskId);
            const localTip = await this.revParse(repoPath, branch);
            if (remoteTip !== null && localTip !== null && remoteTip !== localTip) {
                this.logger.warn(
                    'task-worktrees: adopted local branch differs from origin'
                    + ' — the agent may not see the pushed commits',
                    { taskId, repoId, branch, localTip, remoteTip },
                );
            }
            this.logger.info(
                'task-worktrees: re-attached worktree to existing branch',
                { taskId, repoId, branch, path: target },
            );
            return;
        }
        // No LOCAL branch — but the work may already be on the remote.
        //
        // This is the common state after a failed merge, and it used to
        // lose the task's work in silence. `mergeTaskPr` tears the
        // worktree down AND deletes the local `task/<id>` branch BEFORE
        // it runs `gh pr merge`, so when the merge fails (a conflict, a
        // credential error, checks not passed) the clone keeps only
        // `origin/task/<id>` — and the next ensureWorktree, e.g. the
        // merge-conflict resolver's, would re-create the branch at the
        // DEFAULT branch, handing the agent a worktree with none of the
        // commits under review.
        //
        // Field report, from the resolver agent itself: "the local
        // task/D-LRCA-001 branch points at main (c2fb8d1) instead of
        // the task commit 45a78de on origin/task/D-LRCA-001. How should
        // I proceed?" - it could see the right commit and had been put
        // somewhere else.
        const remoteStart = await this.remoteBranchTip(repoPath, branch, taskId);
        if (remoteStart !== null) {
            await runCommand(
                'git',
                ['worktree', 'add', '-b', branch, target, `origin/${branch}`],
                repoPath,
                this.logger,
            );
            this.logger.info(
                'task-worktrees: created worktree from the REMOTE branch'
                + ' (recovered pushed work)',
                { taskId, repoId, branch, path: target, startPoint: remoteStart },
            );
            return;
        }

        let startPoint = 'HEAD';
        try {
            const { stdout } = await runCommand(
                'git',
                ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
                repoPath,
                this.logger,
            );
            const ref = stdout.trim();
            if (ref.length > 0) startPoint = ref;
        } catch {
            // origin/HEAD not set — `HEAD` is the safe fallback.
        }
        await runCommand(
            'git',
            ['worktree', 'add', '-b', branch, target, startPoint],
            repoPath,
            this.logger,
        );
        this.logger.info('task-worktrees: created worktree', {
            taskId, repoId, branch, path: target, startPoint,
        });
    }

    /**
     * `git rev-parse --verify <branch>` returns 0 iff the branch ref
     * resolves. Best-effort — any error (including the legitimate
     * "branch does not exist" rev-parse failure) is treated as
     * "branch absent" so the caller falls through to the create path.
     */
    /**
     * Tip of `origin/<branch>`, or null when the remote has no such
     * branch.
     *
     * Fetches that ONE ref first, with the repo's GitHub account: the
     * clone is not fetched by ensureWorktree, so a branch pushed from a
     * worktree may not be in the clone's remote-tracking refs at all,
     * and a stale ref is as misleading as a missing one.
     *
     * Every failure means "treat the remote branch as absent": a
     * credential problem, an offline run, or a branch that genuinely
     * does not exist all reach here, and none of them should stop a
     * worktree being created.
     */
    private async remoteBranchTip(
        repoPath: string,
        branch: string,
        taskId: string,
    ): Promise<string | null> {
        try {
            await runCommand(
                'git',
                [
                    'fetch', 'origin',
                    `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
                ],
                repoPath,
                this.logger,
                this.githubEnvForTask?.(taskId) ?? {},
            );
        } catch (err) {
            // Logged, not swallowed: on a private repo this is where a
            // missing account shows up, and the symptom downstream is a
            // worktree branched off the wrong commit.
            this.logger.warn(
                'task-worktrees: could not fetch the remote task branch',
                {
                    taskId,
                    branch,
                    error: err instanceof Error ? err.message : String(err),
                },
            );
        }
        return this.revParse(repoPath, `refs/remotes/origin/${branch}`);
    }

    /** Commit a ref resolves to, or null when it does not resolve. */
    private async revParse(repoPath: string, ref: string): Promise<string | null> {
        try {
            const { stdout } = await runCommand(
                'git',
                ['rev-parse', '--verify', '--quiet', ref],
                repoPath,
            );
            const sha = stdout.trim();
            return sha.length > 0 ? sha : null;
        } catch {
            return null;
        }
    }

    private async branchExists(repoPath: string, branch: string): Promise<boolean> {
        try {
            await runCommand(
                'git',
                ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`],
                repoPath,
            );
            return true;
        } catch {
            return false;
        }
    }

    /**
     * `git worktree prune` clears registrations whose on-disk
     * directory has been deleted. Without it, the `add` below errors
     * with `fatal: '<path>' is a missing but locked working tree` even
     * though the path is empty. Swallow failures — prune is a hint,
     * not a hard requirement.
     */
    private async pruneStaleWorktreeRegistrations(repoPath: string): Promise<void> {
        try {
            await runCommand('git', ['worktree', 'prune'], repoPath);
        } catch (err) {
            this.logger.warn('task-worktrees: prune failed (continuing)', {
                repoPath,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    markPushed(taskId: string): void {
        this.markPushedStmt.run(this.clock(), taskId);
    }

    setPr(taskId: string, url: string, number_: number): void {
        this.setPrStmt.run(url, number_, taskId);
    }

    /**
     * Remove the on-disk worktree for `taskId`. Runs
     * `git worktree remove --force <path>` from the workspace clone so
     * git's `.git/worktrees/<name>` registration is cleaned up too —
     * a plain `rm -rf` leaves stale entries that produce noisy
     * warnings on subsequent `git worktree list`. Falls back to a
     * recursive filesystem delete when no `resolveRepoPath` is wired
     * or the repo registry doesn't know about the repoId.
     *
     * Best-effort: every error is logged and swallowed. The caller
     * (post-merge cleanup, Cancel/Dismiss subscribers, re-decompose
     * wipe) keeps progressing — a stale worktree directory is an
     * acceptable degradation; throwing here would poison the bus
     * offset on every replay.
     */
    async removeOnDisk(taskId: string): Promise<void> {
        const rec = this.get(taskId);
        if (!rec) return;
        const repoPath = this.resolveRepoPath?.(rec.repoId);
        const worktreeExists = fs.existsSync(rec.path);
        if (repoPath && fs.existsSync(repoPath) && worktreeExists) {
            try {
                await runCommand(
                    'git',
                    ['worktree', 'remove', '--force', rec.path],
                    repoPath,
                    this.logger,
                );
                this.logger.info('task-worktrees: removed worktree on disk', {
                    taskId, path: rec.path,
                });
                await this.deleteFeatureBranch(repoPath, rec.branch, taskId);
                return;
            } catch (err) {
                this.logger.warn(
                    'task-worktrees: git worktree remove failed; falling back to fs.rm',
                    {
                        taskId,
                        path: rec.path,
                        error: err instanceof Error ? err.message : String(err),
                    },
                );
            }
        } else if (repoPath && fs.existsSync(repoPath) && !worktreeExists) {
            // The worktree directory is already gone (a previous run
            // tore it down, the operator deleted it manually, etc.) but
            // `.git/worktrees/<name>` may still hold a stale
            // registration that would block `gh pr merge
            // --delete-branch`'s local cleanup with "branch in use".
            // `git worktree prune` clears those orphans without the
            // "not a working tree" noise that `remove` produces.
            try {
                await runCommand(
                    'git',
                    ['worktree', 'prune'],
                    repoPath,
                    this.logger,
                );
                this.logger.info(
                    'task-worktrees: worktree dir already gone; pruned registry',
                    { taskId, path: rec.path },
                );
            } catch (err) {
                this.logger.warn(
                    'task-worktrees: git worktree prune failed',
                    {
                        taskId,
                        error: err instanceof Error ? err.message : String(err),
                    },
                );
            }
            await this.deleteFeatureBranch(repoPath, rec.branch, taskId);
            return;
        }
        // Fallback path: no git superproject available (repo
        // deregistered) or git refused — drop the directory directly.
        // Skips silently if the directory is already gone.
        try {
            if (fs.existsSync(rec.path)) {
                fs.rmSync(rec.path, { recursive: true, force: true });
                this.logger.info('task-worktrees: removed worktree via fs.rm', {
                    taskId, path: rec.path,
                });
            }
        } catch (err) {
            this.logger.warn('task-worktrees: fs.rm failed for worktree', {
                taskId,
                path: rec.path,
                error: err instanceof Error ? err.message : String(err),
            });
        }
        if (repoPath && fs.existsSync(repoPath)) {
            await this.deleteFeatureBranch(repoPath, rec.branch, taskId);
        }
    }

    /**
     * Drop the feature branch ref so a re-spawned worktree branches
     * fresh from `origin/<default>` instead of re-attaching to the
     * old (potentially stale) branch tip.
     *
     * Why: `removeOnDisk` was historically only tearing down the
     * worktree directory + `.git/worktrees/<name>` registration. The
     * branch ref under `.git/refs/heads/task/<id>` survived. On the
     * next `ensureWorktree`, the branch-exists check passed and the
     * `git worktree add <target> <branch>` (no `-b`) re-attached the
     * worktree to the OLD branch tip — preserving any local commits
     * the developer made from a stale base (the canonical case: a
     * deps-blocked task that ran before its upstream merged). The
     * operator's Restart click then "succeeded" but the worktree was
     * still 17 commits ahead of the now-current `origin/master`, and
     * `freshenIfClean` correctly refused to clobber those commits.
     *
     * Deleting the branch here means Restart / Skip / post-merge
     * cleanup all converge on the same "the next worktree for this
     * task starts fresh" semantic. `gh pr merge --delete-branch`'s
     * local cleanup pass becomes a no-op (the branch is already gone)
     * — that's expected and gh tolerates it silently.
     *
     * Best-effort: any git failure (branch missing, ref locked, …) is
     * logged and swallowed so the rest of the teardown still proceeds.
     */
    private async deleteFeatureBranch(
        repoPath: string,
        branch: string,
        taskId: string,
    ): Promise<void> {
        try {
            await runCommand(
                'git',
                ['branch', '-D', branch],
                repoPath,
                this.logger,
            );
            this.logger.info('task-worktrees: deleted feature branch', {
                taskId, branch,
            });
        } catch (err) {
            // `git branch -D` exits 1 with "branch not found" when the
            // ref is already gone (e.g. gh --delete-branch ran first).
            // Treat that as success rather than spamming a warning.
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes('not found') || msg.includes('No such ref')) {
                this.logger.info(
                    'task-worktrees: feature branch already absent',
                    { taskId, branch },
                );
                return;
            }
            this.logger.warn('task-worktrees: branch delete failed', {
                taskId, branch, error: msg,
            });
        }
    }

    /**
     * Tear down every worktree belonging to a single plan in one call.
     * Gives the orchestrator's plan-lifecycle cleanup a clean seam:
     * enumerate the plan's tasks and remove each one's worktree.
     *
     * For each task under `planId` this runs the existing
     * {@link removeOnDisk} (which does `git worktree remove --force`,
     * deletes the feature branch, and falls back to `fs.rm`) AND THEN
     * drops the `task_worktrees` row — `removeOnDisk` deliberately does
     * not delete the DB row, so a caller that wants the row gone (plan
     * teardown does: the plan is going away) must do it here.
     *
     * Best-effort, mirroring the never-throw contract documented on
     * `removeOnDisk`: each task's work is wrapped so one task's failure
     * cannot abort the loop, and the method as a whole never throws. A
     * stale directory is acceptable degradation; throwing from a bus
     * subscriber would poison the offset on every replay.
     */
    async removeAllForPlan(planId: string): Promise<void> {
        let taskIds: string[] = [];
        try {
            const rows = this.selectTasksByPlanStmt.all(planId) as Array<{ id: string }>;
            taskIds = rows.map((r) => r.id);
        } catch (err) {
            // Enumeration itself failed (schema drift, DB error). Log and
            // return — there is nothing to iterate and throwing here would
            // poison the bus offset just the same.
            this.logger.warn('task-worktrees: removeAllForPlan enumeration failed', {
                planId,
                error: err instanceof Error ? err.message : String(err),
            });
            return;
        }

        for (const taskId of taskIds) {
            try {
                // removeOnDisk is already best-effort/log-never-throw, but
                // wrap defensively so a surprise (e.g. a synchronous throw
                // before its own try/catch) still can't abort the loop.
                await this.removeOnDisk(taskId);
            } catch (err) {
                this.logger.warn('task-worktrees: removeOnDisk failed during plan cleanup', {
                    planId,
                    taskId,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
            try {
                // removeOnDisk deliberately leaves the DB row; drop it now
                // so the row is gone once this method returns.
                this.deleteRowStmt.run(taskId);
            } catch (err) {
                this.logger.warn('task-worktrees: worktree-row delete failed during plan cleanup', {
                    planId,
                    taskId,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        }

        this.logger.info('task-worktrees: removed all worktrees for plan', {
            planId,
            tasksProcessed: taskIds.length,
        });
    }
}

/**
 * Parse the `gh pr create` stdout into a `{ url, number }` pair. `gh`
 * prints the URL on a single line; the PR number is the trailing path
 * segment. Returns null when the output didn't look like a PR URL —
 * caller logs + skips persistence in that case.
 */
export function parsePrCreateOutput(
    stdout: string,
): { url: string; number: number } | null {
    const lines = stdout.split(/\r?\n/);
    for (const line of lines) {
        const m = line.match(/https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/);
        if (m) {
            return { url: m[0], number: Number(m[1]) };
        }
    }
    return null;
}

/**
 * Minimal publisher contract the post-commit hook uses to surface a
 * `TaskPrOpened` event whenever it successfully opens a PR. The board
 * picks the event up over SSE and updates the in-memory task row's
 * `prUrl` / `prNumber` so the Merge PR button appears without a
 * page reload.
 */
export interface PostCommitEventPublisher {
    publish(event: {
        readonly type: string;
        readonly v: number;
        readonly occurredAt: number;
        readonly idempotencyKey: string;
        readonly payload: Record<string, unknown>;
    }): Promise<unknown>;
}

export interface RunPostCommitHookArgs {
    readonly store: TaskWorktreeStore;
    readonly logger: Logger;
    readonly taskId: string;
    readonly title: string;
    readonly description: string | null;
    readonly base?: string;
    readonly remote?: string;
    /**
     * Optional event bus. When supplied the hook publishes
     * `TaskPrOpened` after a successful `gh pr create` so the board
     * receives the URL live instead of waiting for the next
     * `/api/tasks` hydration. Optional so tests / legacy callers
     * without a bus still drive the hook successfully.
     */
    /** The repo's GitHub account env. See {@link GitEnvOverlay}. */
    readonly githubEnv?: GitEnvOverlay;
    readonly bus?: PostCommitEventPublisher;
    /** Source of "now" for the published TaskPrOpened event. */
    readonly clock?: () => number;
}

/**
 * Push the task's worktree branch + open a PR via `gh`. Used by the
 * post-commit subscriber wired in the orchestrator. No-op when the
 * task has no worktree record (e.g. a flow that doesn't use the
 * worktree path).
 *
 * Errors are caught and logged — the operator board's task card stays
 * at `commit` status if the PR creation fails, and the operator can
 * inspect the worker log to retry manually. We deliberately do NOT
 * throw so a transient `gh` failure doesn't poison the bus offset.
 */
/**
 * Why the hook did not end with an open PR.
 *
 * The hook is invoked from an AgentFinished subscriber where a throw
 * would poison the bus offset, so it catches everything and returns. That
 * left the operator's Create PR button with nothing to report but a
 * guess: it told them to look for a `gh pr create` error that, in the
 * most common case, was never attempted — the branch had no commits, so
 * the hook returned three lines earlier. Field report: four failed
 * clicks, and the named error is absent from the log every time.
 */
export type PostCommitOutcome =
    | { readonly kind: 'pr-opened'; readonly prUrl: string; readonly prNumber: number }
    /** No worktree record — this flow never used one. */
    | { readonly kind: 'no-worktree' }
    /** The branch has nothing the base does not already have. */
    | { readonly kind: 'no-commits'; readonly branch: string; readonly base: string }
    | { readonly kind: 'push-failed'; readonly error: string }
    | { readonly kind: 'pr-failed'; readonly error: string }
    /** `gh` returned success but printed something unparseable. */
    | { readonly kind: 'pr-url-unparseable'; readonly stdout: string };

/** One-line operator-facing explanation of a non-success outcome. */
export function describePostCommitOutcome(outcome: PostCommitOutcome): string {
    switch (outcome.kind) {
        case 'pr-opened':
            return `PR #${outcome.prNumber} is open.`;
        case 'no-worktree':
            return 'This task has no git worktree, so there is no branch to open a PR from.';
        case 'no-commits':
            // The actionable one. The agent may have left uncommitted work
            // in the worktree — a PR cannot be opened from that, and
            // pointing at gh would send the operator to the wrong place.
            return `Nothing to open a PR for: branch ${outcome.branch} has no commits `
                + `that ${outcome.base} does not already have. If the agent left `
                + 'uncommitted changes, re-run the commit step first.';
        case 'push-failed':
            return `Pushing ${'the branch'} failed: ${outcome.error}`;
        case 'pr-failed':
            return `gh pr create failed: ${outcome.error}`;
        case 'pr-url-unparseable':
            return 'gh reported success but printed no PR URL: '
                + outcome.stdout.slice(0, 200);
    }
}

export async function runPostCommitHook(
    args: RunPostCommitHookArgs,
): Promise<PostCommitOutcome> {
    const rec = args.store.get(args.taskId);
    if (!rec) {
        args.logger.info('task-worktrees: no worktree for task, skipping push/pr', {
            taskId: args.taskId,
        });
        return { kind: 'no-worktree' };
    }

    const remote = args.remote ?? 'origin';
    // Detect the default branch from the worktree's `origin/HEAD`
    // symbolic ref rather than hardcoding `main`. GitHub repos
    // commonly use `master`, `main`, or anything else; `gh pr create`
    // expects a real branch name in `--base`, and passing `main`
    // against a `master`-default repo fails with the misleading
    // "Head sha can't be blank, Base sha can't be blank, No commits
    // between main and <branch>, Base ref must be a branch" error.
    const base = args.base ?? await detectDefaultBranch(rec.path, args.logger);

    // Nothing-to-commit short-circuit. A dependent task whose work was
    // already landed by the task it depended on produces a worktree
    // with no commits ahead of `origin/<base>` — the committer reported
    // "NO CHANGES TO COMMIT". Pushing then `gh pr create` would fail
    // with "No commits between <base> and <branch>", and the flow would
    // be stuck at wait-merged with no PR. Skip push + PR entirely; the
    // AgentFinished bridge completes the task in this case.
    try {
        const { stdout } = await runCommand(
            'git',
            ['rev-list', '--count', `origin/${base}..HEAD`],
            rec.path,
            args.logger,
        );
        if (Number.parseInt(stdout.trim(), 10) === 0) {
            args.logger.info(
                'task-worktrees: no commits ahead of base — skipping push/PR',
                { taskId: args.taskId, branch: rec.branch, base },
            );
            return { kind: 'no-commits', branch: rec.branch, base };
        }
    } catch (err) {
        // If the count check itself fails (detached HEAD, missing base
        // ref, …) fall through to the normal push/PR path rather than
        // silently dropping a real commit.
        args.logger.warn(
            'task-worktrees: ahead-count check failed; proceeding with push/PR',
            {
                taskId: args.taskId,
                error: err instanceof Error ? err.message : String(err),
            },
        );
    }

    // Push the branch. Use `-u` so subsequent pushes track origin.
    try {
        await runCommand(
            'git',
            ['push', '-u', remote, rec.branch],
            rec.path,
            args.logger,
            args.githubEnv,
        );
        args.store.markPushed(args.taskId);
        args.logger.info('task-worktrees: pushed branch', {
            taskId: args.taskId, branch: rec.branch, remote,
        });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        args.logger.error('task-worktrees: push failed', {
            taskId: args.taskId,
            branch: rec.branch,
            error: message,
        });
        // Surface the failure so the board doesn't render the task as a
        // clean "Awaiting merge" (green + Create PR) when nothing actually
        // reached GitHub. Best-effort publish; the board flips the card to
        // a "push failed - retry" state. Operator recovers with the
        // CreateTaskPr command (push is idempotent).
        await publishCommitFailed(args, 'push', message);
        return { kind: 'push-failed', error: message };
    }

    // Open the PR. Title comes from task.title (operator's intent),
    // body from task.description (the agent's instructions). `gh` is
    // expected to be on PATH and authenticated (the workspace repo
    // sync already relies on it).
    //
    // The body is written to a temp file and passed via `--body-file`
    // instead of `--body <text>`. Task descriptions are multi-line
    // markdown with quotes, backticks, parentheses, and newlines — any
    // of those can interact badly with the shell wrapper that spawns
    // gh on Windows (`shell: true` in runCommand, needed because gh
    // can ship as a `.cmd` shim). `--body-file` sidesteps the escaping
    // entirely: the file path is a single short alphanumeric token,
    // and gh reads the body verbatim from disk.
    const ghBin = process.env.GH_PATH || 'gh';
    const body = args.description && args.description.length > 0
        ? args.description
        : `Automated PR for task ${args.taskId}`;
    const bodyPath = path.join(
        os.tmpdir(),
        `pipeline-v2-pr-body-${args.taskId}-${Date.now()}.md`,
    );
    try {
        fs.writeFileSync(bodyPath, body, 'utf8');
    } catch (err) {
        args.logger.error('task-worktrees: failed to write PR body temp file', {
            taskId: args.taskId,
            bodyPath,
            error: err instanceof Error ? err.message : String(err),
        });
        return {
            kind: 'pr-failed',
            error: `could not write the PR body file: ${
                err instanceof Error ? err.message : String(err)}`,
        };
    }
    try {
        const { stdout } = await runCommand(
            ghBin,
            [
                'pr', 'create',
                '--head', rec.branch,
                '--base', base,
                '--title', sanitizeCliText(args.title) || `task ${args.taskId}`,
                '--body-file', bodyPath,
            ],
            rec.path,
            args.logger,
            args.githubEnv,
        );
        const parsed = parsePrCreateOutput(stdout);
        if (parsed) {
            args.store.setPr(args.taskId, parsed.url, parsed.number);
            args.logger.info('task-worktrees: opened PR', {
                taskId: args.taskId,
                branch: rec.branch,
                url: parsed.url,
                number: parsed.number,
            });
            // Publish TaskPrOpened so the board's in-memory task row
            // gets prUrl / prNumber stamped over SSE — without this the
            // Merge PR button only appears after a hard reload. Best-
            // effort: a bus publish failure is logged but does not
            // throw (we already updated the DB; reload picks it up).
            if (args.bus) {
                const at = (args.clock ?? Date.now)();
                try {
                    await args.bus.publish({
                        type: 'TaskPrOpened',
                        v: 1,
                        occurredAt: at,
                        idempotencyKey: `TaskPrOpened:${args.taskId}:${parsed.number}`,
                        payload: {
                            taskId: args.taskId,
                            prUrl: parsed.url,
                            prNumber: parsed.number,
                        },
                    });
                } catch (err) {
                    args.logger.warn('task-worktrees: TaskPrOpened publish failed', {
                        taskId: args.taskId,
                        error: err instanceof Error ? err.message : String(err),
                    });
                }
            }
            return { kind: 'pr-opened', prUrl: parsed.url, prNumber: parsed.number };
        }
        args.logger.warn('task-worktrees: pr create succeeded but URL unparseable', {
            taskId: args.taskId, stdout: stdout.slice(0, 400),
        });
        return { kind: 'pr-url-unparseable', stdout };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        args.logger.error('task-worktrees: gh pr create failed', {
            taskId: args.taskId,
            branch: rec.branch,
            error: message,
        });
        // The push landed but the PR didn't — surface it so the operator
        // sees a "PR failed - retry" state rather than a green Create PR.
        await publishCommitFailed(args, 'pr', message);
        return { kind: 'pr-failed', error: message };
    } finally {
        try { fs.unlinkSync(bodyPath); } catch { /* best-effort */ }
    }
}

/**
 * Publish a `TaskCommitFailed` event so the board flips a task whose
 * commit step technically failed (push rejected, `gh pr create` errored)
 * out of the misleading "Awaiting merge" look into a "push/PR failed -
 * retry" state. Best-effort: a bus publish failure is swallowed (the
 * failure is already in the worker log, and the board's no-PR reframe
 * still flags the state on the next hydration). The key is stable per
 * (taskId, stage) so a replay re-uses it rather than duplicating.
 */
async function publishCommitFailed(
    args: RunPostCommitHookArgs,
    stage: 'push' | 'pr',
    error: string,
): Promise<void> {
    if (!args.bus) return;
    const at = (args.clock ?? Date.now)();
    try {
        await args.bus.publish({
            type: 'TaskCommitFailed',
            v: 1,
            occurredAt: at,
            idempotencyKey: `TaskCommitFailed:${args.taskId}:${stage}`,
            payload: { taskId: args.taskId, stage, error: error.slice(0, 500) },
        });
    } catch (err) {
        args.logger.warn('task-worktrees: TaskCommitFailed publish failed', {
            taskId: args.taskId,
            error: err instanceof Error ? err.message : String(err),
        });
    }
}

/**
 * The slice of {@link TaskWorktreeStore} the merge path uses.
 *
 * Structural so a test can drive the real control flow with a
 * three-method fake instead of a temp-directory store - the same
 * reason `MergeConflictWorktrees` exists.
 */
export interface MergePrWorktrees {
    get(taskId: string): { readonly path: string; readonly prNumber: number | null }
        | null | undefined;
    repoPathForTask(taskId: string): string | null | undefined;
    removeOnDisk(taskId: string): Promise<void>;
}

export interface MergePrArgs {
    readonly store: MergePrWorktrees;
    readonly logger: Logger;
    readonly taskId: string;
    /** The repo's GitHub account env. See {@link GitEnvOverlay}. */
    readonly githubEnv?: GitEnvOverlay;
    /** `squash` | `merge` | `rebase`. Defaults to `squash`. */
    readonly method?: 'squash' | 'merge' | 'rebase';
    /** Pass `--delete-branch`. Defaults to `true`. */
    readonly deleteBranch?: boolean;
    /**
     * Fall back to `gh pr merge --auto` when the PR cannot merge yet
     * because the repo's requirements are unmet (checks pending, a
     * required review missing). Defaults to `true`.
     *
     * Without it the pipeline DEMANDS the merge now and fails on any
     * repo whose checks run on the PR - which is most of them. With
     * it, GitHub holds the merge and runs it when the checks pass.
     */
    readonly auto?: boolean;
    /**
     * Spawn seam for `gh` / `git`. Defaults to {@link runCommand}.
     * Lets the two-phase merge be driven without a network.
     */
    readonly run?: (
        cmd: string,
        argv: readonly string[],
        cwd: string,
        logger?: Logger,
        env?: GitEnvOverlay,
    ) => Promise<{ stdout: string; stderr: string }>;
}

export interface MergePrResult {
    readonly ok: boolean;
    readonly reason?: string;
    /**
     * The merge was QUEUED with GitHub, not performed. `ok` is true -
     * nothing failed - but the PR is NOT merged yet, so the caller must
     * not finish the task. Something has to watch for the merge
     * landing (see `watchEnqueuedMerge` in the orchestrator).
     */
    readonly enqueued?: boolean;
}

/**
 * Run `gh pr merge` for a task's PR. Returns `{ ok: true }` on a clean
 * merge, otherwise `{ ok: false, reason }` so the caller can surface
 * the gh error back to the operator. Never throws — a transient `gh`
 * failure should be retryable from the board without crashing the
 * orchestrator's bus dispatch.
 */
export async function mergeTaskPr(args: MergePrArgs): Promise<MergePrResult> {
    const rec = args.store.get(args.taskId);
    if (!rec) {
        return { ok: false, reason: 'no worktree for task' };
    }
    if (rec.prNumber === null) {
        return { ok: false, reason: 'no PR open for this task — commit must complete first' };
    }
    const run = args.run ?? runCommand;
    const method = args.method ?? 'squash';
    const flag = method === 'merge'
        ? '--merge'
        : method === 'rebase' ? '--rebase' : '--squash';
    const ghBin = process.env.GH_PATH || 'gh';
    const ghArgs = ['pr', 'merge', String(rec.prNumber), flag];
    // Accepted alongside --auto (verified against gh 2.89): GitHub
    // deletes the head branch when it eventually merges, per the
    // repo's own delete-on-merge setting.
    if (args.deleteBranch !== false) ghArgs.push('--delete-branch');
    // Run `gh pr merge` from the BARE CLONE rather than the task
    // worktree. `--delete-branch` triggers gh's local-cleanup pass
    // (`git fetch`, `git switch <base>`, `git branch -d <feature>`),
    // and the worktree's HEAD is on `task/<taskId>`. Switching to
    // `main` inside the worktree fails because the bare clone is
    // already on main — git rejects with `'main' is already used by
    // worktree at '<bare-clone-path>'`. Running from the bare clone
    // instead: it's already on main (no switch needed), the feature
    // branch may or may not exist there (gh deletes it if present,
    // skips if not).
    const cwd = args.store.repoPathForTask(args.taskId) ?? rec.path;
    // Tear down the worktree BEFORE gh pr merge so gh's
    // `--delete-branch` local cleanup can run. Without this, gh
    // detects the PR is merged (or freshly merges it) and then fails
    // with `cannot delete branch 'task/<taskId>' used by worktree at
    // '<path>'`. `removeOnDisk` calls `git worktree remove --force`
    // which unmounts the worktree dir AND clears the
    // `.git/worktrees/<name>` registration; after that the branch is
    // no longer in-use and gh can delete it cleanly. Best-effort —
    // a stale worktree directory is degradation, not a blocker, so
    // `removeOnDisk` already swallows errors. The merge itself
    // proceeds regardless.
    await args.store.removeOnDisk(args.taskId);
    try {
        await run(ghBin, ghArgs, cwd, args.logger, args.githubEnv);
        args.logger.info('task-worktrees: merged PR', {
            taskId: args.taskId,
            prNumber: rec.prNumber,
            method,
            cwd,
        });
        // Pull the merge commit into the bare clone's remote-tracking
        // refs IMMEDIATELY. `gh pr merge` lands the squash/merge commit
        // on the remote's default branch, but the local bare clone's
        // `origin/<default>` ref does NOT advance until something
        // fetches. Without this, a dependent task that unblocks the
        // instant this PR merges (TaskFinished → unblock pass) can
        // create its worktree off a still-stale `origin/<default>` if
        // its own pre-spawn refresh races or fails — the developer then
        // reads pre-merge code and reports "the upstream task didn't
        // merge" (the T-APSF-002 symptom). Fetching here makes the
        // merge visible in the clone deterministically, before any
        // downstream worktree is branched. Best-effort: a fetch failure
        // is logged but doesn't fail the merge (which already
        // succeeded) — the next task's pre-spawn refresh remains the
        // backstop.
        try {
            await run('git', ['fetch', 'origin'], cwd, args.logger, args.githubEnv);
            args.logger.info('task-worktrees: fetched origin after merge', {
                taskId: args.taskId,
                cwd,
            });
        } catch (fetchErr) {
            args.logger.warn(
                'task-worktrees: post-merge fetch failed (next pre-spawn refresh will catch up)',
                {
                    taskId: args.taskId,
                    error: fetchErr instanceof Error ? fetchErr.message : String(fetchErr),
                },
            );
        }
        return { ok: true };
    } catch (err) {
        const rawReason = err instanceof Error ? err.message : String(err);
        // The PR is fine, the REPO is not ready: checks still running,
        // a required review outstanding, a merge queue ahead of it.
        // Retrying now fails identically, so ask GitHub to hold the
        // merge and run it when the requirements are met - which is
        // exactly what gh itself suggests in this message.
        if (args.auto !== false && isMergeBlockedByRequirements(rawReason)) {
            try {
                await run(
                    ghBin,
                    [...ghArgs, '--auto'],
                    cwd,
                    args.logger,
                    args.githubEnv,
                );
                args.logger.info('task-worktrees: queued PR for auto-merge', {
                    taskId: args.taskId,
                    prNumber: rec.prNumber,
                    method,
                    blockedBy: rawReason.slice(0, 200),
                });
                // Deliberately NO post-merge fetch here: nothing has
                // merged yet, so there is no merge commit to pull into
                // the clone. The watcher fetches when it lands.
                return {
                    ok: true,
                    enqueued: true,
                    reason: describeMergeEnqueued(rec.prNumber, rawReason),
                };
            } catch (autoErr) {
                const autoRaw = autoErr instanceof Error
                    ? autoErr.message
                    : String(autoErr);
                // "Allow auto-merge" is a repo setting and OFF by
                // default, so this is the likely outcome on a repo
                // nobody has configured. Name the setting - the raw
                // message is a GraphQL mutation name.
                const reason = isAutoMergeUnavailable(autoRaw)
                    ? describeAutoMergeUnavailable(rec.prNumber, autoRaw)
                    : mapMergeFailureReason(autoRaw, rec.prNumber);
                args.logger.error('task-worktrees: gh pr merge --auto failed', {
                    taskId: args.taskId,
                    prNumber: rec.prNumber,
                    reason,
                });
                return { ok: false, reason };
            }
        }
        const reason = mapMergeFailureReason(rawReason, rec.prNumber);
        args.logger.error('task-worktrees: gh pr merge failed', {
            taskId: args.taskId,
            prNumber: rec.prNumber,
            reason,
        });
        return { ok: false, reason };
    }
}

/**
 * Map `gh pr merge` stderr to an operator-facing reason. The default is
 * to pass the raw message through; we only translate the well-known
 * mergeable=false failure into a clearer "PR has conflicts" sentence
 * since that's the one operators see most often and the gh suggestion
 * (`gh pr checkout && git fetch origin main && git merge origin/main`)
 * is misleading on repos whose default branch isn't `main`.
 */
function mapMergeFailureReason(raw: string, prNumber: number | null): string {
    // A requirements block ("the base branch policy prohibits the
    // merge") ALSO contains "is not mergeable", and rewriting it as a
    // conflict is how a PR whose checks had not finished came to be
    // reported as conflicted - and handed to a merge-resolver agent
    // with nothing to resolve. Pass those through untouched.
    if (isMergeBlockedByRequirements(raw)) return raw;
    if (
        raw.includes('is not mergeable')
        || raw.includes('merge commit cannot be cleanly created')
    ) {
        const prPart = prNumber !== null ? `PR #${prNumber}` : 'this PR';
        return `${prPart} has merge conflicts with the base branch. Resolve them on GitHub (or via \`gh pr checkout ${prNumber ?? ''}\` and a local merge against the default branch), then click Merge PR again.`;
    }
    return raw;
}

/*
 * `defaultWorktreeRoot(repoRoot)` used to live here and returned
 * `<repo>/.pipeline-workspace/worktrees`. It is deliberately gone.
 *
 * Worktrees moved under the pipeline WORKSPACE root (typically
 * `C:\Drop-AI\Source\worktrees`) when clones did. While this helper was
 * still in use the two were disjoint: the agent saw a worktree path in
 * its workspace block, found it empty, and worked on the bare clone
 * instead — landing edits on the clone's branch rather than the task
 * feature branch, so the push and PR either failed or produced an empty
 * PR. See the comment at the TaskWorktreeStore construction in
 * `hosts/orchestrator/main.ts`.
 *
 * Anything that needs the root should read it from the workspace root
 * (`config/env`'s getWorkspaceRoot), never rebuild the old path.
 */

void os; // touch import so node treats this as a module
