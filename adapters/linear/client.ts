/**
 * Linear GraphQL transport.
 *
 * Thin wrapper around `fetch` — no SDK dependency. The Linear v1 client at
 * `pipeline/shared/linear/base.ts` was used as a reference for field shapes,
 * timeouts and the transient-error matcher, but this file is a clean rewrite
 * sized to the v2 adapter's needs.
 *
 * Environment timing: `LINEAR_API_KEY` is read at *call time* via the
 * supplied `getApiKey` thunk (default `process.env.LINEAR_API_KEY`). v1
 * learned the hard way that caching the key at module-load resolves it
 * before the worker's `.env` loader runs, leaving production with `null`
 * credentials. Consumers may still inject their own getter for tests.
 *
 * Retry: transient failures (HTTP 5xx, 429, network/abort) are retried
 * with exponential backoff up to `maxAttempts` times (default 3 — initial
 * + 2 retries). 4xx and GraphQL `errors` fail fast.
 */
import { setTimeout as delay } from 'node:timers/promises';

const DEFAULT_ENDPOINT = 'https://api.linear.app/graphql';
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BACKOFF_BASE_MS = 500;
const DEFAULT_TIMEOUT_MS = 30_000;

/** Read `LINEAR_API_KEY` from the current process env. */
export function defaultGetApiKey(): string | undefined {
  return process.env.LINEAR_API_KEY;
}

/** Read `LINEAR_TEAM_ID` from the current process env. */
export function defaultGetTeamId(): string | undefined {
  return process.env.LINEAR_TEAM_ID;
}

/** Read `LINEAR_INITIATIVE_ID` from the current process env. */
export function defaultGetInitiativeId(): string | undefined {
  return process.env.LINEAR_INITIATIVE_ID;
}

export interface LinearRequestOptions {
  readonly variables?: Readonly<Record<string, unknown>>;
  readonly signal?: AbortSignal;
}

export interface LinearClient {
  request<T = unknown>(query: string, options?: LinearRequestOptions): Promise<T>;
}

export interface LinearClientOptions {
  /** Override the GraphQL endpoint. Defaults to Linear's public API. */
  readonly endpoint?: string;
  /** Override `fetch` (for tests). Defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
  /** Read the API key at call time. Defaults to `process.env.LINEAR_API_KEY`. */
  readonly getApiKey?: () => string | undefined;
  /** Total attempts including the initial one. Default 3 (initial + 2 retries). */
  readonly maxAttempts?: number;
  /** Base for exponential backoff: wait = base * 2^(attempt-1). Default 500ms. */
  readonly backoffBaseMs?: number;
  /** Per-attempt request timeout. Default 30s. */
  readonly timeoutMs?: number;
  /** Test seam for the backoff sleep. */
  readonly sleep?: (ms: number) => Promise<void>;
}

export class LinearApiError extends Error {
  readonly status: number | undefined;
  readonly transient: boolean;
  constructor(message: string, opts: { status?: number; transient?: boolean } = {}) {
    super(message);
    this.name = 'LinearApiError';
    this.status = opts.status;
    this.transient = opts.transient ?? false;
  }
}

const TRANSIENT_NETWORK_RE =
  /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network/i;

function isTransient(err: unknown): boolean {
  if (err instanceof LinearApiError) return err.transient;
  const anyErr = err as { name?: string; message?: string } | null;
  if (anyErr?.name === 'AbortError') return true;
  const msg = anyErr?.message ?? String(err);
  return TRANSIENT_NETWORK_RE.test(msg);
}

/**
 * Build a Linear GraphQL client.
 *
 * The returned object is intentionally tiny — one method, `request`. Callers
 * (the LinearTracker adapter) compose mutations and queries from raw GraphQL
 * strings; the client only owns the transport, auth header, timeout, and
 * retry budget.
 */
export function createLinearClient(options: LinearClientOptions = {}): LinearClient {
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const getApiKey = options.getApiKey ?? defaultGetApiKey;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const backoffBaseMs = options.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const sleep = options.sleep ?? ((ms): Promise<void> => delay(ms).then(() => undefined));

  if (typeof fetchImpl !== 'function') {
    throw new Error('createLinearClient: fetch is not available — pass options.fetchImpl');
  }

  async function attempt<T>(query: string, variables: Readonly<Record<string, unknown>>, externalSignal?: AbortSignal): Promise<T> {
    const apiKey = getApiKey();
    if (!apiKey) throw new LinearApiError('LINEAR_API_KEY is not set');

    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    if (externalSignal) {
      if (externalSignal.aborted) controller.abort();
      else externalSignal.addEventListener('abort', onAbort, { once: true });
    }
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Linear accepts the raw API key, no "Bearer " prefix.
          Authorization: apiKey
        },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const transient = res.status >= 500 || res.status === 429;
        throw new LinearApiError(`Linear HTTP ${res.status}: ${text}`, {
          status: res.status,
          transient
        });
      }

      const json = (await res.json()) as { data?: T; errors?: unknown };
      if (json.errors) {
        // GraphQL-level errors are not retried — they indicate a bad query
        // or a domain rejection, not a transient transport failure.
        throw new LinearApiError(`Linear GraphQL error: ${JSON.stringify(json.errors)}`);
      }
      return json.data as T;
    } finally {
      clearTimeout(timer);
      if (externalSignal) externalSignal.removeEventListener('abort', onAbort);
    }
  }

  return {
    async request<T>(query: string, opts: LinearRequestOptions = {}): Promise<T> {
      const variables = opts.variables ?? {};
      let lastErr: unknown;
      for (let n = 1; n <= maxAttempts; n++) {
        try {
          return await attempt<T>(query, variables, opts.signal);
        } catch (err) {
          lastErr = err;
          if (!isTransient(err) || n >= maxAttempts) throw err;
          await sleep(backoffBaseMs * 2 ** (n - 1));
        }
      }
      throw lastErr instanceof Error ? lastErr : new Error('Linear request failed');
    }
  };
}
