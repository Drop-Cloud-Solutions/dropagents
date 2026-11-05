/**
 * AP-VP5-004 — unit tests for the orchestrator clarification handler.
 *
 * The handler subscribes to the agent stream and translates each
 * `{ event: "needs_human_input", question, choices? }` line into a
 * TaskParked{ reason: 'clarification' } + ClarificationRequested pair.
 * Anything else — malformed JSON, JSON missing the `question` field, an
 * unrelated assistant / system envelope — must be silently skipped
 * (debug log) without emitting either event.
 *
 * Test harness: a `FakeAgentStreamSubscription` exposes an `emit(line)`
 * method the suite calls to drive lines through the handler; published
 * events are observed by subscribing to the real `EventBus` backed by
 * an in-memory `EventStore` (the same pattern used by the orchestrator's
 * own `handlers.test.ts`).
 *
 * Dual-runner discovery mirrors `handlers.test.ts`: this file runs under
 * both Node's built-in `node:test` runner (the repo's own `npm test`)
 * and under `vitest` (the review pipeline's runner).
 */

import * as assert from 'node:assert/strict';

import { EventBus } from '../../../core/events/bus';
import { EventStore } from '../../../core/events/store';
import { applyMigrations, openDatabase, type Db } from '../../../core/state/migrations';
import type {
    ClarificationRequestedPayload,
    StoredEvent,
} from '../../../core/events/event';
import type { Logger } from '../../../core/ports/Logger';
import { TaskParkingEvents } from '../../../core/commands';
import type { TaskParkedEventPayload } from '../../../core/commands';

import {
    parseNeedsHumanInputLine,
    registerClarificationHandler,
    type AgentStreamLineContext,
    type AgentStreamSubscription,
} from '../../../hosts/orchestrator/handlers/clarification';

// ---------------------------------------------------------------------------
// Dual-runner test() shim — see `hosts/orchestrator/handlers.test.ts` for
// the rationale. The vitest branch is gated on `process.env.VITEST` which
// the vitest worker sets automatically; the node:test branch is the
// default `npm test` path (`node --test --import tsx`).
// ---------------------------------------------------------------------------

type TestFn = (name: string, fn: () => void | Promise<void>) => void;

const test: TestFn = (((): TestFn => {
    if (process.env.VITEST) {
        const gt = (globalThis as { test?: TestFn }).test;
        if (typeof gt !== 'function') {
            throw new Error(
                'clarification-handler.test.ts: VITEST=true but globalThis.test is missing — '
                    + 'ensure vitest.config.ts sets test.globals = true',
            );
        }
        return gt;
    }
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    const nt = require('node:test') as { test: TestFn };
    return nt.test;
})());

class SilentLogger implements Logger {
    readonly debugCalls: Array<{ message: string; meta?: Readonly<Record<string, unknown>> }> = [];
    info(): void {}
    warn(): void {}
    error(): void {}
    debug(message: string, meta?: Readonly<Record<string, unknown>>): void {
        this.debugCalls.push({ message, ...(meta !== undefined ? { meta } : {}) });
    }
}

/**
 * Minimal {@link AgentStreamSubscription} stand-in. The suite calls
 * `emit(line)` to drive a single JSONL line through every registered
 * handler; the registered handler returns a Promise<void> so the test
 * can `await` the publish chain before asserting on the bus.
 */
class FakeAgentStreamSubscription implements AgentStreamSubscription {
    private readonly handlers = new Set<
        (line: AgentStreamLineContext) => void | Promise<void>
    >();

    subscribe(
        handler: (line: AgentStreamLineContext) => void | Promise<void>,
    ): () => void {
        this.handlers.add(handler);
        return (): void => {
            this.handlers.delete(handler);
        };
    }

    async emit(line: AgentStreamLineContext): Promise<void> {
        for (const handler of this.handlers) {
            await handler(line);
        }
    }
}

interface Harness {
    readonly db: Db;
    readonly bus: EventBus;
    readonly stream: FakeAgentStreamSubscription;
    readonly logger: SilentLogger;
    readonly published: StoredEvent[];
    readonly unsubscribe: () => void;
    readonly cleanup: () => void;
}

function makeHarness(): Harness {
    const db = openDatabase(':memory:');
    applyMigrations(db);
    const logger = new SilentLogger();
    const store = new EventStore(db);
    const bus = new EventBus(store, logger);
    const stream = new FakeAgentStreamSubscription();
    const published: StoredEvent[] = [];
    bus.subscribeAll((event) => {
        published.push(event);
    });

    // Fixed clock so the idempotency-key assertion below stays
    // deterministic across runs.
    const unsubscribe = registerClarificationHandler({
        bus,
        clock: () => 1_800_000_000_500,
        logger,
        stream,
    });

    return {
        db,
        bus,
        stream,
        logger,
        published,
        unsubscribe,
        cleanup: (): void => {
            unsubscribe();
            db.close();
        },
    };
}

// ---------------------------------------------------------------------------
// AC #2 + #4 — clean needs_human_input line emits TaskParked +
//              ClarificationRequested, choices array preserved verbatim.
// ---------------------------------------------------------------------------

test('clean needs_human_input line emits TaskParked{ clarification } and ClarificationRequested', async () => {
    const h = makeHarness();
    try {
        await h.stream.emit({
            taskId: 't-42',
            stepId: 'dev',
            line: JSON.stringify({
                event: 'needs_human_input',
                question: 'which environment should I target?',
                choices: ['staging', 'prod'],
            }),
        });

        assert.equal(h.published.length, 2);

        const parked = h.published[0];
        assert.equal(parked.type, TaskParkingEvents.TASK_PARKED);
        const parkedPayload = parked.payload as TaskParkedEventPayload;
        assert.equal(parkedPayload.taskId, 't-42');
        assert.equal(parkedPayload.stepId, 'dev');
        assert.equal(parkedPayload.reason, 'clarification');
        assert.equal(parkedPayload.question, 'which environment should I target?');
        assert.equal(parked.occurredAt, 1_800_000_000_500);
        assert.equal(
            parked.idempotencyKey,
            `clarification:${TaskParkingEvents.TASK_PARKED}:t-42:dev:1800000000500`,
        );

        const clarification = h.published[1];
        assert.equal(clarification.type, 'ClarificationRequested');
        const clarificationPayload = clarification.payload as ClarificationRequestedPayload;
        assert.equal(clarificationPayload.taskId, 't-42');
        assert.equal(clarificationPayload.question, 'which environment should I target?');
        assert.deepEqual(clarificationPayload.choices, ['staging', 'prod']);
        assert.equal(clarificationPayload.askedAt, 1_800_000_000_500);
        assert.equal(
            clarification.idempotencyKey,
            'clarification:ClarificationRequested:t-42:dev:1800000000500',
        );
    } finally {
        h.cleanup();
    }
});

test('needs_human_input line without choices preserves the absence (no `choices` key on payload)', async () => {
    const h = makeHarness();
    try {
        await h.stream.emit({
            taskId: 't-43',
            stepId: 'review',
            line: JSON.stringify({
                event: 'needs_human_input',
                question: 'do you want to keep the helper class?',
            }),
        });

        assert.equal(h.published.length, 2);
        const clarification = h.published[1];
        const payload = clarification.payload as ClarificationRequestedPayload;
        assert.equal(payload.question, 'do you want to keep the helper class?');
        assert.equal(payload.choices, undefined);
    } finally {
        h.cleanup();
    }
});

// ---------------------------------------------------------------------------
// AC #3 — malformed JSON / missing question / unrelated event must NOT crash
// and must NOT emit park or clarification events.
// ---------------------------------------------------------------------------

test('malformed JSON line is skipped (no events, no throw, debug log recorded)', async () => {
    const h = makeHarness();
    try {
        await h.stream.emit({
            taskId: 't-44',
            stepId: 'dev',
            line: '{ this is not valid json',
        });

        assert.equal(h.published.length, 0);
        assert.equal(h.logger.debugCalls.length, 1);
        assert.match(
            h.logger.debugCalls[0].message,
            /clarification handler skipped/i,
        );
    } finally {
        h.cleanup();
    }
});

test('JSON with event=needs_human_input but no question is skipped', async () => {
    const h = makeHarness();
    try {
        await h.stream.emit({
            taskId: 't-45',
            stepId: 'dev',
            line: JSON.stringify({
                event: 'needs_human_input',
                // question intentionally absent
                choices: ['a', 'b'],
            }),
        });

        assert.equal(h.published.length, 0);
    } finally {
        h.cleanup();
    }
});

test('JSON with event=needs_human_input but empty-string question is skipped', async () => {
    const h = makeHarness();
    try {
        await h.stream.emit({
            taskId: 't-46',
            stepId: 'dev',
            line: JSON.stringify({ event: 'needs_human_input', question: '' }),
        });
        assert.equal(h.published.length, 0);
    } finally {
        h.cleanup();
    }
});

test('unrelated agent stream event (assistant text envelope) is skipped', async () => {
    const h = makeHarness();
    try {
        await h.stream.emit({
            taskId: 't-47',
            stepId: 'dev',
            line: JSON.stringify({
                type: 'assistant',
                message: {
                    content: [{ type: 'text', text: 'hello, world' }],
                },
            }),
        });
        assert.equal(h.published.length, 0);
    } finally {
        h.cleanup();
    }
});

test('JSON with event=needs_human_input but choices not an array is skipped', async () => {
    const h = makeHarness();
    try {
        await h.stream.emit({
            taskId: 't-48',
            stepId: 'dev',
            line: JSON.stringify({
                event: 'needs_human_input',
                question: 'which env?',
                choices: 'staging,prod',
            }),
        });
        assert.equal(h.published.length, 0);
    } finally {
        h.cleanup();
    }
});

test('JSON with event=needs_human_input but a non-string choice entry is skipped', async () => {
    const h = makeHarness();
    try {
        await h.stream.emit({
            taskId: 't-49',
            stepId: 'dev',
            line: JSON.stringify({
                event: 'needs_human_input',
                question: 'pick one',
                choices: ['a', 7, 'c'],
            }),
        });
        assert.equal(h.published.length, 0);
    } finally {
        h.cleanup();
    }
});

// ---------------------------------------------------------------------------
// AC #5 — full mock-stream sequence asserts that only the first emits.
// ---------------------------------------------------------------------------

test('mixed stream sequence: only the clean needs_human_input line parks the task', async () => {
    const h = makeHarness();
    try {
        await h.stream.emit({
            taskId: 't-50',
            stepId: 'dev',
            line: JSON.stringify({
                event: 'needs_human_input',
                question: 'continue?',
                choices: ['yes', 'no'],
            }),
        });
        await h.stream.emit({
            taskId: 't-50',
            stepId: 'dev',
            line: '{ malformed',
        });
        await h.stream.emit({
            taskId: 't-50',
            stepId: 'dev',
            line: JSON.stringify({ event: 'needs_human_input' }), // missing question
        });
        await h.stream.emit({
            taskId: 't-50',
            stepId: 'dev',
            line: JSON.stringify({
                type: 'assistant',
                message: { content: [{ type: 'text', text: 'thinking...' }] },
            }),
        });

        // Only the clean line emitted events: TaskParked + ClarificationRequested.
        assert.equal(h.published.length, 2);
        assert.equal(h.published[0].type, TaskParkingEvents.TASK_PARKED);
        assert.equal(h.published[1].type, 'ClarificationRequested');
        const clarification = h.published[1].payload as ClarificationRequestedPayload;
        assert.equal(clarification.question, 'continue?');
        assert.deepEqual(clarification.choices, ['yes', 'no']);
    } finally {
        h.cleanup();
    }
});

// ---------------------------------------------------------------------------
// Pure parser semantics — pinned independently of the bus so a regression
// in the parser surfaces with a fast unit test rather than via the
// integration-style cases above.
// ---------------------------------------------------------------------------

test('parseNeedsHumanInputLine returns null for empty / whitespace-only input', () => {
    assert.equal(parseNeedsHumanInputLine(''), null);
    assert.equal(parseNeedsHumanInputLine('   '), null);
    assert.equal(parseNeedsHumanInputLine('\n\n'), null);
});

test('parseNeedsHumanInputLine returns null for non-object JSON', () => {
    assert.equal(parseNeedsHumanInputLine('42'), null);
    assert.equal(parseNeedsHumanInputLine('"hi"'), null);
    assert.equal(parseNeedsHumanInputLine('[1,2,3]'), null);
    assert.equal(parseNeedsHumanInputLine('null'), null);
});

test('parseNeedsHumanInputLine accepts a clean line and surfaces choices verbatim', () => {
    const parsed = parseNeedsHumanInputLine(
        JSON.stringify({
            event: 'needs_human_input',
            question: 'which env?',
            choices: ['staging', 'prod'],
        }),
    );
    assert.ok(parsed !== null);
    assert.equal(parsed!.question, 'which env?');
    assert.deepEqual(parsed!.choices, ['staging', 'prod']);
});
