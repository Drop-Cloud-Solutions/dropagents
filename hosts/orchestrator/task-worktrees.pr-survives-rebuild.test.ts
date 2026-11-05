/**
 * A worktree rebuild must not lose the task's PR.
 *
 * Field case (L-FADC-005 / L-FADC-007). The sequence that broke every
 * conflicted merge:
 *
 *   1. `mergeTaskPr` tears the worktree down BEFORE `gh pr merge`, on
 *      purpose — otherwise `--delete-branch` fails with "cannot delete
 *      branch used by worktree at …". The DB row survives, PR included.
 *   2. `gh pr merge` reports a conflict.
 *   3. The merge-resolver calls `ensureWorktree` to get the checkout back
 *      so its agent can resolve in it.
 *   4. `ensureWorktree` found the directory gone, declared the row broken,
 *      DELETED it, and inserted a fresh one — with `pr_number` NULL.
 *   5. The agent resolved the conflict and pushed correctly. The
 *      re-dispatched `MergeTaskPr` then failed with "no PR open for this
 *      task — commit must complete first", and the task parked asking the
 *      operator to sort it out.
 *
 * So the resolver did the hard part and fell at the last step, every
 * time, and it read from outside as though it had never run.
 *
 * The row is keyed on the TASK. `pr_url` / `pr_number` describe its branch
 * on GitHub; a missing local checkout says nothing about whether the PR
 * still exists.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { execFileSync } from 'node:child_process';

import { applyMigrations, openDatabase, type Db } from '../../core/state/migrations';
import type { Logger } from '../../core/ports/Logger';
import { TaskWorktreeStore } from './task-worktrees';

/** A real repo, because ensureWorktree's create path shells out to git. */
function makeRepo(root: string): string {
    const repo = path.join(root, 'repo');
    fs.mkdirSync(repo, { recursive: true });
    const git = (...args: string[]): void => {
        execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
    };
    git('init', '--initial-branch=main');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 'Test');
    fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n');
    git('add', '.');
    git('commit', '-m', 'init');
    // `git worktree add` resolves the base through origin/<default>, so
    // give the repo an origin pointing at itself and a HEAD symref.
    git('remote', 'add', 'origin', repo);
    git('fetch', 'origin');
    git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
    return repo;
}

const silentLogger: Logger = {
    info: (): void => {}, warn: (): void => {}, error: (): void => {}, debug: (): void => {},
};

interface Harness {
    readonly store: TaskWorktreeStore;
    readonly db: Db;
    readonly root: string;
    cleanup(): void;
}

interface Harness2 extends Harness { readonly repo: string }

function makeHarness(): Harness2 {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-pr-rebuild-'));
    const repo = makeRepo(root);
    const db = openDatabase(':memory:');
    applyMigrations(db);
    const store = new TaskWorktreeStore({
        db,
        worktreeRoot: path.join(root, 'worktrees'),
        logger: silentLogger,
        clock: () => 1_700_000_000_000,
        resolveRepoPath: () => repo,
    });
    return {
        store, db, root, repo,
        cleanup(): void {
            db.close();
            try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
        },
    };
}

/** Seed the row the way the pipeline does: create, push, open a PR. */
function seedWithPr(db: Db, taskId: string): void {
    db.prepare(
        `INSERT INTO task_worktrees(task_id, repo_id, branch, path, created_at,
                                    pushed_at, pr_url, pr_number)
         VALUES (?, 'catalog', ?, ?, 1, 2, ?, ?)`,
    ).run(
        taskId,
        `task/${taskId}`,
        path.join(os.tmpdir(), 'definitely-not-here', taskId),
        `https://github.com/org/repo/pull/18`,
        18,
    );
}

test('rebuilding a worktree whose directory is gone keeps the PR', async () => {
    const h = makeHarness();
    try {
        seedWithPr(h.db, 'L-FADC-005');
        assert.equal(h.store.get('L-FADC-005')?.prNumber, 18, 'precondition');

        // The directory does not exist — exactly the state `mergeTaskPr`
        // leaves behind before `gh pr merge`. ensureWorktree rebuilds.
        await h.store.ensureWorktree('L-FADC-005', 'catalog', h.repo);

        const after = h.store.get('L-FADC-005');
        assert.ok(after, 'the row must still exist after a rebuild');
        assert.equal(
            after!.prNumber, 18,
            'pr_number must survive — losing it is what broke the resolver',
        );
        assert.equal(after!.prUrl, 'https://github.com/org/repo/pull/18');
        assert.equal(after!.pushedAt, 2, 'pushed_at rides along for the same reason');
    } finally {
        h.cleanup();
    }
});

test('a rebuilt row with no PR yet stays PR-less', async () => {
    // The common case: a task whose worktree broke before the committer
    // ever pushed. Nothing to carry, and nothing invented.
    const h = makeHarness();
    try {
        h.db.prepare(
            `INSERT INTO task_worktrees(task_id, repo_id, branch, path, created_at)
             VALUES ('T-1', 'catalog', 'task/T-1', ?, 1)`,
        ).run(path.join(os.tmpdir(), 'gone', 'T-1'));

        await h.store.ensureWorktree('T-1', 'catalog', h.repo);

        const after = h.store.get('T-1');
        assert.ok(after);
        assert.equal(after!.prNumber, null);
        assert.equal(after!.prUrl, null);
        assert.equal(after!.pushedAt, null);
    } finally {
        h.cleanup();
    }
});

test('a task with no row at all is unaffected', async () => {
    const h = makeHarness();
    try {
        await h.store.ensureWorktree('T-NEW', 'catalog', h.repo);
        const after = h.store.get('T-NEW');
        assert.ok(after, 'a first ensureWorktree creates the row');
        assert.equal(after!.prNumber, null, 'nothing to carry, nothing invented');
        assert.equal(after!.prUrl, null);
    } finally {
        h.cleanup();
    }
});
