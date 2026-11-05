/**
 * Unit tests for the AP-PAO-014 new-project modal command-bus dispatch.
 *
 * Scope (AC #5): the modal's submit() path calls the
 * {@link NewProjectCommandSink.createProject} port with the validated V1
 * payload and transitions np-ready -> np-submitting -> np-created on a
 * successful dispatch. The complementary failure paths (validation
 * short-circuit + sink rejection -> np-error + error toast) are covered
 * here too because they share the same dispatch site and would regress
 * silently if the wiring layer started swallowing rejections.
 *
 * The dispatch wiring itself (board.ts -> sendCommand({ type:
 * 'CreateProject' })) is exercised end-to-end by the parity-smoke suite;
 * these tests stay at the modal boundary by injecting a fake sink.
 *
 * Dual-runner discovery — same shim as the sibling new-plan.test.ts:
 * vitest when VITEST=true, node:test otherwise. A single source file is
 * discovered + executed by both `npm test` and `npx vitest run`.
 */
import * as assert from 'node:assert/strict';

import {
    createNewProjectModal,
    type CreateProjectInput,
    type ModalDocument,
    type ModalElement,
    type NewProjectCommandSink,
    type NewProjectDeps,
    type NewProjectModalHandle,
    type OverlayManagerLike,
    type ToastInput,
} from './new-project';

// ---------------------------------------------------------------------------
// Dual-runner test() shim
// ---------------------------------------------------------------------------

type TestFn = (name: string, fn: () => void | Promise<void>) => void;

const test: TestFn = (((): TestFn => {
    if (process.env.VITEST) {
        const gt = (globalThis as { test?: TestFn }).test;
        if (typeof gt !== 'function') {
            throw new Error(
                'new-project.test.ts: VITEST=true but globalThis.test is missing — '
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
// Minimal DOM shim — same shape as new-plan.test.ts / project-form-fields.test.ts
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
        getElementById: (id: string): ModalElement | null =>
            id === 'overlay-root' ? root : null,
        createElement: (tag: string): ModalElement => makeShimElement(tag),
    };
    return { doc, root };
}

// ---------------------------------------------------------------------------
// Fake ports
// ---------------------------------------------------------------------------

interface FakeCommandSink extends NewProjectCommandSink {
    calls: CreateProjectInput[];
    nextProjectId: string | null;
    shouldReject: Error | null;
}

function makeFakeCommands(): FakeCommandSink {
    const sink: FakeCommandSink = {
        calls: [],
        nextProjectId: null,
        shouldReject: null,
        async createProject(input): Promise<{ readonly projectId: string }> {
            sink.calls.push({ ...input, repos: [...input.repos] });
            if (sink.shouldReject) throw sink.shouldReject;
            return { projectId: sink.nextProjectId ?? input.projectId };
        },
    };
    return sink;
}

function makeFakeOverlayManager(): OverlayManagerLike & {
    openCalls: number;
    closeCalls: number;
} {
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

interface Harness {
    readonly modal: NewProjectModalHandle;
    readonly commands: FakeCommandSink;
    readonly overlay: ReturnType<typeof makeFakeOverlayManager>;
    readonly toasts: ToastInput[];
    readonly root: ShimElement;
}

function makeHarness(extra?: Partial<NewProjectDeps>): Harness {
    const { doc, root } = makeShimDocument();
    const commands = makeFakeCommands();
    const overlay = makeFakeOverlayManager();
    const toasts: ToastInput[] = [];
    const deps: NewProjectDeps = {
        overlayManager: overlay,
        commands,
        showToast: (input) => toasts.push(input),
        doc,
        ...extra,
    };
    const modal = createNewProjectModal(deps);
    return { modal, commands, overlay, toasts, root };
}

// ---------------------------------------------------------------------------
// AC #5 — valid submit dispatches createProject via the command sink
// ---------------------------------------------------------------------------

test('submit({valid snapshot}) dispatches createProject with the full V1 payload', async () => {
    const h = makeHarness();
    h.modal.open();
    await h.modal.submit({
        projectId: 'shop',
        name: 'Shop',
        abbr: 'LDP',
        description: 'Loan workflow project',
        color: '#7c6af7',
        repos: [{ id: 'web', name: 'Web', url: 'https://example.com/web.git' }],
    });
    assert.equal(h.commands.calls.length, 1);
    const call = h.commands.calls[0];
    assert.equal(call.projectId, 'shop');
    assert.equal(call.name, 'Shop');
    assert.equal(call.abbr, 'LDP');
    assert.equal(call.description, 'Loan workflow project');
    assert.equal(call.color, '#7c6af7');
    assert.deepEqual(call.repos, [
        { id: 'web', name: 'Web', url: 'https://example.com/web.git' },
    ]);
});

test('submit() transitions np-ready -> np-submitting -> np-created on success', async () => {
    const h = makeHarness();
    h.modal.open();
    h.commands.nextProjectId = 'shop';
    const promise = h.modal.submit({
        projectId: 'shop',
        name: 'Shop',
        repos: [],
    });
    const inFlight = h.modal.getState();
    assert.ok(inFlight && inFlight.kind === 'np-submitting');
    await promise;
    const settled = h.modal.getState();
    assert.ok(settled && settled.kind === 'np-created');
    if (settled.kind === 'np-created') {
        assert.equal(settled.projectId, 'shop');
        assert.equal(settled.name, 'Shop');
    }
});

test('submit() filters partial repo rows (missing id or url) before dispatch', async () => {
    const h = makeHarness();
    h.modal.open();
    await h.modal.submit({
        projectId: 'shop',
        name: 'Shop',
        repos: [
            { id: 'web', name: 'Web', url: 'https://example.com/web.git' },
            { id: '', name: 'Empty id', url: 'https://example.com/x.git' },
            { id: 'no-url', name: 'No URL', url: '' },
        ],
    });
    assert.equal(h.commands.calls.length, 1);
    assert.deepEqual(h.commands.calls[0].repos, [
        { id: 'web', name: 'Web', url: 'https://example.com/web.git' },
    ]);
});

// ---------------------------------------------------------------------------
// Validation short-circuit — no dispatch on missing id / title
// ---------------------------------------------------------------------------

test('submit() with missing projectId surfaces an error toast and does not dispatch', async () => {
    const h = makeHarness();
    h.modal.open();
    await h.modal.submit({ projectId: '', name: 'Shop', repos: [] });
    assert.equal(h.commands.calls.length, 0);
    assert.equal(h.toasts.length, 1);
    assert.equal(h.toasts[0]?.kind, 'error');
    assert.equal(h.toasts[0]?.message, 'ID and title are required');
    assert.equal(h.modal.getState()?.kind, 'np-ready');
});

test('submit() with missing name surfaces an error toast and does not dispatch', async () => {
    const h = makeHarness();
    h.modal.open();
    await h.modal.submit({ projectId: 'shop', name: '', repos: [] });
    assert.equal(h.commands.calls.length, 0);
    assert.equal(h.toasts.length, 1);
    assert.equal(h.toasts[0]?.kind, 'error');
    assert.equal(h.modal.getState()?.kind, 'np-ready');
});

// ---------------------------------------------------------------------------
// Failure path — sink rejection transitions to np-error + toast
// ---------------------------------------------------------------------------

test('submit() rejection transitions to np-error and surfaces the error message', async () => {
    const h = makeHarness();
    h.modal.open();
    h.commands.shouldReject = new Error('command bus down');
    await h.modal.submit({
        projectId: 'shop',
        name: 'Shop',
        repos: [],
    });
    const state = h.modal.getState();
    assert.ok(state && state.kind === 'np-error');
    if (state.kind === 'np-error') {
        assert.equal(state.message, 'command bus down');
    }
    assert.equal(h.toasts.length, 1);
    assert.equal(h.toasts[0]?.kind, 'error');
    assert.equal(h.toasts[0]?.message, 'command bus down');
});

test('submit() outside np-ready throws (closed modal)', async () => {
    const h = makeHarness();
    await assert.rejects(
        () => h.modal.submit({ projectId: 'shop', name: 'Shop', repos: [] }),
        /requires np-ready state/,
    );
    assert.equal(h.commands.calls.length, 0);
});

// ---------------------------------------------------------------------------
// AC #4 — sidebar entry point: open() mounts the panel + registers overlay
// ---------------------------------------------------------------------------

test('open() mounts the panel under #overlay-root and registers with the overlay manager', () => {
    const h = makeHarness();
    h.modal.open();
    assert.equal(h.root.children.length, 1);
    assert.equal(h.overlay.openCalls, 1);
    assert.equal(h.modal.getState()?.kind, 'np-ready');
});
