import type { ApprovalOverrideWarning } from '../../core/projects/registry';
import type { Db } from '../../core/state/migrations';

/**
 * Body shape returned by `GET /health` on the worker-api host.
 *
 * `pendingProjections` is the projection-lag gauge — the number of events
 * sitting in the log past the slowest named subscriber. `null` is the
 * "store-degraded" sentinel: the gauge could not be computed within the
 * health-check budget, but the host itself is still up (`ok: true`).
 *
 * `adapters`, `lastEventAt` and `parkedTasks` are the AP-VP7-003 fields.
 * Each one is computed by its own injected async reader and is allowed to
 * degrade independently — a slow read for one field is not allowed to
 * nuke the other two. When a field times out or throws, it is filled with
 * a safe default (`{}` / `null` / `0`) and the corresponding flag in
 * `degraded` is set to `true`, so a consumer can distinguish "store empty"
 * from "reader unavailable".
 */
export interface HealthCheckBody {
    readonly ok: true;
    readonly uptime: number;
    readonly pendingProjections: number | null;
    readonly adapters: Readonly<Record<string, { readonly wired: boolean }>>;
    readonly lastEventAt: string | null;
    readonly parkedTasks: number;
    /**
     * Stale `approval_override` entries surfaced by the project registry —
     * `(projectId, flowName, stepId)` triples whose stepId is not declared
     * on the flow the registry was last validated against. Empty when no
     * stale entries have been seen, or when no reader is wired (the
     * default for hosts that do not own a `ProjectRegistry` instance).
     *
     * Purely additive: existing consumers that key off `ok` / `uptime` /
     * etc. are unaffected; the field reads as `[]` rather than absent so
     * callers can treat it uniformly.
     */
    readonly approvalOverrideWarnings: ReadonlyArray<ApprovalOverrideWarning>;
    readonly degraded: {
        readonly adapters: boolean;
        readonly lastEventAt: boolean;
        readonly parkedTasks: boolean;
    };
    // Index signature so HealthCheckBody is assignable to the
    // `Readonly<Record<string, unknown>>` shape `BoardHttpServer` accepts
    // for its /health body provider.
    readonly [extra: string]: unknown;
}

/**
 * Returns a non-negative integer or throws. May be sync or async — async is
 * supported chiefly as a test seam (production wires a synchronous
 * better-sqlite3 query).
 */
export type PendingProjectionsQuery = () => number | Promise<number>;

/**
 * Reader for the `adapters` field. Returns a wired-flag per named adapter.
 * Sync or async; production wires async wrappers around the adapter
 * registry, tests use sync stubs.
 */
export type AdapterStatusesQuery = () =>
    | Record<string, { wired: boolean }>
    | Promise<Record<string, { wired: boolean }>>;

/**
 * Reader for the `lastEventAt` field. ISO-8601 timestamp of the most
 * recently appended event, or `null` when the log is empty.
 */
export type LastEventAtQuery = () => (string | null) | Promise<string | null>;

/**
 * Reader for the `parkedTasks` field. Returns the current count of tasks
 * in a parked state — production wires `getParkedTaskCount(db)` from
 * AP-VP7-002.
 */
export type ParkedTaskCountQuery = () => number | Promise<number>;

/**
 * Reader for the `approvalOverrideWarnings` field. Wired in production to
 * `ProjectRegistry.getApprovalOverrideWarnings`. Sync return is the common
 * case (the registry serves an in-memory snapshot); the async signature is
 * supported for symmetry with the other readers and to leave room for a
 * registry that loads warnings lazily from disk.
 */
export type ApprovalOverrideWarningsQuery = () =>
    | ReadonlyArray<ApprovalOverrideWarning>
    | Promise<ReadonlyArray<ApprovalOverrideWarning>>;

export interface HealthCheckOptions {
    readonly db: Db;
    /**
     * Process uptime accessor in seconds. Defaults to `process.uptime()`.
     * Injectable so tests can assert a deterministic value.
     */
    readonly uptime?: () => number;
    /**
     * Hard cap on how long any single /health reader is allowed to run
     * before its field falls back to its degraded default. Shared with
     * the `pendingProjections` gauge. Defaults to 100ms so the whole
     * /health response fits comfortably under the 200ms p99 budget
     * called out in AP-NVP-032.
     */
    readonly timeoutMs?: number;
    /**
     * Test seam: override the default SQLite query. When unset, /health
     * reads from `events` and `subscriber_offsets` via the supplied `db`.
     */
    readonly queryPendingProjections?: PendingProjectionsQuery;
    /**
     * Subscriber names the gauge should measure. The lag number is only
     * meaningful for projectors that REPLAY at boot — action subscribers
     * (auto-merge, fan-out, verify-gate, merge-conflict-resolver) run
     * live-only, so their offsets sit wherever the last live event left
     * them and dragged MIN(last_seq) down: /health read 13803 pending on
     * a worker whose projections were fully caught up. When omitted the
     * gauge measures every subscriber (legacy behaviour).
     */
    readonly projectionSubscribers?: readonly string[];
    /**
     * Reader for the `adapters` map. When omitted, `adapters` is `{}`
     * with `degraded.adapters: false` — the body shape stays stable for
     * legacy callers (notably `hosts/worker-api/main.ts`, which has not
     * yet been migrated to inject adapter status).
     */
    readonly getAdapterStatuses?: AdapterStatusesQuery;
    /**
     * Reader for the `lastEventAt` field.
     */
    readonly getLastEventAt?: LastEventAtQuery;
    /**
     * Reader for the `parkedTasks` field. Production wires
     * `() => getParkedTaskCount(db)` from
     * `core/state/projections/parked-tasks-projection`.
     */
    readonly getParkedTaskCount?: ParkedTaskCountQuery;
    /**
     * Reader for the `approvalOverrideWarnings` field. Production wires
     * `() => registry.getApprovalOverrideWarnings()` once a host owns a
     * `ProjectRegistry` instance. When omitted, the field is `[]` — the
     * body shape stays stable for hosts that do not yet expose stale
     * overrides.
     */
    readonly getApprovalOverrideWarnings?: ApprovalOverrideWarningsQuery;
}

const DEFAULT_TIMEOUT_MS = 100;

/**
 * Build the body-producer used by `BoardHttpServer`'s /health route.
 *
 * The returned function is awaited per request. It races each injected
 * reader against `timeoutMs` independently and in parallel; on timeout or
 * reader error the offending field resolves to its degraded default and
 * its `degraded.*` flag is set, while the surrounding response still
 * reports `ok: true`. This keeps /health useful as a liveness probe even
 * when one underlying store is slow or broken.
 */
export function createWorkerApiHealthCheck(
    options: HealthCheckOptions,
): () => Promise<HealthCheckBody> {
    const uptime = options.uptime ?? ((): number => process.uptime());
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const pendingQuery =
        options.queryPendingProjections
        ?? defaultQuery(options.db, options.projectionSubscribers);
    const adaptersQuery: AdapterStatusesQuery =
        options.getAdapterStatuses ?? ((): Record<string, { wired: boolean }> => ({}));
    const lastEventAtQuery: LastEventAtQuery =
        options.getLastEventAt ?? ((): null => null);
    const parkedTaskCountQuery: ParkedTaskCountQuery =
        options.getParkedTaskCount ?? ((): number => 0);
    const approvalOverrideWarningsQuery: ApprovalOverrideWarningsQuery =
        options.getApprovalOverrideWarnings
        ?? ((): ReadonlyArray<ApprovalOverrideWarning> => []);

    return async (): Promise<HealthCheckBody> => {
        const [
            pending,
            adaptersRes,
            lastEventAtRes,
            parkedRes,
            approvalOverrideWarningsRes,
        ] = await Promise.all([
            runWithTimeout<number, null>(pendingQuery, timeoutMs, null),
            runWithTimeout<
                Record<string, { wired: boolean }>,
                Degraded
            >(adaptersQuery, timeoutMs, DEGRADED),
            runWithTimeout<string | null, Degraded>(
                lastEventAtQuery,
                timeoutMs,
                DEGRADED,
            ),
            runWithTimeout<number, Degraded>(
                parkedTaskCountQuery,
                timeoutMs,
                DEGRADED,
            ),
            // Warnings degrade silently to `[]`. No `degraded.*` flag —
            // AC #4 calls for the new field to be purely additive, so the
            // existing `degraded` shape stays untouched. A slow or
            // throwing registry simply yields the empty default.
            runWithTimeout<
                ReadonlyArray<ApprovalOverrideWarning>,
                ReadonlyArray<ApprovalOverrideWarning>
            >(approvalOverrideWarningsQuery, timeoutMs, []),
        ]);

        const adaptersDegraded = adaptersRes === DEGRADED;
        const lastEventAtDegraded = lastEventAtRes === DEGRADED;
        const parkedDegraded = parkedRes === DEGRADED;

        return {
            ok: true,
            uptime: uptime(),
            pendingProjections: pending,
            adapters: adaptersDegraded ? {} : adaptersRes,
            lastEventAt: lastEventAtDegraded ? null : lastEventAtRes,
            parkedTasks: parkedDegraded ? 0 : parkedRes,
            approvalOverrideWarnings: approvalOverrideWarningsRes,
            degraded: {
                adapters: adaptersDegraded,
                lastEventAt: lastEventAtDegraded,
                parkedTasks: parkedDegraded,
            },
        };
    };
}

/**
 * Sentinel returned by {@link runWithTimeout} when a reader times out or
 * throws. Using a single shared symbol lets the caller distinguish a real
 * `null` (e.g. an empty event log) from a degraded read; the legacy
 * `pendingProjections` path keeps its `null` sentinel for backward
 * compatibility and passes `null` as its fail value instead.
 */
const DEGRADED: unique symbol = Symbol('health-check-degraded');
type Degraded = typeof DEGRADED;

/**
 * The canonical SQL: max event seq minus the slowest subscriber's
 * last_seq. Both selects run as a single prepared statement so SQLite
 * sees one round-trip per /health call. Returns 0 when there are no
 * subscriber rows (cold start) — the absence of subscribers cannot mean
 * "infinite lag" without misrepresenting a freshly-migrated DB.
 *
 * Note on schema vs. task brief: the brief references `event_log.seq`
 * and `subscriber_offsets.offset`; the actual schema (see
 * core/state/schema.sql) uses `events.seq` and `subscriber_offsets.last_seq`.
 * The semantics are identical — the gauge is the gap between the head
 * of the log and the slowest projector.
 */
function defaultQuery(
    db: Db,
    projectionSubscribers?: readonly string[],
): PendingProjectionsQuery {
    // Scope the slowest-projector search to the replaying subscribers when
    // the host names them; otherwise fall back to "every subscriber".
    const names = projectionSubscribers ?? [];
    const filter = names.length > 0
        ? `WHERE subscriber IN (${names.map(() => '?').join(', ')})`
        : '';
    const stmt = db.prepare(
        `SELECT
            (SELECT COALESCE(MAX(seq), 0) FROM events)                     AS max_seq,
            (SELECT MIN(last_seq)  FROM subscriber_offsets ${filter})      AS min_off,
            (SELECT COUNT(*)       FROM subscriber_offsets ${filter})      AS sub_count`,
    );
    const params = names.length > 0 ? [...names, ...names] : [];
    return (): number => {
        const row = stmt.get(...params) as {
            max_seq: number;
            min_off: number | null;
            sub_count: number;
        };
        if (row.sub_count === 0) return 0;
        const minOff = row.min_off ?? 0;
        const pending = row.max_seq - minOff;
        return pending < 0 ? 0 : pending;
    };
}

/**
 * Race the supplied reader against a timer. Resolves to `failValue` on
 * either the timer firing first or the reader throwing — both outcomes
 * map to the same "field unavailable, host still up" body shape.
 *
 * Note: better-sqlite3 is synchronous, so if the SQL call itself blocks
 * the event loop past `timeoutMs` the timer cannot pre-empt it — the
 * query simply finishes late. This still keeps /health bounded for all
 * the failure modes that matter (slow async work, exception path,
 * future async storage adapter) without smuggling worker threads into
 * the health path.
 */
async function runWithTimeout<T, F>(
    work: () => T | Promise<T>,
    timeoutMs: number,
    failValue: F,
): Promise<T | F> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<F>((resolve) => {
        timer = setTimeout(() => resolve(failValue), timeoutMs);
    });
    try {
        const result = await Promise.race<T | F>([
            Promise.resolve().then(() => work()),
            timeout,
        ]);
        return result;
    } catch {
        return failValue;
    } finally {
        if (timer) clearTimeout(timer);
    }
}
