/**
 * Worker-api routes for the workspace repo registry.
 *
 * Read endpoints (this module's responsibility):
 *
 *   GET  /api/repos               — returns `{ repos: RepoRecord[] }`
 *                                   (active rows only, name-sorted).
 *   GET  /api/repos/:repoId       — single repo, or 404.
 *
 * Write endpoints translate directly to `RegisterRepo` / `UpdateRepo` /
 * `ArchiveRepo` / `RefreshRepo` / `RefreshAllRepos` commands. Those
 * route through the board-ui server's REST→Command translator
 * (mirrors how project + plan writes are wired) rather than landing
 * here, so this module stays read-only — same architectural rule the
 * existing `projects.ts` and `decompose-status.ts` routers follow.
 *
 * The read side is backed by {@link RepoProjectionStore.listActive} /
 * `.get()`; the orchestrator owns the store and the worker-api borrows
 * it through {@link Orchestrator.getRepoProjectionStore}.
 */

import * as http from 'node:http';
import { execFile } from 'node:child_process';

import type { Logger } from '../../../core/ports/Logger';
import type { RepoProjectionStore } from '../../../adapters/projections/repo-projection-store';

export const REPOS_LIST_ROUTE_PATTERN = /^\/api\/repos\/?$/;
// Distinct from `/api/repos/:repoId` — checked before the detail
// pattern so the literal "create" segment doesn't get parsed as an id.
export const REPOS_CREATE_DETAIL_PATTERN = /^\/api\/repos\/create\/?$/;
// Reads the currently-authenticated gh user's login so the board's
// Create-new-repo form can default the Owner field without the
// operator having to type their own login.
export const GH_AUTH_USER_PATTERN = /^\/api\/gh\/auth-user\/?$/;
export const REPO_DETAIL_ROUTE_PATTERN = /^\/api\/repos\/([^/]+)$/;
// Declared GitHub accounts, so the repo forms can offer them. Ids and
// labels only - the manager UI owns creating and testing accounts,
// and no account ever carries a secret anyway (it names a `gh`
// config dir; `gh` holds the credential).
export const GITHUB_ACCOUNTS_PATTERN = /^\/api\/github-accounts\/?$/;

export interface ReposRoutesDeps {
    readonly store: RepoProjectionStore;
    readonly logger?: Logger;
    /**
     * Declared GitHub account ids, in display order. Absent (or an
     * empty list) means the board offers no picker and every repo
     * uses the machine's ambient identity - the behaviour from
     * before accounts existed.
     */
    readonly githubAccountIds?: () => readonly string[];
}

export interface ReposRouter {
    handle(req: http.IncomingMessage, res: http.ServerResponse): boolean;
}

export function createReposRouter(deps: ReposRoutesDeps): ReposRouter {
    return {
        handle(req, res): boolean {
            const url = req.url ?? '/';
            const pathname = url.split('?', 1)[0];
            const method = req.method ?? 'GET';

            if (GITHUB_ACCOUNTS_PATTERN.test(pathname)) {
                if (method !== 'GET') {
                    respond(res, 405, { error: 'method not allowed' }, { Allow: 'GET' });
                    return true;
                }
                // Never fails the board: an install with no accounts
                // declared answers an empty list, and the repo forms
                // simply omit the picker.
                let accounts: readonly string[] = [];
                try {
                    accounts = deps.githubAccountIds?.() ?? [];
                } catch (err) {
                    deps.logger?.warn('repos: github account list failed', {
                        error: err instanceof Error ? err.message : String(err),
                    });
                }
                respond(res, 200, { accounts });
                return true;
            }

            if (REPOS_LIST_ROUTE_PATTERN.test(pathname)) {
                if (method !== 'GET') {
                    respond(res, 405, { error: 'method not allowed' }, { Allow: 'GET' });
                    return true;
                }
                try {
                    const repos = deps.store.listActive();
                    respond(res, 200, { repos });
                } catch (err) {
                    fail(deps, res, 'list', err);
                }
                return true;
            }

            if (GH_AUTH_USER_PATTERN.test(pathname)) {
                if (method !== 'GET') {
                    respond(res, 405, { error: 'method not allowed' }, { Allow: 'GET' });
                    return true;
                }
                handleGhAuthUserRequest(deps, res);
                return true;
            }

            // `/api/repos/create` is the board-ui REST translator's
            // write route for `CreateRepo`; don't let the detail
            // matcher swallow it as a phantom repoId.
            if (REPOS_CREATE_DETAIL_PATTERN.test(pathname)) return false;

            const detailMatch = REPO_DETAIL_ROUTE_PATTERN.exec(pathname);
            if (detailMatch) {
                if (method !== 'GET') {
                    respond(res, 405, { error: 'method not allowed' }, { Allow: 'GET' });
                    return true;
                }
                let repoId: string;
                try {
                    repoId = decodeURIComponent(detailMatch[1]);
                } catch {
                    respond(res, 404, { error: 'not found' });
                    return true;
                }
                try {
                    const repo = deps.store.get(repoId);
                    if (!repo) {
                        respond(res, 404, { error: 'repo not found', repoId });
                        return true;
                    }
                    respond(res, 200, repo);
                } catch (err) {
                    fail(deps, res, 'get', err, repoId);
                }
                return true;
            }

            return false;
        },
    };
}

/**
 * Run `gh api user --jq .login` and return the auth-user's login.
 * Used by the board's "Create new repo" form to default the Owner
 * field. Errors (gh missing, unauth, network) resolve to `{ login: '' }`
 * with status 200 so the form gracefully falls back to a blank
 * placeholder rather than blowing up the modal.
 */
function handleGhAuthUserRequest(
    deps: ReposRoutesDeps,
    res: http.ServerResponse,
): void {
    const ghBin = process.env.GH_PATH || 'gh';
    execFile(
        ghBin,
        ['api', 'user', '--jq', '.login'],
        { encoding: 'utf8', timeout: 10_000 },
        (err, stdout) => {
            if (err) {
                deps.logger?.warn('repos: gh auth-user lookup failed', {
                    error: err instanceof Error ? err.message : String(err),
                });
                respond(res, 200, { login: '' });
                return;
            }
            const login = (stdout ?? '').toString().trim();
            respond(res, 200, { login });
        },
    );
}

function respond(
    res: http.ServerResponse,
    status: number,
    body: unknown,
    extraHeaders: Readonly<Record<string, string>> = {},
): void {
    res.writeHead(status, {
        'Content-Type': 'application/json',
        ...extraHeaders,
    });
    res.end(JSON.stringify(body));
}

function fail(
    deps: ReposRoutesDeps,
    res: http.ServerResponse,
    op: string,
    err: unknown,
    repoId?: string,
): void {
    const message = err instanceof Error ? err.message : String(err);
    deps.logger?.error(`repos route: ${op} failed`, {
        ...(repoId ? { repoId } : {}),
        error: message,
    });
    respond(res, 500, { error: `repos ${op} failed`, message });
}
