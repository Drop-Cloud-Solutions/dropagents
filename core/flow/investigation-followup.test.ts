/**
 * AP-IFG-007: unit tests for the `RequestInvestigationFollowup` handler.
 *
 *   - Happy path: operator entry appended on entry, investigator entry
 *     appended on success, `followup_inflight` flips true→false around
 *     the agent run, single event emitted.
 *   - Re-entry rejection: second command while a run is in flight is
 *     rejected without invoking the investigator a second time.
 *   - Agent failure: `followup_inflight` is cleared, no investigator
 *     entry is appended, the original error propagates.
 *
 * Dual-runner discovery
 * ---------------------
 * The repo's own test command (`npm test`) uses Node's built-in
 * `node:test`. The review pipeline runs `npx vitest run` against the
 * changed test file. To stay discoverable by both runners from a single
 * source file, route the `test()` registration through vitest's
 * globally-injected API when `process.env.VITEST` is set, and through
 * `node:test`'s API otherwise.
 */
import * as assert from 'node:assert/strict';

import {
    InMemoryTaskLineageStore,
    type InvestigationThreadEntry,
    type TaskLineage,
} from './engine';
import {
    InvestigationFollowupCommands,
    InvestigationFollowupEvents,
    buildFollowupPrompt,
    createRequestInvestigationFollowupHandler,
    type InvestigationFollowupRequestedEventPayload,
    type InvestigatorAgent,
    type InvestigatorInput,
    type RequestInvestigationFollowupPayload,
} from './investigation-followup';
import type { Command } from '../commands/command';

// ---------------------------------------------------------------------------
// Dual-runner test() shim.
// ---------------------------------------------------------------------------

type TestFn = (name: string, fn: () => void | Promise<void>) => void;

const test: TestFn = (((): TestFn => {
    if (process.env.VITEST) {
        const gt = (globalThis as { test?: TestFn }).test;
        if (typeof gt !== 'function') {
            throw new Error(
                'investigation-followup.test.ts: VITEST=true but globalThis.test is missing — '
                    + 'ensure vitest.config.ts sets test.globals = true',
            );
        }
        return gt;
    }
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    const nt = require('node:test') as { test: TestFn };
    return nt.test;
})());

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeCmd(
    payload: RequestInvestigationFollowupPayload,
    actor = 'operator-1',
    issuedAt = 1_700_000_000_000,
): Command<RequestInvestigationFollowupPayload> {
    return {
        type: InvestigationFollowupCommands.REQUEST_INVESTIGATION_FOLLOWUP,
        actor,
        issuedAt,
        payload,
    };
}

function tickingClock(start = 1_700_000_001_000): () => number {
    let t = start;
    return (): number => t++;
}

function seedLineage(
    store: InMemoryTaskLineageStore,
    taskId: string,
    overrides: Partial<TaskLineage> = {},
): void {
    const base: TaskLineage = {
        parent_task_id: null,
        spawn_reason: null,
        source_investigation_id: null,
        investigation_thread: [],
        followup_inflight: false,
    };
    store.write(taskId, { ...base, ...overrides });
}

class StubInvestigator implements InvestigatorAgent {
    public calls: InvestigatorInput[] = [];
    constructor(private readonly impl: (input: InvestigatorInput) => Promise<string>) {}
    async run(input: InvestigatorInput): Promise<string> {
        this.calls.push(input);
        return this.impl(input);
    }
}

// ---------------------------------------------------------------------------
// 1. Happy path
// ---------------------------------------------------------------------------

test('happy path: operator entry on entry, investigator entry on completion, inflight false at end', async () => {
    const lineage = new InMemoryTaskLineageStore();
    seedLineage(lineage, 'task-happy', {
        parent_task_id: 'task-root',
        spawn_reason: 'investigation-followup',
        source_investigation_id: 'inv-1',
        investigation_thread: [
            { role: 'operator', content: 'initial q', timestamp: 1 },
            { role: 'investigator', content: 'initial a', timestamp: 2 },
        ],
    });

    // The investigator must observe `followup_inflight=true` AND see the
    // operator entry on the thread it receives.
    const investigator = new StubInvestigator(async (input) => {
        const live = lineage.read('task-happy');
        assert.ok(live, 'lineage must exist while agent runs');
        assert.equal(
            live!.followup_inflight,
            true,
            'followup_inflight must be true while agent runs (AC #4)',
        );
        assert.equal(input.thread.length, 3);
        assert.deepEqual(input.thread[2], {
            role: 'operator',
            content: 'why is build still red?',
            timestamp: 1_700_000_001_000,
        });
        assert.equal(input.priorBrief, 'brief text');
        assert.equal(input.priorReport, 'report text');
        return 'because the dep was bumped twice';
    });

    const handler = createRequestInvestigationFollowupHandler({
        clock: tickingClock(),
        lineage,
        investigator,
    });

    const events = await handler(
        makeCmd({
            taskId: 'task-happy',
            question: 'why is build still red?',
            priorBrief: 'brief text',
            priorReport: 'report text',
        }),
        undefined,
    );

    // AC #1, #2: exactly one event emitted, investigator called exactly once.
    assert.equal(investigator.calls.length, 1);
    assert.equal(events.length, 1);
    const event = events[0];
    assert.equal(
        event.type,
        InvestigationFollowupEvents.INVESTIGATION_FOLLOWUP_REQUESTED,
    );
    const payload = event.payload as InvestigationFollowupRequestedEventPayload;
    assert.equal(payload.taskId, 'task-happy');
    assert.equal(payload.question, 'why is build still red?');
    assert.equal(payload.actor, 'operator-1');
    assert.equal(payload.priorBrief, 'brief text');
    assert.equal(payload.priorReport, 'report text');
    assert.equal(
        payload.thread.length,
        3,
        'event must carry the thread snapshot sent to the agent',
    );

    // AC #3: thread now has both new entries in order, immutable lineage
    // fields untouched.
    const after = lineage.read('task-happy');
    assert.ok(after);
    assert.equal(after!.followup_inflight, false, 'AC #4: cleared on success');
    assert.equal(after!.parent_task_id, 'task-root');
    assert.equal(after!.spawn_reason, 'investigation-followup');
    assert.equal(after!.source_investigation_id, 'inv-1');
    assert.equal(after!.investigation_thread.length, 4);
    assert.deepEqual(after!.investigation_thread[2], {
        role: 'operator',
        content: 'why is build still red?',
        timestamp: 1_700_000_001_000,
    });
    assert.deepEqual(after!.investigation_thread[3], {
        role: 'investigator',
        content: 'because the dep was bumped twice',
        timestamp: 1_700_000_001_001,
    });
});

test('happy path: seeds default lineage when the task has no prior record', async () => {
    const lineage = new InMemoryTaskLineageStore();
    const investigator = new StubInvestigator(async () => 'answer');
    const handler = createRequestInvestigationFollowupHandler({
        clock: tickingClock(),
        lineage,
        investigator,
    });

    await handler(
        makeCmd({ taskId: 'task-fresh', question: 'first ever follow-up' }),
        undefined,
    );

    const after = lineage.read('task-fresh');
    assert.ok(after, 'handler must seed lineage when none existed');
    assert.equal(after!.followup_inflight, false);
    assert.equal(after!.investigation_thread.length, 2);
    assert.equal(after!.investigation_thread[0].role, 'operator');
    assert.equal(after!.investigation_thread[1].role, 'investigator');
});

// ---------------------------------------------------------------------------
// 2. Re-entry rejection
// ---------------------------------------------------------------------------

test('re-entry rejection: second command while inflight is rejected and the agent is NOT re-run', async () => {
    const lineage = new InMemoryTaskLineageStore();
    seedLineage(lineage, 'task-busy', { followup_inflight: true });

    const investigator = new StubInvestigator(async () => 'should not run');
    const handler = createRequestInvestigationFollowupHandler({
        clock: tickingClock(),
        lineage,
        investigator,
    });

    await assert.rejects(
        handler(
            makeCmd({ taskId: 'task-busy', question: 'second try' }),
            undefined,
        ),
        /already has a follow-up in flight/,
    );

    // AC #5: no second agent run.
    assert.equal(investigator.calls.length, 0);
    // AC #5: state untouched — inflight is still true, no thread entries
    // were appended by the rejected call.
    const after = lineage.read('task-busy');
    assert.ok(after);
    assert.equal(after!.followup_inflight, true);
    assert.equal(after!.investigation_thread.length, 0);
});

test('re-entry rejection: concurrent dispatch (second call arrives before first finishes) rejects', async () => {
    const lineage = new InMemoryTaskLineageStore();
    seedLineage(lineage, 'task-race');

    let releaseFirst!: (answer: string) => void;
    const firstAnswer = new Promise<string>((resolve) => {
        releaseFirst = resolve;
    });

    let secondCallSeen = false;
    const investigator = new StubInvestigator(async (input) => {
        if (secondCallSeen) {
            throw new Error('investigator must not be called a second time');
        }
        secondCallSeen = true;
        // Stash the await reference so the second dispatch races against
        // the live in-flight gate. The thread must already include the
        // operator entry by the time we arrive here.
        assert.equal(input.thread.length, 1);
        return firstAnswer;
    });

    const handler = createRequestInvestigationFollowupHandler({
        clock: tickingClock(),
        lineage,
        investigator,
    });

    const firstPromise = handler(
        makeCmd({ taskId: 'task-race', question: 'first' }, 'operator-1', 1),
        undefined,
    );

    // Give the handler one microtask cycle to seed the operator entry and
    // flip the inflight gate before the second dispatch runs.
    await Promise.resolve();
    await Promise.resolve();

    await assert.rejects(
        handler(
            makeCmd({ taskId: 'task-race', question: 'second' }, 'operator-1', 2),
            undefined,
        ),
        /already has a follow-up in flight/,
    );

    // Investigator is still mid-call; resolve it so the first dispatch
    // can complete cleanly.
    releaseFirst('answer-1');
    const events = await firstPromise;
    assert.equal(events.length, 1);

    const after = lineage.read('task-race');
    assert.equal(after!.followup_inflight, false);
    assert.equal(after!.investigation_thread.length, 2);
});

// ---------------------------------------------------------------------------
// 3. Agent failure
// ---------------------------------------------------------------------------

test('agent failure: inflight cleared, no investigator entry appended, error propagates', async () => {
    const lineage = new InMemoryTaskLineageStore();
    seedLineage(lineage, 'task-boom', {
        investigation_thread: [
            { role: 'operator', content: 'q0', timestamp: 1 },
            { role: 'investigator', content: 'a0', timestamp: 2 },
        ],
    });

    const investigator = new StubInvestigator(async () => {
        throw new Error('investigator crashed: ENOSPC');
    });
    const handler = createRequestInvestigationFollowupHandler({
        clock: tickingClock(),
        lineage,
        investigator,
    });

    await assert.rejects(
        handler(makeCmd({ taskId: 'task-boom', question: 'crashy q' }), undefined),
        /investigator crashed: ENOSPC/,
    );

    const after = lineage.read('task-boom');
    assert.ok(after);
    // AC #4: inflight cleared even on failure.
    assert.equal(after!.followup_inflight, false);
    // The operator entry is preserved (the question was recorded), but
    // no investigator entry was appended — the thread reflects only
    // turns that actually produced an answer.
    assert.equal(after!.investigation_thread.length, 3);
    assert.equal(after!.investigation_thread[2].role, 'operator');
    assert.equal(after!.investigation_thread[2].content, 'crashy q');
});

// ---------------------------------------------------------------------------
// 4. Validation + ancillary
// ---------------------------------------------------------------------------

test('rejects malformed payloads', async () => {
    const handler = createRequestInvestigationFollowupHandler({
        clock: tickingClock(),
        lineage: new InMemoryTaskLineageStore(),
        investigator: new StubInvestigator(async () => 'unused'),
    });

    await assert.rejects(
        handler(
            {
                type: InvestigationFollowupCommands.REQUEST_INVESTIGATION_FOLLOWUP,
                actor: 'op',
                issuedAt: 0,
                payload: { taskId: '', question: 'q' } as RequestInvestigationFollowupPayload,
            },
            undefined,
        ),
        /invalid payload/,
    );
    await assert.rejects(
        handler(
            {
                type: InvestigationFollowupCommands.REQUEST_INVESTIGATION_FOLLOWUP,
                actor: 'op',
                issuedAt: 0,
                payload: { taskId: 't', question: '' } as RequestInvestigationFollowupPayload,
            },
            undefined,
        ),
        /invalid payload/,
    );
});

test('idempotencyKey is deterministic per (taskId, issuedAt)', async () => {
    const lineage = new InMemoryTaskLineageStore();
    const investigator = new StubInvestigator(async () => 'ans');
    const handler = createRequestInvestigationFollowupHandler({
        clock: tickingClock(),
        lineage,
        investigator,
    });

    const a = await handler(
        makeCmd({ taskId: 'task-id', question: 'q1' }, 'operator-1', 42),
        undefined,
    );
    // Reset inflight so a second dispatch is allowed.
    lineage.update('task-id', { followup_inflight: false });
    const b = await handler(
        makeCmd({ taskId: 'task-id', question: 'q2' }, 'operator-1', 42),
        undefined,
    );
    assert.equal(a[0].idempotencyKey, b[0].idempotencyKey);
    assert.match(
        a[0].idempotencyKey,
        /^RequestInvestigationFollowup:task-id:42$/,
    );
});

test('buildFollowupPrompt renders brief, report, and thread in stable order', () => {
    const input: InvestigatorInput = {
        taskId: 't',
        priorBrief: 'B',
        priorReport: 'R',
        thread: [
            { role: 'operator', content: 'why?', timestamp: 1 },
            { role: 'investigator', content: 'because Z', timestamp: 2 },
        ] as InvestigationThreadEntry[],
    };
    const prompt = buildFollowupPrompt(input);
    assert.ok(prompt.indexOf('## Prior brief') < prompt.indexOf('## Prior investigation report'));
    assert.ok(
        prompt.indexOf('## Prior investigation report') < prompt.indexOf('## Conversation so far'),
    );
    assert.ok(prompt.includes('### operator'));
    assert.ok(prompt.includes('### investigator'));
    assert.ok(prompt.includes('why?'));
    assert.ok(prompt.includes('because Z'));
});

test('buildFollowupPrompt handles an empty thread without crashing', () => {
    const prompt = buildFollowupPrompt({ taskId: 't', thread: [] });
    assert.ok(prompt.includes('## Conversation so far'));
    assert.ok(prompt.includes('(no prior turns)'));
});
