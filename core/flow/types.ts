/**
 * Flow definition types.
 *
 * A FlowDefinition describes how a task progresses through agent roles in
 * response to a triggering event. It is loaded from a YAML file by
 * `loader.ts` and consumed by the orchestrator: given the current step and
 * the outcome of the agent run for that step, the flow picks the next step
 * or emits a terminal event.
 *
 * Transition targets are strings. Two forms are accepted:
 *
 *   1. The `id` of another step in the same flow — control transfers there.
 *   2. The literal `emit:<EventType>` — the flow terminates by publishing an
 *      event of that type onto the bus. No further step in this flow runs.
 *
 * `on_success` is required on every step (a step that never proceeds is a
 * structural mistake — emit an event instead). `on_question` and
 * `on_failure` are optional; when omitted, those outcomes propagate to a
 * default handler chosen by the orchestrator.
 */

export interface FlowStep {
  readonly id: string;
  /**
   * Step kind. For agent steps this is the agent role (`developer`,
   * `reviewer`, …). For gateway-dispatched steps it is the literal
   * step type (`pr.open`, `pr.merge`) — the flow engine inspects this
   * value to decide whether to dispatch a StartAgent command or invoke
   * a port directly.
   */
  readonly agent: string;
  readonly model: string;
  readonly on_success: string;
  readonly on_question?: string;
  readonly on_failure?: string;
  /**
   * Step-scoped parameters. For agent steps these are forwarded onto
   * the StartAgent command context. For gateway-dispatched steps they
   * carry the call arguments (e.g. `{title, body, base, head}` for
   * `pr.open`).
   */
  readonly params?: Readonly<Record<string, unknown>>;
  /**
   * AP-VP-001: per-step approval gate. When `'required'`, the flow engine
   * waits for an operator approval before dispatching this step; when
   * `'auto'`, the step proceeds without operator interaction. When the
   * field is **absent**, the engine falls back to {@link BUILT_IN_APPROVAL_DEFAULTS}
   * for the step kind, and finally to `'auto'` for agent steps whose
   * `agent` value is a free-form role (developer, reviewer, …).
   */
  readonly approval?: FlowStepApproval;
}

export interface FlowDefinition {
  /** Event type that triggers this flow (e.g. `task.created`). */
  readonly on: string;
  /** Optional predicate expression — flow only fires when truthy. */
  readonly when?: string;
  /**
   * AP-IFG-002: when the flow engine should dispatch the first agent step.
   *
   * - `'auto'` — dispatch on `TaskCreated`, no operator approval required.
   * - `'approval-required'` — wait for `TaskApproved` (current behaviour).
   *
   * When the field is **absent**, the engine treats the flow as
   * `'approval-required'` for backwards compatibility — pre-AP-IFG-002 flows
   * must not silently auto-dispatch.
   */
  readonly start_mode?: FlowStartMode;
  /** Ordered steps. `steps[0]` is the entry point. */
  readonly steps: readonly FlowStep[];
  /**
   * What this flow is AS A TASK TYPE (flow id == task type). Absent on
   * flows that are never a task's own type (sub-flows such as `merge` or
   * `worktree-diff-review`).
   *
   * This block is the single source of truth for every per-type fact the
   * pipeline used to keep in hand-maintained lists — the decomposer's
   * allowed set, the code-writing set behind the plan verify gate, the
   * shared-deploy-worktree set, the board's Add-task menu. Five lists that
   * had to agree kept disagreeing (a type in the persona and the flows but
   * not the validator failed real decompositions); one declaration per
   * flow cannot. It is also what lets a stack pack add a task type just by
   * shipping its flow.
   */
  readonly task_type?: TaskTypeMeta;
}

/** Where a task's agents run. See {@link TaskTypeMeta.worktree}. */
export type TaskWorktreeKind = 'task' | 'shared-deploy' | 'workspace-root';

export interface TaskTypeMeta {
  /** Operator-facing name (board menus). Defaults to the flow id. */
  readonly label?: string;
  /** The decomposer may emit this type. Default false. */
  readonly decomposable: boolean;
  /**
   * The task's landed work changes code — a plan containing one gets the
   * plan-level `verify-plan` gate. Default false.
   */
  readonly writes_code: boolean;
  /**
   * `task` (default): a throwaway per-task worktree. `shared-deploy`: the
   * repo's ONE long-lived detached deploy worktree — only for types that
   * commit nothing, where a fresh checkout would cold-rebuild every run.
   * `workspace-root`: no worktree at all — the agent runs rooted at the
   * workspace repos DIRECTORY (the parent, never a clone), because the
   * fault it is chasing may live in any repo or in shared infrastructure.
   * Only for types whose agent cannot write.
   */
  readonly worktree: TaskWorktreeKind;
  /** Offered in the board's "Add task" menu. Default false. */
  readonly add_task: boolean;
  /**
   * The deliverable is an operator-readable REPORT rather than a commit.
   * Gates the board's View-report button: a type with no report has
   * nothing to open, and the button used to render anyway and show a
   * "no report has been recorded" placeholder. Default false.
   */
  readonly produces_report: boolean;
  /**
   * The chat assistant may propose this type in a `PROPOSE_TASK` block.
   *
   * Deliberately its own flag rather than a rule over the others: the chat
   * set is CURATED — it offered `diagnose-azure` but not `review-azure`,
   * and no combination of `decomposable` / `add_task` reproduces that
   * split. Default false.
   */
  readonly chat_proposable: boolean;
  /**
   * Lower-case words the model reaches for that mean this type. The chat
   * parser normalises `Type: diagnose` to whichever type claims it, rather
   * than falling back to `implement` and quietly filing the wrong work.
   */
  readonly synonyms: readonly string[];
}

/**
 * Closed union of accepted {@link FlowDefinition.start_mode} values. The
 * loader rejects any other string with a clear error so a typo in YAML
 * never silently downgrades a flow to legacy behaviour.
 */
export const FLOW_START_MODES = {
  AUTO: 'auto',
  APPROVAL_REQUIRED: 'approval-required',
} as const;

export type FlowStartMode = (typeof FLOW_START_MODES)[keyof typeof FLOW_START_MODES];

const FLOW_START_MODE_VALUES: ReadonlySet<string> = new Set(
  Object.values(FLOW_START_MODES),
);

/** True when `value` is a member of the closed `FlowStartMode` union. */
export function isFlowStartMode(value: string): value is FlowStartMode {
  return FLOW_START_MODE_VALUES.has(value);
}

/**
 * Non-agent step kinds (AP-IFW-002). These appear as string literals in the
 * `agent` field of a {@link FlowStep} and signal to the flow engine that the
 * step is a control-flow primitive rather than a Claude invocation.
 *
 * - `wait-action` parks the task until an operator dispatches `ResumeTask`.
 *   The engine emits a {@link FlowEvents.TASK_PARKED} event with
 *   `reason: 'wait-action'`. The task remains in this step until resumed.
 *
 * - `wait-merged` parks the task until an external signal (PR merged in the
 *   target repo) flips a `ResumeTask` for it. Same TaskParked semantics; the
 *   `reason` discriminator is `'wait-merged'` so the board can render a
 *   "waiting for merge" card instead of the generic action one.
 *
 * - `run-script` dispatches via the injected {@link ScriptRunner} port:
 *   the engine awaits the run, publishes `ScriptFinished{ exitCode,
 *   stdoutPath }`, and routes to `on_success` when `exitCode === 0` else
 *   `on_failure`. Not a pass-through; the step waits for the script.
 *
 * - `verify` dispatches via the injected {@link HealthProbe} port: the
 *   engine awaits the probe, publishes `VerifyFinished{ ok }`, and routes
 *   to `on_success` when `ok` is true else `on_failure`. Not a pass-through.
 *
 * - `report-only` is a terminal-shaped pass-through — useful for review
 *   flows where the agent already emitted its report and the flow needs an
 *   explicit "publish & finish" step before `emit:TaskFinished`.
 *
 * - `context-update` dispatches via the injected {@link AgentRunner} port
 *   with `role: 'curator'`. The engine spawns the curator run; the
 *   runner's `AgentFinished` event routes via the existing handler. Not a
 *   pass-through.
 *
 * - `merge` is the agent-prompt-shaped alias for `pr.merge` (see
 *   `PR_STEP_TYPES.MERGE` in engine.ts) — declarative YAML reads better
 *   with `agent: merge` than the dotted form, and the engine handles both.
 */
export const FLOW_STEP_KINDS = {
  WAIT_ACTION: 'wait-action',
  WAIT_MERGED: 'wait-merged',
  RUN_SCRIPT: 'run-script',
  VERIFY: 'verify',
  REPORT_ONLY: 'report-only',
  CONTEXT_UPDATE: 'context-update',
  MERGE: 'merge',
  /**
   * Auto variants of the two operator gates. `commit-auto` replaces a
   * `worktree-diff-review` step: pure pass-through — the task chains
   * straight to `on_success` (usually `commit`) without parking for the
   * pre-commit diff review. `merge-auto` replaces `wait-merged`: the task
   * still parks in the same wait-merged state (so board/Telegram render
   * consistently and manual Merge PR keeps working as a fallback), but
   * the engine also emits `AutoMergeRequested` and the orchestrator
   * merges the PR as soon as the post-commit hook has opened it.
   */
  COMMIT_AUTO: 'commit-auto',
  MERGE_AUTO: 'merge-auto',
} as const;

export type FlowStepKind = (typeof FLOW_STEP_KINDS)[keyof typeof FLOW_STEP_KINDS];

const WAIT_STEP_KINDS: ReadonlySet<string> = new Set([
  FLOW_STEP_KINDS.WAIT_ACTION,
  FLOW_STEP_KINDS.WAIT_MERGED,
  // merge-auto parks exactly like wait-merged (same resume path, same
  // board state); the auto-merge is driven by the AutoMergeRequested
  // event the engine publishes alongside the park.
  FLOW_STEP_KINDS.MERGE_AUTO,
]);

const PASS_THROUGH_STEP_KINDS: ReadonlySet<string> = new Set([
  FLOW_STEP_KINDS.REPORT_ONLY,
  // commit-auto: the skip-the-diff-review gate — nothing to run, nothing
  // to park; chain straight to on_success.
  FLOW_STEP_KINDS.COMMIT_AUTO,
]);

/** True when entering this step should park the task pending a ResumeTask. */
export function isWaitStepKind(agent: string): boolean {
  return WAIT_STEP_KINDS.has(agent);
}

/**
 * True when entering this step should chain straight through to `on_success`
 * without dispatching an agent or external port.
 */
export function isPassThroughStepKind(agent: string): boolean {
  return PASS_THROUGH_STEP_KINDS.has(agent);
}

/**
 * Closed union of accepted {@link FlowStep.approval} values (AP-VP-001).
 *
 * - `'required'` — operator must approve the step before the engine
 *   dispatches it. The engine emits `TaskParked` with the step's kind as
 *   the reason discriminator, awaiting `ResumeTask` from the board.
 * - `'auto'` — the step runs without operator interaction.
 *
 * Loader rejects any other string with a clear error so a typo in YAML
 * never silently downgrades a step's approval gate.
 */
export const FLOW_STEP_APPROVALS = {
  AUTO: 'auto',
  REQUIRED: 'required',
} as const;

export type FlowStepApproval =
  (typeof FLOW_STEP_APPROVALS)[keyof typeof FLOW_STEP_APPROVALS];

const FLOW_STEP_APPROVAL_VALUES: ReadonlySet<string> = new Set(
  Object.values(FLOW_STEP_APPROVALS),
);

/** True when `value` is a member of the closed `FlowStepApproval` union. */
export function isFlowStepApproval(value: string): value is FlowStepApproval {
  return FLOW_STEP_APPROVAL_VALUES.has(value);
}

/**
 * PR-gateway step types whose default approval gate the loader and engine
 * need to consult when {@link FlowStep.approval} is absent. These mirror
 * the engine's `PR_STEP_TYPES` but live in `types.ts` so the defaults
 * table can stay next to FLOW_STEP_KINDS without forcing types.ts to
 * import engine.ts (which would invert the existing direction).
 */
export const PR_GATEWAY_STEP_KINDS = {
  OPEN: 'pr.open',
  MERGE: 'pr.merge',
} as const;

export type PrGatewayStepKind =
  (typeof PR_GATEWAY_STEP_KINDS)[keyof typeof PR_GATEWAY_STEP_KINDS];

/**
 * Closed union of every step kind that ships with a built-in approval
 * default — the FLOW_STEP_KINDS members plus the PR-gateway step types
 * (`pr.open`, `pr.merge`). Agent steps (developer, reviewer, …) are
 * intentionally excluded: their `agent` value is free-form, so the
 * engine falls back to `'auto'` for any value not present in this union.
 */
export type ApprovalDefaultKind = FlowStepKind | PrGatewayStepKind;

/**
 * AP-VP-001: built-in approval gate defaults, keyed by step kind.
 *
 * The loader and engine both consume this table when a step's
 * {@link FlowStep.approval} is absent. Operator-gated verbs
 * (`wait-action`, `pr.open`, `pr.merge`, `merge` — the alias for
 * `pr.merge`) default to `'required'`; pass-through and externally-
 * resumed verbs default to `'auto'`. Agent steps whose `agent` value
 * is not present in this table fall through to `'auto'` in the engine.
 *
 * The Readonly<Record<ApprovalDefaultKind, …>> annotation makes the
 * table exhaustive over the closed union at the type level: adding a
 * new step kind without registering a default here is a compile error,
 * and unknown keys (e.g. a typo'd `'pr.opne'`) are rejected because
 * Record's key type is ApprovalDefaultKind.
 */
export const BUILT_IN_APPROVAL_DEFAULTS: Readonly<
  Record<ApprovalDefaultKind, FlowStepApproval>
> = {
  [FLOW_STEP_KINDS.WAIT_ACTION]: FLOW_STEP_APPROVALS.REQUIRED,
  [FLOW_STEP_KINDS.WAIT_MERGED]: FLOW_STEP_APPROVALS.AUTO,
  [FLOW_STEP_KINDS.RUN_SCRIPT]: FLOW_STEP_APPROVALS.AUTO,
  [FLOW_STEP_KINDS.VERIFY]: FLOW_STEP_APPROVALS.AUTO,
  [FLOW_STEP_KINDS.REPORT_ONLY]: FLOW_STEP_APPROVALS.AUTO,
  [FLOW_STEP_KINDS.CONTEXT_UPDATE]: FLOW_STEP_APPROVALS.AUTO,
  [FLOW_STEP_KINDS.MERGE]: FLOW_STEP_APPROVALS.REQUIRED,
  [FLOW_STEP_KINDS.COMMIT_AUTO]: FLOW_STEP_APPROVALS.AUTO,
  [FLOW_STEP_KINDS.MERGE_AUTO]: FLOW_STEP_APPROVALS.AUTO,
  [PR_GATEWAY_STEP_KINDS.OPEN]: FLOW_STEP_APPROVALS.REQUIRED,
  [PR_GATEWAY_STEP_KINDS.MERGE]: FLOW_STEP_APPROVALS.REQUIRED,
} as const;
