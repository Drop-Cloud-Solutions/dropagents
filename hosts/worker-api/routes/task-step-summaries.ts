/**
 * Worker-api read-only route for the per-step agent run records.
 *
 * `GET /api/tasks/:taskId/step-summaries`
 *   Returns every `task_step_summaries` row for the given taskId, in
 *   started_at order. The operator board's stage-bar uses this to
 *   colour the chips (running → amber, complete → green, failed → red,
 *   future → blue) and to populate the per-stage summary modal the
 *   operator opens by clicking a chip.
 *
 * The rows are written by the orchestrator's task-projection
 * subscribers — see `attachTaskProjection` in
 * `hosts/orchestrator/main.ts`. The summary field carries the joined
 * `AgentProgress.chunk` text emitted during the agent's run.
 */

import * as http from 'node:http';

import type { Db } from '../../../core/state/migrations';
import type { Logger } from '../../../core/ports/Logger';

export const TASK_STEP_SUMMARIES_ROUTE_PATTERN =
    /^\/api\/tasks\/([^/]+)\/step-summaries\/?$/;

export interface StepSummaryRecord {
    readonly stepId: string;
    readonly role: string | null;
    readonly status: 'running' | 'complete' | 'failed';
    readonly startedAt: number;
    readonly finishedAt: number | null;
    readonly summary: string | null;
    /**
     * The LIVE agent handle driving this step, when it is still
     * running. Absent for a finished step, and for a running one whose
     * agent the orchestrator no longer has mapped.
     *
     * Not persisted - it is read from the orchestrator's live
     * agent-to-task map at request time. The board needs it because
     * the activity stream is not persisted either: after a reload the
     * board knows a step is running but not WHICH run, and Stop agent
     * is addressed by run id.
     */
    readonly agentId?: string;
}

interface StepSummaryRow {
    step_id: string;
    role: string | null;
    status: string;
    started_at: number;
    finished_at: number | null;
    summary: string | null;
}

export interface TaskStepSummariesDeps {
    readonly db: Db;
    readonly logger?: Logger;
    /**
     * The live agent handle a task is currently driving, if any.
     * Wired to `Orchestrator.getAgentForTask`, which inverts the
     * agent-to-task map the engine bridges already maintain.
     *
     * Optional: without it a running step simply reports no agentId,
     * which is the behaviour this route had all along.
     */
    readonly agentForTask?: (taskId: string) => string | undefined;
}

export interface TaskStepSummariesRouter {
    handle(req: http.IncomingMessage, res: http.ServerResponse): boolean;
}

export function createTaskStepSummariesRouter(
    deps: TaskStepSummariesDeps,
): TaskStepSummariesRouter {
    const stmt = deps.db.prepare(
        `SELECT step_id, role, status, started_at, finished_at, summary
           FROM task_step_summaries
          WHERE task_id = ?
          ORDER BY started_at ASC`,
    );

    return {
        handle(req, res): boolean {
            const url = req.url ?? '/';
            const pathname = url.split('?', 1)[0];
            const match = TASK_STEP_SUMMARIES_ROUTE_PATTERN.exec(pathname);
            if (!match) return false;

            const method = req.method ?? 'GET';
            if (method !== 'GET') {
                respond(res, 405, { error: 'method not allowed' }, { Allow: 'GET' });
                return true;
            }

            const taskId = decodeURIComponent(match[1]);
            if (!taskId) {
                respond(res, 400, { error: 'taskId is required' });
                return true;
            }

            try {
                const rows = stmt.all(taskId) as StepSummaryRow[];
                // Resolved once per request, not per row: the lookup is a
                // scan of the live map and a task has at most one agent.
                //
                // Guarded separately from the query. The step list is what
                // the board paints its chips from, and losing all of it
                // because an OPTIONAL extra threw would be a bad trade -
                // the operator would get an empty stage bar instead of a
                // missing Stop button.
                let liveAgentId: string | undefined;
                try {
                    liveAgentId = deps.agentForTask?.(taskId);
                } catch (lookupErr) {
                    deps.logger?.warn(
                        'task-step-summaries: live agent lookup failed',
                        {
                            taskId,
                            error: lookupErr instanceof Error
                                ? lookupErr.message
                                : String(lookupErr),
                        },
                    );
                }
                const steps: StepSummaryRecord[] = rows.map((r) => {
                    const status =
                        r.status === 'complete' || r.status === 'failed'
                            ? r.status
                            : 'running' as const;
                    return {
                        stepId: r.step_id,
                        role: r.role,
                        status,
                        startedAt: r.started_at,
                        finishedAt: r.finished_at,
                        summary: r.summary,
                        // Only for the step that is actually running: a
                        // finished step's agent is gone, and labelling it
                        // with whatever runs now would let Stop signal the
                        // WRONG process.
                        ...(status === 'running' && liveAgentId
                            ? { agentId: liveAgentId }
                            : {}),
                    };
                });
                respond(res, 200, { steps });
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                deps.logger?.error('task-step-summaries: list failed', {
                    taskId,
                    error: message,
                });
                respond(res, 500, {
                    error: 'task-step-summaries list failed',
                    message,
                });
            }
            return true;
        },
    };
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
