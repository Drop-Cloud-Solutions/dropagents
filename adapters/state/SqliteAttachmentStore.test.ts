import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { applyMigrations } from '../../core/state/migrations';
import { SqliteAttachmentStore, type Attachment } from './SqliteAttachmentStore';

function freshDb(): Database.Database {
    const db = new Database(':memory:');
    applyMigrations(db);
    return db;
}

function make(id: string, over: Partial<Attachment> = {}): Attachment {
    return {
        id,
        ownerType: 'task',
        ownerId: 'T-1',
        fileName: `${id}.png`,
        contentType: 'image/png',
        sizeBytes: 100,
        storageKey: `ab/${id}`,
        caption: null,
        createdAt: 1,
        ...over,
    };
}

test('add then get returns the attachment', () => {
    const store = new SqliteAttachmentStore(freshDb());
    store.add(make('att-1', { caption: 'broken button' }));
    const got = store.get('att-1');
    assert.equal(got?.id, 'att-1');
    assert.equal(got?.caption, 'broken button');
    assert.equal(got?.ownerType, 'task');
});

test('listFor returns only the owner, oldest first', () => {
    const store = new SqliteAttachmentStore(freshDb());
    store.add(make('att-2', { ownerId: 'T-1', createdAt: 20 }));
    store.add(make('att-1', { ownerId: 'T-1', createdAt: 10 }));
    store.add(make('att-9', { ownerId: 'T-9', createdAt: 5 }));
    store.add(make('att-p', { ownerType: 'plan', ownerId: 'T-1', createdAt: 1 }));
    const list = store.listFor('task', 'T-1');
    assert.deepEqual(list.map((a) => a.id), ['att-1', 'att-2']);
    assert.deepEqual(store.listFor('plan', 'T-1').map((a) => a.id), ['att-p']);
});

test('remove deletes the row', () => {
    const store = new SqliteAttachmentStore(freshDb());
    store.add(make('att-1'));
    store.remove('att-1');
    assert.equal(store.get('att-1'), null);
    // removing an unknown id is a no-op (no throw).
    store.remove('nope');
});

test('add is idempotent on id (insert-or-replace)', () => {
    const store = new SqliteAttachmentStore(freshDb());
    store.add(make('att-1', { fileName: 'a.png' }));
    store.add(make('att-1', { fileName: 'b.png' }));
    assert.equal(store.get('att-1')?.fileName, 'b.png');
    assert.equal(store.listFor('task', 'T-1').length, 1);
});

// --- the requirement owner (architect tier) ---------------------------
//
// Files pinned to a REQUIREMENT are design input: the architect and the
// design-verifier read them. The owner type had to be widened for that,
// and the row mapper was the thing that made it dangerous — it read
// `owner_type === 'plan' ? 'plan' : 'task'`, so a requirement row came
// back claiming to be a task, which is both the wrong modal and the
// wrong prompt.

test('a requirement attachment survives the round trip as a requirement', () => {
    const store = new SqliteAttachmentStore(freshDb());
    store.add(make('r-1', { ownerType: 'requirement', ownerId: 'REQ-7' }));

    const got = store.get('r-1');
    assert.equal(got?.ownerType, 'requirement', 'must not come back as a task');
    assert.equal(got?.ownerId, 'REQ-7');
});

test('listFor scopes to the owner TYPE as well as the id', () => {
    // A requirement and a plan can carry the same id shape, and the two
    // lists feed different prompts.
    const store = new SqliteAttachmentStore(freshDb());
    store.add(make('a-plan', { ownerType: 'plan', ownerId: 'SAME' }));
    store.add(make('a-req', { ownerType: 'requirement', ownerId: 'SAME' }));

    assert.deepEqual(store.listFor('plan', 'SAME').map((a) => a.id), ['a-plan']);
    assert.deepEqual(store.listFor('requirement', 'SAME').map((a) => a.id), ['a-req']);
    assert.deepEqual(store.listFor('task', 'SAME'), []);
});

test('every owner type round-trips, none collapses into another', () => {
    const store = new SqliteAttachmentStore(freshDb());
    for (const ownerType of ['task', 'plan', 'requirement'] as const) {
        store.add(make(`x-${ownerType}`, { ownerType, ownerId: `O-${ownerType}` }));
    }
    for (const ownerType of ['task', 'plan', 'requirement'] as const) {
        assert.equal(
            store.get(`x-${ownerType}`)?.ownerType,
            ownerType,
            `${ownerType} must not be relabelled`,
        );
    }
});

test('an owner type the store has never heard of degrades to task', () => {
    // Forward compatibility: a row written by a newer build must still
    // read back as SOMETHING rather than crashing a board hydration.
    const db = freshDb();
    db.prepare(
        `INSERT INTO attachments
            (id, owner_type, owner_id, file_name, content_type,
             size_bytes, storage_path, caption, created_at)
         VALUES ('weird', 'epic', 'E-1', 'a.png', 'image/png', 1, 'ab/x', NULL, 1)`,
    ).run();

    assert.equal(new SqliteAttachmentStore(db).get('weird')?.ownerType, 'task');
});
