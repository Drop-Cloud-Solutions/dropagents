/**
 * Retention for streaming-telemetry events.
 *
 * AgentActivity / AgentProgress are live-stream fodder: chunks and ticks
 * that only matter while the emitting agent process is alive (board
 * streaming, in-memory summary accumulation folded elsewhere at
 * AgentFinished). Nothing replays them historically — boot replay skips
 * them explicitly — yet they were ~80% of a mature log (68k of 85k
 * events, 101 MB db on the field worker).
 *
 * This prune runs at orchestrator boot, deleting telemetry rows older
 * than the retention window. A short window is kept (default 7 days) so
 * an operator can still inspect very recent streams in the raw log while
 * debugging. Deletion is safe at any offset position: subscribers that
 * saw the rows have moved past them, and subscribers that never saw them
 * skip them at replay anyway.
 *
 * Disk note: SQLite reuses freed pages, so the file stops GROWING
 * immediately but only shrinks after a manual `VACUUM` (worker stopped).
 */
import type { Db } from './migrations';

/** Event types with no historical value — single source of truth shared
 *  with the orchestrator's boot-replay skip-list. */
export const TELEMETRY_EVENT_TYPES = ['AgentActivity', 'AgentProgress'] as const;

export interface TelemetryPruneResult {
    /** Rows deleted (0 when disabled or nothing matched). */
    readonly deleted: number;
    /** The occurred_at cutoff used, ms epoch (0 when disabled). */
    readonly cutoff: number;
}

export function pruneTelemetryEvents(
    db: Db,
    opts: { readonly retentionDays: number; readonly now: number },
): TelemetryPruneResult {
    if (!Number.isFinite(opts.retentionDays) || opts.retentionDays <= 0) {
        return { deleted: 0, cutoff: 0 };
    }
    const cutoff = opts.now - opts.retentionDays * 24 * 60 * 60 * 1000;
    const placeholders = TELEMETRY_EVENT_TYPES.map(() => '?').join(', ');
    const result = db
        .prepare(
            `DELETE FROM events
              WHERE type IN (${placeholders}) AND occurred_at < ?`,
        )
        .run(...TELEMETRY_EVENT_TYPES, cutoff);
    return { deleted: result.changes, cutoff };
}

/**
 * Resolve the retention window from the environment.
 * `PIPELINE_TELEMETRY_RETENTION_DAYS`: days to keep (default 7);
 * `0` disables pruning entirely.
 */
export function resolveTelemetryRetentionDays(
    env: Record<string, string | undefined>,
): number {
    const raw = env.PIPELINE_TELEMETRY_RETENTION_DAYS;
    if (raw === undefined || raw.trim().length === 0) return 7;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 7;
}
