/**
 * The terminal `result` frame's error text must survive the parser.
 *
 * It used to keep only `subtype`, so an API-level rejection reached the
 * orchestrator as the bare string `error_during_execution` — and since
 * that is the ONLY copy of why a run was refused (the prompt is not
 * logged, the stdout is not persisted), the reason was simply gone.
 *
 * The CLI is not consistent about which field carries the message, hence
 * the tolerance below: guessing one field name wrong costs the operator
 * the whole explanation.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { parseLine, type ParsedStreamEvent } from './streamParser';

type FinishedEvent = Extract<ParsedStreamEvent, { kind: 'finished' }>;

function finished(env: Record<string, unknown>): FinishedEvent {
    const [ev] = parseLine(JSON.stringify({ type: 'result', ...env }));
    assert.ok(ev, 'a result frame produces an event');
    assert.equal(ev!.kind, 'finished');
    return ev as FinishedEvent;
}

const FLAGGED = "API Error: Opus 5's safeguards flagged this message";

test('a failing frame carries its message through', () => {
    const ev = finished({ subtype: 'error_during_execution', result: FLAGGED });
    assert.equal(ev.outcome, 'error_during_execution');
    assert.equal(ev.detail, FLAGGED);
});

test('the message is found wherever the CLI put it', () => {
    // Three shapes seen in the wild, plus the nested object form.
    assert.equal(finished({ subtype: 'error', result: FLAGGED }).detail, FLAGGED);
    assert.equal(finished({ subtype: 'error', error: FLAGGED }).detail, FLAGGED);
    assert.equal(finished({ subtype: 'error', message: FLAGGED }).detail, FLAGGED);
    assert.equal(
        finished({ subtype: 'error', error: { message: FLAGGED } }).detail,
        FLAGGED,
    );
});

test('a SUCCESS frame does not duplicate the reply', () => {
    // On success `result` is the full final text, which AgentFinished
    // already carries as `content`. Copying it here would put a second
    // copy of every reply on the event bus.
    const ev = finished({ subtype: 'success', result: 'the entire plan document…' });
    assert.equal(ev.outcome, 'success');
    assert.equal(ev.detail, undefined);
});

test('a failing frame with no message still parses', () => {
    // The subtype alone is thin, but it must not throw or vanish — the
    // card has to stop showing "in progress" either way.
    const ev = finished({ subtype: 'error_max_turns' });
    assert.equal(ev.outcome, 'error_max_turns');
    assert.equal(ev.detail, undefined);
});

test('blank and non-string messages are treated as absent', () => {
    assert.equal(finished({ subtype: 'error', result: '   ' }).detail, undefined);
    assert.equal(finished({ subtype: 'error', error: 42 }).detail, undefined);
    assert.equal(finished({ subtype: 'error', error: null }).detail, undefined);
    assert.equal(finished({ subtype: 'error', error: {} }).detail, undefined);
});

test('a missing subtype still defaults to success', () => {
    // Pre-existing behaviour, pinned so the new branch cannot change it.
    const ev = finished({ result: 'done' });
    assert.equal(ev.outcome, 'success');
    assert.equal(ev.detail, undefined);
});
