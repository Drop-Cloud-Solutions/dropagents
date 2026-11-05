/**
 * GitHub accounts — more than one GitHub identity, usable at the same
 * time.
 *
 * Before this, there was exactly one GitHub identity in the system and
 * it was implicit: every `gh` call inherited `process.env` and relied on
 * the machine's `gh auth login` keyring, git push went through whatever
 * OS credential helper was configured, and commits were stamped from a
 * single `GIT_COMMIT_NAME`/`GIT_COMMIT_EMAIL` pair. Three separate
 * surfaces, all single-valued and machine-global.
 *
 * ## No secrets here
 *
 * An account stores a `gh_config_dir` — a directory the operator has run
 * `gh auth login` into — and never a token. `gh` keeps the credential in
 * its own store inside that directory, so the pipeline's config, its
 * database and its logs hold a PATH and nothing more. That is what keeps
 * the "secrets never appear in logs, prompts or transcripts; key names
 * only" rule true for free rather than by vigilance.
 *
 * ## Why an env overlay, per child process
 *
 * `GH_CONFIG_DIR` in a child's environment selects which account that
 * ONE process acts as. The obvious alternative, `gh auth switch`, is not
 * merely less tidy — it is disqualifying. It mutates global state, and
 * this pipeline runs tasks concurrently, so two tasks on different
 * accounts would race and whichever switched last would silently win for
 * both. A per-process overlay cannot race.
 *
 * ## Nothing configured means nothing changes
 *
 * {@link resolveGitHubEnv} returns an EMPTY overlay when no accounts are
 * declared, or when the named account is unknown. Call sites spread the
 * result over `process.env`, so an install that has not opted in behaves
 * exactly as it did before this module existed. That property is what
 * makes it safe to thread through ~10 spawn sites at once.
 */

/** A declared GitHub identity. Carries no credential. */
export interface GitHubAccount {
    /** Stable id, used as the value of `repos.account_id`. */
    readonly id: string;
    /**
     * Directory the operator ran `gh auth login` into. Becomes
     * `GH_CONFIG_DIR` for children acting as this account.
     */
    readonly ghConfigDir: string;
    /** `user.name` for commits made against this account's repos. */
    readonly commitName: string;
    /**
     * `user.email` for those commits. Must be a verified address on the
     * GitHub account, or GitHub cannot attribute the commit — the author
     * line is just text, and it is matched to an account by email.
     */
    readonly commitEmail: string;
}

/** Parsed `github_accounts:` block, by id. */
export type GitHubAccountMap = ReadonlyMap<string, GitHubAccount>;

/**
 * Env vars an account contributes to a child process.
 *
 * Three jobs, which is why they travel together:
 *   - `GH_CONFIG_DIR` makes the `gh` CLI act as this account
 *   - `GIT_COMMIT_*` stamp the commit with its identity
 *   - `GIT_CONFIG_*` point `git push` at the same credential
 *
 * All three or none. A child with the first two but not the third would
 * open PRs as one account while pushing as another.
 */
export interface GitHubEnvOverlay {
    readonly GH_CONFIG_DIR?: string;
    /**
     * This project's own names, read by design-doc-committer and
     * GitCli. Git itself ignores them - see the GIT_AUTHOR_* /
     * GIT_COMMITTER_* pair below, which is what actually decides
     * who a commit is attributed to.
     */
    readonly GIT_COMMIT_NAME?: string;
    readonly GIT_COMMIT_EMAIL?: string;
    /**
     * The git-native identity vars, which OVERRIDE `user.name` /
     * `user.email` from any config file.
     *
     * These are what make an agent-authored commit land under the
     * right account. Task commits are made by the committer AGENT
     * running `git commit` itself, not by pipeline code, so there is
     * no call site to pass an identity to - but the agent inherits
     * this env, and git reads these four. Without them a commit for
     * account B's repo would carry the machine's global identity and
     * GitHub would attribute it to the wrong person.
     */
    readonly GIT_AUTHOR_NAME?: string;
    readonly GIT_AUTHOR_EMAIL?: string;
    readonly GIT_COMMITTER_NAME?: string;
    readonly GIT_COMMITTER_EMAIL?: string;
    /**
     * Git reads config from `GIT_CONFIG_COUNT` + `GIT_CONFIG_KEY_n` /
     * `GIT_CONFIG_VALUE_n` (git 2.31+). Used instead of `-c` on each
     * push command because cmd.exe mangles quoted argv on Windows, and
     * the helper value contains both spaces and quotes. It also reaches
     * git commands the pipeline does not issue itself - an agent running
     * `git push` inherits this env and authenticates correctly.
     */
    readonly GIT_CONFIG_COUNT?: string;
    readonly GIT_CONFIG_KEY_0?: string;
    readonly GIT_CONFIG_VALUE_0?: string;
    readonly GIT_CONFIG_KEY_1?: string;
    readonly GIT_CONFIG_VALUE_1?: string;
}

/** One problem with one account, as the manager UI should show it. */
export interface GitHubAccountProblem {
    /** Account id, or '' when the id itself is the problem. */
    readonly id: string;
    readonly message: string;
}

export interface ParsedGitHubAccounts {
    readonly accounts: GitHubAccountMap;
    /**
     * Accounts that could not be used, with the reason. Collected rather
     * than thrown: one malformed entry must not stop the orchestrator
     * booting, and must not take the other accounts down with it. The
     * manager UI shows these; the resolver treats a rejected account as
     * absent, which degrades to the ambient identity rather than to a
     * wrong one.
     */
    readonly problems: readonly GitHubAccountProblem[];
}

/** `github_accounts:` — the top-level key on pipeline.yaml. */
export const GITHUB_ACCOUNTS_KEY = 'github_accounts';

/**
 * Ids are used as a DB value, a YAML key and part of an env-var-ish
 * identity. Keep them boring so none of those three can be surprised.
 */
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * Parse the `github_accounts:` block out of a pipeline.yaml document.
 *
 * Tolerant of absence (the common case — one account, nothing declared)
 * and of a non-mapping value, which is reported rather than thrown for
 * the reason given on {@link ParsedGitHubAccounts.problems}.
 */
export function parseGitHubAccounts(doc: unknown): ParsedGitHubAccounts {
    const empty: ParsedGitHubAccounts = { accounts: new Map(), problems: [] };
    if (!isPlainObject(doc)) return empty;
    const block = doc[GITHUB_ACCOUNTS_KEY];
    if (block === undefined || block === null) return empty;
    if (!isPlainObject(block)) {
        return {
            accounts: new Map(),
            problems: [{
                id: '',
                message: `${GITHUB_ACCOUNTS_KEY} must be a mapping of id to account; got ${typeOf(block)}`,
            }],
        };
    }

    const accounts = new Map<string, GitHubAccount>();
    const problems: GitHubAccountProblem[] = [];
    for (const [id, raw] of Object.entries(block)) {
        if (!ID_RE.test(id)) {
            problems.push({
                id,
                message: `"${id}" is not a usable account id (letters, digits, dash and underscore; must start with a letter or digit)`,
            });
            continue;
        }
        const account = readAccount(id, raw, problems);
        if (account !== null) accounts.set(id, account);
    }
    return { accounts, problems };
}

function readAccount(
    id: string,
    raw: unknown,
    problems: GitHubAccountProblem[],
): GitHubAccount | null {
    if (!isPlainObject(raw)) {
        problems.push({ id, message: `account "${id}" must be a mapping; got ${typeOf(raw)}` });
        return null;
    }
    const ghConfigDir = readString(raw.gh_config_dir);
    const commitName = readString(raw.commit_name);
    const commitEmail = readString(raw.commit_email);

    // All three are required, and the message names every missing field
    // at once: an operator fixing this is editing YAML by hand, and one
    // field per save-and-retry cycle is a poor way to spend an evening.
    const missing: string[] = [];
    if (ghConfigDir === null) missing.push('gh_config_dir');
    if (commitName === null) missing.push('commit_name');
    if (commitEmail === null) missing.push('commit_email');
    if (missing.length > 0) {
        problems.push({
            id,
            message: `account "${id}" is missing ${missing.join(', ')}`,
        });
        return null;
    }
    return {
        id,
        ghConfigDir: ghConfigDir!,
        commitName: commitName!,
        commitEmail: commitEmail!,
    };
}

/**
 * The env overlay for a child process acting as `accountId`.
 *
 * An unknown or absent account yields an EMPTY overlay, deliberately: a
 * child then inherits the machine's ambient identity, which is what the
 * whole system did before accounts existed. The alternative — falling
 * back to *some* configured account — would mean a typo in a repo's
 * `account_id` silently pushes to the wrong GitHub account, and a push
 * cannot be taken back.
 */
export function resolveGitHubEnv(
    accounts: GitHubAccountMap,
    accountId: string | null | undefined,
    ghBin = 'gh',
): GitHubEnvOverlay {
    if (typeof accountId !== 'string' || accountId.length === 0) return {};
    const account = accounts.get(accountId);
    if (!account) return {};
    return {
        GH_CONFIG_DIR: account.ghConfigDir,
        GIT_COMMIT_NAME: account.commitName,
        GIT_COMMIT_EMAIL: account.commitEmail,
        // Author AND committer: git takes them separately, and a
        // commit whose author is one account and committer another
        // renders as "A committed by B" on GitHub.
        GIT_AUTHOR_NAME: account.commitName,
        GIT_AUTHOR_EMAIL: account.commitEmail,
        GIT_COMMITTER_NAME: account.commitName,
        GIT_COMMITTER_EMAIL: account.commitEmail,
        ...gitCredentialEnv(ghBin),
    };
}

/**
 * Point `git` at `gh` for GitHub credentials, for THIS child only.
 *
 * Two entries, and the order matters. The first sets
 * `credential.helper` to the empty string, which git treats as a RESET
 * of the helper list rather than as a helper named "". Env-injected
 * config is applied after the system and global files, so the reset
 * discards whatever is configured there - on Windows that is normally
 * Git Credential Manager, which holds ONE credential per host and so
 * cannot distinguish two github.com accounts. The second entry then
 * installs gh, which resolves the account from `GH_CONFIG_DIR`.
 *
 * Without the reset, GCM would answer first and the push would go out
 * as the machine's single stored identity while the PR was opened by
 * the other account.
 *
 * Applied ONLY when an account resolves (see {@link resolveGitHubEnv}),
 * so an unmapped repo keeps using whatever the machine already does.
 */
export function gitCredentialEnv(ghBin = 'gh'): GitHubEnvOverlay {
    // Quote only when needed: gh's own `auth setup-git` writes
    // `!'C:\Program Files\GitHub CLI\gh.exe' auth git-credential`, and a
    // bare `gh` must stay unquoted so PATH lookup still works.
    const bin = ghBin.includes(' ') ? `'${ghBin}'` : ghBin;
    return {
        GIT_CONFIG_COUNT: '2',
        GIT_CONFIG_KEY_0: 'credential.helper',
        GIT_CONFIG_VALUE_0: '',
        GIT_CONFIG_KEY_1: 'credential.helper',
        GIT_CONFIG_VALUE_1: `!${bin} auth git-credential`,
    };
}

/**
 * Is this account id usable? Call sites that record a mapping (the repo
 * forms) check before storing, so an unusable id is refused where the
 * operator can see it rather than at push time.
 */
export function isKnownAccount(
    accounts: GitHubAccountMap,
    accountId: string | null | undefined,
): boolean {
    return typeof accountId === 'string'
        && accountId.length > 0
        && accounts.has(accountId);
}

/** Declared ids, sorted — for the manager UI and the repo-form picker. */
export function accountIds(accounts: GitHubAccountMap): string[] {
    return Array.from(accounts.keys()).sort();
}

function readString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
    return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function typeOf(x: unknown): string {
    if (x === null) return 'null';
    if (Array.isArray(x)) return 'array';
    return typeof x;
}
