import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import type { Command } from '../../core/commands/command';
import type { StoredEvent } from '../../core/events/event';
import type { Logger } from '../../core/ports/Logger';

import type {
    DecomposeStatusPort,
    DecomposeStatusSnapshot,
} from '../../hosts/worker-api/routes/decompose-status';

import { BoardHttpServer, type CommandSink } from './server';

class CapturingLogger implements Logger {
    readonly warns: { msg: string; meta?: Readonly<Record<string, unknown>> }[] = [];
    info(): void {}
    warn(msg: string, meta?: Readonly<Record<string, unknown>>): void {
        this.warns.push({ msg, meta });
    }
    error(): void {}
    debug(): void {}
}

interface Harness {
    readonly baseUrl: string;
    readonly sent: Command[];
    readonly logger: CapturingLogger;
    readonly decomposeCalls: Array<{ projectId: string; planId: string }>;
    publish(event: StoredEvent): void;
    setSendResult(events: StoredEvent[]): void;
    setSendError(err: Error): void;
    setDecomposeSnapshot(snapshot: DecomposeStatusSnapshot | null): void;
    close(): Promise<void>;
}

async function makeHarness(
    opts: { token?: string; wireDecomposeStatus?: boolean } = {},
): Promise<Harness> {
    const sent: Command[] = [];
    const allHandlers = new Set<(e: StoredEvent) => void>();
    const decomposeCalls: Array<{ projectId: string; planId: string }> = [];
    let nextResult: StoredEvent[] = [];
    let nextError: Error | undefined;
    let decomposeSnapshot: DecomposeStatusSnapshot | null = {
        startedAt: null,
        finishedAt: null,
        errorMessage: null,
        currentStep: 0,
        totalSteps: 0,
    };

    const commandBus: CommandSink = {
        async send(cmd: Command): Promise<readonly StoredEvent[]> {
            sent.push(cmd);
            if (nextError) throw nextError;
            return nextResult;
        },
    };

    const decomposeStatusPort: DecomposeStatusPort = {
        async readDecomposeStatus(projectId, planId) {
            decomposeCalls.push({ projectId, planId });
            if (decomposeSnapshot === null) {
                throw new Error('fake port: snapshot misconfigured');
            }
            return decomposeSnapshot;
        },
    };

    const logger = new CapturingLogger();
    const server = new BoardHttpServer({
        commandBus,
        subscribeAll: (h) => {
            allHandlers.add(h);
            return () => {
                allHandlers.delete(h);
            };
        },
        authToken: opts.token,
        decomposeStatusPort:
            opts.wireDecomposeStatus === false ? undefined : decomposeStatusPort,
        logger,
    });

    const { port } = await server.listen(0);

    return {
        baseUrl: `http://127.0.0.1:${port}`,
        sent,
        logger,
        decomposeCalls,
        publish: (event) => {
            for (const h of allHandlers) h(event);
        },
        setSendResult: (events) => {
            nextResult = events;
        },
        setSendError: (err) => {
            nextError = err;
        },
        setDecomposeSnapshot: (snapshot) => {
            decomposeSnapshot = snapshot;
        },
        close: () => server.close(),
    };
}

function makeStoredEvent(overrides: Partial<StoredEvent> = {}): StoredEvent {
    return {
        seq: 1,
        type: 'TestEvent',
        v: 1,
        occurredAt: 1_700_000_000_000,
        idempotencyKey: 'k-1',
        payload: { hello: 'world' },
        ...overrides,
    };
}

test('POST /commands accepts a valid command and returns 202 with stored events', async () => {
    const h = await makeHarness({ token: 'shh' });
    try {
        h.setSendResult([
            makeStoredEvent({ seq: 11, type: 'PlanApproved', payload: { planId: 'p1' } }),
        ]);

        const cmd: Command = {
            type: 'ApprovePlan',
            actor: 'integration-test',
            issuedAt: 1_700_000_000_000,
            payload: { planId: 'p1' },
        };
        const res = await fetch(`${h.baseUrl}/commands`, {
            method: 'POST',
            headers: {
                Authorization: 'Bearer shh',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(cmd),
        });

        assert.equal(res.status, 202);
        const body = (await res.json()) as { events: StoredEvent[] };
        assert.equal(body.events.length, 1);
        assert.equal(body.events[0].type, 'PlanApproved');
        assert.equal(body.events[0].seq, 11);

        assert.equal(h.sent.length, 1);
        assert.equal(h.sent[0].type, 'ApprovePlan');
        assert.equal(h.sent[0].actor, 'integration-test');
        assert.deepEqual(h.sent[0].payload, { planId: 'p1' });
    } finally {
        await h.close();
    }
});

test('POST /commands rejects bodies that fail command-shape validation', async () => {
    const h = await makeHarness({ token: 'shh' });
    try {
        const res = await fetch(`${h.baseUrl}/commands`, {
            method: 'POST',
            headers: { Authorization: 'Bearer shh', 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'X' }),
        });
        assert.equal(res.status, 400);
        assert.equal(h.sent.length, 0, 'invalid body must not reach the CommandBus');
    } finally {
        await h.close();
    }
});

test('POST /commands without a Bearer token returns 401 with WWW-Authenticate: Bearer', async () => {
    const h = await makeHarness({ token: 'shh' });
    try {
        const res = await fetch(`${h.baseUrl}/commands`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                type: 'X',
                actor: 'a',
                issuedAt: 0,
                payload: {},
            }),
        });
        assert.equal(res.status, 401);
        assert.equal(res.headers.get('www-authenticate'), 'Bearer');
        assert.equal(h.sent.length, 0, 'unauthorized requests must not reach the bus');
    } finally {
        await h.close();
    }
});

test('POST /commands with a wrong Bearer token returns 401', async () => {
    const h = await makeHarness({ token: 'shh' });
    try {
        const res = await fetch(`${h.baseUrl}/commands`, {
            method: 'POST',
            headers: {
                Authorization: 'Bearer not-the-real-one',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                type: 'X',
                actor: 'a',
                issuedAt: 0,
                payload: {},
            }),
        });
        assert.equal(res.status, 401);
        assert.equal(res.headers.get('www-authenticate'), 'Bearer');
    } finally {
        await h.close();
    }
});

test('GET /events streams every published event as an SSE data frame', async () => {
    const h = await makeHarness({ token: 'shh' });
    try {
        const ac = new AbortController();
        const res = await fetch(`${h.baseUrl}/events`, {
            headers: { Authorization: 'Bearer shh' },
            signal: ac.signal,
        });
        assert.equal(res.status, 200);
        assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);

        const reader = res.body!.getReader();
        const decoder = new TextDecoder();

        // Push one event after the request handler has registered its
        // subscriber (which happens synchronously before `flushHeaders`).
        // setImmediate gives Node one tick to deliver the response head
        // to the client before we publish.
        setImmediate(() => {
            h.publish(
                makeStoredEvent({
                    seq: 42,
                    type: 'AgentFinished',
                    payload: { agentId: 'a-1' },
                }),
            );
        });

        // Read until we have at least one complete data frame.
        let buffer = '';
        while (!buffer.includes('\n\n')) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
        }

        assert.match(buffer, /^data: /);
        const jsonPart = buffer.slice('data: '.length).split('\n\n', 1)[0];
        const parsed = JSON.parse(jsonPart) as StoredEvent;
        assert.equal(parsed.type, 'AgentFinished');
        assert.equal(parsed.seq, 42);
        assert.deepEqual(parsed.payload, { agentId: 'a-1' });

        ac.abort();
        // Allow the abort to propagate so reader.cancel doesn't dangle.
        await reader.cancel().catch(() => undefined);
    } finally {
        await h.close();
    }
});

test('GET /events requires auth when a token is configured', async () => {
    const h = await makeHarness({ token: 'shh' });
    try {
        const res = await fetch(`${h.baseUrl}/events`);
        assert.equal(res.status, 401);
        assert.equal(res.headers.get('www-authenticate'), 'Bearer');
    } finally {
        await h.close();
    }
});

test('GET /health returns 200 without an Authorization header', async () => {
    const h = await makeHarness({ token: 'shh' });
    try {
        const res = await fetch(`${h.baseUrl}/health`);
        assert.equal(res.status, 200);
        const body = (await res.json()) as { status: string };
        assert.equal(body.status, 'ok');
    } finally {
        await h.close();
    }
});

test('Unset WORKER_API_TOKEN_V2 disables auth on every endpoint and logs a warning', async () => {
    const h = await makeHarness({}); // no token
    try {
        const startupWarning = h.logger.warns.find((w) =>
            /WORKER_API_TOKEN_V2 unset/.test(w.msg),
        );
        assert.ok(startupWarning, 'server must warn at startup when token is unset');

        const cmd: Command = {
            type: 'ApprovePlan',
            actor: 'localhost',
            issuedAt: 1,
            payload: { planId: 'p1' },
        };
        const res = await fetch(`${h.baseUrl}/commands`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(cmd),
        });
        assert.equal(res.status, 202, 'commands must succeed without auth when token is unset');
        assert.equal(h.sent.length, 1);

        const health = await fetch(`${h.baseUrl}/health`);
        assert.equal(health.status, 200);
    } finally {
        await h.close();
    }
});

// ---------------------------------------------------------------------------
// AP-IFF-005 — decompose-status projection route
//
// These tests prove three things the reviewer asked for: the route is
// actually dispatched by the host router (not just defined in
// `routes/decompose-status.ts`), the auth middleware fronts it, and the
// injected port is invoked with the right path params.
// ---------------------------------------------------------------------------

test('GET /api/projects/:pid/plans/:planId/decompose-status returns idle body with auth', async () => {
    const h = await makeHarness({ token: 'shh' });
    try {
        const res = await fetch(
            `${h.baseUrl}/api/projects/proj-A/plans/plan-1/decompose-status`,
            { headers: { Authorization: 'Bearer shh' } },
        );
        assert.equal(res.status, 200);
        const body = (await res.json()) as {
            status: string;
            progress: { currentStep: number; totalSteps: number };
        };
        assert.equal(body.status, 'idle');
        assert.deepEqual(body.progress, { currentStep: 0, totalSteps: 0 });
        assert.deepEqual(h.decomposeCalls, [
            { projectId: 'proj-A', planId: 'plan-1' },
        ]);
    } finally {
        await h.close();
    }
});

test('GET decompose-status surfaces running state from the injected port', async () => {
    const h = await makeHarness({ token: 'shh' });
    try {
        h.setDecomposeSnapshot({
            startedAt: 1_700_000_000_000,
            finishedAt: null,
            errorMessage: null,
            currentStep: 2,
            totalSteps: 6,
        });
        const res = await fetch(
            `${h.baseUrl}/api/projects/proj-A/plans/plan-1/decompose-status`,
            { headers: { Authorization: 'Bearer shh' } },
        );
        assert.equal(res.status, 200);
        const body = (await res.json()) as {
            status: string;
            progress: { currentStep: number; totalSteps: number };
        };
        assert.equal(body.status, 'running');
        assert.deepEqual(body.progress, { currentStep: 2, totalSteps: 6 });
    } finally {
        await h.close();
    }
});

test('GET decompose-status requires auth when a token is configured', async () => {
    const h = await makeHarness({ token: 'shh' });
    try {
        const res = await fetch(
            `${h.baseUrl}/api/projects/proj-A/plans/plan-1/decompose-status`,
        );
        assert.equal(res.status, 401);
        assert.equal(res.headers.get('www-authenticate'), 'Bearer');
        // The port must not have been hit on an unauthorized request.
        assert.equal(h.decomposeCalls.length, 0);
    } finally {
        await h.close();
    }
});

test('GET decompose-status rejects a wrong Bearer token with 401', async () => {
    const h = await makeHarness({ token: 'shh' });
    try {
        const res = await fetch(
            `${h.baseUrl}/api/projects/proj-A/plans/plan-1/decompose-status`,
            { headers: { Authorization: 'Bearer nope' } },
        );
        assert.equal(res.status, 401);
        assert.equal(h.decomposeCalls.length, 0);
    } finally {
        await h.close();
    }
});

test('GET decompose-status returns 404 when no port is wired into the server', async () => {
    const h = await makeHarness({ token: 'shh', wireDecomposeStatus: false });
    try {
        const res = await fetch(
            `${h.baseUrl}/api/projects/proj-A/plans/plan-1/decompose-status`,
            { headers: { Authorization: 'Bearer shh' } },
        );
        assert.equal(res.status, 404);
    } finally {
        await h.close();
    }
});

test('GET decompose-status decodes percent-encoded path params before passing to the port', async () => {
    const h = await makeHarness({ token: 'shh' });
    try {
        const res = await fetch(
            `${h.baseUrl}/api/projects/proj%20A/plans/plan%2F1/decompose-status`,
            { headers: { Authorization: 'Bearer shh' } },
        );
        assert.equal(res.status, 200);
        assert.deepEqual(h.decomposeCalls, [
            { projectId: 'proj A', planId: 'plan/1' },
        ]);
    } finally {
        await h.close();
    }
});

test('POST /commands surfaces CommandBus errors as 500', async () => {
    const h = await makeHarness({ token: 'shh' });
    try {
        h.setSendError(new Error('handler exploded'));
        const res = await fetch(`${h.baseUrl}/commands`, {
            method: 'POST',
            headers: { Authorization: 'Bearer shh', 'Content-Type': 'application/json' },
            body: JSON.stringify({
                type: 'X',
                actor: 'a',
                issuedAt: 0,
                payload: {},
            }),
        });
        assert.equal(res.status, 500);
        const body = (await res.json()) as { error: string; message: string };
        assert.match(body.message, /handler exploded/);
    } finally {
        await h.close();
    }
});
