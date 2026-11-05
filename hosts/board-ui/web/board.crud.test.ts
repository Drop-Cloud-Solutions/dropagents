/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Unit tests for the AP-IFG-012 project / plan CRUD module.
 *
 * Coverage
 * --------
 * - {@link renderProjectList} / {@link renderPlanTree} produce the
 *   DOM shapes the host page expects: active vs archived buckets,
 *   per-row action buttons, the create-form ↔ create-button toggle
 *   driven by `state.creatingProject` / `state.creatingPlanForProjectId`,
 *   and the edit-form ↔ row toggle driven by `state.editingPlanId`.
 * - The handler callbacks fire with the right arguments when buttons
 *   are clicked, matching the controller's expected dispatch shape.
 * - {@link createBoardCrudController} hits the right v1 REST URLs with
 *   the right methods + JSON bodies, and refetches the affected
 *   projection after every mutation. The integration check is what
 *   guards AC #6 ("After mutation, affected list re-renders without a
 *   full page reload").
 *
 * Dual-runner discovery — see `./stage-bar.test.ts` header for the
 * rationale. Short version: `process.env.VITEST=true` routes to
 * vitest's `globalThis.test`; everywhere else uses `node:test`.
 */
import * as assert from 'node:assert/strict';

import {
    createBoardCrudController,
    initialBoardCrudState,
    renderPlanTree,
    renderProjectList,
    type BoardCrudPlan,
    type BoardCrudProject,
    type BoardCrudState,
    type FetchLike,
    type FetchRequestInit,
    type PlanTreeHandlers,
    type ProjectListHandlers,
    type RenderDocument,
    type RenderElement,
} from './board-crud';

// ---------------------------------------------------------------------------
// Dual-runner test() shim
// ---------------------------------------------------------------------------

type TestFn = (name: string, fn: () => void | Promise<void>) => void;

const test: TestFn = (((): TestFn => {
    if (process.env.VITEST) {
        const gt = (globalThis as { test?: TestFn }).test;
        if (typeof gt !== 'function') {
            throw new Error(
                'board.crud.test.ts: VITEST=true but globalThis.test is missing — '
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
// Minimal DOM shim — same shape as stage-bar.test.ts, kept self-contained
// so the two test files do not need to share a helper module.
// ---------------------------------------------------------------------------

interface ShimElement extends RenderElement {
    tagName: string;
    children: ShimElement[];
    attributes: Map<string, string>;
    onclick?: () => void;
    onsubmit?: () => void;
    value?: string;
}

function makeShimDocument(): RenderDocument {
    function makeElement(tagName: string): ShimElement {
        const attrs = new Map<string, string>();
        const children: ShimElement[] = [];
        const el: ShimElement = {
            tagName,
            className: '',
            textContent: null,
            title: '',
            hidden: false,
            children,
            attributes: attrs,
            setAttribute(name: string, value: string): void {
                attrs.set(name, value);
            },
            appendChild(child: RenderElement): RenderElement {
                children.push(child as ShimElement);
                return child;
            },
        };
        return el;
    }
    return {
        createElement(tagName: string): RenderElement {
            return makeElement(tagName);
        },
    };
}

function asShim(el: RenderElement | null): ShimElement {
    if (!el) throw new Error('expected a rendered element, got null');
    return el as ShimElement;
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
): ShimElement[] {
    const out: ShimElement[] = [];
    const walk = (n: ShimElement): void => {
        if (predicate(n)) out.push(n);
        for (const c of n.children) walk(c);
    };
    walk(root);
    return out;
}

function buttonByAction(root: ShimElement, action: string): ShimElement {
    const btn = findFirst(
        root,
        (el) => el.tagName === 'button' && el.attributes.get('data-action') === action,
    );
    if (!btn) {
        throw new Error(`no button with data-action="${action}" under <${root.tagName}>`);
    }
    return btn;
}

function click(el: ShimElement): void {
    if (!el.onclick) throw new Error('clicked element has no onclick');
    el.onclick();
}

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function project(overrides: Partial<BoardCrudProject> = {}): BoardCrudProject {
    return {
        id: 'p1',
        name: 'Pipeline',
        description: 'main repo',
        ...overrides,
    };
}

function plan(overrides: Partial<BoardCrudPlan> = {}): BoardCrudPlan {
    return {
        id: 'pl1',
        file: 'pl1.md',
        projectId: 'p1',
        title: 'Onboarding plan',
        status: 'draft',
        createdAt: 0,
        ...overrides,
    };
}

function state(overrides: Partial<BoardCrudState> = {}): BoardCrudState {
    return { ...initialBoardCrudState(), ...overrides };
}

function noopProjectHandlers(): ProjectListHandlers {
    return {
        onBeginCreate: () => {},
        onCancelCreate: () => {},
        onSubmitCreate: () => {},
        onSelect: () => {},
        onArchive: () => {},
    };
}

function noopPlanHandlers(): PlanTreeHandlers {
    return {
        onBeginCreate: () => {},
        onCancelCreate: () => {},
        onSubmitCreate: () => {},
        onBeginEdit: () => {},
        onCancelEdit: () => {},
        onSubmitEdit: () => {},
        onDelete: () => {},
    };
}

// ---------------------------------------------------------------------------
// renderProjectList — DOM structure + handler wiring
// ---------------------------------------------------------------------------

test('renderProjectList: emits one row per project plus a create slot (button mode)', () => {
    const doc = makeShimDocument();
    const root = asShim(
        renderProjectList(
            state({ projects: [project({ id: 'a' }), project({ id: 'b', name: 'Other' })] }),
            noopProjectHandlers(),
            doc,
        ),
    );

    assert.equal(root.tagName, 'ul');
    assert.equal(root.className, 'project-list');
    assert.ok(root.attributes.has('data-project-list'));

    const rows = findAll(root, (el) => el.attributes.has('data-project-row'));
    assert.equal(rows.length, 2);
    assert.deepEqual(
        rows.map((r) => r.attributes.get('data-project-id')),
        ['a', 'b'],
    );

    // Each active row has an Open + Archive button.
    for (const row of rows) {
        buttonByAction(row, 'select-project');
        buttonByAction(row, 'archive-project');
    }

    // Create slot is the trailing <li class="project-create">; in button
    // mode it holds the "begin-create-project" affordance.
    buttonByAction(root, 'begin-create-project');
});

test('renderProjectList: archived projects fall under a separate section header without the archive button', () => {
    const doc = makeShimDocument();
    const root = asShim(
        renderProjectList(
            state({
                projects: [
                    project({ id: 'a' }),
                    project({ id: 'b', name: 'Old', archivedAt: 12345 }),
                ],
            }),
            noopProjectHandlers(),
            doc,
        ),
    );

    const header = findFirst(
        root,
        (el) => el.attributes.get('data-section') === 'archived',
    );
    assert.ok(header, 'expected archived section header');
    const archivedRow = findFirst(
        root,
        (el) => el.attributes.get('data-project-id') === 'b',
    );
    assert.ok(archivedRow);
    assert.equal(archivedRow.attributes.get('data-archived'), 'true');
    // No archive button on an already-archived project.
    const archiveBtn = findFirst(
        archivedRow,
        (el) => el.attributes.get('data-action') === 'archive-project',
    );
    assert.equal(archiveBtn, null);
});

test('renderProjectList: marks the selected project row with data-selected', () => {
    const doc = makeShimDocument();
    const root = asShim(
        renderProjectList(
            state({
                projects: [project({ id: 'a' }), project({ id: 'b' })],
                selectedProjectId: 'b',
            }),
            noopProjectHandlers(),
            doc,
        ),
    );
    const selected = findAll(root, (el) => el.attributes.get('data-selected') === 'true');
    assert.equal(selected.length, 1);
    assert.equal(selected[0].attributes.get('data-project-id'), 'b');
});

test('renderProjectList: creatingProject swaps the button slot for an inline form', () => {
    const doc = makeShimDocument();
    const root = asShim(
        renderProjectList(
            state({ creatingProject: true }),
            noopProjectHandlers(),
            doc,
        ),
    );
    const form = findFirst(
        root,
        (el) => el.tagName === 'form' && el.attributes.get('data-action') === 'create-project',
    );
    assert.ok(form, 'expected inline create-project form');
    buttonByAction(form, 'submit-create-project');
    buttonByAction(form, 'cancel-create-project');
    // No "begin" button when the form is open.
    assert.equal(
        findFirst(
            root,
            (el) => el.attributes.get('data-action') === 'begin-create-project',
        ),
        null,
    );
});

test('renderProjectList: clicking archive fires onArchive with the project id', () => {
    const doc = makeShimDocument();
    let archived: string | null = null;
    const handlers: ProjectListHandlers = {
        ...noopProjectHandlers(),
        onArchive: (id) => {
            archived = id;
        },
    };
    const root = asShim(
        renderProjectList(
            state({ projects: [project({ id: 'p42' })] }),
            handlers,
            doc,
        ),
    );
    const row = findFirst(
        root,
        (el) => el.attributes.get('data-project-id') === 'p42',
    );
    assert.ok(row);
    click(buttonByAction(row, 'archive-project'));
    assert.equal(archived, 'p42');
});

test('renderProjectList: submitting the create form trims inputs and calls onSubmitCreate', () => {
    const doc = makeShimDocument();
    let captured: { name?: string; description?: string } | null = null;
    const handlers: ProjectListHandlers = {
        ...noopProjectHandlers(),
        onSubmitCreate: (input) => {
            captured = input;
        },
    };
    const root = asShim(
        renderProjectList(state({ creatingProject: true }), handlers, doc),
    );
    const form = asShim(
        findFirst(
            root,
            (el) => el.tagName === 'form' && el.attributes.get('data-action') === 'create-project',
        ),
    );
    const nameInput = asShim(
        findFirst(form, (el) => el.attributes.get('data-field') === 'name'),
    );
    const descInput = asShim(
        findFirst(form, (el) => el.attributes.get('data-field') === 'description'),
    );
    nameInput.value = '  New Project  ';
    descInput.value = '  shiny  ';
    click(buttonByAction(form, 'submit-create-project'));
    assert.deepEqual(captured, { name: 'New Project', description: 'shiny' });
});

// ---------------------------------------------------------------------------
// renderPlanTree — DOM structure + handler wiring
// ---------------------------------------------------------------------------

test('renderPlanTree: returns null when no project is selected', () => {
    const doc = makeShimDocument();
    const result = renderPlanTree(state(), noopPlanHandlers(), doc);
    assert.equal(result, null);
});

test('renderPlanTree: emits one row per plan plus a create-plan slot', () => {
    const doc = makeShimDocument();
    const root = asShim(
        renderPlanTree(
            state({
                selectedProjectId: 'p1',
                plans: [
                    plan({ id: 'pa', file: 'pa.md', title: 'Plan A' }),
                    plan({ id: 'pb', file: 'pb.md', title: 'Plan B' }),
                ],
            }),
            noopPlanHandlers(),
            doc,
        ),
    );
    assert.equal(root.attributes.get('data-project-id'), 'p1');
    const rows = findAll(root, (el) => el.attributes.has('data-plan-row'));
    assert.equal(rows.length, 2);
    assert.deepEqual(
        rows.map((r) => r.attributes.get('data-plan-id')),
        ['pa', 'pb'],
    );
    for (const row of rows) {
        buttonByAction(row, 'edit-plan');
        buttonByAction(row, 'delete-plan');
    }
    buttonByAction(root, 'begin-create-plan');
});

test('renderPlanTree: editingPlanId replaces the row with an inline edit form', () => {
    const doc = makeShimDocument();
    const root = asShim(
        renderPlanTree(
            state({
                selectedProjectId: 'p1',
                plans: [plan({ id: 'pa', file: 'pa.md' })],
                editingPlanId: 'pa',
            }),
            noopPlanHandlers(),
            doc,
        ),
    );
    const row = asShim(findFirst(root, (el) => el.attributes.get('data-plan-id') === 'pa'));
    const form = findFirst(
        row,
        (el) => el.tagName === 'form' && el.attributes.get('data-action') === 'edit-plan',
    );
    assert.ok(form, 'expected an inline edit form when editingPlanId matches');
    // Plain title span is gone while editing.
    assert.equal(
        findFirst(row, (el) => el.attributes.has('data-plan-title')),
        null,
    );
    buttonByAction(form, 'submit-edit-plan');
    buttonByAction(form, 'cancel-edit-plan');
});

test('renderPlanTree: delete button fires onDelete with (projectId, planFile)', () => {
    const doc = makeShimDocument();
    let captured: [string, string] | null = null;
    const handlers: PlanTreeHandlers = {
        ...noopPlanHandlers(),
        onDelete: (pid, file) => {
            captured = [pid, file];
        },
    };
    const root = asShim(
        renderPlanTree(
            state({
                selectedProjectId: 'p1',
                plans: [plan({ id: 'pa', file: 'pa.md' })],
            }),
            handlers,
            doc,
        ),
    );
    const row = asShim(findFirst(root, (el) => el.attributes.get('data-plan-id') === 'pa'));
    click(buttonByAction(row, 'delete-plan'));
    assert.deepEqual(captured, ['p1', 'pa.md']);
});

test('renderPlanTree: create-plan slot toggles to an inline form when creatingPlanForProjectId matches', () => {
    const doc = makeShimDocument();
    const root = asShim(
        renderPlanTree(
            state({
                selectedProjectId: 'p1',
                creatingPlanForProjectId: 'p1',
            }),
            noopPlanHandlers(),
            doc,
        ),
    );
    const form = findFirst(
        root,
        (el) => el.tagName === 'form' && el.attributes.get('data-action') === 'create-plan',
    );
    assert.ok(form, 'expected inline create-plan form');
    assert.equal(form.attributes.get('data-project-id'), 'p1');
});

// ---------------------------------------------------------------------------
// createBoardCrudController — dispatch + refetch behaviour
// ---------------------------------------------------------------------------

interface RecordedCall {
    readonly url: string;
    readonly method: string;
    readonly body?: unknown;
}

function makeFakeFetch(
    responses: ReadonlyMap<string, () => unknown>,
): { fetch: FetchLike; calls: RecordedCall[] } {
    const calls: RecordedCall[] = [];
    const fetch: FetchLike = async (
        url: string,
        init?: FetchRequestInit,
    ) => {
        const method = (init?.method ?? 'GET').toUpperCase();
        let body: unknown = undefined;
        if (typeof init?.body === 'string' && init.body.length > 0) {
            try {
                body = JSON.parse(init.body);
            } catch {
                body = init.body;
            }
        }
        calls.push({ url, method, body });
        const key = `${method} ${url}`;
        const producer = responses.get(key);
        const payload = producer ? producer() : { ok: true };
        return {
            ok: true,
            status: 200,
            async json(): Promise<unknown> {
                return payload;
            },
        };
    };
    return { fetch, calls };
}

test('controller.loadProjects: GETs /api/projects and stores the response', async () => {
    const projects: BoardCrudProject[] = [project({ id: 'a' }), project({ id: 'b' })];
    const { fetch, calls } = makeFakeFetch(
        new Map([['GET /api/projects', () => ({ projects })]]),
    );
    const controller = createBoardCrudController({ fetch });
    await controller.loadProjects();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'GET');
    assert.equal(calls[0].url, '/api/projects');
    assert.deepEqual(controller.state().projects, projects);
});

test('controller.createProject: POSTs the right body, hides the form, refetches', async () => {
    const { fetch, calls } = makeFakeFetch(
        new Map([['GET /api/projects', () => ({ projects: [project({ id: 'new' })] })]]),
    );
    const controller = createBoardCrudController({ fetch });
    controller.beginCreateProject();
    assert.equal(controller.state().creatingProject, true);

    await controller.createProject({ name: 'New Project', description: 'd' });

    // 1) POST then 2) GET refetch — AC #6.
    assert.equal(calls.length, 2);
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].url, '/api/projects');
    assert.deepEqual(calls[0].body, { name: 'New Project', description: 'd' });
    assert.equal(calls[1].method, 'GET');
    assert.equal(calls[1].url, '/api/projects');

    assert.equal(controller.state().creatingProject, false);
    assert.equal(controller.state().projects.length, 1);
});

test('controller.archiveProject: PATCHes /api/projects/:pid and refetches the project list', async () => {
    const { fetch, calls } = makeFakeFetch(
        new Map([['GET /api/projects', () => ({ projects: [] })]]),
    );
    const controller = createBoardCrudController({ fetch });
    await controller.archiveProject('p9');
    assert.equal(calls.length, 2);
    assert.equal(calls[0].method, 'PATCH');
    assert.equal(calls[0].url, '/api/projects/p9');
    // AC #3: archive is a PATCH on the project URL.
    assert.deepEqual(calls[0].body, { archived: true });
    assert.equal(calls[1].method, 'GET');
    assert.equal(calls[1].url, '/api/projects');
});

test('controller.selectProject: GETs /api/projects/:pid/plans and stores the response', async () => {
    const plans: BoardCrudPlan[] = [plan({ id: 'pa' }), plan({ id: 'pb' })];
    const { fetch, calls } = makeFakeFetch(
        new Map([['GET /api/projects/p1/plans', () => ({ plans })]]),
    );
    const controller = createBoardCrudController({ fetch });
    await controller.selectProject('p1');
    assert.equal(controller.state().selectedProjectId, 'p1');
    assert.deepEqual(controller.state().plans, plans);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, '/api/projects/p1/plans');
});

test('controller.createPlan: POSTs to the plans collection then refetches plans (not projects)', async () => {
    let planCallCount = 0;
    const { fetch, calls } = makeFakeFetch(
        new Map<string, () => unknown>([
            [
                'GET /api/projects/p1/plans',
                () => {
                    planCallCount++;
                    return { plans: [plan({ id: 'fresh' })] };
                },
            ],
        ]),
    );
    const controller = createBoardCrudController({ fetch });
    await controller.selectProject('p1');
    controller.beginCreatePlan('p1');
    await controller.createPlan('p1', { title: 'A title', body: 'A body' });

    // First call = selectProject's load; second = POST; third = refetch.
    assert.equal(calls.length, 3);
    assert.equal(calls[1].method, 'POST');
    assert.equal(calls[1].url, '/api/projects/p1/plans');
    assert.deepEqual(calls[1].body, { title: 'A title', body: 'A body' });
    assert.equal(calls[2].method, 'GET');
    assert.equal(calls[2].url, '/api/projects/p1/plans');
    assert.equal(planCallCount, 2);
    assert.equal(controller.state().creatingPlanForProjectId, null);
});

test('controller.updatePlan: PATCHes /api/projects/:pid/plans/:file, closes the editor, refetches', async () => {
    const { fetch, calls } = makeFakeFetch(
        new Map([['GET /api/projects/p1/plans', () => ({ plans: [] })]]),
    );
    const controller = createBoardCrudController({ fetch });
    controller.beginEditPlan('pa');
    assert.equal(controller.state().editingPlanId, 'pa');
    await controller.updatePlan('p1', 'pa.md', { title: 'New title' });
    assert.equal(calls[0].method, 'PATCH');
    assert.equal(calls[0].url, '/api/projects/p1/plans/pa.md');
    assert.deepEqual(calls[0].body, { title: 'New title' });
    assert.equal(calls[1].method, 'GET');
    assert.equal(calls[1].url, '/api/projects/p1/plans');
    assert.equal(controller.state().editingPlanId, null);
});

test('controller.deletePlan: DELETEs without a body and refetches plans', async () => {
    const { fetch, calls } = makeFakeFetch(
        new Map([['GET /api/projects/p1/plans', () => ({ plans: [] })]]),
    );
    const controller = createBoardCrudController({ fetch });
    await controller.deletePlan('p1', 'pa.md');
    assert.equal(calls[0].method, 'DELETE');
    assert.equal(calls[0].url, '/api/projects/p1/plans/pa.md');
    assert.equal(calls[0].body, undefined);
    assert.equal(calls[1].method, 'GET');
    assert.equal(calls[1].url, '/api/projects/p1/plans');
});

test('controller: failed mutation does NOT trigger a refetch (state stays as-is)', async () => {
    const calls: RecordedCall[] = [];
    const fetch: FetchLike = async (url, init) => {
        const method = (init?.method ?? 'GET').toUpperCase();
        calls.push({ url, method });
        if (method === 'POST') {
            return {
                ok: false,
                status: 400,
                async json(): Promise<unknown> {
                    return { error: 'rejected' };
                },
            };
        }
        return {
            ok: true,
            status: 200,
            async json(): Promise<unknown> {
                return { projects: [] };
            },
        };
    };
    const controller = createBoardCrudController({ fetch, logger: { warn: () => {} } });
    controller.beginCreateProject();
    await controller.createProject({ name: 'X' });
    // Only the failed POST — no refetch.
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'POST');
    // Form stays open so the operator can fix and retry.
    assert.equal(controller.state().creatingProject, true);
});

// ---------------------------------------------------------------------------
// Inline error surfacing (reviewer feedback on AP-IFG-012 attempt #1)
// ---------------------------------------------------------------------------
//
// The previous attempt swallowed mutation failures into a console.warn —
// the operator saw no visible reason for the form to refuse to close.
// These tests pin the contract: every mutation that fails must populate
// the matching state slot AND the renderer must surface that slot in the
// rendered DOM next to the offending form/row.

function failingFetch(
    method: string,
    status: number,
    bodyJson: unknown,
): { fetch: FetchLike; calls: RecordedCall[] } {
    const calls: RecordedCall[] = [];
    const fetch: FetchLike = async (url, init) => {
        const m = (init?.method ?? 'GET').toUpperCase();
        calls.push({ url, method: m });
        if (m === method) {
            return {
                ok: false,
                status,
                async json(): Promise<unknown> {
                    return bodyJson;
                },
            };
        }
        return {
            ok: true,
            status: 200,
            async json(): Promise<unknown> {
                return {};
            },
        };
    };
    return { fetch, calls };
}

test('controller.createProject: failed POST populates createProjectError with the server message', async () => {
    const { fetch } = failingFetch('POST', 422, { error: 'duplicate-name' });
    const controller = createBoardCrudController({ fetch, logger: { warn: () => {} } });
    controller.beginCreateProject();
    await controller.createProject({ name: 'X' });
    assert.equal(controller.state().createProjectError, 'duplicate-name');
    // Renderer surfaces the message inside the form.
    const root = asShim(
        renderProjectList(controller.state(), noopProjectHandlers(), makeShimDocument()),
    );
    const errSlot = findFirst(
        root,
        (el) =>
            el.attributes.get('data-error-for') === 'create-project'
            && (el.textContent ?? '').length > 0,
    );
    assert.ok(errSlot, 'expected an inline error slot inside the create-project form');
    assert.equal(errSlot.textContent, 'duplicate-name');
});

test('controller.archiveProject: failed PATCH populates archiveProjectErrors[id] and the row surfaces it', async () => {
    const { fetch } = failingFetch('PATCH', 500, { error: 'archive-blocked' });
    const controller = createBoardCrudController({ fetch, logger: { warn: () => {} } });
    // Seed a project so the row renderer has something to attach the error to.
    const seeded: BoardCrudState = {
        ...initialBoardCrudState(),
        projects: [project({ id: 'p7' })],
    };
    await controller.archiveProject('p7');
    assert.equal(controller.state().archiveProjectErrors['p7'], 'archive-blocked');

    const root = asShim(
        renderProjectList(
            { ...seeded, archiveProjectErrors: controller.state().archiveProjectErrors },
            noopProjectHandlers(),
            makeShimDocument(),
        ),
    );
    const row = asShim(
        findFirst(root, (el) => el.attributes.get('data-project-id') === 'p7'),
    );
    const errSlot = findFirst(
        row,
        (el) =>
            el.attributes.get('data-error-for') === 'archive-project'
            && el.attributes.get('data-project-id') === 'p7',
    );
    assert.ok(errSlot, 'expected an inline error slot in the failing project row');
    assert.equal(errSlot.textContent, 'archive-blocked');
});

test('controller.createPlan: failed POST populates createPlanError and the create-plan form renders it', async () => {
    const { fetch } = failingFetch('POST', 400, { error: 'title-required' });
    const controller = createBoardCrudController({ fetch, logger: { warn: () => {} } });
    await controller.selectProject('p1');
    controller.beginCreatePlan('p1');
    await controller.createPlan('p1', { title: 'X' });
    assert.equal(controller.state().createPlanError, 'title-required');
    const root = asShim(
        renderPlanTree(controller.state(), noopPlanHandlers(), makeShimDocument()),
    );
    const form = asShim(
        findFirst(
            root,
            (el) => el.tagName === 'form' && el.attributes.get('data-action') === 'create-plan',
        ),
    );
    const errSlot = findFirst(
        form,
        (el) =>
            el.attributes.get('data-error-for') === 'create-plan'
            && (el.textContent ?? '').length > 0,
    );
    assert.ok(errSlot, 'expected inline error inside the create-plan form');
    assert.equal(errSlot.textContent, 'title-required');
});

test('controller.updatePlan: failed PATCH populates editPlanError and the edit form renders it', async () => {
    const { fetch } = failingFetch('PATCH', 409, { error: 'plan-conflict' });
    const controller = createBoardCrudController({ fetch, logger: { warn: () => {} } });
    // Build a state where pa is in edit mode so the renderer chooses the form path.
    await controller.selectProject('p1');
    controller.beginEditPlan('pa');
    await controller.updatePlan('p1', 'pa.md', { title: 'X' });
    assert.equal(controller.state().editPlanError, 'plan-conflict');

    const renderState: BoardCrudState = {
        ...controller.state(),
        selectedProjectId: 'p1',
        plans: [plan({ id: 'pa', file: 'pa.md' })],
        editingPlanId: 'pa',
    };
    const root = asShim(
        renderPlanTree(renderState, noopPlanHandlers(), makeShimDocument()),
    );
    const form = asShim(
        findFirst(
            root,
            (el) => el.tagName === 'form' && el.attributes.get('data-action') === 'edit-plan',
        ),
    );
    const errSlot = findFirst(
        form,
        (el) =>
            el.attributes.get('data-error-for') === 'edit-plan'
            && (el.textContent ?? '').length > 0,
    );
    assert.ok(errSlot, 'expected inline error inside the edit-plan form');
    assert.equal(errSlot.textContent, 'plan-conflict');
});

test('controller.deletePlan: failed DELETE populates editPlanError (shared per-plan slot)', async () => {
    const { fetch } = failingFetch('DELETE', 500, { error: 'delete-failed' });
    const controller = createBoardCrudController({ fetch, logger: { warn: () => {} } });
    await controller.deletePlan('p1', 'pa.md');
    assert.equal(controller.state().editPlanError, 'delete-failed');
});

test('controller.createProject: missing body falls back to a status-coded message', async () => {
    const calls: RecordedCall[] = [];
    const fetch: FetchLike = async (url, init) => {
        const m = (init?.method ?? 'GET').toUpperCase();
        calls.push({ url, method: m });
        return {
            ok: false,
            status: 503,
            async json(): Promise<unknown> {
                throw new Error('no body');
            },
        };
    };
    const controller = createBoardCrudController({ fetch, logger: { warn: () => {} } });
    await controller.createProject({ name: 'X' });
    const err = controller.state().createProjectError ?? '';
    assert.ok(err.includes('503'), `expected status code in fallback message, got: ${err}`);
});

test('controller.beginCreateProject: clears a stale createProjectError', async () => {
    const { fetch } = failingFetch('POST', 400, { error: 'boom' });
    const controller = createBoardCrudController({ fetch, logger: { warn: () => {} } });
    controller.beginCreateProject();
    await controller.createProject({ name: 'X' });
    assert.equal(controller.state().createProjectError, 'boom');
    controller.beginCreateProject();
    assert.equal(controller.state().createProjectError, null);
});

test('controller: apiBase prefix is applied to every URL', async () => {
    const { fetch, calls } = makeFakeFetch(
        new Map([['GET http://upstream/api/projects', () => ({ projects: [] })]]),
    );
    const controller = createBoardCrudController({ fetch, apiBase: 'http://upstream/' });
    await controller.loadProjects();
    assert.equal(calls[0].url, 'http://upstream/api/projects');
});

test('controller.onChange: fires on every state transition', async () => {
    const transitions: BoardCrudState[] = [];
    const { fetch } = makeFakeFetch(
        new Map([['GET /api/projects', () => ({ projects: [project()] })]]),
    );
    const controller = createBoardCrudController({
        fetch,
        onChange: (s) => transitions.push(s),
    });
    controller.beginCreateProject();
    controller.cancelCreateProject();
    await controller.loadProjects();
    // 1 begin + 1 cancel + 1 load = 3 transitions, at minimum.
    assert.ok(transitions.length >= 3, `expected ≥3 transitions, got ${transitions.length}`);
});
