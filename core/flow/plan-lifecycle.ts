/**
 * AP-VP4-006: pure state machine for the plan-lifecycle.
 *
 * Models the orchestrator-side states a plan moves through from the
 * operator's initial brief to a fully decomposed task graph:
 *
 *   brief
 *     -- BriefSubmitted -->     planning (revision = 1)
 *     -- PlanGenerated -->      awaiting-approval (revision = N)
 *     -- GeneratePlan -->       planning (revision = N + 1)        [regenerate loop]
 *     -- DecomposePlan -->      decomposing (revision = N)
 *     -- PlanDecomposed -->     ready                              [terminal]
 *     -- PlanDecomposeFailed -> awaiting-approval (revision = N)   [failure recovery]
 *
 * The reducer is intentionally pure — no I/O, no module state, no calls
 * into the agent runner. Handlers (task-010) and projection stores own
 * the side effects; this module decides only the next state given the
 * current state and an incoming event. Unknown / out-of-order events
 * return the input state unchanged so a replay of the event log never
 * fails because two producers raced (the event store de-dupes by
 * idempotency key; the reducer is the second line of defence).
 *
 * Why a discriminated union over `revision`-bearing variants: the modal
 * that asks the operator to approve or regenerate must render the
 * revision number, and the decomposer must know which revision it was
 * launched against. Carrying `revision` on every state where it is
 * meaningful (planning, awaiting-approval, decomposing) keeps that
 * lookup free of an external "current revision" register that could
 * drift out of sync with the state.
 */

/** Plan-lifecycle state as a discriminated union over `kind`. */
export type State =
  | { readonly kind: 'brief' }
  | { readonly kind: 'planning'; readonly revision: number }
  | { readonly kind: 'awaiting-approval'; readonly revision: number }
  | { readonly kind: 'decomposing'; readonly revision: number }
  | { readonly kind: 'ready' };

/**
 * Events the reducer accepts. These are the *inputs* to the state
 * machine, not the persisted event-store envelopes — handlers strip the
 * `payload` / `idempotencyKey` / `occurredAt` fields before feeding
 * `step()`, so the reducer only sees the discriminator it needs.
 *
 *  - `BriefSubmitted`      — operator submitted the brief; start planning.
 *  - `PlanGenerated`       — planner finished a revision; await approval.
 *  - `GeneratePlan`        — operator clicked Regenerate from the
 *                            awaiting-approval modal; bump revision and
 *                            re-enter planning.
 *  - `DecomposePlan`       — operator approved the current revision;
 *                            start decomposing.
 *  - `PlanDecomposed`      — decomposer finished; plan is ready.
 *  - `PlanDecomposeFailed` — decomposer failed; fall back to
 *                            awaiting-approval so the modal can offer
 *                            Regenerate (recovery loop).
 */
export type EventInput =
  | { readonly type: 'BriefSubmitted' }
  | { readonly type: 'PlanGenerated' }
  | { readonly type: 'GeneratePlan' }
  | { readonly type: 'DecomposePlan' }
  | { readonly type: 'PlanDecomposed' }
  | { readonly type: 'PlanDecomposeFailed' };

/** Initial state for a fresh plan, before any brief has been submitted. */
export const initialState: State = { kind: 'brief' };

/**
 * Pure state transition. Returns the input `state` unchanged when the
 * `(state, event)` pair has no defined transition. The reducer never
 * throws, mutates its arguments, or performs I/O — given the same
 * inputs it always returns the same output.
 */
export function step(state: State, event: EventInput): State {
  switch (state.kind) {
    case 'brief': {
      if (event.type === 'BriefSubmitted') {
        return { kind: 'planning', revision: 1 };
      }
      return state;
    }
    case 'planning': {
      if (event.type === 'PlanGenerated') {
        return { kind: 'awaiting-approval', revision: state.revision };
      }
      return state;
    }
    case 'awaiting-approval': {
      if (event.type === 'GeneratePlan') {
        return { kind: 'planning', revision: state.revision + 1 };
      }
      if (event.type === 'DecomposePlan') {
        return { kind: 'decomposing', revision: state.revision };
      }
      return state;
    }
    case 'decomposing': {
      if (event.type === 'PlanDecomposed') {
        return { kind: 'ready' };
      }
      if (event.type === 'PlanDecomposeFailed') {
        return { kind: 'awaiting-approval', revision: state.revision };
      }
      return state;
    }
    case 'ready': {
      return state;
    }
  }
}
