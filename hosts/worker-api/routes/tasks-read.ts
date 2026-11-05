/**
 * Worker-api read-only route for the durable tasks projection.
 *
 * `GET /api/tasks`
 *   Returns every row in the `tasks` table — the operator board
 *   hits this once on boot to seed its in-memory `tasks` Map so
 *   cards survive a worker-api restart or a browser reload. Tasks
 *   are written into the table by the orchestrator's
 *   `attachTaskProjection` subscriber, which folds the two
 *   `TaskCreated` shapes (orchestrator-emitted lifecycle + decomposer-
 *   projected per-task) into one row via an UPSERT.
 *
 * Response shape mirrors what the board's `applyTaskCreated`
 * reducer expects so the boot-hydration path can pass each row
 * straight through without remapping.
 */

import * as http from 'node:http';

import type Database from 'better-sqlite3';

import type { Db } from '../../../core/state/migrations';
import type { Logger } from '../../../core/ports/Logger';

type SqliteStatement = Database.Statement<unknown[], unknown>;

export const TASKS_LIST_ROUTE_PATTERN = /^\/api\/tasks\/?$/;

/**
 * `GET /api/tasks/:taskId/detail` — the two heavy fields the list route
 * withholds for closed tasks. One row, fetched when the operator opens a
 * task modal and the list said the fields were omitted.
 */
export const TASK_DETAIL_ROUTE_PATTERN = /^\/api\/tasks\/([^/]+)\/detail\/?$/;

/**
 * Wire shape of one row in the `GET /api/tasks` response. Field names
 * match {@link import('../../board-ui/task-projection').TaskProjectionRow}
 * one-for-one so the board can fold each entry through
 * {@link applyTaskCreated} unchanged.
 */
export interface TaskRecord {
    readonly taskId: string;
    readonly planId: string;
    /**
     * Project id derived from the task's plan (`tasks.plan_id →
     * sidebar_plans.pid`). The `tasks` table has no `project_id`
     * column of its own, so the route joins through `sidebar_plans` at
     * read time. Used by the board's project-filter sidebar — when the
     * operator picks a specific project, only tasks with a matching
     * `projectId` survive the filter.
     */
    readonly projectId: string | null;
    /**
     * When the task was created (migration 036, backfilled from the
     * `TaskCreated` event log). Null for a task whose creation event is
     * gone — readers omit the date rather than inventing one.
     */
    readonly createdAt: number | null;
    readonly type: string;
    readonly status: string;
    readonly flowId: string | null;
    readonly title: string | null;
    readonly description: string | null;
    /** Structured ticket fields (goal / acceptance criteria / file impact)
     *  parsed from tasks.ticket_details (migration 027); null for tasks
     *  decomposed before the fields were persisted. */
    readonly ticketDetails: Record<string, unknown> | null;
    /** Operator instructions / remarks (migration 022). */
    /**
     * True when `description` / `ticketDetails` were withheld from this
     * row rather than being genuinely empty. The distinction is the
     * whole contract: without it a client cannot tell 'this task has no
     * description' from 'ask for it', and would render a blank modal.
     * Fetch `GET /api/tasks/:taskId/detail` to fill them in.
     */
    readonly detailOmitted: boolean;
    readonly instructions: string | null;
    /** Operator rejection reason, when the task was rejected. Durable on
     *  `tasks.feedback`; the agent reads the same value back as
     *  `# Feedback to address` on a Retry. */
    readonly feedback: string | null;
    readonly parkedReason: string | null;
    /** Clarification question the task is parked on (migration 031). */
    readonly parkedQuestion: string | null;
    /** Enumerated clarification choices, parsed from parked_choices. */
    readonly parkedChoices: readonly string[] | null;
    /** Step stage the task failed at (dev/review/test/commit); null unless failed. */
    readonly failedStage: string | null;
    readonly prUrl: string | null;
    readonly prNumber: number | null;
    /**
     * Every task this task declared a dependency on, in insertion order.
     * Decomposer-emitted; persisted into `task_deps` by the orchestrator's
     * TaskCreated bridge.
     */
    readonly dependsOn: readonly string[];
    /**
     * Subset of `dependsOn` whose edge is not yet `'merged'`. Non-empty
     * iff the task is still gated on at least one upstream — the board
     * uses this to render the "Blocked by …" chip.
     */
    readonly blockedBy: readonly string[];
    /**
     * True when the operator approved this task while it was still
     * waiting on dependencies. The engine auto-starts it (bypassing the
     * approval gate) once the upstreams merge. Surfaced so a reload
     * still shows the pre-approved state.
     */
    readonly preApproved: boolean;
}

interface TaskRow {
    id: string;
    plan_id: string;
    project_id: string | null;
    type: string;
    status: string;
    flow_id: string | null;
    title: string | null;
    description: string | null;
    ticket_details: string | null;
    detail_omitted: number;
    instructions: string | null;
    feedback: string | null;
    parked_reason: string | null;
    parked_question: string | null;
    parked_choices: string | null;
    failed_stage: string | null;
    pre_approved: number | null;
    pr_url: string | null;
    pr_number: number | null;
    created_at: number | null;
}

export interface TasksReadDeps {
    readonly db: Db;
    readonly logger?: Logger;
}

export interface TasksRouter {
    handle(req: http.IncomingMessage, res: http.ServerResponse): boolean;
}

interface DepRow {
    task_id: string;
    depends_on_task_id: string;
    status: string;
}

function parseChoices(raw: string | null): readonly string[] | null {
    if (typeof raw !== 'string' || raw.length === 0) return null;
    try {
        const parsed = JSON.parse(raw) as unknown;
        return Array.isArray(parsed)
            ? parsed.filter((c): c is string => typeof c === 'string')
            : null;
    } catch {
        return null;
    }
}

function parseTicketJson(raw: string | null): Record<string, unknown> | null {
    if (typeof raw !== 'string' || raw.length === 0) return null;
    try {
        const parsed = JSON.parse(raw) as unknown;
        return parsed && typeof parsed === 'object'
            ? (parsed as Record<string, unknown>)
            : null;
    } catch {
        return null;
    }
}

export function createTasksReadRouter(deps: TasksReadDeps): TasksRouter {
    const stmt: SqliteStatement = deps.db.prepare(
        // Skipped tasks stay in the table for audit but should not
        // reappear on the board after a reload — the operator's Skip
        // click was the explicit "drop from my view" signal.
        `SELECT t.id,
                t.plan_id,
                sp.pid          AS project_id,
                t.type,
                t.status,
                t.flow_id,
                t.title,
                -- The two heavy columns, omitted for CLOSED tasks.
                -- Measured on a live board: 1385 tasks, 3.0 MB of JSON,
                -- 2.3 MB of it description + ticket_details — and 1324
                -- of those tasks were done or skipped. The board renders
                -- neither field on a card; only the task modal reads
                -- them, and it can fetch one row on demand. Active tasks
                -- keep theirs inline: they are the ones the operator
                -- opens constantly, and a round-trip per open is exactly
                -- the latency this change exists to remove.
                CASE WHEN t.status IN ('done','skipped','archived')
                     THEN NULL ELSE t.description END AS description,
                CASE WHEN t.status IN ('done','skipped','archived')
                     THEN NULL ELSE t.ticket_details END AS ticket_details,
                CASE WHEN t.status IN ('done','skipped','archived')
                     THEN 1 ELSE 0 END AS detail_omitted,
                t.instructions,
                t.feedback,
                t.parked_reason,
                t.parked_question,
                t.parked_choices,
                t.failed_stage,
                t.pre_approved,
                w.pr_url,
                w.pr_number,
                -- One integer per row, kept on the LIST rather than the
                -- lazy detail fetch: the modal must be able to show the
                -- date on first paint, and for a closed task the detail
                -- round-trip is exactly what this column would have to
                -- wait for.
                t.created_at
           FROM tasks t
           LEFT JOIN task_worktrees w ON w.task_id = t.id
           LEFT JOIN sidebar_plans sp ON sp.plan_id = t.plan_id
          ORDER BY t.plan_id ASC, t.id ASC`,
    );
    // Fold every edge once per request rather than running a per-task
    // query inside the row map — the typical task count is small but
    // the per-task variant would still slow boot hydration on plans
    // with dozens of tasks.
    const detailStmt: SqliteStatement = deps.db.prepare(
        'SELECT description, ticket_details FROM tasks WHERE id = ?',
    );
    const depsStmt: SqliteStatement = deps.db.prepare(
        `SELECT task_id, depends_on_task_id, status FROM task_deps`,
    );

    return {
        handle(req, res): boolean {
            const url = req.url ?? '/';
            const pathname = url.split('?', 1)[0];

            const detailMatch = TASK_DETAIL_ROUTE_PATTERN.exec(pathname);
            if (detailMatch) {
                if ((req.method ?? 'GET') !== 'GET') {
                    respond(res, 405, { error: 'method not allowed' }, { Allow: 'GET' });
                    return true;
                }
                const taskId = decodeURIComponent(detailMatch[1]);
                try {
                    const row = detailStmt.get(taskId) as
                        | { description: string | null; ticket_details: string | null }
                        | undefined;
                    if (!row) {
                        // 404 rather than an empty body: the caller asked
                        // for a specific task and must not render a blank
                        // modal as though the task had no description.
                        respond(res, 404, { error: 'task not found', taskId });
                        return true;
                    }
                    respond(res, 200, {
                        taskId,
                        description: row.description,
                        ticketDetails: parseTicketJson(row.ticket_details),
                    });
                } catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    deps.logger?.error('tasks-read: detail failed', { taskId, error: message });
                    respond(res, 500, { error: 'task detail failed', message });
                }
                return true;
            }

            if (!TASKS_LIST_ROUTE_PATTERN.test(pathname)) return false;

            const method = req.method ?? 'GET';
            if (method !== 'GET') {
                respond(res, 405, { error: 'method not allowed' }, { Allow: 'GET' });
                return true;
            }

            try {
                const rows = stmt.all() as TaskRow[];
                const depRows = depsStmt.all() as DepRow[];
                const allByTask = new Map<string, string[]>();
                const blockedByTask = new Map<string, string[]>();
                for (const d of depRows) {
                    let all = allByTask.get(d.task_id);
                    if (!all) {
                        all = [];
                        allByTask.set(d.task_id, all);
                    }
                    all.push(d.depends_on_task_id);
                    if (d.status !== 'merged') {
                        let blocked = blockedByTask.get(d.task_id);
                        if (!blocked) {
                            blocked = [];
                            blockedByTask.set(d.task_id, blocked);
                        }
                        blocked.push(d.depends_on_task_id);
                    }
                }
                const tasks: TaskRecord[] = rows.map((r) => ({
                    taskId: r.id,
                    planId: r.plan_id,
                    projectId: r.project_id,
                    type: r.type,
                    status: r.status,
                    flowId: r.flow_id,
                    title: r.title,
                    description: r.description,
                    ticketDetails: parseTicketJson(r.ticket_details),
                    detailOmitted: r.detail_omitted === 1,
                    instructions: r.instructions,
                    feedback: r.feedback,
                    parkedReason: r.parked_reason,
                    parkedQuestion: r.parked_question,
                    parkedChoices: parseChoices(r.parked_choices),
                    failedStage: r.failed_stage,
                    prUrl: r.pr_url,
                    prNumber: r.pr_number,
                    createdAt: r.created_at,
                    dependsOn: allByTask.get(r.id) ?? [],
                    blockedBy: blockedByTask.get(r.id) ?? [],
                    preApproved: r.pre_approved === 1,
                }));
                respond(res, 200, { tasks });
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                deps.logger?.error('tasks-read: list failed', { error: message });
                respond(res, 500, { error: 'tasks list failed', message });
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
