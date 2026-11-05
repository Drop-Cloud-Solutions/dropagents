/**
 * Field report: "I started a new design, click on choose a file,
 * selected the file, added a description and then nothing seem to
 * happen, it does not show an attachment being added."
 *
 * Every upload had succeeded; the list never repainted. Nothing targeted
 * the new-design form's section at all, because the repaint was a
 * board-wide `scheduleRender()` and that pass does not rebuild either
 * requirement surface.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import {
    ATTACHMENTS_OWNER_ATTR,
    attachmentSectionKey,
    sectionsForOwner,
    type OwnedSectionLike,
} from './attachment-sections';

/** A stand-in for a mounted section carrying (or missing) the attribute. */
function section(key: string | null): OwnedSectionLike & { key: string | null } {
    return {
        key,
        getAttribute: (name: string): string | null =>
            (name === ATTACHMENTS_OWNER_ATTR ? key : null),
    };
}

// --- the key ----------------------------------------------------------

test('the key carries the owner TYPE as well as the id', () => {
    assert.equal(attachmentSectionKey('requirement', 'REQ-1'), 'requirement:REQ-1');
    assert.equal(attachmentSectionKey('plan', 'REQ-1'), 'plan:REQ-1');
});

test('the same id under two owners produces two different keys', () => {
    // The architect tier mints `req-<requirementId>` as a PLAN id
    // elsewhere, so ids genuinely cross between owners. Keying on the id
    // alone would repaint one owner's section with another's files.
    assert.notEqual(
        attachmentSectionKey('requirement', 'X-1'),
        attachmentSectionKey('plan', 'X-1'),
    );
});

// --- the targeting ----------------------------------------------------

test('a mounted section for the owner is found', () => {
    const mine = section('requirement:REQ-1');
    const found = sectionsForOwner([mine], 'requirement:REQ-1');
    assert.deepEqual(found, [mine]);
});

test('another OWNER TYPE with the same id is not touched', () => {
    // The bug this key shape exists to prevent.
    const asPlan = section('plan:REQ-1');
    assert.deepEqual(sectionsForOwner([asPlan], 'requirement:REQ-1'), []);
});

test('another id of the same type is not touched', () => {
    const other = section('requirement:REQ-2');
    assert.deepEqual(sectionsForOwner([other], 'requirement:REQ-1'), []);
});

test('two sections for the same owner both repaint', () => {
    // The requirement modal and a form can be torn down and rebuilt in
    // sequence; a double-mount must not leave one of them stale.
    const a = section('requirement:REQ-1');
    const b = section('requirement:REQ-1');
    assert.deepEqual(
        sectionsForOwner([a, section('plan:PL-1'), b], 'requirement:REQ-1'),
        [a, b],
    );
});

test('an element without the attribute is skipped, not crashed on', () => {
    assert.deepEqual(sectionsForOwner([section(null)], 'requirement:REQ-1'), []);
});

test('nothing mounted is simply nothing to do', () => {
    // A section that has been torn down is not found — which is the
    // whole reason the DOM is the lookup instead of a registry of
    // mounted elements that would need keeping in sync.
    assert.deepEqual(sectionsForOwner([], 'requirement:REQ-1'), []);
});

test('an owner id with CSS-special characters still matches', () => {
    // Compared in JS, not inside an attribute selector: a selector built
    // by interpolation would need escaping, and one that threw would
    // take the repaint down with it.
    for (const id of ['a"b', "a'b", 'a]b', 'a b', 'a\\b']) {
        const el = section(`requirement:${id}`);
        assert.deepEqual(
            sectionsForOwner([el], attachmentSectionKey('requirement', id)),
            [el],
            id,
        );
    }
});
