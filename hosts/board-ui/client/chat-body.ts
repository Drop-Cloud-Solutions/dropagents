/**
 * What of an assistant reply to SHOW, once its proposals have their own
 * cards.
 *
 * The worker parses `PROPOSE_*` blocks out of the reply and returns them
 * as structured proposals; both chat surfaces then render the reply body
 * verbatim AND a card per proposal. So every proposed task arrived twice:
 * the whole block as prose — `PROPOSE_TASK`, `Title:`, `Type:`, and the
 * full `Description:` — immediately followed by a card carrying the same
 * title and description with the button on it. The operator reads the
 * description, scrolls past it, and reads it again.
 *
 * This removes the blocks from the displayed text. Nothing is lost: the
 * card is built from the parse of those exact lines, and the persisted
 * message body keeps them, so the agent's own transcript is unchanged.
 *
 * The block detection MIRRORS `splitProposalBlocks` in
 * `hosts/worker-api/routes/chat.ts`, including its tolerance for a marker
 * glued to a code fence (```` ```PROPOSE_ACTION ````). The two must agree:
 * strip less than was parsed and the duplication comes back; strip more
 * and prose disappears with no card to replace it.
 */

// Markers, marker parsing and block bounds all come from the shared
// module the worker-api parser uses. This file used to keep its own copy
// of each with a comment saying "keep in step with it" — they drifted
// twice, and a drift here either duplicates a block into the bubble or
// truncates the task the operator gets.
import {
    isBareFence,
    markerOf,
    PROPOSAL_MARKERS as MARKERS,
    splitProposalBlocks,
} from '../../../core/chat/proposal-blocks';

/**
 * The reply with its proposal blocks removed, ready to render.
 *
 * A reply that is ONLY a proposal returns '' — the caller should then
 * render no bubble at all rather than an empty one.
 */
export function stripProposalBlocks(body: string): string {
    if (typeof body !== 'string' || body.length === 0) return '';
    // Cheap exit: most replies carry no proposal.
    if (!/PROPOSE_/.test(body)) return body;

    // Bounds come from the SHARED splitter the worker-api parser uses.
    // Deriving them here independently is what let the two drift: the
    // parser would stop at a fence inside a description while this kept
    // the rest as prose, rendering the block twice.
    const lines = body.split(/\r?\n/);
    const blocks = splitProposalBlocks(lines.join('\n'));
    const drop = new Set<number>();
    for (const block of blocks) {
        // The marker sits one line before the body; find it by walking
        // back from the first body line (or from endIndex for an empty
        // block) to the nearest marker line.
        let markerIdx = block.endIndex - block.lines.length - 1;
        while (markerIdx > 0 && !MARKERS.has(markerOf(lines[markerIdx] ?? ''))) {
            markerIdx -= 1;
        }
        for (let i = markerIdx; i < block.endIndex; i += 1) drop.add(i);
        // Consume the wrapper's closing fence; leaving it renders a stray
        // ``` where the block used to be.
        if (block.endIndex < lines.length && isBareFence(lines[block.endIndex] ?? '')) {
            drop.add(block.endIndex);
        }
        // And its opening fence, now orphaned.
        if (block.wrapped) {
            for (let j = markerIdx - 1; j >= 0; j -= 1) {
                const t = (lines[j] ?? '').trim();
                if (t.length === 0) continue;
                if (/^```[a-z]*$/i.test(t)) drop.add(j);
                break;
            }
        }
    }

    const kept = lines.filter((_l, i) => !drop.has(i));
    // Collapse the blank runs the removal leaves behind, and trim the
    // ends — a reply that ended with a proposal should not render with a
    // tail of empty lines.
    return kept
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}
