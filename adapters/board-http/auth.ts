import { timingSafeEqual } from 'node:crypto';

const BEARER_PREFIX = 'Bearer ';

/**
 * Validate an `Authorization: Bearer <token>` header against `expected`.
 *
 * The byte-wise comparison runs through `crypto.timingSafeEqual` so a
 * remote attacker cannot recover the token through response-time
 * differences. Length is compared first because `timingSafeEqual` requires
 * equal-length buffers; the API token is a fixed shared secret in
 * deployment, so leaking its length is not material.
 *
 * Returns false for any malformed header (missing, wrong scheme, empty
 * token) so the caller can return a single 401 path regardless of why
 * authentication failed.
 */
export function authorize(authHeader: string | undefined, expected: string): boolean {
    if (typeof authHeader !== 'string') return false;
    if (!authHeader.startsWith(BEARER_PREFIX)) return false;
    const provided = authHeader.slice(BEARER_PREFIX.length);
    if (provided.length === 0) return false;
    return constantTimeEqual(provided, expected);
}

/**
 * Constant-time string equality via `crypto.timingSafeEqual`. Mismatched
 * lengths short-circuit to false (timingSafeEqual itself rejects unequal
 * inputs with a synchronous throw, which we must avoid in a request hot
 * path).
 */
export function constantTimeEqual(a: string, b: string): boolean {
    const ab = Buffer.from(a, 'utf8');
    const bb = Buffer.from(b, 'utf8');
    if (ab.length !== bb.length) return false;
    return timingSafeEqual(ab, bb);
}
