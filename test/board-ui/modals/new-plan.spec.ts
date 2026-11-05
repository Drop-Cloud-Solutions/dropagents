/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Parity tests for the new-plan modal.
 *
 * Coverage targets:
 *   AC #1 open() mounts the panel under the supplied root and registers
 *         with the overlay-manager via openOverlay('new-plan', el).
 *   AC #2 np-brief submit dispatches `CreatePlan` and transitions to
 *         np-planning.
 *   AC #3 np-planning polls decompose-status and advances to
 *         np-plan-review when status === 'complete'.
 *   AC #4 np-plan-review renders the markdown and offers approve +
 *         regenerate + reject buttons; approve POSTs to
 *         `plan-review/approve` and walks through np-decomposing →
 *         np-success.
 *   AC #5 errors transition to np-error and surface a toast.
 *   AC #6 regenerate path re-enters np-planning (revision N+1 ready
 *         for the polling loop to surface).
 *
 * Dual-runner discovery — same pattern as
 * hosts/board-ui/client/chrome/toast.spec.ts: vitest when VITEST=true,
 * node:test otherwise.
 */
import * as assert from 'node:assert/strict';

import {
    DEFAULT_POLL_INTERVAL_MS,
    NEW_PLAN_OVERLAY_ID,
    createNewPlanModal,
    type ApprovePlanInput,
    type DecomposeStatusResponse,
    type ModalDocument,
    type ModalElement,
    type NewPlanCommandSink,
    type NewPlanModalHandle,
    type OverlayManagerLike,
    type PlanReviewClient,
    type PlanReviewDraft,
    type RegeneratePlanInput,
    type ShowToastFn,
    type TimerPort,
    type ToastInput,
} from '../../../hosts/board-ui/client/modals/new-plan';

// ---------------------------------------------------------------------------
// Dual-runner test() shim
// ---------------------------------------------------------------------------

type TestFn = (name: string, fn: () => void | Promise<void>) => void;

const test: TestFn = (((): TestFn => {
    if (process.env.VITEST) {
        const gt = (globalThis as { test?: TestFn }).test;
        if (typeof gt !== 'function') {
            throw new Error(
                'new-plan.spec.ts: VITEST=true but globalThis.test is missing — '
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
    // The modal mounts a `.modal-chrome__overlay` backdrop directly
    // under #overlay-root and nests the panel inside it (matches the
    // project-modal convention and gives the modal `position: fixed`
    // centering). Walk one level deeper to land on the actual panel.
    if (overlayRoot.children.length === 0) {
        throw new Error('expected a backdrop under overlay-root, found none');
    }
    const backdrop = overlayRoot.children[0];
    if (!backdrop.children || backdrop.children.length === 0) {
        throw new Error('expected a panel inside the backdrop, found none');
    }
    return backdrop.children[0];
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

interface FakeCommands extends NewPlanCommandSink {
    readonly createCalls: Array<{ projectId: string; title: string; body?: string }>;
    readonly updateCalls: Array<{ planId: string; title?: string; body?: string }>;
    readonly generateCalls: Array<{
        projectId: string;
        planId: string;
        revision: number;
        briefContent?: string;
    }>;
    nextPlanId: string;
    createPlanShouldReject: Error | null;
}

function makeCommands(): FakeCommands {
    const sink: FakeCommands = {
        createCalls: [],
        updateCalls: [],
        generateCalls: [],
        nextPlanId: 'plan-1',
        createPlanShouldReject: null,
        async createPlan(input): Promise<{ planId: string }> {
            sink.createCalls.push({
                projectId: input.projectId,
                title: input.title,
                body: input.body,
            });
            if (sink.createPlanShouldReject) throw sink.createPlanShouldReject;
            return { planId: sink.nextPlanId };
        },
        async updatePlan(input): Promise<void> {
            sink.updateCalls.push({ ...input });
        },
        async generatePlan(input): Promise<void> {
            sink.generateCalls.push({ ...input });
        },
    };
    return sink;
}

interface FakePlanReview extends PlanReviewClient {
    statusResponses: DecomposeStatusResponse[];
    statusError: Error | null;
    review: PlanReviewDraft;
    reviewError: Error | null;
    regenerateError: Error | null;
    approveError: Error | null;
    /**
     * When set, `approvePlan` awaits this promise before resolving. Lets a
     * test catch the in-flight np-decomposing state without monkey-patching
     * the method.
     */
    approveBlocker: Promise<void> | null;
    /**
     * Plan record returned by `fetchPlan`. `null` simulates a 404; this
     * spec doesn't exercise edit mode today, so the default is `null` and
     * the call counter only ticks if a future case opens the modal with
     * an `existing` target.
     */
    planDetail: { title?: string; body?: string } | null;
    readonly statusCalls: Array<{ projectId: string; planId: string }>;
    readonly reviewCalls: Array<{ projectId: string; planId: string }>;
    readonly fetchPlanCalls: Array<{ projectId: string; planId: string }>;
    readonly regenerateCalls: Array<{
        projectId: string;
        planId: string;
        body?: RegeneratePlanInput;
    }>;
    readonly approveCalls: Array<{
        projectId: string;
        planId: string;
        body?: ApprovePlanInput;
    }>;
}

function makePlanReview(): FakePlanReview {
    const client: FakePlanReview = {
        statusResponses: [{ status: 'running' }],
        statusError: null,
        review: { markdown: '# plan\n\n- step 1', generatedAt: 1_700_000_000_000 },
        reviewError: null,
        regenerateError: null,
        approveError: null,
        approveBlocker: null,
        planDetail: null,
        statusCalls: [],
        reviewCalls: [],
        fetchPlanCalls: [],
        regenerateCalls: [],
        approveCalls: [],
        async fetchPlan(projectId, planId) {
            client.fetchPlanCalls.push({ projectId, planId });
            return client.planDetail;
        },
        async fetchDecomposeStatus(projectId, planId): Promise<DecomposeStatusResponse> {
            client.statusCalls.push({ projectId, planId });
            if (client.statusError) throw client.statusError;
            // Pop the head response; fall back to the last one when exhausted
            // so polling can settle on a steady "running"/"complete" terminal.
            if (client.statusResponses.length > 1) {
                const [head, ...rest] = client.statusResponses;
                client.statusResponses = rest;
                return head;
            }
            return client.statusResponses[0];
        },
        async fetchPlanReview(projectId, planId): Promise<PlanReviewDraft> {
            client.reviewCalls.push({ projectId, planId });
            if (client.reviewError) throw client.reviewError;
            return client.review;
        },
        async regeneratePlanReview(projectId, planId, body): Promise<void> {
            client.regenerateCalls.push({ projectId, planId, body });
            if (client.regenerateError) throw client.regenerateError;
        },
        async approvePlan(projectId, planId, body): Promise<void> {
            client.approveCalls.push({ projectId, planId, body });
            if (client.approveBlocker) await client.approveBlocker;
            if (client.approveError) throw client.approveError;
        },
    };
    return client;
}

interface FakeTimers extends TimerPort {
    capturedHandler: (() => void) | null;
    capturedMs: number | null;
    cleared: number;
}

function makeTimers(): FakeTimers {
    const t: FakeTimers = {
        capturedHandler: null,
        capturedMs: null,
        cleared: 0,
        setInterval(handler, ms): unknown {
            t.capturedHandler = handler;
            t.capturedMs = ms;
            return 'fake-interval-handle';
        },
        clearInterval(_handle): void {
            t.cleared++;
            t.capturedHandler = null;
            t.capturedMs = null;
        },
    };
    return t;
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Harness {
    readonly modal: NewPlanModalHandle;
    readonly shim: ShimDocument;
    readonly overlay: FakeOverlayManager;
    readonly toast: FakeToast;
    readonly commands: FakeCommands;
    readonly planReview: FakePlanReview;
    readonly timers: FakeTimers;
}

function setup(overrides?: { mountRoot?: ModalElement }): Harness {
    const shim = makeShimDocument();
    const overlay = makeOverlayManager();
    const toast = makeToast();
    const commands = makeCommands();
    const planReview = makePlanReview();
    const timers = makeTimers();
    const modal = createNewPlanModal({
        doc: shim.doc,
        mountRoot: overrides?.mountRoot,
        overlayManager: overlay,
        showToast: toast.fn,
        commands,
        planReview,
        timers,
    });
    return { modal, shim, overlay, toast, commands, planReview, timers };
}

// ---------------------------------------------------------------------------
// AC #1 — open() mounts under #overlay-root and registers with the manager
// ---------------------------------------------------------------------------

test('open() mounts a panel under #overlay-root and registers it with the overlay manager', () => {
    const h = setup();
    h.modal.open('proj-1');

    assert.equal(h.shim.overlayRoot.children.length, 1, 'one panel mounted');
    const panel = panelEl(h.shim.overlayRoot);
    assert.equal(panel.attributes.get('data-new-plan-modal'), '');
    assert.equal(panel.attributes.get('role'), 'dialog');
    assert.equal(panel.attributes.get('aria-modal'), 'true');

    assert.equal(h.overlay.opened.length, 1);
    assert.equal(h.overlay.opened[0].id, NEW_PLAN_OVERLAY_ID);
    assert.equal(h.overlay.opened[0].element, panel);

    const state = h.modal.getState();
    assert.ok(state && state.kind === 'np-brief');
    assert.equal((state as { projectId: string }).projectId, 'proj-1');
    assert.equal(panel.attributes.get('data-state'), 'np-brief');
});

test('open() prefers an explicit mountRoot over the default #overlay-root', () => {
    const customRoot = makeShimElement('div');
    const h = setup({ mountRoot: customRoot });
    h.modal.open('proj-1');

    assert.equal(customRoot.children.length, 1);
    assert.equal(h.shim.overlayRoot.children.length, 0);
});

test('open() with no projectId throws — caller must scope the modal to a project', () => {
    const h = setup();
    assert.throws(() => h.modal.open(''), /non-empty projectId/);
});

test('close() detaches the panel, calls overlay-manager.closeOverlay, and clears state', () => {
    const h = setup();
    h.modal.open('proj-1');
    h.modal.close();

    assert.equal(h.shim.overlayRoot.children.length, 0, 'panel detached');
    assert.deepEqual(h.overlay.closed, [NEW_PLAN_OVERLAY_ID]);
    assert.equal(h.modal.getState(), null);
});

// ---------------------------------------------------------------------------
// AC #2 — np-brief submit dispatches CreatePlan and goes to np-planning
// ---------------------------------------------------------------------------

test('np-brief → np-planning: submitCreatePlan dispatches CreatePlan and starts the poll', async () => {
    const h = setup();
    h.modal.open('proj-1');
    h.commands.nextPlanId = 'plan-42';

    await h.modal.submitCreatePlan({ title: 'Ship the thing', body: 'big idea' });

    assert.deepEqual(h.commands.createCalls, [
        { projectId: 'proj-1', title: 'Ship the thing', body: 'big idea' },
    ]);
    const state = h.modal.getState();
    assert.ok(state && state.kind === 'np-planning', `expected np-planning, got ${state?.kind}`);
    assert.equal((state as { planId: string }).planId, 'plan-42');

    // Polling interval should be scheduled at the default cadence.
    assert.equal(h.timers.capturedMs, DEFAULT_POLL_INTERVAL_MS);
    assert.equal(typeof h.timers.capturedHandler, 'function');

    // Panel re-rendered with the planning view.
    const panel = panelEl(h.shim.overlayRoot);
    assert.equal(panel.attributes.get('data-state'), 'np-planning');
    bodyForState(panel, 'np-planning');
});

test('np-brief rejects an empty title and stays in np-brief with a toast', async () => {
    const h = setup();
    h.modal.open('proj-1');

    await h.modal.submitCreatePlan({ title: '   ' });

    assert.equal(h.commands.createCalls.length, 0, 'no command dispatched');
    assert.equal(h.modal.getState()?.kind, 'np-brief');
    assert.equal(h.toast.calls.length, 1);
    assert.equal(h.toast.calls[0].kind, 'error');
});

test('np-brief clicking the submit button triggers CreatePlan via the rendered onclick', async () => {
    const h = setup();
    h.modal.open('proj-1');

    const panel = panelEl(h.shim.overlayRoot);
    const titleInput = findFirst(panel, (n) => n.attributes.get('data-input') === 'title');
    const bodyInput = findFirst(panel, (n) => n.attributes.get('data-input') === 'body');
    if (!titleInput || !bodyInput) throw new Error('missing inputs in np-brief');
    titleInput.value = 'From the button';
    bodyInput.value = 'Body text';

    const submit = buttonForAction(panel, 'submit');
    submit.onclick?.();
    // Microtask drain so the promise inside the onclick handler settles.
    await Promise.resolve();
    await Promise.resolve();

    assert.deepEqual(h.commands.createCalls, [
        { projectId: 'proj-1', title: 'From the button', body: 'Body text' },
    ]);
    assert.equal(h.modal.getState()?.kind, 'np-planning');
});

// ---------------------------------------------------------------------------
// AC #3 — np-planning polls decompose-status, advances to np-plan-review
// ---------------------------------------------------------------------------

test('np-planning → np-plan-review: poll sees complete, fetches review, renders markdown', async () => {
    const h = setup();
    h.modal.open('proj-1');
    h.commands.nextPlanId = 'plan-7';
    h.planReview.statusResponses = [{ status: 'running' }, { status: 'complete' }];
    h.planReview.review = { markdown: '## generated plan', generatedAt: 1_700_000_111_000 };

    await h.modal.submitCreatePlan({ title: 't' });
    assert.equal(h.modal.getState()?.kind, 'np-planning');

    // First poll — still running.
    await h.modal.pollOnce();
    assert.equal(h.modal.getState()?.kind, 'np-planning');
    assert.equal(h.planReview.statusCalls.length, 1);
    assert.equal(h.planReview.reviewCalls.length, 0);

    // Second poll — complete. Drives the plan-review fetch + transition.
    await h.modal.pollOnce();
    const state = h.modal.getState();
    if (!state || state.kind !== 'np-plan-review') {
        throw new Error(`expected np-plan-review, got ${state?.kind ?? 'closed'}`);
    }
    assert.equal(state.planId, 'plan-7');
    assert.equal(state.markdown, '## generated plan');
    assert.equal(state.generatedAt, 1_700_000_111_000);
    assert.equal(h.planReview.reviewCalls.length, 1);
    assert.deepEqual(h.planReview.reviewCalls[0], { projectId: 'proj-1', planId: 'plan-7' });

    // Polling stops once we leave np-planning.
    assert.equal(h.timers.cleared, 1, 'interval cleared after transition');

    // Panel reflects the new state and includes approve + regenerate + reject buttons.
    const panel = panelEl(h.shim.overlayRoot);
    assert.equal(panel.attributes.get('data-state'), 'np-plan-review');
    const body = bodyForState(panel, 'np-plan-review');
    const editor = findFirst(body, (n) => n.attributes.get('data-input') === 'plan-markdown');
    assert.ok(editor, 'editable markdown textarea rendered');
    assert.equal(editor?.value, '## generated plan');
    buttonForAction(panel, 'approve');
    buttonForAction(panel, 'regenerate');
    buttonForAction(panel, 'reject');
});

test('np-planning pollOnce is a no-op when the modal is not in np-planning', async () => {
    const h = setup();
    h.modal.open('proj-1');
    await h.modal.pollOnce();
    assert.equal(h.planReview.statusCalls.length, 0);
    assert.equal(h.modal.getState()?.kind, 'np-brief');
});

// ---------------------------------------------------------------------------
// AC #4 — np-plan-review → np-decomposing → np-success via approve
// ---------------------------------------------------------------------------

test('np-plan-review → np-decomposing → np-success: approve POSTs and succeeds', async () => {
    const h = setup();
    h.modal.open('proj-1');
    h.commands.nextPlanId = 'plan-9';
    h.planReview.statusResponses = [{ status: 'complete' }];

    await h.modal.submitCreatePlan({ title: 't' });
    await h.modal.pollOnce();
    assert.equal(h.modal.getState()?.kind, 'np-plan-review');

    // Block the approvePlan call so we can observe the np-decomposing state
    // mid-flight, then release it and assert the np-success transition.
    let resolveApprove: (() => void) | null = null;
    h.planReview.approveBlocker = new Promise<void>((res) => {
        resolveApprove = res;
    });

    const approvePromise = h.modal.approvePlan();
    // Drain one microtask so approvePlan starts (the dispatch to
    // np-decomposing happens synchronously before the first await).
    await Promise.resolve();
    assert.equal(h.modal.getState()?.kind, 'np-decomposing');
    const panelMid = panelEl(h.shim.overlayRoot);
    assert.equal(panelMid.attributes.get('data-state'), 'np-decomposing');
    bodyForState(panelMid, 'np-decomposing');

    // Release the approve + drain.
    if (!resolveApprove) throw new Error('blocker resolver not captured');
    (resolveApprove as () => void)();
    await approvePromise;

    const finalState = h.modal.getState();
    if (!finalState || finalState.kind !== 'np-success') {
        throw new Error(`expected np-success, got ${finalState?.kind ?? 'closed'}`);
    }
    assert.equal(finalState.planId, 'plan-9');

    assert.equal(h.planReview.approveCalls.length, 1);
    assert.equal(h.planReview.approveCalls[0].planId, 'plan-9');
    // Content defaults to the markdown of the np-plan-review state when the
    // caller omits it (no inline textarea edit).
    assert.equal(h.planReview.approveCalls[0].body?.content, h.planReview.review.markdown);
});

test('np-plan-review regenerate POSTs to /plan-review/regenerate and re-enters np-planning', async () => {
    const h = setup();
    h.modal.open('proj-1');
    h.commands.nextPlanId = 'plan-r';
    h.planReview.statusResponses = [{ status: 'complete' }];

    await h.modal.submitCreatePlan({ title: 't' });
    await h.modal.pollOnce();
    assert.equal(h.modal.getState()?.kind, 'np-plan-review');

    await h.modal.regenerate();
    assert.equal(h.planReview.regenerateCalls.length, 1);
    assert.deepEqual(h.planReview.regenerateCalls[0], {
        projectId: 'proj-1',
        planId: 'plan-r',
        body: undefined,
    });
    assert.equal(h.modal.getState()?.kind, 'np-planning');
    // A new interval was scheduled for the fresh np-planning entry.
    assert.equal(typeof h.timers.capturedHandler, 'function');
});

// ---------------------------------------------------------------------------
// AC #5 — error transitions + toast
// ---------------------------------------------------------------------------

test('CreatePlan failure → np-error with a toast', async () => {
    const h = setup();
    h.modal.open('proj-1');
    h.commands.createPlanShouldReject = new Error('command bus rejected');

    await h.modal.submitCreatePlan({ title: 'broken' });

    const state = h.modal.getState();
    if (!state || state.kind !== 'np-error') {
        throw new Error(`expected np-error, got ${state?.kind ?? 'closed'}`);
    }
    assert.equal(state.message, 'command bus rejected');
    assert.equal(h.toast.calls.length, 1);
    assert.equal(h.toast.calls[0].kind, 'error');
    assert.equal(h.toast.calls[0].message, 'command bus rejected');

    const panel = panelEl(h.shim.overlayRoot);
    assert.equal(panel.attributes.get('data-state'), 'np-error');
    const errBody = bodyForState(panel, 'np-error');
    const errMsg = findFirst(errBody, (n) => n.attributes.has('data-error-message'));
    assert.equal(errMsg?.textContent, 'command bus rejected');
});

test('decompose-status returning status=error transitions to np-error with the surfaced message', async () => {
    const h = setup();
    h.modal.open('proj-1');
    h.planReview.statusResponses = [
        { status: 'error', errorMessage: 'decomposer crashed' },
    ];

    await h.modal.submitCreatePlan({ title: 't' });
    await h.modal.pollOnce();

    const state = h.modal.getState();
    if (!state || state.kind !== 'np-error') {
        throw new Error(`expected np-error, got ${state?.kind ?? 'closed'}`);
    }
    assert.equal(state.message, 'decomposer crashed');
    assert.equal(h.toast.calls.length, 1);
    assert.equal(h.toast.calls[0].kind, 'error');

    // Polling stops on the transition into np-error so we don't keep
    // hammering the projection route after we've already given up.
    assert.equal(h.timers.cleared, 1);
});

test('decompose-status network failure → np-error + toast', async () => {
    const h = setup();
    h.modal.open('proj-1');
    h.planReview.statusError = new Error('network down');

    await h.modal.submitCreatePlan({ title: 't' });
    await h.modal.pollOnce();

    assert.equal(h.modal.getState()?.kind, 'np-error');
    assert.equal(h.toast.calls[0].message, 'network down');
});

test('approvePlan failure during approve → np-error + toast', async () => {
    const h = setup();
    h.modal.open('proj-1');
    h.planReview.statusResponses = [{ status: 'complete' }];
    await h.modal.submitCreatePlan({ title: 't' });
    await h.modal.pollOnce();
    assert.equal(h.modal.getState()?.kind, 'np-plan-review');

    h.planReview.approveError = new Error('worker write failed');
    await h.modal.approvePlan();

    assert.equal(h.modal.getState()?.kind, 'np-error');
    assert.equal(h.toast.calls.length, 1);
    assert.equal(h.toast.calls[0].kind, 'error');
    assert.equal(h.toast.calls[0].message, 'worker write failed');
});

// ---------------------------------------------------------------------------
// Polling cadence — interval port wired through to fake timers
// ---------------------------------------------------------------------------

test('the polling interval handler is the one that invokes pollOnce', async () => {
    const h = setup();
    h.modal.open('proj-1');
    h.planReview.statusResponses = [{ status: 'running' }, { status: 'complete' }];

    await h.modal.submitCreatePlan({ title: 't' });
    const handler = h.timers.capturedHandler;
    if (typeof handler !== 'function') {
        throw new Error('expected the polling interval handler to be captured');
    }

    // First fire — still running.
    handler();
    // pollOnce is async — drain microtasks. Two await Promise.resolve()s
    // suffice because pollOnce has at most two awaits before the early
    // return on status === 'running'.
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(h.modal.getState()?.kind, 'np-planning');
    assert.equal(h.planReview.statusCalls.length, 1);

    // Second fire — complete + review fetch + transition.
    handler();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(h.modal.getState()?.kind, 'np-plan-review');
});

test('closing during np-planning stops the polling interval', () => {
    const h = setup();
    h.modal.open('proj-1');
    h.planReview.statusResponses = [{ status: 'running' }];
    void h.modal.submitCreatePlan({ title: 't' });

    // submitCreatePlan kicks off an async createPlan; wait for it.
    return Promise.resolve()
        .then(() => Promise.resolve())
        .then(() => {
            assert.equal(h.modal.getState()?.kind, 'np-planning');
            assert.equal(typeof h.timers.capturedHandler, 'function');

            h.modal.close();
            assert.equal(h.modal.getState(), null);
            assert.equal(h.timers.cleared, 1, 'interval cleared on close');
        });
});
