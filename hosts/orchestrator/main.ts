import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as crypto from 'crypto';
import * as path from 'path';

import { CommandBus } from '../../core/commands/bus';
import { EventBus } from '../../core/events/bus';
import { EventStore } from '../../core/events/store';
import type { Event } from '../../core/events/event';
import {
    FlowEngine,
    FlowEvents,
    FLOW_ENGINE_SUBSCRIBER,
} from '../../core/flow/engine';
import { parseClarification } from '../../core/flow/clarification-parser';
import {
    parseAgentOutcomeDetailed,
    type ExtraRoleOutcomes,
    type RoleOutcomeMarkers,
} from '../../core/flow/agent-outcome';
import { applySettingsOverlay } from '../../core/config/settings-registry';
import {
    createAzureStateBackupClients,
    resolveStateBackupOptions,
    restoreStateDbIfMissing,
    startStateBackupJob,
    type BackupCapableDb,
    type StateBackupClients,
    type StateBackupJob,
} from '../../adapters/azure/state-backup';
import { loadLayeredFlows, reloadLayeredFlowsInto } from '../../core/flow/loader';
import { TaskTypeCatalog } from '../../core/flow/task-types';
import {
    activePacks,
    activeProfileHome,
    configStoreRootDefaults,
    flowLayerDirs,
    LayeredConfigError,
    readLayeredPipelineDoc,
    resolveConfigFile,
} from '../../config/profile';
import {
    parsePipelineConfig,
    PipelineConfigError,
    type IssueTrackerKind,
    type IssueTrackerShadowKind,
    type PipelineConfig as ValidatedPipelineConfig,
} from '../../core/flow/pipeline-config';
import type { FlowDefinition } from '../../core/flow/types';
import {
    parseGitHubAccounts,
    resolveGitHubEnv,
    type GitHubAccountMap,
} from '../../core/config/github-accounts';
import {
    applyMigrations,
    openDatabase,
    type Db,
} from '../../core/state/migrations';
import type {
    AgentRunner,
    ChatGateway,
    ConfigStore,
    IdGen,
    IssueTracker,
    Logger,
    SourceControl,
} from '../../core/ports';

import {
    createConfigStore,
    resolveConfigStoreOptions,
    type ConfigStoreWiring,
    type ConfigStoreYamlSection,
} from '../../adapters/config-store/createConfigStore';
import { FileLogger } from '../../adapters/logging/file-logger';
import {
    register as registerSnapshotJob,
    type SnapshotJobHandle,
} from '../../adapters/storage/snapshot-job';
import {
    load as loadSchedules,
    register as registerScheduler,
    type SchedulerHandle,
} from '../../adapters/cron/scheduler';
import {
    WorktreeManager,
    registerWorktreeSubscribers,
    type TaskStateLookup,
} from '../../adapters/git/worktree-manager';
import {
    register as registerWorktreeGcJob,
    WORKTREE_GC_JOB_SUBSCRIBER,
    type WorktreeGcJobHandle,
} from '../../adapters/git/worktree-gc-job';
import {
    register as registerEscalationFileWriter,
    ESCALATION_FILE_WRITER_SUBSCRIBER,
    type EscalationFileWriterHandle,
} from '../../adapters/escalation/EscalationFileWriter';
import {
    register as registerAutoTransitionJob,
    AUTO_TRANSITIONS_SUBSCRIBER,
    type AutoTransitionJobHandle,
    type AutoTransitionPlanMetadata,
    type PlanMetadataStore,
} from '../../adapters/auto-transitions/AutoTransitionJob';
import { SNAPSHOT_JOB_SUBSCRIBER } from '../../adapters/storage/snapshot-job';
import { getLogFile, getStateDbPath, getWorkspaceRoot } from '../../config/env';

import { FakeAgentRunner } from '../../adapters/fakes/FakeAgentRunner';
import { FakeChatGateway } from '../../adapters/fakes/FakeChatGateway';
import { FakeIssueTracker } from '../../adapters/fakes/FakeIssueTracker';
import { FakeSourceControl } from '../../adapters/fakes/FakeSourceControl';

import { ClaudeCliRunner } from '../../adapters/claude-cli/ClaudeCliRunner';
import { classifyAuthFailure } from '../../adapters/claude-cli/auth-status';
import { stackHooksFor } from '../../packs/registry';
import type { StackHooks } from '../../core/ports/StackHooks';
import { planTitlesForSubBriefs } from './fanout-titles';
import {
    TELEMETRY_EVENT_TYPES,
    pruneTelemetryEvents,
    resolveTelemetryRetentionDays,
} from '../../core/state/telemetry-prune';
import {
    MERGE_CONFLICT_EVENT,
    MergeConflictResolver,
    isMergeConflictFailure,
} from './merge-conflict-resolver';
import {
    ensureClaudeWorkspaceTrust,
    workspaceTrustPaths,
} from '../../adapters/claude-cli/claude-trust';
import {
    ClaudeCliAgentRunKiller,
    type ClaudeCliInterruptable,
} from '../../adapters/claude-cli/ClaudeCliAgentRunKiller';
import { NoopAgentRunKiller } from '../../adapters/claude-cli/NoopAgentRunKiller';
import { DeepSeekRunner } from '../../adapters/deepseek/DeepSeekRunner';
import { CursorCliRunner } from '../../adapters/cursor-cli/CursorCliRunner';
import {
    OLLAMA_CLOUD_BASE_URL,
    OLLAMA_DEFAULT_BASE_URL,
    OllamaRunner,
} from '../../adapters/ollama/OllamaRunner';
import {
    RoleRoutingAgentRunner,
    type RoutableRunner,
} from '../../adapters/routing/RoleRoutingAgentRunner';

import {
    BoardUiCommands,
    registerBoardUiCommands,
    type AgentRunKiller,
    type CreatePlanPayload,
    type UpdateProjectContextPayload,
} from '../board-ui/commands';
import { registerManagerApiCommands } from '../manager-api/routes';

import { JiraTracker } from '../../adapters/jira/JiraTracker';
import { createJiraClient } from '../../adapters/jira/client';
import {
    DEFAULT_SHADOW_DIFF_LOG_RELPATH,
    JIRA_SHADOW_SUBSCRIBER,
    createFileShadowDiffLog,
    registerJiraShadowSubscriber,
    type JiraExternalRefs,
    type ShadowDiffLog,
} from '../../adapters/jira/subscriber';

import {
    Commands,
    Events,
    LINEAR_COMMENT_SINK_SUBSCRIBER,
    PLAN_GENERATED_EVENT_TYPE,
    buildPlanGenerationGateWiring,
    registerCommandHandlers,
    registerLinearCommentSink,
    registerPlanLifecycleAgentHandlers,
    registerWorkerErrorHandlers,
    type AttachmentAddedPayload,
    type LifecycleAgentContext,
    type PlanApprovedPayload,
    type StartLifecycleAgentArgs,
    CORE_REPORT_ROLES,
    type TaskApprovedPayload,
    type TaskCreatedPayload,
} from './handlers';
import { AgentMemoryStore } from '../../core/projects/agent-memory';
import {
    backfillDesignAttachments,
    designAttachmentsRoot,
    mirrorDesignAttachment,
    removeMirroredDesignAttachment,
    type DesignAttachmentOwner,
} from './design-attachments';
import {
    attachInterruptFeedbackMemory,
    INTERRUPT_FEEDBACK_MEMORY_SUBSCRIBER,
} from './interrupt-feedback-memory';
import { ProjectRegistry } from '../../core/projects/registry';
import {
    PROJECT_PROJECTION_SUBSCRIBER,
    ProjectProjectionStore,
} from '../../adapters/projections/project-projection-store';
import {
    PLAN_PROJECTION_SUBSCRIBER,
    PlanProjectionStore,
} from '../../adapters/projections/plan-projection-store';
import {
    PLAN_REVIEW_PROJECTION_SUBSCRIBER,
    PlanReviewStore,
} from '../../adapters/projections/plan-review-store';
import {
    REQUIREMENT_PROJECTION_SUBSCRIBER,
    RequirementProjectionStore,
} from '../../adapters/projections/requirement-projection-store';
import { commitDesignDoc } from '../../adapters/architect/design-doc-committer';
import { AgentConfigResolver } from './agent-config-resolver';
import {
    RequirementCommands,
    RequirementEvents,
    createApproveArchitectureHandler,
    createArchiveRequirementHandler,
    createProceedFanOutHandler,
    createRegenerateArchitectureHandler,
    createRetryVerificationHandler,
    createSubmitRequirementHandler,
    createUpdateRequirementHandler,
    type ApproveArchitecturePayload,
    type ArchiveRequirementPayload,
    type ArchitectureApprovedPayload,
    type FanOutAuthorizedPayload,
    type ProceedFanOutPayload,
    type RegenerateArchitecturePayload,
    type RetryVerificationPayload,
    type SubmitRequirementPayload,
    type UpdateRequirementPayload,
} from '../../core/requirements';
import {
    DEFAULT_AGENT_PROVIDER,
    SELECTABLE_AGENT_PROVIDER_IDS,
    normalizeProviderId,
    type AgentProviderId,
} from '../../core/agents/providers';
import {
    AttachmentCommands,
    PlanLifecycleCommands,
    type PlanGeneratedEventPayload,
    type SubmitBriefPayload,
} from '../../core/commands';
import {
    collectTaskOutputs,
    describeSkippedOutputs,
    outputIdempotencyKey,
    taskOutputDir,
    taskOutputsRoot,
} from './task-outputs';
import {
    TASK_PROJECTION_SUBSCRIBER,
    TaskProjectionStore,
} from '../../adapters/projections/task-projection-store';
import {
    REPO_PROJECTION_SUBSCRIBER,
    RepoProjectionStore,
} from '../../adapters/projections/repo-projection-store';
import {
    RepoCommands,
    createArchiveRepoHandler,
    createRefreshAllReposHandler,
    createRefreshRepoHandler,
    createRegisterRepoHandler,
    createUpdateRepoHandler,
    type ArchiveRepoPayload,
    type CreateRepoPayload,
    type RefreshAllReposPayload,
    type RefreshRepoPayload,
    type RegisterRepoPayload,
    type UpdateRepoPayload,
} from '../../core/commands/repos';
import { createGitHubRepoAndSeedClaudeMd } from './repo-creation';
import { FsRepoReader } from '../../adapters/repo/FsRepoReader';
import { WorkspaceRepoFetcher } from '../../adapters/repo/WorkspaceRepoFetcher';
import {
    REPO_ENSURE_SUBSCRIBER,
    attachRepoEnsureSubscriber,
    createRepoRefreshTrigger,
} from '../../adapters/repo/repo-sync';
import type { RepoSpec } from '../../core/ports/RepoReader';

import {
    TaskWorktreeStore,
    describePostCommitOutcome,
    runPostCommitHook,
    mergeTaskPr,
    runCommand,
} from './task-worktrees';
import { describeMergeAbandoned } from './merge-classify';
import {
    describeOrphanedRun,
    findOrphanedRuns,
    needsOperatorPark,
} from './orphaned-runs';
import {
    resolveAutoMergePollMs,
    resolveAutoMergeTimeoutMs,
    watchEnqueuedMerge,
} from './merge-watcher';
import { DeployWorktreeStore } from './deploy-worktrees';
import { backfillClarifications } from './clarification-backfill';
import { ProjectContextProvider } from './project-context';
import { parseContextProposal } from './project-context-proposal';
import { SqliteTaskDependencyStore } from '../../adapters/state/SqliteTaskDependencyStore';
import { SqliteAttachmentStore } from '../../adapters/state/SqliteAttachmentStore';
import { FsAttachmentBlobStore } from '../../adapters/storage/FsAttachmentBlobStore';
import type { AttachmentBlobStore } from '../../core/ports/AttachmentBlobStore';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_FLOWS_DIR = path.join(REPO_ROOT, 'config', 'flows');
// State DB path: `PIPELINE_STATE_DB`, else `<repo-root>/.pipeline-state.db`.
// Resolved through `config/env` so this process and the manager-api cannot
// end up on different files — see getStateDbPath for why that matters.
// Read at construction rather than at module load so a late `loadDotenv`
// still applies.
const DEFAULT_REFERENCE_BASELINE_PATH = path.join(REPO_ROOT, 'REFERENCE_BASELINE');
const DEFAULT_PIPELINE_CONFIG_PATH = path.join(REPO_ROOT, 'config', 'pipeline.yaml');
const DEFAULT_SHADOW_DIFF_LOG_PATH = path.join(REPO_ROOT, DEFAULT_SHADOW_DIFF_LOG_RELPATH);
/**
 * Workspace root: the directory the orchestrator clones repos into and
 * lays task worktrees under. The location MATTERS — claude / cursor
 * auto-discover CLAUDE.md by walking up from the agent's cwd; if the
 * workspace lives inside the operator's personal repo tree (e.g.
 * `<workspace>\pipeline-v2\.pipeline-workspace`), the agent's walk hits
 * `<workspace>\CLAUDE.md` and the operator's personal repo siblings,
 * producing the "developer wrote to my local checkout" failure mode.
 *
 * `PIPELINE_WORKSPACE_ROOT` overrides; the per-platform fallback and the
 * reasoning behind each default live in `config/env`.
 */
const DEFAULT_WORKSPACE_ROOT = getWorkspaceRoot();
const DEFAULT_WORKTREE_ROOT = path.join(DEFAULT_WORKSPACE_ROOT, 'worktrees');
const DEFAULT_REPOS_ROOT = path.join(DEFAULT_WORKSPACE_ROOT, 'repos');
const DEFAULT_ATTACHMENTS_ROOT = path.join(DEFAULT_WORKSPACE_ROOT, 'attachments');
const DEFAULT_PLAN_ATTACHMENTS_ROOT = designAttachmentsRoot(
    DEFAULT_WORKSPACE_ROOT,
    'plan',
);
/** Architect-tier design input, mirrored for the worktree-less agents. */
const DEFAULT_REQUIREMENT_ATTACHMENTS_ROOT = designAttachmentsRoot(
    DEFAULT_WORKSPACE_ROOT,
    'requirement',
);
/**
 * Where a task drops the files it PRODUCES (migration 038). One folder
 * per task, outside the worktree so nothing here is ever staged into the
 * task's commit and a post-merge worktree removal cannot take the
 * deliverables with it. See task-outputs.ts for why the pipeline declares
 * this path instead of leaving the agent to invent one.
 */
const DEFAULT_TASK_OUTPUTS_ROOT = taskOutputsRoot(DEFAULT_WORKSPACE_ROOT);

/**
 * Which mirror root an attachment owner uses, or null when it has none.
 *
 * A TASK has no mirror: its attachments are copied into its worktree at
 * spawn instead. Returning null rather than defaulting to the plan root
 * is what keeps a task attachment out of the plan directory.
 */
function designMirrorRoot(ownerType: string): string | null {
    if (ownerType === 'plan') return DEFAULT_PLAN_ATTACHMENTS_ROOT;
    if (ownerType === 'requirement') return DEFAULT_REQUIREMENT_ATTACHMENTS_ROOT;
    return null;
}

/**
 * Root directory holding attachment bytes (migration 021). Sits alongside
 * `worktrees/` and `repos/` under the workspace root so the whole pool is
 * reasoned about the same way by GC tooling. Exported so the worker-api
 * host can point its own blob-store handle (for uploads) at the same path
 * the orchestrator deletes from.
 */
export function attachmentsRoot(): string {
    return DEFAULT_ATTACHMENTS_ROOT;
}
const DEFAULT_SCHEDULES_PATH = path.join(REPO_ROOT, 'config', 'schedules.yaml');
const DEFAULT_PROJECTS_ROOT = path.join(REPO_ROOT, '..', 'projects');
const DEFAULT_PROJECT_CONFIG_DIR = path.join(REPO_ROOT, 'config', 'projects');
const DEFAULT_FLOW_ID = 'echo';
const DEFAULT_PROJECT_ID = 'default-project';
const DEFAULT_TASK_TYPE = 'echo';
const DEFAULT_ACTOR = 'orchestrator';

/**
 * Status values that mark a task as terminal for worktree GC. Matches the
 * vocabulary referenced in TASK.md ("done / dismissed / failed-final");
 * `'failed'` is included so the engine's existing FailTask transition
 * (which writes `'failed'`) also frees the worktree.
 *
 * `'skipped'` is the exact status the `TaskSkipped` projection writes for
 * an operator Cancel/Dismiss. Its absence meant `gcStale` never reclaimed
 * a skipped task whose immediate `removeOnDisk` had failed — the worktree
 * then lingered forever because no terminal status ever matched it.
 */
const TERMINAL_TASK_STATUSES: ReadonlySet<string> = new Set([
    'done',
    'dismissed',
    'skipped',
    'failed',
    'failed-final',
]);

/**
 * May a dependency-unblocked task be re-dispatched into the flow engine?
 * Only PENDING statuses qualify: `created` (the normal waiting-deps case)
 * and `approved` (operator approved while still gated). Everything else —
 * skipped / dismissed / cancelled / done / failed / in-flight — must stay
 * exactly as the operator (or the flow) left it: an upstream turning
 * terminal is a gate release, never a restart. `null` (row missing) is
 * NOT re-dispatched — a task the projection doesn't know can't be safely
 * started. Exported for unit tests.
 */
export function shouldRedispatchUnblockedTask(
    status: string | null,
    parkedReason?: string | null,
): boolean {
    if (status !== 'created' && status !== 'approved') return false;
    // A task PARKED for anything other than the dependency gate is mid-
    // flow: an interrupted run (wait-action), an unanswered question, an
    // approval or diff-review gate. Releasing an upstream dependency must
    // not clear that park — it did, and left an interrupted task with no
    // park, no running agent and stale flow_state, so the board offered
    // neither Resume nor a working start (field case: L-MIBO-010, stopped
    // mid-develop, then un-parked when its dependency finished).
    if (parkedReason && parkedReason !== 'waiting-deps') return false;
    return true;
}

/**
 * Whether `taskId` is terminal for worktree GC purposes.
 *
 * A task counts as terminal when EITHER its own status is in
 * {@link TERMINAL_TASK_STATUSES}, OR its owning plan has been archived or
 * deleted. Both `PlanArchived` and `PlanDeleted` fold into a non-null
 * `archived_at` (soft-delete) on `sidebar_plans`, so a stamped plan makes
 * the periodic gc sweep a true catch-all for plan-orphaned worktrees the
 * archive/delete subscriber may have missed — even when the task's own
 * status never reached a terminal value because the plan went away
 * mid-flight.
 *
 * Unknown taskIds return `false` so the gc never prunes a directory the
 * system does not recognise (mirrors {@link TaskStateLookup}'s contract).
 * Exported so the composition-root tests can exercise the predicate
 * against a seeded DB without booting the whole worktree manager.
 */
export function isTaskTerminalForGc(db: Db, taskId: string): boolean {
    const row = db
        .prepare('SELECT status, plan_id FROM tasks WHERE id = ?')
        .get(taskId) as { status: string; plan_id: string | null } | undefined;
    if (!row) return false;
    if (TERMINAL_TASK_STATUSES.has(row.status)) return true;
    if (typeof row.plan_id === 'string' && row.plan_id.length > 0) {
        const planRow = db
            .prepare(
                `SELECT 1 FROM sidebar_plans
                  WHERE plan_id = ? AND archived_at IS NOT NULL
                  LIMIT 1`,
            )
            .get(row.plan_id);
        if (planRow !== undefined) return true;
    }
    return false;
}

/** 40-char lowercase or uppercase hex — matches a git commit SHA. */
const COMMIT_SHA_RE = /^[0-9a-fA-F]{40}$/;

const SUBSCRIBER_PROJECTION_PLANS = 'projection-plans';
const SUBSCRIBER_PROJECTION_TASKS = 'projection-tasks';
/**
 * Named so the harvest participates in offset tracking: a worker that
 * restarts between an agent finishing and the sweep running replays the
 * AgentFinished it missed and the deliverables still land.
 */
const SUBSCRIBER_TASK_OUTPUT_HARVEST = 'task-output-harvest';
const SUBSCRIBER_BRIDGE_TASK_CREATED = 'bridge-task-created';
const SUBSCRIBER_BRIDGE_TASK_APPROVED = 'bridge-task-approved';
const SUBSCRIBER_BRIDGE_AGENT_FINISHED = 'bridge-agent-finished';
const SUBSCRIBER_BRIDGE_AGENT_FAILED = 'bridge-agent-failed';
/**
 * Named subscriber for the TaskFinished → task_deps merge + unblock pass.
 * Separate from the projection-tasks subscriber so its offset advances
 * independently of the lifecycle status writes — a replay of the projection
 * subscriber should not re-fire dep-flip work that already ran.
 */
const SUBSCRIBER_TASK_DEPS = 'task-deps';

/**
 * Named subscriber for the plan-archive/delete → worktree cascade. Kept
 * distinct from the projection-tasks subscriber so its offset advances
 * independently — folding it under `SUBSCRIBER_PROJECTION_TASKS` would
 * silently share that offset, and a replay of the tasks projection would
 * either re-run (or, worse, skip) the per-plan cleanup depending on which
 * offset had advanced. A dedicated name also means the boot
 * `replayMissed` pass re-fires an archive/delete that happened while the
 * worker was down, so those plans still get their worktrees reclaimed.
 */
const SUBSCRIBER_PLAN_WORKTREE_CLEANUP = 'plan-worktree-cleanup';

/**
 * Named subscriber id for the primary `IssueTracker` lifecycle subscriber.
 * One subscriber regardless of whether `issue_tracker` is `linear` or `jira`
 * — the routing chooses which tracker the subscriber calls into, not how
 * many subscribers exist.
 */
const ISSUE_TRACKER_PRIMARY_SUBSCRIBER = 'issue-tracker-primary';

/**
 * Named subscriber id used when Linear runs in shadow mode (i.e.
 * `issue_tracker: jira, issue_tracker_shadow: linear`). The Jira-side
 * shadow subscriber keeps its existing name from AP-NVP-027 so its
 * offset history remains stable across deployments.
 */
const LINEAR_SHADOW_SUBSCRIBER = 'linear-shadow';

/** AgentRunner plus the optional `flush` hook the fake exposes for tests. */
type RunnerWithFlush = AgentRunner & { flush?: () => Promise<void> };

export interface OrchestratorAdapters {
    readonly agentRunner?: RunnerWithFlush;
    readonly issueTracker?: IssueTracker;
    readonly chatGateway?: ChatGateway;
    readonly sourceControl?: SourceControl;
    /**
     * Optional shadow-mode tracker — wired ONLY when pipeline.yaml has
     * `issue_tracker_shadow: jira`. Tests inject a fake here; production
     * leaves it unset and the host constructs a JiraTracker from env creds.
     */
    readonly jiraIssueTracker?: IssueTracker;
    /**
     * Optional shadow-mode tracker for the reverse direction — used when
     * pipeline.yaml has `issue_tracker: jira, issue_tracker_shadow: linear`.
     * Tests inject a fake here. Production wiring of a real Linear adapter
     * as a shadow is not yet supported via the default (no env-resolved
     * fallback) — when nothing is injected the shadow subscriber falls
     * back to a `FakeIssueTracker` and the shadow-diff log captures any
     * port calls that happen anyway.
     */
    readonly linearShadowIssueTracker?: IssueTracker;
    /** Test seam: override the shadow-diff log sink. */
    readonly jiraShadowDiffLog?: ShadowDiffLog;
    /**
     * Optional pre-built `ConfigStore` wiring. When unset the host calls
     * `createConfigStore` against `ConfigStoreOptions` resolved from the
     * `config_store:` section of pipeline.yaml overlaid with
     * `PIPELINE_STORE_*` env vars (see AC #1–#7). Tests inject a
     * pre-built wiring to avoid touching env vars or the Azure SDK.
     */
    readonly configStore?: ConfigStoreWiring;
    /**
     * Optional pre-built `WorktreeManager`. When supplied the host wires
     * the manager into the task lifecycle (create on TaskStarted, remove
     * on TaskCompleted) and registers a daily gcStale tick. Production
     * boots leave this unset and rely on `WORKTREES_ENABLED=true` to opt
     * in to the default DB-backed manager.
     */
    readonly worktreeManager?: WorktreeManager;
    /**
     * Optional plan-metadata reader used by the {@link AutoTransitionJob}
     * subscriber. Returning `undefined` (the default no-op behaviour)
     * means `auto_transitions: false` for every plan and both event
     * branches stay dormant. Tests inject a populated fake; production
     * wires a real store when the auto-transitions feature is in scope.
     */
    readonly planMetadataStore?: PlanMetadataStore;
}

export interface OrchestratorOptions {
    readonly dbPath?: string;
    /**
     * The REPO flow directory (the default layer). Test seam. The operator
     * profile's flows, pipeline.yaml keys and personas are layered over the
     * repo defaults from the process's ACTIVE profile (config/profile.ts) —
     * one source for all three, so they can never disagree. Only a host
     * entry point activates one, so a test gets repo defaults unless it
     * activates a profile itself.
     */
    readonly flowsDir?: string;
    readonly referenceBaselinePath?: string;
    readonly pipelineConfigPath?: string;
    readonly shadowDiffLogPath?: string;
    readonly defaultFlowId?: string;
    readonly defaultProjectId?: string;
    readonly defaultTaskType?: string;
    readonly logger?: Logger;
    readonly clock?: () => number;
    readonly idGen?: IdGen;
    readonly adapters?: OrchestratorAdapters;
    /**
     * Root directory under which per-project state (notably
     * `<projectId>/agent-memory.jsonl`) lives. Defaults to a `projects/`
     * sibling of the repo root, matching the path v1 writes to so the two
     * pipelines can share an operator filesystem without stomping each
     * other's memory blobs.
     */
    readonly projectsRoot?: string;
    /**
     * Filesystem root the Phase 7 {@link EscalationFileWriter} subscriber
     * uses when materialising `<projectId>/escalations/plan.escalation-*.md`.
     * Defaults to the pipeline workspace root (the same path the worktree
     * manager owns) so escalations live alongside the per-task worktrees.
     */
    readonly workspace?: string;
    /**
     * AP-IFV-001: directory the {@link ProjectRegistry} loads
     * `<projectId>/project.json` from before the flow engine starts. The
     * hydrated registry is passed into {@link FlowEngine.start} so
     * `resolveApproval` can consult per-project `approval_override` maps.
     * Defaults to `<repo>/config/projects`. When the directory is missing
     * the host logs a warning and starts the engine without a registry —
     * production deployments without any projects on disk still boot, but
     * the per-project override layer is inert until the directory exists.
     */
    readonly projectConfigDir?: string;
}

interface PipelineConfig {
    readonly issue_tracker: IssueTrackerKind;
    readonly issue_tracker_shadow: IssueTrackerShadowKind;
    readonly config_store?: ConfigStoreYamlSection;
    readonly worktree_root?: string;
    /**
     * `default_models` from pipeline.yaml: role → model id. Feeds the
     * ClaudeCliRunner's per-role model resolution (`defaultModels[role]`)
     * and the planner / decomposer lifecycle spawns. Flow YAMLs still
     * override per-step; this is the fallback when a step (or the
     * model-less lifecycle agents) doesn't pin one.
     */
    readonly defaultModels?: Readonly<Record<string, string>>;
}

/**
 * Project the `default_models` YAML block (role → model id) into a plain
 * string map, dropping non-string / blank entries. Tolerant of a missing
 * or malformed block (returns `{}`).
 */
function readAgentDefaultModels(block: unknown): Record<string, string> {
    if (!block || typeof block !== 'object' || Array.isArray(block)) return {};
    const out: Record<string, string> = {};
    for (const [role, val] of Object.entries(block as Record<string, unknown>)) {
        if (typeof val === 'string' && val.trim().length > 0) {
            out[role] = val.trim();
        }
    }
    return out;
}

/**
 * Read `<PREFIX><ROLE>` env vars into the role → model override shape
 * every runner's `defaultModels` accepts (`DEEPSEEK_MODEL_DEVELOPER`,
 * `CURSOR_MODEL_TESTER`, ...).
 *
 * Empty / unset values are skipped so a runner's built-in role defaults
 * survive when an operator overrides only a subset (e.g. just the
 * developer). The role is the lowercased SUFFIX, which is what the
 * runners key on.
 *
 * One function, not one per provider: the DeepSeek and Cursor readers
 * were byte-identical apart from the prefix string, so a third provider
 * meant a third copy of the same loop.
 */
/**
 * Parse a positive integer env value, or undefined when absent /
 * unusable. Undefined means "not configured" to every caller, so a typo
 * degrades to the unconfigured behaviour rather than to 0.
 */
function readPositiveInt(raw: string | undefined): number | undefined {
    if (typeof raw !== 'string' || raw.trim().length === 0) return undefined;
    const n = Number.parseInt(raw.trim(), 10);
    return Number.isFinite(n) && n > 0 ? n : undefined;
}

function readRoleModelOverrides(
    env: NodeJS.ProcessEnv,
    prefix: string,
): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
        if (!key.startsWith(prefix)) continue;
        if (typeof value !== 'string' || value.length === 0) continue;
        const role = key.slice(prefix.length).toLowerCase();
        if (role.length === 0) continue;
        out[role] = value;
    }
    return out;
}

/**
 * Supported `AGENT_RUNNER` values — the shared vocabulary from
 * `core/agents/providers`, which is also what the manager API serves.
 * `fake` is the default when unset.
 */
type RunnerKind = AgentProviderId;

/** Output of `buildRunnerByKind` — the runner plus its kill / route surfaces. */
interface BuiltRunner {
    /** Concrete runner — assigned to `this.agentRunner`. */
    readonly runner: RunnerWithFlush;
    /**
     * Surface the killer wraps. Set on real-adapter kinds (claude-cli,
     * deepseek); undefined for the fake so the single-adapter path
     * picks the noop killer.
     */
    readonly interruptable: ClaudeCliInterruptable | undefined;
    /**
     * Surface the role-routing wrapper consumes. Every kind exposes
     * one — fake's `interruptById` is a no-op so fan-out kills on a
     * fake-mapped role resolve silently.
     */
    readonly routable: RoutableRunner;
}

/**
 * Normalise `AGENT_RUNNER` (or one of the per-role overrides) into the
 * canonical RunnerKind. Unset / empty / unrecognised → `fake` (the
 * default, in line with the pre-routing behaviour).
 */
function readRunnerKind(raw: string | undefined): RunnerKind {
    return normalizeProviderId(raw) ?? DEFAULT_AGENT_PROVIDER;
}

/**
 * Read `AGENT_RUNNER_<ROLE>` env vars into a role → kind map. Roles
 * with an empty or unrecognised value are skipped so a partial mapping
 * (only developer + tester pinned) still works — the rest fall through
 * to the global `AGENT_RUNNER` fallback in the router.
 */
function readRoleAdapterOverrides(
    env: NodeJS.ProcessEnv,
): Map<string, RunnerKind> {
    const out = new Map<string, RunnerKind>();
    const prefix = 'AGENT_RUNNER_';
    for (const [key, value] of Object.entries(env)) {
        if (!key.startsWith(prefix)) continue;
        if (typeof value !== 'string' || value.length === 0) continue;
        const role = key.slice(prefix.length).toLowerCase();
        if (role.length === 0) continue;
        // Unrecognised values are SKIPPED here rather than defaulted:
        // the role then falls through to the global AGENT_RUNNER, which
        // is what a typo should do. `fake` is accepted (it is a legal
        // runtime value) even though it is not operator-selectable.
        const normalized = normalizeProviderId(value);
        if (normalized === null) continue;
        out.set(role, normalized);
    }
    return out;
}

function defaultLogger(): Logger {
    // FileLogger by default — the worker-log viewer reads from
    // `<repo>/shared/.cache/worker.log` and is useless without it.
    // `LOG_FILE` overrides only the file *path*; the previous fallback
    // to a console-only logger when LOG_FILE was unset silently
    // disabled the board's worker-log panel.
    const logFile = getLogFile() ?? 'worker.log';
    return new FileLogger(logFile);
}

function defaultIdGen(): IdGen {
    let counter = 0;
    return {
        newId: (): string => `id-${process.pid}-${Date.now()}-${++counter}`,
    };
}

/**
 * Composition root for the v2 pipeline host process.
 *
 * `start()` opens the SQLite state DB, applies migrations, constructs the
 * event bus / store / command bus / flow engine, wires fake (or supplied)
 * adapters, registers the handler set defined in `./handlers`, attaches
 * projection + bridge subscribers, and calls `replayMissed` for every
 * named subscriber so the system resumes cleanly after a restart.
 *
 * `stop()` detaches the flow engine, drains in-flight agent publishes,
 * and closes the database handle.
 *
 * `getCommandBus()` exposes the wired CommandBus so external drivers
 * (integration tests, future operator APIs) can inject commands without
 * reaching past the orchestrator boundary.
 *
 * In Phase 0 the host needs no real external systems: every adapter
 * defaults to its fake from `adapters/fakes/`. Loading the orchestrator
 * with no environment variables set is the supported smoke-test path.
 *
 * # Event naming bridges
 *
 * The orchestrator emits domain events in PascalCase (PlanApproved,
 * TaskCreated, TaskApproved, AgentStarted/AgentFinished) to match the
 * YAML flow definitions and the fake agent runner. The FlowEngine,
 * however, subscribes to a dotted lowercase vocabulary
 * (task.approved, agent.finished, ...). Two named bridge subscribers
 * translate between the two vocabularies:
 *
 *   - bridge-task-created:  TaskCreated  -> task.created
 *   - bridge-task-approved: TaskApproved -> task.approved
 *   - bridge-agent-finished: AgentFinished -> agent.finished
 *
 * The `task.created` bridge is what lets a flow declared with
 * `start_mode: auto` dispatch its first agent step directly from
 * TaskCreated (AP-IFG-002) — without it, `FlowEngine.onTaskCreated`
 * never observes the host's PascalCase `TaskCreated` event and the
 * auto-start path is dead.
 *
 * Bridge publishes use deterministic idempotency keys so replay after a
 * restart is a no-op at the event store (duplicate idempotency keys are
 * de-duped to the originally assigned seq).
 */
export class Orchestrator {
    private readonly options: OrchestratorOptions;
    private readonly subscriberNames: string[] = [];
    private readonly agentToTask = new Map<string, string>();
    /**
     * Shared lifecycle-agent context map. `registerCommandHandlers`
     * writes into it on each planner/decomposer spawn;
     * `registerPlanLifecycleAgentHandlers` reads from it on
     * `AgentFinished` / `AgentFailed` to translate the agent's terminal
     * output into `PlanGenerated` / `PlanDecomposed`. Same instance
     * MUST be threaded through both registrations — without the read
     * side wired, the decomposer JSON never becomes per-task events
     * and the operator board never sees tasks.
     */
    private readonly lifecycleAgents = new Map<string, LifecycleAgentContext>();

    private logger: Logger;
    private clock: () => number;
    private idGen: IdGen;

    private dbPath: string;
    private flowsDir: string;
    private readonly profileHome: string | undefined;
    private referenceBaselinePath: string;
    private pipelineConfigPath: string;
    private shadowDiffLogPath: string;
    private defaultFlowId: string;
    private defaultProjectId: string;
    private defaultTaskType: string;
    private projectsRoot: string;
    private projectConfigDir: string;
    private projectRegistry?: ProjectRegistry;
    private agentMemory?: AgentMemoryStore;

    private db?: Db;
    private bus?: EventBus;
    private commandBus?: CommandBus<unknown>;
    private engine?: FlowEngine;
    private flows?: ReadonlyMap<string, FlowDefinition>;
    private projectProjectionStore?: ProjectProjectionStore;
    private planProjectionStore?: PlanProjectionStore;
    private requirementProjectionStore?: RequirementProjectionStore;
    private agentConfigResolver?: AgentConfigResolver;
    private planReviewStore?: PlanReviewStore;
    private repoProjectionStore?: RepoProjectionStore;
    private workspaceRepoFetcher?: WorkspaceRepoFetcher;
    private repoEnsureUnsubscribe?: () => void;

    private agentRunner: RunnerWithFlush;
    /**
     * Interruptable backing the board-ui's `CancelAgentRun` handler.
     * Set whenever a real runner is in play (`AGENT_RUNNER=claude-cli` →
     * the `ClaudeCliRunner` itself; `AGENT_RUNNER=deepseek` → the
     * runner's inner claude-cli; per-role routing → the
     * `RoleRoutingAgentRunner` which fans the kill out across every
     * inner adapter). `undefined` when only the fake / a test-injected
     * runner is wired — those paths use a `NoopAgentRunKiller`.
     */
    private claudeCliRunner?: ClaudeCliInterruptable;
    private issueTracker: IssueTracker;
    private readonly chatGateway: ChatGateway;
    private readonly sourceControl: SourceControl;
    private configStoreWiring?: ConfigStoreWiring;

    /** Resolved primary/shadow tracker kinds. Filled in start() once the YAML is parsed. */
    private issueTrackerKind: IssueTrackerKind = 'linear';
    private issueTrackerShadow: IssueTrackerShadowKind = 'none';
    private issueTrackerInjected: boolean;
    private cachedPipelineConfig?: PipelineConfig;
    /** Declared GitHub accounts, parsed once. See githubAccounts(). */
    private cachedGithubAccounts?: GitHubAccountMap;
    /**
     * Resolves a task's GitHub-account env overlay. Assigned during
     * start(), where the task/plan lookup statements live; read by
     * subscribers registered outside that scope. Absent before start,
     * which callers read as "ambient identity".
     */
    private githubEnvForTaskFn?: (taskId: string) => Record<string, string>;

    private agentRunnerInjected: boolean;
    private started = false;
    private pendingDeferredStarts = 0;
    private workspace: string;
    private snapshotJob?: SnapshotJobHandle;
    private stateBackupClients?: StateBackupClients;
    private stateBackupJob?: StateBackupJob;
    private worktreeManager?: WorktreeManager;
    private worktreeGcJob?: WorktreeGcJobHandle;
    private taskWorktreeStore?: TaskWorktreeStore;
    /**
     * Tasks whose queued auto-merge is being watched. One watch per
     * task: the operator can click Merge PR again while the first is
     * still polling, and two watchers would publish two TaskResumed
     * events for one merge.
     */
    private readonly enqueuedMergeWatches = new Set<string>();
    /**
     * Per-task dependency edges (AP-IFW-006 Phase 1). Backs the bridge's
     * eligibility gate and the TaskFinished unblock pass. Constructed
     * alongside the state DB.
     */
    private taskDependencyStore?: SqliteTaskDependencyStore;
    /**
     * Attachment metadata projection + blob store (migration 021). The
     * projection is folded from AttachmentAdded / AttachmentRemoved by the
     * projection-tasks subscriber; the blob store (filesystem today) is only
     * touched here to delete bytes on removal — uploads write through the
     * worker-api router's own blob-store handle pointed at the same root.
     */
    private attachmentStore?: SqliteAttachmentStore;
    private attachmentBlobStore?: AttachmentBlobStore;
    private escalationFileWriter?: EscalationFileWriterHandle;
    private autoTransitionJob?: AutoTransitionJobHandle;
    private schedulerHandle?: SchedulerHandle;
    private workerErrorHandlerTeardown?: () => void;

    constructor(options: OrchestratorOptions = {}) {
        this.options = options;

        this.logger = options.logger ?? defaultLogger();
        this.clock = options.clock ?? ((): number => Date.now());
        this.idGen = options.idGen ?? defaultIdGen();

        this.dbPath = options.dbPath ?? getStateDbPath();
        this.flowsDir = options.flowsDir ?? DEFAULT_FLOWS_DIR;
        this.profileHome = activeProfileHome();
        this.referenceBaselinePath =
            options.referenceBaselinePath ?? DEFAULT_REFERENCE_BASELINE_PATH;
        this.pipelineConfigPath =
            options.pipelineConfigPath ?? DEFAULT_PIPELINE_CONFIG_PATH;
        this.shadowDiffLogPath =
            options.shadowDiffLogPath ?? DEFAULT_SHADOW_DIFF_LOG_PATH;
        this.defaultFlowId = options.defaultFlowId ?? DEFAULT_FLOW_ID;
        this.defaultProjectId = options.defaultProjectId ?? DEFAULT_PROJECT_ID;
        this.defaultTaskType = options.defaultTaskType ?? DEFAULT_TASK_TYPE;
        this.projectsRoot = options.projectsRoot ?? DEFAULT_PROJECTS_ROOT;
        this.projectConfigDir =
            options.projectConfigDir ?? DEFAULT_PROJECT_CONFIG_DIR;
        this.workspace = options.workspace ?? DEFAULT_WORKTREE_ROOT;

        const adapters = options.adapters ?? {};
        this.issueTracker = adapters.issueTracker ?? new FakeIssueTracker();
        this.issueTrackerInjected = adapters.issueTracker !== undefined;
        this.chatGateway = adapters.chatGateway ?? new FakeChatGateway();
        this.sourceControl = adapters.sourceControl ?? new FakeSourceControl();

        if (adapters.agentRunner) {
            this.agentRunner = adapters.agentRunner;
            this.agentRunnerInjected = true;
        } else {
            // Placeholder — replaced in start() once the bus exists, because
            // FakeAgentRunner needs the bus as its event publisher.
            this.agentRunner = undefined as unknown as RunnerWithFlush;
            this.agentRunnerInjected = false;
        }
    }

    async start(): Promise<void> {
        if (this.started) return;
        this.verifyReferenceBaseline();
        // Resolve and validate pipeline.yaml BEFORE anything else so an
        // invalid `issue_tracker` (or other rejected value) fails boot
        // with a clear error instead of partially wiring the host.
        this.resolveTrackerRouting();
        // ConfigStore is wired BEFORE any consumer is registered (AC #6 —
        // analogue of `services.AddConfigStore(builder.Configuration)`
        // running before consumer registrations in the .NET host).
        this.attachConfigStore();
        // Operator settings (Management UI Phase 5): overlay stored Settings
        // rows onto process.env before anything snapshots env. Everything
        // downstream — DeepSeek/Cursor construction in initAgentRunner,
        // per-call readers (Jira/Linear clients, git identity,
        // PIPELINE_ARCHITECTURE_REPO_ID) — sees the overlaid values.
        // resolveTrackerRouting above reads pipeline.yaml only (the Jira
        // client reads its env per request), so running after it is safe.
        if (this.configStoreWiring) {
            await applySettingsOverlay(
                this.configStoreWiring.configStore,
                process.env,
                this.logger,
            );
        }
        // State-DB backup/failover (PIPELINE_STATE_BACKUP=1): restore the
        // latest blob backup when no local DB exists — a standby machine
        // boots straight into the primary's state. Must run BEFORE
        // initDatabase opens (and thereby creates) the file. Best-effort:
        // an unreachable storage account logs and boots local-only rather
        // than blocking startup.
        const stateBackupOpts = resolveStateBackupOptions(process.env);
        if (stateBackupOpts) {
            try {
                this.stateBackupClients = await createAzureStateBackupClients(
                    stateBackupOpts,
                    this.logger,
                );
                await restoreStateDbIfMissing(
                    this.dbPath,
                    stateBackupOpts.blobName,
                    this.stateBackupClients,
                    this.logger,
                );
            } catch (err) {
                this.stateBackupClients = undefined;
                this.logger.warn(
                    'state-backup: init failed — continuing WITHOUT backups',
                    { error: err instanceof Error ? err.message : String(err) },
                );
            }
        }
        this.initDatabase();
        // Telemetry retention BEFORE buses/replay: AgentActivity /
        // AgentProgress rows older than the window (default 7 days,
        // PIPELINE_TELEMETRY_RETENTION_DAYS=0 disables) are deleted so
        // the log stops accumulating stream chunks nothing will ever
        // fold again. Freed pages are reused; a manual VACUUM (worker
        // stopped) reclaims the file size itself.
        try {
            const pruned = pruneTelemetryEvents(this.db!, {
                retentionDays: resolveTelemetryRetentionDays(process.env),
                now: this.clock(),
            });
            if (pruned.deleted > 0) {
                this.logger.info('telemetry-prune: deleted old streaming telemetry events', {
                    deleted: pruned.deleted,
                    cutoff: pruned.cutoff,
                });
            }
        } catch (err) {
            this.logger.warn('telemetry-prune: failed (continuing)', {
                error: err instanceof Error ? err.message : String(err),
            });
        }
        // Recover operator clarification answers given BEFORE the
        // projection below existed. `projection-tasks` is long past
        // those offsets, so nothing would replay them, and a task that
        // is mid-flight right now would keep hiding its answer from the
        // reviewer. Idempotent (keyed on the source event seq).
        try {
            backfillClarifications(this.db!, this.logger);
        } catch (err) {
            this.logger.warn('clarification-backfill: failed (continuing)', {
                error: err instanceof Error ? err.message : String(err),
            });
        }
        // Operator-authored project context (migration 034's `context_md`
        // on the projects row). Warmed because the prompt builder reads it
        // synchronously — `startLifecycleAgent` is sync with four call
        // sites — and re-read by `reloadProjectContexts()` when the
        // operator applies config. MUST come after initDatabase: the
        // provider reads the projection, not the config store.
        this.projectContextProvider = new ProjectContextProvider({
            db: this.db!,
            logger: this.logger,
        });
        const loadedContexts = await this.projectContextProvider.refresh();
        if (loadedContexts > 0) {
            this.logger.info('project-context: loaded project contexts', {
                projects: loadedContexts,
            });
        }
        this.initCoreBuses();
        this.initAgentRunner();
        this.flows = loadLayeredFlows(this.flowLayerDirs());
        this.attachProjections();
        this.attachEngineBridges();
        // Tracker subscribers register BEFORE the cascade so PlanApproved
        // and TaskCreated propagate to Linear/Jira *and* mutate the
        // external_refs table before the cascade emits the next event.
        // Reverse that order and the TaskCreated handler reads a missing
        // plan→project mapping and records a spurious shadow-diff entry.
        //
        // Order within the tracker tier: primary registers first so the
        // shadow's external_refs reads (resolve plan→project) follow the
        // authoritative write.
        this.attachPrimaryIssueTrackerSubscriber();
        this.attachShadowIssueTrackerSubscriber();
        // AP-IFG-020 — comment sink runs against the same primary tracker
        // and the same external_refs view as the lifecycle subscriber, but
        // it must register AFTER the primary so a replay processes the
        // PlanApproved/TaskCreated lifecycle writes (which populate
        // external_refs) before the comment sink reads them. Linear-mode
        // only: Jira-primary routings skip the sink entirely so we don't
        // start posting Linear-shaped comments through a Jira adapter.
        this.attachLinearCommentSink();
        this.attachSnapshotJob();
        this.attachWorktreeManager();
        // Phase 7 subscribers wire in the same block as snapshot-job so the
        // composition order stays linear: snapshot-job → worktree-manager
        // (which materialises the WorktreeManager handle the gc job
        // depends on) → Phase 7 trio.
        this.attachPhase7Subscribers();
        this.attachCommandCascades();
        this.registerHandlers();
        // Needs the taskWorktreeStore that registerHandlers() just built.
        this.attachMergeConflictResolver();
        this.workerErrorHandlerTeardown = registerWorkerErrorHandlers({
            bus: this.bus!,
            logger: this.logger,
            clock: this.clock,
        });
        // AP-IFV-001: hydrate ProjectRegistry BEFORE startEngine() so the
        // engine's first dispatch tick already sees per-project
        // approval_override values. The engine subscribes inside
        // FlowEngine.start (which startEngine() calls) so the bus is not
        // drained until after this call returns — provided the registry is
        // built first, no in-flight dispatch can race the bootstrap.
        this.bootstrapProjectRegistry();
        this.startEngine();
        this.attachScheduler();
        await this.replayAllSubscribers();
        // Live-only subscribers never replay (see LIVE_ONLY_SUBSCRIBERS) —
        // surface and clear their backlog so a downtime gap is logged
        // rather than silently carried, and /health's gauge stays honest.
        this.reconcileLiveOnlySubscribers();
        // Resolve agent runs the PREVIOUS worker process left mid-run.
        // Runs after the subscribers are attached (so the events it
        // publishes are folded) and before anything new dispatches.
        await this.reconcileOrphanedAgentRuns();
        // Backfill Claude Code trust for every already-cloned workspace repo
        // (the projection is populated now that replay has run), so headless
        // agents stop warning "this workspace has not been trusted". Runs
        // before agents dispatch their first step, so it doesn't race a live
        // claude process; best-effort + idempotent. New clones are trusted
        // on-ensure (see attachRepoEnsureSubscriber wiring).
        try {
            // Derived from the workspace ROOTS rather than only the
            // projection, because the projection covers one of the
            // three places agents actually run:
            //   repos/<id>      the clone - was covered
            //   worktrees/<id>  where TASK agents run - was not, and a
            //                   fresh worktree per task means a
            //                   directory no human has ever opened
            //   repos/          cwd for a repo-less run, and for
            //                   `gh repo create`
            // Reading the filesystem also covers a clone whose
            // `ensured_path` went stale, which the projection-only
            // list silently missed.
            const clonePaths = (this.repoProjectionStore?.listActive() ?? [])
                .map((r) => r.ensuredPath)
                .filter((p): p is string => typeof p === 'string' && p.length > 0);
            await ensureClaudeWorkspaceTrust(
                workspaceTrustPaths({
                    reposRoot: DEFAULT_REPOS_ROOT,
                    worktreeRoot: path.join(DEFAULT_WORKSPACE_ROOT, 'worktrees'),
                    extra: clonePaths,
                }),
                this.logger,
            );
        } catch {
            /* best-effort — trust backfill never blocks startup */
        }
        // Mirror any design-side attachment that has no copy on disk
        // yet. Every attachment uploaded before this existed has none,
        // and the AttachmentAdded subscriber will not replay them — its
        // offset sits at the log tip. Without this the fix would apply
        // only to attachments added from now on, and the operator whose
        // CSV prompted it would still be told the file is not in the
        // workspace. Idempotent: an existing mirror is skipped.
        //
        // Both worktree-less owners, each to its own root: a plan and a
        // requirement can share an id shape and must not share a
        // directory.
        for (const [owner, root] of [
            ['plan', DEFAULT_PLAN_ATTACHMENTS_ROOT],
            ['requirement', DEFAULT_REQUIREMENT_ATTACHMENTS_ROOT],
        ] as ReadonlyArray<[DesignAttachmentOwner, string]>) {
            try {
                if (!this.db || !this.attachmentBlobStore) break;
                const rows = this.db
                    .prepare(
                        `SELECT id, owner_type, owner_id, file_name, content_type,
                                size_bytes, storage_path, caption, created_at
                           FROM attachments WHERE owner_type = ?`,
                    )
                    .all(owner) as ReadonlyArray<Record<string, unknown>>;
                const written = await backfillDesignAttachments({
                    root,
                    owner,
                    attachments: rows.map((r) => ({
                        id: String(r.id),
                        ownerType: owner,
                        ownerId: String(r.owner_id),
                        fileName: String(r.file_name),
                        contentType: String(r.content_type),
                        sizeBytes: Number(r.size_bytes ?? 0),
                        storageKey: String(r.storage_path),
                        caption: typeof r.caption === 'string' ? r.caption : null,
                        createdAt: Number(r.created_at ?? 0),
                    })),
                    blobStore: this.attachmentBlobStore,
                    logger: this.logger,
                });
                if (written > 0) {
                    this.logger.info(
                        'orchestrator: mirrored attachments for the design agents',
                        { owner, written, root },
                    );
                }
            } catch (err) {
                this.logger.warn('orchestrator: attachment backfill failed', {
                    owner,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        }
        // Periodic state backups start LAST so the first snapshot already
        // contains the boot-time replay/migration writes.
        if (stateBackupOpts && this.stateBackupClients && this.db) {
            this.stateBackupJob = await startStateBackupJob({
                db: this.db as unknown as BackupCapableDb,
                dbPath: this.dbPath,
                clients: this.stateBackupClients,
                opts: stateBackupOpts,
                logger: this.logger,
            });
        }
        this.started = true;
        this.logger.info('orchestrator: started', {
            dbPath: this.dbPath,
            flowsDir: this.flowsDir,
            profileHome: this.profileHome ?? null,
            flows: Array.from(this.flows.keys()),
        });
    }

    private initDatabase(): void {
        this.db = openDatabase(this.dbPath);
        applyMigrations(this.db);
        // Management UI (Option B): per-role agent config from the shared
        // `agents` projection, read at spawn time so UI edits apply live.
        this.agentConfigResolver = new AgentConfigResolver(this.db);
        this.taskDependencyStore = new SqliteTaskDependencyStore(this.db);
        this.attachmentStore = new SqliteAttachmentStore(this.db);
        this.attachmentBlobStore = new FsAttachmentBlobStore(
            attachmentsRoot(),
        );
    }

    /**
     * Resolve `ConfigStoreOptions` from the `config_store:` section of
     * pipeline.yaml overlaid with `PIPELINE_STORE_*` env vars, then
     * construct the matching adapter. Honours `options.adapters.configStore`
     * as a test seam so unit tests can inject a pre-built wiring without
     * touching env vars or the Azure SDK.
     */
    private attachConfigStore(): void {
        const injected = this.options.adapters?.configStore;
        if (injected) {
            this.configStoreWiring = injected;
            return;
        }
        const cfg = this.loadPipelineConfig();
        const options = resolveConfigStoreOptions(
            cfg.config_store,
            process.env,
            configStoreRootDefaults(this.profileHome),
        );
        this.configStoreWiring = createConfigStore(options, {
            logger: this.logger,
        });
        this.logger.info('orchestrator: ConfigStore wired', {
            backendKind: options.backendKind,
            tenant: options.tenant,
        });
    }

    /**
     * REFERENCE_BASELINE pins the v1 (ai-pipeline) commit SHA that v2 is
     * consistent with. The boot path is non-fatal — a missing or malformed
     * baseline file produces a single `warn` and the host continues, so
     * fresh checkouts and recovery scenarios are not blocked.
     */
    private verifyReferenceBaseline(): void {
        let raw: string;
        try {
            raw = fs.readFileSync(this.referenceBaselinePath, 'utf8');
        } catch {
            this.logger.warn('orchestrator: REFERENCE_BASELINE missing', {
                path: this.referenceBaselinePath,
            });
            return;
        }
        const sha = raw.trim();
        if (!COMMIT_SHA_RE.test(sha)) {
            this.logger.warn('orchestrator: REFERENCE_BASELINE malformed', {
                path: this.referenceBaselinePath,
                expected: '40-char hex commit SHA on a single line',
            });
        }
    }

    private initCoreBuses(): void {
        const store = new EventStore(this.db!);
        this.bus = new EventBus(store, this.logger);
        this.commandBus = new CommandBus<unknown>(this.bus, () => undefined);
    }

    /**
     * Pick the agent runner based on `AGENT_RUNNER` (read at call time so
     * `worker/.env` wins over module-level caching — see the env-var-at-
     * call-time convention in CLAUDE.md):
     *
     *   AGENT_RUNNER unset | 'fake' → FakeAgentRunner (in-memory, publishes
     *                                 lifecycle events synthetically)
     *   AGENT_RUNNER='claude-cli'   → ClaudeCliRunner spawning the real
     *                                 `claude` CLI; sidecarDir resolves from
     *                                 AGENT_SIDECAR_DIR (or the runner's
     *                                 os.tmpdir() default when unset).
     *
     * An injected runner short-circuits both branches so tests can pin a
     * specific adapter without touching env vars.
     */
    private initAgentRunner(): void {
        if (this.agentRunnerInjected) return;
        const env = process.env;
        const fallbackKind = readRunnerKind(env.AGENT_RUNNER);
        const roleOverrides = readRoleAdapterOverrides(env);

        // Providers to build: the fallback, any env per-role override
        // (AGENT_RUNNER_<ROLE>), and any provider an operator set on an agent in
        // the management UI (Option B). Best-effort — a provider whose runner
        // can't be built (missing creds) is skipped so one misconfigured agent
        // can't break boot; only the fallback's creds are mandatory.
        // Operator-selectable ids only: an Agent record cannot name
        // `fake`, so a stored value outside this set is stale config and
        // is ignored rather than silently routing a role to the fake.
        const VALID_PROVIDERS = new Set<string>(SELECTABLE_AGENT_PROVIDER_IDS);
        const kinds = new Set<RunnerKind>();
        kinds.add(fallbackKind);
        for (const k of roleOverrides.values()) kinds.add(k);
        for (const p of this.agentConfigResolver?.distinctProviders() ?? []) {
            if (VALID_PROVIDERS.has(p)) kinds.add(readRunnerKind(p));
        }

        const builtByKind = new Map<RunnerKind, BuiltRunner>();
        for (const kind of kinds) {
            try {
                builtByKind.set(kind, this.buildRunnerByKind(kind, env));
            } catch (err) {
                if (kind === fallbackKind) throw err; // fallback creds required
                this.logger.warn('orchestrator: agent-runner provider unavailable; skipping', {
                    kind,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        }
        const fallbackBuilt = builtByKind.get(fallbackKind)!;

        // Fast path: no env overrides, only the fallback provider built, AND
        // no agent-config resolver → a single adapter, identical to the
        // pre-routing world. When the resolver exists the router must be
        // installed even for a single provider: an operator can set a role's
        // provider in the Agents panel at any time, and the router consults
        // the resolver per spawn (a provider whose backend was not built at
        // boot still needs a restart — the UI footnote says so).
        if (roleOverrides.size === 0 && builtByKind.size === 1 && !this.agentConfigResolver) {
            this.agentRunner = fallbackBuilt.runner;
            this.claudeCliRunner = fallbackBuilt.interruptable;
            return;
        }

        // Router path: wrap every built provider. `byRole` is the env-driven
        // per-role map; `byProvider` (keyed by provider name == RunnerKind)
        // lets an Agent's `provider` route a role to its backend at spawn time.
        const byRole = new Map<string, RoutableRunner>();
        for (const [role, kind] of roleOverrides.entries()) {
            const built = builtByKind.get(kind);
            if (built) byRole.set(role, built.routable);
        }
        const byProvider = new Map<string, RoutableRunner>();
        for (const [kind, built] of builtByKind) byProvider.set(kind, built.routable);

        const router = new RoleRoutingAgentRunner({
            byRole,
            byProvider,
            resolveProvider: (role) => this.agentConfigResolver?.provider(role),
            fallback: fallbackBuilt.routable,
            logger: this.logger,
        });
        this.agentRunner = router;
        // Hand the router to the killer regardless of fallback kind — its
        // fan-out is a no-op on adapters that don't own the runId.
        this.claudeCliRunner = router;
    }

    /**
     * Construct the AgentRunner for a single kind, returning both the
     * runner itself and (when applicable) a ClaudeCliInterruptable
     * handle the killer / router can consume. The deepseek branch
     * surfaces its inner claude-cli runner here so the killer wires
     * to the same sidecar / interruptById contract regardless of which
     * adapter the operator selected.
     */
    private buildRunnerByKind(kind: RunnerKind, env: NodeJS.ProcessEnv): BuiltRunner {
        if (kind === 'claude-cli') {
            const sidecarDir = env.AGENT_SIDECAR_DIR;
            const runner = new ClaudeCliRunner({
                bus: this.bus!,
                clock: this.clock,
                logger: this.logger,
                // pipeline.yaml `default_models` → per-role model resolution
                // (`defaultModels[role]`). Without this the block was dead
                // config for the claude-cli runner; now a role's model falls
                // back to it when a flow step (or a lifecycle agent) doesn't
                // pin one. Flow-step `model:` still wins (spec.metadata.model).
                defaultModels: this.loadPipelineConfig().defaultModels ?? {},
                // Management UI (Option B): per-role model override from the
                // Agents panel, consulted above pipeline.yaml defaults but below
                // an explicit flow step.model. Read live from the shared agents
                // table so an edit applies on the next spawn.
                resolveDefaultModel: (role) => this.agentConfigResolver?.model(role),
                ...(sidecarDir !== undefined && sidecarDir.length > 0
                    ? { sidecarDir }
                    : {}),
            });
            return { runner, interruptable: runner, routable: runner };
        }
        if (kind === 'deepseek') {
            const apiKey = env.DEEPSEEK_API_KEY;
            if (!apiKey || apiKey.length === 0) {
                throw new Error(
                    'agent runner "deepseek" requires DEEPSEEK_API_KEY to be set.',
                );
            }
            const sidecarDir = env.AGENT_SIDECAR_DIR;
            const baseUrl = env.DEEPSEEK_BASE_URL;
            const defaultEffort = env.DEEPSEEK_EFFORT_DEFAULT;
            const defaultModels = readRoleModelOverrides(env, 'DEEPSEEK_MODEL_');
            const runner = new DeepSeekRunner({
                bus: this.bus!,
                clock: this.clock,
                logger: this.logger,
                apiKey,
                resolveDefaultModel: (role) => this.agentConfigResolver?.model(role),
                ...(baseUrl !== undefined && baseUrl.length > 0
                    ? { baseUrl }
                    : {}),
                ...(defaultEffort !== undefined && defaultEffort.length > 0
                    ? { defaultEffort }
                    : {}),
                ...(Object.keys(defaultModels).length > 0
                    ? { defaultModels }
                    : {}),
                ...(sidecarDir !== undefined && sidecarDir.length > 0
                    ? { sidecarDir }
                    : {}),
            });
            // Kill goes through the inner claude-cli runner (the
            // spawned process is still `claude`); router routing goes
            // through the DeepSeek wrapper so spec adjustment (model
            // strip, effort clamp) still happens.
            return {
                runner,
                interruptable: runner.inner,
                routable: runner as unknown as RoutableRunner,
            };
        }
        if (kind === 'cursor-cli') {
            const sidecarDir = env.AGENT_SIDECAR_DIR;
            const defaultModel = env.CURSOR_MODEL;
            const defaultModels = readRoleModelOverrides(env, 'CURSOR_MODEL_');
            const runner = new CursorCliRunner({
                bus: this.bus!,
                clock: this.clock,
                logger: this.logger,
                resolveDefaultModel: (role) => this.agentConfigResolver?.model(role),
                ...(defaultModel !== undefined && defaultModel.length > 0
                    ? { defaultModel }
                    : {}),
                ...(Object.keys(defaultModels).length > 0
                    ? { defaultModels }
                    : {}),
                ...(sidecarDir !== undefined && sidecarDir.length > 0
                    ? { sidecarDir }
                    : {}),
            });
            // CursorCliRunner exposes the same `interruptById` /
            // `killedSidecarPath` contract as ClaudeCliRunner — no
            // wrapper needed.
            return {
                runner,
                interruptable: runner,
                routable: runner as unknown as RoutableRunner,
            };
        }
        if (kind === 'ollama' || kind === 'ollama-cloud') {
            return this.buildOllamaRunner(kind, env);
        }
        if (kind === 'fake') {
            const runner = new FakeAgentRunner({
                bus: this.bus!,
                clock: this.clock,
            });
            // Fake is routable for fan-out kill purposes; routing.test.ts
            // covers the fan-out shape.
            return {
                runner,
                interruptable: undefined,
                routable: runner as unknown as RoutableRunner,
            };
        }
        // Exhaustiveness: `kind` is the registry's union, so a provider
        // added to `AGENT_PROVIDER_DESCRIPTORS` with no branch above
        // fails THIS ASSIGNMENT at compile time.
        //
        // That is the whole point of the check. Before, the function
        // ended with an unconditional `new FakeAgentRunner(...)`, so a
        // provider whose branch was forgotten built the fake instead:
        // the operator got an agent that started, produced fabricated
        // output and reported success. A typecheck failure is the
        // cheapest possible version of that bug.
        const unhandled: never = kind;
        throw new Error(
            `orchestrator: no runner factory for agent provider "${String(unhandled)}"`,
        );
    }

    /**
     * Ollama, local or cloud. One adapter, two providers.
     *
     * They differ in exactly three ways: the default base URL, whether
     * an API key is mandatory, and whether a context-window figure is
     * worth asking for. Everything else - the Anthropic-compatible
     * endpoint, the model aliasing, the disabled-traffic env keys - is
     * identical, so the split lives here rather than in two adapters.
     *
     * The split exists at all because the base URL belongs to the runner
     * INSTANCE: with one provider an operator could have local models or
     * cloud models, never both at once. Two providers let per-role
     * routing (`AGENT_RUNNER_DEVELOPER=ollama-cloud`) mix them.
     *
     * A model tag is mandatory for both. There is no sensible default:
     * the tag has to name something the operator pulled or something the
     * cloud serves, and a plausible-looking guess would 404 at spawn.
     * Refusing here matches the deepseek branch refusing without a key -
     * the provider is skipped with a warning unless it is the fallback.
     */
    private buildOllamaRunner(
        kind: 'ollama' | 'ollama-cloud',
        env: NodeJS.ProcessEnv,
    ): BuiltRunner {
        const cloud = kind === 'ollama-cloud';
        const model = env.OLLAMA_MODEL;
        if (!model || model.length === 0) {
            // The two flavours name models differently and this message
            // used to get the hosted one wrong — it suggested
            // "gemma4:cloud", which is the CLI form the hosted API
            // rejects. The suffix is now rewritten by the adapter, but
            // the advice an operator reads has to be right on its own.
            throw new Error(
                `agent runner "${kind}" requires OLLAMA_MODEL. There is no`
                + ' default: the tag must name a model the server actually'
                + ' serves. Locally that is something you pulled, such as'
                + ' "qwen3-coder:30b"; on the hosted endpoint it is a bare name'
                + ' from https://ollama.com/api/tags, such as "mistral-large-4"'
                + ' or "gemma4:31b" (the ":cloud" suffix ollama.com displays is'
                + ' for the Ollama CLI, not for the API).',
            );
        }
        const apiKey = env.OLLAMA_API_KEY;
        if (cloud && (!apiKey || apiKey.length === 0)) {
            // Only the cloud endpoint authenticates; the local daemon
            // ignores the token entirely.
            throw new Error(
                'agent runner "ollama-cloud" requires OLLAMA_API_KEY. Use the'
                + ' "ollama" provider for a local daemon, which needs no key.',
            );
        }
        const baseUrl = (cloud ? env.OLLAMA_CLOUD_BASE_URL : env.OLLAMA_BASE_URL)
            ?? (cloud ? OLLAMA_CLOUD_BASE_URL : OLLAMA_DEFAULT_BASE_URL);
        const smallModel = env.OLLAMA_SMALL_MODEL;
        const contextTokens = readPositiveInt(env.OLLAMA_CONTEXT_TOKENS);
        if (!cloud && contextTokens === undefined) {
            // The local daemon's window is small by default and derived
            // from VRAM, and an oversized prompt is TRUNCATED FROM THE
            // FRONT with a normal 200 - which in this pipeline means the
            // agent runs without its workspace-boundary block. Without a
            // figure here the runner cannot check, so say so once.
            this.logger.warn(
                'orchestrator: OLLAMA_CONTEXT_TOKENS is unset, so prompt size'
                + ' cannot be checked against the local server window. Ollama'
                + ' silently drops the FRONT of an oversized prompt - including'
                + ' the workspace-boundary block. Set OLLAMA_CONTEXT_LENGTH on'
                + ' the daemon and mirror it here.',
            );
        }
        const sidecarDir = env.AGENT_SIDECAR_DIR;
        const runner = new OllamaRunner({
            bus: this.bus!,
            clock: this.clock,
            logger: this.logger,
            model,
            baseUrl,
            // Drives the `:cloud` → bare-name rewrite. Keyed off the
            // provider rather than the base URL so it still applies
            // behind a gateway or proxy.
            cloud,
            resolveDefaultModel: (role) => this.agentConfigResolver?.model(role),
            ...(apiKey !== undefined && apiKey.length > 0 ? { apiKey } : {}),
            ...(smallModel !== undefined && smallModel.length > 0
                ? { smallModel }
                : {}),
            ...(contextTokens !== undefined ? { contextTokens } : {}),
            defaultModels: readRoleModelOverrides(env, 'OLLAMA_MODEL_'),
            ...(sidecarDir !== undefined && sidecarDir.length > 0
                ? { sidecarDir }
                : {}),
        });
        // Kill goes through the inner claude-cli runner (the spawned
        // process is still `claude`); routing goes through the wrapper so
        // the claude-* model strip still happens. Same shape as deepseek.
        return {
            runner,
            interruptable: runner.inner,
            routable: runner as unknown as RoutableRunner,
        };
    }

    private registerHandlers(): void {
        // pipeline.yaml `default_models` → planner / decomposer model. These
        // lifecycle agents aren't flow steps, so they have no per-step
        // `model:` to pin one; threading the configured value here makes
        // `default_models.planner` / `.decomposer` the real knob (and keeps
        // the resolved id visible in AgentStarted metadata). Absent → the
        // handler passes 'none', letting the runner's defaultModels / env
        // resolve it.
        const defaultModels = this.loadPipelineConfig().defaultModels ?? {};
        // Per-host gate + memory store. The gate's subscriber is registered
        // BEFORE handler installation so a replay on restart re-builds the
        // gate from the persisted PlanGenerated events.
        const gateWiring = buildPlanGenerationGateWiring();
        this.attachPlanGenerationGateSubscriber(gateWiring.recordOnEvent);
        this.agentMemory = new AgentMemoryStore(this.projectsRoot);

        // The interrupt-retry modal's feedback → `interrupt-retry` agent
        // memory. Its own subscriber rather than a line in a projection:
        // it matches a PAIR of events (TaskInterrupted then the retry's
        // TaskFieldsUpdated) and owns the mark that links them.
        attachInterruptFeedbackMemory({
            bus: this.bus!,
            memory: this.agentMemory,
            logger: this.logger,
            clock: () => this.clock(),
            tasks: {
                lookup: (taskId: string) => {
                    try {
                        const row = this.db!
                            .prepare(
                                `SELECT t.title AS title, p.project_id AS project_id
                                   FROM tasks t JOIN plans p ON p.id = t.plan_id
                                  WHERE t.id = ?`,
                            )
                            .get(taskId) as
                                | { title?: string | null; project_id?: string | null }
                                | undefined;
                        const projectId = row?.project_id;
                        if (typeof projectId !== 'string' || projectId.length === 0) {
                            return undefined;
                        }
                        return { projectId, title: row?.title ?? taskId };
                    } catch {
                        return undefined;
                    }
                },
            },
        });

        // Board-UI + manager-api command vocabularies share the orchestrator's
        // CommandBus so a single dispatch surface carries every operator-facing
        // command. The killer adapter is the only side-effect port the board's
        // CancelAgentRun handler depends on: wire the live ClaudeCliRunner
        // wrapper when the real runner is in play, fall back to the no-op when
        // the fake runner is configured (nothing to signal).
        //
        // AP-PAO-004: registered BEFORE `registerCommandHandlers` so the board-
        // ui's pre-existing `DeletePlan` handler (richer payload carrying the
        // actor) wins the bus slot; the orchestrator's AP-PAO `DeletePlan`
        // registration then defers gracefully via its try/catch guard. Same
        // command type, same emitted event type ('PlanDeleted').
        const killer: AgentRunKiller = this.claudeCliRunner !== undefined
            ? new ClaudeCliAgentRunKiller(this.claudeCliRunner)
            : new NoopAgentRunKiller({ logger: this.logger });
        registerBoardUiCommands(this.commandBus!, {
            clock: this.clock,
            idGen: this.idGen,
            logger: this.logger,
            runner: killer,
        });
        registerManagerApiCommands(this.commandBus!, {
            clock: this.clock,
            idGen: this.idGen,
            logger: this.logger,
        });

        // WorkspaceRepoFetcher + refresh trigger constructed BEFORE the
        // lifecycle handlers so `resolveRepoSpec` below can close over a
        // ready trigger — the planner's pre-spawn refresh fans out
        // through the same code path the operator-fired "Sync now"
        // button does, keeping the per-repo `RepoSynced` / `RepoSyncFailed`
        // event log a single source of truth.
        this.workspaceRepoFetcher = new WorkspaceRepoFetcher({
            logger: this.logger,
            reposRoot: DEFAULT_REPOS_ROOT,
        });
        const repoRefreshTrigger = createRepoRefreshTrigger({
            bus: this.bus!,
            clock: this.clock,
            logger: this.logger,
            fetcher: this.workspaceRepoFetcher,
            projection: this.repoProjectionStore!,
            // Sync/Refresh clones and fetches too, so it needs the account
            // just as much as the on-register path. Omitting it here is
            // exactly the bug the operator hit: a correctly mapped repo
            // was cloned with the AMBIENT identity, and GitHub answers a
            // private repo the token cannot see with "Could not resolve to
            // a Repository" rather than a permission error — so it reads
            // as though the repo does not exist.
            resolveGithubEnv: (accountId) => this.githubEnvForAccount(accountId),
        });

        // Per-spawn `RepoSpec` resolver. Reads the plan's chosen
        // workspace repoId out of the `sidebar_plans.metadata.targetRepo`
        // JSON column, looks up the corresponding row on the workspace
        // repo registry, awaits a `git fetch + git reset --hard` so the
        // agent sees the latest content (proceeding with stale on
        // failure per operator policy), and returns a `RepoSpec`
        // pointing at the ensured path. Returns `null` when any step
        // can't resolve — handler then spawns without a repo block.
        const repoMetaStmt = this.db!.prepare(
            'SELECT metadata FROM sidebar_plans WHERE plan_id = ? LIMIT 1',
        );
        const repoProjection = this.repoProjectionStore!;
        const orchestratorLogger = this.logger;
        // Plan-level targetRepo lookup, shared by the lifecycle resolver
        // and the task resolver's fallback path.
        const planTargetRepoId = (planId: string): string | null => {
            const row = repoMetaStmt.get(planId) as
                | { metadata: string | null }
                | undefined;
            if (!row || typeof row.metadata !== 'string' || row.metadata.length === 0) {
                return null;
            }
            try {
                const parsed = JSON.parse(row.metadata) as { targetRepo?: unknown };
                return typeof parsed.targetRepo === 'string' && parsed.targetRepo.length > 0
                    ? parsed.targetRepo
                    : null;
            } catch {
                return null;
            }
        };
        const resolveRepoSpecByRepoId = async (
            repoId: string,
            logCtx: Record<string, unknown>,
        ): Promise<RepoSpec | null> => {
            const repo = repoProjection.get(repoId);
            if (!repo) {
                orchestratorLogger.warn(
                    'resolveRepoSpec: repoId not in workspace repo registry',
                    { ...logCtx, repoId },
                );
                return null;
            }
            // Pre-spawn refresh. Calls WorkspaceRepoFetcher.refresh under
            // the hood (`git fetch origin && git reset --hard
            // origin/<default-branch>`). Logged at INFO start/finish so
            // the operator can confirm in the worker log that EVERY
            // agent (planner / decomposer / developer / reviewer / tester
            // / committer) sees a clone synced against origin before
            // its prompt is built. `await` is load-bearing — the agent
            // spawn waits for the reset to complete before reading the
            // tree.
            const refreshStartedAt = Date.now();
            orchestratorLogger.info(
                'resolveRepoSpec: pre-spawn refresh starting',
                { ...logCtx, repoId, repoPath: repo.ensuredPath ?? null },
            );
            try {
                await repoRefreshTrigger.refreshOne(repoId);
                orchestratorLogger.info(
                    'resolveRepoSpec: pre-spawn refresh complete',
                    {
                        ...logCtx,
                        repoId,
                        durationMs: Date.now() - refreshStartedAt,
                    },
                );
            } catch (err) {
                orchestratorLogger.warn(
                    'resolveRepoSpec: pre-spawn refresh threw; proceeding with stale clone',
                    {
                        ...logCtx,
                        repoId,
                        error: err instanceof Error ? err.message : String(err),
                    },
                );
            }
            const updated = repoProjection.get(repoId);
            if (!updated?.ensuredPath) {
                orchestratorLogger.warn(
                    'resolveRepoSpec: repo has no ensured_path post-refresh',
                    { ...logCtx, repoId },
                );
                return null;
            }
            return { repoPath: updated.ensuredPath };
        };
        const resolveRepoSpecByPlanId = async (
            planId: string,
        ): Promise<RepoSpec | null> => {
            const repoId = planTargetRepoId(planId);
            if (!repoId) return null;
            return resolveRepoSpecByRepoId(repoId, { planId });
        };

        const resolveRepoSpec = async (
            args: StartLifecycleAgentArgs,
        ): Promise<RepoSpec | null> => resolveRepoSpecByPlanId(args.planId);

        // FsRepoReader is the production `RepoReader` adapter — walks
        // the working tree, reads CLAUDE.md, samples a few key files.
        // One instance shared across every planner / decomposer spawn.
        // Core samples only CLAUDE.md; enabled packs add the files that
        // matter for their stack (the dotnet-azure pack: Program.cs and the
        // .csproj files).
        const repoReader = new FsRepoReader({
            logger: this.logger,
            defaultSampleGlobs: [
                'CLAUDE.md',
                ...this.getStackHooks().flatMap((h) => h.repoSampleGlobs ?? []),
            ],
        });

        // Task-agent `RepoSpec` resolver. Walks `tasks.plan_id` →
        // `sidebar_plans.metadata.targetRepo` → `repos.ensured_path`,
        // runs the pre-spawn refresh, and returns the spec — same
        // shape lifecycle agents use, just keyed by taskId at the entry
        // point so the StartAgent handler doesn't have to re-derive the
        // planId itself.
        const taskPlanLookupStmt = this.db!.prepare(
            'SELECT plan_id, type FROM tasks WHERE id = ?',
        );
        // Per-task feature-branch worktrees. `ensureWorktree` is
        // idempotent: the first StartAgent for a task creates the
        // worktree off the repo's default branch; every subsequent
        // step in the chain (reviewer / tester / committer) sees the
        // same path so they all amend the developer's branch instead
        // of the workspace clone's main.
        const taskWorktreeStore = new TaskWorktreeStore({
            db: this.db!,
            // Share the same workspace root the repo-clones live under
            // (DEFAULT_WORKSPACE_ROOT — typically C:\Drop-AI\Source).
            // Previously this was hardcoded to
            // `pipeline-v2\.pipeline-workspace\worktrees` so worktrees
            // stayed at the old location while clones moved (the helper
            // that built that path is gone — see the note where it used
            // to live in task-worktrees.ts). The agent then saw two
            // disjoint paths in its WORKSPACE_RULES block, found the
            // worktree empty, and operated on the bare clone instead —
            // landing edits on the clone's branch rather than the task
            // feature branch, so push + PR creation either failed or
            // produced an empty PR.
            worktreeRoot: path.join(DEFAULT_WORKSPACE_ROOT, 'worktrees'),
            logger: this.logger,
            clock: this.clock,
            // Wire the workspace-repo registry so `removeOnDisk` can
            // resolve the originating clone path and run
            // `git worktree remove --force` from the superproject —
            // cleaner than a bare fs.rm (no stale `.git/worktrees/*`
            // metadata left behind).
            resolveRepoPath: (repoId): string | null => {
                const repo = this.repoProjectionStore?.get(repoId);
                return repo?.ensuredPath ?? null;
            },
            // The store fetches and resets inside a worktree, which talks
            // to the remote — so it needs the repo's GitHub account like
            // every other remote call. Lazy: the resolver is defined
            // later in start().
            githubEnvForTask: (taskId) => this.githubEnvForTaskFn?.(taskId) ?? {},
        });
        this.taskWorktreeStore = taskWorktreeStore;

        const taskRepoLookupStmt = this.db!.prepare(
            'SELECT repo_id FROM tasks WHERE id = ?',
        );

        /**
         * The GitHub-account environment for a task's git/gh work.
         *
         * Resolves the repo the SAME way resolveTaskRepoSpec does -
         * the task's own `repo_id` first, then the plan's
         * `metadata.targetRepo` - because the account has to come from
         * the repo the worktree is actually on. Two different rules
         * would mean pushing to one repo with another repo's
         * credential.
         *
         * An EMPTY overlay whenever anything is missing or unmapped:
         * the child then uses the machine's ambient identity, exactly
         * as before accounts existed. Never a fallback to some OTHER
         * configured account - a push cannot be taken back.
         */
        const githubEnvForTask = (taskId: string): Record<string, string> => {
            try {
                const taskRepoRow = taskRepoLookupStmt.get(taskId) as
                    | { repo_id: string | null }
                    | undefined;
                const planRow = taskPlanLookupStmt.get(taskId) as
                    | { plan_id: string | null }
                    | undefined;
                const repoId
                    = (typeof taskRepoRow?.repo_id === 'string'
                        && taskRepoRow.repo_id.length > 0
                        ? taskRepoRow.repo_id
                        : null)
                    ?? (planRow?.plan_id ? planTargetRepoId(planRow.plan_id) : null);
                if (!repoId) return {};
                return this.githubEnvForRepoId(repoId);
            } catch (err) {
                // A resolution failure must not block the push: degrade
                // to the ambient identity and say so.
                orchestratorLogger.warn(
                    'github account resolve failed; using ambient identity',
                    {
                        taskId,
                        error: err instanceof Error ? err.message : String(err),
                    },
                );
                return {};
            }
        };
        // Subscribers registered outside this scope resolve through
        // the instance rather than re-deriving the rule.
        this.githubEnvForTaskFn = githubEnvForTask;

        // Shared per-repo worktrees for `deploy-azure`. A deploy commits
        // nothing — it only needs the origin tip plus the repo's
        // Deploy/*.ps1 — so a throwaway per-task checkout buys no
        // isolation the shared one lacks and costs a full cold rebuild
        // every time (no obj/ or bin/ carried over). One reusable
        // detached checkout per repo keeps the isolation from the
        // workspace clone AND the warm build cache. Everything else
        // (deploy-nuget included: it commits a version bump) keeps its
        // per-task feature-branch worktree.
        const taskStatusLookupStmt = this.db!.prepare(
            'SELECT status FROM tasks WHERE id = ?',
        );
        const deployWorktreeStore = new DeployWorktreeStore({
            worktreeRoot: path.join(DEFAULT_WORKSPACE_ROOT, 'worktrees'),
            logger: this.logger,
            // The store's own `git fetch origin` talks to the remote, so
            // it needs the account like every other remote call. Keyed
            // by repoId because the deploy worktree is per repo.
            githubEnvForRepo: (repoId) => this.githubEnvForRepoId(repoId),
            // Releases the shared checkout from a previous deploy. An
            // UNKNOWN task (row gone) counts as finished — a missing row
            // must never wedge a repo's deploys forever.
            isTaskInFlight: (holderId: string): boolean => {
                try {
                    const row = taskStatusLookupStmt.get(holderId) as
                        | { status: string | null }
                        | undefined;
                    if (!row) return false;
                    return !TERMINAL_TASK_STATUSES.has(String(row.status ?? ''));
                } catch {
                    return false;
                }
            },
        });
        const resolveTaskRepoSpec = async (
            taskId: string,
        ): Promise<RepoSpec | null> => {
            const row = taskPlanLookupStmt.get(taskId) as
                | { plan_id: string | null; type: string | null }
                | undefined;
            if (!row || !row.plan_id) return null;
            // Per-task repo (migration 028, from the decomposer's
            // context.repo_path) WINS over the plan's metadata.targetRepo:
            // the planner may have discovered mid-plan that the change
            // lives in a different repo than the plan was filed under.
            // Without this the task got a worktree for the wrong repo and
            // the agent edited the right repo's SHARED CLONE directly.
            const taskRepoRow = taskRepoLookupStmt.get(taskId) as
                | { repo_id: string | null }
                | undefined;
            const taskRepoId
                = typeof taskRepoRow?.repo_id === 'string' && taskRepoRow.repo_id.length > 0
                    ? taskRepoRow.repo_id
                    : null;
            const repoId = taskRepoId ?? planTargetRepoId(row.plan_id) ?? '';
            if (repoId.length === 0) {
                // Repo-less DIAGNOSTIC tasks run rooted at the workspace
                // repos directory: the fault may live in shared
                // infrastructure, so the agent gets read access to EVERY
                // clone for code correlation instead of being pinned to
                // one repo. Which types run this way is declared by the
                // flow (`task_type.worktree: workspace-root`), not by a
                // hardcoded type name — core knows no stack's type ids. This
                // is the repos PARENT dir, never a clone itself — the
                // agent is read-only by persona and there is no branch /
                // worktree to pollute. Everything else keeps the null
                // (no-cwd) behaviour: a repo-less implement task must
                // fail cleanly, not silently edit the wrong tree. "No
                // cwd" only became true recently — spawn() inherits the
                // orchestrator's cwd for an undefined one, so this
                // branch used to run the agent inside dropagents.
                // ClaudeCliRunner.resolveCwd now substitutes an empty
                // scratch dir.
                if (this.taskTypes().workspaceRootWorktree().has(row.type ?? '')) {
                    return { repoPath: DEFAULT_REPOS_ROOT };
                }
                return null;
            }
            if (taskRepoId && taskRepoId !== planTargetRepoId(row.plan_id)) {
                orchestratorLogger.info(
                    'resolveTaskRepoSpec: task repo overrides plan targetRepo',
                    { taskId, taskRepoId, planId: row.plan_id },
                );
            }
            const repoSpec = await resolveRepoSpecByRepoId(repoId, {
                taskId,
                planId: row.plan_id,
            });
            if (!repoSpec) return null;
            // Deploy tasks take the repo's shared deploy worktree when
            // it is free. `acquire` returns null when another deploy of
            // the same repo is still running or git failed — both mean
            // "use your own per-task worktree", so this can only ever
            // degrade to the behaviour below, never block a deploy.
            // Which types do is declared by their flow
            // (`task_type.worktree: shared-deploy`) — types that commit
            // nothing, where a throwaway checkout would cold-rebuild every
            // deploy.
            if (this.taskTypes().sharedDeployWorktree().has(row.type ?? '')) {
                const shared = await deployWorktreeStore.acquire(
                    taskId, repoId, repoSpec.repoPath,
                );
                if (shared) return { repoPath: shared };
            }
            // No fallback to the bare clone on failure. The clone is
            // the workspace's shared sync target — `repo-refresh:
            // synced` (git fetch + reset) runs before every agent
            // step, which wipes any local edits the developer made
            // between steps. Silently running there produces the
            // pathological symptom of "reviewer / committer see no
            // source changes" while the developer reports success.
            // Propagate the error so the spawn fails cleanly and the
            // operator sees the underlying worktree problem.
            const wt = await taskWorktreeStore.ensureWorktree(
                taskId, repoId, repoSpec.repoPath,
            );
            // After ensureWorktree returns (existing or freshly
            // created), advance the feature branch to the latest
            // origin tip if the worktree has no committed/uncommitted
            // local work. Without this an existing worktree branched
            // off origin BEFORE a sibling dependency's PR merged
            // stayed stuck at the old base — the developer agent
            // would read stale code on the very next spawn even though
            // the bare clone was just refreshed. `freshenIfClean`
            // checks `git status --porcelain` + `git rev-list HEAD
            // ^origin/<default> --count` and skips the reset when
            // either signal shows WIP, so multi-step task pipelines
            // (dev commits, reviewer reads, tester reads, committer
            // pushes) keep their iteration state intact.
            await taskWorktreeStore.freshenIfClean(taskId);
            return { repoPath: wt.path };
        };

        registerCommandHandlers(this.commandBus!, {
            reportRoles: () => this.reportRoleIds(),
            // Agents run git and gh themselves, so the task repo's GitHub
            // account has to reach the agent PROCESS, not just the
            // pipeline's own calls.
            githubEnvForTask: (taskId: string) =>
                this.githubEnvForTaskFn?.(taskId) ?? {},
            // Plan-scoped agents (planner, decomposer, architect) run
            // before any task exists, so they resolve through the plan
            // metadata's targetRepo instead - the same repoId -> account
            // rule underneath.
            githubEnvForPlan: (planId: string) =>
                this.githubEnvForRepoId(planTargetRepoId(planId)),
            clock: this.clock,
            idGen: this.idGen,
            logger: this.logger,
            defaultFlowId: this.defaultFlowId,
            defaultProjectId: this.defaultProjectId,
            defaultTaskType: this.defaultTaskType,
            agentRunner: this.agentRunner,
            registerAgent: (agentId, taskId) => {
                this.agentToTask.set(agentId, taskId);
            },
            deferAgentStart: (run) => this.deferAgentStart(run),
            planGenerationGate: gateWiring.gate,
            agentMemory: this.agentMemory,
            // ResumeTask side effects. The sidecar goes to the task's
            // worktree — the same directory the agent runs in, so a
            // file-first agent finds the operator's answer next to
            // TASK.md.
            resumeWorktrees: {
                pathFor: (taskId: string): string | undefined =>
                    taskWorktreeStore.get(taskId)?.path,
            },
            resumeProjectLookup: {
                projectIdFor: (taskId: string): string | undefined => {
                    try {
                        const row = this.db!
                            .prepare(
                                `SELECT p.project_id AS project_id
                                   FROM tasks t JOIN plans p ON p.id = t.plan_id
                                  WHERE t.id = ?`,
                            )
                            .get(taskId) as { project_id?: string | null } | undefined;
                        return row?.project_id ?? undefined;
                    } catch {
                        return undefined;
                    }
                },
            },
            // Adapts the resume handler's port onto AgentMemoryStore.
            // The QUESTION rides along in the feedback text: the memory
            // block is spliced into future planner / decomposer prompts
            // as prose, and "leave it alone" without its question is
            // advice about nothing.
            resumeMemory: this.agentMemory
                ? {
                    appendMemoryEntry: async (opts): Promise<void> => {
                        const row = this.db!
                            .prepare(
                                'SELECT title, parked_question FROM tasks WHERE id = ?',
                            )
                            .get(opts.taskId) as
                                | { title?: string | null; parked_question?: string | null }
                                | undefined;
                        const question = row?.parked_question?.trim() ?? '';
                        // The Q/A framing belongs to a clarification only.
                        // A commit rejection has no question — the reason
                        // stands on its own, and pinning the parked
                        // question to it would attribute the operator's
                        // "not like that" to whatever the agent last asked.
                        const isClarification = opts.source === 'clarification';
                        this.agentMemory!.append(opts.projectId, {
                            source: opts.source,
                            taskIdentifier: opts.taskId,
                            taskTitle: row?.title ?? opts.taskId,
                            feedback: isClarification && question.length > 0
                                ? `Q: ${question}\nA: ${opts.context}`
                                : opts.context,
                            recordedAt: this.clock(),
                        });
                    },
                }
                : undefined,
            lifecycleAgents: this.lifecycleAgents,
            repoReader,
            resolveRepoSpec,
            resolveTaskRepoSpec,
            // Workspace-layout block feeder. Every active repo is
            // surfaced with its absolute `.pipeline-workspace/repos/<id>`
            // path so the agent prompt can pin cross-repo reads to
            // concrete locations instead of letting the agent guess
            // (and land on the operator's personal checkouts elsewhere
            // on disk).
            listWorkspaceRepos: () => {
                const rows = this.repoProjectionStore?.listActive() ?? [];
                return rows
                    .filter((r) => typeof r.ensuredPath === 'string' && r.ensuredPath.length > 0)
                    .map((r) => ({
                        repoId: r.repoId,
                        name: r.name,
                        path: r.ensuredPath as string,
                    }));
            },
            getStackContextBlock: this.getStackContextBlock(),
            getProjectContextBlock: (projectId: string): string =>
                this.projectContextProvider?.block(projectId) ?? '',
            // pipeline.yaml default_models → planner / decomposer model.
            ...(defaultModels.planner ? { plannerModel: defaultModels.planner } : {}),
            ...(defaultModels.decomposer
                ? { decomposerModel: defaultModels.decomposer }
                : {}),
            // Plan-type routing: read the plan's archetype (metadata.planType)
            // so GeneratePlan can skip the planner for non-feature plans.
            getPlanArchetype: (planId) => {
                try {
                    const row = this.db!
                        .prepare('SELECT metadata FROM sidebar_plans WHERE plan_id = ?')
                        .get(planId) as { metadata?: string } | undefined;
                    if (!row?.metadata) return undefined;
                    const md = JSON.parse(row.metadata) as { planType?: unknown };
                    return typeof md.planType === 'string' ? md.planType : undefined;
                } catch {
                    return undefined;
                }
            },
            // Original brief for a plan, recovered from the event log
            // (BriefSubmitted; planId = `plan-<briefId>`). GeneratePlan
            // falls back to this on operator regenerates, which carry no
            // briefContent of their own.
            getBriefContent: (planId) => {
                try {
                    const briefId = planId.startsWith('plan-')
                        ? planId.slice('plan-'.length)
                        : planId;
                    const row = this.db!
                        .prepare(
                            `SELECT payload FROM events
                              WHERE type = 'BriefSubmitted'
                                AND json_extract(payload, '$.briefId') = ?
                              ORDER BY seq DESC LIMIT 1`,
                        )
                        .get(briefId) as { payload?: string } | undefined;
                    if (!row?.payload) return undefined;
                    const p = JSON.parse(row.payload) as { content?: unknown };
                    return typeof p.content === 'string' && p.content.length > 0
                        ? p.content
                        : undefined;
                } catch {
                    return undefined;
                }
            },
            // Management UI (Option B, Phase 2): per-role persona from the
            // Agents panel, used in place of the agents/<role>.CLAUDE.md file.
            resolveAgentPrompt: (role) => this.agentConfigResolver?.prompt(role),
            // Migration 021: lets the StartAgent handler copy operator
            // attachments into the worktree + list them in TASK.md.
            ...(this.attachmentStore ? { attachmentStore: this.attachmentStore } : {}),
            planAttachmentsRoot: DEFAULT_PLAN_ATTACHMENTS_ROOT,
            // Architect-tier design input. Separate root because an
            // architect run carries a synthetic plan id.
            requirementAttachmentsRoot: DEFAULT_REQUIREMENT_ATTACHMENTS_ROOT,
            // Migration 038: where a task drops the files it produces.
            // The StartAgent handler creates `<root>/<taskId>` and names
            // it in the prompt; attachTaskOutputHarvest sweeps it.
            taskOutputsRoot: DEFAULT_TASK_OUTPUTS_ROOT,
            ...(this.attachmentBlobStore
                ? { attachmentBlobStore: this.attachmentBlobStore }
                : {}),
            db: this.db!,
        });

        // Read side of the planner/decomposer lifecycle. Without this
        // wiring `AgentFinished` for a planner/decomposer never becomes
        // `PlanGenerated.content` / `PlanDecomposed.tasks`, so the
        // decomposer's JSON output stays buried in the runner's
        // AgentProgress chunks and no per-task `TaskCreated` events
        // ever fire. Shares the `lifecycleAgents` map with the spawn
        // path above.
        registerPlanLifecycleAgentHandlers(this.bus!, {
            clock: this.clock,
            logger: this.logger,
            // The operator's attached files. This registration is what
            // spawns the architect and the design-verifier, and it was
            // never given them — so the architect reported a document
            // the operator had attached as "not attached".
            ...(this.attachmentStore
                ? { attachmentStore: this.attachmentStore }
                : {}),
            planAttachmentsRoot: DEFAULT_PLAN_ATTACHMENTS_ROOT,
            requirementAttachmentsRoot: DEFAULT_REQUIREMENT_ATTACHMENTS_ROOT,
            getTaskTypes: () => this.taskTypes(),
            stackHooks: this.getStackHooks(),
            agentRunner: this.agentRunner,
            registerAgent: (agentId, taskId) => {
                this.agentToTask.set(agentId, taskId);
            },
            deferAgentStart: (run) => this.deferAgentStart(run),
            lifecycleAgents: this.lifecycleAgents,
            agentMemory: this.agentMemory,
            repoReader,
            resolveRepoSpec,
            // Same workspace-repo allow-list the operator-driven GeneratePlan
            // path uses, so a re-spawned planner/decomposer gets the boundary
            // block listing the configured repos.
            listWorkspaceRepos: () => {
                const rows = this.repoProjectionStore?.listActive() ?? [];
                return rows
                    .filter((r) => typeof r.ensuredPath === 'string' && r.ensuredPath.length > 0)
                    .map((r) => ({
                        repoId: r.repoId,
                        name: r.name,
                        path: r.ensuredPath as string,
                    }));
            },
            getStackContextBlock: this.getStackContextBlock(),
            getProjectContextBlock: (projectId: string): string =>
                this.projectContextProvider?.block(projectId) ?? '',
            // pipeline.yaml default_models → planner / decomposer model
            // (this path drives the regenerate / re-spawn of lifecycle agents).
            ...(defaultModels.planner ? { plannerModel: defaultModels.planner } : {}),
            ...(defaultModels.decomposer
                ? { decomposerModel: defaultModels.decomposer }
                : {}),
            // Architect Tier (Phase 2): the architect runs as a third
            // lifecycle-agent kind. Its model comes from
            // default_models.architect (falling back to the runner default),
            // and it is fed the systems catalog + the requirement's ask.
            ...((defaultModels as Record<string, string | undefined>).architect
                ? { architectModel: (defaultModels as Record<string, string | undefined>).architect }
                : {}),
            // ONE SYSTEM PER REPO. `systemId` is what the fan-out resolves
            // to a plan's target repo, so every id offered here has to BE a
            // repo id. Projects are the grouping, not a target.
            //
            // This used to emit a system per PROJECT with its repos nested,
            // which broke any project owning more than one repo: the
            // architect got a single fan-out slot for work spanning several
            // repos, wrote one repo's worth into it, and the design-verifier
            // failed the proposal for the briefs that were missing — five
            // times running on REQ-1786956418797, because regenerating
            // cannot loosen a structural constraint. See the note at the
            // top of `systems-catalog.ts`.
            listSystems: () => {
                const reg = this.projectRegistry;
                const rows = this.repoProjectionStore?.listActive() ?? [];
                // repoId -> owning project, for the display grouping. First
                // project wins: a repo shared by several projects (corelib,
                // infrastructure, …) is ONE system either way, and which
                // heading it renders under changes nothing about targeting.
                const ownerOf = new Map<string, { id: string; name: string }>();
                for (const id of reg ? reg.ids() : []) {
                    const pr = reg!.get(id);
                    for (const rs of pr.repos ?? []) {
                        if (!ownerOf.has(rs.id)) ownerOf.set(rs.id, { id, name: pr.name });
                    }
                }
                // Every ACTIVE workspace repo is a system. Driven off the
                // repo projection rather than the registry so a project
                // listing a repo that was never cloned cannot offer an id
                // the fan-out will fail to resolve.
                return rows.map((r) => {
                    const owner = ownerOf.get(r.repoId);
                    return {
                        systemId: r.repoId,
                        name: r.name ?? r.repoId,
                        repos: [{
                            repoId: r.repoId,
                            name: r.name ?? r.repoId,
                            ...(r.ensuredPath ? { path: r.ensuredPath as string } : {}),
                        }],
                        ...(owner
                            ? { projectId: owner.id, projectName: owner.name }
                            : {}),
                    };
                });
            },
            getRequirement: (id) => {
                const r = this.requirementProjectionStore?.get(id);
                return r ? { title: r.title, description: r.description } : null;
            },
            // Fan-out verification gate: the design-verifier audits the
            // proposal (design doc + sub-briefs + rollout) read from the
            // requirement projection.
            getRequirementDesign: (id) => {
                const store = this.requirementProjectionStore;
                if (!store) return undefined;
                const subBriefsRaw = (store.subBriefsFor(id) ?? []) as Array<{
                    system_id?: string;
                    title?: string;
                    brief?: string;
                }>;
                const subBriefs = subBriefsRaw
                    .filter((sb): sb is { system_id: string; title?: string; brief?: string } =>
                        typeof sb.system_id === 'string' && sb.system_id.length > 0)
                    .map((sb) => ({
                        systemId: sb.system_id,
                        ...(typeof sb.title === 'string' ? { title: sb.title } : {}),
                        brief: typeof sb.brief === 'string' ? sb.brief : '',
                    }));
                const designDoc = store.getDesignDoc(id);
                const rolloutRows = (store.rolloutFor(id) ?? []) as Array<{
                    system_id?: string;
                    deploy_after?: string;
                    reason?: string;
                }>;
                const rollout = rolloutRows.length > 0
                    ? rolloutRows
                        .map((r) => `- ${r.system_id} after ${r.deploy_after} — ${r.reason ?? ''}`)
                        .join('\n')
                    : undefined;
                return {
                    ...(typeof designDoc === 'string' && designDoc.length > 0
                        ? { designDoc }
                        : {}),
                    subBriefs,
                    ...(rollout !== undefined ? { rollout } : {}),
                };
            },
            // Option B Phase 2: per-role persona override for lifecycle agents.
            resolveAgentPrompt: (role) => this.agentConfigResolver?.prompt(role),
            // Pass the DB handle so emitPlanDecomposed can rewrite the
            // raw decomposer task ids (`task-001`) into the operator-
            // facing `<projectAbbr>-<planAbbr>-<nnn>` form — and so the
            // decomposer-question path can read the plan's recorded
            // clarifications (the answers it re-spawns with, and the
            // per-plan question count the cap uses).
            db: this.db!,
        });

        // PlanDecomposed (agent-driven, carrying the task list) ->
        // per-task TaskCreated. The store's constructor subscribes
        // itself under {@link TASK_PROJECTION_SUBSCRIBER} and uses the
        // bus's idempotency-key dedup so a restart-driven replay
        // emits the same per-task keys (and the event store silently
        // drops the duplicates).
        new TaskProjectionStore(this.bus!, this.clock);
        this.subscriberNames.push(TASK_PROJECTION_SUBSCRIBER);

        // Workspace repo command handlers + ensure subscriber. The
        // WorkspaceRepoFetcher and refresh trigger were constructed
        // up above so `resolveRepoSpec` can close over them.
        this.commandBus!.register<RegisterRepoPayload>(
            RepoCommands.REGISTER_REPO,
            createRegisterRepoHandler({ clock: this.clock }),
        );
        // CreateRepo: operator clicked "Create new" in the Repos modal.
        // Runs `gh repo create` + clone + CLAUDE.md seed + commit +
        // push, then returns the `RepoRegistered` event for the bus to
        // publish. Errors propagate as 5xx so the modal shows the gh /
        // git error in a toast.
        this.commandBus!.register<CreateRepoPayload>(
            RepoCommands.CREATE_REPO,
            async (cmd) => {
                const event = await createGitHubRepoAndSeedClaudeMd({
                    name: cmd.payload.name,
                    owner: cmd.payload.owner,
                    description: cmd.payload.description,
                    visibility: cmd.payload.visibility,
                    ...(cmd.payload.defaultBranch !== undefined
                        ? { defaultBranch: cmd.payload.defaultBranch }
                        : {}),
                    actor: cmd.actor,
                    reposRoot: DEFAULT_REPOS_ROOT,
                    logger: this.logger,
                    clock: this.clock,
                    // Create the repo UNDER the chosen account, and record
                    // the id on the event so every later clone, fetch,
                    // push and PR for it resolves the same way.
                    ...(cmd.payload.githubAccount !== undefined
                        ? {
                            githubAccount: cmd.payload.githubAccount,
                            githubEnv: this.githubEnvForAccount(
                                cmd.payload.githubAccount,
                            ),
                        }
                        : {}),
                });
                return [event];
            },
        );
        this.commandBus!.register<UpdateRepoPayload>(
            RepoCommands.UPDATE_REPO,
            createUpdateRepoHandler({ clock: this.clock }),
        );
        this.commandBus!.register<ArchiveRepoPayload>(
            RepoCommands.ARCHIVE_REPO,
            createArchiveRepoHandler({ clock: this.clock }),
        );
        this.commandBus!.register<RefreshRepoPayload>(
            RepoCommands.REFRESH_REPO,
            createRefreshRepoHandler({
                clock: this.clock,
                triggerRefresh: repoRefreshTrigger.refreshOne,
            }),
        );
        this.commandBus!.register<RefreshAllReposPayload>(
            RepoCommands.REFRESH_ALL_REPOS,
            createRefreshAllReposHandler({
                clock: this.clock,
                triggerRefreshAll: repoRefreshTrigger.refreshAll,
            }),
        );

        // Architect Tier (Phase 2) — requirement lifecycle commands. The
        // architect-agent spawn (RequirementSubmitted → run architect →
        // ArchitectureProposed) is wired separately; these handlers cover
        // submit / regenerate / approve / archive.
        this.commandBus!.register<SubmitRequirementPayload>(
            RequirementCommands.SUBMIT_REQUIREMENT,
            createSubmitRequirementHandler({ clock: this.clock }),
        );
        // Content-only edit, allowed ONLY while no architect is running for
        // the requirement (the run's prompt was built from the old text). The
        // status guard reads the projection; 'architecting' → command rejected.
        this.commandBus!.register<UpdateRequirementPayload>(
            RequirementCommands.UPDATE_REQUIREMENT,
            createUpdateRequirementHandler({
                clock: this.clock,
                getRequirementStatus: (id) => {
                    const r = this.requirementProjectionStore?.get(id);
                    if (!r) return undefined;
                    return r.archivedAt !== null ? 'archived' : r.status;
                },
            }),
        );
        this.commandBus!.register<RegenerateArchitecturePayload>(
            RequirementCommands.REGENERATE_ARCHITECTURE,
            createRegenerateArchitectureHandler({ clock: this.clock }),
        );
        this.commandBus!.register<ApproveArchitecturePayload>(
            RequirementCommands.APPROVE_ARCHITECTURE,
            createApproveArchitectureHandler({ clock: this.clock }),
        );
        this.commandBus!.register<ArchiveRequirementPayload>(
            RequirementCommands.ARCHIVE_REQUIREMENT,
            createArchiveRequirementHandler({ clock: this.clock }),
        );
        // Fan-out verification gate commands: "Implement anyway" and
        // "Retry verification" from the requirement card.
        this.commandBus!.register<ProceedFanOutPayload>(
            RequirementCommands.PROCEED_FAN_OUT,
            createProceedFanOutHandler({ clock: this.clock }),
        );
        this.commandBus!.register<RetryVerificationPayload>(
            RequirementCommands.RETRY_VERIFICATION,
            createRetryVerificationHandler({ clock: this.clock }),
        );

        // Design-verification gate: ArchitectureApproved no longer fans out
        // directly. It publishes DesignVerificationStarted; the lifecycle-
        // agent wiring spawns the design-verifier, which audits the
        // sub-brief proposal against the full design. Plans are created
        // only when FanOutAuthorized lands — from the verifier on a pass,
        // or from the operator's ProceedFanOut ("Implement anyway").
        this.bus!.subscribe<ArchitectureApprovedPayload>(
            RequirementEvents.ARCHITECTURE_APPROVED,
            async (event) => {
                const requirementId = event.payload?.requirementId;
                if (typeof requirementId !== 'string' || requirementId.length === 0) return;
                const revision = typeof event.payload?.revision === 'number'
                    ? event.payload.revision
                    : 1;
                await this.bus!.publish({
                    type: RequirementEvents.DESIGN_VERIFICATION_STARTED,
                    v: 1,
                    occurredAt: this.clock(),
                    idempotencyKey: `dv-start:${requirementId}:r${revision}`,
                    payload: { requirementId, revision },
                });
            },
            { subscriber: 'requirement-verify-gate' },
        );

        // Fan-out — on FanOutAuthorized, dispatch one SubmitBrief per
        // proposed sub-brief (read from the requirement projection). Each
        // becomes an ordinary plan that runs the normal planner → decompose
        // pipeline INDEPENDENTLY. briefIds are deterministic
        // (`<requirementId>--<systemId>`) so a re-authorization is
        // idempotent via SubmitBrief's `SubmitBrief:<briefId>` key.
        this.bus!.subscribe<FanOutAuthorizedPayload>(
            RequirementEvents.FAN_OUT_AUTHORIZED,
            async (event) => {
                const requirementId = event.payload?.requirementId;
                if (typeof requirementId !== 'string' || requirementId.length === 0) return;
                const subBriefs = (this.requirementProjectionStore?.subBriefsFor(requirementId)
                    ?? []) as Array<{ system_id?: string; title?: string; brief?: string }>;
                // Every sub-plan lands under the requirement's BOARD project
                // (operator-picked at submit) — NOT under the systemId, which
                // is a repo id no project view knows. Without a real project
                // the plans render nowhere and can't be driven through their
                // lifecycle (archive included). The systemId keeps selecting
                // each plan's target repo below.
                const reqRow = this.requirementProjectionStore?.get(requirementId);
                const fanProjectId =
                    (reqRow?.projectId && reqRow.projectId.length > 0
                        ? reqRow.projectId
                        : undefined)
                    ?? process.env.DEFAULT_PROJECT_ID
                    ?? '';
                // The full design doc travels WITH every sub-brief. Each hop
                // (requirement → design → sub-brief → plan → tasks) is a lossy
                // re-summarisation; field incidents showed a file-level detail
                // that only appears in the full design (or in ANOTHER system's
                // sub-brief) is unrecoverable downstream — the planner and
                // decomposer only ever saw their own slice, so cross-system
                // contract changes (shared DTOs, published package surfaces)
                // were missed and builds broke. Appending the design here rides
                // the existing brief plumbing: BriefSubmitted → planner prompt
                // (`# Brief`) → decomposer prompt (getBriefContent).
                const fanDesignDoc = this.requirementProjectionStore?.getDesignDoc(requirementId);
                const designSection =
                    typeof fanDesignDoc === 'string' && fanDesignDoc.trim().length > 0
                        ? '\n\n# Full architecture design (context)\n\n'
                          + 'The brief above is ONE SLICE of the cross-system design below. '
                          + 'Read the full design before planning/decomposing: your slice may '
                          + 'touch files or contracts that other systems consume, and the '
                          + 'design is the only place those couplings are stated. Plan ONLY '
                          + 'the work in your brief — the rest is context, not scope.\n\n'
                          + fanDesignDoc
                        : '';
                // Plan titles must be tellable-apart on the board — the
                // architect once titled EIGHT sub-briefs identically.
                // planTitlesForSubBriefs prefixes duplicated titles with
                // their systemId (see fanout-titles.ts).
                const planTitles = planTitlesForSubBriefs(subBriefs, requirementId);
                for (const sb of subBriefs) {
                    const systemId = sb.system_id;
                    if (typeof systemId !== 'string' || systemId.length === 0) continue;
                    const planProjectId = fanProjectId || systemId; // last-resort legacy behaviour
                    const briefId = `${requirementId}--${systemId}`;
                    const planTitle = planTitles.get(systemId)
                        ?? `${requirementId} — ${systemId}`;
                    // CreatePlan FIRST: the board's plan cards render from the
                    // sidebar_plans projection, which folds PlanCreated only —
                    // SubmitBrief/PlanGenerated never touch it, so without this
                    // the fanned-out plans run invisibly (the operator clicks
                    // "fan out" and "nothing happens"). planId matches the
                    // BriefSubmitted spawn path's derivation (`plan-<briefId>`),
                    // and the CreatePlan:<planId> idempotency key makes
                    // re-approval a no-op.
                    // metadata.targetRepo is LOAD-BEARING, not decorative:
                    // resolveTaskRepoSpec reads it to create the per-task
                    // worktree. Without it the task agents run against the
                    // shared clone directly — uncommitted edits on main, no
                    // branch/PR, and "Review changes" 404s (no worktree to
                    // diff). Resolve tolerantly: exact repo id first, then a
                    // separator/case-normalised match (the architect emitted
                    // 'shop.orders' for repo 'shop-orders' once). A
                    // brand-new system (repo not scaffolded yet) stays unset
                    // for the scaffold path — but say so loudly, because an
                    // unresolved EXISTING repo means invisible-worktree tasks.
                    const repoRows = this.repoProjectionStore?.listActive() ?? [];
                    const normKey = (s: string): string =>
                        s.toLowerCase().replace(/[._\s-]+/g, '-');
                    const targetRepo = repoRows.some((r) => r.repoId === systemId)
                        ? systemId
                        : repoRows.find((r) => normKey(r.repoId) === normKey(systemId))?.repoId;
                    if (!targetRepo) {
                        this.logger.warn(
                            'orchestrator: requirement fan-out systemId matches no workspace repo — '
                            + 'tasks on this plan will run WITHOUT per-task worktrees unless the '
                            + 'plan metadata.targetRepo is set (expected only for repos not yet scaffolded)',
                            { requirementId, systemId },
                        );
                    }
                    try {
                        await this.commandBus!.send<CreatePlanPayload>({
                            type: BoardUiCommands.CREATE_PLAN,
                            actor: 'architect',
                            issuedAt: this.clock(),
                            payload: {
                                planId: `plan-${briefId}`,
                                projectId: planProjectId,
                                title: planTitle,
                                body: typeof sb.brief === 'string' ? sb.brief : '',
                                ...(targetRepo ? { metadata: { targetRepo } } : {}),
                            },
                        });
                    } catch (err) {
                        this.logger.warn('orchestrator: requirement fan-out CreatePlan failed', {
                            requirementId,
                            systemId,
                            error: err instanceof Error ? err.message : String(err),
                        });
                    }
                    const payload: SubmitBriefPayload = {
                        briefId,
                        projectId: planProjectId,
                        content: (typeof sb.brief === 'string' ? sb.brief : '') + designSection,
                        systemId,
                        ...(targetRepo ? { repoId: targetRepo } : {}),
                        requirementId,
                    };
                    try {
                        await this.commandBus!.send({
                            type: PlanLifecycleCommands.SUBMIT_BRIEF,
                            actor: 'architect',
                            issuedAt: this.clock(),
                            payload,
                        });
                    } catch (err) {
                        this.logger.warn('orchestrator: requirement fan-out SubmitBrief failed', {
                            requirementId,
                            systemId,
                            error: err instanceof Error ? err.message : String(err),
                        });
                    }
                }

                // Best-effort: commit the design doc to the workspace-wide
                // architecture repo (configured via PIPELINE_ARCHITECTURE_REPO_ID).
                // Never blocks the fan-out and never throws.
                const archRepoId = process.env.PIPELINE_ARCHITECTURE_REPO_ID;
                if (archRepoId) {
                    const repo = this.repoProjectionStore?.get(archRepoId);
                    const designDoc = this.requirementProjectionStore?.getDesignDoc(requirementId);
                    if (repo?.ensuredPath && typeof designDoc === 'string' && designDoc.length > 0) {
                        const rolloutRows = (this.requirementProjectionStore?.rolloutFor(requirementId)
                            ?? []) as Array<{ system_id?: string; deploy_after?: string; reason?: string }>;
                        const rolloutMd = rolloutRows.length > 0
                            ? '# Rollout order\n\n' + rolloutRows
                                .map((r) => `- ${r.system_id} after ${r.deploy_after} — ${r.reason ?? ''}`)
                                .join('\n') + '\n'
                            : undefined;
                        void commitDesignDoc({
                            repoPath: repo.ensuredPath,
                            requirementId,
                            designDoc,
                            ...(rolloutMd ? { rollout: rolloutMd } : {}),
                            defaultBranch: repo.defaultBranch ?? 'main',
                            // The push needs the architecture repo's own
                            // account, through the shared repoId -> account
                            // rule.
                            githubEnv: this.githubEnvForRepoId(archRepoId),
                        }, { logger: this.logger });
                    }
                }
            },
            { subscriber: 'requirement-fanout' },
        );

        this.repoEnsureUnsubscribe = attachRepoEnsureSubscriber({
            bus: this.bus!,
            clock: this.clock,
            logger: this.logger,
            fetcher: this.workspaceRepoFetcher,
            projection: this.repoProjectionStore!,
            // Clone and fetch as the account the repo is mapped to.
            // Without this a repo the primary account cannot SEE
            // never lands on disk, so nothing downstream gets a
            // chance to run.
            resolveGithubEnv: (accountId) => this.githubEnvForAccount(accountId),
        });
        this.subscriberNames.push(REPO_ENSURE_SUBSCRIBER);

        // CreateTaskPr: operator clicked "Create PR" on the board.
        // Re-runs the post-commit hook (push + `gh pr create`) for a
        // task whose committer succeeded but whose PR creation failed
        // — usually because `gh` was unauthenticated, the remote was
        // not yet known, or a transient network error. The push step
        // is idempotent (no-op when already up to date) so the hook is
        // safe to invoke any number of times. Throws on hook failure
        // so the board POST surfaces a toast with the gh error.
        this.commandBus!.register<{
            readonly taskId: string;
        }>(
            'CreateTaskPr',
            async (cmd) => {
                const { taskId } = cmd.payload;
                if (typeof taskId !== 'string' || taskId.length === 0) {
                    throw new Error('CreateTaskPr: payload.taskId is required');
                }
                if (!this.taskWorktreeStore) {
                    throw new Error('CreateTaskPr: worktree store not initialised');
                }
                if (!this.db) {
                    throw new Error('CreateTaskPr: db not initialised');
                }
                const taskRow = this.db
                    .prepare('SELECT title, description FROM tasks WHERE id = ?')
                    .get(taskId) as
                    | { title: string | null; description: string | null }
                    | undefined;
                const outcome = await runPostCommitHook({
                    store: this.taskWorktreeStore,
                    logger: this.logger,
                    taskId,
                    title: taskRow?.title ?? '',
                    description: taskRow?.description ?? null,
                    bus: this.bus!,
                    clock: this.clock,
                    githubEnv: githubEnvForTask(taskId),
                });
                // The hook updates `task_worktrees.pr_url` on success
                // but swallows errors internally (it's invoked from
                // the AgentFinished subscriber where throws would
                // poison the bus offset). Inspect the store to see
                // whether the PR creation actually landed; surface a
                // 5xx to the board when it didn't so the operator
                // gets a toast with the failure reason rather than a
                // silent no-op.
                const rec = this.taskWorktreeStore.get(taskId);
                if (!rec || rec.prUrl === null) {
                    // Report the reason the hook actually hit. This used to
                    // say "check the worker log for the gh pr create error",
                    // which in the commonest case names a command that was
                    // never run: the branch had no commits, so the hook
                    // returned long before gh. Field report — four failed
                    // clicks, and the error it named absent from the log
                    // every time, while the real line ("no commits ahead of
                    // base") sat one millisecond earlier at info level.
                    throw new Error(describePostCommitOutcome(outcome));
                }
                return [];
            },
        );

        // MergeTaskPr: operator clicked "Merge PR" on the board (or
        // dispatched the same command from chat). Runs `gh pr merge`
        // in the worktree for the task; on success publishes
        // ResumeTask so the engine's wait-merged resume path follows
        // `on_success: emit:TaskFinished` and the projection-tasks
        // subscriber flips the task to status='done'. Failures are
        // surfaced via the worker log; the operator can retry from
        // the same button.
        this.commandBus!.register<{
            readonly taskId: string;
            readonly method?: 'squash' | 'merge' | 'rebase';
        }>(
            'MergeTaskPr',
            async (cmd) => {
                const { taskId, method } = cmd.payload;
                if (typeof taskId !== 'string' || taskId.length === 0) {
                    throw new Error('MergeTaskPr: payload.taskId is required');
                }
                if (!this.taskWorktreeStore) {
                    throw new Error('MergeTaskPr: worktree store not initialised');
                }
                // Already queued with GitHub and being watched. Running
                // `gh pr merge` again cannot help, and in the field it
                // actively hurt: the retry failed with "the head branch
                // is not up to date with the base branch", that was read
                // as a conflict, and a merge-resolver agent was
                // dispatched at a PR with nothing wrong with it. It asked
                // the operator what to do while GitHub merged the PR by
                // itself five minutes later.
                //
                // The retry also tears the worktree down again, which is
                // how the resolver ended up re-creating one from scratch.
                if (this.enqueuedMergeWatches.has(taskId)) {
                    this.logger.info(
                        'MergeTaskPr: already queued for auto-merge — not re-attempting',
                        { taskId },
                    );
                    return [];
                }
                const result = await mergeTaskPr({
                    store: this.taskWorktreeStore,
                    logger: this.logger,
                    taskId,
                    ...(method !== undefined ? { method } : {}),
                    githubEnv: githubEnvForTask(taskId),
                });
                if (!result.ok) {
                    // Conflict-shaped failure → dispatch the merge-resolver
                    // agent (once per task). It resolves + pushes and then
                    // re-runs this command, so the merge completes without
                    // the operator; unsure/failed runs park the task with a
                    // clarification question instead. Non-conflict failures
                    // keep the plain error path.
                    if (
                        isMergeConflictFailure(result.reason)
                        && this.mergeConflictResolver
                        && !this.mergeConflictResolver.hasAttempted(taskId)
                    ) {
                        await this.bus!.publish({
                            type: MERGE_CONFLICT_EVENT,
                            v: 1,
                            occurredAt: this.clock(),
                            idempotencyKey: `${MERGE_CONFLICT_EVENT}:${taskId}:${cmd.issuedAt}`,
                            payload: { taskId, reason: result.reason ?? '' },
                        });
                        throw new Error(
                            `merge conflict for ${taskId} — a merge-resolver agent was `
                            + 'dispatched; it merges automatically on success or parks the '
                            + 'task with a question if unsure.',
                        );
                    }
                    // Bubble up so the board POST sees a 5xx and the
                    // operator gets a toast. Don't publish ResumeTask
                    // — the task stays parked at wait-merged.
                    throw new Error(
                        `merge failed for ${taskId}: ${result.reason ?? 'unknown error'}`,
                    );
                }
                if (result.enqueued) {
                    // GitHub ACCEPTED the merge but has not run it: the
                    // repo's required checks had not passed, so the merge
                    // is queued and lands when they do. The task must NOT
                    // finish here - nothing is merged yet - so no
                    // TaskResumed, and a watcher takes over to finish the
                    // task when the merge actually happens.
                    //
                    // Not an error either: before this, a repo that runs
                    // checks on the PR failed every merge click with "not
                    // mergeable" (reported, wrongly, as a conflict).
                    void this.watchEnqueuedMergeFor(taskId);
                    return [
                        {
                            type: 'TaskMergeEnqueued',
                            v: 1,
                            occurredAt: this.clock(),
                            idempotencyKey:
                                `TaskMergeEnqueued:${taskId}:${cmd.issuedAt}`,
                            payload: {
                                taskId,
                                prNumber:
                                    this.taskWorktreeStore.get(taskId)?.prNumber
                                    ?? null,
                                state: 'enqueued',
                                note: result.reason ?? '',
                            },
                        },
                    ];
                }
                // Merge succeeded — clean up the on-disk worktree so
                // `.pipeline-workspace/worktrees/<taskId>` doesn't
                // accumulate one directory per completed task. The
                // `--delete-branch` flag on `gh pr merge` removed the
                // remote + local refs already; this strips the
                // working-tree checkout + the .git/worktrees/<name>
                // registration. Best-effort: a leftover directory
                // doesn't block the rest of the resume chain.
                await this.taskWorktreeStore!.removeOnDisk(taskId);
                // Resume the wait-merged step. Engine.onTaskResumed
                // reads `paused_step`/`current_step` and follows
                // wait-merged's `on_success` straight to emit:TaskFinished.
                return [
                    {
                        type: 'TaskResumed',
                        v: 1,
                        occurredAt: this.clock(),
                        idempotencyKey: `MergeTaskPr:${taskId}:${cmd.issuedAt}`,
                        payload: { taskId, decision: 'approve' },
                    },
                ];
            },
        );
    }

    /**
     * Finish the task when a QUEUED auto-merge actually lands.
     *
     * `gh pr merge --auto` returns as soon as GitHub accepts the
     * request; the merge itself happens minutes (or an hour) later,
     * when the required checks go green. Without this the task would
     * sit parked at wait-merged for a PR that merged long ago, and -
     * worse - the clone's `origin/<default>` would never advance, so a
     * dependent task unblocked by that merge would branch off
     * pre-merge code.
     *
     * One watch per task per process. Fire-and-forget, and it never
     * throws: on give-up the task stays parked with the manual Merge PR
     * button, which is a degrade, not a loss.
     */
    private async watchEnqueuedMergeFor(taskId: string): Promise<void> {
        if (this.enqueuedMergeWatches.has(taskId)) return;
        const store = this.taskWorktreeStore;
        const rec = store?.get(taskId);
        if (!store || !rec || rec.prNumber === null) {
            this.logger.warn(
                'auto-merge watch: no PR on record — cannot watch',
                { taskId },
            );
            return;
        }
        const prNumber = rec.prNumber;
        // The clone, same cwd the merge ran in: the worktree has
        // already been torn down by mergeTaskPr.
        const cwd = store.repoPathForTask(taskId) ?? rec.path;
        const githubEnv = this.githubEnvForTaskFn?.(taskId) ?? {};
        const ghBin = process.env.GH_PATH || 'gh';
        this.enqueuedMergeWatches.add(taskId);
        try {
            await watchEnqueuedMerge({
                taskId,
                prNumber,
                logger: this.logger,
                now: () => this.clock(),
                pollMs: resolveAutoMergePollMs(process.env),
                timeoutMs: resolveAutoMergeTimeoutMs(process.env),
                sleep: (ms) => new Promise((r) => { setTimeout(r, ms); }),
                viewPr: async () => (await runCommand(
                    ghBin,
                    [
                        'pr', 'view', String(prNumber),
                        '--json', 'state,mergedAt',
                    ],
                    cwd,
                    this.logger,
                    githubEnv,
                )).stdout,
                onMerged: async () => {
                    // The same tail the immediate merge runs. The fetch
                    // is the important one: it advances the clone's
                    // `origin/<default>` so a dependent task branches off
                    // the merge commit rather than pre-merge code.
                    try {
                        await runCommand(
                            'git',
                            ['fetch', 'origin'],
                            cwd,
                            this.logger,
                            githubEnv,
                        );
                    } catch (err) {
                        this.logger.warn(
                            'auto-merge watch: post-merge fetch failed'
                            + ' (next pre-spawn refresh will catch up)',
                            {
                                taskId,
                                error: err instanceof Error
                                    ? err.message
                                    : String(err),
                            },
                        );
                    }
                    await store.removeOnDisk(taskId);
                    // Resume the wait-merged step, exactly as the
                    // MergeTaskPr handler does on an immediate merge:
                    // the engine follows wait-merged's `on_success` to
                    // emit:TaskFinished.
                    await this.bus!.publish({
                        type: 'TaskResumed',
                        v: 1,
                        occurredAt: this.clock(),
                        idempotencyKey:
                            `AutoMergeLanded:${taskId}:${prNumber}`,
                        payload: { taskId, decision: 'approve' },
                    });
                },
                onGaveUp: async (detail) => {
                    // Never silent: the operator has to learn that the
                    // pipeline stopped waiting, or the task looks stuck
                    // for no stated reason.
                    this.logger.error('auto-merge watch: gave up', {
                        taskId,
                        prNumber,
                        detail,
                    });
                    await this.bus!.publish({
                        type: 'TaskMergeEnqueued',
                        v: 1,
                        occurredAt: this.clock(),
                        idempotencyKey:
                            `AutoMergeAbandoned:${taskId}:${prNumber}`,
                        payload: {
                            taskId,
                            prNumber,
                            state: 'abandoned',
                            note: describeMergeAbandoned(prNumber, detail),
                        },
                    });
                },
            });
        } catch (err) {
            this.logger.error('auto-merge watch: failed', {
                taskId,
                prNumber,
                error: err instanceof Error ? err.message : String(err),
            });
        } finally {
            this.enqueuedMergeWatches.delete(taskId);
        }
    }

    /**
     * merge-auto driver: wait (bounded) for the post-commit hook to open
     * the task's PR, then dispatch `MergeTaskPr` — the same command the
     * board's Merge PR button sends, so merge + worktree cleanup + resume
     * all follow the one battle-tested path. Gives up loudly after the
     * deadline; the task stays parked wait-merged with the manual button
     * as fallback, which is a degrade, not a loss.
     */
    private async mergeWhenPrReady(taskId: string): Promise<void> {
        const POLL_MS = 5_000;
        const MAX_ATTEMPTS = 24; // ~2 minutes — gh pr create takes seconds
        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
            const rec = this.taskWorktreeStore?.get(taskId);
            if (rec?.prUrl) {
                try {
                    const produced = await this.commandBus!.send({
                        type: 'MergeTaskPr',
                        actor: 'auto-merge',
                        issuedAt: this.clock(),
                        payload: { taskId },
                    });
                    // A queued merge is NOT a merge. The driver used to
                    // log "PR merged" for both, so the worker log said a
                    // PR had merged while it was still waiting on checks -
                    // and the one place an operator looks to find out what
                    // happened was wrong.
                    const enqueued = produced.some(
                        (e) => e.type === 'TaskMergeEnqueued',
                    );
                    this.logger.info(
                        enqueued
                            ? 'auto-merge: PR queued for auto-merge — watching'
                            : 'auto-merge: PR merged',
                        { taskId },
                    );
                } catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    this.logger.warn(
                        'auto-merge: MergeTaskPr failed — task stays parked wait-merged '
                        + '(merge manually from the board or Telegram)',
                        { taskId, error: message },
                    );
                    // Surface to the operator: auto-merge parks send NO
                    // ready-to-merge message, so a silent failure here
                    // would be completely invisible. Exception: a
                    // conflict that dispatched the merge-resolver — that
                    // path owns its own messaging (merges through or
                    // parks with a question).
                    if (!message.includes('merge-resolver agent was dispatched')) {
                        await this.bus!.publish({
                            type: 'AutoMergeFailed',
                            v: 1,
                            occurredAt: this.clock(),
                            idempotencyKey: `auto-merge-failed:${taskId}:${this.clock()}`,
                            payload: { taskId, reason: message },
                        });
                    }
                }
                return;
            }
            await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        }
        this.logger.warn(
            'auto-merge: no PR appeared within the wait window — task stays parked '
            + 'wait-merged (check the post-commit hook / gh pr create in the log)',
            { taskId },
        );
        await this.bus!.publish({
            type: 'AutoMergeFailed',
            v: 1,
            occurredAt: this.clock(),
            idempotencyKey: `auto-merge-failed:${taskId}:${this.clock()}`,
            payload: {
                taskId,
                reason: 'no PR appeared within the wait window — check the '
                    + 'post-commit hook / gh pr create in the worker log',
            },
        });
    }

    /**
     * Mirror every `PlanGenerated` event into the supplied recorder. Named
     * subscriber so the gate survives orchestrator restarts (`replayMissed`
     * re-fires the events the gate has not yet recorded).
     */
    private attachPlanGenerationGateSubscriber(
        recordOnEvent: (event: { readonly payload: PlanGeneratedEventPayload }) => void,
    ): void {
        const bus = this.bus!;
        const subscriber = 'plan-generation-gate';
        bus.subscribe<PlanGeneratedEventPayload>(
            PLAN_GENERATED_EVENT_TYPE,
            async (event) => recordOnEvent(event),
            { subscriber },
        );
        this.subscriberNames.push(subscriber);
    }

    /**
     * AP-IFV-001: load `<projectConfigDir>/<projectId>/project.json` into
     * an in-memory {@link ProjectRegistry}. Called by `start()` BEFORE
     * {@link startEngine} so the engine constructor closes over a fully
     * hydrated registry — `resolveApproval` is then free to query the
     * project's `approval_override` map on its very first dispatch tick.
     *
     * Missing directories are tolerated (logged at `warn`): a fresh
     * checkout with no `config/projects/` yet still boots, and the
     * engine simply falls through to YAML / built-in defaults until the
     * directory is populated.
     */
    private bootstrapProjectRegistry(): void {
        try {
            // The `projects` projection is the source. It replaced
            // `config/projects/<id>/project.json`, which was only ever
            // written by the manager-api's POST/PUT — a project created
            // from the board had no file, and so ran with no repos, no
            // credential mapping and no approval overrides.
            this.projectRegistry = ProjectRegistry.fromDb(this.db!);
            this.logger.info('orchestrator: ProjectRegistry hydrated', {
                source: 'projects projection',
                projects: this.projectRegistry.ids(),
            });
        } catch (err) {
            this.projectRegistry = undefined;
            this.logger.warn('orchestrator: ProjectRegistry not loaded', {
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    /**
     * Rebuild the registry from the projection.
     *
     * The file-loaded registry was read once at boot, so a repo added to a
     * project only took effect after a restart. Reading a projection makes
     * a refresh cheap, so project edits apply to the next dispatch.
     */
    private refreshProjectRegistry(): void {
        if (!this.db) return;
        try {
            this.projectRegistry = ProjectRegistry.fromDb(this.db);
        } catch (err) {
            this.logger.warn('orchestrator: ProjectRegistry refresh failed', {
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    private startEngine(): void {
        this.engine = FlowEngine.start(this.bus!, this.commandBus!, this.flows!, {
            db: this.db!,
            logger: this.logger,
            clock: this.clock,
            ...(this.projectRegistry
                ? { projectRegistry: this.projectRegistry }
                : {}),
        });
        this.subscriberNames.push(FLOW_ENGINE_SUBSCRIBER);
    }

    /**
     * Replay every named subscriber so a restart resumes cleanly.
     * Order matters: projections write the rows that downstream
     * subscribers (notably the flow engine) reference via FK.
     */
    /**
     * Event types excluded from boot replay. Both are live-stream
     * telemetry: chunks/ticks that only matter while the emitting agent
     * process is alive (board streaming, in-memory summary accumulation).
     * Agents die with the worker, so by definition none were streaming
     * while the worker was down — historical folds of these add nothing.
     * At 85k events the pair was ~80% of the log and the dominant share
     * of a 2m14s boot (field incident: the operator killed two healthy
     * boots as "hung" because the port binds only after replay).
     */
    private static readonly REPLAY_SKIP_TYPES = TELEMETRY_EVENT_TYPES;

    /**
     * Subscribers that deliberately do NOT replay at boot.
     *
     * Each one performs a SIDE EFFECT rather than folding a read model:
     * spawning the design-verifier, spawning the merge-conflict resolver,
     * creating fan-out plans, dispatching MergeTaskPr. Replaying those
     * would re-run history — verifier agents for every past approval,
     * resolver agents for conflicts long since merged — so catching them
     * up by re-dispatch is the wrong medicine.
     *
     * What they must NOT do is skip silently. Their offsets sat wherever
     * the last live event left them, which (a) dragged /health's
     * pendingProjections gauge to a meaningless 13803 and (b) hid the
     * fact that anything published while the worker was DOWN never
     * reached them. `reconcileLiveOnlySubscribers` reports the gap and
     * then advances past it, so the skip is visible in the log instead of
     * invisible in an offset.
     */
    private static readonly LIVE_ONLY_SUBSCRIBERS: readonly string[] = [
        'auto-merge',
        'requirement-fanout',
        'requirement-verify-gate',
        'merge-conflict-resolver',
        // Appends to the project's agent-memory file, which has no dedup:
        // a replay would re-file every interrupt-retry in history as fresh
        // operator feedback. It also correlates a PAIR of live events, and
        // that pairing means nothing replayed out of a historical log.
        INTERRUPT_FEEDBACK_MEMORY_SUBSCRIBER,
    ];

    /** Subscriber names that DO replay — the meaningful lag gauge set. */
    getProjectionSubscriberNames(): readonly string[] {
        return [...this.subscriberNames];
    }

    /**
     * Report and clear the backlog of every live-only subscriber. Runs
     * after `replayAllSubscribers` so the tip it advances to is the same
     * one the projectors just reached.
     */
    private reconcileLiveOnlySubscribers(): void {
        const db = this.db!;
        let maxSeq = 0;
        try {
            maxSeq = (db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM events')
                .get() as { m: number }).m;
        } catch {
            return;
        }
        if (maxSeq === 0) return;
        const readOffset = db.prepare(
            'SELECT last_seq FROM subscriber_offsets WHERE subscriber = ?',
        );
        const advance = db.prepare(
            `INSERT INTO subscriber_offsets(subscriber, last_seq) VALUES (?, ?)
             ON CONFLICT(subscriber) DO UPDATE SET last_seq = excluded.last_seq
             WHERE excluded.last_seq > subscriber_offsets.last_seq`,
        );
        for (const name of Orchestrator.LIVE_ONLY_SUBSCRIBERS) {
            try {
                const row = readOffset.get(name) as { last_seq: number } | undefined;
                const offset = row?.last_seq ?? 0;
                const skipped = maxSeq - offset;
                if (row !== undefined && skipped > 0) {
                    // Only meaningful for a subscriber that has run before:
                    // a first-boot subscriber has no backlog, it has no
                    // history to care about.
                    this.logger.warn(
                        'orchestrator: live-only subscriber skipped events published while it was not listening',
                        { subscriber: name, skipped, from: offset, to: maxSeq },
                    );
                }
                advance.run(name, maxSeq);
            } catch (err) {
                this.logger.warn('orchestrator: live-only offset reconcile failed', {
                    subscriber: name,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        }
    }

    private async replayAllSubscribers(): Promise<void> {
        for (const name of this.subscriberNames) {
            await this.bus!.replayMissed(name, {
                skipTypes: Orchestrator.REPLAY_SKIP_TYPES,
            });
        }
    }

    async stop(): Promise<void> {
        if (!this.started) return;

        if (this.stateBackupJob) {
            // Runs a final backup + releases the lease so a standby can
            // take over immediately after a clean shutdown.
            await this.stateBackupJob.stop().catch(() => undefined);
            this.stateBackupJob = undefined;
        }

        if (this.snapshotJob) {
            this.snapshotJob.stop();
            this.snapshotJob = undefined;
        }

        if (this.worktreeGcJob) {
            this.worktreeGcJob.stop();
            this.worktreeGcJob = undefined;
        }

        if (this.escalationFileWriter) {
            this.escalationFileWriter.stop();
            this.escalationFileWriter = undefined;
        }

        if (this.autoTransitionJob) {
            this.autoTransitionJob.stop();
            this.autoTransitionJob = undefined;
        }

        if (this.schedulerHandle) {
            this.schedulerHandle.stop();
            this.schedulerHandle = undefined;
        }

        if (this.workerErrorHandlerTeardown) {
            this.workerErrorHandlerTeardown();
            this.workerErrorHandlerTeardown = undefined;
        }

        if (this.engine) {
            this.engine.stop();
            this.engine = undefined;
        }

        await this.flush();

        if (this.db && this.db.open) {
            this.db.close();
        }

        this.bus = undefined;
        this.commandBus = undefined;
        this.db = undefined;
        this.taskDependencyStore = undefined;
        this.flows = undefined;
        this.configStoreWiring = undefined;
        this.claudeCliRunner = undefined;
        this.worktreeManager = undefined;
        this.subscriberNames.length = 0;
        this.agentToTask.clear();
        this.started = false;

        this.logger.info('orchestrator: stopped');
    }

    /**
     * Drain the deferred-start queue and any agent-runner publishes that
     * were initiated synchronously but resolve asynchronously. Tests use
     * this after sending a command to observe the full downstream event
     * trail (including chained `emit:` events the engine produces in
     * response to `agent.finished`).
     *
     * Each drain cycle: yield a macrotask so any setImmediate-deferred
     * starts fire, then await `runner.flush()` which transitively awaits
     * every subscriber on the runner's published events. A second
     * confirming idle cycle catches starts that the just-drained chain
     * itself produced (multi-step flows queue the next StartAgent inside
     * `agent.finished` handling).
     */
    async flush(): Promise<void> {
        if (typeof this.agentRunner?.flush !== 'function') {
            // Custom runner without flush hook — best-effort: drain one
            // setImmediate cycle so deferred starts at least fire.
            await new Promise<void>((resolve) => setImmediate(resolve));
            return;
        }
        const MAX_CYCLES = 64;
        let confirmedIdle = 0;
        for (let i = 0; i < MAX_CYCLES && confirmedIdle < 2; i++) {
            await new Promise<void>((resolve) => setImmediate(resolve));
            await this.agentRunner.flush();
            confirmedIdle = this.pendingDeferredStarts === 0 ? confirmedIdle + 1 : 0;
        }
    }

    private deferAgentStart(run: () => void): void {
        this.pendingDeferredStarts++;
        setImmediate(() => {
            try {
                run();
            } catch (err) {
                this.logger.error('orchestrator: deferred agent start threw', {
                    error: err instanceof Error ? err.message : String(err),
                });
            } finally {
                this.pendingDeferredStarts--;
            }
        });
    }

    getCommandBus(): CommandBus<unknown> {
        if (!this.commandBus) {
            throw new Error('Orchestrator: getCommandBus() called before start()');
        }
        return this.commandBus;
    }

    /**
     * Resolve the live agent handle id that a task is currently driving, or
     * `undefined` when no agent is mapped to it. Used by the worker-api host's
     * `InterruptTask` handler to invert the agent→task map the orchestrator
     * already maintains for the engine bridges.
     */
    getAgentForTask(taskId: string): string | undefined {
        for (const [agentId, mappedTaskId] of this.agentToTask) {
            if (mappedTaskId === taskId) return agentId;
        }
        return undefined;
    }

    /**
     * Forward direction of {@link getAgentForTask}. Returns the taskId the
     * agent was registered under, or `undefined` for unknown handles.
     */
    getTaskForAgent(agentId: string): string | undefined {
        return this.agentToTask.get(agentId);
    }

    /**
     * Live EventBus for callers that need to attach cross-cutting
     * subscribers (notably the worker-api host's SSE stream). Throws if
     * called before `start()`.
     */
    getEventBus(): EventBus {
        if (!this.bus) {
            throw new Error('Orchestrator: getEventBus() called before start()');
        }
        return this.bus;
    }

    /**
     * Access the live SQLite handle. Exposed for integration tests so they
     * can read the event log and projected rows; not part of the public
     * runtime surface beyond that.
     */
    getDb(): Db {
        if (!this.db) {
            throw new Error('Orchestrator: getDb() called before start()');
        }
        return this.db;
    }

    /**
     * Hot-reload `config/flows/*.yaml` (operator "Apply" in the management
     * UI, forwarded by the manager-api through the worker-api). The FlowEngine
     * holds `this.flows` BY REFERENCE and looks flows up per dispatch, so
     * swapping the map's contents in place is all a reload takes — no engine
     * restart, and tasks mid-flow simply see the new definitions on their
     * next step lookup.
     *
     * Throws (leaving the running flows untouched) when any flow on disk
     * fails the loader — the caller surfaces the loader's message so the
     * operator can fix the YAML and re-apply.
     *
     * Deliberately flows-only: pipeline.yaml values are snapshotted into
     * runners/handlers at construction (and Agent records already apply live
     * via the AgentConfigResolver), so pipeline.yaml/.env edits still need a
     * process restart.
     */
    /**
     * The enabled stack packs' hooks (packs/registry.ts), built once.
     * They supply the design-context block every lifecycle-agent prompt
     * carries (the dotnet-azure pack's NuGet package graph, so the
     * architect / design-verifier / planner / decomposer reason about
     * cross-repo package flow from DATA — the field incident was a fan-out
     * that missed a package's publish + consumer bumps entirely) and the
     * decomposition checks.
     */
    private projectContextProvider: ProjectContextProvider | undefined;
    private stackHooks: StackHooks[] | undefined;
    private mergeConflictResolver: MergeConflictResolver | undefined;

    private getStackHooks(): StackHooks[] {
        if (!this.stackHooks) {
            this.stackHooks = stackHooksFor(activePacks(), {
                listRepos: () => {
                    const rows = this.repoProjectionStore?.listActive() ?? [];
                    return rows
                        .filter((r) => typeof r.ensuredPath === 'string'
                            && (r.ensuredPath as string).length > 0)
                        .map((r) => ({
                            repoId: r.repoId,
                            path: r.ensuredPath as string,
                        }));
                },
                logger: this.logger,
            });
        }
        return this.stackHooks;
    }

    /** Every enabled pack's design-context block, joined; '' for none. */
    private getStackContextBlock(): () => string {
        return (): string => this.getStackHooks()
            .map((h) => h.designContextBlock?.() ?? '')
            .filter((b) => b.length > 0)
            .join('\n\n');
    }

    reloadFlows(): { flowIds: string[] } {
        if (!this.flows) {
            throw new Error('Orchestrator: reloadFlows() called before start()');
        }
        return reloadLayeredFlowsInto(
            this.flows as Map<string, FlowDefinition>,
            this.flowLayerDirs(),
        );
    }

    /**
     * The task types of the flows currently loaded. Built per call from
     * the live map, so a flow hot-reloaded by Apply changes the catalog
     * immediately — a cached copy would keep validating against the old set.
     */
    /**
     * Verdict markers the enabled packs declare (`pack.yaml` → `roles:`).
     *
     * Core parses the markers for its own roles (reviewer, tester); a
     * pack's roles — the deploy pair, for this stack — arrive as data so
     * core never names them. Built once: `packs:` cannot change without a
     * restart, and this sits on the AgentFinished hot path.
     */
    private packOutcomeMarkers: ExtraRoleOutcomes | undefined;

    private outcomeMarkers(): ExtraRoleOutcomes {
        if (!this.packOutcomeMarkers) {
            const markers = new Map<string, RoleOutcomeMarkers>();
            for (const pack of activePacks()) {
                for (const role of pack.roles) {
                    if (role.outcome) markers.set(role.id, role.outcome);
                }
            }
            this.packOutcomeMarkers = markers;
        }
        return this.packOutcomeMarkers;
    }

    /**
     * Roles whose recorded step summary is an operator-readable report:
     * core's own plus every report role the enabled packs declare.
     *
     * ImplementFromInvestigation and the follow-up thread read through
     * this. Missing a pack's roles is silent — the report is simply not
     * found and the Implement button yields nothing — so the host supplies
     * them rather than core guessing at a stack's role names.
     */
    private reportRoleIds(): readonly string[] {
        return [
            ...CORE_REPORT_ROLES,
            ...activePacks().flatMap(
                (pack) => pack.roles.filter((role) => role.report).map((role) => role.id),
            ),
        ];
    }

    /**
     * Declared GitHub accounts (`github_accounts:` in the layered
     * pipeline.yaml). Parsed off the same cached config the rest of
     * the orchestrator reads, so a manager-UI save needs the same
     * reload/restart as any other pipeline.yaml change.
     *
     * Problems are logged ONCE here rather than thrown: a malformed
     * account entry must not stop the orchestrator booting, and the
     * manager UI shows the same problems next to the account.
     */
    /**
     * Env overlay for one declared account id.
     *
     * The single place an account id becomes an environment, shared
     * by the task path and the clone/fetch path so they cannot
     * disagree about what an id means. Empty for an absent or
     * unknown id - the ambient identity, never another account.
     */
    /**
     * Env overlay for the account a REPO is reached with.
     *
     * One rule, so the task path and the shared deploy worktree
     * cannot disagree about which account owns a repo. Archived
     * repos included: an archived repo can still have an open PR to
     * merge or a deploy to finish, and the account is how to reach
     * it.
     *
     * Empty for an absent or unmapped repo — the ambient identity,
     * never another account.
     */
    githubEnvForRepoId(repoId: string | null): Record<string, string> {
        if (!repoId) return {};
        const repo = this.repoProjectionStore?.get(repoId, {
            includeArchived: true,
        });
        return this.githubEnvForAccount(repo?.githubAccount ?? null);
    }

    githubEnvForAccount(accountId: string | null): Record<string, string> {
        const ghBin = process.env.GH_PATH && process.env.GH_PATH.length > 0
            ? process.env.GH_PATH
            : 'gh';
        return resolveGitHubEnv(
            this.githubAccounts(),
            accountId,
            ghBin,
        ) as Record<string, string>;
    }

    githubAccounts(): GitHubAccountMap {
        if (this.cachedGithubAccounts) return this.cachedGithubAccounts;
        // Reads the layered document directly rather than through
        // loadPipelineConfig(), whose return type is the VALIDATED
        // projection and carries only the keys it validates.
        let doc: unknown = {};
        try {
            doc = readLayeredPipelineDoc({
                repoPath: this.pipelineConfigPath,
                home: this.profileHome ?? null,
            }).doc;
        } catch (err) {
            // A pipeline.yaml this process cannot read is already
            // fatal elsewhere; here it just means no accounts, which
            // degrades to the ambient identity.
            this.logger.warn('github_accounts: pipeline.yaml unreadable', {
                error: err instanceof Error ? err.message : String(err),
            });
        }
        const parsed = parseGitHubAccounts(doc);
        for (const problem of parsed.problems) {
            // Logged, not thrown: one malformed entry must not stop
            // the orchestrator booting. The manager UI shows the same
            // problems beside the account.
            this.logger.warn('github_accounts: entry ignored', {
                id: problem.id,
                reason: problem.message,
            });
        }
        this.cachedGithubAccounts = parsed.accounts;
        return parsed.accounts;
    }

    taskTypes(): TaskTypeCatalog {
        return TaskTypeCatalog.fromFlows(this.flows ?? new Map());
    }

    /**
     * Repo flows first, the profile's over them by flow id. Evaluated per
     * call rather than at construction: the manager UI creates the profile
     * `flows/` folder on the first flow save, and Apply must pick it up
     * without a restart.
     */
    private flowLayerDirs(): string[] {
        return flowLayerDirs({
            repoConfigDir: path.dirname(this.flowsDir),
            home: this.profileHome ?? null,
        });
    }

    /**
     * Re-read every project's `context_md` from the ConfigStore into the
     * in-memory cache the lifecycle prompt builder reads.
     *
     * The manager-api writes project context and then POSTs the worker's
     * reload route; without this the running worker would keep serving the
     * context it warmed at boot, and an operator's edit would appear to do
     * nothing until the next restart — the same "saved but not applied"
     * confusion the persona no-cache rule exists to avoid.
     */
    async reloadProjectContexts(): Promise<{ projects: number }> {
        if (!this.projectContextProvider) return { projects: 0 };
        const projects = await this.projectContextProvider.refresh();
        this.logger.info('project-context: reloaded', { projects });
        return { projects };
    }

    /**
     * Re-run the curated settings overlay (ConfigStore `Settings` rows →
     * `process.env`) on the RUNNING worker. The manager-api forwards here
     * after a settings write so keys that are read per call — most
     * importantly the agent-auth overrides `CLAUDE_CODE_OAUTH_TOKEN` /
     * `ANTHROPIC_API_KEY`, which ClaudeCliRunner snapshots from
     * `process.env` on every spawn — apply to the NEXT agent run without
     * an orchestrator restart. Values snapshotted at construction
     * (pipeline.yaml-driven wiring, adapter clients built at boot) still
     * need the restart the settings UI note describes.
     */
    async reloadSettingsOverlay(): Promise<{ applied: string[] }> {
        if (!this.configStoreWiring) {
            return { applied: [] };
        }
        return applySettingsOverlay(
            this.configStoreWiring.configStore,
            process.env,
            this.logger,
        );
    }

    /**
     * The live flow map the engine dispatches against. Exposed so read-only
     * surfaces (e.g. the worker-api `/api/flow-stages` route) can project the
     * loaded flows to a display catalog WITHOUT re-loading `config/flows`
     * themselves. Returned by reference — {@link reloadFlows} swaps this same
     * map's contents in place, so a caller that holds this reference (or, more
     * typically, calls `getFlows()` per request) always sees the current
     * definitions after an operator "Apply".
     */
    getFlows(): ReadonlyMap<string, FlowDefinition> {
        if (!this.flows) {
            throw new Error('Orchestrator: getFlows() called before start()');
        }
        return this.flows;
    }

    /**
     * Attachment metadata projection (migration 021). Borrowed by the
     * worker-api attachments router for list / download / delete reads, and
     * by the TASK.md builder + decomposer prompt to fold a task's / plan's
     * attachments into the agent context.
     */
    getAttachmentStore(): SqliteAttachmentStore {
        if (!this.attachmentStore) {
            throw new Error('Orchestrator: getAttachmentStore() called before start()');
        }
        return this.attachmentStore;
    }

    /** Blob store behind attachment bytes (filesystem today). */
    getAttachmentBlobStore(): AttachmentBlobStore {
        if (!this.attachmentBlobStore) {
            throw new Error('Orchestrator: getAttachmentBlobStore() called before start()');
        }
        return this.attachmentBlobStore;
    }

    /**
     * Resolve the singleton `ConfigStore` wired by `attachConfigStore()`.
     * Throws if called before `start()`.
     */
    getConfigStore(): ConfigStore {
        if (!this.configStoreWiring) {
            throw new Error('Orchestrator: getConfigStore() called before start()');
        }
        return this.configStoreWiring.configStore;
    }

    /**
     * Snapshot of the named subscribers the orchestrator wired during
     * `start()`. Used by integration tests to assert that scheduled and
     * event-driven subscribers (snapshot-job, escalation-file-writer,
     * worktree-gc-job, auto-transitions-job) are present.
     */
    getRegisteredSubscriberNames(): readonly string[] {
        return [...this.subscriberNames];
    }

    /** Adapter accessors — used by integration tests to assert side effects. */
    getAdapters(): Required<
        Pick<OrchestratorAdapters, 'agentRunner' | 'issueTracker' | 'chatGateway' | 'sourceControl'>
    > {
        return {
            agentRunner: this.agentRunner,
            issueTracker: this.issueTracker,
            chatGateway: this.chatGateway,
            sourceControl: this.sourceControl,
        };
    }

    // ---------------- internal wiring ----------------

    private attachProjections(): void {
        this.attachPlanProjection();
        this.attachTaskProjection();
        this.attachSidebarProjections();
        this.attachTaskDependencyUnblock();
        this.attachPlanWorktreeCleanup();
        // NOT attachMergeConflictResolver() — it needs `taskWorktreeStore`,
        // which registerHandlers() materialises LATER in start(). Calling
        // it here made its `if (!this.taskWorktreeStore) return;` guard fire
        // every boot, so the resolver never subscribed and every merge
        // conflict fell through to the plain error (field report: "the
        // merge-conflict agent doesn't do anything"). It is attached from
        // start() right after registerHandlers().
    }

    /**
     * Merge-conflict resolver agent: MergeConflictDetected → re-provision
     * the task worktree, spawn agents/merge-resolver.CLAUDE.md in it, and
     * on a clean finish re-dispatch MergeTaskPr (merge straight through);
     * unsure/failed runs park the task with the standard clarification
     * question surface. See hosts/orchestrator/merge-conflict-resolver.ts.
     */
    private attachMergeConflictResolver(): void {
        if (!this.taskWorktreeStore) {
            // Never silent: without this the feature is simply absent and
            // conflicts look like plain merge failures.
            this.logger.error(
                'orchestrator: merge-conflict resolver NOT attached — no task worktree '
                + 'store; PR conflicts will fail without an automatic resolve attempt',
            );
            return;
        }
        this.mergeConflictResolver = new MergeConflictResolver({
            bus: this.bus!,
            commandBus: this.commandBus!,
            db: this.db!,
            worktrees: this.taskWorktreeStore,
            agentRunner: this.agentRunner,
            logger: this.logger,
            clock: this.clock,
            // The resolver agent runs git against the remote itself.
            githubEnvForTask: (taskId) => this.githubEnvForTaskFn?.(taskId) ?? {},
            resolveAgentPrompt: (role) => this.agentConfigResolver?.prompt(role),
            resolveModel: (role) => this.agentConfigResolver?.model(role) ?? undefined,
        });
        this.mergeConflictResolver.attach();
    }

    /**
     * Cascade worktree teardown when a plan is archived or deleted.
     *
     * `PlanArchived` / `PlanDeleted` only soft-delete the sidebar row —
     * nothing reclaimed the worktrees of the plan's in-flight tasks, so
     * they leaked on disk permanently (the tasks keep a non-terminal
     * status, so even the gc backstop's status check never matched them).
     * This subscriber enumerates the plan's tasks and removes each
     * worktree via {@link TaskWorktreeStore.removeAllForPlan}, which is
     * already best-effort/log-never-throw.
     *
     * The cascade fires on BOTH archive and delete: the approved design
     * accepts that unarchiving a plan rebuilds worktrees from the fresh
     * bare clone via `ensureWorktree`, and that any uncommitted WIP in an
     * archived task's worktree is lost.
     *
     * Registered under its OWN subscriber name (not folded under the
     * tasks-projection offset) and pushed onto `subscriberNames` so the
     * boot `replayMissed` pass re-runs an archive/delete that landed while
     * the worker was down. Best-effort: a per-plan cleanup failure is
     * logged and never thrown — a throw here would poison the bus offset
     * on every replay.
     */
    private attachPlanWorktreeCleanup(): void {
        const bus = this.bus!;
        const cascade = async (event: {
            readonly payload?: { readonly planId?: string };
        }): Promise<void> => {
            const planId = event.payload?.planId;
            if (typeof planId !== 'string' || planId.length === 0) return;
            if (!this.taskWorktreeStore) return;
            try {
                await this.taskWorktreeStore.removeAllForPlan(planId);
            } catch (err) {
                // removeAllForPlan is already log-never-throw, but guard
                // defensively so a surprise synchronous throw can't poison
                // this subscriber's offset.
                this.logger.warn(
                    'orchestrator: plan-worktree cleanup failed',
                    {
                        planId,
                        error: err instanceof Error ? err.message : String(err),
                    },
                );
            }
        };
        bus.subscribe<{ readonly planId?: string }>(
            'PlanArchived',
            cascade,
            { subscriber: SUBSCRIBER_PLAN_WORKTREE_CLEANUP },
        );
        bus.subscribe<{ readonly planId?: string }>(
            'PlanDeleted',
            cascade,
            { subscriber: SUBSCRIBER_PLAN_WORKTREE_CLEANUP },
        );
        this.subscriberNames.push(SUBSCRIBER_PLAN_WORKTREE_CLEANUP);
    }

    /**
     * AP-IFW-006 Phase 1 — TaskFinished unblock pass.
     *
     * The bridge subscriber suppresses `task.created` for any task whose
     * decomposer-declared dependencies aren't all merged. This subscriber
     * is the counterpart: when an upstream task finishes, we flip every
     * outgoing edge that names it to `'merged'` and re-publish
     * `task.created` for every downstream whose dep set is now satisfied.
     * Flow_state for those tasks doesn't exist yet (the bridge never
     * forwarded the original event) so the engine's `flowStateExists`
     * short-circuit doesn't fire and the first step dispatches exactly
     * as it would have without the deps gate.
     *
     * Idempotency: the re-published `task.created` uses an idempotency
     * key that combines the unblocked taskId with the upstream's seq, so
     * a replay of the same TaskFinished produces the same key and the
     * bus dedups silently.
     */
    private attachTaskDependencyUnblock(): void {
        const bus = this.bus!;
        const db = this.db!;
        const store = this.taskDependencyStore;
        if (!store) {
            throw new Error(
                'orchestrator: taskDependencyStore not initialised before attachTaskDependencyUnblock()',
            );
        }
        // Look up the downstream task's flow_id AND status at publish
        // time. The tasks row is guaranteed to exist (the projection
        // subscriber inserted it on TaskCreated) so a missing flow_id is
        // a data bug, not a race — we log and skip.
        const taskFlowIdStmt = db.prepare(
            'SELECT flow_id, status, parked_reason FROM tasks WHERE id = ?',
        );
        const wipeWorktreeRowStmt = db.prepare(
            'DELETE FROM task_worktrees WHERE task_id = ?',
        );

        const runUnblockPass = async (
            upstreamId: string,
            triggerSeq: number,
            kind: 'finished' | 'skipped',
        ): Promise<void> => {
            const unblocked = store.markUpstreamMerged(upstreamId);
            for (const downstreamId of unblocked) {
                store.unparkTask(downstreamId);
                // Wipe any worktree this downstream task already built.
                // A task that's only now unblocked should not have run
                // yet — but if it did (a premature run, or a worktree
                // created off origin before the upstream's PR merged),
                // that worktree's base predates the merge and the
                // developer would read stale code (the reported
                // "T-xxx-001 did not merge" symptom). Removing it forces
                // the next agent step to rebuild fresh from the now-
                // merged origin via ensureWorktree + the pre-spawn
                // refresh. Best-effort + a no-op when no worktree exists
                // (the normal gated case).
                if (this.taskWorktreeStore) {
                    await this.taskWorktreeStore.removeOnDisk(downstreamId);
                }
                wipeWorktreeRowStmt.run(downstreamId);

                const row = taskFlowIdStmt.get(downstreamId) as
                    | {
                        flow_id: string | null;
                        status: string | null;
                        parked_reason: string | null;
                    }
                    | undefined;
                // Only PENDING downstreams get re-dispatched. A task the
                // operator already skipped / dismissed / cancelled — or one
                // that somehow ran to done/failed — must never be started
                // by its upstream turning terminal (field case: skipping a
                // deployment task released its deploy-verify downstream,
                // which the operator had ALSO skipped, and the verifier
                // spawned anyway, verifying a deployment that never
                // happened).
                if (!shouldRedispatchUnblockedTask(
                    row?.status ?? null,
                    row?.parked_reason ?? null,
                )) {
                    this.logger.info(
                        'orchestrator: unblocked task not re-dispatched — non-pending status or mid-flow park',
                        {
                            taskId: downstreamId,
                            status: row?.status ?? null,
                            parkedReason: row?.parked_reason ?? null,
                        },
                    );
                    continue;
                }
                const flowId = row?.flow_id;
                if (!flowId) {
                    this.logger.warn(
                        'orchestrator: unblocked task has no flow_id; cannot re-dispatch',
                        { taskId: downstreamId },
                    );
                    continue;
                }
                const bridged: Event = {
                    type: FlowEvents.TASK_CREATED,
                    v: 1,
                    occurredAt: this.clock(),
                    idempotencyKey: `unblock:${FlowEvents.TASK_CREATED}:${downstreamId}:${triggerSeq}`,
                    payload: { taskId: downstreamId, flowId },
                };
                await bus.publish(bridged);
                this.logger.info(
                    'orchestrator: unblocked downstream task',
                    { downstreamId, upstreamId, upstreamKind: kind },
                );
            }
        };

        bus.subscribe<{ readonly taskId?: string }>(
            'TaskFinished',
            async (event) => {
                const finishedTaskId = event.payload?.taskId;
                if (typeof finishedTaskId !== 'string' || finishedTaskId.length === 0) {
                    return;
                }
                await runUnblockPass(finishedTaskId, event.seq, 'finished');
            },
            { subscriber: SUBSCRIBER_TASK_DEPS },
        );

        // Skipping an upstream is functionally a terminal state for the
        // dep gate: the skipped task will never publish TaskFinished, so
        // without a parallel pass here every downstream would stay
        // parked forever. Treat skip as "satisfied for gating purposes"
        // and let downstream work proceed. If the operator wanted to
        // halt the cascade, dismissing the downstreams individually is
        // the explicit signal.
        bus.subscribe<{ readonly taskId?: string }>(
            'TaskSkipped',
            async (event) => {
                const skippedTaskId = event.payload?.taskId;
                if (typeof skippedTaskId !== 'string' || skippedTaskId.length === 0) {
                    return;
                }
                await runUnblockPass(skippedTaskId, event.seq, 'skipped');
            },
            { subscriber: SUBSCRIBER_TASK_DEPS },
        );

        this.subscriberNames.push(SUBSCRIBER_TASK_DEPS);
    }

    /**
     * AP-FP-002 / AP-FP-003 — project + plan projections that back the
     * operator board's sidebar (`GET /api/projects` and
     * `GET /api/projects/:pid/plans`). Both stores wire their own
     * subscriptions in the constructor; we hold the references on `this`
     * only so the bus's offset tracker (`replayMissed(subscriber)`) has
     * something to reference on boot if the host ever needs to catch up
     * on missed events after a restart.
     */
    private attachSidebarProjections(): void {
        const bus = this.bus!;
        const db = this.db!;
        this.projectProjectionStore = new ProjectProjectionStore(db, bus);
        // The registry reads the rows this projection writes, so it has to
        // be rebuilt when they change — otherwise a repo added to a project
        // (or an approval override) would not apply until the next
        // restart, which is exactly the staleness the file-loaded registry
        // had. Registered AFTER the projection so the row is already
        // written when the rebuild runs.
        //
        // `ProjectApprovalOverrideUpdated` is folded here rather than in
        // ProjectProjectionStore because the override is not part of the
        // project's identity — it is per-flow policy the engine reads, and
        // the store's vocabulary (created / updated / archived) predates it.
        for (const type of [
            'ProjectCreated',
            'ProjectUpdated',
            'ProjectArchived',
            'ProjectApprovalOverrideUpdated',
        ]) {
            bus.subscribe<Record<string, unknown>>(
                type,
                async () => {
                    this.refreshProjectRegistry();
                },
                { subscriber: PROJECT_PROJECTION_SUBSCRIBER },
            );
        }
        this.planProjectionStore = new PlanProjectionStore(db, bus, this.logger);
        // Plan-review projection (PlanGenerated / PlanDecomposed). Lives
        // alongside the sidebar projections because it's bus-driven and
        // SQLite-backed by the same migrations runner. The worker-api
        // borrows the store handle via {@link getPlanReviewStore} so the
        // plan-review HTTP routes can read from durable state — replacing
        // the in-memory wiring that lost rows on a worker-api restart.
        this.planReviewStore = new PlanReviewStore(db, bus, this.logger);
        // Workspace-level repo registry — folds RepoRegistered /
        // RepoUpdated / RepoArchived / RepoEnsured / RepoEnsureFailed /
        // RepoSynced / RepoSyncFailed into the `repos` table from
        // migration 011. The Repos modal reads through this projection;
        // the planner's pre-spawn refresh resolves a plan's primary
        // repoId → url + default_branch + ensured_path from the same
        // row.
        this.repoProjectionStore = new RepoProjectionStore(db, bus, this.logger);
        // Architect Tier (Phase 2): folds the requirement lifecycle events +
        // fan-out BriefSubmitted linkage into the requirements tables
        // (migration 023). The board's Requirements lane reads through it.
        this.requirementProjectionStore = new RequirementProjectionStore(db, bus, this.logger);
        this.subscriberNames.push(PROJECT_PROJECTION_SUBSCRIBER);
        this.subscriberNames.push(PLAN_PROJECTION_SUBSCRIBER);
        this.subscriberNames.push(PLAN_REVIEW_PROJECTION_SUBSCRIBER);
        this.subscriberNames.push(REPO_PROJECTION_SUBSCRIBER);
        this.subscriberNames.push(REQUIREMENT_PROJECTION_SUBSCRIBER);
        this.logger.info(
            'orchestrator: sidebar projections attached (project + plan + plan-review + repo)',
            {
                projectSubscriber: PROJECT_PROJECTION_SUBSCRIBER,
                planSubscriber: PLAN_PROJECTION_SUBSCRIBER,
                planReviewSubscriber: PLAN_REVIEW_PROJECTION_SUBSCRIBER,
                repoSubscriber: REPO_PROJECTION_SUBSCRIBER,
            },
        );
    }

    /**
     * Accessor for the SQLite-backed repo projection. The worker-api
     * mounts the `/api/repos` routes against this; the orchestrator's
     * planner pre-spawn refresh resolves a plan's primary repo through
     * it too.
     */
    getRepoProjectionStore(): RepoProjectionStore {
        if (!this.repoProjectionStore) {
            throw new Error('Orchestrator: getRepoProjectionStore() called before start()');
        }
        return this.repoProjectionStore;
    }

    /**
     * Accessor for the WorkspaceRepoFetcher. Exposed so the
     * board-http server can wire its `/api/repos/:id/sync` route
     * against the same instance the orchestrator uses internally.
     */
    getWorkspaceRepoFetcher(): WorkspaceRepoFetcher {
        if (!this.workspaceRepoFetcher) {
            throw new Error(
                'Orchestrator: getWorkspaceRepoFetcher() called before start()',
            );
        }
        return this.workspaceRepoFetcher;
    }

    /**
     * Accessor for the SQLite-backed plan-review projection. The
     * worker-api host uses this to mount the `/api/projects/:pid/plans/
     * :planId/plan-review` family of routes against durable state.
     * Throws when called before {@link start} has wired the store.
     */
    getPlanReviewStore(): PlanReviewStore {
        if (!this.planReviewStore) {
            throw new Error('Orchestrator: getPlanReviewStore() called before start()');
        }
        return this.planReviewStore;
    }

    private attachPlanProjection(): void {
        const bus = this.bus!;
        const db = this.db!;
        // `tasks.plan_id` has an ENFORCED foreign key to `plans(id)`
        // (migration 001 + `PRAGMA foreign_keys = ON`). The row used to be
        // written only on PlanApproved — but a non-feature archetype
        // (deploy-only / document / review-* / investigate) never emits
        // PlanApproved: GeneratePlan spawns the decomposer directly. Its
        // tasks then failed to INSERT with a FK violation that the bus
        // swallowed into a log line, so the board showed the tasks live
        // (in-memory SSE fold), the agents ran (the engine works off
        // flow_state, not this table) — and after a refresh the tasks were
        // gone and the plan classified back to Draft. Field case:
        // "deploy the orderapp" (planType deploy-only).
        //
        // PlanCreated is therefore the earliest point the parent row can
        // exist, and it precedes any TaskCreated for that plan.
        bus.subscribe<{ planId?: string; projectId?: string }>(
            'PlanCreated',
            async (event) => {
                const planId = event.payload?.planId;
                const projectId = event.payload?.projectId;
                if (typeof planId !== 'string' || planId.length === 0) return;
                db.prepare(
                    `INSERT OR IGNORE INTO plans(id, project_id, status, created_at)
                     VALUES (?, ?, 'created', ?)`,
                ).run(planId, typeof projectId === 'string' ? projectId : '', event.occurredAt);
            },
            { subscriber: SUBSCRIBER_PROJECTION_PLANS },
        );
        bus.subscribe<PlanApprovedPayload>(
            Events.PLAN_APPROVED,
            async (event) => {
                db.prepare(
                    `INSERT OR IGNORE INTO plans(id, project_id, status, created_at)
                     VALUES (?, ?, 'approved', ?)`,
                ).run(
                    event.payload.planId,
                    event.payload.projectId,
                    event.occurredAt,
                );
            },
            { subscriber: SUBSCRIBER_PROJECTION_PLANS },
        );

        // Decomposer clarifications (migration 035).
        //
        // The decomposer can end a run with the shared `NEEDS_HUMAN_INPUT`
        // block instead of task JSON. Recording the question here is what
        // lets the board hold the decomposer card with an Answer button
        // across a reload — the live SSE fold alone dies with the tab — and
        // what lets `AnswerDecomposerQuestion` verify at dispatch time that
        // the question it is answering is still open.
        //
        // Keyed by the raising event's seq, so a replay re-inserts the same
        // rows instead of duplicating them.
        bus.subscribe<{
            readonly planId?: string;
            readonly projectId?: string;
            readonly question?: string;
            readonly options?: unknown;
            readonly askedAt?: number;
        }>(
            'PlanDecomposeQuestionRaised',
            async (event) => {
                const planId = event.payload?.planId;
                const question = event.payload?.question;
                if (typeof planId !== 'string' || planId.length === 0) return;
                if (typeof question !== 'string' || question.trim().length === 0) return;
                db.prepare(
                    `INSERT OR IGNORE INTO decomposer_clarifications
                         (event_seq, plan_id, project_id, question, options, asked_at)
                     VALUES (?, ?, ?, ?, ?, ?)`,
                ).run(
                    event.seq,
                    planId,
                    typeof event.payload?.projectId === 'string' ? event.payload.projectId : '',
                    question,
                    Array.isArray(event.payload?.options) && event.payload.options.length > 0
                        ? JSON.stringify(event.payload.options)
                        : null,
                    typeof event.payload?.askedAt === 'number'
                        ? event.payload.askedAt
                        : event.occurredAt,
                );
            },
            { subscriber: SUBSCRIBER_PROJECTION_PLANS },
        );
        // The answer lands on the OLDEST still-open question for the plan.
        // Oldest, not newest: questions are answered in the order they were
        // asked (the decomposer is held on one at a time), and picking the
        // newest would strand an earlier row unanswered forever — it would
        // then keep reading as the pending question and the Answer button
        // would never go away.
        bus.subscribe<{
            readonly planId?: string;
            readonly answer?: string;
            readonly answeredAt?: number;
        }>(
            'PlanDecomposeQuestionAnswered',
            async (event) => {
                const planId = event.payload?.planId;
                const answer = event.payload?.answer;
                if (typeof planId !== 'string' || planId.length === 0) return;
                if (typeof answer !== 'string' || answer.trim().length === 0) return;
                db.prepare(
                    `UPDATE decomposer_clarifications
                        SET answer = ?, answered_at = ?
                      WHERE event_seq = (
                          SELECT event_seq FROM decomposer_clarifications
                           WHERE plan_id = ? AND (answer IS NULL OR TRIM(answer) = '')
                           ORDER BY event_seq ASC
                           LIMIT 1
                      )`,
                ).run(
                    answer,
                    typeof event.payload?.answeredAt === 'number'
                        ? event.payload.answeredAt
                        : event.occurredAt,
                    planId,
                );
            },
            { subscriber: SUBSCRIBER_PROJECTION_PLANS },
        );

        /**
         * The operator gave up on a decomposer question.
         *
         * Field report: the decomposer offered "cancel the task" among its
         * own options; answering with it re-spawned the decomposer, which
         * asked again, and the card has no Dismiss while a question is
         * pending — so the plan was stuck with no way out.
         *
         * The row is marked answered with an explicit abandoned note
         * rather than deleted or left blank: `readPendingDecomposerQuestion`
         * selects on an empty answer, so a blank would keep the question
         * pending forever (the bug), and deleting the row would erase the
         * fact that it was ever asked.
         */
        bus.subscribe<{
            readonly planId?: string;
            readonly reason?: string;
            readonly abandonedAt?: number;
        }>(
            'PlanDecomposeQuestionAbandoned',
            async (event) => {
                const planId = event.payload?.planId;
                if (typeof planId !== 'string' || planId.length === 0) return;
                const reason = typeof event.payload?.reason === 'string'
                    ? event.payload.reason.trim()
                    : '';
                const note = reason.length > 0
                    ? `[abandoned by the operator] ${reason}`
                    : '[abandoned by the operator]';
                db.prepare(
                    `UPDATE decomposer_clarifications
                        SET answer = ?, answered_at = ?
                      WHERE event_seq = (
                          SELECT event_seq FROM decomposer_clarifications
                           WHERE plan_id = ? AND (answer IS NULL OR TRIM(answer) = '')
                           ORDER BY event_seq ASC
                           LIMIT 1
                      )`,
                ).run(
                    note,
                    typeof event.payload?.abandonedAt === 'number'
                        ? event.payload.abandonedAt
                        : event.occurredAt,
                    planId,
                );
            },
            { subscriber: SUBSCRIBER_PROJECTION_PLANS },
        );
        this.subscriberNames.push(SUBSCRIBER_PROJECTION_PLANS);
    }

    private attachTaskProjection(): void {
        const bus = this.bus!;
        const db = this.db!;
        // Two distinct `TaskCreated` shapes flow on the same bus:
        //   - orchestrator-emitted from the `CreateTask` command:
        //     `{ taskId, planId, type, flowId, ...lineage }`. No title.
        //   - decomposer-projected from `TaskProjectionStore` per task:
        //     `{ taskId, planId, type, dependencies, title, description }`.
        //     No flowId.
        // The INSERT below uses INSERT-then-UPDATE on the same key so
        // a later event in either order fills in the gaps without
        // clobbering anything the previous one wrote.
        // Defensive parent-row ensure. The FK above means a missing
        // `plans` row silently drops the whole task (the bus logs the
        // throw and moves on). Plans created before the PlanCreated fold
        // existed — or arriving from any future path that skips it —
        // must not cost the operator their tasks. project_id is
        // recovered from the sidebar projection when we have it.
        const ensurePlanRowStmt = db.prepare(
            `INSERT OR IGNORE INTO plans(id, project_id, status, created_at)
             VALUES (?, COALESCE((SELECT pid FROM sidebar_plans WHERE plan_id = ?), ''), 'created', ?)`,
        );
        const insertStmt = db.prepare(
            `INSERT INTO tasks(id, plan_id, type, status, flow_id, title, description, ticket_details, repo_id, created_at)
             VALUES (?, ?, ?, 'created', ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
                 plan_id     = COALESCE(NULLIF(excluded.plan_id, ''), tasks.plan_id),
                 type        = COALESCE(NULLIF(excluded.type, ''), tasks.type),
                 flow_id     = COALESCE(excluded.flow_id, tasks.flow_id),
                 title       = COALESCE(excluded.title, tasks.title),
                 description = COALESCE(excluded.description, tasks.description),
                 ticket_details = COALESCE(excluded.ticket_details, tasks.ticket_details),
                 repo_id     = COALESCE(excluded.repo_id, tasks.repo_id),
                 -- Keep the FIRST creation time. A re-decompose emits a
                 -- second TaskCreated for the same id, and the operator
                 -- reading "created" on the modal wants to know how long
                 -- this work has been around, not when it was last
                 -- regenerated. COALESCE on the STORED side, so a row
                 -- backfilled as NULL still picks one up.
                 created_at  = COALESCE(tasks.created_at, excluded.created_at)`,
        );
        // Status reset on a re-decompose: a TaskCreated event landing
        // for a task that already exists in the projection is treated
        // as a fresh start — reset the row to 'created' + clear
        // parked_reason so the next dispatch through the flow engine
        // begins from the approval gate, and wipe the per-task
        // transients (step summaries, flow_state, worktree) so the
        // board's chip colours / flow engine's state agree with the
        // new revision. Without this, re-decomposing a plan whose
        // tasks reuse their ids (deterministic decomposer output) shows
        // stale green chips on the new attempt.
        const resetTaskOnRedecomposeStmt = db.prepare(
            `UPDATE tasks
                SET status = 'created',
                    parked_reason = NULL,
                    feedback = NULL,
                    -- Repoint at the plan that just created this task.
                    -- Omitting it is what let a colliding id keep pointing
                    -- at an older plan: the reset refreshed every content
                    -- field, so the row LOOKED like the new plan's task
                    -- while belonging to the old one, and the new plan
                    -- rendered as an empty Draft.
                    plan_id = COALESCE(NULLIF(?, ''), plan_id),
                    title = COALESCE(?, title),
                    description = COALESCE(?, description),
                    ticket_details = COALESCE(?, ticket_details),
                    repo_id = COALESCE(?, repo_id),
                    type = COALESCE(NULLIF(?, ''), type),
                    flow_id = COALESCE(?, flow_id)
              WHERE id = ?`,
        );
        /** Which plan owns this task id today? '' / missing = nobody. */
        const taskOwnerStmt = db.prepare('SELECT plan_id FROM tasks WHERE id = ?');
        // Hoisted so the TaskSkipped + TaskRetried subscribers below can
        // reuse them.
        const stepSummariesWipeStmt = db.prepare(
            'DELETE FROM task_step_summaries WHERE task_id = ?',
        );
        const flowStateWipeStmt = db.prepare(
            'DELETE FROM flow_state WHERE task_id = ?',
        );
        const worktreeWipeStmt = db.prepare(
            'DELETE FROM task_worktrees WHERE task_id = ?',
        );
        bus.subscribe<TaskCreatedPayload & {
            title?: string;
            description?: string;
            ticketDetails?: Record<string, unknown>;
            repoId?: string;
        }>(
            Events.TASK_CREATED,
            async (event) => {
                const p = event.payload;
                const ticketJson
                    = p.ticketDetails && typeof p.ticketDetails === 'object'
                        ? JSON.stringify(p.ticketDetails)
                        : null;
                const repoId
                    = typeof p.repoId === 'string' && p.repoId.length > 0
                        ? p.repoId
                        : null;
                // Whose task is this id? A re-decompose of the SAME plan
                // reuses ids by design; an id already owned by ANOTHER
                // plan is a collision, and resetting it would hand that
                // plan's history to this one.
                const owner = taskOwnerStmt.get(p.taskId) as
                    | { plan_id: string | null }
                    | undefined;
                const exists = owner !== undefined;
                if (
                    exists
                    && typeof p.planId === 'string'
                    && p.planId.length > 0
                    && owner.plan_id !== null
                    && owner.plan_id !== p.planId
                ) {
                    // Field case (plan-1786543915236-elif): two plans
                    // derived the same abbreviation, so the new plan's
                    // tasks minted ids belonging to a plan archived weeks
                    // earlier. This branch used to fall through to the
                    // re-decompose reset, which left `plan_id` on the OLD
                    // plan — the new plan showed zero tasks and rendered
                    // as a Draft while its work ran under the old one.
                    //
                    // The id allocator now shifts past a taken prefix, so
                    // this should be unreachable. If it is reached, the
                    // task is REPOINTED at the plan that just created it
                    // (the operator's live plan is the one that must
                    // work) and the theft is logged loudly rather than
                    // happening in silence.
                    this.logger.error(
                        'projection-tasks: task id collides with another plan — repointing',
                        {
                            taskId: p.taskId,
                            previousPlanId: owner.plan_id,
                            planId: p.planId,
                        },
                    );
                }
                if (exists) {
                    // Re-decompose path: refresh the content fields,
                    // reset lifecycle, and wipe the per-task transient
                    // state so the new attempt starts from a clean
                    // slate.
                    resetTaskOnRedecomposeStmt.run(
                        typeof p.planId === 'string' ? p.planId : '',
                        typeof p.title === 'string' ? p.title : null,
                        typeof p.description === 'string' ? p.description : null,
                        ticketJson,
                        repoId,
                        p.type,
                        p.flowId ?? null,
                        p.taskId,
                    );
                    stepSummariesWipeStmt.run(p.taskId);
                    flowStateWipeStmt.run(p.taskId);
                    worktreeWipeStmt.run(p.taskId);
                    return;
                }
                // Parent row first: the FK on tasks.plan_id would otherwise
                // reject the whole insert and the task would exist only in
                // the live SSE view until the operator refreshed.
                if (typeof p.planId === 'string' && p.planId.length > 0) {
                    ensurePlanRowStmt.run(p.planId, p.planId, event.occurredAt);
                }
                insertStmt.run(
                    p.taskId,
                    p.planId,
                    p.type,
                    p.flowId ?? null,
                    typeof p.title === 'string' ? p.title : null,
                    typeof p.description === 'string' ? p.description : null,
                    ticketJson,
                    repoId,
                    // The EVENT's time, not the clock: a replay must
                    // rebuild the same creation date it built the first
                    // time, not stamp the rebuild.
                    event.occurredAt,
                );
            },
            { subscriber: SUBSCRIBER_PROJECTION_TASKS },
        );

        // Lifecycle status writes — without these, the durable row's
        // `status` stays 'created' forever and a reload re-hydrates the
        // board with the wrong button set. The TaskApproved cascade +
        // operator-fired Skip both need to land on disk so
        // `hydrateTasks()` reflects the live state.
        const updateStatusStmt = db.prepare(
            'UPDATE tasks SET status = ? WHERE id = ?',
        );
        // Failure write: status + the stage the card matrix keys its
        // failed:<stage> tag (and Retry/Restart action row) on.
        const failTaskStmt = db.prepare(
            "UPDATE tasks SET status = 'failed', failed_stage = ? WHERE id = ?",
        );
        const clearFailedStageStmt = db.prepare(
            'UPDATE tasks SET failed_stage = NULL WHERE id = ?',
        );
        // An operator rejection carries a REASON, and the reason has to
        // outlive the click. `tasks.feedback` is already the durable home
        // for reject feedback — `readTaskAgentContext` reads it back as
        // `rejectFeedback` and renders it as `# Feedback to address`, so
        // storing it here means a Retry re-runs the agent knowing what was
        // wrong, and the board can show the operator what they said.
        //
        // Field case: the card's Reject dispatched
        // `UpdateTask{status:'rejected', reason}`, and UpdateTask accepts
        // neither field — it drops everything but `taskId`. The task stayed
        // on the board unchanged, no Retry appeared (nothing marked it
        // failed), and the reason was never written anywhere. All three
        // symptoms, one dropped payload.
        const setFeedbackStmt = db.prepare(
            'UPDATE tasks SET feedback = ? WHERE id = ?',
        );
        // Step-id → v1 stage vocabulary (dev/review/test/commit). Unknown
        // steps map to 'dev' so a failed task ALWAYS carries a stage the
        // matrix recognises.
        const stepIdToStage = (stepId: string | null): string => {
            if (!stepId) return 'dev';
            if (stepId === 'develop' || stepId === 'write' || stepId === 'deploy') return 'dev';
            return ['review', 'test', 'commit'].includes(stepId) ? stepId : 'dev';
        };
        // parked_question/parked_choices ride along so a clarification
        // park survives a board reload (migration 031): choices land on
        // ClarificationRequested, which is published BEFORE the
        // TaskParked of the same question cycle — so the clarification
        // variant of this fold must NOT touch parked_choices, or it
        // wipes what was just written and a reloaded board shows the
        // question with no radio options (field incident). Every other
        // reason (and every clear) still nulls all three.
        const updateParkedStmt = db.prepare(
            'UPDATE tasks SET parked_reason = ?, parked_question = ?, parked_choices = NULL WHERE id = ?',
        );
        const updateParkedKeepChoicesStmt = db.prepare(
            'UPDATE tasks SET parked_reason = ?, parked_question = ? WHERE id = ?',
        );
        const updateParkedChoicesStmt = db.prepare(
            'UPDATE tasks SET parked_choices = ? WHERE id = ?',
        );
        bus.subscribe<TaskApprovedPayload>(
            Events.TASK_APPROVED,
            async (event) => {
                updateStatusStmt.run('approved', event.payload.taskId);
            },
            { subscriber: SUBSCRIBER_PROJECTION_TASKS },
        );
        // TaskPreApproved — operator approved a task while it was still
        // waiting on dependencies. Set the durable `pre_approved` flag so
        // the engine's approval gate consumes it (auto-start) when the
        // unblock pass re-dispatches the task after its upstreams merge.
        const setPreApprovedStmt = db.prepare(
            'UPDATE tasks SET pre_approved = 1 WHERE id = ?',
        );
        bus.subscribe<{ readonly taskId?: string }>(
            'TaskPreApproved',
            async (event) => {
                const taskId = event.payload?.taskId;
                if (typeof taskId !== 'string' || taskId.length === 0) return;
                setPreApprovedStmt.run(taskId);
            },
            { subscriber: SUBSCRIBER_PROJECTION_TASKS },
        );
        // TaskInstructionsSet — operator added/edited instructions on a task
        // (migration 022). Persist so readTaskAgentContext folds it into the
        // agent prompt and a board reload re-hydrates the textarea.
        const setInstructionsStmt = db.prepare(
            'UPDATE tasks SET instructions = ? WHERE id = ?',
        );
        bus.subscribe<{ readonly taskId?: string; readonly instructions?: string }>(
            'TaskInstructionsSet',
            async (event) => {
                const taskId = event.payload?.taskId;
                if (typeof taskId !== 'string' || taskId.length === 0) return;
                const instructions = typeof event.payload?.instructions === 'string'
                    ? event.payload.instructions
                    : '';
                setInstructionsStmt.run(instructions.length > 0 ? instructions : null, taskId);
            },
            { subscriber: SUBSCRIBER_PROJECTION_TASKS },
        );

        // TaskFieldsUpdated — EditTask changed a task's title/description.
        // Persist them, because until now nothing did: the event was
        // emitted, the BOARD folded it into its in-memory row, and the
        // `tasks` table was never touched. So the edit survived exactly
        // until a reload, and the AGENT never saw it at all —
        // `readTaskAgentContext` builds the prompt from
        // `tasks.title` / `tasks.description`.
        //
        // That silently defeated two surfaces: the interrupt-retry modal,
        // whose feedback box dispatches EditTask{description}, and now the
        // chat's PROPOSE_TASK_UPDATE. Both looked like they worked.
        //
        // COALESCE on each column so a partial edit (title only) leaves the
        // other field alone rather than nulling it.
        const updateTaskFieldsStmt = db.prepare(
            `UPDATE tasks
                SET title       = COALESCE(?, title),
                    description = COALESCE(?, description)
              WHERE id = ?`,
        );
        bus.subscribe<{
            readonly taskId?: string;
            readonly title?: string;
            readonly description?: string;
        }>(
            'TaskFieldsUpdated',
            async (event) => {
                const taskId = event.payload?.taskId;
                if (typeof taskId !== 'string' || taskId.length === 0) return;
                const title = typeof event.payload?.title === 'string'
                    ? event.payload.title
                    : null;
                const description = typeof event.payload?.description === 'string'
                    ? event.payload.description
                    : null;
                if (title === null && description === null) return;
                updateTaskFieldsStmt.run(title, description, taskId);
            },
            { subscriber: SUBSCRIBER_PROJECTION_TASKS },
        );

        // Attachment metadata projection (migration 021). AttachmentAdded
        // folds the upload's metadata into the `attachments` table;
        // AttachmentRemoved deletes the row AND the underlying blob. The
        // bytes were written by the worker-api router's blob-store handle
        // pointed at the same root, so deleting here is the symmetric
        // teardown. Blob delete is idempotent, so an event replay after a
        // restart (row already gone) is a harmless no-op.
        bus.subscribe<AttachmentAddedPayload>(
            Events.ATTACHMENT_ADDED,
            async (event) => {
                const p = event.payload;
                if (!p || typeof p.attachmentId !== 'string') return;
                this.attachmentStore?.add({
                    id: p.attachmentId,
                    // Verbatim from the event. The old ternary collapsed
                    // everything that was not a plan into a task, which
                    // would have filed every requirement attachment
                    // under the wrong owner.
                    ownerType: p.ownerType,
                    ownerId: p.ownerId,
                    fileName: p.fileName,
                    contentType: p.contentType,
                    sizeBytes: p.sizeBytes,
                    storageKey: p.storageKey,
                    caption: p.caption ?? null,
                    createdAt: p.createdAt,
                    // Migration 038. An event from before it landed has
                    // no kind and is an operator upload.
                    kind: p.kind ?? 'input',
                });
                // Mirror PLAN and REQUIREMENT attachments to disk for the
                // design-side agents. They have no worktree, so the
                // task-side materialiser never runs for them and the
                // bytes were simply unavailable: the operator attached a
                // CSV that WAS the spec and the planner reported the file
                // "is not in the workspace". Written on add rather than
                // at spawn because startLifecycleAgent is synchronous and
                // the blob port is not — this way the file is on disk
                // long before any planner or architect runs.
                // Outputs are never design input: mirroring a harvested
                // file into the plan-attachments tree would feed a task's
                // own CSV back into the next planner as if the operator
                // had pinned it there.
                const mirrorRoot = (p.kind ?? 'input') === 'output'
                    ? null
                    : designMirrorRoot(p.ownerType);
                if (mirrorRoot !== null && this.attachmentBlobStore) {
                    await mirrorDesignAttachment({
                        root: mirrorRoot,
                        ownerId: p.ownerId,
                        attachmentId: p.attachmentId,
                        fileName: p.fileName,
                        storageKey: p.storageKey,
                        blobStore: this.attachmentBlobStore,
                        logger: this.logger,
                    });
                }
            },
            { subscriber: SUBSCRIBER_PROJECTION_TASKS },
        );
        bus.subscribe<{ readonly attachmentId?: string }>(
            Events.ATTACHMENT_REMOVED,
            async (event) => {
                const attachmentId = event.payload?.attachmentId;
                if (typeof attachmentId !== 'string' || attachmentId.length === 0) {
                    return;
                }
                const existing = this.attachmentStore?.get(attachmentId) ?? null;
                this.attachmentStore?.remove(attachmentId);
                // Symmetric teardown for the design mirrors — otherwise
                // a removed attachment keeps showing up in every future
                // planner / architect prompt, which is a worse failure
                // than never having had it.
                const goneRoot = existing
                    ? designMirrorRoot(existing.ownerType)
                    : null;
                if (existing && goneRoot !== null) {
                    await removeMirroredDesignAttachment({
                        root: goneRoot,
                        ownerId: existing.ownerId,
                        attachmentId,
                        logger: this.logger,
                    });
                }
                if (existing && this.attachmentBlobStore) {
                    try {
                        await this.attachmentBlobStore.delete(existing.storageKey);
                    } catch (err) {
                        this.logger.warn(
                            'orchestrator: attachment blob delete failed',
                            {
                                attachmentId,
                                error: err instanceof Error ? err.message : String(err),
                            },
                        );
                    }
                }
            },
            { subscriber: SUBSCRIBER_PROJECTION_TASKS },
        );

        bus.subscribe<{ readonly taskId?: string }>(
            'TaskSkipped',
            async (event) => {
                const taskId = event.payload?.taskId;
                if (typeof taskId !== 'string' || taskId.length === 0) return;
                updateStatusStmt.run('skipped', taskId);
                // Full per-task wipe on cancel/dismiss so a re-decompose
                // (or unskip + retry) starts from a clean slate: chip
                // colours reset to 'todo', flow_state goes away, the
                // worktree row + on-disk directory are both removed.
                // `removeOnDisk` runs `git worktree remove --force`
                // first (cleans up the .git/worktrees registration),
                // falls back to fs.rmSync. Best-effort — logged but
                // doesn't throw.
                if (this.taskWorktreeStore) {
                    await this.taskWorktreeStore.removeOnDisk(taskId);
                }
                stepSummariesWipeStmt.run(taskId);
                flowStateWipeStmt.run(taskId);
                worktreeWipeStmt.run(taskId);
                // Drop the skipped task's outgoing edges so it doesn't
                // hold up downstream tasks. The task's status is now
                // terminal ('skipped'), which already disqualifies it
                // from the schedulable set, but a downstream task that
                // depended on it would otherwise stay parked forever
                // because no TaskFinished will ever flip the edge.
                this.taskDependencyStore?.clearDependencies(taskId);
            },
            { subscriber: SUBSCRIBER_PROJECTION_TASKS },
        );

        // TaskRetried — operator pressed Retry. Reset the durable row's
        // status to 'created' AND wipe the per-step transcript records
        // so the stage-bar chips reset to 'todo' (blue) instead of
        // showing the previous run's green/red chips on top of the
        // fresh attempt. The flow engine subscriber to the same event
        // handles the flow_state wipe + first-step re-dispatch; the
        // statements are hoisted above so the TaskSkipped subscriber
        // can reuse them.
        //
        // The worktree wipe (DB row + on-disk dir) is what makes Retry
        // actually pick up upstream merges. Without it, the next
        // `ensureWorktree` on the re-dispatched first step finds the
        // existing worktree row and returns it as-is — the worktree's
        // branch was created off origin/<default> BEFORE the upstream
        // merged, so the operator sees the same stale code the failed
        // run was working against. Removing the worktree forces the
        // next step to create a fresh one from the freshly-refreshed
        // bare clone (resolveTaskRepoSpec runs `refreshOne` immediately
        // before `ensureWorktree`), which is exactly what the operator
        // expects when they click Restart on a task whose upstream
        // landed new commits.
        bus.subscribe<{ readonly taskId?: string }>(
            'TaskRetried',
            async (event) => {
                const taskId = event.payload?.taskId;
                if (typeof taskId !== 'string' || taskId.length === 0) return;
                this.logger.info(
                    'orchestrator: TaskRetried — resetting task + wiping worktree',
                    { taskId },
                );
                updateStatusStmt.run('created', taskId);
                clearFailedStageStmt.run(taskId);
                stepSummariesWipeStmt.run(taskId);
                if (this.taskWorktreeStore) {
                    await this.taskWorktreeStore.removeOnDisk(taskId);
                }
                const wiped = worktreeWipeStmt.run(taskId);
                this.logger.info(
                    'orchestrator: TaskRetried — worktree row removed',
                    { taskId, rowsAffected: wiped.changes },
                );
                // Re-block dependents. When this upstream task previously
                // finished, the unblock pass on TaskFinished flipped
                // every edge `<dep> depends_on_task_id=<taskId>` to
                // 'merged'. Restarting the upstream means its outputs
                // are no longer trusted, so any downstream that was
                // released by the prior run must wait again — otherwise
                // approving a downstream right now slips past the
                // hasUnmetDeps check (the edge is still merged in the
                // table) and the downstream agent starts against an
                // upstream that hasn't actually finished this time.
                //
                // Re-park downstreams that were exclusively gated on
                // this upstream so the board's "Waiting on deps" chip
                // accurately reflects the new gate state.
                if (this.taskDependencyStore) {
                    const reblocked = this.taskDependencyStore
                        .resetMergedEdgesPointingTo(taskId);
                    if (reblocked > 0) {
                        const dependents = this.taskDependencyStore
                            .listDependents(taskId);
                        for (const downstreamId of dependents) {
                            // Only re-park downstreams whose row isn't
                            // already in a terminal state — done /
                            // skipped tasks shouldn't be revived by an
                            // upstream restart.
                            const downstreamStatus = this.taskDependencyStore
                                .taskStatusFor(downstreamId);
                            if (downstreamStatus === 'done'
                                || downstreamStatus === 'skipped'
                                || downstreamStatus === 'failed') {
                                continue;
                            }
                            this.taskDependencyStore.parkTask(
                                downstreamId,
                                'waiting-deps',
                            );
                        }
                        this.logger.info(
                            'orchestrator: TaskRetried — re-blocked downstream dependents',
                            {
                                taskId,
                                reblockedEdgeCount: reblocked,
                                dependents,
                            },
                        );
                    }
                }
            },
            { subscriber: SUBSCRIBER_PROJECTION_TASKS },
        );

        // TaskFinished — the engine reached its terminal `emit:TaskFinished`
        // (after wait-merged resumes following a successful PR merge).
        // Flip the durable row to `status='done'` and clear parked_reason
        // so the board's "Merge PR" affordance retracts and the card
        // renders as a finished task on reload. The post-MergeTaskPr
        // ResumeTask flow is what publishes this event.
        bus.subscribe<{ readonly taskId?: string }>(
            'TaskFinished',
            async (event) => {
                const taskId = event.payload?.taskId;
                if (typeof taskId !== 'string' || taskId.length === 0) return;
                updateStatusStmt.run('done', taskId);
                updateParkedStmt.run(null, null, taskId);
            },
            { subscriber: SUBSCRIBER_PROJECTION_TASKS },
        );

        // ClarificationAnswered — persist the operator's answer for the
        // WHOLE task, not just the step that asked.
        //
        // The engine hands the answer to the one step it resumes
        // (`humanAnswer` context in onTaskResumed). Every step after
        // that gets a StartAgent without it, and TASK.md is rewritten
        // per step — so the `# Human clarification` section the
        // developer acted on was erased before the reviewer ever read
        // it. The reviewer then measured the work against the task
        // statement the operator had already overruled and rejected it
        // (field case). Reject feedback survives exactly this way on
        // `tasks.feedback`; this is the missing half.
        //
        // The question text lives on `tasks.parked_question` (migration
        // 031) and is still the current park when the answer lands, so
        // the Q and the A are stored as a pair — a bare answer ("option
        // B") means nothing to a later agent. This subscriber MUST stay
        // registered ahead of the `TaskResumed` handler further down
        // that clears parked_reason / parked_question: the bus delivers
        // in registration order, and afterwards the question is gone.
        //
        // `TaskResumed` is the event to fold, NOT `ClarificationAnswered`.
        // The latter is only emitted by `handlers/resume.ts`, which
        // nothing registers — `registerCommandHandlers` binds RESUME_TASK
        // to the plain `createResumeTaskHandler` from core/commands. So
        // ClarificationAnswered never fires in production (the sidecar
        // write and the `remember` -> agent-memory append are dead for
        // the same reason). It is folded here too so that wiring the
        // richer handler later needs no change; duplicate answers are
        // collapsed by `mergeClarifications` on the read side.
        const insertClarificationStmt = this.db!.prepare(
            `INSERT OR IGNORE INTO task_clarifications
                 (event_seq, task_id, question, answer, answered_at)
             VALUES (?, ?, ?, ?, ?)`,
        );
        const parkedQuestionStmt = this.db!.prepare(
            'SELECT parked_question FROM tasks WHERE id = ?',
        );
        const recordClarification = (
            seq: number,
            taskId: unknown,
            answer: unknown,
            answeredAt: number,
        ): void => {
            if (typeof taskId !== 'string' || taskId.length === 0) return;
            if (typeof answer !== 'string' || answer.trim().length === 0) return;
            const row = parkedQuestionStmt.get(taskId) as
                | { parked_question: string | null }
                | undefined;
            insertClarificationStmt.run(
                seq,
                taskId,
                row?.parked_question ?? null,
                answer,
                answeredAt,
            );
        };
        bus.subscribe<{
            readonly taskId?: string;
            readonly decision?: string;
            readonly answer?: string;
        }>(
            'TaskResumed',
            async (event) => {
                // Only an approve-with-answer is a clarification. An
                // approval-gate click carries no answer; a reject carries
                // `feedback`, which is already durable on tasks.feedback.
                if (event.payload?.decision !== 'approve') return;
                recordClarification(
                    event.seq,
                    event.payload?.taskId,
                    event.payload?.answer,
                    event.occurredAt,
                );
            },
            { subscriber: SUBSCRIBER_PROJECTION_TASKS },
        );
        bus.subscribe<{
            readonly taskId?: string;
            readonly answer?: string;
            readonly answeredAt?: number;
        }>(
            'ClarificationAnswered',
            async (event) => {
                recordClarification(
                    event.seq,
                    event.payload?.taskId,
                    event.payload?.answer,
                    typeof event.payload?.answeredAt === 'number'
                        ? event.payload.answeredAt
                        : event.occurredAt,
                );
            },
            { subscriber: SUBSCRIBER_PROJECTION_TASKS },
        );

        // project-context-writer bridge. An `update-project-context` task's
        // whole product is the agent's final message; the flow's `emit:`
        // terminal carries no output, so without this the task would go
        // green having changed nothing — the silent-drop failure this
        // codebase keeps paying for. Same shape as the investigator bridge
        // below, but it dispatches a COMMAND rather than publishing an
        // event: `UpdateProjectContext` is where the truncation guard
        // lives, and bypassing it would let a half-generated context
        // overwrite a good one.
        const contextTaskProjectStmt = this.db!.prepare(
            `SELECT sp.pid AS pid FROM tasks t
               LEFT JOIN sidebar_plans sp ON sp.plan_id = t.plan_id
              WHERE t.id = ?`,
        );
        bus.subscribe<Record<string, unknown>>(
            'AgentFinished',
            async (event) => {
                const p = event.payload ?? {};
                if (p.role !== 'project-context-writer') return;
                if (p.outcome !== 'success') return;
                const md = p.metadata;
                const taskId = md && typeof md === 'object'
                    ? (md as Record<string, unknown>).taskId
                    : undefined;
                if (typeof taskId !== 'string' || taskId.length === 0) return;

                const stepId = typeof (md as Record<string, unknown>).stepId === 'string'
                    ? (md as Record<string, unknown>).stepId as string
                    : 'write-context';
                const projectId = (contextTaskProjectStmt.get(taskId) as
                    | { pid: string | null }
                    | undefined)?.pid ?? null;

                // A context update that quietly did nothing is worse than
                // one that failed: the operator goes on believing the
                // design's follow-up landed. So every abandonment FAILS the
                // task with its reason — the board turns the step red and
                // shows the text, and Retry is there.
                //
                // `agent-outcome.ts` already fails the missing-marker case
                // before this runs. What reaches here is an output that
                // LOOKS right (marker present) and is not usable — a broken
                // fence, a stub replacement, both markers at once — plus
                // whatever the command handler's truncation guard rejects.
                const abandon = async (reason: string): Promise<void> => {
                    this.logger.warn(
                        'project-context: agent output not applied',
                        { taskId, projectId, reason },
                    );
                    await bus.publish({
                        type: FlowEvents.AGENT_FAILED,
                        v: 1,
                        occurredAt: this.clock(),
                        idempotencyKey:
                            `project-context:rejected:${String(p.agentId ?? taskId)}`,
                        payload: {
                            taskId,
                            stepId,
                            reason: `project context NOT updated — ${reason}`,
                        },
                    });
                };
                if (!projectId) {
                    await abandon('the task resolves to no project');
                    return;
                }

                const parsed = parseContextProposal(
                    typeof p.content === 'string' ? p.content : '',
                );
                if (parsed.kind === 'problem') {
                    await abandon(parsed.reason);
                    return;
                }
                if (parsed.kind === 'unchanged') {
                    // A real and expected answer, not a failure: the agent
                    // looked and found nothing worth revising.
                    this.logger.info('project-context: agent reported no change needed', {
                        taskId,
                        projectId,
                    });
                    return;
                }
                try {
                    await this.commandBus!.send<UpdateProjectContextPayload>({
                        type: BoardUiCommands.UPDATE_PROJECT_CONTEXT,
                        actor: 'project-context-writer',
                        issuedAt: this.clock(),
                        payload: { projectId, context: parsed.content },
                    });
                } catch (err) {
                    // The truncation guard throws from the command handler.
                    // Its message names what was wrong with the text.
                    await abandon(err instanceof Error ? err.message : String(err));
                    return;
                }
                this.logger.info('project-context: updated from agent output', {
                    taskId,
                    projectId,
                    bytes: parsed.content.length,
                });
                // The provider caches the rendered block, so without a
                // refresh the very next planner/architect run would still
                // see the old text.
                void this.projectContextProvider?.refresh();
            },
            { subscriber: SUBSCRIBER_PROJECTION_TASKS },
        );

        // Investigator bridge — an investigate-type task's report panel
        // (and the follow-up thread + auto-transition job) listen for
        // `InvestigationCompleted`, but the engine's `emit:` terminals
        // carry no agent output: until this bridge, NOTHING ever emitted
        // the event and every investigation card sat on "Investigation in
        // progress…" forever while the findings hid behind View report.
        // Bridge the investigator's AgentFinished into the event the
        // board folds (`payload.answer` becomes the report markdown).
        // The AutoTransitionJob's subscriber no-ops without
        // `report.spawn_feature_plan`, so this payload is inert there.
        const taskPlanStmt = this.db!.prepare(
            'SELECT plan_id FROM tasks WHERE id = ?',
        );
        bus.subscribe<Record<string, unknown>>(
            'AgentFinished',
            async (event) => {
                const p = event.payload ?? {};
                if (p.role !== 'investigator') return;
                if (p.outcome !== 'success') return;
                const md = p.metadata;
                if (!md || typeof md !== 'object') return;
                const taskId = (md as Record<string, unknown>).taskId;
                if (typeof taskId !== 'string' || taskId.length === 0) return;
                const content = typeof p.content === 'string' ? p.content : '';
                if (content.length === 0) return;
                const row = taskPlanStmt.get(taskId) as
                    | { plan_id: string | null }
                    | undefined;
                await bus.publish({
                    type: 'InvestigationCompleted',
                    v: 1,
                    occurredAt: this.clock(),
                    idempotencyKey: `investigation:${String(p.agentId ?? taskId)}`,
                    payload: {
                        taskId,
                        ...(row?.plan_id ? { planId: row.plan_id } : {}),
                        answer: content,
                    },
                });
            },
            { subscriber: SUBSCRIBER_PROJECTION_TASKS },
        );

        // AgentFailed for a task agent — flip the durable status to
        // 'failed' so the board's Retry button surfaces and a reload
        // doesn't fall back to an outdated 'approved'/'in_progress'
        // state. TWO shapes arrive on this wire type: the runner's
        // crash/exit≠0 events carry `metadata.taskId`; the orchestrator's
        // SEMANTIC failure bridge (agent exited cleanly but its output
        // says TESTS FAILED / CHANGES REQUIRED) publishes a bare
        // `{ taskId, reason }` payload with no metadata. The original
        // metadata-only read silently skipped the bridge shape — a
        // failed tester left the task stuck at 'approved' with no
        // Retry affordance (field case: L-IAED-002).
        bus.subscribe<Record<string, unknown>>(
            'AgentFailed',
            async (event) => {
                const p = event.payload ?? {};
                let taskId: unknown = p.taskId;
                if (typeof taskId !== 'string' || taskId.length === 0) {
                    const md = p.metadata;
                    taskId = md && typeof md === 'object'
                        ? (md as Record<string, unknown>).taskId
                        : undefined;
                }
                if (typeof taskId !== 'string' || taskId.length === 0) return;
                const md = p.metadata && typeof p.metadata === 'object'
                    ? (p.metadata as Record<string, unknown>)
                    : {};
                const stepId = typeof p.stepId === 'string'
                    ? p.stepId
                    : typeof md.stepId === 'string' ? (md.stepId as string) : null;
                failTaskStmt.run(stepIdToStage(stepId), taskId);
            },
            { subscriber: SUBSCRIBER_PROJECTION_TASKS },
        );

        // TaskFailed — the flow engine's terminal (no on_failure route,
        // retry budget exhausted, reject fallback). Nothing folded it
        // into the durable status before, so an engine-terminated task
        // reloaded as its stale pre-failure status.
        bus.subscribe<{ readonly taskId?: string; readonly finalAttempt?: boolean }>(
            'TaskFailed',
            async (event) => {
                const taskId = event.payload?.taskId;
                if (typeof taskId !== 'string' || taskId.length === 0) return;
                const stage = (event.payload as { failed_stage?: unknown })?.failed_stage;
                failTaskStmt.run(
                    stepIdToStage(typeof stage === 'string' ? stage : null),
                    taskId,
                );
                // Keep the operator's rejection reason. Only when one was
                // given — an engine-terminated failure carries a machine
                // reason that would overwrite real operator feedback from
                // an earlier round with boilerplate.
                const reason = (event.payload as { reason?: unknown })?.reason;
                if (typeof reason === 'string' && reason.trim().length > 0) {
                    setFeedbackStmt.run(reason.trim(), taskId);
                }
                // Free the worktree immediately ONLY on a genuinely terminal
                // failure. `finalAttempt` is set true by the flow engine only
                // when the retry budget is exhausted (it is omitted, not
                // false, mid-retry). A mid-retry failure therefore keeps its
                // worktree so the operator can inspect the WIP before Retry;
                // a terminal one frees it now instead of waiting for the 24h
                // gc. `removeOnDisk` is best-effort/log-never-throw and leaves
                // the DB row in place (a re-decompose/Retry wipes that).
                if (event.payload?.finalAttempt === true && this.taskWorktreeStore) {
                    await this.taskWorktreeStore.removeOnDisk(taskId);
                }
            },
            { subscriber: SUBSCRIBER_PROJECTION_TASKS },
        );

        // Per-step run records that back the stage-bar chips + the
        // per-stage summary modal. One row per (taskId, stepId) — the
        // assistant text the agent emits over AgentProgress is
        // accumulated in-memory under its agentId while the run is in
        // flight, then flushed to the row on the terminal event. The
        // board reads these rows on boot via /api/tasks/:taskId/step-summaries
        // so the chips and modal survive a reload.
        const stepRunUpsertStmt = db.prepare(
            `INSERT INTO task_step_summaries(task_id, step_id, role, status, started_at)
             VALUES (?, ?, ?, 'running', ?)
             ON CONFLICT(task_id, step_id) DO UPDATE SET
                 role        = COALESCE(NULLIF(excluded.role, ''), task_step_summaries.role),
                 status      = 'running',
                 started_at  = excluded.started_at,
                 finished_at = NULL,
                 summary     = NULL`,
        );
        const stepRunFinishStmt = db.prepare(
            `UPDATE task_step_summaries
                SET status = ?, finished_at = ?, summary = ?
              WHERE task_id = ? AND step_id = ?`,
        );

        // agentId -> in-flight accumulator. `chunks` collects every
        // assistant text block emitted via AgentProgress; on the
        // agent's terminal event the joined text becomes the durable
        // summary. The map is module-local — a worker restart wipes
        // it, so an agent mid-run at restart loses its accumulated
        // chunks. The row's status stays 'running' until the next
        // terminal event lands; the route reads `status='running'`
        // as "no summary yet".
        const liveAgentSummaries = new Map<
            string,
            { taskId: string; stepId: string; chunks: string[] }
        >();

        const orchClock = this.clock;
        bus.subscribe<Record<string, unknown>>(
            'AgentStarted',
            async (event) => {
                const md = event.payload?.metadata;
                if (!md || typeof md !== 'object') return;
                const meta = md as Record<string, unknown>;
                const taskId = typeof meta.taskId === 'string' ? meta.taskId : '';
                const stepId = typeof meta.stepId === 'string' ? meta.stepId : '';
                if (taskId.length === 0 || stepId.length === 0) return;
                const role = typeof event.payload?.role === 'string'
                    ? event.payload.role
                    : '';
                stepRunUpsertStmt.run(taskId, stepId, role, orchClock());
                const agentId = typeof event.payload?.agentId === 'string'
                    ? event.payload.agentId
                    : '';
                if (agentId.length > 0) {
                    liveAgentSummaries.set(agentId, { taskId, stepId, chunks: [] });
                }
            },
            { subscriber: SUBSCRIBER_PROJECTION_TASKS },
        );

        bus.subscribe<Record<string, unknown>>(
            'AgentProgress',
            async (event) => {
                const agentId = typeof event.payload?.agentId === 'string'
                    ? event.payload.agentId
                    : '';
                if (agentId.length === 0) return;
                const accum = liveAgentSummaries.get(agentId);
                if (!accum) return;
                const chunk = typeof event.payload?.chunk === 'string'
                    ? event.payload.chunk
                    : '';
                if (chunk.length > 0) accum.chunks.push(chunk);
            },
            { subscriber: SUBSCRIBER_PROJECTION_TASKS },
        );

        const flushStepRun = (
            payload: Record<string, unknown>,
            status: 'complete' | 'failed',
            fallback?: string,
        ): void => {
            const md = payload.metadata;
            if (!md || typeof md !== 'object') return;
            const meta = md as Record<string, unknown>;
            const taskId = typeof meta.taskId === 'string' ? meta.taskId : '';
            const stepId = typeof meta.stepId === 'string' ? meta.stepId : '';
            if (taskId.length === 0 || stepId.length === 0) return;
            const agentId = typeof payload.agentId === 'string' ? payload.agentId : '';
            const accum = agentId.length > 0
                ? liveAgentSummaries.get(agentId)
                : undefined;
            // Direct concatenation: with --include-partial-messages each
            // chunk is a tiny text DELTA, so any separator lands mid-word
            // (field case: "I\n\n'll start by reading TASK.md" in the step
            // summary). The deltas already carry the model's own newlines;
            // joining with '' reproduces the message text verbatim.
            const summary = accum && accum.chunks.length > 0
                ? accum.chunks.join('')
                : (fallback ?? null);
            stepRunFinishStmt.run(status, orchClock(), summary, taskId, stepId);
            if (agentId.length > 0) liveAgentSummaries.delete(agentId);
        };

        bus.subscribe<Record<string, unknown>>(
            'AgentFinished',
            async (event) => flushStepRun(event.payload ?? {}, 'complete'),
            { subscriber: SUBSCRIBER_PROJECTION_TASKS },
        );

        // Post-commit hook: when the committer agent finishes a task,
        // push the feature branch and open a PR. The hook short-
        // circuits when there's no worktree for the task (e.g. a flow
        // that didn't go through resolveTaskRepoSpec). Errors land in
        // the worker log without throwing — the bus offset must still
        // advance or the projection would re-fire on every restart.
        const taskTitleStmt = db.prepare(
            'SELECT title, description FROM tasks WHERE id = ?',
        );
        bus.subscribe<Record<string, unknown>>(
            'AgentFinished',
            async (event) => {
                const md = event.payload?.metadata;
                if (!md || typeof md !== 'object') return;
                const meta = md as Record<string, unknown>;
                if (meta.stepId !== 'commit') return;
                const taskId = typeof meta.taskId === 'string' ? meta.taskId : '';
                if (taskId.length === 0) return;
                if (!this.taskWorktreeStore) return;
                const taskRow = taskTitleStmt.get(taskId) as
                    | { title: string | null; description: string | null }
                    | undefined;
                await runPostCommitHook({
                    store: this.taskWorktreeStore,
                    logger: this.logger,
                    taskId,
                    title: taskRow?.title ?? '',
                    description: taskRow?.description ?? null,
                    bus: this.bus!,
                    clock: this.clock,
                    githubEnv: this.githubEnvForTaskFn?.(taskId) ?? {},
                });
            },
            { subscriber: SUBSCRIBER_PROJECTION_TASKS },
        );

        // merge-auto: the engine parked the task wait-merged and asked for
        // an automatic merge. The PR is opened by the post-commit hook in
        // a SEPARATE subscriber (above) that races this one, so we poll
        // the worktree store until the PR number lands before dispatching
        // MergeTaskPr. Fire-and-forget: the poll must not block the bus
        // offset (a 2-minute await here would stall every later event).
        // If no PR ever appears the task simply STAYS parked wait-merged —
        // the operator can merge manually from the board/Telegram, and the
        // give-up is logged (never silent).
        bus.subscribe<{ readonly taskId?: string }>(
            'AutoMergeRequested',
            async (event) => {
                const taskId = event.payload?.taskId;
                if (typeof taskId !== 'string' || taskId.length === 0) return;
                void this.mergeWhenPrReady(taskId);
            },
            { subscriber: 'auto-merge' },
        );

        bus.subscribe<Record<string, unknown>>(
            'AgentFailed',
            async (event) => {
                const stderrTail = typeof event.payload?.stderrTail === 'string'
                    ? event.payload.stderrTail
                    : '';
                flushStepRun(
                    event.payload ?? {},
                    'failed',
                    stderrTail.length > 0 ? stderrTail : 'agent failed',
                );
                // Auth-shaped failure? Promote to a worker-level event: an
                // expired token kills EVERY subsequent spawn, so the board
                // shows one red banner instead of the operator having to
                // infer the pattern from scattered per-task failures. The
                // classifier is deliberately conservative (see
                // adapters/claude-cli/auth-status.ts).
                const authLabel = classifyAuthFailure(stderrTail);
                if (authLabel !== null) {
                    const agentId = typeof event.payload?.agentId === 'string'
                        ? event.payload.agentId
                        : '';
                    this.logger.error('agent-auth: auth-shaped agent failure detected', {
                        agentId,
                        label: authLabel,
                    });
                    try {
                        await bus.publish({
                            type: 'AgentAuthError',
                            v: 1,
                            occurredAt: this.clock(),
                            idempotencyKey: `AgentAuthError:${agentId}:${event.seq}`,
                            payload: { label: authLabel, agentId },
                        });
                    } catch (err) {
                        this.logger.warn('agent-auth: failed to publish AgentAuthError', {
                            error: err instanceof Error ? err.message : String(err),
                        });
                    }
                }
            },
            { subscriber: SUBSCRIBER_PROJECTION_TASKS },
        );

        // Park / resume — persist `parked_reason` so the board can
        // recover the parked state across a reload. Without this, an
        // approval-parked task would re-hydrate with no parkedReason
        // and the card would render the template's Approve/Skip
        // (which sends ApproveTask, a no-op when flow_state exists)
        // instead of renderApprovalControls' Approve/Reject (which
        // sends the correct ResumeTask). The statement was hoisted
        // above so the TaskFinished subscriber can reuse it.
        bus.subscribe<Record<string, unknown>>(
            'TaskParked',
            async (event) => {
                const taskId = event.payload?.taskId;
                const reason = event.payload?.reason;
                if (typeof taskId !== 'string' || taskId.length === 0) return;
                if (typeof reason !== 'string' || reason.length === 0) return;
                const question = typeof event.payload?.question === 'string'
                    && event.payload.question.length > 0
                    ? event.payload.question
                    : null;
                if (reason === 'clarification') {
                    updateParkedKeepChoicesStmt.run(reason, question, taskId);
                } else {
                    updateParkedStmt.run(reason, question, taskId);
                }
            },
            { subscriber: SUBSCRIBER_PROJECTION_TASKS },
        );
        bus.subscribe<Record<string, unknown>>(
            'TaskResumed',
            async (event) => {
                const taskId = event.payload?.taskId;
                if (typeof taskId !== 'string' || taskId.length === 0) return;
                updateParkedStmt.run(null, null, taskId);
            },
            { subscriber: SUBSCRIBER_PROJECTION_TASKS },
        );
        // AgentRunOrphaned — a run the previous worker process left
        // mid-flight. Resolve the step row off `running` so the chip
        // stops spinning and carries the explanation, then park the
        // task when it is the operator's to deal with: a task left
        // with no park AND a stale flow_state offers neither Resume
        // nor a working start, which is the L-MIBO-010 shape.
        bus.subscribe<Record<string, unknown>>(
            'AgentRunOrphaned',
            async (event) => {
                const taskId = event.payload?.taskId;
                const stepId = event.payload?.stepId;
                const note = event.payload?.note;
                if (typeof taskId !== 'string' || taskId.length === 0) return;
                if (typeof stepId !== 'string' || stepId.length === 0) return;
                const text = typeof note === 'string' ? note : 'run lost to a worker restart';
                stepRunFinishStmt.run('failed', this.clock(), text, taskId, stepId);
                if (event.payload?.park !== true) return;
                // `wait-action` is the established reason for an
                // interrupted run (see clearsDependencyPark), so the
                // board already labels and renders it, and the engine
                // resolves the resume target from flow_state - which
                // re-dispatches this very step.
                await bus.publish({
                    type: 'TaskParked',
                    v: 1,
                    occurredAt: this.clock(),
                    idempotencyKey:
                        `orphaned-run-park:${taskId}:${stepId}:${event.occurredAt}`,
                    payload: {
                        taskId,
                        reason: 'wait-action',
                        stepId,
                        question: text,
                    },
                });
            },
            { subscriber: SUBSCRIBER_PROJECTION_TASKS },
        );
        // TaskMergeEnqueued — the merge is queued with GitHub, or the
        // pipeline has given up waiting for it. The task's park stays
        // `wait-merged` (every behaviour keyed off that reason, the
        // manual Merge PR button included, must keep working), so only
        // the QUESTION is rewritten: it is the durable, reload-surviving
        // place an explanation of a park already renders.
        const updateParkedQuestionStmt = db.prepare(
            'UPDATE tasks SET parked_question = ? WHERE id = ?',
        );
        bus.subscribe<Record<string, unknown>>(
            'TaskMergeEnqueued',
            async (event) => {
                const taskId = event.payload?.taskId;
                const note = event.payload?.note;
                if (typeof taskId !== 'string' || taskId.length === 0) return;
                if (typeof note !== 'string' || note.length === 0) return;
                updateParkedQuestionStmt.run(note, taskId);
            },
            { subscriber: SUBSCRIBER_PROJECTION_TASKS },
        );
        bus.subscribe<Record<string, unknown>>(
            'ClarificationRequested',
            async (event) => {
                const taskId = event.payload?.taskId;
                if (typeof taskId !== 'string' || taskId.length === 0) return;
                const choices = Array.isArray(event.payload?.choices)
                    ? (event.payload.choices as unknown[]).filter(
                        (c): c is string => typeof c === 'string',
                    )
                    : [];
                updateParkedChoicesStmt.run(
                    choices.length > 0 ? JSON.stringify(choices) : null,
                    taskId,
                );
            },
            { subscriber: SUBSCRIBER_PROJECTION_TASKS },
        );
        // TaskRetried also clears parked_reason — the retry path
        // re-parks via startStep, so the in-flight `parked_reason='approval'`
        // would otherwise still be there from the previous run until
        // the new TaskParked lands.
        bus.subscribe<Record<string, unknown>>(
            'TaskRetried',
            async (event) => {
                const taskId = event.payload?.taskId;
                if (typeof taskId !== 'string' || taskId.length === 0) return;
                updateParkedStmt.run(null, null, taskId);
            },
            { subscriber: SUBSCRIBER_PROJECTION_TASKS },
        );

        this.subscriberNames.push(SUBSCRIBER_PROJECTION_TASKS);
    }

    private attachEngineBridges(): void {
        this.attachTaskCreatedBridge();
        this.attachTaskApprovedBridge();
        this.attachAgentFinishedBridge();
        this.attachAgentFailedBridge();
        this.attachTaskOutputHarvest();
    }

    /**
     * Harvest a task's produced files after every agent run.
     *
     * Field report: "I had a task create output, once a document and once
     * a csv file with results after checking ... I'd like the output to be
     * downloadable from the task once it finished." The files existed on
     * the worker's disk and the only trace of them was a path quoted in
     * the agent's report prose - nothing the operator could click.
     *
     * Hooked on the agent run rather than on TaskFinished for two
     * reasons. A `document` task's deliverable is written by the
     * doc-writer and only committed several steps later, so at
     * TaskFinished the worktree may already be gone; and a run whose
     * output the reviewer rejects still produced files worth reading. The
     * raw runner event is the one with `agentId`, which is how the task is
     * resolved - the bridged `agent.finished` carries no agentId and falls
     * out of the lookup.
     *
     * Idempotent by content: the key is (task, path, sha256), so the same
     * file found again by the next step's harvest de-dups at the event
     * store while a REWRITTEN file lands as the new version it is.
     */
    private attachTaskOutputHarvest(): void {
        const bus = this.bus!;
        bus.subscribe<{ readonly agentId?: string }>(
            'AgentFinished',
            async (event) => {
                const agentId = event.payload?.agentId;
                if (typeof agentId !== 'string' || agentId.length === 0) return;
                const taskId = this.agentToTask.get(agentId);
                if (!taskId) return;
                await this.harvestTaskOutputs(taskId);
            },
            { subscriber: SUBSCRIBER_TASK_OUTPUT_HARVEST },
        );
        this.subscriberNames.push(SUBSCRIBER_TASK_OUTPUT_HARVEST);
    }

    /**
     * Copy everything in `<workspaceRoot>/task-output/<taskId>/` into the
     * attachment store as `kind: 'output'` attachments on the task.
     *
     * Best-effort per file: one unreadable file does not cost the others.
     * Nothing is silent - a file the harvest refuses (too large, empty,
     * past the count cap) is logged by name with the reason, because a
     * deliverable that disappeared without a word is the failure this
     * whole path exists to prevent.
     */
    private async harvestTaskOutputs(taskId: string): Promise<void> {
        const blobStore = this.attachmentBlobStore;
        const commandBus = this.commandBus;
        if (!blobStore || !commandBus) return;
        const dir = taskOutputDir(DEFAULT_TASK_OUTPUTS_ROOT, taskId);
        let collected;
        try {
            collected = collectTaskOutputs(dir);
        } catch (err) {
            this.logger.warn('task-outputs: collect failed', {
                taskId,
                dir,
                error: err instanceof Error ? err.message : String(err),
            });
            return;
        }
        if (collected.skipped.length > 0) {
            this.logger.warn('task-outputs: files left behind', {
                taskId,
                dir,
                skipped: describeSkippedOutputs(collected.skipped),
            });
        }
        if (collected.files.length === 0) return;

        let recorded = 0;
        for (const file of collected.files) {
            try {
                const bytes = await fsPromises.readFile(file.absPath);
                const idempotencyKey = outputIdempotencyKey(
                    taskId,
                    file.relPath,
                    bytes,
                );
                // The attachment id is derived from the same key, so a
                // re-harvest of an unchanged file reuses the id and the
                // projection's INSERT OR REPLACE is a no-op rather than a
                // second card for one file.
                const attachmentId = `out-${crypto
                    .createHash('sha1')
                    .update(idempotencyKey)
                    .digest('hex')
                    .slice(0, 24)}`;
                if (this.attachmentStore?.get(attachmentId)) continue;
                const storageKey = await blobStore.put(attachmentId, bytes);
                await commandBus.send({
                    type: AttachmentCommands.ATTACH_TO_TASK,
                    actor: 'orchestrator',
                    issuedAt: this.clock(),
                    payload: {
                        attachmentId,
                        ownerId: taskId,
                        // The relative path, so a file in a subfolder is
                        // not confused with a same-named sibling; the
                        // download name stays the basename.
                        fileName: file.relPath,
                        contentType: file.contentType,
                        sizeBytes: file.sizeBytes,
                        storageKey,
                        caption: 'Produced by this task',
                        kind: 'output',
                    },
                });
                recorded += 1;
            } catch (err) {
                this.logger.warn('task-outputs: failed to record a file', {
                    taskId,
                    file: file.relPath,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        }
        if (recorded > 0) {
            this.logger.info('task-outputs: harvested', {
                taskId,
                dir,
                files: recorded,
            });
        }
    }

    /**
     * TaskCreated -> task.created. Mirrors {@link attachTaskApprovedBridge}:
     * the host emits PascalCase domain events on the bus, the FlowEngine
     * subscribes to the dotted lowercase vocabulary, and this bridge
     * translates between the two. Without it, flows declared with
     * `start_mode: auto` never reach `FlowEngine.onTaskCreated` and the
     * first step is never dispatched — the `echo` parity round-trip
     * surfaces this as a missing `TaskFinished` event in the trail.
     */
    private attachTaskCreatedBridge(): void {
        const bus = this.bus!;
        // Broaden the payload type: the decomposer-projected TaskCreated
        // carries `dependencies: string[]` (see ProjectedTaskCreatedPayload
        // in adapters/projections/task-projection-store.ts) which the
        // orchestrator-domain `TaskCreatedPayload` doesn't declare.
        // Reading it here lets the gate decide forward-or-park without
        // a second DB read.
        bus.subscribe<TaskCreatedPayload & { readonly dependencies?: readonly string[] }>(
            Events.TASK_CREATED,
            async (event) => {
                const { taskId, flowId } = event.payload;
                const deps = Array.isArray(event.payload.dependencies)
                    ? event.payload.dependencies
                    : [];

                // AP-IFW-006 Phase 1: persist the decomposer-declared
                // dependency edges so the unblock-on-TaskFinished pass
                // and the UI both have something to read. Edges whose
                // upstream is already terminal are inserted directly as
                // 'merged' so the gate below treats them as satisfied
                // (covers task-added-after-upstream-finished cases like
                // re-decomposes that append a new task referencing one
                // that completed in the previous revision).
                const store = this.taskDependencyStore;
                if (store) {
                    // Clear unconditionally so a re-decompose that drops
                    // a dependency removes the stale edge — the
                    // projection subscriber's reset path doesn't touch
                    // task_deps, so this is the only place edges get
                    // reset to match the fresh decomposer output.
                    store.clearDependencies(taskId);
                    for (const depId of deps) {
                        const upstreamStatus = store.taskStatusFor(depId);
                        const status = upstreamStatus === 'done' ? 'merged' : 'pending';
                        store.addDependency(taskId, depId, status);
                    }
                }

                if (store && store.hasUnmetDeps(taskId)) {
                    store.parkTask(taskId, 'waiting-deps');
                    this.logger.info(
                        'orchestrator: task parked on unmet dependencies',
                        { taskId, deps: deps.slice() },
                    );
                    // Publish TaskParked so the board folds `waiting-deps`
                    // into its LIVE model immediately. Without this the
                    // parkTask DB write was invisible to the open board —
                    // the projected TaskCreated only carries status
                    // 'created' (filtered out of the active Tasks list), so
                    // a deps-gated task vanished until a refresh re-read it
                    // from /api/tasks. Keyed on the source event's
                    // occurredAt so a replay re-uses the same key (deduped)
                    // while a genuine re-decompose (new TaskCreated) re-emits.
                    await bus.publish({
                        type: 'TaskParked',
                        v: 1,
                        occurredAt: this.clock(),
                        idempotencyKey: `waiting-deps-park:${taskId}:${event.occurredAt}`,
                        payload: { taskId, reason: 'waiting-deps', stepId: '' },
                    });
                    // Do NOT forward to the engine. The
                    // unblock-on-TaskFinished pass below will re-publish
                    // `task.created` once every upstream merges, at
                    // which point flow_state still doesn't exist and the
                    // engine starts the first step exactly as if the
                    // task had just been created.
                    return;
                }
                const bridged: Event = {
                    type: FlowEvents.TASK_CREATED,
                    v: 1,
                    occurredAt: this.clock(),
                    idempotencyKey: `bridge:${FlowEvents.TASK_CREATED}:${taskId}`,
                    payload: { taskId, flowId },
                };
                await bus.publish(bridged);
            },
            { subscriber: SUBSCRIBER_BRIDGE_TASK_CREATED },
        );
        this.subscriberNames.push(SUBSCRIBER_BRIDGE_TASK_CREATED);
    }

    private attachTaskApprovedBridge(): void {
        const bus = this.bus!;
        bus.subscribe<TaskApprovedPayload>(
            Events.TASK_APPROVED,
            async (event) => {
                const { taskId, flowId } = event.payload;
                // AP-IFW-006 Phase 1 — dependency gate at the
                // TaskApproved bridge too. The TaskCreated bridge
                // catches the auto-cascade case (operator approved a
                // plan and TaskCreated for every task fires while
                // some still have unmet deps), but a task that's
                // already parked on `waiting-deps` and the operator
                // *clicks* Approve on it bypasses the TaskCreated
                // gate entirely — TaskApproved goes straight to the
                // engine and the first step fires while the upstream
                // is still in flight. Re-check here so an explicit
                // approval click on a deps-parked task is held until
                // the upstreams merge. The unblock pass on
                // TaskFinished re-fires `task.created` (not
                // TaskApproved) so this gate also stays correct on
                // re-approval after unblock — the engine starts the
                // first step via the TaskCreated path and the
                // approval gate inside startStep re-prompts the
                // operator if `approval: required`.
                const store = this.taskDependencyStore;
                if (store) {
                    // Always log the deps snapshot at gate time so we
                    // can spot cases where a downstream task slipped
                    // past the block because its inbound edge was
                    // flipped to 'merged' on a prior upstream run (e.g.
                    // an upstream that completed once, was Restarted,
                    // but never re-blocked its dependents).
                    const currentDeps = store.listDependencies(taskId);
                    this.logger.info(
                        'orchestrator: TaskApproved gate — dependency snapshot',
                        {
                            taskId,
                            edgeCount: currentDeps.length,
                            edges: currentDeps.map((d) => ({
                                upstream: d.dependsOnTaskId,
                                status: d.status,
                            })),
                        },
                    );
                }
                if (store && store.hasUnmetDeps(taskId)) {
                    // Still waiting on deps — re-park and do NOT forward.
                    // (Pre-approval is a separate, explicit operator
                    // action via the PreApproveTask command — this
                    // auto-cascade TaskApproved must not pre-approve every
                    // dependency-gated task.)
                    store.parkTask(taskId, 'waiting-deps');
                    this.logger.info(
                        'orchestrator: TaskApproved blocked on unmet dependencies',
                        { taskId },
                    );
                    // Surface the park live (same reason as the TaskCreated
                    // gate above) so the board doesn't need a refresh.
                    await bus.publish({
                        type: 'TaskParked',
                        v: 1,
                        occurredAt: this.clock(),
                        idempotencyKey: `waiting-deps-park:approved:${taskId}:${event.occurredAt}`,
                        payload: { taskId, reason: 'waiting-deps', stepId: '' },
                    });
                    return;
                }
                // The source event's SEQ is part of the key - unique per stored
                // event, where two clicks can share a millisecond.
                //
                // A per-entity key here silently swallowed every
                // RE-approval: the store dedups to the original row and
                // returns its OLD seq, the bus still dispatches, and the
                // engine's `alreadyApplied(taskId, seq)` then discards it
                // because flow_state has long since advanced past that
                // seq. So the second Approve produced no event, no log,
                // and no work - the exact footgun the ApproveTask
                // handler already guards against by putting `issuedAt` in
                // its own key, undone one layer later.
                const bridged: Event = {
                    type: FlowEvents.TASK_APPROVED,
                    v: 1,
                    occurredAt: this.clock(),
                    idempotencyKey:
                        `bridge:${FlowEvents.TASK_APPROVED}:${taskId}:${event.seq}`,
                    payload: { taskId, flowId },
                };
                await bus.publish(bridged);
            },
            { subscriber: SUBSCRIBER_BRIDGE_TASK_APPROVED },
        );
        this.subscriberNames.push(SUBSCRIBER_BRIDGE_TASK_APPROVED);
    }

    /**
     * AgentFinished -> agent.finished. The in-memory agent→task mapping is
     * intentionally not rehydrated on restart: the engine has already
     * processed the original `agent.finished` from the prior session via
     * the persisted event log, so a missing mapping is a safe no-op.
     */
    private attachAgentFinishedBridge(): void {
        const bus = this.bus!;
        const db = this.db!;
        // Look up the joined assistant text from the per-step summary
        // row — by the time the bridge fires, the projection-tasks
        // AgentFinished subscriber (registered earlier in
        // attachProjections) has already flushed the accumulated
        // `AgentProgress.chunk` text into this column.
        const stepSummaryReadStmt = db.prepare(
            `SELECT summary FROM task_step_summaries
              WHERE task_id = ? AND step_id = ?`,
        );
        // The projection-tasks subscriber for AgentFinished (registered
        // earlier in attachProjections) already wrote `status='complete'`
        // before this bridge runs. When the bridge later reclassifies
        // the run as a failure (CHANGES REQUIRED / TESTS FAILED / API
        // Error), overwrite the row so the chip flips green → red. Same
        // statement shape as the projection's terminal write so the row
        // schema stays consistent.
        const stepSummaryRevertToFailedStmt = db.prepare(
            `UPDATE task_step_summaries
                SET status = 'failed', finished_at = ?
              WHERE task_id = ? AND step_id = ?`,
        );
        bus.subscribe<{
            readonly agentId: string;
            readonly role?: string;
            readonly outcome?: string;
            readonly metadata?: Record<string, unknown>;
        }>(
            'AgentFinished',
            async (event) => {
                const taskId = this.agentToTask.get(event.payload.agentId);
                if (!taskId) return;

                // Interrupt short-circuit: the runner publishes
                // `AgentFinished{ outcome: 'interrupted' }` when the
                // agent process was killed via CancelAgentRun (the
                // SIGTERM/taskkill path in ClaudeCliRunner.publishClose
                // for `ctx.run.killed`). Without this guard the bridge
                // forwarded that event as `agent.finished` and the
                // engine happily followed `on_success`, so stopping the
                // developer kicked off the reviewer, stopping the
                // reviewer kicked off the tester, and so on — the task
                // only paused once it ran out of stages.
                //
                // Treat an interrupted outcome as a failure: park the
                // task with reason 'wait-action' so the operator's Stop
                // click registers immediately and the next step does
                // NOT dispatch. The operator can then click Restart
                // (which clears flow_state + worktree and re-runs from
                // the top) or Dismiss.
                if (event.payload.outcome === 'interrupted') {
                    this.logger.info(
                        'orchestrator: AgentFinished outcome=interrupted — parking task instead of advancing',
                        { taskId, agentId: event.payload.agentId },
                    );
                    // The projection-tasks subscriber ran BEFORE this bridge
                    // and wrote the step 'complete' off the runner's clean
                    // exit — so a stopped agent left a GREEN chip and a
                    // stub summary ("I'll start by reading the task file")
                    // for work that never happened (field case:
                    // L-MIBO-010). Flip it back, same as the
                    // semantic-failure path below.
                    const interruptedStepId = typeof event.payload.metadata === 'object'
                        && event.payload.metadata !== null
                        && typeof (event.payload.metadata as Record<string, unknown>).stepId === 'string'
                        ? (event.payload.metadata as Record<string, string>).stepId
                        : null;
                    if (interruptedStepId) {
                        stepSummaryRevertToFailedStmt.run(
                            this.clock(),
                            taskId,
                            interruptedStepId,
                        );
                    }
                    await bus.publish({
                        type: 'TaskParked',
                        v: 1,
                        occurredAt: this.clock(),
                        idempotencyKey:
                            `interrupt-park:${event.payload.agentId}`,
                        payload: {
                            taskId,
                            reason: 'wait-action',
                            stepId: typeof event.payload.metadata === 'object'
                                && event.payload.metadata !== null
                                && typeof (event.payload.metadata as Record<string, unknown>).stepId === 'string'
                                ? (event.payload.metadata as Record<string, unknown>).stepId as string
                                : '',
                        },
                    });
                    return;
                }

                // Clarification short-circuit: if the agent's final
                // output contained a `NEEDS_HUMAN_INPUT` block, the
                // step must NOT advance to on_success. Park the task
                // with reason='clarification' instead so the operator
                // sees a yellow chip + the clarify modal. Without this
                // guard the tester (or any agent) could ask a question
                // and the flow would happily march on to commit,
                // ignoring the question entirely — which is exactly the
                // bug the operator just hit.
                const md = event.payload.metadata;
                const stepId = md && typeof md === 'object'
                    && typeof (md as Record<string, unknown>).stepId === 'string'
                    ? ((md as Record<string, unknown>).stepId as string)
                    : '';
                const role = typeof event.payload.role === 'string'
                    ? event.payload.role
                    : '';
                if (stepId.length > 0) {
                    const row = stepSummaryReadStmt.get(taskId, stepId) as
                        | { summary: string | null }
                        | undefined;
                    const text = row?.summary ?? '';
                    if (text.length > 0) {
                        const clarification = parseClarification(text);
                        if (clarification) {
                            this.logger.info(
                                'orchestrator: AgentFinished carries NEEDS_HUMAN_INPUT — parking instead of advancing',
                                {
                                    taskId, stepId,
                                    question: clarification.question.slice(0, 200),
                                    optionCount: clarification.options.length,
                                },
                            );
                            // ClarificationRequested first so the
                            // board's choice store is populated before
                            // TaskParked lands and the modal opens.
                            await bus.publish({
                                type: 'ClarificationRequested',
                                v: 1,
                                occurredAt: this.clock(),
                                idempotencyKey:
                                    `clarify:${event.payload.agentId}`,
                                payload: {
                                    taskId,
                                    question: clarification.question,
                                    choices: clarification.options.map((o) => o.label),
                                    raw: clarification.raw,
                                },
                            });
                            // Bridge to the engine's question handler
                            // — onAgentQuestion publishes TaskParked
                            // (reason='clarification') so the board's
                            // existing reducers + the yellow-chip path
                            // light up.
                            await bus.publish({
                                type: FlowEvents.AGENT_QUESTION,
                                v: 1,
                                occurredAt: this.clock(),
                                idempotencyKey:
                                    `bridge:${FlowEvents.AGENT_QUESTION}:${event.payload.agentId}`,
                                payload: {
                                    taskId,
                                    question: clarification.question,
                                },
                            });
                            // Skip the AGENT_FINISHED publish so the
                            // flow doesn't advance to the next step.
                            return;
                        }

                        // Outcome short-circuit: the runner reports
                        // every clean claude-cli exit as AgentFinished
                        // — including reviewer rejections ("CHANGES
                        // REQUIRED:") and tester failures ("TESTS
                        // FAILED:"). Parse the role-specific marker so
                        // those land as AGENT_FAILED instead of
                        // marching the flow onto the next step.
                        // Empty/error-only outputs (e.g. "API Error:
                        // 529 Overloaded" leftover from a crashed
                        // run) also map to failure so a stalled agent
                        // doesn't get treated as success.
                        const verdict = parseAgentOutcomeDetailed(
                            role,
                            text,
                            this.outcomeMarkers(),
                        );
                        if (verdict.outcome === 'failure') {
                            this.logger.info(
                                'orchestrator: AgentFinished output indicates failure — bridging as AGENT_FAILED',
                                { taskId, stepId, role, summaryHead: text.slice(0, 200) },
                            );
                            // Flip the chip green → red. The
                            // projection-tasks subscriber that ran
                            // before this bridge wrote 'complete'
                            // based on the runner's clean exit; the
                            // semantic outcome we just parsed says
                            // otherwise.
                            stepSummaryRevertToFailedStmt.run(this.clock(), taskId, stepId);
                            await bus.publish({
                                type: FlowEvents.AGENT_FAILED,
                                v: 1,
                                occurredAt: this.clock(),
                                idempotencyKey:
                                    `bridge:${FlowEvents.AGENT_FAILED}:${event.payload.agentId}`,
                                payload: {
                                    taskId,
                                    stepId,
                                    // Carry the agent's own verdict line so the
                                    // board shows the evidence ("STALE: app still
                                    // on build 41") instead of a bare "failed".
                                    reason: verdict.sentinel
                                        ? `${role || 'agent'}: ${verdict.sentinel.slice(0, 300)}`
                                        : `${role || 'agent'} output indicates failure`
                                            + ' (no verdict sentinel found)',
                                },
                            });
                            return;
                        }

                        // Commit step with nothing to commit. A dependent
                        // task whose work was already landed by the task
                        // it depended on produces an empty worktree — the
                        // committer reports "NO CHANGES TO COMMIT". There
                        // is no commit, no push, and no PR to open, so
                        // advancing to the `wait-merged` step would park
                        // the task forever waiting on a PR that never
                        // exists (the operator's reported symptom).
                        // Complete the task instead of advancing.
                        if (
                            stepId === 'commit'
                            && /no\s+changes\s+to\s+commit/i.test(text)
                        ) {
                            this.logger.info(
                                'orchestrator: committer reported no changes — completing task instead of advancing to merge',
                                { taskId, stepId },
                            );
                            await bus.publish({
                                type: 'TaskFinished',
                                v: 1,
                                occurredAt: this.clock(),
                                idempotencyKey:
                                    `no-changes-finish:${event.payload.agentId}`,
                                payload: { taskId },
                            });
                            return;
                        }
                    }
                }

                const bridged: Event = {
                    type: FlowEvents.AGENT_FINISHED,
                    v: 1,
                    occurredAt: this.clock(),
                    idempotencyKey: `bridge:${FlowEvents.AGENT_FINISHED}:${event.payload.agentId}`,
                    payload: { taskId },
                };
                await bus.publish(bridged);
            },
            { subscriber: SUBSCRIBER_BRIDGE_AGENT_FINISHED },
        );
        this.subscriberNames.push(SUBSCRIBER_BRIDGE_AGENT_FINISHED);
    }

    /**
     * AgentFailed -> FlowEvents.AGENT_FAILED. Mirrors
     * {@link attachAgentFinishedBridge} but on the failure path: the
     * runner publishes `AgentFailed{ agentId, role, exitCode, stderrTail, metadata }`
     * with no taskId at the payload root, so the bridge looks the taskId
     * up via `agentToTask[agentId]` exactly like the success bridge. The
     * engine's `onAgentFailed` then routes the step through `on_failure`
     * (or emits `TaskFailed`) so the flow doesn't stall waiting for an
     * AgentFinished that will never come.
     *
     * Without this, an agent crash leaves the task parked on `develop`
     * until the operator clicks Retry — the engine never observes the
     * failure on its own bus.
     */
    private attachAgentFailedBridge(): void {
        const bus = this.bus!;
        bus.subscribe<{
            readonly agentId: string;
            readonly stderrTail?: string;
            readonly exitCode?: number;
        }>(
            'AgentFailed',
            async (event) => {
                const taskId = this.agentToTask.get(event.payload.agentId);
                if (!taskId) return;
                const reason = typeof event.payload.stderrTail === 'string'
                        && event.payload.stderrTail.length > 0
                    ? event.payload.stderrTail
                    : typeof event.payload.exitCode === 'number'
                        ? `exit code ${event.payload.exitCode}`
                        : 'agent failed';
                const bridged: Event = {
                    type: FlowEvents.AGENT_FAILED,
                    v: 1,
                    occurredAt: this.clock(),
                    idempotencyKey: `bridge:${FlowEvents.AGENT_FAILED}:${event.payload.agentId}`,
                    payload: { taskId, reason },
                };
                await bus.publish(bridged);
            },
            { subscriber: SUBSCRIBER_BRIDGE_AGENT_FAILED },
        );
        this.subscriberNames.push(SUBSCRIBER_BRIDGE_AGENT_FAILED);
    }

    /**
     * Resolve `issue_tracker` and `issue_tracker_shadow` from pipeline.yaml,
     * validating both. Failing validation throws `PipelineConfigError` so
     * an invalid value aborts boot before any subscriber is wired. Also
     * resolves the primary `IssueTracker` adapter (default per kind: Linear
     * stays with the injected/Fake tracker so today's behaviour is
     * preserved; Jira boots a real `JiraTracker` from env credentials so
     * the routing change is observable end-to-end).
     */
    private resolveTrackerRouting(): void {
        const cfg = this.loadPipelineConfig();
        this.issueTrackerKind = cfg.issue_tracker;
        this.issueTrackerShadow = cfg.issue_tracker_shadow;

        // Promote the primary slot to a JiraTracker if the YAML asked for
        // Jira and the caller did not inject an explicit primary. Linear
        // mode keeps the existing default (Fake unless the test injected
        // its own) — AC #4 requires "no regression" against today.
        if (this.issueTrackerKind === 'jira' && !this.issueTrackerInjected) {
            this.issueTracker = new JiraTracker({ client: createJiraClient() });
        }
    }

    /**
     * Register the primary `IssueTracker` lifecycle subscriber.
     *
     *   PlanApproved   → tracker.createProject + record external_refs row
     *   TaskCreated    → tracker.createIssue   + record external_refs row
     *   TaskFinished   → tracker.closeIssue
     *   TaskSkipped    → tracker.skipIssue
     *
     * One subscriber regardless of which adapter is configured — the
     * routing decision lives in `issueTrackerKind`, not in the subscriber
     * topology. Failures are caught at the handler boundary and logged;
     * they do NOT republish onto the bus (which would let a transient
     * tracker outage cascade into the event log).
     */
    private attachPrimaryIssueTrackerSubscriber(): void {
        const system = this.issueTrackerKind;
        const externalRefs = this.buildExternalRefs(system);
        const bus = this.bus!;
        const subscriber = ISSUE_TRACKER_PRIMARY_SUBSCRIBER;

        bus.subscribe<{
            readonly planId: string;
            readonly projectId?: string;
            readonly name?: string;
            readonly description?: string;
        }>(
            'PlanApproved',
            async (event) => {
                const { planId, name, description } = event.payload;
                if (externalRefs.read(planId)) return;
                try {
                    const ref = await this.issueTracker.createProject({
                        name: name ?? `Plan ${planId}`,
                        description,
                        key: planId,
                    });
                    externalRefs.write(planId, ref.id);
                } catch (err) {
                    this.logger.error('issue-tracker-primary: createProject failed', {
                        system,
                        planId,
                        error: err instanceof Error ? err.message : String(err),
                    });
                }
            },
            { subscriber },
        );

        bus.subscribe<{
            readonly taskId: string;
            readonly planId: string;
            readonly title?: string;
            readonly description?: string;
            readonly labels?: ReadonlyArray<string>;
        }>(
            'TaskCreated',
            async (event) => {
                const { taskId, planId } = event.payload;
                if (externalRefs.read(taskId)) return;
                const projectId = externalRefs.read(planId);
                if (!projectId) {
                    this.logger.warn('issue-tracker-primary: no project mapped for plan', {
                        system,
                        planId,
                        taskId,
                    });
                    return;
                }
                try {
                    const ref = await this.issueTracker.createIssue({
                        title: event.payload.title ?? `Task ${taskId}`,
                        description: event.payload.description,
                        projectId,
                        labels: event.payload.labels,
                    });
                    externalRefs.write(taskId, ref.id);
                } catch (err) {
                    this.logger.error('issue-tracker-primary: createIssue failed', {
                        system,
                        taskId,
                        error: err instanceof Error ? err.message : String(err),
                    });
                }
            },
            { subscriber },
        );

        bus.subscribe<{
            readonly taskId: string;
            readonly summary?: unknown;
            readonly prUrl?: string;
        }>(
            'TaskFinished',
            async (event) => {
                const { taskId } = event.payload;
                const issueId = externalRefs.read(taskId);
                if (!issueId) return;
                try {
                    await this.issueTracker.closeIssue(issueId, composeFinishedSummary(event.payload));
                } catch (err) {
                    this.logger.error('issue-tracker-primary: closeIssue failed', {
                        system,
                        taskId,
                        error: err instanceof Error ? err.message : String(err),
                    });
                }
            },
            { subscriber },
        );

        bus.subscribe<{
            readonly taskId: string;
            readonly reason?: string;
        }>(
            'TaskSkipped',
            async (event) => {
                const { taskId } = event.payload;
                const issueId = externalRefs.read(taskId);
                if (!issueId) return;
                try {
                    await this.issueTracker.skipIssue(issueId, event.payload.reason ?? 'Skipped');
                } catch (err) {
                    this.logger.error('issue-tracker-primary: skipIssue failed', {
                        system,
                        taskId,
                        error: err instanceof Error ? err.message : String(err),
                    });
                }
            },
            { subscriber },
        );

        this.subscriberNames.push(subscriber);
    }

    /**
     * AP-IFG-020 — register the narrative-comment sink against the
     * Linear-scoped `external_refs` reader. Only mounted when the
     * primary tracker is Linear; Jira-primary deployments don't post
     * Linear-flavoured narrative comments, and Linear-shadow mode is a
     * dry-run channel where comments would be noise.
     *
     * The handler list shares its named subscriber across all seven
     * event types so a host restart replays each unprocessed event
     * exactly once.
     */
    private attachLinearCommentSink(): void {
        if (this.issueTrackerKind !== 'linear') return;
        const externalRefs = this.buildExternalRefs('linear');
        registerLinearCommentSink({
            bus: this.bus!,
            tracker: this.issueTracker,
            externalRefs,
            logger: this.logger,
        });
        this.subscriberNames.push(LINEAR_COMMENT_SINK_SUBSCRIBER);
    }

    /**
     * Conditionally wire the shadow-mode subscriber. The shadow direction
     * is driven by `issue_tracker_shadow`:
     *
     *   issue_tracker_shadow: jira    → existing Jira shadow plumbing
     *                                   (AP-NVP-027) — registered under
     *                                   the `jira-shadow` subscriber name.
     *   issue_tracker_shadow: linear  → same plumbing reused for Linear,
     *                                   registered under `linear-shadow`.
     *   issue_tracker_shadow: none    → no-op.
     *
     * The shadow-diff log keeps emitting on divergence regardless of which
     * direction the shadow runs in (AC #6).
     */
    private attachShadowIssueTrackerSubscriber(): void {
        if (this.issueTrackerShadow === 'none') return;
        const direction = this.issueTrackerShadow;

        const adapters = this.options.adapters ?? {};
        const shadowDiffLog =
            adapters.jiraShadowDiffLog ??
            createFileShadowDiffLog(this.shadowDiffLogPath);

        let tracker: IssueTracker;
        let subscriberName: string;
        let system: 'linear' | 'jira';
        if (direction === 'jira') {
            tracker =
                adapters.jiraIssueTracker ??
                new JiraTracker({ client: createJiraClient() });
            subscriberName = JIRA_SHADOW_SUBSCRIBER;
            system = 'jira';
        } else {
            // direction === 'linear' — the shadow tracker must be injected
            // (no production Linear default for shadow mode). When nothing
            // is supplied the subscriber still registers against a Fake so
            // the offset advances and the diff log captures port calls
            // that happen to flow through.
            tracker = adapters.linearShadowIssueTracker ?? new FakeIssueTracker();
            subscriberName = LINEAR_SHADOW_SUBSCRIBER;
            system = 'linear';
        }

        const externalRefs = this.buildExternalRefs(system);

        registerJiraShadowSubscriber({
            bus: this.bus!,
            tracker,
            externalRefs,
            shadowDiffLog,
            clock: this.clock,
            logger: this.logger,
            subscriberName,
        });
        this.subscriberNames.push(subscriberName);
    }

    /**
     * Wire the daily SQLite snapshot job. Mounted only when
     * `SNAPSHOTS_ENABLED=true` is set in the environment — by default the
     * host runs without snapshots so unit and integration tests do not have
     * to clean up snapshot files.
     */
    private attachSnapshotJob(): void {
        const flag = (process.env.SNAPSHOTS_ENABLED ?? '').trim().toLowerCase();
        if (flag !== 'true') return;
        this.snapshotJob = registerSnapshotJob(this.bus!, this.db!, this.logger);
        this.subscriberNames.push(SNAPSHOT_JOB_SUBSCRIBER);
    }

    /**
     * Wire the cron-driven scheduled task subscriber. Mounted only when
     * `SCHEDULES_ENABLED=true`. Reads `config/schedules.yaml` and registers
     * one cron-tracked entry per row; each fire dispatches `CreateTask`
     * through the command bus, which downstream emits `TaskCreated`.
     *
     * A missing or malformed schedules file is non-fatal — the host logs a
     * warning and proceeds without a scheduler.
     */
    private attachScheduler(): void {
        const flag = (process.env.SCHEDULES_ENABLED ?? '').trim().toLowerCase();
        if (flag !== 'true') return;

        // The profile's schedules.yaml replaces the repo's when present.
        const schedulesPath = resolveConfigFile('schedules.yaml', {
            home: this.profileHome ?? null,
            repoConfigDir: path.dirname(DEFAULT_SCHEDULES_PATH),
        }).path;
        let schedules;
        try {
            schedules = loadSchedules(schedulesPath);
        } catch (err) {
            this.logger.warn('orchestrator: schedules.yaml load failed, scheduler not started', {
                path: schedulesPath,
                error: err instanceof Error ? err.message : String(err),
            });
            return;
        }

        this.schedulerHandle = registerScheduler({
            commandBus: this.commandBus!,
            schedules,
            logger: this.logger,
            clock: this.clock,
        });
        this.logger.info('orchestrator: cron scheduler started', {
            entries: schedules.length,
        });
    }

    /**
     * Wire the per-task git worktree manager into the task lifecycle.
     *
     *   TaskStarted (TaskApproved)   -> manager.create(taskId, branch)
     *   TaskCompleted (TaskFinished) -> manager.remove(taskId)
     *
     * Opt-in: only enabled when an explicit manager is supplied via the
     * `adapters` slot or `WORKTREES_ENABLED=true` is set in the
     * environment. By default the orchestrator boots without touching the
     * filesystem, which keeps the existing in-memory and integration
     * tests free of git worktree side-effects.
     *
     * The recurring `gcStale` tick is registered separately by the Phase 7
     * `worktree-gc-job` subscriber in {@link attachPhase7Subscribers} — the
     * manager handle resolved here is stored on `this.worktreeManager` so
     * the gc-job registration has access to it.
     */
    private attachWorktreeManager(): void {
        const injected = this.options.adapters?.worktreeManager;
        let manager: WorktreeManager | undefined = injected;

        if (!manager) {
            const flag = (process.env.WORKTREES_ENABLED ?? '').trim().toLowerCase();
            if (flag !== 'true') return;
            manager = this.buildDefaultWorktreeManager();
        }

        this.worktreeManager = manager;

        const subs = registerWorktreeSubscribers({
            bus: this.bus!,
            manager,
            logger: this.logger,
        });
        for (const name of subs) this.subscriberNames.push(name);
    }

    /**
     * AP-VP7-008: wire the three Phase 7 subscribers alongside the
     * `snapshot-job` registration. The block runs after
     * {@link attachWorktreeManager} so the gc-job has the resolved
     * `WorktreeManager` handle in hand.
     *
     *   - {@link registerEscalationFileWriter} — writes
     *     `<workspace>/<projectId>/escalations/plan.escalation-<taskId>.md`
     *     when a `TaskFailed{ finalAttempt: true }` event lands.
     *   - {@link registerWorktreeGcJob} — periodically calls
     *     `manager.gcStale()` to prune worktrees whose owning task is
     *     terminal. Only registered when a `WorktreeManager` is wired.
     *   - {@link registerAutoTransitionJob} — translates `PrMerged` and
     *     `InvestigationCompleted` events into `DispatchDeploy` /
     *     `CreatePlan` commands when the plan's `auto_transitions` gate
     *     is enabled. The {@link PlanMetadataStore} defaults to a no-op
     *     when not injected — i.e. missing metadata = `auto_transitions:
     *     false`, matching the adapter's documented default.
     */
    private attachPhase7Subscribers(): void {
        const bus = this.bus!;

        this.escalationFileWriter = registerEscalationFileWriter({
            bus,
            workspace: this.workspace,
            defaultProjectId: this.defaultProjectId,
            logger: this.logger,
        });
        this.subscriberNames.push(ESCALATION_FILE_WRITER_SUBSCRIBER);

        if (this.worktreeManager) {
            this.worktreeGcJob = registerWorktreeGcJob(
                bus,
                this.worktreeManager,
                this.logger,
            );
            this.subscriberNames.push(WORKTREE_GC_JOB_SUBSCRIBER);
        }

        const planStore =
            this.options.adapters?.planMetadataStore ?? this.defaultPlanMetadataStore();
        this.autoTransitionJob = registerAutoTransitionJob({
            bus,
            commandBus: this.commandBus!,
            planStore,
            clock: this.clock,
            logger: this.logger,
        });
        this.subscriberNames.push(AUTO_TRANSITIONS_SUBSCRIBER);
    }

    /**
     * No-op `PlanMetadataStore`. Returns `undefined` for every plan id so
     * the AutoTransitionJob gate evaluates to `auto_transitions: false`
     * and neither command branch fires. The real metadata-backed reader
     * is wired by callers that opt in via `adapters.planMetadataStore`.
     */
    private defaultPlanMetadataStore(): PlanMetadataStore {
        return {
            readMetadata(_planId: string): AutoTransitionPlanMetadata | undefined {
                return undefined;
            },
        };
    }

    private buildDefaultWorktreeManager(): WorktreeManager {
        const cfg = this.loadPipelineConfig();
        const worktreeRoot = cfg.worktree_root
            ? path.isAbsolute(cfg.worktree_root)
                ? cfg.worktree_root
                : path.join(REPO_ROOT, cfg.worktree_root)
            : DEFAULT_WORKTREE_ROOT;

        const db = this.db!;
        const taskStore: TaskStateLookup = {
            isTerminal: (taskId: string): boolean => isTaskTerminalForGc(db, taskId),
        };

        return new WorktreeManager({
            repoRoot: REPO_ROOT,
            worktreeRoot,
            taskStore,
            logger: this.logger,
        });
    }

    /**
     * Read+write surface over `external_refs` rows scoped to a single
     * external system. Same shape as the AP-NVP-027 Jira-scoped reader/
     * writer; parameterising by `system` is what the AP-IFW-015 routing
     * change needs so the primary subscriber can record refs under
     * 'linear' or 'jira' depending on `issue_tracker`.
     */
    private buildExternalRefs(system: 'linear' | 'jira'): JiraExternalRefs {
        const db = this.db!;
        return {
            read(localId: string): string | undefined {
                const row = db
                    .prepare(
                        `SELECT external_id FROM external_refs
                         WHERE local_id = ? AND system = ?`,
                    )
                    .get(localId, system) as { external_id: string } | undefined;
                return row?.external_id;
            },
            write(localId: string, externalId: string): void {
                db.prepare(
                    `INSERT OR REPLACE INTO external_refs
                       (local_id, system, external_id)
                     VALUES (?, ?, ?)`,
                ).run(localId, system, externalId);
            },
        };
    }

    /**
     * Read+validate `config/pipeline.yaml`. The validating loader rejects
     * invalid `issue_tracker` / `issue_tracker_shadow` values with a clear
     * `PipelineConfigError` (re-thrown so `start()` aborts before any
     * subscriber is wired). A missing file is non-fatal: the host falls
     * back to documented defaults and logs a warning.
     *
     * Result is cached so multiple call sites in start() do not re-parse.
     */
    private loadPipelineConfig(): PipelineConfig {
        if (this.cachedPipelineConfig) return this.cachedPipelineConfig;

        let validated: ValidatedPipelineConfig;
        try {
            // The profile's pipeline.yaml is deep-merged over the repo's,
            // then validated as ONE document, so a bad key in either layer
            // fails the same way it always has.
            const layered = readLayeredPipelineDoc({
                repoPath: this.pipelineConfigPath,
                home: this.profileHome ?? null,
            });
            validated = parsePipelineConfig(
                layered.profilePath
                    ? `${this.pipelineConfigPath} + ${layered.profilePath}`
                    : this.pipelineConfigPath,
                layered.doc,
            );
        } catch (err) {
            // Only an unreadable REPO default (fresh checkout, no YAML) may
            // fall back. Malformed YAML anywhere, or a profile file that
            // exists but cannot be read, stops boot with the file named.
            if (err instanceof LayeredConfigError
                && (err.reason === 'malformed' || err.file !== this.pipelineConfigPath)) {
                throw new PipelineConfigError(err.file, err.message.slice(err.file.length + 2));
            }
            if (err instanceof PipelineConfigError) {
                // Validation failures are non-recoverable — re-throw so the
                // operator sees the exact offending value and field.
                throw err;
            }
            // I/O or other parse trouble: log + fall back to defaults so a
            // fresh checkout without the YAML still boots.
            this.logger.warn('orchestrator: pipeline config not loaded', {
                path: this.pipelineConfigPath,
                error: err instanceof Error ? err.message : String(err),
            });
            const fallback: PipelineConfig = {
                issue_tracker: 'linear',
                issue_tracker_shadow: 'none',
                defaultModels: {},
            };
            this.cachedPipelineConfig = fallback;
            return fallback;
        }

        const raw = validated.raw as Record<string, unknown>;
        this.cachedPipelineConfig = {
            issue_tracker: validated.issue_tracker,
            issue_tracker_shadow: validated.issue_tracker_shadow,
            config_store: raw.config_store as ConfigStoreYamlSection | undefined,
            worktree_root:
                typeof raw.worktree_root === 'string' ? raw.worktree_root : undefined,
            defaultModels: readAgentDefaultModels(raw.default_models),
        };
        return this.cachedPipelineConfig;
    }

    /**
     * Resolve every step row still marked `running` at boot.
     *
     * At boot such a row is unambiguously orphaned: no live agent can
     * exist yet, so whatever owned it belonged to the worker process
     * that is gone. Its `close` handler - the only thing that
     * publishes a run's terminal event - went with it, so the row
     * would otherwise read `running` forever, flow_state would never
     * advance, and the board would spin on a process that no longer
     * exists.
     *
     * Field report: "there was another agent running, the Get-Process
     * query now returns no results, but Tester still shows running" -
     * the worker had restarted 77 seconds after that tester spawned.
     *
     * Best-effort: a failure here must not stop the worker booting,
     * because everything else about the boot is still useful.
     */
    private async reconcileOrphanedAgentRuns(): Promise<void> {
        let orphans: ReturnType<typeof findOrphanedRuns>;
        try {
            orphans = findOrphanedRuns(this.db!);
        } catch (err) {
            this.logger.warn('orchestrator: orphaned-run scan failed', {
                error: err instanceof Error ? err.message : String(err),
            });
            return;
        }
        if (orphans.length === 0) return;
        this.logger.warn(
            'orchestrator: resolving agent runs stranded by a restart',
            {
                count: orphans.length,
                runs: orphans.slice(0, 10).map((o) => ({
                    taskId: o.taskId,
                    stepId: o.stepId,
                    role: o.role,
                })),
            },
        );
        for (const run of orphans) {
            try {
                await this.bus!.publish({
                    type: 'AgentRunOrphaned',
                    v: 1,
                    occurredAt: this.clock(),
                    // Per (task, step, start): the same stranded run must
                    // not be re-reported if the worker restarts twice
                    // before the operator deals with it, but a LATER run
                    // of the same step that is stranded again must.
                    idempotencyKey:
                        `AgentRunOrphaned:${run.taskId}:${run.stepId}:${run.startedAt}`,
                    payload: {
                        taskId: run.taskId,
                        stepId: run.stepId,
                        role: run.role,
                        startedAt: run.startedAt,
                        note: describeOrphanedRun(run),
                        park: needsOperatorPark(run),
                    },
                });
            } catch (err) {
                this.logger.error(
                    'orchestrator: could not resolve a stranded agent run',
                    {
                        taskId: run.taskId,
                        stepId: run.stepId,
                        error: err instanceof Error ? err.message : String(err),
                    },
                );
            }
        }
    }

    private attachCommandCascades(): void {
        const bus = this.bus!;
        const cmdBus = this.commandBus!;

        // PlanApproved -> CreateTask. Anonymous (live-only): replays must
        // not re-dispatch commands, since each CreateTask handler call
        // mints a fresh taskId and would diverge from the original run.
        bus.subscribe<PlanApprovedPayload>(Events.PLAN_APPROVED, async (event) => {
            await cmdBus.send({
                type: Commands.CREATE_TASK,
                actor: DEFAULT_ACTOR,
                issuedAt: this.clock(),
                payload: { planId: event.payload.planId },
            });
        });

        // TaskCreated -> ApproveTask. Same rationale: live-only cascade.
        bus.subscribe<TaskCreatedPayload>(Events.TASK_CREATED, async (event) => {
            await cmdBus.send({
                type: Commands.APPROVE_TASK,
                actor: DEFAULT_ACTOR,
                issuedAt: this.clock(),
                payload: {
                    taskId: event.payload.taskId,
                    flowId: event.payload.flowId,
                },
            });
        });
    }
}

export type { OrchestratorOptions as Options };

/**
 * Build the human-readable summary string passed to `closeIssue`. Accepts
 * the loose `summary` shape both Linear and Jira subscribers handle:
 *
 *   summary: "text"                                     → "text"
 *   summary: { text, prUrl }                            → "text\n\nPR: ..."
 *   summary?: string, prUrl: "..."                      → "summary\n\nPR: ..."
 *
 * Kept module-private so the primary subscriber stays as the single owner.
 */
function composeFinishedSummary(payload: {
    readonly summary?: unknown;
    readonly prUrl?: string;
}): string {
    const summary = payload.summary;
    if (typeof summary === 'string') {
        return payload.prUrl ? `${summary}\n\nPR: ${payload.prUrl}` : summary;
    }
    if (summary && typeof summary === 'object') {
        const obj = summary as { text?: unknown; prUrl?: unknown };
        const parts: string[] = [];
        if (typeof obj.text === 'string' && obj.text.length > 0) parts.push(obj.text);
        const prUrl =
            typeof obj.prUrl === 'string' && obj.prUrl.length > 0
                ? obj.prUrl
                : payload.prUrl;
        if (prUrl) parts.push(`PR: ${prUrl}`);
        return parts.join('\n\n');
    }
    return payload.prUrl ? `PR: ${payload.prUrl}` : '';
}
