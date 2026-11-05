/**
 * Failed-step chip state (field bug: a failing tester showed green
 * until the operator opened its summary, then went red).
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import {
    applyStepFailure,
    failedStageForStep,
    resolveFailedStepId,
    type StepRecordLike,
} from './step-outcome';

const step = (over: Partial<StepRecordLike> = {}): StepRecordLike => ({
    stepId: 'test',
    role: 'tester',
    status: 'complete',
    startedAt: 1000,
    finishedAt: 2000,
    summary: 'TESTS FAILED: 2 of 14',
    ...over,
});

test('a green step flips to failed without losing the agent output', () => {
    // The AgentFinished fold has already stored the tester's report;
    // the corrective agent.failed must recolour the chip, not blank it.
    const out = applyStepFailure(step(), {
        stepId: 'test',
        role: 'tester',
        reason: 'tester: TESTS FAILED: 2 of 14',
        now: 3000,
    });
    assert.equal(out.status, 'failed');
    assert.equal(out.summary, 'TESTS FAILED: 2 of 14');
    assert.equal(out.startedAt, 1000, 'the original start time survives');
    assert.equal(out.finishedAt, 3000);
    assert.equal(out.role, 'tester');
});

test('with no prior record the failure reason becomes the summary', () => {
    const out = applyStepFailure(undefined, {
        stepId: 'deploy',
        role: 'deployer',
        reason: 'deployer: DEPLOY FAILED: resource group missing',
        now: 500,
    });
    assert.equal(out.status, 'failed');
    assert.equal(out.summary, 'deployer: DEPLOY FAILED: resource group missing');
    assert.equal(out.startedAt, 500);
});

test('an empty reason leaves the summary null rather than blank text', () => {
    const out = applyStepFailure(undefined, { stepId: 'test', reason: '', now: 1 });
    assert.equal(out.summary, null);
    const kept = applyStepFailure(step({ summary: null }), {
        stepId: 'test',
        reason: null,
        now: 1,
    });
    assert.equal(kept.summary, null);
});

test('the role falls back to the one already on the record', () => {
    const out = applyStepFailure(step({ role: 'tester' }), {
        stepId: 'test',
        role: '',
        now: 9,
    });
    assert.equal(out.role, 'tester');
});

// ---------------------------------------------------------------------------

test('an explicit stepId always wins', () => {
    assert.equal(
        resolveFailedStepId('test', [step({ stepId: 'develop', status: 'running' })]),
        'test',
    );
});

test('without a stepId the single running step is used', () => {
    const steps = [
        step({ stepId: 'develop', status: 'complete' }),
        step({ stepId: 'test', status: 'running' }),
    ];
    assert.equal(resolveFailedStepId(undefined, steps), 'test');
});

test('ambiguity reddens nothing', () => {
    // Zero running steps, or several, must not guess — a wrongly
    // reddened chip is worse than a stale one.
    assert.equal(resolveFailedStepId(undefined, []), null);
    assert.equal(
        resolveFailedStepId(undefined, [step({ status: 'complete' })]),
        null,
    );
    assert.equal(
        resolveFailedStepId(undefined, [
            step({ stepId: 'a', status: 'running' }),
            step({ stepId: 'b', status: 'running' }),
        ]),
        null,
    );
    assert.equal(resolveFailedStepId('', [step({ status: 'running' })]), 'test');
});

// ---------------------------------------------------------------------------

test('failed_stage mapping matches what the card understands', () => {
    assert.equal(failedStageForStep('develop'), 'dev');
    assert.equal(failedStageForStep('review'), 'review');
    assert.equal(failedStageForStep('test'), 'test');
    assert.equal(failedStageForStep('commit'), 'commit');
    // Anything else (document, deploy, verify, …) has no card slot of
    // its own and reports as the generic dev stage.
    assert.equal(failedStageForStep('deploy'), 'dev');
});
