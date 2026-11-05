/**
 * Every agent the pipeline spawns must carry the repo's GitHub account.
 *
 * Agents run git and gh THEMSELVES — the developer commits, the
 * committer pushes, the merge-resolver fetches and rebases, the
 * scaffolder clones — so unlike the pipeline's own calls there is no
 * call site to hand a credential to. It has to be on the child process.
 *
 * Field report, from the merge-resolver agent itself: "The worktree
 * can't reach GitHub (git fetch: 'Repository not found', likely a
 * credential/access problem) … How should I proceed?" The task agents
 * had been threaded; the resolver's own spawn had not, so the agent sent
 * to fix a merge could not read the branch it was sent to fix.
 *
 * `AgentSpec.env` is optional by design (absent means the ambient
 * identity, correct for an install with no accounts), so a spawn that
 * forgets it compiles and passes every unit test of the thing being
 * spawned. Only the source text catches it — the same approach as
 * `github-account-wiring.test.ts`, and for the same reason.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const HANDLERS = fs.readFileSync(path.join(__dirname, 'handlers.ts'), 'utf8');
const RESOLVER = fs.readFileSync(
    path.join(__dirname, 'merge-conflict-resolver.ts'),
    'utf8',
);
const MAIN = fs.readFileSync(path.join(__dirname, 'main.ts'), 'utf8');

/**
 * The spawns, and what each agent does with the remote — because "must
 * pass env" alone tells a future reader nothing about the cost.
 */
const SPAWNS = [
    {
        what: 'task agents (StartAgent)',
        source: HANDLERS,
        why: 'the developer commits and the committer pushes',
    },
    {
        what: 'plan agents (planner / decomposer / architect)',
        source: HANDLERS,
        why: 'a planner reads the repo it is planning against, which may be private',
    },
    {
        what: 'the merge-conflict resolver',
        source: RESOLVER,
        why: 'it fetches the base branch, merges, and pushes — without the '
            + 'account it cannot even see the commits it was sent to rebase',
    },
] as const;

/**
 * Every `agentRunner.start(...)` in a file, as the text of the
 * surrounding statement — enough to see whether a spec with `env` was
 * built for it.
 */
function spawnContexts(source: string): string[] {
    const out: string[] = [];
    const needle = 'agentRunner.start(';
    let from = 0;
    for (;;) {
        const at = source.indexOf(needle, from);
        if (at < 0) break;
        // Back up far enough to include the spec literal, whether it is
        // inline or assigned to a `const spec` just above.
        out.push(source.slice(Math.max(0, at - 1400), at + 400));
        from = at + needle.length;
    }
    return out;
}

test('every spawn site is found', () => {
    // Guards the test: a rename that made the search miss a spawn would
    // make its assertion pass vacuously.
    for (const spawn of SPAWNS) {
        assert.ok(
            spawnContexts(spawn.source).length > 0,
            `no agentRunner.start found for ${spawn.what} — did it move?`,
        );
    }
    // handlers.ts holds exactly the two spawns named above. A third
    // appearing here should be added to SPAWNS, not ignored.
    assert.equal(
        spawnContexts(HANDLERS).length,
        2,
        'handlers.ts should hold the task spawn and the plan spawn',
    );
});

test('EVERY agent spawn builds its spec with the account env', () => {
    for (const spawn of SPAWNS) {
        for (const [i, ctx] of spawnContexts(spawn.source).entries()) {
            assert.match(
                ctx,
                /env:\s*githubEnv/,
                `${spawn.what} spawn #${i + 1} must pass env: githubEnv — ${spawn.why}`,
            );
        }
    }
});

test('an EMPTY overlay is not passed as an explicit empty env', () => {
    // `{}` means "no account declared", which must leave the child on
    // the ambient identity rather than spawning it with a deliberately
    // empty environment.
    for (const spawn of SPAWNS) {
        for (const ctx of spawnContexts(spawn.source)) {
            assert.match(
                ctx,
                /Object\.keys\(githubEnv\)\.length > 0/,
                `${spawn.what} must only set env when the overlay is non-empty`,
            );
        }
    }
});

// --- the wiring behind them ------------------------------------------

test('the resolver is constructed WITH a task account resolver', () => {
    // The dep is optional, so a construction that forgets it compiles
    // and silently reverts the fix.
    const at = MAIN.indexOf('new MergeConflictResolver({');
    assert.notEqual(at, -1, 'the resolver construction must exist');
    const args = MAIN.slice(at, MAIN.indexOf('});', at));
    assert.match(
        args,
        /githubEnvForTask:/,
        'MergeConflictResolver must be given githubEnvForTask — its agent runs '
        + 'git against the remote',
    );
});

test('the plan resolver goes through the shared repoId rule', () => {
    // One place a repo becomes an environment, so the plan path and the
    // task path cannot disagree about which account owns a repo.
    const at = MAIN.indexOf('githubEnvForPlan:');
    assert.notEqual(at, -1, 'plan-scoped agents must get an account resolver');
    assert.match(
        MAIN.slice(at, at + 240),
        /githubEnvForRepoId\(/,
        'githubEnvForPlan should resolve through githubEnvForRepoId',
    );
});
