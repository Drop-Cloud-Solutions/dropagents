/**
 * AP-FP-003 — projection store that folds the plan lifecycle events
 * (`PlanCreated`, `PlanUpdated`, `PlanArchived`) into the `plans` row
 * backing the operator sidebar's plan cards.
 *
 * Shape parallel to `project-projection-store.ts`:
 *   - constructor wires the subscriptions against an `EventBus`, named
 *     so `replayMissed(PLAN_PROJECTION_SUBSCRIBER)` recovers after a
 *     process restart.
 *   - per-row state lives in SQLite (`updated_at`), not in-memory, so
 *     there is no `hasProcessed` predicate worth exposing.
 *
 * Composite key:
 *   - The `plans` projection table is keyed on `(pid, plan_id)` rather
 *     than `plan_id` alone — legacy data and copied plan templates can
 *     reuse the same `plan_id` under different projects, and the
 *     sidebar still needs to render them as independent rows. The
 *     event names verified against the orchestrator + board-ui hosts:
 *       - `PlanCreated`  : board-ui commands.ts (`PLAN_CREATED`)
 *       - `PlanUpdated`  : board-ui commands.ts (`PLAN_UPDATED`)
 *       - `PlanArchived` : orchestrator handlers.ts (`PLAN_ARCHIVED`)
 *     PlanCreated carries `projectId` (mapped to `pid`); the Updated
 *     and Archived payloads do not. Those handlers therefore key by
 *     `plan_id` alone — production plan_ids are project-scoped uuids,
 *     so a same-id collision across pids only occurs in the contrived
 *     create-only test scenario, which is what the composite PK
 *     protects.
 *
 * Idempotency model:
 *   - The Created path is `INSERT ... ON CONFLICT(pid, plan_id) DO
 *     UPDATE` gated by `WHERE excluded.updated_at > plans.updated_at`.
 *     A replayed event with the same `occurredAt` flips into the
 *     conflict branch but the WHERE clause evaluates false, so the row
 *     is not touched and `updated_at` never moves backwards.
 *   - The Updated and Archived paths follow the same monotonicity rule
 *     (`@occurredAt > COALESCE(updated_at, 0)`) so a replay is also a
 *     no-op. This matches the brief: "re-applying the same event must
 *     not duplicate rows or change updated_at backwards."
 *
 * Soft delete: `PlanArchived` stamps `archived_at = occurredAt`. The
 * row stays in the table — the sidebar filters on
 * `archived_at IS NULL` (see `core/state/migrations/006_sidebar_projections.sql`).
 */

import type { EventBus } from '../../core/events/bus';
import type { StoredEvent } from '../../core/events/event';
import type { Db } from '../../core/state/migrations';
import type { Logger } from '../../core/ports/Logger';

/**
 * Subscriber name registered with the EventBus. Exposed so a host that
 * wants the projection to recover from missed events on boot can call
 * `bus.replayMissed(PLAN_PROJECTION_SUBSCRIBER)` after wiring it.
 */
export const PLAN_PROJECTION_SUBSCRIBER = 'plan-projection-store';

/**
 * Event-type names this store folds over. Single source of truth so a
 * future rename only updates one place — both the wire and the
 * projection stay in lockstep. Verified against:
 *   - `BoardUiEvents.PLAN_CREATED` / `PLAN_UPDATED` in
 *     `hosts/board-ui/commands.ts`
 *   - `Events.PLAN_ARCHIVED` in `hosts/orchestrator/handlers.ts`
 *   - the discriminated `PlanArchived` variant in
 *     `core/events/event.ts`
 */
export const PLAN_PROJECTION_EVENT_TYPES = {
    CREATED: 'PlanCreated',
    UPDATED: 'PlanUpdated',
    ARCHIVED: 'PlanArchived',
    UNARCHIVED: 'PlanUnarchived',
    DELETED: 'PlanDeleted',
} as const;

/**
 * Structural payload shape for `PlanCreated`. Carries the `projectId`
 * needed to populate the `pid` column of the composite key. Kept
 * narrower than the full `PlanCreatedPayload` declared in
 * `hosts/board-ui/commands.ts` — the projection only persists the
 * fields the sidebar reads.
 */
/**
 * Plan metadata blob persisted on the projection row. Mirrors the wire
 * shape declared by `hosts/board-ui/commands.ts#PlanMetadataPayload`
 * minus the structural guards (the store treats it as opaque JSON —
 * the modal's validator runs ahead of the bus and rejects malformed
 * shapes before they reach this subscriber).
 */
interface PlanMetadataBlob {
    readonly [key: string]: unknown;
}

interface PlanCreatedPayload {
    readonly planId: string;
    readonly projectId: string;
    readonly title?: string;
    readonly body?: string;
    readonly metadata?: PlanMetadataBlob;
}

/**
 * Structural payload shape for `PlanUpdated`. The board-ui's
 * `UpdatePlanPayload` does not carry `projectId`, so updates target
 * the row by `plan_id` alone — production plan_ids are uuids issued
 * per-create, so collisions across pids only occur in the contrived
 * test scenario where two creates share a plan_id under different
 * projects.
 */
interface PlanUpdatedPayload {
    readonly planId: string;
    readonly title?: string;
    readonly body?: string;
    readonly metadata?: PlanMetadataBlob;
}

/**
 * Structural payload shape for `PlanArchived`. The orchestrator emits
 * just `{ planId }`; like Updated, the archive path targets the row
 * by `plan_id` alone.
 */
interface PlanArchivedPayload {
    readonly planId: string;
}

/**
 * SQLite-backed projection over `PlanCreated` / `PlanUpdated` /
 * `PlanArchived`. The constructor wires three subscriptions against
 * the supplied `EventBus`; the bus persists every event before
 * dispatching, so handlers see only events that already cleared the
 * idempotency-key UNIQUE constraint at the store layer.
 */
export class PlanProjectionStore {
    private readonly createStmt;
    private readonly updateStmt;
    private readonly archiveStmt;
    private readonly unarchiveStmt;
    private readonly bodyStmt;
    private readonly logger?: Logger;

    constructor(private readonly db: Db, bus: EventBus, logger?: Logger) {
        this.logger = logger;
        // Created: insert a fresh row keyed on the composite (pid,
        // plan_id) PK. If the same key is already present (replay,
        // duplicate-create), fall through to the conflict branch and
        // refresh the `name`/`updated_at` only when the incoming event
        // is strictly newer than what we have stored.
        this.createStmt = db.prepare(
            `INSERT INTO sidebar_plans(plan_id, pid, name, body, metadata, status, archived_at, updated_at)
             VALUES (@planId, @pid, @name, @body, @metadata, NULL, NULL, @occurredAt)
             ON CONFLICT(pid, plan_id) DO UPDATE SET
                 name       = COALESCE(excluded.name, sidebar_plans.name),
                 body       = COALESCE(excluded.body, sidebar_plans.body),
                 metadata   = COALESCE(excluded.metadata, sidebar_plans.metadata),
                 updated_at = excluded.updated_at
             WHERE excluded.updated_at > sidebar_plans.updated_at`,
        );

        // Updated: targets the row by `plan_id` alone — the Updated
        // payload does not carry `projectId`. COALESCE preserves the
        // stored `name` / `body` / `metadata` when the payload omits
        // them (operator edited only one field). Monotonicity guard
        // makes a stale or replayed event a no-op.
        //
        // `>=`, not `>`: two updates landing in the SAME millisecond are
        // both legitimate, and the strict comparison silently dropped the
        // second — pick a plan's target repo twice in quick succession and
        // the correction never applied, with nothing anywhere to say why.
        // Equality still rejects nothing real: events reach a subscriber in
        // bus order, so same-timestamp events arrive in causal order and
        // last-write-wins is correct for them. A genuinely STALE event
        // (older timestamp) is still a no-op, which is what the guard is
        // for.
        this.updateStmt = db.prepare(
            `UPDATE sidebar_plans
                SET name       = COALESCE(@name, name),
                    body       = COALESCE(@body, body),
                    metadata   = COALESCE(@metadata, metadata),
                    updated_at = @occurredAt
              WHERE plan_id = @planId
                AND @occurredAt >= COALESCE(updated_at, 0)`,
        );

        // Archive: soft-delete by stamping `archived_at` with the
        // event timestamp. The row is never removed — the sidebar
        // filters out archived plans on read.
        this.archiveStmt = db.prepare(
            `UPDATE sidebar_plans
                SET archived_at = @occurredAt,
                    updated_at  = @occurredAt
              WHERE plan_id = @planId
                AND @occurredAt > COALESCE(updated_at, 0)`,
        );

        // Unarchive: inverse of archive — clears the soft-delete stamp so
        // the read-side `archived_at IS NULL` filters surface the plan
        // again. Same monotonicity guard as every other write.
        this.unarchiveStmt = db.prepare(
            `UPDATE sidebar_plans
                SET archived_at = NULL,
                    updated_at  = @occurredAt
              WHERE plan_id = @planId
                AND @occurredAt > COALESCE(updated_at, 0)`,
        );

        // Read-side lookup of the stored plan body. Keyed on `plan_id`
        // alone (production plan_ids are project-scoped uuids) and picks
        // the most-recently-updated row should a contrived same-id
        // collision across pids exist. Backs the `PlanContentReader` the
        // Telegram decompose path consumes so it decomposes real approved
        // content instead of an empty string.
        this.bodyStmt = db.prepare(
            `SELECT body FROM sidebar_plans
              WHERE plan_id = @planId
              ORDER BY updated_at DESC
              LIMIT 1`,
        );

        bus.subscribe<PlanCreatedPayload>(
            PLAN_PROJECTION_EVENT_TYPES.CREATED,
            (event) => this.onCreated(event),
            { subscriber: PLAN_PROJECTION_SUBSCRIBER },
        );
        bus.subscribe<PlanUpdatedPayload>(
            PLAN_PROJECTION_EVENT_TYPES.UPDATED,
            (event) => this.onUpdated(event),
            { subscriber: PLAN_PROJECTION_SUBSCRIBER },
        );
        bus.subscribe<PlanArchivedPayload>(
            PLAN_PROJECTION_EVENT_TYPES.ARCHIVED,
            (event) => this.onArchived(event),
            { subscriber: PLAN_PROJECTION_SUBSCRIBER },
        );
        bus.subscribe<PlanArchivedPayload>(
            PLAN_PROJECTION_EVENT_TYPES.UNARCHIVED,
            (event) => this.onUnarchived(event),
            { subscriber: PLAN_PROJECTION_SUBSCRIBER },
        );
        // PlanDeleted folds into the same archive path — the sidebar
        // query filters on `archived_at IS NULL`, so soft-deleting via
        // a timestamp hides the row from the operator's view without
        // losing the event history. The board's "Delete" button is
        // currently the only way to dismiss a plan, so without this
        // subscription clicking Delete looked silent (the command was
        // accepted but the row stayed in sidebar_plans).
        bus.subscribe<PlanArchivedPayload>(
            PLAN_PROJECTION_EVENT_TYPES.DELETED,
            (event) => this.onArchived(event),
            { subscriber: PLAN_PROJECTION_SUBSCRIBER },
        );
    }

    /**
     * The approved plan body stored for `planId`, or null when the plan is
     * unknown or its body column is empty. Satisfies the `PlanContentReader`
     * shape consumed by the Telegram `decompose_plan` path so decomposition
     * runs against the real approved content rather than an empty string.
     */
    getApprovedContent(planId: string): string | null {
        if (typeof planId !== 'string' || planId.length === 0) return null;
        const row = this.bodyStmt.get({ planId }) as { body: string | null } | undefined;
        const body = row?.body;
        if (typeof body !== 'string' || body.length === 0) return null;
        return body;
    }

    private onCreated(
        event: StoredEvent & { payload: PlanCreatedPayload },
    ): void {
        const { planId, projectId, title, body, metadata } = event.payload;
        if (typeof planId !== 'string' || planId.length === 0) {
            this.logger?.warn('plan-projection: PlanCreated skipped (missing planId)', {
                seq: event.seq,
                payload: event.payload,
            });
            return;
        }
        if (typeof projectId !== 'string' || projectId.length === 0) {
            this.logger?.warn('plan-projection: PlanCreated skipped (missing projectId)', {
                seq: event.seq,
                planId,
            });
            return;
        }
        const info = this.createStmt.run({
            planId,
            pid: projectId,
            name: typeof title === 'string' ? title : null,
            body: typeof body === 'string' ? body : null,
            metadata: serializeMetadata(metadata),
            occurredAt: event.occurredAt,
        });
        this.logger?.info('plan-projection: PlanCreated applied', {
            planId,
            projectId,
            changes: info.changes,
            seq: event.seq,
        });
    }

    private onUpdated(
        event: StoredEvent & { payload: PlanUpdatedPayload },
    ): void {
        const { planId, title, body, metadata } = event.payload;
        if (typeof planId !== 'string' || planId.length === 0) return;
        this.updateStmt.run({
            planId,
            name: typeof title === 'string' ? title : null,
            body: typeof body === 'string' ? body : null,
            metadata: serializeMetadata(metadata),
            occurredAt: event.occurredAt,
        });
    }

    private onArchived(
        event: StoredEvent & { payload: PlanArchivedPayload },
    ): void {
        const { planId } = event.payload;
        if (typeof planId !== 'string' || planId.length === 0) return;
        this.archiveStmt.run({
            planId,
            occurredAt: event.occurredAt,
        });
    }

    private onUnarchived(
        event: StoredEvent & { payload: PlanArchivedPayload },
    ): void {
        const { planId } = event.payload;
        if (typeof planId !== 'string' || planId.length === 0) return;
        this.unarchiveStmt.run({
            planId,
            occurredAt: event.occurredAt,
        });
    }
}

/**
 * Serialize a metadata blob for storage. Returns `null` when the
 * payload omitted metadata (so the COALESCE in the upsert preserves
 * whatever the row already had) and the JSON string otherwise.
 * Defensive against the `undefined` path so a payload that only
 * touched title still leaves the metadata column alone.
 */
function serializeMetadata(metadata: PlanMetadataBlob | undefined): string | null {
    if (metadata === undefined || metadata === null) return null;
    try {
        return JSON.stringify(metadata);
    } catch {
        // Circular references or non-JSON values shouldn't happen
        // (the validator on the command bus rejects malformed
        // shapes), but if they slip through we'd rather not crash
        // the subscriber — return null to preserve the prior value.
        return null;
    }
}
