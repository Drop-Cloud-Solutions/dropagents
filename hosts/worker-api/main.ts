import * as http from 'node:http';
import * as path from 'node:path';

import { BoardHttpServer } from '../../adapters/board-http/server';
import { FileLogger } from '../../adapters/logging/file-logger';
import { SqliteDecomposeStatusStore } from '../../adapters/projections/decompose-status-store';
import { getLogFile, getTelegramBotToken, getWorkspaceRoot } from '../../config/env';
import { parsePipelineConfig } from '../../core/flow/pipeline-config';
import { activePacks, readLayeredPipelineDoc } from '../../config/profile';
import type { AgentHandle } from '../../core/ports/AgentRunner';
import type { IdGen } from '../../core/ports/IdGen';
import type { Logger } from '../../core/ports/Logger';
import type { Db } from '../../core/state/migrations';
import { getParkedTaskCount } from '../../core/state/projections';

import { loadDotenv } from '../loadDotenv';
import { Orchestrator, type OrchestratorOptions } from '../orchestrator/main';
import {
    FileSystemNotesStore,
    type NotesStore,
} from '../orchestrator/handlers/notes';
import { registerInterruptTaskHandler } from './commands/interrupt-task';
import {
    createWorkerApiHealthCheck,
    type AdapterStatusesQuery,
    type LastEventAtQuery,
    type ParkedTaskCountQuery,
} from './health';
import { createContextUpdatesRouter } from './routes/context-updates';
import type { DecomposeStatusPort } from './routes/decompose-status';
import { createNotesRouter } from './routes/notes';
import {
    createPlanReviewRouter,
    type PlanReviewStore as PlanReviewStorePort,
} from './routes/plan-review';
import { createReposRouter } from './routes/repos';
import {
    SqliteProjectsReadStore,
    createProjectsRouter,
    type ProjectsReadStore,
} from './routes/projects';
import { createTasksReadRouter } from './routes/tasks-read';
import { createFlowStagesRouter } from './routes/flow-stages';
import { createTaskTypesRouter } from './routes/task-types';
import { createActiveDecomposersRouter } from './routes/active-decomposers';
import { createConfigReloadRouter } from './routes/config-reload';
import { createProjectContextRouter } from './routes/project-context';
import { createAgentAuthRouter } from './routes/agent-auth';
import { readAgentAuthStatus } from '../../adapters/claude-cli/auth-status';
import { createTaskStepSummariesRouter } from './routes/task-step-summaries';
import { createPlansReadRouter } from './routes/plans-read';
import { createRequirementsReadRouter } from './routes/requirements-read';
import { createTaskDiffRouter } from './routes/task-diff';
import {
    createChatRouter,
    deleteChatSessionWithTeardown,
    vocabularyFromCatalog,
    type TaskTypeVocabulary,
} from './routes/chat';
import { createFlowChatRouter } from './routes/flow-chat';
import {
    createChatRetentionJob,
    resolveChatRetentionDays,
    resolveChatRetentionIntervalMs,
    type ChatRetentionJob,
} from './chat-retention';
import { createChatConfigApplyRouter } from './routes/chat-config-apply';
import { SqliteChatSessionStore } from '../../adapters/state/SqliteChatSessionStore';
import { attachChatNoteGenerator } from './chat-note-generator';
import { createTasksRouter } from './routes/tasks';
import { createDecomposerClarifyRouter } from './routes/decomposer-clarify';
import {
    CORE_REPORT_ROLES,
    createDbInvestigationReportStore,
    createDbInvestigationThreadReader,
} from '../orchestrator/handlers';
import { createWorkerLogRouter } from './routes/worker-log-tail';
import { createAttachmentsRouter } from './routes/attachments';
import { FakeChatGateway } from '../../adapters/fakes/FakeChatGateway';
import { GhPullRequestGateway } from '../../adapters/github/pr-gateway';
import { ChatClarify } from '../../adapters/telegram/chat-clarify';
import { ChatSeedResolver } from '../../adapters/telegram/chat-seed';
import { NotificationLedger } from '../../adapters/telegram/notification-ledger';
import {
    TelegramGateway,
    type ProposalConfirmer,
} from '../../adapters/telegram/TelegramGateway';
import { TaskOpsCommands, TaskParkingCommands } from '../../core/commands';
import type { ChatGateway } from '../../core/ports';
import type { CommandBus } from '../../core/commands/bus';
import type { EventBus } from '../../core/events/bus';
import { ChatService, type ChannelSessionSeed } from './chat-service';

const DEFAULT_PORT = 4101;
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_PROJECTS_ROOT = path.join(REPO_ROOT, '..', 'projects');
const DEFAULT_PIPELINE_CONFIG_PATH = path.join(REPO_ROOT, 'config', 'pipeline.yaml');

/**
 * pipeline.yaml keys whose value names a concrete adapter implementation.
 * The composition root reads these once at boot and surfaces a wired flag
 * per key on /health — driving the AP-VP7-003 `adapters` field without
 * runtime `instanceof Fake*` introspection.
 */
const ADAPTER_SELECTION_KEYS = [
    'issue_tracker',
    'agent_runner',
    'source_control',
    'chat_gateway',
] as const;

/**
 * Trio of readers the worker-api host hands to {@link createWorkerApiHealthCheck}.
 * Bundled into a single value type so the composition root passes one object
 * across module boundaries instead of three loose callbacks — and so tests
 * can substitute the aggregate via the {@link WorkerApiOptions.healthSignals}
 * seam without re-implementing the readers individually.
 */
export interface HealthSignals {
    readonly getAdapterStatuses: AdapterStatusesQuery;
    readonly getLastEventAt: LastEventAtQuery;
    readonly getParkedTaskCount: ParkedTaskCountQuery;
}

export interface WorkerApiOptions {
    readonly port?: number;
    readonly host?: string;
    readonly authToken?: string;
    readonly orchestrator?: OrchestratorOptions;
    readonly logger?: Logger;
    /**
     * Test seam: override the production `DecomposeStatusPort` adapter
     * that backs `GET /api/projects/:pid/plans/:planId/decompose-status`.
     * When unset the host constructs a {@link SqliteDecomposeStatusStore}
     * over the orchestrator's SQLite handle.
     */
    readonly decomposeStatusPort?: DecomposeStatusPort;
    /**
     * Root directory the notes routes read from. Defaults to the same
     * `<repo>/../projects` path the orchestrator host uses for its
     * notes-handler store so the two surfaces share a filesystem.
     * Honoured only when {@link WorkerApiOptions.notesStore} is unset.
     */
    readonly projectsRoot?: string;
    /**
     * Test seam: override the production {@link NotesStore} that backs
     * `GET /projects/:projectId/notes`. When unset the host constructs a
     * {@link FileSystemNotesStore} rooted at {@link WorkerApiOptions.projectsRoot}.
     */
    readonly notesStore?: NotesStore;
    /**
     * Test seam: override the production {@link ProjectsReadStore} that
     * backs `GET /api/projects` and `GET /api/projects/:pid/plans`. When
     * unset the host constructs a {@link SqliteProjectsReadStore} over
     * the orchestrator's SQLite handle.
     */
    readonly projectsReadStore?: ProjectsReadStore;
    /**
     * Test seam: override the `IdGen` used to mint a fresh noteId when a
     * `POST /projects/:projectId/notes` body omits both `noteId` and
     * `title`. Defaults to a tiny pid+timestamp+counter generator —
     * sufficient for the notes-board lifecycle since the operator can
     * always rename via the markdown file after the fact.
     */
    readonly idGen?: IdGen;
    /**
     * Path to `pipeline.yaml`, read at boot to derive the `adapters` field
     * on /health. Defaults to `<repo>/config/pipeline.yaml`. The
     * orchestrator reads the same file via `OrchestratorOptions.pipelineConfigPath`;
     * keep them in sync by passing the same value into both when overriding
     * (typical only for tests).
     */
    readonly pipelineConfigPath?: string;
    /**
     * Test seam: substitute the entire {@link HealthSignals} trio. When
     * unset the host derives the readers from `pipelineConfigPath`,
     * the orchestrator's DB handle, and `getParkedTaskCount` from
     * AP-VP7-002.
     */
    readonly healthSignals?: HealthSignals;
    /**
     * Test seam: substitute the resolved chat-gateway selection. When set, the
     * host uses it verbatim and skips reading `chat_gateway` from pipeline.yaml,
     * resolving the bot token, and constructing a real {@link TelegramGateway}.
     * This keeps boot integration tests hermetic regardless of an ambient
     * `TELEGRAM_BOT_TOKEN` (which would otherwise start a real long-poll loop).
     * Production leaves it unset.
     */
    readonly chatGatewaySelection?: ChatGatewaySelection;
}

export interface WorkerApiHandle {
    readonly port: number;
    readonly orchestrator: Orchestrator;
    stop(): Promise<void>;
}

function defaultIdGen(): IdGen {
    let counter = 0;
    return {
        newId: (): string => `note-${process.pid}-${Date.now()}-${++counter}`,
    };
}

function defaultLogger(): Logger {
    // FileLogger by default — the worker-log viewer reads from
    // `<repo>/shared/.cache/worker.log` and is useless without it.
    // `LOG_FILE` overrides only the file *path*; falling back to a
    // console-only logger when LOG_FILE was unset was the previous
    // behaviour and silently disabled the board's worker-log panel.
    const logFile = getLogFile() ?? 'worker.log';
    return new FileLogger(logFile);
}

/**
 * Composition root for the worker-api process.
 *
 * Boots an `Orchestrator` against the configured SQLite path and binds a
 * `BoardHttpServer` to it for HTTP traffic from the operator board. The
 * orchestrator owns the EventBus and CommandBus; the HTTP server forwards
 * commands into the bus and streams events back out over SSE.
 *
 * In production the worker-api typically runs as a separate process from
 * the orchestrator host, both pointed at the same SQLite database file.
 * Coordinating which process owns the live flow engine is a deployment
 * concern outside the scope of this host.
 */
export async function start(options: WorkerApiOptions = {}): Promise<WorkerApiHandle> {
    const logger = options.logger ?? defaultLogger();
    const port = options.port ?? DEFAULT_PORT;
    // WORKER_API_HOST widens the bind address for multi-machine setups
    // (e.g. 0.0.0.0 so a board on another machine can reach this API).
    // Defaults to loopback-only so nothing is exposed by accident.
    const host = options.host ?? process.env.WORKER_API_HOST ?? '127.0.0.1';
    const authToken = options.authToken ?? process.env.WORKER_API_TOKEN_V2;
    if (host !== '127.0.0.1' && host !== 'localhost' && authToken === undefined) {
        logger.warn('worker-api: binding non-loopback host WITHOUT auth — set WORKER_API_TOKEN_V2', { host });
    }

    // Bind the port BEFORE the orchestrator boots. Orchestrator.start()
    // replays the event log through every projection, which grows with
    // the log (2m14s at 85k events on the field worker) — and until the
    // socket exists the board sees ECONNREFUSED, indistinguishable from a
    // dead worker. The operator killed two healthy boots that way. This
    // bootstrap listener answers immediately: /health reports
    // status=starting, everything else gets 503 {error:'worker starting'}
    // so clients can tell "booting" from "down". It is swapped for the
    // real server (same port) once startup completes.
    const bootstrap = http.createServer((req, res) => {
        const isHealth = (req.url ?? '').split('?')[0] === '/health';
        res.writeHead(isHealth ? 200 : 503, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify(
            isHealth
                ? { status: 'starting' }
                : { error: 'worker starting', message: 'The worker is replaying its event log; retry shortly.' },
        ));
    });
    await new Promise<void>((resolve, reject) => {
        bootstrap.once('error', reject);
        bootstrap.listen(port, host, () => resolve());
    });
    logger.info('worker-api: port bound, starting orchestrator (503 until ready)', { host, port });
    const closeBootstrap = async (): Promise<void> => {
        bootstrap.closeAllConnections();
        await new Promise<void>((resolve) => bootstrap.close(() => resolve()));
    };

    const orchestrator = new Orchestrator({
        ...(options.orchestrator ?? {}),
        logger: options.orchestrator?.logger ?? logger,
    });
    try {
        await orchestrator.start();
    } catch (err) {
        await closeBootstrap();
        throw err;
    }

    const eventBus = orchestrator.getEventBus();
    const commandBus = orchestrator.getCommandBus();
    const db = orchestrator.getDb();

    // InterruptTask handler — registered exactly once, on the bus that was
    // just borrowed from the orchestrator. The `getAgentForTask` accessor
    // returns the agentId string; we wrap it in a minimal `AgentHandle` so
    // the handler can call `agentRunner.interrupt(handle)` against the
    // port without leaking the runner's internal handle table. Real
    // runners (notably ClaudeCliRunner) only read `handle.id` inside
    // `interrupt`, so a stub `spec` is safe and intentional here.
    const { agentRunner } = orchestrator.getAdapters();
    registerInterruptTaskHandler(commandBus, {
        clock: () => Date.now(),
        agentRunner,
        getAgentForTask: (taskId: string): AgentHandle | undefined => {
            const agentId = orchestrator.getAgentForTask(taskId);
            if (agentId === undefined) return undefined;
            return { id: agentId, spec: { role: 'unknown', prompt: '' } };
        },
        logger,
    });

    const pipelineConfigPath =
        options.pipelineConfigPath
        ?? options.orchestrator?.pipelineConfigPath
        ?? DEFAULT_PIPELINE_CONFIG_PATH;
    const healthSignals =
        options.healthSignals ?? buildHealthSignals(db, pipelineConfigPath, logger);
    const healthCheck = createWorkerApiHealthCheck({
        db,
        getAdapterStatuses: healthSignals.getAdapterStatuses,
        getLastEventAt: healthSignals.getLastEventAt,
        getParkedTaskCount: healthSignals.getParkedTaskCount,
        // Measure lag over the REPLAYING projectors only. Action
        // subscribers run live-only, so their offsets are not a lag
        // signal — including them made /health report 13803 pending on a
        // worker whose projections were fully caught up.
        projectionSubscribers: orchestrator.getProjectionSubscriberNames(),
    });
    const decomposeStatusPort =
        options.decomposeStatusPort ?? new SqliteDecomposeStatusStore(db);

    // AP-VP5-009: notes-board routes. Reads come from the same notes
    // handler store the orchestrator notes-handler writes to (markdown
    // file under `<projectsRoot>/<projectId>/notes.md`); writes go
    // through the shared CommandBus so the orchestrator handler owns
    // the persistence + event emission.
    const projectsRoot = options.projectsRoot ?? DEFAULT_PROJECTS_ROOT;
    const notesStore =
        options.notesStore ?? new FileSystemNotesStore(projectsRoot);
    const idGen = options.idGen ?? defaultIdGen();
    const notesRouter = createNotesRouter({
        store: notesStore,
        bus: commandBus,
        idGen,
        logger,
    });

    // AP-VP5-008: task action routes (clarify / reject /
    // investigation-followup). Thin command-dispatchers — body validation
    // + a single CommandBus.send per request. Auth is enforced by the
    // parent BoardHttpServer's Bearer-token gate, the same as every other
    // extra router on this surface.
    const tasksRouter = createTasksRouter({
        bus: commandBus,
        logger,
        // Investigation-thread read side: without this the GET route
        // answered 501 and the follow-up modal never showed the prior
        // Q&A. Derived from durable state (TaskCreated thread payloads +
        // the task's recorded report), so it needs no extra projection.
        // Report roles: core's own plus whatever the enabled packs declare
        // (`pack.yaml` → `roles: [{ report: true }]`). Without the pack's,
        // an Azure review's or diagnosis's summary would not be found and
        // the follow-up thread would silently render without it.
        threadReader: createDbInvestigationThreadReader(db, reportRoles()),
    });

    // The plan-lifecycle twin of /tasks/:id/clarify: the Answer button on a
    // decomposer card held on a `NEEDS_HUMAN_INPUT` question POSTs here.
    const decomposerClarifyRouter = createDecomposerClarifyRouter({
        bus: commandBus,
        logger,
    });

    // AP-FP-004: read-only projects + plans sidebar routes. Backed by the
    // AP-FP-001 projection tables — pure SQLite reads, no Linear fallback.
    // The adapter prepares its statements lazily so the host still boots
    // cleanly on a SQLite handle that hasn't had the projection schema
    // applied yet (the subscriber wiring lives in a separate task).
    const projectsReadStore =
        options.projectsReadStore ?? new SqliteProjectsReadStore(db);
    const projectsRouter = createProjectsRouter({
        store: projectsReadStore,
        logger,
    });

    // Stub until the post-merge curator lands. Returns `200 []` so the
    // board's sidebar polling loop sees a stable empty state instead of a
    // 404. The real implementation is Phase 5 / 7 work in the v2 plan.
    const contextUpdatesRouter = createContextUpdatesRouter({ logger });

    // Worker-log snapshot + SSE tail. Reads the same v2 worker.log file
    // that FileLogger writes (defaults to `<repo>/shared/.cache/worker.log`).
    const workerLogRouter = createWorkerLogRouter();

    // Attachments (migration 021). Upload writes bytes through the
    // orchestrator's blob-store handle (same root the orchestrator deletes
    // from) and dispatches AttachTo*/RemoveAttachment on the shared bus;
    // metadata reads come from the attachment projection. The id generator
    // is attachment-scoped so blob filenames don't collide with note ids.
    let attachmentCounter = 0;
    const attachmentsRouter = createAttachmentsRouter({
        store: orchestrator.getAttachmentStore(),
        blobStore: orchestrator.getAttachmentBlobStore(),
        bus: commandBus,
        idGen: (): string =>
            `att-${process.pid.toString(36)}-${Date.now().toString(36)}-${(attachmentCounter++).toString(36)}`,
        clock: () => Date.now(),
        logger,
    });

    // Plan-review projection — SQLite-backed, wired by the orchestrator
    // under the `plan-review-projection` subscriber so a worker-api
    // restart picks up where it left off via `bus.replayMissed`. The
    // worker-api borrows the store handle here purely as a read-side
    // port for the HTTP routes.
    const planReviewProjection = orchestrator.getPlanReviewStore();
    const planReviewStorePort: PlanReviewStorePort = {
        get: (_projectId, planId) => {
            const latest = planReviewProjection.getLatest(planId);
            if (!latest) return null;
            return {
                markdown: latest.content,
                generatedAt: latest.generatedAt,
            };
        },
        getLatestRevision: (_projectId, planId) =>
            planReviewProjection.getLatest(planId),
        getLatestNonEmptyRevision: (_projectId, planId) =>
            planReviewProjection.getLatestNonEmpty(planId),
        listPending: () => planReviewProjection.listPending(),
    };
    const planReviewRouter = createPlanReviewRouter({
        store: planReviewStorePort,
        bus: commandBus,
        clock: () => Date.now(),
        logger,
        authToken,
    });

    // Workspace repo registry — read-only routes (list + per-repo
    // detail). Writes go through the board-ui REST→Command translator
    // and land as `RegisterRepo` / `UpdateRepo` / `ArchiveRepo` /
    // `RefreshRepo` / `RefreshAllRepos` on the orchestrator's command
    // bus.
    const reposRouter = createReposRouter({
        store: orchestrator.getRepoProjectionStore(),
        logger,
        // The orchestrator already parses and caches the account block;
        // reading it from there keeps one source rather than a second
        // parse that could disagree about which ids are usable.
        githubAccountIds: () => Array.from(orchestrator.githubAccounts().keys()).sort(),
    });

    // Durable tasks read route. Backs the board's boot hydration so
    // task cards survive a worker-api restart / browser reload —
    // before this, the board only folded LIVE SSE events into its
    // in-memory `tasks` Map and any tasks decomposed in a previous
    // session vanished from view.
    const tasksReadRouter = createTasksReadRouter({ db, logger });

    // Flow-stage catalog. Projects the orchestrator's LIVE flow map (borrowed
    // by reference via `getFlows`, so an operator "Apply" hot-reload is
    // reflected) to a `flowId → FlowStage[]` catalog the board hydrates once
    // on boot to render flow-accurate stage strips per card.
    const flowStagesRouter = createFlowStagesRouter({
        getFlows: () => orchestrator.getFlows(),
        logger,
    });

    // What this install can do — the board's Add-task menu and new-plan
    // "Plan type" dropdown, from the live flows and the enabled packs.
    const taskTypesRouter = createTaskTypesRouter({
        catalog: () => orchestrator.taskTypes(),
        packArchetypes: () => activePacks().flatMap((p) => p.archetypes),
        logger,
    });

    // Active decomposers — surfaces in-flight decomposer agent runs so
    // the board's decomposer cards stay on screen across a page reload.
    // Derived from the event log (`AgentStarted` minus its terminal
    // pair) so a worker-api restart still picks up runs that are still
    // alive on the spawned child process.
    const activeDecomposersRouter = createActiveDecomposersRouter({ db, logger });

    // Per-step agent run records — backs the stage-bar chips' status
    // colours and the click-to-see-summary modal on the board.
    const taskStepSummariesRouter = createTaskStepSummariesRouter({
        db,
        logger,
        // So a reloaded board knows WHICH run a 'running' step belongs
        // to. Without it Stop agent has no run id to address and the
        // board reports a live agent as already finished.
        agentForTask: (taskId) => orchestrator.getAgentForTask(taskId),
    });

    // Full plan listing — backs the board's Draft / Progress /
    // Completed / Archived plan sections (the plans were previously a
    // sidebar-only surface; they now live on the main board).
    const plansReadRouter = createPlansReadRouter({ db, logger });
    // Architect Tier (Phase 2): the Requirements lane + detail modal.
    const requirementsReadRouter = createRequirementsReadRouter({ db, logger });
    // Per-task worktree diff — backs the pre-commit human-review modal
    // (operator inspects developer changes before committer runs) and
    // the post-commit diff viewer.
    const taskDiffRouter = createTaskDiffRouter({ db, logger });

    // Chat surface (Phase 1: read-only Q&A). The store is a thin
    // wrapper around chat_sessions / chat_messages; the route handler
    // spawns `claude --resume <id>` per turn and persists the result.
    // cwd is resolved from the chat's pinned repoId via the workspace
    // repo registry.
    const chatStore = new SqliteChatSessionStore(db);
    const repoStore = orchestrator.getRepoProjectionStore();
    // Scratch worktree root for chat edit-mode sessions. Sits next to
    // the task-worktrees pool under the same workspace root the
    // orchestrator uses, so cleanup + GC tooling can reason about
    // both pools the same way later.
    const chatWorktreeRoot = path.join(getWorkspaceRoot(), 'chat-worktrees');
    // Context-driven repo resolution for repo-less board chat sessions —
    // the same infer-remember-or-ask ladder the Telegram surface uses.
    const boardChatSeedResolver = makeTelegramSeedResolver(db, repoStore);
    // Flow-authoring assistant for the manager UI. Runs here because this
    // host owns agent spawning; the manager-api proxies to it, the same way
    // it already proxies POST /reload. It writes nothing — the operator
    // Saves through the manager-api, which stays the sole config authority.
    const flowChatRouter = createFlowChatRouter({
        chatService: new ChatService({
            db,
            store: chatStore,
            logger,
        }),
        projectId: 'manager',
        // The repo root: the flow author reads config/flows/*.yaml for its
        // siblings and agents/*.CLAUDE.md to check a step's persona exists.
        cwd: REPO_ROOT,
        logger,
    });

    const chatRouter = createChatRouter({
        db,
        store: chatStore,
        logger,
        chatWorktreeRoot,
        resolveRepoPath: (repoId: string): string | null => {
            const repo = repoStore.get(repoId);
            return repo?.ensuredPath ?? null;
        },
        // A scratch-edit chat's push and `gh pr create` are remote
        // calls, so they need the repo's GitHub account. Resolved
        // through the orchestrator so there is ONE repoId -> account
        // rule shared with the task and deploy paths.
        githubEnvForRepo: (repoId: string): Record<string, string> =>
            orchestrator.githubEnvForRepoId(repoId),
        resolveChatSeed: (key, text) => boardChatSeedResolver.resolve(key, text),
        scopeContext: (session) => buildScopeContextBlock(db, session),
        // Repo-less chats run rooted at the workspace repos dir (read
        // access to every clone; the agent finds the relevant repos).
        workspaceReposRoot: workspaceReposRootPath(),
        // Proposable types come from the LIVE flows, so an enabled pack's
        // types (diagnose-azure) are proposable and core names none.
        taskTypeVocabulary: vocabularyFromCatalog(orchestrator.taskTypes()),
    });

    // Chat retention: a daily sweep drops sessions untouched for longer
    // than the window (default 14 days). Sessions were never cleaned up,
    // so the list grew without bound and their messages are among the
    // bulkiest rows in the state DB. Deletion runs through the same
    // teardown-then-delete path the operator's Delete button uses, so a
    // scratch-edit session's worktree/branch cannot leak.
    const chatRetentionDeps = {
        store: chatStore,
        logger,
        resolveRepoPath: (repoId: string): string | null => {
            const repo = repoStore.get(repoId);
            return repo?.ensuredPath ?? null;
        },
    };
    const chatRetentionJob: ChatRetentionJob = createChatRetentionJob({
        listSessions: () => chatStore.listAllSessions(),
        deleteSession: (id) => deleteChatSessionWithTeardown(chatRetentionDeps, id),
        retentionDays: resolveChatRetentionDays(process.env),
        clock: () => Date.now(),
        logger,
    });
    chatRetentionJob.start(resolveChatRetentionIntervalMs(process.env));

    // Server-side chat progress narrator: appends `system` notes to a
    // chat thread for every pipeline milestone on a plan linked to that
    // session — independent of any open board tab — and publishes
    // `ChatNoteAppended` so an open board reloads the thread.
    attachChatNoteGenerator({
        bus: eventBus,
        db,
        store: chatStore,
        clock: () => Date.now(),
        logger,
    });

    // Operator "Apply" (Management UI Phase 4): hot-reload config/flows into
    // the running orchestrator. Lives on THIS host because the orchestrator
    // runs in-process here — the manager-api (separate process) forwards its
    // POST /reload to this route.
    const configReloadRouter = createConfigReloadRouter({
        reloadFlows: () => orchestrator.reloadFlows(),
        reloadSettings: () => orchestrator.reloadSettingsOverlay(),
        reloadProjectContexts: () => orchestrator.reloadProjectContexts(),
        logger,
    });

    // Proactive Claude-CLI auth health (field case: an expired OAuth token
    // surfaced only as a generic planner failure). Read fresh per request —
    // cheap (one small file stat/read) and always current after a
    // /api/reload-settings applied a new token override.
    const agentAuthRouter = createAgentAuthRouter({
        readStatus: () => readAgentAuthStatus(),
    });

    // Chat config-apply: executes a confirmed PROPOSE_CONFIG_CHANGE by
    // proxying to the manager-api (the single config-writing authority).
    // MANAGER_API_URL defaults to same-machine; the shared token
    // authenticates the hop.
    // Project architecture context for the board — proxied to the
    // manager-api so config keeps a single writer.
    const projectContextRouter = createProjectContextRouter({
        managerApiUrl: process.env.MANAGER_API_URL ?? 'http://127.0.0.1:4102',
        ...(authToken !== undefined ? { managerApiToken: authToken } : {}),
        logger,
    });

    const chatConfigApplyRouter = createChatConfigApplyRouter({
        managerApiUrl:
            process.env.MANAGER_API_URL ?? 'http://127.0.0.1:4102',
        ...(authToken !== undefined ? { managerApiToken: authToken } : {}),
        logger,
        reloadFlows: () => orchestrator.reloadFlows(),
        appendSystemNote: (sessionId, body) => {
            chatStore.appendMessage({
                sessionId,
                role: 'system',
                body,
                now: Date.now(),
            });
        },
    });

    // Outbound/inbound chat gateway (P-CPTO-011). Telegram ships dark: the
    // real gateway is constructed AND start()ed ONLY when pipeline.yaml selects
    // `chat_gateway: telegram` and a bot token is present; otherwise a no-op
    // FakeChatGateway stands in. The gateway self-attaches its bus subscribers
    // in start(), so the orchestrator needs no change here. A telegram
    // selection with a MISSING token warns (key name only, never the token
    // value) and falls back — it never silently starts nothing.
    const chatGatewaySelection =
        options.chatGatewaySelection
        ?? (await selectAndStartChatGateway({
            chatGatewayName: readChatGatewayName(pipelineConfigPath),
            tokenPresent: getTelegramBotToken() !== undefined,
            logger,
            buildTelegramGateway: (): TelegramGateway =>
                buildTelegramGateway({
                    eventBus,
                    commandBus,
                    db,
                    chatStore,
                    repoStore,
                    logger,
                    taskTypeVocabulary: vocabularyFromCatalog(orchestrator.taskTypes()),
                }),
        }));

    const server = new BoardHttpServer({
        commandBus,
        subscribeAll: (handler) => eventBus.subscribeAll(handler),
        authToken,
        healthCheck,
        decomposeStatusPort,
        extraRouters: [
            notesRouter,
            tasksRouter,
            decomposerClarifyRouter,
            projectsRouter,
            planReviewRouter,
            reposRouter,
            tasksReadRouter,
            flowStagesRouter,
            taskTypesRouter,
            activeDecomposersRouter,
            taskStepSummariesRouter,
            plansReadRouter,
            requirementsReadRouter,
            taskDiffRouter,
            chatRouter,
            flowChatRouter,
            chatConfigApplyRouter,
            contextUpdatesRouter,
            workerLogRouter,
            attachmentsRouter,
            projectContextRouter,
            configReloadRouter,
            agentAuthRouter,
        ],
        logger,
    });

    // Hand the port over: drop the bootstrap 503 responder, then bind the
    // real server. The gap is a few milliseconds; a request landing in it
    // gets a connection refusal and retries — same as any restart.
    await closeBootstrap();
    const { port: bound } = await server.listen(port, host);
    logger.info('worker-api: listening', {
        host,
        port: bound,
        authEnabled: authToken !== undefined,
    });

    return {
        port: bound,
        orchestrator,
        async stop(): Promise<void> {
            chatRetentionJob.stop();
            await server.close();
            // Stop the chat gateway before the orchestrator: it detaches its
            // bus subscribers and asks the inbound long-poll loop to exit at
            // the next cycle boundary (a no-op for the FakeChatGateway path).
            await chatGatewaySelection.stop();
            await orchestrator.stop();
        },
    };
}

async function main(): Promise<void> {
    loadDotenv();
    const portRaw = process.env.WORKER_API_PORT;
    const port = portRaw ? Number(portRaw) : DEFAULT_PORT;
    if (!Number.isFinite(port) || port < 0 || port > 65535) {
        // eslint-disable-next-line no-console
        console.error(`worker-api: invalid WORKER_API_PORT="${portRaw}"`);
        process.exit(1);
    }

    const handle = await start({ port });

    const shutdown = (signal: NodeJS.Signals): void => {
        // eslint-disable-next-line no-console
        console.log(`worker-api: received ${signal}, shutting down`);
        handle
            .stop()
            .then(() => process.exit(0))
            .catch((err) => {
                // eslint-disable-next-line no-console
                console.error('worker-api: error during shutdown', err);
                process.exit(1);
            });
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

if (require.main === module) {
    main().catch((err) => {
        // eslint-disable-next-line no-console
        console.error('worker-api: fatal startup error', err);
        process.exit(1);
    });
}

/**
 * Compose the three /health readers required by AP-VP7-003 against the
 * host-lifetime DB handle and the boot-time pipeline.yaml snapshot.
 *
 *   - `getAdapterStatuses` — closure over a map computed once from
 *     pipeline.yaml. Each key in {@link ADAPTER_SELECTION_KEYS} whose YAML
 *     value names a concrete (non-`fake`) adapter contributes
 *     `{ wired: true }`. Unreadable YAML degrades to `{}` so a missing
 *     config does not poison /health.
 *   - `getLastEventAt` — closure over a prepared `SELECT occurred_at
 *     FROM events ORDER BY seq DESC LIMIT 1` statement. Returns the most
 *     recent event's timestamp as an ISO-8601 string, or `null` when the
 *     log is empty.
 *   - `getParkedTaskCount` — delegates to
 *     {@link getParkedTaskCount} (AP-VP7-002), which executes a cached
 *     `COUNT(*)` against `parked_tasks_projection`.
 *
 * Each reader is a per-host closure — no module-level state, no singleton —
 * so a second `start()` call (a test running back-to-back hosts, for
 * example) gets a fresh aggregate bound to its own DB.
 */
function buildHealthSignals(
    db: Db,
    pipelineConfigPath: string,
    logger: Logger,
): HealthSignals {
    const adapterStatuses = readAdapterStatuses(pipelineConfigPath, logger);

    const lastEventStmt = db.prepare(
        'SELECT occurred_at FROM events ORDER BY seq DESC LIMIT 1',
    );

    return {
        getAdapterStatuses: (): Record<string, { wired: boolean }> => adapterStatuses,
        getLastEventAt: (): string | null => {
            const row = lastEventStmt.get() as
                | { occurred_at: number }
                | undefined;
            if (!row) return null;
            return new Date(row.occurred_at).toISOString();
        },
        getParkedTaskCount: (): number => getParkedTaskCount(db),
    };
}

/**
 * Read the adapter-selection keys from pipeline.yaml and return a wired-flag
 * map. Each YAML value that is a non-empty string other than the literal
 * `"fake"` contributes one `{ wired: true }` entry under its key. Anything
 * else (missing key, explicit `fake`, non-string) is omitted — matching
 * AP-VP7-004 AC #2 ("wired: true ONLY for the non-fake adapter currently
 * wired").
 *
 * A read/parse failure logs once and returns `{}`. The orchestrator's own
 * pipeline-config load already fails boot loudly on malformed YAML, so the
 * /health-side fallback here only fires when the file is genuinely absent.
 */
function readAdapterStatuses(
    pipelineConfigPath: string,
    logger: Logger,
): Record<string, { wired: boolean }> {
    let raw: Readonly<Record<string, unknown>>;
    try {
        raw = loadEffectivePipelineRaw(pipelineConfigPath);
    } catch (err) {
        logger.warn('worker-api: pipeline.yaml unreadable, adapters health field will be empty', {
            path: pipelineConfigPath,
            error: err instanceof Error ? err.message : String(err),
        });
        return {};
    }
    const out: Record<string, { wired: boolean }> = {};
    for (const key of ADAPTER_SELECTION_KEYS) {
        const value = raw[key];
        if (
            typeof value === 'string'
            && value.length > 0
            && value.toLowerCase() !== 'fake'
        ) {
            out[key] = { wired: true };
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// Chat gateway selection (P-CPTO-011)
// ---------------------------------------------------------------------------

/**
 * A chat gateway whose inbound/outbound arms the host must start and stop —
 * the {@link TelegramGateway} shape. `start()` self-attaches the outbound bus
 * subscribers and kicks the inbound long-poll loop; `stop()` reverses both.
 */
export interface StartableChatGateway extends ChatGateway {
    start(): Promise<void>;
    stop(): Promise<void>;
}

/** The chat gateway the host resolved for this boot, plus a shutdown hook. */
export interface ChatGatewaySelection {
    /** Which adapter `chat_gateway` + the token resolved to. */
    readonly kind: 'telegram' | 'fake';
    readonly gateway: ChatGateway;
    /** True when a Telegram gateway was actually start()ed. */
    readonly started: boolean;
    /** Host-shutdown hook. Stops a started Telegram gateway; no-op for fake. */
    stop(): Promise<void>;
}

/**
 * Select and (for Telegram) start the outbound/inbound chat gateway from the
 * `chat_gateway` value in pipeline.yaml and the presence of the bot token:
 *
 *   - `telegram` + token present → build via `buildTelegramGateway` and
 *     `start()` it. The gateway self-attaches its bus subscribers.
 *   - `telegram` + token ABSENT → log a visible warning naming ONLY the env
 *     key (never a token value) and fall back to {@link FakeChatGateway}.
 *     Telegram is configured but cannot run without a credential — surfacing
 *     that beats starting nothing silently.
 *   - anything else (the default) → {@link FakeChatGateway}; Telegram ships dark.
 *
 * `buildTelegramGateway` is a thunk so the caller owns the (heavy) collaborator
 * construction and tests can inject a fake startable gateway to assert the
 * selected branch — and that `start()` fired — without a bot token or network.
 * `tokenPresent` is a boolean rather than the token itself so this function can
 * never accidentally log a secret.
 */
export async function selectAndStartChatGateway(args: {
    readonly chatGatewayName: unknown;
    readonly tokenPresent: boolean;
    readonly buildTelegramGateway: () => StartableChatGateway;
    readonly logger: Logger;
}): Promise<ChatGatewaySelection> {
    const { chatGatewayName, tokenPresent, buildTelegramGateway, logger } = args;
    const wantsTelegram =
        typeof chatGatewayName === 'string'
        && chatGatewayName.trim().toLowerCase() === 'telegram';

    if (wantsTelegram && tokenPresent) {
        const gateway = buildTelegramGateway();
        await gateway.start();
        logger.info('worker-api: Telegram chat gateway started');
        return {
            kind: 'telegram',
            gateway,
            started: true,
            stop: (): Promise<void> => gateway.stop(),
        };
    }

    if (wantsTelegram && !tokenPresent) {
        // Configured for Telegram but no credential. Never start nothing
        // silently — warn (env key name ONLY, never a token value) and fall
        // back to the no-op fake so the operator sees why the bot is dark.
        logger.warn(
            'worker-api: chat_gateway=telegram but TELEGRAM_BOT_TOKEN is unset — '
            + 'falling back to FakeChatGateway (Telegram stays dark)',
        );
    }

    return {
        kind: 'fake',
        gateway: new FakeChatGateway(),
        started: false,
        stop: async (): Promise<void> => {},
    };
}

/**
 * The validated pipeline.yaml document this process actually runs with:
 * the active profile's keys deep-merged over the repo default. Every
 * reader here goes through it so /health and the chat-gateway choice
 * agree with the orchestrator, which reads the same layers.
 */
function loadEffectivePipelineRaw(pipelineConfigPath: string): Readonly<Record<string, unknown>> {
    const layered = readLayeredPipelineDoc({ repoPath: pipelineConfigPath });
    return parsePipelineConfig(layered.profilePath ?? pipelineConfigPath, layered.doc).raw;
}

/** Read `chat_gateway` from pipeline.yaml, degrading an unreadable config to
 *  `undefined` (treated as "not telegram") so boot still completes. */
function readChatGatewayName(pipelineConfigPath: string): unknown {
    try {
        return loadEffectivePipelineRaw(pipelineConfigPath)['chat_gateway'];
    } catch {
        return undefined;
    }
}

/** Minimal read-side of the repo projection the Telegram wiring needs — the
 *  ensured checkout path for a repo id. */
interface RepoPathLookup {
    get(id: string): { ensuredPath?: string | null } | null | undefined;
}

/**
 * Construct the production {@link TelegramGateway} with its full collaborator
 * set. Called by {@link selectAndStartChatGateway} ONLY when `chat_gateway:
 * telegram` and a bot token are both present, so none of this runs while
 * Telegram ships dark. The gateway reads the token + allow-list itself via
 * `readTelegramEnv`; the host supplies the durable collaborators:
 *
 *   - the shared {@link ChatService} for durable, propose-then-confirm free text;
 *   - {@link ChatClarify} for clarification reply correlation;
 *   - {@link NotificationLedger} for outbound de-dup across restarts;
 *   - a `chatSessionSeed` pinning the (repo-picker-less) Telegram surface to an
 *     operator-configured default project/repo cwd;
 *   - a `confirmProposal` seam that dispatches a Confirm-tapped action proposal:
 *     a PR merge through {@link GhPullRequestGateway} (the PR number resolved
 *     from `task_worktrees.pr_number`, the cwd from that task's worktree path),
 *     or an approve/retry onto the command bus.
 */
function buildTelegramGateway(deps: {
    eventBus: EventBus;
    commandBus: CommandBus<unknown>;
    db: Db;
    chatStore: SqliteChatSessionStore;
    repoStore: RepoPathLookup;
    logger: Logger;
    /**
     * Proposable task types from the live flows. Telegram is a real
     * proposal surface: without this, `Type: diagnose` from the phone
     * would normalise to `implement` and file code work for a
     * live-environment question.
     */
    taskTypeVocabulary: TaskTypeVocabulary;
}): TelegramGateway {
    const { eventBus, commandBus, db, chatStore, repoStore, logger } = deps;
    const chatService = new ChatService({
        db,
        store: chatStore,
        logger,
        scopeContext: (session) => buildScopeContextBlock(db, session),
        taskTypeVocabulary: deps.taskTypeVocabulary,
    });
    const clarify = new ChatClarify({ db, logger, commandBus });
    const notificationLedger = new NotificationLedger();
    const resolvePrNumber = makeResolvePrNumber(db);
    const seedResolver = makeTelegramSeedResolver(db, repoStore);
    return new TelegramGateway({
        bus: eventBus,
        commandBus,
        db,
        logger,
        clarify,
        notificationLedger,
        chatService,
        chatSessionSeed: (): ChannelSessionSeed | undefined =>
            resolveTelegramSessionSeed(repoStore),
        chatSeedResolver: (chatId, text) => seedResolver.resolve(chatId, text),
        // So a free-text turn that failed can say "authentication expired"
        // rather than "chat isn't configured" — the credential lapse is the
        // common cause and the one the operator can fix in a minute.
        agentAuthState: () => readAgentAuthStatus().status,
        confirmProposal: makeTelegramConfirmProposal({
            db,
            commandBus,
            resolvePrNumber,
        }),
    });
}

/**
 * Context-driven seed resolution for Telegram free text (see
 * adapters/telegram/chat-seed.ts). Catalog reads go straight to the repo
 * projection (list + ensured paths) and the projects table
 * (metadata.repos → repoIds); per-chat state persists in the gateway's
 * `telegram_state` table. The env-pin path stays on `chatSessionSeed`
 * above and wins when set, so this only runs for un-pinned setups.
 */
/** Parent directory of every synced clone — the chat's default root when
 *  no single repo resolves (the agent then finds the relevant repos
 *  itself). Same path the chat routes use for scoped sessions. */
function workspaceReposRootPath(): string {
    return path.join(getWorkspaceRoot(), 'repos');
}

function makeTelegramSeedResolver(
    db: Db,
    repoStore: RepoPathLookup,
): ChatSeedResolver {
    db.exec(
        `CREATE TABLE IF NOT EXISTS telegram_state (
            key   TEXT NOT NULL PRIMARY KEY,
            value TEXT NOT NULL
        )`,
    );
    return new ChatSeedResolver({
        listRepos: () => {
            const withList = repoStore as RepoPathLookup & {
                listActive?: () => ReadonlyArray<{
                    repoId: string;
                    name?: string | null;
                    ensuredPath?: string | null;
                }>;
            };
            return withList.listActive?.() ?? [];
        },
        listProjects: () => {
            try {
                const rows = db
                    .prepare('SELECT id, name, metadata FROM projects')
                    .all() as ReadonlyArray<{
                        id: string;
                        name?: string | null;
                        metadata?: string | null;
                    }>;
                return rows.map((row) => {
                    let repoIds: string[] = [];
                    if (row.metadata) {
                        try {
                            const parsed = JSON.parse(row.metadata) as {
                                repos?: ReadonlyArray<{ id?: unknown }>;
                            };
                            repoIds = (parsed.repos ?? [])
                                .map((r) => r.id)
                                .filter((id): id is string => typeof id === 'string');
                        } catch { /* unparseable metadata — no repo linkage */ }
                    }
                    return { id: row.id, name: row.name ?? null, repoIds };
                });
            } catch {
                return [];
            }
        },
        readState: (key) => {
            const row = db
                .prepare('SELECT value FROM telegram_state WHERE key = ?')
                .get(key) as { value: string } | undefined;
            return row?.value;
        },
        writeState: (key, value) => {
            db.prepare(
                `INSERT INTO telegram_state(key, value) VALUES (?, ?)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
            ).run(key, value);
        },
        deleteState: (key) => {
            db.prepare('DELETE FROM telegram_state WHERE key = ?').run(key);
        },
        workspaceRoot: () => workspaceReposRootPath(),
    });
}

/**
 * Resolve the PR number recorded for a task from `task_worktrees.pr_number`
 * (populated by the post-commit push/`gh pr create` hook). Returns undefined
 * when the task has no worktree row or no PR yet. Best-effort: a query failure
 * (e.g. the table not yet migrated) degrades to undefined rather than throwing.
 */
export function makeResolvePrNumber(db: Db): (taskId: string) => number | undefined {
    return (taskId: string): number | undefined => {
        try {
            const row = db
                .prepare('SELECT pr_number FROM task_worktrees WHERE task_id = ?')
                .get(taskId) as { pr_number: number | null } | undefined;
            return typeof row?.pr_number === 'number' ? row.pr_number : undefined;
        } catch {
            return undefined;
        }
    };
}

/** Resolve the worktree cwd for a task (`gh` resolves the repo from this
 *  directory's remote when merging). Undefined when the task has no worktree. */
function resolveWorktreeCwd(db: Db, taskId: string): string | undefined {
    try {
        const row = db
            .prepare('SELECT path FROM task_worktrees WHERE task_id = ?')
            .get(taskId) as { path: string | null } | undefined;
        return row?.path ?? undefined;
    } catch {
        return undefined;
    }
}

/**
 * Pin the (repo-picker-less) Telegram chat surface to an operator-configured
 * default project + repo. Reads `TELEGRAM_CHAT_PROJECT_ID` /
 * `TELEGRAM_CHAT_REPO_ID` and resolves the repo's ensured checkout path via the
 * repo projection. Returns undefined when either is unset or the repo has no
 * ensured path — the gateway then degrades free text to its classifier rather
 * than inventing a cwd.
 */
/**
 * Context block for a plan/requirement-scoped chat session — the pinned
 * artifact's CURRENT state, rebuilt per turn so edits the operator just
 * confirmed are visible to the next question. Read-only projection reads;
 * any failure returns undefined (the turn runs with the generic state
 * block only).
 */
export function buildScopeContextBlock(
    db: Db,
    session: { scopeKind: string | null; scopeId: string | null },
): string | undefined {
    if (!session.scopeKind || !session.scopeId) return undefined;
    try {
        if (session.scopeKind === 'plan') {
            const planId = session.scopeId;
            const plan = db
                .prepare('SELECT name, body, metadata FROM sidebar_plans WHERE plan_id = ?')
                .get(planId) as { name?: string; body?: string; metadata?: string } | undefined;
            if (!plan) return undefined;
            const rev = db
                .prepare(
                    `SELECT revision, content FROM plan_review_drafts
                      WHERE plan_id = ? AND content <> ''
                      ORDER BY revision DESC LIMIT 1`,
                )
                .get(planId) as { revision?: number; content?: string } | undefined;
            const tasks = db
                .prepare('SELECT id, title, status FROM tasks WHERE plan_id = ? ORDER BY id')
                .all(planId) as Array<{ id: string; title: string | null; status: string }>;
            const parts = [
                `# Scoped plan context (plan ${planId})`,
                '',
                `You are chatting ABOUT this plan: "${plan.name ?? planId}". Questions`,
                'refer to it; PROPOSE_PLAN_UPDATE blocks replace ITS document; a',
                'PROPOSE_TASK (type investigate) lands in THIS plan.',
                '',
                '## Brief',
                plan.body ?? '(no brief)',
            ];
            if (rev?.content) {
                parts.push('', `## Current implementation plan (revision ${rev.revision})`, rev.content);
            }
            if (tasks.length > 0) {
                parts.push('', '## Tasks');
                for (const t of tasks) {
                    parts.push(`- ${t.id} [${t.status}] ${t.title ?? ''}`);
                }
            }
            return parts.join('\n');
        }
        if (session.scopeKind === 'requirement') {
            const requirementId = session.scopeId;
            const req = db
                .prepare(
                    `SELECT title, description, design_md, verification_status, verification_findings
                       FROM requirements WHERE requirement_id = ?`,
                )
                .get(requirementId) as {
                    title?: string;
                    description?: string;
                    design_md?: string | null;
                    verification_status?: string | null;
                    verification_findings?: string | null;
                } | undefined;
            if (!req) return undefined;
            const subs = db
                .prepare('SELECT system_id, title, brief FROM requirement_subbriefs WHERE requirement_id = ? ORDER BY system_id')
                .all(requirementId) as Array<{ system_id: string; title: string | null; brief: string }>;
            const parts = [
                `# Scoped requirement context (requirement ${requirementId})`,
                '',
                `You are chatting ABOUT this requirement: "${req.title ?? requirementId}".`,
                'PROPOSE_REQUIREMENT_UPDATE blocks replace ITS description.',
                '',
                '## Description',
                req.description ?? '',
            ];
            if (req.design_md) parts.push('', '## Architecture design', req.design_md);
            for (const sb of subs) {
                parts.push('', `## Sub-brief: ${sb.system_id}${sb.title ? ` — ${sb.title}` : ''}`, sb.brief);
            }
            if (req.verification_status) {
                parts.push('', `## Verification: ${req.verification_status}`);
                if (req.verification_findings) parts.push(req.verification_findings);
            }
            return parts.join('\n');
        }
        if (session.scopeKind === 'report') {
            // Scoped to the TASK that produced the report: there is no
            // report table, and `reportId` is an event seq that changes
            // when a task is re-run. The task id is what survives.
            const taskId = session.scopeId;
            const task = db
                .prepare(
                    `SELECT id, title, type, status, plan_id, repo_id, description
                       FROM tasks WHERE id = ?`,
                )
                .get(taskId) as {
                    id: string;
                    title?: string | null;
                    type?: string | null;
                    status?: string | null;
                    plan_id?: string | null;
                    repo_id?: string | null;
                    description?: string | null;
                } | undefined;
            if (!task) return undefined;
            // The SAME two readers the View-report modal and the
            // Implement button use, so the chat cannot end up discussing
            // a different report than the one on screen.
            const roles = reportRoles();
            const report = createDbInvestigationReportStore(db, roles).get(taskId, '');
            if (!report) return undefined;
            const parts = [
                `# Scoped report context (task ${taskId})`,
                '',
                `You are chatting ABOUT the report produced by this ${task.type ?? 'investigate'}`,
                `task: "${task.title ?? taskId}". The operator is reading it right now.`,
                '',
                'This task is FINISHED and its report is a written record — you cannot',
                'change it, and there is no document here to revise. Answer questions',
                'about the findings from the report text below.',
                '',
                'To act on a finding, emit a PROPOSE_TASK block: it becomes a new plan',
                'and runs the planner. Propose one only when the operator asks for the',
                'work, not merely because the report recommends it — reading a report',
                'is not approving it.',
                '',
                `## The report`,
                report.markdown,
            ];
            if (task.description) {
                parts.push('', '## What the task was asked to investigate', task.description);
            }
            // Follow-up Q&A recorded against the task (the older
            // one-shot follow-up modal). The reader appends the report
            // itself as the last assistant turn; drop that copy so the
            // model does not read it twice.
            const thread = createDbInvestigationThreadReader(db, roles).readThread(taskId) ?? [];
            const followUps = thread.filter((e) => e.content !== report.markdown);
            if (followUps.length > 0) {
                parts.push('', '## Earlier follow-up conversation about this report');
                for (const e of followUps) {
                    parts.push('', `**${e.role}:** ${e.content}`);
                }
            }
            if (task.plan_id) {
                parts.push('', `## Origin`, `This task belongs to plan ${task.plan_id}.`);
            }
            if (task.repo_id) {
                parts.push('', `Repo: ${task.repo_id}`);
            }
            return parts.join('\n');
        }
    } catch {
        return undefined;
    }
    return undefined;
}

/**
 * Report roles: core's own plus whatever the enabled packs declare.
 * Without the pack's, an Azure review's or diagnosis's summary is not
 * found and the report chat opens with no report in context.
 */
function reportRoles(): readonly string[] {
    return [
        ...CORE_REPORT_ROLES,
        ...activePacks().flatMap((p) => p.roles.filter((r) => r.report).map((r) => r.id)),
    ];
}

function resolveTelegramSessionSeed(
    repoStore: RepoPathLookup,
): ChannelSessionSeed | undefined {
    const projectId = process.env.TELEGRAM_CHAT_PROJECT_ID?.trim();
    const repoId = process.env.TELEGRAM_CHAT_REPO_ID?.trim();
    if (!projectId || !repoId) return undefined;
    const cwd = repoStore.get(repoId)?.ensuredPath ?? undefined;
    if (!cwd) return undefined;
    return { projectId, repoId, cwd };
}

/**
 * Build the {@link ProposalConfirmer} the gateway invokes on a Confirm tap.
 * Telegram confirms the SAME proposal kinds the board does:
 *   - merge   → look up the task's PR number and its worktree cwd, then
 *               squash-merge via {@link GhPullRequestGateway};
 *   - approve → ResumeTask(approve) on the command bus;
 *   - retry   → RetryTask on the command bus;
 *   - dismiss → acknowledged, nothing dispatched.
 * A `task` proposal runs the board's exact two-step plan path: CreatePlan
 * (so the plan card appears) then GeneratePlan (so the planner/decomposer
 * takes over). Before this, tapping Confirm on a plan the Telegram agent
 * had just proposed replied "only from the board" — the operator had to
 * walk to the board to accept work the bot itself offered.
 * `config` proposals stay board-only: applying them proxies to the
 * manager-api (the single config-writing authority) rather than the
 * command bus, so they need that route, not this seam.
 */
/** Actor recorded on commands the Telegram surface dispatches. */
const TELEGRAM_ACTOR = 'telegram';

function makeTelegramConfirmProposal(deps: {
    db: Db;
    commandBus: CommandBus<unknown>;
    resolvePrNumber: (taskId: string) => number | undefined;
    clock?: () => number;
    idGen?: () => string;
}): ProposalConfirmer {
    const { db, commandBus, resolvePrNumber } = deps;
    const clock = deps.clock ?? ((): number => Date.now());
    const idGen = deps.idGen
        ?? ((): string => `id-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    return async (proposal, ctx) => {
        // Task proposal → the board's own two-step: CreatePlan makes the
        // card visible (sidebar_plans folds PlanCreated only), then
        // GeneratePlan hands the brief to the planner/decomposer.
        if (proposal.kind === 'task') {
            const projectId = ctx.projectId ?? '';
            if (projectId.length === 0) {
                return {
                    dispatched: false,
                    reply: 'I could not tell which project to file that under — '
                        + 'create it from the board, or tell me the project first.',
                };
            }
            const planId = idGen();
            try {
                await commandBus.send({
                    type: 'CreatePlan',
                    actor: TELEGRAM_ACTOR,
                    issuedAt: clock(),
                    payload: {
                        planId,
                        projectId,
                        title: proposal.title,
                        body: proposal.description,
                        metadata: { planType: proposal.type },
                    },
                });
                await commandBus.send({
                    type: 'GeneratePlan',
                    actor: TELEGRAM_ACTOR,
                    issuedAt: clock(),
                    payload: {
                        projectId,
                        planId,
                        previousContent: '',
                        revision: 1,
                        briefContent: proposal.description,
                    },
                });
            } catch (err) {
                return {
                    dispatched: false,
                    reply: `Could not create that plan: ${
                        err instanceof Error ? err.message : String(err)
                    }`,
                };
            }
            return {
                dispatched: true,
                reply: `✅ Plan created: "${proposal.title}" (${proposal.type}) — `
                    + 'the planner is running. Watch the board for the tasks.',
            };
        }
        if (proposal.kind !== 'action') {
            // project-update goes through the projects CRUD route (PATCH
            // /api/projects/:id) and config-apply proxies to the
            // manager-api — the single config-writing authority. Neither
            // is a command-bus dispatch, so neither can ride this seam;
            // say which surface owns it instead of a generic refusal.
            return {
                dispatched: false,
                reply: proposal.kind === 'project-update'
                    ? 'Project settings are edited from the board — confirm that one there.'
                    : 'Config changes are applied through the manager API — confirm that '
                        + 'one from the board.',
            };
        }
        const { action, taskId } = proposal;
        if (action === 'dismiss') {
            return { dispatched: false, reply: 'Dismissed — nothing was changed.' };
        }
        if (action === 'merge') {
            const prNumber = resolvePrNumber(taskId);
            if (prNumber === undefined) {
                return {
                    dispatched: false,
                    reply: `No PR is recorded for task ${taskId} yet.`,
                };
            }
            const cwd = resolveWorktreeCwd(db, taskId);
            if (!cwd) {
                return {
                    dispatched: false,
                    reply: `Can't locate a checkout for task ${taskId} to merge PR #${prNumber}.`,
                };
            }
            const prGateway = new GhPullRequestGateway({ cwd });
            await prGateway.mergePullRequest(prNumber, { method: 'squash' });
            return {
                dispatched: true,
                reply: `Merging PR #${prNumber} (squash) for task ${taskId}.`,
            };
        }
        // approve / retry → command types with registered orchestrator handlers.
        const commandType =
            action === 'approve'
                ? TaskParkingCommands.RESUME_TASK
                : TaskOpsCommands.RETRY_TASK;
        const payload =
            action === 'approve' ? { taskId, decision: 'approve' } : { taskId };
        await commandBus.send({
            type: commandType,
            actor: 'telegram',
            issuedAt: Date.now(),
            payload,
        });
        return {
            dispatched: true,
            reply:
                action === 'approve'
                    ? `Approved task ${taskId}.`
                    : `Retrying task ${taskId}.`,
        };
    };
}
