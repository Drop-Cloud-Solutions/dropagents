/**
 * AP-VP5-008 unit tests for the worker-api task action routes (Phase 5).
 *
 * Covers the five acceptance criteria:
 *   1. POST /tasks/:id/clarify dispatches
 *      `ResumeTask{ decision: 'approve', answer, remember }` and returns 202.
 *   2. POST /tasks/:id/reject dispatches
 *      `ResumeTask{ decision: 'reject', feedback }` and returns 202.
 *   3. POST /tasks/:id/investigation-followup dispatches
 *      `AskInvestigationFollowup{ taskId, question }` and returns 202.
 *   4. Each route returns 400 with a structured error on missing required
 *      fields and does NOT push a command onto the bus.
 *   5. Routes are protected by the existing `WORKER_API_TOKEN_V2` Bearer
 *      auth gate — exercised end-to-end behind a real BoardHttpServer.
 *
 * Dual-runner discovery (matches test/unit/orchestrator/notes-handler.test.ts):
 * the repo's `npm test` runs node:test; the review pipeline runs vitest
 * on changed files. The shim picks the right `test()` at module load so
 * both runners discover the same suite from a single source file.
 */
import * as assert from 'node:assert/strict';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';

import { BoardHttpServer, type CommandSink } from '../../../adapters/board-http/server';
import type { Command } from '../../../core/commands/command';
import {
    NoteOpsCommands,
    TaskParkingCommands,
    type AskInvestigationFollowupPayload,
    type ResumeTaskPayload,
} from '../../../core/commands/index';
import type { StoredEvent } from '../../../core/events/event';
import type { Logger } from '../../../core/ports/Logger';

import type { InvestigationThreadEntry } from '../../../core/flow/engine';
import {
    createTasksRouter,
    type AcceptedBody,
    type TaskThreadReader,
    type TasksCommandSink,
    type TasksRouter,
} from '../../../hosts/worker-api/routes/tasks';

// ---------------------------------------------------------------------------
// Dual-runner test() shim
// ---------------------------------------------------------------------------

type TestFn = (name: string, fn: () => void | Promise<void>) => void;

const test: TestFn = (((): TestFn => {
    if (process.env.VITEST) {
        const gt = (globalThis as { test?: TestFn }).test;
        if (typeof gt !== 'function') {
            throw new Error(
                'tasks-routes-phase5.test.ts: VITEST=true but globalThis.test is missing — '
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

interface FakeBus extends TasksCommandSink, CommandSink {
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

function buildRouter(
    overrides: Partial<{
        bus: TasksCommandSink;
        threadReader: TaskThreadReader;
    }> = {},
): { router: TasksRouter; bus: FakeBus } {
    const bus = (overrides.bus as FakeBus) ?? makeFakeBus();
    const router = createTasksRouter({
        bus,
        clock: () => 7_000,
        logger: new SilentLogger(),
        ...(overrides.threadReader !== undefined
            ? { threadReader: overrides.threadReader }
            : {}),
    });
    return { router, bus };
}

async function standaloneHarnessWithThread(
    threadReader: TaskThreadReader,
): Promise<StandaloneHarness> {
    const { router, bus } = buildRouter({ threadReader });
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
        close: () =>
            new Promise<void>((resolve, reject) =>
                server.close((err) => (err ? reject(err) : resolve())),
            ),
    };
}

// Standalone HTTP harness — mounts the tasks router as its own server with
// no auth. Used to exercise route dispatch, body parsing, and method
// handling without dragging in the BoardHttpServer scaffolding.
interface StandaloneHarness {
    readonly baseUrl: string;
    readonly bus: FakeBus;
    close(): Promise<void>;
}

async function standaloneHarness(): Promise<StandaloneHarness> {
    const { router, bus } = buildRouter();
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
        close: () =>
            new Promise<void>((resolve, reject) =>
                server.close((err) => (err ? reject(err) : resolve())),
            ),
    };
}

// End-to-end harness — mounts the tasks router behind a real
// BoardHttpServer so the Bearer auth gate (AC #5) is exercised through a
// real socket.
interface E2EHarness {
    readonly baseUrl: string;
    readonly bus: FakeBus;
    close(): Promise<void>;
}

async function e2eHarness(
    opts: { authToken?: string } = {},
): Promise<E2EHarness> {
    const { router, bus } = buildRouter();
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
        close: () => server.close(),
    };
}

// ---------------------------------------------------------------------------
// Clarify (AC #1)
// ---------------------------------------------------------------------------

test('HTTP: POST /tasks/:id/clarify dispatches ResumeTask{approve,answer,remember} and returns 202 (AC #1)', async () => {
    const h = await standaloneHarness();
    try {
        const res = await fetch(`${h.baseUrl}/tasks/task-A/clarify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                answer: 'use option B',
                remember: true,
                actor: 'op@x',
            }),
        });
        assert.equal(res.status, 202);
        const body = (await res.json()) as AcceptedBody;
        assert.equal(body.accepted, true);
        assert.equal(body.commandType, TaskParkingCommands.RESUME_TASK);
        assert.equal(body.taskId, 'task-A');

        assert.equal(h.bus.sent.length, 1);
        const cmd = h.bus.sent[0] as Command<ResumeTaskPayload>;
        assert.equal(cmd.type, TaskParkingCommands.RESUME_TASK);
        assert.equal(cmd.actor, 'op@x');
        assert.equal(cmd.issuedAt, 7_000);
        assert.deepEqual(cmd.payload, {
            taskId: 'task-A',
            decision: 'approve',
            answer: 'use option B',
            remember: true,
        });
    } finally {
        await h.close();
    }
});

test('HTTP: POST /tasks/:id/clarify omits remember when caller did not supply one', async () => {
    const h = await standaloneHarness();
    try {
        const res = await fetch(`${h.baseUrl}/tasks/task-A/clarify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ answer: 'yes' }),
        });
        assert.equal(res.status, 202);
        const cmd = h.bus.sent[0] as Command<ResumeTaskPayload>;
        assert.deepEqual(cmd.payload, {
            taskId: 'task-A',
            decision: 'approve',
            answer: 'yes',
        });
        assert.equal('remember' in cmd.payload, false);
    } finally {
        await h.close();
    }
});

test('HTTP: POST /tasks/:id/clarify threads optionKey through onto the ResumeTask payload', async () => {
    const h = await standaloneHarness();
    try {
        const res = await fetch(`${h.baseUrl}/tasks/task-A/clarify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ answer: 'pick A', optionKey: 'A' }),
        });
        assert.equal(res.status, 202);
        const cmd = h.bus.sent[0] as Command<ResumeTaskPayload>;
        assert.equal(cmd.payload.optionKey, 'A');
    } finally {
        await h.close();
    }
});

test('HTTP: POST /tasks/:id/clarify returns 400 when answer is missing (AC #4)', async () => {
    const h = await standaloneHarness();
    try {
        const res = await fetch(`${h.baseUrl}/tasks/task-A/clarify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ remember: true }),
        });
        assert.equal(res.status, 400);
        const body = (await res.json()) as { error: string };
        assert.match(body.error, /answer/);
        assert.equal(h.bus.sent.length, 0);
    } finally {
        await h.close();
    }
});

test('HTTP: POST /tasks/:id/clarify returns 400 when answer is the empty string (AC #4)', async () => {
    const h = await standaloneHarness();
    try {
        const res = await fetch(`${h.baseUrl}/tasks/task-A/clarify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ answer: '' }),
        });
        assert.equal(res.status, 400);
        assert.equal(h.bus.sent.length, 0);
    } finally {
        await h.close();
    }
});

test('HTTP: POST /tasks/:id/clarify returns 400 when remember is non-boolean (AC #4)', async () => {
    const h = await standaloneHarness();
    try {
        const res = await fetch(`${h.baseUrl}/tasks/task-A/clarify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ answer: 'ok', remember: 'yes' }),
        });
        assert.equal(res.status, 400);
        assert.equal(h.bus.sent.length, 0);
    } finally {
        await h.close();
    }
});

// ---------------------------------------------------------------------------
// Reject (AC #2)
// ---------------------------------------------------------------------------

test('HTTP: POST /tasks/:id/reject dispatches ResumeTask{reject,feedback} and returns 202 (AC #2)', async () => {
    const h = await standaloneHarness();
    try {
        const res = await fetch(`${h.baseUrl}/tasks/task-B/reject`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                feedback: 'this plan is wrong',
                actor: 'op',
            }),
        });
        assert.equal(res.status, 202);
        const body = (await res.json()) as AcceptedBody;
        assert.equal(body.commandType, TaskParkingCommands.RESUME_TASK);
        assert.equal(body.taskId, 'task-B');

        assert.equal(h.bus.sent.length, 1);
        const cmd = h.bus.sent[0] as Command<ResumeTaskPayload>;
        assert.equal(cmd.type, TaskParkingCommands.RESUME_TASK);
        assert.equal(cmd.actor, 'op');
        assert.deepEqual(cmd.payload, {
            taskId: 'task-B',
            decision: 'reject',
            feedback: 'this plan is wrong',
        });
    } finally {
        await h.close();
    }
});

test('HTTP: POST /tasks/:id/reject returns 400 when feedback is missing (AC #4)', async () => {
    const h = await standaloneHarness();
    try {
        const res = await fetch(`${h.baseUrl}/tasks/task-B/reject`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        });
        assert.equal(res.status, 400);
        const body = (await res.json()) as { error: string };
        assert.match(body.error, /feedback/);
        assert.equal(h.bus.sent.length, 0);
    } finally {
        await h.close();
    }
});

test('HTTP: POST /tasks/:id/reject returns 400 when feedback is the empty string (AC #4)', async () => {
    const h = await standaloneHarness();
    try {
        const res = await fetch(`${h.baseUrl}/tasks/task-B/reject`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ feedback: '' }),
        });
        assert.equal(res.status, 400);
        assert.equal(h.bus.sent.length, 0);
    } finally {
        await h.close();
    }
});

// ---------------------------------------------------------------------------
// Investigation follow-up (AC #3)
// ---------------------------------------------------------------------------

test('HTTP: POST /tasks/:id/investigation-followup dispatches AskInvestigationFollowup and returns 202 (AC #3)', async () => {
    const h = await standaloneHarness();
    try {
        const res = await fetch(
            `${h.baseUrl}/tasks/task-C/investigation-followup`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    question: 'what about the index migration?',
                    actor: 'op',
                }),
            },
        );
        assert.equal(res.status, 202);
        const body = (await res.json()) as AcceptedBody;
        assert.equal(
            body.commandType,
            NoteOpsCommands.ASK_INVESTIGATION_FOLLOWUP,
        );
        assert.equal(body.taskId, 'task-C');

        assert.equal(h.bus.sent.length, 1);
        const cmd = h.bus.sent[0] as Command<AskInvestigationFollowupPayload>;
        assert.equal(cmd.type, NoteOpsCommands.ASK_INVESTIGATION_FOLLOWUP);
        assert.equal(cmd.actor, 'op');
        assert.deepEqual(cmd.payload, {
            taskId: 'task-C',
            question: 'what about the index migration?',
        });
    } finally {
        await h.close();
    }
});

test('HTTP: POST /tasks/:id/investigation-followup returns 400 when question is missing (AC #4)', async () => {
    const h = await standaloneHarness();
    try {
        const res = await fetch(
            `${h.baseUrl}/tasks/task-C/investigation-followup`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({}),
            },
        );
        assert.equal(res.status, 400);
        const body = (await res.json()) as { error: string };
        assert.match(body.error, /question/);
        assert.equal(h.bus.sent.length, 0);
    } finally {
        await h.close();
    }
});

test('HTTP: POST /tasks/:id/investigation-followup returns 400 when question is the empty string (AC #4)', async () => {
    const h = await standaloneHarness();
    try {
        const res = await fetch(
            `${h.baseUrl}/tasks/task-C/investigation-followup`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ question: '' }),
            },
        );
        assert.equal(res.status, 400);
        assert.equal(h.bus.sent.length, 0);
    } finally {
        await h.close();
    }
});

// ---------------------------------------------------------------------------
// Method + body handling
// ---------------------------------------------------------------------------

test('HTTP: GET /tasks/:id/clarify returns 405 with Allow: POST', async () => {
    const h = await standaloneHarness();
    try {
        const res = await fetch(`${h.baseUrl}/tasks/task-A/clarify`);
        assert.equal(res.status, 405);
        assert.equal(res.headers.get('allow'), 'POST');
        assert.equal(h.bus.sent.length, 0);
    } finally {
        await h.close();
    }
});

test('HTTP: POST /tasks/:id/clarify returns 400 on invalid JSON body', async () => {
    const h = await standaloneHarness();
    try {
        const res = await fetch(`${h.baseUrl}/tasks/task-A/clarify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{not json',
        });
        assert.equal(res.status, 400);
        assert.equal(h.bus.sent.length, 0);
    } finally {
        await h.close();
    }
});

test('HTTP: unknown action /tasks/:id/foo returns 404 so the parent server can claim it', async () => {
    const h = await standaloneHarness();
    try {
        const res = await fetch(`${h.baseUrl}/tasks/task-A/foo`);
        // The standalone harness's fall-through handler also returns 404,
        // which is the right signal: the tasks router did not claim the
        // URL, so the parent surface (or the operator-facing 404) wins.
        assert.equal(res.status, 404);
    } finally {
        await h.close();
    }
});

// ---------------------------------------------------------------------------
// End-to-end auth + mounting (AC #5)
// ---------------------------------------------------------------------------

test('E2E: tasks routes are reachable through BoardHttpServer', async () => {
    const h = await e2eHarness();
    try {
        const res = await fetch(`${h.baseUrl}/tasks/task-A/clarify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ answer: 'yes' }),
        });
        assert.equal(res.status, 202);
        assert.equal(h.bus.sent.length, 1);
        assert.equal(h.bus.sent[0].type, TaskParkingCommands.RESUME_TASK);
    } finally {
        await h.close();
    }
});

test('E2E: POST /tasks/:id/clarify without Bearer token returns 401 + WWW-Authenticate: Bearer (AC #5)', async () => {
    const h = await e2eHarness({ authToken: 'shh' });
    try {
        const res = await fetch(`${h.baseUrl}/tasks/task-A/clarify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ answer: 'yes' }),
        });
        assert.equal(res.status, 401);
        assert.equal(res.headers.get('www-authenticate'), 'Bearer');
        // Auth fires before the router so no command reaches the bus.
        assert.equal(h.bus.sent.length, 0);
    } finally {
        await h.close();
    }
});

test('E2E: POST /tasks/:id/reject without Bearer token returns 401 (AC #5)', async () => {
    const h = await e2eHarness({ authToken: 'shh' });
    try {
        const res = await fetch(`${h.baseUrl}/tasks/task-B/reject`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ feedback: 'no' }),
        });
        assert.equal(res.status, 401);
        assert.equal(h.bus.sent.length, 0);
    } finally {
        await h.close();
    }
});

test('E2E: POST /tasks/:id/investigation-followup without Bearer token returns 401 (AC #5)', async () => {
    const h = await e2eHarness({ authToken: 'shh' });
    try {
        const res = await fetch(
            `${h.baseUrl}/tasks/task-C/investigation-followup`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ question: 'why?' }),
            },
        );
        assert.equal(res.status, 401);
        assert.equal(h.bus.sent.length, 0);
    } finally {
        await h.close();
    }
});

test('E2E: POST /tasks/:id/clarify with the correct Bearer token succeeds and dispatches ResumeTask', async () => {
    const h = await e2eHarness({ authToken: 'shh' });
    try {
        const res = await fetch(`${h.baseUrl}/tasks/task-A/clarify`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: 'Bearer shh',
            },
            body: JSON.stringify({ answer: 'go', remember: false }),
        });
        assert.equal(res.status, 202);
        assert.equal(h.bus.sent.length, 1);
        const cmd = h.bus.sent[0] as Command<ResumeTaskPayload>;
        assert.equal(cmd.type, TaskParkingCommands.RESUME_TASK);
        assert.equal(cmd.payload.decision, 'approve');
        assert.equal(cmd.payload.answer, 'go');
        assert.equal(cmd.payload.remember, false);
    } finally {
        await h.close();
    }
});

test('E2E: BoardHttpServer routes still work alongside the tasks router (no shadow)', async () => {
    const h = await e2eHarness({ authToken: 'shh' });
    try {
        // /health is auth-exempt and owned by BoardHttpServer itself. The
        // tasks router must not shadow it.
        const res = await fetch(`${h.baseUrl}/health`);
        assert.equal(res.status, 200);
    } finally {
        await h.close();
    }
});

// ---------------------------------------------------------------------------
// AP-VP5-011: GET /tasks/:id/investigation-thread (read route)
// ---------------------------------------------------------------------------

test('HTTP: GET /tasks/:id/investigation-thread returns the thread snapshot under taskId + thread keys', async () => {
    const seen: string[] = [];
    const reader: TaskThreadReader = {
        readThread(taskId): ReadonlyArray<InvestigationThreadEntry> {
            seen.push(taskId);
            return [
                { role: 'operator', content: 'why?', timestamp: 100 },
                { role: 'investigator', content: 'because.', timestamp: 200 },
            ];
        },
    };
    const h = await standaloneHarnessWithThread(reader);
    try {
        const res = await fetch(`${h.baseUrl}/tasks/task-A/investigation-thread`);
        assert.equal(res.status, 200);
        const body = (await res.json()) as {
            readonly taskId: string;
            readonly thread: ReadonlyArray<InvestigationThreadEntry>;
        };
        assert.equal(body.taskId, 'task-A');
        assert.deepEqual(body.thread, [
            { role: 'operator', content: 'why?', timestamp: 100 },
            { role: 'investigator', content: 'because.', timestamp: 200 },
        ]);
        assert.deepEqual(seen, ['task-A']);
    } finally {
        await h.close();
    }
});

test('HTTP: GET /tasks/:id/investigation-thread returns an empty array (200) when the task exists but has no turns', async () => {
    const reader: TaskThreadReader = {
        readThread(): ReadonlyArray<InvestigationThreadEntry> {
            return [];
        },
    };
    const h = await standaloneHarnessWithThread(reader);
    try {
        const res = await fetch(`${h.baseUrl}/tasks/task-A/investigation-thread`);
        assert.equal(res.status, 200);
        const body = (await res.json()) as {
            readonly taskId: string;
            readonly thread: ReadonlyArray<InvestigationThreadEntry>;
        };
        assert.equal(body.taskId, 'task-A');
        assert.deepEqual(body.thread, []);
    } finally {
        await h.close();
    }
});

test('HTTP: GET /tasks/:id/investigation-thread returns 404 when the reader resolves to null', async () => {
    const reader: TaskThreadReader = {
        readThread(): null {
            return null;
        },
    };
    const h = await standaloneHarnessWithThread(reader);
    try {
        const res = await fetch(`${h.baseUrl}/tasks/unknown/investigation-thread`);
        assert.equal(res.status, 404);
    } finally {
        await h.close();
    }
});

test('HTTP: GET /tasks/:id/investigation-thread returns 501 when no thread reader is configured', async () => {
    const h = await standaloneHarness();
    try {
        const res = await fetch(`${h.baseUrl}/tasks/task-A/investigation-thread`);
        assert.equal(res.status, 501);
    } finally {
        await h.close();
    }
});

test('HTTP: POST /tasks/:id/investigation-thread returns 405 with Allow: GET', async () => {
    const reader: TaskThreadReader = {
        readThread(): ReadonlyArray<InvestigationThreadEntry> {
            return [];
        },
    };
    const h = await standaloneHarnessWithThread(reader);
    try {
        const res = await fetch(`${h.baseUrl}/tasks/task-A/investigation-thread`, {
            method: 'POST',
        });
        assert.equal(res.status, 405);
        assert.equal(res.headers.get('allow'), 'GET');
    } finally {
        await h.close();
    }
});

test('HTTP: GET /tasks/:id/investigation-thread surfaces reader errors as 500', async () => {
    const reader: TaskThreadReader = {
        async readThread(): Promise<ReadonlyArray<InvestigationThreadEntry>> {
            throw new Error('lineage store offline');
        },
    };
    const h = await standaloneHarnessWithThread(reader);
    try {
        const res = await fetch(`${h.baseUrl}/tasks/task-A/investigation-thread`);
        assert.equal(res.status, 500);
        const body = (await res.json()) as { error: string; message: string };
        assert.match(body.error, /investigation-thread failed/);
        assert.equal(body.message, 'lineage store offline');
    } finally {
        await h.close();
    }
});
