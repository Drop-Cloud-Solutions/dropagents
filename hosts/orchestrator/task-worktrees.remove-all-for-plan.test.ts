/**
 * Unit tests for TaskWorktreeStore.removeAllForPlan — the per-plan
 * teardown seam the orchestrator's plan-lifecycle cleanup uses to
 * enumerate and remove every worktree belonging to one plan.
 *
 * The method must (a) enumerate the plan's tasks via `tasks.plan_id`,
 * (b) call removeOnDisk + drop the `task_worktrees` row for each so the
 * row is gone on return, (c) isolate a single task's failure so the
 * loop still processes the rest, and (d) never throw — a stale
 * directory is acceptable degradation but a throw from a bus subscriber
 * would poison the offset on replay.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { applyMigrations, openDatabase, type Db } from '../../core/state/migrations';
import type { Logger } from '../../core/ports/Logger';
import { TaskWorktreeStore } from './task-worktrees';

class FakeLogger implements Logger {
    readonly warnings: Array<{ message: string; meta?: unknown }> = [];
    readonly infos: Array<{ message: string; meta?: unknown }> = [];
    info(message: string, meta?: Readonly<Record<string, unknown>>): void {
        this.infos.push({ message, meta });
    }
    warn(message: string, meta?: Readonly<Record<string, unknown>>): void {
        this.warnings.push({ message, meta });
    }
    debug(): void {}
    error(): void {}
}

function seedTask(db: Db, id: string, planId: string): void {
    db.prepare(
        `INSERT INTO tasks(id, plan_id, type, status) VALUES (?, ?, 'implement', 'todo')`,
    ).run(id, planId);
}

function seedWorktreeRow(db: Db, taskId: string): void {
    // Path deliberately does not exist on disk, so removeOnDisk's fs.rm
    // fallback is a no-op and no real git runs — the test exercises the
    // DB-row lifecycle without touching the filesystem.
    db.prepare(
        `INSERT INTO task_worktrees(task_id, repo_id, branch, path, created_at)
         VALUES (?, 'repo-1', ?, ?, 1)`,
    ).run(taskId, `task/${taskId}`, `C:/nonexistent/worktrees/${taskId}`);
}

function makeStore(db: Db, logger: Logger): TaskWorktreeStore {
    return new TaskWorktreeStore({
        db,
        worktreeRoot: 'C:/nonexistent/worktrees',
        logger,
        clock: () => 1,
        // No resolveRepoPath wired → removeOnDisk takes the fs.rm
        // fallback, which no-ops for the non-existent paths above.
    });
}

function worktreeRowExists(db: Db, taskId: string): boolean {
    const row = db
        .prepare('SELECT task_id FROM task_worktrees WHERE task_id = ?')
        .get(taskId);
    return row !== undefined;
}

test('removes only the target plan\'s worktree rows, leaves other plans untouched', async () => {
    const db = openDatabase(':memory:');
    applyMigrations(db);
    const logger = new FakeLogger();
    const store = makeStore(db, logger);

    // Two tasks under plan-A, one under plan-B.
    seedTask(db, 't1', 'plan-A');
    seedTask(db, 't2', 'plan-A');
    seedTask(db, 't3', 'plan-B');
    seedWorktreeRow(db, 't1');
    seedWorktreeRow(db, 't2');
    seedWorktreeRow(db, 't3');

    await store.removeAllForPlan('plan-A');

    // AC: only plan-A's worktree rows are gone.
    assert.equal(worktreeRowExists(db, 't1'), false);
    assert.equal(worktreeRowExists(db, 't2'), false);
    assert.equal(worktreeRowExists(db, 't3'), true);

    // The tasks table itself is the enumeration source, not something
    // this method mutates — task rows must survive.
    const taskCount = db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number };
    assert.equal(taskCount.n, 3);

    // Summary line names the plan and the count processed.
    const summary = logger.infos.find(
        (l) => l.message === 'task-worktrees: removed all worktrees for plan',
    );
    assert.ok(summary, 'expected a summary log line');
    assert.deepEqual(summary?.meta, { planId: 'plan-A', tasksProcessed: 2 });
});

test('one task\'s removeOnDisk failure is logged and does not stop the rest', async () => {
    const db = openDatabase(':memory:');
    applyMigrations(db);
    const logger = new FakeLogger();
    const store = makeStore(db, logger);

    seedTask(db, 't1', 'plan-A');
    seedTask(db, 't2', 'plan-A');
    seedWorktreeRow(db, 't1');
    seedWorktreeRow(db, 't2');

    // Force removeOnDisk to blow up for t1 only. removeOnDisk normally
    // swallows everything, so we inject a hard throw to prove the loop's
    // own guard isolates it.
    const processed: string[] = [];
    const original = store.removeOnDisk.bind(store);
    store.removeOnDisk = async (taskId: string): Promise<void> => {
        processed.push(taskId);
        if (taskId === 't1') throw new Error('boom');
        await original(taskId);
    };

    // Must not throw despite t1 failing.
    await store.removeAllForPlan('plan-A');

    // Both tasks were visited...
    assert.deepEqual(processed.sort(), ['t1', 't2']);
    // ...and both rows were dropped — the failure path still runs the
    // row delete for t1.
    assert.equal(worktreeRowExists(db, 't1'), false);
    assert.equal(worktreeRowExists(db, 't2'), false);
    // The failure surfaced as a warning, not a silent drop.
    assert.ok(
        logger.warnings.some(
            (w) => w.message === 'task-worktrees: removeOnDisk failed during plan cleanup',
        ),
        'expected a warning for the failed task',
    );
});

test('a plan with no tasks is a no-op that still logs a zero-count summary', async () => {
    const db = openDatabase(':memory:');
    applyMigrations(db);
    const logger = new FakeLogger();
    const store = makeStore(db, logger);

    await store.removeAllForPlan('plan-empty');

    const summary = logger.infos.find(
        (l) => l.message === 'task-worktrees: removed all worktrees for plan',
    );
    assert.deepEqual(summary?.meta, { planId: 'plan-empty', tasksProcessed: 0 });
});
