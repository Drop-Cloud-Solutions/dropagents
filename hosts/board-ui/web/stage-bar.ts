/**
 * Pipeline stage-bar widget (AP-IFG-011, AP-PAO-011, P-TOTS-004).
 *
 * v2 widget that renders the per-card horizontal stage strip. The DOM
 * shape is byte-for-byte identical to the AP-IFG-011 port — the
 * AP-PAO-008 CSS port targets the same `.stage-bar` / `.stage-cell`
 * selectors — but the INPUT contract was generalized in P-TOTS-004.
 *
 * Previously the bar reduced a fixed four-tag set (`in_progress` …
 * `done`) onto a hardcoded `Developer › Reviewer › Tester › Commit`
 * strip. That baked the standard implement chain into the widget, so a
 * `document` flow with no tester, a single-step `deploy-azure`, or a
 * lone `investigate` chip could not render their own steps.
 *
 * The bar now renders whatever ordered {@link FlowStage} list a task's
 * flow actually runs (see {@link ../../../core/flow/flow-stages}). The
 * caller passes the flow's ordered stages plus the task's progress —
 * the current step id and the failed step id — and the widget derives
 * a per-stage state keyed on those ids:
 *
 *   - every stage before the current one → `done`
 *   - the current stage                 → `active`
 *   - the failed stage                  → `failed` (overlays)
 *   - every stage after the current one  → `pending`
 *
 * A current (or failed) step positioned after all the agent steps — a
 * trailing merge gate, say — leaves every agent stage `done`; that is
 * the terminal "all steps behind it" case. When neither a current nor a
 * failed step is located in the list, no stage is reached and the
 * widget returns `null`.
 *
 * Operator gates (`kind === 'gate'` — the approval / merge steps) are
 * filtered out of the rendered strip: they are approval gates, not work
 * steps, so only `kind === 'agent'` chips are drawn. Gates still count
 * for positioning (a current step that is a trailing merge gate still
 * marks the agent steps before it `done`) because the FULL ordered list
 * is fed through {@link deriveStageStates}; only rendering drops them.
 *
 * Architectural contract
 * ----------------------
 * - Pure: same stages + progress → same DOM. No reads off `globalThis`
 *   beyond resolving the default `document`; unit tests pass a doc shim.
 * - Stateless: never mutates the input stage array, never caches the
 *   produced DOM tree.
 * - Graceful on empty / pre-pipeline input. An empty stage list, a
 *   gate-only flow, or a progress snapshot that reaches no stage returns
 *   `null` (matches v1's `return ""` short-circuit), so the call site
 *   can leave the slot untouched without a defensive wrapper.
 *
 * The renderer takes an injectable {@link RenderDocument} so the unit
 * tests can drive it with a hand-rolled DOM shim (no jsdom dependency).
 * In the browser the parameter is omitted and the function falls back
 * to `globalThis.document`.
 */

import type { FlowStage } from '../../../core/flow/flow-stages';

// ---------------------------------------------------------------------------
// Stage shapes
// ---------------------------------------------------------------------------

/** Per-chip visual state. */
export type StageState = 'pending' | 'active' | 'done' | 'failed';

/**
 * The task's progress inputs, keyed on step id. Both fields are
 * optional and nullable so a projection that never learned them (a
 * pre-pipeline task) can pass `{}` and get a `null` bar back.
 *
 * - `currentStepId` — the step the task is executing right now. Locating
 *   it marks every earlier stage `done`, that stage `active`, and every
 *   later stage `pending`.
 * - `failedStepId` — the step that failed. Locating it marks that stage
 *   `failed` (overlaying `active`/`done`).
 */
export interface StageProgress {
    readonly currentStepId?: string | null;
    readonly failedStepId?: string | null;
}

/** A single stage paired with the state {@link deriveStageStates} derived for it. */
export interface StageWithState {
    readonly stage: FlowStage;
    readonly state: StageState;
}

// ---------------------------------------------------------------------------
// Step-id-keyed derivation
// ---------------------------------------------------------------------------

/**
 * Locate a step id in the ordered stage list. Returns the index, or `-1`
 * when the id is absent (`null` / `undefined` / empty) or not present in
 * the list.
 */
function indexOfStep(
    stages: readonly FlowStage[],
    stepId: string | null | undefined,
): number {
    if (stepId === null || stepId === undefined || stepId === '') return -1;
    return stages.findIndex((s) => s.stepId === stepId);
}

/**
 * Derive the per-stage chip state for an ordered {@link FlowStage} list.
 * Pure function of the inputs.
 *
 * Operates on the FULL list — gates included — so a current/failed step
 * that is itself a gate positions the agent stages around it correctly.
 * Callers render only the `kind === 'agent'` entries.
 *
 * The keying is by step id:
 *
 * 1. Locate the current and failed step ids in the list.
 * 2. The "frontier" is the current step's index if one is located, else
 *    the failed step's index, else `-1` (nothing reached).
 * 3. For each stage at index `i`:
 *      - `i === failedIdx`  → `failed`
 *      - `i === currentIdx` → `active`
 *      - `frontier >= 0 && i < frontier` → `done`
 *      - otherwise → `pending`
 *
 * A current/failed step after all the agent steps (a trailing merge
 * gate) therefore renders every agent stage `done`. When neither id is
 * located (`frontier === -1`) every stage is `pending`, which the
 * renderer treats as "nothing reached".
 */
export function deriveStageStates(
    stages: readonly FlowStage[],
    progress: StageProgress,
): StageWithState[] {
    const currentIdx = indexOfStep(stages, progress.currentStepId);
    const failedIdx = indexOfStep(stages, progress.failedStepId);
    const frontier = currentIdx >= 0 ? currentIdx : failedIdx;

    return stages.map((stage, i) => {
        let state: StageState;
        if (i === failedIdx) state = 'failed';
        else if (i === currentIdx) state = 'active';
        else if (frontier >= 0 && i < frontier) state = 'done';
        else state = 'pending';
        return { stage, state };
    });
}

// ---------------------------------------------------------------------------
// DOM renderer
// ---------------------------------------------------------------------------

/**
 * Narrow Element interface — only the surface the renderer uses. Keeps
 * the file free of a hard `lib: ["dom"]` dependency in tsconfig.json
 * and lets the unit tests pass a hand-rolled shim. In the browser,
 * `HTMLElement` satisfies this shape structurally.
 */
export interface RenderElement {
    className: string;
    textContent: string | null;
    title: string;
    setAttribute(name: string, value: string): void;
    appendChild(child: RenderElement): RenderElement;
}

/** Subset of `Document` the renderer calls into. */
export interface RenderDocument {
    createElement(tagName: string): RenderElement;
}

interface MaybeGlobalDocument {
    document?: RenderDocument;
}

function resolveDocument(doc: RenderDocument | undefined): RenderDocument {
    if (doc) return doc;
    const candidate = (globalThis as MaybeGlobalDocument).document;
    if (!candidate) {
        throw new Error(
            'stage-bar: no document available — pass one explicitly when '
                + 'rendering outside a browser context.',
        );
    }
    return candidate;
}

/**
 * Render the horizontal stage bar for a flow's ordered stages. Returns
 * the root `<ol>` element with one `<li>` chip per `kind === 'agent'`
 * stage, in list order. Returns `null` when the stage list is empty, the
 * flow has no agent stages (a gate-only flow), or the progress snapshot
 * reaches no stage — the caller can leave the host slot untouched.
 *
 * DOM shape (matches the AP-IFG-011 / AP-PAO-008 selectors):
 *
 *   <ol class="stage-bar" aria-label="Pipeline stage">
 *     <li class="stage-cell stage-cell--<state>"
 *         data-stage="<stepId>"
 *         data-state="<state>"
 *         title="<label>">…label…</li>
 *     …
 *   </ol>
 *
 * The `data-stage` and `data-state` attributes are stable hooks for CSS
 * selectors and integration tests. The `stage-cell--<state>` modifier
 * classes carry the visual state without the caller needing to inspect
 * {@link deriveStageStates} directly.
 *
 * @param stages   The flow's ordered stages, as produced by
 *                 `deriveFlowStages` in `core/flow/flow-stages.ts`. Gates
 *                 (`kind === 'gate'`) are filtered out of the strip but
 *                 still position the surrounding agent stages.
 * @param progress The task's current/failed step ids.
 * @param doc      Optional document handle for tests; defaults to
 *                 `globalThis.document`.
 * @returns        The root `<ol>` element, or `null` when nothing should
 *                 render. Freshly constructed on every call.
 */
export function renderStageBar(
    stages: readonly FlowStage[],
    progress: StageProgress,
    doc?: RenderDocument,
): RenderElement | null {
    const states = deriveStageStates(stages, progress);
    const agentStages = states.filter((s) => s.stage.kind === 'agent');
    if (agentStages.length === 0) return null;
    if (!agentStages.some((s) => s.state !== 'pending')) return null;

    const d = resolveDocument(doc);
    const root = d.createElement('ol');
    root.className = 'stage-bar';
    root.setAttribute('aria-label', 'Pipeline stage');

    for (const { stage, state } of agentStages) {
        const cell = d.createElement('li');
        cell.className = `stage-cell stage-cell--${state}`;
        cell.setAttribute('data-stage', stage.stepId);
        cell.setAttribute('data-state', state);
        cell.title = stage.label;
        cell.textContent = stage.label;
        root.appendChild(cell);
    }

    return root;
}
