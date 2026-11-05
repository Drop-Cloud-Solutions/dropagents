import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { renderAttachmentsBlock, type TaskAttachmentRef } from './handlers';

const ref = (over: Partial<TaskAttachmentRef> = {}): TaskAttachmentRef => ({
    relPath: 'attachments/shot.png',
    fileName: 'shot.png',
    contentType: 'image/png',
    caption: null,
    ownerType: 'task',
    ...over,
});

test('empty / undefined attachments render nothing', () => {
    assert.equal(renderAttachmentsBlock(undefined), '');
    assert.equal(renderAttachmentsBlock([]), '');
});

test('renders a heading, the Read instruction, and each path', () => {
    const out = renderAttachmentsBlock([
        ref({ relPath: 'attachments/bug.png', caption: 'login misaligned' }),
        ref({ relPath: 'attachments/seq.pdf', contentType: 'application/pdf', ownerType: 'plan', caption: null }),
    ]);
    assert.match(out, /^# Attachments/);
    assert.match(out, /READ each one/);
    assert.match(out, /`attachments\/bug\.png`.*from the task.*"login misaligned"/);
    assert.match(out, /`attachments\/seq\.pdf`.*from the plan/);
    // Tells the agent not to commit them.
    assert.match(out, /never stage, commit, or modify/);
});
