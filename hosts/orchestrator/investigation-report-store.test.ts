/**
 * Durable report lookup (ImplementFromInvestigation / View report).
 *
 *   1. An InvestigationCompleted event is the primary source.
 *   2. A report ROLE's step summary is the fallback.
 *   3. Regression: a code task's `review` step (run by the `reviewer`
 *      role) must NOT be readable as a report — the old query matched
 *      the step id role-agnostically, so an implement task could be
 *      "implemented from" its reviewer's approval notes.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { applyMigrations, openDatabase, type Db } from '../../core/state/migrations';

import { CORE_REPORT_ROLES, createDbInvestigationReportStore } from './handlers';

function seedStep(
    db: Db,
    taskId: string,
    stepId: string,
    role: string,
    summary: string,
): void {
    db.prepare(
        `INSERT INTO task_step_summaries(task_id, step_id, role, status, started_at, finished_at, summary)
         VALUES (?, ?, ?, 'complete', 1, 2, ?)`,
    ).run(taskId, stepId, role, summary);
}

function makeDb(): Db {
    const db = openDatabase(':memory:');
    applyMigrations(db);
    return db;
}

test('a report role step summary is readable as a report', () => {
    const db = makeDb();
    try {
        seedStep(db, 'T-INV', 'investigator', 'investigator', '# Findings\nroot cause X');
        const got = createDbInvestigationReportStore(db).get('T-INV', 'any');
        assert.ok(got);
        assert.match(got!.markdown, /root cause X/);
    } finally {
        db.close();
    }
});

test("a pack's report roles are read when the host supplies them", () => {
    // `azure-reviewer` / `azure-diagnostician` were literals in the query.
    // They belong to the dotnet-azure pack, so the HOST passes them now —
    // core's default knows only its own roles.
    const db = makeDb();
    try {
        seedStep(db, 'T-DIAG', 'diagnose', 'azure-diagnostician', '# Diagnosis: 500s');
        seedStep(db, 'T-AZ', 'review', 'azure-reviewer', '# Azure findings');
        seedStep(db, 'T-CB', 'review', 'codebase-reviewer', '# Codebase findings');
        const store = createDbInvestigationReportStore(db, [
            ...CORE_REPORT_ROLES, 'azure-reviewer', 'azure-diagnostician',
        ]);
        assert.match(store.get('T-DIAG', 'x')!.markdown, /Diagnosis/);
        assert.match(store.get('T-AZ', 'x')!.markdown, /Azure findings/);
        assert.match(store.get('T-CB', 'x')!.markdown, /Codebase findings/);
    } finally {
        db.close();
    }
});

test("with no pack, a pack role's summary is NOT a report", () => {
    // The other half of the split: core alone must not read a role it does
    // not ship. (The dotnet-azure install gets them back via the host.)
    const db = makeDb();
    try {
        seedStep(db, 'T-AZ', 'review', 'azure-reviewer', '# Azure findings');
        assert.equal(createDbInvestigationReportStore(db).get('T-AZ', 'x'), undefined);
        assert.deepEqual([...CORE_REPORT_ROLES], ['investigator', 'codebase-reviewer']);
    } finally {
        db.close();
    }
});

test('an empty role list reads no step summary instead of failing the query', () => {
    // `role IN ()` is a SQL syntax error, not a no-match — an install that
    // supplied nothing would throw on every lookup.
    const db = makeDb();
    try {
        seedStep(db, 'T-INV2', 'investigator', 'investigator', '# Findings');
        assert.equal(createDbInvestigationReportStore(db, []).get('T-INV2', 'x'), undefined);
    } finally {
        db.close();
    }
});

test("a code task's reviewer step is NOT a report (regression)", () => {
    const db = makeDb();
    try {
        // Exactly the shape an implement flow records.
        seedStep(db, 'T-IMPL', 'develop', 'developer', 'wrote the importer');
        seedStep(db, 'T-IMPL', 'review', 'reviewer', 'APPROVED — all criteria met');
        const got = createDbInvestigationReportStore(db).get('T-IMPL', 'any');
        assert.equal(
            got,
            undefined,
            'a reviewer summary must not be implementable as an investigation report',
        );
    } finally {
        db.close();
    }
});

test('an InvestigationCompleted event wins over step summaries', () => {
    const db = makeDb();
    try {
        seedStep(db, 'T-BOTH', 'investigator', 'investigator', 'step summary');
        db.prepare(
            `INSERT INTO events(type, v, occurred_at, idempotency_key, payload)
             VALUES ('InvestigationCompleted', 1, 5, 'inv:T-BOTH', ?)`,
        ).run(JSON.stringify({ taskId: 'T-BOTH', answer: 'event answer' }));
        const got = createDbInvestigationReportStore(db).get('T-BOTH', 'any');
        assert.equal(got?.markdown, 'event answer');
    } finally {
        db.close();
    }
});
