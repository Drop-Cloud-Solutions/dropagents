/**
 * AP-VP5-001 — unit tests for the extended ResumeTask payload and the new
 * commands/events that round out the operator clarification + notes
 * surface.
 *
 * For every new command and event shape, we:
 *   1. construct the payload with every field set
 *   2. wrap it in the appropriate envelope (Command or Event)
 *   3. JSON-round-trip the envelope
 *   4. assert that the discriminator (`type` on both, plus `name` on the
 *      `*Commands` constants we register) survives the round trip and that
 *      the structural payload fields are preserved verbatim.
 *
 * The new events still carry an unrelated set of fields, so the test also
 * asserts that the `type` literal narrows correctly through the
 * isClarificationRequested / isNoteCreated / etc. predicates after parse.
 */

/**
 * Dual-runner discovery (see `adapters/git/worktree-gc-job.test.ts`):
 *
 * - `npm test` runs `node --test --import tsx`, i.e. Node's `node:test`.
 * - The review pipeline runs `npx vitest run` on changed test files.
 *
 * A static `import { test } from 'vitest'` breaks the first of those, and
 * that is exactly what this file used to carry — so it never ran under
 * `npm test` at all, and `npx tsx --test` on it died on the import. The
 * shim routes to `globalThis.test` under vitest (`vitest.config.ts` sets
 * `globals: true`) and to `node:test` everywhere else.
 */
type TestFn = (name: string, fn: () => void | Promise<void>) => void;

const test: TestFn = (((): TestFn => {
    if (process.env.VITEST) {
        const gt = (globalThis as { test?: TestFn }).test;
        if (typeof gt !== 'function') {
            throw new Error(
                'resume-task-payload.test.ts: VITEST=true but globalThis.test is missing — '
                    + 'ensure vitest.config.ts sets test.globals = true',
            );
        }
        return gt;
    }
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    const nt = require('node:test') as { test: TestFn };
    return nt.test;
})());
import assert from 'node:assert/strict';

import type { Command } from '../../../core/commands/command';
import {
    isAskInvestigationFollowupPayload,
    isConvertNoteToInvestigationPayload,
    isPromoteNoteToPlanPayload,
    isResumeTaskPayload,
    NoteOpsCommands,
    TaskParkingCommands,
} from '../../../core/commands/index';
import type {
    AskInvestigationFollowupPayload,
    ConvertNoteToInvestigationPayload,
    PromoteNoteToPlanPayload,
    ResumeTaskPayload,
} from '../../../core/commands/index';
import {
    isClarificationAnswered,
    isClarificationRequested,
    isInvestigationFollowupAsked,
    isNoteCreated,
    isNoteDeleted,
    isNoteUpdated,
} from '../../../core/events/event';
import type {
    ClarificationAnswered,
    ClarificationRequested,
    Event,
    InvestigationFollowupAsked,
    NoteCreated,
    NoteDeleted,
    NoteUpdated,
} from '../../../core/events/event';

function roundTrip<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

// ---------------------------------------------------------------------------
// ResumeTask: backwards-compatibility for the new optional `remember` field.
// ---------------------------------------------------------------------------

test('ResumeTaskPayload still accepts the legacy approve/reject shape', () => {
    const approve: ResumeTaskPayload = { taskId: 't-1', decision: 'approve' };
    const reject: ResumeTaskPayload = {
        taskId: 't-1',
        decision: 'reject',
        feedback: 'try again',
    };
    assert.ok(isResumeTaskPayload(approve));
    assert.ok(isResumeTaskPayload(reject));
});

test('ResumeTaskPayload accepts feedback, answer, and remember together', () => {
    const payload: ResumeTaskPayload = {
        taskId: 't-2',
        decision: 'approve',
        feedback: 'fine, but rename the file',
        answer: 'use option B',
        remember: true,
    };
    assert.ok(isResumeTaskPayload(payload));
    const cmd: Command<ResumeTaskPayload> = {
        type: TaskParkingCommands.RESUME_TASK,
        actor: 'op-1',
        issuedAt: 1_800_000_000_000,
        payload,
    };
    const restored = roundTrip(cmd);
    assert.equal(restored.type, 'ResumeTask');
    assert.equal(restored.payload.taskId, 't-2');
    assert.equal(restored.payload.decision, 'approve');
    assert.equal(restored.payload.feedback, 'fine, but rename the file');
    assert.equal(restored.payload.answer, 'use option B');
    assert.equal(restored.payload.remember, true);
});

test('isResumeTaskPayload rejects a non-boolean remember field', () => {
    const bogus = {
        taskId: 't-3',
        decision: 'approve',
        remember: 'yes',
    };
    assert.equal(isResumeTaskPayload(bogus), false);
});

// ---------------------------------------------------------------------------
// New commands — discriminator + payload round-trip.
// ---------------------------------------------------------------------------

test('AskInvestigationFollowup command round-trips its discriminator', () => {
    const payload: AskInvestigationFollowupPayload = {
        taskId: 't-10',
        question: 'what did you mean by "stable"?',
    };
    assert.ok(isAskInvestigationFollowupPayload(payload));
    const cmd: Command<AskInvestigationFollowupPayload> = {
        type: NoteOpsCommands.ASK_INVESTIGATION_FOLLOWUP,
        actor: 'op-1',
        issuedAt: 1_800_000_000_001,
        payload,
    };
    const restored = roundTrip(cmd);
    assert.equal(restored.type, 'AskInvestigationFollowup');
    assert.equal(restored.payload.taskId, 't-10');
    assert.equal(restored.payload.question, 'what did you mean by "stable"?');
});

test('PromoteNoteToPlan command round-trips its discriminator', () => {
    const payload: PromoteNoteToPlanPayload = {
        projectId: 'proj-A',
        noteId: 'note-7',
    };
    assert.ok(isPromoteNoteToPlanPayload(payload));
    const cmd: Command<PromoteNoteToPlanPayload> = {
        type: NoteOpsCommands.PROMOTE_NOTE_TO_PLAN,
        actor: 'op-1',
        issuedAt: 1_800_000_000_002,
        payload,
    };
    const restored = roundTrip(cmd);
    assert.equal(restored.type, 'PromoteNoteToPlan');
    assert.equal(restored.payload.projectId, 'proj-A');
    assert.equal(restored.payload.noteId, 'note-7');
});

test('ConvertNoteToInvestigation command round-trips its discriminator', () => {
    const payload: ConvertNoteToInvestigationPayload = {
        projectId: 'proj-A',
        noteId: 'note-7',
    };
    assert.ok(isConvertNoteToInvestigationPayload(payload));
    const cmd: Command<ConvertNoteToInvestigationPayload> = {
        type: NoteOpsCommands.CONVERT_NOTE_TO_INVESTIGATION,
        actor: 'op-1',
        issuedAt: 1_800_000_000_003,
        payload,
    };
    const restored = roundTrip(cmd);
    assert.equal(restored.type, 'ConvertNoteToInvestigation');
    assert.equal(restored.payload.projectId, 'proj-A');
    assert.equal(restored.payload.noteId, 'note-7');
});

test('NoteOpsCommands constants expose the three discriminator strings', () => {
    assert.equal(NoteOpsCommands.ASK_INVESTIGATION_FOLLOWUP, 'AskInvestigationFollowup');
    assert.equal(NoteOpsCommands.PROMOTE_NOTE_TO_PLAN, 'PromoteNoteToPlan');
    assert.equal(
        NoteOpsCommands.CONVERT_NOTE_TO_INVESTIGATION,
        'ConvertNoteToInvestigation',
    );
});

// ---------------------------------------------------------------------------
// New events — discriminator + payload round-trip + predicate narrowing.
// ---------------------------------------------------------------------------

test('ClarificationRequested event survives JSON round-trip', () => {
    const event: ClarificationRequested = {
        type: 'ClarificationRequested',
        v: 1,
        occurredAt: 1_800_000_000_010,
        idempotencyKey: 'ClarificationRequested:t-20:1800000000010',
        payload: {
            taskId: 't-20',
            question: 'which environment should I target?',
            choices: ['staging', 'prod'],
            askedAt: 1_800_000_000_010,
        },
    };
    const restored = roundTrip<Event>(event);
    assert.equal(restored.type, 'ClarificationRequested');
    assert.ok(isClarificationRequested(restored));
    assert.equal(restored.payload.taskId, 't-20');
    assert.equal(restored.payload.question, 'which environment should I target?');
    assert.deepEqual(restored.payload.choices, ['staging', 'prod']);
    assert.equal(restored.payload.askedAt, 1_800_000_000_010);
});

test('ClarificationAnswered event survives JSON round-trip', () => {
    const event: ClarificationAnswered = {
        type: 'ClarificationAnswered',
        v: 1,
        occurredAt: 1_800_000_000_011,
        idempotencyKey: 'ClarificationAnswered:t-20:1800000000011',
        payload: {
            taskId: 't-20',
            answer: 'staging',
            remember: true,
            answeredAt: 1_800_000_000_011,
        },
    };
    const restored = roundTrip<Event>(event);
    assert.equal(restored.type, 'ClarificationAnswered');
    assert.ok(isClarificationAnswered(restored));
    assert.equal(restored.payload.taskId, 't-20');
    assert.equal(restored.payload.answer, 'staging');
    assert.equal(restored.payload.remember, true);
    assert.equal(restored.payload.answeredAt, 1_800_000_000_011);
});

test('InvestigationFollowupAsked event survives JSON round-trip', () => {
    const event: InvestigationFollowupAsked = {
        type: 'InvestigationFollowupAsked',
        v: 1,
        occurredAt: 1_800_000_000_012,
        idempotencyKey: 'InvestigationFollowupAsked:t-30:thread-1',
        payload: {
            taskId: 't-30',
            threadId: 'thread-1',
            question: 'can you also check the staging logs?',
            askedAt: 1_800_000_000_012,
        },
    };
    const restored = roundTrip<Event>(event);
    assert.equal(restored.type, 'InvestigationFollowupAsked');
    assert.ok(isInvestigationFollowupAsked(restored));
    assert.equal(restored.payload.taskId, 't-30');
    assert.equal(restored.payload.threadId, 'thread-1');
    assert.equal(restored.payload.question, 'can you also check the staging logs?');
    assert.equal(restored.payload.askedAt, 1_800_000_000_012);
});

test('NoteCreated event survives JSON round-trip', () => {
    const event: NoteCreated = {
        type: 'NoteCreated',
        v: 1,
        occurredAt: 1_800_000_000_020,
        idempotencyKey: 'NoteCreated:proj-A:note-9',
        payload: {
            projectId: 'proj-A',
            noteId: 'note-9',
            content: 'remember to bump the schema version',
            timestamp: 1_800_000_000_020,
        },
    };
    const restored = roundTrip<Event>(event);
    assert.equal(restored.type, 'NoteCreated');
    assert.ok(isNoteCreated(restored));
    assert.equal(restored.payload.projectId, 'proj-A');
    assert.equal(restored.payload.noteId, 'note-9');
    assert.equal(restored.payload.content, 'remember to bump the schema version');
    assert.equal(restored.payload.timestamp, 1_800_000_000_020);
});

test('NoteUpdated event survives JSON round-trip', () => {
    const event: NoteUpdated = {
        type: 'NoteUpdated',
        v: 1,
        occurredAt: 1_800_000_000_021,
        idempotencyKey: 'NoteUpdated:proj-A:note-9',
        payload: {
            projectId: 'proj-A',
            noteId: 'note-9',
            content: 'remember to bump the schema version AND run the migration',
            timestamp: 1_800_000_000_021,
        },
    };
    const restored = roundTrip<Event>(event);
    assert.equal(restored.type, 'NoteUpdated');
    assert.ok(isNoteUpdated(restored));
    assert.equal(
        restored.payload.content,
        'remember to bump the schema version AND run the migration',
    );
});

test('NoteDeleted event survives JSON round-trip without content', () => {
    const event: NoteDeleted = {
        type: 'NoteDeleted',
        v: 1,
        occurredAt: 1_800_000_000_022,
        idempotencyKey: 'NoteDeleted:proj-A:note-9',
        payload: {
            projectId: 'proj-A',
            noteId: 'note-9',
            timestamp: 1_800_000_000_022,
        },
    };
    const restored = roundTrip<Event>(event);
    assert.equal(restored.type, 'NoteDeleted');
    assert.ok(isNoteDeleted(restored));
    assert.equal(restored.payload.projectId, 'proj-A');
    assert.equal(restored.payload.noteId, 'note-9');
    assert.equal(restored.payload.content, undefined);
    assert.equal(restored.payload.timestamp, 1_800_000_000_022);
});
