/**
 * Stopping a running chat turn — the two bits both chat surfaces need to
 * agree on.
 *
 * There are two of them: the main chat modal and the scoped pane in the
 * plan / design modals. The pane had no stop control at all, so a design
 * chat that was clearly going the wrong way could only be waited out or
 * closed — and closing left the `claude` process running with nobody
 * reading it. Giving the pane a Stop button meant duplicating this logic,
 * so it lives here instead.
 */

/**
 * URL of the worker's stop endpoint for `sessionId`.
 *
 * `encodeURIComponent` is load-bearing, not decoration. Telegram-seeded
 * session ids are `telegram:<userId>[:<repoId>]`, and a raw `:` in the
 * path segment does not round-trip — the worker decodes the segment on
 * the way in (see `decodeSessionId`), so the client MUST encode it. A
 * stop that silently addressed the wrong path would leave the agent
 * running while the UI claimed it had stopped.
 */
export function chatStopUrl(apiBase: string, sessionId: string): string {
    return `${apiBase}/api/chat/sessions/${encodeURIComponent(sessionId)}/stop`;
}

/**
 * True when this error is the operator pressing Stop rather than
 * something going wrong.
 *
 * Aborting a `fetch` rejects the read with an `AbortError`. Rendering
 * that as `(error: signal is aborted…)` tells the operator their own
 * deliberate action failed, which is both alarming and wrong.
 */
export function isOperatorStop(err: unknown): boolean {
    // Duck-typed on `name` rather than `instanceof`. The two surfaces
    // guessed differently — one tested `Error`, the other `DOMException`
    // — and both are guesses about which class the runtime throws: a
    // fetch abort surfaces as a DOMException in browsers, an Error in
    // undici, and neither branch is guaranteed to be the one that fires.
    // A missed abort renders the operator's own Stop as a failure.
    if (typeof err !== 'object' || err === null) return false;
    return (err as { name?: unknown }).name === 'AbortError';
}
