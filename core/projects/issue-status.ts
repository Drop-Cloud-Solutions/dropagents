/**
 * Canonical pipeline status vocabulary + label-to-status derivation.
 *
 * The v1 pipeline kept the `human_status` set and the `deriveStatusFromIssue`
 * function in `pipeline/shared/plan-linear.ts` — i.e. inside the Linear
 * adapter. That mis-placement made it impossible to swap trackers without
 * dragging Linear-specific assumptions along: a Jira adapter would either
 * re-invent the vocabulary or import from a sibling adapter. v2 hoists the
 * vocabulary into `core/` so adapters are pure consumers.
 *
 * Conventions:
 *   - `pipeline:type:<task-type>`         — task taxonomy (scaffold, implement, …)
 *   - `pipeline:stage:<orchestrator-phase>` — current orchestrator phase
 *   - `pipeline:human:<gate>`             — operator-facing gate flags
 *   - `pipeline:failed-stage:<phase>`     — last failed phase (sticky)
 *
 * `ready_for_action` is the new (v2) human_status used when a task parks
 * pending operator input — clarification, wait-action, or wait-merged. The
 * v1 set did not distinguish "the agent is asking the human a question" from
 * "the agent is happily working"; v2 surfaces it as a first-class status so
 * the board can render parked tasks consistently regardless of why they
 * stalled.
 */

/** Pipeline phases the orchestrator advances a task through. */
export const PIPELINE_STAGES = [
    'dev',
    'review',
    'test',
    'commit',
    'ready-to-merge',
] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

/**
 * Canonical operator-facing status vocabulary. NEVER leak Linear workflow
 * state names into UI / chat / docs — translate through this set instead.
 */
export const HUMAN_STATUSES = [
    'created',
    'approved',
    'in_progress',
    'review',
    'testing',
    'ready_to_commit',
    'ready_for_action',
    'ready_to_merge',
    'done',
] as const;
export type HumanStatus = (typeof HUMAN_STATUSES)[number];

/** Internal task-state vocabulary — coarser than `human_status`. */
export type PipelineStatus =
    | 'pending'
    | 'in_progress'
    | 'review'
    | 'testing'
    | 'done'
    | 'skipped'
    | 'failed';

/** Label prefixes carried verbatim on the tracker side. */
export const STAGE_LABEL_PREFIX = 'pipeline:stage:';
export const HUMAN_LABEL_PREFIX = 'pipeline:human:';
export const FAILED_STAGE_LABEL_PREFIX = 'pipeline:failed-stage:';
export const TYPE_LABEL_PREFIX = 'pipeline:type:';

/** Specific human-gate labels referenced by the engine. */
export const HUMAN_LABELS = {
    APPROVED: `${HUMAN_LABEL_PREFIX}approved`,
    COMMIT_APPROVED: `${HUMAN_LABEL_PREFIX}commit-approved`,
    COMMIT_REJECTED: `${HUMAN_LABEL_PREFIX}commit-rejected`,
    MERGED: `${HUMAN_LABEL_PREFIX}merged`,
    /**
     * v2-only label: set whenever a task parks pending operator action, no
     * matter the parking reason (clarification, wait-action, wait-merged).
     * The board surfaces these as the unified "Action required" lane.
     */
    READY_FOR_ACTION: `${HUMAN_LABEL_PREFIX}ready_for_action`,
} as const;

/**
 * Subset of a tracker issue this module needs to derive status. Kept
 * structural (only the fields we read) so it accepts any adapter's issue
 * shape — Linear, Jira, in-memory tests — without an import cycle.
 */
export interface IssueLike {
    readonly state: { readonly type: IssueStateType };
    readonly labels: ReadonlyArray<{ readonly name: string }>;
}

/** Tracker-agnostic workflow state kind. Mirrors Linear's `state.type` values. */
export type IssueStateType =
    | 'triage'
    | 'backlog'
    | 'unstarted'
    | 'started'
    | 'completed'
    | 'canceled';

export interface DerivedStatus {
    readonly status: PipelineStatus;
    readonly human_status: HumanStatus;
    /** Last failed stage, when a `pipeline:failed-stage:*` label is present. */
    readonly failed_stage?: PipelineStage;
}

/**
 * v1-era task types that v2 explicitly does not own — keep them out of the
 * projection so a stale issue from the legacy pipeline doesn't poison the
 * v2 board. Detection is on the `pipeline:type:<task-type>` label only; a
 * legacy issue without that label cannot be silently dropped.
 */
export const V1_CUT_LIST_TASK_TYPES: ReadonlyArray<string> = [
    'swagger',
    'deploy-nuget',
    'bump-package-reference',
];

const V1_CUT_LIST_LABELS: ReadonlySet<string> = new Set(
    V1_CUT_LIST_TASK_TYPES.map((t) => `${TYPE_LABEL_PREFIX}${t}`),
);

/**
 * True when this issue's task-type label belongs to the v1 cut-list. The
 * adapter should silently skip such issues so the legacy pipeline keeps
 * owning them.
 */
export function isCutListIssue(issue: IssueLike): boolean {
    for (const label of issue.labels) {
        if (V1_CUT_LIST_LABELS.has(label.name)) return true;
    }
    return false;
}

/**
 * Derive the pipeline task's (`status`, `human_status`, `failed_stage`) from
 * a tracker issue's workflow state + labels.
 *
 * Direct port of v1's `pipeline/shared/plan-linear.ts#deriveStatusFromIssue`
 * with one v2-only addition: when `pipeline:human:ready_for_action` is
 * present, `human_status` is `'ready_for_action'` regardless of the stage
 * label — a parked task always reports as ready_for_action so the operator
 * UX is uniform whether the agent stopped for clarification or the flow
 * intentionally parked on a wait-* step.
 */
export function deriveStatusFromIssue(issue: IssueLike): DerivedStatus {
    const labels = issue.labels.map((l) => l.name);
    const hasLabel = (n: string): boolean => labels.includes(n);
    const stateType = issue.state.type;

    let failed_stage: PipelineStage | undefined;
    for (const stage of PIPELINE_STAGES) {
        if (stage === 'ready-to-merge') continue;
        if (hasLabel(`${FAILED_STAGE_LABEL_PREFIX}${stage}`)) {
            failed_stage = stage;
            break;
        }
    }

    const humanApproved = hasLabel(HUMAN_LABELS.APPROVED);
    const humanMerged = hasLabel(HUMAN_LABELS.MERGED);
    const readyForAction = hasLabel(HUMAN_LABELS.READY_FOR_ACTION);

    const stage = PIPELINE_STAGES.find((s) =>
        hasLabel(`${STAGE_LABEL_PREFIX}${s}`),
    );

    let status: PipelineStatus = 'pending';
    let human_status: HumanStatus = 'created';

    if (stateType === 'backlog' || stateType === 'triage') {
        status = 'pending';
        human_status = 'created';
    } else if (stateType === 'unstarted') {
        status = 'pending';
        human_status = humanApproved ? 'approved' : 'created';
    } else if (stateType === 'started') {
        if (stage === 'dev') {
            status = 'in_progress';
            human_status = 'approved';
        } else if (stage === 'review') {
            status = 'review';
            human_status = 'review';
        } else if (stage === 'test') {
            status = 'testing';
            human_status = 'testing';
        } else if (stage === 'commit') {
            status = 'pending';
            human_status = 'ready_to_commit';
        } else if (stage === 'ready-to-merge') {
            status = 'done';
            human_status = 'ready_to_merge';
        } else {
            status = 'in_progress';
            human_status = 'approved';
        }
    } else if (stateType === 'completed') {
        status = 'done';
        human_status = humanMerged ? 'done' : 'ready_to_merge';
    } else if (stateType === 'canceled') {
        status = 'skipped';
        human_status = 'done';
    }

    // v2 invariant: a parked-for-action label trumps the stage-derived
    // human_status. Failures keep their own bucket — `failed_stage` is
    // reported via `status='failed'` and the operator sees the failure
    // before the action prompt.
    if (readyForAction && !failed_stage) {
        human_status = 'ready_for_action';
    }

    if (failed_stage) status = 'failed';

    return failed_stage
        ? { status, human_status, failed_stage }
        : { status, human_status };
}

/**
 * Inverse of `deriveStatusFromIssue` for the human_status the writer wants
 * to project onto the tracker. Returns the `pipeline:human:*` label name
 * the adapter should add. Returns `undefined` for statuses that have no
 * dedicated label flip (the orchestrator already encodes them via stage
 * labels) — the adapter should no-op in that case.
 */
export function humanStatusLabel(status: HumanStatus): string | undefined {
    switch (status) {
        case 'approved':
            return HUMAN_LABELS.APPROVED;
        case 'ready_for_action':
            return HUMAN_LABELS.READY_FOR_ACTION;
        case 'done':
            return HUMAN_LABELS.MERGED;
        // 'created', 'in_progress', 'review', 'testing', 'ready_to_commit',
        // 'ready_to_merge' are stage-label-driven, not human-flag-driven.
        default:
            return undefined;
    }
}
