/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Unit tests for the AP-IFF-003 sidebar chrome module.
 *
 * Coverage targets the three event contracts called out in the task
 * acceptance criteria:
 *   1. clicking a project row emits `select:project` with the project
 *      id in `detail`.
 *   2. clicking the Worker-log button emits `open:worker-log`.
 *   3. the live-dot's `data-state` reflects the store's
 *      `sseReadyState`.
 * The renderer is also smoke-tested for badge updates so AC #1 (badge
 * renders) is covered without piling assertions onto the event tests.
 *
 * Dual-runner discovery — see `hosts/board-ui/web/board.crud.test.ts`
 * for the rationale (vitest vs node:test). This file follows the same
 * pattern so it runs under both.
 */
import * as assert from 'node:assert/strict';

import {
    deriveLiveDotState,
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
                'sidebar.spec.ts: VITEST=true but globalThis.test is missing — '
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
// Store fake — single subscriber, manual `set()` for re-render
// ---------------------------------------------------------------------------

function emptyState(): SidebarStoreState {
    return { projects: [], pendingProjections: 0, sseReadyState: 0 };
}

interface FakeStore extends SidebarStore {
    set(next: SidebarStoreState): void;
    listenerCount(): number;
}

function makeFakeStore(initial: SidebarStoreState = emptyState()): FakeStore {
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
        listenerCount() {
            return listeners.size;
        },
    };
}

// ---------------------------------------------------------------------------
// CustomEvent factory — plain-object fallback so tests can read `detail`
// ---------------------------------------------------------------------------

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

function projectRow(root: ShimElement, projectId: string): ShimElement {
    const row = findFirst(
        root,
        (el) => el.attributes.get('data-project-id') === projectId,
    );
    if (!row) throw new Error(`no project row for "${projectId}"`);
    return row;
}

function workerLogButton(root: ShimElement): ShimElement {
    const btn = findFirst(
        root,
        (el) => el.attributes.get('data-action') === 'open-worker-log',
    );
    if (!btn) throw new Error('no worker-log button rendered');
    return btn;
}

function liveDot(root: ShimElement): ShimElement {
    const dot = findFirst(root, (el) => el.attributes.has('data-sidebar-live-dot'));
    if (!dot) throw new Error('no live-dot rendered');
    return dot;
}

function badge(root: ShimElement): ShimElement {
    const b = findFirst(root, (el) => el.attributes.has('data-sidebar-pending-badge'));
    if (!b) throw new Error('no pending-projections badge rendered');
    return b;
}

function click(el: ShimElement): void {
    if (!el.onclick) throw new Error('clicked element has no onclick');
    el.onclick();
}

// ---------------------------------------------------------------------------
// deriveLiveDotState — pure mapping
// ---------------------------------------------------------------------------

test('deriveLiveDotState: 0 → connecting, 1 → open, 2 → closed, fallback → closed', () => {
    assert.equal(deriveLiveDotState(0), 'connecting');
    assert.equal(deriveLiveDotState(1), 'open');
    assert.equal(deriveLiveDotState(2), 'closed');
    assert.equal(deriveLiveDotState(-1), 'closed');
    assert.equal(deriveLiveDotState(Number.NaN), 'closed');
});

// ---------------------------------------------------------------------------
// init / first render — AC #1 (project list + badge)
// ---------------------------------------------------------------------------

test('init: first render mounts a project row per store project with id + name', () => {
    const root = makeShimRoot();
    const store = makeFakeStore({
        projects: [
            { id: 'p1', name: 'Pipeline' },
            { id: 'p2', name: 'Mobile' },
        ],
        pendingProjections: 0,
        sseReadyState: 1,
    });
    init(root, store, { doc: makeShimDocument(), createCustomEvent: makeEvent });

    const rows = findAll(root, (el) =>
        el.attributes.has('data-sidebar-project-row'),
    );
    assert.equal(rows.length, 2);
    assert.deepEqual(
        rows.map((r) => r.attributes.get('data-project-id')),
        ['p1', 'p2'],
    );
    const names = findAll(root, (el) =>
        el.attributes.has('data-sidebar-project-name'),
    ).map((n) => n.textContent);
    assert.deepEqual(names, ['Pipeline', 'Mobile']);
});

test('init: empty project list renders the "No projects" placeholder', () => {
    const root = makeShimRoot();
    const store = makeFakeStore();
    init(root, store, { doc: makeShimDocument(), createCustomEvent: makeEvent });
    const empty = findFirst(root, (el) => el.attributes.has('data-empty'));
    assert.ok(empty, 'expected an empty-state row');
    assert.equal(empty!.textContent, 'No projects');
});

// ---------------------------------------------------------------------------
// AC #2 — project click emits select:project CustomEvent with id detail
// ---------------------------------------------------------------------------

test('clicking a project row dispatches select:project with the project id in detail', () => {
    const root = makeShimRoot();
    const store = makeFakeStore({
        projects: [{ id: 'pickme', name: 'Pickme' }],
        pendingProjections: 0,
        sseReadyState: 1,
    });
    const captured: SidebarEvent[] = [];
    addListener(root, 'select:project', (e) => {
        captured.push(e);
    });

    init(root, store, { doc: makeShimDocument(), createCustomEvent: makeEvent });
    click(projectRow(root, 'pickme'));

    assert.equal(captured.length, 1);
    assert.equal(captured[0].type, 'select:project');
    assert.equal(captured[0].detail, 'pickme');
    assert.equal(captured[0].bubbles, true);
});

// ---------------------------------------------------------------------------
// AC #3 — Worker-log button emits open:worker-log CustomEvent
// ---------------------------------------------------------------------------

test('clicking the Worker-log button dispatches open:worker-log', () => {
    const root = makeShimRoot();
    const store = makeFakeStore();
    const captured: SidebarEvent[] = [];
    addListener(root, 'open:worker-log', (e) => {
        captured.push(e);
    });

    init(root, store, { doc: makeShimDocument(), createCustomEvent: makeEvent });
    click(workerLogButton(root));

    assert.equal(captured.length, 1);
    assert.equal(captured[0].type, 'open:worker-log');
    assert.equal(captured[0].detail, undefined);
    assert.equal(captured[0].bubbles, true);
});

// ---------------------------------------------------------------------------
// AC #4 — live-dot reflects SSE connection state on store update
// ---------------------------------------------------------------------------

test('live-dot data-state tracks the store sseReadyState across re-renders', () => {
    const root = makeShimRoot();
    const store = makeFakeStore({
        projects: [],
        pendingProjections: 0,
        sseReadyState: 0, // connecting
    });
    init(root, store, { doc: makeShimDocument(), createCustomEvent: makeEvent });

    assert.equal(liveDot(root).attributes.get('data-state'), 'connecting');

    store.set({ projects: [], pendingProjections: 0, sseReadyState: 1 });
    assert.equal(liveDot(root).attributes.get('data-state'), 'open');

    store.set({ projects: [], pendingProjections: 0, sseReadyState: 2 });
    assert.equal(liveDot(root).attributes.get('data-state'), 'closed');
});

// ---------------------------------------------------------------------------
// Badge — hidden at 0, visible with count when positive
// ---------------------------------------------------------------------------

test('badge stays hidden when pendingProjections is 0 and surfaces the count otherwise', () => {
    const root = makeShimRoot();
    const store = makeFakeStore({ projects: [], pendingProjections: 0, sseReadyState: 1 });
    init(root, store, { doc: makeShimDocument(), createCustomEvent: makeEvent });

    assert.equal(badge(root).hidden, true);

    store.set({ projects: [], pendingProjections: 3, sseReadyState: 1 });
    const visible = badge(root);
    assert.equal(visible.hidden, false);
    assert.equal(visible.textContent, '3 pending');
    assert.equal(visible.attributes.get('data-pending-count'), '3');

    store.set({ projects: [], pendingProjections: 0, sseReadyState: 1 });
    assert.equal(badge(root).hidden, true);
});

// ---------------------------------------------------------------------------
// Re-render on project list changes
// ---------------------------------------------------------------------------

test('store updates with a new project list trigger a re-render', () => {
    const root = makeShimRoot();
    const store = makeFakeStore({
        projects: [{ id: 'p1', name: 'One' }],
        pendingProjections: 0,
        sseReadyState: 1,
    });
    init(root, store, { doc: makeShimDocument(), createCustomEvent: makeEvent });
    assert.equal(
        findAll(root, (el) => el.attributes.has('data-sidebar-project-row')).length,
        1,
    );

    store.set({
        projects: [
            { id: 'p1', name: 'One' },
            { id: 'p2', name: 'Two' },
            { id: 'p3', name: 'Three' },
        ],
        pendingProjections: 0,
        sseReadyState: 1,
    });
    const rows = findAll(root, (el) =>
        el.attributes.has('data-sidebar-project-row'),
    );
    assert.equal(rows.length, 3);
    assert.deepEqual(
        rows.map((r) => r.attributes.get('data-project-id')),
        ['p1', 'p2', 'p3'],
    );
});

// ---------------------------------------------------------------------------
// destroy() detaches the store subscription
// ---------------------------------------------------------------------------

test('destroy() unsubscribes from the store and stops reacting to updates', () => {
    const root = makeShimRoot();
    const store = makeFakeStore({
        projects: [{ id: 'p1', name: 'One' }],
        pendingProjections: 0,
        sseReadyState: 1,
    });
    const handle = init(root, store, {
        doc: makeShimDocument(),
        createCustomEvent: makeEvent,
    });
    assert.equal(store.listenerCount(), 1);

    handle.destroy();
    assert.equal(store.listenerCount(), 0);

    // A post-destroy push must not crash and must not re-render.
    store.set({
        projects: [
            { id: 'p1', name: 'One' },
            { id: 'p2', name: 'Two' },
        ],
        pendingProjections: 0,
        sseReadyState: 1,
    });
    assert.equal(
        findAll(root, (el) => el.attributes.has('data-sidebar-project-row')).length,
        1,
    );
});
