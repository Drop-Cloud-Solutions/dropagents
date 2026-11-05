/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Unit tests for the AP-IFF-016 reject modal.
 *
 * Coverage
 * --------
 * - AC #1: the modal renders a reason textarea + Reject + Cancel
 *   buttons, all reachable via `data-*` hooks the host can latch onto.
 * - AC #2: submit with a non-empty reason dispatches an `UpdateTask`
 *   command carrying `{taskId, status:'rejected', reason}` — matches
 *   the v1 board's commit-reject payload.
 * - AC #3: empty / whitespace-only reasons block the submit, no
 *   command is dispatched, and the textarea is re-focused.
 * - AC #4: cancel never dispatches and runs the supplied `onClose`
 *   hook so the host can tear the overlay down.
 *
 * Dual-runner discovery — same pattern as the chrome modules' specs
 * (`hosts/board-ui/client/chrome/*.spec.ts`). `process.env.VITEST=true`
 * routes through `globalThis.test`; everywhere else the file uses
 * `node:test`.
 */
import * as assert from 'node:assert/strict';

import {
    REJECT_COMMAND_TYPE,
    openRejectModal,
    type RejectModalDocument,
    type RejectModalElement,
    type RejectTaskCommand,
} from '../../../hosts/board-ui/client/modals/reject';

// ---------------------------------------------------------------------------
// Dual-runner test() shim
// ---------------------------------------------------------------------------

type TestFn = (name: string, fn: () => void | Promise<void>) => void;

const test: TestFn = (((): TestFn => {
    if (process.env.VITEST) {
        const gt = (globalThis as { test?: TestFn }).test;
        if (typeof gt !== 'function') {
            throw new Error(
                'reject.spec.ts: VITEST=true but globalThis.test is missing — '
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
// Minimal DOM shim — mirrors the style used by the chrome specs
// ---------------------------------------------------------------------------

interface ShimElement extends RejectModalElement {
    tagName: string;
    attributes: Map<string, string>;
    children: ShimElement[];
    focusCount: number;
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
        attributes: attrs,
        children,
        focusCount: 0,
        setAttribute(name: string, value: string): void {
            attrs.set(name, value);
        },
        appendChild(child: RejectModalElement): RejectModalElement {
            children.push(child as ShimElement);
            return child;
        },
        focus(): void {
            el.focusCount += 1;
        },
    };
    return el;
}

function makeShimDocument(): RejectModalDocument {
    return {
        createElement(tagName: string): RejectModalElement {
            return makeShimElement(tagName);
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

function requireFirst(
    root: ShimElement,
    predicate: (el: ShimElement) => boolean,
    label: string,
): ShimElement {
    const hit = findFirst(root, predicate);
    if (!hit) throw new Error(`reject.spec.ts: no element matched ${label}`);
    return hit;
}

// ---------------------------------------------------------------------------
// AC #1 — form renders with reason textarea + Reject + Cancel buttons
// ---------------------------------------------------------------------------

test('openRejectModal renders a textarea plus Reject and Cancel buttons', () => {
    const dispatched: RejectTaskCommand[] = [];
    const handle = openRejectModal({
        taskId: 'AP-IFF-016',
        doc: makeShimDocument(),
        dispatch: (cmd) => {
            dispatched.push(cmd);
        },
    });

    const root = handle.root as ShimElement;
    assert.equal(root.attributes.get('role'), 'dialog');
    assert.equal(root.attributes.get('aria-modal'), 'true');
    assert.equal(root.attributes.get('data-task-id'), 'AP-IFF-016');

    const textarea = requireFirst(
        root,
        (el) => el.tagName === 'textarea' && el.attributes.has('data-reject-reason'),
        '<textarea data-reject-reason>',
    );
    assert.equal(textarea, handle.reasonInput);

    const reject = requireFirst(
        root,
        (el) => el.tagName === 'button' && el.attributes.has('data-reject-submit'),
        '<button data-reject-submit>',
    );
    assert.equal(reject.textContent, 'Reject');
    assert.equal(reject, handle.submitButton);

    const cancel = requireFirst(
        root,
        (el) => el.tagName === 'button' && el.attributes.has('data-reject-cancel'),
        '<button data-reject-cancel>',
    );
    assert.equal(cancel.textContent, 'Cancel');
    assert.equal(cancel, handle.cancelButton);

    // No dispatch happens just from rendering.
    assert.deepEqual(dispatched, []);
});

// ---------------------------------------------------------------------------
// AC #2 — submit dispatches the engine's fail command with the reason
// ---------------------------------------------------------------------------

test('submit dispatches task.fail with the reason', async () => {
    const dispatched: RejectTaskCommand[] = [];
    let closed = 0;
    const handle = openRejectModal({
        taskId: 'task-42',
        doc: makeShimDocument(),
        dispatch: (cmd) => {
            dispatched.push(cmd);
        },
        onClose: () => {
            closed += 1;
        },
    });

    handle.reasonInput.value = 'please add the missing null-check';
    const result = await handle.submit();

    assert.ok(result, 'submit must return the dispatched command on success');
    assert.equal(result!.type, REJECT_COMMAND_TYPE);
    // NOT UpdateTask: its payload accepts neither a status nor a
    // reason, so a reject dispatched through it changed nothing —
    // no failed status, no Retry, no stored reason.
    assert.equal(result!.type, 'task.fail');
    assert.deepEqual(result!.payload, {
        taskId: 'task-42',
        reason: 'please add the missing null-check',
    });

    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0], result);
    assert.equal(closed, 1, 'onClose runs after a successful submit');
});

test('clicking the Reject button triggers the same dispatch path as submit()', async () => {
    const dispatched: RejectTaskCommand[] = [];
    const handle = openRejectModal({
        taskId: 'task-click',
        doc: makeShimDocument(),
        dispatch: async (cmd) => {
            dispatched.push(cmd);
        },
    });

    handle.reasonInput.value = 'click flow';
    const onclick = (handle.submitButton as ShimElement).onclick;
    assert.equal(typeof onclick, 'function');
    onclick!();

    // Click handler is sync; the async dispatch microtask runs on next tick.
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].payload.reason, 'click flow');
    assert.equal(dispatched[0].payload.taskId, 'task-click');
    // `task.fail`, not `UpdateTask`: UpdateTask accepts neither a status
    // nor a reason and dropped both, so a reject changed nothing at all.
    assert.equal(dispatched[0].type, 'task.fail');
});

test('submit trims surrounding whitespace from the reason before dispatching', async () => {
    const dispatched: RejectTaskCommand[] = [];
    const handle = openRejectModal({
        taskId: 'task-trim',
        doc: makeShimDocument(),
        dispatch: (cmd) => {
            dispatched.push(cmd);
        },
    });
    handle.reasonInput.value = '   needs more tests   ';
    const result = await handle.submit();
    assert.ok(result);
    assert.equal(result!.payload.reason, 'needs more tests');
    assert.equal(dispatched[0].payload.reason, 'needs more tests');
});

// ---------------------------------------------------------------------------
// AC #3 — empty reason blocks submit
// ---------------------------------------------------------------------------

test('submit with an empty reason does NOT dispatch and re-focuses the textarea', async () => {
    const dispatched: RejectTaskCommand[] = [];
    let closed = 0;
    const handle = openRejectModal({
        taskId: 'task-empty',
        doc: makeShimDocument(),
        dispatch: (cmd) => {
            dispatched.push(cmd);
        },
        onClose: () => {
            closed += 1;
        },
    });

    handle.reasonInput.value = '';
    const result = await handle.submit();

    assert.equal(result, null, 'submit returns null when the reason is blank');
    assert.deepEqual(dispatched, []);
    assert.equal(closed, 0, 'onClose must not fire on a blocked submit');
    assert.equal(
        (handle.reasonInput as ShimElement).focusCount,
        1,
        'textarea must be re-focused so the operator sees where to type',
    );
});

test('submit with whitespace-only reason is treated as empty', async () => {
    const dispatched: RejectTaskCommand[] = [];
    const handle = openRejectModal({
        taskId: 'task-ws',
        doc: makeShimDocument(),
        dispatch: (cmd) => {
            dispatched.push(cmd);
        },
    });

    handle.reasonInput.value = '   \n\t  ';
    const result = await handle.submit();

    assert.equal(result, null);
    assert.deepEqual(dispatched, []);
    assert.equal((handle.reasonInput as ShimElement).focusCount, 1);
});

// ---------------------------------------------------------------------------
// AC #4 — cancel never dispatches, runs onClose
// ---------------------------------------------------------------------------

test('cancel() never dispatches and invokes onClose', () => {
    const dispatched: RejectTaskCommand[] = [];
    let closed = 0;
    const handle = openRejectModal({
        taskId: 'task-cancel',
        doc: makeShimDocument(),
        dispatch: (cmd) => {
            dispatched.push(cmd);
        },
        onClose: () => {
            closed += 1;
        },
    });

    handle.reasonInput.value = 'would have been a reason';
    handle.cancel();

    assert.deepEqual(dispatched, [], 'cancel must not dispatch a command');
    assert.equal(closed, 1, 'cancel must invoke onClose');
});

test('clicking the Cancel button routes through cancel()', () => {
    const dispatched: RejectTaskCommand[] = [];
    let closed = 0;
    const handle = openRejectModal({
        taskId: 'task-cancel-click',
        doc: makeShimDocument(),
        dispatch: (cmd) => {
            dispatched.push(cmd);
        },
        onClose: () => {
            closed += 1;
        },
    });

    const onclick = (handle.cancelButton as ShimElement).onclick;
    assert.equal(typeof onclick, 'function');
    onclick!();

    assert.deepEqual(dispatched, []);
    assert.equal(closed, 1);
});

// ---------------------------------------------------------------------------
// Idempotency — repeated close attempts only fire onClose once
// ---------------------------------------------------------------------------

test('cancel after submit is a no-op (onClose fires exactly once)', async () => {
    const dispatched: RejectTaskCommand[] = [];
    let closed = 0;
    const handle = openRejectModal({
        taskId: 'task-idem',
        doc: makeShimDocument(),
        dispatch: (cmd) => {
            dispatched.push(cmd);
        },
        onClose: () => {
            closed += 1;
        },
    });

    handle.reasonInput.value = 'fine';
    await handle.submit();
    handle.cancel();
    handle.cancel();

    assert.equal(dispatched.length, 1);
    assert.equal(closed, 1, 'onClose must run exactly once across submit + cancel');
});

test('submit after cancel does not dispatch', async () => {
    const dispatched: RejectTaskCommand[] = [];
    const handle = openRejectModal({
        taskId: 'task-after-cancel',
        doc: makeShimDocument(),
        dispatch: (cmd) => {
            dispatched.push(cmd);
        },
    });

    handle.cancel();
    handle.reasonInput.value = 'too late';
    const result = await handle.submit();

    assert.equal(result, null);
    assert.deepEqual(dispatched, []);
});
