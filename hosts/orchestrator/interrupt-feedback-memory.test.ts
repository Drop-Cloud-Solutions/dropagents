/**
 * `interrupt-retry` is one of the three agent-memory sources that were
 * declared in the enum and never written by anything.
 *
 * The operator stops an agent going the wrong way, types what it should
 * have done instead, and hits Retry. That is the most pointed feedback the
 * pipeline ever gets, and it reached that one task's next prompt and
 * nowhere else — the next plan for the same project was written as if it
 * had never happened.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import {
    attachInterruptFeedbackMemory,
    INTERRUPT_FEEDBACK_MEMORY_SUBSCRIBER,
    type FeedbackMemoryBus,
} from './interrupt-feedback-memory';

interface Appended {
    readonly projectId: string;
    readonly source: string;
    readonly taskIdentifier: string;
    readonly taskTitle: string;
    readonly feedback: string;
}

interface Harness {
    readonly emit: (type: string, payload: Record<string, unknown>) => void;
    readonly appended: Appended[];
    readonly warnings: string[];
    readonly subscriberNames: string[];
}

function harness(opts: { knownTask?: boolean; throwOnAppend?: boolean } = {}): Harness {
    const handlers = new Map<string, Array<(e: { payload: unknown }) => void>>();
    const appended: Appended[] = [];
    const warnings: string[] = [];
    const subscriberNames: string[] = [];

    const bus: FeedbackMemoryBus = {
        subscribe: (type, handler, o): void => {
            subscriberNames.push(o.subscriber);
            const list = handlers.get(type) ?? [];
            list.push(handler as (e: { payload: unknown }) => void);
            handlers.set(type, list);
        },
    };

    attachInterruptFeedbackMemory({
        bus,
        memory: {
            append: (projectId, entry): void => {
                if (opts.throwOnAppend) throw new Error('disk full');
                appended.push({ projectId, ...entry });
            },
        },
        tasks: {
            lookup: (taskId) => (opts.knownTask === false
                ? undefined
                : { projectId: 'proj-1', title: `Title of ${taskId}` }),
        },
        logger: {
            info: () => undefined,
            warn: (msg: string) => { warnings.push(msg); },
            error: () => undefined,
            debug: () => undefined,
        } as never,
        clock: () => 1_700_000_000_000,
    });

    return {
        emit: (type, payload): void => {
            for (const h of handlers.get(type) ?? []) h({ payload });
        },
        appended,
        warnings,
        subscriberNames,
    };
}

test('interrupt then retry-with-feedback records an interrupt-retry entry', () => {
    // The modal's two dispatches, in order.
    const h = harness();
    h.emit('TaskInterrupted', { taskId: 'T-1' });
    h.emit('TaskFieldsUpdated', { taskId: 'T-1', description: 'Keep the old API surface.' });

    assert.deepEqual(h.appended, [{
        projectId: 'proj-1',
        source: 'interrupt-retry',
        taskIdentifier: 'T-1',
        taskTitle: 'Title of T-1',
        feedback: 'Keep the old API surface.',
        recordedAt: 1_700_000_000_000,
    } as Appended]);
});

test('an ordinary edit — no interrupt first — records NOTHING', () => {
    // EditTask is the generic edit command; the edit-task modal uses it
    // too. Filing every title tweak as "prior operator feedback" would
    // drown the real corrections in the planner's prompt.
    const h = harness();
    h.emit('TaskFieldsUpdated', { taskId: 'T-1', description: 'A clearer description.' });

    assert.deepEqual(h.appended, []);
});

test('the mark is consumed — a later edit of the same task is not feedback', () => {
    const h = harness();
    h.emit('TaskInterrupted', { taskId: 'T-1' });
    h.emit('TaskFieldsUpdated', { taskId: 'T-1', description: 'first' });
    h.emit('TaskFieldsUpdated', { taskId: 'T-1', description: 'second' });

    assert.equal(h.appended.length, 1);
    assert.equal(h.appended[0].feedback, 'first');
});

test('restarting the task clears the mark', () => {
    // Interrupt, then let it run again without retry feedback. Whatever
    // the operator edits after that is an ordinary edit.
    for (const restartEvent of ['AgentStarted', 'TaskResumed']) {
        const h = harness();
        h.emit('TaskInterrupted', { taskId: 'T-1' });
        h.emit(restartEvent, { taskId: 'T-1' });
        h.emit('TaskFieldsUpdated', { taskId: 'T-1', description: 'later edit' });

        assert.deepEqual(h.appended, [], restartEvent);
    }
});

test('a title-only edit does not consume the mark', () => {
    // The operator may still be on the modal's second step.
    const h = harness();
    h.emit('TaskInterrupted', { taskId: 'T-1' });
    h.emit('TaskFieldsUpdated', { taskId: 'T-1', title: 'Renamed' });
    h.emit('TaskFieldsUpdated', { taskId: 'T-1', description: 'the real feedback' });

    assert.equal(h.appended.length, 1);
    assert.equal(h.appended[0].feedback, 'the real feedback');
});

test('whitespace-only feedback is not recorded', () => {
    const h = harness();
    h.emit('TaskInterrupted', { taskId: 'T-1' });
    h.emit('TaskFieldsUpdated', { taskId: 'T-1', description: '   \n  ' });

    assert.deepEqual(h.appended, []);
});

test('an interrupt on one task does not arm another', () => {
    const h = harness();
    h.emit('TaskInterrupted', { taskId: 'T-1' });
    h.emit('TaskFieldsUpdated', { taskId: 'T-2', description: 'unrelated edit' });

    assert.deepEqual(h.appended, []);
});

test('an unresolvable task WARNS rather than dropping the feedback in silence', () => {
    const h = harness({ knownTask: false });
    h.emit('TaskInterrupted', { taskId: 'T-1' });
    h.emit('TaskFieldsUpdated', { taskId: 'T-1', description: 'feedback' });

    assert.deepEqual(h.appended, []);
    assert.ok(h.warnings.some((w) => /no project for interrupted task/.test(w)));
});

test('an append failure is contained — a memory write never breaks the retry', () => {
    const h = harness({ throwOnAppend: true });
    h.emit('TaskInterrupted', { taskId: 'T-1' });
    h.emit('TaskFieldsUpdated', { taskId: 'T-1', description: 'feedback' });

    assert.ok(h.warnings.some((w) => /append failed/.test(w)));
});

test('every subscription is registered under the one named subscriber', () => {
    // The name is what puts it in LIVE_ONLY_SUBSCRIBERS. If a subscription
    // registered anonymously, its offset would not be reconciled and a
    // boot replay could re-file history as fresh feedback.
    const h = harness();
    assert.ok(h.subscriberNames.length >= 4);
    for (const name of h.subscriberNames) {
        assert.equal(name, INTERRUPT_FEEDBACK_MEMORY_SUBSCRIBER);
    }
});
