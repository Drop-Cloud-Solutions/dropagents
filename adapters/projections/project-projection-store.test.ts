/**
 * AP-FP-002 — unit tests for the project-projection-store subscriber.
 *
 * Trait category: Unit. Every test in this file stands up an in-memory
 * SQLite handle, applies the core + projection schemas, and exercises
 * the subscriber against a real `EventBus` — no external services, no
 * filesystem state, no spawned processes. The harness is symmetric
 * with `task-projection-store.test.ts` so the two read together.
 *
 * Tests follow Arrange / Act / Assert structure: each test first
 * builds the harness and seeds any prerequisite events (Arrange),
 * publishes the event under test (Act), then asserts the resulting
 * row state in the `projects` table (Assert).
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import {
    applyMigrations,
    openDatabase,
    type Db,
} from '../../core/state/migrations';
import { EventBus } from '../../core/events/bus';
import { EventStore } from '../../core/events/store';
import type { Event } from '../../core/events/event';
import type { Logger } from '../../core/ports/Logger';
import {
    PROJECT_PROJECTION_EVENT_TYPES,
    PROJECT_PROJECTION_SUBSCRIBER,
    ProjectProjectionStore,
} from './project-projection-store';

/**
 * Create just the `projects` columns the projection touches. Inlined
 * rather than loading `adapters/projections/schema.sql` because that
 * file (AP-FP-001) also declares a `plans` table that collides with
 * the v1 `plans` table from `core/state/migrations/001_initial.sql`
 * when the projection schema is applied against the same handle. The
 * tests here exercise the project lifecycle only, so they need just
 * this one table — keeping the harness narrow side-steps the AP-FP-001
 * schema clash and stays readable.
 */
function createProjectsTable(db: Db): void {
    db.exec(`
        CREATE TABLE IF NOT EXISTS projects (
            id                   TEXT    NOT NULL PRIMARY KEY,
            name                 TEXT,
            linear_initiative_id TEXT,
            metadata             TEXT,
            archived_at          INTEGER,
            updated_at           INTEGER
        );
    `);
}

class SilentLogger implements Logger {
    info(): void {}
    warn(): void {}
    debug(): void {}
    error(): void {}
}

interface Harness {
    readonly db: Db;
    readonly store: EventStore;
    readonly bus: EventBus;
}

function makeHarness(): Harness {
    const db = openDatabase(':memory:');
    applyMigrations(db);
    createProjectsTable(db);
    const store = new EventStore(db);
    const bus = new EventBus(store, new SilentLogger());
    return { db, store, bus };
}

interface ProjectRow {
    readonly id: string;
    readonly name: string | null;
    readonly archived_at: number | null;
    readonly updated_at: number | null;
}

function readProject(db: Db, id: string): ProjectRow | undefined {
    return db
        .prepare(
            'SELECT id, name, archived_at, updated_at FROM projects WHERE id = ?',
        )
        .get(id) as ProjectRow | undefined;
}

function countProjects(db: Db): number {
    const row = db
        .prepare('SELECT COUNT(*) AS c FROM projects')
        .get() as { c: number };
    return row.c;
}

function projectCreated(
    projectId: string,
    name: string,
    occurredAt: number,
    idempotencyKey: string = `CreateProject:${projectId}`,
): Event {
    return {
        type: PROJECT_PROJECTION_EVENT_TYPES.CREATED,
        v: 1,
        occurredAt,
        idempotencyKey,
        payload: { projectId, name, actor: 'op-1' },
    };
}

function projectUpdated(
    projectId: string,
    name: string | undefined,
    occurredAt: number,
    idempotencyKey: string = `UpdateProject:${projectId}:${occurredAt}`,
): Event {
    return {
        type: PROJECT_PROJECTION_EVENT_TYPES.UPDATED,
        v: 1,
        occurredAt,
        idempotencyKey,
        payload: { projectId, name, actor: 'op-1' },
    };
}

function projectArchived(
    projectId: string,
    occurredAt: number,
    idempotencyKey: string = `ArchiveProject:${projectId}`,
): Event {
    return {
        type: PROJECT_PROJECTION_EVENT_TYPES.ARCHIVED,
        v: 1,
        occurredAt,
        idempotencyKey,
        payload: { projectId, actor: 'op-1' },
    };
}

// ---------------------------------------------------------------------------
// AC #1, #2, #5 — Created upsert inserts a row through the SQLite handle
// ---------------------------------------------------------------------------

test('[Unit] ProjectCreated inserts a row into the projects table', async () => {
    // Arrange
    const { db, bus } = makeHarness();
    try {
        new ProjectProjectionStore(db, bus);

        // Act
        await bus.publish(projectCreated('p-1', 'Pipeline', 1000));

        // Assert
        const row = readProject(db, 'p-1');
        assert.ok(row, 'projects row was inserted');
        assert.equal(row!.id, 'p-1');
        assert.equal(row!.name, 'Pipeline');
        assert.equal(row!.archived_at, null);
        assert.equal(row!.updated_at, 1000);
    } finally {
        db.close();
    }
});

// ---------------------------------------------------------------------------
// AC #2, #3 — Updated upsert mutates the existing row
// ---------------------------------------------------------------------------

test('[Unit] ProjectUpdated mutates the existing row in place', async () => {
    // Arrange
    const { db, bus } = makeHarness();
    try {
        new ProjectProjectionStore(db, bus);
        await bus.publish(projectCreated('p-1', 'Pipeline', 1000));

        // Act — newer event with a renamed project
        await bus.publish(projectUpdated('p-1', 'Pipeline v2', 2000));

        // Assert
        const row = readProject(db, 'p-1');
        assert.ok(row, 'projects row still exists');
        assert.equal(row!.name, 'Pipeline v2');
        assert.equal(row!.updated_at, 2000);
        assert.equal(row!.archived_at, null);
        assert.equal(countProjects(db), 1, 'no duplicate row was inserted');
    } finally {
        db.close();
    }
});

test('[Unit] ProjectUpdated without a name preserves the existing name', async () => {
    // Arrange — Update payloads omit `name` when the operator edited
    // only the description; the projection must not overwrite the
    // stored name with NULL in that case.
    const { db, bus } = makeHarness();
    try {
        new ProjectProjectionStore(db, bus);
        await bus.publish(projectCreated('p-1', 'Pipeline', 1000));

        // Act
        await bus.publish(projectUpdated('p-1', undefined, 2000));

        // Assert
        const row = readProject(db, 'p-1');
        assert.equal(row!.name, 'Pipeline', 'name preserved when not in payload');
        assert.equal(row!.updated_at, 2000);
    } finally {
        db.close();
    }
});

// ---------------------------------------------------------------------------
// AC #4 — Archived path sets archived_at without deleting the row
// ---------------------------------------------------------------------------

test('[Unit] ProjectArchived stamps archived_at and leaves the row intact (soft delete)', async () => {
    // Arrange
    const { db, bus } = makeHarness();
    try {
        new ProjectProjectionStore(db, bus);
        await bus.publish(projectCreated('p-1', 'Pipeline', 1000));

        // Act
        await bus.publish(projectArchived('p-1', 3000));

        // Assert
        const row = readProject(db, 'p-1');
        assert.ok(row, 'row is NOT hard-deleted');
        assert.equal(row!.archived_at, 3000, 'archived_at equals event.occurredAt');
        assert.equal(row!.name, 'Pipeline', 'unrelated columns are unchanged');
        assert.equal(countProjects(db), 1);
    } finally {
        db.close();
    }
});

// ---------------------------------------------------------------------------
// AC #3 — re-applying the same event is a no-op (idempotency)
// ---------------------------------------------------------------------------

test('[Unit] republishing the same ProjectCreated is a no-op (idempotent)', async () => {
    // Arrange
    const { db, bus } = makeHarness();
    try {
        new ProjectProjectionStore(db, bus);
        const event = projectCreated('p-1', 'Pipeline', 1000);

        // Act — same idempotency key, fired twice
        await bus.publish(event);
        await bus.publish(event);

        // Assert: a single row, with updated_at unchanged.
        assert.equal(countProjects(db), 1, 'no duplicate row from replay');
        const row = readProject(db, 'p-1');
        assert.equal(
            row!.updated_at,
            1000,
            'updated_at does not move on replay of the same event',
        );
    } finally {
        db.close();
    }
});

test('[Unit] a stale ProjectUpdated never moves updated_at backwards', async () => {
    // Arrange — newer event lands first; an older replay must not
    // overwrite the fresher state.
    const { db, bus } = makeHarness();
    try {
        new ProjectProjectionStore(db, bus);
        await bus.publish(projectCreated('p-1', 'Pipeline', 2000));

        // Act — same projectId, OLDER occurredAt, different idempotencyKey
        await bus.publish(
            projectUpdated('p-1', 'Stale Name', 1500, 'UpdateProject:p-1:stale'),
        );

        // Assert
        const row = readProject(db, 'p-1');
        assert.equal(row!.name, 'Pipeline', 'newer name retained');
        assert.equal(row!.updated_at, 2000, 'updated_at did not move backwards');
    } finally {
        db.close();
    }
});

test('[Unit] replaying ProjectArchived does not move archived_at backwards', async () => {
    // Arrange
    const { db, bus } = makeHarness();
    try {
        new ProjectProjectionStore(db, bus);
        await bus.publish(projectCreated('p-1', 'Pipeline', 1000));
        await bus.publish(projectArchived('p-1', 3000));

        // Act — replay the same archive event
        await bus.publish(projectArchived('p-1', 3000));

        // Assert
        const row = readProject(db, 'p-1');
        assert.equal(row!.archived_at, 3000);
        assert.equal(row!.updated_at, 3000);
        assert.equal(countProjects(db), 1);
    } finally {
        db.close();
    }
});

// ---------------------------------------------------------------------------
// AC #6 — subscriber registers against the event bus on construction
// ---------------------------------------------------------------------------

test('[Unit] constructor registers the subscriber against all three event types', async () => {
    // Arrange — build a fresh harness, then *post-bus*, append events
    // BEFORE the projection exists. The projection should pick them
    // up only after `replayMissed` is called, proving the subscription
    // names matched and the offset path is wired through to the bus.
    const { db, store, bus } = makeHarness();
    try {
        // Persist events directly via the store so the bus does not
        // deliver them yet — there are no subscribers at this point.
        store.append(projectCreated('p-1', 'Pipeline', 1000));
        store.append(projectUpdated('p-1', 'Pipeline v2', 2000));
        store.append(projectArchived('p-1', 3000));

        // Act — construct the projection; it wires the three
        // subscriptions on the bus. Then replay missed events.
        new ProjectProjectionStore(db, bus);
        await bus.replayMissed(PROJECT_PROJECTION_SUBSCRIBER);

        // Assert: all three event handlers ran in order against the
        // projection's SQLite handle.
        const row = readProject(db, 'p-1');
        assert.ok(row, 'replay delivered events to the constructor-registered handlers');
        assert.equal(row!.name, 'Pipeline v2');
        assert.equal(row!.archived_at, 3000);
        assert.equal(row!.updated_at, 3000);
    } finally {
        db.close();
    }
});

// ---------------------------------------------------------------------------
// Approval overrides on the project row
//
// Project config is worker state now, so per-flow approval policy lives on
// the row the registry reads instead of `config/projects/<id>/project.json`
// — a file that only existed for projects created through the manager-api.
// ---------------------------------------------------------------------------

test('ProjectUpdated REPLACES metadata — a partial blob deletes the rest', async () => {
    // The sharp edge behind the sibling test above, pinned from the
    // other side. `metadata = COALESCE(excluded.metadata, projects.metadata)`
    // only preserves the stored blob when the event carries NONE; any
    // blob that arrives wins whole.
    //
    // Field bug this exists to stop recurring: the board's chat
    // project-update built `{...existing?.metadata, description}` from a
    // `ProjectRow` that had no `metadata` field at all, so the spread
    // contributed nothing and the PATCH carried `{ description }` alone.
    // Accepting a one-line description change from chat therefore wiped
    // the project's abbr, colour, declared repos and approval overrides.
    // It went unseen because board.ts was excluded from tsconfig.
    const h = makeHarness();
    new ProjectProjectionStore(h.db, h.bus);

    await h.bus.publish({
        type: PROJECT_PROJECTION_EVENT_TYPES.CREATED,
        v: 1,
        occurredAt: 10,
        idempotencyKey: 'created-replace',
        payload: {
            projectId: 'p-replace',
            name: 'P',
            metadata: { abbr: 'P', color: '#333', repos: [{ id: 'r1' }] },
        },
    });
    await h.bus.publish({
        type: PROJECT_PROJECTION_EVENT_TYPES.UPDATED,
        v: 1,
        occurredAt: 20,
        idempotencyKey: 'updated-replace',
        payload: {
            projectId: 'p-replace',
            metadata: { description: 'just the description' },
        },
    });

    const row = h.db
        .prepare('SELECT metadata FROM projects WHERE id = ?')
        .get('p-replace') as { metadata: string };
    const meta = JSON.parse(row.metadata) as Record<string, unknown>;

    assert.equal(meta.description, 'just the description');
    // Documenting the behaviour, NOT endorsing it: every writer of this
    // event must send the whole blob it wants to keep.
    assert.equal(meta.abbr, undefined, 'a partial blob really does drop siblings');
    assert.equal(meta.repos, undefined);
});

test('ProjectApprovalOverrideUpdated MERGES into metadata, keeping the rest', async () => {
    // The killer case: the identity upsert REPLACES the blob, so reusing
    // it here would silently drop abbr / color / repos.
    const h = makeHarness();
    new ProjectProjectionStore(h.db, h.bus);

    await h.bus.publish({
        type: PROJECT_PROJECTION_EVENT_TYPES.CREATED,
        v: 1,
        occurredAt: 10,
        idempotencyKey: 'created',
        payload: {
            projectId: 'p1',
            name: 'P1',
            metadata: { abbr: 'P1', color: '#333', repos: [{ id: 'r1' }] },
        },
    });
    await h.bus.publish({
        type: PROJECT_PROJECTION_EVENT_TYPES.APPROVAL_OVERRIDE_UPDATED,
        v: 1,
        occurredAt: 20,
        idempotencyKey: 'override',
        payload: {
            projectId: 'p1',
            approvalOverride: { implement: { develop: 'auto' } },
        },
    });

    const row = h.db
        .prepare('SELECT metadata FROM projects WHERE id = ?')
        .get('p1') as { metadata: string };
    const meta = JSON.parse(row.metadata) as Record<string, unknown>;
    assert.deepEqual(meta.approvalOverride, { implement: { develop: 'auto' } });
    assert.equal(meta.abbr, 'P1', 'sibling metadata must survive the merge');
    assert.equal(meta.color, '#333');
    assert.deepEqual(meta.repos, [{ id: 'r1' }]);
});

test('an override on a project with no metadata yet creates the key', async () => {
    const h = makeHarness();
    new ProjectProjectionStore(h.db, h.bus);
    h.db.prepare(
        `INSERT INTO projects(id, name, metadata, archived_at, updated_at)
         VALUES ('p2', 'P2', NULL, NULL, 1)`,
    ).run();

    await h.bus.publish({
        type: PROJECT_PROJECTION_EVENT_TYPES.APPROVAL_OVERRIDE_UPDATED,
        v: 1,
        occurredAt: 5,
        idempotencyKey: 'override-2',
        payload: { projectId: 'p2', approvalOverride: { echo: { run: 'required' } } },
    });

    const row = h.db
        .prepare('SELECT metadata FROM projects WHERE id = ?')
        .get('p2') as { metadata: string };
    assert.deepEqual(JSON.parse(row.metadata), {
        approvalOverride: { echo: { run: 'required' } },
    });
});

test('a later override replaces the earlier one', async () => {
    // Not monotonic-by-timestamp like the identity events: two overrides
    // set seconds apart are both legitimate and the last one is intent.
    const h = makeHarness();
    new ProjectProjectionStore(h.db, h.bus);
    h.db.prepare(
        `INSERT INTO projects(id, name, metadata, archived_at, updated_at)
         VALUES ('p3', 'P3', '{}', NULL, 100)`,
    ).run();

    for (const [seq, value] of [['a', 'auto'], ['b', 'required']] as const) {
        await h.bus.publish({
            type: PROJECT_PROJECTION_EVENT_TYPES.APPROVAL_OVERRIDE_UPDATED,
            v: 1,
            occurredAt: 1,
            idempotencyKey: `override-${seq}`,
            payload: { projectId: 'p3', approvalOverride: { implement: { develop: value } } },
        });
    }

    const row = h.db
        .prepare('SELECT metadata FROM projects WHERE id = ?')
        .get('p3') as { metadata: string };
    assert.deepEqual(JSON.parse(row.metadata), {
        approvalOverride: { implement: { develop: 'required' } },
    });
});

test('an override for an unknown project is a no-op, not a crash', async () => {
    const h = makeHarness();
    new ProjectProjectionStore(h.db, h.bus);
    await h.bus.publish({
        type: PROJECT_PROJECTION_EVENT_TYPES.APPROVAL_OVERRIDE_UPDATED,
        v: 1,
        occurredAt: 1,
        idempotencyKey: 'override-orphan',
        payload: { projectId: 'ghost', approvalOverride: { a: { b: 'auto' } } },
    });
    const count = h.db
        .prepare('SELECT COUNT(*) AS n FROM projects')
        .get() as { n: number };
    assert.equal(count.n, 0);
});
