/**
 * AP-VP7-007: AutoTransitionJob event subscriber.
 *
 * Two automation hooks the operator can opt into per plan, both gated by
 * the same `auto_transitions: true` flag on the plan's metadata. Missing
 * the flag (or setting it `false`) makes both hooks no-ops — i.e. the
 * default is "ask the operator first".
 *
 *   1. PrMerged → DispatchDeploy
 *      When a PR for the plan lands on the default branch AND the plan's
 *      metadata sets `deploy_after_merge: <env>`, the job issues a
 *      `DispatchDeploy{ planId, env, ... }` command through the existing
 *      command bus. The actual deploy adapter is wired separately under
 *      that command type — the job never imports it.
 *
 *   2. InvestigationCompleted → CreatePlan
 *      When an investigator agent's report carries
 *      `spawn_feature_plan: true`, the job issues a `CreatePlan` command
 *      whose payload threads the investigation report markdown through
 *      as the new plan's brief. The planner adapter handles the command.
 *
 * The job never imports `deploy` / `planner` adapters directly — both
 * dispatches travel through the {@link CommandBus} the rest of the host
 * already uses. That keeps the auto-transitions opt-in isolated from
 * the concrete agents: a future deploy or planner reimplementation only
 * needs to re-register its command handler.
 *
 * Idempotency
 * -----------
 * Subscribers register under {@link AUTO_TRANSITIONS_SUBSCRIBER} so
 * `EventBus` persists their offset and a process restart does not
 * re-deliver events the job has already handled. Inside a single process
 * the job also tracks the `seq` of every event it has dispatched against
 * in an in-memory `Set` so a duplicate live delivery (replay + live race,
 * or a host wiring bug) is a true no-op rather than a double-dispatch.
 *
 * Failures inside a dispatch are caught and logged via the {@link Logger}
 * port — a broken command handler must not stall the subscriber's offset
 * and re-fire the dispatch on every subsequent event.
 */

import type { CommandBus } from '../../core/commands/bus';
import type { Command } from '../../core/commands/command';
import type { EventBus } from '../../core/events/bus';
import type { StoredEvent } from '../../core/events/event';
import type { Logger } from '../../core/ports/Logger';

/** Named subscriber id under which both event handlers register. */
export const AUTO_TRANSITIONS_SUBSCRIBER = 'auto-transitions-job';

/** Default actor recorded on dispatched commands. */
export const AUTO_TRANSITIONS_ACTOR = 'auto-transitions-job';

/** Event types the job subscribes to. */
export const AutoTransitionEvents = {
    PR_MERGED: 'PrMerged',
    INVESTIGATION_COMPLETED: 'InvestigationCompleted',
} as const;

/** Command types the job dispatches through the command bus. */
export const AutoTransitionCommands = {
    DISPATCH_DEPLOY: 'DispatchDeploy',
    CREATE_PLAN: 'CreatePlan',
} as const;

/**
 * Subset of plan metadata the auto-transitions gate consults. Additional
 * fields are tolerated (the underlying store may return a wider object)
 * — the job only narrows on these two.
 */
export interface AutoTransitionPlanMetadata {
    /**
     * Master gate. Missing or `false` makes both event branches a no-op.
     * Documented in the task brief as "missing = false".
     */
    readonly auto_transitions?: boolean;
    /**
     * Deploy target environment to dispatch on PrMerged. Absent disables
     * the deploy branch even when `auto_transitions: true`.
     */
    readonly deploy_after_merge?: string;
}

/**
 * Lookup port for the auto-transitions plan-metadata gate.
 *
 * The job intentionally consumes this as an interface so it does not
 * import a concrete plan store — the host wires whatever `plan-store`
 * helper is canonical at composition time. Returning `undefined` (no
 * metadata for that plan id) is treated the same as
 * `{ auto_transitions: false }`.
 */
export interface PlanMetadataStore {
    readMetadata(planId: string): AutoTransitionPlanMetadata | undefined;
}

/**
 * Payload of the `PrMerged` event the job subscribes to. `planId` is the
 * pipeline plan whose metadata the gate consults; `prNumber` / `repoPath`
 * are passed through to the dispatched deploy command so the downstream
 * deploy adapter has the artefact identifiers it needs.
 */
export interface PrMergedEventPayload {
    readonly planId: string;
    readonly prNumber?: number;
    readonly repoPath?: string;
    readonly taskId?: string;
}

/**
 * The investigation report shape the gate inspects. Free-form aside from
 * the single `spawn_feature_plan` flag and an optional `brief` markdown
 * blob that becomes the new plan's brief content when CreatePlan fires.
 */
export interface InvestigationReportPayload {
    readonly spawn_feature_plan?: boolean;
    readonly brief?: string;
    readonly title?: string;
}

/**
 * Payload of the `InvestigationCompleted` event the job subscribes to.
 * The agent stream publishes this with the report markdown attached;
 * the job re-reads only the `spawn_feature_plan` flag and `brief` body.
 */
export interface InvestigationCompletedEventPayload {
    readonly taskId: string;
    readonly planId: string;
    readonly report: InvestigationReportPayload;
}

/**
 * `DispatchDeploy` command payload. Carries the gate-resolved env and
 * the merge artefact identifiers so the deploy adapter need not re-read
 * plan metadata or events.
 */
export interface DispatchDeployCommandPayload {
    readonly planId: string;
    readonly env: string;
    readonly prNumber?: number;
    readonly repoPath?: string;
    readonly taskId?: string;
}

/**
 * `CreatePlan` command payload. The investigation report's markdown
 * becomes the new plan's brief verbatim.
 */
export interface CreatePlanCommandPayload {
    readonly sourceTaskId: string;
    readonly sourcePlanId: string;
    readonly brief: string;
    readonly title?: string;
}

export interface AutoTransitionJobDeps {
    readonly bus: EventBus;
    readonly commandBus: CommandBus<unknown>;
    readonly planStore: PlanMetadataStore;
    readonly clock: () => number;
    readonly logger?: Logger;
    /** Override the actor recorded on dispatched commands. */
    readonly actor?: string;
    /** Override the subscriber name (defaults to {@link AUTO_TRANSITIONS_SUBSCRIBER}). */
    readonly subscriberName?: string;
}

export interface AutoTransitionJobHandle {
    /** Detach both subscribers. Idempotent. */
    stop(): void;
}

/**
 * Attach the two event handlers to the bus. Returns a handle whose
 * `stop()` detaches both subscribers — used by tests and graceful
 * shutdown.
 */
export function register(deps: AutoTransitionJobDeps): AutoTransitionJobHandle {
    const subscriberName = deps.subscriberName ?? AUTO_TRANSITIONS_SUBSCRIBER;
    const actor = deps.actor ?? AUTO_TRANSITIONS_ACTOR;
    const seen = new Set<number>();

    const unsubs = [
        deps.bus.subscribe<PrMergedEventPayload>(
            AutoTransitionEvents.PR_MERGED,
            (event) => handlePrMerged(event, deps, seen, actor),
            { subscriber: subscriberName },
        ),
        deps.bus.subscribe<InvestigationCompletedEventPayload>(
            AutoTransitionEvents.INVESTIGATION_COMPLETED,
            (event) => handleInvestigationCompleted(event, deps, seen, actor),
            { subscriber: subscriberName },
        ),
    ];

    let stopped = false;
    return {
        stop(): void {
            if (stopped) return;
            stopped = true;
            for (const u of unsubs) u();
        },
    };
}

async function handlePrMerged(
    event: StoredEvent & { payload: PrMergedEventPayload },
    deps: AutoTransitionJobDeps,
    seen: Set<number>,
    actor: string,
): Promise<void> {
    if (seen.has(event.seq)) return;
    seen.add(event.seq);

    const { planId, prNumber, repoPath, taskId } = event.payload;
    if (!planId) return;

    const meta = deps.planStore.readMetadata(planId);
    if (!isAutoTransitionsEnabled(meta)) return;

    const env = meta?.deploy_after_merge;
    if (typeof env !== 'string' || env.length === 0) return;

    const payload: DispatchDeployCommandPayload = { planId, env };
    if (prNumber !== undefined) {
        (payload as { prNumber: number }).prNumber = prNumber;
    }
    if (repoPath !== undefined) {
        (payload as { repoPath: string }).repoPath = repoPath;
    }
    if (taskId !== undefined) {
        (payload as { taskId: string }).taskId = taskId;
    }

    const cmd: Command<DispatchDeployCommandPayload> = {
        type: AutoTransitionCommands.DISPATCH_DEPLOY,
        actor,
        issuedAt: deps.clock(),
        payload,
    };

    try {
        await deps.commandBus.send(cmd);
    } catch (err) {
        deps.logger?.error('auto-transitions: DispatchDeploy failed', {
            planId,
            env,
            sourceEventSeq: event.seq,
            error: err instanceof Error ? err.message : String(err),
        });
    }
}

async function handleInvestigationCompleted(
    event: StoredEvent & { payload: InvestigationCompletedEventPayload },
    deps: AutoTransitionJobDeps,
    seen: Set<number>,
    actor: string,
): Promise<void> {
    if (seen.has(event.seq)) return;
    seen.add(event.seq);

    const { taskId, planId, report } = event.payload;
    if (!planId || !taskId) return;
    if (!report || report.spawn_feature_plan !== true) return;

    const meta = deps.planStore.readMetadata(planId);
    if (!isAutoTransitionsEnabled(meta)) return;

    const payload: CreatePlanCommandPayload = {
        sourceTaskId: taskId,
        sourcePlanId: planId,
        brief: report.brief ?? '',
    };
    if (report.title !== undefined) {
        (payload as { title: string }).title = report.title;
    }

    const cmd: Command<CreatePlanCommandPayload> = {
        type: AutoTransitionCommands.CREATE_PLAN,
        actor,
        issuedAt: deps.clock(),
        payload,
    };

    try {
        await deps.commandBus.send(cmd);
    } catch (err) {
        deps.logger?.error('auto-transitions: CreatePlan failed', {
            taskId,
            planId,
            sourceEventSeq: event.seq,
            error: err instanceof Error ? err.message : String(err),
        });
    }
}

function isAutoTransitionsEnabled(
    meta: AutoTransitionPlanMetadata | undefined,
): boolean {
    return meta?.auto_transitions === true;
}
