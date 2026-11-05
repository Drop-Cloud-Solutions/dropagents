/**
 * Field case: typing into a task modal's Instructions box lost focus
 * several times a sentence, and scrolling a long modal snapped back on
 * its own. Both came from the same line — `bodyEl.replaceChildren(...)`
 * running on every SSE tick, destroying the focused node and zeroing the
 * scroller.
 *
 * No jsdom in this repo (see `client/modals/project-context.test.ts`), so
 * the helpers take structural types and these are plain objects.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import {
    isOperatorEditingIn,
    rebuildPreservingScroll,
} from './modal-refresh';

/** A container that "contains" exactly the nodes it was given. */
function containerOf(...members: unknown[]): { contains(n: unknown): boolean } {
    return { contains: (n: unknown): boolean => members.includes(n) };
}

test('a focused textarea inside the modal blocks the rebuild', () => {
    const field = { tagName: 'TEXTAREA' };
    assert.equal(isOperatorEditingIn(containerOf(field), field), true);
});

test('a focused input inside the modal blocks the rebuild', () => {
    const field = { tagName: 'input' }; // tag casing varies by construction
    assert.equal(isOperatorEditingIn(containerOf(field), field), true);
});

test('a contenteditable region counts as editing', () => {
    const field = { tagName: 'DIV', isContentEditable: true };
    assert.equal(isOperatorEditingIn(containerOf(field), field), true);
});

test('a field OUTSIDE the modal body does not block it', () => {
    // The plan modal's chat composer lives in the right pane, outside
    // [data-plan-modal-body]. "Review the plan while chatting about it"
    // depends on the left pane still refreshing while it has focus.
    const composer = { tagName: 'TEXTAREA' };
    assert.equal(isOperatorEditingIn(containerOf(/* nothing */), composer), false);
});

test('a focused button or select does not block it', () => {
    // Neither holds a caret, and a rebuild restores a select's value from
    // state — treating them as editable would stall the modal for as long
    // as a dropdown sat focused.
    for (const tagName of ['BUTTON', 'SELECT', 'A', 'DIV']) {
        const el = { tagName };
        assert.equal(isOperatorEditingIn(containerOf(el), el), false, tagName);
    }
});

test('no focus, or no container, is not editing', () => {
    assert.equal(isOperatorEditingIn(containerOf(), null), false);
    assert.equal(isOperatorEditingIn(null, { tagName: 'TEXTAREA' }), false);
    assert.equal(isOperatorEditingIn(undefined, undefined), false);
});

test('scroll position survives the rebuild', () => {
    // Mirrors what replaceChildren does: emptying the element drops
    // scrollTop to 0 as a side effect of there being nothing to scroll.
    const el = { scrollTop: 420 };
    let ran = false;
    rebuildPreservingScroll(el, () => {
        ran = true;
        el.scrollTop = 0;
    });
    assert.equal(ran, true, 'the rebuild must still happen');
    assert.equal(el.scrollTop, 420);
});

test('a modal that was never scrolled is left untouched', () => {
    const writes: number[] = [];
    const el = {
        get scrollTop(): number { return 0; },
        set scrollTop(v: number) { writes.push(v); },
    };
    rebuildPreservingScroll(el, () => {});
    assert.deepEqual(writes, [], 'no reason to write 0 over 0');
});

test('the rebuild runs even with no element to preserve', () => {
    let ran = false;
    rebuildPreservingScroll(null, () => { ran = true; });
    assert.equal(ran, true);
});

test('a throwing rebuild is not swallowed', () => {
    // refreshPlanModal wraps its rebuild in a try/catch that renders a
    // diagnostic. Swallowing here would leave the modal blank with no
    // message instead.
    const el = { scrollTop: 10 };
    assert.throws(
        () => rebuildPreservingScroll(el, () => { throw new Error('build failed'); }),
        /build failed/,
    );
});
