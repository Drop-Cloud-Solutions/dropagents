/**
 * Field report: the operator attached `FW26_v12_loan capping_final.csv` to
 * a plan — the CSV WAS the spec — and the planner replied that it "is not
 * in the workspace". It was right: plan attachments reached the lifecycle
 * agents as a list of filenames, and the note said outright that the bytes
 * were not in the working tree. Only task agents ever got real files, and
 * the planner has no worktree.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { AttachmentBlobStore } from '../../core/ports/AttachmentBlobStore';
import type { Attachment } from '../../adapters/state/SqliteAttachmentStore';

import {
    backfillDesignAttachments,
    designAttachmentDir,
    designAttachmentPath,
    designAttachmentsRoot,
    mirrorDesignAttachment,
    removeMirroredDesignAttachment,
    designAttachmentScope,
    renderDesignAttachmentsNote,
    safeFileName,
} from './design-attachments';

const silentLogger = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
} as never;

function tmpRoot(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'plan-att-'));
}

function fakeBlobStore(bytes: Record<string, string>): AttachmentBlobStore {
    return {
        put: async () => 'unused',
        get: async (key: string) => {
            const v = bytes[key];
            if (v === undefined) throw new Error(`no blob for ${key}`);
            return Buffer.from(v, 'utf8');
        },
        delete: async () => undefined,
    };
}

function meta(over: Partial<Attachment> = {}): Attachment {
    return {
        id: 'att-1',
        ownerType: 'plan',
        ownerId: 'plan-123',
        fileName: 'FW26_v12_loan capping_final.csv',
        contentType: 'text/csv',
        sizeBytes: 10,
        storageKey: 'at/att-1',
        caption: null,
        createdAt: 1,
        ...over,
    };
}

test('the mirrored file keeps the operator filename verbatim, spaces and all', async () => {
    // The prompt quotes the name back and the operator recognises it. A
    // slugged `fw26_v12_loan_capping_final.csv` would read as a different
    // file from the one they attached.
    const root = tmpRoot();
    try {
        const written = await mirrorDesignAttachment({
            root,
            ownerId: 'plan-123',
            attachmentId: 'att-1',
            fileName: 'FW26_v12_loan capping_final.csv',
            storageKey: 'at/att-1',
            blobStore: fakeBlobStore({ 'at/att-1': 'sku,qty\nA,1\n' }),
            logger: silentLogger,
        });

        assert.ok(written);
        assert.equal(path.basename(written!), 'FW26_v12_loan capping_final.csv');
        assert.equal(fs.readFileSync(written!, 'utf8'), 'sku,qty\nA,1\n');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('two attachments sharing a filename do not collide', () => {
    // The task-side materialiser renames the second to `data-2.csv`,
    // which it can only do because it writes the whole set in one pass.
    // Mirroring one event at a time has no such view, so the attachment
    // id carries the uniqueness instead.
    const a = designAttachmentPath('/root', 'plan-1', 'att-1', 'data.csv');
    const b = designAttachmentPath('/root', 'plan-1', 'att-2', 'data.csv');
    assert.notEqual(a, b);
    assert.equal(path.basename(a), 'data.csv');
    assert.equal(path.basename(b), 'data.csv');
});

test('a traversing filename or id cannot escape the plan directory', () => {
    // Defence-in-depth: ids are pipeline-minted, but a `..` reaching
    // path.join would write outside the workspace root, which is the one
    // thing the whole boundary apparatus exists to prevent.
    const root = path.join('/root', 'plan-attachments');
    const p = designAttachmentPath(root, '../../etc', '../..', '../../../evil.sh');
    assert.ok(
        p.startsWith(path.join(root, '_')) || p.startsWith(path.join(root, 'unnamed')),
        `escaped: ${p}`,
    );
    assert.ok(!p.includes('..'));
    assert.equal(safeFileName('../../../evil.sh'), 'evil.sh');
});

test('removing an attachment removes its mirror', async () => {
    // A removed attachment that kept appearing in every future planner
    // prompt is worse than never having had it.
    const root = tmpRoot();
    try {
        const written = await mirrorDesignAttachment({
            root,
            ownerId: 'plan-123',
            attachmentId: 'att-1',
            fileName: 'spec.csv',
            storageKey: 'at/att-1',
            blobStore: fakeBlobStore({ 'at/att-1': 'x' }),
            logger: silentLogger,
        });
        assert.ok(fs.existsSync(written!));

        await removeMirroredDesignAttachment({
            root, ownerId: 'plan-123', attachmentId: 'att-1', logger: silentLogger,
        });

        assert.equal(fs.existsSync(written!), false);
        // A second removal is a no-op, not a throw.
        await removeMirroredDesignAttachment({
            root, ownerId: 'plan-123', attachmentId: 'att-1', logger: silentLogger,
        });
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('a blob that cannot be read is logged and skipped, not thrown', async () => {
    // The upload already succeeded; failing here would surface as an
    // error on an operation the operator watched complete.
    const root = tmpRoot();
    try {
        const written = await mirrorDesignAttachment({
            root,
            ownerId: 'plan-123',
            attachmentId: 'att-1',
            fileName: 'spec.csv',
            storageKey: 'missing',
            blobStore: fakeBlobStore({}),
            logger: silentLogger,
        });
        assert.equal(written, null);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('the backfill writes only what is missing', async () => {
    // Every attachment uploaded before this existed has no mirror, and
    // the AttachmentAdded subscriber will not replay them.
    const root = tmpRoot();
    try {
        const blobs = fakeBlobStore({ 'at/att-1': 'one', 'at/att-2': 'two' });
        const metas = [
            meta({ id: 'att-1', fileName: 'a.csv', storageKey: 'at/att-1' }),
            meta({ id: 'att-2', fileName: 'b.csv', storageKey: 'at/att-2' }),
        ];

        assert.equal(
            await backfillDesignAttachments({ root, owner: 'plan', attachments: metas, blobStore: blobs, logger: silentLogger }),
            2,
        );
        // Second pass finds both present and writes nothing.
        assert.equal(
            await backfillDesignAttachments({ root, owner: 'plan', attachments: metas, blobStore: blobs, logger: silentLogger }),
            0,
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('the backfill ignores TASK attachments', async () => {
    // Those are materialised into the worktree at spawn and have no
    // business in the plan mirror.
    const root = tmpRoot();
    try {
        const n = await backfillDesignAttachments({
            owner: 'plan',
            root,
            attachments: [meta({ ownerType: 'task', ownerId: 'T-1' })],
            blobStore: fakeBlobStore({ 'at/att-1': 'x' }),
            logger: silentLogger,
        });

        assert.equal(n, 0);
        assert.equal(fs.existsSync(designAttachmentDir(root, 'T-1')), false);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('the note names the real path of each attachment', () => {
    const root = tmpRoot();
    try {
        const m = meta();
        const target = designAttachmentPath(root, m.ownerId, m.id, m.fileName);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, 'sku,qty');

        const note = renderDesignAttachmentsNote(
        'plan',root, m.ownerId, [m]);

        assert.match(note, /^# Plan attachments/);
        assert.ok(note.includes(m.fileName), 'filename');
        assert.ok(note.includes(target), 'absolute path');
        // The old wording actively told the agent the bytes were absent —
        // which is precisely what made it report the CSV missing.
        assert.doesNotMatch(note, /not in your working tree/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('an attachment whose mirror is MISSING is marked, not quietly given a path', () => {
    // Promising a path that is not there sends the agent to a missing
    // file and teaches it to distrust the block.
    const root = tmpRoot();
    try {
        const note = renderDesignAttachmentsNote(
        'plan',root, 'plan-123', [meta()]);

        assert.ok(note.includes('FW26_v12_loan capping_final.csv'));
        assert.match(note, /NOT on disk/);
        assert.match(note, /rather than inventing its contents/);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('no attachments renders nothing at all', () => {
    assert.equal(renderDesignAttachmentsNote(
        'plan','/root', 'plan-123', []), '');
});

test('the root sits beside repos/ and worktrees/, not inside a clone', () => {
    // Anything written inside a clone is wiped by the pre-spawn
    // `git fetch && reset --hard`.
    const root = designAttachmentsRoot(path.join('C:', 'ws'), 'plan');
    assert.equal(root, path.join('C:', 'ws', 'plan-attachments'));
});

// --- the requirement owner (architect tier) ---------------------------
//
// A requirement's attachments are its design INPUT. The architect has no
// worktree either, so they are mirrored the same way the plan's are —
// under their own root, because a plan and a requirement can share an id
// shape and must never share a directory.

test('plan and requirement roots are different directories', () => {
    const ws = path.join('C:', 'ws');
    const plan = designAttachmentsRoot(ws, 'plan');
    const req = designAttachmentsRoot(ws, 'requirement');

    assert.notEqual(plan, req);
    assert.equal(path.basename(plan), 'plan-attachments');
    assert.equal(path.basename(req), 'requirement-attachments');
    assert.equal(path.dirname(req), ws, 'beside repos/ and worktrees/, not in a clone');
});

test('the same id under two owners does not collide on disk', () => {
    // The thing the separate roots exist for.
    const ws = path.join('C:', 'ws');
    assert.notEqual(
        designAttachmentPath(designAttachmentsRoot(ws, 'plan'), 'X-1', 'a-1', 'spec.csv'),
        designAttachmentPath(designAttachmentsRoot(ws, 'requirement'), 'X-1', 'a-1', 'spec.csv'),
    );
});

test('the backfill only writes the owner it was asked for', () => {
    // One pass per root. A requirement attachment written into the plan
    // root would be read by the planner and never by the architect.
    const metas: Attachment[] = [
        {
            id: 'p-1', ownerType: 'plan', ownerId: 'PL-1', fileName: 'a.csv',
            contentType: 'text/csv', sizeBytes: 1, storageKey: 'ab/p1',
            caption: null, createdAt: 1,
        },
        {
            id: 'r-1', ownerType: 'requirement', ownerId: 'REQ-1', fileName: 'b.json',
            contentType: 'application/json', sizeBytes: 1, storageKey: 'ab/r1',
            caption: null, createdAt: 2,
        },
    ];
    const seen: string[] = [];
    const blobs: AttachmentBlobStore = {
        put: async () => '',
        get: async (key: string) => {
            seen.push(key);
            return Buffer.from('x');
        },
        delete: async () => undefined,
    };
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'req-backfill-'));
    try {
        return backfillDesignAttachments({
            root, owner: 'requirement', attachments: metas,
            blobStore: blobs, logger: silentLogger,
        }).then((written) => {
            assert.equal(written, 1);
            assert.deepEqual(seen, ['ab/r1'], 'the plan attachment is not its business');
        });
    } finally {
        /* temp dir left to the OS sweep */
    }
});

// --- the prompt block -------------------------------------------------

test('the requirement block is headed and worded for a REQUIREMENT', () => {
    // The architect reading "# Plan attachments" would be told it was
    // looking at something that does not exist — its plan id is
    // synthetic. Persona wording is a contract in this codebase.
    const metas: Attachment[] = [{
        id: 'a-1', ownerType: 'requirement', ownerId: 'REQ-1', fileName: 'api.json',
        contentType: 'application/json', sizeBytes: 2, storageKey: 'ab/a1',
        caption: 'the target contract', createdAt: 1,
    }];
    const note = renderDesignAttachmentsNote(
        'requirement', path.join('C:', 'ws', 'requirement-attachments'),
        'REQ-1', metas, () => true,
    );

    assert.match(note, /^# Requirement attachments/);
    assert.ok(!note.includes('# Plan attachments'));
    assert.match(note, /before designing/);
    assert.match(note, /api\.json/);
    assert.match(note, /the target contract/);
});

test('the plan block is unchanged by the generalisation', () => {
    const metas: Attachment[] = [{
        id: 'a-1', ownerType: 'plan', ownerId: 'PL-1', fileName: 'cols.csv',
        contentType: 'text/csv', sizeBytes: 2, storageKey: 'ab/a1',
        caption: null, createdAt: 1,
    }];
    const note = renderDesignAttachmentsNote(
        'plan', path.join('C:', 'ws', 'plan-attachments'), 'PL-1', metas, () => true,
    );

    assert.match(note, /^# Plan attachments/);
    assert.match(note, /before planning/);
});

test('a requirement attachment that is NOT on disk is marked, not given a path', () => {
    // Promising a path that is not there sends the architect to a missing
    // file and teaches it to distrust the block.
    const metas: Attachment[] = [{
        id: 'a-1', ownerType: 'requirement', ownerId: 'REQ-1', fileName: 'api.json',
        contentType: 'application/json', sizeBytes: 2, storageKey: 'ab/a1',
        caption: null, createdAt: 1,
    }];
    const note = renderDesignAttachmentsNote(
        'requirement', path.join('C:', 'ws', 'requirement-attachments'),
        'REQ-1', metas, () => false,
    );

    assert.match(note, /NOT on disk/);
    assert.match(note, /rather than inventing its contents/);
});

// --- which owner a run reads ------------------------------------------

test('an architect run reads the REQUIREMENT, not its synthetic plan', () => {
    // The architect's planId is minted as `req-<requirementId>` so the
    // lifecycle plumbing has something plan-shaped to key on. No such
    // plan exists, so plan attachments would always be empty and the
    // boundary block would name a directory for a plan that never will.
    assert.deepEqual(
        designAttachmentScope({ planId: 'req-REQ-7', requirementId: 'REQ-7' }),
        { owner: 'requirement', ownerId: 'REQ-7' },
    );
});

test('a planner / decomposer run reads its real plan', () => {
    assert.deepEqual(
        designAttachmentScope({ planId: 'PL-1' }),
        { owner: 'plan', ownerId: 'PL-1' },
    );
    assert.deepEqual(
        designAttachmentScope({ planId: 'PL-1', requirementId: undefined }),
        { owner: 'plan', ownerId: 'PL-1' },
    );
});

test('an empty requirementId falls back to the plan', () => {
    // Defensive: a '' threaded through would otherwise scope the run to
    // an owner id of '' and silently find nothing.
    assert.deepEqual(
        designAttachmentScope({ planId: 'PL-1', requirementId: '' }),
        { owner: 'plan', ownerId: 'PL-1' },
    );
});
