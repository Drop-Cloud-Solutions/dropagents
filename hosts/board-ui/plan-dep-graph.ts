/**
 * Pure builders for the plan modal's task **dependency graph** (the
 * Mermaid DAG rendered by `board.ts`).
 *
 * Lifted out of `board.ts` for the same reason `task-projection.ts` and
 * `task-tags.ts` were: `board.ts` has top-level browser side effects
 * (EventSource, document queries, overlay-manager construction) that crash
 * a `node:test` import. Everything here is pure — same input → same output,
 * no DOM, no globals — so `plan-dep-graph.test.ts` can exercise the edge
 * filtering, status mapping, and Mermaid string generation directly.
 *
 * `board.ts` owns only the impure shell: reaching the Mermaid global,
 * `mermaid.render(...)`, building the DOM section, and the offline fallback.
 */

/**
 * The subset of the board's task row this module reads. `TaskProjectionRow`
 * (and therefore `board.ts`'s `TaskRow`) is structurally assignable to it,
 * so callers pass task rows straight through with no adapter.
 */
export interface DepGraphTask {
    readonly taskId: string;
    readonly title: string | null;
    readonly status: string;
    readonly dependsOn: readonly string[];
    readonly blockedBy: readonly string[];
    readonly parkedReason: string | null;
}

export type DepGraphStatus =
    | 'done'
    | 'running'
    | 'blocked'
    | 'failed'
    | 'skipped'
    | 'todo';

/**
 * Task statuses the board treats as actively running (mirrors
 * `TASK_IN_PROGRESS_STATES` in `board.ts` / `countPlanTasks`).
 */
const IN_PROGRESS_STATES: ReadonlySet<string> = new Set<string>([
    'in_progress',
    'review',
    'test',
    'commit',
    'merge',
]);

/**
 * The dependency edges to draw: `[upstream, downstream]` pairs where BOTH
 * endpoints are tasks in this plan. A `dependsOn` pointing outside the plan
 * (or at a task not present) is dropped — it can't be drawn here.
 */
export function computeDepEdges(
    planTasks: readonly DepGraphTask[],
): Array<[string, string]> {
    const ids = new Set(planTasks.map((t) => t.taskId));
    const edges: Array<[string, string]> = [];
    for (const t of planTasks) {
        const deps = Array.isArray(t.dependsOn) ? t.dependsOn : [];
        for (const d of deps) {
            if (ids.has(d)) edges.push([d, t.taskId]);
        }
    }
    return edges;
}

/**
 * Map a task to one of the six graph status classes. Priority order
 * matters: a done/failed/skipped terminal beats "blocked", which beats a
 * live/parked "running", which beats the default "todo".
 */
export function depGraphStatus(task: DepGraphTask): DepGraphStatus {
    if (task.status === 'done') return 'done';
    if (task.status === 'failed') return 'failed';
    if (task.status === 'skipped') return 'skipped';
    const blocked = Array.isArray(task.blockedBy) ? task.blockedBy : [];
    if (blocked.length > 0 || task.parkedReason === 'waiting-deps') {
        return 'blocked';
    }
    if (IN_PROGRESS_STATES.has(task.status) || task.parkedReason) {
        return 'running';
    }
    return 'todo';
}

/** A Mermaid-safe node id derived from the task id (`T-AMAP-006` → `n_T_AMAP_006`). */
export function depGraphNodeId(taskId: string): string {
    return 'n_' + taskId.replace(/[^A-Za-z0-9]/g, '_');
}

/** taskId + a short, parser-safe title for the node label. */
export function depGraphLabel(task: DepGraphTask): string {
    const title = (task.title ?? '').trim();
    const short = title.length > 32 ? `${title.slice(0, 31)}…` : title;
    const text = short ? `${task.taskId}: ${short}` : task.taskId;
    // Inside a "…" Mermaid label, quotes/backticks and newlines break the
    // parser — strip them and collapse whitespace.
    return text.replace(/["`]/g, '').replace(/\s+/g, ' ');
}

/**
 * Compose a Mermaid `flowchart TD` for the plan's task DAG. `edges` is
 * whatever {@link computeDepEdges} returned (passed in so the caller can
 * decide, before building the section, whether there's anything to draw).
 * The palette mirrors the board's status buckets.
 */
export function buildMermaidFlowchart(
    planTasks: readonly DepGraphTask[],
    edges: ReadonlyArray<readonly [string, string]>,
): string {
    const lines: string[] = ['flowchart TD'];
    lines.push('classDef done fill:#065f46,stroke:#10b981,color:#d1fae5;');
    lines.push('classDef running fill:#1e3a8a,stroke:#60a5fa,color:#dbeafe;');
    lines.push('classDef blocked fill:#78350f,stroke:#f59e0b,color:#fde68a;');
    lines.push('classDef failed fill:#7f1d1d,stroke:#ef4444,color:#fecaca;');
    lines.push('classDef skipped fill:#374151,stroke:#9ca3af,color:#e5e7eb;');
    lines.push('classDef todo fill:#1f2937,stroke:#4b5563,color:#e5e7eb;');
    for (const t of planTasks) {
        lines.push(
            `${depGraphNodeId(t.taskId)}["${depGraphLabel(t)}"]:::${depGraphStatus(t)}`,
        );
    }
    for (const [from, to] of edges) {
        lines.push(`${depGraphNodeId(from)} --> ${depGraphNodeId(to)}`);
    }
    return lines.join('\n');
}
