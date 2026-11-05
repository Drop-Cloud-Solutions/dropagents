/**
 * `mergeTaskPr`: try the merge now, and QUEUE it when the repo isn't
 * ready.
 *
 * Field report: "the auto merge is having some issues … but the pull
 * request has been created and is ready to merge. The suitsupply github
 * has checks that run when a push is done and also checks when a pull
 * request is done. Can that be the issue?"
 *
 * It was. `gh pr merge` DEMANDS the merge immediately, so on any repo
 * whose required checks run on the PR it failed every time — and the
 * message ("is not mergeable: the base branch policy prohibits the
 * merge") was then rewritten as a merge conflict, which sent a
 * merge-resolver agent at a branch with nothing to resolve.
 *
 * `--auto` hands the merge to GitHub to run when the checks pass, which
 * is what gh itself suggests in that very message.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { mergeTaskPr, type MergePrArgs } from './task-worktrees';

const silent = {
    info: (): void => undefined,
    warn: (): void => undefined,
    error: (): void => undefined,
    debug: (): void => undefined,
} as unknown as MergePrArgs['logger'];

const POLICY_BLOCK = new Error(
    'gh exited 1: Pull request #42 is not mergeable: the base branch policy '
    + 'prohibits the merge.\nTo have the pull request merged after all the '
    + 'requirements have been met, add the `--auto` flag.',
);

const CONFLICT = new Error(
    'gh exited 1: Pull request #42 is not mergeable: the merge commit cannot '
    + 'be cleanly created.',
);

interface Spawn {
    readonly cmd: string;
    readonly argv: readonly string[];
}

/**
 * `failures` maps a command shape to the error it throws:
 *   'merge'      the immediate `gh pr merge`
 *   'merge-auto' the `gh pr merge … --auto` retry
 */
function harness(failures: {
    merge?: Error;
    'merge-auto'?: Error;
} = {}): { args: MergePrArgs; spawns: Spawn[]; removed: string[] } {
    const spawns: Spawn[] = [];
    const removed: string[] = [];
    const args: MergePrArgs = {
        taskId: 'T-1',
        logger: silent,
        store: {
            get: () => ({ path: 'C:/ws/worktrees/T-1', prNumber: 42 }),
            repoPathForTask: () => 'C:/ws/repos/shop',
            removeOnDisk: async (id: string): Promise<void> => { removed.push(id); },
        },
        run: async (cmd, argv) => {
            spawns.push({ cmd, argv: [...argv] });
            const isMerge = argv[0] === 'pr' && argv[1] === 'merge';
            if (isMerge) {
                const key = argv.includes('--auto') ? 'merge-auto' : 'merge';
                const err = failures[key];
                if (err) throw err;
            }
            return { stdout: '', stderr: '' };
        },
    };
    return { args, spawns, removed };
}

const merges = (spawns: Spawn[]): Spawn[] =>
    spawns.filter((s) => s.argv[0] === 'pr' && s.argv[1] === 'merge');
const fetches = (spawns: Spawn[]): Spawn[] =>
    spawns.filter((s) => s.cmd === 'git' && s.argv[0] === 'fetch');

// --- the happy path is unchanged --------------------------------------

test('a merge that succeeds immediately does NOT use --auto', async () => {
    // Most repos can merge on the spot, and queueing a merge that could
    // have happened now would park the task for no reason.
    const h = harness();
    const result = await mergeTaskPr(h.args);

    assert.deepEqual(result, { ok: true });
    assert.equal(merges(h.spawns).length, 1, 'exactly one merge attempt');
    assert.ok(!merges(h.spawns)[0]!.argv.includes('--auto'));
    assert.equal(fetches(h.spawns).length, 1, 'the clone is fetched after a real merge');
});

// --- the field case ---------------------------------------------------

test('checks not yet passed -> the merge is QUEUED with --auto', async () => {
    const h = harness({ merge: POLICY_BLOCK });
    const result = await mergeTaskPr(h.args);

    assert.equal(result.ok, true, 'queueing is not a failure');
    assert.equal(result.enqueued, true, 'but it is NOT merged');
    const attempts = merges(h.spawns);
    assert.equal(attempts.length, 2, 'immediate attempt, then the queued one');
    assert.ok(!attempts[0]!.argv.includes('--auto'), 'immediate first');
    assert.ok(attempts[1]!.argv.includes('--auto'), 'then queued');
});

test('the queued attempt keeps the merge method and --delete-branch', async () => {
    // Dropping either would squash-merge a PR the operator asked to
    // rebase, or leave the branch behind.
    const h = harness({ merge: POLICY_BLOCK });
    await mergeTaskPr({ ...h.args, method: 'rebase' });

    const auto = merges(h.spawns)[1]!;
    assert.ok(auto.argv.includes('--rebase'));
    assert.ok(auto.argv.includes('--delete-branch'));
    assert.ok(!auto.argv.includes('--squash'));
});

test('a QUEUED merge does not fetch the clone', async () => {
    // Nothing has merged, so there is no merge commit to pull in. The
    // fetch belongs to whatever notices the merge landing.
    const h = harness({ merge: POLICY_BLOCK });
    await mergeTaskPr(h.args);

    assert.equal(fetches(h.spawns).length, 0);
});

test('the enqueued reason explains the wait in GitHub\'s own words', async () => {
    // It lands in the task's parked question, which is all the operator
    // sees on the card.
    const h = harness({ merge: POLICY_BLOCK });
    const result = await mergeTaskPr(h.args);

    assert.match(result.reason!, /#42/);
    assert.match(result.reason!, /base branch policy/, 'gh\'s reason survives');
    assert.match(result.reason!, /watching/i, 'and says nobody has to act');
});

// --- what must NOT be queued ------------------------------------------

test('a real conflict is never queued', async () => {
    // Waiting cannot clear a conflict. Queueing one would hide a PR
    // that needs a rebase behind an hour of polling.
    const h = harness({ merge: CONFLICT });
    const result = await mergeTaskPr(h.args);

    assert.equal(result.ok, false);
    assert.equal(result.enqueued, undefined);
    assert.equal(merges(h.spawns).length, 1, 'no --auto retry');
    assert.match(result.reason!, /conflict/i);
});

test('an auth or network failure is never queued', async () => {
    for (const raw of ['gh: Bad credentials (HTTP 401)', 'gh: not found on PATH']) {
        const h = harness({ merge: new Error(raw) });
        const result = await mergeTaskPr(h.args);

        assert.equal(result.ok, false, raw);
        assert.equal(merges(h.spawns).length, 1, raw);
        // The raw message passes through untouched — it is what the
        // operator pastes into a search.
        assert.equal(result.reason, raw);
    }
});

test('auto: false restores the demand-it-now behaviour', async () => {
    // An operator (or a flow) that wants the merge to fail loudly
    // rather than be queued keeps that option.
    const h = harness({ merge: POLICY_BLOCK });
    const result = await mergeTaskPr({ ...h.args, auto: false });

    assert.equal(result.ok, false);
    assert.equal(merges(h.spawns).length, 1);
});

// --- the repo refusing to queue ---------------------------------------

test('a repo with auto-merge switched off says which setting to flip', async () => {
    // "Allow auto-merge" is OFF by default, so this is the likely
    // outcome on a repo nobody has configured. The raw message is a
    // GraphQL mutation name and tells the operator nothing.
    const h = harness({
        merge: POLICY_BLOCK,
        'merge-auto': new Error(
            'GraphQL: Pull request Auto merge is not allowed for this '
            + 'repository (enablePullRequestAutoMerge)',
        ),
    });
    const result = await mergeTaskPr(h.args);

    assert.equal(result.ok, false);
    assert.equal(result.enqueued, undefined);
    assert.match(result.reason!, /Allow auto-merge/);
    assert.match(result.reason!, /required checks have not passed/);
});

test('an unexpected --auto failure surfaces its real message', async () => {
    // Never swallow: the operator needs the actual error, not a guess
    // about auto-merge settings.
    const h = harness({
        merge: POLICY_BLOCK,
        'merge-auto': new Error('gh: Bad credentials (HTTP 401)'),
    });
    const result = await mergeTaskPr(h.args);

    assert.equal(result.ok, false);
    assert.match(result.reason!, /Bad credentials/);
});

// --- the invariants that already held ---------------------------------

test('the worktree is torn down before any merge attempt', async () => {
    // gh's `--delete-branch` cleanup cannot delete a branch a worktree
    // still has checked out.
    const h = harness({ merge: POLICY_BLOCK });
    await mergeTaskPr(h.args);

    assert.deepEqual(h.removed, ['T-1']);
});

test('a task with no PR is refused without spawning anything', async () => {
    const h = harness();
    const result = await mergeTaskPr({
        ...h.args,
        store: { ...h.args.store, get: () => ({ path: 'p', prNumber: null }) },
    });

    assert.equal(result.ok, false);
    assert.equal(h.spawns.length, 0);
    assert.match(result.reason!, /no PR open/);
});

// --- the not-up-to-date block is queued too ---------------------------

test('"head branch is not up to date" is queued, not sent to the resolver', async () => {
    // Verbatim from the field: this failure dispatched a merge-resolver
    // agent at a PR that only needed its branch updated — which GitHub
    // does itself once auto-merge is on, and did, five minutes later.
    const h = harness({
        merge: new Error(
            'gh exited 1: X Pull request #42 is not mergeable: the head branch '
            + 'is not up to date with the base branch.\nTo have the pull request '
            + 'merged after all the requirements have been met, add the `--auto` flag.',
        ),
    });
    const result = await mergeTaskPr(h.args);

    assert.equal(result.enqueued, true);
    assert.ok(merges(h.spawns)[1]!.argv.includes('--auto'));
});

test('a stderr truncated past the --auto hint is still queued', async () => {
    // `runCommand` cut the Error at 200 characters, which landed inside
    // the hint. The classifier must not depend on a byte budget.
    const h = harness({
        merge: new Error(
            'X Pull request #42 is not mergeable: the head branch is not up to '
            + 'date with the base branch.\nTo have the pull request merged after '
            + 'all the requirements have been met, add the `-',
        ),
    });
    const result = await mergeTaskPr(h.args);

    assert.equal(result.enqueued, true, 'the truncated message must still queue');
});
