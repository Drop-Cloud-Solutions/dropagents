/**
 * Command shape for the command bus.
 *
 * A command is a typed intent ("create something", "approve X") issued by a
 * caller and routed to a single pure handler. Commands are NOT persisted —
 * only the events a handler emits in response are appended to the event log.
 *
 * `actor` identifies who issued the command (operator id, system component
 * name, etc.) and is intended for audit trails: handlers typically copy it
 * onto the events they emit. `issuedAt` is a unix-epoch millisecond
 * timestamp, matching the convention used by `Event.occurredAt`.
 */
export interface Command<TPayload = unknown> {
    type: string;
    actor: string;
    issuedAt: number;
    payload: TPayload;
}
