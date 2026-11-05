/**
 * Field report: "when chatting in modal form of plan or architecture
 * design there is no stop button to interrupt an agent."
 *
 * The main chat modal has had one from the start; the scoped pane in the
 * plan / design modals had none, so a design chat going the wrong way
 * could only be waited out or closed — and closing left the `claude`
 * process running with nobody reading it.
 *
 * Giving the pane a Stop button meant the two surfaces had to agree on
 * these two things, which is why they live in one module.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { chatStopUrl, isOperatorStop } from './chat-stop';

test('the stop URL encodes the session id', () => {
    // Telegram-seeded ids are `telegram:<userId>[:<repoId>]`. A raw colon
    // in the path segment does not round-trip through the worker's
    // decodeSessionId, so an unencoded stop would address a session that
    // does not exist — 200 {stopped:false}, agent still running, UI
    // claiming it stopped.
    assert.equal(
        chatStopUrl('http://localhost:4000', 'telegram:8621:shop'),
        'http://localhost:4000/api/chat/sessions/telegram%3A8621%3Ashop/stop',
    );
});

test('an ordinary session id passes through unchanged', () => {
    assert.equal(
        chatStopUrl('', 'sess-123'),
        '/api/chat/sessions/sess-123/stop',
    );
});

test('an AbortError is recognised whichever class the runtime threw', () => {
    // The two surfaces guessed differently — one tested `Error`, the
    // other `DOMException` — and both are guesses: a fetch abort is a
    // DOMException in browsers and an Error in undici.
    const asError = new Error('The operation was aborted');
    asError.name = 'AbortError';
    assert.equal(isOperatorStop(asError), true);

    assert.equal(isOperatorStop({ name: 'AbortError' }), true);

    if (typeof DOMException === 'function') {
        assert.equal(isOperatorStop(new DOMException('aborted', 'AbortError')), true);
    }
});

test('a real failure is NOT mistaken for a stop', () => {
    // The consequence of getting this backwards is a network error
    // rendered as "(stopped)" — the operator reads a broken turn as one
    // they cancelled themselves and never retries it.
    assert.equal(isOperatorStop(new Error('fetch failed')), false);
    assert.equal(isOperatorStop(new TypeError('Failed to fetch')), false);
});

test('non-object throws do not crash the classifier', () => {
    for (const value of [undefined, null, 'AbortError', 42, false]) {
        assert.equal(isOperatorStop(value), false, String(value));
    }
});
