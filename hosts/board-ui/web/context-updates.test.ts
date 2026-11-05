/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Unit tests for the AP-IFG-022 context-updates panel.
 *
 * Coverage
 * --------
 * - {@link renderPendingList} emits the documented DOM shape: one row
 *   per pending entry with Run / Skip buttons, an empty-state slot when
 *   the list is empty, and an inline error slot when a load fails.
 * - The Run / Skip handlers fire with the right task id.
 * - {@link createContextUpdatesController} hits the right URLs and
 *   refetches the pending list after a successful dispatch. A failed
 *   dispatch populates `dispatchErrors[taskId]` rather than throwing.
 *
 * Dual-runner discovery — see `./board.crud.test.ts` header for the
 * rationale (vitest vs node:test).
 */
import * as assert from 'node:assert/strict';

import {
    createContextUpdatesController,
    initialContextUpdatesState,
    renderPendingList,
    type ContextUpdateHandlers,
    type ContextUpdatesState,
    type FetchLike,
    type FetchRequestInit,
    type PendingContextUpdate,
    type RenderDocument,
    type RenderElement,
} from './context-updates';

// ---------------------------------------------------------------------------
// Dual-runner test() shim
// ---------------------------------------------------------------------------

type TestFn = (name: string, fn: () => void | Promise<void>) => void;

const test: TestFn = (((): TestFn => {
    if (process.env.VITEST) {
        const gt = (globalThis as { test?: TestFn }).test;
        if (typeof gt !== 'function') {
            throw new Error(
                'context-updates.test.ts: VITEST=true but globalThis.test is missing — '
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
// Minimal DOM shim — same shape as board.crud.test.ts
// ---------------------------------------------------------------------------

interface ShimElement extends RenderElement {
    tagName: string;
    children: ShimElement[];
    attributes: Map<string, string>;
    onclick?: () => void;
    disabled?: boolean;
}

function makeShimDocument(): RenderDocument {
    function makeElement(tagName: string): ShimElement {
        const attrs = new Map<string, string>();
        const children: ShimElement[] = [];
        const el: ShimElement = {
            tagName,
            className: '',
            textContent: null,
            title: '',
            hidden: false,
            children,
            attributes: attrs,
            setAttribute(name: string, value: string): void {
                attrs.set(name, value);
            },
            appendChild(child: RenderElement): RenderElement {
                children.push(child as ShimElement);
                return child;
            },
        };
        return el;
    }
    return {
        createElement(tagName: string): RenderElement {
            return makeElement(tagName);
        },
    };
}

function asShim(el: RenderElement | null): ShimElement {
    if (!el) throw new Error('expected a rendered element, got null');
    return el as ShimElement;
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

function buttonByAction(root: ShimElement, action: string): ShimElement {
    const btn = findFirst(
        root,
        (el) => el.tagName === 'button' && el.attributes.get('data-action') === action,
    );
    if (!btn) {
        throw new Error(`no button with data-action="${action}" under <${root.tagName}>`);
    }
    return btn;
}

function click(el: ShimElement): void {
    if (!el.onclick) throw new Error('clicked element has no onclick');
    el.onclick();
}

function noopHandlers(): ContextUpdateHandlers {
    return { onRun: () => {}, onSkip: () => {} };
}

function entry(overrides: Partial<PendingContextUpdate> = {}): PendingContextUpdate {
    return {
        taskId: 't1',
        summary: 'Update CLAUDE.md with new flow',
        ...overrides,
    };
}

function state(overrides: Partial<ContextUpdatesState> = {}): ContextUpdatesState {
    return { ...initialContextUpdatesState(), ...overrides };
}

// ---------------------------------------------------------------------------
// renderPendingList — DOM shape + handler wiring
// ---------------------------------------------------------------------------

test('renderPendingList: emits the empty-state row when there is nothing pending', () => {
    const doc = makeShimDocument();
    const root = asShim(renderPendingList(state(), noopHandlers(), doc));
    assert.equal(root.tagName, 'ul');
    assert.ok(root.attributes.has('data-context-updates'));
    const empty = asShim(findFirst(root, (el) => el.attributes.has('data-empty')));
    assert.equal(empty.textContent, 'No pending context updates');
});

test('renderPendingList: emits one row per pending entry with Run + Skip buttons', () => {
    const doc = makeShimDocument();
    const root = asShim(
        renderPendingList(
            state({
                pending: [
                    entry({ taskId: 'a', summary: 'flow A' }),
                    entry({ taskId: 'b', summary: 'flow B' }),
                ],
            }),
            noopHandlers(),
            doc,
        ),
    );
    const rows = findAll(root, (el) => el.attributes.has('data-context-update-row'));
    assert.equal(rows.length, 2);
    assert.deepEqual(
        rows.map((r) => r.attributes.get('data-task-id')),
        ['a', 'b'],
    );
    for (const row of rows) {
        buttonByAction(row, 'run-context-update');
        buttonByAction(row, 'skip-context-update');
        const summary = findFirst(row, (el) =>
            el.attributes.has('data-context-update-summary'),
        );
        assert.ok(summary);
    }
});

test('renderPendingList: surfaces optional prNumber and planId chips when present', () => {
    const doc = makeShimDocument();
    const root = asShim(
        renderPendingList(
            state({
                pending: [
                    entry({ taskId: 'a', planId: 'pl-9', prNumber: 42, summary: 's' }),
                ],
            }),
            noopHandlers(),
            doc,
        ),
    );
    const row = asShim(findFirst(root, (el) => el.attributes.get('data-task-id') === 'a'));
    const pr = asShim(findFirst(row, (el) => el.attributes.has('data-context-update-pr')));
    const plan = asShim(findFirst(row, (el) => el.attributes.has('data-context-update-plan')));
    assert.equal(pr.textContent, 'PR #42');
    assert.equal(plan.textContent, 'pl-9');
});

test('renderPendingList: clicking Run fires onRun with the row task id', () => {
    const doc = makeShimDocument();
    let runArg: string | null = null;
    const handlers: ContextUpdateHandlers = {
        onRun: (id) => {
            runArg = id;
        },
        onSkip: () => {},
    };
    const root = asShim(
        renderPendingList(
            state({ pending: [entry({ taskId: 'pickme' })] }),
            handlers,
            doc,
        ),
    );
    const row = asShim(findFirst(root, (el) => el.attributes.get('data-task-id') === 'pickme'));
    click(buttonByAction(row, 'run-context-update'));
    assert.equal(runArg, 'pickme');
});

test('renderPendingList: clicking Skip fires onSkip with the row task id', () => {
    const doc = makeShimDocument();
    let skipArg: string | null = null;
    const handlers: ContextUpdateHandlers = {
        onRun: () => {},
        onSkip: (id) => {
            skipArg = id;
        },
    };
    const root = asShim(
        renderPendingList(
            state({ pending: [entry({ taskId: 'pickme' })] }),
            handlers,
            doc,
        ),
    );
    const row = asShim(findFirst(root, (el) => el.attributes.get('data-task-id') === 'pickme'));
    click(buttonByAction(row, 'skip-context-update'));
    assert.equal(skipArg, 'pickme');
});

test('renderPendingList: surfaces loadError in an inline alert slot', () => {
    const doc = makeShimDocument();
    const root = asShim(
        renderPendingList(state({ loadError: 'upstream offline' }), noopHandlers(), doc),
    );
    const slot = asShim(
        findFirst(root, (el) => el.attributes.get('data-error-for') === 'load'),
    );
    assert.equal(slot.textContent, 'upstream offline');
});

test('renderPendingList: surfaces dispatchError next to the offending row only', () => {
    const doc = makeShimDocument();
    const root = asShim(
        renderPendingList(
            state({
                pending: [entry({ taskId: 'a' }), entry({ taskId: 'b' })],
                dispatchErrors: { a: 'curator unavailable' },
            }),
            noopHandlers(),
            doc,
        ),
    );
    const slot = asShim(
        findFirst(
            root,
            (el) =>
                el.attributes.get('data-error-for') === 'dispatch'
                && el.attributes.get('data-task-id') === 'a',
        ),
    );
    assert.equal(slot.textContent, 'curator unavailable');
    // No slot on the unrelated row.
    const rowB = asShim(findFirst(root, (el) => el.attributes.get('data-task-id') === 'b'));
    assert.equal(
        findFirst(
            rowB,
            (el) => el.attributes.get('data-error-for') === 'dispatch',
        ),
        null,
    );
});

test('renderPendingList: disables Run + Skip for in-flight rows', () => {
    const doc = makeShimDocument();
    const root = asShim(
        renderPendingList(
            state({
                pending: [entry({ taskId: 'a' })],
                inFlight: ['a'],
            }),
            noopHandlers(),
            doc,
        ),
    );
    const row = asShim(findFirst(root, (el) => el.attributes.get('data-task-id') === 'a'));
    const run = buttonByAction(row, 'run-context-update');
    const skip = buttonByAction(row, 'skip-context-update');
    assert.equal(run.disabled, true);
    assert.equal(skip.disabled, true);
});

// ---------------------------------------------------------------------------
// Controller — URL routing + refetch
// ---------------------------------------------------------------------------

interface RecordedCall {
    readonly url: string;
    readonly method: string;
}

function makeFakeFetch(
    responses: ReadonlyMap<string, () => { ok: boolean; status: number; body: unknown }>,
): { fetch: FetchLike; calls: RecordedCall[] } {
    const calls: RecordedCall[] = [];
    const fetch: FetchLike = async (url, init?: FetchRequestInit) => {
        const method = (init?.method ?? 'GET').toUpperCase();
        calls.push({ url, method });
        const key = `${method} ${url}`;
        const producer = responses.get(key);
        const out = producer ? producer() : { ok: true, status: 200, body: {} };
        return {
            ok: out.ok,
            status: out.status,
            async json(): Promise<unknown> {
                return out.body;
            },
        };
    };
    return { fetch, calls };
}

test('controller.loadPending: GETs /context-updates/pending and stores the response', async () => {
    const pending: PendingContextUpdate[] = [entry({ taskId: 'a' })];
    const { fetch, calls } = makeFakeFetch(
        new Map([
            [
                'GET /context-updates/pending',
                () => ({ ok: true, status: 200, body: { pending } }),
            ],
        ]),
    );
    const controller = createContextUpdatesController({ fetch });
    await controller.loadPending();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'GET');
    assert.equal(calls[0].url, '/context-updates/pending');
    assert.deepEqual(controller.state().pending, pending);
    assert.equal(controller.state().loadError, null);
});

test('controller.loadPending: failed load surfaces the error and leaves the list alone', async () => {
    const { fetch } = makeFakeFetch(
        new Map([
            [
                'GET /context-updates/pending',
                () => ({ ok: false, status: 503, body: { error: 'upstream down' } }),
            ],
        ]),
    );
    const controller = createContextUpdatesController({
        fetch,
        logger: { warn: () => {} },
    });
    await controller.loadPending();
    assert.equal(controller.state().loadError, 'upstream down');
    assert.equal(controller.state().pending.length, 0);
});

test('controller.runUpdate: POSTs /tasks/:tid/context-update/run then refetches', async () => {
    let pendingCalls = 0;
    const { fetch, calls } = makeFakeFetch(
        new Map<string, () => { ok: boolean; status: number; body: unknown }>([
            [
                'POST /tasks/t-7/context-update/run',
                () => ({ ok: true, status: 202, body: {} }),
            ],
            [
                'GET /context-updates/pending',
                () => {
                    pendingCalls++;
                    return { ok: true, status: 200, body: { pending: [] } };
                },
            ],
        ]),
    );
    const controller = createContextUpdatesController({ fetch });
    await controller.runUpdate('t-7');
    // 1) POST then 2) GET refetch — AC #4 (success drops the row).
    assert.equal(calls.length, 2);
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].url, '/tasks/t-7/context-update/run');
    assert.equal(calls[1].method, 'GET');
    assert.equal(calls[1].url, '/context-updates/pending');
    assert.equal(pendingCalls, 1);
    assert.equal(controller.state().inFlight.length, 0);
    assert.equal(controller.state().dispatchErrors['t-7'], undefined);
});

test('controller.skipUpdate: POSTs /tasks/:tid/context-update/skip then refetches', async () => {
    const { fetch, calls } = makeFakeFetch(
        new Map<string, () => { ok: boolean; status: number; body: unknown }>([
            [
                'POST /tasks/t-9/context-update/skip',
                () => ({ ok: true, status: 202, body: {} }),
            ],
            [
                'GET /context-updates/pending',
                () => ({ ok: true, status: 200, body: { pending: [] } }),
            ],
        ]),
    );
    const controller = createContextUpdatesController({ fetch });
    await controller.skipUpdate('t-9');
    assert.equal(calls.length, 2);
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].url, '/tasks/t-9/context-update/skip');
    assert.equal(calls[1].method, 'GET');
    assert.equal(calls[1].url, '/context-updates/pending');
});

test('controller.runUpdate: failed POST populates dispatchErrors[taskId] and does NOT refetch', async () => {
    const { fetch, calls } = makeFakeFetch(
        new Map<string, () => { ok: boolean; status: number; body: unknown }>([
            [
                'POST /tasks/t-7/context-update/run',
                () => ({ ok: false, status: 500, body: { error: 'curator down' } }),
            ],
        ]),
    );
    const controller = createContextUpdatesController({
        fetch,
        logger: { warn: () => {} },
    });
    await controller.runUpdate('t-7');
    // Only the failed POST — no GET refetch.
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'POST');
    assert.equal(controller.state().dispatchErrors['t-7'], 'curator down');
    assert.equal(controller.state().inFlight.length, 0);
});

test('controller.runUpdate: encodes the taskId so URL-unsafe chars do not break the path', async () => {
    const { fetch, calls } = makeFakeFetch(
        new Map<string, () => { ok: boolean; status: number; body: unknown }>([
            [
                'POST /tasks/t%2Fhello/context-update/run',
                () => ({ ok: true, status: 202, body: {} }),
            ],
            [
                'GET /context-updates/pending',
                () => ({ ok: true, status: 200, body: { pending: [] } }),
            ],
        ]),
    );
    const controller = createContextUpdatesController({ fetch });
    await controller.runUpdate('t/hello');
    assert.equal(calls[0].url, '/tasks/t%2Fhello/context-update/run');
});

test('controller.apiBase: prefix is applied to every URL', async () => {
    const { fetch, calls } = makeFakeFetch(
        new Map<string, () => { ok: boolean; status: number; body: unknown }>([
            [
                'GET http://upstream/context-updates/pending',
                () => ({ ok: true, status: 200, body: { pending: [] } }),
            ],
        ]),
    );
    const controller = createContextUpdatesController({
        fetch,
        apiBase: 'http://upstream/',
    });
    await controller.loadPending();
    assert.equal(calls[0].url, 'http://upstream/context-updates/pending');
});

test('controller.onChange: fires on every state transition', async () => {
    const transitions: ContextUpdatesState[] = [];
    const { fetch } = makeFakeFetch(
        new Map<string, () => { ok: boolean; status: number; body: unknown }>([
            [
                'POST /tasks/t-1/context-update/run',
                () => ({ ok: true, status: 202, body: {} }),
            ],
            [
                'GET /context-updates/pending',
                () => ({ ok: true, status: 200, body: { pending: [entry()] } }),
            ],
        ]),
    );
    const controller = createContextUpdatesController({
        fetch,
        onChange: (s) => transitions.push(s),
    });
    await controller.runUpdate('t-1');
    // begin-in-flight + end-in-flight + post-refetch ≥ 3 transitions.
    assert.ok(transitions.length >= 3, `expected ≥3 transitions, got ${transitions.length}`);
});

test('controller.runUpdate: clears a stale dispatchError for the same task on retry', async () => {
    let firstCall = true;
    const fetch: FetchLike = async (url, init?: FetchRequestInit) => {
        const method = (init?.method ?? 'GET').toUpperCase();
        if (method === 'POST') {
            if (firstCall) {
                firstCall = false;
                return {
                    ok: false,
                    status: 500,
                    async json(): Promise<unknown> {
                        return { error: 'first fail' };
                    },
                };
            }
            return {
                ok: true,
                status: 202,
                async json(): Promise<unknown> {
                    return {};
                },
            };
        }
        return {
            ok: true,
            status: 200,
            async json(): Promise<unknown> {
                return { pending: [] };
            },
        };
    };
    const controller = createContextUpdatesController({
        fetch,
        logger: { warn: () => {} },
    });
    await controller.runUpdate('t-1');
    assert.equal(controller.state().dispatchErrors['t-1'], 'first fail');
    await controller.runUpdate('t-1');
    assert.equal(controller.state().dispatchErrors['t-1'], undefined);
});
