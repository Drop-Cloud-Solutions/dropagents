/**
 * Stop agent must never call a running agent finished.
 *
 * Field report: "task D-AHCW-001 still shows the tester agent running,
 * but when I click on Stop agent it says agent already finished".
 *
 * The step record said running (it was — 18 minutes in, confirmed
 * server-side) while the run record's `agentId` was empty, and the old
 * condition treated the two as the same thing:
 *
 *     if (run.status !== 'running' || run.agentId.length === 0)
 *         -> "Agent already finished."
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { decideStopAgent } from './stop-agent-decision';

// --- the field bug ----------------------------------------------------

test('a RUNNING agent with no known run id is not "finished"', () => {
    const d = decideStopAgent({ status: 'running', agentId: '' });
    assert.equal(d.kind, 'unknown-run');
    // assert.equal above narrows the union, so d.message is in scope.
    assert.ok(
        !/finished/i.test(d.message),
        `must not claim the agent finished: ${d.message}`,
    );
});

test('and it tells the operator what to do about it', () => {
    // The old message sent an operator looking for a bug in the agent
    // instead of in the board.
    const d = decideStopAgent({ status: 'running', agentId: '' });
    assert.equal(d.kind, 'unknown-run');
    assert.match(d.message, /still running/i);
    assert.match(d.message, /reload/i);
});

// --- the normal paths -------------------------------------------------

test('a running agent with a run id is cancelled, by that id', () => {
    // Sending the wrong id would signal someone else's process.
    const d = decideStopAgent({
        status: 'running',
        agentId: 'claude-cli-mv7e6ltd-6624-46',
    });
    assert.deepEqual(d, {
        kind: 'cancel',
        agentId: 'claude-cli-mv7e6ltd-6624-46',
    });
});

test('a finished or failed agent reports finished, and sends nothing', () => {
    for (const status of ['complete', 'failed']) {
        const d = decideStopAgent({ status, agentId: 'a-1' });
        assert.equal(d.kind, 'finished', status);
    }
});

test('a finished agent reports finished even WITH a run id', () => {
    // Status wins over the id: cancelling a finished run would signal a
    // pid that may since have been reused.
    assert.equal(decideStopAgent({ status: 'complete', agentId: 'a-1' }).kind, 'finished');
});

test('no run record at all is its own case', () => {
    for (const run of [undefined, null]) {
        const d = decideStopAgent(run);
        assert.equal(d.kind, 'no-run');
        assert.match(d.message, /no active agent/i);
    }
});

// --- the invariant ----------------------------------------------------

test('only a cancel decision ever carries a run id', () => {
    // Every other branch must be unable to send CancelAgentRun, which is
    // what stops a stale board from signalling an unrelated process.
    const cases = [
        { status: 'running', agentId: '' },
        { status: 'complete', agentId: 'a-1' },
        { status: 'failed', agentId: '' },
        { status: 'weird-new-status', agentId: 'a-1' },
    ];
    for (const run of cases) {
        const d = decideStopAgent(run);
        if (d.kind === 'cancel') {
            assert.fail(`${JSON.stringify(run)} must not cancel`);
        }
        assert.ok(d.message.length > 0, 'and every refusal explains itself');
    }
});

test('an unrecognised status is treated as not-running', () => {
    // Fail closed: a status the board does not understand must not send
    // a kill signal.
    assert.equal(decideStopAgent({ status: 'queued', agentId: 'a-1' }).kind, 'finished');
});
