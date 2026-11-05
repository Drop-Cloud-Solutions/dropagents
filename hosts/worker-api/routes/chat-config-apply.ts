/**
 * POST /api/chat/config-apply — execute a confirmed chat
 * `PROPOSE_CONFIG_CHANGE` proposal.
 *
 * The chat agent proposes; the operator clicks the confirm chip; this
 * route EXECUTES by proxying to the manager-api — deliberately not by
 * writing config itself, so the manager-api stays the single
 * config-writing authority (its validation, atomic writes and write
 * lock are not duplicated in a second process).
 *
 * Targets (mirroring the manager UI's write surface):
 *   pipeline        → PUT {manager}/pipeline          (yaml, dry-run validated)
 *   flow:<name>     → PUT {manager}/flows/<name>      (yaml, dry-run validated)
 *                     + in-process flow hot-reload on success
 *   persona:<role>  → PUT {manager}/agent-md/<role>   ({content})
 *   setting:<KEY>   → PUT {manager}/settings/<KEY>    ({value})
 *   agent:<role>    → PUT/POST {manager}/agents…      (model / provider)
 *   project-context:<projectId>
 *                   → PUT {manager}/projects/<id>/context-md ({content})
 *
 * Secrets: a secret setting's value NEVER travels through the agent.
 * When the key is secret and no `operatorValue` is supplied, the route
 * answers `{ needsSecretValue: true }` and the UI prompts the operator
 * to type the value, then re-posts. A body-supplied value for a secret
 * key is refused outright.
 *
 * On success (and on failure) a `system` note is appended to the chat
 * session so the operator sees the outcome in-thread and the agent
 * reads it in its next turn's transcript.
 */
import * as http from 'node:http';

import type { Logger } from '../../../core/ports/Logger';

export const CHAT_CONFIG_APPLY_ROUTE = '/api/chat/config-apply';

const MAX_BODY_BYTES = 1_000_000;

interface FetchResponseLike {
    readonly ok: boolean;
    readonly status: number;
    json(): Promise<unknown>;
    text(): Promise<string>;
}

type FetchLike = (
    url: string,
    init?: {
        method?: string;
        headers?: Record<string, string>;
        body?: string;
        signal?: AbortSignal;
    },
) => Promise<FetchResponseLike>;

export interface ChatConfigApplyDeps {
    /** manager-api origin, e.g. http://127.0.0.1:4102 (no trailing slash). */
    readonly managerApiUrl: string;
    readonly managerApiToken?: string;
    readonly fetchImpl?: FetchLike;
    readonly logger?: Logger;
    /** In-process flow hot-reload, run after a flow/pipeline write. */
    readonly reloadFlows?: () => { flowIds: readonly string[] };
    /** Appends the outcome note to the chat thread. */
    readonly appendSystemNote?: (sessionId: string, body: string) => void;
}

export interface ChatConfigApplyRouter {
    handle(req: http.IncomingMessage, res: http.ServerResponse): boolean;
}

interface ApplyBody {
    readonly sessionId?: string;
    readonly target?: string;
    readonly body?: string;
    readonly model?: string;
    readonly provider?: string;
    readonly operatorValue?: string;
}

export function createChatConfigApplyRouter(
    deps: ChatConfigApplyDeps,
): ChatConfigApplyRouter {
    const fetchImpl: FetchLike = deps.fetchImpl ?? (fetch as unknown as FetchLike);
    const base = deps.managerApiUrl.replace(/\/+$/, '');
    const headers = (json: boolean): Record<string, string> => ({
        ...(json ? { 'Content-Type': 'application/json' } : { 'Content-Type': 'text/yaml' }),
        ...(deps.managerApiToken !== undefined
            ? { Authorization: `Bearer ${deps.managerApiToken}` }
            : {}),
    });

    async function managerJson(
        method: string,
        pathName: string,
        payload?: unknown,
    ): Promise<{ status: number; body: unknown }> {
        const res = await fetchImpl(`${base}${pathName}`, {
            method,
            headers: headers(true),
            ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
            signal: AbortSignal.timeout(15_000),
        });
        return { status: res.status, body: await res.json().catch(() => ({})) };
    }

    async function managerYaml(
        pathName: string,
        yaml: string,
        dryRun: boolean,
    ): Promise<{ status: number; body: unknown }> {
        const suffix = dryRun ? '?dry_run=1' : '';
        const res = await fetchImpl(`${base}${pathName}${suffix}`, {
            method: 'PUT',
            headers: headers(false),
            body: yaml,
            signal: AbortSignal.timeout(15_000),
        });
        return { status: res.status, body: await res.json().catch(() => ({})) };
    }

    const errText = (body: unknown): string => {
        if (body && typeof body === 'object' && 'error' in body) {
            return String((body as { error: unknown }).error);
        }
        return 'unknown error';
    };

    async function apply(
        input: ApplyBody,
    ): Promise<{ status: number; body: Record<string, unknown>; note?: string }> {
        const target = (input.target ?? '').trim();

        if (target === 'pipeline' || target.startsWith('flow:')) {
            const yaml = input.body ?? '';
            if (yaml.trim().length === 0) {
                return { status: 422, body: { error: 'body (yaml) is required' } };
            }
            const pathName = target === 'pipeline'
                ? '/pipeline'
                : `/flows/${encodeURIComponent(target.slice('flow:'.length))}`;
            // Dry-run first: an invalid file must never land on disk, and
            // the loader's message goes back to the thread verbatim.
            const dry = await managerYaml(pathName, yaml, true);
            if (dry.status !== 200) {
                return {
                    status: 422,
                    body: { error: `validation failed: ${errText(dry.body)}` },
                };
            }
            const put = await managerYaml(pathName, yaml, false);
            if (put.status !== 200) {
                return { status: 502, body: { error: errText(put.body) } };
            }
            let reloadNote = '';
            try {
                const r = deps.reloadFlows?.();
                if (r) reloadNote = ` Flows hot-reloaded (${r.flowIds.length} loaded).`;
            } catch (err) {
                reloadNote = ' Flow reload failed — restart the worker to pick the change up.';
                deps.logger?.warn('chat-config-apply: flow reload failed', {
                    error: err instanceof Error ? err.message : String(err),
                });
            }
            return {
                status: 200,
                body: { applied: true, target },
                note: `Config change applied: ${target}.${reloadNote}`,
            };
        }

        if (target.startsWith('persona:')) {
            const role = target.slice('persona:'.length);
            const content = input.body ?? '';
            if (content.trim().length === 0) {
                return { status: 422, body: { error: 'body (markdown) is required' } };
            }
            const put = await managerJson(
                'PUT',
                `/agent-md/${encodeURIComponent(role)}`,
                { content },
            );
            if (put.status !== 200) {
                return { status: 502, body: { error: errText(put.body) } };
            }
            return {
                status: 200,
                body: { applied: true, target },
                note: `Config change applied: ${target} (takes effect on the next ${role} spawn).`,
            };
        }

        if (target.startsWith('project-context:')) {
            const projectId = target.slice('project-context:'.length);
            const content = input.body ?? '';
            // An empty body legitimately CLEARS the context through the
            // manager-api route, and that is the right default for the UI
            // — but not from here. The agent reaching this path with an
            // empty Body means it dropped the section, and wiping the
            // operator's architecture description on a formatting slip is
            // not a mistake they can undo from the thread.
            if (content.trim().length === 0) {
                return {
                    status: 422,
                    body: {
                        error: 'body (the COMPLETE new markdown) is required. To CLEAR '
                            + 'a project context, do it from the board or manager UI.',
                    },
                };
            }
            const put = await managerJson(
                'PUT',
                `/projects/${encodeURIComponent(projectId)}/context-md`,
                { content },
            );
            if (put.status !== 200) {
                // 422 is the truncation guard, 404 an unknown project.
                // Both name the real problem, so pass them through rather
                // than flattening to "apply failed".
                return {
                    status: put.status === 422 || put.status === 404 ? put.status : 502,
                    body: { error: errText(put.body) },
                };
            }
            return {
                status: 200,
                body: { applied: true, target },
                note: `Project context updated: ${projectId}. It reaches the next `
                    + 'planner / decomposer / architect run after the worker reloads '
                    + 'config.',
            };
        }

        if (target.startsWith('setting:')) {
            const key = target.slice('setting:'.length);
            const listing = await managerJson('GET', '/settings');
            const rows = (listing.body as { settings?: Array<Record<string, unknown>> })
                ?.settings ?? [];
            const row = rows.find((r) => r.key === key);
            if (!row) {
                return { status: 422, body: { error: `unknown setting "${key}"` } };
            }
            const secret = row.secret === true;
            if (secret && (input.body ?? '').length > 0) {
                return {
                    status: 422,
                    body: {
                        error: `"${key}" is a secret — its value must not travel through `
                            + 'the chat agent. Confirm the proposal and enter the value '
                            + 'when prompted.',
                    },
                };
            }
            const value = secret ? input.operatorValue : (input.operatorValue ?? input.body);
            if (secret && (value ?? '').length === 0) {
                return { status: 200, body: { needsSecretValue: true, key } };
            }
            if ((value ?? '').length === 0) {
                return { status: 422, body: { error: 'a non-empty value is required' } };
            }
            const put = await managerJson(
                'PUT',
                `/settings/${encodeURIComponent(key)}`,
                { value },
            );
            if (put.status !== 200) {
                return { status: 502, body: { error: errText(put.body) } };
            }
            return {
                status: 200,
                body: { applied: true, target },
                note: `Config change applied: setting ${key}${secret ? ' (secret)' : ''}.`,
            };
        }

        if (target.startsWith('agent:')) {
            const role = target.slice('agent:'.length);
            const listing = await managerJson('GET', '/agents');
            const agents = (listing.body as { agents?: Array<Record<string, unknown>> })
                ?.agents ?? [];
            // Newest record per role wins — mirror the orchestrator's
            // AgentConfigResolver.
            const existing = agents
                .filter((a) => a.role === role)
                .sort((a, b) => Number(b.updatedAt ?? 0) - Number(a.updatedAt ?? 0))[0];
            const payload = {
                name: String(existing?.name ?? role),
                role,
                provider: input.provider ?? String(existing?.provider ?? ''),
                model: input.model ?? String(existing?.model ?? ''),
                prompt: String(existing?.prompt ?? ''),
            };
            const put = existing?.agentId
                ? await managerJson(
                    'PUT',
                    `/agents/${encodeURIComponent(String(existing.agentId))}`,
                    payload,
                )
                : await managerJson('POST', '/agents', payload);
            if (put.status >= 300) {
                return { status: 502, body: { error: errText(put.body) } };
            }
            return {
                status: 200,
                body: { applied: true, target },
                note: `Config change applied: ${target} — `
                    + `${input.model ? `model=${input.model} ` : ''}`
                    + `${input.provider ? `provider=${input.provider}` : ''}`.trim()
                    + ' (applies on the next spawn).',
            };
        }

        return { status: 422, body: { error: `unknown target "${target}"` } };
    }

    return {
        handle(req, res): boolean {
            const pathname = (req.url ?? '/').split('?', 1)[0];
            if (pathname !== CHAT_CONFIG_APPLY_ROUTE) return false;
            if ((req.method ?? '') !== 'POST') {
                respond(res, 405, { error: 'method not allowed' });
                return true;
            }
            readBody(req)
                .then(async (raw) => {
                    let input: ApplyBody;
                    try {
                        input = JSON.parse(raw) as ApplyBody;
                    } catch {
                        respond(res, 400, { error: 'invalid JSON body' });
                        return;
                    }
                    const result = await apply(input);
                    // In-thread outcome note (success OR failure) so the
                    // operator sees it and the agent learns it next turn.
                    const sessionId = input.sessionId;
                    if (sessionId && deps.appendSystemNote) {
                        const noteText = result.note
                            ?? (result.status === 200 && result.body.needsSecretValue
                                ? undefined
                                : `Config change FAILED for ${input.target}: ${errText(result.body)}`);
                        if (noteText) {
                            try {
                                deps.appendSystemNote(sessionId, noteText);
                            } catch { /* note is best-effort */ }
                        }
                    }
                    respond(res, result.status, result.body);
                })
                .catch((err) => {
                    deps.logger?.error('chat-config-apply: failed', {
                        error: err instanceof Error ? err.message : String(err),
                    });
                    respond(res, 502, {
                        error: `manager-api unreachable: ${err instanceof Error ? err.message : String(err)}`,
                    });
                });
            return true;
        },
    };
}

function readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        let total = 0;
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => {
            total += c.length;
            if (total > MAX_BODY_BYTES) {
                reject(new Error('body too large'));
                req.destroy();
                return;
            }
            chunks.push(c);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

function respond(
    res: http.ServerResponse,
    status: number,
    body: unknown,
): void {
    const raw = JSON.stringify(body);
    res.writeHead(status, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(raw),
    });
    res.end(raw);
}
