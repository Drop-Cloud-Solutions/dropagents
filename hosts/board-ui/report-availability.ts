/**
 * Is there a REPORT to read for a task — the predicate behind the
 * View-report button.
 *
 * Field incident: the button rendered on every task in a terminal-ish
 * state, including while the reviewer/tester agent was still running,
 * and for task types that never produce a report. It never failed
 * visibly either — with nothing recorded the modal opened on a
 * "No report has been recorded" placeholder, so the affordance read as
 * broken. Two independent gates fix that: the task TYPE must be one
 * whose deliverable is a report, and a report must actually exist.
 *
 * Pure + separately testable (same pattern as `task-tags.ts` /
 * `task-projection.ts`): `board.ts` is the browser wiring, this is the
 * rule.
 */

/**
 * Types whose deliverable IS an operator-readable report.
 *
 * This used to be a hardcoded set, and it named two of the dotnet-azure
 * pack's types (`review-azure`, `diagnose-azure`) inside core — so core
 * knew a stack's type ids, and a pack could not add a report type at all.
 * The flows declare it now (`task_type.produces_report`) and the board
 * fills this set from `GET /api/task-types` at boot.
 *
 * It starts as CORE's own types so the View-report button is already
 * correct on first paint, before hydration lands. The set object is
 * mutated in place rather than rebound: `board.ts` re-exports it and
 * several callers read it, and a live view keeps all of them honest.
 */
const reportTaskTypes = new Set<string>([
    'investigate',
    'review-codebase',
    'code-review',
]);

/** Live read-only view. Reflects hydration. */
export const REPORT_TASK_TYPES: ReadonlySet<string> = reportTaskTypes;

/**
 * Replace the report-producing types with what this install actually runs
 * (core + enabled packs), from the task-type catalog.
 *
 * An empty or unusable list is IGNORED. A failed or half-parsed
 * `/api/task-types` must not turn every View-report button off across the
 * board — silently losing an affordance is the exact failure this module
 * was written to end.
 */
export function setReportTaskTypes(ids: Iterable<string>): void {
    const next = [...ids].filter((id) => typeof id === 'string' && id.length > 0);
    if (next.length === 0) return;
    reportTaskTypes.clear();
    for (const id of next) reportTaskTypes.add(id);
}

/**
 * Roles whose recorded step summary is a report. Role-based on purpose:
 * matching a step merely NAMED `review` also matched the reviewer step
 * that every code-writing flow has, so an implement task could surface
 * its reviewer's notes as an "investigation report". `code-review`'s
 * reviewer step still qualifies — via REPORT_TASK_TYPES, not the role.
 *
 * Only CORE roles are listed. A pack's report step is recognised by its
 * step id (see REPORT_STEPS) — `azure-reviewer` runs a step called
 * `review` and `azure-diagnostician` one called `diagnose` — so naming
 * those roles here bought nothing and put stack knowledge in core.
 */
export const REPORT_ROLES: ReadonlySet<string> = new Set([
    'investigator',
    'codebase-reviewer',
]);

/** Step ids that carry a report inside a report-producing flow. */
export const REPORT_STEPS: ReadonlySet<string> = new Set([
    'investigator',
    'investigate',
    'diagnose',
    'review',
]);

export interface ReportStepLike {
    readonly stepId: string;
    readonly role?: string | null;
    readonly summary?: string | null;
    readonly finishedAt?: number | null;
}

/** Newest step record carrying a non-empty report summary, if any. */
export function pickReportStep<T extends ReportStepLike>(
    steps: Iterable<T> | undefined,
): T | undefined {
    if (!steps) return undefined;
    return [...steps]
        .filter((r) => REPORT_ROLES.has(r.role ?? '') || REPORT_STEPS.has(r.stepId))
        .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))
        .find((r) => (r.summary ?? '').length > 0);
}

export function taskTypeProducesReport(type: string | null | undefined): boolean {
    return REPORT_TASK_TYPES.has(type ?? '');
}

/**
 * The button predicate. `hasProjectionReport` is the board's
 * InvestigationCompleted map; `steps` are the hydrated step records.
 */
export function hasReadableReport(args: {
    readonly type: string | null | undefined;
    readonly hasProjectionReport: boolean;
    readonly steps?: Iterable<ReportStepLike> | undefined;
}): boolean {
    if (!taskTypeProducesReport(args.type)) return false;
    if (args.hasProjectionReport) return true;
    return pickReportStep(args.steps) !== undefined;
}
