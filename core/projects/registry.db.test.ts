/**
 * ProjectRegistry backed by the `projects` projection.
 *
 * Project config is worker state, not application source — so the registry
 * reads the row rather than `config/projects/<id>/project.json`, which only
 * ever existed for projects created through the manager-api. A project
 * created from the board had NO file, and so silently ran with no repos,
 * no credential mapping and no approval overrides.
 *
 * Tolerance is the deliberate difference from the file loader: a malformed
 * file aborted boot (an operator had hand-edited it and needed telling), a
 * malformed row must not take the whole worker down for one project.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { applyMigrations, openDatabase, type Db } from '../state/migrations';
import { ProjectRegistry, UnknownProjectError } from './registry';

function makeDb(): Db {
    const db = openDatabase(':memory:');
    applyMigrations(db);
    return db;
}

function insertProject(
    db: Db,
    id: string,
    name: string | null,
    metadata: unknown,
    archivedAt: number | null = null,
): void {
    db.prepare(
        `INSERT INTO projects(id, name, metadata, archived_at, updated_at)
         VALUES (?, ?, ?, ?, 1)`,
    ).run(id, name, metadata === undefined ? null : JSON.stringify(metadata), archivedAt);
}

test('a project row resolves to the same shape the file loader produced', () => {
    const db = makeDb();
    try {
        insertProject(db, 'shop', 'Shop', {
            abbr: 'LD',
            color: '#336699',
            description: 'Loans',
            gitHubOwner: 'example-org',
            linearTeamId: 'team-1',
            jiraProjectKey: 'LD',
            credentialEnv: { gitHubToken: 'GH_TOKEN_LD' },
            repos: [
                { id: 'shop.orders', defaultBranch: 'main' },
                { id: 'shop', url: 'https://github.com/x/shop.git' },
            ],
        });

        const reg = ProjectRegistry.fromDb(db);
        assert.deepEqual(reg.ids(), ['shop']);

        const project = reg.get('shop');
        assert.equal(project.name, 'Shop');
        assert.equal(project.gitHubOwner, 'example-org');
        assert.equal(project.linearTeamId, 'team-1');
        assert.equal(project.jiraProjectKey, 'LD');
        assert.deepEqual(project.repos.map((r) => r.id), [
            'shop.orders',
            'shop',
        ]);
        assert.equal(project.repos[0]!.defaultBranch, 'main');
        assert.equal(project.repos[1]!.url, 'https://github.com/x/shop.git');
        // Credentials stay indirect: the row names the env var, the
        // registry resolves it at get() time.
        assert.equal(project.credentials.gitHubToken, undefined, 'unset env = undefined');
    } finally {
        db.close();
    }
});

test('credential env names resolve from the environment at get() time', () => {
    const db = makeDb();
    const prev = process.env.GH_TOKEN_TEST;
    process.env.GH_TOKEN_TEST = 'secret-value';
    try {
        insertProject(db, 'p', 'P', { credentialEnv: { gitHubToken: 'GH_TOKEN_TEST' } });
        const project = ProjectRegistry.fromDb(db).get('p');
        assert.equal(project.credentials.gitHubToken, 'secret-value');
    } finally {
        if (prev === undefined) delete process.env.GH_TOKEN_TEST;
        else process.env.GH_TOKEN_TEST = prev;
        db.close();
    }
});

test('archived projects are not registered', () => {
    // An archived project must not drive a flow; `get()` throwing is how
    // the engine already treats a project it does not know.
    const db = makeDb();
    try {
        insertProject(db, 'live', 'Live', {});
        insertProject(db, 'gone', 'Gone', {}, 1_700_000_000_000);
        const reg = ProjectRegistry.fromDb(db);
        assert.deepEqual(reg.ids(), ['live']);
        assert.equal(reg.has('gone'), false);
        assert.throws(() => reg.get('gone'), UnknownProjectError);
    } finally {
        db.close();
    }
});

test('a project with no metadata still resolves, with empty defaults', () => {
    // Every project created from the board today is exactly this row.
    const db = makeDb();
    try {
        insertProject(db, 'bare', 'Bare', undefined);
        const project = ProjectRegistry.fromDb(db).get('bare');
        assert.deepEqual(project.repos, []);
        assert.deepEqual(project.approvalOverride, {});
        assert.equal(project.name, 'Bare');
        // `resolveCredentials` returns the key set with undefined values
        // (shared with the file source), so assert on the values rather
        // than the object shape.
        assert.deepEqual(
            Object.values(project.credentials).filter((v) => v !== undefined),
            [],
        );
    } finally {
        db.close();
    }
});

test('a malformed metadata blob degrades that project instead of failing boot', () => {
    const db = makeDb();
    try {
        db.prepare(
            `INSERT INTO projects(id, name, metadata, archived_at, updated_at)
             VALUES ('broken', 'Broken', '{not json', NULL, 1)`,
        ).run();
        insertProject(db, 'fine', 'Fine', { repos: [{ id: 'r' }] });

        const reg = ProjectRegistry.fromDb(db);
        assert.deepEqual(reg.ids().sort(), ['broken', 'fine']);
        assert.deepEqual(reg.get('broken').repos, [], 'unusable blob = empty, not a throw');
        assert.deepEqual(reg.get('fine').repos.map((r) => r.id), ['r']);
    } finally {
        db.close();
    }
});

test('half-filled repo entries are dropped, not fatal', () => {
    const db = makeDb();
    try {
        insertProject(db, 'p', 'P', {
            repos: [{ id: 'good' }, { name: 'no-id' }, 'nonsense', null],
        });
        assert.deepEqual(
            ProjectRegistry.fromDb(db).get('p').repos.map((r) => r.id),
            ['good'],
        );
    } finally {
        db.close();
    }
});

test('a row with no name falls back to the id', () => {
    const db = makeDb();
    try {
        insertProject(db, 'no-name', null, {});
        assert.equal(ProjectRegistry.fromDb(db).get('no-name').name, 'no-name');
    } finally {
        db.close();
    }
});

// ---------------------------------------------------------------------------
// Approval overrides
// ---------------------------------------------------------------------------

test('approval overrides are read live from the row', () => {
    // Read-through, so a write since this registry was built is visible —
    // the property the file version had, preserved.
    const db = makeDb();
    try {
        insertProject(db, 'p', 'P', {});
        const reg = ProjectRegistry.fromDb(db);
        assert.deepEqual(reg.getApprovalOverride('p'), {});

        db.prepare('UPDATE projects SET metadata = ? WHERE id = ?').run(
            JSON.stringify({ approvalOverride: { implement: { develop: 'auto' } } }),
            'p',
        );
        assert.deepEqual(reg.getApprovalOverride('p'), {
            implement: { develop: 'auto' },
        });
        assert.deepEqual(reg.get('p').approvalOverride, {
            implement: { develop: 'auto' },
        });
    } finally {
        db.close();
    }
});

test('updateApprovalOverride validates but does not write on the DB source', () => {
    // The command handler calls this as its validation gate; the row is
    // written by the projection that folds the resulting event, so a
    // replay reproduces it.
    const db = makeDb();
    try {
        insertProject(db, 'p', 'P', {});
        const reg = ProjectRegistry.fromDb(db);

        reg.updateApprovalOverride('p', { implement: { develop: 'auto' } });
        assert.deepEqual(
            reg.getApprovalOverride('p'),
            {},
            'the registry must not write the projection behind the event log',
        );

        assert.throws(() => reg.updateApprovalOverride('nope', {}), UnknownProjectError);
        assert.throws(
            () => reg.updateApprovalOverride('p', {
                implement: { develop: 'sometimes' },
            } as never),
            /approval/i,
            'a malformed override must abort before any event is emitted',
        );
    } finally {
        db.close();
    }
});
