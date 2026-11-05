/**
 * Helpers backing db-report: where the state DB's bytes actually went.
 *
 * Exists because the only honest answer to "the database is 1.4 GB, is
 * that a problem?" is a measurement, and the field worker has no sqlite3
 * CLI to take one with. Splitting the query orchestration from the
 * formatting keeps both testable against an in-memory DB.
 *
 * Two questions this has to separate, because they have opposite fixes:
 *
 *   1. Is the FILE big, or is the DATA big? SQLite reuses freed pages but
 *      never hands them back to the OS, so a file can be mostly slack
 *      after a large delete. That is `npm run vacuum:db`, with no
 *      retention decision attached.
 *   2. If the data really is big, WHAT is big? Streaming telemetry
 *      (`AgentActivity` / `AgentProgress`) is stream fodder nothing
 *      replays and the prune already covers it; agent output carried on
 *      `AgentFinished` is the historical record and is not disposable.
 *      Confusing the two leads to deleting the wrong thing.
 *
 * Read-only throughout, and it never prints a payload VALUE — only type
 * names, counts and sizes. Payloads carry prompts, agent output and
 * operator feedback; a diagnostic that dumps them is a diagnostic nobody
 * can paste into a chat.
 */

import * as fs from 'node:fs';

import type { Db } from '../core/state/migrations';
import {
    TELEMETRY_EVENT_TYPES,
    resolveTelemetryRetentionDays,
} from '../core/state/telemetry-prune';

/** Default number of event types listed before the tail is summarised. */
export const DEFAULT_TYPE_LIMIT = 15;

/**
 * Share of the file that has to be free pages before vacuuming is worth
 * an operator's attention. Below this the slack is ordinary churn.
 */
export const VACUUM_WORTH_IT_RATIO = 0.2;

export interface EventTypeStat {
    readonly type: string;
    readonly rows: number;
    readonly bytes: number;
    readonly maxBytes: number;
}

export interface TelemetryStat {
    /** Rows of streaming telemetry currently in the log, at any age. */
    readonly rows: number;
    readonly bytes: number;
    /** The window the orchestrator would apply at its next boot. */
    readonly retentionDays: number;
    /** Rows the next boot prune would delete (0 when pruning is off). */
    readonly prunableRows: number;
    readonly prunableBytes: number;
}

export interface TableStat {
    readonly name: string;
    readonly rows: number;
}

export interface DbReport {
    readonly dbPath: string;
    readonly fileBytes: number;
    /** WAL sidecar, which can be substantial on a long-running worker. */
    readonly walBytes: number;
    readonly pageCount: number;
    readonly pageSize: number;
    readonly freelistCount: number;
    readonly freeBytes: number;
    /** Free pages as a share of the file, 0..1. */
    readonly freeRatio: number;
    readonly eventRows: number;
    readonly payloadBytes: number;
    readonly oldestEventAt: number | null;
    readonly newestEventAt: number | null;
    readonly byType: readonly EventTypeStat[];
    /** Types beyond the limit, rolled up so the totals still add up. */
    readonly otherTypes: { readonly types: number; readonly rows: number; readonly bytes: number };
    readonly telemetry: TelemetryStat;
    readonly tables: readonly TableStat[];
}

export interface BuildDbReportOptions {
    readonly dbPath: string;
    readonly now: number;
    readonly typeLimit?: number;
    readonly env?: Record<string, string | undefined>;
    /** Seam for tests; defaults to a real stat that tolerates absence. */
    readonly sizeOf?: (path: string) => number;
}

/** Byte size of a path, 0 when it does not exist (the WAL may not). */
export const defaultSizeOf = (path: string): number => {
    try {
        return fs.statSync(path).size;
    } catch {
        return 0;
    }
};

const pragmaNumber = (db: Db, name: string): number => {
    const raw = db.pragma(`${name}`, { simple: true }) as unknown;
    const n = typeof raw === 'number' ? raw : Number(raw);
    return Number.isFinite(n) ? n : 0;
};

export function buildDbReport(db: Db, opts: BuildDbReportOptions): DbReport {
    const sizeOf = opts.sizeOf ?? defaultSizeOf;
    const typeLimit = opts.typeLimit ?? DEFAULT_TYPE_LIMIT;

    const pageCount = pragmaNumber(db, 'page_count');
    const pageSize = pragmaNumber(db, 'page_size');
    const freelistCount = pragmaNumber(db, 'freelist_count');
    const freeBytes = freelistCount * pageSize;
    const filePages = pageCount * pageSize;

    const totals = db
        .prepare(
            `SELECT COUNT(*) AS rows, COALESCE(SUM(LENGTH(payload)), 0) AS bytes,
                    MIN(occurred_at) AS oldest, MAX(occurred_at) AS newest
               FROM events`,
        )
        .get() as {
            rows: number;
            bytes: number;
            oldest: number | null;
            newest: number | null;
        };

    const allTypes = db
        .prepare(
            `SELECT type,
                    COUNT(*) AS rows,
                    COALESCE(SUM(LENGTH(payload)), 0) AS bytes,
                    COALESCE(MAX(LENGTH(payload)), 0) AS maxBytes
               FROM events
              GROUP BY type
              ORDER BY bytes DESC`,
        )
        .all() as EventTypeStat[];
    const byType = allTypes.slice(0, typeLimit);
    const tail = allTypes.slice(typeLimit);
    const otherTypes = {
        types: tail.length,
        rows: tail.reduce((sum, t) => sum + t.rows, 0),
        bytes: tail.reduce((sum, t) => sum + t.bytes, 0),
    };

    const telemetry = buildTelemetryStat(db, opts);
    const tables = listTableRowCounts(db);

    return {
        dbPath: opts.dbPath,
        fileBytes: sizeOf(opts.dbPath),
        walBytes: sizeOf(`${opts.dbPath}-wal`),
        pageCount,
        pageSize,
        freelistCount,
        freeBytes,
        freeRatio: filePages > 0 ? freeBytes / filePages : 0,
        eventRows: totals.rows,
        payloadBytes: totals.bytes,
        oldestEventAt: totals.oldest,
        newestEventAt: totals.newest,
        byType,
        otherTypes,
        telemetry,
        tables,
    };
}

/**
 * Telemetry totals plus a DRY RUN of the boot prune.
 *
 * The retention window comes from the same resolver the orchestrator
 * uses, so "what a restart would delete" is a real answer rather than an
 * estimate against a guessed default. The event-type list is imported for
 * the same reason: a second copy of that vocabulary here would drift from
 * the prune it is reporting on, and report confidently on the wrong set.
 */
function buildTelemetryStat(db: Db, opts: BuildDbReportOptions): TelemetryStat {
    const placeholders = TELEMETRY_EVENT_TYPES.map(() => '?').join(', ');
    const current = db
        .prepare(
            `SELECT COUNT(*) AS rows, COALESCE(SUM(LENGTH(payload)), 0) AS bytes
               FROM events WHERE type IN (${placeholders})`,
        )
        .get(...TELEMETRY_EVENT_TYPES) as { rows: number; bytes: number };

    const retentionDays = resolveTelemetryRetentionDays(opts.env ?? process.env);
    if (retentionDays <= 0) {
        // 0 disables pruning entirely; reporting a cutoff would imply a
        // restart reclaims something, and it would not.
        return {
            rows: current.rows,
            bytes: current.bytes,
            retentionDays,
            prunableRows: 0,
            prunableBytes: 0,
        };
    }
    const cutoff = opts.now - retentionDays * 24 * 60 * 60 * 1000;
    const prunable = db
        .prepare(
            `SELECT COUNT(*) AS rows, COALESCE(SUM(LENGTH(payload)), 0) AS bytes
               FROM events
              WHERE type IN (${placeholders}) AND occurred_at < ?`,
        )
        .get(...TELEMETRY_EVENT_TYPES, cutoff) as { rows: number; bytes: number };

    return {
        rows: current.rows,
        bytes: current.bytes,
        retentionDays,
        prunableRows: prunable.rows,
        prunableBytes: prunable.bytes,
    };
}

/** Row counts for every table, biggest first. Cheap and often enough. */
function listTableRowCounts(db: Db): TableStat[] {
    const names = db
        .prepare(
            `SELECT name FROM sqlite_master
              WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
              ORDER BY name`,
        )
        .all() as Array<{ name: string }>;
    const stats: TableStat[] = [];
    for (const { name } of names) {
        try {
            const row = db
                .prepare(`SELECT COUNT(*) AS rows FROM "${name}"`)
                .get() as { rows: number };
            stats.push({ name, rows: row.rows });
        } catch {
            // A table the current schema cannot read is still worth
            // listing as present rather than silently omitting.
            stats.push({ name, rows: -1 });
        }
    }
    return stats.sort((a, b) => b.rows - a.rows);
}

const MB = 1024 * 1024;
const mb = (n: number): string => (n / MB).toFixed(1);
const pct = (ratio: number): string => (ratio * 100).toFixed(1);

/** ISO day for a ms epoch, or `—` when there is nothing to date. */
const day = (at: number | null): string =>
    (at === null || !Number.isFinite(at)
        ? '—'
        : new Date(at).toISOString().slice(0, 10));

export function formatDbReport(report: DbReport): string {
    const lines: string[] = [];
    lines.push(`db-report: ${report.dbPath}`);
    lines.push('');
    lines.push('--- file ---');
    lines.push(`  file            ${mb(report.fileBytes)} MB`);
    lines.push(`  wal sidecar     ${mb(report.walBytes)} MB`);
    lines.push(
        `  pages           ${report.pageCount} x ${report.pageSize} B`,
    );
    lines.push(
        `  free pages      ${mb(report.freeBytes)} MB`
        + ` (${pct(report.freeRatio)}% of the file)`,
    );
    // The verdict, because the numbers above have one actionable reading
    // and it should not be left as an exercise.
    lines.push(
        report.freeRatio >= VACUUM_WORTH_IT_RATIO
            ? `  => mostly slack: "npm run vacuum:db" (worker stopped) returns`
                + ` ~${mb(report.freeBytes)} MB to the OS`
            : '  => the file is mostly live data, not reclaimable slack',
    );
    lines.push('');
    lines.push('--- events ---');
    lines.push(`  rows            ${report.eventRows}`);
    lines.push(`  payload         ${mb(report.payloadBytes)} MB`);
    lines.push(
        `  span            ${day(report.oldestEventAt)}`
        + ` .. ${day(report.newestEventAt)}`,
    );
    lines.push('');
    lines.push('--- payload bytes by event type ---');
    lines.push(
        `  ${'MB'.padStart(9)}  ${'rows'.padStart(9)}`
        + `  ${'avg KB'.padStart(8)}  ${'max KB'.padStart(8)}  type`,
    );
    for (const stat of report.byType) {
        const avgKb = stat.rows > 0 ? stat.bytes / 1024 / stat.rows : 0;
        lines.push(
            `  ${mb(stat.bytes).padStart(9)}  ${String(stat.rows).padStart(9)}`
            + `  ${avgKb.toFixed(1).padStart(8)}`
            + `  ${(stat.maxBytes / 1024).toFixed(1).padStart(8)}  ${stat.type}`,
        );
    }
    if (report.otherTypes.types > 0) {
        lines.push(
            `  ${mb(report.otherTypes.bytes).padStart(9)}`
            + `  ${String(report.otherTypes.rows).padStart(9)}`
            + `  ${''.padStart(8)}  ${''.padStart(8)}`
            + `  (+${report.otherTypes.types} smaller types)`,
        );
    }
    lines.push('');
    lines.push('--- streaming telemetry (nothing replays it) ---');
    lines.push(
        `  in the log      ${report.telemetry.rows} rows,`
        + ` ${mb(report.telemetry.bytes)} MB`,
    );
    if (report.telemetry.retentionDays <= 0) {
        lines.push(
            '  retention       DISABLED'
            + ' (PIPELINE_TELEMETRY_RETENTION_DAYS=0) — nothing is ever pruned',
        );
    } else {
        lines.push(`  retention       ${report.telemetry.retentionDays} days`);
        lines.push(
            `  => a worker restart would delete ${report.telemetry.prunableRows}`
            + ` rows (~${mb(report.telemetry.prunableBytes)} MB of payload).`,
        );
        if (report.telemetry.prunableRows > 0) {
            // The prune only runs at boot, so a long-uptime worker holds
            // telemetry far past its window. Say so where it is visible.
            lines.push(
                '     The prune runs at BOOT ONLY, so this is what uptime has'
                + ' accumulated past the window.',
            );
        }
    }
    lines.push('');
    lines.push('--- table row counts ---');
    for (const table of report.tables) {
        if (table.rows === 0) continue;
        const count = table.rows < 0 ? 'unreadable' : String(table.rows);
        lines.push(`  ${count.padStart(10)}  ${table.name}`);
    }
    return lines.join('\n');
}
