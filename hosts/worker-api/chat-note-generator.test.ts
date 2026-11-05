import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { milestoneFor } from './chat-note-generator';
import type { StoredEvent } from '../../core/events/event';

function ev(type: string, payload: Record<string, unknown>): StoredEvent {
    return {
        seq: 1,
        type,
        v: 1,
        occurredAt: 0,
        idempotencyKey: 'k',
        payload,
    } as StoredEvent;
}

test('PlanGenerated → planner-finished note', () => {
    const m = milestoneFor(ev('PlanGenerated', { planId: 'p1' }));
    assert.ok(m);
    assert.match(m.line, /Planner finished/);
    assert.equal(m.action, undefined);
});

test('TaskParked wait-merged → merge note with merge action', () => {
    const m = milestoneFor(ev('TaskParked', { taskId: 'T-1', reason: 'wait-merged' }));
    assert.ok(m);
    assert.deepEqual(m.action, { kind: 'merge', taskId: 'T-1', label: 'Merge PR' });
});

test('TaskParked approval → approve action', () => {
    const m = milestoneFor(ev('TaskParked', { taskId: 'T-1', reason: 'approval' }));
    assert.deepEqual(m?.action, { kind: 'approve', taskId: 'T-1', label: 'Approve' });
});

test('TaskParked worktree-diff-review → review note, no inline action', () => {
    const m = milestoneFor(ev('TaskParked', { taskId: 'T-1', reason: 'worktree-diff-review' }));
    assert.ok(m);
    assert.match(m.line, /ready for your review/);
    assert.equal(m.action, undefined);
});

test('TaskParked waiting-deps → no note (silent)', () => {
    assert.equal(
        milestoneFor(ev('TaskParked', { taskId: 'T-1', reason: 'waiting-deps' })),
        null,
    );
});

test('AgentStarted needs a stepId in metadata', () => {
    assert.equal(milestoneFor(ev('AgentStarted', { taskId: 'T-1', role: 'developer' })), null);
    const m = milestoneFor(ev('AgentStarted', {
        taskId: 'T-1', role: 'developer', metadata: { stepId: 'develop' },
    }));
    assert.ok(m);
    assert.match(m.line, /developer started on T-1/);
});

test('TaskFinished + TaskFailed map to their notes', () => {
    assert.match(milestoneFor(ev('TaskFinished', { taskId: 'T-1' }))!.line, /finished/);
    assert.match(milestoneFor(ev('TaskFailed', { taskId: 'T-1' }))!.line, /failed/);
});

test('unrelated event → null', () => {
    assert.equal(milestoneFor(ev('AgentProgress', { agentId: 'a' })), null);
    assert.equal(milestoneFor(ev('ChatNoteAppended', { sessionId: 's' })), null);
});

test('milestone keys are stable + scoped to the task/plan', () => {
    assert.equal(milestoneFor(ev('TaskFinished', { taskId: 'T-9' }))!.key, 'finished:T-9');
    assert.equal(milestoneFor(ev('PlanGenerated', { planId: 'p9' }))!.key, 'plan-generated:p9');
});
