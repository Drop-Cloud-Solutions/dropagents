/**
 * Folding `RepoRegistered` / `RepoUpdated` text fields into the board's
 * repo row.
 *
 * One rule, in one place, because having three was the bug.
 *
 * `UpdateRepo`'s handler fills absent fields with the empty string
 * (`name: cmd.payload.name ?? ''`), and the projection is written to
 * match: `name = COALESCE(NULLIF(@name, ''), name)` — an empty incoming
 * value means "unchanged", not "set to empty". The board's fold had the
 * `length > 0` guard on `url` and NOT on `name`, so an edit that changed
 * anything OTHER than the name blanked the name on screen while the
 * database kept it. Display-only, and still alarming: the operator sees
 * their repo lose its name.
 *
 * It was reachable before — editing only the default branch did it — but
 * only became the common case when "change just the GitHub account"
 * turned into a normal edit.
 */

/**
 * The value a folded text field should take.
 *
 * A non-empty incoming string wins. Anything else — absent, not a
 * string, or the empty string the handler sends for "unchanged" — keeps
 * what is already on the row, falling back to `fallback` for a row being
 * created rather than updated.
 *
 * Mirrors `COALESCE(NULLIF(@field, ''), field)` deliberately: the board
 * and the projection must agree, or the UI shows a value the database
 * does not hold and the edit form then offers to "restore" something
 * that never changed.
 */
export function foldRepoText(
    incoming: unknown,
    stored: string | undefined,
    fallback: string,
): string {
    if (typeof incoming === 'string' && incoming.length > 0) return incoming;
    return stored ?? fallback;
}

/**
 * The same rule for the nullable account column, where the empty string
 * is MEANINGFUL: it is how an Update clears the mapping.
 *
 * So this one cannot use {@link foldRepoText} — there, empty means
 * "unchanged"; here it means "cleared". The projection draws the same
 * distinction with a CASE rather than a COALESCE.
 */
export function foldRepoAccount(
    incoming: unknown,
    stored: string | null | undefined,
): string | null {
    if (typeof incoming === 'string') return incoming.length > 0 ? incoming : null;
    return stored ?? null;
}
