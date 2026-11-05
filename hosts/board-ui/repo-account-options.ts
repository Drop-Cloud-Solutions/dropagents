/**
 * The options in a repo's GitHub-account picker.
 *
 * Extracted from the DOM builder because one case here is a trap with an
 * expensive failure: a repo mapped to an account that is no longer
 * declared. If the select has no option for that id, the browser falls
 * back to the first option — the empty "Default" — and the next Save
 * sends `githubAccount: ''`, which CLEARS the mapping the operator came
 * to look at. Silently, on a form they may have opened only to rename
 * the repo.
 *
 * So a stored-but-undeclared id gets its own option, labelled as such.
 */

export interface RepoAccountOption {
    /** Submitted value. `''` is the default (ambient) identity. */
    readonly value: string;
    readonly label: string;
}

export interface RepoAccountPicker {
    readonly options: readonly RepoAccountOption[];
    /** What the select should be set to once the options exist. */
    readonly selected: string;
    /**
     * False when the control should not render at all: nothing declared
     * AND this repo is unmapped. An install with one GitHub account
     * should not grow a control whose only choice is "default".
     */
    readonly visible: boolean;
}

/** Label for the empty option — the machine's own `gh` login. */
export const DEFAULT_ACCOUNT_LABEL = 'Default (machine gh login)';

/**
 * Build the picker for `current` against the `declared` account ids.
 *
 * `current` is the repo's stored account: null / '' for unmapped.
 */
export function repoAccountPicker(
    declared: readonly string[],
    current: string | null | undefined,
): RepoAccountPicker {
    const mapped = typeof current === 'string' && current.length > 0 ? current : null;
    if (declared.length === 0 && mapped === null) {
        return { options: [], selected: '', visible: false };
    }
    const options: RepoAccountOption[] = [
        { value: '', label: DEFAULT_ACCOUNT_LABEL },
        ...declared.map((id) => ({ value: id, label: id })),
    ];
    if (mapped !== null && !declared.includes(mapped)) {
        // Keeps the stored value round-trippable, and says why it looks
        // odd. The operator can then either declare the account again or
        // deliberately choose Default.
        options.push({ value: mapped, label: `${mapped} (not declared)` });
    }
    return { options, selected: mapped ?? '', visible: true };
}

/**
 * Should an Update carry `githubAccount`, and as what?
 *
 * Returns null when the selection did not change, so the PATCH omits the
 * field — on an Update an omitted account leaves the mapping alone.
 * Returns `''` when the operator moved a mapped repo back to Default,
 * which is how a mapping is CLEARED. Those two cannot be collapsed: one
 * means "don't touch", the other means "remove".
 */
export function accountUpdateValue(
    selected: string,
    stored: string | null | undefined,
): string | null {
    const before = typeof stored === 'string' ? stored : '';
    return selected === before ? null : selected;
}
