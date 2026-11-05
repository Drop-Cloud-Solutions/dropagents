/**
 * AP-VP5-005 — orchestrator resume handler.
 *
 * Extends the bare `ResumeTask` command handler from `core/commands` with
 * the worktree-side and memory-side mutations that accompany an operator
 * answer or rejection:
 *
 *   ResumeTask{ decision: 'approve', answer?, remember? }
 *     1. Truncate-and-write the answer to
 *        `<worktreeRoot>/clarification-answer.md` (when `answer` is set).
 *     2. If `remember === true`, persist the answer into the per-project
 *        agent memory via {@link AgentMemoryWriter.appendMemoryEntry} so
 *        future tasks see it without re-asking.
 *     3. Emit `ClarificationAnswered` carrying `{ taskId, answer, remember,
 *        answeredAt }`.
 *     4. Forward to the existing core handler, which emits `TaskResumed`
 *        and drives the engine's resume path (re-dispatches the parked
 *        agent step with the operator's verdict in context).
 *
 *   ResumeTask{ decision: 'reject', feedback? }
 *     1. Truncate-and-write the feedback to `<worktreeRoot>/feedback.md`
 *        (when `feedback` is set).
 *     2. Forward to the existing core handler. The flow engine's
 *        `TaskResumed` subscriber (AP-VP5-003) sees `decision: 'reject'`
 *        and routes through the parked step's `on_failure` branch.
 *
 * Sidecar files are written BEFORE the inner handler runs (and therefore
 * before the flow engine re-dispatches the next step) so the re-dispatched
 * agent observes the freshest content on its first read. Truncate semantics
 * — a second answer/feedback for the same task overwrites the prior
 * content rather than appending — match the agents' input-file convention:
 * latest value wins.
 */
import * as fsModule from 'node:fs';
import * as path from 'node:path';

import type { CommandHandler } from '../../../core/commands/bus';
import type { Command } from '../../../core/commands/command';
import {
    createResumeTaskHandler,
    isResumeTaskPayload,
    type ResumeTaskPayload,
} from '../../../core/commands';
import type {
    ClarificationAnsweredPayload,
    Event,
} from '../../../core/events/event';
import type { Logger } from '../../../core/ports/Logger';

/**
 * Resolve a `taskId` to the absolute path of its worktree root — the same
 * directory that hosts `.agent-stream.jsonl`. In production this is
 * satisfied structurally by {@link import('../../../adapters/git/worktree-manager').WorktreeManager.pathFor}.
 * Returns `undefined` when no worktree is currently tracked for `taskId`
 * (replay against a pruned task, test harness without a worktree, ...): the
 * handler logs a warning and skips the sidecar write rather than failing
 * the resume.
 */
export interface WorktreeRootLookup {
    pathFor(taskId: string): string | undefined;
}

/**
 * Resolve a `taskId` to the owning `projectId` so a `remember=true`
 * answer can be appended to the right per-project agent memory. Returns
 * `undefined` when the mapping is not known to the orchestrator — in
 * which case the memory append is skipped (with a warn log) but the
 * resume still proceeds.
 */
export interface TaskProjectLookup {
    projectIdFor(taskId: string): string | undefined;
}

/**
 * Write-side port matching {@link import('../../../core/projects/agent-memory').AgentMemoryStore.appendMemoryEntry}.
 * Production wires the store; tests substitute a recorder.
 */
export interface AgentMemoryWriter {
    appendMemoryEntry(opts: {
        readonly projectId: string;
        /**
         * `commit-reject` is not decoration. The memory store has always
         * declared it as a source and nothing ever wrote one: rejecting a
         * commit with a reason told THAT task's agent (via `feedback.md`)
         * and no one else, so the next plan for the same project was
         * written as if the pushback had never happened.
         */
        readonly source: 'clarification' | 'commit-reject';
        readonly taskId: string;
        readonly decision: string;
        readonly context: string;
    }): Promise<void>;
}

/**
 * Filesystem write injection point. Defaults to a synchronous
 * `fs.writeFileSync` (truncate-and-write semantics).
 */
export interface ResumeFsAdapter {
    writeFileSync(filePath: string, contents: string): void;
}

export interface ResumeHandlerDeps {
    readonly clock: () => number;
    readonly logger: Logger;
    readonly worktrees: WorktreeRootLookup;
    /** Optional per-project memory adapter. When omitted, `remember=true`
     *  is captured on the emitted event but no JSONL/markdown line is
     *  appended (tests can opt out cleanly). */
    readonly memory?: AgentMemoryWriter;
    /** Required alongside {@link memory} to resolve which project to
     *  append into. When either is missing, the memory write is skipped. */
    readonly projectLookup?: TaskProjectLookup;
    /** Filesystem write injection. Defaults to `fs.writeFileSync`. */
    readonly fs?: ResumeFsAdapter;
}

/** Sidecar filename for an approve-with-answer resume. */
export const CLARIFICATION_ANSWER_FILENAME = 'clarification-answer.md';
/** Sidecar filename for a reject-with-feedback resume. */
export const FEEDBACK_FILENAME = 'feedback.md';

const CLARIFICATION_ANSWERED_EVENT_TYPE = 'ClarificationAnswered';

/**
 * Build the orchestrator-side ResumeTask handler. Composes the pure
 * command handler from `core/commands` with the sidecar / memory writes
 * the orchestrator host owns.
 */
export function createResumeHandler(
    deps: ResumeHandlerDeps,
): CommandHandler<Command<ResumeTaskPayload>> {
    const inner = createResumeTaskHandler({ clock: deps.clock });
    const writeFile: ResumeFsAdapter['writeFileSync'] =
        deps.fs?.writeFileSync.bind(deps.fs)
            ?? ((filePath, contents): void => {
                fsModule.writeFileSync(filePath, contents);
            });

    return async (cmd, state): Promise<Event[]> => {
        if (!isResumeTaskPayload(cmd.payload)) {
            // Mirror the inner handler's contract so the bus rejects
            // malformed dynamic / replay payloads before any side-effect.
            throw new Error('ResumeTask: invalid payload');
        }
        const { taskId, decision, answer, feedback, remember } = cmd.payload;

        const extras: Event[] = [];

        if (decision === 'approve') {
            if (answer !== undefined) {
                writeSidecar(
                    deps,
                    writeFile,
                    taskId,
                    CLARIFICATION_ANSWER_FILENAME,
                    answer,
                );
                if (remember === true) {
                    await appendMemoryIfWired(deps, taskId, answer, 'clarification', 'answer');
                }
                const answeredAt = deps.clock();
                const payload: ClarificationAnsweredPayload = {
                    taskId,
                    answer,
                    remember: remember === true,
                    answeredAt,
                };
                extras.push({
                    type: CLARIFICATION_ANSWERED_EVENT_TYPE,
                    v: 1,
                    occurredAt: answeredAt,
                    // Keyed on (taskId, issuedAt) so a duplicate
                    // operator click within the same millisecond collapses
                    // at the event store rather than emitting a second
                    // ClarificationAnswered.
                    idempotencyKey:
                        `${CLARIFICATION_ANSWERED_EVENT_TYPE}:${taskId}:${cmd.issuedAt}`,
                    payload,
                });
            }
        } else if (decision === 'reject') {
            if (feedback !== undefined) {
                writeSidecar(
                    deps,
                    writeFile,
                    taskId,
                    FEEDBACK_FILENAME,
                    feedback,
                );
                // …and into the project's memory. The sidecar reaches only
                // THIS task's next agent run; the memory block reaches the
                // planner and decomposer on every future run. A rejection
                // is the operator saying "not like that", which is exactly
                // what the next plan should be written knowing.
                //
                // No `remember` opt-in here, unlike a clarification answer:
                // an answer may be a one-off fact about one task, whereas a
                // reject is a judgement about the work, and the operator
                // already typed a reason to justify it.
                if (feedback.trim().length > 0) {
                    await appendMemoryIfWired(
                        deps, taskId, feedback, 'commit-reject', 'reject',
                    );
                }
            }
        }

        // Existing approve / reject dispatch — the inner handler emits
        // TaskResumed which the flow engine subscriber consumes to route
        // the parked task onward (on_success / on_failure).
        const taskResumed = await inner(cmd, state);
        return [...extras, ...taskResumed];
    };
}

function writeSidecar(
    deps: ResumeHandlerDeps,
    writeFile: ResumeFsAdapter['writeFileSync'],
    taskId: string,
    filename: string,
    contents: string,
): void {
    const root = deps.worktrees.pathFor(taskId);
    if (root === undefined) {
        deps.logger.warn(
            `orchestrator/resume: no worktree for taskId; ${filename} not written`,
            { taskId, filename },
        );
        return;
    }
    const filePath = path.join(root, filename);
    try {
        writeFile(filePath, contents);
    } catch (err) {
        deps.logger.warn(
            `orchestrator/resume: failed to write ${filename}`,
            {
                taskId,
                filename,
                path: filePath,
                error: err instanceof Error ? err.message : String(err),
            },
        );
    }
}

async function appendMemoryIfWired(
    deps: ResumeHandlerDeps,
    taskId: string,
    context: string,
    source: 'clarification' | 'commit-reject',
    decision: string,
): Promise<void> {
    if (!deps.memory || !deps.projectLookup) {
        deps.logger.warn(
            'orchestrator/resume: memory-worthy feedback but agent-memory wiring is incomplete',
            {
                taskId,
                hasMemory: deps.memory !== undefined,
                hasProjectLookup: deps.projectLookup !== undefined,
            },
        );
        return;
    }
    const projectId = deps.projectLookup.projectIdFor(taskId);
    if (projectId === undefined) {
        deps.logger.warn(
            'orchestrator/resume: no projectId for taskId; memory entry skipped',
            { taskId, source },
        );
        return;
    }
    try {
        await deps.memory.appendMemoryEntry({
            projectId,
            source,
            taskId,
            decision,
            context,
        });
    } catch (err) {
        deps.logger.warn(
            'orchestrator/resume: appendMemoryEntry failed',
            {
                taskId,
                projectId,
                error: err instanceof Error ? err.message : String(err),
            },
        );
    }
}
