/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Unit tests for the AP-PAO-017 empty-state New Project CTA.
 *
 * Sibling to `sidebar.spec.ts` — that file covers the AP-IFF-003
 * contract (project rows, badge, live-dot, worker-log button); this one
 * pins the AP-PAO-017 addition: when the projection reports zero
 * projects, the sidebar renders a primary CTA whose click dispatches
 * `open:new-project`, and the populated-state path is left unchanged.
 *
 * Dual-runner discovery — see `hosts/board-ui/web/board.crud.test.ts`
 * for the rationale (vitest vs node:test). This file follows the same
 * pattern so it runs under both.
 */
import * as assert from 'node:assert/strict';

import {
    init,
    type SidebarDocument,
    type SidebarElement,
    type SidebarEvent,
    type SidebarStore,
    type SidebarStoreState,
} from './sidebar';

// ---------------------------------------------------------------------------
// Dual-runner test() shim
// ---------------------------------------------------------------------------

type TestFn = (name: string, fn: () => void | Promise<void>) => void;

const test: TestFn = (((): TestFn => {
    if (process.env.VITEST) {
        const gt = (globalThis as { test?: TestFn }).test;
        if (typeof gt !== 'function') {
            throw new Error(
                'sidebar.test.ts: VITEST=true but globalThis.test is missing — '
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
// Minimal DOM shim (mirrors sidebar.spec.ts)
// ---------------------------------------------------------------------------

interface ShimElement extends SidebarElement {
    tagName: string;
    attributes: Map<string, string>;
    children: ShimElement[];
    listeners: Map<string, Array<(event: SidebarEvent) => void>>;
    dispatched: SidebarEvent[];
    onclick?: () => void;
}

function makeShimElement(tagName: string): ShimElement {
    const attrs = new Map<string, string>();
    const children: ShimElement[] = [];
    const listeners = new Map<string, Array<(event: SidebarEvent) => void>>();
    const dispatched: SidebarEvent[] = [];
    const el: ShimElement = {
        tagName,
        className: '',
        textContent: null,
        hidden: false,
        attributes: attrs,
        children,
        listeners,
        dispatched,
        setAttribute(name: string, value: string): void {
            attrs.set(name, value);
        },
        appendChild(child: SidebarElement): SidebarElement {
            children.push(child as ShimElement);
            return child;
        },
        replaceChildren(...next: SidebarElement[]): void {
            children.length = 0;
            for (const c of next) children.push(c as ShimElement);
        },
        dispatchEvent(event: SidebarEvent): boolean {
            dispatched.push(event);
            const ls = listeners.get(event.type) ?? [];
            for (const l of ls) l(event);
            return true;
        },
    };
    return el;
}

function makeShimDocument(): SidebarDocument {
    return {
        createElement(tagName: string): SidebarElement {
            return makeShimElement(tagName);
        },
    };
}

function makeShimRoot(): ShimElement {
    return makeShimElement('aside');
}

function addListener(
    el: ShimElement,
    type: string,
    listener: (event: SidebarEvent) => void,
): void {
    const bucket = el.listeners.get(type) ?? [];
    bucket.push(listener);
    el.listeners.set(type, bucket);
}

// ---------------------------------------------------------------------------
// Store fake
// ---------------------------------------------------------------------------

interface FakeStore extends SidebarStore {
    set(next: SidebarStoreState): void;
}

function makeFakeStore(initial: SidebarStoreState): FakeStore {
    let current = initial;
    const listeners = new Set<(state: SidebarStoreState) => void>();
    return {
        getState: () => current,
        subscribe(listener) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        set(next) {
            current = next;
            for (const l of listeners) l(current);
        },
    };
}

function makeEvent(
    type: string,
    init: { detail?: unknown; bubbles?: boolean },
): SidebarEvent {
    return { type, detail: init.detail, bubbles: init.bubbles };
}

// ---------------------------------------------------------------------------
// Tree-walking helpers
// ---------------------------------------------------------------------------

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

function findAll(
    root: ShimElement,
    predicate: (el: ShimElement) => boolean,
): ShimElement[] {
    const out: ShimElement[] = [];
    const walk = (n: ShimElement): void => {
        if (predicate(n)) out.push(n);
        for (const c of n.children) walk(c);
    };
    walk(root);
    return out;
}

function findCta(root: ShimElement): ShimElement | null {
    return findFirst(root, (el) => el.attributes.has('data-sidebar-new-project-cta'));
}

function emptyStateRoot(): SidebarStoreState {
    return { projects: [], pendingProjections: 0, sseReadyState: 1 };
}

function populatedStateRoot(): SidebarStoreState {
    return {
        projects: [
            { id: 'p1', name: 'Pipeline' },
            { id: 'p2', name: 'Mobile' },
        ],
        pendingProjections: 0,
        sseReadyState: 1,
    };
}

// ---------------------------------------------------------------------------
// AC #1 — Empty state renders the CTA
// ---------------------------------------------------------------------------

test('empty state: renders a "New project" CTA when projections has zero projects', () => {
    const root = makeShimRoot();
    init(root, makeFakeStore(emptyStateRoot()), {
        doc: makeShimDocument(),
        createCustomEvent: makeEvent,
    });

    const cta = findCta(root);
    assert.ok(cta, 'expected an empty-state CTA button');
    assert.equal(cta!.tagName, 'button');
    assert.equal(cta!.attributes.get('type'), 'button');
    assert.equal(cta!.attributes.get('data-action'), 'open-new-project');
    assert.equal(cta!.textContent, '+ New project');
});

// ---------------------------------------------------------------------------
// AC #2 — Click dispatches open:new-project (which the host wires to the
// AP-PAO-014 new-project modal)
// ---------------------------------------------------------------------------

test('empty state: clicking the CTA dispatches open:new-project', () => {
    const root = makeShimRoot();
    const captured: SidebarEvent[] = [];
    addListener(root, 'open:new-project', (e) => {
        captured.push(e);
    });

    init(root, makeFakeStore(emptyStateRoot()), {
        doc: makeShimDocument(),
        createCustomEvent: makeEvent,
    });

    const cta = findCta(root);
    assert.ok(cta, 'expected an empty-state CTA button');
    if (!cta!.onclick) throw new Error('CTA has no onclick handler');
    cta!.onclick();

    assert.equal(captured.length, 1);
    assert.equal(captured[0].type, 'open:new-project');
    assert.equal(captured[0].detail, undefined);
    assert.equal(captured[0].bubbles, true);
});

// ---------------------------------------------------------------------------
// AC #3 — Store transition empty → populated removes the CTA and renders
// the project rows (validates the re-render path used after a successful
// CreateProject command surfaces the new project via the SSE projection).
// ---------------------------------------------------------------------------

test('transition empty → populated removes the CTA and renders project rows', () => {
    const root = makeShimRoot();
    const store = makeFakeStore(emptyStateRoot());
    init(root, store, { doc: makeShimDocument(), createCustomEvent: makeEvent });

    assert.ok(findCta(root), 'expected CTA in empty state');

    store.set({
        projects: [{ id: 'fresh', name: 'Fresh project' }],
        pendingProjections: 0,
        sseReadyState: 1,
    });

    assert.equal(findCta(root), null, 'CTA must not render once a project exists');
    const rows = findAll(root, (el) =>
        el.attributes.has('data-sidebar-project-row'),
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].attributes.get('data-project-id'), 'fresh');
});

// ---------------------------------------------------------------------------
// AC #4 — Populated state path is unchanged (no CTA when projects exist)
// ---------------------------------------------------------------------------

test('populated state: no CTA is rendered when projects are present', () => {
    const root = makeShimRoot();
    init(root, makeFakeStore(populatedStateRoot()), {
        doc: makeShimDocument(),
        createCustomEvent: makeEvent,
    });

    assert.equal(findCta(root), null, 'populated state must not render the CTA');
    // And the existing populated-state contract is intact: two rows in,
    // two rows out.
    const rows = findAll(root, (el) =>
        el.attributes.has('data-sidebar-project-row'),
    );
    assert.equal(rows.length, 2);
});

// ---------------------------------------------------------------------------
// Click events are scoped to the empty state — once we transition to a
// populated list, clicks on a project row dispatch select:project, never
// open:new-project. Guards against any stale handler bleed-through after
// a re-render.
// ---------------------------------------------------------------------------

test('after empty → populated transition, project-row clicks do not fire open:new-project', () => {
    const root = makeShimRoot();
    const store = makeFakeStore(emptyStateRoot());
    const captured: SidebarEvent[] = [];
    addListener(root, 'open:new-project', (e) => {
        captured.push(e);
    });

    init(root, store, { doc: makeShimDocument(), createCustomEvent: makeEvent });
    store.set({
        projects: [{ id: 'p1', name: 'Pipeline' }],
        pendingProjections: 0,
        sseReadyState: 1,
    });

    const row = findFirst(
        root,
        (el) => el.attributes.get('data-project-id') === 'p1',
    );
    assert.ok(row, 'expected project row after re-render');
    if (!row!.onclick) throw new Error('row has no onclick');
    row!.onclick();

    assert.equal(captured.length, 0);
});
