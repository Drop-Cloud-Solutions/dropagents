/**
 * Plan-lifecycle chat actions: create_plan, run_planner, decompose_plan,
 * archive_plan, delete_plan.
 *
 * `create_plan` / `run_planner` / `decompose_plan` map onto the
 * {@link PlanLifecycleCommands} surface added in AP-IFW-003. `archive_plan`
 * and `delete_plan` do not yet have v2 commands wired and are surfaced as
 * `not-wired` skips so the operator-visible reply (from the classifier)
 * still flows and a later track can drop the command in without
 * re-prompting.
 *
 * The classifier's payloads on `create_plan` are JSON-encoded
 * (`{project, title, description, repo_id, archetype}`); this module
 * tolerates either a raw string title or a JSON blob and pulls out the
 * fields the v2 command actually needs.
 */

import type { CommandBus } from '../../core/commands/bus';
import type { Command } from '../../core/commands/command';
import type { ChatGateway, IdGen, Logger } from '../../core/ports';
import {
    PlanLifecycleCommands,
    type DecomposePlanPayload,
    type GeneratePlanPayload,
    type SubmitBriefPayload,
} from '../../core/commands';

export const ACTOR_PLAN_NL = 'telegram-nl-plan';

/**
 * Read-side seam for the approved plan body a `decompose_plan` needs.
 *
 * The Telegram chat surface does not carry the approved plan markdown in
 * scope — it only knows the plan id the operator named. This port lets
 * {@link ChatPlanOps} pull the real body from the plan projection
 * (`adapters/projections/plan-projection-store`, backed by `sidebar_plans`)
 * before dispatching `DecomposePlan`, instead of feeding the decomposer an
 * empty string. Production wires the projection store (its
 * `getApprovedContent` method satisfies this shape structurally); tests
 * inject a stub.
 */
export interface PlanContentReader {
    /**
     * The approved body stored for `planId`, or null when the plan is
     * unknown / has no content. An empty/whitespace body is treated the
     * same as "no content" by the decompose path — decomposition must not
     * run against nothing.
     */
    getApprovedContent(planId: string): string | null;
}

export interface ChatPlanOpsDeps {
    readonly commandBus: CommandBus<unknown>;
    readonly logger: Logger;
    /** Generates plan / brief ids when the operator did not supply one. */
    readonly idGen: IdGen;
    readonly clock?: () => number;
    /**
     * Default project id used when the classifier resolved a plan/task in
     * chat but the SubmitBrief payload did not name one. Optional — when
     * absent and the payload lacks a project, the dispatch is skipped.
     */
    readonly defaultProjectId?: string;
    /**
     * Loads the approved plan body so `decompose_plan` runs against the
     * real, approved content rather than an empty string.
     */
    readonly planReader: PlanContentReader;
    /**
     * Outbound chat surface used to make a blocked decompose VISIBLE to the
     * operator (per the "never fail silently" rule). Optional — when absent
     * (or when the input carries no `chatId`) the block is still recorded on
     * the result's `skipReason` and in a `logger.warn`, but no chat message
     * is pushed.
     */
    readonly chatGateway?: ChatGateway;
}

export interface ChatPlanInput {
    readonly action: string;
    /** target: plan id or project slug, depending on the action. */
    readonly target?: string;
    /** payload: JSON-or-text body produced by the classifier. */
    readonly payload?: string;
    /**
     * Originating chat id, when known. Used to surface a decompose block
     * back to the operator through {@link ChatPlanOpsDeps.chatGateway}.
     */
    readonly chatId?: number | string;
}

export interface ChatPlanResult {
    readonly dispatched: boolean;
    readonly commandType?: string;
    readonly skipReason?: string;
}

interface CreatePlanArgs {
    readonly project?: string;
    readonly title?: string;
    readonly description?: string;
    readonly archetype?: string;
}

export class ChatPlanOps {
    private readonly clock: () => number;

    constructor(private readonly deps: ChatPlanOpsDeps) {
        this.clock = deps.clock ?? ((): number => Date.now());
    }

    async dispatch(input: ChatPlanInput): Promise<ChatPlanResult> {
        switch (input.action) {
            case 'create_plan':
                return this.handleCreatePlan(input);
            case 'run_planner':
                return this.handleRunPlanner(input);
            case 'decompose_plan':
                return this.handleDecomposePlan(input);
            case 'archive_plan':
            case 'delete_plan':
                this.deps.logger.info('chat-plan-ops: action not wired in v2', {
                    action: input.action,
                    target: input.target ?? null,
                });
                return {
                    dispatched: false,
                    skipReason: `${input.action}: command not yet wired in v2`,
                };
            default:
                return {
                    dispatched: false,
                    skipReason: `chat-plan-ops: unknown action "${input.action}"`,
                };
        }
    }

    private async handleCreatePlan(input: ChatPlanInput): Promise<ChatPlanResult> {
        const args = parseCreatePlanPayload(input.payload);
        const projectId = args.project ?? this.deps.defaultProjectId;
        if (!projectId) {
            return {
                dispatched: false,
                skipReason: 'create_plan: no project resolved',
            };
        }
        const briefId = this.deps.idGen.newId();
        const payload: SubmitBriefPayload = {
            briefId,
            projectId,
            content: composeBriefContent(args),
        };
        return this.send(PlanLifecycleCommands.SUBMIT_BRIEF, payload);
    }

    private async handleRunPlanner(input: ChatPlanInput): Promise<ChatPlanResult> {
        if (!input.target) {
            return { dispatched: false, skipReason: 'run_planner: no plan target' };
        }
        const projectId = this.deps.defaultProjectId;
        if (!projectId) {
            return {
                dispatched: false,
                skipReason: 'run_planner: no defaultProjectId configured',
            };
        }
        // Chat-bot triggers always re-run the planner from scratch — there is
        // no revision picker in the conversational surface. Revision is fixed
        // at 1; the new-plan modal owns the multi-revision path (task-013).
        const payload: GeneratePlanPayload = {
            planId: input.target,
            projectId,
            revision: 1,
        };
        return this.send(PlanLifecycleCommands.GENERATE_PLAN, payload);
    }

    private async handleDecomposePlan(input: ChatPlanInput): Promise<ChatPlanResult> {
        if (!input.target) {
            return { dispatched: false, skipReason: 'decompose_plan: no plan target' };
        }
        const projectId = this.deps.defaultProjectId;
        if (!projectId) {
            return {
                dispatched: false,
                skipReason: 'decompose_plan: no defaultProjectId configured',
            };
        }
        // The chat surface doesn't carry the approved plan body in scope, so
        // load it from the plan projection keyed by plan id. Feeding the
        // decomposer an empty string here (the old placeholder) silently
        // decomposed *nothing* — the classifier's cheerful "decomposing…"
        // reply masked a no-op. When there is no approved content, refuse to
        // dispatch and make the drop visible to the operator instead.
        const approvedContent = this.deps.planReader.getApprovedContent(input.target);
        if (approvedContent === null || approvedContent.trim().length === 0) {
            const skipReason =
                `decompose_plan: plan "${input.target}" has no approved content — nothing to decompose`;
            this.deps.logger.warn('chat-plan-ops: decompose blocked, no approved plan content', {
                planId: input.target,
                planFound: approvedContent !== null,
            });
            await this.notifyOperator(
                input,
                `⚠️ Can't decompose plan "${input.target}": no approved plan content was found. `
                    + 'Generate and approve the plan first, then try again.',
            );
            return { dispatched: false, skipReason };
        }
        const payload: DecomposePlanPayload = {
            planId: input.target,
            projectId,
            approvedContent,
            conventions: {},
        };
        return this.send(PlanLifecycleCommands.DECOMPOSE_PLAN, payload);
    }

    /**
     * Push a plain-text notice to the operator's chat, when a gateway and a
     * chat id are both available. Best-effort: a failed send is logged but
     * never throws — the caller has already recorded the skip on its result.
     */
    private async notifyOperator(input: ChatPlanInput, message: string): Promise<void> {
        if (!this.deps.chatGateway || input.chatId === undefined) return;
        try {
            await this.deps.chatGateway.notify(String(input.chatId), message);
        } catch (err) {
            this.deps.logger.warn('chat-plan-ops: operator notify failed', {
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    private async send(commandType: string, payload: unknown): Promise<ChatPlanResult> {
        const command: Command = {
            type: commandType,
            actor: ACTOR_PLAN_NL,
            issuedAt: this.clock(),
            payload,
        };
        try {
            await this.deps.commandBus.send(command);
            return { dispatched: true, commandType };
        } catch (err) {
            this.deps.logger.warn('chat-plan-ops: command dispatch failed', {
                command: commandType,
                error: err instanceof Error ? err.message : String(err),
            });
            return {
                dispatched: false,
                commandType,
                skipReason: `dispatch failed: ${err instanceof Error ? err.message : String(err)}`,
            };
        }
    }
}

function parseCreatePlanPayload(raw: string | undefined): CreatePlanArgs {
    if (!raw || raw.length === 0) return {};
    try {
        const obj = JSON.parse(raw) as Record<string, unknown>;
        const args: CreatePlanArgs = {};
        if (typeof obj.project === 'string') (args as { project: string }).project = obj.project;
        if (typeof obj.title === 'string') (args as { title: string }).title = obj.title;
        if (typeof obj.description === 'string')
            (args as { description: string }).description = obj.description;
        if (typeof obj.archetype === 'string')
            (args as { archetype: string }).archetype = obj.archetype;
        return args;
    } catch {
        // Free-text fallback — treat the entire payload as the description.
        return { description: raw };
    }
}

function composeBriefContent(args: CreatePlanArgs): string {
    const lines: string[] = [];
    if (args.title) lines.push(`Title: ${args.title}`);
    if (args.archetype) lines.push(`Archetype: ${args.archetype}`);
    if (args.description) lines.push(args.description);
    return lines.join('\n\n');
}
