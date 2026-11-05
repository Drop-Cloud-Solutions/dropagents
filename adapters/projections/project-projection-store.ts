/**
 * AP-FP-002 — projection store that folds the project lifecycle events
 * (`ProjectCreated`, `ProjectUpdated`, `ProjectArchived`) into the
 * `projects` row backing the operator sidebar.
 *
 * The board-ui handlers (`hosts/board-ui/commands.ts`) are pure event
 * emitters — they validate the request, build the event, and return it
 * for the bus to persist. The mutation against the projection table is
 * decoupled from the handler so subscribers can be added or replaced
 * without touching the command layer. This store is the production
 * subscriber for the sidebar's projects column.
 *
 * Shape parallel to `task-projection-store.ts`:
 *   - constructor wires the subscription against an `EventBus`, named
 *     so `replayMissed(PROJECT_PROJECTION_SUBSCRIBER)` recovers after a
 *     process restart.
 *   - the public API is the constructor; there are no other methods
 *     callers need to reach for in production. A `hasProcessed`
 *     equivalent would be a test seam — but we keep the per-row state
 *     in SQLite (`updated_at`) rather than in-memory, so there is no
 *     analogous predicate worth exposing.
 *
 * Idempotency model:
 *   - Both upsert paths run an `INSERT ... ON CONFLICT(id) DO UPDATE`
 *     gated by `WHERE excluded.updated_at > projects.updated_at`. A
 *     replayed event with the same `occurredAt` triggers the conflict
 *     branch but the WHERE clause evaluates false, so the row is not
 *     touched and `updated_at` never moves backwards.
 *   - The archive path follows the same monotonicity rule
 *     (`@occurredAt > COALESCE(updated_at, 0)`) so a replayed
 *     `ProjectArchived` is also a no-op.
 *   - This matches the brief's requirement: "re-applying the same
 *     event must not duplicate rows or change updated_at backwards."
 *
 * Soft delete: `ProjectArchived` stamps `archived_at = occurredAt`. The
 * row stays in the table — the sidebar filters on
 * `archived_at IS NULL` (see `core/state/migrations/006_sidebar_projections.sql`).
 */

import type { EventBus } from '../../core/events/bus';
import type { StoredEvent } from '../../core/events/event';
import type { Db } from '../../core/state/migrations';

/**
 * Subscriber name registered with the EventBus. Exposed so a host that
 * wants the projection to recover from missed events on boot can call
 * `bus.replayMissed(PROJECT_PROJECTION_SUBSCRIBER)` after wiring it.
 */
export const PROJECT_PROJECTION_SUBSCRIBER = 'project-projection-store';

/**
 * Event-type names this store folds over. Single source of truth so a
 * future rename only updates one place — both the wire and the
 * projection stay in lockstep.
 */
export const PROJECT_PROJECTION_EVENT_TYPES = {
    CREATED: 'ProjectCreated',
    UPDATED: 'ProjectUpdated',
    ARCHIVED: 'ProjectArchived',
    /**
     * Per-flow / per-step approval policy. Folded here because it lives on
     * the project row, but kept a separate event because it is POLICY the
     * engine reads rather than part of the project's identity — and
     * because it merges into `metadata` instead of replacing it.
     */
    APPROVAL_OVERRIDE_UPDATED: 'ProjectApprovalOverrideUpdated',
    /**
     * The project's architecture context (migration 034). Its own column
     * rather than a metadata key: it is prose measured in KB and the
     * sidebar list reads metadata on every board load.
     */
    CONTEXT_UPDATED: 'ProjectContextUpdated',
} as const;

/**
 * Structural payload shapes the store narrows to inside its handlers.
 * Kept intentionally narrower than the full `ProjectCreatedPayload`
 * declared in `hosts/board-ui/commands.ts` — the projection only
 * persists the fields the sidebar reads, not the operator-audit
 * fields (`actor`, `description`) the events carry for auditing.
 */
interface ProjectMetadataBlob {
    readonly [key: string]: unknown;
}

interface ProjectUpsertPayload {
    readonly projectId: string;
    readonly name?: string;
    readonly metadata?: ProjectMetadataBlob;
}

interface ProjectContextPayload {
    readonly projectId: string;
    readonly context?: unknown;
}

interface ProjectApprovalOverridePayload {
    readonly projectId: string;
    readonly approvalOverride?: unknown;
}

interface ProjectArchivePayload {
    readonly projectId: string;
}

/**
 * SQLite-backed projection over `ProjectCreated` / `ProjectUpdated` /
 * `ProjectArchived`. The constructor wires three subscriptions against
 * the supplied `EventBus`; the bus persists every event before
 * dispatching, so handlers see only events that already cleared the
 * idempotency-key UNIQUE constraint at the store layer.
 */
export class ProjectProjectionStore {
    private readonly upsertStmt;
    private readonly approvalOverrideStmt;
    private readonly contextStmt;
    private readonly archiveStmt;

    constructor(private readonly db: Db, bus: EventBus) {
        // Same statement for both `Created` and `Updated` paths: the
        // schema has no semantic difference between a fresh row and an
        // edit. COALESCE preserves the existing `name` when an
        // `Updated` event arrives without a `name` field — the
        // board-ui's `UpdateProjectPayload` declares `name` optional.
        this.upsertStmt = db.prepare(
            `INSERT INTO projects(id, name, metadata, archived_at, updated_at)
             VALUES (@id, @name, @metadata, NULL, @occurredAt)
             ON CONFLICT(id) DO UPDATE SET
                 name       = COALESCE(excluded.name, projects.name),
                 metadata   = COALESCE(excluded.metadata, projects.metadata),
                 updated_at = excluded.updated_at
             WHERE excluded.updated_at > projects.updated_at`,
        );

        this.approvalOverrideStmt = db.prepare(
            `UPDATE projects
                SET metadata   = json_set(
                        COALESCE(metadata, '{}'),
                        '$.approvalOverride',
                        json(@override)
                    ),
                    updated_at = @occurredAt
              WHERE id = @id`,
        );

        // Empty string CLEARS the context (a legitimate state), so this
        // writes whatever it is handed rather than COALESCE-ing.
        this.contextStmt = db.prepare(
            `UPDATE projects
                SET context_md = @context,
                    updated_at = @occurredAt
              WHERE id = @id`,
        );

        // Soft-delete: stamp `archived_at` with the event timestamp.
        // The row is never removed — the sidebar filters out archived
        // projects on read. The `WHERE` clause makes the update
        // monotonic: a replayed `ProjectArchived` with the same
        // `occurredAt` evaluates false and is a no-op.
        this.archiveStmt = db.prepare(
            `UPDATE projects
                SET archived_at = @occurredAt,
                    updated_at  = @occurredAt
              WHERE id = @id
                AND @occurredAt > COALESCE(updated_at, 0)`,
        );

        bus.subscribe<ProjectUpsertPayload>(
            PROJECT_PROJECTION_EVENT_TYPES.CREATED,
            (event) => this.onUpsert(event),
            { subscriber: PROJECT_PROJECTION_SUBSCRIBER },
        );
        bus.subscribe<ProjectUpsertPayload>(
            PROJECT_PROJECTION_EVENT_TYPES.UPDATED,
            (event) => this.onUpsert(event),
            { subscriber: PROJECT_PROJECTION_SUBSCRIBER },
        );
        bus.subscribe<ProjectArchivePayload>(
            PROJECT_PROJECTION_EVENT_TYPES.ARCHIVED,
            (event) => this.onArchived(event),
            { subscriber: PROJECT_PROJECTION_SUBSCRIBER },
        );
        bus.subscribe<ProjectApprovalOverridePayload>(
            PROJECT_PROJECTION_EVENT_TYPES.APPROVAL_OVERRIDE_UPDATED,
            (event) => this.onApprovalOverride(event),
            { subscriber: PROJECT_PROJECTION_SUBSCRIBER },
        );
        bus.subscribe<ProjectContextPayload>(
            PROJECT_PROJECTION_EVENT_TYPES.CONTEXT_UPDATED,
            (event) => this.onContext(event),
            { subscriber: PROJECT_PROJECTION_SUBSCRIBER },
        );
    }

    private onContext(
        event: StoredEvent & { payload: ProjectContextPayload },
    ): void {
        const { projectId, context } = event.payload;
        if (typeof projectId !== 'string' || projectId.length === 0) return;
        if (typeof context !== 'string') return;
        this.contextStmt.run({
            id: projectId,
            context: context.length > 0 ? context : null,
            occurredAt: event.occurredAt,
        });
    }

    private onUpsert(
        event: StoredEvent & { payload: ProjectUpsertPayload },
    ): void {
        const { projectId, name, metadata } = event.payload;
        if (typeof projectId !== 'string' || projectId.length === 0) return;
        this.upsertStmt.run({
            id: projectId,
            name: typeof name === 'string' ? name : null,
            metadata: serializeMetadata(metadata),
            occurredAt: event.occurredAt,
        });
    }

    /**
     * MERGE the override into the metadata blob — `json_set` touches one
     * key and leaves `abbr` / `color` / `repos` alone. The upsert above
     * REPLACES the blob wholesale (what the project form sends), which
     * would silently drop every other field if it were reused here.
     *
     * No `updated_at` guard: unlike the identity events this is not
     * monotonic-by-timestamp — two overrides set seconds apart are both
     * legitimate, and the last write is the operator's latest intent.
     */
    private onApprovalOverride(
        event: StoredEvent & { payload: ProjectApprovalOverridePayload },
    ): void {
        const { projectId, approvalOverride } = event.payload;
        if (typeof projectId !== 'string' || projectId.length === 0) return;
        if (approvalOverride === undefined || approvalOverride === null) return;
        this.approvalOverrideStmt.run({
            id: projectId,
            override: JSON.stringify(approvalOverride),
            occurredAt: event.occurredAt,
        });
    }

    private onArchived(
        event: StoredEvent & { payload: ProjectArchivePayload },
    ): void {
        const { projectId } = event.payload;
        if (typeof projectId !== 'string' || projectId.length === 0) return;
        this.archiveStmt.run({
            id: projectId,
            occurredAt: event.occurredAt,
        });
    }
}

/**
 * Serialize a metadata blob to JSON for storage. Returns `null` when
 * the payload omitted metadata so the COALESCE in the upsert preserves
 * whatever the row already had. Defensive against shapes the JSON
 * serialiser can't handle (circular refs, BigInt, etc.) so a
 * malformed write doesn't crash the subscriber.
 */
function serializeMetadata(metadata: ProjectMetadataBlob | undefined): string | null {
    if (metadata === undefined || metadata === null) return null;
    try {
        return JSON.stringify(metadata);
    } catch {
        return null;
    }
}
