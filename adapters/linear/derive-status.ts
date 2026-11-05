/**
 * Linear adapter — port of v1's `deriveStatusFromIssue`.
 *
 * Origin:
 *   - Stage / state branching: `pipeline/plan-linear.ts` (v1)
 *   - Expanded stage set (`action`, `awaiting-clarification`):
 *     `pipeline/shared/linear-sync.ts` (v1)
 *
 * Label vocabulary is unchanged from v1 — no `v2:` prefix:
 *   - `pipeline:stage:<dev|review|test|commit|ready-to-merge|action|awaiting-clarification>`
 *   - `pipeline:human:<approved|merged|commit-approved>`
 *   - `pipeline:failed-stage:<dev|review|test|commit>`
 *
 * Pure helper — given a Linear-shaped issue (state.type + labels[]), returns
 * `{ status, human_status, failed_stage? }`. No Linear API calls, no I/O.
 */

/** Tracker-agnostic workflow state kind. Mirrors Linear's `state.type` values. */
export type LinearIssueStateType =
    | 'triage'
    | 'backlog'
    | 'unstarted'
    | 'started'
    | 'completed'
    | 'canceled';

/** Coarse-grained pipeline status used by the orchestrator / store. */
export type TaskStatus =
    | 'pending'
    | 'in_progress'
    | 'review'
    | 'testing'
    | 'done'
    | 'skipped'
    | 'failed';

/** Operator-facing column the board renders. v1 vocabulary preserved. */
export type HumanStatus =
    | 'created'
    | 'approved'
    | 'ready_for_review'
    | 'ready_for_test'
    | 'ready_to_commit'
    | 'ready_for_action'
    | 'awaiting_clarification'
    | 'ready_to_merge'
    | 'done';

/** Stages that can fail (terminal `pipeline:failed-stage:<stage>` label). */
export type FailedStage = 'dev' | 'review' | 'test' | 'commit';

/**
 * Structural shape this module needs from a tracker issue. Kept open
 * (`labels`, `state.type`) so any adapter — Linear, in-memory test fixture,
 * future Jira — can satisfy it without an import cycle.
 */
export interface LinearIssueLike {
    readonly state: { readonly type: LinearIssueStateType };
    readonly labels: ReadonlyArray<{ readonly name: string }>;
}

export interface DerivedStatus {
    readonly status: TaskStatus;
    readonly human_status: HumanStatus;
    /** Set when a `pipeline:failed-stage:<stage>` label is present. */
    readonly failed_stage?: FailedStage;
}

const STAGE_LABEL_PREFIX = 'pipeline:stage:';
const HUMAN_LABEL_PREFIX = 'pipeline:human:';
const FAILED_STAGE_LABEL_PREFIX = 'pipeline:failed-stage:';

const FAILED_STAGES: ReadonlyArray<FailedStage> = [
    'dev',
    'review',
    'test',
    'commit',
];

const STAGES = [
    'dev',
    'review',
    'test',
    'commit',
    'ready-to-merge',
    'action',
    'awaiting-clarification',
] as const;
type Stage = (typeof STAGES)[number];

/**
 * Derive `{ status, human_status, failed_stage? }` from a Linear issue's
 * workflow state + labels. Direct port of v1's helper — same branches, same
 * defaults, same label names.
 *
 * Branches:
 *   - `backlog` / `triage` → `pending` / `created`
 *   - `unstarted` → `pending` / `approved` when `pipeline:human:approved` is
 *     present, otherwise `pending` / `created`.
 *   - `started` → stage label decides; missing stage falls back to
 *     `in_progress` / `approved`.
 *   - `completed` → `done` / `done` when `pipeline:human:merged` is present,
 *     otherwise `done` / `ready_to_merge`.
 *   - `canceled` → `skipped` / `done`.
 *
 * A `pipeline:failed-stage:<stage>` label forces `status='failed'` and
 * surfaces the stage; the human_status is otherwise untouched so the
 * operator still sees where the task was when it failed.
 */
export function deriveStatusFromIssue(issue: LinearIssueLike): DerivedStatus {
    const labels = issue.labels.map((l) => l.name);
    const hasLabel = (n: string): boolean => labels.includes(n);
    const stateType = issue.state.type;

    let failed_stage: FailedStage | undefined;
    for (const s of FAILED_STAGES) {
        if (hasLabel(`${FAILED_STAGE_LABEL_PREFIX}${s}`)) {
            failed_stage = s;
            break;
        }
    }

    const humanApproved = hasLabel(`${HUMAN_LABEL_PREFIX}approved`);
    const humanMerged = hasLabel(`${HUMAN_LABEL_PREFIX}merged`);

    const stage: Stage | undefined = STAGES.find((s) =>
        hasLabel(`${STAGE_LABEL_PREFIX}${s}`),
    );

    let status: TaskStatus = 'pending';
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
            human_status = 'ready_for_review';
        } else if (stage === 'test') {
            status = 'testing';
            human_status = 'ready_for_test';
        } else if (stage === 'commit') {
            status = 'pending';
            human_status = 'ready_to_commit';
        } else if (stage === 'ready-to-merge') {
            status = 'done';
            human_status = 'ready_to_merge';
        } else if (stage === 'action') {
            status = 'pending';
            human_status = 'ready_for_action';
        } else if (stage === 'awaiting-clarification') {
            status = 'pending';
            human_status = 'awaiting_clarification';
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

    if (failed_stage) status = 'failed';

    return failed_stage
        ? { status, human_status, failed_stage }
        : { status, human_status };
}
