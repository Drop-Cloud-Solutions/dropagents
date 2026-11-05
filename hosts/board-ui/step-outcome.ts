/**
 * Step-chip state for a FAILED agent step.
 *
 * Field bug: a tester that reported `TESTS FAILED:` showed a GREEN chip
 * on the board until the operator clicked the chip — then it turned red
 * and stayed red. Two different sources disagreed:
 *
 *   - Live SSE: the runner exits 0 for a tester that ran fine and simply
 *     found failing tests, so it publishes `AgentFinished`, and the
 *     board folded that straight to `status: 'complete'`.
 *   - The durable row: the orchestrator parses the role's verdict
 *     sentinel (`core/flow/agent-outcome.ts`), flips
 *     `task_step_summaries.status` to 'failed' and republishes the run
 *     as the flow event `agent.failed`.
 *
 * The board had no fold for `agent.failed`, so the green chip stood
 * until the summary modal's catch-up fetch read the durable row and
 * overwrote it. Every role with a verdict vocabulary was affected —
 * reviewer (`CHANGES REQUIRED`), tester (`TESTS FAILED`), deployer
 * (`DEPLOY FAILED`), deploy-verifier (`STALE:` / `INCONCLUSIVE:`) — not
 * just the tester the operator happened to notice.
 *
 * These helpers live outside `board.ts` because that file is excluded
 * from tsconfig: only the esbuild bundle and these colocated tests
 * check it.
 */

export interface StepRecordLike {
    stepId: string;
    role: string | null;
    status: 'running' | 'complete' | 'failed';
    startedAt: number;
    finishedAt: number | null;
    summary: string | null;
}

/**
 * Map a flow step id onto the coarse `failed_stage` vocabulary the task
 * card reads. Historically inlined in the `AgentFailed` fold; shared now
 * so the semantic-failure path cannot drift from the crash path.
 */
export function failedStageForStep(stepId: string): string {
    if (stepId === 'develop') return 'dev';
    if (stepId === 'review' || stepId === 'test' || stepId === 'commit') {
        return stepId;
    }
    return 'dev';
}

/**
 * Which step does a failure belong to?
 *
 * The semantic bridge carries `stepId` explicitly. The crash bridge does
 * NOT (it only knows the agentId), so fall back to the step the board
 * currently believes is running. Ambiguity — zero or several running
 * steps — returns `null`: leaving a chip alone beats reddening the
 * wrong one.
 */
export function resolveFailedStepId(
    explicit: unknown,
    steps: Iterable<StepRecordLike>,
): string | null {
    if (typeof explicit === 'string' && explicit.length > 0) return explicit;
    const running = [...steps].filter((s) => s.status === 'running');
    return running.length === 1 ? running[0]!.stepId : null;
}

/**
 * Build the failed step record, preserving what the earlier
 * `AgentFinished` fold already captured.
 *
 * The summary matters: by the time `agent.failed` arrives the board has
 * usually stored the agent's full assistant text (that is what the chip
 * modal shows). Overwriting it with the short failure reason would
 * throw away the tester's actual output — the reason is only a fallback
 * for a step that never accumulated any.
 */
export function applyStepFailure(
    prev: StepRecordLike | undefined,
    args: {
        readonly stepId: string;
        readonly role?: string | null;
        readonly reason?: string | null;
        readonly now: number;
    },
): StepRecordLike {
    const reason = typeof args.reason === 'string' && args.reason.length > 0
        ? args.reason
        : null;
    return {
        stepId: args.stepId,
        role: (args.role && args.role.length > 0 ? args.role : null)
            ?? prev?.role
            ?? null,
        status: 'failed',
        startedAt: prev?.startedAt ?? args.now,
        finishedAt: args.now,
        summary: prev?.summary ?? reason,
    };
}
