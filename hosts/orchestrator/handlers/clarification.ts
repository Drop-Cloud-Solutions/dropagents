/**
 * AP-VP5-004 — orchestrator clarification handler.
 *
 * Subscribes to the running task's agent stream (the same `.agent-stream.jsonl`
 * source the worker-api SSE route tails — wired in by the orchestrator host
 * via the {@link AgentStreamSubscription} port so this handler never opens a
 * second file watcher) and looks for the explicit JSON envelope:
 *
 *     { "event": "needs_human_input", "question": "...", "choices"?: [...] }
 *
 * When the line parses as JSON and matches that exact shape, the handler
 * emits two events on the EventBus:
 *
 *   1. `TaskParked` with `reason: 'clarification'` — the universal park
 *      signal the flow engine's resume path already understands (mirrors
 *      what {@link FlowEngine.onAgentQuestion} emits for the in-process
 *      AGENT_QUESTION marker path, but here driven directly from the
 *      stream rather than via the engine's `AgentQuestion` event).
 *
 *   2. `ClarificationRequested` (AP-VP5-001) — the typed event carrying
 *      the operator-facing question + optional choices the board's
 *      clarification modal renders.
 *
 * Anything else — malformed JSON, a JSON object without
 * `event === 'needs_human_input'`, or a `needs_human_input` line whose
 * `question` is missing / not a non-empty string — is silently skipped with
 * a `debug`-level log line. The stream carries a lot of unrelated CLI
 * envelopes (`assistant`, `system`, `tool_use`, ...) and routinely emits
 * incomplete buffer tails; throwing on any of those would crash every
 * developer / reviewer run.
 *
 * Wiring lives in `hosts/orchestrator/handlers.ts`, which re-exports
 * {@link registerClarificationHandler} so the host's startup wiring goes
 * through the same handler-surface barrel the rest of the orchestrator
 * lifecycle handlers use.
 */

import type { EventBus } from '../../../core/events/bus';
import type {
    ClarificationRequestedPayload,
    Event,
} from '../../../core/events/event';
import type { Logger } from '../../../core/ports/Logger';
import { TaskParkingEvents } from '../../../core/commands';
import type { TaskParkedEventPayload } from '../../../core/commands';

/**
 * One JSONL line from the agent stream, tagged with the task and step the
 * stream belongs to. The orchestrator host supplies `taskId` and `stepId`
 * from its existing agent → task / agent → step bookkeeping; this handler
 * is intentionally ignorant of how those mappings are derived.
 */
export interface AgentStreamLineContext {
    readonly taskId: string;
    readonly stepId: string;
    /** Raw stream line, verbatim (without trailing newline). */
    readonly line: string;
}

/**
 * Port that hands each stream line to a registered listener. The
 * production wiring is the existing per-task agent-stream subscription
 * (the same source the worker-api SSE tails); tests pass a tiny in-memory
 * implementation that just calls `emit(line)` when the suite wants a line
 * delivered.
 */
export interface AgentStreamSubscription {
    /**
     * Register `handler` for every subsequent stream line. Returns a
     * teardown closure that detaches the listener — the orchestrator host
     * invokes it from its `stop()` path between suites.
     *
     * Handlers may be async; the subscription implementation is expected
     * to await them so a downstream `bus.publish` settles before the next
     * line is processed (this keeps event ordering deterministic for
     * replay and for the tests below).
     */
    subscribe(
        handler: (line: AgentStreamLineContext) => void | Promise<void>,
    ): () => void;
}

export interface ClarificationHandlerDeps {
    readonly bus: EventBus;
    readonly clock: () => number;
    readonly logger: Logger;
    readonly stream: AgentStreamSubscription;
}

/**
 * Event type literal the typed event variant
 * {@link import('../../../core/events/event').ClarificationRequested} uses
 * as its discriminator. Re-declared here so we don't depend on the
 * variant import at the call site — the payload type alone is enough.
 */
const CLARIFICATION_REQUESTED_EVENT_TYPE = 'ClarificationRequested';

/**
 * Loose shape we accept from the JSONL stream after `JSON.parse`. Keeping
 * the typed view minimal lets us reject anything that does not satisfy
 * the contract without writing a full schema validator.
 */
interface ParsedNeedsHumanInput {
    readonly question: string;
    readonly choices?: readonly string[];
}

/**
 * Return the parsed clarification when `line` is a JSON object whose
 * `event` field is exactly `"needs_human_input"` and whose `question`
 * is a non-empty string. Returns `null` for every other shape — empty
 * line, non-JSON, JSON that is not an object, wrong `event` value,
 * missing or non-string `question`, or `choices` that is present but not
 * a string array.
 *
 * Pure — exposed for the tests that pin the parser semantics.
 */
export function parseNeedsHumanInputLine(line: string): ParsedNeedsHumanInput | null {
    if (typeof line !== 'string') return null;
    const trimmed = line.trim();
    if (trimmed.length === 0) return null;
    if (trimmed[0] !== '{') return null;
    let parsed: unknown;
    try {
        parsed = JSON.parse(trimmed);
    } catch {
        return null;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const obj = parsed as Record<string, unknown>;
    if (obj.event !== 'needs_human_input') return null;
    if (typeof obj.question !== 'string' || obj.question.length === 0) return null;
    if (obj.choices === undefined) {
        return { question: obj.question };
    }
    if (!Array.isArray(obj.choices)) return null;
    const choices: string[] = [];
    for (const c of obj.choices) {
        if (typeof c !== 'string') return null;
        choices.push(c);
    }
    return { question: obj.question, choices };
}

/**
 * Wire the clarification handler onto the supplied stream subscription.
 * Returns an unsubscribe closure the orchestrator host calls from its
 * `stop()` path.
 *
 * The handler emits TaskParked + ClarificationRequested in that order so
 * a subscriber that wants to render the park UI (board, chat-bot) can
 * react to the park first and then enrich with the operator-visible
 * question payload — same emission order the engine uses for its own
 * AgentQuestion-driven park.
 */
export function registerClarificationHandler(deps: ClarificationHandlerDeps): () => void {
    return deps.stream.subscribe(async ({ taskId, stepId, line }) => {
        const parsed = parseNeedsHumanInputLine(line);
        if (parsed === null) {
            // Most stream lines are not clarifications; `debug` keeps the
            // noise out of the info channel while still leaving a
            // breadcrumb when an operator turns up log verbosity to
            // diagnose a clarification that did NOT trigger.
            deps.logger.debug(
                'orchestrator: clarification handler skipped non-needs_human_input line',
                {
                    taskId,
                    stepId,
                    // Cap the sample so a runaway line cannot blow up the
                    // log file.
                    sample: typeof line === 'string' ? line.slice(0, 120) : '',
                },
            );
            return;
        }

        const askedAt = deps.clock();
        const parkedPayload: TaskParkedEventPayload = {
            taskId,
            stepId,
            reason: 'clarification',
            question: parsed.question,
        };
        const parkedEvent: Event = {
            type: TaskParkingEvents.TASK_PARKED,
            v: 1,
            occurredAt: askedAt,
            // Deterministic per (taskId, stepId, askedAt) so a duplicate
            // delivery (replay, double-tail) collapses at the event
            // store rather than parking the task twice. `askedAt` is
            // injected via `deps.clock` so tests get a fully predictable
            // key without poking at the timer.
            idempotencyKey: `clarification:${TaskParkingEvents.TASK_PARKED}:${taskId}:${stepId}:${askedAt}`,
            payload: parkedPayload,
        };

        try {
            await deps.bus.publish(parkedEvent);
        } catch (err) {
            deps.logger.warn('orchestrator: clarification TaskParked publish failed', {
                taskId,
                stepId,
                error: err instanceof Error ? err.message : String(err),
            });
            return;
        }

        const clarificationPayload: ClarificationRequestedPayload =
            parsed.choices !== undefined
                ? {
                      taskId,
                      question: parsed.question,
                      choices: parsed.choices,
                      askedAt,
                  }
                : { taskId, question: parsed.question, askedAt };
        const clarificationEvent: Event = {
            type: CLARIFICATION_REQUESTED_EVENT_TYPE,
            v: 1,
            occurredAt: askedAt,
            idempotencyKey: `clarification:${CLARIFICATION_REQUESTED_EVENT_TYPE}:${taskId}:${stepId}:${askedAt}`,
            payload: clarificationPayload,
        };
        try {
            await deps.bus.publish(clarificationEvent);
        } catch (err) {
            deps.logger.warn(
                'orchestrator: ClarificationRequested publish failed',
                {
                    taskId,
                    stepId,
                    error: err instanceof Error ? err.message : String(err),
                },
            );
        }
    });
}
