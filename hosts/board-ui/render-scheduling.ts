/**
 * Which events need a full board repaint, and which only feed a modal.
 *
 * The board's SSE handler called `scheduleRender()` after EVERY event.
 * `render()` rebuilds the plan cards, the task cards, every section and
 * the plan tree — `replaceChildren` throughout — so the entire board's
 * DOM was thrown away and recreated on each one.
 *
 * That is fine at the rate domain events arrive. It is not fine while an
 * agent is streaming: the runner spawns with `--include-partial-messages`,
 * so a running decomposer emits an `AgentProgress` per text delta, and the
 * board rebuilt itself at the rAF ceiling for the whole run.
 *
 * Reported symptom, and it is worse than cosmetic: the plan cards flicker,
 * and clicking a button on one often does nothing. A click only fires when
 * mousedown and mouseup land on the SAME element — rebuild the card between
 * them and the browser has nothing to dispatch on. The operator is left
 * clicking "Decompose" repeatedly while the board looks broken.
 *
 * The fix is to notice that these streaming events change nothing the board
 * itself draws. The active-planner and active-decomposer cards render a
 * title, a model tag and a status pill — status comes from
 * `AgentStarted` / `AgentFinished`, never from a chunk. The chunks feed the
 * agent-stream MODALS, which have their own refreshers, and each of those
 * early-returns when its modal is closed. So with no modal open a streaming
 * chunk becomes literally no DOM work.
 */

/**
 * Events that only feed the agent-stream modals.
 *
 * Deliberately a short, closed list. Anything not named here gets the full
 * repaint, so a new event type is correct-but-slow by default rather than
 * silently missing from the board — the failure that matters is a card
 * that never updates, not one that updates too often.
 */
export const STREAM_ONLY_EVENT_TYPES: ReadonlySet<string> = new Set([
    'AgentProgress',
    'AgentActivity',
]);

/**
 * True when this event needs a full `render()`.
 *
 * `AgentStarted` / `AgentFinished` / `AgentFailed` are NOT in the
 * stream-only set on purpose: they flip a status pill, a stage chip and
 * the card's action row, and they arrive once per step rather than per
 * token.
 */
export function needsFullRender(eventType: string | null | undefined): boolean {
    if (typeof eventType !== 'string' || eventType.length === 0) return true;
    return !STREAM_ONLY_EVENT_TYPES.has(eventType);
}
