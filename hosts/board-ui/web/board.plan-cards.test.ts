/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Unit tests for the AP-IFB-003 plan-card renderer.
 *
 * Coverage
 * --------
 * - Acceptance #1: the template + renderer expose slots for title,
 *   tech-stack tags, and action buttons. The renderer fills the three
 *   in the documented top → bottom order.
 * - Acceptance #2: the V1 action set ({Show agent, Review plan,
 *   Activate, Re-decompose, Delete}) is rendered conditionally based
 *   on plan status. Per-status sets cover the planner-running,
 *   plan-ready, active and done phases.
 * - Acceptance #3: every action button fires its handler with the
 *   plan projection. Production wires the handlers to the existing
 *   sendCommand POST adapter; this module sticks to handler wiring so
 *   the test stays headless and never reaches worker-api directly.
 *
 * Dual-runner discovery — mirrors `./stage-bar.test.ts` and
 * `./board.task-cards.test.ts`. `process.env.VITEST=true` routes to
 * vitest's `globalThis.test`; everywhere else uses `node:test`.
 */
import * as assert from 'node:assert/strict';

import {
    derivePlanCardActions,
    PLAN_CARD_ACTIONS_DEFAULT,
    PLAN_CARD_ACTION_MAP,
    renderPlanActions,
    renderPlanCard,
    renderPlanTitle,
    renderTechStackTags,
    type PlanCardAction,
    type PlanCardHandlers,
    type PlanCardModel,
    type RenderDocument,
    type RenderElement,
} from './board-plan-cards';

// ---------------------------------------------------------------------------
// Dual-runner test() shim
// ---------------------------------------------------------------------------

type TestFn = (name: string, fn: () => void | Promise<void>) => void;

const test: TestFn = (((): TestFn => {
    if (process.env.VITEST) {
        const gt = (globalThis as { test?: TestFn }).test;
        if (typeof gt !== 'function') {
            throw new Error(
                'board.plan-cards.test.ts: VITEST=true but globalThis.test is missing — '
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
// DOM shim — same shape as board.task-cards.test.ts, kept self-contained
// so the two test files do not need to share a helper module.
// ---------------------------------------------------------------------------

interface ShimElement extends RenderElement {
    tagName: string;
    children: ShimElement[];
    attributes: Map<string, string>;
    onclick?: () => void;
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
            disabled: false,
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
        (el) =>
            el.tagName === 'button'
            && el.attributes.get('data-action') === action,
    );
    if (!btn) {
        throw new Error(
            `no button with data-action="${action}" under <${root.tagName}>`,
        );
    }
    return btn;
}

function findButton(root: ShimElement, action: string): ShimElement | null {
    return findFirst(
        root,
        (el) =>
            el.tagName === 'button'
            && el.attributes.get('data-action') === action,
    );
}

function click(el: ShimElement): void {
    if (!el.onclick) throw new Error('clicked element has no onclick');
    el.onclick();
}

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function plan(overrides: Partial<PlanCardModel> = {}): PlanCardModel {
    return {
        planId: 'pl-1',
        projectId: 'proj-1',
        status: 'plan_ready',
        title: 'Wire up the thing',
        techStack: ['dotnet8', 'azure-functions-v4'],
        planFile: 'pl-1.md',
        ...overrides,
    };
}

function noopHandlers(): PlanCardHandlers {
    return {
        onShowAgent: () => {},
        onReviewPlan: () => {},
        onActivate: () => {},
        onRedecompose: () => {},
        onDelete: () => {},
    };
}

// ---------------------------------------------------------------------------
// AC #1 — template slots (title, tech-stack, actions) are filled
// ---------------------------------------------------------------------------

test('renderPlanCard: emits the title / tech-stack / actions slots in v1 reading order', () => {
    const doc = makeShimDocument();
    const root = asShim(renderPlanCard(plan(), noopHandlers(), {}, doc));
    assert.equal(root.tagName, 'li');
    assert.equal(root.attributes.get('data-plan-id'), 'pl-1');
    assert.equal(root.attributes.get('data-plan-status'), 'plan_ready');

    const titleEl = asShim(
        findFirst(root, (el) => el.attributes.has('data-plan-title')),
    );
    assert.equal(titleEl.textContent, 'Wire up the thing');

    const techEl = asShim(
        findFirst(root, (el) => el.attributes.has('data-plan-tech-stack')),
    );
    const chips = findAll(techEl, (el) => el.className === 'tech-tag');
    assert.deepEqual(
        chips.map((c) => c.textContent),
        ['dotnet8', 'azure-functions-v4'],
    );

    const actions = asShim(
        findFirst(root, (el) => el.attributes.has('data-plan-actions')),
    );
    assert.ok(actions, 'expected the actions slot to be present');
});

test('renderPlanTitle: falls back to an empty string when title is missing', () => {
    const doc = makeShimDocument();
    const el = asShim(renderPlanTitle(doc, plan({ title: undefined })));
    assert.equal(el.textContent, '');
    assert.equal(el.attributes.has('data-plan-title'), true);
});

test('renderTechStackTags: empty / missing tech-stack yields an empty container, never null', () => {
    const doc = makeShimDocument();
    const empty = asShim(renderTechStackTags(doc, []));
    assert.equal(empty.children.length, 0);
    assert.equal(empty.attributes.has('data-plan-tech-stack'), true);

    const missing = asShim(renderTechStackTags(doc, undefined));
    assert.equal(missing.children.length, 0);
});

test('renderTechStackTags: skips blank / whitespace-only entries', () => {
    const doc = makeShimDocument();
    const root = asShim(
        renderTechStackTags(doc, ['dotnet8', '', '   ', 'cosmos-db']),
    );
    const chips = findAll(root, (el) => el.className === 'tech-tag');
    assert.deepEqual(
        chips.map((c) => c.textContent),
        ['dotnet8', 'cosmos-db'],
    );
});

// ---------------------------------------------------------------------------
// AC #2 — per-status conditional action set (V1 parity)
// ---------------------------------------------------------------------------

test('derivePlanCardActions: planning-status plans expose only Show agent', () => {
    assert.deepEqual(derivePlanCardActions(plan({ status: 'planning' })), [
        'show-agent',
    ]);
});

test('derivePlanCardActions: plan_ready exposes the full V1 action row in order', () => {
    assert.deepEqual(derivePlanCardActions(plan({ status: 'plan_ready' })), [
        'show-agent',
        'review-plan',
        'activate',
        're-decompose',
        'delete-plan',
    ]);
});

test('derivePlanCardActions: created and awaiting_review match plan_ready (pre-activation phase)', () => {
    const ready = derivePlanCardActions(plan({ status: 'plan_ready' }));
    assert.deepEqual(derivePlanCardActions(plan({ status: 'created' })), ready);
    assert.deepEqual(
        derivePlanCardActions(plan({ status: 'awaiting_review' })),
        ready,
    );
});

test('derivePlanCardActions: active phases expose Show agent + Delete', () => {
    for (const status of [
        'approved',
        'active',
        'in_progress',
        'review',
        'testing',
        'ready_to_commit',
        'ready_to_merge',
    ]) {
        assert.deepEqual(
            derivePlanCardActions(plan({ status })),
            ['show-agent', 'delete-plan'],
            `unexpected action set for status="${status}"`,
        );
    }
});

test('derivePlanCardActions: done / archived expose Delete only', () => {
    assert.deepEqual(derivePlanCardActions(plan({ status: 'done' })), [
        'delete-plan',
    ]);
    assert.deepEqual(derivePlanCardActions(plan({ status: 'archived' })), [
        'delete-plan',
    ]);
});

test('derivePlanCardActions: unknown status falls back to the default escape-hatch set', () => {
    assert.deepEqual(
        derivePlanCardActions(plan({ status: 'something-new' })),
        PLAN_CARD_ACTIONS_DEFAULT,
    );
});

test('derivePlanCardActions: normalises case and dash-aliased status keys', () => {
    assert.deepEqual(
        derivePlanCardActions(plan({ status: 'Plan-Ready' })),
        PLAN_CARD_ACTION_MAP['plan_ready'],
    );
    assert.deepEqual(
        derivePlanCardActions(plan({ status: 'IN-PROGRESS' })),
        PLAN_CARD_ACTION_MAP['in_progress'],
    );
});

test('renderPlanActions: emits one button per derived action, in order', () => {
    const doc = makeShimDocument();
    const row = asShim(renderPlanActions(doc, plan(), noopHandlers()));
    const buttons = findAll(row, (el) => el.tagName === 'button');
    assert.deepEqual(
        buttons.map((b) => b.attributes.get('data-action')),
        ['show-agent', 'review-plan', 'activate', 're-decompose', 'delete-plan'],
    );
});

test('renderPlanCard: an active plan only renders Show agent + Delete', () => {
    const doc = makeShimDocument();
    const root = asShim(
        renderPlanCard(plan({ status: 'in_progress' }), noopHandlers(), {}, doc),
    );
    assert.ok(findButton(root, 'show-agent'), 'expected Show agent on active plan');
    assert.ok(findButton(root, 'delete-plan'), 'expected Delete on active plan');
    assert.equal(findButton(root, 'review-plan'), null);
    assert.equal(findButton(root, 'activate'), null);
    assert.equal(findButton(root, 're-decompose'), null);
});

// ---------------------------------------------------------------------------
// AC #3 — every action button fires its handler with the plan projection
// ---------------------------------------------------------------------------

test('renderPlanActions: Show agent fires onShowAgent with the plan', () => {
    const doc = makeShimDocument();
    let shown: PlanCardModel | null = null;
    const handlers: PlanCardHandlers = {
        ...noopHandlers(),
        onShowAgent: (p) => {
            shown = p;
        },
    };
    const row = asShim(renderPlanActions(doc, plan({ planId: 'pl-7' }), handlers));
    click(buttonByAction(row, 'show-agent'));
    assert.ok(shown);
    assert.equal((shown as unknown as PlanCardModel).planId, 'pl-7');
});

test('renderPlanActions: Review plan / Activate / Re-decompose each fire the matching handler', () => {
    const doc = makeShimDocument();
    const fired: PlanCardAction[] = [];
    const handlers: PlanCardHandlers = {
        ...noopHandlers(),
        onReviewPlan: () => fired.push('review-plan'),
        onActivate: () => fired.push('activate'),
        onRedecompose: () => fired.push('re-decompose'),
    };
    const row = asShim(renderPlanActions(doc, plan(), handlers));
    click(buttonByAction(row, 'review-plan'));
    click(buttonByAction(row, 'activate'));
    click(buttonByAction(row, 're-decompose'));
    assert.deepEqual(fired, ['review-plan', 'activate', 're-decompose']);
});

test('renderPlanActions: Delete fires onDelete with the plan', () => {
    const doc = makeShimDocument();
    let deleted: PlanCardModel | null = null;
    const handlers: PlanCardHandlers = {
        ...noopHandlers(),
        onDelete: (p) => {
            deleted = p;
        },
    };
    const row = asShim(renderPlanActions(doc, plan({ planId: 'pl-x' }), handlers));
    click(buttonByAction(row, 'delete-plan'));
    assert.ok(deleted);
    assert.equal((deleted as unknown as PlanCardModel).planId, 'pl-x');
});

test('renderPlanActions: Delete is disabled when planFile is missing', () => {
    const doc = makeShimDocument();
    const row = asShim(
        renderPlanActions(doc, plan({ planFile: null }), noopHandlers()),
    );
    const del = buttonByAction(row, 'delete-plan');
    assert.equal(del.disabled, true);
    assert.equal(del.attributes.get('disabled'), 'disabled');
});
