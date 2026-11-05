/**
 * Every repo-sync construction has to resolve the GitHub account.
 *
 * Field report: syncing a correctly-mapped repo failed with
 * "GraphQL: Could not resolve to a Repository with the name
 * 'Suitsupply/DescartesAPI'" even though the repo existed.
 *
 * `RepoSyncDeps.resolveGithubEnv` was wired into
 * `attachRepoEnsureSubscriber` and NOT into `createRepoRefreshTrigger`,
 * which is the path Sync/Refresh takes. The optional dep silently
 * resolved to `{}`, so the clone ran with the machine's AMBIENT identity
 * — and GitHub answers a private repo the token cannot see with "could
 * not resolve to a Repository" rather than a permission error. The
 * failure therefore reads as "the repo does not exist", which is the
 * single most misleading thing it could have said.
 *
 * The dep is optional by design (absent means the ambient identity,
 * which is correct for an install with no accounts), so neither the
 * compiler nor a repo-sync unit test can catch a construction that
 * forgets it — repo-sync itself was correct throughout. This asserts the
 * wiring at the source level instead, the same approach as
 * manager-board's markup-contract test, and for the same reason: the
 * failure is invisible to every other check.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { callArguments } from './call-arguments.testlib';

const MAIN = fs.readFileSync(path.join(__dirname, 'main.ts'), 'utf8');

/** The factories that take a `RepoSyncDeps`. */
const FACTORIES = ['createRepoRefreshTrigger', 'attachRepoEnsureSubscriber'] as const;


test('both repo-sync factories are actually called', () => {
    // Guards the test itself: a rename that made the search miss every
    // call site would otherwise pass vacuously.
    for (const factory of FACTORIES) {
        assert.ok(
            callArguments(MAIN, factory).length > 0,
            `${factory} not found in main.ts — did it move or get renamed?`,
        );
    }
});

test('EVERY repo-sync construction passes resolveGithubEnv', () => {
    // The bug: one of the two did not, so Sync cloned private repos with
    // the wrong identity and reported them as non-existent.
    for (const factory of FACTORIES) {
        for (const [index, args] of callArguments(MAIN, factory).entries()) {
            assert.match(
                args,
                /resolveGithubEnv\s*:/,
                `${factory} call #${index + 1} must pass resolveGithubEnv — without it `
                + 'clone and fetch run as the ambient GitHub identity, and a private '
                + 'repo the ambient account cannot see fails as "could not resolve to '
                + 'a Repository".',
            );
        }
    }
});

test('the resolver goes through the shared githubEnvForAccount', () => {
    // One place an account id becomes an environment. Two call sites
    // building the overlay differently could disagree about what an id
    // means, which is the same class of bug one level down.
    for (const factory of FACTORIES) {
        for (const args of callArguments(MAIN, factory)) {
            assert.match(
                args,
                /resolveGithubEnv\s*:\s*\([^)]*\)\s*=>\s*this\.githubEnvForAccount\(/,
                `${factory} should resolve through this.githubEnvForAccount`,
            );
        }
    }
});
