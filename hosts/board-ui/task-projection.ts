/**
 * Pure TaskCreated reducer (AP-VP4-014).
 *
 * Lifted out of `board.ts` for the same reason `task-tags.ts` was:
 * `board.ts` has top-level browser side effects (overlay-manager
 * construction, EventSource setup, document queries) that crash a
 * `node:test` import. This module is pure — same input → same output,
 * no DOM reads, no global state — so `board.test.ts` can import it
 * directly to exercise the projection without standing up a browser.
 *
 * # Why this matters for AP-VP4-014
 *
 * Task-008's `task-projection-store` folds one `PlanDecomposed` event
 * into N `TaskCreated` events (one per decomposer task). Those events
 * arrive at the board over SSE in tight succession — same JS tick, no
 * yield between them. The board's render contract is "one card per
 * entry in the in-memory `tasks` Map", so the reducer below MUST
 * unconditionally `set` the new row each time it fires. Any conditional
 * dedup, debounce, or batch-buffer at this layer would lose cards from
 * a freshly-decomposed plan.
 *
 * # Idempotency
 *
 * `Map.set` is idempotent by definition: re-applying the same
 * `TaskCreated` payload writes the same entry. That matches the
 * orchestrator's durable dedup (events table UNIQUE constraint on
 * `idempotency_key`) — a replayed `PlanDecomposed` re-emits the same
 * per-task keys, the bus drops the duplicates, and even if a duplicate
 * slipped through, this reducer would simply overwrite the row with
 * identical data.
 *
 * # What the renderer reads
 *
 * `renderTasks` in `board.ts` iterates `tasks.values()` once per render
 * tick and emits one DOM card per entry. The fields populated below
 * are the ones the card template (`#task-card-template` in
 * `index.html`) renders directly: `taskId`, `type`, `planId`, and —
 * via AP-VP4-014 — `title`. The remaining fields (status, parked
 * state, investigation thread, etc.) are mutated by later events
 * (TaskApproved / TaskParked / etc.) and start at sensible defaults.
 */

/**
 * Structural shape of the board's in-memory task row. Mirrors the
 * `TaskRow` interface in `board.ts` exactly — the entry imports this
 * type so the two stay in sync without a duplicate declaration drifting.
 */
export interface TaskProjectionRow {
    taskId: string;
    planId: string;
    projectId: string | null;
    planFile: string | null;
    type: string;
    flowId: string;
    status: string;
    title: string | null;
    description: string | null;
    /** Structured ticket fields (goal / acceptance criteria / file
     *  impact). Hydrated from /api/tasks + the projected TaskCreated
     *  payload; null for pre-027 tasks (plain-description fallback). */
    ticketDetails: {
        goal?: string;
        acceptanceCriteria?: string[];
        filesToCreate?: string[];
        filesToModify?: string[];
        filesToDelete?: string[];
        /** Scoped verification commands from the decomposer. */
        testCommands?: string[];
    } | null;
    /**
     * True when `/api/tasks` WITHHELD `description` + `ticketDetails`
     * rather than the task genuinely having none. Closed tasks are
     * hydrated without them — measured at 2.3 MB of a 3.0 MB payload,
     * for prose no card renders. The task modal fetches the row from
     * `/api/tasks/:id/detail` when it opens.
     *
     * The flag is the contract: without it, a blank modal and a task
     * with no description are indistinguishable, and the operator gets
     * silently shown an empty brief.
     */
    detailOmitted: boolean;
    /** Operator instructions / remarks (migration 022). Hydrated from
     *  /api/tasks; kept live by the TaskInstructionsSet SSE reducer. */
    instructions: string | null;
    /** Operator rejection reason (`tasks.feedback`). Set when the
     *  operator rejected the task with a reason; the same text reaches
     *  the agent as `# Feedback to address` on a Retry. */
    feedback: string | null;
    parkedReason: string | null;
    /** Stage the task failed at (dev/review/test/commit) — drives the
     *  card matrix's failed:<stage> tag + Retry/Restart action row. */
    failed_stage: string | null;
    parkedQuestion: string | null;
    parkedStepId: string | null;
    investigation_thread: Array<{
        role: string;
        content: string;
        timestamp: number;
    }>;
    followup_inflight: boolean;
    /** PR URL once the post-commit hook successfully opened a PR. */
    prUrl: string | null;
    /** Corresponding PR number — used by the Merge PR command. */
    prNumber: number | null;
    /**
     * Set when the post-commit hook hit a TECHNICAL failure (push
     * rejected, `gh pr create` errored) — the commit is local-only, not on
     * GitHub. Live-only (TaskCommitFailed SSE); cleared on TaskPrOpened /
     * TaskResumed / TaskRetried. Drives the "push/PR failed - retry"
     * treatment so the card doesn't look like a clean "Awaiting merge".
     */
    commitError: string | null;
    /**
     * Every task this task declared a dependency on. Carried on the
     * /api/tasks hydration payload so a reload reflects the DAG; live
     * TaskCreated SSE events from the projection store carry the same
     * list, so the chip renders correctly during a fresh decompose too.
     */
    dependsOn: string[];
    /**
     * Subset of {@link dependsOn} whose upstream is not yet merged. The
     * `Blocked by …` chip renders iff this list is non-empty.
     */
    blockedBy: string[];
    /**
     * True when the operator pre-approved this task while it was
     * waiting on dependencies — the engine auto-starts it once the
     * upstreams merge. Drives the "approved ✓" hint on the
     * waiting-deps chip and hides the Approve button.
     */
    preApproved: boolean;
    /**
     * When the task was created, shown on the task modal's meta row.
     *
     * `tasks.created_at` (migration 036) via /api/tasks on hydration;
     * for a task created live in this session the SSE `TaskCreated`
     * payload has no such field, so the caller stamps the event
     * envelope's `occurredAt` instead. Null when neither is available —
     * the modal omits the date rather than showing a wrong one.
     */
    createdAt: number | null;
}

/**
 * Pure reducer: apply a single `TaskCreated` payload to a tasks map.
 *
 * Returns the row that was written so callers can chain (e.g. update a
 * derived index keyed on the same taskId). Returns `null` only when
 * the payload is missing a string `taskId` — the orchestrator never
 * emits such an event, but the board's SSE handler must tolerate any
 * malformed line from a stale producer without throwing.
 *
 * Each call unconditionally writes a new row. The renderer's "one card
 * per Map entry" contract turns N applications into N cards in the
 * very next render tick.
 */
export function applyTaskCreated(
    map: Map<string, TaskProjectionRow>,
    payload: Record<string, unknown>,
): TaskProjectionRow | null {
    if (typeof payload.taskId !== 'string') return null;
    const row: TaskProjectionRow = {
        taskId: payload.taskId,
        planId: typeof payload.planId === 'string' ? payload.planId : '',
        projectId:
            typeof payload.projectId === 'string' ? payload.projectId : null,
        planFile:
            typeof payload.planFile === 'string' ? payload.planFile : null,
        type: typeof payload.type === 'string' ? payload.type : '',
        flowId: typeof payload.flowId === 'string' ? payload.flowId : '',
        // Default to 'created' for a fresh TaskCreated SSE payload (the
        // event never carries a status field) but respect an explicit
        // status when present — the /api/tasks hydration response
        // carries the durable row's status so a reload reflects whether
        // the task is approved / skipped / in-progress / failed.
        status:
            typeof payload.status === 'string' && payload.status.length > 0
                ? payload.status
                : 'created',
        title: typeof payload.title === 'string' ? payload.title : null,
        description:
            typeof payload.description === 'string'
                ? payload.description
                : null,
        ticketDetails:
            payload.ticketDetails && typeof payload.ticketDetails === 'object'
                ? (payload.ticketDetails as TaskProjectionRow['ticketDetails'])
                : null,
        // Present on the hydration row; absent on a live TaskCreated
        // event, which the SSE caller patches from the envelope.
        createdAt:
            typeof payload.createdAt === 'number' && payload.createdAt > 0
                ? payload.createdAt
                : null,
        detailOmitted: payload.detailOmitted === true,
        feedback:
            typeof payload.feedback === 'string' && payload.feedback.length > 0
                ? payload.feedback
                : null,
        instructions:
            typeof payload.instructions === 'string'
                ? payload.instructions
                : null,
        // `parkedReason` rides on the /api/tasks hydration payload so a
        // reload picks up an approval-parked task with the right gate
        // rendering (renderApprovalControls → Approve/Reject). Live
        // TaskCreated events never carry it; they go through the dedicated
        // TaskParked reducer instead.
        parkedReason:
            typeof payload.parkedReason === 'string' && payload.parkedReason.length > 0
                ? payload.parkedReason
                : null,
        failed_stage:
            typeof payload.failedStage === 'string' && payload.failedStage.length > 0
                ? payload.failedStage
                : null,
        // Clarification question survives a reload via the hydration
        // payload (migration 031) — without it the Answer button opened
        // an empty modal after a refresh.
        parkedQuestion:
            typeof payload.parkedQuestion === 'string' && payload.parkedQuestion.length > 0
                ? payload.parkedQuestion
                : null,
        parkedStepId: null,
        investigation_thread: Array.isArray(payload.investigation_thread)
            ? (
                  payload.investigation_thread as TaskProjectionRow['investigation_thread']
              ).slice()
            : [],
        followup_inflight: Boolean(payload.followup_inflight),
        prUrl: typeof payload.prUrl === 'string' && payload.prUrl.length > 0
            ? payload.prUrl
            : null,
        prNumber: typeof payload.prNumber === 'number' && Number.isFinite(payload.prNumber)
            ? payload.prNumber
            : null,
        commitError: null,
        // `dependencies` is the wire name on the projected TaskCreated
        // event (ProjectedTaskCreatedPayload); `dependsOn` is the wire
        // name on the /api/tasks hydration response. Accept both so the
        // reducer doesn't lose the DAG depending on which entry point
        // the row came from.
        dependsOn: Array.isArray(payload.dependsOn)
            ? (payload.dependsOn as unknown[]).filter(
                  (v): v is string => typeof v === 'string',
              )
            : Array.isArray(payload.dependencies)
              ? (payload.dependencies as unknown[]).filter(
                    (v): v is string => typeof v === 'string',
                )
              : [],
        // Live TaskCreated events never carry `blockedBy` — the field
        // is computed server-side at /api/tasks read time. Fresh
        // decomposes inherit `blockedBy = dependsOn` (everything is
        // pending the moment the task lands) so the chip renders
        // immediately; later TaskDepsResolved events (if/when added)
        // would prune the list.
        blockedBy: Array.isArray(payload.blockedBy)
            ? (payload.blockedBy as unknown[]).filter(
                  (v): v is string => typeof v === 'string',
              )
            : Array.isArray(payload.dependencies)
              ? (payload.dependencies as unknown[]).filter(
                    (v): v is string => typeof v === 'string',
                )
              : Array.isArray(payload.dependsOn)
                ? (payload.dependsOn as unknown[]).filter(
                      (v): v is string => typeof v === 'string',
                  )
                : [],
        preApproved: payload.preApproved === true,
    };
    map.set(payload.taskId, row);
    return row;
}
