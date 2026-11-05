/**
 * Unit tests for {@link HttpHealthProbe}.
 *
 * Each test that needs a server spins up an in-process `node:http`
 * listener on an ephemeral port, runs the probe against the resulting
 * `http://127.0.0.1:<port>` URL, and tears the server down in `finally`
 * so a mid-flight failure never leaks a listener between runs. The
 * network-failure test deliberately points at an unbound port to
 * exercise the throw-free transport-error path.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

import { HttpHealthProbe } from './HttpHealthProbe';

type Handler = (
    req: http.IncomingMessage,
    res: http.ServerResponse,
) => void;

async function withServer(
    handler: Handler,
    fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
    const server = http.createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
        const { port } = server.address() as AddressInfo;
        await fn(`http://127.0.0.1:${port}`);
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
}

function jsonResponder(status: number, payload: unknown): Handler {
    return (_req, res) => {
        res.statusCode = status;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(payload));
    };
}

// ---------------------------------------------------------------------------
// AC #5: status match
// ---------------------------------------------------------------------------

test('status predicate: matches when response code equals', async () => {
    await withServer(
        (_req, res) => {
            res.statusCode = 200;
            res.end('ok');
        },
        async (baseUrl) => {
            const probe = new HttpHealthProbe();
            const result = await probe.probe(baseUrl, {
                kind: 'status',
                equals: 200,
            });
            assert.equal(result.ok, true);
            assert.equal(result.status, 200);
            // Body should not be read for a status predicate.
            assert.equal(result.body, undefined);
        },
    );
});

// ---------------------------------------------------------------------------
// AC #5: status mismatch
// ---------------------------------------------------------------------------

test('status predicate: does not match when response code differs', async () => {
    await withServer(
        (_req, res) => {
            res.statusCode = 503;
            res.end('busy');
        },
        async (baseUrl) => {
            const probe = new HttpHealthProbe();
            const result = await probe.probe(baseUrl, {
                kind: 'status',
                equals: 200,
            });
            assert.equal(result.ok, false);
            assert.equal(result.status, 503);
            assert.equal(result.body, undefined);
        },
    );
});

// ---------------------------------------------------------------------------
// AC #5: json-path match
// ---------------------------------------------------------------------------

test('json-path predicate: matches a top-level field', async () => {
    await withServer(
        jsonResponder(200, { status: 'ok', version: 'v3' }),
        async (baseUrl) => {
            const probe = new HttpHealthProbe();
            const result = await probe.probe(baseUrl, {
                kind: 'json-path',
                path: 'status',
                equals: 'ok',
            });
            assert.equal(result.ok, true);
            assert.equal(result.status, 200);
            assert.deepEqual(result.body, { status: 'ok', version: 'v3' });
        },
    );
});

test('json-path predicate: matches a nested field', async () => {
    await withServer(
        jsonResponder(200, { data: { ready: true } }),
        async (baseUrl) => {
            const probe = new HttpHealthProbe();
            const result = await probe.probe(baseUrl, {
                kind: 'json-path',
                path: 'data.ready',
                equals: true,
            });
            assert.equal(result.ok, true);
            assert.equal(result.status, 200);
        },
    );
});

test('json-path predicate: tolerates leading $ or $. prefix', async () => {
    await withServer(
        jsonResponder(200, { ready: true }),
        async (baseUrl) => {
            const probe = new HttpHealthProbe();
            const withDollar = await probe.probe(baseUrl, {
                kind: 'json-path',
                path: '$.ready',
                equals: true,
            });
            assert.equal(withDollar.ok, true);

            const bareDollar = await probe.probe(baseUrl, {
                kind: 'json-path',
                path: '$',
                equals: { ready: true },
            });
            assert.equal(bareDollar.ok, true);
        },
    );
});

test('json-path predicate: structural equality on object values', async () => {
    await withServer(
        jsonResponder(200, { meta: { tags: ['a', 'b'], n: 2 } }),
        async (baseUrl) => {
            const probe = new HttpHealthProbe();
            const result = await probe.probe(baseUrl, {
                kind: 'json-path',
                path: 'meta',
                equals: { tags: ['a', 'b'], n: 2 },
            });
            assert.equal(result.ok, true);
        },
    );
});

// ---------------------------------------------------------------------------
// AC #5: json-path miss (key missing)
// ---------------------------------------------------------------------------

test('json-path predicate: returns ok=false when key is missing', async () => {
    await withServer(
        jsonResponder(200, { other: 'value' }),
        async (baseUrl) => {
            const probe = new HttpHealthProbe();
            const result = await probe.probe(baseUrl, {
                kind: 'json-path',
                path: 'data.ready',
                equals: true,
            });
            assert.equal(result.ok, false);
            assert.equal(result.status, 200);
            // Body is still surfaced so callers can diagnose.
            assert.deepEqual(result.body, { other: 'value' });
        },
    );
});

test('json-path predicate: returns ok=false when value differs', async () => {
    await withServer(
        jsonResponder(200, { status: 'degraded' }),
        async (baseUrl) => {
            const probe = new HttpHealthProbe();
            const result = await probe.probe(baseUrl, {
                kind: 'json-path',
                path: 'status',
                equals: 'ok',
            });
            assert.equal(result.ok, false);
            assert.equal(result.status, 200);
            assert.deepEqual(result.body, { status: 'degraded' });
        },
    );
});

test('json-path predicate: returns ok=false when body is not JSON', async () => {
    await withServer(
        (_req, res) => {
            res.statusCode = 200;
            res.setHeader('content-type', 'text/html');
            res.end('<html>not json</html>');
        },
        async (baseUrl) => {
            const probe = new HttpHealthProbe();
            const result = await probe.probe(baseUrl, {
                kind: 'json-path',
                path: 'status',
                equals: 'ok',
            });
            assert.equal(result.ok, false);
            assert.equal(result.status, 200);
        },
    );
});

test('json-path predicate: walking into a non-object returns ok=false', async () => {
    await withServer(
        jsonResponder(200, { data: 'string-not-object' }),
        async (baseUrl) => {
            const probe = new HttpHealthProbe();
            const result = await probe.probe(baseUrl, {
                kind: 'json-path',
                path: 'data.ready',
                equals: true,
            });
            assert.equal(result.ok, false);
        },
    );
});

// ---------------------------------------------------------------------------
// AC #4 / AC #5: network failure resolves rather than throwing
// ---------------------------------------------------------------------------

test('network failure: returns ok=false, status=0 without throwing', async () => {
    // Bind to an ephemeral port, immediately close it, then try to probe
    // it. The OS will reject the connection — exactly the transport
    // failure mode the engine relies on the adapter to swallow.
    const server = http.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    await new Promise<void>((resolve) => server.close(() => resolve()));

    const probe = new HttpHealthProbe();
    const result = await probe.probe(`http://127.0.0.1:${port}`, {
        kind: 'status',
        equals: 200,
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 0);
    assert.equal(result.body, undefined);
});

test('network failure: surfaces the same shape for json-path predicates', async () => {
    const server = http.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    await new Promise<void>((resolve) => server.close(() => resolve()));

    const probe = new HttpHealthProbe();
    const result = await probe.probe(`http://127.0.0.1:${port}`, {
        kind: 'json-path',
        path: 'status',
        equals: 'ok',
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 0);
});

// ---------------------------------------------------------------------------
// Injectable fetch: lets hosts plug a mock without spinning a listener.
// ---------------------------------------------------------------------------

test('honours the injectable fetch option', async () => {
    let seenUrl = '';
    const fakeFetch = async (url: string): Promise<Response> => {
        seenUrl = url;
        return new Response(JSON.stringify({ ready: true }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        });
    };
    const probe = new HttpHealthProbe({ fetch: fakeFetch });
    const result = await probe.probe('http://example.invalid/health', {
        kind: 'json-path',
        path: 'ready',
        equals: true,
    });
    assert.equal(seenUrl, 'http://example.invalid/health');
    assert.equal(result.ok, true);
    assert.equal(result.status, 200);
});

test('a thrown fetch is treated as a transport failure', async () => {
    const fakeFetch = async (): Promise<Response> => {
        throw new TypeError('network unreachable');
    };
    const probe = new HttpHealthProbe({ fetch: fakeFetch });
    const result = await probe.probe('http://example.invalid/health', {
        kind: 'status',
        equals: 200,
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 0);
});
