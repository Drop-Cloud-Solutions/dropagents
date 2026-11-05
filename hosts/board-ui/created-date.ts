/**
 * "created <date>" for the plan and task modals.
 *
 * Deliberately NOT `toLocaleDateString`. The board is read by people in
 * Europe and the tests run wherever CI puts them, and `4/7/2026` means
 * two different days on either side of the Atlantic — on a screen whose
 * whole purpose is judging how long a piece of work has been sitting,
 * that ambiguity is the one thing the date must not have. A spelled
 * month is unambiguous everywhere and tests the same on every machine.
 *
 * The year is dropped inside the current year, because most of what an
 * operator looks at was created this year and "4 Jul" carries all the
 * information "4 Jul 2026" does while taking half the width of a chips
 * row that already holds status, type and project.
 */

const MONTHS = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

/**
 * Format a creation timestamp for a modal's meta row.
 *
 * Returns null for anything that is not a usable epoch-ms number —
 * absent (a task whose `TaskCreated` event was pruned, a plan row
 * predating the fold), NaN, or a non-number off the wire. The caller
 * omits the line entirely rather than printing "Invalid Date" or
 * inventing today: a wrong date is worse than no date here, because it
 * is read as evidence of how long something has been waiting.
 *
 * `now` is injected so the this-year rule is testable without freezing
 * the system clock.
 */
export function formatCreatedDate(
    at: number | null | undefined,
    now: number = Date.now(),
): string | null {
    if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) return null;
    const d = new Date(at);
    if (Number.isNaN(d.getTime())) return null;
    const day = d.getDate();
    const month = MONTHS[d.getMonth()];
    if (month === undefined) return null;
    const year = d.getFullYear();
    const thisYear = new Date(now).getFullYear();
    return year === thisYear ? `${day} ${month}` : `${day} ${month} ${year}`;
}

/**
 * The chips-row piece, or null when there is no date to show.
 * Prefixed because a bare "4 Jul" next to a status and a project name
 * reads as just another tag.
 */
export function createdChip(
    at: number | null | undefined,
    now: number = Date.now(),
): string | null {
    const formatted = formatCreatedDate(at, now);
    return formatted === null ? null : `created ${formatted}`;
}

/**
 * Precise local timestamp for the element's `title`, so hovering gives
 * the exact time the compact form drops. Locale formatting is fine
 * HERE — it is a tooltip on the operator's own machine, not the label
 * the tests or another reader depend on.
 */
export function createdTooltip(at: number | null | undefined): string | null {
    if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) return null;
    const d = new Date(at);
    if (Number.isNaN(d.getTime())) return null;
    try {
        return `Created ${d.toLocaleString()}`;
    } catch {
        return `Created ${d.toISOString()}`;
    }
}
