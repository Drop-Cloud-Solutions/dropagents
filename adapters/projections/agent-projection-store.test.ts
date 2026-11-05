/**
 * P-SM-002 — unit tests for the agent-projection-store subscriber.
 *
 * Trait category: Unit. Every test in this file stands up an in-memory
 * SQLite handle, applies the core migrations (which include
 * `025_agents_projection.sql`), and exercises the subscriber against a
 * real `EventBus` — no external services, no filesystem state, no spawned
 * processes. The harness is symmetric with `project-projection-store.test.ts`
 * so the two read together.
 *
 * Tests follow Arrange / Act / Assert structure: each test first builds
 * the harness and seeds any prerequisite events (Arrange), publishes the
 * event under test (Act), then asserts the resulting row state via the
 * store's `list()` port or a direct read of the `agents` table (Assert).
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
    AGENT_PROJECTION_EVENT_TYPES,
    AGENT_PROJECTION_SUBSCRIBER,
    AgentProjectionStore,
} from './agent-projection-store';

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
    // Migration 025_agents_projection.sql creates the `agents` table, so
    // applyMigrations alone is enough — no inline table needed (unlike the
    // projects test, whose schema.sql `plans` table collided with the v1
    // schema).
    const db = openDatabase(':memory:');
    applyMigrations(db);
    const store = new EventStore(db);
    const bus = new EventBus(store, new SilentLogger());
    return { db, store, bus };
}

interface AgentRow {
    readonly agent_id: string;
    readonly name: string | null;
    readonly role: string | null;
    readonly provider: string | null;
    readonly model: string | null;
    readonly prompt: string | null;
    readonly deleted_at: number | null;
    readonly updated_at: number | null;
}

function readAgent(db: Db, id: string): AgentRow | undefined {
    return db
        .prepare(
            `SELECT agent_id, name, role, provider, model, prompt, deleted_at, updated_at
               FROM agents WHERE agent_id = ?`,
        )
        .get(id) as AgentRow | undefined;
}

function countAgents(db: Db): number {
    const row = db.prepare('SELECT COUNT(*) AS c FROM agents').get() as { c: number };
    return row.c;
}

function agentCreated(
    agentId: string,
    fields: {
        name: string;
        role: string;
        provider: string;
        model: string;
        prompt?: string;
    },
    occurredAt: number,
    idempotencyKey: string = `CreateAgent:${agentId}`,
): Event {
    return {
        type: AGENT_PROJECTION_EVENT_TYPES.CREATED,
        v: 1,
        occurredAt,
        idempotencyKey,
        payload: { agentId, ...fields, actor: 'op-1' },
    };
}

function agentUpdated(
    agentId: string,
    fields: {
        name?: string;
        role?: string;
        provider?: string;
        model?: string;
        prompt?: string;
    },
    occurredAt: number,
    idempotencyKey: string = `UpdateAgent:${agentId}:${occurredAt}`,
): Event {
    return {
        type: AGENT_PROJECTION_EVENT_TYPES.UPDATED,
        v: 1,
        occurredAt,
        idempotencyKey,
        payload: { agentId, ...fields, actor: 'op-1' },
    };
}

function agentDeleted(
    agentId: string,
    occurredAt: number,
    idempotencyKey: string = `DeleteAgent:${agentId}`,
): Event {
    return {
        type: AGENT_PROJECTION_EVENT_TYPES.DELETED,
        v: 1,
        occurredAt,
        idempotencyKey,
        payload: { agentId, actor: 'op-1' },
    };
}

// ---------------------------------------------------------------------------
// Insert — AgentCreated upsert inserts a row through the SQLite handle
// ---------------------------------------------------------------------------

test('[Unit] AgentCreated inserts a row into the agents table', async () => {
    // Arrange
    const { db, bus } = makeHarness();
    try {
        new AgentProjectionStore(db, bus);

        // Act
        await bus.publish(
            agentCreated(
                'ag-1',
                {
                    name: 'Coder',
                    role: 'developer',
                    provider: 'claude-cli',
                    model: 'claude-opus-4-8',
                    prompt: 'be helpful',
                },
                1000,
            ),
        );

        // Assert
        const row = readAgent(db, 'ag-1');
        assert.ok(row, 'agents row was inserted');
        assert.equal(row!.agent_id, 'ag-1');
        assert.equal(row!.name, 'Coder');
        assert.equal(row!.role, 'developer');
        assert.equal(row!.provider, 'claude-cli');
        assert.equal(row!.model, 'claude-opus-4-8');
        assert.equal(row!.prompt, 'be helpful');
        assert.equal(row!.deleted_at, null);
        assert.equal(row!.updated_at, 1000);
    } finally {
        db.close();
    }
});

// ---------------------------------------------------------------------------
// Update — mutates the existing row; omitted fields are preserved
// ---------------------------------------------------------------------------

test('[Unit] AgentUpdated mutates the existing row in place', async () => {
    // Arrange
    const { db, bus } = makeHarness();
    try {
        new AgentProjectionStore(db, bus);
        await bus.publish(
            agentCreated(
                'ag-1',
                { name: 'Coder', role: 'developer', provider: 'claude-cli', model: 'm1' },
                1000,
            ),
        );

        // Act — newer event renames the agent and swaps the model
        await bus.publish(
            agentUpdated('ag-1', { name: 'Coder v2', model: 'm2' }, 2000),
        );

        // Assert
        const row = readAgent(db, 'ag-1');
        assert.ok(row, 'agents row still exists');
        assert.equal(row!.name, 'Coder v2');
        assert.equal(row!.model, 'm2');
        assert.equal(row!.updated_at, 2000);
        assert.equal(row!.deleted_at, null);
        assert.equal(countAgents(db), 1, 'no duplicate row was inserted');
    } finally {
        db.close();
    }
});

test('[Unit] AgentUpdated without a field preserves the existing value', async () => {
    // Arrange — Update payloads omit fields the operator did not touch;
    // the projection must not overwrite a stored column with NULL.
    const { db, bus } = makeHarness();
    try {
        new AgentProjectionStore(db, bus);
        await bus.publish(
            agentCreated(
                'ag-1',
                {
                    name: 'Coder',
                    role: 'developer',
                    provider: 'claude-cli',
                    model: 'm1',
                    prompt: 'original prompt',
                },
                1000,
            ),
        );

        // Act — update only the model; every other field is omitted
        await bus.publish(agentUpdated('ag-1', { model: 'm2' }, 2000));

        // Assert — omitted fields survive, model changes, timestamp advances
        const row = readAgent(db, 'ag-1');
        assert.equal(row!.name, 'Coder', 'name preserved when not in payload');
        assert.equal(row!.role, 'developer', 'role preserved when not in payload');
        assert.equal(row!.provider, 'claude-cli', 'provider preserved when not in payload');
        assert.equal(row!.prompt, 'original prompt', 'prompt preserved when not in payload');
        assert.equal(row!.model, 'm2', 'model updated');
        assert.equal(row!.updated_at, 2000);
    } finally {
        db.close();
    }
});

// ---------------------------------------------------------------------------
// Delete — AgentDeleted stamps deleted_at without removing the row
// ---------------------------------------------------------------------------

test('[Unit] AgentDeleted stamps deleted_at and keeps the row (hard-delete semantics)', async () => {
    // Arrange
    const { db, bus } = makeHarness();
    try {
        new AgentProjectionStore(db, bus);
        await bus.publish(
            agentCreated(
                'ag-1',
                { name: 'Coder', role: 'developer', provider: 'claude-cli', model: 'm1' },
                1000,
            ),
        );

        // Act
        await bus.publish(agentDeleted('ag-1', 3000));

        // Assert
        const row = readAgent(db, 'ag-1');
        assert.ok(row, 'row is NOT physically removed');
        assert.equal(row!.deleted_at, 3000, 'deleted_at equals event.occurredAt');
        assert.equal(row!.name, 'Coder', 'unrelated columns are unchanged');
        assert.equal(countAgents(db), 1);
    } finally {
        db.close();
    }
});

// ---------------------------------------------------------------------------
// Idempotent replay — updated_at does not move backwards
// ---------------------------------------------------------------------------

test('[Unit] republishing the same AgentCreated is a no-op (idempotent)', async () => {
    // Arrange
    const { db, bus } = makeHarness();
    try {
        new AgentProjectionStore(db, bus);
        const event = agentCreated(
            'ag-1',
            { name: 'Coder', role: 'developer', provider: 'claude-cli', model: 'm1' },
            1000,
        );

        // Act — same idempotency key, fired twice
        await bus.publish(event);
        await bus.publish(event);

        // Assert: a single row, with updated_at unchanged.
        assert.equal(countAgents(db), 1, 'no duplicate row from replay');
        const row = readAgent(db, 'ag-1');
        assert.equal(
            row!.updated_at,
            1000,
            'updated_at does not move on replay of the same event',
        );
    } finally {
        db.close();
    }
});

test('[Unit] a stale AgentUpdated never moves updated_at backwards', async () => {
    // Arrange — newer event lands first; an older replay must not
    // overwrite the fresher state.
    const { db, bus } = makeHarness();
    try {
        new AgentProjectionStore(db, bus);
        await bus.publish(
            agentCreated(
                'ag-1',
                { name: 'Coder', role: 'developer', provider: 'claude-cli', model: 'm1' },
                2000,
            ),
        );

        // Act — same agentId, OLDER occurredAt, different idempotencyKey
        await bus.publish(
            agentUpdated('ag-1', { name: 'Stale Name' }, 1500, 'UpdateAgent:ag-1:stale'),
        );

        // Assert
        const row = readAgent(db, 'ag-1');
        assert.equal(row!.name, 'Coder', 'newer name retained');
        assert.equal(row!.updated_at, 2000, 'updated_at did not move backwards');
    } finally {
        db.close();
    }
});

test('[Unit] replaying AgentDeleted does not move deleted_at backwards', async () => {
    // Arrange
    const { db, bus } = makeHarness();
    try {
        new AgentProjectionStore(db, bus);
        await bus.publish(
            agentCreated(
                'ag-1',
                { name: 'Coder', role: 'developer', provider: 'claude-cli', model: 'm1' },
                1000,
            ),
        );
        await bus.publish(agentDeleted('ag-1', 3000));

        // Act — replay the same delete event
        await bus.publish(agentDeleted('ag-1', 3000));

        // Assert
        const row = readAgent(db, 'ag-1');
        assert.equal(row!.deleted_at, 3000);
        assert.equal(row!.updated_at, 3000);
        assert.equal(countAgents(db), 1);
    } finally {
        db.close();
    }
});

// ---------------------------------------------------------------------------
// list() — returns only active rows, ordered by name
// ---------------------------------------------------------------------------

test('[Unit] list() returns only active rows, ordered by name', async () => {
    // Arrange
    const { db, bus } = makeHarness();
    try {
        const projection = new AgentProjectionStore(db, bus);
        await bus.publish(
            agentCreated(
                'ag-z',
                { name: 'Zeta', role: 'reviewer', provider: 'claude-cli', model: 'm1' },
                1000,
            ),
        );
        await bus.publish(
            agentCreated(
                'ag-a',
                { name: 'Alpha', role: 'developer', provider: 'claude-cli', model: 'm2' },
                1100,
            ),
        );
        await bus.publish(
            agentCreated(
                'ag-d',
                { name: 'Deleted One', role: 'tester', provider: 'claude-cli', model: 'm3' },
                1200,
            ),
        );

        // Act — remove one agent, then list
        await bus.publish(agentDeleted('ag-d', 2000));
        const rows = projection.list();

        // Assert — active rows only, alphabetised by name
        assert.equal(rows.length, 2, 'deleted agent is excluded');
        assert.deepEqual(
            rows.map((r) => r.name),
            ['Alpha', 'Zeta'],
            'rows are ordered by name',
        );
        const alpha = rows[0];
        assert.deepEqual(alpha, {
            agentId: 'ag-a',
            name: 'Alpha',
            role: 'developer',
            provider: 'claude-cli',
            model: 'm2',
            prompt: null,
            // updatedAt is exposed so the operator UI can tell which record
            // wins when a role has duplicates (resolver: newest wins).
            updatedAt: 1100,
        });
    } finally {
        db.close();
    }
});

// ---------------------------------------------------------------------------
// Constructor registers subscribers — replayMissed delivers events
// ---------------------------------------------------------------------------

test('[Unit] constructor registers the subscriber against all three event types', async () => {
    // Arrange — append events to the store BEFORE the projection exists,
    // so the bus has no subscriber to deliver them to yet. The projection
    // should pick them up only after `replayMissed`, proving the
    // subscription names matched and the offset path is wired through.
    const { db, store, bus } = makeHarness();
    try {
        store.append(
            agentCreated(
                'ag-1',
                { name: 'Coder', role: 'developer', provider: 'claude-cli', model: 'm1' },
                1000,
            ),
        );
        store.append(agentUpdated('ag-1', { name: 'Coder v2' }, 2000));
        store.append(agentDeleted('ag-1', 3000));

        // Act — construct the projection (wires three subscriptions), then
        // replay missed events.
        const projection = new AgentProjectionStore(db, bus);
        await bus.replayMissed(AGENT_PROJECTION_SUBSCRIBER);

        // Assert: all three handlers ran in order against the projection's
        // SQLite handle — the agent ends up renamed then deleted.
        const row = readAgent(db, 'ag-1');
        assert.ok(row, 'replay delivered events to the constructor-registered handlers');
        assert.equal(row!.name, 'Coder v2');
        assert.equal(row!.deleted_at, 3000);
        assert.equal(row!.updated_at, 3000);
        assert.equal(projection.list().length, 0, 'deleted agent is not listed');
    } finally {
        db.close();
    }
});
