/**
 * Slash-command parser for the Telegram chat surface (AP-VP6-006).
 *
 * The orchestrator's command bus exposes a handful of operator verbs —
 * `ResumeTask` (with `decision: 'approve' | 'reject'` and optional
 * `feedback` / `answer`), `SkipTask`, `RetryTask`, `CancelTask` — and the
 * board fires these directly from button clicks. The Telegram surface
 * mirrors those same verbs through six slash commands so an operator
 * can drive a task end-to-end from the chat client:
 *
 *   /approve              → ResumeTask{ decision: 'approve' }
 *   /reject [feedback]    → ResumeTask{ decision: 'reject', feedback? }
 *   /clarify <answer>     → ResumeTask{ decision: 'approve', answer }
 *   /skip                 → SkipTask
 *   /retry                → RetryTask
 *   /cancel               → CancelTask
 *
 * `parseCommand` is a pure function over the message text. It does NOT
 * dispatch — it returns the parsed intent so the adapter can stamp the
 * `actor` (chat-provider user id) and `taskId` (resolved from chat
 * context) before building the `Command<...>` envelope that goes on the
 * bus. Unknown commands return `{ kind: 'unrecognized', raw }` instead
 * of throwing so the adapter can render a polite "didn't recognise that"
 * reply without a try/catch wrapper at every call site.
 *
 * The /clarify mapping copies the convention from
 * `adapters/telegram/chat-clarify.ts`: a clarification answer resumes
 * the parked task through `on_success` (i.e. `decision: 'approve'`) with
 * the operator's text threaded onto `ResumeTaskPayload.answer`. The
 * engine routing for `decision: 'reject'` happens elsewhere — the router
 * only constructs the payload.
 */

/**
 * Parsed slash command — the discriminator is the bus command type name
 * (`ResumeTask` / `SkipTask` / `RetryTask` / `CancelTask`) so the adapter
 * can switch on it without re-mapping. Fields below the discriminator
 * mirror the matching `*Payload` shape from `core/commands/index.ts` minus
 * `taskId`, which the adapter resolves from chat context.
 */
export type InboundChatCommand =
    | { readonly kind: 'ResumeTask'; readonly decision: 'approve' }
    | {
          readonly kind: 'ResumeTask';
          readonly decision: 'reject';
          readonly feedback?: string;
      }
    | {
          readonly kind: 'ResumeTask';
          readonly decision: 'approve';
          readonly answer: string;
      }
    | { readonly kind: 'SkipTask' }
    | { readonly kind: 'RetryTask' }
    | { readonly kind: 'CancelTask' };

export interface UnrecognizedCommand {
    readonly kind: 'unrecognized';
    /** Original input verbatim — useful for the adapter's reply text. */
    readonly raw: string;
}

export type ParseCommandResult = InboundChatCommand | UnrecognizedCommand;

/**
 * Parse a Telegram message body into an inbound chat command.
 *
 * Leading and trailing whitespace on the message are tolerated. The verb
 * itself is matched case-insensitively (`/Approve` works the same as
 * `/approve`) so the operator's mobile autocorrect doesn't silently
 * break the dispatch. Arguments after the verb are split on the first
 * run of whitespace; the remainder is preserved verbatim (interior
 * whitespace and punctuation included). For `/reject`, an absent
 * argument leaves `feedback` unset rather than persisting an empty
 * string. For `/clarify`, an absent argument falls through to
 * `unrecognized` — a clarification with no answer is meaningless.
 */
export function parseCommand(text: string): ParseCommandResult {
    const raw = text;
    const trimmed = text.trim();
    if (trimmed.length === 0 || trimmed[0] !== '/') {
        return { kind: 'unrecognized', raw };
    }

    const spaceIdx = trimmed.search(/\s/);
    const verb = (spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)).toLowerCase();
    const rest = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim();

    switch (verb) {
        case '/approve':
            return { kind: 'ResumeTask', decision: 'approve' };
        case '/reject':
            return rest.length === 0
                ? { kind: 'ResumeTask', decision: 'reject' }
                : { kind: 'ResumeTask', decision: 'reject', feedback: rest };
        case '/clarify':
            if (rest.length === 0) return { kind: 'unrecognized', raw };
            return { kind: 'ResumeTask', decision: 'approve', answer: rest };
        case '/skip':
            return { kind: 'SkipTask' };
        case '/retry':
            return { kind: 'RetryTask' };
        case '/cancel':
            return { kind: 'CancelTask' };
        default:
            return { kind: 'unrecognized', raw };
    }
}
