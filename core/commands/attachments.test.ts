import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import {
    AttachmentCommands,
    isAttachToOwnerPayload,
    isRemoveAttachmentPayload,
} from './index';

test('AttachmentCommands names are stable', () => {
    assert.equal(AttachmentCommands.ATTACH_TO_TASK, 'AttachToTask');
    assert.equal(AttachmentCommands.ATTACH_TO_PLAN, 'AttachToPlan');
    assert.equal(AttachmentCommands.REMOVE_ATTACHMENT, 'RemoveAttachment');
});

test('isAttachToOwnerPayload accepts a full payload (caption optional)', () => {
    const base = {
        attachmentId: 'att-1',
        ownerId: 'T-1',
        fileName: 'shot.png',
        contentType: 'image/png',
        sizeBytes: 1024,
        storageKey: 'ab/att-1',
    };
    assert.equal(isAttachToOwnerPayload(base), true);
    assert.equal(isAttachToOwnerPayload({ ...base, caption: 'misaligned' }), true);
});

test('isAttachToOwnerPayload rejects missing / wrong-typed fields', () => {
    assert.equal(isAttachToOwnerPayload({}), false);
    assert.equal(isAttachToOwnerPayload({ attachmentId: 'x' }), false);
    assert.equal(
        isAttachToOwnerPayload({
            attachmentId: 'a', ownerId: 'o', fileName: 'f',
            contentType: 'image/png', sizeBytes: 'big', storageKey: 'k',
        }),
        false,
    );
    assert.equal(
        isAttachToOwnerPayload({
            attachmentId: 'a', ownerId: 'o', fileName: 'f',
            contentType: 'image/png', sizeBytes: 1, storageKey: 'k', caption: 5,
        }),
        false,
    );
});

test('isRemoveAttachmentPayload requires id + owner', () => {
    assert.equal(
        isRemoveAttachmentPayload({ attachmentId: 'a', ownerType: 'task', ownerId: 'T-1' }),
        true,
    );
    assert.equal(
        isRemoveAttachmentPayload({ attachmentId: 'a', ownerType: 'plan', ownerId: 'P-1' }),
        true,
    );
    assert.equal(
        isRemoveAttachmentPayload({ attachmentId: 'a', ownerType: 'bogus', ownerId: 'T-1' }),
        false,
    );
    assert.equal(isRemoveAttachmentPayload({ attachmentId: 'a' }), false);
});
