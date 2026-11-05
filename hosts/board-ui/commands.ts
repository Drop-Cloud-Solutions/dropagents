/**
 * Board-UI command vocabulary (AP-IFG-008).
 *
 * Defines the 13 operator-facing commands the board surfaces for CRUD on
 * projects, plans, tasks, notes, and the agent-cancellation control. Each
 * command body intentionally mirrors the v1 board's request shape so an
 * operator (or integration test) trained on v1 sees the same payloads here.
 *
 * Architectural rule (AC #3): handlers emit a single domain event and do
 * NOT mutate state inline. The state projection — sqlite tables, Linear
 * sync, chat notifications — lives in subscriber modules that watch the
 * event bus. `CancelAgentRun` is the lone handler with a side effect: it
 * delegates to the injected `AgentRunKiller` (production: a thin wrapper
 * around `ClaudeCliRunner.interrupt`) before emitting `AgentRunCancelled`.
 *
 * Event-name aliasing: the orchestrator already owns a `TaskUpdated` event
 * for AP-IFG-001 lineage mutations. The board-ui's full-field task edit is
 * a different concern, so it emits `TaskFieldsUpdated` to keep payload
 * shapes type-safe at the subscriber boundary.
 *
 * Production wiring registers these handlers on the SAME CommandBus the
 * orchestrator uses; tests construct a fresh bus per case so handler
 * ordering and idempotency keys can be asserted in isolation.
 */

import {
    isArchivePlanPayload,
    isMarkTaskCompletePayload,
    isPreApproveTaskPayload,
    isRetryTaskPayload,
    isSkipTaskPayload,
    isUpdateProjectApprovalOverridePayload,
    PlanOpsCommands,
    ProjectOpsCommands,
    TaskOpsCommands,
} from '../../core/commands';
import type { CommandBus, CommandHandler } from '../../core/commands/bus';
import { findTruncation } from '../manager-api/persona-integrity';
import type { Command } from '../../core/commands/command';
import type { Event } from '../../core/events/event';
import type { IdGen } from '../../core/ports/IdGen';
import type { Logger } from '../../core/ports/Logger';

// ---------------------------------------------------------------------------
// Command / event type constants
// ---------------------------------------------------------------------------

export const BoardUiCommands = {
    CREATE_PROJECT: 'CreateProject',
    UPDATE_PROJECT: 'UpdateProject',
    /**
     * The project's architecture context (prose). A separate command from
     * UpdateProject because it lands in its own column, not the metadata
     * blob — see migration 034 — and because the project form must not
     * have to round-trip a page of markdown just to rename a project.
     */
    UPDATE_PROJECT_CONTEXT: 'UpdateProjectContext',
    ARCHIVE_PROJECT: 'ArchiveProject',
    CREATE_PLAN: 'CreatePlan',
    UPDATE_PLAN: 'UpdatePlan',
    DELETE_PLAN: 'DeletePlan',
    /**
     * Operator-facing field edit on a task — title / description / type /
     * flowId. Renamed away from the historic `'UpdateTask'` string because
     * the orchestrator host owns a same-named `Commands.UPDATE_TASK` for
     * AP-IFG-001 lineage mutations; registering both on the shared bus
     * tripped a duplicate-handler boot error (AP-IFE-004). The emitted
     * event stays `TaskFieldsUpdated`, so subscribers are unaffected.
     */
    EDIT_TASK: 'EditTask',
    DELETE_TASK: 'DeleteTask',
    CREATE_INVESTIGATION: 'CreateInvestigation',
    CREATE_NOTE: 'CreateNote',
    UPDATE_NOTE: 'UpdateNote',
    DELETE_NOTE: 'DeleteNote',
    CANCEL_AGENT_RUN: 'CancelAgentRun',
    /**
     * Abort a running task agent. Distinct from `CANCEL_AGENT_RUN` (which
     * targets a live runId): `INTERRUPT_TASK` is taskId-keyed and matches
     * v1's interrupt semantics — append a `TaskInterrupted` event and drop
     * a `.killed` sidecar in the task's worktree so the running agent
     * notices on its next stream poll. The handler lives in the worker-api
     * host (`hosts/worker-api/commands/interrupt-task.ts`) because the
     * sidecar write is a filesystem side effect outside the pure-event
     * vocabulary the rest of this module provides.
     */
    INTERRUPT_TASK: 'InterruptTask',
} as const;

export const BoardUiEvents = {
    PROJECT_CREATED: 'ProjectCreated',
    PROJECT_UPDATED: 'ProjectUpdated',
    PROJECT_CONTEXT_UPDATED: 'ProjectContextUpdated',
    PROJECT_ARCHIVED: 'ProjectArchived',
    PLAN_CREATED: 'PlanCreated',
    PLAN_UPDATED: 'PlanUpdated',
    PLAN_DELETED: 'PlanDeleted',
    /**
     * Aliased away from the bare `TaskUpdated` event the orchestrator emits
     * for AP-IFG-001 lineage mutations. Subscribers that care about field
     * edits (title/description/type/flow) listen for this; subscribers that
     * care about lineage (`investigation_thread`, `followup_inflight`)
     * stay on `TaskUpdated`.
     */
    TASK_FIELDS_UPDATED: 'TaskFieldsUpdated',
    TASK_DELETED: 'TaskDeleted',
    INVESTIGATION_REQUESTED: 'InvestigationRequested',
    NOTE_CREATED: 'NoteCreated',
    NOTE_UPDATED: 'NoteUpdated',
    NOTE_DELETED: 'NoteDeleted',
    AGENT_RUN_CANCELLED: 'AgentRunCancelled',
    /**
     * Paired with `INTERRUPT_TASK`. Emitted after the worker-api host has
     * dropped the `.killed` sidecar in the task's worktree so subscribers
     * see the interrupt only once the running agent's signal file is
     * already on disk — same ordering rule as `AGENT_RUN_CANCELLED`.
     */
    TASK_INTERRUPTED: 'TaskInterrupted',
} as const;

// ---------------------------------------------------------------------------
// Command payloads (mirror v1 board request bodies)
// ---------------------------------------------------------------------------

/** One repo entry on the operator's project form. */
export interface ProjectRepoPayload {
    readonly id: string;
    readonly name?: string;
    readonly url: string;
}

/**
 * Project metadata — everything beyond name + description the
 * new-project / edit-project modal collects. Persisted as a JSON blob
 * on `projects.metadata` so adding another knob doesn't require a
 * fresh migration. Every key is optional; the modal sends only what
 * the operator filled in.
 */
export interface ProjectMetadataPayload {
    readonly abbr?: string;
    readonly color?: string;
    /** Description duplicated here so projection writes survive without
     *  reading the dedicated `description` column from elsewhere. */
    readonly description?: string;
    readonly repos?: ReadonlyArray<ProjectRepoPayload>;
}

export interface CreateProjectPayload {
    /** Optional client-supplied id; the handler falls back to `idGen.newId()`. */
    readonly projectId?: string;
    readonly name: string;
    readonly description?: string;
    readonly metadata?: ProjectMetadataPayload;
}

export interface UpdateProjectPayload {
    readonly projectId: string;
    readonly name?: string;
    readonly description?: string;
    readonly metadata?: ProjectMetadataPayload;
}

export interface UpdateProjectContextPayload {
    readonly projectId: string;
    /** Markdown. Empty string CLEARS the context — a legitimate state. */
    readonly context: string;
}

export interface ArchiveProjectPayload {
    readonly projectId: string;
}

/**
 * Conventions block — operator-supplied per-plan overrides for the
 * developer / reviewer / tester defaults. Mirrors the same four keys
 * the modal's conventions sub-form ships and the v1 `plan_defaults`
 * shape so the wire stays compatible with v1 archive consumers.
 */
export interface PlanConventionsPayload {
    readonly namespace_root?: string;
    readonly test_framework?: string;
    readonly branch_pattern?: string;
    readonly commit_pattern?: string;
}

/**
 * Plan metadata — everything the new-plan modal collects beyond the
 * title + body pair. Persisted as a JSON blob on `sidebar_plans` so a
 * future field doesn't require a column-per-knob migration. Every key
 * is optional; the modal sends only what the operator filled in.
 */
export interface PlanMetadataPayload {
    readonly conventions?: PlanConventionsPayload;
    /** v1 archetype slug — `feature`, `deploy-only`, etc. */
    readonly planType?: string;
    /** Repo id picked from the project's repos dropdown. */
    readonly targetRepo?: string;
    /** Comma-separated tech-stack hint forwarded to the planner. */
    readonly techStack?: string;
    readonly deployAfterMerge?: boolean;
    readonly skipPlanReview?: boolean;
    readonly autoTrigger?: boolean;
}

export interface CreatePlanPayload {
    readonly planId?: string;
    readonly projectId: string;
    readonly title: string;
    readonly body?: string;
    readonly metadata?: PlanMetadataPayload;
}

export interface UpdatePlanPayload {
    readonly planId: string;
    readonly title?: string;
    readonly body?: string;
    readonly metadata?: PlanMetadataPayload;
}

export interface DeletePlanPayload {
    readonly planId: string;
}

export interface UpdateTaskPayload {
    readonly taskId: string;
    readonly title?: string;
    readonly description?: string;
    readonly type?: string;
    readonly flowId?: string;
}

export interface DeleteTaskPayload {
    readonly taskId: string;
}

export interface CreateInvestigationPayload {
    readonly taskId: string;
    readonly question: string;
}

/** Notes can hang off a project, a plan, or a task. */
export type NoteTargetType = 'project' | 'plan' | 'task';

export interface CreateNotePayload {
    readonly noteId?: string;
    readonly targetType: NoteTargetType;
    readonly targetId: string;
    readonly body: string;
}

export interface UpdateNotePayload {
    readonly noteId: string;
    readonly body: string;
}

export interface DeleteNotePayload {
    readonly noteId: string;
}

export interface CancelAgentRunPayload {
    readonly runId: string;
    readonly reason?: string;
}

export interface InterruptTaskPayload {
    readonly taskId: string;
    readonly reason?: string;
}

// ---------------------------------------------------------------------------
// Event payloads
// ---------------------------------------------------------------------------

export interface ProjectCreatedPayload {
    readonly projectId: string;
    readonly name: string;
    readonly description?: string;
    readonly metadata?: ProjectMetadataPayload;
    readonly actor: string;
}

export interface ProjectUpdatedPayload {
    readonly projectId: string;
    readonly name?: string;
    readonly description?: string;
    readonly metadata?: ProjectMetadataPayload;
    readonly actor: string;
}

export interface ProjectArchivedPayload {
    readonly projectId: string;
    readonly actor: string;
}

export interface PlanCreatedPayload {
    readonly planId: string;
    readonly projectId: string;
    readonly title: string;
    readonly body?: string;
    readonly metadata?: PlanMetadataPayload;
    readonly actor: string;
}

export interface PlanUpdatedPayload {
    readonly planId: string;
    readonly title?: string;
    readonly body?: string;
    readonly metadata?: PlanMetadataPayload;
    readonly actor: string;
}

export interface PlanDeletedPayload {
    readonly planId: string;
    readonly actor: string;
}

export interface TaskFieldsUpdatedPayload {
    readonly taskId: string;
    readonly title?: string;
    readonly description?: string;
    readonly type?: string;
    readonly flowId?: string;
    readonly actor: string;
}

export interface TaskDeletedPayload {
    readonly taskId: string;
    readonly actor: string;
}

export interface InvestigationRequestedPayload {
    readonly investigationId: string;
    readonly taskId: string;
    readonly question: string;
    readonly actor: string;
}

export interface NoteCreatedPayload {
    readonly noteId: string;
    readonly targetType: NoteTargetType;
    readonly targetId: string;
    readonly body: string;
    readonly actor: string;
}

export interface NoteUpdatedPayload {
    readonly noteId: string;
    readonly body: string;
    readonly actor: string;
}

export interface NoteDeletedPayload {
    readonly noteId: string;
    readonly actor: string;
}

export interface AgentRunCancelledPayload {
    readonly runId: string;
    readonly reason?: string;
    readonly actor: string;
}

export interface TaskInterruptedPayload {
    readonly taskId: string;
    readonly reason?: string;
    readonly actor: string;
}

// ---------------------------------------------------------------------------
// Type-guard validators
// ---------------------------------------------------------------------------

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0;
}

function isOptionalString(value: unknown): boolean {
    return value === undefined || typeof value === 'string';
}

function isOptionalBoolean(value: unknown): boolean {
    return value === undefined || typeof value === 'boolean';
}

/**
 * Structural guard for {@link PlanMetadataPayload}. Treats every key as
 * optional and tolerates extra fields so a future operator-facing knob
 * doesn't need a coordinated wire-shape bump — the projection still
 * round-trips whatever JSON the modal posted.
 */
function isOptionalPlanMetadata(value: unknown): boolean {
    if (value === undefined) return true;
    if (!isObject(value)) return false;
    if (!isOptionalString(value.planType)) return false;
    if (!isOptionalString(value.targetRepo)) return false;
    if (!isOptionalString(value.techStack)) return false;
    if (!isOptionalBoolean(value.deployAfterMerge)) return false;
    if (!isOptionalBoolean(value.skipPlanReview)) return false;
    if (!isOptionalBoolean(value.autoTrigger)) return false;
    if (value.conventions !== undefined) {
        if (!isObject(value.conventions)) return false;
        const c = value.conventions;
        if (!isOptionalString(c.namespace_root)) return false;
        if (!isOptionalString(c.test_framework)) return false;
        if (!isOptionalString(c.branch_pattern)) return false;
        if (!isOptionalString(c.commit_pattern)) return false;
    }
    return true;
}

export function isCreateProjectPayload(value: unknown): value is CreateProjectPayload {
    if (!isObject(value)) return false;
    if (!isNonEmptyString(value.name)) return false;
    if (value.projectId !== undefined && !isNonEmptyString(value.projectId)) return false;
    if (!isOptionalString(value.description)) return false;
    if (!isOptionalProjectMetadata(value.metadata)) return false;
    return true;
}

export function isUpdateProjectContextPayload(
    value: unknown,
): value is UpdateProjectContextPayload {
    if (!isObject(value)) return false;
    if (!isNonEmptyString(value.projectId)) return false;
    // '' is valid and means "clear it" — so the check is `typeof`, not
    // non-empty. A missing field is still a rejection: silently treating
    // absent as empty would let a malformed request wipe the context.
    if (typeof value.context !== 'string') return false;
    return true;
}

export function isUpdateProjectPayload(value: unknown): value is UpdateProjectPayload {
    if (!isObject(value)) return false;
    if (!isNonEmptyString(value.projectId)) return false;
    if (!isOptionalString(value.name)) return false;
    if (!isOptionalString(value.description)) return false;
    if (!isOptionalProjectMetadata(value.metadata)) return false;
    return true;
}

/**
 * Structural guard for {@link ProjectMetadataPayload}. Treats every
 * key as optional and tolerates extras — same forward-compat stance as
 * {@link isOptionalPlanMetadata}.
 */
function isOptionalProjectMetadata(value: unknown): boolean {
    if (value === undefined) return true;
    if (!isObject(value)) return false;
    if (!isOptionalString(value.abbr)) return false;
    if (!isOptionalString(value.color)) return false;
    if (!isOptionalString(value.description)) return false;
    if (value.repos !== undefined) {
        if (!Array.isArray(value.repos)) return false;
        for (const repo of value.repos) {
            if (!isObject(repo)) return false;
            if (!isNonEmptyString(repo.id)) return false;
            if (!isNonEmptyString(repo.url)) return false;
            if (!isOptionalString(repo.name)) return false;
        }
    }
    return true;
}

export function isArchiveProjectPayload(value: unknown): value is ArchiveProjectPayload {
    return isObject(value) && isNonEmptyString(value.projectId);
}

export function isCreatePlanPayload(value: unknown): value is CreatePlanPayload {
    if (!isObject(value)) return false;
    if (!isNonEmptyString(value.projectId)) return false;
    if (!isNonEmptyString(value.title)) return false;
    if (value.planId !== undefined && !isNonEmptyString(value.planId)) return false;
    if (!isOptionalString(value.body)) return false;
    if (!isOptionalPlanMetadata(value.metadata)) return false;
    return true;
}

export function isUpdatePlanPayload(value: unknown): value is UpdatePlanPayload {
    if (!isObject(value)) return false;
    if (!isNonEmptyString(value.planId)) return false;
    if (!isOptionalString(value.title)) return false;
    if (!isOptionalString(value.body)) return false;
    if (!isOptionalPlanMetadata(value.metadata)) return false;
    return true;
}

export function isDeletePlanPayload(value: unknown): value is DeletePlanPayload {
    return isObject(value) && isNonEmptyString(value.planId);
}

export function isUpdateTaskPayload(value: unknown): value is UpdateTaskPayload {
    if (!isObject(value)) return false;
    if (!isNonEmptyString(value.taskId)) return false;
    if (!isOptionalString(value.title)) return false;
    if (!isOptionalString(value.description)) return false;
    if (!isOptionalString(value.type)) return false;
    if (!isOptionalString(value.flowId)) return false;
    return true;
}

export function isDeleteTaskPayload(value: unknown): value is DeleteTaskPayload {
    return isObject(value) && isNonEmptyString(value.taskId);
}

export function isCreateInvestigationPayload(
    value: unknown,
): value is CreateInvestigationPayload {
    if (!isObject(value)) return false;
    return isNonEmptyString(value.taskId) && isNonEmptyString(value.question);
}

function isNoteTargetType(value: unknown): value is NoteTargetType {
    return value === 'project' || value === 'plan' || value === 'task';
}

export function isCreateNotePayload(value: unknown): value is CreateNotePayload {
    if (!isObject(value)) return false;
    if (!isNoteTargetType(value.targetType)) return false;
    if (!isNonEmptyString(value.targetId)) return false;
    if (!isNonEmptyString(value.body)) return false;
    if (value.noteId !== undefined && !isNonEmptyString(value.noteId)) return false;
    return true;
}

export function isUpdateNotePayload(value: unknown): value is UpdateNotePayload {
    if (!isObject(value)) return false;
    return isNonEmptyString(value.noteId) && isNonEmptyString(value.body);
}

export function isDeleteNotePayload(value: unknown): value is DeleteNotePayload {
    return isObject(value) && isNonEmptyString(value.noteId);
}

export function isCancelAgentRunPayload(value: unknown): value is CancelAgentRunPayload {
    if (!isObject(value)) return false;
    if (!isNonEmptyString(value.runId)) return false;
    if (!isOptionalString(value.reason)) return false;
    return true;
}

export function isInterruptTaskPayload(value: unknown): value is InterruptTaskPayload {
    if (!isObject(value)) return false;
    if (!isNonEmptyString(value.taskId)) return false;
    if (!isOptionalString(value.reason)) return false;
    return true;
}

// ---------------------------------------------------------------------------
// Side-effect port for CancelAgentRun
// ---------------------------------------------------------------------------

/**
 * Adapter port for terminating a live agent run. The board-ui's
 * `CancelAgentRun` handler invokes `kill(runId)` BEFORE emitting
 * `AgentRunCancelled` so subscribers see the cancellation event only after
 * the underlying process has been signalled. Production wires this to a
 * `ClaudeCliRunner` (via a thin handle-by-id adapter); tests inject a fake
 * that records the runId it was called with.
 */
export interface AgentRunKiller {
    kill(runId: string): Promise<void> | void;
}

// ---------------------------------------------------------------------------
// Handler factory + registration
// ---------------------------------------------------------------------------

export interface BoardUiCommandDeps {
    readonly clock: () => number;
    readonly idGen: IdGen;
    readonly runner: AgentRunKiller;
    /**
     * Structured logger. Every handler emits one `info` line on entry
     * (post-validation) carrying `{type, actor, idempotencyKey}` and a
     * `warn`/`error` line on rejection (invalid payload, runner failure)
     * so the board's command stream is observable end-to-end without
     * crawling the event log. The same `Logger` port the `EventBus`
     * already uses — adapters decide transport.
     */
    readonly logger: Logger;
}

/**
 * Build a generic single-event handler. `mapPayload` converts the command
 * payload into the emitted event payload (typically by spreading + adding
 * `actor`); `idempotencyKey` is computed per-command from the validated
 * payload so duplicate dispatches de-dupe at the event store rather than
 * re-applying the mutation.
 *
 * Logging contract: an invalid payload produces a `warn` line and rejects;
 * a valid payload produces an `info` line tagged with the deterministic
 * idempotency key, then emits the event.
 */
function buildEmitter<TPayload, TEventPayload>(
    deps: BoardUiCommandDeps,
    commandType: string,
    eventType: string,
    validate: (value: unknown) => value is TPayload,
    idempotencyKey: (payload: TPayload, cmd: Command<TPayload>) => string,
    mapPayload: (payload: TPayload, cmd: Command<TPayload>) => TEventPayload,
): CommandHandler<Command<TPayload>> {
    return async (cmd): Promise<Event[]> => {
        if (!validate(cmd.payload)) {
            deps.logger.warn(`board-ui: ${commandType} rejected (invalid payload)`, {
                type: commandType,
                actor: cmd.actor,
            });
            throw new Error(`${eventType}: invalid payload`);
        }
        const key = idempotencyKey(cmd.payload, cmd);
        deps.logger.info(`board-ui: ${commandType} accepted`, {
            type: commandType,
            actor: cmd.actor,
            idempotencyKey: key,
        });
        const event: Event = {
            type: eventType,
            v: 1,
            occurredAt: deps.clock(),
            idempotencyKey: key,
            payload: mapPayload(cmd.payload, cmd),
        };
        return [event];
    };
}

/**
 * Strip `undefined` fields from a record before it lands on an event
 * payload. The event log persists payloads as JSON, and an explicit
 * `undefined` value would round-trip as a missing key anyway — but the
 * in-memory shape stays sparse this way too, which simplifies assertions
 * in tests (`'description' in payload` only when supplied).
 */
function compact<T extends Record<string, unknown>>(record: T): Partial<T> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(record)) {
        if (v !== undefined) out[k] = v;
    }
    return out as Partial<T>;
}

export function createCreateProjectHandler(
    deps: BoardUiCommandDeps,
): CommandHandler<Command<CreateProjectPayload>> {
    return async (cmd): Promise<Event[]> => {
        if (!isCreateProjectPayload(cmd.payload)) {
            deps.logger.warn(
                `board-ui: ${BoardUiCommands.CREATE_PROJECT} rejected (invalid payload)`,
                { type: BoardUiCommands.CREATE_PROJECT, actor: cmd.actor },
            );
            throw new Error('CreateProject: invalid payload');
        }
        const projectId = cmd.payload.projectId ?? deps.idGen.newId();
        const key = `${BoardUiCommands.CREATE_PROJECT}:${projectId}`;
        deps.logger.info(`board-ui: ${BoardUiCommands.CREATE_PROJECT} accepted`, {
            type: BoardUiCommands.CREATE_PROJECT,
            actor: cmd.actor,
            idempotencyKey: key,
        });
        const payload: ProjectCreatedPayload = compact({
            projectId,
            name: cmd.payload.name,
            description: cmd.payload.description,
            metadata: cmd.payload.metadata,
            actor: cmd.actor,
        }) as ProjectCreatedPayload;
        return [
            {
                type: BoardUiEvents.PROJECT_CREATED,
                v: 1,
                occurredAt: deps.clock(),
                idempotencyKey: key,
                payload,
            },
        ];
    };
}

export function createUpdateProjectHandler(
    deps: BoardUiCommandDeps,
): CommandHandler<Command<UpdateProjectPayload>> {
    return buildEmitter<UpdateProjectPayload, ProjectUpdatedPayload>(
        deps,
        BoardUiCommands.UPDATE_PROJECT,
        BoardUiEvents.PROJECT_UPDATED,
        isUpdateProjectPayload,
        (p, cmd) => `${BoardUiCommands.UPDATE_PROJECT}:${p.projectId}:${cmd.issuedAt}`,
        (p, cmd) =>
            compact({
                projectId: p.projectId,
                name: p.name,
                description: p.description,
                metadata: p.metadata,
                actor: cmd.actor,
            }) as ProjectUpdatedPayload,
    );
}

export function createUpdateProjectContextHandler(
    deps: BoardUiCommandDeps,
): CommandHandler<Command<UpdateProjectContextPayload>> {
    return buildEmitter<UpdateProjectContextPayload, UpdateProjectContextPayload>(
        deps,
        BoardUiCommands.UPDATE_PROJECT_CONTEXT,
        BoardUiEvents.PROJECT_CONTEXT_UPDATED,
        isUpdateProjectContextPayload,
        // Keyed on issuedAt, not projectId: every save is a distinct
        // decision. A per-project key would dedup the second edit of the
        // day into silence — the DecomposePlan bug, in a new place.
        (p, cmd) => `${BoardUiCommands.UPDATE_PROJECT_CONTEXT}:${p.projectId}:${cmd.issuedAt}`,
        (p) => {
            // The integrity guard lives HERE, not only on the manager-api
            // route, because the command bus is the invariant boundary:
            // `/commands/update-project-context` reaches the same handler
            // and would otherwise bypass it. Content that stops
            // mid-thought is a truncated generation or a half-finished
            // paste, and overwriting a good context with it is silent
            // damage. Empty is allowed — that is "no context".
            if (p.context.trim().length > 0) {
                const problem = findTruncation(p.context);
                if (problem) {
                    throw new Error(
                        `UpdateProjectContext: ${problem.message} (${problem.code})`,
                    );
                }
            }
            return { projectId: p.projectId, context: p.context };
        },
    );
}

export function createArchiveProjectHandler(
    deps: BoardUiCommandDeps,
): CommandHandler<Command<ArchiveProjectPayload>> {
    return buildEmitter<ArchiveProjectPayload, ProjectArchivedPayload>(
        deps,
        BoardUiCommands.ARCHIVE_PROJECT,
        BoardUiEvents.PROJECT_ARCHIVED,
        isArchiveProjectPayload,
        (p) => `${BoardUiCommands.ARCHIVE_PROJECT}:${p.projectId}`,
        (p, cmd) => ({ projectId: p.projectId, actor: cmd.actor }),
    );
}

export function createCreatePlanHandler(
    deps: BoardUiCommandDeps,
): CommandHandler<Command<CreatePlanPayload>> {
    return async (cmd): Promise<Event[]> => {
        if (!isCreatePlanPayload(cmd.payload)) {
            deps.logger.warn(
                `board-ui: ${BoardUiCommands.CREATE_PLAN} rejected (invalid payload)`,
                { type: BoardUiCommands.CREATE_PLAN, actor: cmd.actor },
            );
            throw new Error('CreatePlan: invalid payload');
        }
        const planId = cmd.payload.planId ?? deps.idGen.newId();
        const key = `${BoardUiCommands.CREATE_PLAN}:${planId}`;
        deps.logger.info(`board-ui: ${BoardUiCommands.CREATE_PLAN} accepted`, {
            type: BoardUiCommands.CREATE_PLAN,
            actor: cmd.actor,
            idempotencyKey: key,
        });
        const payload: PlanCreatedPayload = compact({
            planId,
            projectId: cmd.payload.projectId,
            title: cmd.payload.title,
            body: cmd.payload.body,
            metadata: cmd.payload.metadata,
            actor: cmd.actor,
        }) as PlanCreatedPayload;
        return [
            {
                type: BoardUiEvents.PLAN_CREATED,
                v: 1,
                occurredAt: deps.clock(),
                idempotencyKey: key,
                payload,
            },
        ];
    };
}

export function createUpdatePlanHandler(
    deps: BoardUiCommandDeps,
): CommandHandler<Command<UpdatePlanPayload>> {
    return buildEmitter<UpdatePlanPayload, PlanUpdatedPayload>(
        deps,
        BoardUiCommands.UPDATE_PLAN,
        BoardUiEvents.PLAN_UPDATED,
        isUpdatePlanPayload,
        (p, cmd) => `${BoardUiCommands.UPDATE_PLAN}:${p.planId}:${cmd.issuedAt}`,
        (p, cmd) =>
            compact({
                planId: p.planId,
                title: p.title,
                body: p.body,
                metadata: p.metadata,
                actor: cmd.actor,
            }) as PlanUpdatedPayload,
    );
}

export function createDeletePlanHandler(
    deps: BoardUiCommandDeps,
): CommandHandler<Command<DeletePlanPayload>> {
    return buildEmitter<DeletePlanPayload, PlanDeletedPayload>(
        deps,
        BoardUiCommands.DELETE_PLAN,
        BoardUiEvents.PLAN_DELETED,
        isDeletePlanPayload,
        (p) => `${BoardUiCommands.DELETE_PLAN}:${p.planId}`,
        (p, cmd) => ({ planId: p.planId, actor: cmd.actor }),
    );
}

export function createUpdateTaskHandler(
    deps: BoardUiCommandDeps,
): CommandHandler<Command<UpdateTaskPayload>> {
    return buildEmitter<UpdateTaskPayload, TaskFieldsUpdatedPayload>(
        deps,
        BoardUiCommands.EDIT_TASK,
        BoardUiEvents.TASK_FIELDS_UPDATED,
        isUpdateTaskPayload,
        (p, cmd) => `${BoardUiCommands.EDIT_TASK}:${p.taskId}:${cmd.issuedAt}`,
        (p, cmd) =>
            compact({
                taskId: p.taskId,
                title: p.title,
                description: p.description,
                type: p.type,
                flowId: p.flowId,
                actor: cmd.actor,
            }) as TaskFieldsUpdatedPayload,
    );
}

export function createDeleteTaskHandler(
    deps: BoardUiCommandDeps,
): CommandHandler<Command<DeleteTaskPayload>> {
    return buildEmitter<DeleteTaskPayload, TaskDeletedPayload>(
        deps,
        BoardUiCommands.DELETE_TASK,
        BoardUiEvents.TASK_DELETED,
        isDeleteTaskPayload,
        (p) => `${BoardUiCommands.DELETE_TASK}:${p.taskId}`,
        (p, cmd) => ({ taskId: p.taskId, actor: cmd.actor }),
    );
}

export function createCreateInvestigationHandler(
    deps: BoardUiCommandDeps,
): CommandHandler<Command<CreateInvestigationPayload>> {
    return async (cmd): Promise<Event[]> => {
        if (!isCreateInvestigationPayload(cmd.payload)) {
            deps.logger.warn(
                `board-ui: ${BoardUiCommands.CREATE_INVESTIGATION} rejected (invalid payload)`,
                { type: BoardUiCommands.CREATE_INVESTIGATION, actor: cmd.actor },
            );
            throw new Error('CreateInvestigation: invalid payload');
        }
        const investigationId = deps.idGen.newId();
        const key = `${BoardUiCommands.CREATE_INVESTIGATION}:${investigationId}`;
        deps.logger.info(`board-ui: ${BoardUiCommands.CREATE_INVESTIGATION} accepted`, {
            type: BoardUiCommands.CREATE_INVESTIGATION,
            actor: cmd.actor,
            idempotencyKey: key,
        });
        const payload: InvestigationRequestedPayload = {
            investigationId,
            taskId: cmd.payload.taskId,
            question: cmd.payload.question,
            actor: cmd.actor,
        };
        return [
            {
                type: BoardUiEvents.INVESTIGATION_REQUESTED,
                v: 1,
                occurredAt: deps.clock(),
                idempotencyKey: key,
                payload,
            },
        ];
    };
}

export function createCreateNoteHandler(
    deps: BoardUiCommandDeps,
): CommandHandler<Command<CreateNotePayload>> {
    return async (cmd): Promise<Event[]> => {
        if (!isCreateNotePayload(cmd.payload)) {
            deps.logger.warn(
                `board-ui: ${BoardUiCommands.CREATE_NOTE} rejected (invalid payload)`,
                { type: BoardUiCommands.CREATE_NOTE, actor: cmd.actor },
            );
            throw new Error('CreateNote: invalid payload');
        }
        const noteId = cmd.payload.noteId ?? deps.idGen.newId();
        const key = `${BoardUiCommands.CREATE_NOTE}:${noteId}`;
        deps.logger.info(`board-ui: ${BoardUiCommands.CREATE_NOTE} accepted`, {
            type: BoardUiCommands.CREATE_NOTE,
            actor: cmd.actor,
            idempotencyKey: key,
        });
        const payload: NoteCreatedPayload = {
            noteId,
            targetType: cmd.payload.targetType,
            targetId: cmd.payload.targetId,
            body: cmd.payload.body,
            actor: cmd.actor,
        };
        return [
            {
                type: BoardUiEvents.NOTE_CREATED,
                v: 1,
                occurredAt: deps.clock(),
                idempotencyKey: key,
                payload,
            },
        ];
    };
}

export function createUpdateNoteHandler(
    deps: BoardUiCommandDeps,
): CommandHandler<Command<UpdateNotePayload>> {
    return buildEmitter<UpdateNotePayload, NoteUpdatedPayload>(
        deps,
        BoardUiCommands.UPDATE_NOTE,
        BoardUiEvents.NOTE_UPDATED,
        isUpdateNotePayload,
        (p, cmd) => `${BoardUiCommands.UPDATE_NOTE}:${p.noteId}:${cmd.issuedAt}`,
        (p, cmd) => ({ noteId: p.noteId, body: p.body, actor: cmd.actor }),
    );
}

export function createDeleteNoteHandler(
    deps: BoardUiCommandDeps,
): CommandHandler<Command<DeleteNotePayload>> {
    return buildEmitter<DeleteNotePayload, NoteDeletedPayload>(
        deps,
        BoardUiCommands.DELETE_NOTE,
        BoardUiEvents.NOTE_DELETED,
        isDeleteNotePayload,
        (p) => `${BoardUiCommands.DELETE_NOTE}:${p.noteId}`,
        (p, cmd) => ({ noteId: p.noteId, actor: cmd.actor }),
    );
}

/**
 * `CancelAgentRun` is the only handler with an external side effect. The
 * runner is invoked BEFORE the event is emitted so subscribers observe the
 * cancellation only after the underlying process has been signalled; if
 * the runner throws, no event is published and the error propagates back
 * to the caller (the command bus stops on the first rejected publish).
 */
export function createCancelAgentRunHandler(
    deps: BoardUiCommandDeps,
): CommandHandler<Command<CancelAgentRunPayload>> {
    return async (cmd): Promise<Event[]> => {
        if (!isCancelAgentRunPayload(cmd.payload)) {
            deps.logger.warn(
                `board-ui: ${BoardUiCommands.CANCEL_AGENT_RUN} rejected (invalid payload)`,
                { type: BoardUiCommands.CANCEL_AGENT_RUN, actor: cmd.actor },
            );
            throw new Error('CancelAgentRun: invalid payload');
        }
        const { runId, reason } = cmd.payload;
        const key = `${BoardUiCommands.CANCEL_AGENT_RUN}:${runId}:${cmd.issuedAt}`;
        deps.logger.info(`board-ui: ${BoardUiCommands.CANCEL_AGENT_RUN} accepted`, {
            type: BoardUiCommands.CANCEL_AGENT_RUN,
            actor: cmd.actor,
            idempotencyKey: key,
        });
        try {
            await deps.runner.kill(runId);
        } catch (err) {
            deps.logger.error(
                `board-ui: ${BoardUiCommands.CANCEL_AGENT_RUN} runner.kill failed`,
                {
                    type: BoardUiCommands.CANCEL_AGENT_RUN,
                    actor: cmd.actor,
                    runId,
                    error: err instanceof Error ? err.message : String(err),
                },
            );
            throw err;
        }
        const payload: AgentRunCancelledPayload = compact({
            runId,
            reason,
            actor: cmd.actor,
        }) as AgentRunCancelledPayload;
        return [
            {
                type: BoardUiEvents.AGENT_RUN_CANCELLED,
                v: 1,
                occurredAt: deps.clock(),
                idempotencyKey: key,
                payload,
            },
        ];
    };
}

/**
 * Register every board-ui command handler onto the supplied bus. The
 * production orchestrator host calls this once during boot; integration
 * tests pass an isolated `CommandBus` so registrations do not collide
 * with the orchestrator's own command vocabulary (notably the lineage
 * `UpdateTask` — see the module header).
 */
export function registerBoardUiCommands(
    bus: CommandBus<unknown>,
    deps: BoardUiCommandDeps,
): void {
    bus.register<CreateProjectPayload>(
        BoardUiCommands.CREATE_PROJECT,
        createCreateProjectHandler(deps),
    );
    bus.register<UpdateProjectPayload>(
        BoardUiCommands.UPDATE_PROJECT,
        createUpdateProjectHandler(deps),
    );
    bus.register<UpdateProjectContextPayload>(
        BoardUiCommands.UPDATE_PROJECT_CONTEXT,
        createUpdateProjectContextHandler(deps),
    );
    bus.register<ArchiveProjectPayload>(
        BoardUiCommands.ARCHIVE_PROJECT,
        createArchiveProjectHandler(deps),
    );
    bus.register<CreatePlanPayload>(
        BoardUiCommands.CREATE_PLAN,
        createCreatePlanHandler(deps),
    );
    bus.register<UpdatePlanPayload>(
        BoardUiCommands.UPDATE_PLAN,
        createUpdatePlanHandler(deps),
    );
    bus.register<DeletePlanPayload>(
        BoardUiCommands.DELETE_PLAN,
        createDeletePlanHandler(deps),
    );
    bus.register<UpdateTaskPayload>(
        BoardUiCommands.EDIT_TASK,
        createUpdateTaskHandler(deps),
    );
    bus.register<DeleteTaskPayload>(
        BoardUiCommands.DELETE_TASK,
        createDeleteTaskHandler(deps),
    );
    bus.register<CreateInvestigationPayload>(
        BoardUiCommands.CREATE_INVESTIGATION,
        createCreateInvestigationHandler(deps),
    );
    bus.register<CreateNotePayload>(
        BoardUiCommands.CREATE_NOTE,
        createCreateNoteHandler(deps),
    );
    bus.register<UpdateNotePayload>(
        BoardUiCommands.UPDATE_NOTE,
        createUpdateNoteHandler(deps),
    );
    bus.register<DeleteNotePayload>(
        BoardUiCommands.DELETE_NOTE,
        createDeleteNoteHandler(deps),
    );
    bus.register<CancelAgentRunPayload>(
        BoardUiCommands.CANCEL_AGENT_RUN,
        createCancelAgentRunHandler(deps),
    );
}

/**
 * HTTP route table for the board-ui server. Each entry pairs a kebab-case
 * URL suffix with its command type + validator, so `hosts/board-ui/server.ts`
 * can wire all 13 v1-shaped POST routes from a single map without 13
 * separate `INVESTIGATION_ROUTES`-style entries.
 *
 * The route paths intentionally mirror the existing
 * `/commands/<kebab-name>` convention used by the investigation routes,
 * keeping a single URL family on the board surface.
 */
export interface BoardUiCommandRoute {
    readonly commandType: string;
    readonly validate: (payload: unknown) => boolean;
}

export const BOARD_UI_COMMAND_ROUTES: Readonly<Record<string, BoardUiCommandRoute>> = {
    '/commands/create-project': {
        commandType: BoardUiCommands.CREATE_PROJECT,
        validate: isCreateProjectPayload,
    },
    '/commands/update-project': {
        commandType: BoardUiCommands.UPDATE_PROJECT,
        validate: isUpdateProjectPayload,
    },
    '/commands/update-project-context': {
        commandType: BoardUiCommands.UPDATE_PROJECT_CONTEXT,
        validate: isUpdateProjectContextPayload,
    },
    '/commands/archive-project': {
        commandType: BoardUiCommands.ARCHIVE_PROJECT,
        validate: isArchiveProjectPayload,
    },
    '/commands/create-plan': {
        commandType: BoardUiCommands.CREATE_PLAN,
        validate: isCreatePlanPayload,
    },
    '/commands/update-plan': {
        commandType: BoardUiCommands.UPDATE_PLAN,
        validate: isUpdatePlanPayload,
    },
    '/commands/delete-plan': {
        commandType: BoardUiCommands.DELETE_PLAN,
        validate: isDeletePlanPayload,
    },
    '/commands/update-task': {
        commandType: BoardUiCommands.EDIT_TASK,
        validate: isUpdateTaskPayload,
    },
    '/commands/delete-task': {
        commandType: BoardUiCommands.DELETE_TASK,
        validate: isDeleteTaskPayload,
    },
    '/commands/create-investigation': {
        commandType: BoardUiCommands.CREATE_INVESTIGATION,
        validate: isCreateInvestigationPayload,
    },
    '/commands/create-note': {
        commandType: BoardUiCommands.CREATE_NOTE,
        validate: isCreateNotePayload,
    },
    '/commands/update-note': {
        commandType: BoardUiCommands.UPDATE_NOTE,
        validate: isUpdateNotePayload,
    },
    '/commands/delete-note': {
        commandType: BoardUiCommands.DELETE_NOTE,
        validate: isDeleteNotePayload,
    },
    '/commands/cancel-agent-run': {
        commandType: BoardUiCommands.CANCEL_AGENT_RUN,
        validate: isCancelAgentRunPayload,
    },
    '/commands/interrupt-task': {
        commandType: BoardUiCommands.INTERRUPT_TASK,
        validate: isInterruptTaskPayload,
    },
    // AP-PAO-005 — direct task / plan / project ops routes. The wire
    // symbols live in core/commands so the orchestrator host can register
    // matching handlers from the same source of truth. `DeletePlan` is
    // already routed above against `BoardUiCommands.DELETE_PLAN`, which
    // shares its wire value with `PlanOpsCommands.DELETE_PLAN`, so no new
    // entry is needed for it.
    '/commands/skip-task': {
        commandType: TaskOpsCommands.SKIP_TASK,
        validate: isSkipTaskPayload,
    },
    '/commands/retry-task': {
        commandType: TaskOpsCommands.RETRY_TASK,
        validate: isRetryTaskPayload,
    },
    '/commands/mark-task-complete': {
        commandType: TaskOpsCommands.MARK_TASK_COMPLETE,
        validate: isMarkTaskCompletePayload,
    },
    '/commands/pre-approve-task': {
        commandType: TaskOpsCommands.PRE_APPROVE_TASK,
        validate: isPreApproveTaskPayload,
    },
    '/commands/archive-plan': {
        commandType: PlanOpsCommands.ARCHIVE_PLAN,
        validate: isArchivePlanPayload,
    },
    '/commands/update-project-approval-override': {
        commandType: ProjectOpsCommands.UPDATE_PROJECT_APPROVAL_OVERRIDE,
        validate: isUpdateProjectApprovalOverridePayload,
    },
};
