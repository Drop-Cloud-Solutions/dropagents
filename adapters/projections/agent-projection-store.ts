/**
 * P-SM-002 — projection store that folds the agent lifecycle events
 * (`AgentCreated`, `AgentUpdated`, `AgentDeleted`) emitted by the
 * manager-api command handlers (see `ManagerApiEvents` in
 * `hosts/manager-api/routes.ts`) into the `agents` read-model row that
 * backs the operator UI's `GET /agents` list.
 *
 * The manager-api handlers are pure event emitters — they validate the
 * request, build the event, and return it for the bus to persist. The
 * mutation against the projection table is decoupled from the handler so
 * subscribers can be added or replaced without touching the command
 * layer. This store is the production subscriber for the agents read
 * model.
 *
 * Shape parallel to `project-projection-store.ts`:
 *   - constructor wires the subscription against an `EventBus`, named so
 *     `replayMissed(AGENT_PROJECTION_SUBSCRIBER)` recovers after a
 *     process restart.
 *   - `list()` is the one extra public method the read port
 *     (`GET /agents`) reaches for; the rest of the surface is the
 *     constructor. Per-row state lives in SQLite (`updated_at`) rather
 *     than in-memory, so there is no in-process predicate worth exposing.
 *
 * Idempotency model:
 *   - Both upsert paths (`Created` + `Updated`) run one
 *     `INSERT ... ON CONFLICT(agent_id) DO UPDATE` gated by
 *     `WHERE excluded.updated_at > agents.updated_at`. A replayed event
 *     with the same `occurredAt` triggers the conflict branch but the
 *     WHERE clause evaluates false, so the row is not touched and
 *     `updated_at` never moves backwards.
 *   - `COALESCE(excluded.<col>, agents.<col>)` preserves a stored field
 *     when an `Updated` event omits it — the manager-api
 *     `UpdateAgentPayload` declares every field but `agentId` optional.
 *   - The delete path follows the same monotonicity rule
 *     (`@occurredAt > COALESCE(updated_at, 0)`) so a replayed
 *     `AgentDeleted` is also a no-op.
 *
 * Delete semantics: `AgentDeleted` is a hard delete stamped as
 * `deleted_at = occurredAt`. The row stays in the table (soft row) — the
 * read filters on `deleted_at IS NULL` (see
 * `core/state/migrations/025_agents_projection.sql`), so a deleted agent
 * disappears from `list()` while its history remains inspectable.
 */

import type { EventBus } from '../../core/events/bus';
import type { StoredEvent } from '../../core/events/event';
import type { Db } from '../../core/state/migrations';

/**
 * Subscriber name registered with the EventBus. Exposed so a host that
 * wants the projection to recover from missed events on boot can call
 * `bus.replayMissed(AGENT_PROJECTION_SUBSCRIBER)` after wiring it.
 */
export const AGENT_PROJECTION_SUBSCRIBER = 'agent-projection-store';

/**
 * Event-type names this store folds over. Single source of truth so a
 * future rename only updates one place — both the wire and the
 * projection stay in lockstep. Mirrors `ManagerApiEvents` in
 * `hosts/manager-api/routes.ts`.
 */
export const AGENT_PROJECTION_EVENT_TYPES = {
    CREATED: 'AgentCreated',
    UPDATED: 'AgentUpdated',
    DELETED: 'AgentDeleted',
} as const;

/**
 * Structural payload shapes the store narrows to inside its handlers.
 * Kept intentionally narrower than the full `AgentCreatedPayload`
 * declared in `hosts/manager-api/routes.ts` — the projection only
 * persists the fields the read port surfaces, not the operator-audit
 * field (`actor`) the events carry for auditing.
 */
interface AgentUpsertPayload {
    readonly agentId: string;
    readonly name?: string;
    readonly role?: string;
    readonly provider?: string;
    readonly model?: string;
    readonly prompt?: string;
}

interface AgentDeletePayload {
    readonly agentId: string;
}

/**
 * One active-agent row as surfaced to the `GET /agents` read port.
 * Columns map straight through from the projection table; `deleted_at`
 * is internal bookkeeping and is not exposed. `updatedAt` IS exposed:
 * the orchestrator's `AgentConfigResolver` resolves a role to its
 * newest row (`ORDER BY updated_at DESC LIMIT 1`), so the operator UI
 * needs the timestamp to show which record actually wins when a role
 * has duplicates.
 */
export interface AgentListRow {
    readonly agentId: string;
    readonly name: string | null;
    readonly role: string | null;
    readonly provider: string | null;
    readonly model: string | null;
    readonly prompt: string | null;
    readonly updatedAt: number | null;
}

/**
 * SQLite-backed projection over `AgentCreated` / `AgentUpdated` /
 * `AgentDeleted`. The constructor wires three subscriptions against the
 * supplied `EventBus`; the bus persists every event before dispatching,
 * so handlers see only events that already cleared the idempotency-key
 * UNIQUE constraint at the store layer.
 */
export class AgentProjectionStore {
    private readonly upsertStmt;
    private readonly deleteStmt;
    private readonly listStmt;

    constructor(private readonly db: Db, bus: EventBus) {
        // Same statement for both `Created` and `Updated` paths: the
        // schema has no semantic difference between a fresh row and an
        // edit. COALESCE preserves each stored column when an `Updated`
        // event arrives without that field — the manager-api
        // `UpdateAgentPayload` declares every field but `agentId`
        // optional. The `WHERE` clause keeps `updated_at` monotonic so a
        // replayed event never moves it backwards.
        this.upsertStmt = db.prepare(
            `INSERT INTO agents(agent_id, name, role, provider, model, prompt, deleted_at, updated_at)
             VALUES (@id, @name, @role, @provider, @model, @prompt, NULL, @occurredAt)
             ON CONFLICT(agent_id) DO UPDATE SET
                 name       = COALESCE(excluded.name, agents.name),
                 role       = COALESCE(excluded.role, agents.role),
                 provider   = COALESCE(excluded.provider, agents.provider),
                 model      = COALESCE(excluded.model, agents.model),
                 prompt     = COALESCE(excluded.prompt, agents.prompt),
                 updated_at = excluded.updated_at
             WHERE excluded.updated_at > agents.updated_at`,
        );

        // Hard-delete semantics via a kept ("soft") row: stamp
        // `deleted_at` with the event timestamp so the read filter
        // (`deleted_at IS NULL`) hides the agent while its history
        // remains inspectable. The `WHERE` clause makes the update
        // monotonic: a replayed `AgentDeleted` with the same `occurredAt`
        // evaluates false and is a no-op.
        this.deleteStmt = db.prepare(
            `UPDATE agents
                SET deleted_at = @occurredAt,
                    updated_at = @occurredAt
              WHERE agent_id = @id
                AND @occurredAt > COALESCE(updated_at, 0)`,
        );

        // Read port for `GET /agents`: only active rows, ordered by the
        // operator-facing label.
        this.listStmt = db.prepare(
            `SELECT agent_id AS agentId, name, role, provider, model, prompt,
                    updated_at AS updatedAt
               FROM agents
              WHERE deleted_at IS NULL
              ORDER BY name`,
        );

        bus.subscribe<AgentUpsertPayload>(
            AGENT_PROJECTION_EVENT_TYPES.CREATED,
            (event) => this.onUpsert(event),
            { subscriber: AGENT_PROJECTION_SUBSCRIBER },
        );
        bus.subscribe<AgentUpsertPayload>(
            AGENT_PROJECTION_EVENT_TYPES.UPDATED,
            (event) => this.onUpsert(event),
            { subscriber: AGENT_PROJECTION_SUBSCRIBER },
        );
        bus.subscribe<AgentDeletePayload>(
            AGENT_PROJECTION_EVENT_TYPES.DELETED,
            (event) => this.onDeleted(event),
            { subscriber: AGENT_PROJECTION_SUBSCRIBER },
        );
    }

    /**
     * Active agents, ordered by name — the shape `GET /agents` returns.
     * Rows stamped with a `deleted_at` are excluded.
     */
    list(): AgentListRow[] {
        return this.listStmt.all() as AgentListRow[];
    }

    private onUpsert(
        event: StoredEvent & { payload: AgentUpsertPayload },
    ): void {
        const { agentId, name, role, provider, model, prompt } = event.payload;
        if (typeof agentId !== 'string' || agentId.length === 0) return;
        this.upsertStmt.run({
            id: agentId,
            name: typeof name === 'string' ? name : null,
            role: typeof role === 'string' ? role : null,
            provider: typeof provider === 'string' ? provider : null,
            model: typeof model === 'string' ? model : null,
            prompt: typeof prompt === 'string' ? prompt : null,
            occurredAt: event.occurredAt,
        });
    }

    private onDeleted(
        event: StoredEvent & { payload: AgentDeletePayload },
    ): void {
        const { agentId } = event.payload;
        if (typeof agentId !== 'string' || agentId.length === 0) return;
        this.deleteStmt.run({
            id: agentId,
            occurredAt: event.occurredAt,
        });
    }
}
