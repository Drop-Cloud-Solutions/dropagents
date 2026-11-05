/**
 * Claude CLI authentication health — detection + proactive status.
 *
 * Field incident: the worker's OAuth token expired and every agent spawn
 * died with an auth error that surfaced only as generic per-task/plan
 * failures. Auth expiry is different from a normal agent failure: it
 * kills EVERY subsequent spawn until fixed, and the fix (a fresh token)
 * has nothing to do with the failed task. Two capabilities live here:
 *
 *  - {@link classifyAuthFailure}: conservative stderr matcher the
 *    orchestrator runs on every AgentFailed so auth-shaped failures can
 *    be promoted to a worker-level `AgentAuthError` event (board banner,
 *    log). Patterns are deliberately NARROW — a task whose test output
 *    merely contains the word "unauthorized" must not trip a worker-wide
 *    auth alarm.
 *
 *  - {@link readAgentAuthStatus}: proactive check for `GET
 *    /api/agent-auth`. Reads ONLY the expiry timestamp from the CLI's
 *    credentials file (never token material) and reports ok /
 *    expiring-soon / expired / unknown, so the operator sees expiry
 *    COMING instead of discovering it from a dead planner. An env
 *    override (`CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY`) reports
 *    as ok — those don't have a locally readable expiry.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Auth-shaped failure signatures seen from the claude CLI / Anthropic API.
 * Each entry pairs the regex with a short stable label that goes into the
 * `AgentAuthError` payload (the raw stderr may contain anything; the label
 * is safe for UI + Telegram).
 */
const AUTH_FAILURE_SIGNATURES: ReadonlyArray<{ re: RegExp; label: string }> = [
    { re: /invalid api key/i, label: 'invalid API key' },
    { re: /api key.*(expired|revoked)/i, label: 'API key expired/revoked' },
    { re: /oauth token.*(expired|revoked|invalid)/i, label: 'OAuth token expired' },
    { re: /token has expired/i, label: 'OAuth token expired' },
    { re: /please run\s+`?\/?login`?/i, label: 'CLI not logged in' },
    { re: /authentication_error/i, label: 'authentication error' },
    { re: /credential[s]?\s+(are\s+)?(expired|invalid|missing)/i, label: 'credentials invalid' },
    { re: /\b401\b.{0,40}unauthorized|unauthorized.{0,40}\b401\b/is, label: 'HTTP 401 unauthorized' },
];

/**
 * Returns a short stable label when `text` looks like an agent-auth
 * failure, or null for everything else.
 */
export function classifyAuthFailure(text: string | undefined | null): string | null {
    if (!text) return null;
    for (const { re, label } of AUTH_FAILURE_SIGNATURES) {
        if (re.test(text)) return label;
    }
    return null;
}

export type AgentAuthState = 'ok' | 'expiring-soon' | 'expired' | 'unknown';

export interface AgentAuthStatus {
    readonly status: AgentAuthState;
    /** Epoch ms the OAuth credentials expire; null when not determinable. */
    readonly expiresAt: number | null;
    /** Where auth comes from: the CLI's OAuth credentials file, an env
     *  override, or nothing found. */
    readonly source: 'oauth-credentials' | 'env-override' | 'none';
    readonly checkedAt: number;
    /** Operator-facing one-liner ("expires in 3d", "expired 2h ago"). */
    readonly detail: string;
}

/** Default warning window: flag 'expiring-soon' within 48h of expiry. */
const EXPIRING_SOON_MS = 48 * 60 * 60 * 1000;

export interface ReadAgentAuthOptions {
    readonly credentialsPath?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly now?: () => number;
    readonly expiringSoonMs?: number;
}

function defaultCredentialsPath(): string {
    return path.join(os.homedir(), '.claude', '.credentials.json');
}

function humanizeDelta(ms: number): string {
    const abs = Math.abs(ms);
    const days = Math.floor(abs / 86_400_000);
    if (days >= 1) return `${days}d`;
    const hours = Math.floor(abs / 3_600_000);
    if (hours >= 1) return `${hours}h`;
    return `${Math.max(1, Math.floor(abs / 60_000))}m`;
}

/**
 * Proactive auth status. Never throws; never reads or returns token
 * material — only the expiry timestamp leaves the credentials file.
 */
export function readAgentAuthStatus(opts: ReadAgentAuthOptions = {}): AgentAuthStatus {
    const env = opts.env ?? process.env;
    const now = (opts.now ?? Date.now)();
    const soonMs = opts.expiringSoonMs ?? EXPIRING_SOON_MS;

    // Env override wins: the CLI authenticates with the token/key from env
    // and the local OAuth file (possibly expired) is irrelevant.
    const override = env.CLAUDE_CODE_OAUTH_TOKEN?.trim() || env.ANTHROPIC_API_KEY?.trim();
    if (override) {
        return {
            status: 'ok',
            expiresAt: null,
            source: 'env-override',
            checkedAt: now,
            detail: 'auth via configured token/key (no local expiry to check)',
        };
    }

    const credPath = opts.credentialsPath ?? defaultCredentialsPath();
    let expiresAt: number | null = null;
    try {
        const raw = fs.readFileSync(credPath, 'utf8');
        const parsed = JSON.parse(raw) as {
            claudeAiOauth?: { expiresAt?: unknown };
        };
        const v = parsed.claudeAiOauth?.expiresAt;
        if (typeof v === 'number' && Number.isFinite(v)) expiresAt = v;
    } catch {
        return {
            status: 'unknown',
            expiresAt: null,
            source: 'none',
            checkedAt: now,
            detail: 'no readable Claude CLI credentials found on this machine',
        };
    }
    if (expiresAt === null) {
        return {
            status: 'unknown',
            expiresAt: null,
            source: 'oauth-credentials',
            checkedAt: now,
            detail: 'credentials file has no readable expiry',
        };
    }
    if (expiresAt <= now) {
        return {
            status: 'expired',
            expiresAt,
            source: 'oauth-credentials',
            checkedAt: now,
            detail: `Claude CLI OAuth expired ${humanizeDelta(now - expiresAt)} ago`,
        };
    }
    if (expiresAt - now <= soonMs) {
        return {
            status: 'expiring-soon',
            expiresAt,
            source: 'oauth-credentials',
            checkedAt: now,
            detail: `Claude CLI OAuth expires in ${humanizeDelta(expiresAt - now)}`,
        };
    }
    return {
        status: 'ok',
        expiresAt,
        source: 'oauth-credentials',
        checkedAt: now,
        detail: `Claude CLI OAuth valid for ${humanizeDelta(expiresAt - now)}`,
    };
}
