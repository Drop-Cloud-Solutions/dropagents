/**
 * Telegram inbound allow-list parser.
 *
 * Strict deny-by-default semantics: unset, empty, or whitespace-only input
 * resolves to `deny-all` and {@link isAllowed} returns `false` for every
 * user ID — including ones that look legitimate. The orchestrator must be
 * able to call {@link parseAllowList} once at startup, log the result via
 * {@link describeMode}, and then gate every inbound update through
 * {@link isAllowed} without re-checking the raw env var.
 *
 * Why a dedicated module: the allow-list is the only enforcement boundary
 * between the wider Telegram user base and the orchestrator. Inline-parsing
 * the env var at the call site has historically drifted (truthy-string
 * checks, missing trim, accidental `Number('')===0` accepts) so the rules
 * live here in one place with exhaustive tests, and task-013 re-pins the
 * deny-all contract from the outside.
 */

/** Parser output. `mode === 'deny-all'` means every user is denied,
 *  regardless of `ids`. Callers MUST go through {@link isAllowed} rather
 *  than testing membership on `ids` directly. */
export interface ParsedAllowList {
    readonly mode: 'deny-all' | 'allow-list';
    readonly ids: ReadonlySet<number>;
    readonly warnings: readonly string[];
}

/** Matches an unsigned decimal integer with no leading zeros allowed past
 *  a single zero. Telegram user IDs are positive 64-bit ints; we keep the
 *  regex strict so that tokens like "-1", "1.5", "1e3", "0x10", or "1 2"
 *  fall through to the warnings path instead of being silently accepted
 *  by a lenient `Number()` coercion. */
const INTEGER_TOKEN = /^(?:0|[1-9]\d*)$/;

/**
 * Parse the raw `TELEGRAM_ALLOWED_USER_IDS` env value.
 *
 * Contract:
 * - `undefined`, `null`, `''`, or whitespace-only → `mode: 'deny-all'`,
 *   `ids: new Set()`, `warnings: []`.
 * - Comma-separated integers → `mode: 'allow-list'` with the parsed set.
 *   Whitespace around each token is trimmed.
 * - Tokens that are not integers are dropped and recorded in `warnings`
 *   as `dropped non-numeric token: "<raw>"` so the startup log can show
 *   exactly what was rejected.
 * - Empty tokens produced by stray/trailing commas (e.g. `"1,,2"` or
 *   `"1,"`) are skipped silently — they are typos, not garbage worth a
 *   warning.
 * - Duplicates collapse into the set; no warning is emitted.
 *
 * Note: the parameter type permits `null` at runtime even though
 * TypeScript callers will typically pass `string | undefined` from
 * `process.env`. Defensive against callers that normalise missing env
 * vars to `null`.
 */
export function parseAllowList(raw: string | null | undefined): ParsedAllowList {
    if (raw === undefined || raw === null || raw.trim() === '') {
        return { mode: 'deny-all', ids: new Set(), warnings: [] };
    }

    const ids = new Set<number>();
    const warnings: string[] = [];

    for (const rawToken of raw.split(',')) {
        const token = rawToken.trim();
        if (token === '') continue;
        if (!INTEGER_TOKEN.test(token)) {
            warnings.push(`dropped non-numeric token: "${rawToken}"`);
            continue;
        }
        const id = Number(token);
        if (!Number.isSafeInteger(id)) {
            warnings.push(`dropped non-numeric token: "${rawToken}"`);
            continue;
        }
        ids.add(id);
    }

    return { mode: 'allow-list', ids, warnings };
}

/**
 * Authorisation check. Always returns `false` in `deny-all` mode so a
 * misconfigured deployment fails closed. In `allow-list` mode the user
 * must appear in the parsed set.
 */
export function isAllowed(parsed: ParsedAllowList, userId: number): boolean {
    if (parsed.mode === 'deny-all') return false;
    return parsed.ids.has(userId);
}

/**
 * Human-readable summary for the startup log. Format is stable enough to
 * grep for in operator-facing logs:
 *
 * - `deny-all (no users allowed)`
 * - `allow-list (1 user ID: 123)`
 * - `allow-list (2 user IDs: 123, 456)`
 *
 * IDs are emitted in insertion order so the log line matches the env var
 * the operator just set, modulo trimmed whitespace and dropped garbage.
 */
export function describeMode(parsed: ParsedAllowList): string {
    if (parsed.mode === 'deny-all') {
        return 'deny-all (no users allowed)';
    }
    const ids = Array.from(parsed.ids);
    const noun = ids.length === 1 ? 'user ID' : 'user IDs';
    return `allow-list (${ids.length} ${noun}: ${ids.join(', ')})`;
}
