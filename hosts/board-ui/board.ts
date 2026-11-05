/* eslint-env browser */
/**
 * Pipeline operator board — TypeScript entry point (AP-IFF-019).
 *
 * This is the SOURCE OF TRUTH that humans edit. The browser-served file
 * is `board.js`, the esbuild bundle output of `npm run build:board` —
 * see `package.json` (`scripts.build:board`). Re-run that script after
 * any edit to this file or to the modules under `client/`.
 *
 * The entry talks ONLY to worker-api (never to Linear or any adapter
 * directly):
 *   - GET  /events   (EventSource) — receives every domain event the
 *                    orchestrator publishes; updates an in-memory
 *                    projection of plans and tasks; re-renders.
 *   - POST /commands — submits Approve / Skip / Retry commands plus the
 *                    typed dispatches each modal owns.
 *
 * The modal-trigger wiring imports the typed modules under
 * `client/modals/*` and `client/chrome/*` rather than re-implementing
 * them. The TS modules own the structural DOM types, dispatcher ports,
 * and unit-test coverage; this entry assembles them with the runtime
 * deps the browser needs (overlay-manager singleton, fetch, EventSource,
 * sendCommand POST adapter).
 *
 * Projection store, SSE subscription, and Kanban-column rendering stay
 * in this file (AC #4) — only the modal-launch wiring is delegated.
 */

import { getOverlayManager } from './client/chrome/overlay-manager';
import { showToast } from './client/chrome/toast';
import {
    ATTACHMENTS_KIND_ATTR,
    ATTACHMENTS_OWNER_ATTR,
    attachmentSectionKey,
    sectionKind,
    sectionsForOwner,
} from './client/attachment-sections';
import { decideStopAgent } from './client/stop-agent-decision';
import { openClarifyModal } from './client/modals/clarify';
import { openDiffReview } from './client/modals/diff-review';
import {
    extractMermaidBlocks,
    markdownToDrawio,
    pageNameFor,
} from './diagram-export';
import {
    sanitizeMermaidInMarkdown,
    sanitizeMermaidSource,
} from '../../core/requirements/mermaid-sanitize';
import { openInterruptRetryModal } from './client/modals/interrupt-retry';
import { openInvestigationFollowupModal } from './client/modals/investigation-followup';
import { createEditProjectModal, DEFAULT_KNOWN_STEP_KINDS } from './client/modals/edit-project';
import { createProjectContextModal } from './client/modals/project-context';
import { createNewPlanModal } from './client/modals/new-plan';
import { createNewProjectModal } from './client/modals/new-project';
import { openRejectModal } from './client/modals/reject';
import {
    createReviewReportModal,
    type ReviewReportModalHandle,
} from './client/modals/review-report';
import { openWorkerLog } from './client/modals/worker-log';
import { isOperatorEditingIn, rebuildPreservingScroll } from './modal-refresh';
import { needsFullRender } from './render-scheduling';
import { planAttention } from './plan-attention';
import {
    hydrateInBatches,
    tasksNeedingStepHydration,
} from './step-hydration';
import {
    canEditTaskInstructions,
    instructionsApplyToRerun,
} from './instructions-editability';
import { isActiveBoardTaskStatus } from './task-visibility';
import { gateStepState, type GateStepState } from './gate-step-state';
import { pickReportStep, hasReadableReport, setReportTaskTypes } from './report-availability';
import { setExtraWorkRoles } from './task-tags';
import {
    applyStepFailure,
    failedStageForStep,
    resolveFailedStepId,
} from './step-outcome';
import { openChatModal, notifyChatProgress } from './client/modals/chat';
import {
    mountScopedChatPane,
    type ScopedChatHandle,
    type ScopedChatOptions,
} from './client/panels/scoped-chat';
// AP-VP5-014 — Phase 5 modal/panel wiring. These are the new AP-VP5-010/011/012/013
// surfaces that talk to the worker-api endpoints introduced in AP-VP5-008/009:
//   - `modals/clarify` POSTs `/tasks/:id/clarify`
//   - `modals/reject-feedback` POSTs `/tasks/:id/reject`
//   - `panels/notes` talks to `/projects/:id/notes*`
// The follow-up modal lives under `client/modals/` (it already had the
// project's client-modal shape) and is wired to the AP-VP5-008 follow-up
// endpoint.
import { openClarifyModal as openPhase5ClarifyModal } from './modals/clarify';
import { openRejectFeedbackModal } from './modals/reject-feedback';
import { init as initNotesPanel } from './panels/notes';
import { applyTaskCreated as applyTaskCreatedReducer } from './task-projection';
import { createdChip, createdTooltip } from './created-date';
import { filterPlansByQuery, isSearching } from './archived-search';
import {
    accountUpdateValue,
    repoAccountPicker,
} from './repo-account-options';
import { foldRepoAccount, foldRepoText } from './repo-fold';
import {
    planBodySections,
    shouldCollapseRequest,
} from './plan-body-sections';
import {
    describeRegenerateSection,
    nextRegenerateRevision,
    REGENERATE_FEEDBACK_CLASS,
    REGENERATE_ROWS,
} from './requirement-regenerate';
import {
    buildMermaidFlowchart,
    computeDepEdges,
} from './plan-dep-graph';
import {
    REQUIREMENT_EVENT_TYPES,
    applyRequirementEvent,
    type RequirementRow,
} from './requirements-projection';
import type { FlowStage } from '../../core/flow/flow-stages';

declare global {
    interface Window {
        WORKER_API_BASE?: string;
    }
}

const API_BASE = (window.WORKER_API_BASE || '').replace(/\/+$/, '');
const COLUMNS = [
    'created',
    'approved',
    'in_progress',
    'review',
    'test',
    'commit',
    'merge',
] as const;
type Column = typeof COLUMNS[number];
const COLUMN_LABELS: Record<Column, string> = {
    created: 'Created',
    approved: 'Approved',
    in_progress: 'In progress',
    review: 'Review',
    test: 'Test',
    commit: 'Commit',
    merge: 'Merge',
};

const TRIAGE_COLUMNS = new Set<string>(['created', 'approved', 'in_progress', 'review']);
const STREAM_TAIL_LIMIT = 6;

interface PlanRow {
    planId: string;
    projectId: string;
    status: string;
    /**
     * AP-IFB-003 v1-parity slots. The plan-card template surfaces a
     * title row + tech-stack chips when the projection carries them;
     * legacy events that pre-date AP-IFB-003 leave these absent and
     * the renderer falls back to an empty title / empty tech-stack
     * row (the slots stay in the DOM so layout never reflows).
     *
     * `planFile` is the v1-shaped URL slug — gates the Delete action.
     * A plan whose file slug never landed on the projection cannot be
     * routed through DELETE /api/projects/:pid/plans/:file, so the
     * renderer disables (rather than omits) the Delete button.
     */
    title: string | null;
    techStack: string[];
    planFile: string | null;
    /** Markdown body of the latest plan revision (rendered in the plan
     *  modal). Hydrated from sidebar_plans.body. */
    body: string | null;
    /** Parsed `metadata` blob — carries `planType`, `abbr`, `targetRepo`,
     *  etc. Populated from the plan-create / plan-update events. */
    metadata: Record<string, unknown>;
    /** Set when the operator clicked Archive. Plans with this set route
     *  into the Archived plans board section regardless of task state. */
    archivedAt: number | null;
    /**
     * When the plan was created, shown on the plan modal's meta row.
     * From `plans.created_at` via /api/plans on hydration, or the
     * event envelope's `occurredAt` for a plan created live in this
     * session. Null when neither is available — the modal then omits
     * the date rather than inventing one.
     */
    createdAt: number | null;
}

// AP-VP4-014 — the structural row type lives in `./task-projection` so
// the pure reducer and this entry share one definition. `parkedStepId`
// (AP-VP-015) and the rest of the parked-state slots are populated by
// later events (TaskParked / TaskResumed) — `applyTaskCreated` starts
// them at their null defaults.
type TaskRow = import('./task-projection').TaskProjectionRow;

const plans = new Map<string, PlanRow>();
// Architect Tier (Phase 2): the Requirements lane rows, hydrated from
// /api/requirements and kept live by the requirement lifecycle SSE events.
const requirements = new Map<string, RequirementRow>();
const REQUIREMENT_EVENT_TYPE_SET: ReadonlySet<string> = new Set(
    Object.values(REQUIREMENT_EVENT_TYPES),
);
const tasks = new Map<string, TaskRow>();

/**
 * Flow-stage catalog: `flowId` → ordered `FlowStage[]` (P-TOTS-006).
 *
 * Hydrated once on boot from `GET /api/flow-stages` (see
 * {@link hydrateFlowStages}) and read per card render by
 * {@link stagesForTask}. Keyed by flow — not by task — so a single fetch
 * serves every card, and TaskCreated events that land afterwards reuse
 * the same map without re-fetching. Empty until the fetch resolves (and
 * permanently empty if it fails), which the stage-bar renderer treats as
 * "no bar" rather than an error.
 */
const flowStageCatalog = new Map<string, FlowStage[]>();

/**
 * Step kinds the Edit-project modal treats as known (anything else gets a
 * visible "unknown step kind" note). Seeded with core's own kinds and then
 * extended IN PLACE by {@link hydrateFlowStages} with every step of every
 * loaded flow — including an enabled pack's roles, which core does not
 * name. The modal captures this set by reference at construction, so the
 * later additions are visible to it.
 */
const knownStepKinds = new Set<string>(DEFAULT_KNOWN_STEP_KINDS);

/**
 * Resolve the ordered `FlowStage[]` for a task's flow. Falls back to the
 * task's `type` when `flowId` did not populate — flow id == task type, so
 * a task that lost its `flowId` still maps to its flow (defense-in-depth
 * matching the `task?.flowId ?? task?.type ?? ''` pattern used elsewhere in
 * the bundle). Returns the empty array when neither is present, or when the
 * resolved flow is absent from the catalog (an unknown flow, or the catalog
 * has not hydrated / its fetch failed) — the stage-bar renders no bar in
 * that case.
 */
function stagesForTask(
    task: { readonly flowId?: string | null; readonly type?: string | null },
): readonly FlowStage[] {
    const flowId = task.flowId ?? task.type ?? '';
    if (!flowId) return [];
    return flowStageCatalog.get(flowId) ?? [];
}
const streamTails = new Map<string, Array<{ kind: string; text: string; at: number }>>();
const investigationReports = new Map<
    string,
    { reportId: string; markdown: string; dismissed: boolean; implemented: boolean }
>();

/**
 * What an attachment hangs off.
 *
 * `requirement` is the architect tier: files pinned to a requirement as
 * input for the DESIGN, which the architect and the design-verifier read.
 * They are deliberately not inherited by the plans the fan-out creates.
 */
type AttachmentOwner = 'task' | 'plan' | 'requirement';

/**
 * Attachment metadata (migration 021), keyed by `${ownerType}:${ownerId}`.
 * Hydrated from `GET /api/attachments` when a task / plan modal opens and
 * kept live by the AttachmentAdded / AttachmentRemoved SSE reducers. The
 * bytes are never held here — the modal renders `<img>` / download links
 * that point at `GET /api/attachments/:id`.
 */
interface AttachmentMeta {
    id: string;
    ownerType: AttachmentOwner;
    ownerId: string;
    fileName: string;
    contentType: string;
    sizeBytes: number;
    caption: string | null;
    createdAt: number;
    /**
     * Migration 038: 'input' is an operator upload, 'output' a file the
     * task produced and the operator can download.
     */
    kind: AttachmentKind;
}

/**
 * Input (the operator attached it) vs output (the task produced it).
 * Kept apart everywhere - two lists, two sections - because they are
 * read for opposite reasons.
 */
type AttachmentKind = 'input' | 'output';

const attachments = new Map<string, AttachmentMeta[]>();

/**
 * The kind is part of the key, not a filter applied afterwards: inputs
 * and outputs hydrate from two separate requests, and a shared key meant
 * whichever response landed second wiped the other.
 */
function attachKey(
    ownerType: AttachmentOwner,
    ownerId: string,
    kind: AttachmentKind,
): string {
    return `${ownerType}:${ownerId}:${kind}`;
}

function getAttachments(
    ownerType: AttachmentOwner,
    ownerId: string,
    kind: AttachmentKind = 'input',
): AttachmentMeta[] {
    return attachments.get(attachKey(ownerType, ownerId, kind)) ?? [];
}

/** Insert or replace an attachment in its owner's list (dedup by id). */
function upsertAttachment(meta: AttachmentMeta): void {
    const key = attachKey(meta.ownerType, meta.ownerId, meta.kind);
    const list = attachments.get(key) ?? [];
    const next = list.filter((a) => a.id !== meta.id);
    next.push(meta);
    next.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    attachments.set(key, next);
}

function removeAttachmentLocal(ownerType: AttachmentOwner, ownerId: string, id: string): void {
    // Both kinds: `AttachmentRemoved` carries no kind, and an id is
    // unique across them, so sweeping both is exact rather than a guess.
    for (const kind of ['input', 'output'] as const) {
        const key = attachKey(ownerType, ownerId, kind);
        const list = attachments.get(key);
        if (!list) continue;
        attachments.set(key, list.filter((a) => a.id !== id));
    }
}

/** Coerce a raw SSE/REST attachment object into an {@link AttachmentMeta}. */
/**
 * Narrow an owner type off the wire.
 *
 * A nested ternary here collapsed everything that was not a plan into
 * a task, so every REQUIREMENT attachment arrived filed under the
 * wrong owner and its modal showed nothing. Unknown values still fall
 * back to 'task', the oldest type, rather than dropping the row.
 */
function coerceOwnerType(raw: unknown): AttachmentOwner {
    if (raw === 'plan' || raw === 'requirement') return raw;
    return 'task';
}

function coerceAttachment(raw: Record<string, unknown>): AttachmentMeta | null {
    const id = raw.id ?? raw.attachmentId;
    if (typeof id !== 'string' || id.length === 0) return null;
    const ownerType = coerceOwnerType(raw.ownerType);
    const ownerId = typeof raw.ownerId === 'string' ? raw.ownerId : '';
    if (ownerId.length === 0) return null;
    return {
        id,
        ownerType,
        ownerId,
        fileName: typeof raw.fileName === 'string' ? raw.fileName : 'attachment',
        contentType: typeof raw.contentType === 'string' ? raw.contentType : 'application/octet-stream',
        sizeBytes: typeof raw.sizeBytes === 'number' ? raw.sizeBytes : 0,
        caption: typeof raw.caption === 'string' ? raw.caption : null,
        createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : 0,
        kind: raw.kind === 'output' ? 'output' : 'input',
    };
}

/**
 * Per-task agent run state — the same lifecycle structure
 * `activePlanners` keeps for planner runs, but keyed by `taskId` so the
 * Show agent modal on a task card can pull the rich activity feed
 * (lifecycle, system, tool_use, tool_result, assistant, …) the same
 * way the planner Show agent modal does. Populated from the Agent*
 * events for task agents (developer / reviewer / tester / committer
 * — anything whose metadata.taskId is set), cleared on TaskRetried so
 * a fresh run starts from a clean transcript.
 *
 * The shape mirrors {@link ActivePlanner} so the existing
 * `renderShowPlannerAgentBody` rendering primitives can be reused for
 * the task modal body without a parallel renderer.
 */
interface TaskAgentRun {
    taskId: string;
    agentId: string;
    role: string;
    startedAt: number;
    activities: PlannerActivity[];
    status: 'running' | 'complete' | 'failed';
    error?: string;
    finishedAt?: number;
}
const taskAgents = new Map<string, TaskAgentRun>();

/**
 * Per-step agent run records, keyed by `${taskId}:${stepId}`. Populated
 * from `/api/tasks/:taskId/step-summaries` on boot and updated live as
 * `AgentStarted` / `AgentFinished` / `AgentFailed` events flow in for
 * task agents. Drives two surfaces:
 *
 *   - The stage-bar chips on the task card: each step's `status`
 *     resolves to a colour (running → amber, complete → green, failed
 *     → red, missing → blue/todo).
 *   - The per-stage summary modal opened by clicking a chip: shows the
 *     stored `summary` (the joined `AgentProgress.chunk` text the
 *     agent emitted during its run) when the step has finished.
 */
interface TaskStepRecord {
    stepId: string;
    role: string | null;
    status: 'running' | 'complete' | 'failed';
    startedAt: number;
    finishedAt: number | null;
    summary: string | null;
    /**
     * The live agent handle for a RUNNING step, as the
     * step-summaries hydration reports it. Only needed on the reload
     * path - a live AgentStarted carries the id straight into
     * {@link taskAgents} - and it is what Stop agent addresses.
     */
    agentId?: string;
}
const taskStepRuns = new Map<string, Map<string, TaskStepRecord>>();

function getTaskStepMap(taskId: string): Map<string, TaskStepRecord> {
    let m = taskStepRuns.get(taskId);
    if (!m) {
        m = new Map();
        taskStepRuns.set(taskId, m);
    }
    return m;
}

function setTaskStepRecord(taskId: string, rec: TaskStepRecord): void {
    getTaskStepMap(taskId).set(rec.stepId, rec);
}

/**
 * Lifecycle state for a single in-flight planner agent, keyed by planId.
 * The board folds `AgentStarted` / `AgentProgress` / `AgentFinished` /
 * `AgentFailed` / `PlanGenerated` / `PlanGenerateFailed` events into this
 * row so the sidebar badge, the active-planner card in the main area,
 * and the "Show agent" stream modal can all read from the same source.
 *
 * `chunks` is a rolling buffer of the assistant text emitted via
 * `AgentProgress`. Capped at ACTIVE_PLANNER_CHUNK_LIMIT — older chunks
 * fall off the head when the buffer overflows so a long planner run
 * doesn't grow the board's memory unbounded.
 */
interface PlannerActivity {
    readonly at: number;
    /**
     * Categories surfaced today: `'lifecycle'` (agent started/finished
     * markers added by the board), `'assistant'` (text chunks from the
     * runner), `'system'`, `'tool_use'`, `'tool_result'`, `'thinking'`,
     * `'stderr'`. The renderer styles each one distinctly.
     */
    readonly category: string;
    /** One-line summary the stream renders as the row's primary text. */
    detail: string;
    /**
     * Additional context that doesn't fit on the detail line — tool
     * input args, full thinking body, full tool result. Rendered in a
     * collapsed, scrollable secondary block under the row. Optional;
     * absent for lifecycle markers + stderr lines.
     */
    extra?: string;
    /**
     * Raw accumulated assistant text (untruncated, untrimmed) for
     * delta-coalescing — with --include-partial-messages each tiny
     * text delta arrives as its own AgentProgress event, and one row
     * per delta rendered words broken across timestamped lines.
     * Consecutive assistant chunks append here instead.
     */
    full?: string;
}

/**
 * Fold an assistant text chunk into `activities`: append to the trailing
 * assistant row when one exists (delta continuation), else push a fresh
 * row via `push`. Keeps detail/extra in sync with the accumulated text.
 */
function coalesceAssistantChunk(
    activities: PlannerActivity[],
    chunk: string,
    push: (entry: PlannerActivity) => void,
): void {
    const last = activities[activities.length - 1];
    if (last && last.category === 'assistant') {
        const full = (last.full ?? last.extra ?? last.detail) + chunk;
        last.full = full;
        const trimmed = full.trim();
        last.detail = truncate(trimmed, 140);
        if (trimmed.length > 140) last.extra = trimmed;
        return;
    }
    const trimmed = chunk.trim();
    push({
        at: Date.now(),
        category: 'assistant',
        detail: truncate(trimmed, 140),
        ...(trimmed.length > 140 ? { extra: trimmed } : {}),
        full: chunk,
    });
}
interface ActivePlanner {
    readonly planId: string;
    readonly projectId: string;
    readonly agentId: string;
    /** Resolved model this run actually used (from AgentStarted). */
    model?: string;
    readonly startedAt: number;
    chunks: string[];
    /** Tool calls / system frames / stderr lines surfaced alongside chunks. */
    activities: PlannerActivity[];
    status: 'running' | 'complete' | 'failed';
    error?: string;
    revision?: number;
    /** Epoch ms when the agent reached a terminal state. Set on
     *  AgentFinished / AgentFailed. Used to freeze the elapsed-time
     *  display in the Show-agent modal so the timer stops climbing
     *  after the run is over. */
    finishedAt?: number;
}
const activePlanners = new Map<string, ActivePlanner>();
const ACTIVE_PLANNER_CHUNK_LIMIT = 2000;
const ACTIVE_PLANNER_ACTIVITY_LIMIT = 1000;

/**
 * Lifecycle state for a single in-flight decomposer agent, keyed by
 * planId. Symmetric with {@link ActivePlanner} — same activity timeline,
 * same chunk buffer, same fold rules. The decomposer card surfaces
 * exactly the same Show-agent transcript the planner card does, but
 * for the AgentRunner run that produced the TaskCreated burst.
 *
 * Per the operator's choice the card stays on the board until they
 * click Dismiss, so a completed/failed entry persists beyond the
 * agent's terminal event. `dismissed === true` is the sentinel the
 * renderer keys on to skip painting the card without losing the row.
 */
interface ActiveDecomposer {
    readonly planId: string;
    readonly projectId: string;
    readonly agentId: string;
    /** Resolved model this run actually used (from AgentStarted). */
    model?: string;
    readonly startedAt: number;
    chunks: string[];
    activities: PlannerActivity[];
    /**
     * `awaiting` is the decomposer's own `NEEDS_HUMAN_INPUT` park: the run
     * ended by asking the operator something and will be re-spawned with
     * the answer. It is deliberately NOT `failed` — the run is held, not
     * broken, and the card offers Answer rather than a red error line.
     */
    status: 'running' | 'complete' | 'failed' | 'awaiting' | 'abandoned';
    error?: string;
    /** Set while `status === 'awaiting'` — the question to answer. */
    question?: string;
    /** Enumerated option labels the agent offered, if any. */
    questionOptions?: string[];
    askedAt?: number;
    /** Same as {@link ActivePlanner.finishedAt}. */
    finishedAt?: number;
    /** Operator clicked Dismiss — keep the entry around so a late event
     *  doesn't resurrect a card the operator already retired, but skip
     *  painting it. */
    dismissed?: boolean;
}
const activeDecomposers = new Map<string, ActiveDecomposer>();

// ---------- AP-VP-015 — approval-gate inline-reject state ----------------
//
// `approvalRejectOpen` records which approval-parked task cards have the
// inline feedback textarea expanded. `approvalRejectFeedback` mirrors
// the textarea content so a re-render (the renderer calls replaceChildren
// on every projection update) does not blow the operator's in-progress
// text away. Both are keyed by taskId. The set entry and the map entry
// are cleared when the task resumes (TaskResumed handler) or after the
// operator submits / cancels (see onRejectParked / cancelApprovalReject).
const approvalRejectOpen = new Set<string>();
const approvalRejectFeedback = new Map<string, string>();

// ---------- AP-VP5-014 — clarification choices side-store ----------------
//
// `ClarificationRequested` (core/events/event.ts) carries the optional
// enumerated `choices` the agent offered alongside the question; the
// AP-VP5-010 clarify modal renders them as radio buttons above the
// free-text textarea. We don't put `choices` on the projection row —
// the projection is structurally typed via `task-projection.ts` and the
// rest of the board treats parked-clarification as a string-only state —
// so we capture it on the side, keyed by taskId, and clear it when the
// task resumes.
const clarificationChoices = new Map<string, string[]>();

// Process-wide overlay-manager singleton. The modal modules talk to this
// through the `OverlayManagerLike` port — pushing onto / popping from a
// shared stack so Escape always closes the topmost modal regardless of
// which TS module owns it.
const overlayManager = getOverlayManager();

// ----- event handling --------------------------------------------------

interface StoredEvent {
    type: string;
    seq: number;
    /**
     * Unix epoch ms from the event envelope. On the wire since the SSE
     * feed serialises the whole StoredEvent, and already read for the
     * Requirements lane — declared here so a second reader is type-safe
     * rather than relying on the same untyped access.
     */
    occurredAt?: number;
    payload: Record<string, unknown> & { taskId?: string; planId?: string };
}

/**
 * Append an entry to a planner's activity timeline. Caps the buffer
 * at `ACTIVE_PLANNER_ACTIVITY_LIMIT` so a long-running planner with
 * lots of tool calls + stderr can't grow memory unbounded; the
 * oldest entries fall off the head, which the Show-agent stream
 * surfaces as a "(earlier activity elided)" note.
 */
function pushPlannerActivity(row: ActivePlanner, entry: PlannerActivity): void {
    row.activities.push(entry);
    while (row.activities.length > ACTIVE_PLANNER_ACTIVITY_LIMIT) {
        row.activities.shift();
    }
}

/**
 * Same as {@link pushPlannerActivity} but typed for the decomposer
 * shape. Kept as a separate function so a future divergence (different
 * cap, different elide rule) is a one-symbol edit.
 */
function pushDecomposerActivity(
    row: ActiveDecomposer,
    entry: PlannerActivity,
): void {
    row.activities.push(entry);
    while (row.activities.length > ACTIVE_PLANNER_ACTIVITY_LIMIT) {
        row.activities.shift();
    }
}

function pushTaskAgentActivity(row: TaskAgentRun, entry: PlannerActivity): void {
    row.activities.push(entry);
    while (row.activities.length > ACTIVE_PLANNER_ACTIVITY_LIMIT) {
        row.activities.shift();
    }
}

/**
 * Fold an SSE event into the `activePlanners` map. Returns `true` when
 * the event was claimed (i.e. it belonged to a planner run), so the
 * caller can short-circuit the per-task switch below. The Claude CLI
 * runner stamps the AgentSpec's metadata onto every Agent* event it
 * publishes; we look at `metadata.kind === 'planner'` (set by the
 * orchestrator's `startLifecycleAgent` when it dispatches a planner)
 * and `metadata.planId` to correlate the runtime agentId to the plan.
 *
 * `PlanGenerated` / `PlanGenerateFailed` events don't carry metadata
 * because they're emitted by the orchestrator, not the runner — but
 * they DO carry `planId`, so we match on that to flip the active
 * planner's terminal status without needing the agentId.
 */
function applyPlannerEvent(
    type: string,
    payload: Record<string, unknown>,
): boolean {
    const md = (payload.metadata ?? null) as
        | { kind?: unknown; planId?: unknown; projectId?: unknown; revision?: unknown }
        | null;
    const isPlannerRun = md?.kind === 'planner' && typeof md.planId === 'string';
    const planIdFromMeta = isPlannerRun ? (md!.planId as string) : null;
    const agentId = typeof payload.agentId === 'string' ? payload.agentId : null;
    switch (type) {
        case 'AgentStarted': {
            if (!isPlannerRun || planIdFromMeta === null || !agentId) return false;
            const projectId
                = typeof md!.projectId === 'string' ? (md!.projectId as string) : '';
            const revision
                = typeof md!.revision === 'number' ? (md!.revision as number) : undefined;
            const now = Date.now();
            activePlanners.set(planIdFromMeta, {
                planId: planIdFromMeta,
                projectId,
                agentId,
                ...(typeof payload.model === 'string' ? { model: payload.model } : {}),
                startedAt: now,
                chunks: [],
                activities: [
                    {
                        at: now,
                        category: 'lifecycle',
                        detail: `agent started · ${agentId}`,
                    },
                ],
                status: 'running',
                ...(revision !== undefined ? { revision } : {}),
            });
            return true;
        }
        case 'AgentProgress': {
            if (!isPlannerRun || planIdFromMeta === null) return false;
            const row = activePlanners.get(planIdFromMeta);
            if (!row) return true; // claimed but row missed (out-of-order); drop
            const chunk = typeof payload.chunk === 'string' ? payload.chunk : '';
            if (chunk.length === 0) return true;
            row.chunks.push(chunk);
            // Record an entry on the activity timeline so the Show
            // agent feed surfaces assistant text alongside the tool
            // frames. `detail` is a one-line preview; `extra` carries
            // the full text so the operator can expand it inline —
            // same convention as v1's stream renderer.
            coalesceAssistantChunk(row.activities, chunk, (entry) =>
                pushPlannerActivity(row, entry));
            // Cap the rolling buffer so a long planner run doesn't grow
            // memory unbounded. The Show-agent modal renders the tail
            // anyway, so the head is the part that's safe to evict.
            while (row.chunks.length > ACTIVE_PLANNER_CHUNK_LIMIT) {
                row.chunks.shift();
            }
            return true;
        }
        case 'AgentActivity': {
            if (!isPlannerRun || planIdFromMeta === null) return false;
            const row = activePlanners.get(planIdFromMeta);
            if (!row) return true;
            const category
                = typeof payload.category === 'string' ? (payload.category as string) : 'event';
            const detail
                = typeof payload.detail === 'string' ? (payload.detail as string) : '';
            const extra
                = typeof payload.extra === 'string' ? (payload.extra as string) : undefined;
            pushPlannerActivity(row, {
                at: Date.now(),
                category,
                detail,
                ...(extra !== undefined ? { extra } : {}),
            });
            return true;
        }
        case 'AgentFinished': {
            if (!isPlannerRun || planIdFromMeta === null) return false;
            // Done ⇒ gone. A finished planner is represented by its plan
            // under Ready (the content-carrying PlanGenerated lands right
            // after this and bumps planLatestRevision); keeping a
            // "complete" card under Active planners double-displayed the
            // same plan until a refresh. Failed runs still stick around
            // (AgentFailed keeps the row with its error).
            activePlanners.delete(planIdFromMeta);
            return true;
        }
        case 'AgentFailed': {
            if (!isPlannerRun || planIdFromMeta === null) return false;
            const row = activePlanners.get(planIdFromMeta);
            if (row) {
                row.status = 'failed';
                row.finishedAt = Date.now();
                row.error
                    = typeof payload.stderrTail === 'string'
                        && (payload.stderrTail as string).length > 0
                        ? truncate(payload.stderrTail as string, 240)
                        : 'planner failed';
                pushPlannerActivity(row, {
                    at: Date.now(),
                    category: 'lifecycle',
                    detail: `agent failed${row.error ? ` · ${row.error}` : ''}`,
                });
            }
            return true;
        }
        case 'PlanGenerateFailed': {
            const planId = typeof payload.planId === 'string' ? payload.planId : null;
            if (planId === null) return false;
            const row = activePlanners.get(planId);
            if (row) {
                row.status = 'failed';
                row.finishedAt = Date.now();
                row.error
                    = typeof payload.error === 'string'
                        ? truncate(payload.error as string, 240)
                        : 'planner failed';
            }
            // Don't claim this event — the existing switch may also
            // want to surface the failure elsewhere (e.g. toasts).
            return false;
        }
        // PlanGenerated arrives with content when the planner finishes.
        // We drop the active-planner row here so the card no longer
        // shows under Active planners — the plan has transitioned to
        // Ready, where the operator can decompose or regenerate from
        // the modal. We also cache the markdown content so the plan
        // modal renders the planner output instead of the original
        // brief, and bump the latest-revision marker monotonically.
        case 'PlanGenerated': {
            const planId = typeof payload.planId === 'string' ? payload.planId : null;
            if (planId === null) return false;
            const content
                = typeof payload.content === 'string' ? (payload.content as string) : '';
            if (content.length > 0) planReviewContent.set(planId, content);
            // Only a CONTENT-carrying PlanGenerated marks a revision. The
            // GeneratePlan command emits a synchronous empty PlanGenerated
            // at dispatch time — before the agent runs — and counting that
            // one flipped auth-failed planner runs into "Ready" plans.
            if (content.length > 0) {
                activePlanners.delete(planId);
                const revision = typeof payload.revision === 'number'
                    ? payload.revision
                    : 1;
                const prior = planLatestRevision.get(planId) ?? 0;
                if (revision > prior) planLatestRevision.set(planId, revision);
            }
            return false;
        }
        case 'PlanDecomposed': {
            // The planner phase is over — decomposer is producing
            // tasks. Drop the active-planner card if one is somehow
            // still around, but keep the latest-revision + cached
            // planner content. classifyPlan flips to Progress as soon
            // as the first TaskCreated lands; until that arrives we
            // want the plan to stay under Ready (decomposer-in-flight
            // is a transient window the user explicitly does not want
            // surfaced as Draft). The cached planner content also
            // backs the modal body across the whole plan lifecycle.
            const planId = typeof payload.planId === 'string' ? payload.planId : null;
            if (planId !== null) {
                activePlanners.delete(planId);
            }
            return false;
        }
        default:
            return false;
    }
}

/**
 * Fold an SSE event into the `activeDecomposers` map. Mirrors
 * {@link applyPlannerEvent} — the only material differences are the
 * metadata kind discriminator (`'decomposer'` instead of `'planner'`)
 * and the terminal-state behaviour: a completed/failed decomposer
 * card sticks around until the operator clicks Dismiss, so
 * `AgentFinished` / `AgentFailed` flip `status` but never delete the
 * row.
 */
/**
 * Flatten the `{key,label}` options on a `PlanDecomposeQuestionRaised` into
 * the plain strings the Answer modal renders as radios. Kept lenient — the
 * options originate in LLM output, so a malformed entry degrades to "one
 * fewer radio", never to a broken card.
 */
function readDecomposerOptionLabels(raw: unknown): string[] {
    if (!Array.isArray(raw)) return [];
    const out: string[] = [];
    for (const entry of raw) {
        if (!entry || typeof entry !== 'object') continue;
        const o = entry as Record<string, unknown>;
        const label = typeof o.label === 'string' ? o.label.trim() : '';
        if (label.length === 0) continue;
        const key = typeof o.key === 'string' ? o.key.trim() : '';
        out.push(key.length > 0 ? `${key}) ${label}` : label);
    }
    return out;
}

function applyDecomposerEvent(
    type: string,
    payload: Record<string, unknown>,
): boolean {
    const md = (payload.metadata ?? null) as
        | { kind?: unknown; planId?: unknown; projectId?: unknown }
        | null;
    const isDecomposerRun
        = md?.kind === 'decomposer' && typeof md.planId === 'string';
    const planIdFromMeta = isDecomposerRun ? (md!.planId as string) : null;
    const agentId = typeof payload.agentId === 'string' ? payload.agentId : null;
    switch (type) {
        case 'AgentStarted': {
            if (!isDecomposerRun || planIdFromMeta === null || !agentId) return false;
            const projectId
                = typeof md!.projectId === 'string' ? (md!.projectId as string) : '';
            const now = Date.now();
            activeDecomposers.set(planIdFromMeta, {
                planId: planIdFromMeta,
                projectId,
                agentId,
                ...(typeof payload.model === 'string' ? { model: payload.model } : {}),
                startedAt: now,
                chunks: [],
                activities: [
                    {
                        at: now,
                        category: 'lifecycle',
                        detail: `agent started · ${agentId}`,
                    },
                ],
                status: 'running',
            });
            return true;
        }
        case 'AgentProgress': {
            if (!isDecomposerRun || planIdFromMeta === null) return false;
            const row = activeDecomposers.get(planIdFromMeta);
            if (!row) return true;
            const chunk = typeof payload.chunk === 'string' ? payload.chunk : '';
            if (chunk.length === 0) return true;
            row.chunks.push(chunk);
            coalesceAssistantChunk(row.activities, chunk, (entry) =>
                pushDecomposerActivity(row, entry));
            while (row.chunks.length > ACTIVE_PLANNER_CHUNK_LIMIT) {
                row.chunks.shift();
            }
            return true;
        }
        case 'AgentActivity': {
            if (!isDecomposerRun || planIdFromMeta === null) return false;
            const row = activeDecomposers.get(planIdFromMeta);
            if (!row) return true;
            const category
                = typeof payload.category === 'string' ? (payload.category as string) : 'event';
            const detail
                = typeof payload.detail === 'string' ? (payload.detail as string) : '';
            const extra
                = typeof payload.extra === 'string' ? (payload.extra as string) : undefined;
            pushDecomposerActivity(row, {
                at: Date.now(),
                category,
                detail,
                ...(extra !== undefined ? { extra } : {}),
            });
            return true;
        }
        case 'AgentFinished': {
            if (!isDecomposerRun || planIdFromMeta === null) return false;
            const row = activeDecomposers.get(planIdFromMeta);
            if (row) {
                row.status = 'complete';
                row.finishedAt = Date.now();
                pushDecomposerActivity(row, {
                    at: Date.now(),
                    category: 'lifecycle',
                    detail: 'agent finished',
                });
            }
            return true;
        }
        case 'AgentFailed': {
            if (!isDecomposerRun || planIdFromMeta === null) return false;
            const row = activeDecomposers.get(planIdFromMeta);
            if (row) {
                row.status = 'failed';
                row.finishedAt = Date.now();
                row.error
                    = typeof payload.stderrTail === 'string'
                        && (payload.stderrTail as string).length > 0
                        ? truncate(payload.stderrTail as string, 240)
                        : 'decomposer failed';
                pushDecomposerActivity(row, {
                    at: Date.now(),
                    category: 'lifecycle',
                    detail: `agent failed${row.error ? ` · ${row.error}` : ''}`,
                });
            }
            return true;
        }
        case 'PlanDecomposeQuestionAbandoned': {
            // The operator gave up on the question. Terminal, so the
            // card finally offers Dismiss — while a question was
            // pending it deliberately did not, and answering was the
            // only control. That was the trap: the decomposer had
            // offered "cancel the task" among its own options, and
            // answering with it re-spawned the decomposer, which asked
            // again.
            const planId = typeof payload.planId === 'string' ? payload.planId : null;
            if (planId === null) return false;
            const row = activeDecomposers.get(planId);
            if (!row) return true;
            row.status = 'abandoned';
            // The question goes with it: leaving it on the card would
            // keep showing the thing the operator just walked away from.
            row.question = undefined;
            row.questionOptions = undefined;
            row.error = undefined;
            pushDecomposerActivity(row, {
                at: Date.now(),
                category: 'lifecycle',
                detail: typeof payload.reason === 'string' && payload.reason.length > 0
                    ? `operator abandoned the question · ${truncate(payload.reason, 160)}`
                    : 'operator abandoned the question — the decomposer was not re-run',
            });
            return true;
        }
        case 'PlanDecomposeQuestionRaised': {
            // The decomposer asked instead of answering. Its AgentFinished
            // has already flipped the row to 'complete' (it exited cleanly),
            // so this branch has to overwrite that — otherwise the card
            // reads "✓ Decomposer complete" on a plan that produced no
            // tasks and is waiting on the operator.
            const planId = typeof payload.planId === 'string' ? payload.planId : null;
            const question = typeof payload.question === 'string' ? payload.question : '';
            if (planId === null || question.length === 0) return false;
            const row = activeDecomposers.get(planId);
            if (!row) return true;
            row.status = 'awaiting';
            row.question = question;
            row.questionOptions = readDecomposerOptionLabels(payload.options);
            row.askedAt = typeof payload.askedAt === 'number' ? payload.askedAt : Date.now();
            // A prior failure line would sit under the question and read as
            // if the run had broken. It hasn't.
            row.error = undefined;
            pushDecomposerActivity(row, {
                at: row.askedAt,
                category: 'lifecycle',
                detail: `asked the operator · ${truncate(question, 160)}`,
            });
            return true;
        }
        case 'PlanDecomposeQuestionAnswered': {
            // The re-spawn's AgentStarted replaces this row wholesale a
            // moment later; clearing the question here means the Answer
            // button goes away the instant the answer lands rather than
            // lingering long enough to be double-clicked.
            const planId = typeof payload.planId === 'string' ? payload.planId : null;
            if (planId === null) return false;
            const row = activeDecomposers.get(planId);
            if (!row) return true;
            row.status = 'running';
            row.question = undefined;
            row.questionOptions = undefined;
            row.askedAt = undefined;
            pushDecomposerActivity(row, {
                at: Date.now(),
                category: 'lifecycle',
                detail: 'operator answered · re-running the decomposer',
            });
            return true;
        }
        case 'PlanDecomposeFailed': {
            // The agent finished cleanly but the orchestrator's bridge
            // couldn't fold the output into TaskCreated events — the
            // JSON was missing, malformed, or schema-invalid. Without
            // this branch the decomposer card silently disappeared and
            // the operator was left wondering why no tasks landed.
            // Flip the card to status='failed' + carry the failure
            // reason so the Show-agent modal surfaces what went wrong.
            const planId = typeof payload.planId === 'string' ? payload.planId : null;
            if (planId === null) return false;
            const row = activeDecomposers.get(planId);
            if (row) {
                row.status = 'failed';
                row.finishedAt = Date.now();
                row.error
                    = typeof payload.error === 'string'
                        ? truncate(payload.error as string, 240)
                        : 'plan decompose failed';
                pushDecomposerActivity(row, {
                    at: Date.now(),
                    category: 'lifecycle',
                    detail: `decompose failed · ${row.error}`,
                });
            }
            return true;
        }
        default:
            return false;
    }
}

function applyEvent(event: StoredEvent): void {
    if (!event || typeof event !== 'object') return;
    const payload = (event.payload || {}) as Record<string, unknown>;
    // Planner-lifecycle fold runs first because the planner's Agent*
    // events carry `metadata.kind === 'planner'` but NOT `taskId` — so
    // the per-task branches below would otherwise short-circuit and
    // drop them. `applyPlannerEvent` updates `activePlanners`; it
    // returns whether it claimed the event so the per-task branches
    // below stay a no-op for planner runs.
    if (applyPlannerEvent(event.type, payload)) return;
    // Decomposer-lifecycle fold runs alongside the planner one. The
    // two are mutually exclusive — claude-cli stamps either
    // `kind: 'planner'` or `kind: 'decomposer'` on the spec metadata,
    // not both — so calling them in sequence is safe.
    if (applyDecomposerEvent(event.type, payload)) return;
    // Architect Tier: the architect's Agent* stream (kind === 'architect').
    if (applyArchitectEvent(event.type, payload)) return;
    // Architect Tier (Phase 2): fold requirement lifecycle events into the
    // Requirements lane. Claimed events don't fall through to the plan/task
    // branches below.
    if (REQUIREMENT_EVENT_TYPE_SET.has(event.type)) {
        applyRequirementEvent(
            requirements,
            event.type,
            payload,
            typeof event.occurredAt === 'number' ? event.occurredAt : undefined,
        );
        // Live left-pane refresh for the open requirement modal — a
        // confirmed chat edit / verification verdict / approve repaints
        // in place, mirroring the plan modal's review-while-chatting
        // behaviour.
        if (typeof payload.requirementId === 'string') {
            void refreshRequirementModal(payload.requirementId);
        }
        scheduleRender();
        return;
    }
    switch (event.type) {
        case 'PlanApproved': {
            if (typeof payload.planId !== 'string') return;
            const existing = plans.get(payload.planId);
            plans.set(payload.planId, {
                planId: payload.planId,
                projectId: typeof payload.projectId === 'string'
                    ? payload.projectId
                    : existing?.projectId ?? '',
                status: 'approved',
                title: typeof payload.title === 'string'
                    ? payload.title
                    : existing?.title ?? null,
                techStack: Array.isArray(payload.techStack)
                    ? (payload.techStack as unknown[]).filter(
                        (x): x is string => typeof x === 'string',
                    )
                    : existing?.techStack ?? [],
                planFile: typeof payload.planFile === 'string'
                    ? payload.planFile
                    : existing?.planFile ?? null,
                body: typeof payload.body === 'string'
                    ? payload.body
                    : existing?.body ?? null,
                metadata: payload.metadata && typeof payload.metadata === 'object'
                    ? { ...(payload.metadata as Record<string, unknown>) }
                    : existing?.metadata ?? {},
                archivedAt: existing?.archivedAt ?? null,
                // Approval is not creation. Keep whatever the hydrated
                // row already had, and fall back to this envelope only
                // when the board never saw the plan created — an
                // approximation the modal is better off showing than a
                // blank where a date belongs.
                createdAt: existing?.createdAt
                    ?? (typeof event.occurredAt === 'number' ? event.occurredAt : null),
            });
            return;
        }
        case 'PlanArchived': {
            if (typeof payload.planId !== 'string') return;
            const existing = plans.get(payload.planId);
            if (!existing) return;
            existing.archivedAt
                = typeof payload.archivedAt === 'number'
                    ? payload.archivedAt
                    : Date.now();
            return;
        }
        case 'PlanUnarchived': {
            if (typeof payload.planId !== 'string') return;
            const existing = plans.get(payload.planId);
            if (!existing) return;
            existing.archivedAt = null;
            return;
        }
        // Board-CRUD plan events (BoardUiEvents). Without these, a plan
        // created / edited / deleted from the board only reached the
        // sidebar's `crudState.plans` (via the post-action loadPlans);
        // the main board sections render from the `plans` Map, which is
        // only fed by applyEvent + the boot hydrate — so a new plan
        // needed a manual refresh to appear. These reducers fold the
        // live events so the section grid updates immediately.
        case 'PlanCreated': {
            if (typeof payload.planId !== 'string') return;
            const existing = plans.get(payload.planId);
            plans.set(payload.planId, {
                planId: payload.planId,
                projectId: typeof payload.projectId === 'string'
                    ? payload.projectId
                    : existing?.projectId ?? '',
                status: typeof payload.status === 'string'
                    ? payload.status
                    : existing?.status ?? 'draft',
                title: typeof payload.title === 'string'
                    ? payload.title
                    : existing?.title ?? null,
                techStack: existing?.techStack ?? [],
                planFile: existing?.planFile ?? null,
                body: typeof payload.body === 'string'
                    ? payload.body
                    : existing?.body ?? null,
                metadata: payload.metadata && typeof payload.metadata === 'object'
                    ? { ...(payload.metadata as Record<string, unknown>) }
                    : existing?.metadata ?? {},
                archivedAt: existing?.archivedAt ?? null,
                // A plan created live in this session has no hydrated
                // row to take the date from, so the envelope's own
                // timestamp stands in. An already-hydrated value wins:
                // it came from `plans.created_at`, which is the record.
                createdAt: existing?.createdAt
                    ?? (typeof event.occurredAt === 'number' ? event.occurredAt : null),
            });
            return;
        }
        case 'PlanUpdated': {
            if (typeof payload.planId !== 'string') return;
            const existing = plans.get(payload.planId);
            if (!existing) return;
            if (typeof payload.title === 'string') existing.title = payload.title;
            if (typeof payload.body === 'string') existing.body = payload.body;
            if (payload.metadata && typeof payload.metadata === 'object') {
                // REPLACE, not merge — this fold has to agree with the
                // projection, which does `metadata = COALESCE(@metadata,
                // metadata)`, i.e. the supplied blob wins whole. Every
                // producer of PlanUpdated already reads the stored blob and
                // sends it back merged (UpdatePlan from the modal form,
                // patchPlanMetadata, the impact-warning scan, SetPlanRepo).
                // Merging here instead meant a REMOVED key lingered on the
                // board until the next reload: clear a plan's target repo
                // and the modal kept showing the old one.
                existing.metadata = {
                    ...(payload.metadata as Record<string, unknown>),
                };
            }
            return;
        }
        case 'PlanDeleted': {
            if (typeof payload.planId !== 'string') return;
            plans.delete(payload.planId);
            return;
        }
        case 'AgentAuthError': {
            // Live auth-shaped agent failure: flip the banner to expired
            // immediately (the next /api/agent-auth poll refines the
            // detail with the credential expiry).
            const label = typeof payload.label === 'string' ? payload.label : 'auth error';
            agentAuthState = {
                status: 'expired',
                detail: `Agent authentication failed (${label})`,
            };
            updateAgentAuthBanner();
            return;
        }
        case 'TaskCreated': {
            // AP-VP4-014 — delegate the row construction to the pure
            // reducer in `./task-projection`. Task-008 emits one
            // `TaskCreated` per decomposer task from a single
            // `PlanDecomposed` fold; the reducer below MUST stay an
            // unconditional `Map.set` so an N-task burst lands as N
            // distinct rows in the same JS tick, which the rAF-batched
            // `scheduleRender` then paints in a single render pass.
            if (applyTaskCreatedReducer(tasks, payload) === null) return;
            // The projected TaskCreated payload doesn't carry
            // `projectId` (see ProjectedTaskCreatedPayload in
            // `adapters/projections/task-projection-store.ts`), so the
            // reducer leaves it null. The sidebar's project filter then
            // hides the task whenever a specific project is selected.
            // Plans always carry projectId — fall back to the plan's
            // projectId so the filter has something to match against.
            if (typeof payload.taskId === 'string') {
                const row = tasks.get(payload.taskId);
                if (row && (!row.projectId || row.projectId.length === 0)) {
                    const plan = plans.get(row.planId);
                    if (plan && plan.projectId) {
                        row.projectId = plan.projectId;
                    }
                }
                // Same shape of gap: the projected TaskCreated payload
                // carries no `createdAt` either — the column is written
                // by the projection from this event, so the envelope's
                // own timestamp IS the creation time for a task the
                // board watches appear. A hydrated value wins, since a
                // re-decompose re-emits TaskCreated for an existing id
                // and must not restart the clock.
                if (row && row.createdAt === null
                    && typeof event.occurredAt === 'number') {
                    row.createdAt = event.occurredAt;
                }
            }
            if (
                typeof payload.sourceTaskId === 'string'
                && typeof payload.sourceReportId === 'string'
            ) {
                const r = investigationReports.get(payload.sourceTaskId);
                if (r && r.reportId === payload.sourceReportId) {
                    r.implemented = true;
                }
            }
            return;
        }
        case 'TaskApproved': {
            if (typeof payload.taskId !== 'string') return;
            const t = tasks.get(payload.taskId);
            if (!t) return;
            t.status = 'approved';
            if (typeof payload.flowId === 'string') t.flowId = payload.flowId;
            return;
        }
        case 'TaskPreApproved': {
            // Operator approved a task that's still waiting on deps. It
            // stays parked 'waiting-deps' but will auto-start when the
            // upstreams merge — flip the in-memory flag so the card
            // shows the approved state and drops its Approve button.
            if (typeof payload.taskId !== 'string') return;
            const t = tasks.get(payload.taskId);
            if (t) t.preApproved = true;
            return;
        }
        case 'TaskInstructionsSet': {
            // Operator added/edited instructions on a task (migration 022).
            if (typeof payload.taskId !== 'string') return;
            const t = tasks.get(payload.taskId);
            if (t) {
                t.instructions = typeof payload.instructions === 'string'
                    && payload.instructions.length > 0
                    ? payload.instructions
                    : null;
            }
            return;
        }
        case 'AttachmentAdded': {
            // Operator attached a file to a task / plan / requirement
            // (migration 021). Fold the metadata so the owner's modal
            // shows the new thumbnail / chip live, without a re-fetch.
            const meta = coerceAttachment(payload);
            if (meta) {
                upsertAttachment(meta);
                refreshAttachmentSections(meta.ownerType, meta.ownerId);
            }
            return;
        }
        case 'AttachmentRemoved': {
            const id = typeof payload.attachmentId === 'string' ? payload.attachmentId : '';
            const ownerType = coerceOwnerType(payload.ownerType);
            const ownerId = typeof payload.ownerId === 'string' ? payload.ownerId : '';
            if (id.length > 0 && ownerId.length > 0) {
                removeAttachmentLocal(ownerType, ownerId, id);
                refreshAttachmentSections(ownerType, ownerId);
            }
            return;
        }
        case 'TaskRetried': {
            // Operator pressed Retry. Wipe every "this task already ran"
            // signal off the in-memory row so the card returns to a
            // fresh-task layout (Approve gate buttons via
            // renderApprovalControls once TaskParked arrives, then the
            // agent chain re-runs). The stream tail is also dropped so
            // the new run's transcript starts clean.
            if (typeof payload.taskId !== 'string') return;
            const t = tasks.get(payload.taskId);
            if (!t) return;
            t.status = 'created';
            t.parkedReason = null;
            t.parkedQuestion = null;
            t.parkedStepId = null;
            t.commitError = null;
            streamTails.delete(payload.taskId);
            taskAgents.delete(payload.taskId);
            approvalRejectOpen.delete(payload.taskId);
            approvalRejectFeedback.delete(payload.taskId);
            return;
        }
        case 'TaskSkipped': {
            // Keep the task row in the Map (status='skipped') so the
            // plan modal can still surface it under the archived /
            // completed sections. `renderTasksFlat` filters by
            // status + TASK_IN_PROGRESS_STATES so the card drops out
            // of the active board. Also clear the parked flags — a
            // dismissed task should not carry forward "Awaiting
            // review" / "Awaiting answer" metadata that would
            // mislead the modal view, and the active-task filter
            // double-guards against stale parkedReason on the
            // row. Drop the transient per-task adornments (stream
            // tail, investigation report, clarification choice) —
            // those carry no value once the task is shelved.
            if (typeof payload.taskId !== 'string') return;
            const t = tasks.get(payload.taskId);
            if (t) {
                t.status = 'skipped';
                t.parkedReason = null;
                t.parkedQuestion = null;
                t.parkedStepId = null;
            }
            streamTails.delete(payload.taskId);
            investigationReports.delete(payload.taskId);
            clarificationChoices.delete(payload.taskId);
            return;
        }
        case 'TaskUpdated': {
            if (typeof payload.taskId !== 'string') return;
            const t = tasks.get(payload.taskId);
            if (!t) return;
            if (Array.isArray(payload.investigation_thread)) {
                t.investigation_thread = (
                    payload.investigation_thread as TaskRow['investigation_thread']
                ).slice();
            }
            if (typeof payload.followup_inflight === 'boolean') {
                t.followup_inflight = payload.followup_inflight;
            }
            return;
        }
        case 'TaskFieldsUpdated': {
            if (typeof payload.taskId !== 'string') return;
            const t = tasks.get(payload.taskId);
            if (!t) return;
            if (typeof payload.title === 'string') t.title = payload.title;
            if (typeof payload.description === 'string') t.description = payload.description;
            if (typeof payload.type === 'string') t.type = payload.type;
            if (typeof payload.flowId === 'string') t.flowId = payload.flowId;
            return;
        }
        case 'TaskDeleted': {
            if (typeof payload.taskId !== 'string') return;
            tasks.delete(payload.taskId);
            streamTails.delete(payload.taskId);
            investigationReports.delete(payload.taskId);
            clarificationChoices.delete(payload.taskId);
            return;
        }
        case 'AgentStarted': {
            const taskId = agentEventTaskId(payload);
            if (!taskId) return;
            const t = tasks.get(taskId);
            if (!t) return;
            t.parkedReason = null;
            t.parkedQuestion = null;
            t.parkedStepId = null;
            const role = typeof payload.agent === 'string'
                ? payload.agent
                : typeof payload.role === 'string' ? payload.role : '';
            t.status = AGENT_ROLE_TO_COLUMN[role] ?? 'in_progress';
            const agentId = typeof payload.agentId === 'string' ? payload.agentId : '';
            const now = Date.now();
            // Track the per-step record so the stage-bar chip flips to
            // 'running' immediately. The summary stays null until the
            // terminal event lands.
            const md = payload.metadata;
            if (md && typeof md === 'object') {
                const stepId = (md as Record<string, unknown>).stepId;
                if (typeof stepId === 'string' && stepId.length > 0) {
                    setTaskStepRecord(taskId, {
                        stepId,
                        role: role || null,
                        status: 'running',
                        startedAt: now,
                        finishedAt: null,
                        summary: null,
                    });
                }
            }
            // Reset the run record so a fresh AgentStarted (e.g. after
            // Retry → re-spawn) doesn't keep the prior run's activities.
            taskAgents.set(taskId, {
                taskId,
                agentId,
                role: role || 'agent',
                startedAt: now,
                activities: [
                    {
                        at: now,
                        category: 'lifecycle',
                        detail: `${role || 'agent'} started${agentId ? ` · ${agentId}` : ''}`,
                    },
                ],
                status: 'running',
            });
            appendStreamLine(taskId, 'started', `▶ ${role || 'agent'} started`);
            return;
        }
        case 'AgentProgress': {
            // Per-task assistant chunks from the runner. Each chunk is
            // a `text` block emitted by the stream-json parser.
            const taskId = agentEventTaskId(payload);
            if (!taskId) return;
            if (!tasks.has(taskId)) return;
            const chunk = typeof payload.chunk === 'string' ? payload.chunk : '';
            const trimmed = chunk.trim();
            if (trimmed.length === 0) return;
            const run = taskAgents.get(taskId);
            if (run) {
                coalesceAssistantChunk(run.activities, chunk, (entry) =>
                    pushTaskAgentActivity(run, entry));
            }
            appendAssistantStreamText(taskId, chunk);
            return;
        }
        case 'AgentActivity': {
            // Tool use / lifecycle / metadata frames the parser
            // classifies separately from assistant text.
            const taskId = agentEventTaskId(payload);
            if (!taskId) return;
            if (!tasks.has(taskId)) return;
            const category = typeof payload.category === 'string' ? payload.category : 'event';
            const detail = typeof payload.detail === 'string' ? payload.detail : '';
            const extra = typeof payload.extra === 'string' ? payload.extra : undefined;
            if (detail.length === 0) return;
            const run = taskAgents.get(taskId);
            if (run) {
                pushTaskAgentActivity(run, {
                    at: Date.now(),
                    category,
                    detail,
                    ...(extra !== undefined ? { extra } : {}),
                });
            }
            appendStreamLine(taskId, category, truncate(detail, 240));
            return;
        }
        case 'AgentFinished': {
            const taskId = agentEventTaskId(payload);
            if (!taskId) return;
            const t = tasks.get(taskId);
            if (!t) return;
            const idx = COLUMNS.indexOf(t.status as Column);
            if (idx >= 0 && idx < COLUMNS.length - 1) t.status = COLUMNS[idx + 1];
            const role = typeof payload.agent === 'string'
                ? payload.agent
                : typeof payload.role === 'string' ? payload.role : '';
            const run = taskAgents.get(taskId);
            if (run) {
                run.status = 'complete';
                run.finishedAt = Date.now();
                pushTaskAgentActivity(run, {
                    at: Date.now(),
                    category: 'lifecycle',
                    detail: `${role || 'agent'} finished`,
                });
            }
            // Flip the stage-bar chip to 'complete' and populate the
            // summary so the click-to-open modal has content. The
            // summary is the joined assistant text from the in-flight
            // run's chunk buffer — same source the orchestrator uses
            // for the durable `task_step_summaries.summary` column.
            const fmd = payload.metadata;
            if (fmd && typeof fmd === 'object') {
                const stepId = (fmd as Record<string, unknown>).stepId;
                if (typeof stepId === 'string' && stepId.length > 0) {
                    const prev = taskStepRuns.get(taskId)?.get(stepId);
                    const summaryText = run
                        ? run.activities
                              .filter((a) => a.category === 'assistant')
                              .map((a) => a.extra ?? a.detail)
                              .join('\n\n') || null
                        : null;
                    setTaskStepRecord(taskId, {
                        stepId,
                        role: role || prev?.role || null,
                        status: 'complete',
                        startedAt: prev?.startedAt ?? Date.now(),
                        finishedAt: Date.now(),
                        summary: summaryText,
                    });
                }
            }
            appendStreamLine(taskId, 'finished', `■ ${role || 'agent'} finished`);
            return;
        }
        case 'TaskFailed': {
            // Engine terminal (no on_failure, retry budget, reject
            // fallback) — same Retry-surfacing rule as AgentFailed.
            const taskId = typeof payload.taskId === 'string' ? payload.taskId : null;
            if (!taskId) return;
            const t = tasks.get(taskId);
            if (!t) return;
            t.status = 'failed';
            if (typeof payload.failed_stage === 'string') {
                t.failed_stage = payload.failed_stage;
            }
            return;
        }
        case 'AgentFailed': {
            const taskId = agentEventTaskId(payload);
            if (!taskId) return;
            const t = tasks.get(taskId);
            if (!t) return;
            // Failed runs flip status so pruneTaskActions surfaces the
            // Retry button — without this the card sits on its prior
            // status (in_progress/approved/etc.) and the operator has
            // no clear path to redo the step.
            t.status = 'failed';
            {
                const md2 = payload.metadata;
                const sid = typeof payload.stepId === 'string'
                    ? payload.stepId
                    : md2 && typeof md2 === 'object'
                        ? (md2 as Record<string, unknown>).stepId
                        : undefined;
                if (typeof sid === 'string' && sid.length > 0) {
                    t.failed_stage = failedStageForStep(sid);
                }
            }
            const role = typeof payload.agent === 'string'
                ? payload.agent
                : typeof payload.role === 'string' ? payload.role : '';
            const tail = typeof payload.stderrTail === 'string'
                ? truncate(payload.stderrTail as string, 240)
                : '';
            const run = taskAgents.get(taskId);
            if (run) {
                run.status = 'failed';
                run.finishedAt = Date.now();
                if (tail) run.error = tail;
                pushTaskAgentActivity(run, {
                    at: Date.now(),
                    category: 'lifecycle',
                    detail: `${role || 'agent'} failed${tail ? ` · ${tail}` : ''}`,
                });
            }
            const ffmd = payload.metadata;
            if (ffmd && typeof ffmd === 'object') {
                const stepId = (ffmd as Record<string, unknown>).stepId;
                if (typeof stepId === 'string' && stepId.length > 0) {
                    const prev = taskStepRuns.get(taskId)?.get(stepId);
                    const summaryText = run
                        ? run.activities
                              .filter((a) => a.category === 'assistant')
                              .map((a) => a.extra ?? a.detail)
                              .join('\n\n') || (tail || null)
                        : (tail || null);
                    setTaskStepRecord(taskId, {
                        stepId,
                        role: role || prev?.role || null,
                        status: 'failed',
                        startedAt: prev?.startedAt ?? Date.now(),
                        finishedAt: Date.now(),
                        summary: summaryText,
                    });
                }
            }
            appendStreamLine(
                taskId,
                'failed',
                `✕ ${role || 'agent'} failed${tail ? ': ' + tail : ''}`,
            );
            return;
        }
        case 'agent.failed': {
            // The SEMANTIC failure path. A tester that ran fine but
            // found failing tests exits 0, so the runner publishes
            // AgentFinished and the fold above painted the chip green.
            // The orchestrator then parses the role's verdict sentinel
            // ("TESTS FAILED:", "CHANGES REQUIRED:", "STALE:", …),
            // flips the durable task_step_summaries row to 'failed' and
            // republishes the run as this flow event.
            //
            // Without this case the board kept the green chip until the
            // summary modal's catch-up fetch read the durable row and
            // silently corrected it — the operator saw a step go from
            // green to red purely for having looked at it.
            if (typeof payload.taskId !== 'string') return;
            const taskId = payload.taskId;
            const t = tasks.get(taskId);
            if (!t) return;
            const reason = typeof payload.reason === 'string' ? payload.reason : '';
            const stepId = resolveFailedStepId(
                payload.stepId,
                (taskStepRuns.get(taskId) ?? new Map()).values(),
            );
            t.status = 'failed';
            if (stepId) {
                t.failed_stage = failedStageForStep(stepId);
                const prev = taskStepRuns.get(taskId)?.get(stepId);
                setTaskStepRecord(
                    taskId,
                    applyStepFailure(prev, {
                        stepId,
                        role: prev?.role ?? null,
                        reason,
                        now: Date.now(),
                    }),
                );
            }
            const run = taskAgents.get(taskId);
            if (run && run.status !== 'failed') {
                run.status = 'failed';
                run.finishedAt = Date.now();
                if (reason) run.error = truncate(reason, 240);
                pushTaskAgentActivity(run, {
                    at: Date.now(),
                    category: 'lifecycle',
                    detail: reason || 'agent reported failure',
                });
            }
            appendStreamLine(
                taskId,
                'failed',
                `✕ ${reason || 'agent reported failure'}`,
            );
            return;
        }
        case 'AgentQuestion': {
            const taskId = agentEventTaskId(payload);
            if (!taskId) return;
            const role = typeof payload.agent === 'string'
                ? payload.agent
                : typeof payload.role === 'string' ? payload.role : '';
            const q = typeof payload.question === 'string' ? payload.question : '';
            appendStreamLine(
                taskId,
                'question',
                `? ${role || 'agent'}${q ? ': ' + truncate(q, 140) : ''}`,
            );
            return;
        }
        case 'TaskParked': {
            if (typeof payload.taskId !== 'string') return;
            const t = tasks.get(payload.taskId);
            if (!t) return;
            t.parkedReason = typeof payload.reason === 'string' ? payload.reason : null;
            t.parkedQuestion =
                typeof payload.question === 'string' ? payload.question : null;
            // AP-VP-015 — TaskParked carries `stepId` (see
            // TaskParkedEventPayload). Capture it so the approval-gate
            // card can map (parkedReason='approval', stepId) → v1 tag.
            t.parkedStepId =
                typeof payload.stepId === 'string' ? payload.stepId : null;
            if (t.parkedReason === 'clarification' && t.parkedQuestion) {
                appendStreamLine(
                    payload.taskId,
                    'parked',
                    `⏸ parked (clarification): ${truncate(t.parkedQuestion, 140)}`,
                );
            } else if (t.parkedReason) {
                appendStreamLine(payload.taskId, 'parked', `⏸ parked (${t.parkedReason})`);
            }
            return;
        }
        case 'TaskResumed': {
            if (typeof payload.taskId !== 'string') return;
            const t = tasks.get(payload.taskId);
            if (!t) return;
            t.parkedReason = null;
            t.parkedQuestion = null;
            t.parkedStepId = null;
            t.commitError = null;
            // AP-VP-015 — drop any in-flight reject-feedback panel state
            // so a fresh park doesn't inherit a stale textarea.
            approvalRejectOpen.delete(payload.taskId);
            approvalRejectFeedback.delete(payload.taskId);
            // AP-VP5-014 — clarification choices belonged to the question
            // the agent just got an answer to; they're stale once the
            // task resumes (the next park may have a different choice set
            // or none at all).
            clarificationChoices.delete(payload.taskId);
            appendStreamLine(payload.taskId, 'resumed', '▶ resumed');
            return;
        }
        case 'TaskPrOpened': {
            // The post-commit hook just opened a PR. Stamp the URL +
            // number onto the in-memory row so the card swaps the
            // Create PR button for Merge PR on the next paint, without
            // the operator having to reload.
            if (typeof payload.taskId !== 'string') return;
            const t = tasks.get(payload.taskId);
            if (!t) return;
            if (typeof payload.prUrl === 'string' && payload.prUrl.length > 0) {
                t.prUrl = payload.prUrl;
            }
            if (typeof payload.prNumber === 'number'
                && Number.isFinite(payload.prNumber)) {
                t.prNumber = payload.prNumber;
            }
            // The PR landed — clear any prior push/PR failure flag.
            t.commitError = null;
            return;
        }
        case 'TaskCommitFailed': {
            // The post-commit hook failed to push the branch or open the
            // PR — the commit is local only, NOT on GitHub. Flag it so the
            // card renders a "push/PR failed - retry" state instead of a
            // misleading clean "Awaiting merge".
            if (typeof payload.taskId !== 'string') return;
            const t = tasks.get(payload.taskId);
            if (!t) return;
            const stage = payload.stage === 'pr' ? 'PR creation' : 'push';
            const err = typeof payload.error === 'string' ? payload.error : '';
            t.commitError = `${stage} failed${err ? `: ${truncate(err, 200)}` : ''}`;
            appendStreamLine(payload.taskId, 'parked', `✗ ${stage} failed`);
            return;
        }
        case 'TaskFinished': {
            // Engine reached `emit:TaskFinished` (after wait-merged
            // resumed following a successful PR merge). Flip the
            // in-memory row to status='done' and clear the parked
            // metadata so the card collapses to its Done state
            // (Dismiss-only) on the next paint. `pruneTaskActions`
            // hides Merge PR / Create PR / Resume for done tasks.
            if (typeof payload.taskId !== 'string') return;
            const t = tasks.get(payload.taskId);
            if (!t) return;
            t.status = 'done';
            t.parkedReason = null;
            t.parkedQuestion = null;
            t.parkedStepId = null;
            return;
        }
        case 'AgentRunOrphaned': {
            // A run the previous worker process left mid-flight. The
            // chip has been spinning on a process that no longer
            // exists; flip it to failed and carry the explanation so
            // the step modal says what happened instead of
            // "(agent still running …)" forever. The TaskParked that
            // follows (when it is the operator's to deal with) paints
            // the card itself.
            if (typeof payload.taskId !== 'string') return;
            if (typeof payload.stepId !== 'string') return;
            const prev = taskStepRuns.get(payload.taskId)?.get(payload.stepId);
            const note = typeof payload.note === 'string' ? payload.note : '';
            setTaskStepRecord(payload.taskId, {
                stepId: payload.stepId,
                role: typeof payload.role === 'string' ? payload.role : prev?.role ?? null,
                status: 'failed',
                startedAt: typeof payload.startedAt === 'number'
                    ? payload.startedAt
                    : prev?.startedAt ?? Date.now(),
                finishedAt: Date.now(),
                summary: note.length > 0 ? note : prev?.summary ?? null,
            });
            const run = taskAgents.get(payload.taskId);
            if (run && run.status === 'running') {
                run.status = 'failed';
                // Stop agent must stop offering to kill it.
                run.agentId = '';
            }
            appendStreamLine(
                payload.taskId,
                'parked',
                `✗ ${payload.stepId} run lost to a worker restart`,
            );
            return;
        }
        case 'TaskMergeEnqueued': {
            // The merge is QUEUED with GitHub (its required checks had
            // not passed yet) or the pipeline has stopped waiting for
            // it. The park stays `wait-merged` — the card keeps its
            // Awaiting-merge treatment and its Merge PR button — and
            // only the explanation changes, so the operator can see WHY
            // nothing is happening instead of watching a silent card.
            if (typeof payload.taskId !== 'string') return;
            const t = tasks.get(payload.taskId);
            if (!t) return;
            const note = typeof payload.note === 'string' ? payload.note : '';
            if (note.length === 0) return;
            t.parkedQuestion = note;
            appendStreamLine(
                payload.taskId,
                'parked',
                `${payload.state === 'abandoned' ? '✗' : '⏳'} ${truncate(note, 180)}`,
            );
            return;
        }
        case 'ClarificationRequested': {
            // AP-VP5-014 — capture the agent's enumerated choices on the
            // side store so the AP-VP5-010 Answer button can hand them to
            // the clarify modal. The question text itself rides on
            // `TaskParked.payload.question`, which the projection has
            // already mapped onto `task.parkedQuestion` for us.
            if (typeof payload.taskId !== 'string') return;
            if (Array.isArray(payload.choices)) {
                const cleaned = (payload.choices as unknown[]).filter(
                    (c): c is string => typeof c === 'string',
                );
                clarificationChoices.set(payload.taskId, cleaned);
            } else {
                clarificationChoices.delete(payload.taskId);
            }
            return;
        }
        case 'investigation.completed':
        case 'InvestigationCompleted': {
            const taskId = payload.taskId;
            if (typeof taskId !== 'string') return;
            const reportId = String(event.seq);
            const markdown = typeof payload.answer === 'string' ? payload.answer : '';
            const existing = investigationReports.get(taskId);
            if (existing && Number(existing.reportId) > event.seq) return;
            investigationReports.set(taskId, {
                reportId,
                markdown,
                dismissed: false,
                implemented: false,
            });
            return;
        }
        case 'InvestigationDismissed': {
            const taskId = payload.taskId;
            const reportId = payload.reportId;
            if (typeof taskId !== 'string' || typeof reportId !== 'string') return;
            const r = investigationReports.get(taskId);
            if (!r || r.reportId !== reportId) return;
            r.dismissed = true;
            return;
        }
        case 'RepoRegistered':
        case 'RepoUpdated':
        case 'RepoArchived':
        case 'RepoEnsured':
        case 'RepoEnsureFailed':
        case 'RepoSynced':
        case 'RepoSyncFailed':
            applyRepoEvent(event.type, payload);
            return;
        default:
            return;
    }
}

// AP-PAO-009 — agent-role → Kanban column lookup. This is the residual
// of the deleted `roleToColumn(role)` helper, kept as a plain dict because
// the column projection is *separate* from the v1 multi-tag derivation
// owned by `deriveTaskTags` below. The columns model continues to drive
// the existing Kanban renderer; the tag model drives the per-card action
// matrix that web/board-task-cards.ts consumes.
const AGENT_ROLE_TO_COLUMN: Readonly<Record<string, Column>> = {
    developer: 'in_progress',
    reviewer: 'review',
    tester: 'test',
    committer: 'commit',
    merger: 'merge',
};

// V1-parity short labels for the type-badge. The badge's colour comes
// from the per-type CSS rule keyed on `data-task-type-badge`; the text
// here is the short readout. Mirrors the TYPE_STYLE labels in
// `web/board-task-cards.ts` so the runtime card matches the typed
// renderer used by tests.
const TYPE_BADGE_LABEL: Readonly<Record<string, string>> = {
    implement: 'IMPL',
    investigate: 'INV',
    docs: 'DOC',
    review: 'REV',
    refactor: 'RFC',
    scaffold: 'SCF',
    fix: 'FIX',
    test: 'TST',
};

// ---------- v1-parity task-tag derivation (AP-PAO-009) ----------------
//
// The v1 board cards rendered a *multi-tag* state — a single card could
// carry both `in_progress` and `awaiting_clarification`, or surface
// `failed:test` alongside the step it had been retrying. v2's prior
// `roleToColumn` / `advanceColumn` pair collapsed that to a single
// column string, losing the overlay states. `deriveTaskTags` restores
// the multi-tag projection; `getActionsForTags` returns the per-tag
// action-button matrix the v1 card row exposed.
//
// Both functions are PURE and exported here so the typed renderer in
// `web/board-task-cards.ts` (and the unit-test harness in
// `board.test.ts`) can derive tags + actions without re-implementing
// the table OR pulling in this entry's top-level browser wiring. The
// implementations live in `./task-tags` — board.ts is just the
// re-export seam, keeping the canonical "implemented in board.ts"
// surface the AP-PAO-009 plan calls out.

export {
    approvalStepTag,
    deriveTaskTags,
    type DeriveTagsEvent,
    type DeriveTagsTask,
    type FailedStage,
    type TaskTag,
} from './task-tags';

// AP-VP4-014 — pure TaskCreated reducer. Re-export so the bundle entry
// remains the canonical surface (matching `task-tags.ts`) while keeping
// the reducer importable from `board.test.ts` without dragging in any
// of this file's browser wiring. See `./task-projection` for why the
// "one Map.set per TaskCreated" contract is load-bearing.
export { applyTaskCreated, type TaskProjectionRow } from './task-projection';

// Report availability (View-report gating) — pure rule, see
// ./report-availability. Re-exported so tests can reach it through the
// canonical bundle entry like task-tags / task-projection.
export {
    hasReadableReport,
    pickReportStep,
    taskTypeProducesReport,
    REPORT_TASK_TYPES,
} from './report-availability';

/**
 * Assistant text for the card's stream tail — coalesces consecutive
 * assistant entries so partial-message deltas don't render one broken
 * word per line. Keeps the last 240 chars of the accumulated message.
 */
function appendAssistantStreamText(taskId: string, chunk: string): void {
    let tail = streamTails.get(taskId);
    if (!tail) {
        tail = [];
        streamTails.set(taskId, tail);
    }
    const last = tail[tail.length - 1];
    if (last && last.kind === 'assistant') {
        const full = `${last.text}${chunk}`;
        last.text = full.length > 240 ? `…${full.slice(-239)}` : full;
        last.at = Date.now();
        return;
    }
    const trimmed = chunk.trim();
    if (trimmed.length === 0) return;
    appendStreamLine(taskId, 'assistant', truncate(trimmed, 240));
}

function appendStreamLine(taskId: string, kind: string, text: string): void {
    let tail = streamTails.get(taskId);
    if (!tail) {
        tail = [];
        streamTails.set(taskId, tail);
    }
    tail.push({ kind, text, at: Date.now() });
    if (tail.length > STREAM_TAIL_LIMIT) {
        tail.splice(0, tail.length - STREAM_TAIL_LIMIT);
    }
}

// Agent runner events (AgentStarted / AgentProgress / AgentActivity /
// AgentFinished / AgentQuestion) carry the task id on `metadata.taskId`
// — that's where the orchestrator's StartAgent handler stamps it.
// Reading `payload.taskId` directly silently drops every per-task agent
// event because the runners (FakeAgentRunner, ClaudeCliRunner) never
// populate that field at the payload root. Use this helper everywhere
// a runner-emitted event needs to attribute to a task.
function agentEventTaskId(payload: Record<string, unknown>): string | null {
    if (typeof payload.taskId === 'string') return payload.taskId;
    const md = payload.metadata;
    if (md && typeof md === 'object') {
        const t = (md as Record<string, unknown>).taskId;
        if (typeof t === 'string') return t;
    }
    return null;
}

function truncate(text: string, max: number): string {
    if (text.length <= max) return text;
    return text.slice(0, max - 1) + '…';
}

function parkedChipLabel(reason: string): string {
    switch (reason) {
        case 'clarification':
            return 'Needs answer';
        case 'wait-action':
            return 'Awaiting action';
        case 'wait-merged':
            return 'Awaiting merge';
        case 'worktree-diff-review':
            return 'Awaiting review';
        case 'waiting-deps':
            return 'Waiting on deps';
        default:
            return 'Parked';
    }
}

// ----- rendering -------------------------------------------------------

const planListEl = document.getElementById('plan-list');
const planTemplate = document.getElementById('plan-card-template') as HTMLTemplateElement | null;
const taskTemplate = document.getElementById('task-card-template') as HTMLTemplateElement | null;
const columnEls = new Map<string, HTMLElement>();
COLUMNS.forEach((col) => {
    const el = document.querySelector(`.column[data-column="${col}"]`) as HTMLElement | null;
    if (el) columnEls.set(col, el);
});

/**
 * True between mousedown and mouseup anywhere on the board.
 *
 * A click is only dispatched when both halves land on the SAME element.
 * `render()` rebuilds cards wholesale, so a repaint that lands mid-press
 * destroys the button under the pointer and the click never happens —
 * the operator sees the card flicker and their click do nothing.
 *
 * Cutting the streaming repaints (see `render-scheduling.ts`) removed the
 * flood, but a burst of real events — a decomposer emitting a dozen
 * TaskCreated at once — can still land inside a press. So renders are held
 * for the few hundred milliseconds a press lasts and flushed straight
 * after. Nothing is dropped: `renderPending` remembers that one is owed.
 *
 * Released on pointerup, pointercancel and window blur, and by a timeout,
 * because a press whose release is never observed (pointer dragged out of
 * the window, a swallowed event) must not freeze the board.
 */
let pointerHeld = false;
let renderPending = false;
let pointerReleaseTimer: ReturnType<typeof setTimeout> | null = null;

function releasePointerHold(): void {
    if (!pointerHeld) return;
    pointerHeld = false;
    if (pointerReleaseTimer !== null) {
        clearTimeout(pointerReleaseTimer);
        pointerReleaseTimer = null;
    }
    if (renderPending) {
        renderPending = false;
        scheduleRender();
    }
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    document.addEventListener('pointerdown', () => {
        pointerHeld = true;
        if (pointerReleaseTimer !== null) clearTimeout(pointerReleaseTimer);
        // Safety net: a press this long is not a click any more.
        pointerReleaseTimer = setTimeout(releasePointerHold, 1_000);
    }, true);
    document.addEventListener('pointerup', releasePointerHold, true);
    document.addEventListener('pointercancel', releasePointerHold, true);
    window.addEventListener('blur', releasePointerHold);
}

let renderScheduled = false;
function scheduleRender(): void {
    if (renderScheduled) return;
    // Hold the repaint until the press finishes — see `pointerHeld`.
    if (pointerHeld) {
        renderPending = true;
        return;
    }
    renderScheduled = true;
    requestAnimationFrame(() => {
        renderScheduled = false;
        render();
    });
}

/**
 * Repaint ONLY the agent-stream modals.
 *
 * A streaming chunk changes nothing the board draws — see
 * `render-scheduling.ts` for why, and for the flicker/lost-click problem
 * that came from repainting everything per token. Each refresher below
 * early-returns when its modal is closed, so with none open this costs
 * nothing at all.
 *
 * Skipped entirely when a full render is already queued: that does all of
 * this and more, and running both in one frame would rebuild the modal
 * bodies twice.
 */
let streamRenderScheduled = false;
function scheduleStreamRender(): void {
    if (renderScheduled || streamRenderScheduled) return;
    streamRenderScheduled = true;
    requestAnimationFrame(() => {
        streamRenderScheduled = false;
        refreshShowPlannerAgentModal();
        refreshShowDecomposerAgentModal();
        refreshShowTaskAgentModal();
        refreshShowArchitectAgentModal();
    });
}

function render(): void {
    renderPlans();
    renderTasks();
    renderActivePlanners();
    renderActiveDecomposers();
    renderRequirements();
    renderArchivedRequirements();
    renderPlanSections();
    refreshPlanModal();
    refreshTaskModal();
    // The Show-planner-agent modal mirrors `activePlanners` directly;
    // a no-op when the modal is closed (early return on null body
    // ref). Hooking it into the rAF-batched paint keeps the stream
    // body in sync with AgentProgress events without standing up a
    // dedicated subscription.
    refreshShowPlannerAgentModal();
    refreshShowDecomposerAgentModal();
    refreshShowTaskAgentModal();
    refreshShowArchitectAgentModal();
    // Same story for the sidebar's plan tree — planner badge state
    // lives in activePlanners and only the sidebar surface reads it.
    // The plan-tree renderer doesn't auto-subscribe to applyEvent
    // updates today (it re-paints when crudState changes), so trigger
    // a redraw any time a planner-related event arrived.
    if (sidebarShouldRedraw()) renderPlanTree();
}

/**
 * Fill the `#active-planners` section in the main board area with one
 * card per entry in `activePlanners`. The card is the prominent
 * surface the operator interacts with — sidebar plan rows carry a
 * lighter-weight running badge as a hint, but the action buttons
 * (Show agent / Show report) live on this main-area card.
 *
 * Reads the plan's title from `crudState.plans` when available so the
 * card reads as "Planner — <plan title>" instead of a raw planId.
 * Cards are sorted by `startedAt` so the oldest in-flight planner
 * sits at the top.
 */
/**
 * Hide a board section element when it has no cards to show. Reduces
 * visual noise — empty section headers (Active planners, Active
 * decomposers, Draft plans, …) read as "there is something here" even
 * when their body is blank; collapsing the whole `<section>` makes the
 * board's surface area track actual activity.
 */
function toggleSectionVisible(sectionId: string, visible: boolean): void {
    const sectionEl = document.getElementById(sectionId);
    if (!sectionEl) return;
    sectionEl.hidden = !visible;
}

/**
 * Project-scoped visibility helper used by every board renderer that
 * surfaces plans, tasks, or per-plan agent cards. When the operator
 * picks "All projects" in the sidebar (`crudState.selectedProjectId === null`)
 * everything shows; when they pick a specific project, the board narrows
 * to that project. Rows missing a `projectId` (legacy data, partial
 * hydration) are surfaced in All mode and hidden when a specific
 * project is selected, so the operator's filter is never accidentally
 * broadened by orphan rows.
 */
/**
 * A task's owning project, falling back to its PLAN's.
 *
 * `TaskCreated` carries no `projectId` — the payload is
 * `{taskId, planId, type, flowId}` plus optional lineage. So a task
 * folded from the live SSE stream has `projectId: null`, while the SAME
 * task hydrated from `/api/tasks` has one, because that query derives it
 * with `LEFT JOIN sidebar_plans sp ON sp.plan_id = t.plan_id`.
 *
 * With a project selected in the sidebar, `isVisibleForCurrentProject`
 * treats an unknown project as "not mine" and hides the row. The reported
 * symptom: a task added from the plan-modal chat produced a Telegram
 * notification with its id and appeared nowhere on the board — until a
 * hard refresh, which replaced the live row with a hydrated one and made
 * it appear. That is also why it looked like the click had done nothing.
 *
 * The plan is the authority either way (the API's join says so), so
 * resolve through it here rather than trusting every publisher to
 * remember the field. `CreateTask` now stamps it too, but this keeps the
 * board correct for any emitter that does not.
 */
function projectIdForTask(task: {
    readonly projectId?: string | null;
    readonly planId?: string | null;
}): string | null {
    if (typeof task.projectId === 'string' && task.projectId.length > 0) {
        return task.projectId;
    }
    const planId = task.planId;
    if (typeof planId !== 'string' || planId.length === 0) return null;
    return plans.get(planId)?.projectId ?? null;
}

function isVisibleForCurrentProject(projectId: string | null | undefined): boolean {
    const sel = crudState.selectedProjectId;
    if (sel === null || sel === '') return true;
    if (typeof projectId !== 'string' || projectId.length === 0) return false;
    return projectId === sel;
}

function renderActivePlanners(): void {
    const section = document.querySelector(
        '#active-planners [data-section-body]',
    ) as HTMLElement | null;
    const countBadge = document.querySelector(
        '#active-planners [data-count-badge]',
    ) as HTMLElement | null;
    if (!section) return;
    const rows = Array.from(activePlanners.values())
        .filter((p) => isVisibleForCurrentProject(p.projectId))
        .sort((a, b) => a.startedAt - b.startedAt);
    if (countBadge) {
        countBadge.textContent = rows.length === 0 ? '' : String(rows.length);
    }
    section.replaceChildren();
    for (const row of rows) {
        section.appendChild(renderActivePlannerCard(row));
    }
    toggleSectionVisible('active-planners', rows.length > 0);
}

function renderActivePlannerCard(planner: ActivePlanner): HTMLElement {
    const card = document.createElement('article');
    card.className = `active-planner-card active-planner-card--${planner.status}`;
    card.setAttribute('data-active-planner-card', planner.planId);
    card.setAttribute('data-planner-status', planner.status);

    const planTitle = (() => {
        const fromPlans = plans.get(planner.planId)?.title ?? null;
        if (fromPlans && fromPlans.length > 0) return fromPlans;
        const fromCrud
            = crudState.plans.find((p) => p.id === planner.planId)?.title ?? '';
        return fromCrud.length > 0 ? fromCrud : planner.planId;
    })();

    const header = document.createElement('header');
    header.className = 'active-planner-card__header';
    const title = document.createElement('h4');
    title.className = 'active-planner-card__title';
    title.textContent = `Planner — ${planTitle}`;
    header.appendChild(title);
    const agentTag = document.createElement('span');
    agentTag.className = 'active-planner-card__agent';
    agentTag.textContent = `planner${planner.model ? ` · ${planner.model}` : ''}`;
    header.appendChild(agentTag);
    const statusPill = document.createElement('span');
    statusPill.className
        = `active-planner-card__status active-planner-card__status--${planner.status}`;
    statusPill.textContent
        = planner.status === 'running'
            ? '● Planner running'
            : planner.status === 'complete'
                ? '✓ Plan ready'
                : `✗ Failed${planner.error ? ` — ${planner.error}` : ''}`;
    header.appendChild(statusPill);
    card.appendChild(header);

    if (planner.revision !== undefined) {
        const meta = document.createElement('div');
        meta.className = 'active-planner-card__meta';
        meta.textContent = `Revision ${planner.revision}`;
        card.appendChild(meta);
    }

    const actions = document.createElement('div');
    actions.className = 'active-planner-card__actions';

    // Running: Show agent (opens live stream modal) + Stop agent.
    // Complete: Show report (opens report modal with Approve / Regen /
    // Discard / Close).
    // Failed: Show report (with the error surfaced) + Discard.
    if (planner.status === 'running') {
        const showBtn = document.createElement('button');
        showBtn.type = 'button';
        showBtn.className = 'active-planner-card__action';
        showBtn.setAttribute('data-action', 'show-agent');
        showBtn.textContent = 'Show agent';
        showBtn.addEventListener('click', () => {
            openShowPlannerAgentModal(planner.planId);
        });
        actions.appendChild(showBtn);
    } else {
        // Completed (or failed): primary action is Show report —
        // operator's main decision point lives there (approve /
        // regenerate with feedback / discard / close). Show agent
        // stays available as a secondary so the operator can re-read
        // the planner's stream after the fact.
        const reportBtn = document.createElement('button');
        reportBtn.type = 'button';
        reportBtn.className
            = 'active-planner-card__action active-planner-card__action--primary';
        reportBtn.setAttribute('data-action', 'show-report');
        reportBtn.textContent = 'Show report';
        reportBtn.addEventListener('click', () => {
            openShowPlannerReportModal(planner.planId);
        });
        actions.appendChild(reportBtn);
        const showAgentBtn = document.createElement('button');
        showAgentBtn.type = 'button';
        showAgentBtn.className = 'active-planner-card__action';
        showAgentBtn.setAttribute('data-action', 'show-agent');
        showAgentBtn.textContent = 'Show agent';
        showAgentBtn.addEventListener('click', () => {
            openShowPlannerAgentModal(planner.planId);
        });
        actions.appendChild(showAgentBtn);
    }
    card.appendChild(actions);
    return card;
}

/**
 * Paint one card per non-dismissed entry in {@link activeDecomposers}.
 * Symmetric with {@link renderActivePlanners}: same section-list slot
 * convention, same sort order. The card surfaces:
 *
 *   - while running: Show agent (+ Stop agent button via the modal)
 *   - on complete:   Show agent + Dismiss
 *   - on failed:     Show agent + Dismiss
 *
 * Completed/failed cards persist on the board until the operator
 * clicks Dismiss — matches the explicit ask: the decomposer card is a
 * post-run review surface, not a transient toast.
 */
function renderActiveDecomposers(): void {
    const section = document.querySelector(
        '#active-decomposers [data-section-body]',
    ) as HTMLElement | null;
    const countBadge = document.querySelector(
        '#active-decomposers [data-count-badge]',
    ) as HTMLElement | null;
    if (!section) return;
    const rows = Array.from(activeDecomposers.values())
        .filter((r) => r.dismissed !== true)
        .filter((r) => isVisibleForCurrentProject(r.projectId))
        .sort((a, b) => a.startedAt - b.startedAt);
    if (countBadge) {
        countBadge.textContent = rows.length === 0 ? '' : String(rows.length);
    }
    section.replaceChildren();
    for (const row of rows) {
        section.appendChild(renderActiveDecomposerCard(row));
    }
    toggleSectionVisible('active-decomposers', rows.length > 0);
}

function renderActiveDecomposerCard(dec: ActiveDecomposer): HTMLElement {
    const card = document.createElement('article');
    card.className = `active-planner-card active-decomposer-card active-planner-card--${dec.status}`;
    card.setAttribute('data-active-decomposer-card', dec.planId);
    card.setAttribute('data-decomposer-status', dec.status);

    const planTitle = (() => {
        const fromPlans = plans.get(dec.planId)?.title ?? null;
        if (fromPlans && fromPlans.length > 0) return fromPlans;
        const fromCrud
            = crudState.plans.find((p) => p.id === dec.planId)?.title ?? '';
        return fromCrud.length > 0 ? fromCrud : dec.planId;
    })();

    const header = document.createElement('header');
    header.className = 'active-planner-card__header';
    const title = document.createElement('h4');
    title.className = 'active-planner-card__title';
    title.textContent = `Decomposer — ${planTitle}`;
    header.appendChild(title);
    const agentTag = document.createElement('span');
    agentTag.className = 'active-planner-card__agent';
    agentTag.textContent = `decomposer${dec.model ? ` · ${dec.model}` : ''}`;
    header.appendChild(agentTag);
    const statusPill = document.createElement('span');
    statusPill.className
        = `active-planner-card__status active-planner-card__status--${dec.status}`;
    statusPill.textContent
        = dec.status === 'running'
            ? '● Decomposer running'
            : dec.status === 'complete'
                ? '✓ Decomposer complete'
                : dec.status === 'awaiting'
                    ? '❓ Waiting for your answer'
                    : `✗ Failed${dec.error ? ` — ${dec.error}` : ''}`;
    header.appendChild(statusPill);
    card.appendChild(header);

    // The question goes on the CARD, not only inside the Answer modal. A
    // question the operator has to open a dialog to read is a question they
    // walk past — the whole point of holding the run is that they notice.
    if (dec.status === 'awaiting' && dec.question) {
        const questionRow = document.createElement('p');
        questionRow.className = 'active-planner-card__question';
        questionRow.setAttribute('data-decomposer-question', dec.planId);
        questionRow.textContent = truncate(dec.question, 400);
        card.appendChild(questionRow);
    }

    const actions = document.createElement('div');
    actions.className = 'active-planner-card__actions';

    if (dec.status === 'awaiting') {
        const answerBtn = document.createElement('button');
        answerBtn.type = 'button';
        answerBtn.className
            = 'active-planner-card__action active-planner-card__action--primary';
        answerBtn.setAttribute('data-action', 'answer-decomposer');
        answerBtn.textContent = 'Answer';
        answerBtn.addEventListener('click', () => {
            openDecomposerAnswer(dec);
        });
        actions.appendChild(answerBtn);

        // The way out. An ANSWER can never be an action: the
        // decomposer writes its own options, so one of them reading
        // "cancel the task" still only sends text back and re-spawns
        // the decomposer, which asks again. With no Dismiss while a
        // question is pending, that left no exit at all.
        const giveUpBtn = document.createElement('button');
        giveUpBtn.type = 'button';
        giveUpBtn.className
            = 'active-planner-card__action active-planner-card__action--danger';
        giveUpBtn.setAttribute('data-action', 'abandon-decomposer');
        giveUpBtn.textContent = 'Give up on the question';
        giveUpBtn.title = 'Retire the question without answering it. The'
            + ' decomposer is NOT re-run; the plan stays as it is and you can'
            + ' edit it and decompose again.';
        giveUpBtn.addEventListener('click', () => {
            void abandonDecomposerQuestion(dec.planId);
        });
        actions.appendChild(giveUpBtn);
    }

    const showBtn = document.createElement('button');
    showBtn.type = 'button';
    showBtn.className = 'active-planner-card__action';
    showBtn.setAttribute('data-action', 'show-agent');
    showBtn.textContent = 'Show agent';
    showBtn.addEventListener('click', () => {
        openShowDecomposerAgentModal(dec.planId);
    });
    actions.appendChild(showBtn);

    // Dismiss only makes sense for terminal states — a running
    // decomposer should be stopped (via the Show-agent modal's Stop
    // button) before its card is retired.
    //
    // `awaiting` is not terminal and deliberately gets no Dismiss: the
    // question stays pending in the projection either way, so dismissing
    // would only hide the one control that can un-hold the plan, and the
    // operator would have to work out that a reload brings it back.
    if (dec.status !== 'running' && dec.status !== 'awaiting') {
        const dismissBtn = document.createElement('button');
        dismissBtn.type = 'button';
        dismissBtn.className
            = 'active-planner-card__action active-planner-card__action--danger';
        dismissBtn.setAttribute('data-action', 'dismiss');
        dismissBtn.textContent = 'Dismiss';
        dismissBtn.addEventListener('click', () => {
            dismissDecomposerCard(dec.planId);
        });
        actions.appendChild(dismissBtn);
    }
    card.appendChild(actions);
    return card;
}

function dismissDecomposerCard(planId: string): void {
    const row = activeDecomposers.get(planId);
    if (!row) return;
    row.dismissed = true;
    scheduleRender();
}

let lastPlannerSidebarSig = '';
function sidebarShouldRedraw(): boolean {
    // Fingerprint the active-planner set so we only re-render the
    // sidebar when the badge contents would actually change. Avoids
    // tearing down the operator's in-flight CRUD inputs (Edit Plan
    // form, etc.) on every unrelated SSE event.
    const sig = Array.from(activePlanners.values())
        .map((p) => `${p.planId}:${p.status}:${p.chunks.length}`)
        .sort()
        .join('|');
    if (sig === lastPlannerSidebarSig) return false;
    lastPlannerSidebarSig = sig;
    return true;
}

function renderPlans(): void {
    if (!planListEl || !planTemplate) return;
    planListEl.replaceChildren();
    const sorted = Array.from(plans.values()).sort((a, b) =>
        a.planId.localeCompare(b.planId),
    );
    const planMaxColumnIdx = new Map<string, number>();
    for (const t of tasks.values()) {
        if (!t.planId) continue;
        const idx = COLUMNS.indexOf(t.status as Column);
        if (idx < 0) continue;
        const prior = planMaxColumnIdx.get(t.planId);
        if (prior === undefined || idx > prior) {
            planMaxColumnIdx.set(t.planId, idx);
        }
    }
    for (const plan of sorted) {
        const frag = planTemplate.content.cloneNode(true) as DocumentFragment;
        const cardEl = frag.querySelector('[data-plan-card]') as HTMLElement | null;
        if (cardEl) {
            cardEl.setAttribute('data-plan-id', plan.planId);
            cardEl.setAttribute('data-plan-status', plan.status);
        }
        (frag.querySelector('[data-plan-id]') as HTMLElement).textContent = plan.planId;
        (frag.querySelector('[data-plan-status]') as HTMLElement).textContent = plan.status;
        (frag.querySelector('[data-plan-project]') as HTMLElement).textContent = plan.projectId;
        // AP-IFB-003 — title slot. Empty when the projection hasn't
        // learned a title yet; the slot still exists in the DOM so
        // layout stays stable across projections.
        const titleEl = frag.querySelector('[data-plan-title]') as HTMLElement | null;
        if (titleEl) titleEl.textContent = plan.title ?? '';
        // AP-IFB-003 — tech-stack chips. One <span class="tech-tag">
        // per entry, in projection order. Skips blank entries so a
        // stray empty string from a stale projection cannot leave a
        // ghost chip behind.
        const techEl = frag.querySelector('[data-plan-tech-stack]') as HTMLElement | null;
        if (techEl) {
            techEl.replaceChildren();
            for (const tag of plan.techStack) {
                const trimmed = (tag ?? '').trim();
                if (!trimmed) continue;
                const chip = document.createElement('span');
                chip.className = 'tech-tag';
                chip.setAttribute('data-tech-tag', trimmed);
                chip.textContent = trimmed;
                techEl.appendChild(chip);
            }
        }
        const stageBarEl = frag.querySelector('[data-plan-stage-bar]') as HTMLElement | null;
        if (stageBarEl) {
            const reached = planMaxColumnIdx.get(plan.planId);
            renderStageBar(stageBarEl, reached === undefined ? -1 : reached);
        }
        // AP-IFB-003 — actions slot. The renderer in
        // web/board-plan-cards.ts owns the per-status conditional
        // set; this host mirrors `derivePlanCardActions` by hand so
        // a v2 status that lands here without web/ updating keeps
        // falling through to the {Show agent, Delete} escape hatch.
        const actionsEl = frag.querySelector('[data-plan-actions]') as HTMLElement | null;
        if (actionsEl) {
            actionsEl.replaceChildren();
            for (const action of derivePlanCardActions(plan.status)) {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.setAttribute('data-action', action);
                btn.textContent = PLAN_CARD_ACTION_LABELS[action];
                if (action === 'delete-plan' && !plan.planFile) {
                    btn.disabled = true;
                    btn.title =
                        'Delete is unavailable: plan file slug missing on this projection.';
                }
                btn.addEventListener('click', () => onPlanAction(action, plan));
                actionsEl.appendChild(btn);
            }
        }
        planListEl.appendChild(frag);
    }
}

// ----- plan-card V1 conditional action set (mirrors web/board-plan-cards.ts)
//
// Keep the map below in sync with PLAN_CARD_ACTION_MAP in
// web/board-plan-cards.ts. The typed module is the source of truth and
// has the unit-test coverage; this host mirrors the data so the
// browser bundle does not have to import across the web/ boundary.

type PlanCardAction =
    | 'show-agent'
    | 'review-plan'
    | 'activate'
    | 're-decompose'
    | 'delete-plan';

const PLAN_CARD_ACTION_MAP: Readonly<Record<string, ReadonlyArray<PlanCardAction>>> = {
    planning: ['show-agent'],
    plan_ready: ['show-agent', 'review-plan', 'activate', 're-decompose', 'delete-plan'],
    created: ['show-agent', 'review-plan', 'activate', 're-decompose', 'delete-plan'],
    awaiting_review: ['show-agent', 'review-plan', 'activate', 're-decompose', 'delete-plan'],
    approved: ['show-agent', 'delete-plan'],
    active: ['show-agent', 'delete-plan'],
    in_progress: ['show-agent', 'delete-plan'],
    review: ['show-agent', 'delete-plan'],
    testing: ['show-agent', 'delete-plan'],
    ready_to_commit: ['show-agent', 'delete-plan'],
    ready_to_merge: ['show-agent', 'delete-plan'],
    done: ['delete-plan'],
    archived: ['delete-plan'],
};

const PLAN_CARD_ACTIONS_DEFAULT: ReadonlyArray<PlanCardAction> = [
    'show-agent',
    'delete-plan',
];

const PLAN_CARD_ACTION_LABELS: Readonly<Record<PlanCardAction, string>> = {
    'show-agent': 'Show agent',
    'review-plan': 'Review plan',
    activate: 'Activate',
    're-decompose': 'Re-decompose',
    'delete-plan': 'Delete',
};

function derivePlanCardActions(status: string): ReadonlyArray<PlanCardAction> {
    const raw = (status || '').toLowerCase().replace(/-/g, '_');
    return PLAN_CARD_ACTION_MAP[raw] ?? PLAN_CARD_ACTIONS_DEFAULT;
}

function renderStageBar(container: HTMLElement, reachedIdx: number): void {
    container.replaceChildren();
    for (let i = 0; i < COLUMNS.length; i += 1) {
        const cell = document.createElement('li');
        cell.className = 'stage-cell';
        if (reachedIdx >= 0) {
            if (i < reachedIdx) cell.classList.add('done');
            else if (i === reachedIdx) cell.classList.add('current');
        }
        cell.title = COLUMN_LABELS[COLUMNS[i]] || COLUMNS[i];
        container.appendChild(cell);
    }
}

// ----- pipeline stage-bar (mirrors web/stage-bar.ts) -------------------
//
// REMOVED: `PIPELINE_STAGES` (dev/review/test/commit), `PIPELINE_STAGE_AGENT`
// and `STAGE_ID_TO_STEP_ID`. They encoded ONE flow's shape as "the"
// pipeline, and the task modal iterated them — so a document / deploy /
// investigate / review task opened on four steps it does not have while
// the card behind it showed the real ones. Steps now come from the
// hydrated flow-stage catalog (`stagesForTask`), which is per-flow and
// server-derived. Only the label lookup survives, as a display nicety
// for legacy stage ids.
const PIPELINE_STAGE_LABEL: Record<string, string> = {
    dev: 'Developer',
    review: 'Reviewer',
    test: 'Tester',
    commit: 'Commit',
    investigator: 'Investigator',
};

interface PipelineLog {
    agent?: string;
    event?: string;
}

interface PipelineTask {
    type?: string;
    status?: string;
    human_status?: string;
    failed_stage?: string;
    meta?: { log?: PipelineLog[]; failed_stage?: string };
}

/**
 * Map a task's durable step record + terminal status onto a chip state.
 * Mirrors the colour contract the AP-PAO-008 stylesheet keys off:
 *   running  → active (amber) — or `awaiting` (yellow) when the engine
 *              has parked the task on a clarification question
 *   complete → done   (green)
 *   failed   → failed (red)
 *   missing  → todo   (blue) — unless the whole task is terminal, in
 *              which case an un-run step is treated as done so a merged
 *              task never shows a stray blue chip.
 */
function stageStateForStep(
    rec: TaskStepRecord | undefined,
    terminal: boolean,
    parkedReason: string | null,
): string {
    if (rec) {
        if (rec.status === 'complete') return 'done';
        if (rec.status === 'failed') return 'failed';
        return parkedReason === 'clarification' ? 'awaiting' : 'active';
    }
    return terminal ? 'done' : 'todo';
}

/**
 * Render the flow-accurate stage strip (P-TOTS-006).
 *
 * The chips are driven by the task's OWN flow, not a fixed
 * `Developer › Reviewer › Tester › Commit` bar. `stages` is the ordered
 * `FlowStage[]` that `board.ts` looked up for the task's `flowId` in the
 * flow-stage catalog (hydrated once from `GET /api/flow-stages` by
 * {@link hydrateFlowStages}, resolved per render by {@link stagesForTask}).
 * Only `kind === 'agent'` steps render — operator gates (approval /
 * merge) are dropped from the strip. An empty stage list — an unknown
 * flow, or the catalog not yet hydrated / its fetch having failed —
 * renders NO bar at all (the container is hidden), matching the
 * graceful-degradation contract: a missing catalog costs the strip, never
 * the card. This also folds the old `investigate` special-case into the
 * general path — an investigate flow simply derives to a single
 * `Investigator` agent chip.
 *
 * Per-chip colour still comes from the durable `taskStepRuns` records,
 * keyed by the flow's real `stepId` — which is exactly the key the
 * AgentStarted/Finished metadata and `/api/tasks/:id/step-summaries`
 * store under. `data-stage` therefore carries the real step id, and the
 * body-level chip-click handler opens the per-step summary modal against
 * it directly.
 */
/** Gate state → the stage-bar's chip vocabulary (see stageStateForStep). */
function gateChipState(state: GateStepState): string {
    if (state === 'complete') return 'done';
    if (state === 'waiting') return 'awaiting';
    return 'todo';
}

function renderPipelineStageBar(
    container: HTMLElement,
    task: PipelineTask,
    taskId?: string,
    stages: readonly FlowStage[] = [],
): HTMLElement {
    container.replaceChildren();
    if (task && task.type) container.setAttribute('data-task-type', task.type);
    else container.removeAttribute('data-task-type');
    if (taskId) container.setAttribute('data-task-id', taskId);

    // Gate steps (merge-auto / wait-merged / commit-auto / wait-action)
    // are shown too — the operator asked for the merge to be visible on
    // the board, and hiding it made an auto-merged task look like it
    // stopped at commit. They run no agent, so their state comes from
    // gateStepState rather than a step record.
    const agentStages = stages;
    if (agentStages.length === 0) {
        // Unknown flow / catalog absent → no strip. Hide the slot so the
        // card layout collapses cleanly instead of leaving an empty <ol>.
        container.hidden = true;
        return container;
    }
    container.hidden = false;

    const parkedReason = (task as { parkedReason?: string | null })?.parkedReason ?? null;
    const terminal = Boolean(task)
        && (task.status === 'done' || task.human_status === 'ready_to_merge');

    const allStepIds = stages.map((s) => s.stepId);
    const recordedStepIds = new Set<string>(
        taskId ? [...(taskStepRuns.get(taskId)?.keys() ?? [])] : [],
    );
    for (const stage of agentStages) {
        const stepId = stage.stepId;
        const rec = taskId ? taskStepRuns.get(taskId)?.get(stepId) : undefined;
        const state = stage.kind === 'gate' && !rec
            ? gateChipState(gateStepState({
                agent: stage.agent,
                allStepIds,
                stepId,
                recordedStepIds,
                taskStatus: task?.status ?? null,
                parkedReason,
            }))
            : stageStateForStep(rec, terminal, parkedReason);
        const cell = document.createElement('li');
        cell.className = `stage-cell stage-cell--${state}`;
        cell.setAttribute('data-stage', stepId);
        cell.setAttribute('data-state', state);
        cell.title = `${stage.label} — ${state}`;
        cell.textContent = stage.label;
        // The card-level delegated click listener catches clicks on
        // `[data-stage]` and opens the summary modal. Mark the cell so the
        // cursor reflects its actionability — the modal opens for any chip
        // that has a durable record and noops for the still-todo ones.
        if (rec && taskId) {
            cell.setAttribute('role', 'button');
            cell.setAttribute('tabindex', '0');
            cell.style.cursor = 'pointer';
        }
        container.appendChild(cell);
    }
    return container;
}

function renderTasks(): void {
    if (!taskTemplate) return;
    // Legacy path: when the page exposes Kanban columns
    // (`.column[data-column]`), group tasks per column and write the
    // cards into each column's `[data-tasks]` slot. The section-list
    // layout in the current `index.html` has no such columns, so this
    // branch is a no-op there — the flat fallback below handles it.
    if (columnEls.size > 0) {
        renderTasksKanban();
        return;
    }
    renderTasksFlat();
}

/**
 * Flat tasks view used by the section-list layout. Renders one list
 * item per task into `#all-tasks [data-tasks]`, grouped by planId so
 * tasks from the same decompose stay clustered. The count badge on
 * the section header reflects the total. This is intentionally
 * simpler than the per-column Kanban path — it exists so the
 * decomposer's output is visible at all on the current main-area
 * layout; refining into per-plan cards under the plan-status sections
 * is a follow-up.
 */
// ----- plan sections (Draft / Progress / Completed / Archived) ---------
//
// Plans moved from the sidebar to the main board's section list. Each
// section renders a card per plan in that lifecycle bucket; clicking a
// card opens the plan modal with the plan body + interactive task cards
// rendered via the same `renderTaskCard` the top-level Tasks section
// uses.

type PlanLifecycleSection = 'draft' | 'ready' | 'progress' | 'completed' | 'archived';

/**
 * Per-plan latest PlanGenerated revision. Populated from the
 * `/api/plan-reviews` hydration and the PlanGenerated SSE handler;
 * cleared by PlanDecomposed. `classifyPlan` consults this to route
 * plans with a planner-produced draft (but no tasks yet) into the
 * "Ready" section between Draft and Progress.
 */
const planLatestRevision = new Map<string, number>();

/**
 * Per-plan planner output (markdown body of the latest PlanGenerated
 * revision). The plan modal renders this in place of the operator's
 * original brief once the planner has produced an implementation plan
 * — without it the modal would keep showing the original description.
 * Cleared by PlanDecomposed so a re-decompose cycle starts clean.
 */
const planReviewContent = new Map<string, string>();

interface PlanLifecycleCounts {
    readonly total: number;
    readonly done: number;
    readonly inProgress: number;
    readonly todo: number;
    readonly skipped: number;
}

const TASK_IN_PROGRESS_STATES = new Set<string>([
    'in_progress', 'review', 'test', 'commit', 'merge',
]);

function countPlanTasks(planId: string): PlanLifecycleCounts {
    let total = 0;
    let done = 0;
    let inProgress = 0;
    let skipped = 0;
    let todo = 0;
    for (const t of tasks.values()) {
        if (t.planId !== planId) continue;
        total += 1;
        if (t.status === 'done') done += 1;
        else if (t.status === 'skipped') skipped += 1;
        else if (TASK_IN_PROGRESS_STATES.has(t.status)) inProgress += 1;
        else if (t.parkedReason) inProgress += 1;
        else todo += 1;
    }
    return { total, done, inProgress, todo, skipped };
}

function classifyPlan(plan: PlanRow): PlanLifecycleSection | null {
    if (plan.archivedAt !== null) return 'archived';
    // While the planner is actively running, the plan belongs to the
    // Active planners section only — suppress it from all lifecycle
    // buckets so the operator does not see two cards for the same
    // plan during a Run planner / Regenerate cycle. The next
    // status flip (to 'complete' / 'failed') will route it back into
    // Ready (revision landed) or Draft (no revision).
    const plannerRow = activePlanners.get(plan.planId);
    if (plannerRow !== undefined && plannerRow.status === 'running') {
        return null;
    }
    const counts = countPlanTasks(plan.planId);
    if (counts.total === 0) {
        // No tasks yet. If the planner has produced a draft revision
        // (PlanGenerated landed), the plan is "Ready" — the operator
        // can decompose, regenerate, or feed back. Otherwise the brief
        // hasn't been planned, so it's still a Draft.
        return planLatestRevision.has(plan.planId) ? 'ready' : 'draft';
    }
    const terminal = counts.done + counts.skipped;
    if (terminal === counts.total) {
        // All tasks terminal: at least one done → completed; otherwise
        // every task was skipped (effectively cancelled). When the
        // planner has a fresh draft for the cancelled plan, surface it
        // under Ready; otherwise it returns to Draft.
        if (counts.done > 0) return 'completed';
        return planLatestRevision.has(plan.planId) ? 'ready' : 'draft';
    }
    return 'progress';
}

function planAbbr(plan: PlanRow): string | null {
    const md = plan.metadata as { abbr?: unknown };
    if (typeof md.abbr === 'string' && md.abbr.length > 0) return md.abbr;
    return null;
}

function planType(plan: PlanRow): string | null {
    const md = plan.metadata as { planType?: unknown };
    if (typeof md.planType === 'string' && md.planType.length > 0) {
        return md.planType;
    }
    return null;
}

function projectNameFor(projectId: string): string {
    if (!projectId) return '';
    const fromCrud = crudState.projects.find((p) => p.id === projectId);
    if (fromCrud?.name) return fromCrud.name;
    return projectId;
}

/**
 * Repo options for the new/edit-plan modal's "Target repo" dropdown,
 * scoped to the PROJECT: when the project declares repos (the `repos`
 * list in its metadata blob), only those are offered — workspace-registry
 * entries are preferred for their display name/url, and declared repos
 * missing from the registry still show so a selection is never silently
 * narrowed. A project with NO declared repos falls back to the full
 * workspace registry (legacy behaviour for unconfigured projects).
 */
function repoOptionsForProject(
    project: ProjectRow | null,
): ProjectRowRepo[] {
    // Annotated rather than inferred: the registry's `name` is always a
    // string, so an inferred element type is narrower than a declared
    // repo's (`name?`), and pushing one into the other below does not
    // typecheck. The declared shape is the one this returns.
    const workspaceRepos: ProjectRowRepo[] = Array.from(repos.values())
        .filter((r) => r.archivedAt === null)
        .map((r) => ({ id: r.repoId, name: r.name, url: r.url }));
    const declared = project?.repos ?? [];
    if (declared.length > 0) {
        const ids = new Set(declared.map((r) => r.id));
        const scoped = workspaceRepos.filter((r) => ids.has(r.id));
        const inRegistry = new Set(scoped.map((r) => r.id));
        for (const r of declared) {
            if (!inRegistry.has(r.id)) scoped.push(r);
        }
        return scoped;
    }
    return workspaceRepos.length > 0 ? workspaceRepos : declared.slice();
}

function openEditPlanModal(plan: PlanRow): void {
    const project = crudState.projects.find((p) => p.id === plan.projectId) ?? null;
    ensureOverlayRoot();
    const repoList = repoOptionsForProject(project);
    newPlanModal.open(plan.projectId, {
        projectName: project?.name,
        ...(project?.abbr !== undefined ? { projectAbbr: project.abbr } : {}),
        ...(repoList.length > 0 ? { projectRepos: repoList } : {}),
        existing: {
            planId: plan.planId,
            ...(plan.planFile !== null ? { planFile: plan.planFile } : {}),
        },
    });
}

async function runDecomposeForPlan(
    plan: PlanRow,
    button: HTMLButtonElement,
): Promise<void> {
    if (!plan.projectId || !plan.planId) {
        showToast({ message: 'Plan is missing projectId or planId.', kind: 'error' });
        return;
    }
    button.disabled = true;
    const previousLabel = button.textContent;
    button.textContent = 'Decomposing…';
    try {
        const url = `${API_BASE}/api/projects/${encodeURIComponent(plan.projectId)}/plans/${encodeURIComponent(plan.planId)}/plan-review/approve`;
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        });
        if (!res.ok) {
            throw new Error(`HTTP ${res.status}`);
        }
        showToast({ message: 'Decomposer dispatched.', kind: 'info' });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        showToast({ message: `Decompose failed: ${msg}`, kind: 'error' });
        button.disabled = false;
        button.textContent = previousLabel;
    }
}

async function runPlannerForPlan(
    plan: PlanRow,
    button: HTMLButtonElement,
): Promise<void> {
    if (!plan.projectId || !plan.planId) {
        showToast({ message: 'Plan is missing projectId or planId.', kind: 'error' });
        return;
    }
    button.disabled = true;
    const previousLabel = button.textContent;
    button.textContent = 'Planning…';
    try {
        const nextRevision = (planLatestRevision.get(plan.planId) ?? 0) + 1;
        const url = `${API_BASE}/api/projects/${encodeURIComponent(plan.projectId)}/plans/${encodeURIComponent(plan.planId)}/generate-plan`;
        const body: Record<string, unknown> = { revision: nextRevision };
        if (plan.body) body.briefContent = plan.body;
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            throw new Error(`HTTP ${res.status}`);
        }
        showToast({ message: 'Planner dispatched.', kind: 'info' });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        showToast({ message: `Run planner failed: ${msg}`, kind: 'error' });
        button.disabled = false;
        button.textContent = previousLabel;
    }
}

async function runRegenerateForPlan(
    plan: PlanRow,
    feedback: string,
    button: HTMLButtonElement,
): Promise<boolean> {
    if (!plan.projectId || !plan.planId) {
        showToast({ message: 'Plan is missing projectId or planId.', kind: 'error' });
        return false;
    }
    button.disabled = true;
    const previousLabel = button.textContent;
    button.textContent = 'Regenerating…';
    try {
        const url = `${API_BASE}/api/projects/${encodeURIComponent(plan.projectId)}/plans/${encodeURIComponent(plan.planId)}/plan-review/regenerate`;
        const trimmed = feedback.trim();
        const body: Record<string, unknown> = {};
        if (trimmed.length > 0) body.feedback = trimmed;
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            throw new Error(`HTTP ${res.status}`);
        }
        showToast({ message: 'Planner regenerate dispatched.', kind: 'info' });
        return true;
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        showToast({ message: `Regenerate failed: ${msg}`, kind: 'error' });
        button.disabled = false;
        button.textContent = previousLabel;
        return false;
    }
}

function renderPlanCardForSection(
    plan: PlanRow,
    section: PlanLifecycleSection,
): HTMLElement {
    const card = document.createElement('article');
    card.className = `board-plan-card board-plan-card--${section}`;
    card.setAttribute('data-board-plan-card', plan.planId);
    card.setAttribute('role', 'button');
    card.setAttribute('tabindex', '0');

    const header = document.createElement('header');
    header.className = 'board-plan-card__header';

    const title = document.createElement('h4');
    title.className = 'board-plan-card__title';
    title.textContent = plan.title ?? plan.planId;
    header.appendChild(title);

    // Attention badge, right behind the plan name. With a dozen plans
    // running, `3 done - 2 in-progress - 1 todo` says nothing about
    // whether anything is STUCK: a task at an approval gate, one asking a
    // question and one that failed all read as 'in-progress', so the
    // operator had to open plans one by one to find the one that had been
    // waiting on them. See plan-attention.ts for what counts.
    const attention = planAttention(plan.planId, tasks.values());
    if (attention.needsAttention) {
        const badge = document.createElement('span');
        badge.className = 'board-plan-card__attention'
            + ` board-plan-card__attention--${attention.severity}`;
        badge.setAttribute('data-plan-attention', attention.severity);
        badge.textContent = '!';
        // Title AND aria-label: the glyph alone says 'something', and the
        // operator wants to know WHICH plan to open without opening any.
        badge.title = attention.summary;
        badge.setAttribute('aria-label', attention.summary);
        badge.setAttribute('role', 'img');
        header.appendChild(badge);
    }

    const abbr = planAbbr(plan);
    if (abbr) {
        const pill = document.createElement('span');
        pill.className = 'board-plan-card__abbr';
        pill.textContent = abbr;
        header.appendChild(pill);
    }
    card.appendChild(header);

    const meta = document.createElement('div');
    meta.className = 'board-plan-card__meta';
    const pieces: string[] = [];
    const projName = projectNameFor(plan.projectId);
    if (projName) pieces.push(projName);
    const type = planType(plan);
    if (type) pieces.push(type);
    meta.textContent = pieces.join(' · ');
    card.appendChild(meta);

    const counts = countPlanTasks(plan.planId);
    if (counts.total > 0) {
        const countsRow = document.createElement('div');
        countsRow.className = 'board-plan-card__counts';
        countsRow.textContent = `${counts.done} done · ${counts.inProgress} in-progress · ${counts.todo} todo`
            + (counts.skipped > 0 ? ` · ${counts.skipped} skipped` : '');
        card.appendChild(countsRow);
    }

    // Durable planner-failure line (metadata.plannerError, written by the
    // orchestrator on PlanGenerateFailed, cleared by the next successful
    // run). Rendered on the DRAFT card so a failed run explains itself
    // even after a board reload — previously the error only lived on the
    // in-session Active planners card.
    const plannerError = (plan.metadata as { plannerError?: unknown }).plannerError;
    if (section === 'draft' && typeof plannerError === 'string' && plannerError.length > 0) {
        const errRow = document.createElement('div');
        errRow.className = 'board-plan-card__planner-error';
        errRow.textContent = `Planner failed: ${plannerError}`;
        card.appendChild(errRow);
    }

    if (section === 'completed') {
        const actions = document.createElement('div');
        actions.className = 'board-plan-card__actions';
        const archiveBtn = document.createElement('button');
        archiveBtn.type = 'button';
        archiveBtn.className = 'board-plan-card__archive';
        archiveBtn.textContent = 'Archive';
        archiveBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            void sendCommand({
                type: 'ArchivePlan',
                actor: 'operator',
                issuedAt: Date.now(),
                payload: { planId: plan.planId },
            });
        });
        actions.appendChild(archiveBtn);
        card.appendChild(actions);
    }

    if (section === 'draft') {
        // Draft plans (no tasks yet, or every task skipped so the plan
        // returned to draft) get Edit + Run planner + Dismiss. Edit
        // re-opens the new-plan modal in edit mode, pre-fills from the
        // projection, and writes back through the plan-update path.
        // Run planner fires the GeneratePlan REST route — the
        // orchestrator's planner agent reads the latest plan body and
        // emits PlanGenerated, flipping the card into Ready. Dismiss
        // archives the plan (same mechanism as the Completed plan's
        // Archive button) — non-destructive, row stays in the DB, plan
        // surfaces under Archived where it can be re-opened later.
        const actions = document.createElement('div');
        actions.className = 'board-plan-card__actions';

        const editBtn = document.createElement('button');
        editBtn.type = 'button';
        editBtn.className = 'board-plan-card__edit';
        editBtn.textContent = 'Edit';
        editBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            openEditPlanModal(plan);
        });
        actions.appendChild(editBtn);

        const dismissBtn = document.createElement('button');
        dismissBtn.type = 'button';
        dismissBtn.className = 'board-plan-card__dismiss';
        dismissBtn.textContent = 'Dismiss';
        dismissBtn.title = 'Archive this draft plan (recoverable from Archived)';
        dismissBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            void sendCommand({
                type: 'ArchivePlan',
                actor: 'operator',
                issuedAt: Date.now(),
                payload: { planId: plan.planId },
            });
        });
        actions.appendChild(dismissBtn);

        const runPlannerBtn = document.createElement('button');
        runPlannerBtn.type = 'button';
        runPlannerBtn.className = 'board-plan-card__run-planner';
        runPlannerBtn.textContent = 'Run planner';
        runPlannerBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            void runPlannerForPlan(plan, runPlannerBtn);
        });
        actions.appendChild(runPlannerBtn);

        card.appendChild(actions);
    }

    if (section === 'ready') {
        // Ready plans have a planner-produced draft revision but no
        // tasks yet. The card surfaces the primary action (Decompose)
        // plus Dismiss for the "I don't want this draft after all"
        // case. Feedback + Regenerate live inside the plan modal —
        // clicking the card opens the modal where the operator can
        // iterate on the draft before decomposing.
        const actions = document.createElement('div');
        actions.className = 'board-plan-card__actions';

        const dismissBtn = document.createElement('button');
        dismissBtn.type = 'button';
        dismissBtn.className = 'board-plan-card__dismiss';
        dismissBtn.textContent = 'Dismiss';
        dismissBtn.title = 'Archive this plan (recoverable from Archived)';
        dismissBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            void sendCommand({
                type: 'ArchivePlan',
                actor: 'operator',
                issuedAt: Date.now(),
                payload: { planId: plan.planId },
            });
        });
        actions.appendChild(dismissBtn);

        const decomposeBtn = document.createElement('button');
        decomposeBtn.type = 'button';
        decomposeBtn.className = 'board-plan-card__decompose';
        decomposeBtn.textContent = 'Decompose';
        decomposeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            void runDecomposeForPlan(plan, decomposeBtn);
        });
        actions.appendChild(decomposeBtn);
        card.appendChild(actions);
    }

    if (section === 'progress') {
        // In-progress plans whose every task has been dismissed/skipped
        // (or otherwise stalled out without flipping any to done) have no
        // path back to draft / ready / completed under classifyPlan, so
        // the only way off the board is an explicit Archive. The handler
        // is ungated — same command the Completed/Draft/Ready Archive
        // buttons dispatch — so a confirm() before firing avoids an
        // accidental click on a still-active plan.
        const actions = document.createElement('div');
        actions.className = 'board-plan-card__actions';

        const archiveBtn = document.createElement('button');
        archiveBtn.type = 'button';
        archiveBtn.className = 'board-plan-card__archive';
        archiveBtn.textContent = 'Archive';
        archiveBtn.title = 'Archive this plan (recoverable from Archived)';
        archiveBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const title = plan.title ?? plan.planId;
            const confirmed = window.confirm(
                `Archive plan "${title}"? In-progress tasks will stay in the database but the plan will move to the Archived section.`,
            );
            if (!confirmed) return;
            void sendCommand({
                type: 'ArchivePlan',
                actor: 'operator',
                issuedAt: Date.now(),
                payload: { planId: plan.planId },
            });
        });
        actions.appendChild(archiveBtn);
        card.appendChild(actions);
    }

    if (section === 'archived') {
        const actions = document.createElement('div');
        actions.className = 'board-plan-card__actions';
        const unarchiveBtn = document.createElement('button');
        unarchiveBtn.type = 'button';
        unarchiveBtn.className = 'board-plan-card__unarchive';
        unarchiveBtn.textContent = 'Unarchive';
        unarchiveBtn.title = 'Restore this plan to the active board sections';
        unarchiveBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            void sendCommand({
                type: 'UnarchivePlan',
                actor: 'operator',
                issuedAt: Date.now(),
                payload: { planId: plan.planId },
            });
        });
        actions.appendChild(unarchiveBtn);
        card.appendChild(actions);
    }

    card.addEventListener('click', () => openPlanModal(plan.planId));
    card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            openPlanModal(plan.planId);
        }
    });

    return card;
}

function renderPlanSections(): void {
    const buckets: Record<PlanLifecycleSection, PlanRow[]> = {
        draft: [],
        ready: [],
        progress: [],
        completed: [],
        archived: [],
    };
    for (const plan of plans.values()) {
        if (!isVisibleForCurrentProject(plan.projectId)) continue;
        const section = classifyPlan(plan);
        if (section === null) continue;
        buckets[section].push(plan);
    }
    const sectionIds: Record<PlanLifecycleSection, string> = {
        draft: 'draft-plans',
        ready: 'ready-plans',
        progress: 'progress-plans',
        completed: 'completed-plans',
        archived: 'archived-plans',
    };
    for (const section of ['draft', 'ready', 'progress', 'completed', 'archived'] as const) {
        const sectionEl = document.querySelector(
            `#${sectionIds[section]} [data-section-body]`,
        ) as HTMLElement | null;
        const countBadge = document.querySelector(
            `#${sectionIds[section]} [data-count-badge]`,
        ) as HTMLElement | null;
        if (!sectionEl) continue;
        let list = buckets[section]
            .slice()
            .sort((a, b) => (a.title ?? '').localeCompare(b.title ?? ''));
        let hiddenOlder = 0;
        let searchedEmpty = false;
        if (section === 'archived') {
            // Newest-archived first: that's how an archive is browsed.
            list = list.sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0));
            if (isSearching(archivedPlanQuery)) {
                // Searching deliberately IGNORES the recency window. The
                // whole reason to search an archive is to find something
                // old; applying a 7-day cutoff to the results would
                // answer "no such plan" for exactly the plans worth
                // searching for. `list` is already project-scoped by
                // isVisibleForCurrentProject above.
                const before = list.length;
                list = filterPlansByQuery(list, archivedPlanQuery);
                searchedEmpty = list.length === 0 && before > 0;
            } else {
                // The archive grows forever — show a recency window (7
                // days, extended by 7 per "Show older" click) rather
                // than everything.
                const cutoff = Date.now() - archivedPlansWindowDays * 24 * 60 * 60 * 1000;
                const windowed = list.filter((p) => (p.archivedAt ?? 0) >= cutoff);
                hiddenOlder = list.length - windowed.length;
                list = windowed;
            }
        }
        if (countBadge) {
            countBadge.textContent = list.length === 0 ? '' : String(list.length);
        }
        sectionEl.replaceChildren();
        for (const p of list) {
            sectionEl.appendChild(renderPlanCardForSection(p, section));
        }
        if (section === 'archived' && hiddenOlder > 0) {
            const older = document.createElement('button');
            older.type = 'button';
            older.className = 'archived-show-older';
            older.textContent = `Show older (${hiddenOlder} more beyond ${archivedPlansWindowDays} days)`;
            older.addEventListener('click', () => {
                archivedPlansWindowDays += 7;
                scheduleRender();
            });
            sectionEl.appendChild(older);
        }
        if (searchedEmpty) {
            // Say it. An empty body under a search box reads as the
            // search being broken rather than as no matches, and the
            // operator's next move is to retype the same query.
            const none = document.createElement('p');
            none.className = 'archived-search-empty';
            none.textContent = `No archived plans match "${archivedPlanQuery.trim()}"`
                + (crudState.selectedProjectId
                    ? ` in ${projectNameFor(crudState.selectedProjectId) || 'this project'}.`
                    : ' in any project.');
            sectionEl.appendChild(none);
        }
        // The archived section stays visible while older plans exist even
        // if the current window is empty — the button must be reachable.
        // While searching it stays visible regardless, so a no-match
        // result can be SEEN rather than collapsing the section away.
        const hasContent = list.length > 0
            || (section === 'archived'
                && (hiddenOlder > 0 || isSearching(archivedPlanQuery)));
        toggleSectionVisible(sectionIds[section], hasContent);
    }
}

/**
 * Plans whose collapsed "Original request" the operator has opened.
 *
 * The plan modal rebuilds its whole body on every SSE tick, and a
 * fresh `<details>` defaults to closed — so without this, opening a
 * long request would snap shut the moment any task in the plan
 * ticked. Session-scoped; a reload starts collapsed again.
 */
const planRequestOpen = new Set<string>();

/**
 * Recency window for the Archived plans section, in days. Starts at one
 * week; every "Show older" click extends it by another week. Session-
 * scoped on purpose — a reload snaps back to the tidy default.
 */
let archivedPlansWindowDays = 7;

/**
 * The archived-plans search box's current text. Session-scoped and NOT
 * persisted: a stored query would silently hide most of the archive on
 * the next load, with the only clue a few characters in a collapsed
 * section's header.
 */
let archivedPlanQuery = '';

// --- Requirements lane (Architect Tier, Phase 2) --------------------

function renderRequirements(): void {
    const body = document.querySelector(
        '#requirements-lane [data-section-body]',
    ) as HTMLElement | null;
    const badge = document.querySelector(
        '#requirements-lane [data-count-badge]',
    ) as HTMLElement | null;
    if (!body) return;
    const rows = Array.from(requirements.values())
        .filter((r) => !r.archived)
        // Same project scoping as tasks/plans: a selected project narrows
        // the lane; requirements without a project (legacy) show only in
        // the All-projects view.
        .filter((r) => isVisibleForCurrentProject(r.projectId))
        .sort((a, b) => a.requirementId.localeCompare(b.requirementId));
    if (badge) badge.textContent = rows.length === 0 ? '' : String(rows.length);
    body.replaceChildren();
    for (const r of rows) body.appendChild(renderRequirementCard(r));
    // Always keep the section visible — its header carries the
    // "+ New requirement" button even when the lane is empty.
    toggleSectionVisible('requirements-lane', true);
}

/**
 * Recency window for the Archived requirements section, in days.
 * Mirrors the Archived-plans behaviour: one week, extended by a week
 * per "Show older" click, session-scoped.
 */
let archivedRequirementsWindowDays = 7;

function renderArchivedRequirements(): void {
    const body = document.querySelector(
        '#archived-requirements [data-section-body]',
    ) as HTMLElement | null;
    const badge = document.querySelector(
        '#archived-requirements [data-count-badge]',
    ) as HTMLElement | null;
    if (!body) return;
    // Newest-archived first — that's how an archive is browsed.
    const all = Array.from(requirements.values())
        .filter((r) => r.archived)
        .filter((r) => isVisibleForCurrentProject(r.projectId))
        .sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0));
    const cutoff = Date.now() - archivedRequirementsWindowDays * 24 * 60 * 60 * 1000;
    const windowed = all.filter((r) => (r.archivedAt ?? 0) >= cutoff);
    const hiddenOlder = all.length - windowed.length;
    if (badge) badge.textContent = windowed.length === 0 ? '' : String(windowed.length);
    body.replaceChildren();
    for (const r of windowed) body.appendChild(renderRequirementCard(r));
    if (hiddenOlder > 0) {
        const older = document.createElement('button');
        older.type = 'button';
        older.className = 'archived-show-older';
        older.textContent =
            `Show older (${hiddenOlder} more beyond ${archivedRequirementsWindowDays} days)`;
        older.addEventListener('click', () => {
            archivedRequirementsWindowDays += 7;
            scheduleRender();
        });
        body.appendChild(older);
    }
    // Visible while anything is in the window OR older items exist (the
    // "Show older" button must stay reachable); hidden entirely when
    // there are no archived requirements at all.
    toggleSectionVisible('archived-requirements', windowed.length > 0 || hiddenOlder > 0);
}

function renderRequirementCard(r: RequirementRow): HTMLElement {
    const card = document.createElement('article');
    card.className = `board-plan-card requirement-card requirement-card--${r.status}`;
    card.setAttribute('data-requirement-card', r.requirementId);
    card.setAttribute('role', 'button');
    card.setAttribute('tabindex', '0');
    const header = document.createElement('header');
    header.className = 'board-plan-card__header';
    const title = document.createElement('h4');
    title.className = 'board-plan-card__title';
    title.textContent = r.title || r.requirementId;
    header.appendChild(title);
    const status = document.createElement('span');
    status.className = `requirement-card__status requirement-card__status--${r.status}`;
    status.textContent = r.status;
    header.appendChild(status);
    // Show agent — visible while the architect is designing (status
    // 'architecting', which survives a reload via /api/requirements) or once
    // we've captured a stream row. Mirrors the planner/decomposer cards.
    if (r.status === 'architecting' || activeArchitects.has(r.requirementId)) {
        const showBtn = document.createElement('button');
        showBtn.type = 'button';
        showBtn.className = 'requirement-card__show-agent';
        showBtn.textContent = 'Show agent';
        showBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            openShowArchitectAgentModal(r.requirementId);
        });
        header.appendChild(showBtn);
    }
    card.appendChild(header);

    // Fan-out verification gate. 'verifying' shows progress; 'failed'
    // shows the findings + the three decisions (plus Retry when the
    // verifier itself errored). Plans do not exist until one of the
    // authorize paths fires.
    if (r.verificationStatus === 'verifying') {
        const line = document.createElement('div');
        line.className = 'requirement-card__verify requirement-card__verify--running';
        line.textContent = '🔎 Verifying fan-out against the design…';
        card.appendChild(line);
    } else if (r.verificationStatus === 'failed') {
        const box = document.createElement('div');
        box.className = 'requirement-card__verify requirement-card__verify--failed';
        const head = document.createElement('div');
        head.className = 'requirement-card__verify-head';
        head.textContent = r.verificationError
            ? `⚠ Design verification error: ${r.verificationError}`
            : `⚠ Design verification failed — ${r.verificationFindings.length} finding${r.verificationFindings.length === 1 ? '' : 's'}`;
        box.appendChild(head);
        if (r.verificationFindings.length > 0) {
            const list = document.createElement('ul');
            list.className = 'requirement-card__verify-findings';
            for (const f of r.verificationFindings.slice(0, 6)) {
                const li = document.createElement('li');
                li.textContent = `${f.severity === 'blocker' ? '⛔' : '⚠'} `
                    + (f.systemId ? `[${f.systemId}] ` : '[cross-plan] ')
                    + f.finding;
                list.appendChild(li);
            }
            if (r.verificationFindings.length > 6) {
                const li = document.createElement('li');
                li.textContent = `… and ${r.verificationFindings.length - 6} more (open the design)`;
                list.appendChild(li);
            }
            box.appendChild(list);
        }
        const actions = document.createElement('div');
        actions.className = 'requirement-card__verify-actions';
        const btn = (
            label: string,
            handler: () => void,
            cls = '',
        ): HTMLButtonElement => {
            const b = document.createElement('button');
            b.type = 'button';
            b.textContent = label;
            if (cls) b.className = cls;
            b.addEventListener('click', (e) => {
                e.stopPropagation();
                handler();
            });
            actions.appendChild(b);
            return b;
        };
        // Optimistic fold: flip the local row the moment a decision button
        // is clicked so the findings block disappears (or switches state)
        // immediately — the confirming SSE event lands moments later, but
        // without this the unchanged card made it look like the click did
        // nothing.
        const optimistic = (patch: Partial<RequirementRow>): void => {
            Object.assign(r, patch);
            scheduleRender();
        };
        btn('Implement anyway', () => {
            void sendCommand({
                type: 'ProceedFanOut',
                actor: 'operator',
                issuedAt: Date.now(),
                payload: { requirementId: r.requirementId, revision: r.revision },
            });
            optimistic({ verificationStatus: 'overridden' });
        });
        btn('Re-run architect with findings', () => {
            const feedback = 'Design verification found these problems with the fan-out '
                + 'proposal — address every one:\n'
                + r.verificationFindings
                    .map((f) => `- ${f.systemId ? `[${f.systemId}] ` : '[cross-plan] '}${f.finding}`)
                    .join('\n');
            void sendCommand({
                type: 'RegenerateArchitecture',
                actor: 'operator',
                issuedAt: Date.now(),
                payload: {
                    requirementId: r.requirementId,
                    revision: r.revision + 1,
                    feedback,
                },
            });
            optimistic({
                status: 'architecting',
                verificationStatus: null,
                verificationFindings: [],
                verificationError: null,
            });
        });
        if (r.verificationError) {
            btn('Retry verification', () => {
                void sendCommand({
                    type: 'RetryVerification',
                    actor: 'operator',
                    issuedAt: Date.now(),
                    payload: { requirementId: r.requirementId, revision: r.revision },
                });
                optimistic({
                    verificationStatus: 'verifying',
                    verificationFindings: [],
                    verificationError: null,
                });
            });
        }
        btn('Cancel', () => {
            if (!window.confirm('Cancel this implementation? The architectural design will be archived.')) return;
            void sendCommand({
                type: 'ArchiveRequirement',
                actor: 'operator',
                issuedAt: Date.now(),
                payload: { requirementId: r.requirementId },
            });
            optimistic({ archived: true, archivedAt: Date.now() });
        }, 'requirement-card__verify-cancel');
        box.appendChild(actions);
        card.appendChild(box);
    } else if (r.verificationStatus === 'overridden') {
        const line = document.createElement('div');
        line.className = 'requirement-card__verify requirement-card__verify--overridden';
        line.textContent = '⚠ Fan-out forced past a failed verification (implement anyway)';
        card.appendChild(line);
    }

    card.addEventListener('click', () => void openRequirementModal(r.requirementId));
    return card;
}

const REQUIREMENT_MODAL_OVERLAY_ID = 'requirement-modal';
let requirementModalBackdrop: HTMLElement | null = null;

let requirementChatHandle: ScopedChatHandle | null = null;
let requirementModalRequirementId: string | null = null;
let requirementModalBodyEl: HTMLElement | null = null;

function buildRequirementOverlay(
    titleText: string,
    bodyNodes: Node[],
    chatScope?: { requirementId: string; projectId: string },
): void {
    // Tear down ANY previous requirement modal first — variable AND DOM.
    // Previously only the overlay-manager id was reset, so a double-open
    // stacked two identical modals: Close removed the tracked (top) one,
    // the visible older one's Close then no-oped (tracked backdrop
    // already null), and its chat toggle orphaned panes ("empty space
    // where chat was"). Mirrors openPlanModal's belt-and-braces close.
    closeRequirementModal();
    const root = ensureOverlayRoot();
    root.querySelectorAll('[data-requirement-modal-overlay]').forEach((el) => el.remove());
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-chrome__overlay';
    backdrop.setAttribute('data-requirement-modal-overlay', '');
    backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) closeRequirementModal();
    });
    const panel = document.createElement('div');
    panel.className = 'plan-modal modal-chrome';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    const header = document.createElement('div');
    header.className = 'modal-chrome__header';
    const h = document.createElement('h3');
    h.className = 'modal-chrome__title';
    h.textContent = titleText;
    header.appendChild(h);
    const content = document.createElement('div');
    content.className = 'plan-modal__content';
    if (chatScope) {
        const chatBtn = document.createElement('button');
        chatBtn.className = 'plan-modal__chat-toggle';
        chatBtn.type = 'button';
        chatBtn.textContent = '💬 Chat';
        chatBtn.addEventListener('click', () => {
            if (requirementChatHandle !== null) {
                requirementChatHandle.destroy();
                requirementChatHandle = null;
                panel.classList.remove('plan-modal--split');
                content.querySelector('.plan-modal__chat-pane')?.remove();
                return;
            }
            const pane = document.createElement('div');
            pane.className = 'plan-modal__chat-pane';
            content.appendChild(pane);
            panel.classList.add('plan-modal--split');
            requirementChatHandle = mountScopedChatPane(pane, {
                apiBase: API_BASE,
                scopeKind: 'requirement',
                scopeId: chatScope.requirementId,
                projectId: chatScope.projectId,
                repoId: null,
                title: `Design chat — ${titleText}`,
                sendCommand: (command) => sendCommandOrThrow(command as BoardCommand),
                createPlan: scopedChatCreatePlan(chatScope.projectId, null),
                onError: (message) => showToast({ message, kind: 'error' }),
            });
        });
        header.appendChild(chatBtn);
    }
    const closeBtn = document.createElement('button');
    closeBtn.className = 'modal-chrome__close';
    closeBtn.type = 'button';
    closeBtn.textContent = 'Close';
    closeBtn.addEventListener('click', closeRequirementModal);
    header.appendChild(closeBtn);
    panel.appendChild(header);
    const body = document.createElement('div');
    body.className = 'modal-chrome__body plan-modal__body';
    body.replaceChildren(...bodyNodes);
    content.appendChild(body);
    panel.appendChild(content);
    requirementModalBodyEl = body;
    backdrop.appendChild(panel);
    root.appendChild(backdrop);
    requirementModalBackdrop = backdrop;
    overlayManager.openOverlay(REQUIREMENT_MODAL_OVERLAY_ID, panel);
}

function closeRequirementModal(): void {
    if (requirementChatHandle !== null) {
        requirementChatHandle.destroy();
        requirementChatHandle = null;
    }
    requirementModalRequirementId = null;
    requirementModalBodyEl = null;
    if (currentAttachTarget?.ownerType === 'requirement') {
        currentAttachTarget = null;
    }
    // A new-design form closed WITHOUT submitting. Its uploads belong
    // to a requirement that will never exist, so nothing would ever
    // list them and nothing would ever delete them. Best-effort.
    if (draftRequirementId !== null) {
        const draftId = draftRequirementId;
        draftRequirementId = null;
        for (const meta of getAttachments('requirement', draftId)) {
            void deleteAttachmentById('requirement', draftId, meta.id);
        }
    }
    overlayManager.closeOverlay(REQUIREMENT_MODAL_OVERLAY_ID);
    requirementModalBackdrop?.remove();
    requirementModalBackdrop = null;
    // Sweep stray instances from any historical double-open — the DOM,
    // not the tracking variable, is the source of truth for what the
    // operator can see.
    document
        .querySelectorAll('[data-requirement-modal-overlay]')
        .forEach((el) => el.remove());
}

/**
 * Requirement id of an UNSUBMITTED new-design form, or null.
 *
 * The id is minted when the form opens rather than on submit, so the
 * operator can attach the spec BEFORE the architect runs — and it has
 * to run before it, because `SubmitRequirement` spawns the architect
 * immediately. Attaching afterwards only reaches a Regenerate.
 *
 * Kept here so a form the operator abandons can take its uploads with
 * it: rows pointing at a requirement that was never submitted are
 * invisible to every surface and would never be cleaned up.
 */
let draftRequirementId: string | null = null;

function openNewRequirementModal(): void {
    const wrap = document.createElement('div');
    wrap.className = 'requirement-form';
    // Client-minted, and minted HERE. The server is idempotent on the
    // command key, and submitNewRequirement reuses this exact id.
    // `draftRequirementId` is set AFTER the overlay is built — see below.
    const requirementId = `REQ-${Date.now()}`;
    const titleLabel = document.createElement('label');
    titleLabel.textContent = 'Title';
    const titleInput = document.createElement('input');
    titleInput.type = 'text';
    titleInput.className = 'requirement-form__title';
    titleInput.placeholder = 'e.g. Expose customer X in System B';
    titleLabel.appendChild(titleInput);
    // Project — every fanned-out sub-plan lands under this board project
    // (the architect's systems only pick each plan's target repo).
    const projectLabel = document.createElement('label');
    projectLabel.textContent = 'Project';
    const projectSelect = document.createElement('select');
    projectSelect.className = 'requirement-form__project';
    for (const proj of crudState.projects) {
        const opt = document.createElement('option');
        opt.value = proj.id;
        opt.textContent = proj.name || proj.id;
        projectSelect.appendChild(opt);
    }
    if (crudState.selectedProjectId
        && crudState.projects.some((proj) => proj.id === crudState.selectedProjectId)) {
        projectSelect.value = crudState.selectedProjectId;
    }
    projectLabel.appendChild(projectSelect);
    const descLabel = document.createElement('label');
    descLabel.textContent = 'Business requirement';
    const descInput = document.createElement('textarea');
    descInput.className = 'requirement-form__desc';
    descInput.rows = 8;
    descInput.placeholder =
        'Describe the cross-system need in business terms. The architect will '
        + 'design the integration, define the shared contracts, and propose one '
        + 'independent plan per affected system.';
    descLabel.appendChild(descInput);
    const actions = document.createElement('div');
    actions.className = 'requirement-form__actions';
    const submit = document.createElement('button');
    submit.type = 'button';
    submit.className = 'requirement-form__submit';
    submit.textContent = 'Submit — run architect';
    submit.addEventListener('click', () => {
        const title = titleInput.value.trim();
        const description = descInput.value.trim();
        if (title.length === 0 || description.length === 0) {
            titleInput.reportValidity?.();
            return;
        }
        // Submitted: the uploads belong to a real requirement now, so
        // the close below must not sweep them.
        draftRequirementId = null;
        submitNewRequirement(
            requirementId,
            title,
            description,
            projectSelect.value || undefined,
        );
        closeRequirementModal();
    });
    actions.appendChild(submit);
    // Design INPUT, attachable before the architect ever runs: an API
    // spec, a schema, a screenshot of the screen being replaced. The
    // files are mirrored to disk on upload, so they are already there
    // when Submit spawns the architect.
    const attachSection = buildAttachmentsSection('requirement', requirementId);
    wrap.append(titleLabel, projectLabel, descLabel, attachSection, actions);
    buildRequirementOverlay('New architectural design', [wrap]);
    // AFTER the overlay: buildRequirementOverlay closes any previous
    // requirement modal first, and that close sweeps the draft. Setting
    // this earlier would have it cleared before the form was even
    // visible, and the uploads of an abandoned form would then leak.
    draftRequirementId = requirementId;
    // Paste-to-attach targets the draft.
    currentAttachTarget = { ownerType: 'requirement', ownerId: requirementId };
    titleInput.focus();
}

/**
 * Dispatch the new requirement.
 *
 * The id is passed IN rather than minted here: the form has already
 * used it as the owner of any attachments the operator added, and
 * minting a second one would submit a requirement whose design input
 * is filed under an id nothing will ever read.
 */
function submitNewRequirement(
    requirementId: string,
    title: string,
    description: string,
    projectId?: string,
): void {
    void sendCommand({
        type: 'SubmitRequirement',
        actor: 'operator',
        issuedAt: Date.now(),
        payload: {
            requirementId,
            title,
            description,
            ...(projectId ? { projectId } : {}),
        },
    });
}

function requirementCommand(type: string, requirementId: string, extra: Record<string, unknown> = {}): void {
    void sendCommand({
        type,
        actor: 'operator',
        issuedAt: Date.now(),
        payload: { requirementId, ...extra },
    });
}

interface RequirementDetail {
    requirement: { requirementId: string; title: string; description?: string; projectId?: string | null; status: string; revision: number; designDoc?: string | null };
    contracts: Array<{ contractId: string; kind: string; producer: string; consumers: string[]; backwardCompatible: boolean; summary: string }>;
    subBriefs: Array<{ systemId: string; title: string; produces: string[]; consumes: string[] }>;
    rollout: Array<{ systemId: string; deployAfter: string; reason: string }>;
    plans: Array<{ systemId: string; planId: string | null }>;
}

async function buildRequirementModalContent(
    requirementId: string,
): Promise<{ title: string; nodes: HTMLElement[] }> {
    let detail: RequirementDetail | null = null;
    try {
        const res = await fetch(`${API_BASE}/api/requirements/${encodeURIComponent(requirementId)}`);
        if (res.ok) detail = (await res.json()) as RequirementDetail;
    } catch {
        // Fall through to the row-only view below.
    }
    const row = requirements.get(requirementId);
    const status = detail?.requirement.status ?? row?.status ?? 'unknown';
    const revision = detail?.requirement.revision ?? row?.revision ?? 1;
    const title = detail?.requirement.title ?? row?.title ?? requirementId;

    const nodes: HTMLElement[] = [];
    const meta = document.createElement('div');
    meta.className = 'requirement-modal__meta';
    const metaProject = detail?.requirement.projectId;
    meta.textContent = `Status: ${status} · revision ${revision}`
        + (metaProject ? ` · project ${metaProject}` : '');
    nodes.push(meta);

    // Actions available by status.
    const actions = document.createElement('div');
    actions.className = 'requirement-modal__actions';
    if (status === 'proposed') {
        const approve = document.createElement('button');
        approve.type = 'button';
        approve.className = 'requirement-modal__approve';
        approve.textContent = 'Approve — fan out plans';
        approve.addEventListener('click', () => {
            requirementCommand('ApproveArchitecture', requirementId, { revision });
            closeRequirementModal();
        });
        actions.appendChild(approve);
    }
    // Regenerate / Re-run live in their own section at the END of the
    // body (see buildRequirementRegenerateSection) rather than as a
    // button here: guidance for the architect is a paragraph, not a
    // word, and it used to be collected through `window.prompt`.
    const archive = document.createElement('button');
    archive.type = 'button';
    archive.className = 'requirement-modal__archive';
    archive.textContent = 'Archive';
    archive.addEventListener('click', () => {
        requirementCommand('ArchiveRequirement', requirementId);
        closeRequirementModal();
    });
    actions.appendChild(archive);
    nodes.push(actions);

    // The full business request — always visible. While the architect is
    // RUNNING it is read-only (the live run's prompt was built from this
    // text, so editing mid-run would desync operator and agent); when idle
    // it becomes an editable form saved via UpdateRequirement (which the
    // server also guards against a concurrent run).
    const description = detail?.requirement.description ?? row?.description ?? '';
    const editable = status !== 'architecting' && status !== 'archived' && !row?.archived;
    const requestSection = document.createElement('section');
    requestSection.className = 'requirement-modal__section requirement-modal__request';
    const requestHeading = document.createElement('h4');
    requestHeading.textContent = editable ? 'Business request (editable)' : 'Business request';
    requestSection.appendChild(requestHeading);
    if (editable) {
        const editTitleLabel = document.createElement('label');
        editTitleLabel.textContent = 'Title';
        const editTitleInput = document.createElement('input');
        editTitleInput.type = 'text';
        editTitleInput.className = 'requirement-form__title';
        editTitleInput.value = title;
        editTitleLabel.appendChild(editTitleInput);
        const editDescInput = document.createElement('textarea');
        editDescInput.className = 'requirement-form__desc';
        editDescInput.rows = 8;
        editDescInput.value = description;
        const saveBtn = document.createElement('button');
        saveBtn.type = 'button';
        saveBtn.className = 'requirement-modal__save';
        saveBtn.textContent = 'Save changes';
        const saveMsg = document.createElement('p');
        saveMsg.className = 'requirement-modal__note';
        saveBtn.addEventListener('click', async () => {
            const newTitle = editTitleInput.value.trim();
            const newDesc = editDescInput.value.trim();
            if (newTitle.length === 0) {
                saveMsg.textContent = 'Title is required.';
                return;
            }
            if (newTitle === title && newDesc === description) {
                saveMsg.textContent = 'No changes to save.';
                return;
            }
            saveBtn.disabled = true;
            try {
                await sendCommandOrThrow({
                    type: 'UpdateRequirement',
                    actor: 'operator',
                    issuedAt: Date.now(),
                    payload: { requirementId, title: newTitle, description: newDesc },
                });
                saveMsg.textContent =
                    'Saved - a later "Regenerate" / "Re-run architect" uses the updated text.';
            } catch (err) {
                saveMsg.textContent = err instanceof Error ? err.message : String(err);
            }
            saveBtn.disabled = false;
        });
        requestSection.append(editTitleLabel, editDescInput, saveBtn, saveMsg);
    } else {
        // Read-only: the FULL request text, not a truncated card line.
        const requestText = document.createElement('p');
        requestText.className = 'requirement-modal__request-text';
        requestText.textContent = description.length > 0 ? description : '(no description)';
        requestSection.appendChild(requestText);
    }
    nodes.push(requestSection);

    // Design INPUT: files the operator pins for the architect to read —
    // an API spec, a schema, a screenshot of the screen being replaced.
    // Directly after the request, because that is what they belong to:
    // the request says what is wanted and these say what it looks like.
    // Mirrored to disk on upload, so the architect and the
    // design-verifier Read the real bytes rather than a caption.
    nodes.push(buildAttachmentsSection('requirement', requirementId));

    // The narrative design + Mermaid diagrams (component + sequence), rendered
    // via the same markdown+mermaid path as plan bodies.
    if (detail?.requirement.designDoc) {
        const designSection = document.createElement('section');
        designSection.className = 'plan-modal__plan-body requirement-modal__design';
        const h = document.createElement('h4');
        h.textContent = 'Design';
        designSection.appendChild(h);
        // Diagram export — the design's Mermaid blocks as raw .mmd sources
        // or a multi-page .drawio with NATIVE shapes (editable in
        // diagrams.net; unconvertible diagrams fall back to a source-note
        // page so the file always opens complete).
        // Sanitize the whole doc up front so renders AND exports (.mmd /
        // .drawio) all see valid Mermaid, including docs stored before
        // the capture-time sanitizer existed.
        const designDoc = sanitizeMermaidInMarkdown(detail.requirement.designDoc);
        const diagramBlocks = extractMermaidBlocks(designDoc);
        if (diagramBlocks.length > 0) {
            const bar = document.createElement('div');
            bar.className = 'requirement-modal__export';
            const label = document.createElement('span');
            label.className = 'requirement-modal__export-label';
            label.textContent = 'Export diagrams:';
            bar.appendChild(label);
            const drawioBtn = document.createElement('button');
            drawioBtn.type = 'button';
            drawioBtn.textContent = '.drawio (all)';
            drawioBtn.title = 'Multi-page draw.io file — one page per diagram, native shapes';
            drawioBtn.addEventListener('click', () => {
                const file = markdownToDrawio(designDoc);
                if (!file) return;
                downloadTextFile(`${requirementId}-diagrams.drawio`, file, 'application/xml');
            });
            bar.appendChild(drawioBtn);
            diagramBlocks.forEach((block, i) => {
                const name = pageNameFor(block, i);
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.textContent = `${name} (.mmd)`;
                btn.title = 'Raw Mermaid source';
                btn.addEventListener('click', () => {
                    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
                    downloadTextFile(`${requirementId}-${slug}.mmd`, block.source, 'text/plain');
                });
                bar.appendChild(btn);
            });
            designSection.appendChild(bar);
        }
        for (const node of renderMarkdown(designDoc)) {
            designSection.appendChild(node);
        }
        nodes.push(designSection);
    }

    if (detail) {
        if (detail.contracts.length > 0) {
            nodes.push(buildRequirementListSection('Contracts',
                detail.contracts.map((c) =>
                    `${c.contractId} (${c.kind}) — ${c.producer} → ${c.consumers.join(', ') || '(none)'}`
                    + (c.backwardCompatible ? '' : ' · BREAKING'))));
        }
        if (detail.subBriefs.length > 0) {
            nodes.push(buildRequirementListSection('Per-system plans (independent)',
                detail.subBriefs.map((s) =>
                    `${s.systemId}: ${s.title}`
                    + (s.produces.length ? ` · produces ${s.produces.join(', ')}` : '')
                    + (s.consumes.length ? ` · consumes ${s.consumes.join(', ')}` : ''))));
        }
        if (detail.rollout.length > 0) {
            nodes.push(buildRequirementListSection('Rollout order (deploy)',
                detail.rollout.map((r) => `${r.systemId} after ${r.deployAfter} — ${r.reason}`)));
        }
        if (detail.plans.length > 0) {
            nodes.push(buildRequirementListSection('Fanned-out plans',
                detail.plans.map((p) => `${p.systemId}${p.planId ? ` → ${p.planId}` : ''}`)));
        }
    }
    if (status === 'architecting') {
        const note = document.createElement('p');
        note.className = 'requirement-modal__note';
        note.textContent = 'The architect is working on this design — the proposal will appear when it finishes.';
        nodes.push(note);
    }
    const regenSection = buildRequirementRegenerateSection(requirementId, status, revision);
    if (regenSection !== null) nodes.push(regenSection);

    return { title, nodes };
}

async function openRequirementModal(requirementId: string): Promise<void> {
    // Hydrated BEFORE the content is built: the SSE reducers only carry
    // attachments added since the page loaded, and a fetch that resolved
    // after the first paint would leave the section looking empty.
    await fetchAttachmentList('requirement', requirementId);
    const { title, nodes } = await buildRequirementModalContent(requirementId);
    const reqRow = requirements.get(requirementId);
    buildRequirementOverlay(title, nodes, {
        requirementId,
        projectId: reqRow?.projectId ?? '',
    });
    requirementModalRequirementId = requirementId;
    // Paste-to-attach targets whichever modal is open.
    currentAttachTarget = { ownerType: 'requirement', ownerId: requirementId };
}

/**
 * Re-render the requirement modal's LEFT pane in place when a
 * requirement lifecycle event lands for the open requirement — same
 * live-review property the plan modal has. The chat pane (right) is a
 * sibling of the body element, so the swap never touches the thread.
 * Async re-fetch is fine here: requirement events are rare (approve,
 * verification verdicts, updates), unlike the per-tick plan refresh.
 */
let requirementRefreshToken = 0;
async function refreshRequirementModal(requirementId: string): Promise<void> {
    if (requirementModalRequirementId !== requirementId) return;
    const bodyEl = requirementModalBodyEl;
    if (!bodyEl) return;
    // Per-pane focus guard: don't rebuild under the operator's caret in
    // the LEFT pane (regenerate feedback fields etc.); typing in the
    // chat composer (outside bodyEl) must not block the refresh.
    const active = document.activeElement;
    if (
        active !== null
        && bodyEl.contains(active)
        && (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement)
    ) {
        return;
    }
    // Carry typed-but-unsent regenerate feedback across the rebuild. The
    // focus guard above only covers the case where the caret is IN the
    // box; the operator who types ten lines and then clicks away to
    // re-read the design would otherwise lose the lot to the next SSE
    // tick — worse than the `window.prompt` this replaced.
    const prevFeedback = (bodyEl.querySelector(
        `.${REGENERATE_FEEDBACK_CLASS}`,
    ) as HTMLTextAreaElement | null)?.value ?? '';
    const token = ++requirementRefreshToken;
    try {
        const { nodes } = await buildRequirementModalContent(requirementId);
        // Stale-response guards: a newer refresh superseded this one, or
        // the modal closed / switched requirement while we fetched.
        if (token !== requirementRefreshToken) return;
        if (requirementModalRequirementId !== requirementId) return;
        if (requirementModalBodyEl !== bodyEl) return;
        bodyEl.replaceChildren(...nodes);
        if (prevFeedback.length > 0) {
            const next = bodyEl.querySelector(
                `.${REGENERATE_FEEDBACK_CLASS}`,
            ) as HTMLTextAreaElement | null;
            // Only into an empty box: never clobber what the fresh
            // render legitimately put there.
            if (next && next.value.length === 0) next.value = prevFeedback;
        }
    } catch {
        // Fetch hiccup — keep the current content; the next event retries.
    }
}

/**
 * Render the "Regenerate this design" section — a ten-row textarea plus
 * the button that sends it. The wording and whether it appears at all
 * come from {@link describeRegenerateSection}; this half is the DOM and
 * the dispatch.
 */
function buildRequirementRegenerateSection(
    requirementId: string,
    status: string,
    revision: number,
): HTMLElement | null {
    const spec = describeRegenerateSection(status);
    if (spec === null) return null;

    const section = document.createElement('section');
    section.className = 'requirement-modal__regenerate-section';

    const heading = document.createElement('h4');
    heading.textContent = spec.heading;
    section.appendChild(heading);

    const hint = document.createElement('p');
    hint.className = 'requirement-modal__regenerate-hint';
    hint.textContent = spec.hint;
    section.appendChild(hint);

    const feedback = document.createElement('textarea');
    feedback.className = REGENERATE_FEEDBACK_CLASS;
    feedback.rows = REGENERATE_ROWS;
    feedback.placeholder = spec.placeholder;
    section.appendChild(feedback);

    const buttonRow = document.createElement('div');
    buttonRow.className = 'requirement-modal__regenerate-actions';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'requirement-modal__regenerate-btn';
    btn.textContent = spec.buttonLabel;
    btn.addEventListener('click', () => {
        // Disable before dispatching: the command is fire-and-forget and
        // the modal closes on the next line, but a double-click inside
        // that window would spawn the architect twice on one revision.
        btn.disabled = true;
        requirementCommand('RegenerateArchitecture', requirementId, {
            revision: nextRegenerateRevision(revision),
            feedback: feedback.value,
        });
        // Close so the next SSE tick can re-render the card as
        // architecting rather than leaving stale controls on screen.
        closeRequirementModal();
    });
    buttonRow.appendChild(btn);
    section.appendChild(buttonRow);

    return section;
}

function buildRequirementListSection(heading: string, items: string[]): HTMLElement {
    const section = document.createElement('section');
    section.className = 'requirement-modal__section';
    const h = document.createElement('h4');
    h.textContent = heading;
    section.appendChild(h);
    const ul = document.createElement('ul');
    for (const it of items) {
        const li = document.createElement('li');
        li.textContent = it;
        ul.appendChild(li);
    }
    section.appendChild(ul);
    return section;
}

async function hydrateRequirements(): Promise<void> {
    try {
        const res = await fetch(`${API_BASE}/api/requirements`);
        if (!res.ok) return;
        const json = (await res.json()) as { requirements?: unknown };
        const list = Array.isArray(json.requirements) ? json.requirements : [];
        for (const raw of list) {
            const r = raw as Record<string, unknown>;
            if (typeof r.requirementId !== 'string') continue;
            requirements.set(r.requirementId, {
                requirementId: r.requirementId,
                title: typeof r.title === 'string' ? r.title : '',
                description: typeof r.description === 'string' ? r.description : '',
                projectId:
                    typeof r.projectId === 'string' && r.projectId.length > 0
                        ? r.projectId
                        : null,
                status: typeof r.status === 'string' ? r.status : 'submitted',
                revision: typeof r.revision === 'number' ? r.revision : 1,
                archived: typeof r.archivedAt === 'number' && r.archivedAt !== null,
                archivedAt: typeof r.archivedAt === 'number' ? r.archivedAt : null,
                ...parseVerificationFields(r),
            });
        }
        scheduleRender();
    } catch {
        // Non-fatal — the lane stays empty until an SSE event arrives.
    }
}

/**
 * Hydration mapping for the verification-gate fields: the API carries
 * `verificationStatus` plus `verificationFindings` as the projection's
 * JSON blob `{findings: [...], error?, summary?}`.
 */
function parseVerificationFields(r: Record<string, unknown>): {
    verificationStatus: string | null;
    verificationFindings: Array<{ systemId: string | null; severity: string; finding: string }>;
    verificationError: string | null;
} {
    const status = typeof r.verificationStatus === 'string' ? r.verificationStatus : null;
    let findings: Array<{ systemId: string | null; severity: string; finding: string }> = [];
    let error: string | null = null;
    if (typeof r.verificationFindings === 'string' && r.verificationFindings.length > 0) {
        try {
            const blob = JSON.parse(r.verificationFindings) as {
                findings?: unknown;
                error?: unknown;
            };
            if (Array.isArray(blob.findings)) {
                findings = (blob.findings as Array<Record<string, unknown>>)
                    .filter((f) => f && typeof f.finding === 'string')
                    .map((f) => ({
                        systemId: typeof f.systemId === 'string' ? f.systemId : null,
                        severity: typeof f.severity === 'string' ? f.severity : 'warning',
                        finding: f.finding as string,
                    }));
            }
            if (typeof blob.error === 'string' && blob.error.length > 0) error = blob.error;
        } catch { /* unparseable blob — render without findings */ }
    }
    return { verificationStatus: status, verificationFindings: findings, verificationError: error };
}

function wireRequirementButtons(): void {
    const btn = document.querySelector('[data-action="open-new-requirement"]');
    if (btn) btn.addEventListener('click', () => openNewRequirementModal());
}

// --- Show architect agent: live stream (Architect Tier) --------------
// The architect runs as a lifecycle agent (kind === 'architect'), so it
// emits the same AgentStarted/Progress/Finished stream the planner does —
// tagged with metadata.planId = `req-<requirementId>`. We fold it into
// `activeArchitects` and surface the transcript via a Show-agent modal
// reusing the planner modal's chrome + row renderers.
interface ActiveArchitect {
    readonly requirementId: string;
    planId: string;
    projectId: string;
    /** Backfilled from AgentProgress when we missed AgentStarted (reload). */
    agentId: string;
    /** Resolved model this run actually used (from AgentStarted). */
    model?: string;
    startedAt: number;
    chunks: string[];
    activities: PlannerActivity[];
    status: 'running' | 'complete' | 'failed';
    error?: string;
    finishedAt?: number;
}
const activeArchitects = new Map<string, ActiveArchitect>();

/**
 * Get or lazily create the architect stream row for a requirement. Lazy
 * creation matters on a page reload mid-run: the board missed the past
 * AgentStarted (SSE only streams new events), so the row is seeded from the
 * first AgentProgress/Activity that arrives afterward instead of being lost.
 */
function ensureArchitectRow(
    requirementId: string,
    md: { planId?: unknown; projectId?: unknown } | null,
    agentId: string | null,
): ActiveArchitect {
    let row = activeArchitects.get(requirementId);
    if (!row) {
        row = {
            requirementId,
            planId: typeof md?.planId === 'string' ? md.planId : `req-${requirementId}`,
            projectId: typeof md?.projectId === 'string' ? md.projectId : '',
            agentId: agentId ?? '',
            startedAt: Date.now(),
            chunks: [],
            activities: [],
            status: 'running',
        };
        activeArchitects.set(requirementId, row);
    } else if (agentId && !row.agentId) {
        row.agentId = agentId; // backfill so Stop works after a reload
    }
    return row;
}

function architectReqIdFromMeta(
    md: { kind?: unknown; planId?: unknown } | null,
): string | null {
    if (!md || md.kind !== 'architect' || typeof md.planId !== 'string') return null;
    const planId = md.planId;
    return planId.startsWith('req-') ? planId.slice(4) : planId;
}

function applyArchitectEvent(type: string, payload: Record<string, unknown>): boolean {
    const md = (payload.metadata ?? null) as
        | { kind?: unknown; planId?: unknown; projectId?: unknown }
        | null;
    const requirementId = architectReqIdFromMeta(md);
    if (requirementId === null) return false; // not an architect run
    const agentId = typeof payload.agentId === 'string' ? payload.agentId : null;
    switch (type) {
        case 'AgentStarted': {
            const row = ensureArchitectRow(requirementId, md, agentId);
            row.status = 'running';
            if (typeof payload.model === 'string') row.model = payload.model;
            row.startedAt = Date.now();
            pushPlannerActivity(row, {
                at: Date.now(),
                category: 'lifecycle',
                detail: `agent started${agentId ? ` · ${agentId}` : ''}`,
            });
            return true;
        }
        case 'AgentProgress': {
            const chunk = typeof payload.chunk === 'string' ? payload.chunk : '';
            if (chunk.length === 0) return true;
            const row = ensureArchitectRow(requirementId, md, agentId);
            row.chunks.push(chunk);
            coalesceAssistantChunk(row.activities, chunk, (entry) =>
                pushPlannerActivity(row, entry));
            while (row.chunks.length > ACTIVE_PLANNER_CHUNK_LIMIT) row.chunks.shift();
            return true;
        }
        case 'AgentActivity': {
            const row = ensureArchitectRow(requirementId, md, agentId);
            const category = typeof payload.category === 'string' ? payload.category : 'event';
            const detail = typeof payload.detail === 'string' ? payload.detail : '';
            const extra = typeof payload.extra === 'string' ? payload.extra : undefined;
            pushPlannerActivity(row, {
                at: Date.now(),
                category,
                detail,
                ...(extra !== undefined ? { extra } : {}),
            });
            return true;
        }
        case 'AgentFinished': {
            const row = ensureArchitectRow(requirementId, md, agentId);
            row.status = 'complete';
            row.finishedAt = Date.now();
            pushPlannerActivity(row, { at: Date.now(), category: 'lifecycle', detail: 'agent finished' });
            return true;
        }
        case 'AgentFailed': {
            const row = ensureArchitectRow(requirementId, md, agentId);
            row.status = 'failed';
            row.finishedAt = Date.now();
            row.error = typeof payload.stderrTail === 'string' && payload.stderrTail.length > 0
                ? truncate(payload.stderrTail, 240)
                : 'architect failed';
            pushPlannerActivity(row, {
                at: Date.now(),
                category: 'lifecycle',
                detail: `agent failed${row.error ? ` · ${row.error}` : ''}`,
            });
            return true;
        }
        default:
            return false;
    }
}

const SHOW_ARCHITECT_AGENT_OVERLAY_ID = 'show-architect-agent';
let showArchitectAgentBody: HTMLElement | null = null;
let showArchitectAgentTitle: HTMLElement | null = null;
let showArchitectAgentStatus: HTMLElement | null = null;
let showArchitectAgentBackdrop: HTMLElement | null = null;
let showArchitectAgentReqId: string | null = null;
let showArchitectAgentStopBtn: HTMLButtonElement | null = null;
let showArchitectAgentTick: ReturnType<typeof setInterval> | null = null;

function openShowArchitectAgentModal(requirementId: string): void {
    if (showArchitectAgentBackdrop !== null) closeShowArchitectAgentModal();
    const root = ensureOverlayRoot();
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-chrome__overlay';
    const panel = document.createElement('div');
    panel.className = 'show-planner-agent-modal show-architect-agent-modal modal-chrome';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    const header = document.createElement('div');
    header.className = 'modal-chrome__header';
    const heading = document.createElement('h3');
    heading.className = 'modal-chrome__title';
    header.appendChild(heading);
    const status = document.createElement('span');
    status.className = 'show-planner-agent-status';
    header.appendChild(status);
    const stopBtn = document.createElement('button');
    stopBtn.className = 'show-planner-agent-stop active-planner-card__action active-planner-card__action--danger';
    stopBtn.type = 'button';
    stopBtn.textContent = 'Stop agent';
    stopBtn.addEventListener('click', () => requestStopArchitect(requirementId));
    header.appendChild(stopBtn);
    showArchitectAgentStopBtn = stopBtn;
    const closeBtn = document.createElement('button');
    closeBtn.className = 'modal-chrome__close';
    closeBtn.type = 'button';
    closeBtn.textContent = 'Close';
    closeBtn.addEventListener('click', closeShowArchitectAgentModal);
    header.appendChild(closeBtn);
    panel.appendChild(header);
    const body = document.createElement('div');
    body.className = 'show-planner-agent-body modal-chrome__body';
    panel.appendChild(body);
    backdrop.appendChild(panel);
    root.appendChild(backdrop);
    overlayManager.openOverlay(SHOW_ARCHITECT_AGENT_OVERLAY_ID, panel);
    showArchitectAgentBackdrop = backdrop;
    showArchitectAgentBody = body;
    showArchitectAgentTitle = heading;
    showArchitectAgentStatus = status;
    showArchitectAgentReqId = requirementId;
    if (showArchitectAgentTick !== null) clearInterval(showArchitectAgentTick);
    showArchitectAgentTick = setInterval(() => refreshShowArchitectAgentModal(), 1000);
    refreshShowArchitectAgentModal();
}

function closeShowArchitectAgentModal(): void {
    if (showArchitectAgentBackdrop === null) return;
    overlayManager.closeOverlay(SHOW_ARCHITECT_AGENT_OVERLAY_ID);
    showArchitectAgentBackdrop.remove();
    showArchitectAgentBackdrop = null;
    showArchitectAgentBody = null;
    showArchitectAgentTitle = null;
    showArchitectAgentStatus = null;
    showArchitectAgentReqId = null;
    showArchitectAgentStopBtn = null;
    if (showArchitectAgentTick !== null) {
        clearInterval(showArchitectAgentTick);
        showArchitectAgentTick = null;
    }
}

function refreshShowArchitectAgentModal(): void {
    if (showArchitectAgentBody === null || showArchitectAgentReqId === null
        || showArchitectAgentTitle === null || showArchitectAgentStatus === null) {
        return;
    }
    const row = activeArchitects.get(showArchitectAgentReqId);
    const titleText = requirements.get(showArchitectAgentReqId)?.title ?? showArchitectAgentReqId;
    showArchitectAgentTitle.textContent = `Architect — ${titleText}`;
    if (!row) {
        showArchitectAgentStatus.textContent = '(no active run)';
        showArchitectAgentBody.textContent = '';
        if (showArchitectAgentStopBtn) showArchitectAgentStopBtn.hidden = true;
        return;
    }
    if (showArchitectAgentStopBtn) showArchitectAgentStopBtn.hidden = row.status !== 'running';
    showArchitectAgentStatus.textContent = row.status === 'running'
        ? '● running'
        : row.status === 'complete'
            ? '✓ complete'
            : `✗ failed${row.error ? `: ${row.error}` : ''}`;
    renderShowArchitectAgentBody(showArchitectAgentBody, row);
    if (row.status !== 'running' && showArchitectAgentTick !== null) {
        clearInterval(showArchitectAgentTick);
        showArchitectAgentTick = null;
    }
}

function renderShowArchitectAgentBody(body: HTMLElement, row: ActiveArchitect): void {
    const elapsed = formatElapsed(Math.max(0, Date.now() - row.startedAt));
    const statusLabel = row.status === 'running'
        ? `running · ${elapsed}`
        : row.status === 'complete'
            ? `complete · ${elapsed}`
            : `failed${row.error ? ` · ${row.error}` : ''}`;
    const header = document.createElement('div');
    header.className = `stream-header stream-header--${row.status}`;
    header.textContent = `● Architect ${statusLabel}`;
    const children: HTMLElement[] = [header];
    if (row.activities.length === 0) {
        const idle = document.createElement('div');
        idle.className = 'stream-idle';
        idle.textContent = row.status === 'running'
            ? '(waiting for the first event — claude is starting up)'
            : '(no activity captured)';
        children.push(idle);
    } else {
        if (row.activities.length >= ACTIVE_PLANNER_ACTIVITY_LIMIT) {
            const elide = document.createElement('div');
            elide.className = 'stream-elide';
            elide.textContent = '(earlier activity elided — buffer capped)';
            children.push(elide);
        }
        for (const entry of row.activities) children.push(renderActivityRow(entry));
    }
    applyStreamChildren(body, children);
}

function requestStopArchitect(requirementId: string): void {
    const row = activeArchitects.get(requirementId);
    if (row && row.status === 'running' && row.agentId) {
        void sendCommand({
            type: 'CancelAgentRun',
            actor: 'operator',
            issuedAt: Date.now(),
            payload: { runId: row.agentId, reason: 'operator stopped architect' },
        });
    }
}

// --- Plan modal: title + body + interactive task cards ---------------
const PLAN_MODAL_OVERLAY_ID = 'plan-modal';
let planModalBackdrop: HTMLElement | null = null;
let planModalPlanId: string | null = null;

function openPlanModal(planId: string): void {
    if (planModalBackdrop !== null) closePlanModal();
    // Defensive cleanup: if a prior openOverlay threw mid-construction we
    // could be left with a stale `plan-modal` id on the overlay-manager
    // stack while `planModalBackdrop` is null — every subsequent click
    // would then re-throw at openOverlay and the operator would see an
    // empty (or stuck) modal shell. closeOverlay is idempotent so the
    // belt-and-braces close before each open is safe.
    overlayManager.closeOverlay(PLAN_MODAL_OVERLAY_ID);

    planModalPlanId = planId;
    const root = ensureOverlayRoot();
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-chrome__overlay';
    backdrop.setAttribute('data-plan-modal-overlay', '');
    // Clicking the backdrop (outside the panel) closes the modal —
    // matches the task modal's affordance and the convention every
    // other modal in the board follows. Without this, the only escape
    // was the Close button, which felt like a regression vs the rest
    // of the UI.
    backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) closePlanModal();
    });
    const panel = document.createElement('div');
    panel.className = 'plan-modal modal-chrome';
    panel.setAttribute('data-plan-modal', '');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-labelledby', 'plan-modal-title');
    panel.setAttribute('data-plan-id', planId);

    const header = document.createElement('div');
    header.className = 'modal-chrome__header';
    const title = document.createElement('h3');
    title.className = 'modal-chrome__title';
    title.id = 'plan-modal-title';
    title.setAttribute('data-plan-modal-title', '');
    header.appendChild(title);
    // Side-by-side chat: toggles the modal into a split view with the
    // plan on the left (still live-refreshing) and the scoped chat
    // thread on the right — review while chatting. The pane lives
    // OUTSIDE the [data-plan-modal-body] element so refreshPlanModal's
    // rebuild never touches the thread or the composer.
    const chatBtn = document.createElement('button');
    chatBtn.className = 'plan-modal__chat-toggle';
    chatBtn.type = 'button';
    chatBtn.textContent = '💬 Chat';
    chatBtn.addEventListener('click', () => togglePlanChatPane(planId));
    header.appendChild(chatBtn);
    const closeBtn = document.createElement('button');
    closeBtn.className = 'modal-chrome__close';
    closeBtn.type = 'button';
    closeBtn.textContent = 'Close';
    closeBtn.addEventListener('click', closePlanModal);
    header.appendChild(closeBtn);
    panel.appendChild(header);

    const content = document.createElement('div');
    content.className = 'plan-modal__content';
    content.setAttribute('data-plan-modal-content', '');
    panel.appendChild(content);

    const body = document.createElement('div');
    body.className = 'modal-chrome__body plan-modal__body';
    body.setAttribute('data-plan-modal-body', '');
    content.appendChild(body);

    backdrop.appendChild(panel);
    root.appendChild(backdrop);
    // Track backdrop FIRST so a refreshPlanModal-thrown error still
    // gets the modal torn down on close. Previously planModalBackdrop
    // was set AFTER openOverlay + refreshPlanModal, so any throw in
    // either left planModalBackdrop null while the DOM kept the empty
    // shell — closePlanModal would then early-return and the operator
    // was stuck staring at an empty modal.
    planModalBackdrop = backdrop;
    try {
        overlayManager.openOverlay(PLAN_MODAL_OVERLAY_ID, panel);
        refreshPlanModal();
    } catch (err) {
        // eslint-disable-next-line no-console
        console.error('board-ui: openPlanModal failed', err);
        closePlanModal();
        return;
    }
    // Lazy-fetch planner content if it isn't cached yet — covers
    // the race where the modal is opened before the /api/plan-reviews
    // hydration finishes, or where an old planner revision pre-dates
    // the board session.
    void ensurePlanReviewContent(planId);
    // Boot hydration skips CLOSED tasks' step records; this modal renders
    // them, so pull the ones it needs now rather than fetching 1,300 of
    // them on every page load.
    void ensurePlanStepRuns(planId);
    currentAttachTarget = { ownerType: 'plan', ownerId: planId };
    void fetchAttachmentList('plan', planId);
}

async function ensurePlanReviewContent(planId: string): Promise<void> {
    if (planReviewContent.has(planId)) return;
    const plan = plans.get(planId);
    if (!plan || !plan.projectId) return;
    try {
        const url = `${API_BASE}/api/projects/${encodeURIComponent(plan.projectId)}/plans/${encodeURIComponent(planId)}/plan-review`;
        const res = await fetch(url);
        if (!res.ok) return;
        const json = (await res.json()) as { markdown?: unknown };
        if (typeof json.markdown === 'string' && json.markdown.length > 0) {
            planReviewContent.set(planId, json.markdown);
            scheduleRender();
        }
    } catch {
        // Quiet failure — falls back to the brief in the modal body.
    }
}

let planChatHandle: ScopedChatHandle | null = null;

function togglePlanChatPane(planId: string): void {
    if (planModalBackdrop === null) return;
    const panel = planModalBackdrop.querySelector('[data-plan-modal]') as HTMLElement | null;
    const content = planModalBackdrop.querySelector('[data-plan-modal-content]') as HTMLElement | null;
    if (!panel || !content) return;
    if (planChatHandle !== null) {
        planChatHandle.destroy();
        planChatHandle = null;
        panel.classList.remove('plan-modal--split');
        content.querySelector('.plan-modal__chat-pane')?.remove();
        return;
    }
    const plan = plans.get(planId);
    if (!plan) return;
    const pane = document.createElement('div');
    pane.className = 'plan-modal__chat-pane';
    content.appendChild(pane);
    panel.classList.add('plan-modal--split');
    const md = plan.metadata as { targetRepo?: unknown };
    planChatHandle = mountScopedChatPane(pane, {
        apiBase: API_BASE,
        scopeKind: 'plan',
        scopeId: planId,
        projectId: plan.projectId,
        repoId: typeof md.targetRepo === 'string' ? md.targetRepo : null,
        title: `Plan chat — ${plan.title ?? planId}`,
        sendCommand: (command) => sendCommandOrThrow(command as BoardCommand),
        createPlan: scopedChatCreatePlan(
            plan.projectId,
            typeof md.targetRepo === 'string' ? md.targetRepo : null,
        ),
        onError: (message) => showToast({ message, kind: 'error' }),
    });
}

function closePlanModal(): void {
    if (planModalBackdrop === null) return;
    if (planChatHandle !== null) {
        planChatHandle.destroy();
        planChatHandle = null;
    }
    overlayManager.closeOverlay(PLAN_MODAL_OVERLAY_ID);
    planModalBackdrop.remove();
    planModalBackdrop = null;
    planModalPlanId = null;
    if (currentAttachTarget?.ownerType === 'plan') currentAttachTarget = null;
}

// --- Add task to plan --------------------------------------------------
//
// Operator-authored tasks for work the planner/decomposer missed. Rendered
// as its OWN overlay (not inline in the plan modal) because the plan modal
// rebuilds its body on every SSE tick — an inline form would be recreated
// empty mid-typing whenever an unrelated event lands. A separate overlay
// is untouched by refreshPlanModal.
//
// Task types offered = the install's flows that declare
// `task_type.add_task`, and plan archetypes = core + enabled packs, both
// from `GET /api/task-types` (hydrateTaskTypes). They used to be hardcoded
// here, so a type with no loaded flow could be offered — a task created
// that way sat silently unstartable — and a pack's types could never show.
let addTaskTypes: ReadonlyArray<{ id: string; label: string }> = [];
let planArchetypes: ReadonlyArray<{ value: string; label: string }> = [];

const ADD_TASK_OVERLAY_ID = 'add-task-modal';

function openAddTaskModal(plan: PlanRow, planTasks: readonly TaskRow[]): void {
    overlayManager.closeOverlay(ADD_TASK_OVERLAY_ID);
    const root = ensureOverlayRoot();
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-chrome__overlay';
    const close = (): void => {
        overlayManager.closeOverlay(ADD_TASK_OVERLAY_ID);
        backdrop.remove();
    };
    backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) close();
    });

    const panel = document.createElement('div');
    panel.className = 'add-task-modal modal-chrome';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');

    const header = document.createElement('div');
    header.className = 'modal-chrome__header';
    const title = document.createElement('h3');
    title.className = 'modal-chrome__title';
    title.textContent = `Add task — ${plan.title ?? plan.planId}`;
    header.appendChild(title);
    const closeBtn = document.createElement('button');
    closeBtn.className = 'modal-chrome__close';
    closeBtn.type = 'button';
    closeBtn.textContent = 'Close';
    closeBtn.addEventListener('click', close);
    header.appendChild(closeBtn);
    panel.appendChild(header);

    const body = document.createElement('div');
    body.className = 'modal-chrome__body add-task-modal__body';

    const field = (labelText: string, control: HTMLElement): HTMLElement => {
        const wrap = document.createElement('label');
        wrap.className = 'add-task-modal__field';
        const span = document.createElement('span');
        span.className = 'add-task-modal__label';
        span.textContent = labelText;
        wrap.appendChild(span);
        wrap.appendChild(control);
        return wrap;
    };

    const titleInput = document.createElement('input');
    titleInput.type = 'text';
    titleInput.className = 'add-task-modal__title';
    titleInput.placeholder = 'Short imperative title, e.g. "Handle missing price rows in importer"';
    body.appendChild(field('Title', titleInput));

    const typeSelect = document.createElement('select');
    typeSelect.className = 'add-task-modal__type';
    if (addTaskTypes.length === 0) {
        // Say so rather than offer an empty menu that looks broken.
        showToast({
            message: 'Task types are not loaded yet (GET /api/task-types) — reload the board if this persists.',
            kind: 'error',
        });
    }
    for (const t of addTaskTypes) {
        const opt = document.createElement('option');
        opt.value = t.id;
        opt.textContent = t.label;
        typeSelect.appendChild(opt);
    }
    if (addTaskTypes.some((t) => t.id === 'implement')) typeSelect.value = 'implement';
    body.appendChild(field('Task type', typeSelect));

    const descInput = document.createElement('textarea');
    descInput.className = 'add-task-modal__description';
    descInput.rows = 6;
    descInput.placeholder
        = 'Brief for the agent: what needs to happen, why (e.g. what the '
        + 'failed task missed), and how to verify it worked.';
    body.appendChild(field('Description', descInput));

    // Repo select: "(plan default)" resolves server-side via the plan's
    // targetRepo; a concrete choice rides TaskCreated.repoId and wins in
    // per-task worktree resolution (migration 028 path).
    const repoSelect = document.createElement('select');
    repoSelect.className = 'add-task-modal__repo';
    const defaultOpt = document.createElement('option');
    defaultOpt.value = '';
    defaultOpt.textContent = '(plan default)';
    repoSelect.appendChild(defaultOpt);
    const fillRepos = (): void => {
        for (const repo of Array.from(repos.values()).sort(
            (a, b) => a.repoId.localeCompare(b.repoId),
        )) {
            if (repo.archivedAt !== null) continue;
            const opt = document.createElement('option');
            opt.value = repo.repoId;
            opt.textContent = repo.repoId;
            repoSelect.appendChild(opt);
        }
    };
    if (repos.size > 0) {
        fillRepos();
    } else {
        void loadRepos().then(() => {
            if (repoSelect.options.length <= 1) fillRepos();
        });
    }
    body.appendChild(field('Repository', repoSelect));

    // Dependencies: tick the plan tasks that must finish first. The
    // TaskCreated bridge persists the edges and parks the new task on
    // 'waiting-deps' until every upstream is terminal.
    const depChecks: Array<{ box: HTMLInputElement; id: string }> = [];
    if (planTasks.length > 0) {
        const depWrap = document.createElement('div');
        depWrap.className = 'add-task-modal__deps';
        const depLabel = document.createElement('span');
        depLabel.className = 'add-task-modal__label';
        depLabel.textContent = 'Depends on (optional)';
        depWrap.appendChild(depLabel);
        for (const t of planTasks) {
            const row = document.createElement('label');
            row.className = 'add-task-modal__dep-row';
            const box = document.createElement('input');
            box.type = 'checkbox';
            row.appendChild(box);
            const text = document.createElement('span');
            text.textContent = t.title && t.title !== t.taskId
                ? `${t.taskId} — ${t.title}`
                : t.taskId;
            row.appendChild(text);
            depWrap.appendChild(row);
            depChecks.push({ box, id: t.taskId });
        }
        body.appendChild(depWrap);
    }

    const errorEl = document.createElement('p');
    errorEl.className = 'add-task-modal__error';
    errorEl.hidden = true;
    body.appendChild(errorEl);

    const actions = document.createElement('div');
    actions.className = 'add-task-modal__actions';
    const submitBtn = document.createElement('button');
    submitBtn.type = 'button';
    submitBtn.className = 'plan-modal__regenerate-btn';
    submitBtn.textContent = 'Add task';
    submitBtn.addEventListener('click', async () => {
        const taskTitle = titleInput.value.trim();
        if (taskTitle.length === 0) {
            errorEl.textContent = 'Title is required.';
            errorEl.hidden = false;
            titleInput.focus();
            return;
        }
        const dependencies = depChecks.filter((d) => d.box.checked).map((d) => d.id);
        const payload: Record<string, unknown> = {
            planId: plan.planId,
            taskType: typeSelect.value,
            flowId: typeSelect.value,
            title: taskTitle,
        };
        const desc = descInput.value.trim();
        if (desc.length > 0) payload.description = desc;
        if (repoSelect.value.length > 0) payload.repoId = repoSelect.value;
        if (dependencies.length > 0) payload.dependencies = dependencies;
        submitBtn.disabled = true;
        errorEl.hidden = true;
        try {
            await sendCommandOrThrow({
                type: 'CreateTask',
                actor: 'operator',
                issuedAt: Date.now(),
                payload,
            });
            showToast({
                message: `Task added to ${plan.title ?? plan.planId} — it starts at the approval gate.`,
                kind: 'success',
            });
            close();
        } catch (err) {
            errorEl.textContent = err instanceof Error ? err.message : String(err);
            errorEl.hidden = false;
            submitBtn.disabled = false;
        }
    });
    actions.appendChild(submitBtn);
    body.appendChild(actions);

    panel.appendChild(body);
    backdrop.appendChild(panel);
    root.appendChild(backdrop);
    overlayManager.openOverlay(ADD_TASK_OVERLAY_ID, panel);
    titleInput.focus();
}

function refreshPlanModal(): void {
    if (planModalBackdrop === null || planModalPlanId === null) return;
    const plan = plans.get(planModalPlanId);
    if (!plan) {
        // Plan vanished (archived → re-decompose path that wiped the
        // row?). Close defensively.
        closePlanModal();
        return;
    }
    const titleEl = planModalBackdrop.querySelector(
        '[data-plan-modal-title]',
    ) as HTMLElement | null;
    if (titleEl) {
        const abbr = planAbbr(plan);
        titleEl.textContent = abbr
            ? `${abbr} — ${plan.title ?? plan.planId}`
            : (plan.title ?? plan.planId);
    }
    const bodyEl = planModalBackdrop.querySelector(
        '[data-plan-modal-body]',
    ) as HTMLElement | null;
    if (!bodyEl) return;

    // The modal re-renders on every SSE tick (replaceChildren rebuilds all
    // sections). Two guards keep that from fighting the operator's typing:
    //  1. While an input/textarea INSIDE the modal has focus, skip the
    //     refresh entirely — a rebuild would recreate the field empty and
    //     drop the caret mid-word. The next tick after blur catches up.
    //  2. Across rebuilds, carry the typed-but-unsubmitted regenerate
    //     feedback into the freshly created textarea.
    // Per-PANE focus guard: only typing inside the LEFT pane (the plan
    // body) blocks its rebuild. Typing in the chat composer (right pane,
    // outside [data-plan-modal-body]) must NOT freeze the plan side —
    // "review while chatting" depends on the left pane refreshing while
    // the operator writes messages.
    if (isOperatorEditingIn(bodyEl, document.activeElement)) return;
    const prevFeedback = (bodyEl.querySelector(
        '.plan-modal__regenerate-feedback',
    ) as HTMLTextAreaElement | null)?.value ?? '';

    try {
        // 3. Scroll survives the rebuild — reading a long plan while its
        //    tasks tick along must not yank the operator back to the top.
        rebuildPreservingScroll(bodyEl, () => {
            bodyEl.replaceChildren(...buildPlanModalBody(plan));
        });
        if (prevFeedback.length > 0) {
            const next = bodyEl.querySelector(
                '.plan-modal__regenerate-feedback',
            ) as HTMLTextAreaElement | null;
            if (next && next.value.length === 0) next.value = prevFeedback;
        }
    } catch (err) {
        // eslint-disable-next-line no-console
        console.error('board-ui: refreshPlanModal body build failed', err);
        // Don't leave the modal blank — render a minimal diagnostic so
        // the operator can at least see the plan id, close the modal,
        // and report what went wrong. Without this, an exception inside
        // one of the body sections (a malformed task row tripping
        // renderTaskCard, a renderMarkdown crash on bad input) used to
        // leave `bodyEl.replaceChildren` un-called and the modal
        // appeared empty.
        const fallback = document.createElement('p');
        fallback.className = 'plan-modal__error';
        fallback.textContent
            = `Plan ${plan.planId} — render failed: ${err instanceof Error ? err.message : String(err)}`;
        bodyEl.replaceChildren(fallback);
    }
}

/**
 * The plan's target repo — shown, and changeable, from the plan modal.
 *
 * `metadata.targetRepo` decides the worktree for every task under the plan
 * that carries no repo of its own, so a wrong value sends agents at the
 * wrong codebase. It was only visible inside the edit-plan form (and only
 * settable there), which meant the operator reading a plan could not see
 * which repo it would run against, let alone correct it.
 *
 * Applies on change rather than behind a Save button: the modal rebuilds on
 * every SSE tick and restores a `<select>` from state, so an unsaved pick
 * would be silently reverted by the next event.
 */
function buildPlanRepoSection(plan: PlanRow): HTMLElement {
    const section = document.createElement('section');
    section.className = 'plan-modal__repo';
    const heading = document.createElement('h4');
    heading.textContent = 'Target repo';
    section.appendChild(heading);

    const hint = document.createElement('p');
    hint.className = 'plan-modal__repo-hint';
    hint.textContent
        = 'Where tasks in this plan run. Tasks that already carry their own '
        + 'repo keep it; everything else follows this.';
    section.appendChild(hint);

    const md = plan.metadata as { targetRepo?: unknown };
    const current = typeof md.targetRepo === 'string' && md.targetRepo.length > 0
        ? md.targetRepo
        : '';
    const project = crudState.projects.find((p) => p.id === plan.projectId) ?? null;
    const options = repoOptionsForProject(project);

    const select = document.createElement('select');
    select.className = 'plan-modal__repo-select';
    select.setAttribute('aria-label', 'Target repo');
    const none = document.createElement('option');
    none.value = '';
    none.textContent = options.length === 0
        ? '(no repos configured for this project)'
        : '(none — tasks must carry their own repo)';
    select.appendChild(none);
    for (const repo of options) {
        const opt = document.createElement('option');
        opt.value = repo.id;
        opt.textContent = repo.name && repo.name !== repo.id
            ? `${repo.name} (${repo.id})`
            : repo.id;
        select.appendChild(opt);
    }
    // The stored repo may not be among the project's options — an archived
    // registry entry, or a repo the project no longer declares. Show it
    // anyway and say so: silently rendering "(none)" would tell the
    // operator the plan has no repo when it very much does.
    if (current.length > 0 && !options.some((r) => r.id === current)) {
        const orphan = document.createElement('option');
        orphan.value = current;
        orphan.textContent = `${current} — not in this project's repos`;
        select.appendChild(orphan);
    }
    select.value = current;

    select.addEventListener('change', () => {
        const next = select.value;
        void (async () => {
            try {
                await sendCommandOrThrow({
                    type: 'SetPlanRepo',
                    actor: 'operator',
                    issuedAt: Date.now(),
                    payload: { planId: plan.planId, repoId: next },
                });
                showToast({
                    message: next.length > 0
                        ? `${plan.planId} now targets ${next}.`
                        : `${plan.planId} no longer has a target repo.`,
                    kind: 'success',
                });
            } catch (err) {
                // Put the dropdown back so it never shows a repo the plan
                // does not actually have.
                select.value = current;
                showToast({
                    message: err instanceof Error ? err.message : String(err),
                    kind: 'error',
                });
            }
        })();
    });
    section.appendChild(select);
    return section;
}

function buildPlanModalBody(plan: PlanRow): HTMLElement[] {
    const children: HTMLElement[] = [];

    // Header chips: project, type, archived flag.
    const chips = document.createElement('div');
    chips.className = 'plan-modal__chips';
    const pieces: string[] = [];
    const projName = projectNameFor(plan.projectId);
    if (projName) pieces.push(projName);
    const type = planType(plan);
    if (type) pieces.push(type);
    if (plan.archivedAt !== null) pieces.push('archived');
    // Created date last: it is the least-changing fact on the row, and
    // the operator scans for status/type first.
    const planCreated = createdChip(plan.createdAt);
    if (planCreated !== null) {
        pieces.push(planCreated);
        const tip = createdTooltip(plan.createdAt);
        if (tip !== null) chips.title = tip;
    }
    chips.textContent = pieces.join(' · ');
    children.push(chips);

    // Target repo, right under the header: which codebase this plan's
    // tasks will run against is the first thing worth checking, and it
    // used to be invisible outside the edit form.
    children.push(buildPlanRepoSection(plan));

    // Durable planner failure (metadata.plannerError) — mirrors the draft
    // card's error line so the modal explains why there's no plan yet.
    const modalPlannerError = (plan.metadata as { plannerError?: unknown }).plannerError;
    if (typeof modalPlannerError === 'string' && modalPlannerError.length > 0) {
        const errEl = document.createElement('p');
        errEl.className = 'plan-modal__planner-error';
        errEl.textContent = `Planner failed: ${modalPlannerError}`;
        children.push(errEl);
    }

    // The request AND the plan, in that order. The planner output
    // used to REPLACE the brief, so the moment a plan went Ready the
    // request it was built from vanished from the one screen where
    // you decide whether the plan answers it. Which sections appear
    // is plan-body-sections.ts, and tested there.
    const plannerOutput = planReviewContent.get(plan.planId);
    for (const section of planBodySections(plannerOutput, plan.body)) {
        const bodySection = document.createElement('section');
        bodySection.className
            = `plan-modal__plan-body plan-modal__plan-body--${section.kind}`;

        // A long pasted request collapses so it cannot push the
        // plan - the thing under review - off the screen. A short
        // one stays open, which is the whole point of showing it.
        const collapse = section.kind === 'request'
            && shouldCollapseRequest(plan.body);
        const host = collapse
            ? document.createElement('details')
            : bodySection;
        if (collapse) {
            const details = host as HTMLDetailsElement;
            // Survive the rebuild the next SSE tick will trigger.
            details.open = planRequestOpen.has(plan.planId);
            details.addEventListener('toggle', () => {
                if (details.open) planRequestOpen.add(plan.planId);
                else planRequestOpen.delete(plan.planId);
            });
            const summary = document.createElement('summary');
            summary.className = 'plan-modal__request-summary';
            summary.textContent = section.heading;
            host.appendChild(summary);
        } else {
            const heading = document.createElement('h4');
            heading.textContent = section.heading;
            host.appendChild(heading);
        }
        for (const node of renderMarkdown(section.markdown)) {
            host.appendChild(node);
        }
        if (collapse) bodySection.appendChild(host);
        children.push(bodySection);
    }

    // Attachments — sequence diagrams / specs / mockups attached to the
    // plan. Plan-level attachments also feed the decomposer (Phase 3), so
    // a diagram pinned here informs how the plan is broken into tasks.
    children.push(buildAttachmentsSection('plan', plan.planId));

    // Tasks belonging to this plan, sorted by id. Computed once and reused
    // by both the dependency graph and the task list below.
    const planTasks = Array.from(tasks.values())
        .filter((t) => t.planId === plan.planId)
        .sort((a, b) => a.taskId.localeCompare(b.taskId));

    // Dependency graph — a visual DAG of this plan's tasks and their
    // declared dependencies, colored by status. Rendered client-side via
    // the Mermaid global (loaded in index.html); degrades to a text edge
    // list when Mermaid is unavailable (offline / blocked) and is omitted
    // entirely when the plan has no inter-task edges to draw.
    const depGraph = buildDepGraphSection(planTasks);
    if (depGraph) children.push(depGraph);

    // Impact-check warnings (advisory, from the post-decompose scan):
    // files that reference a type this plan modifies but that no task
    // touches. Rendered ABOVE the task list so the operator reviews the
    // candidate misses before approving tasks — the fix is one click
    // away via "+ Add task".
    const impactSection = buildImpactWarningsSection(plan);
    if (impactSection) children.push(impactSection);

    // Tasks: every task whose planId matches, rendered with the same
    // renderTaskCard the top-level Tasks section uses. The card stays
    // fully interactive (Approve / Cancel / Retry / Merge PR / chip
    // clicks all wire through the same delegated handlers).
    const tasksSection = document.createElement('section');
    tasksSection.className = 'plan-modal__tasks';
    const taskHeadingRow = document.createElement('div');
    taskHeadingRow.className = 'plan-modal__tasks-heading';
    const taskHeading = document.createElement('h4');
    taskHeading.textContent = 'Tasks';
    taskHeadingRow.appendChild(taskHeading);
    // Operator escape hatch: when the planner/decomposer missed a piece
    // of work, a task can be appended to the plan by hand. Archived
    // plans are read-only (their tasks are hidden from the board), so
    // the affordance is omitted there.
    if (plan.archivedAt === null) {
        const addBtn = document.createElement('button');
        addBtn.type = 'button';
        addBtn.className = 'plan-modal__add-task-btn';
        addBtn.setAttribute('data-add-task', '');
        addBtn.textContent = '+ Add task';
        addBtn.addEventListener('click', () => openAddTaskModal(plan, planTasks));
        taskHeadingRow.appendChild(addBtn);
    }
    tasksSection.appendChild(taskHeadingRow);
    if (planTasks.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'plan-modal__tasks-empty';
        empty.textContent = '(no tasks decomposed yet)';
        tasksSection.appendChild(empty);
    } else {
        const list = document.createElement('ul');
        list.className = 'plan-modal__task-list';
        for (const task of planTasks) {
            list.appendChild(renderTaskCard(task));
        }
        tasksSection.appendChild(list);
    }
    children.push(tasksSection);

    // Ready plans expose Feedback + Regenerate inside the modal so the
    // operator can iterate on the planner draft without cluttering the
    // card grid. Clicking Regenerate dispatches the planner again,
    // closes the modal, and the plan flips back into Active planners
    // until the next PlanGenerated arrives. The classifier hides the
    // plan from every lifecycle bucket while the planner is running.
    if (classifyPlan(plan) === 'ready') {
        const regenSection = document.createElement('section');
        regenSection.className = 'plan-modal__regenerate';
        const regenHeading = document.createElement('h4');
        regenHeading.textContent = 'Regenerate plan';
        regenSection.appendChild(regenHeading);

        const feedback = document.createElement('textarea');
        feedback.className = 'plan-modal__regenerate-feedback';
        feedback.placeholder = 'Feedback for the planner (optional)';
        feedback.rows = 3;
        regenSection.appendChild(feedback);

        const buttonRow = document.createElement('div');
        buttonRow.className = 'plan-modal__regenerate-actions';
        const regenerateBtn = document.createElement('button');
        regenerateBtn.type = 'button';
        regenerateBtn.className = 'plan-modal__regenerate-btn';
        regenerateBtn.textContent = 'Regenerate';
        regenerateBtn.addEventListener('click', async () => {
            const ok = await runRegenerateForPlan(plan, feedback.value, regenerateBtn);
            // Close on success so the next SSE tick can reclassify the
            // plan into Active planners without the modal showing stale
            // ready-mode controls against a now-in-flight plan.
            if (ok) closePlanModal();
        });
        buttonRow.appendChild(regenerateBtn);
        regenSection.appendChild(buttonRow);

        children.push(regenSection);
    }

    return children;
}

/**
 * Build the "Impact check" section from `plan.metadata.impactWarnings`
 * (attached by the orchestrator's post-decompose scan via a PlanUpdated
 * metadata merge). Returns null when the plan has no warnings — the
 * common, quiet case. `impactWarningsTotal` may exceed the persisted
 * list (the orchestrator caps what it stores); the header says so.
 */
function buildImpactWarningsSection(plan: PlanRow): HTMLElement | null {
    const raw = plan.metadata?.impactWarnings;
    if (!Array.isArray(raw) || raw.length === 0) return null;
    const warnings = raw.filter(
        (w): w is { changedFile: string; typeName: string; referencingFile: string } =>
            !!w && typeof w === 'object'
            && typeof (w as Record<string, unknown>).changedFile === 'string'
            && typeof (w as Record<string, unknown>).referencingFile === 'string',
    );
    if (warnings.length === 0) return null;
    const totalRaw = plan.metadata?.impactWarningsTotal;
    const total = typeof totalRaw === 'number' && totalRaw > warnings.length
        ? totalRaw
        : warnings.length;

    const section = document.createElement('section');
    section.className = 'plan-modal__impact';
    const heading = document.createElement('h4');
    heading.textContent = `⚠ Impact check — ${total} untouched reference${total === 1 ? '' : 's'}`;
    section.appendChild(heading);
    const intro = document.createElement('p');
    intro.className = 'plan-modal__impact-intro';
    intro.textContent
        = 'These files reference types this plan modifies, but no task touches '
        + 'them. Review whether any needs a task (see "+ Add task" below) — '
        + 'or ignore the ones that need no edit.';
    section.appendChild(intro);
    const list = document.createElement('ul');
    list.className = 'plan-modal__impact-list';
    for (const w of warnings) {
        const li = document.createElement('li');
        const ref = document.createElement('code');
        ref.textContent = w.referencingFile;
        li.appendChild(ref);
        const rest = document.createElement('span');
        rest.textContent = ` references ${typeof w.typeName === 'string' ? w.typeName : '?'} (modified in ${w.changedFile})`;
        li.appendChild(rest);
        list.appendChild(li);
    }
    if (total > warnings.length) {
        const li = document.createElement('li');
        li.className = 'plan-modal__impact-more';
        li.textContent = `… and ${total - warnings.length} more (see worker log)`;
        list.appendChild(li);
    }
    section.appendChild(list);
    return section;
}

// --- Task dependency graph (Mermaid) ----------------------------------
//
// Mermaid is loaded as a plain <script> in index.html and kept OUT of the
// esbuild bundle so board.js stays lean. We reach it through the window
// global lazily (only when a plan modal opens) and degrade gracefully to a
// text edge-list when it is unavailable — a blocked/offline CDN, or a
// future vendored copy that failed to load — so the modal never breaks.
interface MermaidGlobal {
    initialize(config: Record<string, unknown>): void;
    render(id: string, text: string): Promise<{ svg: string }>;
}

function getMermaid(): MermaidGlobal | null {
    const m = (window as unknown as { mermaid?: MermaidGlobal }).mermaid;
    return m && typeof m.render === 'function' ? m : null;
}

let mermaidInitialized = false;
let depGraphSeq = 0;

/**
 * Build the "Dependency graph" section for a plan modal. Returns null when
 * there is nothing worth drawing — no tasks, or no edges *between* this
 * plan's tasks (an unconnected pile of nodes is noise, and the task list
 * below already shows them). The heavy render is fired asynchronously into
 * the returned section's canvas so `buildPlanModalBody` stays synchronous.
 */
function buildDepGraphSection(planTasks: readonly TaskRow[]): HTMLElement | null {
    if (planTasks.length === 0) return null;
    // Only edges whose BOTH endpoints are tasks in this plan (pure helper).
    const edges = computeDepEdges(planTasks);
    if (edges.length === 0) return null;

    const section = document.createElement('section');
    section.className = 'plan-modal__depgraph';
    const heading = document.createElement('h4');
    heading.textContent = 'Dependency graph';
    section.appendChild(heading);
    section.appendChild(buildDepGraphLegend());

    const canvas = document.createElement('div');
    canvas.className = 'plan-modal__depgraph-canvas';
    canvas.setAttribute('data-depgraph-canvas', '');
    const loading = document.createElement('p');
    loading.className = 'plan-modal__depgraph-loading';
    loading.textContent = 'Rendering graph…';
    canvas.appendChild(loading);
    section.appendChild(canvas);

    void renderDepGraphInto(canvas, planTasks, edges);
    return section;
}

/**
 * Render a Mermaid definition into `container` as SVG. On any failure — Mermaid
 * not loaded (offline / blocked CDN) or a parse/render error — replace the
 * container with `fallback()` so the surface degrades instead of breaking.
 * Shared by the plan dependency graph and the Markdown ```mermaid fences.
 */
async function renderMermaidInto(
    container: HTMLElement,
    def: string,
    fallback: () => Node,
): Promise<void> {
    const mermaid = getMermaid();
    if (!mermaid) {
        container.replaceChildren(fallback());
        return;
    }
    try {
        if (!mermaidInitialized) {
            // securityLevel 'strict' — we render trusted, self-built or
            // committed-doc defs, but strict blocks any markup that slips
            // through from injecting. htmlLabels off keeps labels as plain
            // SVG text (no HTML entity surprises).
            mermaid.initialize({
                startOnLoad: false,
                theme: 'dark',
                securityLevel: 'strict',
                flowchart: { htmlLabels: false, curve: 'basis' },
            });
            mermaidInitialized = true;
        }
        // Repair the recurring LLM syntax slip (bare `;` in labels /
        // messages) before parsing, so design docs stored before the
        // capture-time sanitizer still render.
        const { svg } = await mermaid.render(
            `mermaid-svg-${depGraphSeq++}`,
            sanitizeMermaidSource(def),
        );
        container.innerHTML = svg;
    } catch (err) {
        // eslint-disable-next-line no-console
        console.error('board-ui: mermaid render failed', err);
        container.replaceChildren(fallback());
    }
}

async function renderDepGraphInto(
    canvas: HTMLElement,
    planTasks: readonly TaskRow[],
    edges: ReadonlyArray<readonly [string, string]>,
): Promise<void> {
    const def = buildMermaidFlowchart(planTasks, edges);
    await renderMermaidInto(canvas, def, () => buildDepGraphFallback(edges));
}

function buildDepGraphLegend(): HTMLElement {
    const legend = document.createElement('div');
    legend.className = 'plan-modal__depgraph-legend';
    const items: Array<[string, string]> = [
        ['done', 'done'],
        ['running', 'in progress'],
        ['blocked', 'blocked'],
        ['failed', 'failed'],
        ['skipped', 'skipped'],
        ['todo', 'todo'],
    ];
    for (const [cls, label] of items) {
        const item = document.createElement('span');
        item.className = `depgraph-legend__item depgraph-legend__item--${cls}`;
        item.textContent = label;
        legend.appendChild(item);
    }
    return legend;
}

/** Text fallback when Mermaid can't render (offline / blocked / error). */
function buildDepGraphFallback(
    edges: ReadonlyArray<readonly [string, string]>,
): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'plan-modal__depgraph-fallback';
    const note = document.createElement('p');
    note.textContent = 'Graph view unavailable — task dependencies:';
    wrap.appendChild(note);
    const ul = document.createElement('ul');
    for (const [from, to] of edges) {
        const li = document.createElement('li');
        li.textContent = `${from} → ${to}`;
        ul.appendChild(li);
    }
    wrap.appendChild(ul);
    return wrap;
}

// --- Task modal: focused details view for a single task ---------------
//
// Mirrors the plan modal pattern: a single shared overlay reused across
// every task click; opened with `openTaskModal(taskId)`, refreshed on
// every render tick via `refreshTaskModal()` so live progress (status
// flips, parked-reason changes, new step summaries) reflects without a
// close/reopen. Closes defensively when the task vanishes from the
// in-memory Map (re-decompose path wipes the row).
const TASK_MODAL_OVERLAY_ID = 'task-modal';
let taskModalBackdrop: HTMLElement | null = null;
let taskModalTaskId: string | null = null;
/**
 * In-flight instructions textarea edit (migration 022). The task modal
 * re-renders on every SSE tick, so this preserves the operator's typing
 * across a re-render the same way the plan modal caches its feedback edit.
 * Cleared on Save, modal close, and task switch.
 */
let pendingInstructionsEdit: { taskId: string; value: string } | null = null;

/**
 * Build the "Instructions / remarks" section for the task modal. Editable
 * (textarea + Save) while the task hasn't started; read-only afterwards
 * (the text is already baked into the agent's brief). Carries no state that
 * a re-render would lose — in-flight typing lives in
 * {@link pendingInstructionsEdit}.
 */
function buildTaskInstructionsSection(task: TaskRow): HTMLElement {
    const section = document.createElement('section');
    section.className = 'task-modal__instructions';
    const heading = document.createElement('h4');
    heading.textContent = 'Instructions / remarks';
    section.appendChild(heading);

    const stored = task.instructions ?? '';
    const hasStepRuns = (taskStepRuns.get(task.taskId)?.size ?? 0) > 0;
    const editability = {
        status: task.status,
        parkedReason: task.parkedReason,
        hasStepRuns,
    };

    if (!canEditTaskInstructions(editability)) {
        // Read-only only while an agent actually holds the brief, or once
        // the task is terminal. A HALTED task stays editable — see
        // `instructions-editability.ts`.
        const note = document.createElement('p');
        note.className = 'task-modal__instructions-note';
        const state = task.status === 'done'
            || task.status === 'skipped'
            || task.status === 'archived'
            ? 'This task is finished'
            : 'An agent is working on this task right now';
        note.textContent = stored.length > 0
            ? `${state} — these instructions were included in its brief.`
            : `${state} — stop it first if you need to change its instructions.`;
        section.appendChild(note);
        if (stored.length > 0) {
            const ro = document.createElement('div');
            ro.className = 'task-modal__instructions-readonly';
            ro.textContent = stored;
            section.appendChild(ro);
        }
        return section;
    }

    const hint = document.createElement('p');
    hint.className = 'task-modal__instructions-hint';
    // Say what the save will actually do. On a halted task the operator
    // has just stopped an agent and wants to redirect it; "added before it
    // starts" reads as "too late for this one", which is exactly wrong.
    hint.textContent = instructionsApplyToRerun(editability)
        ? 'Added to the agent’s brief on the NEXT run — save, then click '
          + 'Retry below to re-run this task with them.'
        : 'Added to the agent’s brief before it starts — e.g. "reuse the '
          + 'existing FooService, don’t add a new DI registration".';
    section.appendChild(hint);

    const textarea = document.createElement('textarea');
    textarea.className = 'task-modal__instructions-input';
    textarea.rows = 4;
    textarea.placeholder = 'Instructions or remarks for the agent…';
    const cached = pendingInstructionsEdit && pendingInstructionsEdit.taskId === task.taskId
        ? pendingInstructionsEdit.value
        : null;
    textarea.value = cached !== null ? cached : stored;
    textarea.addEventListener('input', () => {
        pendingInstructionsEdit = { taskId: task.taskId, value: textarea.value };
    });
    section.appendChild(textarea);

    const actions = document.createElement('div');
    actions.className = 'task-modal__instructions-actions';
    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'task-modal__instructions-save';
    saveBtn.textContent = 'Save instructions';
    saveBtn.addEventListener('click', () => {
        const value = textarea.value;
        void sendCommand({
            type: 'SetTaskInstructions',
            actor: 'operator',
            issuedAt: Date.now(),
            payload: { taskId: task.taskId, instructions: value },
        });
        // Drop the cache so the next render seeds from the SSE-updated row.
        pendingInstructionsEdit = null;
        showToast({ message: 'Instructions saved.', kind: 'success' });
    });
    actions.appendChild(saveBtn);
    section.appendChild(actions);
    return section;
}

function openTaskModal(taskId: string): void {
    if (taskModalBackdrop !== null) closeTaskModal();
    taskModalTaskId = taskId;
    const root = ensureOverlayRoot();
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-chrome__overlay';
    backdrop.setAttribute('data-task-modal-overlay', '');
    // Clicking the backdrop (outside the panel) closes the modal —
    // matches the plan modal's affordance.
    backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) closeTaskModal();
    });

    const panel = document.createElement('div');
    panel.className = 'task-modal modal-chrome';
    panel.setAttribute('data-task-modal', '');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-labelledby', 'task-modal-title');
    panel.setAttribute('data-task-id', taskId);

    const header = document.createElement('div');
    header.className = 'modal-chrome__header';
    const title = document.createElement('h3');
    title.className = 'modal-chrome__title';
    title.id = 'task-modal-title';
    title.setAttribute('data-task-modal-title', '');
    header.appendChild(title);
    const closeBtn = document.createElement('button');
    closeBtn.className = 'modal-chrome__close';
    closeBtn.type = 'button';
    closeBtn.textContent = 'Close';
    closeBtn.addEventListener('click', closeTaskModal);
    header.appendChild(closeBtn);
    panel.appendChild(header);

    const body = document.createElement('div');
    body.className = 'modal-chrome__body task-modal__body';
    body.setAttribute('data-task-modal-body', '');
    panel.appendChild(body);

    backdrop.appendChild(panel);
    root.appendChild(backdrop);
    overlayManager.openOverlay(TASK_MODAL_OVERLAY_ID, panel);
    taskModalBackdrop = backdrop;
    // Fresh modal → drop any stale in-flight instructions edit from a
    // previously-open task.
    pendingInstructionsEdit = null;
    currentAttachTarget = { ownerType: 'task', ownerId: taskId };
    void fetchAttachmentList('task', taskId);
    // Produced files come from a second request rather than one
    // unfiltered list: the two sections are keyed separately, so a single
    // response would have to be split client-side anyway.
    void fetchAttachmentList('task', taskId, 'output');
    void ensureTaskDetail(taskId);
    refreshTaskModal();
}

/**
 * Task ids whose detail fetch has been issued, so a modal reopened before
 * the first response lands does not fire a second request.
 */
const taskDetailFetched = new Set<string>();

/**
 * Pull `description` + `ticketDetails` for a task the hydration payload
 * withheld them from.
 *
 * `/api/tasks` omits both for CLOSED tasks — measured on a live board at
 * 2.3 MB of a 3.0 MB response, for prose no card renders and 1324 of
 * 1385 tasks that were done or skipped. Active tasks keep theirs inline,
 * so the tasks the operator actually opens need no round-trip; this only
 * fires on a finished task's modal.
 */
async function ensureTaskDetail(taskId: string): Promise<void> {
    const task = tasks.get(taskId);
    if (!task || !task.detailOmitted) return;
    if (taskDetailFetched.has(taskId)) return;
    taskDetailFetched.add(taskId);
    try {
        const res = await fetch(`${API_BASE}/api/tasks/${encodeURIComponent(taskId)}/detail`);
        if (!res.ok) {
            // Allow a retry on the next open rather than leaving the
            // modal permanently blank after one bad response.
            taskDetailFetched.delete(taskId);
            return;
        }
        const body = (await res.json()) as {
            description?: unknown;
            ticketDetails?: unknown;
        };
        const row = tasks.get(taskId);
        if (!row) return;
        if (typeof body.description === 'string') row.description = body.description;
        if (body.ticketDetails && typeof body.ticketDetails === 'object') {
            row.ticketDetails = body.ticketDetails as typeof row.ticketDetails;
        }
        // Cleared so the modal stops showing the "loading" line and the
        // fields render as if they had been hydrated all along.
        row.detailOmitted = false;
        refreshTaskModal();
    } catch {
        taskDetailFetched.delete(taskId);
    }
}

function closeTaskModal(): void {
    if (taskModalBackdrop === null) return;
    overlayManager.closeOverlay(TASK_MODAL_OVERLAY_ID);
    taskModalBackdrop.remove();
    taskModalBackdrop = null;
    taskModalTaskId = null;
    pendingInstructionsEdit = null;
    if (currentAttachTarget?.ownerType === 'task') currentAttachTarget = null;
}

function refreshTaskModal(): void {
    if (taskModalBackdrop === null || taskModalTaskId === null) return;
    const task = tasks.get(taskModalTaskId);
    if (!task) {
        // Task vanished — re-decompose path wiped it. Close defensively.
        closeTaskModal();
        return;
    }
    const titleEl = taskModalBackdrop.querySelector(
        '[data-task-modal-title]',
    ) as HTMLElement | null;
    if (titleEl) {
        titleEl.textContent = task.title
            ? `${task.taskId} — ${task.title}`
            : task.taskId;
    }
    const bodyEl = taskModalBackdrop.querySelector(
        '[data-task-modal-body]',
    ) as HTMLElement | null;
    if (!bodyEl) return;

    // This body is rebuilt wholesale on every SSE tick, and a running task
    // ticks often. Skip the rebuild while the operator is typing in it —
    // the Instructions textarea used to lose focus several times a
    // sentence, because `replaceChildren` destroys the focused node and
    // focus falls back to <body>. `pendingInstructionsEdit` kept the TEXT
    // across that, which is why the field looked fine and the keystrokes
    // still went nowhere.
    if (isOperatorEditingIn(bodyEl, document.activeElement)) return;

    const children: HTMLElement[] = [];

    // Header chips — status, type, project, parked reason if any.
    const chips = document.createElement('div');
    chips.className = 'task-modal__chips';
    const chipPieces: string[] = [];
    if (task.status) chipPieces.push(task.status);
    if (task.type) chipPieces.push(task.type);
    const projName = task.projectId ? projectNameFor(task.projectId) : '';
    if (projName) chipPieces.push(projName);
    if (task.parkedReason) chipPieces.push(parkedChipLabel(task.parkedReason));
    const taskCreated = createdChip(task.createdAt);
    if (taskCreated !== null) {
        chipPieces.push(taskCreated);
        const tip = createdTooltip(task.createdAt);
        if (tip !== null) chips.title = tip;
    }
    chips.textContent = chipPieces.join(' · ');
    children.push(chips);

    // Ticket layout: Goal → Technical impact → Acceptance criteria →
    // Implementation brief (the untouched decomposer description).
    // Tasks decomposed before the structured fields were persisted have
    // ticketDetails === null and render the plain description exactly
    // as before.
    const ticket = task.ticketDetails;
    if (ticket?.goal) {
        const goalSection = document.createElement('section');
        goalSection.className = 'task-modal__goal';
        const heading = document.createElement('h4');
        heading.textContent = 'Goal';
        goalSection.appendChild(heading);
        const p = document.createElement('p');
        p.className = 'task-modal__goal-text';
        p.textContent = ticket.goal;
        goalSection.appendChild(p);
        children.push(goalSection);
    }
    const fileGroups: Array<[string, string[] | undefined]> = [
        ['Create', ticket?.filesToCreate],
        ['Modify', ticket?.filesToModify],
        ['Delete', ticket?.filesToDelete],
    ];
    if (fileGroups.some(([, files]) => (files?.length ?? 0) > 0)) {
        const impactSection = document.createElement('section');
        impactSection.className = 'task-modal__impact';
        const heading = document.createElement('h4');
        heading.textContent = 'Technical impact';
        impactSection.appendChild(heading);
        for (const [label, files] of fileGroups) {
            if (!files || files.length === 0) continue;
            const group = document.createElement('div');
            group.className = 'task-modal__impact-group';
            const tag = document.createElement('span');
            tag.className = `task-modal__impact-tag task-modal__impact-tag--${label.toLowerCase()}`;
            tag.textContent = label;
            group.appendChild(tag);
            const chipsWrap = document.createElement('span');
            chipsWrap.className = 'task-modal__impact-files';
            for (const f of files) {
                const chip = document.createElement('code');
                chip.className = 'task-modal__impact-file';
                chip.textContent = f;
                chipsWrap.appendChild(chip);
            }
            group.appendChild(chipsWrap);
            impactSection.appendChild(group);
        }
        children.push(impactSection);
    }
    if (ticket?.acceptanceCriteria && ticket.acceptanceCriteria.length > 0) {
        const acSection = document.createElement('section');
        acSection.className = 'task-modal__acceptance';
        const heading = document.createElement('h4');
        heading.textContent = 'Acceptance criteria';
        acSection.appendChild(heading);
        const list = document.createElement('ul');
        list.className = 'task-modal__acceptance-list';
        for (const c of ticket.acceptanceCriteria) {
            const li = document.createElement('li');
            li.className = 'task-modal__acceptance-item';
            li.textContent = c;
            list.appendChild(li);
        }
        acSection.appendChild(list);
        children.push(acSection);
    }
    // Test commands — the decomposer's scoped verification for THIS task,
    // the same list TASK.md hands the tester. Surfaced so the operator can
    // see what will actually run before approving, and spot a
    // whole-suite command before it costs two runs of it.
    if (ticket?.testCommands && ticket.testCommands.length > 0) {
        const testSection = document.createElement('section');
        testSection.className = 'task-modal__test-commands';
        const heading = document.createElement('h4');
        heading.textContent = 'Test commands';
        testSection.appendChild(heading);
        const list = document.createElement('ul');
        list.className = 'task-modal__test-commands-list';
        for (const c of ticket.testCommands) {
            const li = document.createElement('li');
            const code = document.createElement('code');
            code.textContent = c;
            li.appendChild(code);
            list.appendChild(li);
        }
        testSection.appendChild(list);
        children.push(testSection);
    }
    // The brief was withheld from hydration (closed task) and its fetch
    // has not landed yet. Say so — a silently empty modal reads as "this
    // task had no description", which for a finished task is a plausible
    // enough lie that the operator would believe it.
    if (task.detailOmitted) {
        const pending = document.createElement('p');
        pending.className = 'task-modal__detail-pending';
        pending.textContent = 'Loading the full brief…';
        children.push(pending);
    }
    // Description — full markdown body, verbatim (labelled as the
    // implementation brief when the structured sections are present).
    if (task.description && task.description.length > 0) {
        const descSection = document.createElement('section');
        descSection.className = 'task-modal__description';
        const heading = document.createElement('h4');
        heading.textContent = ticket ? 'Implementation brief' : 'Description';
        descSection.appendChild(heading);
        for (const node of renderMarkdown(task.description)) {
            descSection.appendChild(node);
        }
        children.push(descSection);
    }

    // Instructions / remarks — operator guidance folded into the agent's
    // brief before the task starts (migration 022). Editable while pending.
    children.push(buildTaskInstructionsSection(task));

    // Rejection — what the operator said and when it stops mattering.
    // Nothing surfaced this before: the reason was dropped on dispatch, so
    // there was nothing to show, and once it IS stored a task that failed
    // for an operator reason looked identical to one that failed on its
    // own. The same text reaches the agent as `# Feedback to address` on
    // Retry, so showing it here is also showing what the retry will act on.
    const rejection = (task.feedback ?? '').trim();
    if (rejection.length > 0) {
        const section = document.createElement('section');
        section.className = 'task-modal__rejection';
        const heading = document.createElement('h4');
        heading.textContent = 'Rejected';
        section.appendChild(heading);
        const note = document.createElement('p');
        note.className = 'task-modal__rejection-note';
        note.textContent = task.status === 'failed'
            ? 'You rejected this task with the reason below. Retry re-runs it '
              + 'with this as the agent’s feedback.'
            : 'Rejection reason from an earlier round — the agent has it as '
              + 'feedback.';
        section.appendChild(note);
        const body = document.createElement('div');
        body.className = 'task-modal__rejection-reason';
        body.textContent = rejection;
        section.appendChild(body);
        children.push(section);
    }

    // Attachments — screenshots / mockups / specs the operator pinned to
    // the task. Sits near the top so a "here's what went wrong" image is
    // visible without scrolling past the pipeline steps.
    children.push(buildAttachmentsSection('task', task.taskId));
    // Produced files sit directly under the operator's own attachments:
    // same card, opposite direction. Hidden until the task has any.
    children.push(buildTaskOutputsSection(task.taskId));

    // Parked status — visible only when the task is in a parked state.
    if (task.parkedReason) {
        const parkedSection = document.createElement('section');
        parkedSection.className = 'task-modal__parked';
        const heading = document.createElement('h4');
        heading.textContent = 'Awaiting operator';
        parkedSection.appendChild(heading);
        const summary = document.createElement('p');
        summary.className = 'task-modal__parked-summary';
        const reasonLabel = parkedChipLabel(task.parkedReason);
        summary.textContent = task.parkedStepId
            ? `${reasonLabel} at step "${task.parkedStepId}".`
            : reasonLabel;
        parkedSection.appendChild(summary);
        if (task.parkedQuestion) {
            const q = document.createElement('p');
            q.className = 'task-modal__parked-question';
            q.textContent = task.parkedQuestion;
            parkedSection.appendChild(q);
        }
        children.push(parkedSection);
    }

    // Steps section — one row per pipeline stage with status + summary
    // preview. Clicking a row opens the existing per-step summary modal
    // so the operator can dive into the transcript without leaving the
    // task modal closed forever.
    const stepsSection = document.createElement('section');
    stepsSection.className = 'task-modal__steps';
    const stepsHeading = document.createElement('h4');
    stepsHeading.textContent = 'Pipeline steps';
    stepsSection.appendChild(stepsHeading);
    const stepRows = renderTaskModalStepRows(task);
    if (stepRows.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'task-modal__steps-empty';
        empty.textContent = '(no agent activity yet)';
        stepsSection.appendChild(empty);
    } else {
        const list = document.createElement('ul');
        list.className = 'task-modal__step-list';
        for (const row of stepRows) list.appendChild(row);
        stepsSection.appendChild(list);
    }
    children.push(stepsSection);

    // PR section — visible once the post-commit hook opens a PR.
    if (task.prUrl) {
        const prSection = document.createElement('section');
        prSection.className = 'task-modal__pr';
        const heading = document.createElement('h4');
        heading.textContent = 'Pull request';
        prSection.appendChild(heading);
        const link = document.createElement('a');
        link.className = 'task-modal__pr-link';
        link.href = task.prUrl;
        link.textContent = task.prNumber !== null
            ? `#${task.prNumber} — ${task.prUrl}`
            : task.prUrl;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        prSection.appendChild(link);
        children.push(prSection);
    }

    // Actions section — reuse the same per-state visibility logic the
    // task card uses. We render a fresh button row and run pruneTaskActions
    // against a fragment that holds the template's `.task-actions`, then
    // mount what survives into the modal. Clicks on each button route
    // through the existing onTaskAction handler.
    const actionsSection = document.createElement('section');
    actionsSection.className = 'task-modal__actions';
    const actionsHeading = document.createElement('h4');
    actionsHeading.textContent = 'Actions';
    actionsSection.appendChild(actionsHeading);
    const actionsRow = buildTaskModalActions(task);
    actionsSection.appendChild(actionsRow);
    children.push(actionsSection);

    // `.task-modal__body` is the scroller (max-height 80vh, overflow
    // auto), so replacing its children drops scrollTop to 0. Without this
    // the modal jumped back on every tick and a long task could not be
    // read while its agent ran.
    rebuildPreservingScroll(bodyEl, () => {
        bodyEl.replaceChildren(...children);
    });
}

/**
 * Build the per-step row list shown in the task modal.
 *
 * Steps come from the hydrated FLOW-STAGE CATALOG for this task's flow —
 * the same source the card's stage bar uses (`stagesForTask`). It used to
 * iterate a hardcoded dev → review → test → commit list, so a document,
 * deploy, investigate or review task opened on four steps it does not
 * have while the card right behind it showed the real ones (operator
 * report). A flow whose catalog entry is missing (unknown id, or the
 * hydration fetch failed) falls back to the recorded steps for the task,
 * so the modal shows what actually ran rather than a wrong fixed strip.
 */
function renderTaskModalStepRows(task: TaskRow): HTMLElement[] {
    const stepMap = taskStepRuns.get(task.taskId);
    const rows: HTMLElement[] = [];
    // The flow's own ordered steps. Empty catalog → fall back to whatever
    // this task actually recorded, so the list is never silently wrong.
    const stages = stagesForTask(task);
    const steps: ReadonlyArray<{ stepId: string; label: string; agent?: string; kind?: string }>
        = stages.length > 0
            ? stages.map((st) => ({
                stepId: st.stepId,
                label: st.label || st.stepId,
                agent: st.agent,
                kind: st.kind,
            }))
            : [...(stepMap?.keys() ?? [])].map((stepId) => ({ stepId, label: stepId }));
    const allStepIds = steps.map((st) => st.stepId);
    const recordedStepIds = new Set<string>([...(stepMap?.keys() ?? [])]);
    for (const step of steps) {
        const stepId = step.stepId;
        const rec = stepMap?.get(stepId);
        const li = document.createElement('li');
        li.className = 'task-modal__step';
        const label = document.createElement('span');
        label.className = 'task-modal__step-label';
        label.textContent = step.label;
        li.appendChild(label);
        const status = document.createElement('span');
        status.className = 'task-modal__step-status';
        if (rec) {
            status.classList.add(`task-modal__step-status--${rec.status}`);
            status.textContent = rec.status;
        } else if (step.kind === 'gate') {
            // Gate steps run no agent, so "no record" does NOT mean
            // pending — an auto-merged task showed "Merge (auto): pending"
            // long after the PR had landed (operator report).
            const gs = gateStepState({
                agent: step.agent ?? '',
                allStepIds,
                stepId,
                recordedStepIds,
                taskStatus: task.status,
                parkedReason: task.parkedReason,
            });
            const label = gs === 'complete' ? 'complete' : gs === 'waiting' ? 'waiting' : 'pending';
            status.classList.add(`task-modal__step-status--${label}`);
            status.textContent = label;
        } else {
            status.classList.add('task-modal__step-status--pending');
            status.textContent = 'pending';
        }
        li.appendChild(status);
        if (rec && rec.summary) {
            const preview = document.createElement('p');
            preview.className = 'task-modal__step-summary';
            preview.textContent = rec.summary.length > 240
                ? rec.summary.slice(0, 240).trimEnd() + '…'
                : rec.summary;
            li.appendChild(preview);
        }
        // Clicking a row opens the per-step summary modal so the
        // operator can read the full transcript without losing the
        // task modal's context.
        if (rec) {
            li.classList.add('task-modal__step--clickable');
            li.addEventListener('click', () => {
                openTaskStepSummaryModal(task.taskId, stepId, rec);
            });
        }
        rows.push(li);
    }
    return rows;
}

/**
 * Build a fresh button row for the task modal's Actions section. Uses
 * the existing `pruneTaskActions` logic to decide which buttons stay
 * visible based on the task's current state; clicks route through the
 * same `onTaskAction` dispatcher the card uses, so behaviour matches
 * one-for-one.
 */
function buildTaskModalActions(task: TaskRow): HTMLElement {
    const row = document.createElement('div');
    row.className = 'task-modal__action-row task-actions';
    const actionDefs: ReadonlyArray<{ label: string; action: string }> = [
        { label: 'Approve', action: 'approve' },
        { label: 'Skip', action: 'skip' },
        { label: 'Retry', action: 'retry' },
        { label: 'Cancel', action: 'cancel' },
        { label: 'Merge PR', action: 'merge-pr' },
        { label: 'Dismiss', action: 'dismiss' },
        { label: 'Resume', action: 'resume' },
        { label: 'Review changes', action: 'human-review' },
        { label: 'Answer', action: 'answer-clarification' },
        { label: 'Show agent', action: 'show-agent' },
        { label: 'View report', action: 'view-report' },
    ];
    for (const def of actionDefs) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.setAttribute('data-action', def.action);
        btn.textContent = def.label;
        btn.addEventListener('click', () => onTaskAction(def.action, task));
        row.appendChild(btn);
    }
    // Re-use the card's pruning to hide buttons that don't apply to
    // the current state. We synthesize the same DocumentFragment shape
    // pruneTaskActions expects (a fragment with `.task-actions
    // button[data-action]` selectors) by wrapping the row in a
    // DocumentFragment temporarily — pruneTaskActions only reads, so a
    // direct visibility pass on the row's buttons matches its contract.
    applyTaskActionVisibility(row, task);
    return row;
}

/**
 * Mirror of `pruneTaskActions`'s visibility rules. Runs against the
 * task modal's button row (rather than a card-template fragment) so
 * the modal honours the same per-state action set as the card without
 * a refactor of the existing function.
 */
function applyTaskActionVisibility(row: HTMLElement, task: TaskRow): void {
    const setVisible = (action: string, visible: boolean): void => {
        const btn = row.querySelector(
            `button[data-action="${action}"]`,
        ) as HTMLButtonElement | null;
        if (!btn) return;
        btn.hidden = !visible;
    };
    const status = task.status || 'created';
    const parkedAtApproval = task.parkedReason === 'approval';
    const isDone = status === 'done';
    const isTerminal = isDone || status === 'skipped' || status === 'archived';
    const awaitingMerge = task.parkedReason === 'wait-merged' && !!task.prUrl;
    const inFlight = status === 'in_progress'
        || status === 'review'
        || status === 'test'
        || status === 'commit'
        || status === 'merge';
    const isParked = !!task.parkedReason;
    const isFailed = status === 'failed';
    const isCreated = status === 'created';

    if (isDone) {
        setVisible('approve', false);
        setVisible('skip', false);
        setVisible('retry', false);
        setVisible('cancel', false);
        setVisible('merge-pr', false);
        setVisible('resume', false);
        setVisible('human-review', false);
        setVisible('answer-clarification', false);
        setVisible('dismiss', true);
        setVisible('show-agent', taskAgents.has(task.taskId) || taskStepRuns.has(task.taskId));
        setVisible('view-report', taskHasReport(task));
        return;
    }

    setVisible('approve', isCreated && !parkedAtApproval && !awaitingMerge);
    setVisible('skip', isCreated && !parkedAtApproval && !awaitingMerge);
    setVisible('retry',
        !inFlight && !isCreated && !parkedAtApproval && !awaitingMerge);
    setVisible('cancel', !isTerminal);
    setVisible('merge-pr', awaitingMerge);
    setVisible('dismiss', isParked || isFailed);
    // Resume is hidden for parked reasons that have their own dedicated
    // affordance — Approve gate, Merge PR, Review changes, clarify Answer.
    const resumeOwnedByOtherUi = parkedAtApproval
        || awaitingMerge
        || task.parkedReason === 'clarification'
        || task.parkedReason === 'worktree-diff-review';
    setVisible('resume', isParked && !resumeOwnedByOtherUi);
    setVisible('human-review', task.parkedReason === 'worktree-diff-review');
    setVisible('answer-clarification', task.parkedReason === 'clarification');
    // Same gating as the card (injectTaskCardModalTriggers): Show agent
    // needs a real run to show, View report needs a report-producing
    // type with a recorded report and no agent still working.
    setVisible(
        'show-agent',
        !isCreated && (taskAgents.has(task.taskId) || taskStepRuns.has(task.taskId)),
    );
    setVisible('view-report', !inFlight && (isFailed || isTerminal) && taskHasReport(task));
}

// ----- per-plan fold state for the Tasks section ------------------------
//
// The flat task list is grouped by plan; each group heading toggles its
// tasks, and the header's "Collapse all / Expand all" button flips every
// group at once. The fold set is persisted so the constant SSE-driven
// re-renders — and page reloads — keep the operator's folds.

const COLLAPSED_TASK_PLANS_KEY = 'board:collapsedTaskPlans';

function loadCollapsedTaskPlans(): string[] {
    try {
        const raw = window.localStorage.getItem(COLLAPSED_TASK_PLANS_KEY);
        const parsed: unknown = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
    } catch {
        return [];
    }
}

const collapsedTaskPlans = new Set<string>(loadCollapsedTaskPlans());

function saveCollapsedTaskPlans(): void {
    try {
        window.localStorage.setItem(
            COLLAPSED_TASK_PLANS_KEY,
            JSON.stringify([...collapsedTaskPlans]),
        );
    } catch {
        /* private mode / quota — folds just won't survive a reload */
    }
}

function toggleTaskPlanFold(planKey: string): void {
    if (collapsedTaskPlans.has(planKey)) collapsedTaskPlans.delete(planKey);
    else collapsedTaskPlans.add(planKey);
    saveCollapsedTaskPlans();
    renderTasks();
}

function renderTasksFlat(): void {
    if (!taskTemplate) return;
    const listEl = document.querySelector(
        '#all-tasks [data-tasks]',
    ) as HTMLElement | null;
    if (!listEl) return;
    const countEl = document.querySelector(
        '#all-tasks [data-count-badge]',
    ) as HTMLElement | null;

    // The Tasks section is the operator's "what's running right now"
    // surface. Plan-status sections own the full lifecycle view (each
    // card opens a modal with every task on the plan), so this list
    // narrows to in-flight tasks: any task with status in_progress /
    // review / test / commit / merge OR any parked state. Finished /
    // skipped / draft (created without approval) tasks live behind the
    // plan card instead.
    const all = Array.from(tasks.values()).filter((t) => {
        // Project filter — the sidebar's "All projects" selector lets
        // the operator scope the board to a single project.
        if (!isVisibleForCurrentProject(projectIdForTask(t))) return false;
        // Archiving a plan means "not executing this" — its tasks
        // (whatever their state) don't belong on the active Tasks
        // surface. Unarchive the plan to bring them back.
        const parentPlan = t.planId ? plans.get(t.planId) : undefined;
        if (parentPlan && parentPlan.archivedAt !== null) return false;
        // Status/parked gating lives in ./task-visibility (pure +
        // tested). NOTE `failed` is INCLUDED: a failed task is exactly
        // what wants the operator's attention, and excluding it made a
        // reviewer-rejected task vanish from the board — only findable
        // by opening its project (field case DF-BRBS-014).
        return isActiveBoardTaskStatus(t.status, t.parkedReason);
    });
    if (countEl) countEl.textContent = all.length === 0 ? '' : String(all.length);
    toggleSectionVisible('all-tasks', all.length > 0);

    if (all.length === 0) {
        listEl.replaceChildren();
        return;
    }

    // Sort: planId asc, then taskId asc — keeps a decompose's task
    // burst contiguous and ordered.
    all.sort((a, b) => {
        const planCmp = (a.planId || '').localeCompare(b.planId || '');
        if (planCmp !== 0) return planCmp;
        return a.taskId.localeCompare(b.taskId);
    });

    // Group per plan so the heading can carry a count and a fold toggle.
    const groups = new Map<string, TaskRow[]>();
    for (const task of all) {
        const planKey = task.planId || '(no plan)';
        const group = groups.get(planKey);
        if (group) group.push(task);
        else groups.set(planKey, [task]);
    }

    const children: HTMLElement[] = [];
    for (const [planKey, group] of groups) {
        const collapsed = collapsedTaskPlans.has(planKey);
        const heading = document.createElement('li');
        heading.className =
            'task-plan-heading' + (collapsed ? ' task-plan-heading--collapsed' : '');
        heading.setAttribute('data-task-plan-heading', planKey);
        heading.setAttribute('role', 'button');
        heading.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
        heading.title = collapsed ? 'Expand tasks' : 'Collapse tasks';

        const chevron = document.createElement('span');
        chevron.className = 'task-plan-heading__chevron';
        chevron.textContent = collapsed ? '▸' : '▾';
        const label = document.createElement('span');
        label.className = 'task-plan-heading__label';
        // Prefer the plan's human title over the raw planId.
        label.textContent = plans.get(planKey)?.title || planKey;
        const count = document.createElement('span');
        count.className = 'task-plan-heading__count';
        count.textContent = String(group.length);
        heading.append(chevron, label, count);
        heading.addEventListener('click', () => toggleTaskPlanFold(planKey));
        children.push(heading);

        if (!collapsed) {
            for (const task of group) children.push(renderTaskCard(task));
        }
    }
    listEl.replaceChildren(...children);

    // "Collapse all / Expand all" — label follows the current state; the
    // `onclick` assignment (not addEventListener) keeps re-renders from
    // stacking handlers.
    const foldAllBtn = document.querySelector(
        '#all-tasks [data-fold-all-tasks]',
    ) as HTMLButtonElement | null;
    if (foldAllBtn) {
        const planKeys = [...groups.keys()];
        const anyExpanded = planKeys.some((k) => !collapsedTaskPlans.has(k));
        foldAllBtn.textContent = anyExpanded ? 'Collapse all' : 'Expand all';
        foldAllBtn.onclick = (): void => {
            if (anyExpanded) for (const k of planKeys) collapsedTaskPlans.add(k);
            else for (const k of planKeys) collapsedTaskPlans.delete(k);
            saveCollapsedTaskPlans();
            renderTasks();
        };
    }
}

function renderTasksKanban(): void {
    if (!taskTemplate) return;
    const byColumn = new Map<string, TaskRow[]>();
    COLUMNS.forEach((col) => byColumn.set(col, []));
    for (const task of tasks.values()) {
        const bucket = byColumn.get(task.status) || byColumn.get('created')!;
        bucket.push(task);
    }
    for (const [col, list] of byColumn) {
        const colEl = columnEls.get(col);
        if (!colEl) continue;
        const listEl = colEl.querySelector('[data-tasks]') as HTMLElement | null;
        const countEl = colEl.querySelector('[data-count]') as HTMLElement | null;
        if (countEl) countEl.textContent = String(list.length);
        if (!listEl) continue;
        listEl.replaceChildren();
        list.sort((a, b) => a.taskId.localeCompare(b.taskId));
        for (const task of list) {
            listEl.appendChild(renderTaskCard(task));
        }
    }
}

/**
 * Build a single task card from `taskTemplate` populated with the
 * supplied row. Returns the root `<li class="task-card">` element so
 * callers can append it directly into either a Kanban column's
 * `[data-tasks]` slot or the flat-list section body.
 */
function renderTaskCard(task: TaskRow): HTMLElement {
    const frag = (taskTemplate as HTMLTemplateElement).content.cloneNode(true) as DocumentFragment;
    const cardEl = frag.querySelector('[data-task-card]') as HTMLElement | null;
    if (cardEl) {
        // Card root needs `data-task-id` so the delegated click
        // handler can resolve the card → task lookup. Without this,
        // `cardEl.getAttribute('data-task-id')` on the `<li>` returns
        // null and Show agent / View report silently no-op.
        cardEl.setAttribute('data-task-id', task.taskId);
    }
    // Scope the inner-span queries to `.task-X` classes — the card
    // root now also carries `data-task-id`, and a bare
    // `frag.querySelector('[data-task-id]')` would match the root
    // first and the subsequent `.textContent = …` would wipe every
    // child of the card. (That was the "TASKS 1 but no card body"
    // bug — count badge updated, card collapsed to a text node.)
    (frag.querySelector('.task-id') as HTMLElement).textContent = task.taskId;
    (frag.querySelector('.task-type') as HTMLElement).textContent = task.type;
    (frag.querySelector('.task-plan') as HTMLElement).textContent = task.planId;
    // Type-coloured short-label badge. The CSS keys colours off
    // `data-task-type-badge='<type>'`; setting that attribute + a short
    // label fills the otherwise-empty `<span class="type-badge">` that
    // was rendering as a thin coloured line. Labels mirror v1's
    // TYPE_STYLE map; unknown types fall through to `TASK`.
    const typeBadgeEl = frag.querySelector('[data-type-badge]') as HTMLElement | null;
    if (typeBadgeEl) {
        const key = (task.type ?? '').toLowerCase();
        const label = TYPE_BADGE_LABEL[key] ?? 'TASK';
        typeBadgeEl.setAttribute('data-task-type-badge', key);
        typeBadgeEl.textContent = label;
    }
    // Populate the [data-task-title] slot the card template exposes.
    // The decomposer-produced TaskCreated events carry titles; leaving
    // the slot blank hid the labelling from the board.
    const titleEl = frag.querySelector('[data-task-title]') as HTMLElement | null;
    if (titleEl) titleEl.textContent = task.title ?? '';
    renderParkedChip(frag, task);
    renderDependencyChip(frag, task);
    if (cardEl && task.parkedReason) {
        cardEl.classList.add('parked');
        cardEl.classList.add(`parked--${task.parkedReason}`);
    }
    const stageBarEl = frag.querySelector('[data-stage-bar]') as HTMLElement | null;
    // P-TOTS-006: resolve the task's flow to its ordered FlowStage[] from
    // the hydrated catalog and hand it to the stage-bar renderer. An
    // unknown flow (or an unhydrated / failed catalog) resolves to [], so
    // the card renders no bar rather than a stale fixed strip.
    if (stageBarEl) {
        renderPipelineStageBar(
            stageBarEl,
            task as PipelineTask,
            task.taskId,
            stagesForTask(task),
        );
    }
    // PR link: post-commit hook stores the GitHub URL on
    // task_worktrees.pr_url. Surface it as a small link in the meta
    // row so the operator can review the diff before clicking
    // Merge PR. Appended after the existing meta content (plan id).
    if (task.prUrl && cardEl) {
        const metaEl = frag.querySelector('[data-task-meta]') as HTMLElement | null;
        if (metaEl) {
            const sep = document.createElement('span');
            sep.className = 'task-meta-sep';
            sep.textContent = ' · ';
            const link = document.createElement('a');
            link.className = 'task-pr-link';
            link.href = task.prUrl;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            link.textContent = task.prNumber !== null
                ? `PR #${task.prNumber}`
                : 'PR';
            // Stop the click from bubbling to the stage-cell delegated
            // handler that would otherwise open the summary modal for
            // a chip that happens to share ancestry.
            link.addEventListener('click', (e) => e.stopPropagation());
            metaEl.appendChild(sep);
            metaEl.appendChild(link);
        }
    }
    renderStreamTail(frag, task);
    renderInvestigation(frag, task);
    renderInvestigationThread(frag, task);
    renderFollowupChip(frag, task);
    const resumeBtn = frag.querySelector('[data-resume-action]') as HTMLButtonElement | null;
    // Approval parks render their own Approve / Reject row; wait-merged
    // parks render their own "Merge PR" button; worktree-diff-review
    // parks render their own "Review changes" modal. Each has semantic
    // resume meaning that the blind Resume button would short-circuit:
    // clicking Resume on a wait-merged task fires ResumeTask which
    // the engine folds straight to emit:TaskFinished without ever
    // calling `gh pr merge`. Keep Resume hidden for those reasons.
    if (resumeBtn) {
        const parkedReason = task.parkedReason ?? '';
        const ownedByOtherUi
            = parkedReason === 'approval'
            || parkedReason === 'wait-merged'
            || parkedReason === 'clarification'
            || parkedReason === 'worktree-diff-review'
            // waiting-deps has no flow_state (the task never dispatched),
            // so Resume would warn + no-op. Its real affordances are
            // Approve (pre-approve) / Skip, handled by pruneTaskActions.
            || parkedReason === 'waiting-deps';
        resumeBtn.hidden = !parkedReason || ownedByOtherUi;
    }
    injectTaskCardModalTriggers(frag, task);
    renderApprovalControls(frag, task);
    // The card template ships with Approve / Skip / Retry / Resume as
    // static action buttons. Most don't apply to most task states, so
    // hide the ones that don't fit the current status — operator sees
    // a single coherent next-step affordance instead of the full action
    // soup. Approve + Skip stay on the freshly-created card; Retry is
    // only meaningful after a failure; Resume only on parked tasks
    // (handled separately above).
    pruneTaskActions(frag, task);
    frag.querySelectorAll('button[data-action]').forEach((btn) => {
        const action = (btn as HTMLButtonElement).dataset.action || '';
        // show-agent + view-report are wired via the columns-level
        // delegated listener so a single bubbling handler covers
        // every card. Skip per-card listeners for them.
        if (action === 'show-agent' || action === 'view-report') return;
        btn.addEventListener('click', () => onTaskAction(action, task));
    });
    if (!cardEl) {
        throw new Error('renderTaskCard: template missing [data-task-card]');
    }
    // Open the task-details modal when the operator clicks anywhere on
    // the card OUTSIDE an interactive element. Clicks on buttons /
    // links / textareas keep their own handlers — the closest() guard
    // bails before we hijack them. Stage chips have their own click
    // handler wired by renderPipelineStageBar; same deal.
    cardEl.addEventListener('click', (e) => {
        const target = e.target as HTMLElement | null;
        if (!target) return;
        if (target.closest('button, a, textarea, input, select, [data-stage-cell]')) {
            return;
        }
        openTaskModal(task.taskId);
    });
    cardEl.setAttribute('role', 'button');
    cardEl.setAttribute('tabindex', '0');
    cardEl.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const target = e.target as HTMLElement | null;
        // Pressing Enter on a focused button inside the card should
        // trigger the button, not the card-level modal.
        if (target && target !== cardEl
            && target.closest('button, a, textarea, input, select')) {
            return;
        }
        e.preventDefault();
        openTaskModal(task.taskId);
    });
    return cardEl;
}

/**
 * AP-IFW-006 Phase 1 — render a dependency chip on the task card.
 *
 * Two states:
 *   - `Blocked by: T-001, T-002`  (when `blockedBy.length > 0` — red chip)
 *   - `Deps: T-001, T-002 ✓`      (when all upstreams merged but the
 *                                   task declared at least one — neutral)
 *
 * The chip is appended to the existing `[data-task-body]` row so it
 * shows up next to the plan-id + parked chip without a template change.
 */
function renderDependencyChip(frag: DocumentFragment, task: TaskRow): void {
    const depsAll = Array.isArray(task.dependsOn) ? task.dependsOn : [];
    if (depsAll.length === 0) return;
    const body = frag.querySelector('.task-body') as HTMLElement | null;
    if (!body) return;
    const blocked = Array.isArray(task.blockedBy) ? task.blockedBy : [];
    const chip = document.createElement('span');
    chip.className = 'deps-chip';
    if (blocked.length > 0) {
        chip.classList.add('deps-chip--blocked');
        // When pre-approved, signal that it'll auto-start on unblock.
        chip.textContent = task.preApproved
            ? `Blocked by: ${blocked.join(', ')} · approved ✓`
            : `Blocked by: ${blocked.join(', ')}`;
        chip.title = task.preApproved
            ? `Approved — will start automatically when ${blocked.length} upstream task${blocked.length === 1 ? '' : 's'} finish`
            : `Waiting on ${blocked.length} upstream task${blocked.length === 1 ? '' : 's'}`;
    } else {
        chip.classList.add('deps-chip--ready');
        chip.textContent = `Deps: ${depsAll.join(', ')} ✓`;
    }
    body.appendChild(chip);
}

function renderParkedChip(frag: DocumentFragment, task: TaskRow): void {
    const chip = frag.querySelector('[data-parked-chip]') as HTMLElement | null;
    if (!chip) return;
    // Reaching wait-merged with no PR means the commit is LOCAL ONLY — the
    // post-commit push/PR didn't complete. Render that as a warning (with
    // the precise error when a TaskCommitFailed event flagged it) instead
    // of the plain green "Awaiting merge", so a failed push doesn't read as
    // "done". The Create PR button (re-runs push + PR, idempotent) is the
    // retry. This is robust across reloads because it's derived from the
    // persisted parkedReason + prUrl, not just the live commitError flag.
    const notPushed = task.parkedReason === 'wait-merged' && !task.prUrl;
    if (task.commitError || notPushed) {
        chip.hidden = false;
        chip.className = 'parked-chip parked-chip--commit-failed';
        chip.textContent = task.commitError
            ? '⚠ Push/PR failed — Retry'
            : 'Not on GitHub yet — Retry push & PR';
        chip.title = task.commitError
            ?? 'The commit is local only. Click "Create PR" to push the branch and open the PR.';
        return;
    }
    // A rejected task is not parked — it is FAILED with an operator
    // reason — so it reached this renderer and got hidden, which is why a
    // rejection was invisible on the card. Show it, with the reason on
    // hover; the modal carries the full text.
    const rejection = (task.feedback ?? '').trim();
    if (!task.parkedReason && task.status === 'failed' && rejection.length > 0) {
        chip.hidden = false;
        chip.className = 'parked-chip parked-chip--rejected';
        chip.textContent = 'Rejected';
        chip.title = rejection;
        return;
    }
    if (!task.parkedReason) {
        chip.hidden = true;
        chip.textContent = '';
        return;
    }
    chip.hidden = false;
    chip.className = 'parked-chip';
    chip.classList.add(`parked-chip--${task.parkedReason}`);
    chip.textContent = parkedChipLabel(task.parkedReason);
    if (task.parkedQuestion) chip.title = task.parkedQuestion;
    else chip.removeAttribute('title');
}

function renderStreamTail(frag: DocumentFragment, _task: TaskRow): void {
    // The inline agent-stream section on the card is no longer used —
    // Show agent now opens the dedicated modal (same chrome as the
    // planner / decomposer modals) which reads from {@link taskAgents}.
    // Keep the section hidden so any leftover styling on the template
    // doesn't reserve vertical space on the card.
    const section = frag.querySelector('[data-agent-stream]') as HTMLElement | null;
    if (section) section.hidden = true;
}

function renderInvestigation(frag: DocumentFragment, task: TaskRow): void {
    const section = frag.querySelector('[data-investigation]') as HTMLElement | null;
    if (!section) return;
    const report = investigationReports.get(task.taskId);
    const isInvestigateType = task.type === 'investigate';
    if (!report && !isInvestigateType) {
        section.hidden = true;
        return;
    }
    section.hidden = false;
    if (!report) {
        const reportEl = section.querySelector('[data-investigation-report]') as HTMLElement | null;
        if (reportEl) {
            reportEl.replaceChildren();
            const p = document.createElement('p');
            p.className = 'investigation-pending';
            p.textContent = 'Investigation in progress…';
            reportEl.appendChild(p);
        }
        const stateEl = section.querySelector('[data-investigation-state]') as HTMLElement | null;
        if (stateEl) stateEl.textContent = 'in progress';
        const actionsEl = section.querySelector('[data-investigation-actions]') as HTMLElement | null;
        if (actionsEl) actionsEl.hidden = true;
        return;
    }
    const reportEl = section.querySelector('[data-investigation-report]') as HTMLElement | null;
    if (reportEl) {
        reportEl.replaceChildren();
        for (const node of renderMarkdown(report.markdown)) reportEl.appendChild(node);
    }
    const stateEl = section.querySelector('[data-investigation-state]') as HTMLElement | null;
    const actionsEl = section.querySelector('[data-investigation-actions]') as HTMLElement | null;
    const actionable = !report.dismissed && !report.implemented && TRIAGE_COLUMNS.has(task.status);
    if (stateEl) {
        if (report.implemented) stateEl.textContent = 'implemented';
        else if (report.dismissed) stateEl.textContent = 'dismissed';
        else stateEl.textContent = actionable ? 'ready for action' : 'closed';
    }
    if (actionsEl) actionsEl.hidden = !actionable;
}

function renderInvestigationThread(frag: DocumentFragment, task: TaskRow): void {
    if (task.type !== 'investigate') return;
    const thread = Array.isArray(task.investigation_thread) ? task.investigation_thread : [];
    if (thread.length === 0) return;
    const cardEl = frag.querySelector('[data-task-card]') as HTMLElement | null;
    if (!cardEl) return;
    const list = document.createElement('ol');
    list.className = 'investigation-thread';
    list.setAttribute('data-investigation-thread', '');
    for (const entry of thread) {
        const item = document.createElement('li');
        const role = typeof entry.role === 'string' ? entry.role : '';
        item.className = `investigation-thread-entry investigation-thread-entry--${role}`;
        item.setAttribute('data-thread-role', role);
        if (typeof entry.timestamp === 'number') {
            item.setAttribute('data-thread-timestamp', String(entry.timestamp));
        }
        const roleEl = document.createElement('span');
        roleEl.className = 'investigation-thread-role';
        roleEl.textContent = role;
        item.appendChild(roleEl);
        const contentEl = document.createElement('p');
        contentEl.className = 'investigation-thread-content';
        contentEl.textContent = typeof entry.content === 'string' ? entry.content : '';
        item.appendChild(contentEl);
        list.appendChild(item);
    }
    cardEl.appendChild(list);
}

function renderFollowupChip(frag: DocumentFragment, task: TaskRow): void {
    if (task.type !== 'investigate') return;
    const cardEl = frag.querySelector('[data-task-card]') as HTMLElement | null;
    if (!cardEl) return;
    const chip = document.createElement('div');
    chip.className = 'followup-chip';
    chip.setAttribute('data-followup-chip', '');
    chip.setAttribute('data-task-id', task.taskId);
    const inflight = Boolean(task.followup_inflight);
    chip.setAttribute('data-inflight', inflight ? 'true' : 'false');

    const input = document.createElement('input');
    input.type = 'text';
    input.name = 'question';
    input.setAttribute('data-field', 'question');
    input.placeholder = 'Ask a follow-up…';
    chip.appendChild(input);

    const askBtn = document.createElement('button');
    askBtn.type = 'button';
    askBtn.setAttribute('data-action', 'ask-followup');
    askBtn.textContent = 'Ask';
    if (inflight) {
        askBtn.disabled = true;
        askBtn.setAttribute('aria-busy', 'true');
    }
    askBtn.addEventListener('click', () => {
        if (task.followup_inflight) return;
        const question = (input.value || '').trim();
        if (!question) return;
        onAskFollowup(task, question);
    });
    chip.appendChild(askBtn);

    if (inflight) {
        const spinner = document.createElement('span');
        spinner.className = 'followup-spinner';
        spinner.setAttribute('data-followup-spinner', '');
        spinner.setAttribute('role', 'status');
        spinner.setAttribute('aria-label', 'Investigator working…');
        spinner.textContent = '⟳';
        chip.appendChild(spinner);
    }

    const showBtn = document.createElement('button');
    showBtn.type = 'button';
    showBtn.setAttribute('data-action', 'show-agent');
    showBtn.textContent = 'Show agent';
    // AP-IFB-008 — handled by the columns-level delegated click listener
    // alongside the task-card "Show agent" button. No per-card listener
    // here to avoid double-firing onShowAgent.
    chip.appendChild(showBtn);

    cardEl.appendChild(chip);
}

function renderMarkdown(text: string): Node[] {
    if (!text) return [];
    const nodes: Node[] = [];
    const lines = text.split(/\r?\n/);
    let listEl: HTMLUListElement | null = null;
    let paragraph: HTMLParagraphElement | null = null;
    // Fenced code block state: a ``` line opens a block (with an optional
    // language), lines are buffered verbatim until the closing ```.
    let fenceOpen = false;
    let fenceLang = '';
    let fenceLines: string[] = [];
    const flushParagraph = (): void => {
        if (paragraph) {
            nodes.push(paragraph);
            paragraph = null;
        }
    };
    const flushList = (): void => {
        if (listEl) {
            nodes.push(listEl);
            listEl = null;
        }
    };
    for (const raw of lines) {
        const line = raw.trimEnd();
        const fence = line.match(/^```(.*)$/);
        if (fenceOpen) {
            if (fence) {
                // Closing fence — emit the buffered block (mermaid → diagram,
                // otherwise a <pre>), preserving blank lines inside it.
                nodes.push(buildMarkdownCodeBlock(fenceLang, fenceLines.join('\n')));
                fenceOpen = false;
                fenceLang = '';
                fenceLines = [];
            } else {
                fenceLines.push(raw);
            }
            continue;
        }
        if (fence) {
            flushParagraph();
            flushList();
            fenceOpen = true;
            fenceLang = (fence[1] || '').trim().toLowerCase();
            fenceLines = [];
            continue;
        }
        if (!line.trim()) {
            flushParagraph();
            flushList();
            continue;
        }
        const heading = line.match(/^(#{1,6})\s+(.+)$/);
        if (heading) {
            flushParagraph();
            flushList();
            const level = Math.min(heading[1].length + 2, 6);
            const h = document.createElement('h' + level);
            h.textContent = heading[2];
            nodes.push(h);
            continue;
        }
        const bullet = line.match(/^\s*[-*]\s+(.+)$/);
        if (bullet) {
            flushParagraph();
            if (!listEl) listEl = document.createElement('ul');
            const li = document.createElement('li');
            li.textContent = bullet[1];
            listEl.appendChild(li);
            continue;
        }
        flushList();
        if (!paragraph) paragraph = document.createElement('p');
        if (paragraph.textContent) paragraph.append(document.createElement('br'));
        paragraph.append(document.createTextNode(line));
    }
    flushParagraph();
    flushList();
    // An unterminated fence (no closing ```) still renders its buffered body.
    if (fenceOpen) {
        nodes.push(buildMarkdownCodeBlock(fenceLang, fenceLines.join('\n')));
    }
    return nodes;
}

/**
 * Build a rendered node for a fenced code block. A `mermaid` fence becomes a
 * diagram (async-rendered via {@link renderMermaidInto}, falling back to the
 * raw source in a <pre> when Mermaid is unavailable); any other language is a
 * plain <pre><code>.
 */
function buildMarkdownCodeBlock(lang: string, code: string): Node {
    if (lang === 'mermaid') {
        const container = document.createElement('div');
        container.className = 'markdown-mermaid';
        const loading = document.createElement('p');
        loading.className = 'markdown-mermaid__loading';
        loading.textContent = 'Rendering diagram…';
        container.appendChild(loading);
        void renderMermaidInto(container, code, () => buildMarkdownPre(code));
        return container;
    }
    return buildMarkdownPre(code);
}

function buildMarkdownPre(code: string): HTMLElement {
    const pre = document.createElement('pre');
    pre.className = 'markdown-pre';
    const codeEl = document.createElement('code');
    codeEl.textContent = code;
    pre.appendChild(codeEl);
    return pre;
}

// ----- command actions -------------------------------------------------

interface BoardCommand {
    type: string;
    actor: string;
    issuedAt: number;
    payload: Record<string, unknown>;
}

function onApprovePlan(plan: PlanRow): void {
    void sendCommand({
        type: 'ApprovePlan',
        actor: 'operator',
        issuedAt: Date.now(),
        payload: { planId: plan.planId, projectId: plan.projectId || undefined },
    });
}

// AP-IFB-003 — plan-card action router. The five buttons rendered by
// the V1 action set route here; each branch dispatches through the
// existing `sendCommand` adapter (NOT a worker-api fetch) so the
// renderer stays decoupled from the wire format. "Show agent" is the
// lone UI-only branch: it reveals any plan-agent stream slot on the
// card without producing a command.
function onPlanAction(action: PlanCardAction, plan: PlanRow): void {
    switch (action) {
        case 'show-agent': {
            const cardEl = document.querySelector(
                `[data-plan-card][data-plan-id="${cssEscape(plan.planId)}"]`,
            ) as HTMLElement | null;
            if (cardEl) {
                const streamEl = cardEl.querySelector(
                    '[data-plan-agent-stream]',
                ) as HTMLElement | null;
                if (streamEl) streamEl.hidden = false;
                if (cardEl.scrollIntoView) {
                    cardEl.scrollIntoView({ block: 'nearest' });
                }
            }
            return;
        }
        case 'review-plan':
            void sendCommand({
                type: 'RequestPlanReview',
                actor: 'operator',
                issuedAt: Date.now(),
                payload: {
                    planId: plan.planId,
                    projectId: plan.projectId || undefined,
                },
            });
            return;
        case 'activate':
            // Activate is v1's name for the v2 ApprovePlan command.
            onApprovePlan(plan);
            return;
        case 're-decompose':
            void sendCommand({
                type: 'RedecomposePlan',
                actor: 'operator',
                issuedAt: Date.now(),
                payload: {
                    planId: plan.planId,
                    projectId: plan.projectId || undefined,
                },
            });
            return;
        case 'delete-plan':
            // Delete dispatches the typed BoardUi DELETE_PLAN command
            // through the same sink — not the worker-api DELETE route
            // the sidebar plan-tree uses (AC #3).
            if (!plan.planFile) return;
            void sendCommand({
                type: 'DeletePlan',
                actor: 'operator',
                issuedAt: Date.now(),
                payload: { planId: plan.planId },
            });
            return;
    }
}

function onTaskAction(action: string, task: TaskRow): void {
    let command: BoardCommand | null = null;
    switch (action) {
        case 'approve':
            // Approve on a deps-parked task is a PRE-approval: it
            // doesn't start the task (the upstream isn't merged yet) but
            // records the operator's intent so the engine auto-starts it
            // when the dependency finishes. Optimistically flip the
            // in-memory row so the card shows the approved state
            // immediately; the server confirms via TaskPreApproved.
            if (task.parkedReason === 'waiting-deps') {
                task.preApproved = true;
                showToast({
                    message: `${task.taskId} approved — it will start when its dependencies finish.`,
                    kind: 'info',
                });
                command = {
                    type: 'PreApproveTask',
                    actor: 'operator',
                    issuedAt: Date.now(),
                    payload: { taskId: task.taskId },
                };
                break;
            }
            command = {
                type: 'ApproveTask',
                actor: 'operator',
                issuedAt: Date.now(),
                payload: { taskId: task.taskId, flowId: task.flowId },
            };
            break;
        case 'skip':
        case 'cancel': {
            // Cancel is the in-flight escape hatch: if an agent is
            // running for this task, interrupt it first so we don't
            // keep burning tokens, then emit SkipTask to mark the row
            // done. The interrupt is best-effort — a CancelAgentRun
            // that fails (race against AgentFinished, sidecar already
            // killed, …) is silently dropped on the orchestrator side
            // and the SkipTask still lands.
            const run = taskAgents.get(task.taskId);
            if (run && run.status === 'running' && run.agentId) {
                void sendCommand({
                    type: 'CancelAgentRun',
                    actor: 'operator',
                    issuedAt: Date.now(),
                    payload: { runId: run.agentId, reason: 'operator cancelled task' },
                });
            }
            command = {
                type: 'SkipTask',
                actor: 'operator',
                issuedAt: Date.now(),
                payload: { taskId: task.taskId },
            };
            break;
        }
        case 'retry-step':
        case 'restart':
            // AP-PAO-009 matrix ids for the failed:<stage> action row.
            // The v2 engine has exactly one retry shape — wipe flow
            // state, re-dispatch step 1 through the approval gate — so
            // both map onto the same RetryTask path as 'retry'.
            // falls through
        case 'retry':
            // Re-run the task from the first step. The orchestrator's
            // RetryTask handler emits a `TaskRetried` event that the
            // flow engine folds by dropping the existing `flow_state`
            // row and re-dispatching `steps[0]` — which lands back at
            // the approval gate, so the operator gets a fresh Approve/
            // Reject choice before the agent re-spawns.
            //
            // For tasks already in `done` state, confirm first — Retry
            // on a completed task is intentional (re-run against an
            // updated flow YAML, restart a MarkTaskComplete-overridden
            // task, …) but an accidental click would re-fire the
            // whole agent chain and could open a duplicate PR.
            if (task.status === 'done') {
                const label = task.title ? `"${task.title}"` : task.taskId;
                const confirmed = window.confirm(
                    `Re-run ${label} from the first step? This task is already marked done; retrying will reset it to created and re-dispatch the whole agent chain.`,
                );
                if (!confirmed) return;
            }
            command = {
                type: 'RetryTask',
                actor: 'operator',
                issuedAt: Date.now(),
                payload: { taskId: task.taskId },
            };
            break;
        case 'merge':
            // ready_to_merge matrix row alias.
            // falls through
        case 'merge-pr':
            // Operator clicked Merge PR. Orchestrator handler runs
            // `gh pr merge` in the worktree and (on success) publishes
            // ResumeTask which the engine folds via the wait-merged
            // step's on_success straight to emit:TaskFinished. The
            // TaskFinished projection-tasks subscriber then flips the
            // row to status='done' so the board paints it as a
            // finished task on the next render.
            //
            // Use `sendCommandOrThrow` here (not the fire-and-forget
            // `sendCommand`) so a merge-conflict failure or auth issue
            // surfaces as a toast the operator can act on. The handler
            // never publishes ResumeTask on failure, so the task stays
            // parked at wait-merged and the button remains clickable
            // for a retry once the underlying issue is resolved.
            (async () => {
                try {
                    await sendCommandOrThrow({
                        type: 'MergeTaskPr',
                        actor: 'operator',
                        issuedAt: Date.now(),
                        payload: { taskId: task.taskId },
                    });
                    showToast({
                        message: `Merging PR for ${task.taskId}…`,
                        kind: 'info',
                    });
                } catch (err) {
                    const msg = err instanceof Error
                        ? err.message
                        : String(err);
                    showToast({ message: msg, kind: 'error' });
                }
            })();
            return;
        case 'create-pr':
            // Operator clicked Create PR — the post-commit hook failed
            // to open a PR the first time (typically `gh` auth issue or
            // an already-existing PR for the same branch). The
            // orchestrator's CreateTaskPr handler re-runs the hook
            // (push is idempotent, gh pr create re-attempts). On
            // success the task_worktrees row gains a prUrl, the next
            // render swaps Create PR out for Merge PR. On failure the
            // command surface returns 5xx with the error reason and
            // the operator sees a toast.
            command = {
                type: 'CreateTaskPr',
                actor: 'operator',
                issuedAt: Date.now(),
                payload: { taskId: task.taskId },
            };
            break;
        case 'already-merged':
            // ready_to_merge matrix row — same override as mark-complete.
            // falls through
        case 'mark-complete': {
            // Operator override for tasks stuck past the work-completion
            // point. Confirm first — flipping to 'done' bypasses every
            // remaining stage (commit, PR, review, …), and the dep
            // store's TaskFinished hook also unblocks every downstream
            // task that depended on this one. Both are intended; the
            // confirm just guards an accidental click.
            const label = task.title ? `"${task.title}"` : task.taskId;
            const confirmed = window.confirm(
                `Mark ${label} as complete? Any remaining steps (commit, PR, …) will be skipped and downstream tasks that were waiting on this one will unblock.`,
            );
            if (!confirmed) return;
            command = {
                type: 'MarkTaskComplete',
                actor: 'operator',
                issuedAt: Date.now(),
                payload: { taskId: task.taskId },
            };
            break;
        }
        case 'dismiss': {
            // Done task → operator clicked Dismiss. SkipTask is the
            // existing "remove this row from the board" signal — its
            // projection-tasks subscriber flips status to 'skipped'
            // and /api/tasks already filters skipped rows, so the card
            // stays gone across reloads. We deliberately reuse
            // SkipTask instead of inventing a new event: the visual
            // effect is identical and the worktree / step_summaries /
            // PR history are wiped (the per-task cancel cleanup), which
            // is correct for a fully-finished task.
            command = {
                type: 'SkipTask',
                actor: 'operator',
                issuedAt: Date.now(),
                payload: { taskId: task.taskId },
            };
            break;
        }
        case 'approve-commit':
            // ready_to_commit matrix row: approving the commit IS the
            // resume-with-approve decision on the parked step.
            // falls through
        case 'resume':
            // Clarification parks open the clarify modal so the
            // operator types their answer; wait-* parks resume blind.
            if (task.parkedReason === 'clarification') {
                openClarify(task);
                return;
            }
            command = buildResumeCommand(task);
            break;
        case 'review':
            // ready_to_commit matrix row — same surface as diff-review.
            // falls through
        case 'diff-review':
            openDiffReviewForTask(task);
            return;
        case 'interrupt-retry':
        case 'interrupt-restart':
        case 'interrupt-cancel':
            // in-flight matrix row: all three open the interrupt modal,
            // where the operator picks retry / restart / cancel.
            openInterruptRetry(task);
            return;
        case 'answer':
            // awaiting_clarification matrix row.
            openClarificationAnswer(task);
            return;
        case 'implement':
            // ready_for_action matrix row: open the report modal, whose
            // Implement button runs the robust decompose-from-report
            // path (projection report OR step-summary fallback).
            openReviewReportForTask(task);
            return;
        case 'open-pr':
            if (task.prUrl) window.open(task.prUrl, '_blank', 'noopener');
            else showToast({ message: 'No PR recorded for this task yet.', kind: 'info' });
            return;
        // show-agent / view-report on CARDS are delegated (body-level
        // listener below); these cases cover the task MODAL's action row,
        // whose buttons dispatch through onTaskAction directly — without
        // them the modal's View report / Show agent buttons silently
        // no-oped (no matching case, no error).
        case 'show-agent':
            onShowAgent(task);
            return;
        case 'view-report':
            openReviewReportForTask(task);
            return;
        case 'human-review':
            openHumanReviewForTask(task);
            return;
        case 'reject':
            openRejectForTask(task);
            return;
        case 'clarify':
            // Defensive: if any caller still routes a 'clarify' action
            // here (e.g., a stale chat-bot affordance), open the modal.
            // The task-card itself no longer renders a dedicated button —
            // the Resume action covers parked-clarification cards.
            openClarify(task);
            return;
        case 'answer-clarification':
            // AP-VP5-014 — Phase 5 Answer button. Opens the AP-VP5-010
            // clarify modal that POSTs `{answer, remember}` to the
            // worker-api's `/tasks/:id/clarify` endpoint.
            openClarificationAnswer(task);
            return;
        case 'ask-investigation-followup':
            // AP-VP5-014 — Phase 5 Ask follow-up button. Opens the
            // AP-VP5-011 modal pre-populated with the investigation
            // thread.
            openInvestigationFollowup(task);
            return;
        case 'implement-from-investigation':
            void onImplementFromInvestigation(task);
            return;
        case 'dismiss-investigation':
            void onDismissInvestigation(task);
            return;
        default:
            return;
    }
    if (command) void sendCommand(command);
}

function buildResumeCommand(task: TaskRow): BoardCommand {
    return {
        type: 'ResumeTask',
        actor: 'operator',
        issuedAt: Date.now(),
        payload: { taskId: task.taskId, decision: 'approve' },
    };
}

function onAskFollowup(task: TaskRow, question: string): void {
    // 'AskInvestigationFollowup' is the wire type the orchestrator
    // registers; this path used the legacy 'RequestInvestigationFollowup'
    // alias, which no handler has ever answered.
    void sendCommand({
        type: 'AskInvestigationFollowup',
        actor: 'operator',
        issuedAt: Date.now(),
        payload: { taskId: task.taskId, question },
    });
}

function onShowAgent(task: TaskRow): void {
    // Open the same modal chrome the planner and decomposer use, scoped
    // to `taskAgents[taskId]`. The inline `[data-agent-stream]` section
    // on the card is no longer rendered — the modal is the single
    // surface for the task agent's live activity feed + Stop button.
    openShowTaskAgentModal(task.taskId);
}

function cssEscape(value: string): string {
    const s = String(value);
    const cssGlobal = (window as unknown as { CSS?: { escape?: (v: string) => string } }).CSS;
    if (cssGlobal && typeof cssGlobal.escape === 'function') return cssGlobal.escape(s);
    return s.replace(/[^a-zA-Z0-9_-]/g, (ch) => '\\' + ch);
}

async function onImplementFromInvestigation(task: TaskRow): Promise<void> {
    const report = investigationReports.get(task.taskId);
    if (!report) return;
    await postInvestigationAction('/commands/implement-from-investigation', {
        taskId: task.taskId,
        reportId: report.reportId,
    });
}

async function onDismissInvestigation(task: TaskRow): Promise<void> {
    const report = investigationReports.get(task.taskId);
    if (!report) return;
    const reasonRaw = window.prompt('Reason for dismissing this investigation (optional):', '');
    if (reasonRaw === null) return;
    const reason = reasonRaw.trim();
    const body: Record<string, string> = { taskId: task.taskId, reportId: report.reportId };
    if (reason) body.reason = reason;
    await postInvestigationAction('/commands/dismiss-investigation', body);
}

async function postInvestigationAction(path: string, body: Record<string, unknown>): Promise<void> {
    try {
        const res = await fetch(`${API_BASE}${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            // eslint-disable-next-line no-console
            console.warn('board-ui: investigation action rejected', path, res.status);
        }
    } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('board-ui: investigation action failed', path, err);
    }
}

async function sendCommand(command: BoardCommand): Promise<void> {
    try {
        const res = await fetch(`${API_BASE}/commands`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(command),
        });
        if (!res.ok) {
            // Surface the rejection — commands whose handlers throw with a
            // diagnostic message (e.g. CreateTaskPr's "PR creation did not
            // land ...") used to die as a console.warn, so a failing button
            // just looked unresponsive to the operator.
            const text = await res.text().catch(() => '');
            const detail = text.slice(0, 300) || `HTTP ${res.status}`;
            showToast({ message: `${command.type} failed: ${detail}`, kind: 'error' });
            // eslint-disable-next-line no-console
            console.warn('board-ui: command rejected', command.type, res.status, text);
        }
    } catch (err) {
        showToast({
            message: `${command.type} failed: ${err instanceof Error ? err.message : String(err)}`,
            kind: 'error',
        });
        // eslint-disable-next-line no-console
        console.warn('board-ui: command failed', command.type, err);
    }
}

// Strict variant of {@link sendCommand} for call sites that need rejection on
// dispatch failure. The default `sendCommand` swallows non-2xx and network
// errors with a console warning so a fire-and-forget caller can stay on the
// happy path — but the AP-IFB-004 new-project modal's port contract requires
// the createProject promise to reject on command-bus failure so the modal
// transitions to `np-error` and surfaces a toast. Use this variant when an
// awaited caller (a modal, a confirmation dialog) needs to react to errors.
async function sendCommandOrThrow(command: BoardCommand): Promise<void> {
    const res = await fetch(`${API_BASE}/commands`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(command),
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        const detail = text || `${res.status} ${res.statusText}`.trim();
        throw new Error(`${command.type} rejected: ${detail}`);
    }
}

// ----- attachments (migration 021) -------------------------------------
//
// The operator attaches screenshots / mockups / sequence diagrams / spec
// docs to a task or plan. The bytes go to the worker-api over a raw binary
// POST; metadata flows back live over SSE (AttachmentAdded / Removed). The
// list section re-renders on every modal tick, so folding an event into the
// `attachments` Map is enough to show a new thumbnail without a re-fetch.

/** Owner of the currently-open modal — the target for a clipboard paste. */
let currentAttachTarget: { ownerType: AttachmentOwner; ownerId: string } | null = null;

const ATTACHMENT_ACCEPT =
    'image/png,image/jpeg,image/gif,image/webp,application/pdf,'
    + 'text/plain,text/markdown,text/csv,application/json,'
    + 'application/msword,'
    + 'application/vnd.openxmlformats-officedocument.wordprocessingml.document,'
    + 'application/vnd.ms-excel,'
    + 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Hydrate an owner's attachment list from the worker-api (modal open). */
async function fetchAttachmentList(
    ownerType: AttachmentOwner,
    ownerId: string,
    kind: AttachmentKind = 'input',
): Promise<void> {
    try {
        const res = await fetch(
            `${API_BASE}/api/attachments?ownerType=${ownerType}`
            + `&ownerId=${encodeURIComponent(ownerId)}&kind=${kind}`,
        );
        if (!res.ok) return;
        const data = (await res.json()) as { attachments?: unknown };
        if (!Array.isArray(data.attachments)) return;
        const list: AttachmentMeta[] = [];
        for (const raw of data.attachments) {
            if (raw && typeof raw === 'object') {
                const meta = coerceAttachment(raw as Record<string, unknown>);
                if (meta) list.push(meta);
            }
        }
        list.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
        attachments.set(attachKey(ownerType, ownerId, kind), list);
        refreshAttachmentSections(ownerType, ownerId);
        scheduleRender();
    } catch {
        /* best-effort — the modal still renders without the list */
    }
}

/** Upload one file as a raw binary POST. SSE folds the result back in. */
async function uploadAttachmentFile(
    ownerType: AttachmentOwner,
    ownerId: string,
    file: File,
    caption: string,
): Promise<void> {
    const name = file.name && file.name.length > 0 ? file.name : 'attachment';
    const params = new URLSearchParams({ ownerType, ownerId, name });
    if (caption.length > 0) params.set('caption', caption);
    try {
        const res = await fetch(`${API_BASE}/api/attachments?${params.toString()}`, {
            method: 'POST',
            headers: { 'Content-Type': file.type || 'application/octet-stream' },
            body: file,
        });
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            // eslint-disable-next-line no-console
            console.warn('board-ui: attachment upload rejected', res.status, text);
            window.alert(`Upload failed: ${text || res.status}`);
            return;
        }
        // Optimistically fold the response (SSE will also arrive; dedup by id).
        const data = (await res.json()) as { attachment?: unknown };
        if (data.attachment && typeof data.attachment === 'object') {
            const meta = coerceAttachment(data.attachment as Record<string, unknown>);
            if (meta) {
                upsertAttachment(meta);
                // The board pass does not reach the requirement
                // surfaces, so the section repaints itself.
                refreshAttachmentSections(meta.ownerType, meta.ownerId);
                scheduleRender();
            }
        }
    } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('board-ui: attachment upload failed', err);
        window.alert('Upload failed (network error).');
    }
}

/** Upload a list of files, prompting once for an optional shared caption. */
async function uploadAttachmentFiles(
    ownerType: AttachmentOwner,
    ownerId: string,
    files: readonly File[],
): Promise<void> {
    if (files.length === 0) return;
    const caption = (window.prompt(
        files.length === 1
            ? 'Caption for this attachment (optional) — e.g. "login button is misaligned":'
            : `Caption for these ${files.length} attachments (optional):`,
        '',
    ) ?? '').trim();
    for (const file of files) {
        await uploadAttachmentFile(ownerType, ownerId, file, caption);
    }
}

async function deleteAttachmentById(
    ownerType: AttachmentOwner,
    ownerId: string,
    id: string,
): Promise<void> {
    // Optimistic local removal; SSE AttachmentRemoved confirms it.
    removeAttachmentLocal(ownerType, ownerId, id);
    refreshAttachmentSections(ownerType, ownerId);
    scheduleRender();
    try {
        await fetch(`${API_BASE}/api/attachments/${encodeURIComponent(id)}`, {
            method: 'DELETE',
        });
    } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('board-ui: attachment delete failed', err);
    }
}

function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Paint the list of cards (or the empty note) into `list`. */
function renderAttachmentList(
    list: HTMLElement,
    ownerType: AttachmentOwner,
    ownerId: string,
    kind: AttachmentKind = 'input',
): void {
    const items = getAttachments(ownerType, ownerId, kind);
    if (items.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'attachments__empty';
        empty.textContent = kind === 'output'
            ? 'No files produced yet.'
            : 'No attachments yet.';
        list.replaceChildren(empty);
        return;
    }
    list.replaceChildren(
        ...items.map((meta) => buildAttachmentCard(ownerType, ownerId, meta)),
    );
}

/**
 * Repaint every mounted attachments section for one owner, in place.
 *
 * Field report: "I started a new design, click on choose a file,
 * selected the file, added a description and then nothing seem to
 * happen, it does not show an attachment being added". The upload had
 * SUCCEEDED every time — the worker logged all three — and the list
 * simply never repainted.
 *
 * The upload path ended in `scheduleRender()`, which repaints the
 * BOARD. A plan / task modal is rebuilt by that pass, so its section
 * came along for free and the code noted as much ("the section is
 * rebuilt on every modal tick"). The requirement surfaces are not:
 * the modal has its own refresh, and the NEW-design form is not
 * rendered by anything at all once it is open.
 *
 * Rebuilding the enclosing modal is the wrong fix for the form — it
 * would wipe the title and description the operator is part-way
 * through typing. Only the card list is replaced, leaving the heading,
 * the dropzone and every other field untouched.
 *
 * The DOM is the lookup, not a registry: a section that has been torn
 * down is simply not found, so there is nothing to keep in sync and no
 * stale element to leak.
 */
function refreshAttachmentSections(
    ownerType: AttachmentOwner,
    ownerId: string,
): void {
    const mounted = sectionsForOwner(
        document.querySelectorAll(`[${ATTACHMENTS_OWNER_ATTR}]`),
        attachmentSectionKey(ownerType, ownerId),
    );
    for (const el of mounted) {
        const list = el.querySelector('.attachments__list');
        if (!(list instanceof HTMLElement)) continue;
        // A task mounts TWO sections for one owner key - uploads and
        // produced files. Each is repainted from its own kind, or the two
        // would mirror each other.
        const kind = sectionKind(el);
        renderAttachmentList(list, ownerType, ownerId, kind);
        if (el instanceof HTMLElement && kind === 'output') {
            // The produced-files section stays out of the way until there
            // is something in it: most tasks produce no files, and an
            // always-visible empty block is noise on every one of them.
            el.style.display = getAttachments(ownerType, ownerId, 'output').length > 0
                ? ''
                : 'none';
        }
    }
}

/**
 * Build the Attachments section for a task / plan / requirement modal:
 * the list of existing attachments (image thumbnails / file chips, each
 * with download + remove) followed by a stateless upload zone
 * (click-to-pick + drag-drop; clipboard paste is handled document-wide
 * while a modal is open).
 *
 * Carries no text-entry state, so a re-render clobbers nothing — and
 * the list repaints in place via {@link refreshAttachmentSections}
 * rather than waiting for its container to be rebuilt.
 */
function buildAttachmentsSection(ownerType: AttachmentOwner, ownerId: string): HTMLElement {
    const section = document.createElement('section');
    section.className = 'attachments';
    section.setAttribute(
        ATTACHMENTS_OWNER_ATTR,
        attachmentSectionKey(ownerType, ownerId),
    );
    section.setAttribute(ATTACHMENTS_KIND_ATTR, 'input');
    const heading = document.createElement('h4');
    heading.textContent = 'Attachments';
    section.appendChild(heading);

    const list = document.createElement('div');
    list.className = 'attachments__list';
    renderAttachmentList(list, ownerType, ownerId, 'input');
    section.appendChild(list);

    section.appendChild(buildAttachmentDropzone(ownerType, ownerId));
    return section;
}

/**
 * The files a task PRODUCED, each one a download (migration 038).
 *
 * Field report: "I had a task create output, once a document and once a
 * csv file with results after checking ... I would like the output to be
 * downloadable from the task once it finished." Before this the only
 * trace of a produced file was a path quoted in the agent's report prose,
 * pointing at the worker's disk where the operator could not reach it.
 *
 * No dropzone: nothing is uploaded into this section, the harvest fills
 * it. Mounted even when empty and hidden by the repaint, so a file that
 * lands while the modal is open appears without the modal being rebuilt.
 */
function buildTaskOutputsSection(taskId: string): HTMLElement {
    const section = document.createElement('section');
    section.className = 'attachments attachments--outputs';
    section.setAttribute(
        ATTACHMENTS_OWNER_ATTR,
        attachmentSectionKey('task', taskId),
    );
    section.setAttribute(ATTACHMENTS_KIND_ATTR, 'output');
    const heading = document.createElement('h4');
    heading.textContent = 'Produced files';
    section.appendChild(heading);

    const hint = document.createElement('p');
    hint.className = 'attachments__hint';
    hint.textContent =
        'Files this task wrote to its output folder. Click to download.';
    section.appendChild(hint);

    const list = document.createElement('div');
    list.className = 'attachments__list';
    renderAttachmentList(list, 'task', taskId, 'output');
    section.appendChild(list);

    if (getAttachments('task', taskId, 'output').length === 0) {
        section.style.display = 'none';
    }
    return section;
}

function buildAttachmentCard(
    ownerType: AttachmentOwner,
    ownerId: string,
    meta: AttachmentMeta,
): HTMLElement {
    const card = document.createElement('div');
    card.className = 'attachments__card';

    const href = `${API_BASE}/api/attachments/${encodeURIComponent(meta.id)}`;
    const isImage = meta.contentType.startsWith('image/');

    const link = document.createElement('a');
    link.href = href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.className = 'attachments__preview';
    if (isImage) {
        const img = document.createElement('img');
        img.className = 'attachments__thumb';
        img.src = href;
        img.alt = meta.fileName;
        img.loading = 'lazy';
        link.appendChild(img);
    } else {
        const icon = document.createElement('span');
        icon.className = 'attachments__file-icon';
        icon.textContent = '📄';
        link.appendChild(icon);
    }
    card.appendChild(link);

    const info = document.createElement('div');
    info.className = 'attachments__meta';
    const nameLink = document.createElement('a');
    nameLink.href = href;
    nameLink.target = '_blank';
    nameLink.rel = 'noopener noreferrer';
    nameLink.className = 'attachments__name';
    nameLink.textContent = meta.fileName;
    info.appendChild(nameLink);
    const sub = document.createElement('div');
    sub.className = 'attachments__sub';
    sub.textContent = formatBytes(meta.sizeBytes);
    info.appendChild(sub);
    if (meta.caption) {
        const cap = document.createElement('div');
        cap.className = 'attachments__caption';
        cap.textContent = meta.caption;
        info.appendChild(cap);
    }
    card.appendChild(info);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'attachments__remove';
    remove.title = 'Remove attachment';
    remove.textContent = '✕';
    remove.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (window.confirm(`Remove "${meta.fileName}"?`)) {
            void deleteAttachmentById(ownerType, ownerId, meta.id);
        }
    });
    card.appendChild(remove);
    return card;
}

function buildAttachmentDropzone(ownerType: AttachmentOwner, ownerId: string): HTMLElement {
    const zone = document.createElement('div');
    zone.className = 'attachments__dropzone';

    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = ATTACHMENT_ACCEPT;
    input.className = 'attachments__file-input';
    input.style.display = 'none';
    input.addEventListener('change', () => {
        const files = input.files ? Array.from(input.files) : [];
        if (files.length > 0) void uploadAttachmentFiles(ownerType, ownerId, files);
        input.value = '';
    });

    const label = document.createElement('span');
    label.className = 'attachments__dropzone-label';
    label.textContent = 'Drop files here, paste a screenshot, or ';
    const pick = document.createElement('button');
    pick.type = 'button';
    pick.className = 'attachments__pick';
    pick.textContent = 'choose a file';
    pick.addEventListener('click', () => input.click());
    label.appendChild(pick);

    zone.appendChild(label);
    zone.appendChild(input);

    zone.addEventListener('dragover', (e) => {
        e.preventDefault();
        zone.classList.add('attachments__dropzone--over');
    });
    zone.addEventListener('dragleave', () => {
        zone.classList.remove('attachments__dropzone--over');
    });
    zone.addEventListener('drop', (e) => {
        e.preventDefault();
        zone.classList.remove('attachments__dropzone--over');
        const files = e.dataTransfer ? Array.from(e.dataTransfer.files) : [];
        if (files.length > 0) void uploadAttachmentFiles(ownerType, ownerId, files);
    });
    return zone;
}

// Document-level paste: when a task / plan modal is open and the clipboard
// holds an image (the Win+Shift+S → Ctrl+V screenshot flow), upload it to
// the open modal's owner. Installed once; a no-op when no modal is open.
document.addEventListener('paste', (e: ClipboardEvent) => {
    const target = currentAttachTarget;
    if (!target || !e.clipboardData) return;
    const files: File[] = [];
    for (const item of Array.from(e.clipboardData.items)) {
        if (item.kind === 'file') {
            const file = item.getAsFile();
            if (file) files.push(file);
        }
    }
    if (files.length > 0) {
        e.preventDefault();
        void uploadAttachmentFiles(target.ownerType, target.ownerId, files);
    }
});

// ----- connection ------------------------------------------------------

const dotEl = document.getElementById('connection-dot');
const labelEl = document.getElementById('connection-label');

function setConnectionState(state: string): void {
    if (dotEl) {
        dotEl.classList.remove('connected', 'disconnected');
        if (state === 'connected') dotEl.classList.add('connected');
        else if (state === 'disconnected') dotEl.classList.add('disconnected');
    }
    if (labelEl) {
        // Short v1-style labels: `live` reads better than `connected`
        // next to a green dot and matches the operator's mental model
        // (the SSE feed is delivering events live).
        const text
            = state === 'connected'
                ? 'live'
                : state === 'disconnected'
                    ? 'disconnected'
                    : state === 'connecting…'
                        ? 'connecting…'
                        : state;
        labelEl.textContent = text;
    }
}

function connect(): void {
    const source = new EventSource(`${API_BASE}/events`);
    source.onopen = () => setConnectionState('connected');
    // On error, probe /health before declaring the worker dead: during
    // boot the worker binds its port immediately and answers
    // {status:'starting'} while the event-log replay runs (minutes on a
    // large log). Showing "disconnected" for that window made the
    // operator kill healthy boots. EventSource does not reliably
    // auto-retry a non-stream 503, so the starting path closes the
    // source and reconnects itself.
    source.onerror = () => {
        void (async (): Promise<void> => {
            try {
                const res = await fetch(`${API_BASE}/health`, { cache: 'no-store' });
                const body = await res.json().catch(() => null) as { status?: string } | null;
                if (body?.status === 'starting') {
                    setConnectionState('worker starting…');
                    source.close();
                    window.setTimeout(connect, 3000);
                    return;
                }
            } catch {
                // Probe failed — the worker really is unreachable.
            }
            setConnectionState('disconnected');
        })();
    };
    source.onmessage = (msg) => {
        let event: StoredEvent;
        try {
            event = JSON.parse(msg.data);
        } catch {
            return;
        }
        applyEvent(event);
        // The server-side narrator appends a `system` progress note for
        // every pipeline milestone and then publishes ChatNoteAppended.
        // When one lands for the chat session that's currently open,
        // reload its thread so the new note shows immediately.
        if (event.type === 'ChatNoteAppended') {
            const sid = (event.payload as { sessionId?: unknown })?.sessionId;
            if (typeof sid === 'string') notifyChatProgress(sid);
        }
        // Streaming chunks repaint the agent modals only. Repainting the
        // whole board per token made the cards flicker and swallowed
        // clicks — a click needs mousedown and mouseup on the same
        // element, and the card was rebuilt between them.
        if (needsFullRender(event.type)) scheduleRender();
        else scheduleStreamRender();
    };
}

// ----- project / plan CRUD (mirrors web/board-crud.ts) -----------------

/** Repo entry surfaced from the project metadata blob. */
interface ProjectRowRepo {
    id: string;
    name?: string;
    url: string;
}

/**
 * Project row shape the board carries internally. Mirrors the route's
 * `ProjectRecord` minus the projection nullable + plus a few derived
 * fields (`archivedAt`, `abbr`, `color`, `description`, `repos`) lifted
 * out of the `metadata` JSON blob so callers don't have to parse it
 * every time.
 */
interface ProjectRow {
    id: string;
    name: string;
    archivedAt?: string | null;
    abbr?: string;
    color?: string;
    description?: string;
    repos?: ProjectRowRepo[];
    /**
     * The project's raw metadata blob, kept alongside the fields lifted
     * out of it.
     *
     * Load-bearing, not decorative: `ProjectUpdated` REPLACES the stored
     * metadata (`metadata = COALESCE(excluded.metadata, projects.metadata)`
     * in project-projection-store), so anything sending a partial blob
     * deletes the rest. `applyChatProjectUpdate` was already written to
     * spread this before adding its own key — but the field did not
     * exist, so the spread contributed nothing and the PATCH carried
     * `{ description }` alone. Accepting a chat description change
     * therefore wiped `abbr`, `color`, `repos` and `approvalOverride`.
     * Found by typechecking this file for the first time.
     */
    metadata?: Record<string, unknown>;
}
interface PlanRowRest {
    id: string;
    file: string;
    title: string;
    status: string;
}

interface CrudState {
    projects: ProjectRow[];
    plans: PlanRowRest[];
    selectedProjectId: string | null;
    creatingPlanForProjectId: string | null;
    editingPlanId: string | null;
    createPlanError: string | null;
    editPlanError: string | null;
    archiveProjectErrors: Record<string, string>;
}

const crudState: CrudState = {
    projects: [],
    plans: [],
    selectedProjectId: null,
    creatingPlanForProjectId: null,
    editingPlanId: null,
    createPlanError: null,
    editPlanError: null,
    archiveProjectErrors: {},
};

const projectListContainer = document.getElementById('project-list-container');
const planTreeContainer = document.getElementById('plan-tree-container');

interface CrudFetchResponse {
    ok: boolean;
    status: number;
    json: () => Promise<unknown>;
}

async function crudFetch(method: string, path: string, body?: unknown): Promise<CrudFetchResponse> {
    const init: RequestInit = { method };
    if (body !== undefined) {
        init.headers = { 'Content-Type': 'application/json' };
        init.body = JSON.stringify(body);
    }
    try {
        return (await fetch(`${API_BASE}${path}`, init)) as CrudFetchResponse;
    } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('board-ui: crud fetch failed', method, path, err);
        return { ok: false, status: 0, json: async () => ({}) };
    }
}

async function readCrudError(res: CrudFetchResponse): Promise<string> {
    try {
        const body = (await res.json()) as { error?: string; message?: string } | null;
        if (body && typeof body.error === 'string' && body.error) return body.error;
        if (body && typeof body.message === 'string' && body.message) return body.message;
    } catch {
        // fall through
    }
    return `Request failed (HTTP ${res.status || 0})`;
}

async function loadProjects(): Promise<void> {
    const res = await crudFetch('GET', '/api/projects');
    if (!res || !res.ok) return;
    // The AP-FP-004 route returns `ProjectRecord` rows with a
    // `metadata` JSON object (abbr / color / description / repos). Lift
    // the bag into top-level fields on ProjectRow so renderers + the
    // edit modal don't have to parse it on every read.
    interface RawProject {
        readonly id?: string;
        readonly name?: string | null;
        readonly metadata?: Record<string, unknown> | null;
        readonly archivedAt?: string | null;
    }
    interface RawProjectWithId extends RawProject {
        readonly id: string;
    }
    const json = (await res.json()) as { projects?: ReadonlyArray<RawProject> };
    const raw = Array.isArray(json?.projects) ? json.projects : [];
    crudState.projects = raw
        .filter((p): p is RawProjectWithId => typeof p.id === 'string' && p.id.length > 0)
        .map((p) => {
            const md = (p.metadata ?? null) as Record<string, unknown> | null;
            const abbr = typeof md?.abbr === 'string' ? md.abbr : undefined;
            const color = typeof md?.color === 'string' ? md.color : undefined;
            const description = typeof md?.description === 'string' ? md.description : undefined;
            const reposRaw = Array.isArray(md?.repos) ? (md.repos as unknown[]) : [];
            const repos: ProjectRowRepo[] = reposRaw
                .filter((r): r is { id: string; url: string; name?: string } => {
                    if (!r || typeof r !== 'object') return false;
                    const obj = r as Record<string, unknown>;
                    return (
                        typeof obj.id === 'string'
                        && obj.id.length > 0
                        && typeof obj.url === 'string'
                        && obj.url.length > 0
                    );
                })
                .map((r) => ({
                    id: r.id,
                    url: r.url,
                    ...(typeof r.name === 'string' && r.name.length > 0
                        ? { name: r.name }
                        : {}),
                }));
            return {
                id: p.id,
                name: typeof p.name === 'string' ? p.name : '',
                ...(p.archivedAt !== undefined ? { archivedAt: p.archivedAt } : {}),
                ...(abbr !== undefined ? { abbr } : {}),
                ...(color !== undefined ? { color } : {}),
                ...(description !== undefined ? { description } : {}),
                ...(repos.length > 0 ? { repos } : {}),
                // Carry the whole blob, not just the keys destructured
                // above: a partial write deletes what it omits.
                ...(md !== null ? { metadata: md } : {}),
            };
        });
    // Hydrate the persisted project filter on first load. We only apply
    // it when the selection still corresponds to a real (non-archived)
    // project — otherwise fall through to "All projects" so the board
    // does not silently filter to an empty set after the operator
    // archives the project that was selected.
    if (crudState.selectedProjectId === null) {
        const persisted = loadPersistedSelectedProjectId();
        if (persisted !== null) {
            const stillExists = crudState.projects.some(
                (p) => p.id === persisted && !p.archivedAt,
            );
            if (stillExists) {
                crudState.selectedProjectId = persisted;
                // No need to fire onSelectProject — we're inside boot,
                // before the first render, so the next scheduleRender
                // tick will pick up the filtered view automatically.
            } else {
                // Stale selection — clear it so future reloads don't
                // keep retrying a dead id.
                persistSelectedProjectId(null);
            }
        }
    }
    renderProjectList();
    scheduleRender();
}

async function loadPlans(projectId: string): Promise<void> {
    const res = await crudFetch('GET', `/api/projects/${encodeURIComponent(projectId)}/plans`);
    if (!res || !res.ok) return;
    // The AP-FP-004 route returns rows shaped as PlanRecord
    // (`{ planId, pid, name, status, updatedAt }`), but the rest of the
    // board treats plan rows as `PlanRowRest = { id, file, title,
    // status }`. Map the projection row into the board's shape here so
    // call-sites (renderPlanRow, openEditPlan, etc.) stay in the v1
    // vocabulary — `id` keys the Edit/Delete dispatches, `file` doubles
    // as the v1-style URL slug for the REST translator.
    const json = (await res.json()) as {
        plans?: ReadonlyArray<{
            planId?: string;
            name?: string | null;
            status?: string | null;
        }>;
    };
    const raw = Array.isArray(json?.plans) ? json.plans : [];
    crudState.plans = raw
        .filter((p): p is { planId: string; name?: string | null; status?: string | null } =>
            typeof p.planId === 'string' && p.planId.length > 0)
        .map((p) => ({
            id: p.planId,
            file: p.planId,
            title: typeof p.name === 'string' ? p.name : '',
            status: typeof p.status === 'string' ? p.status : 'draft',
        }));
    renderPlanTree();
}

async function onSelectProject(projectId: string): Promise<void> {
    crudState.selectedProjectId = projectId;
    crudState.plans = [];
    crudState.creatingPlanForProjectId = null;
    crudState.editingPlanId = null;
    persistSelectedProjectId(projectId);
    renderProjectList();
    renderPlanTree();
    // The project filter affects every renderer that surfaces plans,
    // tasks, or per-plan agent cards. scheduleRender() is the single
    // entry point that re-runs all of them on the next paint.
    scheduleRender();
    // AP-VP5-014 — mount / re-target the per-project notes panel in the
    // sidebar so the operator can see and edit notes for the active
    // project without leaving the board.
    mountNotesPanelForProject(projectId);
    await loadPlans(projectId);
}

/**
 * Handler for the "All projects" pseudo-row at the top of the sidebar.
 * Sets `selectedProjectId` to null so every project-scoped renderer
 * surfaces everything; mirrors `onSelectProject`'s side effects (clears
 * the legacy plan-tree state, persists the selection, re-renders).
 */
function onSelectAllProjects(): void {
    crudState.selectedProjectId = null;
    crudState.plans = [];
    crudState.creatingPlanForProjectId = null;
    crudState.editingPlanId = null;
    persistSelectedProjectId(null);
    renderProjectList();
    renderPlanTree();
    scheduleRender();
}

/**
 * Persist the operator's project selection so a page reload re-applies
 * the same filter. Falls back to localStorage; quietly no-ops when the
 * storage API is unavailable (private browsing edge cases).
 */
const SELECTED_PROJECT_STORAGE_KEY = 'board.selectedProjectId';
function persistSelectedProjectId(projectId: string | null): void {
    try {
        if (projectId === null) {
            window.localStorage.removeItem(SELECTED_PROJECT_STORAGE_KEY);
        } else {
            window.localStorage.setItem(SELECTED_PROJECT_STORAGE_KEY, projectId);
        }
    } catch {
        // ignore: storage disabled in this context
    }
}

function loadPersistedSelectedProjectId(): string | null {
    try {
        const raw = window.localStorage.getItem(SELECTED_PROJECT_STORAGE_KEY);
        if (typeof raw === 'string' && raw.length > 0) return raw;
    } catch {
        // ignore
    }
    return null;
}

async function onArchiveProject(projectId: string): Promise<void> {
    if (crudState.archiveProjectErrors[projectId]) {
        delete crudState.archiveProjectErrors[projectId];
        renderProjectList();
    }
    // DELETE → ArchiveProject command (soft delete). PATCH-with-
    // `archived: true` previously routed to UpdateProject, which
    // doesn't know about an `archived` field and silently no-op'd, so
    // the button looked broken.
    const res = await crudFetch(
        'DELETE',
        `/api/projects/${encodeURIComponent(projectId)}`,
    );
    if (!res || !res.ok) {
        crudState.archiveProjectErrors[projectId] = await readCrudError(res);
        renderProjectList();
        return;
    }
    await loadProjects();
}

async function onCreatePlan(
    projectId: string,
    input: {
        title: string;
        body?: string;
        metadata?: Record<string, unknown>;
        planId?: string;
    },
): Promise<void> {
    const body: Record<string, unknown> = { title: input.title };
    if (input.body) body.body = input.body;
    if (input.metadata !== undefined) body.metadata = input.metadata;
    // The "Save & run planner" path pre-mints a planId so it can fire
    // GeneratePlan against the same key without waiting on the SSE
    // projection round-trip. The REST shim accepts it on
    // CreatePlanPayload.planId; absent, the worker-api mints one.
    if (input.planId !== undefined) body.planId = input.planId;
    const res = await crudFetch(
        'POST',
        `/api/projects/${encodeURIComponent(projectId)}/plans`,
        body,
    );
    if (!res || !res.ok) {
        crudState.createPlanError = await readCrudError(res);
        renderPlanTree();
        return;
    }
    crudState.creatingPlanForProjectId = null;
    crudState.createPlanError = null;
    await loadPlans(projectId);
}

async function onUpdatePlan(
    projectId: string,
    planFile: string,
    input: { title?: string; body?: string; metadata?: Record<string, unknown> },
): Promise<void> {
    const body: Record<string, unknown> = {};
    if (input.title !== undefined) body.title = input.title;
    if (input.body !== undefined) body.body = input.body;
    if (input.metadata !== undefined) body.metadata = input.metadata;
    const res = await crudFetch(
        'PATCH',
        `/api/projects/${encodeURIComponent(projectId)}/plans/${encodeURIComponent(planFile)}`,
        body,
    );
    if (!res || !res.ok) {
        crudState.editPlanError = await readCrudError(res);
        renderPlanTree();
        return;
    }
    crudState.editingPlanId = null;
    crudState.editPlanError = null;
    await loadPlans(projectId);
}

async function onDeletePlan(projectId: string, planFile: string): Promise<void> {
    const res = await crudFetch(
        'DELETE',
        `/api/projects/${encodeURIComponent(projectId)}/plans/${encodeURIComponent(planFile)}`,
    );
    if (!res || !res.ok) {
        crudState.editPlanError = await readCrudError(res);
        renderPlanTree();
        return;
    }
    await loadPlans(projectId);
}

function makeCrudFormError(scope: string, message: string | null): HTMLElement {
    const slot = document.createElement('div');
    slot.className = 'form-error';
    slot.setAttribute('data-error-for', scope);
    slot.setAttribute('role', 'alert');
    if (message) slot.textContent = message;
    else slot.hidden = true;
    return slot;
}

function makeCrudButton(label: string, action: string, onClick: () => void): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('data-action', action);
    btn.textContent = label;
    btn.addEventListener('click', (e) => {
        e.preventDefault();
        onClick();
    });
    return btn;
}

function makeCrudInput(name: string, placeholder: string, required: boolean): HTMLInputElement {
    const input = document.createElement('input');
    input.type = 'text';
    input.name = name;
    input.setAttribute('data-field', name);
    input.placeholder = placeholder;
    if (required) input.required = true;
    return input;
}

function makeCrudTextarea(name: string, placeholder: string): HTMLTextAreaElement {
    const ta = document.createElement('textarea');
    ta.name = name;
    ta.setAttribute('data-field', name);
    ta.placeholder = placeholder;
    return ta;
}

function renderCreateProjectForm(): HTMLButtonElement {
    // AP-IFB-006: the inline 2-field form has been removed; clicking the
    // sidebar's Create button now opens the AP-IFB-004 new-project modal
    // (full V1 field set — name, abbr, slug, description, colour, repos)
    // via the overlay manager.
    return makeCrudButton('+ New project', 'open-new-project', () => {
        openNewProject();
    });
}

function renderEditProjectButton(): HTMLLIElement {
    const slot = document.createElement('li');
    slot.className = 'project-edit';
    slot.setAttribute('data-slot', 'edit-project');
    const selectedId = crudState.selectedProjectId;
    const selected = selectedId
        ? crudState.projects.find((p) => p.id === selectedId) ?? null
        : null;
    const btn = makeCrudButton('Edit project', 'open-edit-project', () => {
        if (!selected) return;
        openEditProject(selected);
    });
    // Architecture context sits beside Edit: same scope (the selected
    // project), different kind of content — prose the design-side agents
    // read, rather than fields the board renders.
    const contextBtn = makeCrudButton('Context', 'open-project-context', () => {
        if (!selected) return;
        openProjectContext(selected);
    });
    if (!selected) {
        contextBtn.disabled = true;
    }
    if (!selected) {
        // AC #5: hidden when no project is selected. `hidden` keeps the
        // slot in the DOM so layout stays stable across selection changes.
        slot.hidden = true;
        slot.setAttribute('data-hidden', 'no-selection');
        btn.disabled = true;
    }
    slot.appendChild(btn);
    slot.appendChild(contextBtn);
    return slot;
}

function renderProjectRow(project: ProjectRow): HTMLLIElement {
    const row = document.createElement('li');
    row.className = 'project-row';
    row.setAttribute('data-project-row', '');
    row.setAttribute('data-project-id', project.id);
    row.setAttribute('role', 'button');
    row.setAttribute('tabindex', '0');
    if (project.id === crudState.selectedProjectId) {
        row.classList.add('project-row--selected');
        row.setAttribute('data-selected', 'true');
    }
    if (project.archivedAt) row.setAttribute('data-archived', 'true');

    // Color dot on the left. Uses `project.color` (set in the project
    // modal); falls back to a neutral grey when unset so the slot keeps
    // its width and the name stays aligned across the column.
    const dot = document.createElement('span');
    dot.className = 'project-row__dot';
    dot.setAttribute('aria-hidden', 'true');
    if (project.color) {
        dot.style.backgroundColor = project.color;
    }
    row.appendChild(dot);

    const name = document.createElement('span');
    name.className = 'project-name';
    name.setAttribute('data-project-name', '');
    name.textContent = project.name;
    row.appendChild(name);

    // Archive affordance — small × icon that surfaces on row hover.
    // Active projects only; archived rows stay in the list but the
    // icon is omitted (no destructive action on something already
    // soft-deleted).
    if (!project.archivedAt) {
        const archive = document.createElement('button');
        archive.type = 'button';
        archive.className = 'project-row__archive';
        archive.setAttribute('data-action', 'archive-project');
        archive.setAttribute('aria-label', `Archive ${project.name}`);
        archive.textContent = '×';
        archive.addEventListener('click', (e) => {
            // Don't let the click bubble to the row's select handler.
            e.stopPropagation();
            void onArchiveProject(project.id);
        });
        row.appendChild(archive);
    }

    // Whole row selects the project. Keyboard parity via Enter/Space
    // on the focused row.
    row.addEventListener('click', () => {
        void onSelectProject(project.id);
    });
    row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            void onSelectProject(project.id);
        }
    });

    const archiveError = crudState.archiveProjectErrors[project.id];
    if (archiveError) {
        const slot = document.createElement('span');
        slot.className = 'project-row-error';
        slot.setAttribute('data-error-for', 'archive-project');
        slot.setAttribute('data-project-id', project.id);
        slot.setAttribute('role', 'alert');
        slot.textContent = archiveError;
        row.appendChild(slot);
    }
    return row;
}

/**
 * Render the "All projects" pseudo-row at the top of the sidebar.
 * Clicking it sets `selectedProjectId` to null, which every
 * project-scoped renderer treats as "no filter — show everything".
 * Styled as a project row but with a sentinel data attribute and no
 * archive affordance, so the existing project-row CSS reuses cleanly.
 */
function renderAllProjectsRow(): HTMLLIElement {
    const row = document.createElement('li');
    row.className = 'project-row project-row--all';
    row.setAttribute('data-project-row', 'all');
    row.setAttribute('data-project-id', '__all__');
    row.setAttribute('role', 'button');
    row.setAttribute('tabindex', '0');
    if (crudState.selectedProjectId === null) {
        row.classList.add('project-row--selected');
        row.setAttribute('data-selected', 'true');
    }

    const dot = document.createElement('span');
    dot.className = 'project-row__dot project-row__dot--all';
    dot.setAttribute('aria-hidden', 'true');
    row.appendChild(dot);

    const name = document.createElement('span');
    name.className = 'project-name';
    name.textContent = 'All projects';
    row.appendChild(name);

    row.addEventListener('click', () => onSelectAllProjects());
    row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onSelectAllProjects();
        }
    });
    return row;
}

function renderProjectList(): void {
    if (!projectListContainer) return;
    projectListContainer.replaceChildren();
    const root = document.createElement('ul');
    root.className = 'project-list';
    root.setAttribute('data-project-list', '');

    // "All projects" sits at the top of the list as a pseudo-row.
    root.appendChild(renderAllProjectsRow());

    const active = crudState.projects.filter((p) => !p.archivedAt);
    const archived = crudState.projects.filter((p) => !!p.archivedAt);
    for (const p of active) root.appendChild(renderProjectRow(p));
    if (archived.length > 0) {
        const header = document.createElement('li');
        header.className = 'project-archived-header';
        header.setAttribute('data-section', 'archived');
        header.textContent = 'Archived';
        root.appendChild(header);
        for (const p of archived) root.appendChild(renderProjectRow(p));
    }

    const createSlot = document.createElement('li');
    createSlot.className = 'project-create';
    createSlot.appendChild(renderCreateProjectForm());
    root.appendChild(createSlot);
    root.appendChild(renderEditProjectButton());
    projectListContainer.appendChild(root);
}

function renderEditPlanForm(plan: PlanRowRest, projectId: string): HTMLFormElement {
    const form = document.createElement('form');
    form.className = 'plan-edit-form';
    form.setAttribute('data-action', 'edit-plan');
    form.setAttribute('data-plan-id', plan.id);
    form.setAttribute('data-plan-file', plan.file);
    form.setAttribute('data-project-id', projectId);
    const titleInput = makeCrudInput('title', 'Plan title', false);
    titleInput.value = plan.title || '';
    const bodyInput = makeCrudTextarea('body', 'Plan body (optional)');
    form.appendChild(titleInput);
    form.appendChild(bodyInput);
    form.appendChild(makeCrudFormError('edit-plan', crudState.editPlanError));
    const submit = (): void => {
        const title = titleInput.value.trim();
        const body = bodyInput.value.trim();
        const input: { title?: string; body?: string } = {};
        if (title && title !== plan.title) input.title = title;
        if (body) input.body = body;
        void onUpdatePlan(projectId, plan.file, input);
    };
    form.appendChild(makeCrudButton('Save', 'submit-edit-plan', submit));
    form.appendChild(
        makeCrudButton('Cancel', 'cancel-edit-plan', () => {
            crudState.editingPlanId = null;
            crudState.editPlanError = null;
            renderPlanTree();
        }),
    );
    form.addEventListener('submit', (e) => {
        e.preventDefault();
        submit();
    });
    return form;
}

function renderPlanRow(plan: PlanRowRest, projectId: string): HTMLLIElement {
    const row = document.createElement('li');
    row.className = 'plan-row';
    row.setAttribute('data-plan-row', '');
    row.setAttribute('data-plan-id', plan.id);
    row.setAttribute('data-plan-file', plan.file);
    if (crudState.editingPlanId === plan.id) {
        row.appendChild(renderEditPlanForm(plan, projectId));
        return row;
    }
    const title = document.createElement('span');
    title.className = 'plan-title';
    title.setAttribute('data-plan-title', '');
    title.textContent = plan.title;
    row.appendChild(title);

    const status = document.createElement('span');
    status.className = 'plan-status';
    status.setAttribute('data-plan-status', '');
    status.textContent = plan.status;
    row.appendChild(status);

    // Planner-running badge + Show agent button surface when the
    // operator has fired the planner for this plan. Badge text reflects
    // the lifecycle state (running / complete / failed); the button
    // opens the agent stream modal so the operator can watch the
    // Claude CLI assistant text live.
    const planner = activePlanners.get(plan.id);
    if (planner) {
        const badge = document.createElement('span');
        badge.className = `plan-planner-badge plan-planner-badge--${planner.status}`;
        badge.setAttribute('data-plan-planner-badge', planner.status);
        badge.textContent
            = planner.status === 'running'
                ? '🤖 Planner running'
                : planner.status === 'complete'
                    ? '✓ Planner done'
                    : `✗ Planner failed`;
        row.appendChild(badge);
        row.appendChild(
            makeCrudButton('Show agent', 'show-planner-agent', () => {
                openShowPlannerAgentModal(plan.id);
            }),
        );
    }

    row.appendChild(
        makeCrudButton('Edit', 'edit-plan', () => {
            // Reuse the new-plan modal in edit mode rather than rendering
            // the v0 inline title+body form. The modal carries the full
            // V1 field set (plan type, target repo, tech stack, deploy
            // toggles, conventions) — edit mode fires
            // `commands.planReview.fetchPlan(projectId, planId)` on open
            // and pre-fills title + body from the fresh projection record
            // (not the possibly-stale `PlanRowRest` we have on the row).
            const project = crudState.projects.find((p) => p.id === projectId) ?? null;
            ensureOverlayRoot();
            const repoList = repoOptionsForProject(project);
            newPlanModal.open(projectId, {
                projectName: project?.name,
                ...(project?.abbr !== undefined ? { projectAbbr: project.abbr } : {}),
                ...(repoList.length > 0 ? { projectRepos: repoList } : {}),
                existing: {
                    planId: plan.id,
                    planFile: plan.file,
                },
            });
        }),
    );
    row.appendChild(
        makeCrudButton('Delete', 'delete-plan', () => void onDeletePlan(projectId, plan.file)),
    );
    return row;
}

function renderPlanTree(): void {
    if (!planTreeContainer) return;
    planTreeContainer.replaceChildren();
    const projectId = crudState.selectedProjectId;
    if (!projectId) return;

    const root = document.createElement('ul');
    root.className = 'plan-tree';
    root.setAttribute('data-plan-tree', '');
    root.setAttribute('data-project-id', projectId);
    for (const p of crudState.plans) root.appendChild(renderPlanRow(p, projectId));

    const createSlot = document.createElement('li');
    createSlot.className = 'plan-create';
    createSlot.appendChild(
        makeCrudButton('+ Create plan', 'begin-create-plan', () => {
            openNewPlan(projectId);
        }),
    );
    root.appendChild(createSlot);
    planTreeContainer.appendChild(root);
}

if (projectListContainer) {
    renderProjectList();
    void loadProjects();
}

// Re-paint active-planner cards across a page reload. Without this the
// `activePlanners` Map starts empty on every boot and any planner whose
// draft is sitting in the projection — waiting on the operator's
// approve/regenerate — vanishes from the main area until a fresh live
// event re-seeds it. The endpoint returns only plans that have a
// PlanGenerated revision AND no PlanDecomposed yet, so a card never
// pops back after the decomposer has fired.
void hydrateActivePlanners();

// Same pattern as `hydrateActivePlanners` but for decomposer runs.
// `/api/active-decomposers` derives the live roster from the event log:
// `AgentStarted` events stamped `metadata.kind='decomposer'` minus the
// ones with a matching terminal `AgentFinished` / `AgentFailed`. Without
// this hydration, refreshing the board while a decomposer is running
// hides the card until a fresh live event arrives — but no fresh event
// fires because the spawn happened in the previous session.
void hydrateActiveDecomposers();

async function hydrateActiveDecomposers(): Promise<void> {
    interface ActiveEntry {
        readonly planId?: string;
        readonly projectId?: string;
        readonly agentId?: string;
        readonly startedAt?: number;
        readonly status?: string;
        readonly question?: string;
        readonly options?: unknown;
        readonly askedAt?: number;
    }
    try {
        const res = await fetch(`${API_BASE}/api/active-decomposers`);
        if (!res.ok) return;
        const json = (await res.json()) as { decomposers?: ActiveEntry[] };
        const entries = Array.isArray(json.decomposers) ? json.decomposers : [];
        let seeded = 0;
        for (const entry of entries) {
            if (typeof entry.planId !== 'string' || entry.planId.length === 0) continue;
            if (typeof entry.agentId !== 'string' || entry.agentId.length === 0) continue;
            // Don't trample a row already populated by a live event
            // that arrived before this fetch resolved.
            if (activeDecomposers.has(entry.planId)) continue;
            const startedAt
                = typeof entry.startedAt === 'number' ? entry.startedAt : Date.now();
            const projectId
                = typeof entry.projectId === 'string' ? entry.projectId : '';
            // A run held on a question is restored as such — without this
            // the card came back reading "running" for an agent that had
            // already exited, and the Answer button (the only way to move
            // the plan forward) never appeared after a reload.
            const awaiting
                = entry.status === 'awaiting' && typeof entry.question === 'string'
                    && entry.question.length > 0;
            const askedAt
                = typeof entry.askedAt === 'number' ? entry.askedAt : startedAt;
            activeDecomposers.set(entry.planId, {
                planId: entry.planId,
                projectId,
                agentId: entry.agentId,
                startedAt,
                chunks: [],
                activities: [
                    {
                        at: startedAt,
                        category: 'lifecycle',
                        detail: 'restored from event log',
                    },
                    ...(awaiting
                        ? [{
                            at: askedAt,
                            category: 'lifecycle',
                            detail: `asked the operator · ${truncate(entry.question!, 160)}`,
                        }]
                        : []),
                ],
                status: awaiting ? 'awaiting' : 'running',
                ...(awaiting
                    ? {
                        question: entry.question!,
                        questionOptions: Array.isArray(entry.options)
                            ? entry.options.filter(
                                (o): o is string => typeof o === 'string' && o.length > 0,
                            )
                            : [],
                        askedAt,
                    }
                    : {}),
            });
            seeded += 1;
        }
        if (seeded > 0) scheduleRender();
    } catch {
        // Network blip or worker-api down — fall through quietly.
        // Live events resume the moment SSE reconnects.
    }
}

async function hydrateActivePlanners(): Promise<void> {
    interface PendingEntry {
        readonly planId?: string;
        readonly projectId?: string;
        readonly revision?: number;
        readonly content?: string;
        readonly generatedAt?: number;
    }
    try {
        const res = await fetch(`${API_BASE}/api/plan-reviews`);
        if (!res.ok) return;
        const json = (await res.json()) as { entries?: PendingEntry[] };
        const entries = Array.isArray(json.entries) ? json.entries : [];
        let seeded = 0;
        for (const entry of entries) {
            if (typeof entry.planId !== 'string' || entry.planId.length === 0) continue;
            if (typeof entry.projectId !== 'string' || entry.projectId.length === 0) continue;
            // Seed the latest-revision tracker so classifyPlan can put
            // this plan into the Ready section across a reload. This
            // runs even when the active-planner card is already live
            // (the next branch skips the rest of the iteration).
            // Content-guarded (belt to listPending's braces): an empty
            // dispatch-time revision must never mark a plan Ready.
            if (
                typeof entry.revision === 'number' && entry.revision > 0
                && typeof entry.content === 'string' && entry.content.length > 0
            ) {
                const prior = planLatestRevision.get(entry.planId) ?? 0;
                if (entry.revision > prior) {
                    planLatestRevision.set(entry.planId, entry.revision);
                }
            }
            // Cache the planner output too — the plan modal needs it
            // to render the implementation plan in place of the brief.
            if (typeof entry.content === 'string' && entry.content.length > 0) {
                planReviewContent.set(entry.planId, entry.content);
            }
            // NOTE: finished drafts are deliberately NOT resurrected as
            // "complete" Active-planner cards any more. The plan renders
            // under Ready (classifyPlan reads the revision tracker seeded
            // above) — the old resurrection double-displayed every
            // reviewed-but-undecomposed plan after a reload, the same
            // done-but-still-listed card the live fold now removes on
            // AgentFinished.
            seeded += 1;
        }
        if (seeded > 0) scheduleRender();
    } catch {
        // Network blip or worker-api down — fall through quietly.
        // Live events resume the moment SSE reconnects.
    }
}

// ---------- AP-VP5-014 — per-project notes panel sidebar mount ----------
//
// The AP-VP5-013 notes panel renders its own chrome (header, composer,
// list) under whichever container we hand it. Index.html only ships
// the Phase 1 sidebar sections (projects, context-updates, plans), so
// we synthesise a `.sidebar-notes` host on first use and slot it in
// after the context-updates section — that puts it above the plan
// tree and above the live plans stream, which matches the v1 "notes
// live near the top of the project surface" placement.
//
// One panel handle is cached on the module so re-selecting projects
// just calls `setProjectId(...)` (which clears local state + reloads
// the list) rather than tearing down and rebuilding the DOM. The
// markdown port is bridged from the existing `renderMarkdown` (used by
// plan cards) so notes get the same heading / list / paragraph
// rendering the rest of the board uses.

let notesPanelHandle: ReturnType<typeof initNotesPanel> | null = null;
let notesPanelHost: HTMLElement | null = null;

function ensureNotesPanelHost(): HTMLElement | null {
    if (notesPanelHost) return notesPanelHost;
    const sidebar = document.querySelector('aside.sidebar') as HTMLElement | null;
    if (!sidebar) return null;
    const section = document.createElement('section');
    section.className = 'notes';
    section.setAttribute('id', 'notes-section');
    section.setAttribute('aria-label', 'Project notes');
    const heading = document.createElement('h2');
    heading.textContent = 'Notes';
    section.appendChild(heading);
    const container = document.createElement('div');
    container.setAttribute('id', 'notes-panel-container');
    container.setAttribute('aria-live', 'polite');
    section.appendChild(container);
    // Slot the notes section between the context-updates section and the
    // plans section so the operator's "things I jotted down for this
    // project" surface sits next to "things needing my eyes right now".
    const plansSection = sidebar.querySelector('#plans-section');
    if (plansSection && plansSection.parentNode === sidebar) {
        sidebar.insertBefore(section, plansSection);
    } else {
        sidebar.appendChild(section);
    }
    notesPanelHost = container;
    return container;
}

function mountNotesPanelForProject(projectId: string): void {
    const host = ensureNotesPanelHost();
    if (!host) return;
    if (notesPanelHandle) {
        void notesPanelHandle.setProjectId(projectId);
        return;
    }
    notesPanelHandle = initNotesPanel(host as never, projectId, {
        fetch: ((url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) =>
            fetch(url, init as RequestInit)) as never,
        // Bridge the live-DOM `renderMarkdown(text)` (returns Node[])
        // onto the panel's structural element surface. The notes-panel
        // module just stitches the returned nodes into a parent via
        // appendChild, which the real DOM accepts directly.
        renderMarkdown: ((text: string) =>
            renderMarkdown(text) as unknown as ReadonlyArray<never>) as never,
        apiBase: API_BASE,
        actor: 'operator',
        onError: (err: Error) => {
            // eslint-disable-next-line no-console
            console.warn('board-ui: notes panel error', err);
        },
    });
    void notesPanelHandle.load();
}

// ----- context-update curator panel (mirrors web/context-updates.ts) ---

interface ContextUpdateEntry {
    taskId: string;
    summary?: string;
    prNumber?: number;
    planId?: string;
}

const contextUpdatesState = {
    pending: [] as ContextUpdateEntry[],
    loadError: null as string | null,
    dispatchErrors: {} as Record<string, string>,
    inFlight: new Set<string>(),
};

const contextUpdatesContainer = document.getElementById('context-updates-container');

async function loadContextUpdatesPending(): Promise<void> {
    let res: Response;
    try {
        res = await fetch(`${API_BASE}/context-updates/pending`, { method: 'GET' });
    } catch (err) {
        contextUpdatesState.loadError =
            err && (err as Error).message ? (err as Error).message : String(err);
        renderContextUpdates();
        return;
    }
    if (!res.ok) {
        contextUpdatesState.loadError = await readContextUpdateError(res);
        renderContextUpdates();
        return;
    }
    let json: { pending?: ContextUpdateEntry[] } = {};
    try {
        json = await res.json();
    } catch {
        json = {};
    }
    // Narrow through a local: `Array.isArray(json && json.pending)` tests
    // the expression, not the property, so it never narrowed
    // `json.pending` itself.
    const pending = json.pending;
    contextUpdatesState.pending = Array.isArray(pending) ? pending : [];
    contextUpdatesState.loadError = null;
    renderContextUpdates();
}

async function readContextUpdateError(res: Response): Promise<string> {
    try {
        const body = (await res.json()) as { error?: string; message?: string };
        if (body && typeof body.error === 'string' && body.error) return body.error;
        if (body && typeof body.message === 'string' && body.message) return body.message;
    } catch {
        // fall through
    }
    return `Request failed (HTTP ${res.status || 0})`;
}

async function dispatchContextUpdate(taskId: string, action: string): Promise<void> {
    delete contextUpdatesState.dispatchErrors[taskId];
    contextUpdatesState.inFlight.add(taskId);
    renderContextUpdates();
    const url = `${API_BASE}/tasks/${encodeURIComponent(taskId)}/context-update/${action}`;
    let res: Response;
    try {
        res = await fetch(url, { method: 'POST' });
    } catch (err) {
        contextUpdatesState.dispatchErrors[taskId] =
            err && (err as Error).message ? (err as Error).message : String(err);
        contextUpdatesState.inFlight.delete(taskId);
        renderContextUpdates();
        return;
    }
    if (!res.ok) {
        contextUpdatesState.dispatchErrors[taskId] = await readContextUpdateError(res);
        contextUpdatesState.inFlight.delete(taskId);
        renderContextUpdates();
        return;
    }
    contextUpdatesState.inFlight.delete(taskId);
    await loadContextUpdatesPending();
}

function makeContextUpdateButton(
    label: string,
    action: string,
    taskId: string,
    disabled: boolean,
): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('data-action', action);
    btn.textContent = label;
    if (disabled) {
        btn.disabled = true;
        btn.setAttribute('aria-busy', 'true');
    }
    btn.addEventListener('click', (e) => {
        e.preventDefault();
        if (btn.disabled) return;
        const verb = action === 'run-context-update' ? 'run' : 'skip';
        void dispatchContextUpdate(taskId, verb);
    });
    return btn;
}

function renderContextUpdates(): void {
    if (!contextUpdatesContainer) return;
    contextUpdatesContainer.replaceChildren();
    const root = document.createElement('ul');
    root.className = 'context-updates';
    root.setAttribute('data-context-updates', '');

    if (contextUpdatesState.loadError) {
        const slot = document.createElement('li');
        slot.className = 'context-updates-error';
        slot.setAttribute('data-error-for', 'load');
        slot.setAttribute('role', 'alert');
        slot.textContent = contextUpdatesState.loadError;
        root.appendChild(slot);
    }

    if (contextUpdatesState.pending.length === 0 && !contextUpdatesState.loadError) {
        const empty = document.createElement('li');
        empty.className = 'context-updates-empty';
        empty.setAttribute('data-empty', '');
        empty.textContent = 'No pending context updates';
        root.appendChild(empty);
        contextUpdatesContainer.appendChild(root);
        return;
    }

    for (const entry of contextUpdatesState.pending) {
        if (!entry || typeof entry.taskId !== 'string') continue;
        const row = document.createElement('li');
        row.className = 'context-update-row';
        row.setAttribute('data-context-update-row', '');
        row.setAttribute('data-task-id', entry.taskId);

        const summary = document.createElement('span');
        summary.className = 'context-update-summary';
        summary.setAttribute('data-context-update-summary', '');
        summary.textContent = typeof entry.summary === 'string' ? entry.summary : '';
        row.appendChild(summary);

        if (typeof entry.prNumber === 'number' && entry.prNumber > 0) {
            const pr = document.createElement('span');
            pr.className = 'context-update-pr';
            pr.setAttribute('data-context-update-pr', '');
            pr.textContent = `PR #${entry.prNumber}`;
            row.appendChild(pr);
        }
        if (entry.planId) {
            const plan = document.createElement('span');
            plan.className = 'context-update-plan';
            plan.setAttribute('data-context-update-plan', '');
            plan.textContent = String(entry.planId);
            row.appendChild(plan);
        }

        const busy = contextUpdatesState.inFlight.has(entry.taskId);
        row.appendChild(
            makeContextUpdateButton('Run', 'run-context-update', entry.taskId, busy),
        );
        row.appendChild(
            makeContextUpdateButton('Skip', 'skip-context-update', entry.taskId, busy),
        );

        const dispatchError = contextUpdatesState.dispatchErrors[entry.taskId];
        if (dispatchError) {
            const slot = document.createElement('span');
            slot.className = 'form-error';
            slot.setAttribute('data-error-for', 'dispatch');
            slot.setAttribute('data-task-id', entry.taskId);
            slot.setAttribute('role', 'alert');
            slot.textContent = dispatchError;
            row.appendChild(slot);
        }

        root.appendChild(row);
    }
    contextUpdatesContainer.appendChild(root);
}

if (contextUpdatesContainer) {
    renderContextUpdates();
    void loadContextUpdatesPending();
}

// ----- modal wiring (AP-IFF-019) ---------------------------------------
//
// Each open* helper below builds the dependency bag the typed module
// expects (overlay-manager singleton, dispatch port that POSTs through
// /commands, fetch + EventSource adapters) and forwards to the imported
// entry point. The dependency wiring stays here; the modal's UX,
// keyboard handling, focus management, and dispatch payload shaping all
// live in the typed source — see `client/modals/<name>.ts`.

function ensureOverlayRoot(): HTMLElement {
    let root = document.getElementById('overlay-root');
    if (!root) {
        root = document.createElement('div');
        root.id = 'overlay-root';
        document.body.appendChild(root);
    }
    return root;
}

function ensureToastRoot(): void {
    if (!document.getElementById('toast-root')) {
        const t = document.createElement('div');
        t.id = 'toast-root';
        document.body.appendChild(t);
    }
}

// The overlay-manager singleton attaches its own document-level Escape
// listener on construction (see client/chrome/overlay-manager.ts) — it
// closes the topmost overlay automatically. No additional keydown
// handler is wired here.

// --- new-plan ---
// The typed module's command-sink expects createPlan to resolve with the
// new plan's id (used to key the decompose-status poll) and updatePlan
// to resolve void; the projection route methods are named
// fetchDecomposeStatus / fetchPlanReview / regeneratePlanReview /
// approvePlan. `regeneratePlanReview` and `approvePlan` forward the
// modal's body (operator feedback / approved content + conventions) to
// the worker-api so the backend can dispatch GeneratePlan (revision N+1)
// or DecomposePlan with the right payload.
const newPlanModal = createNewPlanModal({
    planTypes: () => planArchetypes,
    overlayManager,
    commands: {
        async createPlan(input) {
            await onCreatePlan(input.projectId, {
                title: input.title,
                body: input.body,
                metadata: input.metadata as Record<string, unknown> | undefined,
                ...(input.planId !== undefined ? { planId: input.planId } : {}),
            });
            // When the caller pre-minted a planId (the "Save & run
            // planner" path), echo it back so the subsequent
            // GeneratePlan dispatch keys on the same value. Otherwise
            // the board's REST shim doesn't echo back the worker-minted
            // id; the modal degrades to the no-poll close-with-toast
            // path on that branch.
            return { planId: input.planId ?? '' };
        },
        async updatePlan(input) {
            // The Edit button on Draft plan cards opens this modal
            // without the sidebar's project selection being primed,
            // so fall back to the plan row's projectId (we already
            // hydrate it on the PlanRow from /api/plans). This makes
            // the save work regardless of how the modal was opened.
            const planRow = plans.get(input.planId);
            const projectId
                = planRow?.projectId || crudState.selectedProjectId || '';
            await onUpdatePlan(projectId, input.planId, {
                title: input.title,
                body: input.body,
                metadata: input.metadata as Record<string, unknown> | undefined,
            });
        },
        async generatePlan(input: {
            projectId: string;
            planId: string;
            briefContent?: string;
            revision: number;
        }) {
            // Operator-fired planner run. POST to the new REST route
            // that translates into a `GeneratePlan` command; the
            // orchestrator dispatches the Claude CLI planner and emits
            // PlanGenerated when the agent finishes. Returns 202 — the
            // planner runs asynchronously.
            const url = `${API_BASE}/api/projects/${encodeURIComponent(input.projectId)}/plans/${encodeURIComponent(input.planId)}/generate-plan`;
            const body: Record<string, unknown> = { revision: input.revision };
            if (input.briefContent !== undefined) {
                body.briefContent = input.briefContent;
            }
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (!res.ok) {
                throw new Error(
                    `GeneratePlan dispatch failed: HTTP ${res.status}`,
                );
            }
        },
    },
    planReview: {
        async fetchPlan(projectId, planId) {
            // Guard the empty-id case the same way the other planReview
            // methods do — if either id is empty, short-circuit to `null`
            // so the modal treats it as "no record" without firing a
            // request that would 404.
            if (!projectId || !planId) return null;
            const url = `${API_BASE}/api/projects/${encodeURIComponent(projectId)}/plans/${encodeURIComponent(planId)}`;
            const res = await fetch(url);
            if (res.status === 404) return null;
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const json = (await res.json()) as {
                plan?: {
                    name?: string | null;
                    body?: string | null;
                    metadata?: Record<string, unknown> | null;
                };
            };
            const plan = json.plan;
            if (!plan) return null;
            return {
                title: typeof plan.name === 'string' ? plan.name : undefined,
                body: typeof plan.body === 'string' ? plan.body : undefined,
                // The wire passes the metadata bag through unchanged —
                // the modal narrows to its own NewPlanMetadata shape and
                // ignores fields it doesn't know how to render.
                metadata: plan.metadata ?? undefined,
            };
        },
        async fetchDecomposeStatus(projectId, planId) {
            // Guard against an empty planId — the new-plan modal can briefly
            // sit in `np-planning` state before a planId is minted, and
            // without this short-circuit the poll fires
            // `GET /api/projects/<pid>/plans//decompose-status` which 404s
            // and pollutes the console. Returning an `idle` shape keeps the
            // modal state machine where it is until a real planId arrives.
            if (!projectId || !planId) {
                return { status: 'idle' } as never;
            }
            const url = `${API_BASE}/api/projects/${encodeURIComponent(projectId)}/plans/${encodeURIComponent(planId)}/decompose-status`;
            const res = await fetch(url);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return (await res.json()) as never;
        },
        async fetchPlanReview(projectId, planId) {
            if (!projectId || !planId) {
                return { status: 'idle' } as never;
            }
            const url = `${API_BASE}/api/projects/${encodeURIComponent(projectId)}/plans/${encodeURIComponent(planId)}/plan-review`;
            const res = await fetch(url);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return (await res.json()) as never;
        },
        async regeneratePlanReview(projectId, planId, body) {
            if (!projectId || !planId) return;
            const url = `${API_BASE}/api/projects/${encodeURIComponent(projectId)}/plans/${encodeURIComponent(planId)}/plan-review/regenerate`;
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body ?? {}),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
        },
        async approvePlan(projectId, planId, body) {
            if (!projectId || !planId) return;
            const url = `${API_BASE}/api/projects/${encodeURIComponent(projectId)}/plans/${encodeURIComponent(planId)}/plan-review/approve`;
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body ?? {}),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
        },
    },
    showToast: (input) => showToast({ message: input.message, kind: input.kind }),
    // Migration 021: upload an operator-picked file to a freshly-created
    // plan. Throws on a non-2xx so the modal's per-file counter is
    // accurate. Same raw-binary POST the plan/task modals use.
    async uploadPlanAttachment(planId: string, file: File): Promise<void> {
        const name = file.name && file.name.length > 0 ? file.name : 'attachment';
        const params = new URLSearchParams({ ownerType: 'plan', ownerId: planId, name });
        const res = await fetch(`${API_BASE}/api/attachments?${params.toString()}`, {
            method: 'POST',
            headers: { 'Content-Type': file.type || 'application/octet-stream' },
            body: file,
        });
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw new Error(`attachment upload failed: ${res.status} ${text}`.trim());
        }
    },
});

function openNewPlan(projectId: string | null): void {
    const target = projectId || crudState.selectedProjectId;
    if (!target) {
        showToast({ message: 'Select a project before creating a plan.', kind: 'error' });
        return;
    }
    ensureOverlayRoot();
    const project = crudState.projects.find((p) => p.id === target) ?? null;
    // Target repo dropdown — scoped to the project's declared repos (see
    // repoOptionsForProject). The planner / decomposer pre-spawn refresh
    // keys off the chosen repoId.
    const repoList = repoOptionsForProject(project);
    newPlanModal.open(target, {
        projectName: project?.name,
        ...(project?.abbr !== undefined ? { projectAbbr: project.abbr } : {}),
        ...(repoList.length > 0 ? { projectRepos: repoList } : {}),
    });
}

// --- new-project (AP-PAO-014) ---
// The AP-IFB-004 modal owns the full V1 form (name, abbr, slug, description,
// colour, repos). The command-sink dispatches a CreateProject command over
// the existing /commands bus (per BOARD_UI_COMMAND_ROUTES) — the orchestrator
// handler emits ProjectCreated, and the SSE projection updates the sidebar
// list. The server-side payload validator only enforces name/projectId
// today; extra V1 fields (abbr, color, repos) pass through unchecked so the
// wiring layer can light them up incrementally without a modal rework.
//
// `sendCommandOrThrow` (not the swallowing `sendCommand`) is used here so a
// failed dispatch rejects the createProject promise — the modal's async port
// contract requires that to transition to `np-error` and surface a toast.
const newProjectModal = createNewProjectModal({
    overlayManager,
    getWorkspaceRepos: () =>
        Array.from(repos.values())
            .filter((r) => r.archivedAt === null)
            .map((r) => ({ id: r.repoId, name: r.name, url: r.url })),
    commands: {
        async createProject(input) {
            // Wrap abbr / color / description / repos under `metadata`
            // so the projection's JSON column captures them. Previously
            // these were sent as top-level keys and the handler
            // silently dropped them — abbr/repos never reached the
            // edit-project modal's pre-fill path.
            const metadata: Record<string, unknown> = {};
            if (input.abbr) metadata.abbr = input.abbr;
            if (input.color) metadata.color = input.color;
            if (input.description) metadata.description = input.description;
            if (input.repos.length > 0) metadata.repos = input.repos;
            const payload: Record<string, unknown> = {
                projectId: input.projectId,
                name: input.name,
            };
            if (input.description) payload.description = input.description;
            if (Object.keys(metadata).length > 0) payload.metadata = metadata;
            await sendCommandOrThrow({
                type: 'CreateProject',
                actor: 'operator',
                issuedAt: Date.now(),
                payload,
            });
            return { projectId: input.projectId };
        },
    },
    showToast: (input) => showToast({ message: input.message, kind: input.kind }),
});

function openNewProject(): void {
    ensureOverlayRoot();
    newProjectModal.open();
}

// --- edit-project (AP-IFB-006) ---
// The AP-IFB-005 modal pre-populates from the supplied project. The
// sidebar's project list only carries `{ id, name, archivedAt }` today,
// so abbr/description/colour/repos start blank; the modal handles
// missing optional fields by leaving the inputs empty. Submit dispatches
// to PATCH /api/projects/:pid — the URL pid is the lookup key, so
// renaming the slug from inside the modal is not yet wired through.
const editProjectModal = createEditProjectModal({
    overlayManager,
    knownStepKinds,
    getWorkspaceRepos: () =>
        Array.from(repos.values())
            .filter((r) => r.archivedAt === null)
            .map((r) => ({ id: r.repoId, name: r.name, url: r.url })),
    commands: {
        async updateProject(input) {
            // Same metadata-wrapping convention as createProject — the
            // projection's `metadata` JSON column receives the
            // abbr/color/description/repos bag verbatim.
            const metadata: Record<string, unknown> = {};
            if (input.abbr) metadata.abbr = input.abbr;
            if (input.color) metadata.color = input.color;
            if (input.description) metadata.description = input.description;
            if (input.repos.length > 0) metadata.repos = input.repos;
            const body: Record<string, unknown> = {
                projectId: input.projectId,
                name: input.name,
            };
            if (input.description) body.description = input.description;
            if (Object.keys(metadata).length > 0) body.metadata = metadata;
            const res = await crudFetch(
                'PATCH',
                `/api/projects/${encodeURIComponent(input.originalProjectId)}`,
                body,
            );
            if (!res || !res.ok) throw new Error(await readCrudError(res));
            await loadProjects();
            return { projectId: input.projectId };
        },
    },
    showToast: (input) => showToast({ message: input.message, kind: input.kind }),
});

// --- project architecture context ---------------------------------------
//
// Reads/writes `projects.context_md` through worker-api's
// proxy to the manager-api (the single config writer). The same text is
// handed to the planner, decomposer and architect as `# Project context`.
const projectContextModal = createProjectContextModal({
    load: async (projectId) => {
        const res = await crudFetch(
            'GET',
            `/api/projects/${encodeURIComponent(projectId)}/context-md`,
        );
        return {
            ok: res.ok,
            status: res.status,
            body: (await res.json().catch(() => ({}))) as {
                content?: string;
                etag?: string;
                error?: string;
            },
        };
    },
    save: async (projectId, content, etag) => {
        const res = await crudFetch(
            'PUT',
            `/api/projects/${encodeURIComponent(projectId)}/context-md`,
            etag ? { content, etag } : { content },
        );
        return {
            ok: res.ok,
            status: res.status,
            body: (await res.json().catch(() => ({}))) as {
                etag?: string;
                error?: string;
                code?: string;
            },
        };
    },
    openOverlay: (id, panel) => overlayManager.openOverlay(id, panel),
    closeOverlay: (id) => overlayManager.closeOverlay(id),
});

function openProjectContext(project: ProjectRow): void {
    ensureOverlayRoot();
    void projectContextModal.open({
        projectId: project.id,
        ...(project.name ? { projectName: project.name } : {}),
    });
}

function openEditProject(project: ProjectRow): void {
    ensureOverlayRoot();
    editProjectModal.open({
        projectId: project.id,
        name: project.name,
        ...(project.abbr !== undefined ? { abbr: project.abbr } : {}),
        ...(project.color !== undefined ? { color: project.color } : {}),
        ...(project.description !== undefined ? { description: project.description } : {}),
        repos: project.repos ?? [],
    });
}

// --- show planner agent modal -------------------------------------------
//
// Inline (board.ts-owned) modal that streams the active planner's
// assistant text. Reads from `activePlanners.get(planId).chunks` —
// already kept up-to-date by `applyPlannerEvent` — and listens to the
// global SSE-driven re-render trigger (`scheduleRender`) so newly
// appended chunks land in the modal's body without a manual subscribe.
//
// Lifecycle is hooked through the shared `overlayManager` so Escape /
// stack ordering still works (overlay-manager.ts). The element is
// removed on close because the manager only flips aria-hidden; we
// mirror the convention of new-project / clarify modals.
const SHOW_PLANNER_AGENT_OVERLAY_ID = 'show-planner-agent';
let showPlannerAgentBody: HTMLElement | null = null;
let showPlannerAgentTitle: HTMLElement | null = null;
let showPlannerAgentStatus: HTMLElement | null = null;
let showPlannerAgentPanel: HTMLElement | null = null;
let showPlannerAgentBackdrop: HTMLElement | null = null;
let showPlannerAgentPlanId: string | null = null;
let showPlannerAgentStopBtn: HTMLButtonElement | null = null;
let showPlannerAgentTickInterval: ReturnType<typeof setInterval> | null = null;

function openShowPlannerAgentModal(planId: string): void {
    // Re-opening: tear down the previous panel first so the overlay
    // manager's stack stays consistent.
    if (showPlannerAgentBackdrop !== null) closeShowPlannerAgentModal();
    const root = ensureOverlayRoot();
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-chrome__overlay';
    backdrop.setAttribute('data-show-planner-agent-overlay', '');
    const panel = document.createElement('div');
    panel.className = 'show-planner-agent-modal modal-chrome';
    panel.setAttribute('data-show-planner-agent-modal', '');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-labelledby', 'show-planner-agent-title');
    panel.setAttribute('data-plan-id', planId);

    const header = document.createElement('div');
    header.className = 'modal-chrome__header';
    const heading = document.createElement('h3');
    heading.className = 'modal-chrome__title';
    heading.setAttribute('id', 'show-planner-agent-title');
    header.appendChild(heading);
    const status = document.createElement('span');
    status.className = 'show-planner-agent-status';
    status.setAttribute('data-show-planner-agent-status', '');
    header.appendChild(status);
    // Stop agent — visible while running, dispatches CancelAgentRun
    // with the planner's agentId. The orchestrator's existing
    // CancelAgentRun handler signals the live process; AgentFinished
    // (with outcome === 'interrupted') follows. Hidden once the
    // planner reaches a terminal state.
    const stopBtn = document.createElement('button');
    stopBtn.className
        = 'show-planner-agent-stop active-planner-card__action active-planner-card__action--danger';
    stopBtn.setAttribute('type', 'button');
    stopBtn.setAttribute('data-action', 'stop-planner');
    stopBtn.textContent = 'Stop agent';
    stopBtn.addEventListener('click', () => {
        void requestStopPlanner(planId);
    });
    header.appendChild(stopBtn);
    showPlannerAgentStopBtn = stopBtn;

    const closeBtn = document.createElement('button');
    closeBtn.className = 'modal-chrome__close';
    closeBtn.setAttribute('type', 'button');
    closeBtn.setAttribute('data-action', 'close');
    closeBtn.textContent = 'Close';
    closeBtn.addEventListener('click', closeShowPlannerAgentModal);
    header.appendChild(closeBtn);
    panel.appendChild(header);

    const body = document.createElement('div');
    body.className = 'show-planner-agent-body modal-chrome__body';
    body.setAttribute('data-show-planner-agent-body', '');
    panel.appendChild(body);

    backdrop.appendChild(panel);
    root.appendChild(backdrop);
    overlayManager.openOverlay(SHOW_PLANNER_AGENT_OVERLAY_ID, panel);

    showPlannerAgentBackdrop = backdrop;
    showPlannerAgentPanel = panel;
    showPlannerAgentBody = body;
    showPlannerAgentTitle = heading;
    showPlannerAgentStatus = status;
    showPlannerAgentPlanId = planId;
    // 1s tick so the elapsed-time line in the body stays current even
    // when no SSE events have arrived recently (the planner is often
    // quiet for tens of seconds while claude thinks before emitting
    // its single assistant envelope). Cleared on close so a closed
    // modal doesn't leak a timer.
    if (showPlannerAgentTickInterval !== null) {
        clearInterval(showPlannerAgentTickInterval);
    }
    showPlannerAgentTickInterval = setInterval(() => {
        refreshShowPlannerAgentModal();
    }, 1000);
    refreshShowPlannerAgentModal();
}

function closeShowPlannerAgentModal(): void {
    if (showPlannerAgentBackdrop === null) return;
    overlayManager.closeOverlay(SHOW_PLANNER_AGENT_OVERLAY_ID);
    showPlannerAgentBackdrop.remove();
    showPlannerAgentBackdrop = null;
    showPlannerAgentPanel = null;
    showPlannerAgentBody = null;
    showPlannerAgentTitle = null;
    showPlannerAgentStatus = null;
    showPlannerAgentPlanId = null;
    showPlannerAgentStopBtn = null;
    if (showPlannerAgentTickInterval !== null) {
        clearInterval(showPlannerAgentTickInterval);
        showPlannerAgentTickInterval = null;
    }
}

// --- Show decomposer agent modal --------------------------------------
//
// Same chrome and rendering pipeline as the planner Show-agent modal,
// scoped to {@link activeDecomposers}. The two cannot share a single
// open modal at the same time today (one global ref per modal), but
// they coexist in the overlay-manager stack so opening one while the
// other is open just stacks both with Escape closing the topmost.

const SHOW_DECOMPOSER_AGENT_OVERLAY_ID = 'show-decomposer-agent';
let showDecomposerAgentBody: HTMLElement | null = null;
let showDecomposerAgentTitle: HTMLElement | null = null;
let showDecomposerAgentStatus: HTMLElement | null = null;
let showDecomposerAgentBackdrop: HTMLElement | null = null;
let showDecomposerAgentPlanId: string | null = null;
let showDecomposerAgentStopBtn: HTMLButtonElement | null = null;
let showDecomposerAgentTickInterval: ReturnType<typeof setInterval> | null = null;

function openShowDecomposerAgentModal(planId: string): void {
    if (showDecomposerAgentBackdrop !== null) closeShowDecomposerAgentModal();
    const root = ensureOverlayRoot();
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-chrome__overlay';
    backdrop.setAttribute('data-show-decomposer-agent-overlay', '');
    const panel = document.createElement('div');
    panel.className = 'show-planner-agent-modal show-decomposer-agent-modal modal-chrome';
    panel.setAttribute('data-show-decomposer-agent-modal', '');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-labelledby', 'show-decomposer-agent-title');
    panel.setAttribute('data-plan-id', planId);

    const header = document.createElement('div');
    header.className = 'modal-chrome__header';
    const heading = document.createElement('h3');
    heading.className = 'modal-chrome__title';
    heading.setAttribute('id', 'show-decomposer-agent-title');
    header.appendChild(heading);
    const status = document.createElement('span');
    status.className = 'show-planner-agent-status';
    status.setAttribute('data-show-decomposer-agent-status', '');
    header.appendChild(status);

    const stopBtn = document.createElement('button');
    stopBtn.className
        = 'show-planner-agent-stop active-planner-card__action active-planner-card__action--danger';
    stopBtn.setAttribute('type', 'button');
    stopBtn.setAttribute('data-action', 'stop-decomposer');
    stopBtn.textContent = 'Stop agent';
    stopBtn.addEventListener('click', () => {
        void requestStopDecomposer(planId);
    });
    header.appendChild(stopBtn);
    showDecomposerAgentStopBtn = stopBtn;

    const closeBtn = document.createElement('button');
    closeBtn.className = 'modal-chrome__close';
    closeBtn.setAttribute('type', 'button');
    closeBtn.setAttribute('data-action', 'close');
    closeBtn.textContent = 'Close';
    closeBtn.addEventListener('click', closeShowDecomposerAgentModal);
    header.appendChild(closeBtn);
    panel.appendChild(header);

    const body = document.createElement('div');
    body.className = 'show-planner-agent-body modal-chrome__body';
    body.setAttribute('data-show-decomposer-agent-body', '');
    panel.appendChild(body);

    backdrop.appendChild(panel);
    root.appendChild(backdrop);
    overlayManager.openOverlay(SHOW_DECOMPOSER_AGENT_OVERLAY_ID, panel);

    showDecomposerAgentBackdrop = backdrop;
    showDecomposerAgentBody = body;
    showDecomposerAgentTitle = heading;
    showDecomposerAgentStatus = status;
    showDecomposerAgentPlanId = planId;
    if (showDecomposerAgentTickInterval !== null) {
        clearInterval(showDecomposerAgentTickInterval);
    }
    showDecomposerAgentTickInterval = setInterval(() => {
        refreshShowDecomposerAgentModal();
    }, 1000);
    refreshShowDecomposerAgentModal();
}

function closeShowDecomposerAgentModal(): void {
    if (showDecomposerAgentBackdrop === null) return;
    overlayManager.closeOverlay(SHOW_DECOMPOSER_AGENT_OVERLAY_ID);
    showDecomposerAgentBackdrop.remove();
    showDecomposerAgentBackdrop = null;
    showDecomposerAgentBody = null;
    showDecomposerAgentTitle = null;
    showDecomposerAgentStatus = null;
    showDecomposerAgentPlanId = null;
    showDecomposerAgentStopBtn = null;
    if (showDecomposerAgentTickInterval !== null) {
        clearInterval(showDecomposerAgentTickInterval);
        showDecomposerAgentTickInterval = null;
    }
}

function refreshShowDecomposerAgentModal(): void {
    if (
        showDecomposerAgentBody === null
        || showDecomposerAgentPlanId === null
        || showDecomposerAgentTitle === null
        || showDecomposerAgentStatus === null
    ) {
        return;
    }
    const planId = showDecomposerAgentPlanId;
    const dec = activeDecomposers.get(planId);
    const plan = plans.get(planId);
    const titleText = plan?.title ?? planId;
    showDecomposerAgentTitle.textContent
        = `Decomposer — ${titleText}${dec?.model ? ` · ${dec.model}` : ''}`;
    if (!dec) {
        showDecomposerAgentStatus.textContent = '(no active run)';
        showDecomposerAgentBody.textContent = '';
        if (showDecomposerAgentStopBtn) showDecomposerAgentStopBtn.hidden = true;
        return;
    }
    if (showDecomposerAgentStopBtn) {
        showDecomposerAgentStopBtn.hidden = dec.status !== 'running';
    }
    showDecomposerAgentStatus.textContent
        = dec.status === 'running'
            ? `running · ${formatElapsed(elapsedFor(dec))}`
            : dec.status === 'complete'
                ? `complete · ${formatElapsed(elapsedFor(dec))}`
                : `failed${dec.error ? ` · ${dec.error}` : ''}`;
    renderShowDecomposerAgentBody(showDecomposerAgentBody, dec);
    // The agent run is over — stop the 1s ticker so the elapsed
    // display freezes and the modal stops re-rendering. Re-opens
    // restart a fresh interval that immediately stops again on the
    // first refresh tick.
    if (dec.status !== 'running' && showDecomposerAgentTickInterval !== null) {
        clearInterval(showDecomposerAgentTickInterval);
        showDecomposerAgentTickInterval = null;
    }
}

/**
 * Time the operator has been waiting on this lifecycle agent. For a
 * running row that's `now - startedAt`; for a finished row it's
 * frozen at `finishedAt - startedAt` so the Show-agent modal's timer
 * stops climbing the moment the agent reaches a terminal state.
 */
function elapsedFor(
    row: { startedAt: number; finishedAt?: number; status: string },
): number {
    const end
        = row.status !== 'running' && typeof row.finishedAt === 'number'
            ? row.finishedAt
            : Date.now();
    return Math.max(0, end - row.startedAt);
}

function renderShowDecomposerAgentBody(
    body: HTMLElement,
    dec: ActiveDecomposer,
): void {
    const elapsed = formatElapsed(elapsedFor(dec));
    const statusLabel
        = dec.status === 'running'
            ? `running · ${elapsed}`
            : dec.status === 'complete'
                ? `complete · ${elapsed}`
                : `failed${dec.error ? ` · ${dec.error}` : ''}`;

    const header = document.createElement('div');
    header.className = `stream-header stream-header--${dec.status}`;
    header.textContent = `● Decomposer ${statusLabel}`;

    const children: HTMLElement[] = [header];
    if (dec.activities.length === 0) {
        const idle = document.createElement('div');
        idle.className = 'stream-idle';
        idle.textContent
            = dec.status === 'running'
                ? '(waiting for the first event — claude is starting up)'
                : '(no activity captured)';
        children.push(idle);
    } else {
        if (dec.activities.length >= ACTIVE_PLANNER_ACTIVITY_LIMIT) {
            const elide = document.createElement('div');
            elide.className = 'stream-elide';
            elide.textContent = '(earlier activity elided — buffer capped)';
            children.push(elide);
        }
        for (const entry of dec.activities) {
            children.push(renderActivityRow(entry));
        }
    }
    applyStreamChildren(body, children);
}

async function requestStopDecomposer(planId: string): Promise<void> {
    const dec = activeDecomposers.get(planId);
    if (!dec || dec.status !== 'running' || dec.agentId.length === 0) return;
    try {
        const res = await fetch(`${API_BASE}/commands`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                type: 'CancelAgentRun',
                actor: 'operator',
                issuedAt: Date.now(),
                // `runId` is the wire name `isCancelAgentRunPayload`
                // accepts; the previous `agentId` field was the v1 name
                // and the validator rejected it as `invalid payload`,
                // so the orchestrator never reached the agent killer
                // and the Stop button silently no-op'd with a 500.
                payload: { runId: dec.agentId, reason: 'operator stopped' },
            }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        showToast({ message: 'Decomposer stop requested.', kind: 'info' });
    } catch (err) {
        showToast({
            message:
                err instanceof Error
                    ? `Stop failed: ${err.message}`
                    : 'Stop failed',
            kind: 'error',
        });
    }
}

// --- Show task agent modal -------------------------------------------
//
// Same chrome and rendering primitives as the planner Show-agent modal,
// scoped to {@link taskAgents}. Opening the modal for a task whose
// agent is still running gives the operator a live activity feed and a
// Stop button that fires CancelAgentRun against the runtime agent id.
// Completed/failed runs keep the modal accessible so the operator can
// re-read the agent's transcript after the fact.

const SHOW_TASK_AGENT_OVERLAY_ID = 'show-task-agent';
let showTaskAgentBody: HTMLElement | null = null;
let showTaskAgentTitle: HTMLElement | null = null;
let showTaskAgentStatus: HTMLElement | null = null;
let showTaskAgentBackdrop: HTMLElement | null = null;
let showTaskAgentTaskId: string | null = null;
let showTaskAgentStopBtn: HTMLButtonElement | null = null;
let showTaskAgentTickInterval: ReturnType<typeof setInterval> | null = null;

function openShowTaskAgentModal(taskId: string): void {
    if (showTaskAgentBackdrop !== null) closeShowTaskAgentModal();
    const root = ensureOverlayRoot();
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-chrome__overlay';
    backdrop.setAttribute('data-show-task-agent-overlay', '');
    const panel = document.createElement('div');
    panel.className = 'show-planner-agent-modal show-task-agent-modal modal-chrome';
    panel.setAttribute('data-show-task-agent-modal', '');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-labelledby', 'show-task-agent-title');
    panel.setAttribute('data-task-id', taskId);

    const header = document.createElement('div');
    header.className = 'modal-chrome__header';
    const heading = document.createElement('h3');
    heading.className = 'modal-chrome__title';
    heading.setAttribute('id', 'show-task-agent-title');
    header.appendChild(heading);
    const status = document.createElement('span');
    status.className = 'show-planner-agent-status';
    status.setAttribute('data-show-task-agent-status', '');
    header.appendChild(status);

    const stopBtn = document.createElement('button');
    stopBtn.className
        = 'show-planner-agent-stop active-planner-card__action active-planner-card__action--danger';
    stopBtn.setAttribute('type', 'button');
    stopBtn.setAttribute('data-action', 'stop-task-agent');
    stopBtn.textContent = 'Stop agent';
    stopBtn.addEventListener('click', () => {
        void requestStopTaskAgent(taskId);
    });
    header.appendChild(stopBtn);
    showTaskAgentStopBtn = stopBtn;

    const closeBtn = document.createElement('button');
    closeBtn.className = 'modal-chrome__close';
    closeBtn.setAttribute('type', 'button');
    closeBtn.setAttribute('data-action', 'close');
    closeBtn.textContent = 'Close';
    closeBtn.addEventListener('click', closeShowTaskAgentModal);
    header.appendChild(closeBtn);
    panel.appendChild(header);

    const body = document.createElement('div');
    body.className = 'show-planner-agent-body modal-chrome__body';
    body.setAttribute('data-show-task-agent-body', '');
    panel.appendChild(body);

    backdrop.appendChild(panel);
    root.appendChild(backdrop);
    overlayManager.openOverlay(SHOW_TASK_AGENT_OVERLAY_ID, panel);

    showTaskAgentBackdrop = backdrop;
    showTaskAgentBody = body;
    showTaskAgentTitle = heading;
    showTaskAgentStatus = status;
    showTaskAgentTaskId = taskId;
    if (showTaskAgentTickInterval !== null) {
        clearInterval(showTaskAgentTickInterval);
    }
    showTaskAgentTickInterval = setInterval(() => {
        refreshShowTaskAgentModal();
    }, 1000);
    refreshShowTaskAgentModal();
}

function closeShowTaskAgentModal(): void {
    if (showTaskAgentBackdrop === null) return;
    overlayManager.closeOverlay(SHOW_TASK_AGENT_OVERLAY_ID);
    showTaskAgentBackdrop.remove();
    showTaskAgentBackdrop = null;
    showTaskAgentBody = null;
    showTaskAgentTitle = null;
    showTaskAgentStatus = null;
    showTaskAgentTaskId = null;
    showTaskAgentStopBtn = null;
    if (showTaskAgentTickInterval !== null) {
        clearInterval(showTaskAgentTickInterval);
        showTaskAgentTickInterval = null;
    }
}

function refreshShowTaskAgentModal(): void {
    if (
        showTaskAgentBody === null
        || showTaskAgentTaskId === null
        || showTaskAgentTitle === null
        || showTaskAgentStatus === null
    ) {
        return;
    }
    const taskId = showTaskAgentTaskId;
    const task = tasks.get(taskId);
    const run = taskAgents.get(taskId);
    const titleText = task?.title ?? taskId;
    showTaskAgentTitle.textContent = `${run?.role ?? 'Agent'} — ${titleText}`;
    if (!run) {
        showTaskAgentStatus.textContent = '(no active run)';
        showTaskAgentBody.textContent = '';
        if (showTaskAgentStopBtn) showTaskAgentStopBtn.hidden = true;
        return;
    }
    if (showTaskAgentStopBtn) {
        showTaskAgentStopBtn.hidden = run.status !== 'running';
    }
    const statusLabel
        = run.status === 'running'
            ? '● running'
            : run.status === 'complete'
                ? '✓ complete'
                : `✗ failed${run.error ? `: ${run.error}` : ''}`;
    showTaskAgentStatus.textContent = statusLabel;
    showTaskAgentStatus.setAttribute('data-show-task-agent-status', run.status);
    renderShowTaskAgentBody(showTaskAgentBody, run);
    if (run.status !== 'running' && showTaskAgentTickInterval !== null) {
        clearInterval(showTaskAgentTickInterval);
        showTaskAgentTickInterval = null;
    }
}

// Reuses {@link renderActivityRow} + {@link applyStreamChildren} from
// the planner renderer, so the row markup (stamp · label · detail ·
// optional extra `<pre>`) and the sticky-bottom scroll behaviour are
// identical between planner / decomposer / task modals.
function renderShowTaskAgentBody(body: HTMLElement, run: TaskAgentRun): void {
    const elapsed = formatElapsed(Math.max(0, Date.now() - run.startedAt));
    const statusLabel
        = run.status === 'running'
            ? `running · ${elapsed}`
            : run.status === 'complete'
                ? `complete · ${elapsed}`
                : `failed${run.error ? ` · ${run.error}` : ''}`;
    const header = document.createElement('div');
    header.className = `stream-header stream-header--${run.status}`;
    header.textContent = `● ${run.role || 'Agent'} ${statusLabel}`;
    const children: HTMLElement[] = [header];
    if (run.activities.length === 0) {
        const idle = document.createElement('div');
        idle.className = 'stream-idle';
        idle.textContent
            = run.status === 'running'
                ? '(waiting for the first event — claude is starting up)'
                : '(no activity captured)';
        children.push(idle);
    } else {
        if (run.activities.length >= ACTIVE_PLANNER_ACTIVITY_LIMIT) {
            const elide = document.createElement('div');
            elide.className = 'stream-elide';
            elide.textContent = '(earlier activity elided — buffer capped)';
            children.push(elide);
        }
        for (const entry of run.activities) {
            children.push(renderActivityRow(entry));
        }
    }
    applyStreamChildren(body, children);
}

// --- Per-step summary modal ------------------------------------------
//
// Triggered by clicking a stage-bar chip on a task card. Reads the
// freshest `TaskStepRecord` for (taskId, stepId) — the durable
// projection is hydrated on boot and updated live, so a chip that has
// a colour always has a record. On open the modal fetches the latest
// row from `/api/tasks/:taskId/step-summaries` so a summary that
// landed after the in-memory copy was last updated (e.g. another
// browser tab) shows correctly.

const SHOW_TASK_STEP_SUMMARY_OVERLAY_ID = 'show-task-step-summary';
let showTaskStepSummaryBackdrop: HTMLElement | null = null;

function closeTaskStepSummaryModal(): void {
    if (!showTaskStepSummaryBackdrop) return;
    overlayManager.closeOverlay(SHOW_TASK_STEP_SUMMARY_OVERLAY_ID);
    showTaskStepSummaryBackdrop.remove();
    showTaskStepSummaryBackdrop = null;
}

function openTaskStepSummaryModal(
    taskId: string,
    stage: string,
    initial: TaskStepRecord,
): void {
    if (showTaskStepSummaryBackdrop !== null) closeTaskStepSummaryModal();

    const root = ensureOverlayRoot();
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-chrome__overlay';
    backdrop.setAttribute('data-task-step-summary-overlay', '');

    const panel = document.createElement('div');
    panel.className = 'show-planner-agent-modal task-step-summary-modal modal-chrome';
    panel.setAttribute('data-task-step-summary-modal', '');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('data-task-id', taskId);
    panel.setAttribute('data-step-id', initial.stepId);

    const header = document.createElement('div');
    header.className = 'modal-chrome__header';

    const title = document.createElement('h3');
    title.className = 'modal-chrome__title';
    const task = tasks.get(taskId);
    const taskTitle = task?.title ?? taskId;
    const label = PIPELINE_STAGE_LABEL[stage] ?? initial.role ?? initial.stepId;
    title.textContent = `${label} — ${taskTitle}`;
    header.appendChild(title);

    const status = document.createElement('span');
    status.className = 'show-planner-agent-status';
    status.setAttribute(
        'data-show-task-step-summary-status',
        initial.status,
    );
    status.textContent = statusLabelForStep(initial);
    header.appendChild(status);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'modal-chrome__close';
    closeBtn.setAttribute('type', 'button');
    closeBtn.setAttribute('data-action', 'close');
    closeBtn.textContent = 'Close';
    closeBtn.addEventListener('click', closeTaskStepSummaryModal);
    header.appendChild(closeBtn);
    panel.appendChild(header);

    const body = document.createElement('div');
    body.className = 'show-planner-agent-body modal-chrome__body';
    body.setAttribute('data-task-step-summary-body', '');
    renderTaskStepSummaryBody(body, initial);
    panel.appendChild(body);

    backdrop.appendChild(panel);
    root.appendChild(backdrop);
    overlayManager.openOverlay(SHOW_TASK_STEP_SUMMARY_OVERLAY_ID, panel);
    showTaskStepSummaryBackdrop = backdrop;

    // Refresh against the server so the summary reflects the freshest
    // row. A running step in another tab may have just finished; this
    // catch-up read pulls the final summary text without a reload.
    void refreshTaskStepSummary(taskId, initial.stepId, body, status);
}

async function refreshTaskStepSummary(
    taskId: string,
    stepId: string,
    body: HTMLElement,
    status: HTMLElement,
): Promise<void> {
    try {
        const res = await fetch(
            `${API_BASE}/api/tasks/${encodeURIComponent(taskId)}/step-summaries`,
        );
        if (!res.ok) return;
        const json = (await res.json()) as { steps?: TaskStepRecord[] };
        const list = Array.isArray(json.steps) ? json.steps : [];
        const fresh = list.find((s) => s.stepId === stepId);
        if (!fresh) return;
        setTaskStepRecord(taskId, fresh);
        if (!showTaskStepSummaryBackdrop) return;
        status.setAttribute('data-show-task-step-summary-status', fresh.status);
        status.textContent = statusLabelForStep(fresh);
        renderTaskStepSummaryBody(body, fresh);
    } catch {
        // Network blip — initial state stays on screen.
    }
}

function statusLabelForStep(rec: TaskStepRecord): string {
    const elapsedMs = rec.finishedAt
        ? rec.finishedAt - rec.startedAt
        : Date.now() - rec.startedAt;
    const elapsed = formatElapsed(Math.max(0, elapsedMs));
    if (rec.status === 'running') return `● running · ${elapsed}`;
    if (rec.status === 'failed') return `✗ failed · ${elapsed}`;
    return `✓ complete · ${elapsed}`;
}

function renderTaskStepSummaryBody(body: HTMLElement, rec: TaskStepRecord): void {
    body.replaceChildren();
    if (rec.summary && rec.summary.length > 0) {
        const pre = document.createElement('pre');
        pre.className = 'task-step-summary-text';
        pre.textContent = rec.summary;
        body.appendChild(pre);
        return;
    }
    const empty = document.createElement('div');
    empty.className = 'stream-idle';
    empty.textContent
        = rec.status === 'running'
            ? '(agent still running — summary will appear once it finishes)'
            : '(no transcript captured for this step)';
    body.appendChild(empty);
}

async function requestStopTaskAgent(taskId: string): Promise<void> {
    // The running/finished/unknown-run distinction lives in
    // `decideStopAgent` so it is tested rather than re-litigated here:
    // conflating an EMPTY run id with a finished agent is what told an
    // operator a live tester had already finished.
    const decision = decideStopAgent(taskAgents.get(taskId));
    if (decision.kind !== 'cancel') {
        showToast({
            message: decision.message,
            kind: decision.kind === 'finished' ? 'info' : 'error',
        });
        return;
    }
    try {
        const res = await fetch(`${API_BASE}/commands`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                type: 'CancelAgentRun',
                actor: 'operator',
                issuedAt: Date.now(),
                payload: { runId: decision.agentId, reason: 'operator stopped' },
            }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        showToast({ message: 'Stop signal sent.', kind: 'info' });
    } catch (err) {
        showToast({
            message:
                err instanceof Error
                    ? `Stop failed: ${err.message}`
                    : 'Stop failed',
            kind: 'error',
        });
    }
}

/**
 * Update the open Show-planner-agent modal in place with the current
 * activePlanners state for its plan id. Called from `scheduleRender`'s
 * paint pass so live AgentProgress chunks land in the modal body
 * without a per-event subscribe.
 */
function refreshShowPlannerAgentModal(): void {
    if (
        showPlannerAgentBody === null
        || showPlannerAgentPlanId === null
        || showPlannerAgentTitle === null
        || showPlannerAgentStatus === null
    ) {
        return;
    }
    const planId = showPlannerAgentPlanId;
    const planner = activePlanners.get(planId);
    const plan = plans.get(planId);
    const titleText = plan?.title ?? planId;
    showPlannerAgentTitle.textContent
        = `Planner — ${titleText}${planner?.model ? ` · ${planner.model}` : ''}`;
    if (!planner) {
        showPlannerAgentStatus.textContent = '(no active run)';
        showPlannerAgentBody.textContent = '';
        if (showPlannerAgentStopBtn) showPlannerAgentStopBtn.hidden = true;
        return;
    }
    // Stop button only makes sense while the agent is in-flight —
    // hide it on terminal states so the operator can't click it after
    // the process is already gone.
    if (showPlannerAgentStopBtn) {
        showPlannerAgentStopBtn.hidden = planner.status !== 'running';
    }
    const statusLabel
        = planner.status === 'running'
            ? '● running'
            : planner.status === 'complete'
                ? '✓ complete'
                : `✗ failed${planner.error ? `: ${planner.error}` : ''}`;
    showPlannerAgentStatus.textContent = statusLabel;
    showPlannerAgentStatus.setAttribute(
        'data-show-planner-agent-status',
        planner.status,
    );
    // Render the activity feed as a series of DOM rows so each event
    // can carry its own styling (lifecycle / system / tool_use /
    // tool_result / thinking / assistant / stderr). Mirrors v1's
    // per-event row layout in `pipeline/board/board.js#renderStreamEvent`.
    // We rebuild from scratch on every refresh — cheap for a few
    // hundred rows and avoids needing to track per-row diff state.
    renderShowPlannerAgentBody(showPlannerAgentBody, planner);
    // Silence the "panel unused" lint hint — used during open() to
    // anchor a future per-state class toggle without re-querying.
    void showPlannerAgentPanel;
    // Stop the 1s ticker once the planner has reached a terminal
    // state — see {@link refreshShowDecomposerAgentModal} for the
    // matching guard on the sister modal.
    if (planner.status !== 'running' && showPlannerAgentTickInterval !== null) {
        clearInterval(showPlannerAgentTickInterval);
        showPlannerAgentTickInterval = null;
    }
}

/**
 * Render the Show-agent body for a planner row. Builds a fresh DOM
 * subtree on every call — one `<div>` per activity entry. Mirrors
 * v1's `renderStreamEvent` (pipeline/board/board.js) where each
 * event category gets its own row class so the CSS can colour the
 * tool name, dim the tool_result body, italicise the thinking block,
 * etc.
 *
 * Activities the renderer styles distinctly:
 *
 *   lifecycle    "● planner started" / "✓ finished" / "✗ failed"
 *   system       "session started · model: claude-opus-4-7"
 *   tool_use     "tool: <name>" + collapsed args block underneath
 *   tool_result  one-line head; collapsed full output block under it
 *   thinking     italic preview; expandable to full thinking body
 *   assistant    plain text preview; expandable to full chunk
 *   stderr       red-tinted line
 */
function renderShowPlannerAgentBody(
    body: HTMLElement,
    planner: ActivePlanner,
): void {
    const elapsed = formatElapsed(Math.max(0, Date.now() - planner.startedAt));
    const statusLabel
        = planner.status === 'running'
            ? `running · ${elapsed}`
            : planner.status === 'complete'
                ? `complete · ${elapsed}`
                : `failed${planner.error ? ` · ${planner.error}` : ''}`;

    const header = document.createElement('div');
    header.className = `stream-header stream-header--${planner.status}`;
    header.textContent = `● Planner ${statusLabel}`;

    const children: HTMLElement[] = [header];

    if (planner.activities.length === 0) {
        const idle = document.createElement('div');
        idle.className = 'stream-idle';
        idle.textContent
            = planner.status === 'running'
                ? '(waiting for the first event — claude is starting up)'
                : '(no activity captured)';
        children.push(idle);
    } else {
        if (planner.activities.length >= ACTIVE_PLANNER_ACTIVITY_LIMIT) {
            const elide = document.createElement('div');
            elide.className = 'stream-elide';
            elide.textContent = '(earlier activity elided — buffer capped)';
            children.push(elide);
        }
        for (const entry of planner.activities) {
            children.push(renderActivityRow(entry));
        }
    }
    applyStreamChildren(body, children);
}

/**
 * Stable set of expanded `<details>` rows, keyed by the entry's `at`
 * timestamp. Every render rebuilds the row DOM (`replaceChildren`),
 * which would otherwise wipe the operator's open/close state — the
 * "click → flash → close" the user is seeing is the next render
 * landing within ~1s and re-creating the element with `open === false`.
 *
 * Cast to string so a future schema change to a non-numeric key
 * doesn't silently break the Set. Collisions across two different
 * planner runs are harmless: the worst case is one row reopening
 * after a modal switch, which is preferable to the toggle being
 * useless.
 */
const streamExpandedRows = new Set<string>();

/**
 * Per-row inner-pre scroll position, keyed by the entry's `at`. Every
 * render tick (1s + every SSE event) rebuilds the activity DOM via
 * `replaceChildren`, which destroys the operator's scroll state on
 * the inner pre blocks. Without this side store, the user's "scroll
 * down to read the full tool output" gets undone on the very next
 * tick. Same `at`-keyed convention `streamExpandedRows` uses above.
 */
const streamRowInnerScrollTops = new Map<string, number>();

/**
 * Restore (and start tracking) scroll position on an inner pre. The
 * scroll listener writes the live `scrollTop` back into the side
 * store so a future re-render reads it; the queued microtask sets
 * `scrollTop` on the freshly-mounted element so the value survives
 * the rebuild. Setting `scrollTop` synchronously after `createElement`
 * is a no-op (the node isn't in the DOM yet); the microtask runs after
 * `replaceChildren` mounts everything and layout is current.
 */
function trackPreScroll(key: string, pre: HTMLElement): void {
    pre.addEventListener('scroll', () => {
        streamRowInnerScrollTops.set(key, pre.scrollTop);
    });
    const stored = streamRowInnerScrollTops.get(key);
    if (stored !== undefined) {
        // Defer the assignment until the pre is in the DOM. A direct
        // `pre.scrollTop = stored` here lands on a detached node and
        // is dropped.
        queueMicrotask(() => {
            pre.scrollTop = stored;
        });
    }
}

function renderActivityRow(entry: PlannerActivity): HTMLElement {
    const row = document.createElement('div');
    row.className = `stream-row stream-row--${entry.category}`;
    row.setAttribute('data-category', entry.category);
    row.setAttribute('data-at', String(entry.at));

    const stamp = document.createElement('span');
    stamp.className = 'stream-stamp';
    stamp.textContent = formatTimestamp(entry.at);
    row.appendChild(stamp);

    const label = document.createElement('span');
    label.className = 'stream-label';
    label.textContent = labelForCategory(entry.category);
    row.appendChild(label);

    const detail = document.createElement('span');
    detail.className = 'stream-detail';
    detail.textContent = entry.detail;
    row.appendChild(detail);

    if (entry.extra !== undefined && entry.extra.length > 0) {
        // Tool inputs, tool results, and thinking bodies render inline
        // — operator should see what claude is doing without an extra
        // click. Same convention as v1's stream (scrollable inline
        // pre block). Long assistant text stays behind a `<details>`
        // toggle because it can run to hundreds of lines per chunk.
        const isExpandable = entry.category === 'assistant';
        const key = String(entry.at);
        if (isExpandable) {
            const more = document.createElement('details');
            more.className = 'stream-extra';
            if (streamExpandedRows.has(key)) {
                more.open = true;
            }
            // Sync toggle state into the side store BEFORE the next
            // paint can clobber it — `replaceChildren` rebuilds these
            // elements from scratch on every render tick.
            more.addEventListener('toggle', () => {
                if (more.open) {
                    streamExpandedRows.add(key);
                } else {
                    streamExpandedRows.delete(key);
                }
            });
            const summary = document.createElement('summary');
            summary.className = 'stream-extra__summary';
            summary.textContent = 'show full text';
            more.appendChild(summary);
            const pre = document.createElement('pre');
            pre.className = 'stream-extra__body';
            pre.textContent = entry.extra;
            trackPreScroll(`${key}:details`, pre);
            more.appendChild(pre);
            row.appendChild(more);
        } else {
            const pre = document.createElement('pre');
            pre.className = 'stream-extra__body stream-extra__body--inline';
            pre.textContent = entry.extra;
            trackPreScroll(`${key}:inline`, pre);
            row.appendChild(pre);
        }
    }
    return row;
}

/**
 * Replace the stream body's children while preserving the scroll
 * position the operator chose. Only auto-sticks to the bottom when
 * they were already there (within {@link STICKY_BOTTOM_THRESHOLD_PX})
 * — otherwise an SSE event arriving mid-read would yank them back to
 * the latest row every tick.
 */
const STICKY_BOTTOM_THRESHOLD_PX = 48;
function applyStreamChildren(
    body: HTMLElement,
    children: readonly HTMLElement[],
): void {
    const wasNearBottom
        = body.scrollHeight - body.clientHeight - body.scrollTop
            < STICKY_BOTTOM_THRESHOLD_PX;
    body.replaceChildren(...children);
    if (wasNearBottom) {
        body.scrollTop = body.scrollHeight;
    }
}

function formatTimestamp(at: number): string {
    const ts = new Date(at);
    const hh = String(ts.getHours()).padStart(2, '0');
    const mm = String(ts.getMinutes()).padStart(2, '0');
    const ss = String(ts.getSeconds()).padStart(2, '0');
    return `[${hh}:${mm}:${ss}]`;
}

function labelForCategory(category: string): string {
    switch (category) {
        case 'tool_use':
            return 'tool';
        case 'tool_result':
            return '↳';
        case 'thinking':
            return '💭';
        case 'assistant':
            return '💬';
        case 'stderr':
            return '⚠';
        case 'system':
            return 'system';
        case 'lifecycle':
            return '●';
        default:
            return category;
    }
}

function formatElapsed(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remSeconds = seconds % 60;
    return `${minutes}m ${remSeconds}s`;
}

/**
 * Operator-fired interrupt on the active planner for a given planId.
 * Hits `POST /commands` with a CancelAgentRun envelope — the
 * orchestrator's CancelAgentRun handler invokes the AgentRunKiller
 * port (ClaudeCliAgentRunKiller in prod), which signals the live
 * Claude CLI process. AgentFinished with `outcome === 'interrupted'`
 * follows; applyPlannerEvent then flips the planner row's status to
 * `complete` (the runner's exit code is what triggers the close
 * publish; the runner doesn't separately publish AgentFailed on
 * interrupt).
 */
async function requestStopPlanner(planId: string): Promise<void> {
    const planner = activePlanners.get(planId);
    if (!planner) {
        showToast({
            message: 'No active planner to stop for this plan.',
            kind: 'error',
        });
        return;
    }
    if (planner.status !== 'running') {
        showToast({
            message: 'Planner has already finished.',
            kind: 'info',
        });
        return;
    }
    try {
        const res = await fetch(`${API_BASE}/commands`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                type: 'CancelAgentRun',
                actor: 'operator',
                issuedAt: Date.now(),
                payload: { runId: planner.agentId, reason: 'operator stopped' },
            }),
        });
        if (!res.ok) {
            throw new Error(`HTTP ${res.status}`);
        }
        showToast({
            message: 'Stop signal sent. The planner will finish shortly.',
            kind: 'info',
        });
    } catch (err) {
        showToast({
            message:
                err instanceof Error
                    ? `Stop failed: ${err.message}`
                    : 'Stop failed',
            kind: 'error',
        });
    }
}

// --- show planner report modal ------------------------------------------
//
// Opens after the planner finishes. Fetches the latest plan-review
// markdown via the existing projection route, renders it in an
// editable textarea so the operator can tweak before approving, and
// surfaces three actions:
//   * Approve & start decomposer — POSTs DecomposePlan with the
//     (possibly edited) markdown as approvedContent.
//   * Regenerate — fires another GeneratePlan with revision N+1 and
//     the optional feedback textarea content carried through as
//     `feedback`. The planner re-runs against the same plan; the
//     active-planner card flips back to `running`.
//   * Discard — soft-delete the plan via DeletePlan. Per the spec
//     "discard = delete".
//   * Close — just close the modal; plan stays where it is.
const SHOW_PLANNER_REPORT_OVERLAY_ID = 'show-planner-report';
let showPlannerReportBackdrop: HTMLElement | null = null;
let showPlannerReportContentEl: HTMLTextAreaElement | null = null;
let showPlannerReportFeedbackEl: HTMLTextAreaElement | null = null;
let showPlannerReportPlanId: string | null = null;

function openShowPlannerReportModal(planId: string): void {
    if (showPlannerReportBackdrop !== null) closeShowPlannerReportModal();
    const planner = activePlanners.get(planId);
    if (!planner) {
        showToast({
            message: 'No planner report available for this plan yet.',
            kind: 'error',
        });
        return;
    }
    const root = ensureOverlayRoot();
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-chrome__overlay';
    backdrop.setAttribute('data-show-planner-report-overlay', '');

    const panel = document.createElement('div');
    panel.className = 'show-planner-report-modal modal-chrome';
    panel.setAttribute('data-show-planner-report-modal', '');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-labelledby', 'show-planner-report-title');
    panel.setAttribute('data-plan-id', planId);

    const header = document.createElement('div');
    header.className = 'modal-chrome__header';
    const heading = document.createElement('h3');
    heading.className = 'modal-chrome__title';
    heading.setAttribute('id', 'show-planner-report-title');
    const planTitle = plans.get(planId)?.title
        ?? crudState.plans.find((p) => p.id === planId)?.title
        ?? planId;
    heading.textContent = `Planner report — ${planTitle}`;
    header.appendChild(heading);
    const closeXBtn = document.createElement('button');
    closeXBtn.className = 'modal-chrome__close';
    closeXBtn.setAttribute('type', 'button');
    closeXBtn.setAttribute('data-action', 'close');
    closeXBtn.textContent = '✕';
    closeXBtn.addEventListener('click', closeShowPlannerReportModal);
    header.appendChild(closeXBtn);
    panel.appendChild(header);

    const body = document.createElement('div');
    body.className = 'show-planner-report-body modal-chrome__body';

    // Implementation-plan markdown — editable so the operator can
    // tweak before approving. Seeded with "Loading…" until the
    // fetch resolves.
    const contentLabel = document.createElement('label');
    contentLabel.className = 'form-label';
    contentLabel.textContent = 'Implementation plan';
    body.appendChild(contentLabel);
    const contentEl = document.createElement('textarea');
    contentEl.className = 'show-planner-report-content';
    contentEl.setAttribute('data-input', 'plan-content');
    contentEl.value = '';
    contentEl.placeholder = 'Loading planner output…';
    body.appendChild(contentEl);

    const feedbackLabel = document.createElement('label');
    feedbackLabel.className = 'form-label';
    feedbackLabel.textContent = 'Feedback for regenerate (optional)';
    body.appendChild(feedbackLabel);
    const feedbackEl = document.createElement('textarea');
    feedbackEl.className = 'show-planner-report-feedback';
    feedbackEl.setAttribute('data-input', 'feedback');
    feedbackEl.placeholder
        = 'What should the next revision change? Leave blank to regenerate without a hint.';
    feedbackEl.value = '';
    body.appendChild(feedbackEl);
    panel.appendChild(body);

    const footer = document.createElement('div');
    footer.className = 'modal-chrome__footer';

    const discardBtn = document.createElement('button');
    discardBtn.type = 'button';
    discardBtn.className = 'np-button np-button--danger';
    discardBtn.setAttribute('data-action', 'discard');
    discardBtn.textContent = 'Discard';
    discardBtn.addEventListener('click', () => {
        void onDiscardPlanner(planId);
    });
    footer.appendChild(discardBtn);

    const regenBtn = document.createElement('button');
    regenBtn.type = 'button';
    regenBtn.className = 'np-button';
    regenBtn.setAttribute('data-action', 'regenerate');
    regenBtn.textContent = 'Regenerate';
    regenBtn.addEventListener('click', () => {
        void onRegeneratePlanner(planId);
    });
    footer.appendChild(regenBtn);

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'np-button';
    closeBtn.setAttribute('data-action', 'close');
    closeBtn.textContent = 'Close';
    closeBtn.addEventListener('click', closeShowPlannerReportModal);
    footer.appendChild(closeBtn);

    const approveBtn = document.createElement('button');
    approveBtn.type = 'button';
    approveBtn.className = 'np-button';
    approveBtn.setAttribute('data-action', 'approve');
    approveBtn.textContent = 'Approve & start decomposer';
    approveBtn.addEventListener('click', () => {
        void onApprovePlannerReport(planId);
    });
    footer.appendChild(approveBtn);
    panel.appendChild(footer);

    backdrop.appendChild(panel);
    root.appendChild(backdrop);
    overlayManager.openOverlay(SHOW_PLANNER_REPORT_OVERLAY_ID, panel);
    showPlannerReportBackdrop = backdrop;
    showPlannerReportContentEl = contentEl;
    showPlannerReportFeedbackEl = feedbackEl;
    showPlannerReportPlanId = planId;

    // Async fetch the latest markdown from the plan-review projection.
    // Resolves shortly after the planner's AgentFinished — but the
    // projection write is async, so we may briefly see "Loading…"
    // before the content lands. Fall back to the active-planner
    // buffer if the projection isn't populated yet.
    void hydrateReportContent(planId, planner.projectId);
}

async function hydrateReportContent(
    planId: string,
    projectId: string,
): Promise<void> {
    if (!showPlannerReportContentEl) return;
    try {
        const url = `${API_BASE}/api/projects/${encodeURIComponent(projectId)}/plans/${encodeURIComponent(planId)}/plan-review`;
        const res = await fetch(url);
        if (res.ok) {
            const json = (await res.json()) as { markdown?: string };
            if (
                showPlannerReportPlanId === planId
                && showPlannerReportContentEl
                && typeof json.markdown === 'string'
                && json.markdown.length > 0
            ) {
                showPlannerReportContentEl.value = json.markdown;
                return;
            }
        }
    } catch {
        // fall through to the agent-stream fallback
    }
    // Fallback: dump the chunks the board buffered during the run.
    // Not as nicely formatted as the projection's markdown but at
    // least the operator sees something while the projection catches
    // up (or if the route is unreachable).
    const planner = activePlanners.get(planId);
    if (
        showPlannerReportPlanId === planId
        && showPlannerReportContentEl
        && planner
        && planner.chunks.length > 0
    ) {
        showPlannerReportContentEl.value = planner.chunks.join('');
    }
}

function closeShowPlannerReportModal(): void {
    if (showPlannerReportBackdrop === null) return;
    overlayManager.closeOverlay(SHOW_PLANNER_REPORT_OVERLAY_ID);
    showPlannerReportBackdrop.remove();
    showPlannerReportBackdrop = null;
    showPlannerReportContentEl = null;
    showPlannerReportFeedbackEl = null;
    showPlannerReportPlanId = null;
}

async function onApprovePlannerReport(planId: string): Promise<void> {
    const planner = activePlanners.get(planId);
    if (!planner) return;
    const markdown = showPlannerReportContentEl?.value ?? '';
    if (markdown.trim().length === 0) {
        showToast({
            message: 'Implementation plan is empty — nothing to decompose.',
            kind: 'error',
        });
        return;
    }
    try {
        const res = await fetch(`${API_BASE}/commands`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                type: 'DecomposePlan',
                actor: 'operator',
                issuedAt: Date.now(),
                payload: {
                    planId,
                    projectId: planner.projectId,
                    approvedContent: markdown,
                    // `conventions` is required at the command boundary.
                    // The form-driven plan body already carries any
                    // operator-set conventions inline; passing `{}` here
                    // lets the decomposer fall back to repo defaults.
                    conventions: {},
                },
            }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        showToast({
            message:
                'Plan approved — decomposer dispatched. Tasks will appear on the board as they are generated.',
            kind: 'success',
        });
        closeShowPlannerReportModal();
    } catch (err) {
        showToast({
            message:
                err instanceof Error
                    ? `Approve failed: ${err.message}`
                    : 'Approve failed',
            kind: 'error',
        });
    }
}

async function onRegeneratePlanner(planId: string): Promise<void> {
    const planner = activePlanners.get(planId);
    if (!planner) return;
    const feedback = (showPlannerReportFeedbackEl?.value ?? '').trim();
    // previousContent is what the operator may have edited in the
    // textarea — falling back to the chunk buffer if the textarea
    // ended up empty (e.g. the projection hadn't caught up by the
    // time the modal opened).
    let previousContent = (showPlannerReportContentEl?.value ?? '').trim();
    if (previousContent.length === 0 && planner.chunks.length > 0) {
        previousContent = planner.chunks.join('').trim();
    }
    // briefContent — the planner needs the original brief (the plan
    // body) for context, otherwise the second run lands without
    // anything to plan against. Fetch it from the plan-detail
    // projection at submit time so a stale crudState doesn't bite.
    let briefContent = '';
    try {
        const url = `${API_BASE}/api/projects/${encodeURIComponent(planner.projectId)}/plans/${encodeURIComponent(planId)}`;
        const res = await fetch(url);
        if (res.ok) {
            const json = (await res.json()) as { plan?: { body?: string | null } };
            const body = json.plan?.body;
            if (typeof body === 'string') briefContent = body;
        }
    } catch {
        // Non-fatal — the planner will still see previousContent
        // and feedback, which is usually enough to produce a
        // meaningful revision.
    }
    const nextRevision = (planner.revision ?? 1) + 1;
    try {
        const url = `${API_BASE}/api/projects/${encodeURIComponent(planner.projectId)}/plans/${encodeURIComponent(planId)}/generate-plan`;
        const body: Record<string, unknown> = { revision: nextRevision };
        if (feedback.length > 0) body.feedback = feedback;
        if (previousContent.length > 0) body.previousContent = previousContent;
        if (briefContent.length > 0) body.briefContent = briefContent;
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        // Reset to running. Keep the prior activities visible — the
        // operator wants to see what the planner did on revision N
        // alongside revision N+1. A separator marks the boundary.
        planner.status = 'running';
        planner.chunks = [];
        planner.error = undefined;
        planner.revision = nextRevision;
        pushPlannerActivity(planner, {
            at: Date.now(),
            category: 'lifecycle',
            detail: `── revision ${nextRevision} starting${feedback ? ` · feedback: ${truncate(feedback, 100)}` : ''} ──`,
        });
        scheduleRender();
        showToast({
            message: `Regenerating plan (revision ${nextRevision})…`,
            kind: 'success',
        });
        closeShowPlannerReportModal();
    } catch (err) {
        showToast({
            message:
                err instanceof Error
                    ? `Regenerate failed: ${err.message}`
                    : 'Regenerate failed',
            kind: 'error',
        });
    }
}

async function onDiscardPlanner(planId: string): Promise<void> {
    const planner = activePlanners.get(planId);
    if (!planner) return;
    if (
        !confirm(
            'Discard this plan? It will be archived and removed from the sidebar.',
        )
    ) {
        return;
    }
    try {
        await onDeletePlan(planner.projectId, planId);
        // Also drop the active-planner row immediately so the card
        // vanishes from the main area without waiting on the next
        // SSE projection refresh.
        activePlanners.delete(planId);
        scheduleRender();
        closeShowPlannerReportModal();
        showToast({ message: 'Plan discarded.', kind: 'info' });
    } catch (err) {
        showToast({
            message:
                err instanceof Error
                    ? `Discard failed: ${err.message}`
                    : 'Discard failed',
            kind: 'error',
        });
    }
}

/** Trigger a client-side file download for generated text content. */
function downloadTextFile(filename: string, content: string, mime: string): void {
    const blob = new Blob([content], { type: `${mime};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Give the browser a beat to start the download before revoking.
    setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// --- diff-review ---
function openDiffReviewForTask(task: TaskRow): void {
    if (!task.projectId || !task.planId) {
        showToast({
            message: 'Diff unavailable: project / plan slug missing on this task.',
            kind: 'error',
        });
        return;
    }
    const root = ensureOverlayRoot();
    const element = document.createElement('div');
    root.appendChild(element);
    openDiffReview(
        {
            projectId: task.projectId,
            planId: task.planId,
            taskId: task.taskId,
            flowId: task.flowId,
        },
        {
            element: element as never,
            overlayManager: overlayManager as never,
            fetch: ((url: string) => fetch(url)) as never,
            dispatch: (cmd) => {
                void sendCommand({ ...cmd, actor: 'operator', issuedAt: Date.now() } as BoardCommand);
            },
            onReject: () => openRejectForTask(task),
        },
    );
}

// --- human-review (pre-commit operator gate) ---
function openHumanReviewForTask(task: TaskRow): void {
    if (!task.projectId || !task.planId) {
        showToast({
            message: 'Diff unavailable: project / plan slug missing on this task.',
            kind: 'error',
        });
        return;
    }
    const root = ensureOverlayRoot();
    const element = document.createElement('div');
    root.appendChild(element);
    openDiffReview(
        {
            projectId: task.projectId,
            planId: task.planId,
            taskId: task.taskId,
            flowId: task.flowId,
        },
        {
            element: element as never,
            overlayManager: overlayManager as never,
            fetch: ((url: string) => fetch(url)) as never,
            // `dispatch` is unused in human-review mode — the two
            // override callbacks below dispatch ResumeTask directly —
            // but the modal API still expects the field, so keep a
            // no-op stub here for type compatibility.
            dispatch: (_cmd) => {
                /* no-op: human-review mode uses the override callbacks */
            },
            onReject: () => {
                /* no-op: human-review mode owns the reject flow via
                   onHumanReviewReject. */
            },
            humanReviewMode: true,
            onHumanReviewApprove: () => {
                void sendCommand({
                    type: 'ResumeTask',
                    actor: 'operator',
                    issuedAt: Date.now(),
                    payload: {
                        taskId: task.taskId,
                        decision: 'approve',
                    },
                });
            },
            onHumanReviewReject: (_params, feedback) => {
                void sendCommand({
                    type: 'ResumeTask',
                    actor: 'operator',
                    issuedAt: Date.now(),
                    payload: {
                        taskId: task.taskId,
                        decision: 'reject',
                        feedback,
                    },
                });
            },
        },
    );
}

// --- notes ---
// --- interrupt-retry ---
function openInterruptRetry(task: TaskRow): void {
    ensureOverlayRoot();
    openInterruptRetryModal(
        { taskId: task.taskId },
        {
            dispatch: async (cmd) => sendCommand(cmd as BoardCommand),
            toast: (opts) => showToast({ message: opts.message, kind: opts.kind }),
            overlay: overlayManager as never,
            actor: 'operator',
        },
    );
}

// --- clarify ---
function openClarify(task: TaskRow): void {
    const root = ensureOverlayRoot();
    overlayManager.openOverlay(`clarify:${task.taskId}`, root as never);
    openClarifyModal(
        {
            taskId: task.taskId,
            question: task.parkedQuestion || undefined,
            dispatcher: {
                dispatch: async (cmd) => {
                    await sendCommand({
                        type: cmd.type,
                        actor: 'operator',
                        issuedAt: Date.now(),
                        payload: cmd.payload as never,
                    });
                },
            },
            onClose: () => overlayManager.closeOverlay(`clarify:${task.taskId}`),
        },
        { parent: root as never },
    );
}

// --- AP-VP5-010 clarify modal (Phase 5 Answer button) ---
//
// The legacy `openClarify(task)` above dispatches `UpdateTask` with the
// operator's clarification payload (AP-IFF-015). The new Phase 5 path
// POSTs the answer to `/tasks/:id/clarify` (worker-api AP-VP5-008) and
// supports the agent's enumerated `choices` rendered as radio buttons.
// Both surfaces coexist while we migrate callers; the new "Answer"
// button on parked-clarification cards is the Phase 5 entry point.
function openClarificationAnswer(task: TaskRow): void {
    const root = ensureOverlayRoot();
    const overlayId = `clarification-answer:${task.taskId}`;
    overlayManager.openOverlay(overlayId, root as never);
    openPhase5ClarifyModal(
        {
            taskId: task.taskId,
            question: task.parkedQuestion ?? '',
            choices: clarificationChoices.get(task.taskId),
            apiBase: API_BASE,
            onClose: () => overlayManager.closeOverlay(overlayId),
            onError: (info) => showToast({ message: info.message, kind: 'error' }),
        },
        { parent: root as never },
    );
}

// --- Decomposer question Answer button ---
//
// Same modal as the task-side Answer (question + radio options + free text
// + Remember), pointed at the plan-scoped endpoint. The worker-api
// dispatches `AnswerDecomposerQuestion`, whose subscriber re-spawns the
// decomposer with every answer given on the plan threaded into its prompt.
//
// A rejected dispatch (409 — the question was already answered elsewhere)
// leaves the modal open with the operator's text intact, which is the
// modal's own non-2xx behaviour; the card corrects itself on the next SSE
// fold.
/**
 * Retire a pending decomposer question without answering it.
 *
 * Field report: "I have the decomposer asking a question, one of the
 * options is cancel the task, which is what I selected but the question
 * keeps coming back and I have no way to dismiss the decomposer."
 *
 * The decomposer writes its own options, so one of them reading "cancel
 * the task" is still only text: answering sends it back and the
 * decomposer is re-spawned, which asks again. And the card has no
 * Dismiss while a question is pending — deliberately, because that would
 * hide the one control that can un-hold the plan — so there was no exit.
 *
 * This posts the ACTION. The worker retires the question and does not
 * re-spawn anything; the plan is left exactly as it was, ready to be
 * edited and decomposed again.
 */
async function abandonDecomposerQuestion(planId: string): Promise<void> {
    try {
        const res = await fetch(
            `${API_BASE}/plans/${encodeURIComponent(planId)}/decomposer-abandon`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ actor: 'operator' }),
            },
        );
        if (!res.ok) {
            // 409 is the "already answered / never asked" case, and the
            // worker's message names the plan — pass it through rather
            // than inventing one.
            const body = await res.json().catch(() => ({})) as { message?: string };
            showToast({
                message: body.message
                    ?? `Could not retire the question (HTTP ${res.status}).`,
                kind: 'error',
            });
            return;
        }
        showToast({
            message: 'Question retired — the decomposer was not re-run.',
            kind: 'info',
        });
    } catch (err) {
        showToast({
            message: err instanceof Error
                ? `Could not retire the question: ${err.message}`
                : 'Could not retire the question.',
            kind: 'error',
        });
    }
}

function openDecomposerAnswer(dec: ActiveDecomposer): void {
    const root = ensureOverlayRoot();
    const overlayId = `decomposer-answer:${dec.planId}`;
    overlayManager.openOverlay(overlayId, root as never);
    openPhase5ClarifyModal(
        {
            taskId: dec.planId,
            question: dec.question ?? '',
            choices: dec.questionOptions,
            apiBase: API_BASE,
            submitPath: `/plans/${encodeURIComponent(dec.planId)}/decomposer-answer`,
            onClose: () => overlayManager.closeOverlay(overlayId),
            onError: (info) => showToast({ message: info.message, kind: 'error' }),
        },
        { parent: root as never },
    );
}

// --- AP-VP5-012 reject-feedback modal (Phase 5 commit-approval Reject) ---
//
// Wired only on commit-approval cards (parkedReason==='approval' AND
// parkedStepId==='pr.open'). Other approval-parked cards (wait-action,
// pr.merge) keep the inline-textarea Reject panel from AP-VP-015.
// On a 202 the worker-api dispatches `ResumeTask{decision:'reject',
// feedback}` for us; the modal closes itself on success.
function openCommitRejectFeedback(task: TaskRow): void {
    const root = ensureOverlayRoot();
    const overlayId = `reject-feedback:${task.taskId}`;
    const handle = openRejectFeedbackModal(
        {
            taskId: task.taskId,
            apiBase: API_BASE,
            fetch: ((url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) =>
                fetch(url, init as RequestInit)) as never,
            onClose: () => overlayManager.closeOverlay(overlayId),
            onError: (info) => {
                const detail = info.status
                    ? `Reject failed (HTTP ${info.status}).`
                    : 'Reject failed — network error. Try again.';
                showToast({ message: detail, kind: 'error' });
            },
        },
        { parent: root as never },
    );
    overlayManager.openOverlay(overlayId, handle.root as never);
}

// --- AP-VP5-011 investigation-followup modal (Phase 5 Ask follow-up) ---
//
// Replaces the inline `.followup-chip` text-input on investigate-type
// cards. The new modal renders the full operator/investigator thread
// alongside the question textarea so the operator can read context
// before posting their follow-up.
function openInvestigationFollowup(task: TaskRow): void {
    const root = ensureOverlayRoot();
    const overlayId = `followup:${task.taskId}`;
    const handle = openInvestigationFollowupModal(
        {
            taskId: task.taskId,
            // Thread fetcher — pulls the latest investigation thread via
            // the worker-api so the modal sees every turn (including any
            // posted after the last SSE projection update).
            fetchThread: async (taskId: string) => {
                const url = `${API_BASE}/tasks/${encodeURIComponent(taskId)}/investigation-thread`;
                const res = await fetch(url);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const body = (await res.json()) as {
                    thread?: ReadonlyArray<{ role: string; content: string; timestamp: number }>;
                };
                return Array.isArray(body?.thread) ? body.thread : [];
            },
            // Dispatcher — POSTs the follow-up so worker-api dispatches
            // `AskInvestigationFollowup` onto the command bus.
            dispatcher: async (cmd) => {
                const res = await fetch(
                    `${API_BASE}/tasks/${encodeURIComponent(task.taskId)}/investigation-followup`,
                    {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ question: cmd.payload.question }),
                    },
                );
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
            },
            toast: { showToast: (opts) => showToast({ message: opts.message, kind: opts.kind }) },
            onClose: () => overlayManager.closeOverlay(overlayId),
        },
        { parent: root as never },
    );
    overlayManager.openOverlay(overlayId, handle.overlay as never);
    // Fire-and-forget the initial thread load so the operator sees the
    // existing turns without an extra click. Errors funnel through the
    // toast port the modal already owns.
    void handle.refresh();
}

// --- reject ---
function openRejectForTask(task: TaskRow): void {
    const root = ensureOverlayRoot();
    const handle = openRejectModal({
        taskId: task.taskId,
        dispatch: (cmd) => {
            void sendCommand({
                type: cmd.type,
                actor: 'operator',
                issuedAt: Date.now(),
                payload: cmd.payload as never,
            });
        },
        onClose: () => {
            overlayManager.closeOverlay(`reject:${task.taskId}`);
            // The manager only marks the element aria-hidden; this modal
            // does not tear itself down (unlike clarify/review-report),
            // so remove the panel here or it accumulates in #overlay-root
            // and a second Reject on the same task throws (id already
            // open) with a stale panel still on screen.
            (handle.root as unknown as { remove?: () => void }).remove?.();
        },
    });
    root.appendChild(handle.root as unknown as Node);
    overlayManager.openOverlay(`reject:${task.taskId}`, handle.root as never);
}

// --- worker-log ---
function openWorkerLogModal(): void {
    const root = ensureOverlayRoot();
    const element = document.createElement('div');
    root.appendChild(element);
    openWorkerLog({
        element: element as never,
        overlayManager: overlayManager as never,
        fetch: ((url: string) => fetch(url)) as never,
        createEventSource: (url: string) => new EventSource(url) as never,
    });
}

// --- review-report (AP-IFB-008) ---
// One modal handle reused across cards — the AP-IFB-007 factory tears
// down + remounts on each open(), so a single instance keeps the
// overlay-manager id stable while letting every "View report" click
// re-populate the report body.
let reviewReportModal: ReviewReportModalHandle | null = null;

function getReviewReportModal(): ReviewReportModalHandle {
    if (reviewReportModal) return reviewReportModal;
    ensureOverlayRoot();
    reviewReportModal = createReviewReportModal({
        overlayManager: overlayManager as never,
        commands: {
            async dismissReport({ taskId, reportId, reason }) {
                const body: Record<string, unknown> = { taskId, reportId };
                if (reason) body.reason = reason;
                await postInvestigationAction(
                    '/commands/dismiss-investigation',
                    body,
                );
            },
            async implementReport({ taskId, reportId }) {
                await postInvestigationAction(
                    '/commands/implement-from-investigation',
                    { taskId, reportId },
                );
            },
        },
        showToast: (input) =>
            showToast({ message: input.message, kind: input.kind }),
        // Chat about the report, scoped to the task that produced it.
        // Same pane as the plan and design chats, so the one affordance
        // that matters here — turning a finding into a plan — behaves
        // identically on all three surfaces.
        mountChat: (container, ctx) => mountScopedChatPane(container as never, {
            apiBase: API_BASE,
            scopeKind: 'report',
            scopeId: ctx.taskId,
            projectId: ctx.projectId,
            // A report task's own repo is where the FINDING lives, not
            // necessarily where the fix belongs, so it is not pinned as
            // the plan's target: the agent names one with `Repo:` when it
            // knows, and the operator sees it on the chip either way.
            repoId: null,
            title: `Report chat — ${ctx.title}`,
            sendCommand: (command) => sendCommandOrThrow(command as BoardCommand),
            createPlan: scopedChatCreatePlan(ctx.projectId, null),
            onError: (message) => showToast({ message, kind: 'error' }),
        }),
    });
    return reviewReportModal;
}

/** The recorded report step for a task, if any (see report-availability). */
function findReportStep(taskId: string): TaskStepRecord | undefined {
    return pickReportStep(taskStepRuns.get(taskId)?.values());
}

/**
 * Is there a report to READ for this task right now? Drives whether the
 * View-report button renders at all — no more clicking into a
 * placeholder.
 */
function taskHasReport(task: TaskRow): boolean {
    return hasReadableReport({
        type: task.type,
        hasProjectionReport: investigationReports.has(task.taskId),
        steps: taskStepRuns.get(task.taskId)?.values(),
    });
}

function openReviewReportForTask(task: TaskRow): void {
    const handle = getReviewReportModal();
    // A chat session needs a project. The task row carries one for tasks
    // created since the projection gained the field; older rows fall back
    // to the owning plan's. Still null means no Chat button rather than a
    // session-create that 400s after the operator clicks.
    const projectId = task.projectId
        ?? (task.planId ? plans.get(task.planId)?.projectId ?? null : null);
    const chatFields = projectId !== null ? { projectId } : {};
    const report = investigationReports.get(task.taskId);
    if (report) {
        handle.open({
            taskId: task.taskId,
            reportId: report.reportId,
            content: report.markdown || '(report body is empty)',
            title: `Review report — ${task.taskId}`,
            ...chatFields,
        });
        return;
    }
    // No InvestigationCompleted event on the projection — fall back to the
    // report-producing agent's recorded step output (task_step_summaries,
    // hydrated on load, so it survives reloads). Covers investigator runs
    // that finished before the InvestigationCompleted bridge existed AND
    // the review-* task family (codebase / azure reviewers), whose report
    // only ever lives in the step summary — without this match their
    // View-report opened on the empty placeholder with no usable
    // Implement.
    const stepRec = findReportStep(task.taskId);
    if (stepRec?.summary && stepRec.summary.length > 0) {
        handle.open({
            taskId: task.taskId,
            reportId: `step:${task.taskId}:${stepRec.stepId}`,
            content: stepRec.summary,
            title: `Review report — ${task.taskId}`,
            ...chatFields,
        });
        return;
    }
    // Nothing recorded anywhere. Surface a placeholder so the operator
    // gets visible feedback that the click was handled rather than
    // silently no-oping; the reportId is namespaced under the task so
    // the dismiss/implement dispatches still carry a stable key.
    handle.open({
        taskId: task.taskId,
        reportId: `task:${task.taskId}`,
        content: 'No report has been recorded for this task yet.',
        title: `Review report — ${task.taskId}`,
    });
}

// ---------- AP-VP-015 — approval-gate Approve / Reject controls ---------
//
// When the flow engine parks a task at an approval gate it emits a
// TaskParked event with `reason: 'approval'` and the parked `stepId`.
// The card renders an Approve button and a Reject button alongside an
// inline feedback panel — NO modal. Approve dispatches
// `ResumeTask{decision:'approve'}` immediately; Reject reveals the
// inline textarea, and Submit dispatches `ResumeTask{decision:'reject',
// feedback}`. The (parkedReason='approval', stepId) → v1 status tag map
// lives in task-tags.ts (`approvalStepTag`); board.ts is the wiring
// seam.
function renderApprovalControls(frag: DocumentFragment, task: TaskRow): void {
    if (task.parkedReason !== 'approval') return;
    const cardEl = frag.querySelector('[data-task-card]') as HTMLElement | null;
    if (!cardEl) return;

    const wrap = document.createElement('div');
    wrap.className = 'approval-controls';
    wrap.setAttribute('data-approval-controls', '');
    wrap.setAttribute('data-task-id', task.taskId);
    if (task.parkedStepId) wrap.setAttribute('data-step-id', task.parkedStepId);

    const approveBtn = document.createElement('button');
    approveBtn.type = 'button';
    approveBtn.className = 'approval-approve';
    approveBtn.setAttribute('data-action', 'approval-approve');
    approveBtn.textContent = 'Approve';
    approveBtn.addEventListener('click', () => onApproveParked(task));
    wrap.appendChild(approveBtn);

    const rejectBtn = document.createElement('button');
    rejectBtn.type = 'button';
    rejectBtn.className = 'approval-reject';
    rejectBtn.setAttribute('data-action', 'approval-reject');
    rejectBtn.textContent = 'Reject';
    wrap.appendChild(rejectBtn);

    // AP-VP5-014 — commit-approval cards (parkedStepId === 'pr.open')
    // open the AP-VP5-012 reject-feedback modal instead of the inline
    // textarea panel. Other approval-park stepIds (wait-action, pr.merge)
    // continue to use the AP-VP-015 inline panel below.
    const isCommitApproval = task.parkedStepId === 'pr.open';
    if (isCommitApproval) {
        rejectBtn.addEventListener('click', () => {
            openCommitRejectFeedback(task);
        });
        cardEl.appendChild(wrap);
        return;
    }

    const panel = document.createElement('div');
    panel.className = 'approval-reject-panel';
    panel.setAttribute('data-approval-reject-panel', '');
    const isOpen = approvalRejectOpen.has(task.taskId);
    panel.hidden = !isOpen;

    const feedback = document.createElement('textarea');
    feedback.className = 'approval-feedback';
    feedback.setAttribute('data-approval-feedback', '');
    feedback.setAttribute('aria-label', 'Reason for rejecting');
    feedback.setAttribute('rows', '3');
    feedback.placeholder = 'Tell the agent what to change…';
    feedback.value = approvalRejectFeedback.get(task.taskId) ?? '';
    feedback.addEventListener('input', () => {
        approvalRejectFeedback.set(task.taskId, feedback.value);
    });
    panel.appendChild(feedback);

    const submitBtn = document.createElement('button');
    submitBtn.type = 'button';
    submitBtn.className = 'approval-reject-submit';
    submitBtn.setAttribute('data-action', 'approval-reject-submit');
    submitBtn.textContent = 'Submit rejection';
    submitBtn.addEventListener('click', () => {
        // AP-VP-015 (attempt #2 reviewer feedback): empty feedback is a
        // valid Reject. The `feedback` field on ResumeTaskPayload is
        // optional, and forcing the operator to type a reason before they
        // can reject was inconsistent with that contract. Submit always
        // dispatches; the textarea value (trimmed, possibly '') threads
        // straight onto the payload.
        const reason = (feedback.value || '').trim();
        approvalRejectFeedback.set(task.taskId, reason);
        onRejectParked(task, reason);
    });
    panel.appendChild(submitBtn);

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'approval-reject-cancel';
    cancelBtn.setAttribute('data-action', 'approval-reject-cancel');
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => {
        approvalRejectOpen.delete(task.taskId);
        approvalRejectFeedback.delete(task.taskId);
        scheduleRender();
    });
    panel.appendChild(cancelBtn);

    rejectBtn.addEventListener('click', () => {
        approvalRejectOpen.add(task.taskId);
        scheduleRender();
    });

    wrap.appendChild(panel);
    cardEl.appendChild(wrap);
}

function onApproveParked(task: TaskRow): void {
    void sendCommand({
        type: 'ResumeTask',
        actor: 'operator',
        issuedAt: Date.now(),
        payload: { taskId: task.taskId, decision: 'approve' },
    });
}

function onRejectParked(task: TaskRow, feedback: string): void {
    approvalRejectOpen.delete(task.taskId);
    approvalRejectFeedback.delete(task.taskId);
    void sendCommand({
        type: 'ResumeTask',
        actor: 'operator',
        issuedAt: Date.now(),
        payload: { taskId: task.taskId, decision: 'reject', feedback },
    });
    scheduleRender();
}

// Inject the modal-trigger buttons onto a task-card fragment. The card's
// existing `.task-actions` row hosts these. Visibility is task-shape
// driven so a card only shows the affordances that make sense for its
// current column / status.
/**
 * Hide static `.task-actions` buttons that don't apply to the task's
 * current state. The template ships with Approve / Skip / Retry /
 * Resume as a static set; rather than rebuild the markup per status,
 * we toggle visibility here.
 *
 * Rules:
 *   - `approve` / `skip` — visible on a freshly-created task, hidden
 *     once the task has moved past `created` (the only operator
 *     decision left on a created task is "kick it off" or "drop it").
 *   - `retry` — only after a failure.
 *   - `resume` — only on a parked task that isn't an approval park
 *     (approval parks render their own Approve / Reject row via
 *     `renderApprovalControls`). Handled above; this function leaves
 *     the existing visibility alone.
 */
function pruneTaskActions(frag: DocumentFragment, task: TaskRow): void {
    const setVisible = (action: string, visible: boolean): void => {
        const btn = frag.querySelector(
            `.task-actions button[data-action="${action}"]`,
        ) as HTMLButtonElement | null;
        if (!btn) return;
        btn.hidden = !visible;
    };
    const status = task.status || 'created';
    // A task parked at the approval gate gets its own Approve/Reject
    // strip via renderApprovalControls. The template's freshly-created
    // Approve/Skip would otherwise stack alongside it and double up
    // the affordance — hide the template buttons in that state.
    const parkedAtApproval = task.parkedReason === 'approval';
    // Done tasks collapse to a single Dismiss affordance — the chain
    // finished, the PR is merged, there's nothing else the operator
    // can do on the card. Dismiss removes the card from the board
    // (local + persisted as status='skipped' so it stays gone across
    // reloads); the worktree + PR history live on in the DB for audit.
    const isDone = status === 'done';
    const isTerminal = isDone
        || status === 'skipped'
        || status === 'archived';
    const awaitingMerge = task.parkedReason === 'wait-merged' && !!task.prUrl;
    // Parked at wait-merged BUT the post-commit hook failed to open a
    // PR (prUrl still null). The operator can retry via "Create PR" —
    // the orchestrator's CreateTaskPr command re-runs runPostCommitHook
    // which is push-idempotent and re-attempts `gh pr create`.
    const awaitingPr = task.parkedReason === 'wait-merged' && !task.prUrl;
    const inFlight = status === 'in_progress'
        || status === 'review'
        || status === 'test'
        || status === 'commit'
        || status === 'merge';
    // Hoisted above the mark-complete predicate. Originally these were
    // declared together with the dismiss-button visibility further
    // down, but the `canMarkComplete` block above references `isFailed`
    // and Temporal Dead Zone made the access throw
    // `Cannot access 'isFailed' before initialization` — which then
    // bubbled out of pruneTaskActions → renderTaskCard →
    // buildPlanModalBody and left the plan modal empty.
    const isParked = !!task.parkedReason;
    const isFailed = status === 'failed';

    if (isDone) {
        setVisible('approve', false);
        setVisible('skip', false);
        // Retry stays available on Done so the operator can re-run a
        // task whose flow definition changed after it finished — e.g.
        // an integration-test task that was MarkTaskComplete'd before
        // the flow was updated to actually commit + merge the test.
        // The TaskRetried handler resets `status='created'` and wipes
        // step summaries; the engine re-dispatches the first step
        // against the current YAML, so the new flow shape takes effect
        // without dismissing and re-decomposing the plan.
        setVisible('retry', true);
        setVisible('cancel', false);
        setVisible('merge-pr', false);
        setVisible('create-pr', false);
        setVisible('mark-complete', false);
        setVisible('dismiss', true);
        return;
    }

    // AP-IFW-006 — Approve on a `waiting-deps` task is a PRE-approval:
    // it doesn't start the task now (the upstream isn't merged), it
    // records the operator's intent so the engine auto-starts it the
    // moment the dependency finishes (PreApproveTask → pre_approved →
    // resolveApproval bypass). Show Approve for a deps-parked task that
    // hasn't been pre-approved yet; hide it once pre-approved (the chip
    // then shows "approved ✓"). For a normal created task, Approve has
    // its usual "kick it off" meaning.
    const waitingOnDeps = task.parkedReason === 'waiting-deps';
    const showApprove = waitingOnDeps
        ? !task.preApproved
        : (status === 'created' && !parkedAtApproval && !awaitingMerge);
    setVisible('approve', showApprove);
    setVisible('skip', (status === 'created' || waitingOnDeps)
        && !parkedAtApproval && !awaitingMerge);
    // Retry is the escape hatch for any state where the operator might
    // want to redo the task from the top:
    //   - failed runs
    //   - skipped tasks the operator changed their mind on
    //   - `approved` rows whose agent crashed before the projection
    //     updated (legacy `0xC000013A` case)
    //   - parked tasks the operator wants to abandon-and-restart
    //     (worktree-diff-review they don't want to keep iterating on,
    //     wait-action stalls after a cancel-agent that left the row
    //     mid-flow, …). Without this the only escape was Dismiss, but
    //     Dismiss skips the task — there was no way to restart it
    //     from the top.
    //
    // Hidden for:
    //   - in-flight states with NO parked_reason — the agent is
    //     actively running and a Retry click would race the live
    //     dispatch. Cancel is the right escape there; once it lands
    //     the task transitions to failed/parked and Retry becomes
    //     available.
    //   - parked-at-approval — has its own Approve/Reject controls
    //     that own the decision.
    //   - waiting-deps — Retry can't usefully resume a task whose
    //     upstream hasn't merged; the unblock pass will re-dispatch
    //     it automatically when the dep clears.
    //   - awaiting-merge — Merge PR is the only meaningful action
    //     there.
    const restartable
        = isParked && !parkedAtApproval && !awaitingMerge && task.parkedReason !== 'waiting-deps';
    setVisible('retry',
        (restartable || (!inFlight && status !== 'created'))
        && !parkedAtApproval
        && !awaitingMerge);
    // Relabel "Retry" → "Restart" when the affordance is a fresh start
    // from a parked / in-flight state rather than a re-run of a
    // completed-but-not-merged task. The action under the hood is the
    // same (`RetryTask` → engine drops flow_state + re-dispatches
    // steps[0]), but the wording matches the operator's mental model:
    // "Retry" reads as "do that again" (post-failure), "Restart" reads
    // as "throw away the in-flight state and start over" (parked or
    // stuck mid-flow).
    const retryBtn = frag.querySelector(
        '.task-actions button[data-action="retry"]',
    ) as HTMLButtonElement | null;
    if (retryBtn) {
        retryBtn.textContent = restartable ? 'Restart' : 'Retry';
    }
    // Cancel stays available for the entire run-life of the task. The
    // operator can always pull the plug on a stuck or wrong-direction
    // run; once the task is terminal there is nothing to cancel.
    setVisible('cancel', !isTerminal);
    // Merge PR shows only when the chain reached the wait-merged step
    // AND the post-commit hook successfully opened a PR (prUrl set).
    // Without prUrl the merge has nothing to act on — the button stays
    // hidden so the operator doesn't get a confusing failure toast.
    setVisible('merge-pr', awaitingMerge);
    // Create PR is the mirror affordance — wait-merged with no prUrl
    // means the post-commit hook ran but `gh pr create` failed
    // silently (logged, never surfaced to the flow). Clicking re-runs
    // the hook (push is idempotent) and re-attempts the PR creation.
    setVisible('create-pr', awaitingPr);
    // Relabel the Create PR button to read as a retry when the push/PR
    // actually failed — it's the same idempotent CreateTaskPr action, but
    // "Retry push & PR" matches the operator's mental model in that state.
    if (awaitingPr) {
        const prBtn = frag.querySelector(
            '.task-actions button[data-action="create-pr"]',
        ) as HTMLButtonElement | null;
        if (prBtn) {
            prBtn.textContent = task.commitError ? 'Retry push & PR' : 'Create PR';
        }
    }
    // Mark complete — operator override for tasks whose work succeeded
    // but the flow stalled before reaching emit:TaskFinished. Canonical
    // cases:
    //   - an integration-test task whose tester finished back when the
    //     flow still routed through review/commit;
    //   - a dependent task that produced no changes (its work was
    //     already landed by the task it depended on) and is stuck at
    //     wait-merged with no PR (`awaitingPr`) — there's nothing to
    //     merge, so Mark complete is the clean exit.
    // Shown for in-flight / failed / wait-merged-no-PR states; never
    // for created (operator can just Approve) or parked-at-approval /
    // awaiting-merge (those have their own single-purpose buttons).
    const canMarkComplete = (inFlight || isFailed || awaitingPr)
        && !parkedAtApproval
        && !awaitingMerge;
    setVisible('mark-complete', canMarkComplete);
    // Dismiss as a "get this card off my board" affordance for tasks
    // that aren't actively running but are waiting on something — parked
    // at any reason (clarification / approval / wait-merged /
    // worktree-diff-review) or already failed. Functionally identical
    // to Cancel + Skip (all three dispatch SkipTask), but the label
    // reads cleaner for "I don't care about this task anymore" while
    // the run isn't actively burning tokens. In-flight tasks keep
    // Cancel (the stronger "stop the agent now" affordance); created/
    // non-parked tasks keep Skip (their natural pairing with Approve).
    setVisible('dismiss', isParked || isFailed);
}

function injectTaskCardModalTriggers(frag: DocumentFragment, task: TaskRow): void {
    const actions = frag.querySelector('.task-actions');
    if (!actions) return;
    const addBtn = (label: string, action: string): HTMLButtonElement => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.setAttribute('data-action', action);
        btn.textContent = label;
        actions.appendChild(btn);
        return btn;
    };
    if (task.status === 'review' || task.status === 'test') {
        addBtn('Diff', 'diff-review');
        addBtn('Reject', 'reject');
    }
    // AP-VP5-014 — Answer button for cards parked awaiting clarification.
    // Opens the Phase 5 clarify modal with the agent's question + any
    // enumerated choices captured from `ClarificationRequested`.
    if (task.parkedReason === 'clarification') {
        addBtn('Answer', 'answer-clarification');
    }
    // Pre-commit human-review parking — opens the diff-review modal in
    // human-review mode (textarea + Approve / Request changes). Approve
    // dispatches ResumeTask{decision:'approve'} (engine follows
    // on_success → commit); Request changes dispatches
    // ResumeTask{decision:'reject', feedback} (engine follows on_failure
    // → develop with the operator's note threaded as rejectFeedback).
    if (task.parkedReason === 'worktree-diff-review') {
        addBtn('Review changes', 'human-review');
    }
    // AP-VP5-014 — Ask follow-up button for investigation cards that have
    // a thread. Opens the Phase 5 investigation-followup modal with the
    // existing thread pre-loaded.
    if (
        task.type === 'investigate'
        && Array.isArray(task.investigation_thread)
        && task.investigation_thread.length > 0
    ) {
        addBtn('Ask follow-up', 'ask-investigation-followup');
    }
    // Action visibility scoped to the task's lifecycle stage. Every
    // affordance here must be FUNCTIONAL in the state it renders in —
    // a button that opens an empty modal reads as a broken pipeline
    // (operator report: "buttons that are not functional for the state
    // they are in").
    //
    // Removed deliberately, do not re-add without a read model:
    //   - `Notes`: NoteCreated events have no projection, so the list
    //     could never populate; the modal had no Close button and
    //     re-opening it threw (overlay id already open).
    //   - `Investigate`: its open-investigations list was a hard-coded
    //     empty stub with a no-op subscribe, and the modal had no Close
    //     button. Creating investigate work goes through Add task /
    //     chat, which both dispatch real commands.
    const status = task.status || 'created';
    const isCreated = status === 'created';
    const isTerminal = status === 'done' || status === 'archived';
    const isRunning = status === 'in_progress'
        || status === 'review'
        || status === 'test'
        || status === 'commit'
        || status === 'merge';

    // AP-IFB-008 — Show agent + View report. These two are owned by
    // the columns-level click delegation registered at the bottom of
    // this file (see "task-card delegated actions"), NOT by the per-
    // card binding loop that wires the rest of `.task-actions`. The
    // loop skips them by data-action so the same handler does not
    // fire twice.
    //
    // Show agent needs an actual run to show: a task that never
    // spawned one (skipped straight from created, dependency-released
    // and cancelled, …) opened the modal on "(no active run)".
    if (!isCreated && (taskAgents.has(task.taskId) || taskStepRuns.has(task.taskId))) {
        addBtn('Show agent', 'show-agent');
    }
    // View report: only for task types whose deliverable IS a report,
    // only once one actually exists, and never mid-run — `review` and
    // `test` are LIVE agent statuses, so the old status-only gate put
    // the button on cards whose agent was still working.
    if (!isRunning && (isTerminal || status === 'failed') && taskHasReport(task)) {
        addBtn('View report', 'view-report');
    }
    // NOTE (reviewer feedback, attempt #2): a dedicated `Clarify` button
    // for parked-clarification cards used to live here, alongside the
    // template's `Resume` button. That made TWO open-triggers for the
    // same modal. Resume is the canonical surface — it routes through
    // onTaskAction → openClarify(task) for parked-clarification tasks
    // and dispatches ResumeTask blindly for wait-* parks. The dedicated
    // Clarify button is intentionally not re-added.
}

// ----- modal-trigger bindings (sidebar / header) -----------------------

ensureToastRoot();

const workerLogLauncher = document.getElementById('worker-log-launcher');
if (workerLogLauncher) {
    workerLogLauncher.addEventListener('click', (e) => {
        e.preventDefault();
        openWorkerLogModal();
    });
}

const chatLauncher = document.getElementById('open-chat-modal');
if (chatLauncher) {
    chatLauncher.addEventListener('click', (e) => {
        e.preventDefault();
        openChatModal({
            overlayManager,
            listProjects: () => crudState.projects.map((p) => ({
                id: p.id,
                name: p.name,
            })),
            listRepos: () => Array.from(repos.values())
                .filter((r) => r.archivedAt === null)
                .map((r) => ({ id: r.repoId, name: r.name })),
            currentProjectId: crudState.selectedProjectId || null,
            apiBase: API_BASE,
            renderMarkdown: (text: string) => renderMarkdown(text),
            submitBrief: submitChatProposal,
            updateProject: applyChatProjectUpdate,
            applyConfigChange: applyChatConfigChange,
            runTaskAction: runChatTaskAction,
            updateTask: applyChatTaskUpdate,
            setPlanRepo: applyChatPlanRepo,
        });
    });
}

/**
 * Apply a confirmed PROPOSE_CONFIG_CHANGE from chat. Posts to the
 * worker's /api/chat/config-apply, which proxies to the manager-api.
 * Secret settings round-trip: the server answers needsSecretValue and
 * the operator types the value here — it never travels through the
 * agent or the transcript.
 */
async function applyChatConfigChange(args: {
    sessionId: string;
    proposal: {
        target: string;
        body?: string;
        model?: string;
        provider?: string;
    };
}): Promise<boolean> {
    const post = async (operatorValue?: string): Promise<Response> =>
        fetch(`${API_BASE}/api/chat/config-apply`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                sessionId: args.sessionId,
                target: args.proposal.target,
                ...(args.proposal.body !== undefined ? { body: args.proposal.body } : {}),
                ...(args.proposal.model !== undefined ? { model: args.proposal.model } : {}),
                ...(args.proposal.provider !== undefined
                    ? { provider: args.proposal.provider }
                    : {}),
                ...(operatorValue !== undefined ? { operatorValue } : {}),
            }),
        });
    try {
        let res = await post();
        let json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (res.ok && json.needsSecretValue === true) {
            const value = window.prompt(
                `Enter the value for secret setting ${String(json.key ?? args.proposal.target)}:`,
                '',
            );
            if (value === null || value.trim().length === 0) return false;
            res = await post(value.trim());
            json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        }
        if (!res.ok) {
            showToast({
                message: `Config change failed: ${String(json.error ?? `HTTP ${res.status}`)}`,
                kind: 'error',
            });
            return false;
        }
        showToast({ message: `Config change applied: ${args.proposal.target}`, kind: 'info' });
        return true;
    } catch (err) {
        showToast({
            message: `Config change failed: ${err instanceof Error ? err.message : String(err)}`,
            kind: 'error',
        });
        return false;
    }
}

/**
 * Apply a project-update proposal from chat. Mirrors the board's
 * edit-project save path: PATCH /api/projects/:id with the new
 * description (stored on both the top-level field and the metadata
 * blob, matching how the edit-project modal saves it). Approval
 * overrides are intentionally NOT settable from chat — they're a
 * nested per-flow/per-step structure managed on the board.
 */
async function applyChatProjectUpdate(args: {
    projectId: string;
    proposal: { description: string };
}): Promise<boolean> {
    if (!args.projectId) return false;
    const existing = crudState.projects.find((p) => p.id === args.projectId);
    const metadata: Record<string, unknown> = {
        ...(existing?.metadata ?? {}),
        description: args.proposal.description,
    };
    const body: Record<string, unknown> = {
        projectId: args.projectId,
        description: args.proposal.description,
        metadata,
    };
    try {
        const res = await crudFetch(
            'PATCH',
            `/api/projects/${encodeURIComponent(args.projectId)}`,
            body,
        );
        if (!res || !res.ok) {
            showToast({ message: 'Project update failed.', kind: 'error' });
            return false;
        }
        showToast({ message: 'Project updated.', kind: 'info' });
        await loadProjects();
        return true;
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        showToast({ message: `Project update failed: ${msg}`, kind: 'error' });
        return false;
    }
}

/**
 * Run an operator task action (Approve / Merge PR) from a chat
 * progress-note button. Dispatches the same commands the board's task
 * cards use. Merge uses sendCommandOrThrow so a conflict surfaces;
 * approve is fire-and-forget with a toast.
 */
async function runChatTaskAction(args: {
    action: 'approve' | 'merge' | 'retry' | 'dismiss';
    taskId: string;
}): Promise<boolean> {
    const task = tasks.get(args.taskId);
    try {
        switch (args.action) {
            case 'merge':
                await sendCommandOrThrow({
                    type: 'MergeTaskPr',
                    actor: 'operator',
                    issuedAt: Date.now(),
                    payload: { taskId: args.taskId },
                });
                showToast({ message: `Merging PR for ${args.taskId}…`, kind: 'info' });
                return true;
            case 'approve':
                // The approval-gate command needs the flowId, which the
                // task row carries.
                await sendCommandOrThrow({
                    type: 'ApproveTask',
                    actor: 'operator',
                    issuedAt: Date.now(),
                    payload: {
                        taskId: args.taskId,
                        flowId: task?.flowId ?? task?.type ?? '',
                    },
                });
                showToast({ message: `${args.taskId} approved.`, kind: 'info' });
                return true;
            case 'retry':
                await sendCommandOrThrow({
                    type: 'RetryTask',
                    actor: 'operator',
                    issuedAt: Date.now(),
                    payload: { taskId: args.taskId },
                });
                showToast({ message: `${args.taskId} restarted.`, kind: 'info' });
                return true;
            case 'dismiss':
                await sendCommandOrThrow({
                    type: 'SkipTask',
                    actor: 'operator',
                    issuedAt: Date.now(),
                    payload: { taskId: args.taskId },
                });
                showToast({ message: `${args.taskId} dismissed.`, kind: 'info' });
                return true;
            default:
                return false;
        }
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        showToast({ message: msg, kind: 'error' });
        return false;
    }
}

/**
 * Apply a chat-proposed edit to an EXISTING task.
 *
 * Two commands, because the fields live in two places: title/description
 * are task columns (`EditTask` → `TaskFieldsUpdated`), instructions are
 * the operator's free-text note the agent reads at spawn
 * (`SetTaskInstructions` → `TaskInstructionsSet`). A proposal may carry
 * either or both; only the named fields are sent, so an instructions-only
 * edit never blanks the description.
 */
async function applyChatTaskUpdate(args: {
    taskId: string;
    title?: string;
    description?: string;
    instructions?: string;
}): Promise<boolean> {
    if (!tasks.has(args.taskId)) {
        // The agent named a task the board has never seen. Say so rather
        // than firing a command that lands on nothing.
        showToast({ message: `Unknown task ${args.taskId}.`, kind: 'error' });
        return false;
    }
    const hasFields = typeof args.title === 'string' || typeof args.description === 'string';
    try {
        if (hasFields) {
            await sendCommandOrThrow({
                type: 'EditTask',
                actor: 'operator',
                issuedAt: Date.now(),
                payload: {
                    taskId: args.taskId,
                    ...(typeof args.title === 'string' ? { title: args.title } : {}),
                    ...(typeof args.description === 'string'
                        ? { description: args.description }
                        : {}),
                },
            });
        }
        if (typeof args.instructions === 'string') {
            await sendCommandOrThrow({
                type: 'SetTaskInstructions',
                actor: 'operator',
                issuedAt: Date.now(),
                payload: { taskId: args.taskId, instructions: args.instructions },
            });
        }
        showToast({ message: `${args.taskId} updated.`, kind: 'success' });
        return true;
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        showToast({ message: msg, kind: 'error' });
        return false;
    }
}

/**
 * Apply a chat-proposed target repo for a plan.
 *
 * Same command the plan modal's dropdown sends, so the merge with the
 * plan's other metadata happens once, server-side.
 */
async function applyChatPlanRepo(args: {
    planId: string;
    repoId: string;
}): Promise<boolean> {
    if (!plans.has(args.planId)) {
        showToast({ message: `Unknown plan ${args.planId}.`, kind: 'error' });
        return false;
    }
    try {
        await sendCommandOrThrow({
            type: 'SetPlanRepo',
            actor: 'operator',
            issuedAt: Date.now(),
            payload: { planId: args.planId, repoId: args.repoId },
        });
        showToast({
            message: args.repoId.length > 0
                ? `${args.planId} now targets ${args.repoId}.`
                : `${args.planId} no longer has a target repo.`,
            kind: 'success',
        });
        return true;
    } catch (err) {
        showToast({
            message: err instanceof Error ? err.message : String(err),
            kind: 'error',
        });
        return false;
    }
}

/**
 * The `createPlan` seam for a scoped chat pane (plan / design / report).
 *
 * It routes to the SAME {@link submitChatProposal} the main chat window's
 * "Create plan & start" button uses, which is the point: a proposal made
 * in a design or report chat used to render as a dead chip reading
 * "confirm it from the main chat window", because plan creation is not a
 * single command (CreatePlan + chat-session link + GeneratePlan) and the
 * pane is only handed a command dispatcher. Sending the operator to
 * another window to re-ask a question that the scoped thread already has
 * the context for defeated the purpose of the scoped chat.
 *
 * `projectId`/`repoId` are the PANE's. A proposal naming its own
 * `Project:`/`Repo:` overrides them inside submitChatProposal, so a
 * cross-project proposal behaves identically on both surfaces.
 */
function scopedChatCreatePlan(
    projectId: string,
    repoId: string | null,
): NonNullable<ScopedChatOptions['createPlan']> {
    return (args) => submitChatProposal({
        sessionId: args.sessionId,
        projectId,
        repoId,
        proposal: args.proposal,
    });
}

/**
 * Turn a chat task proposal into a real plan and kick the planner.
 * Mirrors the board's "Save & run planner" flow: create the plan with
 * the proposal's title + description as the brief body (and planType /
 * targetRepo metadata), then fire GeneratePlan so the pipeline takes
 * over. The operator then sees the plan on the board and walks it
 * through decompose → tasks → review → merge exactly as if they'd
 * authored the brief by hand.
 */
async function submitChatProposal(args: {
    sessionId: string;
    projectId: string;
    repoId: string | null;
    proposal: {
        title: string;
        type: string;
        description: string;
        projectId?: string;
        repoId?: string;
    };
}): Promise<boolean> {
    // Cross-project targeting: a `Project:` field in the PROPOSE_TASK block
    // overrides the chat session's project — e.g. a framework-library bug
    // found while chatting in a business project. Match by id first, then
    // case-insensitively by name; an unknown target errors instead of
    // silently landing the plan in the wrong project.
    let projectId = args.projectId;
    let repoId = args.repoId;
    if (args.proposal.projectId && args.proposal.projectId.length > 0) {
        const wanted = args.proposal.projectId.toLowerCase();
        const target = crudState.projects.find((p) => p.id.toLowerCase() === wanted)
            ?? crudState.projects.find((p) => (p.name ?? '').toLowerCase() === wanted);
        if (!target) {
            showToast({
                message: `Proposal targets unknown project "${args.proposal.projectId}".`,
                kind: 'error',
            });
            return false;
        }
        projectId = target.id;
        // A cross-project proposal must not drag the session's repo along —
        // the proposal's own Repo: field (below) or nothing.
        repoId = null;
    }
    if (args.proposal.repoId && args.proposal.repoId.length > 0) {
        repoId = args.proposal.repoId;
    }
    if (!projectId) {
        showToast({ message: 'Chat session has no project — cannot create a plan.', kind: 'error' });
        return false;
    }
    // Pre-mint a planId so we can fire generate-plan against the same
    // key without waiting on the SSE projection round-trip (same trick
    // the new-plan modal's "Save & run planner" path uses).
    const planId = `id-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const metadata: Record<string, unknown> = { planType: args.proposal.type };
    if (repoId !== null) metadata.targetRepo = repoId;
    try {
        await onCreatePlan(projectId, {
            title: args.proposal.title,
            body: args.proposal.description,
            metadata,
            planId,
        });
        // Persist the plan → chat-session link so the server-side
        // narrator (hosts/worker-api/chat-note-generator.ts) can append
        // progress notes to this thread for every pipeline milestone —
        // independent of whether this board tab stays open.
        void fetch(`${API_BASE}/api/chat/links`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ planId, sessionId: args.sessionId }),
        }).catch(() => { /* best-effort; the operator can retry the proposal */ });
        const url = `${API_BASE}/api/projects/${encodeURIComponent(projectId)}/plans/${encodeURIComponent(planId)}/generate-plan`;
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                revision: 1,
                briefContent: args.proposal.description,
            }),
        });
        if (!res.ok) {
            throw new Error(`GeneratePlan dispatch failed: HTTP ${res.status}`);
        }
        showToast({
            message: `Plan "${args.proposal.title}" created — planner dispatched.`,
            kind: 'info',
        });
        return true;
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        showToast({ message: `Could not create plan: ${msg}`, kind: 'error' });
        return false;
    }
}

// AP-IFB-008 — task-card delegated actions.
//
// "Show agent" expands the inline `[data-agent-stream]` section on the
// originating card; "View report" opens the AP-IFB-007 review-report
// modal pre-populated with whatever report content the projection has
// for that task. Both live behind one bubbling listener so every card —
// including the investigation followup chip's "Show agent" — flows
// through a single delegation seam rather than per-card listeners.
//
// The old `section.columns` root was removed when the layout switched
// to the section-list. Bind to the section-list container instead so
// cards under `#all-tasks` (and any future per-section task surface)
// flow through the same delegation seam.
// Delegated at BODY level deliberately: task cards render in the flat
// Tasks section AND inside the plan modal's task list (an overlay that
// lives outside [data-section-list]) — a section-scoped listener left
// show-agent / view-report dead on modal-rendered cards. The handler
// filters by closest('[data-task-card]') + data-action, so body-wide
// delegation stays precise.
const taskActionsRoot = document.body;
taskActionsRoot.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    if (!target || typeof target.closest !== 'function') return;

    // Stage-bar chip click. Branches based on the chip's data-state:
    //   awaiting → open the Phase 5 clarify modal so the operator can
    //              type a reply that resumes the parked agent
    //   anything else with a record → open the per-step summary modal
    //   todo (no record) → noop
    const stageCell = target.closest('[data-stage]') as HTMLElement | null;
    if (stageCell) {
        const cardEl = stageCell.closest('[data-task-card]') as HTMLElement | null;
        if (!cardEl) return;
        const taskId = cardEl.getAttribute('data-task-id') || '';
        // P-TOTS-006: `data-stage` now carries the flow's real step id, so
        // it keys straight into `taskStepRuns` with no stage-alias
        // indirection (the old STAGE_ID_TO_STEP_ID hop, which mismapped
        // e.g. the investigate chip).
        const stepId = stageCell.getAttribute('data-stage') || '';
        if (!taskId || !stepId) return;
        const state = stageCell.getAttribute('data-state') || '';
        if (state === 'awaiting') {
            const task = tasks.get(taskId);
            if (task) {
                event.preventDefault();
                openClarificationAnswer(task);
            }
            return;
        }
        const rec = taskStepRuns.get(taskId)?.get(stepId);
        if (!rec) return; // todo chip — no record yet, click is a noop
        event.preventDefault();
        openTaskStepSummaryModal(taskId, stepId, rec);
        return;
    }

    const btn = target.closest('button[data-action]') as HTMLButtonElement | null;
    if (!btn) return;
    const action = btn.dataset.action || '';
    if (action !== 'show-agent' && action !== 'view-report') return;
    const cardEl = btn.closest('[data-task-card]') as HTMLElement | null;
    if (!cardEl) return;
    const taskId = cardEl.getAttribute('data-task-id') || '';
    const task = tasks.get(taskId);
    if (!task) return;
    event.preventDefault();
    if (action === 'show-agent') onShowAgent(task);
    else openReviewReportForTask(task);
});

// Section collapse/expand. Clicking a section header toggles a
// `data-collapsed` attribute on the section; the CSS keys off that to
// hide the body and rotate the chevron. State is persisted to
// localStorage keyed by `data-section` so the operator's choice
// survives reloads.
const SECTION_COLLAPSE_STORAGE_KEY = 'board:section-collapsed';

function loadCollapsedSections(): Set<string> {
    try {
        const raw = localStorage.getItem(SECTION_COLLAPSE_STORAGE_KEY);
        if (!raw) return new Set();
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return new Set();
        return new Set(parsed.filter((s): s is string => typeof s === 'string'));
    } catch {
        return new Set();
    }
}

function persistCollapsedSections(collapsed: Set<string>): void {
    try {
        localStorage.setItem(
            SECTION_COLLAPSE_STORAGE_KEY,
            JSON.stringify(Array.from(collapsed)),
        );
    } catch {
        // localStorage can be unavailable (private-browsing quirks);
        // collapse state staying in-memory only is an acceptable
        // degradation.
    }
}

/**
 * Toggle the section's `data-collapsed` + the body's `hidden`. The
 * chevron is a CSS `::before` pseudo-element that rotates -90° when
 * the section has `[data-collapsed]`, and the body is hidden via the
 * existing `.section-body[hidden] { display: none }` rule. Persists
 * the choice to localStorage so a reload restores the same state.
 */
/**
 * Is the event target an interactive control inside a section header,
 * rather than the header itself?
 *
 * The header is a click-to-collapse button, so anything the operator is
 * meant to USE in it has to be excluded. It was `closest('button')`
 * alone, which covered the `Show archived` toggle; a search input is not
 * a button, so clicking it collapsed the section and typing a space in
 * it did too.
 */
function isHeaderControl(target: EventTarget | null): boolean {
    const el = target as HTMLElement | null;
    if (!el || typeof el.closest !== 'function') return false;
    return el.closest('button, input, textarea, select, label, a') !== null;
}

function toggleSectionCollapsed(section: HTMLElement, persisted: Set<string>): void {
    const id = section.getAttribute('data-section') ?? '';
    const wasCollapsed = section.hasAttribute('data-collapsed');
    if (wasCollapsed) {
        section.removeAttribute('data-collapsed');
        persisted.delete(id);
    } else {
        section.setAttribute('data-collapsed', '');
        persisted.add(id);
    }
    const body = section.querySelector<HTMLElement>('[data-section-body]');
    if (body) body.toggleAttribute('hidden', !wasCollapsed);
    persistCollapsedSections(persisted);
}

// Wire each section header directly so the toggle doesn't depend on
// any document-level delegation or `closest()` combinator quirks.
// Restoring the collapsed-on-boot state and binding the click/keyboard
// handlers happen in the same pass so a section that loads collapsed
// has the same click behaviour as one that loads expanded.
(() => {
    const collapsed = loadCollapsedSections();
    const sections = document.querySelectorAll<HTMLElement>(
        '[data-section-list] section[data-section]',
    );
    for (const section of sections) {
        const id = section.getAttribute('data-section') ?? '';
        if (!id) continue;
        const header = section.querySelector<HTMLElement>('[data-section-header]');
        if (!header) continue;
        header.setAttribute('role', 'button');
        header.setAttribute('tabindex', '0');
        if (collapsed.has(id)) {
            section.setAttribute('data-collapsed', '');
            const body = section.querySelector<HTMLElement>('[data-section-body]');
            if (body) body.setAttribute('hidden', '');
        }
        const handler = (event: Event): void => {
            // Don't hijack clicks on in-header buttons (the
            // archived-plans `Show archived` toggle, future per-
            // section action buttons).
            if (isHeaderControl(event.target)) return;
            event.preventDefault();
            toggleSectionCollapsed(section, collapsed);
        };
        header.addEventListener('click', handler);
        header.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            // SPACE is load-bearing here: the archived-plans header holds
            // a search input, and without this guard typing a space in
            // it collapsed the whole section mid-word.
            if (isHeaderControl(event.target)) return;
            event.preventDefault();
            toggleSectionCollapsed(section, collapsed);
        });
    }
})();

// Archived-plans search. Bound once at boot; the render reads
// `archivedPlanQuery` on every pass, so a keystroke only has to update
// the variable and ask for a repaint.
(() => {
    const input = document.querySelector<HTMLInputElement>('[data-archived-search]');
    if (!input) return;
    const section = document.getElementById('archived-plans');
    input.addEventListener('input', () => {
        archivedPlanQuery = input.value;
        // Expand on the first keystroke. The section is collapsed by
        // default and the box lives in its header, so searching without
        // this types into a control whose results are hidden — which
        // reads as the search not working.
        if (section && isSearching(archivedPlanQuery)) {
            section.removeAttribute('data-collapsed');
            const body = section.querySelector<HTMLElement>('[data-section-body]');
            if (body) body.removeAttribute('hidden');
        }
        scheduleRender();
    });
    // Escape clears, which is what a type-to-filter box is expected to
    // do and saves selecting-all to delete. Stopped from propagating so
    // it does not also close something behind the board.
    input.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape' || input.value.length === 0) return;
        event.stopPropagation();
        input.value = '';
        archivedPlanQuery = '';
        scheduleRender();
    });
})();

const headerActionsEl = document.getElementById('header-actions');
if (headerActionsEl) {
    const newPlanBtn = document.createElement('button');
    newPlanBtn.type = 'button';
    newPlanBtn.className = 'header-action header-action--new-plan';
    newPlanBtn.setAttribute('data-action', 'open-new-plan');
    newPlanBtn.textContent = '+ New plan';
    newPlanBtn.addEventListener('click', (e) => {
        e.preventDefault();
        openNewPlan(crudState.selectedProjectId);
    });
    headerActionsEl.appendChild(newPlanBtn);
}

// ---------- Workspace repo registry (UI) -----------------------------------
//
// A single workspace-level Repos modal. The sidebar button opens it; the
// modal renders the current list of repos with inline Sync / Edit /
// Archive controls, an "Add repo" form at the top, and a Refresh-all
// button in the header. State syncs through both an initial GET on boot
// and SSE Repo* events folded into {@link repos}.

interface RepoUiRow {
    readonly repoId: string;
    readonly name: string;
    readonly url: string;
    readonly defaultBranch: string;
    readonly ensuredPath: string | null;
    readonly lastSyncedAt: number | null;
    readonly lastSyncStatus: 'ok' | 'clone-failed' | 'sync-failed' | null;
    readonly lastSyncError: string | null;
    readonly archivedAt: number | null;
    readonly updatedAt: number;
    /**
     * Declared GitHub account this repo is reached with, or null for
     * the machine's ambient gh identity.
     */
    readonly githubAccount: string | null;
}
const repos = new Map<string, RepoUiRow>();
const REPOS_MODAL_OVERLAY_ID = 'repos-modal';
let reposModalBackdrop: HTMLElement | null = null;
let reposModalBody: HTMLElement | null = null;
const repoEditOpen = new Set<string>();

function applyRepoEvent(type: string, payload: Record<string, unknown>): void {
    const repoId = typeof payload.repoId === 'string' ? payload.repoId : null;
    if (!repoId) return;
    const at
        = typeof payload.at === 'number' ? payload.at : Date.now();

    if (type === 'RepoRegistered' || type === 'RepoUpdated') {
        const existing = repos.get(repoId);
        const next: RepoUiRow = {
            repoId,
            // One rule for all three, because having three was the
            // bug: `name` lacked the non-empty guard that `url` had,
            // and UpdateRepo sends '' for every field the operator
            // did not touch - so editing anything else blanked the
            // name on screen while the database kept it.
            name: foldRepoText(payload.name, existing?.name, repoId),
            url: foldRepoText(payload.url, existing?.url, ''),
            defaultBranch: foldRepoText(
                payload.defaultBranch,
                existing?.defaultBranch,
                'main',
            ),
            ensuredPath: existing?.ensuredPath ?? null,
            lastSyncedAt: existing?.lastSyncedAt ?? null,
            lastSyncStatus: existing?.lastSyncStatus ?? null,
            lastSyncError: existing?.lastSyncError ?? null,
            // RepoRegistered for a previously-archived row un-archives.
            archivedAt: type === 'RepoRegistered' ? null : existing?.archivedAt ?? null,
            updatedAt: at,
            // The deliberate exception to the rule above: here the
            // empty string is MEANINGFUL - it is how an Update clears
            // the mapping. An absent field still means "unchanged".
            githubAccount: foldRepoAccount(
                payload.githubAccount,
                existing?.githubAccount,
            ),
        };
        repos.set(repoId, next);
    } else if (type === 'RepoArchived') {
        const existing = repos.get(repoId);
        if (existing) {
            repos.set(repoId, { ...existing, archivedAt: at, updatedAt: at });
        }
    } else if (type === 'RepoEnsured' || type === 'RepoSynced') {
        const existing = repos.get(repoId);
        const ensuredPath
            = type === 'RepoEnsured' && typeof payload.ensuredPath === 'string'
                ? (payload.ensuredPath as string)
                : existing?.ensuredPath ?? null;
        if (existing) {
            repos.set(repoId, {
                ...existing,
                ensuredPath,
                lastSyncedAt: at,
                lastSyncStatus: 'ok',
                lastSyncError: null,
                updatedAt: at,
            });
        }
    } else if (type === 'RepoEnsureFailed' || type === 'RepoSyncFailed') {
        const existing = repos.get(repoId);
        const status = type === 'RepoEnsureFailed' ? 'clone-failed' : 'sync-failed';
        const error = typeof payload.error === 'string' ? (payload.error as string) : '';
        if (existing) {
            repos.set(repoId, {
                ...existing,
                lastSyncedAt: at,
                lastSyncStatus: status,
                lastSyncError: error,
                updatedAt: at,
            });
        }
    }
    refreshReposModal();
}

async function loadRepos(): Promise<void> {
    interface RawRepo {
        readonly repoId?: string;
        readonly name?: string;
        readonly url?: string;
        readonly defaultBranch?: string;
        readonly ensuredPath?: string | null;
        readonly lastSyncedAt?: number | null;
        readonly lastSyncStatus?: 'ok' | 'clone-failed' | 'sync-failed' | null;
        readonly lastSyncError?: string | null;
        readonly archivedAt?: number | null;
        readonly updatedAt?: number | null;
        readonly githubAccount?: string | null;
    }
    try {
        const res = await fetch(`${API_BASE}/api/repos`);
        if (!res.ok) return;
        const json = (await res.json()) as { repos?: RawRepo[] };
        const list = Array.isArray(json.repos) ? json.repos : [];
        repos.clear();
        for (const raw of list) {
            if (typeof raw.repoId !== 'string') continue;
            repos.set(raw.repoId, {
                repoId: raw.repoId,
                name: typeof raw.name === 'string' ? raw.name : raw.repoId,
                url: typeof raw.url === 'string' ? raw.url : '',
                defaultBranch: typeof raw.defaultBranch === 'string' ? raw.defaultBranch : 'main',
                ensuredPath: typeof raw.ensuredPath === 'string' ? raw.ensuredPath : null,
                lastSyncedAt: typeof raw.lastSyncedAt === 'number' ? raw.lastSyncedAt : null,
                lastSyncStatus:
                    raw.lastSyncStatus === 'ok'
                    || raw.lastSyncStatus === 'clone-failed'
                    || raw.lastSyncStatus === 'sync-failed'
                        ? raw.lastSyncStatus
                        : null,
                lastSyncError: typeof raw.lastSyncError === 'string' ? raw.lastSyncError : null,
                archivedAt: typeof raw.archivedAt === 'number' ? raw.archivedAt : null,
                updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0,
                githubAccount: typeof raw.githubAccount === 'string'
                    ? raw.githubAccount
                    : null,
            });
        }
        refreshReposModal();
    } catch {
        // Worker-api unreachable — modal will show an empty list and
        // an inline error when the operator tries to act on it.
    }
}

function openReposModal(): void {
    if (reposModalBackdrop !== null) closeReposModal();
    const root = ensureOverlayRoot();
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-chrome__overlay';
    backdrop.setAttribute('data-repos-modal-overlay', '');
    const panel = document.createElement('div');
    panel.className = 'repos-modal modal-chrome';
    panel.setAttribute('data-repos-modal', '');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-labelledby', 'repos-modal-title');

    const header = document.createElement('div');
    header.className = 'modal-chrome__header';
    const title = document.createElement('h3');
    title.id = 'repos-modal-title';
    title.className = 'modal-chrome__title';
    title.textContent = 'Repositories';
    header.appendChild(title);

    const refreshAllBtn = document.createElement('button');
    refreshAllBtn.type = 'button';
    refreshAllBtn.className = 'np-button';
    refreshAllBtn.setAttribute('data-action', 'refresh-all-repos');
    refreshAllBtn.textContent = 'Refresh all';
    refreshAllBtn.addEventListener('click', () => {
        void onRefreshAllRepos();
    });
    header.appendChild(refreshAllBtn);

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'modal-chrome__close';
    closeBtn.setAttribute('data-action', 'close');
    closeBtn.textContent = 'Close';
    closeBtn.addEventListener('click', closeReposModal);
    header.appendChild(closeBtn);
    panel.appendChild(header);

    const body = document.createElement('div');
    body.className = 'repos-modal__body modal-chrome__body';
    body.setAttribute('data-repos-modal-body', '');
    panel.appendChild(body);

    backdrop.appendChild(panel);
    root.appendChild(backdrop);
    overlayManager.openOverlay(REPOS_MODAL_OVERLAY_ID, panel);

    reposModalBackdrop = backdrop;
    reposModalBody = body;

    // Fetch fresh state on open so a user landing here for the first
    // time sees the projection without waiting for an SSE event.
    void loadRepos();
    refreshReposModal();
}

function closeReposModal(): void {
    if (reposModalBackdrop === null) return;
    overlayManager.closeOverlay(REPOS_MODAL_OVERLAY_ID);
    reposModalBackdrop.remove();
    reposModalBackdrop = null;
    reposModalBody = null;
    repoEditOpen.clear();
}

function refreshReposModal(): void {
    if (!reposModalBody) return;
    const rows = Array.from(repos.values())
        .filter((r) => r.archivedAt === null)
        .sort((a, b) => a.name.localeCompare(b.name));

    const children: HTMLElement[] = [];
    children.push(renderRepoAddSection());

    if (rows.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'repos-empty';
        empty.textContent
            = 'No repositories registered yet. Add one above to get started.';
        children.push(empty);
    } else {
        for (const repo of rows) {
            children.push(renderRepoRow(repo));
        }
    }
    reposModalBody.replaceChildren(...children);
}

/**
 * Mode toggle in the Repos modal: either "Register existing" (point
 * at a clone URL the operator already owns on GitHub) or "Create new"
 * (have the orchestrator run `gh repo create` + seed CLAUDE.md). The
 * active mode lives at module scope so the toggle survives
 * refreshReposModal() re-renders triggered by SSE events landing
 * while the modal is open.
 */
type RepoAddMode = 'register' | 'create';
let repoAddMode: RepoAddMode = 'register';

function renderRepoAddSection(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'repo-add-section';

    const tabs = document.createElement('div');
    tabs.className = 'repo-add-tabs';
    tabs.setAttribute('role', 'tablist');

    const mkTab = (mode: RepoAddMode, label: string): HTMLButtonElement => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'repo-add-tab';
        if (repoAddMode === mode) btn.classList.add('repo-add-tab--active');
        btn.setAttribute('role', 'tab');
        btn.setAttribute(
            'aria-selected',
            repoAddMode === mode ? 'true' : 'false',
        );
        btn.textContent = label;
        btn.addEventListener('click', () => {
            if (repoAddMode === mode) return;
            repoAddMode = mode;
            refreshReposModal();
        });
        return btn;
    };
    tabs.appendChild(mkTab('register', 'Register existing'));
    tabs.appendChild(mkTab('create', 'Create new'));
    wrap.appendChild(tabs);

    wrap.appendChild(
        repoAddMode === 'register' ? renderAddRepoForm() : renderCreateRepoForm(),
    );
    return wrap;
}

function renderCreateRepoForm(): HTMLElement {
    const form = document.createElement('form');
    form.className = 'repo-add-form';
    form.setAttribute('data-form', 'create-repo');

    const heading = document.createElement('h4');
    heading.className = 'repo-add-form__heading';
    heading.textContent = 'Create new repository';
    form.appendChild(heading);

    const hint = document.createElement('p');
    hint.className = 'repo-add-form__hint';
    hint.textContent =
        'Creates a new GitHub repo, clones it into the workspace, and seeds '
        + 'CLAUDE.md with the description below. The pipeline\'s `gh` auth needs '
        + 'permission to create repos in the chosen owner.';
    form.appendChild(hint);

    const grid = document.createElement('div');
    grid.className = 'repo-add-form__grid';

    const ownerLabel = document.createElement('label');
    ownerLabel.className = 'repo-add-form__field';
    ownerLabel.innerHTML = '<span>Owner / org</span>';
    const ownerInput = document.createElement('input');
    ownerInput.type = 'text';
    ownerInput.name = 'owner';
    ownerInput.placeholder = 'fetching gh user…';
    ownerInput.required = true;
    ownerLabel.appendChild(ownerInput);
    grid.appendChild(ownerLabel);
    // Default the Owner field to the gh-authenticated user so the
    // operator doesn't have to type their own login.
    void fetchGhAuthLogin().then((login) => {
        if (ownerInput.value.length === 0 && login.length > 0) {
            ownerInput.placeholder = login;
            ownerInput.value = login;
        } else {
            ownerInput.placeholder = 'e.g. example-org';
        }
    });

    const nameLabel = document.createElement('label');
    nameLabel.className = 'repo-add-form__field';
    nameLabel.innerHTML = '<span>Name</span>';
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.name = 'name';
    nameInput.placeholder = 'loan-allowances';
    nameInput.required = true;
    nameLabel.appendChild(nameInput);
    grid.appendChild(nameLabel);

    const visLabel = document.createElement('label');
    visLabel.className = 'repo-add-form__field';
    visLabel.innerHTML = '<span>Visibility</span>';
    const visSelect = document.createElement('select');
    visSelect.name = 'visibility';
    const visPrivate = document.createElement('option');
    visPrivate.value = 'private';
    visPrivate.textContent = 'Private';
    visPrivate.selected = true;
    const visPublic = document.createElement('option');
    visPublic.value = 'public';
    visPublic.textContent = 'Public';
    visSelect.appendChild(visPrivate);
    visSelect.appendChild(visPublic);
    visLabel.appendChild(visSelect);
    grid.appendChild(visLabel);

    const branchLabel = document.createElement('label');
    branchLabel.className = 'repo-add-form__field';
    branchLabel.innerHTML = '<span>Default branch</span>';
    const branchInput = document.createElement('input');
    branchInput.type = 'text';
    branchInput.name = 'defaultBranch';
    branchInput.placeholder = 'main';
    branchLabel.appendChild(branchInput);
    grid.appendChild(branchLabel);

    const account = buildRepoAccountField();
    grid.appendChild(account.field);

    form.appendChild(grid);

    const descLabel = document.createElement('label');
    descLabel.className = 'repo-add-form__field repo-add-form__field--full';
    descLabel.innerHTML = '<span>Description (purpose)</span>';
    const descInput = document.createElement('textarea');
    descInput.name = 'description';
    descInput.required = true;
    descInput.rows = 5;
    descInput.placeholder =
        'Describe the purpose of this repo. Seeds the new repo\'s CLAUDE.md\n'
        + 'so the planner / developer agents understand the intent on first run.';
    descLabel.appendChild(descInput);
    form.appendChild(descLabel);

    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.className = 'np-button';
    submit.textContent = 'Create repository';
    form.appendChild(submit);

    form.addEventListener('submit', (e) => {
        e.preventDefault();
        const owner = ownerInput.value.trim();
        const name = nameInput.value.trim();
        const description = descInput.value.trim();
        const visibility = (visSelect.value as 'private' | 'public') ?? 'private';
        const defaultBranch = branchInput.value.trim();
        if (!owner || !name || !description) return;
        submit.disabled = true;
        submit.textContent = 'Creating…';
        const githubAccount = account.select.value.trim();
        void onCreateRepo({
            owner,
            name,
            description,
            visibility,
            defaultBranch: defaultBranch.length > 0 ? defaultBranch : undefined,
            // Omitted when blank rather than sent as '': the handler
            // treats absent as "ambient identity", and an empty string
            // would be stored as a mapping to an account named ''.
            ...(githubAccount.length > 0 ? { githubAccount } : {}),
        })
            .then(() => {
                nameInput.value = '';
                descInput.value = '';
                branchInput.value = '';
            })
            .finally(() => {
                submit.disabled = false;
                submit.textContent = 'Create repository';
            });
    });
    return form;
}

/**
 * Best-effort lookup of the gh-authenticated user's login. Used to
 * default the Owner field on the Create new form. Network failures
 * resolve to empty so the field stays blank rather than blocking the
 * form.
 */
let cachedGhAuthLogin: string | null = null;
async function fetchGhAuthLogin(): Promise<string> {
    if (cachedGhAuthLogin !== null) return cachedGhAuthLogin;
    try {
        const res = await fetch(`${API_BASE}/api/gh/auth-user`);
        if (!res.ok) {
            cachedGhAuthLogin = '';
            return '';
        }
        const json = (await res.json()) as { login?: unknown };
        const login = typeof json.login === 'string' ? json.login : '';
        cachedGhAuthLogin = login;
        return login;
    } catch {
        cachedGhAuthLogin = '';
        return '';
    }
}

/**
 * Declared GitHub account ids, for the repo forms.
 *
 * Memoised like the gh-auth login lookup beside it: the list changes
 * only when the operator edits it in the manager UI, which needs a
 * worker restart to take effect anyway. An empty list (nothing
 * declared, or the worker unreachable) means the forms omit the
 * picker entirely rather than offering an empty dropdown.
 */
let cachedGithubAccountIds: string[] | null = null;

async function fetchGithubAccountIds(): Promise<string[]> {
    if (cachedGithubAccountIds !== null) return cachedGithubAccountIds;
    try {
        const res = await fetch(`${API_BASE}/api/github-accounts`);
        if (!res.ok) {
            cachedGithubAccountIds = [];
            return cachedGithubAccountIds;
        }
        const json = (await res.json()) as { accounts?: unknown };
        cachedGithubAccountIds = Array.isArray(json.accounts)
            ? json.accounts.filter((a): a is string => typeof a === 'string')
            : [];
    } catch {
        cachedGithubAccountIds = [];
    }
    return cachedGithubAccountIds;
}

/**
 * The GitHub-account picker for a repo form.
 *
 * Hidden until the list arrives, and left hidden when nothing is
 * declared — an install with one GitHub account should not grow a
 * control that can only say "default". The empty option is the
 * default and means the machine's ambient identity, which is what
 * every repo used before accounts existed.
 */
function buildRepoAccountField(selected?: string | null): {
    readonly field: HTMLElement;
    readonly select: HTMLSelectElement;
} {
    const label = document.createElement('label');
    label.className = 'repo-add-form__field';
    label.hidden = true;
    const span = document.createElement('span');
    span.textContent = 'GitHub account';
    label.appendChild(span);
    const select = document.createElement('select');
    select.name = 'githubAccount';
    select.title = 'Which declared GitHub account reaches this repo;'
        + ' Default uses the machine own gh login.';
    label.appendChild(select);
    void fetchGithubAccountIds().then((ids) => {
        // What to offer, and what to pre-select, is decided by
        // repoAccountPicker - including the case with teeth, a repo
        // mapped to an account that is no longer declared. See
        // repo-account-options.test.ts.
        const picker = repoAccountPicker(ids, selected);
        if (!picker.visible) return;
        for (const opt of picker.options) {
            const option = document.createElement('option');
            option.value = opt.value;
            option.textContent = opt.label;
            select.appendChild(option);
        }
        // Set AFTER the options exist; assigning value to an empty
        // select is a no-op.
        select.value = picker.selected;
        label.hidden = false;
    });
    return { field: label, select };
}

function renderAddRepoForm(): HTMLElement {
    const form = document.createElement('form');
    form.className = 'repo-add-form';
    form.setAttribute('data-form', 'add-repo');

    const heading = document.createElement('h4');
    heading.className = 'repo-add-form__heading';
    heading.textContent = 'Add repository';
    form.appendChild(heading);

    const grid = document.createElement('div');
    grid.className = 'repo-add-form__grid';

    const nameLabel = document.createElement('label');
    nameLabel.className = 'repo-add-form__field';
    nameLabel.innerHTML = '<span>Name</span>';
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.name = 'name';
    nameInput.placeholder = 'Config service';
    nameInput.required = true;
    nameLabel.appendChild(nameInput);
    grid.appendChild(nameLabel);

    const urlLabel = document.createElement('label');
    urlLabel.className = 'repo-add-form__field';
    urlLabel.innerHTML = '<span>Clone URL</span>';
    const urlInput = document.createElement('input');
    urlInput.type = 'text';
    urlInput.name = 'url';
    urlInput.placeholder = 'https://github.com/example/configservice';
    urlInput.required = true;
    urlLabel.appendChild(urlInput);
    grid.appendChild(urlLabel);

    const branchLabel = document.createElement('label');
    branchLabel.className = 'repo-add-form__field';
    branchLabel.innerHTML = '<span>Default branch</span>';
    const branchInput = document.createElement('input');
    branchInput.type = 'text';
    branchInput.name = 'defaultBranch';
    branchInput.placeholder = 'main';
    branchLabel.appendChild(branchInput);
    grid.appendChild(branchLabel);

    form.appendChild(grid);

    const account = buildRepoAccountField();
    grid.appendChild(account.field);

    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.className = 'np-button';
    submit.textContent = 'Register repository';
    form.appendChild(submit);

    form.addEventListener('submit', (e) => {
        e.preventDefault();
        const name = nameInput.value.trim();
        const url = urlInput.value.trim();
        const defaultBranch = branchInput.value.trim();
        if (!name || !url) return;
        const githubAccount = account.select.value.trim();
        void onRegisterRepo({
            name,
            url,
            defaultBranch: defaultBranch.length > 0 ? defaultBranch : undefined,
            // Omitted when empty, not sent as "": on a REGISTER the
            // projection COALESCEs an absent account to whatever is
            // already stored, which is what keeps a re-register from
            // clearing an existing mapping.
            ...(githubAccount.length > 0 ? { githubAccount } : {}),
        }).then(() => {
            nameInput.value = '';
            urlInput.value = '';
            branchInput.value = '';
        });
    });
    return form;
}

function renderRepoRow(repo: RepoUiRow): HTMLElement {
    const row = document.createElement('div');
    row.className = 'repo-row';
    row.setAttribute('data-repo-id', repo.repoId);

    if (repoEditOpen.has(repo.repoId)) {
        row.appendChild(renderRepoEditForm(repo));
        return row;
    }

    const head = document.createElement('div');
    head.className = 'repo-row__head';
    // "<account> - <name>" when the repo is mapped. Its own element,
    // not part of the bold name, so the account reads as a qualifier
    // and the name stays the thing you scan for. An UNMAPPED repo shows
    // the name alone rather than a placeholder: which repos carry a
    // non-default account is the signal worth seeing, and "default - x"
    // on every row would bury it.
    if (repo.githubAccount) {
        const account = document.createElement('span');
        account.className = 'repo-row__account';
        account.textContent = `${repo.githubAccount} - `;
        account.title = `Reached with the "${repo.githubAccount}" GitHub account`;
        head.appendChild(account);
    }
    const name = document.createElement('span');
    name.className = 'repo-row__name';
    name.textContent = repo.name;
    head.appendChild(name);

    const status = document.createElement('span');
    status.className = `repo-row__status repo-row__status--${repo.lastSyncStatus ?? 'unknown'}`;
    status.textContent = repoStatusLabel(repo);
    head.appendChild(status);
    row.appendChild(head);

    const meta = document.createElement('div');
    meta.className = 'repo-row__meta';
    meta.textContent = `${repo.url} · branch: ${repo.defaultBranch}`;
    row.appendChild(meta);

    if (repo.lastSyncError) {
        const err = document.createElement('div');
        err.className = 'repo-row__error';
        err.textContent = `Error: ${repo.lastSyncError}`;
        row.appendChild(err);
    }

    const actions = document.createElement('div');
    actions.className = 'repo-row__actions';

    const syncBtn = document.createElement('button');
    syncBtn.type = 'button';
    syncBtn.className = 'np-button';
    syncBtn.setAttribute('data-action', 'sync-repo');
    syncBtn.textContent = 'Sync now';
    syncBtn.addEventListener('click', () => {
        void onRefreshRepo(repo.repoId);
    });
    actions.appendChild(syncBtn);

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'np-button';
    editBtn.setAttribute('data-action', 'edit-repo');
    editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', () => {
        repoEditOpen.add(repo.repoId);
        refreshReposModal();
    });
    actions.appendChild(editBtn);

    const archiveBtn = document.createElement('button');
    archiveBtn.type = 'button';
    archiveBtn.className = 'np-button np-button--danger';
    archiveBtn.setAttribute('data-action', 'archive-repo');
    archiveBtn.textContent = 'Archive';
    archiveBtn.addEventListener('click', () => {
        if (
            !confirm(
                `Archive repository "${repo.name}"? The on-disk clone is kept; the row is hidden from pickers.`,
            )
        ) {
            return;
        }
        void onArchiveRepo(repo.repoId);
    });
    actions.appendChild(archiveBtn);

    row.appendChild(actions);
    return row;
}

function renderRepoEditForm(repo: RepoUiRow): HTMLElement {
    const form = document.createElement('form');
    form.className = 'repo-row__edit';
    form.setAttribute('data-form', 'edit-repo');

    const grid = document.createElement('div');
    grid.className = 'repo-add-form__grid';

    const nameLabel = document.createElement('label');
    nameLabel.className = 'repo-add-form__field';
    nameLabel.innerHTML = '<span>Name</span>';
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.value = repo.name;
    nameLabel.appendChild(nameInput);
    grid.appendChild(nameLabel);

    const urlLabel = document.createElement('label');
    urlLabel.className = 'repo-add-form__field';
    urlLabel.innerHTML = '<span>Clone URL</span>';
    const urlInput = document.createElement('input');
    urlInput.type = 'text';
    urlInput.value = repo.url;
    urlLabel.appendChild(urlInput);
    grid.appendChild(urlLabel);

    const branchLabel = document.createElement('label');
    branchLabel.className = 'repo-add-form__field';
    branchLabel.innerHTML = '<span>Default branch</span>';
    const branchInput = document.createElement('input');
    branchInput.type = 'text';
    branchInput.value = repo.defaultBranch;
    branchLabel.appendChild(branchInput);
    grid.appendChild(branchLabel);

    // Changing a repo's account is an EDIT, not a re-registration:
    // re-registering to change one field means retyping the name and
    // URL and hoping they match.
    const account = buildRepoAccountField(repo.githubAccount);
    grid.appendChild(account.field);

    form.appendChild(grid);

    const actions = document.createElement('div');
    actions.className = 'repo-row__actions';

    const save = document.createElement('button');
    save.type = 'submit';
    save.className = 'np-button';
    save.textContent = 'Save';
    actions.appendChild(save);

    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'np-button';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => {
        repoEditOpen.delete(repo.repoId);
        refreshReposModal();
    });
    actions.appendChild(cancel);

    form.appendChild(actions);

    form.addEventListener('submit', (e) => {
        e.preventDefault();
        const body: {
            repoId: string;
            name?: string;
            url?: string;
            defaultBranch?: string;
            githubAccount?: string;
        } = {
            repoId: repo.repoId,
        };
        const newName = nameInput.value.trim();
        const newUrl = urlInput.value.trim();
        const newBranch = branchInput.value.trim();
        if (newName !== repo.name && newName.length > 0) body.name = newName;
        if (newUrl !== repo.url && newUrl.length > 0) body.url = newUrl;
        if (newBranch !== repo.defaultBranch && newBranch.length > 0) {
            body.defaultBranch = newBranch;
        }
        // null = unchanged, so the PATCH omits it and the mapping is
        // left alone; '' = the operator moved a mapped repo back to
        // Default, which is how a mapping is CLEARED. The two cannot
        // be collapsed.
        const nextAccount = accountUpdateValue(
            account.select.value,
            repo.githubAccount,
        );
        if (nextAccount !== null) body.githubAccount = nextAccount;
        repoEditOpen.delete(repo.repoId);
        void onUpdateRepo(body);
    });
    return form;
}

function repoStatusLabel(repo: RepoUiRow): string {
    if (repo.lastSyncStatus === 'ok' && repo.lastSyncedAt) {
        return `✓ synced ${formatRelativeTime(repo.lastSyncedAt)}`;
    }
    if (repo.lastSyncStatus === 'clone-failed') return '✗ clone failed';
    if (repo.lastSyncStatus === 'sync-failed') return '⚠ sync failed';
    return '(not yet synced)';
}

function formatRelativeTime(epochMs: number): string {
    const diff = Date.now() - epochMs;
    if (diff < 60_000) return 'just now';
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
    return `${Math.floor(diff / 86_400_000)}d ago`;
}

async function onRegisterRepo(body: {
    name: string;
    url: string;
    defaultBranch?: string;
    githubAccount?: string;
}): Promise<void> {
    try {
        const res = await fetch(`${API_BASE}/api/repos`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        showToast({ message: `Registered ${body.name}`, kind: 'success' });
    } catch (err) {
        showToast({
            message: err instanceof Error ? `Register failed: ${err.message}` : 'Register failed',
            kind: 'error',
        });
    }
}

/**
 * Dispatch the "Create new repo" command. The worker-api → orchestrator
 * chain runs `gh repo create` + clone + seed CLAUDE.md + commit + push.
 * Failures land back here as 4xx/5xx with the gh / git error in the
 * body; we surface them in a toast so the operator can act.
 */
async function onCreateRepo(body: {
    githubAccount?: string;
    owner: string;
    name: string;
    description: string;
    visibility: 'private' | 'public';
    defaultBranch?: string;
}): Promise<void> {
    try {
        const res = await fetch(`${API_BASE}/api/repos/create`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            let detail: string | undefined;
            try {
                const parsed = (await res.json()) as { error?: unknown };
                if (typeof parsed.error === 'string') detail = parsed.error;
            } catch {
                /* fall through */
            }
            throw new Error(detail ?? `HTTP ${res.status}`);
        }
        showToast({
            message: `Created ${body.owner}/${body.name}`,
            kind: 'success',
        });
    } catch (err) {
        showToast({
            message: err instanceof Error
                ? `Create failed: ${err.message}`
                : 'Create failed',
            kind: 'error',
        });
        // Re-throw so the form's `.finally` resets the button label.
        throw err;
    }
}

async function onUpdateRepo(body: {
    githubAccount?: string;
    repoId: string;
    name?: string;
    url?: string;
    defaultBranch?: string;
}): Promise<void> {
    try {
        const res = await fetch(
            `${API_BASE}/api/repos/${encodeURIComponent(body.repoId)}`,
            {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        showToast({ message: 'Repository updated.', kind: 'success' });
    } catch (err) {
        showToast({
            message: err instanceof Error ? `Update failed: ${err.message}` : 'Update failed',
            kind: 'error',
        });
        refreshReposModal();
    }
}

async function onArchiveRepo(repoId: string): Promise<void> {
    try {
        const res = await fetch(
            `${API_BASE}/api/repos/${encodeURIComponent(repoId)}`,
            { method: 'DELETE' },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        showToast({ message: 'Repository archived.', kind: 'info' });
    } catch (err) {
        showToast({
            message: err instanceof Error ? `Archive failed: ${err.message}` : 'Archive failed',
            kind: 'error',
        });
    }
}

async function onRefreshRepo(repoId: string): Promise<void> {
    try {
        const res = await fetch(
            `${API_BASE}/api/repos/${encodeURIComponent(repoId)}/refresh`,
            { method: 'POST' },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        showToast({
            message: `Sync started for ${repoId}`,
            kind: 'info',
        });
    } catch (err) {
        showToast({
            message: err instanceof Error ? `Sync failed: ${err.message}` : 'Sync failed',
            kind: 'error',
        });
    }
}

async function onRefreshAllRepos(): Promise<void> {
    try {
        const res = await fetch(`${API_BASE}/api/repos/refresh-all`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        showToast({ message: 'Refresh all started.', kind: 'info' });
    } catch (err) {
        showToast({
            message:
                err instanceof Error ? `Refresh-all failed: ${err.message}` : 'Refresh-all failed',
            kind: 'error',
        });
    }
}

// Wire the sidebar button on first render.
const openReposBtn = document.getElementById('open-repos-modal');
if (openReposBtn) {
    openReposBtn.addEventListener('click', openReposModal);
}
void loadRepos();
void hydrateTasks();
void hydrateFlowStages();
void hydrateTaskTypes();
void hydratePlans();
void hydrateRequirements();
wireRequirementButtons();

// ---------- Agent auth health banner ----------------------------------
//
// Field case: the worker's Claude CLI OAuth token expired and every agent
// spawn died with what looked like scattered per-task failures. The
// worker now exposes GET /api/agent-auth (expiry timestamp only — no
// token material); the board shows a persistent banner when auth is
// expired or about to expire, refreshed every 5 minutes and flipped
// instantly by a live AgentAuthError event. Fix instructions inline:
// paste a `claude setup-token` token into the manager's settings — it
// applies on the next agent spawn without a worker restart.
interface AgentAuthBannerState {
    readonly status: string;
    readonly detail: string;
}
let agentAuthState: AgentAuthBannerState | null = null;

function updateAgentAuthBanner(): void {
    const id = 'agent-auth-banner';
    let el = document.getElementById(id);
    const show = agentAuthState !== null
        && (agentAuthState.status === 'expired' || agentAuthState.status === 'expiring-soon');
    if (!show) {
        el?.remove();
        return;
    }
    if (!el) {
        el = document.createElement('div');
        el.id = id;
        el.className = 'agent-auth-banner';
        document.body.prepend(el);
    }
    const expired = agentAuthState!.status === 'expired';
    el.classList.toggle('agent-auth-banner--expired', expired);
    el.textContent = `${expired ? '🔴' : '🟠'} ${agentAuthState!.detail} — `
        + (expired
            ? 'agents cannot run. '
            : 'agents will start failing when it lapses. ')
        + 'Fix: run `claude setup-token` on any machine and paste the token into '
        + 'Manager → Settings → "Claude long-lived OAuth token" (applies on the '
        + 'next agent run), or re-run `claude login` on the worker.';
}

async function refreshAgentAuthStatus(): Promise<void> {
    try {
        const res = await fetch(`${API_BASE}/api/agent-auth`);
        if (!res.ok) return;
        const body = (await res.json()) as { status?: unknown; detail?: unknown };
        if (typeof body.status !== 'string') return;
        agentAuthState = {
            status: body.status,
            detail: typeof body.detail === 'string' ? body.detail : `agent auth: ${body.status}`,
        };
        updateAgentAuthBanner();
    } catch {
        // Worker unreachable — the SSE disconnect surface owns that story.
    }
}

void refreshAgentAuthStatus();
setInterval(() => void refreshAgentAuthStatus(), 5 * 60 * 1000);

async function hydratePlans(): Promise<void> {
    interface RawPlan {
        readonly planId?: string;
        readonly projectId?: string;
        readonly name?: string | null;
        readonly status?: string | null;
        readonly body?: string | null;
        readonly metadata?: Record<string, unknown>;
        readonly archivedAt?: number | null;
        readonly createdAt?: number | null;
    }
    try {
        const res = await fetch(`${API_BASE}/api/plans`);
        if (!res.ok) return;
        const json = (await res.json()) as { plans?: RawPlan[] };
        const list = Array.isArray(json.plans) ? json.plans : [];
        let seeded = 0;
        for (const raw of list) {
            if (typeof raw.planId !== 'string' || raw.planId.length === 0) continue;
            // Don't trample a row populated by a live SSE event that
            // beat the fetch — live always wins.
            if (plans.has(raw.planId)) continue;
            plans.set(raw.planId, {
                planId: raw.planId,
                projectId: typeof raw.projectId === 'string' ? raw.projectId : '',
                status: typeof raw.status === 'string' ? raw.status : 'draft',
                title: typeof raw.name === 'string' ? raw.name : null,
                techStack: [],
                planFile: null,
                body: typeof raw.body === 'string' ? raw.body : null,
                metadata: raw.metadata && typeof raw.metadata === 'object'
                    ? { ...raw.metadata }
                    : {},
                archivedAt: typeof raw.archivedAt === 'number' ? raw.archivedAt : null,
                createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : null,
            });
            seeded += 1;
        }
        if (seeded > 0) scheduleRender();
    } catch {
        // Network blip — SSE will repopulate from the next live event.
    }
}

/**
 * Boot-time hydrate for the `tasks` Map from the durable projection.
 * Without this, the board's in-memory task store starts empty on every
 * page load and the operator's view of a previously-decomposed plan
 * vanishes — any TaskCreated SSE event that arrived in a previous
 * session is gone with the closed tab. The route response shape
 * matches what `applyTaskCreatedReducer` expects so each row passes
 * straight through.
 */
async function hydrateTasks(): Promise<void> {
    interface RawTask {
        readonly taskId?: string;
        readonly planId?: string;
        readonly type?: string;
        readonly status?: string;
        readonly flowId?: string | null;
        readonly title?: string | null;
        readonly description?: string | null;
    }
    try {
        const res = await fetch(`${API_BASE}/api/tasks`);
        if (!res.ok) return;
        const json = (await res.json()) as { tasks?: RawTask[] };
        const list = Array.isArray(json.tasks) ? json.tasks : [];
        let seeded = 0;
        for (const raw of list) {
            if (typeof raw.taskId !== 'string') continue;
            // Clarification choices live in a side map (the modal reads
            // clarificationChoices) — re-seed it from the hydration
            // payload so the Answer modal has its radio options after a
            // reload, not just in the live session. Seeded BEFORE the
            // live-row skip below: a live SSE event racing hydration
            // populates the task row but never carries the choices.
            const rawChoices = (raw as Record<string, unknown>).parkedChoices;
            if (Array.isArray(rawChoices) && !clarificationChoices.has(raw.taskId)) {
                const cleaned = (rawChoices as unknown[]).filter(
                    (c): c is string => typeof c === 'string',
                );
                if (cleaned.length > 0) clarificationChoices.set(raw.taskId, cleaned);
            }
            // Skip rows already populated by a live SSE event that
            // arrived between the SSE connect and this fetch
            // resolving — the live event is the freshest.
            if (tasks.has(raw.taskId)) continue;
            applyTaskCreatedReducer(tasks, raw as Record<string, unknown>);
            seeded += 1;
        }
        // Pull the per-step records for every hydrated task in
        // parallel — the stage-bar relies on them for chip colours and
        // the summary modal opens against them. Fired alongside the
        // task hydration rather than after, so the modal trigger on a
        // chip is live the moment the card paints.
        // ONLY the tasks the main board paints chips for, in bounded
        // batches, re-rendering as each lands. This used to fire one
        // request per task in the payload — 1,385 of them at once on a
        // real board — behind a single Promise.all, so the board painted
        // with blank chips and stayed that way for as long as the tail
        // took. A closed task's records are fetched when its plan modal
        // opens (see ensurePlanStepRuns).
        await hydrateInBatches(
            tasksNeedingStepHydration(
                list.filter((r): r is RawTask & { taskId: string } =>
                    typeof r.taskId === 'string'),
            ),
            (taskId) => hydrateTaskStepRuns(taskId),
            () => scheduleRender(),
        );
        // With step runs now loaded, advance any running task off the
        // durable 'approved' status to its actual stage — otherwise a
        // refreshed in-flight task falls through every render filter and
        // its card disappears until the next live AgentStarted event.
        for (const t of tasks.values()) {
            const derived = deriveStartedStatus(t);
            if (derived) t.status = derived;
            // Seed the "Show agent" run record so the modal has content
            // after a reload instead of "(no active run)".
            seedTaskAgentFromSteps(t.taskId);
        }
        if (seeded > 0) scheduleRender();
        else scheduleRender();
    } catch {
        // Worker-api unreachable — fall through; SSE will repopulate
        // on next live event.
    }
}

/**
 * Boot-time hydrate for the flow-stage catalog (P-TOTS-006).
 *
 * Fetches the `flowId → FlowStage[]` map from `GET /api/flow-stages`
 * once, alongside {@link hydrateTasks}, and stores it in
 * {@link flowStageCatalog}. Each card then resolves its flow's stages via
 * {@link stagesForTask} — the catalog is keyed by flow, not task, so this
 * single fetch covers every card (present and future) without embedding a
 * stages array on the per-task SSE payload. A re-render is scheduled on
 * success so cards that already painted (with no bar) pick up their strip.
 *
 * Degrades gracefully: a non-OK response, a malformed body, or a network
 * error leaves the catalog empty and every card renders no stage bar,
 * exactly the way {@link hydrateTasks} tolerates an unreachable
 * worker-api. A missing catalog costs the strip, never board boot.
 *
 * A silent empty catalog blanks every card's stage strip, which read as a
 * pipeline stall in the field until someone traced it to a proxy gap (a
 * missing `/api/flow-stages` route). So each degradation path now surfaces
 * an operator-visible warning (console + error toast) that NAMES the route,
 * per Rule 1 (never fail silently) — without throwing, so board boot stays
 * resilient.
 */
/**
 * Load the Add-task menu and the new-plan "Plan type" options from
 * `GET /api/task-types`. A failure is surfaced (toast + console), never
 * silent: the Add-task modal then says the list is missing instead of
 * showing an empty menu, and the new-plan dialog falls back to the core
 * plan types.
 */
async function hydrateTaskTypes(): Promise<void> {
    try {
        const res = await fetch(`${API_BASE}/api/task-types`);
        if (!res.ok) {
            const message = `Task types unavailable (GET /api/task-types returned HTTP ${res.status}).`;
            console.warn(`[board] hydrateTaskTypes: ${message}`);
            showToast({ message, kind: 'error' });
            return;
        }
        const json = (await res.json()) as {
            addTask?: ReadonlyArray<{ id?: unknown; label?: unknown }>;
            archetypes?: ReadonlyArray<{ id?: unknown; label?: unknown }>;
            taskTypes?: ReadonlyArray<{ id?: unknown; producesReport?: unknown }>;
        };
        // Which types have a report to open is declared by their flow
        // (`task_type.produces_report`), so an enabled pack's report types
        // arrive here rather than being named in the board's source.
        setReportTaskTypes(
            (json.taskTypes ?? [])
                .filter((t) => t.producesReport === true && typeof t.id === 'string')
                .map((t) => t.id as string),
        );
        addTaskTypes = (json.addTask ?? [])
            .filter((t): t is { id: string; label: string } => typeof t.id === 'string' && typeof t.label === 'string')
            .map((t) => ({ id: t.id, label: t.label }));
        planArchetypes = (json.archetypes ?? [])
            .filter((a): a is { id: string; label: string } => typeof a.id === 'string' && typeof a.label === 'string')
            .map((a) => ({ value: a.id, label: a.label }));
    } catch (err) {
        const message = `Task types unavailable (${err instanceof Error ? err.message : String(err)}).`;
        console.warn(`[board] hydrateTaskTypes: ${message}`);
        showToast({ message, kind: 'error' });
    }
}

async function hydrateFlowStages(): Promise<void> {
    interface RawFlowStage {
        readonly stepId?: unknown;
        readonly agent?: unknown;
        readonly label?: unknown;
        readonly kind?: unknown;
    }
    // Surface a failed/empty hydration to the operator instead of silently
    // blanking every stage strip. Names the route so the next proxy gap is
    // diagnosable at a glance. Never throws: showToast no-ops when the
    // chrome hasn't mounted, and console.warn always lands.
    const warnCatalog = (reason: string): void => {
        const message =
            `Flow-stage catalog unavailable (${reason}) — cards will render `
            + 'without their stage strip. Check the /api/flow-stages route.';
        console.warn(`[board] hydrateFlowStages: ${message}`);
        showToast({ message, kind: 'error' });
    };
    try {
        const res = await fetch(`${API_BASE}/api/flow-stages`);
        if (!res.ok) {
            warnCatalog(`GET /api/flow-stages returned HTTP ${res.status}`);
            return;
        }
        const json = (await res.json()) as {
            flows?: Record<string, RawFlowStage[]>;
        };
        const flows = json.flows;
        if (!flows || typeof flows !== 'object') {
            warnCatalog('GET /api/flow-stages returned no flows map');
            return;
        }
        if (Object.keys(flows).length === 0) {
            warnCatalog('GET /api/flow-stages returned an empty flows map');
            return;
        }
        flowStageCatalog.clear();
        for (const [flowId, rawStages] of Object.entries(flows)) {
            if (!Array.isArray(rawStages)) continue;
            const stages: FlowStage[] = [];
            for (const raw of rawStages) {
                if (!raw || typeof raw !== 'object') continue;
                const { stepId, agent, label, kind } = raw as RawFlowStage;
                if (
                    typeof stepId !== 'string'
                    || typeof agent !== 'string'
                    || typeof label !== 'string'
                    || (kind !== 'agent' && kind !== 'gate')
                ) {
                    continue;
                }
                stages.push({ stepId, agent, label, kind });
            }
            flowStageCatalog.set(flowId, stages);
        }
        // Which roles do WORK, and which step kinds are KNOWN, are both
        // properties of the flows this install loaded — core cannot name a
        // pack's roles. Two surfaces learn them here: the card tag deriver
        // (so a pack's running step reads as in_progress instead of falling
        // through to an idle-looking `created`) and the Edit-project modal
        // (so a pack's steps are not flagged "unknown step kind").
        const agentRoles = new Set<string>();
        for (const stages of flowStageCatalog.values()) {
            for (const s of stages) {
                if (s.kind === 'agent') agentRoles.add(s.agent);
                knownStepKinds.add(s.agent);
            }
        }
        setExtraWorkRoles(agentRoles);
        scheduleRender();
    } catch (err) {
        // Worker-api unreachable or the /api/flow-stages route absent
        // (older server) — leave the catalog empty so every card renders
        // no stage bar rather than throwing. Mirrors hydrateTasks' catch,
        // but surfaces the failure so the proxy gap doesn't hide.
        const detail = err instanceof Error ? err.message : String(err);
        warnCatalog(`GET /api/flow-stages fetch failed: ${detail}`);
    }
}

/**
 * On boot, map a started-but-not-finished task to its current pipeline
 * stage from the hydrated step runs, mirroring the live AgentStarted
 * mapping ({@link AGENT_ROLE_TO_COLUMN}).
 *
 * Why this is needed: the durable `tasks.status` stays `'approved'` for the
 * whole run — the orchestrator projection never advances it per-stage (only
 * the per-step `task_step_summaries` rows track progress). So after a
 * refresh a running task is `'approved'` with no `parkedReason`, which is
 * neither `'created'` (draft, lives behind the plan card) nor a
 * `TASK_IN_PROGRESS_STATES` value nor parked — so every render filter drops
 * it and the card vanishes until the next live AgentStarted event flips the
 * in-memory status. Deriving the stage here makes the refreshed model match
 * the live one across the Tasks section, plan-progress counts, and chips.
 *
 * Returns null (leave status untouched) unless the task is in the pre-run
 * `'approved'` resting state AND not parked AND has step runs — parked /
 * created / terminal tasks keep their own render paths.
 */
function deriveStartedStatus(task: TaskRow): Column | null {
    if (task.status !== 'approved' || task.parkedReason) return null;
    const steps = taskStepRuns.get(task.taskId);
    if (!steps || steps.size === 0) return null;
    let running: TaskStepRecord | null = null;
    let furthest: Column | null = null;
    for (const rec of steps.values()) {
        const col = AGENT_ROLE_TO_COLUMN[rec.role ?? ''] ?? null;
        if (rec.status === 'running'
            && (running === null || rec.startedAt > running.startedAt)) {
            running = rec;
        }
        if (col !== null
            && (furthest === null
                || COLUMNS.indexOf(col) > COLUMNS.indexOf(furthest))) {
            furthest = col;
        }
    }
    if (running !== null) {
        return AGENT_ROLE_TO_COLUMN[running.role ?? ''] ?? 'in_progress';
    }
    // Steps exist but NONE is running. That is not an in-flight task — it
    // is a stalled one: the agent was stopped, crashed, or the flow never
    // dispatched the next step. Reporting the furthest stage reached made
    // the card look in-flight, which hid Retry AND Restart (both gate on
    // `!inFlight`) while Resume stayed hidden too (not parked) — the
    // operator was left with no way forward at all (field case:
    // L-MIBO-010, stopped mid-develop).
    //
    // Leaving the status at 'approved' is both honest and actionable: the
    // Tasks section keeps approved tasks visible (see task-visibility.ts),
    // so the card does not vanish, and the live AgentStarted event flips
    // it the moment a step really begins.
    void furthest;
    return null;
}

/**
 * Seed a {@link TaskAgentRun} for the "Show agent" modal from the
 * hydrated step runs, so a reload doesn't leave the modal stuck on
 * "(no active run)" while a step chip clearly shows Running.
 *
 * The live activity stream (assistant chunks, tool calls) is never
 * persisted — only the joined summary is, and only once a step finishes.
 * So on boot we reconstruct the CURRENT run (the running step, else the
 * most-recently-started one) with a lifecycle marker plus the persisted
 * summary when present, and live AgentProgress/AgentActivity events
 * append to this run record as they keep arriving over the reconnected
 * SSE stream.
 *
 * The agentId comes from the step-summaries hydration, which reads the
 * orchestrator's live agent-to-task map. This comment used to claim
 * "the agentId is unknown here, but Stop is keyed by taskId so it still
 * works" - it is not and it did not. `requestStopTaskAgent` LOOKS UP by
 * taskId but SENDS `CancelAgentRun{runId}`, and it treats an empty
 * agentId as "already finished". So after any reload, Stop agent on a
 * genuinely running task reported "Agent already finished." and did
 * nothing, with no way to recover: the AgentStarted frame that carried
 * the id is never sent again.
 *
 * No-op when a live event already populated the run (live data wins) or
 * the task has no step runs.
 */
function seedTaskAgentFromSteps(taskId: string): void {
    if (taskAgents.has(taskId)) return;
    const steps = taskStepRuns.get(taskId);
    if (!steps || steps.size === 0) return;
    let current: TaskStepRecord | null = null;
    for (const rec of steps.values()) {
        if (current === null) { current = rec; continue; }
        // Prefer a running step; otherwise the most-recently-started.
        const recRunning = rec.status === 'running';
        const curRunning = current.status === 'running';
        if (recRunning && !curRunning) current = rec;
        else if (recRunning === curRunning && rec.startedAt > current.startedAt) {
            current = rec;
        }
    }
    if (current === null) return;
    const role = current.role || 'agent';
    const activities: PlannerActivity[] = [{
        at: current.startedAt,
        category: 'lifecycle',
        detail: current.status === 'running'
            ? `${role} running — live output resumes here after the reload`
            : `${role} ${current.status}`,
    }];
    if (current.summary && current.summary.trim().length > 0) {
        activities.push({
            at: current.finishedAt ?? current.startedAt,
            category: 'assistant',
            detail: truncate(current.summary, 140),
            ...(current.summary.length > 140 ? { extra: current.summary } : {}),
        });
    }
    taskAgents.set(taskId, {
        taskId,
        agentId: current.agentId ?? '',
        role,
        startedAt: current.startedAt,
        activities,
        status: current.status,
        ...(current.finishedAt !== null ? { finishedAt: current.finishedAt } : {}),
    });
}

/** Plans whose closed tasks have already had their step records pulled. */
const planStepRunsHydrated = new Set<string>();

/**
 * Fetch step records for a plan's tasks that boot hydration skipped.
 *
 * Boot only pulls the tasks the main board paints (see
 * `tasksNeedingStepHydration`); a plan modal renders its CLOSED tasks
 * too, and those would otherwise show not-started chips. Runs once per
 * plan, in bounded batches, re-rendering as each lands so the modal
 * fills in rather than waiting on the slowest request.
 */
async function ensurePlanStepRuns(planId: string): Promise<void> {
    if (planStepRunsHydrated.has(planId)) return;
    planStepRunsHydrated.add(planId);
    const missing = Array.from(tasks.values())
        .filter((t) => t.planId === planId)
        .filter((t) => (taskStepRuns.get(t.taskId)?.size ?? 0) === 0)
        .map((t) => t.taskId);
    if (missing.length === 0) return;
    await hydrateInBatches(
        missing,
        (taskId) => hydrateTaskStepRuns(taskId),
        () => refreshPlanModal(),
    );
}

async function hydrateTaskStepRuns(taskId: string): Promise<void> {
    interface RawStep {
        readonly stepId?: string;
        readonly role?: string | null;
        readonly status?: string;
        readonly startedAt?: number;
        readonly finishedAt?: number | null;
        readonly summary?: string | null;
        /** Live run id, present only while the step is running. */
        readonly agentId?: string;
    }
    try {
        const res = await fetch(
            `${API_BASE}/api/tasks/${encodeURIComponent(taskId)}/step-summaries`,
        );
        if (!res.ok) return;
        const json = (await res.json()) as { steps?: RawStep[] };
        const list = Array.isArray(json.steps) ? json.steps : [];
        for (const raw of list) {
            if (typeof raw.stepId !== 'string' || raw.stepId.length === 0) continue;
            const status: TaskStepRecord['status']
                = raw.status === 'complete' || raw.status === 'failed'
                    ? raw.status
                    : 'running';
            setTaskStepRecord(taskId, {
                stepId: raw.stepId,
                role: typeof raw.role === 'string' ? raw.role : null,
                status,
                startedAt: typeof raw.startedAt === 'number' ? raw.startedAt : Date.now(),
                finishedAt: typeof raw.finishedAt === 'number' ? raw.finishedAt : null,
                summary: typeof raw.summary === 'string' ? raw.summary : null,
                ...(typeof raw.agentId === 'string' && raw.agentId.length > 0
                    ? { agentId: raw.agentId }
                    : {}),
            });
        }
    } catch {
        // Network blip — chip will show 'todo' (blue) until the next
        // live event repopulates.
    }
}

setConnectionState('connecting…');
render();
connect();
