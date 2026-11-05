/**
 * Board → manager-api hop for project architecture context.
 *
 * The manager-api owns the write (validation, integrity guard, atomic
 * write, lock). This route only carries the request, so what matters is
 * that it carries the ANSWER back intact: a 422 from the truncation
 * guard and a 409 from a concurrent save are what the editor acts on,
 * and flattening either would strip the reason.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as http from 'node:http';

import {
    PROJECT_CONTEXT_ROUTE_PATTERN,
    createProjectContextRouter,
} from './project-context';

interface Recorded {
    url: string;
    method: string | undefined;
    headers: Record<string, string> | undefined;
    body: string | undefined;
}

function makeFetch(
    recorded: Recorded[],
    response: { status: number; body: unknown },
): never extends never ? Parameters<typeof createProjectContextRouter>[0]['fetchImpl'] : never {
    return async (url, init) => {
        recorded.push({
            url,
            method: init?.method,
            headers: init?.headers,
            body: init?.body,
        });
        return {
            ok: response.status < 400,
            status: response.status,
            json: async (): Promise<unknown> => response.body,
        };
    };
}

/** Minimal req/res doubles — the router only reads url/method and writes JSON. */
function makeReq(url: string, method: string, body?: string): http.IncomingMessage {
    const listeners: Record<string, Array<(arg?: unknown) => void>> = {};
    const req = {
        url,
        method,
        on(event: string, cb: (arg?: unknown) => void): http.IncomingMessage {
            (listeners[event] ??= []).push(cb);
            if (event === 'end' && body !== undefined) {
                // Deliver the body on the next tick so both handlers are
                // registered before either fires.
                setImmediate(() => {
                    for (const d of listeners.data ?? []) d(Buffer.from(body, 'utf8'));
                    for (const e of listeners.end ?? []) e();
                });
            } else if (event === 'end' && body === undefined) {
                setImmediate(() => {
                    for (const e of listeners.end ?? []) e();
                });
            }
            return req as unknown as http.IncomingMessage;
        },
        destroy(): void {},
    };
    return req as unknown as http.IncomingMessage;
}

interface CapturedRes {
    readonly res: http.ServerResponse;
    readonly done: Promise<{ status: number; body: unknown }>;
}

function makeRes(): CapturedRes {
    let resolve!: (v: { status: number; body: unknown }) => void;
    const done = new Promise<{ status: number; body: unknown }>((r) => { resolve = r; });
    let status = 0;
    const res = {
        writeHead(code: number): http.ServerResponse {
            status = code;
            return res as unknown as http.ServerResponse;
        },
        end(payload?: string): void {
            resolve({ status, body: payload ? JSON.parse(payload) : null });
        },
    };
    return { res: res as unknown as http.ServerResponse, done };
}

test('the route pattern matches only the context-md path', () => {
    assert.ok(PROJECT_CONTEXT_ROUTE_PATTERN.test('/api/projects/shop/context-md'));
    assert.ok(PROJECT_CONTEXT_ROUTE_PATTERN.test('/api/projects/shop/context-md/'));
    assert.equal(PROJECT_CONTEXT_ROUTE_PATTERN.test('/api/projects/shop'), false);
    assert.equal(PROJECT_CONTEXT_ROUTE_PATTERN.test('/api/projects'), false);
});

test('GET forwards to the manager-api with the bearer token and returns its body', async () => {
    const recorded: Recorded[] = [];
    const router = createProjectContextRouter({
        managerApiUrl: 'http://127.0.0.1:4102/',
        managerApiToken: 'shared-token',
        fetchImpl: makeFetch(recorded, {
            status: 200,
            body: { projectId: 'shop', exists: true, content: '# Ctx', etag: 'e1' },
        }),
    });

    const { res, done } = makeRes();
    const handled = router.handle(makeReq('/api/projects/shop/context-md', 'GET'), res);
    assert.equal(handled, true);
    const out = await done;

    assert.equal(recorded[0]!.url, 'http://127.0.0.1:4102/projects/shop/context-md');
    assert.equal(recorded[0]!.method, 'GET');
    assert.equal(recorded[0]!.headers?.Authorization, 'Bearer shared-token');
    assert.equal(out.status, 200);
    assert.equal((out.body as { content: string }).content, '# Ctx');
});

test('PUT forwards the body and passes a 422 guard rejection through verbatim', async () => {
    // The reason is the payload here — "nothing was saved, and here is
    // why" is what the editor shows the operator.
    const recorded: Recorded[] = [];
    const router = createProjectContextRouter({
        managerApiUrl: 'http://127.0.0.1:4102',
        fetchImpl: makeFetch(recorded, {
            status: 422,
            body: { error: 'The content ends on "…:" …', code: 'dangling-lead-in' },
        }),
    });

    const { res, done } = makeRes();
    router.handle(
        makeReq('/api/projects/shop/context-md', 'PUT', '{"content":"# X\\n\\n**Y:**"}'),
        res,
    );
    const out = await done;

    assert.equal(recorded[0]!.method, 'PUT');
    assert.equal(recorded[0]!.headers?.['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(recorded[0]!.body ?? ''), { content: '# X\n\n**Y:**' });
    assert.equal(out.status, 422, 'the guard verdict must not be flattened');
    assert.equal((out.body as { code: string }).code, 'dangling-lead-in');
});

test('a 409 from a concurrent save also passes through', async () => {
    const router = createProjectContextRouter({
        managerApiUrl: 'http://127.0.0.1:4102',
        fetchImpl: makeFetch([], {
            status: 409,
            body: { error: 'the project context changed since you opened it' },
        }),
    });
    const { res, done } = makeRes();
    router.handle(makeReq('/api/projects/p/context-md', 'PUT', '{"content":"x"}'), res);
    assert.equal((await done).status, 409);
});

test('an unreachable manager-api is a 502 that names the hop', async () => {
    const router = createProjectContextRouter({
        managerApiUrl: 'http://127.0.0.1:4102',
        fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
    });
    const { res, done } = makeRes();
    router.handle(makeReq('/api/projects/p/context-md', 'GET'), res);
    const out = await done;
    assert.equal(out.status, 502);
    assert.match((out.body as { error: string }).error, /manager-api unreachable/);
});

test('other methods are refused with Allow', async () => {
    const router = createProjectContextRouter({
        managerApiUrl: 'http://127.0.0.1:4102',
        fetchImpl: makeFetch([], { status: 200, body: {} }),
    });
    const { res, done } = makeRes();
    router.handle(makeReq('/api/projects/p/context-md', 'DELETE'), res);
    assert.equal((await done).status, 405);
});

test('a non-matching path is not handled', () => {
    const router = createProjectContextRouter({
        managerApiUrl: 'http://127.0.0.1:4102',
        fetchImpl: makeFetch([], { status: 200, body: {} }),
    });
    const { res } = makeRes();
    assert.equal(router.handle(makeReq('/api/tasks', 'GET'), res), false);
});
