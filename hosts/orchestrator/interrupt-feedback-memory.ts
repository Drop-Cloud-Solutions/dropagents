/**
 * Record the interrupt-retry modal's feedback as `interrupt-retry` agent
 * memory.
 *
 * The `interrupt-retry` source has existed in the memory store's enum
 * since it was written and nothing ever produced one. The operator stops
 * an agent going the wrong way, types what it should have done instead,
 * and hits Retry — the single most pointed piece of feedback the pipeline
 * ever receives — and it reached that one task's next prompt and nowhere
 * else. The next plan for the same project was written as if it had never
 * happened.
 *
 * There is no single event carrying "the operator retried with feedback".
 * The modal is two steps and dispatches two commands:
 *
 *   1. `InterruptTask`  → `TaskInterrupted{taskId}`
 *   2. `EditTask{description}` → `TaskFieldsUpdated{taskId, description}`
 *
 * So this subscriber matches the PAIR: a `TaskFieldsUpdated` carrying a
 * description, for a task that was interrupted and has not run since. The
 * mark is consumed on use, so an ordinary description edit later is not
 * recorded, and it is cleared when the task starts again.
 *
 * Deliberately NOT inferred from `TaskFieldsUpdated` alone: `EditTask` is
 * the generic edit command (the edit-task modal uses it too), and filing
 * every title tweak as "prior operator feedback" would drown the real
 * corrections in the planner's prompt.
 *
 * A worker restart between the two steps loses the mark, and the entry is
 * simply not written. That is the right way round: a missing memory entry
 * costs a repeated mistake, a wrong one misleads every future plan.
 */
import type { Logger } from '../../core/ports/Logger';
import type { AgentMemorySource } from '../../core/projects/agent-memory';

/** Minimal bus surface — `EventBus.subscribe`, structurally. */
export interface FeedbackMemoryBus {
    subscribe<T>(
        type: string,
        handler: (event: { payload: T }) => void | Promise<void>,
        opts: { subscriber: string },
    ): void;
}

/** Write side: `AgentMemoryStore.append`, structurally. */
export interface FeedbackMemoryWriter {
    append(
        projectId: string,
        entry: {
            source: AgentMemorySource;
            taskIdentifier: string;
            taskTitle: string;
            feedback: string;
            recordedAt?: number;
        },
    ): void;
}

/** Resolve a task to the project and title the memory entry needs. */
export interface FeedbackTaskLookup {
    lookup(taskId: string): { projectId: string; title: string } | undefined;
}

export interface InterruptFeedbackMemoryDeps {
    readonly bus: FeedbackMemoryBus;
    readonly memory: FeedbackMemoryWriter;
    readonly tasks: FeedbackTaskLookup;
    readonly logger: Logger;
    readonly clock: () => number;
}

export const INTERRUPT_FEEDBACK_MEMORY_SUBSCRIBER = 'interrupt-feedback-memory';

/**
 * Attach the subscriber. Exported separately from the orchestrator's
 * composition root so a test can drive it with three fakes and no SQLite.
 */
export function attachInterruptFeedbackMemory(
    deps: InterruptFeedbackMemoryDeps,
): void {
    // Tasks interrupted and not yet restarted. Bounded by the number of
    // tasks an operator can interrupt without retrying — single digits.
    const interrupted = new Set<string>();

    const taskIdOf = (payload: { taskId?: unknown }): string | null =>
        typeof payload.taskId === 'string' && payload.taskId.length > 0
            ? payload.taskId
            : null;

    deps.bus.subscribe<{ taskId?: string }>(
        'TaskInterrupted',
        (event) => {
            const taskId = taskIdOf(event.payload);
            if (taskId !== null) interrupted.add(taskId);
        },
        { subscriber: INTERRUPT_FEEDBACK_MEMORY_SUBSCRIBER },
    );

    // A restarted task drops its mark: whatever the operator edits after
    // it is running again is an ordinary edit, not retry feedback.
    for (const started of ['AgentStarted', 'TaskResumed'] as const) {
        deps.bus.subscribe<{ taskId?: string }>(
            started,
            (event) => {
                const taskId = taskIdOf(event.payload);
                if (taskId !== null) interrupted.delete(taskId);
            },
            { subscriber: INTERRUPT_FEEDBACK_MEMORY_SUBSCRIBER },
        );
    }

    deps.bus.subscribe<{ taskId?: string; description?: string }>(
        'TaskFieldsUpdated',
        (event) => {
            const taskId = taskIdOf(event.payload);
            if (taskId === null) return;
            if (!interrupted.has(taskId)) return;
            const feedback = typeof event.payload.description === 'string'
                ? event.payload.description.trim()
                : '';
            // A title-only edit on an interrupted task is not feedback.
            // Leave the mark in place — the operator may still be on the
            // modal's second step.
            if (feedback.length === 0) return;
            interrupted.delete(taskId);
            const task = deps.tasks.lookup(taskId);
            if (!task) {
                deps.logger.warn(
                    'interrupt-feedback-memory: no project for interrupted task; entry skipped',
                    { taskId },
                );
                return;
            }
            try {
                deps.memory.append(task.projectId, {
                    source: 'interrupt-retry',
                    taskIdentifier: taskId,
                    taskTitle: task.title,
                    feedback,
                    recordedAt: deps.clock(),
                });
            } catch (err) {
                deps.logger.warn('interrupt-feedback-memory: append failed', {
                    taskId,
                    projectId: task.projectId,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        },
        { subscriber: INTERRUPT_FEEDBACK_MEMORY_SUBSCRIBER },
    );
}
