/**
 * Unit tests for the AP-PAO-015 Advanced approvals section of the
 * edit-project modal.
 *
 * Coverage targets the task's acceptance criteria:
 *   AC #1 The modal renders a collapsed 'Advanced approvals' section
 *         (data-section + data-collapsed="true" by default).
 *   AC #2 Every step from every flow YAML is listed with its own
 *         approval-mode dropdown — verified by counting rendered rows.
 *   AC #3 Dropdowns are pre-populated from the project's existing
 *         approval_override; absent entries fall back to 'default'.
 *   AC #4 Save dispatches UpdateProjectApprovalOverride through the
 *         command sink with the shape
 *         `{ [flowName]: { [stepId]: 'auto' | 'required' | 'default' } }`.
 *   AC #5 Unknown step kinds render with a 'default' value, a
 *         `data-unknown-step-kind` marker, and a visible note.
 *   AC #6 Unit tests cover: empty initial override, partial existing
 *         override, save dispatch payload shape, unknown-kind fallback.
 *
 * Dual-runner discovery
 * ---------------------
 * Same pattern as project-form-fields.test.ts: vitest when VITEST=true,
 * node:test otherwise. A single source file is discovered + executed by
 * both `npm test` and `npx vitest run`.
 */
import * as assert from 'node:assert/strict';

import {
    APPROVAL_MODE_VALUES,
    createEditProjectModal,
    type ApprovalModeValue,
    type ApprovalOverride,
    type EditProjectCommandSink,
    type EditProjectInput,
    type FlowProvider,
    type ModalDocument,
    type ModalElement,
    type ModalFlow,
    type OverlayManagerLike,
    type ShowToastFn,
    type ToastInput,
    type UpdateApprovalOverrideInput,
    type UpdateProjectInput,
} from './edit-project';

// ---------------------------------------------------------------------------
// Dual-runner test() shim
// ---------------------------------------------------------------------------

type TestFn = (name: string, fn: () => void | Promise<void>) => void;

const test: TestFn = (((): TestFn => {
    if (process.env.VITEST) {
        const gt = (globalThis as { test?: TestFn }).test;
        if (typeof gt !== 'function') {
            throw new Error(
                'edit-project.test.ts: VITEST=true but globalThis.test is missing — '
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
// Minimal DOM shim — same shape as the sibling project-form-fields.test.ts
// ---------------------------------------------------------------------------

interface ShimElement extends ModalElement {
    readonly tagName: string;
    readonly children: ShimElement[];
    readonly attributes: Map<string, string>;
    parent: ShimElement | null;
    onclick?: () => void;
    onchange?: () => void;
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

interface ShimDocument extends ModalDocument {
    readonly overlayRoot: ShimElement;
}

function makeShimDocument(): ShimDocument {
    const overlayRoot = makeShimElement('div');
    overlayRoot.setAttribute('id', 'overlay-root');
    return {
        overlayRoot,
        getElementById(id: string): ModalElement | null {
            return id === 'overlay-root' ? overlayRoot : null;
        },
        createElement(tag: string): ModalElement {
            return makeShimElement(tag);
        },
    };
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

// ---------------------------------------------------------------------------
// Test fakes — overlay manager, command sink, toast sink
// ---------------------------------------------------------------------------

interface OverlayCall {
    readonly kind: 'open' | 'close';
    readonly id: string;
    readonly element?: unknown;
}

function makeOverlayManager(): {
    manager: OverlayManagerLike;
    calls: OverlayCall[];
} {
    const calls: OverlayCall[] = [];
    return {
        calls,
        manager: {
            openOverlay(id, element): unknown {
                calls.push({ kind: 'open', id, element });
                return null;
            },
            closeOverlay(id): void {
                calls.push({ kind: 'close', id });
            },
        },
    };
}

interface UpdateProjectCall {
    readonly kind: 'updateProject';
    readonly input: UpdateProjectInput;
}
interface UpdateApprovalCall {
    readonly kind: 'updateApprovalOverride';
    readonly input: UpdateApprovalOverrideInput;
}
type SinkCall = UpdateProjectCall | UpdateApprovalCall;

function makeCommandSink(): {
    sink: EditProjectCommandSink;
    calls: SinkCall[];
} {
    const calls: SinkCall[] = [];
    return {
        calls,
        sink: {
            async updateProject(
                input: UpdateProjectInput,
            ): Promise<{ readonly projectId: string }> {
                calls.push({ kind: 'updateProject', input });
                return { projectId: input.projectId };
            },
            async updateApprovalOverride(
                input: UpdateApprovalOverrideInput,
            ): Promise<void> {
                calls.push({ kind: 'updateApprovalOverride', input });
            },
        },
    };
}

function makeToast(): { toasts: ToastInput[]; showToast: ShowToastFn } {
    const toasts: ToastInput[] = [];
    return { toasts, showToast: (t): void => void toasts.push(t) };
}

// ---------------------------------------------------------------------------
// Flow fixture — two flows, several steps, one unknown agent kind
// ---------------------------------------------------------------------------

const KNOWN_KINDS = new Set([
    'developer',
    'reviewer',
    'tester',
    'commit-approval',
    'merge-approval',
    'wait-action',
]);

function fixtureFlows(): ReadonlyMap<string, ModalFlow> {
    const flows = new Map<string, ModalFlow>();
    flows.set('implement', {
        steps: [
            { id: 'dev', agent: 'developer' },
            { id: 'review', agent: 'reviewer' },
            { id: 'test', agent: 'tester' },
            { id: 'gate', agent: 'commit-approval' },
        ],
    });
    flows.set('merge', {
        steps: [
            { id: 'gate', agent: 'merge-approval' },
            { id: 'park', agent: 'wait-action' },
        ],
    });
    return flows;
}

function fixtureFlowProvider(): FlowProvider {
    const flows = fixtureFlows();
    return { loadFlows: (): ReadonlyMap<string, ModalFlow> => flows };
}

function baseInput(): EditProjectInput {
    return { projectId: 'alpha', name: 'Alpha' };
}

// ---------------------------------------------------------------------------
// Helpers — pull approval-mode dropdowns out of a rendered panel
// ---------------------------------------------------------------------------

function panelOf(doc: ShimDocument): ShimElement {
    const p = findFirst(
        doc.overlayRoot,
        (n) => n.attributes.has('data-edit-project-modal'),
    );
    if (!p) throw new Error('edit-project panel not mounted under overlay-root');
    return p;
}

function approvalRows(panel: ShimElement): ShimElement[] {
    return findAll(panel, (n) => n.attributes.has('data-approval-step'));
}

interface RowSnapshot {
    readonly flow: string;
    readonly stepId: string;
    readonly kind: string;
    readonly value: string;
    readonly unknown: boolean;
    readonly noteVisible: boolean;
}

function snapshotRow(row: ShimElement): RowSnapshot {
    const select = findFirst(row, (n) =>
        n.attributes.has('data-approval-mode-select'),
    );
    const note = findFirst(row, (n) =>
        n.attributes.has('data-unknown-step-kind-note'),
    );
    return {
        flow: row.attributes.get('data-approval-flow-key') ?? '',
        stepId: row.attributes.get('data-approval-step') ?? '',
        kind: row.attributes.get('data-approval-step-kind') ?? '',
        value: select?.value ?? '',
        unknown: row.attributes.has('data-unknown-step-kind'),
        noteVisible: note !== null,
    };
}

// ---------------------------------------------------------------------------
// AC #1 — collapsed Advanced approvals section is present after open()
// ---------------------------------------------------------------------------

test('renders a collapsed Advanced approvals section by default', () => {
    const doc = makeShimDocument();
    const { manager } = makeOverlayManager();
    const { sink } = makeCommandSink();
    const { showToast } = makeToast();
    const modal = createEditProjectModal({
        overlayManager: manager,
        commands: sink,
        showToast,
        doc,
        flows: fixtureFlowProvider(),
        knownStepKinds: KNOWN_KINDS,
    });
    modal.open(baseInput());

    const panel = panelOf(doc);
    const section = findFirst(panel, (n) =>
        n.attributes.get('data-section') === 'advanced-approvals',
    );
    assert.ok(section, 'expected an advanced-approvals section');
    assert.equal(section.attributes.get('data-collapsed'), 'true');
    assert.equal(modal.isAdvancedApprovalsExpanded(), false);

    const toggle = findFirst(section, (n) =>
        n.attributes.get('data-action') === 'toggle-advanced-approvals',
    );
    assert.ok(toggle, 'expected a toggle button');
    assert.equal(toggle.attributes.get('aria-expanded'), 'false');
});

// ---------------------------------------------------------------------------
// AC #6.a — empty initial override: every step listed, every dropdown 'default'
// ---------------------------------------------------------------------------

test('empty initial override renders every step at "default"', () => {
    const doc = makeShimDocument();
    const { manager } = makeOverlayManager();
    const { sink } = makeCommandSink();
    const { showToast } = makeToast();
    const modal = createEditProjectModal({
        overlayManager: manager,
        commands: sink,
        showToast,
        doc,
        flows: fixtureFlowProvider(),
        knownStepKinds: KNOWN_KINDS,
    });
    modal.open(baseInput());

    const panel = panelOf(doc);
    const rows = approvalRows(panel).map(snapshotRow);
    // 4 steps (implement) + 2 steps (merge) = 6
    assert.equal(rows.length, 6);
    for (const r of rows) {
        assert.equal(r.value, 'default', `row ${r.flow}/${r.stepId} should default`);
        assert.equal(r.unknown, false);
        assert.equal(r.noteVisible, false);
    }

    const snapshot = modal.getApprovalOverride();
    assert.ok(snapshot, 'expected an override snapshot');
    assert.deepEqual(snapshot, {
        implement: {
            dev: 'default',
            review: 'default',
            test: 'default',
            gate: 'default',
        },
        merge: {
            gate: 'default',
            park: 'default',
        },
    });
});

// ---------------------------------------------------------------------------
// AC #6.b — partial existing override: matching entries pre-populated,
// others left at 'default'
// ---------------------------------------------------------------------------

test('partial existing override pre-populates only matching step rows', () => {
    const doc = makeShimDocument();
    const { manager } = makeOverlayManager();
    const { sink } = makeCommandSink();
    const { showToast } = makeToast();

    const existing: ApprovalOverride = {
        implement: { dev: 'auto', gate: 'required' },
        merge: { gate: 'required' },
    };

    const modal = createEditProjectModal({
        overlayManager: manager,
        commands: sink,
        showToast,
        doc,
        flows: fixtureFlowProvider(),
        knownStepKinds: KNOWN_KINDS,
    });
    modal.open({ ...baseInput(), approvalOverride: existing });

    const panel = panelOf(doc);
    const byKey: Record<string, RowSnapshot> = {};
    for (const row of approvalRows(panel)) {
        const s = snapshotRow(row);
        byKey[`${s.flow}/${s.stepId}`] = s;
    }

    assert.equal(byKey['implement/dev'].value, 'auto');
    assert.equal(byKey['implement/gate'].value, 'required');
    assert.equal(byKey['merge/gate'].value, 'required');
    // Unmentioned steps remain at 'default'.
    assert.equal(byKey['implement/review'].value, 'default');
    assert.equal(byKey['implement/test'].value, 'default');
    assert.equal(byKey['merge/park'].value, 'default');

    // The handle's snapshot must match what the DOM is showing.
    assert.deepEqual(modal.getApprovalOverride(), {
        implement: {
            dev: 'auto',
            review: 'default',
            test: 'default',
            gate: 'required',
        },
        merge: {
            gate: 'required',
            park: 'default',
        },
    });
});

// ---------------------------------------------------------------------------
// AC #6.c — save dispatch payload shape: updateApprovalOverride called
// with the full two-level map after the main update succeeds.
// ---------------------------------------------------------------------------

test('submit() dispatches UpdateProjectApprovalOverride with the full payload', async () => {
    const doc = makeShimDocument();
    const { manager } = makeOverlayManager();
    const { sink, calls } = makeCommandSink();
    const { showToast } = makeToast();

    const existing: ApprovalOverride = {
        implement: { dev: 'auto' },
    };

    const modal = createEditProjectModal({
        overlayManager: manager,
        commands: sink,
        showToast,
        doc,
        flows: fixtureFlowProvider(),
        knownStepKinds: KNOWN_KINDS,
    });
    modal.open({ ...baseInput(), approvalOverride: existing });

    // Mutate one dropdown via its onChange handler so the dispatched
    // payload reflects an operator-changed value, not just the seed.
    const panel = panelOf(doc);
    const reviewRow = findFirst(
        panel,
        (n) =>
            n.attributes.has('data-approval-step')
            && n.attributes.get('data-approval-step') === 'review'
            && n.attributes.get('data-approval-flow-key') === 'implement',
    );
    assert.ok(reviewRow, 'expected an implement/review row');
    const reviewSelect = findFirst(reviewRow, (n) =>
        n.attributes.has('data-approval-mode-select'),
    );
    assert.ok(reviewSelect, 'expected a select inside the review row');
    reviewSelect.value = 'required';
    reviewSelect.onchange?.();

    await modal.submit({ projectId: 'alpha', name: 'Alpha' });

    const update = calls.find((c) => c.kind === 'updateProject');
    const override = calls.find((c) => c.kind === 'updateApprovalOverride');
    assert.ok(update, 'updateProject was not dispatched');
    assert.ok(override, 'updateApprovalOverride was not dispatched');
    // The override call must come AFTER the project update.
    const upIdx = calls.indexOf(update);
    const ovIdx = calls.indexOf(override);
    assert.ok(ovIdx > upIdx, 'override should be dispatched after the main update');

    assert.equal(override.input.projectId, 'alpha');
    assert.deepEqual(override.input.approvalOverride, {
        implement: {
            dev: 'auto',
            review: 'required',
            test: 'default',
            gate: 'default',
        },
        merge: {
            gate: 'default',
            park: 'default',
        },
    });

    // The payload's leaf values are restricted to the three-value union.
    // Walk via keys so the index-signature value type (`ApprovalModeValue`)
    // is preserved — `Object.values()` on a `readonly` index signature
    // falls back to the loose overload that widens the leaf to `string`,
    // which would defeat the type-level assertion on the next line.
    const all = override.input.approvalOverride;
    for (const flowName of Object.keys(all)) {
        const flow = all[flowName];
        for (const stepId of Object.keys(flow)) {
            const leaf: ApprovalModeValue = flow[stepId];
            assert.ok(
                (APPROVAL_MODE_VALUES as ReadonlyArray<string>).includes(leaf),
                `leaf value "${leaf}" is not in APPROVAL_MODE_VALUES`,
            );
        }
    }
});

// ---------------------------------------------------------------------------
// AC #6.d — unknown step kind: row marked + visible note + value 'default'
// ---------------------------------------------------------------------------

test('unknown step kind renders default value and a visible note', () => {
    const doc = makeShimDocument();
    const { manager } = makeOverlayManager();
    const { sink, calls } = makeCommandSink();
    const { showToast } = makeToast();

    // A flow containing a step whose `agent` is NOT in the known-kinds
    // set. The modal should still render a row for it, but the row must
    // start at 'default' even when the override claims otherwise, and a
    // visible 'unknown step kind' note must appear next to the dropdown.
    const flows = new Map<string, ModalFlow>();
    flows.set('experimental', {
        steps: [
            { id: 'classify', agent: 'developer' },
            { id: 'mystery', agent: 'future-agent' },
        ],
    });
    const provider: FlowProvider = {
        loadFlows: (): ReadonlyMap<string, ModalFlow> => flows,
    };

    const modal = createEditProjectModal({
        overlayManager: manager,
        commands: sink,
        showToast,
        doc,
        flows: provider,
        knownStepKinds: KNOWN_KINDS,
    });
    // Override sets BOTH steps to 'required'; the unknown row must
    // ignore that and start at 'default'.
    modal.open({
        ...baseInput(),
        approvalOverride: {
            experimental: { classify: 'required', mystery: 'required' },
        },
    });

    const panel = panelOf(doc);
    const rows = approvalRows(panel).map(snapshotRow);
    assert.equal(rows.length, 2);

    const known = rows.find((r) => r.stepId === 'classify');
    const unknown = rows.find((r) => r.stepId === 'mystery');
    assert.ok(known && unknown);

    assert.equal(known.kind, 'developer');
    assert.equal(known.unknown, false);
    assert.equal(known.noteVisible, false);
    assert.equal(known.value, 'required');

    assert.equal(unknown.kind, 'future-agent');
    assert.equal(unknown.unknown, true);
    assert.equal(unknown.noteVisible, true);
    assert.equal(unknown.value, 'default');

    // The snapshot reflects the visible-state, not the persisted override.
    assert.deepEqual(modal.getApprovalOverride(), {
        experimental: {
            classify: 'required',
            mystery: 'default',
        },
    });

    // The text of the note is the operator-facing copy.
    const noteEl = findFirst(panel, (n) =>
        n.attributes.has('data-unknown-step-kind-note'),
    );
    assert.ok(noteEl);
    assert.equal(noteEl.textContent, 'unknown step kind');

    // Submit and confirm the dispatched override carries 'default' for
    // the unknown step, never the stored 'required'.
    return modal.submit({ projectId: 'alpha', name: 'Alpha' }).then(() => {
        const override = calls.find((c) => c.kind === 'updateApprovalOverride');
        assert.ok(override);
        assert.equal(
            override.input.approvalOverride.experimental?.mystery,
            'default',
        );
    });
});

// ---------------------------------------------------------------------------
// Toggle behaviour — exposed for completeness so a regression in the
// header button's onclick is caught immediately.
// ---------------------------------------------------------------------------

test('toggleAdvancedApprovals() flips data-collapsed on the section body', () => {
    const doc = makeShimDocument();
    const { manager } = makeOverlayManager();
    const { sink } = makeCommandSink();
    const { showToast } = makeToast();
    const modal = createEditProjectModal({
        overlayManager: manager,
        commands: sink,
        showToast,
        doc,
        flows: fixtureFlowProvider(),
        knownStepKinds: KNOWN_KINDS,
    });
    modal.open(baseInput());

    const panel = panelOf(doc);
    const body = findFirst(panel, (n) =>
        n.attributes.has('data-advanced-approvals-body'),
    );
    assert.ok(body);
    assert.equal(body.attributes.get('data-collapsed'), 'true');

    modal.toggleAdvancedApprovals();
    assert.equal(modal.isAdvancedApprovalsExpanded(), true);
    assert.equal(body.attributes.get('data-collapsed'), 'false');

    modal.toggleAdvancedApprovals();
    assert.equal(modal.isAdvancedApprovalsExpanded(), false);
    assert.equal(body.attributes.get('data-collapsed'), 'true');
});

// ---------------------------------------------------------------------------
// Back-compat: when no FlowProvider is wired, the section disappears and
// submit() does NOT call updateApprovalOverride. This protects every
// existing edit-project caller that has not yet been taught about the
// advanced section.
// ---------------------------------------------------------------------------

test('no FlowProvider wired: section is omitted and submit skips the override dispatch', async () => {
    const doc = makeShimDocument();
    const { manager } = makeOverlayManager();
    const { sink, calls } = makeCommandSink();
    const { showToast } = makeToast();
    const modal = createEditProjectModal({
        overlayManager: manager,
        commands: sink,
        showToast,
        doc,
    });
    modal.open(baseInput());

    const panel = panelOf(doc);
    assert.equal(
        findFirst(panel, (n) =>
            n.attributes.get('data-section') === 'advanced-approvals',
        ),
        null,
    );
    assert.equal(modal.getApprovalOverride(), null);

    await modal.submit({ projectId: 'alpha', name: 'Alpha' });
    assert.equal(
        calls.find((c) => c.kind === 'updateApprovalOverride'),
        undefined,
    );
});
