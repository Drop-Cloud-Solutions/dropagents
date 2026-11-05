/**
 * "Regenerate this design" on the architect (requirement) modal.
 *
 * Replaces a `window.prompt()`. Guidance for the architect is a
 * paragraph — "keep the read model, drop the outbox, the consumer cannot
 * change this quarter" — and a prompt gives one unstyled line: no
 * wrapping, no newlines, no editing back over what you typed, and no way
 * to see the design you are commenting on while you write, because the
 * prompt covers the modal.
 *
 * Only the DECISION lives here — which statuses offer a regenerate and
 * what it is called — because that is the part with rules in it. The
 * DOM is built by the caller, which has `document`, the command
 * dispatcher and the modal's close hook. Same split as
 * `describeProposalChip`: the matrix is reachable in a test, the
 * plumbing is not worth a DOM shim.
 */

/** Rows on the feedback textarea. Ten, because the operator asked for ten. */
export const REGENERATE_ROWS = 10;

/**
 * Class on the feedback textarea. Exported because it is also the
 * selector the modal's refresh uses to carry typed-but-unsent text
 * across a rebuild — two string literals that must not drift apart.
 */
export const REGENERATE_FEEDBACK_CLASS = 'requirement-modal__regenerate-feedback';

export interface RegenerateSectionSpec {
    readonly heading: string;
    readonly hint: string;
    readonly placeholder: string;
    readonly buttonLabel: string;
}

/**
 * How the regenerate section should read for a requirement in `status`,
 * or null when it should not render at all.
 *
 * Two statuses can regenerate and they mean different things:
 *
 *   `proposed`     a design exists and the operator wants a different one
 *   `architecting` the run produced nothing usable and is stuck
 *
 * Both bump the revision and re-spawn the agent, so the wording is the
 * only thing that tells the operator which case they are in — "Re-run"
 * on a stuck run, "Regenerate" on a design they have read and rejected.
 *
 * Every other status returns null. An `approved` requirement has already
 * fanned out into plans and a regenerate would strand them; an
 * `archived` one is closed. Rendering a button that would do damage is
 * worse than not offering it.
 */
export function describeRegenerateSection(status: string): RegenerateSectionSpec | null {
    if (status === 'architecting') {
        return {
            heading: 'Re-run the architect',
            hint: 'The run produced no usable proposal. Add any guidance for the retry, then re-run.',
            placeholder: 'Optional guidance for the re-run',
            buttonLabel: 'Re-run architect',
        };
    }
    if (status === 'proposed') {
        return {
            heading: 'Regenerate this design',
            hint: 'Say what should change. The architect reads this alongside the current design.',
            placeholder: 'Feedback for the architect (optional)',
            buttonLabel: 'Regenerate',
        };
    }
    return null;
}

/**
 * The revision a regenerate should be dispatched against.
 *
 * Always the next one: `RegenerateArchitecture` keys on it to decide
 * whether to re-spawn, so re-sending the current revision is a no-op
 * that looks to the operator like the button did nothing. Guards a
 * missing or nonsense revision to 1 → 2 rather than emitting NaN, which
 * would fail validation server-side with nothing useful on screen.
 */
export function nextRegenerateRevision(revision: number | null | undefined): number {
    if (typeof revision !== 'number' || !Number.isFinite(revision) || revision < 1) {
        return 2;
    }
    return Math.floor(revision) + 1;
}
