/**
 * Worker-api read-only route for the in-flight decomposer roster.
 *
 * `GET /api/active-decomposers`
 *   Returns one entry per decomposer agent run that has started but
 *   not yet emitted a terminal `AgentFinished` / `AgentFailed`. The
 *   operator board hits this on boot so the decomposer card stays on
 *   screen across a page reload while the underlying child process
 *   keeps running.
 *
 * Source of truth is the event log: `AgentStarted` events stamp the
 * spawn (with `metadata.kind === 'decomposer'`), and
 * `AgentFinished` / `AgentFailed` events terminate the run with the
 * same `agentId`. Pairing the two sets yields the active roster
 * without a separate projection table — decomposer runs are
 * low-frequency, so a one-time scan on boot is cheap.
 *
 * A run held on a `NEEDS_HUMAN_INPUT` question is active too, and the
 * pairing above would drop it: the agent DID emit a clean `AgentFinished`
 * — it finished by asking. So `PlanDecomposeQuestionRaised` /
 * `PlanDecomposeQuestionAnswered` / `PlanDecomposeQuestionAbandoned` are
 * folded as a second, overriding pass:
 * a plan whose newest question event is a raise comes back with
 * `status: 'awaiting'` and the question, so the reloaded board can paint
 * the Answer button instead of losing the card and the operator's cue.
 *
 * Response shape mirrors the in-memory `ActiveDecomposer` row the
 * board's `applyDecomposerEvent` reducer maintains, so the hydration
 * path can copy each entry straight onto the map.
 */

import * as http from 'node:http';

import type { Db } from '../../../core/state/migrations';
import type { Logger } from '../../../core/ports/Logger';

export const ACTIVE_DECOMPOSERS_ROUTE_PATTERN = /^\/api\/active-decomposers\/?$/;

/**
 * Wire shape of one entry in the `GET /api/active-decomposers` response.
 * Matches the fields {@link import('../../board-ui/board').ActiveDecomposer}
 * needs to render a card with the lifecycle metadata.
 */
export interface ActiveDecomposerRecord {
    readonly planId: string;
    readonly projectId: string;
    readonly agentId: string;
    readonly startedAt: number;
    /**
     * `'running'` (the agent process is alive) or `'awaiting'` (it finished
     * by asking the operator a question and the answer is outstanding).
     * Absent in older payloads; the board treats a missing value as
     * `'running'` so an upgrade in either direction stays coherent.
     */
    readonly status?: 'running' | 'awaiting';
    /** Set on `status: 'awaiting'` — the question to render. */
    readonly question?: string;
    /** Enumerated option labels, when the agent offered any. */
    readonly options?: readonly string[];
    /** Set on `status: 'awaiting'` — when the question was asked. */
    readonly askedAt?: number;
}

interface EventRow {
    type: string;
    occurred_at: number;
    payload: string;
}

export interface ActiveDecomposersDeps {
    readonly db: Db;
    readonly logger?: Logger;
}

export interface ActiveDecomposersRouter {
    handle(req: http.IncomingMessage, res: http.ServerResponse): boolean;
}

export function createActiveDecomposersRouter(
    deps: ActiveDecomposersDeps,
): ActiveDecomposersRouter {
    // Single scan covers both halves of the join: the started events
    // give us candidate runs, the terminal events tell us which to drop.
    const stmt = deps.db.prepare(
        `SELECT type, occurred_at, payload
           FROM events
          WHERE type IN ('AgentStarted', 'AgentFinished', 'AgentFailed',
                         'PlanDecomposeQuestionRaised',
                         'PlanDecomposeQuestionAnswered',
                         'PlanDecomposeQuestionAbandoned')
          ORDER BY seq ASC`,
    );

    return {
        handle(req, res): boolean {
            const url = req.url ?? '/';
            const pathname = url.split('?', 1)[0];
            if (!ACTIVE_DECOMPOSERS_ROUTE_PATTERN.test(pathname)) return false;

            const method = req.method ?? 'GET';
            if (method !== 'GET') {
                respond(res, 405, { error: 'method not allowed' }, { Allow: 'GET' });
                return true;
            }

            try {
                const rows = stmt.all() as EventRow[];
                const decomposers = foldRowsToActiveDecomposers(rows);
                respond(res, 200, { decomposers });
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                deps.logger?.error('active-decomposers: list failed', { error: message });
                respond(res, 500, { error: 'active-decomposers list failed', message });
            }
            return true;
        },
    };
}

/**
 * Pure fold over event rows. Four passes:
 *   1. Collect terminated agentIds from AgentFinished + AgentFailed.
 *   2. Remember the LAST decomposer AgentStarted per planId (whether or
 *      not it terminated) — an awaiting run needs its agentId to open the
 *      Show-agent modal, and its agent has by definition already finished.
 *   3. Emit one `running` record per non-terminated AgentStarted.
 *   4. Overlay the question state: a plan whose last question event is a
 *      raise is `awaiting`, and that wins over any running entry (the raise
 *      always follows that run's AgentFinished). An answered plan drops back
 *      out — its re-spawn arrives as a fresh AgentStarted in pass 3.
 *
 * Exported for unit testing.
 */
export function foldRowsToActiveDecomposers(
    rows: ReadonlyArray<EventRow>,
): ActiveDecomposerRecord[] {
    const terminated = new Set<string>();
    for (const row of rows) {
        if (row.type !== 'AgentFinished' && row.type !== 'AgentFailed') continue;
        const payload = safeParse(row.payload);
        if (!payload) continue;
        const agentId = readString(payload, 'agentId');
        if (agentId) terminated.add(agentId);
    }

    // Keep the most recent active run per planId — if the orchestrator
    // re-spawned the decomposer (rare but possible on retry), the older
    // run is dead even if its terminal event somehow never landed.
    const byPlanId = new Map<string, ActiveDecomposerRecord>();
    const lastSpawnByPlanId = new Map<
        string,
        { agentId: string; projectId: string; startedAt: number }
    >();
    for (const row of rows) {
        if (row.type !== 'AgentStarted') continue;
        const payload = safeParse(row.payload);
        if (!payload) continue;
        const md = payload.metadata;
        if (!md || typeof md !== 'object') continue;
        const meta = md as Record<string, unknown>;
        if (meta.kind !== 'decomposer') continue;
        const planId = readString(meta, 'planId');
        const projectId = readString(meta, 'projectId');
        const agentId = readString(payload, 'agentId');
        if (!planId || !agentId) continue;
        lastSpawnByPlanId.set(planId, {
            agentId,
            projectId: projectId ?? '',
            startedAt: row.occurred_at,
        });
        if (terminated.has(agentId)) continue;
        byPlanId.set(planId, {
            planId,
            projectId: projectId ?? '',
            agentId,
            startedAt: row.occurred_at,
            status: 'running',
        });
    }

    // Last question event per plan. A raise with nothing after it means
    // the operator still owes an answer; an answer OR an abandon
    // settles it.
    //
    // Abandoning has to be in this pass, not just in the live SSE fold.
    // Without it a reload re-derived `awaiting` from the raise and the
    // question came back — which is the literal symptom the operator
    // reported ("the question keeps coming back"), and it would have
    // survived the fix everywhere else.
    const pendingQuestions = new Map<
        string,
        { question: string; options: string[]; askedAt: number; projectId: string } | null
    >();
    for (const row of rows) {
        if (
            row.type !== 'PlanDecomposeQuestionRaised'
            && row.type !== 'PlanDecomposeQuestionAnswered'
            && row.type !== 'PlanDecomposeQuestionAbandoned'
        ) continue;
        const payload = safeParse(row.payload);
        if (!payload) continue;
        const planId = readString(payload, 'planId');
        if (!planId) continue;
        if (
            row.type === 'PlanDecomposeQuestionAnswered'
            || row.type === 'PlanDecomposeQuestionAbandoned'
        ) {
            pendingQuestions.set(planId, null);
            continue;
        }
        const question = readString(payload, 'question');
        if (!question) continue;
        pendingQuestions.set(planId, {
            question,
            options: readOptionLabels(payload.options),
            askedAt: typeof payload.askedAt === 'number' ? payload.askedAt : row.occurred_at,
            projectId: readString(payload, 'projectId') ?? '',
        });
    }

    for (const [planId, pending] of pendingQuestions) {
        if (pending === null) continue;
        const spawn = lastSpawnByPlanId.get(planId);
        byPlanId.set(planId, {
            planId,
            projectId: pending.projectId || spawn?.projectId || '',
            // No spawn row means the AgentStarted has aged out of whatever
            // window we scanned; the card is still worth painting — the
            // question is the point — so fall back to a synthetic id rather
            // than dropping the operator's cue on the floor.
            agentId: spawn?.agentId ?? `plan:${planId}`,
            startedAt: spawn?.startedAt ?? pending.askedAt,
            status: 'awaiting',
            question: pending.question,
            ...(pending.options.length > 0 ? { options: pending.options } : {}),
            askedAt: pending.askedAt,
        });
    }

    return Array.from(byPlanId.values()).sort((a, b) => a.startedAt - b.startedAt);
}

/**
 * Options ride the event as `{key,label}` objects. The board's Answer modal
 * renders plain strings, so flatten to `"A) label"` — the operator picks a
 * radio and the agent gets back a sentence it can act on rather than a bare
 * letter it has to re-resolve.
 */
function readOptionLabels(raw: unknown): string[] {
    if (!Array.isArray(raw)) return [];
    const out: string[] = [];
    for (const entry of raw) {
        if (!entry || typeof entry !== 'object') continue;
        const o = entry as Record<string, unknown>;
        const label = typeof o.label === 'string' ? o.label.trim() : '';
        if (label.length === 0) continue;
        const key = typeof o.key === 'string' ? o.key.trim() : '';
        out.push(key.length > 0 ? `${key}) ${label}` : label);
    }
    return out;
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

function readString(
    obj: Record<string, unknown>,
    key: string,
): string | null {
    const v = obj[key];
    return typeof v === 'string' && v.length > 0 ? v : null;
}

function respond(
    res: http.ServerResponse,
    status: number,
    body: unknown,
    extraHeaders: Readonly<Record<string, string>> = {},
): void {
    res.writeHead(status, {
        'Content-Type': 'application/json',
        ...extraHeaders,
    });
    res.end(JSON.stringify(body));
}
