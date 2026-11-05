/**
 * Tests that adapters/projections/schema.sql includes the `agents` table
 * (added by task P-SM-001 alongside migration 025_agents_projection.sql).
 *
 * These tests load schema.sql against a bare in-memory SQLite database —
 * no core migration runner — so they prove that a projection DB stood up
 * from this file alone (the pattern used in production when the projection
 * store initialises) gets the agents table, mirroring how `projects` is
 * already covered by the same file.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';

const SCHEMA_PATH = path.join(__dirname, 'schema.sql');
const SCHEMA_SQL = fs.readFileSync(SCHEMA_PATH, 'utf8');

function freshDb(): Database.Database {
    return new Database(':memory:');
}

function listTables(db: Database.Database): string[] {
    return (
        db
            .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
            .all() as { name: string }[]
    ).map((r) => r.name);
}

type ColInfo = { name: string; type: string; notnull: number; pk: number };

function tableColumns(db: Database.Database, table: string): ColInfo[] {
    return db.prepare(`PRAGMA table_info('${table}')`).all() as ColInfo[];
}

// ---------------------------------------------------------------------------
// Table existence
// ---------------------------------------------------------------------------

test('[Unit] schema.sql creates the agents table in a fresh projection DB', () => {
    const db = freshDb();
    try {
        db.exec(SCHEMA_SQL);
        const tables = listTables(db);
        assert.ok(
            tables.includes('agents'),
            `expected "agents" table after loading schema.sql, got: ${tables.join(', ')}`,
        );
    } finally {
        db.close();
    }
});

// ---------------------------------------------------------------------------
// Column schema
// ---------------------------------------------------------------------------

test('[Unit] agents table from schema.sql has the correct column names', () => {
    const db = freshDb();
    try {
        db.exec(SCHEMA_SQL);
        const cols = tableColumns(db, 'agents');
        const names = cols.map((c) => c.name).sort();
        assert.deepEqual(
            names,
            ['agent_id', 'deleted_at', 'model', 'name', 'prompt', 'provider', 'role', 'updated_at'],
            `unexpected agents columns: ${names.join(',')}`,
        );
    } finally {
        db.close();
    }
});

test('[Unit] agents.agent_id is NOT NULL TEXT PRIMARY KEY', () => {
    const db = freshDb();
    try {
        db.exec(SCHEMA_SQL);
        const cols = tableColumns(db, 'agents');
        const col = cols.find((c) => c.name === 'agent_id')!;
        assert.ok(col, 'agent_id column must exist');
        assert.equal(col.notnull, 1, 'agent_id must be NOT NULL');
        assert.equal(col.pk, 1, 'agent_id must be PRIMARY KEY');
        assert.match(col.type.toUpperCase(), /TEXT/, 'agent_id must be TEXT');
    } finally {
        db.close();
    }
});

test('[Unit] agents.deleted_at is nullable INTEGER (NULL while active)', () => {
    const db = freshDb();
    try {
        db.exec(SCHEMA_SQL);
        const cols = tableColumns(db, 'agents');
        const col = cols.find((c) => c.name === 'deleted_at')!;
        assert.ok(col, 'deleted_at column must exist');
        assert.equal(col.notnull, 0, 'deleted_at must be nullable');
        assert.match(col.type.toUpperCase(), /INTEGER/, 'deleted_at must be INTEGER');
    } finally {
        db.close();
    }
});

// ---------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------

test('[Unit] schema.sql creates idx_agents_active index on agents(deleted_at)', () => {
    const db = freshDb();
    try {
        db.exec(SCHEMA_SQL);
        const indexes = db
            .prepare("PRAGMA index_list('agents')")
            .all() as { name: string }[];
        const hasActiveIndex = indexes.some((ix) => {
            const icols = db
                .prepare(`PRAGMA index_info('${ix.name}')`)
                .all() as { name: string }[];
            return icols.some((c) => c.name === 'deleted_at');
        });
        assert.ok(
            hasActiveIndex,
            'expected an index covering agents(deleted_at) — idx_agents_active',
        );
    } finally {
        db.close();
    }
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

test('[Unit] schema.sql is idempotent — exec twice does not throw', () => {
    const db = freshDb();
    try {
        db.exec(SCHEMA_SQL);
        assert.doesNotThrow(
            () => db.exec(SCHEMA_SQL),
            'second exec of schema.sql must be a no-op (CREATE IF NOT EXISTS)',
        );
    } finally {
        db.close();
    }
});

test('[Unit] schema.sql idempotency preserves existing agents rows', () => {
    const db = freshDb();
    try {
        db.exec(SCHEMA_SQL);
        db.prepare(
            'INSERT INTO agents(agent_id, name, role, deleted_at, updated_at) VALUES (?, ?, ?, ?, ?)',
        ).run('ag-1', 'Coder', 'developer', null, 1_700_000_000_000);

        db.exec(SCHEMA_SQL); // second apply

        const row = db
            .prepare("SELECT agent_id, name FROM agents WHERE agent_id = 'ag-1'")
            .get() as { agent_id: string; name: string } | undefined;
        assert.ok(row, 'seeded row must survive second schema.sql exec');
        assert.equal(row!.name, 'Coder');
    } finally {
        db.close();
    }
});
