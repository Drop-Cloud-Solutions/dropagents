/**
 * AP-VP5-005 — unit tests for the orchestrator resume handler.
 *
 * The handler wraps the bare `ResumeTask` command handler from
 * `core/commands` with sidecar / memory writes:
 *
 *   approve + answer  -> clarification-answer.md (truncate-write) +
 *                        optional appendMemoryEntry(remember=true) +
 *                        ClarificationAnswered event +
 *                        existing TaskResumed event
 *
 *   reject + feedback -> feedback.md (truncate-write) +
 *                        existing TaskResumed event (engine routes
 *                        to on_failure via task-003)
 *
 * The suite mocks the worktree-root lookup and the filesystem write so
 * the real disk is never touched. Truncate semantics are asserted by
 * driving two consecutive resumes and verifying the second value
 * REPLACES the first under the same path key.
 *
 * Dual-runner discovery (matches `clarification-handler.test.ts`): the
 * repo's `npm test` runs node:test; the review pipeline runs vitest on
 * changed files. The shim picks the right `test()` at module load so
 * both runners discover the same suite from a single source file.
 */
import * as assert from 'node:assert/strict';
import * as path from 'node:path';

import type { Command } from '../../../core/commands/command';
import { TaskParkingCommands } from '../../../core/commands';
import type { ResumeTaskPayload } from '../../../core/commands';
import type { ClarificationAnsweredPayload, Event } from '../../../core/events/event';
import type { Logger } from '../../../core/ports/Logger';

import {
    CLARIFICATION_ANSWER_FILENAME,
    FEEDBACK_FILENAME,
    createResumeHandler,
    type AgentMemoryWriter,
    type ResumeFsAdapter,
    type TaskProjectLookup,
    type WorktreeRootLookup,
} from '../../../hosts/orchestrator/handlers/resume';

// ---------------------------------------------------------------------------
// Dual-runner test() shim — see `hosts/orchestrator/handlers.test.ts` for
// the rationale. The vitest branch is gated on `process.env.VITEST` which
// the vitest worker sets automatically.
// ---------------------------------------------------------------------------

type TestFn = (name: string, fn: () => void | Promise<void>) => void;

const test: TestFn = (((): TestFn => {
    if (process.env.VITEST) {
        const gt = (globalThis as { test?: TestFn }).test;
        if (typeof gt !== 'function') {
            throw new Error(
                'resume-handler.test.ts: VITEST=true but globalThis.test is missing — '
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
// Test doubles
// ---------------------------------------------------------------------------

class SilentLogger implements Logger {
    readonly warnCalls: Array<{ message: string; meta?: Readonly<Record<string, unknown>> }> = [];
    info(): void {}
    error(): void {}
    debug(): void {}
    warn(message: string, meta?: Readonly<Record<string, unknown>>): void {
        this.warnCalls.push({ message, ...(meta !== undefined ? { meta } : {}) });
    }
}

/** In-memory writeFileSync — truncate-and-write semantics (latest call
 *  wins per path), matching the production behaviour the test pins. */
class MemoryFs implements ResumeFsAdapter {
    readonly writes: Array<{ path: string; contents: string }> = [];
    private readonly contents = new Map<string, string>();
    writeFileSync(filePath: string, contents: string): void {
        this.writes.push({ path: filePath, contents });
        this.contents.set(filePath, contents);
    }
    read(filePath: string): string | undefined {
        return this.contents.get(filePath);
    }
}

class StaticWorktreeLookup implements WorktreeRootLookup {
    constructor(private readonly map: ReadonlyMap<string, string>) {}
    pathFor(taskId: string): string | undefined {
        return this.map.get(taskId);
    }
}

class StaticProjectLookup implements TaskProjectLookup {
    constructor(private readonly map: ReadonlyMap<string, string>) {}
    projectIdFor(taskId: string): string | undefined {
        return this.map.get(taskId);
    }
}

class RecordingMemory implements AgentMemoryWriter {
    readonly calls: Array<{
        projectId: string;
        source: 'clarification' | 'commit-reject';
        taskId: string;
        decision: string;
        context: string;
    }> = [];
    async appendMemoryEntry(opts: {
        readonly projectId: string;
        readonly source: 'clarification';
        readonly taskId: string;
        readonly decision: string;
        readonly context: string;
    }): Promise<void> {
        this.calls.push({ ...opts });
    }
}

interface Harness {
    readonly handler: ReturnType<typeof createResumeHandler>;
    readonly fs: MemoryFs;
    readonly memory: RecordingMemory;
    readonly logger: SilentLogger;
    readonly worktreeFor: (taskId: string) => string;
}

function makeHarness(opts: { withMemory?: boolean } = {}): Harness {
    const withMemory = opts.withMemory ?? true;
    const fs = new MemoryFs();
    const memory = new RecordingMemory();
    const logger = new SilentLogger();
    const worktreeMap = new Map<string, string>([
        ['task-A', '/wt/task-A'],
        ['task-B', '/wt/task-B'],
        ['task-C', '/wt/task-C'],
        ['task-D', '/wt/task-D'],
        ['task-E', '/wt/task-E'],
    ]);
    const projectMap = new Map<string, string>([
        ['task-A', 'proj-1'],
        ['task-B', 'proj-1'],
        ['task-C', 'proj-1'],
        ['task-D', 'proj-1'],
        ['task-E', 'proj-1'],
    ]);
    const handler = createResumeHandler({
        clock: () => 1_800_000_000_500,
        logger,
        worktrees: new StaticWorktreeLookup(worktreeMap),
        fs,
        ...(withMemory
            ? {
                  memory,
                  projectLookup: new StaticProjectLookup(projectMap),
              }
            : {}),
    });
    return {
        handler,
        fs,
        memory,
        logger,
        worktreeFor: (taskId): string => {
            const v = worktreeMap.get(taskId);
            if (v === undefined) throw new Error(`unmapped taskId ${taskId}`);
            return v;
        },
    };
}

function makeCmd(payload: ResumeTaskPayload, actor = 'op-1'): Command<ResumeTaskPayload> {
    return {
        type: TaskParkingCommands.RESUME_TASK,
        actor,
        issuedAt: 1_700_000_000_000,
        payload,
    };
}

// ---------------------------------------------------------------------------
// AC #1 — approve+answer writes clarification-answer.md to the worktree
//          BEFORE the TaskResumed event the inner handler emits.
// AC #4 — ClarificationAnswered is emitted before TaskResumed.
// ---------------------------------------------------------------------------

test('approve+answer writes clarification-answer.md to the worktree and emits ClarificationAnswered + TaskResumed', async () => {
    const h = makeHarness();
    const events = await h.handler(
        makeCmd({
            taskId: 'task-A',
            decision: 'approve',
            answer: 'use option A — keep current names',
            optionKey: 'A',
        }),
        undefined,
    );

    // Sidecar landed at the expected path with the verbatim answer.
    const expectedPath = path.join(h.worktreeFor('task-A'), CLARIFICATION_ANSWER_FILENAME);
    assert.equal(h.fs.read(expectedPath), 'use option A — keep current names');
    assert.equal(h.fs.writes.length, 1);
    assert.equal(h.fs.writes[0].path, expectedPath);

    // The sidecar write must happen BEFORE TaskResumed (the engine consumes
    // TaskResumed to re-dispatch the agent step, which reads the sidecar).
    // We approximate "before" by asserting both: (a) the write happened at
    // all, and (b) ClarificationAnswered + TaskResumed both fired with the
    // ClarificationAnswered ahead of TaskResumed in the returned array.
    assert.equal(events.length, 2);
    assert.equal(events[0].type, 'ClarificationAnswered');
    assert.equal(events[1].type, 'TaskResumed');

    const clarification = events[0].payload as ClarificationAnsweredPayload;
    assert.equal(clarification.taskId, 'task-A');
    assert.equal(clarification.answer, 'use option A — keep current names');
    assert.equal(clarification.remember, false);
    assert.equal(clarification.answeredAt, 1_800_000_000_500);
    assert.equal(
        events[0].idempotencyKey,
        `ClarificationAnswered:task-A:1700000000000`,
    );
});

// ---------------------------------------------------------------------------
// AC #2 — reject+feedback writes feedback.md, and only TaskResumed is
//          emitted (the engine subscriber routes to on_failure on its own).
// ---------------------------------------------------------------------------

test('reject+feedback writes feedback.md to the worktree and emits only TaskResumed', async () => {
    const h = makeHarness();
    const events = await h.handler(
        makeCmd({
            taskId: 'task-B',
            decision: 'reject',
            feedback: 'please rerun with staging credentials',
        }),
        undefined,
    );

    const expectedPath = path.join(h.worktreeFor('task-B'), FEEDBACK_FILENAME);
    assert.equal(h.fs.read(expectedPath), 'please rerun with staging credentials');
    assert.equal(h.fs.writes.length, 1);
    assert.equal(h.fs.writes[0].path, expectedPath);

    // No ClarificationAnswered on the reject path — that event is reserved
    // for approve+answer. TaskResumed alone is what task-003 routes on.
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'TaskResumed');
    const resumed = events[0].payload as { decision: string; feedback?: string };
    assert.equal(resumed.decision, 'reject');
    assert.equal(resumed.feedback, 'please rerun with staging credentials');

    // The rejection is ALSO filed as project memory. It used to be a
    // pure sidecar write: the reason reached this task's next agent run
    // and nothing else, so the next plan for the same project was
    // written as if the operator had never pushed back. `commit-reject`
    // had been declared in the memory store's source enum from the start
    // with nothing ever producing one.
    assert.equal(h.memory.calls.length, 1);
    const rejectEntry = h.memory.calls[0];
    assert.equal(rejectEntry.source, 'commit-reject');
    assert.equal(rejectEntry.projectId, 'proj-1');
    assert.equal(rejectEntry.taskId, 'task-B');
    assert.equal(rejectEntry.decision, 'reject');
    assert.equal(rejectEntry.context, 'please rerun with staging credentials');
});

test('a rejection with WHITESPACE-only feedback records no memory entry', async () => {
    // The sidecar still gets written (latest value wins is that file's
    // contract), but there is nothing to tell a future planner.
    const h = makeHarness();
    await h.handler(
        makeCmd({ taskId: 'task-B', decision: 'reject', feedback: '   ' }),
        undefined,
    );
    assert.equal(h.memory.calls.length, 0);
});

test('a rejection with no feedback at all records no memory entry', async () => {
    const h = makeHarness();
    await h.handler(
        makeCmd({ taskId: 'task-B', decision: 'reject' }),
        undefined,
    );
    assert.equal(h.memory.calls.length, 0);
});

// ---------------------------------------------------------------------------
// AC #3 — approve+answer with remember=true triggers appendMemoryEntry
//          with source='clarification', taskId, decision='answer', context.
// ---------------------------------------------------------------------------

test('approve+answer+remember=true calls appendMemoryEntry with source=clarification', async () => {
    const h = makeHarness();
    const events = await h.handler(
        makeCmd({
            taskId: 'task-C',
            decision: 'approve',
            answer: 'use option B',
            remember: true,
        }),
        undefined,
    );

    assert.equal(h.memory.calls.length, 1);
    const call = h.memory.calls[0];
    assert.equal(call.source, 'clarification');
    assert.equal(call.projectId, 'proj-1');
    assert.equal(call.taskId, 'task-C');
    assert.equal(call.decision, 'answer');
    assert.equal(call.context, 'use option B');

    // remember=true is mirrored onto the emitted event payload so a
    // replay reproduces the operator's persist intent.
    const clarification = events[0].payload as ClarificationAnsweredPayload;
    assert.equal(clarification.remember, true);
});

test('approve+answer+remember=false does NOT call appendMemoryEntry', async () => {
    const h = makeHarness();
    await h.handler(
        makeCmd({
            taskId: 'task-A',
            decision: 'approve',
            answer: 'use option A',
            remember: false,
        }),
        undefined,
    );
    assert.equal(h.memory.calls.length, 0);
});

test('approve+answer without remember field does NOT call appendMemoryEntry (omitted = no persist)', async () => {
    const h = makeHarness();
    await h.handler(
        makeCmd({
            taskId: 'task-A',
            decision: 'approve',
            answer: 'use option A',
        }),
        undefined,
    );
    assert.equal(h.memory.calls.length, 0);
});

// ---------------------------------------------------------------------------
// AC #5 — truncate semantics: a second resume for the same task overwrites
//          the prior sidecar content.
// ---------------------------------------------------------------------------

test('a second answer overwrites the prior clarification-answer.md (truncate-write)', async () => {
    const h = makeHarness();
    await h.handler(
        makeCmd({ taskId: 'task-D', decision: 'approve', answer: 'first answer' }),
        undefined,
    );
    await h.handler(
        makeCmd({ taskId: 'task-D', decision: 'approve', answer: 'second answer' }),
        undefined,
    );
    const expectedPath = path.join(h.worktreeFor('task-D'), CLARIFICATION_ANSWER_FILENAME);
    // The MemoryFs records two writes (proving each call really wrote),
    // but the readback under the same path key reflects the latest content
    // verbatim — i.e. truncate-and-write, not append.
    assert.equal(h.fs.writes.length, 2);
    assert.equal(h.fs.writes[0].contents, 'first answer');
    assert.equal(h.fs.writes[1].contents, 'second answer');
    assert.equal(h.fs.read(expectedPath), 'second answer');
});

test('a second feedback overwrites the prior feedback.md (truncate-write)', async () => {
    const h = makeHarness();
    await h.handler(
        makeCmd({ taskId: 'task-E', decision: 'reject', feedback: 'first try again' }),
        undefined,
    );
    await h.handler(
        makeCmd({ taskId: 'task-E', decision: 'reject', feedback: 'second try again' }),
        undefined,
    );
    const expectedPath = path.join(h.worktreeFor('task-E'), FEEDBACK_FILENAME);
    assert.equal(h.fs.writes.length, 2);
    assert.equal(h.fs.read(expectedPath), 'second try again');
});

// ---------------------------------------------------------------------------
// Edge cases — approve without an `answer` field must not write a sidecar
//              and must not emit ClarificationAnswered; reject without
//              `feedback` likewise skips the sidecar.
// ---------------------------------------------------------------------------

test('approve WITHOUT answer field does not write the sidecar and does not emit ClarificationAnswered', async () => {
    const h = makeHarness();
    const events = await h.handler(
        makeCmd({ taskId: 'task-A', decision: 'approve' }),
        undefined,
    );
    assert.equal(h.fs.writes.length, 0);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'TaskResumed');
});

test('reject WITHOUT feedback field does not write the sidecar', async () => {
    const h = makeHarness();
    const events = await h.handler(
        makeCmd({ taskId: 'task-B', decision: 'reject' }),
        undefined,
    );
    assert.equal(h.fs.writes.length, 0);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'TaskResumed');
});

// ---------------------------------------------------------------------------
// Resilience — a worktree miss is logged at warn level but does not throw,
//              and the inner TaskResumed dispatch still proceeds so the
//              engine isn't wedged on a stale taskId/worktree mapping.
// ---------------------------------------------------------------------------

test('unknown worktree mapping warns and skips the sidecar but still emits TaskResumed', async () => {
    const h = makeHarness();
    const events = await h.handler(
        makeCmd({
            taskId: 'task-unknown',
            decision: 'approve',
            answer: 'use option A',
        }),
        undefined,
    );
    assert.equal(h.fs.writes.length, 0);
    // ClarificationAnswered is still emitted — operator gave an answer,
    // audit trail captures it. TaskResumed still goes through to unblock
    // the engine.
    assert.equal(events.length, 2);
    assert.equal(events[0].type, 'ClarificationAnswered');
    assert.equal(events[1].type, 'TaskResumed');
    // The warn line names the file we failed to write.
    const warn = h.logger.warnCalls.find((w) =>
        w.message.includes(CLARIFICATION_ANSWER_FILENAME),
    );
    assert.ok(warn, 'expected a warn log mentioning clarification-answer.md');
});

test('remember=true with memory wiring omitted is logged at warn and does not throw', async () => {
    const h = makeHarness({ withMemory: false });
    const events = await h.handler(
        makeCmd({
            taskId: 'task-A',
            decision: 'approve',
            answer: 'use option A',
            remember: true,
        }),
        undefined,
    );
    assert.equal(events.length, 2);
    assert.equal(h.memory.calls.length, 0);
    const warn = h.logger.warnCalls.find((w) =>
        w.message.includes('agent-memory wiring is incomplete'),
    );
    assert.ok(warn, 'expected a warn log when remember=true but memory port missing');
});

// ---------------------------------------------------------------------------
// Payload validation — malformed payloads are rejected at the handler
//                      boundary BEFORE any sidecar write.
// ---------------------------------------------------------------------------

test('malformed payload throws and does not touch the filesystem', async () => {
    const h = makeHarness();
    await assert.rejects(
        h.handler(
            {
                type: TaskParkingCommands.RESUME_TASK,
                actor: 'op-1',
                issuedAt: 0,
                payload: { taskId: '', decision: 'approve' } as ResumeTaskPayload,
            },
            undefined,
        ),
        /invalid payload/,
    );
    assert.equal(h.fs.writes.length, 0);
});

// ---------------------------------------------------------------------------
// Sanity — TaskResumed surfaces the operator decision through the inner
//          handler unmodified so task-003's engine subscriber observes the
//          same payload it would have on the bare core handler.
// ---------------------------------------------------------------------------

test('TaskResumed payload threads decision, answer, optionKey, remember verbatim', async () => {
    const h = makeHarness();
    const events = await h.handler(
        makeCmd({
            taskId: 'task-A',
            decision: 'approve',
            answer: 'use option B',
            optionKey: 'B',
            remember: true,
        }),
        undefined,
    );
    const resumed = events[1];
    assert.equal(resumed.type, 'TaskResumed');
    const payload = resumed.payload as {
        taskId: string;
        decision: string;
        answer?: string;
        optionKey?: string;
        remember?: boolean;
    };
    assert.equal(payload.taskId, 'task-A');
    assert.equal(payload.decision, 'approve');
    assert.equal(payload.answer, 'use option B');
    assert.equal(payload.optionKey, 'B');
    assert.equal(payload.remember, true);
});

// ---------------------------------------------------------------------------
// Cross-call sequencing — approve then reject for the same task writes
// BOTH sidecars (the resume handler does not delete prior files; the agent
// reading TASK.md is responsible for honouring the latest one).
// ---------------------------------------------------------------------------

test('approve then reject for the same task writes both sidecars at their own paths', async () => {
    const h = makeHarness();
    await h.handler(
        makeCmd({
            taskId: 'task-D',
            decision: 'approve',
            answer: 'tentative answer',
        }),
        undefined,
    );
    await h.handler(
        makeCmd({
            taskId: 'task-D',
            decision: 'reject',
            feedback: 'actually no, start over',
        }),
        undefined,
    );
    const root = h.worktreeFor('task-D');
    assert.equal(
        h.fs.read(path.join(root, CLARIFICATION_ANSWER_FILENAME)),
        'tentative answer',
    );
    assert.equal(
        h.fs.read(path.join(root, FEEDBACK_FILENAME)),
        'actually no, start over',
    );
});

// ---------------------------------------------------------------------------
// Last-line defence — type narrow: the handler's signature is the same
// shape the orchestrator wires under TaskParkingCommands.RESUME_TASK, so a
// drop-in replacement does not need extra cast sites.
// ---------------------------------------------------------------------------

test('handler return type is an Event[] usable as the bus dispatch contract', async () => {
    const h = makeHarness();
    const events: Event[] = await h.handler(
        makeCmd({ taskId: 'task-A', decision: 'approve' }),
        undefined,
    );
    assert.ok(Array.isArray(events));
});
