import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as http from 'node:http';

import { start, type ManagerBoardServerHandle } from './server';

interface UpstreamCall {
    method: string;
    url: string;
    headers: http.IncomingHttpHeaders;
    body: string;
}

interface UpstreamReply {
    status?: number;
    headers?: http.OutgoingHttpHeaders;
    body?: string;
}

interface Upstream {
    readonly origin: string;
    readonly calls: UpstreamCall[];
    reply: UpstreamReply;
    stop(): Promise<void>;
}

async function startUpstream(): Promise<Upstream> {
    const calls: UpstreamCall[] = [];
    const state: { reply: UpstreamReply } = {
        reply: { status: 200, headers: { 'Content-Type': 'application/json' }, body: '{}' }
    };

    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
            calls.push({
                method: req.method ?? '',
                url: req.url ?? '',
                headers: req.headers,
                body: Buffer.concat(chunks).toString('utf8')
            });
            const r = state.reply;
            res.writeHead(r.status ?? 200, r.headers ?? {});
            res.end(r.body ?? '');
        });
    });

    const port = await new Promise<number>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address();
            if (!addr || typeof addr === 'string') {
                reject(new Error('upstream: listen returned no address'));
                return;
            }
            resolve(addr.port);
        });
    });

    let stopped = false;
    return {
        origin: `http://127.0.0.1:${port}`,
        calls,
        get reply() {
            return state.reply;
        },
        set reply(v: UpstreamReply) {
            state.reply = v;
        },
        stop(): Promise<void> {
            if (stopped) return Promise.resolve();
            stopped = true;
            return new Promise((resolve) => {
                server.close(() => resolve());
            });
        }
    };
}

interface Harness {
    readonly baseUrl: string;
    readonly upstream: Upstream;
    readonly handle: ManagerBoardServerHandle;
    stop(): Promise<void>;
}

async function makeHarness(opts: { token?: string } = {}): Promise<Harness> {
    const upstream = await startUpstream();
    let handle: ManagerBoardServerHandle;
    try {
        handle = await start({
            port: 0,
            host: '127.0.0.1',
            managerApiUrl: upstream.origin,
            managerApiToken: opts.token
        });
    } catch (err) {
        await upstream.stop();
        throw err;
    }
    return {
        baseUrl: `http://127.0.0.1:${handle.port}`,
        upstream,
        handle,
        async stop(): Promise<void> {
            await handle.stop();
            await upstream.stop();
        }
    };
}

test('GET / serves index.html', async () => {
    const h = await makeHarness();
    try {
        const res = await fetch(`${h.baseUrl}/`);
        assert.equal(res.status, 200);
        assert.match(res.headers.get('content-type') ?? '', /text\/html/);
        const body = await res.text();
        assert.match(body, /Pipeline Manager/);
        assert.match(body, /id="editor"/);
    } finally {
        await h.stop();
    }
});

test('GET /manager.js serves the script', async () => {
    const h = await makeHarness();
    try {
        const res = await fetch(`${h.baseUrl}/manager.js`);
        assert.equal(res.status, 200);
        assert.match(res.headers.get('content-type') ?? '', /application\/javascript/);
    } finally {
        await h.stop();
    }
});

test('GET /manager.css serves the stylesheet', async () => {
    const h = await makeHarness();
    try {
        const res = await fetch(`${h.baseUrl}/manager.css`);
        assert.equal(res.status, 200);
        assert.match(res.headers.get('content-type') ?? '', /text\/css/);
    } finally {
        await h.stop();
    }
});

test('Bearer token never appears in client-side assets', async () => {
    const TOKEN = 'super-secret-token-9f3b';
    const h = await makeHarness({ token: TOKEN });
    try {
        for (const asset of ['/', '/manager.js', '/manager.css']) {
            const res = await fetch(`${h.baseUrl}${asset}`);
            const body = await res.text();
            assert.equal(
                body.includes(TOKEN),
                false,
                `token leaked into ${asset}: ${body.slice(0, 200)}`
            );
        }
    } finally {
        await h.stop();
    }
});

test('GET /unknown returns 404', async () => {
    const h = await makeHarness();
    try {
        const res = await fetch(`${h.baseUrl}/nope.html`);
        assert.equal(res.status, 404);
    } finally {
        await h.stop();
    }
});

test('Static handler refuses path traversal attempts', async () => {
    const h = await makeHarness();
    try {
        const res = await fetch(`${h.baseUrl}/../package.json`);
        // Node normalises the URL before sending; either way, the
        // server must not return package.json.
        assert.notEqual(res.status, 200);
        const body = await res.text();
        assert.equal(body.includes('"name": "dropagents"'), false);
    } finally {
        await h.stop();
    }
});

test('GET /api/pipeline strips the /api prefix and proxies upstream', async () => {
    const h = await makeHarness();
    h.upstream.reply = {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: '{"issue_tracker":"linear"}'
    };
    try {
        const res = await fetch(`${h.baseUrl}/api/pipeline`);
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.deepEqual(body, { issue_tracker: 'linear' });
        assert.equal(h.upstream.calls.length, 1);
        assert.equal(h.upstream.calls[0].method, 'GET');
        assert.equal(h.upstream.calls[0].url, '/pipeline');
    } finally {
        await h.stop();
    }
});

test('Proxy injects Authorization: Bearer <token> on upstream requests', async () => {
    const TOKEN = 'token-abc-123';
    const h = await makeHarness({ token: TOKEN });
    try {
        const res = await fetch(`${h.baseUrl}/api/flows`);
        assert.equal(res.status, 200);
        assert.equal(h.upstream.calls.length, 1);
        assert.equal(h.upstream.calls[0].headers.authorization, `Bearer ${TOKEN}`);
    } finally {
        await h.stop();
    }
});

test('Proxy strips client-supplied Authorization when no token is configured', async () => {
    const h = await makeHarness({ token: undefined });
    try {
        await fetch(`${h.baseUrl}/api/flows`, {
            headers: { Authorization: 'Bearer client-injected' }
        });
        assert.equal(h.upstream.calls.length, 1);
        assert.equal(h.upstream.calls[0].headers.authorization, undefined);
    } finally {
        await h.stop();
    }
});

test('Proxy overrides client-supplied Authorization with the configured token', async () => {
    const TOKEN = 'real-token';
    const h = await makeHarness({ token: TOKEN });
    try {
        await fetch(`${h.baseUrl}/api/flows`, {
            headers: { Authorization: 'Bearer client-attempt' }
        });
        assert.equal(h.upstream.calls.length, 1);
        assert.equal(h.upstream.calls[0].headers.authorization, `Bearer ${TOKEN}`);
    } finally {
        await h.stop();
    }
});

test('PUT /api/pipeline forwards body and returns the upstream status code', async () => {
    const h = await makeHarness({ token: 't' });
    h.upstream.reply = {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: '{"ok":true}'
    };
    try {
        const yamlBody = 'issue_tracker: linear\n';
        const res = await fetch(`${h.baseUrl}/api/pipeline`, {
            method: 'PUT',
            headers: { 'Content-Type': 'text/yaml' },
            body: yamlBody
        });
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { ok: true });
        assert.equal(h.upstream.calls.length, 1);
        assert.equal(h.upstream.calls[0].method, 'PUT');
        assert.equal(h.upstream.calls[0].url, '/pipeline');
        assert.equal(h.upstream.calls[0].body, yamlBody);
        assert.equal(h.upstream.calls[0].headers['content-type'], 'text/yaml');
    } finally {
        await h.stop();
    }
});

test('PUT /api/flows/:name passes 422 validation errors through to the client', async () => {
    const h = await makeHarness({ token: 't' });
    h.upstream.reply = {
        status: 422,
        headers: { 'Content-Type': 'application/json' },
        body: '{"error":"flow echo: missing required field steps"}'
    };
    try {
        const res = await fetch(`${h.baseUrl}/api/flows/echo`, {
            method: 'PUT',
            headers: { 'Content-Type': 'text/yaml' },
            body: 'on: TaskApproved\n'
        });
        assert.equal(res.status, 422);
        assert.deepEqual(await res.json(), {
            error: 'flow echo: missing required field steps'
        });
        assert.equal(h.upstream.calls[0].url, '/flows/echo');
    } finally {
        await h.stop();
    }
});

test('Proxy preserves the query string', async () => {
    const h = await makeHarness();
    try {
        await fetch(`${h.baseUrl}/api/flows?filter=echo`);
        assert.equal(h.upstream.calls[0].url, '/flows?filter=echo');
    } finally {
        await h.stop();
    }
});

test('Proxy returns 502 when the upstream is unreachable', async () => {
    // Stand up a harness, then take down the upstream so the proxy
    // request hits a closed port.
    const h = await makeHarness();
    await h.upstream.stop();
    try {
        const res = await fetch(`${h.baseUrl}/api/pipeline`);
        assert.equal(res.status, 502);
    } finally {
        await h.stop();
    }
});
