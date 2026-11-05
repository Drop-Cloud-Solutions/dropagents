/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Unit tests for the AP-IFB-007 review-report modal.
 *
 * Coverage targets the task's five acceptance criteria:
 *   AC #1 open() mounts under #overlay-root and registers with the
 *         overlay-manager via openOverlay('review-report', el).
 *   AC #2 rr-ready renders the report content passed in on open inside
 *         the <pre data-report-content> slot.
 *   AC #3 Close, Dismiss, Implement buttons are present in rr-ready.
 *   AC #4 Dismiss and Implement dispatch through the command-sink
 *         (dismissReport / implementReport) with {taskId, reportId} and
 *         transition rr-ready → rr-submitting → rr-done.
 *   AC #5 the `#review-report-modal-template` is registered in
 *         hosts/board-ui/index.html with the three V1 action buttons.
 *
 * Dual-runner discovery — same pattern as new-project.spec.ts: vitest
 * when VITEST=true, node:test otherwise.
 *
 * DOM strategy — hand-rolled shim. The existing modal specs
 * (new-plan.spec.ts, new-project.spec.ts, notes.spec.ts) all roll their
 * own shim rather than pulling in jsdom; this file follows the same
 * shape so a reviewer can diff it side-by-side.
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    REVIEW_REPORT_OVERLAY_ID,
    REVIEW_REPORT_TEMPLATE_ID,
    createReviewReportModal,
    type DismissReportInput,
    type ImplementReportInput,
    type ModalDocument,
    type ModalElement,
    type OverlayManagerLike,
    type ReviewReportCommandSink,
    type ReviewReportModalHandle,
    type ShowToastFn,
    type ToastInput,
} from '../../../hosts/board-ui/client/modals/review-report';

// ---------------------------------------------------------------------------
// Dual-runner test() shim
// ---------------------------------------------------------------------------

type TestFn = (name: string, fn: () => void | Promise<void>) => void;

const test: TestFn = (((): TestFn => {
    if (process.env.VITEST) {
        const gt = (globalThis as { test?: TestFn }).test;
        if (typeof gt !== 'function') {
            throw new Error(
                'review-report.spec.ts: VITEST=true but globalThis.test is missing — '
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
// Minimal DOM shim — same shape as new-project.spec.ts
// ---------------------------------------------------------------------------

interface ShimElement extends ModalElement {
    readonly tagName: string;
    readonly children: ShimElement[];
    readonly attributes: Map<string, string>;
    parent: ShimElement | null;
    removed: boolean;
    onclick?: () => void;
}

function makeShimElement(tagName: string): ShimElement {
    const attrs = new Map<string, string>();
    const children: ShimElement[] = [];
    const el: ShimElement = {
        tagName,
        className: '',
        textContent: null,
        value: undefined,
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
            children.length = 0;
            for (const c of next) {
                (c as ShimElement).parent = el;
                children.push(c as ShimElement);
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
    overlayRoot: ShimElement;
}

const OVERLAY_ROOT_ID_LITERAL = 'overlay-root';

function makeShimDocument(): ShimDocument {
    const overlayRoot = makeShimElement('div');
    const doc: ModalDocument = {
        getElementById(id: string): ModalElement | null {
            return id === OVERLAY_ROOT_ID_LITERAL ? overlayRoot : null;
        },
        createElement(tagName: string): ModalElement {
            return makeShimElement(tagName);
        },
    };
    return { doc, overlayRoot };
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

function bodyForState(root: ShimElement, state: string): ShimElement {
    const el = findFirst(root, (n) => n.attributes.get('data-state-body') === state);
    if (!el) throw new Error(`no body rendered for state "${state}"`);
    return el;
}

function buttonForAction(root: ShimElement, action: string): ShimElement {
    const el = findFirst(root, (n) => n.attributes.get('data-action') === action);
    if (!el) throw new Error(`no button rendered for action "${action}"`);
    return el;
}

function panelEl(overlayRoot: ShimElement): ShimElement {
    if (overlayRoot.children.length === 0) {
        throw new Error('expected a panel under overlay-root, found none');
    }
    return overlayRoot.children[0];
}

// ---------------------------------------------------------------------------
// Fake ports
// ---------------------------------------------------------------------------

interface FakeOverlayManager extends OverlayManagerLike {
    readonly opened: Array<{ id: string; element: unknown }>;
    readonly closed: string[];
}

function makeOverlayManager(): FakeOverlayManager {
    const opened: Array<{ id: string; element: unknown }> = [];
    const closed: string[] = [];
    return {
        opened,
        closed,
        openOverlay(id, element): unknown {
            opened.push({ id, element });
            return { id, element, previouslyFocused: null };
        },
        closeOverlay(id): void {
            closed.push(id);
        },
    };
}

interface FakeToast {
    readonly fn: ShowToastFn;
    readonly calls: ToastInput[];
}

function makeToast(): FakeToast {
    const calls: ToastInput[] = [];
    return {
        calls,
        fn: (input): void => {
            calls.push(input);
        },
    };
}

interface FakeCommands extends ReviewReportCommandSink {
    readonly dismissCalls: DismissReportInput[];
    readonly implementCalls: ImplementReportInput[];
    dismissShouldReject: Error | null;
    implementShouldReject: Error | null;
    /** When set, the matching call awaits this promise before resolving. */
    dismissBlocker: Promise<void> | null;
    implementBlocker: Promise<void> | null;
}

function makeCommands(): FakeCommands {
    const sink: FakeCommands = {
        dismissCalls: [],
        implementCalls: [],
        dismissShouldReject: null,
        implementShouldReject: null,
        dismissBlocker: null,
        implementBlocker: null,
        async dismissReport(input): Promise<void> {
            sink.dismissCalls.push({ ...input });
            if (sink.dismissBlocker) await sink.dismissBlocker;
            if (sink.dismissShouldReject) throw sink.dismissShouldReject;
        },
        async implementReport(input): Promise<void> {
            sink.implementCalls.push({ ...input });
            if (sink.implementBlocker) await sink.implementBlocker;
            if (sink.implementShouldReject) throw sink.implementShouldReject;
        },
    };
    return sink;
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Harness {
    readonly modal: ReviewReportModalHandle;
    readonly shim: ShimDocument;
    readonly overlay: FakeOverlayManager;
    readonly toast: FakeToast;
    readonly commands: FakeCommands;
}

function setup(overrides?: { mountRoot?: ModalElement }): Harness {
    const shim = makeShimDocument();
    const overlay = makeOverlayManager();
    const toast = makeToast();
    const commands = makeCommands();
    const modal = createReviewReportModal({
        doc: shim.doc,
        mountRoot: overrides?.mountRoot,
        overlayManager: overlay,
        showToast: toast.fn,
        commands,
    });
    return { modal, shim, overlay, toast, commands };
}

function openWith(
    h: Harness,
    overrides: Partial<{
        taskId: string;
        reportId: string;
        content: string;
        title: string;
    }> = {},
): void {
    h.modal.open({
        taskId: overrides.taskId ?? 'task-1',
        reportId: overrides.reportId ?? 'report-1',
        content: overrides.content ?? 'reviewer noted: file X needs Y',
        title: overrides.title,
    });
}

// ---------------------------------------------------------------------------
// AC #1 — open() mounts under #overlay-root and registers with manager
// ---------------------------------------------------------------------------

test('open() mounts a panel under #overlay-root and registers it with the overlay manager', () => {
    const h = setup();
    openWith(h);

    assert.equal(h.shim.overlayRoot.children.length, 1);
    const panel = panelEl(h.shim.overlayRoot);
    assert.equal(panel.attributes.get('data-review-report-modal'), '');
    assert.equal(panel.attributes.get('role'), 'dialog');
    assert.equal(panel.attributes.get('aria-modal'), 'true');
    assert.equal(panel.attributes.get('aria-labelledby'), 'review-report-title');

    assert.equal(h.overlay.opened.length, 1);
    assert.equal(h.overlay.opened[0].id, REVIEW_REPORT_OVERLAY_ID);
    assert.equal(h.overlay.opened[0].element, panel);

    const state = h.modal.getState();
    assert.ok(state && state.kind === 'rr-ready');
    assert.equal(panel.attributes.get('data-state'), 'rr-ready');
});

test('open() prefers an explicit mountRoot over the default #overlay-root', () => {
    const customRoot = makeShimElement('div');
    const h = setup({ mountRoot: customRoot });
    openWith(h);
    assert.equal(customRoot.children.length, 1);
    assert.equal(h.shim.overlayRoot.children.length, 0);
});

test('open() rejects empty taskId / reportId', () => {
    const h = setup();
    assert.throws(
        () => h.modal.open({ taskId: '', reportId: 'r', content: 'x' }),
        /non-empty taskId/,
    );
    assert.throws(
        () => h.modal.open({ taskId: 't', reportId: '', content: 'x' }),
        /non-empty reportId/,
    );
});

test('close() detaches the panel, calls overlay-manager.closeOverlay, and clears state', () => {
    const h = setup();
    openWith(h);
    h.modal.close();
    assert.equal(h.shim.overlayRoot.children.length, 0);
    assert.deepEqual(h.overlay.closed, [REVIEW_REPORT_OVERLAY_ID]);
    assert.equal(h.modal.getState(), null);
});

test('re-opening tears down the previous panel before mounting a fresh one', () => {
    const h = setup();
    openWith(h, { taskId: 't1', reportId: 'r1' });
    openWith(h, { taskId: 't2', reportId: 'r2' });
    // One closeOverlay from the implicit close + one panel currently mounted.
    assert.equal(h.shim.overlayRoot.children.length, 1);
    assert.deepEqual(h.overlay.closed, [REVIEW_REPORT_OVERLAY_ID]);
    assert.equal(h.overlay.opened.length, 2);
    const state = h.modal.getState();
    assert.ok(state && state.kind === 'rr-ready');
    if (state && state.kind === 'rr-ready') {
        assert.equal(state.taskId, 't2');
        assert.equal(state.reportId, 'r2');
    }
});

// ---------------------------------------------------------------------------
// AC #2 — rr-ready renders the report content
// ---------------------------------------------------------------------------

test('rr-ready renders the report content inside the data-report-content slot', () => {
    const h = setup();
    openWith(h, { content: 'reviewer says: rename foo → bar' });
    const panel = panelEl(h.shim.overlayRoot);
    const body = bodyForState(panel, 'rr-ready');

    assert.equal(body.attributes.get('data-task-id'), 'task-1');
    assert.equal(body.attributes.get('data-report-id'), 'report-1');

    const content = findFirst(body, (n) => n.attributes.has('data-report-content'));
    assert.ok(content, 'missing data-report-content slot');
    assert.equal(content!.tagName, 'pre');
    assert.equal(content!.textContent, 'reviewer says: rename foo → bar');
});

test('rr-ready renders a custom title when one is supplied', () => {
    const h = setup();
    openWith(h, { title: 'Azure review report' });
    const panel = panelEl(h.shim.overlayRoot);
    const heading = findFirst(panel, (n) => n.attributes.get('id') === 'review-report-title');
    assert.ok(heading);
    assert.equal(heading!.textContent, 'Azure review report');
});

test('rr-ready defaults the title to "Review report" when none supplied', () => {
    const h = setup();
    openWith(h);
    const panel = panelEl(h.shim.overlayRoot);
    const heading = findFirst(panel, (n) => n.attributes.get('id') === 'review-report-title');
    assert.equal(heading?.textContent, 'Review report');
});

// ---------------------------------------------------------------------------
// AC #3 — Close, Dismiss, Implement buttons are present in rr-ready
// ---------------------------------------------------------------------------

test('rr-ready renders Close, Dismiss, and Implement buttons', () => {
    const h = setup();
    openWith(h);
    const panel = panelEl(h.shim.overlayRoot);
    const close = buttonForAction(panel, 'close');
    const dismiss = buttonForAction(panel, 'dismiss');
    const implement = buttonForAction(panel, 'implement');
    assert.equal(close.textContent, 'Close');
    assert.equal(dismiss.textContent, 'Dismiss');
    assert.equal(implement.textContent, 'Implement');
});

test('clicking Close detaches the panel without dispatching any command', () => {
    const h = setup();
    openWith(h);
    const panel = panelEl(h.shim.overlayRoot);
    const close = buttonForAction(panel, 'close');
    close.onclick?.();
    assert.equal(h.shim.overlayRoot.children.length, 0);
    assert.equal(h.modal.getState(), null);
    assert.equal(h.commands.dismissCalls.length, 0);
    assert.equal(h.commands.implementCalls.length, 0);
});

// ---------------------------------------------------------------------------
// AC #4 — Dismiss + Implement dispatch through the command sink
// ---------------------------------------------------------------------------

test('Dismiss dispatches dismissReport with {taskId, reportId} and transitions rr-ready → rr-submitting → rr-done', async () => {
    const h = setup();
    let resolveDismiss: () => void = (): void => undefined;
    h.commands.dismissBlocker = new Promise<void>((r) => {
        resolveDismiss = r;
    });

    openWith(h, { taskId: 'task-42', reportId: 'rep-9' });
    const promise = h.modal.dismiss();

    // While the command sink is in flight the modal is in rr-submitting.
    const submittingState = h.modal.getState();
    assert.ok(submittingState && submittingState.kind === 'rr-submitting');
    if (submittingState && submittingState.kind === 'rr-submitting') {
        assert.equal(submittingState.action, 'dismiss');
    }

    resolveDismiss();
    await promise;

    assert.equal(h.commands.dismissCalls.length, 1);
    assert.equal(h.commands.dismissCalls[0].taskId, 'task-42');
    assert.equal(h.commands.dismissCalls[0].reportId, 'rep-9');
    assert.equal(h.commands.implementCalls.length, 0);

    const done = h.modal.getState();
    assert.ok(done && done.kind === 'rr-done');
    if (done && done.kind === 'rr-done') {
        assert.equal(done.action, 'dismiss');
    }
});

test('Implement dispatches implementReport with {taskId, reportId} and transitions rr-ready → rr-submitting → rr-done', async () => {
    const h = setup();
    let resolveImpl: () => void = (): void => undefined;
    h.commands.implementBlocker = new Promise<void>((r) => {
        resolveImpl = r;
    });

    openWith(h, { taskId: 'task-7', reportId: 'rep-3' });
    const promise = h.modal.implement();

    const submitting = h.modal.getState();
    assert.ok(submitting && submitting.kind === 'rr-submitting');
    if (submitting && submitting.kind === 'rr-submitting') {
        assert.equal(submitting.action, 'implement');
    }

    resolveImpl();
    await promise;

    assert.equal(h.commands.implementCalls.length, 1);
    assert.deepEqual(h.commands.implementCalls[0], {
        taskId: 'task-7',
        reportId: 'rep-3',
    });
    assert.equal(h.commands.dismissCalls.length, 0);

    const done = h.modal.getState();
    assert.ok(done && done.kind === 'rr-done');
    if (done && done.kind === 'rr-done') {
        assert.equal(done.action, 'implement');
    }
});

test('clicking the Dismiss button calls dismissReport through the command sink', async () => {
    const h = setup();
    openWith(h, { taskId: 't', reportId: 'r' });
    const panel = panelEl(h.shim.overlayRoot);
    buttonForAction(panel, 'dismiss').onclick?.();
    // The click handler returns synchronously; flush the microtask queue.
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(h.commands.dismissCalls.length, 1);
    assert.equal(h.commands.dismissCalls[0].taskId, 't');
    assert.equal(h.commands.dismissCalls[0].reportId, 'r');
});

test('clicking the Implement button calls implementReport through the command sink', async () => {
    const h = setup();
    openWith(h, { taskId: 't', reportId: 'r' });
    const panel = panelEl(h.shim.overlayRoot);
    buttonForAction(panel, 'implement').onclick?.();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(h.commands.implementCalls.length, 1);
    assert.deepEqual(h.commands.implementCalls[0], { taskId: 't', reportId: 'r' });
});

test('Dismiss forwards the explicit reason argument to the command sink', async () => {
    const h = setup();
    openWith(h, { taskId: 't', reportId: 'r' });
    await h.modal.dismiss({ reason: 'not actionable' });
    assert.equal(h.commands.dismissCalls.length, 1);
    assert.equal(h.commands.dismissCalls[0].reason, 'not actionable');
});

test('Dismiss reads the reason from the rendered textarea when no argument is supplied', async () => {
    const h = setup();
    openWith(h, { taskId: 't', reportId: 'r' });
    const panel = panelEl(h.shim.overlayRoot);
    const reasonEl = findFirst(panel, (n) => n.attributes.get('data-input') === 'reason');
    assert.ok(reasonEl, 'expected a reason textarea in rr-ready');
    reasonEl!.value = '  duplicate of #42  ';
    await h.modal.dismiss();
    assert.equal(h.commands.dismissCalls.length, 1);
    assert.equal(h.commands.dismissCalls[0].reason, 'duplicate of #42');
});

test('Dismiss omits the reason when neither argument nor textarea has content', async () => {
    const h = setup();
    openWith(h, { taskId: 't', reportId: 'r' });
    await h.modal.dismiss();
    assert.equal(h.commands.dismissCalls.length, 1);
    assert.equal(h.commands.dismissCalls[0].reason, undefined);
});

test('Dismiss failure transitions to rr-error and surfaces a toast', async () => {
    const h = setup();
    h.commands.dismissShouldReject = new Error('upstream offline');
    openWith(h, { taskId: 't', reportId: 'r' });
    await h.modal.dismiss();

    const state = h.modal.getState();
    assert.ok(state && state.kind === 'rr-error');
    if (state && state.kind === 'rr-error') {
        assert.equal(state.action, 'dismiss');
        assert.equal(state.message, 'upstream offline');
    }
    assert.equal(h.toast.calls.length, 1);
    assert.equal(h.toast.calls[0].kind, 'error');
});

test('Implement failure transitions to rr-error and surfaces a toast', async () => {
    const h = setup();
    h.commands.implementShouldReject = new Error('command bus rejected');
    openWith(h, { taskId: 't', reportId: 'r' });
    await h.modal.implement();

    const state = h.modal.getState();
    assert.ok(state && state.kind === 'rr-error');
    if (state && state.kind === 'rr-error') {
        assert.equal(state.action, 'implement');
        assert.equal(state.message, 'command bus rejected');
    }
    assert.equal(h.toast.calls.length, 1);
    assert.equal(h.toast.calls[0].kind, 'error');
});

test('dismiss() / implement() reject outside rr-ready', async () => {
    const h = setup();
    // Closed.
    await assert.rejects(h.modal.dismiss(), /rr-ready state, got "closed"/);
    await assert.rejects(h.modal.implement(), /rr-ready state, got "closed"/);

    // rr-submitting (mid-flight Dismiss).
    let release: () => void = (): void => undefined;
    h.commands.dismissBlocker = new Promise<void>((r) => {
        release = r;
    });
    openWith(h, { taskId: 't', reportId: 'r' });
    const pending = h.modal.dismiss();
    await assert.rejects(h.modal.dismiss(), /rr-ready state, got "rr-submitting"/);
    await assert.rejects(h.modal.implement(), /rr-ready state, got "rr-submitting"/);
    release();
    await pending;
});

test('closing the modal mid-flight discards the late dismiss response (no state mutation)', async () => {
    const h = setup();
    let release: () => void = (): void => undefined;
    h.commands.dismissBlocker = new Promise<void>((r) => {
        release = r;
    });
    openWith(h, { taskId: 't', reportId: 'r' });
    const pending = h.modal.dismiss();
    // Operator closes before the command completes.
    h.modal.close();
    release();
    await pending;
    // State must stay null — no rr-done leak.
    assert.equal(h.modal.getState(), null);
});

// ---------------------------------------------------------------------------
// State rendering — rr-submitting and rr-done surface a sensible body
// ---------------------------------------------------------------------------

test('rr-submitting renders a spinner + action-specific message', async () => {
    const h = setup();
    h.commands.implementBlocker = new Promise(() => undefined); // never resolves
    openWith(h, { taskId: 't', reportId: 'r' });
    void h.modal.implement();
    const panel = panelEl(h.shim.overlayRoot);
    const body = bodyForState(panel, 'rr-submitting');
    assert.equal(body.attributes.get('data-action'), 'implement');
    const spinner = findFirst(body, (n) => n.className === 'rr-spinner');
    assert.ok(spinner, 'missing spinner in rr-submitting');
});

test('rr-done after dismiss renders a confirmation message + Close button', async () => {
    const h = setup();
    openWith(h, { taskId: 't', reportId: 'r' });
    await h.modal.dismiss();
    const panel = panelEl(h.shim.overlayRoot);
    const body = bodyForState(panel, 'rr-done');
    assert.equal(body.attributes.get('data-action'), 'dismiss');
    const msg = findFirst(body, (n) => n.tagName === 'p');
    assert.equal(msg?.textContent, 'Report dismissed.');
    buttonForAction(body, 'close'); // throws if missing
});

test('rr-done after implement renders the "Implementation queued." message', async () => {
    const h = setup();
    openWith(h, { taskId: 't', reportId: 'r' });
    await h.modal.implement();
    const panel = panelEl(h.shim.overlayRoot);
    const body = bodyForState(panel, 'rr-done');
    const msg = findFirst(body, (n) => n.tagName === 'p');
    assert.equal(msg?.textContent, 'Implementation queued.');
});

// ---------------------------------------------------------------------------
// AC #5 — `#review-report-modal-template` is registered in index.html
// ---------------------------------------------------------------------------

test('hosts/board-ui/index.html registers a <template> with id review-report-modal-template carrying the three V1 action buttons', () => {
    const indexPath = path.resolve(
        __dirname,
        '../../../hosts/board-ui/index.html',
    );
    const html = fs.readFileSync(indexPath, 'utf8');
    assert.ok(
        html.includes(`id="${REVIEW_REPORT_TEMPLATE_ID}"`),
        `expected a <template id="${REVIEW_REPORT_TEMPLATE_ID}"> in index.html`,
    );
    // The three V1 action buttons must be reachable from the static template
    // so the structural source-of-truth in index.html stays in sync with the
    // runtime renderer.
    for (const action of ['close', 'dismiss', 'implement'] as const) {
        assert.ok(
            html.includes(`data-action="${action}"`),
            `expected a button with data-action="${action}" in the review-report template`,
        );
    }
    // The report-content slot is structural too — the runtime renderer fills
    // it via doc.createElement('pre'), but the template advertises the slot.
    assert.ok(
        html.includes('data-report-content'),
        'expected a data-report-content slot in the review-report template',
    );
});
