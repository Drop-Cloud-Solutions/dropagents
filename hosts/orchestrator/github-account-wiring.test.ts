/**
 * Every surface that touches a GitHub remote has to be WIRED to the
 * repo's account, not merely capable of it.
 *
 * Field report: "the auto-merge is having some issues, it says there is
 * a problem with the credentials (The worktree can't access
 * https://github.com/…/DescartesAPI.git ("Repository not found", most
 * likely credentials))" — on a repo that exists, with a PR already open
 * on it. GitHub does not leak the existence of a repo an identity
 * cannot see, so a wrong credential and a deleted repo produce the SAME
 * message.
 *
 * The account threading was done call site by call site, and each site
 * that was missed cost its own incident:
 *
 *   repo clone/fetch   missed `createRepoRefreshTrigger` -> Sync failed
 *   worktree freshen   missed entirely -> the auto-merge above
 *
 * The remaining sites are covered here BEFORE they produce a third.
 * Every one of these deps is optional by design (absent means the
 * ambient identity, right for an install with no accounts), so a
 * forgotten wiring compiles, passes every unit test of the collaborator,
 * and fails in the field as a repo that "does not exist". Only the
 * source text can catch it.
 *
 * See `repo-sync-wiring.test.ts` for the two repo-sync factories.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { callArguments } from './call-arguments.testlib';

const ORCHESTRATOR_MAIN = fs.readFileSync(path.join(__dirname, 'main.ts'), 'utf8');
const WORKER_MAIN = fs.readFileSync(
    path.join(__dirname, '..', 'worker-api', 'main.ts'),
    'utf8',
);

/**
 * One row per construction that ends in a git/gh call against a remote.
 *
 * `option` is the dep that carries the account; `why` is the failure the
 * operator sees when it is absent, because a bare "must pass X" gives a
 * future reader nothing to reason with.
 */
const SURFACES = [
    {
        what: 'DeployWorktreeStore',
        source: ORCHESTRATOR_MAIN,
        factory: 'new DeployWorktreeStore',
        option: 'githubEnvForRepo',
        why: 'the shared deploy worktree runs its own `git fetch origin`; without '
            + 'the account a private repo fails as "Repository not found" and the '
            + 'deploy falls back to a cold per-task worktree',
    },
    {
        what: 'chat router (scratch-edit Open PR)',
        source: WORKER_MAIN,
        factory: 'createChatRouter',
        option: 'githubEnvForRepo',
        why: 'a scratch-edit chat pushes its branch and runs `gh pr create`; '
            + 'without the account both run as the ambient identity',
    },
    {
        what: 'architecture design-doc commit',
        source: ORCHESTRATOR_MAIN,
        factory: 'commitDesignDoc',
        option: 'githubEnv',
        why: 'the design doc is pushed to the architecture repo, and that path is '
            + 'best-effort — a credential failure is a log line nobody reads and '
            + 'the doc silently never lands',
    },
] as const;

test('every remote-touching construction is present in the source', () => {
    // Guards the test itself: a rename that made the search miss a call
    // site would make its assertion pass vacuously, which is precisely
    // how the original gap stayed invisible.
    for (const surface of SURFACES) {
        assert.ok(
            callArguments(surface.source, surface.factory).length > 0,
            `${surface.factory} not found — did it move or get renamed? `
            + 'This test cannot protect a call site it cannot see.',
        );
    }
});

test('EVERY remote-touching construction passes the account', () => {
    for (const surface of SURFACES) {
        const calls = callArguments(surface.source, surface.factory);
        for (const [index, args] of calls.entries()) {
            assert.match(
                args,
                new RegExp(`${surface.option}\\s*:`),
                `${surface.what} call #${index + 1} must pass ${surface.option} — `
                + surface.why,
            );
        }
    }
});

test('the account is resolved through the ONE repoId rule', () => {
    // `githubEnvForRepoId` is the single place a repo becomes an
    // environment. Two call sites deriving it differently could disagree
    // about which account owns a repo — the same class of bug one level
    // down, and the reason `githubEnvForAccount` exists for ids.
    for (const surface of SURFACES) {
        for (const args of callArguments(surface.source, surface.factory)) {
            assert.match(
                args,
                // Bounded, because the resolver may be a multi-line
                // arrow with its own type annotations between the two.
                new RegExp(`${surface.option}\\s*:[\\s\\S]{0,240}?githubEnvForRepoId\\(`),
                `${surface.what} should resolve through githubEnvForRepoId`,
            );
        }
    }
});

test('the repoId rule itself still exists and includes archived repos', () => {
    // An archived repo can still have an open PR to merge or a deploy to
    // finish, and the account is how to reach it. A lookup that skipped
    // them would silently hand back the ambient identity.
    const i = ORCHESTRATOR_MAIN.indexOf('githubEnvForRepoId(repoId: string | null)');
    assert.notEqual(i, -1, 'githubEnvForRepoId must exist');
    const body = ORCHESTRATOR_MAIN.slice(i, i + 600);
    assert.match(body, /includeArchived:\s*true/);
    assert.match(
        body,
        /githubEnvForAccount\(/,
        'the repoId rule must go through the shared account rule, not re-derive it',
    );
});
