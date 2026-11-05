/**
 * A re-created worktree must come back on the PUSHED commit, not on the
 * default branch.
 *
 * Field report, from the merge-resolver agent itself: "The worktree
 * can't reach GitHub (git fetch: 'Repository not found', likely a
 * credential/access problem), and the local task/D-LRCA-001 branch
 * points at main (c2fb8d1) instead of the task commit 45a78de on
 * origin/task/D-LRCA-001. How should I proceed?"
 *
 * It could see the right commit and had been put somewhere else. Why:
 *
 *   1. `mergeTaskPr` tears the worktree down AND deletes the local
 *      `task/<id>` branch BEFORE running `gh pr merge`, so gh's
 *      --delete-branch cleanup can work.
 *   2. The merge then fails — a conflict, a credential error, checks
 *      not passed — and the clone keeps only `origin/task/<id>`.
 *   3. The merge-conflict resolver calls ensureWorktree, whose create
 *      path only ever asked `git rev-parse refs/heads/<branch>`. No
 *      local branch, so it created one off the DEFAULT branch and
 *      handed the agent a tree with none of the commits under review.
 *
 * Step 3 is fixed here: the remote branch is consulted (and fetched,
 * with the repo's account) before falling back to the default branch.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

import { TaskWorktreeStore } from './task-worktrees';
import { openDatabase, applyMigrations, type Db } from '../../core/state/migrations';
import type { Logger } from '../../core/ports/Logger';

interface LogLine {
    readonly level: string;
    readonly msg: string;
    readonly data?: unknown;
}

function makeLogger(lines: LogLine[]): Logger {
    const push = (level: string) => (msg: string, data?: unknown): void => {
        lines.push({ level, msg, data });
    };
    return {
        info: push('info'),
        warn: push('warn'),
        error: push('error'),
        debug: push('debug'),
    } as unknown as Logger;
}

/**
 * A REAL git repository pair: an origin and a clone. The defect is in
 * which ref a `git worktree add` starts from, so faking git would be
 * faking the thing under test.
 */
interface Repos {
    readonly root: string;
    readonly origin: string;
    readonly clone: string;
    readonly taskCommit: string;
    readonly mainCommit: string;
    cleanup(): void;
}

function git(args: readonly string[], cwd: string): string {
    return execFileSync('git', args.slice(), {
        cwd,
        encoding: 'utf8',
        env: {
            ...process.env,
            GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@x.io',
            GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@x.io',
            GIT_CONFIG_GLOBAL: path.join(os.tmpdir(), 'no-such-gitconfig'),
            GIT_CONFIG_SYSTEM: path.join(os.tmpdir(), 'no-such-gitconfig'),
        },
    }).toString();
}

/**
 * origin has `main` plus a pushed `task/T-1` one commit ahead; the
 * clone has fetched main but NOT the task branch, and has no local
 * `task/T-1` — exactly the post-failed-merge state.
 */
function makeRepos(branch: string): Repos {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-remote-'));
    const origin = path.join(root, 'origin');
    const work = path.join(root, 'seed');
    const clone = path.join(root, 'clone');

    fs.mkdirSync(work, { recursive: true });
    git(['init', '--initial-branch=main'], work);
    fs.writeFileSync(path.join(work, 'a.txt'), 'base\n');
    git(['add', '-A'], work);
    git(['commit', '-m', 'base'], work);
    const mainCommit = git(['rev-parse', 'HEAD'], work).trim();

    git(['checkout', '-b', branch], work);
    fs.writeFileSync(path.join(work, 'a.txt'), 'the work under review\n');
    git(['add', '-A'], work);
    git(['commit', '-m', 'task work'], work);
    const taskCommit = git(['rev-parse', 'HEAD'], work).trim();
    git(['checkout', 'main'], work);

    git(['clone', '--bare', work, origin], root);
    git(['clone', origin, clone], root);
    // The clone knows main. Drop its knowledge of the task branch, as a
    // clone that never fetched since the push would have.
    git(['update-ref', '-d', `refs/remotes/origin/${branch}`], clone);
    git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'], clone);

    return {
        root, origin, clone, taskCommit, mainCommit,
        cleanup: (): void => { fs.rmSync(root, { recursive: true, force: true }); },
    };
}

function makeStore(repos: Repos, worktreeRoot: string, lines: LogLine[]): {
    store: TaskWorktreeStore;
    db: Db;
} {
    const db = openDatabase(':memory:');
    applyMigrations(db);
    const store = new TaskWorktreeStore({
        db,
        worktreeRoot,
        logger: makeLogger(lines),
        resolveRepoPath: () => repos.clone,
    });
    return { store, db };
}

const BRANCH = 'task/T-1';

// --- the field bug ----------------------------------------------------

test('a worktree for an already-pushed branch starts at the REMOTE commit', async () => {
    const repos = makeRepos(BRANCH);
    const wtRoot = path.join(repos.root, 'worktrees');
    const { store, db } = makeStore(repos, wtRoot, []);
    try {
        const rec = await store.ensureWorktree('T-1', 'shop', repos.clone);

        const head = git(['rev-parse', 'HEAD'], rec.path).trim();
        assert.equal(
            head,
            repos.taskCommit,
            'the worktree must hold the commit under review, not the base branch',
        );
        assert.notEqual(head, repos.mainCommit);
        // Trimmed: git's autocrlf rewrites the line ending on checkout
        // here, and the content is the point, not the ending.
        assert.equal(
            fs.readFileSync(path.join(rec.path, 'a.txt'), 'utf8').trim(),
            'the work under review',
            'the agent must actually see the work',
        );
    } finally {
        db.close();
        repos.cleanup();
    }
});

test('the recovery is logged, so it is visible in the worker log', async () => {
    // Silent recovery is nearly as bad as silent loss: the next report
    // of "the branch is at main" needs something to search for.
    const repos = makeRepos(BRANCH);
    const lines: LogLine[] = [];
    const { store, db } = makeStore(repos, path.join(repos.root, 'worktrees'), lines);
    try {
        await store.ensureWorktree('T-1', 'shop', repos.clone);
        assert.ok(
            lines.some((l) => l.msg.includes('created worktree from the REMOTE branch')),
            `expected a recovery log line; got: ${lines.map((l) => l.msg).join(' | ')}`,
        );
    } finally {
        db.close();
        repos.cleanup();
    }
});

// --- the old behaviour, where it is still right -----------------------

test('a branch that exists NOWHERE still starts at the default branch', async () => {
    // A brand-new task. Nothing is pushed, so the default branch is the
    // only sensible start point — the fix must not change this.
    const repos = makeRepos(BRANCH);
    const { store, db } = makeStore(repos, path.join(repos.root, 'worktrees'), []);
    try {
        const rec = await store.ensureWorktree('T-FRESH', 'shop', repos.clone);
        assert.equal(
            git(['rev-parse', 'HEAD'], rec.path).trim(),
            repos.mainCommit,
            'a task with no pushed work starts from the default branch',
        );
    } finally {
        db.close();
        repos.cleanup();
    }
});

test('an existing LOCAL branch is still adopted as-is', async () => {
    // The re-decompose case: git remembers the branch, the directory was
    // wiped. Adoption must keep working.
    const repos = makeRepos(BRANCH);
    const { store, db } = makeStore(repos, path.join(repos.root, 'worktrees'), []);
    try {
        git(['branch', BRANCH, repos.mainCommit], repos.clone);
        const rec = await store.ensureWorktree('T-1', 'shop', repos.clone);
        assert.equal(
            git(['rev-parse', '--abbrev-ref', 'HEAD'], rec.path).trim(),
            BRANCH,
        );
    } finally {
        db.close();
        repos.cleanup();
    }
});

test('a local branch BEHIND the remote is called out, not left to be guessed', async () => {
    // Same visible symptom as the field report (an agent on an older
    // commit), reached by the adoption path instead of the create path.
    // Adopting is the conservative choice, so the warning is what makes
    // it diagnosable.
    const repos = makeRepos(BRANCH);
    const lines: LogLine[] = [];
    const { store, db } = makeStore(repos, path.join(repos.root, 'worktrees'), lines);
    try {
        git(['branch', BRANCH, repos.mainCommit], repos.clone);
        await store.ensureWorktree('T-1', 'shop', repos.clone);

        const warn = lines.find((l) => l.msg.includes('differs from origin'));
        assert.ok(warn, `expected a divergence warning; got: ${lines.map((l) => l.msg).join(' | ')}`);
        const data = warn.data as { localTip?: string; remoteTip?: string };
        assert.equal(data.localTip, repos.mainCommit);
        assert.equal(data.remoteTip, repos.taskCommit);
    } finally {
        db.close();
        repos.cleanup();
    }
});

// --- degrading --------------------------------------------------------

test('an unreachable remote still produces a usable worktree, and says why', async () => {
    // What the operator actually hit: the account was missing, so the
    // fetch failed. The worktree must still be created (off the default
    // branch — there is nothing better to use) and the fetch failure has
    // to be in the log, because it is the real cause.
    const repos = makeRepos(BRANCH);
    const lines: LogLine[] = [];
    const { store, db } = makeStore(repos, path.join(repos.root, 'worktrees'), lines);
    try {
        git(['remote', 'set-url', 'origin', path.join(repos.root, 'gone')], repos.clone);
        git(['update-ref', '-d', `refs/remotes/origin/${BRANCH}`], repos.clone);

        const rec = await store.ensureWorktree('T-1', 'shop', repos.clone);
        assert.ok(fs.existsSync(rec.path), 'a worktree is still created');
        assert.ok(
            lines.some((l) => l.msg.includes('could not fetch the remote task branch')),
            'the fetch failure must be logged — it is the actual cause',
        );
    } finally {
        db.close();
        repos.cleanup();
    }
});

test('the remote lookup carries the repo\'s GitHub account', async () => {
    // Same reason every other remote call does: on a private repo an
    // ambient identity gets "Repository not found", and the symptom is a
    // worktree branched off the wrong commit.
    const repos = makeRepos(BRANCH);
    const db = openDatabase(':memory:');
    applyMigrations(db);
    const asked: string[] = [];
    try {
        const store = new TaskWorktreeStore({
            db,
            worktreeRoot: path.join(repos.root, 'worktrees'),
            logger: makeLogger([]),
            resolveRepoPath: () => repos.clone,
            githubEnvForTask: (taskId) => {
                asked.push(taskId);
                return {};
            },
        });
        await store.ensureWorktree('T-1', 'shop', repos.clone);
        assert.ok(asked.includes('T-1'), 'the account must be resolved for the fetch');
    } finally {
        db.close();
        repos.cleanup();
    }
});
