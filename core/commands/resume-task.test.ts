import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createResumeTaskHandler, TaskParkingEvents } from './index';
import type { Command } from './command';
import type { ResumeTaskPayload, TaskResumedEventPayload } from './index';

function makeCmd(
    payload: ResumeTaskPayload,
    actor = 'operator-1',
): Command<ResumeTaskPayload> {
    return {
        type: 'ResumeTask',
        actor,
        issuedAt: 1_700_000_000_000,
        payload,
    };
}

// ---------------------------------------------------------------------------
// AP-VP-002 — the three explicit decision/feedback cases.
//
// task-006 wires the engine routing (approve -> on_success, reject ->
// on_failure with feedback persisted on the task record). At this stage we
// only assert the command-construction path: payload validation accepts the
// new shape and the handler forwards `decision` + `feedback` onto the
// TaskResumed event so the downstream branch has the operator's verdict to
// work with.
// ---------------------------------------------------------------------------

test('createResumeTaskHandler: approve emits a TaskResumed event carrying decision=approve', async () => {
    const handler = createResumeTaskHandler({ clock: () => 1_700_000_001_234 });
    const events = await handler(
        makeCmd({
            taskId: 'task-A',
            decision: 'approve',
            answer: 'use option A',
            optionKey: 'A',
        }),
        undefined,
    );

    assert.equal(events.length, 1);
    const ev = events[0];
    assert.equal(ev.type, TaskParkingEvents.TASK_RESUMED);
    assert.equal(ev.occurredAt, 1_700_000_001_234);
    const payload = ev.payload as TaskResumedEventPayload;
    assert.equal(payload.taskId, 'task-A');
    assert.equal(payload.actor, 'operator-1');
    assert.equal(payload.decision, 'approve');
    assert.equal(payload.answer, 'use option A');
    assert.equal(payload.optionKey, 'A');
    assert.ok(
        !('feedback' in (payload as unknown as Record<string, unknown>)),
        'feedback must not be present on approve',
    );
});

test('createResumeTaskHandler: reject without feedback emits decision=reject and omits feedback', async () => {
    const handler = createResumeTaskHandler({ clock: () => 1_700_000_001_234 });
    const events = await handler(
        makeCmd({ taskId: 'task-B', decision: 'reject' }),
        undefined,
    );

    assert.equal(events.length, 1);
    const payload = events[0].payload as Record<string, unknown>;
    assert.equal(payload.taskId, 'task-B');
    assert.equal(payload.actor, 'operator-1');
    assert.equal(payload.decision, 'reject');
    assert.ok(!('feedback' in payload), 'feedback must be omitted when not supplied');
    assert.ok(!('answer' in payload), 'answer must be omitted when not supplied');
    assert.ok(!('optionKey' in payload), 'optionKey must be omitted when not supplied');
});

test('createResumeTaskHandler: reject with feedback persists the feedback string verbatim', async () => {
    const handler = createResumeTaskHandler({ clock: () => 1_700_000_001_234 });
    const events = await handler(
        makeCmd({
            taskId: 'task-C',
            decision: 'reject',
            feedback: 'please rerun with the staging credentials',
        }),
        undefined,
    );

    assert.equal(events.length, 1);
    const payload = events[0].payload as TaskResumedEventPayload;
    assert.equal(payload.taskId, 'task-C');
    assert.equal(payload.decision, 'reject');
    assert.equal(payload.feedback, 'please rerun with the staging credentials');
});

// ---------------------------------------------------------------------------
// Validation / idempotency invariants — preserved from the original suite.
// ---------------------------------------------------------------------------

test('createResumeTaskHandler: idempotencyKey is deterministic per (taskId, issuedAt)', async () => {
    const handler = createResumeTaskHandler({ clock: () => 1_700_000_000_000 });
    const a = await handler(
        makeCmd({ taskId: 'task-Z', decision: 'approve' }),
        undefined,
    );
    const b = await handler(
        makeCmd({ taskId: 'task-Z', decision: 'approve' }),
        undefined,
    );
    assert.equal(a[0].idempotencyKey, b[0].idempotencyKey);
    assert.match(a[0].idempotencyKey, /^ResumeTask:task-Z:/);
});

test('createResumeTaskHandler: rejects malformed payload', async () => {
    const handler = createResumeTaskHandler({ clock: () => 1_700_000_000_000 });
    // Empty taskId.
    await assert.rejects(
        handler(
            {
                type: 'ResumeTask',
                actor: 'o',
                issuedAt: 0,
                payload: { taskId: '', decision: 'approve' } as ResumeTaskPayload,
            },
            undefined,
        ),
        /invalid payload/,
    );
    // Missing decision (a compile error in TS — cast through unknown to
    // assert the runtime guard catches dynamic callers / replay).
    await assert.rejects(
        handler(
            {
                type: 'ResumeTask',
                actor: 'o',
                issuedAt: 0,
                payload: { taskId: 't' } as unknown as ResumeTaskPayload,
            },
            undefined,
        ),
        /invalid payload/,
    );
    // Bogus decision value.
    await assert.rejects(
        handler(
            {
                type: 'ResumeTask',
                actor: 'o',
                issuedAt: 0,
                payload: {
                    taskId: 't',
                    decision: 'maybe',
                } as unknown as ResumeTaskPayload,
            },
            undefined,
        ),
        /invalid payload/,
    );
});
