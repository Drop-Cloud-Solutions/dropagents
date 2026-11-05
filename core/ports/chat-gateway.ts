/**
 * Port: bidirectional chat surface for the AP-VP6 flow engine.
 *
 * This is the v6-shaped chat port: a single `notify(event)` verb for
 * outbound, and a single `onInboundCommand(handler)` verb for inbound.
 * The verbose v1-shaped {@link import('./ChatGateway').ChatGateway} in
 * the sibling PascalCase file remains the legacy port; new code wires
 * against this one.
 *
 * The {@link ChatEvent} discriminated union mirrors the four v1 chat
 * events the parity harness pins
 * (`plan-ready`, `commit-ready`, `task-failed`, `worker-error` — see
 * `test/parity/chat/chat-events.spec.ts`). The shape would normally
 * live in `shared/chat-events.ts`; that module does not exist in this
 * repo, so the union is defined inline here as the local source of
 * truth — adapters and tests both depend on this file.
 *
 * Inbound is push-driven: the adapter calls the handler registered via
 * {@link ChatGateway.onInboundCommand} whenever it parses a chat
 * message into a recognised operator intent. The handler dispatches
 * onto the command bus; the orchestrator never polls the port.
 *
 * All values are pure types — no runtime code, no implementations.
 */

/**
 * Outbound chat event the orchestrator pushes through the gateway.
 *
 * Each variant carries the minimal payload the chat surface needs to
 * render an actionable operator message. `taskId` is present on every
 * variant so the gateway can correlate operator replies back onto the
 * task that produced the event.
 */
export type ChatEvent =
  | {
      readonly kind: 'plan-ready';
      readonly taskId: string;
      readonly flowId?: string;
      readonly reason?: string;
    }
  | {
      readonly kind: 'commit-ready';
      readonly taskId: string;
      readonly flowId?: string;
      readonly reason?: string;
    }
  | {
      readonly kind: 'task-failed';
      readonly taskId: string;
      readonly reason?: string;
    }
  | {
      readonly kind: 'worker-error';
      readonly taskId?: string;
      readonly error: string;
    };

/**
 * Inbound chat command — an operator intent parsed by the adapter from
 * a chat message (inline button press or natural-language reply) and
 * delivered to the registered handler.
 *
 * `actor` is the chat-provider-assigned operator id (Telegram user id,
 * Slack user id, ...). It is preserved verbatim so the host can apply
 * its allow-list checks and stamp the resulting command's `actor`
 * field for audit.
 */
export type InboundChatCommand =
  | {
      readonly kind: 'approve';
      readonly taskId: string;
      readonly actor: string;
    }
  | {
      readonly kind: 'skip';
      readonly taskId: string;
      readonly actor: string;
    }
  | {
      readonly kind: 'retry';
      readonly taskId: string;
      readonly actor: string;
    }
  | {
      readonly kind: 'cancel';
      readonly taskId: string;
      readonly actor: string;
    }
  | {
      readonly kind: 'restart';
      readonly taskId: string;
      readonly actor: string;
    }
  | {
      readonly kind: 'clarify-reply';
      readonly taskId: string;
      readonly answer: string;
      readonly actor: string;
    }
  | {
      readonly kind: 'message';
      readonly text: string;
      readonly actor: string;
    };

/**
 * Handler invoked by the gateway for each inbound operator command.
 * Implementations are expected to dispatch onto the command bus and
 * return synchronously — long-running work happens off the dispatch
 * path.
 */
export type InboundChatCommandHandler = (cmd: InboundChatCommand) => void;

export interface ChatGateway {
  /**
   * Deliver {@link event} to the configured chat surface. The adapter
   * decides routing (DM, group, channel) from its own configuration —
   * the port carries the semantic event, not a transport-level address.
   */
  notify(event: ChatEvent): Promise<void>;

  /**
   * Register a handler the adapter will invoke for every inbound
   * operator command. Calling this a second time replaces the previous
   * handler; passing `undefined` is not supported — to stop receiving
   * commands, dispose the gateway instead.
   */
  onInboundCommand(handler: InboundChatCommandHandler): void;
}
