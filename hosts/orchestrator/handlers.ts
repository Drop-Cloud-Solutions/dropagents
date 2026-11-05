import * as fs from 'node:fs';
import * as path from 'node:path';

import type {
    Attachment,
    AttachmentOwnerType,
    SqliteAttachmentStore,
} from '../../adapters/state/SqliteAttachmentStore';
import type { AttachmentBlobStore } from '../../core/ports/AttachmentBlobStore';

import type { CommandBus, CommandHandler } from '../../core/commands/bus';
import type { Command } from '../../core/commands/command';
import type { EventBus } from '../../core/events/bus';
import type {
    Event,
    PlanArchivedPayload,
    PlanDecomposedTask,
    PlanUnarchivedPayload,
    PlanDeletedPayload,
    TaskRetriedPayload,
    TaskSkippedPayload,
    UnknownEvent,
} from '../../core/events/event';
import {
    BoardUiCommands,
    BoardUiEvents,
    isInterruptTaskPayload,
    type AgentRunKiller,
    type InterruptTaskPayload,
    type TaskInterruptedPayload,
} from '../board-ui/commands';
import {
    NotificationKinds,
    type AgentRunner,
    type AgentSpec,
    type IdGen,
    type Logger,
    type NotificationPayload,
} from '../../core/ports';
import {
    FlowCommands,
    type FailTaskPayload,
    type InvestigationThreadEntry,
    type RequestInvestigationPayload,
    type StartAgentPayload,
    type TaskLineage,
    type TaskLineageStore,
} from '../../core/flow/engine';
import {
    InvestigationFollowupCommands,
    createRequestInvestigationFollowupHandler,
    type InvestigatorAgent,
    type InvestigatorInput,
    type RequestInvestigationFollowupPayload,
} from '../../core/flow/investigation-followup';
import type { RepoReader, RepoSpec } from '../../core/ports/RepoReader';
import {
    mergeClarifications,
    renderClarificationBlock,
    type ClarificationRecord,
} from './operator-decisions';
import { renderProjectContextForEditing } from './project-context';
import {
    createResumeHandler,
    type AgentMemoryWriter as ResumeMemoryWriter,
    type TaskProjectLookup as ResumeProjectLookup,
    type WorktreeRootLookup as ResumeWorktreeLookup,
} from './handlers/resume';
import {
    validateDecomposerOutput,
    normalizeDecomposerOutput,
} from '../../core/decomposer/validate';
import { apiErrorLine, looksLikeApiError } from '../../core/flow/agent-outcome';
import { parseClarification } from '../../core/flow/clarification-parser';
import { composePersona, flowLayerDirs } from '../../config/profile';
import { loadLayeredFlows } from '../../core/flow/loader';
import { TaskTypeCatalog } from '../../core/flow/task-types';
import {
    ApprovalCallbackCommands,
    AttachmentCommands,
    PlanLifecycleCommands,
    PlanLifecycleEvents,
    PlanOpsCommands,
    ProjectOpsCommands,
    TaskOpsCommands,
    TaskParkingCommands,
    type ResumeTaskPayload,
    createApprovalCallbackHandler,
    createDecomposePlanHandler,
    createGeneratePlanHandler,
    createSubmitBriefHandler,
    isArchivePlanPayload,
    isAbandonDecomposerQuestionPayload,
    isAnswerDecomposerQuestionPayload,
    isUnarchivePlanPayload,
    InvestigationCommands,
    isImplementFromInvestigationPayload,
    NoteOpsCommands,
    isAskInvestigationFollowupPayload,
    type AskInvestigationFollowupPayload,
    createDismissInvestigationHandler,
    type ImplementFromInvestigationPayload,
    type DismissInvestigationPayload,
    type InvestigationReportStore,
    isAttachToOwnerPayload,
    isDeletePlanPayload,
    isMarkTaskCompletePayload,
    isPreApproveTaskPayload,
    isRemoveAttachmentPayload,
    isRetryTaskPayload,
    isSetTaskInstructionsPayload,
    isSetPlanRepoPayload,
    isSkipTaskPayload,
    isUpdateProjectApprovalOverridePayload,
    InMemoryPlanGenerationGate,
    type ApprovalCallbackPayload,
    type ResumeTaskDecision,
    type ArchivePlanPayload,
    type UnarchivePlanPayload,
    type AbandonDecomposerQuestionPayload,
    type AnswerDecomposerQuestionPayload,
    type AttachToOwnerPayload,
    type BriefSubmittedEventPayload,
    type DecomposePlanPayload,
    type DeletePlanPayload,
    type GeneratePlanPayload,
    type MarkTaskCompletePayload,
    type PlanConventions,
    type PlanGenerationGate,
    type PlanGeneratedEventPayload,
    type PreApproveTaskPayload,
    type RemoveAttachmentPayload,
    type RetryTaskPayload,
    type SetTaskInstructionsPayload,
    type SetPlanRepoPayload,
    type SkipTaskPayload,
    type SubmitBriefPayload,
    type UpdateProjectApprovalOverridePayload,
} from '../../core/commands';
import {
    RequirementEvents,
    extractDesignDoc,
    parseArchitectureProposal,
    type ArchitectureProposedPayload,
    RequirementCommands,
    type RequirementSubmittedPayload,
    type DesignVerificationFinding,
    type DesignVerificationStartedPayload,
} from '../../core/requirements';
import { sanitizeMermaidInMarkdown } from '../../core/requirements/mermaid-sanitize';
import type { StackHooks } from '../../core/ports/StackHooks';
import {
    renderSystemsCatalogBlock,
    type SystemCatalogEntry,
} from './systems-catalog';
import type { AgentMemoryEntry, AgentMemoryStore } from '../../core/projects/agent-memory';
import type { ApprovalOverride } from '../../core/projects/registry';
import {
    registerNotesHandlers,
    type NotesDocumentSync,
    type NotesStore,
} from './handlers/notes';
import { taskOutputDir } from './task-outputs';
import {
    readUpstreamOutputs,
    renderUpstreamOutputsBlock,
    type UpstreamTaskOutput,
} from './upstream-outputs';
import {
    designAttachmentDir,
    designAttachmentScope,
    renderDesignAttachmentsNote,
    type DesignAttachmentOwner,
} from './design-attachments';

/**
 * Pipeline-level command names. These are the commands the *orchestrator host*
 * exposes to the outside world (operator, integration tests). The flow engine's
 * own internal commands (StartAgent / FailTask / RequestInvestigation) come
 * from `core/flow/engine`'s `FlowCommands` constant — they are still routed
 * through this same CommandBus, but they are produced by the engine, not by
 * external callers.
 */
export const Commands = {
    APPROVE_PLAN: 'ApprovePlan',
    CREATE_TASK: 'CreateTask',
    APPROVE_TASK: 'ApproveTask',
    /**
     * AP-IFG-001: mutate lineage fields on a previously-created task
     * (currently `followup_inflight` and `investigation_thread`) without
     * re-emitting `TaskCreated`. Idempotency on the resulting event keys
     * on (taskId, issuedAt).
     */
    UPDATE_TASK: 'UpdateTask',
} as const;

/** Domain event types the orchestrator's handlers emit. */
export const Events = {
    PLAN_APPROVED: 'PlanApproved',
    TASK_CREATED: 'TaskCreated',
    TASK_APPROVED: 'TaskApproved',
    /** AP-IFG-001: emitted by `UpdateTask`. Lineage-only mutation. */
    TASK_UPDATED: 'TaskUpdated',
    // AP-PAO-004: operator-driven task / plan / project lifecycle events.
    TASK_SKIPPED: 'TaskSkipped',
    TASK_RETRIED: 'TaskRetried',
    /** Emitted by PreApproveTask — operator approved a deps-gated task. */
    TASK_PRE_APPROVED: 'TaskPreApproved',
    /** Emitted by SetTaskInstructions — operator added instructions/remarks. */
    TASK_INSTRUCTIONS_SET: 'TaskInstructionsSet',
    /**
     * Emitted by the `MarkTaskComplete` operator command. Same wire type
     * the flow engine uses for `emit:TaskFinished` terminals — the
     * projection-tasks subscriber flips `tasks.status='done'` and the
     * dependency store's TaskFinished hook marks every outgoing edge
     * merged, exactly as a flow-driven finish would.
     */
    TASK_FINISHED: 'TaskFinished',
    PLAN_ARCHIVED: 'PlanArchived',
    PLAN_UNARCHIVED: 'PlanUnarchived',
    PLAN_DELETED: 'PlanDeleted',
    PROJECT_APPROVAL_OVERRIDE_UPDATED: 'ProjectApprovalOverrideUpdated',
    /** Migration 021 — operator attached / removed a file on a task or plan. */
    ATTACHMENT_ADDED: 'AttachmentAdded',
    ATTACHMENT_REMOVED: 'AttachmentRemoved',
} as const;

/**
 * Payload of an `AttachmentAdded` event (migration 021). Mirrors a row of
 * the `attachments` projection; the projection-tasks subscriber folds it in
 * verbatim. `caption` is `null` when the operator didn't add one.
 */
export interface AttachmentAddedPayload {
    readonly attachmentId: string;
    readonly ownerType: AttachmentOwnerType;
    readonly ownerId: string;
    readonly fileName: string;
    readonly contentType: string;
    readonly sizeBytes: number;
    readonly storageKey: string;
    readonly caption: string | null;
    readonly createdAt: number;
    /**
     * Migration 038: 'input' (operator upload) or 'output' (a file the
     * task produced, harvested from its output folder). Always written,
     * so a projection never has to guess the direction.
     */
    readonly kind: 'input' | 'output';
}

/**
 * AP-PAO-004: minimal write-side port the `UpdateProjectApprovalOverride`
 * handler depends on. Structural so a real `ProjectRegistry` instance
 * satisfies it without any wrapping, while tests can supply a tiny fake
 * that just records the most recent call.
 */
export interface ProjectApprovalOverrideStore {
    updateApprovalOverride(projectId: string, override: ApprovalOverride): void;
}

export interface ApprovePlanPayload {
    readonly planId: string;
    readonly projectId?: string;
}

export interface CreateTaskPayload {
    readonly planId: string;
    readonly taskType?: string;
    readonly flowId?: string;
    // ---- operator-authored tasks (board "Add task") ----
    // A task the planner/decomposer missed can be appended to a plan by
    // hand. These ride the emitted TaskCreated so the existing folds pick
    // them up: title/description → tasks projection, repoId → per-task
    // worktree resolution, dependencies → task_deps edges + waiting-deps
    // parking in the TaskCreated bridge.
    readonly title?: string;
    readonly description?: string;
    readonly repoId?: string;
    readonly dependencies?: ReadonlyArray<string>;
    // ---- AP-IFG-001: lineage fields (all optional on the inbound command) ----
    readonly parent_task_id?: string;
    readonly spawn_reason?: string;
    readonly source_investigation_id?: string;
    readonly investigation_thread?: ReadonlyArray<InvestigationThreadEntry>;
    readonly followup_inflight?: boolean;
}

export interface ApproveTaskPayload {
    readonly taskId: string;
    readonly flowId: string;
}

export interface PlanApprovedPayload {
    readonly planId: string;
    readonly projectId: string;
    readonly actor: string;
}

/**
 * Lineage shape mirrored from v1's `pipeline/worker/orchestrator.ts` task
 * record. Every field is OPTIONAL on the wire — legacy `TaskCreated`
 * events that pre-date AP-IFG-001 stay readable. The projection helper
 * {@link projectTaskCreated} fills the defaults (`[]` for the thread,
 * `false` for the inflight flag) when an event arrives without them.
 */
export interface TaskCreatedPayload {
    readonly taskId: string;
    readonly planId: string;
    readonly type: string;
    readonly flowId: string;
    /**
     * Owning project, resolved from the plan at publish time.
     *
     * The board folds this event live and ALSO hydrates the same task
     * from `/api/tasks`, which derives the project with
     * `LEFT JOIN sidebar_plans`. Without the field here the two disagreed:
     * a live row had `projectId: null`, the sidebar's project filter reads
     * an unknown project as "not mine", and the task was invisible until a
     * reload replaced it with the hydrated row. Field case: a task added
     * from the plan-modal chat sent its Telegram notification and appeared
     * nowhere, so the Add-task click looked like a no-op.
     */
    readonly projectId?: string;
    readonly parent_task_id?: string;
    readonly spawn_reason?: string;
    readonly source_investigation_id?: string;
    readonly investigation_thread?: ReadonlyArray<InvestigationThreadEntry>;
    readonly followup_inflight?: boolean;
}

export interface TaskApprovedPayload {
    readonly taskId: string;
    readonly flowId: string;
}

/**
 * AP-IFG-001: minimal mutation payload for the lineage fields that change
 * AFTER task creation. `parent_task_id`, `spawn_reason`, and
 * `source_investigation_id` are immutable once recorded — they describe
 * how the task was born — so they are intentionally absent here. The two
 * fields that DO mutate over the course of an investigation are the
 * append-only message thread and the in-flight gate.
 */
export interface TaskUpdatedPayload {
    readonly taskId: string;
    readonly investigation_thread?: ReadonlyArray<InvestigationThreadEntry>;
    readonly followup_inflight?: boolean;
}

/**
 * Inbound payload for the `UpdateTask` command. Same shape as the
 * resulting `TaskUpdated` event — the command handler is a pass-through
 * onto the event log.
 */
export interface UpdateTaskPayload {
    readonly taskId: string;
    readonly investigation_thread?: ReadonlyArray<InvestigationThreadEntry>;
    readonly followup_inflight?: boolean;
}

/**
 * Normalized task lineage record produced by {@link projectTaskCreated}.
 * Every field is concrete: optional inputs collapse to documented
 * defaults so downstream code never has to repeat the defaulting logic
 * (`investigation_thread = []`, `followup_inflight = false`, the three
 * id/reason fields normalise `undefined` to `null` for symmetry with
 * SQLite NULLs on the persisted side).
 */
export interface TaskProjection {
    readonly taskId: string;
    readonly planId: string;
    readonly type: string;
    readonly flowId: string;
    readonly parent_task_id: string | null;
    readonly spawn_reason: string | null;
    readonly source_investigation_id: string | null;
    readonly investigation_thread: ReadonlyArray<InvestigationThreadEntry>;
    readonly followup_inflight: boolean;
}

export type { InvestigationThreadEntry, TaskLineage, TaskLineageStore };

/**
 * Project an inbound `TaskCreatedPayload` (which may be legacy and lack
 * lineage fields entirely) into a fully-defaulted {@link TaskProjection}.
 *
 *   - `investigation_thread` defaults to `[]`
 *   - `followup_inflight`     defaults to `false`
 *   - the three optional id/reason fields default to `null`
 *
 * The returned object is a fresh value; the input is not mutated, and the
 * thread array is shallow-cloned so the caller cannot accidentally mutate
 * the event payload through the projection.
 */
export function projectTaskCreated(payload: TaskCreatedPayload): TaskProjection {
    return {
        taskId: payload.taskId,
        planId: payload.planId,
        type: payload.type,
        flowId: payload.flowId,
        parent_task_id: payload.parent_task_id ?? null,
        spawn_reason: payload.spawn_reason ?? null,
        source_investigation_id: payload.source_investigation_id ?? null,
        investigation_thread:
            payload.investigation_thread !== undefined
                ? payload.investigation_thread.slice()
                : [],
        followup_inflight: payload.followup_inflight ?? false,
    };
}

/**
 * Apply a `TaskUpdatedPayload` onto an existing {@link TaskProjection}.
 * Fields the update leaves `undefined` are preserved from the prior
 * projection — this is the rule that lets `UpdateTask` mutate just
 * `followup_inflight` without erasing the thread, or vice versa.
 *
 * `investigation_thread` is REPLACED wholesale when present (the caller
 * owns the append-or-replace decision). The v1 orchestrator likewise
 * treats the thread as an immutable snapshot persisted by whoever
 * mutates it; this preserves that contract.
 */
export function applyTaskUpdated(
    projection: TaskProjection,
    update: TaskUpdatedPayload,
): TaskProjection {
    if (update.taskId !== projection.taskId) {
        throw new Error(
            `applyTaskUpdated: taskId mismatch — projection "${projection.taskId}", update "${update.taskId}"`,
        );
    }
    return {
        ...projection,
        investigation_thread:
            update.investigation_thread !== undefined
                ? update.investigation_thread.slice()
                : projection.investigation_thread,
        followup_inflight:
            update.followup_inflight !== undefined
                ? update.followup_inflight
                : projection.followup_inflight,
    };
}

export interface HandlerDeps {
    /**
     * Roles whose recorded step summary IS an operator-readable report —
     * what ImplementFromInvestigation decomposes and the follow-up thread
     * renders. Core's own roles are the default; an enabled pack's report
     * roles (`pack.yaml` → `roles: [{ report: true }]`) are added by the
     * host, because core must not name a stack's roles.
     *
     * Omitted = core only. Getting this wrong is SILENT: the report simply
     * is not found, and the operator sees an Implement button that yields
     * nothing.
     */
    readonly reportRoles?: () => readonly string[];
    /**
     * Env overlay for a task's GitHub account, applied to the AGENT
     * process.
     *
     * Agents run git and gh themselves - the committer commits, the
     * scaffolder clones - so there is no pipeline call site to hand a
     * credential to. Absent, or an empty result, leaves the agent on
     * the machine's ambient identity.
     */
    readonly githubEnvForTask?: (taskId: string) => Readonly<Record<string, string>>;
    /**
     * Same thing for the PLAN-scoped lifecycle agents (planner,
     * decomposer, architect), keyed by planId because they run before
     * any task exists.
     *
     * They read the plan's target repo - a planner inspects the code it
     * is planning against - so on a private repo an ambient identity
     * gets "Repository not found" and plans against nothing.
     */
    readonly githubEnvForPlan?: (planId: string) => Readonly<Record<string, string>>;
    readonly clock: () => number;
    readonly idGen: IdGen;
    readonly logger: Logger;
    readonly defaultFlowId: string;
    readonly defaultProjectId: string;
    readonly defaultTaskType: string;
    readonly agentRunner: AgentRunner;
    /**
     * Records that an agent run was started for `taskId`. The orchestrator's
     * AgentFinished bridge needs this mapping to translate the runner's
     * agent-keyed events back into task-keyed events for the flow engine.
     */
    readonly registerAgent: (agentId: string, taskId: string) => void;
    /**
     * Defer the actual `runner.start(...)` call to a future macrotask.
     *
     * The flow engine's `onTaskApproved` awaits the StartAgent command and
     * THEN writes `flow_state`. If we kicked off the runner inside the
     * synchronous handler body, the runner's async `AgentStarted` /
     * `AgentFinished` publishes (and the bridge that translates them into
     * the engine's `agent.finished`) would interleave via microtasks and
     * could reach the engine BEFORE `writeInitialState` had committed —
     * the engine would then warn "AgentFinished for task without flow
     * state" and silently drop the transition.
     *
     * Deferring to a macrotask (default: `setImmediate`) breaks the race:
     * every microtask continuation, including `writeInitialState`, drains
     * before the runner produces its first event.
     */
    readonly deferAgentStart: (run: () => void) => void;
    /**
     * Gate consulted by `ApprovePlan`: returns true iff a `PlanGenerated`
     * event for the supplied `planId` has been observed since boot. The
     * orchestrator host wires an EventBus subscriber that calls
     * `gate.record(planId)` on every `PlanGenerated` event; replay on
     * restart re-runs that subscriber so the gate survives process bounces.
     *
     * Optional for tests / hosts that want to skip the gate (defaults to a
     * fresh InMemoryPlanGenerationGate; supplying a stub gives strict
     * control over what the handler observes).
     */
    readonly planGenerationGate?: PlanGenerationGate;
    /**
     * Per-project memory store. When `GeneratePlan` or `DecomposePlan` is
     * dispatched, the corresponding planner/decomposer agent is invoked
     * with the rendered memory block in its prompt + metadata so prior
     * operator feedback flows into the prompt. Optional — when omitted the
     * agent is still invoked, just without the memory block (used by the
     * existing echo-flow integration tests that have no project memory).
     */
    readonly agentMemory?: AgentMemoryStore;
    /**
     * Worktree-root lookup for the ResumeTask sidecars
     * (`clarification-answer.md` / `feedback.md`). Optional: when absent
     * the sidecar write is skipped with a warning and the resume still
     * proceeds — the answer also travels in the prompt, so the file is a
     * convenience for a file-first agent, never the only copy.
     */
    readonly resumeWorktrees?: ResumeWorktreeLookup;
    /**
     * Per-project memory writer for `remember: true` answers, plus the
     * task→project resolution it needs. Both must be present or the
     * remember flag is logged and dropped.
     */
    readonly resumeMemory?: ResumeMemoryWriter;
    readonly resumeProjectLookup?: ResumeProjectLookup;
    /** Role label for the planner agent. Defaults to `'planner'`. */
    readonly plannerRole?: string;
    /** Role label for the decomposer agent. Defaults to `'decomposer'`. */
    readonly decomposerRole?: string;
    /** Model label for the planner agent. Defaults to `'opus'`. */
    readonly plannerModel?: string;
    /** Model label for the decomposer agent. Defaults to `'sonnet'`. */
    readonly decomposerModel?: string;
    /**
     * AP-IFG-007: lineage store used by the `RequestInvestigationFollowup`
     * handler to gate re-entry on `followup_inflight` and to append
     * operator + investigator entries onto `investigation_thread`. When
     * omitted the follow-up handler is NOT registered — callers that want
     * follow-up support must supply both `taskLineage` AND
     * `investigatorAgent` together.
     */
    readonly taskLineage?: TaskLineageStore;
    /**
     * AP-IFG-007: adapter that runs the investigator agent with the
     * follow-up prompt and resolves with its answer. Paired with
     * `taskLineage`. In production this wraps the existing `AgentRunner`;
     * in tests it can be replaced with a stub that resolves a canned
     * answer.
     */
    readonly investigatorAgent?: InvestigatorAgent;
    /**
     * AP-VP5-006: resolves the absolute path to the `investigation-history.jsonl`
     * file for a task — conventionally `<worktree>/investigation-history.jsonl`.
     * When supplied (alongside `taskLineage` + `investigatorAgent`) the follow-up
     * handler additionally persists each turn — operator before spawn, investigator
     * after completion — as one JSONL line `{ role, content, timestamp, threadId }`.
     * The file is created on the first follow-up and seeded from the
     * `priorBrief` / `priorReport` carried on the command payload (the v2
     * equivalent of v1's "original investigation completion event"); subsequent
     * turns only append. Returning `undefined` for a given `taskId` disables
     * persistence for that task — the in-memory lineage path still runs.
     */
    readonly investigationHistoryPath?: (taskId: string) => string | undefined;
    /**
     * AP-PAO-004: write-side hook used by the
     * `UpdateProjectApprovalOverride` handler to persist the per-flow /
     * per-step override map onto `core/projects/<id>/project.json` via the
     * registry. When omitted the handler is NOT registered — operators
     * dispatching that command on a host without project persistence get
     * a clear "no handler" error rather than a silent no-op.
     */
    readonly approvalOverrideStore?: ProjectApprovalOverrideStore;
    /**
     * AP-VP4-010: port used to assemble planner / decomposer prompts with
     * a repo tree + sample-file blob. The handler invokes
     * `repoReader.read(repoSpec)` once per spawn so the agent prompt
     * carries the same context the v1 worker injects from
     * `worker/repo-fetch.ts`. Optional — when omitted, the prompt is
     * assembled without the repo block (used by unit tests that have no
     * filesystem under test).
     */
    readonly repoReader?: RepoReader;
    /**
     * AP-VP4-010: spec passed to `repoReader.read` when a planner /
     * decomposer agent is dispatched. The orchestrator host normally
     * derives this from the project's `repo.path`; tests that want
     * deterministic prompt assembly inject a tiny in-memory spec instead.
     */
    readonly repoSpec?: RepoSpec;
    /**
     * Per-spawn `RepoSpec` resolver. When set, `startLifecycleAgent`
     * calls this with the spawn args (planId/projectId/etc.) and uses
     * the returned spec instead of the static {@link repoSpec}. The
     * orchestrator host wires this to look up the plan's chosen
     * workspace repoId, await a `git fetch && git reset --hard`
     * against it (so the agent sees the latest content), and return a
     * `RepoSpec` pointing at the refreshed clone. Returning `null`
     * tells the handler to skip the repo block — used when the plan
     * has no targetRepo set or the workspace registry has no matching
     * row.
     */
    readonly resolveRepoSpec?: (
        args: StartLifecycleAgentArgs,
    ) => Promise<RepoSpec | null>;
    /**
     * Task-side counterpart of {@link resolveRepoSpec}. The StartAgent
     * handler calls this with the `taskId` so the orchestrator can walk
     * `tasks.plan_id → sidebar_plans.metadata.targetRepo → repos.ensured_path`,
     * run the pre-spawn refresh, and hand back a `RepoSpec` pointing at
     * the freshly-pulled clone. Returning `null` tells the handler to
     * spawn without a repo block and without a cwd — which the runner
     * turns into an empty scratch dir, NOT an inherited cwd
     * (`ClaudeCliRunner.resolveCwd`), and which makes the prompt's
     * workspace block read-only.
     */
    readonly resolveTaskRepoSpec?: (
        taskId: string,
    ) => Promise<RepoSpec | null>;
    /**
     * Lists every active repo in the pipeline workspace with its
     * absolute path. Used by the StartAgent handler to populate the
     * agent prompt's `# Workspace layout` block so cross-repo reads
     * have concrete paths and the agent does not walk up to the
     * operator's personal checkouts elsewhere on disk. When omitted
     * the block is skipped (legacy / test wiring); production threads
     * `RepoProjectionStore.listActive()` through here.
     */
    readonly listWorkspaceRepos?: () => ReadonlyArray<WorkspaceRepoEntry>;
    /**
     * The enabled stack packs' design-context blocks (e.g. the dotnet-azure
     * pack's NuGet package graph: publishers, consumers, the required
     * publish/bump chain), joined, injected into every lifecycle-agent
     * prompt. '' with no pack that has one. Wired by the host from the
     * packs' StackHooks.
     */
    readonly getStackContextBlock?: () => string;
    /**
     * Rendered `# Project context` block for a project (ConfigStore
     * projects.context_md). Design-side agents only —
     * see hosts/orchestrator/project-context.ts.
     */
    readonly getProjectContextBlock?: (projectId: string) => string;
    /**
     * Plan-type router: the plan's archetype (`metadata.planType`) by planId.
     * GeneratePlan uses it — a non-`feature` archetype (documentation /
     * review-* / deploy-only / investigate) skips the planner and decomposes
     * the brief straight into the archetype's task(s). Returns undefined for a
     * feature / unset plan, in which case the planner runs as normal.
     */
    readonly getPlanArchetype?: (planId: string) => string | undefined;
    /**
     * The plan's ORIGINAL brief text by planId (from the BriefSubmitted
     * event; planId = `plan-<briefId>`). GeneratePlan uses it as the
     * `# Brief` section whenever the command doesn't carry one — i.e.
     * every operator Regenerate. Without it a regenerate whose previous
     * revision recorded no content (agent failed at spawn) hands the
     * planner a prompt with NO task description at all, and it parks on
     * NEEDS_HUMAN_INPUT asking what the work is.
     */
    readonly getBriefContent?: (planId: string) => string | undefined;
    /**
     * Management UI (Option B): the per-role persona (Agent.prompt) to use
     * instead of the `agents/<role>.CLAUDE.md` file. Returns undefined when no
     * agent record configures the role, in which case the file is used.
     */
    readonly resolveAgentPrompt?: (role: string) => string | undefined;
    /**
     * Read-only SQLite handle the StartAgent handler uses to load task +
     * plan context for the prompt builder. When omitted the handler
     * falls back to the legacy placeholder prompt — production wiring
     * always supplies it.
     */
    readonly db?: import('../../core/state/migrations').Db;
    /**
     * AP-VP4-010: shared map that captures the per-agent context a
     * planner / decomposer spawn needs to translate AgentFinished /
     * AgentFailed back into PlanGenerated / PlanDecomposed events.
     * Both `registerCommandHandlers` (the spawn site) and
     * `registerPlanLifecycleAgentHandlers` (the AgentFinished subscriber)
     * read and write through the same map, so callers must supply a
     * single instance when wiring both. Omitting it disables the
     * agent-driven PlanGenerated / PlanDecomposed emission path
     * entirely (used by the existing handlers.test.ts tests that only
     * exercise the synchronous emit + gate flip).
     */
    readonly lifecycleAgents?: Map<string, LifecycleAgentContext>;
    /**
     * AP-VP5-007: per-project notes-board store. When supplied,
     * `registerCommandHandlers` wires the notes CRUD + promote/convert
     * surface (CreateProjectNote / UpdateProjectNote / DeleteProjectNote
     * / PromoteNoteToPlan / ConvertNoteToInvestigation). Production
     * wires a {@link FileSystemNotesStore} rooted at the runtime
     * projects directory; tests inject an in-memory fake or a
     * tmp-dir-backed instance. Omitting this disables the notes surface
     * entirely.
     */
    readonly notesStore?: NotesStore;
    /**
     * AP-VP5-007: Linear-document mirror invoked on every notes
     * mutation. Phase 5 only the
     * {@link import('../../adapters/fakes/FakeNotesDocumentSync').FakeNotesDocumentSync}
     * fake satisfies this port; Phase 6 swaps in a real Linear adapter
     * behind the same interface. Optional — when omitted the CRUD
     * handlers skip the mirror call.
     */
    readonly notesDocumentSync?: NotesDocumentSync;
    /**
     * Migration 021: attachment metadata projection. When wired (alongside
     * {@link attachmentBlobStore}), the StartAgent handler materialises a
     * task's + its plan's attachments into `<worktree>/attachments/` and
     * lists them in TASK.md so the agent can Read the screenshots / specs.
     * Omitting both disables the surface (tests, minimal hosts).
     */
    readonly attachmentStore?: SqliteAttachmentStore;
    /**
     * Root of the mirrored PLAN attachments
     * (`<workspaceRoot>/plan-attachments`). Lifecycle agents have no
     * worktree, so this is where their attachments live and what the
     * `# Plan attachments` block points at. Unset = the block degrades to
     * naming files without paths (tests, minimal hosts).
     */
    readonly planAttachmentsRoot?: string;
    /**
     * Root of the mirrored REQUIREMENT attachments
     * (`<workspaceRoot>/requirement-attachments`) — the architect tier's
     * design INPUT, read by the architect and the design-verifier.
     *
     * Separate from {@link planAttachmentsRoot} because an architect run
     * carries a SYNTHETIC plan id (`req-<requirementId>`): pointing it at
     * the plan root would name a directory for a plan that does not
     * exist. Unset = the block degrades to filenames without paths.
     */
    readonly requirementAttachmentsRoot?: string;
    /**
     * Root of the per-task deliverable output folders
     * (`<workspaceRoot>/task-output`, migration 038). When wired, the
     * StartAgent handler creates `<root>/<taskId>`, names it in the
     * prompt, and the orchestrator's harvest attaches whatever the agent
     * leaves there to the task. Unset = no output block, which is what
     * every host that has not wired it should see.
     */
    readonly taskOutputsRoot?: string;
    /** Migration 021: blob store the materialiser reads attachment bytes
     *  from. Paired with {@link attachmentStore}. */
    readonly attachmentBlobStore?: AttachmentBlobStore;
}

/**
 * AP-VP4-010: per-spawn context recorded for a planner / decomposer agent
 * run. The AgentFinished subscriber reads it back out by `agentId` so it
 * can emit the right downstream event with the original `planId`,
 * `revision`, etc — fields the runner itself has no notion of.
 *
 *   - `kind`         distinguishes planner vs decomposer for the
 *                    AgentFinished branch.
 *   - `revision`     mirrors the planner's `GeneratePlan.revision`. The
 *                    BriefSubmitted-triggered spawn records `1` so
 *                    AC #1's "PlanGenerated with revision === 1" holds.
 *   - `feedback` /
 *     `previousContent` are the regenerate-mode inputs threaded onto the
 *                    planner prompt. Mirrored onto the PlanGenerated
 *                    event for traceability.
 *   - `approvedContent` /
 *     `conventions`  are the decomposer-only inputs threaded onto the
 *                    decomposer prompt.
 */
export interface LifecycleAgentContext {
    readonly kind: 'planner' | 'decomposer' | 'architect' | 'design-verifier';
    readonly planId: string;
    readonly projectId: string;
    readonly revision?: number;
    readonly briefId?: string;
    readonly feedback?: string;
    readonly previousContent?: string;
    readonly approvedContent?: string;
    readonly conventions?: PlanConventions;
    /** Architect Tier: the requirement id, on architect-kind contexts. */
    readonly requirementId?: string;
    /**
     * The remaining spawn inputs, recorded so a decomposer run that ends on
     * a `NEEDS_HUMAN_INPUT` question can be re-spawned IDENTICALLY once the
     * operator answers — same brief, same archetype allow-list. Reading
     * them back off the context is the only way the re-spawn is faithful:
     * `briefContent` is resolved through `getBriefContent` at dispatch time
     * and `archetype` rides the BriefSubmitted event, neither of which the
     * answer path has.
     */
    readonly briefContent?: string;
    readonly archetype?: string;
    /** Answers already given on this plan, oldest first. */
    readonly clarifications?: readonly ClarificationRecord[];
}

/**
 * AP-VP4-010: domain event types emitted by the agent-driven half of the
 * plan lifecycle. The successful PlanGenerated / PlanDecomposed types
 * already live on `PlanLifecycleEvents` (see core/commands/index.ts); the
 * `*Failed` variants are owned here because they are downstream-only —
 * no operator command emits them directly.
 */
export const PlanLifecycleAgentEvents = {
    PLAN_GENERATE_FAILED: 'PlanGenerateFailed',
    PLAN_DECOMPOSE_FAILED: 'PlanDecomposeFailed',
    /**
     * The decomposer ended its run with the universal `NEEDS_HUMAN_INPUT`
     * block instead of a task JSON document — it hit something it could not
     * decide safely and asked.
     *
     * This is NOT a failure and must not be folded as one: before this
     * event existed the question fell straight through
     * {@link emitPlanDecomposed}'s JSON extraction and surfaced as
     * "decomposer output contains no JSON object" — a parser error on a red
     * card, with the actual question buried in the agent stream and no way
     * to answer it. The decomposer card holds on this event and grows an
     * Answer button.
     */
    PLAN_DECOMPOSE_QUESTION_RAISED: 'PlanDecomposeQuestionRaised',
    /** The operator answered; a subscriber re-spawns the decomposer. */
    PLAN_DECOMPOSE_QUESTION_ANSWERED: 'PlanDecomposeQuestionAnswered',
    /**
     * The operator gave up on the question. Retires it WITHOUT a
     * re-spawn — the absence of that subscriber is the whole point, and
     * is pinned by a test.
     */
    PLAN_DECOMPOSE_QUESTION_ABANDONED: 'PlanDecomposeQuestionAbandoned',
} as const;

export interface PlanGeneratedAgentEventPayload extends PlanGeneratedEventPayload {
    /** Markdown body the planner agent emitted (verbatim stdout). */
    readonly content: string;
}

export interface PlanDecomposedAgentEventPayload {
    readonly planId: string;
    readonly projectId: string;
    readonly actor: string;
    /** Validated JSON document the decomposer produced. */
    readonly tasks: unknown;
    readonly conventions?: PlanConventions;
    /**
     * Plan revision the decomposer ran against. Threaded through so the
     * downstream task-projection-store can scope each TaskCreated event
     * to a specific revision — without it, a re-decompose of the same
     * plan would emit events with the same idempotency key as the prior
     * run and silently get dropped by the event store's UNIQUE constraint.
     */
    readonly revision?: number;
}

export interface PlanGenerateFailedPayload {
    readonly planId: string;
    readonly projectId: string;
    readonly revision?: number;
    readonly error: string;
}

export interface PlanDecomposeFailedPayload {
    readonly planId: string;
    readonly projectId: string;
    readonly error: string;
}

/**
 * Maximum questions the decomposer may ask on one plan before the run is
 * failed instead of re-spawned. Mirrors the per-task cap stated in
 * `agents/_shared/clarification-block.md` ("The hard cap is 3
 * clarifications per task"): an agent that keeps asking is not converging,
 * and the operator should get the normal failure UX rather than an endless
 * question loop.
 */
export const DECOMPOSER_CLARIFICATION_CAP = 3;

export interface PlanDecomposeQuestionRaisedPayload {
    readonly planId: string;
    readonly projectId: string;
    /** The `Question:` line, hard wraps re-joined (clarification-parser). */
    readonly question: string;
    /** Enumerated options as the agent wrote them; `[]` when it gave none. */
    readonly options: ReadonlyArray<{ readonly key: string; readonly label: string }>;
    /** The block verbatim, so the modal can show the original wording. */
    readonly raw: string;
    readonly askedAt: number;
}

export interface PlanDecomposeQuestionAnsweredPayload {
    readonly planId: string;
    readonly projectId: string;
    /** The question this answers, copied from the pending row. */
    readonly question: string;
    readonly answer: string;
    /** Operator opted to file the decision in the project's agent memory. */
    readonly remember?: boolean;
    readonly answeredAt: number;
}

/**
 * Register every command handler the orchestrator host owns onto the
 * supplied CommandBus. This includes:
 *
 *   - Operator-facing handlers: ApprovePlan, CreateTask, ApproveTask
 *     (each emits the matching domain event).
 *   - Flow-engine-driven handlers: agent.start, task.fail,
 *     investigation.request, task.finish (drive or log; agent.start in
 *     particular spawns the AgentRunner and seeds the agent→task mapping
 *     so AgentFinished can later be bridged back to the engine).
 *
 * Handlers stay pure with respect to the event log — every state change
 * the rest of the host cares about flows back through the EventBus, not
 * through return values from the handler.
 */
export function registerCommandHandlers(
    cmdBus: CommandBus<unknown>,
    deps: HandlerDeps,
): void {
    const gate: PlanGenerationGate =
        deps.planGenerationGate ?? new InMemoryPlanGenerationGate();
    const plannerRole = deps.plannerRole ?? 'planner';
    const decomposerRole = deps.decomposerRole ?? 'decomposer';
    // 'none' (not a hardcoded alias) when unset: resolveModel treats it as
    // "no per-call override" and falls through to the runner's
    // defaultModels[role] (from pipeline.yaml) then the CLAUDE_MODEL_<ROLE> /
    // CLAUDE_MODEL env vars. The orchestrator threads the configured
    // default_models.planner / .decomposer into deps, so in practice this
    // carries the YAML value.
    const plannerModel = deps.plannerModel ?? 'none';
    const decomposerModel = deps.decomposerModel ?? 'none';

    cmdBus.register<ApprovePlanPayload>(Commands.APPROVE_PLAN, async (cmd) => {
        const { planId } = cmd.payload;
        if (!gate.has(planId)) {
            throw new Error(
                `ApprovePlan: refusing — no PlanGenerated event recorded for plan "${planId}". Dispatch GeneratePlan first.`,
            );
        }
        const payload: PlanApprovedPayload = {
            planId,
            projectId: cmd.payload.projectId ?? deps.defaultProjectId,
            actor: cmd.actor,
        };
        const event: Event = {
            type: Events.PLAN_APPROVED,
            v: 1,
            occurredAt: deps.clock(),
            idempotencyKey: `${Commands.APPROVE_PLAN}:${planId}`,
            payload,
        };
        return [event];
    });

    // SubmitBrief — operator entry point. Pure event emission; no agent
    // invocation here (the brief is just persisted on the event log so a
    // subsequent GeneratePlan has provenance to point back to).
    cmdBus.register<SubmitBriefPayload>(
        PlanLifecycleCommands.SUBMIT_BRIEF,
        createSubmitBriefHandler({ clock: deps.clock }),
    );

    // GeneratePlan — emit PlanGenerated *and* invoke the planner agent with
    // the project's memory blob in its prompt + metadata. The gate is
    // flipped synchronously here so a subsequent ApprovePlan in the same
    // process succeeds without needing a separate event subscriber to be
    // wired. (The orchestrator host ALSO wires a named PlanGenerated
    // subscriber so replay after restart re-builds the gate from the
    // persisted log — gate.record is idempotent (Set add) so the two
    // paths can coexist without double-counting.)
    const generatePlanInner = createGeneratePlanHandler({ clock: deps.clock });
    cmdBus.register<GeneratePlanPayload>(
        PlanLifecycleCommands.GENERATE_PLAN,
        async (cmd) => {
            // Plan-type routing: a non-feature archetype skips the planner and
            // decomposes the brief straight into its task(s). The decomposer's
            // archetype allow-lists produce exactly the right task type
            // (document / review-* / deploy-* / investigate). No PlanGenerated
            // is emitted — the decomposer emits PlanDecomposed on finish.
            const archetype = deps.getPlanArchetype?.(cmd.payload.planId);
            // Regenerate dispatches (plan-review route) carry no brief —
            // recover the original BriefSubmitted text so the planner
            // always sees the task description, even when the previous
            // revision's content is empty (prior run failed at spawn).
            const briefContent =
                cmd.payload.briefContent ?? deps.getBriefContent?.(cmd.payload.planId);
            if (typeof archetype === 'string' && archetype.length > 0 && archetype !== 'feature') {
                startLifecycleAgent(deps, {
                    kind: 'decomposer',
                    role: decomposerRole,
                    model: decomposerModel,
                    planId: cmd.payload.planId,
                    projectId: cmd.payload.projectId,
                    approvedContent: briefContent ?? '',
                    archetype,
                });
                return [];
            }
            const events = await generatePlanInner(cmd, undefined);
            gate.record(cmd.payload.planId);
            startLifecycleAgent(deps, {
                kind: 'planner',
                role: plannerRole,
                model: plannerModel,
                planId: cmd.payload.planId,
                projectId: cmd.payload.projectId,
                revision: cmd.payload.revision,
                ...(cmd.payload.briefId !== undefined ? { briefId: cmd.payload.briefId } : {}),
                ...(cmd.payload.feedback !== undefined ? { feedback: cmd.payload.feedback } : {}),
                ...(cmd.payload.previousContent !== undefined
                    ? { previousContent: cmd.payload.previousContent }
                    : {}),
                ...(briefContent !== undefined ? { briefContent } : {}),
            });
            return events;
        },
    );

    // DecomposePlan — emit PlanDecomposed + invoke the decomposer agent
    // with project memory threaded in.
    const decomposeInner = createDecomposePlanHandler({ clock: deps.clock });
    cmdBus.register<DecomposePlanPayload>(
        PlanLifecycleCommands.DECOMPOSE_PLAN,
        async (cmd) => {
            const events = await decomposeInner(cmd, undefined);
            // The decomposer sees the ORIGINAL brief alongside the approved
            // plan. For requirement-fanned plans the brief carries the full
            // architecture design (see the fan-out in main.ts) — without it
            // the decomposer only ever saw the planner's re-summarisation,
            // and cross-system file/contract details the planner dropped
            // were unrecoverable (missed files → broken builds).
            const decomposeBrief = deps.getBriefContent?.(cmd.payload.planId);
            startLifecycleAgent(deps, {
                kind: 'decomposer',
                role: decomposerRole,
                model: decomposerModel,
                planId: cmd.payload.planId,
                projectId: cmd.payload.projectId,
                approvedContent: cmd.payload.approvedContent,
                conventions: cmd.payload.conventions,
                ...(decomposeBrief !== undefined && decomposeBrief.length > 0
                    ? { briefContent: decomposeBrief }
                    : {}),
            });
            return events;
        },
    );

    // AnswerDecomposerQuestion — the operator's reply to the question a
    // decomposer run is held on. Validates + emits only: the re-spawn is
    // driven by the PlanDecomposeQuestionAnswered subscriber in
    // `registerPlanLifecycleAgentHandlers`.
    cmdBus.register<AnswerDecomposerQuestionPayload>(
        PlanLifecycleCommands.ANSWER_DECOMPOSER_QUESTION,
        async (cmd) => {
            if (!isAnswerDecomposerQuestionPayload(cmd.payload)) {
                throw new Error(
                    'AnswerDecomposerQuestion: payload.planId and a non-empty payload.answer are required',
                );
            }
            const { planId, remember } = cmd.payload;
            const answer = cmd.payload.answer.trim();
            const pending = readPendingDecomposerQuestion(deps.db, planId);
            if (!pending) {
                // A stale Answer button (the question was already answered
                // in another tab, or the plan was re-decomposed) must say so
                // rather than emit an answer to nothing.
                throw new Error(
                    `AnswerDecomposerQuestion: no unanswered decomposer question on plan ${planId}`,
                );
            }
            const answeredAt = deps.clock();
            const payload: PlanDecomposeQuestionAnsweredPayload = {
                planId,
                projectId: pending.projectId,
                question: pending.question,
                answer,
                ...(remember !== undefined ? { remember } : {}),
                answeredAt,
            };
            return [{
                type: PlanLifecycleAgentEvents.PLAN_DECOMPOSE_QUESTION_ANSWERED,
                v: 1,
                occurredAt: answeredAt,
                // Per (plan, question) — answering the SAME question twice is
                // the double-click case and must collapse; a later question
                // on the same plan has a different event_seq and lands
                // separately.
                idempotencyKey:
                    `${PlanLifecycleAgentEvents.PLAN_DECOMPOSE_QUESTION_ANSWERED}`
                    + `:${planId}:${String(pending.eventSeq)}`,
                payload,
            }];
        },
    );

    // AbandonDecomposerQuestion — the operator gives up on the
    // question rather than answering it.
    //
    // Field report: the decomposer offered "cancel the task" as one of
    // its own options; selecting it answered the question with that
    // text, the decomposer was re-spawned, and it asked again. The
    // options are the agent's prose, so no answer can ever be a
    // pipeline ACTION. This command is the action.
    //
    // Emits only, like the answer handler. The difference is what does
    // NOT subscribe to the resulting event: nothing re-spawns.
    cmdBus.register<AbandonDecomposerQuestionPayload>(
        PlanLifecycleCommands.ABANDON_DECOMPOSER_QUESTION,
        async (cmd) => {
            if (!isAbandonDecomposerQuestionPayload(cmd.payload)) {
                throw new Error(
                    'AbandonDecomposerQuestion: payload.planId is required',
                );
            }
            const { planId } = cmd.payload;
            const reason = cmd.payload.reason?.trim();
            const pending = readPendingDecomposerQuestion(deps.db, planId);
            if (!pending) {
                // Same contract as answering: a stale button must say so
                // rather than retire a question nobody asked.
                throw new Error(
                    'AbandonDecomposerQuestion: no unanswered decomposer'
                    + ` question on plan ${planId}`,
                );
            }
            const abandonedAt = deps.clock();
            return [{
                type: PlanLifecycleAgentEvents.PLAN_DECOMPOSE_QUESTION_ABANDONED,
                v: 1,
                occurredAt: abandonedAt,
                // Per (plan, question), exactly as the answer is: a
                // double-click collapses, a later question on the same
                // plan has its own event_seq.
                idempotencyKey:
                    `${PlanLifecycleAgentEvents.PLAN_DECOMPOSE_QUESTION_ABANDONED}`
                    + `:${planId}:${String(pending.eventSeq)}`,
                payload: {
                    planId,
                    projectId: pending.projectId,
                    question: pending.question,
                    ...(reason !== undefined && reason.length > 0
                        ? { reason }
                        : {}),
                    abandonedAt,
                },
            }];
        },
    );

    // RecordPlanRevision — the plan-scoped chat's "apply this edit"
    // confirm. Emits an agent-keyed PlanGenerated (revision max+1,
    // actor = the confirming operator surface) so the chat edit rides
    // the ENTIRE existing revision machinery: plan-review store, board
    // fold (modal re-renders live), decompose-uses-latest, regenerate
    // history. Nothing overwrites in place.
    cmdBus.register<{ planId?: string; content?: string; summary?: string }>(
        'RecordPlanRevision',
        async (cmd) => {
            const planId = cmd.payload?.planId;
            const content = cmd.payload?.content;
            if (typeof planId !== 'string' || planId.length === 0) {
                throw new Error('RecordPlanRevision: payload.planId is required');
            }
            if (typeof content !== 'string' || content.trim().length === 0) {
                throw new Error('RecordPlanRevision: payload.content must be the complete plan document');
            }
            // Archived plans are read-only: chatting ABOUT one is fine, but
            // an archived plan is by definition not being executed — an
            // edit landing there would silently change nothing on the
            // board and confuse the revision history. Unarchive first.
            assertPlanNotArchived(deps.db, planId, 'RecordPlanRevision');
            let revision = 1;
            let projectId = '';
            if (deps.db) {
                try {
                    const revRow = deps.db
                        .prepare('SELECT MAX(revision) AS rev FROM plan_review_drafts WHERE plan_id = ?')
                        .get(planId) as { rev: number | null } | undefined;
                    if (typeof revRow?.rev === 'number') revision = revRow.rev + 1;
                    const planRow = deps.db
                        .prepare('SELECT pid FROM sidebar_plans WHERE plan_id = ?')
                        .get(planId) as { pid: string | null } | undefined;
                    projectId = planRow?.pid ?? '';
                } catch { /* best-effort — revision 1 / empty project */ }
            }
            const summary = typeof cmd.payload?.summary === 'string'
                ? cmd.payload.summary
                : '';
            const event: Event = {
                type: 'PlanGenerated',
                v: 1,
                occurredAt: deps.clock(),
                idempotencyKey: `chat:PlanGenerated:${planId}:r${revision}:${cmd.issuedAt}`,
                payload: {
                    planId,
                    projectId,
                    actor: cmd.actor,
                    content,
                    revision,
                    ...(summary.length > 0 ? { feedback: summary } : {}),
                },
            };
            return [event];
        },
    );

    // ResumeTask — universal: the handler is identical no matter which
    // agent role parked the task. The flow engine's onTaskResumed picks
    // the resume target out of `paused_step` / `current_step`, so this
    // handler MUST stay agent-role agnostic.
    //
    // This is the ORCHESTRATOR-side handler, which wraps the pure one
    // from core/commands with the side effects that accompany an
    // operator answer: the worktree sidecars, the `remember` ->
    // agent-memory append, and the `ClarificationAnswered` event.
    // Registering `createResumeTaskHandler` directly here (as this line
    // did) left all three dead — the sidecar the clarification protocol
    // doc documents was never written, and the board's "remember this
    // answer" checkbox reached the command and stopped.
    const resumeHandler = createResumeHandler({
        clock: deps.clock,
        logger: deps.logger,
        // No lookup wired (tests, hosts without worktrees) => no
        // sidecar, logged. Everything else still runs.
        worktrees: deps.resumeWorktrees ?? { pathFor: (): undefined => undefined },
        ...(deps.resumeMemory !== undefined ? { memory: deps.resumeMemory } : {}),
        ...(deps.resumeProjectLookup !== undefined
            ? { projectLookup: deps.resumeProjectLookup }
            : {}),
    });
    cmdBus.register(TaskParkingCommands.RESUME_TASK, resumeHandler);

    // AP-IFG-015 — Telegram stage-decision approval callbacks. Each verb the
    // TelegramGateway parses (commit / merge / deploy / context-update) MUST
    // have a registered handler or the operator's tap dispatches a command
    // nobody handles and the bus throws "no handler registered" — the exact
    // gap this closes. Every handler is thin: it re-shapes the `{ taskId }`
    // callback into the same `TaskResumed` gate event the board's Resume path
    // emits, with the verb's fixed decision (approve verbs advance through
    // `on_success` / handleApprovalApprove; reject verbs route through
    // `on_failure` / handleApprovalReject). No new event type is introduced,
    // and the emitted event's idempotencyKey carries the dispatch timestamp
    // (`ResumeTask:<taskId>:<issuedAt>`) so two decisions on the same task
    // never collapse into one deduped event.
    const registerApprovalCallback = (
        commandType: string,
        decision: ResumeTaskDecision,
    ): void => {
        cmdBus.register<ApprovalCallbackPayload>(
            commandType,
            createApprovalCallbackHandler({ clock: deps.clock }, decision),
        );
    };
    registerApprovalCallback(ApprovalCallbackCommands.APPROVE_COMMIT, 'approve');
    registerApprovalCallback(ApprovalCallbackCommands.REJECT_COMMIT, 'reject');
    registerApprovalCallback(ApprovalCallbackCommands.APPROVE_MERGE, 'approve');
    registerApprovalCallback(ApprovalCallbackCommands.REJECT_MERGE, 'reject');
    registerApprovalCallback(ApprovalCallbackCommands.APPROVE_DEPLOY, 'approve');
    registerApprovalCallback(
        ApprovalCallbackCommands.ACCEPT_CONTEXT_UPDATE,
        'approve',
    );
    registerApprovalCallback(
        ApprovalCallbackCommands.REJECT_CONTEXT_UPDATE,
        'reject',
    );

    cmdBus.register<CreateTaskPayload>(Commands.CREATE_TASK, async (cmd) => {
        // Same read-only rule as RecordPlanRevision: tasks added to an
        // archived plan are hidden and unstartable — reject loudly
        // instead of letting the chat/API path create invisible work.
        assertPlanNotArchived(deps.db, cmd.payload.planId, 'CreateTask');
        const taskId = allocateSiblingTaskId(deps, cmd.payload.planId)
            ?? deps.idGen.newId();
        const projectId = projectIdForPlan(deps, cmd.payload.planId);
        const base: TaskCreatedPayload = {
            taskId,
            planId: cmd.payload.planId,
            type: cmd.payload.taskType ?? deps.defaultTaskType,
            flowId: cmd.payload.flowId ?? deps.defaultFlowId,
            ...(projectId !== null ? { projectId } : {}),
        };
        // AP-IFG-001: only spread lineage fields the caller actually
        // supplied. Keeping the payload sparse lets the projection's
        // default-on-read logic stay the single source of truth for
        // legacy-event handling.
        const payload: TaskCreatedPayload = withOperatorTaskFields(
            withLineage(base, cmd.payload),
            cmd.payload,
        );
        const event: Event = {
            type: Events.TASK_CREATED,
            v: 1,
            occurredAt: deps.clock(),
            idempotencyKey: `${Commands.CREATE_TASK}:${taskId}`,
            payload,
        };
        return [event];
    });

    cmdBus.register<UpdateTaskPayload>(Commands.UPDATE_TASK, async (cmd) => {
        const { taskId, investigation_thread, followup_inflight } = cmd.payload;
        if (typeof taskId !== 'string' || taskId.length === 0) {
            throw new Error('UpdateTask: payload.taskId is required');
        }
        const payload: TaskUpdatedPayload = { taskId };
        if (investigation_thread !== undefined) {
            (payload as { investigation_thread: ReadonlyArray<InvestigationThreadEntry> })
                .investigation_thread = investigation_thread;
        }
        if (followup_inflight !== undefined) {
            (payload as { followup_inflight: boolean })
                .followup_inflight = followup_inflight;
        }
        const event: Event = {
            type: Events.TASK_UPDATED,
            v: 1,
            occurredAt: deps.clock(),
            // Deterministic per (taskId, issuedAt) so duplicate dispatches
            // within the same millisecond de-dupe at the event store rather
            // than mutating the projection twice.
            idempotencyKey: `${Commands.UPDATE_TASK}:${taskId}:${cmd.issuedAt}`,
            payload,
        };
        return [event];
    });

    cmdBus.register<ApproveTaskPayload>(Commands.APPROVE_TASK, async (cmd, state) => {
        // "Approve" means two different things, and sending the wrong
        // event for the state is a SILENT no-op.
        //
        //   not started yet      -> TaskApproved starts the flow
        //   held at the APPROVAL GATE -> the engine is waiting for a
        //                          TaskResumed; TaskApproved is
        //                          discarded by onTaskApproved's
        //                          `flowStateExists` short-circuit
        //
        // Field report: I approved a task in the Telegram app and it
        // did not start. The Telegram approval keyboard sends
        // ApproveTask for BOTH states, where the board sends ResumeTask
        // for the second one - so every gate approval from Telegram was
        // dropped without a log line.
        //
        // Fixed HERE rather than in the Telegram keyboard because this
        // is the one choke point every producer goes through - the
        // board's own race when its in-memory parkedReason is stale,
        // the chat assistant, the HTTP API, and the Approve buttons
        // already sitting in the operator's Telegram history, which
        // keep sending the old callback forever.
        const gateStep = approvalGateParkedStep(deps.db, cmd.payload.taskId);
        // ONLY an operator can satisfy an approval gate.
        //
        // `TaskCreated -> ApproveTask` is an automatic cascade (actor
        // 'orchestrator'): every task a decomposition produces gets an
        // ApproveTask a few hundred milliseconds after the engine parks
        // its first step at the gate. Routing THAT to a resume approves
        // the gate the pipeline just raised, and the first task of every
        // plan starts with no operator involvement at all - which is
        // what happened in the field: "the first task started without my
        // approval". The engine's old silent `flowStateExists` return
        // was load-bearing for exactly this cascade.
        //
        // A WHITELIST of operator actors, not a blacklist of automated
        // ones, because the two failure directions are not comparable:
        // an actor missing from this list leaves a task parked (visible,
        // recoverable, one more click), while an automated actor missing
        // from a blacklist runs an agent against a repo nobody approved.
        if (gateStep !== null && !isOperatorActor(cmd.actor)) {
            // Falls through to the plain TaskApproved below, exactly as
            // before this routing existed: the engine discards it for a
            // task that already has flow_state, and the task stays
            // parked for the operator.
            deps.logger.info(
                'ApproveTask: task is at the approval gate — not releasing it'
                + ' for a non-operator actor',
                { taskId: cmd.payload.taskId, stepId: gateStep, actor: cmd.actor },
            );
        } else if (gateStep !== null) {
            deps.logger.info('ApproveTask: task is at the approval gate — resuming', {
                taskId: cmd.payload.taskId,
                stepId: gateStep,
                actor: cmd.actor,
            });
            const resumeCmd: Command<ResumeTaskPayload> = {
                ...cmd,
                type: TaskParkingCommands.RESUME_TASK,
                payload: { taskId: cmd.payload.taskId, decision: 'approve' },
            };
            return resumeHandler(resumeCmd, state);
        }
        const payload: TaskApprovedPayload = {
            taskId: cmd.payload.taskId,
            flowId: cmd.payload.flowId,
        };
        const event: Event = {
            type: Events.TASK_APPROVED,
            v: 1,
            occurredAt: deps.clock(),
            // Include `issuedAt` so each Approve click is a fresh
            // event — without it a re-approve after a reset (or after
            // a Cancel + re-decompose) collides with the original
            // TaskApproved's key and never persists a new row. The
            // bus's dispatch path still fires subscribers on the old
            // seq, but follow-up forensics (replay debugging,
            // per-attempt audit) are easier when every click has its
            // own event row.
            idempotencyKey: `${Commands.APPROVE_TASK}:${cmd.payload.taskId}:${cmd.issuedAt}`,
            payload,
        };
        return [event];
    });

    cmdBus.register<StartAgentPayload>(FlowCommands.START_AGENT, async (cmd) => {
        // Build the task-agent prompt from the persisted task + plan
        // context. Falls back to the legacy placeholder string only when
        // no DB handle is wired (tests) or the task row doesn't exist
        // (which would itself be a bug the agent should fail fast on).
        const payload = cmd.payload;
        const ctxArgs = payload.context ?? {};
        const rejectFeedback = typeof ctxArgs.rejectFeedback === 'string'
            ? (ctxArgs.rejectFeedback as string)
            : undefined;
        const investigationAnswer = typeof ctxArgs.investigationAnswer === 'string'
            ? (ctxArgs.investigationAnswer as string)
            : undefined;
        const humanAnswer = typeof ctxArgs.humanAnswer === 'string'
            ? (ctxArgs.humanAnswer as string)
            : undefined;
        const baseCtx = deps.db
            ? readTaskAgentContext(deps.db, payload.agent, payload.taskId, payload.stepId, {
                ...(rejectFeedback !== undefined ? { rejectFeedback } : {}),
                ...(investigationAnswer !== undefined ? { investigationAnswer } : {}),
                ...(humanAnswer !== undefined ? { humanAnswer } : {}),
            })
            : null;
        // Layer the workspace-layout fields onto the base context. The
        // worktreePath isn't known until resolveTaskRepoSpec resolves,
        // so seed it null here and stamp it on inside the resolver
        // continuation below.
        const workspaceRepos = deps.listWorkspaceRepos?.() ?? [];
        const personaOverride = deps.resolveAgentPrompt?.(payload.agent);
        // Deliverable output folder (migration 038). Created before the
        // prompt is built, not lazily on first write: an agent trusts a
        // path that exists far more than one it has to mkdir, and the
        // report that triggered this feature shows what an agent does
        // when it has to pick a location for itself.
        const outputDir = typeof deps.taskOutputsRoot === 'string'
            && deps.taskOutputsRoot.length > 0
            ? taskOutputDir(deps.taskOutputsRoot, payload.taskId)
            : null;
        if (outputDir !== null) {
            try {
                fs.mkdirSync(outputDir, { recursive: true });
            } catch (err) {
                deps.logger.warn(
                    'orchestrator: failed to create the task output folder',
                    {
                        taskId: payload.taskId,
                        outputDir,
                        error: err instanceof Error ? err.message : String(err),
                    },
                );
            }
        }
        const ctx: TaskAgentContext | null = baseCtx === null
            ? null
            : {
                ...baseCtx,
                ...(workspaceRepos.length > 0 ? { workspaceRepos } : {}),
                ...(personaOverride ? { personaOverride } : {}),
                ...(outputDir !== null ? { taskOutputDir: outputDir } : {}),
            };

        const initialPrompt = ctx
            ? assembleTaskAgentPrompt(ctx)
            : `step ${payload.stepId} for task ${payload.taskId}`;

        const metadata: Record<string, unknown> = {
            taskId: payload.taskId,
            stepId: payload.stepId,
            model: payload.model,
            ...(payload.context ?? {}),
        };

        // The task repo's GitHub account, for the agent's OWN git and
        // gh calls. Resolved once per launch rather than per use so a
        // mid-run config change cannot split one agent across two
        // identities.
        const githubEnv = deps.githubEnvForTask?.(payload.taskId) ?? {};
        const launch = (finalPrompt: string, cwd?: string): void => {
            const spec: AgentSpec = {
                role: payload.agent,
                prompt: finalPrompt,
                metadata,
                ...(cwd !== undefined ? { cwd } : {}),
                ...(Object.keys(githubEnv).length > 0 ? { env: githubEnv } : {}),
            };
            deps.deferAgentStart(() => {
                const handle = deps.agentRunner.start(spec);
                deps.registerAgent(handle.id, payload.taskId);
            });
        };

        // Repo block resolution mirrors the lifecycle path: when both the
        // resolver and a RepoReader are wired, await the resolved spec,
        // read the working tree, and re-assemble the prompt with the
        // # Repository context block. On any failure, fall back to the
        // initial prompt so the agent at least gets the task + plan
        // context (degrades gracefully instead of spawning blank).
        if (ctx && deps.repoReader && deps.resolveTaskRepoSpec) {
            const reader = deps.repoReader;
            void deps.resolveTaskRepoSpec(payload.taskId)
                .catch((err) => {
                    deps.logger.warn(
                        'orchestrator: resolveTaskRepoSpec rejected; spawning without repo block',
                        {
                            taskId: payload.taskId,
                            error: err instanceof Error ? err.message : String(err),
                        },
                    );
                    return null;
                })
                .then(async (spec) => {
                    if (!spec) {
                        launch(initialPrompt);
                        return;
                    }
                    // Worktree path is now resolved — fold it into the
                    // context so the `# Workspace layout` block can
                    // declare the agent's cwd in concrete terms.
                    let ctxWithWt: TaskAgentContext = {
                        ...ctx,
                        worktreePath: spec.repoPath,
                    };
                    // Materialise operator attachments (migration 021) into
                    // <worktree>/attachments/ so the agent can Read the
                    // screenshots / specs the operator pinned to this task
                    // (or its plan). Refs flow into both TASK.md and the
                    // prompt's `# Attachments` block. Best-effort.
                    if (deps.attachmentStore && deps.attachmentBlobStore) {
                        const refs = await materializeTaskAttachments(
                            spec.repoPath,
                            payload.taskId,
                            ctx.planId ?? null,
                            deps.attachmentStore,
                            deps.attachmentBlobStore,
                            deps.logger,
                        );
                        if (refs.length > 0) {
                            ctxWithWt = { ...ctxWithWt, attachments: refs };
                        }
                    }
                    // Write TASK.md to the worktree root before the
                    // agent spawns. Every retained agent persona
                    // (developer / reviewer / tester / committer)
                    // instructs the agent to "Read TASK.md thoroughly"
                    // — the file is the source of truth the agent
                    // expects to find at its cwd. Without it the agent
                    // either hallucinates a guess or asks the operator
                    // a NEEDS_HUMAN_INPUT question about where TASK.md
                    // lives. The prompt also carries the same context
                    // for redundancy, but writing the file matches the
                    // persona's mental model exactly.
                    writeTaskMd(spec.repoPath, ctxWithWt, deps.logger);
                    try {
                        const repoRead = await reader.read(spec);
                        const repoBlock = renderRepoBlock(
                            repoRead.claudeMd,
                            repoRead.tree,
                            repoRead.sampleFiles,
                        );
                        launch(
                            assembleTaskAgentPrompt({ ...ctxWithWt, repoBlock }),
                            spec.repoPath,
                        );
                    } catch (err) {
                        deps.logger.warn(
                            'orchestrator: RepoReader.read failed; spawning without repo block',
                            {
                                taskId: payload.taskId,
                                error: err instanceof Error ? err.message : String(err),
                            },
                        );
                        launch(
                            assembleTaskAgentPrompt(ctxWithWt),
                            spec.repoPath,
                        );
                    }
                });
            return [];
        }
        launch(initialPrompt);
        return [];
    });

    cmdBus.register<FailTaskPayload>(FlowCommands.FAIL_TASK, async (cmd) => {
        deps.logger.warn('orchestrator: task failed', {
            taskId: cmd.payload.taskId,
            reason: cmd.payload.reason,
        });
        return [];
    });

    cmdBus.register<RequestInvestigationPayload>(
        FlowCommands.REQUEST_INVESTIGATION,
        async (cmd) => {
            // Two paths exist for answering an AgentQuestion:
            //
            //   1. Operator path (always wired): TaskParked publishes
            //      reason='clarification' alongside this command; the
            //      board surfaces a yellow stage chip + clarify modal,
            //      and the operator's reply lands as TaskResumed with
            //      `humanAnswer` threaded onto the next StartAgent.
            //
            //   2. Investigator path (NOT YET WIRED): an investigator
            //      agent could be spawned with the question + task
            //      context, then bridge its AgentFinished into an
            //      InvestigationCompleted event. The
            //      InvestigatorAgent port + agents/investigator.CLAUDE.md
            //      persona exist; the spawn+bridge wiring does not. A
            //      follow-up task should wire it so simple questions
            //      get auto-answered without operator interrupt.
            //
            // Until path 2 lands, this handler is a structured-log
            // checkpoint so the operator can confirm the question
            // surfaced and verify the board chip flipped to yellow.
            deps.logger.info(
                'orchestrator: investigation requested — operator-clarify modal is the only wired answer path',
                {
                    taskId: cmd.payload.taskId,
                    resumeStep: cmd.payload.resumeStep,
                    question: cmd.payload.question,
                },
            );
            return [];
        },
    );

    // task.finish is reserved for future explicit finish flows; the engine
    // does not currently dispatch it (terminal `emit:` directives bypass the
    // command bus). Registered as a no-op so an upstream change cannot crash
    // the orchestrator with "no handler for command".
    cmdBus.register(FlowCommands.FINISH_TASK, async () => []);

    // ---------------------------------------------------------------------
    // AP-PAO-004 — direct task / plan / project lifecycle commands.
    //
    // Each handler is a thin event emitter: mutate state via the projection
    // (the registry for project files; the event log itself for task/plan
    // transitions), then publish the corresponding event for downstream
    // subscribers. Idempotency keys are deterministic per (entity-id,
    // issuedAt) so a duplicate operator click within the same millisecond
    // de-dupes at the event store (UNIQUE on idempotency_key) without
    // blocking a legitimate later action on the same entity.
    // ---------------------------------------------------------------------

    cmdBus.register<SkipTaskPayload>(TaskOpsCommands.SKIP_TASK, async (cmd) => {
        if (!isSkipTaskPayload(cmd.payload)) {
            throw new Error('SkipTask: invalid payload');
        }
        const { taskId } = cmd.payload;
        const payload: TaskSkippedPayload = { taskId };
        const event: Event = {
            type: Events.TASK_SKIPPED,
            v: 1,
            occurredAt: deps.clock(),
            idempotencyKey: `${TaskOpsCommands.SKIP_TASK}:${taskId}:${cmd.issuedAt}`,
            payload,
        };
        return [event];
    });

    cmdBus.register<RetryTaskPayload>(TaskOpsCommands.RETRY_TASK, async (cmd) => {
        if (!isRetryTaskPayload(cmd.payload)) {
            throw new Error('RetryTask: invalid payload');
        }
        const { taskId } = cmd.payload;
        const payload: TaskRetriedPayload = { taskId };
        const event: Event = {
            type: Events.TASK_RETRIED,
            v: 1,
            occurredAt: deps.clock(),
            idempotencyKey: `${TaskOpsCommands.RETRY_TASK}:${taskId}:${cmd.issuedAt}`,
            payload,
        };
        return [event];
    });

    // MarkTaskComplete — operator override that emits TaskFinished for
    // the supplied taskId. Same wire shape the flow engine emits at an
    // `emit:TaskFinished` terminal, so the projection-tasks subscriber
    // flips status to 'done' and the dependency store's TaskFinished
    // hook marks every outgoing edge merged. Idempotency keys on
    // (taskId, issuedAt) so a duplicate click within the same
    // millisecond de-dups at the event store. Used to recover tasks
    // whose flow stalls past the work-completion point with no
    // automatic path forward (e.g. an integration-test task whose
    // tester succeeded but downstream steps were trimmed out).
    cmdBus.register<MarkTaskCompletePayload>(
        TaskOpsCommands.MARK_TASK_COMPLETE,
        async (cmd) => {
            if (!isMarkTaskCompletePayload(cmd.payload)) {
                throw new Error('MarkTaskComplete: invalid payload');
            }
            const { taskId } = cmd.payload;
            const event: Event = {
                type: Events.TASK_FINISHED,
                v: 1,
                occurredAt: deps.clock(),
                idempotencyKey: `${TaskOpsCommands.MARK_TASK_COMPLETE}:${taskId}:${cmd.issuedAt}`,
                payload: { taskId },
            };
            return [event];
        },
    );

    // PreApproveTask — operator approved a task still parked on its
    // dependencies. Emits TaskPreApproved; the projection subscriber sets
    // `tasks.pre_approved = 1`, and the engine's approval gate consumes
    // it to auto-start the task when its upstreams merge (the unblock
    // pass re-dispatches it). Idempotency keys on (taskId, issuedAt).
    cmdBus.register<PreApproveTaskPayload>(
        TaskOpsCommands.PRE_APPROVE_TASK,
        async (cmd) => {
            if (!isPreApproveTaskPayload(cmd.payload)) {
                throw new Error('PreApproveTask: invalid payload');
            }
            const { taskId } = cmd.payload;
            const event: Event = {
                type: Events.TASK_PRE_APPROVED,
                v: 1,
                occurredAt: deps.clock(),
                idempotencyKey: `${TaskOpsCommands.PRE_APPROVE_TASK}:${taskId}:${cmd.issuedAt}`,
                payload: { taskId },
            };
            return [event];
        },
    );

    // SetTaskInstructions — operator added free-text instructions/remarks to
    // a task (typically before it starts). The projection writes
    // `tasks.instructions`; readTaskAgentContext folds it into the agent
    // prompt's `# Operator instructions` block. Idempotency keys on
    // (taskId, issuedAt) so a duplicate dispatch de-dups but a later edit
    // (new issuedAt) lands as a fresh event.
    cmdBus.register<SetTaskInstructionsPayload>(
        TaskOpsCommands.SET_TASK_INSTRUCTIONS,
        async (cmd) => {
            if (!isSetTaskInstructionsPayload(cmd.payload)) {
                throw new Error('SetTaskInstructions: invalid payload');
            }
            const { taskId, instructions } = cmd.payload;
            // Instructions added to a task that has ALREADY run are the
            // `interrupt-restart` case: the operator stopped an agent
            // going the wrong way and is telling the next run what to do
            // differently. That is project-level feedback — the same
            // mistake is worth not repeating in the next plan — so it goes
            // into agent memory too, not only into this task's prompt.
            //
            // Instructions written BEFORE the first run are deliberately
            // NOT recorded: those are task scope, not a correction, and
            // filing every up-front brief as "prior operator feedback"
            // would drown the real corrections.
            await recordInstructionsAsMemory(deps, taskId, instructions);
            const event: Event = {
                type: Events.TASK_INSTRUCTIONS_SET,
                v: 1,
                occurredAt: deps.clock(),
                idempotencyKey: `${TaskOpsCommands.SET_TASK_INSTRUCTIONS}:${taskId}:${cmd.issuedAt}`,
                payload: { taskId, instructions },
            };
            return [event];
        },
    );

    // SetPlanRepo — re-point a plan at a different repo. `metadata.targetRepo`
    // decides the worktree for every task under the plan that has no repo of
    // its own, so the operator (plan modal) and the chat agent both need to
    // be able to correct it after the fact.
    //
    // The merge is the whole reason this is a command and not a plain
    // UpdatePlan: the plans projection does `metadata = COALESCE(@metadata,
    // metadata)`, i.e. a supplied blob REPLACES the stored one. A caller
    // sending `{targetRepo}` alone would wipe planType, conventions,
    // techStack and the impact-check warnings. Doing it here means no caller
    // has to know that.
    cmdBus.register<SetPlanRepoPayload>(
        PlanLifecycleCommands.SET_PLAN_REPO,
        async (cmd) => {
            if (!isSetPlanRepoPayload(cmd.payload)) {
                throw new Error('SetPlanRepo: invalid payload');
            }
            const { planId, repoId } = cmd.payload;
            if (!deps.db) throw new Error('SetPlanRepo: no database wired');
            const row = deps.db
                .prepare('SELECT metadata FROM sidebar_plans WHERE plan_id = ?')
                .get(planId) as { metadata?: string | null } | undefined;
            if (!row) {
                // Never fail silently: an unknown plan id means the caller
                // (a chat agent naming a plan, a stale board tab) is wrong,
                // and a no-op event would look like it worked.
                throw new Error(`SetPlanRepo: unknown plan ${planId}`);
            }
            let metadata: Record<string, unknown> = {};
            if (row.metadata) {
                try {
                    const parsed = JSON.parse(row.metadata) as unknown;
                    if (parsed && typeof parsed === 'object') {
                        metadata = { ...(parsed as Record<string, unknown>) };
                    }
                } catch {
                    deps.logger.warn(
                        'SetPlanRepo: stored plan metadata is unparseable — replacing it',
                        { planId },
                    );
                }
            }
            // Empty string CLEARS, which is different from "leave alone" —
            // the plan then falls back to whatever each task carries.
            if (repoId.length > 0) metadata.targetRepo = repoId;
            else delete metadata.targetRepo;
            deps.logger.info('SetPlanRepo: re-pointing plan', {
                planId,
                repoId: repoId.length > 0 ? repoId : '(cleared)',
                actor: cmd.actor,
            });
            const event: Event = {
                type: 'PlanUpdated',
                v: 1,
                occurredAt: deps.clock(),
                // issuedAt in the key so a correction after a wrong pick
                // lands as its own event instead of de-duping away.
                idempotencyKey:
                    `${PlanLifecycleCommands.SET_PLAN_REPO}:${planId}:${cmd.issuedAt}`,
                payload: { planId, metadata, actor: cmd.actor },
            };
            return [event];
        },
    );

    // Attachment lifecycle (migration 021). The worker-api router has
    // already written the bytes to the blob store and minted the id; these
    // handlers are pure — they just lift the metadata onto an
    // `AttachmentAdded` event. The attachments-projection subscriber
    // (main.ts) folds it into the `attachments` table, and the board sees
    // it live over SSE. Idempotency keys on the attachmentId (which is
    // unique per upload) so a duplicate dispatch de-dups at the store.
    const registerAttach = (
        commandType: string,
        ownerType: AttachmentOwnerType,
    ): void => {
        cmdBus.register<AttachToOwnerPayload>(commandType, async (cmd) => {
            if (!isAttachToOwnerPayload(cmd.payload)) {
                throw new Error(`${commandType}: invalid payload`);
            }
            const p = cmd.payload;
            const event: Event = {
                type: Events.ATTACHMENT_ADDED,
                v: 1,
                occurredAt: deps.clock(),
                // Keyed on the attachment id, which is unique per upload
                // AND per harvested output (the harvest mints one per
                // file+content), so a duplicate dispatch de-dups at the
                // store without swallowing a genuinely new file.
                idempotencyKey: `${Events.ATTACHMENT_ADDED}:${p.attachmentId}`,
                payload: {
                    attachmentId: p.attachmentId,
                    ownerType,
                    ownerId: p.ownerId,
                    fileName: p.fileName,
                    contentType: p.contentType,
                    sizeBytes: p.sizeBytes,
                    storageKey: p.storageKey,
                    caption: p.caption ?? null,
                    createdAt: deps.clock(),
                    // Migration 038. The command carries it only for the
                    // output harvest; every operator upload omits it and
                    // means 'input'.
                    kind: p.kind ?? 'input',
                },
            };
            return [event];
        });
    };
    registerAttach(AttachmentCommands.ATTACH_TO_TASK, 'task');
    registerAttach(AttachmentCommands.ATTACH_TO_PLAN, 'plan');
    // Architect tier: design input pinned to a requirement. Every
    // command type dispatched anywhere needs a registered handler, and
    // the attachments route dispatches this one the moment the board
    // offers the control.
    registerAttach(AttachmentCommands.ATTACH_TO_REQUIREMENT, 'requirement');

    cmdBus.register<RemoveAttachmentPayload>(
        AttachmentCommands.REMOVE_ATTACHMENT,
        async (cmd) => {
            if (!isRemoveAttachmentPayload(cmd.payload)) {
                throw new Error('RemoveAttachment: invalid payload');
            }
            const { attachmentId, ownerType, ownerId } = cmd.payload;
            const event: Event = {
                type: Events.ATTACHMENT_REMOVED,
                v: 1,
                occurredAt: deps.clock(),
                idempotencyKey: `${Events.ATTACHMENT_REMOVED}:${attachmentId}:${cmd.issuedAt}`,
                payload: { attachmentId, ownerType, ownerId },
            };
            return [event];
        },
    );

    cmdBus.register<ArchivePlanPayload>(PlanOpsCommands.ARCHIVE_PLAN, async (cmd) => {
        if (!isArchivePlanPayload(cmd.payload)) {
            throw new Error('ArchivePlan: invalid payload');
        }
        const { planId } = cmd.payload;
        const payload: PlanArchivedPayload = { planId };
        const event: Event = {
            type: Events.PLAN_ARCHIVED,
            v: 1,
            occurredAt: deps.clock(),
            idempotencyKey: `${PlanOpsCommands.ARCHIVE_PLAN}:${planId}:${cmd.issuedAt}`,
            payload,
        };
        return [event];
    });

    // Implement / Dismiss on an investigation or review report.
    //
    // Implement fans the report out through the DECOMPOSER rather than
    // scaffolding one monolithic task: it creates a FRESH plan
    // ("Implement findings of <task>", inheriting the source plan's
    // targetRepo) and spawns the decomposer over the report markdown —
    // each finding becomes its own task with dependencies, ticket
    // fields and per-task repo resolution. A fresh plan (rather than
    // decomposing into the source plan) avoids task-id collisions with
    // the plan's existing tasks and the per-(planId, revision) dedup
    // that would silently drop a second decomposition.
    //
    // The report store reads durable state: the InvestigationCompleted
    // event's answer, or the report-producing agent's
    // task_step_summaries row (the same fallback the View-report modal
    // renders, so whatever the operator saw is what gets decomposed).
    cmdBus.register<ImplementFromInvestigationPayload>(
        InvestigationCommands.IMPLEMENT_FROM_INVESTIGATION,
        async (cmd) => {
            if (!isImplementFromInvestigationPayload(cmd.payload)) {
                throw new Error('ImplementFromInvestigation: invalid payload');
            }
            const { taskId: sourceTaskId, reportId } = cmd.payload;
            const reports = createDbInvestigationReportStore(deps.db, deps.reportRoles?.());
            const report = reports.get(sourceTaskId, reportId);
            if (!report) {
                throw new Error(
                    `ImplementFromInvestigation: no report "${reportId}" for task "${sourceTaskId}"`,
                );
            }
            // Source task → its plan → projectId + targetRepo to inherit.
            const srcTask = deps.db
                ?.prepare('SELECT plan_id FROM tasks WHERE id = ?')
                .get(sourceTaskId) as { plan_id: string | null } | undefined;
            const srcPlan = srcTask?.plan_id
                ? (deps.db
                    ?.prepare('SELECT pid, metadata FROM sidebar_plans WHERE plan_id = ?')
                    .get(srcTask.plan_id) as
                    | { pid: string | null; metadata: string | null }
                    | undefined)
                : undefined;
            const projectId = srcPlan?.pid ?? deps.defaultProjectId;
            let targetRepo: string | undefined;
            try {
                const md = srcPlan?.metadata ? JSON.parse(srcPlan.metadata) : {};
                if (typeof (md as { targetRepo?: unknown }).targetRepo === 'string') {
                    targetRepo = (md as { targetRepo: string }).targetRepo;
                }
            } catch { /* tolerate malformed metadata */ }

            const at = deps.clock();
            const planId = `plan-impl-${sourceTaskId}-${at}`;
            const title = `Implement findings of ${sourceTaskId}`;
            const planCreated: Event = {
                type: 'PlanCreated',
                v: 1,
                occurredAt: at,
                idempotencyKey:
                    `${InvestigationCommands.IMPLEMENT_FROM_INVESTIGATION}:${planId}`,
                payload: {
                    planId,
                    projectId,
                    title,
                    body: report.markdown,
                    metadata: {
                        planType: 'feature',
                        sourceTaskId,
                        sourceReportId: reportId,
                        ...(targetRepo !== undefined ? { targetRepo } : {}),
                    },
                    actor: cmd.actor,
                },
            };
            startLifecycleAgent(deps, {
                kind: 'decomposer',
                role: decomposerRole,
                model: decomposerModel,
                planId,
                projectId,
                approvedContent:
                    `# Implement the findings below (from ${sourceTaskId})\n\n${report.markdown}`,
            });
            return [planCreated];
        },
    );
    cmdBus.register<DismissInvestigationPayload>(
        InvestigationCommands.DISMISS_INVESTIGATION,
        createDismissInvestigationHandler({ clock: deps.clock }),
    );

    // AskInvestigationFollowup — the operator's follow-up question after
    // reading an investigation (or review) report. Route + modal existed;
    // nothing handled the command. Spawns a NEW investigate task in the
    // source task's plan whose brief carries the question plus the prior
    // report, and whose TaskCreated payload records the running Q&A
    // thread (prior thread + prior answer + this question) so the
    // follow-up modal can render the conversation.
    cmdBus.register<AskInvestigationFollowupPayload>(
        NoteOpsCommands.ASK_INVESTIGATION_FOLLOWUP,
        async (cmd) => {
            if (!isAskInvestigationFollowupPayload(cmd.payload)) {
                throw new Error('AskInvestigationFollowup: invalid payload');
            }
            const { taskId: sourceTaskId, question } = cmd.payload;
            const at = deps.clock();
            const src = deps.db
                ?.prepare('SELECT plan_id FROM tasks WHERE id = ?')
                .get(sourceTaskId) as { plan_id: string | null } | undefined;
            const planId = src?.plan_id ?? sourceTaskId;
            const report = createDbInvestigationReportStore(deps.db, deps.reportRoles?.())
                .get(sourceTaskId, '');
            const priorThread = deps.db
                ? readInvestigationThreadSeed(deps.db, sourceTaskId)
                : [];
            const thread: InvestigationThreadEntry[] = [
                ...priorThread,
                ...(report
                    ? [{ role: 'assistant', content: report.markdown, timestamp: at }]
                    : []),
                { role: 'user', content: question, timestamp: at },
            ];
            const newTaskId = deps.idGen.newId();
            const shortQ = question.replace(/\s+/g, ' ').trim().slice(0, 60);
            const description = [
                '# Follow-up question',
                '',
                question,
                ...(report
                    ? ['', `# Prior investigation report (${sourceTaskId})`, '', report.markdown]
                    : []),
            ].join('\n');
            const event: Event = {
                type: Events.TASK_CREATED,
                v: 1,
                occurredAt: at,
                idempotencyKey:
                    `${NoteOpsCommands.ASK_INVESTIGATION_FOLLOWUP}:${sourceTaskId}:${cmd.issuedAt}`,
                payload: {
                    taskId: newTaskId,
                    planId,
                    type: 'investigate',
                    flowId: 'investigate',
                    title: `Follow-up: ${shortQ}`,
                    description,
                    parent_task_id: sourceTaskId,
                    spawn_reason: 'investigation-followup',
                    source_investigation_id: sourceTaskId,
                    investigation_thread: thread,
                },
            };
            return [event];
        },
    );

    // UnarchivePlan — inverse of ArchivePlan: clears archived_at so the
    // plan re-enters the active board sections (classified by its task
    // states as usual). Review drafts removed at archive time are NOT
    // restored — an unarchived plan may need a fresh planner run.
    cmdBus.register<UnarchivePlanPayload>(
        PlanOpsCommands.UNARCHIVE_PLAN,
        async (cmd) => {
            if (!isUnarchivePlanPayload(cmd.payload)) {
                throw new Error('UnarchivePlan: invalid payload');
            }
            const { planId } = cmd.payload;
            const payload: PlanUnarchivedPayload = { planId };
            const event: Event = {
                type: Events.PLAN_UNARCHIVED,
                v: 1,
                occurredAt: deps.clock(),
                idempotencyKey:
                    `${PlanOpsCommands.UNARCHIVE_PLAN}:${planId}:${cmd.issuedAt}`,
                payload,
            };
            return [event];
        },
    );

    // DeletePlan: the board-ui's AP-IFG-008 command surface also owns a
    // 'DeletePlan' command that emits the same 'PlanDeleted' event (with a
    // richer `{planId, actor}` payload). Production wiring registers
    // `registerBoardUiCommands` BEFORE `registerCommandHandlers`, so when
    // both are present we defer to the board-ui's handler and skip our
    // registration cleanly rather than tripping CommandBus's duplicate-
    // handler guard. Test harnesses that only wire the orchestrator's
    // handlers still exercise this branch.
    try {
        cmdBus.register<DeletePlanPayload>(PlanOpsCommands.DELETE_PLAN, async (cmd) => {
            if (!isDeletePlanPayload(cmd.payload)) {
                throw new Error('DeletePlan: invalid payload');
            }
            const { planId } = cmd.payload;
            const payload: PlanDeletedPayload = { planId };
            const event: Event = {
                type: Events.PLAN_DELETED,
                v: 1,
                occurredAt: deps.clock(),
                idempotencyKey: `${PlanOpsCommands.DELETE_PLAN}:${planId}:${cmd.issuedAt}`,
                payload,
            };
            return [event];
        });
    } catch (err) {
        deps.logger.info('orchestrator: DeletePlan handler already registered, deferring', {
            error: err instanceof Error ? err.message : String(err),
        });
    }

    // UpdateProjectApprovalOverride — only wired when the host supplies a
    // store. The handler persists via the store (which in production is a
    // `ProjectRegistry`) BEFORE emitting the event, so any validation
    // error inside the registry (e.g. unknown projectId, malformed leaf
    // value) aborts the dispatch without polluting the event log.
    if (deps.approvalOverrideStore) {
        const store = deps.approvalOverrideStore;
        cmdBus.register<UpdateProjectApprovalOverridePayload>(
            ProjectOpsCommands.UPDATE_PROJECT_APPROVAL_OVERRIDE,
            async (cmd) => {
                if (!isUpdateProjectApprovalOverridePayload(cmd.payload)) {
                    throw new Error('UpdateProjectApprovalOverride: invalid payload');
                }
                const { projectId, approvalOverride } = cmd.payload;
                store.updateApprovalOverride(projectId, approvalOverride);
                // Emitted through the UnknownEvent envelope: the
                // discriminated variant declared in core/events/event.ts
                // (AP-PAO-002) narrows `approvalOverride` to the simpler
                // 'approve' | 'reject' | null shape from a different
                // operator surface. The command/registry contract here
                // carries the richer per-flow / per-step map, so we
                // emit on the open envelope and let consumers narrow on
                // payload shape rather than the event-type variant.
                const event: UnknownEvent = {
                    type: Events.PROJECT_APPROVAL_OVERRIDE_UPDATED,
                    v: 1,
                    occurredAt: deps.clock(),
                    idempotencyKey: `${ProjectOpsCommands.UPDATE_PROJECT_APPROVAL_OVERRIDE}:${projectId}:${cmd.issuedAt}`,
                    payload: { projectId, approvalOverride },
                };
                return [event];
            },
        );
    }

    // AP-IFG-007: RequestInvestigationFollowup. Only registered when the
    // host wires both a lineage store AND an investigator adapter — the
    // command depends on both to gate re-entry and to run the agent.
    //
    // AP-VP5-006: when the host also wires `investigationHistoryPath`, the
    // investigator adapter is decorated with a per-turn JSONL persister so
    // each follow-up's operator question (before spawn) and investigator
    // reply (after completion) lands on `<worktree>/investigation-history.jsonl`
    // alongside the in-memory lineage thread. The persister is layered on the
    // investigator (not on the command handler) so the inner handler's
    // lineage-store contract — its `followup_inflight` gate and the
    // `InvestigationFollowupRequested` event it emits — stays untouched.
    if (deps.taskLineage && deps.investigatorAgent) {
        const investigator: InvestigatorAgent =
            deps.investigationHistoryPath !== undefined
                ? wrapInvestigatorWithHistoryFile(
                      deps.investigatorAgent,
                      deps.investigationHistoryPath,
                      deps.clock,
                  )
                : deps.investigatorAgent;
        cmdBus.register<RequestInvestigationFollowupPayload>(
            InvestigationFollowupCommands.REQUEST_INVESTIGATION_FOLLOWUP,
            createRequestInvestigationFollowupHandler({
                clock: deps.clock,
                lineage: deps.taskLineage,
                investigator,
            }),
        );
    }

    // AP-VP5-007: per-project notes board CRUD + promote/convert.
    // Only registered when a NotesStore is wired — hosts without
    // per-project filesystem persistence (the synchronous-only unit
    // harness) skip the surface entirely. The Linear-document mirror is
    // a separate optional port; this phase only the fake adapter
    // satisfies it.
    if (deps.notesStore) {
        const notesDeps = {
            clock: deps.clock,
            idGen: deps.idGen,
            logger: deps.logger,
            store: deps.notesStore,
            ...(deps.notesDocumentSync !== undefined
                ? { documentSync: deps.notesDocumentSync }
                : {}),
        };
        registerNotesHandlers(cmdBus, notesDeps);
    }
}

/**
 * AP-VP5-006 — `<worktree>/investigation-history.jsonl` line shape.
 *
 * Mirrors v1's append-only history file: one JSON object per line with the
 * speaker `role`, the literal message `content`, the epoch-ms `timestamp`,
 * and the per-task `threadId` that ties every turn on a single task back
 * to a stable identifier. v1 carried a separate `task.investigation_thread_id`
 * column on the task record; v2 derives the same identity from `taskId`
 * (which is itself stable across all follow-up turns), so the read side
 * never needs a join to recover the thread.
 */
export interface InvestigationHistoryLine {
    readonly role: string;
    readonly content: string;
    readonly timestamp: number;
    readonly threadId: string;
}

/**
 * AP-VP5-006 — decorate an {@link InvestigatorAgent} with the per-turn
 * `investigation-history.jsonl` writer.
 *
 * Behaviour per call:
 *
 *   - Resolve the absolute history-file path for the task; when the resolver
 *     returns `undefined` (e.g. the task has no worktree yet), persistence
 *     is a no-op and only the inner investigator runs.
 *   - On the FIRST follow-up for the task (the file does not yet exist),
 *     create the parent directory and seed the file with the
 *     command-payload's `priorBrief` (as an `operator` line) and
 *     `priorReport` (as an `investigator` line). Either or both may be
 *     absent — in which case the seed is skipped for that side. This is
 *     v2's stand-in for v1's "seed from the original investigation
 *     completion event" hint.
 *   - Always append the operator's NEW question — the inner handler has
 *     already appended it to `input.thread` as the last entry — BEFORE the
 *     real investigator runs. AC #2 ("one operator line before spawn").
 *   - Run the inner investigator. The thread the inner handler passes is
 *     `[...priorThread, operatorEntry]`, so the spawn prompt mirrors AC #3
 *     ("full thread as prior conversation context") regardless of whether
 *     the file persistence is enabled.
 *   - On completion, append `{ role: 'investigator', content: answer, ... }`.
 *     A throw from the inner investigator propagates unchanged — no
 *     investigator line is appended, matching the inner handler's contract
 *     that only successful turns survive in the thread.
 *
 * The `threadId` on every persisted line is `input.taskId`. Stable, never
 * null, and trivially "set on first follow-up + reused" (AC #4) because it
 * is derived from a value that already lives on the task projection.
 */
export function wrapInvestigatorWithHistoryFile(
    inner: InvestigatorAgent,
    historyPathFor: (taskId: string) => string | undefined,
    clock: () => number,
): InvestigatorAgent {
    return {
        async run(input: InvestigatorInput): Promise<string> {
            const filePath = historyPathFor(input.taskId);
            if (filePath !== undefined) {
                seedAndAppendOperatorLine(filePath, input, clock);
            }
            const answer = await inner.run(input);
            if (filePath !== undefined) {
                appendHistoryLine(filePath, {
                    role: 'investigator',
                    content: answer,
                    timestamp: clock(),
                    threadId: input.taskId,
                });
            }
            return answer;
        },
    };
}

function seedAndAppendOperatorLine(
    filePath: string,
    input: InvestigatorInput,
    clock: () => number,
): void {
    const threadId = input.taskId;
    if (!fs.existsSync(filePath)) {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        if (input.priorBrief !== undefined && input.priorBrief.length > 0) {
            appendHistoryLine(filePath, {
                role: 'operator',
                content: input.priorBrief,
                timestamp: clock(),
                threadId,
            });
        }
        if (input.priorReport !== undefined && input.priorReport.length > 0) {
            appendHistoryLine(filePath, {
                role: 'investigator',
                content: input.priorReport,
                timestamp: clock(),
                threadId,
            });
        }
    }
    const operatorEntry = input.thread[input.thread.length - 1];
    if (operatorEntry !== undefined) {
        appendHistoryLine(filePath, {
            role: operatorEntry.role,
            content: operatorEntry.content,
            timestamp: operatorEntry.timestamp,
            threadId,
        });
    }
}

function appendHistoryLine(filePath: string, line: InvestigationHistoryLine): void {
    fs.appendFileSync(filePath, JSON.stringify(line) + '\n');
}

/**
 * AP-IFG-001: copy any lineage fields the caller supplied onto a fresh
 * `TaskCreatedPayload`. Fields the caller left `undefined` are NOT
 * spread, so the event payload stays sparse and round-trips through the
 * event log without adding noise for tasks that have no lineage.
 */
function withLineage(
    base: TaskCreatedPayload,
    input: CreateTaskPayload,
): TaskCreatedPayload {
    const out: Record<string, unknown> = { ...base };
    if (input.parent_task_id !== undefined) out.parent_task_id = input.parent_task_id;
    if (input.spawn_reason !== undefined) out.spawn_reason = input.spawn_reason;
    if (input.source_investigation_id !== undefined) {
        out.source_investigation_id = input.source_investigation_id;
    }
    if (input.investigation_thread !== undefined) {
        out.investigation_thread = input.investigation_thread;
    }
    if (input.followup_inflight !== undefined) {
        out.followup_inflight = input.followup_inflight;
    }
    return out as unknown as TaskCreatedPayload;
}

/**
 * Copy the operator-authored fields (board "Add task") onto the
 * `TaskCreated` payload. Same sparse-spread contract as
 * {@link withLineage}: fields the caller left undefined are omitted so
 * decomposer-era events and operator-era events stay distinguishable in
 * the log. The downstream consumers already exist — tasks-projection
 * reads `title`/`description`/`repoId`, the TaskCreated bridge reads
 * `dependencies` — so no fold changes are needed.
 */
function withOperatorTaskFields(
    base: TaskCreatedPayload,
    input: CreateTaskPayload,
): TaskCreatedPayload {
    const out: Record<string, unknown> = { ...base };
    if (typeof input.title === 'string' && input.title.trim().length > 0) {
        out.title = input.title.trim();
    }
    if (typeof input.description === 'string' && input.description.trim().length > 0) {
        out.description = input.description.trim();
    }
    if (typeof input.repoId === 'string' && input.repoId.length > 0) {
        out.repoId = input.repoId;
    }
    if (Array.isArray(input.dependencies)) {
        const depIds = input.dependencies.filter(
            (d): d is string => typeof d === 'string' && d.length > 0,
        );
        if (depIds.length > 0) out.dependencies = depIds;
    }
    return out as unknown as TaskCreatedPayload;
}

/**
 * Reject mutations targeting an archived plan. Archived = "assumed not
 * to be executed anymore" (operator's own definition): its tasks are
 * hidden and unstartable, so writes would land invisibly. Best-effort
 * when no DB is wired (unit harnesses without sidebar_plans) — the
 * projection-backed hosts always pass one.
 */
function assertPlanNotArchived(
    db: import('../../core/state/migrations').Db | undefined,
    planId: string | undefined,
    commandName: string,
): void {
    if (!db || typeof planId !== 'string' || planId.length === 0) return;
    try {
        const row = db
            .prepare('SELECT archived_at FROM sidebar_plans WHERE plan_id = ?')
            .get(planId) as { archived_at: number | null } | undefined;
        if (row && row.archived_at !== null) {
            throw new Error(
                `${commandName}: plan ${planId} is archived — unarchive it first `
                + '(archived plans are read-only).',
            );
        }
    } catch (err) {
        if (err instanceof Error && err.message.includes('is archived')) throw err;
        // Table/read hiccup — don't block the write on the guard's own
        // machinery.
    }
}

/**
 * Continue the plan's existing task-id numbering for operator-added
 * tasks: a plan whose decomposer produced `L-IAED-001..005` gets
 * `L-IAED-006`, not an opaque `task-1784...` id. Sibling ids matching
 * `<prefix>-<NNN>` vote on the prefix (most common wins); the next
 * number is max+1, bumped further if the candidate id is already taken
 * anywhere in the tasks table (ids are global — worktree paths and
 * routes key on them). Returns undefined when there is no DB, no
 * numbered siblings, or anything unexpected — the caller falls back to
 * `idGen.newId()`.
 */
/**
 * The plan's project, for stamping onto TaskCreated. Mirrors the join the
 * `/api/tasks` read route uses, so a live row and a hydrated one carry the
 * same value. Best-effort: a plan with no sidebar row yields null and the
 * board falls back to resolving through the plan itself.
 */
function projectIdForPlan(deps: HandlerDeps, planId: string): string | null {
    const db = deps.db;
    if (!db || typeof planId !== 'string' || planId.length === 0) return null;
    try {
        const row = db
            .prepare('SELECT pid FROM sidebar_plans WHERE plan_id = ? LIMIT 1')
            .get(planId) as { pid?: string | null } | undefined;
        return typeof row?.pid === 'string' && row.pid.length > 0 ? row.pid : null;
    } catch {
        return null;
    }
}

/**
 * Task ids handed out by {@link allocateSiblingTaskId} that the `tasks`
 * table has not caught up with yet.
 *
 * The allocator reads a PROJECTION, and projections are folded after the
 * handler returns — so two CreateTask commands in flight at once both see
 * the same highest sibling number and both mint the same id. The events
 * table's `UNIQUE(idempotency_key)` then swallows the second as a
 * duplicate of the first, silently.
 *
 * That was reachable before (double-click), but it becomes routine the
 * moment the chat agent can propose several tasks at once: the operator
 * clicks Apply, Apply, Apply, watches three cards turn "✓ Applied", and
 * gets one task. Measured, not theorised — three concurrent dispatches
 * produced exactly one row.
 *
 * Entries are dropped as soon as the real row appears, so the set holds
 * only genuinely in-flight ids. One worker process at a time is the
 * deployment model, so process-local is the whole picture.
 *
 * Keyed on `deps` — i.e. per handler registration, which is per database
 * — rather than being one module-level set. A shared set outlives the db
 * it was reserved against: two orchestrators in one process (every test
 * file that builds more than one harness) would inherit each other's
 * reservations and never retire them, because retirement asks THIS db
 * whether the row has appeared.
 */
const reservedTaskIdsByDeps = new WeakMap<HandlerDeps, Set<string>>();

function reservedIdsFor(deps: HandlerDeps): Set<string> {
    let set = reservedTaskIdsByDeps.get(deps);
    if (set === undefined) {
        set = new Set<string>();
        reservedTaskIdsByDeps.set(deps, set);
    }
    return set;
}

function allocateSiblingTaskId(
    deps: HandlerDeps,
    planId: string,
): string | undefined {
    const db = deps.db;
    if (!db) return undefined;
    try {
        const rows = db.prepare('SELECT id FROM tasks WHERE plan_id = ?')
            .all(planId) as ReadonlyArray<{ id: string }>;
        const byPrefix = new Map<string, number>();
        const counts = new Map<string, number>();
        for (const row of rows) {
            const m = /^([A-Za-z0-9][A-Za-z0-9-]*)-(\d{2,})$/.exec(row.id);
            if (!m) continue;
            const [, prefix, num] = m;
            counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
            const n = parseInt(num, 10);
            if (n > (byPrefix.get(prefix) ?? 0)) byPrefix.set(prefix, n);
        }
        let prefix: string | undefined;
        let best = 0;
        for (const [p, c] of counts) {
            if (c > best) { best = c; prefix = p; }
        }
        if (!prefix) return undefined;
        const existsStmt = db.prepare('SELECT 1 FROM tasks WHERE id = ?');
        const reservedTaskIds = reservedIdsFor(deps);
        // Retire reservations the projection has caught up with, so the
        // set stays the in-flight window rather than growing forever.
        for (const id of reservedTaskIds) {
            if (existsStmt.get(id)) reservedTaskIds.delete(id);
        }
        // A reserved id counts as taken for the high-water mark too:
        // without this the scan below starts from the table's maximum and
        // walks straight back over the ids already handed out.
        for (const id of reservedTaskIds) {
            const m = /^([A-Za-z0-9][A-Za-z0-9-]*)-(\d{2,})$/.exec(id);
            if (!m || m[1] !== prefix) continue;
            const n = parseInt(m[2], 10);
            if (n > (byPrefix.get(prefix) ?? 0)) byPrefix.set(prefix, n);
        }
        let next = (byPrefix.get(prefix) ?? 0) + 1;
        for (let attempts = 0; attempts < 1000; attempts += 1, next += 1) {
            const candidate = `${prefix}-${String(next).padStart(3, '0')}`;
            if (existsStmt.get(candidate) || reservedTaskIds.has(candidate)) continue;
            reservedTaskIds.add(candidate);
            return candidate;
        }
        return undefined;
    } catch {
        // Numbering is a nicety — never let it block task creation.
        return undefined;
    }
}

/**
 * Kick off a planner / decomposer agent run. The agent memory store is
 * consulted at invocation time so the prompt and metadata both carry the
 * rendered memory block — keeping memory injection in the dispatcher (not
 * inside the handler factories) lets the factories stay pure and unit-
 * testable without a filesystem.
 *
 * AP-VP4-010: the prompt now also carries (where supplied) the brief
 * content, conventions, feedback / previous-content for regenerate mode,
 * the approved plan body for decompose mode, and the
 * {@link RepoReader}-produced repo block. Each section is rendered as a
 * markdown heading inside the prompt; sections without data are skipped
 * rather than emitted as empty headings.
 *
 * The lifecycle context (`kind`, `revision`, `feedback`, ...) is also
 * recorded against the freshly-allocated agentId in
 * `deps.lifecycleAgents`. The AgentFinished / AgentFailed subscribers
 * registered by {@link registerPlanLifecycleAgentHandlers} read that map
 * to translate the runner's bus events back into PlanGenerated /
 * PlanDecomposed / Plan*Failed events that carry the right plan-side
 * fields.
 */
export interface StartLifecycleAgentArgs {
    readonly kind: 'planner' | 'decomposer' | 'architect' | 'design-verifier';
    readonly role: string;
    readonly model: string;
    readonly planId: string;
    readonly projectId: string;
    readonly revision?: number;
    readonly briefId?: string;
    readonly briefContent?: string;
    readonly conventions?: PlanConventions;
    readonly feedback?: string;
    readonly previousContent?: string;
    readonly approvedContent?: string;
    /** Architect Tier: the requirement this architect run is designing. */
    readonly requirementId?: string;
    /** Plan archetype, threaded into the decomposer prompt (`Plan archetype: X`). */
    readonly archetype?: string;
    /**
     * Operator answers to questions this agent already asked on this plan,
     * oldest first. Rendered as the `# Human clarification` block — the same
     * heading, wording and binding-precedence language the task agents get,
     * so the decomposer treats a settled decision as settled.
     */
    readonly clarifications?: readonly ClarificationRecord[];
}

function startLifecycleAgent(
    deps: HandlerDeps,
    args: StartLifecycleAgentArgs,
): void {
    const {
        kind, role, model, planId, projectId, revision,
        briefId, briefContent, conventions, feedback, previousContent,
        approvedContent, clarifications,
    } = args;

    const memoryBlock = deps.agentMemory ? deps.agentMemory.renderForPrompt(projectId) : '';
    // Which owner's attachments this agent reads — a requirement for the
    // architect tier, a plan for the planner / decomposer. See
    // `designAttachmentScope` for why the architect cannot use its own
    // (synthetic) plan id.
    const { owner: attachmentOwner, ownerId: attachmentOwnerId } =
        designAttachmentScope({
            planId,
            ...(args.requirementId !== undefined
                ? { requirementId: args.requirementId }
                : {}),
        });
    const attachmentsRoot = attachmentOwner === 'requirement'
        ? deps.requirementAttachmentsRoot
        : deps.planAttachmentsRoot;
    const attachmentsNote = buildDesignAttachmentsNote(
        deps.attachmentStore,
        attachmentOwner,
        attachmentOwnerId,
        attachmentsRoot,
    );
    // The boundary block forbids every path it does not list, so the
    // attachments directory has to be named there too — otherwise the
    // agent is handed a path and simultaneously told not to read it.
    const planAttachmentsDir = typeof attachmentsRoot === 'string'
        && attachmentsRoot.length > 0
        && attachmentsNote.length > 0
        ? designAttachmentDir(attachmentsRoot, attachmentOwnerId)
        : undefined;
    // Registered workspace repos — fed into the `# !!! WORKSPACE BOUNDARIES`
    // block so the planner/decomposer knows the ONLY repos it may read are
    // the configured clones, not the operator's personal checkouts. Without
    // this the lifecycle prompt carried no boundary block at all and the
    // planner searched the whole disk for a referenced repo.
    const workspaceRepos = deps.listWorkspaceRepos?.() ?? [];
    // NuGet package graph — publishers/consumers + the required
    // publish/bump chain. Every design-side agent gets it: the field
    // incident was a fan-out that missed the package deployment because
    // no agent had any data about the cross-repo package topology.
    const stackContextBlock = deps.getStackContextBlock?.() ?? '';
    // Operator-authored description of how this project's repos fit
    // together. Same audience as the package graph: the agents that
    // design across repos rather than edit inside one.
    const projectContextBlock = deps.getProjectContextBlock?.(projectId) ?? '';
    const prompt = assembleLifecyclePrompt({
        role, planId, projectId, kind, revision,
        briefContent, conventions, feedback, previousContent, approvedContent,
        archetype: args.archetype,
        ...(clarifications !== undefined ? { clarifications } : {}),
        ...(deps.resolveAgentPrompt?.(role)
            ? { personaOverride: deps.resolveAgentPrompt(role) }
            : {}),
        memoryBlock,
        repoBlock: '',
        stackContextBlock,
        projectContextBlock,
        attachmentsNote,
        ...(planAttachmentsDir !== undefined ? { planAttachmentsDir } : {}),
        workspaceRepos,
    });

    const baseMetadata: Record<string, unknown> = {
        planId,
        projectId,
        model,
        agentMemory: memoryBlock,
        kind,
    };
    if (revision !== undefined) baseMetadata.revision = revision;
    if (briefId !== undefined) baseMetadata.briefId = briefId;

    // `cwd` is the resolved workspace clone path (e.g.
    // `C:\Drop-AI\Source\repos\workshop.orchestrator`) — threaded
    // into AgentSpec.cwd so ClaudeCliRunner spawns the planner /
    // decomposer with its working directory PINNED to the workspace
    // repo. Without this the agent inherited the orchestrator's
    // process cwd and walked up into the operator's personal repo
    // tree (e.g. `<workspace>/projects/workshop`) when it tried to
    // resolve relative path references in the brief, ending up
    // reading source from the wrong clone entirely.
    // The plan's repo account, for the same reason the task agents get
    // one: these agents run git and gh themselves against the repo they
    // are planning against.
    const githubEnv = deps.githubEnvForPlan?.(planId) ?? {};
    const launch = (finalPrompt: string, cwd?: string): void => {
        const spec: AgentSpec = {
            role,
            prompt: finalPrompt,
            metadata: baseMetadata,
            ...(cwd !== undefined ? { cwd } : {}),
            ...(Object.keys(githubEnv).length > 0 ? { env: githubEnv } : {}),
        };
        deps.deferAgentStart(() => {
            const handle = deps.agentRunner.start(spec);
            // Lifecycle agents are plan-scoped, not task-scoped, so the
            // taskId column on the agent→task map is left as the planId —
            // good enough for diagnostics; the bridge no-ops when the
            // resulting AgentFinished doesn't map to a flow_state row.
            deps.registerAgent(handle.id, `plan:${planId}`);
            if (deps.lifecycleAgents) {
                const ctx: LifecycleAgentContext = {
                    kind, planId, projectId,
                    ...(revision !== undefined ? { revision } : {}),
                    ...(briefId !== undefined ? { briefId } : {}),
                    ...(feedback !== undefined ? { feedback } : {}),
                    ...(previousContent !== undefined ? { previousContent } : {}),
                    ...(approvedContent !== undefined ? { approvedContent } : {}),
                    ...(conventions !== undefined ? { conventions } : {}),
                    ...(args.requirementId !== undefined
                        ? { requirementId: args.requirementId }
                        : {}),
                    // Recorded so a decomposer parked on a question can be
                    // re-spawned with exactly the inputs it had.
                    ...(briefContent !== undefined ? { briefContent } : {}),
                    ...(args.archetype !== undefined ? { archetype: args.archetype } : {}),
                    ...(clarifications !== undefined ? { clarifications } : {}),
                };
                deps.lifecycleAgents.set(handle.id, ctx);
            }
        });
    };

    // Repo block is async via the RepoReader port (task-003). When the
    // orchestrator host wires `resolveRepoSpec`, the resolver does the
    // pre-spawn refresh against the workspace repo registry and hands
    // back a `RepoSpec` pointing at the freshly-pulled clone — that's
    // the path that powers planner / decomposer prompts in production.
    // The static `repoSpec` is kept as a fallback for tests that want a
    // deterministic in-memory spec.
    if (deps.repoReader && (deps.resolveRepoSpec || deps.repoSpec)) {
        const reader = deps.repoReader;
        const specSource: Promise<RepoSpec | null> = deps.resolveRepoSpec
            ? deps.resolveRepoSpec(args).catch((err) => {
                deps.logger.warn('orchestrator: resolveRepoSpec rejected; spawning without repo block', {
                    planId,
                    projectId,
                    error: err instanceof Error ? err.message : String(err),
                });
                return null;
            })
            : Promise.resolve(deps.repoSpec ?? null);
        specSource
            .then((spec) => {
                if (!spec) {
                    // No spec resolved — fall back to the pre-built
                    // prompt with no cwd. The planner runs without a
                    // pinned working directory; this matches legacy
                    // behaviour for plans whose targetRepo can't be
                    // resolved (newly created plans before the repo
                    // registry is populated, tests with no resolver).
                    launch(prompt);
                    return;
                }
                reader
                    .read(spec)
                    .then((repoRead) => {
                        const repoBlock = renderRepoBlock(
                            repoRead.claudeMd,
                            repoRead.tree,
                            repoRead.sampleFiles,
                        );
                        launch(
                            assembleLifecyclePrompt({
                                role, planId, projectId, kind, revision,
                                briefContent, conventions, feedback, previousContent,
                                approvedContent, archetype: args.archetype,
                                ...(clarifications !== undefined ? { clarifications } : {}),
                                ...(deps.resolveAgentPrompt?.(role)
                                    ? { personaOverride: deps.resolveAgentPrompt(role) }
                                    : {}),
                                memoryBlock, repoBlock,
                                stackContextBlock,
                                projectContextBlock,
                                attachmentsNote,
                                workspaceRepos,
                                // cwd is now resolved — name it as the agent's
                                // working clone so the boundary block anchors
                                // the workspace root concretely.
                                worktreePath: spec.repoPath,
                            }),
                            spec.repoPath,
                        );
                    })
                    .catch((err) => {
                        deps.logger.warn('orchestrator: RepoReader.read failed; spawning agent without repo block', {
                            planId, projectId,
                            error: err instanceof Error ? err.message : String(err),
                        });
                        // Even when reader.read fails (e.g. a transient
                        // FS error walking the workspace clone), we
                        // still have the resolved spec — pass its
                        // repoPath so the planner at least runs with
                        // its cwd anchored to the right clone rather
                        // than the orchestrator's process cwd.
                        launch(prompt, spec.repoPath);
                    });
            });
        return;
    }
    launch(prompt);
}

interface AssemblePromptArgs {
    readonly role: string;
    readonly planId: string;
    readonly projectId: string;
    readonly kind: 'planner' | 'decomposer' | 'architect' | 'design-verifier';
    readonly revision?: number;
    readonly briefContent?: string;
    readonly conventions?: PlanConventions;
    readonly feedback?: string;
    readonly previousContent?: string;
    readonly approvedContent?: string;
    readonly archetype?: string;
    /** See {@link StartLifecycleAgentArgs.clarifications}. */
    readonly clarifications?: readonly ClarificationRecord[];
    /** Management UI (Option B): persona override (Agent.prompt). */
    readonly personaOverride?: string;
    readonly memoryBlock: string;
    readonly repoBlock: string;
    /** The enabled stack packs' design-context blocks ('' = omit). */
    readonly stackContextBlock?: string;
    /** Rendered `# Project context` block ('' = omit). */
    readonly projectContextBlock?: string;
    /**
     * Migration 021: text summary of the plan's operator attachments
     * (filename + caption + type), rendered as a `# Plan attachments`
     * block. Lifecycle agents (planner / decomposer) run against the
     * shared repo clone, not a throwaway worktree, so the bytes are not
     * materialised here — but the captions tell the agent what the
     * operator pinned (e.g. "target layout", "auth sequence"). The actual
     * image/PDF bytes reach the per-task developer agents via the task's
     * inherited plan attachments.
     */
    readonly attachmentsNote?: string;
    /** Absolute dir of this plan's mirrored attachments, for the
     *  boundary block's readable-paths list. */
    readonly planAttachmentsDir?: string;
    /** Absolute path of the agent's working clone (cwd). Anchors the
     *  `# !!! WORKSPACE BOUNDARIES` block's workspace-root inference. */
    readonly worktreePath?: string;
    /** Registered workspace repos. Rendered in the boundary block as the
     *  exhaustive allow-list of repos the agent may read. */
    readonly workspaceRepos?: ReadonlyArray<WorkspaceRepoEntry>;
}

/**
 * Read `agents/<role>.CLAUDE.md` from the repo root and cache it per
 * role for the lifetime of the process. The file is the operator-
 * authored role specification (role definition, output rules,
 * archetype modes, etc.); without it the lifecycle agents run with
 * only the structured context blocks (Brief / Conventions / etc.) and
 * no instructions on how to behave, which surfaces as the agent
 * asking clarification questions or producing terse output without
 * narration.
 *
 * Returns `null` when the file doesn't exist for a given role —
 * roles without a persona file just run with the bare prompt.
 */
// Deliberately NOT cached: agent spawns are seconds apart at their
// densest and the files are a few KB, while a process-lifetime cache
// meant an edited persona (git pull, or the manager UI's MD editor —
// whose save promises "applies on the next spawn") silently kept
// serving the old text until the next worker restart. Field case: a
// restructured committer persona that never reached the committer.
//
// Resolution goes through the profile layers (config/profile.ts): the
// operator's profile persona, then — only until `profile init` has run —
// the legacy Agents-panel DB prompt passed in as `legacyOverride`, then the
// repo default, with any `.extend.md` spliced in ahead of the shared block.
// It used to be `personaOverride ?? <repo file>` at each call site, which
// is how a stale 49 KB DB copy of the decomposer persona silently shadowed
// every later improvement to the file.
function loadAgentPersona(role: string, legacyOverride?: string): string | null {
    return composePersona(role, legacyOverride !== undefined ? { legacyOverride } : {});
}

// ---------------------------------------------------------------------------
// Task-agent prompt assembly
// ---------------------------------------------------------------------------
//
// The task agents (developer / reviewer / tester / committer / doc-writer /
// investigator) need real context to do anything useful — without it the
// runner spawns claude with a placeholder prompt like
// `step develop for task task-001` and the agent has nothing to work on.
// Mirror the lifecycle agent's `assembleLifecyclePrompt` pattern: load the
// role persona, then layer task / plan / repo blocks on top.

/**
 * Per-repo workspace entry used to render the agent prompt's
 * `# Workspace layout` block. The orchestrator pulls these from
 * `RepoProjectionStore.listActive()` and threads them through every
 * `StartAgent` call so the agent sees the absolute paths of every
 * registered repo in `.pipeline-workspace/repos/`. Without this block
 * the agent walks up the directory tree looking for sibling repos
 * named in the task description / CLAUDE.md and lands on the operator's
 * personal checkouts elsewhere on disk.
 */
export interface WorkspaceRepoEntry {
    readonly repoId: string;
    readonly name: string;
    /** Absolute path to the workspace clone. */
    readonly path: string;
}

export interface TaskAgentContext {
    readonly role: string;
    /** Management UI (Option B): persona override (Agent.prompt); when set it
     *  replaces the `agents/<role>.CLAUDE.md` file as the agent's persona. */
    readonly personaOverride?: string;
    readonly taskId: string;
    readonly stepId: string;
    readonly title: string | null;
    readonly description: string | null;
    readonly type: string;
    readonly planId: string;
    readonly planName: string | null;
    readonly latestPlanContent: string | null;
    /** Operator instructions / remarks (migration 022). Rendered as the
     *  `# Operator instructions` block — high-priority guidance layered on
     *  top of the decomposer's description. */
    readonly instructions?: string | null;
    readonly rejectFeedback?: string;
    readonly investigationAnswer?: string;
    readonly humanAnswer?: string;
    /**
     * Every clarification the operator has answered on this task, oldest
     * first — durable (`task_clarifications`, migration 033) rather than
     * step-scoped like {@link humanAnswer}. Rendered as the
     * `# Human clarification` block so the reviewer and tester see the
     * decisions the developer was told to implement.
     */
    readonly clarifications?: readonly ClarificationRecord[];
    readonly repoBlock?: string;
    /**
     * The project's stored context, rendered for EDITING. Set only for the
     * roles in {@link PROJECT_CONTEXT_EDITOR_ROLES} — an agent asked to
     * replace this text in full has to see all of it, and no other task
     * role has any business rewriting it.
     */
    readonly projectContextBlock?: string;
    /** Owning project id, resolved via the task's plan. */
    readonly projectId?: string;
    /**
     * NOTE: there is deliberately no `stackContextBlock` here. The graph
     * goes to the DESIGN-side agents (planner / decomposer / architect)
     * via `AssemblePromptArgs`; a task agent works one repo and does not
     * choose bump chains. The field used to be declared on this
     * interface but nothing ever set it and nothing read it — the same
     * shape of dead wiring that hid the lifecycle bug for so long.
     */
    /** Absolute path of the worktree the agent will run in. Used by
     *  the `# Workspace layout` block so the agent has a concrete cwd
     *  to anchor relative reads against. */
    readonly worktreePath?: string;
    /** Every active repo in the pipeline workspace. Listed in the
     *  `# Workspace layout` block so cross-repo reads have absolute
     *  paths instead of guesses. */
    readonly workspaceRepos?: ReadonlyArray<WorkspaceRepoEntry>;
    /** Operator attachments materialised into `<worktree>/attachments/`
     *  for the agent to Read (migration 021). Rendered as the
     *  `# Attachments` prompt block + TASK.md `## Attachments` section. */
    readonly attachments?: readonly TaskAttachmentRef[];
    /** Structured ticket fields (goal / acceptance criteria / file
     *  impact) from tasks.ticket_details — see migration 027. */
    readonly ticketDetails?: TaskTicketDetails;
    /**
     * What the tasks this one depends on reported, and when they
     * finished. Rendered as the `# Upstream task output` block in the
     * prompt and in TASK.md.
     *
     * The deploy-verifier's persona has always listed "the upstream
     * deploy task's completion timestamp" and its output tail as inputs
     * "from TASK.md" and forbidden deriving the published version any
     * other way - while nothing wrote either one into a prompt. It asked
     * the operator instead, nearly every run.
     */
    readonly upstreamOutputs?: readonly UpstreamTaskOutput[];
    /** Upstreams past the render cap, named so none is dropped silently. */
    readonly upstreamOmitted?: readonly string[];
    /**
     * Absolute path of this task's OUTPUT folder (migration 038) —
     * `<workspaceRoot>/task-output/<taskId>`. Rendered as the
     * `# Deliverable files` block, as a TASK.md section, and listed as
     * writable in the boundary block (which reads this field by shape -
     * `renderWorkspaceLayoutBlock(ctx)` is handed the task context
     * directly, so the two names have to agree).
     */
    readonly taskOutputDir?: string;
}

/**
 * One operator attachment copied into the task worktree (migration 021).
 * `relPath` is the worktree-relative path the agent Reads; `caption` is the
 * operator's note ("login button is misaligned"); `ownerType` distinguishes
 * a task-level attachment from one inherited from the plan.
 */
export interface TaskAttachmentRef {
    readonly relPath: string;
    readonly fileName: string;
    readonly contentType: string;
    readonly caption: string | null;
    readonly ownerType: 'task' | 'plan';
}

/**
 * Render the `# Attachments` block listing every materialised attachment
 * with its worktree path, content type, caption, and origin — plus an
 * explicit instruction to Read each one (the Read tool renders images and
 * PDFs, so the agent literally sees the screenshot / diagram). Returns ''
 * when there are no attachments so callers can append unconditionally.
 */
export function renderAttachmentsBlock(
    refs: readonly TaskAttachmentRef[] | undefined,
): string {
    if (!refs || refs.length === 0) return '';
    const lines: string[] = [
        '# Attachments',
        '',
        'The operator attached the following file(s). READ each one before you'
        + ' start — the Read tool renders images and PDFs, so these show you what'
        + ' to build or what went wrong. Treat captions as part of the task'
        + ' requirements. These files live outside the repo tree and are NOT part'
        + ' of your change — never stage, commit, or modify them.',
        '',
    ];
    for (const ref of refs) {
        const origin = ref.ownerType === 'plan' ? 'from the plan' : 'from the task';
        const caption = ref.caption ? ` — "${ref.caption}"` : '';
        lines.push(`- \`${ref.relPath}\` (${ref.contentType}, ${origin})${caption}`);
    }
    return lines.join('\n');
}

/**
 * `# Deliverable files` — where a produced file has to go to be reachable.
 *
 * Field report: an investigation wrote its results CSV to a folder it
 * invented under the workspace root and ended its report with "The CSV is
 * at C:\Drop-AI\Source\scratch\<task>\...". The file was real and
 * the operator could not get at it: a path in prose is not a download.
 *
 * The agent was not misbehaving — the boundary block says every legal path
 * starts at the workspace root, and it picked one. So the pipeline names
 * the folder instead of leaving it to be guessed, and harvests whatever
 * lands there onto the task.
 */
export function renderTaskOutputsBlock(outputDir: string | undefined): string {
    if (!outputDir || outputDir.length === 0) return '';
    return [
        '# Deliverable files',
        '',
        'If this task produces FILES for the operator — a results CSV, an',
        'exported report, a generated document — write them here:',
        '',
        `  ${outputDir}`,
        '',
        'The folder already exists. Everything you leave in it is attached to',
        'the task automatically, so the operator can download it from the',
        'board when the task finishes. Use plain, descriptive file names.',
        '',
        'This is the ONLY place a produced file is reachable from. Do not',
        'invent another folder for it, and do not settle for quoting a path',
        'in your report — a path the operator cannot click is not a',
        'deliverable. A file that belongs in the repository (documentation,',
        'a committed script) still goes in your worktree as usual; copy it',
        'here as well if the operator should be able to download it directly.',
    ].join('\n');
}

interface TaskContextRow {
    title: string | null;
    description: string | null;
    type: string;
    plan_id: string;
    feedback: string | null;
    instructions: string | null;
    ticket_details: string | null;
}

/** Parsed tasks.ticket_details JSON (migration 027). */
export interface TaskTicketDetails {
    readonly goal?: string;
    readonly acceptanceCriteria?: readonly string[];
    readonly filesToCreate?: readonly string[];
    readonly filesToModify?: readonly string[];
    readonly filesToDelete?: readonly string[];
    /** The decomposer's `test.commands` for this task. */
    readonly testCommands?: readonly string[];
}

function parseTicketDetails(raw: string | null): TaskTicketDetails | undefined {
    if (typeof raw !== 'string' || raw.length === 0) return undefined;
    try {
        const parsed = JSON.parse(raw) as TaskTicketDetails;
        return parsed && typeof parsed === 'object' ? parsed : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Render the structured ticket sections (file impact + acceptance
 * criteria) shared by the agent prompt (`#` headings) and TASK.md
 * (`##` headings). The goal is rendered separately by each caller —
 * it belongs before the description, not after.
 */
export function renderTicketSections(
    details: TaskTicketDetails | undefined,
    h: '#' | '##',
): string[] {
    if (!details) return [];
    const out: string[] = [];
    const fileGroup = (label: string, files?: readonly string[]): void => {
        if (files && files.length > 0) {
            out.push(`${label}:`);
            for (const f of files) out.push(`- ${f}`);
        }
    };
    if (
        (details.filesToCreate?.length ?? 0) > 0
        || (details.filesToModify?.length ?? 0) > 0
        || (details.filesToDelete?.length ?? 0) > 0
    ) {
        out.push('', `${h} File impact`, '');
        fileGroup('Create', details.filesToCreate);
        fileGroup('Modify', details.filesToModify);
        fileGroup('Delete', details.filesToDelete);
    }
    if (details.acceptanceCriteria && details.acceptanceCriteria.length > 0) {
        out.push('', `${h} Acceptance criteria`, '');
        for (const c of details.acceptanceCriteria) out.push(`- [ ] ${c}`);
    }
    // The tester persona tells the agent to read "the test commands" from
    // TASK.md. Until now TASK.md never carried any: the decomposer's
    // `test` block was validated and dropped, so the tester inferred a
    // command instead — and what it inferred for a PowerShell repo was
    // the whole suite, on the tester step and again on every
    // `on_failure: develop` loop.
    //
    // Scoped, not exhaustive: these are the commands for THIS task, which
    // is the point. An agent that needs more can still run more.
    if (details.testCommands && details.testCommands.length > 0) {
        out.push('', `${h} Test commands`, '');
        out.push('Run these to verify this task. They are scoped to what it');
        out.push('changed — do not widen them to the whole suite.');
        out.push('');
        for (const c of details.testCommands) out.push(`- \`${c}\``);
    }
    return out;
}

/**
 * Render the `# Operator instructions` block. High-priority, operator-
 * authored guidance layered on top of the decomposer's description (e.g.
 * "reuse FooService, don't add a DI registration"). Returns '' when empty.
 */
export function renderInstructionsBlock(
    instructions: string | null | undefined,
): string {
    if (typeof instructions !== 'string' || instructions.trim().length === 0) {
        return '';
    }
    return [
        '# Operator instructions',
        '',
        'The operator added the following instructions for this task. Treat'
        + ' them as authoritative requirements — they override the generic'
        + ' description where they conflict.',
        '',
        instructions.trim(),
    ].join('\n');
}

interface SidebarPlanRow {
    name: string | null;
}

interface PlanReviewRow {
    content: string;
}

/**
 * Read enough state out of SQLite to build a task-agent prompt: the
 * task's title / description / type, the plan name (for the prompt's
 * "Plan: <name>" header line), and the latest plan-review revision's
 * approved markdown (the operator-edited plan the decomposer's tasks
 * derive from). Optional fields gracefully default to `null` so a
 * partially-projected row still produces a usable prompt.
 */
/**
 * Task roles that receive the project context as an EDITABLE block.
 *
 * A set rather than a string compare because the membership is the whole
 * policy: the block is a full copy of operator-authored prose, and every
 * role in here is one that can replace it wholesale. Adding a name is a
 * decision to trust that role with an overwrite.
 */
export const PROJECT_CONTEXT_EDITOR_ROLES: ReadonlySet<string> = new Set([
    'project-context-writer',
]);

export function readTaskAgentContext(
    db: import('../../core/state/migrations').Db,
    role: string,
    taskId: string,
    stepId: string,
    extra?: { rejectFeedback?: string; investigationAnswer?: string; humanAnswer?: string },
): TaskAgentContext | null {
    const taskRow = db
        .prepare(
            `SELECT title, description, type, plan_id, feedback, instructions,
                    ticket_details
               FROM tasks WHERE id = ?`,
        )
        .get(taskId) as TaskContextRow | undefined;
    if (!taskRow) return null;
    const ticketDetails = parseTicketDetails(taskRow.ticket_details);

    const planName
        = (db
            .prepare(`SELECT name FROM sidebar_plans WHERE plan_id = ? LIMIT 1`)
            .get(taskRow.plan_id) as SidebarPlanRow | undefined)
            ?.name ?? null;

    const planContent
        = (db
            .prepare(
                `SELECT content FROM plan_review_drafts
                  WHERE plan_id = ? ORDER BY revision DESC LIMIT 1`,
            )
            .get(taskRow.plan_id) as PlanReviewRow | undefined)
            ?.content ?? null;

    // `tasks.feedback` carries the operator's reject reason from the
    // last approval-park rejection; thread it onto the prompt as
    // `# Human feedback` so the agent sees the redirect.
    const rejectFeedback
        = extra?.rejectFeedback
        ?? (typeof taskRow.feedback === 'string' && taskRow.feedback.length > 0
            ? taskRow.feedback
            : undefined);

    // Durable clarification answers (migration 033). Merged with the
    // step-scoped `humanAnswer` because the two arrive off different
    // events and their order is not guaranteed — see
    // `mergeClarifications`. Best-effort: a task predating the table
    // (or a read error) must not stop the agent from starting.
    let storedClarifications: ClarificationRecord[] = [];
    try {
        storedClarifications = (db
            .prepare(
                `SELECT question, answer FROM task_clarifications
                  WHERE task_id = ? ORDER BY event_seq ASC`,
            )
            .all(taskId) as Array<{ question: string | null; answer: string }>)
            .map((r) => ({ question: r.question, answer: r.answer }));
    } catch {
        storedClarifications = [];
    }
    const clarifications = mergeClarifications(
        storedClarifications,
        extra?.humanAnswer,
    );

    // What this task's dependencies reported. Best-effort: context, not a
    // precondition, so a read failure costs the block and not the run.
    const upstream = readUpstreamOutputs(db, taskId);

    // Project id + (for the context-writer role only) the current project
    // context. Resolved through the plan because `tasks` carries no
    // project column. Best-effort on both counts: a task whose plan row
    // is missing still runs, it just runs without the block — and the
    // writer persona treats an absent block as a hard stop rather than
    // guessing, so the failure surfaces instead of overwriting.
    let projectId: string | null = null;
    let projectContextBlock: string | undefined;
    try {
        projectId = (db
            .prepare('SELECT pid FROM sidebar_plans WHERE plan_id = ? LIMIT 1')
            .get(taskRow.plan_id) as { pid: string | null } | undefined)
            ?.pid ?? null;
        if (projectId && PROJECT_CONTEXT_EDITOR_ROLES.has(role)) {
            const row = db
                .prepare('SELECT context_md FROM projects WHERE id = ?')
                .get(projectId) as { context_md: string | null } | undefined;
            projectContextBlock = renderProjectContextForEditing(row?.context_md ?? '');
        }
    } catch {
        projectId = null;
    }

    return {
        ...(clarifications.length > 0 ? { clarifications } : {}),
        ...(upstream.outputs.length > 0
            ? { upstreamOutputs: upstream.outputs }
            : {}),
        ...(upstream.omittedTasks.length > 0
            ? { upstreamOmitted: upstream.omittedTasks }
            : {}),
        role,
        taskId,
        stepId,
        ...(projectId !== null ? { projectId } : {}),
        ...(projectContextBlock !== undefined ? { projectContextBlock } : {}),
        title: taskRow.title,
        description: taskRow.description,
        type: taskRow.type,
        planId: taskRow.plan_id,
        planName,
        latestPlanContent: planContent,
        ...(typeof taskRow.instructions === 'string' && taskRow.instructions.trim().length > 0
            ? { instructions: taskRow.instructions }
            : {}),
        ...(ticketDetails !== undefined ? { ticketDetails } : {}),
        ...(rejectFeedback !== undefined ? { rejectFeedback } : {}),
        ...(extra?.investigationAnswer !== undefined
            ? { investigationAnswer: extra.investigationAnswer }
            : {}),
        ...(extra?.humanAnswer !== undefined
            ? { humanAnswer: extra.humanAnswer }
            : {}),
    };
}

/**
 * Assemble the final prompt string for a task-agent spawn. Layout:
 *
 *   <role persona from agents/<role>.CLAUDE.md>
 *
 *   Role: <role>
 *   Task: <taskId>
 *   Step: <stepId>
 *   Title: <title>
 *   Type: <type>
 *
 *   # Task
 *   <description>
 *
 *   # Plan
 *   <latest plan-review markdown>
 *
 *   # Human feedback              (when rejectFeedback supplied)
 *   <feedback>
 *
 *   # Investigation answer        (when resumed with an investigation result)
 *   <answer>
 *
 *   # Human clarification         (when resumed with a clarify-modal answer)
 *   <answer>
 *
 *   # Repository context          (when the resolver returns a RepoSpec)
 *   <CLAUDE.md + file tree + sample files>
 */
export function assembleTaskAgentPrompt(ctx: TaskAgentContext): string {
    const parts: string[] = [];

    // Workspace layout goes FIRST — before the persona — so the agent
    // sets its cwd / forbidden-path mental model before reading any
    // role-specific instructions or repository CLAUDE.md content that
    // might leak paths from the operator's personal checkouts (see the
    // detailed warning inside renderWorkspaceLayoutBlock).
    const layout = renderWorkspaceLayoutBlock(ctx);
    if (layout) parts.push(layout, '');

    const persona = loadAgentPersona(ctx.role, ctx.personaOverride);
    if (persona) parts.push(persona, '');

    const header = [
        `Role: ${ctx.role}`,
        `Task: ${ctx.taskId}`,
    ];
    if (ctx.stepId) header.push(`Step: ${ctx.stepId}`);
    if (ctx.title) header.push(`Title: ${ctx.title}`);
    if (ctx.type) header.push(`Type: ${ctx.type}`);
    if (ctx.planId) header.push(`Plan: ${ctx.planName ?? ctx.planId}`);
    parts.push(...header);

    if (ctx.ticketDetails?.goal) {
        parts.push('', '# Goal', ctx.ticketDetails.goal);
    }
    parts.push('', '# Task');
    if (ctx.description && ctx.description.length > 0) {
        parts.push(ctx.description);
    } else if (ctx.title) {
        parts.push(ctx.title);
    } else {
        parts.push('(no description supplied)');
    }
    // File impact + acceptance criteria (the decomposer's contract for
    // this task) — the tester/reviewer verify against exactly this list.
    parts.push(...renderTicketSections(ctx.ticketDetails, '#'));

    const instructionsBlock = renderInstructionsBlock(ctx.instructions);
    if (instructionsBlock) parts.push('', instructionsBlock);

    const attachBlock = renderAttachmentsBlock(ctx.attachments);
    if (attachBlock) parts.push('', attachBlock);

    // Ahead of the plan and the repo tree: a verifier reads this to find
    // the one value it must not derive, and burying it under a file
    // listing is how it ends up asking the operator instead.
    const upstreamBlock = renderUpstreamOutputsBlock(
        ctx.upstreamOutputs ?? [],
        ctx.upstreamOmitted ?? [],
        '#',
    );
    if (upstreamBlock) parts.push('', upstreamBlock);

    const outputsBlock = renderTaskOutputsBlock(ctx.taskOutputDir);
    if (outputsBlock) parts.push('', outputsBlock);

    if (ctx.latestPlanContent && ctx.latestPlanContent.length > 0) {
        parts.push('', '# Plan', ctx.latestPlanContent);
    }

    if (ctx.rejectFeedback) {
        parts.push('', '# Feedback to address', ctx.rejectFeedback);
    }
    if (ctx.investigationAnswer) {
        parts.push('', '# Investigation answer', ctx.investigationAnswer);
    }
    const clarificationBlock = renderClarificationBlock(
        ctx.clarifications ?? mergeClarifications([], ctx.humanAnswer),
        '#',
    );
    if (clarificationBlock) {
        parts.push('', clarificationBlock);
    }
    // Ahead of `repoBlock`: that one is a bulky file tree, and the text
    // this agent has to rewrite should not sit below it.
    if (ctx.projectContextBlock) {
        parts.push('', ctx.projectContextBlock);
    }
    if (ctx.repoBlock) {
        parts.push('', ctx.repoBlock);
    }

    return parts.join('\n');
}

/**
 * Write `TASK.md` to the worktree root so the agent persona's
 * "Read TASK.md thoroughly" instruction has a real file to read. The
 * file mirrors the prompt's structured blocks (title, type, plan id,
 * description, plan content, reject-feedback when present) so an
 * agent that ignores the prompt and only reads the file still has the
 * full context it needs to act. Best-effort: write failures are logged
 * but never throw — the agent still runs against the in-prompt copy.
 */
function writeTaskMd(
    worktreePath: string,
    ctx: TaskAgentContext,
    logger: Logger,
): void {
    const lines: string[] = [];
    lines.push(`# Task: ${ctx.title ?? ctx.taskId}`, '');
    const layout = renderWorkspaceLayoutBlock({ ...ctx, worktreePath });
    if (layout) lines.push(layout, '');
    lines.push(`- **Task ID:** ${ctx.taskId}`);
    if (ctx.type) lines.push(`- **Type:** ${ctx.type}`);
    if (ctx.planId) lines.push(`- **Plan:** ${ctx.planName ?? ctx.planId}`);
    lines.push(`- **Step:** ${ctx.stepId}`);
    lines.push('');
    if (ctx.ticketDetails?.goal) {
        lines.push('## Goal', '', ctx.ticketDetails.goal, '');
    }
    lines.push('## Description', '');
    lines.push(
        ctx.description && ctx.description.length > 0
            ? ctx.description
            : '(no description supplied)',
    );
    lines.push(...renderTicketSections(ctx.ticketDetails, '##'));
    const instructionsBlock = renderInstructionsBlock(ctx.instructions);
    if (instructionsBlock) {
        // Demote the single-`#` prompt heading to `##` so it nests under
        // the TASK.md `#` title.
        lines.push('', instructionsBlock.replace(/^# /, '## '));
    }
    const attachBlock = renderAttachmentsBlock(ctx.attachments);
    if (attachBlock) {
        // renderAttachmentsBlock emits a single-`#` heading for the prompt;
        // demote it to `##` so it nests under the TASK.md `#` title.
        lines.push('', attachBlock.replace(/^# /, '## '));
    }
    // The output folder belongs in TASK.md as well as the prompt: every
    // retained persona tells the agent to read TASK.md thoroughly, and
    // that file is the one it re-reads mid-run when deciding where
    // something goes.
    // TASK.md as well as the prompt, and this one matters more here than
    // most: the deploy-verifier persona tells the agent its inputs come
    // "from TASK.md", and that is the file it opens first.
    const upstreamSection = renderUpstreamOutputsBlock(
        ctx.upstreamOutputs ?? [],
        ctx.upstreamOmitted ?? [],
        '##',
    );
    if (upstreamSection) lines.push('', upstreamSection);

    const outputsSection = renderTaskOutputsBlock(ctx.taskOutputDir);
    if (outputsSection) {
        lines.push('', outputsSection.replace(/^# /, '## '));
    }
    if (ctx.latestPlanContent && ctx.latestPlanContent.length > 0) {
        lines.push('', '## Plan', '', ctx.latestPlanContent);
    }
    if (ctx.rejectFeedback) {
        lines.push('', '## Feedback to address', '', ctx.rejectFeedback);
    }
    if (ctx.investigationAnswer) {
        lines.push('', '## Investigation answer', '', ctx.investigationAnswer);
    }
    const clarificationSection = renderClarificationBlock(
        ctx.clarifications ?? mergeClarifications([], ctx.humanAnswer),
        '##',
    );
    if (clarificationSection) {
        lines.push('', clarificationSection);
    }
    const target = path.join(worktreePath, 'TASK.md');
    try {
        fs.writeFileSync(target, lines.join('\n'), 'utf8');
    } catch (err) {
        logger.warn('orchestrator: failed to write TASK.md', {
            taskId: ctx.taskId,
            target,
            error: err instanceof Error ? err.message : String(err),
        });
    }
    // Sidecar file with just the workspace-boundary rules. Some agents
    // (especially memory-driven ones) read CLAUDE.md / WORKSPACE_RULES.md
    // / AGENTS.md style files BEFORE following the in-prompt
    // instructions. Writing the constraints as a standalone file at the
    // worktree root means a file-first agent still hits the boundaries
    // immediately. Best-effort: a write failure logs but does not throw —
    // the in-prompt copy is the authoritative source.
    if (layout && layout.length > 0) {
        const rulesTarget = path.join(worktreePath, 'WORKSPACE_RULES.md');
        try {
            fs.writeFileSync(rulesTarget, layout, 'utf8');
        } catch (err) {
            logger.warn('orchestrator: failed to write WORKSPACE_RULES.md', {
                taskId: ctx.taskId,
                target: rulesTarget,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }
}

/**
 * Copy a task's + its plan's operator attachments (migration 021) into
 * `<worktree>/attachments/` and return the refs for the TASK.md / prompt
 * `# Attachments` block. The bytes come from the blob store; the directory
 * is git-excluded by the worktree's `.git/info/exclude` (`/attachments/`)
 * so they never land in the task's commit. Best-effort per file — a failed
 * copy is logged and skipped, never fatal to agent spawn.
 */
async function materializeTaskAttachments(
    worktreePath: string,
    taskId: string,
    planId: string | null,
    store: SqliteAttachmentStore,
    blobStore: AttachmentBlobStore,
    logger: Logger,
): Promise<TaskAttachmentRef[]> {
    // Each entry carries the owner type it was LOOKED UP under, rather
    // than reading it back off the row. A task worktree only ever gets
    // task and plan attachments - requirement attachments are design
    // input and deliberately do not flow down - and pairing the type
    // here is what proves that to the compiler, instead of narrowing a
    // wider value with a ternary that would silently mislabel anything
    // new.
    const metas: Array<{
        readonly meta: Attachment;
        readonly ownerType: 'task' | 'plan';
    }> = [
        // 'input' only, and this is load-bearing (migration 038). A
        // harvested OUTPUT copied back into a worktree would be handed to
        // the next agent as if the operator had attached it, and the
        // committer stages what it finds - a findings CSV would end up in
        // the repo and the PR.
        ...store.listFor('task', taskId, 'input')
            .map((meta) => ({ meta, ownerType: 'task' as const })),
        ...(planId
            ? store.listFor('plan', planId, 'input')
                .map((meta) => ({ meta, ownerType: 'plan' as const }))
            : []),
    ];
    if (metas.length === 0) return [];
    const dir = path.join(worktreePath, 'attachments');
    try {
        fs.mkdirSync(dir, { recursive: true });
    } catch (err) {
        logger.warn('orchestrator: failed to create worktree attachments dir', {
            taskId,
            dir,
            error: err instanceof Error ? err.message : String(err),
        });
        return [];
    }
    const refs: TaskAttachmentRef[] = [];
    const usedNames = new Set<string>();
    for (const { meta, ownerType } of metas) {
        try {
            const bytes = await blobStore.get(meta.storageKey);
            const name = uniqueAttachmentName(meta.fileName, usedNames);
            usedNames.add(name.toLowerCase());
            fs.writeFileSync(path.join(dir, name), bytes);
            refs.push({
                relPath: `attachments/${name}`,
                fileName: meta.fileName,
                contentType: meta.contentType,
                caption: meta.caption,
                ownerType,
            });
        } catch (err) {
            logger.warn('orchestrator: failed to materialise attachment', {
                taskId,
                attachmentId: meta.id,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }
    return refs;
}

/**
 * Produce a filesystem-safe, collision-free name for a materialised
 * attachment. Strips path separators + control / reserved characters,
 * falls back to `attachment` when nothing usable survives, and appends
 * `-2`, `-3`, … when a name is already taken in this worktree.
 */
function uniqueAttachmentName(fileName: string, used: ReadonlySet<string>): string {
    const base = (fileName.split(/[\\/]/).pop() ?? '');
    let safe = '';
    for (const ch of base) {
        if (ch.charCodeAt(0) < 0x20) continue;
        if ('<>:"|?*'.includes(ch)) continue;
        safe += ch;
    }
    safe = safe.trim() || 'attachment';
    if (!used.has(safe.toLowerCase())) return safe;
    const dot = safe.lastIndexOf('.');
    const stem = dot > 0 ? safe.slice(0, dot) : safe;
    const ext = dot > 0 ? safe.slice(dot) : '';
    for (let i = 2; ; i += 1) {
        const candidate = `${stem}-${i}${ext}`;
        if (!used.has(candidate.toLowerCase())) return candidate;
    }
}

/**
 * Build the attachments note for a lifecycle agent (migration 021).
 *
 * Lists each attachment's filename, type, and operator caption so the
 * agent knows what the operator pinned — to the PLAN for a planner /
 * decomposer, to the REQUIREMENT for an architect / design-verifier.
 * Returns '' when the store is unwired or the owner has none.
 */
function buildDesignAttachmentsNote(
    store: SqliteAttachmentStore | undefined,
    owner: DesignAttachmentOwner,
    ownerId: string,
    attachmentsRoot: string | undefined,
): string {
    if (!store) return '';
    // Design input only. Plans and requirements do not produce outputs
    // today, but the filter says what this block is FOR rather than
    // relying on that staying true.
    const metas = store.listFor(owner, ownerId, 'input');
    if (metas.length === 0) return '';
    // With a root wired, the block names the real path of each file (see
    // design-attachments.ts). Without one — minimal hosts, older tests —
    // fall back to the caption-only wording rather than promising paths
    // that were never written.
    if (typeof attachmentsRoot === 'string' && attachmentsRoot.length > 0) {
        return renderDesignAttachmentsNote(
            owner, attachmentsRoot, ownerId, metas,
        );
    }
    // No root wired, so there are no paths to promise. Says what it
    // knows and nothing more — the previous wording of this fallback
    // claimed the bytes were unavailable, which is still true HERE but
    // was wrong once the mirror existed.
    const lines: string[] = owner === 'requirement'
        ? [
            '# Requirement attachments',
            '',
            'The operator pinned the following file(s) to this requirement as'
            + ' input for the design. The bytes are not available to you, but'
            + ' the captions describe what they show — factor them into the'
            + ' design, and say plainly where a caption was not enough.',
            '',
        ]
        : [
            '# Plan attachments',
            '',
            'The operator pinned the following file(s) to this plan. The bytes'
            + ' are not in your working tree, but the captions describe what'
            + ' they show — factor them into the plan / task breakdown. The'
            + ' per-task developer agents receive the actual files to Read.',
            '',
        ];
    for (const m of metas) {
        const caption = m.caption ? ` — "${m.caption}"` : '';
        lines.push(`- ${m.fileName} (${m.contentType})${caption}`);
    }
    return lines.join('\n');
}

function assembleLifecyclePrompt(args: AssemblePromptArgs): string {
    const parts: string[] = [];

    // Workspace boundaries FIRST — before the persona — so the planner /
    // decomposer sets its allowed-paths mental model before reading the
    // brief or any repo CLAUDE.md. Without this block the lifecycle agents
    // ran with no filesystem boundary and would search the whole disk for
    // a repo named in the brief, landing on the operator's personal
    // checkouts under C:\Users\...\source\repos.
    const layout = renderWorkspaceLayoutBlock({
        ...(args.worktreePath !== undefined ? { worktreePath: args.worktreePath } : {}),
        ...(args.workspaceRepos !== undefined ? { workspaceRepos: args.workspaceRepos } : {}),
        ...(args.planAttachmentsDir !== undefined
            ? { planAttachmentsDir: args.planAttachmentsDir }
            : {}),
    });
    if (layout) parts.push(layout, '');

    // Load the role persona from `agents/<role>.CLAUDE.md` if available
    // and prepend it to the prompt. Without this, the agent runs with
    // only the structured context blocks below and no instructions on
    // how to behave — which surfaces as "what would you like me to
    // plan?" responses on regenerate runs and no narration between
    // tool calls during the run.
    const persona = loadAgentPersona(args.role, args.personaOverride);
    if (persona) parts.push(persona, '');

    // Style + Process guidance for the lifecycle (planner / decomposer)
    // agents. The persona file above instructs claude to output a
    // structured markdown document; without an explicit narration
    // directive, claude jumps straight to that document and the
    // operator sees a 30-second silence followed by the final answer.
    // The Process section reserves a narration phase BEFORE the
    // markdown document so the operator can follow the reasoning
    // live in the Show-agent stream.
    parts.push(
        '## Process',
        'The operator watches a live stream of your output (tool calls, thinking, '
        + 'and assistant text). Walk them through your reasoning before producing '
        + 'the final markdown document required by the role spec above. Specifically:',
        '',
        '  1. After reading the brief and the repository context, write a short '
        + 'paragraph (2–4 sentences) in plain prose about what you understand and '
        + 'how you intend to approach it. Surface anything ambiguous or risky.',
        '  2. If you need to inspect a file, briefly say what you are looking for '
        + 'before calling the tool. After the tool returns, briefly note what you '
        + 'found and how it changes (or doesn\'t change) your approach.',
        '  3. Use plain conversational sentences for this narration. Do not use '
        + 'markdown headings (# / ##) or bullet lists during narration — those are '
        + 'reserved for the final document.',
        '  4. Once your narration is complete and you have everything you need, '
        + 'produce the final markdown document the role spec calls for. The '
        + 'document is what the operator approves; the narration is the live '
        + 'reasoning that gets them there.',
        '',
    );

    parts.push(
        `Role: ${args.role}`,
        `Plan: ${args.planId}`,
        `Project: ${args.projectId}`,
    );
    if (args.revision !== undefined) parts.push(`Revision: ${args.revision}`);
    // The decomposer's archetype allow-lists key off this line. Default to
    // `feature` when unset so the planner-driven path keeps its behaviour;
    // the direct (planner-skipped) path passes the real archetype.
    if (args.kind === 'decomposer') {
        parts.push(`Plan archetype: ${args.archetype ?? 'feature'}`);
    }
    if (args.briefContent) {
        parts.push('', '# Brief', args.briefContent);
    }
    if (args.attachmentsNote) {
        parts.push('', args.attachmentsNote);
    }
    if (args.conventions && Object.keys(args.conventions).length > 0) {
        parts.push('', '# Conventions', JSON.stringify(args.conventions, null, 2));
    }
    if (args.feedback) {
        parts.push('', '# Human feedback', args.feedback);
    }
    // Answers to questions THIS agent asked on this plan. Rendered with the
    // shared renderer so the heading and the binding-precedence wording are
    // byte-identical to the task-agent prompt's — the decomposer's persona
    // promises `# Human clarification` through the shared escape-hatch block,
    // and a differently-worded block would be a different contract.
    if (args.clarifications && args.clarifications.length > 0) {
        const block = renderClarificationBlock(args.clarifications);
        if (block) parts.push('', block);
    }
    if (args.previousContent) {
        parts.push(
            '',
            args.kind === 'architect'
                ? '# Previous design + fan-out (adjust minimally — do not redesign)'
                : '# Previous implementation plan',
            args.previousContent,
        );
    }
    if (args.approvedContent) {
        parts.push('', '# Approved implementation plan', args.approvedContent);
    }
    if (args.memoryBlock) {
        parts.push('', args.memoryBlock);
    }
    // The enabled stack packs' design context — e.g. the dotnet-azure
    // pack's NuGet package graph, which carries its own
    // `# NuGet package graph (workspace)` heading and is '' when the scan
    // found nothing or failed.
    //
    // This append was MISSING: the block was computed, passed by both
    // call sites and declared on the args — and then dropped on the
    // floor. The decomposer's persona names it as the authority for
    // bump chains ("Source of truth: the per-publisher chain block in
    // the package graph context. Do not invent your own bump chain"),
    // so it was being told to copy from a block that never arrived —
    // leaving it to improvise the cross-repo publish order, or omit it.
    // Placed ahead of `repoBlock` because that one is a bulky file tree
    // and would bury this.
    if (args.stackContextBlock) {
        parts.push('', args.stackContextBlock);
    }
    // Operator-authored project description. Ahead of `repoBlock` for the
    // same reason as the package graph — the repo tree is bulky and would
    // bury it — and after the brief, because it is background for the
    // request rather than part of it.
    if (args.projectContextBlock) {
        parts.push('', args.projectContextBlock);
    }
    if (args.repoBlock) {
        parts.push('', args.repoBlock);
    }
    return parts.join('\n');
}

/**
 * Render the `# Workspace layout` block — absolute paths of every
 * registered repo plus an explicit instruction to stay inside the
 * pipeline workspace. Returns empty string when neither field is set
 * (legacy callers / tests without a repoProjectionStore wired) so the
 * prompt degrades gracefully.
 *
 * The block is rendered NEAR THE TOP of the prompt (after the persona,
 * before the task description) so it sets the agent's mental model
 * before it reads anything else. Without this, a CLAUDE.md baked into
 * a workspace clone — authored against the operator's local layout —
 * leaks relative paths like `../../catalog` and the agent walks up
 * the directory tree, landing on the operator's personal checkouts.
 */
export function renderWorkspaceLayoutBlock(
    ctx: {
        readonly worktreePath?: string;
        readonly workspaceRepos?: ReadonlyArray<WorkspaceRepoEntry>;
        /** Mirrored plan attachments — readable, outside every repo. */
        readonly planAttachmentsDir?: string;
        /**
         * This task's deliverable output folder (migration 038) —
         * WRITABLE, and also outside every repo. It has to be named
         * here for the same reason the attachments dir does: the
         * forbidden-paths section below rules out everything it does
         * not list, and an agent handed a path in one block and
         * forbidden it in the next obeys the prohibition.
         */
        readonly taskOutputDir?: string;
    },
    platform: NodeJS.Platform = process.platform,
): string {
    const wt = typeof ctx.worktreePath === 'string' && ctx.worktreePath.length > 0
        ? ctx.worktreePath
        : null;
    const repos = Array.isArray(ctx.workspaceRepos) ? ctx.workspaceRepos : [];
    const attachmentsDir
        = typeof ctx.planAttachmentsDir === 'string' && ctx.planAttachmentsDir.length > 0
            ? ctx.planAttachmentsDir
            : null;
    const outputDir
        = typeof ctx.taskOutputDir === 'string' && ctx.taskOutputDir.length > 0
            ? ctx.taskOutputDir
            : null;
    if (!wt && repos.length === 0 && attachmentsDir === null && outputDir === null) {
        return '';
    }

    // Derive an inferred workspace root from the worktree path (or the
    // first repo path) so we can name it explicitly in the prompt. The
    // worktree path always ends in `\worktrees\<taskId>`; trim that
    // suffix to surface the `.pipeline-workspace` root. Falls back to
    // a generic warning when the path doesn't match.
    const workspaceRoot = inferWorkspaceRoot(wt, repos);

    // The forbidden-path examples have to be written in the SHAPE the
    // agent will actually encounter. A macOS agent told to avoid
    // `C:\Users\<any>\source\repos` learns nothing about
    // `/Users/<any>/source/repos`, which is the tree that would really
    // get corrupted — the clause silently protects nothing.
    const onWindows = platform === 'win32';
    const forbiddenCheckoutPatterns = onWindows
        ? [
            'C:\\Users\\<any>\\source\\repos\\...',
            'C:\\Users\\<any>\\Documents\\...',
            'C:\\Users\\<any>\\Projects\\...',
        ]
        : [
            '/Users/<any>/source/repos/...   (macOS)',
            '/home/<any>/src/...             (Linux)',
            '~/Documents/... , ~/Projects/...',
        ];
    const homeCheckoutExample = onWindows
        ? 'C:\\Users\\<name>\\source\\repos\\...'
        : '/Users/<name>/source/repos/...';

    const lines: string[] = [
        '# !!! WORKSPACE BOUNDARIES — read this first !!!',
        '',
        'You are running inside an automated pipeline. The ONLY filesystem',
        'paths you may read or write are listed below. Any other path on',
        'disk — including the operator\'s personal repo checkouts — is OFF',
        'LIMITS, even if some other CLAUDE.md, persona file, plan text, or',
        'memory says otherwise.',
    ];
    if (wt) {
        lines.push(
            '',
            '## Your worktree (your cwd, where edits must land)',
            '',
            `  ${wt}`,
        );
    } else {
        // No worktree resolved. The repo paths below are the workspace's
        // SHARED CLONES, and this block used to present them exactly as
        // it does for a worktree run — "these are the paths you may read
        // or write". An agent that took it at its word wrote into the
        // clone, where the pre-spawn `git fetch && git reset --hard`
        // destroys the work (and any operator work in flight with it),
        // leaving the pipeline's own worktree empty. Say plainly that
        // this run cannot write anywhere.
        lines.push(
            '',
            '## You have NO worktree — this run is READ-ONLY',
            '',
            'No repo resolved for this run, so the pipeline could not give you',
            'a worktree, and your working directory is an empty scratch folder',
            'with no source in it.',
            '',
            'The repo paths listed below are the workspace\'s SHARED CLONES.',
            'The pipeline runs `git fetch && git reset --hard` on them before',
            'every agent: anything you write there is destroyed, and it',
            'destroys whatever else was in flight. Read them if you need to.',
            'Do NOT write to them, do not create a branch in them, and do not',
            'commit in them.',
            '',
            'If this task requires an edit, do not improvise a location for it.',
            'Emit `NEEDS_HUMAN_INPUT: no repo was resolved for this task, so I',
            'have no worktree to write in` and stop.',
        );
    }
    if (workspaceRoot) {
        lines.push(
            '',
            '## Pipeline workspace root',
            '',
            `  ${workspaceRoot}`,
            '',
            'Every legal path begins with the workspace root above.',
        );
    }
    if (repos.length > 0) {
        lines.push(
            '',
            wt
                ? '## Other repos available in the workspace'
                : '## Repos in the workspace — READ-ONLY, these are shared clones',
            '',
            'When the task asks you to read or reference code in another repo,',
            'use ONLY the absolute paths below. Do NOT walk up the directory',
            'tree looking for a sibling repo with the same name elsewhere.',
            '',
        );
        for (const r of repos) {
            const label = r.name && r.name.length > 0 ? r.name : r.repoId;
            lines.push(`  - ${label} (${r.repoId}): ${r.path}`);
        }
        if (!wt) {
            lines.push(
                '',
                'Every path above is READ-ONLY for this run. See the warning above.',
            );
        }
    } else {
        lines.push(
            '',
            '## Other repos available in the workspace',
            '',
            wt
                ? 'None. Only your working clone above is available.'
                : 'None. You have no worktree and no repo — you cannot write anywhere.',
        );
    }
    if (attachmentsDir !== null) {
        // Named explicitly because "any directory outside the workspace
        // root" is forbidden below and this one sits beside `repos/` and
        // `worktrees/` rather than inside them. Without this line the
        // prompt hands the agent a path in one block and forbids it in
        // the next — and the agent obeys the forbidding one.
        lines.push(
            '',
            '## Operator attachments for this plan (READ-ONLY, but readable)',
            '',
            `  ${attachmentsDir}`,
            '',
            'Files the operator pinned to this plan. Reading them is expected —',
            'a CSV or spec attached here is usually the actual requirement.',
            'Do not write anything into this directory.',
        );
    }
    if (outputDir !== null) {
        lines.push(
            '',
            '## Deliverable output folder for this task (WRITABLE)',
            '',
            `  ${outputDir}`,
            '',
            'The second place you are allowed to write, besides your worktree.',
            'Files you produce FOR THE OPERATOR go here — a results CSV, an',
            'exported report — and are attached to the task for download. It',
            'is not part of any repo, so nothing here is ever committed.',
        );
    }
    lines.push(
        '',
        '## Referenced repos that are NOT listed above',
        '',
        'The brief or plan may name another repo as a "reference", "prototype",',
        'or "example" (e.g. a `*.prototype` repo). If that repo is NOT in the',
        'allow-list above, it has NOT been added to the workspace and is',
        'UNAVAILABLE to you. In that case:',
        '',
        '  - Do NOT search the filesystem for it (no `find` / globbing across',
        '    the disk, no reading a copy from the operator\'s personal',
        `    checkouts under ${homeCheckoutExample} or anywhere else).`,
        '  - Proceed using only the repos listed above, and explicitly note in',
        '    your output that the referenced repo was not available — or emit',
        '    `NEEDS_HUMAN_INPUT: <question>` asking the operator to add it to',
        '    the project if you genuinely cannot proceed without it.',
    );
    lines.push(
        '',
        '## Forbidden paths',
        '',
        'NEVER read or write under any of these patterns, even if they exist',
        'on disk and contain code that "looks right":',
        '',
        '  - Any directory outside the workspace root above.',
        '  - Common operator-checkout patterns the agent must NOT touch:',
        ...forbiddenCheckoutPatterns.map((p) => `      * ${p}`),
        '      * Anything under the operator\'s home directory.',
    );
    lines.push(
        '',
        '## Verification protocol — BEFORE every Edit / Write tool call',
        '',
        // Without a worktree there is NO legal write target, so the
        // worktree-run wording ("one of the paths listed above") would
        // read as permission to write into the shared clones.
        wt
            ? '  1. Confirm the target path begins with one of the absolute paths'
                + '\n     listed under "Your worktree" or "Other repos available" above'
                + (outputDir !== null
                    ? ',\n     or with the deliverable output folder.'
                    : '.')
            : '  1. STOP. You have no worktree, so there is no legal write target.'
                + (outputDir !== null
                    ? '\n     The ONE exception is the deliverable output folder above:'
                        + '\n     a produced file may be written there. Every repo path'
                        + '\n     listed above is read-only for this run.'
                    : '\n     Every path listed above is read-only for this run.'),
        '  2. If the path you have in mind starts with anything else (a',
        '     forbidden root, an operator checkout, a shorter prefix that',
        '     happens to also exist on disk), STOP. Do not write.',
        '  3. If you cannot resolve a target path to one of the allowed',
        '     prefixes, emit `NEEDS_HUMAN_INPUT: <question>` instead of',
        '     guessing. A wrong-path write corrupts the operator\'s personal',
        '     repo — that\'s worse than asking.',
        '',
        '## Why this matters',
        '',
        'The pipeline clones each repo into the workspace root and gives you',
        'a worktree on a feature branch. The operator may have unrelated',
        'personal checkouts of the same repos elsewhere on disk (typically',
        `under paths like \`${homeCheckoutExample}\`). Those`,
        'checkouts are NOT the pipeline workspace — writing there corrupts',
        'the operator\'s working files and leaves the pipeline\'s worktree',
        'empty, which the committer correctly refuses.',
        '',
        'Any CLAUDE.md you encounter at a parent directory of the worktree',
        '(e.g. a workspace overview describing repo paths) is OUT OF SCOPE',
        'for you. The Workspace layout above is the authoritative source for',
        'where each repo lives — not the CLAUDE.md walk.',
    );
    return lines.join('\n');
}

/**
 * Infer the pipeline workspace root from the worktree path. The
 * pipeline always lays worktrees out as `<root>/worktrees/<taskId>`,
 * so trimming that suffix gives the `.pipeline-workspace` root. Falls
 * back to a parent of a repo path when the worktree is unset (legacy
 * tests). Returns null when no inference is possible.
 */
function inferWorkspaceRoot(
    worktreePath: string | null,
    repos: ReadonlyArray<WorkspaceRepoEntry>,
): string | null {
    if (worktreePath) {
        const wt = worktreePath.replace(/[\\/]+$/, '');
        const m = wt.match(/^(.+)[\\/]worktrees[\\/][^\\/]+$/);
        if (m) return m[1];
    }
    if (repos.length > 0) {
        const p = repos[0].path.replace(/[\\/]+$/, '');
        const m = p.match(/^(.+)[\\/]repos[\\/][^\\/]+$/);
        if (m) return m[1];
    }
    return null;
}

function renderRepoBlock(
    claudeMd: string | null,
    tree: ReadonlyArray<string>,
    sampleFiles: Readonly<Record<string, string>>,
): string {
    const sections: string[] = ['# Repository context'];
    if (claudeMd && claudeMd.length > 0) {
        sections.push('## CLAUDE.md', claudeMd);
    }
    if (tree.length > 0) {
        sections.push('## File tree', tree.join('\n'));
    }
    const sampleEntries = Object.entries(sampleFiles);
    if (sampleEntries.length > 0) {
        sections.push('## Sample files');
        for (const [relPath, body] of sampleEntries) {
            sections.push(`### ${relPath}`, body);
        }
    }
    return sections.join('\n');
}

/**
 * AP-VP4-010 — wire the BriefSubmitted / AgentFinished / AgentFailed
 * subscribers that drive the agent-emitted half of the plan lifecycle.
 *
 * Behaviour:
 *
 *   - On `BriefSubmitted`: spawn the planner agent with revision === 1
 *     (AC #1). The planId is derived from the brief: `plan-<briefId>` so
 *     a brief always has a deterministic plan id without needing a
 *     separate `idGen` call.
 *   - On `AgentFinished` for a recorded lifecycle agent:
 *       * planner   → emit `PlanGenerated` carrying the agent's markdown
 *                     `content`, the recorded `revision`, and (if set)
 *                     the `feedback` that triggered the run. (AC #1, #2.)
 *       * decomposer → parse the JSON body and validate against
 *                      `core/decomposer/task.schema.json` (via
 *                      `validateDecomposerOutput`). On success emit
 *                      `PlanDecomposed` (AC #3); on failure emit
 *                      `PlanDecomposeFailed` (AC #4) AND append the
 *                      validation error to the project's
 *                      `agent-memory.jsonl` as `clarification` feedback
 *                      so the next planner run learns from the failure
 *                      (AC #5). The handler does NOT auto-retry — the
 *                      decompose modal surfaces Regenerate (per task
 *                      hint).
 *   - On `AgentFailed`: emit the matching `Plan*Failed` event (planner →
 *     `PlanGenerateFailed`; decomposer → `PlanDecomposeFailed`). The
 *     decomposer-side variant also routes the failure into agent memory.
 *
 * Idempotency keys are deterministic per (planId, revision) for planner
 * outputs and per (planId, agentId) for decomposer outputs so duplicate
 * AgentFinished publishes (replay, crash recovery) collapse at the event
 * store rather than emitting duplicate PlanGenerated rows.
 *
 * The function returns an unsubscribe closure the orchestrator host can
 * invoke from its `stop()` path to drop the listeners cleanly between
 * suites in a long-running test runner.
 */
export interface RegisterPlanLifecycleAgentHandlersDeps {
    readonly clock: () => number;
    readonly logger: Logger;
    readonly plannerRole?: string;
    readonly decomposerRole?: string;
    readonly plannerModel?: string;
    readonly decomposerModel?: string;
    readonly agentRunner: AgentRunner;
    readonly registerAgent: (agentId: string, taskId: string) => void;
    readonly deferAgentStart: (run: () => void) => void;
    readonly lifecycleAgents: Map<string, LifecycleAgentContext>;
    readonly agentMemory?: AgentMemoryStore;
    readonly repoReader?: RepoReader;
    readonly repoSpec?: RepoSpec;
    /**
     * Attachment metadata + the mirror roots, for the
     * `# Plan attachments` / `# Requirement attachments` prompt blocks.
     *
     * These were missing from this registration entirely, so every
     * agent it spawns - planner, decomposer, architect,
     * design-verifier - built its note from an undefined store and got
     * ''. The architect said so out loud: "The referenced 'document'
     * describing the connection is not attached", about a document the
     * operator had attached and the worker had logged.
     *
     * Optional like the rest, which is why nothing caught it: absent
     * means no block, and no block compiles.
     */
    readonly attachmentStore?: SqliteAttachmentStore;
    readonly planAttachmentsRoot?: string;
    readonly requirementAttachmentsRoot?: string;
    /**
     * Per-spawn `RepoSpec` resolver — same shape as on
     * {@link HandlerDeps}. Threaded into the inner `spawnDeps` used
     * by the BriefSubmitted path so a planner auto-spawned by a brief
     * gets the same pre-spawn refresh + repo-block plumbing the
     * operator-driven GeneratePlan path uses.
     */
    readonly resolveRepoSpec?: (
        args: StartLifecycleAgentArgs,
    ) => Promise<RepoSpec | null>;
    /**
     * Registered workspace repos — threaded into the spawn path so the
     * re-spawned planner/decomposer gets the same `# !!! WORKSPACE
     * BOUNDARIES` allow-list the operator-driven GeneratePlan path builds.
     */
    readonly listWorkspaceRepos?: () => ReadonlyArray<WorkspaceRepoEntry>;
    /**
     * Actor stamped onto the agent-emitted lifecycle events. The runner
     * has no notion of the operator who originally dispatched the
     * triggering command, so a stable bot identifier (default
     * `'planner-agent'` / `'decomposer-agent'`) is the honest answer.
     */
    readonly plannerActor?: string;
    readonly decomposerActor?: string;
    // --- Architect Tier (Phase 2) ---
    readonly architectRole?: string;
    readonly architectModel?: string;
    readonly architectActor?: string;
    /** Build the systems-catalog entries fed into the architect's prompt. */
    readonly listSystems?: () => ReadonlyArray<SystemCatalogEntry>;
    /**
     * Read a requirement's title/description from the projection — used on a
     * regenerate (RequirementSubmitted revision > 1 carries them empty).
     */
    readonly getRequirement?: (
        requirementId: string,
    ) => { readonly title: string; readonly description: string } | null;
    // --- Fan-out verification gate ---
    readonly designVerifierRole?: string;
    readonly designVerifierModel?: string;
    /** See HandlerDeps.getStackContextBlock. */
    readonly getStackContextBlock?: () => string;
    /**
     * The enabled stack packs' hooks. The decomposition checks (deletion
     * references, impact) run through these; with no pack enabled there
     * are none, because core does not know any language well enough to
     * scan it.
     */
    readonly stackHooks?: readonly StackHooks[];
    /**
     * The task types of the flows this process runs — the decomposer's
     * allowed set comes from here. The orchestrator passes its live flow
     * map; without it (tests, tools) the flows are loaded from the same
     * layers the orchestrator would use.
     */
    readonly getTaskTypes?: () => TaskTypeCatalog;
    /** See HandlerDeps.getProjectContextBlock. */
    readonly getProjectContextBlock?: (projectId: string) => string;
    /**
     * Read the approved proposal the design-verifier audits: the full
     * design doc, every sub-brief, and the rollout order. Wired from the
     * requirement projection store by the host; absent (tests without the
     * architect tier) means DesignVerificationStarted events fail loudly
     * as a verification error instead of spawning a blind agent.
     */
    readonly getRequirementDesign?: (requirementId: string) => {
        readonly designDoc?: string;
        readonly subBriefs: ReadonlyArray<{
            readonly systemId: string;
            readonly title?: string;
            readonly brief: string;
        }>;
        readonly rollout?: string;
    } | undefined;
    /** Management UI (Option B): per-role persona override (Agent.prompt). */
    readonly resolveAgentPrompt?: (role: string) => string | undefined;
    /**
     * Optional read-only DB handle used by the decomposer's task-ID
     * rewriter. When supplied, `emitPlanDecomposed` looks up the
     * project's `metadata.abbr` + the plan's name and rewrites each
     * task id from the decomposer's raw `task-001` form into
     * `<projectAbbr>-<planAbbr>-<nnn>` so commit branches /
     * task_step_summaries / PR titles all carry a human-readable
     * identifier instead of the generic `task-001`.
     */
    readonly db?: import('../../core/state/migrations').Db;
}

/**
 * Shape of the AgentFinished / AgentFailed payloads we care about.
 * Defined locally so this module does not need to import the runner's
 * private types.
 */
interface AgentFinishedPayload {
    readonly agentId: string;
    readonly role?: string;
    readonly outcome: string;
    readonly content?: string;
    /**
     * The terminal frame's error text on a non-success outcome — an API
     * rejection, a context-length error. Absent when the CLI reported no
     * detail beyond the subtype.
     */
    readonly error?: string;
}
interface AgentFailedPayload {
    readonly agentId: string;
    readonly role?: string;
    readonly exitCode?: number | null;
    readonly stderrTail?: string;
}

export function registerPlanLifecycleAgentHandlers(
    bus: EventBus,
    deps: RegisterPlanLifecycleAgentHandlersDeps,
): () => void {
    const plannerRole = deps.plannerRole ?? 'planner';
    const decomposerRole = deps.decomposerRole ?? 'decomposer';
    // 'none' (not a hardcoded alias) when unset: resolveModel treats it as
    // "no per-call override" and falls through to the runner's
    // defaultModels[role] (from pipeline.yaml) then the CLAUDE_MODEL_<ROLE> /
    // CLAUDE_MODEL env vars. The orchestrator threads the configured
    // default_models.planner / .decomposer into deps, so in practice this
    // carries the YAML value.
    const plannerModel = deps.plannerModel ?? 'none';
    const decomposerModel = deps.decomposerModel ?? 'none';
    const plannerActor = deps.plannerActor ?? 'planner-agent';
    const decomposerActor = deps.decomposerActor ?? 'decomposer-agent';
    const architectRole = deps.architectRole ?? 'architect';
    const architectModel = deps.architectModel ?? 'none';
    const designVerifierRole = deps.designVerifierRole ?? 'design-verifier';
    const designVerifierModel = deps.designVerifierModel ?? 'none';
    const architectActor = deps.architectActor ?? 'architect-agent';

    // Inner-deps view that satisfies `startLifecycleAgent`'s HandlerDeps
    // signature without forcing callers to construct a full HandlerDeps.
    // Only the fields the spawn path actually reads are required.
    const spawnDeps: HandlerDeps = {
        clock: deps.clock,
        idGen: { newId: (): string => `agent-${deps.clock()}` },
        logger: deps.logger,
        defaultFlowId: '',
        defaultProjectId: '',
        defaultTaskType: '',
        agentRunner: deps.agentRunner,
        registerAgent: deps.registerAgent,
        deferAgentStart: deps.deferAgentStart,
        agentMemory: deps.agentMemory,
        lifecycleAgents: deps.lifecycleAgents,
        repoReader: deps.repoReader,
        repoSpec: deps.repoSpec,
        resolveRepoSpec: deps.resolveRepoSpec,
        listWorkspaceRepos: deps.listWorkspaceRepos,
        ...(deps.getStackContextBlock
            ? { getStackContextBlock: deps.getStackContextBlock }
            : {}),
        ...(deps.getProjectContextBlock
            ? { getProjectContextBlock: deps.getProjectContextBlock }
            : {}),
        ...(deps.resolveAgentPrompt ? { resolveAgentPrompt: deps.resolveAgentPrompt } : {}),
        // The operator's attached files. Forwarded, not re-derived:
        // `startLifecycleAgent` reads them off whatever deps it is
        // handed, and this object is the one every spawn in this
        // registration uses.
        ...(deps.attachmentStore ? { attachmentStore: deps.attachmentStore } : {}),
        ...(deps.planAttachmentsRoot
            ? { planAttachmentsRoot: deps.planAttachmentsRoot }
            : {}),
        ...(deps.requirementAttachmentsRoot
            ? { requirementAttachmentsRoot: deps.requirementAttachmentsRoot }
            : {}),
    };

    const offBrief = bus.subscribe<BriefSubmittedEventPayload>(
        PlanLifecycleEvents.BRIEF_SUBMITTED,
        async (event) => {
            const { briefId, projectId, content } = event.payload;
            const planId = `plan-${briefId}`;
            const archetype = event.payload.archetype;
            // Non-feature archetypes (documentation / review-codebase /
            // review-azure / deploy-only / investigate) don't need an
            // implementation plan — skip the planner and decompose the brief
            // straight into the archetype's task(s). The decomposer's
            // archetype allow-lists produce exactly the right task type(s).
            if (typeof archetype === 'string' && archetype.length > 0 && archetype !== 'feature') {
                startLifecycleAgent(spawnDeps, {
                    kind: 'decomposer',
                    role: decomposerRole,
                    model: decomposerModel,
                    planId,
                    projectId,
                    approvedContent: content,
                    archetype,
                    ...(event.payload.conventions !== undefined
                        ? { conventions: event.payload.conventions }
                        : {}),
                });
                return;
            }
            // Feature (or unset): the planner produces a plan to review, then
            // the operator approves → DecomposePlan.
            startLifecycleAgent(spawnDeps, {
                kind: 'planner',
                role: plannerRole,
                model: plannerModel,
                planId,
                projectId,
                revision: 1,
                briefId,
                briefContent: content,
                conventions: event.payload.conventions,
            });
        },
    );

    // Architect Tier — a requirement submission spawns the architect as a
    // third lifecycle-agent kind. It runs output-only (like the planner):
    // the prompt carries the requirement + the systems catalog; its final
    // message is the design Markdown + a ```json proposal we parse on finish.
    const offRequirement = bus.subscribe<RequirementSubmittedPayload>(
        RequirementEvents.REQUIREMENT_SUBMITTED,
        async (event) => {
            const p = event.payload;
            if (typeof p?.requirementId !== 'string' || p.requirementId.length === 0) return;
            // On a regenerate the event carries empty title/description; read
            // them back from the projection so the re-run has the ask.
            let title = p.title;
            let description = p.description;
            if ((!title || !description) && deps.getRequirement) {
                const r = deps.getRequirement(p.requirementId);
                if (r) {
                    title = title || r.title;
                    description = description || r.description;
                }
            }
            const catalog = renderSystemsCatalogBlock(deps.listSystems?.() ?? []);
            const briefContent = [
                `The business requirement to design across systems:`,
                ``,
                `Title: ${title}`,
                ``,
                description,
                ``,
                `---`,
                ``,
                catalog,
            ].join('\n');
            // Regenerate (revision > 1): thread the PREVIOUS design +
            // fan-out into the prompt so the architect ADJUSTS it against
            // the feedback (verification findings / operator notes)
            // instead of redesigning from scratch — same previousContent
            // pattern the planner's regenerate uses. Without this the
            // architect never saw its prior proposal and every re-run
            // could restructure parts the findings never questioned.
            let previousContent: string | undefined;
            const revision = typeof p.revision === 'number' ? p.revision : 1;
            if (revision > 1 && deps.getRequirementDesign) {
                const prior = deps.getRequirementDesign(p.requirementId);
                if (prior && (prior.designDoc || prior.subBriefs.length > 0)) {
                    const parts: string[] = [];
                    if (prior.designDoc) parts.push(prior.designDoc);
                    if (prior.subBriefs.length > 0) {
                        parts.push('', '## Previous fan-out (sub-briefs)');
                        for (const sb of prior.subBriefs) {
                            parts.push(
                                '',
                                `### System: ${sb.systemId}${sb.title ? ` — ${sb.title}` : ''}`,
                                sb.brief,
                            );
                        }
                    }
                    if (prior.rollout) {
                        parts.push('', '## Previous rollout order', prior.rollout);
                    }
                    previousContent = parts.join('\n');
                }
            }
            startLifecycleAgent(spawnDeps, {
                kind: 'architect',
                role: architectRole,
                model: architectModel,
                planId: `req-${p.requirementId}`,
                projectId: '',
                revision: p.revision,
                requirementId: p.requirementId,
                briefContent,
                ...(previousContent !== undefined ? { previousContent } : {}),
                ...(p.feedback !== undefined ? { feedback: p.feedback } : {}),
            });
        },
    );

    // Fan-out verification gate: DesignVerificationStarted (published by
    // the ArchitectureApproved subscriber, or by the operator's Retry
    // verification) spawns the design-verifier, which audits the sub-brief
    // proposal against the full design BEFORE any plan exists. Its verdict
    // routes in the AgentFinished/AgentFailed handlers below.
    const spawnDesignVerifier = (
        requirementId: string,
        revision: number,
        extraFeedback?: string,
    ): void => {
        const design = deps.getRequirementDesign?.(requirementId);
        const req = deps.getRequirement?.(requirementId);
        if (!design || design.subBriefs.length === 0) {
            // No proposal to audit — surface as a verification error
            // (never silently swallow the gate; the operator gets the
            // Implement-anyway / Retry buttons).
            void bus.publish({
                type: RequirementEvents.DESIGN_VERIFICATION_FAILED,
                v: 1,
                occurredAt: deps.clock(),
                idempotencyKey: `dv-fail:${requirementId}:r${revision}:${deps.clock()}`,
                payload: {
                    requirementId,
                    revision,
                    findings: [],
                    error: 'no fan-out proposal found to verify (sub-briefs missing from the projection)',
                },
            });
            return;
        }
        const parts: string[] = [
            'You are verifying a fan-out PROPOSAL against an approved architecture design.',
            '',
            `Requirement: ${req?.title ?? requirementId}`,
            '',
            req?.description ?? '',
            '',
            '# Approved architecture design',
            design.designDoc ?? '(no design document recorded)',
        ];
        if (design.rollout) {
            parts.push('', '# Rollout order', design.rollout);
        }
        parts.push('', '# Proposed fan-out (one plan per system)');
        for (const sb of design.subBriefs) {
            parts.push(
                '',
                `## System: ${sb.systemId}${sb.title ? ` — ${sb.title}` : ''}`,
                sb.brief,
            );
        }
        const catalog = renderSystemsCatalogBlock(deps.listSystems?.() ?? []);
        if (catalog) parts.push('', catalog);
        startLifecycleAgent(spawnDeps, {
            kind: 'design-verifier',
            role: designVerifierRole,
            model: designVerifierModel,
            planId: `req-${requirementId}`,
            projectId: '',
            revision,
            requirementId,
            briefContent: parts.join('\n'),
            ...(extraFeedback !== undefined ? { feedback: extraFeedback } : {}),
        });
    };

    const offVerifyStart = bus.subscribe<DesignVerificationStartedPayload>(
        RequirementEvents.DESIGN_VERIFICATION_STARTED,
        async (event) => {
            const p = event.payload;
            if (typeof p?.requirementId !== 'string' || p.requirementId.length === 0) return;
            spawnDesignVerifier(
                p.requirementId,
                typeof p.revision === 'number' ? p.revision : 1,
            );
        },
    );

    // One corrective retry per (requirement, revision) when the verifier's
    // reply has no parseable verdict — same policy as the architect.
    const verifierRetryLedger = new Set<string>();

    // Spawn inputs of decomposer runs currently held on an unanswered
    // question, keyed by planId. Process-local — the durable record is
    // `decomposer_clarifications` — so the answer path must work without it.
    const pendingDecomposerQuestions = new Map<string, LifecycleAgentContext>();

    const offFinished = bus.subscribe<AgentFinishedPayload>(
        'AgentFinished',
        async (event) => {
            const ctx = deps.lifecycleAgents.get(event.payload.agentId);
            if (!ctx) return; // Not one of our agents — leave for other subscribers.
            deps.lifecycleAgents.delete(event.payload.agentId);
            if (event.payload.outcome !== 'success') {
                // The close-handler path publishes AgentFinished with
                // outcome === 'interrupted' for operator-killed runs. We
                // do NOT auto-emit PlanGenerated / PlanDecomposed on
                // those — the modal owns the Regenerate decision — and an
                // interrupt is not a failure to report back to the person
                // who asked for it.
                if (event.payload.outcome === 'interrupted') {
                    deps.logger.info('orchestrator: lifecycle agent interrupted; skipping emit', {
                        agentId: event.payload.agentId,
                        kind: ctx.kind,
                    });
                    return;
                }
                // Anything else is a real failure and MUST be reported.
                // This branch used to log one info line and return, so an
                // API-level rejection left the card spinning with no
                // event, no error on the plan, and nothing on the board —
                // the operator's only clue was a line in worker.log.
                const reason = event.payload.error
                    ?? apiErrorLine(event.payload.content ?? '')
                    ?? `the agent ended with outcome "${event.payload.outcome}"`;
                deps.logger.warn('orchestrator: lifecycle agent finished non-success', {
                    agentId: event.payload.agentId,
                    outcome: event.payload.outcome,
                    kind: ctx.kind,
                    reason,
                });
                await reportLifecycleFailure(bus, deps, ctx, reason);
                return;
            }
            const content = event.payload.content ?? '';
            // A `success` outcome whose body is an API-error banner: the
            // CLI printed `API Error: 400 …` instead of doing the work and
            // exited 0. Task agents have always caught this; lifecycle
            // agents did not, so a flagged decomposition surfaced as
            // "decomposer output contains no JSON object" — true, and
            // useless for working out what to change.
            if (looksLikeApiError(content)) {
                const reason = apiErrorLine(content) ?? content.trim().slice(0, 400);
                deps.logger.warn('orchestrator: lifecycle agent returned an API error as its output', {
                    agentId: event.payload.agentId,
                    kind: ctx.kind,
                    reason,
                });
                await reportLifecycleFailure(bus, deps, ctx, reason);
                return;
            }
            if (ctx.kind === 'design-verifier') {
                await handleDesignVerifierFinished(bus, deps, ctx, content, {
                    respawn: spawnDesignVerifier,
                    retriedOnce: verifierRetryLedger,
                });
            } else if (ctx.kind === 'architect') {
                await emitArchitectureProposed(bus, deps, architectActor, ctx, content);
            } else if (ctx.kind === 'planner') {
                await emitPlanGenerated(bus, deps.clock, plannerActor, ctx, content);
                // A successful run supersedes any recorded failure — clear
                // the durable error so the plan card stops showing it.
                // No-op (no event) when no error was recorded.
                await patchPlanMetadata(
                    bus,
                    deps,
                    ctx.planId,
                    { plannerError: null, plannerErrorAt: null },
                    { onlyIfSet: 'plannerError' },
                );
            } else {
                await emitPlanDecomposed(
                    bus, deps, decomposerActor, ctx, content,
                    pendingDecomposerQuestions,
                );
            }
        },
    );

    // The operator answered a decomposer question — re-spawn the decomposer
    // with every answer given on this plan in front of it.
    //
    // Event-driven rather than done inside the command handler: the command
    // validates and emits, subscribers act. It also means a replayed
    // PlanDecomposeQuestionAnswered re-drives the same spawn, which is the
    // behaviour we want if the process died between the two.
    // An abandoned question releases the in-memory spawn context too.
    // Deliberately the ONLY subscriber on this event: the absence of a
    // re-spawn is what makes abandoning different from answering, and
    // leaving the context behind would let a later answer resurrect a
    // run the operator had given up on.
    const offQuestionAbandoned = bus.subscribe<{ readonly planId?: string }>(
        PlanLifecycleAgentEvents.PLAN_DECOMPOSE_QUESTION_ABANDONED,
        async (event) => {
            const planId = event.payload?.planId;
            if (typeof planId !== 'string' || planId.length === 0) return;
            pendingDecomposerQuestions.delete(planId);
            deps.logger.info(
                'orchestrator: decomposer question abandoned; not re-spawning',
                { planId },
            );
        },
    );

    const offQuestionAnswered = bus.subscribe<PlanDecomposeQuestionAnsweredPayload>(
        PlanLifecycleAgentEvents.PLAN_DECOMPOSE_QUESTION_ANSWERED,
        async (event) => {
            const { planId, projectId, question, answer, remember } = event.payload;
            if (typeof planId !== 'string' || planId.length === 0) return;
            const pending = pendingDecomposerQuestions.get(planId);
            pendingDecomposerQuestions.delete(planId);

            // `remember` files the decision project-wide so the NEXT plan is
            // designed knowing it. Best-effort: a memory write must never
            // block the re-spawn the operator is waiting on.
            if (remember === true && deps.agentMemory) {
                try {
                    const entry: AgentMemoryEntry = {
                        source: 'clarification',
                        taskIdentifier: planId,
                        taskTitle: 'decomposer question',
                        feedback: question ? `Q: ${question}\nA: ${answer}` : answer,
                        recordedAt: deps.clock(),
                    };
                    deps.agentMemory.append(projectId, entry);
                } catch (err) {
                    deps.logger.warn('orchestrator: remembering a decomposer answer failed', {
                        planId,
                        error: err instanceof Error ? err.message : String(err),
                    });
                }
            }

            // Every answer on the plan, not just this one: a second question
            // must not erase the first decision. Falls back to the event's
            // own Q&A when the projection has not folded the row yet (the
            // two are different subscribers on the same event).
            let clarifications = readDecomposerClarifications(deps.db, planId);
            if (!clarifications.some((c) => c.answer.trim() === answer.trim())) {
                clarifications = [...clarifications, { question: question || null, answer }];
            }

            const resolved = pending ?? rebuildDecomposerSpawnContext(deps, planId, projectId);
            if (!resolved) {
                // Never silently drop the operator's answer: without the
                // approved plan body a re-spawn would decompose nothing.
                await emitPlanDecomposeFailed(
                    bus,
                    deps,
                    { kind: 'decomposer', planId, projectId },
                    'answer recorded, but the decomposer run context is gone (worker restarted '
                    + 'and no approved plan body is in the projection). Re-approve the plan to '
                    + 'decompose again — your answer is stored and will be threaded in.',
                );
                return;
            }

            startLifecycleAgent(spawnDeps, {
                kind: 'decomposer',
                role: decomposerRole,
                model: decomposerModel,
                planId,
                projectId: resolved.projectId || projectId,
                clarifications,
                ...(resolved.approvedContent !== undefined
                    ? { approvedContent: resolved.approvedContent }
                    : {}),
                ...(resolved.conventions !== undefined
                    ? { conventions: resolved.conventions }
                    : {}),
                ...(resolved.briefContent !== undefined
                    ? { briefContent: resolved.briefContent }
                    : {}),
                ...(resolved.archetype !== undefined ? { archetype: resolved.archetype } : {}),
            });
            deps.logger.info('orchestrator: re-spawning the decomposer with the operator answer', {
                planId,
                answers: clarifications.length,
                restored: pending ? 'in-memory' : 'projection',
            });
        },
    );

    const offFailed = bus.subscribe<AgentFailedPayload>(
        'AgentFailed',
        async (event) => {
            const ctx = deps.lifecycleAgents.get(event.payload.agentId);
            if (!ctx) return;
            deps.lifecycleAgents.delete(event.payload.agentId);
            const reason = event.payload.stderrTail ?? `exitCode=${event.payload.exitCode ?? 'null'}`;
            await reportLifecycleFailure(bus, deps, ctx, reason);
        },
    );

    return (): void => {
        offBrief();
        offRequirement();
        offVerifyStart();
        offFinished();
        offFailed();
        offQuestionAnswered();
        offQuestionAbandoned();
    };
}

/**
 * Rebuild the inputs of a decomposer run whose in-memory context is gone —
 * the worker restarted between the question and the answer.
 *
 * The approved plan body is the one input a re-spawn cannot do without, and
 * `plan_review_drafts` holds it at the latest revision: exactly the source
 * the `/plan-review/approve` route reads when it dispatches DecomposePlan in
 * the first place. Returns null when there is no such row, and the caller
 * turns that into a visible failure rather than an empty spawn.
 */
function rebuildDecomposerSpawnContext(
    deps: RegisterPlanLifecycleAgentHandlersDeps,
    planId: string,
    projectId: string,
): LifecycleAgentContext | null {
    if (!deps.db) return null;
    try {
        const row = deps.db
            .prepare(
                `SELECT content, project_id FROM plan_review_drafts
                  WHERE plan_id = ?
                  ORDER BY revision DESC
                  LIMIT 1`,
            )
            .get(planId) as { content?: string; project_id?: string | null } | undefined;
        const content = typeof row?.content === 'string' ? row.content : '';
        if (content.trim().length === 0) return null;
        return {
            kind: 'decomposer',
            planId,
            projectId: row?.project_id || projectId,
            approvedContent: content,
        };
    } catch (err) {
        deps.logger.warn('orchestrator: could not rebuild the decomposer spawn context', {
            planId,
            error: err instanceof Error ? err.message : String(err),
        });
        return null;
    }
}

/**
 * Route the design-verifier's final message: parse the JSON verdict and
 * publish the matching gate events. Pass → DesignVerificationPassed +
 * FanOutAuthorized (the plans get created). Fail → DesignVerificationFailed
 * with the findings (the requirement card shows them + the decision
 * buttons). Unparseable output → ONE corrective respawn, then a
 * verification error (never a silent drop, never an authorized fan-out).
 */
async function handleDesignVerifierFinished(
    bus: EventBus,
    deps: RegisterPlanLifecycleAgentHandlersDeps,
    ctx: LifecycleAgentContext,
    content: string,
    opts: {
        readonly respawn: (
            requirementId: string,
            revision: number,
            extraFeedback?: string,
        ) => void;
        readonly retriedOnce: Set<string>;
    },
): Promise<void> {
    const requirementId = ctx.requirementId ?? '';
    const revision = ctx.revision ?? 1;
    const verdict = parseDesignVerifierVerdict(content);
    if (verdict === null) {
        const retryKey = `${requirementId}:r${revision}`;
        if (!opts.retriedOnce.has(retryKey)) {
            opts.retriedOnce.add(retryKey);
            deps.logger.warn('design-verifier: unparseable verdict — one corrective retry', {
                requirementId,
            });
            opts.respawn(
                requirementId,
                revision,
                'Your previous reply contained no parseable verdict JSON. Reply with '
                + 'ONLY the JSON object: {"verdict":"pass"|"fail","summary":"...",'
                + '"findings":[{"systemId":"<id or null>","severity":"blocker"|"warning",'
                + '"finding":"..."}]}',
            );
            return;
        }
        await bus.publish({
            type: RequirementEvents.DESIGN_VERIFICATION_FAILED,
            v: 1,
            occurredAt: deps.clock(),
            idempotencyKey: `dv-fail:${requirementId}:r${revision}:${deps.clock()}`,
            payload: {
                requirementId,
                revision,
                findings: [],
                error: 'verifier reply contained no parseable verdict JSON (after one retry)',
            },
        });
        return;
    }
    if (verdict.verdict === 'pass') {
        await bus.publish({
            type: RequirementEvents.DESIGN_VERIFICATION_PASSED,
            v: 1,
            occurredAt: deps.clock(),
            idempotencyKey: `dv-pass:${requirementId}:r${revision}`,
            payload: {
                requirementId,
                revision,
                ...(verdict.summary !== undefined ? { summary: verdict.summary } : {}),
            },
        });
        await bus.publish({
            type: RequirementEvents.FAN_OUT_AUTHORIZED,
            v: 1,
            occurredAt: deps.clock(),
            idempotencyKey: `dv-authorize:${requirementId}:r${revision}`,
            payload: { requirementId, revision, source: 'verification' },
        });
        return;
    }
    await bus.publish({
        type: RequirementEvents.DESIGN_VERIFICATION_FAILED,
        v: 1,
        occurredAt: deps.clock(),
        idempotencyKey: `dv-fail:${requirementId}:r${revision}:${deps.clock()}`,
        payload: {
            requirementId,
            revision,
            findings: verdict.findings,
            ...(verdict.summary !== undefined ? { summary: verdict.summary } : {}),
        },
    });
}

/**
 * Defensive parse of the verifier's verdict JSON. Tolerates surrounding
 * narration/fences (balanced-JSON extraction), normalises findings, and
 * returns null when no usable verdict is present. Exported for tests.
 */
export function parseDesignVerifierVerdict(content: string): {
    readonly verdict: 'pass' | 'fail';
    readonly summary?: string;
    readonly findings: readonly DesignVerificationFinding[];
} | null {
    const slice = extractJsonObject(content);
    if (slice === null) return null;
    let parsed: unknown;
    try {
        parsed = JSON.parse(slice);
    } catch {
        return null;
    }
    if (!parsed || typeof parsed !== 'object') return null;
    const v = parsed as { verdict?: unknown; summary?: unknown; findings?: unknown };
    const verdict = v.verdict === 'pass' || v.verdict === 'fail' ? v.verdict : null;
    if (verdict === null) return null;
    const findings: DesignVerificationFinding[] = [];
    if (Array.isArray(v.findings)) {
        for (const raw of v.findings) {
            if (!raw || typeof raw !== 'object') continue;
            const f = raw as { systemId?: unknown; severity?: unknown; finding?: unknown };
            const text = typeof f.finding === 'string' ? f.finding.trim() : '';
            if (text.length === 0) continue;
            findings.push({
                systemId:
                    typeof f.systemId === 'string' && f.systemId.length > 0
                        ? f.systemId
                        : null,
                severity: f.severity === 'blocker' ? 'blocker' : 'warning',
                finding: text.slice(0, 600),
            });
        }
    }
    // A fail verdict with no findings is unusable feedback — coerce a
    // placeholder so the operator sees SOMETHING actionable.
    if (verdict === 'fail' && findings.length === 0) {
        const summary = typeof v.summary === 'string' ? v.summary.trim() : '';
        findings.push({
            systemId: null,
            severity: 'blocker',
            finding: summary.length > 0
                ? summary.slice(0, 600)
                : 'verifier returned fail without findings — re-run verification',
        });
    }
    return {
        verdict,
        findings,
        ...(typeof v.summary === 'string' && v.summary.trim().length > 0
            ? { summary: v.summary.trim().slice(0, 400) }
            : {}),
    };
}

/**
 * Requirements already auto-retried once after an invalid architect reply.
 * Prompt guards ("single-turn run — never end while sub-agents are out")
 * reduce but do not eliminate the ended-mid-exploration failure mode, so
 * the first invalid output triggers ONE automatic re-run with corrective
 * feedback; a second failure stays parked for the operator (the modal's
 * Re-run button). In-memory: a process restart grants one fresh retry,
 * which is acceptable.
 */
const ARCHITECT_AUTO_RETRIED = new Set<string>();

async function emitArchitectureProposed(
    bus: EventBus,
    deps: RegisterPlanLifecycleAgentHandlersDeps,
    actor: string,
    ctx: LifecycleAgentContext,
    content: string,
): Promise<void> {
    const requirementId = ctx.requirementId;
    if (typeof requirementId !== 'string' || requirementId.length === 0) return;
    const result = parseArchitectureProposal(content, {
        requirementId,
        actor,
        ...(ctx.revision !== undefined ? { revision: ctx.revision } : {}),
    });
    if (!result.ok) {
        // Invalid output — most commonly the agent ended its turn while its
        // exploration sub-agents were still out, so no design/JSON was ever
        // written. Auto-retry ONCE with corrective feedback (same path as
        // the operator's Regenerate: a RequirementSubmitted with a bumped
        // revision re-spawns the architect; title/description come back
        // from the projection). A second failure logs and leaves the
        // requirement in 'architecting' for the operator's Re-run.
        if (!ARCHITECT_AUTO_RETRIED.has(requirementId)) {
            ARCHITECT_AUTO_RETRIED.add(requirementId);
            const nextRevision = (ctx.revision ?? 1) + 1;
            deps.logger.warn('orchestrator: architect output invalid — auto-retrying once', {
                requirementId,
                nextRevision,
                error: result.error,
            });
            await bus.publish({
                type: RequirementEvents.REQUIREMENT_SUBMITTED,
                v: 1,
                occurredAt: deps.clock(),
                idempotencyKey: `${RequirementCommands.SUBMIT_REQUIREMENT}:${requirementId}:r${nextRevision}`,
                payload: {
                    requirementId,
                    title: '',
                    description: '',
                    actor: 'architect-auto-retry',
                    revision: nextRevision,
                    feedback:
                        'AUTOMATIC RETRY — your previous reply was DISCARDED because it '
                        + 'ended mid-exploration without the required output. This run is '
                        + 'single-turn: do not end your reply while sub-agents are still '
                        + 'running, and make sure it ends with the full design Markdown '
                        + 'followed by the final ```json proposal block.',
                } satisfies RequirementSubmittedPayload,
            });
            return;
        }
        deps.logger.warn('orchestrator: architect output invalid; no ArchitectureProposed emitted', {
            requirementId,
            error: result.error,
            outputHead: content.slice(0, 800),
        });
        return;
    }
    // Carry the design-doc Markdown (the narrative + Mermaid diagrams the
    // architect emitted before the JSON block) so the board can render it and
    // a follow-on step can commit it to the architecture repo. The Mermaid
    // blocks are sanitized mechanically (bare `;` → `#59;`) — a recurring
    // LLM syntax slip that otherwise kills the whole diagram at render.
    const payload: ArchitectureProposedPayload = {
        ...result.value,
        designDoc: sanitizeMermaidInMarkdown(extractDesignDoc(content)),
    };
    const event: Event = {
        type: RequirementEvents.ARCHITECTURE_PROPOSED,
        v: 1,
        occurredAt: deps.clock(),
        // Distinct from any command-emitted variant; keyed per (requirement,
        // revision) so a regenerate lands as a new event.
        idempotencyKey:
            `agent:ArchitectureProposed:${payload.requirementId}:r${payload.revision}`,
        payload,
    };
    await bus.publish(event);
}

async function emitPlanGenerated(
    bus: EventBus,
    clock: () => number,
    actor: string,
    ctx: LifecycleAgentContext,
    content: string,
): Promise<void> {
    const payload: PlanGeneratedAgentEventPayload = {
        planId: ctx.planId,
        projectId: ctx.projectId,
        actor,
        content,
        ...(ctx.revision !== undefined ? { revision: ctx.revision } : {}),
        ...(ctx.briefId !== undefined ? { briefId: ctx.briefId } : {}),
        ...(ctx.feedback !== undefined ? { feedback: ctx.feedback } : {}),
        ...(ctx.revision !== undefined && ctx.revision > 1
            ? { previousRevision: ctx.revision - 1 }
            : {}),
    };
    const event: Event = {
        type: PlanLifecycleEvents.PLAN_GENERATED,
        v: 1,
        occurredAt: clock(),
        // Keyed off (planId, revision, source=agent) so the agent-driven
        // PlanGenerated does not collide with the synchronous one the
        // GeneratePlan command handler emits (which keys on
        // `${GENERATE_PLAN}:${planId}:r${revision}`).
        idempotencyKey:
            `agent:${PlanLifecycleEvents.PLAN_GENERATED}:${ctx.planId}:r${ctx.revision ?? 1}`,
        payload,
    };
    await bus.publish(event);
}

async function emitPlanDecomposed(
    bus: EventBus,
    deps: RegisterPlanLifecycleAgentHandlersDeps,
    actor: string,
    ctx: LifecycleAgentContext,
    content: string,
    pendingQuestions?: Map<string, LifecycleAgentContext>,
): Promise<void> {
    // A question is checked for FIRST, ahead of the JSON extraction. The
    // decomposer carries the same `NEEDS_HUMAN_INPUT` escape hatch as every
    // other persona and does use it; before this branch existed the block
    // fell through to `extractJsonObject`, which found no JSON and failed the
    // run with "decomposer output contains no JSON object". The operator got
    // a parser error where an agent had actually asked them a question.
    if (await emitDecomposeQuestionIfAsked(bus, deps, ctx, content, pendingQuestions)) {
        return;
    }
    let parsed: unknown;
    // The decomposer often wraps its JSON in surrounding narration —
    // a paragraph of intent, a fenced ```json block, a trailing
    // "Let me know if..." line. The persona file and Process
    // directive ask for clean output but in practice the agent
    // produces text + JSON + text. Strip it down to the first
    // balanced JSON object before parsing.
    const jsonSlice = extractJsonObject(content);
    if (jsonSlice === null) {
        await emitPlanDecomposeFailed(
            bus,
            deps,
            ctx,
            'decomposer output contains no JSON object',
        );
        return;
    }
    try {
        parsed = JSON.parse(jsonSlice);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const reason = `decomposer output is not valid JSON: ${message}`;
        await emitPlanDecomposeFailed(bus, deps, ctx, reason);
        return;
    }
    // Repair common LLM format slips (e.g. `agent` written as a bare
    // string) before validating, so one task's minor shape mistake
    // doesn't fail the whole decomposition.
    parsed = normalizeDecomposerOutput(parsed);
    const validation = validateDecomposerOutput(parsed, taskTypesFor(deps).decomposable());
    if (!validation.ok) {
        await emitPlanDecomposeFailed(bus, deps, ctx, validation.error ?? 'schema validation failed');
        return;
    }
    // Deletion-reference pass: deletions whose remaining references are
    // owned by other tasks get inferred "run after" edges; references no
    // task updates fail the decomposition here — BEFORE tasks exist —
    // with a message naming the exact files (it also lands in agent
    // memory, so the next decompose run sees it as feedback).
    const rawTasks =
        (parsed as { plan?: { tasks?: ReadonlyArray<Record<string, unknown>> } })
            .plan?.tasks ?? [];
    let deletionEdges: ReadonlyMap<string, readonly string[]> | undefined;
    const hasDeletions = rawTasks.some((t) => {
        const c = (t.context ?? {}) as { files_to_delete?: unknown };
        return Array.isArray(c.files_to_delete) && c.files_to_delete.length > 0;
    });
    const hasModifies = rawTasks.some((t) => {
        const c = (t.context ?? {}) as { files_to_modify?: unknown };
        return Array.isArray(c.files_to_modify) && c.files_to_modify.length > 0;
    });
    // Resolved once, shared by the (blocking) deletion pass and the
    // (advisory) impact check below.
    let scanRepoPath: string | undefined;
    if ((hasDeletions || hasModifies) && deps.resolveRepoSpec && (deps.stackHooks ?? []).length > 0) {
        try {
            const spec = await deps.resolveRepoSpec({
                kind: 'decomposer',
                role: 'decomposer',
                model: 'none',
                planId: ctx.planId,
                projectId: ctx.projectId,
            });
            scanRepoPath = spec?.repoPath;
        } catch (err) {
            deps.logger.warn('decompose scans: repo spec unresolved — scans skipped', {
                planId: ctx.planId,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }
    const hooks = deps.stackHooks ?? [];
    if (hasDeletions && scanRepoPath) {
        for (const hook of hooks) {
            if (!hook.scanDeletions) continue;
            try {
                const scan = hook.scanDeletions(scanRepoPath, rawTasks, deps.logger);
                if (scan.failure !== undefined) {
                    await emitPlanDecomposeFailed(bus, deps, ctx, scan.failure);
                    return;
                }
                deletionEdges = mergeEdges(deletionEdges, scan.edges);
            } catch (err) {
                // The scan is a safety net, not a gate on its own machinery:
                // an fs/repo error must not fail an otherwise-valid decompose.
                deps.logger.warn('decompose deletion scan skipped on error', {
                    planId: ctx.planId,
                    pack: hook.packId,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        }
    }
    // Advisory impact check: files referencing a type this plan MODIFIES
    // that no task touches. Never blocks — a modified type is legitimately
    // referenced in places needing no edit — but the list lands on the
    // plan's metadata (`impactWarnings`) so the operator sees candidate
    // misses BEFORE approving tasks, instead of finding them as broken
    // builds. Computed before the PlanDecomposed publish below and
    // attached afterwards via a PlanUpdated metadata merge.
    let impactWarnings: ReadonlyArray<Record<string, string>> | undefined;
    let impactTotal = 0;
    if (scanRepoPath) {
        for (const hook of hooks) {
            if (!hook.scanImpact) continue;
            try {
                const impact = hook.scanImpact(scanRepoPath, rawTasks, deps.logger);
                impactWarnings = [
                    ...(impactWarnings ?? []),
                    ...impact.warnings.map((w) => ({
                        changedFile: w.changedFile,
                        typeName: w.typeName,
                        referencingFile: w.referencingFile,
                    })),
                ];
                impactTotal += impact.total;
                if (impact.total > 0) {
                    deps.logger.info(impact.summary, { planId: ctx.planId, pack: hook.packId });
                }
            } catch (err) {
                deps.logger.warn('decompose impact scan skipped on error', {
                    planId: ctx.planId,
                    pack: hook.packId,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        }
    }
    // The agent's output is `{ plan: { id, title, description, tasks: [...] } }`
    // — the wrapper shape the schema validator enforces. The event log
    // contract (and the downstream `TaskProjectionStore`) expects a
    // flat `PlanDecomposedTask[]` on `tasks`, with each task's
    // `description` lifted out of the nested `context.description`
    // field. Map here so the event store sees the canonical shape
    // every consumer reads from.
    // The plan-level verify gate is NO LONGER auto-appended (operator
    // decision: each task's tester already builds+tests its own work, so
    // the extra all-deps build task added little — verification effort
    // moved to the requirement fan-out gate instead). The `verify-plan`
    // flow/type stays available for MANUAL use via the plan modal's
    // "+ Add task"; appendPlanVerifyTask remains exported for that
    // helper's tests and any future opt-in wiring.
    const flatTasks = extractDecomposerTasks(
        parsed,
        deletionEdges,
        makeRepoPathResolver(deps.listWorkspaceRepos?.() ?? [], deps.logger),
    );
    // Rewrite the decomposer's raw `task-001` ids into
    // `<projectAbbr>-<planAbbr>-<nnn>` so every downstream surface
    // (worktree branch name, task_step_summaries.task_id, PR title,
    // operator-facing card label) carries a recognisable identifier
    // instead of the generic placeholder. The decomposer agent has
    // no view onto the operator's project/plan abbrevs — this rewrite
    // is the orchestrator's responsibility. Dependency references on
    // each task are rewritten through the same map so cross-task
    // references stay valid post-rename.
    const renamedTasks = deps.db
        ? renameDecomposerTaskIds(deps.db, ctx, flatTasks, deps.logger)
        : flatTasks;
    const payload: PlanDecomposedAgentEventPayload = {
        planId: ctx.planId,
        projectId: ctx.projectId,
        actor,
        tasks: renamedTasks,
        ...(ctx.revision !== undefined ? { revision: ctx.revision } : {}),
        ...(ctx.conventions !== undefined ? { conventions: ctx.conventions } : {}),
    };
    const event: Event = {
        type: PlanLifecycleEvents.PLAN_DECOMPOSED,
        v: 1,
        occurredAt: deps.clock(),
        // The synchronous DecomposePlan handler keys on
        // `${DECOMPOSE_PLAN}:${planId}`; the agent-driven emit uses an
        // `agent:` prefix so both events can coexist on the log.
        // Revision is appended so re-decomposing the same plan after
        // a regenerate emits a fresh event instead of getting
        // silently dropped by the events table UNIQUE constraint —
        // without it the downstream task projection never sees the
        // new decomposition.
        idempotencyKey: `agent:${PlanLifecycleEvents.PLAN_DECOMPOSED}:${ctx.planId}:r${ctx.revision ?? 1}`,
        payload,
    };
    await bus.publish(event);

    // Persist the impact-check result on the plan's metadata. Emitted even
    // when the list is EMPTY (but only when the scan actually ran) so a
    // re-decompose clears warnings from the previous task split. The
    // sidebar_plans projection REPLACES the whole metadata blob on
    // PlanUpdated, so merge with the stored blob here — otherwise
    // targetRepo/planType would be clobbered (targetRepo is load-bearing
    // for per-task worktrees).
    if (impactWarnings !== undefined && deps.db) {
        try {
            const row = deps.db
                .prepare('SELECT metadata FROM sidebar_plans WHERE plan_id = ?')
                .get(ctx.planId) as { metadata?: string | null } | undefined;
            let existing: Record<string, unknown> = {};
            if (row?.metadata) {
                try {
                    const parsed = JSON.parse(row.metadata) as unknown;
                    if (parsed && typeof parsed === 'object') {
                        existing = parsed as Record<string, unknown>;
                    }
                } catch { /* unparseable stored blob — start fresh */ }
            }
            await bus.publish({
                type: 'PlanUpdated',
                v: 1,
                occurredAt: deps.clock(),
                // Clock in the key: a retry decompose of the SAME revision
                // must still land its (different) warning list.
                idempotencyKey: `impact:${ctx.planId}:${deps.clock()}`,
                payload: {
                    planId: ctx.planId,
                    metadata: {
                        ...existing,
                        impactWarnings,
                        impactWarningsTotal: impactTotal,
                    },
                },
            });
        } catch (err) {
            deps.logger.warn('impact-check: failed to attach warnings to plan', {
                planId: ctx.planId,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }
}

/**
 * Lift the decomposer's nested task list into the flat
 * `PlanDecomposedTask` shape the rest of the pipeline reads. The agent
 * emits `{ plan: { tasks: [{ id, title, type, dependencies, agent,
 * context: { description }, ... }] } }`; this returns
 * `[{ id, title, type, dependencies, description, archetype? }, ...]`.
 *
 * Validation has already passed by the time we get here, so each
 * field is safe to dereference. Missing-optional defaults (empty
 * dependencies, empty description) are filled in as the doc-comment
 * on `PlanDecomposedTask` calls for.
 */
/**
 * Pull the first balanced top-level JSON object out of a string that
 * may contain prose around it. The decomposer agent commonly wraps
 * its output in:
 *
 *   - A narration paragraph followed by the raw object
 *   - A fenced ```json ... ``` block (or just ```{ ... })
 *   - Both — narration + fence + JSON + trailing comment
 *
 * Strategy: prefer a fenced block when present (the agent is being
 * explicit about which slice is the JSON); otherwise scan the whole
 * content for every brace-balanced span (ignoring braces inside string
 * literals) and pick the largest one that `JSON.parse` accepts. Picking
 * the largest parseable span — rather than the first balanced one —
 * skips brace-laden prose (inlined pseudo-code, `foo({ ... })` snippets)
 * that precedes the real object. Returns the matched slice (without
 * fences) or `null` when no balanced object is found.
 *
 * The returned slice is passed straight to `JSON.parse`, so any
 * remaining issues (trailing commas, comments) still surface as
 * parse errors — the helper's job is to peel off surrounding prose,
 * not to repair malformed JSON.
 */
export function extractJsonObject(content: string): string | null {
    if (typeof content !== 'string' || content.length === 0) return null;

    // Fenced block first: ```json\n...\n``` or ```\n...\n```. The
    // closing fence on its own line is the most common shape.
    const fence
        = /```(?:json)?\s*\n([\s\S]*?)\n```/.exec(content);
    if (fence && fence[1]) {
        const picked = pickJsonSpan(fence[1].trim());
        if (picked !== null) return picked;
    }

    return pickJsonSpan(content);
}

/**
 * Choose the best brace-balanced span from `text`. Prefer the largest
 * span that `JSON.parse` accepts, so brace-laden prose (e.g. inlined
 * `runTurnStreaming({ ... })` pseudo-code) that appears before the real
 * plan object does not win just by coming first. When nothing parses,
 * fall back to the largest span so a malformed real object surfaces its
 * own `JSON.parse` error rather than being silently dropped. Returns
 * `null` only when no balanced span exists at all.
 */
function pickJsonSpan(text: string): string | null {
    const spans = scanBalancedObjects(text);
    if (spans.length === 0) return null;
    const parseable = spans.filter((span) => {
        try {
            JSON.parse(span);
            return true;
        } catch {
            return false;
        }
    });
    const pool = parseable.length > 0 ? parseable : spans;
    return pool.reduce((longest, span) =>
        span.length > longest.length ? span : longest);
}

/**
 * Collect every top-level brace-balanced span in `text`. Walks forward
 * from each `{`: on a balanced object it records the span and resumes
 * after it (so interior/nested braces are not re-scanned as separate
 * top-level spans); on an unbalanced `{` it advances one character and
 * tries again. Returns the spans in source order.
 */
function scanBalancedObjects(text: string): string[] {
    const spans: string[] = [];
    let from = text.indexOf('{');
    while (from !== -1) {
        const span = balancedFrom(text, from);
        if (span !== null) {
            spans.push(span);
            from = text.indexOf('{', from + span.length);
        } else {
            from = text.indexOf('{', from + 1);
        }
    }
    return spans;
}

/**
 * Return the brace-balanced object starting at `start` (which must be a
 * `{`) — the substring from `start` to its matching `}`, respecting
 * string-literal escapes. Returns `null` when the braces never balance.
 */
function balancedFrom(text: string, start: number): string | null {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i += 1) {
        const ch = text[i];
        if (inString) {
            if (escaped) {
                escaped = false;
            } else if (ch === '\\') {
                escaped = true;
            } else if (ch === '"') {
                inString = false;
            }
            continue;
        }
        if (ch === '"') {
            inString = true;
            continue;
        }
        if (ch === '{') depth += 1;
        else if (ch === '}') {
            depth -= 1;
            if (depth === 0) {
                return text.slice(start, i + 1);
            }
        }
    }
    return null;
}

/**
 * The Q&A thread recorded on a task's TaskCreated payload (follow-up
 * tasks carry the prior conversation forward). Empty for tasks created
 * without a thread.
 */
function readInvestigationThreadSeed(
    db: import('../../core/state/migrations').Db,
    taskId: string,
): InvestigationThreadEntry[] {
    try {
        const row = db
            .prepare(
                `SELECT payload FROM events
                  WHERE type = 'TaskCreated'
                    AND json_extract(payload, '$.taskId') = ?
                  ORDER BY seq DESC LIMIT 1`,
            )
            .get(taskId) as { payload: string } | undefined;
        if (!row) return [];
        const p = JSON.parse(row.payload) as {
            investigation_thread?: unknown;
        };
        if (!Array.isArray(p.investigation_thread)) return [];
        return p.investigation_thread.filter(
            (e): e is InvestigationThreadEntry =>
                !!e
                && typeof (e as InvestigationThreadEntry).role === 'string'
                && typeof (e as InvestigationThreadEntry).content === 'string',
        );
    } catch {
        return [];
    }
}

/**
 * Read-side port for `GET /tasks/:id/investigation-thread` — the
 * conversation the follow-up modal renders: the thread recorded at the
 * task's creation plus the task's own answer (report) once it exists.
 * Returns null for unknown tasks. Exported for the worker-api host,
 * which previously had NO reader wired (the route answered 501).
 */
export function createDbInvestigationThreadReader(
    db: import('../../core/state/migrations').Db,
    reportRoles: readonly string[] = CORE_REPORT_ROLES,
): {
    readThread(taskId: string): InvestigationThreadEntry[] | null;
} {
    const reports = createDbInvestigationReportStore(db, reportRoles);
    return {
        readThread(taskId): InvestigationThreadEntry[] | null {
            const exists = db
                .prepare('SELECT 1 FROM tasks WHERE id = ?')
                .get(taskId);
            if (!exists) return null;
            const thread = readInvestigationThreadSeed(db, taskId);
            const answer = reports.get(taskId, '');
            if (
                answer
                && !thread.some(
                    (e) => e.role === 'assistant' && e.content === answer.markdown,
                )
            ) {
                thread.push({
                    role: 'assistant',
                    content: answer.markdown,
                    timestamp: Date.now(),
                });
            }
            return thread;
        },
    };
}

/**
 * Durable report lookup for ImplementFromInvestigation. Reads the same
 * sources the View-report modal renders, newest first:
 *   1. the latest `InvestigationCompleted` event for the task (payload
 *      `answer` carries the report markdown);
 *   2. the investigator's `task_step_summaries` row — the fallback used
 *      when the run predates the InvestigationCompleted bridge.
 * `record` is a no-op: the event log IS the record.
 */
/**
 * Report roles core ships. A stack pack's report roles are passed in by
 * the host (see {@link HandlerDeps.reportRoles}) — `azure-reviewer` and
 * `azure-diagnostician` were literals in the query below until packs owned
 * them.
 *
 * `reviewer` is deliberately absent: every code-writing flow has a step
 * named `review` run by that role, and treating its "APPROVED, looks good"
 * notes as an investigation report meant ImplementFromInvestigation
 * decomposed a reviewer's approval.
 */
export const CORE_REPORT_ROLES: readonly string[] = ['investigator', 'codebase-reviewer'];

export function createDbInvestigationReportStore(
    db: import('../../core/state/migrations').Db | undefined,
    reportRoles: readonly string[] = CORE_REPORT_ROLES,
): InvestigationReportStore {
    const roles = reportRoles.filter((r) => typeof r === 'string' && r.length > 0);
    return {
        record: (): void => undefined,
        get(taskId, _reportId) {
            if (!db) return undefined;
            try {
                const rows = db
                    .prepare(
                        `SELECT payload FROM events
                          WHERE type = 'InvestigationCompleted'
                          ORDER BY seq DESC`,
                    )
                    .all() as ReadonlyArray<{ payload: string }>;
                for (const r of rows) {
                    try {
                        const p = JSON.parse(r.payload) as {
                            taskId?: unknown;
                            answer?: unknown;
                        };
                        if (
                            p.taskId === taskId
                            && typeof p.answer === 'string'
                            && p.answer.length > 0
                        ) {
                            return { markdown: p.answer };
                        }
                    } catch {
                        /* skip poisoned rows */
                    }
                }
                // Role-scoped ONLY. The previous version also matched any
                // step NAMED 'review', and every code-writing flow
                // (implement / refactor / scaffold / document / swagger /
                // architect) has a `review` step run by the `reviewer`
                // role — so ImplementFromInvestigation would happily
                // decompose a reviewer's "APPROVED, looks good" notes as
                // if they were an investigation report. `code-review`
                // tasks keep working: their step summary is still read
                // through the InvestigationCompleted branch above, and
                // the reviewer role is intentionally NOT a report role.
                //
                // The roles are a PARAMETER: core's own plus whatever the
                // enabled packs declare. An empty list means there is no
                // role to read, so skip the query — `role IN ()` is a
                // syntax error, not a no-match.
                if (roles.length === 0) return undefined;
                const step = db
                    .prepare(
                        `SELECT summary FROM task_step_summaries
                          WHERE task_id = ?
                            AND role IN (${roles.map(() => '?').join(', ')})
                            AND summary IS NOT NULL AND summary <> ''
                          ORDER BY finished_at DESC LIMIT 1`,
                    )
                    .get(taskId, ...roles) as { summary: string | null } | undefined;
                if (step?.summary) return { markdown: step.summary };
            } catch {
                /* schema drift / closed db — treat as no report */
            }
            return undefined;
        },
    };
}

/**
 * Lift the decomposer's task list into the canonical
 * {@link PlanDecomposedTask} shape.
 *
 * The return type used to name only id/title/type/description/
 * dependencies/archetype while the body already spread the ticket
 * fields in — so the contract said less than the code did, and it was
 * not obvious that `test.commands` was the one field NOT being lifted.
 * Exported so a test can pin the lift against raw decomposer output.
 */
export function extractDecomposerTasks(
    parsed: unknown,
    extraDeps?: ReadonlyMap<string, readonly string[]>,
    resolveRepoId?: (repoPath: string) => string | undefined,
): PlanDecomposedTask[] {
    const doc = parsed as { plan?: { tasks?: ReadonlyArray<Record<string, unknown>> } };
    const list = doc.plan?.tasks ?? [];
    // Synthesize implicit dependencies from file-write overlaps: two
    // tasks that create/modify the same file would conflict if they ran
    // in parallel and each opened a PR, so the later one is made to
    // depend on the earlier. Merged into the decomposer's declared
    // logical dependencies; the rename + edge-insertion + gate machinery
    // downstream treats them identically. `extraDeps` (the deletion-
    // reference scan) rides the same merge.
    const fileOverlap = computeFileOverlapDependencies(list);
    return list.map((task) => {
        const ctx = (task.context ?? {}) as { description?: unknown };
        const declared = Array.isArray(task.dependencies)
            ? (task.dependencies as ReadonlyArray<unknown>).filter(
                (d): d is string => typeof d === 'string',
            )
            : [];
        const id = String(task.id);
        // Union declared + file-overlap deps, preserving order and
        // dropping duplicates + self-references.
        const merged: string[] = [];
        const seen = new Set<string>();
        for (const d of [
            ...declared,
            ...(fileOverlap.get(id) ?? []),
            ...(extraDeps?.get(id) ?? []),
        ]) {
            if (d === id || seen.has(d)) continue;
            seen.add(d);
            merged.push(d);
        }
        const archetype
            = typeof task.archetype === 'string' ? task.archetype : undefined;
        // Structured ticket fields, lifted verbatim from the context block
        // the decomposer already produces. Previously these were dropped
        // here — the board showed one text blob and the developer/tester
        // never received the acceptance criteria their personas tell them
        // to follow. The description stays the untouched brief text.
        const fullCtx = (task.context ?? {}) as {
            description?: unknown;
            goal?: unknown;
            acceptance_criteria?: unknown;
            files_to_create?: unknown;
            files_to_modify?: unknown;
            files_to_delete?: unknown;
            repo_path?: unknown;
        };
        const strList = (v: unknown): string[] =>
            Array.isArray(v)
                ? v.filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
                : [];
        const goal = typeof fullCtx.goal === 'string' ? fullCtx.goal.trim() : '';
        const acceptanceCriteria = strList(fullCtx.acceptance_criteria);
        const filesToCreate = strList(fullCtx.files_to_create);
        const filesToModify = strList(fullCtx.files_to_modify);
        const filesToDelete = strList(fullCtx.files_to_delete);
        // `test` is a SIBLING of `context`, and is `null` for task types
        // that carry no tests (scaffold / refactor). Tolerant of both the
        // filled object and the null so a missing block is simply absent
        // rather than a validation failure.
        const testBlock = (task as { test?: unknown }).test;
        const testCommands = testBlock && typeof testBlock === 'object'
            ? strList((testBlock as { commands?: unknown }).commands)
            : [];
        // Per-task repo: the decomposer declares where THIS task's files
        // live (context.repo_path), which may differ from the plan's
        // targetRepo when the planner discovered the change belongs
        // elsewhere. Resolved to a registry repoId here; worktree
        // creation prefers it over the plan-level target.
        const repoId =
            typeof fullCtx.repo_path === 'string' && fullCtx.repo_path.trim().length > 0
                ? resolveRepoId?.(fullCtx.repo_path.trim())
                : undefined;
        return {
            id,
            title: String(task.title),
            type: String(task.type),
            description: typeof ctx.description === 'string' ? ctx.description : '',
            dependencies: merged,
            ...(archetype !== undefined ? { archetype } : {}),
            ...(repoId !== undefined ? { repoId } : {}),
            ...(goal.length > 0 ? { goal } : {}),
            ...(acceptanceCriteria.length > 0 ? { acceptanceCriteria } : {}),
            ...(filesToCreate.length > 0 ? { filesToCreate } : {}),
            ...(filesToModify.length > 0 ? { filesToModify } : {}),
            ...(filesToDelete.length > 0 ? { filesToDelete } : {}),
            ...(testCommands.length > 0 ? { testCommands } : {}),
        };
    });
}

/**
 * Option C of the missed-file fixes: append ONE `verify-plan` task that
 * depends on every other task in the decomposition. It starts only after
 * all upstreams are terminal, in a worktree cut from the default branch
 * that therefore contains the plan's entire merged work — so a consumer
 * the decomposer missed surfaces as ONE failing verify task at plan
 * level (with the impact-check warnings and "+ Add task" one modal
 * away), not as a broken build found after deploy.
 *
 * Skipped when the plan writes no code (no task of a
 * `codeWritingTypes` type — `TaskTypeCatalog.writesCode()`, i.e. the flows
 * declaring `task_type.writes_code`) or when the decomposer already
 * emitted its own `verify-plan` task. The raw id has no trailing digits
 * ON PURPOSE: `renameDecomposerTaskIds` then assigns it the next
 * positional sequence number, so the gate renders as the plan's last
 * task (`…-006` after `…-001..005`).
 *
 * Exported for unit testing.
 */
export function appendPlanVerifyTask<
    T extends {
        readonly id: string;
        readonly type: string;
        readonly title: string;
        readonly dependencies: readonly string[];
    },
>(tasks: ReadonlyArray<T>, codeWritingTypes: ReadonlySet<string>): Array<T | {
    readonly id: string;
    readonly title: string;
    readonly type: string;
    readonly description: string;
    readonly dependencies: readonly string[];
    readonly goal: string;
    readonly acceptanceCriteria: readonly string[];
}> {
    if (tasks.length === 0) return [...tasks];
    if (!tasks.some((t) => codeWritingTypes.has(t.type))) return [...tasks];
    if (tasks.some((t) => t.type === 'verify-plan')) return [...tasks];
    // Union of the plan's declared file touches — tells the tester which
    // projects to build without it having to reverse-engineer the plan.
    const touched = new Set<string>();
    for (const t of tasks) {
        const withFiles = t as T & {
            readonly filesToCreate?: readonly string[];
            readonly filesToModify?: readonly string[];
            readonly filesToDelete?: readonly string[];
        };
        for (const f of withFiles.filesToCreate ?? []) touched.add(f);
        for (const f of withFiles.filesToModify ?? []) touched.add(f);
    }
    const touchedList = [...touched].sort();
    const shown = touchedList.slice(0, 30);
    const fileBlock = shown.length > 0
        ? 'Files the plan touches (build/test every project containing one):\n'
          + shown.map((f) => `- ${f}`).join('\n')
          + (touchedList.length > shown.length
              ? `\n- … and ${touchedList.length - shown.length} more`
              : '')
        : 'Use `git log --name-only -20` in the worktree to find the projects '
          + 'this plan changed.';
    const description
        = 'Plan-level verification gate (auto-appended by the orchestrator). '
        + 'Every other task in this plan has finished and merged; this worktree '
        + 'contains the combined result. Do NOT write or modify code or tests. '
        + 'Build every affected project and run its test suite; report '
        + 'pass/fail with the actual compiler/test output. A failure here '
        + 'usually means the plan missed a file that also needed changing — '
        + 'name the file(s) and the symbol(s) involved so the operator can add '
        + 'a follow-up task.\n\n'
        + fileBlock;
    return [
        ...tasks,
        {
            id: 'task-plan-verify',
            title: 'Verify plan — build and test all affected projects',
            type: 'verify-plan',
            description,
            dependencies: tasks.map((t) => t.id),
            goal: 'Prove the plan\'s combined merged work builds and passes tests.',
            acceptanceCriteria: [
                'Every project containing a touched file builds without errors.',
                'The test suites of the affected projects pass.',
                'Any failure names the exact files/symbols so a follow-up task can be added.',
            ],
        },
    ];
}

/**
 * Map a decomposer `context.repo_path` (an absolute folder path the
 * agent typed) onto a workspace-registry repoId. Exact ensured-path
 * match first; then folder-basename ↔ repoId/name with separator
 * tolerance (`workshop.orders` ≈ `workshop-orders`) — the same
 * normalisation the requirement fan-out uses. Unresolved paths warn and
 * return undefined, which falls back to the plan's targetRepo.
 * Exported for unit testing.
 */
export function makeRepoPathResolver(
    repos: ReadonlyArray<WorkspaceRepoEntry>,
    logger?: Logger,
): (repoPath: string) => string | undefined {
    const normPath = (p: string): string =>
        p.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    const normKey = (s: string): string =>
        s.toLowerCase().replace(/[._\s-]+/g, '-');
    const byPath = new Map(repos.map((r) => [normPath(r.path), r.repoId]));
    return (repoPath: string): string | undefined => {
        const np = normPath(repoPath);
        const exact = byPath.get(np);
        if (exact) return exact;
        const base = np.split('/').pop() ?? '';
        if (base.length > 0) {
            const key = normKey(base);
            for (const r of repos) {
                if (normKey(r.repoId) === key || normKey(r.name) === key) {
                    return r.repoId;
                }
            }
        }
        logger?.warn(
            'decompose: task repo_path matched no workspace repo — falling back to the plan targetRepo',
            { repoPath },
        );
        return undefined;
    };
}

/**
 * Normalise a file path for cross-task overlap comparison: trim,
 * forward-slash separators, strip a leading `./`, and lowercase (the
 * workspace is Windows, where paths are case-insensitive). Returns ''
 * for non-strings / blanks, which the caller ignores.
 */
/**
 * The single key every spelling of the repo's CLAUDE.md collapses onto.
 * `CLAUDE.md`, `./CLAUDE.md` and `/CLAUDE.md` are one file; without a
 * shared key, two tasks editing it would look like two different writes
 * and stay parallel.
 */
export const CLAUDE_MD_OVERLAP_KEY = 'claude.md';

function normalizeOverlapPath(p: unknown): string {
    if (typeof p !== 'string') return '';
    return p
        .trim()
        .replace(/\\/g, '/')
        .replace(/^\.\//, '')
        // Leading slashes stripped so `/CLAUDE.md` and `CLAUDE.md` are the
        // same key. A NESTED `docs/CLAUDE.md` is deliberately left alone —
        // that is a different file.
        .replace(/^\/+/, '')
        .toLowerCase();
}

/**
 * The set of files a decomposer task writes — `context.files_to_create`
 * ∪ `context.files_to_modify` ∪ `context.files_to_delete`. Reads only;
 * `files_to_read` is excluded (reading a shared file isn't a
 * merge-conflict source). Deletes count as writes: deleting a file
 * another task edits is the sharpest possible conflict.
 */
function taskWriteSet(task: Record<string, unknown>): Set<string> {
    const ctx = (task.context ?? {}) as {
        files_to_create?: unknown;
        files_to_modify?: unknown;
        files_to_delete?: unknown;
        updates_claude_md?: unknown;
    };
    const out = new Set<string>();
    for (const arr of [ctx.files_to_create, ctx.files_to_modify, ctx.files_to_delete]) {
        if (!Array.isArray(arr)) continue;
        for (const f of arr) {
            const norm = normalizeOverlapPath(f);
            if (norm.length > 0) out.add(norm);
        }
    }
    // The repo's CLAUDE.md is a write nobody declared. Developer rule 7
    // tells every agent to keep it current — a new module, a changed build
    // step, a new framework — so several tasks in one plan edit the same
    // handful of sections. The decomposer never listed it (it cannot know
    // which agent will decide to), the overlap scan saw no shared file,
    // the tasks stayed parallel, and the branches collided at merge.
    //
    // `updates_claude_md` lets the decomposer declare it without having to
    // guess where CLAUDE.md sits in that repo, and it collapses onto the
    // same key as a literal `CLAUDE.md` path — so a plan that spells the
    // file out chains correctly with one that only sets the flag.
    if (ctx.updates_claude_md === true) out.add(CLAUDE_MD_OVERLAP_KEY);
    return out;
}

/**
 * Compute file-write-overlap dependencies for a decomposer task list.
 * Task N depends on every EARLIER task M (M before N in decomposition
 * order) whose write-set shares at least one file with N's. Edges only
 * point backward in list order, so the result is always acyclic.
 *
 * Returns a Map of taskId → ids of earlier tasks it overlaps with.
 * Exported for unit testing.
 */
export function computeFileOverlapDependencies(
    tasks: ReadonlyArray<Record<string, unknown>>,
): Map<string, string[]> {
    const ids = tasks.map((t) => String(t.id));
    const writeSets = tasks.map(taskWriteSet);
    const result = new Map<string, string[]>();
    for (let n = 0; n < tasks.length; n += 1) {
        if (writeSets[n].size === 0) continue;
        const deps: string[] = [];
        for (let m = 0; m < n; m += 1) {
            if (writeSets[m].size === 0) continue;
            let shared = false;
            for (const f of writeSets[n]) {
                if (writeSets[m].has(f)) { shared = true; break; }
            }
            if (shared) deps.push(ids[m]);
        }
        if (deps.length > 0) result.set(ids[n], deps);
    }
    return result;
}

/**
 * Build an `<projectAbbr>-<planAbbr>-<nnn>` id prefix from the
 * project's `metadata.abbr` + a derived plan abbreviation. Falls back
 * to the raw planId tail when the metadata is missing. The plan
 * abbreviation is derived from the plan's name: first letter of each
 * non-trivial word, uppercased, capped at 4 chars. "Add roleid filter"
 * becomes "ARF"; a single-word plan name "auth" becomes "AUTH".
 */
export function derivePlanAbbr(planName: string | null): string {
    if (!planName) return 'PLN';
    const words = planName
        .split(/[\s_-]+/)
        // Task ids become git branch names, WINDOWS DIRECTORY names
        // (worktrees) and URL segments — strip everything that isn't a
        // letter/digit BEFORE taking initials. Field case: a plan named
        // with a quoted word produced task id `P-CF"A-001`; `"` is an
        // illegal Windows filename character, so the worktree could
        // never be created and Review-changes 404'd forever.
        .map((w) => w.replace(/[^A-Za-z0-9]/g, ''))
        .filter((w) => w.length > 0 && !/^(a|an|the|to|of|for|and)$/i.test(w));
    if (words.length === 0) return 'PLN';
    if (words.length === 1) {
        return words[0].slice(0, 4).toUpperCase();
    }
    return words.map((w) => w[0].toUpperCase()).join('').slice(0, 4);
}

/** Last-resort guard for id fragments from operator-controlled inputs. */
export function sanitizeIdFragment(fragment: string, fallback: string): string {
    const clean = fragment.replace(/[^A-Za-z0-9]/g, '');
    return clean.length > 0 ? clean : fallback;
}

interface ProjectAbbrRow { metadata: string | null }
interface PlanNameRow { name: string | null }

export function renameDecomposerTaskIds(
    db: import('../../core/state/migrations').Db,
    ctx: LifecycleAgentContext,
    tasks: ReadonlyArray<{
        readonly id: string;
        readonly title: string;
        readonly type: string;
        readonly description: string;
        readonly dependencies: readonly string[];
        readonly archetype?: string;
    }>,
    logger: Logger,
): Array<{
    readonly id: string;
    readonly title: string;
    readonly type: string;
    readonly description: string;
    readonly dependencies: readonly string[];
    readonly archetype?: string;
}> {
    // Pull project abbr from projects.metadata.abbr, plan name from
    // sidebar_plans.name. Either query is best-effort: a row missing
    // (legacy task, hand-rolled DB) falls back to a literal short
    // string so the rewrite always produces a usable id.
    let projectAbbr = 'PRJ';
    try {
        const row = db
            .prepare('SELECT metadata FROM projects WHERE id = ?')
            .get(ctx.projectId) as ProjectAbbrRow | undefined;
        if (row?.metadata) {
            const parsed = JSON.parse(row.metadata) as { abbr?: unknown };
            if (typeof parsed.abbr === 'string' && parsed.abbr.length > 0) {
                projectAbbr = parsed.abbr.toUpperCase();
            }
        }
    } catch (err) {
        logger.warn('renameDecomposerTaskIds: failed to read project abbr', {
            projectId: ctx.projectId,
            error: err instanceof Error ? err.message : String(err),
        });
    }

    let planName: string | null = null;
    try {
        const row = db
            .prepare('SELECT name FROM sidebar_plans WHERE plan_id = ? LIMIT 1')
            .get(ctx.planId) as PlanNameRow | undefined;
        planName = row?.name ?? null;
    } catch (err) {
        logger.warn('renameDecomposerTaskIds: failed to read plan name', {
            planId: ctx.planId,
            error: err instanceof Error ? err.message : String(err),
        });
    }
    const planAbbr = derivePlanAbbr(planName);

    // Build a rename map from the raw decomposer id (e.g. `task-001`)
    // to the prefixed id. Sequence number is preserved when the raw
    // id ends in digits — otherwise we fall back to the 1-based
    // position in the tasks list.
    const renameMap = new Map<string, string>();
    // Both abbr fragments are operator-controlled (project metadata.abbr,
    // plan name) — sanitize so the composed id is always a valid git
    // ref / Windows path / URL segment.
    const safeProject = sanitizeIdFragment(projectAbbr, 'PRJ');
    const safePlan = sanitizeIdFragment(planAbbr, 'PLN');

    // Two plans can derive the SAME abbreviation — the abbr is initials
    // of the plan name with stopwords dropped, so "deploy products api to
    // staging" and "deploy products api to stg" both give DPAS. Their
    // tasks then mint identical ids, and `id` is the primary key.
    //
    // What that cost (field case, plan-1786543915236-elif): the second
    // plan's tasks collided with a 3-week-old archived plan's. The
    // TaskCreated projection saw the id already present, took its
    // re-decompose branch, and reset the OLD plan's rows — leaving
    // `plan_id` pointing at the old plan. The new plan ended up with ZERO
    // tasks: it rendered as a Draft with just the operator's brief, its
    // worktree cleanup found nothing, and the work that actually ran was
    // recorded against a plan archived weeks earlier.
    //
    // So: shift this batch past anything already using the prefix, unless
    // the existing rows belong to THIS plan — that case is a genuine
    // re-decompose and must keep its ids so the projection can reset them.
    let seqOffset = 0;
    try {
        const rows = db
            .prepare('SELECT id, plan_id FROM tasks WHERE id LIKE ?')
            .all(`${safeProject}-${safePlan}-%`) as Array<{
                id: string;
                plan_id: string | null;
            }>;
        const otherPlanIds = rows.filter((r) => r.plan_id !== ctx.planId);
        if (otherPlanIds.length > 0) {
            let highest = 0;
            for (const row of rows) {
                const m = /(\d+)$/.exec(row.id);
                if (m) highest = Math.max(highest, Number(m[1]));
            }
            seqOffset = highest;
            logger.warn(
                'renameDecomposerTaskIds: task-id prefix already used by another plan — '
                + 'continuing the sequence so this plan keeps its own tasks',
                {
                    planId: ctx.planId,
                    prefix: `${safeProject}-${safePlan}`,
                    takenBy: [...new Set(otherPlanIds.map((r) => r.plan_id))],
                    seqOffset,
                },
            );
        }
    } catch (err) {
        // A failed probe must not stop the decomposition; the projection
        // guard is the backstop for a collision that slips through.
        logger.warn('renameDecomposerTaskIds: could not check for id collisions', {
            planId: ctx.planId,
            error: err instanceof Error ? err.message : String(err),
        });
    }

    tasks.forEach((task, idx) => {
        const match = task.id.match(/(\d+)$/);
        const rawSeq = match ? Number(match[1]) : idx + 1;
        const seq = String(rawSeq + seqOffset).padStart(3, '0');
        const newId = `${safeProject}-${safePlan}-${seq}`;
        renameMap.set(task.id, newId);
    });

    return tasks.map((task) => {
        const newId = renameMap.get(task.id) ?? task.id;
        // Rewrite dependency references through the same map so
        // cross-task pointers (e.g. `task-002` depends on `task-001`)
        // stay valid in their new ids.
        const newDeps = task.dependencies.map((d) => renameMap.get(d) ?? d);
        return { ...task, id: newId, dependencies: newDeps };
    });
}

/**
 * Merge a patch into the plan's `sidebar_plans.metadata` blob via a
 * `PlanUpdated` event (same pattern as the impact-check warnings). The
 * projection REPLACES the whole blob on PlanUpdated, so the stored blob
 * is read and merged here. `opts.onlyIfSet` skips the publish when the
 * named key is absent/null in the stored blob — used to clear
 * `plannerError` without emitting a no-op event on every success.
 */
async function patchPlanMetadata(
    bus: EventBus,
    deps: RegisterPlanLifecycleAgentHandlersDeps,
    planId: string,
    patch: Record<string, unknown>,
    opts?: { readonly onlyIfSet?: string },
): Promise<void> {
    if (!deps.db) return;
    try {
        const row = deps.db
            .prepare('SELECT metadata FROM sidebar_plans WHERE plan_id = ?')
            .get(planId) as { metadata?: string | null } | undefined;
        let existing: Record<string, unknown> = {};
        if (row?.metadata) {
            try {
                const parsed = JSON.parse(row.metadata) as unknown;
                if (parsed && typeof parsed === 'object') {
                    existing = parsed as Record<string, unknown>;
                }
            } catch { /* unparseable stored blob — start fresh */ }
        }
        if (opts?.onlyIfSet !== undefined) {
            const current = existing[opts.onlyIfSet];
            if (current === undefined || current === null) return;
        }
        await bus.publish({
            type: 'PlanUpdated',
            v: 1,
            occurredAt: deps.clock(),
            idempotencyKey: `plan-meta:${planId}:${deps.clock()}`,
            payload: { planId, metadata: { ...existing, ...patch } },
        });
    } catch (err) {
        deps.logger.warn('patchPlanMetadata failed', {
            planId,
            error: err instanceof Error ? err.message : String(err),
        });
    }
}

async function emitPlanGenerateFailed(
    bus: EventBus,
    clock: () => number,
    ctx: LifecycleAgentContext,
    error: string,
): Promise<void> {
    const payload: PlanGenerateFailedPayload = {
        planId: ctx.planId,
        projectId: ctx.projectId,
        error,
        ...(ctx.revision !== undefined ? { revision: ctx.revision } : {}),
    };
    const event: Event = {
        type: PlanLifecycleAgentEvents.PLAN_GENERATE_FAILED,
        v: 1,
        occurredAt: clock(),
        idempotencyKey:
            `${PlanLifecycleAgentEvents.PLAN_GENERATE_FAILED}:${ctx.planId}:r${ctx.revision ?? 1}`,
        payload,
    };
    await bus.publish(event);
}

/**
 * File operator instructions as `interrupt-restart` memory when the task
 * has already run at least one agent.
 *
 * "Has already run" is `agent_runs` having a row for the task — the
 * server-side equivalent of the board's `hasStepRuns`, which is what
 * `instructionsApplyToRerun` uses to decide whether the copy says "for the
 * next run". Best-effort throughout: a memory write must never fail the
 * command that carries the operator's instructions.
 */
async function recordInstructionsAsMemory(
    deps: HandlerDeps,
    taskId: string,
    instructions: string,
): Promise<void> {
    if (!deps.agentMemory || !deps.db) return;
    if (instructions.trim().length === 0) return;
    try {
        const ran = deps.db
            .prepare('SELECT 1 AS ran FROM agent_runs WHERE task_id = ? LIMIT 1')
            .get(taskId) as { ran?: number } | undefined;
        if (!ran) return;
        const row = deps.db
            .prepare(
                `SELECT t.title AS title, p.project_id AS project_id
                   FROM tasks t JOIN plans p ON p.id = t.plan_id
                  WHERE t.id = ?`,
            )
            .get(taskId) as { title?: string | null; project_id?: string | null } | undefined;
        const projectId = row?.project_id;
        if (typeof projectId !== 'string' || projectId.length === 0) {
            deps.logger.warn(
                'orchestrator: instructions on a re-run but no projectId; memory entry skipped',
                { taskId },
            );
            return;
        }
        deps.agentMemory.append(projectId, {
            source: 'interrupt-restart',
            taskIdentifier: taskId,
            taskTitle: row?.title ?? taskId,
            feedback: instructions,
            recordedAt: deps.clock(),
        });
    } catch (err) {
        deps.logger.warn('orchestrator: failed to record instructions in agent memory', {
            taskId,
            error: err instanceof Error ? err.message : String(err),
        });
    }
}

/**
 * Report a failed lifecycle run to the operator, whichever way it
 * failed.
 *
 * One router for both subscribers. `AgentFailed` (the CLI died) has
 * always come through here; `AgentFinished` with a non-success outcome
 * (the CLI ran, and the API refused the prompt) used to log a single
 * info line and return — no event, no plan metadata, nothing on the
 * board. The card simply stopped, and the only trace was in worker.log.
 *
 * Shared rather than duplicated because the two paths describe the same
 * thing to the operator, and a divergence between them is invisible
 * until someone is staring at a stalled card.
 */
async function reportLifecycleFailure(
    bus: EventBus,
    deps: RegisterPlanLifecycleAgentHandlersDeps,
    ctx: LifecycleAgentContext,
    reason: string,
): Promise<void> {
    if (ctx.kind === 'design-verifier') {
        // Agent-level failure (auth, crash) — a verification ERROR,
        // not a fail verdict. The requirement card shows the error
        // with Retry verification / Implement anyway / Cancel.
        await bus.publish({
            type: RequirementEvents.DESIGN_VERIFICATION_FAILED,
            v: 1,
            occurredAt: deps.clock(),
            idempotencyKey:
                `dv-fail:${ctx.requirementId}:r${ctx.revision ?? 1}:${deps.clock()}`,
            payload: {
                requirementId: ctx.requirementId ?? '',
                revision: ctx.revision ?? 1,
                findings: [],
                error: reason.slice(0, 400),
            },
        });
        return;
    }
    if (ctx.kind === 'architect') {
        deps.logger.warn('orchestrator: architect agent failed', {
            requirementId: ctx.requirementId,
            reason,
        });
        return;
    }
    if (ctx.kind === 'planner') {
        await emitPlanGenerateFailed(bus, deps.clock, ctx, reason);
        // Persist the failure on the plan's metadata so the DRAFT
        // card shows why the planner failed even after a board
        // reload (the active-planner card's error only lives in
        // the live session). Cleared by the next successful run.
        await patchPlanMetadata(bus, deps, ctx.planId, {
            plannerError: reason.slice(0, 300),
            plannerErrorAt: deps.clock(),
        });
        return;
    }
    await emitPlanDecomposeFailed(bus, deps, ctx, reason);
}

async function emitPlanDecomposeFailed(
    bus: EventBus,
    deps: RegisterPlanLifecycleAgentHandlersDeps,
    ctx: LifecycleAgentContext,
    error: string,
): Promise<void> {
    // AP-VP4-010 AC #5: route the rejection into agent memory so the
    // next planner run sees it as prior operator feedback. The source is
    // 'clarification' because the failure is logically an operator-side
    // question ("the JSON did not validate, please regenerate"), which
    // matches the source enum the memory store accepts.
    if (deps.agentMemory) {
        try {
            const entry: AgentMemoryEntry = {
                source: 'clarification',
                taskIdentifier: ctx.planId,
                taskTitle: 'PlanDecomposeFailed',
                feedback: error,
                recordedAt: deps.clock(),
            };
            deps.agentMemory.append(ctx.projectId, entry);
        } catch (err) {
            deps.logger.warn('orchestrator: failed to append PlanDecomposeFailed feedback to agent memory', {
                planId: ctx.planId,
                projectId: ctx.projectId,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }
    const payload: PlanDecomposeFailedPayload = {
        planId: ctx.planId,
        projectId: ctx.projectId,
        error,
    };
    const event: Event = {
        type: PlanLifecycleAgentEvents.PLAN_DECOMPOSE_FAILED,
        v: 1,
        occurredAt: deps.clock(),
        idempotencyKey:
            `${PlanLifecycleAgentEvents.PLAN_DECOMPOSE_FAILED}:${ctx.planId}:${deps.clock()}`,
        payload,
    };
    await bus.publish(event);
}

/**
 * The pending decomposer question on `planId` — the newest recorded row
 * with no answer yet — or null when there is none.
 *
 * This is what makes the Answer button honest: the board renders it off a
 * projection, and the command re-checks the same projection at dispatch
 * time, so a question answered in another tab is rejected instead of
 * silently re-answered.
 */
export function readPendingDecomposerQuestion(
    db: import('../../core/state/migrations').Db | undefined,
    planId: string,
): { readonly eventSeq: number; readonly projectId: string; readonly question: string } | null {
    if (!db) return null;
    try {
        const row = db
            .prepare(
                `SELECT event_seq, project_id, question FROM decomposer_clarifications
                  WHERE plan_id = ? AND (answer IS NULL OR TRIM(answer) = '')
                  ORDER BY event_seq DESC
                  LIMIT 1`,
            )
            .get(planId) as
                | { event_seq: number; project_id: string | null; question: string }
                | undefined;
        if (row) {
            return {
                eventSeq: row.event_seq,
                projectId: row.project_id ?? '',
                question: row.question,
            };
        }
    } catch {
        // Fall through to the event log — see below.
    }
    // The projection said nothing. That is NOT proof there is no pending
    // question: the board's card is painted by folding the EVENT LOG
    // (`/api/active-decomposers`), so if the two ever disagree the operator
    // is looking at an Answer button whose command refuses every click —
    // a permanently dead control with no way to un-hold the plan. It has
    // one real cause (the projection missed the row: table not yet
    // migrated when the event landed, a subscriber error the bus logged
    // and swallowed) and no good outcome.
    //
    // So fall back to the same source the card uses. Card and command then
    // cannot disagree by construction.
    return readPendingDecomposerQuestionFromEvents(db, planId);
}

/**
 * Pending question derived straight from the event log: the newest
 * `PlanDecomposeQuestionRaised` for the plan, unless a
 * `PlanDecomposeQuestionAnswered` for that plan follows it.
 *
 * `eventSeq` is the raising event's seq — the same value the projection
 * stores as its primary key, so the answer's idempotency key is identical
 * whichever path produced it and a double-click still collapses.
 */
function readPendingDecomposerQuestionFromEvents(
    db: import('../../core/state/migrations').Db,
    planId: string,
): { readonly eventSeq: number; readonly projectId: string; readonly question: string } | null {
    try {
        const rows = db
            .prepare(
                `SELECT seq, type, payload FROM events
                  WHERE type IN ('PlanDecomposeQuestionRaised',
                                 'PlanDecomposeQuestionAnswered')
                  ORDER BY seq ASC`,
            )
            .all() as ReadonlyArray<{ seq: number; type: string; payload: string }>;
        let pending: { eventSeq: number; projectId: string; question: string } | null = null;
        for (const row of rows) {
            let payload: Record<string, unknown>;
            try {
                payload = JSON.parse(row.payload) as Record<string, unknown>;
            } catch {
                continue;
            }
            if (payload.planId !== planId) continue;
            if (row.type === 'PlanDecomposeQuestionAnswered') {
                pending = null;
                continue;
            }
            const question = typeof payload.question === 'string' ? payload.question : '';
            if (question.length === 0) continue;
            pending = {
                eventSeq: row.seq,
                projectId: typeof payload.projectId === 'string' ? payload.projectId : '',
                question,
            };
        }
        return pending;
    } catch {
        return null;
    }
}

/**
 * Read every clarification recorded for `planId`, oldest first.
 *
 * `answered` filters to rows the operator has actually replied to — the
 * prompt block only ever carries decisions, never an open question. The
 * unfiltered form is what the cap counts: three questions asked is three
 * questions asked, whether or not the third was answered.
 */
export function readDecomposerClarifications(
    db: import('../../core/state/migrations').Db | undefined,
    planId: string,
    opts?: { readonly answeredOnly?: boolean },
): ClarificationRecord[] {
    if (!db) return [];
    try {
        const rows = db
            .prepare(
                `SELECT question, answer FROM decomposer_clarifications
                  WHERE plan_id = ?
                  ORDER BY event_seq ASC`,
            )
            .all(planId) as ReadonlyArray<{
                question: string | null;
                answer: string | null;
            }>;
        const out: ClarificationRecord[] = [];
        for (const row of rows) {
            const answer = typeof row.answer === 'string' ? row.answer.trim() : '';
            if (opts?.answeredOnly !== false && answer.length === 0) continue;
            out.push({ question: row.question ?? null, answer });
        }
        return out;
    } catch {
        // The table is a read-side convenience; a projection that has not
        // caught up (or a test DB without the migration) must not take the
        // decompose path down with it.
        return [];
    }
}

/**
 * Count questions asked on `planId`, answered or not — the cap's input.
 */
function countDecomposerQuestions(
    db: import('../../core/state/migrations').Db | undefined,
    planId: string,
): number {
    if (!db) return 0;
    let projected = 0;
    try {
        const row = db
            .prepare('SELECT COUNT(*) AS n FROM decomposer_clarifications WHERE plan_id = ?')
            .get(planId) as { n?: number } | undefined;
        projected = typeof row?.n === 'number' ? row.n : 0;
    } catch { /* fall through to the event count */ }
    // The event log is the floor. A projection that missed rows would
    // otherwise silently raise the cap and let the decomposer ask forever —
    // the loop the cap exists to stop. Same reasoning as
    // readPendingDecomposerQuestionFromEvents: never let a read-side gap
    // change a decision.
    let emitted = 0;
    try {
        const row = db
            .prepare(
                `SELECT COUNT(*) AS n FROM events
                  WHERE type = 'PlanDecomposeQuestionRaised'
                    AND json_extract(payload, '$.planId') = ?`,
            )
            .get(planId) as { n?: number } | undefined;
        emitted = typeof row?.n === 'number' ? row.n : 0;
    } catch { /* no JSON1 support — the projection count stands alone */ }
    return Math.max(projected, emitted);
}

/**
 * When the decomposer's final message carries a `NEEDS_HUMAN_INPUT` block,
 * publish `PlanDecomposeQuestionRaised` and return true — the caller must
 * then stop, leaving the run held rather than failed.
 *
 * Returns false when the output carries no question (the normal path) and,
 * deliberately, when the block is present but unparseable: a marker with no
 * `Question:` line cannot be put in front of an operator, so it falls
 * through to the JSON path and fails with the real output in the error.
 * Silently swallowing it would leave the plan with no card state at all.
 */
async function emitDecomposeQuestionIfAsked(
    bus: EventBus,
    deps: RegisterPlanLifecycleAgentHandlersDeps,
    ctx: LifecycleAgentContext,
    content: string,
    pendingQuestions?: Map<string, LifecycleAgentContext>,
): Promise<boolean> {
    const clarification = parseClarification(content);
    if (clarification === null) return false;

    const asked = countDecomposerQuestions(deps.db, ctx.planId);
    if (asked >= DECOMPOSER_CLARIFICATION_CAP) {
        // Not converging. Fail with the question in the message so the
        // operator can see WHAT it kept asking, then decide whether to
        // rewrite the plan or re-approve it.
        await emitPlanDecomposeFailed(
            bus,
            deps,
            ctx,
            `decomposer asked ${String(asked + 1)} questions on this plan `
            + `(cap ${String(DECOMPOSER_CLARIFICATION_CAP)}); it is not converging. `
            + `Latest question: ${clarification.question}`,
        );
        return true;
    }

    const askedAt = deps.clock();
    // The spawn inputs are stashed BEFORE the publish so the answer
    // subscriber can re-spawn this exact run. Process-local by design: on a
    // worker restart the map is empty and the answer path rebuilds the
    // inputs from the projection instead (see the answered subscriber).
    pendingQuestions?.set(ctx.planId, ctx);

    const payload: PlanDecomposeQuestionRaisedPayload = {
        planId: ctx.planId,
        projectId: ctx.projectId,
        question: clarification.question,
        options: clarification.options.map((o) => ({ key: o.key, label: o.label })),
        raw: clarification.raw,
        askedAt,
    };
    await bus.publish({
        type: PlanLifecycleAgentEvents.PLAN_DECOMPOSE_QUESTION_RAISED,
        v: 1,
        occurredAt: askedAt,
        // Keyed on askedAt, not on planId alone: a decomposer may ask more
        // than once on the same plan and each question is a distinct event.
        // A per-plan key would dedup the second question out of existence —
        // the exact failure mode `DecomposePlan` shipped with.
        idempotencyKey:
            `${PlanLifecycleAgentEvents.PLAN_DECOMPOSE_QUESTION_RAISED}:${ctx.planId}:${askedAt}`,
        payload,
    });
    deps.logger.info('orchestrator: decomposer asked the operator a question', {
        planId: ctx.planId,
        projectId: ctx.projectId,
        question: clarification.question.slice(0, 200),
        options: clarification.options.length,
    });
    return true;
}

/** Union of two edge maps (task id → the ids it must follow), de-duplicated. */
function mergeEdges(
    a: ReadonlyMap<string, readonly string[]> | undefined,
    b: ReadonlyMap<string, readonly string[]>,
): ReadonlyMap<string, readonly string[]> {
    if (!a) return b;
    const out = new Map<string, readonly string[]>(a);
    for (const [id, deps] of b) out.set(id, [...new Set([...(out.get(id) ?? []), ...deps])]);
    return out;
}

function taskTypesFor(deps: { readonly getTaskTypes?: () => TaskTypeCatalog }): TaskTypeCatalog {
    return deps.getTaskTypes
        ? deps.getTaskTypes()
        : TaskTypeCatalog.fromFlows(loadLayeredFlows(flowLayerDirs()));
}

/**
 * Wire the PlanGenerated subscriber that feeds the supplied gate. The
 * orchestrator host calls this once after `registerCommandHandlers` so
 * future ApprovePlan calls observe the gate progressing as PlanGenerated
 * events flow through.
 */
export interface PlanGenerationGateWiring {
    readonly gate: PlanGenerationGate;
    readonly recordOnEvent: (event: { readonly payload: PlanGeneratedEventPayload }) => void;
}

export function buildPlanGenerationGateWiring(
    gate: PlanGenerationGate = new InMemoryPlanGenerationGate(),
): PlanGenerationGateWiring {
    return {
        gate,
        recordOnEvent: (event): void => {
            gate.record(event.payload.planId);
        },
    };
}

export const PLAN_GENERATED_EVENT_TYPE = PlanLifecycleEvents.PLAN_GENERATED;

// AP-IFG-020 — re-exported here so the orchestrator host wires the
// narrative-comment sink through the same handler-surface import as the
// rest of the lifecycle plumbing. The sink itself lives next door in
// `./linear-comment-sink` so the per-kind comment table stays pinned by
// dedicated unit tests rather than buried alongside command handlers.
export {
    LINEAR_COMMENT_SINK_SUBSCRIBER,
    LinearCommentSinkEvents,
    registerLinearCommentSink,
    type LinearCommentSinkDeps,
    type LinearCommentSinkEventType,
    type LinearCommentSinkPayload,
} from './linear-comment-sink';

// AP-VP5-004 — re-exported so the orchestrator host wires the
// clarification handler through the same handler-surface import as the
// rest of the lifecycle plumbing. The handler itself lives in
// `./handlers/clarification` so the parser semantics are pinned by a
// dedicated unit test (`test/unit/orchestrator/clarification-handler.test.ts`)
// rather than buried alongside command handlers.
export {
    parseNeedsHumanInputLine,
    registerClarificationHandler,
    type AgentStreamLineContext,
    type AgentStreamSubscription,
    type ClarificationHandlerDeps,
} from './handlers/clarification';

/**
 * AP-IFG-014: emit a `WorkerError` notification on any uncaught exception
 * or unhandled promise rejection raised inside the orchestrator host.
 *
 * The handler publishes through the supplied {@link EventBus}, which lets
 * a registered {@link NotificationPort} adapter (TelegramGateway today,
 * Slack / web-UI tomorrow) translate the event into an operator-visible
 * message via its own `WorkerError` subscriber — no extra wiring at this
 * call site.
 *
 * `process` defaults to the global Node process emitter; tests can inject
 * a `NodeJS.EventEmitter` stand-in to drive both event types
 * deterministically without leaking real handlers between cases.
 *
 * Returns a teardown closure. The orchestrator host invokes it on
 * `stop()` so a long-running test suite doesn't accrete listeners.
 */
export interface WorkerErrorHandlerDeps {
    readonly bus: EventBus;
    readonly logger: Logger;
    readonly clock: () => number;
    /**
     * Process emitter the handler attaches to. Defaults to `process`; tests
     * pass a fresh `EventEmitter` so they can `.emit('uncaughtException', ...)`
     * without disturbing the real Node process.
     */
    readonly processEmitter?: NodeJS.EventEmitter;
}

/**
 * AP-VP-013 — orchestrator-side `InterruptTask` handler.
 *
 * The worker-api host's existing handler (`hosts/worker-api/commands/
 * interrupt-task.ts`) reaches `ClaudeCliRunner.interrupt(handle)` directly,
 * which writes the sidecar inside the runner. That works while
 * `ClaudeCliRunner` is the only kill path, but as soon as the dispatch goes
 * through the `AgentRunKiller` port — the production wiring already
 * constructs a `ClaudeCliAgentRunKiller` and hands it to the board-ui's
 * `CancelAgentRun` handler — the sidecar write becomes the killer
 * implementation's problem rather than the handler's. A future adapter
 * that wraps `taskkill` directly (or a different process model entirely)
 * could legitimately omit the sidecar and silently turn every operator
 * interrupt into a "real crash" from the runner's close-handler point of
 * view.
 *
 * This handler hoists the sidecar write to the dispatch site:
 *
 *   1. Resolve `taskId` → live agent handle (returns `[]` if no agent is
 *      mapped — same not-found contract as the worker-api handler).
 *   2. `writeFileSync` the `.killed` sidecar at the path the runner's
 *      close handler reads, carrying at least a timestamp + agentId.
 *   3. THEN call `agentRunKiller.kill(agentId)`. Order matters: an async
 *      write that lost the race to the kill signal would let the close
 *      handler observe the exit before the sidecar landed and misclassify
 *      the run as a crash. The write is synchronous so the file is on
 *      disk before the killer port returns control.
 *   4. Emit `TaskInterrupted` for downstream subscribers.
 *
 * The handler is exported as a factory + opt-in registration helper rather
 * than auto-registered from `registerCommandHandlers` so callers can pick
 * exactly one InterruptTask implementation per CommandBus (the worker-api
 * host registers its own; orchestrator-only hosts that want the
 * sidecar-at-dispatch behaviour wire this one instead).
 */
export interface InterruptTaskHandlerDeps {
    readonly clock: () => number;
    /**
     * Killer port. Production wiring passes the same
     * `ClaudeCliAgentRunKiller` instance the board-ui's `CancelAgentRun`
     * handler is already given — keeping a single side-effect adapter
     * means there is exactly one place to reason about cancellation
     * semantics across the host.
     */
    readonly agentRunKiller: AgentRunKiller;
    /**
     * Inverse of the orchestrator's `agentToTask` map: returns the live
     * agentId driving `taskId`, or `undefined` when nothing is mapped.
     * Production wiring delegates to `Orchestrator.getAgentForTask`.
     */
    readonly getAgentForTask: (taskId: string) => string | undefined;
    /**
     * Absolute path of the `.killed` sidecar for `agentId`. Must match
     * the runner's close-handler expectation — production wiring binds
     * `ClaudeCliRunner.killedSidecarPath` so the runner and the handler
     * agree on a single path scheme (sidecarDir + `${agentId}.killed`).
     */
    readonly sidecarPathForAgent: (agentId: string) => string;
    readonly logger: Logger;
}

/**
 * Payload written into the `.killed` sidecar. Kept intentionally small —
 * the only invariant the runner's close handler depends on is the file's
 * presence; the contents are for post-mortem correlation (which operator
 * killed which agent, when).
 */
export interface KilledSidecarBody {
    readonly killedAt: number;
    readonly agentId: string;
    readonly taskId: string;
    readonly actor: string;
    readonly reason?: string;
}

/**
 * Write the sidecar synchronously so the file is on disk by the time
 * control returns. Parent directory is created on demand — the sidecar
 * dir convention (`${sidecarDir}/${agentId}.killed`) matches the runner's
 * own `writeKilledSidecar`, so in production this `mkdirSync` is usually
 * a no-op (the dir was already created when the agent first spawned).
 */
function writeKilledSidecarSync(
    sidecarPath: string,
    body: KilledSidecarBody,
): void {
    fs.mkdirSync(path.dirname(sidecarPath), { recursive: true });
    fs.writeFileSync(sidecarPath, JSON.stringify(body));
}

export function createInterruptTaskHandler(
    deps: InterruptTaskHandlerDeps,
): CommandHandler<Command<InterruptTaskPayload>> {
    return async (cmd): Promise<Event[]> => {
        if (!isInterruptTaskPayload(cmd.payload)) {
            deps.logger.warn(
                `orchestrator: ${BoardUiCommands.INTERRUPT_TASK} rejected (invalid payload)`,
                { type: BoardUiCommands.INTERRUPT_TASK, actor: cmd.actor },
            );
            throw new Error('InterruptTask: invalid payload');
        }
        const { taskId, reason } = cmd.payload;

        const agentId = deps.getAgentForTask(taskId);
        if (agentId === undefined) {
            deps.logger.warn(
                `orchestrator: ${BoardUiCommands.INTERRUPT_TASK} no live agent for task`,
                {
                    type: BoardUiCommands.INTERRUPT_TASK,
                    actor: cmd.actor,
                    taskId,
                },
            );
            return [];
        }

        const key = `${BoardUiCommands.INTERRUPT_TASK}:${taskId}:${cmd.issuedAt}`;
        deps.logger.info(`orchestrator: ${BoardUiCommands.INTERRUPT_TASK} accepted`, {
            type: BoardUiCommands.INTERRUPT_TASK,
            actor: cmd.actor,
            idempotencyKey: key,
            taskId,
            agentId,
        });

        // Sidecar BEFORE kill. Synchronous so the file is guaranteed on
        // disk before the killer port has a chance to deliver the signal.
        const sidecarPath = deps.sidecarPathForAgent(agentId);
        const sidecarBody: KilledSidecarBody =
            reason !== undefined
                ? { killedAt: deps.clock(), agentId, taskId, actor: cmd.actor, reason }
                : { killedAt: deps.clock(), agentId, taskId, actor: cmd.actor };
        try {
            writeKilledSidecarSync(sidecarPath, sidecarBody);
        } catch (err) {
            deps.logger.error(
                `orchestrator: ${BoardUiCommands.INTERRUPT_TASK} sidecar write failed`,
                {
                    type: BoardUiCommands.INTERRUPT_TASK,
                    taskId,
                    agentId,
                    sidecarPath,
                    error: err instanceof Error ? err.message : String(err),
                },
            );
            throw err;
        }

        try {
            await deps.agentRunKiller.kill(agentId);
        } catch (err) {
            deps.logger.error(
                `orchestrator: ${BoardUiCommands.INTERRUPT_TASK} killer.kill failed`,
                {
                    type: BoardUiCommands.INTERRUPT_TASK,
                    taskId,
                    agentId,
                    error: err instanceof Error ? err.message : String(err),
                },
            );
            throw err;
        }

        const payload: TaskInterruptedPayload =
            reason !== undefined
                ? { taskId, actor: cmd.actor, reason }
                : { taskId, actor: cmd.actor };
        const event: Event = {
            type: BoardUiEvents.TASK_INTERRUPTED,
            v: 1,
            occurredAt: deps.clock(),
            idempotencyKey: key,
            payload,
        };
        return [event];
    };
}

/**
 * Register the orchestrator-side `InterruptTask` handler on `bus`. Only
 * one InterruptTask handler may live on a given CommandBus — callers
 * pick this implementation OR the worker-api host's, not both.
 */
export function registerInterruptTaskHandler(
    bus: CommandBus<unknown>,
    deps: InterruptTaskHandlerDeps,
): void {
    bus.register<InterruptTaskPayload>(
        BoardUiCommands.INTERRUPT_TASK,
        createInterruptTaskHandler(deps),
    );
}

export function registerWorkerErrorHandlers(
    deps: WorkerErrorHandlerDeps,
): () => void {
    const emitter = deps.processEmitter ?? process;
    let seq = 0;

    const emit = async (source: 'uncaughtException' | 'unhandledRejection', err: unknown): Promise<void> => {
        seq += 1;
        const message = err instanceof Error ? err.message : String(err);
        const stack = err instanceof Error ? err.stack : undefined;
        const payload: NotificationPayload = {
            title: 'Worker error',
            error: message,
            body: `Source: ${source}`,
            ...(stack !== undefined ? { stack } : {}),
        };
        try {
            await deps.bus.publish({
                type: NotificationKinds.WORKER_ERROR,
                v: 1,
                occurredAt: deps.clock(),
                idempotencyKey: `WorkerError:${deps.clock()}:${seq}`,
                payload,
            });
        } catch (publishErr) {
            // Publishing must never re-throw — that would itself trigger a
            // fresh uncaughtException and infinite-loop the handler.
            deps.logger.error('worker-error: publish failed', {
                source,
                error: publishErr instanceof Error ? publishErr.message : String(publishErr),
            });
        }
    };

    const onException = (err: unknown): void => {
        void emit('uncaughtException', err);
    };
    const onRejection = (reason: unknown): void => {
        void emit('unhandledRejection', reason);
    };

    emitter.on('uncaughtException', onException);
    emitter.on('unhandledRejection', onRejection);

    return (): void => {
        emitter.off('uncaughtException', onException);
        emitter.off('unhandledRejection', onRejection);
    };
}

/**
 * The step a task is being HELD AT by the flow engine's approval gate,
 * or null when it is not at the gate.
 *
 * `flow_state.parked_step_id` is written by the gate and cleared the
 * moment the step is released, so a non-null value means "the engine is
 * waiting for a TaskResumed decision on this step".
 *
 * This is what tells an approval of a RUNNING flow apart from an
 * approval that STARTS one - two states that need different events, and
 * whose confusion silently dropped every gate approval from Telegram.
 *
 * Degrades to null: with no db wired (tests, thin hosts) the caller
 * keeps its previous behaviour rather than guessing.
 */
export function approvalGateParkedStep(
    db: import('../../core/state/migrations').Db | undefined,
    taskId: string,
): string | null {
    if (!db) return null;
    try {
        const row = db
            .prepare('SELECT parked_step_id FROM flow_state WHERE task_id = ?')
            .get(taskId) as { parked_step_id?: string | null } | undefined;
        const stepId = row?.parked_step_id;
        return typeof stepId === 'string' && stepId.length > 0 ? stepId : null;
    } catch {
        // A missing table (a host that never migrated) must not take
        // the approval down - fall back to the start-of-flow event.
        return null;
    }
}

/**
 * Actors whose `ApproveTask` is a HUMAN decision, and may therefore
 * release the flow engine's approval gate.
 *
 * The pipeline dispatches ApproveTask to itself too - `TaskCreated ->`
 * `ApproveTask` fires for every task a decomposition produces - and that
 * cascade means "this task may begin its flow", NOT "the operator
 * approved the step the gate is holding". One command name, two
 * intentions; only the second one may start an agent.
 *
 * Deliberately a whitelist. An operator surface missing from it leaves
 * the task parked - visible, and one more click. An automated actor
 * missing from a blacklist would run an agent nobody approved.
 */
const OPERATOR_ACTORS: ReadonlySet<string> = new Set([
    'operator', // the board
    'telegram', // the Telegram keyboard and slash commands
]);

/** Is this `ApproveTask` an operator decision? See {@link OPERATOR_ACTORS}. */
export function isOperatorActor(actor: string | undefined | null): boolean {
    return typeof actor === 'string' && OPERATOR_ACTORS.has(actor);
}
