/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Unit tests for the AP-IFF-018 worker-log modal.
 *
 * Coverage maps to the acceptance criteria from TASK.md:
 *   AC #1 — Modal opens via overlayManager and fetches the snapshot.
 *   AC #2 — SSE stream appends new lines as they arrive.
 *   AC #3 — Level filter triggers re-fetch and reconnects SSE.
 *   AC #4 — SSE connection closes when the modal closes.
 *   AC #5 — this file is the unit-test artefact.
 *
 * DOM strategy — hand-rolled shim, matching the convention established
 * by `hosts/board-ui/client/chrome/*.spec.ts` and the sibling
 * `diff-review.spec.ts` / `interrupt-retry.spec.ts`: jsdom is not in the
 * dependency graph and the modal's structural surface is small enough
 * that a ~70-line shim is cheaper than dragging jsdom in.
 *
 * Dual-runner discovery — same pattern as the other modal specs so this
 * file runs under both `node --test --import tsx` (the repo default)
 * and `npx vitest run` (the review pipeline).
 */
import * as assert from 'node:assert/strict';

import {
    WORKER_LOG_OVERLAY_ID,
    WORKER_LOG_SNAPSHOT_PATH,
    WORKER_LOG_TAIL_PATH,
    buildSnapshotUrl,
    buildTailUrl,
    openWorkerLog,
    type WorkerLogDocument,
    type WorkerLogElement,
    type WorkerLogEventSourceLike,
    type WorkerLogFetch,
    type WorkerLogFetchResponse,
    type WorkerLogOverlayManager,
} from '../../../hosts/board-ui/client/modals/worker-log';

// ---------------------------------------------------------------------------
// Dual-runner test() shim
// ---------------------------------------------------------------------------

type TestFn = (name: string, fn: () => void | Promise<void>) => void;

const test: TestFn = (((): TestFn => {
    if (process.env.VITEST) {
        const gt = (globalThis as { test?: TestFn }).test;
        if (typeof gt !== 'function') {
            throw new Error(
                'worker-log.spec.ts: VITEST=true but globalThis.test is missing — '
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

interface ShimElement extends WorkerLogElement {
    readonly tagName: string;
    readonly children: ShimElement[];
    readonly attributes: Map<string, string>;
    parent: ShimElement | null;
    removed: boolean;
    onchange?: () => void | Promise<void>;
    onclick?: () => void;
}

function makeShimElement(tagName: string): ShimElement {
    const attrs = new Map<string, string>();
    const children: ShimElement[] = [];
    const el: ShimElement = {
        tagName,
        className: '',
        textContent: null,
        value: '',
        children,
        attributes: attrs,
        parent: null,
        removed: false,
        setAttribute(name: string, value: string): void {
            attrs.set(name, value);
        },
        appendChild(child: WorkerLogElement): WorkerLogElement {
            const c = child as ShimElement;
            c.parent = el;
            children.push(c);
            return child;
        },
        replaceChildren(...next: WorkerLogElement[]): void {
            children.length = 0;
            for (const c of next) {
                const sc = c as ShimElement;
                sc.parent = el;
                children.push(sc);
            }
        },
        remove(): void {
            el.removed = true;
            if (el.parent) {
                const idx = el.parent.children.indexOf(el);
                if (idx >= 0) el.parent.children.splice(idx, 1);
                el.parent = null;
            }
        },
    };
    return el;
}

function makeShimDocument(): WorkerLogDocument {
    return {
        createElement(tagName: string): WorkerLogElement {
            return makeShimElement(tagName);
        },
    };
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

function findByAttr(root: ShimElement, attr: string): ShimElement {
    const hit = findFirst(root, (el) => el.attributes.has(attr));
    if (!hit) throw new Error(`no element with attribute "${attr}"`);
    return hit;
}

function findByAction(root: ShimElement, action: string): ShimElement {
    const hit = findFirst(root, (el) => el.attributes.get('data-action') === action);
    if (!hit) throw new Error(`no element with data-action="${action}"`);
    return hit;
}

// ---------------------------------------------------------------------------
// Recorder fakes — fetch / overlay-manager / EventSource factory
// ---------------------------------------------------------------------------

interface FetchCall {
    readonly url: string;
}

interface FakeFetch {
    readonly fn: WorkerLogFetch;
    readonly calls: FetchCall[];
    /** Override the response for the NEXT call (FIFO). */
    queue(response: WorkerLogFetchResponse | Error): void;
}

function makeFakeFetch(defaultResponse: WorkerLogFetchResponse | Error): FakeFetch {
    const calls: FetchCall[] = [];
    const queued: Array<WorkerLogFetchResponse | Error> = [];
    const fn: WorkerLogFetch = async (url): Promise<WorkerLogFetchResponse> => {
        calls.push({ url });
        const next = queued.shift() ?? defaultResponse;
        if (next instanceof Error) throw next;
        return next;
    };
    return {
        fn,
        calls,
        queue(response): void {
            queued.push(response);
        },
    };
}

function jsonResponse(body: unknown, status = 200): WorkerLogFetchResponse {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async (): Promise<unknown> => body,
    };
}

interface FakeOverlayManager extends WorkerLogOverlayManager {
    readonly opens: Array<{ readonly id: string; readonly element: unknown }>;
    readonly closes: string[];
}

function makeFakeOverlayManager(): FakeOverlayManager {
    const opens: Array<{ readonly id: string; readonly element: unknown }> = [];
    const closes: string[] = [];
    return {
        opens,
        closes,
        openOverlay(id, element): unknown {
            opens.push({ id, element });
            return { id };
        },
        closeOverlay(id): void {
            closes.push(id);
        },
    };
}

interface FakeEventSource extends WorkerLogEventSourceLike {
    readonly url: string;
    readonly id: number;
    closed: boolean;
}

interface EventSourceRecorder {
    readonly factory: (url: string) => WorkerLogEventSourceLike;
    readonly created: FakeEventSource[];
    last(): FakeEventSource;
}

function makeEventSourceRecorder(): EventSourceRecorder {
    const created: FakeEventSource[] = [];
    let id = 0;
    return {
        created,
        factory(url: string): WorkerLogEventSourceLike {
            const es: FakeEventSource = {
                url,
                id: id++,
                onmessage: null,
                onerror: null,
                closed: false,
                close(): void {
                    es.closed = true;
                },
            };
            created.push(es);
            return es;
        },
        last(): FakeEventSource {
            if (created.length === 0) throw new Error('no EventSource created yet');
            return created[created.length - 1];
        },
    };
}

// ---------------------------------------------------------------------------
// buildSnapshotUrl / buildTailUrl — pin the route + query contract
// ---------------------------------------------------------------------------

test('buildSnapshotUrl: omits ?level when no filter is active', () => {
    assert.equal(buildSnapshotUrl(null), WORKER_LOG_SNAPSHOT_PATH);
});

test('buildSnapshotUrl: encodes each documented level', () => {
    assert.equal(buildSnapshotUrl('info'), `${WORKER_LOG_SNAPSHOT_PATH}?level=info`);
    assert.equal(buildSnapshotUrl('warn'), `${WORKER_LOG_SNAPSHOT_PATH}?level=warn`);
    assert.equal(buildSnapshotUrl('error'), `${WORKER_LOG_SNAPSHOT_PATH}?level=error`);
});

test('buildTailUrl: matches the snapshot pattern with the tail path', () => {
    assert.equal(buildTailUrl(null), WORKER_LOG_TAIL_PATH);
    assert.equal(buildTailUrl('warn'), `${WORKER_LOG_TAIL_PATH}?level=warn`);
});

// ---------------------------------------------------------------------------
// AC #1 — Modal opens via overlayManager and fetches the snapshot
// ---------------------------------------------------------------------------

test('AC #1: openWorkerLog registers an overlay and fetches the snapshot', async () => {
    const root = makeShimElement('div');
    const overlay = makeFakeOverlayManager();
    const fetcher = makeFakeFetch(
        jsonResponse({ lines: ['one', 'two', 'three'] }),
    );
    const events = makeEventSourceRecorder();

    const handle = openWorkerLog({
        element: root,
        overlayManager: overlay,
        fetch: fetcher.fn,
        createEventSource: events.factory,
        doc: makeShimDocument(),
    });

    // Overlay is pushed synchronously so the loading state shows in the
    // same tick as the open call.
    assert.equal(overlay.opens.length, 1);
    assert.equal(overlay.opens[0].id, WORKER_LOG_OVERLAY_ID);
    assert.equal(overlay.opens[0].element, root);

    // Default level is "all" (null), so the snapshot URL must omit the
    // query string.
    await handle.loaded;
    assert.equal(fetcher.calls.length, 1);
    assert.equal(fetcher.calls[0].url, WORKER_LOG_SNAPSHOT_PATH);

    // Snapshot lines are rendered into the body in order.
    const lines = findAll(root, (el) =>
        el.attributes.has('data-worker-log-line'),
    );
    assert.deepEqual(
        lines.map((l) => l.textContent),
        ['one', 'two', 'three'],
    );
});

test('AC #1: dialog chrome (role, aria, level filter, close button) is mounted', async () => {
    const root = makeShimElement('div');
    const overlay = makeFakeOverlayManager();
    const fetcher = makeFakeFetch(jsonResponse({ lines: [] }));
    const events = makeEventSourceRecorder();

    const handle = openWorkerLog({
        element: root,
        overlayManager: overlay,
        fetch: fetcher.fn,
        createEventSource: events.factory,
        doc: makeShimDocument(),
    });
    await handle.loaded;

    assert.equal(root.attributes.get('role'), 'dialog');
    assert.equal(root.attributes.get('aria-modal'), 'true');
    assert.equal(root.attributes.get('data-modal'), 'worker-log');

    // Filter dropdown and close button are wired so the operator can
    // drive the modal from a real browser without going through the
    // programmatic API.
    const filter = findByAttr(root, 'data-worker-log-filter');
    assert.equal(filter.tagName, 'select');
    assert.equal(typeof filter.onchange, 'function');

    const closeBtn = findByAction(root, 'close');
    assert.equal(typeof closeBtn.onclick, 'function');
});

test('AC #1: snapshot HTTP error surfaces an error status and no lines render', async () => {
    const root = makeShimElement('div');
    const overlay = makeFakeOverlayManager();
    const fetcher = makeFakeFetch(jsonResponse({ error: 'boom' }, 500));
    const events = makeEventSourceRecorder();

    const handle = openWorkerLog({
        element: root,
        overlayManager: overlay,
        fetch: fetcher.fn,
        createEventSource: events.factory,
        doc: makeShimDocument(),
    });
    await handle.loaded;

    const status = findByAttr(root, 'data-worker-log-status');
    assert.equal(status.attributes.get('data-worker-log-status'), 'error');
    assert.match(status.textContent ?? '', /HTTP 500/);
    assert.equal(
        findAll(root, (el) => el.attributes.has('data-worker-log-line')).length,
        0,
    );
});

// ---------------------------------------------------------------------------
// AC #2 — SSE stream appends new lines
// ---------------------------------------------------------------------------

test('AC #2: tail EventSource opens at the documented URL after the snapshot resolves', async () => {
    const root = makeShimElement('div');
    const overlay = makeFakeOverlayManager();
    const fetcher = makeFakeFetch(jsonResponse({ lines: ['seed'] }));
    const events = makeEventSourceRecorder();

    const handle = openWorkerLog({
        element: root,
        overlayManager: overlay,
        fetch: fetcher.fn,
        createEventSource: events.factory,
        doc: makeShimDocument(),
    });
    await handle.loaded;

    assert.equal(events.created.length, 1);
    assert.equal(events.last().url, WORKER_LOG_TAIL_PATH);
    assert.equal(typeof events.last().onmessage, 'function');
});

test('AC #2: each onmessage frame appends a line to the log body in order', async () => {
    const root = makeShimElement('div');
    const overlay = makeFakeOverlayManager();
    const fetcher = makeFakeFetch(jsonResponse({ lines: ['seed-1', 'seed-2'] }));
    const events = makeEventSourceRecorder();

    const handle = openWorkerLog({
        element: root,
        overlayManager: overlay,
        fetch: fetcher.fn,
        createEventSource: events.factory,
        doc: makeShimDocument(),
    });
    await handle.loaded;

    const es = events.last();
    assert.ok(es.onmessage, 'tail must wire onmessage');
    es.onmessage!({ data: 'live-1' });
    es.onmessage!({ data: 'live-2' });
    es.onmessage!({ data: 'live-3' });

    const lines = findAll(root, (el) =>
        el.attributes.has('data-worker-log-line'),
    );
    assert.deepEqual(
        lines.map((l) => l.textContent),
        ['seed-1', 'seed-2', 'live-1', 'live-2', 'live-3'],
    );
});

test('AC #2: empty / non-string SSE payloads are dropped without appending a blank line', async () => {
    const root = makeShimElement('div');
    const overlay = makeFakeOverlayManager();
    const fetcher = makeFakeFetch(jsonResponse({ lines: [] }));
    const events = makeEventSourceRecorder();

    const handle = openWorkerLog({
        element: root,
        overlayManager: overlay,
        fetch: fetcher.fn,
        createEventSource: events.factory,
        doc: makeShimDocument(),
    });
    await handle.loaded;

    const es = events.last();
    es.onmessage!({ data: '' });
    es.onmessage!({ data: null as unknown as string });
    es.onmessage!({ data: 'real-line' });

    const lines = findAll(root, (el) =>
        el.attributes.has('data-worker-log-line'),
    );
    assert.deepEqual(
        lines.map((l) => l.textContent),
        ['real-line'],
    );
});

// ---------------------------------------------------------------------------
// AC #3 — Level filter triggers re-fetch and reconnects SSE
// ---------------------------------------------------------------------------

test('AC #3: setLevel re-fetches the snapshot with the level query and reopens the SSE tail', async () => {
    const root = makeShimElement('div');
    const overlay = makeFakeOverlayManager();
    const fetcher = makeFakeFetch(jsonResponse({ lines: ['unfiltered'] }));
    const events = makeEventSourceRecorder();

    const handle = openWorkerLog({
        element: root,
        overlayManager: overlay,
        fetch: fetcher.fn,
        createEventSource: events.factory,
        doc: makeShimDocument(),
    });
    await handle.loaded;

    // Initial state: one snapshot fetch (no level), one EventSource (no level).
    assert.equal(fetcher.calls.length, 1);
    assert.equal(fetcher.calls[0].url, WORKER_LOG_SNAPSHOT_PATH);
    assert.equal(events.created.length, 1);
    assert.equal(events.last().url, WORKER_LOG_TAIL_PATH);

    // Queue a snapshot reply for the post-filter fetch and switch level.
    fetcher.queue(jsonResponse({ lines: ['warn-only'] }));
    await handle.setLevel('warn');

    assert.equal(fetcher.calls.length, 2);
    assert.equal(
        fetcher.calls[1].url,
        `${WORKER_LOG_SNAPSHOT_PATH}?level=warn`,
    );
    // A new EventSource was created at the level-scoped URL...
    assert.equal(events.created.length, 2);
    assert.equal(events.last().url, `${WORKER_LOG_TAIL_PATH}?level=warn`);
    // ...and the previous one was closed so the operator doesn't get
    // duplicate lines while the new stream catches up.
    assert.equal(events.created[0].closed, true);
    assert.equal(handle.currentLevel, 'warn');

    // The snapshot body now reflects the level filter response.
    const lines = findAll(root, (el) =>
        el.attributes.has('data-worker-log-line'),
    );
    assert.deepEqual(
        lines.map((l) => l.textContent),
        ['warn-only'],
    );
});

test('AC #3: the level dropdown change handler routes through the same setLevel path', async () => {
    const root = makeShimElement('div');
    const overlay = makeFakeOverlayManager();
    const fetcher = makeFakeFetch(jsonResponse({ lines: [] }));
    const events = makeEventSourceRecorder();

    const handle = openWorkerLog({
        element: root,
        overlayManager: overlay,
        fetch: fetcher.fn,
        createEventSource: events.factory,
        doc: makeShimDocument(),
    });
    await handle.loaded;

    const filter = findByAttr(root, 'data-worker-log-filter') as ShimElement;
    assert.ok(typeof filter.onchange === 'function');

    // Operator picks "error" from the dropdown.
    fetcher.queue(jsonResponse({ lines: [] }));
    filter.value = 'error';
    await filter.onchange!();

    assert.equal(handle.currentLevel, 'error');
    assert.equal(fetcher.calls.length, 2);
    assert.equal(
        fetcher.calls[1].url,
        `${WORKER_LOG_SNAPSHOT_PATH}?level=error`,
    );
    assert.equal(events.last().url, `${WORKER_LOG_TAIL_PATH}?level=error`);
});

test('AC #3: setLevel with the current level is a no-op — no extra fetch or reconnect', async () => {
    const root = makeShimElement('div');
    const overlay = makeFakeOverlayManager();
    const fetcher = makeFakeFetch(jsonResponse({ lines: [] }));
    const events = makeEventSourceRecorder();

    const handle = openWorkerLog({
        element: root,
        overlayManager: overlay,
        fetch: fetcher.fn,
        createEventSource: events.factory,
        doc: makeShimDocument(),
        initialLevel: 'info',
    });
    await handle.loaded;
    const fetchesBefore = fetcher.calls.length;
    const sourcesBefore = events.created.length;

    await handle.setLevel('info');

    assert.equal(fetcher.calls.length, fetchesBefore);
    assert.equal(events.created.length, sourcesBefore);
});

test('AC #3: initialLevel seeds both the snapshot query and the tail subscription', async () => {
    const root = makeShimElement('div');
    const overlay = makeFakeOverlayManager();
    const fetcher = makeFakeFetch(jsonResponse({ lines: [] }));
    const events = makeEventSourceRecorder();

    const handle = openWorkerLog({
        element: root,
        overlayManager: overlay,
        fetch: fetcher.fn,
        createEventSource: events.factory,
        doc: makeShimDocument(),
        initialLevel: 'warn',
    });
    await handle.loaded;

    assert.equal(fetcher.calls[0].url, `${WORKER_LOG_SNAPSHOT_PATH}?level=warn`);
    assert.equal(events.last().url, `${WORKER_LOG_TAIL_PATH}?level=warn`);
    assert.equal(handle.currentLevel, 'warn');
});

// ---------------------------------------------------------------------------
// AC #4 — SSE connection closes when the modal closes
// ---------------------------------------------------------------------------

test('AC #4: close() tears down the EventSource and unregisters the overlay', async () => {
    const root = makeShimElement('div');
    const overlay = makeFakeOverlayManager();
    const fetcher = makeFakeFetch(jsonResponse({ lines: [] }));
    const events = makeEventSourceRecorder();

    const handle = openWorkerLog({
        element: root,
        overlayManager: overlay,
        fetch: fetcher.fn,
        createEventSource: events.factory,
        doc: makeShimDocument(),
    });
    await handle.loaded;
    const es = events.last();
    assert.equal(es.closed, false);

    handle.close();

    assert.equal(es.closed, true, 'SSE connection must be closed on modal close');
    assert.deepEqual(overlay.closes, [WORKER_LOG_OVERLAY_ID]);
});

test('AC #4: close() is idempotent — calling it twice does not double-close', async () => {
    const root = makeShimElement('div');
    const overlay = makeFakeOverlayManager();
    const fetcher = makeFakeFetch(jsonResponse({ lines: [] }));
    const events = makeEventSourceRecorder();

    const handle = openWorkerLog({
        element: root,
        overlayManager: overlay,
        fetch: fetcher.fn,
        createEventSource: events.factory,
        doc: makeShimDocument(),
    });
    await handle.loaded;

    handle.close();
    handle.close();

    assert.equal(overlay.closes.length, 1);
});

test('AC #4: the close button drives the same teardown path as handle.close()', async () => {
    const root = makeShimElement('div');
    const overlay = makeFakeOverlayManager();
    const fetcher = makeFakeFetch(jsonResponse({ lines: [] }));
    const events = makeEventSourceRecorder();

    const handle = openWorkerLog({
        element: root,
        overlayManager: overlay,
        fetch: fetcher.fn,
        createEventSource: events.factory,
        doc: makeShimDocument(),
    });
    await handle.loaded;
    const es = events.last();

    const closeBtn = findByAction(root, 'close') as ShimElement;
    closeBtn.onclick!();

    assert.equal(es.closed, true);
    assert.deepEqual(overlay.closes, [WORKER_LOG_OVERLAY_ID]);
    // Sanity: the handle records the closed state by ignoring further
    // setLevel calls (no extra fetch).
    const fetchesBefore = fetcher.calls.length;
    await handle.setLevel('warn');
    assert.equal(fetcher.calls.length, fetchesBefore);
});
