/**
 * Edit-project modal (AP-IFB-005).
 *
 * Operator-facing modal for editing an existing pipeline project. Same
 * field set as {@link ./new-project} — name, abbr, id/slug, description,
 * colour swatch, and zero-or-more repo rows — pre-populated from the
 * project passed in on `open()`.
 *
 * State machine — mirrors the new-project flow with `ep-` prefixed
 * states so the renderer's `data-state` attribute and the test
 * harness's `data-state-body` selectors stay distinguishable from the
 * new-project flow even when both modals are mounted into the same
 * overlay root:
 *
 *   ep-ready      — form visible, pre-populated from the supplied
 *                   project. `submit()` validates id+name and advances
 *                   to ep-submitting.
 *   ep-submitting — command in flight. Spinner is rendered. On resolve
 *                   transitions to ep-updated; on reject transitions
 *                   to ep-error and surfaces a toast.
 *   ep-updated    — success state with a close button.
 *   ep-error      — failure state with a close button and the error
 *                   message inline.
 *
 * Integration
 * -----------
 * - Mounting: the modal is registered with the AP-IFF-002 overlay
 *   manager via `overlayManager.openOverlay('edit-project', el)` on
 *   open and `closeOverlay('edit-project')` on close. The panel
 *   element is appended under `#overlay-root` when the host does not
 *   supply a custom mount.
 * - Toasts: validation + dispatch failures funnel through the
 *   AP-IFF-004 `showToast` queue via {@link EditProjectDeps.showToast}.
 * - Commands: project updates go through an
 *   {@link EditProjectCommandSink} port. Production wires this to a
 *   POST against `/commands/update-project` (per
 *   `BOARD_UI_COMMAND_ROUTES['/commands/update-project']`); tests pass
 *   a hand-rolled fake. The worker-side UpdateProject handler already
 *   exists (`hosts/board-ui/commands.ts:createUpdateProjectHandler` —
 *   wired into the command bus at registerBoardUiCommandHandlers) so
 *   the existing stub form's submit already lands on a registered
 *   handler; this modal upgrades the form fields without changing the
 *   command-bus contract.
 * - Shared field helpers: the colour swatch row + repo-row builder
 *   live in {@link ./project-form-fields} so this modal and
 *   {@link ./new-project} share one source of truth for the
 *   swatches and repo-row DOM construction.
 *
 * Renderer shape
 * --------------
 * Follows the structural-DOM pattern used by new-plan.ts /
 * new-project.ts — the module touches a narrow {@link ModalDocument} /
 * {@link ModalElement} surface so unit tests drive it with a hand-
 * rolled shim, no jsdom.
 *
 * The modal builds its DOM dynamically; index.html registers a
 * `<template id="edit-project-modal-template">` element with the V1-
 * style static markup as a parallel reference point (matching the
 * new-project-modal-template / task-card-template / plan-card-template
 * precedent).
 */

import {
    APPROVAL_MODE_VALUES,
    PROJECT_COLOR_SWATCHES,
    createApprovalModeDropdown,
    createColorSwatchGroup,
    createRepoRowList,
    createWorkspaceRepoSelector,
    resolveModalDocument,
    type ApprovalModeDropdown,
    type ApprovalModeValue,
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
export const EDIT_PROJECT_OVERLAY_ID = 'edit-project';

/** DOM id of the default mount target. Matches AP-IFF-001 `#overlay-root`. */
export const OVERLAY_ROOT_ID = 'overlay-root';

/** DOM id of the `<template>` element registered in `index.html`. */
export const EDIT_PROJECT_TEMPLATE_ID = 'edit-project-modal-template';

// Re-export the shared swatch palette + structural types so callers
// (and tests) can import them from this module directly.
export { PROJECT_COLOR_SWATCHES, APPROVAL_MODE_VALUES };
export type { ApprovalModeValue, ModalDocument, ModalElement, ModalEvent };

// ---------------------------------------------------------------------------
// Advanced approvals — flow-loader port + override shape
// ---------------------------------------------------------------------------

/**
 * One step in a flow, as the modal needs it. Mirrors the {@link FlowStep}
 * shape from `core/flow/types` but lifted locally so the client module
 * does not import the Node-only flow loader directly.
 */
export interface ModalFlowStep {
    readonly id: string;
    readonly agent: string;
}

/** Subset of a {@link FlowDefinition} the modal cares about. */
export interface ModalFlow {
    readonly steps: ReadonlyArray<ModalFlowStep>;
}

/**
 * Port the modal calls on `open()` to discover every flow + step pair
 * that should appear in the Advanced approvals section. Production wires
 * this to a wrapper around `loadAllFlows('config/flows')`; tests pass an
 * in-memory map keyed by flow name.
 */
export interface FlowProvider {
    loadFlows(): ReadonlyMap<string, ModalFlow>;
}

/**
 * Two-level approval-mode override map. The outer key is the flow name
 * (matches `FlowProvider.loadFlows()` map key), the inner key is the step
 * id, and the leaf is one of the {@link ApprovalModeValue} literals.
 * Matches `core/commands.ApprovalOverride`.
 */
export type ApprovalOverride = {
    readonly [flowName: string]: {
        readonly [stepId: string]: ApprovalModeValue;
    };
};

/**
 * Inputs to the {@link EditProjectCommandSink.updateApprovalOverride}
 * call. Mirrors the `UpdateProjectApprovalOverridePayload` from
 * `core/commands` so the wiring layer can forward without remapping.
 */
export interface UpdateApprovalOverrideInput {
    readonly projectId: string;
    readonly approvalOverride: ApprovalOverride;
}

/**
 * Default set of step kinds the modal knows how to gate: the core
 * `FLOW_STEP_KINDS` (mirrored locally, for the reason given above — this
 * module does not import `core/flow/types`) plus core's own agent roles.
 *
 * It deliberately does NOT name a stack pack's roles. `board.ts` passes a
 * `knownStepKinds` set that it extends from the LOADED flows, so an
 * enabled pack's steps are known without core listing them; this default
 * is the pre-hydration floor, and what tests get.
 *
 * Step kinds outside the set still render a dropdown, but with a visible
 * "unknown step kind" note so the operator can spot a flow that grew a
 * new step type without the modal being taught about it.
 */
export const DEFAULT_KNOWN_STEP_KINDS: ReadonlySet<string> = new Set([
    // FLOW_STEP_KINDS (core/flow/types)
    'wait-action',
    'wait-merged',
    'run-script',
    'verify',
    'report-only',
    'context-update',
    'merge',
    // Agent roles surfaced by the YAML flows under config/flows/.
    'developer',
    'reviewer',
    'tester',
    'committer',
    'investigator',
    'commit-approval',
    'merge-approval',
    'pr-ready',
    'codebase-reviewer',
    'context-update-curator',
    'doc-writer',
    'echo',
    'repo-scaffolder',
    'worktree-diff-review',
]);

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

export type EditProjectStateKind =
    | 'ep-ready'
    | 'ep-submitting'
    | 'ep-updated'
    | 'ep-error';

export interface EditProjectReady {
    readonly kind: 'ep-ready';
    /** The project's existing identifier — used as the command lookup key. */
    readonly originalProjectId: string;
}

export interface EditProjectSubmitting {
    readonly kind: 'ep-submitting';
    readonly originalProjectId: string;
    readonly projectId: string;
    readonly name: string;
}

export interface EditProjectUpdated {
    readonly kind: 'ep-updated';
    readonly projectId: string;
    readonly name: string;
}

export interface EditProjectError {
    readonly kind: 'ep-error';
    readonly originalProjectId: string;
    readonly message: string;
}

export type EditProjectState =
    | EditProjectReady
    | EditProjectSubmitting
    | EditProjectUpdated
    | EditProjectError;

// ---------------------------------------------------------------------------
// Form-data + command-sink types
// ---------------------------------------------------------------------------

/** Alias for the shared {@link ProjectRepoInput} type. */
export type EditProjectRepoInput = ProjectRepoInput;

/**
 * Shape passed into {@link EditProjectModalHandle.open}. Every field
 * the modal renders is reachable here so pre-population is lossless;
 * `projectId` doubles as the command lookup key on submit.
 */
export interface EditProjectInput {
    /** Existing slug-style id ("shop"). Required. */
    readonly projectId: string;
    /** Existing human-readable name. Required. */
    readonly name: string;
    /** Optional abbreviation. */
    readonly abbr?: string;
    /** Optional description. */
    readonly description?: string;
    /** Optional swatch hex value. */
    readonly color?: string;
    /** Existing repos. Empty array when the project has none. */
    readonly repos?: ReadonlyArray<EditProjectRepoInput>;
    /**
     * The project's persisted approval override. The wiring layer fetches
     * this via `ProjectRegistry.getApprovalOverride(projectId)` and passes
     * it on `open()` so the Advanced approvals dropdowns can pre-populate
     * without the modal having to call into the registry directly.
     * Absent / empty maps render as all-default.
     */
    readonly approvalOverride?: ApprovalOverride;
}

/**
 * Inputs to the {@link EditProjectCommandSink.updateProject} call.
 *
 * - `originalProjectId` is the lookup key — always the slug the modal
 *   was opened with, never the (possibly-edited) value in the slug
 *   input. This guarantees the wiring layer can identify the project
 *   to update even if the operator changes its slug.
 * - `projectId` is the slug the operator wants the project to have
 *   after the update — equal to `originalProjectId` for the common
 *   "rename only" path, different when the operator changes the slug.
 *
 * The remaining fields mirror {@link EditProjectInput} so the wiring
 * layer can forward the full payload without lossy translation.
 */
export interface UpdateProjectInput {
    readonly originalProjectId: string;
    readonly projectId: string;
    readonly name: string;
    readonly abbr?: string;
    readonly description?: string;
    readonly color?: string;
    readonly repos: ReadonlyArray<EditProjectRepoInput>;
}

/**
 * Port over the board command bus. Production wires this to a POST
 * against `/commands/update-project` — the worker-side handler at
 * `hosts/board-ui/commands.ts:createUpdateProjectHandler` accepts the
 * `UpdateProject` command and emits a `ProjectUpdated` event. Tests
 * pass a fake.
 *
 * The return shape carries the projectId back so the modal can show a
 * success view referencing the freshly updated project (and so the
 * wiring layer can surface a server-resolved slug after a rename).
 */
export interface EditProjectCommandSink {
    updateProject(input: UpdateProjectInput): Promise<{ readonly projectId: string }>;
    /**
     * Dispatches the `UpdateProjectApprovalOverride` command on save.
     * Optional so callers that do not wire the Advanced approvals
     * section (e.g. older host snippets) still type-check; when the
     * Advanced section is rendered, `submit()` does call this method
     * with the assembled override.
     */
    updateApprovalOverride?(input: UpdateApprovalOverrideInput): Promise<void>;
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

/** Minimal overlay-manager surface the modal needs. */
export interface OverlayManagerLike {
    openOverlay(id: string, element: unknown): unknown;
    closeOverlay(id: string): void;
}

// ---------------------------------------------------------------------------
// Deps + handle
// ---------------------------------------------------------------------------

export interface EditProjectDeps {
    readonly overlayManager: OverlayManagerLike;
    readonly commands: EditProjectCommandSink;
    readonly showToast: ShowToastFn;
    readonly doc?: ModalDocument;
    /** Optional mount root. Defaults to `#overlay-root`. */
    readonly mountRoot?: ModalElement;
    /**
     * Provides the flow definitions used to populate the Advanced
     * approvals section. When omitted the section is not rendered and
     * `submit()` skips the override dispatch — the legacy contract.
     */
    readonly flows?: FlowProvider;
    /**
     * Override the built-in {@link DEFAULT_KNOWN_STEP_KINDS} set. `board.ts`
     * passes one it extends from the loaded flows, so an enabled pack's step
     * kinds are known; tests pass a smaller set to exercise the unknown-kind
     * fallback without coupling the assertion to whatever the production
     * default happens to contain.
     *
     * Captured by reference: a caller may keep adding to the set after the
     * modal is constructed, which is what hydration does.
     */
    readonly knownStepKinds?: ReadonlySet<string>;
    /**
     * Lazy reader for the workspace repo registry. Same contract as
     * the new-project modal — when supplied and the registry has at
     * least one row, the modal renders a checkbox multi-select
     * against it; when empty, falls back to the legacy free-text
     * row list.
     */
    readonly getWorkspaceRepos?: () => ReadonlyArray<WorkspaceRepoOption>;
}

/**
 * Snapshot of the form as the renderer sees it. Used by callers (tests
 * primarily) that want to drive submit without scraping the DOM —
 * `submit(snapshot)` short-circuits the DOM read in that path.
 */
export interface EditProjectFormSnapshot {
    readonly projectId: string;
    readonly name: string;
    readonly abbr?: string;
    readonly description?: string;
    readonly color?: string;
    readonly repos?: ReadonlyArray<EditProjectRepoInput>;
}

export interface EditProjectModalHandle {
    /**
     * Open the modal pre-populated from {@link project}. Idempotent —
     * re-opening tears down the previous panel and resets state to
     * ep-ready with the new project.
     */
    open(project: EditProjectInput): void;
    /** Close the modal, detach the overlay, and clear state. */
    close(): void;
    /** Snapshot of the current state. `null` when closed. */
    getState(): EditProjectState | null;
    /**
     * Submit the form. Reads values from the rendered inputs when no
     * snapshot is supplied; tests pass a snapshot to bypass the DOM read.
     * Transitions ep-ready → ep-submitting → (ep-updated | ep-error).
     */
    submit(snapshot?: EditProjectFormSnapshot): Promise<void>;
    /** Append an empty repo row to the form. */
    addRepoRow(): void;
    /** Snapshot of the currently entered repo rows (for tests). */
    getRepoRows(): ReadonlyArray<EditProjectRepoInput>;
    /** Select a swatch programmatically. */
    pickColor(color: string): void;
    /** Currently selected swatch hex value, or `null` when none picked. */
    getSelectedColor(): string | null;
    /**
     * Snapshot of the current Advanced approvals state — `null` when no
     * {@link FlowProvider} was wired (the section is not rendered).
     */
    getApprovalOverride(): ApprovalOverride | null;
    /**
     * Whether the Advanced approvals section is currently expanded. The
     * section starts collapsed; the toggle button flips this flag.
     */
    isAdvancedApprovalsExpanded(): boolean;
    /** Toggle the Advanced approvals section programmatically (for tests). */
    toggleAdvancedApprovals(): void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createEditProjectModal(deps: EditProjectDeps): EditProjectModalHandle {
    const doc = resolveModalDocument(deps.doc, 'edit-project modal');

    let panel: ModalElement | null = null;
    let backdrop: ModalElement | null = null;
    let state: EditProjectState | null = null;
    /**
     * The project the modal was opened with. Retained across renders so
     * the renderer can re-populate inputs whenever the panel rebuilds
     * (e.g. ep-error → operator clicks Close → re-open).
     */
    let openedProject: EditProjectInput | null = null;
    /**
     * Token incremented on every state transition (including close).
     * Async callbacks captured before a transition compare against this
     * when they resolve so a stale updateProject result doesn't leak
     * into the next state.
     */
    let token = 0;

    // Form-input refs and form-only state. Lives outside the renderer
    // so the inputs survive their initial render and the colour /
    // repo-row mutations stay sticky across the lifetime of ep-ready.
    let nameInput: ModalElementWithEvents | null = null;
    let abbrInput: ModalElementWithEvents | null = null;
    let idInput: ModalElementWithEvents | null = null;
    let descInput: ModalElementWithEvents | null = null;
    let swatchGroup: ColorSwatchGroup | null = null;
    let repoList: RepoRowList | null = null;
    let workspaceRepoSelector: WorkspaceRepoSelector | null = null;

    // Advanced approvals — flow snapshot + per-step dropdown state. The
    // outer Map's iteration order matches `loadFlows()`; the inner Map's
    // iteration order matches each flow's declared `steps[]` order.
    let flowSnapshot: ReadonlyMap<string, ModalFlow> | null = null;
    const approvalValues = new Map<string, Map<string, ApprovalModeValue>>();
    const approvalDropdowns: ApprovalModeDropdown[] = [];
    let advancedBody: ModalElement | null = null;
    let advancedExpanded = false;

    const knownStepKinds: ReadonlySet<string> =
        deps.knownStepKinds ?? DEFAULT_KNOWN_STEP_KINDS;

    function resetFormRefs(): void {
        nameInput = null;
        abbrInput = null;
        idInput = null;
        descInput = null;
        swatchGroup = null;
        repoList = null;
        workspaceRepoSelector = null;
        advancedBody = null;
        approvalDropdowns.length = 0;
    }

    function resetApprovalState(): void {
        flowSnapshot = null;
        approvalValues.clear();
        advancedExpanded = false;
    }

    function captureApprovalState(project: EditProjectInput): void {
        approvalValues.clear();
        if (!deps.flows) {
            flowSnapshot = null;
            return;
        }
        const flows = deps.flows.loadFlows();
        flowSnapshot = flows;
        const persisted = project.approvalOverride ?? {};
        for (const [flowName, flow] of flows) {
            const perStep = new Map<string, ApprovalModeValue>();
            const flowOverride = persisted[flowName] ?? {};
            for (const step of flow.steps) {
                const initial = resolveInitialMode(
                    step.agent,
                    flowOverride[step.id],
                );
                perStep.set(step.id, initial);
            }
            approvalValues.set(flowName, perStep);
        }
    }

    function resolveInitialMode(
        kind: string,
        overrideValue: ApprovalModeValue | undefined,
    ): ApprovalModeValue {
        // Unknown step kinds always start at 'default' — the modal can't
        // promise the gate semantics, so we refuse to pre-populate from a
        // possibly-stale override entry. Operators can still pick another
        // value; the note next to the dropdown makes the situation clear.
        if (!knownStepKinds.has(kind)) return 'default';
        if (overrideValue !== undefined && isApprovalModeValue(overrideValue)) {
            return overrideValue;
        }
        return 'default';
    }

    function buildApprovalOverride(): ApprovalOverride {
        const out: Record<string, Record<string, ApprovalModeValue>> = {};
        for (const [flowName, perStep] of approvalValues) {
            const inner: Record<string, ApprovalModeValue> = {};
            for (const [stepId, value] of perStep) {
                inner[stepId] = value;
            }
            out[flowName] = inner;
        }
        return out;
    }

    function setState(next: EditProjectState | null): void {
        token++;
        state = next;
        render();
    }

    function toError(originalProjectId: string, message: string): void {
        deps.showToast({ message, kind: 'error' });
        setState({ kind: 'ep-error', originalProjectId, message });
    }

    function resolveMountRoot(): ModalElement {
        if (deps.mountRoot) return deps.mountRoot;
        const root = doc.getElementById(OVERLAY_ROOT_ID);
        if (!root) {
            throw new Error(
                `edit-project modal: mount root "#${OVERLAY_ROOT_ID}" not found and no `
                    + 'mountRoot dependency supplied.',
            );
        }
        return root;
    }

    // ---------------------------------------------------------------------
    // Public API
    // ---------------------------------------------------------------------

    function open(project: EditProjectInput): void {
        if (
            !project
            || typeof project.projectId !== 'string'
            || project.projectId.length === 0
        ) {
            throw new Error(
                'edit-project modal: open() requires a project with a non-empty projectId.',
            );
        }
        if (typeof project.name !== 'string' || project.name.length === 0) {
            throw new Error('edit-project modal: open() requires a project with a non-empty name.');
        }
        // Re-opening: tear down the previous panel before mounting a
        // fresh one so the overlay-manager stack stays consistent.
        if (panel !== null) {
            doClose();
        }
        openedProject = project;
        captureApprovalState(project);
        const root = resolveMountRoot();
        // Backdrop wrapper — `.modal-chrome__overlay` (board.css:1702)
        // gives the panel `position: fixed`, centers it, and dims the
        // page. Without this wrapper the panel just sits in document
        // flow wherever `#overlay-root` happens to render and no longer
        // reads as a modal.
        backdrop = doc.createElement('div');
        backdrop.className = 'modal-chrome__overlay';
        backdrop.setAttribute('data-edit-project-overlay', '');
        panel = doc.createElement('div');
        panel.className = 'edit-project-modal modal-chrome';
        panel.setAttribute('data-edit-project-modal', '');
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-modal', 'true');
        panel.setAttribute('aria-labelledby', 'edit-project-title');
        panel.setAttribute('data-project-id', project.projectId);
        backdrop.appendChild(panel);
        root.appendChild(backdrop);
        deps.overlayManager.openOverlay(EDIT_PROJECT_OVERLAY_ID, panel);
        setState({ kind: 'ep-ready', originalProjectId: project.projectId });
    }

    function doClose(): void {
        token++;
        if (panel !== null) {
            deps.overlayManager.closeOverlay(EDIT_PROJECT_OVERLAY_ID);
            // Removing the backdrop tears the panel down with it; we
            // still null `panel` for the renderer guards.
            if (backdrop !== null) {
                backdrop.remove();
                backdrop = null;
            }
            panel = null;
        }
        state = null;
        openedProject = null;
        resetFormRefs();
        resetApprovalState();
    }

    function close(): void {
        doClose();
    }

    function getState(): EditProjectState | null {
        return state;
    }

    function readSnapshotFromDom(): EditProjectFormSnapshot {
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

    async function submit(snapshot?: EditProjectFormSnapshot): Promise<void> {
        if (!state || state.kind !== 'ep-ready') {
            throw new Error(
                `edit-project modal: submit() requires ep-ready state, got "${state?.kind ?? 'closed'}".`,
            );
        }
        const originalProjectId = state.originalProjectId;
        const data = snapshot ?? readSnapshotFromDom();
        const projectId = (data.projectId ?? '').trim();
        const name = (data.name ?? '').trim();
        if (projectId.length === 0 || name.length === 0) {
            deps.showToast({ message: 'ID and title are required', kind: 'error' });
            return;
        }
        const repos = (data.repos ?? []).filter(
            (r) => r.id.length > 0 && r.url.length > 0,
        );
        const input: UpdateProjectInput = {
            originalProjectId,
            projectId,
            name,
            abbr: data.abbr,
            description: data.description,
            color: data.color,
            repos,
        };
        setState({ kind: 'ep-submitting', originalProjectId, projectId, name });
        const localToken = token;
        try {
            const result = await deps.commands.updateProject(input);
            if (localToken !== token) return; // closed / advanced during await
            // Dispatch the approval-override command alongside the main
            // project update. Skipped when no flow provider was wired
            // (no Advanced approvals section was rendered) or the sink
            // does not implement the optional method.
            if (flowSnapshot !== null && deps.commands.updateApprovalOverride) {
                const approvalOverride = buildApprovalOverride();
                await deps.commands.updateApprovalOverride({
                    projectId: result.projectId,
                    approvalOverride,
                });
                if (localToken !== token) return;
            }
            setState({ kind: 'ep-updated', projectId: result.projectId, name });
        } catch (err) {
            if (localToken !== token) return;
            toError(originalProjectId, errorMessage(err, 'Update project failed'));
        }
    }

    function addRepoRow(): void {
        if (!repoList) {
            throw new Error(
                'edit-project modal: addRepoRow() requires the form to be rendered '
                    + '(call open() first).',
            );
        }
        repoList.addRow();
    }

    function getRepoRows(): ReadonlyArray<EditProjectRepoInput> {
        if (workspaceRepoSelector) return workspaceRepoSelector.getSelected();
        return repoList?.getRows() ?? [];
    }

    function pickColor(color: string): void {
        if (!swatchGroup) {
            throw new Error(
                'edit-project modal: pickColor() requires the form to be rendered '
                    + '(call open() first).',
            );
        }
        swatchGroup.pickColor(color);
    }

    function getSelectedColor(): string | null {
        return swatchGroup?.getSelectedColor() ?? null;
    }

    // ---------------------------------------------------------------------
    // Renderer
    // ---------------------------------------------------------------------

    function render(): void {
        if (panel === null || state === null) return;
        panel.setAttribute('data-state', state.kind);
        const view = (() => {
            switch (state.kind) {
                case 'ep-ready':
                    return renderReady();
                case 'ep-submitting':
                    return renderSubmitting(state);
                case 'ep-updated':
                    return renderUpdated(state);
                case 'ep-error':
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
        initial: string,
    ): ModalElementWithEvents {
        const input = doc.createElement('input') as ModalElementWithEvents;
        input.setAttribute('type', 'text');
        input.setAttribute('data-input', field);
        input.setAttribute('aria-label', ariaLabel);
        input.setAttribute('placeholder', placeholder);
        input.value = initial;
        return input;
    }

    function renderTitleAbbrRow(project: EditProjectInput): ModalElement {
        const row = makeFormRow('title', 'Project title');
        const titleEl = makeTextInput('name', 'Project title', 'e.g. Shop', project.name);
        nameInput = titleEl;
        row.appendChild(titleEl);

        const abbrEl = makeTextInput(
            'abbr',
            'Project abbreviation',
            'LDP',
            project.abbr ?? '',
        );
        abbrEl.setAttribute('maxlength', '4');
        abbrInput = abbrEl;
        row.appendChild(abbrEl);
        return row;
    }

    function renderSlugRow(project: EditProjectInput): ModalElement {
        const row = makeFormRow('id', 'Project ID (slug)');
        const slugEl = makeTextInput(
            'id',
            'Project ID (slug)',
            'shop',
            project.projectId,
        );
        idInput = slugEl;
        row.appendChild(slugEl);
        return row;
    }

    function renderDescriptionRow(project: EditProjectInput): ModalElement {
        const row = makeFormRow('description', 'Description');
        const descEl = doc.createElement('textarea') as ModalElementWithEvents;
        descEl.setAttribute('data-input', 'description');
        descEl.setAttribute('aria-label', 'Project description');
        descEl.setAttribute('placeholder', 'Brief description of the project');
        descEl.value = project.description ?? '';
        descInput = descEl;
        row.appendChild(descEl);
        return row;
    }

    function renderColorRow(project: EditProjectInput): ModalElement {
        const row = makeFormRow('color', 'Color');
        swatchGroup = createColorSwatchGroup(doc, { initialColor: project.color ?? null });
        row.appendChild(swatchGroup.element);
        return row;
    }

    function renderReposRow(project: EditProjectInput): ModalElement {
        const row = makeFormRow('repos', 'Repositories');
        const workspaceRepos = deps.getWorkspaceRepos?.() ?? [];

        if (workspaceRepos.length > 0) {
            const help = doc.createElement('p');
            help.className = 'form-help';
            help.textContent
                = 'Pick the repositories this project uses. Manage the '
                  + 'registry from the Repositories button in the sidebar — '
                  + 'every project linking to a repo shares the same clone '
                  + 'on disk.';
            row.appendChild(help);
            // Initial selection = ids of repos already linked to the
            // project. Old per-project metadata entries that no longer
            // match a workspace repoId silently drop out.
            const initialSelected = (project.repos ?? [])
                .map((r) => r.id)
                .filter((id): id is string => typeof id === 'string' && id.length > 0);
            workspaceRepoSelector = createWorkspaceRepoSelector(doc, {
                workspaceRepos,
                initialSelected,
            });
            row.appendChild(workspaceRepoSelector.element);
            return row;
        }

        // Legacy fallback for projects opened when no workspace repos
        // exist yet — keep the free-text rows so the operator can
        // still edit, then re-link via the registry once a repo
        // exists.
        const help = doc.createElement('p');
        help.className = 'form-help';
        help.textContent
            = 'No workspace repositories registered yet. Inline rows below '
              + 'are kept for compatibility — register repos via the '
              + 'sidebar Repositories button to switch this to a multi-select.';
        row.appendChild(help);
        repoList = createRepoRowList(doc);
        row.appendChild(repoList.element);
        for (const repo of project.repos ?? []) {
            repoList.addRow(repo);
        }
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
            makeButton('Save changes', 'submit', () => {
                void submit();
            }),
        );
        return footer;
    }

    function renderReady(): ModalElement {
        resetFormRefs();

        const project = openedProject;
        if (!project) {
            throw new Error(
                'edit-project modal: renderReady() invoked without an opened project — '
                    + 'this is a bug; open() should always set openedProject before setState().',
            );
        }

        const wrap = doc.createElement('section');
        wrap.className = 'np-state np-state--ready';
        wrap.setAttribute('data-state-body', 'ep-ready');
        wrap.setAttribute('data-project-id', project.projectId);

        const heading = doc.createElement('h3');
        heading.setAttribute('id', 'edit-project-title');
        heading.textContent = `Edit project — ${project.name}`;
        wrap.appendChild(heading);

        wrap.appendChild(renderTitleAbbrRow(project));
        wrap.appendChild(renderSlugRow(project));
        wrap.appendChild(renderDescriptionRow(project));
        wrap.appendChild(renderColorRow(project));
        wrap.appendChild(renderReposRow(project));
        if (flowSnapshot !== null) {
            wrap.appendChild(renderAdvancedApprovalsSection(flowSnapshot));
        }
        wrap.appendChild(renderReadyFooter());
        return wrap;
    }

    function renderAdvancedApprovalsSection(
        flows: ReadonlyMap<string, ModalFlow>,
    ): ModalElement {
        const section = doc.createElement('section');
        section.className = 'ep-advanced-approvals';
        section.setAttribute('data-section', 'advanced-approvals');
        section.setAttribute('data-collapsed', advancedExpanded ? 'false' : 'true');

        const header = doc.createElement('div');
        header.className = 'ep-advanced-approvals__header';

        const toggle = doc.createElement('button') as ModalElementWithEvents;
        toggle.setAttribute('type', 'button');
        toggle.setAttribute('data-action', 'toggle-advanced-approvals');
        toggle.setAttribute('aria-expanded', advancedExpanded ? 'true' : 'false');
        toggle.className = 'ep-advanced-approvals__toggle';
        toggle.textContent = 'Advanced approvals';
        toggle.onclick = (): void => {
            advancedExpanded = !advancedExpanded;
            section.setAttribute('data-collapsed', advancedExpanded ? 'false' : 'true');
            toggle.setAttribute('aria-expanded', advancedExpanded ? 'true' : 'false');
            if (advancedBody) {
                advancedBody.setAttribute(
                    'data-collapsed',
                    advancedExpanded ? 'false' : 'true',
                );
            }
        };
        header.appendChild(toggle);
        section.appendChild(header);

        const body = doc.createElement('div');
        body.className = 'ep-advanced-approvals__body';
        body.setAttribute('data-advanced-approvals-body', '');
        body.setAttribute('data-collapsed', advancedExpanded ? 'false' : 'true');
        advancedBody = body;

        for (const [flowName, flow] of flows) {
            body.appendChild(renderFlowApprovalGroup(flowName, flow));
        }
        section.appendChild(body);
        return section;
    }

    function renderFlowApprovalGroup(
        flowName: string,
        flow: ModalFlow,
    ): ModalElement {
        const group = doc.createElement('div');
        group.className = 'ep-approval-flow';
        group.setAttribute('data-approval-flow', flowName);

        const heading = doc.createElement('h4');
        heading.className = 'ep-approval-flow__name';
        heading.setAttribute('data-approval-flow-name', '');
        heading.textContent = flowName;
        group.appendChild(heading);

        for (const step of flow.steps) {
            group.appendChild(renderApprovalStepRow(flowName, step));
        }
        return group;
    }

    function renderApprovalStepRow(
        flowName: string,
        step: ModalFlowStep,
    ): ModalElement {
        const row = doc.createElement('div');
        row.className = 'ep-approval-step';
        row.setAttribute('data-approval-step', step.id);
        row.setAttribute('data-approval-step-kind', step.agent);
        row.setAttribute('data-approval-flow-key', flowName);

        const knownKind = knownStepKinds.has(step.agent);
        if (!knownKind) {
            row.setAttribute('data-unknown-step-kind', '');
        }

        const stepLabel = doc.createElement('span');
        stepLabel.className = 'ep-approval-step__label';
        stepLabel.setAttribute('data-approval-step-label', '');
        stepLabel.textContent = `${step.id} (${step.agent})`;
        row.appendChild(stepLabel);

        const perStep = approvalValues.get(flowName);
        const initialValue: ApprovalModeValue =
            perStep?.get(step.id) ?? 'default';

        const dropdown = createApprovalModeDropdown(doc, {
            label: `${flowName} / ${step.id}`,
            value: initialValue,
            onChange: (next: ApprovalModeValue): void => {
                let target = approvalValues.get(flowName);
                if (!target) {
                    target = new Map<string, ApprovalModeValue>();
                    approvalValues.set(flowName, target);
                }
                target.set(step.id, next);
            },
        });
        approvalDropdowns.push(dropdown);
        row.appendChild(dropdown.element);

        if (!knownKind) {
            const note = doc.createElement('span');
            note.className = 'ep-approval-step__note';
            note.setAttribute('data-unknown-step-kind-note', '');
            note.setAttribute('role', 'note');
            note.textContent = 'unknown step kind';
            row.appendChild(note);
        }
        return row;
    }

    function renderSubmitting(s: EditProjectSubmitting): ModalElement {
        const wrap = doc.createElement('section');
        wrap.className = 'np-state np-state--submitting';
        wrap.setAttribute('data-state-body', 'ep-submitting');
        wrap.setAttribute('data-project-id', s.projectId);

        const msg = doc.createElement('p');
        msg.textContent = 'Saving changes…';
        wrap.appendChild(msg);

        const spinner = doc.createElement('div');
        spinner.className = 'np-spinner';
        spinner.setAttribute('role', 'status');
        spinner.setAttribute('aria-live', 'polite');
        spinner.textContent = 'Working…';
        wrap.appendChild(spinner);
        return wrap;
    }

    function renderUpdated(s: EditProjectUpdated): ModalElement {
        const wrap = doc.createElement('section');
        wrap.className = 'np-state np-state--updated';
        wrap.setAttribute('data-state-body', 'ep-updated');
        wrap.setAttribute('data-project-id', s.projectId);

        const msg = doc.createElement('p');
        msg.textContent = `Project "${s.name}" updated.`;
        wrap.appendChild(msg);

        wrap.appendChild(
            makeButton('Close', 'close', () => {
                close();
            }),
        );
        return wrap;
    }

    function renderError(s: EditProjectError): ModalElement {
        const wrap = doc.createElement('section');
        wrap.className = 'np-state np-state--error';
        wrap.setAttribute('data-state-body', 'ep-error');
        wrap.setAttribute('data-project-id', s.originalProjectId);

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

    function isApprovalModeValue(value: unknown): value is ApprovalModeValue {
        return (
            typeof value === 'string'
            && (APPROVAL_MODE_VALUES as ReadonlyArray<string>).includes(value)
        );
    }

    function errorMessage(err: unknown, fallback: string): string {
        if (err instanceof Error && err.message) return err.message;
        if (typeof err === 'string' && err.length > 0) return err;
        return fallback;
    }

    function getApprovalOverrideSnapshot(): ApprovalOverride | null {
        if (flowSnapshot === null) return null;
        return buildApprovalOverride();
    }

    function isAdvancedApprovalsExpanded(): boolean {
        return advancedExpanded;
    }

    function toggleAdvancedApprovals(): void {
        if (flowSnapshot === null) {
            throw new Error(
                'edit-project modal: toggleAdvancedApprovals() requires a '
                    + 'FlowProvider to be wired via deps.flows.',
            );
        }
        advancedExpanded = !advancedExpanded;
        if (advancedBody) {
            advancedBody.setAttribute(
                'data-collapsed',
                advancedExpanded ? 'false' : 'true',
            );
        }
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
        getApprovalOverride: getApprovalOverrideSnapshot,
        isAdvancedApprovalsExpanded,
        toggleAdvancedApprovals,
    };
}
