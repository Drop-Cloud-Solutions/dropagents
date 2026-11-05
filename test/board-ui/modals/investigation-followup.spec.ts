/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Unit tests for the AP-VP5-011 investigation follow-up modal.
 *
 * Coverage matches the task's acceptance criteria:
 *   AC #1 — thread renders chronologically with role + timestamp,
 *   AC #2 — Ask dispatches `AskInvestigationFollowup` and clears the
 *           textarea on a resolved dispatch,
 *   AC #3 — thread re-fetches after a successful follow-up,
 *   AC #4 — empty thread renders the `no follow-ups yet` placeholder,
 *   AC #5 — Close button + idempotent close() match the clarify modal's
 *           lifecycle (Escape is handled by the overlay-manager wrapper
 *           in production; the modal exposes the close() hook the
 *           manager calls back into).
 *
 * DOM strategy: hand-rolled shim, mirroring the clarify modal's spec
 * pattern at `test/board-ui/modals/clarify.spec.ts`. The shim implements
 * the narrow surface the modal reads (className, setAttribute,
 * appendChild, replaceChildren, remove, focus, textContent, value).
 *
 * Dual-runner test() shim — mirrors the clarify spec so this file runs
 * under both `node --test --import tsx` (the repo's `npm test`) and
 * vitest (the review pipeline's runner).
 */
import * as assert from 'node:assert/strict';

import {
    FOLLOWUP_ASK_LABEL,
    FOLLOWUP_ASK_TESTID,
    FOLLOWUP_CLOSE_LABEL,
    FOLLOWUP_CLOSE_TESTID,
    FOLLOWUP_EMPTY_MESSAGE,
    FOLLOWUP_EMPTY_TESTID,
    FOLLOWUP_OVERLAY_TESTID,
    FOLLOWUP_TEXTAREA_TESTID,
    FOLLOWUP_THREAD_TESTID,
    FOLLOWUP_TOAST_ERROR_MESSAGE,
    FOLLOWUP_TOAST_FETCH_ERROR_MESSAGE,
    FOLLOWUP_TOAST_SUCCESS_MESSAGE,
    FOLLOWUP_TURN_TESTID,
    openInvestigationFollowupModal,
    type AskInvestigationFollowupCommand,
    type FollowupDispatcher,
    type FollowupDocument,
    type FollowupElement,
    type FollowupThreadEntry,
    type FollowupToastOptions,
    type FollowupToastPort,
    type ThreadFetcher,
} from '../../../hosts/board-ui/client/modals/investigation-followup';

// ---------------------------------------------------------------------------
// Dual-runner test() shim
// ---------------------------------------------------------------------------

type TestFn = (name: string, fn: () => void | Promise<void>) => void;

const test: TestFn = (((): TestFn => {
    if (process.env.VITEST) {
        const gt = (globalThis as { test?: TestFn }).test;
        if (typeof gt !== 'function') {
            throw new Error(
                'investigation-followup.spec.ts: VITEST=true but globalThis.test '
                    + 'is missing — ensure vitest.config.ts sets test.globals = true',
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

interface ShimElement extends FollowupElement {
    readonly tagName: string;
    readonly children: ShimElement[];
    readonly attributes: Map<string, string>;
    parent: ShimElement | null;
    removed: boolean;
    focusCalls: number;
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
        hidden: false,
        children,
        attributes: attrs,
        parent: null,
        removed: false,
        focusCalls: 0,
        setAttribute(name: string, value: string): void {
            attrs.set(name, value);
        },
        appendChild(child: FollowupElement): FollowupElement {
            const c = child as ShimElement;
            c.parent = el;
            children.push(c);
            return c;
        },
        replaceChildren(...next: FollowupElement[]): void {
            for (const child of children) child.parent = null;
            children.length = 0;
            for (const child of next) {
                const c = child as ShimElement;
                c.parent = el;
                children.push(c);
            }
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
        focus(): void {
            el.focusCalls += 1;
        },
    };
    return el;
}

interface ShimDocument {
    doc: FollowupDocument;
    body: ShimElement;
}

function makeShimDocument(): ShimDocument {
    const body = makeShimElement('body');
    const doc: FollowupDocument = {
        createElement(tagName: string): FollowupElement {
            return makeShimElement(tagName);
        },
    };
    return { doc, body };
}

function findByTestId(root: ShimElement, testId: string): ShimElement | null {
    if (root.attributes.get('data-testid') === testId) return root;
    for (const child of root.children) {
        const hit = findByTestId(child, testId);
        if (hit) return hit;
    }
    return null;
}

function findAllByTestId(root: ShimElement, testId: string): ShimElement[] {
    const out: ShimElement[] = [];
    function walk(el: ShimElement): void {
        if (el.attributes.get('data-testid') === testId) out.push(el);
        for (const child of el.children) walk(child);
    }
    walk(root);
    return out;
}

function asShim(el: FollowupElement | null): ShimElement {
    if (!el) throw new Error('expected an element, got null');
    return el as ShimElement;
}

// ---------------------------------------------------------------------------
// Recording fakes
// ---------------------------------------------------------------------------

function makeRecordingDispatcher(): {
    dispatcher: FollowupDispatcher;
    calls: AskInvestigationFollowupCommand[];
} {
    const calls: AskInvestigationFollowupCommand[] = [];
    const dispatcher: FollowupDispatcher = (
        command: AskInvestigationFollowupCommand,
    ): void => {
        calls.push(command);
    };
    return { dispatcher, calls };
}

function makeRecordingToast(): {
    toast: FollowupToastPort;
    calls: FollowupToastOptions[];
} {
    const calls: FollowupToastOptions[] = [];
    return {
        calls,
        toast: {
            showToast(opts: FollowupToastOptions): void {
                calls.push(opts);
            },
        },
    };
}

interface ScriptedFetcher {
    fetchThread: ThreadFetcher;
    calls: string[];
    /** Queue the next thread snapshot the fetcher should resolve with. */
    queue(thread: ReadonlyArray<FollowupThreadEntry>): void;
}

function makeScriptedFetcher(): ScriptedFetcher {
    const calls: string[] = [];
    const queued: Array<ReadonlyArray<FollowupThreadEntry>> = [];
    return {
        calls,
        queue(thread): void {
            queued.push(thread);
        },
        fetchThread: async (taskId: string) => {
            calls.push(taskId);
            // Default to an empty thread when the test forgot to queue
            // a snapshot for a given call — keeps the modal stable in
            // tests that only care about other behaviours.
            return queued.shift() ?? [];
        },
    };
}

const ISO_FMT = (ts: number): string => new Date(ts).toISOString();

// ---------------------------------------------------------------------------
// AC #1 / #4 — render: empty + multi-turn
// ---------------------------------------------------------------------------

test('openInvestigationFollowupModal mounts the overlay with thread, textarea, Ask and Close', () => {
    const { doc, body } = makeShimDocument();
    const { dispatcher } = makeRecordingDispatcher();
    const fetcher = makeScriptedFetcher();

    const handle = openInvestigationFollowupModal(
        {
            taskId: 'AP-100',
            dispatcher,
            fetchThread: fetcher.fetchThread,
        },
        { doc, parent: body },
    );

    assert.equal(body.children.length, 1, 'overlay must be mounted under parent');
    const overlay = asShim(handle.overlay);
    assert.equal(overlay.attributes.get('data-testid'), FOLLOWUP_OVERLAY_TESTID);
    assert.equal(overlay.attributes.get('data-task-id'), 'AP-100');
    assert.equal(overlay.attributes.get('role'), 'dialog');
    assert.equal(overlay.attributes.get('aria-modal'), 'true');

    const textarea = asShim(handle.textarea);
    assert.equal(textarea.tagName, 'textarea');
    assert.equal(textarea.attributes.get('data-testid'), FOLLOWUP_TEXTAREA_TESTID);

    const askButton = asShim(handle.askButton);
    assert.equal(askButton.tagName, 'button');
    assert.equal(askButton.textContent, FOLLOWUP_ASK_LABEL);
    assert.equal(askButton.attributes.get('data-testid'), FOLLOWUP_ASK_TESTID);

    const closeButton = asShim(handle.closeButton);
    assert.equal(closeButton.tagName, 'button');
    assert.equal(closeButton.textContent, FOLLOWUP_CLOSE_LABEL);
    assert.equal(closeButton.attributes.get('data-testid'), FOLLOWUP_CLOSE_TESTID);

    // Initial render uses an empty thread.
    const thread = asShim(handle.threadContainer);
    assert.equal(thread.attributes.get('data-testid'), FOLLOWUP_THREAD_TESTID);
    const empty = findByTestId(thread, FOLLOWUP_EMPTY_TESTID);
    assert.ok(empty, 'empty placeholder must render before the first fetch resolves');
    assert.equal(empty.textContent, FOLLOWUP_EMPTY_MESSAGE);
});

test('renders the empty placeholder when fetchThread resolves to an empty array', async () => {
    const { doc, body } = makeShimDocument();
    const { dispatcher } = makeRecordingDispatcher();
    const fetcher = makeScriptedFetcher();
    fetcher.queue([]); // initial fetch resolves to empty.

    const handle = openInvestigationFollowupModal(
        {
            taskId: 'AP-101',
            dispatcher,
            fetchThread: fetcher.fetchThread,
        },
        { doc, parent: body },
    );

    // Drain the fire-and-forget initial fetch.
    await handle.refresh();

    const overlay = asShim(handle.overlay);
    const empty = findByTestId(overlay, FOLLOWUP_EMPTY_TESTID);
    assert.ok(empty, 'expected the empty-thread placeholder');
    assert.equal(empty.textContent, FOLLOWUP_EMPTY_MESSAGE);

    // No turn elements were emitted.
    assert.equal(findAllByTestId(overlay, FOLLOWUP_TURN_TESTID).length, 0);
});

test('renders a multi-turn thread chronologically with role + timestamp', async () => {
    const { doc, body } = makeShimDocument();
    const { dispatcher } = makeRecordingDispatcher();
    const fetcher = makeScriptedFetcher();
    const thread: FollowupThreadEntry[] = [
        { role: 'operator', content: 'Why is the build red?', timestamp: 1_000 },
        { role: 'investigator', content: 'Upstream cache was poisoned.', timestamp: 2_000 },
        { role: 'operator', content: 'Roll it back?', timestamp: 3_000 },
    ];
    fetcher.queue(thread);

    const handle = openInvestigationFollowupModal(
        {
            taskId: 'AP-110',
            dispatcher,
            fetchThread: fetcher.fetchThread,
            formatTimestamp: ISO_FMT,
        },
        { doc, parent: body },
    );

    await handle.refresh();

    const overlay = asShim(handle.overlay);
    const turns = findAllByTestId(overlay, FOLLOWUP_TURN_TESTID);
    assert.equal(turns.length, 3, 'expected one rendered turn per thread entry');

    // Chronological order is preserved.
    assert.deepEqual(
        turns.map((t) => t.attributes.get('data-turn-index')),
        ['0', '1', '2'],
    );
    assert.deepEqual(
        turns.map((t) => t.attributes.get('data-role')),
        ['operator', 'investigator', 'operator'],
    );
    assert.deepEqual(
        turns.map((t) => t.attributes.get('data-timestamp')),
        ['1000', '2000', '3000'],
    );

    // Role + timestamp + content all surface in the rendered tree.
    const firstTurn = turns[0];
    const roleEl = firstTurn.children[0].children[0]; // header > role
    const tsEl = firstTurn.children[0].children[1]; // header > timestamp
    const bodyEl = firstTurn.children[1]; // body
    assert.equal(roleEl.textContent, 'operator');
    assert.equal(tsEl.textContent, ISO_FMT(1_000));
    assert.equal(tsEl.attributes.get('datetime'), new Date(1_000).toISOString());
    assert.equal(bodyEl.textContent, 'Why is the build red?');

    // The empty placeholder is gone.
    assert.equal(findByTestId(overlay, FOLLOWUP_EMPTY_TESTID), null);

    // currentThread() exposes the rendered snapshot for assertions that
    // don't want to scrape the DOM.
    assert.deepEqual(handle.currentThread(), thread);
});

// ---------------------------------------------------------------------------
// AC #2 — Ask dispatches and clears the textarea on success
// ---------------------------------------------------------------------------

test('Ask dispatches AskInvestigationFollowup with the trimmed question and clears the textarea', async () => {
    const { doc, body } = makeShimDocument();
    const { dispatcher, calls } = makeRecordingDispatcher();
    const fetcher = makeScriptedFetcher();
    fetcher.queue([]); // initial load.
    fetcher.queue([
        { role: 'operator', content: 'Roll back the migration', timestamp: 42 },
    ]); // post-Ask refresh.

    const handle = openInvestigationFollowupModal(
        {
            taskId: 'AP-200',
            dispatcher,
            fetchThread: fetcher.fetchThread,
        },
        { doc, parent: body },
    );

    await handle.refresh(); // drain initial fetch.

    handle.textarea.value = '   Roll back the migration   ';
    const ok = await handle.ask();

    assert.equal(ok, true, 'ask must report success on a resolved dispatch');
    assert.equal(calls.length, 1, 'exactly one command must be dispatched');
    assert.deepEqual(calls[0], {
        type: 'AskInvestigationFollowup',
        payload: { taskId: 'AP-200', question: 'Roll back the migration' },
    });

    // Textarea is cleared so the operator can type a follow-up.
    assert.equal(handle.textarea.value, '');

    // Modal stays open after a successful Ask (Close lifecycle is the
    // operator's call — clarify-style Submit-closes does NOT apply here
    // because the operator likely wants to read the answer).
    assert.equal(asShim(handle.overlay).removed, false);
});

test('Ask is a no-op on an empty textarea — no dispatch, no fetch, no clear', async () => {
    const { doc, body } = makeShimDocument();
    const { dispatcher, calls } = makeRecordingDispatcher();
    const fetcher = makeScriptedFetcher();
    fetcher.queue([]);

    const handle = openInvestigationFollowupModal(
        {
            taskId: 'AP-201',
            dispatcher,
            fetchThread: fetcher.fetchThread,
        },
        { doc, parent: body },
    );

    await handle.refresh();
    const fetchCallsBefore = fetcher.calls.length;

    handle.textarea.value = '    \n\t  ';
    const ok = await handle.ask();

    assert.equal(ok, false);
    assert.equal(calls.length, 0, 'no dispatch on empty input');
    assert.equal(
        fetcher.calls.length,
        fetchCallsBefore,
        'no refresh on empty input',
    );
    assert.equal(handle.textarea.value, '    \n\t  ', 'value preserved');
    // Empty input re-focuses the textarea (focusCalls = initial pre-focus + this).
    assert.ok(asShim(handle.textarea).focusCalls >= 2);
});

test('clicking the Ask button dispatches the same command (click handler wired)', async () => {
    const { doc, body } = makeShimDocument();
    const { dispatcher, calls } = makeRecordingDispatcher();
    const fetcher = makeScriptedFetcher();
    fetcher.queue([]);
    fetcher.queue([]);

    const handle = openInvestigationFollowupModal(
        {
            taskId: 'AP-202',
            dispatcher,
            fetchThread: fetcher.fetchThread,
        },
        { doc, parent: body },
    );

    await handle.refresh();
    handle.textarea.value = 'pin upstream cache';

    const askBtn = asShim(handle.askButton);
    assert.ok(askBtn.onclick, 'Ask button must have an onclick handler');
    askBtn.onclick?.();
    // Click handler is fire-and-forget; drain microtasks so the dispatch
    // + clear + refresh all land before the assertions run.
    for (let i = 0; i < 4; i++) await Promise.resolve();

    assert.equal(calls.length, 1);
    assert.equal(calls[0].payload.question, 'pin upstream cache');
});

// ---------------------------------------------------------------------------
// AC #3 — thread re-fetches after a successful follow-up
// ---------------------------------------------------------------------------

test('a successful Ask re-fetches the thread and renders the new turn', async () => {
    const { doc, body } = makeShimDocument();
    const { dispatcher } = makeRecordingDispatcher();
    const fetcher = makeScriptedFetcher();
    fetcher.queue([]); // initial load — empty.
    fetcher.queue([
        { role: 'operator', content: 'do x', timestamp: 100 },
        { role: 'investigator', content: 'done', timestamp: 200 },
    ]); // refresh after Ask.

    const handle = openInvestigationFollowupModal(
        {
            taskId: 'AP-300',
            dispatcher,
            fetchThread: fetcher.fetchThread,
            formatTimestamp: ISO_FMT,
        },
        { doc, parent: body },
    );

    await handle.refresh(); // drain initial.
    assert.equal(fetcher.calls.length, 1);
    assert.equal(handle.currentThread().length, 0);

    handle.textarea.value = 'do x';
    const ok = await handle.ask();
    assert.equal(ok, true);

    // The Ask path fires a second fetch — the modal now reflects
    // the operator + investigator turns the orchestrator persisted.
    assert.equal(fetcher.calls.length, 2);
    assert.equal(handle.currentThread().length, 2);

    const overlay = asShim(handle.overlay);
    const turns = findAllByTestId(overlay, FOLLOWUP_TURN_TESTID);
    assert.equal(turns.length, 2);
    assert.equal(turns[0].attributes.get('data-role'), 'operator');
    assert.equal(turns[1].attributes.get('data-role'), 'investigator');
});

test('Ask failure does NOT clear the textarea, does NOT refresh, and fires an error toast', async () => {
    const { doc, body } = makeShimDocument();
    const { toast, calls: toasted } = makeRecordingToast();
    const fetcher = makeScriptedFetcher();
    fetcher.queue([]);

    let attempts = 0;
    const dispatcher: FollowupDispatcher = (): Promise<void> => {
        attempts += 1;
        return Promise.reject(new Error('bus offline'));
    };

    const handle = openInvestigationFollowupModal(
        {
            taskId: 'AP-310',
            dispatcher,
            fetchThread: fetcher.fetchThread,
            toast,
        },
        { doc, parent: body },
    );

    await handle.refresh();
    const fetchCallsAfterInit = fetcher.calls.length;

    handle.textarea.value = 'retry me';
    const ok = await handle.ask();

    assert.equal(ok, false);
    assert.equal(attempts, 1, 'dispatch was attempted before failing');
    assert.equal(
        fetcher.calls.length,
        fetchCallsAfterInit,
        'no refresh on a failed Ask',
    );
    // Textarea value preserved so the operator can retry without retyping.
    assert.equal(handle.textarea.value, 'retry me');
    assert.equal(asShim(handle.overlay).removed, false, 'modal stays open');

    assert.ok(
        toasted.some(
            (t) =>
                t.kind === 'error'
                && t.message === FOLLOWUP_TOAST_ERROR_MESSAGE,
        ),
        'error toast must fire on a failed Ask',
    );
});

test('Ask success fires the success toast through the injected port', async () => {
    const { doc, body } = makeShimDocument();
    const { dispatcher } = makeRecordingDispatcher();
    const { toast, calls: toasted } = makeRecordingToast();
    const fetcher = makeScriptedFetcher();
    fetcher.queue([]);
    fetcher.queue([{ role: 'operator', content: 'q', timestamp: 1 }]);

    const handle = openInvestigationFollowupModal(
        {
            taskId: 'AP-320',
            dispatcher,
            fetchThread: fetcher.fetchThread,
            toast,
        },
        { doc, parent: body },
    );

    await handle.refresh();
    handle.textarea.value = 'q';

    const ok = await handle.ask();
    assert.equal(ok, true);
    assert.ok(
        toasted.some(
            (t) =>
                t.kind === 'success'
                && t.message === FOLLOWUP_TOAST_SUCCESS_MESSAGE,
        ),
        'success toast must fire on a resolved Ask',
    );
});

test('fetchThread rejection surfaces a fetch-error toast and leaves the prior render intact', async () => {
    const { doc, body } = makeShimDocument();
    const { dispatcher } = makeRecordingDispatcher();
    const { toast, calls: toasted } = makeRecordingToast();

    // First fetch resolves; second fetch rejects.
    let attempt = 0;
    const fetchThread: ThreadFetcher = async () => {
        attempt += 1;
        if (attempt === 1) {
            return [
                { role: 'operator', content: 'keep me', timestamp: 1 },
            ];
        }
        throw new Error('worker-api down');
    };

    const handle = openInvestigationFollowupModal(
        { taskId: 'AP-330', dispatcher, fetchThread, toast },
        { doc, parent: body },
    );

    await handle.refresh(); // first refresh — succeeds.
    assert.equal(handle.currentThread().length, 1);

    const failed = await handle.refresh(); // second refresh — fails.
    assert.equal(failed, false);
    // Last successful thread is still what's exposed; the rendered tree
    // was not wiped on a failed fetch.
    assert.equal(handle.currentThread().length, 1);
    assert.ok(
        toasted.some(
            (t) =>
                t.kind === 'error'
                && t.message === FOLLOWUP_TOAST_FETCH_ERROR_MESSAGE,
        ),
        'fetch-error toast must fire on a failed refresh',
    );
});

// ---------------------------------------------------------------------------
// AC #5 — Close lifecycle matches the clarify modal
// ---------------------------------------------------------------------------

test('clicking Close removes the overlay and fires onClose exactly once', () => {
    const { doc, body } = makeShimDocument();
    const { dispatcher } = makeRecordingDispatcher();
    const fetcher = makeScriptedFetcher();
    let closeCount = 0;

    const handle = openInvestigationFollowupModal(
        {
            taskId: 'AP-400',
            dispatcher,
            fetchThread: fetcher.fetchThread,
            onClose: () => {
                closeCount += 1;
            },
        },
        { doc, parent: body },
    );

    const closeBtn = asShim(handle.closeButton);
    assert.ok(closeBtn.onclick, 'Close button must have an onclick handler');
    closeBtn.onclick?.();

    assert.equal(asShim(handle.overlay).removed, true);
    assert.equal(body.children.length, 0);
    assert.equal(closeCount, 1);
});

test('handle.close() is idempotent — a second close does not re-fire onClose', () => {
    const { doc, body } = makeShimDocument();
    const { dispatcher } = makeRecordingDispatcher();
    const fetcher = makeScriptedFetcher();
    let closeCount = 0;

    const handle = openInvestigationFollowupModal(
        {
            taskId: 'AP-401',
            dispatcher,
            fetchThread: fetcher.fetchThread,
            onClose: () => {
                closeCount += 1;
            },
        },
        { doc, parent: body },
    );

    handle.close();
    handle.close();
    handle.close();

    assert.equal(closeCount, 1, 'onClose fires exactly once across repeat closes');
});

test('Ask after close is a no-op (closed modals are inert)', async () => {
    const { doc, body } = makeShimDocument();
    const { dispatcher, calls } = makeRecordingDispatcher();
    const fetcher = makeScriptedFetcher();

    const handle = openInvestigationFollowupModal(
        {
            taskId: 'AP-402',
            dispatcher,
            fetchThread: fetcher.fetchThread,
        },
        { doc, parent: body },
    );

    handle.textarea.value = 'too late';
    handle.close();

    const ok = await handle.ask();
    assert.equal(ok, false);
    assert.equal(calls.length, 0);
});
