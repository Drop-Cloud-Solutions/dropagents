import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import type { IdGen } from '../ports/IdGen';
import type { Command } from './command';

import {
    InvestigationCommands,
    InvestigationEvents,
    InMemoryInvestigationReportStore,
    createDismissInvestigationHandler,
    createImplementFromInvestigationHandler,
    isDismissInvestigationPayload,
    isImplementFromInvestigationPayload,
    type DismissInvestigationPayload,
    type ImplementFromInvestigationPayload,
    type ImplementTaskCreatedPayload,
    type InvestigationDismissedEventPayload,
} from './index';

function fakeIdGen(): IdGen {
    let n = 0;
    return { newId: (): string => `task-new-${++n}` };
}

function fixedClock(start = 1_700_000_000_000): () => number {
    let t = start;
    return (): number => t++;
}

function makeCommand<TPayload>(
    type: string,
    payload: TPayload,
    actor = 'operator-1',
): Command<TPayload> {
    return {
        type,
        actor,
        issuedAt: 1_700_000_000_000,
        payload,
    };
}

// ---------------------------------------------------------------------------
// Validation (AC #1)
// ---------------------------------------------------------------------------

test('isImplementFromInvestigationPayload accepts {taskId, reportId}', () => {
    assert.equal(
        isImplementFromInvestigationPayload({ taskId: 't', reportId: 'r' }),
        true,
    );
});

test('isImplementFromInvestigationPayload rejects missing or wrong-typed fields', () => {
    assert.equal(isImplementFromInvestigationPayload(null), false);
    assert.equal(isImplementFromInvestigationPayload('s'), false);
    assert.equal(isImplementFromInvestigationPayload({}), false);
    assert.equal(isImplementFromInvestigationPayload({ taskId: 't' }), false);
    assert.equal(
        isImplementFromInvestigationPayload({ taskId: 1, reportId: 'r' }),
        false,
    );
    assert.equal(
        isImplementFromInvestigationPayload({ taskId: 't', reportId: 7 }),
        false,
    );
});

test('isDismissInvestigationPayload accepts optional string reason', () => {
    assert.equal(
        isDismissInvestigationPayload({ taskId: 't', reportId: 'r' }),
        true,
    );
    assert.equal(
        isDismissInvestigationPayload({ taskId: 't', reportId: 'r', reason: 'duplicate' }),
        true,
    );
});

test('isDismissInvestigationPayload rejects non-string reason and missing required fields', () => {
    assert.equal(isDismissInvestigationPayload(null), false);
    assert.equal(
        isDismissInvestigationPayload({ taskId: 't', reportId: 'r', reason: 5 }),
        false,
    );
    assert.equal(
        isDismissInvestigationPayload({ taskId: 't' }),
        false,
    );
});

// ---------------------------------------------------------------------------
// InMemoryInvestigationReportStore — keyed by (taskId, reportId)
// ---------------------------------------------------------------------------

test('InMemoryInvestigationReportStore round-trips reports independently per task and per report', () => {
    const store = new InMemoryInvestigationReportStore();
    store.record('t1', 'r1', { markdown: 'one' });
    store.record('t1', 'r2', { markdown: 'two' });
    store.record('t2', 'r1', { markdown: 'three' });

    assert.deepEqual(store.get('t1', 'r1'), { markdown: 'one' });
    assert.deepEqual(store.get('t1', 'r2'), { markdown: 'two' });
    assert.deepEqual(store.get('t2', 'r1'), { markdown: 'three' });
    assert.equal(store.get('t1', 'missing'), undefined);
    assert.equal(store.get('missing', 'r1'), undefined);
});

// ---------------------------------------------------------------------------
// ImplementFromInvestigation handler (AC #4)
// ---------------------------------------------------------------------------

test('ImplementFromInvestigation emits a TaskCreated with the report markdown as planBody', async () => {
    const reports = new InMemoryInvestigationReportStore();
    reports.record('task-1', 'report-7', {
        markdown: '# Recommended action\n- bump x\n',
    });

    const handler = createImplementFromInvestigationHandler({
        clock: fixedClock(1_700_000_000_500),
        idGen: fakeIdGen(),
        reports,
        scaffoldFlowId: 'scaffold',
        scaffoldTaskType: 'scaffold',
    });

    const events = await handler(
        makeCommand<ImplementFromInvestigationPayload>(
            InvestigationCommands.IMPLEMENT_FROM_INVESTIGATION,
            { taskId: 'task-1', reportId: 'report-7' },
        ),
        undefined,
    );

    assert.equal(events.length, 1);
    const e = events[0];
    assert.equal(e.type, InvestigationEvents.TASK_CREATED);
    assert.equal(e.occurredAt, 1_700_000_000_500);

    const payload = e.payload as ImplementTaskCreatedPayload;
    assert.equal(payload.planBody, '# Recommended action\n- bump x\n');
    assert.equal(payload.flowId, 'scaffold');
    assert.equal(payload.type, 'scaffold');
    assert.equal(payload.sourceTaskId, 'task-1');
    assert.equal(payload.sourceReportId, 'report-7');
    assert.equal(payload.taskId, 'task-new-1');
    assert.equal(payload.planId, 'task-1');
});

test('ImplementFromInvestigation routes onto a custom scaffold flow/type when configured', async () => {
    const reports = new InMemoryInvestigationReportStore();
    reports.record('task-9', 'r-1', { markdown: 'body' });

    const handler = createImplementFromInvestigationHandler({
        clock: fixedClock(),
        idGen: fakeIdGen(),
        reports,
        scaffoldFlowId: 'custom-flow',
        scaffoldTaskType: 'custom-type',
        planIdFor: (sourceTaskId): string => `plan-of-${sourceTaskId}`,
    });

    const events = await handler(
        makeCommand<ImplementFromInvestigationPayload>(
            InvestigationCommands.IMPLEMENT_FROM_INVESTIGATION,
            { taskId: 'task-9', reportId: 'r-1' },
        ),
        undefined,
    );

    const payload = events[0].payload as ImplementTaskCreatedPayload;
    assert.equal(payload.flowId, 'custom-flow');
    assert.equal(payload.type, 'custom-type');
    assert.equal(payload.planId, 'plan-of-task-9');
});

test('ImplementFromInvestigation throws when no report exists for (taskId, reportId)', async () => {
    const reports = new InMemoryInvestigationReportStore();
    const handler = createImplementFromInvestigationHandler({
        clock: fixedClock(),
        idGen: fakeIdGen(),
        reports,
        scaffoldFlowId: 'scaffold',
        scaffoldTaskType: 'scaffold',
    });

    await assert.rejects(
        () =>
            handler(
                makeCommand<ImplementFromInvestigationPayload>(
                    InvestigationCommands.IMPLEMENT_FROM_INVESTIGATION,
                    { taskId: 'task-x', reportId: 'missing' },
                ),
                undefined,
            ),
        /no report/i,
    );
});

test('ImplementFromInvestigation rejects malformed payloads', async () => {
    const reports = new InMemoryInvestigationReportStore();
    const handler = createImplementFromInvestigationHandler({
        clock: fixedClock(),
        idGen: fakeIdGen(),
        reports,
        scaffoldFlowId: 'scaffold',
        scaffoldTaskType: 'scaffold',
    });

    await assert.rejects(
        () =>
            handler(
                {
                    type: InvestigationCommands.IMPLEMENT_FROM_INVESTIGATION,
                    actor: 'op',
                    issuedAt: 0,
                    payload: { taskId: 'only-task' } as unknown as ImplementFromInvestigationPayload,
                },
                undefined,
            ),
        /invalid payload/i,
    );
});

test('ImplementFromInvestigation uses a deterministic idempotency key per (taskId, reportId)', async () => {
    const reports = new InMemoryInvestigationReportStore();
    reports.record('task-1', 'report-7', { markdown: 'body' });

    const handler = createImplementFromInvestigationHandler({
        clock: fixedClock(),
        idGen: fakeIdGen(),
        reports,
        scaffoldFlowId: 'scaffold',
        scaffoldTaskType: 'scaffold',
    });

    const first = await handler(
        makeCommand(InvestigationCommands.IMPLEMENT_FROM_INVESTIGATION, {
            taskId: 'task-1',
            reportId: 'report-7',
        }),
        undefined,
    );
    const second = await handler(
        makeCommand(InvestigationCommands.IMPLEMENT_FROM_INVESTIGATION, {
            taskId: 'task-1',
            reportId: 'report-7',
        }),
        undefined,
    );
    assert.equal(first[0].idempotencyKey, second[0].idempotencyKey);
});

// ---------------------------------------------------------------------------
// DismissInvestigation handler (AC #7)
// ---------------------------------------------------------------------------

test('DismissInvestigation emits InvestigationDismissed and persists the supplied reason', async () => {
    const handler = createDismissInvestigationHandler({ clock: fixedClock() });
    const events = await handler(
        makeCommand<DismissInvestigationPayload>(
            InvestigationCommands.DISMISS_INVESTIGATION,
            { taskId: 'task-1', reportId: 'r-9', reason: 'not relevant' },
            'operator-42',
        ),
        undefined,
    );

    assert.equal(events.length, 1);
    const e = events[0];
    assert.equal(e.type, InvestigationEvents.INVESTIGATION_DISMISSED);

    const payload = e.payload as InvestigationDismissedEventPayload;
    assert.equal(payload.taskId, 'task-1');
    assert.equal(payload.reportId, 'r-9');
    assert.equal(payload.reason, 'not relevant');
    assert.equal(payload.actor, 'operator-42');
});

test('DismissInvestigation omits reason from the event payload when none was given', async () => {
    const handler = createDismissInvestigationHandler({ clock: fixedClock() });
    const events = await handler(
        makeCommand<DismissInvestigationPayload>(
            InvestigationCommands.DISMISS_INVESTIGATION,
            { taskId: 'task-1', reportId: 'r-9' },
        ),
        undefined,
    );
    const payload = events[0].payload as Record<string, unknown>;
    assert.equal(
        Object.prototype.hasOwnProperty.call(payload, 'reason'),
        false,
        'no reason supplied → no reason key on the event',
    );
});

test('DismissInvestigation rejects malformed payloads', async () => {
    const handler = createDismissInvestigationHandler({ clock: fixedClock() });
    await assert.rejects(
        () =>
            handler(
                {
                    type: InvestigationCommands.DISMISS_INVESTIGATION,
                    actor: 'op',
                    issuedAt: 0,
                    payload: { taskId: 't', reportId: 'r', reason: 9 } as unknown as DismissInvestigationPayload,
                },
                undefined,
            ),
        /invalid payload/i,
    );
});

test('DismissInvestigation uses a deterministic idempotency key per (taskId, reportId)', async () => {
    const handler = createDismissInvestigationHandler({ clock: fixedClock() });
    const first = await handler(
        makeCommand(InvestigationCommands.DISMISS_INVESTIGATION, {
            taskId: 't',
            reportId: 'r',
        }),
        undefined,
    );
    const second = await handler(
        makeCommand(InvestigationCommands.DISMISS_INVESTIGATION, {
            taskId: 't',
            reportId: 'r',
            reason: 'changed mind',
        }),
        undefined,
    );
    assert.equal(first[0].idempotencyKey, second[0].idempotencyKey);
});
