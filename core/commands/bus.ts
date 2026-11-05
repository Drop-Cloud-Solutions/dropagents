import type { EventBus } from '../events/bus';
import type { Event, StoredEvent } from '../events/event';
import type { Command } from './command';

/**
 * Pure command handler. Given a command and a snapshot of application state,
 * the handler decides what events (if any) should be appended to the log.
 *
 * Handlers must not perform side effects of their own — the CommandBus is
 * responsible for publishing the returned events through the EventBus, which
 * in turn persists them and notifies subscribers. Returning `[]` is a valid
 * no-op: the command was accepted but produced no state change.
 */
export type CommandHandler<TCommand extends Command = Command, TState = unknown> = (
    command: TCommand,
    state: TState,
) => Promise<Event[]>;

/**
 * Routes typed commands to registered pure handlers and publishes the
 * resulting events through the EventBus.
 *
 * Exactly one handler may be registered per command `type` — duplicate
 * registration is a programmer error and throws. Likewise, sending a command
 * with no registered handler throws: the command bus has no concept of a
 * default route or a dead-letter queue.
 *
 * Handlers receive a state snapshot supplied by `stateProvider` at the moment
 * `send` is invoked. Events returned by the handler are published in order;
 * if any `publish` call rejects, the remaining events are NOT published and
 * the error propagates to the caller.
 */
export class CommandBus<TState = unknown> {
    private readonly handlers = new Map<string, CommandHandler<Command, TState>>();

    constructor(
        private readonly eventBus: EventBus,
        private readonly stateProvider: () => TState,
    ) {}

    /**
     * Install a handler for commands of `type`. Throws if a handler is
     * already registered for that type — overwriting silently would mask
     * wiring bugs.
     */
    register<TPayload = unknown>(
        type: string,
        handler: CommandHandler<Command<TPayload>, TState>,
    ): void {
        if (this.handlers.has(type)) {
            throw new Error(
                `CommandBus: a handler is already registered for command type "${type}"`,
            );
        }
        this.handlers.set(type, handler as CommandHandler<Command, TState>);
    }

    /**
     * Invoke the handler registered for `command.type`, publish each returned
     * event through the EventBus in order, and return the stored events.
     *
     * Throws synchronously-via-rejection if no handler is registered for the
     * command's type. This is a programmer error — at the time `send` is
     * called, all routes are expected to be wired up.
     */
    async send<TPayload = unknown>(command: Command<TPayload>): Promise<StoredEvent[]> {
        const handler = this.handlers.get(command.type);
        if (!handler) {
            throw new Error(
                `CommandBus: no handler registered for command type "${command.type}"`,
            );
        }
        const events = await handler(command as Command, this.stateProvider());
        const stored: StoredEvent[] = [];
        for (const event of events) {
            stored.push(await this.eventBus.publish(event));
        }
        return stored;
    }
}
