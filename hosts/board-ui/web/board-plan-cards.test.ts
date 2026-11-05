/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Unit tests for the AP-PAO-012 section-grouping additions to the
 * AP-IFB-003 plan-card renderer.
 *
 * Coverage
 * --------
 * - AC #1: each section's derivation rule. Investigation-type plans,
 *   archived plans, and the four task-tag-driven buckets (attention,
 *   draft, progress, completed) each get a dedicated test that pins
 *   the precedence order spelled out in the task brief.
 * - AC #2 & AC #3: the section count badges reflect the number of
 *   plans in each section, and archived plans only render into the
 *   archived body when the section toggle is expanded — count badge
 *   still updates either way so the operator sees how many plans are
 *   hidden behind the collapsed toggle.
 * - AC #4: investigation-type plans land in the Investigations strip
 *   even when their tasks would otherwise route them into progress /
 *   attention / completed.
 *
 * Dual-runner discovery — mirrors `./board.plan-cards.test.ts` /
 * `./stage-bar.test.ts`. `process.env.VITEST=true` routes to vitest's
 * `globalThis.test`; everywhere else uses `node:test`.
 */
import * as assert from 'node:assert/strict';

import type { DeriveTagsTask } from '../task-tags';
import {
    derivePlanSection,
    PLAN_SECTIONS,
    renderPlansBySection,
    type PlanCardHandlers,
    type PlanCardModel,
    type PlanSection,
    type PlanSectionTarget,
    type PlanSectionTargets,
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
                'board-plan-cards.test.ts: VITEST=true but globalThis.test is missing — '
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
// DOM shim — same shape as board.plan-cards.test.ts; self-contained so the
// two test files do not need to share a helper module.
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

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function plan(overrides: Partial<PlanCardModel> = {}): PlanCardModel {
    return {
        planId: 'pl-1',
        projectId: 'proj-1',
        status: 'plan_ready',
        title: 'Wire up the thing',
        techStack: ['dotnet8'],
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

function makeTarget(doc: RenderDocument): PlanSectionTarget {
    return {
        body: doc.createElement('div'),
        countBadge: doc.createElement('span'),
    };
}

function makeTargets(doc: RenderDocument): PlanSectionTargets {
    const out: Partial<Record<PlanSection, PlanSectionTarget>> = {};
    for (const section of PLAN_SECTIONS) out[section] = makeTarget(doc);
    return out as PlanSectionTargets;
}

function bodyChildCount(target: PlanSectionTarget): number {
    return (target.body as ShimElement).children.length;
}

function badgeText(target: PlanSectionTarget): string | null {
    return target.countBadge.textContent;
}

// ---------------------------------------------------------------------------
// AC #1 — derivation rule per section
// ---------------------------------------------------------------------------

test('derivePlanSection: plan with no tasks lands in draft-plans', () => {
    assert.equal(derivePlanSection(plan(), []), 'draft-plans');
});

test('derivePlanSection: only created / approved tasks → draft-plans', () => {
    const tasks: DeriveTagsTask[] = [
        { human_status: 'created' },
        { human_status: 'approved' },
    ];
    assert.equal(derivePlanSection(plan(), tasks), 'draft-plans');
});

test('derivePlanSection: any failed:<stage> task → attention-plans', () => {
    for (const stage of ['dev', 'review', 'test', 'commit']) {
        const tasks: DeriveTagsTask[] = [
            { human_status: 'approved' },
            { failed_stage: stage },
        ];
        assert.equal(
            derivePlanSection(plan(), tasks),
            'attention-plans',
            `expected attention for failed_stage="${stage}"`,
        );
    }
});

test('derivePlanSection: any awaiting_clarification task → attention-plans', () => {
    const tasks: DeriveTagsTask[] = [
        { human_status: 'in_progress' },
        {
            current_step_id: 'develop',
            parkedReason: 'clarification',
        },
    ];
    assert.equal(derivePlanSection(plan(), tasks), 'attention-plans');
});

test('derivePlanSection: any in_progress task → progress-plans', () => {
    const tasks: DeriveTagsTask[] = [
        { human_status: 'approved' },
        { human_status: 'in_progress' },
    ];
    assert.equal(derivePlanSection(plan(), tasks), 'progress-plans');
});

test('derivePlanSection: ready_for_review / ready_for_test / ready_to_commit / ready_to_merge → progress-plans', () => {
    for (const status of [
        'ready_for_review',
        'testing',
        'ready_to_commit',
        'ready_to_merge',
    ]) {
        const tasks: DeriveTagsTask[] = [{ human_status: status }];
        assert.equal(
            derivePlanSection(plan(), tasks),
            'progress-plans',
            `expected progress for human_status="${status}"`,
        );
    }
});

test('derivePlanSection: every task done → completed-plans', () => {
    const tasks: DeriveTagsTask[] = [
        { human_status: 'done' },
        { human_status: 'done' },
    ];
    assert.equal(derivePlanSection(plan(), tasks), 'completed-plans');
});

test('derivePlanSection: mixed done + created → draft-plans (not completed)', () => {
    const tasks: DeriveTagsTask[] = [
        { human_status: 'done' },
        { human_status: 'created' },
    ];
    assert.equal(derivePlanSection(plan(), tasks), 'draft-plans');
});

test('derivePlanSection: archived flag → archived-plans (overrides every other rule)', () => {
    const tasks: DeriveTagsTask[] = [
        // Would otherwise route to attention.
        { failed_stage: 'commit' },
    ];
    assert.equal(
        derivePlanSection(plan({ archived: true }), tasks),
        'archived-plans',
    );
});

test('derivePlanSection: investigation-type plan → investigations even when tasks would route elsewhere', () => {
    const tasks: DeriveTagsTask[] = [
        // Would otherwise route to progress.
        { human_status: 'in_progress' },
    ];
    assert.equal(
        derivePlanSection(plan({ type: 'investigation' }), tasks),
        'investigations',
    );
});

test('derivePlanSection: archived flag wins over investigation-type', () => {
    assert.equal(
        derivePlanSection(
            plan({ type: 'investigation', archived: true }),
            [{ human_status: 'in_progress' }],
        ),
        'archived-plans',
    );
});

test('derivePlanSection: attention wins over progress when both are present', () => {
    const tasks: DeriveTagsTask[] = [
        { human_status: 'in_progress' },
        { failed_stage: 'test' },
    ];
    assert.equal(derivePlanSection(plan(), tasks), 'attention-plans');
});

// ---------------------------------------------------------------------------
// AC #4 — investigation-type plans always land in Investigations strip
// ---------------------------------------------------------------------------

test('renderPlansBySection: investigation-type plan renders into investigations regardless of task tags', () => {
    const doc = makeShimDocument();
    const targets = makeTargets(doc);
    const plans: PlanCardModel[] = [
        plan({ planId: 'pl-inv', type: 'investigation' }),
    ];
    const tasksByPlanId = new Map<string, DeriveTagsTask[]>([
        ['pl-inv', [{ failed_stage: 'test' }, { human_status: 'done' }]],
    ]);
    const counts = renderPlansBySection(
        plans,
        tasksByPlanId,
        noopHandlers(),
        targets,
        {},
        doc,
    );
    assert.equal(counts.investigations, 1);
    assert.equal(counts['attention-plans'], 0);
    assert.equal(counts['completed-plans'], 0);
    assert.equal(bodyChildCount(targets.investigations), 1);
    assert.equal(bodyChildCount(targets['attention-plans']), 0);
});

// ---------------------------------------------------------------------------
// AC #3 — archived toggle behaviour
// ---------------------------------------------------------------------------

test('renderPlansBySection: archived plans are NOT rendered into the body when collapsed', () => {
    const doc = makeShimDocument();
    const targets = makeTargets(doc);
    const plans: PlanCardModel[] = [
        plan({ planId: 'pl-a', archived: true }),
        plan({ planId: 'pl-b', archived: true }),
    ];
    const counts = renderPlansBySection(
        plans,
        new Map(),
        noopHandlers(),
        targets,
        { archivedExpanded: false },
        doc,
    );
    // The count badge still reflects the true archived count so the
    // operator sees "Archived (2)" beside the toggle even while it is
    // collapsed.
    assert.equal(counts['archived-plans'], 2);
    assert.equal(badgeText(targets['archived-plans']), '2');
    // …but no cards were appended.
    assert.equal(bodyChildCount(targets['archived-plans']), 0);
});

test('renderPlansBySection: archived plans render into the body when expanded', () => {
    const doc = makeShimDocument();
    const targets = makeTargets(doc);
    const plans: PlanCardModel[] = [
        plan({ planId: 'pl-a', archived: true }),
        plan({ planId: 'pl-b', archived: true }),
    ];
    renderPlansBySection(
        plans,
        new Map(),
        noopHandlers(),
        targets,
        { archivedExpanded: true },
        doc,
    );
    assert.equal(bodyChildCount(targets['archived-plans']), 2);
    assert.equal(badgeText(targets['archived-plans']), '2');
});

test('renderPlansBySection: archivedExpanded defaults to false (collapsed)', () => {
    const doc = makeShimDocument();
    const targets = makeTargets(doc);
    renderPlansBySection(
        [plan({ planId: 'pl-a', archived: true })],
        new Map(),
        noopHandlers(),
        targets,
        {},
        doc,
    );
    assert.equal(bodyChildCount(targets['archived-plans']), 0);
    assert.equal(badgeText(targets['archived-plans']), '1');
});

// ---------------------------------------------------------------------------
// AC #2 — count-badge update across every section
// ---------------------------------------------------------------------------

test('renderPlansBySection: writes per-section counts into the count badge of every section', () => {
    const doc = makeShimDocument();
    const targets = makeTargets(doc);
    const plans: PlanCardModel[] = [
        plan({ planId: 'pl-draft-1' }),
        plan({ planId: 'pl-draft-2' }),
        plan({ planId: 'pl-progress' }),
        plan({ planId: 'pl-attention' }),
        plan({ planId: 'pl-done' }),
        plan({ planId: 'pl-inv', type: 'investigation' }),
        plan({ planId: 'pl-arch', archived: true }),
    ];
    const tasksByPlanId = new Map<string, DeriveTagsTask[]>([
        // pl-draft-1 + pl-draft-2 — no tasks at all → draft
        ['pl-progress', [{ human_status: 'in_progress' }]],
        ['pl-attention', [{ failed_stage: 'review' }]],
        ['pl-done', [{ human_status: 'done' }]],
        // Investigation tasks don't matter — type wins.
        ['pl-inv', [{ human_status: 'in_progress' }]],
        // Archived tasks don't matter — archived flag wins.
        ['pl-arch', [{ human_status: 'done' }]],
    ]);
    const counts = renderPlansBySection(
        plans,
        tasksByPlanId,
        noopHandlers(),
        targets,
        { archivedExpanded: false },
        doc,
    );
    assert.deepEqual(counts, {
        investigations: 1,
        'draft-plans': 2,
        'attention-plans': 1,
        'progress-plans': 1,
        'completed-plans': 1,
        'archived-plans': 1,
    });
    assert.equal(badgeText(targets.investigations), '1');
    assert.equal(badgeText(targets['draft-plans']), '2');
    assert.equal(badgeText(targets['attention-plans']), '1');
    assert.equal(badgeText(targets['progress-plans']), '1');
    assert.equal(badgeText(targets['completed-plans']), '1');
    assert.equal(badgeText(targets['archived-plans']), '1');
});

test('renderPlansBySection: empty plan list writes "0" into every count badge', () => {
    const doc = makeShimDocument();
    const targets = makeTargets(doc);
    const counts = renderPlansBySection(
        [],
        new Map(),
        noopHandlers(),
        targets,
        {},
        doc,
    );
    for (const section of PLAN_SECTIONS) {
        assert.equal(counts[section], 0, `expected zero count for ${section}`);
        assert.equal(
            badgeText(targets[section]),
            '0',
            `expected "0" badge text for ${section}`,
        );
    }
});

test('renderPlansBySection: each rendered card is a plan-card root carrying the plan id', () => {
    const doc = makeShimDocument();
    const targets = makeTargets(doc);
    const plans: PlanCardModel[] = [
        plan({ planId: 'pl-draft-x' }),
        plan({ planId: 'pl-progress-y' }),
    ];
    const tasksByPlanId = new Map<string, DeriveTagsTask[]>([
        ['pl-progress-y', [{ human_status: 'in_progress' }]],
    ]);
    renderPlansBySection(
        plans,
        tasksByPlanId,
        noopHandlers(),
        targets,
        {},
        doc,
    );
    const draftBody = asShim(targets['draft-plans'].body);
    const progressBody = asShim(targets['progress-plans'].body);
    const draftCards = findAll(
        draftBody,
        (el) => el.attributes.has('data-plan-card'),
    );
    const progressCards = findAll(
        progressBody,
        (el) => el.attributes.has('data-plan-card'),
    );
    assert.deepEqual(
        draftCards.map((c) => c.attributes.get('data-plan-id')),
        ['pl-draft-x'],
    );
    assert.deepEqual(
        progressCards.map((c) => c.attributes.get('data-plan-id')),
        ['pl-progress-y'],
    );
});
