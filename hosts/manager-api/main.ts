import * as http from 'node:http';
import * as path from 'node:path';

import { getStateDbPath } from '../../config/env';
import { authorize } from '../../adapters/board-http/auth';
import { NoopAgentRunKiller } from '../../adapters/claude-cli/NoopAgentRunKiller';
import {
    createConfigStore,
    resolveConfigStoreOptions,
    type ConfigStoreYamlSection,
} from '../../adapters/config-store/createConfigStore';
import {
    AGENT_PROJECTION_SUBSCRIBER,
    AgentProjectionStore,
} from '../../adapters/projections/agent-projection-store';
import {
    PROJECT_PROJECTION_SUBSCRIBER,
    ProjectProjectionStore,
} from '../../adapters/projections/project-projection-store';
import { CommandBus } from '../../core/commands/bus';
import { EventBus } from '../../core/events/bus';
import { EventStore } from '../../core/events/store';
import type { ConfigStore } from '../../core/ports/ConfigStore';
import {
    getProjectContextMd,
    putProjectContextMd,
} from './project-context';
import type { IdGen } from '../../core/ports/IdGen';
import type { Logger } from '../../core/ports/Logger';
import { applyMigrations, openDatabase, type Db } from '../../core/state/migrations';

import { registerBoardUiCommands } from '../board-ui/commands';
import { loadDotenv } from '../loadDotenv';
import {
    activeProfileHome,
    configStoreRootDefaults,
    readLayeredPipelineDoc,
} from '../../config/profile';
import { resolvePacks, type PackManifest } from '../../config/packs';
import { SqliteProjectsReadStore } from '../worker-api/routes/projects';
import {
    deleteAgent,
    deleteProject,
    generateAgentMd,
    acknowledgeDefault,
    getAgentMd,
    getProfileStatus,
    resetAgentMd,
    resetFlow,
    resetPipeline,
    getAgentModel,
    getAgentProviders,
    getAgentRoles,
    getAgents,
    getFlow,
    getModels,
    getPipeline,
    getProjects,
    getRepoTiers,
    getSettings,
    getStepKinds,
    listFlows,
    postAgent,
    postProject,
    postReload,
    postFlowChat,
    putSetting,
    deleteSetting,
    putAgent,
    putAgentMd,
    putAgentModel,
    putFlow,
    putPipeline,
    putProject,
    registerManagerApiCommands,
    type AgentsReadPort,
    type CommandRoutesOptions,
    type ProjectsReadPort,
    type RouteResult,
    type WriteRoutesOptions,
} from './routes';
import {
    getGithubAccounts,
    putGithubAccounts,
    testGithubAccount,
} from './github-accounts-routes';
import { runGhForAccount } from './gh-exec';

/**
 * Composition root for the manager-api process (AP-NVP-028 / P-SM-004).
 *
 * The read-only config surface (AP-NVP-028) is now the front half of a
 * full CQRS composition root. In addition to the static-config routes it
 * opens the shared sqlite state DB, builds an EventStore → EventBus →
 * CommandBus, registers both the board-ui and manager-api command
 * vocabularies on that single bus, wires the projects/agents read-model
 * projections, and constructs a `ConfigStore` for per-role model
 * overrides.
 *
 * Routes (the manager-board proxy strips the `/api` prefix, so these are
 * the bare paths this host serves):
 *   - `GET  /health`               — liveness, no auth
 *   - `GET  /pipeline`             — parsed pipeline.yaml
 *   - `GET  /flows`                — list of flow names under config/flows/
 *   - `GET  /flows/:name`          — parsed single flow YAML, 404 if missing
 *   - `GET  /models`               — default_models block from pipeline.yaml
 *   - `PUT  /pipeline`             — replace pipeline.yaml (atomic, validated)
 *   - `PUT  /flows/:name`          — replace one flow YAML (atomic, validated)
 *   - `GET  /agent-models/:role`   — per-role model override (state port)
 *   - `PUT  /agent-models/:role`   — persist a per-role override
 *   - `GET  /projects`             — active projects (projection read model)
 *   - `POST /projects`             — CreateProject command
 *   - `PUT  /projects/:projectId`  — UpdateProject command
 *   - `DELETE /projects/:projectId`— ArchiveProject command
 *   - `GET  /agents`               — active agents (projection read model)
 *   - `POST /agents`               — CreateAgent command
 *   - `PUT  /agents/:agentId`      — UpdateAgent command
 *   - `DELETE /agents/:agentId`    — DeleteAgent command
 *   - `GET  /step-kinds`           — static step-kind enum
 *   - `GET  /repo-tiers`           — static repo-tier enum
 *   - `GET  /agent-providers`      — static provider enum
 *   - `GET  /agent-roles`          — role vocabulary + per-role fallback config
 *   - `GET  /settings`             — curated runtime settings (secrets masked)
 *   - `PUT  /settings/:key`        — store a setting (applied on restart)
 *   - `DELETE /settings/:key`      — remove an override (back to .env)
 *   - `POST /reload`               — operator "Apply": forwards to the
 *                                    worker-api's /api/reload-flows (hot-reload)
 *   (PUT /pipeline and PUT /flows/:name accept `?dry_run=1` — full
 *   validation, no write — backing the UI's Validate button.)
 *
 * Config files are re-read from disk on every request — there is no
 * in-memory cache — so a manual edit under `config/` is visible on the
 * next GET.
 *
 * Auth: when `authToken` is set, every endpoint other than `/health`
 * requires `Authorization: Bearer <token>` with constant-time compare.
 * When unset the server runs unauthenticated and logs a warning at start
 * (matches the worker-api convention for localhost-only setups).
 */

export const DEFAULT_PORT = 4102;
const DEFAULT_HOST = '127.0.0.1';


const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'PUT', 'POST', 'DELETE']);

const FLOW_PATH_RE = /^\/flows\/([^/]+)\/?$/;
const AGENT_MODEL_PATH_RE = /^\/agent-models\/([^/]+)\/?$/;
const PROJECT_ID_PATH_RE = /^\/projects\/([^/]+)\/?$/;
const AGENT_ID_PATH_RE = /^\/agents\/([^/]+)\/?$/;
const SETTING_KEY_PATH_RE = /^\/settings\/([^/]+)\/?$/;
const AGENT_MD_PATH_RE = /^\/agent-md\/([^/]+)\/?$/;
/** `POST /flows/<name>/chat` — the manager UI's flow assistant. */
const FLOW_CHAT_PATH_RE = /^\/flows\/([^/]+)\/chat\/?$/;
/** GitHub account registry — see github-accounts-routes.ts. */
const GH_ACCOUNTS_RE = /^\/github-accounts\/?$/;
const GH_ACCOUNT_TEST_RE = /^\/github-accounts\/([^/]+)\/test\/?$/;

const AGENT_MD_GENERATE_PATH_RE = /^\/agent-md\/([^/]+)\/generate\/?$/;
/** Project architecture context (`projects.context_md`, migration 034). */
const PROJECT_CONTEXT_MD_PATH_RE = /^\/projects\/([^/]+)\/context-md\/?$/;

export interface ManagerApiOptions {
    readonly port?: number;
    readonly host?: string;
    readonly authToken?: string;
    readonly configDir?: string;
    /**
     * The operator profile every config write lands in. Undefined = the
     * process's active profile (set by `main()` via loadDotenv); `null`
     * forces the legacy single-layer mode tests rely on.
     */
    readonly profileHome?: string | null;
    readonly logger?: Logger;
    /**
     * Path to the shared sqlite state DB. Defaults to `getStateDbPath()` —
     * the SAME resolution the orchestrator uses, which is what keeps the
     * two processes on one file. Tests inject a temp-file path so each
     * suite gets an isolated projection DB.
     */
    readonly dbPath?: string;
    /**
     * Overrides forwarded to write handlers. Tests inject `lockPath` so
     * concurrent suites don't fight over `shared/.cache/manager-api.lock`,
     * and `lock.waitMs` to control fail-fast vs. wait-and-retry behaviour.
     */
    readonly write?: Pick<WriteRoutesOptions, 'lockPath' | 'lock'>;
    /**
     * Origin of the worker-api hosting the live orchestrator — the target
     * of the operator "Apply" (`POST /reload` forwards there). Defaults to
     * `WORKER_API_URL` (env) then `http://127.0.0.1:4101`.
     */
    readonly workerApiUrl?: string;
    /** Injectable fetch for tests of the reload forward. */
    readonly fetchImpl?: typeof fetch;
}

const MAX_BODY_BYTES = 1 * 1024 * 1024; // 1 MiB — config YAML never gets this big.

export interface ManagerApiHandle {
    readonly port: number;
    stop(): Promise<void>;
}

function defaultLogger(): Logger {
    /* eslint-disable no-console */
    return {
        info: (m, meta) => console.log(`[info ] ${m}`, meta ?? ''),
        warn: (m, meta) => console.warn(`[warn ] ${m}`, meta ?? ''),
        error: (m, meta) => console.error(`[error] ${m}`, meta ?? ''),
        debug: (m, meta) => console.debug(`[debug] ${m}`, meta ?? ''),
    };
    /* eslint-enable no-console */
}

export async function start(options: ManagerApiOptions = {}): Promise<ManagerApiHandle> {
    const logger = options.logger ?? defaultLogger();
    const port = options.port ?? DEFAULT_PORT;
    // MANAGER_API_HOST widens the bind address for multi-machine setups
    // (e.g. a Tailscale IP so the management UI on another machine can
    // reach this API). Defaults to loopback-only.
    const host = options.host ?? process.env.MANAGER_API_HOST ?? DEFAULT_HOST;
    const authToken = options.authToken ?? process.env.WORKER_API_TOKEN_V2;
    const configDir =
        options.configDir ?? path.resolve(__dirname, '..', '..', 'config');
    const profileHome = options.profileHome === undefined
        ? activeProfileHome()
        : (options.profileHome ?? undefined);
    // Enabled packs, from the same layered pipeline.yaml the orchestrator
    // reads. An unknown pack stops startup here, naming the packs that
    // exist, exactly as it stops the worker.
    const packs = resolvePacks(
        (readConfigDoc(configDir, profileHome) as { packs?: unknown } | undefined)?.packs,
    );
    const dbPath = options.dbPath ?? getStateDbPath();

    if (!authToken) {
        logger.warn(
            'manager-api: WORKER_API_TOKEN_V2 unset — running unauthenticated (localhost-only mode)',
        );
    }
    if (host !== '127.0.0.1' && host !== 'localhost' && authToken === undefined) {
        logger.warn('manager-api: binding non-loopback host WITHOUT auth — set WORKER_API_TOKEN_V2', { host });
    }

    // --- State DB + CQRS wiring ---------------------------------------------
    // Open the same sqlite DB the orchestrator/board-ui use so the commands
    // this host emits and the projections it reads stay consistent with the
    // rest of the pipeline. `applyMigrations` is idempotent — a DB already
    // migrated by the orchestrator is a no-op.
    const db = openDatabase(dbPath);
    applyMigrations(db);

    const eventBus = new EventBus(new EventStore(db), logger);
    const commandBus = new CommandBus<unknown>(eventBus, () => undefined);

    // Register both operator-facing command vocabularies on the single bus.
    // The board-ui set owns project/plan/task/note CRUD (we surface only
    // project CRUD here); the manager-api set owns agent CRUD. There is no
    // live claude process in this host, so `CancelAgentRun` binds against a
    // no-op killer — the same fallback board-ui uses under AGENT_RUNNER=fake.
    const idGen = defaultIdGen();
    const clock = (): number => Date.now();
    registerBoardUiCommands(commandBus, {
        clock,
        idGen,
        logger,
        runner: new NoopAgentRunKiller({ logger }),
    });
    registerManagerApiCommands(commandBus, { clock, idGen, logger });

    // Per-role model overrides live in the ConfigStore (kind `AgentModels`),
    // not pipeline.yaml — resolved from the same `config_store:` section +
    // `PIPELINE_STORE_*` env overlay the orchestrator uses.
    const configStoreOptions = resolveConfigStoreOptions(
        readConfigStoreSection(configDir, profileHome),
        process.env,
        configStoreRootDefaults(profileHome),
    );
    const { configStore } = createConfigStore(configStoreOptions, { logger });

    // Read-model projections. Each constructor wires its own subscriptions
    // against the bus; `replayMissed` re-folds any events appended while
    // this process was down so a restart recovers the read model. The
    // projects read side reuses the worker-api's projection reader over the
    // `projects` table; agents read straight from their projection store.
    const projectsReadStore = new SqliteProjectsReadStore(db);
    new ProjectProjectionStore(db, eventBus);
    const agentProjectionStore = new AgentProjectionStore(db, eventBus);
    for (const subscriber of [PROJECT_PROJECTION_SUBSCRIBER, AGENT_PROJECTION_SUBSCRIBER]) {
        await eventBus.replayMissed(subscriber);
    }

    const ctx: HandleCtx = {
        db,
        configDir,
        profileHome,
        packs,
        authToken,
        logger,
        write: options.write,
        configStore,
        commandBus,
        projects: projectsReadStore,
        agents: agentProjectionStore,
        clock,
        actor: 'operator',
        workerApiUrl:
            options.workerApiUrl ?? process.env.WORKER_API_URL ?? 'http://127.0.0.1:4101',
        // Same shared secret both APIs authenticate with — the reload
        // forward reuses it as the upstream bearer.
        workerApiToken: authToken,
        fetchImpl: options.fetchImpl,
    };

    const server = http.createServer((req, res) => {
        handle(req, res, ctx);
    });

    const bound = await new Promise<number>((resolve, reject) => {
        const onError = (err: Error): void => reject(err);
        server.once('error', onError);
        server.listen(port, host, () => {
            server.removeListener('error', onError);
            const addr = server.address();
            if (!addr || typeof addr === 'string') {
                reject(new Error('manager-api: listen returned no address'));
                return;
            }
            resolve(addr.port);
        });
    });

    logger.info('manager-api: listening', {
        host,
        port: bound,
        configDir,
        profileHome: profileHome ?? null,
        dbPath,
        authEnabled: authToken !== undefined,
    });

    return {
        port: bound,
        stop(): Promise<void> {
            return new Promise((resolve) => {
                server.close(() => {
                    // Close the DB handle only after the HTTP server has
                    // drained; an in-flight request could still be reading.
                    try {
                        db.close();
                    } catch {
                        /* already closed / never opened — safe to ignore */
                    }
                    resolve();
                });
                const closeAll = (
                    server as { closeAllConnections?: () => void }
                ).closeAllConnections;
                if (typeof closeAll === 'function') {
                    closeAll.call(server);
                }
            });
        },
    };
}

/**
 * Read the `config_store:` section out of `<configDir>/pipeline.yaml` so
 * the ConfigStore backend selection matches the orchestrator's. Best
 * effort: a missing/malformed file or absent section yields `undefined`,
 * and `resolveConfigStoreOptions` then falls back to the `PIPELINE_STORE_*`
 * env overlay and the `fs` default.
 */
function readConfigStoreSection(
    configDir: string,
    profileHome: string | undefined,
): ConfigStoreYamlSection | undefined {
    let doc: unknown;
    try {
        // Same layered view the orchestrator reads, so the two processes
        // open the same store.
        doc = readLayeredPipelineDoc({ repoConfigDir: configDir, home: profileHome ?? null }).doc;
    } catch {
        return undefined;
    }
    if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
        return undefined;
    }
    const section = (doc as Record<string, unknown>).config_store;
    if (typeof section !== 'object' || section === null || Array.isArray(section)) {
        return undefined;
    }
    return section as ConfigStoreYamlSection;
}

/**
 * Counter-based id generator for the two command vocabularies. Agents and
 * projects created without a client-supplied id get a
 * `mgr-<pid>-<ts>-<n>` id; the operator can rename via the edit path
 * afterward, so a human-readable id is unnecessary.
 */
function defaultIdGen(): IdGen {
    let counter = 0;
    return {
        newId: (): string => `mgr-${process.pid}-${Date.now()}-${++counter}`,
    };
}

interface HandleCtx {
    readonly configDir: string;
    readonly profileHome: string | undefined;
    readonly packs: readonly PackManifest[];
    readonly authToken: string | undefined;
    readonly logger: Logger;
    readonly write: Pick<WriteRoutesOptions, 'lockPath' | 'lock'> | undefined;
    readonly configStore: ConfigStore;
    /** Read side of the projections this host also folds (project context). */
    readonly db: Db;
    readonly commandBus: CommandBus<unknown>;
    readonly projects: ProjectsReadPort;
    readonly agents: AgentsReadPort;
    readonly clock: () => number;
    readonly actor: string;
    /** Target of POST /reload (worker-api origin) + its bearer token. */
    readonly workerApiUrl: string;
    readonly workerApiToken: string | undefined;
    readonly fetchImpl: typeof fetch | undefined;
}

function handle(req: http.IncomingMessage, res: http.ServerResponse, ctx: HandleCtx): void {
    const method = req.method ?? '';
    if (!ALLOWED_METHODS.has(method)) {
        respondJson(res, 405, { error: 'method not allowed' });
        return;
    }

    const pathname = (req.url ?? '/').split('?', 1)[0];

    if (pathname === '/health') {
        if (method !== 'GET' && method !== 'HEAD') {
            respondJson(res, 405, { error: 'method not allowed' });
            return;
        }
        respondJson(res, 200, { ok: true });
        return;
    }

    if (ctx.authToken !== undefined && !authorize(req.headers.authorization, ctx.authToken)) {
        res.setHeader('WWW-Authenticate', 'Bearer');
        respondJson(res, 401, { error: 'unauthorized' });
        return;
    }

    route(req, res, ctx, method, pathname).catch((err) => {
        ctx.logger.error('manager-api: handler failed', {
            method,
            url: req.url,
            error: (err as Error).message,
        });
        if (!res.headersSent) {
            respondJson(res, 500, {
                error: 'internal error',
                message: (err as Error).message,
            });
        }
    });
}

/**
 * Method-aware router. Reads (GET/HEAD) and body-less DELETEs dispatch
 * directly; PUT/POST buffer the request body first (413 on overflow).
 * A `null` result from any dispatcher means "no route matched" → 404.
 */
async function route(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    ctx: HandleCtx,
    method: string,
    pathname: string,
): Promise<void> {
    if (method === 'GET' || method === 'HEAD') {
        // `?layer=default`: the built-in version alone (the UI's "Show
        // default"). A read with no profile IS the default layer, so the
        // same routes serve it — no second code path to drift.
        const query = (req.url ?? '').split('?')[1] ?? '';
        const defaultLayer = /(?:^|&)layer=default(?:&|$)/.test(query);
        sendResult(res, await dispatchRead(defaultLayer ? { ...ctx, profileHome: undefined } : ctx, pathname));
        return;
    }
    if (method === 'DELETE') {
        sendResult(res, await dispatchDelete(ctx, pathname));
        return;
    }
    // PUT / POST — both carry a request body.
    const body = await readBodyOr413(req, res);
    if (body === null) return;
    const contentType = req.headers['content-type'];
    if (method === 'PUT') {
        // `?dry_run=1|true` (Phase 4 "real Validate"): the YAML write
        // handlers run their full validation and stop before the write.
        const query = (req.url ?? '').split('?')[1] ?? '';
        const dryRun = /(?:^|&)dry_run=(1|true)(?:&|$)/.test(query);
        sendResult(res, await dispatchPut(ctx, pathname, body, contentType, dryRun));
        return;
    }
    sendResult(res, await dispatchPost(ctx, pathname, body, contentType));
}

function sendResult(res: http.ServerResponse, result: RouteResult | null): void {
    if (!result) {
        respondJson(res, 404, { error: 'not found' });
        return;
    }
    respondJson(res, result.status, result.body);
}

async function dispatchRead(
    ctx: HandleCtx,
    pathname: string,
): Promise<RouteResult | null> {
    if (pathname === '/pipeline') return getPipeline(layerOpts(ctx));
    if (pathname === '/flows') return listFlows(layerOpts(ctx));
    if (pathname === '/models') return getModels(layerOpts(ctx));
    if (pathname === '/profile') return getProfileStatus(layerOpts(ctx));
    if (pathname === '/projects') return getProjects({ projects: ctx.projects });
    if (pathname === '/agents') return getAgents({ agents: ctx.agents });
    if (pathname === '/step-kinds') return getStepKinds();
    if (pathname === '/repo-tiers') return getRepoTiers();
    if (pathname === '/agent-providers') return getAgentProviders();
    if (pathname === '/agent-roles') return getAgentRoles(layerOpts(ctx));
    if (pathname === '/settings') return getSettings({ configStore: ctx.configStore });
    if (GH_ACCOUNTS_RE.test(pathname)) return getGithubAccounts(layerOpts(ctx));
    const flowMatch = FLOW_PATH_RE.exec(pathname);
    if (flowMatch) {
        return getFlow(layerOpts(ctx), decodeURIComponent(flowMatch[1]));
    }
    const modelMatch = AGENT_MODEL_PATH_RE.exec(pathname);
    if (modelMatch) {
        return getAgentModel(
            { ...layerOpts(ctx), configStore: ctx.configStore },
            decodeURIComponent(modelMatch[1]),
        );
    }
    const mdMatch = AGENT_MD_PATH_RE.exec(pathname);
    if (mdMatch) {
        return getAgentMd(
            { ...layerOpts(ctx), logger: ctx.logger },
            decodeURIComponent(mdMatch[1]),
        );
    }
    const ctxMatch = PROJECT_CONTEXT_MD_PATH_RE.exec(pathname);
    if (ctxMatch) {
        return getProjectContextMd(
            {
                db: ctx.db,
                commandBus: ctx.commandBus,
                actor: ctx.actor,
                clock: ctx.clock,
                logger: ctx.logger,
            },
            decodeURIComponent(ctxMatch[1]),
        );
    }
    return null;
}

async function dispatchPut(
    ctx: HandleCtx,
    pathname: string,
    body: string,
    contentType: string | undefined,
    dryRun = false,
): Promise<RouteResult | null> {
    const writeOpts: WriteRoutesOptions = {
        ...layerOpts(ctx),
        ...(ctx.write?.lockPath !== undefined ? { lockPath: ctx.write.lockPath } : {}),
        ...(ctx.write?.lock !== undefined ? { lock: ctx.write.lock } : {}),
    };

    if (pathname === '/pipeline') return putPipeline(writeOpts, body, contentType, dryRun);
    if (GH_ACCOUNTS_RE.test(pathname)) {
        // JSON, not YAML: the panel submits a list of structured
        // accounts and the route turns it into the yaml block, so the
        // operator never hand-assembles the mapping.
        return putGithubAccounts(writeOpts, body, dryRun);
    }
    const flowMatch = FLOW_PATH_RE.exec(pathname);
    if (flowMatch) {
        return putFlow(writeOpts, decodeURIComponent(flowMatch[1]), body, contentType, dryRun);
    }
    const modelMatch = AGENT_MODEL_PATH_RE.exec(pathname);
    if (modelMatch) {
        return putAgentModel(
            { ...layerOpts(ctx), configStore: ctx.configStore },
            decodeURIComponent(modelMatch[1]),
            body,
            contentType,
        );
    }
    const projectMatch = PROJECT_ID_PATH_RE.exec(pathname);
    if (projectMatch) {
        return putProject(commandOpts(ctx), decodeURIComponent(projectMatch[1]), body, contentType);
    }
    const agentMatch = AGENT_ID_PATH_RE.exec(pathname);
    if (agentMatch) {
        return putAgent(commandOpts(ctx), decodeURIComponent(agentMatch[1]), body, contentType);
    }
    const settingMatch = SETTING_KEY_PATH_RE.exec(pathname);
    if (settingMatch) {
        return putSetting(
            {
                configStore: ctx.configStore,
                workerApiUrl: ctx.workerApiUrl,
                ...(ctx.workerApiToken !== undefined
                    ? { workerApiToken: ctx.workerApiToken }
                    : {}),
                logger: ctx.logger,
            },
            decodeURIComponent(settingMatch[1]),
            body,
            contentType,
        );
    }
    const mdMatch = AGENT_MD_PATH_RE.exec(pathname);
    if (mdMatch) {
        return putAgentMd(
            { ...layerOpts(ctx), logger: ctx.logger },
            decodeURIComponent(mdMatch[1]),
            body,
            contentType,
        );
    }
    const ctxMatch = PROJECT_CONTEXT_MD_PATH_RE.exec(pathname);
    if (ctxMatch) {
        return putProjectContextMd(
            {
                db: ctx.db,
                commandBus: ctx.commandBus,
                actor: ctx.actor,
                clock: ctx.clock,
                logger: ctx.logger,
            },
            decodeURIComponent(ctxMatch[1]),
            body,
            contentType,
        );
    }
    return null;
}

async function dispatchPost(
    ctx: HandleCtx,
    pathname: string,
    body: string,
    contentType: string | undefined,
): Promise<RouteResult | null> {
    if (pathname === '/projects') return postProject(commandOpts(ctx), body, contentType);
    if (pathname === '/agents') return postAgent(commandOpts(ctx), body, contentType);
    if (pathname === '/profile/acknowledge') {
        return acknowledgeDefault(layerOpts(ctx), body, contentType);
    }
    if (pathname === '/reload') {
        return postReload({
            workerApiUrl: ctx.workerApiUrl,
            ...(ctx.workerApiToken !== undefined
                ? { workerApiToken: ctx.workerApiToken }
                : {}),
            ...(ctx.fetchImpl !== undefined ? { fetchImpl: ctx.fetchImpl } : {}),
            logger: ctx.logger,
        });
    }
    const ghTestMatch = GH_ACCOUNT_TEST_RE.exec(pathname);
    if (ghTestMatch) {
        return testGithubAccount(
            layerOpts(ctx),
            { exec: runGhForAccount },
            decodeURIComponent(ghTestMatch[1]),
        );
    }
    const flowChatMatch = FLOW_CHAT_PATH_RE.exec(pathname);
    if (flowChatMatch) {
        let parsed: unknown = {};
        try {
            parsed = body.trim().length > 0 ? JSON.parse(body) : {};
        } catch {
            return { status: 400, body: { error: 'invalid JSON body' } };
        }
        return postFlowChat(decodeURIComponent(flowChatMatch[1]), parsed, {
            workerApiUrl: ctx.workerApiUrl,
            ...(ctx.workerApiToken !== undefined
                ? { workerApiToken: ctx.workerApiToken }
                : {}),
            ...(ctx.fetchImpl !== undefined ? { fetchImpl: ctx.fetchImpl } : {}),
            logger: ctx.logger,
        });
    }
    const mdGenMatch = AGENT_MD_GENERATE_PATH_RE.exec(pathname);
    if (mdGenMatch) {
        return generateAgentMd(
            { ...layerOpts(ctx), logger: ctx.logger },
            decodeURIComponent(mdGenMatch[1]),
            body,
            contentType,
        );
    }
    return null;
}

async function dispatchDelete(
    ctx: HandleCtx,
    pathname: string,
): Promise<RouteResult | null> {
    // Reset: drop the profile's copy so the built-in default applies again.
    if (pathname === '/pipeline') return resetPipeline(layerOpts(ctx));
    const flowResetMatch = FLOW_PATH_RE.exec(pathname);
    if (flowResetMatch) return resetFlow(layerOpts(ctx), decodeURIComponent(flowResetMatch[1]));
    const mdResetMatch = AGENT_MD_PATH_RE.exec(pathname);
    if (mdResetMatch) {
        return resetAgentMd({ ...layerOpts(ctx), logger: ctx.logger }, decodeURIComponent(mdResetMatch[1]));
    }
    const projectMatch = PROJECT_ID_PATH_RE.exec(pathname);
    if (projectMatch) {
        return deleteProject(commandOpts(ctx), decodeURIComponent(projectMatch[1]));
    }
    const agentMatch = AGENT_ID_PATH_RE.exec(pathname);
    if (agentMatch) {
        return deleteAgent(commandOpts(ctx), decodeURIComponent(agentMatch[1]));
    }
    const settingMatch = SETTING_KEY_PATH_RE.exec(pathname);
    if (settingMatch) {
        return deleteSetting(
            { configStore: ctx.configStore },
            decodeURIComponent(settingMatch[1]),
        );
    }
    return null;
}

function commandOpts(ctx: HandleCtx): CommandRoutesOptions {
    return {
        commandBus: ctx.commandBus,
        clock: ctx.clock,
        actor: ctx.actor,
        configDir: ctx.configDir,
        logger: ctx.logger,
        ...(ctx.profileHome !== undefined ? { profileHome: ctx.profileHome } : {}),
    };
}

/** The repo config dir, enabled packs and active profile — every layered route's options. */
function layerOpts(ctx: HandleCtx): { configDir: string; profileHome?: string; packs: readonly PackManifest[] } {
    return {
        configDir: ctx.configDir,
        packs: ctx.packs,
        ...(ctx.profileHome !== undefined ? { profileHome: ctx.profileHome } : {}),
    };
}

/** The effective pipeline.yaml, or undefined when it cannot be read. */
function readConfigDoc(configDir: string, profileHome: string | undefined): unknown {
    try {
        return readLayeredPipelineDoc({ repoConfigDir: configDir, home: profileHome ?? null }).doc;
    } catch {
        return undefined;
    }
}

async function readBodyOr413(
    req: http.IncomingMessage,
    res: http.ServerResponse,
): Promise<string | null> {
    try {
        return await readBody(req);
    } catch (err) {
        if ((err as { code?: string }).code === 'BODY_TOO_LARGE') {
            respondJson(res, 413, { error: 'request body too large' });
            return null;
        }
        throw err;
    }
}

function readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let total = 0;
        req.on('data', (chunk: Buffer) => {
            total += chunk.length;
            if (total > MAX_BODY_BYTES) {
                const err = new Error('body too large') as Error & { code: string };
                err.code = 'BODY_TOO_LARGE';
                req.destroy(err);
                reject(err);
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

function respondJson(res: http.ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(payload),
    });
    res.end(payload);
}

async function main(): Promise<void> {
    loadDotenv();
    const portRaw = process.env.MANAGER_API_PORT;
    const port = portRaw ? Number(portRaw) : DEFAULT_PORT;
    if (!Number.isFinite(port) || port < 0 || port > 65535) {
        // eslint-disable-next-line no-console
        console.error(`manager-api: invalid MANAGER_API_PORT="${portRaw}"`);
        process.exit(1);
    }

    const handle = await start({ port });

    const shutdown = (signal: NodeJS.Signals): void => {
        // eslint-disable-next-line no-console
        console.log(`manager-api: received ${signal}, shutting down`);
        handle
            .stop()
            .then(() => process.exit(0))
            .catch((err) => {
                // eslint-disable-next-line no-console
                console.error('manager-api: error during shutdown', err);
                process.exit(1);
            });
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

if (require.main === module) {
    main().catch((err) => {
        // eslint-disable-next-line no-console
        console.error('manager-api: fatal startup error', err);
        process.exit(1);
    });
}
