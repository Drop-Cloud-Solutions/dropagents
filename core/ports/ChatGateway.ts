/**
 * Port: bidirectional chat surface (Telegram, Slack, Discord, ...).
 *
 * # Outbound — `notify`
 *
 * The original v1 surface. Hosts call `notify(channel, message)` to push a
 * plain-text message to a chat backend; the adapter decides what `channel`
 * means (Telegram chat id, Slack channel id, ...). The event-bus → chat
 * bridge is layered on top of this verb inside the adapter and is not part
 * of the port contract.
 *
 * # Inbound — `InboundMessage` + `ClarificationReplyCorrelator`
 *
 * Inbound chat traffic in v2 is conversational, not request/response. When
 * an operator types a free-text message the adapter delivers an
 * {@link InboundMessage} to the pipeline: the message itself, the chat id
 * it arrived on, the sender's id (so the host can apply its allow-list),
 * and — critically — the id of the message the operator was replying to,
 * if any. The latter is the spine of clarification reply correlation: when
 * a task parks on a clarification question the host persists
 * `(taskId, questionMessageId)` through {@link ClarificationReplyCorrelator},
 * and a later inbound message carrying that `replyToMessageId` resolves
 * unambiguously back to the parked task.
 *
 * The port models the data shapes only — it does not prescribe a transport
 * (long-poll, webhook, websocket) and it does not own the dispatch path.
 * Adapters are expected to feed inbound traffic into their own router,
 * which translates a parsed intent into a command on the pipeline's
 * `CommandBus`. The shared types live here so that router (and any tests
 * over it) can be written against an interface rather than a concrete
 * transport.
 */

/**
 * One inbound message as observed by the chat adapter. Field names are
 * adapter-agnostic — Telegram's `message_id` maps to `messageId`, Slack's
 * `ts` would map to the same field if a Slack adapter were added later.
 *
 * `replyToMessageId` is populated when the operator's client signalled
 * that this message is a reply to a previous bot message (Telegram's
 * `reply_to_message.message_id`, Slack's `thread_ts`). Absent for
 * top-level messages.
 */
export interface InboundMessage {
  /** Provider-assigned message id, unique per chat. */
  readonly messageId: number;
  /** The chat (DM, group, channel) the message arrived on. */
  readonly chatId: number | string;
  /** Sender's provider-assigned user id. Used for allow-list checks. */
  readonly senderId: number;
  /** Free-form text body. Empty string when the message carried no text. */
  readonly text: string;
  /**
   * When the operator's client marked the message as a reply, the
   * `message_id` of the message being replied to. The clarification
   * correlator keys on this field.
   */
  readonly replyToMessageId?: number;
}

/**
 * Persistence surface for clarification reply correlation. Each parked
 * task that asked a question records the `(taskId, chatId, messageId)`
 * tuple here when the question is delivered. On a later inbound message
 * the adapter calls `lookupByQuestionMessageId` to resolve the reply
 * back to its parked task.
 *
 * `chatId` is recorded alongside `messageId` because Telegram's
 * `message_id` is only unique within a chat — a reply from a different
 * chat to the same numeric id is a different physical message. The
 * lookup matches on both.
 */
export interface ClarificationReplyCorrelator {
  /**
   * Persist a `(taskId, chatId, messageId)` triple. A second call for the
   * same `taskId` overwrites the prior pointer — only the most recent
   * outstanding question correlates back to the task. Idempotent.
   */
  recordQuestion(taskId: string, chatId: number | string, messageId: number): void;

  /**
   * Resolve a reply-to pointer to its parked taskId. Returns undefined
   * when no record matches — the adapter then routes the message through
   * the normal NL intent classifier rather than the clarification path.
   */
  lookupByQuestionMessageId(
    chatId: number | string,
    messageId: number,
  ): string | undefined;

  /**
   * Drop the correlation record for `taskId`. Called after a successful
   * `ResumeTask` dispatch so a stale pointer can't double-resume the task
   * if the operator replies again to the same question message.
   */
  clearForTask(taskId: string): void;
}

/**
 * Outbound chat gateway. Adapters that also model inbound traffic do so
 * through {@link InboundMessage} and {@link ClarificationReplyCorrelator};
 * those are not added as members of this interface because the inbound
 * path is push-driven by the adapter's own transport, not pulled by the
 * orchestrator.
 */
export interface ChatGateway {
  /**
   * Deliver `message` to `channel`. The semantics of `channel` are
   * adapter-specific (Telegram chat id, Slack channel id, ...).
   */
  notify(channel: string, message: string): Promise<void>;
}
