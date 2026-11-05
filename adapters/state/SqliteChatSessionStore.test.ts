import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { openDatabase, applyMigrations, Db } from '../../core/state/migrations';
import { SqliteChatSessionStore } from './SqliteChatSessionStore';

function freshDb(): Db {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-store-'));
    const db = openDatabase(path.join(dir, 'state.db'));
    applyMigrations(db);
    return db;
}

test('createSession + getSession round-trips a read-only session', () => {
    const db = freshDb();
    try {
        const store = new SqliteChatSessionStore(db);
        const s = store.createSession({
            id: 'chat-1',
            projectId: 'P1',
            repoId: 'repo-a',
            cwd: 'C:/clone',
            title: null,
            mode: 'read-only',
            branch: null,
            now: 100,
        });
        assert.equal(s.mode, 'read-only');
        const fetched = store.getSession('chat-1');
        assert.equal(fetched?.projectId, 'P1');
        assert.equal(fetched?.cwd, 'C:/clone');
    } finally {
        db.close();
    }
});

test('appendMessage persists role + metadata, including system notes', () => {
    const db = freshDb();
    try {
        const store = new SqliteChatSessionStore(db);
        store.createSession({
            id: 'chat-1', projectId: 'P1', repoId: null, cwd: 'x',
            title: null, mode: 'read-only', branch: null, now: 1,
        });
        store.appendMessage({ sessionId: 'chat-1', role: 'user', body: 'hi', now: 2 });
        store.appendMessage({
            sessionId: 'chat-1',
            role: 'system',
            body: 'T-1 is ready to merge.',
            metadata: { action: { kind: 'merge', taskId: 'T-1', label: 'Merge PR' } },
            now: 3,
        });
        const msgs = store.listMessages('chat-1');
        assert.equal(msgs.length, 2);
        assert.equal(msgs[1].role, 'system');
        assert.deepEqual(msgs[1].metadata?.action, {
            kind: 'merge', taskId: 'T-1', label: 'Merge PR',
        });
    } finally {
        db.close();
    }
});

test('linkPlan + listPlanLinks persists the plan→session link', () => {
    const db = freshDb();
    try {
        const store = new SqliteChatSessionStore(db);
        store.linkPlan('plan-a', 'chat-1', 10);
        store.linkPlan('plan-b', 'chat-2', 20);
        const links = store.listPlanLinks();
        // Ordered most-recent-first (created_at DESC).
        assert.deepEqual(links, [
            { planId: 'plan-b', sessionId: 'chat-2' },
            { planId: 'plan-a', sessionId: 'chat-1' },
        ]);
    } finally {
        db.close();
    }
});

test('linkPlan is idempotent: re-linking a plan overwrites the session', () => {
    const db = freshDb();
    try {
        const store = new SqliteChatSessionStore(db);
        store.linkPlan('plan-a', 'chat-1', 10);
        store.linkPlan('plan-a', 'chat-2', 30);
        const links = store.listPlanLinks();
        assert.equal(links.length, 1);
        assert.deepEqual(links[0], { planId: 'plan-a', sessionId: 'chat-2' });
    } finally {
        db.close();
    }
});
