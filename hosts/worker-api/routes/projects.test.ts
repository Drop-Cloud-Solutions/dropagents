/**
 * AP-FP-004 — unit tests for the projects + plans read routes.
 *
 * Trait category: Unit. Each test stands up an in-memory SQLite handle,
 * applies just the AP-FP-001 projection tables (no core migrations, so
 * no clash with the v1 `plans` table from `core/state/migrations/001`),
 * seeds rows, and exercises the production {@link SqliteProjectsReadStore}
 * adapter through the pure route handlers. No HTTP server, no Linear,
 * no filesystem.
 *
 * Coverage maps to the brief's acceptance criteria:
 *   AC #1, #2, #3 — happy path: list returns active rows in stable order
 *                    and reads come from the projection table only
 *   AC #3 — archived rows (archived_at IS NOT NULL) are excluded
 *   AC #1 — `pid` filter scopes the plans response correctly
 *   AC #5 — unknown pid resolves to 200 + `[]` (NOT 404)
 *   AC #7 — every test name is prefixed `[Unit]` so the project's test
 *           runner can filter on the Unit trait
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { openDatabase, type Db } from '../../../core/state/migrations';
import {
    PROJECTS_LIST_ROUTE_PATTERN,
    PROJECTS_PLANS_ROUTE_PATTERN,
    SqliteProjectsReadStore,
    createProjectsRouter,
    listPlansForProject,
    listProjects,
    type PlanRecord,
    type ProjectRecord,
} from './projects';

// ---------------------------------------------------------------------------
// Test harness — fresh in-memory DB with just the projection tables
// ---------------------------------------------------------------------------

/**
 * Build a clean SQLite handle with the AP-FP-001 projection tables. We
 * skip `applyMigrations` here because the core migrations install a v1
 * `plans` table whose shape conflicts with the projection — the read
 * route under test only touches the projection tables, so the narrow
 * harness sidesteps the schema clash and keeps the test focused.
 */
function makeProjectionDb(): Db {
    const db = openDatabase(':memory:');
    db.exec(`
        CREATE TABLE projects (
            id                   TEXT    NOT NULL PRIMARY KEY,
            name                 TEXT,
            linear_initiative_id TEXT,
            metadata             TEXT,
            archived_at          INTEGER,
            updated_at           INTEGER
        );
        CREATE TABLE sidebar_plans (
            plan_id     TEXT    NOT NULL,
            pid         TEXT    NOT NULL,
            name        TEXT,
            body        TEXT,
            metadata    TEXT,
            status      TEXT,
            archived_at INTEGER,
            updated_at  INTEGER,
            PRIMARY KEY (pid, plan_id)
        );
    `);
    return db;
}

function seedProject(
    db: Db,
    row: {
        id: string;
        name?: string;
        linear_initiative_id?: string;
        archived_at?: number | null;
        updated_at?: number;
    },
): void {
    db.prepare(
        `INSERT INTO projects(id, name, linear_initiative_id, archived_at, updated_at)
         VALUES (@id, @name, @linear, @archived, @updated)`,
    ).run({
        id: row.id,
        name: row.name ?? null,
        linear: row.linear_initiative_id ?? null,
        archived: row.archived_at ?? null,
        updated: row.updated_at ?? null,
    });
}

function seedPlan(
    db: Db,
    row: {
        plan_id: string;
        pid: string;
        name?: string;
        status?: string;
        archived_at?: number | null;
        updated_at?: number;
    },
): void {
    db.prepare(
        `INSERT INTO sidebar_plans(plan_id, pid, name, status, archived_at, updated_at)
         VALUES (@plan_id, @pid, @name, @status, @archived, @updated)`,
    ).run({
        plan_id: row.plan_id,
        pid: row.pid,
        name: row.name ?? null,
        status: row.status ?? null,
        archived: row.archived_at ?? null,
        updated: row.updated_at ?? null,
    });
}

// ---------------------------------------------------------------------------
// AC #1, #2, #3, #7 — GET /api/projects happy path
// ---------------------------------------------------------------------------

test('[Unit] listProjects returns active rows in stable id-ascending order', () => {
    const db = makeProjectionDb();
    try {
        seedProject(db, { id: 'p-charlie', name: 'Charlie', updated_at: 1000 });
        seedProject(db, { id: 'p-alpha', name: 'Alpha', updated_at: 3000 });
        seedProject(db, { id: 'p-bravo', name: 'Bravo', updated_at: 2000 });

        const store = new SqliteProjectsReadStore(db);
        const result = listProjects({ store });

        assert.equal(result.status, 200);
        const body = (result.body as { projects: readonly ProjectRecord[] }).projects;
        assert.deepEqual(
            body.map((p) => p.id),
            ['p-alpha', 'p-bravo', 'p-charlie'],
            'projects sorted by id ASC',
        );
        assert.equal(body[0].name, 'Alpha');
        assert.equal(body[0].linearInitiativeId, null);
        assert.equal(body[0].updatedAt, 3000);
    } finally {
        db.close();
    }
});

test('[Unit] listProjects surfaces the linear_initiative_id column when set', () => {
    const db = makeProjectionDb();
    try {
        seedProject(db, {
            id: 'p-1',
            name: 'Pipeline',
            linear_initiative_id: 'init-42',
            updated_at: 1000,
        });

        const store = new SqliteProjectsReadStore(db);
        const result = listProjects({ store });
        const body = (result.body as { projects: readonly ProjectRecord[] }).projects;

        assert.equal(body.length, 1);
        assert.equal(body[0].linearInitiativeId, 'init-42');
    } finally {
        db.close();
    }
});

// ---------------------------------------------------------------------------
// AC #3 — archived projects excluded
// ---------------------------------------------------------------------------

test('[Unit] listProjects excludes rows whose archived_at IS NOT NULL', () => {
    const db = makeProjectionDb();
    try {
        seedProject(db, { id: 'p-active', name: 'Active', updated_at: 1000 });
        seedProject(db, {
            id: 'p-archived',
            name: 'Archived',
            archived_at: 2000,
            updated_at: 2000,
        });

        const store = new SqliteProjectsReadStore(db);
        const result = listProjects({ store });
        const body = (result.body as { projects: readonly ProjectRecord[] }).projects;

        assert.equal(body.length, 1, 'archived row filtered out');
        assert.equal(body[0].id, 'p-active');
    } finally {
        db.close();
    }
});

test('[Unit] listProjects returns an empty array when the projection is empty', () => {
    // AC: empty projection ⇒ empty sidebar by design — no Linear fallback.
    const db = makeProjectionDb();
    try {
        const store = new SqliteProjectsReadStore(db);
        const result = listProjects({ store });

        assert.equal(result.status, 200);
        assert.deepEqual(result.body, { projects: [] });
    } finally {
        db.close();
    }
});

// ---------------------------------------------------------------------------
// AC #1, #3 — GET /api/projects/:pid/plans pid filtering + archive exclusion
// ---------------------------------------------------------------------------

test('[Unit] listPlansForProject returns only plans matching the pid', () => {
    const db = makeProjectionDb();
    try {
        seedProject(db, { id: 'p-1', name: 'One', updated_at: 1000 });
        seedProject(db, { id: 'p-2', name: 'Two', updated_at: 1000 });
        seedPlan(db, {
            plan_id: 'pl-1a',
            pid: 'p-1',
            name: 'Plan 1A',
            status: 'created',
            updated_at: 2000,
        });
        seedPlan(db, {
            plan_id: 'pl-1b',
            pid: 'p-1',
            name: 'Plan 1B',
            status: 'approved',
            updated_at: 2100,
        });
        seedPlan(db, {
            plan_id: 'pl-2a',
            pid: 'p-2',
            name: 'Plan 2A',
            status: 'in_progress',
            updated_at: 2200,
        });

        const store = new SqliteProjectsReadStore(db);
        const result = listPlansForProject({ store }, 'p-1');

        assert.equal(result.status, 200);
        const body = (result.body as { plans: readonly PlanRecord[] }).plans;
        assert.deepEqual(
            body.map((p) => p.planId),
            ['pl-1a', 'pl-1b'],
            'only p-1 plans returned, sorted by plan_id ASC',
        );
        assert.equal(body[0].pid, 'p-1');
        assert.equal(body[0].name, 'Plan 1A');
        assert.equal(body[0].status, 'created');
        assert.equal(body[1].status, 'approved');
        // Cross-project leakage check
        assert.ok(
            body.every((p) => p.pid === 'p-1'),
            'no plans from p-2 leaked into the response',
        );
    } finally {
        db.close();
    }
});

test('[Unit] listPlansForProject excludes archived plans even when active for the same pid', () => {
    const db = makeProjectionDb();
    try {
        seedPlan(db, {
            plan_id: 'pl-active',
            pid: 'p-1',
            name: 'Active',
            updated_at: 1000,
        });
        seedPlan(db, {
            plan_id: 'pl-archived',
            pid: 'p-1',
            name: 'Archived',
            archived_at: 1500,
            updated_at: 1500,
        });

        const store = new SqliteProjectsReadStore(db);
        const result = listPlansForProject({ store }, 'p-1');
        const body = (result.body as { plans: readonly PlanRecord[] }).plans;

        assert.equal(body.length, 1);
        assert.equal(body[0].planId, 'pl-active');
    } finally {
        db.close();
    }
});

// ---------------------------------------------------------------------------
// AC #5 — unknown pid returns 200 with an empty array (NOT 404)
// ---------------------------------------------------------------------------

test('[Unit] listPlansForProject returns 200 + [] for an unknown pid (not 404)', () => {
    const db = makeProjectionDb();
    try {
        seedPlan(db, {
            plan_id: 'pl-1',
            pid: 'p-known',
            name: 'Existing',
            updated_at: 1000,
        });

        const store = new SqliteProjectsReadStore(db);
        const result = listPlansForProject({ store }, 'p-unknown');

        assert.equal(result.status, 200, 'unknown pid is NOT 404');
        assert.deepEqual(result.body, { plans: [] });
    } finally {
        db.close();
    }
});

test('[Unit] listPlansForProject returns 200 + [] when the projection has no plans at all', () => {
    const db = makeProjectionDb();
    try {
        const store = new SqliteProjectsReadStore(db);
        const result = listPlansForProject({ store }, 'p-1');

        assert.equal(result.status, 200);
        assert.deepEqual(result.body, { plans: [] });
    } finally {
        db.close();
    }
});

// ---------------------------------------------------------------------------
// Adapter laziness — construction does not crash on a DB without the tables
// ---------------------------------------------------------------------------

test('[Unit] SqliteProjectsReadStore can be constructed against a DB without the projection tables', () => {
    // The worker-api host boots before the projection schema is
    // necessarily applied; the adapter must not crash at construction.
    const db = openDatabase(':memory:');
    try {
        assert.doesNotThrow(() => new SqliteProjectsReadStore(db));
    } finally {
        db.close();
    }
});

// ---------------------------------------------------------------------------
// HTTP wrapper — URL matching + method gate
// ---------------------------------------------------------------------------

test('[Unit] route patterns match the documented URLs', () => {
    assert.ok(PROJECTS_LIST_ROUTE_PATTERN.test('/api/projects'));
    assert.ok(PROJECTS_LIST_ROUTE_PATTERN.test('/api/projects/'));
    assert.ok(!PROJECTS_LIST_ROUTE_PATTERN.test('/api/projects/p-1'));

    const m = PROJECTS_PLANS_ROUTE_PATTERN.exec('/api/projects/p-1/plans');
    assert.ok(m);
    assert.equal(m![1], 'p-1');
    assert.ok(PROJECTS_PLANS_ROUTE_PATTERN.test('/api/projects/p-1/plans/'));
    // Must not steal `/api/projects/:pid/plans/:planId/...` — that surface
    // belongs to plan-review / decompose-status routes.
    assert.ok(
        !PROJECTS_PLANS_ROUTE_PATTERN.test(
            '/api/projects/p-1/plans/pl-1/decompose-status',
        ),
    );
});

/** Minimal in-memory ServerResponse fake. Captures status + body for assertion. */
function makeFakeRes(): {
    status?: number;
    headers?: Readonly<Record<string, string>>;
    body?: string;
    end(body?: string): void;
    writeHead(status: number, headers?: Readonly<Record<string, string>>): void;
} {
    const fake: {
        status?: number;
        headers?: Readonly<Record<string, string>>;
        body?: string;
        end(body?: string): void;
        writeHead(
            status: number,
            headers?: Readonly<Record<string, string>>,
        ): void;
    } = {
        end(body) {
            this.body = body;
        },
        writeHead(status, headers) {
            this.status = status;
            this.headers = headers;
        },
    };
    return fake;
}

test('[Unit] router handles GET /api/projects against the seeded store', () => {
    const db = makeProjectionDb();
    try {
        seedProject(db, { id: 'p-1', name: 'Pipeline', updated_at: 1000 });
        const router = createProjectsRouter({
            store: new SqliteProjectsReadStore(db),
        });

        const res = makeFakeRes();
        const claimed = router.handle(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            { url: '/api/projects', method: 'GET' } as any,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            res as any,
        );

        assert.equal(claimed, true);
        assert.equal(res.status, 200);
        const body = (JSON.parse(res.body ?? '{"projects":[]}') as {
            projects: ProjectRecord[];
        }).projects;
        assert.equal(body.length, 1);
        assert.equal(body[0].id, 'p-1');
    } finally {
        db.close();
    }
});

test('[Unit] router handles GET /api/projects/:pid/plans for an unknown pid with 200 + []', () => {
    const db = makeProjectionDb();
    try {
        const router = createProjectsRouter({
            store: new SqliteProjectsReadStore(db),
        });

        const res = makeFakeRes();
        const claimed = router.handle(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            { url: '/api/projects/p-unknown/plans', method: 'GET' } as any,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            res as any,
        );

        assert.equal(claimed, true);
        assert.equal(res.status, 200);
        assert.equal(res.body, '{"plans":[]}');
    } finally {
        db.close();
    }
});

test('[Unit] router rejects non-GET methods with 405 + Allow: GET', () => {
    const db = makeProjectionDb();
    try {
        const router = createProjectsRouter({
            store: new SqliteProjectsReadStore(db),
        });

        const res = makeFakeRes();
        router.handle(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            { url: '/api/projects', method: 'POST' } as any,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            res as any,
        );

        assert.equal(res.status, 405);
        assert.equal(res.headers?.Allow, 'GET');
    } finally {
        db.close();
    }
});

test('[Unit] router returns false for an unrelated URL so the parent can fall through', () => {
    const db = makeProjectionDb();
    try {
        const router = createProjectsRouter({
            store: new SqliteProjectsReadStore(db),
        });

        const res = makeFakeRes();
        const claimed = router.handle(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            { url: '/api/something-else', method: 'GET' } as any,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            res as any,
        );

        assert.equal(claimed, false);
        assert.equal(res.status, undefined, 'no response written');
    } finally {
        db.close();
    }
});
