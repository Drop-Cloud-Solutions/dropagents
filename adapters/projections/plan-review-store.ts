/**
 * SQLite-backed projection over `PlanGenerated` / `PlanDecomposed`.
 *
 * Each `PlanGenerated` event lands as a row in `plan_review_drafts`
 * keyed by `(plan_id, revision)`. Each `PlanDecomposed` event lands as
 * a row in `plan_review_decomposed` keyed by `plan_id`. The board's
 * Show-report modal reads from the drafts table; the active-planner
 * card hydration on boot reads `listPending()`, which excludes any
 * plan that has been decomposed.
 *
 * Persistence model
 * -----------------
 * The on-disk tables are defined in
 * `core/state/migrations/010_plan_review_projection.sql`. The store
 * subscribes itself to the EventBus in its constructor under the
 * `plan-review-projection` subscriber name, so a worker-api restart
 * picks up where the projection left off via `bus.replayMissed`.
 *
 * Idempotency
 * -----------
 * `PlanGenerated` UPSERTs by `(plan_id, revision)` and gates the
 * conflict branch on `excluded.generated_at >= drafts.generated_at` so
 * a replay with the same timestamp is a no-op and a strictly older one
 * cannot move state backwards. `PlanDecomposed` uses `INSERT OR IGNORE`
 * so the decomposed flag is monotonic. Combined with the bus's per-
 * subscriber offset tracking, replay leaves the projection bit-for-bit
 * equal to a fresh fold.
 *
 * Legacy shape
 * ------------
 * Pre-extension `PlanGenerated` events (AP-VP4-001 era) carried only
 * `{ planId, projectId, briefId, actor }`. Those are treated as the
 * implicit initial revision 1 with an empty `content`, mirroring the
 * convention documented on `PlanGeneratedPayload` in
 * `core/events/event.ts`.
 */

import type { EventBus } from '../../core/events/bus';
import type {
    Event,
    PlanDecomposed,
    PlanGenerated,
    StoredEvent,
} from '../../core/events/event';
import { isPlanDecomposed, isPlanGenerated } from '../../core/events/event';
import type { Logger } from '../../core/ports/Logger';
import type { Db } from '../../core/state/migrations';

/**
 * Structural payload shape shared by the soft-delete events the
 * projection reacts to. Both PlanDeleted and PlanArchived carry just
 * `{ planId }` on the wire (the operator's archive and the discard
 * button both translate to one of these), so a single union covers
 * the fold.
 */
interface PlanRemovalPayload {
    readonly planId: string;
}

/**
 * Subscriber name registered with the EventBus. Exposed so a host that
 * wants the projection to recover from missed events on boot can call
 * `bus.replayMissed(PLAN_REVIEW_PROJECTION_SUBSCRIBER)` after wiring it.
 */
export const PLAN_REVIEW_PROJECTION_SUBSCRIBER = 'plan-review-projection';

/**
 * Event-type names this store folds over. Single source of truth so a
 * future rename only updates one place — both the wire and the
 * projection stay in lockstep.
 */
export const PLAN_REVIEW_EVENT_TYPES = {
    GENERATED: 'PlanGenerated',
    DECOMPOSED: 'PlanDecomposed',
    DELETED: 'PlanDeleted',
    ARCHIVED: 'PlanArchived',
} as const;

/**
 * A single plan-review revision row. The persistent counterpart of
 * the in-memory shape that lived here before the SQLite move.
 */
export interface PlanReviewRevision {
    readonly revision: number;
    readonly content: string;
    readonly feedback?: string;
    readonly generatedAt: number;
    /**
     * Originating project id, captured from the PlanGenerated payload.
     * Optional because pre-extension events may have omitted it; in
     * practice the orchestrator always emits with `projectId` set.
     * Required by `listPending()` so a downstream caller can hydrate a
     * per-project view without a second lookup.
     */
    readonly projectId?: string;
}

/**
 * Pending plan-review entry. One per plan that has at least one
 * revision but has not yet been decomposed. The board's boot-time
 * `hydrateActivePlanners()` consumes this list to re-paint cards
 * across a page reload.
 */
export interface PendingPlanReview {
    readonly planId: string;
    readonly projectId: string;
    readonly revision: number;
    readonly content: string;
    readonly generatedAt: number;
}

interface DraftRow {
    plan_id: string;
    revision: number;
    content: string;
    feedback: string | null;
    project_id: string | null;
    generated_at: number;
}

function rowToRevision(row: DraftRow): PlanReviewRevision {
    return {
        revision: row.revision,
        content: row.content,
        generatedAt: row.generated_at,
        ...(row.feedback !== null ? { feedback: row.feedback } : {}),
        ...(row.project_id !== null ? { projectId: row.project_id } : {}),
    };
}

export class PlanReviewStore {
    private readonly upsertDraftStmt;
    private readonly markDecomposedStmt;
    private readonly getRevisionStmt;
    private readonly getLatestStmt;
    private readonly getLatestNonEmptyStmt;
    private readonly listRevisionsStmt;
    private readonly isDecomposedStmt;
    private readonly listPendingStmt;
    private readonly deleteDraftsStmt;
    private readonly deleteDecomposedStmt;
    private readonly logger?: Logger;

    /**
     * Construct the projection and wire its subscriptions.
     *
     * When `bus` is provided the store registers a named subscriber so
     * the host's `replayMissed(PLAN_REVIEW_PROJECTION_SUBSCRIBER)`
     * recovers events missed across a restart. When `bus` is omitted
     * the store works as a pure SQLite reader/writer driven by direct
     * `fold(event)` calls — used by tests that want to bypass the bus.
     */
    constructor(private readonly db: Db, bus?: EventBus, logger?: Logger) {
        this.logger = logger;

        this.upsertDraftStmt = db.prepare(
            `INSERT INTO plan_review_drafts(
                plan_id, revision, content, feedback, project_id, generated_at
             )
             VALUES (@planId, @revision, @content, @feedback, @projectId, @generatedAt)
             ON CONFLICT(plan_id, revision) DO UPDATE SET
                 content      = excluded.content,
                 feedback     = excluded.feedback,
                 project_id   = COALESCE(excluded.project_id, plan_review_drafts.project_id),
                 generated_at = excluded.generated_at
             WHERE excluded.generated_at >= plan_review_drafts.generated_at`,
        );

        this.markDecomposedStmt = db.prepare(
            `INSERT OR IGNORE INTO plan_review_decomposed(plan_id, decomposed_at)
             VALUES (@planId, @decomposedAt)`,
        );

        this.getRevisionStmt = db.prepare(
            `SELECT plan_id, revision, content, feedback, project_id, generated_at
               FROM plan_review_drafts
              WHERE plan_id = ? AND revision = ?`,
        );

        this.getLatestStmt = db.prepare(
            `SELECT plan_id, revision, content, feedback, project_id, generated_at
               FROM plan_review_drafts
              WHERE plan_id = ?
              ORDER BY revision DESC
              LIMIT 1`,
        );

        this.getLatestNonEmptyStmt = db.prepare(
            `SELECT plan_id, revision, content, feedback, project_id, generated_at
               FROM plan_review_drafts
              WHERE plan_id = ? AND content <> ''
              ORDER BY revision DESC
              LIMIT 1`,
        );

        this.listRevisionsStmt = db.prepare(
            `SELECT plan_id, revision, content, feedback, project_id, generated_at
               FROM plan_review_drafts
              WHERE plan_id = ?
              ORDER BY revision ASC`,
        );

        this.isDecomposedStmt = db.prepare(
            'SELECT 1 FROM plan_review_decomposed WHERE plan_id = ?',
        );

        // PlanDeleted / PlanArchived: the operator's Discard button (and
        // the sidebar Archive action) emit one of these so the row
        // disappears from the sidebar. Without a corresponding wipe on
        // the plan-review tables, `listPending()` would keep surfacing
        // the deleted plan after a page reload — the active-planner
        // card would resurrect itself.
        this.deleteDraftsStmt = db.prepare(
            'DELETE FROM plan_review_drafts WHERE plan_id = ?',
        );
        this.deleteDecomposedStmt = db.prepare(
            'DELETE FROM plan_review_decomposed WHERE plan_id = ?',
        );

        // `listPending()` — latest NON-EMPTY revision per plan minus the
        // decomposed set, scoped to rows with a known project_id (the
        // board can't render a card without it). Empty-content rows are
        // dispatch-time placeholders (the GeneratePlan handler emits a
        // synchronous PlanGenerated BEFORE the agent runs): treating one
        // as "the draft" made a plan whose planner FAILED classify as
        // Ready on the board — field case: auth-failed planner, plan
        // showed Ready with no content. A plan whose only revisions are
        // empty now simply has no pending review row (→ board Draft).
        this.listPendingStmt = db.prepare(
            `SELECT d.plan_id     AS plan_id,
                    d.project_id  AS project_id,
                    d.revision    AS revision,
                    d.content     AS content,
                    d.generated_at AS generated_at
               FROM plan_review_drafts d
              WHERE d.project_id IS NOT NULL
                AND d.content <> ''
                AND d.revision = (
                    SELECT MAX(revision)
                      FROM plan_review_drafts d2
                     WHERE d2.plan_id = d.plan_id
                       AND d2.content <> ''
                )
                AND NOT EXISTS (
                    SELECT 1 FROM plan_review_decomposed dec
                     WHERE dec.plan_id = d.plan_id
                )
                -- Archived plans are excluded HERE rather than by deleting
                -- their drafts. Archiving is reversible; the delete was
                -- not, so archive-then-unarchive left a plan the board
                -- still called ready with no revision behind it, and
                -- Regenerate answered 404 forever (14 of 17 live plans on
                -- one project). A view concern belongs in the view.
                AND NOT EXISTS (
                    SELECT 1 FROM sidebar_plans sp
                     WHERE sp.plan_id = d.plan_id
                       AND sp.archived_at IS NOT NULL
                )
              ORDER BY d.generated_at ASC`,
        );

        if (bus) {
            bus.subscribe<PlanGenerated['payload']>(
                PLAN_REVIEW_EVENT_TYPES.GENERATED,
                (event) => {
                    this.applyPlanGenerated(event);
                },
                { subscriber: PLAN_REVIEW_PROJECTION_SUBSCRIBER },
            );
            bus.subscribe<PlanDecomposed['payload']>(
                PLAN_REVIEW_EVENT_TYPES.DECOMPOSED,
                (event) => {
                    this.applyPlanDecomposed(event);
                },
                { subscriber: PLAN_REVIEW_PROJECTION_SUBSCRIBER },
            );
            bus.subscribe<PlanRemovalPayload>(
                PLAN_REVIEW_EVENT_TYPES.DELETED,
                (event) => {
                    this.applyPlanRemoval(event.payload);
                },
                { subscriber: PLAN_REVIEW_PROJECTION_SUBSCRIBER },
            );
            // PlanArchived deliberately does NOT wipe the drafts. Archiving
            // is reversible from the sidebar, and a wipe is not: unarchiving
            // restored the plan row and could not restore its revisions, so
            // Regenerate 404'd on a plan the board showed as ready. The
            // card it was hiding is hidden by listPending's archived filter
            // instead.
        }
    }

    /**
     * Apply an event to the projection. Non-`PlanGenerated` /
     * non-`PlanDecomposed` events are ignored so a host can pipe its
     * entire event stream through without pre-filtering. Returns the
     * resulting revision row when a `PlanGenerated` was folded, `null`
     * for everything else.
     *
     * Used by tests that want to drive the store without standing up a
     * full EventBus. Production code goes through the bus subscription
     * the constructor wires.
     */
    fold(event: Event | StoredEvent): PlanReviewRevision | null {
        if (isPlanGenerated(event)) {
            return this.applyPlanGenerated(event);
        }
        if (isPlanDecomposed(event)) {
            this.applyPlanDecomposed(event);
            return null;
        }
        // DELETED only. PlanArchived is reversible and must leave the
        // revisions intact — see the constructor's subscription note.
        if (event.type === PLAN_REVIEW_EVENT_TYPES.DELETED) {
            const payload = (event as { payload?: { planId?: unknown } }).payload;
            if (payload && typeof payload.planId === 'string') {
                this.applyPlanRemoval({ planId: payload.planId });
            }
            return null;
        }
        return null;
    }

    /** Highest-revision row for the plan, or `null` if no revisions. */
    getLatest(planId: string): PlanReviewRevision | null {
        const row = this.getLatestStmt.get(planId) as DraftRow | undefined;
        return row ? rowToRevision(row) : null;
    }

    /**
     * Highest-revision row whose `content` is non-empty, or `null` when
     * every revision is empty. A `PlanGenerated` is folded at DISPATCH
     * time (content '') and only overwritten when the planner agent
     * finishes — so a run that dies before producing output leaves an
     * empty row at the top of the revision stack. Regenerate uses this
     * reader so `previousContent` reflects the last plan that actually
     * exists rather than the empty residue of a failed attempt.
     */
    getLatestNonEmpty(planId: string): PlanReviewRevision | null {
        const row = this.getLatestNonEmptyStmt.get(planId) as DraftRow | undefined;
        return row ? rowToRevision(row) : null;
    }

    /**
     * Exact-match lookup by `(planId, revision)`. Returns `null` when
     * the plan is unknown or the revision has never been projected.
     */
    getRevision(planId: string, revision: number): PlanReviewRevision | null {
        const row = this.getRevisionStmt.get(planId, revision) as
            | DraftRow
            | undefined;
        return row ? rowToRevision(row) : null;
    }

    /**
     * All revisions for a plan in chronological (revision-ascending)
     * order. Returns an empty array — never `null` — for an unknown
     * plan so callers can iterate without a null-guard.
     */
    listRevisions(planId: string): readonly PlanReviewRevision[] {
        const rows = this.listRevisionsStmt.all(planId) as DraftRow[];
        return rows.map(rowToRevision);
    }

    /**
     * Returns true once a `PlanDecomposed` has been folded for
     * `planId`. Exposed so callers can filter the pending set without
     * a second query.
     */
    isDecomposed(planId: string): boolean {
        return this.isDecomposedStmt.get(planId) !== undefined;
    }

    /**
     * Enumerate every plan with at least one revision that has not yet
     * been decomposed. The board hits this on boot to re-hydrate the
     * active-planner cards after a page reload.
     */
    listPending(): PendingPlanReview[] {
        const rows = this.listPendingStmt.all() as Array<{
            plan_id: string;
            project_id: string;
            revision: number;
            content: string;
            generated_at: number;
        }>;
        return rows.map((row) => ({
            planId: row.plan_id,
            projectId: row.project_id,
            revision: row.revision,
            content: row.content,
            generatedAt: row.generated_at,
        }));
    }

    private applyPlanGenerated(event: PlanGenerated | StoredEvent): PlanReviewRevision | null {
        const payload = (event as PlanGenerated).payload;
        const planId = payload.planId;
        if (typeof planId !== 'string' || planId.length === 0) return null;

        const revision =
            typeof payload.revision === 'number' && Number.isFinite(payload.revision)
                ? payload.revision
                : 1;
        const content = typeof payload.content === 'string' ? payload.content : '';
        const feedback =
            typeof payload.feedback === 'string' && payload.feedback.length > 0
                ? payload.feedback
                : null;
        const projectId =
            typeof payload.projectId === 'string' && payload.projectId.length > 0
                ? payload.projectId
                : null;
        const generatedAt =
            typeof event.occurredAt === 'number' && Number.isFinite(event.occurredAt)
                ? event.occurredAt
                : 0;

        this.upsertDraftStmt.run({
            planId,
            revision,
            content,
            feedback,
            projectId,
            generatedAt,
        });

        // A new revision means the planner re-ran (operator clicked
        // Regenerate, or a prior run that emitted a stale decomposed
        // flag is being superseded). Clear any decomposed mark so the
        // active-planner card resurfaces on `listPending()` and the
        // operator gets a fresh approve/regenerate decision against
        // the new draft. Without this, a once-decomposed planId stays
        // decomposed forever even if the operator restarts the plan.
        this.deleteDecomposedStmt.run(planId);

        // Re-read so the row we return reflects the COALESCE of
        // project_id (if a later replay omitted it, the stored value
        // wins) and the post-conflict-branch state generally.
        const row = this.getRevisionStmt.get(planId, revision) as
            | DraftRow
            | undefined;
        if (!row) {
            this.logger?.warn(
                'plan-review-store: PlanGenerated landed but row missing on re-read',
                { planId, revision },
            );
            return null;
        }
        return rowToRevision(row);
    }

    private applyPlanDecomposed(event: PlanDecomposed | StoredEvent): void {
        const payload = (event as PlanDecomposed).payload;
        const planId = payload.planId;
        if (typeof planId !== 'string' || planId.length === 0) return;
        // Two `PlanDecomposed` events flow per plan in production:
        //   1. Synchronous from the `DecomposePlan` command handler the
        //      moment the operator clicks Approve. No `tasks` payload
        //      — it just records the approval on the event log.
        //   2. Async from the lifecycle subscriber once the decomposer
        //      agent finishes. Carries the actual task list.
        //
        // Marking the plan as decomposed on the first (empty) event
        // would retire the active-planner card the moment the
        // operator approves — *before* the decomposer has even
        // started. The card should stay until the agent's task-bearing
        // event lands (or the plan is discarded), matching what
        // `TaskProjectionStore` does on the same discriminator.
        const tasks = (payload as { tasks?: unknown }).tasks;
        if (!Array.isArray(tasks) || tasks.length === 0) return;
        const decomposedAt =
            typeof event.occurredAt === 'number' && Number.isFinite(event.occurredAt)
                ? event.occurredAt
                : 0;
        this.markDecomposedStmt.run({ planId, decomposedAt });
    }

    /**
     * Cascade a Discard / Archive into the plan-review tables. Both
     * draft revisions AND the decomposed flag are wiped so a future
     * re-create of the same planId starts from a clean slate. Without
     * this fold, `listPending()` would keep returning rows for plans
     * the operator has already dismissed — the active-planner card
     * would resurrect itself on every page reload.
     */
    private applyPlanRemoval(payload: PlanRemovalPayload): void {
        const planId = payload.planId;
        if (typeof planId !== 'string' || planId.length === 0) return;
        this.deleteDraftsStmt.run(planId);
        this.deleteDecomposedStmt.run(planId);
    }
}
