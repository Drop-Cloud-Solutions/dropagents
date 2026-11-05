/**
 * Merge-conflict resolver — an agent that resolves PR merge conflicts and
 * merges straight through, or asks the operator when it isn't sure.
 *
 * Field problem: a conflicted `gh pr merge` just failed; the task sat
 * parked at ready-to-merge until the operator resolved by hand. Now:
 *
 *   MergeTaskPr hits a conflict
 *     → `MergeConflictDetected` published (manual click AND auto-merge)
 *     → this module re-provisions the task worktree (the merge path tears
 *       it down pre-merge; ensureWorktree re-attaches to the task branch
 *       with its commits intact), spawns a `merge-resolver` agent in it
 *     → agent merges origin/<default> into the branch, resolves markers
 *       honoring BOTH sides, commits, pushes
 *     → on success: MergeTaskPr is re-dispatched — the merge completes
 *       with no operator involvement ("merge straight through").
 *     → unsure / failed: the task parks with reason=clarification — the
 *       SAME question surface other agents use (Answer button with the
 *       question + options persisted, Telegram ❓) — explaining exactly
 *       what conflicted and what the choices are.
 *
 * Engine isolation is deliberate: the resolver agent is NOT registered in
 * the agent→task map, so the AgentFinished/AgentFailed engine bridges
 * ignore it — its completion can never be mistaken for the merge step
 * finishing (which would emit TaskFinished WITHOUT a merged PR). The
 * board's Show-agent stream still renders it via `metadata.taskId`.
 *
 * One attempt per task per process: a resolve → still-conflicted →
 * resolve loop is capped at a single automated try; the second conflict
 * goes straight to the operator.
 */

import type { EventBus } from '../../core/events/bus';
import type { Logger } from '../../core/ports/Logger';
import type { AgentRunner } from '../../core/ports';
import type { Db } from '../../core/state/migrations';
import { parseClarification } from '../../core/flow/clarification-parser';
import { composePersona } from '../../config/profile';
import { isMergeBlockedByRequirements } from './merge-classify';

/** Conflict-shaped `gh pr merge` failures (vs auth/network/API errors). */
const CONFLICT_PATTERNS: ReadonlyArray<RegExp> = [
    /not mergeable/i,
    /merge conflict/i,
    /conflicts? must be resolved/i,
    /\bCONFLICT\b/,
    /merge commit cannot be cleanly created/i,
];

export function isMergeConflictFailure(reason: string | undefined | null): boolean {
    if (!reason) return false;
    // A PR blocked by the repo's own REQUIREMENTS (checks pending,
    // review missing, merge queue) is not a conflict - but gh words
    // both as "is not mergeable", so /not mergeable/ above matches it
    // too. Field report: a PR whose checks had simply not finished was
    // reported as having conflicts and a merge-resolver agent was sent
    // to resolve nothing. The agent found the branch clean, could not
    // explain itself, and the operator lost an afternoon to it.
    if (isMergeBlockedByRequirements(reason)) return false;
    return CONFLICT_PATTERNS.some((re) => re.test(reason));
}

export interface MergeConflictWorktrees {
    get(taskId: string): {
        readonly repoId: string;
        readonly branch: string;
        readonly path: string;
        readonly prNumber: number | null;
    } | null | undefined;
    ensureWorktree(
        taskId: string,
        repoId: string,
        repoPath: string,
    ): Promise<{ readonly path: string; readonly branch: string }>;
    repoPathForTask(taskId: string): string | null | undefined;
}

export interface MergeConflictResolverDeps {
    readonly bus: EventBus;
    readonly commandBus: {
        send(cmd: {
            type: string;
            actor: string;
            issuedAt: number;
            payload: Record<string, unknown>;
        }): Promise<unknown>;
    };
    readonly db: Db;
    readonly worktrees: MergeConflictWorktrees;
    readonly agentRunner: AgentRunner;
    /**
     * Env overlay for the task's GitHub account, applied to the
     * RESOLVER AGENT process.
     *
     * The resolver is an agent that runs git itself - it fetches the
     * base branch, merges, and pushes - so without the account it
     * works on the ambient identity and a private repo answers
     * "Repository not found". It then has no way to see the commits it
     * was sent to rebase, and asks the operator what to do instead.
     *
     * Absent, or an empty result, leaves the agent ambient.
     */
    readonly githubEnvForTask?: (taskId: string) => Readonly<Record<string, string>>;
    readonly logger: Logger;
    readonly clock: () => number;
    /** Agents-panel persona override for the merge-resolver role. */
    readonly resolveAgentPrompt?: (role: string) => string | undefined;
    /** Agents-panel / config model for the role ('' | undefined = runner default). */
    readonly resolveModel?: (role: string) => string | undefined;
    /** Directory holding agents/<role>.CLAUDE.md; defaults to <repo>/agents. */
    readonly agentsDir?: string;
}

export const MERGE_CONFLICT_EVENT = 'MergeConflictDetected';
const RESOLVER_ROLE = 'merge-resolver';
const RESOLVER_SUBSCRIBER = 'merge-conflict-resolver';

export class MergeConflictResolver {
    private readonly attempted = new Set<string>();
    /** agentId → taskId for in-flight resolver runs. */
    private readonly pending = new Map<string, string>();
    private readonly unsubscribers: Array<() => void> = [];

    constructor(private readonly deps: MergeConflictResolverDeps) {}

    /** True when an automated resolve was already tried for this task. */
    hasAttempted(taskId: string): boolean {
        return this.attempted.has(taskId);
    }

    attach(): void {
        const { bus } = this.deps;
        this.unsubscribers.push(
            bus.subscribe<{ taskId?: string; reason?: string }>(
                MERGE_CONFLICT_EVENT,
                async (event) => {
                    const taskId = event.payload?.taskId;
                    if (typeof taskId !== 'string' || taskId.length === 0) return;
                    await this.onConflict(taskId, event.payload?.reason ?? '');
                },
                { subscriber: RESOLVER_SUBSCRIBER },
            ),
        );
        this.unsubscribers.push(
            bus.subscribe<{
                agentId?: string;
                outcome?: string;
                content?: string;
                metadata?: Record<string, unknown>;
            }>(
                'AgentFinished',
                async (event) => {
                    const agentId = event.payload?.agentId ?? '';
                    const taskId = this.pending.get(agentId);
                    if (!taskId) return;
                    this.pending.delete(agentId);
                    if (event.payload?.outcome === 'interrupted') {
                        // Operator killed the run — their call; stay parked
                        // ready-to-merge for manual handling.
                        this.deps.logger.info('merge-resolver: run interrupted by operator', {
                            taskId,
                        });
                        return;
                    }
                    await this.onResolverFinished(taskId, event.payload?.content ?? '');
                },
                { subscriber: RESOLVER_SUBSCRIBER },
            ),
        );
        this.unsubscribers.push(
            bus.subscribe<{ agentId?: string; stderrTail?: string }>(
                'AgentFailed',
                async (event) => {
                    const agentId = event.payload?.agentId ?? '';
                    const taskId = this.pending.get(agentId);
                    if (!taskId) return;
                    this.pending.delete(agentId);
                    await this.parkWithQuestion(
                        taskId,
                        'The merge-resolver agent crashed while resolving the PR merge '
                        + `conflict: ${(event.payload?.stderrTail ?? 'unknown error').slice(0, 300)}. `
                        + 'Resolve the conflict manually in the repo, then click Merge PR again.',
                        [
                            'A) I resolved it manually — retry Merge PR',
                            'B) Cancel this merge for now',
                        ],
                    );
                },
                { subscriber: RESOLVER_SUBSCRIBER },
            ),
        );
    }

    detach(): void {
        for (const off of this.unsubscribers) off();
        this.unsubscribers.length = 0;
    }

    private async onConflict(taskId: string, reason: string): Promise<void> {
        if (this.attempted.has(taskId)) {
            this.deps.logger.warn(
                'merge-resolver: conflict recurrence — automated resolve already attempted, leaving for the operator',
                { taskId },
            );
            return;
        }
        this.attempted.add(taskId);

        const rec = this.deps.worktrees.get(taskId);
        const repoPath = this.deps.worktrees.repoPathForTask(taskId);
        if (!rec || !repoPath) {
            await this.parkWithQuestion(
                taskId,
                'The PR has a merge conflict, but no worktree/repo record could be '
                + 'located to run the automatic resolver. Resolve the conflict '
                + 'manually, then click Merge PR again.',
                ['A) I resolved it manually — retry Merge PR'],
            );
            return;
        }

        let worktree: { path: string; branch: string };
        try {
            worktree = await this.deps.worktrees.ensureWorktree(taskId, rec.repoId, repoPath);
        } catch (err) {
            await this.parkWithQuestion(
                taskId,
                'The PR has a merge conflict and re-creating the task worktree for '
                + `the automatic resolver failed: ${err instanceof Error ? err.message : String(err)}. `
                + 'Resolve manually, then click Merge PR again.',
                ['A) I resolved it manually — retry Merge PR'],
            );
            return;
        }

        const task = this.readTask(taskId);
        const defaultBranch = this.readDefaultBranch(rec.repoId) ?? 'main';
        const prompt = this.buildPrompt({
            taskId,
            title: task?.title ?? taskId,
            description: task?.description ?? '',
            branch: worktree.branch,
            defaultBranch,
            conflictReason: reason,
        });
        const model = this.deps.resolveModel?.(RESOLVER_ROLE);
        // The resolver fetches, merges and pushes, so it needs the
        // repo's GitHub account exactly as the task agents do.
        const githubEnv = this.deps.githubEnvForTask?.(taskId) ?? {};
        const handle = this.deps.agentRunner.start({
            role: RESOLVER_ROLE,
            prompt,
            cwd: worktree.path,
            ...(Object.keys(githubEnv).length > 0 ? { env: githubEnv } : {}),
            metadata: {
                taskId,
                stepId: 'merge-resolve',
                kind: 'merge-resolver',
                ...(model ? { model } : {}),
            },
        });
        // Deliberately NOT registered in the agent→task map: the engine's
        // AgentFinished bridge must never treat this run as the merge step
        // completing. Outcome routing happens in this module only.
        this.pending.set(handle.id, taskId);
        this.deps.logger.info('merge-resolver: agent dispatched', {
            taskId,
            agentId: handle.id,
            branch: worktree.branch,
            defaultBranch,
        });
    }

    private async onResolverFinished(taskId: string, content: string): Promise<void> {
        const clar = parseClarification(content);
        if (clar !== null) {
            await this.parkWithQuestion(
                taskId,
                clar.question,
                clar.options.map((o) => `${o.key}) ${o.label}`),
            );
            return;
        }
        // Clean finish — the resolution is pushed; merge straight through.
        try {
            await this.deps.commandBus.send({
                type: 'MergeTaskPr',
                actor: 'merge-resolver',
                issuedAt: this.deps.clock(),
                payload: { taskId },
            });
            this.deps.logger.info('merge-resolver: conflict resolved and PR merged', { taskId });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            await this.parkWithQuestion(
                taskId,
                isMergeConflictFailure(message)
                    ? 'The merge-resolver pushed a resolution, but the PR still '
                      + `reports conflicts (${message.slice(0, 200)}). This usually means `
                      + 'the base branch moved again mid-resolve. Resolve manually, '
                      + 'then click Merge PR again.'
                    : 'The merge conflict was resolved and pushed, but the follow-up '
                      + `merge failed: ${message.slice(0, 250)}. Fix the underlying issue, `
                      + 'then click Merge PR again.',
                ['A) I handled it — retry Merge PR', 'B) Leave parked for now'],
            );
        }
    }

    /**
     * Park the task with the SAME clarification surface other agents use:
     * TaskParked(reason=clarification) carries the question (persisted →
     * the card's Answer button), ClarificationRequested carries the
     * choices (persisted → the modal's radios). `notifyChat: true` tells
     * the Telegram TaskParked handler to send the ❓ message — normal
     * agent clarifications are covered by AgentQuestion, which this
     * host-side park does not emit (emitting it would hit the engine's
     * question machinery for a step that isn't running).
     */
    private async parkWithQuestion(
        taskId: string,
        question: string,
        choices: readonly string[],
    ): Promise<void> {
        const at = this.deps.clock();
        await this.deps.bus.publish({
            type: 'TaskParked',
            v: 1,
            occurredAt: at,
            idempotencyKey: `merge-resolver:parked:${taskId}:${at}`,
            payload: {
                taskId,
                stepId: 'merge',
                reason: 'clarification',
                question,
                notifyChat: true,
            },
        });
        await this.deps.bus.publish({
            type: 'ClarificationRequested',
            v: 1,
            occurredAt: at,
            idempotencyKey: `merge-resolver:clarify:${taskId}:${at}`,
            payload: { taskId, question, choices: choices.slice() },
        });
        this.deps.logger.warn('merge-resolver: parked with operator question', {
            taskId,
        });
    }

    private readTask(taskId: string): { title: string | null; description: string | null } | null {
        try {
            const row = this.deps.db
                .prepare('SELECT title, description FROM tasks WHERE id = ?')
                .get(taskId) as { title: string | null; description: string | null } | undefined;
            return row ?? null;
        } catch {
            return null;
        }
    }

    private readDefaultBranch(repoId: string): string | null {
        try {
            const row = this.deps.db
                .prepare('SELECT default_branch FROM repos WHERE repo_id = ?')
                .get(repoId) as { default_branch: string | null } | undefined;
            return row?.default_branch ?? null;
        } catch {
            return null;
        }
    }

    private buildPrompt(args: {
        taskId: string;
        title: string;
        description: string;
        branch: string;
        defaultBranch: string;
        conflictReason: string;
    }): string {
        const persona = this.deps.resolveAgentPrompt?.(RESOLVER_ROLE)
            ?? this.readPersonaFile()
            ?? FALLBACK_PERSONA;
        return [
            persona,
            '',
            '---',
            '',
            `Task: ${args.taskId} — ${args.title}`,
            '',
            args.description,
            '',
            `Your branch (this task's reviewed work): ${args.branch}`,
            `Base branch to merge in: origin/${args.defaultBranch}`,
            `Reported merge failure: ${args.conflictReason || '(gh reported the PR as not mergeable)'}`,
            '',
            'Steps: git fetch origin, then merge origin/'
            + `${args.defaultBranch} into ${args.branch}, resolve every conflict, `
            + 'commit the merge, and push the branch. The orchestrator merges the '
            + 'PR automatically after you finish — do NOT run gh or merge the PR '
            + 'yourself.',
        ].join('\n');
    }

    private readPersonaFile(): string | null {
        // Through the profile layers like every other persona, so an
        // operator's customised merge-resolver is the one that runs.
        // `agentsDir` stays as the test seam for the repo layer.
        return composePersona(
            RESOLVER_ROLE,
            this.deps.agentsDir !== undefined ? { repoAgentsDir: this.deps.agentsDir } : {},
        );
    }
}

const FALLBACK_PERSONA = [
    'You are a merge-conflict resolver in an automated pipeline. Merge the',
    'base branch into the task branch, resolve every conflict honoring BOTH',
    'sides\' intent, commit the merge, push. Never use git stash. If a',
    'conflict is semantic or you are not confident, emit NEEDS_HUMAN_INPUT',
    'with a Question: line and Options: list instead of guessing.',
].join(' ');
