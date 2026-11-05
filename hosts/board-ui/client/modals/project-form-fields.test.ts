/**
 * Unit tests for the shared approval-mode dropdown control
 * (AP-PAO-013).
 *
 * Coverage targets the task's acceptance criteria:
 *   AC #1 createApprovalModeDropdown is exported from
 *         project-form-fields.ts (covered by the static import below).
 *   AC #2 Three options render: 'auto', 'required',
 *         '(use flow default)'.
 *   AC #3 Selecting '(use flow default)' emits the literal value
 *         'default' via onChange.
 *   AC #4 The control has no module-level state and two embedded
 *         instances do not interfere — verified by the "embedded twice"
 *         case below.
 *   AC #5 Unit tests cover rendering with each initial value and
 *         onChange firing with the correct value for each option.
 *
 * Dual-runner discovery
 * ---------------------
 * The repo's own `npm test` runs `node --test --import tsx`; the
 * review pipeline runs `npx vitest run` on changed test files. The
 * shim below picks the right `test()` at module load so a single
 * source file is discovered and executed by both runners. See
 * commands.test.ts for the longer explanation.
 */
import * as assert from 'node:assert/strict';

import {
    APPROVAL_MODE_VALUES,
    createApprovalModeDropdown,
    type ApprovalModeValue,
    type ModalDocument,
    type ModalElement,
} from './project-form-fields';

// ---------------------------------------------------------------------------
// Dual-runner test() shim — mirrors commands.test.ts
// ---------------------------------------------------------------------------

type TestFn = (name: string, fn: () => void | Promise<void>) => void;

const test: TestFn = (((): TestFn => {
    if (process.env.VITEST) {
        const gt = (globalThis as { test?: TestFn }).test;
        if (typeof gt !== 'function') {
            throw new Error(
                'project-form-fields.test.ts: VITEST=true but globalThis.test is '
                    + 'missing — ensure vitest.config.ts sets test.globals = true',
            );
        }
        return gt;
    }
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    const nt = require('node:test') as { test: TestFn };
    return nt.test;
})());

// ---------------------------------------------------------------------------
// Minimal DOM shim — same shape as edit-project.spec.ts so the
// modal-test suites speak the same language.
// ---------------------------------------------------------------------------

interface ShimElement extends ModalElement {
    readonly tagName: string;
    readonly children: ShimElement[];
    readonly attributes: Map<string, string>;
    parent: ShimElement | null;
    onchange?: () => void;
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

function makeShimDocument(): ModalDocument {
    return {
        getElementById: (): ModalElement | null => null,
        createElement: (tag: string): ModalElement => makeShimElement(tag),
    };
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

function selectInside(root: ShimElement): ShimElement {
    const el = findFirst(root, (n) => n.attributes.has('data-approval-mode-select'));
    if (!el) throw new Error('approval-mode select missing');
    return el;
}

// ---------------------------------------------------------------------------
// AC #2 — three options render with the operator-facing labels
// ---------------------------------------------------------------------------

test('renders the three options in canonical order with the V1 labels', () => {
    const doc = makeShimDocument();
    const dd = createApprovalModeDropdown(doc, {
        label: 'Approval mode',
        value: 'auto',
        onChange: (): void => {},
    });
    const root = dd.element as ShimElement;
    assert.equal(root.attributes.has('data-approval-mode'), true);

    const options = findAll(root, (n) => n.tagName === 'option');
    assert.equal(options.length, 3);

    assert.equal(options[0].attributes.get('value'), 'auto');
    assert.equal(options[0].textContent, 'auto');

    assert.equal(options[1].attributes.get('value'), 'required');
    assert.equal(options[1].textContent, 'required');

    assert.equal(options[2].attributes.get('value'), 'default');
    assert.equal(options[2].textContent, '(use flow default)');
});

test('renders the operator-facing label text next to the select', () => {
    const doc = makeShimDocument();
    const dd = createApprovalModeDropdown(doc, {
        label: 'Plan approval',
        value: 'auto',
        onChange: (): void => {},
    });
    const root = dd.element as ShimElement;
    const labelText = findFirst(root, (n) => n.attributes.has('data-approval-mode-label'));
    assert.ok(labelText, 'expected a data-approval-mode-label element');
    assert.equal(labelText.textContent, 'Plan approval');

    const select = selectInside(root);
    assert.equal(select.attributes.get('aria-label'), 'Plan approval');
});

// ---------------------------------------------------------------------------
// AC #5a — rendering with each initial value selects the matching option
// ---------------------------------------------------------------------------

for (const initial of ['auto', 'required', 'default'] as const) {
    test(`initial value "${initial}" is reflected in select.value and getValue()`, () => {
        const doc = makeShimDocument();
        const changes: ApprovalModeValue[] = [];
        const dd = createApprovalModeDropdown(doc, {
            label: 'Approval mode',
            value: initial,
            onChange: (v): void => {
                changes.push(v);
            },
        });
        const select = selectInside(dd.element as ShimElement);
        assert.equal(select.value, initial);
        assert.equal(dd.getValue(), initial);
        // Rendering must not synthesise an onChange call.
        assert.deepEqual(changes, []);
    });
}

// ---------------------------------------------------------------------------
// AC #3 + AC #5b — onChange fires with the correct value for each option,
// including the literal 'default' for '(use flow default)'.
// ---------------------------------------------------------------------------

for (const picked of ['auto', 'required', 'default'] as const) {
    test(`onChange fires with "${picked}" when the operator selects that option`, () => {
        const doc = makeShimDocument();
        const changes: ApprovalModeValue[] = [];
        // Seed with a different value so every case observes a real
        // transition rather than re-selecting the initial option.
        const seed: ApprovalModeValue = picked === 'auto' ? 'required' : 'auto';
        const dd = createApprovalModeDropdown(doc, {
            label: 'Approval mode',
            value: seed,
            onChange: (v): void => {
                changes.push(v);
            },
        });
        const select = selectInside(dd.element as ShimElement);
        select.value = picked;
        select.onchange?.();
        assert.deepEqual(changes, [picked]);
        assert.equal(dd.getValue(), picked);
    });
}

// ---------------------------------------------------------------------------
// AC #4 — no global state: two instances embedded in the same modal
// must not share selection or callback wiring.
// ---------------------------------------------------------------------------

test('two embedded instances keep independent selection and callbacks', () => {
    const doc = makeShimDocument();
    const aChanges: ApprovalModeValue[] = [];
    const bChanges: ApprovalModeValue[] = [];
    const a = createApprovalModeDropdown(doc, {
        label: 'A',
        value: 'auto',
        onChange: (v): void => {
            aChanges.push(v);
        },
    });
    const b = createApprovalModeDropdown(doc, {
        label: 'B',
        value: 'required',
        onChange: (v): void => {
            bChanges.push(v);
        },
    });

    const selA = selectInside(a.element as ShimElement);
    const selB = selectInside(b.element as ShimElement);

    selA.value = 'default';
    selA.onchange?.();

    assert.deepEqual(aChanges, ['default']);
    assert.deepEqual(bChanges, []);
    assert.equal(a.getValue(), 'default');
    assert.equal(b.getValue(), 'required');

    selB.value = 'auto';
    selB.onchange?.();
    assert.deepEqual(aChanges, ['default']);
    assert.deepEqual(bChanges, ['auto']);
});

// ---------------------------------------------------------------------------
// setValue() is the programmatic counterpart and must NOT fire onChange.
// ---------------------------------------------------------------------------

test('setValue() updates the rendered select without firing onChange', () => {
    const doc = makeShimDocument();
    const changes: ApprovalModeValue[] = [];
    const dd = createApprovalModeDropdown(doc, {
        label: 'Approval mode',
        value: 'auto',
        onChange: (v): void => {
            changes.push(v);
        },
    });
    dd.setValue('required');
    const select = selectInside(dd.element as ShimElement);
    assert.equal(select.value, 'required');
    assert.equal(dd.getValue(), 'required');
    assert.deepEqual(changes, []);
});

// ---------------------------------------------------------------------------
// Defensive normalisation — an out-of-vocabulary select.value should
// fall back to the previous selection rather than emit garbage.
// ---------------------------------------------------------------------------

test('an unknown raw value on the underlying select is ignored', () => {
    const doc = makeShimDocument();
    const changes: ApprovalModeValue[] = [];
    const dd = createApprovalModeDropdown(doc, {
        label: 'Approval mode',
        value: 'auto',
        onChange: (v): void => {
            changes.push(v);
        },
    });
    const select = selectInside(dd.element as ShimElement);
    select.value = 'something-else';
    select.onchange?.();
    assert.deepEqual(changes, ['auto']);
    assert.equal(dd.getValue(), 'auto');
});

// ---------------------------------------------------------------------------
// APPROVAL_MODE_VALUES is the canonical vocabulary exported alongside.
// ---------------------------------------------------------------------------

test('APPROVAL_MODE_VALUES exports the canonical three-value vocabulary in order', () => {
    assert.deepEqual([...APPROVAL_MODE_VALUES], ['auto', 'required', 'default']);
});
