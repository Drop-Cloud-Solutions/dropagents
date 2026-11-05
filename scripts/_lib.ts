/* eslint-disable no-console */
/**
 * Shared helpers for operator-facing CLI scripts under `scripts/`.
 *
 * Operator scripts dispatch commands to a *running* worker-api over HTTP
 * (`POST /commands`) rather than mutating SQLite directly. Routing through
 * the command bus keeps the event projection consistent: the handler
 * persists its events, every named subscriber sees them, and replay after
 * a restart re-runs the same code path. The alternative — writing rows
 * straight into `events` / `tasks` — would bypass projections and silently
 * drift the in-memory state of any host already attached to the DB.
 *
 * Connection config lives in two env vars, matching the worker-api host:
 *
 *   WORKER_API_URL     — base URL (default `http://127.0.0.1:4101`)
 *   WORKER_API_TOKEN_V2 — bearer token (optional; the worker-api runs
 *                        unauthenticated when its own token is unset)
 *
 * The helpers below are deliberately tiny — every dep that touches I/O is
 * injectable so per-script unit tests can drive `run()` without spawning a
 * child process or binding a real port.
 */

import * as http from 'node:http';
import * as https from 'node:https';
import { URL } from 'node:url';

import type { Command } from '../core/commands/command';

export interface ParsedArgs {
    readonly flags: ReadonlyMap<string, string | true>;
    readonly positional: readonly string[];
}

/**
 * Minimal flag parser. Supports `--name value`, `--name=value`, and bare
 * `--name` (boolean true). Everything else is positional. Order between
 * positional and flag args is preserved within each list. Intentionally
 * does NOT support short flags (`-x`) — operator scripts are dispatched
 * by humans typing the long form for readability.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
    const flags = new Map<string, string | true>();
    const positional: string[] = [];
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--') {
            for (let j = i + 1; j < argv.length; j++) positional.push(argv[j]);
            break;
        }
        if (a.startsWith('--')) {
            const eq = a.indexOf('=');
            if (eq >= 0) {
                flags.set(a.slice(2, eq), a.slice(eq + 1));
                continue;
            }
            const key = a.slice(2);
            const next = argv[i + 1];
            if (next !== undefined && !next.startsWith('--')) {
                flags.set(key, next);
                i++;
            } else {
                flags.set(key, true);
            }
            continue;
        }
        positional.push(a);
    }
    return { flags, positional };
}

export function flagString(args: ParsedArgs, name: string): string | undefined {
    const v = args.flags.get(name);
    return typeof v === 'string' ? v : undefined;
}

export function flagBool(args: ParsedArgs, name: string): boolean {
    return args.flags.has(name);
}

export interface ApiConfig {
    readonly url: string;
    readonly token?: string;
}

export function getApiConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
    const url = env.WORKER_API_URL ?? 'http://127.0.0.1:4101';
    const token = env.WORKER_API_TOKEN_V2;
    return token !== undefined && token.length > 0 ? { url, token } : { url };
}

export interface CommandPostResult {
    readonly status: number;
    readonly body: unknown;
}

/**
 * The HTTP seam tests inject. Production wiring routes through
 * `defaultHttpPost`, which posts to the worker-api over the `http` module.
 */
export type HttpPost = (
    cfg: ApiConfig,
    command: Command,
) => Promise<CommandPostResult>;

export const defaultHttpPost: HttpPost = (cfg, command) => {
    const target = new URL('/commands', cfg.url);
    const body = JSON.stringify(command);
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(body)),
    };
    if (cfg.token) headers['Authorization'] = `Bearer ${cfg.token}`;

    const isHttps = target.protocol === 'https:';
    const lib = isHttps ? https : http;
    const port = target.port
        ? Number(target.port)
        : isHttps
            ? 443
            : 80;

    return new Promise<CommandPostResult>((resolve, reject) => {
        const req = lib.request(
            {
                hostname: target.hostname,
                port,
                path: `${target.pathname}${target.search}`,
                method: 'POST',
                headers,
            },
            (res) => {
                const chunks: Buffer[] = [];
                res.on('data', (chunk: Buffer) => chunks.push(chunk));
                res.on('end', () => {
                    const raw = Buffer.concat(chunks).toString('utf8');
                    let parsed: unknown = raw;
                    if (raw.length > 0) {
                        try {
                            parsed = JSON.parse(raw);
                        } catch {
                            // Non-JSON body — keep the raw string for the
                            // caller to surface in error output.
                        }
                    }
                    resolve({ status: res.statusCode ?? 0, body: parsed });
                });
            },
        );
        req.on('error', reject);
        req.write(body);
        req.end();
    });
};

export interface RunDeps {
    readonly httpPost?: HttpPost;
    readonly env?: NodeJS.ProcessEnv;
    readonly clock?: () => number;
    readonly stdout?: (line: string) => void;
    readonly stderr?: (line: string) => void;
}

export interface CommandSpec<TPayload> {
    readonly type: string;
    readonly actor: string;
    readonly payload: TPayload;
}

/**
 * Build a `Command` from the supplied spec and ship it to the worker-api.
 * Returns the parsed `{ status, body }` so a script can decide its own
 * exit code (2xx → 0, anything else → non-zero).
 */
export async function dispatchCommand<TPayload>(
    spec: CommandSpec<TPayload>,
    deps: RunDeps = {},
): Promise<CommandPostResult> {
    const env = deps.env ?? process.env;
    const cfg = getApiConfig(env);
    const post = deps.httpPost ?? defaultHttpPost;
    const clock = deps.clock ?? Date.now;
    const command: Command<TPayload> = {
        type: spec.type,
        actor: spec.actor,
        issuedAt: clock(),
        payload: spec.payload,
    };
    return post(cfg, command);
}

export function writeStdout(deps: RunDeps, line: string): void {
    const out = deps.stdout ?? ((l: string) => process.stdout.write(`${l}\n`));
    out(line);
}

export function writeStderr(deps: RunDeps, line: string): void {
    const err = deps.stderr ?? ((l: string) => process.stderr.write(`${l}\n`));
    err(line);
}

/**
 * Report the outcome of a dispatched command. Success (2xx) renders the
 * worker-api's response body to stdout as pretty JSON; everything else
 * writes a single-line error to stderr followed by the body. Returns the
 * suggested exit code so callers can `return reportOutcome(...)` directly.
 */
export function reportOutcome(
    actionLabel: string,
    result: CommandPostResult,
    deps: RunDeps,
): number {
    const bodyJson = (() => {
        try {
            return JSON.stringify(result.body, null, 2);
        } catch {
            return String(result.body);
        }
    })();
    if (result.status >= 200 && result.status < 300) {
        writeStdout(deps, `${actionLabel}: OK (HTTP ${result.status})`);
        writeStdout(deps, bodyJson);
        return 0;
    }
    writeStderr(deps, `${actionLabel}: FAILED (HTTP ${result.status})`);
    writeStderr(deps, bodyJson);
    return 1;
}

/**
 * Standard `--help` rendering. Scripts pass a multi-line string; this
 * helper just funnels it through the injected stdout sink so tests can
 * capture it without monkeypatching `process.stdout`.
 */
export function printHelp(help: string, deps: RunDeps = {}): number {
    writeStdout(deps, help.trimEnd());
    return 0;
}

/**
 * Convenience: every script accepts `--help` / `-h`. Returning `true`
 * means the caller should print help and exit 0 without running anything.
 */
export function isHelpRequested(args: ParsedArgs): boolean {
    return args.flags.has('help') || args.flags.has('h');
}

/**
 * Standard CLI bootstrap: invoke `run` with `process.argv.slice(2)` and
 * exit with its returned code. Uncaught exceptions surface as a final
 * stderr line + exit 2, distinguishing harness errors from a non-zero
 * dispatch result.
 */
export function runCli(run: (argv: readonly string[]) => Promise<number>): void {
    run(process.argv.slice(2)).then(
        (code) => process.exit(code),
        (err) => {
            const msg = err instanceof Error ? err.stack ?? err.message : String(err);
            process.stderr.write(`fatal: ${msg}\n`);
            process.exit(2);
        },
    );
}
