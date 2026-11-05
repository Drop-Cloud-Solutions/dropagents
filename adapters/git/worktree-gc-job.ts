/**
 * Adapter: scheduled worktree-gc subscriber.
 *
 * A registration shim around {@link WorktreeManager.gcStale}. The job
 * ticks every 6 hours (override with `WORKTREE_GC_TICK_HOURS`) and asks
 * the manager to prune any worktree whose owning task is terminal AND
 * whose mtime is older than the manager's idle threshold. Active-task
 * worktrees are skipped inside `gcStale` via the manager's
 * `TaskStateLookup.isTerminal` check — this module never re-implements
 * the staleness rule.
 *
 * Mirrors `adapters/storage/snapshot-job.ts` registration shape:
 *
 *   register(eventBus, dependency, logger, options) -> { runOnce, stop }
 *
 *   - `eventBus` is accepted for parity with other subscriber
 *     registrations even though the job drives cadence via an interval
 *     rather than reacting to a specific event.
 *   - The recurring timer is `.unref()`'d so it never keeps the process
 *     alive on its own (AC #3).
 *   - Failures inside the cycle are caught and routed through
 *     {@link Logger} — a broken gc cycle must never crash the
 *     orchestrator and the next tick still fires (AC #5).
 *   - `runOnStart` (default `true`) fires one cycle immediately on
 *     registration so a freshly-rebooted host immediately catches up.
 */

import type { EventBus } from '../../core/events/bus';
import type { Logger } from '../../core/ports/Logger';
import type { WorktreeManager } from './worktree-manager';

export const WORKTREE_GC_JOB_SUBSCRIBER = 'worktree-gc-job';

const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_TICK_HOURS = 6;
const DEFAULT_TICK_MS = DEFAULT_TICK_HOURS * HOUR_MS;

export interface WorktreeGcJobOptions {
    /**
     * Tick period in milliseconds. Defaults to `WORKTREE_GC_TICK_HOURS`
     * (env, in hours) or 6h when unset/invalid.
     */
    readonly tickIntervalMs?: number;
    /** Run one cycle immediately on register. Defaults to true. */
    readonly runOnStart?: boolean;
    /** Start the recurring timer. Defaults to true; tests pass false. */
    readonly startTimer?: boolean;
}

export interface WorktreeGcJobHandle {
    /** Run one gc cycle. Never throws — failures are logged. */
    runOnce(): Promise<{ pruned: string[] }>;
    /** Cancel the recurring timer. Idempotent. */
    stop(): void;
}

/**
 * Register the worktree-gc job. The `eventBus` parameter is taken to
 * match the subscriber-registration convention used by sibling
 * scheduled subscribers (e.g. snapshot-job); the job itself drives
 * cadence via an internal interval rather than reacting to a specific
 * event type.
 */
export function register(
    eventBus: EventBus,
    manager: WorktreeManager,
    logger: Logger,
    options: WorktreeGcJobOptions = {},
): WorktreeGcJobHandle {
    void eventBus;

    const tickIntervalMs = options.tickIntervalMs ?? readTickEnv();
    const runOnStart = options.runOnStart ?? true;
    const startTimer = options.startTimer ?? true;

    const runOnce = async (): Promise<{ pruned: string[] }> => {
        try {
            const result = await manager.gcStale();
            if (result.pruned.length > 0) {
                logger.info('worktree-gc-job: cycle pruned worktrees', {
                    prunedCount: result.pruned.length,
                    pruned: result.pruned,
                });
            }
            return result;
        } catch (err) {
            logger.error('worktree-gc-job: cycle failed', {
                error: err instanceof Error ? err.message : String(err),
            });
            return { pruned: [] };
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
        // Fire-and-forget so register() stays synchronous for the host
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

function readTickEnv(): number {
    const raw = process.env.WORKTREE_GC_TICK_HOURS;
    if (raw === undefined) return DEFAULT_TICK_MS;
    const trimmed = raw.trim();
    if (trimmed === '') return DEFAULT_TICK_MS;
    const hours = Number.parseFloat(trimmed);
    if (!Number.isFinite(hours) || hours <= 0) return DEFAULT_TICK_MS;
    return Math.round(hours * HOUR_MS);
}
