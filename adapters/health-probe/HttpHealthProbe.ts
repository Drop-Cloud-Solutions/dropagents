/**
 * Adapter: HTTP-backed {@link HealthProbe}.
 *
 * Implements the port via Node's built-in `fetch` (Node 20+). The
 * adapter is deliberately minimal — one request per probe, no retries,
 * no auth, no header munging — matching the port's "anything fancier is
 * a second adapter" guidance.
 *
 * Failure semantics (load-bearing for the flow engine that polls this):
 *
 *   - Network failure (DNS, connection refused, abort, transport error)
 *     resolves to `{ ok: false, status: 0 }` without throwing.
 *   - For `kind: 'status'`, only the response status code is inspected.
 *     The body is not read.
 *   - For `kind: 'json-path'`, the body is parsed as JSON. A parse
 *     failure resolves to `{ ok: false, status: <response.status> }`
 *     without throwing. A missing dot-path key is a miss (`ok: false`)
 *     and the parsed body is still surfaced via `result.body`.
 *
 * The dot-path walker is intentionally tiny: it splits on `.`, tolerates
 * a leading `$` or `$.`, and refuses any path component that isn't a
 * literal own-property key on the current object. No array indexing, no
 * wildcards, no JSONPath filters.
 */

import type {
    HealthPredicate,
    HealthProbe,
    HealthProbeResult,
} from '../../core/ports/HealthProbe';

/** Minimal subset of the global fetch shape the adapter relies on. */
export type FetchLike = (
    input: string,
    init?: RequestInit,
) => Promise<Response>;

export interface HttpHealthProbeOptions {
    /**
     * Injectable `fetch`. Defaults to the Node 20+ global. Tests pass a
     * fake to avoid spinning a real listener when they don't need one.
     */
    readonly fetch?: FetchLike;
}

export class HttpHealthProbe implements HealthProbe {
    private readonly fetchFn: FetchLike;

    constructor(options: HttpHealthProbeOptions = {}) {
        this.fetchFn = options.fetch ?? globalThis.fetch;
    }

    async probe(
        url: string,
        predicate: HealthPredicate,
    ): Promise<HealthProbeResult> {
        let response: Response;
        try {
            response = await this.fetchFn(url);
        } catch {
            return { ok: false, status: 0 };
        }

        if (predicate.kind === 'status') {
            return {
                ok: response.status === predicate.equals,
                status: response.status,
            };
        }

        let body: unknown;
        try {
            body = await response.json();
        } catch {
            return { ok: false, status: response.status };
        }

        const value = walkDotPath(body, predicate.path);
        const ok = value !== MISSING && jsonEqual(value, predicate.equals);
        return { ok, status: response.status, body };
    }
}

/**
 * Sentinel returned by {@link walkDotPath} when a path component is
 * missing on the current object. Using a symbol instead of `undefined`
 * lets a predicate legitimately match `equals: undefined` if a caller
 * ever wants to — though in practice JSON cannot represent `undefined`,
 * so this is really just a "no such key" tag the consumer never sees.
 */
const MISSING: unique symbol = Symbol('health-probe.missing');

function walkDotPath(input: unknown, path: string): unknown {
    const cleaned = path.replace(/^\$\.?/, '');
    if (cleaned === '') return input;
    const parts = cleaned.split('.');
    let cursor: unknown = input;
    for (const part of parts) {
        if (cursor === null || typeof cursor !== 'object') return MISSING;
        if (!Object.prototype.hasOwnProperty.call(cursor, part)) return MISSING;
        cursor = (cursor as Record<string, unknown>)[part];
    }
    return cursor;
}

function jsonEqual(a: unknown, b: unknown): boolean {
    if (Object.is(a, b)) return true;
    if (a === null || b === null) return false;
    if (typeof a !== typeof b) return false;
    if (typeof a !== 'object') return false;

    const aIsArr = Array.isArray(a);
    const bIsArr = Array.isArray(b);
    if (aIsArr !== bIsArr) return false;

    if (aIsArr) {
        const aArr = a as readonly unknown[];
        const bArr = b as readonly unknown[];
        if (aArr.length !== bArr.length) return false;
        for (let i = 0; i < aArr.length; i++) {
            if (!jsonEqual(aArr[i], bArr[i])) return false;
        }
        return true;
    }

    const aObj = a as Record<string, unknown>;
    const bObj = b as Record<string, unknown>;
    const aKeys = Object.keys(aObj);
    const bKeys = Object.keys(bObj);
    if (aKeys.length !== bKeys.length) return false;
    for (const k of aKeys) {
        if (!Object.prototype.hasOwnProperty.call(bObj, k)) return false;
        if (!jsonEqual(aObj[k], bObj[k])) return false;
    }
    return true;
}
