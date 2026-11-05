/**
 * Scheduler: pick the tasks a worker may start right now (AP-IFW-006).
 *
 * `eligibleTasks(snapshot)` returns the ids of tasks that
 *   1. carry no `parked_reason` (NULL or empty string), and
 *   2. have every outgoing dependency edge in status `'merged'`.
 *
 * The function is pure — it operates on a {@link TaskGraphSnapshot} composed
 * by the caller. Production callers compose the snapshot from a
 * {@link TaskDependencyStore} via {@link snapshotFromStore}; tests build
 * snapshots directly.
 *
 * Cycle detection: if the dependency graph contains any cycle (including a
 * self-edge), {@link CycleDetectedError} is thrown. The cycle is reported
 * before any eligibility decision is made — a cyclic graph is a structural
 * mistake, and silently dropping its members from the eligible set would
 * mask the bug.
 *
 * v2 cut-list note: there is no `bump-package-reference` task type in v2 and
 * the scheduler does not look at task type at all. Every task is gated by
 * the same rule.
 */

import type {
  SchedulableTask,
  TaskDependency,
  TaskDependencyStore,
} from '../ports/TaskDependencyStore';

export interface TaskGraphSnapshot {
  readonly tasks: readonly SchedulableTask[];
  readonly dependencies: readonly TaskDependency[];
}

export class CycleDetectedError extends Error {
  override readonly name = 'CycleDetectedError';
  /** Node ids on the cycle, in traversal order, with the start node repeated at the end. */
  readonly cycle: readonly string[];

  constructor(cycle: readonly string[]) {
    super(`task_deps cycle detected: ${cycle.join(' -> ')}`);
    this.cycle = cycle;
  }
}

/** Build a snapshot from a {@link TaskDependencyStore}. */
export function snapshotFromStore(store: TaskDependencyStore): TaskGraphSnapshot {
  return {
    tasks: store.listSchedulableTasks(),
    dependencies: store.listDependencies(),
  };
}

/**
 * Return the ids of tasks that may be started now. Order matches the order
 * of `snapshot.tasks` so callers that pre-sort upstream get deterministic
 * output.
 */
export function eligibleTasks(snapshot: TaskGraphSnapshot): string[] {
  detectCycle(snapshot);

  const depsByTask = new Map<string, TaskDependency[]>();
  for (const dep of snapshot.dependencies) {
    let bucket = depsByTask.get(dep.taskId);
    if (!bucket) {
      bucket = [];
      depsByTask.set(dep.taskId, bucket);
    }
    bucket.push(dep);
  }

  const eligible: string[] = [];
  for (const task of snapshot.tasks) {
    if (isParked(task)) continue;
    const deps = depsByTask.get(task.id) ?? [];
    if (deps.every((d) => d.status === 'merged')) {
      eligible.push(task.id);
    }
  }
  return eligible;
}

function isParked(task: SchedulableTask): boolean {
  // SQLite ALTER ADD COLUMN ... TEXT yields NULL for pre-existing rows; the
  // empty-string check is a defensive fallback for adapters that normalise
  // NULL → '' on the way out.
  return task.parkedReason !== null && task.parkedReason !== '';
}

// ---------------------------------------------------------------------------
// Cycle detection — iterative DFS with a path stack.
// ---------------------------------------------------------------------------

const COLOR_WHITE = 0;
const COLOR_GRAY = 1;
const COLOR_BLACK = 2;

interface Frame {
  readonly node: string;
  readonly iter: Iterator<string>;
}

function detectCycle(snapshot: TaskGraphSnapshot): void {
  const adjacency = new Map<string, string[]>();
  const allNodes = new Set<string>();

  for (const t of snapshot.tasks) allNodes.add(t.id);
  for (const dep of snapshot.dependencies) {
    allNodes.add(dep.taskId);
    allNodes.add(dep.dependsOnTaskId);
    let neighbors = adjacency.get(dep.taskId);
    if (!neighbors) {
      neighbors = [];
      adjacency.set(dep.taskId, neighbors);
    }
    neighbors.push(dep.dependsOnTaskId);
  }

  const color = new Map<string, number>();
  for (const start of allNodes) {
    if ((color.get(start) ?? COLOR_WHITE) !== COLOR_WHITE) continue;
    walk(start, adjacency, color);
  }
}

function walk(
  start: string,
  adjacency: Map<string, string[]>,
  color: Map<string, number>,
): void {
  const stack: Frame[] = [];
  const onPath = new Set<string>();
  const pathOrder: string[] = [];

  enter(start, adjacency, color, stack, onPath, pathOrder);

  while (stack.length > 0) {
    const top = stack[stack.length - 1]!;
    const next = top.iter.next();

    if (next.done) {
      stack.pop();
      onPath.delete(top.node);
      pathOrder.pop();
      color.set(top.node, COLOR_BLACK);
      continue;
    }

    const child = next.value;
    if (onPath.has(child)) {
      const idx = pathOrder.indexOf(child);
      const cycle = pathOrder.slice(idx).concat(child);
      throw new CycleDetectedError(cycle);
    }
    if ((color.get(child) ?? COLOR_WHITE) === COLOR_BLACK) continue;
    enter(child, adjacency, color, stack, onPath, pathOrder);
  }
}

function enter(
  node: string,
  adjacency: Map<string, string[]>,
  color: Map<string, number>,
  stack: Frame[],
  onPath: Set<string>,
  pathOrder: string[],
): void {
  color.set(node, COLOR_GRAY);
  onPath.add(node);
  pathOrder.push(node);
  stack.push({
    node,
    iter: (adjacency.get(node) ?? [])[Symbol.iterator](),
  });
}
