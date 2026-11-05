/**
 * Plan-card slot assertions (AP-IFB-009, AC #2).
 *
 * Renders a representative plan through `web/board-plan-cards.ts` and
 * asserts the V1-parity slots shipped by AP-IFB-003 are present:
 *
 *   - `[data-plan-card]`        — card root.
 *   - `[data-plan-id]`          — id label.
 *   - `[data-plan-status]`      — status label.
 *   - `[data-plan-title]`       — title row, populated from `plan.title`.
 *   - `[data-plan-tech-stack]`  — tech-stack tag container.
 *   - `[data-tech-tag]`         — one chip per stack entry. The sample
 *                                 declares three so the assertion catches
 *                                 a "container present, no chips" bug.
 *   - `[data-plan-actions]`     — action-button container.
 *
 * The action set is the `plan_ready` row from
 * {@link PLAN_CARD_ACTION_MAP} — Show agent, Review plan, Activate,
 * Re-decompose, Delete — so the assertion locks down the full V1 button
 * set on a representative plan status. Per-status conditional branches
 * are unit-tested in `web/board.plan-cards.test.ts`; the parity harness
 * pins the operator-facing "all five visible at plan_ready" contract.
 */

import {
    renderPlanCard,
    type PlanCardHandlers,
    type PlanCardModel,
    type RenderDocument,
} from '../web/board-plan-cards';

import {
    createShimDocument,
    findAllByDataAttr,
    findButtonByAction,
    findByDataAttr,
    type ShimElement,
} from './dom-shim';

export const PLAN_CARD_SAMPLE: PlanCardModel = {
    planId: 'pl-009-sample',
    projectId: 'proj-sample',
    status: 'plan_ready',
    title: 'Sample plan title for parity-smoke',
    techStack: ['typescript', 'node', 'sqlite'],
    planFile: 'pl-009-sample.md',
};

const EXPECTED_ACTIONS: ReadonlyArray<string> = [
    'show-agent',
    'review-plan',
    'activate',
    're-decompose',
    'delete-plan',
];

function noopHandlers(): PlanCardHandlers {
    return {
        onShowAgent: () => {},
        onReviewPlan: () => {},
        onActivate: () => {},
        onRedecompose: () => {},
        onDelete: () => {},
    };
}

function fail(message: string): never {
    const err = new Error(`plan-card parity: ${message}`);
    err.name = 'BoardUiParityFailure';
    throw err;
}

export function assertPlanCardSlots(): void {
    const doc = createShimDocument();
    const root = renderPlanCard(
        PLAN_CARD_SAMPLE,
        noopHandlers(),
        {},
        doc as unknown as RenderDocument,
    ) as unknown as ShimElement;

    // Card-level identifier slots.
    if (root.attributes.get('data-plan-card') === undefined) {
        fail('missing [data-plan-card] on card root');
    }
    if (root.attributes.get('data-plan-id') !== PLAN_CARD_SAMPLE.planId) {
        fail(
            `card root [data-plan-id]="${root.attributes.get('data-plan-id')}" ` +
                `does not equal "${PLAN_CARD_SAMPLE.planId}"`,
        );
    }
    if (root.attributes.get('data-plan-status') !== PLAN_CARD_SAMPLE.status) {
        fail(
            `card root [data-plan-status]="${root.attributes.get('data-plan-status')}" ` +
                `does not equal "${PLAN_CARD_SAMPLE.status}"`,
        );
    }

    const title = findByDataAttr(root, 'data-plan-title');
    if (!title) fail('missing [data-plan-title] row');
    if ((title.textContent ?? '') !== PLAN_CARD_SAMPLE.title) {
        fail(
            `[data-plan-title] text content "${title.textContent ?? ''}" ` +
                `does not equal "${PLAN_CARD_SAMPLE.title}"`,
        );
    }

    const techStack = findByDataAttr(root, 'data-plan-tech-stack');
    if (!techStack) fail('missing [data-plan-tech-stack] container');
    const chips = findAllByDataAttr(techStack, 'data-tech-tag');
    if (chips.length !== (PLAN_CARD_SAMPLE.techStack ?? []).length) {
        fail(
            `expected ${(PLAN_CARD_SAMPLE.techStack ?? []).length} ` +
                `[data-tech-tag] chips under [data-plan-tech-stack]; ` +
                `got ${chips.length}`,
        );
    }
    for (const tag of PLAN_CARD_SAMPLE.techStack ?? []) {
        const hit = chips.find((c) => c.attributes.get('data-tech-tag') === tag);
        if (!hit) {
            fail(`missing tech-tag chip for "${tag}"`);
        }
    }

    const actions = findByDataAttr(root, 'data-plan-actions');
    if (!actions) fail('missing [data-plan-actions] row');
    for (const action of EXPECTED_ACTIONS) {
        const btn = findButtonByAction(actions, action);
        if (!btn) {
            fail(
                `missing <button data-action="${action}"> under [data-plan-actions] ` +
                    `for plan status "${PLAN_CARD_SAMPLE.status}"`,
            );
        }
    }
}
