/**
 * ProjectRegistry behaviour, ported from the deleted file-loader suite.
 *
 * `ProjectRegistry.load(dir)` and its parser are gone along with
 * `config/projects/<id>/project.json` — project configuration is worker
 * state, not application source. Its parse-error tests went with it:
 * there is no file left to malform.
 *
 * What survives is everything about how the registry BEHAVES once built,
 * which is source-independent: credential resolution, stale-override
 * warnings, and the validation gate. Re-tested here against a row.
 * `registry.db.test.ts` covers the row-shape parsing itself.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import type { FlowDefinition } from '../flow/types';
import { applyMigrations, openDatabase, type Db } from '../state/migrations';
import {
    InvalidApprovalOverrideError,
    ProjectRegistry,
    UnknownProjectError,
} from './registry';

function makeDb(): Db {
    const db = openDatabase(':memory:');
    applyMigrations(db);
    return db;
}

function insertProject(db: Db, id: string, metadata: unknown): void {
    db.prepare(
        `INSERT INTO projects(id, name, metadata, archived_at, updated_at)
         VALUES (?, ?, ?, NULL, 1)`,
    ).run(id, id, JSON.stringify(metadata));
}

function buildFlow(stepIds: readonly string[]): FlowDefinition {
    return {
        on: 'task.created',
        steps: stepIds.map((id, i) => ({
            id,
            agent: 'reviewer',
            model: 'claude-sonnet-4-6',
            on_success: i < stepIds.length - 1 ? stepIds[i + 1]! : 'emit:TaskFinished',
        })),
    };
}

function captureWarnings(run: () => void): string[] {
    const captured: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]): void => {
        captured.push(
            args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '),
        );
    };
    try {
        run();
    } finally {
        console.warn = original;
    }
    return captured;
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

test('get re-reads env every call, so credential rotation needs no reload', () => {
    const db = makeDb();
    const prev = process.env.ROTATING_TOKEN;
    try {
        insertProject(db, 'p', { credentialEnv: { gitHubToken: 'ROTATING_TOKEN' } });
        const reg = ProjectRegistry.fromDb(db);

        process.env.ROTATING_TOKEN = 'first';
        assert.equal(reg.get('p').credentials.gitHubToken, 'first');
        process.env.ROTATING_TOKEN = 'second';
        assert.equal(reg.get('p').credentials.gitHubToken, 'second');
    } finally {
        if (prev === undefined) delete process.env.ROTATING_TOKEN;
        else process.env.ROTATING_TOKEN = prev;
        db.close();
    }
});

test('get throws UnknownProjectError for an unregistered id', () => {
    const db = makeDb();
    try {
        assert.throws(
            () => ProjectRegistry.fromDb(db).get('nope'),
            (err: unknown) => err instanceof UnknownProjectError && err.projectId === 'nope',
        );
    } finally {
        db.close();
    }
});

test('list returns every project with credentials and overrides resolved', () => {
    const db = makeDb();
    try {
        insertProject(db, 'alpha', { approvalOverride: { commit: { lint: 'auto' } } });
        insertProject(db, 'beta', {});
        const all = ProjectRegistry.fromDb(db)
            .list()
            .sort((a, b) => a.id.localeCompare(b.id));
        assert.deepEqual(all.map((p) => p.id), ['alpha', 'beta']);
        assert.deepEqual(all[0]!.approvalOverride, { commit: { lint: 'auto' } });
        assert.deepEqual(all[1]!.approvalOverride, {});
    } finally {
        db.close();
    }
});

test('planDefaults come through for the new-plan modal', () => {
    const db = makeDb();
    try {
        insertProject(db, 'p', {
            planDefaults: { namespace_root: 'Example.Loans', test_framework: 'xunit' },
        });
        assert.deepEqual(ProjectRegistry.fromDb(db).get('p').planDefaults, {
            namespace_root: 'Example.Loans',
            test_framework: 'xunit',
        });
    } finally {
        db.close();
    }
});

// ---------------------------------------------------------------------------
// The validation gate
// ---------------------------------------------------------------------------

test('updateApprovalOverride rejects values other than auto | required | default', () => {
    const db = makeDb();
    try {
        insertProject(db, 'p', {});
        const reg = ProjectRegistry.fromDb(db);
        assert.throws(
            () => reg.updateApprovalOverride('p', { commit: { lint: 'sometimes' } } as never),
            InvalidApprovalOverrideError,
        );
        assert.throws(
            () => reg.updateApprovalOverride('p', { commit: 'auto' } as never),
            InvalidApprovalOverrideError,
        );
        assert.throws(
            () => reg.updateApprovalOverride('p', 'nope' as never),
            InvalidApprovalOverrideError,
        );
    } finally {
        db.close();
    }
});

test('updateApprovalOverride accepts a partial override covering one flow', () => {
    const db = makeDb();
    try {
        insertProject(db, 'p', {});
        ProjectRegistry.fromDb(db).updateApprovalOverride('p', { commit: { lint: 'auto' } });
    } finally {
        db.close();
    }
});

test('getApprovalOverride throws UnknownProjectError for an unregistered id', () => {
    const db = makeDb();
    try {
        assert.throws(
            () => ProjectRegistry.fromDb(db).getApprovalOverride('nope'),
            UnknownProjectError,
        );
    } finally {
        db.close();
    }
});

// ---------------------------------------------------------------------------
// Stale-override warnings
//
// A stale override silently no-ops in the engine: the operator's "always
// auto-approve" appears to do nothing, with no reason given anywhere.
// ---------------------------------------------------------------------------

test('warnUnknownOverrideSteps is silent when every override step exists', () => {
    const db = makeDb();
    try {
        insertProject(db, 'alpha', {
            approvalOverride: { commit: { lint: 'auto', release: 'required' } },
        });
        const reg = ProjectRegistry.fromDb(db);
        assert.deepEqual(
            captureWarnings(() =>
                reg.warnUnknownOverrideSteps('alpha', buildFlow(['lint', 'release'])),
            ),
            [],
        );
        assert.deepEqual(reg.getApprovalOverrideWarnings(), []);
    } finally {
        db.close();
    }
});

test('warnUnknownOverrideSteps is silent for a project with no override', () => {
    const db = makeDb();
    try {
        insertProject(db, 'alpha', {});
        const reg = ProjectRegistry.fromDb(db);
        assert.deepEqual(
            captureWarnings(() => reg.warnUnknownOverrideSteps('alpha', buildFlow(['lint']))),
            [],
        );
    } finally {
        db.close();
    }
});

test('warnUnknownOverrideSteps warns per unknown step id without throwing', () => {
    const db = makeDb();
    try {
        insertProject(db, 'alpha', {
            approvalOverride: {
                commit: { lint: 'auto', ghost: 'required' },
                review: { phantom: 'auto' },
            },
        });
        const reg = ProjectRegistry.fromDb(db);
        const warnings = captureWarnings(() =>
            reg.warnUnknownOverrideSteps('alpha', buildFlow(['lint'])),
        );
        assert.equal(warnings.length, 2);
        const joined = warnings.join('\n');
        assert.match(joined, /step id "ghost"/);
        assert.match(joined, /flow "commit"/);
        assert.match(joined, /step id "phantom"/);
        assert.match(joined, /silently no-op/);
    } finally {
        db.close();
    }
});

test('getApprovalOverrideWarnings records one entry per stale step, deduped', () => {
    const db = makeDb();
    try {
        insertProject(db, 'alpha', {
            approvalOverride: {
                commit: { lint: 'auto', ghost: 'required' },
                review: { phantom: 'auto' },
            },
        });
        const reg = ProjectRegistry.fromDb(db);
        const flow = buildFlow(['lint']);
        assert.deepEqual(reg.getApprovalOverrideWarnings(), [], 'empty before any call');

        captureWarnings(() => reg.warnUnknownOverrideSteps('alpha', flow));
        captureWarnings(() => reg.warnUnknownOverrideSteps('alpha', flow));

        const warnings = reg
            .getApprovalOverrideWarnings()
            .slice()
            .sort((a, b) => a.stepId.localeCompare(b.stepId));
        assert.equal(warnings.length, 2, 'repeat calls must not multiply the surface');
        assert.equal(warnings[0]!.projectId, 'alpha');
        assert.equal(warnings[0]!.flowName, 'commit');
        assert.equal(warnings[0]!.stepId, 'ghost');
        assert.match(warnings[0]!.reason, /silently no-op/);
        assert.equal(warnings[1]!.stepId, 'phantom');
    } finally {
        db.close();
    }
});

test('warnUnknownOverrideSteps throws UnknownProjectError for an unregistered id', () => {
    const db = makeDb();
    try {
        assert.throws(
            () =>
                ProjectRegistry.fromDb(db).warnUnknownOverrideSteps(
                    'nope',
                    buildFlow(['lint']),
                ),
            (err: unknown) => err instanceof UnknownProjectError && err.projectId === 'nope',
        );
    } finally {
        db.close();
    }
});
