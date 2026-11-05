/**
 * Universal AGENT_QUESTION / NEEDS_HUMAN_INPUT parser (AP-IFW-002).
 *
 * Ported from `pipeline/shared/parse-clarification.ts`. Detects the
 * NEEDS_HUMAN_INPUT escape hatch in any agent's final output. Every
 * retained role (developer / reviewer / tester / committer / doc-writer /
 * investigator / echo + the seven Track-1 ports) can emit this block to
 * park the task and surface a question to the operator instead of guessing.
 *
 * Canonical format emitted by agents (single source of truth lives at
 * `agents/_shared/clarification-block.md`):
 *
 *   NEEDS_HUMAN_INPUT
 *   Question: <one sentence>
 *   Options:
 *     A) first option — short description
 *     B) second option
 *     C) cancel the task
 *
 * Loose match so small prompt drift doesn't break detection:
 *   - Marker is case-insensitive and may have optional surrounding markdown
 *     (e.g. "## NEEDS_HUMAN_INPUT" or "**NEEDS_HUMAN_INPUT**").
 *   - The marker does NOT have to start a line. It used to, and that cost
 *     an operator a whole task: the committer on T-PKG-005 emitted a
 *     textbook block, but the step summary concatenates the agent's
 *     assistant text blocks with no separator, so what reached this
 *     parser was "...and create the commit.NEEDS_HUMAN_INPUT". The
 *     leading-newline anchor missed it, the step counted as success, the
 *     flow advanced to merge, and the task parked at wait-merged with a
 *     question nobody could answer (the board only offers Answer for
 *     reason='clarification'). A swallowed question is the worst failure
 *     this parser has, so the leading anchor is now any non-word
 *     character.
 *   - "Question:" and "Options:" labels are case-insensitive.
 *   - Option letters may be A/B/C…, 1/2/3…, lowercase, and the separator
 *     after the label may be `)`, `.`, `-`, or `:`.
 *   - Everything after the first non-option section heading is discarded.
 */

export interface ClarificationOption {
  /** Normalised letter (`A`, `B`, …) or number as-is. */
  readonly key: string;
  /** Human-facing one-liner. */
  readonly label: string;
}

export interface Clarification {
  readonly question: string;
  readonly options: readonly ClarificationOption[];
  /**
   * The full block as the agent wrote it. The board renders this verbatim
   * in the action modal so the operator sees the original wording (not a
   * reformatted version).
   */
  readonly raw: string;
}

/**
 * The marker, anchored on a non-word character (or start of input) rather
 * than a newline — see the note above on the glued-concatenation field
 * case.
 *
 * The TRAILING side stays strict: the marker must still be the last thing
 * on its line. That is what keeps prose ABOUT the escape hatch from
 * tripping it — "emit NEEDS_HUMAN_INPUT as your final message" has text
 * after it on the line and does not match — and a false positive here
 * parks a healthy task.
 */
const MARKER_RE =
  /(?:^|[^A-Za-z0-9_])\s*[#*`]*\s*needs[_ ]human[_ ]input\s*[#*`]*\s*(?:\n|$)/i;

/**
 * Re-join hard-wrapped lines: single newlines collapse to a space,
 * blank lines survive as one paragraph break, runs of spaces collapse.
 */
function unwrapLines(text: string): string {
  return text
    .split(/\n\s*\n/)
    .map((para) => para.split('\n').map((l) => l.trim()).filter((l) => l.length > 0).join(' '))
    .filter((para) => para.length > 0)
    .join('\n\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

export function parseClarification(agentOutput: string): Clarification | null {
  if (!agentOutput) return null;
  const mStart = agentOutput.match(MARKER_RE);
  if (!mStart) return null;
  const start = (mStart.index ?? 0) + mStart[0].length;
  const body = agentOutput.slice(start);

  const questionMatch = body.match(/^\s*question\s*:\s*(.+?)(?:\n|$)/i);
  if (!questionMatch) return null;

  const optionsIdx = body.search(/\n\s*options\s*:/i);

  // The question runs from the "Question:" label to the "Options:" label
  // (or end of block). Models hard-wrap long questions across several
  // lines — the old first-line-only capture cut the operator's Answer
  // modal off mid-sentence (field case: a multi-line stash-collision
  // question showed only its first fragment). Join the wrapped lines
  // back into one sentence; blank lines become paragraph breaks.
  const questionStart = (body.match(/^\s*question\s*:\s*/i)?.[0] ?? '').length;
  const questionRegion =
    optionsIdx >= 0 ? body.slice(questionStart, optionsIdx) : body.slice(questionStart);
  const question = unwrapLines(questionRegion);
  if (question.length === 0) return null;

  const optionsBlock =
    optionsIdx >= 0
      ? body.slice(optionsIdx).replace(/\n\s*options\s*:/i, '')
      : '';

  const options: ClarificationOption[] = [];
  if (optionsBlock) {
    const lines = optionsBlock.split('\n');
    for (const line of lines) {
      const lm = line.match(
        /^\s*(?:[-*]\s*)?([A-Za-z]|\d{1,2})\s*[).\-:]\s*(.+?)\s*$/,
      );
      if (lm) {
        const key = lm[1].toUpperCase();
        if (options.some((o) => o.key === key)) continue;
        options.push({ key, label: lm[2].trim() });
        continue;
      }
      if (options.length > 0 && /^\s*(?:#|\*\*|---|===)/.test(line)) break;
      // Continuation of a hard-wrapped option: a non-empty line that
      // doesn't start a new option or section belongs to the PREVIOUS
      // option — the old parser silently dropped these, truncating the
      // option text the operator saw.
      const cont = line.trim();
      if (options.length > 0 && cont.length > 0) {
        const last = options[options.length - 1];
        options[options.length - 1] = { key: last.key, label: `${last.label} ${cont}` };
      }
    }
  }

  const rawEnd =
    optionsIdx >= 0
      ? body.slice(0, optionsIdx).length + optionsBlock.length
      : questionMatch[0].length;
  const raw = agentOutput.slice(mStart.index ?? 0, start + rawEnd).trim();

  return { question, options, raw };
}

/**
 * Cheap pre-check: does this output look like it carries a clarification
 * block? Used after the dev/review/test stages to short-circuit the
 * happy path — a task with NEEDS_HUMAN_INPUT should park, not advance.
 */
export function outputHasClarification(agentOutput: string): boolean {
  return MARKER_RE.test(agentOutput || '');
}
