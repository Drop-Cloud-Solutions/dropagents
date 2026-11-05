/**
 * Giving up on a decomposer question.
 *
 * Field report: "I have the decomposer asking a question, one of the
 * options is cancel the task, which is what I selected but the question
 * keeps coming back and I have no way to dismiss the decomposer."
 *
 * The decomposer writes its own options, so nothing stops it offering
 * one the pipeline cannot perform. "Cancel the task" was only text:
 * `AnswerDecomposerQuestion` records it and a subscriber RE-SPAWNS the
 * decomposer, which asks again. And the card has no Dismiss while a
 * question is pending — deliberately, since that would hide the one
 * control that can un-hold the plan — so there was no exit at all.
 *
 * `AbandonDecomposerQuestion` is the exit. The thing that makes it work
 * is what does NOT happen: no re-spawn.
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

function withDb(): { dbPath: string; cleanup: () => void } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dec-abandon-'));
    const dbPath = path.join(dir, 'state.db');
    const db = openDatabase(dbPath);
    applyMigrations(db);
    db.close();
    return {
        dbPath,
        cleanup: (): void => {
            try {
                fs.rmSync(dir, { recursive: true, force: true });
            } catch {
                /* the OS sweeps the temp dir */
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

/** A plan held on a decomposer question, as the projection records it. */
function seedPendingQuestion(db: Db, planId: string, question = 'Which repo?'): void {
    db.prepare(
        "INSERT INTO plans(id, project_id, status, created_at) VALUES (?, 'proj-1', 'approved', 1)",
    ).run(planId);
    db.prepare(
        `INSERT INTO decomposer_clarifications
            (event_seq, plan_id, project_id, question, options, asked_at)
         VALUES (1, ?, 'proj-1', ?, NULL, 1)`,
    ).run(planId, question);
}

const pendingCount = (db: Db, planId: string): number =>
    (db
        .prepare(
            "SELECT COUNT(*) AS n FROM decomposer_clarifications"
            + " WHERE plan_id = ? AND (answer IS NULL OR TRIM(answer) = '')",
        )
        .get(planId) as { n: number }).n;

const eventTypes = (db: Db, planId: string): string[] =>
    (db
        .prepare(
            "SELECT type FROM events WHERE payload LIKE '%' || ? || '%' ORDER BY seq",
        )
        .all(planId) as Array<{ type: string }>).map((r) => r.type);

// --- the exit ---------------------------------------------------------

test('abandoning retires the question so it stops coming back', () => {
    const seeded = withDb();
    const db = openDatabase(seeded.dbPath);
    try {
        seedPendingQuestion(db, 'PL-1');
        assert.equal(pendingCount(db, 'PL-1'), 1, 'seeded as pending');
    } finally {
        db.close();
    }

    const orch = orchestratorOn(seeded.dbPath);
    return orch.start()
        .then(() => orch.getCommandBus().send({
            type: 'AbandonDecomposerQuestion',
            actor: 'operator',
            issuedAt: 1_700_000_000_000,
            payload: { planId: 'PL-1' },
        }))
        .then(() => {
            assert.equal(
                pendingCount(orch.getDb(), 'PL-1'),
                0,
                'the question must no longer read as unanswered',
            );
        })
        .finally(async () => {
            await orch.stop();
            seeded.cleanup();
        });
});

test('the decomposer is NOT re-spawned', async () => {
    // The whole point. Answering re-spawns; abandoning must not, or the
    // operator is back in the loop they were trying to leave.
    const seeded = withDb();
    const db = openDatabase(seeded.dbPath);
    try {
        seedPendingQuestion(db, 'PL-2');
    } finally {
        db.close();
    }
    const orch = orchestratorOn(seeded.dbPath);
    await orch.start();
    try {
        await orch.getCommandBus().send({
            type: 'AbandonDecomposerQuestion',
            actor: 'operator',
            issuedAt: 1_700_000_000_001,
            payload: { planId: 'PL-2' },
        });

        const types = eventTypes(orch.getDb(), 'PL-2');
        assert.ok(
            types.includes('PlanDecomposeQuestionAbandoned'),
            `the abandon must be recorded; got ${types.join(', ')}`,
        );
        assert.ok(
            !types.includes('PlanDecomposeQuestionAnswered'),
            'and must NOT be recorded as an answer',
        );
        assert.ok(
            !types.some((t) => t === 'AgentStarted' || t === 'StartAgent'),
            `no agent may be spawned; got ${types.join(', ')}`,
        );
    } finally {
        await orch.stop();
        seeded.cleanup();
    }
});

test('the history says it was abandoned, not left blank', async () => {
    // `readPendingDecomposerQuestion` selects on an empty answer, so a
    // blank would keep the question pending forever — the bug. Deleting
    // the row would erase that it was ever asked.
    const seeded = withDb();
    const db = openDatabase(seeded.dbPath);
    try {
        seedPendingQuestion(db, 'PL-3');
    } finally {
        db.close();
    }
    const orch = orchestratorOn(seeded.dbPath);
    await orch.start();
    try {
        await orch.getCommandBus().send({
            type: 'AbandonDecomposerQuestion',
            actor: 'operator',
            issuedAt: 1_700_000_000_002,
            payload: { planId: 'PL-3', reason: 'not worth decomposing' },
        });

        const row = orch.getDb()
            .prepare('SELECT question, answer FROM decomposer_clarifications WHERE plan_id = ?')
            .get('PL-3') as { question: string; answer: string | null };
        assert.equal(row.question, 'Which repo?', 'the question is kept');
        assert.match(row.answer ?? '', /abandoned by the operator/i);
        assert.match(row.answer ?? '', /not worth decomposing/, 'the reason is kept');
    } finally {
        await orch.stop();
        seeded.cleanup();
    }
});

// --- the guards -------------------------------------------------------

test('abandoning when nothing is pending is refused, not silently accepted', async () => {
    // Same contract as answering: a stale button says so rather than
    // retiring a question nobody asked.
    const seeded = withDb();
    const db = openDatabase(seeded.dbPath);
    try {
        db.prepare(
            "INSERT INTO plans(id, project_id, status, created_at) VALUES ('PL-4', 'p', 'approved', 1)",
        ).run();
    } finally {
        db.close();
    }
    const orch = orchestratorOn(seeded.dbPath);
    await orch.start();
    try {
        await assert.rejects(
            () => orch.getCommandBus().send({
                type: 'AbandonDecomposerQuestion',
                actor: 'operator',
                issuedAt: 1_700_000_000_003,
                payload: { planId: 'PL-4' },
            }),
            /no unanswered decomposer question/i,
        );
    } finally {
        await orch.stop();
        seeded.cleanup();
    }
});

test('a double-click collapses to one event', async () => {
    // The key is per (plan, question), exactly as the answer's is.
    const seeded = withDb();
    const db = openDatabase(seeded.dbPath);
    try {
        seedPendingQuestion(db, 'PL-5');
    } finally {
        db.close();
    }
    const orch = orchestratorOn(seeded.dbPath);
    await orch.start();
    try {
        await orch.getCommandBus().send({
            type: 'AbandonDecomposerQuestion',
            actor: 'operator',
            issuedAt: 1_700_000_000_004,
            payload: { planId: 'PL-5' },
        });
        // The second click is refused — the question is no longer
        // pending — which is itself the collapse the operator wants.
        await assert.rejects(() => orch.getCommandBus().send({
            type: 'AbandonDecomposerQuestion',
            actor: 'operator',
            issuedAt: 1_700_000_000_005,
            payload: { planId: 'PL-5' },
        }));

        const n = (orch.getDb()
            .prepare(
                "SELECT COUNT(*) AS n FROM events"
                + " WHERE type = 'PlanDecomposeQuestionAbandoned'"
                + " AND payload LIKE '%PL-5%'",
            )
            .get() as { n: number }).n;
        assert.equal(n, 1);
    } finally {
        await orch.stop();
        seeded.cleanup();
    }
});

test('the plan is left decomposable — nothing is failed or archived', async () => {
    // Giving up on a QUESTION is not giving up on the plan: editing it
    // and decomposing again is the next thing the operator does.
    const seeded = withDb();
    const db = openDatabase(seeded.dbPath);
    try {
        seedPendingQuestion(db, 'PL-6');
    } finally {
        db.close();
    }
    const orch = orchestratorOn(seeded.dbPath);
    await orch.start();
    try {
        await orch.getCommandBus().send({
            type: 'AbandonDecomposerQuestion',
            actor: 'operator',
            issuedAt: 1_700_000_000_006,
            payload: { planId: 'PL-6' },
        });

        const plan = orch.getDb()
            .prepare('SELECT status FROM plans WHERE id = ?')
            .get('PL-6') as { status: string };
        assert.equal(plan.status, 'approved', 'the plan is untouched');
    } finally {
        await orch.stop();
        seeded.cleanup();
    }
});
