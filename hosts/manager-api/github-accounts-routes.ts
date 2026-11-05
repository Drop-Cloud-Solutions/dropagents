/**
 * Manager-api routes for the GitHub account registry.
 *
 * Accounts are declared under `github_accounts:` in pipeline.yaml. The
 * manager-api is the single config-writing authority, so these routes
 * exist rather than leaving the operator to hand-edit YAML — and because
 * the profile layer is where the write has to land: a `gh_config_dir` is
 * a machine-specific path and has no business in a tracked repo file.
 *
 * The write delegates to {@link putPipeline} rather than adding a second
 * writer. That path already diffs the submission against the repo
 * default, refuses a submission that would drop a default key, runs the
 * config and pack validators, takes the cross-process lock, and writes
 * atomically. A parallel writer would have to re-earn all of that.
 *
 * ## Why a separate Test route
 *
 * `GET` answers cheaply — what is declared, what failed to parse, and
 * whether each `gh_config_dir` exists on disk. It deliberately does NOT
 * shell out to `gh`: an account check costs a network round trip, and a
 * panel that takes five seconds times the number of accounts to paint is
 * a panel nobody opens.
 *
 * `POST /github-accounts/:id/test` is the expensive, explicit check —
 * `gh api user` inside that account's config dir, answering "who am I".
 * Without it a typo'd config dir is invisible until a task tries to open
 * a PR and parks with `AuthMissing`: a mystery failure hours later, in a
 * different surface, far from the typo.
 */
import * as fs from 'fs';
import * as yaml from 'js-yaml';

import {
    accountIds,
    parseGitHubAccounts,
    GITHUB_ACCOUNTS_KEY,
    type GitHubAccount,
} from '../../core/config/github-accounts';
import {
    getPipeline,
    putPipeline,
    type RouteResult,
    type RoutesOptions,
    type WriteRoutesOptions,
} from './routes';

/** `GET /github-accounts` | `PUT /github-accounts` */
export const GITHUB_ACCOUNTS_PATH_RE = /^\/github-accounts\/?$/;
/** `POST /github-accounts/<id>/test` */
export const GITHUB_ACCOUNT_TEST_PATH_RE = /^\/github-accounts\/([^/]+)\/test\/?$/;

/** One account as the manager UI shows it. */
export interface GitHubAccountView {
    readonly id: string;
    readonly ghConfigDir: string;
    readonly commitName: string;
    readonly commitEmail: string;
    /**
     * Does `gh_config_dir` exist? A cheap fs check, not an auth check —
     * false is a certain problem, true only means the Test is worth
     * running.
     */
    readonly configDirExists: boolean;
}

export interface GitHubAccountsBody {
    readonly accounts: readonly GitHubAccountView[];
    /** Entries that could not be used, with the reason. */
    readonly problems: ReadonlyArray<{ readonly id: string; readonly message: string }>;
}

/**
 * Read the declared accounts, layered profile-over-repo like every other
 * manager read.
 */
export function getGithubAccounts(opts: RoutesOptions): RouteResult {
    const pipeline = getPipeline(opts);
    if (pipeline.status !== 200) return pipeline;
    const { accounts, problems } = parseGitHubAccounts(pipeline.body);
    const view: GitHubAccountView[] = accountIds(accounts).map((id) => {
        const a = accounts.get(id)!;
        return {
            id: a.id,
            ghConfigDir: a.ghConfigDir,
            commitName: a.commitName,
            commitEmail: a.commitEmail,
            configDirExists: dirExists(a.ghConfigDir),
        };
    });
    const body: GitHubAccountsBody = { accounts: view, problems };
    return { status: 200, body };
}

/** The shape `PUT /github-accounts` accepts. */
interface PutBody {
    readonly accounts?: ReadonlyArray<Partial<GitHubAccount> & { id?: string }>;
}

/**
 * Replace the whole `github_accounts:` block.
 *
 * Whole-block rather than per-account CRUD because the file is the
 * record: a partial update would need a merge, and a merge against a
 * document the operator may also be hand-editing is how two writers
 * start disagreeing. The panel always submits the full list.
 *
 * Validation here is structural and cheap (ids, required fields,
 * duplicate ids). Whether the credential actually works is the Test
 * route's job — refusing a save because `gh` was briefly unreachable
 * would be worse than letting the operator save and then see red.
 */
export async function putGithubAccounts(
    opts: WriteRoutesOptions,
    body: string,
    dryRun = false,
): Promise<RouteResult> {
    let parsed: PutBody;
    try {
        parsed = JSON.parse(body) as PutBody;
    } catch {
        return { status: 400, body: { error: 'body must be JSON' } };
    }
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.accounts)) {
        return { status: 400, body: { error: 'body must be {"accounts": [...]}' } };
    }

    const block: Record<string, unknown> = {};
    const seen = new Set<string>();
    for (const raw of parsed.accounts) {
        const id = str(raw?.id);
        const ghConfigDir = str(raw?.ghConfigDir);
        const commitName = str(raw?.commitName);
        const commitEmail = str(raw?.commitEmail);
        if (id === null) {
            return { status: 422, body: { error: 'every account needs an id' } };
        }
        if (seen.has(id)) {
            // A duplicate silently collapses when written as a YAML
            // mapping, so one of the operator's two entries would simply
            // vanish on save.
            return { status: 422, body: { error: `duplicate account id "${id}"` } };
        }
        seen.add(id);
        const missing = [
            ghConfigDir === null ? 'gh_config_dir' : null,
            commitName === null ? 'commit_name' : null,
            commitEmail === null ? 'commit_email' : null,
        ].filter((m): m is string => m !== null);
        if (missing.length > 0) {
            return {
                status: 422,
                body: { error: `account "${id}" is missing ${missing.join(', ')}` },
            };
        }
        block[id] = {
            gh_config_dir: ghConfigDir,
            commit_name: commitName,
            commit_email: commitEmail,
        };
    }

    // Re-validate through the shared parser, so this route and the
    // orchestrator agree on what is acceptable rather than drifting.
    const check = parseGitHubAccounts({ [GITHUB_ACCOUNTS_KEY]: block });
    if (check.problems.length > 0) {
        return { status: 422, body: { error: check.problems[0]!.message } };
    }

    const current = getPipeline(opts);
    if (current.status !== 200) return current;
    const doc = isPlainObject(current.body) ? { ...current.body } : {};
    if (Object.keys(block).length === 0) {
        // No accounts left means remove the key, not write an empty
        // mapping — an empty override lets writeProfilePipeline delete
        // the profile file entirely, which is the correct "reset".
        delete doc[GITHUB_ACCOUNTS_KEY];
    } else {
        doc[GITHUB_ACCOUNTS_KEY] = block;
    }
    return putPipeline(opts, yaml.dump(doc, { lineWidth: 100 }), 'text/yaml', dryRun);
}

/** Result of running `gh api user` inside an account's config dir. */
export interface GitHubAccountTestResult {
    readonly id: string;
    readonly ok: boolean;
    /** The login `gh` reported, when it reported one. */
    readonly login?: string;
    readonly error?: string;
}

/** Injected so tests do not shell out. */
export type GhExec = (
    args: readonly string[],
    env: Readonly<Record<string, string>>,
) => Promise<{ stdout: string; stderr: string; code: number }>;

export interface TestAccountDeps {
    readonly exec: GhExec;
}

/**
 * "Who am I on this account?" — the check that turns a typo from a
 * parked task hours later into a red mark now.
 *
 * Reports rather than throws for every failure mode, because every one
 * of them is something the operator needs to read: a config dir that
 * does not exist, a `gh` that is not on PATH, a directory that exists
 * but was never logged into.
 */
export async function testGithubAccount(
    opts: RoutesOptions,
    deps: TestAccountDeps,
    id: string,
): Promise<RouteResult> {
    const pipeline = getPipeline(opts);
    if (pipeline.status !== 200) return pipeline;
    const { accounts } = parseGitHubAccounts(pipeline.body);
    const account = accounts.get(id);
    if (!account) {
        return { status: 404, body: { error: `unknown account "${id}"` } };
    }
    if (!dirExists(account.ghConfigDir)) {
        const result: GitHubAccountTestResult = {
            id,
            ok: false,
            error: `gh_config_dir does not exist: ${account.ghConfigDir}`,
        };
        return { status: 200, body: result };
    }
    try {
        const out = await deps.exec(
            ['api', 'user', '--jq', '.login'],
            { GH_CONFIG_DIR: account.ghConfigDir },
        );
        const login = out.stdout.trim();
        if (out.code !== 0 || login.length === 0) {
            const detail = out.stderr.trim() || `gh exited ${out.code}`;
            const result: GitHubAccountTestResult = {
                id,
                ok: false,
                // The usual cause, named: a config dir that exists
                // because someone created it, but was never logged into.
                error: `${detail} — has \`gh auth login\` been run with GH_CONFIG_DIR=${account.ghConfigDir}?`,
            };
            return { status: 200, body: result };
        }
        const result: GitHubAccountTestResult = { id, ok: true, login };
        return { status: 200, body: result };
    } catch (err) {
        const result: GitHubAccountTestResult = {
            id,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
        };
        return { status: 200, body: result };
    }
}

function dirExists(dir: string): boolean {
    try {
        return fs.statSync(dir).isDirectory();
    } catch {
        return false;
    }
}

function str(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
    return typeof x === 'object' && x !== null && !Array.isArray(x);
}
