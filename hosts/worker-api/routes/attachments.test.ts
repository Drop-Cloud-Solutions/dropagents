import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';

import { applyMigrations } from '../../../core/state/migrations';
import { SqliteAttachmentStore } from '../../../adapters/state/SqliteAttachmentStore';
import { FsAttachmentBlobStore } from '../../../adapters/storage/FsAttachmentBlobStore';
import { createAttachmentsRouter } from './attachments';
import type { Command } from '../../../core/commands/command';

/**
 * Stand up the router behind a real http server, with a fake bus that
 * folds AttachTo / RemoveAttachment commands into the store exactly the way
 * the orchestrator handler + projection subscriber would in production.
 */
function harness(): {
    base: string;
    store: SqliteAttachmentStore;
    blobRoot: string;
    /** Command types the router dispatched, in order. */
    sent: string[];
    close: () => Promise<void>;
} {
    const db = new Database(':memory:');
    applyMigrations(db);
    const store = new SqliteAttachmentStore(db);
    const blobRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'attach-rt-'));
    const blobStore = new FsAttachmentBlobStore(blobRoot);

    const sent: string[] = [];
    const ownerOf: Record<string, 'task' | 'plan' | 'requirement'> = {
        AttachToTask: 'task',
        AttachToPlan: 'plan',
        AttachToRequirement: 'requirement',
    };
    const bus = {
        async send(command: Command): Promise<[]> {
            const p = command.payload as Record<string, unknown>;
            sent.push(command.type);
            if (ownerOf[command.type]) {
                store.add({
                    id: p.attachmentId as string,
                    ownerType: ownerOf[command.type]!,
                    ownerId: p.ownerId as string,
                    fileName: p.fileName as string,
                    contentType: p.contentType as string,
                    sizeBytes: p.sizeBytes as number,
                    storageKey: p.storageKey as string,
                    caption: (p.caption as string) ?? null,
                    createdAt: command.issuedAt,
                });
            } else if (command.type === 'RemoveAttachment') {
                const existing = store.get(p.attachmentId as string);
                store.remove(p.attachmentId as string);
                if (existing) await blobStore.delete(existing.storageKey);
            }
            return [];
        },
    };

    let counter = 0;
    const router = createAttachmentsRouter({
        store,
        blobStore,
        bus,
        idGen: () => `att-${counter++}`,
        clock: () => 1000,
    });

    const server = http.createServer((req, res) => {
        if (!router.handle(req, res)) {
            res.writeHead(404);
            res.end();
        }
    });
    server.listen(0);
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    return {
        base: `http://127.0.0.1:${port}`,
        store,
        blobRoot,
        sent,
        close: () => new Promise<void>((r) => server.close(() => r())),
    };
}

test('upload → list → download → delete round-trips through the router', async () => {
    const h = harness();
    try {
        const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
        const up = await fetch(
            `${h.base}/api/attachments?ownerType=task&ownerId=T-1&name=shot.png&caption=broken`,
            { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: png },
        );
        assert.equal(up.status, 201);
        const upBody = (await up.json()) as { attachment: { id: string; caption: string } };
        const id = upBody.attachment.id;
        assert.equal(upBody.attachment.caption, 'broken');

        const list = await fetch(`${h.base}/api/attachments?ownerType=task&ownerId=T-1`);
        const listBody = (await list.json()) as { attachments: Array<{ id: string }> };
        assert.equal(listBody.attachments.length, 1);
        assert.equal(listBody.attachments[0].id, id);

        const dl = await fetch(`${h.base}/api/attachments/${id}`);
        assert.equal(dl.status, 200);
        assert.equal(dl.headers.get('content-type'), 'image/png');
        assert.equal(dl.headers.get('x-content-type-options'), 'nosniff');
        const dlBytes = Buffer.from(await dl.arrayBuffer());
        assert.deepEqual(dlBytes, png);

        const del = await fetch(`${h.base}/api/attachments/${id}`, { method: 'DELETE' });
        assert.equal(del.status, 202);
        assert.equal(h.store.get(id), null);

        const after = await fetch(`${h.base}/api/attachments?ownerType=task&ownerId=T-1`);
        const afterBody = (await after.json()) as { attachments: unknown[] };
        assert.equal(afterBody.attachments.length, 0);
    } finally {
        await h.close();
    }
});

test('rejects an unsupported content type with 415', async () => {
    const h = harness();
    try {
        const res = await fetch(
            `${h.base}/api/attachments?ownerType=task&ownerId=T-1&name=x.svg`,
            { method: 'POST', headers: { 'Content-Type': 'image/svg+xml' }, body: '<svg/>' },
        );
        assert.equal(res.status, 415);
        assert.equal(h.store.listFor('task', 'T-1').length, 0);
    } finally {
        await h.close();
    }
});

test('missing ownerType/ownerId is a 400', async () => {
    const h = harness();
    try {
        const res = await fetch(`${h.base}/api/attachments?ownerType=task`, {
            method: 'POST', headers: { 'Content-Type': 'image/png' }, body: Buffer.from('x'),
        });
        assert.equal(res.status, 400);
    } finally {
        await h.close();
    }
});

test('download of an unknown id is 404', async () => {
    const h = harness();
    try {
        const res = await fetch(`${h.base}/api/attachments/nope`);
        assert.equal(res.status, 404);
    } finally {
        await h.close();
    }
});

// --- the requirement owner (architect tier) ---------------------------
//
// Design input: the operator pins an API spec or a screenshot to a
// REQUIREMENT, and the architect and design-verifier read it. The route
// has to accept the third owner type and dispatch its own command — the
// orchestrator handler is what decides the owner, so sending
// AttachToPlan here would file it under a plan that does not exist.

test('an upload to a requirement dispatches AttachToRequirement', async () => {
    const h = harness();
    try {
        const res = await fetch(
            `${h.base}/api/attachments?ownerType=requirement&ownerId=REQ-7&name=api.json`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: Buffer.from('{"openapi":"3.0.0"}'),
            },
        );
        assert.equal(res.status, 201);
        assert.ok(
            h.sent.includes('AttachToRequirement'),
            `expected AttachToRequirement; got ${h.sent.join(', ')}`,
        );
        assert.ok(
            !h.sent.includes('AttachToPlan') && !h.sent.includes('AttachToTask'),
            'and NOT one of the other owners',
        );
    } finally {
        await h.close();
    }
});

test('a requirement upload lists under the requirement, not a plan', async () => {
    const h = harness();
    try {
        await fetch(
            `${h.base}/api/attachments?ownerType=requirement&ownerId=REQ-7&name=api.json&caption=the%20spec`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: Buffer.from('{}'),
            },
        );

        const mine = await (await fetch(
            `${h.base}/api/attachments?ownerType=requirement&ownerId=REQ-7`,
        )).json() as { attachments: Array<{ fileName: string; caption: string | null }> };
        assert.equal(mine.attachments.length, 1);
        assert.equal(mine.attachments[0]!.fileName, 'api.json');
        assert.equal(mine.attachments[0]!.caption, 'the spec');

        // The same id as a plan must not see it — the two feed different
        // prompts.
        const asPlan = await (await fetch(
            `${h.base}/api/attachments?ownerType=plan&ownerId=REQ-7`,
        )).json() as { attachments: unknown[] };
        assert.deepEqual(asPlan.attachments, []);
    } finally {
        await h.close();
    }
});

test('an unknown owner type is still rejected', async () => {
    // The parser is a whitelist; widening it must not have turned it into
    // "anything goes", which would write rows nothing ever reads.
    const h = harness();
    try {
        const res = await fetch(
            `${h.base}/api/attachments?ownerType=epic&ownerId=E-1&name=x.png`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'image/png' },
                body: Buffer.from([0x89, 0x50]),
            },
        );
        assert.equal(res.status, 400);
        const body = await res.json() as { error: string };
        assert.match(body.error, /requirement/, 'the error should name what IS allowed');
        assert.deepEqual(h.sent, [], 'and nothing is dispatched');
    } finally {
        await h.close();
    }
});

test('deleting a requirement attachment round-trips', async () => {
    const h = harness();
    try {
        const up = await (await fetch(
            `${h.base}/api/attachments?ownerType=requirement&ownerId=REQ-7&name=api.json`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: Buffer.from('{}'),
            },
        )).json() as { attachment: { id: string; ownerType: string } };
        assert.equal(up.attachment.ownerType, 'requirement', 'echoed back as a requirement');

        const del = await fetch(
            `${h.base}/api/attachments/${up.attachment.id}`,
            { method: 'DELETE' },
        );
        assert.equal(del.status, 202, 'accepted — the orchestrator does the deleting');
        assert.deepEqual(h.store.listFor('requirement', 'REQ-7'), []);
    } finally {
        await h.close();
    }
});
