/**
 * Centralised reader for v2's environment variables.
 *
 * Two layers:
 *  - Per-variable getters (e.g. {@link getLinearApiKey}) re-read
 *    `process.env` on every call. No module-level caching: `hosts/loadDotenv`
 *    runs *after* import resolution, so a cached const would freeze in the
 *    pre-dotenv value and ship `undefined` to production.
 *  - {@link validateEnv} aggregates every missing key into a single Error
 *    before throwing. Hosts call it once on startup with the subset they
 *    need, so a fresh checkout sees every misconfiguration at once instead
 *    of guessing-and-restarting one variable at a time.
 *
 * Empty or whitespace-only values (a half-filled `.env` like `LINEAR_API_KEY=`)
 * are normalised to `undefined` and treated as missing by {@link validateEnv}.
 */

import * as os from 'os';
import * as path from 'path';

export type EnvKey =
    | 'LINEAR_API_KEY'
    | 'LINEAR_TEAM_ID'
    | 'AZURE_TENANT_ID'
    | 'AZURE_CLIENT_ID'
    | 'AZURE_CLIENT_SECRET'
    | 'TELEGRAM_BOT_TOKEN'
    | 'TELEGRAM_BOT_TOKEN_V2'
    | 'WORKER_API_TOKEN_V2'
    | 'JIRA_BASE_URL'
    | 'JIRA_EMAIL'
    | 'JIRA_API_TOKEN'
    | 'PIPELINE_STORE_BACKEND'
    | 'PIPELINE_WORKSPACE_ROOT'
    | 'PIPELINE_STATE_DB'
    | 'LOG_FILE'
    | 'MANAGER_API_PORT'
    | 'BOARD_UI_PORT'
    | 'WORKER_API_PORT';

function read(key: EnvKey): string | undefined {
    const raw = process.env[key];
    if (raw === undefined) return undefined;
    const trimmed = raw.trim();
    return trimmed === '' ? undefined : trimmed;
}

export function getLinearApiKey(): string | undefined {
    return read('LINEAR_API_KEY');
}

export function getLinearTeamId(): string | undefined {
    return read('LINEAR_TEAM_ID');
}

export function getAzureTenantId(): string | undefined {
    return read('AZURE_TENANT_ID');
}

export function getAzureClientId(): string | undefined {
    return read('AZURE_CLIENT_ID');
}

export function getAzureClientSecret(): string | undefined {
    return read('AZURE_CLIENT_SECRET');
}

/**
 * Telegram bot token, canonical key first.
 *
 * `TELEGRAM_BOT_TOKEN` is the single canonical key operators set. The legacy
 * `TELEGRAM_BOT_TOKEN_V2` is still honoured as a deprecated fallback so
 * existing deployments keep working through the rename; it is consulted only
 * when the canonical key is unset (or empty/whitespace-only, per {@link read}).
 * The resolution order here MUST stay identical to what `TelegramGateway`'s
 * `readTelegramEnv` reads. The token is a secret — callers must never log the
 * returned value, only the key name.
 */
export function getTelegramBotToken(): string | undefined {
    return read('TELEGRAM_BOT_TOKEN') ?? read('TELEGRAM_BOT_TOKEN_V2');
}

export function getWorkerApiTokenV2(): string | undefined {
    return read('WORKER_API_TOKEN_V2');
}

export function getJiraBaseUrl(): string | undefined {
    return read('JIRA_BASE_URL');
}

export function getJiraEmail(): string | undefined {
    return read('JIRA_EMAIL');
}

export function getJiraApiToken(): string | undefined {
    return read('JIRA_API_TOKEN');
}

export function getPipelineStoreBackend(): string | undefined {
    return read('PIPELINE_STORE_BACKEND');
}

/**
 * Fallback workspace root, used only when `PIPELINE_WORKSPACE_ROOT` is
 * unset. Exported for tests; production code calls
 * {@link getWorkspaceRoot}.
 *
 * The location MATTERS. claude / cursor auto-discover CLAUDE.md by
 * walking UP from the agent's cwd, so a workspace nested inside the
 * operator's own repo tree lets the walk reach their personal checkouts
 * — the "developer wrote to my local clone" failure mode. Both defaults
 * are therefore rooted outside any conventional developer tree:
 *
 *  - Windows: `C:\Drop-AI\Source` (the deployed worker's layout; do not
 *    change without migrating it).
 *  - macOS / Linux: `~/Drop-AI/Source`. Not `~/source/repos` or a
 *    sibling of it — the walk from `~/Drop-AI/Source/repos/<repo>` tops
 *    out at the home directory without ever passing through a personal
 *    checkout. A `/opt`-style root would read as more isolated but needs
 *    root to create, which a launchd/user-session worker does not have.
 */
export function defaultWorkspaceRoot(
    platform: NodeJS.Platform = process.platform,
    homedir: () => string = os.homedir,
): string {
    if (platform === 'win32') return 'C:\\Drop-AI\\Source';
    return path.join(homedir(), 'Drop-AI', 'Source');
}

/**
 * Root the orchestrator clones repos into and lays task worktrees under.
 *
 * Read through this rather than touching `process.env` directly: the
 * three hosts each used to inline their own `C:\Drop-AI\Source` literal,
 * which on a non-Windows box produced a DIRECTORY LITERALLY NAMED
 * `C:\Drop-AI\Source` in the process cwd instead of an error.
 */
export function getWorkspaceRoot(): string {
    return read('PIPELINE_WORKSPACE_ROOT') ?? defaultWorkspaceRoot();
}

/** `<repo-root>` — this file lives at `<repo-root>/config/env.ts`. */
const REPO_ROOT = path.resolve(__dirname, '..');

/** Where the state DB lives when `PIPELINE_STATE_DB` is unset. */
export const DEFAULT_STATE_DB_PATH = path.join(REPO_ROOT, '.pipeline-state.db');

/**
 * Path to the SQLite state database — the event log and every projection.
 *
 * EVERY process that opens it must resolve the path the same way, and the
 * reason is not tidiness. The worker and the manager-api are separate
 * processes sharing one file; point them at two files and nothing errors.
 * The manager UI simply shows and writes configuration the worker never
 * reads, and the operator is left debugging an orchestrator that ignores
 * their edits. That was the state of things until this function existed:
 * the manager-api honoured `PIPELINE_STATE_DB` and the worker's path was
 * hardcoded, so setting the variable silently split them.
 *
 * A RELATIVE value is resolved against the repo root, not `process.cwd()`.
 * The four hosts are launched from different places — a service sets its
 * own working directory, an operator script runs from wherever the shell
 * is — so a cwd-relative path would reintroduce the same split by a
 * different route.
 */
export function getStateDbPath(): string {
    const fromEnv = read('PIPELINE_STATE_DB');
    if (fromEnv === undefined) return DEFAULT_STATE_DB_PATH;
    return path.isAbsolute(fromEnv) ? fromEnv : path.resolve(REPO_ROOT, fromEnv);
}

export function getLogFile(): string | undefined {
    return read('LOG_FILE');
}

export function getManagerApiPort(): string | undefined {
    return read('MANAGER_API_PORT');
}

export function getManagerBoardPort(): string | undefined {
    return read('BOARD_UI_PORT');
}

export function getWorkerApiPort(): string | undefined {
    return read('WORKER_API_PORT');
}

/**
 * Verify every key in `requiredKeys` is present and non-empty in `process.env`.
 *
 * Walks the full list before throwing so the resulting Error message names
 * every missing key — operators fix all gaps in one pass instead of bisecting
 * through restarts.
 */
export function validateEnv(requiredKeys: readonly EnvKey[]): void {
    const missing: EnvKey[] = [];
    for (const key of requiredKeys) {
        if (read(key) === undefined) missing.push(key);
    }
    if (missing.length === 0) return;
    throw new Error(
        `Missing or empty required environment variables: ${missing.join(', ')}`,
    );
}
