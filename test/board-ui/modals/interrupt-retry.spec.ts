/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Unit tests for the AP-IFF-014 interrupt-retry modal.
 *
 * Coverage maps to the acceptance criteria from TASK.md:
 *   AC #1 — step 1 dispatches `InterruptTask` on confirm.
 *   AC #2 — step 2 dispatches `UpdateTask` with the operator's feedback
 *           on Retry.
 *   AC #3 — cancelling at either step closes the modal without dispatching
 *           anything further.
 *   AC #4 — every dispatch outcome (success or failure) is surfaced via
 *           the toast port.
 *   AC #5 — this file is the unit-test artefact.
 *
 * DOM strategy — hand-rolled shim.
 * --------------------------------
 * Matches the convention established by `hosts/board-ui/client/chrome/*.spec.ts`:
 * jsdom is not in the dependency graph, and the modal's structural DOM
 * surface is tiny enough that a 50-line shim is cheaper than dragging in
 * jsdom. The shim only models the methods the modal actually consumes.
 *
 * Dual-runner registration — same pattern as the chrome specs so this
 * file runs under both `node --test --import tsx` (the repo default) and
 * vitest (the review pipeline's `npx vitest run`).
 */
import * as assert from 'node:assert/strict';

import { BoardUiCommands } from '../../../hosts/board-ui/commands';
import {
    DEFAULT_MOUNT_ID,
    openInterruptRetryModal,
    type InterruptRetryHandle,
    type ModalDocument,
    type ModalElement,
    type OverlayManagerLike,
    type ShowToastOpts,
} from '../../../hosts/board-ui/client/modals/interrupt-retry';

import type { Command } from '../../../core/commands/command';

// ---------------------------------------------------------------------------
// Dual-runner test() shim
// ---------------------------------------------------------------------------

type TestFn = (name: string, fn: () => void | Promise<void>) => void;

const test: TestFn = (((): TestFn => {
    if (process.env.VITEST) {
        const gt = (globalThis as { test?: TestFn }).test;
        if (typeof gt !== 'function') {
            throw new Error(
                'interrupt-retry.spec.ts: VITEST=true but globalThis.test is missing — '
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
// Minimal DOM shim — only the surface the modal touches.
// ---------------------------------------------------------------------------

interface ShimElement extends ModalElement {
    readonly tagName: string;
    readonly children: ShimElement[];
    readonly attributes: Map<string, string>;
    parent: ShimElement | null;
    removed: boolean;
    onclick?: () => void;
    oninput?: (value: string) => void;
}

function makeShimElement(tagName: string): ShimElement {
    const attrs = new Map<string, string>();
    const children: ShimElement[] = [];
    const el: ShimElement = {
        tagName,
        className: '',
        textContent: null,
        hidden: false,
        children,
        attributes: attrs,
        parent: null,
        removed: false,
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
            for (const c of children) c.parent = null;
            children.length = 0;
            for (const n of next) {
                const c = n as ShimElement;
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
    };
    return el;
}

interface ShimDocument {
    doc: ModalDocument;
    mount: ShimElement;
}

function makeShimDocument(mountId: string = DEFAULT_MOUNT_ID): ShimDocument {
    const mount = makeShimElement('div');
    mount.setAttribute('id', mountId);
    const doc: ModalDocument = {
        getElementById(id: string): ModalElement | null {
            return id === mountId ? mount : null;
        },
        createElement(tagName: string): ModalElement {
            return makeShimElement(tagName);
        },
    };
    return { doc, mount };
}

// ---------------------------------------------------------------------------
// Overlay / toast / dispatch recorders
// ---------------------------------------------------------------------------

interface OverlayCall {
    readonly kind: 'open' | 'close';
    readonly id: string;
    readonly element?: ModalElement;
}

function makeOverlayRecorder(): {
    overlay: OverlayManagerLike;
    calls: OverlayCall[];
    isOpen(id: string): boolean;
} {
    const calls: OverlayCall[] = [];
    const open = new Set<string>();
    const overlay: OverlayManagerLike = {
        openOverlay(id: string, element: ModalElement): unknown {
            calls.push({ kind: 'open', id, element });
            open.add(id);
            return { id, element };
        },
        closeOverlay(id: string): void {
            calls.push({ kind: 'close', id });
            open.delete(id);
        },
    };
    return {
        overlay,
        calls,
        isOpen: (id: string): boolean => open.has(id),
    };
}

function makeToastRecorder(): {
    toast: (opts: ShowToastOpts) => void;
    toasts: ShowToastOpts[];
} {
    const toasts: ShowToastOpts[] = [];
    return {
        toasts,
        toast: (opts: ShowToastOpts): void => {
            toasts.push(opts);
        },
    };
}

interface DispatchSpy {
    dispatch: (cmd: Command<unknown>) => Promise<unknown>;
    calls: Command<unknown>[];
    /** Override the response for the NEXT call (FIFO). */
    queue(result: { ok: true } | { ok: false; err: Error }): void;
}

function makeDispatchSpy(): DispatchSpy {
    const calls: Command<unknown>[] = [];
    const queued: Array<{ ok: true } | { ok: false; err: Error }> = [];
    return {
        calls,
        queue(result): void {
            queued.push(result);
        },
        dispatch: (cmd): Promise<unknown> => {
            calls.push(cmd);
            const next = queued.shift() ?? { ok: true };
            if (next.ok) return Promise.resolve();
            return Promise.reject(next.err);
        },
    };
}

// Tiny convenience finder so a test can reach for the cancel/confirm
// button without depending on render order.
function findButton(el: ShimElement, action: string): ShimElement {
    const stack: ShimElement[] = [el];
    while (stack.length) {
        const cur = stack.pop()!;
        if (cur.attributes.get('data-action') === action) return cur;
        for (const c of cur.children) stack.push(c);
    }
    throw new Error(`button data-action="${action}" not found`);
}

function findTextarea(el: ShimElement): ShimElement {
    const stack: ShimElement[] = [el];
    while (stack.length) {
        const cur = stack.pop()!;
        if (cur.attributes.get('data-field') === 'feedback') return cur;
        for (const c of cur.children) stack.push(c);
    }
    throw new Error('feedback textarea not found');
}

interface TestKit {
    handle: InterruptRetryHandle;
    mount: ShimElement;
    overlayCalls: OverlayCall[];
    isOpen: (id: string) => boolean;
    toasts: ShowToastOpts[];
    dispatchCalls: Command<unknown>[];
    dispatchSpy: DispatchSpy;
}

function mountModal(opts: { taskId?: string } = {}): TestKit {
    const taskId = opts.taskId ?? 'task-42';
    const { doc, mount } = makeShimDocument();
    const overlayRec = makeOverlayRecorder();
    const toastRec = makeToastRecorder();
    const dispatchSpy = makeDispatchSpy();
    const handle = openInterruptRetryModal(
        { taskId },
        {
            doc,
            overlay: overlayRec.overlay,
            toast: toastRec.toast,
            dispatch: dispatchSpy.dispatch,
            actor: 'op-1',
            clock: (): number => 1_700_000_000_000,
        },
    );
    return {
        handle,
        mount,
        overlayCalls: overlayRec.calls,
        isOpen: overlayRec.isOpen,
        toasts: toastRec.toasts,
        dispatchCalls: dispatchSpy.calls,
        dispatchSpy,
    };
}

// ---------------------------------------------------------------------------
// Mount-time invariants
// ---------------------------------------------------------------------------

test('openInterruptRetryModal mounts on step 1 with the interrupt confirm UI', () => {
    const kit = mountModal();
    const root = kit.handle.element as ShimElement;

    assert.equal(kit.handle.step, 'interrupt');
    assert.equal(root.attributes.get('data-step'), 'interrupt');
    assert.equal(root.attributes.get('role'), 'dialog');
    assert.equal(root.attributes.get('aria-modal'), 'true');
    assert.equal(root.attributes.get('data-task-id'), 'task-42');
    assert.equal(
        kit.mount.children[0],
        root,
        'modal element must be appended to #overlay-root',
    );

    // The interrupt-confirm button must be present at step 1 and the
    // retry button must NOT yet exist.
    findButton(root, 'confirm-interrupt');
    findButton(root, 'cancel');
    assert.throws(() => findButton(root, 'confirm-retry'));
});

test('openInterruptRetryModal registers an overlay on mount', () => {
    const kit = mountModal({ taskId: 'task-X' });
    assert.equal(kit.overlayCalls.length, 1);
    assert.equal(kit.overlayCalls[0].kind, 'open');
    assert.equal(kit.overlayCalls[0].id, 'interrupt-retry:task-X');
    assert.equal(kit.overlayCalls[0].element, kit.handle.element);
    assert.equal(kit.isOpen('interrupt-retry:task-X'), true);
});

// ---------------------------------------------------------------------------
// AC #1 — Step 1 dispatches InterruptTask on confirm
// ---------------------------------------------------------------------------

test('AC #1: step 1 confirm dispatches InterruptTask with the task id and actor', async () => {
    const kit = mountModal({ taskId: 'task-42' });

    await kit.handle.confirm();

    assert.equal(kit.dispatchCalls.length, 1);
    const cmd = kit.dispatchCalls[0];
    assert.equal(cmd.type, BoardUiCommands.INTERRUPT_TASK);
    assert.equal(cmd.actor, 'op-1');
    assert.equal(cmd.issuedAt, 1_700_000_000_000);
    assert.deepEqual(cmd.payload, { taskId: 'task-42' });
});

test('AC #1: a successful InterruptTask advances the modal to step 2 and shows a success toast', async () => {
    const kit = mountModal();
    await kit.handle.confirm();

    assert.equal(kit.handle.step, 'retry');
    const root = kit.handle.element as ShimElement;
    assert.equal(root.attributes.get('data-step'), 'retry');

    // Step-2 controls must now be present.
    findButton(root, 'confirm-retry');
    findTextarea(root);
    assert.throws(() => findButton(root, 'confirm-interrupt'));

    assert.equal(kit.toasts.length, 1);
    assert.equal(kit.toasts[0].kind, 'success');
});

test('AC #4: a failing InterruptTask surfaces an error toast and the modal stays on step 1', async () => {
    const kit = mountModal();
    kit.dispatchSpy.queue({ ok: false, err: new Error('worker offline') });

    await kit.handle.confirm();

    assert.equal(kit.handle.step, 'interrupt');
    const root = kit.handle.element as ShimElement;
    assert.equal(root.attributes.get('data-step'), 'interrupt');
    findButton(root, 'confirm-interrupt');

    assert.equal(kit.toasts.length, 1);
    assert.equal(kit.toasts[0].kind, 'error');
    assert.match(kit.toasts[0].message, /worker offline/);
});

// ---------------------------------------------------------------------------
// AC #2 — Step 2 dispatches UpdateTask with feedback on Retry
// ---------------------------------------------------------------------------

test('AC #2: step 2 retry dispatches UpdateTask carrying the operator\'s feedback', async () => {
    const kit = mountModal({ taskId: 'task-42' });

    // Walk through step 1 so we get into step 2.
    await kit.handle.confirm();
    assert.equal(kit.handle.step, 'retry');

    // Simulate operator typing into the textarea (via the wired oninput).
    const textarea = findTextarea(kit.handle.element as ShimElement);
    assert.ok(typeof textarea.oninput === 'function', 'textarea must expose an input handler');
    textarea.oninput!('please be more careful about the env-var order');
    assert.equal(kit.handle.feedback, 'please be more careful about the env-var order');

    await kit.handle.confirm();

    // Two dispatches total: interrupt + update.
    assert.equal(kit.dispatchCalls.length, 2);
    const update = kit.dispatchCalls[1];
    assert.equal(update.type, BoardUiCommands.EDIT_TASK);
    assert.equal(update.actor, 'op-1');
    assert.deepEqual(update.payload, {
        taskId: 'task-42',
        description: 'please be more careful about the env-var order',
    });
});

test('AC #2: a successful UpdateTask closes the modal and shows a success toast', async () => {
    const kit = mountModal({ taskId: 'task-42' });
    await kit.handle.confirm();
    kit.handle.setFeedback('try again');
    await kit.handle.confirm();

    assert.equal(kit.handle.step, 'closed');
    const root = kit.handle.element as ShimElement;
    assert.equal(root.removed, true, 'modal element must be detached on success');
    assert.equal(kit.isOpen('interrupt-retry:task-42'), false, 'overlay must be closed on success');

    // Toasts: one success per dispatch.
    assert.equal(kit.toasts.length, 2);
    assert.equal(kit.toasts[0].kind, 'success');
    assert.equal(kit.toasts[1].kind, 'success');
});

test('AC #4: a failing UpdateTask surfaces an error toast and keeps the modal on step 2', async () => {
    const kit = mountModal();
    await kit.handle.confirm(); // step 1 success
    kit.dispatchSpy.queue({ ok: false, err: new Error('db locked') });

    kit.handle.setFeedback('retry please');
    await kit.handle.confirm();

    assert.equal(kit.handle.step, 'retry', 'modal must stay on step 2 after a retry failure');
    const root = kit.handle.element as ShimElement;
    assert.equal(root.removed, false);
    assert.equal(root.attributes.get('data-step'), 'retry');

    // Two toasts total: success for the interrupt, error for the retry.
    assert.equal(kit.toasts.length, 2);
    assert.equal(kit.toasts[0].kind, 'success');
    assert.equal(kit.toasts[1].kind, 'error');
    assert.match(kit.toasts[1].message, /db locked/);
});

// ---------------------------------------------------------------------------
// AC #3 — Cancel closes without dispatching
// ---------------------------------------------------------------------------

test('AC #3: cancel at step 1 closes the modal without dispatching and without any toast', () => {
    const kit = mountModal({ taskId: 'task-42' });

    kit.handle.cancel();

    assert.equal(kit.handle.step, 'closed');
    assert.equal(kit.dispatchCalls.length, 0, 'cancel must NOT dispatch any command');
    assert.equal(kit.toasts.length, 0, 'cancel is silent — no toast');
    assert.equal((kit.handle.element as ShimElement).removed, true);
    assert.equal(kit.isOpen('interrupt-retry:task-42'), false);
});

test('AC #3: cancel from step 2 closes the modal without dispatching UpdateTask', async () => {
    const kit = mountModal({ taskId: 'task-42' });

    // Get to step 2.
    await kit.handle.confirm();
    assert.equal(kit.handle.step, 'retry');
    assert.equal(kit.dispatchCalls.length, 1, 'only the interrupt dispatched so far');

    kit.handle.cancel();

    assert.equal(kit.handle.step, 'closed');
    assert.equal(
        kit.dispatchCalls.length,
        1,
        'cancel from step 2 must NOT issue an UpdateTask — the interrupt has already happened',
    );
    assert.equal((kit.handle.element as ShimElement).removed, true);
    assert.equal(kit.isOpen('interrupt-retry:task-42'), false);
});

test('AC #3: cancel is idempotent — calling it twice is a no-op the second time', () => {
    const kit = mountModal();
    kit.handle.cancel();
    const closesBefore = kit.overlayCalls.filter((c) => c.kind === 'close').length;
    kit.handle.cancel();
    const closesAfter = kit.overlayCalls.filter((c) => c.kind === 'close').length;
    assert.equal(closesAfter, closesBefore, 'second cancel must not re-close the overlay');
});

// ---------------------------------------------------------------------------
// Wiring sanity — buttons drive the same code paths the tests exercise.
// ---------------------------------------------------------------------------

test('clicking the cancel button drives handle.cancel()', () => {
    const kit = mountModal();
    const cancelBtn = findButton(kit.handle.element as ShimElement, 'cancel');
    assert.ok(typeof cancelBtn.onclick === 'function', 'cancel button must wire an onclick handler');
    cancelBtn.onclick!();
    assert.equal(kit.handle.step, 'closed');
    assert.equal(kit.dispatchCalls.length, 0);
});

test('clicking the interrupt confirm button triggers an InterruptTask dispatch', async () => {
    const kit = mountModal();
    const confirmBtn = findButton(kit.handle.element as ShimElement, 'confirm-interrupt');
    assert.ok(typeof confirmBtn.onclick === 'function');
    confirmBtn.onclick!();
    // Let the queued microtask flush so the dispatch resolves.
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(kit.dispatchCalls.length, 1);
    assert.equal(kit.dispatchCalls[0].type, BoardUiCommands.INTERRUPT_TASK);
});

// ---------------------------------------------------------------------------
// Double-click guard — concurrent confirms collapse to a single dispatch.
// ---------------------------------------------------------------------------

test('confirm is re-entrancy-safe — two overlapping calls produce one dispatch', async () => {
    // The dispatch is async; without an in-flight guard a fast double click
    // would issue InterruptTask twice. The handler must collapse them.
    const kit = mountModal();
    const a = kit.handle.confirm();
    const b = kit.handle.confirm();
    await Promise.all([a, b]);
    assert.equal(kit.dispatchCalls.length, 1, 'concurrent confirms must collapse to a single dispatch');
});
