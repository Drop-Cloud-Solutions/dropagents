/**
 * Operator commands for acting on the most recent investigation report
 * on a task (AP-NVP-031).
 *
 * After the investigator agent emits an InvestigationCompleted event with
 * a markdown answer, the operator decides whether to:
 *
 *   - Implement the recommendation → `ImplementFromInvestigation`, which
 *     produces a fresh scaffold task whose plan body carries the report
 *     markdown verbatim.
 *   - Dismiss it → `DismissInvestigation`, emitting an
 *     `InvestigationDismissed` event. The optional `reason` is persisted
 *     on that event so the board (and any later audit) can render why.
 *
 * The handlers are pure factories: they receive their state (the
 * `InvestigationReportStore`, a clock, an id generator) at construction
 * and return a `CommandHandler` suitable for `CommandBus.register`. This
 * keeps them trivially unit-testable without a live bus or database.
 *
 * The HTTP surface that drives these commands lives in
 * `hosts/board-ui/server.ts` — those two routes translate operator clicks
 * into a `Command` object and forward it to the worker-api's existing
 * `POST /commands` endpoint, which then routes through the same
 * `CommandBus.send` path every other command uses.
 */

import type { Event } from '../events/event';
import type { IdGen } from '../ports/IdGen';
import type { CommandHandler } from './bus';
import type { Command } from './command';

export const InvestigationCommands = {
    IMPLEMENT_FROM_INVESTIGATION: 'ImplementFromInvestigation',
    DISMISS_INVESTIGATION: 'DismissInvestigation',
} as const;

/**
 * Operator command + paired events for resuming a parked task (AP-IFW-002).
 *
 * A task can be parked for two distinct reasons, both surfaced as a single
 * {@link TaskParkedReason} discriminator on the `TaskParked` event:
 *
 *   - `wait-action` — the flow has reached a `wait-action` / `wait-merged`
 *     step that intentionally pauses until the operator (or an external
 *     signal — merged PR, completed deploy, etc.) dispatches `ResumeTask`.
 *   - `clarification` — an agent emitted an `AGENT_QUESTION` /
 *     `NEEDS_HUMAN_INPUT` block during a normal step. The flow engine
 *     parks the task at the agent's step and waits for `ResumeTask` to
 *     re-run the agent with the operator's answer threaded in as context.
 *
 * `ResumeTask` is a thin command: its handler emits a single `TaskResumed`
 * event whose payload mirrors the command, plus the actor. The flow engine
 * subscribes to `TaskResumed` and decides — based on the parked step's kind
 * — whether to chain through `on_success` (wait-* kinds) or re-issue
 * `StartAgent` with `humanAnswer` context (clarification).
 */
export const TaskParkingCommands = {
    RESUME_TASK: 'ResumeTask',
} as const;

export const TaskParkingEvents = {
    TASK_PARKED: 'TaskParked',
    TASK_RESUMED: 'TaskResumed',
} as const;

/**
 * - `wait-action` / `wait-merged` — flow reached a wait-* step intentionally.
 * - `clarification` — agent emitted AGENT_QUESTION; the parent step is parked
 *   awaiting an operator answer.
 * - `approval` (AP-VP-007) — engine ran the {@link evaluateApproval} gate on
 *   a command-producing step and it returned `'required'`. The task is held
 *   at the step until a `ResumeTask` arrives with a decision.
 * - `investigation-followup` (AP-VP5-003) — the orchestrator parked the task
 *   while a follow-up investigation runs against a prior report. Set by the
 *   caller publishing the TaskParked event; the engine accepts it on
 *   resume so the parked state reads back without crashing.
 * - `commit-reject` (AP-VP5-003) — the operator rejected the commit at a
 *   commit-approval / worktree-diff-review park. Set by the caller; the
 *   engine accepts the wider union on read so the rejected state can route
 *   through the step's `on_failure` (or default TaskFailed terminal).
 */
export type TaskParkedReason =
    | 'wait-action'
    | 'wait-merged'
    | 'clarification'
    | 'approval'
    | 'investigation-followup'
    | 'commit-reject'
    // Operator-gated diff review BEFORE the committer runs. Emitted by
    // the engine when entering a `worktree-diff-review` lifecycle
    // parking step (typically inserted between `test` and `commit` in
    // the implement flow). The board renders a dedicated review modal
    // for this reason — Approve resumes through `on_success`, Reject
    // (with required feedback) routes through `on_failure` with the
    // feedback threaded as `rejectFeedback` into the next StartAgent.
    | 'worktree-diff-review';

/**
 * Operator's verdict on a parked task. `approve` resumes the flow through
 * `on_success` (existing behaviour); `reject` will be routed through
 * `on_failure` once task-006 wires the engine branch. The discriminator
 * is the required field so every ResumeTask captures an explicit
 * decision — there is no implicit default.
 */
export type ResumeTaskDecision = 'approve' | 'reject';

export interface ResumeTaskPayload {
    readonly taskId: string;
    /**
     * Required operator verdict. `approve` preserves the prior
     * advance-through-on_success behaviour; `reject` is captured now so
     * the engine routing in task-006 can branch on it without a schema
     * bump.
     */
    readonly decision: ResumeTaskDecision;
    /**
     * Optional free-form rejection rationale. Only meaningful when
     * `decision === 'reject'` — recorded on the TaskResumed event so the
     * downstream failure handler (task-006) can surface it on the task
     * record and the audit trail.
     */
    readonly feedback?: string;
    /**
     * Free-form answer text from the operator. When the parked step was an
     * agent step (clarification), this is threaded onto the resumed
     * StartAgent's context as `humanAnswer`. Optional for `wait-*` steps
     * where resuming is a yes/no decision.
     */
    readonly answer?: string;
    /**
     * Optional selected option key (e.g. `"A"`). Mirrors the keys produced
     * by `parseClarification`. Not interpreted by the engine — recorded on
     * the TaskResumed event for auditability.
     */
    readonly optionKey?: string;
    /**
     * Operator's "remember this answer" intent (AP-VP5-001). When `true`,
     * downstream subscribers persist the {question, answer} pair into the
     * project's agent-memory so future tasks see the same clarification
     * answered automatically. The command bus does not interpret this
     * field — it is copied verbatim onto the TaskResumed event and onto the
     * ClarificationAnswered event a subscriber emits.
     */
    readonly remember?: boolean;
}

export interface TaskParkedEventPayload {
    readonly taskId: string;
    readonly stepId: string;
    readonly reason: TaskParkedReason;
    /** Free-form question text from the agent (clarification only). */
    readonly question?: string;
    /** True when the park needs NO human decision (merge-auto): the
     *  notification surfaces suppress their ready-to-act message and only
     *  speak up on completion or failure. */
    readonly auto?: boolean;
}

export interface TaskResumedEventPayload {
    readonly taskId: string;
    readonly actor: string;
    /**
     * Operator verdict copied verbatim from the originating
     * {@link ResumeTaskPayload.decision}. Required so the engine routing
     * in task-006 can branch on this field without inferring a default.
     */
    readonly decision: ResumeTaskDecision;
    /** Free-form rejection rationale; only set when `decision === 'reject'`. */
    readonly feedback?: string;
    readonly answer?: string;
    readonly optionKey?: string;
    /** Mirror of {@link ResumeTaskPayload.remember}. Copied verbatim from
     *  the command so audit replay sees the operator's persist intent. */
    readonly remember?: boolean;
}

export function isResumeTaskPayload(value: unknown): value is ResumeTaskPayload {
    if (!value || typeof value !== 'object') return false;
    const v = value as Record<string, unknown>;
    if (typeof v.taskId !== 'string' || v.taskId.length === 0) return false;
    if (v.decision !== 'approve' && v.decision !== 'reject') return false;
    if (v.feedback !== undefined && typeof v.feedback !== 'string') return false;
    if (v.answer !== undefined && typeof v.answer !== 'string') return false;
    if (v.optionKey !== undefined && typeof v.optionKey !== 'string') return false;
    if (v.remember !== undefined && typeof v.remember !== 'boolean') return false;
    return true;
}

export interface ResumeTaskDeps {
    readonly clock: () => number;
}

/**
 * Build the `ResumeTask` command handler.
 *
 * Emits a single `TaskResumed` event whose `idempotencyKey` is deterministic
 * per (taskId, issuedAt) so a duplicate operator click within the same
 * millisecond de-dupes at the event store rather than resuming the task twice.
 * `actor` is captured from the command so the audit trail records who
 * unparked the task.
 */
export function createResumeTaskHandler(
    deps: ResumeTaskDeps,
): CommandHandler<Command<ResumeTaskPayload>> {
    return async (cmd) => {
        if (!isResumeTaskPayload(cmd.payload)) {
            throw new Error('ResumeTask: invalid payload');
        }
        const { taskId, decision, feedback, answer, optionKey, remember } = cmd.payload;
        const payload: TaskResumedEventPayload = {
            taskId,
            actor: cmd.actor,
            decision,
        };
        if (feedback !== undefined) {
            (payload as { feedback: string }).feedback = feedback;
        }
        if (answer !== undefined) (payload as { answer: string }).answer = answer;
        if (optionKey !== undefined) {
            (payload as { optionKey: string }).optionKey = optionKey;
        }
        if (remember !== undefined) {
            (payload as { remember: boolean }).remember = remember;
        }
        const event: Event = {
            type: TaskParkingEvents.TASK_RESUMED,
            v: 1,
            occurredAt: deps.clock(),
            idempotencyKey: `${TaskParkingCommands.RESUME_TASK}:${taskId}:${cmd.issuedAt}`,
            payload,
        };
        return [event];
    };
}

/**
 * AP-IFG-015 — Telegram stage-decision approval callbacks.
 *
 * The Telegram operator channel renders an inline Approve / Reject keyboard
 * at each pipeline gate (commit-ready, pr-ready/merge, deploy-ready,
 * context-updated). A tap dispatches one of these commands carrying just the
 * gated `{ taskId }` — there is no per-verb payload beyond the task.
 *
 * These are NOT new event producers: every verb translates onto the SAME
 * approval-gate path {@link createResumeTaskHandler} drives, emitting a
 * `TaskResumed` event with a fixed decision (approve verbs → `'approve'`,
 * reject verbs → `'reject'`). The flow engine's `onTaskResumed` then resumes
 * the task through `on_success` / `handleApprovalApprove` (approve) or
 * `on_failure` / `handleApprovalReject` (reject), exactly as an operator's
 * board click would. Handler registration lives in the orchestrator host
 * (`hosts/orchestrator/handlers.ts`); the string values here MUST stay in
 * lock-step with the gateway's `TelegramInboundCommands` /
 * `CALLBACK_VERB_TO_COMMAND` map so the dispatched command type finds a
 * registered handler — a missing pair is the "no handler registered" class
 * of bug this task closes.
 */
export const ApprovalCallbackCommands = {
    APPROVE_COMMIT: 'ApproveCommit',
    REJECT_COMMIT: 'RejectCommit',
    APPROVE_MERGE: 'ApproveMerge',
    REJECT_MERGE: 'RejectMerge',
    APPROVE_DEPLOY: 'ApproveDeploy',
    ACCEPT_CONTEXT_UPDATE: 'AcceptContextUpdate',
    REJECT_CONTEXT_UPDATE: 'RejectContextUpdate',
} as const;

/**
 * Shared payload for every AP-IFG-015 callback command. The gateway only
 * knows the gated task id — the verb itself carries the approve/reject
 * intent — so the wire shape is the single `taskId` field.
 */
export interface ApprovalCallbackPayload {
    readonly taskId: string;
}

export function isApprovalCallbackPayload(
    value: unknown,
): value is ApprovalCallbackPayload {
    if (!value || typeof value !== 'object') return false;
    const v = value as Record<string, unknown>;
    return typeof v.taskId === 'string' && v.taskId.length > 0;
}

/**
 * Build a handler for one AP-IFG-015 callback command. The handler is thin:
 * it re-shapes the `{ taskId }` callback into a `ResumeTask`-shaped command
 * carrying the verb's fixed {@link ResumeTaskDecision}, then delegates to the
 * exact same {@link createResumeTaskHandler} the board's Resume path uses.
 *
 * Delegating (rather than emitting a hand-rolled `TaskResumed`) guarantees
 * the emitted event is byte-for-byte the gate path — same event type, same
 * `idempotencyKey` shape (`ResumeTask:<taskId>:<issuedAt>`, which carries the
 * dispatch timestamp so two decisions on the same task never collapse into
 * one deduped event).
 */
export function createApprovalCallbackHandler(
    deps: ResumeTaskDeps,
    decision: ResumeTaskDecision,
): CommandHandler<Command<ApprovalCallbackPayload>> {
    const resume = createResumeTaskHandler(deps);
    return async (cmd, state) => {
        if (!isApprovalCallbackPayload(cmd.payload)) {
            throw new Error(`${cmd.type}: invalid payload`);
        }
        const resumeCmd: Command<ResumeTaskPayload> = {
            ...cmd,
            payload: { taskId: cmd.payload.taskId, decision },
        };
        return resume(resumeCmd, state);
    };
}

/**
 * Brief → Plan → Decompose lifecycle commands (AP-IFW-003).
 *
 * Three operator-facing commands drive the upstream of every task. The
 * paired domain events (one per command) form the audit trail that the
 * `ApprovePlan` gate consults:
 *
 *   SubmitBrief   → BriefSubmitted
 *   GeneratePlan  → PlanGenerated     (consumed by ApprovePlan gate)
 *   DecomposePlan → PlanDecomposed
 *
 * Each command emits exactly one event from its handler. The handlers
 * themselves do not call into the agent runner — the orchestrator host
 * wires a separate StartAgent dispatch on top of these handlers so the
 * planner and decomposer prompts can be enriched with per-project agent
 * memory at invocation time (see hosts/orchestrator/handlers.ts).
 */
export const PlanLifecycleCommands = {
    SUBMIT_BRIEF: 'SubmitBrief',
    GENERATE_PLAN: 'GeneratePlan',
    DECOMPOSE_PLAN: 'DecomposePlan',
    /**
     * Re-point a plan at a different repo.
     *
     * `sidebar_plans.metadata.targetRepo` is load-bearing: it resolves the
     * per-task worktree for every task under the plan that has no repo of
     * its own. Getting it wrong sends agents at the wrong repo, so it must
     * be changeable after the fact — from the plan modal and from chat.
     *
     * A dedicated command rather than a plain `UpdatePlan`: the plans
     * projection REPLACES the whole metadata blob, so a caller sending
     * `{targetRepo}` alone would silently drop planType, conventions,
     * techStack and the impact-check warnings. The handler reads the
     * stored blob and merges, in ONE place, so no caller has to know.
     */
    SET_PLAN_REPO: 'SetPlanRepo',
    /**
     * The operator's reply to a question the DECOMPOSER asked (its
     * `NEEDS_HUMAN_INPUT` escape hatch). Emits
     * `PlanDecomposeQuestionAnswered`; a lifecycle subscriber re-spawns the
     * decomposer with every answer given on the plan threaded into its
     * prompt.
     *
     * Not `ResumeTask`: a decomposer run is plan-scoped, has no task row,
     * no worktree and no flow state, so none of the parked-task machinery
     * (`tasks.parked_reason`, the engine's resume dispatch) applies to it.
     */
    ANSWER_DECOMPOSER_QUESTION: 'AnswerDecomposerQuestion',
    /**
     * Give up on the question instead of answering it.
     *
     * Field report: "I have the decomposer asking a question, one of the
     * options is cancel the task, which is what I selected but the
     * question keeps coming back and I have no way to dismiss the
     * decomposer."
     *
     * The decomposer writes its own options, and nothing stops it
     * offering one the pipeline cannot perform. Answering with it is
     * just text: the answer is recorded and the decomposer is
     * re-spawned, which asks again. The card has no Dismiss while a
     * question is pending (deliberately — it would hide the only
     * control that can un-hold the plan), so there was no way out at
     * all.
     *
     * This is the way out. It retires the question WITHOUT re-spawning
     * anything, which is the one thing answering can never do.
     */
    ABANDON_DECOMPOSER_QUESTION: 'AbandonDecomposerQuestion',
} as const;

export interface SetPlanRepoPayload {
    readonly planId: string;
    /** Workspace repo id. Empty string CLEARS the plan's target repo. */
    readonly repoId: string;
}

export function isSetPlanRepoPayload(value: unknown): value is SetPlanRepoPayload {
    if (!value || typeof value !== 'object') return false;
    const v = value as Record<string, unknown>;
    return (
        typeof v.planId === 'string' && v.planId.length > 0
        && typeof v.repoId === 'string'
    );
}

export const PlanLifecycleEvents = {
    BRIEF_SUBMITTED: 'BriefSubmitted',
    PLAN_GENERATED: 'PlanGenerated',
    PLAN_DECOMPOSED: 'PlanDecomposed',
} as const;

/**
 * Plan-level conventions seed (AP-VP4-005). Mirrors the
 * `PlanDefaults` shape from `core/projects/registry.ts` (task-004)
 * field-for-field so the new-plan modal can copy the project's
 * `plan_defaults` block straight onto a SubmitBrief or DecomposePlan
 * payload without renaming keys. Defined locally to keep `core/commands`
 * independent of `core/projects`.
 *
 * All fields are optional — the modal may surface any subset; an absent
 * field means "fall through to whatever the planner / decomposer infers".
 */
export interface PlanConventions {
    readonly namespace_root?: string;
    readonly test_framework?: string;
    readonly branch_pattern?: string;
    readonly commit_pattern?: string;
}

export interface SubmitBriefPayload {
    readonly briefId: string;
    readonly projectId: string;
    /** Free-form brief content captured from the modal's textarea. */
    readonly content: string;
    /**
     * Architect Tier: the SYSTEM this fanned-out brief targets (a repo id,
     * e.g. `workshop-tailorqueue`). Distinct from `projectId`, which is
     * the BOARD project the plan lands under — the requirement fan-out
     * sets both so the requirement modal can keep linking plans by system.
     */
    readonly systemId?: string;
    /**
     * Repo the operator selected for this plan. Optional because some
     * projects expose a single canonical repo and the modal omits the
     * selector entirely.
     */
    readonly repoId?: string;
    /**
     * Conventions seed the operator confirmed (or left at the project's
     * `plan_defaults` values). Optional — when absent the planner falls
     * back to whatever it can derive from the project context.
     */
    readonly conventions?: PlanConventions;
    /**
     * When this brief was fanned out from an architect requirement (Architect
     * Tier, Phase 2), the originating requirement's id. Lets the requirement
     * projection link this plan back to its parent requirement. Absent for
     * ordinary operator-authored briefs.
     */
    readonly requirementId?: string;
    /**
     * Plan archetype selected in the new-plan modal (feature | documentation |
     * review-codebase | review-azure | deploy-only | investigate). Drives
     * routing: `feature` (or absent) runs the planner; every other archetype
     * skips the planner and decomposes the brief straight into its task(s).
     */
    readonly archetype?: string;
}

export interface GeneratePlanPayload {
    readonly planId: string;
    readonly projectId: string;
    /** Originating brief, when GeneratePlan follows SubmitBrief. Optional
     *  so the handler can also be invoked stand-alone (e.g. operator
     *  re-runs the planner on an existing plan). */
    readonly briefId?: string;
    /**
     * Monotonically-incrementing revision number for this generation.
     * Required at the command boundary so every PlanGenerated event
     * carries an explicit revision — there is no implicit "first
     * revision" default.
     */
    readonly revision: number;
    /**
     * Operator feedback that triggered this generation, when the request
     * follows a rejection of a previous revision.
     */
    readonly feedback?: string;
    /**
     * Rendered content of the previous revision. Seeds the planner agent
     * prompt with the prior draft when the operator is asking for a
     * revision; the orchestrator (task-010) threads it onto the agent
     * invocation. Not copied onto the PlanGenerated event payload.
     */
    readonly previousContent?: string;
    /**
     * Inline brief text for cases where the operator fires the planner
     * directly on an existing plan (no `BriefSubmitted` in front).
     * Threaded into `assembleLifecyclePrompt` as the `# Brief` section
     * so the planner sees the plan's body even when there is no
     * `briefId` to look up in the event log. Optional — the
     * brief-driven path still routes content via `briefId`.
     */
    readonly briefContent?: string;
}

export interface DecomposePlanPayload {
    readonly planId: string;
    readonly projectId: string;
    /**
     * The plan body the operator approved (verbatim). The decomposer
     * agent ingests this as its starting point. Required so the
     * command-bus boundary rejects decompose attempts that omit the
     * approved body.
     */
    readonly approvedContent: string;
    /**
     * Conventions to thread into the decomposer prompt — same shape as
     * SubmitBrief's seed so the modal can flow conventions through both
     * commands without remapping. Required at the command boundary; an
     * empty `{}` is acceptable when the operator left every field blank.
     */
    readonly conventions: PlanConventions;
}

/**
 * `AnswerDecomposerQuestion` — the operator's reply to the pending
 * decomposer question on `planId`.
 *
 * `answer` is free text (or the label of the option the operator picked in
 * the Answer modal — the modal resolves a radio selection to its label
 * before POSTing, so the agent reads a sentence rather than "B").
 *
 * `remember: true` also files the decision in the project's agent memory, so
 * the next plan for this project is designed knowing it. Default false: the
 * operator opts in to memorising an answer, never the other way around.
 */
export interface AnswerDecomposerQuestionPayload {
    readonly planId: string;
    readonly answer: string;
    readonly remember?: boolean;
}

/**
 * Retire a pending decomposer question unanswered.
 *
 * `reason` is the operator's optional note, recorded in place of an
 * answer so the plan history says the question was abandoned rather
 * than leaving a blank that reads like a bug.
 */
export interface AbandonDecomposerQuestionPayload {
    readonly planId: string;
    readonly reason?: string;
}

export interface BriefSubmittedEventPayload {
    readonly briefId: string;
    readonly projectId: string;
    readonly content: string;
    readonly actor: string;
    readonly repoId?: string;
    /** Architect Tier: the system (repo id) this fanned-out brief targets. */
    readonly systemId?: string;
    readonly conventions?: PlanConventions;
    /** Originating architect requirement, when fanned out (Phase 2). */
    readonly requirementId?: string;
    /** Plan archetype (drives planner-vs-direct-decompose routing). */
    readonly archetype?: string;
}

export interface PlanGeneratedEventPayload {
    readonly planId: string;
    readonly projectId: string;
    readonly briefId?: string;
    readonly actor: string;
    /** Revision this generation produced (mirrors the command field). */
    readonly revision?: number;
    /** Operator feedback threaded through from the command, if any. */
    readonly feedback?: string;
    /**
     * Revision number that this PlanGenerated supersedes. Set when the
     * command's `revision > 1` so subscribers can correlate the feedback
     * round-trip without having to read the previous event.
     */
    readonly previousRevision?: number;
}

export interface PlanDecomposedEventPayload {
    readonly planId: string;
    readonly projectId: string;
    readonly actor: string;
    /** Conventions threaded through from the command. */
    readonly conventions?: PlanConventions;
}

const PLAN_CONVENTION_KEYS: readonly string[] = [
    'namespace_root',
    'test_framework',
    'branch_pattern',
    'commit_pattern',
];

export function isPlanConventions(value: unknown): value is PlanConventions {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const v = value as Record<string, unknown>;
    for (const key of PLAN_CONVENTION_KEYS) {
        const leaf = v[key];
        if (leaf !== undefined && typeof leaf !== 'string') return false;
    }
    return true;
}

export function isSubmitBriefPayload(value: unknown): value is SubmitBriefPayload {
    if (!value || typeof value !== 'object') return false;
    const v = value as Record<string, unknown>;
    if (typeof v.briefId !== 'string' || v.briefId.length === 0) return false;
    if (typeof v.projectId !== 'string' || v.projectId.length === 0) return false;
    if (typeof v.content !== 'string') return false;
    if (v.repoId !== undefined && (typeof v.repoId !== 'string' || v.repoId.length === 0)) {
        return false;
    }
    if (v.systemId !== undefined && (typeof v.systemId !== 'string' || v.systemId.length === 0)) {
        return false;
    }
    if (v.conventions !== undefined && !isPlanConventions(v.conventions)) return false;
    if (v.requirementId !== undefined
        && (typeof v.requirementId !== 'string' || v.requirementId.length === 0)) {
        return false;
    }
    if (v.archetype !== undefined && typeof v.archetype !== 'string') return false;
    return true;
}

export function isGeneratePlanPayload(value: unknown): value is GeneratePlanPayload {
    if (!value || typeof value !== 'object') return false;
    const v = value as Record<string, unknown>;
    if (typeof v.planId !== 'string' || v.planId.length === 0) return false;
    if (typeof v.projectId !== 'string' || v.projectId.length === 0) return false;
    if (v.briefId !== undefined && typeof v.briefId !== 'string') return false;
    if (typeof v.revision !== 'number' || !Number.isInteger(v.revision) || v.revision < 1) {
        return false;
    }
    if (v.feedback !== undefined && typeof v.feedback !== 'string') return false;
    if (v.previousContent !== undefined && typeof v.previousContent !== 'string') return false;
    if (v.briefContent !== undefined && typeof v.briefContent !== 'string') return false;
    return true;
}

export function isDecomposePlanPayload(value: unknown): value is DecomposePlanPayload {
    if (!value || typeof value !== 'object') return false;
    const v = value as Record<string, unknown>;
    if (typeof v.planId !== 'string' || v.planId.length === 0) return false;
    if (typeof v.projectId !== 'string' || v.projectId.length === 0) return false;
    if (typeof v.approvedContent !== 'string') return false;
    if (!isPlanConventions(v.conventions)) return false;
    return true;
}

export function isAnswerDecomposerQuestionPayload(
    value: unknown,
): value is AnswerDecomposerQuestionPayload {
    if (!value || typeof value !== 'object') return false;
    const v = value as Record<string, unknown>;
    if (typeof v.planId !== 'string' || v.planId.length === 0) return false;
    if (typeof v.answer !== 'string' || v.answer.trim().length === 0) return false;
    if (v.remember !== undefined && typeof v.remember !== 'boolean') return false;
    return true;
}

export function isAbandonDecomposerQuestionPayload(
    value: unknown,
): value is AbandonDecomposerQuestionPayload {
    if (!value || typeof value !== 'object') return false;
    const v = value as Record<string, unknown>;
    if (typeof v.planId !== 'string' || v.planId.length === 0) return false;
    if (v.reason !== undefined && typeof v.reason !== 'string') return false;
    return true;
}

export interface PlanLifecycleDeps {
    readonly clock: () => number;
}

export function createSubmitBriefHandler(
    deps: PlanLifecycleDeps,
): CommandHandler<Command<SubmitBriefPayload>> {
    return async (cmd) => {
        if (!isSubmitBriefPayload(cmd.payload)) {
            throw new Error('SubmitBrief: invalid payload');
        }
        const { briefId, projectId, content, repoId, systemId, conventions, requirementId, archetype }
            = cmd.payload;
        const payload: BriefSubmittedEventPayload = {
            briefId,
            projectId,
            content,
            actor: cmd.actor,
        };
        if (repoId !== undefined) (payload as { repoId: string }).repoId = repoId;
        if (systemId !== undefined) (payload as { systemId: string }).systemId = systemId;
        if (conventions !== undefined) {
            (payload as { conventions: PlanConventions }).conventions = conventions;
        }
        if (requirementId !== undefined) {
            (payload as { requirementId: string }).requirementId = requirementId;
        }
        if (archetype !== undefined) {
            (payload as { archetype: string }).archetype = archetype;
        }
        return [
            {
                type: PlanLifecycleEvents.BRIEF_SUBMITTED,
                v: 1,
                occurredAt: deps.clock(),
                idempotencyKey: `${PlanLifecycleCommands.SUBMIT_BRIEF}:${briefId}`,
                payload,
            },
        ];
    };
}

export function createGeneratePlanHandler(
    deps: PlanLifecycleDeps,
): CommandHandler<Command<GeneratePlanPayload>> {
    return async (cmd) => {
        if (!isGeneratePlanPayload(cmd.payload)) {
            throw new Error('GeneratePlan: invalid payload');
        }
        const { planId, projectId, briefId, revision, feedback } = cmd.payload;
        const payload: PlanGeneratedEventPayload = {
            planId,
            projectId,
            actor: cmd.actor,
            revision,
        };
        if (briefId !== undefined) (payload as { briefId: string }).briefId = briefId;
        if (feedback !== undefined) (payload as { feedback: string }).feedback = feedback;
        if (revision > 1) {
            (payload as { previousRevision: number }).previousRevision = revision - 1;
        }
        return [
            {
                type: PlanLifecycleEvents.PLAN_GENERATED,
                v: 1,
                occurredAt: deps.clock(),
                // Key on (planId, revision) so a second GeneratePlan for
                // the same plan but a new revision lands as a distinct
                // event rather than de-duping against the previous draft.
                idempotencyKey:
                    `${PlanLifecycleCommands.GENERATE_PLAN}:${planId}:r${revision}`,
                payload,
            },
        ];
    };
}

export function createDecomposePlanHandler(
    deps: PlanLifecycleDeps,
): CommandHandler<Command<DecomposePlanPayload>> {
    return async (cmd) => {
        if (!isDecomposePlanPayload(cmd.payload)) {
            throw new Error('DecomposePlan: invalid payload');
        }
        const { planId, projectId, conventions } = cmd.payload;
        const payload: PlanDecomposedEventPayload = {
            planId,
            projectId,
            actor: cmd.actor,
            conventions,
        };
        const occurredAt = deps.clock();
        return [
            {
                type: PlanLifecycleEvents.PLAN_DECOMPOSED,
                v: 1,
                occurredAt,
                // Keyed per dispatch (not per plan): a RETRY after a failed
                // decomposition must land as a fresh event so the decompose
                // status projection sees a new attempt — with a per-plan key
                // the events table's UNIQUE constraint silently dropped every
                // re-dispatch and the status card stayed pinned on the first
                // attempt's error.
                idempotencyKey:
                    `${PlanLifecycleCommands.DECOMPOSE_PLAN}:${planId}:${occurredAt}`,
                payload,
            },
        ];
    };
}

/**
 * Gate the ApprovePlan command uses to verify a `PlanGenerated` event has
 * been recorded for a given `planId`. The orchestrator fills this in by
 * subscribing to `PlanGenerated` and calling `record`; the ApprovePlan
 * handler queries `has` and refuses (throws) when missing.
 *
 * Kept as a tiny interface so tests can hand-feed `record` to assert
 * gate behaviour without standing up an EventBus.
 */
export interface PlanGenerationGate {
    has(planId: string): boolean;
    record(planId: string): void;
}

export class InMemoryPlanGenerationGate implements PlanGenerationGate {
    private readonly generated = new Set<string>();
    has(planId: string): boolean {
        return this.generated.has(planId);
    }
    record(planId: string): void {
        this.generated.add(planId);
    }
}

export const InvestigationEvents = {
    /**
     * The follow-up task event. `ImplementFromInvestigation` emits a
     * `TaskCreated` whose payload carries the report markdown as
     * `planBody`. The event type matches the orchestrator's existing
     * `TaskCreated` so the projection + cascade keep working unchanged.
     */
    TASK_CREATED: 'TaskCreated',
    INVESTIGATION_DISMISSED: 'InvestigationDismissed',
} as const;

export interface ImplementFromInvestigationPayload {
    readonly taskId: string;
    readonly reportId: string;
}

export interface DismissInvestigationPayload {
    readonly taskId: string;
    readonly reportId: string;
    readonly reason?: string;
}

export interface InvestigationDismissedEventPayload {
    readonly taskId: string;
    readonly reportId: string;
    readonly actor: string;
    readonly reason?: string;
}

/**
 * The TaskCreated event ImplementFromInvestigation emits. Includes the
 * planBody (markdown from the report) and the source identifiers so the
 * board can correlate the new task back to the report it came from.
 */
export interface ImplementTaskCreatedPayload {
    readonly taskId: string;
    readonly planId: string;
    readonly type: string;
    readonly flowId: string;
    readonly planBody: string;
    readonly sourceTaskId: string;
    readonly sourceReportId: string;
    /**
     * Card title + agent brief. The generic tasks projection folds
     * `title` / `description` off any TaskCreated payload — without
     * these the follow-up task rendered as a blank card and the
     * developer prompt carried "(no description supplied)" while the
     * report sat unread in `planBody`.
     */
    readonly title: string;
    readonly description: string;
}

export function isImplementFromInvestigationPayload(
    value: unknown,
): value is ImplementFromInvestigationPayload {
    if (!value || typeof value !== 'object') return false;
    const v = value as Record<string, unknown>;
    return typeof v.taskId === 'string' && typeof v.reportId === 'string';
}

export function isDismissInvestigationPayload(
    value: unknown,
): value is DismissInvestigationPayload {
    if (!value || typeof value !== 'object') return false;
    const v = value as Record<string, unknown>;
    if (typeof v.taskId !== 'string' || typeof v.reportId !== 'string') return false;
    if (v.reason !== undefined && typeof v.reason !== 'string') return false;
    return true;
}

export interface InvestigationReport {
    readonly markdown: string;
}

/**
 * Lookup port for investigation reports captured from the agent stream.
 * `record` is called by a subscriber on `InvestigationCompleted` events.
 * `get` is called by the `ImplementFromInvestigation` handler. Tests
 * inject `InMemoryInvestigationReportStore`; production wires the same
 * impl into the orchestrator host.
 */
export interface InvestigationReportStore {
    record(taskId: string, reportId: string, report: InvestigationReport): void;
    get(taskId: string, reportId: string): InvestigationReport | undefined;
}

export class InMemoryInvestigationReportStore implements InvestigationReportStore {
    private readonly reports = new Map<string, InvestigationReport>();

    record(taskId: string, reportId: string, report: InvestigationReport): void {
        this.reports.set(keyFor(taskId, reportId), report);
    }

    get(taskId: string, reportId: string): InvestigationReport | undefined {
        return this.reports.get(keyFor(taskId, reportId));
    }
}

function keyFor(taskId: string, reportId: string): string {
    return `${taskId} ${reportId}`;
}

export interface ImplementFromInvestigationDeps {
    readonly clock: () => number;
    readonly idGen: IdGen;
    readonly reports: InvestigationReportStore;
    readonly scaffoldFlowId: string;
    readonly scaffoldTaskType: string;
    /**
     * planId for the follow-up task. Defaults to the source taskId so the
     * downstream task is always traceable back to its parent without an
     * explicit join — the orchestrator can override this when it has a
     * real plan id in scope.
     */
    readonly planIdFor?: (sourceTaskId: string) => string;
}

export interface DismissInvestigationDeps {
    readonly clock: () => number;
}

/**
 * Build the `ImplementFromInvestigation` command handler.
 *
 * On success it returns a single `TaskCreated` event whose payload carries
 * the investigation report's markdown as `planBody`. The new task is
 * routed onto the scaffold flow (`type=scaffold`, `flowId=scaffold` by
 * default — the orchestrator can override via `scaffoldFlowId` /
 * `scaffoldTaskType` to match its own naming).
 *
 * The handler throws when the `(taskId, reportId)` pair has no matching
 * report. The board-ui only surfaces buttons for live reports, so an
 * empty lookup means a stale click / replay / programmer error; failing
 * loudly stops a phantom task being scaffolded with no plan body.
 */
export function createImplementFromInvestigationHandler(
    deps: ImplementFromInvestigationDeps,
): CommandHandler<Command<ImplementFromInvestigationPayload>> {
    return async (cmd) => {
        if (!isImplementFromInvestigationPayload(cmd.payload)) {
            throw new Error('ImplementFromInvestigation: invalid payload');
        }
        const { taskId: sourceTaskId, reportId } = cmd.payload;
        const report = deps.reports.get(sourceTaskId, reportId);
        if (!report) {
            throw new Error(
                `ImplementFromInvestigation: no report "${reportId}" for task "${sourceTaskId}"`,
            );
        }
        const planId = deps.planIdFor ? deps.planIdFor(sourceTaskId) : sourceTaskId;
        const newTaskId = deps.idGen.newId();
        const payload: ImplementTaskCreatedPayload = {
            taskId: newTaskId,
            planId,
            type: deps.scaffoldTaskType,
            flowId: deps.scaffoldFlowId,
            planBody: report.markdown,
            sourceTaskId,
            sourceReportId: reportId,
            title: `Implement findings of ${sourceTaskId}`,
            description: report.markdown,
        };
        const event: Event = {
            type: InvestigationEvents.TASK_CREATED,
            v: 1,
            occurredAt: deps.clock(),
            // Deterministic per (sourceTaskId, reportId) so a duplicate
            // click or replay is de-duped at the event store rather than
            // scaffolding a second task.
            idempotencyKey: `${InvestigationCommands.IMPLEMENT_FROM_INVESTIGATION}:${sourceTaskId}:${reportId}`,
            payload,
        };
        return [event];
    };
}

/**
 * Build the `DismissInvestigation` command handler.
 *
 * Emits a single `InvestigationDismissed` event. When the operator
 * supplied a `reason`, it is persisted on the event payload so audit
 * and later UI can render *why* the report was set aside. The actor is
 * always recorded from the command — there is no anonymous dismissal.
 */
export function createDismissInvestigationHandler(
    deps: DismissInvestigationDeps,
): CommandHandler<Command<DismissInvestigationPayload>> {
    return async (cmd) => {
        if (!isDismissInvestigationPayload(cmd.payload)) {
            throw new Error('DismissInvestigation: invalid payload');
        }
        const { taskId, reportId, reason } = cmd.payload;
        const payload: InvestigationDismissedEventPayload =
            reason !== undefined
                ? { taskId, reportId, actor: cmd.actor, reason }
                : { taskId, reportId, actor: cmd.actor };
        const event: Event = {
            type: InvestigationEvents.INVESTIGATION_DISMISSED,
            v: 1,
            occurredAt: deps.clock(),
            idempotencyKey: `${InvestigationCommands.DISMISS_INVESTIGATION}:${taskId}:${reportId}`,
            payload,
        };
        return [event];
    };
}

/**
 * Operator commands for direct task lifecycle actions (AP-PAO-001).
 *
 * Both `SkipTask` and `RetryTask` address a single task by id. Only the
 * symbols and payload contracts live here — the orchestrator host owns
 * handler wiring, so the board, worker-api, and tests can reference these
 * without dragging in handler dependencies.
 */
export const TaskOpsCommands = {
    SKIP_TASK: 'SkipTask',
    RETRY_TASK: 'RetryTask',
    /**
     * Operator-driven "this task is good, mark it done" override. Emits
     * `TaskFinished` with the supplied taskId so the projection-tasks
     * subscriber flips `tasks.status='done'`, the dependency store
     * marks the upstream merged, and the card renders as a completed
     * task. Intended for tasks whose flow stalls at a state with no
     * automatic path forward (e.g. an integration-test task whose
     * tester succeeded but the downstream review/commit chain was
     * removed in a flow simplification — the in-flight task lands
     * "stuck approved" with only a Cancel affordance).
     */
    MARK_TASK_COMPLETE: 'MarkTaskComplete',
    /**
     * Operator pre-approval for a dependency-gated task. Fired when the
     * operator clicks Approve on a task still parked `waiting-deps`:
     * sets `tasks.pre_approved = 1` and emits `TaskPreApproved`. When the
     * upstreams merge and the unblock pass re-dispatches the task, the
     * engine's approval gate consumes the flag and auto-starts it — so
     * the operator doesn't have to come back and approve a second time.
     */
    PRE_APPROVE_TASK: 'PreApproveTask',
    /**
     * Operator instructions / remarks added to a task (typically before it
     * starts). Persists `tasks.instructions` and emits `TaskInstructionsSet`;
     * the value is folded into the agent prompt + TASK.md as an
     * `# Operator instructions` block so the developer / reviewer follow it.
     * Idempotent on (taskId): the latest set wins. Pass an empty string to
     * clear.
     */
    SET_TASK_INSTRUCTIONS: 'SetTaskInstructions',
} as const;

export interface SkipTaskPayload {
    readonly taskId: string;
}

export interface RetryTaskPayload {
    readonly taskId: string;
}

export interface MarkTaskCompletePayload {
    readonly taskId: string;
}

export interface PreApproveTaskPayload {
    readonly taskId: string;
}

export interface SetTaskInstructionsPayload {
    readonly taskId: string;
    /** Free-text operator instructions. Empty string clears them. */
    readonly instructions: string;
}

export function isSetTaskInstructionsPayload(
    value: unknown,
): value is SetTaskInstructionsPayload {
    if (!value || typeof value !== 'object') return false;
    const v = value as Record<string, unknown>;
    return (
        typeof v.taskId === 'string' && v.taskId.length > 0
        && typeof v.instructions === 'string'
    );
}

export function isPreApproveTaskPayload(
    value: unknown,
): value is PreApproveTaskPayload {
    if (!value || typeof value !== 'object') return false;
    const v = value as Record<string, unknown>;
    return typeof v.taskId === 'string' && v.taskId.length > 0;
}

export function isSkipTaskPayload(value: unknown): value is SkipTaskPayload {
    if (!value || typeof value !== 'object') return false;
    const v = value as Record<string, unknown>;
    return typeof v.taskId === 'string' && v.taskId.length > 0;
}

export function isRetryTaskPayload(value: unknown): value is RetryTaskPayload {
    if (!value || typeof value !== 'object') return false;
    const v = value as Record<string, unknown>;
    return typeof v.taskId === 'string' && v.taskId.length > 0;
}

export function isMarkTaskCompletePayload(
    value: unknown,
): value is MarkTaskCompletePayload {
    if (!value || typeof value !== 'object') return false;
    const v = value as Record<string, unknown>;
    return typeof v.taskId === 'string' && v.taskId.length > 0;
}

/**
 * Attachment lifecycle (migration 021). The worker-api attachments router
 * writes the uploaded BYTES to the blob store and mints the attachment id,
 * then dispatches one of these so the metadata flows through the event log
 * like every other state change: `AttachToTask` / `AttachToPlan` /
 * `AttachToRequirement` emit
 * `AttachmentAdded`; `RemoveAttachment` emits `AttachmentRemoved`. The
 * orchestrator's attachments-projection subscriber folds those into the
 * `attachments` table (and deletes the blob on removal).
 */
export const AttachmentCommands = {
    ATTACH_TO_TASK: 'AttachToTask',
    ATTACH_TO_PLAN: 'AttachToPlan',
    /**
     * Architect tier: files pinned to a REQUIREMENT as input for the
     * design. Its own command rather than a reused `AttachToPlan`
     * because the architect's synthetic plan id (`req-<requirementId>`)
     * would otherwise store a non-plan id under `owner_type = plan`,
     * and the prompt block would tell the architect it was reading
     * attachments for a plan that does not exist.
     */
    ATTACH_TO_REQUIREMENT: 'AttachToRequirement',
    REMOVE_ATTACHMENT: 'RemoveAttachment',
} as const;

/**
 * Carries the full metadata for an upload that already landed in the blob
 * store. `ownerId` is the task id (AttachToTask) or plan id (AttachToPlan)
 * — the owner *type* is implied by the command. `storageKey` is the opaque
 * key the blob store handed back; `caption` is the operator's optional note.
 */
export interface AttachToOwnerPayload {
    readonly attachmentId: string;
    readonly ownerId: string;
    readonly fileName: string;
    readonly contentType: string;
    readonly sizeBytes: number;
    readonly storageKey: string;
    readonly caption?: string;
    /**
     * Migration 038. 'output' marks a file the TASK produced (harvested
     * from its output folder) rather than one the operator attached.
     * Absent means 'input' - every pre-existing caller is an upload.
     */
    readonly kind?: 'input' | 'output';
}

export interface RemoveAttachmentPayload {
    readonly attachmentId: string;
    readonly ownerType: 'task' | 'plan' | 'requirement';
    readonly ownerId: string;
}

export function isAttachToOwnerPayload(
    value: unknown,
): value is AttachToOwnerPayload {
    if (!value || typeof value !== 'object') return false;
    const v = value as Record<string, unknown>;
    return (
        typeof v.attachmentId === 'string' && v.attachmentId.length > 0
        && typeof v.ownerId === 'string' && v.ownerId.length > 0
        && typeof v.fileName === 'string' && v.fileName.length > 0
        && typeof v.contentType === 'string' && v.contentType.length > 0
        && typeof v.sizeBytes === 'number' && Number.isFinite(v.sizeBytes)
        && typeof v.storageKey === 'string' && v.storageKey.length > 0
        && (v.caption === undefined || typeof v.caption === 'string')
        && (v.kind === undefined || v.kind === 'input' || v.kind === 'output')
    );
}

export function isRemoveAttachmentPayload(
    value: unknown,
): value is RemoveAttachmentPayload {
    if (!value || typeof value !== 'object') return false;
    const v = value as Record<string, unknown>;
    return (
        typeof v.attachmentId === 'string' && v.attachmentId.length > 0
        && (v.ownerType === 'task'
            || v.ownerType === 'plan'
            || v.ownerType === 'requirement')
        && typeof v.ownerId === 'string' && v.ownerId.length > 0
    );
}

/**
 * Operator commands for plan-level retention (AP-PAO-001).
 *
 * `ArchivePlan` hides a plan from active views without destroying its
 * history; `DeletePlan` is the destructive counterpart. Both target a
 * plan by id; handlers live in the orchestrator host alongside the
 * projection that tracks plan retention state.
 */
export const PlanOpsCommands = {
    ARCHIVE_PLAN: 'ArchivePlan',
    UNARCHIVE_PLAN: 'UnarchivePlan',
    DELETE_PLAN: 'DeletePlan',
} as const;

export interface ArchivePlanPayload {
    readonly planId: string;
}

export interface UnarchivePlanPayload {
    readonly planId: string;
}

export interface DeletePlanPayload {
    readonly planId: string;
}

export function isArchivePlanPayload(value: unknown): value is ArchivePlanPayload {
    if (!value || typeof value !== 'object') return false;
    const v = value as Record<string, unknown>;
    return typeof v.planId === 'string' && v.planId.length > 0;
}

export function isUnarchivePlanPayload(value: unknown): value is UnarchivePlanPayload {
    if (!value || typeof value !== 'object') return false;
    const v = value as Record<string, unknown>;
    return typeof v.planId === 'string' && v.planId.length > 0;
}

export function isDeletePlanPayload(value: unknown): value is DeletePlanPayload {
    if (!value || typeof value !== 'object') return false;
    const v = value as Record<string, unknown>;
    return typeof v.planId === 'string' && v.planId.length > 0;
}

/**
 * Operator command for editing a project's per-flow approval-gate
 * overrides (AP-PAO-001).
 *
 * `approvalOverride` is a two-level map keyed by flow name then step id.
 * Each leaf is a tri-state telling the flow engine whether that step's
 * approval gate should be forced `auto` (skip the gate), forced
 * `required` (always pause), or left at the flow's `default` (engine
 * decides). Unknown flow names / step ids are tolerated so a stored
 * override can survive a flow rename without blocking other gates;
 * absent entries are treated as `'default'` by the engine.
 */
export const ProjectOpsCommands = {
    UPDATE_PROJECT_APPROVAL_OVERRIDE: 'UpdateProjectApprovalOverride',
} as const;

export type ApprovalOverrideValue = 'auto' | 'required' | 'default';

export type ApprovalOverride = {
    readonly [flowName: string]: {
        readonly [stepId: string]: ApprovalOverrideValue;
    };
};

export interface UpdateProjectApprovalOverridePayload {
    readonly projectId: string;
    readonly approvalOverride: ApprovalOverride;
}

const APPROVAL_OVERRIDE_VALUES: ReadonlySet<string> = new Set([
    'auto',
    'required',
    'default',
]);

export function isApprovalOverride(value: unknown): value is ApprovalOverride {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    for (const stepMap of Object.values(value as Record<string, unknown>)) {
        if (!stepMap || typeof stepMap !== 'object' || Array.isArray(stepMap)) {
            return false;
        }
        for (const leaf of Object.values(stepMap as Record<string, unknown>)) {
            if (typeof leaf !== 'string' || !APPROVAL_OVERRIDE_VALUES.has(leaf)) {
                return false;
            }
        }
    }
    return true;
}

export function isUpdateProjectApprovalOverridePayload(
    value: unknown,
): value is UpdateProjectApprovalOverridePayload {
    if (!value || typeof value !== 'object') return false;
    const v = value as Record<string, unknown>;
    if (typeof v.projectId !== 'string' || v.projectId.length === 0) return false;
    return isApprovalOverride(v.approvalOverride);
}

/**
 * AP-VP5-001 — investigation follow-up + note conversion commands.
 *
 * `AskInvestigationFollowup` is a thin operator-facing alias for the
 * follow-up dispatch path: it carries just the `(taskId, question)` pair
 * so chat / board callers can express the intent without building the
 * fuller {@link RequestInvestigationFollowupPayload} (which also accepts
 * cached prior-brief / prior-report bodies). A subscriber translates
 * `AskInvestigationFollowup` into the existing follow-up flow.
 *
 * `PromoteNoteToPlan` and `ConvertNoteToInvestigation` are operator
 * actions on the per-project Notes board: one promotes a free-form note
 * into a real plan brief, the other spawns an investigation rooted at
 * the note's content. Both commands address the note by
 * `(projectId, noteId)` and let downstream subscribers resolve the body.
 */
export const NoteOpsCommands = {
    ASK_INVESTIGATION_FOLLOWUP: 'AskInvestigationFollowup',
    PROMOTE_NOTE_TO_PLAN: 'PromoteNoteToPlan',
    CONVERT_NOTE_TO_INVESTIGATION: 'ConvertNoteToInvestigation',
} as const;

export interface AskInvestigationFollowupPayload {
    readonly taskId: string;
    readonly question: string;
}

export interface PromoteNoteToPlanPayload {
    readonly projectId: string;
    readonly noteId: string;
}

export interface ConvertNoteToInvestigationPayload {
    readonly projectId: string;
    readonly noteId: string;
}

export function isAskInvestigationFollowupPayload(
    value: unknown,
): value is AskInvestigationFollowupPayload {
    if (!value || typeof value !== 'object') return false;
    const v = value as Record<string, unknown>;
    if (typeof v.taskId !== 'string' || v.taskId.length === 0) return false;
    if (typeof v.question !== 'string' || v.question.length === 0) return false;
    return true;
}

export function isPromoteNoteToPlanPayload(
    value: unknown,
): value is PromoteNoteToPlanPayload {
    if (!value || typeof value !== 'object') return false;
    const v = value as Record<string, unknown>;
    if (typeof v.projectId !== 'string' || v.projectId.length === 0) return false;
    if (typeof v.noteId !== 'string' || v.noteId.length === 0) return false;
    return true;
}

export function isConvertNoteToInvestigationPayload(
    value: unknown,
): value is ConvertNoteToInvestigationPayload {
    if (!value || typeof value !== 'object') return false;
    const v = value as Record<string, unknown>;
    if (typeof v.projectId !== 'string' || v.projectId.length === 0) return false;
    if (typeof v.noteId !== 'string' || v.noteId.length === 0) return false;
    return true;
}
