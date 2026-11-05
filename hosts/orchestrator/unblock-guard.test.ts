/**
 * Dependency-unblock re-dispatch guard (field case: skipping a deployment
 * task released its deploy-verify downstream — which the operator had ALSO
 * skipped — and the verifier spawned anyway, verifying a deployment that
 * never happened).
 *
 * An upstream turning terminal is a GATE RELEASE, never a restart: only
 * pending downstreams (created / approved) may be re-dispatched.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';

import { loadFlow } from '../../core/flow/loader';
import { shouldRedispatchUnblockedTask } from './main';

test('pending statuses re-dispatch; everything else stays put', () => {
    assert.equal(shouldRedispatchUnblockedTask('created'), true);
    assert.equal(shouldRedispatchUnblockedTask('approved'), true);

    for (const status of [
        'skipped', 'dismissed', 'cancelled', 'done', 'failed',
        'failed-final', 'in_progress', 'review', 'test', null,
    ]) {
        assert.equal(
            shouldRedispatchUnblockedTask(status),
            false,
            `status "${status}" must NOT be re-dispatched on unblock`,
        );
    }
});

test('deploy-verify first step requires operator approval', () => {
    const flow = loadFlow(
        path.join(__dirname, '..', '..', 'packs', 'dotnet-azure', 'flows', 'deploy-verify.yaml'),
    );
    assert.equal(flow.steps[0]!.agent, 'deploy-verifier');
    assert.equal(
        flow.steps[0]!.approval,
        'required',
        'the verifier must never auto-run when the dependency gate releases',
    );
});

test('a task parked mid-flow is NOT re-dispatched when its dependency clears', () => {
    // Field case L-MIBO-010: the operator stopped the developer agent, so
    // the task parked with reason 'wait-action'. When its dependency
    // finished, the unblock pass re-dispatched it purely on status
    // ('approved'), clearing the park — leaving a task with no park, no
    // running agent and stale flow_state: neither Resume nor a working
    // start was offered.
    assert.equal(shouldRedispatchUnblockedTask('approved', 'wait-action'), false);
    assert.equal(shouldRedispatchUnblockedTask('approved', 'clarification'), false);
    assert.equal(shouldRedispatchUnblockedTask('created', 'approval'), false);
    assert.equal(shouldRedispatchUnblockedTask('approved', 'worktree-diff-review'), false);
    assert.equal(shouldRedispatchUnblockedTask('approved', 'wait-merged'), false);
});

test('the dependency gate itself still releases', () => {
    // 'waiting-deps' IS the park this pass exists to clear.
    assert.equal(shouldRedispatchUnblockedTask('created', 'waiting-deps'), true);
    assert.equal(shouldRedispatchUnblockedTask('approved', 'waiting-deps'), true);
    // Unparked pending tasks keep working as before.
    assert.equal(shouldRedispatchUnblockedTask('created', null), true);
    assert.equal(shouldRedispatchUnblockedTask('approved', undefined), true);
    // A terminal status still wins over any park value.
    assert.equal(shouldRedispatchUnblockedTask('skipped', 'waiting-deps'), false);
});
