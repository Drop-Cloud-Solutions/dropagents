/**
 * What "Stop agent" should do, given what the board knows about the run.
 *
 * Field report: "task D-AHCW-001 still shows the tester agent running,
 * but when I click on Stop agent it says agent already finished".
 *
 * Both halves of the board were right about different things. The card
 * showed the tester running because the step record said so — and it
 * genuinely was, 18 minutes in. Stop said it had finished because the
 * run record's `agentId` was EMPTY, and the old condition lumped that
 * together with a finished run:
 *
 *     if (run.status !== 'running' || run.agentId.length === 0)
 *         -> "Agent already finished."
 *
 * An empty agentId does not mean finished. It means the board never
 * learned which run this is, which is the normal state after a RELOAD:
 * the live activity stream is not persisted, so boot hydration
 * reconstructs the running step from `task_step_summaries` and used to
 * fill in `agentId: ''`. `CancelAgentRun` is addressed by run id, so
 * Stop had nothing to send — and could never get it, because the
 * `AgentStarted` frame that carried the id is not sent again.
 *
 * The id now rides along on the step-summaries hydration (read from the
 * orchestrator's live agent-to-task map), so the common case is fixed at
 * the source. This function is what keeps the two cases apart for the
 * residue, and exists separately so the distinction is tested rather
 * than re-litigated inside a 13,000-line render file.
 */

/** What the board holds for a task's current agent run. */
export interface StopAgentRunView {
    readonly status: 'running' | 'complete' | 'failed' | string;
    readonly agentId: string;
}

export type StopAgentDecision =
    /** Send `CancelAgentRun` with this run id. */
    | { readonly kind: 'cancel'; readonly agentId: string }
    /** Nothing is running; tell the operator so. */
    | { readonly kind: 'finished'; readonly message: string }
    /** Running, but this session cannot address it. */
    | { readonly kind: 'unknown-run'; readonly message: string }
    /** No run record at all for the task. */
    | { readonly kind: 'no-run'; readonly message: string };

export function decideStopAgent(
    run: StopAgentRunView | undefined | null,
): StopAgentDecision {
    if (!run) {
        return {
            kind: 'no-run',
            message: 'No active agent to stop for this task.',
        };
    }
    if (run.status !== 'running') {
        return { kind: 'finished', message: 'Agent already finished.' };
    }
    if (run.agentId.length === 0) {
        // Never "already finished": it is running, and saying otherwise
        // sent an operator looking for a bug in the agent instead of in
        // the board. Name the real limitation and the way out.
        return {
            kind: 'unknown-run',
            message:
                'Still running, but this board session does not know the run'
                + ' id — reload the board and try again.',
        };
    }
    return { kind: 'cancel', agentId: run.agentId };
}
