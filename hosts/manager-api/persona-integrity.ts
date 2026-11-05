/**
 * Integrity checks for persona markdown written through the manager-api.
 *
 * Field incident: the planner and decomposer personas were rewritten via
 * the manager UI and landed on the worker TRUNCATED MID-SENTENCE — the
 * decomposer at "**Tool allowlists by role:**" (680 of 1053 lines), the
 * planner inside a `## Key Files` example. What was lost was the tail:
 * the decomposer's output template (the JSON contract
 * `core/decomposer/task.schema.json` is derived from), its self-check
 * and anti-patterns, and — in both files — the NEEDS_HUMAN_INPUT escape
 * hatch, without which neither agent can park for a clarification at
 * all. Nothing noticed until the personas were diffed by hand.
 *
 * A persona is prose, so "is this complete?" has no exact answer. These
 * checks look only for endings that are unambiguously mid-thought, and
 * were validated against all 21 personas in the repo plus the shared
 * block — every one passes, so a legitimate save is not blocked.
 *
 * Both editing surfaces funnel through `PUT /agent-md/:role` (the UI
 * editor directly, chat via `chat-config-apply`'s `persona:<role>`
 * target), so guarding that one route covers both.
 */

export interface PersonaProblem {
    /** Stable slug for the UI / logs. */
    readonly code:
        | 'unclosed-code-fence'
        | 'dangling-lead-in'
        | 'dangling-heading'
        | 'escape-hatch-dropped';
    /** Operator-facing sentence: what is wrong and what to do about it. */
    readonly message: string;
}

const FENCE_RE = /^\s*(?:```|~~~)/;

function lines(content: string): string[] {
    return content.replace(/\r\n/g, '\n').split('\n');
}

function lastMeaningfulLine(content: string): string {
    const nonEmpty = lines(content).filter((l) => l.trim().length > 0);
    return nonEmpty.length > 0 ? nonEmpty[nonEmpty.length - 1]! : '';
}

/**
 * Does this content end mid-thought? Returns the first problem found, or
 * `null` when the ending looks deliberate.
 *
 * Deliberately NOT checked: ending on a bullet, a table row, or a plain
 * sentence. Those are all legitimate endings, and a false rejection
 * blocks an operator from saving perfectly good text.
 */
export function findTruncation(content: string): PersonaProblem | null {
    const all = lines(content);

    // An odd number of fence markers means a code block was opened and
    // never closed — the single most reliable truncation tell.
    const fences = all.filter((l) => FENCE_RE.test(l)).length;
    if (fences % 2 !== 0) {
        return {
            code: 'unclosed-code-fence',
            message:
                'The content ends inside an unclosed code block (odd number of ``` '
                + 'fences). That usually means the text was cut off before it '
                + 'finished. Nothing was saved.',
        };
    }

    const last = lastMeaningfulLine(content);

    // A line ending in a colon promises what comes next — a list, an
    // example, a code block. Both field truncations ended exactly this
    // way ("**Tool allowlists by role:**", "… Example:").
    //
    // Trailing emphasis/code markers are stripped first: the decomposer's
    // real cut was `**Tool allowlists by role:**`, whose last CHARACTER
    // is an asterisk. Checking the raw ending missed the one case this
    // guard exists for.
    if (last.trimEnd().replace(/[*_`~]+$/, '').trimEnd().endsWith(':')) {
        return {
            code: 'dangling-lead-in',
            message:
                `The content ends on "${truncateForMessage(last)}", which introduces `
                + 'something that never arrives — the text was almost certainly cut '
                + 'off. Nothing was saved.',
        };
    }

    // A heading with no body under it.
    if (/^\s*#{1,6}\s/.test(last)) {
        return {
            code: 'dangling-heading',
            message:
                `The content ends on the heading "${truncateForMessage(last)}" with no `
                + 'section under it — the text was almost certainly cut off. Nothing '
                + 'was saved.',
        };
    }

    return null;
}

/**
 * Refuse to replace a persona that HAS the NEEDS_HUMAN_INPUT escape
 * hatch with one that doesn't.
 *
 * Not every persona carries it — `chat` and `design-verifier` never
 * have — so this is a regression check against the file being replaced,
 * never a blanket requirement. An agent that loses the block silently
 * loses its only way to ask the operator a question.
 */
export function findDroppedEscapeHatch(
    current: string | null,
    next: string,
): PersonaProblem | null {
    if (current === null) return null;
    if (!current.includes('NEEDS_HUMAN_INPUT')) return null;
    if (next.includes('NEEDS_HUMAN_INPUT')) return null;
    return {
        code: 'escape-hatch-dropped',
        message:
            'The current persona ends with the NEEDS_HUMAN_INPUT escape hatch and '
            + 'the new content does not. Without it this agent cannot ask the '
            + 'operator a question — it can only guess or fail. Keep the '
            + '`## Escape hatch: NEEDS_HUMAN_INPUT` section (copy it from any other '
            + 'persona, or from agents/_shared/clarification-block.md). Nothing was '
            + 'saved.',
    };
}

export interface SplicedGeneration {
    readonly content: string;
    /** The line the generation stopped on, echoed back for the notice. */
    readonly resumedAfter: string;
    /** How many lines were carried over from the existing file. */
    readonly carriedLines: number;
}

/**
 * Rescue a generation that stopped early.
 *
 * A model asked to reproduce a 1000-line persona can hit its output
 * limit and return a clean exit with a partial document. When the last
 * line it produced also exists — exactly once — in the file being
 * revised, the remainder of that file is exactly what is missing, and
 * the two splice at a known-good boundary. This is the same repair done
 * by hand for the planner and decomposer; doing it here means the
 * operator reviews a COMPLETE draft instead of unknowingly saving a
 * truncated one.
 *
 * Returns `null` when the seam is not unambiguous — no anchor, or an
 * anchor appearing more than once. A wrong splice would be worse than
 * an honest failure.
 */
export function spliceTruncatedGeneration(
    generated: string,
    current: string,
): SplicedGeneration | null {
    const anchor = lastMeaningfulLine(generated);
    if (anchor.length === 0) return null;

    const currentLines = lines(current);
    const hits = currentLines
        .map((l, i) => (l === anchor ? i : -1))
        .filter((i) => i !== -1);
    if (hits.length !== 1) return null;

    const tail = currentLines.slice(hits[0]! + 1);
    if (tail.every((l) => l.trim().length === 0)) return null;

    const generatedLines = lines(generated);
    // Trim trailing blanks off the generation so the seam is exactly the
    // anchor line followed by the carried-over tail.
    while (
        generatedLines.length > 0
        && generatedLines[generatedLines.length - 1]!.trim().length === 0
    ) {
        generatedLines.pop();
    }

    return {
        content: [...generatedLines, ...tail].join('\n'),
        resumedAfter: anchor,
        carriedLines: tail.length,
    };
}

function truncateForMessage(line: string): string {
    const t = line.trim();
    return t.length > 60 ? `${t.slice(0, 60)}…` : t;
}
