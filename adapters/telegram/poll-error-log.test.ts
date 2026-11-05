/**
 * Field incident: a second bot instance was polling the same token, so
 * every `getUpdates` lost the race and logged the same conflict. At one
 * failure per poll cycle that filled the entire 500-line warning window
 * with one repeated message — and buried the line that mattered: an
 * expired Claude CLI credential breaking every agent spawn. The operator
 * was told free-text chat "isn't configured" and went looking for a
 * feature that had shipped a month earlier.
 *
 * A recurring fault must stay visible without evicting everything else.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { PollErrorLog, pollErrorHint } from './poll-error-log';

const CONFLICT =
    'Telegram getUpdates failed: Conflict: terminated by other getUpdates request; '
    + 'make sure that only one bot instance is running';

function at(times: number[]): () => number {
    let i = 0;
    return () => times[Math.min(i++, times.length - 1)]!;
}

test('the first failure is always logged, with a hint naming the fix', () => {
    const log = new PollErrorLog({ now: () => 0 });
    const decision = log.record(CONFLICT);

    assert.equal(decision.kind, 'log');
    assert.ok(decision.kind === 'log' && decision.message.includes('Conflict'));
    // The raw API error says nothing about what to DO, and nothing in this
    // process can resolve it — so the log line has to carry the fix.
    assert.match(
        (decision as { hint?: string }).hint ?? '',
        /Another bot instance is polling the same token/,
    );
});

test('identical repeats inside the window are suppressed', () => {
    const log = new PollErrorLog({ repeatAfterMs: 1000, now: at([0, 100, 200, 300]) });
    assert.equal(log.record(CONFLICT).kind, 'log');
    assert.equal(log.record(CONFLICT).kind, 'suppress');
    assert.equal(log.record(CONFLICT).kind, 'suppress');
    assert.equal(log.record(CONFLICT).kind, 'suppress');
});

test('a periodic repeat reports how many were suppressed', () => {
    // Suppression must not become silence: an outage that is still going
    // an hour later has to keep saying so.
    const log = new PollErrorLog({ repeatAfterMs: 1000, now: at([0, 100, 200, 5000]) });
    log.record(CONFLICT);
    log.record(CONFLICT);
    log.record(CONFLICT);

    const decision = log.record(CONFLICT);
    assert.equal(decision.kind, 'log');
    assert.ok(decision.kind === 'log' && /2 identical failures suppressed/.test(decision.message));
    assert.ok(decision.kind === 'log' && /still failing after/.test(decision.message));
});

test('a DIFFERENT error logs immediately, even mid-storm', () => {
    // The whole point. A token rejection arriving during a conflict storm
    // must not be folded away as "more of the same" — that is exactly how
    // the expired credential stayed invisible.
    const log = new PollErrorLog({ repeatAfterMs: 60_000, now: at([0, 10, 20]) });
    assert.equal(log.record(CONFLICT).kind, 'log');
    assert.equal(log.record(CONFLICT).kind, 'suppress');

    const other = log.record('Telegram getUpdates failed: 401 Unauthorized');
    assert.equal(other.kind, 'log');
    assert.match((other as { hint?: string }).hint ?? '', /bot token was rejected/i);
});

test('a successful poll resets the window so the next outage logs at once', () => {
    const log = new PollErrorLog({ repeatAfterMs: 60_000, now: at([0, 10, 20, 30]) });
    log.record(CONFLICT);
    assert.equal(log.record(CONFLICT).kind, 'suppress');

    log.clear();

    // A new outage minutes later is a new event, not the tail of the old
    // one — folding it into an hours-old window would hide a fresh fault.
    assert.equal(log.record(CONFLICT).kind, 'log');
});

test('an error with no known cause is logged without an invented hint', () => {
    const log = new PollErrorLog({ now: () => 0 });
    const decision = log.record('socket hang up');
    assert.equal(decision.kind, 'log');
    assert.equal((decision as { hint?: string }).hint, undefined);
});

test('whitespace differences do not defeat the suppression', () => {
    // The API repeats the same string; trailing whitespace variation
    // would otherwise re-log it every cycle and defeat the whole point.
    const log = new PollErrorLog({ repeatAfterMs: 60_000, now: at([0, 10]) });
    log.record(CONFLICT);
    assert.equal(log.record(`  ${CONFLICT}  `).kind, 'suppress');
});

test('pollErrorHint is exported and matches the two known causes', () => {
    assert.match(pollErrorHint(CONFLICT) ?? '', /only one/i);
    assert.match(pollErrorHint('401 Unauthorized') ?? '', /TELEGRAM_BOT_TOKEN_V2/);
    assert.equal(pollErrorHint('ETIMEDOUT'), undefined);
});
