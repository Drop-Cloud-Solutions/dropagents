/**
 * Where a `PROPOSE_*` block starts and ends.
 *
 * This lived twice — once in the worker-api parser, once in the board's
 * prose stripper — with a comment on each saying "the two must agree".
 * They drifted, twice. The parser decides what the task GETS and the
 * stripper decides what the operator SEES, so a disagreement either
 * duplicates a block into the chat bubble or silently truncates the task.
 * One module, imported by both.
 *
 * The hard case is a fence INSIDE a block. Two real shapes collide:
 *
 *   A. wrapped — the model fences the whole block. The closing fence ends
 *      it, and prose after it is the agent talking to the operator.
 *
 *          ```
 *          PROPOSE_TASK
 *          Description: details
 *          ```
 *          Say the word and I'll add it.
 *
 *   B. unwrapped, with a code sample in the description. The fences are
 *      the operator's own evidence and are CONTENT.
 *
 *          PROPOSE_TASK
 *          Description: the summary is wrong. From a real `tst` run:
 *          ```
 *          app: a  status: Succeeded
 *          ```
 *          Acceptance: attribute per-app.
 *
 * Field report on B: the description stopped dead at "From a real `tst`
 * run:", losing the evidence and the acceptance criteria, and the agents
 * came back asking questions the description had already answered.
 *
 * Unwrapped blocks are told apart by fence PARITY over the rest of the
 * block: an even number of fences means they pair up into code samples
 * (content); an odd one means a stray closing fence (a terminator). That
 * is exactly the information the two shapes differ by.
 */

/** Every marker that opens a proposal block. */
export const PROPOSAL_MARKERS: ReadonlySet<string> = new Set([
    'PROPOSE_TASK',
    'PROPOSE_TASK_UPDATE',
    'PROPOSE_PLAN_REPO',
    'PROPOSE_PROJECT_UPDATE',
    'PROPOSE_ACTION',
    'PROPOSE_CONFIG_CHANGE',
    'PROPOSE_PLAN_UPDATE',
    'PROPOSE_REQUIREMENT_UPDATE',
]);

/**
 * A marker line with its surrounding backticks stripped — the model
 * regularly glues the marker to the fence (```PROPOSE_ACTION).
 */
export function markerOf(line: string): string {
    return line.trim().replace(/^`+\s*/, '').replace(/\s*`+$/, '').trim();
}

/** A line that is exactly a bare fence — a wrapper's opener or closer. */
export function isBareFence(line: string): boolean {
    return line.trim() === '```';
}

/** Any fence line, tagged (```yaml) or not — both open a code block. */
function isAnyFence(line: string): boolean {
    return /^```/.test(line.trim());
}

export interface ProposalBlock {
    readonly marker: string;
    /** The block's body lines, marker and wrapper fences excluded. */
    readonly lines: string[];
    /** Index just past the block — the wrapper's closing fence, if any. */
    readonly endIndex: number;
    /** True when the block was opened inside a fence. */
    readonly wrapped: boolean;
}

/**
 * Does a bare fence at or after `from` terminate this UNWRAPPED block?
 *
 * Counts fences from `from` to the next marker (or the end). An even
 * count means they pair into code samples and belong to the description;
 * an odd count leaves one unmatched, which is a stray closing fence and
 * ends the block.
 */
function unwrappedFenceTerminates(lines: readonly string[], from: number): boolean {
    let fences = 0;
    for (let i = from; i < lines.length; i += 1) {
        if (PROPOSAL_MARKERS.has(markerOf(lines[i]!))) break;
        if (isAnyFence(lines[i]!)) fences += 1;
    }
    return fences % 2 === 1;
}

/**
 * Split `text` into its proposal blocks, in order.
 *
 * `endIndex` lets the stripper remove exactly what the parser consumed,
 * including a wrapper's closing fence, without re-deriving the bounds.
 */
export function splitProposalBlocks(text: string): ProposalBlock[] {
    const out: ProposalBlock[] = [];
    const lines = text.split(/\r?\n/);
    let i = 0;
    while (i < lines.length) {
        const marker = markerOf(lines[i]!);
        if (!PROPOSAL_MARKERS.has(marker)) {
            i += 1;
            continue;
        }
        // Opened inside a fence? Either glued to the marker, or a bare
        // fence on the line above.
        const wrapped = lines[i]!.trim().startsWith('`')
            || (i > 0 && isBareFence(lines[i - 1]!));
        i += 1;
        // For an unwrapped block, decide ONCE whether its fences are
        // content or a terminator — deciding per line would flip midway
        // through a code sample.
        const fenceEnds = !wrapped && unwrappedFenceTerminates(lines, i);
        const body: string[] = [];
        for (; i < lines.length; i += 1) {
            if (PROPOSAL_MARKERS.has(markerOf(lines[i]!))) break;
            if (isBareFence(lines[i]!) && (wrapped || fenceEnds)) break;
            body.push(lines[i]!);
        }
        out.push({ marker, lines: body, endIndex: i, wrapped });
    }
    return out;
}
