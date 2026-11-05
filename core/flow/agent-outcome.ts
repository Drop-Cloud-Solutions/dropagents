/**
 * Parse a task agent's final assistant text into a semantic outcome.
 *
 * The runner's `AgentFinished` event only carries the process exit
 * code — `0` for every clean claude-cli run, regardless of whether
 * the reviewer rejected the diff or the tester reported failing
 * tests. To route review/test failures back to the developer (via
 * the YAML `on_failure: develop`) the orchestrator needs to look at
 * the agent's own output and decide whether the run actually
 * succeeded.
 *
 * The convention is encoded in each agent persona under "## Your output".
 * Core knows only its OWN roles:
 *
 *   reviewer        → `APPROVED`         | `CHANGES REQUIRED: …`
 *   tester          → `ALL TESTS PASSED` | `TESTS FAILED: …`
 *   developer → no terminal marker — fall through to `unknown`
 *   committer → no terminal marker — fall through to `unknown`
 *
 * A stack pack's roles arrive as {@link ExtraRoleOutcomes} — declared in
 * its `pack.yaml` as plain marker strings and compiled here into the same
 * patterns above, so core never names a stack's roles. The dotnet-azure
 * pack supplies the deploy pair that way (`DEPLOYED` / `DEPLOY FAILED`,
 * `VERIFIED:` / `STALE:` / `INCONCLUSIVE:`).
 *
 * Such a role can be SENTINEL-REQUIRED (`require_verdict`): an output with
 * no recognised verdict is a FAILURE, not an unknown-treated-as-success.
 * Field case T-DOA-001/002: a deploy task and its verify task both
 * reported success while nothing reached Azure — the personas defined
 * these sentinels but nothing parsed them, so `DEPLOY FAILED:` and
 * `STALE:` sailed through on the process exit code alone. A deploy step
 * that produces no verdict is exactly the silent no-op this guards.
 *
 * Still pure: the markers are an ARGUMENT, not module state, so the same
 * (role, text, markers) always gives the same verdict.
 *
 * Additionally a transient Claude CLI error (e.g. `API Error: 529
 * Overloaded`) leaves the assistant chunks looking like a "success"
 * to the runner. Treat outputs that contain only such an error as
 * `failure` so the flow doesn't march past a crashed run.
 */

export type AgentOutcome = 'success' | 'failure' | 'unknown';

interface OutcomePatterns {
    readonly success: readonly RegExp[];
    readonly failure: readonly RegExp[];
}

const PATTERNS_BY_ROLE: Readonly<Record<string, OutcomePatterns>> = {
    reviewer: {
        success: [/(^|\n)\s*[#*`]*\s*approved\s*[#*`]*\s*($|\n)/i],
        failure: [/(^|\n)\s*[#*`]*\s*changes\s+required\s*[:.\-—–]/i],
    },
    tester: {
        success: [/(^|\n)\s*[#*`]*\s*all\s+tests\s+passed\s*[#*`]*\s*($|\n)/i],
        failure: [/(^|\n)\s*[#*`]*\s*tests\s+failed\s*[:.\-—–]/i],
    },
    'project-context-writer': {
        // Either marker is a completed job: one replaces the project
        // context, the other records that nothing needed changing.
        success: [/(^|\n)\s*[#*`]*\s*PROJECT_CONTEXT_(?:UPDATE|UNCHANGED)\b/i],
        failure: [],
    },
};

/**
 * Verdict markers for a role core does not know, supplied by the caller.
 *
 * Plain strings, compiled by {@link compileMarkers} into the same shapes
 * as the table above — a pack declares `DEPLOYED`, not a regex, so it
 * cannot smuggle in a subtly different matcher. `requireVerdict` makes an
 * unrecognised output a FAILURE (the sentinel-required rule): the verdict
 * must be the last line with content.
 */
export interface RoleOutcomeMarkers {
    readonly success: readonly string[];
    readonly failure: readonly string[];
    readonly requireVerdict: boolean;
}

/** role → its markers. The orchestrator builds this from the enabled packs. */
export type ExtraRoleOutcomes = ReadonlyMap<string, RoleOutcomeMarkers>;

/**
 * Compile marker strings into the anchored, case-insensitive patterns this
 * module already applies to its own roles.
 *
 * A marker ending in `:` REQUIRES a separator (`VERIFIED:` →
 * `verified\s*[:.-]`), matching how the verifier's verdict always carries
 * its evidence. One without takes a word boundary and an optional
 * separator (`DEPLOYED` → `deployed\b\s*[:.-]?`), so both `DEPLOYED — app
 * to stg` and `DEPLOY FAILED: no such group` match as they did when these
 * patterns were literals here.
 */
function compileMarkers(markers: readonly string[]): RegExp[] {
    const out: RegExp[] = [];
    for (const raw of markers) {
        const marker = raw.trim();
        if (marker.length === 0) continue;
        const needsSeparator = marker.endsWith(':');
        const words = marker
            .replace(/:+$/, '')
            .split(/\s+/)
            .filter((w) => w.length > 0)
            .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        if (words.length === 0) continue;
        const body = words.join('\\s+');
        const tail = needsSeparator ? '\\s*[:.-]' : '\\b\\s*[:.-]?';
        out.push(new RegExp(`^\\s*[#*\`]*\\s*${body}${tail}`, 'i'));
    }
    return out;
}

/**
 * Same "no verdict means failure" rule, but the marker may sit ANYWHERE
 * in the output rather than on the final line.
 *
 * `project-context-writer` needs this because its verdict is a BLOCK, not
 * a line: `PROJECT_CONTEXT_UPDATE` is followed by a fenced copy of the new
 * context, so the last meaningful line is the last line of that context
 * and would never match. Without the role listed here at all, a reply that
 * forgot the marker entirely would parse as `unknown`, which the
 * orchestrator's bridge treats as success — the task would go green having
 * written nothing.
 */
const SENTINEL_ANYWHERE_ROLES: ReadonlySet<string> = new Set([
    'project-context-writer',
]);

/**
 * The verdict line: the last line with actual CONTENT.
 *
 * Not merely the last non-empty line — agents routinely close their
 * reasoning trace in a fenced block, so the literal final line is a
 * ``` fence and the verdict sits just above it. Reading the fence as the
 * verdict scope made a clean VERIFIED report fail the task (field case:
 * L-DOA-002, whose report ended `VERIFIED: ...` then a closing fence).
 * Trailing fences, horizontal rules and bare heading marks are skipped.
 */
// Indicates the claude CLI itself errored - the assistant chunks
// contain only this surface, no real work product. Apply regardless of
// role.
const API_ERROR_PATTERN = /API Error:\s*\d+/i;

/**
 * Did the CLI print an API-level error INSTEAD of doing the work?
 *
 * The other shape of an API failure: rather than a failing terminal
 * frame, the CLI writes `API Error: 400 …` as assistant text and exits
 * 0. The run then looks successful and its "output" is the error banner.
 *
 * Task agents have consulted this since it was written (via
 * {@link parseAgentOutcomeDetailed}). Lifecycle agents — planner,
 * decomposer, architect — never did, so a flagged decomposition was
 * reported to the operator as "decomposer output contains no JSON
 * object", which is true and useless. Exported so both paths test the
 * same thing rather than growing a second regex that drifts.
 */
export function looksLikeApiError(text: string | null | undefined): boolean {
    return typeof text === 'string' && API_ERROR_PATTERN.test(text);
}

/**
 * The API-error line itself, for a failure reason the operator can act
 * on. Returns the first matching line rather than the whole body, which
 * may carry a partial answer ahead of the banner.
 */
export function apiErrorLine(text: string): string | null {
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (line.length > 0 && API_ERROR_PATTERN.test(line)) return line;
    }
    return null;
}

const DECORATION_ONLY_RE = /^(?:`{3,}[a-z0-9_-]*|~{3,}|-{3,}|[*]{3,}|_{3,}|={3,}|#{1,6})$/i;

function lastMeaningfulLine(text: string): string {
    const lines = text.split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
        const line = lines[i]!.trim();
        if (line.length === 0) continue;
        if (DECORATION_ONLY_RE.test(line)) continue;
        return line;
    }
    return '';
}

export interface AgentOutcomeDetail {
    readonly outcome: AgentOutcome;
    /**
     * The verdict line the decision came from, when there was one —
     * carried into the task's failure reason so the board shows the
     * agent's own evidence ("STALE: app still on build 41") instead of
     * a bare "failed".
     */
    readonly sentinel?: string;
}

/**
 * Pure: maps `(role, finalText)` → outcome + the verdict line behind it.
 *
 * Resolution order, highest priority first:
 *   1. Empty / missing text → `failure` (nothing to interpret).
 *   2. API Error marker → `failure` (claude crashed mid-stream).
 *   3. Role failure marker on the LAST non-empty line → `failure`.
 *   4. Role success marker on the LAST non-empty line → `success`.
 *   5. Role failure marker ANYWHERE → `failure`. Deliberately
 *      asymmetric: a verdict buried above trailing chatter still fails
 *      the step, while success must be the agent's final word.
 *   6. Sentinel-required role with nothing matched → `failure`.
 *   7. Otherwise → `unknown` (roles without markers, e.g. developer,
 *      must not be falsely failed).
 *
 * Legacy roles (reviewer / tester) keep whole-text matching so their
 * long-standing "APPROVED somewhere in the summary" behaviour is
 * unchanged.
 */
export function parseAgentOutcomeDetailed(
    role: string,
    finalText: string | null | undefined,
    extraOutcomes?: ExtraRoleOutcomes,
): AgentOutcomeDetail {
    if (!finalText || finalText.trim().length === 0) {
        return { outcome: 'failure' };
    }
    if (API_ERROR_PATTERN.test(finalText)) {
        return { outcome: 'failure' };
    }
    const key = role.toLowerCase();
    // A caller-supplied role (a pack's) is compiled to the same shapes as
    // core's own. Core's table wins on a collision: a pack must not
    // redefine what `reviewer` counts as approved.
    const extra = PATTERNS_BY_ROLE[key] ? undefined : extraOutcomes?.get(key);
    const patterns = PATTERNS_BY_ROLE[key]
        ?? (extra
            ? { success: compileMarkers(extra.success), failure: compileMarkers(extra.failure) }
            : undefined);
    if (!patterns) return { outcome: 'unknown' };

    const lastLineOnly = extra?.requireVerdict === true;
    const requiresSentinel = lastLineOnly || SENTINEL_ANYWHERE_ROLES.has(key);
    const scope = lastLineOnly ? lastMeaningfulLine(finalText) : finalText;

    for (const re of patterns.failure) {
        if (re.test(scope)) return { outcome: 'failure', sentinel: scope };
    }
    for (const re of patterns.success) {
        if (re.test(scope)) return { outcome: 'success', sentinel: scope };
    }
    if (requiresSentinel) {
        // A failure verdict that isn't the final line still fails the
        // step — only a SUCCESS verdict has to be the last word.
        for (const line of finalText.split(/\r?\n/).reverse()) {
            const trimmed = line.trim();
            if (trimmed.length === 0) continue;
            for (const re of patterns.failure) {
                if (re.test(trimmed)) return { outcome: 'failure', sentinel: trimmed };
            }
        }
        return { outcome: 'failure' };
    }
    return { outcome: 'unknown' };
}

/** Back-compat wrapper — the outcome without the evidence line. */
export function parseAgentOutcome(
    role: string,
    finalText: string | null | undefined,
    extraOutcomes?: ExtraRoleOutcomes,
): AgentOutcome {
    return parseAgentOutcomeDetailed(role, finalText, extraOutcomes).outcome;
}
