/**
 * Boot must resolve a step the previous worker process left mid-run.
 *
 * Field report: "there was another agent running, the Get-Process query
 * now returns no results, but Tester still shows running". The worker
 * had restarted 77 seconds after that tester spawned, taking the child
 * process AND the `close` handler that publishes a run's terminal event
 * — so the row read `running` forever, flow_state never advanced, and
 * the board spun on a process that no longer existed.
 *
 * Driven against a REAL `orch.start()` rather than the reconciliation
 * functions alone (those have their own file): what was missing was the
 * pass running at all, and only a boot can show that it does.
 *
 * The DB is file-backed because the pass runs DURING start() — the row
 * has to exist before the orchestrator opens the database, which
 * `:memory:` makes impossible.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { openDatabase, applyMigrations, type Db } from '../../core/state/migrations';
import { Orchestrator } from './main';
import type { Logger } from '../../core/ports/Logger';

class SilentLogger implements Logger {
    info(): void {}
    warn(): void {}
    error(): void {}
    debug(): void {}
}

const FLOWS_DIR = path.resolve(__dirname, '..', '..', 'config', 'flows');

/** A task mid-run: flow_state on the step, step row still 'running'. */
function seedStrandedRun(db: Db, taskId: string, stepId = 'test'): void {
    db.prepare(
        "INSERT INTO plans(id, project_id, status, created_at) VALUES (?, 'p', 'approved', 1)",
    ).run(`pl-${taskId}`);
    db.prepare(
        'INSERT INTO tasks(id, plan_id, type, status, flow_id)'
        + " VALUES (?, ?, 'implement', 'in-progress', 'implement')",
    ).run(taskId, `pl-${taskId}`);
    db.prepare(
        'INSERT INTO flow_state(task_id, current_step, last_event_seq) VALUES (?, ?, 0)',
    ).run(taskId, stepId);
    db.prepare(
        'INSERT INTO task_step_summaries'
        + ' (task_id, step_id, role, status, started_at, finished_at, summary)'
        + " VALUES (?, ?, 'tester', 'running', 1000, NULL, NULL)",
    ).run(taskId, stepId);
}

function withSeededDb(seed: (db: Db) => void): {
    dbPath: string;
    cleanup: () => void;
} {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orphan-boot-'));
    const dbPath = path.join(dir, 'state.db');
    const db = openDatabase(dbPath);
    applyMigrations(db);
    seed(db);
    db.close();
    return {
        dbPath,
        cleanup: (): void => {
            try {
                fs.rmSync(dir, { recursive: true, force: true });
            } catch {
                /* Windows may still hold the file; the temp dir is swept anyway */
            }
        },
    };
}

function orchestratorOn(dbPath: string): Orchestrator {
    return new Orchestrator({
        dbPath,
        flowsDir: FLOWS_DIR,
        logger: new SilentLogger(),
        idGen: { newId: (): string => 'x' },
    });
}

// --- the field bug ----------------------------------------------------

test('a run stranded by a restart is resolved at boot', async () => {
    const seeded = withSeededDb((db) => seedStrandedRun(db, 'T-ORPHAN'));
    const orch = orchestratorOn(seeded.dbPath);
    await orch.start();
    try {
        const step = orch
            .getDb()
            .prepare(
                'SELECT status, finished_at, summary FROM task_step_summaries'
                + ' WHERE task_id = ? AND step_id = ?',
            )
            .get('T-ORPHAN', 'test') as {
                status: string;
                finished_at: number | null;
                summary: string | null;
            };

        assert.equal(step.status, 'failed', 'the chip must stop spinning');
        assert.ok(step.finished_at !== null, 'and the run must have an end');
        assert.match(
            step.summary ?? '',
            /worker restarted/i,
            'the summary must say what happened — there is no transcript to read',
        );
    } finally {
        await orch.stop();
        seeded.cleanup();
    }
});

test('the task is parked, so the operator has an affordance', async () => {
    // A task left with no park AND a stale flow_state offers neither
    // Resume nor a working start — the L-MIBO-010 shape recorded in
    // `clearsDependencyPark`.
    const seeded = withSeededDb((db) => seedStrandedRun(db, 'T-ORPHAN-2'));
    const orch = orchestratorOn(seeded.dbPath);
    await orch.start();
    try {
        const row = orch
            .getDb()
            .prepare('SELECT parked_reason, parked_question FROM tasks WHERE id = ?')
            .get('T-ORPHAN-2') as {
                parked_reason: string | null;
                parked_question: string | null;
            };

        assert.equal(row.parked_reason, 'wait-action');
        assert.match(row.parked_question ?? '', /Resume/);
    } finally {
        await orch.stop();
        seeded.cleanup();
    }
});

test('a task already parked for its OWN reason keeps that park', async () => {
    // A clarification is a more specific thing to be waiting for, and
    // the park is what carries the question text.
    const seeded = withSeededDb((db) => {
        seedStrandedRun(db, 'T-ORPHAN-3');
        db.prepare(
            "UPDATE tasks SET parked_reason = 'clarification',"
            + " parked_question = 'Which one?' WHERE id = ?",
        ).run('T-ORPHAN-3');
    });
    const orch = orchestratorOn(seeded.dbPath);
    await orch.start();
    try {
        const db = orch.getDb();
        const row = db
            .prepare('SELECT parked_reason, parked_question FROM tasks WHERE id = ?')
            .get('T-ORPHAN-3') as {
                parked_reason: string | null;
                parked_question: string | null;
            };
        assert.equal(row.parked_reason, 'clarification');
        assert.equal(row.parked_question, 'Which one?');

        // The step row is resolved regardless — the spinner was wrong
        // either way, and that is not the park's business.
        const step = db
            .prepare('SELECT status FROM task_step_summaries WHERE task_id = ?')
            .get('T-ORPHAN-3') as { status: string };
        assert.equal(step.status, 'failed');
    } finally {
        await orch.stop();
        seeded.cleanup();
    }
});

// --- restarting repeatedly -------------------------------------------

test('restarting twice does not re-report the same stranded run', async () => {
    // The key is per (task, step, startedAt), so a second boot before
    // the operator has dealt with it stays quiet.
    const seeded = withSeededDb((db) => seedStrandedRun(db, 'T-ORPHAN-4'));
    try {
        for (let i = 0; i < 2; i += 1) {
            const orch = orchestratorOn(seeded.dbPath);
            await orch.start();
            await orch.stop();
        }
        const db = openDatabase(seeded.dbPath);
        try {
            const n = db
                .prepare(
                    "SELECT COUNT(*) AS n FROM events WHERE type = 'AgentRunOrphaned'"
                    + " AND payload LIKE '%T-ORPHAN-4%'",
                )
                .get() as { n: number };
            assert.equal(n.n, 1, 'one event for one stranded run');
        } finally {
            db.close();
        }
    } finally {
        seeded.cleanup();
    }
});

test('a clean boot publishes nothing', async () => {
    // A restart must not cost an event per finished step.
    const seeded = withSeededDb((db) => {
        db.prepare(
            'INSERT INTO plans(id, project_id, status, created_at)'
            + " VALUES ('pl-c', 'p', 'approved', 1)",
        ).run();
        db.prepare(
            'INSERT INTO tasks(id, plan_id, type, status)'
            + " VALUES ('T-CLEAN', 'pl-c', 'implement', 'done')",
        ).run();
        db.prepare(
            'INSERT INTO task_step_summaries'
            + ' (task_id, step_id, role, status, started_at, finished_at, summary)'
            + " VALUES ('T-CLEAN', 'develop', 'developer', 'complete', 1, 2, 'done')",
        ).run();
    });
    const orch = orchestratorOn(seeded.dbPath);
    await orch.start();
    try {
        const n = orch
            .getDb()
            .prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'AgentRunOrphaned'")
            .get() as { n: number };
        assert.equal(n.n, 0);
    } finally {
        await orch.stop();
        seeded.cleanup();
    }
});

test('a DONE task with a stray running row is resolved but not parked', async () => {
    // It can happen when the terminal event landed for the task but not
    // for the step. Fixing the row is right; reviving the card is not.
    const seeded = withSeededDb((db) => {
        seedStrandedRun(db, 'T-ORPHAN-5');
        db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run('T-ORPHAN-5');
    });
    const orch = orchestratorOn(seeded.dbPath);
    await orch.start();
    try {
        const db = orch.getDb();
        assert.equal(
            (db.prepare('SELECT status FROM task_step_summaries WHERE task_id = ?')
                .get('T-ORPHAN-5') as { status: string }).status,
            'failed',
        );
        assert.equal(
            (db.prepare('SELECT parked_reason FROM tasks WHERE id = ?')
                .get('T-ORPHAN-5') as { parked_reason: string | null }).parked_reason,
            null,
            'a finished task must not be parked',
        );
    } finally {
        await orch.stop();
        seeded.cleanup();
    }
});
