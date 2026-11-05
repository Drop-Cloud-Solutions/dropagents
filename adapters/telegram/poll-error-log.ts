/**
 * Rate-limit for the Telegram poll loop's failure log.
 *
 * Field incident: a second bot instance was polling the same token, so
 * every `getUpdates` lost the long-poll race and logged
 * `Conflict: terminated by other getUpdates request`. At one failure per
 * poll cycle that filled the entire 500-line warning window with one
 * repeated message — and buried the line that actually mattered, an
 * expired Claude CLI credential that was breaking every agent spawn. The
 * operator went looking for a missing feature instead of an expired
 * token.
 *
 * A recurring fault must stay visible without being able to evict
 * everything else from the log. So: log the first occurrence in full,
 * suppress the identical repeats, and log again on an interval with the
 * count of what was suppressed. A DIFFERENT error always logs
 * immediately — the whole point is that a new fault is not hidden behind
 * an old one.
 */

/** What one call to {@link PollErrorLog.record} decided. */
export type PollLogDecision =
    | { readonly kind: 'log'; readonly message: string; readonly hint?: string }
    | { readonly kind: 'suppress' };

export interface PollErrorLogOptions {
    /** How long identical repeats stay suppressed. Default 5 minutes. */
    readonly repeatAfterMs?: number;
    readonly now?: () => number;
}

const DEFAULT_REPEAT_AFTER_MS = 5 * 60 * 1000;

/**
 * Operator-facing hints for poll failures whose cause is not obvious from
 * the raw API error. `Conflict: terminated by other getUpdates request`
 * says nothing about what to DO; the fix is always "find the other
 * instance", and the error will otherwise repeat forever because nothing
 * in this process can resolve it.
 */
const HINTS: ReadonlyArray<{ re: RegExp; hint: string }> = [
    {
        re: /terminated by other getUpdates|Conflict/i,
        hint: 'Another bot instance is polling the same token — Telegram allows'
            + ' only one. Messages are being split between the instances at'
            + ' random. Stop the duplicate worker.',
    },
    {
        re: /\b401\b|unauthorized|bot token/i,
        hint: 'The bot token was rejected. Check TELEGRAM_BOT_TOKEN_V2 on this worker.',
    },
];

/** The hint for `message`, or undefined when it needs none. */
export function pollErrorHint(message: string): string | undefined {
    for (const { re, hint } of HINTS) {
        if (re.test(message)) return hint;
    }
    return undefined;
}

export class PollErrorLog {
    private readonly repeatAfterMs: number;
    private readonly now: () => number;
    /** The error currently being suppressed, if any. */
    private last: { message: string; firstAt: number; lastLoggedAt: number; suppressed: number }
        | null = null;

    constructor(opts: PollErrorLogOptions = {}) {
        this.repeatAfterMs = opts.repeatAfterMs ?? DEFAULT_REPEAT_AFTER_MS;
        this.now = opts.now ?? ((): number => Date.now());
    }

    /**
     * Decide whether this failure should be logged.
     *
     * The returned `message` is what to log: the raw error for a first
     * occurrence, or the error plus a suppressed-count summary for a
     * periodic repeat.
     */
    record(rawMessage: string): PollLogDecision {
        const at = this.now();
        const message = rawMessage.trim();
        const hint = pollErrorHint(message);

        // A different error is always news — log it and start tracking it
        // instead. Without this, a token rejection arriving during a
        // conflict storm would be suppressed as "more of the same".
        if (this.last === null || this.last.message !== message) {
            this.last = { message, firstAt: at, lastLoggedAt: at, suppressed: 0 };
            return hint === undefined ? { kind: 'log', message } : { kind: 'log', message, hint };
        }

        if (at - this.last.lastLoggedAt < this.repeatAfterMs) {
            this.last.suppressed += 1;
            return { kind: 'suppress' };
        }

        const suppressed = this.last.suppressed;
        const minutes = Math.max(1, Math.round((at - this.last.firstAt) / 60_000));
        this.last.lastLoggedAt = at;
        this.last.suppressed = 0;
        const summary = `${message} (still failing after ${minutes}m;`
            + ` ${suppressed} identical failure${suppressed === 1 ? '' : 's'} suppressed)`;
        return hint === undefined
            ? { kind: 'log', message: summary }
            : { kind: 'log', message: summary, hint };
    }

    /**
     * Clear the tracked failure after a successful poll, so the next
     * outage logs immediately rather than being folded into an hours-old
     * suppression window.
     */
    clear(): void {
        this.last = null;
    }
}
