/**
 * State of a NON-AGENT (gate) flow step — merge-auto, wait-merged,
 * commit-auto, wait-action, worktree-diff-review.
 *
 * These steps run no agent, so they never write a `task_step_summaries`
 * row. Anything that derives step state from those records alone shows
 * them as `pending` forever — a `deploy-nuget` task whose PR had already
 * been auto-merged still listed "Merge (auto): pending" in the task
 * modal (operator report), and the card's stage bar hid gate steps
 * entirely so the merge was invisible there.
 *
 * State is therefore inferred from signals that DO exist:
 *   - the task is parked on this very gate  → `waiting`
 *   - the task reached a terminal status    → `complete` (the flow ran
 *     to the end, so every gate on the way passed)
 *   - a LATER step already has a record     → `complete` (the flow moved
 *     past this gate)
 *   - otherwise                             → `pending`
 *
 * Pure + separately testable (same pattern as `task-tags.ts`,
 * `report-availability.ts`, `task-visibility.ts`).
 */

export type GateStepState = 'pending' | 'waiting' | 'complete';

/** Park reasons, mapped to the gate-step kinds they belong to. */
const PARK_REASON_TO_GATE_KINDS: Readonly<Record<string, readonly string[]>> = {
    'wait-merged': ['wait-merged', 'merge-auto', 'merge', 'pr.merge'],
    'wait-action': ['wait-action'],
    'worktree-diff-review': ['worktree-diff-review'],
};

const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['done', 'archived']);

export interface GateStepInput {
    /** The gate step's `agent` value (its kind), e.g. `merge-auto`. */
    readonly agent: string;
    /** Ordered step ids of the whole flow, for the "moved past it" check. */
    readonly allStepIds: readonly string[];
    /** This gate's step id. */
    readonly stepId: string;
    /** Step ids that have a recorded run (any status). */
    readonly recordedStepIds: ReadonlySet<string>;
    readonly taskStatus: string | null | undefined;
    readonly parkedReason: string | null | undefined;
}

export function gateStepState(input: GateStepInput): GateStepState {
    // Parked ON this gate — the operator (or the auto-merger) is the one
    // holding it.
    if (input.parkedReason) {
        const kinds = PARK_REASON_TO_GATE_KINDS[input.parkedReason] ?? [];
        if (kinds.includes(input.agent)) return 'waiting';
    }
    if (TERMINAL_STATUSES.has(input.taskStatus ?? '')) return 'complete';
    // A later step has run, so the flow already passed this gate.
    const idx = input.allStepIds.indexOf(input.stepId);
    if (idx >= 0) {
        for (const laterId of input.allStepIds.slice(idx + 1)) {
            if (input.recordedStepIds.has(laterId)) return 'complete';
        }
    }
    return 'pending';
}
