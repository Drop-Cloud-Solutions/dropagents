/**
 * Source-level contract helper, shared by the wiring tests.
 *
 * Several deps in this codebase are optional BY DESIGN — an absent
 * `resolveGithubEnv` / `githubEnvForRepo` means "use the machine's
 * ambient GitHub identity", which is correct for an install that has
 * declared no accounts. That makes a construction which simply forgets
 * one invisible to the compiler and to every unit test of the thing
 * being constructed: the collaborator is correct, the wiring is not.
 *
 * Both halves of that bug shipped (see `repo-sync-wiring.test.ts`), so
 * the wiring is asserted against the source text instead.
 */

/**
 * The text of each `<factory>({ ... })` call in `source`.
 *
 * Walks braces from the opening one rather than matching to the first
 * `}`, so a nested object literal cannot end the match early — which
 * would hide exactly the option being looked for.
 */
export function callArguments(source: string, factory: string): string[] {
    const out: string[] = [];
    const needle = `${factory}({`;
    let from = 0;
    for (;;) {
        const start = source.indexOf(needle, from);
        if (start < 0) break;
        let depth = 0;
        let i = start + factory.length + 1;
        for (; i < source.length; i += 1) {
            const ch = source[i];
            if (ch === '{') depth += 1;
            else if (ch === '}') {
                depth -= 1;
                if (depth === 0) break;
            }
        }
        out.push(source.slice(start, i + 1));
        from = i + 1;
    }
    return out;
}
