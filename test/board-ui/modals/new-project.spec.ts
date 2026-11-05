/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Unit tests for the AP-IFB-004 new-project modal.
 *
 * Coverage targets the task's acceptance criteria:
 *   AC #1 open() mounts the panel under #overlay-root and registers with
 *         the overlay-manager via openOverlay('new-project', el).
 *   AC #2 np-ready renders inputs for name, abbr, id/slug, description,
 *         the colour swatch row and the repo-row container.
 *   AC #3 PROJECT_COLOR_SWATCHES exports exactly the seven V1 hex values
 *         and the rendered swatch row contains seven swatches.
 *   AC #4 addRepoRow / removeRepoRow add and remove rows dynamically.
 *   AC #5 submit() dispatches createProject through the command sink
 *         with the V1 form payload (id, name, abbr, description, color,
 *         repos) and transitions np-ready → np-submitting → np-created.
 *   AC #6 the template `#new-project-modal-template` is registered in
 *         hosts/board-ui/index.html with the seven V1 swatch hex values.
 *
 * Dual-runner discovery — same pattern as
 * test/board-ui/modals/new-plan.spec.ts: vitest when VITEST=true,
 * node:test otherwise.
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    NEW_PROJECT_OVERLAY_ID,
    NEW_PROJECT_TEMPLATE_ID,
    PROJECT_COLOR_SWATCHES,
    createNewProjectModal,
    type CreateProjectInput,
    type ModalDocument,
    type ModalElement,
    type NewProjectCommandSink,
    type NewProjectModalHandle,
    type OverlayManagerLike,
    type ShowToastFn,
    type ToastInput,
} from '../../../hosts/board-ui/client/modals/new-project';

// ---------------------------------------------------------------------------
// Dual-runner test() shim — mirrors new-plan.spec.ts
// ---------------------------------------------------------------------------

type TestFn = (name: string, fn: () => void | Promise<void>) => void;

const test: TestFn = (((): TestFn => {
    if (process.env.VITEST) {
        const gt = (globalThis as { test?: TestFn }).test;
        if (typeof gt !== 'function') {
            throw new Error(
                'new-project.spec.ts: VITEST=true but globalThis.test is missing — '
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
// Minimal DOM shim (same shape as new-plan.spec.ts)
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
    const found = findByAttribute(overlayRoot, 'data-new-project-modal');
    if (!found) {
        throw new Error(
            'expected a [data-new-project-modal] panel under overlay-root, found none',
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

interface FakeCommands extends NewProjectCommandSink {
    readonly calls: CreateProjectInput[];
    nextProjectId: string | null;
    createProjectShouldReject: Error | null;
    /** When set, createProject awaits this promise before resolving. */
    createProjectBlocker: Promise<void> | null;
}

function makeCommands(): FakeCommands {
    const sink: FakeCommands = {
        calls: [],
        nextProjectId: null,
        createProjectShouldReject: null,
        createProjectBlocker: null,
        async createProject(input): Promise<{ projectId: string }> {
            sink.calls.push({ ...input, repos: [...input.repos] });
            if (sink.createProjectBlocker) await sink.createProjectBlocker;
            if (sink.createProjectShouldReject) throw sink.createProjectShouldReject;
            return { projectId: sink.nextProjectId ?? input.projectId };
        },
    };
    return sink;
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Harness {
    readonly modal: NewProjectModalHandle;
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
    const modal = createNewProjectModal({
        doc: shim.doc,
        mountRoot: overrides?.mountRoot,
        overlayManager: overlay,
        showToast: toast.fn,
        commands,
    });
    return { modal, shim, overlay, toast, commands };
}

// ---------------------------------------------------------------------------
// AC #3 — PROJECT_COLOR_SWATCHES exports exactly the V1 hex values
// ---------------------------------------------------------------------------

test('PROJECT_COLOR_SWATCHES exports exactly the seven V1 hex values in V1 order', () => {
    // Order matches pipeline/board/board.html:186-192.
    assert.deepEqual(
        [...PROJECT_COLOR_SWATCHES],
        ['#7c6af7', '#38bdf8', '#34d399', '#fbbf24', '#f87171', '#c084fc', '#fb923c'],
    );
    assert.equal(PROJECT_COLOR_SWATCHES.length, 7);
});

// ---------------------------------------------------------------------------
// AC #1 — open() mounts under #overlay-root and registers with manager
// ---------------------------------------------------------------------------

test('open() mounts a panel under #overlay-root and registers it with the overlay manager', () => {
    const h = setup();
    h.modal.open();

    // root -> backdrop -> panel. The backdrop is what gives the panel
    // `position: fixed`, centres it and dims the page; without it the
    // panel sits in document flow and stops reading as a modal. Pinned
    // here because `panelEl` now finds the panel by marker, so losing
    // the wrapper would otherwise go unnoticed.
    assert.equal(h.shim.overlayRoot.children.length, 1);
    const backdrop = h.shim.overlayRoot.children[0]!;
    assert.ok(
        backdrop.attributes.has('data-new-project-overlay'),
        'the single child of overlay-root must be the backdrop',
    );
    const panel = panelEl(h.shim.overlayRoot);
    assert.equal(backdrop.children[0], panel, 'the panel sits inside the backdrop');
    assert.equal(panel.attributes.get('data-new-project-modal'), '');
    assert.equal(panel.attributes.get('role'), 'dialog');
    assert.equal(panel.attributes.get('aria-modal'), 'true');

    assert.equal(h.overlay.opened.length, 1);
    assert.equal(h.overlay.opened[0].id, NEW_PROJECT_OVERLAY_ID);
    assert.equal(h.overlay.opened[0].element, panel);

    const state = h.modal.getState();
    assert.ok(state && state.kind === 'np-ready');
    assert.equal(panel.attributes.get('data-state'), 'np-ready');
});

test('open() prefers an explicit mountRoot over the default #overlay-root', () => {
    const customRoot = makeShimElement('div');
    const h = setup({ mountRoot: customRoot });
    h.modal.open();
    assert.equal(customRoot.children.length, 1);
    assert.equal(h.shim.overlayRoot.children.length, 0);
});

test('close() detaches the panel, calls overlay-manager.closeOverlay, and clears state', () => {
    const h = setup();
    h.modal.open();
    h.modal.close();
    assert.equal(h.shim.overlayRoot.children.length, 0);
    assert.deepEqual(h.overlay.closed, [NEW_PROJECT_OVERLAY_ID]);
    assert.equal(h.modal.getState(), null);
});

test('re-opening tears down the previous panel before mounting a fresh one', () => {
    const h = setup();
    h.modal.open();
    h.modal.open();
    // One closeOverlay from the implicit close + one panel currently mounted.
    assert.equal(h.shim.overlayRoot.children.length, 1);
    assert.deepEqual(h.overlay.closed, [NEW_PROJECT_OVERLAY_ID]);
    assert.equal(h.overlay.opened.length, 2);
});

// ---------------------------------------------------------------------------
// AC #2 — np-ready renders every required input
// ---------------------------------------------------------------------------

test('np-ready renders name, abbr, id, description inputs and a repos container', () => {
    const h = setup();
    h.modal.open();
    const panel = panelEl(h.shim.overlayRoot);
    const body = bodyForState(panel, 'np-ready');

    for (const field of ['name', 'abbr', 'id', 'description']) {
        const el = findFirst(body, (n) => n.attributes.get('data-input') === field);
        assert.ok(el, `missing input for "${field}"`);
    }
    const reposContainer = findFirst(body, (n) => n.attributes.has('data-repos'));
    assert.ok(reposContainer, 'missing data-repos container');
    // Repos start empty — operator adds via the button.
    assert.equal(reposContainer?.children.length, 0);

    // Footer carries Cancel + Create project.
    buttonForAction(panel, 'cancel');
    buttonForAction(panel, 'submit');
});

// ---------------------------------------------------------------------------
// AC #3 — rendered swatch row has exactly 7 V1 swatches
// ---------------------------------------------------------------------------

test('np-ready renders exactly seven swatches with the V1 hex values in order', () => {
    const h = setup();
    h.modal.open();
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

test('pickColor selects a swatch and flips aria-pressed on the chosen one only', () => {
    const h = setup();
    h.modal.open();
    h.modal.pickColor('#34d399');
    assert.equal(h.modal.getSelectedColor(), '#34d399');

    const panel = panelEl(h.shim.overlayRoot);
    const swatches = findAll(panel, (n) => n.attributes.has('data-swatch'));
    const selectedCount = swatches.filter(
        (s) => s.attributes.get('aria-pressed') === 'true',
    ).length;
    assert.equal(selectedCount, 1);
    const selected = swatches.find((s) => s.attributes.get('aria-pressed') === 'true');
    assert.equal(selected?.attributes.get('data-swatch'), '#34d399');
});

test('clicking a swatch button selects its colour', () => {
    const h = setup();
    h.modal.open();
    const panel = panelEl(h.shim.overlayRoot);
    const swatches = findAll(panel, (n) => n.attributes.has('data-swatch'));
    swatches[3].onclick?.(); // #fbbf24
    assert.equal(h.modal.getSelectedColor(), '#fbbf24');
});

// ---------------------------------------------------------------------------
// AC #4 — repo rows can be added and removed dynamically
// ---------------------------------------------------------------------------

test('addRepoRow appends a row with id, name, url inputs + a remove button', () => {
    const h = setup();
    h.modal.open();
    h.modal.addRepoRow();
    h.modal.addRepoRow();

    const panel = panelEl(h.shim.overlayRoot);
    const reposContainer = findFirst(panel, (n) => n.attributes.has('data-repos'));
    assert.ok(reposContainer);
    assert.equal(reposContainer.children.length, 2);

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
    h.modal.open();
    h.modal.addRepoRow();
    h.modal.addRepoRow();
    h.modal.addRepoRow();

    const panel = panelEl(h.shim.overlayRoot);
    const reposContainer = findFirst(panel, (n) => n.attributes.has('data-repos'));
    if (!reposContainer) throw new Error('missing repos container');
    assert.equal(reposContainer.children.length, 3);

    // Remove the middle row.
    const middleRow = reposContainer.children[1];
    const removeBtn = findFirst(
        middleRow,
        (n) => n.attributes.get('data-action') === 'remove-repo',
    );
    removeBtn?.onclick?.();

    assert.equal(reposContainer.children.length, 2);
    assert.equal(h.modal.getRepoRows().length, 2);
});

test('clicking the + Add repo button appends a repo row', () => {
    const h = setup();
    h.modal.open();
    const panel = panelEl(h.shim.overlayRoot);
    const addBtn = buttonForAction(panel, 'add-repo');
    addBtn.onclick?.();
    addBtn.onclick?.();
    assert.equal(h.modal.getRepoRows().length, 2);
});

// ---------------------------------------------------------------------------
// AC #5 — submit() dispatches createProject and transitions states
// ---------------------------------------------------------------------------

test('submit dispatches createProject with the full V1 form payload', async () => {
    const h = setup();
    h.modal.open();

    await h.modal.submit({
        projectId: 'shop',
        name: 'Shop',
        abbr: 'LDP',
        description: 'Loan management',
        color: '#7c6af7',
        repos: [
            { id: 'web', name: 'Web app', url: 'https://github.com/org/web.git' },
            { id: 'api', url: 'https://github.com/org/api.git' },
        ],
    });

    assert.equal(h.commands.calls.length, 1);
    const call = h.commands.calls[0];
    assert.equal(call.projectId, 'shop');
    assert.equal(call.name, 'Shop');
    assert.equal(call.abbr, 'LDP');
    assert.equal(call.description, 'Loan management');
    assert.equal(call.color, '#7c6af7');
    assert.deepEqual([...call.repos], [
        { id: 'web', name: 'Web app', url: 'https://github.com/org/web.git' },
        { id: 'api', url: 'https://github.com/org/api.git' },
    ]);
    assert.equal(h.modal.getState()?.kind, 'np-created');
});

test('submit reads the form payload from the rendered inputs when no snapshot is supplied', async () => {
    const h = setup();
    h.modal.open();

    const panel = panelEl(h.shim.overlayRoot);
    const setInput = (field: string, value: string): void => {
        const el = findFirst(panel, (n) => n.attributes.get('data-input') === field);
        if (!el) throw new Error(`missing data-input="${field}"`);
        el.value = value;
    };
    setInput('id', 'shimmer');
    setInput('name', 'Shimmer');
    setInput('abbr', 'shm');
    setInput('description', 'A small project');
    h.modal.pickColor('#38bdf8');
    h.modal.addRepoRow();
    const reposContainer = findFirst(panel, (n) => n.attributes.has('data-repos'));
    if (!reposContainer) throw new Error('missing repos container');
    const firstRow = reposContainer.children[0];
    const setField = (field: string, value: string): void => {
        const el = findFirst(firstRow, (n) => n.attributes.get('data-field') === field);
        if (!el) throw new Error(`missing data-field="${field}"`);
        el.value = value;
    };
    setField('id', 'core');
    setField('name', 'Core');
    setField('url', 'https://github.com/org/core.git');

    await h.modal.submit();

    assert.equal(h.commands.calls.length, 1);
    const call = h.commands.calls[0];
    assert.equal(call.projectId, 'shimmer');
    assert.equal(call.name, 'Shimmer');
    // abbr is upper-cased on read (V1 parity).
    assert.equal(call.abbr, 'SHM');
    assert.equal(call.description, 'A small project');
    assert.equal(call.color, '#38bdf8');
    assert.deepEqual([...call.repos], [
        { id: 'core', name: 'Core', url: 'https://github.com/org/core.git' },
    ]);
});

test('submit drops partial repo rows (missing id or url) — V1 parity', async () => {
    const h = setup();
    h.modal.open();
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

test('submit rejects an empty id or name with a toast and stays in np-ready', async () => {
    const h = setup();
    h.modal.open();
    await h.modal.submit({ projectId: '', name: 'Has name', repos: [] });
    assert.equal(h.commands.calls.length, 0);
    assert.equal(h.modal.getState()?.kind, 'np-ready');
    assert.equal(h.toast.calls.length, 1);
    assert.equal(h.toast.calls[0].kind, 'error');

    await h.modal.submit({ projectId: 'has-id', name: '', repos: [] });
    assert.equal(h.commands.calls.length, 0);
    assert.equal(h.modal.getState()?.kind, 'np-ready');
    assert.equal(h.toast.calls.length, 2);
});

test('np-ready → np-submitting → np-created: submit walks the full happy-path state machine', async () => {
    const h = setup();
    h.modal.open();
    h.commands.nextProjectId = 'proj-42';

    let resolveCreate: (() => void) | null = null;
    h.commands.createProjectBlocker = new Promise<void>((res) => {
        resolveCreate = res;
    });

    const submitPromise = h.modal.submit({
        projectId: 'p',
        name: 'P',
        repos: [],
    });
    // Drain one microtask so submit() advances past the synchronous
    // setState('np-submitting') call.
    await Promise.resolve();
    assert.equal(h.modal.getState()?.kind, 'np-submitting');
    const panel = panelEl(h.shim.overlayRoot);
    assert.equal(panel.attributes.get('data-state'), 'np-submitting');
    bodyForState(panel, 'np-submitting');

    if (!resolveCreate) throw new Error('blocker resolver not captured');
    (resolveCreate as () => void)();
    await submitPromise;

    const finalState = h.modal.getState();
    if (!finalState || finalState.kind !== 'np-created') {
        throw new Error(`expected np-created, got ${finalState?.kind ?? 'closed'}`);
    }
    assert.equal(finalState.projectId, 'proj-42');
    assert.equal(finalState.name, 'P');

    const panelEnd = panelEl(h.shim.overlayRoot);
    assert.equal(panelEnd.attributes.get('data-state'), 'np-created');
    bodyForState(panelEnd, 'np-created');
});

test('createProject failure transitions to np-error and surfaces a toast', async () => {
    const h = setup();
    h.modal.open();
    h.commands.createProjectShouldReject = new Error('linear write failed');

    await h.modal.submit({ projectId: 'p', name: 'P', repos: [] });

    const state = h.modal.getState();
    if (!state || state.kind !== 'np-error') {
        throw new Error(`expected np-error, got ${state?.kind ?? 'closed'}`);
    }
    assert.equal(state.message, 'linear write failed');
    assert.equal(h.toast.calls.length, 1);
    assert.equal(h.toast.calls[0].kind, 'error');
    assert.equal(h.toast.calls[0].message, 'linear write failed');

    const panel = panelEl(h.shim.overlayRoot);
    assert.equal(panel.attributes.get('data-state'), 'np-error');
    const errBody = bodyForState(panel, 'np-error');
    const errMsg = findFirst(errBody, (n) => n.attributes.has('data-error-message'));
    assert.equal(errMsg?.textContent, 'linear write failed');
});

test('clicking submit button in np-ready triggers createProject via the rendered onclick', async () => {
    const h = setup();
    h.modal.open();
    const panel = panelEl(h.shim.overlayRoot);
    const setInput = (field: string, value: string): void => {
        const el = findFirst(panel, (n) => n.attributes.get('data-input') === field);
        if (!el) throw new Error(`missing data-input="${field}"`);
        el.value = value;
    };
    setInput('id', 'btn-id');
    setInput('name', 'Button-driven');

    const submitBtn = buttonForAction(panel, 'submit');
    submitBtn.onclick?.();
    // Drain microtasks for the inner async submit() to settle.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(h.commands.calls.length, 1);
    assert.equal(h.commands.calls[0].projectId, 'btn-id');
    assert.equal(h.commands.calls[0].name, 'Button-driven');
});

test('cancel button closes the modal without dispatching createProject', () => {
    const h = setup();
    h.modal.open();
    const panel = panelEl(h.shim.overlayRoot);
    const cancelBtn = buttonForAction(panel, 'cancel');
    cancelBtn.onclick?.();
    assert.equal(h.commands.calls.length, 0);
    assert.equal(h.modal.getState(), null);
    assert.deepEqual(h.overlay.closed, [NEW_PROJECT_OVERLAY_ID]);
});

// ---------------------------------------------------------------------------
// V1 parity — slug/abbr auto-fill on title input
// ---------------------------------------------------------------------------

test('typing into the title input auto-fills slug and abbr when neither has been edited', () => {
    const h = setup();
    h.modal.open();
    const panel = panelEl(h.shim.overlayRoot);
    const nameEl = findFirst(panel, (n) => n.attributes.get('data-input') === 'name');
    const slugEl = findFirst(panel, (n) => n.attributes.get('data-input') === 'id');
    const abbrEl = findFirst(panel, (n) => n.attributes.get('data-input') === 'abbr');
    if (!nameEl || !slugEl || !abbrEl) throw new Error('missing form inputs');

    nameEl.value = 'Loan Drop';
    nameEl.oninput?.();
    assert.equal(slugEl.value, 'loan-drop');
    assert.equal(abbrEl.value, 'LD');
});

test('manual edits to slug/abbr disable the auto-fill on subsequent title input', () => {
    const h = setup();
    h.modal.open();
    const panel = panelEl(h.shim.overlayRoot);
    const nameEl = findFirst(panel, (n) => n.attributes.get('data-input') === 'name');
    const slugEl = findFirst(panel, (n) => n.attributes.get('data-input') === 'id');
    const abbrEl = findFirst(panel, (n) => n.attributes.get('data-input') === 'abbr');
    if (!nameEl || !slugEl || !abbrEl) throw new Error('missing form inputs');

    slugEl.value = 'custom-slug';
    slugEl.oninput?.();
    abbrEl.value = 'XYZ';
    abbrEl.oninput?.();

    nameEl.value = 'New Name';
    nameEl.oninput?.();
    assert.equal(slugEl.value, 'custom-slug');
    assert.equal(abbrEl.value, 'XYZ');
});

// ---------------------------------------------------------------------------
// AC #6 — index.html registers the new-project modal template
// ---------------------------------------------------------------------------

test('hosts/board-ui/index.html registers <template id="new-project-modal-template"> with the seven V1 swatches', () => {
    const indexPath = path.resolve(__dirname, '../../../hosts/board-ui/index.html');
    const html = fs.readFileSync(indexPath, 'utf8');

    assert.match(
        html,
        new RegExp(`<template[^>]*id="${NEW_PROJECT_TEMPLATE_ID}"`),
        'expected the new-project modal template to be registered in index.html',
    );

    // The template carries the seven V1 swatch hex values verbatim.
    for (const hex of PROJECT_COLOR_SWATCHES) {
        assert.ok(
            html.includes(`data-swatch="${hex}"`),
            `expected swatch ${hex} to be present in the index.html template`,
        );
    }

    // Form-input markers for every required field.
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
