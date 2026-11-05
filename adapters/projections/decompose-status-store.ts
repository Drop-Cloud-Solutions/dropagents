/**
 * AP-IFF-005 — production `DecomposeStatusPort` adapter over the v2 event log.
 *
 * The route in `hosts/worker-api/routes/decompose-status.ts` is a pure
 * snapshot consumer: it asks the port for a `DecomposeStatusSnapshot` and
 * maps it onto the four-state status vocabulary. This adapter is the
 * production implementation of that port — it derives the snapshot by
 * scanning the `events` table for the lifecycle events the orchestrator
 * publishes when a decompose run happens.
 *
 * Per the task brief, no new event types are introduced. The decompose
 * lifecycle in v2 today emits a single `PlanDecomposed` event (see
 * `core/commands/index.ts` + `hosts/orchestrator/handlers.ts`). The
 * adapter is written so it ALSO recognises optional terminal events
 * (`PlanDecomposeFinished`, `PlanDecomposeFailed`) when they exist on the
 * log — that keeps the contract honest as the engine grows: the moment a
 * subscriber starts emitting them, the route flips from `running` to
 * `complete` / `error` without a touch to either side.
 *
 * Mapping from events to snapshot fields:
 *
 *   PlanDecomposed         → startedAt = occurredAt
 *   PlanDecomposeFinished  → finishedAt = occurredAt, currentStep, totalSteps
 *   PlanDecomposeFailed    → errorMessage, finishedAt = occurredAt
 *
 * Scoping: the JSON payload's `planId` AND `projectId` must both match the
 * arguments. Matching on planId alone would let a request for one project
 * leak status across to another project that happened to reuse the planId.
 */

import type { Db } from '../../core/state/migrations';
import type {
    DecomposeStatusPort,
    DecomposeStatusSnapshot,
} from '../../hosts/worker-api/routes/decompose-status';

/**
 * Event-type names this adapter understands. Listed as a single source of
 * truth so a future migration that renames any of them has one place to
 * update — both the wire and the port stay in lockstep.
 */
export const DECOMPOSE_EVENT_TYPES = {
    STARTED: 'PlanDecomposed',
    FINISHED: 'PlanDecomposeFinished',
    FAILED: 'PlanDecomposeFailed',
} as const;

/**
 * Row shape returned by the prepared statement. Columns are limited to the
 * fields the adapter actually folds into the snapshot — keeping the row
 * narrow keeps the JSON parse cost bounded even on a long event log.
 */
interface DecomposeEventRow {
    readonly type: string;
    readonly occurred_at: number;
    readonly payload: string;
}

/**
 * SQLite-backed adapter. Implements {@link DecomposeStatusPort} by reading
 * directly from the `events` table managed by `core/events/store.ts`.
 *
 * The adapter does NOT maintain its own projection table. The decompose
 * lifecycle is low-frequency (one event per plan per run), so scanning the
 * subset of `events` whose `type` matches a decompose lifecycle type and
 * filtering by JSON payload is cheap. An index on `events.type` already
 * exists (see `core/state/migrations/001_initial.sql`), which gives the
 * query a covering filter before JSON inspection kicks in.
 */
export class SqliteDecomposeStatusStore implements DecomposeStatusPort {
    constructor(private readonly db: Db) {}

    async readDecomposeStatus(
        projectId: string,
        planId: string,
    ): Promise<DecomposeStatusSnapshot> {
        const rows = this.db
            .prepare(
                `SELECT type, occurred_at, payload
                 FROM events
                 WHERE type IN (?, ?, ?)
                 ORDER BY seq ASC`,
            )
            .all(
                DECOMPOSE_EVENT_TYPES.STARTED,
                DECOMPOSE_EVENT_TYPES.FINISHED,
                DECOMPOSE_EVENT_TYPES.FAILED,
            ) as ReadonlyArray<DecomposeEventRow>;

        return foldRowsToSnapshot(rows, projectId, planId);
    }
}

/**
 * Pure fold over the event rows. Extracted so unit tests can exercise the
 * derivation rules without standing up a real SQLite instance — and so the
 * sqlite adapter stays a thin SELECT + JSON.parse shim.
 *
 * Behaviour:
 *   - No matching `PlanDecomposed` → blank snapshot (idle).
 *   - First `PlanDecomposed` for the (project, plan) sets `startedAt`.
 *   - Any `PlanDecomposeStepCompleted`-shaped payload on a recognised event
 *     advances `currentStep` / `totalSteps`. Step counts are read from the
 *     terminal events too so a missing per-step stream still reports a
 *     sensible final count when the run completes in one event.
 *   - `PlanDecomposeFailed` populates `errorMessage` + `finishedAt`.
 *   - `PlanDecomposeFinished` populates `finishedAt` only.
 *
 * Malformed payloads (missing fields, non-string projectId) are skipped
 * silently — the route still returns a 200 with the best-effort snapshot
 * rather than 500-ing on a poisoned event row.
 */
export function foldRowsToSnapshot(
    rows: ReadonlyArray<DecomposeEventRow>,
    projectId: string,
    planId: string,
): DecomposeStatusSnapshot {
    let startedAt: number | null = null;
    let finishedAt: number | null = null;
    let errorMessage: string | null = null;
    let currentStep = 0;
    let totalSteps = 0;

    for (const row of rows) {
        const payload = safeParse(row.payload);
        if (payload === null) continue;
        if (!matchesPlan(payload, projectId, planId)) continue;

        // Track step progress from any event that carries the fields. Both
        // terminal events and the started event may carry a final count.
        const cs = readNumber(payload, 'currentStep');
        const ts = readNumber(payload, 'totalSteps');
        if (cs !== null) currentStep = cs;
        if (ts !== null) totalSteps = ts;

        switch (row.type) {
            case DECOMPOSE_EVENT_TYPES.STARTED: {
                // Two shapes share the PlanDecomposed type: the dispatch-time
                // marker (no tasks) and the agent-driven SUCCESS emit (tasks
                // array present). The success shape terminates the run and
                // supersedes any earlier failure — without this, one failed
                // attempt pinned status:'error' forever even after a retry
                // decomposed the plan.
                if (Array.isArray(payload.tasks)) {
                    if (startedAt === null) startedAt = row.occurred_at;
                    finishedAt = row.occurred_at;
                    errorMessage = null;
                    break;
                }
                if (startedAt === null) {
                    // First started event wins — a replayed or re-emitted
                    // started event must not push the timestamp forward.
                    startedAt = row.occurred_at;
                } else if (finishedAt !== null || errorMessage !== null) {
                    // A fresh dispatch AFTER a terminal event is a RETRY —
                    // reset the snapshot so the card shows 'running' again
                    // instead of the previous attempt's stale error.
                    startedAt = row.occurred_at;
                    finishedAt = null;
                    errorMessage = null;
                    currentStep = 0;
                    totalSteps = 0;
                }
                break;
            }
            case DECOMPOSE_EVENT_TYPES.FINISHED:
                finishedAt = row.occurred_at;
                errorMessage = null;
                break;
            case DECOMPOSE_EVENT_TYPES.FAILED: {
                finishedAt = row.occurred_at;
                // emitPlanDecomposeFailed publishes the reason as `error`;
                // older emitters used `errorMessage`. Read both so the card
                // shows the ACTUAL parse/validation message instead of the
                // generic fallback.
                const msg =
                    readString(payload, 'errorMessage') ?? readString(payload, 'error');
                errorMessage = msg ?? 'decompose failed';
                break;
            }
            default:
                break;
        }
    }

    return { startedAt, finishedAt, errorMessage, currentStep, totalSteps };
}

function safeParse(raw: string): Record<string, unknown> | null {
    try {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === 'object') {
            return parsed as Record<string, unknown>;
        }
        return null;
    } catch {
        return null;
    }
}

function matchesPlan(
    payload: Record<string, unknown>,
    projectId: string,
    planId: string,
): boolean {
    return payload.projectId === projectId && payload.planId === planId;
}

function readNumber(
    payload: Record<string, unknown>,
    key: string,
): number | null {
    const v = payload[key];
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function readString(
    payload: Record<string, unknown>,
    key: string,
): string | null {
    const v = payload[key];
    return typeof v === 'string' && v.length > 0 ? v : null;
}
