/**
 * Unit tests for the AP-FP-006 create-task modal.
 *
 * Trait category: Unit (AC #7) — no jsdom, no network, no real timers.
 * The renderer is exercised against a hand-rolled {@link ModalDocument}
 * shim, the keydown port is faked, and the fetch port is faked.
 *
 * Coverage maps to TASK.md acceptance criteria:
 *   AC #1  — openCreateTaskModal is the single entry point and returns a
 *            handle that exposes `close()`.
 *   AC #2  — The modal opens with `.modal-overlay` wrapping a
 *            `.modal-card` (the cross-modal structural markers the AC
 *            pins on; the inner card also carries `new-plan-modal
 *            modal-chrome` for visual parity with new-plan.ts).
 *   AC #3  — ESC dismisses the modal. A click on the overlay backdrop
 *            dismisses; a click on the card does NOT dismiss.
 *   AC #4  — Submitting POSTs to `${apiBase}${tasksPath}` (default
 *            `${apiBase}/tasks`) and forwards projectId / planId from
 *            the factory opts.
 *   AC #6  — Open, ESC dismiss, click-outside dismiss, submit dispatch
 *            (this file).
 *
 * Dual-runner discovery — mirrors `new-plan.test.ts` / `new-project.test.ts`.
 * The repo's own `npm test` runs `node --test --import tsx`; the review
 * pipeline runs `npx vitest run`. The shim below picks the right
 * `test()` at module load so a single source file is discovered and
 * executed by both runners.
 */
import * as assert from 'node:assert/strict';

import {
    CREATE_TASK_OVERLAY_ID,
    DEFAULT_TASKS_PATH,
    openCreateTaskModal,
    type CreateTaskKeydown,
    type CreateTaskKeydownUnsub,
    type CreateTaskModalHandle,
    type FetchFn,
    type FetchRequestInit,
    type FetchResponseLike,
    type KeydownPort,
    type ModalDocument,
    type ModalElement,
    type ToastInput,
} from './create-task';

// ---------------------------------------------------------------------------
// Dual-runner test() shim
// ---------------------------------------------------------------------------

type TestFn = (name: string, fn: () => void | Promise<void>) => void;

const test: TestFn = (((): TestFn => {
    if (process.env.VITEST) {
        const gt = (globalThis as { test?: TestFn }).test;
        if (typeof gt !== 'function') {
            throw new Error(
                'create-task.test.ts: VITEST=true but globalThis.test is missing — '
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
// Minimal DOM shim — same shape as new-plan.test.ts / new-project.test.ts
// so the modal-test suites speak the same language.
// ---------------------------------------------------------------------------

interface ShimElement extends ModalElement {
    readonly tagName: string;
    readonly children: ShimElement[];
    readonly attributes: Map<string, string>;
    parent: ShimElement | null;
    onclick?: (event?: { target?: unknown }) => void;
    oninput?: () => void;
}

function makeShimElement(tagName: string): ShimElement {
    const attrs = new Map<string, string>();
    const children: ShimElement[] = [];
    const el: ShimElement = {
        tagName,
        className: '',
        textContent: null,
        value: undefined,
        children,
        attributes: attrs,
        parent: null,
        setAttribute(name: string, value: string): void {
            attrs.set(name, value);
        },
        appendChild(child: ModalElement): ModalElement {
            const c = child as ShimElement;
            c.parent = el;
            children.push(c);
            return c;
        },
        replaceChildren(...next: ModalElement[]): void {
            children.length = 0;
            for (const c of next) {
                (c as ShimElement).parent = el;
                children.push(c as ShimElement);
            }
        },
        remove(): void {
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

function makeShimDoc(): { doc: ModalDocument; root: ShimElement } {
    const root = makeShimElement('div');
    root.setAttribute('id', 'overlay-root');
    const doc: ModalDocument = {
        getElementById: (id: string): ModalElement | null =>
            id === 'overlay-root' ? root : null,
        createElement: (tag: string): ModalElement => makeShimElement(tag),
    };
    return { doc, root };
}

function findFirst(
    root: ShimElement,
    predicate: (el: ShimElement) => boolean,
): ShimElement | null {
    if (predicate(root)) return root;
    for (const c of root.children) {
        const hit = findFirst(c, predicate);
        if (hit) return hit;
    }
    return null;
}

function findByClass(root: ShimElement, cls: string): ShimElement | null {
    return findFirst(root, (el) =>
        el.className.split(/\s+/).includes(cls),
    );
}

function findByDataAction(root: ShimElement, action: string): ShimElement | null {
    return findFirst(root, (el) => el.attributes.get('data-action') === action);
}

// ---------------------------------------------------------------------------
// Fake ports
// ---------------------------------------------------------------------------

interface FakeKeydown extends KeydownPort {
    listeners: Array<(ev: CreateTaskKeydown) => void>;
    unsubCount: number;
    press(key: string): void;
}

function makeFakeKeydown(): FakeKeydown {
    const port: FakeKeydown = {
        listeners: [],
        unsubCount: 0,
        addListener(handler): CreateTaskKeydownUnsub {
            port.listeners.push(handler);
            return (): void => {
                port.unsubCount++;
            };
        },
        press(key): void {
            for (const l of [...port.listeners]) l({ key });
        },
    };
    return port;
}

interface FakeFetch {
    calls: Array<{ url: string; init: FetchRequestInit }>;
    nextOk: boolean;
    nextStatus: number;
    nextReject: Error | null;
    fn: FetchFn;
}

function makeFakeFetch(): FakeFetch {
    const fake: FakeFetch = {
        calls: [],
        nextOk: true,
        nextStatus: 201,
        nextReject: null,
        fn: async (url, init): Promise<FetchResponseLike> => {
            fake.calls.push({ url, init });
            if (fake.nextReject) throw fake.nextReject;
            return { ok: fake.nextOk, status: fake.nextStatus };
        },
    };
    return fake;
}

interface Harness {
    readonly handle: CreateTaskModalHandle;
    readonly root: ShimElement;
    readonly keydown: FakeKeydown;
    readonly fetch: FakeFetch;
    readonly toasts: ToastInput[];
    readonly closeCalls: { count: number };
    readonly submitPayloads: Array<Record<string, unknown>>;
}

function makeHarness(extra: {
    apiBase?: string;
    tasksPath?: string;
    projectId?: string;
    planId?: string;
} = {}): Harness {
    const { doc, root } = makeShimDoc();
    const keydown = makeFakeKeydown();
    const fetch = makeFakeFetch();
    const toasts: ToastInput[] = [];
    const closeCalls = { count: 0 };
    const submitPayloads: Array<Record<string, unknown>> = [];
    const handle = openCreateTaskModal({
        doc,
        keydown,
        fetch: fetch.fn,
        showToast: (t) => toasts.push(t),
        onClose: () => {
            closeCalls.count++;
        },
        onSubmit: (p) => {
            submitPayloads.push({ ...p });
        },
        ...extra,
    });
    return { handle, root, keydown, fetch, toasts, closeCalls, submitPayloads };
}

// ---------------------------------------------------------------------------
// AC #2 — the modal opens with .modal-overlay wrapping .modal-card
// ---------------------------------------------------------------------------

test('openCreateTaskModal renders .modal-overlay wrapping .modal-card', () => {
    const h = makeHarness();
    const overlay = findByClass(h.root, 'modal-overlay');
    assert.ok(overlay, 'overlay was rendered under the mount root');
    assert.equal(overlay?.attributes.get('data-overlay-id'), CREATE_TASK_OVERLAY_ID);
    assert.equal(overlay?.attributes.get('role'), 'presentation');

    const card = overlay ? findByClass(overlay, 'modal-card') : null;
    assert.ok(card, 'card was rendered inside the overlay');
    assert.equal(card?.attributes.get('role'), 'dialog');
    assert.equal(card?.attributes.get('aria-modal'), 'true');
    // The card also carries new-plan-modal modal-chrome so its visual
    // chrome stays consistent with the new-plan overlay it mirrors.
    const classes = (card?.className ?? '').split(/\s+/);
    assert.ok(classes.includes('new-plan-modal'), 'card carries new-plan-modal chrome class');
    assert.ok(classes.includes('modal-chrome'), 'card carries modal-chrome class');

    assert.equal(h.handle.isOpen(), true);
});

// ---------------------------------------------------------------------------
// AC #3 — ESC closes the modal
// ---------------------------------------------------------------------------

test('ESC closes the modal and releases the keydown listener', () => {
    const h = makeHarness();
    assert.equal(h.keydown.listeners.length, 1, 'one keydown listener registered on open');

    h.keydown.press('Escape');

    assert.equal(h.handle.isOpen(), false, 'modal reports closed after ESC');
    assert.equal(findByClass(h.root, 'modal-overlay'), null, 'overlay removed from the DOM');
    assert.equal(h.keydown.unsubCount, 1, 'keydown listener unsubscribed on close');
    assert.equal(h.closeCalls.count, 1, 'onClose callback fired exactly once');
});

test('non-Escape keys do not close the modal', () => {
    const h = makeHarness();
    h.keydown.press('Enter');
    h.keydown.press('a');
    assert.equal(h.handle.isOpen(), true, 'modal stays open for non-Escape keys');
});

// ---------------------------------------------------------------------------
// AC #3 — click-outside dismiss (overlay closes; card does not)
// ---------------------------------------------------------------------------

test('clicking the overlay backdrop closes the modal', () => {
    const h = makeHarness();
    const overlay = findByClass(h.root, 'modal-overlay') as ShimElement;
    overlay.onclick?.({ target: overlay });
    assert.equal(h.handle.isOpen(), false, 'overlay-target click closes the modal');
    assert.equal(findByClass(h.root, 'modal-overlay'), null, 'overlay removed from the DOM');
});

test('clicking inside the card does NOT close the modal', () => {
    const h = makeHarness();
    const overlay = findByClass(h.root, 'modal-overlay') as ShimElement;
    const card = findByClass(overlay, 'modal-card') as ShimElement;
    // Simulate the click bubbling up from the card to the overlay handler
    // — the production overlay handler must ignore bubbled clicks whose
    // target is not the overlay itself.
    overlay.onclick?.({ target: card });
    assert.equal(h.handle.isOpen(), true, 'click inside the card keeps the modal open');
    // And the card's own onclick is a documented no-op.
    card.onclick?.({ target: card });
    assert.equal(h.handle.isOpen(), true);
});

// ---------------------------------------------------------------------------
// AC #4 — submit POSTs to ${apiBase}${tasksPath} with the form payload
// ---------------------------------------------------------------------------

test('submit POSTs JSON to ${apiBase}/tasks and includes projectId / planId', async () => {
    const h = makeHarness({
        apiBase: 'https://board.test',
        projectId: 'pid-1',
        planId: 'plan-1',
    });

    await h.handle.submit({ title: 'Wire up modal', body: 'with body content' });

    assert.equal(h.fetch.calls.length, 1, 'fetch invoked exactly once');
    const call = h.fetch.calls[0];
    assert.equal(call.url, `https://board.test${DEFAULT_TASKS_PATH}`);
    assert.equal(call.init.method, 'POST');
    assert.equal(call.init.headers?.['Content-Type'], 'application/json');
    const parsed = JSON.parse(call.init.body ?? '{}') as Record<string, unknown>;
    assert.equal(parsed.title, 'Wire up modal');
    assert.equal(parsed.body, 'with body content');
    assert.equal(parsed.projectId, 'pid-1');
    assert.equal(parsed.planId, 'plan-1');

    assert.equal(h.submitPayloads.length, 1, 'onSubmit dispatched with the payload');
    assert.equal(h.handle.isOpen(), false, 'modal closes after a successful submit');
    assert.equal(h.closeCalls.count, 1);
});

test('apiBase trailing slash is normalised before concatenating tasksPath', async () => {
    const h = makeHarness({ apiBase: 'https://board.test/' });
    await h.handle.submit({ title: 't' });
    assert.equal(h.fetch.calls[0].url, 'https://board.test/tasks');
});

test('clicking the submit button collects form input and dispatches', async () => {
    const h = makeHarness();
    const overlay = findByClass(h.root, 'modal-overlay') as ShimElement;
    const card = findByClass(overlay, 'modal-card') as ShimElement;
    const titleInput = findFirst(card, (el) => el.attributes.get('data-input') === 'title');
    const bodyInput = findFirst(card, (el) => el.attributes.get('data-input') === 'body');
    const submitBtn = findByDataAction(card, 'submit');
    assert.ok(titleInput && bodyInput && submitBtn);

    titleInput!.value = 'from button';
    bodyInput!.value = 'body text';
    submitBtn!.onclick?.();
    // The button handler kicks off submit asynchronously — flush one tick.
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(h.fetch.calls.length, 1, 'submit dispatched through the button click');
    const parsed = JSON.parse(h.fetch.calls[0].init.body ?? '{}') as Record<string, unknown>;
    assert.equal(parsed.title, 'from button');
    assert.equal(parsed.body, 'body text');
});

test('empty title short-circuits submit with a toast and keeps the modal open', async () => {
    const h = makeHarness();
    await h.handle.submit({ title: '   ' });
    assert.equal(h.fetch.calls.length, 0, 'no fetch when title is blank');
    assert.equal(h.toasts.length, 1, 'a toast surfaced the validation error');
    assert.equal(h.toasts[0].kind, 'error');
    assert.equal(h.handle.isOpen(), true, 'modal stays open so the operator can retype');
    h.handle.close();
});

test('non-OK response surfaces a toast and keeps the modal open', async () => {
    const h = makeHarness();
    h.fetch.nextOk = false;
    h.fetch.nextStatus = 500;
    await h.handle.submit({ title: 'will fail' });
    assert.equal(h.toasts.length, 1);
    assert.equal(h.toasts[0].kind, 'error');
    assert.ok(h.toasts[0].message.includes('500'));
    assert.equal(h.handle.isOpen(), true, 'modal stays open on backend failure');
    assert.equal(h.submitPayloads.length, 0, 'onSubmit does not fire on a non-OK response');
});

test('fetch rejection surfaces a toast and keeps the modal open', async () => {
    const h = makeHarness();
    h.fetch.nextReject = new Error('network down');
    await h.handle.submit({ title: 'will throw' });
    assert.equal(h.toasts.length, 1);
    assert.equal(h.toasts[0].kind, 'error');
    assert.equal(h.toasts[0].message, 'network down');
    assert.equal(h.handle.isOpen(), true);
});

// ---------------------------------------------------------------------------
// AC #1 — openCreateTaskModal returns a handle that exposes close()
// ---------------------------------------------------------------------------

test('openCreateTaskModal returns a handle exposing a close function', () => {
    const h = makeHarness();
    assert.equal(typeof h.handle.close, 'function', 'close is a function');
    h.handle.close();
    assert.equal(h.handle.isOpen(), false);
    assert.equal(findByClass(h.root, 'modal-overlay'), null);
    assert.equal(h.closeCalls.count, 1);
    // close() is idempotent — calling twice does not double-fire onClose
    // or throw if the panel has already been detached.
    assert.doesNotThrow(() => h.handle.close());
    assert.equal(h.closeCalls.count, 1, 'onClose fires at most once');
});
