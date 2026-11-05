/**
 * When the operator may edit a task's instructions.
 *
 * The gate used to be `taskHasStarted()` — any recorded step run, or a
 * terminal status, made the field read-only. Its stated reason was that
 * "once the developer has the brief, later edits would silently not
 * apply until a retry".
 *
 * That conflates STARTED with RUNNING, and the difference is the whole
 * point. Reported: the operator stopped a developer mid-run because the
 * work was going the wrong way, and then had no way to tell it what to do
 * differently — the task was parked awaiting their decision, with the
 * instructions box locked and a note advising them to add instructions
 * before the task runs.
 *
 * A halted task is precisely the case where an edit DOES apply:
 * `readTaskAgentContext` reads `tasks.instructions` fresh on every spawn
 * and renders it as `# Operator instructions`, so Retry re-runs the agent
 * with whatever the operator just saved. The old rule locked the field at
 * the one moment it was most useful.
 *
 * So: editable unless an agent is actively working the task, or the task
 * is terminal and nothing further will read them.
 */

export interface InstructionsEditabilityInput {
    readonly status?: string | null;
    readonly parkedReason?: string | null;
    /** True when the task has at least one recorded step run. */
    readonly hasStepRuns?: boolean;
}

/** Statuses that mean an agent is mid-step — unless the task is parked. */
const WORKING_STATUSES: ReadonlySet<string> = new Set([
    'in_progress',
    'review',
    'test',
    'commit',
    'merge',
]);

/** Nothing will run again, so nothing will read a new instruction. */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
    'done',
    'skipped',
    'archived',
]);

export function canEditTaskInstructions(
    task: InstructionsEditabilityInput,
): boolean {
    const status = task.status || 'created';
    if (TERMINAL_STATUSES.has(status)) return false;
    // Parked is the halted case: the agent is stopped and the task is
    // waiting on the operator (a stop, a clarification, a gate) or on a
    // dependency. Whatever resumes it re-reads the instructions.
    if (task.parkedReason) return true;
    // Failed: Retry re-spawns from the top with a fresh prompt.
    if (status === 'failed') return true;
    // Never started — the original editable case.
    if (!task.hasStepRuns) return true;
    // An agent holds the brief right now. Editing here really would be
    // the silent no-op the old rule was guarding against.
    return !WORKING_STATUSES.has(status);
}

/**
 * True when the task ran before, so the copy can say the edit applies to
 * the NEXT run rather than implying it has not started.
 */
export function instructionsApplyToRerun(
    task: InstructionsEditabilityInput,
): boolean {
    return Boolean(task.hasStepRuns) || (task.status || '') === 'failed';
}
