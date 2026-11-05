/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Unit tests for the AP-IFB-005 edit-project modal.
 *
 * Coverage targets the task's acceptance criteria:
 *   AC #1 open() mounts the panel under #overlay-root and registers
 *         with the overlay-manager via openOverlay('edit-project', el).
 *   AC #2 ep-ready pre-populates every field (name, abbr, id/slug,
 *         description, color, repos) from the project passed in.
 *   AC #3 submit() dispatches updateProject through the command sink
 *         carrying both originalProjectId (lookup key) and the
 *         possibly-edited projectId, and transitions ep-ready →
 *         ep-submitting → ep-updated.
 *   AC #4 hosts/board-ui/index.html registers
 *         <template id="edit-project-modal-template"> with the seven
 *         V1 swatch hex values.
 *   AC #5 the shared swatch/repo-rows helpers (project-form-fields)
 *         are used — the rendered DOM exposes the same `data-swatch`
 *         and `data-repo-row` markers as new-project, asserted by
 *         re-using the seven-swatch row check.
 *
 * Dual-runner discovery — same pattern as new-project.spec.ts: vitest
 * when VITEST=true, node:test otherwise.
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    EDIT_PROJECT_OVERLAY_ID,
    EDIT_PROJECT_TEMPLATE_ID,
    PROJECT_COLOR_SWATCHES,
    createEditProjectModal,
    type EditProjectCommandSink,
    type EditProjectInput,
    type EditProjectModalHandle,
    type ModalDocument,
    type ModalElement,
    type OverlayManagerLike,
    type ShowToastFn,
    type ToastInput,
    type UpdateProjectInput,
} from '../../../hosts/board-ui/client/modals/edit-project';

// ---------------------------------------------------------------------------
// Dual-runner test() shim — mirrors new-project.spec.ts
// ---------------------------------------------------------------------------

type TestFn = (name: string, fn: () => void | Promise<void>) => void;

const test: TestFn = (((): TestFn => {
    if (process.env.VITEST) {
        const gt = (globalThis as { test?: TestFn }).test;
        if (typeof gt !== 'function') {
            throw new Error(
                'edit-project.spec.ts: VITEST=true but globalThis.test is missing — '
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
// Minimal DOM shim — same shape as new-project.spec.ts so the two
// modal suites speak the same language.
// ---------------------------------------------------------------------------

interface ShimElement extends ModalElement {
    readonly tagName: string;
    readonly children: ShimElement[];
    readonly attributes: Map<string, string>;
    parent: ShimElement | null;
    removed: boolean;
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

function findAll(
    root: ShimElement,
    predicate: (el: ShimElement) => boolean,
    out: ShimElement[] = [],
): ShimElement[] {
    if (predicate(root)) out.push(root);
    for (const c of root.children) findAll(c, predicate, out);
    return out;
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

/**
 * The panel, found by its marker attribute rather than by position.
 *
 * This used to return `overlayRoot.children[0]`, and the modal later
 * gained a BACKDROP wrapper (`root -> backdrop -> panel`) so the panel
 * would be centered and the page dimmed. `children[0]` became the
 * backdrop, every `panel.attributes.get(...)` came back undefined, and
 * these specs went red and stayed red — the helper was pinned to a DOM
 * shape, not to the thing it was looking for.
 */
function panelEl(overlayRoot: ShimElement): ShimElement {
    const found = findByAttribute(overlayRoot, 'data-edit-project-modal');
    if (!found) {
        throw new Error(
            'expected a [data-edit-project-modal] panel under overlay-root, found none',
        );
    }
    return found;
}

/** Depth-first search for the first descendant carrying `attr`. */
function findByAttribute(root: ShimElement, attr: string): ShimElement | null {
    for (const child of root.children) {
        if (child.attributes.has(attr)) return child;
        const nested = findByAttribute(child, attr);
        if (nested) return nested;
    }
    return null;
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

interface FakeCommands extends EditProjectCommandSink {
    readonly calls: UpdateProjectInput[];
    nextProjectId: string | null;
    updateProjectShouldReject: Error | null;
    updateProjectBlocker: Promise<void> | null;
}

function makeCommands(): FakeCommands {
    const sink: FakeCommands = {
        calls: [],
        nextProjectId: null,
        updateProjectShouldReject: null,
        updateProjectBlocker: null,
        async updateProject(input): Promise<{ projectId: string }> {
            sink.calls.push({ ...input, repos: [...input.repos] });
            if (sink.updateProjectBlocker) await sink.updateProjectBlocker;
            if (sink.updateProjectShouldReject) throw sink.updateProjectShouldReject;
            return { projectId: sink.nextProjectId ?? input.projectId };
        },
    };
    return sink;
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Harness {
    readonly modal: EditProjectModalHandle;
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
    const modal = createEditProjectModal({
        doc: shim.doc,
        mountRoot: overrides?.mountRoot,
        overlayManager: overlay,
        showToast: toast.fn,
        commands,
    });
    return { modal, shim, overlay, toast, commands };
}

function sampleProject(overrides?: Partial<EditProjectInput>): EditProjectInput {
    return {
        projectId: 'shop',
        name: 'Shop',
        abbr: 'LDP',
        description: 'Loan management',
        color: '#7c6af7',
        repos: [
            { id: 'web', name: 'Web app', url: 'https://github.com/org/web.git' },
            { id: 'api', url: 'https://github.com/org/api.git' },
        ],
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// AC #1 — open() mounts under #overlay-root and registers with manager
// ---------------------------------------------------------------------------

test('open() mounts a panel under #overlay-root and registers it with the overlay manager', () => {
    const h = setup();
    h.modal.open(sampleProject());

    // root -> backdrop -> panel. The backdrop is what gives the panel
    // `position: fixed`, centres it and dims the page; without it the
    // panel sits in document flow and stops reading as a modal. Pinned
    // here because `panelEl` now finds the panel by marker, so losing
    // the wrapper would otherwise go unnoticed.
    assert.equal(h.shim.overlayRoot.children.length, 1);
    const backdrop = h.shim.overlayRoot.children[0]!;
    assert.ok(
        backdrop.attributes.has('data-edit-project-overlay'),
        'the single child of overlay-root must be the backdrop',
    );
    const panel = panelEl(h.shim.overlayRoot);
    assert.equal(backdrop.children[0], panel, 'the panel sits inside the backdrop');
    assert.equal(panel.attributes.get('data-edit-project-modal'), '');
    assert.equal(panel.attributes.get('role'), 'dialog');
    assert.equal(panel.attributes.get('aria-modal'), 'true');
    assert.equal(panel.attributes.get('data-project-id'), 'shop');

    assert.equal(h.overlay.opened.length, 1);
    assert.equal(h.overlay.opened[0].id, EDIT_PROJECT_OVERLAY_ID);
    assert.equal(h.overlay.opened[0].element, panel);

    const state = h.modal.getState();
    assert.ok(state && state.kind === 'ep-ready');
    assert.equal(state.originalProjectId, 'shop');
    assert.equal(panel.attributes.get('data-state'), 'ep-ready');
});

test('open() prefers an explicit mountRoot over the default #overlay-root', () => {
    const customRoot = makeShimElement('div');
    const h = setup({ mountRoot: customRoot });
    h.modal.open(sampleProject());
    assert.equal(customRoot.children.length, 1);
    assert.equal(h.shim.overlayRoot.children.length, 0);
});

test('open() rejects a project with a missing projectId or name', () => {
    const h = setup();
    assert.throws(() => h.modal.open({ projectId: '', name: 'ok' } as EditProjectInput));
    assert.throws(() => h.modal.open({ projectId: 'ok', name: '' } as EditProjectInput));
});

test('close() detaches the panel, calls overlay-manager.closeOverlay, and clears state', () => {
    const h = setup();
    h.modal.open(sampleProject());
    h.modal.close();
    assert.equal(h.shim.overlayRoot.children.length, 0);
    assert.deepEqual(h.overlay.closed, [EDIT_PROJECT_OVERLAY_ID]);
    assert.equal(h.modal.getState(), null);
});

test('re-opening tears down the previous panel before mounting a fresh one', () => {
    const h = setup();
    h.modal.open(sampleProject());
    h.modal.open(sampleProject({ projectId: 'second', name: 'Second' }));
    assert.equal(h.shim.overlayRoot.children.length, 1);
    assert.deepEqual(h.overlay.closed, [EDIT_PROJECT_OVERLAY_ID]);
    assert.equal(h.overlay.opened.length, 2);
    const panel = panelEl(h.shim.overlayRoot);
    assert.equal(panel.attributes.get('data-project-id'), 'second');
});

// ---------------------------------------------------------------------------
// AC #2 — pre-population from the supplied project
// ---------------------------------------------------------------------------

test('ep-ready pre-populates name, abbr, id/slug, description from the project', () => {
    const h = setup();
    h.modal.open(sampleProject());
    const panel = panelEl(h.shim.overlayRoot);
    const body = bodyForState(panel, 'ep-ready');

    const valueOf = (field: string): string | undefined => {
        const el = findFirst(body, (n) => n.attributes.get('data-input') === field);
        return el?.value;
    };

    assert.equal(valueOf('name'), 'Shop');
    assert.equal(valueOf('abbr'), 'LDP');
    assert.equal(valueOf('id'), 'shop');
    assert.equal(valueOf('description'), 'Loan management');
});

test('ep-ready pre-populates the colour swatch selection', () => {
    const h = setup();
    h.modal.open(sampleProject({ color: '#34d399' }));
    assert.equal(h.modal.getSelectedColor(), '#34d399');

    const panel = panelEl(h.shim.overlayRoot);
    const swatches = findAll(panel, (n) => n.attributes.has('data-swatch'));
    const selected = swatches.filter((s) => s.attributes.get('aria-pressed') === 'true');
    assert.equal(selected.length, 1);
    assert.equal(selected[0].attributes.get('data-swatch'), '#34d399');
});

test('ep-ready pre-populates one repo row per existing repo', () => {
    const h = setup();
    h.modal.open(sampleProject());
    const panel = panelEl(h.shim.overlayRoot);
    const reposContainer = findFirst(panel, (n) => n.attributes.has('data-repos'));
    assert.ok(reposContainer);
    assert.equal(reposContainer.children.length, 2);

    const rows = h.modal.getRepoRows();
    assert.equal(rows.length, 2);
    assert.equal(rows[0].id, 'web');
    assert.equal(rows[0].name, 'Web app');
    assert.equal(rows[0].url, 'https://github.com/org/web.git');
    assert.equal(rows[1].id, 'api');
    assert.equal(rows[1].name, undefined);
    assert.equal(rows[1].url, 'https://github.com/org/api.git');
});

test('ep-ready handles a project with no repos / no color / no description', () => {
    const h = setup();
    h.modal.open({ projectId: 'bare', name: 'Bare project' });
    const panel = panelEl(h.shim.overlayRoot);
    const reposContainer = findFirst(panel, (n) => n.attributes.has('data-repos'));
    assert.ok(reposContainer);
    assert.equal(reposContainer.children.length, 0);
    assert.equal(h.modal.getSelectedColor(), null);
    assert.equal(h.modal.getRepoRows().length, 0);
});

// ---------------------------------------------------------------------------
// AC #5 — shared swatch helper renders the seven V1 swatches in order
// ---------------------------------------------------------------------------

test('ep-ready renders exactly seven swatches with the V1 hex values in order', () => {
    const h = setup();
    h.modal.open(sampleProject());
    const panel = panelEl(h.shim.overlayRoot);
    const swatches = findAll(panel, (n) => n.attributes.has('data-swatch'));
    assert.equal(swatches.length, 7);
    const hexes = swatches.map((s) => s.attributes.get('data-swatch'));
    assert.deepEqual(hexes, [
        '#7c6af7',
        '#38bdf8',
        '#34d399',
        '#fbbf24',
        '#f87171',
        '#c084fc',
        '#fb923c',
    ]);
});

test('clicking a swatch button overrides the initial selection', () => {
    const h = setup();
    h.modal.open(sampleProject({ color: '#7c6af7' }));
    const panel = panelEl(h.shim.overlayRoot);
    const swatches = findAll(panel, (n) => n.attributes.has('data-swatch'));
    swatches[3].onclick?.(); // #fbbf24
    assert.equal(h.modal.getSelectedColor(), '#fbbf24');
});

test('addRepoRow appends a row with id, name, url inputs + a remove button', () => {
    const h = setup();
    h.modal.open({ projectId: 'p', name: 'P' });
    h.modal.addRepoRow();

    const panel = panelEl(h.shim.overlayRoot);
    const reposContainer = findFirst(panel, (n) => n.attributes.has('data-repos'));
    assert.ok(reposContainer);
    assert.equal(reposContainer.children.length, 1);

    const firstRow = reposContainer.children[0];
    for (const field of ['id', 'name', 'url']) {
        const el = findFirst(firstRow, (n) => n.attributes.get('data-field') === field);
        assert.ok(el, `missing repo-row field "${field}"`);
    }
    const removeBtn = findFirst(
        firstRow,
        (n) => n.attributes.get('data-action') === 'remove-repo',
    );
    assert.ok(removeBtn, 'remove button missing on a repo row');
});

test('the remove button on a repo row removes only that row', () => {
    const h = setup();
    h.modal.open(sampleProject()); // pre-populated with 2 rows
    h.modal.addRepoRow(); // 3 rows total

    const panel = panelEl(h.shim.overlayRoot);
    const reposContainer = findFirst(panel, (n) => n.attributes.has('data-repos'));
    if (!reposContainer) throw new Error('missing repos container');
    assert.equal(reposContainer.children.length, 3);

    // Remove the middle row (the second pre-populated repo).
    const middleRow = reposContainer.children[1];
    const removeBtn = findFirst(
        middleRow,
        (n) => n.attributes.get('data-action') === 'remove-repo',
    );
    removeBtn?.onclick?.();

    assert.equal(reposContainer.children.length, 2);
    const remaining = h.modal.getRepoRows();
    assert.equal(remaining.length, 2);
    assert.equal(remaining[0].id, 'web');
    assert.equal(remaining[1].id, '');
});

// ---------------------------------------------------------------------------
// AC #3 — submit dispatches updateProject and transitions states
// ---------------------------------------------------------------------------

test('submit dispatches updateProject with originalProjectId + the full payload', async () => {
    const h = setup();
    h.modal.open(sampleProject());

    await h.modal.submit({
        projectId: 'shop',
        name: 'Shop renamed',
        abbr: 'LDR',
        description: 'New description',
        color: '#fbbf24',
        repos: [{ id: 'web', name: 'Web', url: 'https://github.com/org/web.git' }],
    });

    assert.equal(h.commands.calls.length, 1);
    const call = h.commands.calls[0];
    assert.equal(call.originalProjectId, 'shop');
    assert.equal(call.projectId, 'shop');
    assert.equal(call.name, 'Shop renamed');
    assert.equal(call.abbr, 'LDR');
    assert.equal(call.description, 'New description');
    assert.equal(call.color, '#fbbf24');
    assert.deepEqual([...call.repos], [
        { id: 'web', name: 'Web', url: 'https://github.com/org/web.git' },
    ]);
    assert.equal(h.modal.getState()?.kind, 'ep-updated');
});

test('submit preserves originalProjectId when the operator changes the slug', async () => {
    const h = setup();
    h.modal.open(sampleProject({ projectId: 'old-slug' }));
    await h.modal.submit({
        projectId: 'new-slug',
        name: 'Shop',
        repos: [],
    });
    assert.equal(h.commands.calls.length, 1);
    assert.equal(h.commands.calls[0].originalProjectId, 'old-slug');
    assert.equal(h.commands.calls[0].projectId, 'new-slug');
});

test('submit reads the form payload from the rendered inputs when no snapshot is supplied', async () => {
    const h = setup();
    h.modal.open(sampleProject());

    const panel = panelEl(h.shim.overlayRoot);
    const setInput = (field: string, value: string): void => {
        const el = findFirst(panel, (n) => n.attributes.get('data-input') === field);
        if (!el) throw new Error(`missing data-input="${field}"`);
        el.value = value;
    };
    setInput('name', 'Shop v2');
    setInput('description', 'Updated description');
    h.modal.pickColor('#c084fc');

    await h.modal.submit();

    assert.equal(h.commands.calls.length, 1);
    const call = h.commands.calls[0];
    assert.equal(call.originalProjectId, 'shop');
    assert.equal(call.projectId, 'shop');
    assert.equal(call.name, 'Shop v2');
    assert.equal(call.description, 'Updated description');
    assert.equal(call.color, '#c084fc');
    // Pre-populated repos are read back from the rendered rows.
    assert.equal(call.repos.length, 2);
    assert.equal(call.repos[0].id, 'web');
    assert.equal(call.repos[1].id, 'api');
});

test('submit upper-cases abbr on read (V1 parity with new-project)', async () => {
    const h = setup();
    h.modal.open(sampleProject({ abbr: 'ldp' }));
    const panel = panelEl(h.shim.overlayRoot);
    const abbrEl = findFirst(panel, (n) => n.attributes.get('data-input') === 'abbr');
    if (!abbrEl) throw new Error('missing abbr input');
    abbrEl.value = 'xyz';

    await h.modal.submit();
    assert.equal(h.commands.calls[0].abbr, 'XYZ');
});

test('submit drops partial repo rows (missing id or url) — V1 parity', async () => {
    const h = setup();
    h.modal.open({ projectId: 'p', name: 'P' });
    await h.modal.submit({
        projectId: 'p',
        name: 'P',
        repos: [
            { id: 'ok', url: 'https://github.com/org/ok.git' },
            { id: 'no-url', url: '' },
            { id: '', url: 'https://github.com/org/no-id.git' },
        ],
    });
    assert.equal(h.commands.calls.length, 1);
    assert.deepEqual([...h.commands.calls[0].repos], [
        { id: 'ok', url: 'https://github.com/org/ok.git' },
    ]);
});

test('submit rejects an empty id or name with a toast and stays in ep-ready', async () => {
    const h = setup();
    h.modal.open(sampleProject());
    await h.modal.submit({ projectId: '', name: 'Has name', repos: [] });
    assert.equal(h.commands.calls.length, 0);
    assert.equal(h.modal.getState()?.kind, 'ep-ready');
    assert.equal(h.toast.calls.length, 1);
    assert.equal(h.toast.calls[0].kind, 'error');

    await h.modal.submit({ projectId: 'has-id', name: '', repos: [] });
    assert.equal(h.commands.calls.length, 0);
    assert.equal(h.modal.getState()?.kind, 'ep-ready');
    assert.equal(h.toast.calls.length, 2);
});

test('ep-ready → ep-submitting → ep-updated: submit walks the full happy-path state machine', async () => {
    const h = setup();
    h.modal.open(sampleProject());
    h.commands.nextProjectId = 'shop-v2';

    let resolveUpdate: (() => void) | null = null;
    h.commands.updateProjectBlocker = new Promise<void>((res) => {
        resolveUpdate = res;
    });

    const submitPromise = h.modal.submit({
        projectId: 'shop',
        name: 'Shop',
        repos: [],
    });
    // Drain one microtask so submit() advances past the synchronous
    // setState('ep-submitting') call.
    await Promise.resolve();
    assert.equal(h.modal.getState()?.kind, 'ep-submitting');
    const panel = panelEl(h.shim.overlayRoot);
    assert.equal(panel.attributes.get('data-state'), 'ep-submitting');
    bodyForState(panel, 'ep-submitting');

    if (!resolveUpdate) throw new Error('blocker resolver not captured');
    (resolveUpdate as () => void)();
    await submitPromise;

    const finalState = h.modal.getState();
    if (!finalState || finalState.kind !== 'ep-updated') {
        throw new Error(`expected ep-updated, got ${finalState?.kind ?? 'closed'}`);
    }
    assert.equal(finalState.projectId, 'shop-v2');
    assert.equal(finalState.name, 'Shop');

    const panelEnd = panelEl(h.shim.overlayRoot);
    assert.equal(panelEnd.attributes.get('data-state'), 'ep-updated');
    bodyForState(panelEnd, 'ep-updated');
});

test('updateProject failure transitions to ep-error and surfaces a toast', async () => {
    const h = setup();
    h.modal.open(sampleProject());
    h.commands.updateProjectShouldReject = new Error('linear write failed');

    await h.modal.submit({ projectId: 'shop', name: 'Shop', repos: [] });

    const state = h.modal.getState();
    if (!state || state.kind !== 'ep-error') {
        throw new Error(`expected ep-error, got ${state?.kind ?? 'closed'}`);
    }
    assert.equal(state.originalProjectId, 'shop');
    assert.equal(state.message, 'linear write failed');
    assert.equal(h.toast.calls.length, 1);
    assert.equal(h.toast.calls[0].kind, 'error');
    assert.equal(h.toast.calls[0].message, 'linear write failed');

    const panel = panelEl(h.shim.overlayRoot);
    assert.equal(panel.attributes.get('data-state'), 'ep-error');
    const errBody = bodyForState(panel, 'ep-error');
    const errMsg = findFirst(errBody, (n) => n.attributes.has('data-error-message'));
    assert.equal(errMsg?.textContent, 'linear write failed');
});

test('clicking the submit button in ep-ready triggers updateProject via the rendered onclick', async () => {
    const h = setup();
    h.modal.open(sampleProject());
    const panel = panelEl(h.shim.overlayRoot);

    const submitBtn = buttonForAction(panel, 'submit');
    submitBtn.onclick?.();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(h.commands.calls.length, 1);
    assert.equal(h.commands.calls[0].originalProjectId, 'shop');
    assert.equal(h.commands.calls[0].projectId, 'shop');
    assert.equal(h.commands.calls[0].name, 'Shop');
});

test('cancel button closes the modal without dispatching updateProject', () => {
    const h = setup();
    h.modal.open(sampleProject());
    const panel = panelEl(h.shim.overlayRoot);
    const cancelBtn = buttonForAction(panel, 'cancel');
    cancelBtn.onclick?.();
    assert.equal(h.commands.calls.length, 0);
    assert.equal(h.modal.getState(), null);
    assert.deepEqual(h.overlay.closed, [EDIT_PROJECT_OVERLAY_ID]);
});

// ---------------------------------------------------------------------------
// AC #4 — index.html registers the edit-project modal template
// ---------------------------------------------------------------------------

test('hosts/board-ui/index.html registers <template id="edit-project-modal-template"> with the seven V1 swatches', () => {
    const indexPath = path.resolve(__dirname, '../../../hosts/board-ui/index.html');
    const html = fs.readFileSync(indexPath, 'utf8');

    assert.match(
        html,
        new RegExp(`<template[^>]*id="${EDIT_PROJECT_TEMPLATE_ID}"`),
        'expected the edit-project modal template to be registered in index.html',
    );

    for (const hex of PROJECT_COLOR_SWATCHES) {
        assert.ok(
            html.includes(`data-swatch="${hex}"`),
            `expected swatch ${hex} to be present in the index.html template`,
        );
    }
    for (const field of ['name', 'abbr', 'id', 'description']) {
        assert.ok(
            html.includes(`data-input="${field}"`),
            `expected data-input="${field}" in the index.html template`,
        );
    }
    assert.ok(html.includes('data-repos'), 'expected the repos container in the template');
    assert.ok(
        html.includes('data-action="add-repo"'),
        'expected the + Add repo button in the template',
    );
});
