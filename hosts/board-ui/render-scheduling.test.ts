/**
 * Field report: "the board is flickering, causing clicks to be missed —
 * decomposing tasks are running, and when I hover a ready plan to start
 * its decomposition the card flickers and the click doesn't always
 * trigger the button."
 *
 * The SSE handler called `scheduleRender()` after every event, and
 * `render()` rebuilds every plan card, task card and section with
 * `replaceChildren`. A running decomposer emits one `AgentProgress` per
 * text delta, so the board rebuilt itself at the rAF ceiling for the whole
 * run. A click only fires when mousedown and mouseup land on the same
 * element; rebuilding the card between them leaves the browser nothing to
 * dispatch on.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { STREAM_ONLY_EVENT_TYPES, needsFullRender } from './render-scheduling';

test('streaming chunks do NOT trigger a full repaint', () => {
    // The flood. These arrive per token and change nothing the board draws.
    assert.equal(needsFullRender('AgentProgress'), false);
    assert.equal(needsFullRender('AgentActivity'), false);
});

test('agent LIFECYCLE events still repaint the board', () => {
    // These flip a status pill, a stage chip and the card's action row,
    // and arrive once per step rather than per token. Treating them as
    // streaming would leave a finished agent showing "running".
    for (const type of ['AgentStarted', 'AgentFinished', 'AgentFailed', 'AgentQuestion']) {
        assert.equal(needsFullRender(type), true, type);
    }
});

test('domain events still repaint the board', () => {
    for (const type of [
        'TaskCreated', 'TaskApproved', 'TaskParked', 'TaskResumed', 'TaskFinished',
        'TaskFailed', 'PlanApproved', 'PlanUpdated', 'PlanDecomposed',
        'ArchitectureProposed', 'DesignVerificationFailed', 'ChatNoteAppended',
    ]) {
        assert.equal(needsFullRender(type), true, type);
    }
});

test('an unknown event type repaints — correct-but-slow is the safe default', () => {
    // A new event that nobody adds here is merely inefficient. One
    // wrongly classified as streaming would be a card that never updates,
    // which is the failure that actually costs the operator something.
    assert.equal(needsFullRender('SomeFutureEvent'), true);
});

test('a missing or empty type repaints rather than being dropped', () => {
    assert.equal(needsFullRender(undefined), true);
    assert.equal(needsFullRender(null), true);
    assert.equal(needsFullRender(''), true);
});

test('the stream-only list stays short and deliberate', () => {
    // Every entry here is a repaint the board will NOT do. Growing this
    // set silently is how a card stops updating, so the list is pinned.
    assert.deepEqual([...STREAM_ONLY_EVENT_TYPES].sort(), [
        'AgentActivity',
        'AgentProgress',
    ]);
});
