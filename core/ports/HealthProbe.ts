/**
 * Port: HTTP health probe.
 *
 * Asks "is this URL healthy?" and answers with a `{ ok, status, body? }`
 * triple. The notion of "healthy" is supplied by the caller as a
 * {@link HealthPredicate} — a discriminated union that is intentionally
 * tiny so the adapter implementation stays a thin wrapper around a
 * single HTTP request:
 *
 *   - `kind: 'status'`    — the response's status code must equal
 *                           `equals` (typical: 200). The adapter does
 *                           not read the body in this case.
 *   - `kind: 'json-path'` — the response body is parsed as JSON and the
 *                           value at the supplied dot-path must equal
 *                           `equals`. Missing keys count as a miss
 *                           (ok = false), not a throw.
 *
 * Anything fancier (auth, custom headers, multi-step probes, JSONPath
 * filters/wildcards) is intentionally out of scope: a richer probe
 * becomes a second adapter rather than a bigger predicate vocabulary.
 *
 * The port is deliberately throw-free in the network-failure path:
 * adapters MUST resolve with `{ ok: false, status: 0 }` when the request
 * never reaches a responding server, so callers (typically a flow engine
 * polling readiness) get a predictable boolean back instead of an
 * unhandled promise rejection.
 */

/**
 * The two predicate shapes the port understands. Discriminated on
 * `kind` so adapter implementations can `switch` exhaustively.
 *
 * - `status`    matches when the HTTP response code equals `equals`.
 * - `json-path` matches when the JSON value at the dot-path `path`
 *               (e.g. `status`, `data.ready`, `$.version`) deep-equals
 *               `equals`. A leading `$.` or `$` is tolerated. Array
 *               indexing and JSONPath filters are not supported.
 */
export type HealthPredicate =
    | { readonly kind: 'status'; readonly equals: number }
    | { readonly kind: 'json-path'; readonly path: string; readonly equals: unknown };

/**
 * Outcome of a probe call.
 *
 *   - `ok`     — true iff the predicate matched. Adapters MUST return
 *                `false` on network errors, JSON-parse failures, and
 *                missing dot-path keys rather than throwing.
 *   - `status` — the HTTP status code of the response. Zero when the
 *                request never reached a responding server (DNS error,
 *                connection refused, transport-level abort).
 *   - `body`   — the parsed JSON body when a `json-path` predicate
 *                read it (regardless of match outcome), so callers can
 *                surface the actual value in a diagnostic. Omitted for
 *                `status` predicates and for unreachable endpoints.
 */
export interface HealthProbeResult {
    readonly ok: boolean;
    readonly status: number;
    readonly body?: unknown;
}

export interface HealthProbe {
    probe(url: string, predicate: HealthPredicate): Promise<HealthProbeResult>;
}
