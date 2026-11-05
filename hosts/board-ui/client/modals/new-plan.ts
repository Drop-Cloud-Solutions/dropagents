/**
 * New-plan modal (AP-IFF-008 / AP-VP4-013).
 *
 * Multi-step modal that walks the operator through creating a plan,
 * watching the planner agent, reviewing and editing the generated
 * implementation plan, and approving it for decomposition. The state
 * machine has six operator-visible states + a single error state:
 *
 *   np-brief        — initial form. Title + description + an editable
 *                     conventions sub-form (seeded from
 *                     `project.plan_defaults` when present). Submit fires
 *                     the `CreatePlan` command and advances to np-planning.
 *   np-planning     — spinner + polls
 *                     `GET /api/projects/:pid/plans/:planId/decompose-status`
 *                     every {@link DEFAULT_POLL_INTERVAL_MS} ms. The
 *                     polling loop also surfaces the latest plan-review
 *                     `revision` so the operator sees a "Revision N"
 *                     counter while the agent works. Status `complete`
 *                     fetches the plan-review markdown and advances to
 *                     np-plan-review; status `error` surfaces a toast and
 *                     goes to np-error.
 *   np-plan-review  — renders the planner markdown in an editable textarea
 *                     plus a revision counter and three actions: Approve
 *                     (POST `.../approve` with the latest content +
 *                     conventions), Regenerate (reveals an inline feedback
 *                     textarea, then POST `.../regenerate` with the
 *                     feedback so the planner has guidance for revision
 *                     N+1) and Reject (np-rejected end state, then close).
 *   np-decomposing  — intermediate spinner while the approve POST settles
 *                     and the decomposer kicks off. On resolve →
 *                     np-success; on reject → np-error + toast.
 *   np-success      — terminal success state.
 *   np-rejected     — terminal reject state. Rendered for one frame so
 *                     subscribers on the projection bus see the transition,
 *                     then the modal closes itself.
 *   np-error        — failure state.
 *
 * Integration
 * -----------
 * - Mounting: the modal is registered with the AP-IFF-002 overlay
 *   manager via `overlayManager.openOverlay('new-plan', el)` on open
 *   and `closeOverlay('new-plan')` on close. The panel element is
 *   appended under `#overlay-root` (the mount point shipped by
 *   AP-IFF-001) when the host does not supply a custom mount.
 * - Toasts: errors funnel through the AP-IFF-004 `showToast` queue via
 *   the injected {@link NewPlanDeps.showToast}.
 * - Commands: `CreatePlan` and `UpdatePlan` go through a
 *   `NewPlanCommandSink` port. Production wires this to a POST against
 *   `/commands`; tests pass a hand-rolled fake.
 * - Projection reads + approve/regenerate POSTs: decompose-status, the
 *   plan-review draft, approve, and regenerate all go through a single
 *   `PlanReviewClient` port. Production wires this to fetches against
 *   the AP-IFF-005 / AP-IFF-006 worker-api routes (proxied by the board
 *   server per AP-IFF-007); tests pass a fake.
 *
 * Renderer shape
 * --------------
 * Follows the structural-DOM pattern used by AP-IFF-002/003/004 — the
 * module touches a narrow {@link ModalDocument} / {@link ModalElement}
 * surface so unit tests drive it with a hand-rolled shim, no jsdom.
 */

// ---------------------------------------------------------------------------
// Public types — states + port surfaces
// ---------------------------------------------------------------------------

/** Stable id pushed onto the overlay-manager stack. */
import { CORE_ARCHETYPES } from '../../../../core/decomposer/archetypes';

export const NEW_PLAN_OVERLAY_ID = 'new-plan';

/** DOM id of the default mount target. Matches AP-IFF-001 `#overlay-root`. */
export const OVERLAY_ROOT_ID = 'overlay-root';

/** Default decompose-status polling cadence in ms. */
export const DEFAULT_POLL_INTERVAL_MS = 1000;

/** State machine kinds. */
export type NewPlanStateKind =
    | 'np-brief'
    | 'np-planning'
    | 'np-plan-review'
    | 'np-decomposing'
    | 'np-success'
    | 'np-rejected'
    | 'np-error';

/**
 * Seed values for a plan's conventions block. Mirrors the
 * `core/projects/registry.ts#PlanDefaults` shape so the modal can copy
 * the object across without remapping keys.
 */
export interface PlanConventions {
    readonly namespace_root?: string;
    readonly test_framework?: string;
    readonly branch_pattern?: string;
    readonly commit_pattern?: string;
}

/** Ordered list of the four convention fields the brief sub-form renders. */
export const PLAN_CONVENTION_FIELDS: ReadonlyArray<keyof PlanConventions> = [
    'namespace_root',
    'test_framework',
    'branch_pattern',
    'commit_pattern',
];

/**
 * Operator-facing copy for each convention field: a readable label and a
 * placeholder showing example values so the operator can answer "what
 * goes in here?" without leaving the modal. Used by the conventions
 * sub-form renderer; the field names themselves (`namespace_root`, etc.)
 * stay snake_case on the wire because they mirror v1's plan_defaults
 * schema verbatim.
 */
export const CONVENTION_FIELD_META: Readonly<Record<keyof PlanConventions, {
    readonly label: string;
    readonly placeholder: string;
}>> = {
    namespace_root: {
        label: 'Namespace root',
        placeholder: 'Example.Loans, MyCompany.AiPipeline',
    },
    test_framework: {
        label: 'Test framework',
        placeholder: 'xunit, jest, vitest, node:test',
    },
    branch_pattern: {
        label: 'Branch pattern',
        placeholder: 'feature/{task-id}-{slug}',
    },
    commit_pattern: {
        label: 'Commit pattern',
        placeholder: '{task-id}: {description}',
    },
};

export interface NewPlanBrief {
    readonly kind: 'np-brief';
    readonly projectId: string;
    /** Conventions seeded from `project.plan_defaults`. Always populated;
     *  fields the project did not declare stay undefined. */
    readonly conventions: PlanConventions;
}

export interface NewPlanPlanning {
    readonly kind: 'np-planning';
    readonly projectId: string;
    readonly planId: string;
    readonly conventions: PlanConventions;
    /**
     * Highest plan-review revision the decompose-status payload has
     * surfaced so far. Undefined until the engine reports one. The
     * reducer only allows the value to monotonically increase so a
     * late-arriving low-revision payload cannot rewind the counter.
     */
    readonly revision?: number;
}

export interface NewPlanPlanReview {
    readonly kind: 'np-plan-review';
    readonly projectId: string;
    readonly planId: string;
    readonly markdown: string;
    readonly generatedAt: number;
    readonly conventions: PlanConventions;
    readonly revision?: number;
}

export interface NewPlanDecomposing {
    readonly kind: 'np-decomposing';
    readonly projectId: string;
    readonly planId: string;
    readonly revision?: number;
}

export interface NewPlanSuccess {
    readonly kind: 'np-success';
    readonly projectId: string;
    readonly planId: string;
    readonly revision?: number;
}

export interface NewPlanRejected {
    readonly kind: 'np-rejected';
    readonly projectId: string;
    readonly planId: string;
}

export interface NewPlanError {
    readonly kind: 'np-error';
    readonly projectId: string;
    readonly planId?: string;
    readonly message: string;
}

export type NewPlanState =
    | NewPlanBrief
    | NewPlanPlanning
    | NewPlanPlanReview
    | NewPlanDecomposing
    | NewPlanSuccess
    | NewPlanRejected
    | NewPlanError;

// ---------------------------------------------------------------------------
// Plan-lifecycle event vocabulary + pure reducer
// ---------------------------------------------------------------------------

/**
 * Events the modal listens for. The vocabulary is intentionally split
 * between operator intents (`approve-requested`, `regenerate-requested`,
 * `reject-requested`) and projection notifications
 * (`plan-created`, `plan-draft-ready`, `plan-activated`, `*-failed`,
 * `revision-bumped`) so the reducer is the single integration point for
 * both the operator (clicking a button) and the backend (a plan-lifecycle
 * event landing on the projection bus). `error-occurred` is the catch-all
 * that lets any state transition to `np-error` from a single reducer
 * branch.
 *
 * `planId` is required on every variant that targets an in-flight plan
 * so the reducer can drop stale notifications when an operator has
 * already advanced past that plan (close + reopen, regenerate).
 */
export type NewPlanEvent =
    | { readonly kind: 'plan-created'; readonly planId: string }
    | {
          readonly kind: 'plan-draft-ready';
          readonly planId: string;
          readonly markdown: string;
          readonly generatedAt: number;
          /** Revision number this draft maps to. Carried into np-plan-review
           *  so the counter persists across approve/regenerate cycles. */
          readonly revision?: number;
      }
    | { readonly kind: 'planner-failed'; readonly planId: string; readonly message: string }
    | { readonly kind: 'approve-requested'; readonly planId: string }
    | {
          readonly kind: 'regenerate-requested';
          readonly planId: string;
          /** Operator-supplied feedback that motivated the regeneration. */
          readonly feedback?: string;
      }
    | { readonly kind: 'reject-requested'; readonly planId: string }
    | { readonly kind: 'plan-activated'; readonly planId: string }
    | { readonly kind: 'activation-failed'; readonly planId: string; readonly message: string }
    | {
          readonly kind: 'revision-bumped';
          readonly planId: string;
          readonly revision: number;
      }
    | { readonly kind: 'error-occurred'; readonly planId?: string; readonly message: string };

const EMPTY_CONVENTIONS: PlanConventions = Object.freeze({});

/**
 * Core plan archetypes for the "Plan type" dropdown — the fallback when
 * the board has not (or could not) load the install's full list, which
 * adds the enabled stack packs' archetypes (`NewPlanDeps.planTypes`).
 * `value` is the archetype slug; the first entry (`feature`) is the default.
 */
export const PLAN_TYPE_OPTIONS: ReadonlyArray<{
    readonly value: string;
    readonly label: string;
}> = CORE_ARCHETYPES.map((a) => ({ value: a.id, label: a.label }));

/**
 * Pure reducer over `(state, event) -> state`. No DOM access, no async,
 * no side effects — production wiring + unit tests both consume this
 * directly. `null` represents the closed modal.
 *
 * Stale events (a plan-id that doesn't match the current state) are
 * dropped — the reducer returns the input state unchanged so re-entrant
 * notifications from the projection bus can't leak across plans.
 */
export function reduceNewPlan(
    state: NewPlanState | null,
    event: NewPlanEvent,
): NewPlanState | null {
    // error-occurred is the catch-all: any state collapses to np-error so
    // the same reducer branch covers create-plan failures, polling
    // failures, decomposer failures, etc.
    if (event.kind === 'error-occurred') {
        if (state === null) return null;
        if (state.kind === 'np-error') {
            return { ...state, message: event.message, planId: event.planId ?? state.planId };
        }
        const planId = 'planId' in state ? state.planId : event.planId;
        return {
            kind: 'np-error',
            projectId: state.projectId,
            planId,
            message: event.message,
        };
    }

    if (state === null) return null;

    switch (state.kind) {
        case 'np-brief':
            if (event.kind === 'plan-created') {
                return {
                    kind: 'np-planning',
                    projectId: state.projectId,
                    planId: event.planId,
                    conventions: state.conventions,
                };
            }
            return state;

        case 'np-planning':
            if (event.kind === 'plan-draft-ready' && event.planId === state.planId) {
                return {
                    kind: 'np-plan-review',
                    projectId: state.projectId,
                    planId: state.planId,
                    markdown: event.markdown,
                    generatedAt: event.generatedAt,
                    conventions: state.conventions,
                    revision: pickHigherRevision(state.revision, event.revision),
                };
            }
            if (event.kind === 'planner-failed' && event.planId === state.planId) {
                return {
                    kind: 'np-error',
                    projectId: state.projectId,
                    planId: state.planId,
                    message: event.message,
                };
            }
            if (event.kind === 'revision-bumped' && event.planId === state.planId) {
                const next = pickHigherRevision(state.revision, event.revision);
                if (next === state.revision) return state;
                return { ...state, revision: next };
            }
            return state;

        case 'np-plan-review':
            if (event.kind === 'approve-requested' && event.planId === state.planId) {
                return {
                    kind: 'np-decomposing',
                    projectId: state.projectId,
                    planId: state.planId,
                    revision: state.revision,
                };
            }
            if (event.kind === 'regenerate-requested' && event.planId === state.planId) {
                return {
                    kind: 'np-planning',
                    projectId: state.projectId,
                    planId: state.planId,
                    conventions: state.conventions,
                    revision: state.revision,
                };
            }
            if (event.kind === 'reject-requested' && event.planId === state.planId) {
                return {
                    kind: 'np-rejected',
                    projectId: state.projectId,
                    planId: state.planId,
                };
            }
            if (event.kind === 'revision-bumped' && event.planId === state.planId) {
                const next = pickHigherRevision(state.revision, event.revision);
                if (next === state.revision) return state;
                return { ...state, revision: next };
            }
            return state;

        case 'np-decomposing':
            if (event.kind === 'plan-activated' && event.planId === state.planId) {
                return {
                    kind: 'np-success',
                    projectId: state.projectId,
                    planId: state.planId,
                    revision: state.revision,
                };
            }
            if (event.kind === 'activation-failed' && event.planId === state.planId) {
                return {
                    kind: 'np-error',
                    projectId: state.projectId,
                    planId: state.planId,
                    message: event.message,
                };
            }
            return state;

        case 'np-success':
        case 'np-rejected':
        case 'np-error':
            return state;
    }
}

function pickHigherRevision(current: number | undefined, incoming: number | undefined): number | undefined {
    if (incoming === undefined) return current;
    if (current === undefined) return incoming;
    return incoming > current ? incoming : current;
}

// ---------------------------------------------------------------------------
// Port surfaces — minimal so production wiring + tests both satisfy them
// ---------------------------------------------------------------------------

/** Decompose-status response shape — mirrors AP-IFF-005's `DecomposeStatusBody`. */
export interface DecomposeStatusResponse {
    readonly status: 'idle' | 'running' | 'complete' | 'error';
    readonly progress?: { readonly currentStep: number; readonly totalSteps: number };
    readonly errorMessage?: string;
    readonly plannerPhase?: string;
    /** Highest plan-review revision the engine has surfaced so far. */
    readonly revision?: number;
    readonly lastError?: string;
}

/** Plan-review draft shape — mirrors AP-IFF-006's `PlanReviewDraft`. */
export interface PlanReviewDraft {
    readonly markdown: string;
    readonly generatedAt: number;
    /** Revision number for this draft. Optional for backwards compatibility. */
    readonly revision?: number;
}

/**
 * Plan metadata bag — every field the modal collects beyond title +
 * body. The wire mirrors `hosts/board-ui/commands.ts#PlanMetadataPayload`.
 * Optional throughout; only the keys the operator filled in are sent
 * to `createPlan` / `updatePlan` so the validator on the bus doesn't
 * see noise.
 */
export interface NewPlanMetadata {
    readonly conventions?: PlanConventions;
    readonly planType?: string;
    readonly targetRepo?: string;
    readonly techStack?: string;
    readonly deployAfterMerge?: boolean;
    readonly skipPlanReview?: boolean;
    readonly autoTrigger?: boolean;
}

/** Inputs to the {@link NewPlanCommandSink.createPlan} call. */
export interface CreatePlanInput {
    readonly projectId: string;
    readonly title: string;
    readonly body?: string;
    /** Conventions captured from the brief sub-form. Forwarded to the
     *  CreatePlan command so the planner sees them on revision 1.
     *  Retained for callers that only care about conventions; new
     *  callers should prefer the bundled `metadata` field which
     *  carries the full advanced/conventions set. */
    readonly conventions?: PlanConventions;
    /** Full advanced + conventions field set (AP-PAO-019). */
    readonly metadata?: NewPlanMetadata;
    /**
     * Optional client-supplied plan id. When omitted the worker-api
     * mints one. The "Save & run planner" path pre-allocates the id
     * so it can fire the subsequent GeneratePlan against the same
     * planId without waiting for the SSE projection round-trip.
     */
    readonly planId?: string;
}

/** Inputs to the {@link NewPlanCommandSink.updatePlan} call. */
export interface UpdatePlanInput {
    readonly planId: string;
    readonly title?: string;
    readonly body?: string;
    readonly metadata?: NewPlanMetadata;
}

/** Inputs to {@link NewPlanCommandSink.generatePlan}. */
export interface GeneratePlanInput {
    readonly projectId: string;
    readonly planId: string;
    /** Plan body to seed the planner prompt's `# Brief` section. */
    readonly briefContent?: string;
    /** Revision number; first run = 1. */
    readonly revision: number;
}

/**
 * Port over the board command bus. Production wires this to a POST
 * against `/commands` (per `BOARD_UI_COMMAND_ROUTES['/commands/create-plan']`
 * and `/commands/update-plan`); tests pass a fake.
 *
 * `createPlan` must return the new plan's id — the modal needs it to
 * key the decompose-status poll.
 */
export interface NewPlanCommandSink {
    createPlan(input: CreatePlanInput): Promise<{ readonly planId: string }>;
    updatePlan(input: UpdatePlanInput): Promise<void>;
    /**
     * Fire `GeneratePlan` against an existing plan. Hits
     * `POST /api/projects/:pid/plans/:planId/generate-plan` — the
     * orchestrator dispatches the Claude CLI planner against the
     * supplied brief content. Resolves when the request was accepted
     * (planner runs asynchronously; the board observes the result via
     * the live event stream + the plan-review projection).
     */
    generatePlan(input: GeneratePlanInput): Promise<void>;
}

/** Body forwarded to `POST .../plan-review/approve`. */
export interface ApprovePlanInput {
    readonly conventions?: PlanConventions;
    /** Latest content as edited in the np-plan-review textarea. */
    readonly content?: string;
}

/** Body forwarded to `POST .../plan-review/regenerate`. */
export interface RegeneratePlanInput {
    readonly feedback?: string;
}

/**
 * Port over the worker-api projection routes proxied by the board
 * server. Production satisfies this with a thin `fetch` wrapper that
 * POSTs / GETs the AP-IFF routes; tests pass a hand-rolled fake.
 */
export interface PlanReviewClient {
    fetchDecomposeStatus(projectId: string, planId: string): Promise<DecomposeStatusResponse>;
    fetchPlanReview(projectId: string, planId: string): Promise<PlanReviewDraft>;
    /**
     * GET `/api/projects/:pid/plans/:planId` — fetch the plan's latest
     * projection record. The edit-plan flow calls this on open so the
     * modal pre-fills with current data instead of whatever the row
     * list happened to carry. Returns `null` when the plan no longer
     * exists in the projection (archived or deleted) — the modal
     * surfaces that as a toast and stays open with empty fields.
     *
     * `metadata` is the bag of advanced + conventions fields the modal
     * round-trips. Optional on the wire (older projection rows have
     * no metadata column populated); the modal treats absence as "no
     * captured values".
     */
    fetchPlan(
        projectId: string,
        planId: string,
    ): Promise<{
        readonly title?: string;
        readonly body?: string;
        readonly metadata?: NewPlanMetadata;
    } | null>;
    /**
     * POST `.../plan-review/regenerate`. The body carries the operator's
     * feedback when one was supplied; the backend folds the feedback into
     * the next `GeneratePlan` command (revision N+1).
     */
    regeneratePlanReview(
        projectId: string,
        planId: string,
        body?: RegeneratePlanInput,
    ): Promise<void>;
    /**
     * POST `.../plan-review/approve`. The body carries the latest content
     * (as edited in the textarea) and the conventions block; the backend
     * dispatches `DecomposePlan` with both.
     */
    approvePlan(
        projectId: string,
        planId: string,
        body?: ApprovePlanInput,
    ): Promise<void>;
}

/** Unsubscribe handle returned by {@link PlanLifecycleProjection.subscribe}. */
export type PlanLifecycleUnsubscribe = () => void;

/**
 * Subscription port over the plan-lifecycle projection. Production wires
 * this to whatever bus the projection layer exposes (SSE, in-process
 * EventBus, etc.); tests pass a fake that emits {@link NewPlanEvent}s
 * synchronously. The modal subscribes when it enters `np-planning` and
 * unsubscribes when it leaves so listeners don't leak across plans.
 *
 * The polling loop and the projection both funnel through the same
 * reducer so the modal's behaviour is identical whether the backend
 * pushes events or whether the legacy decompose-status poll uncovers them.
 */
export interface PlanLifecycleProjection {
    subscribe(
        planId: string,
        listener: (event: NewPlanEvent) => void,
    ): PlanLifecycleUnsubscribe;
}

// ---------------------------------------------------------------------------
// Toast + overlay-manager surfaces — structural subsets of the real modules
// ---------------------------------------------------------------------------

export type ToastKind = 'info' | 'error' | 'success';

export interface ToastInput {
    readonly message: string;
    readonly kind?: ToastKind;
}

export type ShowToastFn = (input: ToastInput) => void;

/**
 * Minimal overlay-manager surface the modal needs. The real
 * `OverlayManager` (AP-IFF-002) satisfies this structurally.
 */
export interface OverlayManagerLike {
    openOverlay(id: string, element: unknown): unknown;
    closeOverlay(id: string): void;
}

// ---------------------------------------------------------------------------
// Structural DOM types — keep tests jsdom-free
// ---------------------------------------------------------------------------

export interface ModalEvent {
    preventDefault?(): void;
}

export interface ModalElement {
    className: string;
    textContent: string | null;
    value?: string;
    setAttribute(name: string, value: string): void;
    appendChild(child: ModalElement): ModalElement;
    replaceChildren(...children: ModalElement[]): void;
    remove(): void;
}

export interface ModalDocument {
    getElementById(id: string): ModalElement | null;
    createElement(tagName: string): ModalElement;
}

interface ModalElementWithEvents extends ModalElement {
    onclick?: () => void;
    onsubmit?: (event: ModalEvent) => void;
    /**
     * Native `change` event handler — present on `<input type="file">`.
     * The brief view's attachment picker (migration 021) assigns it to
     * capture the operator's file selection. Fires only in a real browser;
     * the structural-DOM test shim never invokes it.
     */
    onchange?: () => void;
    /**
     * Native `input` event handler. Captured here so the brief view's
     * title-input can drive auto-fill into the plan-abbreviation field
     * (mirrors the new-project modal's wiring). Optional so the
     * conventions-fieldset inputs — which also assign `oninput` but
     * don't share the same surface — type-check against the same
     * widened interface.
     */
    oninput?: () => void;
    /**
     * Native `checked` property — present on `<input type="checkbox">`.
     * Used by the advanced-options checkboxes (Deploy after merge /
     * Skip plan review / Auto-trigger next step) so the modal can both
     * pre-fill the boolean from the fetched plan metadata and read the
     * operator's current selection on submit. Optional so non-checkbox
     * inputs share this structural surface without lying about a field
     * the runtime doesn't actually expose.
     */
    checked?: boolean;
}

interface MaybeGlobalDocument {
    document?: ModalDocument;
}

function resolveDocument(doc: ModalDocument | undefined): ModalDocument {
    if (doc) return doc;
    const candidate = (globalThis as MaybeGlobalDocument).document;
    if (!candidate) {
        throw new Error(
            'new-plan modal: no document available — pass one explicitly when '
                + 'rendering outside a browser context.',
        );
    }
    return candidate;
}

// ---------------------------------------------------------------------------
// Timer surface
// ---------------------------------------------------------------------------

/** Handle returned by {@link TimerPort.setInterval}. Opaque to callers. */
export type IntervalHandle = unknown;

/**
 * Narrow timer port so tests can drive the polling loop with fake
 * timers without monkey-patching globals. Defaults to the host
 * `setInterval` / `clearInterval` in production.
 */
export interface TimerPort {
    setInterval(handler: () => void, ms: number): IntervalHandle;
    clearInterval(handle: IntervalHandle): void;
}

function defaultTimerPort(): TimerPort {
    return {
        setInterval: (handler, ms): IntervalHandle =>
            (globalThis as { setInterval: (h: () => void, m: number) => IntervalHandle }).setInterval(handler, ms),
        clearInterval: (handle): void => {
            (globalThis as { clearInterval: (h: IntervalHandle) => void }).clearInterval(handle);
        },
    };
}

// ---------------------------------------------------------------------------
// Deps + handle
// ---------------------------------------------------------------------------

export interface NewPlanDeps {
    /**
     * The install's plan archetypes (core + enabled packs), read each time
     * the form renders — the board loads them after this modal is built.
     * Absent or empty → the core list.
     */
    readonly planTypes?: () => ReadonlyArray<{ readonly value: string; readonly label: string }>;
    readonly overlayManager: OverlayManagerLike;
    readonly commands: NewPlanCommandSink;
    readonly planReview: PlanReviewClient;
    readonly showToast: ShowToastFn;
    readonly doc?: ModalDocument;
    /** Optional mount root. Defaults to `#overlay-root`. */
    readonly mountRoot?: ModalElement;
    readonly timers?: TimerPort;
    readonly pollIntervalMs?: number;
    /**
     * Optional plan-lifecycle projection. When supplied, the modal
     * subscribes on entry to `np-planning` and unsubscribes on exit so
     * real events drive the reducer directly. Tests inject a fake.
     */
    readonly projection?: PlanLifecycleProjection;
    /**
     * Migration 021: upload an attachment to a freshly-created plan.
     * When supplied, the brief view (create mode only) shows a file
     * picker; on submit the modal pre-mints the planId, creates the plan
     * with it, then uploads each picked file to that plan id. When omitted
     * the picker is hidden — the modal stays attachment-free (and every
     * existing unit test, which doesn't wire this, is unaffected).
     *
     * BOTH submit buttons honour it. "Save & run planner" uploads before
     * dispatching GeneratePlan, because the planner's `# Plan attachments`
     * block is assembled at spawn time; it used to ignore the picked files
     * entirely, which sent design runs out without the input the operator
     * had attached.
     */
    readonly uploadPlanAttachment?: (planId: string, file: File) => Promise<void>;
}

/**
 * One repo entry surfaced in the Target repo dropdown. Mirrors the V1
 * project record's repo shape (`id`, optional display `name`, `url`,
 * optional local `path` override).
 */
export interface NewPlanProjectRepo {
    readonly id: string;
    readonly name?: string;
    readonly url?: string;
    readonly path?: string;
}

/**
 * Existing-plan payload supplied when the modal is opened in **edit
 * mode**. Presence of this field on {@link NewPlanOpenInput} switches
 * the brief view's heading + primary-action label and routes submit to
 * {@link NewPlanCommandSink.updatePlan} instead of `createPlan`.
 *
 * `planId` is what the UpdatePlan command keys on. `planFile` is
 * retained for future use (worker-api plan routes accept the v1-style
 * URL slug); the modal does not read it today but board.ts surfaces it
 * so a follow-up that switches the update path back to the v1 plan-file
 * URL doesn't need a separate plumbing pass.
 */
export interface NewPlanEditTarget {
    readonly planId: string;
    readonly planFile?: string;
    readonly title?: string;
    readonly body?: string;
    /**
     * Plan metadata — conventions + advanced options. Populated by
     * the modal's edit-mode fetch (`applyEditPrefill`) once the
     * `fetchPlan` response arrives; renderBrief reads it to seed the
     * advanced/conventions input values.
     */
    readonly metadata?: NewPlanMetadata;
}

export interface NewPlanOpenInput {
    /**
     * Convention defaults sourced from `project.plan_defaults`. Optional
     * — projects without a `plan_defaults` block open the brief with all
     * four convention inputs blank.
     */
    readonly planDefaults?: PlanConventions;
    /**
     * Display name of the project the plan belongs to. Renders as the
     * heading suffix (`New plan — <projectName>`). Optional — callers
     * that don't know the name (e.g. tests) skip the suffix.
     */
    readonly projectName?: string;
    /**
     * Project abbreviation (max ~4 chars). Renders as a small badge to
     * the right of the Plan title input — V1 parity.
     */
    readonly projectAbbr?: string;
    /**
     * Repos available under the project. Populates the Target repo
     * dropdown. When empty / undefined the dropdown still renders but
     * with only the placeholder option.
     */
    readonly projectRepos?: ReadonlyArray<NewPlanProjectRepo>;
    /**
     * When set, the modal opens in edit mode: the heading reads "Edit
     * plan — …", the title + description inputs pre-populate from the
     * supplied values, and the primary action submits via
     * `commands.updatePlan` instead of `createPlan`.
     */
    readonly existing?: NewPlanEditTarget;
}

export interface NewPlanModalHandle {
    /**
     * Open the modal for the supplied project. Idempotent: re-opening
     * resets state to np-brief. Pass `planDefaults` to seed the
     * conventions sub-form (typically from `project.plan_defaults`).
     */
    open(projectId: string, input?: NewPlanOpenInput): void;
    /** Close the modal, detach the overlay, and stop any in-flight polling. */
    close(): void;
    /** Snapshot of the current state. `null` when closed. */
    getState(): NewPlanState | null;
    /**
     * Submit the np-brief form. Transitions np-brief → np-planning.
     * `conventions` overrides whatever was seeded into the brief state
     * (so a user edit is honoured even when the caller does not feed the
     * change back through `open()`).
     */
    submitCreatePlan(input: {
        readonly title: string;
        readonly body?: string;
        readonly conventions?: PlanConventions;
    }): Promise<void>;
    /**
     * Approve the reviewed plan. Transitions
     * np-plan-review → np-decomposing → np-success.
     * `content` overrides the markdown captured in state (so an edit in
     * the textarea is forwarded to the approve POST without needing a
     * separate dispatch).
     */
    approvePlan(input?: {
        readonly content?: string;
        readonly conventions?: PlanConventions;
    }): Promise<void>;
    /**
     * Reject the reviewed plan. The reducer transitions to np-rejected
     * (so subscribers see the event) and the modal then closes itself.
     * No-op outside np-plan-review.
     */
    rejectPlan(): void;
    /**
     * Regenerate the plan-review draft. Transitions np-plan-review →
     * np-planning, POSTing the operator feedback so the planner can use
     * it for revision N+1.
     */
    regenerate(input?: { readonly feedback?: string }): Promise<void>;
    /**
     * Perform one decompose-status poll. The polling interval calls this
     * internally; tests call it directly to advance the np-planning state
     * deterministically without driving a fake clock. No-op outside
     * np-planning.
     */
    pollOnce(): Promise<void>;
    /**
     * Dispatch a plan-lifecycle event through the reducer. The
     * subscription wiring calls this when the projection emits; tests
     * call it directly to assert event-to-state mappings without a fake
     * projection harness. Returns the new state (or `null` when the
     * event collapsed the modal closed).
     */
    dispatch(event: NewPlanEvent): NewPlanState | null;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createNewPlanModal(deps: NewPlanDeps): NewPlanModalHandle {
    const doc = resolveDocument(deps.doc);
    const timers = deps.timers ?? defaultTimerPort();
    const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

    let panel: ModalElement | null = null;
    let backdrop: ModalElement | null = null;
    let state: NewPlanState | null = null;
    let pollHandle: IntervalHandle | null = null;
    let projectionUnsub: PlanLifecycleUnsubscribe | null = null;
    let projectionPlanId: string | null = null;
    /**
     * Latest values captured from the np-plan-review form inputs. The
     * renderer rebuilds the DOM on every state transition, so the
     * textarea / feedback values would otherwise be lost the moment a
     * revision-bumped event re-rendered the panel. These caches let the
     * renderer seed the rebuilt inputs with the operator's in-flight
     * edits so a keystroke is not destroyed by a background event.
     */
    let pendingMarkdownEdit: string | null = null;
    let pendingFeedback = '';
    let feedbackVisible = false;
    /** Working copy of conventions for the brief sub-form. */
    let briefConventions: PlanConventions = EMPTY_CONVENTIONS;
    /**
     * Files the operator picked in the create-mode brief view (migration
     * 021), held until submit so they can be uploaded against the
     * freshly-minted plan id. Reset on close. `briefAttachmentListEl` is
     * the pending-list container so a pick/remove updates only that node
     * instead of re-rendering the whole brief (which would reset the form
     * inputs to empty).
     */
    let briefAttachments: File[] = [];
    let briefAttachmentListEl: ModalElement | null = null;
    /**
     * Snapshot of the {@link NewPlanOpenInput} the modal was opened with,
     * preserved so the brief renderer can read the project name / abbr /
     * repos every time it rebuilds the DOM (state transitions invoke
     * `render()` afresh; without this the form would lose its V1 chrome
     * on the second render).
     */
    let openedInput: NewPlanOpenInput | null = null;
    /**
     * Refs to the brief view's inputs. Captured during `renderBrief`
     * so (a) submit can gather every field into a single metadata bag
     * without re-traversing the DOM, and (b) the async edit-mode
     * fetchPlan() callback can apply fresh values without forcing a
     * full re-render (which would stomp the conventions sub-form
     * state). All refs are nulled on close and on every state
     * transition out of `np-brief`.
     */
    let briefTitleInput: ModalElementWithEvents | null = null;
    let briefBodyInput: ModalElementWithEvents | null = null;
    let briefPlanTypeSelect: ModalElementWithEvents | null = null;
    let briefTargetRepoSelect: ModalElementWithEvents | null = null;
    let briefTechStackInput: ModalElementWithEvents | null = null;
    let briefDeployCheckbox: ModalElementWithEvents | null = null;
    let briefSkipReviewCheckbox: ModalElementWithEvents | null = null;
    let briefAutoTriggerCheckbox: ModalElementWithEvents | null = null;
    let briefConventionsInputs: ReadonlyMap<
        keyof PlanConventions,
        ModalElementWithEvents
    > | null = null;
    /**
     * Token incremented on every state transition (including close). Async
     * callbacks captured before a transition compare against this when
     * they resolve so a stale poll result doesn't leak into the next state.
     */
    let token = 0;

    function stopPolling(): void {
        if (pollHandle !== null) {
            timers.clearInterval(pollHandle);
            pollHandle = null;
        }
    }

    function stopProjection(): void {
        if (projectionUnsub !== null) {
            projectionUnsub();
            projectionUnsub = null;
            projectionPlanId = null;
        }
    }

    function ensureProjectionFor(planId: string): void {
        if (!deps.projection) return;
        if (projectionPlanId === planId) return;
        stopProjection();
        projectionUnsub = deps.projection.subscribe(planId, (event) => {
            dispatch(event);
        });
        projectionPlanId = planId;
    }

    function setState(next: NewPlanState | null): void {
        const prevKind = state?.kind;
        token++;
        state = next;
        if (next === null || next.kind !== 'np-planning') {
            stopPolling();
        }
        // Drop any pending edit caches when we leave np-plan-review — the
        // operator's in-flight edits are only relevant while that screen
        // is rendered.
        if (next === null || next.kind !== 'np-plan-review') {
            pendingMarkdownEdit = null;
            pendingFeedback = '';
            feedbackVisible = false;
        }
        if (next === null || next.kind !== 'np-brief') {
            // Re-seed when we leave; restored from the freshly-opened state on next entry.
            if (next === null) briefConventions = EMPTY_CONVENTIONS;
        }
        // Terminal states (np-success, np-error, np-rejected) don't listen
        // for further projection events, so drop the subscription. Otherwise
        // keep it active while planId is in play so np-decomposing ->
        // np-success can still observe a `plan-activated` notification.
        const noPlanIdField = next === null || !('planId' in next) || next.planId === undefined;
        const terminal =
            next !== null
            && (next.kind === 'np-success' || next.kind === 'np-error' || next.kind === 'np-rejected');
        if (noPlanIdField || terminal) {
            stopProjection();
        }
        render();
        // np-rejected is an end state that auto-closes the modal one frame
        // after it appears — the render() above gives projection subscribers
        // a chance to see the transition, then we tear down the panel.
        if (
            next !== null
            && next.kind === 'np-rejected'
            && prevKind !== 'np-rejected'
        ) {
            doClose();
        }
    }

    /**
     * Apply an event through the pure reducer and commit the result.
     * Side-effecting bookkeeping (poll start, projection subscribe,
     * toast on error transition) hangs off the state change, not the
     * reducer itself.
     */
    function dispatch(event: NewPlanEvent): NewPlanState | null {
        const prev = state;
        const next = reduceNewPlan(prev, event);
        if (next === prev) return prev;
        // Toast on error transitions so failures surface even when the
        // event came in from the projection rather than an inline await.
        if (next !== null && next.kind === 'np-error' && (prev === null || prev.kind !== 'np-error')) {
            deps.showToast({ message: next.message, kind: 'error' });
        }
        setState(next);
        if (next !== null && next.kind === 'np-planning') {
            startPollingFor(next.projectId, next.planId);
            ensureProjectionFor(next.planId);
        }
        return next;
    }

    function toError(planId: string | undefined, message: string): void {
        // Funnel through the reducer so error-from-any-state stays a
        // single source of truth.
        const reduced = reduceNewPlan(state, { kind: 'error-occurred', planId, message });
        if (reduced === state) {
            // Reducer dropped the event (state was null). Fall back to a
            // toast so the failure isn't silent.
            deps.showToast({ message, kind: 'error' });
            return;
        }
        deps.showToast({ message, kind: 'error' });
        setState(reduced);
    }

    function resolveMountRoot(): ModalElement {
        if (deps.mountRoot) return deps.mountRoot;
        const root = doc.getElementById(OVERLAY_ROOT_ID);
        if (!root) {
            throw new Error(
                `new-plan modal: mount root "#${OVERLAY_ROOT_ID}" not found and no `
                    + 'mountRoot dependency supplied.',
            );
        }
        return root;
    }

    // ---------------------------------------------------------------------
    // Public API
    // ---------------------------------------------------------------------

    function open(projectId: string, input?: NewPlanOpenInput): void {
        if (typeof projectId !== 'string' || projectId.length === 0) {
            throw new Error('new-plan modal: open() requires a non-empty projectId.');
        }
        // Re-opening: tear down the previous panel before mounting a fresh one
        // so the overlay-manager stack stays consistent (no duplicate id).
        if (panel !== null) {
            doClose();
        }
        const root = resolveMountRoot();
        // Backdrop wrapper — `.modal-chrome__overlay` (board.css:1702)
        // gives the panel `position: fixed`, centers it, and dims the
        // page. Matches the project modals' wrapper convention.
        backdrop = doc.createElement('div');
        backdrop.className = 'modal-chrome__overlay';
        backdrop.setAttribute('data-new-plan-overlay', '');
        panel = doc.createElement('div');
        panel.className = 'new-plan-modal modal-chrome';
        panel.setAttribute('data-new-plan-modal', '');
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-modal', 'true');
        panel.setAttribute('aria-labelledby', 'new-plan-title');
        backdrop.appendChild(panel);
        root.appendChild(backdrop);
        deps.overlayManager.openOverlay(NEW_PLAN_OVERLAY_ID, panel);
        openedInput = input ?? null;
        const conventions = input?.planDefaults ?? EMPTY_CONVENTIONS;
        briefConventions = { ...conventions };
        setState({ kind: 'np-brief', projectId, conventions: briefConventions });

        // Edit mode: fetch the up-to-date plan record so the modal shows
        // current title/body regardless of how stale the row list was.
        // Done after setState so the renderer has already created the
        // input refs (`briefTitleInput` / `briefBodyInput`); the
        // callback applies the freshly-fetched values without forcing a
        // full re-render (which would stomp the conventions sub-form).
        if (input?.existing) {
            const target = input.existing;
            const localToken = token;
            void (async (): Promise<void> => {
                try {
                    const fresh = await deps.planReview.fetchPlan(
                        projectId,
                        target.planId,
                    );
                    if (localToken !== token) return; // closed / re-opened
                    if (fresh === null) {
                        // 404 from the worker-api means the sidebar_plans
                        // projection has no row for this (pid, planId).
                        // Most often: the worker-api was restarted after
                        // the row was created, but the plan was created
                        // before the projection subscriber was wired —
                        // or vice-versa. Either way, restarting the
                        // worker-api and recreating the plan rebuilds
                        // the projection. The "archived" wording earlier
                        // was misleading because archive isn't actually
                        // wired today.
                        deps.showToast({
                            message:
                                'Plan details unavailable — the sidebar projection has no record '
                                + 'for this plan id. Restart the worker-api and recreate the '
                                + 'plan if this persists.',
                            kind: 'error',
                        });
                        return;
                    }
                    applyEditPrefill({
                        title: fresh.title,
                        body: fresh.body,
                        metadata: fresh.metadata,
                    });
                } catch (err) {
                    if (localToken !== token) return;
                    deps.showToast({
                        message: errorMessage(err, 'Failed to load plan'),
                        kind: 'error',
                    });
                }
            })();
        }
    }

    /**
     * Apply freshly-fetched plan values to the brief view's inputs
     * without re-rendering. Only overwrites a field when the operator
     * has not started typing (i.e. the input is still empty); preserves
     * in-flight edits so a slow fetch never stomps the operator's work.
     */
    function applyEditPrefill(fresh: {
        readonly title?: string;
        readonly body?: string;
        readonly metadata?: NewPlanMetadata;
    }): void {
        if (briefTitleInput && (briefTitleInput.value ?? '') === '') {
            briefTitleInput.value = fresh.title ?? '';
            // Programmatic value writes don't fire `input` events, so
            // dependent listeners (the abbr auto-fill in particular)
            // would never see the title change. Invoke the handler
            // directly so the abbreviation re-derives from the freshly
            // applied title.
            briefTitleInput.oninput?.();
        }
        if (briefBodyInput && (briefBodyInput.value ?? '') === '') {
            briefBodyInput.value = fresh.body ?? '';
        }
        // Advanced + conventions metadata. Each field is only applied
        // when the input is still empty / unchecked — preserves
        // in-flight operator edits so a slow fetch never stomps work.
        const md = fresh.metadata;
        if (md) {
            if (
                briefPlanTypeSelect
                && (briefPlanTypeSelect.value ?? '') === PLAN_TYPE_OPTIONS[0].value
                && typeof md.planType === 'string'
                && md.planType.length > 0
            ) {
                briefPlanTypeSelect.value = md.planType;
            }
            if (
                briefTargetRepoSelect
                && (briefTargetRepoSelect.value ?? '') === ''
                && typeof md.targetRepo === 'string'
                && md.targetRepo.length > 0
            ) {
                briefTargetRepoSelect.value = md.targetRepo;
            }
            if (
                briefTechStackInput
                && (briefTechStackInput.value ?? '') === ''
                && typeof md.techStack === 'string'
            ) {
                briefTechStackInput.value = md.techStack;
            }
            if (briefDeployCheckbox && briefDeployCheckbox.checked !== true) {
                briefDeployCheckbox.checked = md.deployAfterMerge === true;
            }
            if (briefSkipReviewCheckbox && briefSkipReviewCheckbox.checked !== true) {
                briefSkipReviewCheckbox.checked = md.skipPlanReview === true;
            }
            if (briefAutoTriggerCheckbox && briefAutoTriggerCheckbox.checked !== true) {
                briefAutoTriggerCheckbox.checked = md.autoTrigger === true;
            }
            if (md.conventions && briefConventionsInputs) {
                for (const field of PLAN_CONVENTION_FIELDS) {
                    const input = briefConventionsInputs.get(field);
                    if (!input) continue;
                    if ((input.value ?? '').length > 0) continue;
                    const v = md.conventions[field];
                    if (typeof v === 'string' && v.length > 0) {
                        input.value = v;
                    }
                }
                briefConventions = { ...briefConventions, ...md.conventions };
            }
        }
        // Cache the fetched values into openedInput.existing so a later
        // submit reads "no change" against the latest server state, not
        // against an empty initial.
        if (openedInput?.existing) {
            openedInput = {
                ...openedInput,
                existing: {
                    ...openedInput.existing,
                    title: fresh.title ?? openedInput.existing.title,
                    body: fresh.body ?? openedInput.existing.body,
                    metadata: md ?? openedInput.existing.metadata,
                },
            };
        }
    }

    function doClose(): void {
        token++;
        stopPolling();
        stopProjection();
        if (panel !== null) {
            deps.overlayManager.closeOverlay(NEW_PLAN_OVERLAY_ID);
            // Removing the backdrop tears the panel down with it; we
            // still null `panel` for the renderer guards.
            if (backdrop !== null) {
                backdrop.remove();
                backdrop = null;
            }
            panel = null;
        }
        state = null;
        pendingMarkdownEdit = null;
        pendingFeedback = '';
        feedbackVisible = false;
        briefConventions = EMPTY_CONVENTIONS;
        briefAttachments = [];
        briefAttachmentListEl = null;
        openedInput = null;
        briefTitleInput = null;
        briefBodyInput = null;
        briefPlanTypeSelect = null;
        briefTargetRepoSelect = null;
        briefTechStackInput = null;
        briefDeployCheckbox = null;
        briefSkipReviewCheckbox = null;
        briefAutoTriggerCheckbox = null;
        briefConventionsInputs = null;
    }

    function close(): void {
        doClose();
    }

    async function submitCreatePlan(input: {
        readonly title: string;
        readonly body?: string;
        readonly conventions?: PlanConventions;
        readonly metadata?: NewPlanMetadata;
    }): Promise<void> {
        if (!state || state.kind !== 'np-brief') {
            throw new Error(
                `new-plan modal: submitCreatePlan() requires np-brief state, got "${state?.kind ?? 'closed'}".`,
            );
        }
        const title = (input.title ?? '').trim();
        if (title.length === 0) {
            deps.showToast({ message: 'Title is required', kind: 'error' });
            return;
        }
        const { projectId } = state;
        const conventions = input.conventions ?? briefConventions;
        // Commit the conventions back into the brief state so the
        // subsequent np-planning carries the user-edited values.
        if (input.conventions !== undefined) {
            briefConventions = { ...input.conventions };
            setState({ kind: 'np-brief', projectId, conventions: briefConventions });
        }
        // Create-with-attachments path (migration 021): pre-mint the plan
        // id so the picked files can be uploaded against it, then close
        // with a toast (the plan lands as a draft via SSE, attachments
        // already attached). Keeps the normal create UX — no np-planning
        // poll — just with files. Only taken when the host wired an
        // uploader AND the operator actually picked something.
        const attachFiles = briefAttachments.slice();
        if (deps.uploadPlanAttachment && attachFiles.length > 0) {
            const planId = mintPlanId();
            const localTokenA = token;
            try {
                await deps.commands.createPlan({
                    projectId,
                    planId,
                    title,
                    body: input.body,
                    conventions,
                    metadata: input.metadata,
                });
                if (localTokenA !== token) return;
                let uploaded = 0;
                for (const file of attachFiles) {
                    try {
                        await deps.uploadPlanAttachment(planId, file);
                        uploaded += 1;
                    } catch {
                        /* per-file best-effort; the plan still exists */
                    }
                }
                if (localTokenA !== token) return;
                deps.showToast({
                    message:
                        `Plan created with ${uploaded} attachment(s) — it appears `
                        + 'in the sidebar as a draft. Open it later to generate the plan.',
                    kind: uploaded === attachFiles.length ? 'success' : 'error',
                });
                close();
            } catch (err) {
                if (localTokenA !== token) return;
                toError(undefined, errorMessage(err, 'Create plan failed'));
            }
            return;
        }

        const localToken = token;
        try {
            const result = await deps.commands.createPlan({
                projectId,
                title,
                body: input.body,
                conventions,
                metadata: input.metadata,
            });
            if (localToken !== token) return; // user closed / advanced
            // Without a planId we cannot key the decompose-status poll
            // for the np-planning state — and the v2 REST shim returns
            // an empty planId today (the CreatePlan POST doesn't echo
            // the new id). Rather than land in np-planning and stall
            // forever, close the modal with a success toast: the plan
            // appears in the sidebar via the SSE projection, the
            // operator can open it later to trigger the planner agent
            // once that wiring lands. Tests inject a fake that returns
            // a real planId, so they continue exercising the
            // np-planning → np-plan-review flow.
            if (!result.planId) {
                deps.showToast({
                    message:
                        'Plan created — it appears in the sidebar as a draft. '
                        + 'Open it later to generate the implementation plan.',
                    kind: 'success',
                });
                close();
                return;
            }
            dispatch({ kind: 'plan-created', planId: result.planId });
        } catch (err) {
            if (localToken !== token) return;
            toError(undefined, errorMessage(err, 'Create plan failed'));
        }
    }

    /**
     * Side-effect helper that starts the decompose-status polling loop
     * for a freshly-entered np-planning state. The pure reducer never
     * starts intervals — `dispatch` calls this when the transition into
     * np-planning is committed, mirroring the projection subscribe so
     * both fallback (poll) and forward (projection) paths fire from a
     * single integration point.
     */
    function startPollingFor(_projectId: string, _planId: string): void {
        stopPolling();
        const handle = timers.setInterval(() => {
            void pollOnce();
        }, pollIntervalMs);
        pollHandle = handle;
    }

    async function pollOnce(): Promise<void> {
        if (!state || state.kind !== 'np-planning') return;
        const localToken = token;
        const { projectId, planId } = state;
        let resp: DecomposeStatusResponse;
        try {
            resp = await deps.planReview.fetchDecomposeStatus(projectId, planId);
        } catch (err) {
            if (localToken !== token) return;
            toError(planId, errorMessage(err, 'Decompose status fetch failed'));
            return;
        }
        if (localToken !== token) return;
        if (resp.status === 'error') {
            dispatch({
                kind: 'planner-failed',
                planId,
                message: resp.errorMessage ?? 'Decomposer failed',
            });
            return;
        }
        if (resp.status !== 'complete') {
            // Still running / idle — keep polling. Surface revision
            // bumps eagerly so the counter updates between polls; the
            // dispatch is the last thing we do here so it can safely
            // bump `token` without invalidating any subsequent guard.
            if (typeof resp.revision === 'number') {
                dispatch({ kind: 'revision-bumped', planId, revision: resp.revision });
            }
            return;
        }
        // Status complete — fetch the draft and advance.
        let draft: PlanReviewDraft;
        try {
            draft = await deps.planReview.fetchPlanReview(projectId, planId);
        } catch (err) {
            if (localToken !== token) return;
            toError(planId, errorMessage(err, 'Plan review fetch failed'));
            return;
        }
        if (localToken !== token) return;
        dispatch({
            kind: 'plan-draft-ready',
            planId,
            markdown: draft.markdown,
            generatedAt: draft.generatedAt,
            revision: draft.revision ?? resp.revision,
        });
    }

    async function regenerate(input?: { readonly feedback?: string }): Promise<void> {
        if (!state || state.kind !== 'np-plan-review') {
            throw new Error(
                `new-plan modal: regenerate() requires np-plan-review state, got "${state?.kind ?? 'closed'}".`,
            );
        }
        const { projectId, planId } = state;
        const feedback = input?.feedback ?? pendingFeedback;
        const localToken = token;
        try {
            await deps.planReview.regeneratePlanReview(
                projectId,
                planId,
                feedback.length > 0 ? { feedback } : undefined,
            );
        } catch (err) {
            if (localToken !== token) return;
            toError(planId, errorMessage(err, 'Regenerate failed'));
            return;
        }
        if (localToken !== token) return;
        dispatch({
            kind: 'regenerate-requested',
            planId,
            ...(feedback.length > 0 ? { feedback } : {}),
        });
    }

    async function approvePlan(input?: {
        readonly content?: string;
        readonly conventions?: PlanConventions;
    }): Promise<void> {
        if (!state || state.kind !== 'np-plan-review') {
            throw new Error(
                `new-plan modal: approvePlan() requires np-plan-review state, got "${state?.kind ?? 'closed'}".`,
            );
        }
        const { projectId, planId, markdown, conventions } = state;
        const content = input?.content ?? pendingMarkdownEdit ?? markdown;
        // Empty-body guard: refuse to approve when the resolved content is
        // blank/whitespace. A cleared textarea must not POST an empty plan
        // body to the worker — surface a toast and stay in np-plan-review so
        // the operator can retype or reject.
        if (content.trim().length === 0) {
            deps.showToast({ message: 'Plan body is required', kind: 'error' });
            return;
        }
        const finalConventions = input?.conventions ?? conventions;
        dispatch({ kind: 'approve-requested', planId });
        const localToken = token;
        try {
            await deps.planReview.approvePlan(projectId, planId, {
                content,
                conventions: finalConventions,
            });
        } catch (err) {
            if (localToken !== token) return; // closed / advanced during await
            toError(planId, errorMessage(err, 'Approve plan failed'));
            return;
        }
        if (localToken !== token) return;
        dispatch({ kind: 'plan-activated', planId });
    }

    function rejectPlan(): void {
        if (!state || state.kind !== 'np-plan-review') return;
        const { planId } = state;
        // Surface the reject as a domain event first so subscribers on
        // the projection bus see the transition, then collapse the modal.
        dispatch({ kind: 'reject-requested', planId });
    }

    function getState(): NewPlanState | null {
        return state;
    }

    // ---------------------------------------------------------------------
    // Renderer
    // ---------------------------------------------------------------------

    function render(): void {
        if (panel === null || state === null) return;
        panel.setAttribute('data-state', state.kind);
        // Top-level revision marker. Mirrored from whichever state carries
        // a revision so tests + DOM observers can read it off the panel
        // without walking into the inner body section.
        const stateRevision =
            'revision' in state && typeof state.revision === 'number'
                ? state.revision
                : undefined;
        if (stateRevision !== undefined) {
            panel.setAttribute('data-revision', String(stateRevision));
        }
        const view = (() => {
            switch (state.kind) {
                case 'np-brief':
                    return renderBrief(state);
                case 'np-planning':
                    return renderPlanning(state);
                case 'np-plan-review':
                    return renderPlanReview(state);
                case 'np-decomposing':
                    return renderDecomposing(state);
                case 'np-success':
                    return renderSuccess(state);
                case 'np-rejected':
                    return renderRejected(state);
                case 'np-error':
                    return renderError(state);
            }
        })();
        panel.replaceChildren(view);
    }

    function makeButton(label: string, action: string, onClick: () => void): ModalElement {
        const btn = doc.createElement('button') as ModalElementWithEvents;
        btn.setAttribute('type', 'button');
        btn.setAttribute('data-action', action);
        btn.className = 'np-button';
        btn.textContent = label;
        btn.onclick = onClick;
        return btn;
    }

    function makeConventionsFieldset(
        seed: PlanConventions,
        onInput: (next: PlanConventions) => void,
    ): { readonly el: ModalElement; readonly inputs: ReadonlyMap<keyof PlanConventions, ModalElementWithEvents> } {
        // Wrapper section. Uses a plain `<div>` rather than `<fieldset>`
        // so the browser doesn't impose its own legend/border styling on
        // top of the modal's form-row treatment — the section reads as
        // a continuation of the rest of the form.
        const section = doc.createElement('div');
        section.className = 'np-conventions';
        section.setAttribute('data-conventions', '');

        const heading = doc.createElement('h4');
        heading.className = 'np-conventions__heading';
        heading.textContent = 'Conventions';
        section.appendChild(heading);

        const help = doc.createElement('p');
        help.className = 'form-help np-conventions__help';
        help.textContent
            = 'Optional. Seeded from the project\'s defaults; override any '
              + 'value here to apply it just to this plan. Leave a field blank '
              + 'to inherit the project default.';
        section.appendChild(help);

        const inputs = new Map<keyof PlanConventions, ModalElementWithEvents>();
        const working: { -readonly [K in keyof PlanConventions]?: string } = { ...seed };

        for (const field of PLAN_CONVENTION_FIELDS) {
            const meta = CONVENTION_FIELD_META[field];
            const row = doc.createElement('div');
            row.className = 'form-row';
            row.setAttribute('data-row', `conventions-${field.replace(/_/g, '-')}`);

            const label = doc.createElement('label');
            label.className = 'form-label';
            label.textContent = meta.label;
            row.appendChild(label);

            const input = doc.createElement('input') as ModalElementWithEvents;
            input.setAttribute('type', 'text');
            input.setAttribute('data-input', `conventions.${field}`);
            input.setAttribute('aria-label', meta.label);
            input.setAttribute('placeholder', meta.placeholder);
            input.value = seed[field] ?? '';
            // Mirror keystrokes back into the working copy so the brief
            // submit picks up edits without the test harness needing to
            // wire a synthetic input event.
            (input as ModalElementWithEvents & { oninput?: () => void }).oninput = (): void => {
                if (typeof input.value === 'string' && input.value.length > 0) {
                    working[field] = input.value;
                } else {
                    delete working[field];
                }
                onInput({ ...working });
            };
            row.appendChild(input);
            inputs.set(field, input);
            section.appendChild(row);
        }

        return { el: section, inputs };
    }

    /**
     * Rebuild only the pending-attachments list (migration 021) from
     * `briefAttachments`, leaving the rest of the brief form untouched —
     * a pick/remove must NOT re-render the whole brief, which would reset
     * the title/description inputs to empty.
     */
    function renderBriefAttachments(): void {
        const listEl = briefAttachmentListEl;
        if (!listEl) return;
        const rows: ModalElement[] = [];
        briefAttachments.forEach((file, index) => {
            const li = doc.createElement('li');
            li.className = 'np-attach-item';
            const name = doc.createElement('span');
            name.className = 'np-attach-name';
            name.textContent = file.name || 'attachment';
            li.appendChild(name);
            li.appendChild(
                makeButton('✕', `remove-attachment-${index}`, () => {
                    briefAttachments.splice(index, 1);
                    renderBriefAttachments();
                }),
            );
            rows.push(li);
        });
        listEl.replaceChildren(...rows);
    }

    function renderBrief(s: NewPlanBrief): ModalElement {
        const wrap = doc.createElement('section');
        wrap.className = 'np-state np-state--brief';
        wrap.setAttribute('data-state-body', 'np-brief');
        wrap.setAttribute('data-project-id', s.projectId);

        const projectName = openedInput?.projectName ?? '';
        const projectRepos = openedInput?.projectRepos ?? [];

        /**
         * Tracks whether the operator has hand-edited the plan-abbr input.
         * When false, typing into the title regenerates the abbr from
         * {@link suggestPlanAbbr}. Once the operator types into the abbr
         * field directly the flag latches to true and auto-fill stops —
         * mirrors {@link createNewProjectModal}'s `abbrIsManual` flag.
         */
        let planAbbrIsManual = false;
        const editing = openedInput?.existing;
        if (editing) {
            wrap.setAttribute('data-mode', 'edit');
            wrap.setAttribute('data-plan-id', editing.planId);
        } else {
            wrap.setAttribute('data-mode', 'create');
        }

        // Heading + subtitle. Edit mode swaps both — "Edit plan — …" and
        // a copy line that drops the decompose reference since editing a
        // draft plan does not re-run the decomposer.
        const heading = doc.createElement('h3');
        heading.setAttribute('id', 'new-plan-title');
        const headingLabel = editing ? 'Edit plan' : 'New plan';
        heading.textContent = projectName
            ? `${headingLabel} — ${projectName}`
            : headingLabel;
        wrap.appendChild(heading);

        const subtitle = doc.createElement('p');
        subtitle.className = 'np-subtitle';
        subtitle.textContent = editing
            ? 'Update the plan\'s metadata. Saved changes apply to this draft '
              + 'without re-running the decomposer.'
            : 'Describe the feature. After saving, Claude will automatically '
              + 'decompose it into tasks.';
        wrap.appendChild(subtitle);

        // PLAN TYPE — dropdown of V1 archetypes. Currently captured into
        // the form snapshot only; backend wiring of `archetype` lands in a
        // follow-up (the existing submitCreatePlan signature only ships
        // title + body + conventions).
        const planTypeRow = makeFormRow('plan-type', 'Plan type');
        const planTypeSelect = doc.createElement('select') as ModalElementWithEvents;
        planTypeSelect.setAttribute('data-input', 'plan-type');
        planTypeSelect.setAttribute('aria-label', 'Plan type');
        const livePlanTypes = deps.planTypes?.() ?? [];
        for (const opt of livePlanTypes.length > 0 ? livePlanTypes : PLAN_TYPE_OPTIONS) {
            const optionEl = doc.createElement('option');
            optionEl.setAttribute('value', opt.value);
            optionEl.textContent = opt.label;
            planTypeSelect.appendChild(optionEl);
        }
        planTypeSelect.value = PLAN_TYPE_OPTIONS[0].value;
        planTypeRow.appendChild(planTypeSelect);
        wrap.appendChild(planTypeRow);

        // TARGET REPO — populated from openedInput.projectRepos. When the
        // project has no repos the dropdown still renders with just the
        // placeholder so the field shape is consistent.
        const repoRow = makeFormRow('target-repo', 'Target repo');
        const repoSelect = doc.createElement('select') as ModalElementWithEvents;
        repoSelect.setAttribute('data-input', 'target-repo');
        repoSelect.setAttribute('aria-label', 'Target repo');
        const placeholderOpt = doc.createElement('option');
        placeholderOpt.setAttribute('value', '');
        placeholderOpt.textContent = projectRepos.length === 0
            ? '(no repos configured)'
            : '(pick a repo)';
        repoSelect.appendChild(placeholderOpt);
        for (const repo of projectRepos) {
            const optionEl = doc.createElement('option');
            optionEl.setAttribute('value', repo.id);
            const label = repo.name ?? repo.id;
            optionEl.textContent = repo.path ? `${label} (${repo.path})` : label;
            repoSelect.appendChild(optionEl);
        }
        repoRow.appendChild(repoSelect);
        wrap.appendChild(repoRow);

        // PLAN TITLE + abbr badge — identical layout to the project
        // modals' title row.
        const titleRow = makeFormRow('title', 'Plan title');
        const titleInput = doc.createElement('input') as ModalElementWithEvents;
        titleInput.setAttribute('type', 'text');
        titleInput.setAttribute('data-input', 'title');
        titleInput.setAttribute('aria-label', 'Plan title');
        titleInput.setAttribute('placeholder', 'e.g. Loan notification 14-day cooldown');
        titleInput.value = editing?.title ?? '';
        briefTitleInput = titleInput;
        titleRow.appendChild(titleInput);

        // Plan abbreviation — auto-derived from the title as the operator
        // types, editable once they care. Mirrors the new-project abbr
        // behaviour: empty initial state, auto-fill on title input, latch
        // to manual on first abbr edit so the auto-fill stops overwriting
        // the operator's choice.
        const abbrBadge = doc.createElement('input') as ModalElementWithEvents;
        abbrBadge.setAttribute('type', 'text');
        abbrBadge.setAttribute('data-input', 'abbr');
        abbrBadge.setAttribute('aria-label', 'Plan abbreviation');
        abbrBadge.setAttribute('placeholder', 'LNC');
        abbrBadge.setAttribute('maxlength', '4');
        const initialAbbr = suggestPlanAbbr(editing?.title ?? '');
        abbrBadge.value = initialAbbr;
        // If we seeded an initial value from the existing title, the
        // operator hasn't typed yet — auto-fill should still track
        // subsequent title edits. Manual-latch only flips when the
        // operator actually types into the abbr field.
        titleRow.appendChild(abbrBadge);
        wrap.appendChild(titleRow);

        titleInput.oninput = (): void => {
            if (!planAbbrIsManual) {
                abbrBadge.value = suggestPlanAbbr(titleInput.value ?? '');
            }
        };
        abbrBadge.oninput = (): void => {
            planAbbrIsManual = true;
        };

        // FEATURE DESCRIPTION — the body / brief / decompose input. V1
        // labels this "Feature description"; we keep that label here too
        // and capture the value into the existing `body` submit field.
        const bodyRow = makeFormRow('description', 'Feature description');
        const bodyInput = doc.createElement('textarea') as ModalElementWithEvents;
        bodyInput.setAttribute('data-input', 'body');
        bodyInput.setAttribute('aria-label', 'Plan description');
        bodyInput.setAttribute(
            'placeholder',
            'Describe what needs to be built in plain language. This becomes '
                + 'the plan description and the input for /decompose.',
        );
        bodyInput.value = editing?.body ?? '';
        briefBodyInput = bodyInput;
        bodyRow.appendChild(bodyInput);
        wrap.appendChild(bodyRow);

        // ── Attachments (migration 021) — create mode only, and only when
        // the host wired an uploader. The operator picks screenshots /
        // mockups / diagrams here; on submit the modal pre-mints the plan
        // id, creates the plan, then uploads each file against it. Edit
        // mode is excluded — an existing plan already has the richer
        // attachments UI (thumbnails, drag/drop, paste) in its plan modal.
        if (!editing && deps.uploadPlanAttachment) {
            const attachRow = makeFormRow('attachments', 'Attachments (optional)');
            const hint = doc.createElement('p');
            hint.className = 'np-attach-hint';
            hint.textContent =
                'Screenshots, mockups, sequence diagrams, or spec docs. The '
                + 'agents will Read them while working on the plan.';
            attachRow.appendChild(hint);

            const fileInput = doc.createElement('input') as ModalElementWithEvents;
            fileInput.setAttribute('type', 'file');
            fileInput.setAttribute('multiple', '');
            fileInput.setAttribute('data-input', 'plan-attachments');
            fileInput.setAttribute('aria-label', 'Plan attachments');
            fileInput.className = 'np-attach-input';
            // onchange fires only in a real browser; tests never trigger it,
            // so the FileList read below stays out of the structural-DOM path.
            fileInput.onchange = (): void => {
                const picked = (fileInput as unknown as { files?: ArrayLike<File> | null }).files;
                if (picked) {
                    for (let i = 0; i < picked.length; i += 1) briefAttachments.push(picked[i]);
                }
                (fileInput as unknown as { value?: string }).value = '';
                renderBriefAttachments();
            };
            attachRow.appendChild(fileInput);

            attachRow.appendChild(
                makeButton('Choose files', 'pick-attachments', () => {
                    (fileInput as unknown as { click?: () => void }).click?.();
                }),
            );

            const list = doc.createElement('ul');
            list.className = 'np-attach-list';
            list.setAttribute('data-attach-list', '');
            briefAttachmentListEl = list;
            attachRow.appendChild(list);
            wrap.appendChild(attachRow);
            renderBriefAttachments();
        }

        // ── Advanced options — collapsible. Holds tech-stack + the
        // three workflow checkboxes (Deploy after merge / Skip plan
        // review / Auto-trigger next step). All five fields round-trip
        // through the projection's `metadata` JSON column; in edit mode
        // the disclosure auto-opens when at least one value is set so
        // the operator immediately sees what's stored.
        const seededMetadata: NewPlanMetadata = editing?.metadata ?? {};
        const seededTechStack = seededMetadata.techStack ?? '';
        const seededDeploy = seededMetadata.deployAfterMerge ?? false;
        const seededSkipReview = seededMetadata.skipPlanReview ?? false;
        const seededAutoTrigger = seededMetadata.autoTrigger ?? false;
        const seededPlanType = seededMetadata.planType ?? PLAN_TYPE_OPTIONS[0].value;
        const seededTargetRepo = seededMetadata.targetRepo ?? '';

        // Seed the dropdowns from the fetched metadata when editing.
        planTypeSelect.value = seededPlanType;
        repoSelect.value = seededTargetRepo;
        briefPlanTypeSelect = planTypeSelect;
        briefTargetRepoSelect = repoSelect;

        const techStackRow = makeFormRow('tech-stack', 'Tech stack (comma separated)');
        const techStackInput = doc.createElement('input') as ModalElementWithEvents;
        techStackInput.setAttribute('type', 'text');
        techStackInput.setAttribute('data-input', 'tech-stack');
        techStackInput.setAttribute('aria-label', 'Tech stack (comma separated)');
        techStackInput.setAttribute('placeholder', 'dotnet8, azure-functions-v4, cosmos-db, xunit');
        techStackInput.value = seededTechStack;
        briefTechStackInput = techStackInput;
        techStackRow.appendChild(techStackInput);

        const deploy = makeCheckboxRow(
            'deploy-after-merge',
            'Deploy after merge',
            '(automatically append a deploy task)',
            seededDeploy,
        );
        briefDeployCheckbox = deploy.input;
        const skipReview = makeCheckboxRow(
            'skip-plan-review',
            'Skip plan review',
            '(small/trivial change — go straight to task decomposition)',
            seededSkipReview,
        );
        briefSkipReviewCheckbox = skipReview.input;
        const autoTrigger = makeAutoTriggerPanel(seededAutoTrigger);
        briefAutoTriggerCheckbox = autoTrigger.input;

        // Auto-open the Advanced disclosure in edit mode when any of
        // the contained fields has a value worth showing.
        const advancedHasValues
            = seededTechStack.length > 0
              || seededDeploy
              || seededSkipReview
              || seededAutoTrigger;
        const advancedDetails = makeCollapsible(
            'advanced',
            'Advanced options',
            !!editing && advancedHasValues,
        );
        advancedDetails.appendChild(techStackRow);
        advancedDetails.appendChild(deploy.row);
        advancedDetails.appendChild(skipReview.row);
        advancedDetails.appendChild(autoTrigger.panel);
        wrap.appendChild(advancedDetails);

        // ── Conventions — collapsible. The sub-form lives in
        // `makeConventionsFieldset`; we wrap its returned element in a
        // `<details>` so the operator can keep the modal short unless
        // they want to override a value. In edit mode the fetched
        // metadata.conventions overrides the project defaults (so the
        // operator sees what's actually saved on the plan, not what's
        // inherited). The disclosure auto-opens when editing AND at
        // least one convention field already has a value.
        const seededConventions: PlanConventions = {
            ...s.conventions,
            ...(seededMetadata.conventions ?? {}),
        };
        const { el: conventionsEl, inputs: conventionInputs } = makeConventionsFieldset(
            seededConventions,
            (next) => {
                briefConventions = next;
            },
        );
        briefConventionsInputs = conventionInputs;
        // Initialise briefConventions to the seeded values so a submit
        // without any operator edits still ships what was loaded.
        briefConventions = { ...seededConventions };
        const conventionsHasValues = PLAN_CONVENTION_FIELDS.some((field) => {
            const v = seededConventions[field];
            return typeof v === 'string' && v.length > 0;
        });
        const conventionsDetails = makeCollapsible(
            'conventions',
            'Conventions',
            !!editing && conventionsHasValues,
        );
        conventionsDetails.appendChild(conventionsEl);
        wrap.appendChild(conventionsDetails);

        // Footer — Cancel + primary submit, right-aligned via `.np-footer`.
        const footer = doc.createElement('div');
        footer.className = 'np-footer';
        footer.appendChild(
            makeButton('Cancel', 'cancel', () => {
                close();
            }),
        );
        const gatherSubmitInput = (): {
            title: string;
            body: string;
            conventions: { -readonly [K in keyof PlanConventions]?: string };
            metadata: NewPlanMetadata | undefined;
        } => {
            const title = titleInput.value ?? '';
            const body = bodyInput.value ?? '';
            const conventions: { -readonly [K in keyof PlanConventions]?: string } = {};
            for (const field of PLAN_CONVENTION_FIELDS) {
                const v = conventionInputs.get(field)?.value;
                if (typeof v === 'string' && v.length > 0) {
                    conventions[field] = v;
                }
            }
            const metadata = gatherMetadata(conventions);
            return { title, body, conventions, metadata };
        };
        const submitLabel = editing ? 'Save changes' : 'Create draft plan';
        footer.appendChild(
            makeButton(submitLabel, 'submit', () => {
                const input = gatherSubmitInput();
                if (editing) {
                    void submitEditPlan({
                        title: input.title,
                        body: input.body,
                        metadata: input.metadata,
                    });
                } else {
                    void submitCreatePlan({
                        title: input.title,
                        body: input.body,
                        conventions: input.conventions,
                        metadata: input.metadata,
                    });
                }
            }),
        );
        // Secondary primary action — "Save & run planner". Saves the
        // current edits (CreatePlan or UpdatePlan), then fires
        // GeneratePlan against the same planId so the operator can
        // kick the planner off without a second click. The planner
        // runs asynchronously; the board picks up the running state
        // via AgentStarted / AgentProgress / PlanGenerated SSE events.
        footer.appendChild(
            makeButton('Save & run planner', 'save-and-run-planner', () => {
                const input = gatherSubmitInput();
                void submitAndRunPlanner({
                    title: input.title,
                    body: input.body,
                    conventions: input.conventions,
                    metadata: input.metadata,
                });
            }),
        );
        wrap.appendChild(footer);

        return wrap;
    }

    /**
     * Edit-mode submit. Forwards the operator's title / body edits to
     * `commands.updatePlan` and closes the modal on success. Mirrors
     * {@link submitCreatePlan}'s token-guard so an in-flight update that
     * resolves after the operator closed the modal does not transition
     * the closed state.
     */
    async function submitEditPlan(input: {
        readonly title: string;
        readonly body?: string;
        readonly metadata?: NewPlanMetadata;
    }): Promise<void> {
        if (!state || state.kind !== 'np-brief') {
            throw new Error(
                `new-plan modal: submitEditPlan() requires np-brief state, got "${state?.kind ?? 'closed'}".`,
            );
        }
        const target = openedInput?.existing;
        if (!target) {
            throw new Error('new-plan modal: submitEditPlan() called without an open edit target.');
        }
        const title = (input.title ?? '').trim();
        if (title.length === 0) {
            deps.showToast({ message: 'Title is required', kind: 'error' });
            return;
        }
        const body = typeof input.body === 'string' ? input.body : undefined;
        const localToken = token;
        try {
            await deps.commands.updatePlan({
                planId: target.planId,
                title: title !== (target.title ?? '') ? title : undefined,
                body,
                metadata: input.metadata,
            });
            if (localToken !== token) return; // user closed during await
            doClose();
        } catch (err) {
            if (localToken !== token) return;
            deps.showToast({
                message: errorMessage(err, 'Save changes failed'),
                kind: 'error',
            });
        }
    }

    /**
     * "Save & run planner" submit. Saves the form (CreatePlan in
     * create mode, UpdatePlan in edit mode), then fires GeneratePlan
     * against the same planId. The planner is dispatched
     * asynchronously by the orchestrator; the board observes the
     * running state via the live event stream.
     *
     * Any files picked in the brief view are uploaded against that
     * planId FIRST — the planner reads its attachments at spawn, so an
     * upload after GeneratePlan arrives too late to be seen. A failed
     * upload cancels the dispatch rather than running the planner on a
     * partial input set.
     *
     * Create mode pre-mints a planId client-side so the subsequent
     * GeneratePlan has a stable key — the CreatePlan REST shim
     * doesn't echo back the new id, and waiting on a projection
     * round-trip would race with the operator closing the modal.
     */
    async function submitAndRunPlanner(input: {
        readonly title: string;
        readonly body: string;
        readonly conventions: { -readonly [K in keyof PlanConventions]?: string };
        readonly metadata: NewPlanMetadata | undefined;
    }): Promise<void> {
        if (!state || state.kind !== 'np-brief') {
            throw new Error(
                `new-plan modal: submitAndRunPlanner() requires np-brief state, got "${state?.kind ?? 'closed'}".`,
            );
        }
        const title = (input.title ?? '').trim();
        if (title.length === 0) {
            deps.showToast({ message: 'Title is required', kind: 'error' });
            return;
        }
        const { projectId } = state;
        const editing = openedInput?.existing;
        const localToken = token;
        try {
            let planId: string;
            if (editing) {
                planId = editing.planId;
                await deps.commands.updatePlan({
                    planId,
                    title:
                        title !== (editing.title ?? '') ? title : undefined,
                    body: typeof input.body === 'string' ? input.body : undefined,
                    metadata: input.metadata,
                });
            } else {
                planId = mintPlanId();
                await deps.commands.createPlan({
                    projectId,
                    planId,
                    title,
                    body: input.body,
                    conventions: input.conventions,
                    metadata: input.metadata,
                });
            }
            if (localToken !== token) return;
            // The operator's picked files, uploaded BEFORE the planner is
            // dispatched. GeneratePlan is what spawns the planner, and the
            // `# Plan attachments` block is built at spawn time from the
            // attachments projection - upload afterwards and the design run
            // goes out blind on input the operator can see sitting in the
            // form.
            //
            // Field report: an investigation plan was created through this
            // button with a document attached, and the investigator
            // reported no input file. The worker log showed CreatePlan and
            // the planner's pre-spawn refresh 0.4s apart with no upload
            // between them - this path never read `briefAttachments` at
            // all, so the file never left the browser. "Create draft plan"
            // uploaded them; "Save & run planner" dropped them silently.
            let uploadedCount = 0;
            const attachFiles = briefAttachments.slice();
            if (deps.uploadPlanAttachment && attachFiles.length > 0) {
                const failed: string[] = [];
                for (const file of attachFiles) {
                    try {
                        await deps.uploadPlanAttachment(planId, file);
                        uploadedCount += 1;
                    } catch {
                        failed.push(file.name || 'attachment');
                    }
                }
                if (localToken !== token) return;
                if (failed.length > 0) {
                    // Never fail silently, and never start a design run on
                    // input the operator believes it has. The plan itself is
                    // saved, so the way forward is to attach the rest from
                    // the plan's own modal and run the planner from there.
                    deps.showToast({
                        message:
                            `Plan saved, but ${failed.length} of ${attachFiles.length} `
                            + `attachment(s) failed to upload (${failed.join(', ')}). `
                            + 'The planner was NOT started - attach them on the plan '
                            + 'and run it from there.',
                        kind: 'error',
                    });
                    close();
                    return;
                }
            }
            await deps.commands.generatePlan({
                projectId,
                planId,
                briefContent:
                    typeof input.body === 'string' && input.body.length > 0
                        ? input.body
                        : undefined,
                revision: 1,
            });
            if (localToken !== token) return;
            deps.showToast({
                message:
                    (uploadedCount > 0
                        ? `${uploadedCount} attachment(s) uploaded. `
                        : '')
                    + 'Planner agent dispatched. Watch the sidebar for the '
                    + '"Planner running" badge and the agent stream.',
                kind: 'success',
            });
            close();
        } catch (err) {
            if (localToken !== token) return;
            deps.showToast({
                message: errorMessage(err, 'Save & run planner failed'),
                kind: 'error',
            });
        }
    }

    /**
     * Mint a fresh planId for the "Save & run planner" create path.
     * Format mirrors what the worker-api would generate (`id-<pid>-
     * <epoch>-<seq>`), but we replace the worker pid with a per-
     * session prefix because the browser doesn't have one. Random
     * enough that two clicks at the same wall-clock millisecond still
     * mint distinct ids.
     */
    function mintPlanId(): string {
        const epoch = Date.now();
        const rand = Math.floor(Math.random() * 1_000_000).toString(36);
        return `plan-${epoch}-${rand}`;
    }

    function makeFormRow(dataRow: string, labelText: string): ModalElement {
        const row = doc.createElement('div');
        row.className = 'form-row';
        row.setAttribute('data-row', dataRow);
        const label = doc.createElement('label');
        label.className = 'form-label';
        label.textContent = labelText;
        row.appendChild(label);
        return row;
    }

    /**
     * Assemble the metadata bag the submit path ships to the wire.
     * Reads from the captured brief-view input refs so callers don't
     * have to scrape the DOM every time. Conventions are passed in
     * explicitly because the call-site already iterated the
     * conventions sub-form's inputs into a typed object. Empty / falsy
     * fields are omitted so the validator on the bus doesn't see noise
     * for fields the operator never touched.
     */
    function gatherMetadata(
        conventions: { -readonly [K in keyof PlanConventions]?: string },
    ): NewPlanMetadata | undefined {
        const planType = (briefPlanTypeSelect?.value ?? '').trim();
        const targetRepo = (briefTargetRepoSelect?.value ?? '').trim();
        const techStack = (briefTechStackInput?.value ?? '').trim();
        const deployAfterMerge = briefDeployCheckbox?.checked === true;
        const skipPlanReview = briefSkipReviewCheckbox?.checked === true;
        const autoTrigger = briefAutoTriggerCheckbox?.checked === true;
        const conventionsHas = Object.keys(conventions).length > 0;
        const metadata: { -readonly [K in keyof NewPlanMetadata]?: NewPlanMetadata[K] } = {};
        if (conventionsHas) metadata.conventions = conventions;
        if (planType.length > 0) metadata.planType = planType;
        if (targetRepo.length > 0) metadata.targetRepo = targetRepo;
        if (techStack.length > 0) metadata.techStack = techStack;
        if (deployAfterMerge) metadata.deployAfterMerge = true;
        if (skipPlanReview) metadata.skipPlanReview = true;
        if (autoTrigger) metadata.autoTrigger = true;
        return Object.keys(metadata).length > 0 ? metadata : undefined;
    }

    /**
     * Derive a 2–4 letter abbreviation from a plan title — first letter
     * of each whitespace-delimited word, uppercased, capped at four
     * characters. Mirrors `createNewProjectModal`'s `suggestAbbrFromName`
     * so both forms feel the same to the operator.
     */
    function suggestPlanAbbr(title: string): string {
        return title
            .split(/\s+/)
            .map((word) => word[0] ?? '')
            .filter((c) => /[A-Za-z]/.test(c))
            .join('')
            .toUpperCase()
            .slice(0, 4);
    }

    /**
     * Build a `<details>` collapsible with a styled `<summary>` header.
     * Callers append the contents directly to the returned element; the
     * native `<details>`/`<summary>` pair handles the toggle without
     * any custom JS so the open/closed state survives a re-render.
     *
     * `defaultOpen=true` sets the `open` attribute up-front (used in
     * edit mode when the wrapped section already has values worth
     * showing). The native browser toggle still lets the operator
     * collapse it manually after open.
     */
    function makeCollapsible(
        dataKey: string,
        summaryLabel: string,
        defaultOpen: boolean,
    ): ModalElement {
        const details = doc.createElement('details');
        details.className = 'np-collapsible';
        details.setAttribute('data-collapsible', dataKey);
        if (defaultOpen) details.setAttribute('open', '');
        const summary = doc.createElement('summary');
        summary.className = 'np-collapsible__summary';
        summary.textContent = summaryLabel;
        details.appendChild(summary);
        return details;
    }

    function makeCheckboxRow(
        field: string,
        labelText: string,
        helperText: string,
        initialChecked: boolean,
    ): { readonly row: ModalElement; readonly input: ModalElementWithEvents } {
        const row = doc.createElement('label');
        row.className = 'checkbox-row';
        row.setAttribute('data-checkbox-row', field);
        const input = doc.createElement('input') as ModalElementWithEvents;
        input.setAttribute('type', 'checkbox');
        input.setAttribute('data-input', field);
        // Set both the property and the attribute so the renderer
        // covers test shims (which only reflect `setAttribute`) AND the
        // real DOM (where `.checked` is the property to write/read).
        if (initialChecked) {
            input.setAttribute('checked', 'true');
            input.checked = true;
        }
        row.appendChild(input);
        const text = doc.createElement('span');
        text.className = 'checkbox-label';
        const primary = doc.createElement('span');
        primary.className = 'checkbox-label-primary';
        primary.textContent = labelText;
        text.appendChild(primary);
        if (helperText) {
            const helper = doc.createElement('span');
            helper.className = 'checkbox-label-helper';
            helper.textContent = ' ' + helperText;
            text.appendChild(helper);
        }
        row.appendChild(text);
        return { row, input };
    }

    function makeAutoTriggerPanel(
        initialChecked: boolean,
    ): { readonly panel: ModalElement; readonly input: ModalElementWithEvents } {
        const panel = doc.createElement('div');
        panel.className = 'highlighted-checkbox-panel';
        panel.setAttribute('data-panel', 'auto-trigger');
        const label = doc.createElement('label');
        label.className = 'checkbox-row';
        const input = doc.createElement('input') as ModalElementWithEvents;
        input.setAttribute('type', 'checkbox');
        input.setAttribute('data-input', 'auto-trigger');
        if (initialChecked) {
            input.setAttribute('checked', 'true');
            input.checked = true;
        }
        label.appendChild(input);
        const text = doc.createElement('span');
        text.className = 'checkbox-label';
        const primary = doc.createElement('span');
        primary.className = 'checkbox-label-primary';
        primary.textContent = 'Auto-trigger next step';
        text.appendChild(primary);
        const helper = doc.createElement('span');
        helper.className = 'checkbox-label-helper';
        helper.textContent
            = ' When a task in this plan completes (e.g. an implement task '
              + 'merges), automatically queue the configured follow-up — '
              + 'usually a deploy. Spawned tasks still require your '
              + 'Approve / Skip per the workflow\'s policy. Leave unchecked '
              + 'to babysit each transition manually.';
        text.appendChild(helper);
        label.appendChild(text);
        panel.appendChild(label);
        return { panel, input };
    }

    function renderPlanning(s: NewPlanPlanning): ModalElement {
        const wrap = doc.createElement('section');
        wrap.className = 'np-state np-state--planning';
        wrap.setAttribute('data-state-body', 'np-planning');
        wrap.setAttribute('data-project-id', s.projectId);
        wrap.setAttribute('data-plan-id', s.planId);
        if (s.revision !== undefined) {
            wrap.setAttribute('data-revision', String(s.revision));
        }

        const msg = doc.createElement('p');
        msg.textContent = 'Planner agent is generating tasks…';
        wrap.appendChild(msg);

        if (s.revision !== undefined) {
            const rev = doc.createElement('span');
            rev.className = 'np-revision';
            rev.setAttribute('data-revision-label', '');
            rev.textContent = `Revision ${s.revision}`;
            wrap.appendChild(rev);
        }

        const spinner = doc.createElement('div');
        spinner.className = 'np-spinner';
        spinner.setAttribute('role', 'status');
        spinner.setAttribute('aria-live', 'polite');
        spinner.textContent = 'Working…';
        wrap.appendChild(spinner);
        return wrap;
    }

    function renderPlanReview(s: NewPlanPlanReview): ModalElement {
        const wrap = doc.createElement('section');
        wrap.className = 'np-state np-state--plan-review';
        wrap.setAttribute('data-state-body', 'np-plan-review');
        wrap.setAttribute('data-plan-id', s.planId);
        if (s.revision !== undefined) {
            wrap.setAttribute('data-revision', String(s.revision));
        }

        const heading = doc.createElement('h3');
        heading.setAttribute('id', 'new-plan-title');
        heading.textContent = 'Review plan';
        wrap.appendChild(heading);

        if (s.revision !== undefined) {
            const rev = doc.createElement('span');
            rev.className = 'np-revision';
            rev.setAttribute('data-revision-label', '');
            rev.textContent = `Revision ${s.revision}`;
            wrap.appendChild(rev);
        }

        // Editable markdown textarea (replaces the read-only <pre>). The
        // operator's edits feed approvePlan() via pendingMarkdownEdit so a
        // background revision-bumped event doesn't destroy in-flight typing.
        const editor = doc.createElement('textarea') as ModalElementWithEvents;
        editor.className = 'np-markdown-editor';
        editor.setAttribute('data-input', 'plan-markdown');
        editor.setAttribute('aria-label', 'Plan body (editable)');
        editor.value = pendingMarkdownEdit ?? s.markdown;
        (editor as ModalElementWithEvents & { oninput?: () => void }).oninput = (): void => {
            pendingMarkdownEdit = typeof editor.value === 'string' ? editor.value : null;
        };
        wrap.appendChild(editor);

        const ts = doc.createElement('span');
        ts.className = 'np-generated-at';
        ts.setAttribute('data-generated-at', String(s.generatedAt));
        ts.textContent = new Date(s.generatedAt).toISOString();
        wrap.appendChild(ts);

        // Feedback textarea — only revealed once the operator clicks
        // Regenerate. Hidden by default to keep the review screen tidy.
        if (feedbackVisible) {
            const fb = doc.createElement('textarea') as ModalElementWithEvents;
            fb.className = 'np-feedback';
            fb.setAttribute('data-input', 'feedback');
            fb.setAttribute('aria-label', 'Regenerate feedback');
            fb.value = pendingFeedback;
            (fb as ModalElementWithEvents & { oninput?: () => void }).oninput = (): void => {
                pendingFeedback = typeof fb.value === 'string' ? fb.value : '';
            };
            wrap.appendChild(fb);

            wrap.appendChild(
                makeButton('Submit feedback', 'regenerate-submit', () => {
                    const feedback = typeof fb.value === 'string' ? fb.value : pendingFeedback;
                    pendingFeedback = feedback;
                    void regenerate({ feedback });
                }),
            );
        }

        wrap.appendChild(
            makeButton('Approve', 'approve', () => {
                const content = typeof editor.value === 'string'
                    ? editor.value
                    : (pendingMarkdownEdit ?? s.markdown);
                pendingMarkdownEdit = content;
                void approvePlan({ content, conventions: s.conventions });
            }),
        );
        wrap.appendChild(
            makeButton('Regenerate', 'regenerate', () => {
                // First click reveals the feedback textarea; if it is
                // already visible, fall through to the submit action so
                // operators who type then click Regenerate again still
                // dispatch the POST.
                if (!feedbackVisible) {
                    feedbackVisible = true;
                    render();
                    return;
                }
                const feedback = pendingFeedback;
                void regenerate({ feedback });
            }),
        );
        wrap.appendChild(
            makeButton('Reject', 'reject', () => {
                rejectPlan();
            }),
        );
        return wrap;
    }

    function renderDecomposing(s: NewPlanDecomposing): ModalElement {
        const wrap = doc.createElement('section');
        wrap.className = 'np-state np-state--decomposing';
        wrap.setAttribute('data-state-body', 'np-decomposing');
        wrap.setAttribute('data-plan-id', s.planId);
        if (s.revision !== undefined) {
            wrap.setAttribute('data-revision', String(s.revision));
        }

        const msg = doc.createElement('p');
        msg.textContent = 'Decomposing plan into tasks…';
        wrap.appendChild(msg);
        return wrap;
    }

    function renderSuccess(s: NewPlanSuccess): ModalElement {
        const wrap = doc.createElement('section');
        wrap.className = 'np-state np-state--success';
        wrap.setAttribute('data-state-body', 'np-success');
        wrap.setAttribute('data-plan-id', s.planId);
        if (s.revision !== undefined) {
            wrap.setAttribute('data-revision', String(s.revision));
        }

        const msg = doc.createElement('p');
        msg.textContent = 'Plan approved.';
        wrap.appendChild(msg);

        wrap.appendChild(
            makeButton('Close', 'close', () => {
                close();
            }),
        );
        return wrap;
    }

    function renderRejected(s: NewPlanRejected): ModalElement {
        const wrap = doc.createElement('section');
        wrap.className = 'np-state np-state--rejected';
        wrap.setAttribute('data-state-body', 'np-rejected');
        wrap.setAttribute('data-plan-id', s.planId);

        const msg = doc.createElement('p');
        msg.textContent = 'Plan rejected.';
        wrap.appendChild(msg);
        return wrap;
    }

    function renderError(s: NewPlanError): ModalElement {
        const wrap = doc.createElement('section');
        wrap.className = 'np-state np-state--error';
        wrap.setAttribute('data-state-body', 'np-error');

        const msg = doc.createElement('p');
        msg.setAttribute('data-error-message', '');
        msg.setAttribute('role', 'alert');
        msg.textContent = s.message;
        wrap.appendChild(msg);

        wrap.appendChild(
            makeButton('Close', 'close', () => {
                close();
            }),
        );
        return wrap;
    }

    function errorMessage(err: unknown, fallback: string): string {
        if (err instanceof Error && err.message) return err.message;
        if (typeof err === 'string' && err.length > 0) return err;
        return fallback;
    }

    return {
        open,
        close,
        getState,
        submitCreatePlan,
        approvePlan,
        rejectPlan,
        regenerate,
        pollOnce,
        dispatch,
    };
}
