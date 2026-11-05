/**
 * AP-VP5-007 unit tests for the orchestrator notes handler.
 *
 * Covers the five acceptance criteria:
 *   1. Notes persist to core/projects/<projectId>/notes.md with
 *      `## <noteId>` section delimiters.
 *   2. Create / update / delete each emit the matching event with
 *      projectId + noteId.
 *   3. promoteNoteToPlan emits PlanDrafted with the note content as the
 *      plan brief.
 *   4. convertNoteToInvestigation emits InvestigationRequested with the
 *      note content as the brief.
 *   5. Linear-document sync goes through the fake adapter and is
 *      assertable via the fake's recorder.
 *
 * Dual-runner discovery (matches hosts/orchestrator/handlers.test.ts):
 * the repo's `npm test` runs node:test; the review pipeline runs vitest
 * on changed files. The shim picks the right `test()` at module load so
 * both runners discover the same suite from a single source file.
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { CommandBus } from '../../../core/commands/bus';
import { EventBus } from '../../../core/events/bus';
import { EventStore } from '../../../core/events/store';
import { applyMigrations, openDatabase, type Db } from '../../../core/state/migrations';
import type { IdGen, Logger } from '../../../core/ports';

import {
    FileSystemNotesStore,
    NotesCommands,
    NotesEvents,
    parseNotes,
    serializeNotes,
    type InvestigationRequestedFromNotePayload,
    type PlanDraftedPayload,
} from '../../../hosts/orchestrator/handlers/notes';
import { FakeNotesDocumentSync } from '../../../adapters/fakes/FakeNotesDocumentSync';
import { registerCommandHandlers } from '../../../hosts/orchestrator/handlers';
import type { NoteLifecyclePayload } from '../../../core/events/event';

// ---------------------------------------------------------------------------
// Dual-runner test() shim
// ---------------------------------------------------------------------------

type TestFn = (name: string, fn: () => void | Promise<void>) => void;

const test: TestFn = (((): TestFn => {
    if (process.env.VITEST) {
        const gt = (globalThis as { test?: TestFn }).test;
        if (typeof gt !== 'function') {
            throw new Error(
                'notes-handler.test.ts: VITEST=true but globalThis.test is missing — '
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
// Helpers
// ---------------------------------------------------------------------------

class SilentLogger implements Logger {
    info(): void {}
    warn(): void {}
    error(): void {}
    debug(): void {}
}

interface Harness {
    readonly db: Db;
    readonly bus: EventBus;
    readonly cmdBus: CommandBus<unknown>;
    readonly projectsRoot: string;
    readonly store: FileSystemNotesStore;
    readonly documentSync: FakeNotesDocumentSync;
    readonly cleanup: () => void;
}

let clockNow = 1_700_000_000_000;
function tickingClock(): number {
    clockNow += 1;
    return clockNow;
}

function makeHarness(): Harness {
    clockNow = 1_700_000_000_000;
    const db = openDatabase(':memory:');
    applyMigrations(db);
    const logger = new SilentLogger();
    const store = new EventStore(db);
    const bus = new EventBus(store, logger);
    const cmdBus = new CommandBus<unknown>(bus, () => undefined);

    const projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-vp5-007-notes-'));
    const notesStore = new FileSystemNotesStore(projectsRoot);
    const documentSync = new FakeNotesDocumentSync();

    const idGen: IdGen = ((): IdGen => {
        let n = 0;
        return { newId: (): string => `id-${++n}` };
    })();

    registerCommandHandlers(cmdBus, {
        clock: tickingClock,
        idGen,
        logger,
        defaultFlowId: 'echo',
        defaultProjectId: 'proj-test',
        defaultTaskType: 'echo',
        agentRunner: { start: () => ({ id: 'a', spec: { role: 'r', prompt: '' } }), interrupt: async () => {} },
        registerAgent: () => {},
        deferAgentStart: (run): void => run(),
        notesStore,
        notesDocumentSync: documentSync,
    });

    return {
        db,
        bus,
        cmdBus,
        projectsRoot,
        store: notesStore,
        documentSync,
        cleanup: (): void => {
            db.close();
            fs.rmSync(projectsRoot, { recursive: true, force: true });
        },
    };
}

function readEventTypes(db: Db): string[] {
    return (db.prepare('SELECT type FROM events ORDER BY seq').all() as { type: string }[]).map(
        (r) => r.type,
    );
}

function readEventPayload<T>(db: Db, type: string): T {
    const row = db
        .prepare('SELECT payload FROM events WHERE type = ? ORDER BY seq DESC LIMIT 1')
        .get(type) as { payload: string } | undefined;
    if (!row) throw new Error(`no event of type ${type} in the store`);
    return JSON.parse(row.payload) as T;
}

// ---------------------------------------------------------------------------
// Parser / serializer round-trip
// ---------------------------------------------------------------------------

test('parseNotes + serializeNotes round-trip on a multi-section file', () => {
    const md = '## first-note\n\nbody of first\n\n## second-note\n\nbody of second\n';
    const parsed = parseNotes(md);
    assert.deepEqual(parsed, [
        { noteId: 'first-note', content: 'body of first' },
        { noteId: 'second-note', content: 'body of second' },
    ]);
    const round = parseNotes(serializeNotes(parsed));
    assert.deepEqual(round, parsed);
});

test('serializeNotes of an empty list yields an empty string', () => {
    assert.equal(serializeNotes([]), '');
});

// ---------------------------------------------------------------------------
// AC #1, #2 — CreateProjectNote persists + emits NoteCreated
// ---------------------------------------------------------------------------

test('CreateProjectNote writes a `## <noteId>` section and emits NoteCreated', async () => {
    const h = makeHarness();
    try {
        await h.cmdBus.send({
            type: NotesCommands.CREATE_NOTE,
            actor: 'op',
            issuedAt: 1,
            payload: {
                projectId: 'proj-A',
                noteId: 'idea-1',
                content: 'investigate flaky test',
            },
        });

        // AC #1 — on-disk persistence under core/projects/<projectId>/notes.md
        const notesFile = path.join(h.projectsRoot, 'proj-A', 'notes.md');
        const raw = fs.readFileSync(notesFile, 'utf8');
        assert.match(raw, /^## idea-1\b/m);
        assert.match(raw, /investigate flaky test/);

        // list-via-store returns the note
        const listed = h.store.list('proj-A');
        assert.deepEqual(listed, [{ noteId: 'idea-1', content: 'investigate flaky test' }]);

        // AC #2 — NoteCreated event with projectId + noteId
        const types = readEventTypes(h.db);
        assert.deepEqual(types, [NotesEvents.NOTE_CREATED]);
        const payload = readEventPayload<NoteLifecyclePayload>(h.db, NotesEvents.NOTE_CREATED);
        assert.equal(payload.projectId, 'proj-A');
        assert.equal(payload.noteId, 'idea-1');
        assert.equal(payload.content, 'investigate flaky test');
        assert.equal(typeof payload.timestamp, 'number');

        // AC #5 — Linear-document fake was invoked
        const calls = h.documentSync.getCalls();
        assert.equal(calls.length, 1);
        assert.deepEqual(calls[0], {
            projectId: 'proj-A',
            noteId: 'idea-1',
            content: 'investigate flaky test',
            action: 'created',
        });
    } finally {
        h.cleanup();
    }
});

// ---------------------------------------------------------------------------
// AC #2 — UpdateProjectNote mutates content but preserves the id
// ---------------------------------------------------------------------------

test('UpdateProjectNote mutates content but preserves the noteId', async () => {
    const h = makeHarness();
    try {
        await h.cmdBus.send({
            type: NotesCommands.CREATE_NOTE,
            actor: 'op',
            issuedAt: 1,
            payload: { projectId: 'proj-A', noteId: 'idea-1', content: 'first draft' },
        });
        await h.cmdBus.send({
            type: NotesCommands.UPDATE_NOTE,
            actor: 'op',
            issuedAt: 2,
            payload: { projectId: 'proj-A', noteId: 'idea-1', content: 'second draft' },
        });

        const listed = h.store.list('proj-A');
        assert.deepEqual(listed, [{ noteId: 'idea-1', content: 'second draft' }]);

        // NoteUpdated event landed with the new content
        const payload = readEventPayload<NoteLifecyclePayload>(h.db, NotesEvents.NOTE_UPDATED);
        assert.equal(payload.projectId, 'proj-A');
        assert.equal(payload.noteId, 'idea-1');
        assert.equal(payload.content, 'second draft');

        // Linear-document fake saw both the create and update calls
        const actions = h.documentSync.getCalls().map((c) => c.action);
        assert.deepEqual(actions, ['created', 'updated']);
    } finally {
        h.cleanup();
    }
});

// ---------------------------------------------------------------------------
// AC #2 — DeleteProjectNote removes the section
// ---------------------------------------------------------------------------

test('DeleteProjectNote removes the section and emits NoteDeleted', async () => {
    const h = makeHarness();
    try {
        await h.cmdBus.send({
            type: NotesCommands.CREATE_NOTE,
            actor: 'op',
            issuedAt: 1,
            payload: { projectId: 'proj-A', noteId: 'idea-1', content: 'transient' },
        });
        await h.cmdBus.send({
            type: NotesCommands.CREATE_NOTE,
            actor: 'op',
            issuedAt: 2,
            payload: { projectId: 'proj-A', noteId: 'idea-2', content: 'keeper' },
        });
        await h.cmdBus.send({
            type: NotesCommands.DELETE_NOTE,
            actor: 'op',
            issuedAt: 3,
            payload: { projectId: 'proj-A', noteId: 'idea-1' },
        });

        const listed = h.store.list('proj-A');
        assert.deepEqual(listed, [{ noteId: 'idea-2', content: 'keeper' }]);

        // Markdown file no longer contains the removed section header
        const raw = fs.readFileSync(
            path.join(h.projectsRoot, 'proj-A', 'notes.md'),
            'utf8',
        );
        assert.equal(raw.includes('## idea-1'), false);
        assert.match(raw, /^## idea-2\b/m);

        const payload = readEventPayload<NoteLifecyclePayload>(h.db, NotesEvents.NOTE_DELETED);
        assert.equal(payload.projectId, 'proj-A');
        assert.equal(payload.noteId, 'idea-1');

        // Linear-document fake saw the deletion (no content body)
        const calls = h.documentSync.getCalls();
        const deleteCall = calls.find((c) => c.action === 'deleted');
        assert.ok(deleteCall, 'fake recorder must capture the deleted call');
        assert.equal(deleteCall!.noteId, 'idea-1');
        assert.equal(deleteCall!.content, undefined);
    } finally {
        h.cleanup();
    }
});

// ---------------------------------------------------------------------------
// AC #3 — promoteNoteToPlan emits PlanDrafted with the note content as brief
// ---------------------------------------------------------------------------

test('PromoteNoteToPlan emits PlanDrafted with the note content as the plan brief', async () => {
    const h = makeHarness();
    try {
        await h.cmdBus.send({
            type: NotesCommands.CREATE_NOTE,
            actor: 'op',
            issuedAt: 1,
            payload: {
                projectId: 'proj-A',
                noteId: 'idea-1',
                content: 'rewrite the planner prompt to include conventions',
            },
        });
        await h.cmdBus.send({
            type: NotesCommands.PROMOTE_NOTE_TO_PLAN,
            actor: 'op',
            issuedAt: 2,
            payload: { projectId: 'proj-A', noteId: 'idea-1' },
        });

        assert.ok(readEventTypes(h.db).includes(NotesEvents.PLAN_DRAFTED));
        const payload = readEventPayload<PlanDraftedPayload>(h.db, NotesEvents.PLAN_DRAFTED);
        assert.equal(payload.projectId, 'proj-A');
        assert.equal(payload.noteId, 'idea-1');
        assert.equal(payload.brief, 'rewrite the planner prompt to include conventions');
        assert.equal(payload.planId, 'plan-idea-1');
        assert.equal(payload.actor, 'op');
    } finally {
        h.cleanup();
    }
});

test('PromoteNoteToPlan honours an operator-supplied planId override', async () => {
    const h = makeHarness();
    try {
        await h.cmdBus.send({
            type: NotesCommands.CREATE_NOTE,
            actor: 'op',
            issuedAt: 1,
            payload: { projectId: 'proj-A', noteId: 'idea-1', content: 'hello' },
        });
        await h.cmdBus.send({
            type: NotesCommands.PROMOTE_NOTE_TO_PLAN,
            actor: 'op',
            issuedAt: 2,
            payload: { projectId: 'proj-A', noteId: 'idea-1', planId: 'plan-custom' },
        });
        const payload = readEventPayload<PlanDraftedPayload>(h.db, NotesEvents.PLAN_DRAFTED);
        assert.equal(payload.planId, 'plan-custom');
    } finally {
        h.cleanup();
    }
});

test('PromoteNoteToPlan throws when the note is unknown', async () => {
    const h = makeHarness();
    try {
        await assert.rejects(
            h.cmdBus.send({
                type: NotesCommands.PROMOTE_NOTE_TO_PLAN,
                actor: 'op',
                issuedAt: 1,
                payload: { projectId: 'proj-A', noteId: 'ghost' },
            }),
            /no note "ghost"/,
        );
    } finally {
        h.cleanup();
    }
});

// ---------------------------------------------------------------------------
// AC #4 — convertNoteToInvestigation emits InvestigationRequested
// ---------------------------------------------------------------------------

test('ConvertNoteToInvestigation emits InvestigationRequested with the note content as the brief', async () => {
    const h = makeHarness();
    try {
        await h.cmdBus.send({
            type: NotesCommands.CREATE_NOTE,
            actor: 'op',
            issuedAt: 1,
            payload: {
                projectId: 'proj-A',
                noteId: 'idea-2',
                content: 'why is the test flaky?',
            },
        });
        await h.cmdBus.send({
            type: NotesCommands.CONVERT_NOTE_TO_INVESTIGATION,
            actor: 'op',
            issuedAt: 2,
            payload: { projectId: 'proj-A', noteId: 'idea-2' },
        });

        assert.ok(readEventTypes(h.db).includes(NotesEvents.INVESTIGATION_REQUESTED));
        const payload = readEventPayload<InvestigationRequestedFromNotePayload>(
            h.db,
            NotesEvents.INVESTIGATION_REQUESTED,
        );
        assert.equal(payload.projectId, 'proj-A');
        assert.equal(payload.noteId, 'idea-2');
        assert.equal(payload.brief, 'why is the test flaky?');
        assert.equal(payload.investigationId, 'investigation-idea-2');
        assert.equal(payload.actor, 'op');
    } finally {
        h.cleanup();
    }
});

// ---------------------------------------------------------------------------
// AC #5 — every CRUD mutation routes through the fake document-sync adapter
// ---------------------------------------------------------------------------

test('every CRUD mutation routes through the Linear-document fake adapter', async () => {
    const h = makeHarness();
    try {
        await h.cmdBus.send({
            type: NotesCommands.CREATE_NOTE,
            actor: 'op',
            issuedAt: 1,
            payload: { projectId: 'proj-A', noteId: 'idea-1', content: 'a' },
        });
        await h.cmdBus.send({
            type: NotesCommands.UPDATE_NOTE,
            actor: 'op',
            issuedAt: 2,
            payload: { projectId: 'proj-A', noteId: 'idea-1', content: 'b' },
        });
        await h.cmdBus.send({
            type: NotesCommands.DELETE_NOTE,
            actor: 'op',
            issuedAt: 3,
            payload: { projectId: 'proj-A', noteId: 'idea-1' },
        });

        const calls = h.documentSync.getCalls();
        assert.deepEqual(
            calls.map((c) => ({ action: c.action, noteId: c.noteId })),
            [
                { action: 'created', noteId: 'idea-1' },
                { action: 'updated', noteId: 'idea-1' },
                { action: 'deleted', noteId: 'idea-1' },
            ],
        );
    } finally {
        h.cleanup();
    }
});
