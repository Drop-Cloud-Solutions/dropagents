/**
 * AP-IFF-005 — read-only decompose-status projection.
 *
 * Surface: `GET /api/projects/:pid/plans/:planId/decompose-status`.
 *
 * Returns a flattened JSON shape the operator board can render without
 * having to replay any event log:
 *
 *   {
 *     status: 'idle' | 'running' | 'complete' | 'error',
 *     progress: { currentStep, totalSteps },
 *     errorMessage?: string,        // present only when status === 'error'
 *   }
 *
 * Architectural rule (same as `hosts/board-ui/projections.ts`): reads come
 * from a projection port — never the event log directly. The port surface
 * declared here is intentionally minimal so any adapter (sqlite, in-memory,
 * fake) can satisfy it. Tests in `./decompose-status.spec.ts` wire a small
 * fake; a production adapter that derives the snapshot from the v2 event
 * store (`PlanDecomposed`, the decomposer agent's lifecycle events) lands in
 * a follow-up subscriber wiring task.
 *
 * "No new event types" (per the brief): this module is purely a read
 * projection — it does not register commands or emit events. Status is
 * derived from a snapshot the port exposes.
 */

/**
 * A point-in-time view of decompose progress for a single plan. The port
 * collapses the underlying events (decompose started, per-step completed,
 * decompose finished / failed) into the four fields below; this module
 * then maps those fields onto the documented status vocabulary.
 *
 * `startedAt === null` is the canonical "no decompose ever ran for this
 * plan" signal (→ `idle`). Once a run starts, `currentStep` / `totalSteps`
 * advance as decomposer steps complete; `finishedAt` flips when the run
 * terminates cleanly; `errorMessage` is set when it fails.
 */
export interface DecomposeStatusSnapshot {
    readonly startedAt: number | null;
    readonly finishedAt: number | null;
    readonly errorMessage: string | null;
    readonly currentStep: number;
    readonly totalSteps: number;
    /**
     * Optional planner-side lifecycle phase tag (e.g. `'generating'`,
     * `'reviewing'`, `'approved'`). Sourced from the decompose-status-store
     * when the underlying engine has surfaced one; passed through to the
     * route body so the operator board can render planner progress
     * alongside decompose progress.
     */
    readonly plannerPhase?: string | null;
    /**
     * Revision of the plan-review draft this decompose status corresponds
     * to. Useful when the operator re-rolled the plan and a stale decompose
     * snapshot is still on screen — the board can compare against the
     * latest plan-review revision and warn the operator.
     */
    readonly revision?: number | null;
    /**
     * Last operator-facing error the engine recorded. Distinct from
     * `errorMessage` (which is the *terminal* failure of a decompose run):
     * `lastError` carries transient errors the engine recovered from, so a
     * run can be `'running'` AND surface the most recent transient error.
     */
    readonly lastError?: string | null;
}

/**
 * Read-side port over the decompose-status projection. Production wires a
 * sqlite-backed adapter that folds the v2 events into the snapshot; tests
 * pass a hand-rolled fake.
 *
 * Returns a "blank" snapshot (all zero / null) — not `null` — when no
 * decompose run has ever happened for the plan. That keeps the route's
 * idle case a single branch on `startedAt`, with no nullable plumbing in
 * the response builder.
 */
export interface DecomposeStatusPort {
    readDecomposeStatus(
        projectId: string,
        planId: string,
    ): Promise<DecomposeStatusSnapshot>;
}

/**
 * The four documented status values. Kept narrow on purpose: anything
 * outside this set is a contract break, not a tolerable variant.
 */
export type DecomposeStatus = 'idle' | 'running' | 'complete' | 'error';

export interface DecomposeStatusBody {
    readonly status: DecomposeStatus;
    readonly progress: {
        readonly currentStep: number;
        readonly totalSteps: number;
    };
    readonly errorMessage?: string;
    /** Planner lifecycle phase. Present only when the snapshot supplies one. */
    readonly plannerPhase?: string;
    /** Plan-review revision this status maps to. Present only when known. */
    readonly revision?: number;
    /** Most recent recoverable error from the engine. Present only when set. */
    readonly lastError?: string;
}

export interface RouteResult {
    readonly status: number;
    readonly body: Readonly<Record<string, unknown>>;
}

/**
 * Translate a snapshot to the wire body. Pure — no I/O — so it is
 * cheap to unit-test the status-derivation rules in isolation from the
 * port.
 *
 * Precedence (matters when multiple terminal signals overlap on the
 * snapshot, e.g. a failed run that also recorded `finishedAt`): `error`
 * wins over `complete` so a recorded failure is never silently masked by
 * the engine writing a finish timestamp on the failure path.
 */
export function deriveStatusBody(
    snapshot: DecomposeStatusSnapshot,
): DecomposeStatusBody {
    const progress = {
        currentStep: snapshot.currentStep,
        totalSteps: snapshot.totalSteps,
    };
    const status = deriveStatus(snapshot);
    const base: DecomposeStatusBody = { status, progress };
    return decorateWithExtras(base, snapshot);
}

function deriveStatus(snapshot: DecomposeStatusSnapshot): DecomposeStatus {
    if (snapshot.startedAt === null) return 'idle';
    if (snapshot.errorMessage !== null) return 'error';
    if (snapshot.finishedAt !== null) return 'complete';
    return 'running';
}

/**
 * Attach the optional surfaced fields (`errorMessage`, `plannerPhase`,
 * `revision`, `lastError`) to the body only when the snapshot supplies
 * them. Keeping each field conditional (rather than always-present-but-
 * null) keeps the wire compact and matches the documented body shape:
 * absent ≡ "engine has nothing to say about this".
 */
function decorateWithExtras(
    body: DecomposeStatusBody,
    snapshot: DecomposeStatusSnapshot,
): DecomposeStatusBody {
    let out: DecomposeStatusBody = body;
    if (body.status === 'error' && snapshot.errorMessage !== null) {
        out = { ...out, errorMessage: snapshot.errorMessage };
    }
    if (typeof snapshot.plannerPhase === 'string' && snapshot.plannerPhase.length > 0) {
        out = { ...out, plannerPhase: snapshot.plannerPhase };
    }
    if (typeof snapshot.revision === 'number' && Number.isFinite(snapshot.revision)) {
        out = { ...out, revision: snapshot.revision };
    }
    if (typeof snapshot.lastError === 'string' && snapshot.lastError.length > 0) {
        out = { ...out, lastError: snapshot.lastError };
    }
    return out;
}

/**
 * Route handler for `GET /api/projects/:pid/plans/:planId/decompose-status`.
 *
 * Always returns 200 with the documented body — a plan that has never
 * been decomposed is `idle`, not 404. That matches the brief's AC #2 and
 * keeps the board's polling loop trivial: it can ask about any plan id
 * without first proving the projection has heard of it.
 *
 * Both path params are required and validated as non-empty strings; an
 * empty `projectId` or `planId` returns 404 so a malformed router pattern
 * cannot fall through to a successful idle response on an unparsed URL.
 */
export async function getDecomposeStatus(
    port: DecomposeStatusPort,
    projectId: string,
    planId: string,
): Promise<RouteResult> {
    if (typeof projectId !== 'string' || projectId.length === 0) {
        return { status: 404, body: { error: 'not found' } };
    }
    if (typeof planId !== 'string' || planId.length === 0) {
        return { status: 404, body: { error: 'not found' } };
    }
    const snapshot = await port.readDecomposeStatus(projectId, planId);
    const body = deriveStatusBody(snapshot);
    return { status: 200, body: body as unknown as Readonly<Record<string, unknown>> };
}

/**
 * Path pattern the host's router matches against. Exposed as a constant so
 * the wiring file and any contract test reference the same literal string
 * (preventing a `:pid` / `:projectId` drift between the route table and
 * the request URLs the board generates).
 */
export const DECOMPOSE_STATUS_ROUTE_PATTERN =
    '/api/projects/:pid/plans/:planId/decompose-status';
