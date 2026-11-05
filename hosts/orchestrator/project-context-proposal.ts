/**
 * Reading the `project-context-writer` agent's answer.
 *
 * The agent's job is to hand back the COMPLETE new project context. That
 * makes its output unusually dangerous to parse loosely: whatever we
 * extract replaces the operator's stored text in full, so a sloppy match
 * that grabs half the reply silently deletes the other half of their
 * architecture description. Every rule below exists to make the failure
 * mode "nothing was written, and the operator is told why" rather than
 * "something was written, and nobody noticed what was lost".
 *
 * Contract (see `agents/project-context-writer.CLAUDE.md`):
 *
 *     PROJECT_CONTEXT_UPDATE
 *     ```markdown
 *     <the complete new context>
 *     ```
 *
 * or, when nothing needs to change, the single line
 *
 *     PROJECT_CONTEXT_UNCHANGED
 *
 * Marker tolerance is deliberate (`## PROJECT_CONTEXT_UPDATE`, a bold
 * variant, a stray colon): models reach for those and the pipeline has
 * been burned before by parsers that only accepted the literal form. The
 * FENCE, by contrast, is mandatory — it is the only thing that says where
 * the content ends, and guessing a boundary is how content gets dropped.
 */

/** The agent had nothing to change. */
export interface ContextUnchanged {
    readonly kind: 'unchanged';
}

/** A complete replacement, ready for the UpdateProjectContext command. */
export interface ContextUpdate {
    readonly kind: 'update';
    readonly content: string;
}

/** Output we could not read. `reason` is shown to the operator verbatim. */
export interface ContextProposalProblem {
    readonly kind: 'problem';
    readonly reason: string;
}

export type ContextProposal =
    | ContextUnchanged
    | ContextUpdate
    | ContextProposalProblem;

/**
 * Matches a marker line however the model decorated it: leading `#`s,
 * surrounding `**`, a trailing colon. Anchored to a whole line so the
 * word appearing inside prose ("I left PROJECT_CONTEXT_UPDATE alone")
 * cannot trigger it.
 */
function markerLine(marker: string): RegExp {
    return new RegExp(`^\\s{0,3}(?:#{1,6}\\s*)?\\*{0,2}${marker}\\*{0,2}\\s*:?\\s*$`, 'im');
}

const UPDATE_MARKER = markerLine('PROJECT_CONTEXT_UPDATE');
const UNCHANGED_MARKER = markerLine('PROJECT_CONTEXT_UNCHANGED');

/** Minimum length for a replacement to be believable. */
const MIN_CONTENT_CHARS = 40;

export function parseContextProposal(output: string): ContextProposal {
    const text = typeof output === 'string' ? output : '';
    if (text.trim().length === 0) {
        return { kind: 'problem', reason: 'the agent produced no output' };
    }

    const update = UPDATE_MARKER.exec(text);
    const unchanged = UNCHANGED_MARKER.exec(text);

    // Both markers present: the agent contradicted itself. Refuse rather
    // than pick — one branch overwrites the context and the other leaves
    // it alone, so a coin-flip here is a coin-flip on the operator's data.
    if (update && unchanged) {
        return {
            kind: 'problem',
            reason: 'the output carries BOTH PROJECT_CONTEXT_UPDATE and '
                + 'PROJECT_CONTEXT_UNCHANGED — refusing to guess which was meant',
        };
    }
    if (unchanged) return { kind: 'unchanged' };
    if (!update) {
        return {
            kind: 'problem',
            reason: 'the output has neither a PROJECT_CONTEXT_UPDATE block nor a '
                + 'PROJECT_CONTEXT_UNCHANGED line',
        };
    }

    const after = text.slice(update.index + update[0].length);
    const fenced = extractFirstFence(after);
    if (fenced === null) {
        return {
            kind: 'problem',
            reason: 'PROJECT_CONTEXT_UPDATE is not followed by a closed ``` fence — '
                + 'without one there is no way to tell where the new context ends',
        };
    }
    const content = fenced.trim();
    if (content.length === 0) {
        return {
            kind: 'problem',
            reason: 'the PROJECT_CONTEXT_UPDATE fence is empty. To record that nothing '
                + 'should change, emit PROJECT_CONTEXT_UNCHANGED; clearing a project '
                + 'context is an operator action, not an agent one',
        };
    }
    if (content.length < MIN_CONTENT_CHARS) {
        // A near-empty replacement is far more likely to be a truncated
        // generation than a genuine one-line architecture description,
        // and it would wipe everything that was there.
        return {
            kind: 'problem',
            reason: `the replacement is only ${content.length} characters — too short to `
                + 'be a complete project context, and it would replace the whole of the '
                + 'existing one',
        };
    }
    return { kind: 'update', content };
}

/**
 * Return the body of the first fenced block, or null when the fence never
 * closes. Handles the ```` ```markdown ```` info string and tolerates
 * longer fences (````` ```` `````), which models emit when the content
 * itself contains a triple backtick.
 */
function extractFirstFence(text: string): string | null {
    const lines = text.split(/\r?\n/);
    let fence: string | null = null;
    const body: string[] = [];
    for (const line of lines) {
        const open = /^\s{0,3}(`{3,})\s*[A-Za-z0-9_-]*\s*$/.exec(line);
        if (fence === null) {
            if (open) fence = open[1];
            continue;
        }
        // A closing fence is at least as long as the opener and carries no
        // info string — that is what lets a nested ``` inside the content
        // stay content.
        const close = /^\s{0,3}(`{3,})\s*$/.exec(line);
        if (close && close[1].length >= fence.length) {
            return body.join('\n');
        }
        body.push(line);
    }
    return null;
}
