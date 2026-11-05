/**
 * Task ids must not collide across plans.
 *
 * An id is `<projectAbbr>-<planAbbr>-<seq>`, and the plan abbr is the
 * initials of the plan name with stopwords dropped. So "deploy products
 * api to staging" and "deploy products api to stg" both derive DPAS —
 * the second plan mints ids the first already owns, and `id` is the
 * primary key.
 *
 * Field case (plan-1786543915236-elif): the operator's new deploy plan
 * collided with one archived three weeks earlier. The TaskCreated
 * projection saw the id present, took its re-decompose branch, and reset
 * the OLD plan's rows without touching `plan_id`. The new plan ended up
 * with zero tasks — a Draft card showing only the brief — while the
 * deploy that actually ran was recorded against the old plan, and the
 * archive-time worktree cleanup found nothing to clean.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { applyMigrations, openDatabase, type Db } from '../../core/state/migrations';
import type { Logger } from '../../core/ports/Logger';
import { derivePlanAbbr, renameDecomposerTaskIds } from './handlers';

interface LogLine {
    readonly message: string;
    readonly meta?: Readonly<Record<string, unknown>>;
}

function makeLogger(sink: LogLine[]): Logger {
    return {
        info: (): void => {},
        debug: (): void => {},
        error: (): void => {},
        warn: (message, meta): void => { sink.push({ message, meta }); },
    };
}

function makeDb(): Db {
    const db = openDatabase(':memory:');
    applyMigrations(db);
    db.prepare(
        `INSERT INTO projects(id, name, metadata, archived_at, updated_at)
         VALUES ('shop', 'Shop', ?, NULL, 1)`,
    ).run(JSON.stringify({ abbr: 'L' }));
    return db;
}

function seedPlan(db: Db, planId: string, name: string): void {
    db.prepare(
        "INSERT INTO plans(id, project_id, status, created_at) VALUES (?, 'shop', 'active', 1)",
    ).run(planId);
    db.prepare(
        `INSERT INTO sidebar_plans(plan_id, pid, name, status, updated_at)
         VALUES (?, 'shop', ?, 'active', 1)`,
    ).run(planId, name);
}

function seedTask(db: Db, taskId: string, planId: string): void {
    db.prepare(
        `INSERT INTO tasks(id, plan_id, type, status)
         VALUES (?, ?, 'deploy-azure', 'done')`,
    ).run(taskId, planId);
}

const RAW_TASKS = [
    { id: 'task-001', title: 'Deploy', type: 'deploy-azure', description: '', dependencies: [] },
    {
        id: 'task-002',
        title: 'Verify',
        type: 'deploy-verify',
        description: '',
        dependencies: ['task-001'],
    },
];

const ctxFor = (planId: string): never =>
    ({ planId, projectId: 'shop' } as never);

test('the two plan names from the field case really do collide', () => {
    // If this ever stops being true the bug below is unreachable — but
    // the abbreviation is initials-minus-stopwords, so it will not.
    assert.equal(derivePlanAbbr('deploy products api to staging'), 'DPAS');
    assert.equal(derivePlanAbbr('deploy products api to stg'), 'DPAS');
});

test('a second plan with the same abbr gets its own ids', () => {
    const db = makeDb();
    const logs: LogLine[] = [];
    try {
        seedPlan(db, 'plan-old', 'deploy products api to staging');
        seedPlan(db, 'plan-new', 'deploy products api to stg');
        seedTask(db, 'L-DPAS-001', 'plan-old');
        seedTask(db, 'L-DPAS-002', 'plan-old');

        const renamed = renameDecomposerTaskIds(
            db,
            ctxFor('plan-new'),
            RAW_TASKS,
            makeLogger(logs),
        );

        assert.deepEqual(
            renamed.map((t) => t.id),
            ['L-DPAS-003', 'L-DPAS-004'],
            'the sequence continues past the ids the other plan owns',
        );
        // Dependencies must be rewritten through the same map, or task 2
        // waits forever on an id that no longer exists.
        assert.deepEqual(renamed[1]!.dependencies, ['L-DPAS-003']);
        assert.ok(
            logs.some((l) => l.message.includes('already used by another plan')),
            'the collision must be visible, not silently absorbed',
        );
    } finally {
        db.close();
    }
});

test('re-decomposing the SAME plan reuses its ids', () => {
    // The projection's re-decompose reset depends on this: shifting here
    // would orphan the previous attempt's rows instead of resetting them.
    const db = makeDb();
    const logs: LogLine[] = [];
    try {
        seedPlan(db, 'plan-one', 'deploy products api to stg');
        seedTask(db, 'L-DPAS-001', 'plan-one');
        seedTask(db, 'L-DPAS-002', 'plan-one');

        const renamed = renameDecomposerTaskIds(
            db,
            ctxFor('plan-one'),
            RAW_TASKS,
            makeLogger(logs),
        );

        assert.deepEqual(renamed.map((t) => t.id), ['L-DPAS-001', 'L-DPAS-002']);
        assert.deepEqual(logs, [], 'nothing collided — nothing to report');
    } finally {
        db.close();
    }
});

test('a fresh prefix is unaffected', () => {
    const db = makeDb();
    try {
        seedPlan(db, 'plan-new', 'deploy products api to stg');
        const renamed = renameDecomposerTaskIds(db, ctxFor('plan-new'), RAW_TASKS, makeLogger([]));
        assert.deepEqual(renamed.map((t) => t.id), ['L-DPAS-001', 'L-DPAS-002']);
    } finally {
        db.close();
    }
});

test('the shift clears the HIGHEST taken sequence, not just the count', () => {
    // Two plans have already used the prefix and the survivor is 007 —
    // starting from "how many exist" would collide all over again.
    const db = makeDb();
    try {
        seedPlan(db, 'plan-a', 'deploy products api to staging');
        seedPlan(db, 'plan-new', 'deploy products api to stg');
        seedTask(db, 'L-DPAS-007', 'plan-a');

        const renamed = renameDecomposerTaskIds(db, ctxFor('plan-new'), RAW_TASKS, makeLogger([]));
        assert.deepEqual(renamed.map((t) => t.id), ['L-DPAS-008', 'L-DPAS-009']);
    } finally {
        db.close();
    }
});
