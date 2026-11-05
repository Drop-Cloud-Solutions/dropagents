/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Project / plan CRUD controller for the operator board SPA (AP-IFG-012).
 *
 * Pure, testable module that owns:
 *   - the in-memory state (projects + plans for the selected project)
 *   - the renderers for the project sidebar and the per-project plan tree
 *   - the dispatchers that call the v1-shaped REST routes from
 *     {@link ../server.ts#BOARD_UI_REST_ROUTES} (task-009) and re-fetch
 *     the affected projection from task-010 before triggering a re-render.
 *
 * The browser-side `hosts/board-ui/board.js` mirrors this module's
 * derivation by hand (same pattern as {@link ./stage-bar.ts} →
 * `board.js`'s inline pipeline-stage block). If you change a derivation
 * here, update the mirror — and vice versa — or the tests in
 * `./board.crud.test.ts` will fail.
 *
 * Architectural contract
 * ----------------------
 * - Reads go through {@link FetchLike} (a structural subset of
 *   `fetch()`). Tests inject a fake; the browser passes
 *   `globalThis.fetch.bind(globalThis)`.
 * - Renderers take {@link RenderDocument} (the same DOM-shim shape used
 *   by `stage-bar.ts`) so unit tests stay jsdom-free.
 * - Mutations always call `loadProjects()` or `loadPlans()` after the
 *   write returns, regardless of HTTP status — the projection is the
 *   single source of truth for what got committed.
 * - No mutation of the input state happens inside renderers. The
 *   controller updates state, then the renderers are called with the
 *   new state.
 */

// ---------------------------------------------------------------------------
// Projection shapes (v1-compatible, mirror ./projections.ts)
// ---------------------------------------------------------------------------

export interface BoardCrudProject {
    readonly id: string;
    readonly name: string;
    readonly description?: string;
    readonly archivedAt?: number;
}

export interface BoardCrudPlan {
    readonly id: string;
    readonly file: string;
    readonly projectId: string;
    readonly title: string;
    readonly status: string;
    readonly createdAt: number;
}

// ---------------------------------------------------------------------------
// State + handlers
// ---------------------------------------------------------------------------

/**
 * Snapshot of the project/plan UI state. The controller owns one
 * instance; renderers read it but never mutate it (the controller
 * builds the next snapshot and swaps it in).
 */
export interface BoardCrudState {
    readonly projects: ReadonlyArray<BoardCrudProject>;
    readonly plans: ReadonlyArray<BoardCrudPlan>;
    readonly selectedProjectId: string | null;
    readonly creatingProject: boolean;
    readonly creatingPlanForProjectId: string | null;
    readonly editingPlanId: string | null;
    /**
     * Inline error slots — populated by failed mutations so the renderer
     * can surface the server's complaint next to the offending form/row
     * instead of swallowing it into the console (reviewer feedback on
     * AP-IFG-012 attempt #1). Cleared on begin/cancel/success.
     */
    readonly createProjectError: string | null;
    readonly createPlanError: string | null;
    readonly editPlanError: string | null;
    /** Keyed by project id — one entry per project that just failed to archive. */
    readonly archiveProjectErrors: Readonly<Record<string, string>>;
}

export function initialBoardCrudState(): BoardCrudState {
    return {
        projects: [],
        plans: [],
        selectedProjectId: null,
        creatingProject: false,
        creatingPlanForProjectId: null,
        editingPlanId: null,
        createProjectError: null,
        createPlanError: null,
        editPlanError: null,
        archiveProjectErrors: {},
    };
}

/**
 * Inline form payloads the dispatchers consume. Mirror the REST route
 * shapes from `BOARD_UI_REST_ROUTES` so the browser body matches the
 * server-side validator without an extra translation step.
 */
export interface CreateProjectInput {
    readonly name: string;
    readonly description?: string;
}

export interface CreatePlanInput {
    readonly title: string;
    readonly body?: string;
}

export interface UpdatePlanInput {
    readonly title?: string;
    readonly body?: string;
}

// ---------------------------------------------------------------------------
// FetchLike — structural subset of the browser `fetch`
// ---------------------------------------------------------------------------

/**
 * Minimal Response surface the dispatchers consume. We never read the
 * body of a mutation response — `ok` and `status` are enough to decide
 * whether to refetch. The projection refetch reads `json()` so callers
 * must implement it on the fake.
 */
export interface FetchResponseLike {
    readonly ok: boolean;
    readonly status: number;
    json(): Promise<unknown>;
}

export interface FetchRequestInit {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
}

export type FetchLike = (input: string, init?: FetchRequestInit) => Promise<FetchResponseLike>;

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

/**
 * Injectable controller dependencies. `apiBase` mirrors the global
 * `WORKER_API_BASE` the SPA reads from `window` — empty string means
 * same-origin relative URLs.
 */
export interface BoardCrudDeps {
    readonly fetch: FetchLike;
    readonly apiBase?: string;
    /** Fired whenever the controller updates `state`. */
    readonly onChange?: (state: BoardCrudState) => void;
    /**
     * Logger for surfaced errors. Optional — defaults to a silent
     * no-op so tests can drive the controller without pulling stderr
     * noise into their golden output.
     */
    readonly logger?: { warn: (message: string, ...args: unknown[]) => void };
}

export interface BoardCrudController {
    state(): BoardCrudState;
    loadProjects(): Promise<void>;
    loadPlans(projectId: string): Promise<void>;
    selectProject(projectId: string): Promise<void>;
    beginCreateProject(): void;
    cancelCreateProject(): void;
    createProject(input: CreateProjectInput): Promise<void>;
    archiveProject(projectId: string): Promise<void>;
    beginCreatePlan(projectId: string): void;
    cancelCreatePlan(): void;
    createPlan(projectId: string, input: CreatePlanInput): Promise<void>;
    beginEditPlan(planId: string): void;
    cancelEditPlan(): void;
    updatePlan(
        projectId: string,
        planFile: string,
        input: UpdatePlanInput,
    ): Promise<void>;
    deletePlan(projectId: string, planFile: string): Promise<void>;
}

/**
 * Build a fresh controller. The instance owns a single `state` cell
 * that every method updates atomically (build the next snapshot, swap,
 * notify). Callers must NOT mutate the returned `state()` value.
 */
export function createBoardCrudController(
    deps: BoardCrudDeps,
): BoardCrudController {
    const apiBase = (deps.apiBase ?? '').replace(/\/+$/, '');
    let current: BoardCrudState = initialBoardCrudState();

    const setState = (next: BoardCrudState): void => {
        current = next;
        deps.onChange?.(current);
    };

    const fetchJson = async (
        method: string,
        path: string,
        body?: unknown,
    ): Promise<FetchResponseLike> => {
        const init: FetchRequestInit = { method };
        if (body !== undefined) {
            init.headers = { 'Content-Type': 'application/json' };
            init.body = JSON.stringify(body);
        }
        return deps.fetch(`${apiBase}${path}`, init);
    };

    /**
     * Pull a human-readable error message out of a non-ok response. Prefers
     * `{ error: string }` from the server (the worker-api convention) and
     * falls back to the status code so the operator always sees something
     * actionable even when the server returns no body.
     */
    const readErrorMessage = async (res: FetchResponseLike): Promise<string> => {
        try {
            const body = (await res.json()) as {
                error?: unknown;
                message?: unknown;
            };
            if (body && typeof body.error === 'string' && body.error) return body.error;
            if (body && typeof body.message === 'string' && body.message) return body.message;
        } catch {
            // fall through to the status-code message
        }
        return `Request failed (HTTP ${res.status})`;
    };

    const loadProjects = async (): Promise<void> => {
        const res = await deps.fetch(`${apiBase}/api/projects`, { method: 'GET' });
        if (!res.ok) {
            deps.logger?.warn('board-crud: GET /api/projects failed', res.status);
            return;
        }
        const json = (await res.json()) as { projects?: ReadonlyArray<BoardCrudProject> };
        const projects = Array.isArray(json.projects) ? json.projects : [];
        setState({ ...current, projects });
    };

    const loadPlans = async (projectId: string): Promise<void> => {
        const res = await deps.fetch(
            `${apiBase}/api/projects/${encodeURIComponent(projectId)}/plans`,
            { method: 'GET' },
        );
        if (!res.ok) {
            deps.logger?.warn('board-crud: GET /api/projects/:pid/plans failed', res.status);
            // Keep prior plans on error — refetch will retry on next mutation.
            return;
        }
        const json = (await res.json()) as { plans?: ReadonlyArray<BoardCrudPlan> };
        const plans = Array.isArray(json.plans) ? json.plans : [];
        setState({ ...current, plans });
    };

    const selectProject = async (projectId: string): Promise<void> => {
        setState({
            ...current,
            selectedProjectId: projectId,
            plans: [],
            creatingPlanForProjectId: null,
            editingPlanId: null,
        });
        await loadPlans(projectId);
    };

    const beginCreateProject = (): void => {
        setState({ ...current, creatingProject: true, createProjectError: null });
    };

    const cancelCreateProject = (): void => {
        setState({ ...current, creatingProject: false, createProjectError: null });
    };

    const createProject = async (input: CreateProjectInput): Promise<void> => {
        const body: Record<string, unknown> = { name: input.name };
        if (input.description !== undefined) body.description = input.description;
        const res = await fetchJson('POST', '/api/projects', body);
        if (!res.ok) {
            const message = await readErrorMessage(res);
            deps.logger?.warn('board-crud: POST /api/projects failed', res.status);
            setState({ ...current, createProjectError: message });
            return;
        }
        setState({ ...current, creatingProject: false, createProjectError: null });
        await loadProjects();
    };

    const archiveProject = async (projectId: string): Promise<void> => {
        // AP-IFG-012 AC #3: archive via PATCH on the v1-compatible
        // project URL. The route table maps PATCH /api/projects/:pid to
        // the UPDATE_PROJECT command — passing `{ archived: true }`
        // expresses the operator's intent in the payload so a future
        // ARCHIVE_PROJECT route can adopt the same body shape without a
        // client change.
        // Clear any prior archive error for this project before retrying so
        // the slot doesn't briefly show the stale message during the flight.
        if (current.archiveProjectErrors[projectId]) {
            const next = { ...current.archiveProjectErrors };
            delete next[projectId];
            setState({ ...current, archiveProjectErrors: next });
        }
        const res = await fetchJson(
            'PATCH',
            `/api/projects/${encodeURIComponent(projectId)}`,
            { archived: true },
        );
        if (!res.ok) {
            const message = await readErrorMessage(res);
            deps.logger?.warn('board-crud: PATCH archive failed', res.status);
            setState({
                ...current,
                archiveProjectErrors: {
                    ...current.archiveProjectErrors,
                    [projectId]: message,
                },
            });
            return;
        }
        await loadProjects();
    };

    const beginCreatePlan = (projectId: string): void => {
        setState({
            ...current,
            creatingPlanForProjectId: projectId,
            editingPlanId: null,
            createPlanError: null,
            editPlanError: null,
        });
    };

    const cancelCreatePlan = (): void => {
        setState({ ...current, creatingPlanForProjectId: null, createPlanError: null });
    };

    const createPlan = async (
        projectId: string,
        input: CreatePlanInput,
    ): Promise<void> => {
        const body: Record<string, unknown> = { title: input.title };
        if (input.body !== undefined) body.body = input.body;
        const res = await fetchJson(
            'POST',
            `/api/projects/${encodeURIComponent(projectId)}/plans`,
            body,
        );
        if (!res.ok) {
            const message = await readErrorMessage(res);
            deps.logger?.warn('board-crud: POST plan failed', res.status);
            setState({ ...current, createPlanError: message });
            return;
        }
        setState({ ...current, creatingPlanForProjectId: null, createPlanError: null });
        await loadPlans(projectId);
    };

    const beginEditPlan = (planId: string): void => {
        setState({
            ...current,
            editingPlanId: planId,
            creatingPlanForProjectId: null,
            editPlanError: null,
            createPlanError: null,
        });
    };

    const cancelEditPlan = (): void => {
        setState({ ...current, editingPlanId: null, editPlanError: null });
    };

    const updatePlan = async (
        projectId: string,
        planFile: string,
        input: UpdatePlanInput,
    ): Promise<void> => {
        const body: Record<string, unknown> = {};
        if (input.title !== undefined) body.title = input.title;
        if (input.body !== undefined) body.body = input.body;
        const res = await fetchJson(
            'PATCH',
            `/api/projects/${encodeURIComponent(projectId)}/plans/${encodeURIComponent(planFile)}`,
            body,
        );
        if (!res.ok) {
            const message = await readErrorMessage(res);
            deps.logger?.warn('board-crud: PATCH plan failed', res.status);
            setState({ ...current, editPlanError: message });
            return;
        }
        setState({ ...current, editingPlanId: null, editPlanError: null });
        await loadPlans(projectId);
    };

    const deletePlan = async (
        projectId: string,
        planFile: string,
    ): Promise<void> => {
        const res = await fetchJson(
            'DELETE',
            `/api/projects/${encodeURIComponent(projectId)}/plans/${encodeURIComponent(planFile)}`,
        );
        if (!res.ok) {
            const message = await readErrorMessage(res);
            deps.logger?.warn('board-crud: DELETE plan failed', res.status);
            // Re-use the edit-plan slot: a delete failure is per-plan and
            // the operator's eye is already on the same row.
            setState({ ...current, editPlanError: message });
            return;
        }
        await loadPlans(projectId);
    };

    return {
        state: () => current,
        loadProjects,
        loadPlans,
        selectProject,
        beginCreateProject,
        cancelCreateProject,
        createProject,
        archiveProject,
        beginCreatePlan,
        cancelCreatePlan,
        createPlan,
        beginEditPlan,
        cancelEditPlan,
        updatePlan,
        deletePlan,
    };
}

// ---------------------------------------------------------------------------
// Renderers — pure functions over `BoardCrudState`
// ---------------------------------------------------------------------------

/** Subset of `Element` the renderers touch. Same shape used by stage-bar. */
export interface RenderElement {
    className: string;
    textContent: string | null;
    title: string;
    hidden: boolean;
    setAttribute(name: string, value: string): void;
    appendChild(child: RenderElement): RenderElement;
}

export interface RenderDocument {
    createElement(tagName: string): RenderElement;
}

/** Click / submit handlers wired onto the rendered nodes. */
export interface ProjectListHandlers {
    readonly onBeginCreate: () => void;
    readonly onCancelCreate: () => void;
    readonly onSubmitCreate: (input: CreateProjectInput) => void;
    readonly onSelect: (projectId: string) => void;
    readonly onArchive: (projectId: string) => void;
}

export interface PlanTreeHandlers {
    readonly onBeginCreate: (projectId: string) => void;
    readonly onCancelCreate: () => void;
    readonly onSubmitCreate: (projectId: string, input: CreatePlanInput) => void;
    readonly onBeginEdit: (planId: string) => void;
    readonly onCancelEdit: () => void;
    readonly onSubmitEdit: (
        projectId: string,
        planFile: string,
        input: UpdatePlanInput,
    ) => void;
    readonly onDelete: (projectId: string, planFile: string) => void;
}

interface MaybeGlobalDocument {
    document?: RenderDocument;
}

function resolveDocument(doc: RenderDocument | undefined): RenderDocument {
    if (doc) return doc;
    const candidate = (globalThis as MaybeGlobalDocument).document;
    if (!candidate) {
        throw new Error(
            'board-crud: no document available — pass one explicitly when '
                + 'rendering outside a browser context.',
        );
    }
    return candidate;
}

/**
 * Capture a click on a button. The renderer wires this onto the
 * element via `setAttribute` so the DOM-shim tests can introspect the
 * intended handler without needing a real event system.
 */
interface RenderElementWithEvents extends RenderElement {
    onclick?: () => void;
    onsubmit?: () => void;
    value?: string;
}

function attachClick(el: RenderElement, handler: () => void): void {
    (el as RenderElementWithEvents).onclick = handler;
}

function attachSubmit(el: RenderElement, handler: () => void): void {
    (el as RenderElementWithEvents).onsubmit = handler;
}

function makeButton(
    doc: RenderDocument,
    label: string,
    action: string,
    onClick: () => void,
): RenderElement {
    const btn = doc.createElement('button');
    btn.setAttribute('type', 'button');
    btn.setAttribute('data-action', action);
    btn.textContent = label;
    attachClick(btn, onClick);
    return btn;
}

function makeInput(
    doc: RenderDocument,
    name: string,
    initial: string,
): RenderElement {
    const input = doc.createElement('input');
    input.setAttribute('type', 'text');
    input.setAttribute('name', name);
    input.setAttribute('data-field', name);
    (input as RenderElementWithEvents).value = initial;
    return input;
}

function makeTextarea(
    doc: RenderDocument,
    name: string,
    initial: string,
): RenderElement {
    const ta = doc.createElement('textarea');
    ta.setAttribute('name', name);
    ta.setAttribute('data-field', name);
    (ta as RenderElementWithEvents).value = initial;
    return ta;
}

/**
 * Render the project sidebar: a list of projects (with select +
 * archive buttons per row) and a "Create project" affordance that
 * either shows a button or an inline form, driven by
 * `state.creatingProject`. Returns the root `<ul>`.
 *
 * The renderer is pure of the state — it neither reads nor writes
 * anything outside the input. The click handlers, on the other hand,
 * are user-supplied so they can dispatch through whatever controller
 * the caller is using.
 *
 * DOM shape (kept stable for board.css + tests):
 *
 *   <ul class="project-list" data-project-list>
 *     <li class="project-row" data-project-id="<id>" …>
 *       <span class="project-name">…</span>
 *       <button data-action="select-project">Open</button>
 *       <button data-action="archive-project">Archive</button>
 *     </li>
 *     …
 *     <li class="project-create">
 *       <button data-action="begin-create-project">+ Create project</button>
 *       — OR (when state.creatingProject) —
 *       <form data-action="create-project">
 *         <input data-field="name"><input data-field="description">
 *         <button data-action="submit-create-project">Save</button>
 *         <button data-action="cancel-create-project">Cancel</button>
 *       </form>
 *     </li>
 *   </ul>
 */
export function renderProjectList(
    state: BoardCrudState,
    handlers: ProjectListHandlers,
    doc?: RenderDocument,
): RenderElement {
    const d = resolveDocument(doc);
    const root = d.createElement('ul');
    root.className = 'project-list';
    root.setAttribute('data-project-list', '');

    // One row per active project (archived ones go into a separate
    // bucket below so the list stays useful for the operator).
    const active = state.projects.filter((p) => !p.archivedAt);
    const archived = state.projects.filter((p) => !!p.archivedAt);

    for (const project of active) {
        root.appendChild(renderProjectRow(d, project, state, handlers));
    }

    if (archived.length > 0) {
        const header = d.createElement('li');
        header.className = 'project-archived-header';
        header.setAttribute('data-section', 'archived');
        header.textContent = 'Archived';
        root.appendChild(header);
        for (const project of archived) {
            root.appendChild(renderProjectRow(d, project, state, handlers));
        }
    }

    const createSlot = d.createElement('li');
    createSlot.className = 'project-create';
    if (state.creatingProject) {
        createSlot.appendChild(renderCreateProjectForm(d, state, handlers));
    } else {
        createSlot.appendChild(
            makeButton(
                d,
                '+ Create project',
                'begin-create-project',
                handlers.onBeginCreate,
            ),
        );
    }
    root.appendChild(createSlot);

    return root;
}

function renderProjectRow(
    d: RenderDocument,
    project: BoardCrudProject,
    state: BoardCrudState,
    handlers: ProjectListHandlers,
): RenderElement {
    const row = d.createElement('li');
    row.className = 'project-row';
    row.setAttribute('data-project-row', '');
    row.setAttribute('data-project-id', project.id);
    if (project.id === state.selectedProjectId) {
        row.className = 'project-row project-row--selected';
        row.setAttribute('data-selected', 'true');
    }
    if (project.archivedAt) {
        row.setAttribute('data-archived', 'true');
    }

    const name = d.createElement('span');
    name.className = 'project-name';
    name.setAttribute('data-project-name', '');
    name.textContent = project.name;
    row.appendChild(name);

    const selectBtn = makeButton(d, 'Open', 'select-project', () =>
        handlers.onSelect(project.id),
    );
    row.appendChild(selectBtn);

    if (!project.archivedAt) {
        const archiveBtn = makeButton(d, 'Archive', 'archive-project', () =>
            handlers.onArchive(project.id),
        );
        row.appendChild(archiveBtn);
    }

    // Inline archive-error slot — populated by a failed PATCH so the
    // operator sees the server's complaint next to the row that failed
    // (reviewer feedback on AP-IFG-012 attempt #1).
    const archiveError = state.archiveProjectErrors[project.id];
    if (archiveError) {
        const errSlot = d.createElement('span');
        errSlot.className = 'project-row-error';
        errSlot.setAttribute('data-error-for', 'archive-project');
        errSlot.setAttribute('data-project-id', project.id);
        errSlot.setAttribute('role', 'alert');
        errSlot.textContent = archiveError;
        row.appendChild(errSlot);
    }

    return row;
}

/**
 * Inline error slot appended to a form. Always rendered (so tests can
 * locate the element deterministically); hidden when no message is set.
 */
function renderFormError(
    d: RenderDocument,
    scope: string,
    message: string | null,
): RenderElement {
    const slot = d.createElement('div');
    slot.className = 'form-error';
    slot.setAttribute('data-error-for', scope);
    slot.setAttribute('role', 'alert');
    if (message) {
        slot.textContent = message;
    } else {
        slot.hidden = true;
        slot.textContent = '';
    }
    return slot;
}

function renderCreateProjectForm(
    d: RenderDocument,
    state: BoardCrudState,
    handlers: ProjectListHandlers,
): RenderElement {
    const form = d.createElement('form');
    form.className = 'project-create-form';
    form.setAttribute('data-action', 'create-project');

    const nameInput = makeInput(d, 'name', '');
    nameInput.setAttribute('placeholder', 'Project name');
    nameInput.setAttribute('required', 'required');
    form.appendChild(nameInput);

    const descInput = makeInput(d, 'description', '');
    descInput.setAttribute('placeholder', 'Description (optional)');
    form.appendChild(descInput);

    form.appendChild(renderFormError(d, 'create-project', state.createProjectError));

    const submit = makeButton(d, 'Save', 'submit-create-project', () => {
        const name = ((nameInput as RenderElementWithEvents).value ?? '').trim();
        if (!name) return;
        const description = (
            (descInput as RenderElementWithEvents).value ?? ''
        ).trim();
        handlers.onSubmitCreate({
            name,
            description: description || undefined,
        });
    });
    form.appendChild(submit);

    const cancel = makeButton(
        d,
        'Cancel',
        'cancel-create-project',
        handlers.onCancelCreate,
    );
    form.appendChild(cancel);

    attachSubmit(form, () => {
        const name = ((nameInput as RenderElementWithEvents).value ?? '').trim();
        if (!name) return;
        const description = (
            (descInput as RenderElementWithEvents).value ?? ''
        ).trim();
        handlers.onSubmitCreate({
            name,
            description: description || undefined,
        });
    });

    return form;
}

/**
 * Render the plan tree for the selected project. Returns either the
 * root `<ul>` of plans, or `null` when no project is selected (the
 * caller leaves the host slot empty in that case). Each row carries
 * Edit and Delete buttons; Edit toggles inline to a save/cancel form
 * driven by `state.editingPlanId`.
 *
 * DOM shape:
 *
 *   <ul class="plan-tree" data-plan-tree data-project-id="<pid>">
 *     <li class="plan-row" data-plan-id data-plan-file>
 *       <span class="plan-title">…</span>
 *       <span class="plan-status">…</span>
 *       <button data-action="edit-plan">Edit</button>
 *       <button data-action="delete-plan">Delete</button>
 *       — OR (when editingPlanId === plan.id) —
 *       <form data-action="edit-plan">…</form>
 *     </li>
 *     …
 *     <li class="plan-create">…create button or form…</li>
 *   </ul>
 */
export function renderPlanTree(
    state: BoardCrudState,
    handlers: PlanTreeHandlers,
    doc?: RenderDocument,
): RenderElement | null {
    if (!state.selectedProjectId) return null;
    const projectId = state.selectedProjectId;
    const d = resolveDocument(doc);

    const root = d.createElement('ul');
    root.className = 'plan-tree';
    root.setAttribute('data-plan-tree', '');
    root.setAttribute('data-project-id', projectId);

    for (const plan of state.plans) {
        root.appendChild(renderPlanRow(d, plan, projectId, state, handlers));
    }

    const createSlot = d.createElement('li');
    createSlot.className = 'plan-create';
    if (state.creatingPlanForProjectId === projectId) {
        createSlot.appendChild(renderCreatePlanForm(d, projectId, state, handlers));
    } else {
        createSlot.appendChild(
            makeButton(d, '+ Create plan', 'begin-create-plan', () =>
                handlers.onBeginCreate(projectId),
            ),
        );
    }
    root.appendChild(createSlot);

    return root;
}

function renderPlanRow(
    d: RenderDocument,
    plan: BoardCrudPlan,
    projectId: string,
    state: BoardCrudState,
    handlers: PlanTreeHandlers,
): RenderElement {
    const row = d.createElement('li');
    row.className = 'plan-row';
    row.setAttribute('data-plan-row', '');
    row.setAttribute('data-plan-id', plan.id);
    row.setAttribute('data-plan-file', plan.file);

    if (state.editingPlanId === plan.id) {
        row.appendChild(renderEditPlanForm(d, plan, projectId, state, handlers));
        return row;
    }

    const title = d.createElement('span');
    title.className = 'plan-title';
    title.setAttribute('data-plan-title', '');
    title.textContent = plan.title;
    row.appendChild(title);

    const status = d.createElement('span');
    status.className = 'plan-status';
    status.setAttribute('data-plan-status', '');
    status.textContent = plan.status;
    row.appendChild(status);

    const editBtn = makeButton(d, 'Edit', 'edit-plan', () =>
        handlers.onBeginEdit(plan.id),
    );
    row.appendChild(editBtn);

    const deleteBtn = makeButton(d, 'Delete', 'delete-plan', () =>
        handlers.onDelete(projectId, plan.file),
    );
    row.appendChild(deleteBtn);

    return row;
}

function renderCreatePlanForm(
    d: RenderDocument,
    projectId: string,
    state: BoardCrudState,
    handlers: PlanTreeHandlers,
): RenderElement {
    const form = d.createElement('form');
    form.className = 'plan-create-form';
    form.setAttribute('data-action', 'create-plan');
    form.setAttribute('data-project-id', projectId);

    const titleInput = makeInput(d, 'title', '');
    titleInput.setAttribute('placeholder', 'Plan title');
    titleInput.setAttribute('required', 'required');
    form.appendChild(titleInput);

    const bodyInput = makeTextarea(d, 'body', '');
    bodyInput.setAttribute('placeholder', 'Plan body (optional)');
    form.appendChild(bodyInput);

    form.appendChild(renderFormError(d, 'create-plan', state.createPlanError));

    const submit = (): void => {
        const title = ((titleInput as RenderElementWithEvents).value ?? '').trim();
        if (!title) return;
        const body = ((bodyInput as RenderElementWithEvents).value ?? '').trim();
        handlers.onSubmitCreate(projectId, {
            title,
            body: body || undefined,
        });
    };

    form.appendChild(
        makeButton(d, 'Save', 'submit-create-plan', submit),
    );
    form.appendChild(
        makeButton(d, 'Cancel', 'cancel-create-plan', handlers.onCancelCreate),
    );

    attachSubmit(form, submit);

    return form;
}

function renderEditPlanForm(
    d: RenderDocument,
    plan: BoardCrudPlan,
    projectId: string,
    state: BoardCrudState,
    handlers: PlanTreeHandlers,
): RenderElement {
    const form = d.createElement('form');
    form.className = 'plan-edit-form';
    form.setAttribute('data-action', 'edit-plan');
    form.setAttribute('data-plan-id', plan.id);
    form.setAttribute('data-plan-file', plan.file);
    form.setAttribute('data-project-id', projectId);

    const titleInput = makeInput(d, 'title', plan.title);
    titleInput.setAttribute('placeholder', 'Plan title');
    form.appendChild(titleInput);

    const bodyInput = makeTextarea(d, 'body', '');
    bodyInput.setAttribute('placeholder', 'Plan body (optional)');
    form.appendChild(bodyInput);

    form.appendChild(renderFormError(d, 'edit-plan', state.editPlanError));

    const submit = (): void => {
        const title = ((titleInput as RenderElementWithEvents).value ?? '').trim();
        const body = ((bodyInput as RenderElementWithEvents).value ?? '').trim();
        const input: UpdatePlanInput = {};
        if (title && title !== plan.title) (input as { title?: string }).title = title;
        if (body) (input as { body?: string }).body = body;
        handlers.onSubmitEdit(projectId, plan.file, input);
    };

    form.appendChild(makeButton(d, 'Save', 'submit-edit-plan', submit));
    form.appendChild(
        makeButton(d, 'Cancel', 'cancel-edit-plan', handlers.onCancelEdit),
    );

    attachSubmit(form, submit);

    return form;
}
