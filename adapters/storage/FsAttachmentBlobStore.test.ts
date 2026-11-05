import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { FsAttachmentBlobStore } from './FsAttachmentBlobStore';

function tmpRoot(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'attach-blob-'));
}

test('put then get round-trips the exact bytes', async () => {
    const store = new FsAttachmentBlobStore(tmpRoot());
    const bytes = Buffer.from([0, 1, 2, 250, 255, 128]);
    const key = await store.put('att-abc123', bytes);
    const read = await store.get(key);
    assert.deepEqual(read, bytes);
});

test('delete removes the blob and is idempotent', async () => {
    const root = tmpRoot();
    const store = new FsAttachmentBlobStore(root);
    const key = await store.put('att-del', Buffer.from('hello'));
    await store.delete(key);
    await assert.rejects(() => store.get(key));
    // Second delete must not throw.
    await store.delete(key);
});

test('the storage key is sharded and stable for an id', async () => {
    const store = new FsAttachmentBlobStore(tmpRoot());
    const key = await store.put('abcdef', Buffer.from('x'));
    // first-two-char shard + id.
    assert.equal(key.replace(/\\/g, '/'), 'ab/abcdef');
});

test('get refuses a key that escapes the root', async () => {
    const store = new FsAttachmentBlobStore(tmpRoot());
    await assert.rejects(() => store.get('../../etc/passwd'));
});
