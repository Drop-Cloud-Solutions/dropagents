/**
 * Unit tests for the new-plan modal state machine and projection
 * wiring (AP-IFF-008 / AP-VP4-013).
 *
 * Coverage targets the task's acceptance criteria:
 *   AC #1     — `createNewPlanModal` mounts a distinct DOM region for
 *                each of np-brief / np-planning / np-plan-review /
 *                np-decomposing / np-success / np-rejected / np-error.
 *                Each transition is asserted to flip the `data-state` /
 *                `data-state-body` markers.
 *   AC #2     — Conventions sub-form on np-brief seeds from the
 *                `planDefaults` passed to `open()`.
 *   AC #3     — Approve POSTs `{conventions, content}` to the worker-api
 *                `plan-review/approve` endpoint via PlanReviewClient.
 *   AC #4     — Regenerate reveals an inline feedback textarea on first
 *                click and POSTs the operator feedback on submit.
 *   AC #5     — Reject closes the modal without further dispatch (the
 *                command sink stays untouched).
 *   AC #6     — Revision counter updates every time decompose-status
 *                returns a higher revision and never rewinds.
 *   AC #7     — Pure reducer transitions are asserted against
 *                `reduceNewPlan` so the state machine has a sharp,
 *                jsdom-free unit contract.
 *
 * Dual-runner discovery — mirrors `project-form-fields.test.ts`. The
 * repo's own `npm test` runs `node --test --import tsx`; the review
 * pipeline runs `npx vitest run`. The shim below picks the right
 * `test()` at module load so a single source file is discovered and
 * executed by both runners.
 */
import * as assert from 'node:assert/strict';

import {
    createNewPlanModal,
    PLAN_CONVENTION_FIELDS,
    reduceNewPlan,
    type ApprovePlanInput,
    type ModalDocument,
    type ModalElement,
    type NewPlanCommandSink,
    type NewPlanDeps,
    type NewPlanEvent,
    type NewPlanState,
    type OverlayManagerLike,
    type PlanConventions,
    type PlanLifecycleProjection,
    type PlanLifecycleUnsubscribe,
    type PlanReviewClient,
    type RegeneratePlanInput,
    type TimerPort,
    type ToastInput,
} from './new-plan';

// ---------------------------------------------------------------------------
// Dual-runner test() shim
// ---------------------------------------------------------------------------

type TestFn = (name: string, fn: () => void | Promise<void>) => void;

const test: TestFn = (((): TestFn => {
    if (process.env.VITEST) {
        const gt = (globalThis as { test?: TestFn }).test;
        if (typeof gt !== 'function') {
            throw new Error(
                'new-plan.test.ts: VITEST=true but globalThis.test is missing — '
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
// Minimal DOM shim — same shape as project-form-fields.test.ts so the
// modal-test suites speak the same language.
// ---------------------------------------------------------------------------

interface ShimElement extends ModalElement {
    readonly tagName: string;
    readonly children: ShimElement[];
    readonly attributes: Map<string, string>;
    parent: ShimElement | null;
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
        children,
        attributes: attrs,
        parent: null,
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

function makeShimDocument(): { doc: ModalDocument; root: ShimElement } {
    const root = makeShimElement('div');
    root.setAttribute('id', 'overlay-root');
    const doc: ModalDocument = {
        getElementById: (id: string): ModalElement | null => (id === 'overlay-root' ? root : null),
        createElement: (tag: string): ModalElement => makeShimElement(tag),
    };
    return { doc, root };
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

function panelOf(root: ShimElement): ShimElement {
    const p = findFirst(root, (n) => n.attributes.get('data-new-plan-modal') === '');
    if (!p) throw new Error('new-plan panel missing');
    return p;
}

function findButton(root: ShimElement, action: string): ShimElement | null {
    return findFirst(root, (n) => n.attributes.get('data-action') === action);
}

function findInput(root: ShimElement, name: string): ShimElement | null {
    return findFirst(root, (n) => n.attributes.get('data-input') === name);
}

// ---------------------------------------------------------------------------
// Test harness — minimal deps fakes
// ---------------------------------------------------------------------------

interface FakeCommandSink extends NewPlanCommandSink {
    createPlanCalls: number;
    updatePlanCalls: number;
    generatePlanCalls: number;
    lastCreateInput?: {
        readonly projectId: string;
        readonly title: string;
        readonly body?: string;
        readonly conventions?: PlanConventions;
    };
    nextPlanId: string;
}

function makeFakeCommands(): FakeCommandSink {
    const sink: FakeCommandSink = {
        createPlanCalls: 0,
        updatePlanCalls: 0,
        generatePlanCalls: 0,
        nextPlanId: 'plan-1',
        async createPlan(input): Promise<{ readonly planId: string }> {
            sink.createPlanCalls++;
            sink.lastCreateInput = input;
            return { planId: sink.nextPlanId };
        },
        async updatePlan(): Promise<void> {
            sink.updatePlanCalls++;
        },
        async generatePlan(): Promise<void> {
            sink.generatePlanCalls++;
        },
    };
    return sink;
}

interface FakePlanReview extends PlanReviewClient {
    decomposeStatus: 'idle' | 'running' | 'complete' | 'error';
    decomposeError?: string;
    /** Revision the next decompose-status response will surface. */
    decomposeRevision?: number;
    draftMarkdown: string;
    draftGeneratedAt: number;
    draftRevision?: number;
    regenerateCalls: number;
    lastRegenerateBody?: RegeneratePlanInput;
    approveCalls: number;
    lastApproveBody?: ApprovePlanInput;
    /**
     * The record the next `fetchPlan` call returns. `null` simulates a
     * 404 (the plan has been archived); `undefined` means no fetch is
     * expected on this run (the modal in create mode never calls it).
     */
    planDetail?: { title?: string; body?: string } | null;
    fetchPlanCalls: number;
}

function makeFakePlanReview(): FakePlanReview {
    const client: FakePlanReview = {
        decomposeStatus: 'running',
        draftMarkdown: '# Plan',
        draftGeneratedAt: 1700000000000,
        regenerateCalls: 0,
        approveCalls: 0,
        fetchPlanCalls: 0,
        async fetchPlan() {
            client.fetchPlanCalls++;
            return client.planDetail ?? null;
        },
        async fetchDecomposeStatus() {
            const out: {
                status: 'idle' | 'running' | 'complete' | 'error';
                errorMessage?: string;
                revision?: number;
            } = { status: client.decomposeStatus };
            if (client.decomposeError !== undefined) out.errorMessage = client.decomposeError;
            if (client.decomposeRevision !== undefined) out.revision = client.decomposeRevision;
            return out;
        },
        async fetchPlanReview() {
            const out: { markdown: string; generatedAt: number; revision?: number } = {
                markdown: client.draftMarkdown,
                generatedAt: client.draftGeneratedAt,
            };
            if (client.draftRevision !== undefined) out.revision = client.draftRevision;
            return out;
        },
        async regeneratePlanReview(_projectId, _planId, body) {
            client.regenerateCalls++;
            client.lastRegenerateBody = body;
        },
        async approvePlan(_projectId, _planId, body) {
            client.approveCalls++;
            client.lastApproveBody = body;
        },
    };
    return client;
}

function makeFakeOverlayManager(): OverlayManagerLike & { openCalls: number; closeCalls: number } {
    const manager = {
        openCalls: 0,
        closeCalls: 0,
        openOverlay(): unknown {
            manager.openCalls++;
            return undefined;
        },
        closeOverlay(): void {
            manager.closeCalls++;
        },
    };
    return manager;
}

function makeNoopTimers(): TimerPort {
    return {
        setInterval: () => 0,
        clearInterval: () => undefined,
    };
}

interface Harness {
    readonly modal: ReturnType<typeof createNewPlanModal>;
    readonly commands: FakeCommandSink;
    readonly planReview: FakePlanReview;
    readonly overlay: ReturnType<typeof makeFakeOverlayManager>;
    readonly toasts: ToastInput[];
    readonly root: ShimElement;
    readonly projection: FakeProjection;
}

interface FakeProjection extends PlanLifecycleProjection {
    listeners: Map<string, Set<(event: NewPlanEvent) => void>>;
    subscribeCalls: number;
    unsubscribeCalls: number;
    emit(planId: string, event: NewPlanEvent): void;
}

function makeFakeProjection(): FakeProjection {
    const listeners = new Map<string, Set<(event: NewPlanEvent) => void>>();
    const projection: FakeProjection = {
        listeners,
        subscribeCalls: 0,
        unsubscribeCalls: 0,
        subscribe(planId: string, listener: (event: NewPlanEvent) => void): PlanLifecycleUnsubscribe {
            projection.subscribeCalls++;
            let set = listeners.get(planId);
            if (!set) {
                set = new Set();
                listeners.set(planId, set);
            }
            set.add(listener);
            return (): void => {
                projection.unsubscribeCalls++;
                set?.delete(listener);
            };
        },
        emit(planId: string, event: NewPlanEvent): void {
            const set = listeners.get(planId);
            if (!set) return;
            for (const fn of [...set]) fn(event);
        },
    };
    return projection;
}

function makeHarness(extra?: Partial<NewPlanDeps>): Harness {
    const { doc, root } = makeShimDocument();
    const commands = makeFakeCommands();
    const planReview = makeFakePlanReview();
    const overlay = makeFakeOverlayManager();
    const toasts: ToastInput[] = [];
    const projection = makeFakeProjection();
    const deps: NewPlanDeps = {
        overlayManager: overlay,
        commands,
        planReview,
        showToast: (input) => toasts.push(input),
        doc,
        timers: makeNoopTimers(),
        projection,
        ...extra,
    };
    const modal = createNewPlanModal(deps);
    return { modal, commands, planReview, overlay, toasts, root, projection };
}

// ---------------------------------------------------------------------------
// AC #7 — pure reducer transitions, one test per transition
// ---------------------------------------------------------------------------

const EMPTY_CONVENTIONS: PlanConventions = {};
const SEED_CONVENTIONS: PlanConventions = {
    namespace_root: 'pkg.example',
    test_framework: 'vitest',
    branch_pattern: 'feature/{slug}',
    commit_pattern: '{type}: {summary}',
};

const BRIEF: NewPlanState = {
    kind: 'np-brief',
    projectId: 'proj-1',
    conventions: EMPTY_CONVENTIONS,
};
const PLANNING: NewPlanState = {
    kind: 'np-planning',
    projectId: 'proj-1',
    planId: 'plan-1',
    conventions: EMPTY_CONVENTIONS,
};
const PLAN_REVIEW: NewPlanState = {
    kind: 'np-plan-review',
    projectId: 'proj-1',
    planId: 'plan-1',
    markdown: '# draft',
    generatedAt: 1700000000000,
    conventions: EMPTY_CONVENTIONS,
};
const DECOMPOSING: NewPlanState = {
    kind: 'np-decomposing',
    projectId: 'proj-1',
    planId: 'plan-1',
};
const SUCCESS: NewPlanState = { kind: 'np-success', projectId: 'proj-1', planId: 'plan-1' };
const REJECTED: NewPlanState = { kind: 'np-rejected', projectId: 'proj-1', planId: 'plan-1' };
const ERROR_STATE: NewPlanState = {
    kind: 'np-error',
    projectId: 'proj-1',
    planId: 'plan-1',
    message: 'boom',
};

// ---------------------------------------------------------------------------
// Migration 021 — create-with-attachments path
// ---------------------------------------------------------------------------

test('create with picked attachments pre-mints a planId, uploads each file, and closes', async () => {
    const uploads: Array<{ planId: string; name: string }> = [];
    const h = makeHarness({
        uploadPlanAttachment: async (planId, file): Promise<void> => {
            uploads.push({ planId, name: file.name });
        },
    });
    h.modal.open('proj-1');

    // Simulate the operator picking two files: set the file input's
    // `files` and invoke its onchange (the real browser does this).
    const input = findInput(h.root, 'plan-attachments') as
        (ShimElement & { files?: unknown; onchange?: () => void }) | null;
    assert.ok(input, 'attachment file input should render when uploader is wired');
    input.files = [
        { name: 'bug.png' } as unknown as File,
        { name: 'spec.pdf' } as unknown as File,
    ];
    input.onchange?.();

    await h.modal.submitCreatePlan({ title: 'My plan', body: 'do it' });

    // createPlan was called WITH a pre-minted planId (not empty).
    assert.equal(h.commands.createPlanCalls, 1);
    const planId = (h.commands.lastCreateInput as { planId?: string }).planId;
    assert.ok(planId && planId.length > 0, 'createPlan must receive a pre-minted planId');
    // Both files uploaded against that same planId.
    assert.deepEqual(uploads, [
        { planId: planId as string, name: 'bug.png' },
        { planId: planId as string, name: 'spec.pdf' },
    ]);
    // Modal closed (did NOT enter np-planning) and toasted success.
    assert.equal(h.modal.getState(), null);
    assert.ok(h.toasts.some((t) => t.kind === 'success'));
});

test('create with NO picked attachments keeps the normal flow (no planId pre-mint)', async () => {
    const h = makeHarness({
        uploadPlanAttachment: async (): Promise<void> => undefined,
    });
    h.modal.open('proj-1');
    // No file pick — submit normally. The fake returns nextPlanId, so the
    // modal advances to np-planning exactly as before.
    await h.modal.submitCreatePlan({ title: 'My plan', body: 'do it' });
    assert.equal(h.commands.createPlanCalls, 1);
    assert.equal((h.commands.lastCreateInput as { planId?: string }).planId, undefined);
    assert.equal(h.modal.getState()?.kind, 'np-planning');
});

/**
 * "Save & run planner" and the picked files.
 *
 * Field report: "I've created an investigation plan, and added a file as
 * input, the task then ran, but the agent said there was no input file."
 * The worker log showed CreatePlan at 14:04:53.771 and the planner's
 * pre-spawn refresh at 14:04:54.216 with NO `attachments: uploaded` line
 * between them, and the plan's attachment list was empty: this submit path
 * never read `briefAttachments`, so the file the operator could see listed
 * in the form never left the browser. "Create draft plan" uploaded them;
 * this button dropped them.
 */
function flushAsync(): Promise<void> {
    // The button's onclick is `void submitAndRunPlanner(...)`, so the
    // awaited createPlan -> upload -> generatePlan chain needs several
    // microtask turns to drain.
    let p = Promise.resolve();
    for (let i = 0; i < 12; i += 1) p = p.then(() => undefined);
    return p;
}

function pickFiles(h: Harness, ...names: string[]): void {
    const input = findInput(h.root, 'plan-attachments') as
        (ShimElement & { files?: unknown; onchange?: () => void }) | null;
    assert.ok(input, 'attachment file input should render when uploader is wired');
    input.files = names.map((name) => ({ name }) as unknown as File);
    input.onchange?.();
}

function clickSaveAndRunPlanner(h: Harness, title: string): void {
    const panel = panelOf(h.root);
    const titleInput = findInput(panel, 'title') as ShimElement;
    titleInput.value = title;
    const btn = findButton(panel, 'save-and-run-planner') as ShimElement;
    assert.ok(btn, '"Save & run planner" button rendered');
    btn.onclick?.();
}

test('Save & run planner uploads the picked files BEFORE dispatching the planner', async () => {
    // Ordering is the whole point: the planner's `# Plan attachments`
    // block is built when GeneratePlan spawns it, so an upload that lands
    // afterwards is invisible to the run the operator just started.
    const generateCallsAtUpload: number[] = [];
    const uploads: Array<{ planId: string; name: string }> = [];
    const h = makeHarness({
        uploadPlanAttachment: async (planId, file): Promise<void> => {
            generateCallsAtUpload.push(h.commands.generatePlanCalls);
            uploads.push({ planId, name: file.name });
        },
    });
    h.modal.open('proj-1');
    pickFiles(h, 'connection-spec.docx', 'sgtins.csv');
    clickSaveAndRunPlanner(h, 'check the sgtins from MAO');
    await flushAsync();

    assert.equal(h.commands.createPlanCalls, 1);
    const planId = (h.commands.lastCreateInput as { planId?: string }).planId;
    assert.ok(planId && planId.length > 0, 'createPlan must receive a pre-minted planId');
    assert.deepEqual(
        uploads,
        [
            { planId: planId as string, name: 'connection-spec.docx' },
            { planId: planId as string, name: 'sgtins.csv' },
        ],
        'every picked file must be uploaded against the plan that was just created',
    );
    assert.deepEqual(
        generateCallsAtUpload,
        [0, 0],
        'GeneratePlan must not have been dispatched while files were still uploading',
    );
    assert.equal(h.commands.generatePlanCalls, 1, 'the planner is still dispatched');
    assert.ok(
        h.toasts.some((t) => t.kind === 'success' && /attachment/i.test(t.message)),
        `the success toast should name the uploads; got ${JSON.stringify(h.toasts)}`,
    );
});

test('Save & run planner with no picked files dispatches the planner unchanged', async () => {
    const h = makeHarness({
        uploadPlanAttachment: async (): Promise<void> => undefined,
    });
    h.modal.open('proj-1');
    clickSaveAndRunPlanner(h, 'no files here');
    await flushAsync();
    assert.equal(h.commands.createPlanCalls, 1);
    assert.equal(h.commands.generatePlanCalls, 1);
    assert.ok(
        h.toasts.some((t) => t.kind === 'success' && !/attachment/i.test(t.message)),
        'the toast should not mention attachments when none were picked',
    );
});

test('Save & run planner does NOT start the planner when an upload fails', async () => {
    // Running the planner on a partial input set is the failure this whole
    // fix is about - so a failed upload has to stop the dispatch and say so,
    // not proceed quietly.
    const h = makeHarness({
        uploadPlanAttachment: async (_planId, file): Promise<void> => {
            if (file.name === 'spec.pdf') throw new Error('HTTP 415');
        },
    });
    h.modal.open('proj-1');
    pickFiles(h, 'ok.png', 'spec.pdf');
    clickSaveAndRunPlanner(h, 'partial upload');
    await flushAsync();

    assert.equal(h.commands.createPlanCalls, 1, 'the plan itself is still saved');
    assert.equal(h.commands.generatePlanCalls, 0, 'the planner must NOT be dispatched');
    const errs = h.toasts.filter((t) => t.kind === 'error');
    assert.equal(errs.length, 1, `expected one error toast; got ${JSON.stringify(h.toasts)}`);
    assert.match(errs[0].message, /spec\.pdf/, 'the failing file is named');
    assert.match(errs[0].message, /NOT started/, 'and the operator is told the planner did not run');
    assert.equal(h.modal.getState(), null, 'the modal closes rather than offering a second create');
});

test('Save & run planner without an uploader wired is unaffected', async () => {
    // Hosts that never wired uploadPlanAttachment see no picker at all;
    // the path must not change shape for them.
    const h = makeHarness();
    h.modal.open('proj-1');
    assert.equal(
        findInput(h.root, 'plan-attachments'),
        null,
        'no picker without an uploader',
    );
    clickSaveAndRunPlanner(h, 'plain');
    await flushAsync();
    assert.equal(h.commands.generatePlanCalls, 1);
});

test('reduceNewPlan: np-brief + plan-created -> np-planning', () => {
    const next = reduceNewPlan(BRIEF, { kind: 'plan-created', planId: 'plan-1' });
    assert.deepEqual(next, {
        kind: 'np-planning',
        projectId: 'proj-1',
        planId: 'plan-1',
        conventions: EMPTY_CONVENTIONS,
    });
});

test('reduceNewPlan: np-planning + plan-draft-ready -> np-plan-review (carries conventions + revision)', () => {
    const planning: NewPlanState = {
        ...PLANNING,
        conventions: SEED_CONVENTIONS,
    } as NewPlanState;
    const next = reduceNewPlan(planning, {
        kind: 'plan-draft-ready',
        planId: 'plan-1',
        markdown: '# m',
        generatedAt: 42,
        revision: 3,
    });
    assert.deepEqual(next, {
        kind: 'np-plan-review',
        projectId: 'proj-1',
        planId: 'plan-1',
        markdown: '# m',
        generatedAt: 42,
        conventions: SEED_CONVENTIONS,
        revision: 3,
    });
});

test('reduceNewPlan: np-planning + planner-failed -> np-error', () => {
    const next = reduceNewPlan(PLANNING, {
        kind: 'planner-failed',
        planId: 'plan-1',
        message: 'kaboom',
    });
    assert.deepEqual(next, {
        kind: 'np-error',
        projectId: 'proj-1',
        planId: 'plan-1',
        message: 'kaboom',
    });
});

test('reduceNewPlan: np-plan-review + approve-requested -> np-decomposing', () => {
    const next = reduceNewPlan(PLAN_REVIEW, { kind: 'approve-requested', planId: 'plan-1' });
    assert.deepEqual(next, {
        kind: 'np-decomposing',
        projectId: 'proj-1',
        planId: 'plan-1',
        revision: undefined,
    });
});

test('reduceNewPlan: np-plan-review + regenerate-requested -> np-planning (preserves conventions)', () => {
    const reviewWithConv: NewPlanState = { ...PLAN_REVIEW, conventions: SEED_CONVENTIONS };
    const next = reduceNewPlan(reviewWithConv, { kind: 'regenerate-requested', planId: 'plan-1' });
    assert.equal(next?.kind, 'np-planning');
    if (next && next.kind === 'np-planning') {
        assert.deepEqual(next.conventions, SEED_CONVENTIONS);
    }
});

test('reduceNewPlan: np-plan-review + reject-requested -> np-rejected', () => {
    const next = reduceNewPlan(PLAN_REVIEW, { kind: 'reject-requested', planId: 'plan-1' });
    assert.deepEqual(next, {
        kind: 'np-rejected',
        projectId: 'proj-1',
        planId: 'plan-1',
    });
});

test('reduceNewPlan: np-decomposing + plan-activated -> np-success', () => {
    const next = reduceNewPlan(DECOMPOSING, { kind: 'plan-activated', planId: 'plan-1' });
    assert.deepEqual(next, {
        kind: 'np-success',
        projectId: 'proj-1',
        planId: 'plan-1',
        revision: undefined,
    });
});

test('reduceNewPlan: np-decomposing + activation-failed -> np-error', () => {
    const next = reduceNewPlan(DECOMPOSING, {
        kind: 'activation-failed',
        planId: 'plan-1',
        message: 'nope',
    });
    assert.deepEqual(next, {
        kind: 'np-error',
        projectId: 'proj-1',
        planId: 'plan-1',
        message: 'nope',
    });
});

test('reduceNewPlan: np-planning + revision-bumped advances the counter monotonically', () => {
    const after2 = reduceNewPlan(PLANNING, { kind: 'revision-bumped', planId: 'plan-1', revision: 2 });
    assert.ok(after2 && after2.kind === 'np-planning');
    if (after2 && after2.kind === 'np-planning') {
        assert.equal(after2.revision, 2);
    }
    const after1 = reduceNewPlan(after2 as NewPlanState, {
        kind: 'revision-bumped',
        planId: 'plan-1',
        revision: 1,
    });
    // Lower revision should not rewind the counter.
    assert.strictEqual(after1, after2);
    const after3 = reduceNewPlan(after2 as NewPlanState, {
        kind: 'revision-bumped',
        planId: 'plan-1',
        revision: 3,
    });
    assert.ok(after3 && after3.kind === 'np-planning');
    if (after3 && after3.kind === 'np-planning') {
        assert.equal(after3.revision, 3);
    }
});

test('reduceNewPlan: stale planId is dropped (np-planning + plan-draft-ready for other plan)', () => {
    const next = reduceNewPlan(PLANNING, {
        kind: 'plan-draft-ready',
        planId: 'plan-OTHER',
        markdown: '# other',
        generatedAt: 1,
    });
    assert.strictEqual(next, PLANNING); // unchanged reference
});

test('reduceNewPlan: terminal states are sticky to ordinary events', () => {
    assert.strictEqual(reduceNewPlan(SUCCESS, { kind: 'plan-created', planId: 'plan-2' }), SUCCESS);
    assert.strictEqual(
        reduceNewPlan(ERROR_STATE, { kind: 'approve-requested', planId: 'plan-1' }),
        ERROR_STATE,
    );
    assert.strictEqual(
        reduceNewPlan(REJECTED, { kind: 'plan-created', planId: 'plan-2' }),
        REJECTED,
    );
});

test('reduceNewPlan: null state stays null on any event except a no-op', () => {
    assert.equal(reduceNewPlan(null, { kind: 'plan-created', planId: 'plan-1' }), null);
    assert.equal(reduceNewPlan(null, { kind: 'error-occurred', message: 'x' }), null);
});

// ---------------------------------------------------------------------------
// Error-from-any-state collapses to np-error
// ---------------------------------------------------------------------------

test('reduceNewPlan: error-occurred collapses every entry-state to np-error', () => {
    const entries: NewPlanState[] = [BRIEF, PLANNING, PLAN_REVIEW, DECOMPOSING];
    for (const entry of entries) {
        const next = reduceNewPlan(entry, {
            kind: 'error-occurred',
            planId: 'planId' in entry ? entry.planId : undefined,
            message: `from-${entry.kind}`,
        });
        assert.ok(next !== null, `${entry.kind}: expected np-error, got null`);
        assert.equal(next?.kind, 'np-error', `${entry.kind}: expected np-error`);
        if (next && next.kind === 'np-error') {
            assert.equal(next.message, `from-${entry.kind}`);
            assert.equal(next.projectId, entry.projectId);
        }
    }
});

test('reduceNewPlan: error-occurred on np-error overwrites the message', () => {
    const next = reduceNewPlan(ERROR_STATE, { kind: 'error-occurred', message: 'newer' });
    assert.ok(next && next.kind === 'np-error');
    assert.equal((next as { message: string }).message, 'newer');
});

// ---------------------------------------------------------------------------
// AC #1 — factory mounts distinct DOM regions per state
// ---------------------------------------------------------------------------

test('open() mounts the panel and renders the np-brief region', () => {
    const h = makeHarness();
    h.modal.open('proj-1');
    const panel = panelOf(h.root);
    assert.equal(panel.attributes.get('data-state'), 'np-brief');
    const body = findFirst(panel, (n) => n.attributes.get('data-state-body') === 'np-brief');
    assert.ok(body, 'np-brief body region present');
    assert.equal(h.overlay.openCalls, 1);
});

test('dispatch(plan-created) advances brief -> planning and renders the spinner region', () => {
    const h = makeHarness();
    h.modal.open('proj-1');
    h.modal.dispatch({ kind: 'plan-created', planId: 'plan-1' });
    const panel = panelOf(h.root);
    assert.equal(panel.attributes.get('data-state'), 'np-planning');
    const body = findFirst(panel, (n) => n.attributes.get('data-state-body') === 'np-planning');
    assert.ok(body, 'np-planning body region present');
});

test('dispatch(plan-draft-ready) renders Approve / Regenerate / Reject buttons', () => {
    const h = makeHarness();
    h.modal.open('proj-1');
    h.modal.dispatch({ kind: 'plan-created', planId: 'plan-1' });
    h.modal.dispatch({
        kind: 'plan-draft-ready',
        planId: 'plan-1',
        markdown: '# my plan',
        generatedAt: 1,
    });
    const panel = panelOf(h.root);
    assert.equal(panel.attributes.get('data-state'), 'np-plan-review');
    assert.ok(findButton(panel, 'approve'), 'Approve button rendered');
    assert.ok(findButton(panel, 'regenerate'), 'Regenerate button rendered');
    assert.ok(findButton(panel, 'reject'), 'Reject button rendered');
});

test('np-plan-review renders the markdown body in an editable textarea', () => {
    const h = makeHarness();
    h.modal.open('proj-1');
    h.modal.dispatch({ kind: 'plan-created', planId: 'plan-1' });
    h.modal.dispatch({
        kind: 'plan-draft-ready',
        planId: 'plan-1',
        markdown: '# editable',
        generatedAt: 1,
    });
    const panel = panelOf(h.root);
    const editor = findInput(panel, 'plan-markdown') as ShimElement;
    assert.ok(editor, 'plan-markdown editor rendered');
    assert.equal(editor.tagName, 'textarea');
    assert.equal(editor.value, '# editable');
});

// ---------------------------------------------------------------------------
// AC #5 — Reject closes the modal without further dispatch
// ---------------------------------------------------------------------------

test('Reject button closes the modal and does not dispatch a command', () => {
    const h = makeHarness();
    h.modal.open('proj-1');
    h.modal.dispatch({ kind: 'plan-created', planId: 'plan-1' });
    h.modal.dispatch({
        kind: 'plan-draft-ready',
        planId: 'plan-1',
        markdown: '# my plan',
        generatedAt: 1,
    });
    const panel = panelOf(h.root);
    const btn = findButton(panel, 'reject') as ShimElement;
    btn.onclick?.();
    assert.equal(h.modal.getState(), null);
    assert.equal(h.overlay.closeCalls, 1);
    assert.equal(h.commands.updatePlanCalls, 0);
    assert.equal(h.planReview.approveCalls, 0);
    assert.equal(h.planReview.regenerateCalls, 0);
});

// ---------------------------------------------------------------------------
// AC #2 — Conventions sub-form seeding from project.plan_defaults
// ---------------------------------------------------------------------------

test('open() with planDefaults seeds the conventions sub-form inputs (AC #2)', () => {
    const h = makeHarness();
    h.modal.open('proj-1', { planDefaults: SEED_CONVENTIONS });
    const panel = panelOf(h.root);
    for (const field of PLAN_CONVENTION_FIELDS) {
        const input = findInput(panel, `conventions.${field}`) as ShimElement;
        assert.ok(input, `conventions.${field} input rendered`);
        assert.equal(input.value, SEED_CONVENTIONS[field]);
    }
});

test('open() without planDefaults renders blank conventions inputs', () => {
    const h = makeHarness();
    h.modal.open('proj-1');
    const panel = panelOf(h.root);
    for (const field of PLAN_CONVENTION_FIELDS) {
        const input = findInput(panel, `conventions.${field}`) as ShimElement;
        assert.ok(input, `conventions.${field} input rendered`);
        assert.equal(input.value, '');
    }
});

test('submitCreatePlan() forwards the (edited) conventions block to createPlan', async () => {
    const h = makeHarness();
    h.modal.open('proj-1', { planDefaults: SEED_CONVENTIONS });
    const panel = panelOf(h.root);
    // Operator edits one field then clicks "Create plan".
    const ns = findInput(panel, 'conventions.namespace_root') as ShimElement;
    ns.value = 'pkg.changed';
    ns.oninput?.();
    const title = findInput(panel, 'title') as ShimElement;
    title.value = 'My plan';
    const submit = findButton(panel, 'submit') as ShimElement;
    submit.onclick?.();
    // Drain the createPlan promise.
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(h.commands.createPlanCalls, 1);
    assert.deepEqual(h.commands.lastCreateInput?.conventions, {
        namespace_root: 'pkg.changed',
        test_framework: SEED_CONVENTIONS.test_framework,
        branch_pattern: SEED_CONVENTIONS.branch_pattern,
        commit_pattern: SEED_CONVENTIONS.commit_pattern,
    });
});

// ---------------------------------------------------------------------------
// AC #3 — Approve POSTs to .../approve with conventions + content
// ---------------------------------------------------------------------------

test('Approve dispatches planReview.approvePlan with the latest content + conventions (AC #3)', async () => {
    const h = makeHarness();
    h.modal.open('proj-1', { planDefaults: SEED_CONVENTIONS });
    await h.modal.submitCreatePlan({ title: 'My plan', conventions: SEED_CONVENTIONS });
    h.projection.emit('plan-1', {
        kind: 'plan-draft-ready',
        planId: 'plan-1',
        markdown: '# initial',
        generatedAt: 1,
        revision: 1,
    });
    const panel = panelOf(h.root);
    // Operator edits the markdown in the textarea before approving.
    const editor = findInput(panel, 'plan-markdown') as ShimElement;
    editor.value = '# edited body';
    editor.oninput?.();
    const approve = findButton(panel, 'approve') as ShimElement;
    approve.onclick?.();
    // Approve goes through dispatch -> async planReview.approvePlan.
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(h.planReview.approveCalls, 1);
    assert.equal(h.planReview.lastApproveBody?.content, '# edited body');
    assert.deepEqual(h.planReview.lastApproveBody?.conventions, SEED_CONVENTIONS);
    assert.equal(h.commands.updatePlanCalls, 0, 'approve must not call updatePlan');
    assert.equal(h.modal.getState()?.kind, 'np-success');
});

test('Approve is a no-op when the textarea is cleared (empty-body guard)', async () => {
    const h = makeHarness();
    h.modal.open('proj-1', { planDefaults: SEED_CONVENTIONS });
    await h.modal.submitCreatePlan({ title: 'My plan', conventions: SEED_CONVENTIONS });
    h.projection.emit('plan-1', {
        kind: 'plan-draft-ready',
        planId: 'plan-1',
        markdown: '# initial',
        generatedAt: 1,
        revision: 1,
    });
    const panel = panelOf(h.root);
    // Operator clears the textarea (whitespace-only) and then clicks Approve.
    const editor = findInput(panel, 'plan-markdown') as ShimElement;
    editor.value = '   ';
    editor.oninput?.();
    const toastsBefore = h.toasts.length;
    const approve = findButton(panel, 'approve') as ShimElement;
    approve.onclick?.();
    // Drain any microtasks the click might have scheduled.
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(h.planReview.approveCalls, 0, 'approve must not POST when body is empty');
    assert.equal(h.modal.getState()?.kind, 'np-plan-review', 'state stays np-plan-review');
    assert.equal(h.toasts.length, toastsBefore + 1, 'one error toast surfaces');
    assert.equal(h.toasts[h.toasts.length - 1]?.kind, 'error');
});

// ---------------------------------------------------------------------------
// AC #4 — Regenerate reveals feedback textarea, POSTs feedback
// ---------------------------------------------------------------------------

test('Regenerate first click reveals a feedback textarea (AC #4)', () => {
    const h = makeHarness();
    h.modal.open('proj-1');
    h.modal.dispatch({ kind: 'plan-created', planId: 'plan-1' });
    h.modal.dispatch({
        kind: 'plan-draft-ready',
        planId: 'plan-1',
        markdown: '# m',
        generatedAt: 1,
    });
    let panel = panelOf(h.root);
    assert.equal(findInput(panel, 'feedback'), null, 'feedback textarea hidden before regenerate click');
    const regen = findButton(panel, 'regenerate') as ShimElement;
    regen.onclick?.();
    panel = panelOf(h.root);
    const fb = findInput(panel, 'feedback') as ShimElement;
    assert.ok(fb, 'feedback textarea revealed after first regenerate click');
    assert.equal(fb.tagName, 'textarea');
    assert.equal(h.planReview.regenerateCalls, 0, 'first click does not POST yet');
});

test('Regenerate-with-feedback POSTs the operator feedback (AC #4)', async () => {
    const h = makeHarness();
    h.modal.open('proj-1');
    await h.modal.submitCreatePlan({ title: 'My plan' });
    h.projection.emit('plan-1', {
        kind: 'plan-draft-ready',
        planId: 'plan-1',
        markdown: '# m',
        generatedAt: 1,
        revision: 1,
    });
    let panel = panelOf(h.root);
    // First click reveals the textarea.
    (findButton(panel, 'regenerate') as ShimElement).onclick?.();
    panel = panelOf(h.root);
    // Type feedback into the textarea, then click submit.
    const fb = findInput(panel, 'feedback') as ShimElement;
    fb.value = 'Please cover edge case Q.';
    fb.oninput?.();
    const submit = findButton(panel, 'regenerate-submit') as ShimElement;
    submit.onclick?.();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(h.planReview.regenerateCalls, 1);
    assert.deepEqual(h.planReview.lastRegenerateBody, { feedback: 'Please cover edge case Q.' });
    assert.equal(h.modal.getState()?.kind, 'np-planning');
});

test('Regenerate without feedback POSTs an undefined body', async () => {
    const h = makeHarness();
    h.modal.open('proj-1');
    await h.modal.submitCreatePlan({ title: 'My plan' });
    h.projection.emit('plan-1', {
        kind: 'plan-draft-ready',
        planId: 'plan-1',
        markdown: '# m',
        generatedAt: 1,
    });
    await h.modal.regenerate();
    assert.equal(h.planReview.regenerateCalls, 1);
    assert.equal(h.planReview.lastRegenerateBody, undefined);
});

// ---------------------------------------------------------------------------
// AC #6 — Revision counter updates from decompose-status
// ---------------------------------------------------------------------------

test('Revision counter renders in np-planning when decompose-status surfaces a revision (AC #6)', async () => {
    const h = makeHarness();
    h.modal.open('proj-1');
    await h.modal.submitCreatePlan({ title: 'My plan' });
    // First poll: revision 1.
    h.planReview.decomposeRevision = 1;
    await h.modal.pollOnce();
    let panel = panelOf(h.root);
    assert.equal(panel.attributes.get('data-revision'), '1');
    const rev1 = findFirst(panel, (n) => n.attributes.get('data-revision-label') === '');
    assert.ok(rev1, 'revision label rendered');
    assert.equal(rev1?.textContent, 'Revision 1');
    // Second poll: revision 3.
    h.planReview.decomposeRevision = 3;
    await h.modal.pollOnce();
    panel = panelOf(h.root);
    assert.equal(panel.attributes.get('data-revision'), '3');
    // Third poll with a lower revision should NOT rewind the counter.
    h.planReview.decomposeRevision = 2;
    await h.modal.pollOnce();
    panel = panelOf(h.root);
    assert.equal(panel.attributes.get('data-revision'), '3');
});

test('Revision counter carries from np-planning into np-plan-review', async () => {
    const h = makeHarness();
    h.modal.open('proj-1');
    await h.modal.submitCreatePlan({ title: 'My plan' });
    h.planReview.decomposeRevision = 4;
    h.planReview.decomposeStatus = 'complete';
    h.planReview.draftRevision = 4;
    await h.modal.pollOnce();
    const panel = panelOf(h.root);
    assert.equal(panel.attributes.get('data-state'), 'np-plan-review');
    assert.equal(panel.attributes.get('data-revision'), '4');
});

// ---------------------------------------------------------------------------
// Projection subscription wiring
// ---------------------------------------------------------------------------

test('projection.subscribe is called on entry to np-planning', async () => {
    const h = makeHarness();
    h.modal.open('proj-1');
    await h.modal.submitCreatePlan({ title: 'My plan' });
    assert.equal(h.projection.subscribeCalls, 1);
    assert.ok(h.projection.listeners.get('plan-1')?.size === 1);
});

test('projection events flow through the reducer and update the state', async () => {
    const h = makeHarness();
    h.modal.open('proj-1');
    await h.modal.submitCreatePlan({ title: 'My plan' });
    h.projection.emit('plan-1', {
        kind: 'plan-draft-ready',
        planId: 'plan-1',
        markdown: '# from-projection',
        generatedAt: 999,
        revision: 2,
    });
    const state = h.modal.getState();
    assert.ok(state && state.kind === 'np-plan-review');
    if (state && state.kind === 'np-plan-review') {
        assert.equal(state.markdown, '# from-projection');
        assert.equal(state.generatedAt, 999);
        assert.equal(state.revision, 2);
    }
});

test('projection planner-failed event surfaces an error toast and transitions to np-error', async () => {
    const h = makeHarness();
    h.modal.open('proj-1');
    await h.modal.submitCreatePlan({ title: 'My plan' });
    h.projection.emit('plan-1', {
        kind: 'planner-failed',
        planId: 'plan-1',
        message: 'planner crashed',
    });
    const state = h.modal.getState();
    assert.ok(state && state.kind === 'np-error');
    if (state && state.kind === 'np-error') {
        assert.equal(state.message, 'planner crashed');
    }
    assert.equal(h.toasts.length, 1);
    assert.equal(h.toasts[0]?.kind, 'error');
});

test('projection plan-activated event during np-decomposing transitions to np-success', async () => {
    const h = makeHarness();
    h.modal.open('proj-1');
    await h.modal.submitCreatePlan({ title: 'My plan' });
    h.projection.emit('plan-1', {
        kind: 'plan-draft-ready',
        planId: 'plan-1',
        markdown: '# m',
        generatedAt: 1,
    });
    h.modal.dispatch({ kind: 'approve-requested', planId: 'plan-1' });
    assert.equal(h.modal.getState()?.kind, 'np-decomposing');
    h.projection.emit('plan-1', { kind: 'plan-activated', planId: 'plan-1' });
    assert.equal(h.modal.getState()?.kind, 'np-success');
});

test('close() unsubscribes the projection listener', async () => {
    const h = makeHarness();
    h.modal.open('proj-1');
    await h.modal.submitCreatePlan({ title: 'My plan' });
    assert.equal(h.projection.subscribeCalls, 1);
    h.modal.close();
    assert.equal(h.projection.unsubscribeCalls, 1);
    assert.equal(h.projection.listeners.get('plan-1')?.size ?? 0, 0);
});

// ---------------------------------------------------------------------------
// Approve / Regenerate button wiring end-to-end
// ---------------------------------------------------------------------------

test('Approve transitions through np-decomposing and lands at np-success', async () => {
    const h = makeHarness();
    h.modal.open('proj-1');
    await h.modal.submitCreatePlan({ title: 'My plan' });
    h.projection.emit('plan-1', {
        kind: 'plan-draft-ready',
        planId: 'plan-1',
        markdown: '# m',
        generatedAt: 1,
    });
    const promise = h.modal.approvePlan();
    assert.equal(h.modal.getState()?.kind, 'np-decomposing');
    await promise;
    assert.equal(h.planReview.approveCalls, 1);
    assert.equal(h.modal.getState()?.kind, 'np-success');
});

test('Regenerate factory call (without a feedback arg) re-enters np-planning', async () => {
    const h = makeHarness();
    h.modal.open('proj-1');
    await h.modal.submitCreatePlan({ title: 'My plan' });
    h.projection.emit('plan-1', {
        kind: 'plan-draft-ready',
        planId: 'plan-1',
        markdown: '# m',
        generatedAt: 1,
    });
    await h.modal.regenerate();
    assert.equal(h.planReview.regenerateCalls, 1);
    assert.equal(h.modal.getState()?.kind, 'np-planning');
});
