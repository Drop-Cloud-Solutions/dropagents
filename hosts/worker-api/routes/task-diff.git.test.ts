/**
 * Integration test for createGitDiffInvoker against a REAL git repo —
 * the one seam the fixture-driven task-diff.spec.ts deliberately skips.
 *
 * Regression under test: with two tasks in flight, task 1 merges to the
 * base branch while task 2 is still parked at human-review. The old
 * `git diff origin/main` (two-dot, tip-relative) then showed task 1's
 * landed changes as DELETIONS in task 2's review. The invoker now diffs
 * against the merge-base (fork point), i.e. exactly what task 2 will
 * push.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { createGitDiffInvoker } from './task-diff';

function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function write(dir: string, rel: string, content: string): void {
    fs.writeFileSync(path.join(dir, rel), content, 'utf8');
}

/**
 * Build: an "origin" repo with base branch `main`, a clone acting as the
 * task-2 worktree branched at C1, then advance origin's main to C2
 * (task 1's merge) and fetch in the clone — the exact mid-review state.
 */
function makeFixture(): { worktree: string; cleanup(): void } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-diff-git-'));
    const origin = path.join(root, 'origin');
    const worktree = path.join(root, 'clone');
    fs.mkdirSync(origin);
    git(origin, 'init', '--initial-branch=main');
    git(origin, 'config', 'user.email', 'test@example.com');
    git(origin, 'config', 'user.name', 'Test');
    write(origin, 'shared.txt', 'base\n');
    git(origin, 'add', '-A');
    git(origin, 'commit', '-m', 'C1: base');

    git(root, 'clone', origin, worktree);
    git(worktree, 'config', 'user.email', 'test@example.com');
    git(worktree, 'config', 'user.name', 'Test');
    git(worktree, 'checkout', '-b', 'task/T-2');

    // Task 1 lands on origin/main AFTER task 2 branched.
    write(origin, 'task1.txt', 'task 1 landed this\n');
    git(origin, 'add', '-A');
    git(origin, 'commit', '-m', 'C2: task 1 merged');
    git(worktree, 'fetch', 'origin');

    // Task 2's own (uncommitted) work.
    write(worktree, 'task2.txt', 'task 2 work\n');

    return {
        worktree,
        cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
    };
}

test("[Integration] a sibling task's merged changes do NOT appear as deletions", async () => {
    const fx = makeFixture();
    try {
        const invoke = createGitDiffInvoker();
        const diff = await invoke(fx.worktree);
        // Task 2's own work shows as an addition...
        assert.match(diff, /task2\.txt/);
        assert.match(diff, /\+task 2 work/);
        // ...and task 1's landed file is ABSENT — with the old tip-relative
        // diff it appeared here as a deletion (-task 1 landed this).
        assert.ok(!diff.includes('task1.txt'), 'sibling merge must not appear in the review diff');
        assert.ok(!diff.includes('-task 1 landed this'));
    } finally {
        fx.cleanup();
    }
});

test('[Integration] committed + staged + untracked task work all show against the fork point', async () => {
    const fx = makeFixture();
    try {
        // Committed on the task branch.
        write(fx.worktree, 'committed.txt', 'committed change\n');
        git(fx.worktree, 'add', '-A');
        git(fx.worktree, 'commit', '-m', 'task 2 commit');
        // Staged but uncommitted.
        write(fx.worktree, 'staged.txt', 'staged change\n');
        git(fx.worktree, 'add', 'staged.txt');
        const invoke = createGitDiffInvoker();
        const diff = await invoke(fx.worktree);
        assert.match(diff, /\+committed change/);
        assert.match(diff, /\+staged change/);
        assert.match(diff, /\+task 2 work/, 'untracked file still synthesised');
        assert.ok(!diff.includes('task1.txt'));
    } finally {
        fx.cleanup();
    }
});

test('[Integration] master-named base branches resolve too (no hardcoded main)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-diff-git-'));
    try {
        const origin = path.join(root, 'origin');
        const worktree = path.join(root, 'clone');
        fs.mkdirSync(origin);
        git(origin, 'init', '--initial-branch=master');
        git(origin, 'config', 'user.email', 'test@example.com');
        git(origin, 'config', 'user.name', 'Test');
        write(origin, 'a.txt', 'base\n');
        git(origin, 'add', '-A');
        git(origin, 'commit', '-m', 'C1');
        git(root, 'clone', origin, worktree);
        git(worktree, 'checkout', '-b', 'task/T-9');
        write(origin, 'b.txt', 'landed\n');
        git(origin, 'add', '-A');
        git(origin, 'commit', '-m', 'C2');
        git(worktree, 'fetch', 'origin');
        write(worktree, 'mine.txt', 'my change\n');

        const diff = await createGitDiffInvoker()(worktree);
        assert.match(diff, /\+my change/);
        assert.ok(!diff.includes('b.txt'), 'master-based sibling merge must not appear');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
