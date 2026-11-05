/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Unit tests for the AP-IFF-012 investigate modal.
 *
 * Coverage maps to the task's five acceptance criteria:
 *   AC #1 — renders an open-investigations list from the projection store
 *   AC #2 — Create form dispatches CreateInvestigation
 *   AC #3 — Implement action dispatches ImplementFromInvestigation
 *   AC #4 — Dismiss action dispatches DismissInvestigation
 *   AC #5 — covered transitively by AC #2-#4 (one test per action)
 *
 * Dual-runner discovery — see `hosts/board-ui/web/board.crud.test.ts`
 * for the rationale (vitest vs node:test). This file follows the same
 * pattern so it runs under both.
 */
import * as assert from 'node:assert/strict';

import {
    init,
    type InvestigateCommand,
    type InvestigateDocument,
    type InvestigateElement,
    type InvestigateStore,
    type InvestigateStoreState,
    type InvestigateToastOptions,
    type OpenInvestigation,
} from '../../../hosts/board-ui/client/modals/investigate';
import { BoardUiCommands } from '../../../hosts/board-ui/commands';
import { InvestigationCommands } from '../../../core/commands';

// ---------------------------------------------------------------------------
// Dual-runner test() shim
// ---------------------------------------------------------------------------

type TestFn = (name: string, fn: () => void | Promise<void>) => void;

const test: TestFn = (((): TestFn => {
    if (process.env.VITEST) {
        const gt = (globalThis as { test?: TestFn }).test;
        if (typeof gt !== 'function') {
            throw new Error(
                'investigate.spec.ts: VITEST=true but globalThis.test is missing — '
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

interface ShimElement extends InvestigateElement {
    tagName: string;
    attributes: Map<string, string>;
    children: ShimElement[];
    onclick?: () => void | Promise<void>;
    onsubmit?: (event: { preventDefault?: () => void }) => void | Promise<void>;
}

function makeShimElement(tagName: string): ShimElement {
    const attrs = new Map<string, string>();
    const children: ShimElement[] = [];
    const el: ShimElement = {
        tagName,
        className: '',
        textContent: null,
        value: '',
        attributes: attrs,
        children,
        setAttribute(name: string, value: string): void {
            attrs.set(name, value);
        },
        appendChild(child: InvestigateElement): InvestigateElement {
            children.push(child as ShimElement);
            return child;
        },
        replaceChildren(...next: InvestigateElement[]): void {
            children.length = 0;
            for (const c of next) children.push(c as ShimElement);
        },
    };
    return el;
}

function makeShimDocument(): InvestigateDocument {
    return {
        createElement(tagName: string): InvestigateElement {
            return makeShimElement(tagName);
        },
    };
}

function makeShimRoot(): ShimElement {
    return makeShimElement('div');
}

// ---------------------------------------------------------------------------
// Store fake — single subscriber, manual `set()` for re-render
// ---------------------------------------------------------------------------

function emptyState(): InvestigateStoreState {
    return { openInvestigations: [] };
}

interface FakeStore extends InvestigateStore {
    set(next: InvestigateStoreState): void;
    listenerCount(): number;
}

function makeFakeStore(initial: InvestigateStoreState = emptyState()): FakeStore {
    let current = initial;
    const listeners = new Set<(state: InvestigateStoreState) => void>();
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
// Dispatcher recorder
// ---------------------------------------------------------------------------

interface Recorder {
    readonly calls: InvestigateCommand[];
    dispatch: (cmd: InvestigateCommand) => Promise<void>;
}

function makeRecorder(): Recorder {
    const calls: InvestigateCommand[] = [];
    return {
        calls,
        dispatch: async (cmd) => {
            calls.push(cmd);
        },
    };
}

/**
 * Recorder + a dispatcher that always rejects. Lets the toast tests
 * cover the failure branch without re-implementing the recorder shape.
 */
function makeRejectingRecorder(reason: unknown = new Error('dispatch failed')): Recorder {
    const calls: InvestigateCommand[] = [];
    return {
        calls,
        dispatch: async (cmd) => {
            calls.push(cmd);
            throw reason;
        },
    };
}

interface ToastRecorder {
    readonly calls: InvestigateToastOptions[];
    readonly showToast: (opts: InvestigateToastOptions) => void;
}

function makeToastRecorder(): ToastRecorder {
    const calls: InvestigateToastOptions[] = [];
    return {
        calls,
        showToast: (opts) => {
            calls.push(opts);
        },
    };
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

function rowFor(root: ShimElement, taskId: string, reportId: string): ShimElement {
    const row = findFirst(
        root,
        (el) =>
            el.attributes.get('data-task-id') === taskId &&
            el.attributes.get('data-report-id') === reportId,
    );
    if (!row) throw new Error(`no row for (${taskId}, ${reportId})`);
    return row;
}

function child(parent: ShimElement, attr: string): ShimElement {
    const hit = findFirst(parent, (el) => el.attributes.has(attr));
    if (!hit) throw new Error(`no descendant with attribute "${attr}"`);
    return hit;
}

function createForm(root: ShimElement): ShimElement {
    return child(root, 'data-investigate-create-form');
}

function taskIdInput(root: ShimElement): ShimElement {
    return child(root, 'data-investigate-task-id');
}

function questionInput(root: ShimElement): ShimElement {
    return child(root, 'data-investigate-question');
}

// ---------------------------------------------------------------------------
// AC #1 — list renders from projection store
// ---------------------------------------------------------------------------

test('init: renders an open-investigations row per store entry with task + report ids', () => {
    const root = makeShimRoot();
    const investigations: ReadonlyArray<OpenInvestigation> = [
        { taskId: 't1', reportId: 'r1', question: 'why does X happen?', taskTitle: 'Task one' },
        { taskId: 't2', reportId: 'r2', question: 'why does Y happen?' },
    ];
    const store = makeFakeStore({ openInvestigations: investigations });
    const recorder = makeRecorder();
    init(root, store, recorder.dispatch, { doc: makeShimDocument() });

    const rows = findAll(root, (el) => el.attributes.has('data-investigate-row'));
    assert.equal(rows.length, 2);
    assert.deepEqual(
        rows.map((r) => r.attributes.get('data-task-id')),
        ['t1', 't2'],
    );
    assert.deepEqual(
        rows.map((r) => r.attributes.get('data-report-id')),
        ['r1', 'r2'],
    );

    const titles = findAll(root, (el) =>
        el.attributes.has('data-investigate-row-title'),
    ).map((t) => t.textContent);
    assert.deepEqual(titles, ['Task one', 't2']);

    const questions = findAll(root, (el) =>
        el.attributes.has('data-investigate-row-question'),
    ).map((q) => q.textContent);
    assert.deepEqual(questions, ['why does X happen?', 'why does Y happen?']);
});

test('init: empty open-investigations list renders the placeholder', () => {
    const root = makeShimRoot();
    const store = makeFakeStore();
    const recorder = makeRecorder();
    init(root, store, recorder.dispatch, { doc: makeShimDocument() });

    const empty = findFirst(root, (el) => el.attributes.has('data-empty'));
    assert.ok(empty, 'expected an empty-state row');
    assert.equal(empty!.textContent, 'No open investigations');
});

// ---------------------------------------------------------------------------
// AC #2 — Create form dispatches CreateInvestigation
// ---------------------------------------------------------------------------

test('submitting the create form dispatches CreateInvestigation with taskId + question', () => {
    const root = makeShimRoot();
    const store = makeFakeStore();
    const recorder = makeRecorder();
    init(root, store, recorder.dispatch, { doc: makeShimDocument() });

    const form = createForm(root);
    taskIdInput(root).value = 'task-42';
    questionInput(root).value = 'is the cache invalidation race real?';

    let prevented = false;
    form.onsubmit?.({ preventDefault: (): void => { prevented = true; } });

    assert.equal(prevented, true, 'submit handler must preventDefault');
    assert.equal(recorder.calls.length, 1);
    const cmd = recorder.calls[0];
    assert.equal(cmd.type, BoardUiCommands.CREATE_INVESTIGATION);
    assert.deepEqual(cmd.payload, {
        taskId: 'task-42',
        question: 'is the cache invalidation race real?',
    });
});

test('create form ignores submissions with empty taskId or question', () => {
    const root = makeShimRoot();
    const store = makeFakeStore();
    const recorder = makeRecorder();
    init(root, store, recorder.dispatch, { doc: makeShimDocument() });

    const form = createForm(root);

    // Both empty.
    form.onsubmit?.({ preventDefault: (): void => {} });
    assert.equal(recorder.calls.length, 0);

    // taskId only.
    taskIdInput(root).value = 't';
    questionInput(root).value = '';
    form.onsubmit?.({ preventDefault: (): void => {} });
    assert.equal(recorder.calls.length, 0);

    // question only.
    taskIdInput(root).value = '';
    questionInput(root).value = 'why?';
    form.onsubmit?.({ preventDefault: (): void => {} });
    assert.equal(recorder.calls.length, 0);
});

// ---------------------------------------------------------------------------
// AC #3 — Implement action dispatches ImplementFromInvestigation
// ---------------------------------------------------------------------------

test('clicking Implement on a row dispatches ImplementFromInvestigation with (taskId, reportId)', () => {
    const root = makeShimRoot();
    const store = makeFakeStore({
        openInvestigations: [
            { taskId: 'task-1', reportId: 'report-7', question: 'why?' },
        ],
    });
    const recorder = makeRecorder();
    init(root, store, recorder.dispatch, { doc: makeShimDocument() });

    const row = rowFor(root, 'task-1', 'report-7');
    const btn = child(row, 'data-investigate-implement');
    if (!btn.onclick) throw new Error('Implement button has no onclick');
    btn.onclick();

    assert.equal(recorder.calls.length, 1);
    const cmd = recorder.calls[0];
    assert.equal(cmd.type, InvestigationCommands.IMPLEMENT_FROM_INVESTIGATION);
    assert.deepEqual(cmd.payload, { taskId: 'task-1', reportId: 'report-7' });
});

// ---------------------------------------------------------------------------
// AC #4 — Dismiss action dispatches DismissInvestigation
// ---------------------------------------------------------------------------

test('clicking Dismiss on a row dispatches DismissInvestigation with (taskId, reportId)', () => {
    const root = makeShimRoot();
    const store = makeFakeStore({
        openInvestigations: [
            { taskId: 'task-1', reportId: 'report-7', question: 'why?' },
        ],
    });
    const recorder = makeRecorder();
    init(root, store, recorder.dispatch, { doc: makeShimDocument() });

    const row = rowFor(root, 'task-1', 'report-7');
    const btn = child(row, 'data-investigate-dismiss');
    if (!btn.onclick) throw new Error('Dismiss button has no onclick');
    btn.onclick();

    assert.equal(recorder.calls.length, 1);
    const cmd = recorder.calls[0];
    assert.equal(cmd.type, InvestigationCommands.DISMISS_INVESTIGATION);
    assert.deepEqual(cmd.payload, { taskId: 'task-1', reportId: 'report-7' });
});

test('Dismiss forwards a non-empty reason onto the command payload', () => {
    const root = makeShimRoot();
    const store = makeFakeStore({
        openInvestigations: [
            { taskId: 'task-1', reportId: 'report-7', question: 'why?' },
        ],
    });
    const recorder = makeRecorder();
    init(root, store, recorder.dispatch, { doc: makeShimDocument() });

    const row = rowFor(root, 'task-1', 'report-7');
    child(row, 'data-investigate-row-reason').value = 'not relevant anymore';
    const btn = child(row, 'data-investigate-dismiss');
    btn.onclick!();

    assert.equal(recorder.calls.length, 1);
    assert.deepEqual(recorder.calls[0].payload, {
        taskId: 'task-1',
        reportId: 'report-7',
        reason: 'not relevant anymore',
    });
});

test('Dismiss omits reason when the input is empty or whitespace-only', () => {
    const root = makeShimRoot();
    const store = makeFakeStore({
        openInvestigations: [
            { taskId: 'task-1', reportId: 'report-7', question: 'why?' },
        ],
    });
    const recorder = makeRecorder();
    init(root, store, recorder.dispatch, { doc: makeShimDocument() });

    const row = rowFor(root, 'task-1', 'report-7');
    child(row, 'data-investigate-row-reason').value = '   ';
    const btn = child(row, 'data-investigate-dismiss');
    btn.onclick!();

    assert.equal(recorder.calls.length, 1);
    const payload = recorder.calls[0].payload as unknown as Record<string, unknown>;
    assert.equal(
        Object.prototype.hasOwnProperty.call(payload, 'reason'),
        false,
        'empty reason → no reason key on the payload',
    );
});

// ---------------------------------------------------------------------------
// Re-render on store updates
// ---------------------------------------------------------------------------

test('store updates with new open investigations trigger a re-render', () => {
    const root = makeShimRoot();
    const store = makeFakeStore({
        openInvestigations: [
            { taskId: 't1', reportId: 'r1', question: 'q1' },
        ],
    });
    const recorder = makeRecorder();
    init(root, store, recorder.dispatch, { doc: makeShimDocument() });

    assert.equal(
        findAll(root, (el) => el.attributes.has('data-investigate-row')).length,
        1,
    );

    store.set({
        openInvestigations: [
            { taskId: 't1', reportId: 'r1', question: 'q1' },
            { taskId: 't2', reportId: 'r2', question: 'q2' },
            { taskId: 't3', reportId: 'r3', question: 'q3' },
        ],
    });

    const rows = findAll(root, (el) => el.attributes.has('data-investigate-row'));
    assert.equal(rows.length, 3);
    assert.deepEqual(
        rows.map((r) => r.attributes.get('data-task-id')),
        ['t1', 't2', 't3'],
    );
});

// ---------------------------------------------------------------------------
// destroy() detaches the store subscription
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Toast wiring — reviewer feedback. Each of the three operator actions
// (Create / Implement / Dismiss) must surface a success toast on resolve
// and an error toast on reject through the injected `showToast` port.
// ---------------------------------------------------------------------------

test('Create form: success path raises a success toast through the showToast port', async () => {
    const root = makeShimRoot();
    const store = makeFakeStore();
    const recorder = makeRecorder();
    const toasts = makeToastRecorder();
    init(root, store, recorder.dispatch, {
        doc: makeShimDocument(),
        showToast: toasts.showToast,
    });

    const form = createForm(root);
    taskIdInput(root).value = 'task-42';
    questionInput(root).value = 'why?';

    await form.onsubmit?.({ preventDefault: (): void => {} });

    assert.equal(toasts.calls.length, 1);
    assert.equal(toasts.calls[0].kind, 'success');
    assert.equal(toasts.calls[0].message, 'Investigation created');
});

test('Create form: failure path raises an error toast through the showToast port', async () => {
    const root = makeShimRoot();
    const store = makeFakeStore();
    const recorder = makeRejectingRecorder();
    const toasts = makeToastRecorder();
    init(root, store, recorder.dispatch, {
        doc: makeShimDocument(),
        showToast: toasts.showToast,
    });

    const form = createForm(root);
    taskIdInput(root).value = 'task-42';
    questionInput(root).value = 'why?';

    await form.onsubmit?.({ preventDefault: (): void => {} });

    assert.equal(recorder.calls.length, 1, 'dispatch must still have been attempted');
    assert.equal(toasts.calls.length, 1);
    assert.equal(toasts.calls[0].kind, 'error');
    assert.equal(toasts.calls[0].message, 'Failed to create investigation');
});

test('Implement: success path raises a success toast through the showToast port', async () => {
    const root = makeShimRoot();
    const store = makeFakeStore({
        openInvestigations: [
            { taskId: 'task-1', reportId: 'report-7', question: 'why?' },
        ],
    });
    const recorder = makeRecorder();
    const toasts = makeToastRecorder();
    init(root, store, recorder.dispatch, {
        doc: makeShimDocument(),
        showToast: toasts.showToast,
    });

    const row = rowFor(root, 'task-1', 'report-7');
    const btn = child(row, 'data-investigate-implement');
    await btn.onclick!();

    assert.equal(toasts.calls.length, 1);
    assert.equal(toasts.calls[0].kind, 'success');
    assert.equal(toasts.calls[0].message, 'Investigation queued for implementation');
});

test('Implement: failure path raises an error toast through the showToast port', async () => {
    const root = makeShimRoot();
    const store = makeFakeStore({
        openInvestigations: [
            { taskId: 'task-1', reportId: 'report-7', question: 'why?' },
        ],
    });
    const recorder = makeRejectingRecorder();
    const toasts = makeToastRecorder();
    init(root, store, recorder.dispatch, {
        doc: makeShimDocument(),
        showToast: toasts.showToast,
    });

    const row = rowFor(root, 'task-1', 'report-7');
    const btn = child(row, 'data-investigate-implement');
    await btn.onclick!();

    assert.equal(toasts.calls.length, 1);
    assert.equal(toasts.calls[0].kind, 'error');
    assert.equal(toasts.calls[0].message, 'Failed to implement investigation');
});

test('Dismiss: success path raises a success toast through the showToast port', async () => {
    const root = makeShimRoot();
    const store = makeFakeStore({
        openInvestigations: [
            { taskId: 'task-1', reportId: 'report-7', question: 'why?' },
        ],
    });
    const recorder = makeRecorder();
    const toasts = makeToastRecorder();
    init(root, store, recorder.dispatch, {
        doc: makeShimDocument(),
        showToast: toasts.showToast,
    });

    const row = rowFor(root, 'task-1', 'report-7');
    const btn = child(row, 'data-investigate-dismiss');
    await btn.onclick!();

    assert.equal(toasts.calls.length, 1);
    assert.equal(toasts.calls[0].kind, 'success');
    assert.equal(toasts.calls[0].message, 'Investigation dismissed');
});

test('Dismiss: failure path raises an error toast through the showToast port', async () => {
    const root = makeShimRoot();
    const store = makeFakeStore({
        openInvestigations: [
            { taskId: 'task-1', reportId: 'report-7', question: 'why?' },
        ],
    });
    const recorder = makeRejectingRecorder();
    const toasts = makeToastRecorder();
    init(root, store, recorder.dispatch, {
        doc: makeShimDocument(),
        showToast: toasts.showToast,
    });

    const row = rowFor(root, 'task-1', 'report-7');
    const btn = child(row, 'data-investigate-dismiss');
    await btn.onclick!();

    assert.equal(toasts.calls.length, 1);
    assert.equal(toasts.calls[0].kind, 'error');
    assert.equal(toasts.calls[0].message, 'Failed to dismiss investigation');
});

test('omitting showToast does not break the dispatch wiring', async () => {
    const root = makeShimRoot();
    const store = makeFakeStore();
    const recorder = makeRecorder();
    init(root, store, recorder.dispatch, { doc: makeShimDocument() });

    const form = createForm(root);
    taskIdInput(root).value = 'task-42';
    questionInput(root).value = 'why?';
    await form.onsubmit?.({ preventDefault: (): void => {} });

    assert.equal(recorder.calls.length, 1);
});

test('destroy() unsubscribes from the store and stops reacting to updates', () => {
    const root = makeShimRoot();
    const store = makeFakeStore({
        openInvestigations: [
            { taskId: 't1', reportId: 'r1', question: 'q1' },
        ],
    });
    const recorder = makeRecorder();
    const handle = init(root, store, recorder.dispatch, { doc: makeShimDocument() });
    assert.equal(store.listenerCount(), 1);

    handle.destroy();
    assert.equal(store.listenerCount(), 0);

    // A post-destroy push must not crash and must not re-render.
    store.set({
        openInvestigations: [
            { taskId: 't1', reportId: 'r1', question: 'q1' },
            { taskId: 't2', reportId: 'r2', question: 'q2' },
        ],
    });
    assert.equal(
        findAll(root, (el) => el.attributes.has('data-investigate-row')).length,
        1,
    );
});
