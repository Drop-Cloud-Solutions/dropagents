/**
 * Server-side chat progress narrator.
 *
 * Subscribes to the orchestrator's event bus and, for any event whose
 * plan/task is linked to a chat session (chat_plan_links), appends a
 * `system` progress note directly to chat_messages — independent of
 * whether a board tab is open. This makes narration complete: a task
 * that finishes overnight is recorded so the operator sees the full
 * history when they next open the chat.
 *
 * It replaces the browser-driven note posting (the board used to POST
 * notes from its SSE loop, which only worked while a tab was open).
 * After appending a note the generator publishes a lightweight
 * `ChatNoteAppended` event so an open board can reload the thread.
 *
 * Delivery model: `subscribeAll` is live-only and anonymous — each
 * event is seen once, with no replay on restart. That avoids duplicate
 * notes across restarts at the cost of missing narration for events
 * that fired while the worker was down (acceptable: the board still
 * reflects real task state; only the chat narration has a gap). An
 * in-process `reported` set guards against the rare same-run duplicate
 * (e.g. a re-published TaskCreated carrying the same idempotency key).
 */

import type Database from 'better-sqlite3';

import type { EventBus } from '../../core/events/bus';
import type { Event, StoredEvent } from '../../core/events/event';
import type { Logger } from '../../core/ports/Logger';
import type { SqliteChatSessionStore } from '../../adapters/state/SqliteChatSessionStore';

export const CHAT_NOTE_APPENDED_EVENT = 'ChatNoteAppended';

export interface ChatNoteGeneratorDeps {
    readonly bus: EventBus;
    readonly db: Database.Database;
    readonly store: SqliteChatSessionStore;
    readonly clock: () => number;
    readonly logger?: Logger;
}

/** A milestone resolved from an event: the note text + optional action. */
export interface Milestone {
    /** Stable per-(session) key so the same milestone isn't posted twice. */
    readonly key: string;
    readonly line: string;
    readonly action?: { kind: 'merge' | 'approve'; taskId: string; label: string };
}

/**
 * Wire the narrator onto the bus. Returns an unsubscribe function.
 */
export function attachChatNoteGenerator(deps: ChatNoteGeneratorDeps): () => void {
    const reported = new Set<string>();
    const taskPlanStmt = deps.db.prepare('SELECT plan_id FROM tasks WHERE id = ?');

    const resolvePlanId = (payload: Record<string, unknown>): string | null => {
        if (typeof payload.planId === 'string' && payload.planId.length > 0) {
            return payload.planId;
        }
        const taskId = typeof payload.taskId === 'string' ? payload.taskId : '';
        if (taskId.length === 0) return null;
        const row = taskPlanStmt.get(taskId) as { plan_id?: string } | undefined;
        return typeof row?.plan_id === 'string' ? row.plan_id : null;
    };

    const handler = async (event: StoredEvent): Promise<void> => {
        const milestone = milestoneFor(event);
        if (milestone === null) return;
        const payload = (event.payload ?? {}) as Record<string, unknown>;
        const planId = resolvePlanId(payload);
        if (planId === null) return;
        const sessionId = deps.store.sessionForPlan(planId);
        if (sessionId === null) return;

        const dedupeKey = `${sessionId}:${milestone.key}`;
        if (reported.has(dedupeKey)) return;
        reported.add(dedupeKey);

        const now = deps.clock();
        deps.store.appendMessage({
            sessionId,
            role: 'system',
            body: milestone.line,
            now,
            ...(milestone.action !== undefined
                ? { metadata: { action: milestone.action } }
                : {}),
        });

        // Ping any open board so it reloads the thread. Keyed on the
        // triggering event's seq so a replayed trigger (shouldn't happen
        // with subscribeAll, but belt-and-braces) dedups at the store.
        const ping: Event = {
            type: CHAT_NOTE_APPENDED_EVENT,
            v: 1,
            occurredAt: now,
            idempotencyKey: `chat-note:${sessionId}:${event.seq}`,
            payload: { sessionId },
        };
        try {
            await deps.bus.publish(ping);
        } catch (err) {
            deps.logger?.warn('chat-note-generator: ping publish failed', {
                sessionId,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    };

    return deps.bus.subscribeAll((event) => {
        void handler(event).catch((err) => {
            deps.logger?.warn('chat-note-generator: handler threw', {
                type: event.type,
                error: err instanceof Error ? err.message : String(err),
            });
        });
    });
}

/**
 * Map a domain event to a chat milestone, or null when the event isn't
 * a narratable milestone. Mirrors the vocabulary the board used to post
 * client-side.
 */
export function milestoneFor(event: StoredEvent): Milestone | null {
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    const taskId = typeof payload.taskId === 'string' ? payload.taskId : '';
    const planId = typeof payload.planId === 'string' ? payload.planId : '';

    switch (event.type) {
        case 'PlanGenerated':
            if (planId.length === 0) return null;
            return {
                key: `plan-generated:${planId}`,
                line: '📋 Planner finished. Open the plan on the board to decompose it into tasks.',
            };
        case 'TaskCreated':
            if (taskId.length === 0) return null;
            return { key: `task-created:${taskId}`, line: `🧩 Task ${taskId} created.` };
        case 'AgentStarted': {
            const md = (payload.metadata ?? {}) as Record<string, unknown>;
            const stepId = typeof md.stepId === 'string' ? md.stepId : '';
            const role = typeof payload.role === 'string' ? payload.role : 'agent';
            if (taskId.length === 0 || stepId.length === 0) return null;
            return {
                key: `agent:${taskId}:${stepId}`,
                line: `▶️ ${role} started on ${taskId}.`,
            };
        }
        case 'TaskParked': {
            const reason = typeof payload.reason === 'string' ? payload.reason : '';
            if (taskId.length === 0) return null;
            if (reason === 'worktree-diff-review') {
                return {
                    key: `parked:${taskId}:review`,
                    line: `✋ ${taskId} is ready for your review — open it on the board to review the changes, then approve or request changes.`,
                };
            }
            if (reason === 'wait-merged') {
                return {
                    key: `parked:${taskId}:merge`,
                    line: `🔀 ${taskId} is ready to merge.`,
                    action: { kind: 'merge', taskId, label: 'Merge PR' },
                };
            }
            if (reason === 'approval') {
                return {
                    key: `parked:${taskId}:approval`,
                    line: `⏸ ${taskId} is waiting for approval to start.`,
                    action: { kind: 'approve', taskId, label: 'Approve' },
                };
            }
            return null;
        }
        case 'TaskFinished':
            if (taskId.length === 0) return null;
            return { key: `finished:${taskId}`, line: `✅ ${taskId} finished.` };
        case 'TaskFailed':
            if (taskId.length === 0) return null;
            return {
                key: `failed:${taskId}`,
                line: `❌ ${taskId} failed — check the board for details.`,
            };
        default:
            return null;
    }
}
