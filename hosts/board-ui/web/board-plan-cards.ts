/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Plan-card renderer for the operator board SPA (AP-IFB-003 + AP-PAO-012).
 *
 * Pure, testable module that owns the per-plan-card DOM shape: the
 * title row, the tech-stack tag container, the plan-stage-bar slot
 * (delegated to the host-side stage-bar derivation), and the
 * conditional V1 action set — {Show agent, Review plan, Activate,
 * Re-decompose, Delete}. The per-status conditional is ported from
 * v1's `pipeline/board/board.js` plan rendering: each plan status
 * exposes a fixed subset of the action set so the operator never
 * sees an action that does not apply (e.g. "Activate" on an already-
 * active plan).
 *
 * AP-PAO-012 layered section-grouping on top of the per-card renderer.
 * Plans now fan into the six AP-PAO-007 section bodies (investigations,
 * draft, attention, progress, completed, archived) instead of the
 * legacy seven-column Kanban grid. The section is derived from each
 * plan's tasks via {@link ../task-tags#deriveTaskTags} — see
 * {@link derivePlanSection} for the precedence rules. The card renderer
 * itself is unchanged; only the fan-out routing changed.
 *
 * The browser-side `hosts/board-ui/board.ts` mirrors this module's
 * derivation by hand, the same way `board-task-cards.ts` is mirrored
 * — the .ts side here is the typed source of truth and test target;
 * board.ts is what the browser actually loads after compilation.
 *
 * Architectural contract
 * ----------------------
 * - Pure of state. Same {@link PlanCardModel} input → same DOM. The
 *   handlers are user-supplied so the caller decides what dispatch
 *   looks like — the renderer NEVER touches `worker-api` directly
 *   (AC #3). Production wiring routes every handler through the
 *   existing `sendCommand` POST adapter in board.ts.
 * - The renderer never reads `globalThis` beyond resolving a default
 *   `document`; unit tests pass a shim, matching the {@link ./stage-bar}
 *   and {@link ./board-task-cards} pattern.
 * - No cross-imports from `pipeline/board/` (AC #5). The legacy v1
 *   tree is gone in v2 and `web/` MUST NOT depend on it; the
 *   conditional-action map below is a port, not a re-export.
 */

import { deriveTaskTags, type DeriveTagsTask } from '../task-tags';

// ---------------------------------------------------------------------------
// Plan projection consumed by the card renderer
// ---------------------------------------------------------------------------

/**
 * Projection of a single plan as the card renderer consumes it. Every
 * field except `planId`/`projectId`/`status` is optional so the renderer
 * can cope with legacy projections that pre-date AP-IFB-003 — the title
 * slot falls back to an empty string, the tech-stack container stays
 * empty when `techStack` is missing, and `planFile` only gates the
 * Delete affordance (a plan whose file slug never made it onto the
 * projection cannot be DELETE-routed without risking the wrong row).
 */
export interface PlanCardModel {
    readonly planId: string;
    readonly projectId: string;
    readonly status: string;
    readonly title?: string;
    readonly techStack?: ReadonlyArray<string>;
    readonly planFile?: string | null;
    /**
     * AP-PAO-012 — plan type. Used to route investigation-type plans
     * into the dedicated Investigations strip regardless of their
     * task-derived tags (per AC #4). Any other value (or absent) is
     * ignored by {@link derivePlanSection} and the plan falls through
     * to the task-tag-driven buckets.
     */
    readonly type?: string;
    /**
     * AP-PAO-012 — archived flag set by the ArchivePlan handler. When
     * true the plan lands in the archived section regardless of its
     * task tags so the operator's "main view" stays focused on live
     * work.
     */
    readonly archived?: boolean;
}

/**
 * Action ids exposed by the plan card. The renderer emits one button
 * per id in {@link derivePlanCardActions}; the host wires each id to a
 * handler in {@link PlanCardHandlers}.
 */
export type PlanCardAction =
    | 'show-agent'
    | 'review-plan'
    | 'activate'
    | 're-decompose'
    | 'delete-plan';

/**
 * Handler set the renderer wires onto the rendered DOM. Each callback
 * receives the plan projection that the click originated from so the
 * caller can dispatch without an extra lookup. Production wires every
 * non-UI handler through `sendCommand` so the operator never reaches
 * worker-api directly.
 */
export interface PlanCardHandlers {
    readonly onShowAgent: (plan: PlanCardModel) => void;
    readonly onReviewPlan: (plan: PlanCardModel) => void;
    readonly onActivate: (plan: PlanCardModel) => void;
    readonly onRedecompose: (plan: PlanCardModel) => void;
    readonly onDelete: (plan: PlanCardModel) => void;
}

// ---------------------------------------------------------------------------
// Render-target shape (mirrors ./board-task-cards RenderElement / RenderDocument)
// ---------------------------------------------------------------------------

export interface RenderElement {
    className: string;
    textContent: string | null;
    title: string;
    hidden: boolean;
    disabled?: boolean;
    setAttribute(name: string, value: string): void;
    appendChild(child: RenderElement): RenderElement;
}

export interface RenderDocument {
    createElement(tagName: string): RenderElement;
}

interface RenderElementWithEvents extends RenderElement {
    onclick?: () => void;
}

interface MaybeGlobalDocument {
    document?: RenderDocument;
}

function resolveDocument(doc: RenderDocument | undefined): RenderDocument {
    if (doc) return doc;
    const candidate = (globalThis as MaybeGlobalDocument).document;
    if (!candidate) {
        throw new Error(
            'board-plan-cards: no document available — pass one explicitly when '
                + 'rendering outside a browser context.',
        );
    }
    return candidate;
}

function attachClick(el: RenderElement, handler: () => void): void {
    (el as RenderElementWithEvents).onclick = handler;
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

// ---------------------------------------------------------------------------
// V1 conditional action map (AP-IFB-003)
// ---------------------------------------------------------------------------

/**
 * Per-status set of plan-card actions, ported from v1's
 * `pipeline/board/board.js` plan rendering. Statuses are normalised to
 * lower-case (and `-`-aliased to `_`) on lookup so a projection that
 * carries `Plan-Ready` or `PLAN_READY` still hits the canonical entry.
 *
 * The map is the SINGLE place per-status policy lives — the renderer
 * itself does not branch on status. A v2 status that grows out of the
 * v1 vocabulary lands here, not in a button's `hidden=true` clause.
 *
 * Order in each tuple is the operator's left-to-right reading order on
 * the rendered card, matching v1. Do not reorder casually — the parity
 * harness compares the DOM to the v1 baseline.
 */
export const PLAN_CARD_ACTION_MAP: Readonly<
    Record<string, ReadonlyArray<PlanCardAction>>
> = {
    // Planner agent is still running. The operator can watch the
    // agent stream but cannot act on plan content that does not exist
    // yet — Activate / Review / Re-decompose all need a generated plan.
    planning: ['show-agent'],

    // Plan content generated, awaiting operator approval. Full action
    // row: review the markdown, activate (kick off the pipeline),
    // re-decompose (regenerate from scratch), or delete entirely.
    plan_ready: ['show-agent', 'review-plan', 'activate', 're-decompose', 'delete-plan'],
    created: ['show-agent', 'review-plan', 'activate', 're-decompose', 'delete-plan'],
    awaiting_review: ['show-agent', 'review-plan', 'activate', 're-decompose', 'delete-plan'],

    // Plan is active and the per-task pipeline is running. Activate
    // is past; Review / Re-decompose would clobber in-flight work.
    // The operator can still inspect the (now-historical) plan-agent
    // stream and delete the plan if they want to abandon it.
    approved: ['show-agent', 'delete-plan'],
    active: ['show-agent', 'delete-plan'],
    in_progress: ['show-agent', 'delete-plan'],
    review: ['show-agent', 'delete-plan'],
    testing: ['show-agent', 'delete-plan'],
    ready_to_commit: ['show-agent', 'delete-plan'],
    ready_to_merge: ['show-agent', 'delete-plan'],

    // Plan finished — Delete is the only remaining action.
    done: ['delete-plan'],
    archived: ['delete-plan'],
};

/**
 * Fallback action set for any status missing from
 * {@link PLAN_CARD_ACTION_MAP}. Matches the v1 "unknown status" branch:
 * surface Show agent + Delete so the operator always has at least the
 * two non-destructive escape hatches.
 */
export const PLAN_CARD_ACTIONS_DEFAULT: ReadonlyArray<PlanCardAction> = [
    'show-agent',
    'delete-plan',
];

/**
 * Resolve the conditional action set for a plan. Normalises the status
 * lookup (lower-case, `-` → `_`) so a projection that carries
 * `Plan-Ready` still routes to the `plan_ready` entry. Returns
 * {@link PLAN_CARD_ACTIONS_DEFAULT} for any unknown status — never
 * `undefined` or empty, so the actions slot is never blank.
 */
export function derivePlanCardActions(
    plan: PlanCardModel,
): ReadonlyArray<PlanCardAction> {
    const raw = (plan.status || '').toLowerCase().replace(/-/g, '_');
    return PLAN_CARD_ACTION_MAP[raw] ?? PLAN_CARD_ACTIONS_DEFAULT;
}

// ---------------------------------------------------------------------------
// Slot renderers
// ---------------------------------------------------------------------------

/**
 * Render the plan-title row. Falls back to an empty string when the
 * projection lacks a `title`; the slot still exists in the DOM so
 * layout is stable across projections (matches the task-card title-row
 * pattern).
 */
export function renderPlanTitle(
    doc: RenderDocument,
    plan: PlanCardModel,
): RenderElement {
    const title = doc.createElement('div');
    title.className = 'plan-title';
    title.setAttribute('data-plan-title', '');
    title.textContent = plan.title ?? '';
    return title;
}

/**
 * Render the tech-stack tag container as one `<span class="tech-tag">`
 * per entry. Returns the container element with no children when the
 * tech-stack is missing or empty — the slot stays in the DOM (so CSS
 * spacing rules apply uniformly) but renders nothing visible.
 */
export function renderTechStackTags(
    doc: RenderDocument,
    techStack: ReadonlyArray<string> | undefined,
): RenderElement {
    const container = doc.createElement('div');
    container.className = 'plan-tech-stack';
    container.setAttribute('data-plan-tech-stack', '');
    if (!techStack || techStack.length === 0) return container;
    for (const tag of techStack) {
        const t = (tag ?? '').toString().trim();
        if (!t) continue;
        const chip = doc.createElement('span');
        chip.className = 'tech-tag';
        chip.setAttribute('data-tech-tag', t);
        chip.textContent = t;
        container.appendChild(chip);
    }
    return container;
}

/**
 * Label for each action button. Kept here (not derived from the action
 * id) so the operator-visible strings match v1 verbatim — "Re-decompose"
 * carries the hyphen, "Show agent" / "Review plan" are two words.
 */
const PLAN_CARD_ACTION_LABEL: Readonly<Record<PlanCardAction, string>> = {
    'show-agent': 'Show agent',
    'review-plan': 'Review plan',
    activate: 'Activate',
    're-decompose': 'Re-decompose',
    'delete-plan': 'Delete',
};

function fireAction(
    action: PlanCardAction,
    plan: PlanCardModel,
    handlers: PlanCardHandlers,
): void {
    switch (action) {
        case 'show-agent':
            handlers.onShowAgent(plan);
            return;
        case 'review-plan':
            handlers.onReviewPlan(plan);
            return;
        case 'activate':
            handlers.onActivate(plan);
            return;
        case 're-decompose':
            handlers.onRedecompose(plan);
            return;
        case 'delete-plan':
            handlers.onDelete(plan);
            return;
    }
}

/**
 * Render the plan-actions row. Emits one `<button data-action="…">`
 * per id in {@link derivePlanCardActions}, in the order the map
 * declares them so the rendered DOM matches v1's reading order.
 */
export function renderPlanActions(
    doc: RenderDocument,
    plan: PlanCardModel,
    handlers: PlanCardHandlers,
): RenderElement {
    const row = doc.createElement('div');
    row.className = 'plan-actions';
    row.setAttribute('data-plan-actions', '');
    for (const action of derivePlanCardActions(plan)) {
        const btn = makeButton(
            doc,
            PLAN_CARD_ACTION_LABEL[action],
            action,
            () => fireAction(action, plan, handlers),
        );
        // The Delete affordance needs a plan-file slug to address the
        // v1-shaped DELETE route. Disable it (rather than omit it) when
        // the projection has not learned the slug yet, so the operator
        // sees the button position is reserved and not just missing.
        if (action === 'delete-plan' && !plan.planFile) {
            btn.disabled = true;
            btn.setAttribute('disabled', 'disabled');
            btn.setAttribute(
                'title',
                'Delete is unavailable: plan file slug missing on this projection.',
            );
        }
        row.appendChild(btn);
    }
    return row;
}

// ---------------------------------------------------------------------------
// Main card renderer
// ---------------------------------------------------------------------------

/**
 * Render a single plan card. Returns the root `<li>` element. The card
 * structure (top → bottom):
 *
 *   <li class="plan-card" data-plan-card data-plan-id="<id>" data-plan-status="<status>">
 *     <header class="plan-header">…id + status…</header>
 *     <div class="plan-title">…title…</div>
 *     <div class="plan-meta">…projectId…</div>
 *     <div class="plan-tech-stack">…tags…</div>
 *     <div class="plan-actions">…conditional buttons…</div>
 *   </li>
 *
 * The plan-stage-bar slot is intentionally NOT emitted here — the host
 * mounts its own stage-bar derivation under `[data-plan-stage-bar]`
 * (see board.ts `renderPlans`). The renderer's job is the title /
 * tech-stack / actions trio; the stage-bar stays on the host side so
 * the per-task max-column derivation does not have to cross modules.
 */
export function renderPlanCard(
    plan: PlanCardModel,
    handlers: PlanCardHandlers,
    options: Readonly<Record<string, never>> = {},
    doc?: RenderDocument,
): RenderElement {
    // `options` is reserved for future flags (e.g. `editing`) — present
    // now to match the task-card signature so callers can adopt it
    // without churning the call site.
    void options;
    const d = resolveDocument(doc);

    const root = d.createElement('li');
    root.className = 'plan-card';
    root.setAttribute('data-plan-card', '');
    root.setAttribute('data-plan-id', plan.planId);
    root.setAttribute('data-plan-status', plan.status);

    const header = d.createElement('header');
    header.className = 'plan-header';
    const idEl = d.createElement('span');
    idEl.className = 'plan-id';
    idEl.setAttribute('data-plan-id', '');
    idEl.textContent = plan.planId;
    header.appendChild(idEl);
    const statusEl = d.createElement('span');
    statusEl.className = 'plan-status';
    statusEl.setAttribute('data-plan-status', '');
    statusEl.textContent = plan.status;
    header.appendChild(statusEl);
    root.appendChild(header);

    root.appendChild(renderPlanTitle(d, plan));

    const meta = d.createElement('div');
    meta.className = 'plan-meta';
    const projectEl = d.createElement('span');
    projectEl.setAttribute('data-plan-project', '');
    projectEl.textContent = plan.projectId;
    meta.appendChild(projectEl);
    root.appendChild(meta);

    root.appendChild(renderTechStackTags(d, plan.techStack));
    root.appendChild(renderPlanActions(d, plan, handlers));

    return root;
}

// ---------------------------------------------------------------------------
// Section grouping (AP-PAO-012)
// ---------------------------------------------------------------------------

/**
 * Canonical ids of the six AP-PAO-007 section panels. The strings match
 * the `data-section="…"` attributes on the panels in
 * `hosts/board-ui/index.html` so the host can resolve each target panel
 * with a single `querySelector('[data-section="<id>"]')` call.
 */
export const PLAN_SECTIONS = [
    'investigations',
    'draft-plans',
    'attention-plans',
    'progress-plans',
    'completed-plans',
    'archived-plans',
] as const;

export type PlanSection = typeof PLAN_SECTIONS[number];

/**
 * Tag set that flips a plan into the attention strip — any task
 * carrying one of these gets the whole plan re-routed regardless of
 * what the rest of its tasks look like. `failed:<stage>` is matched
 * by prefix; `awaiting_clarification` is matched literally.
 */
function isAttentionTag(tag: string): boolean {
    return tag === 'awaiting_clarification' || tag.startsWith('failed:');
}

/**
 * Tag set that flips a plan into the progress strip. Mirrors v1's
 * "the pipeline is actually moving" inventory — every tag between
 * `in_progress` and `ready_to_merge` inclusive.
 */
const PROGRESS_TAGS: ReadonlySet<string> = new Set<string>([
    'in_progress',
    'ready_for_review',
    'ready_for_test',
    'ready_to_commit',
    'ready_to_merge',
]);

/**
 * Tag set that keeps a plan in the draft strip. A plan whose tasks
 * carry only these (no progress, no attention, not all-done) has not
 * actually started moving yet.
 */
const DRAFT_TAGS: ReadonlySet<string> = new Set<string>(['created', 'approved']);

/**
 * Resolve the section bucket a plan belongs to.
 *
 * Precedence (highest first):
 *   1. `plan.archived` flag → archived-plans. Set by the ArchivePlan
 *      handler and overrides every other rule so an archived plan never
 *      leaks back into the active sections after the operator hid it.
 *   2. `plan.type === 'investigation'` → investigations. AC #4 — an
 *      investigation plan lands in the Investigations strip even if
 *      its tasks happen to derive an in-progress / done / etc. tag set.
 *   3. Any task tagged `failed:<stage>` or `awaiting_clarification`
 *      → attention-plans. The plan needs operator eyes right now and
 *      should not be hidden behind the progress count.
 *   4. Any task tagged with a progress tag (in_progress,
 *      ready_for_review, ready_for_test, ready_to_commit,
 *      ready_to_merge) → progress-plans.
 *   5. Every task tagged `done` (and at least one task exists) →
 *      completed-plans.
 *   6. Otherwise (no tasks yet, or only created/approved tags) →
 *      draft-plans. Fresh plans land here before any task starts.
 */
export function derivePlanSection(
    plan: PlanCardModel,
    tasks: ReadonlyArray<DeriveTagsTask> = [],
): PlanSection {
    if (plan.archived) return 'archived-plans';
    if (plan.type === 'investigation') return 'investigations';

    if (tasks.length === 0) return 'draft-plans';

    let hasAttention = false;
    let hasProgress = false;
    let allDone = true;
    let allDraftOrDone = true;

    for (const task of tasks) {
        const tags = deriveTaskTags(task);
        let taskHasDone = false;
        for (const tag of tags) {
            if (isAttentionTag(tag)) {
                hasAttention = true;
                allDraftOrDone = false;
            } else if (PROGRESS_TAGS.has(tag)) {
                hasProgress = true;
                allDraftOrDone = false;
            } else if (tag === 'done') {
                taskHasDone = true;
            } else if (tag === 'skipped') {
                taskHasDone = true;
            } else if (!DRAFT_TAGS.has(tag)) {
                // Any other tag (overlays like ready_for_action) means
                // the plan is not "only draft". Don't pull it into
                // completed either since the task isn't terminal.
                allDraftOrDone = false;
            }
        }
        if (!taskHasDone) allDone = false;
    }

    if (hasAttention) return 'attention-plans';
    if (hasProgress) return 'progress-plans';
    if (allDone) return 'completed-plans';
    if (allDraftOrDone) return 'draft-plans';
    return 'draft-plans';
}

/**
 * Per-section render target. The host resolves these once at startup
 * by querying the AP-PAO-007 scaffold panels: `body` is the
 * `[data-section-body]` slot the card list lives in; `countBadge` is
 * the `[data-count-badge]` span in the panel header.
 *
 * Both elements are written through {@link RenderElement} — no
 * `replaceChildren` is assumed on the structural-DOM surface; callers
 * are responsible for clearing the body before invoking
 * {@link renderPlansBySection}, exactly like the legacy renderer in
 * `board.ts` already does for the Kanban columns.
 */
export interface PlanSectionTarget {
    readonly body: RenderElement;
    readonly countBadge: RenderElement;
}

/** Map of every section panel the renderer needs to fan plans into. */
export type PlanSectionTargets = Readonly<Record<PlanSection, PlanSectionTarget>>;

/**
 * Options consumed by {@link renderPlansBySection}.
 *
 * - `archivedExpanded` — when `false` (the default) the archived section
 *   body is left empty even when the projection carries archived plans.
 *   The count badge still reflects the true archived count so the
 *   operator sees "Archived (12)" while the toggle is collapsed.
 */
export interface RenderPlansBySectionOptions {
    readonly archivedExpanded?: boolean;
}

/**
 * Fan a list of plans into the six AP-PAO-007 section panels and
 * update each panel's count badge.
 *
 * The function appends — it does NOT clear existing children. Callers
 * are expected to clear `target.body` before each render pass; this
 * matches the legacy `planListEl.replaceChildren()` pattern in board.ts
 * and keeps the structural-DOM surface free of a `replaceChildren`
 * method that the existing card-renderer tests would need to mock.
 *
 * Returns the per-section count map so the host can hand it to a
 * telemetry sink or to a test assertion without re-reading the DOM.
 * The count for `archived-plans` reflects the true number of archived
 * plans even when `archivedExpanded` is false.
 */
export function renderPlansBySection(
    plans: ReadonlyArray<PlanCardModel>,
    tasksByPlanId: ReadonlyMap<string, ReadonlyArray<DeriveTagsTask>>,
    handlers: PlanCardHandlers,
    targets: PlanSectionTargets,
    options: RenderPlansBySectionOptions = {},
    doc?: RenderDocument,
): Record<PlanSection, number> {
    const d = resolveDocument(doc);
    const counts: Record<PlanSection, number> = {
        investigations: 0,
        'draft-plans': 0,
        'attention-plans': 0,
        'progress-plans': 0,
        'completed-plans': 0,
        'archived-plans': 0,
    };

    const archivedExpanded = options.archivedExpanded === true;

    for (const plan of plans) {
        const tasks = tasksByPlanId.get(plan.planId) ?? [];
        const section = derivePlanSection(plan, tasks);
        counts[section] += 1;
        // Skip rendering the archived cards when the section is
        // collapsed — the count badge still gets updated below so the
        // operator sees how many plans are hidden behind the toggle.
        if (section === 'archived-plans' && !archivedExpanded) continue;
        const target = targets[section];
        if (!target) continue;
        target.body.appendChild(renderPlanCard(plan, handlers, {}, d));
    }

    for (const section of PLAN_SECTIONS) {
        const target = targets[section];
        if (!target) continue;
        target.countBadge.textContent = String(counts[section]);
    }

    return counts;
}
