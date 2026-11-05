/**
 * AP-VP4-008 — projection that folds `PlanDecomposed` events into one
 * `TaskCreated` event per task in the decomposer's payload.
 *
 * The decomposer publishes a single `PlanDecomposed` event carrying the
 * full task list for a plan. Downstream subscribers (flow engine, board
 * projections, audit forwarders) prefer per-task events: it lets each
 * consumer key its state on `taskId` without re-parsing the array out of
 * the plan-scoped payload every time.
 *
 * This store closes that gap. It subscribes to `PlanDecomposed`, walks
 * the `tasks` array, and publishes a `TaskCreated` event per entry —
 * preserving the fields the brief calls out (`id`, `title`, `type`,
 * `dependencies`, `description`). No new event type is introduced; the
 * existing `TaskCreated` discriminator is reused so subscribers that
 * already listen for it pick up the new emissions automatically.
 *
 * Idempotency has two layers, both deliberate:
 *
 *   1. **In-memory short-circuit on `planId`.** A `Set<string>` records
 *      which plans have been folded inside this process. A second
 *      delivery of `PlanDecomposed` for the same plan (live republish,
 *      tail of a duplicate idempotency-key dedup at the bus, or anything
 *      else that re-fires the subscription) returns without touching the
 *      bus at all. The hint on the brief calls this out by name: "gate
 *      on the planId".
 *
 *   2. **Durable dedup via `idempotencyKey` on every emitted
 *      `TaskCreated`.** The key is `TaskCreated:<planId>:<taskId>`. The
 *      `events` table has a UNIQUE constraint on `idempotency_key`
 *      (`core/events/store.ts`), so even when the in-memory set is empty
 *      — e.g. after a process restart that triggers `replayMissed` — a
 *      replayed `PlanDecomposed` re-emits the same per-task keys and the
 *      store rejects them silently. Defence in depth: the fast path
 *      keeps the steady state cheap; the persistent path makes restarts
 *      safe.
 */

import type { EventBus } from '../../core/events/bus';
import type {
    Event,
    PlanDecomposedPayload,
    PlanDecomposedTask,
    StoredEvent,
} from '../../core/events/event';

/**
 * Subscriber name registered with the EventBus. Exposed so a host that
 * wants the projection to recover from missed events on boot can call
 * `bus.replayMissed(TASK_PROJECTION_SUBSCRIBER)` after wiring it.
 */
export const TASK_PROJECTION_SUBSCRIBER = 'task-projection-store';

/**
 * Event type emitted per task. Matches the existing `TaskCreated`
 * discriminator used elsewhere in the orchestrator host so we do not
 * fork the vocabulary.
 */
export const TASK_CREATED_EVENT_TYPE = 'TaskCreated';

/**
 * Payload emitted per projected task. Carries the five fields the brief
 * requires preserved from the decomposer's task entry plus the
 * originating `planId` so downstream consumers can group tasks by plan
 * without re-querying the event log.
 *
 * The shape is structural (no class) and intentionally narrower than
 * the orchestrator's full `TaskCreatedPayload` — this projection's job
 * is to surface the decomposer output, not to drive flow execution.
 * Subscribers that need the flow-engine fields (`flowId`, lineage)
 * continue to read the orchestrator-emitted `TaskCreated` events; both
 * shapes share the same discriminator and travel through the same log.
 */
export interface ProjectedTaskCreatedPayload {
    readonly taskId: string;
    readonly planId: string;
    readonly title: string;
    readonly type: string;
    /**
     * Flow id the FlowEngine dispatches against. Mirrors `type` —
     * the flow loader keys YAMLs by file name (`implement.yaml` →
     * `flowId='implement'`) and the decomposer task types use the
     * same vocabulary, so the two are 1:1. Surfaced as its own field
     * so the orchestrator's `TaskCreated → ApproveTask` cascade has
     * a non-undefined `flowId` to forward to the engine.
     */
    readonly flowId: string;
    readonly dependencies: readonly string[];
    readonly description: string;
    /**
     * Structured ticket fields (goal / acceptance criteria / file
     * impact) lifted from the decomposer's context block. Absent when
     * the decomposer supplied none — readers fall back to rendering
     * the plain description.
     */
    readonly ticketDetails?: TaskTicketDetails;
    /**
     * Per-task workspace repo (resolved from the decomposer's
     * context.repo_path). Overrides the plan's metadata.targetRepo for
     * worktree creation; absent → plan-level fallback.
     */
    readonly repoId?: string;
}

/** JSON stored in tasks.ticket_details (migration 027). */
export interface TaskTicketDetails {
    readonly goal?: string;
    readonly acceptanceCriteria?: readonly string[];
    readonly filesToCreate?: readonly string[];
    readonly filesToModify?: readonly string[];
    readonly filesToDelete?: readonly string[];
    /** The decomposer's `test.commands` for this task, rendered into
     *  TASK.md's `## Test commands` so the tester runs the SCOPED
     *  command instead of inferring the whole suite. */
    readonly testCommands?: readonly string[];
}

/**
 * Build the durable idempotency key for a projected `TaskCreated`.
 *
 * Exported so tests (and future tooling that wants to audit whether a
 * given task has been projected) construct the same key the store
 * does. The `planId` segment scopes the key — two plans that happen
 * to reuse a task id (legacy data, copied templates) keep separate
 * dedup buckets.
 */
export function taskCreatedIdempotencyKey(
    planId: string,
    taskId: string,
    revision?: number,
): string {
    if (revision !== undefined) {
        return `${TASK_CREATED_EVENT_TYPE}:${planId}:r${revision}:${taskId}`;
    }
    return `${TASK_CREATED_EVENT_TYPE}:${planId}:${taskId}`;
}

/**
 * Subscribe a projection to the supplied `EventBus`. The store wires
 * its subscription in the constructor; callers retain the instance
 * only when they need to inspect projection state (currently just
 * `hasProcessed` for tests / health checks).
 */
export class TaskProjectionStore {
    private readonly processedPlans = new Set<string>();

    constructor(
        private readonly bus: EventBus,
        private readonly clock: () => number,
    ) {
        bus.subscribe<PlanDecomposedPayload>(
            'PlanDecomposed',
            (event) => this.onPlanDecomposed(event),
            { subscriber: TASK_PROJECTION_SUBSCRIBER },
        );
    }

    /**
     * Returns true when this process has already folded a
     * `PlanDecomposed` for `planId`. Mainly a test seam; production
     * code should rely on the bus dedup, not this predicate.
     */
    hasProcessed(planId: string): boolean {
        return this.processedPlans.has(planId);
    }

    private async onPlanDecomposed(
        event: StoredEvent & { payload: PlanDecomposedPayload },
    ): Promise<void> {
        const { planId, tasks, revision } = event.payload;

        // In-memory short-circuit, scoped per (plan, revision). Without
        // the revision suffix a re-decompose (operator regenerates the
        // plan, runs the decomposer again) would hit the same dedup
        // bucket as the first run and never emit fresh TaskCreated
        // events — leaving the board stuck on the old task set. Keyed
        // by `${planId}|r${revision}` so each decomposition revision
        // gets its own bucket.
        const dedupKey = revision !== undefined
            ? `${planId}|r${revision}`
            : planId;
        if (this.processedPlans.has(dedupKey)) return;

        // Two distinct `PlanDecomposed` events flow per plan in the
        // current pipeline:
        //
        //   1. Synchronously from the `DecomposePlan` command handler
        //      the moment the operator clicks Approve. No `tasks`
        //      payload — its only job is to record the operator's
        //      decision on the event log.
        //   2. Asynchronously from the lifecycle subscriber once the
        //      decomposer agent finishes. Carries the actual
        //      `PlanDecomposedTask[]` lifted out of the agent's JSON.
        //
        // Marking the plan as processed on the first (empty) event
        // would silently drop the task-bearing second event — exactly
        // the "decomposer ran, no tasks on the board" failure mode.
        // So: skip the mark when there's nothing to emit.
        if (!tasks || tasks.length === 0) {
            return;
        }

        for (const task of tasks) {
            await this.emitTaskCreated(planId, task, revision);
        }

        // Marked AFTER the loop completes so a mid-fold throw leaves
        // the plan unmarked and a retry can finish the job. The
        // durable `idempotency_key` on every emitted `TaskCreated`
        // means a partial retry never produces duplicate rows.
        this.processedPlans.add(dedupKey);
    }

    private async emitTaskCreated(
        planId: string,
        task: PlanDecomposedTask,
        revision?: number,
    ): Promise<void> {
        // `flowId` is what the FlowEngine keys on (`onTaskApproved` does
        // `this.flows.get(flowId)`). The flow loader keys YAMLs by
        // file name (`config/flows/implement.yaml` → flowId='implement'),
        // and the decomposer task types use the same vocabulary, so
        // mirroring `task.type` onto `flowId` is the canonical mapping.
        // Tasks whose type has no matching YAML will fail at dispatch
        // — the operator sees the failure on the card and can rename
        // the type to one that exists. Without this, every projected
        // task arrived at the engine with `flowId=undefined` and got
        // immediately marked failed.
        const details: TaskTicketDetails = {
            ...(task.goal !== undefined ? { goal: task.goal } : {}),
            ...(task.acceptanceCriteria !== undefined
                ? { acceptanceCriteria: task.acceptanceCriteria }
                : {}),
            ...(task.filesToCreate !== undefined ? { filesToCreate: task.filesToCreate } : {}),
            ...(task.filesToModify !== undefined ? { filesToModify: task.filesToModify } : {}),
            ...(task.filesToDelete !== undefined ? { filesToDelete: task.filesToDelete } : {}),
            ...(task.testCommands !== undefined
                ? { testCommands: task.testCommands }
                : {}),
        };
        const payload: ProjectedTaskCreatedPayload = {
            taskId: task.id,
            planId,
            title: task.title,
            type: task.type,
            flowId: task.type,
            dependencies: task.dependencies,
            description: task.description,
            ...(Object.keys(details).length > 0 ? { ticketDetails: details } : {}),
            ...(task.repoId !== undefined ? { repoId: task.repoId } : {}),
        };
        const event: Event = {
            type: TASK_CREATED_EVENT_TYPE,
            v: 1,
            occurredAt: this.clock(),
            idempotencyKey: taskCreatedIdempotencyKey(planId, task.id, revision),
            payload,
        };
        await this.bus.publish(event);
    }
}
