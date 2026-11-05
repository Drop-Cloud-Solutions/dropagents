/**
 * Which document sections the plan modal shows.
 *
 * It used to show one: the planner's implementation plan once it
 * existed, and the operator's brief only until then — "render that in
 * place of the operator's original brief", as the code said. So the
 * moment a plan went Ready, the request it was built from disappeared
 * from the one screen where you decide whether the plan answers it.
 *
 * Both now render, request first. Reading order is input then output,
 * which is the order you check them in: "this is what I asked for, this
 * is what came back."
 */

export interface PlanBodySection {
    /** Heading shown above the markdown. */
    readonly heading: string;
    /** Markdown to render. Never empty. */
    readonly markdown: string;
    /**
     * Stable class suffix, so the two sections can be styled and
     * targeted apart (the brief is reference material; the plan is the
     * thing under review).
     */
    readonly kind: 'request' | 'plan';
}

/**
 * Build the section list for a plan.
 *
 * `plannerOutput` is the generated implementation plan (the latest
 * plan-review revision), `brief` the operator's original request.
 * Either may be absent: a Draft plan has no plan yet, and a plan
 * created by a path that recorded no brief has none to show.
 *
 * "Original request" rather than "Brief" deliberately. `Brief` is this
 * project's internal word for it — it is the `# Brief` header in the
 * planner prompt — but the operator looking for it called it their
 * original request, and this is the screen where they go looking. One
 * word of vocabulary drift costs less than a section nobody recognises.
 */
export function planBodySections(
    plannerOutput: string | null | undefined,
    brief: string | null | undefined,
): PlanBodySection[] {
    const sections: PlanBodySection[] = [];
    const requestText = text(brief);
    const planText = text(plannerOutput);

    if (requestText !== null) {
        sections.push({
            heading: 'Original request',
            markdown: requestText,
            kind: 'request',
        });
    }
    if (planText !== null) {
        sections.push({
            heading: 'Implementation plan',
            markdown: planText,
            kind: 'plan',
        });
    }
    return sections;
}

/**
 * Is the request worth collapsing by default?
 *
 * A two-line request reads better open; a pasted page of requirements
 * would push the plan — the thing actually under review — off the
 * screen. The threshold is on LINES rather than characters because what
 * costs vertical space is lines, and a long single paragraph wraps to
 * far fewer than its character count suggests.
 */
export const REQUEST_COLLAPSE_LINES = 12;

export function shouldCollapseRequest(brief: string | null | undefined): boolean {
    const requestText = text(brief);
    if (requestText === null) return false;
    return requestText.split(/\r?\n/).length > REQUEST_COLLAPSE_LINES;
}

function text(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    return value.trim().length > 0 ? value : null;
}
