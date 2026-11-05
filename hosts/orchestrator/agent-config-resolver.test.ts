import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { applyMigrations, openDatabase, type Db } from '../../core/state/migrations';
import { AgentConfigResolver } from './agent-config-resolver';

function seedAgent(
    db: Db,
    row: { agentId: string; role: string; provider?: string; model?: string; prompt?: string; deletedAt?: number; updatedAt?: number },
): void {
    db.prepare(
        `INSERT INTO agents(agent_id, name, role, provider, model, prompt, deleted_at, updated_at)
         VALUES (@agentId, @name, @role, @provider, @model, @prompt, @deletedAt, @updatedAt)`,
    ).run({
        agentId: row.agentId,
        name: row.agentId,
        role: row.role,
        provider: row.provider ?? null,
        model: row.model ?? null,
        prompt: row.prompt ?? null,
        deletedAt: row.deletedAt ?? null,
        updatedAt: row.updatedAt ?? 1,
    });
}

function freshDb(): Db {
    const db = openDatabase(':memory:');
    applyMigrations(db);
    return db;
}

test('resolves model / provider / prompt for a configured role', () => {
    const db = freshDb();
    seedAgent(db, {
        agentId: 'a1', role: 'reviewer', provider: 'deepseek',
        model: 'claude-sonnet-5', prompt: 'Be terse.',
    });
    const r = new AgentConfigResolver(db);
    assert.equal(r.model('reviewer'), 'claude-sonnet-5');
    assert.equal(r.provider('reviewer'), 'deepseek');
    assert.equal(r.prompt('reviewer'), 'Be terse.');
    const cfg = r.get('reviewer');
    assert.equal(cfg?.model, 'claude-sonnet-5');
});

test('returns undefined/null for a role with no agent', () => {
    const r = new AgentConfigResolver(freshDb());
    assert.equal(r.model('developer'), undefined);
    assert.equal(r.get('developer'), null);
    assert.equal(r.model(''), undefined);
});

test('excludes soft-deleted rows', () => {
    const db = freshDb();
    seedAgent(db, { agentId: 'a1', role: 'tester', model: 'claude-haiku-4-5', deletedAt: 123 });
    const r = new AgentConfigResolver(db);
    assert.equal(r.model('tester'), undefined);
    assert.equal(r.get('tester'), null);
});

test('newest (max updated_at) wins when a role has duplicates', () => {
    const db = freshDb();
    seedAgent(db, { agentId: 'old', role: 'planner', model: 'claude-opus-4-7', updatedAt: 10 });
    seedAgent(db, { agentId: 'new', role: 'planner', model: 'claude-opus-4-8', updatedAt: 20 });
    const r = new AgentConfigResolver(db);
    assert.equal(r.model('planner'), 'claude-opus-4-8');
});

test('empty model column is treated as no override', () => {
    const db = freshDb();
    seedAgent(db, { agentId: 'a1', role: 'developer', provider: 'claude-cli' });
    const r = new AgentConfigResolver(db);
    assert.equal(r.model('developer'), undefined);
    assert.equal(r.provider('developer'), 'claude-cli');
});
