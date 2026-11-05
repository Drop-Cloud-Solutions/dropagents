/**
 * Pure task-tag derivation + per-tag action matrix (AP-PAO-009).
 *
 * Lifted into its own module so it can be imported from both the
 * browser-only `board.ts` entry (which re-exports for the bundle) AND
 * from `board.test.ts` / `web/board-task-cards.ts` without dragging in
 * `board.ts`'s top-level browser wiring (overlay-manager construction,
 * EventSource setup, document queries). No DOM reads, no imports with
 * side effects.
 *
 * One piece of state, deliberately: {@link setExtraWorkRoles}. WHICH agent
 * roles exist beyond the core dev → review → test → commit spine is a
 * property of the flows this install loaded, so a pack's roles cannot be
 * listed here — core must not know a stack's role names. The board fills
 * them from `GET /api/flow-stages` at boot. Everything else is a pure
 * function of its arguments.
 *
 * The v1 board cards rendered a *multi-tag* state — a single card could
 * carry both `in_progress` and `awaiting_clarification`, or surface
 * `failed:test` alongside the step it had been retrying. v2's prior
 * `roleToColumn` / `advanceColumn` pair collapsed that to a single
 * column string, losing the overlay states. `deriveTaskTags` restores
 * the multi-tag projection consumed by the plan-card renderer.
 * action-button matrix the v1 card row exposed.
 */

/** Closed v1 inventory of card tags. */
export type FailedStage = 'dev' | 'review' | 'test' | 'commit';
export type TaskTag =
    | 'created'
    | 'approved'
    | 'in_progress'
    | 'ready_for_review'
    | 'ready_for_test'
    | 'ready_to_commit'
    | 'ready_for_action'
    | 'ready_to_merge'
    | 'awaiting_clarification'
    | 'done'
    | 'skipped'
    | `failed:${FailedStage}`;

/**
 * Structural shape the tag-derivation reads from. Every field is
 * optional so a stale projection (missing `current_step_id`, missing
 * `meta.log`, etc.) still yields a sensible tag set rather than
 * throwing. Mirrors the v1 task record's fields verbatim where they
 * overlap.
 */
export interface DeriveTagsTask {
    readonly status?: string;
    readonly human_status?: string;
    readonly current_step_id?: string | null;
    readonly current_step_status?: string;
    readonly parkedReason?: string | null;
    readonly failed_stage?: string | null;
    /**
     * True iff the most recent committer pass produced a rejection the
     * operator hasn't cleared yet. The v1 board surfaced this as
     * `ready_to_commit` (not `failed:commit`) so the operator saw the
     * commit-approval row, not the retry row. Distinct from
     * `failed_stage='commit'` which is a hard step failure.
     */
    readonly commit_rejected?: boolean;
    readonly meta?: {
        readonly log?: ReadonlyArray<{ agent?: string; event?: string }>;
        readonly failed_stage?: string;
    };
}

/**
 * Structural shape of one event the log-tail fallback reads. The v2
 * board projection stores SSE events shaped like `{ type, payload }`;
 * the only fields the fallback needs are the event type and the
 * agent / role embedded in the payload.
 */
export interface DeriveTagsEvent {
    readonly type: string;
    readonly payload?: {
        readonly agent?: string;
        readonly role?: string;
    };
}

/**
 * Step-id → tag. Covers both v1 step-id strings (`develop`,
 * `approve-commit`) and the bare agent-role strings v2's AgentStarted
 * events carry (`developer`, `reviewer`, …) so the log-tail fallback
 * can route through the same map.
 */
const STEP_ID_TO_TAG: Readonly<Record<string, TaskTag>> = {
    develop: 'in_progress',
    dev: 'in_progress',
    developer: 'in_progress',
    review: 'ready_for_review',
    reviewer: 'ready_for_review',
    test: 'ready_for_test',
    tester: 'ready_for_test',
    'approve-commit': 'ready_to_commit',
    commit: 'ready_to_commit',
    committer: 'ready_to_commit',
    merge: 'ready_to_merge',
    merger: 'ready_to_merge',
    // Extra CORE agent-role steps. These run outside the
    // dev→review→test→commit spine, so the closest sensible member of the
    // closed TaskTag union is `in_progress` — an active work step — rather
    // than falling through to `created`. Kept off STEP_TAG_ORDER so an
    // AgentFinished tail advances them into `ready_for_review` (the existing
    // next-after-in_progress rung), matching the other work steps.
    //
    // A pack's roles are NOT listed here — see setExtraWorkRoles.
    'doc-writer': 'in_progress',
};

/**
 * Agent roles this install runs that the table above does not name: every
 * `kind: 'agent'` step of every loaded flow, core and pack alike.
 *
 * This was four hardcoded entries, three of them the dotnet-azure pack's
 * (`deployer`, `publisher`, `deploy-verifier`) — so core named one stack's
 * roles, and any OTHER pack's roles resolved no tag at all: its cards fell
 * through to `created` and read as idle while an agent was running, which
 * is exactly the bug P-TOTS-003 fixed, fixed for four role names only.
 */
const extraWorkRoles = new Set<string>();

/**
 * Replace the extra work roles (the board passes the loaded flows' agent
 * steps). An empty or unusable list is ignored: a failed `/api/flow-stages`
 * must not silently turn running cards back into idle-looking ones.
 */
export function setExtraWorkRoles(roles: Iterable<string>): void {
    const next = [...roles].filter((r) => typeof r === 'string' && r.length > 0);
    if (next.length === 0) return;
    extraWorkRoles.clear();
    for (const r of next) extraWorkRoles.add(r);
}

/**
 * Tag for a step id / agent role: the core table first, then whatever the
 * loaded flows contributed. An unrecognised id stays `undefined` so a
 * garbage log entry still falls through to `created`.
 */
function tagForStep(stepId: string): TaskTag | undefined {
    return STEP_ID_TO_TAG[stepId] ?? (extraWorkRoles.has(stepId) ? 'in_progress' : undefined);
}

/** Linear step ordering used to advance an AgentFinished tail into the next step's tag. */
const STEP_TAG_ORDER: ReadonlyArray<TaskTag> = [
    'in_progress',
    'ready_for_review',
    'ready_for_test',
    'ready_to_commit',
    'ready_to_merge',
];

const FAILED_STAGES: ReadonlySet<string> = new Set<FailedStage>([
    'dev',
    'review',
    'test',
    'commit',
]);

/**
 * AP-VP-015 — parked-for-approval step-id → v1 status tag.
 *
 * When the flow engine parks a task at an approval gate
 * (`parkedReason === 'approval'`), the step the task is sitting on
 * decides which v1 status tag the card surfaces:
 *
 *   - `pr.open`     → `ready_to_commit` (operator approves the commit
 *                     before the PR is opened)
 *   - `pr.merge`    → `ready_to_merge`  (operator approves the merge
 *                     of an already-open PR)
 *   - `wait-action` → `ready_for_action` (generic wait-for-operator step)
 *   - anything else → `ready_for_action` (safe default — operator still
 *                     gets the Approve/Reject row, just under the
 *                     ready-for-action banner)
 *
 * Pure data table so `board.approval.test.ts` can pin every entry plus
 * the fallback against the v1 inventory without re-implementing the
 * mapping.
 */
const APPROVAL_STEP_ID_TO_TAG: Readonly<Record<string, TaskTag>> = {
    'pr.open': 'ready_to_commit',
    'pr.merge': 'ready_to_merge',
    'wait-action': 'ready_for_action',
};

/** Safe default for an approval-parked task whose stepId isn't in the table. */
const APPROVAL_DEFAULT_TAG: TaskTag = 'ready_for_action';

/**
 * Resolve the v1 status tag for a task parked at an approval gate
 * (AP-VP-015). Exported so the board-ui renderer and the unit-test
 * harness share the same mapping — keeps the per-fixture assertions in
 * `board.approval.test.ts` and the actual rendered tag on the card
 * mathematically identical.
 */
export function approvalStepTag(stepId: string | null | undefined): TaskTag {
    if (!stepId) return APPROVAL_DEFAULT_TAG;
    return APPROVAL_STEP_ID_TO_TAG[stepId] ?? APPROVAL_DEFAULT_TAG;
}

/** v1 human_status → canonical tag. `testing` flips to `ready_for_test` to match the v1 inventory. */
const HUMAN_STATUS_TO_TAG: Readonly<Record<string, TaskTag>> = {
    created: 'created',
    approved: 'approved',
    in_progress: 'in_progress',
    review: 'ready_for_review',
    ready_for_review: 'ready_for_review',
    testing: 'ready_for_test',
    ready_for_test: 'ready_for_test',
    ready_to_commit: 'ready_to_commit',
    ready_for_action: 'ready_for_action',
    ready_to_merge: 'ready_to_merge',
    // v2 flow statuses the v1 table never knew: committer running ≈
    // in-flight; merge = waiting on the PR → the merge action row.
    commit: 'in_progress',
    merge: 'ready_to_merge',
    done: 'done',
    skipped: 'skipped',
};

function advanceStepTag(current: TaskTag): TaskTag | undefined {
    const idx = STEP_TAG_ORDER.indexOf(current);
    if (idx < 0) return undefined;
    if (idx >= STEP_TAG_ORDER.length - 1) return current;
    return STEP_TAG_ORDER[idx + 1];
}

/**
 * v1-parity log-tail fallback. Walks the event log from the tail, mirror
 * of `deriveStatusFromIssue`'s "most recent stage wins" strategy: the
 * most recent AgentStarted gives the running step's tag; an
 * AgentFinished without a later start advances to the next step's tag.
 */
function deriveStepTagFromEvents(
    events: ReadonlyArray<DeriveTagsEvent>,
): TaskTag | undefined {
    for (let i = events.length - 1; i >= 0; i -= 1) {
        const ev = events[i];
        if (!ev) continue;
        const role = ev.payload?.agent ?? ev.payload?.role ?? '';
        if (!role) continue;
        if (ev.type === 'AgentStarted') {
            return tagForStep(role);
        }
        if (ev.type === 'AgentFinished') {
            const current = tagForStep(role);
            if (!current) continue;
            return advanceStepTag(current);
        }
    }
    return undefined;
}

/**
 * Derive the multi-tag set for a task. The returned array preserves
 * insertion order: terminal tags first (`done` / `skipped` / `failed:*`),
 * then the human_status mapping, then the step-derived tag, then the
 * parked overlay (`awaiting_clarification` or `ready_for_action`).
 *
 * When `current_step_id` is absent, the function falls back to
 * `task.meta.log` first (v1 projection shape) and then to the supplied
 * `events` array (v2 SSE projection shape). Either ordering reproduces
 * the v1 behaviour of "the tail of the log decides where the card sits."
 *
 * Multi-tag invariants exercised by the unit tests:
 *   - A parked-for-clarification mid-step task carries both `in_progress`
 *     and `awaiting_clarification`.
 *   - A commit rejected by the operator carries `ready_to_commit` again
 *     (NOT `failed:commit`) so the action row offers the commit-approval
 *     buttons.
 *   - A failed step yields `failed:<stage>` for any of dev/review/test/commit.
 */
export function deriveTaskTags(
    task: DeriveTagsTask,
    events: ReadonlyArray<DeriveTagsEvent> = [],
): TaskTag[] {
    const tags: TaskTag[] = [];
    const seen = new Set<TaskTag>();
    const push = (tag: TaskTag | undefined): void => {
        if (!tag || seen.has(tag)) return;
        seen.add(tag);
        tags.push(tag);
    };

    const failedStage = task.failed_stage ?? task.meta?.failed_stage ?? null;
    if (failedStage && FAILED_STAGES.has(failedStage)) {
        push(`failed:${failedStage as FailedStage}`);
    }

    const statusKey = task.human_status ?? task.status ?? '';
    // status 'failed' with no recorded stage (legacy rows, pre-029
    // events): still surface the failure action row rather than a
    // buttonless card — stage defaults to 'dev'.
    if (statusKey === 'failed' && tags.length === 0) {
        push('failed:dev');
    }
    push(HUMAN_STATUS_TO_TAG[statusKey]);

    let stepTag: TaskTag | undefined;
    if (task.current_step_id) {
        stepTag = tagForStep(task.current_step_id);
    } else if (task.meta?.log && task.meta.log.length > 0) {
        const logEvents: DeriveTagsEvent[] = task.meta.log.map((entry) => ({
            type: entry.event === 'complete' ? 'AgentFinished' : 'AgentStarted',
            payload: { agent: entry.agent },
        }));
        stepTag = deriveStepTagFromEvents(logEvents);
    } else if (events.length > 0) {
        stepTag = deriveStepTagFromEvents(events);
    }
    push(stepTag);

    // commit_rejected overlays on top of whatever the step layer picked.
    // The v1 board re-opened the commit row in this state, so the card
    // must carry `ready_to_commit` even when the step tag pointed at a
    // later stage. NOT a `failed:*` — a rejection is operator-driven and
    // does not run the failure-retry actions.
    if (task.commit_rejected) push('ready_to_commit');

    if (task.parkedReason === 'clarification') {
        push('awaiting_clarification');
    } else if (task.parkedReason === 'approval') {
        // AP-VP-015 — approval-gate parks surface their v1 status tag
        // off the parked stepId so the operator sees the matching v1
        // status banner alongside the Approve/Reject row that board.ts
        // renders inline on the card.
        push(approvalStepTag(task.current_step_id));
    } else if (task.parkedReason) {
        push('ready_for_action');
    }

    if (tags.length === 0) push('created');

    return tags;
}

// NOTE: the per-tag ACTION MATRIX (`ActionDef`, `TAG_ACTIONS`,
// `FAILED_ACTIONS`, `getActionsForTags`, `allMatrixActionIds`) was
// removed. It fed only `web/board-task-cards.ts`, a typed card renderer
// the shipped board never used — board.ts renders cards from the
// `#task-card-template` in index.html instead. The matrix advertised
// buttons (Open in VS Code, Already merged, …) that no operator-visible
// surface rendered, and its parity assertions passed against code that
// did not ship. `deriveTaskTags` / `approvalStepTag` survive: they are
// real inputs to the plan-card renderer and the approval tests.
