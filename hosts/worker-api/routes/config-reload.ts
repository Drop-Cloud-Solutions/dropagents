/**
 * Worker-api route for the operator "Apply" action (Management UI Phase 4).
 *
 * `POST /api/reload-flows`
 *   Hot-reloads `config/flows/*.yaml` into the RUNNING orchestrator via
 *   `Orchestrator.reloadFlows()` — the flow engine looks flows up per
 *   dispatch from a shared map, so the swap takes effect on the next step
 *   without a restart.
 *
 * Why this lives here and not in the manager-api: the manager-api is a
 * separate process sharing only the SQLite file, and the orchestrator's
 * EventBus never re-polls the event log after boot — a cross-process
 * "reload" event would go unseen. The worker-api hosts the live
 * orchestrator in-process, so an HTTP call here is the one reliable
 * delivery path. The manager-api's `POST /reload` forwards to this route.
 *
 * Responses:
 *   200 { ok: true, flows, flowIds, note }  — reloaded
 *   422 { error }                           — a flow on disk failed the
 *                                             loader; the previous flows
 *                                             stay active untouched
 *   405                                     — non-POST
 *
 * Scope note: flows only. pipeline.yaml values are snapshotted into
 * runners/handlers at construction, and Agent records already apply live
 * from the shared DB — the `note` in the response spells that out for the
 * operator UI.
 */

import * as http from 'node:http';

import type { Logger } from '../../../core/ports/Logger';

export const RELOAD_FLOWS_ROUTE_PATTERN = /^\/api\/reload-flows\/?$/;
export const RELOAD_SETTINGS_ROUTE_PATTERN = /^\/api\/reload-settings\/?$/;

/**
 * The `note` is part of the wire contract: the management UI shows it
 * verbatim so the operator knows exactly what an Apply did and did not do.
 */
export const RELOAD_FLOWS_NOTE =
    'flows reloaded — pipeline.yaml and .env changes still need an orchestrator restart; '
    + 'Agent records (models/providers/personas) already apply live per spawn';

export interface ConfigReloadDeps {
    /** `() => orchestrator.reloadFlows()` — throws when a flow fails the loader. */
    readonly reloadFlows: () => { flowIds: string[] };
    /**
     * `() => orchestrator.reloadSettingsOverlay()` — re-applies the stored
     * curated settings onto the RUNNING worker's process.env. The
     * manager-api forwards here after a settings write so per-spawn env
     * readers (ClaudeCliRunner: CLAUDE_CODE_OAUTH_TOKEN /
     * ANTHROPIC_API_KEY) apply without a restart. Optional: absent means
     * the route 404s (older orchestrator wiring).
     */
    readonly reloadSettings?: () => Promise<{ applied: string[] }>;
    /**
     * `() => orchestrator.reloadProjectContexts()` — re-reads every
     * project's `context_md` into the cache the lifecycle prompt builder
     * reads synchronously. Rides on the flows reload because that is the
     * POST the operator's Apply already sends; without it an edited
     * project context would not reach an agent until the next restart.
     * Optional and best-effort: a failure must not fail the flows reload,
     * which is what the operator actually asked for.
     */
    readonly reloadProjectContexts?: () => Promise<{ projects: number }>;
    readonly logger?: Logger;
}

export interface ConfigReloadRouter {
    handle(req: http.IncomingMessage, res: http.ServerResponse): boolean;
}

export function createConfigReloadRouter(deps: ConfigReloadDeps): ConfigReloadRouter {
    return {
        handle(req, res): boolean {
            const url = req.url ?? '/';
            const pathname = url.split('?', 1)[0];

            if (RELOAD_SETTINGS_ROUTE_PATTERN.test(pathname)) {
                const method = req.method ?? 'GET';
                if (method !== 'POST') {
                    respond(res, 405, { error: 'method not allowed' }, { Allow: 'POST' });
                    return true;
                }
                const reloadSettings = deps.reloadSettings;
                if (!reloadSettings) {
                    respond(res, 404, { error: 'settings reload not wired on this worker' });
                    return true;
                }
                reloadSettings()
                    .then(({ applied }) => {
                        deps.logger?.info('config-reload: settings overlay re-applied', {
                            keys: applied, // key NAMES only — never values
                        });
                        respond(res, 200, {
                            ok: true,
                            applied,
                            note: 'stored settings overlaid onto the running worker — '
                                + 'per-spawn readers (agent auth token/key, model env vars) '
                                + 'apply on the next agent run; boot-snapshotted wiring '
                                + 'still needs a restart',
                        });
                    })
                    .catch((err: unknown) => {
                        const message = err instanceof Error ? err.message : String(err);
                        deps.logger?.warn('config-reload: settings reload failed', {
                            error: message,
                        });
                        respond(res, 500, { error: message });
                    });
                return true;
            }

            if (!RELOAD_FLOWS_ROUTE_PATTERN.test(pathname)) return false;

            const method = req.method ?? 'GET';
            if (method !== 'POST') {
                respond(res, 405, { error: 'method not allowed' }, { Allow: 'POST' });
                return true;
            }

            try {
                const { flowIds } = deps.reloadFlows();
                deps.logger?.info('config-reload: flows reloaded', {
                    flows: flowIds.length,
                });
                // Best-effort and deliberately not awaited into the
                // response: the operator asked for flows, and a config
                // store hiccup must not turn a successful reload into a
                // 500. The provider logs its own failure and keeps the
                // previously loaded contexts.
                void deps.reloadProjectContexts?.().catch((err: unknown) => {
                    deps.logger?.warn('config-reload: project contexts not reloaded', {
                        error: err instanceof Error ? err.message : String(err),
                    });
                });
                respond(res, 200, {
                    ok: true,
                    flows: flowIds.length,
                    flowIds,
                    note: RELOAD_FLOWS_NOTE,
                });
            } catch (err) {
                // Loader rejection (malformed YAML, unreachable step, dup id):
                // the running flows are untouched — tell the operator what to
                // fix rather than treating it as a server fault.
                const message = err instanceof Error ? err.message : String(err);
                deps.logger?.warn('config-reload: reload rejected', { error: message });
                respond(res, 422, { error: message });
            }
            return true;
        },
    };
}

function respond(
    res: http.ServerResponse,
    status: number,
    body: unknown,
    headers?: Record<string, string>,
): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(payload),
        ...(headers ?? {}),
    });
    res.end(payload);
}
