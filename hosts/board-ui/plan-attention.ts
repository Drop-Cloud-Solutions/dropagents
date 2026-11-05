/**
 * Which plans have a task waiting on the OPERATOR.
 *
 * Reported: with a lot of plans running tasks, the board's plan cards all
 * look alike — `3 done · 2 in-progress · 1 todo` says nothing about
 * whether anything is stuck. A task parked at an approval gate, one
 * asking a question, and one that failed all sit inside "in-progress" as
 * far as the card is concerned, so the operator has to open plans one by
 * one to find the one that has been waiting on them for an hour.
 *
 * The distinction that matters is not "is something happening" but "is
 * something waiting for ME". A running developer needs nothing. A task
 * parked at `waiting-deps` needs nothing either — it starts itself when
 * its upstream finishes. A task parked at `approval` will sit there
 * forever.
 *
 * Kept as a separate pure module so the rule is testable without a DOM:
 * the badge is only as useful as its accuracy, and a badge that cries
 * wolf on `waiting-deps` gets ignored within a day.
 */

/** The subset of a task row this needs. Structural, so `TaskRow` fits. */
export interface AttentionTaskLike {
    readonly planId?: string | null;
    readonly status?: string | null;
    readonly parkedReason?: string | null;
    readonly feedback?: string | null;
    readonly commitError?: string | null;
    readonly prUrl?: string | null;
}

/**
 * Why a plan is flagged. Ordered by how much it wants the operator:
 * something broken first, then something waiting.
 */
export type AttentionKind = 'failed' | 'approval' | 'question' | 'review' | 'merge';

export interface PlanAttention {
    /** True when at least one task wants the operator. */
    readonly needsAttention: boolean;
    /** `failed` when anything is broken, else `waiting`. Drives the colour. */
    readonly severity: 'failed' | 'waiting' | 'none';
    /** Count per kind, most severe first. Empty when nothing needs attention. */
    readonly reasons: ReadonlyArray<{ kind: AttentionKind; count: number }>;
    /** One-line summary for the badge's tooltip. */
    readonly summary: string;
}

const NONE: PlanAttention = {
    needsAttention: false,
    severity: 'none',
    reasons: [],
    summary: '',
};

/**
 * Park reasons that are waiting on the OPERATOR.
 *
 * `waiting-deps` is deliberately absent: that task starts itself the
 * moment its upstream finishes, so flagging it would light up most of a
 * healthy board. Same reasoning excludes every in-progress status — an
 * agent working is the normal state, not an alert.
 */
const OPERATOR_PARK_KINDS: Readonly<Record<string, AttentionKind>> = {
    approval: 'approval',
    clarification: 'question',
    'worktree-diff-review': 'review',
    'wait-merged': 'merge',
    'wait-action': 'approval',
};

/** Statuses where nothing further will happen and nothing is owed. */
const CLOSED_STATUSES: ReadonlySet<string> = new Set(['done', 'skipped', 'archived']);

/** Human labels, singular — the summary pluralises. */
const KIND_LABELS: Readonly<Record<AttentionKind, string>> = {
    failed: 'failed',
    approval: 'awaiting approval',
    question: 'awaiting an answer',
    review: 'awaiting review',
    merge: 'awaiting merge',
};

/** Most-wanted first, so the summary leads with the worst thing. */
const KIND_ORDER: readonly AttentionKind[] = [
    'failed', 'question', 'approval', 'review', 'merge',
];

/**
 * Classify ONE task. Returns null when it wants nothing from the operator.
 *
 * Exported because the per-kind rules are the part worth pinning: each
 * one corresponds to an affordance the task card renders, and the badge
 * is a lie if it flags a task whose card offers no button.
 */
export function taskAttentionKind(task: AttentionTaskLike): AttentionKind | null {
    const status = task.status ?? '';
    if (CLOSED_STATUSES.has(status)) return null;

    // A commit that never reached GitHub needs a human to retry the push.
    // Checked before the park map because such a task IS parked at
    // `wait-merged`, and "merge the PR" is the wrong prompt when there is
    // no PR — the card says "Retry push & PR" for exactly this case.
    const parked = task.parkedReason ?? '';
    if (
        (task.commitError !== undefined && task.commitError !== null && task.commitError !== '')
        || (parked === 'wait-merged' && !task.prUrl)
    ) {
        return 'failed';
    }

    // Failed covers an operator rejection too: rejecting a task leaves it
    // failed with the reason in `feedback`, and Retry is the way out.
    if (status === 'failed') return 'failed';

    const kind = OPERATOR_PARK_KINDS[parked];
    return kind ?? null;
}

/**
 * Fold every task of one plan into a single badge state.
 *
 * `tasks` may be the whole board's task list; entries for other plans are
 * ignored, so callers can pass an unfiltered iterable.
 */
export function planAttention(
    planId: string,
    tasks: Iterable<AttentionTaskLike>,
): PlanAttention {
    const counts = new Map<AttentionKind, number>();
    for (const task of tasks) {
        if (task.planId !== planId) continue;
        const kind = taskAttentionKind(task);
        if (kind === null) continue;
        counts.set(kind, (counts.get(kind) ?? 0) + 1);
    }
    if (counts.size === 0) return NONE;

    const reasons = KIND_ORDER
        .filter((k) => counts.has(k))
        .map((k) => ({ kind: k, count: counts.get(k)! }));
    const total = reasons.reduce((n, r) => n + r.count, 0);
    return {
        needsAttention: true,
        severity: counts.has('failed') ? 'failed' : 'waiting',
        reasons,
        summary: `${total} task${total === 1 ? '' : 's'} need${total === 1 ? 's' : ''} you: `
            + reasons.map((r) => `${r.count} ${KIND_LABELS[r.kind]}`).join(', '),
    };
}
