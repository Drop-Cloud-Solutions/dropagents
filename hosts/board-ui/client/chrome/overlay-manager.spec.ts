/**
 * Unit tests for the AP-IFF-002 overlay manager.
 *
 * Coverage matches the task's acceptance criteria:
 *   1. openOverlay pushes onto the stack and sets aria-hidden=false,
 *   2. closeOverlay removes the entry, restores focus, and sets
 *      aria-hidden=true,
 *   3. Escape keydown closes only the topmost overlay (outer
 *      overlays stay open until they're top-of-stack),
 *   4. closeAll empties the stack,
 *   5. additional behavioural edge cases — duplicate open rejection,
 *      preventDefault cooperation, and dispose() cleanup — to lock in
 *      the contract documented in `overlay-manager.ts`.
 *
 * DOM strategy — hand-rolled shim.
 * --------------------------------
 * The task brief mentions "jsdom DOM" as a hint but jsdom is not in the
 * project's dependency graph (see `package.json`) and the existing
 * convention for chrome widgets is a 40-line hand-rolled shim
 * (`hosts/board-ui/web/stage-bar.test.ts` documents the rationale:
 * adding jsdom is a much bigger blast radius than implementing the
 * three method surfaces this manager touches). The shim below is
 * deliberately tiny and only models what the manager actually consumes.
 *
 * Dual-runner test() shim — mirrors `stage-bar.test.ts` so this file
 * runs under both `node --test --import tsx` (the repo's `npm test`)
 * and vitest. See that file's header for the full reasoning.
 */
import * as assert from 'node:assert/strict';

import {
    OverlayManager,
    type OverlayElement,
    type OverlayFocusable,
    type OverlayHandle,
    type OverlayKeyboardEvent,
    type OverlayKeydownListener,
} from './overlay-manager';

// ---------------------------------------------------------------------------
// Dual-runner test() shim
// ---------------------------------------------------------------------------

type TestFn = (name: string, fn: () => void | Promise<void>) => void;

const test: TestFn = (((): TestFn => {
    if (process.env.VITEST) {
        const gt = (globalThis as { test?: TestFn }).test;
        if (typeof gt !== 'function') {
            throw new Error(
                'overlay-manager.spec.ts: VITEST=true but globalThis.test is missing — '
                    + 'ensure vitest.config.ts sets test.globals = true',
            );
        }
        return gt;
    }
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    const nt = require('node:test') as { test: TestFn };
    return nt.test;
})());

// ---------------------------------------------------------------------------
// Minimal DOM shim
// ---------------------------------------------------------------------------

interface ShimElement extends OverlayElement {
    readonly attributes: Map<string, string>;
}

interface ShimFocusable extends OverlayFocusable {
    readonly id: string;
    focusCalls: number;
}

/**
 * Standalone interface (not extending OverlayDocument) so the shim can
 * expose a mutable `activeElement` without colliding with the parent's
 * `readonly` modifier. Structurally compatible with OverlayDocument —
 * passing a ShimDocument where an OverlayDocument is expected is sound
 * because mutable is assignable to readonly.
 */
interface ShimDocument {
    activeElement: OverlayFocusable | null;
    addEventListener(type: 'keydown', listener: OverlayKeydownListener): void;
    removeEventListener(type: 'keydown', listener: OverlayKeydownListener): void;
    dispatchKey(key: string): OverlayKeyboardEvent;
    listenerCount(): number;
}

function makeShimElement(): ShimElement {
    const attributes = new Map<string, string>();
    return {
        attributes,
        setAttribute(name: string, value: string): void {
            attributes.set(name, value);
        },
    };
}

function makeShimFocusable(id: string): ShimFocusable {
    const f: ShimFocusable = {
        id,
        focusCalls: 0,
        focus(): void {
            f.focusCalls += 1;
        },
    };
    return f;
}

function makeShimDocument(): ShimDocument {
    const listeners = new Set<OverlayKeydownListener>();
    const doc: ShimDocument = {
        activeElement: null,
        addEventListener(type: 'keydown', listener: OverlayKeydownListener): void {
            assert.equal(type, 'keydown', 'overlay-manager should only listen on keydown');
            listeners.add(listener);
        },
        removeEventListener(type: 'keydown', listener: OverlayKeydownListener): void {
            assert.equal(type, 'keydown', 'overlay-manager should only detach keydown');
            listeners.delete(listener);
        },
        listenerCount(): number {
            return listeners.size;
        },
        dispatchKey(key: string): OverlayKeyboardEvent {
            const event: OverlayKeyboardEvent = {
                key,
                defaultPrevented: false,
                preventDefault(): void {
                    (event as { defaultPrevented: boolean }).defaultPrevented = true;
                },
            };
            for (const fn of listeners) fn(event);
            return event;
        },
    };
    return doc;
}

// ---------------------------------------------------------------------------
// AC #1: openOverlay
// ---------------------------------------------------------------------------

test('openOverlay pushes onto the stack and sets aria-hidden=false', () => {
    const doc = makeShimDocument();
    const mgr = new OverlayManager(doc);
    try {
        const el = makeShimElement();
        el.setAttribute('aria-hidden', 'true');

        const handle = mgr.openOverlay('confirm-dialog', el);

        assert.equal(el.attributes.get('aria-hidden'), 'false');
        assert.equal(handle.id, 'confirm-dialog');
        const stack = mgr.getStack();
        assert.equal(stack.length, 1);
        assert.equal(stack[0].id, 'confirm-dialog');
        assert.equal(stack[0].element, el);
    } finally {
        mgr.dispose();
    }
});

test('openOverlay captures the currently-focused element as previouslyFocused', () => {
    const doc = makeShimDocument();
    const trigger = makeShimFocusable('trigger-btn');
    doc.activeElement = trigger;
    const mgr = new OverlayManager(doc);
    try {
        const handle = mgr.openOverlay('panel', makeShimElement());
        assert.equal(handle.previouslyFocused, trigger);
    } finally {
        mgr.dispose();
    }
});

test('openOverlay rejects a duplicate id with a clear error', () => {
    const doc = makeShimDocument();
    const mgr = new OverlayManager(doc);
    try {
        mgr.openOverlay('panel', makeShimElement());
        assert.throws(
            () => mgr.openOverlay('panel', makeShimElement()),
            /already open/,
        );
    } finally {
        mgr.dispose();
    }
});

test('openOverlay supports stacking — second overlay sits on top of first', () => {
    const doc = makeShimDocument();
    const mgr = new OverlayManager(doc);
    try {
        const a = makeShimElement();
        const b = makeShimElement();
        mgr.openOverlay('a', a);
        mgr.openOverlay('b', b);
        const stack = mgr.getStack();
        assert.deepEqual(
            stack.map((e) => e.id),
            ['a', 'b'],
        );
    } finally {
        mgr.dispose();
    }
});

// ---------------------------------------------------------------------------
// AC #2: closeOverlay
// ---------------------------------------------------------------------------

test('closeOverlay removes the entry, restores focus, and sets aria-hidden=true', () => {
    const doc = makeShimDocument();
    const trigger = makeShimFocusable('trigger-btn');
    doc.activeElement = trigger;
    const mgr = new OverlayManager(doc);
    try {
        const el = makeShimElement();
        mgr.openOverlay('panel', el);
        assert.equal(el.attributes.get('aria-hidden'), 'false');
        assert.equal(trigger.focusCalls, 0);

        mgr.closeOverlay('panel');

        assert.equal(el.attributes.get('aria-hidden'), 'true');
        assert.equal(trigger.focusCalls, 1, 'previouslyFocused.focus() must be called once');
        assert.equal(mgr.getStack().length, 0);
    } finally {
        mgr.dispose();
    }
});

test('closeOverlay is a no-op for unknown ids', () => {
    const doc = makeShimDocument();
    const mgr = new OverlayManager(doc);
    try {
        mgr.openOverlay('panel', makeShimElement());
        // Should not throw and should not pop the wrong overlay.
        mgr.closeOverlay('does-not-exist');
        assert.equal(mgr.getStack().length, 1);
    } finally {
        mgr.dispose();
    }
});

test('closeOverlay tolerates a previouslyFocused element without a focus() method', () => {
    const doc = makeShimDocument();
    // activeElement that satisfies OverlayFocusable but has no focus impl —
    // e.g. document.body in some test rigs.
    doc.activeElement = {};
    const mgr = new OverlayManager(doc);
    try {
        mgr.openOverlay('panel', makeShimElement());
        // Should not throw.
        mgr.closeOverlay('panel');
        assert.equal(mgr.getStack().length, 0);
    } finally {
        mgr.dispose();
    }
});

// ---------------------------------------------------------------------------
// AC #3: Escape semantics
// ---------------------------------------------------------------------------

test('Escape keydown closes only the topmost overlay', () => {
    const doc = makeShimDocument();
    const mgr = new OverlayManager(doc);
    try {
        const a = makeShimElement();
        const b = makeShimElement();
        mgr.openOverlay('a', a);
        mgr.openOverlay('b', b);

        const event = doc.dispatchKey('Escape');

        assert.equal(event.defaultPrevented, true, 'manager should preventDefault on consumed Escape');
        const stack = mgr.getStack();
        assert.equal(stack.length, 1);
        assert.equal(stack[0].id, 'a', 'bottom overlay must remain open');
        assert.equal(b.attributes.get('aria-hidden'), 'true', 'top overlay should be hidden');
        assert.equal(a.attributes.get('aria-hidden'), 'false', 'bottom overlay should stay visible');
    } finally {
        mgr.dispose();
    }
});

test('Escape on an empty stack is a no-op (no preventDefault, no throw)', () => {
    const doc = makeShimDocument();
    const mgr = new OverlayManager(doc);
    try {
        const event = doc.dispatchKey('Escape');
        assert.equal(event.defaultPrevented, false);
    } finally {
        mgr.dispose();
    }
});

test('Non-Escape keys never close an overlay', () => {
    const doc = makeShimDocument();
    const mgr = new OverlayManager(doc);
    try {
        mgr.openOverlay('panel', makeShimElement());
        doc.dispatchKey('Enter');
        doc.dispatchKey('a');
        doc.dispatchKey('Tab');
        assert.equal(mgr.getStack().length, 1, 'no key other than Escape should pop the stack');
    } finally {
        mgr.dispose();
    }
});

test('Escape with defaultPrevented already set is ignored — inner handlers win', () => {
    // Capture the manager's listener at construction time so the test
    // can invoke it directly with a pre-prevented event (the shim's
    // `dispatchKey` always starts with `defaultPrevented=false`).
    let captured: OverlayKeydownListener | null = null;
    const doc = makeShimDocument();
    const origAdd = doc.addEventListener.bind(doc);
    doc.addEventListener = (type: 'keydown', listener: OverlayKeydownListener): void => {
        captured = listener;
        origAdd(type, listener);
    };
    const mgr = new OverlayManager(doc);
    try {
        mgr.openOverlay('panel', makeShimElement());
        assert.ok(captured, 'manager must register a keydown listener on construction');

        const prePrevented: OverlayKeyboardEvent = {
            key: 'Escape',
            defaultPrevented: true,
            preventDefault(): void {
                // Already prevented; manager should never reach this branch.
                throw new Error('manager called preventDefault on a pre-prevented event');
            },
        };
        (captured as OverlayKeydownListener)(prePrevented);

        assert.equal(
            mgr.getStack().length,
            1,
            'manager must not close when defaultPrevented is already true',
        );
    } finally {
        mgr.dispose();
    }
});

// ---------------------------------------------------------------------------
// AC #4: closeAll
// ---------------------------------------------------------------------------

test('closeAll empties the stack and hides every overlay', () => {
    const doc = makeShimDocument();
    const mgr = new OverlayManager(doc);
    try {
        const a = makeShimElement();
        const b = makeShimElement();
        const c = makeShimElement();
        mgr.openOverlay('a', a);
        mgr.openOverlay('b', b);
        mgr.openOverlay('c', c);

        mgr.closeAll();

        assert.equal(mgr.getStack().length, 0);
        assert.equal(a.attributes.get('aria-hidden'), 'true');
        assert.equal(b.attributes.get('aria-hidden'), 'true');
        assert.equal(c.attributes.get('aria-hidden'), 'true');
    } finally {
        mgr.dispose();
    }
});

test('closeAll on an empty stack is a no-op', () => {
    const doc = makeShimDocument();
    const mgr = new OverlayManager(doc);
    try {
        mgr.closeAll();
        assert.equal(mgr.getStack().length, 0);
    } finally {
        mgr.dispose();
    }
});

// ---------------------------------------------------------------------------
// Lifecycle: keydown listener attach/detach
// ---------------------------------------------------------------------------

test('constructor attaches exactly one keydown listener; dispose detaches it', () => {
    const doc = makeShimDocument();
    assert.equal(doc.listenerCount(), 0);
    const mgr = new OverlayManager(doc);
    assert.equal(doc.listenerCount(), 1);
    mgr.dispose();
    assert.equal(doc.listenerCount(), 0);
});

test('getStack returns a fresh array — callers cannot mutate internal state', () => {
    const doc = makeShimDocument();
    const mgr = new OverlayManager(doc);
    try {
        mgr.openOverlay('a', makeShimElement());
        const snapshot = mgr.getStack();
        (snapshot as OverlayHandle[]).length = 0;
        assert.equal(mgr.getStack().length, 1, 'mutating the snapshot must not affect the manager');
    } finally {
        mgr.dispose();
    }
});

test('constructor throws a clear error when no document is available', () => {
    const originalDoc = (globalThis as { document?: unknown }).document;
    delete (globalThis as { document?: unknown }).document;
    try {
        assert.throws(() => new OverlayManager(), /no document available/);
    } finally {
        if (originalDoc !== undefined) {
            (globalThis as { document?: unknown }).document = originalDoc;
        }
    }
});
