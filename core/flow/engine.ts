import type { EventBus } from '../events/bus';
import type { StoredEvent } from '../events/event';
import type { CommandBus } from '../commands/bus';
import type { Command } from '../commands/command';
import type { Db } from '../state/migrations';
import type { Logger } from '../ports/Logger';
import type {
    MergeMethod,
    OpenPullRequestSpec,
    PullRequestGateway,
} from '../ports/pull-request-gateway';
import type { ScriptRunner } from '../ports/ScriptRunner';
import type { HealthPredicate, HealthProbe } from '../ports/HealthProbe';
import type { AgentRunner, AgentSpec } from '../ports/AgentRunner';
import type { FlowDefinition, FlowStep, FlowStepApproval } from './types';
import {
    isPassThroughStepKind,
    isWaitStepKind,
    FLOW_STEP_KINDS,
    BUILT_IN_APPROVAL_DEFAULTS,
} from './types';
import { evaluateApproval, UnknownStepKindError } from './approval';
import type {
    TaskParkedEventPayload,
    TaskParkedReason,
    TaskResumedEventPayload,
} from '../commands';
import { TaskParkingEvents } from '../commands';
import { ProjectRegistry, UnknownProjectError } from '../projects/registry';

/**
 * Flow engine: a named EventBus subscriber that drives task lifecycle.
 *
 * The engine consumes lifecycle events and dispatches commands:
 *
 *   TaskCreated             -> route the first step through {@link startStep}.
 *                              The per-step approval gate (defaulted from
 *                              {@link BUILT_IN_APPROVAL_DEFAULTS} or set
 *                              explicitly in YAML) is the single decider:
 *                              `'auto'` dispatches StartAgent immediately,
 *                              `'required'` parks the task with
 *                              `reason: 'approval'`. The legacy `start_mode`
 *                              field is no longer consulted here — every
 *                              first-step dispatch goes through the gate.
 *   TaskApproved            -> same code path as TaskCreated. Kept as a
 *                              backwards-compatible entry point for hosts
 *                              that emit only TaskApproved; when a prior
 *                              TaskCreated already initialised flow_state,
 *                              this is a no-op so the step is not
 *                              dispatched twice.
 *   AgentFinished           -> StartAgent (next step) OR publish emit: event
 *   AgentQuestion           -> RequestInvestigation (default) OR follow on_question
 *   InvestigationCompleted  -> StartAgent (saved resume step)
 *   TaskResumed             -> branch on `decision`. When parked at an
 *                              approval gate, `'approve'` replays the
 *                              parked step (gate bypassed); `'reject'`
 *                              routes to the step's `on_failure` or, in
 *                              its absence, emits TaskFailed with
 *                              `failed_stage: 'rejected'`.
 *
 * Persistent state lives in `flow_state` (one row per task: current_step,
 * last_event_seq). The flow identity for an active task is stored on
 * `tasks.flow_id` so the engine can resolve the FlowDefinition after a
 * restart with only a task id in hand.
 *
 * Idempotency model:
 *   - The bus's per-subscriber offset (advanced by the bus after each
 *     successful handler run) is the primary guard against re-processing
 *     on `replayMissed`.
 *   - As a secondary guard, every handler checks `flow_state.last_event_seq`
 *     and skips when it is >= the incoming event's seq.
 *   - Each handler dispatches its outgoing command first, then writes
 *     state. If the command throws, state stays put and the next replay
 *     re-tries. If state-write throws after a successful command, replay
 *     re-sends the command; downstream handlers dedupe via the events
 *     they publish (UNIQUE idempotency_key in the store).
 */

export const FLOW_ENGINE_SUBSCRIBER = 'flow-engine';
const EMIT_PREFIX = 'emit:';

/**
 * Maximum number of times an `on_failure` route may dispatch back to a
 * previously-run step before the engine bails out with a `TaskFailed`
 * terminal. Caps the dev → review → dev → review loop a stubborn
 * implementation could otherwise produce. The count is per-target
 * step, sourced from `task_step_summaries` rows.
 */
const MAX_RETRY_ATTEMPTS = 3;

/**
 * AP-VP-007: event type published when an approval-park `ResumeTask` arrives
 * with `decision: 'reject'` and the parked step has no `on_failure` target.
 * The payload is `{ taskId, failed_stage: 'rejected' }` so downstream
 * subscribers can distinguish operator rejection from other failure modes
 * without parsing a free-form reason string.
 */
const REJECTED_TASK_FAILED_EVENT = 'TaskFailed';

/**
 * Step types dispatched directly through the {@link PullRequestGateway}
 * port instead of being routed to an agent via StartAgent. The engine
 * recognises these by inspecting `FlowStep.agent` — keeping the YAML
 * schema unchanged while letting the engine treat them as plumbing
 * verbs rather than language-model invocations.
 */
export const PR_STEP_TYPES = {
    OPEN: 'pr.open',
    MERGE: 'pr.merge',
} as const;

/**
 * AP-IFG-004 / AP-IFG-005: lifecycle stage kinds used by commit-approval,
 * pr-ready, merge, and worktree-diff-review flows. The engine recognises
 * these in the `agent` field of a FlowStep (same convention as
 * {@link PR_STEP_TYPES} and the wait/pass-through kinds in `types.ts`).
 *
 * - `commit-approval` (AP-IFG-004) parks the task pending an operator
 *   action — same shape as `wait-action`, distinguished by the step
 *   `agent` so flow YAMLs can advertise intent. Resumes through
 *   `on_success` on {@link TaskParkingEvents.TASK_RESUMED}; the natural
 *   follow-up is `emit:CommitReady`.
 *
 * - `pr-ready` (AP-IFG-004) is a pass-through verb that chains
 *   synchronously to `on_success`. Flows use it to signal that commit +
 *   push has completed and the branch is ready for PR creation; the
 *   natural follow-up is `emit:PrReady`.
 *
 * - `merge-approval` (AP-IFG-005) parks the task pending the operator's
 *   approval of an open PR — same parking shape as `commit-approval`,
 *   with a distinct kind so boards/audit can render "ready to merge"
 *   intent. Resumes through `on_success` whose natural follow-up is
 *   `emit:MergeReady`; the downstream merge through the git adapter
 *   listens for that event.
 *
 * - `worktree-diff-review` (AP-IFG-005) parks the task while the operator
 *   reviews the worktree diff inline before commit (analogous to v1's
 *   `/api/worker/worktree-diff` routes). The board subscribes to the
 *   `TaskParked` event published on entry to render the diff snapshot;
 *   resume drives the flow's `on_success` target.
 *
 * - `context-update-curator` (AP-IFG-006) parks the task pending the
 *   operator's accept/reject of a CLAUDE.md diff produced by the curator
 *   agent. Same parking shape as the other lifecycle approvals; the
 *   board subscribes to the `TaskParked` event to render the diff
 *   inline. Resume drives the flow's `on_success` whose natural
 *   follow-up is `emit:ContextUpdated`, consumed by Tracks D and F.
 *
 * - `deploy-ready` (AP-IFG-006) is a pass-through verb (sibling of
 *   `pr-ready`) that chains synchronously to `on_success`. Flows use it
 *   to signal that a deploy script has finished running and the
 *   artefact is awaiting downstream verification; the natural follow-up
 *   is `emit:DeployReady`.
 */
export const LIFECYCLE_STEP_KINDS = {
    COMMIT_APPROVAL: 'commit-approval',
    PR_READY: 'pr-ready',
    MERGE_APPROVAL: 'merge-approval',
    WORKTREE_DIFF_REVIEW: 'worktree-diff-review',
    CONTEXT_UPDATE_CURATOR: 'context-update-curator',
    DEPLOY_READY: 'deploy-ready',
} as const;

export type LifecycleStepKind =
    (typeof LIFECYCLE_STEP_KINDS)[keyof typeof LIFECYCLE_STEP_KINDS];

const LIFECYCLE_PARKING_STEP_KINDS: ReadonlySet<string> = new Set([
    LIFECYCLE_STEP_KINDS.COMMIT_APPROVAL,
    LIFECYCLE_STEP_KINDS.MERGE_APPROVAL,
    LIFECYCLE_STEP_KINDS.WORKTREE_DIFF_REVIEW,
    LIFECYCLE_STEP_KINDS.CONTEXT_UPDATE_CURATOR,
]);

const LIFECYCLE_PASSTHROUGH_STEP_KINDS: ReadonlySet<string> = new Set([
    LIFECYCLE_STEP_KINDS.PR_READY,
    LIFECYCLE_STEP_KINDS.DEPLOY_READY,
]);

/**
 * True when entering this step should park the task with reason
 * `wait-action`, awaiting a `ResumeTask` from the operator. Treated
 * identically by {@link onTaskResumed}; the step `agent` discriminator
 * lets downstream subscribers render the appropriate UI.
 */
function isLifecycleParkingStepKind(agent: string): boolean {
    return LIFECYCLE_PARKING_STEP_KINDS.has(agent);
}

function isLifecyclePassThroughStepKind(agent: string): boolean {
    return LIFECYCLE_PASSTHROUGH_STEP_KINDS.has(agent);
}

export const FlowEvents = {
    /**
     * AP-IFG-002: the engine subscribes to TaskCreated so flows whose
     * `start_mode` is `'auto'` can dispatch their first agent step without
     * waiting for an operator approval. Hosts emitting `TaskCreated`
     * events on their domain-event channel (e.g. `'TaskCreated'`) are
     * expected to bridge onto this event type, the same way TaskApproved
     * is bridged to {@link FlowEvents.TASK_APPROVED}.
     */
    TASK_CREATED: 'task.created',
    TASK_APPROVED: 'task.approved',
    AGENT_FINISHED: 'agent.finished',
    AGENT_QUESTION: 'agent.question',
    INVESTIGATION_COMPLETED: 'investigation.completed',
    /**
     * AP-IFW-002: emitted whenever the engine parks a task pending a
     * `ResumeTask` command. Carries a `reason` discriminator so subscribers
     * (board, chat-bot, audit log) can render the correct UI without
     * sniffing the step graph.
     */
    TASK_PARKED: TaskParkingEvents.TASK_PARKED,
    /** AP-IFW-002: emitted by the `ResumeTask` command handler. */
    TASK_RESUMED: TaskParkingEvents.TASK_RESUMED,
    /**
     * Operator clicked Retry on a task. The engine drops any existing
     * `flow_state` for the task and re-dispatches the first step — same
     * code path as a fresh `TaskCreated`, so the approval gate fires
     * again and the operator gets a fresh Approve/Reject choice.
     */
    TASK_RETRIED: 'TaskRetried',
    /**
     * A `merge-auto` step parked in the wait-merged state. The
     * orchestrator host subscribes, waits for the post-commit hook's PR
     * to exist, then dispatches `MergeTaskPr` — merging without the
     * operator's Merge PR click. Payload: `{ taskId, stepId }`.
     */
    AUTO_MERGE_REQUESTED: 'AutoMergeRequested',
    /**
     * Task-side agent run failed (non-zero exit or runner-side error).
     * Hosts bridge raw `AgentFailed` events to this name so the engine
     * can route the step through its `on_failure` transition (or emit
     * `TaskFailed` when no on_failure is declared) without overloading
     * the success-path `AGENT_FINISHED` handler.
     */
    AGENT_FAILED: 'agent.failed',
} as const;

export const FlowCommands = {
    START_AGENT: 'agent.start',
    FINISH_TASK: 'task.finish',
    FAIL_TASK: 'task.fail',
    REQUEST_INVESTIGATION: 'investigation.request',
} as const;

/**
 * AP-IFG-004 / AP-IFG-005: lifecycle domain events emitted as the natural
 * `on_success` terminal of the corresponding lifecycle flow YAMLs
 * (commit-approval, pr-ready, merge). Track D subscribes to these to
 * drive the commit + PR-creation + branch-merge workflow.
 */
export const LifecycleEvents = {
    COMMIT_READY: 'CommitReady',
    PR_READY: 'PrReady',
    /**
     * AP-IFG-005: emitted by the `merge` flow's `on_success` after the
     * operator resumes the `merge-approval` park step. The downstream
     * git-adapter subscriber consumes this event to trigger the actual
     * branch merge.
     */
    MERGE_READY: 'MergeReady',
    /**
     * AP-IFG-006: emitted by the `context-update-curator` flow's
     * `on_success` after the operator accepts the curator agent's
     * CLAUDE.md diff. Tracks D and F subscribe to this event to apply
     * the context update downstream.
     */
    CONTEXT_UPDATED: 'ContextUpdated',
    /**
     * AP-IFG-006: emitted by the `deploy-ready` flow after the deploy
     * script has finished running. Tracks D and F subscribe to this
     * event to verify the deployed artefact.
     */
    DEPLOY_READY: 'DeployReady',
} as const;

/**
 * AP-VP-010: events the engine publishes when a `run-script` or `verify`
 * step's port call completes. The payload of each names the step it
 * originated from so subscribers can correlate without tracking
 * `current_step` themselves.
 *
 *   - `ScriptFinished` — emitted after `ScriptRunner.run` resolves. Carries
 *     the exit code and the absolute path of the stdout file the runner
 *     wrote, so subscribers (board, audit log) can render the output
 *     without re-running the script.
 *   - `VerifyFinished` — emitted after `HealthProbe.probe` resolves.
 *     Carries the boolean `ok` (the predicate's match result), so
 *     downstream subscribers don't have to re-evaluate the predicate.
 */
export const ScriptEvents = {
    SCRIPT_FINISHED: 'ScriptFinished',
    VERIFY_FINISHED: 'VerifyFinished',
} as const;

export interface ScriptFinishedEventPayload {
    readonly taskId: string;
    readonly stepId: string;
    readonly exitCode: number;
    readonly stdoutPath: string;
}

export interface VerifyFinishedEventPayload {
    readonly taskId: string;
    readonly stepId: string;
    readonly ok: boolean;
}

export interface CommitReadyEventPayload {
    readonly taskId: string;
}

export interface PrReadyEventPayload {
    readonly taskId: string;
}

/**
 * AP-IFG-006: payload of the `ContextUpdated` lifecycle event. Tracks D
 * and F subscribe to this event to apply the curator's CLAUDE.md diff
 * downstream, so the payload carries the PR number for that diff —
 * sourced from the `context-update-curator` step's `params.prNumber`,
 * with a fallback to the in-memory `openedPrNumbers` cache when an
 * earlier `pr.open` in the same flow populated it. Hosts that template
 * `context-update-curator.yaml` per task populate `prNumber` at
 * flow-registration time; the shipping YAML declares a placeholder
 * value of 0 hosts are expected to override.
 */
export interface ContextUpdatedEventPayload {
    readonly taskId: string;
    readonly prNumber: number;
}

/**
 * AP-IFG-006: payload of the `DeployReady` lifecycle event. Tracks D and
 * F subscribe to this event to verify the deployed artefact, so the
 * payload carries the two pieces of context the verifier cannot derive
 * from `taskId` alone:
 *
 *   - `deploy_kind`   — the deploy target classifier (e.g.
 *     `azure-functions`, `azure-app-service`). Sourced from the
 *     `deploy-ready` step's `params.deploy_kind`.
 *   - `deploy_target` — the named slot/environment (e.g. `staging`,
 *     `prod`). Sourced from the step's `params.deploy_target`.
 *
 * Hosts that template `deploy-ready.yaml` per task populate both at
 * flow-registration time; the shipping YAML declares placeholder empty
 * strings hosts are expected to override. Snake-case field names match
 * the convention used by Tracks D / F event consumers.
 */
export interface DeployReadyEventPayload {
    readonly taskId: string;
    readonly deploy_kind: string;
    readonly deploy_target: string;
}

/**
 * AP-IFG-005: payload of the `MergeReady` lifecycle event. The downstream
 * git-adapter subscribes to this event to merge the PR's branch in the
 * target repo, so the payload carries the two pieces of context the
 * adapter cannot derive from `taskId` alone:
 *
 *   - `prNumber` — the GitHub PR number the operator approved. Sourced by
 *     the engine from the merge-approval step's `params.prNumber`, with a
 *     fallback to the in-memory `openedPrNumbers` cache when an earlier
 *     `pr.open` in the same flow set it.
 *   - `repoPath` — the working-copy path on the worker. Sourced from the
 *     merge-approval step's `params.repoPath`. Hosts that template flow
 *     YAMLs per task populate this at flow-registration time; the
 *     shipping `config/flows/merge.yaml` declares placeholder values
 *     hosts are expected to override.
 */
export interface MergeReadyEventPayload {
    readonly taskId: string;
    readonly prNumber: number;
    readonly repoPath: string;
}

export interface TaskApprovedPayload {
    taskId: string;
    flowId: string;
}

/**
 * AP-IFG-002: minimal TaskCreated payload the engine consumes. The
 * orchestrator's domain-level `TaskCreatedPayload` carries additional
 * lineage and projection fields; the engine only needs the identifiers
 * required to resolve the flow and dispatch the first step.
 */
export interface TaskCreatedPayload {
    taskId: string;
    flowId: string;
}

export interface AgentFinishedPayload {
    taskId: string;
}

export interface AgentQuestionPayload {
    taskId: string;
    question?: string;
}

export interface InvestigationCompletedPayload {
    taskId: string;
    resumeStep?: string;
    /** Free-form text the investigator returned. Threaded into the resumed
     *  StartAgent's `context.investigationAnswer` so the parent agent can
     *  consume it. */
    answer?: string;
}

export interface StartAgentPayload {
    taskId: string;
    stepId: string;
    agent: string;
    model: string;
    /** Optional extra context for the host's AgentSpec. Currently used to
     *  thread `investigationAnswer` through to a resumed parent step. */
    context?: Record<string, unknown>;
}

export interface FinishTaskPayload {
    taskId: string;
}

export interface FailTaskPayload {
    taskId: string;
    reason: string;
}

/**
 * AP-VP7-001: payload of the `TaskFailed` event published by the flow
 * engine. The optional `finalAttempt` flag is set `true` only when a
 * task's retry budget is exhausted (`retry_count >= max_retries`) at the
 * moment the event is emitted; otherwise the field is omitted. Consumers
 * that pre-date this field MUST treat a missing flag as `false`, which
 * preserves backward compatibility with payloads emitted before the flag
 * existed (see {@link buildTaskFailedPayload}).
 */
export interface TaskFailedEventPayload {
    readonly taskId: string;
    /** Stage discriminator (e.g. `'rejected'`). Optional because some
     *  emission paths predate the discriminator. */
    readonly failed_stage?: string;
    /** True only when `retry_count >= max_retries` at emission time;
     *  omitted otherwise so downstream consumers that read a missing
     *  flag as `false` see the same shape they always did. */
    readonly finalAttempt?: boolean;
}

/**
 * AP-VP7-001: build a {@link TaskFailedEventPayload} from a base payload
 * plus the task's retry tally. Sets `finalAttempt: true` only when
 * `retryCount >= maxRetries`; omits the field otherwise so consumers
 * that pre-date the flag continue to parse the event unchanged. When
 * `retry` is `undefined`, the base payload is returned verbatim (no
 * flag set) — used by emission sites that have no retry context, such
 * as the operator-rejection terminal path, which is not the retry
 * budget terminal.
 */
export function buildTaskFailedPayload(
    base: TaskFailedEventPayload,
    retry?: { readonly retryCount: number; readonly maxRetries: number },
): TaskFailedEventPayload {
    if (retry !== undefined && retry.retryCount >= retry.maxRetries) {
        return { ...base, finalAttempt: true };
    }
    return base;
}

export interface RequestInvestigationPayload {
    taskId: string;
    resumeStep: string;
    question?: string;
}

/**
 * AP-IFG-001: a single message in a task's investigation thread. Mirrors
 * the shape v1's `pipeline/worker/orchestrator.ts` writes onto each task
 * record: an ordered list of `{role, content, timestamp}` entries that
 * grows as an investigation flow exchanges turns with the operator and
 * downstream agents.
 *
 *   - `role`      — speaker label (`'operator'`, `'investigator'`,
 *                   `'developer'`, …). Free-form so v2 can adopt new
 *                   role labels without a schema bump.
 *   - `content`   — the literal message text.
 *   - `timestamp` — epoch milliseconds. Always the time the entry was
 *                   appended, NOT the time the agent run completed.
 */
export interface InvestigationThreadEntry {
    readonly role: string;
    readonly content: string;
    readonly timestamp: number;
}

/**
 * AP-IFG-001: the lineage record persisted alongside a task by the
 * state-port write path. Every field has a documented default so a
 * legacy task without lineage loads as `{parent_task_id: null,
 * spawn_reason: null, source_investigation_id: null,
 * investigation_thread: [], followup_inflight: false}`. The projection
 * helper in `hosts/orchestrator/handlers.ts` is responsible for
 * applying those defaults at read time.
 */
export interface TaskLineage {
    readonly parent_task_id: string | null;
    readonly spawn_reason: string | null;
    readonly source_investigation_id: string | null;
    readonly investigation_thread: ReadonlyArray<InvestigationThreadEntry>;
    readonly followup_inflight: boolean;
}

/**
 * Port over the persistence surface for task lineage. The orchestrator
 * host projects `TaskCreated` events through this store so the lineage
 * fields persist alongside the task row and load back unchanged on
 * subsequent reads (AC #3 — round-trip preserves all five fields
 * verbatim).
 *
 * The port lives in `core/flow` rather than `core/ports/` because it is
 * a flow-level concern — only the orchestrator and the flow engine
 * need to read or write lineage. A SQLite-backed adapter is intentionally
 * deferred: callers that need durability today wire the in-memory
 * implementation below; callers that need cross-process durability layer
 * a migration on top in a follow-up task.
 */
export interface TaskLineageStore {
    /**
     * Persist `lineage` for `taskId`. Replaces any prior record
     * verbatim — partial updates flow through `update` instead.
     */
    write(taskId: string, lineage: TaskLineage): void;
    /**
     * Read the lineage for `taskId`. Returns `undefined` when no record
     * has been written yet (the caller is expected to fall back to the
     * defaulted projection in that case).
     */
    read(taskId: string): TaskLineage | undefined;
    /**
     * Mutate the two non-immutable lineage fields
     * (`investigation_thread`, `followup_inflight`) on an existing
     * record. Throws when no prior write exists — the caller must seed
     * the lineage via {@link write} before updating it.
     */
    update(
        taskId: string,
        patch: {
            readonly investigation_thread?: ReadonlyArray<InvestigationThreadEntry>;
            readonly followup_inflight?: boolean;
        },
    ): TaskLineage;
}

/**
 * In-memory implementation of {@link TaskLineageStore}. Used by unit
 * tests (and as the default in the orchestrator host until the SQLite
 * adapter lands). Each `write` deep-copies the thread array so callers
 * cannot mutate the stored record through their input reference.
 */
export class InMemoryTaskLineageStore implements TaskLineageStore {
    private readonly records = new Map<string, TaskLineage>();

    write(taskId: string, lineage: TaskLineage): void {
        this.records.set(taskId, freezeLineage(lineage));
    }

    read(taskId: string): TaskLineage | undefined {
        return this.records.get(taskId);
    }

    update(
        taskId: string,
        patch: {
            readonly investigation_thread?: ReadonlyArray<InvestigationThreadEntry>;
            readonly followup_inflight?: boolean;
        },
    ): TaskLineage {
        const prior = this.records.get(taskId);
        if (!prior) {
            throw new Error(
                `InMemoryTaskLineageStore.update: no record for task "${taskId}" — call write() first`,
            );
        }
        const next: TaskLineage = freezeLineage({
            parent_task_id: prior.parent_task_id,
            spawn_reason: prior.spawn_reason,
            source_investigation_id: prior.source_investigation_id,
            investigation_thread:
                patch.investigation_thread !== undefined
                    ? patch.investigation_thread
                    : prior.investigation_thread,
            followup_inflight:
                patch.followup_inflight !== undefined
                    ? patch.followup_inflight
                    : prior.followup_inflight,
        });
        this.records.set(taskId, next);
        return next;
    }
}

function freezeLineage(lineage: TaskLineage): TaskLineage {
    return {
        parent_task_id: lineage.parent_task_id,
        spawn_reason: lineage.spawn_reason,
        source_investigation_id: lineage.source_investigation_id,
        investigation_thread: lineage.investigation_thread.map((e) => ({
            role: e.role,
            content: e.content,
            timestamp: e.timestamp,
        })),
        followup_inflight: lineage.followup_inflight,
    };
}

export interface FlowEngineOptions {
    db: Db;
    logger: Logger;
    /** Source of "now" for emitted commands/events. Defaults to Date.now. */
    clock?: () => number;
    /**
     * PullRequestGateway used for gateway-dispatched step types
     * (`pr.open`, `pr.merge`). Optional — flows that never include
     * those step types can construct the engine without one. Encountering
     * a PR step without a configured gateway fails the task.
     */
    prGateway?: PullRequestGateway;
    /**
     * AP-VP-010: ScriptRunner used to dispatch `run-script` steps. Optional —
     * flows that never include a `run-script` step can construct the engine
     * without one. A `run-script` step encountered without a configured
     * runner throws at dispatch time.
     */
    scriptRunner?: ScriptRunner;
    /**
     * AP-VP-010: HealthProbe used to dispatch `verify` steps. Optional —
     * flows that never include a `verify` step can construct the engine
     * without one. A `verify` step encountered without a configured probe
     * throws at dispatch time.
     */
    healthProbe?: HealthProbe;
    /**
     * AP-VP-010: AgentRunner used to dispatch `context-update` steps with
     * `role: 'curator'`. Optional — flows that never include a
     * `context-update` step can construct the engine without one. A
     * `context-update` step encountered without a configured runner
     * throws at dispatch time. Kept distinct from the host-side StartAgent
     * pipeline so the curator role is the engine's responsibility (not the
     * host's), matching AP-VP-010's "direct port injection for the curator
     * role" decision.
     */
    agentRunner?: AgentRunner;
    /**
     * AP-IFV-001: per-project approval override registry. When supplied,
     * {@link FlowEngine.resolveApproval} reads
     * `registry.get(projectId).approvalOverride?.[flowName]` and feeds it
     * to {@link evaluateApproval} as the highest-precedence layer of the
     * `project override > flow YAML > built-in default` chain. Optional —
     * hosts that have not yet bootstrapped a ProjectRegistry (and unit
     * tests that exercise the gate without one) keep working with the
     * built-in defaults + per-step YAML values. No singleton import: the
     * engine never reaches for a module-global registry, so test doubles
     * stay ergonomic.
     */
    projectRegistry?: ProjectRegistry;
}

interface ActiveContext {
    readonly taskId: string;
    readonly flow: FlowDefinition;
    readonly step: FlowStep;
    readonly currentStep: string;
    readonly lastEventSeq: number | null;
    readonly flowId: string;
    readonly pausedStep: string | null;
    /**
     * AP-VP-007: the step id where the task is parked pending operator
     * approval. Set by {@link startStep}'s approval gate; cleared by
     * {@link onTaskResumed} on resume. Distinct from `pausedStep` (which
     * is the resume marker for AgentQuestion clarification sub-flows).
     */
    readonly parkedStepId: string | null;
}

interface FlowStateRow {
    readonly currentStep: string;
    readonly lastEventSeq: number | null;
    readonly flowId: string | null;
    readonly pausedStep: string | null;
    readonly parkedStepId: string | null;
}

export class FlowEngine {
    private readonly clock: () => number;
    private readonly unsubs: Array<() => void> = [];
    private readonly prGateway?: PullRequestGateway;
    private readonly scriptRunner?: ScriptRunner;
    private readonly healthProbe?: HealthProbe;
    private readonly agentRunner?: AgentRunner;
    private readonly projectRegistry?: ProjectRegistry;
    /**
     * In-memory cache of the most recently opened PR number per task,
     * keyed by taskId. Lets a subsequent `pr.merge` step in the same
     * flow target the PR opened by an earlier `pr.open` step without
     * round-tripping through the database. Cleared by callers that
     * complete the task; not durable across restarts (real flows
     * should specify the number explicitly via step params).
     */
    private readonly openedPrNumbers = new Map<string, number>();

    private constructor(
        private readonly eventBus: EventBus,
        private readonly commandBus: CommandBus<unknown>,
        private readonly flows: ReadonlyMap<string, FlowDefinition>,
        private readonly db: Db,
        private readonly logger: Logger,
        clock?: () => number,
        prGateway?: PullRequestGateway,
        scriptRunner?: ScriptRunner,
        healthProbe?: HealthProbe,
        agentRunner?: AgentRunner,
        projectRegistry?: ProjectRegistry,
    ) {
        this.clock = clock ?? ((): number => Date.now());
        this.prGateway = prGateway;
        this.scriptRunner = scriptRunner;
        this.healthProbe = healthProbe;
        this.agentRunner = agentRunner;
        this.projectRegistry = projectRegistry;
    }

    /**
     * Construct, attach subscribers, and return the running engine. The
     * subscriber is registered under the name `'flow-engine'` so its
     * offset is durable across restarts.
     */
    static start(
        eventBus: EventBus,
        commandBus: CommandBus<unknown>,
        flows: ReadonlyMap<string, FlowDefinition>,
        options: FlowEngineOptions,
    ): FlowEngine {
        const engine = new FlowEngine(
            eventBus,
            commandBus,
            flows,
            options.db,
            options.logger,
            options.clock,
            options.prGateway,
            options.scriptRunner,
            options.healthProbe,
            options.agentRunner,
            options.projectRegistry,
        );
        warnApprovalStepsWithoutOnFailure(flows, options.logger);
        engine.attach();
        return engine;
    }

    /** Detach every subscriber. Idempotent. */
    stop(): void {
        for (const off of this.unsubs) off();
        this.unsubs.length = 0;
    }

    private attach(): void {
        const sub = <T>(
            type: string,
            handler: (event: StoredEvent & { payload: T }) => Promise<void>,
        ): void => {
            this.unsubs.push(
                this.eventBus.subscribe<T>(type, handler, {
                    subscriber: FLOW_ENGINE_SUBSCRIBER,
                }),
            );
        };
        sub<TaskCreatedPayload>(FlowEvents.TASK_CREATED, (e) => this.onTaskCreated(e));
        sub<TaskApprovedPayload>(FlowEvents.TASK_APPROVED, (e) => this.onTaskApproved(e));
        sub<AgentFinishedPayload>(FlowEvents.AGENT_FINISHED, (e) => this.onAgentFinished(e));
        sub<AgentQuestionPayload>(FlowEvents.AGENT_QUESTION, (e) => this.onAgentQuestion(e));
        sub<InvestigationCompletedPayload>(FlowEvents.INVESTIGATION_COMPLETED, (e) =>
            this.onInvestigationCompleted(e),
        );
        sub<TaskResumedEventPayload>(FlowEvents.TASK_RESUMED, (e) => this.onTaskResumed(e));
        sub<{ readonly taskId: string }>(FlowEvents.TASK_RETRIED, (e) => this.onTaskRetried(e));
        sub<{ readonly taskId: string; readonly reason?: string }>(
            FlowEvents.AGENT_FAILED,
            (e) => this.onAgentFailed(e),
        );
    }

    // ---- event handlers ----

    /**
     * AP-VP-007: route the first step through the approval gate. The
     * legacy `start_mode` branch is gone — every first-step dispatch
     * (auto or approval-required) calls {@link startStep}, and the
     * step's resolved approval value is the only thing deciding whether
     * the StartAgent / OpenPullRequest / MergePullRequest command is
     * built immediately or the task is parked pending operator approval.
     *
     * Unknown flow ids are logged and skipped rather than failing the
     * task: TaskCreated arrives early in the lifecycle (before the
     * operator has had a chance to confirm or correct the flow id) and a
     * spurious FailTask here would race the projection of `tasks.flow_id`.
     * If the flow id is genuinely wrong, TaskApproved's existing handler
     * still fails the task.
     */
    private async onTaskCreated(
        event: StoredEvent & { payload: TaskCreatedPayload },
    ): Promise<void> {
        const { taskId, flowId } = event.payload;

        if (this.alreadyApplied(taskId, event.seq)) return;

        const flow = this.flows.get(flowId);
        if (!flow) {
            this.logger.warn(
                'flow-engine: TaskCreated for unknown flow id — deferring to TaskApproved',
                { taskId, flowId },
            );
            return;
        }

        if (this.flowStateExists(taskId)) return;

        await this.startStep(taskId, flow, flow.steps[0], event.seq, {
            flowId,
            isInitial: true,
        });
    }

    /**
     * AP-VP-007: backwards-compatible entry point for hosts that still
     * emit TaskApproved as the start-of-flow signal. The dispatch path is
     * identical to {@link onTaskCreated}: the step's approval gate
     * decides park vs. dispatch. When a prior TaskCreated already
     * initialised flow_state for this task, this handler short-circuits
     * so the first step is never dispatched twice.
     */
    private async onTaskApproved(
        event: StoredEvent & { payload: TaskApprovedPayload },
    ): Promise<void> {
        const { taskId, flowId } = event.payload;

        if (this.alreadyApplied(taskId, event.seq)) return;

        // Already running. TaskApproved is a START signal, so there is
        // nothing to do - but say so, because an operator who just
        // pressed Approve is owed an explanation, and for a long time
        // this was a bare `return`.
        //
        // Field report: approving from Telegram did not start the task.
        // Telegram sent ApproveTask for a task HELD AT THE APPROVAL
        // GATE, which needs a TaskResumed, and this short-circuit threw
        // the approval away without a single log line. The command
        // handler now routes a gate-parked task to the resume path
        // (`approvalGateParkedStep`), so reaching here with a parked
        // step means that routing was bypassed - which is worth an
        // explicit warning rather than silence.
        //
        // Checked BEFORE the unknown-flow branch on purpose: a task
        // that already has flow_state started under a flow the engine
        // accepted, so a stale `flowId` on a re-approval must not fail
        // a running task.
        if (this.flowStateExists(taskId)) {
            const ctx = this.readActive(taskId);
            if (ctx?.parkedStepId) {
                // info, not warn: the TaskCreated -> ApproveTask cascade
                // reaches here for EVERY approval-gated task, so a warning
                // would cry wolf on the normal path. The command handler is
                // what decides whether an approval may release the gate.
                this.logger.info(
                    'flow-engine: TaskApproved for a task at the approval gate'
                    + ' — ignored; the gate needs a ResumeTask decision',
                    { taskId, flowId, parkedStepId: ctx.parkedStepId },
                );
                return;
            }
            this.logger.info(
                'flow-engine: TaskApproved for a task already started — ignored',
                { taskId, flowId, currentStep: ctx?.currentStep ?? null },
            );
            return;
        }

        const flow = this.flows.get(flowId);
        if (!flow) {
            this.logger.error('flow-engine: unknown flow id — failing task', {
                taskId,
                flowId,
            });
            await this.failTask(taskId, `unknown flow id: ${flowId}`);
            return;
        }

        await this.startStep(taskId, flow, flow.steps[0], event.seq, {
            flowId,
            isInitial: true,
        });
    }

    private flowStateExists(taskId: string): boolean {
        const row = this.db
            .prepare('SELECT 1 FROM flow_state WHERE task_id = ?')
            .get(taskId);
        return row !== undefined;
    }

    private async failTask(taskId: string, reason: string): Promise<void> {
        await this.sendCommand<FailTaskPayload>(FlowCommands.FAIL_TASK, {
            taskId,
            reason,
        });
        this.db
            .prepare("UPDATE tasks SET status = 'failed' WHERE id = ?")
            .run(taskId);
    }

    private async onAgentFinished(
        event: StoredEvent & { payload: AgentFinishedPayload },
    ): Promise<void> {
        const ctx = this.readActive(event.payload.taskId);
        if (!ctx) {
            this.logger.warn('flow-engine: AgentFinished for task without flow state', {
                taskId: event.payload.taskId,
            });
            return;
        }
        if (this.isStaleSeq(ctx, event.seq)) return;

        await this.followTransition(ctx, ctx.step.on_success, event.seq);
    }

    /**
     * Bridged from raw `AgentFailed` events (the host's bridge subscribes to
     * the runner's `AgentFailed`, looks up `agentToTask[agentId]`, and
     * republishes as {@link FlowEvents.AGENT_FAILED} with the same
     * `taskId`). Mirrors {@link onAgentFinished} but routes to the step's
     * `on_failure` transition when declared, falling back to a `TaskFailed`
     * terminal so the flow doesn't stall waiting for a success signal that
     * will never come.
     *
     * Stale-seq guard is the same as the success path — a replay of the
     * same AgentFailed must not re-route twice once `flow_state` has
     * advanced past it.
     */
    private async onAgentFailed(
        event: StoredEvent & { payload: { readonly taskId: string; readonly reason?: string } },
    ): Promise<void> {
        const ctx = this.readActive(event.payload.taskId);
        if (!ctx) {
            this.logger.warn('flow-engine: AgentFailed for task without flow state', {
                taskId: event.payload.taskId,
            });
            return;
        }
        if (this.isStaleSeq(ctx, event.seq)) return;

        if (ctx.step.on_failure !== undefined) {
            // Retry-budget guard for step transitions: an on_failure
            // that points back to a previously-run agent step (e.g.
            // review → develop, test → develop) would otherwise loop
            // indefinitely on a stubborn implementation. Count how many
            // times the target step has already run and convert the
            // route into a TaskFailed terminal once the budget is hit.
            // `emit:` terminals and same-step retries are exempt — the
            // budget only applies to a step jump back to a real agent
            // step that has its own task_step_summaries row.
            const target = ctx.step.on_failure;
            if (!target.startsWith(EMIT_PREFIX) && target !== ctx.step.id) {
                const attempts = this.countCompletedStepAttempts(ctx.taskId, target);
                if (attempts >= MAX_RETRY_ATTEMPTS) {
                    this.logger.warn(
                        'flow-engine: AgentFailed retry budget exhausted; terminating task',
                        {
                            taskId: ctx.taskId,
                            failedStep: ctx.step.id,
                            target,
                            attempts,
                            maxRetries: MAX_RETRY_ATTEMPTS,
                        },
                    );
                    const exhaustedPayload: TaskFailedEventPayload = buildTaskFailedPayload(
                        { taskId: ctx.taskId, failed_stage: ctx.step.id },
                        { retryCount: attempts, maxRetries: MAX_RETRY_ATTEMPTS },
                    );
                    await this.eventBus.publish({
                        type: 'TaskFailed',
                        v: 1,
                        occurredAt: this.clock(),
                        idempotencyKey: `${FLOW_ENGINE_SUBSCRIBER}:agent-failed:${ctx.taskId}:${event.seq}`,
                        payload: exhaustedPayload,
                    });
                    this.advanceSeq(ctx.taskId, event.seq);
                    return;
                }
            }
            // Thread the failed step's transcript into the next
            // StartAgent's `context.rejectFeedback`. The developer's
            // prompt-builder folds that into the `## Feedback from
            // <role>` block of TASK.md + the prompt, so the agent
            // knows exactly why the reviewer rejected ("CHANGES
            // REQUIRED: missing null check on …") or the tester
            // failed ("TESTS FAILED: BadRequestException at line …")
            // instead of guessing from a stale description. Reads
            // straight from `task_step_summaries.summary` — written
            // by the projection-tasks subscriber when the step
            // finished — so a worker restart between failure + retry
            // still surfaces the message.
            //
            // `bypassApproval: true` because the operator already
            // approved the original run; bouncing back via on_failure
            // (review → develop, test → develop) should NOT require a
            // fresh approval click — it'd stall the chain at every
            // loop iteration. The retry-budget guard above caps the
            // loop count so a stubborn implementation still terminates.
            const failedRole = (ctx.step.agent ?? '').toString();
            const failedSummary = this.readStepSummary(ctx.taskId, ctx.step.id);
            const feedback = failedSummary && failedSummary.length > 0
                ? `${failedRole || 'agent'} failed with the following output:\n\n${failedSummary}`
                : event.payload.reason ?? `${failedRole || 'agent'} step failed`;
            await this.followTransition(ctx, ctx.step.on_failure, event.seq, {
                bypassApproval: true,
                rejectFeedback: feedback,
            });
            return;
        }

        // No on_failure declared — terminate the task. `failed_stage`
        // carries the step id so the operator board can label the
        // failure ("failed at: develop" vs "failed at: review") without
        // re-querying flow_state.
        const failedPayload: TaskFailedEventPayload = buildTaskFailedPayload({
            taskId: ctx.taskId,
            failed_stage: ctx.step.id,
        });
        await this.eventBus.publish({
            type: 'TaskFailed',
            v: 1,
            occurredAt: this.clock(),
            idempotencyKey: `${FLOW_ENGINE_SUBSCRIBER}:agent-failed:${ctx.taskId}:${event.seq}`,
            payload: failedPayload,
        });
        this.advanceSeq(ctx.taskId, event.seq);
    }

    /**
     * Count how many `task_step_summaries` rows exist for the given
     * (taskId, stepId). Used by the on_failure retry-budget guard: each
     * row corresponds to one agent run on that step, so this is the
     * total attempt count regardless of outcome. A `task_step_summaries`
     * row is created by the orchestrator's projection subscriber on
     * AgentStarted, so it captures both successful and failed past
     * runs uniformly.
     */
    /**
     * Read the joined assistant transcript the projection-tasks
     * subscriber stored for the (taskId, stepId) pair on AgentFinished.
     * Used by the on_failure routing to thread the previous step's
     * output back to the developer as actionable feedback.
     */
    private readStepSummary(taskId: string, stepId: string): string | null {
        try {
            const row = this.db
                .prepare(
                    `SELECT summary FROM task_step_summaries
                      WHERE task_id = ? AND step_id = ?`,
                )
                .get(taskId, stepId) as { summary: string | null } | undefined;
            return row?.summary ?? null;
        } catch {
            return null;
        }
    }

    private countCompletedStepAttempts(taskId: string, stepId: string): number {
        try {
            const row = this.db
                .prepare(
                    `SELECT COUNT(*) AS cnt FROM task_step_summaries
                      WHERE task_id = ? AND step_id = ?`,
                )
                .get(taskId, stepId) as { cnt: number } | undefined;
            return row?.cnt ?? 0;
        } catch (err) {
            // Migration may be absent in older test harnesses — treat
            // missing table as "no prior attempts" so the budget check
            // is non-fatal.
            this.logger.warn('flow-engine: countCompletedStepAttempts failed', {
                taskId, stepId,
                error: err instanceof Error ? err.message : String(err),
            });
            return 0;
        }
    }

    private async onAgentQuestion(
        event: StoredEvent & { payload: AgentQuestionPayload },
    ): Promise<void> {
        const ctx = this.readActive(event.payload.taskId);
        if (!ctx) {
            this.logger.warn('flow-engine: AgentQuestion for task without flow state', {
                taskId: event.payload.taskId,
            });
            return;
        }
        if (this.isStaleSeq(ctx, event.seq)) return;

        const target = ctx.step.on_question;
        if (target === undefined) {
            // Default: request an investigation sub-flow AND publish a
            // TaskParked event (reason=clarification) so the universal
            // resume path applies. Record the parent step in `paused_step`
            // so a later InvestigationCompleted / TaskResumed can resume
            // here even if the sub-flow advances `current_step` in between.
            // Sequential AgentQuestions overwrite paused_step with the same
            // value — safe.
            await this.sendCommand<RequestInvestigationPayload>(
                FlowCommands.REQUEST_INVESTIGATION,
                {
                    taskId: ctx.taskId,
                    resumeStep: ctx.step.id,
                    question: event.payload.question,
                },
            );
            await this.publishTaskParked(
                ctx.taskId,
                ctx.step.id,
                'clarification',
                event.seq,
                event.payload.question,
            );
            this.writePausedStep(ctx.taskId, ctx.step.id, event.seq);
            return;
        }
        await this.followTransition(ctx, target, event.seq);
    }

    private async onTaskResumed(
        event: StoredEvent & { payload: TaskResumedEventPayload },
    ): Promise<void> {
        const ctx = this.readActive(event.payload.taskId);
        if (!ctx) {
            this.logger.warn('flow-engine: TaskResumed for task without flow state', {
                taskId: event.payload.taskId,
            });
            return;
        }
        if (this.isStaleSeq(ctx, event.seq)) return;

        // AP-VP-007: a parked_step_id projected onto the row means the task
        // was held by the approval gate before any command was dispatched.
        // Resume branches on `decision`: 'approve' replays the step through
        // the dispatch path with the gate bypassed; 'reject' routes to the
        // step's `on_failure` or, in its absence, emits TaskFailed with
        // failed_stage='rejected'. `feedback` is persisted on tasks.feedback
        // on reject so the downstream agent run can consume it.
        if (ctx.parkedStepId !== null) {
            const parkedStep = ctx.flow.steps.find((s) => s.id === ctx.parkedStepId);
            if (!parkedStep) {
                this.logger.error('flow-engine: approval-park resume target unknown', {
                    taskId: ctx.taskId,
                    parkedStepId: ctx.parkedStepId,
                });
                return;
            }
            const decision = event.payload.decision;
            if (decision === 'reject') {
                await this.handleApprovalReject(ctx, parkedStep, event);
                return;
            }
            // Default to approve. Required decision is validated at the
            // command-handler boundary (isResumeTaskPayload), so any value
            // other than 'reject' reaching here is 'approve'.
            await this.handleApprovalApprove(ctx, parkedStep, event);
            return;
        }

        // Resume target priority: paused_step (set when AgentQuestion parked
        // a normal step) > current_step (set when a wait-* step was entered).
        const targetId = ctx.pausedStep ?? ctx.currentStep;
        const resumeStep = ctx.flow.steps.find((s) => s.id === targetId);
        if (!resumeStep) {
            this.logger.error('flow-engine: TaskResumed resume target unknown', {
                taskId: ctx.taskId,
                resumeStep: targetId,
            });
            return;
        }

        // AP-IFG-005: merge-approval resume carries a richer payload than
        // the generic `{ taskId }` shape published by followTransition's
        // emit branch. Intercept first so the downstream git-adapter
        // receives prNumber + repoPath.
        if (resumeStep.agent === LIFECYCLE_STEP_KINDS.MERGE_APPROVAL) {
            await this.emitMergeReady(ctx.taskId, resumeStep, event.seq);
            return;
        }

        // AP-IFG-006: context-update-curator resume carries the prNumber
        // of the curator's CLAUDE.md diff so Tracks D and F can locate
        // the PR downstream. Same payload-augmentation gap as merge-approval.
        if (resumeStep.agent === LIFECYCLE_STEP_KINDS.CONTEXT_UPDATE_CURATOR) {
            await this.emitContextUpdated(ctx.taskId, resumeStep, event.seq);
            return;
        }

        if (
            isWaitStepKind(resumeStep.agent) ||
            isLifecycleParkingStepKind(resumeStep.agent)
        ) {
            // wait-action / wait-merged / lifecycle parking steps
            // (commit-approval, worktree-diff-review): advance through
            // on_success — UNLESS the operator's decision was `reject`,
            // in which case follow `on_failure` so the diff-review
            // (and any other operator-gated parking step) routes back
            // through the failure branch with the rejection feedback
            // threaded onto the next StartAgent's prompt. Without this
            // branch, every Reject silently advanced through on_success
            // as if the operator had clicked Approve.
            const resumedCtx: ActiveContext = {
                ...ctx,
                step: resumeStep,
                currentStep: resumeStep.id,
            };
            const decision = event.payload.decision;
            if (decision === 'reject') {
                if (resumeStep.on_failure === undefined) {
                    // Operator rejected at a parking step that has no
                    // on_failure target. Without a route there's
                    // nothing to fold to — log + park indefinitely so
                    // the operator can investigate. Better to stall
                    // visibly than to silently advance through
                    // on_success.
                    this.logger.warn(
                        'flow-engine: ResumeTask reject at a step with no on_failure target — task stays parked',
                        {
                            taskId: ctx.taskId,
                            stepId: resumeStep.id,
                            kind: resumeStep.agent,
                        },
                    );
                    return;
                }
                const feedback = typeof event.payload.feedback === 'string'
                    ? event.payload.feedback
                    : undefined;
                // Persist to tasks.feedback, not just the next dispatch:
                // the prompt builder's fallback reads this column for
                // EVERY later step, so the reviewer/tester re-runs see
                // the operator's "# Feedback to address" block too.
                // Field incident: an operator rejected a version bump at
                // diff-review; only the developer saw the instruction,
                // and the reviewer then rejected the undo because the
                // ticket's acceptance criteria still demanded the bump.
                if (feedback !== undefined && feedback.length > 0) {
                    this.writeTaskFeedback(ctx.taskId, feedback);
                }
                await this.followTransition(
                    resumedCtx,
                    resumeStep.on_failure,
                    event.seq,
                    {
                        bypassApproval: true,
                        ...(feedback !== undefined && feedback.length > 0
                            ? { rejectFeedback: feedback }
                            : {}),
                    },
                );
                return;
            }
            await this.followTransition(resumedCtx, resumeStep.on_success, event.seq);
            return;
        }

        // Clarification case: re-issue StartAgent for the parked agent step,
        // threading the operator's answer through as `humanAnswer` context.
        const context: Record<string, unknown> = {};
        if (event.payload.answer !== undefined) {
            context.humanAnswer = event.payload.answer;
        }
        if (event.payload.optionKey !== undefined) {
            context.humanAnswerOption = event.payload.optionKey;
        }
        await this.sendStartAgent(
            ctx.taskId,
            resumeStep,
            Object.keys(context).length > 0 ? context : undefined,
        );
        this.writeResume(ctx.taskId, resumeStep.id, event.seq);
    }

    /**
     * Operator clicked Retry. Drop every trace of the previous run and
     * re-dispatch the first step exactly as if the task had just been
     * created — so the approval gate fires again, the operator gets a
     * fresh Approve/Reject decision, and the agent chain re-runs from the
     * top.
     *
     * Why drop rather than resume: `onTaskApproved` / `onTaskResumed` both
     * short-circuit when `flow_state` already exists or when the task is
     * in a parked-but-not-approval state, which is exactly the situation
     * the operator is trying to escape (a stalled or failed run). The
     * cleanest signal is "act as if this task were brand new". The task
     * row itself is left untouched — `tasks.flow_id` still drives which
     * flow we dispatch, and the projection subscriber resets the status
     * column in lockstep.
     *
     * The `TaskRetried` event idempotency key is per-issuedAt, so an
     * accidental double-click produces two events with two distinct
     * keys and this handler runs twice; that is safe — the second run
     * sees no flow_state (deleted by the first), re-creates it via
     * `startStep`, and the duplicate StartAgent command is suppressed
     * by the bus's idempotency-key UNIQUE constraint downstream.
     */
    private async onTaskRetried(
        event: StoredEvent & { payload: { readonly taskId: string } },
    ): Promise<void> {
        const { taskId } = event.payload;
        if (typeof taskId !== 'string' || taskId.length === 0) return;

        const taskRow = this.db
            .prepare('SELECT flow_id AS flowId FROM tasks WHERE id = ?')
            .get(taskId) as { flowId: string | null } | undefined;
        if (!taskRow || !taskRow.flowId) {
            this.logger.warn('flow-engine: TaskRetried for unknown task', { taskId });
            return;
        }
        const flow = this.flows.get(taskRow.flowId);
        if (!flow) {
            this.logger.error(
                'flow-engine: TaskRetried — flow id on task no longer in registry',
                { taskId, flowId: taskRow.flowId },
            );
            return;
        }

        // Wipe the prior run's flow state in a single transaction so a
        // half-applied retry can never leave a row with stale paused/
        // parked pointers. `clearParkedStepId` + the `current_step` reset
        // would otherwise have to coordinate two writes.
        this.db.prepare('DELETE FROM flow_state WHERE task_id = ?').run(taskId);

        // Re-dispatch the first step. `isInitial: true` triggers the same
        // INSERT path `onTaskCreated` uses; `bypassApproval: false` (the
        // default) ensures the approval gate runs and parks the task
        // exactly as it would on a brand-new TaskCreated.
        await this.startStep(taskId, flow, flow.steps[0], event.seq, {
            flowId: taskRow.flowId,
            isInitial: true,
        });
    }

    /**
     * AP-VP-007: approval-park resume — `decision: 'approve'`. The parked
     * step is replayed through {@link startStep} with the approval gate
     * bypassed (the operator's approval IS the gate). `parked_step_id` is
     * cleared in the same write that advances `last_event_seq` so the next
     * replay does not re-park.
     */
    private async handleApprovalApprove(
        ctx: ActiveContext,
        parkedStep: FlowStep,
        event: StoredEvent & { payload: TaskResumedEventPayload },
    ): Promise<void> {
        this.clearParkedStepId(ctx.taskId);
        await this.startStep(ctx.taskId, ctx.flow, parkedStep, event.seq, {
            flowId: ctx.flowId,
            isInitial: false,
            bypassApproval: true,
        });
    }

    /**
     * AP-VP-007 / AP-VP5-003: approval-park resume — `decision: 'reject'`.
     * Persists the operator's `feedback` (when present) on `tasks.feedback`,
     * clears `parked_step_id`, then either follows the step's `on_failure`
     * target — with `feedback` threaded onto the dispatch payload so the
     * downstream step (agent context or emit event) can consume it without a
     * second DB read — or, when no `on_failure` is declared, emits
     * `TaskFailed{ failed_stage: 'rejected' }` as the default rejection
     * terminal. The default terminal intentionally omits `feedback` from its
     * payload — feedback is already persisted to `tasks.feedback` and is
     * only threaded onto the dispatch payload when an explicit `on_failure`
     * target opts into the wider shape. A `FlowEngine.start`-time warning
     * identifies approval-required steps missing an `on_failure` so the
     * fallback path is never silent.
     */
    private async handleApprovalReject(
        ctx: ActiveContext,
        parkedStep: FlowStep,
        event: StoredEvent & { payload: TaskResumedEventPayload },
    ): Promise<void> {
        const feedback = event.payload.feedback;
        if (feedback !== undefined) {
            this.writeTaskFeedback(ctx.taskId, feedback);
        }
        this.clearParkedStepId(ctx.taskId);
        if (parkedStep.on_failure !== undefined) {
            const resumedCtx: ActiveContext = {
                ...ctx,
                step: parkedStep,
                currentStep: parkedStep.id,
                parkedStepId: null,
            };
            await this.followRejectTransition(
                resumedCtx,
                parkedStep.on_failure,
                event.seq,
                feedback,
            );
            return;
        }
        // AP-VP7-001: operator-rejection is NOT the retry-budget terminal,
        // so no retry tally is threaded in and `finalAttempt` is omitted.
        // Downstream consumers read the missing flag as `false`, preserving
        // the on-the-wire shape that pre-dated AP-VP7-001.
        const rejectedPayload: TaskFailedEventPayload = buildTaskFailedPayload({
            taskId: ctx.taskId,
            failed_stage: 'rejected',
        });
        await this.eventBus.publish({
            type: REJECTED_TASK_FAILED_EVENT,
            v: 1,
            occurredAt: this.clock(),
            idempotencyKey: `${FLOW_ENGINE_SUBSCRIBER}:reject:${ctx.taskId}:${event.seq}`,
            payload: rejectedPayload,
        });
        this.advanceSeq(ctx.taskId, event.seq);
    }

    /**
     * AP-VP5-003: variant of {@link followTransition} that threads the
     * operator's rejection `feedback` onto the dispatched payload. For
     * `emit:` terminals the feedback is appended to the event payload; for
     * a step transition the feedback is threaded onto the StartAgent
     * context (under the `rejectFeedback` key) so the downstream agent run
     * can read it without a second DB round-trip.
     */
    private async followRejectTransition(
        ctx: ActiveContext,
        target: string,
        eventSeq: number,
        feedback: string | undefined,
    ): Promise<void> {
        if (target.startsWith(EMIT_PREFIX)) {
            const eventType = target.slice(EMIT_PREFIX.length);
            const payload: { taskId: string; feedback?: string } = {
                taskId: ctx.taskId,
            };
            if (feedback !== undefined) payload.feedback = feedback;
            await this.eventBus.publish({
                type: eventType,
                v: 1,
                occurredAt: this.clock(),
                idempotencyKey: `${FLOW_ENGINE_SUBSCRIBER}:emit:${eventType}:${ctx.taskId}:${eventSeq}`,
                payload,
            });
            this.advanceSeq(ctx.taskId, eventSeq);
            this.openedPrNumbers.delete(ctx.taskId);
            return;
        }
        const nextStep = ctx.flow.steps.find((s) => s.id === target);
        if (!nextStep) {
            this.logger.error('flow-engine: missing reject-transition target', {
                taskId: ctx.taskId,
                target,
            });
            return;
        }
        // Default agent dispatch with feedback threaded onto context so the
        // downstream agent reads the operator's rationale alongside the
        // step's normal inputs. Non-agent step kinds (wait-*, pass-throughs,
        // PR gateway, run-script, verify, context-update) ignore the
        // `rejectFeedback` context — the standard startStep dispatch path
        // handles those without further hand-off.
        if (
            feedback !== undefined
            && !isWaitStepKind(nextStep.agent)
            && !isLifecycleParkingStepKind(nextStep.agent)
            && !isLifecyclePassThroughStepKind(nextStep.agent)
            && !isPassThroughStepKind(nextStep.agent)
            && !isPrStepType(nextStep.agent)
            && nextStep.agent !== FLOW_STEP_KINDS.MERGE
            && nextStep.agent !== FLOW_STEP_KINDS.RUN_SCRIPT
            && nextStep.agent !== FLOW_STEP_KINDS.VERIFY
            && nextStep.agent !== FLOW_STEP_KINDS.CONTEXT_UPDATE
        ) {
            await this.sendStartAgent(ctx.taskId, nextStep, { rejectFeedback: feedback });
            this.persistStep(ctx.taskId, ctx.flowId, nextStep.id, eventSeq, false);
            return;
        }
        await this.startStep(ctx.taskId, ctx.flow, nextStep, eventSeq, {
            flowId: ctx.flowId,
            isInitial: false,
        });
    }

    /**
     * AP-IFG-005: publish `MergeReady` (or whatever the merge-approval
     * step's `on_success` emit terminal names) with the prNumber and
     * repoPath fields the downstream git-adapter needs. Sources:
     *
     *   - `prNumber` — `step.params.prNumber` (number) with a fallback to
     *     the in-memory {@link openedPrNumbers} cache populated by an
     *     earlier `pr.open` in the same flow.
     *   - `repoPath` — `step.params.repoPath` (non-empty string).
     *
     * Either missing throws — the merge cannot proceed without both.
     */
    private async emitMergeReady(
        taskId: string,
        step: FlowStep,
        eventSeq: number,
    ): Promise<void> {
        if (!step.on_success.startsWith(EMIT_PREFIX)) {
            throw new Error(
                `flow-engine: merge-approval step "${step.id}" on_success must be an emit: terminal`,
            );
        }
        const eventType = step.on_success.slice(EMIT_PREFIX.length);
        const params = step.params ?? {};
        const prNumber = resolveMergeApprovalPrNumber(
            taskId,
            step.id,
            params,
            this.openedPrNumbers,
        );
        const repoPath = requireMergeApprovalRepoPath(step.id, params);
        const payload: MergeReadyEventPayload = { taskId, prNumber, repoPath };
        await this.eventBus.publish({
            type: eventType,
            v: 1,
            occurredAt: this.clock(),
            idempotencyKey: `${FLOW_ENGINE_SUBSCRIBER}:emit:${eventType}:${taskId}:${eventSeq}`,
            payload,
        });
        this.advanceSeq(taskId, eventSeq);
        this.openedPrNumbers.delete(taskId);
    }

    /**
     * AP-IFG-006: publish `ContextUpdated` with the curator's PR number.
     * Source priority: `step.params.prNumber` (positive finite number) >
     * the in-memory {@link openedPrNumbers} cache populated by an
     * earlier `pr.open` in the same flow. Missing both throws — Tracks D
     * and F cannot locate the CLAUDE.md PR without the number.
     */
    private async emitContextUpdated(
        taskId: string,
        step: FlowStep,
        eventSeq: number,
    ): Promise<void> {
        if (!step.on_success.startsWith(EMIT_PREFIX)) {
            throw new Error(
                `flow-engine: context-update-curator step "${step.id}" on_success must be an emit: terminal`,
            );
        }
        const eventType = step.on_success.slice(EMIT_PREFIX.length);
        const params = step.params ?? {};
        const prNumber = resolveContextUpdatedPrNumber(
            taskId,
            step.id,
            params,
            this.openedPrNumbers,
        );
        const payload: ContextUpdatedEventPayload = { taskId, prNumber };
        await this.eventBus.publish({
            type: eventType,
            v: 1,
            occurredAt: this.clock(),
            idempotencyKey: `${FLOW_ENGINE_SUBSCRIBER}:emit:${eventType}:${taskId}:${eventSeq}`,
            payload,
        });
        this.advanceSeq(taskId, eventSeq);
        this.openedPrNumbers.delete(taskId);
    }

    /**
     * AP-IFG-006: publish `DeployReady` with the deploy classifier and
     * target. Both are required step params; either missing throws so
     * downstream verification never receives an ambiguous DeployReady
     * payload.
     */
    private async emitDeployReady(
        taskId: string,
        step: FlowStep,
        eventSeq: number,
    ): Promise<void> {
        if (!step.on_success.startsWith(EMIT_PREFIX)) {
            throw new Error(
                `flow-engine: deploy-ready step "${step.id}" on_success must be an emit: terminal`,
            );
        }
        const eventType = step.on_success.slice(EMIT_PREFIX.length);
        const params = step.params ?? {};
        const deploy_kind = requireDeployReadyParam(step.id, params, 'deploy_kind');
        const deploy_target = requireDeployReadyParam(step.id, params, 'deploy_target');
        const payload: DeployReadyEventPayload = {
            taskId,
            deploy_kind,
            deploy_target,
        };
        await this.eventBus.publish({
            type: eventType,
            v: 1,
            occurredAt: this.clock(),
            idempotencyKey: `${FLOW_ENGINE_SUBSCRIBER}:emit:${eventType}:${taskId}:${eventSeq}`,
            payload,
        });
        this.advanceSeq(taskId, eventSeq);
    }

    private async publishTaskParked(
        taskId: string,
        stepId: string,
        reason: TaskParkedReason,
        eventSeq: number,
        question?: string,
        opts?: { readonly auto?: boolean },
    ): Promise<void> {
        const payload: TaskParkedEventPayload = {
            taskId,
            stepId,
            reason,
            ...(question !== undefined ? { question } : {}),
            // auto=true: this park needs NO human decision (merge-auto) -
            // notification surfaces suppress their ready-to-act message and
            // only speak up on completion or failure.
            ...(opts?.auto === true ? { auto: true } : {}),
        };
        await this.eventBus.publish({
            type: FlowEvents.TASK_PARKED,
            v: 1,
            occurredAt: this.clock(),
            idempotencyKey: `${FLOW_ENGINE_SUBSCRIBER}:parked:${taskId}:${eventSeq}`,
            payload,
        });
    }

    private async onInvestigationCompleted(
        event: StoredEvent & { payload: InvestigationCompletedPayload },
    ): Promise<void> {
        const ctx = this.readActive(event.payload.taskId);
        if (!ctx) {
            this.logger.warn(
                'flow-engine: InvestigationCompleted for task without flow state',
                { taskId: event.payload.taskId },
            );
            return;
        }
        if (this.isStaleSeq(ctx, event.seq)) return;

        // Resume target priority: explicit payload override > recorded
        // paused_step > current_step (fallback for legacy state with no
        // paused_step recorded).
        const targetId =
            event.payload.resumeStep ?? ctx.pausedStep ?? ctx.currentStep;
        const resumeStep = ctx.flow.steps.find((s) => s.id === targetId);
        if (!resumeStep) {
            this.logger.error('flow-engine: investigation resume target unknown', {
                taskId: ctx.taskId,
                resumeStep: targetId,
            });
            return;
        }

        const context =
            event.payload.answer !== undefined
                ? { investigationAnswer: event.payload.answer }
                : undefined;
        await this.sendStartAgent(ctx.taskId, resumeStep, context);
        this.writeResume(ctx.taskId, resumeStep.id, event.seq);
    }

    // ---- transitions ----

    private async followTransition(
        ctx: ActiveContext,
        target: string,
        eventSeq: number,
        opts: { bypassApproval?: boolean; rejectFeedback?: string } = {},
    ): Promise<void> {
        if (target.startsWith(EMIT_PREFIX)) {
            const eventType = target.slice(EMIT_PREFIX.length);
            await this.eventBus.publish({
                type: eventType,
                v: 1,
                occurredAt: this.clock(),
                idempotencyKey: `${FLOW_ENGINE_SUBSCRIBER}:emit:${eventType}:${ctx.taskId}:${eventSeq}`,
                payload: { taskId: ctx.taskId },
            });
            this.advanceSeq(ctx.taskId, eventSeq);
            this.openedPrNumbers.delete(ctx.taskId);
            return;
        }
        const nextStep = ctx.flow.steps.find((s) => s.id === target);
        if (!nextStep) {
            // The loader rejects this at load time; guard defensively in case
            // the flow map drifts under us.
            this.logger.error('flow-engine: missing transition target', {
                taskId: ctx.taskId,
                target,
            });
            return;
        }
        await this.startStep(ctx.taskId, ctx.flow, nextStep, eventSeq, {
            flowId: ctx.flowId,
            isInitial: false,
            ...(opts.bypassApproval ? { bypassApproval: true } : {}),
            ...(opts.rejectFeedback !== undefined
                ? { rejectFeedback: opts.rejectFeedback }
                : {}),
        });
    }

    /**
     * Begin executing `step`. Agent steps emit a StartAgent command and
     * persist `current_step`. Gateway-dispatched steps (`pr.open`,
     * `pr.merge`) call the {@link PullRequestGateway} synchronously,
     * persist the step as current, then chain straight into the
     * step's `on_success` target — there is no AgentFinished event to
     * wait for.
     */
    private async startStep(
        taskId: string,
        flow: FlowDefinition,
        step: FlowStep,
        eventSeq: number,
        opts: {
            flowId: string;
            isInitial: boolean;
            bypassApproval?: boolean;
            /**
             * Forwarded to the StartAgent command's `context` so the
             * downstream task-agent prompt-builder can fold it into
             * `## Feedback from <role>` in TASK.md + the prompt. Used
             * by the on_failure routing to thread the failing step's
             * full output (CHANGES REQUIRED:… / TESTS FAILED:…) back
             * into the developer's next prompt — without it the dev
             * agent re-runs blind to what broke last time.
             */
            rejectFeedback?: string;
        },
    ): Promise<void> {
        // Non-command step kinds keep their existing parking / pass-through
        // semantics: the approval gate guards command construction, not the
        // wait-* / lifecycle / pass-through verbs which never build one.

        // wait-action / wait-merged / merge-auto: park with the existing
        // reason discriminator. merge-auto parks in the SAME wait-merged
        // state (board + Telegram + manual Merge PR all keep working), and
        // additionally publishes AutoMergeRequested — the orchestrator's
        // subscriber waits for the post-commit hook's PR and dispatches
        // MergeTaskPr, which resumes this park exactly like an operator
        // click would.
        if (isWaitStepKind(step.agent)) {
            this.persistStep(taskId, opts.flowId, step.id, eventSeq, opts.isInitial);
            const reason: TaskParkedReason =
                step.agent === FLOW_STEP_KINDS.WAIT_MERGED
                    || step.agent === FLOW_STEP_KINDS.MERGE_AUTO
                    ? 'wait-merged'
                    : 'wait-action';
            await this.publishTaskParked(taskId, step.id, reason, eventSeq, undefined, {
                auto: step.agent === FLOW_STEP_KINDS.MERGE_AUTO,
            });
            if (step.agent === FLOW_STEP_KINDS.MERGE_AUTO) {
                await this.eventBus.publish({
                    type: FlowEvents.AUTO_MERGE_REQUESTED,
                    v: 1,
                    occurredAt: this.clock(),
                    idempotencyKey: `${FLOW_ENGINE_SUBSCRIBER}:auto-merge:${taskId}:${eventSeq}`,
                    payload: { taskId, stepId: step.id },
                });
            }
            return;
        }

        // AP-IFG-004 / AP-IFG-005: operator-gated lifecycle parking steps —
        // commit-approval, merge-approval, worktree-diff-review,
        // context-update-curator. They have their own parking semantics so the
        // generic approval gate stays out of the way.
        if (isLifecycleParkingStepKind(step.agent)) {
            this.logger.info('flow-engine: lifecycle parking step', {
                taskId,
                stepId: step.id,
                kind: step.agent,
            });
            this.persistStep(taskId, opts.flowId, step.id, eventSeq, opts.isInitial);
            // `worktree-diff-review` carries a dedicated reason so the
            // board renders the diff-review modal instead of the
            // generic wait-action card; the rest of the lifecycle
            // parking steps share `wait-action` since they don't yet
            // have a bespoke UI.
            const reason: TaskParkedReason =
                step.agent === LIFECYCLE_STEP_KINDS.WORKTREE_DIFF_REVIEW
                    ? 'worktree-diff-review'
                    : 'wait-action';
            await this.publishTaskParked(taskId, step.id, reason, eventSeq);
            return;
        }

        // AP-IFG-004 / AP-IFG-006: lifecycle pass-throughs — pr-ready,
        // deploy-ready. Chain synchronously to on_success.
        if (isLifecyclePassThroughStepKind(step.agent)) {
            this.logger.info('flow-engine: lifecycle pass-through step', {
                taskId,
                stepId: step.id,
                kind: step.agent,
            });
            this.persistStep(taskId, opts.flowId, step.id, eventSeq, opts.isInitial);
            if (step.agent === LIFECYCLE_STEP_KINDS.DEPLOY_READY) {
                await this.emitDeployReady(taskId, step, eventSeq);
                return;
            }
            const ctx: ActiveContext = {
                taskId,
                flow,
                step,
                currentStep: step.id,
                lastEventSeq: eventSeq,
                flowId: opts.flowId,
                pausedStep: null,
                parkedStepId: null,
            };
            await this.followTransition(ctx, step.on_success, eventSeq);
            return;
        }

        // Pass-through verbs (run-script, verify, report-only, context-update).
        if (isPassThroughStepKind(step.agent)) {
            this.logger.info('flow-engine: pass-through step', {
                taskId,
                stepId: step.id,
                kind: step.agent,
            });
            this.persistStep(taskId, opts.flowId, step.id, eventSeq, opts.isInitial);
            const ctx: ActiveContext = {
                taskId,
                flow,
                step,
                currentStep: step.id,
                lastEventSeq: eventSeq,
                flowId: opts.flowId,
                pausedStep: null,
                parkedStepId: null,
            };
            await this.followTransition(ctx, step.on_success, eventSeq);
            return;
        }

        // AP-VP-007: command-producing dispatch. Every step that resolves into
        // a StartAgent / OpenPullRequest / MergePullRequest command passes
        // through the approval gate first. When the gate returns 'required'
        // we park the task at this step pending a ResumeTask. First-step
        // entry from TaskCreated / TaskApproved lands here too: the legacy
        // start_mode field is no longer consulted by the engine — the
        // resolved approval value for `steps[0]` is the single decider for
        // park vs. dispatch on TaskCreated.
        if (!opts.bypassApproval) {
            const approval = this.resolveApproval(step, opts.flowId, taskId);
            if (approval === 'required') {
                this.logger.info('flow-engine: approval gate parked step', {
                    taskId,
                    stepId: step.id,
                    agent: step.agent,
                });
                this.persistStep(taskId, opts.flowId, step.id, eventSeq, opts.isInitial);
                this.writeParkedStepId(taskId, step.id);
                await this.publishTaskParked(taskId, step.id, 'approval', eventSeq);
                return;
            }
        }

        // PR-gateway steps (pr.open, pr.merge) + the `merge` alias.
        if (isPrStepType(step.agent) || step.agent === FLOW_STEP_KINDS.MERGE) {
            await this.dispatchPrStep(taskId, step);
            this.persistStep(taskId, opts.flowId, step.id, eventSeq, opts.isInitial);
            const ctx: ActiveContext = {
                taskId,
                flow,
                step,
                currentStep: step.id,
                lastEventSeq: eventSeq,
                flowId: opts.flowId,
                pausedStep: null,
                parkedStepId: null,
            };
            await this.followTransition(ctx, step.on_success, eventSeq);
            return;
        }

        // AP-VP-010: run-script — invoke the ScriptRunner port, publish
        // ScriptFinished, route by exit code (0 → on_success, else
        // on_failure when declared otherwise on_success).
        if (step.agent === FLOW_STEP_KINDS.RUN_SCRIPT) {
            await this.dispatchRunScript(taskId, flow, step, eventSeq, opts);
            return;
        }

        // AP-VP-010: verify — invoke the HealthProbe port, publish
        // VerifyFinished, route by `ok`.
        if (step.agent === FLOW_STEP_KINDS.VERIFY) {
            await this.dispatchVerify(taskId, flow, step, eventSeq, opts);
            return;
        }

        // AP-VP-010: context-update — spawn the curator agent via the
        // AgentRunner port. The runner's AgentFinished event routes via
        // the existing handler; on_failure is reached when a host-side
        // bridge translates an AgentFailed into the engine's failure path.
        if (step.agent === FLOW_STEP_KINDS.CONTEXT_UPDATE) {
            await this.dispatchContextUpdate(taskId, step, eventSeq, opts);
            return;
        }

        // Default: agent step — dispatch StartAgent.
        const ctxForAgent: Record<string, unknown> | undefined
            = opts.rejectFeedback !== undefined
                ? { rejectFeedback: opts.rejectFeedback }
                : undefined;
        await this.sendStartAgent(taskId, step, ctxForAgent);
        this.persistStep(taskId, opts.flowId, step.id, eventSeq, opts.isInitial);
    }

    /**
     * AP-VP-010: run-script dispatch. Invokes {@link ScriptRunner.run}
     * with the script path, args, cwd, and env sourced from `step.params`,
     * then publishes {@link ScriptEvents.SCRIPT_FINISHED} and routes the
     * flow on exit code: `0` follows `on_success`; any other exit code
     * follows `on_failure` when declared, falling back to `on_success`
     * (mirroring the existing convention used by other transition-by-
     * outcome dispatches when `on_failure` is omitted).
     */
    private async dispatchRunScript(
        taskId: string,
        flow: FlowDefinition,
        step: FlowStep,
        eventSeq: number,
        opts: { flowId: string; isInitial: boolean },
    ): Promise<void> {
        if (!this.scriptRunner) {
            throw new Error(
                `flow-engine: run-script step "${step.id}" requires a ScriptRunner, none configured`,
            );
        }
        const params = step.params ?? {};
        const scriptPath = requireParamString(step.id, 'run-script', params, 'scriptPath');
        const cwd = requireParamString(step.id, 'run-script', params, 'cwd');
        const args = parseStringArrayParam(step.id, 'run-script', params, 'args');
        const env = parseStringRecordParam(step.id, 'run-script', params, 'env');

        this.persistStep(taskId, opts.flowId, step.id, eventSeq, opts.isInitial);
        const result = await this.scriptRunner.run(scriptPath, args, cwd, env);
        await this.eventBus.publish({
            type: ScriptEvents.SCRIPT_FINISHED,
            v: 1,
            occurredAt: this.clock(),
            idempotencyKey: `${FLOW_ENGINE_SUBSCRIBER}:script-finished:${taskId}:${eventSeq}`,
            payload: {
                taskId,
                stepId: step.id,
                exitCode: result.exitCode,
                stdoutPath: result.stdoutPath,
            } satisfies ScriptFinishedEventPayload,
        });

        const target = result.exitCode === 0
            ? step.on_success
            : (step.on_failure ?? step.on_success);
        const ctx: ActiveContext = {
            taskId,
            flow,
            step,
            currentStep: step.id,
            lastEventSeq: eventSeq,
            flowId: opts.flowId,
            pausedStep: null,
            parkedStepId: null,
        };
        await this.followTransition(ctx, target, eventSeq);
    }

    /**
     * AP-VP-010: verify dispatch. Invokes {@link HealthProbe.probe} with
     * the url + predicate sourced from `step.params`, publishes
     * {@link ScriptEvents.VERIFY_FINISHED} carrying the boolean `ok`, and
     * routes the flow: `ok === true` follows `on_success`; otherwise
     * `on_failure` when declared, falling back to `on_success`.
     */
    private async dispatchVerify(
        taskId: string,
        flow: FlowDefinition,
        step: FlowStep,
        eventSeq: number,
        opts: { flowId: string; isInitial: boolean },
    ): Promise<void> {
        if (!this.healthProbe) {
            throw new Error(
                `flow-engine: verify step "${step.id}" requires a HealthProbe, none configured`,
            );
        }
        const params = step.params ?? {};
        const url = requireParamString(step.id, 'verify', params, 'url');
        const predicate = parseHealthPredicate(step.id, params);

        this.persistStep(taskId, opts.flowId, step.id, eventSeq, opts.isInitial);
        const result = await this.healthProbe.probe(url, predicate);
        await this.eventBus.publish({
            type: ScriptEvents.VERIFY_FINISHED,
            v: 1,
            occurredAt: this.clock(),
            idempotencyKey: `${FLOW_ENGINE_SUBSCRIBER}:verify-finished:${taskId}:${eventSeq}`,
            payload: {
                taskId,
                stepId: step.id,
                ok: result.ok,
            } satisfies VerifyFinishedEventPayload,
        });

        const target = result.ok
            ? step.on_success
            : (step.on_failure ?? step.on_success);
        const ctx: ActiveContext = {
            taskId,
            flow,
            step,
            currentStep: step.id,
            lastEventSeq: eventSeq,
            flowId: opts.flowId,
            pausedStep: null,
            parkedStepId: null,
        };
        await this.followTransition(ctx, target, eventSeq);
    }

    /**
     * AP-VP-010: context-update dispatch. Spawns the curator agent via
     * {@link AgentRunner.start} (role hard-coded to `'curator'`) using
     * the prompt + cwd sourced from `step.params`. The runner publishes
     * its own AgentFinished / AgentFailed lifecycle events; the engine's
     * existing {@link onAgentFinished} handler routes via `on_success`
     * when AgentFinished arrives for this task. Failure routing
     * (`on_failure`) is handled out of band — the host-side bridge that
     * translates the runner's `AgentFailed` into the engine's failure
     * channel is responsible for it.
     */
    private async dispatchContextUpdate(
        taskId: string,
        step: FlowStep,
        eventSeq: number,
        opts: { flowId: string; isInitial: boolean },
    ): Promise<void> {
        if (!this.agentRunner) {
            throw new Error(
                `flow-engine: context-update step "${step.id}" requires an AgentRunner, none configured`,
            );
        }
        const params = step.params ?? {};
        const prompt = requireParamString(step.id, 'context-update', params, 'prompt');
        const cwdRaw = params['cwd'];
        if (cwdRaw !== undefined && (typeof cwdRaw !== 'string' || cwdRaw.length === 0)) {
            throw new Error(
                `flow-engine: context-update step "${step.id}" param "cwd" must be a non-empty string when set`,
            );
        }
        const spec: AgentSpec = cwdRaw === undefined
            ? { role: 'curator', prompt }
            : { role: 'curator', prompt, cwd: cwdRaw };

        this.persistStep(taskId, opts.flowId, step.id, eventSeq, opts.isInitial);
        this.agentRunner.start(spec);
    }

    /**
     * AP-VP-007 / AP-IFV-001: resolve the effective approval gate value
     * for a step. Wraps {@link evaluateApproval} so that an agent step
     * whose `agent` value (developer, reviewer, …) is not present in the
     * defaults table falls back to `'auto'` — the defaults table is keyed
     * on the closed union of non-agent step kinds, so a missing entry
     * signals an agent step rather than a misconfigured one.
     *
     * The highest-precedence layer of the resolution chain is the active
     * project's per-flow override map at
     * `projectRegistry.get(projectId).approvalOverride?.[flowName]`. When
     * the registry is injected and a matching project + flow are found,
     * the map is passed as `projectOverrides` to {@link evaluateApproval};
     * otherwise the call falls through to the step's YAML `approval`
     * field and finally the built-in defaults. A missing project, missing
     * flow entry, or a missing registry is treated as "no override" — the
     * gate must never harden a step that the YAML/defaults call `'auto'`
     * just because the project file omits the override block.
     */
    private resolveApproval(
        step: FlowStep,
        flowName: string,
        taskId: string,
    ): FlowStepApproval {
        const projectOverrides = this.lookupProjectOverrides(taskId, flowName);
        let resolved: FlowStepApproval;
        try {
            resolved = evaluateApproval(
                step,
                projectOverrides,
                BUILT_IN_APPROVAL_DEFAULTS,
            );
        } catch (err) {
            if (err instanceof UnknownStepKindError) return 'auto';
            throw err;
        }
        // Pre-approval: the operator approved this task while it was
        // parked on dependencies, opting into auto-start once the
        // upstreams merge. When the unblock pass re-dispatches the task,
        // this consumes the flag so the gate that would otherwise park
        // at 'approval' runs straight away. One-shot — only consumed
        // when the step would actually have required approval, and
        // cleared on use so a subsequent retry re-prompts.
        if (resolved === 'required' && this.consumePreApproved(taskId)) {
            return 'auto';
        }
        return resolved;
    }

    /**
     * Atomically read-and-clear the task's `pre_approved` flag. Returns
     * true when the task was pre-approved (and clears it so the
     * approval is single-use). Best-effort: a missing column / row
     * returns false rather than throwing, so flows on a DB that predates
     * migration 020 still resolve approval normally.
     */
    private consumePreApproved(taskId: string): boolean {
        try {
            const row = this.db
                .prepare('SELECT pre_approved FROM tasks WHERE id = ?')
                .get(taskId) as { pre_approved?: number } | undefined;
            if (!row || !row.pre_approved) return false;
            this.db
                .prepare('UPDATE tasks SET pre_approved = 0 WHERE id = ?')
                .run(taskId);
            this.logger.info('flow-engine: consumed pre-approval', { taskId });
            return true;
        } catch {
            return false;
        }
    }

    /**
     * AP-IFV-001: resolve the project override map for `(taskId, flowName)`.
     *
     * Returns `undefined` (the "no overrides supplied" sentinel
     * {@link evaluateApproval} understands) when any link in the chain is
     * missing: no registry injected, no `tasks.plan_id` → `plans.project_id`
     * row, the project not registered, the project's `approvalOverride`
     * field absent, or the flow not represented in the override block. The
     * `'default'` literal (a legal {@link ApprovalOverrideValue}) is also
     * filtered out at the step level so it falls through to the YAML /
     * built-in default exactly like a missing override entry.
     *
     * `'default'` is not a member of {@link FlowStepApproval}, so when an
     * operator writes `'default'` for a step we strip it here rather than
     * leaking it into evaluateApproval (which would treat it as a literal
     * override value).
     */
    private lookupProjectOverrides(
        taskId: string,
        flowName: string,
    ): Record<string, FlowStepApproval> | undefined {
        if (!this.projectRegistry) return undefined;
        const projectId = this.fetchProjectId(taskId);
        if (projectId === undefined) return undefined;
        let project;
        try {
            project = this.projectRegistry.get(projectId);
        } catch (err) {
            if (err instanceof UnknownProjectError) return undefined;
            throw err;
        }
        const flowOverrides = project.approvalOverride?.[flowName];
        if (flowOverrides === undefined) return undefined;
        const filtered: Record<string, FlowStepApproval> = {};
        for (const [stepId, value] of Object.entries(flowOverrides)) {
            if (value === 'auto' || value === 'required') {
                filtered[stepId] = value;
            }
            // 'default' (and any other unexpected value) intentionally
            // falls through so evaluateApproval consults step.approval
            // then the built-in default for that step kind.
        }
        return filtered;
    }

    /**
     * AP-IFV-001: resolve the project id for a task by joining
     * `tasks.plan_id` against `plans.project_id`. Returns `undefined`
     * when no such row exists — callers treat that as "no overrides
     * available" so unit tests that seed only a `tasks` row (no `plans`
     * companion) keep working.
     */
    private fetchProjectId(taskId: string): string | undefined {
        const row = this.db
            .prepare(
                `SELECT p.project_id AS projectId
                 FROM tasks t
                 INNER JOIN plans p ON p.id = t.plan_id
                 WHERE t.id = ?`,
            )
            .get(taskId) as { projectId: string } | undefined;
        return row?.projectId;
    }

    private persistStep(
        taskId: string,
        flowId: string,
        stepId: string,
        eventSeq: number,
        isInitial: boolean,
    ): void {
        if (isInitial) this.writeInitialState(taskId, flowId, stepId, eventSeq);
        else this.writeStep(taskId, stepId, eventSeq);
    }

    private async dispatchPrStep(taskId: string, step: FlowStep): Promise<void> {
        if (!this.prGateway) {
            throw new Error(
                `flow-engine: step "${step.id}" (type ${step.agent}) requires a PullRequestGateway, none configured`,
            );
        }
        const params = step.params ?? {};
        if (step.agent === PR_STEP_TYPES.OPEN) {
            const spec = parseOpenSpec(step.id, params);
            const result = await this.prGateway.openPullRequest(spec);
            this.openedPrNumbers.set(taskId, result.number);
            return;
        }
        if (
            step.agent === PR_STEP_TYPES.MERGE ||
            step.agent === FLOW_STEP_KINDS.MERGE
        ) {
            const number = resolveMergeNumber(
                taskId,
                step.id,
                params,
                this.openedPrNumbers,
            );
            const method = parseMergeMethod(step.id, params);
            await this.prGateway.mergePullRequest(number, { method });
            return;
        }
        // isPrStepType keeps this branch unreachable; defensive.
        throw new Error(`flow-engine: unhandled pr step type "${step.agent}"`);
    }

    private async sendStartAgent(
        taskId: string,
        step: FlowStep,
        context?: Record<string, unknown>,
    ): Promise<void> {
        const payload: StartAgentPayload = {
            taskId,
            stepId: step.id,
            agent: step.agent,
            model: step.model,
        };
        if (context !== undefined) payload.context = context;
        await this.sendCommand<StartAgentPayload>(FlowCommands.START_AGENT, payload);
    }

    private async sendCommand<TPayload>(type: string, payload: TPayload): Promise<void> {
        const command: Command<TPayload> = {
            type,
            actor: FLOW_ENGINE_SUBSCRIBER,
            issuedAt: this.clock(),
            payload,
        };
        await this.commandBus.send(command);
    }

    // ---- persistence ----

    private alreadyApplied(taskId: string, eventSeq: number): boolean {
        const row = this.db
            .prepare('SELECT last_event_seq FROM flow_state WHERE task_id = ?')
            .get(taskId) as { last_event_seq: number | null } | undefined;
        if (!row || row.last_event_seq === null) return false;
        return row.last_event_seq >= eventSeq;
    }

    private isStaleSeq(ctx: ActiveContext, eventSeq: number): boolean {
        return ctx.lastEventSeq !== null && ctx.lastEventSeq >= eventSeq;
    }

    private readActive(taskId: string): ActiveContext | undefined {
        const row = this.fetchFlowStateRow(taskId);
        if (!row || !row.flowId) return undefined;
        return this.buildActiveContext(taskId, {
            currentStep: row.currentStep,
            lastEventSeq: row.lastEventSeq,
            flowId: row.flowId,
            pausedStep: row.pausedStep,
            parkedStepId: row.parkedStepId,
        });
    }

    private fetchFlowStateRow(taskId: string): FlowStateRow | undefined {
        return this.db
            .prepare(
                `SELECT fs.current_step   AS currentStep,
                        fs.last_event_seq AS lastEventSeq,
                        fs.paused_step    AS pausedStep,
                        fs.parked_step_id AS parkedStepId,
                        t.flow_id         AS flowId
                 FROM flow_state fs
                 INNER JOIN tasks t ON t.id = fs.task_id
                 WHERE fs.task_id = ?`,
            )
            .get(taskId) as FlowStateRow | undefined;
    }

    private buildActiveContext(
        taskId: string,
        row: {
            currentStep: string;
            lastEventSeq: number | null;
            flowId: string;
            pausedStep: string | null;
            parkedStepId: string | null;
        },
    ): ActiveContext | undefined {
        const flow = this.flows.get(row.flowId);
        if (!flow) {
            this.logger.error('flow-engine: flow id on task no longer in registry', {
                taskId,
                flowId: row.flowId,
            });
            return undefined;
        }
        const step = flow.steps.find((s) => s.id === row.currentStep);
        if (!step) {
            this.logger.error('flow-engine: current_step missing from flow', {
                taskId,
                currentStep: row.currentStep,
                flowId: row.flowId,
            });
            return undefined;
        }
        return { taskId, flow, step, ...row };
    }

    private writeInitialState(
        taskId: string,
        flowId: string,
        stepId: string,
        eventSeq: number,
    ): void {
        const tx = this.db.transaction(() => {
            this.db
                .prepare('UPDATE tasks SET flow_id = ? WHERE id = ?')
                .run(flowId, taskId);
            this.db
                .prepare(
                    `INSERT INTO flow_state(task_id, current_step, last_event_seq)
                     VALUES (?, ?, ?)
                     ON CONFLICT(task_id) DO UPDATE SET
                         current_step   = excluded.current_step,
                         last_event_seq = excluded.last_event_seq
                     WHERE excluded.last_event_seq > IFNULL(flow_state.last_event_seq, -1)`,
                )
                .run(taskId, stepId, eventSeq);
        });
        tx();
    }

    private writeStep(taskId: string, stepId: string, eventSeq: number): void {
        this.db
            .prepare(
                `UPDATE flow_state
                 SET current_step = ?, last_event_seq = ?
                 WHERE task_id = ?
                   AND (last_event_seq IS NULL OR last_event_seq < ?)`,
            )
            .run(stepId, eventSeq, taskId, eventSeq);
    }

    private advanceSeq(taskId: string, eventSeq: number): void {
        this.db
            .prepare(
                `UPDATE flow_state
                 SET last_event_seq = ?
                 WHERE task_id = ?
                   AND (last_event_seq IS NULL OR last_event_seq < ?)`,
            )
            .run(eventSeq, taskId, eventSeq);
    }

    private writeResume(taskId: string, stepId: string, eventSeq: number): void {
        this.db
            .prepare(
                `UPDATE flow_state
                 SET current_step   = ?,
                     last_event_seq = ?,
                     paused_step    = NULL
                 WHERE task_id = ?
                   AND (last_event_seq IS NULL OR last_event_seq < ?)`,
            )
            .run(stepId, eventSeq, taskId, eventSeq);
    }

    private writePausedStep(taskId: string, stepId: string, eventSeq: number): void {
        this.db
            .prepare(
                `UPDATE flow_state
                 SET paused_step    = ?,
                     last_event_seq = ?
                 WHERE task_id = ?
                   AND (last_event_seq IS NULL OR last_event_seq < ?)`,
            )
            .run(stepId, eventSeq, taskId, eventSeq);
    }

    /**
     * AP-VP-007: persist the parked step id when the approval gate fires.
     * The seq advance is owned by the preceding {@link persistStep}; this
     * helper only writes `parked_step_id` so a replay re-running the same
     * handler is a no-op (the value is already correct or the row's seq
     * has already advanced past the handler's event).
     */
    private writeParkedStepId(taskId: string, stepId: string): void {
        this.db
            .prepare(
                `UPDATE flow_state
                 SET parked_step_id = ?
                 WHERE task_id = ?`,
            )
            .run(stepId, taskId);
    }

    /**
     * AP-VP-007: clear `parked_step_id` when the operator resumes an
     * approval park (approve or reject). The seq advance is owned by the
     * dispatch that follows ({@link persistStep} on approve, the emit:
     * publish + {@link advanceSeq} on reject without on_failure) so this
     * helper only clears the marker.
     */
    private clearParkedStepId(taskId: string): void {
        this.db
            .prepare(
                'UPDATE flow_state SET parked_step_id = NULL WHERE task_id = ?',
            )
            .run(taskId);
    }

    /**
     * AP-VP-007: persist operator feedback on a rejected approval park.
     * Lives on `tasks.feedback` so the value survives flow_state resets and
     * is scoped to the task lifetime.
     */
    private writeTaskFeedback(taskId: string, feedback: string): void {
        this.db
            .prepare('UPDATE tasks SET feedback = ? WHERE id = ?')
            .run(feedback, taskId);
    }
}

// ---------------------------------------------------------------------------
// PR-step helpers
// ---------------------------------------------------------------------------

function isPrStepType(agent: string): boolean {
    return agent === PR_STEP_TYPES.OPEN || agent === PR_STEP_TYPES.MERGE;
}

function parseOpenSpec(
    stepId: string,
    params: Readonly<Record<string, unknown>>,
): OpenPullRequestSpec {
    const title = requireStringParam(stepId, params, 'title');
    const base = requireStringParam(stepId, params, 'base');
    const head = requireStringParam(stepId, params, 'head');
    const bodyRaw = params['body'];
    if (bodyRaw !== undefined && typeof bodyRaw !== 'string') {
        throw new Error(
            `flow-engine: pr.open step "${stepId}" param "body" must be a string`,
        );
    }
    return bodyRaw === undefined
        ? { title, base, head }
        : { title, body: bodyRaw, base, head };
}

function resolveMergeNumber(
    taskId: string,
    stepId: string,
    params: Readonly<Record<string, unknown>>,
    cache: ReadonlyMap<string, number>,
): number {
    const explicit = params['number'];
    if (typeof explicit === 'number' && Number.isFinite(explicit)) {
        return explicit;
    }
    if (explicit !== undefined) {
        throw new Error(
            `flow-engine: pr.merge step "${stepId}" param "number" must be a finite number`,
        );
    }
    const cached = cache.get(taskId);
    if (cached === undefined) {
        throw new Error(
            `flow-engine: pr.merge step "${stepId}" has no "number" param and no prior pr.open opened a PR in this flow`,
        );
    }
    return cached;
}

const MERGE_METHODS: ReadonlySet<MergeMethod> = new Set(['squash', 'merge', 'rebase']);

function parseMergeMethod(
    stepId: string,
    params: Readonly<Record<string, unknown>>,
): MergeMethod {
    const raw = params['method'];
    if (typeof raw !== 'string' || !MERGE_METHODS.has(raw as MergeMethod)) {
        throw new Error(
            `flow-engine: pr.merge step "${stepId}" param "method" must be one of squash|merge|rebase`,
        );
    }
    return raw as MergeMethod;
}

// ---------------------------------------------------------------------------
// merge-approval helpers (AP-IFG-005)
// ---------------------------------------------------------------------------

function resolveMergeApprovalPrNumber(
    taskId: string,
    stepId: string,
    params: Readonly<Record<string, unknown>>,
    cache: ReadonlyMap<string, number>,
): number {
    const raw = params['prNumber'];
    if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
        return raw;
    }
    if (raw !== undefined && raw !== null && !(typeof raw === 'number' && raw === 0)) {
        throw new Error(
            `flow-engine: merge-approval step "${stepId}" param "prNumber" must be a positive finite number`,
        );
    }
    const cached = cache.get(taskId);
    if (cached === undefined) {
        throw new Error(
            `flow-engine: merge-approval step "${stepId}" has no usable "prNumber" param and no prior pr.open opened a PR in this flow`,
        );
    }
    return cached;
}

function requireMergeApprovalRepoPath(
    stepId: string,
    params: Readonly<Record<string, unknown>>,
): string {
    const raw = params['repoPath'];
    if (typeof raw !== 'string' || raw.length === 0) {
        throw new Error(
            `flow-engine: merge-approval step "${stepId}" requires non-empty string param "repoPath"`,
        );
    }
    return raw;
}

// ---------------------------------------------------------------------------
// context-update-curator + deploy-ready helpers (AP-IFG-006)
// ---------------------------------------------------------------------------

function resolveContextUpdatedPrNumber(
    taskId: string,
    stepId: string,
    params: Readonly<Record<string, unknown>>,
    cache: ReadonlyMap<string, number>,
): number {
    const raw = params['prNumber'];
    if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
        return raw;
    }
    if (raw !== undefined && raw !== null && !(typeof raw === 'number' && raw === 0)) {
        throw new Error(
            `flow-engine: context-update-curator step "${stepId}" param "prNumber" must be a positive finite number`,
        );
    }
    const cached = cache.get(taskId);
    if (cached === undefined) {
        throw new Error(
            `flow-engine: context-update-curator step "${stepId}" has no usable "prNumber" param and no prior pr.open opened a PR in this flow`,
        );
    }
    return cached;
}

function requireDeployReadyParam(
    stepId: string,
    params: Readonly<Record<string, unknown>>,
    name: 'deploy_kind' | 'deploy_target',
): string {
    const raw = params[name];
    if (typeof raw !== 'string' || raw.length === 0) {
        throw new Error(
            `flow-engine: deploy-ready step "${stepId}" requires non-empty string param "${name}"`,
        );
    }
    return raw;
}

function requireStringParam(
    stepId: string,
    params: Readonly<Record<string, unknown>>,
    name: string,
): string {
    const v = params[name];
    if (typeof v !== 'string' || v.length === 0) {
        throw new Error(
            `flow-engine: pr step "${stepId}" requires non-empty string param "${name}"`,
        );
    }
    return v;
}

// ---------------------------------------------------------------------------
// run-script / verify / context-update helpers (AP-VP-010)
// ---------------------------------------------------------------------------

function requireParamString(
    stepId: string,
    kind: string,
    params: Readonly<Record<string, unknown>>,
    name: string,
): string {
    const v = params[name];
    if (typeof v !== 'string' || v.length === 0) {
        throw new Error(
            `flow-engine: ${kind} step "${stepId}" requires non-empty string param "${name}"`,
        );
    }
    return v;
}

function parseStringArrayParam(
    stepId: string,
    kind: string,
    params: Readonly<Record<string, unknown>>,
    name: string,
): string[] {
    const raw = params[name];
    if (raw === undefined) return [];
    if (!Array.isArray(raw) || !raw.every((v) => typeof v === 'string')) {
        throw new Error(
            `flow-engine: ${kind} step "${stepId}" param "${name}" must be an array of strings when set`,
        );
    }
    return raw as string[];
}

function parseStringRecordParam(
    stepId: string,
    kind: string,
    params: Readonly<Record<string, unknown>>,
    name: string,
): Record<string, string> {
    const raw = params[name];
    if (raw === undefined) return {};
    if (
        raw === null
        || typeof raw !== 'object'
        || Array.isArray(raw)
        || !Object.values(raw as Record<string, unknown>).every(
            (v) => typeof v === 'string',
        )
    ) {
        throw new Error(
            `flow-engine: ${kind} step "${stepId}" param "${name}" must be a string-valued object when set`,
        );
    }
    return raw as Record<string, string>;
}

/**
 * AP-VP-010: parse a {@link HealthPredicate} off the `verify` step's
 * `params.predicate`. The predicate is a discriminated union over `kind`
 * (`'status'` | `'json-path'`), so this helper validates each shape
 * exhaustively and throws a step-scoped error on any malformation —
 * downstream callers get a typed predicate without further validation.
 */
function parseHealthPredicate(
    stepId: string,
    params: Readonly<Record<string, unknown>>,
): HealthPredicate {
    const raw = params['predicate'];
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error(
            `flow-engine: verify step "${stepId}" requires object param "predicate"`,
        );
    }
    const obj = raw as Record<string, unknown>;
    const kind = obj['kind'];
    if (kind === 'status') {
        const equals = obj['equals'];
        if (typeof equals !== 'number' || !Number.isFinite(equals)) {
            throw new Error(
                `flow-engine: verify step "${stepId}" predicate.equals must be a finite number for kind 'status'`,
            );
        }
        return { kind: 'status', equals };
    }
    if (kind === 'json-path') {
        const path = obj['path'];
        if (typeof path !== 'string' || path.length === 0) {
            throw new Error(
                `flow-engine: verify step "${stepId}" predicate.path must be a non-empty string for kind 'json-path'`,
            );
        }
        return { kind: 'json-path', path, equals: obj['equals'] };
    }
    throw new Error(
        `flow-engine: verify step "${stepId}" predicate.kind must be 'status' or 'json-path'`,
    );
}

// ---------------------------------------------------------------------------
// Approval-gate load-time validation (AP-VP5-003)
// ---------------------------------------------------------------------------

/**
 * AP-VP5-003: walk the registered flow map at `FlowEngine.start` time and
 * emit one warning per step that (a) declares `approval: 'required'` and
 * (b) omits `on_failure`. The rejection path silently falls back to
 * `emit:TaskFailed{ failed_stage: 'rejected' }` for these steps; surfacing
 * the warning at load time lets operators distinguish an intentional
 * default from an oversight without waiting for the first reject to fire.
 */
function warnApprovalStepsWithoutOnFailure(
    flows: ReadonlyMap<string, FlowDefinition>,
    logger: Logger,
): void {
    for (const [flowId, flow] of flows.entries()) {
        for (const step of flow.steps) {
            if (step.approval !== 'required') continue;
            if (step.on_failure !== undefined) continue;
            logger.warn(
                'flow-engine: approval-required step has no on_failure — '
                    + 'reject will fall back to emit:TaskFailed{ failed_stage: "rejected" }',
                { flowId, stepId: step.id, agent: step.agent },
            );
        }
    }
}
