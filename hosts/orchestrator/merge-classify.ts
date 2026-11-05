/**
 * Why a `gh pr merge` failed — and whether `--auto` is the answer.
 *
 * Field report: "the auto merge is having some issues … but the pull
 * request has been created and is ready to merge. The suitsupply github
 * has checks that run when a push is done and also checks when a pull
 * request is done. Can that be the issue?"
 *
 * Yes. `gh pr merge` demands the merge NOW. On a repo with required
 * status checks the merge is refused until those checks pass, and gh
 * says:
 *
 *   X Pull request #42 is not mergeable: the base branch policy
 *     prohibits the merge.
 *   To have the pull request merged after all the requirements have
 *     been met, add the `--auto` flag.
 *
 * Two things went wrong with that message. The pipeline reported it as
 * a merge CONFLICT — `isMergeConflictFailure` matched on `not
 * mergeable`, which both failures contain — and so dispatched a
 * merge-resolver agent at a PR with nothing to resolve. And it never
 * took gh's own advice.
 *
 * The distinction is exact in gh's output, so it is drawn here rather
 * than guessed at by the callers:
 *
 *   requirements  "the base branch policy prohibits the merge"
 *                 → wait. `--auto` enqueues the merge with GitHub,
 *                   which lands it when the checks pass.
 *   conflict      "the merge commit cannot be cleanly created"
 *                 → a human or the merge-resolver agent must rebase.
 *
 * Both start with "is not mergeable", which is why a substring test on
 * that phrase alone cannot be trusted.
 */

/**
 * The PR cannot merge YET because the repo's own requirements are not
 * satisfied — checks pending or failing, a required review missing, a
 * merge queue in front of it.
 *
 * Nothing about the branch is wrong, so retrying immediately fails the
 * same way. This is the shape `--auto` exists for.
 */
const REQUIREMENTS_PATTERNS: ReadonlyArray<RegExp> = [
    // gh's own wording for a protected base branch, and the hint it
    // prints directly underneath it.
    /base branch policy prohibits the merge/i,
    /add the `?--auto`? flag/i,
    // "Require branches to be up to date before merging". NOT a
    // conflict: GitHub updates the branch itself once auto-merge is
    // on, which is exactly what happened in the field - the resolver
    // agent was asking the operator for help while GitHub quietly
    // merged the PR.
    //
    // Matched on its own wording rather than on the `--auto` hint that
    // follows it, because that hint sat just past the stderr
    // truncation and so was invisible here. Belt and braces: the
    // truncation is fixed too.
    /head branch is not up to date/i,
    /not up to date with the base branch/i,
    // The ruleset wrapper GitHub puts around all of the above.
    // Rulesets are policy; a content conflict never arrives this way.
    /repository rule violations/i,
    // The GraphQL layer's variants, seen when gh passes the API error
    // through instead of formatting it.
    /required status check/i,
    /expected status check/i,
    /changes? requested/i,
    /review(s)? required/i,
    /at least \d+ approving review/i,
    // mergeStateStatus=UNSTABLE/BLOCKED — checks still running or red.
    /unstable state/i,
    /merge queue/i,
    /protected branch/i,
];

/** The branch itself conflicts with the base — somebody must rebase. */
const CONFLICT_PATTERNS: ReadonlyArray<RegExp> = [
    /merge commit cannot be cleanly created/i,
    /resolve the merge conflicts/i,
    /merge conflict/i,
    /conflicts? must be resolved/i,
    /\bCONFLICT\b/,
];

/**
 * Is this failure the "requirements not met yet" kind?
 *
 * Checked BEFORE the conflict patterns by every caller, because a
 * requirements block also says "is not mergeable" and a conflict-shaped
 * reading of it sends an agent to resolve a conflict that does not
 * exist.
 */
export function isMergeBlockedByRequirements(
    raw: string | undefined | null,
): boolean {
    if (!raw) return false;
    // An explicit conflict wins: if gh named the conflict, waiting for
    // checks will never clear it.
    if (CONFLICT_PATTERNS.some((re) => re.test(raw))) return false;
    return REQUIREMENTS_PATTERNS.some((re) => re.test(raw));
}

/**
 * Did `gh pr merge --auto` fail because the REPO does not allow
 * auto-merge?
 *
 * Auto-merge is a repository setting ("Allow auto-merge" in Settings →
 * General) that is OFF by default. With it off the mutation is rejected
 * outright, and the operator needs to be told which switch to flip
 * rather than reading a GraphQL mutation name.
 */
export function isAutoMergeUnavailable(
    raw: string | undefined | null,
): boolean {
    if (!raw) return false;
    return /auto.?merge is not allowed/i.test(raw)
        || /auto.?merge is not enabled/i.test(raw)
        || /enablePullRequestAutoMerge/i.test(raw)
        || /can'?t? (?:not )?enable auto.?merge/i.test(raw);
}

/** Operator-facing note for a merge GitHub has accepted but not run. */
export function describeMergeEnqueued(
    prNumber: number,
    blockedReason: string,
): string {
    return `PR #${prNumber} is queued for auto-merge: GitHub will merge it`
        + ' as soon as the required checks pass. The pipeline is watching and'
        + ' will finish the task on its own; Merge PR stays available if you'
        + ` want to force it sooner. GitHub's reason for waiting:`
        + ` ${blockedReason.trim().slice(0, 200)}`;
}

/**
 * Operator-facing reason for a `--auto` attempt the repo refuses.
 *
 * Names the setting, because the raw message is a GraphQL mutation name
 * and tells the operator nothing they can act on.
 */
export function describeAutoMergeUnavailable(
    prNumber: number,
    raw: string,
): string {
    return `PR #${prNumber} cannot merge yet (its required checks have not`
        + ' passed) and this repository does not allow auto-merge, so the'
        + ' merge cannot be queued either. Turn on "Allow auto-merge" in the'
        + ' repository settings, or merge from GitHub once the checks go'
        + ` green. GitHub said: ${raw.trim().slice(0, 200)}`;
}

/** Operator-facing note for an enqueued merge the pipeline gave up on. */
export function describeMergeAbandoned(
    prNumber: number,
    detail: string,
): string {
    return `PR #${prNumber} was queued for auto-merge but has not merged.`
        + ` ${detail.trim()}`
        + ' The task stays parked — merge it from GitHub or click Merge PR'
        + ' again once its checks are green.';
}
