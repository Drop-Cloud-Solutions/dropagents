/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Unit tests for the AP-IFF-004 toast queue.
 *
 * Coverage
 * --------
 * - AC #1: `showToast` renders a `.toast` element into `#toast-root`
 *   with the correct kind modifier class and message text.
 * - AC #2: the toast is removed from the DOM `ttlMs` ms after creation,
 *   driven entirely by fake timers — no real-clock waits.
 * - AC #3: multiple toasts stack vertically in FIFO order and dismiss
 *   independently when their per-toast timers fire.
 * - AC #4: fake timers are used throughout (vi.useFakeTimers when run
 *   under vitest, the node:test mock.timers equivalent otherwise).
 *
 * Dual-runner discovery — same pattern as
 * `hosts/board-ui/web/board.task-cards.test.ts`. `process.env.VITEST=true`
 * routes test registration through `globalThis.test`; everywhere else
 * the file uses `node:test`. The fake-timer plumbing follows the same
 * fork — vitest's `vi.useFakeTimers()` and node:test's
 * `mock.timers.enable()` expose nearly the same surface, so the helper
 * below normalises them behind a `FakeClock` interface.
 */
import * as assert from 'node:assert/strict';

import {
    DEFAULT_TOAST_TTL_MS,
    KIND_CLASS,
    SHOW_CLASS,
    TOAST_CLASS,
    TOAST_ROOT_ID,
    TOAST_SLIDE_MS,
    showToast,
    type ToastDocument,
    type ToastElement,
} from './toast';

// ---------------------------------------------------------------------------
// Dual-runner test() shim
// ---------------------------------------------------------------------------

type TestFn = (name: string, fn: () => void | Promise<void>) => void;

const test: TestFn = (((): TestFn => {
    if (process.env.VITEST) {
        const gt = (globalThis as { test?: TestFn }).test;
        if (typeof gt !== 'function') {
            throw new Error(
                'toast.spec.ts: VITEST=true but globalThis.test is missing — '
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
// Fake-timer helper — vi.useFakeTimers under vitest, mock.timers under node:test
// ---------------------------------------------------------------------------

interface FakeClock {
    tick(ms: number): void;
    teardown(): void;
}

function enableFakeTimers(): FakeClock {
    if (process.env.VITEST) {
        const vi = (globalThis as { vi?: any }).vi;
        if (!vi || typeof vi.useFakeTimers !== 'function') {
            throw new Error(
                'toast.spec.ts: VITEST=true but globalThis.vi is missing — '
                    + 'ensure vitest.config.ts sets test.globals = true',
            );
        }
        vi.useFakeTimers();
        return {
            tick: (ms: number): void => {
                vi.advanceTimersByTime(ms);
            },
            teardown: (): void => {
                vi.useRealTimers();
            },
        };
    }
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    const { mock } = require('node:test') as typeof import('node:test');
    mock.timers.enable({ apis: ['setTimeout'] });
    return {
        tick: (ms: number): void => {
            mock.timers.tick(ms);
        },
        teardown: (): void => {
            mock.timers.reset();
        },
    };
}

function withFakeClock(body: (clock: FakeClock) => void): void {
    const clock = enableFakeTimers();
    try {
        body(clock);
    } finally {
        clock.teardown();
    }
}

// ---------------------------------------------------------------------------
// Minimal DOM shim — matches the hand-rolled style used by stage-bar.test.ts
// ---------------------------------------------------------------------------

interface ShimElement extends ToastElement {
    readonly tagName: string;
    readonly children: ShimElement[];
    readonly attributes: Map<string, string>;
    parent: ShimElement | null;
    removed: boolean;
}

function makeShimElement(tagName: string): ShimElement {
    const attrs = new Map<string, string>();
    const children: ShimElement[] = [];
    const el: ShimElement = {
        tagName,
        className: '',
        textContent: null,
        children,
        attributes: attrs,
        parent: null,
        removed: false,
        setAttribute(name: string, value: string): void {
            attrs.set(name, value);
        },
        appendChild(child: ToastElement): ToastElement {
            const c = child as ShimElement;
            c.parent = el;
            children.push(c);
            return c;
        },
        remove(): void {
            el.removed = true;
            const p = el.parent;
            if (p) {
                const idx = p.children.indexOf(el);
                if (idx >= 0) p.children.splice(idx, 1);
                el.parent = null;
            }
        },
    };
    return el;
}

interface ShimDocument {
    doc: ToastDocument;
    root: ShimElement;
}

function makeShimDocument(): ShimDocument {
    const root = makeShimElement('div');
    const doc: ToastDocument = {
        getElementById(id: string): ToastElement | null {
            return id === TOAST_ROOT_ID ? root : null;
        },
        createElement(tagName: string): ToastElement {
            return makeShimElement(tagName);
        },
    };
    return { doc, root };
}

function asShim(el: ToastElement | null): ShimElement {
    if (!el) throw new Error('expected a rendered toast element, got null');
    return el as ShimElement;
}

// ---------------------------------------------------------------------------
// AC #1 — render shape + kind-to-class mapping
// ---------------------------------------------------------------------------

test('showToast renders a .toast element into #toast-root with the kind class', () => {
    withFakeClock(() => {
        const { doc, root } = makeShimDocument();
        const toast = asShim(showToast({ message: 'saved', kind: 'success' }, doc));

        assert.equal(toast.tagName, 'div');
        assert.equal(toast.textContent, 'saved');
        assert.ok(
            toast.className.startsWith(`${TOAST_CLASS} `),
            `expected leading "${TOAST_CLASS}" class, got "${toast.className}"`,
        );
        assert.ok(
            toast.className.includes(KIND_CLASS.success),
            `expected "${KIND_CLASS.success}" modifier class, got "${toast.className}"`,
        );
        assert.equal(toast.attributes.get('data-kind'), 'success');
        assert.equal(root.children.length, 1);
        assert.equal(root.children[0], toast);
    });
});

test('showToast maps each kind to its own modifier class', () => {
    withFakeClock(() => {
        const { doc } = makeShimDocument();
        const info = asShim(showToast({ message: 'i', kind: 'info' }, doc));
        const err = asShim(showToast({ message: 'e', kind: 'error' }, doc));
        const ok = asShim(showToast({ message: 's', kind: 'success' }, doc));

        assert.ok(info.className.includes(KIND_CLASS.info));
        assert.ok(err.className.includes(KIND_CLASS.error));
        assert.ok(ok.className.includes(KIND_CLASS.success));

        // Error toasts opt into role=alert so assistive tech announces
        // them immediately; info/success use role=status for a softer
        // live-region update.
        assert.equal(err.attributes.get('role'), 'alert');
        assert.equal(info.attributes.get('role'), 'status');
        assert.equal(ok.attributes.get('role'), 'status');
    });
});

test('showToast defaults kind to info when the caller omits it', () => {
    withFakeClock(() => {
        const { doc } = makeShimDocument();
        const toast = asShim(showToast({ message: 'plain' }, doc));
        assert.ok(toast.className.includes(KIND_CLASS.info));
        assert.equal(toast.attributes.get('data-kind'), 'info');
    });
});

test('showToast returns null when #toast-root is missing', () => {
    withFakeClock(() => {
        const doc: ToastDocument = {
            getElementById: (): ToastElement | null => null,
            createElement: (tagName: string): ToastElement => makeShimElement(tagName),
        };
        assert.equal(showToast({ message: 'orphan' }, doc), null);
    });
});

// ---------------------------------------------------------------------------
// AC #2 — auto-dismiss after ttlMs
// ---------------------------------------------------------------------------

test('toast auto-dismisses exactly when ttlMs elapses', () => {
    withFakeClock((clock) => {
        const { doc, root } = makeShimDocument();
        const toast = asShim(showToast({ message: 'gone soon', ttlMs: 2000 }, doc));

        assert.equal(root.children.length, 1);
        assert.equal(toast.removed, false);

        clock.tick(1999);
        assert.equal(toast.removed, false, 'toast must survive until exactly ttlMs');
        assert.equal(root.children.length, 1);

        clock.tick(1);
        assert.equal(toast.removed, true, 'toast must be removed at ttlMs');
        assert.equal(root.children.length, 0);
    });
});

test('showToast falls back to the default 4000 ms ttl when ttlMs is omitted', () => {
    withFakeClock((clock) => {
        const { doc, root } = makeShimDocument();
        const toast = asShim(showToast({ message: 'default ttl' }, doc));

        clock.tick(DEFAULT_TOAST_TTL_MS - 1);
        assert.equal(toast.removed, false);
        assert.equal(root.children.length, 1);

        clock.tick(1);
        assert.equal(toast.removed, true);
        assert.equal(root.children.length, 0);
    });
});

// ---------------------------------------------------------------------------
// AC #3 — multiple toasts stack vertically + dismiss independently
// ---------------------------------------------------------------------------

test('multiple toasts stack in FIFO order under #toast-root', () => {
    withFakeClock(() => {
        const { doc, root } = makeShimDocument();
        const a = asShim(showToast({ message: 'A', ttlMs: 10_000 }, doc));
        const b = asShim(showToast({ message: 'B', ttlMs: 10_000 }, doc));
        const c = asShim(showToast({ message: 'C', ttlMs: 10_000 }, doc));

        assert.deepEqual(
            root.children.map((child) => child.textContent),
            ['A', 'B', 'C'],
            'toasts must stack in insertion order (FIFO, top-to-bottom)',
        );
        assert.equal(root.children[0], a);
        assert.equal(root.children[1], b);
        assert.equal(root.children[2], c);
    });
});

test('three toasts with different ttls dismiss independently in their own time', () => {
    withFakeClock((clock) => {
        const { doc, root } = makeShimDocument();
        const a = asShim(showToast({ message: 'A', ttlMs: 1000 }, doc));
        const b = asShim(showToast({ message: 'B', ttlMs: 2000 }, doc));
        const c = asShim(showToast({ message: 'C', ttlMs: 3000 }, doc));

        assert.equal(root.children.length, 3);

        clock.tick(1000);
        assert.equal(a.removed, true, 'A (ttl 1000) must be gone at t=1000');
        assert.equal(b.removed, false);
        assert.equal(c.removed, false);
        assert.deepEqual(
            root.children.map((child) => child.textContent),
            ['B', 'C'],
        );

        clock.tick(1000);
        assert.equal(b.removed, true, 'B (ttl 2000) must be gone at t=2000');
        assert.equal(c.removed, false);
        assert.deepEqual(
            root.children.map((child) => child.textContent),
            ['C'],
        );

        clock.tick(1000);
        assert.equal(c.removed, true, 'C (ttl 3000) must be gone at t=3000');
        assert.equal(root.children.length, 0);
    });
});

// ---------------------------------------------------------------------------
// Reviewer follow-up — `show` class lifecycle drives the v1 CSS transitions
// ---------------------------------------------------------------------------

test('toast mounts without `show`, then gains it on the next tick so the slide-in fires', () => {
    // The .toast rule in board.css starts hidden (translateY(60px), opacity 0)
    // and the .toast.show rule resets it. Adding `show` synchronously at
    // mount would collapse the transition into an instant snap, so we
    // assert the class flips one tick after appendChild.
    withFakeClock((clock) => {
        const { doc } = makeShimDocument();
        const toast = asShim(showToast({ message: 'animated', kind: 'info' }, doc));

        assert.equal(
            toast.className.split(/\s+/).includes(SHOW_CLASS),
            false,
            'show must NOT be present at mount — the browser needs a frame with the pre-transition styles first',
        );

        clock.tick(0);
        assert.equal(
            toast.className.split(/\s+/).includes(SHOW_CLASS),
            true,
            'show must be present after the next tick so the CSS transition fires',
        );
        // Modifier + base classes must survive the upgrade.
        assert.ok(toast.className.includes(KIND_CLASS.info));
        assert.ok(toast.className.startsWith(`${TOAST_CLASS} `));
    });
});

test('toast drops `show` TOAST_SLIDE_MS before removal so the slide-out plays', () => {
    withFakeClock((clock) => {
        const { doc, root } = makeShimDocument();
        const ttlMs = 2000;
        const toast = asShim(showToast({ message: 'sliding out', ttlMs }, doc));

        // Bring the toast to its shown state.
        clock.tick(0);
        assert.equal(toast.className.split(/\s+/).includes(SHOW_CLASS), true);

        // Just before the slide-out trigger, `show` is still on.
        clock.tick(ttlMs - TOAST_SLIDE_MS - 1);
        assert.equal(
            toast.className.split(/\s+/).includes(SHOW_CLASS),
            true,
            'show must remain until exactly ttlMs - TOAST_SLIDE_MS',
        );
        assert.equal(toast.removed, false);

        // At ttlMs - TOAST_SLIDE_MS, `show` comes off — slide-out begins.
        clock.tick(1);
        assert.equal(
            toast.className.split(/\s+/).includes(SHOW_CLASS),
            false,
            'show must be removed TOAST_SLIDE_MS before el.remove() so the slide-out transition has time to play',
        );
        assert.equal(toast.removed, false, 'node still present during the slide-out window');
        assert.ok(toast.className.includes(KIND_CLASS.info));

        // At ttlMs, the node finally leaves the DOM.
        clock.tick(TOAST_SLIDE_MS);
        assert.equal(toast.removed, true);
        assert.equal(root.children.length, 0);
    });
});

test('toast with ttlMs <= TOAST_SLIDE_MS skips the slide-out and removes at ttlMs', () => {
    // For very short TTLs there isn't enough time for the slide-out to be
    // visually meaningful — honouring the caller's TTL wins over the
    // animation. This guards against scheduling a slide-out timer at a
    // negative offset, which would fire immediately and leave a flicker.
    withFakeClock((clock) => {
        const { doc, root } = makeShimDocument();
        const toast = asShim(showToast({ message: 'fast', ttlMs: TOAST_SLIDE_MS }, doc));

        clock.tick(TOAST_SLIDE_MS - 1);
        assert.equal(toast.removed, false);
        // `show` must NOT have been pre-emptively removed.
        assert.equal(toast.className.split(/\s+/).includes(SHOW_CLASS), true);

        clock.tick(1);
        assert.equal(toast.removed, true, 'short-ttl toast removes at exactly ttlMs');
        assert.equal(root.children.length, 0);
    });
});

// ---------------------------------------------------------------------------
// AC #3 — multiple toasts dismiss independently (continued)
// ---------------------------------------------------------------------------

test('a longer-lived toast survives the dismissal of an earlier short-lived one', () => {
    // Regression guard: a single shared timer would dismiss the second
    // toast at the same instant as the first. Each toast owning its own
    // setTimeout keeps them decoupled.
    withFakeClock((clock) => {
        const { doc, root } = makeShimDocument();
        const shortLived = asShim(showToast({ message: 'short', ttlMs: 500 }, doc));
        const longLived = asShim(showToast({ message: 'long', ttlMs: 5000 }, doc));

        clock.tick(500);
        assert.equal(shortLived.removed, true);
        assert.equal(longLived.removed, false);
        assert.equal(root.children.length, 1);
        assert.equal(root.children[0], longLived);

        clock.tick(4500);
        assert.equal(longLived.removed, true);
        assert.equal(root.children.length, 0);
    });
});
