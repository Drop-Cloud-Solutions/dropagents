/**
 * Chat retention — drop sessions nobody has touched in a while.
 *
 * Chat sessions accumulate forever: every board question, every Telegram
 * turn, every plan/requirement side-pane conversation mints one and
 * nothing ever removed them. The sidebar grows unusable and their
 * messages are the bulkiest rows in the state DB after agent telemetry.
 *
 * A session is "inactive" by `updated_at`, which every turn bumps — so a
 * long-running conversation is safe no matter how old it is; only ones
 * genuinely untouched for the retention window are removed.
 *
 * Deletion goes through the SAME path the operator's Delete button uses:
 * a `scratch-edit` session's git worktree is torn down BEFORE its row is
 * dropped, or the branch would leak on disk with nothing pointing at it.
 *
 * Env knobs (documented in `.env.example`):
 *   PIPELINE_CHAT_RETENTION_DAYS   days to keep (default 14; 0 disables)
 *   PIPELINE_CHAT_RETENTION_HOURS  hours between sweeps (default 24)
 */
import type { Logger } from '../../core/ports/Logger';

/** The shape retention needs from a chat session row. */
export interface RetentionSession {
    readonly id: string;
    readonly updatedAt: number;
}

export interface ChatRetentionDeps {
    /** Every session the store holds (id + updatedAt is enough). */
    readonly listSessions: () => readonly RetentionSession[];
    /**
     * Delete one session. Wired to the same teardown-then-delete path the
     * DELETE route uses so scratch worktrees do not leak.
     */
    readonly deleteSession: (id: string) => Promise<void>;
    readonly retentionDays: number;
    readonly clock: () => number;
    readonly logger?: Logger;
}

export interface ChatRetentionJob {
    /** Run one sweep now. Returns the ids removed. */
    sweep(): Promise<string[]>;
    /** Start the periodic sweep (also runs one immediately). */
    start(intervalMs: number): void;
    stop(): void;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Sessions whose `updatedAt` is older than the cutoff. Pure. */
export function selectExpiredSessions(
    sessions: readonly RetentionSession[],
    cutoff: number,
): string[] {
    return sessions.filter((s) => s.updatedAt < cutoff).map((s) => s.id);
}

export function createChatRetentionJob(deps: ChatRetentionDeps): ChatRetentionJob {
    let timer: ReturnType<typeof setInterval> | null = null;
    const enabled = Number.isFinite(deps.retentionDays) && deps.retentionDays > 0;

    const sweep = async (): Promise<string[]> => {
        if (!enabled) return [];
        const cutoff = deps.clock() - deps.retentionDays * DAY_MS;
        let expired: string[];
        try {
            expired = selectExpiredSessions(deps.listSessions(), cutoff);
        } catch (err) {
            deps.logger?.warn('chat-retention: could not list sessions', {
                error: err instanceof Error ? err.message : String(err),
            });
            return [];
        }
        const removed: string[] = [];
        for (const id of expired) {
            try {
                await deps.deleteSession(id);
                removed.push(id);
            } catch (err) {
                // One bad session must not abort the sweep.
                deps.logger?.warn('chat-retention: delete failed', {
                    sessionId: id,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        }
        if (removed.length > 0) {
            deps.logger?.info('chat-retention: removed inactive chat sessions', {
                removed: removed.length,
                retentionDays: deps.retentionDays,
                cutoff,
            });
        }
        return removed;
    };

    return {
        sweep,
        start(intervalMs: number): void {
            if (!enabled) {
                deps.logger?.info('chat-retention: disabled (retention days <= 0)');
                return;
            }
            if (timer !== null) return;
            void sweep();
            timer = setInterval(() => void sweep(), intervalMs);
            // Never hold the process open for a housekeeping timer.
            (timer as unknown as { unref?: () => void }).unref?.();
        },
        stop(): void {
            if (timer === null) return;
            clearInterval(timer);
            timer = null;
        },
    };
}

/** `PIPELINE_CHAT_RETENTION_DAYS` (default 14, `0` disables). */
export function resolveChatRetentionDays(env: NodeJS.ProcessEnv): number {
    const raw = env.PIPELINE_CHAT_RETENTION_DAYS;
    if (raw === undefined || raw.trim().length === 0) return 14;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 14;
}

/** `PIPELINE_CHAT_RETENTION_HOURS` (default 24 — a daily sweep). */
export function resolveChatRetentionIntervalMs(env: NodeJS.ProcessEnv): number {
    const raw = env.PIPELINE_CHAT_RETENTION_HOURS;
    const parsed = raw === undefined ? NaN : Number(raw);
    const hours = Number.isFinite(parsed) && parsed > 0 ? parsed : 24;
    return hours * 60 * 60 * 1000;
}
