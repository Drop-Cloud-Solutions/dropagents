/**
 * /api/chat/config-apply — target routing, dry-run gating, the secret
 * round-trip, and the in-thread outcome note. All manager-api traffic
 * goes through an injected fake fetch; no real HTTP or config writes.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as http from 'node:http';

import { createChatConfigApplyRouter, CHAT_CONFIG_APPLY_ROUTE } from './chat-config-apply';

interface Recorded {
    url: string;
    method: string;
    body?: string;
}

function makeFakeManager(
    responder: (url: string, method: string) => { status: number; body: unknown },
): { calls: Recorded[]; fetchImpl: (url: string, init?: { method?: string; body?: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }> } {
    const calls: Recorded[] = [];
    return {
        calls,
        fetchImpl: async (url, init) => {
            const method = init?.method ?? 'GET';
            calls.push({ url, method, ...(init?.body !== undefined ? { body: init.body } : {}) });
            const r = responder(url, method);
            return {
                ok: r.status < 300,
                status: r.status,
                json: async () => r.body,
                text: async () => JSON.stringify(r.body),
            };
        },
    };
}

async function post(
    router: ReturnType<typeof createChatConfigApplyRouter>,
    payload: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
    const server = http.createServer((req, res) => {
        if (!router.handle(req, res)) {
            res.writeHead(404).end();
        }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;
    try {
        const res = await fetch(`http://127.0.0.1:${port}${CHAT_CONFIG_APPLY_ROUTE}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    } finally {
        server.close();
    }
}

test('flow target: dry-run first, then write, then hot-reload + thread note', async () => {
    const mgr = makeFakeManager(() => ({ status: 200, body: { ok: true } }));
    let reloaded = 0;
    const notes: string[] = [];
    const router = createChatConfigApplyRouter({
        managerApiUrl: 'http://mgr',
        managerApiToken: 'tok',
        fetchImpl: mgr.fetchImpl,
        reloadFlows: () => {
            reloaded += 1;
            return { flowIds: ['implement', 'refactor'] };
        },
        appendSystemNote: (_s, body) => {
            notes.push(body);
        },
    });

    const out = await post(router, {
        sessionId: 'chat-1',
        target: 'flow:implement',
        body: 'on: TaskApproved\nsteps: []',
    });

    assert.equal(out.status, 200);
    assert.equal(out.body.applied, true);
    assert.deepEqual(
        mgr.calls.map((c) => c.url),
        ['http://mgr/flows/implement?dry_run=1', 'http://mgr/flows/implement'],
        'dry-run precedes the real write',
    );
    assert.equal(reloaded, 1);
    assert.match(notes[0] ?? '', /applied: flow:implement/);
    assert.match(notes[0] ?? '', /hot-reloaded \(2 loaded\)/);
});

test('flow target: dry-run failure blocks the write and reports the loader error', async () => {
    const mgr = makeFakeManager((url) =>
        url.includes('dry_run')
            ? { status: 422, body: { error: 'unreachable step "docs"' } }
            : { status: 200, body: { ok: true } });
    const notes: string[] = [];
    const router = createChatConfigApplyRouter({
        managerApiUrl: 'http://mgr',
        fetchImpl: mgr.fetchImpl,
        appendSystemNote: (_s, body) => {
            notes.push(body);
        },
    });

    const out = await post(router, {
        sessionId: 'chat-1',
        target: 'flow:implement',
        body: 'bad yaml',
    });

    assert.equal(out.status, 422);
    assert.match(String(out.body.error), /unreachable step/);
    assert.equal(mgr.calls.length, 1, 'no write after failed validation');
    assert.match(notes[0] ?? '', /FAILED/);
});

test('secret setting: needsSecretValue round-trip; agent-supplied value refused', async () => {
    const mgr = makeFakeManager((url) => {
        if (url.endsWith('/settings')) {
            return {
                status: 200,
                body: { settings: [{ key: 'LINEAR_API_KEY', secret: true }] },
            };
        }
        return { status: 200, body: { ok: true } };
    });
    const router = createChatConfigApplyRouter({
        managerApiUrl: 'http://mgr',
        fetchImpl: mgr.fetchImpl,
    });

    // No value yet → prompt the operator.
    const ask = await post(router, { target: 'setting:LINEAR_API_KEY' });
    assert.equal(ask.status, 200);
    assert.equal(ask.body.needsSecretValue, true);

    // Agent-supplied body for a secret → refused.
    const smuggled = await post(router, {
        target: 'setting:LINEAR_API_KEY',
        body: 'lin_api_123',
    });
    assert.equal(smuggled.status, 422);
    assert.match(String(smuggled.body.error), /secret/);

    // Operator-typed value → applied.
    const applied = await post(router, {
        target: 'setting:LINEAR_API_KEY',
        operatorValue: 'lin_api_123',
    });
    assert.equal(applied.status, 200);
    assert.equal(applied.body.applied, true);
    const put = mgr.calls.find((c) => c.method === 'PUT');
    assert.ok(put?.url.endsWith('/settings/LINEAR_API_KEY'));
});

test('agent target: updates the newest record for the role, preserving other fields', async () => {
    const mgr = makeFakeManager((url, method) => {
        if (url.endsWith('/agents') && method === 'GET') {
            return {
                status: 200,
                body: {
                    agents: [
                        { agentId: 'old', role: 'reviewer', name: 'R1', model: 'a', prompt: 'P', updatedAt: 1 },
                        { agentId: 'new', role: 'reviewer', name: 'R2', model: 'b', prompt: 'P2', updatedAt: 9 },
                    ],
                },
            };
        }
        return { status: 200, body: { ok: true } };
    });
    const router = createChatConfigApplyRouter({
        managerApiUrl: 'http://mgr',
        fetchImpl: mgr.fetchImpl,
    });

    const out = await post(router, {
        target: 'agent:reviewer',
        model: 'claude-opus-4-8',
    });

    assert.equal(out.status, 200);
    const put = mgr.calls.find((c) => c.method === 'PUT');
    assert.ok(put?.url.endsWith('/agents/new'), 'newest record wins');
    const payload = JSON.parse(put?.body ?? '{}') as Record<string, unknown>;
    assert.equal(payload.model, 'claude-opus-4-8');
    assert.equal(payload.prompt, 'P2', 'existing prompt preserved');
    assert.equal(payload.name, 'R2');
});

test('unknown target and unreachable manager map to clear errors', async () => {
    const router = createChatConfigApplyRouter({
        managerApiUrl: 'http://mgr',
        fetchImpl: async () => {
            throw new Error('ECONNREFUSED');
        },
    });
    const unknown = await post(router, { target: 'database:main' });
    assert.equal(unknown.status, 422);

    const unreachable = await post(router, {
        target: 'flow:implement',
        body: 'x: y',
    });
    assert.equal(unreachable.status, 502);
    assert.match(String(unreachable.body.error), /unreachable|ECONNREFUSED/);
});

// --- project-context target -------------------------------------------
//
// The one target whose write REPLACES operator-authored prose rather than
// a file the operator can diff in git. Every case below is about not
// destroying it by accident.

test('project-context target: PUTs the full markdown to the manager-api', async () => {
    const mgr = makeFakeManager(() => ({ status: 200, body: { ok: true, bytes: 42 } }));
    const notes: string[] = [];
    const router = createChatConfigApplyRouter({
        managerApiUrl: 'http://mgr',
        fetchImpl: mgr.fetchImpl,
        appendSystemNote: (_s, body) => {
            notes.push(body);
        },
    });

    const out = await post(router, {
        sessionId: 'chat-1',
        target: 'project-context:example.platform',
        body: '# Example Platform\n\nFour repos.',
    });

    assert.equal(out.status, 200);
    assert.equal(out.body.applied, true);
    assert.equal(mgr.calls.length, 1);
    assert.equal(mgr.calls[0].method, 'PUT');
    // Project ids carry dots; the path must survive encodeURIComponent.
    assert.equal(
        mgr.calls[0].url,
        'http://mgr/projects/example.platform/context-md',
    );
    assert.deepEqual(JSON.parse(mgr.calls[0].body ?? '{}'), {
        content: '# Example Platform\n\nFour repos.',
    });
    assert.match(notes[0] ?? '', /Project context updated: example\.platform/);
});

test('project-context target: an empty body is refused, not treated as a clear', async () => {
    // The manager-api route reads empty content as "clear the context",
    // which is right for the UI and wrong from an agent — a dropped
    // section would silently wipe the operator's architecture notes.
    const mgr = makeFakeManager(() => ({ status: 200, body: { ok: true } }));
    const router = createChatConfigApplyRouter({
        managerApiUrl: 'http://mgr',
        fetchImpl: mgr.fetchImpl,
    });

    for (const body of ['', '   \n  ', undefined]) {
        const out = await post(router, {
            sessionId: 'chat-1',
            target: 'project-context:example.platform',
            ...(body !== undefined ? { body } : {}),
        });
        assert.equal(out.status, 422);
        assert.match(String(out.body.error), /COMPLETE new markdown/);
    }
    assert.equal(mgr.calls.length, 0, 'nothing may reach the manager-api');
});

test('project-context target: the truncation 422 reaches the thread verbatim', async () => {
    // The guard's message says WHICH way the content stops mid-thought.
    // Flattening it to 502 "apply failed" leaves the agent no way to fix
    // its own output on the next turn.
    const mgr = makeFakeManager(() => ({
        status: 422,
        body: { error: 'content ends on an unclosed code fence', code: 'unclosed-fence' },
    }));
    const router = createChatConfigApplyRouter({
        managerApiUrl: 'http://mgr',
        fetchImpl: mgr.fetchImpl,
    });

    const out = await post(router, {
        sessionId: 'chat-1',
        target: 'project-context:example.platform',
        body: '# Example Platform\n\n```yaml\nnever closed',
    });

    assert.equal(out.status, 422);
    assert.match(String(out.body.error), /unclosed code fence/);
});

test('project-context target: an unknown project keeps its 404', async () => {
    const mgr = makeFakeManager(() => ({
        status: 404,
        body: { error: 'project not found', projectId: 'nope' },
    }));
    const router = createChatConfigApplyRouter({
        managerApiUrl: 'http://mgr',
        fetchImpl: mgr.fetchImpl,
    });

    const out = await post(router, {
        sessionId: 'chat-1',
        target: 'project-context:nope',
        body: '# Something long enough to be a real context body.',
    });

    assert.equal(out.status, 404);
    assert.match(String(out.body.error), /project not found/);
});
