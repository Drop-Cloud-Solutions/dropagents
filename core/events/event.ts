/**
 * Event payload types for the append-only event log.
 *
 * `Event` is the producer-facing shape supplied to EventStore.append. The
 * `seq` column is server-assigned by SQLite's AUTOINCREMENT, so callers
 * never supply it on input — they receive it back from `append` and see
 * it on every record returned from `readAfter`.
 *
 * `idempotencyKey` is the producer-supplied de-dup token. A second append
 * with the same key returns the original assigned seq without inserting
 * a new row (UNIQUE constraint on events.idempotency_key in the schema).
 *
 * `payload` is persisted as JSON in the `payload` TEXT column. `type` and
 * `v` are dedicated columns so consumers can filter without parsing the
 * blob.
 *
 * `occurredAt` is a unix-epoch millisecond timestamp, matching the schema
 * convention documented in core/state/schema.sql.
 *
 * `Event` is a discriminated union: each known variant pins its `type`
 * field to a string literal and tightens `payload` to a specific shape so
 * subscribers can narrow on `event.type` and reach typed fields without
 * extra assertions. Producers emitting an event whose payload shape is
 * not yet captured in the union fall through to `UnknownEvent`, the open
 * envelope that preserves the pre-AP-PAO-002 shape (`type: string`,
 * `payload: unknown`).
 */

/**
 * Open envelope used by producers whose payload shape is not yet captured
 * as a discriminated variant. Acts as the catch-all in the `Event` union
 * so existing emitters (Track-04 lifecycle, flow-engine internals, host
 * adapters) keep type-checking unchanged.
 */
export interface UnknownEvent {
    type: string;
    v: number;
    occurredAt: number;
    idempotencyKey: string;
    payload: unknown;
}

// ---------------------------------------------------------------------------
// AP-PAO-002 — discriminated event variants
// ---------------------------------------------------------------------------

export interface TaskSkippedPayload {
    readonly taskId: string;
}

export interface TaskSkipped extends UnknownEvent {
    readonly type: 'TaskSkipped';
    readonly payload: TaskSkippedPayload;
}

export interface TaskRetriedPayload {
    readonly taskId: string;
}

export interface TaskRetried extends UnknownEvent {
    readonly type: 'TaskRetried';
    readonly payload: TaskRetriedPayload;
}

export interface PlanArchivedPayload {
    readonly planId: string;
}

export interface PlanArchived extends UnknownEvent {
    readonly type: 'PlanArchived';
    readonly payload: PlanArchivedPayload;
}

export interface PlanUnarchivedPayload {
    readonly planId: string;
}

export interface PlanUnarchived extends UnknownEvent {
    readonly type: 'PlanUnarchived';
    readonly payload: PlanUnarchivedPayload;
}

export interface PlanDeletedPayload {
    readonly planId: string;
}

export interface PlanDeleted extends UnknownEvent {
    readonly type: 'PlanDeleted';
    readonly payload: PlanDeletedPayload;
}

/**
 * Operator-driven override of a project's natural approval state.
 * `'approve'` / `'reject'` set an explicit decision; `null` clears any
 * prior override and falls back to the underlying state.
 */
export type ProjectApprovalOverride = 'approve' | 'reject' | null;

export interface ProjectApprovalOverrideUpdatedPayload {
    readonly projectId: string;
    readonly approvalOverride: ProjectApprovalOverride;
}

export interface ProjectApprovalOverrideUpdated extends UnknownEvent {
    readonly type: 'ProjectApprovalOverrideUpdated';
    readonly payload: ProjectApprovalOverrideUpdatedPayload;
}

// ---------------------------------------------------------------------------
// AP-VP4-001 — PlanGenerated / PlanDecomposed payload extensions
//
// Events are append-only. Old PlanGenerated events were emitted with the
// pre-extension payload shape `{ planId, projectId, briefId?, actor }`
// (see `PlanGeneratedEventPayload` in core/commands/index.ts) and are
// already persisted in the store. The new shape adds the producer-facing
// fields `revision`, `content`, `feedback`, `previousRevision`.
//
// All new fields are declared optional so a replayed old-shape event
// type-checks as a `PlanGenerated` variant without coercion. Consumers
// that need a numeric revision for an old event should treat
// `revision === undefined` as revision 1 (the implicit initial draft).
//
// The pre-extension fields (`projectId`, `briefId`, `actor`) are
// preserved as optional on the payload so the existing emitter in
// core/commands/index.ts still type-checks when it constructs an event
// with `type: 'PlanGenerated'` and the legacy payload shape.
// ---------------------------------------------------------------------------

export interface PlanGeneratedPayload {
    readonly planId: string;
    /** Monotonically-incrementing revision number for this plan. Absent
     *  on pre-extension events; consumers should treat absence as 1. */
    readonly revision?: number;
    /** Rendered plan body the planner produced for this revision. */
    readonly content?: string;
    /** Operator feedback that triggered this revision, when the
     *  PlanGenerated was emitted in response to a rejection. */
    readonly feedback?: string;
    /** Revision number that this PlanGenerated supersedes, when
     *  produced as a follow-up to operator feedback. */
    readonly previousRevision?: number;
    /** Pre-extension audit field — originating project id. */
    readonly projectId?: string;
    /** Pre-extension audit field — originating brief id. */
    readonly briefId?: string;
    /** Pre-extension audit field — operator who triggered the event. */
    readonly actor?: string;
}

export interface PlanGenerated extends UnknownEvent {
    readonly type: 'PlanGenerated';
    readonly payload: PlanGeneratedPayload;
}

/**
 * Structural shape of a single task in a PlanDecomposed payload.
 *
 * Kept as a flat structural type — deliberately NOT a reference to a
 * domain `Task` class — so the event log stays decoupled from in-memory
 * representations that may evolve independently. New optional fields can
 * be added here without breaking older replayed events.
 */
export interface PlanDecomposedTask {
    readonly id: string;
    readonly title: string;
    readonly type: string;
    readonly dependencies: readonly string[];
    readonly description: string;
    /** Optional archetype tag describing the task's pipeline shape
     *  (e.g. `scaffold`, `docs`). */
    readonly archetype?: string;
    // ---- Structured ticket fields (all optional; lifted verbatim from the
    // decomposer's context block — absent on pre-extension events). The
    // `description` above stays the untouched implementation brief. ----
    /** 1–2 sentence outcome statement in feature terms (the "why/what"). */
    readonly goal?: string;
    /**
     * Workspace repo this task's files live in, resolved from the
     * decomposer's `context.repo_path` against the repo registry. When
     * present it OVERRIDES the plan's `metadata.targetRepo` for worktree
     * creation — the planner may discover mid-plan that the change lives
     * in a different repo than the plan was filed under.
     */
    readonly repoId?: string;
    /** Verifiable acceptance criteria (`context.acceptance_criteria`). */
    readonly acceptanceCriteria?: readonly string[];
    readonly filesToCreate?: readonly string[];
    readonly filesToModify?: readonly string[];
    readonly filesToDelete?: readonly string[];
    /**
     * The decomposer's `test.commands` — how to verify THIS task.
     *
     * These used to be validated and then dropped: nothing lifted the
     * `test` block off the decomposer's output, so it reached neither the
     * task row nor TASK.md, while the tester persona told the agent to
     * read "the test commands" from a TASK.md that had never contained
     * them. The tester therefore inferred a command, and what it inferred
     * for a PowerShell repo was the whole suite.
     */
    readonly testCommands?: readonly string[];
}

export interface PlanDecomposedPayload {
    readonly planId: string;
    /** Tasks the decomposer produced for this plan. Absent on
     *  pre-extension events so the variant still type-checks for replays
     *  of the old `{ planId, projectId, actor }` shape. */
    readonly tasks?: readonly PlanDecomposedTask[];
    /** Pre-extension audit field — originating project id. */
    readonly projectId?: string;
    /** Pre-extension audit field — operator who triggered the event. */
    readonly actor?: string;
    /** Plan revision this decomposition ran against. Scopes the
     *  downstream TaskCreated idempotency keys so a re-decompose of
     *  the same plan emits a fresh task set instead of getting
     *  silently dropped by the events table UNIQUE constraint. */
    readonly revision?: number;
}

export interface PlanDecomposed extends UnknownEvent {
    readonly type: 'PlanDecomposed';
    readonly payload: PlanDecomposedPayload;
}

// ---------------------------------------------------------------------------
// AP-VP5-001 — clarification, investigation-follow-up, and notes events
//
// Five additional discriminated variants carry the operator/agent
// clarification handshake and the per-project Notes board lifecycle.
// All shapes use unix-epoch millisecond timestamps (matching
// `occurredAt`) and live on `KnownEvent` so consumers can narrow on
// `event.type` without an extra cast.
// ---------------------------------------------------------------------------

export interface ClarificationRequestedPayload {
    readonly taskId: string;
    readonly question: string;
    /** Optional enumerated choices the agent offered (e.g. ['A', 'B']). */
    readonly choices?: readonly string[];
    /** Unix-epoch ms at which the agent asked the question. */
    readonly askedAt: number;
}

export interface ClarificationRequested extends UnknownEvent {
    readonly type: 'ClarificationRequested';
    readonly payload: ClarificationRequestedPayload;
}

export interface ClarificationAnsweredPayload {
    readonly taskId: string;
    readonly answer: string;
    /** Operator's "remember this answer" intent, mirroring
     *  {@link import('../commands/index').ResumeTaskPayload.remember}. */
    readonly remember: boolean;
    readonly answeredAt: number;
}

export interface ClarificationAnswered extends UnknownEvent {
    readonly type: 'ClarificationAnswered';
    readonly payload: ClarificationAnsweredPayload;
}

export interface InvestigationFollowupAskedPayload {
    readonly taskId: string;
    /** Identifier for the follow-up conversation thread on a task. */
    readonly threadId: string;
    readonly question: string;
    readonly askedAt: number;
}

export interface InvestigationFollowupAsked extends UnknownEvent {
    readonly type: 'InvestigationFollowupAsked';
    readonly payload: InvestigationFollowupAskedPayload;
}

/**
 * Shared lifecycle payload for the per-project notes board.
 *
 * `content` is optional so a `NoteDeleted` event can elide the body
 * entirely and an update can carry only metadata. `timestamp` is the
 * unix-epoch ms when the action occurred (board / chat may differ from
 * `occurredAt` if the event is replayed).
 */
export interface NoteLifecyclePayload {
    readonly projectId: string;
    readonly noteId: string;
    readonly content?: string;
    readonly timestamp: number;
}

export interface NoteCreated extends UnknownEvent {
    readonly type: 'NoteCreated';
    readonly payload: NoteLifecyclePayload;
}

export interface NoteUpdated extends UnknownEvent {
    readonly type: 'NoteUpdated';
    readonly payload: NoteLifecyclePayload;
}

// ---------------------------------------------------------------------------
// Repo registry — workspace-level repo lifecycle.
//
// Repos are first-class entities at the workspace root, not nested under
// projects. Many repos are shared across projects (microservice-style
// codebases), so a single registry keeps disk usage / sync logic
// deduplicated. Projects link to repos by id; plans pick a primary repo
// from the project's linked set.
// ---------------------------------------------------------------------------

/**
 * Payload shared by `RepoRegistered` and `RepoUpdated`. The two are
 * distinguished by event type rather than payload shape so a single
 * fold path can serve both, and the operator surface can tell create
 * vs update apart for UI affordances (e.g. "added" vs "edited" toast).
 */
export interface RepoLifecyclePayload {
    readonly repoId: string;
    readonly name: string;
    readonly url: string;
    /** Default branch the agents read from. Falls back to `'main'`. */
    readonly defaultBranch?: string;
    /**
     * Which declared GitHub account reaches this repo
     * (`github_accounts:` in pipeline.yaml). Absent means the machine's
     * ambient `gh` identity — what every repo used before accounts
     * existed, and still the default.
     *
     * An id that no longer resolves degrades to that same ambient
     * identity rather than to another account: a mapping typo must
     * not silently push to the wrong GitHub account.
     */
    readonly githubAccount?: string;
    readonly actor: string;
}

export interface RepoRegistered extends UnknownEvent {
    readonly type: 'RepoRegistered';
    readonly payload: RepoLifecyclePayload;
}

export interface RepoUpdated extends UnknownEvent {
    readonly type: 'RepoUpdated';
    readonly payload: RepoLifecyclePayload;
}

export interface RepoArchivedPayload {
    readonly repoId: string;
    readonly actor: string;
}

export interface RepoArchived extends UnknownEvent {
    readonly type: 'RepoArchived';
    readonly payload: RepoArchivedPayload;
}

/**
 * Emitted by the RepoEnsureSubscriber when an initial `gh repo clone`
 * succeeds. Carries the absolute path the clone landed at so the
 * projection can store it without re-deriving from RepoFetcher's
 * convention rules.
 */
export interface RepoEnsuredPayload {
    readonly repoId: string;
    readonly ensuredPath: string;
    /** Epoch ms the clone completed. */
    readonly at: number;
}

export interface RepoEnsured extends UnknownEvent {
    readonly type: 'RepoEnsured';
    readonly payload: RepoEnsuredPayload;
}

/**
 * Emitted when the clone step fails. The board surfaces the error so
 * the operator can fix `gh auth` / network / GitHub access before
 * trying to plan against the repo.
 */
export interface RepoEnsureFailedPayload {
    readonly repoId: string;
    readonly error: string;
    readonly at: number;
}

export interface RepoEnsureFailed extends UnknownEvent {
    readonly type: 'RepoEnsureFailed';
    readonly payload: RepoEnsureFailedPayload;
}

/**
 * Emitted after a successful `git fetch && git reset --hard` against
 * the default branch. Pre-spawn refresh in `startLifecycleAgent`
 * publishes this so the projection's `last_synced_at` reflects the
 * snapshot the agent actually saw.
 */
export interface RepoSyncedPayload {
    readonly repoId: string;
    readonly at: number;
}

export interface RepoSynced extends UnknownEvent {
    readonly type: 'RepoSynced';
    readonly payload: RepoSyncedPayload;
}

/**
 * Emitted on refresh failure. The planner proceeds with stale content
 * (operator chose this policy); the projection records the error so
 * the operator sees the staleness on the board.
 */
export interface RepoSyncFailedPayload {
    readonly repoId: string;
    readonly error: string;
    readonly at: number;
}

export interface RepoSyncFailed extends UnknownEvent {
    readonly type: 'RepoSyncFailed';
    readonly payload: RepoSyncFailedPayload;
}

export interface NoteDeleted extends UnknownEvent {
    readonly type: 'NoteDeleted';
    readonly payload: NoteLifecyclePayload;
}

// ---------------------------------------------------------------------------
// Unions
// ---------------------------------------------------------------------------

/**
 * Discriminated union of every event variant whose payload shape is
 * captured in this module. Useful when a consumer wants strict narrowing
 * on `type` without the `UnknownEvent` fallback widening `payload` back
 * to `unknown`.
 */
export type KnownEvent =
    | TaskSkipped
    | TaskRetried
    | PlanArchived
    | PlanUnarchived
    | PlanDeleted
    | ProjectApprovalOverrideUpdated
    | PlanGenerated
    | PlanDecomposed
    | ClarificationRequested
    | ClarificationAnswered
    | InvestigationFollowupAsked
    | NoteCreated
    | NoteUpdated
    | NoteDeleted
    | RepoRegistered
    | RepoUpdated
    | RepoArchived
    | RepoEnsured
    | RepoEnsureFailed
    | RepoSynced
    | RepoSyncFailed;

/**
 * Producer-facing event type. Includes the discriminated `KnownEvent`
 * variants plus the open `UnknownEvent` envelope so callers emitting
 * events whose payload shape is not (yet) in the union still type-check.
 */
export type Event = KnownEvent | UnknownEvent;

export type StoredEvent = Event & { seq: number };

// ---------------------------------------------------------------------------
// Type predicates — handy when narrowing inside a generic `Event` handler
// because the `UnknownEvent` catch-all otherwise widens `payload` to
// `unknown` even after a literal `type` check.
// ---------------------------------------------------------------------------

export function isTaskSkipped(event: Event): event is TaskSkipped {
    return event.type === 'TaskSkipped';
}

export function isTaskRetried(event: Event): event is TaskRetried {
    return event.type === 'TaskRetried';
}

export function isPlanArchived(event: Event): event is PlanArchived {
    return event.type === 'PlanArchived';
}

export function isPlanUnarchived(event: Event): event is PlanUnarchived {
    return event.type === 'PlanUnarchived';
}

export function isPlanDeleted(event: Event): event is PlanDeleted {
    return event.type === 'PlanDeleted';
}

export function isProjectApprovalOverrideUpdated(
    event: Event,
): event is ProjectApprovalOverrideUpdated {
    return event.type === 'ProjectApprovalOverrideUpdated';
}

export function isPlanGenerated(event: Event): event is PlanGenerated {
    return event.type === 'PlanGenerated';
}

export function isPlanDecomposed(event: Event): event is PlanDecomposed {
    return event.type === 'PlanDecomposed';
}

export function isClarificationRequested(event: Event): event is ClarificationRequested {
    return event.type === 'ClarificationRequested';
}

export function isClarificationAnswered(event: Event): event is ClarificationAnswered {
    return event.type === 'ClarificationAnswered';
}

export function isInvestigationFollowupAsked(
    event: Event,
): event is InvestigationFollowupAsked {
    return event.type === 'InvestigationFollowupAsked';
}

export function isNoteCreated(event: Event): event is NoteCreated {
    return event.type === 'NoteCreated';
}

export function isNoteUpdated(event: Event): event is NoteUpdated {
    return event.type === 'NoteUpdated';
}

export function isNoteDeleted(event: Event): event is NoteDeleted {
    return event.type === 'NoteDeleted';
}

export function isRepoRegistered(event: Event): event is RepoRegistered {
    return event.type === 'RepoRegistered';
}

export function isRepoUpdated(event: Event): event is RepoUpdated {
    return event.type === 'RepoUpdated';
}

export function isRepoArchived(event: Event): event is RepoArchived {
    return event.type === 'RepoArchived';
}

export function isRepoEnsured(event: Event): event is RepoEnsured {
    return event.type === 'RepoEnsured';
}

export function isRepoEnsureFailed(event: Event): event is RepoEnsureFailed {
    return event.type === 'RepoEnsureFailed';
}

export function isRepoSynced(event: Event): event is RepoSynced {
    return event.type === 'RepoSynced';
}

export function isRepoSyncFailed(event: Event): event is RepoSyncFailed {
    return event.type === 'RepoSyncFailed';
}
