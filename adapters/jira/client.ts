/**
 * Jira Cloud REST transport.
 *
 * Thin wrapper around `fetch` — no SDK dependency. The shape mirrors
 * `adapters/linear/client.ts` so anyone who has read that file can follow
 * this one without re-orienting.
 *
 * Auth: Jira Cloud accepts HTTP Basic with `<email>:<api-token>`. Both
 * credentials are read at *call time* via getter thunks (default
 * `process.env`) so a worker's `.env` loader can sequence after import
 * resolution without the credentials latching to `undefined`.
 *
 * Retry policy: deliberately none. The shadow subscriber catches every
 * failure and writes the diff log — re-trying inside the transport would
 * just delay the inevitable swallow. Callers that want retries (the
 * Linear adapter pattern) can wrap this client.
 */
const DEFAULT_TIMEOUT_MS = 30_000;

export class JiraApiError extends Error {
  override readonly name = 'JiraApiError';
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

export function defaultGetBaseUrl(): string | undefined {
  return process.env.JIRA_BASE_URL;
}

export function defaultGetEmail(): string | undefined {
  return process.env.JIRA_EMAIL;
}

export function defaultGetApiToken(): string | undefined {
  return process.env.JIRA_API_TOKEN;
}

export interface JiraClient {
  post<T = unknown>(pathPart: string, body: unknown): Promise<T>;
  get<T = unknown>(pathPart: string): Promise<T>;
}

export interface JiraClientOptions {
  /** Override `fetch` (for tests). Defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
  /** Read the base URL at call time. Defaults to `process.env.JIRA_BASE_URL`. */
  readonly getBaseUrl?: () => string | undefined;
  /** Read the email at call time. Defaults to `process.env.JIRA_EMAIL`. */
  readonly getEmail?: () => string | undefined;
  /** Read the API token at call time. Defaults to `process.env.JIRA_API_TOKEN`. */
  readonly getApiToken?: () => string | undefined;
  /** Per-request timeout in milliseconds. Default 30s. */
  readonly timeoutMs?: number;
}

export function createJiraClient(options: JiraClientOptions = {}): JiraClient {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const getBaseUrl = options.getBaseUrl ?? defaultGetBaseUrl;
  const getEmail = options.getEmail ?? defaultGetEmail;
  const getApiToken = options.getApiToken ?? defaultGetApiToken;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (typeof fetchImpl !== 'function') {
    throw new Error('createJiraClient: fetch is not available — pass options.fetchImpl');
  }

  async function request<T>(method: string, pathPart: string, body?: unknown): Promise<T> {
    const base = getBaseUrl();
    if (!base) throw new JiraApiError('JIRA_BASE_URL is not set');
    const email = getEmail();
    const token = getApiToken();
    if (!email || !token) {
      throw new JiraApiError('JIRA_EMAIL and JIRA_API_TOKEN must both be set');
    }

    const url = base.replace(/\/+$/, '') + pathPart;
    const auth = Buffer.from(`${email}:${token}`).toString('base64');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetchImpl(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Basic ${auth}`
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new JiraApiError(`Jira HTTP ${res.status}: ${text}`, res.status);
      }
      if (res.status === 204) return undefined as T;
      const ctype = res.headers.get('content-type') ?? '';
      if (!ctype.includes('json')) return undefined as T;
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    post<T>(pathPart: string, body: unknown): Promise<T> {
      return request<T>('POST', pathPart, body);
    },
    get<T>(pathPart: string): Promise<T> {
      return request<T>('GET', pathPart);
    }
  };
}
