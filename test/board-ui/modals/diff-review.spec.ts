/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Unit tests for the AP-IFF-010 diff-review modal.
 *
 * Coverage targets every acceptance criterion in TASK.md:
 *  - AC #1: fetches the diff route and renders the parsed files +
 *    hunks. The fetch URL is asserted so the proxy entry in
 *    `hosts/board-ui/server.ts` and the worker-api responder stay in
 *    lockstep.
 *  - AC #2: Prev/Next hunk buttons walk the flat hunk list, mark the
 *    current entry with `data-active="true"`, and the aria-disabled
 *    flags reflect the start/end clamps.
 *  - AC #3: Approve dispatches a single `UpdateTask` command carrying
 *    the task id, the optional flow id, and the configured status
 *    transition.
 *  - AC #4: Reject closes the diff-review overlay and invokes the
 *    host's `onReject` callback so the reject modal can take over.
 *  - AC #5: every dispatch path above is asserted with recorder fakes
 *    — no real fetch and no real `OverlayManager`.
 *
 * Dual-runner discovery follows the same pattern as
 * `hosts/board-ui/client/chrome/sidebar.spec.ts`: the file picks the
 * test() registration function from `globalThis.test` under vitest and
 * from `node:test` under the default `node --test` runner.
 */
import * as assert from 'node:assert/strict';

import {
    DEFAULT_APPROVE_STATUS,
    DIFF_REVIEW_OVERLAY_ID,
    UPDATE_TASK_COMMAND,
    buildDiffUrl,
    openDiffReview,
    type DiffReviewCommand,
    type DiffReviewDocument,
    type DiffReviewElement,
    type DiffReviewFetch,
    type DiffReviewFetchResponse,
    type DiffReviewOverlayManager,
    type DiffReviewParams,
    type TaskDiffResponse,
} from '../../../hosts/board-ui/client/modals/diff-review';

// ---------------------------------------------------------------------------
// Dual-runner test() shim
// ---------------------------------------------------------------------------

type TestFn = (name: string, fn: () => void | Promise<void>) => void;

const test: TestFn = (((): TestFn => {
    if (process.env.VITEST) {
        const gt = (globalThis as { test?: TestFn }).test;
        if (typeof gt !== 'function') {
            throw new Error(
                'diff-review.spec.ts: VITEST=true but globalThis.test is missing — '
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
// Minimal DOM shim — mirrors the sidebar.spec.ts approach
// ---------------------------------------------------------------------------

interface ShimElement extends DiffReviewElement {
    tagName: string;
    attributes: Map<string, string>;
    children: ShimElement[];
    onclick?: () => void;
    scrollCalls: number;
}

function makeShimElement(tagName: string): ShimElement {
    const attrs = new Map<string, string>();
    const children: ShimElement[] = [];
    const el: ShimElement = {
        tagName,
        className: '',
        textContent: null,
        attributes: attrs,
        children,
        scrollCalls: 0,
        setAttribute(name: string, value: string): void {
            attrs.set(name, value);
        },
        removeAttribute(name: string): void {
            attrs.delete(name);
        },
        appendChild(child: DiffReviewElement): DiffReviewElement {
            children.push(child as ShimElement);
            return child;
        },
        replaceChildren(...next: DiffReviewElement[]): void {
            children.length = 0;
            for (const c of next) children.push(c as ShimElement);
        },
        scrollIntoView(): void {
            el.scrollCalls += 1;
        },
    };
    return el;
}

function makeShimDocument(): DiffReviewDocument {
    return {
        createElement(tagName: string): DiffReviewElement {
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

function byAction(root: ShimElement, action: string): ShimElement {
    const hit = findFirst(root, (el) => el.attributes.get('data-action') === action);
    if (!hit) throw new Error(`no element with data-action="${action}"`);
    return hit;
}

function click(el: ShimElement): void {
    if (!el.onclick) throw new Error(`clicked element <${el.tagName}> has no onclick`);
    el.onclick();
}

// ---------------------------------------------------------------------------
// Recorder fakes
// ---------------------------------------------------------------------------

interface FetchCall {
    readonly url: string;
}

interface FakeFetch {
    readonly fn: DiffReviewFetch;
    readonly calls: FetchCall[];
}

function makeFakeFetch(response: DiffReviewFetchResponse | Error): FakeFetch {
    const calls: FetchCall[] = [];
    const fn: DiffReviewFetch = async (url) => {
        calls.push({ url });
        if (response instanceof Error) throw response;
        return response;
    };
    return { fn, calls };
}

function jsonResponse(body: unknown, status = 200): DiffReviewFetchResponse {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async (): Promise<unknown> => body,
    };
}

interface FakeOverlayManager extends DiffReviewOverlayManager {
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

function makeDispatchRecorder(): { calls: DiffReviewCommand[]; dispatch: (cmd: DiffReviewCommand) => void } {
    const calls: DiffReviewCommand[] = [];
    return {
        calls,
        dispatch(cmd): void {
            calls.push(cmd);
        },
    };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PARAMS: DiffReviewParams = {
    projectId: 'proj-1',
    planId: 'plan-A',
    taskId: 'task-42',
    flowId: 'flow-9',
};

function fixtureDiff(): TaskDiffResponse {
    return {
        files: [
            {
                path: 'src/a.ts',
                hunks: [
                    {
                        header: '@@ -1,3 +1,4 @@',
                        lines: [
                            { kind: 'ctx', text: 'export const a = 1;' },
                            { kind: 'add', text: 'export const b = 2;' },
                        ],
                    },
                    {
                        header: '@@ -10,2 +11,3 @@',
                        lines: [
                            { kind: 'del', text: 'old' },
                            { kind: 'add', text: 'new' },
                        ],
                    },
                ],
            },
            {
                path: 'src/b.ts',
                hunks: [
                    {
                        header: '@@ -5,1 +5,2 @@',
                        lines: [{ kind: 'add', text: 'one' }],
                    },
                ],
            },
        ],
    };
}

// ---------------------------------------------------------------------------
// buildDiffUrl — pin the proxy contract
// ---------------------------------------------------------------------------

test('buildDiffUrl: builds the proxied worker-api diff route with encoded ids', () => {
    const url = buildDiffUrl({
        projectId: 'proj 1',
        planId: 'plan/A',
        taskId: 'task:42',
    });
    assert.equal(
        url,
        '/api/projects/proj%201/plans/plan%2FA/tasks/task%3A42/diff',
    );
});

// ---------------------------------------------------------------------------
// AC #1 — load + render
// ---------------------------------------------------------------------------

test('openDiffReview: opens the overlay, fetches the diff route, and renders hunks per file', async () => {
    const root = makeShimElement('div');
    const overlay = makeFakeOverlayManager();
    const fetcher = makeFakeFetch(jsonResponse(fixtureDiff()));
    const dispatcher = makeDispatchRecorder();

    const handle = openDiffReview(PARAMS, {
        element: root,
        overlayManager: overlay,
        fetch: fetcher.fn,
        dispatch: dispatcher.dispatch,
        onReject: (): void => {
            // noop for this case
        },
        doc: makeShimDocument(),
        now: () => 1_700_000_000_000,
    });

    // Overlay was opened before the fetch resolves (synchronous push so
    // the operator sees the loading state in the same tick).
    assert.equal(overlay.opens.length, 1);
    assert.equal(overlay.opens[0].id, DIFF_REVIEW_OVERLAY_ID);
    assert.equal(overlay.opens[0].element, root);

    // Loading placeholder rendered while the fetch is in flight.
    assert.ok(
        findFirst(root, (el) => el.attributes.has('data-diff-review-loading')),
        'expected the loading placeholder before the fetch resolves',
    );

    await handle.loaded;

    assert.equal(fetcher.calls.length, 1);
    assert.equal(fetcher.calls[0].url, buildDiffUrl(PARAMS));

    // Two-pane layout: every file shows up in the left-pane file list,
    // but only the currently-selected file's content is rendered in
    // the right pane. Default selection is the first file.
    const fileRows = findAll(root, (el) =>
        el.attributes.has('data-diff-file-row'),
    );
    assert.deepEqual(
        fileRows.map((r) => r.attributes.get('data-file-index')),
        ['0', '1'],
    );

    // Right-pane file header — only the selected file.
    const fileHeaders = findAll(root, (el) =>
        el.attributes.has('data-diff-file-header'),
    );
    assert.deepEqual(
        fileHeaders.map((h) => h.textContent),
        ['src/a.ts'],
    );

    // Hunks: only the selected file's two hunks are rendered.
    const hunks = findAll(root, (el) => el.attributes.has('data-diff-hunk'));
    assert.equal(hunks.length, 2);
    assert.deepEqual(
        hunks.map((h) => h.attributes.get('data-file-index') + ':' + h.attributes.get('data-hunk-index')),
        ['0:0', '0:1'],
    );

    // Hunk-nav chrome present (AC #2 preconditions).
    assert.ok(byAction(root, 'prev-hunk'));
    assert.ok(byAction(root, 'next-hunk'));
    const counter = findFirst(root, (el) => el.attributes.has('data-diff-hunk-counter'));
    assert.equal(counter?.textContent, '1 / 2 hunks');
});

test('openDiffReview: renders an empty-state when the diff has no files', async () => {
    const root = makeShimElement('div');
    const overlay = makeFakeOverlayManager();
    const fetcher = makeFakeFetch(jsonResponse({ files: [] }));
    const dispatcher = makeDispatchRecorder();

    const handle = openDiffReview(PARAMS, {
        element: root,
        overlayManager: overlay,
        fetch: fetcher.fn,
        dispatch: dispatcher.dispatch,
        onReject: (): void => undefined,
        doc: makeShimDocument(),
    });
    await handle.loaded;

    assert.ok(findFirst(root, (el) => el.attributes.has('data-diff-review-empty')));
    const counter = findFirst(root, (el) => el.attributes.has('data-diff-hunk-counter'));
    assert.equal(counter?.textContent, '0 / 0 hunks');
});

test('openDiffReview: surfaces an HTTP error when the diff endpoint fails', async () => {
    const root = makeShimElement('div');
    const overlay = makeFakeOverlayManager();
    const fetcher = makeFakeFetch(jsonResponse({ error: 'boom' }, 500));
    const dispatcher = makeDispatchRecorder();

    const handle = openDiffReview(PARAMS, {
        element: root,
        overlayManager: overlay,
        fetch: fetcher.fn,
        dispatch: dispatcher.dispatch,
        onReject: (): void => undefined,
        doc: makeShimDocument(),
    });
    await handle.loaded;

    const errPanel = findFirst(root, (el) =>
        el.attributes.has('data-diff-review-error'),
    );
    assert.ok(errPanel, 'expected an error panel for the failed fetch');
    const msg = findFirst(errPanel!, (el) =>
        (el.className ?? '').includes('diff-review-error-message'),
    );
    assert.match(msg!.textContent ?? '', /HTTP 500/);
});

// ---------------------------------------------------------------------------
// AC #2 — hunk navigation
// ---------------------------------------------------------------------------

test('prev/next buttons walk the selected file\'s hunks and clamp at both ends', async () => {
    const root = makeShimElement('div');
    const overlay = makeFakeOverlayManager();
    const fetcher = makeFakeFetch(jsonResponse(fixtureDiff()));
    const dispatcher = makeDispatchRecorder();

    const handle = openDiffReview(PARAMS, {
        element: root,
        overlayManager: overlay,
        fetch: fetcher.fn,
        dispatch: dispatcher.dispatch,
        onReject: (): void => undefined,
        doc: makeShimDocument(),
    });
    await handle.loaded;

    // The two-pane layout scopes hunk navigation to the currently
    // selected file. The fixture's first file has two hunks; the
    // operator switches files via the left-pane file list (covered
    // in its own test). Cross-file navigation via prev/next was the
    // single-pane layout's contract — the new layout makes the
    // file picker the primary navigation surface.
    const hunks = findAll(root, (el) => el.attributes.has('data-diff-hunk'));
    const prev = byAction(root, 'prev-hunk');
    const next = byAction(root, 'next-hunk');
    const counter = findFirst(root, (el) => el.attributes.has('data-diff-hunk-counter'))!;

    assert.equal(hunks.length, 2);
    assert.equal(hunks[0].attributes.get('data-active'), 'true');
    assert.equal(hunks[1].attributes.get('data-active'), 'false');
    assert.equal(prev.attributes.get('aria-disabled'), 'true');
    assert.equal(next.attributes.get('aria-disabled'), 'false');
    assert.equal(counter.textContent, '1 / 2 hunks');

    click(next);
    assert.equal(hunks[1].attributes.get('data-active'), 'true');
    assert.equal(counter.textContent, '2 / 2 hunks');
    assert.equal(next.attributes.get('aria-disabled'), 'true');

    // Past the end is a no-op.
    click(next);
    assert.equal(hunks[1].attributes.get('data-active'), 'true');

    click(prev);
    assert.equal(hunks[0].attributes.get('data-active'), 'true');
    assert.equal(prev.attributes.get('aria-disabled'), 'true');

    // Before the start clamps too.
    click(prev);
    assert.equal(hunks[0].attributes.get('data-active'), 'true');

    const scrolled = hunks.reduce((sum, h) => sum + h.scrollCalls, 0);
    assert.ok(scrolled >= 2, `expected at least 2 scroll calls across hunks, got ${scrolled}`);
});

test('clicking a file row in the left pane swaps the right pane to that file', async () => {
    const root = makeShimElement('div');
    const overlay = makeFakeOverlayManager();
    const fetcher = makeFakeFetch(jsonResponse(fixtureDiff()));
    const dispatcher = makeDispatchRecorder();

    const handle = openDiffReview(PARAMS, {
        element: root,
        overlayManager: overlay,
        fetch: fetcher.fn,
        dispatch: dispatcher.dispatch,
        onReject: (): void => undefined,
        doc: makeShimDocument(),
    });
    await handle.loaded;

    // Initial selection: first file (src/a.ts).
    let header = findFirst(root, (el) =>
        el.attributes.has('data-diff-file-header'),
    );
    assert.equal(header?.textContent, 'src/a.ts');

    // Click the second file row.
    const fileRows = findAll(root, (el) =>
        el.attributes.has('data-diff-file-row'),
    );
    click(fileRows[1]);

    // Right pane now shows src/b.ts and only its single hunk.
    header = findFirst(root, (el) =>
        el.attributes.has('data-diff-file-header'),
    );
    assert.equal(header?.textContent, 'src/b.ts');
    const hunks = findAll(root, (el) => el.attributes.has('data-diff-hunk'));
    assert.equal(hunks.length, 1);
    assert.equal(hunks[0].attributes.get('data-file-index'), '1');

    // Selection highlight followed the click.
    const refreshedRows = findAll(root, (el) =>
        el.attributes.has('data-diff-file-row'),
    );
    assert.ok(
        (refreshedRows[1].className ?? '').includes('diff-review-file-row--selected'),
    );
});

// ---------------------------------------------------------------------------
// AC #3 — Approve dispatches UpdateTask with the configured status
// ---------------------------------------------------------------------------

test('Approve button dispatches UpdateTask with the configured status transition and closes the overlay', async () => {
    const root = makeShimElement('div');
    const overlay = makeFakeOverlayManager();
    const fetcher = makeFakeFetch(jsonResponse(fixtureDiff()));
    const dispatcher = makeDispatchRecorder();
    let rejectCalls = 0;

    const handle = openDiffReview(PARAMS, {
        element: root,
        overlayManager: overlay,
        fetch: fetcher.fn,
        dispatch: dispatcher.dispatch,
        onReject: (): void => {
            rejectCalls += 1;
        },
        doc: makeShimDocument(),
        now: () => 1_700_000_000_000,
        actor: 'operator',
    });
    await handle.loaded;

    click(byAction(root, 'approve'));

    assert.equal(dispatcher.calls.length, 1);
    const cmd = dispatcher.calls[0];
    assert.equal(cmd.type, UPDATE_TASK_COMMAND);
    assert.equal(cmd.actor, 'operator');
    assert.equal(cmd.issuedAt, 1_700_000_000_000);
    assert.deepEqual(cmd.payload, {
        taskId: PARAMS.taskId,
        flowId: PARAMS.flowId,
        status: DEFAULT_APPROVE_STATUS,
    });

    // Reject was untouched.
    assert.equal(rejectCalls, 0);

    // Overlay closed exactly once.
    assert.deepEqual(overlay.closes, [DIFF_REVIEW_OVERLAY_ID]);

    // A second Approve click is a no-op on the close path
    // (idempotent — the handler de-dupes via the closed flag).
    click(byAction(root, 'approve'));
    assert.deepEqual(overlay.closes, [DIFF_REVIEW_OVERLAY_ID]);
});

test('Approve omits flowId from the payload when no flow is configured', async () => {
    const root = makeShimElement('div');
    const overlay = makeFakeOverlayManager();
    const fetcher = makeFakeFetch(jsonResponse(fixtureDiff()));
    const dispatcher = makeDispatchRecorder();

    const handle = openDiffReview(
        { projectId: 'p', planId: 'pl', taskId: 't' },
        {
            element: root,
            overlayManager: overlay,
            fetch: fetcher.fn,
            dispatch: dispatcher.dispatch,
            onReject: (): void => undefined,
            doc: makeShimDocument(),
            approveStatus: 'ready_to_commit',
        },
    );
    await handle.loaded;

    click(byAction(root, 'approve'));
    assert.equal(dispatcher.calls.length, 1);
    assert.deepEqual(dispatcher.calls[0].payload, {
        taskId: 't',
        status: 'ready_to_commit',
    });
});

// ---------------------------------------------------------------------------
// AC #4 — Reject closes the diff-review overlay and hands off to the host
// ---------------------------------------------------------------------------

test('Reject closes the diff-review overlay and invokes onReject with the task params', async () => {
    const root = makeShimElement('div');
    const overlay = makeFakeOverlayManager();
    const fetcher = makeFakeFetch(jsonResponse(fixtureDiff()));
    const dispatcher = makeDispatchRecorder();
    const rejectCalls: DiffReviewParams[] = [];

    const handle = openDiffReview(PARAMS, {
        element: root,
        overlayManager: overlay,
        fetch: fetcher.fn,
        dispatch: dispatcher.dispatch,
        onReject: (p): void => {
            rejectCalls.push(p);
        },
        doc: makeShimDocument(),
    });
    await handle.loaded;

    click(byAction(root, 'reject'));

    // Overlay closed first, then the host's reject callback fired.
    assert.deepEqual(overlay.closes, [DIFF_REVIEW_OVERLAY_ID]);
    assert.equal(rejectCalls.length, 1);
    assert.deepEqual(rejectCalls[0], PARAMS);

    // No UpdateTask dispatched on Reject.
    assert.equal(dispatcher.calls.length, 0);
});

// ---------------------------------------------------------------------------
// Programmatic close path
// ---------------------------------------------------------------------------

test('handle.close() closes the overlay once and is idempotent', async () => {
    const root = makeShimElement('div');
    const overlay = makeFakeOverlayManager();
    const fetcher = makeFakeFetch(jsonResponse(fixtureDiff()));
    const dispatcher = makeDispatchRecorder();

    const handle = openDiffReview(PARAMS, {
        element: root,
        overlayManager: overlay,
        fetch: fetcher.fn,
        dispatch: dispatcher.dispatch,
        onReject: (): void => undefined,
        doc: makeShimDocument(),
    });
    await handle.loaded;

    handle.close();
    handle.close();

    assert.deepEqual(overlay.closes, [DIFF_REVIEW_OVERLAY_ID]);
});
