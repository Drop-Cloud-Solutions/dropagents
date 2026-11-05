/**
 * Unit tests for the P-TOTS-004 stage-bar widget.
 *
 * The widget was generalized from a fixed four-tag reduction onto a
 * hardcoded `Developer › Reviewer › Tester › Commit` strip to rendering
 * whatever ordered {@link FlowStage} list a task's flow actually runs.
 *
 * Coverage (per AC)
 * -----------------
 * - `deriveStageStates` keys off the current/failed step id: stages
 *   before the current one are `done`, the current one `active`, the
 *   failed one `failed`, later ones `pending`; a current/failed step
 *   after all steps (a trailing merge gate) leaves everything `done`;
 *   an unreached snapshot leaves everything `pending`.
 * - `renderStageBar` renders one chip per `agent`-kind stage in list
 *   order, filters `gate`-kind stages out of the strip, keeps the DOM
 *   byte-shape identical, and returns `null` when the list is empty,
 *   gate-only, or reaches no stage.
 *
 * Dual-runner discovery — mirrors `commands.test.ts`. See that file's
 * header for the full rationale; the short version is that vitest sets
 * `process.env.VITEST=true`, so the shim routes there via
 * `globalThis.test` and falls back to `node:test` everywhere else.
 */
import * as assert from 'node:assert/strict';

import type { FlowStage } from '../../../core/flow/flow-stages';
import {
    deriveStageStates,
    renderStageBar,
    type RenderDocument,
    type RenderElement,
} from './stage-bar';

// ---------------------------------------------------------------------------
// Dual-runner test() shim
// ---------------------------------------------------------------------------

type TestFn = (name: string, fn: () => void | Promise<void>) => void;

const test: TestFn = (((): TestFn => {
    if (process.env.VITEST) {
        const gt = (globalThis as { test?: TestFn }).test;
        if (typeof gt !== 'function') {
            throw new Error(
                'stage-bar.test.ts: VITEST=true but globalThis.test is missing — '
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
// FlowStage fixtures
// ---------------------------------------------------------------------------

function stage(
    stepId: string,
    agent: string,
    label: string,
    kind: FlowStage['kind'] = 'agent',
): FlowStage {
    return { stepId, agent, label, kind };
}

/**
 * The classic implement chain: dev → review → test → commit, plus a
 * trailing `wait-merged` merge gate. The gate is `kind === 'gate'` so it
 * is filtered out of the rendered strip but still positions the agent
 * stages before it.
 */
const IMPLEMENT_STAGES: readonly FlowStage[] = [
    stage('develop', 'developer', 'Developer'),
    stage('review', 'reviewer', 'Reviewer'),
    stage('test', 'tester', 'Tester'),
    stage('commit', 'committer', 'Committer'),
    stage('merge', 'wait-merged', 'Merge', 'gate'),
];

/** A single-step flow — e.g. `deploy-azure`'s lone `deployer` step. */
const SINGLE_STAGE: readonly FlowStage[] = [stage('deploy', 'deployer', 'Deployer')];

// ---------------------------------------------------------------------------
// Minimal DOM shim
// ---------------------------------------------------------------------------

interface ShimElement extends RenderElement {
    readonly tagName: string;
    readonly children: ShimElement[];
    readonly attributes: Map<string, string>;
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

/** Collapse a derived state list into `stepId → state` for compact asserts. */
function stateById(
    stages: readonly FlowStage[],
    progress: { currentStepId?: string | null; failedStepId?: string | null },
): Record<string, string> {
    const out: Record<string, string> = {};
    for (const { stage: s, state } of deriveStageStates(stages, progress)) {
        out[s.stepId] = state;
    }
    return out;
}

// ---------------------------------------------------------------------------
// deriveStageStates — current-step keying
// ---------------------------------------------------------------------------

test('deriveStageStates: current step is active, earlier done, later pending', () => {
    assert.deepEqual(stateById(IMPLEMENT_STAGES, { currentStepId: 'test' }), {
        develop: 'done',
        review: 'done',
        test: 'active',
        commit: 'pending',
        merge: 'pending',
    });
});

test('deriveStageStates: current step at the head leaves the rest pending', () => {
    assert.deepEqual(stateById(IMPLEMENT_STAGES, { currentStepId: 'develop' }), {
        develop: 'active',
        review: 'pending',
        test: 'pending',
        commit: 'pending',
        merge: 'pending',
    });
});

test('deriveStageStates: single-step flow — the lone current step is active', () => {
    assert.deepEqual(stateById(SINGLE_STAGE, { currentStepId: 'deploy' }), {
        deploy: 'active',
    });
});

// ---------------------------------------------------------------------------
// deriveStageStates — terminal / all-done
// ---------------------------------------------------------------------------

test('deriveStageStates: a current step behind all others (trailing gate) marks every stage done', () => {
    // current == the trailing merge gate: all agent steps are behind it.
    assert.deepEqual(stateById(IMPLEMENT_STAGES, { currentStepId: 'merge' }), {
        develop: 'done',
        review: 'done',
        test: 'done',
        commit: 'done',
        merge: 'active',
    });
});

test('deriveStageStates: an unreached snapshot (no current / failed) leaves every stage pending', () => {
    assert.deepEqual(stateById(IMPLEMENT_STAGES, {}), {
        develop: 'pending',
        review: 'pending',
        test: 'pending',
        commit: 'pending',
        merge: 'pending',
    });
    assert.deepEqual(stateById(IMPLEMENT_STAGES, { currentStepId: null, failedStepId: null }), {
        develop: 'pending',
        review: 'pending',
        test: 'pending',
        commit: 'pending',
        merge: 'pending',
    });
});

test('deriveStageStates: an unknown current step id reaches nothing', () => {
    assert.deepEqual(stateById(IMPLEMENT_STAGES, { currentStepId: 'no-such-step' }), {
        develop: 'pending',
        review: 'pending',
        test: 'pending',
        commit: 'pending',
        merge: 'pending',
    });
});

// ---------------------------------------------------------------------------
// deriveStageStates — failed-step keying
// ---------------------------------------------------------------------------

test('deriveStageStates: failed step is failed, earlier done, later pending', () => {
    assert.deepEqual(stateById(IMPLEMENT_STAGES, { failedStepId: 'review' }), {
        develop: 'done',
        review: 'failed',
        test: 'pending',
        commit: 'pending',
        merge: 'pending',
    });
});

test('deriveStageStates: failed overlays on top of a current step', () => {
    // review failed while commit is (re)current: review stays failed,
    // everything before commit is done, commit is active.
    assert.deepEqual(
        stateById(IMPLEMENT_STAGES, { currentStepId: 'commit', failedStepId: 'review' }),
        {
            develop: 'done',
            review: 'failed',
            test: 'done',
            commit: 'active',
            merge: 'pending',
        },
    );
});

test('deriveStageStates: failed step alone (no current) still marks earlier stages done', () => {
    assert.deepEqual(stateById(IMPLEMENT_STAGES, { failedStepId: 'commit' }), {
        develop: 'done',
        review: 'done',
        test: 'done',
        commit: 'failed',
        merge: 'pending',
    });
});

// ---------------------------------------------------------------------------
// deriveStageStates — purity
// ---------------------------------------------------------------------------

test('deriveStageStates: does not mutate the input stage array', () => {
    const stages = IMPLEMENT_STAGES.slice();
    const snapshot = JSON.stringify(stages);
    deriveStageStates(stages, { currentStepId: 'test' });
    assert.equal(JSON.stringify(stages), snapshot);
});

// ---------------------------------------------------------------------------
// renderStageBar — DOM structure
// ---------------------------------------------------------------------------

test('renderStageBar: renders <ol class="stage-bar"> with one chip per agent stage', () => {
    const doc = makeShimDocument();
    const root = asShim(renderStageBar(IMPLEMENT_STAGES, { currentStepId: 'test' }, doc));
    assert.equal(root.tagName, 'ol');
    assert.equal(root.className, 'stage-bar');
    assert.equal(root.attributes.get('aria-label'), 'Pipeline stage');

    // The trailing merge gate (kind === 'gate') is filtered out — four
    // agent chips remain.
    assert.equal(root.children.length, 4);

    const stageIds = root.children.map((c) => c.attributes.get('data-stage'));
    assert.deepEqual(stageIds, ['develop', 'review', 'test', 'commit']);

    const states = root.children.map((c) => c.attributes.get('data-state'));
    assert.deepEqual(states, ['done', 'done', 'active', 'pending']);

    const labels = root.children.map((c) => c.textContent);
    assert.deepEqual(labels, ['Developer', 'Reviewer', 'Tester', 'Committer']);

    for (const cell of root.children) {
        const state = cell.attributes.get('data-state');
        assert.equal(cell.tagName, 'li');
        assert.equal(cell.title, cell.textContent);
        assert.ok(
            cell.className.startsWith('stage-cell '),
            `expected stage-cell class on chip, got "${cell.className}"`,
        );
        assert.ok(
            cell.className.includes(`stage-cell--${state}`),
            `expected stage-cell--${state} modifier class, got "${cell.className}"`,
        );
    }
});

test('renderStageBar: single-step flow renders exactly one chip', () => {
    const doc = makeShimDocument();
    const root = asShim(renderStageBar(SINGLE_STAGE, { currentStepId: 'deploy' }, doc));
    assert.equal(root.children.length, 1);
    assert.equal(root.children[0].attributes.get('data-stage'), 'deploy');
    assert.equal(root.children[0].attributes.get('data-state'), 'active');
    assert.equal(root.children[0].textContent, 'Deployer');
});

test('renderStageBar: gate-kind stages never appear in the strip', () => {
    const doc = makeShimDocument();
    const root = asShim(renderStageBar(IMPLEMENT_STAGES, { currentStepId: 'merge' }, doc));
    const stageIds = root.children.map((c) => c.attributes.get('data-stage'));
    assert.ok(!stageIds.includes('merge'), 'merge gate must be filtered from the strip');
    // current == the trailing gate → every rendered agent chip is done.
    const states = root.children.map((c) => c.attributes.get('data-state'));
    assert.deepEqual(states, ['done', 'done', 'done', 'done']);
});

test('renderStageBar: gate-only flow renders nothing', () => {
    const doc = makeShimDocument();
    const gateOnly: readonly FlowStage[] = [
        stage('open', 'pr.open', 'Commit', 'gate'),
        stage('merge', 'pr.merge', 'Merge', 'gate'),
    ];
    assert.equal(renderStageBar(gateOnly, { currentStepId: 'open' }, doc), null);
});

test('renderStageBar: failed step paints the right chip with the failed modifier', () => {
    const doc = makeShimDocument();
    const root = asShim(renderStageBar(IMPLEMENT_STAGES, { failedStepId: 'test' }, doc));
    const testChip = root.children.find((c) => c.attributes.get('data-stage') === 'test');
    if (!testChip) throw new Error('test chip should be present');
    assert.equal(testChip.attributes.get('data-state'), 'failed');
    assert.ok(testChip.className.includes('stage-cell--failed'));
});

// ---------------------------------------------------------------------------
// renderStageBar — graceful empty
// ---------------------------------------------------------------------------

test('renderStageBar: empty stage list returns null', () => {
    const doc = makeShimDocument();
    assert.equal(renderStageBar([], { currentStepId: 'develop' }, doc), null);
});

test('renderStageBar: a snapshot that reaches no stage returns null', () => {
    const doc = makeShimDocument();
    assert.equal(renderStageBar(IMPLEMENT_STAGES, {}, doc), null);
    assert.equal(
        renderStageBar(IMPLEMENT_STAGES, { currentStepId: null, failedStepId: null }, doc),
        null,
    );
    assert.equal(renderStageBar(IMPLEMENT_STAGES, { currentStepId: 'no-such-step' }, doc), null);
});

// ---------------------------------------------------------------------------
// renderStageBar — purity
// ---------------------------------------------------------------------------

test('renderStageBar: pure function — repeated calls return fresh, independent DOM trees', () => {
    const doc = makeShimDocument();
    const progress = { currentStepId: 'develop' };
    const a = asShim(renderStageBar(IMPLEMENT_STAGES, progress, doc));
    const b = asShim(renderStageBar(IMPLEMENT_STAGES, progress, doc));
    assert.notEqual(a, b, 'renderStageBar must not memoise the root element');
    assert.notEqual(
        a.children[0],
        b.children[0],
        'renderStageBar must not memoise child cells',
    );
});

test('renderStageBar: input stage array is not mutated', () => {
    const doc = makeShimDocument();
    const stages = IMPLEMENT_STAGES.slice();
    const snapshot = JSON.stringify(stages);
    renderStageBar(stages, { currentStepId: 'review' }, doc);
    assert.equal(JSON.stringify(stages), snapshot);
});

test('renderStageBar: missing document throws a clear error when no shim is passed', () => {
    const originalDoc = (globalThis as { document?: unknown }).document;
    delete (globalThis as { document?: unknown }).document;
    try {
        assert.throws(
            () => renderStageBar(IMPLEMENT_STAGES, { currentStepId: 'develop' }),
            /no document available/,
        );
    } finally {
        if (originalDoc !== undefined) {
            (globalThis as { document?: unknown }).document = originalDoc;
        }
    }
});
