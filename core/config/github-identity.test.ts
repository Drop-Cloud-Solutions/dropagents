/**
 * Per-account commit identity.
 *
 * The operator asked for commits on the second account's repos to be
 * authored as that account. The obvious place to implement that — a
 * commit call site taking a name and email — turned out not to exist:
 * `GitCli` is referenced nowhere in production, and task commits are
 * made by the committer AGENT running `git commit` itself.
 *
 * So the identity has to travel as environment, and it has to be the
 * GIT-NATIVE variables. `GIT_COMMIT_NAME` / `GIT_COMMIT_EMAIL` are this
 * project's own names, read by `design-doc-committer` and `GitCli`; git
 * ignores them entirely. `GIT_AUTHOR_*` and `GIT_COMMITTER_*` are what
 * git reads, and they override `user.name` / `user.email` from every
 * config file — verified against a scratch repo, not assumed.
 *
 * Both halves are asserted here because dropping either is silent: with
 * only the project's own names, an agent commit carries the machine's
 * global identity and GitHub attributes it to the wrong person.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import {
    parseGitHubAccounts,
    resolveGitHubEnv,
    GITHUB_ACCOUNTS_KEY,
} from './github-accounts';

const DOC = {
    [GITHUB_ACCOUNTS_KEY]: {
        sidekick: {
            gh_config_dir: 'C:\\gh\\sidekick',
            commit_name: 'Sidekick Bot',
            commit_email: 'bot@example.com',
        },
    },
};

function env(id: string | null) {
    const { accounts } = parseGitHubAccounts(DOC);
    return resolveGitHubEnv(accounts, id);
}

test('the git-native author and committer vars are set', () => {
    // These are the ones git actually reads. Without them the commit
    // carries the machine's global user.name / user.email.
    const e = env('sidekick');

    assert.equal(e.GIT_AUTHOR_NAME, 'Sidekick Bot');
    assert.equal(e.GIT_AUTHOR_EMAIL, 'bot@example.com');
    assert.equal(e.GIT_COMMITTER_NAME, 'Sidekick Bot');
    assert.equal(e.GIT_COMMITTER_EMAIL, 'bot@example.com');
});

test("the project's own GIT_COMMIT_* names are set too", () => {
    // design-doc-committer reads these, and GitCli.commit() throws
    // without them. Keeping both pairs is deliberate, not redundant.
    const e = env('sidekick');

    assert.equal(e.GIT_COMMIT_NAME, 'Sidekick Bot');
    assert.equal(e.GIT_COMMIT_EMAIL, 'bot@example.com');
});

test('author and committer agree', () => {
    // A commit whose author is one account and committer another renders
    // on GitHub as "A committed by B" — technically correct and
    // confusing on every single commit.
    const e = env('sidekick');

    assert.equal(e.GIT_AUTHOR_NAME, e.GIT_COMMITTER_NAME);
    assert.equal(e.GIT_AUTHOR_EMAIL, e.GIT_COMMITTER_EMAIL);
});

test('an unmapped repo sets NO identity vars', () => {
    // The whole overlay is empty, so the agent commits under the
    // machine's configured identity — the behaviour from before accounts
    // existed. A partial overlay here would rewrite the author of every
    // commit in every unmapped repo.
    for (const id of [null, '', 'typo']) {
        const e = env(id);
        assert.deepEqual(e, {}, String(id));
        assert.equal(e.GIT_AUTHOR_NAME, undefined, String(id));
        assert.equal(e.GIT_COMMITTER_EMAIL, undefined, String(id));
    }
});

test('the overlay is a flat string map, safe to spread into a child env', () => {
    // Every consumer spreads it over process.env. A nested value would
    // reach the child as "[object Object]" and git would accept it as a
    // name.
    const e = env('sidekick') as Record<string, unknown>;

    for (const [key, value] of Object.entries(e)) {
        assert.equal(typeof value, 'string', `${key} must be a string`);
    }
});
