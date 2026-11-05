/**
 * Gate-step state (merge-auto / wait-merged / commit-auto / wait-action).
 *
 * Field case: a deploy-nuget task whose merge step is `merge-auto` had
 * already been merged, but the task modal still showed
 * "Merge (auto): pending" — gate steps run no agent, so they never write
 * a task_step_summaries row, and anything reading only those records
 * calls them pending forever. The card's stage bar hid them entirely.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { gateStepState } from './gate-step-state';

const FLOW = ['publish', 'commit', 'merge'];

function state(over: Partial<Parameters<typeof gateStepState>[0]> = {}): string {
    return gateStepState({
        agent: 'merge-auto',
        allStepIds: FLOW,
        stepId: 'merge',
        recordedStepIds: new Set(['publish', 'commit']),
        taskStatus: 'merge',
        parkedReason: null,
        ...over,
    });
}

test('a finished task shows its merge gate as complete (the reported bug)', () => {
    assert.equal(state({ taskStatus: 'done' }), 'complete');
    assert.equal(state({ taskStatus: 'archived' }), 'complete');
});

test('parked ON the gate reads as waiting', () => {
    assert.equal(state({ parkedReason: 'wait-merged' }), 'waiting');
    // wait-merged covers every merge-ish kind, including the auto variant.
    assert.equal(state({ agent: 'wait-merged', parkedReason: 'wait-merged' }), 'waiting');
    assert.equal(
        state({ agent: 'wait-action', stepId: 'gate', parkedReason: 'wait-action' }),
        'waiting',
    );
});

test('a park on a DIFFERENT gate does not mark this one waiting', () => {
    assert.equal(state({ agent: 'merge-auto', parkedReason: 'worktree-diff-review' }), 'pending');
});

test('a recorded LATER step means the flow moved past this gate', () => {
    // commit-auto sits before commit here; a commit record proves it passed.
    assert.equal(
        gateStepState({
            agent: 'commit-auto',
            allStepIds: ['develop', 'commit-gate', 'commit', 'merge'],
            stepId: 'commit-gate',
            recordedStepIds: new Set(['develop', 'commit']),
            taskStatus: 'commit',
            parkedReason: null,
        }),
        'complete',
    );
});

test('an unreached gate is still pending', () => {
    assert.equal(
        state({ recordedStepIds: new Set(['publish']), taskStatus: 'in_progress' }),
        'pending',
    );
});
