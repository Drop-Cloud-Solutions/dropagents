/**
 * New-project modal (AP-IFB-004).
 *
 * Operator-facing modal for creating a pipeline project. Ports the V1
 * `submitProject` form (pipeline/board/board.html:163-211,
 * pipeline/board/board.js:2583) onto the AP-IFF-002 overlay manager and
 * the AP-IFG-008 command sink, mirroring the registration shape of
 * {@link ../modals/new-plan} (overlay id, open/close lifecycle, command-
 * sink dispatch on submit).
 *
 * State machine (simpler than new-plan — no decomposer poll, no review
 * step):
 *
 *   np-ready      — form visible. Operator edits the V1 fields:
 *                   name (title), abbr, id/slug, description, color
 *                   swatch (one of the seven V1 hex values), and zero
 *                   or more repo rows (id + display name + git URL).
 *                   `submit()` validates id+name and advances to
 *                   np-submitting.
 *   np-submitting — command in flight. Spinner is rendered. On resolve
 *                   transitions to np-created; on reject transitions
 *                   to np-error and surfaces a toast.
 *   np-created    — success state with a close button.
 *   np-error      — failure state with a close button and the error
 *                   message inline.
 *
 * Integration
 * -----------
 * - Mounting: the modal is registered with the AP-IFF-002 overlay
 *   manager via `overlayManager.openOverlay('new-project', el)` on
 *   open and `closeOverlay('new-project')` on close. The panel element
 *   is appended under `#overlay-root` when the host does not supply a
 *   custom mount.
 * - Toasts: validation + dispatch failures funnel through the
 *   AP-IFF-004 `showToast` queue via {@link NewProjectDeps.showToast}.
 * - Commands: project creation goes through a {@link NewProjectCommandSink}
 *   port. Production (AP-PAO-014) wires this to a `CreateProject` dispatch
 *   over the board's existing `/commands` bus — the orchestrator handler
 *   then emits a `ProjectCreated` event and the SSE projection updates the
 *   sidebar. Tests pass a hand-rolled fake. The port surface is intentionally
 *   broader than the underlying `CreateProjectPayload` so the modal can carry
 *   abbr, color and repos through to the wiring layer without dropping any
 *   V1 form data.
 * - Shared field helpers: the colour swatch row + repo-row builder live
 *   in {@link ./project-form-fields} so the AP-IFB-005 edit-project
 *   modal can reuse them without duplicating ~120 lines of DOM
 *   construction.
 *
 * Renderer shape
 * --------------
 * Follows the structural-DOM pattern used by new-plan.ts — the module
 * touches a narrow {@link ModalDocument} / {@link ModalElement} surface
 * so unit tests can drive it with a hand-rolled shim, no jsdom.
 *
 * The modal builds its DOM dynamically; index.html registers a
 * `<template id="new-project-modal-template">` element with the V1-style
 * static markup as a parallel registration point (matching the
 * task-card-template / plan-card-template precedent).
 */

import {
    PROJECT_COLOR_SWATCHES,
    createColorSwatchGroup,
    createRepoRowList,
    createWorkspaceRepoSelector,
    resolveModalDocument,
    type ColorSwatchGroup,
    type ModalDocument,
    type ModalElement,
    type ModalElementWithEvents,
    type ModalEvent,
    type ProjectRepoInput,
    type RepoRowList,
    type WorkspaceRepoOption,
    type WorkspaceRepoSelector,
} from './project-form-fields';

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

/** Stable id pushed onto the overlay-manager stack. */
export const NEW_PROJECT_OVERLAY_ID = 'new-project';

/** DOM id of the default mount target. Matches AP-IFF-001 `#overlay-root`. */
export const OVERLAY_ROOT_ID = 'overlay-root';

/** DOM id of the `<template>` element registered in `index.html`. */
export const NEW_PROJECT_TEMPLATE_ID = 'new-project-modal-template';

// Re-export the shared swatch palette so existing callers (and tests
// that import `PROJECT_COLOR_SWATCHES` from this module) keep working.
export { PROJECT_COLOR_SWATCHES };

// Re-export the shared structural-DOM types — the new-project.spec.ts
// suite imports `ModalDocument` / `ModalElement` from this module.
export type { ModalDocument, ModalElement, ModalEvent };

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

export type NewProjectStateKind =
    | 'np-ready'
    | 'np-submitting'
    | 'np-created'
    | 'np-error';

export interface NewProjectReady {
    readonly kind: 'np-ready';
}

export interface NewProjectSubmitting {
    readonly kind: 'np-submitting';
    readonly projectId: string;
    readonly name: string;
}

export interface NewProjectCreated {
    readonly kind: 'np-created';
    readonly projectId: string;
    readonly name: string;
}

export interface NewProjectError {
    readonly kind: 'np-error';
    readonly message: string;
}

export type NewProjectState =
    | NewProjectReady
    | NewProjectSubmitting
    | NewProjectCreated
    | NewProjectError;

// ---------------------------------------------------------------------------
// Form-data + command-sink types
// ---------------------------------------------------------------------------

/**
 * One repo row in the form — alias for the shared {@link ProjectRepoInput}
 * type. Kept named `NewProjectRepoInput` for compatibility with callers
 * that imported it from this module before the helper extraction.
 */
export type NewProjectRepoInput = ProjectRepoInput;

/**
 * Inputs to the {@link NewProjectCommandSink.createProject} call.
 * Mirrors the V1 `submitProject` POST body so production wiring can
 * forward the full payload without lossy translation.
 */
export interface CreateProjectInput {
    /** Slug-style id ("shop"). Required. */
    readonly projectId: string;
    /** Human-readable name ("Shop"). Required. */
    readonly name: string;
    /** Optional 2-3 letter abbreviation used as a commit prefix. */
    readonly abbr?: string;
    /** Optional one-paragraph description. */
    readonly description?: string;
    /** Optional swatch hex value (one of {@link PROJECT_COLOR_SWATCHES}). */
    readonly color?: string;
    /** Zero or more repo rows. Empty array when the operator added none. */
    readonly repos: ReadonlyArray<NewProjectRepoInput>;
}

/**
 * Port over the board command bus. Production wires this to a POST
 * against `/commands/create-project`; tests pass a fake.
 *
 * The return shape carries the projectId back so the modal can show a
 * success view referencing the freshly created project.
 */
export interface NewProjectCommandSink {
    createProject(input: CreateProjectInput): Promise<{ readonly projectId: string }>;
}

// ---------------------------------------------------------------------------
// Toast + overlay-manager surfaces
// ---------------------------------------------------------------------------

export type ToastKind = 'info' | 'error' | 'success';

export interface ToastInput {
    readonly message: string;
    readonly kind?: ToastKind;
}

export type ShowToastFn = (input: ToastInput) => void;

/**
 * Minimal overlay-manager surface the modal needs. The real
 * `OverlayManager` (AP-IFF-002) satisfies this structurally.
 */
export interface OverlayManagerLike {
    openOverlay(id: string, element: unknown): unknown;
    closeOverlay(id: string): void;
}

// ---------------------------------------------------------------------------
// Deps + handle
// ---------------------------------------------------------------------------

export interface NewProjectDeps {
    readonly overlayManager: OverlayManagerLike;
    readonly commands: NewProjectCommandSink;
    readonly showToast: ShowToastFn;
    readonly doc?: ModalDocument;
    /** Optional mount root. Defaults to `#overlay-root`. */
    readonly mountRoot?: ModalElement;
    /**
     * Lazy reader for the workspace repo registry. Called at render
     * time so the checkbox list always reflects the current registry
     * (newly-registered repos appear without re-opening the modal).
     * When the host hasn't loaded any repos yet, returning `[]` falls
     * back to the legacy free-text {@link RepoRowList} below — keeps
     * the form usable on a fresh install before any repo exists.
     */
    readonly getWorkspaceRepos?: () => ReadonlyArray<WorkspaceRepoOption>;
}

/**
 * Snapshot of the form as the renderer sees it. Used by callers (tests
 * primarily) that want to drive submit without scraping the DOM —
 * `submit(snapshot)` short-circuits the DOM read in that path.
 */
export interface NewProjectFormSnapshot {
    readonly projectId: string;
    readonly name: string;
    readonly abbr?: string;
    readonly description?: string;
    readonly color?: string;
    readonly repos?: ReadonlyArray<NewProjectRepoInput>;
}

export interface NewProjectModalHandle {
    /** Open the modal. Idempotent: re-opening resets state to np-ready. */
    open(): void;
    /** Close the modal, detach the overlay, and clear state. */
    close(): void;
    /** Snapshot of the current state. `null` when closed. */
    getState(): NewProjectState | null;
    /**
     * Submit the form. Reads values from the rendered inputs when no
     * snapshot is supplied; tests pass a snapshot to bypass the DOM read.
     * Transitions np-ready → np-submitting → (np-created | np-error).
     */
    submit(snapshot?: NewProjectFormSnapshot): Promise<void>;
    /** Append a new repo row to the form (matches V1's `addRepoRow`). */
    addRepoRow(): void;
    /** Snapshot of the currently entered repo rows (for tests). */
    getRepoRows(): ReadonlyArray<NewProjectRepoInput>;
    /** Select a swatch programmatically (matches V1's `pickColor`). */
    pickColor(color: string): void;
    /** Currently selected swatch hex value, or `null` when none picked. */
    getSelectedColor(): string | null;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createNewProjectModal(deps: NewProjectDeps): NewProjectModalHandle {
    const doc = resolveModalDocument(deps.doc, 'new-project modal');

    let panel: ModalElement | null = null;
    let backdrop: ModalElement | null = null;
    let state: NewProjectState | null = null;
    /**
     * Token incremented on every state transition (including close).
     * Async callbacks captured before a transition compare against this
     * when they resolve so a stale createProject result doesn't leak
     * into the next state.
     */
    let token = 0;

    // Form-input refs and form-only state. Lives outside the renderer
    // so the inputs survive their initial render and the colour /
    // repo-row mutations stay sticky across the lifetime of np-ready.
    let nameInput: ModalElementWithEvents | null = null;
    let abbrInput: ModalElementWithEvents | null = null;
    let idInput: ModalElementWithEvents | null = null;
    let descInput: ModalElementWithEvents | null = null;
    let swatchGroup: ColorSwatchGroup | null = null;
    let repoList: RepoRowList | null = null;
    let workspaceRepoSelector: WorkspaceRepoSelector | null = null;
    /**
     * Tracks whether the slug input has been edited manually. When false,
     * typing into the name input auto-fills the slug — mirrors V1's
     * `suggestProjectSlug` + the `dataset.manual` flag.
     */
    let slugIsManual = false;
    let abbrIsManual = false;

    function resetFormRefs(): void {
        nameInput = null;
        abbrInput = null;
        idInput = null;
        descInput = null;
        swatchGroup = null;
        repoList = null;
        workspaceRepoSelector = null;
        slugIsManual = false;
        abbrIsManual = false;
    }

    function setState(next: NewProjectState | null): void {
        token++;
        state = next;
        render();
    }

    function toError(message: string): void {
        deps.showToast({ message, kind: 'error' });
        setState({ kind: 'np-error', message });
    }

    function resolveMountRoot(): ModalElement {
        if (deps.mountRoot) return deps.mountRoot;
        const root = doc.getElementById(OVERLAY_ROOT_ID);
        if (!root) {
            throw new Error(
                `new-project modal: mount root "#${OVERLAY_ROOT_ID}" not found and no `
                    + 'mountRoot dependency supplied.',
            );
        }
        return root;
    }

    // ---------------------------------------------------------------------
    // Public API
    // ---------------------------------------------------------------------

    function open(): void {
        if (panel !== null) {
            doClose();
        }
        const root = resolveMountRoot();
        // Backdrop wrapper — `.modal-chrome__overlay` (board.css:1702)
        // gives the panel `position: fixed`, centers it, and dims the
        // page. Without this wrapper the panel just sits in document
        // flow wherever `#overlay-root` happens to render and no longer
        // reads as a modal.
        backdrop = doc.createElement('div');
        backdrop.className = 'modal-chrome__overlay';
        backdrop.setAttribute('data-new-project-overlay', '');
        panel = doc.createElement('div');
        panel.className = 'new-project-modal modal-chrome';
        panel.setAttribute('data-new-project-modal', '');
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-modal', 'true');
        panel.setAttribute('aria-labelledby', 'new-project-title');
        backdrop.appendChild(panel);
        root.appendChild(backdrop);
        deps.overlayManager.openOverlay(NEW_PROJECT_OVERLAY_ID, panel);
        setState({ kind: 'np-ready' });
    }

    function doClose(): void {
        token++;
        if (panel !== null) {
            deps.overlayManager.closeOverlay(NEW_PROJECT_OVERLAY_ID);
            // Removing the backdrop tears the panel down with it; we
            // still null `panel` for the renderer guards.
            if (backdrop !== null) {
                backdrop.remove();
                backdrop = null;
            }
            panel = null;
        }
        state = null;
        resetFormRefs();
    }

    function close(): void {
        doClose();
    }

    function getState(): NewProjectState | null {
        return state;
    }

    function readSnapshotFromDom(): NewProjectFormSnapshot {
        const repos = workspaceRepoSelector
            ? workspaceRepoSelector.getSelected()
            : (repoList?.getRows() ?? []).filter(
                (r) => r.id.length > 0 && r.url.length > 0,
            );
        return {
            projectId: (idInput?.value ?? '').trim(),
            name: (nameInput?.value ?? '').trim(),
            abbr: (abbrInput?.value ?? '').trim().toUpperCase() || undefined,
            description: (descInput?.value ?? '').trim() || undefined,
            color: swatchGroup?.getSelectedColor() ?? undefined,
            repos,
        };
    }

    async function submit(snapshot?: NewProjectFormSnapshot): Promise<void> {
        if (!state || state.kind !== 'np-ready') {
            throw new Error(
                `new-project modal: submit() requires np-ready state, got "${state?.kind ?? 'closed'}".`,
            );
        }
        const data = snapshot ?? readSnapshotFromDom();
        const projectId = (data.projectId ?? '').trim();
        const name = (data.name ?? '').trim();
        if (projectId.length === 0 || name.length === 0) {
            deps.showToast({ message: 'ID and title are required', kind: 'error' });
            return;
        }
        // Filter partial repo rows here too, not only in readSnapshotFromDom,
        // so callers that pass an explicit snapshot get the same V1 parity
        // ("row needs both an id and a url to ship to the wiring layer").
        const repos = (data.repos ?? []).filter(
            (r) => r.id.length > 0 && r.url.length > 0,
        );
        const input: CreateProjectInput = {
            projectId,
            name,
            abbr: data.abbr,
            description: data.description,
            color: data.color,
            repos,
        };
        setState({ kind: 'np-submitting', projectId, name });
        const localToken = token;
        try {
            const result = await deps.commands.createProject(input);
            if (localToken !== token) return; // closed / advanced during await
            setState({ kind: 'np-created', projectId: result.projectId, name });
        } catch (err) {
            if (localToken !== token) return;
            toError(errorMessage(err, 'Create project failed'));
        }
    }

    function addRepoRow(): void {
        if (!repoList) {
            throw new Error(
                'new-project modal: addRepoRow() requires the form to be rendered '
                    + '(call open() first).',
            );
        }
        repoList.addRow();
    }

    function getRepoRows(): ReadonlyArray<NewProjectRepoInput> {
        if (workspaceRepoSelector) return workspaceRepoSelector.getSelected();
        return repoList?.getRows() ?? [];
    }

    function pickColor(color: string): void {
        if (!swatchGroup) {
            throw new Error(
                'new-project modal: pickColor() requires the form to be rendered '
                    + '(call open() first).',
            );
        }
        swatchGroup.pickColor(color);
    }

    function getSelectedColor(): string | null {
        return swatchGroup?.getSelectedColor() ?? null;
    }

    // ---------------------------------------------------------------------
    // V1-parity slug/abbr auto-fill (mirrors suggestProjectSlug)
    // ---------------------------------------------------------------------

    function suggestSlugFromName(name: string): string {
        return name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '')
            .slice(0, 30);
    }

    function suggestAbbrFromName(name: string): string {
        return name
            .split(/\s+/)
            .map((word) => word[0] ?? '')
            .filter((c) => /[A-Za-z]/.test(c))
            .join('')
            .toUpperCase()
            .slice(0, 3);
    }

    // ---------------------------------------------------------------------
    // Renderer
    // ---------------------------------------------------------------------

    function render(): void {
        if (panel === null || state === null) return;
        panel.setAttribute('data-state', state.kind);
        const view = (() => {
            switch (state.kind) {
                case 'np-ready':
                    return renderReady();
                case 'np-submitting':
                    return renderSubmitting(state);
                case 'np-created':
                    return renderCreated(state);
                case 'np-error':
                    return renderError(state);
            }
        })();
        panel.replaceChildren(view);
    }

    function makeButton(label: string, action: string, onClick: () => void): ModalElement {
        const btn = doc.createElement('button') as ModalElementWithEvents;
        btn.setAttribute('type', 'button');
        btn.setAttribute('data-action', action);
        btn.className = 'np-button';
        btn.textContent = label;
        btn.onclick = onClick;
        return btn;
    }

    function makeFormRow(dataRow: string, labelText: string): ModalElement {
        const row = doc.createElement('div');
        row.className = 'form-row';
        row.setAttribute('data-row', dataRow);
        const label = doc.createElement('label');
        label.className = 'form-label';
        label.textContent = labelText;
        row.appendChild(label);
        return row;
    }

    function makeTextInput(
        field: string,
        ariaLabel: string,
        placeholder: string,
    ): ModalElementWithEvents {
        const input = doc.createElement('input') as ModalElementWithEvents;
        input.setAttribute('type', 'text');
        input.setAttribute('data-input', field);
        input.setAttribute('aria-label', ariaLabel);
        input.setAttribute('placeholder', placeholder);
        input.value = '';
        return input;
    }

    function renderTitleAbbrRow(): ModalElement {
        const row = makeFormRow('title', 'Project title');
        const titleEl = makeTextInput('name', 'Project title', 'e.g. Shop');
        nameInput = titleEl;
        row.appendChild(titleEl);

        const abbrEl = makeTextInput('abbr', 'Project abbreviation', 'LDP');
        abbrEl.setAttribute('maxlength', '4');
        abbrInput = abbrEl;
        row.appendChild(abbrEl);
        return row;
    }

    function renderSlugRow(): ModalElement {
        const row = makeFormRow('id', 'Project ID (slug)');
        const slugEl = makeTextInput('id', 'Project ID (slug)', 'shop');
        idInput = slugEl;
        row.appendChild(slugEl);
        return row;
    }

    function wireTitleSlugAbbrAutofill(): void {
        const titleEl = nameInput;
        const slugEl = idInput;
        const abbrEl = abbrInput;
        if (!titleEl || !slugEl || !abbrEl) return;
        // V1 parity: title input drives slug + abbr until either is edited
        // manually, then auto-fill is disabled for that field.
        titleEl.oninput = (): void => {
            const name = titleEl.value ?? '';
            if (!slugIsManual) slugEl.value = suggestSlugFromName(name);
            if (!abbrIsManual) abbrEl.value = suggestAbbrFromName(name);
        };
        slugEl.oninput = (): void => {
            slugIsManual = (slugEl.value ?? '').length > 0;
        };
        abbrEl.oninput = (): void => {
            abbrIsManual = (abbrEl.value ?? '').length > 0;
        };
    }

    function renderDescriptionRow(): ModalElement {
        const row = makeFormRow('description', 'Description');
        const descEl = doc.createElement('textarea') as ModalElementWithEvents;
        descEl.setAttribute('data-input', 'description');
        descEl.setAttribute('aria-label', 'Project description');
        descEl.setAttribute('placeholder', 'Brief description of the project');
        descEl.value = '';
        descInput = descEl;
        row.appendChild(descEl);
        return row;
    }

    function renderColorRow(): ModalElement {
        const row = makeFormRow('color', 'Color');
        swatchGroup = createColorSwatchGroup(doc);
        row.appendChild(swatchGroup.element);
        return row;
    }

    function renderReposRow(): ModalElement {
        const row = makeFormRow('repos', 'Repositories');
        const workspaceRepos = deps.getWorkspaceRepos?.() ?? [];

        if (workspaceRepos.length > 0) {
            // Workspace registry present — render the multi-select.
            // Repos are first-class workspace entities; the project
            // just picks which ones it uses.
            const help = doc.createElement('p');
            help.className = 'form-help';
            help.textContent
                = 'Pick the repositories this project uses. Manage the '
                  + 'registry from the Repositories button in the sidebar — '
                  + 'every project linking to a repo shares the same clone '
                  + 'on disk.';
            row.appendChild(help);
            workspaceRepoSelector = createWorkspaceRepoSelector(doc, {
                workspaceRepos,
            });
            row.appendChild(workspaceRepoSelector.element);
            return row;
        }

        // Legacy fallback: no workspace repos registered yet — render
        // the free-text row list so the operator can still author a
        // project on a fresh install. They'll re-link via the
        // registry once they add a repo.
        const help = doc.createElement('p');
        help.className = 'form-help';
        help.textContent
            = 'No workspace repositories registered yet. Type repo metadata '
              + 'inline for now, or open the Repositories button in the '
              + 'sidebar to register one and re-open this modal.';
        row.appendChild(help);
        repoList = createRepoRowList(doc);
        row.appendChild(repoList.element);
        row.appendChild(
            makeButton('+ Add repo', 'add-repo', () => {
                addRepoRow();
            }),
        );
        return row;
    }

    function renderReadyFooter(): ModalElement {
        const footer = doc.createElement('div');
        footer.className = 'np-footer';
        footer.appendChild(
            makeButton('Cancel', 'cancel', () => {
                close();
            }),
        );
        footer.appendChild(
            makeButton('Create project', 'submit', () => {
                void submit();
            }),
        );
        return footer;
    }

    function renderReady(): ModalElement {
        // Reset the form refs — a fresh np-ready render replaces every
        // input element so any old references would dangle. New refs are
        // captured below as the per-row helpers build the tree.
        resetFormRefs();

        const wrap = doc.createElement('section');
        wrap.className = 'np-state np-state--ready';
        wrap.setAttribute('data-state-body', 'np-ready');

        const heading = doc.createElement('h3');
        heading.setAttribute('id', 'new-project-title');
        heading.textContent = 'New project';
        wrap.appendChild(heading);

        wrap.appendChild(renderTitleAbbrRow());
        wrap.appendChild(renderSlugRow());
        wireTitleSlugAbbrAutofill();
        wrap.appendChild(renderDescriptionRow());
        wrap.appendChild(renderColorRow());
        wrap.appendChild(renderReposRow());
        wrap.appendChild(renderReadyFooter());
        return wrap;
    }

    function renderSubmitting(s: NewProjectSubmitting): ModalElement {
        const wrap = doc.createElement('section');
        wrap.className = 'np-state np-state--submitting';
        wrap.setAttribute('data-state-body', 'np-submitting');
        wrap.setAttribute('data-project-id', s.projectId);

        const msg = doc.createElement('p');
        msg.textContent = 'Creating project…';
        wrap.appendChild(msg);

        const spinner = doc.createElement('div');
        spinner.className = 'np-spinner';
        spinner.setAttribute('role', 'status');
        spinner.setAttribute('aria-live', 'polite');
        spinner.textContent = 'Working…';
        wrap.appendChild(spinner);
        return wrap;
    }

    function renderCreated(s: NewProjectCreated): ModalElement {
        const wrap = doc.createElement('section');
        wrap.className = 'np-state np-state--created';
        wrap.setAttribute('data-state-body', 'np-created');
        wrap.setAttribute('data-project-id', s.projectId);

        const msg = doc.createElement('p');
        msg.textContent = `Project "${s.name}" created.`;
        wrap.appendChild(msg);

        wrap.appendChild(
            makeButton('Close', 'close', () => {
                close();
            }),
        );
        return wrap;
    }

    function renderError(s: NewProjectError): ModalElement {
        const wrap = doc.createElement('section');
        wrap.className = 'np-state np-state--error';
        wrap.setAttribute('data-state-body', 'np-error');

        const msg = doc.createElement('p');
        msg.setAttribute('data-error-message', '');
        msg.setAttribute('role', 'alert');
        msg.textContent = s.message;
        wrap.appendChild(msg);

        wrap.appendChild(
            makeButton('Close', 'close', () => {
                close();
            }),
        );
        return wrap;
    }

    function errorMessage(err: unknown, fallback: string): string {
        if (err instanceof Error && err.message) return err.message;
        if (typeof err === 'string' && err.length > 0) return err;
        return fallback;
    }

    return {
        open,
        close,
        getState,
        submit,
        addRepoRow,
        getRepoRows,
        pickColor,
        getSelectedColor,
    };
}
