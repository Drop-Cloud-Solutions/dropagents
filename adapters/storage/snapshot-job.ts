/**
 * Adapter: daily SQLite snapshot subscriber.
 *
 * On a daily tick the job runs `VACUUM INTO 'shared/.cache/snapshots/
 * state-YYYY-MM-DD.db'` against the primary state DB and then prunes the
 * snapshots directory down to the most recent `SNAPSHOT_RETAIN` files
 * (default 7). The job is registered as a subscriber on host startup and
 * fires its first cycle on registration; subsequent cycles run on a
 * 24-hour `setInterval`. The interval handle is `.unref()`'d so it never
 * keeps the process alive on its own.
 *
 * Failures inside the job are caught and logged through the {@link Logger}
 * port — a broken snapshot run must never crash the orchestrator (AC #6).
 *
 * `VACUUM INTO` refuses to overwrite an existing file. If today's snapshot
 * is already on disk the job logs and skips the write rather than crashing
 * (AC #3).
 */

import * as fs from 'fs';
import * as path from 'path';

import type { Db } from '../../core/state/migrations';
import type { EventBus } from '../../core/events/bus';
import type { Logger } from '../../core/ports/Logger';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_SNAPSHOTS_DIR = path.join(REPO_ROOT, 'shared', '.cache', 'snapshots');
const DEFAULT_RETAIN = 7;
const DEFAULT_TICK_MS = 24 * 60 * 60 * 1000;
const SNAPSHOT_FILE_RE = /^state-(\d{4}-\d{2}-\d{2})\.db$/;

export const SNAPSHOT_JOB_SUBSCRIBER = 'snapshot-job';

export interface SnapshotJobOptions {
    /** Override the snapshots target directory. Defaults to `shared/.cache/snapshots/`. */
    readonly snapshotsDir?: string;
    /** Retention count. Defaults to env `SNAPSHOT_RETAIN` or 7. */
    readonly retain?: number;
    /** Clock override for tests. Defaults to `() => new Date()`. */
    readonly now?: () => Date;
    /** Tick period in milliseconds. Defaults to 24h. */
    readonly tickIntervalMs?: number;
    /** Run a cycle immediately on register. Defaults to true. */
    readonly runOnStart?: boolean;
    /** Start the recurring timer. Defaults to true; tests pass false. */
    readonly startTimer?: boolean;
}

export interface SnapshotJobHandle {
    /** Run a single snapshot cycle synchronously-as-possible. Never throws. */
    runOnce(): Promise<void>;
    /** Cancel the recurring timer. Idempotent. */
    stop(): void;
}

/**
 * Register the snapshot job. The `eventBus` parameter is taken to match the
 * subscriber-registration convention used elsewhere in the host — the job
 * itself drives cadence via an internal interval rather than reacting to a
 * specific event type.
 */
export function register(
    eventBus: EventBus,
    store: Db,
    logger: Logger,
    options: SnapshotJobOptions = {},
): SnapshotJobHandle {
    void eventBus;

    const snapshotsDir = options.snapshotsDir ?? DEFAULT_SNAPSHOTS_DIR;
    const retain = options.retain ?? readRetainEnv();
    const now = options.now ?? ((): Date => new Date());
    const tickIntervalMs = options.tickIntervalMs ?? DEFAULT_TICK_MS;
    const runOnStart = options.runOnStart ?? true;
    const startTimer = options.startTimer ?? true;

    const runOnce = async (): Promise<void> => {
        try {
            fs.mkdirSync(snapshotsDir, { recursive: true });
            const stamp = dateStamp(now());
            const target = path.join(snapshotsDir, `state-${stamp}.db`);

            if (fs.existsSync(target)) {
                logger.info('snapshot-job: snapshot for today already exists, skipping', {
                    target,
                });
            } else {
                store.exec(`VACUUM INTO '${escapeSqlLiteral(target)}'`);
                logger.info('snapshot-job: snapshot written', { target });
            }

            prune(snapshotsDir, retain, logger);
        } catch (err) {
            logger.error('snapshot-job: cycle failed', {
                error: err instanceof Error ? err.message : String(err),
            });
        }
    };

    let timer: NodeJS.Timeout | undefined;
    if (startTimer) {
        timer = setInterval(() => {
            void runOnce();
        }, tickIntervalMs);
        if (typeof timer.unref === 'function') timer.unref();
    }

    if (runOnStart) {
        // Fire-and-forget: register() must remain synchronous for the host
        // wiring path. Errors are swallowed inside runOnce.
        void runOnce();
    }

    return {
        runOnce,
        stop(): void {
            if (timer !== undefined) {
                clearInterval(timer);
                timer = undefined;
            }
        },
    };
}

function readRetainEnv(): number {
    const raw = process.env.SNAPSHOT_RETAIN;
    if (raw === undefined) return DEFAULT_RETAIN;
    const trimmed = raw.trim();
    if (trimmed === '') return DEFAULT_RETAIN;
    const n = Number.parseInt(trimmed, 10);
    if (!Number.isFinite(n) || n < 1) return DEFAULT_RETAIN;
    return n;
}

function dateStamp(d: Date): string {
    const yyyy = d.getUTCFullYear().toString().padStart(4, '0');
    const mm = (d.getUTCMonth() + 1).toString().padStart(2, '0');
    const dd = d.getUTCDate().toString().padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
}

function escapeSqlLiteral(s: string): string {
    return s.replace(/'/g, "''");
}

function prune(dir: string, retain: number, logger: Logger): void {
    if (!fs.existsSync(dir)) return;
    // Sort by mtime ascending so the oldest-on-disk snapshots are pruned
    // first regardless of what their filename date stamp claims. Filename
    // and mtime usually agree, but a re-copied or backfilled snapshot can
    // have a recent mtime with an old date stamp — pruning by stamp would
    // delete a fresh file in that case.
    const stamped = fs
        .readdirSync(dir)
        .map((name) => {
            if (!SNAPSHOT_FILE_RE.test(name)) return null;
            try {
                const mtimeMs = fs.statSync(path.join(dir, name)).mtimeMs;
                return { name, mtimeMs };
            } catch {
                return null;
            }
        })
        .filter((e): e is { name: string; mtimeMs: number } => e !== null)
        .sort((a, b) => a.mtimeMs - b.mtimeMs);

    if (stamped.length <= retain) return;
    const toDelete = stamped.slice(0, stamped.length - retain);
    for (const e of toDelete) {
        try {
            fs.unlinkSync(path.join(dir, e.name));
            logger.info('snapshot-job: pruned old snapshot', { file: e.name });
        } catch (err) {
            logger.warn('snapshot-job: prune failed', {
                file: e.name,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }
}
