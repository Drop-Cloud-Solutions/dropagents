/**
 * `InterruptTask` command handler (AP-IFE-005).
 *
 * The board-ui's pure-event handlers (see `hosts/board-ui/commands.ts`)
 * emit domain events and stop there. Interrupting a running task is one of
 * the operator-driven mutations that ALSO needs an external side effect:
 * we have to signal the live agent process the orchestrator dispatched
 * for the task. That side effect is owned by the `AgentRunner` port —
 * `ClaudeCliRunner.interrupt` already writes the `.killed` sidecar AND
 * issues the platform-aware kill, so the handler stays a thin lookup +
 * delegate + event emitter.
 *
 * Resolution model: the orchestrator already maintains an `agentToTask`
 * map (agentId → taskId) for its bridge subscribers. Rather than mirror
 * that into a parallel taskId → agentId cache (and the invalidation bugs
 * that come with it), we invert the map on each call via the accessor the
 * orchestrator exposes. Active-agent cardinality is small (<50) so the
 * scan is cheap, and it sidesteps cache drift after AgentFinished /
 * AgentFailed.
 *
 * Order of operations matches `CancelAgentRun`: we call
 * `agentRunner.interrupt(handle)` BEFORE publishing `TaskInterrupted`, so
 * any subscriber that observes the event is guaranteed the underlying
 * process has already been signalled (and the sidecar already on disk).
 *
 * Not-found contract: when no live agent is mapped to the supplied
 * taskId we return an empty event list rather than throwing. The command
 * itself is structurally valid — the operator just asked to interrupt
 * something that is no longer running (race against natural completion,
 * stale board view, ...). Throwing in that path would turn a benign race
 * into an HTTP 5xx for the board.
 */
import type { CommandBus, CommandHandler } from '../../../core/commands/bus';
import type { Command } from '../../../core/commands/command';
import type { Event } from '../../../core/events/event';
import type { AgentHandle, AgentRunner } from '../../../core/ports/AgentRunner';
import type { Logger } from '../../../core/ports/Logger';

import {
    BoardUiCommands,
    BoardUiEvents,
    isInterruptTaskPayload,
    type InterruptTaskPayload,
    type TaskInterruptedPayload,
} from '../../board-ui/commands';

/**
 * Outcome of an InterruptTask attempt. `'interrupted'` means a live agent
 * was found and signalled (caller will observe a `TaskInterrupted` event);
 * `'not-found'` means no agent was mapped to the task at lookup time and
 * the handler emitted no event. Exported so callers that need to assert
 * on the result (integration tests, future router code) have a typed
 * vocabulary to match against instead of reading event-list lengths.
 */
export type InterruptTaskOutcome =
    | { readonly kind: 'interrupted'; readonly taskId: string; readonly agentId: string }
    | { readonly kind: 'not-found'; readonly taskId: string };

export interface InterruptTaskDeps {
    readonly clock: () => number;
    /**
     * Interrupt-only slice of `AgentRunner`. Narrowed so tests can inject
     * a fake that records the handle without having to implement `start`,
     * and so callers cannot accidentally spawn agents through this dep.
     */
    readonly agentRunner: Pick<AgentRunner, 'interrupt'>;
    /**
     * Inverse lookup over the orchestrator's `agentToTask` map. Returns
     * the live `AgentHandle` currently driving `taskId`, or `undefined`
     * when no agent is mapped — production wiring inverts the map by
     * calling the orchestrator's accessor on each invocation (small
     * cardinality, no cache to invalidate); tests inject a literal map.
     */
    readonly getAgentForTask: (taskId: string) => AgentHandle | undefined;
    readonly logger: Logger;
}

export function createInterruptTaskHandler(
    deps: InterruptTaskDeps,
): CommandHandler<Command<InterruptTaskPayload>> {
    return async (cmd): Promise<Event[]> => {
        if (!isInterruptTaskPayload(cmd.payload)) {
            deps.logger.warn(
                `worker-api: ${BoardUiCommands.INTERRUPT_TASK} rejected (invalid payload)`,
                { type: BoardUiCommands.INTERRUPT_TASK, actor: cmd.actor },
            );
            throw new Error('InterruptTask: invalid payload');
        }
        const { taskId, reason } = cmd.payload;

        const handle = deps.getAgentForTask(taskId);
        if (handle === undefined) {
            deps.logger.warn(
                `worker-api: ${BoardUiCommands.INTERRUPT_TASK} no live agent for task`,
                {
                    type: BoardUiCommands.INTERRUPT_TASK,
                    actor: cmd.actor,
                    taskId,
                },
            );
            return [];
        }

        const key = `${BoardUiCommands.INTERRUPT_TASK}:${taskId}:${cmd.issuedAt}`;
        deps.logger.info(`worker-api: ${BoardUiCommands.INTERRUPT_TASK} accepted`, {
            type: BoardUiCommands.INTERRUPT_TASK,
            actor: cmd.actor,
            idempotencyKey: key,
            taskId,
            agentId: handle.id,
        });

        try {
            await deps.agentRunner.interrupt(handle);
        } catch (err) {
            deps.logger.error(
                `worker-api: ${BoardUiCommands.INTERRUPT_TASK} runner.interrupt failed`,
                {
                    type: BoardUiCommands.INTERRUPT_TASK,
                    actor: cmd.actor,
                    taskId,
                    agentId: handle.id,
                    error: err instanceof Error ? err.message : String(err),
                },
            );
            throw err;
        }

        const payload: TaskInterruptedPayload =
            reason !== undefined
                ? { taskId, actor: cmd.actor, reason }
                : { taskId, actor: cmd.actor };

        const event: Event = {
            type: BoardUiEvents.TASK_INTERRUPTED,
            v: 1,
            occurredAt: deps.clock(),
            idempotencyKey: key,
            payload,
        };
        return [event];
    };
}

/**
 * Register the `InterruptTask` handler on the supplied command bus.
 * Idempotent at the call-site only: re-registering against the same bus
 * type is a programmer error (the bus throws), which is the desired
 * behaviour — the worker-api host calls this exactly once during boot.
 */
export function registerInterruptTaskHandler(
    bus: CommandBus<unknown>,
    deps: InterruptTaskDeps,
): void {
    bus.register<InterruptTaskPayload>(
        BoardUiCommands.INTERRUPT_TASK,
        createInterruptTaskHandler(deps),
    );
}
