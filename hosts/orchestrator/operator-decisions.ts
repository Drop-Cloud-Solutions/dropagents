/**
 * Rendering + merge rules for the operator's clarification answers.
 *
 * An answer is a DECISION, not a message to one agent. When the
 * operator resolves a question that conflicts with the task statement,
 * that resolution has to outlive the step that asked it — otherwise the
 * reviewer measures the developer's work against a statement the
 * operator already overruled, and rejects correct work.
 *
 * The engine only threads the answer onto the step it resumes
 * (`humanAnswer` context). These helpers combine that step-scoped value
 * with the durable `task_clarifications` rows so every later step sees
 * the full set, and render it with explicit precedence wording.
 */

export interface ClarificationRecord {
    /** The agent's question, when it was captured at park time. */
    readonly question: string | null;
    readonly answer: string;
}

/**
 * Combine the durable rows with the step-scoped `humanAnswer`, in order,
 * without repeating an answer that appears in both.
 *
 * Both sources are used because their ordering is not guaranteed: the
 * ClarificationAnswered projection and the engine's resume dispatch
 * react to two different events, so the StartAgent that carries
 * `humanAnswer` may be built before the row lands. Taking the union
 * makes the prompt correct either way.
 */
export function mergeClarifications(
    stored: readonly ClarificationRecord[],
    humanAnswer?: string,
): ClarificationRecord[] {
    const out: ClarificationRecord[] = [];
    const seen = new Set<string>();
    for (const rec of stored) {
        const key = rec.answer.trim();
        if (key.length === 0 || seen.has(key)) continue;
        seen.add(key);
        out.push(rec);
    }
    const live = (humanAnswer ?? '').trim();
    if (live.length > 0 && !seen.has(live)) {
        out.push({ question: null, answer: humanAnswer!.trim() });
    }
    return out;
}

/**
 * Render the `# Human clarification` block.
 *
 * The heading is deliberately unchanged: every persona's shared
 * escape-hatch block promises the answer arrives "in a `HUMAN
 * CLARIFICATION` section at the top of TASK.md", and
 * `clarification-parser.ts` is the only other contract in this area.
 * What changes is the CONTENT — every answer given on the task, with
 * the precedence stated, instead of only the one the resumed step was
 * handed.
 *
 * Returns '' when there is nothing to render so callers can append
 * unconditionally. `headingPrefix` is '#' for the prompt and '##' for
 * TASK.md, where the block nests under the task title.
 */
export function renderClarificationBlock(
    records: readonly ClarificationRecord[],
    headingPrefix: '#' | '##' = '#',
): string {
    if (records.length === 0) return '';
    const lines: string[] = [`${headingPrefix} Human clarification`, ''];
    lines.push(
        'The operator was asked to decide the following, and answered.',
        'These answers are BINDING for this task: where one conflicts with',
        'the task description, the acceptance criteria, or the plan, the',
        "operator's answer wins. Do not re-open a settled question, and do",
        'not report work as wrong for following one.',
        '',
    );
    records.forEach((rec, i) => {
        const n = records.length > 1 ? `${i + 1}. ` : '';
        const question = (rec.question ?? '').trim();
        if (question.length > 0) {
            lines.push(`${n}**Q:** ${question}`);
            lines.push(`${n.length > 0 ? '   ' : ''}**A:** ${rec.answer.trim()}`);
        } else {
            lines.push(`${n}**Operator's answer:** ${rec.answer.trim()}`);
        }
        lines.push('');
    });
    return lines.join('\n').trimEnd();
}
