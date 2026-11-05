/**
 * AP-VP5-009 unit tests for the worker-api notes routes.
 *
 * Covers the five acceptance criteria:
 *   1. GET /projects/:projectId/notes returns 200 + the parsed list,
 *      including the empty-array path when no notes have been stored.
 *   2. POST/PUT/DELETE dispatch the matching `CreateProjectNote`,
 *      `UpdateProjectNote`, `DeleteProjectNote` commands and return 202.
 *   3. POST /promote and POST /convert dispatch `PromoteNoteToPlan` and
 *      `ConvertNoteToInvestigation` and return 202.
 *   4. Routes are protected by `WORKER_API_TOKEN_V2` Bearer auth — a
 *      missing or wrong token returns 401 with the documented header,
 *      and no command reaches the bus.
 *   5. The router is reachable end-to-end behind a real
 *      {@link BoardHttpServer} so `/projects/:projectId/notes` resolves
 *      through the same surface the operator board talks to.
 *
 * Dual-runner discovery (matches test/unit/orchestrator/notes-handler.test.ts):
 * the repo's `npm test` runs node:test; the review pipeline runs vitest
 * on changed files. The shim picks the right `test()` at module load so
 * both runners discover the same suite from a single source file.
 */
import * as assert from 'node:assert/strict';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';

import type { Command } from '../../../core/commands/command';
import type { StoredEvent } from '../../../core/events/event';
import type { IdGen, Logger } from '../../../core/ports';

import { BoardHttpServer, type CommandSink } from '../../../adapters/board-http/server';
import {
    NotesCommands,
    type NoteRecord,
    type NotesStore,
    type CreateNotePayload,
    type UpdateNotePayload,
    type DeleteNotePayload,
    type PromoteNoteToPlanPayload,
    type ConvertNoteToInvestigationPayload,
} from '../../../hosts/orchestrator/handlers/notes';
import {
    createNotesRouter,
    listNotes,
    slugifyTitle,
    type AcceptedBody,
    type ListNotesBody,
    type NotesCommandSink,
    type NotesRouter,
} from '../../../hosts/worker-api/routes/notes';

// ---------------------------------------------------------------------------
// Dual-runner test() shim
// ---------------------------------------------------------------------------

type TestFn = (name: string, fn: () => void | Promise<void>) => void;

const test: TestFn = (((): TestFn => {
    if (process.env.VITEST) {
        const gt = (globalThis as { test?: TestFn }).test;
        if (typeof gt !== 'function') {
            throw new Error(
                'notes-routes.test.ts: VITEST=true but globalThis.test is missing — '
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
// Fakes
// ---------------------------------------------------------------------------

class SilentLogger implements Logger {
    info(): void {}
    warn(): void {}
    error(): void {}
    debug(): void {}
}

interface FakeStore extends NotesStore {
    seed(projectId: string, records: ReadonlyArray<NoteRecord>): void;
    readonly listCalls: Array<string>;
}

function makeFakeStore(): FakeStore {
    const data = new Map<string, NoteRecord[]>();
    const listCalls: string[] = [];
    return {
        listCalls,
        seed(projectId, records): void {
            data.set(projectId, records.map((r) => ({ ...r })));
        },
        list(projectId): NoteRecord[] {
            listCalls.push(projectId);
            return (data.get(projectId) ?? []).map((r) => ({ ...r }));
        },
        get(projectId, noteId): NoteRecord | undefined {
            return data.get(projectId)?.find((r) => r.noteId === noteId);
        },
        upsert(projectId, noteId, content): void {
            const arr = data.get(projectId) ?? [];
            const idx = arr.findIndex((r) => r.noteId === noteId);
            if (idx === -1) arr.push({ noteId, content });
            else arr[idx] = { noteId, content };
            data.set(projectId, arr);
        },
        delete(projectId, noteId): boolean {
            const arr = data.get(projectId);
            if (!arr) return false;
            const idx = arr.findIndex((r) => r.noteId === noteId);
            if (idx === -1) return false;
            arr.splice(idx, 1);
            return true;
        },
    };
}

interface FakeBus extends NotesCommandSink, CommandSink {
    readonly sent: ReadonlyArray<Command>;
}

function makeFakeBus(): FakeBus {
    const sent: Command[] = [];
    return {
        get sent(): readonly Command[] {
            return sent;
        },
        async send(cmd): Promise<readonly StoredEvent[]> {
            sent.push(cmd);
            return [];
        },
    };
}

const fakeIdGen: IdGen = {
    newId: (): string => 'generated-id-1',
};

function buildRouter(
    overrides: Partial<{ store: NotesStore; bus: NotesCommandSink }> = {},
): { router: NotesRouter; bus: FakeBus; store: FakeStore } {
    const store = (overrides.store as FakeStore) ?? makeFakeStore();
    const bus = (overrides.bus as FakeBus) ?? makeFakeBus();
    const router = createNotesRouter({
        store,
        bus,
        idGen: fakeIdGen,
        clock: () => 7_000,
        logger: new SilentLogger(),
    });
    return { router, bus, store };
}

// HTTP harness: mounts the notes router as a standalone server with no
// auth — used to exercise route dispatch, body parsing, method handling
// without dragging the BoardHttpServer scaffolding in.
interface StandaloneHarness {
    readonly baseUrl: string;
    readonly bus: FakeBus;
    readonly store: FakeStore;
    close(): Promise<void>;
}

async function standaloneHarness(): Promise<StandaloneHarness> {
    const { router, bus, store } = buildRouter();
    const server = http.createServer((req, res) => {
        if (router.handle(req, res)) return;
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    return {
        baseUrl: `http://127.0.0.1:${port}`,
        bus,
        store,
        close: () =>
            new Promise<void>((resolve, reject) =>
                server.close((err) => (err ? reject(err) : resolve())),
            ),
    };
}

// End-to-end harness: mounts the notes router behind a real
// BoardHttpServer so the auth gate (AC #4) and the extraRouters wiring
// (AC #5) are both exercised through a real socket.
interface E2EHarness {
    readonly baseUrl: string;
    readonly bus: FakeBus;
    readonly store: FakeStore;
    close(): Promise<void>;
}

async function e2eHarness(
    opts: { authToken?: string } = {},
): Promise<E2EHarness> {
    const { router, bus, store } = buildRouter();
    const server = new BoardHttpServer({
        commandBus: bus,
        subscribeAll: () => () => {},
        ...(opts.authToken !== undefined ? { authToken: opts.authToken } : {}),
        extraRouters: [router],
        logger: new SilentLogger(),
    });
    const { port } = await server.listen(0);
    return {
        baseUrl: `http://127.0.0.1:${port}`,
        bus,
        store,
        close: () => server.close(),
    };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test('slugifyTitle: kebab-cases a normal title', () => {
    assert.equal(slugifyTitle('My Note About Things'), 'my-note-about-things');
});

test('slugifyTitle: returns null for all-punctuation input', () => {
    assert.equal(slugifyTitle('!!!'), null);
});

test('slugifyTitle: collapses runs of separators', () => {
    assert.equal(slugifyTitle('  hello---world  '), 'hello-world');
});

// ---------------------------------------------------------------------------
// GET — empty + populated (AC #1)
// ---------------------------------------------------------------------------

test('listNotes returns an empty array when no notes exist for the project', async () => {
    const store = makeFakeStore();
    const bus = makeFakeBus();
    const result = await listNotes(
        { store, bus, idGen: fakeIdGen },
        'proj-empty',
    );
    assert.equal(result.status, 200);
    const body = result.body as unknown as ListNotesBody;
    assert.deepEqual(body, { notes: [] });
    assert.deepEqual(store.listCalls, ['proj-empty']);
});

test('listNotes returns the populated note list in source order', async () => {
    const store = makeFakeStore();
    store.seed('proj-1', [
        { noteId: 'a', content: 'first' },
        { noteId: 'b', content: 'second' },
    ]);
    const bus = makeFakeBus();
    const result = await listNotes(
        { store, bus, idGen: fakeIdGen },
        'proj-1',
    );
    assert.equal(result.status, 200);
    const body = result.body as unknown as ListNotesBody;
    assert.deepEqual(body, {
        notes: [
            { noteId: 'a', content: 'first' },
            { noteId: 'b', content: 'second' },
        ],
    });
});

test('HTTP: GET /projects/:pid/notes returns 200 with empty array when notes.md missing (AC #1)', async () => {
    const h = await standaloneHarness();
    try {
        const res = await fetch(`${h.baseUrl}/projects/proj-empty/notes`);
        assert.equal(res.status, 200);
        const body = (await res.json()) as ListNotesBody;
        assert.deepEqual(body, { notes: [] });
    } finally {
        await h.close();
    }
});

test('HTTP: GET /projects/:pid/notes returns 200 with the populated list (AC #1)', async () => {
    const h = await standaloneHarness();
    try {
        h.store.seed('proj-1', [
            { noteId: 'design', content: '# Design notes' },
            { noteId: 'todo', content: '- a\n- b' },
        ]);
        const res = await fetch(`${h.baseUrl}/projects/proj-1/notes`);
        assert.equal(res.status, 200);
        const body = (await res.json()) as ListNotesBody;
        assert.deepEqual(body, {
            notes: [
                { noteId: 'design', content: '# Design notes' },
                { noteId: 'todo', content: '- a\n- b' },
            ],
        });
    } finally {
        await h.close();
    }
});

// ---------------------------------------------------------------------------
// Mutations dispatch matching commands + return 202 (AC #2, #3)
// ---------------------------------------------------------------------------

test('HTTP: POST /projects/:pid/notes dispatches CreateProjectNote and returns 202 (AC #2)', async () => {
    const h = await standaloneHarness();
    try {
        const res = await fetch(`${h.baseUrl}/projects/proj-1/notes`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                content: '# Hello',
                title: 'My First Note',
                actor: 'op@x',
            }),
        });
        assert.equal(res.status, 202);
        const body = (await res.json()) as AcceptedBody;
        assert.equal(body.accepted, true);
        assert.equal(body.commandType, NotesCommands.CREATE_NOTE);
        // Title slugifies into the noteId so the operator can predict
        // the on-disk section header without a round-trip.
        assert.equal(body.noteId, 'my-first-note');
        assert.equal(h.bus.sent.length, 1);
        const cmd = h.bus.sent[0] as Command<CreateNotePayload>;
        assert.equal(cmd.type, NotesCommands.CREATE_NOTE);
        assert.equal(cmd.actor, 'op@x');
        assert.equal(cmd.issuedAt, 7_000);
        assert.deepEqual(cmd.payload, {
            projectId: 'proj-1',
            noteId: 'my-first-note',
            content: '# Hello',
        });
    } finally {
        await h.close();
    }
});

test('HTTP: POST /projects/:pid/notes generates a noteId via IdGen when title is missing', async () => {
    const h = await standaloneHarness();
    try {
        const res = await fetch(`${h.baseUrl}/projects/proj-1/notes`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: 'untitled' }),
        });
        assert.equal(res.status, 202);
        const body = (await res.json()) as AcceptedBody;
        assert.equal(body.noteId, 'generated-id-1');
        const cmd = h.bus.sent[0] as Command<CreateNotePayload>;
        assert.equal(cmd.payload.noteId, 'generated-id-1');
    } finally {
        await h.close();
    }
});

test('HTTP: POST /projects/:pid/notes honours an explicit noteId in the body', async () => {
    const h = await standaloneHarness();
    try {
        const res = await fetch(`${h.baseUrl}/projects/proj-1/notes`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: 'x', noteId: 'explicit-id' }),
        });
        assert.equal(res.status, 202);
        const cmd = h.bus.sent[0] as Command<CreateNotePayload>;
        assert.equal(cmd.payload.noteId, 'explicit-id');
    } finally {
        await h.close();
    }
});

test('HTTP: POST /projects/:pid/notes rejects a body without content (400, no dispatch)', async () => {
    const h = await standaloneHarness();
    try {
        const res = await fetch(`${h.baseUrl}/projects/proj-1/notes`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: 'no content here' }),
        });
        assert.equal(res.status, 400);
        assert.equal(h.bus.sent.length, 0);
    } finally {
        await h.close();
    }
});

test('HTTP: PUT /projects/:pid/notes/:noteId dispatches UpdateProjectNote and returns 202 (AC #2)', async () => {
    const h = await standaloneHarness();
    try {
        const res = await fetch(`${h.baseUrl}/projects/proj-1/notes/n-1`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: 'updated body', actor: 'op' }),
        });
        assert.equal(res.status, 202);
        const body = (await res.json()) as AcceptedBody;
        assert.equal(body.commandType, NotesCommands.UPDATE_NOTE);
        assert.equal(body.noteId, 'n-1');
        assert.equal(h.bus.sent.length, 1);
        const cmd = h.bus.sent[0] as Command<UpdateNotePayload>;
        assert.equal(cmd.type, NotesCommands.UPDATE_NOTE);
        assert.equal(cmd.actor, 'op');
        assert.deepEqual(cmd.payload, {
            projectId: 'proj-1',
            noteId: 'n-1',
            content: 'updated body',
        });
    } finally {
        await h.close();
    }
});

test('HTTP: DELETE /projects/:pid/notes/:noteId dispatches DeleteProjectNote and returns 202 (AC #2)', async () => {
    const h = await standaloneHarness();
    try {
        const res = await fetch(`${h.baseUrl}/projects/proj-1/notes/n-1`, {
            method: 'DELETE',
        });
        assert.equal(res.status, 202);
        const body = (await res.json()) as AcceptedBody;
        assert.equal(body.commandType, NotesCommands.DELETE_NOTE);
        assert.equal(h.bus.sent.length, 1);
        const cmd = h.bus.sent[0] as Command<DeleteNotePayload>;
        assert.equal(cmd.type, NotesCommands.DELETE_NOTE);
        assert.deepEqual(cmd.payload, { projectId: 'proj-1', noteId: 'n-1' });
    } finally {
        await h.close();
    }
});

test('HTTP: POST /projects/:pid/notes/:noteId/promote dispatches PromoteNoteToPlan and returns 202 (AC #3)', async () => {
    const h = await standaloneHarness();
    try {
        const res = await fetch(
            `${h.baseUrl}/projects/proj-1/notes/n-1/promote`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ planId: 'plan-7', actor: 'op' }),
            },
        );
        assert.equal(res.status, 202);
        const body = (await res.json()) as AcceptedBody;
        assert.equal(body.commandType, NotesCommands.PROMOTE_NOTE_TO_PLAN);
        assert.equal(h.bus.sent.length, 1);
        const cmd = h.bus.sent[0] as Command<PromoteNoteToPlanPayload>;
        assert.equal(cmd.type, NotesCommands.PROMOTE_NOTE_TO_PLAN);
        assert.equal(cmd.actor, 'op');
        assert.deepEqual(cmd.payload, {
            projectId: 'proj-1',
            noteId: 'n-1',
            planId: 'plan-7',
        });
    } finally {
        await h.close();
    }
});

test('HTTP: POST /projects/:pid/notes/:noteId/promote omits planId when caller did not supply one', async () => {
    const h = await standaloneHarness();
    try {
        const res = await fetch(
            `${h.baseUrl}/projects/proj-1/notes/n-1/promote`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({}),
            },
        );
        assert.equal(res.status, 202);
        const cmd = h.bus.sent[0] as Command<PromoteNoteToPlanPayload>;
        assert.deepEqual(cmd.payload, { projectId: 'proj-1', noteId: 'n-1' });
        assert.equal('planId' in cmd.payload, false);
    } finally {
        await h.close();
    }
});

test('HTTP: POST /projects/:pid/notes/:noteId/convert dispatches ConvertNoteToInvestigation and returns 202 (AC #3)', async () => {
    const h = await standaloneHarness();
    try {
        const res = await fetch(
            `${h.baseUrl}/projects/proj-1/notes/n-1/convert`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    investigationId: 'inv-9',
                    actor: 'op',
                }),
            },
        );
        assert.equal(res.status, 202);
        const body = (await res.json()) as AcceptedBody;
        assert.equal(
            body.commandType,
            NotesCommands.CONVERT_NOTE_TO_INVESTIGATION,
        );
        assert.equal(h.bus.sent.length, 1);
        const cmd = h.bus.sent[0] as Command<ConvertNoteToInvestigationPayload>;
        assert.equal(cmd.type, NotesCommands.CONVERT_NOTE_TO_INVESTIGATION);
        assert.deepEqual(cmd.payload, {
            projectId: 'proj-1',
            noteId: 'n-1',
            investigationId: 'inv-9',
        });
    } finally {
        await h.close();
    }
});

// ---------------------------------------------------------------------------
// Method handling
// ---------------------------------------------------------------------------

test('HTTP: PATCH /projects/:pid/notes/:noteId returns 405 with Allow: PUT, DELETE', async () => {
    const h = await standaloneHarness();
    try {
        const res = await fetch(`${h.baseUrl}/projects/proj-1/notes/n-1`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
        });
        assert.equal(res.status, 405);
        assert.equal(res.headers.get('allow'), 'PUT, DELETE');
        assert.equal(h.bus.sent.length, 0);
    } finally {
        await h.close();
    }
});

test('HTTP: GET /projects/:pid/notes/:noteId/promote returns 405 with Allow: POST', async () => {
    const h = await standaloneHarness();
    try {
        const res = await fetch(
            `${h.baseUrl}/projects/proj-1/notes/n-1/promote`,
        );
        assert.equal(res.status, 405);
        assert.equal(res.headers.get('allow'), 'POST');
    } finally {
        await h.close();
    }
});

// ---------------------------------------------------------------------------
// End-to-end auth + mounting (AC #4, #5)
// ---------------------------------------------------------------------------

test('E2E: notes routes are reachable through BoardHttpServer (AC #5)', async () => {
    const h = await e2eHarness();
    try {
        h.store.seed('proj-e2e', [{ noteId: 'a', content: 'hello' }]);
        const res = await fetch(`${h.baseUrl}/projects/proj-e2e/notes`);
        assert.equal(res.status, 200);
        const body = (await res.json()) as ListNotesBody;
        assert.deepEqual(body, { notes: [{ noteId: 'a', content: 'hello' }] });
    } finally {
        await h.close();
    }
});

test('E2E: GET without Bearer token returns 401 + WWW-Authenticate: Bearer (AC #4)', async () => {
    const h = await e2eHarness({ authToken: 'shh' });
    try {
        const res = await fetch(`${h.baseUrl}/projects/proj-e2e/notes`);
        assert.equal(res.status, 401);
        assert.equal(res.headers.get('www-authenticate'), 'Bearer');
        // Auth fires before the router so the store must not be touched.
        assert.equal(h.store.listCalls.length, 0);
    } finally {
        await h.close();
    }
});

test('E2E: POST without Bearer token returns 401 and no command reaches the bus (AC #4)', async () => {
    const h = await e2eHarness({ authToken: 'shh' });
    try {
        const res = await fetch(`${h.baseUrl}/projects/proj-e2e/notes`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: 'x' }),
        });
        assert.equal(res.status, 401);
        assert.equal(res.headers.get('www-authenticate'), 'Bearer');
        assert.equal(h.bus.sent.length, 0);
    } finally {
        await h.close();
    }
});

test('E2E: POST with the correct Bearer token succeeds and dispatches CreateProjectNote', async () => {
    const h = await e2eHarness({ authToken: 'shh' });
    try {
        const res = await fetch(`${h.baseUrl}/projects/proj-e2e/notes`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: 'Bearer shh',
            },
            body: JSON.stringify({ content: 'x', noteId: 'n-1' }),
        });
        assert.equal(res.status, 202);
        assert.equal(h.bus.sent.length, 1);
        assert.equal(h.bus.sent[0].type, NotesCommands.CREATE_NOTE);
    } finally {
        await h.close();
    }
});

test('E2E: BoardHttpServer routes still work alongside the notes router (no shadow)', async () => {
    const h = await e2eHarness({ authToken: 'shh' });
    try {
        // /health is auth-exempt and is owned by BoardHttpServer itself.
        // Notes routing must not break it.
        const res = await fetch(`${h.baseUrl}/health`);
        assert.equal(res.status, 200);
    } finally {
        await h.close();
    }
});
