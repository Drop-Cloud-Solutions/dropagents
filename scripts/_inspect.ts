/**
 * Helpers backing inspect-issue. Holds the row-type interfaces, default
 * db path, readonly-open helper, and per-table query orchestration so the
 * CLI entry point stays a thin arg-parse + dispatch wrapper.
 */

import * as path from 'node:path';
import Database from 'better-sqlite3';

import { getStateDbPath } from '../config/env';

export const REPO_ROOT = path.resolve(__dirname, '..');
/**
 * Resolved the same way the hosts resolve it (`PIPELINE_STATE_DB`, else
 * `<repo-root>/.pipeline-state.db`). A diagnostic that reads a different
 * file from the worker reports on the wrong system, confidently — which
 * is worse than not running.
 *
 * Read lazily: operator scripts call `loadDotenv` before touching this,
 * and a module-level const would freeze the pre-dotenv value.
 */
export function defaultDbPath(): string {
    return getStateDbPath();
}
export const DEFAULT_EVENT_COUNT = 20;

export interface TaskRow {
    readonly id: string;
    readonly plan_id: string;
    readonly type: string;
    readonly status: string;
    readonly flow_id: string | null;
    readonly flow_position: number | null;
}

export interface PlanRow {
    readonly id: string;
    readonly project_id: string;
    readonly status: string;
    readonly created_at: number;
}

export interface FlowStateRow {
    readonly task_id: string;
    readonly current_step: string;
    readonly paused_step: string | null;
    readonly last_event_seq: number | null;
}

export interface EventRow {
    readonly seq: number;
    readonly type: string;
    readonly occurred_at: number;
    readonly payload: string;
}

export interface ExternalRefRow {
    readonly local_id: string;
    readonly system: string;
    readonly external_id: string;
    readonly claim_owner: string | null;
}

export type OpenDbFn = (dbPath: string) => Database.Database;

export const defaultOpenReadonlyDb: OpenDbFn = (dbPath) =>
    new Database(dbPath, { readonly: true, fileMustExist: true });

export interface InspectDump {
    readonly taskId: string;
    readonly db: string;
    readonly task: TaskRow;
    readonly plan: PlanRow | null;
    readonly flowState: FlowStateRow | null;
    readonly externalRefs: readonly ExternalRefRow[];
    readonly events: readonly {
        seq: number;
        type: string;
        occurredAt: number;
        payload: unknown;
    }[];
}

function safeParse(raw: string): unknown {
    try {
        return JSON.parse(raw);
    } catch {
        return raw;
    }
}

/**
 * Pull every relevant row for `taskId` from the readonly handle. Returns
 * `null` if no task row exists — caller decides how to surface that.
 */
export function buildDump(
    db: Database.Database,
    taskId: string,
    dbPath: string,
    eventCount: number,
): InspectDump | null {
    const task = db
        .prepare('SELECT id, plan_id, type, status, flow_id, flow_position FROM tasks WHERE id = ?')
        .get(taskId) as TaskRow | undefined;
    if (!task) return null;

    const plan = db
        .prepare('SELECT id, project_id, status, created_at FROM plans WHERE id = ?')
        .get(task.plan_id) as PlanRow | undefined;

    const flowState = db
        .prepare('SELECT task_id, current_step, paused_step, last_event_seq FROM flow_state WHERE task_id = ?')
        .get(taskId) as FlowStateRow | undefined;

    const externalRefs = db
        .prepare('SELECT local_id, system, external_id, claim_owner FROM external_refs WHERE local_id = ?')
        .all(taskId) as ExternalRefRow[];

    let events: EventRow[] = [];
    if (eventCount > 0) {
        // SQLite has no native JSON index — LIKE on the serialised payload
        // is the cheapest portable filter and keeps the row scan in-engine.
        const needle = `%"taskId":"${taskId}"%`;
        events = db
            .prepare(
                `SELECT seq, type, occurred_at, payload FROM events
                 WHERE payload LIKE ?
                 ORDER BY seq DESC LIMIT ?`,
            )
            .all(needle, eventCount) as EventRow[];
        events.reverse();
    }

    return {
        taskId,
        db: dbPath,
        task,
        plan: plan ?? null,
        flowState: flowState ?? null,
        externalRefs,
        events: events.map((e) => ({
            seq: e.seq,
            type: e.type,
            occurredAt: e.occurred_at,
            payload: safeParse(e.payload),
        })),
    };
}
