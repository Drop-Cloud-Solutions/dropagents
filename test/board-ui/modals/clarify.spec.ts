/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Unit tests for the AP-IFF-015 clarify modal.
 *
 * Coverage matches the task's acceptance criteria:
 *   AC #1 — form renders with textarea and Submit/Cancel buttons,
 *   AC #2 — Submit dispatches `UpdateTask` with the clarification text,
 *   AC #3 — empty (or whitespace-only) textarea blocks submit, no
 *           dispatch fires and the modal stays open,
 *   AC #4 — Cancel closes the modal without dispatching, and reuse of
 *           the handle after close is a no-op.
 *
 * Plus the reviewer-feedback toast assertions (attempt #2):
 *   - success toast on resolved dispatch,
 *   - error toast on rejected dispatch, modal stays open for retry.
 *
 * DOM strategy — hand-rolled shim.
 * --------------------------------
 * jsdom is not in the project's dependency graph and the existing
 * convention for board-ui chrome widgets is a minimal shim (see
 * `hosts/board-ui/client/chrome/overlay-manager.spec.ts` +
 * `chrome/toast.spec.ts` for the rationale). The shim below models
 * only the surface the clarify modal actually consumes — appendChild,
 * setAttribute, remove, focus, textContent, value, hidden. The toast
 * port is injected as a recording fake so toast assertions add no
 * jsdom dependency either.
 *
 * Dual-runner test() shim — mirrors `chrome/toast.spec.ts` so this
 * file runs under both `node --test --import tsx` (the repo's
 * `npm test`) and vitest (the review pipeline's runner). See that
 * file's header for the full reasoning.
 */
import * as assert from 'node:assert/strict';

import type { ShowToastOptions } from '../../../hosts/board-ui/client/chrome/toast';
import {
    CLARIFY_CANCEL_LABEL,
    CLARIFY_CANCEL_TESTID,
    CLARIFY_OVERLAY_TESTID,
    CLARIFY_SUBMIT_LABEL,
    CLARIFY_SUBMIT_TESTID,
    CLARIFY_TEXTAREA_TESTID,
    CLARIFY_TOAST_ERROR_MESSAGE,
    CLARIFY_TOAST_SUCCESS_MESSAGE,
    type ClarifyCommand,
    type ClarifyDispatcher,
    type ClarifyDocument,
    type ClarifyElement,
    type ClarifyToastPort,
    openClarifyModal,
} from '../../../hosts/board-ui/client/modals/clarify';

// ---------------------------------------------------------------------------
// Dual-runner test() shim
// ---------------------------------------------------------------------------

type TestFn = (name: string, fn: () => void | Promise<void>) => void;

const test: TestFn = (((): TestFn => {
    if (process.env.VITEST) {
        const gt = (globalThis as { test?: TestFn }).test;
        if (typeof gt !== 'function') {
            throw new Error(
                'clarify.spec.ts: VITEST=true but globalThis.test is missing — '
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

interface ShimElement extends ClarifyElement {
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
        appendChild(child: ClarifyElement): ClarifyElement {
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
        focus(): void {
            el.focusCalls += 1;
        },
    };
    return el;
}

interface ShimDocument {
    doc: ClarifyDocument;
    body: ShimElement;
}

function makeShimDocument(): ShimDocument {
    const body = makeShimElement('body');
    const doc: ClarifyDocument = {
        createElement(tagName: string): ClarifyElement {
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

function asShim(el: ClarifyElement | null): ShimElement {
    if (!el) throw new Error('expected an element, got null');
    return el as ShimElement;
}

function makeRecordingDispatcher(): {
    dispatcher: ClarifyDispatcher;
    calls: ClarifyCommand[];
} {
    const calls: ClarifyCommand[] = [];
    return {
        calls,
        dispatcher: {
            dispatch(command: ClarifyCommand): void {
                calls.push(command);
            },
        },
    };
}

function makeRecordingToast(): {
    toast: ClarifyToastPort;
    calls: ShowToastOptions[];
} {
    const calls: ShowToastOptions[] = [];
    return {
        calls,
        toast: {
            showToast(opts: ShowToastOptions): void {
                calls.push(opts);
            },
        },
    };
}

// ---------------------------------------------------------------------------
// AC #1 — render shape: textarea + Submit/Cancel
// ---------------------------------------------------------------------------

test('openClarifyModal renders an overlay with a textarea, Submit, and Cancel buttons', () => {
    const { doc, body } = makeShimDocument();
    const { dispatcher } = makeRecordingDispatcher();

    const handle = openClarifyModal(
        { taskId: 'AP-001', dispatcher },
        { doc, parent: body },
    );

    // Overlay mounted under the parent.
    assert.equal(body.children.length, 1);
    const overlay = asShim(handle.overlay);
    assert.equal(body.children[0], overlay);
    assert.equal(overlay.attributes.get('data-testid'), CLARIFY_OVERLAY_TESTID);
    assert.equal(overlay.attributes.get('data-task-id'), 'AP-001');
    assert.equal(overlay.attributes.get('role'), 'dialog');
    assert.equal(overlay.attributes.get('aria-modal'), 'true');

    // Textarea + buttons reachable through the handle.
    const textarea = asShim(handle.textarea);
    assert.equal(textarea.tagName, 'textarea');
    assert.equal(
        textarea.attributes.get('data-testid'),
        CLARIFY_TEXTAREA_TESTID,
    );

    const submitButton = asShim(handle.submitButton);
    assert.equal(submitButton.tagName, 'button');
    assert.equal(submitButton.textContent, CLARIFY_SUBMIT_LABEL);
    assert.equal(
        submitButton.attributes.get('data-testid'),
        CLARIFY_SUBMIT_TESTID,
    );

    const cancelButton = asShim(handle.cancelButton);
    assert.equal(cancelButton.tagName, 'button');
    assert.equal(cancelButton.textContent, CLARIFY_CANCEL_LABEL);
    assert.equal(
        cancelButton.attributes.get('data-testid'),
        CLARIFY_CANCEL_TESTID,
    );

    // And they're discoverable through the DOM tree, not just the handle —
    // proves the overlay structure carries them, not just the return value.
    assert.equal(findByTestId(overlay, CLARIFY_TEXTAREA_TESTID), textarea);
    assert.equal(findByTestId(overlay, CLARIFY_SUBMIT_TESTID), submitButton);
    assert.equal(findByTestId(overlay, CLARIFY_CANCEL_TESTID), cancelButton);
});

test('openClarifyModal renders the question text when provided', () => {
    const { doc, body } = makeShimDocument();
    const { dispatcher } = makeRecordingDispatcher();

    const handle = openClarifyModal(
        {
            taskId: 'AP-002',
            dispatcher,
            question: 'Which SDK version should we target?',
        },
        { doc, parent: body },
    );

    const question = findByTestId(asShim(handle.overlay), 'clarify-question');
    assert.ok(question, 'expected the question element to be rendered');
    assert.equal(question.textContent, 'Which SDK version should we target?');
});

test('openClarifyModal pre-focuses the textarea so the operator can type immediately', () => {
    const { doc, body } = makeShimDocument();
    const { dispatcher } = makeRecordingDispatcher();

    const handle = openClarifyModal(
        { taskId: 'AP-003', dispatcher },
        { doc, parent: body },
    );

    assert.equal(
        asShim(handle.textarea).focusCalls,
        1,
        'textarea.focus() must fire exactly once during open()',
    );
});

// ---------------------------------------------------------------------------
// AC #2 — Submit dispatches UpdateTask { taskId, clarification }
// ---------------------------------------------------------------------------

test('handle.submit() dispatches UpdateTask with the clarification text and closes the modal', async () => {
    const { doc, body } = makeShimDocument();
    const { dispatcher, calls } = makeRecordingDispatcher();
    let closeCount = 0;

    const handle = openClarifyModal(
        {
            taskId: 'AP-010',
            dispatcher,
            onClose: () => {
                closeCount += 1;
            },
        },
        { doc, parent: body },
    );

    handle.textarea.value = 'Use the v3 SDK.';

    const ok = await handle.submit();
    assert.equal(ok, true, 'submit() must report success when the dispatch fires');

    assert.equal(calls.length, 1, 'submit must dispatch exactly one command');
    assert.deepEqual(calls[0], {
        type: 'UpdateTask',
        payload: {
            taskId: 'AP-010',
            clarification: 'Use the v3 SDK.',
        },
    });

    // Modal is closed — overlay removed from the parent.
    assert.equal(asShim(handle.overlay).removed, true);
    assert.equal(body.children.length, 0);
    assert.equal(closeCount, 1, 'onClose must fire exactly once on submit');
});

test('handle.submit() trims surrounding whitespace before dispatching', async () => {
    const { doc, body } = makeShimDocument();
    const { dispatcher, calls } = makeRecordingDispatcher();

    const handle = openClarifyModal(
        { taskId: 'AP-011', dispatcher },
        { doc, parent: body },
    );

    handle.textarea.value = '   pin to 4.6   \n';

    const ok = await handle.submit();
    assert.equal(ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].payload.clarification, 'pin to 4.6');
});

test('clicking the Submit button dispatches the same UpdateTask command', async () => {
    const { doc, body } = makeShimDocument();
    const { dispatcher, calls } = makeRecordingDispatcher();

    const handle = openClarifyModal(
        { taskId: 'AP-012', dispatcher },
        { doc, parent: body },
    );

    handle.textarea.value = 'roll back the migration';

    const submitBtn = asShim(handle.submitButton);
    assert.ok(submitBtn.onclick, 'Submit button must have an onclick handler');
    submitBtn.onclick?.();

    // The click handler fires `submit()` as a fire-and-forget; flush the
    // microtask queue so the dispatch + close land before assertions run.
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], {
        type: 'UpdateTask',
        payload: {
            taskId: 'AP-012',
            clarification: 'roll back the migration',
        },
    });
    assert.equal(asShim(handle.overlay).removed, true);
});

test('submit awaits an async dispatcher before closing the modal', async () => {
    const { doc, body } = makeShimDocument();

    let resolveDispatch: () => void = () => undefined;
    const inflight = new Promise<void>((resolve) => {
        resolveDispatch = resolve;
    });
    const calls: ClarifyCommand[] = [];
    const dispatcher: ClarifyDispatcher = {
        dispatch(command: ClarifyCommand): Promise<void> {
            calls.push(command);
            return inflight;
        },
    };

    const handle = openClarifyModal(
        { taskId: 'AP-013', dispatcher },
        { doc, parent: body },
    );
    handle.textarea.value = 'ack';

    const submitted = handle.submit();
    // Microtask drain — dispatch has been called, but its promise is
    // still pending, so the modal must remain open.
    await Promise.resolve();
    assert.equal(calls.length, 1);
    assert.equal(asShim(handle.overlay).removed, false);

    resolveDispatch();
    const ok = await submitted;
    assert.equal(ok, true);
    assert.equal(asShim(handle.overlay).removed, true);
});

// ---------------------------------------------------------------------------
// AC #3 — empty textarea blocks submit
// ---------------------------------------------------------------------------

test('handle.submit() does NOT dispatch when the textarea is empty', async () => {
    const { doc, body } = makeShimDocument();
    const { dispatcher, calls } = makeRecordingDispatcher();
    let closeCount = 0;

    const handle = openClarifyModal(
        {
            taskId: 'AP-020',
            dispatcher,
            onClose: () => {
                closeCount += 1;
            },
        },
        { doc, parent: body },
    );

    // Empty by default.
    const ok = await handle.submit();

    assert.equal(ok, false, 'submit() must report failure when the textarea is empty');
    assert.equal(calls.length, 0, 'no command may be dispatched');
    assert.equal(
        asShim(handle.overlay).removed,
        false,
        'modal must stay open so the operator can complete their answer',
    );
    assert.equal(closeCount, 0, 'onClose must not fire on a blocked submit');

    // The pre-open focus call is 1; a blocked submit re-focuses the
    // textarea, bringing the total to 2.
    assert.equal(asShim(handle.textarea).focusCalls, 2);
});

test('handle.submit() treats whitespace-only input as empty', async () => {
    const { doc, body } = makeShimDocument();
    const { dispatcher, calls } = makeRecordingDispatcher();

    const handle = openClarifyModal(
        { taskId: 'AP-021', dispatcher },
        { doc, parent: body },
    );

    handle.textarea.value = '   \n  \t  ';

    const ok = await handle.submit();
    assert.equal(ok, false);
    assert.equal(calls.length, 0);
    assert.equal(asShim(handle.overlay).removed, false);
});

test('clicking Submit with an empty textarea is a no-op', async () => {
    const { doc, body } = makeShimDocument();
    const { dispatcher, calls } = makeRecordingDispatcher();

    const handle = openClarifyModal(
        { taskId: 'AP-022', dispatcher },
        { doc, parent: body },
    );

    const submitBtn = asShim(handle.submitButton);
    submitBtn.onclick?.();
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(calls.length, 0);
    assert.equal(asShim(handle.overlay).removed, false);
});

// ---------------------------------------------------------------------------
// AC #4 — Cancel closes the modal without dispatching
// ---------------------------------------------------------------------------

test('handle.cancel() closes the modal without dispatching', () => {
    const { doc, body } = makeShimDocument();
    const { dispatcher, calls } = makeRecordingDispatcher();
    let closeCount = 0;

    const handle = openClarifyModal(
        {
            taskId: 'AP-030',
            dispatcher,
            onClose: () => {
                closeCount += 1;
            },
        },
        { doc, parent: body },
    );

    // Even a populated answer must not leak through Cancel.
    handle.textarea.value = 'never mind';

    handle.cancel();

    assert.equal(calls.length, 0, 'cancel must not dispatch');
    assert.equal(asShim(handle.overlay).removed, true);
    assert.equal(body.children.length, 0);
    assert.equal(closeCount, 1, 'onClose must fire exactly once on cancel');
});

test('clicking Cancel closes the modal without dispatching', () => {
    const { doc, body } = makeShimDocument();
    const { dispatcher, calls } = makeRecordingDispatcher();

    const handle = openClarifyModal(
        { taskId: 'AP-031', dispatcher },
        { doc, parent: body },
    );

    handle.textarea.value = 'oops, wrong card';

    const cancelBtn = asShim(handle.cancelButton);
    assert.ok(cancelBtn.onclick, 'Cancel button must have an onclick handler');
    cancelBtn.onclick?.();

    assert.equal(calls.length, 0);
    assert.equal(asShim(handle.overlay).removed, true);
});

test('cancel after submit is an idempotent no-op (no second close, no second onClose)', async () => {
    const { doc, body } = makeShimDocument();
    const { dispatcher, calls } = makeRecordingDispatcher();
    let closeCount = 0;

    const handle = openClarifyModal(
        {
            taskId: 'AP-032',
            dispatcher,
            onClose: () => {
                closeCount += 1;
            },
        },
        { doc, parent: body },
    );

    handle.textarea.value = 'ship it';
    await handle.submit();

    assert.equal(calls.length, 1);
    assert.equal(closeCount, 1);

    // A late Esc / re-entrant cancel must not re-fire onClose or
    // re-touch the (already detached) overlay.
    handle.cancel();
    assert.equal(closeCount, 1, 'onClose must not fire a second time');
});

test('submit after cancel does not dispatch (closed modals are inert)', async () => {
    const { doc, body } = makeShimDocument();
    const { dispatcher, calls } = makeRecordingDispatcher();

    const handle = openClarifyModal(
        { taskId: 'AP-033', dispatcher },
        { doc, parent: body },
    );

    handle.textarea.value = 'late answer';
    handle.cancel();

    const ok = await handle.submit();
    assert.equal(ok, false, 'submit on a closed modal must report failure');
    assert.equal(calls.length, 0, 'closed modals must never dispatch');
});

// ---------------------------------------------------------------------------
// Reviewer feedback — toast queue wired into Submit success / failure paths
// ---------------------------------------------------------------------------

test('Submit success path fires a success toast through the injected port', async () => {
    const { doc, body } = makeShimDocument();
    const { dispatcher, calls: dispatched } = makeRecordingDispatcher();
    const { toast, calls: toasted } = makeRecordingToast();

    const handle = openClarifyModal(
        { taskId: 'AP-040', dispatcher, toast },
        { doc, parent: body },
    );

    handle.textarea.value = 'green light';

    const ok = await handle.submit();
    assert.equal(ok, true);
    assert.equal(dispatched.length, 1, 'dispatch must fire on the success path');
    assert.equal(toasted.length, 1, 'exactly one toast on the success path');
    assert.equal(toasted[0].kind, 'success');
    assert.equal(toasted[0].message, CLARIFY_TOAST_SUCCESS_MESSAGE);
    // Modal closes on success.
    assert.equal(asShim(handle.overlay).removed, true);
});

test('Submit failure path fires an error toast and leaves the modal open for retry', async () => {
    const { doc, body } = makeShimDocument();
    const { toast, calls: toasted } = makeRecordingToast();

    // Capture the dispatched commands so we can prove dispatch was
    // attempted (and not just short-circuited before the error path).
    const dispatched: ClarifyCommand[] = [];
    const failure = new Error('command bus offline');
    const dispatcher: ClarifyDispatcher = {
        dispatch(command: ClarifyCommand): Promise<void> {
            dispatched.push(command);
            return Promise.reject(failure);
        },
    };

    let closeCount = 0;
    const handle = openClarifyModal(
        {
            taskId: 'AP-041',
            dispatcher,
            toast,
            onClose: () => {
                closeCount += 1;
            },
        },
        { doc, parent: body },
    );

    handle.textarea.value = 'retry me';

    const ok = await handle.submit();
    assert.equal(ok, false, 'submit must report failure when dispatch rejects');
    assert.equal(dispatched.length, 1, 'dispatch was attempted before failing');
    assert.equal(toasted.length, 1, 'exactly one toast on the failure path');
    assert.equal(toasted[0].kind, 'error');
    assert.equal(toasted[0].message, CLARIFY_TOAST_ERROR_MESSAGE);

    // Modal stays open so the operator can retry without retyping.
    assert.equal(
        asShim(handle.overlay).removed,
        false,
        'modal must remain mounted after a failed dispatch so retry is possible',
    );
    assert.equal(body.children.length, 1);
    assert.equal(
        closeCount,
        0,
        'onClose must not fire on a failed dispatch — the modal is still open',
    );

    // Textarea is re-focused so the operator can edit + retry immediately.
    // The pre-open focus call is 1; the failure path re-focuses, making 2.
    assert.equal(asShim(handle.textarea).focusCalls, 2);
});

test('Submit failure preserves the textarea value so the operator can retry without retyping', async () => {
    const { doc, body } = makeShimDocument();
    const { toast } = makeRecordingToast();

    let attempts = 0;
    const dispatcher: ClarifyDispatcher = {
        dispatch(): Promise<void> {
            attempts += 1;
            // First attempt fails, second resolves — proves a retry
            // through the same handle is operational.
            return attempts === 1
                ? Promise.reject(new Error('transient'))
                : Promise.resolve();
        },
    };

    const handle = openClarifyModal(
        { taskId: 'AP-042', dispatcher, toast },
        { doc, parent: body },
    );

    handle.textarea.value = 'same answer';

    const first = await handle.submit();
    assert.equal(first, false);
    // Value is left intact for the retry.
    assert.equal(handle.textarea.value, 'same answer');
    assert.equal(asShim(handle.overlay).removed, false);

    const second = await handle.submit();
    assert.equal(second, true);
    assert.equal(asShim(handle.overlay).removed, true);
});

test('Blocked (empty) submit does NOT fire a toast — toasts are reserved for dispatch outcomes', async () => {
    const { doc, body } = makeShimDocument();
    const { dispatcher } = makeRecordingDispatcher();
    const { toast, calls: toasted } = makeRecordingToast();

    const handle = openClarifyModal(
        { taskId: 'AP-043', dispatcher, toast },
        { doc, parent: body },
    );

    // Empty textarea — submit is suppressed before any dispatch happens.
    const ok = await handle.submit();
    assert.equal(ok, false);
    assert.equal(
        toasted.length,
        0,
        'empty-input rejection is a UX guard, not a dispatch result — no toast',
    );
});
