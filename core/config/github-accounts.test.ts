/**
 * GitHub accounts — the parse and the env overlay.
 *
 * Operator request: a second GitHub account, both usable at the same
 * time, for repositories the first account cannot reach.
 *
 * Three properties carry the weight, and all three are about failing
 * safely rather than about the happy path:
 *
 *  1. Nothing configured means nothing changes. An empty overlay leaves
 *     the child on the machine's ambient identity, which is exactly what
 *     the system did before accounts existed — so threading this through
 *     ~10 spawn sites cannot alter the behaviour of an install that has
 *     not opted in.
 *  2. An UNKNOWN account resolves to empty, never to "some other
 *     account". A typo in a repo's `account_id` must degrade to the
 *     ambient identity, not silently push to the wrong GitHub account.
 *     A push cannot be taken back.
 *  3. One malformed entry does not take the others down, and does not
 *     stop the orchestrator booting. Problems are collected for the
 *     manager UI to show.
 *
 * No test here involves a token, because an account never holds one —
 * it names a `gh` config directory and `gh` keeps the credential.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import {
    accountIds,
    gitCredentialEnv,
    isKnownAccount,
    parseGitHubAccounts,
    resolveGitHubEnv,
    GITHUB_ACCOUNTS_KEY,
} from './github-accounts';

function doc(accounts: unknown): Record<string, unknown> {
    return { issue_tracker: 'fake', [GITHUB_ACCOUNTS_KEY]: accounts };
}

const TWO = doc({
    dropcs: {
        gh_config_dir: 'C:\\Drop-AI\\gh-accounts\\dropcs',
        commit_name: 'Primary Operator',
        commit_email: 'dev@example.com',
    },
    sidekick: {
        gh_config_dir: 'C:\\Drop-AI\\gh-accounts\\sidekick',
        commit_name: 'Sidekick Bot',
        commit_email: 'bot@example.com',
    },
});

// --- absence is the common case --------------------------------------

test('a pipeline.yaml with no accounts block parses to nothing', () => {
    // One account, nothing declared — the state of every install today.
    for (const d of [{}, { issue_tracker: 'fake' }, doc(undefined), doc(null)]) {
        const parsed = parseGitHubAccounts(d);
        assert.equal(parsed.accounts.size, 0);
        assert.deepEqual(parsed.problems, []);
    }
});

test('a non-mapping document is tolerated, not thrown', () => {
    for (const d of [null, undefined, 'nope', 42, []]) {
        assert.equal(parseGitHubAccounts(d).accounts.size, 0, JSON.stringify(d));
    }
});

test('nothing configured yields an EMPTY overlay', () => {
    // The load-bearing property: spread over process.env this is a
    // no-op, so an install that has not opted in is untouched.
    const { accounts } = parseGitHubAccounts({});
    assert.deepEqual(resolveGitHubEnv(accounts, 'dropcs'), {});
    assert.deepEqual(resolveGitHubEnv(accounts, null), {});
});

// --- the happy path --------------------------------------------------

test('two accounts parse, each with its own config dir and identity', () => {
    const { accounts, problems } = parseGitHubAccounts(TWO);

    assert.deepEqual(problems, []);
    assert.deepEqual(accountIds(accounts), ['dropcs', 'sidekick']);
    assert.equal(accounts.get('sidekick')?.commitEmail, 'bot@example.com');
});

test('the overlay covers gh, the commit identity AND git push', () => {
    // All three together: selecting an account has to change who `gh`
    // acts as, who the commit is authored by, and which credential
    // `git push` uses. Any two without the third means a PR opened by
    // one account carrying commits or pushes from another.
    const { accounts } = parseGitHubAccounts(TWO);

    const env = resolveGitHubEnv(accounts, 'sidekick');

    assert.equal(env.GH_CONFIG_DIR, 'C:\\Drop-AI\\gh-accounts\\sidekick');
    assert.equal(env.GIT_COMMIT_NAME, 'Sidekick Bot');
    assert.equal(env.GIT_COMMIT_EMAIL, 'bot@example.com');
    assert.equal(env.GIT_CONFIG_COUNT, '2');
});

test('the git credential config RESETS the helper list before adding gh', () => {
    // The reset is the whole point. Env-injected config is applied
    // after the system and global files, so an empty `credential.helper`
    // discards what is configured there - on Windows that is Git
    // Credential Manager, which holds ONE credential per host and so
    // cannot tell two github.com accounts apart. Without the reset GCM
    // answers first and the push goes out as the machine identity while
    // the PR is opened by the other account.
    const env = gitCredentialEnv();

    assert.equal(env.GIT_CONFIG_COUNT, '2');
    assert.equal(env.GIT_CONFIG_KEY_0, 'credential.helper');
    assert.equal(env.GIT_CONFIG_VALUE_0, '', 'entry 0 is the reset');
    assert.equal(env.GIT_CONFIG_KEY_1, 'credential.helper');
    assert.match(env.GIT_CONFIG_VALUE_1 ?? '', /auth git-credential$/);
});

test('a gh path with spaces is quoted; a bare binary name is not', () => {
    // gh's own `auth setup-git` writes the quoted absolute form, and a
    // bare `gh` has to stay unquoted or PATH lookup breaks.
    assert.equal(
        gitCredentialEnv('C:\\Program Files\\GitHub CLI\\gh.exe').GIT_CONFIG_VALUE_1,
        "!'C:\\Program Files\\GitHub CLI\\gh.exe' auth git-credential",
    );
    assert.equal(gitCredentialEnv('gh').GIT_CONFIG_VALUE_1, '!gh auth git-credential');
});

test('an UNMAPPED repo gets no git config at all — not a half overlay', () => {
    // The dangerous partial. Emitting the credential reset without a
    // GH_CONFIG_DIR would clear Git Credential Manager and install gh
    // pointed at whatever the DEFAULT config dir holds — so every push
    // for every unmapped repo would change identity, or fail outright.
    // Empty means empty.
    const { accounts } = parseGitHubAccounts(TWO);

    for (const id of [null, undefined, '', 'typo']) {
        const env = resolveGitHubEnv(accounts, id as string | null);
        assert.deepEqual(env, {}, String(id));
        assert.equal(env.GIT_CONFIG_COUNT, undefined, String(id));
    }
});

test('two accounts resolve independently — no shared state', () => {
    // What `gh auth switch` could not give us: resolving one account
    // must not affect the other, because concurrent tasks resolve both.
    const { accounts } = parseGitHubAccounts(TWO);
    const a = resolveGitHubEnv(accounts, 'dropcs');
    const b = resolveGitHubEnv(accounts, 'sidekick');
    const aAgain = resolveGitHubEnv(accounts, 'dropcs');

    assert.notEqual(a.GH_CONFIG_DIR, b.GH_CONFIG_DIR);
    assert.deepEqual(a, aAgain);
});

test('values are trimmed, so a stray space in the YAML does not break a path', () => {
    const { accounts } = parseGitHubAccounts(doc({
        a: {
            gh_config_dir: '  C:\\dir  ',
            commit_name: ' Name ',
            commit_email: ' a@b.c ',
        },
    }));
    assert.equal(accounts.get('a')?.ghConfigDir, 'C:\\dir');
    assert.equal(accounts.get('a')?.commitName, 'Name');
});

// --- an unknown account must NOT fall back ---------------------------

test('an unknown account id resolves to EMPTY, not to another account', () => {
    // The dangerous alternative: falling back to the first/default
    // account would mean a typo'd repo mapping pushes to the wrong
    // GitHub account, and a push cannot be taken back.
    const { accounts } = parseGitHubAccounts(TWO);

    assert.deepEqual(resolveGitHubEnv(accounts, 'typo'), {});
    assert.deepEqual(resolveGitHubEnv(accounts, ''), {});
    assert.deepEqual(resolveGitHubEnv(accounts, null), {});
    assert.deepEqual(resolveGitHubEnv(accounts, undefined), {});
});

test('isKnownAccount is how a caller checks BEFORE storing a mapping', () => {
    const { accounts } = parseGitHubAccounts(TWO);
    assert.equal(isKnownAccount(accounts, 'dropcs'), true);
    assert.equal(isKnownAccount(accounts, 'typo'), false);
    assert.equal(isKnownAccount(accounts, null), false);
    assert.equal(isKnownAccount(accounts, ''), false);
});

// --- malformed entries are reported, not fatal -----------------------

test('a missing field names EVERY missing field at once', () => {
    // The operator is editing YAML by hand; one field per
    // save-and-retry cycle is a poor way to spend an evening.
    const { accounts, problems } = parseGitHubAccounts(doc({
        broken: { gh_config_dir: 'C:\\dir' },
    }));

    assert.equal(accounts.size, 0, 'unusable, so not offered');
    assert.equal(problems.length, 1);
    assert.match(problems[0]!.message, /commit_name/);
    assert.match(problems[0]!.message, /commit_email/);
    assert.equal(problems[0]!.id, 'broken');
});

test('one broken account does not take the good ones down', () => {
    // And does not stop the orchestrator booting.
    const { accounts, problems } = parseGitHubAccounts(doc({
        good: {
            gh_config_dir: 'C:\\dir',
            commit_name: 'N',
            commit_email: 'e@x.y',
        },
        broken: 'not a mapping',
    }));

    assert.deepEqual(accountIds(accounts), ['good']);
    assert.equal(problems.length, 1);
    assert.match(problems[0]!.message, /must be a mapping/);
});

test('a broken account is absent from the resolver, not half-applied', () => {
    // A partial overlay would be the worst outcome: GH_CONFIG_DIR set
    // with no commit identity means `gh` acts as one account while
    // GitCli.commit() throws on the missing name.
    const { accounts } = parseGitHubAccounts(doc({
        broken: { gh_config_dir: 'C:\\dir' },
    }));
    assert.deepEqual(resolveGitHubEnv(accounts, 'broken'), {});
});

test('an unusable id is rejected with its own message', () => {
    // Ids become a DB value, a YAML key and part of an identity; keep
    // them boring so none of the three is surprised.
    const { accounts, problems } = parseGitHubAccounts(doc({
        'has space': { gh_config_dir: 'd', commit_name: 'n', commit_email: 'e' },
        '../escape': { gh_config_dir: 'd', commit_name: 'n', commit_email: 'e' },
    }));

    assert.equal(accounts.size, 0);
    assert.equal(problems.length, 2);
    for (const p of problems) assert.match(p.message, /not a usable account id/);
});

test('a non-mapping accounts block is reported once', () => {
    const { accounts, problems } = parseGitHubAccounts(doc('dropcs'));
    assert.equal(accounts.size, 0);
    assert.equal(problems.length, 1);
    assert.match(problems[0]!.message, /must be a mapping of id to account/);
});

// --- no secrets ------------------------------------------------------

test('an account models a config DIRECTORY, never a token', () => {
    // The reason the whole design hangs on gh: the pipeline's config, db
    // and logs hold a path, and `gh` holds the credential. A token field
    // would make "secrets never appear in logs" a matter of vigilance
    // rather than of structure.
    const { accounts } = parseGitHubAccounts(doc({
        a: {
            gh_config_dir: 'C:\\dir',
            commit_name: 'n',
            commit_email: 'e@x.y',
            // Someone pasting a token in gets it ignored, not stored.
            token: 'ghp_SHOULD_BE_IGNORED',
        },
    }));

    const account = accounts.get('a')!;
    assert.deepEqual(Object.keys(account).sort(), [
        'commitEmail', 'commitName', 'ghConfigDir', 'id',
    ]);
    assert.doesNotMatch(JSON.stringify(account), /ghp_/);
    assert.doesNotMatch(JSON.stringify(resolveGitHubEnv(accounts, 'a')), /ghp_/);
});
