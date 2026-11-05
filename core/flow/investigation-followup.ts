/**
 * AP-IFG-007: investigation follow-up command + event + handler.
 *
 * Mirrors v1's `pipeline/worker/investigation-followup.ts:buildFollowupPrompt`.
 * After an investigation has produced its initial report, the operator can
 * ask a follow-up question that re-engages the investigator agent with the
 * prior brief + report + the full conversation thread.
 *
 * Lifecycle of a single follow-up turn:
 *
 *   1. `RequestInvestigationFollowup` command is dispatched.
 *   2. Handler reads the task's lineage record. If `followup_inflight` is
 *      true the command is rejected — only one in-flight follow-up at a
 *      time. AC #5.
 *   3. Handler appends `{role:'operator', content, timestamp}` to the
 *      `investigation_thread` and flips `followup_inflight` to true. AC #3.
 *   4. Handler dispatches the investigator agent with prior brief, prior
 *      report, and the thread (operator entry included). AC #2.
 *   5. On success: handler appends `{role:'investigator', content, timestamp}`
 *      to the thread and flips `followup_inflight` back to false. AC #3 + #4.
 *   6. On failure: handler flips `followup_inflight` back to false (no
 *      investigator entry appended) and rethrows so the bus reports the
 *      failure to its caller. AC #4.
 *
 * The handler returns a single `InvestigationFollowupRequested` event
 * carrying the operator question + the thread snapshot at the moment the
 * follow-up was issued. The agent's answer surfaces through the existing
 * `AgentQuestion` / `AgentFinished` event path emitted by the agent
 * runner itself — no new "answer" event type is introduced here.
 */

import type { CommandHandler } from '../commands/bus';
import type { Command } from '../commands/command';
import type { Event } from '../events/event';
import type {
    InvestigationThreadEntry,
    TaskLineage,
    TaskLineageStore,
} from './engine';

export const InvestigationFollowupCommands = {
    REQUEST_INVESTIGATION_FOLLOWUP: 'RequestInvestigationFollowup',
} as const;

export const InvestigationFollowupEvents = {
    INVESTIGATION_FOLLOWUP_REQUESTED: 'InvestigationFollowupRequested',
} as const;

/**
 * Inbound command payload. `priorBrief` and `priorReport` are optional so
 * callers that already have them cached (board UI, chat-bot) can avoid an
 * extra lookup; the investigator is still given the thread regardless.
 */
export interface RequestInvestigationFollowupPayload {
    readonly taskId: string;
    readonly question: string;
    readonly priorBrief?: string;
    readonly priorReport?: string;
}

/**
 * The event emitted by a successful follow-up turn. Records the operator
 * question + the thread snapshot that was sent to the agent. The
 * investigator's answer is NOT carried on this event — it surfaces via the
 * agent runner's own `AgentQuestion` / `AgentFinished` events so chat and
 * board pick it up through the existing stream.
 */
export interface InvestigationFollowupRequestedEventPayload {
    readonly taskId: string;
    readonly question: string;
    readonly actor: string;
    readonly thread: ReadonlyArray<InvestigationThreadEntry>;
    readonly priorBrief?: string;
    readonly priorReport?: string;
}

/**
 * Inputs threaded into the investigator on a follow-up turn. Matches the
 * v1 shape: prior brief + prior report + current thread.
 */
export interface InvestigatorInput {
    readonly taskId: string;
    readonly thread: ReadonlyArray<InvestigationThreadEntry>;
    readonly priorBrief?: string;
    readonly priorReport?: string;
}

/**
 * Port: dispatch the investigator agent and resolve with its answer.
 *
 * Kept as a tiny interface so the handler can be exercised in unit tests
 * without a real AgentRunner / Claude CLI. Production wires this onto the
 * existing AgentRunner via a thin adapter in the orchestrator host.
 */
export interface InvestigatorAgent {
    run(input: InvestigatorInput): Promise<string>;
}

export function isRequestInvestigationFollowupPayload(
    value: unknown,
): value is RequestInvestigationFollowupPayload {
    if (!value || typeof value !== 'object') return false;
    const v = value as Record<string, unknown>;
    if (typeof v.taskId !== 'string' || v.taskId.length === 0) return false;
    if (typeof v.question !== 'string' || v.question.length === 0) return false;
    if (v.priorBrief !== undefined && typeof v.priorBrief !== 'string') return false;
    if (v.priorReport !== undefined && typeof v.priorReport !== 'string') return false;
    return true;
}

/**
 * Render the follow-up prompt fed to the investigator. The shape mirrors
 * v1's `buildFollowupPrompt`: prior brief, prior report, then the thread
 * as a labelled transcript. Exported so the host adapter can reuse the
 * same rendering when it hands the input to the AgentRunner.
 */
export function buildFollowupPrompt(input: InvestigatorInput): string {
    const parts: string[] = [];
    if (input.priorBrief !== undefined && input.priorBrief.length > 0) {
        parts.push('## Prior brief', input.priorBrief);
    }
    if (input.priorReport !== undefined && input.priorReport.length > 0) {
        parts.push('## Prior investigation report', input.priorReport);
    }
    parts.push('## Conversation so far');
    if (input.thread.length === 0) {
        parts.push('(no prior turns)');
    } else {
        for (const entry of input.thread) {
            parts.push(`### ${entry.role}`, entry.content);
        }
    }
    return parts.join('\n\n');
}

export interface RequestInvestigationFollowupDeps {
    readonly clock: () => number;
    readonly lineage: TaskLineageStore;
    readonly investigator: InvestigatorAgent;
}

const EMPTY_LINEAGE: TaskLineage = {
    parent_task_id: null,
    spawn_reason: null,
    source_investigation_id: null,
    investigation_thread: [],
    followup_inflight: false,
};

/**
 * Build the `RequestInvestigationFollowup` command handler.
 *
 * The handler is asynchronous and awaits the investigator agent. Callers
 * that do not want to block on the agent run should dispatch the command
 * from a fire-and-forget context — the handler's contract is that
 * `followup_inflight` is true for the entire duration of the run.
 */
export function createRequestInvestigationFollowupHandler(
    deps: RequestInvestigationFollowupDeps,
): CommandHandler<Command<RequestInvestigationFollowupPayload>> {
    return async (cmd) => {
        if (!isRequestInvestigationFollowupPayload(cmd.payload)) {
            throw new Error('RequestInvestigationFollowup: invalid payload');
        }
        const { taskId, question, priorBrief, priorReport } = cmd.payload;

        let lineage = deps.lineage.read(taskId);
        if (!lineage) {
            deps.lineage.write(taskId, EMPTY_LINEAGE);
            lineage = deps.lineage.read(taskId);
        }
        if (!lineage) {
            // Defensive: write+read must round-trip. The InMemory impl always
            // does; a custom store that lies here is a programmer error.
            throw new Error(
                `RequestInvestigationFollowup: lineage store rejected seed for task "${taskId}"`,
            );
        }
        if (lineage.followup_inflight) {
            throw new Error(
                `RequestInvestigationFollowup: task "${taskId}" already has a follow-up in flight`,
            );
        }

        const operatorEntry: InvestigationThreadEntry = {
            role: 'operator',
            content: question,
            timestamp: deps.clock(),
        };
        const threadWithOperator: InvestigationThreadEntry[] = [
            ...lineage.investigation_thread,
            operatorEntry,
        ];
        deps.lineage.update(taskId, {
            investigation_thread: threadWithOperator,
            followup_inflight: true,
        });

        let answer: string;
        try {
            answer = await deps.investigator.run({
                taskId,
                thread: threadWithOperator,
                priorBrief,
                priorReport,
            });
        } catch (err) {
            // AC #4: clear the inflight gate even on failure so a later
            // retry is not blocked forever by a crashed run. No
            // investigator entry is appended — the thread reflects only
            // turns that actually produced an answer.
            deps.lineage.update(taskId, { followup_inflight: false });
            throw err;
        }

        const investigatorEntry: InvestigationThreadEntry = {
            role: 'investigator',
            content: answer,
            timestamp: deps.clock(),
        };
        deps.lineage.update(taskId, {
            investigation_thread: [...threadWithOperator, investigatorEntry],
            followup_inflight: false,
        });

        const payload: InvestigationFollowupRequestedEventPayload = {
            taskId,
            question,
            actor: cmd.actor,
            thread: threadWithOperator,
        };
        if (priorBrief !== undefined) {
            (payload as { priorBrief: string }).priorBrief = priorBrief;
        }
        if (priorReport !== undefined) {
            (payload as { priorReport: string }).priorReport = priorReport;
        }

        const event: Event = {
            type: InvestigationFollowupEvents.INVESTIGATION_FOLLOWUP_REQUESTED,
            v: 1,
            occurredAt: deps.clock(),
            // Deterministic per (taskId, issuedAt) so a duplicate dispatch
            // within the same millisecond de-dupes at the event store
            // rather than re-running the agent twice.
            idempotencyKey: `${InvestigationFollowupCommands.REQUEST_INVESTIGATION_FOLLOWUP}:${taskId}:${cmd.issuedAt}`,
            payload,
        };
        return [event];
    };
}
