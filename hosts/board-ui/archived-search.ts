/**
 * Searching the archived-plans section.
 *
 * The archive grows forever and is browsed by recency — a 7-day window
 * extended a week per "Show older" click. That is right for "what did I
 * just archive" and useless for "where is that plan about loan capping",
 * which is the question an operator actually brings to an archive months
 * later.
 *
 * Project scoping is NOT handled here. The board already filters every
 * plan through `isVisibleForCurrentProject` before sectioning, so a
 * search inside a project page sees only that project's plans and a
 * search on All projects sees all of them — for free, and consistently
 * with every other section. Re-implementing it here would be a second
 * copy that could disagree.
 */

/** What a plan contributes to the search. */
export interface SearchablePlan {
    readonly planId: string;
    readonly title: string | null;
    /** The brief markdown, when the projection carried one. */
    readonly body: string | null;
    readonly metadata?: Readonly<Record<string, unknown>> | undefined;
}

/**
 * Split a raw query into terms.
 *
 * Whitespace-separated, lowercased, order-independent. Returns an empty
 * array for a blank query, which callers read as "not searching" — the
 * distinction matters because an empty query must restore the recency
 * window rather than match everything in a flat list.
 */
export function queryTerms(raw: string | null | undefined): string[] {
    if (typeof raw !== 'string') return [];
    return raw
        .toLowerCase()
        .split(/\s+/)
        .map((t) => t.trim())
        .filter((t) => t.length > 0);
}

/**
 * The text a query is matched against: the plan's title, its id, its
 * brief, and its plan type.
 *
 * The brief is included because that is where the topic actually lives —
 * titles get shortened ("Import fixes") while the brief names the thing
 * ("FW26 loan capping CSV"). The id is included because operators quote
 * ids to each other and pasting one into a search box should find it.
 *
 * Not searched: the generated implementation plan and the task list.
 * Neither is held client-side — the board fetches them per plan on
 * demand — so including them would mean a request per archived plan per
 * keystroke. Worth doing server-side if the brief turns out not to be
 * enough.
 */
export function planHaystack(plan: SearchablePlan): string {
    const planType = plan.metadata?.planType;
    return [
        plan.title ?? '',
        plan.planId,
        plan.body ?? '',
        typeof planType === 'string' ? planType : '',
    ].join('\n').toLowerCase();
}

/**
 * Does this plan match every term?
 *
 * AND rather than OR: two words typed into a search box mean "both of
 * these", and OR on a long brief matches almost everything, which reads
 * as the filter being broken. Substring rather than whole-word, so
 * "capping" finds "loan-capping" and a half-typed word narrows as you go.
 */
export function planMatches(plan: SearchablePlan, terms: readonly string[]): boolean {
    if (terms.length === 0) return true;
    const haystack = planHaystack(plan);
    return terms.every((t) => haystack.includes(t));
}

/**
 * Filter plans by a raw query string. A blank query returns the input
 * untouched (same array contents, so the caller's windowing still
 * applies).
 */
export function filterPlansByQuery<T extends SearchablePlan>(
    plans: readonly T[],
    raw: string | null | undefined,
): T[] {
    const terms = queryTerms(raw);
    if (terms.length === 0) return plans.slice();
    return plans.filter((p) => planMatches(p, terms));
}

/** Is the operator searching? Drives whether the recency window applies. */
export function isSearching(raw: string | null | undefined): boolean {
    return queryTerms(raw).length > 0;
}
