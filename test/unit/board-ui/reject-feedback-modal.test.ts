/**
 * AP-VP5-012 unit tests for the reject-feedback modal.
 *
 * Covers every acceptance criterion the brief calls out:
 *   1. Modal renders a single textarea, Reject button, Cancel button.
 *   2. Reject button is disabled until the textarea has non-whitespace
 *      content; flips back to disabled when the operator clears it.
 *   3. Reject POSTs to /tasks/:id/reject with `{ feedback: <textarea> }`
 *      and closes on 202.
 *   4. Cancel and Escape close the modal without dispatching.
 *   5. Empty / whitespace-only feedback is rejected at the modal level
 *      (no POST attempted).
 *
 * Dual-runner test() shim — matches the AP-VP5-013 panel test: the repo's
 * `npm test` runs node:test; the review pipeline runs vitest on changed
 * files. The shim picks the right `test()` at module load so a single
 * source file is discovered by both runners.
 *
 * DOM strategy — hand-rolled shim. The modal speaks the structural
 * `RejectFeedbackElement` / `RejectFeedbackDocument` surface, so the
 * test never reaches for jsdom.
 */
import * as assert from 'node:assert/strict';

import {
    openRejectFeedbackModal,
    REJECT_FEEDBACK_ACCEPTED_STATUS,
    REJECT_FEEDBACK_CANCEL_TESTID,
    REJECT_FEEDBACK_OVERLAY_TESTID,
    REJECT_FEEDBACK_PLACEHOLDER,
    REJECT_FEEDBACK_SUBMIT_TESTID,
    type RejectFeedbackDocument,
    type RejectFeedbackElement,
    type RejectFeedbackFetch,
    type RejectFeedbackFetchInit,
    type RejectFeedbackKeyListener,
    type RejectFeedbackKeyTarget,
    type RejectFeedbackResponse,
} from '../../../hosts/board-ui/modals/reject-feedback';

// ---------------------------------------------------------------------------
// Dual-runner test() shim
// ---------------------------------------------------------------------------

type TestFn = (name: string, fn: () => void | Promise<void>) => void;

const test: TestFn = (((): TestFn => {
    if (process.env.VITEST) {
        const gt = (globalThis as { test?: TestFn }).test;
        if (typeof gt !== 'function') {
            throw new Error(
                'reject-feedback-modal.test.ts: VITEST=true but globalThis.test is missing — '
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

interface ShimElement extends RejectFeedbackElement {
    readonly tagName: string;
    readonly children: ShimElement[];
    readonly attributes: Map<string, string>;
    parent: ShimElement | null;
    focusCalls: number;
    onclick?: () => void;
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
        disabled: undefined,
        attributes: attrs,
        children,
        parent: null,
        focusCalls: 0,
        setAttribute(name: string, value: string): void {
            attrs.set(name, value);
        },
        removeAttribute(name: string): void {
            attrs.delete(name);
        },
        appendChild(child: RejectFeedbackElement): RejectFeedbackElement {
            const c = child as ShimElement;
            c.parent = el;
            children.push(c);
            return c;
        },
        remove(): void {
            const p = el.parent;
            if (p) {
                const idx = p.children.indexOf(el);
                if (idx >= 0) p.children.splice(idx, 1);
                el.parent = null;
            }
        },
        focus(): void {
            el.focusCalls++;
        },
    };
    return el;
}

function makeShimDocument(): { doc: RejectFeedbackDocument; parent: ShimElement } {
    const parent = makeShimElement('body');
    const doc: RejectFeedbackDocument = {
        createElement(tag: string): RejectFeedbackElement {
            return makeShimElement(tag);
        },
    };
    return { doc, parent };
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

function byTestId(root: ShimElement, testid: string): ShimElement {
    const hit = findFirst(root, (n) => n.attributes.get('data-testid') === testid);
    if (!hit) throw new Error(`no element with data-testid="${testid}"`);
    return hit;
}

// ---------------------------------------------------------------------------
// Fake fetch + key target
// ---------------------------------------------------------------------------

interface FetchCall {
    readonly url: string;
    readonly method: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: unknown;
}

interface FakeFetch {
    readonly fn: RejectFeedbackFetch;
    readonly calls: FetchCall[];
    /** Force the next call to resolve with the given status. */
    queueStatus(status: number): void;
    /** Force the next call to reject with the given error. */
    queueReject(error: unknown): void;
}

function makeFakeFetch(): FakeFetch {
    const calls: FetchCall[] = [];
    const queue: Array<() => Promise<RejectFeedbackResponse>> = [];
    // Implementation note (AP-VP5-012 attempt #3):
    //
    // Earlier revisions wrote `fn` as an `async function` and queued
    // `async () => ({...})` resolvers. That layered TWO async-function
    // wrappers between submit()'s `await` and the response, which inserts
    // an extra PromiseResolveThenableJob microtask into the chain — so
    // the close-on-202 path resolved on the third microtask while the
    // AC3 click-driven test only drained two (`await Promise.resolve()`
    // twice). The fix is to keep `fn` synchronous and return the queued
    // function's already-fulfilled promise directly: `await options.fetch()`
    // then resolves in a single microtask. The `await handle.submit()`
    // tests are unaffected because they drain the promise fully.
    return {
        calls,
        queueStatus(status: number): void {
            queue.push(() => Promise.resolve({ ok: status >= 200 && status < 300, status }));
        },
        queueReject(error: unknown): void {
            queue.push(() => Promise.reject(error));
        },
        fn(url: string, init?: RejectFeedbackFetchInit): Promise<RejectFeedbackResponse> {
            let parsed: unknown = undefined;
            if (typeof init?.body === 'string') {
                try {
                    parsed = JSON.parse(init.body);
                } catch {
                    parsed = init.body;
                }
            }
            calls.push({
                url,
                method: init?.method ?? 'GET',
                headers: { ...(init?.headers ?? {}) },
                body: parsed,
            });
            const next = queue.shift();
            if (!next) {
                return Promise.reject(
                    new Error(`unexpected fetch call: ${init?.method ?? 'GET'} ${url}`),
                );
            }
            return next();
        },
    };
}

interface FakeKeyTarget extends RejectFeedbackKeyTarget {
    listeners: RejectFeedbackKeyListener[];
    /** Synthesize a keydown event and dispatch to every registered listener. */
    fire(key: string): { preventDefaultCalls: number };
}

function makeFakeKeyTarget(): FakeKeyTarget {
    const listeners: RejectFeedbackKeyListener[] = [];
    return {
        listeners,
        addEventListener(_type: 'keydown', listener: RejectFeedbackKeyListener): void {
            listeners.push(listener);
        },
        removeEventListener(_type: 'keydown', listener: RejectFeedbackKeyListener): void {
            const idx = listeners.indexOf(listener);
            if (idx >= 0) listeners.splice(idx, 1);
        },
        fire(key: string): { preventDefaultCalls: number } {
            let preventDefaultCalls = 0;
            const event = {
                key,
                preventDefault(): void {
                    preventDefaultCalls++;
                },
            };
            for (const fn of [...listeners]) fn(event);
            return { preventDefaultCalls };
        },
    };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface OpenInput {
    readonly taskId?: string;
    readonly apiBase?: string;
    readonly onClose?: () => void;
    readonly onError?: (info: { status?: number; error?: unknown }) => void;
}

function openModal(input: OpenInput = {}) {
    const { doc, parent } = makeShimDocument();
    const fetchPort = makeFakeFetch();
    const keyTarget = makeFakeKeyTarget();
    const handle = openRejectFeedbackModal(
        {
            taskId: input.taskId ?? 'task-1',
            fetch: fetchPort.fn,
            apiBase: input.apiBase,
            onClose: input.onClose,
            onError: input.onError,
        },
        { doc, parent, keyTarget },
    );
    return { handle, fetchPort, keyTarget, parent, doc };
}

function type(textarea: RejectFeedbackElement, value: string): void {
    textarea.value = value;
    (textarea as ShimElement).oninput?.();
}

// ---------------------------------------------------------------------------
// AC #1 — renders textarea + Reject + Cancel
// ---------------------------------------------------------------------------

test('AC1: modal renders one textarea, Reject button, and Cancel button', () => {
    const { handle, parent } = openModal();
    const overlay = byTestId(parent, REJECT_FEEDBACK_OVERLAY_TESTID);
    // Overlay is mounted under the supplied parent.
    assert.equal((overlay as ShimElement).parent, parent);
    // Exactly one textarea, with the placeholder pinned by the task brief.
    const textareas = findAll(parent, (n) => n.tagName === 'textarea');
    assert.equal(textareas.length, 1);
    assert.equal(textareas[0]?.attributes.get('placeholder'), REJECT_FEEDBACK_PLACEHOLDER);
    // The handle's textarea reference points at that same node.
    assert.equal(handle.textarea, textareas[0]);
    // Reject + Cancel buttons present with the expected testids and labels.
    const submit = byTestId(parent, REJECT_FEEDBACK_SUBMIT_TESTID);
    const cancel = byTestId(parent, REJECT_FEEDBACK_CANCEL_TESTID);
    assert.equal(submit.tagName, 'button');
    assert.equal(cancel.tagName, 'button');
    assert.equal(submit.textContent, 'Reject');
    assert.equal(cancel.textContent, 'Cancel');
    // Dialog wiring — role + aria + data-task-id.
    assert.equal(overlay.attributes.get('role'), 'dialog');
    assert.equal(overlay.attributes.get('aria-modal'), 'true');
    assert.equal(overlay.attributes.get('data-task-id'), 'task-1');
});

test('AC1: textarea is pre-focused so keyboard users can start typing immediately', () => {
    const { handle } = openModal();
    assert.equal((handle.textarea as ShimElement).focusCalls, 1);
});

// ---------------------------------------------------------------------------
// AC #2 — Reject disabled until non-whitespace content
// ---------------------------------------------------------------------------

test('AC2: Reject button starts disabled', () => {
    const { handle, parent } = openModal();
    const submit = byTestId(parent, REJECT_FEEDBACK_SUBMIT_TESTID);
    assert.equal(submit.attributes.has('disabled'), true, 'disabled attribute set');
    assert.equal((submit as ShimElement).disabled, true, 'disabled property mirrored');
    assert.equal(handle.rejectButton, submit);
});

test('AC2: typing non-whitespace content enables the Reject button', () => {
    const { handle, parent } = openModal();
    const submit = byTestId(parent, REJECT_FEEDBACK_SUBMIT_TESTID);
    type(handle.textarea, 'Needs another pass over the diff.');
    assert.equal(submit.attributes.has('disabled'), false);
    assert.equal((submit as ShimElement).disabled, false);
});

test('AC2: whitespace-only content keeps the Reject button disabled', () => {
    const { handle, parent } = openModal();
    const submit = byTestId(parent, REJECT_FEEDBACK_SUBMIT_TESTID);
    type(handle.textarea, '   \n  \t  ');
    assert.equal(submit.attributes.has('disabled'), true);
    assert.equal((submit as ShimElement).disabled, true);
});

test('AC2: clearing the textarea re-disables the Reject button', () => {
    const { handle, parent } = openModal();
    const submit = byTestId(parent, REJECT_FEEDBACK_SUBMIT_TESTID);
    type(handle.textarea, 'Has content.');
    assert.equal((submit as ShimElement).disabled, false);
    type(handle.textarea, '');
    assert.equal(submit.attributes.has('disabled'), true);
    assert.equal((submit as ShimElement).disabled, true);
});

// ---------------------------------------------------------------------------
// AC #3 — Reject POSTs to /tasks/:id/reject and closes on 202
// ---------------------------------------------------------------------------

test('AC3: Reject POSTs to /tasks/:id/reject with the trimmed feedback', async () => {
    const closes: number[] = [];
    const { handle, parent, fetchPort } = openModal({
        taskId: 'task-42',
        onClose: () => closes.push(1),
    });
    fetchPort.queueStatus(REJECT_FEEDBACK_ACCEPTED_STATUS);
    type(handle.textarea, '   Please ship the migration too.   ');
    const submit = byTestId(parent, REJECT_FEEDBACK_SUBMIT_TESTID);
    submit.onclick?.();
    // Drain the awaited fetch.
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(fetchPort.calls.length, 1);
    assert.equal(fetchPort.calls[0]?.url, '/tasks/task-42/reject');
    assert.equal(fetchPort.calls[0]?.method, 'POST');
    assert.equal(fetchPort.calls[0]?.headers['Content-Type'], 'application/json');
    assert.deepEqual(fetchPort.calls[0]?.body, { feedback: 'Please ship the migration too.' });
    // 202 → modal closes, onClose fires once, overlay removed from parent.
    assert.equal(closes.length, 1);
    assert.equal(findFirst(parent, (n) => n.attributes.get('data-testid') === REJECT_FEEDBACK_OVERLAY_TESTID), null);
});

test('AC3: apiBase prefix is prepended to the request URL when supplied', async () => {
    const { handle, fetchPort } = openModal({ taskId: 'abc-9', apiBase: 'https://worker.example' });
    fetchPort.queueStatus(REJECT_FEEDBACK_ACCEPTED_STATUS);
    type(handle.textarea, 'feedback');
    await handle.submit();
    assert.equal(fetchPort.calls[0]?.url, 'https://worker.example/tasks/abc-9/reject');
});

test('AC3: task id is URL-encoded so an issue id with special chars is safe', async () => {
    const { handle, fetchPort } = openModal({ taskId: 'team/AI-1' });
    fetchPort.queueStatus(REJECT_FEEDBACK_ACCEPTED_STATUS);
    type(handle.textarea, 'nope');
    await handle.submit();
    assert.equal(fetchPort.calls[0]?.url, '/tasks/team%2FAI-1/reject');
});

test('AC3: non-202 responses leave the modal open and surface onError', async () => {
    const errors: Array<{ status?: number; error?: unknown }> = [];
    const closes: number[] = [];
    const { handle, parent, fetchPort } = openModal({
        onClose: () => closes.push(1),
        onError: (info) => errors.push(info),
    });
    fetchPort.queueStatus(500);
    type(handle.textarea, 'feedback');
    const result = await handle.submit();
    assert.equal(result, false);
    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.status, 500);
    assert.equal(closes.length, 0, 'onClose must not fire on a non-202');
    // Overlay still in the tree, ready for the retry.
    assert.ok(findFirst(parent, (n) => n.attributes.get('data-testid') === REJECT_FEEDBACK_OVERLAY_TESTID));
});

test('AC3: a fetch rejection surfaces through onError without dispatching close', async () => {
    const errors: Array<{ status?: number; error?: unknown }> = [];
    const { handle, fetchPort } = openModal({ onError: (info) => errors.push(info) });
    const boom = new Error('network down');
    fetchPort.queueReject(boom);
    type(handle.textarea, 'feedback');
    const result = await handle.submit();
    assert.equal(result, false);
    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.error, boom);
});

// ---------------------------------------------------------------------------
// AC #4 — Cancel and Escape close without dispatching
// ---------------------------------------------------------------------------

test('AC4: Cancel closes the modal without POSTing', () => {
    const closes: number[] = [];
    const { parent, fetchPort } = openModal({ onClose: () => closes.push(1) });
    const cancel = byTestId(parent, REJECT_FEEDBACK_CANCEL_TESTID);
    cancel.onclick?.();
    assert.equal(fetchPort.calls.length, 0);
    assert.equal(closes.length, 1);
    assert.equal(findFirst(parent, (n) => n.attributes.get('data-testid') === REJECT_FEEDBACK_OVERLAY_TESTID), null);
});

test('AC4: Escape via the key-target closes the modal without POSTing', () => {
    const closes: number[] = [];
    const { parent, fetchPort, keyTarget } = openModal({ onClose: () => closes.push(1) });
    assert.equal(keyTarget.listeners.length, 1, 'modal subscribed to keydown on open');
    const { preventDefaultCalls } = keyTarget.fire('Escape');
    assert.equal(preventDefaultCalls, 1, 'Escape is preventDefault-ed');
    assert.equal(fetchPort.calls.length, 0);
    assert.equal(closes.length, 1);
    assert.equal(findFirst(parent, (n) => n.attributes.get('data-testid') === REJECT_FEEDBACK_OVERLAY_TESTID), null);
    assert.equal(keyTarget.listeners.length, 0, 'modal unsubscribed on close');
});

test('AC4: non-Escape keys are ignored', () => {
    const closes: number[] = [];
    const { parent, keyTarget, handle } = openModal({ onClose: () => closes.push(1) });
    keyTarget.fire('Enter');
    keyTarget.fire('a');
    assert.equal(closes.length, 0);
    assert.ok(findFirst(parent, (n) => n.attributes.get('data-testid') === REJECT_FEEDBACK_OVERLAY_TESTID));
    // The handle's direct handleKeydown entry behaves the same.
    handle.handleKeydown({ key: 'Tab' });
    assert.equal(closes.length, 0);
});

test('AC4: handle.handleKeydown closes on Escape (host-driven wiring)', () => {
    const closes: number[] = [];
    const { handle, parent, fetchPort } = openModal({ onClose: () => closes.push(1) });
    let prevented = 0;
    handle.handleKeydown({ key: 'Escape', preventDefault: () => { prevented++; } });
    assert.equal(prevented, 1);
    assert.equal(fetchPort.calls.length, 0);
    assert.equal(closes.length, 1);
    assert.equal(findFirst(parent, (n) => n.attributes.get('data-testid') === REJECT_FEEDBACK_OVERLAY_TESTID), null);
});

test('AC4: close is idempotent — a second Cancel does not refire onClose', () => {
    const closes: number[] = [];
    const { parent } = openModal({ onClose: () => closes.push(1) });
    const cancel = byTestId(parent, REJECT_FEEDBACK_CANCEL_TESTID);
    cancel.onclick?.();
    cancel.onclick?.();
    assert.equal(closes.length, 1);
});

// ---------------------------------------------------------------------------
// AC #5 — empty/whitespace feedback never POSTs
// ---------------------------------------------------------------------------

test('AC5: clicking Reject with an empty textarea does not POST', async () => {
    const { handle, parent, fetchPort } = openModal();
    const submit = byTestId(parent, REJECT_FEEDBACK_SUBMIT_TESTID);
    submit.onclick?.();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(fetchPort.calls.length, 0);
    // Modal stays open.
    assert.ok(findFirst(parent, (n) => n.attributes.get('data-testid') === REJECT_FEEDBACK_OVERLAY_TESTID));
    // Programmatic submit() also no-ops.
    const result = await handle.submit();
    assert.equal(result, false);
    assert.equal(fetchPort.calls.length, 0);
});

test('AC5: programmatic submit() with whitespace-only feedback no-ops and re-focuses textarea', async () => {
    const { handle, fetchPort } = openModal();
    type(handle.textarea, '   \n  ');
    const focusBefore = (handle.textarea as ShimElement).focusCalls;
    const result = await handle.submit();
    assert.equal(result, false);
    assert.equal(fetchPort.calls.length, 0);
    assert.equal((handle.textarea as ShimElement).focusCalls, focusBefore + 1);
});
