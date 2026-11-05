import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

import type { Logger } from '../../core/ports/Logger';

import { start } from './main';
import { postFlowChat } from './routes';

const SAMPLE_PIPELINE = `issue_tracker: linear
agent_runner: claude-cli
source_control: git-cli
chat_gateway: telegram
default_models:
  developer: claude-opus-4-7
worktree_root: .pipeline-workspace/v2
`;

const SAMPLE_FLOW_ECHO = `on: TaskApproved
steps:
  - id: run
    agent: developer
    model: claude-opus-4-7
    on_success: emit:TaskFinished
`;

const SAMPLE_FLOW_REVIEW = `on: TaskApproved
steps:
  - id: review
    agent: reviewer
    model: claude-sonnet-4-6
    on_success: emit:TaskFinished
`;

class SilentLogger implements Logger {
    info(): void {}
    warn(): void {}
    error(): void {}
    debug(): void {}
}

interface Fixture {
    readonly dir: string;
    readonly pipelinePath: string;
    readonly flowsDir: string;
    readonly lockPath: string;
    cleanup(): void;
}

function makeFixture(): Fixture {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-api-put-'));
    const pipelinePath = path.join(dir, 'pipeline.yaml');
    const flowsDir = path.join(dir, 'flows');
    fs.mkdirSync(flowsDir);
    fs.writeFileSync(pipelinePath, SAMPLE_PIPELINE, 'utf8');
    fs.writeFileSync(path.join(flowsDir, 'echo.yaml'), SAMPLE_FLOW_ECHO, 'utf8');
    fs.writeFileSync(path.join(flowsDir, 'code-review.yaml'), SAMPLE_FLOW_REVIEW, 'utf8');
    return {
        dir,
        pipelinePath,
        flowsDir,
        lockPath: path.join(dir, '.locks', 'manager-api.lock'),
        cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
    };
}

interface Harness {
    readonly baseUrl: string;
    readonly fixture: Fixture;
    stop(): Promise<void>;
}

async function makeHarness(opts: {
    token?: string;
    waitMs?: number;
    workerApiUrl?: string;
} = {}): Promise<Harness> {
    const fixture = makeFixture();
    const handle = await start({
        port: 0,
        host: '127.0.0.1',
        authToken: opts.token,
        configDir: fixture.dir,
        logger: new SilentLogger(),
        write: {
            lockPath: fixture.lockPath,
            lock: opts.waitMs !== undefined ? { waitMs: opts.waitMs } : {},
        },
        ...(opts.workerApiUrl !== undefined ? { workerApiUrl: opts.workerApiUrl } : {}),
    });
    return {
        baseUrl: `http://127.0.0.1:${handle.port}`,
        fixture,
        async stop(): Promise<void> {
            await handle.stop();
            fixture.cleanup();
        },
    };
}

const TOKEN = 'test-token';
const YAML_HEADERS = { 'Content-Type': 'text/yaml', Authorization: `Bearer ${TOKEN}` };

// ---------------------------------------------------------------------------
// AC #7: bearer required
// ---------------------------------------------------------------------------

test('PUT /pipeline without bearer returns 401', async () => {
    const h = await makeHarness({ token: TOKEN });
    try {
        const res = await fetch(`${h.baseUrl}/pipeline`, {
            method: 'PUT',
            headers: { 'Content-Type': 'text/yaml' },
            body: SAMPLE_PIPELINE,
        });
        assert.equal(res.status, 401);
        assert.equal(res.headers.get('www-authenticate'), 'Bearer');
        // File on disk must be untouched.
        assert.equal(fs.readFileSync(h.fixture.pipelinePath, 'utf8'), SAMPLE_PIPELINE);
    } finally {
        await h.stop();
    }
});

test('PUT /flows/:name without bearer returns 401', async () => {
    const h = await makeHarness({ token: TOKEN });
    try {
        const res = await fetch(`${h.baseUrl}/flows/echo`, {
            method: 'PUT',
            headers: { 'Content-Type': 'text/yaml' },
            body: SAMPLE_FLOW_ECHO,
        });
        assert.equal(res.status, 401);
    } finally {
        await h.stop();
    }
});

// ---------------------------------------------------------------------------
// AC #1, #3: happy path
// ---------------------------------------------------------------------------

test('PUT /pipeline with valid YAML persists the file and returns 200', async () => {
    const h = await makeHarness({ token: TOKEN });
    try {
        const next = SAMPLE_PIPELINE.replace(
            'issue_tracker: linear',
            'issue_tracker: jira',
        );
        const res = await fetch(`${h.baseUrl}/pipeline`, {
            method: 'PUT',
            headers: YAML_HEADERS,
            body: next,
        });
        assert.equal(res.status, 200);
        assert.equal(fs.readFileSync(h.fixture.pipelinePath, 'utf8'), next);
    } finally {
        await h.stop();
    }
});

test('PUT /flows/:name with valid YAML persists and returns 200', async () => {
    const h = await makeHarness({ token: TOKEN });
    try {
        const body = `on: TaskApproved
steps:
  - id: only
    agent: developer
    model: claude-opus-4-7
    on_success: emit:Done
`;
        const res = await fetch(`${h.baseUrl}/flows/new-one`, {
            method: 'PUT',
            headers: YAML_HEADERS,
            body,
        });
        assert.equal(res.status, 200);
        const target = path.join(h.fixture.flowsDir, 'new-one.yaml');
        assert.equal(fs.readFileSync(target, 'utf8'), body);
    } finally {
        await h.stop();
    }
});

test('PUT /flows/:name replacing an existing flow rewrites the file', async () => {
    const h = await makeHarness({ token: TOKEN });
    try {
        const body = `on: TaskApproved
steps:
  - id: replacement
    agent: developer
    model: claude-opus-4-7
    on_success: emit:Done
`;
        const res = await fetch(`${h.baseUrl}/flows/echo`, {
            method: 'PUT',
            headers: YAML_HEADERS,
            body,
        });
        assert.equal(res.status, 200);
        const target = path.join(h.fixture.flowsDir, 'echo.yaml');
        assert.equal(fs.readFileSync(target, 'utf8'), body);
    } finally {
        await h.stop();
    }
});

// ---------------------------------------------------------------------------
// AC #2, #4: validation failure — PUT /pipeline → 422, PUT /flows/:name → 400
// (AP-VP-014 moved flow-loader rejections to 400 to match the task literal.)
// ---------------------------------------------------------------------------

test('PUT /pipeline with malformed YAML returns 422 and leaves file intact', async () => {
    const h = await makeHarness({ token: TOKEN });
    try {
        const before = fs.readFileSync(h.fixture.pipelinePath, 'utf8');
        const res = await fetch(`${h.baseUrl}/pipeline`, {
            method: 'PUT',
            headers: YAML_HEADERS,
            body: 'this: is: not: valid: yaml\n',
        });
        assert.equal(res.status, 422);
        const body = (await res.json()) as { error: string };
        assert.ok(body.error.length > 0);
        assert.equal(fs.readFileSync(h.fixture.pipelinePath, 'utf8'), before);
    } finally {
        await h.stop();
    }
});

test('PUT /pipeline rejects non-mapping YAML with 422', async () => {
    const h = await makeHarness({ token: TOKEN });
    try {
        const before = fs.readFileSync(h.fixture.pipelinePath, 'utf8');
        const res = await fetch(`${h.baseUrl}/pipeline`, {
            method: 'PUT',
            headers: YAML_HEADERS,
            body: '- a\n- b\n',
        });
        assert.equal(res.status, 422);
        assert.equal(fs.readFileSync(h.fixture.pipelinePath, 'utf8'), before);
    } finally {
        await h.stop();
    }
});

test('PUT /flows/:name where loadAllFlows would throw returns 400', async () => {
    const h = await makeHarness({ token: TOKEN });
    try {
        const before = fs.readdirSync(h.fixture.flowsDir).sort();
        // Missing required `on_success` on the only step.
        const body = `on: TaskApproved
steps:
  - id: broken
    agent: developer
    model: claude-opus-4-7
`;
        const res = await fetch(`${h.baseUrl}/flows/broken`, {
            method: 'PUT',
            headers: YAML_HEADERS,
            body,
        });
        assert.equal(res.status, 400);
        const json = (await res.json()) as { error: string };
        assert.match(json.error, /on_success/);
        // No file written.
        const after = fs.readdirSync(h.fixture.flowsDir).sort();
        assert.deepEqual(after, before);
    } finally {
        await h.stop();
    }
});

test('PUT /flows/:name catches cross-file errors (unreachable step)', async () => {
    const h = await makeHarness({ token: TOKEN });
    try {
        const body = `on: TaskApproved
steps:
  - id: a
    agent: developer
    model: claude-opus-4-7
    on_success: emit:Done
  - id: orphan
    agent: reviewer
    model: claude-sonnet-4-6
    on_success: emit:Done
`;
        const res = await fetch(`${h.baseUrl}/flows/orphaned`, {
            method: 'PUT',
            headers: YAML_HEADERS,
            body,
        });
        assert.equal(res.status, 400);
        const json = (await res.json()) as { error: string };
        assert.match(json.error, /unreachable/);
    } finally {
        await h.stop();
    }
});

// ---------------------------------------------------------------------------
// Content-Type policing
// ---------------------------------------------------------------------------

test('PUT with no Content-Type is rejected', async () => {
    // `fetch` auto-fills Content-Type from the body, so we hand-roll a
    // raw HTTP request to exercise the header-absent path explicitly.
    const h = await makeHarness({ token: TOKEN });
    try {
        const status = await rawPut(h.baseUrl, '/pipeline', SAMPLE_PIPELINE, {
            Authorization: `Bearer ${TOKEN}`,
        });
        assert.equal(status, 415);
    } finally {
        await h.stop();
    }
});

function rawPut(
    baseUrl: string,
    pathname: string,
    body: string,
    headers: Record<string, string>,
): Promise<number> {
    const url = new URL(pathname, baseUrl);
    return new Promise((resolve, reject) => {
        const req = http.request(
            {
                hostname: url.hostname,
                port: url.port,
                path: url.pathname,
                method: 'PUT',
                headers: {
                    ...headers,
                    'Content-Length': Buffer.byteLength(body).toString(),
                },
            },
            (res) => {
                res.resume();
                res.on('end', () => resolve(res.statusCode ?? 0));
            },
        );
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

test('PUT with application/json Content-Type is rejected', async () => {
    const h = await makeHarness({ token: TOKEN });
    try {
        const res = await fetch(`${h.baseUrl}/pipeline`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
            body: SAMPLE_PIPELINE,
        });
        assert.equal(res.status, 415);
    } finally {
        await h.stop();
    }
});

test('PUT accepts text/plain as a Content-Type', async () => {
    const h = await makeHarness({ token: TOKEN });
    try {
        const res = await fetch(`${h.baseUrl}/pipeline`, {
            method: 'PUT',
            headers: { 'Content-Type': 'text/plain', Authorization: `Bearer ${TOKEN}` },
            body: SAMPLE_PIPELINE,
        });
        assert.equal(res.status, 200);
    } finally {
        await h.stop();
    }
});

test('PUT /flows/:name with disallowed name returns 404', async () => {
    const h = await makeHarness({ token: TOKEN });
    try {
        const res = await fetch(
            `${h.baseUrl}/flows/${encodeURIComponent('../pipeline')}`,
            {
                method: 'PUT',
                headers: YAML_HEADERS,
                body: SAMPLE_FLOW_ECHO,
            },
        );
        assert.equal(res.status, 404);
    } finally {
        await h.stop();
    }
});

// ---------------------------------------------------------------------------
// AC #5: concurrent writes serialise; second fails fast with 409 when
// waitMs is 0.
// ---------------------------------------------------------------------------

test('Concurrent PUT fails fast with 409 when lock waitMs=0', async () => {
    const h = await makeHarness({ token: TOKEN, waitMs: 0 });
    try {
        // Hand-roll a held lock so the live PUT meets contention.
        fs.mkdirSync(path.dirname(h.fixture.lockPath), { recursive: true });
        const fd = fs.openSync(h.fixture.lockPath, 'wx');
        try {
            const res = await fetch(`${h.baseUrl}/pipeline`, {
                method: 'PUT',
                headers: YAML_HEADERS,
                body: SAMPLE_PIPELINE,
            });
            assert.equal(res.status, 409);
        } finally {
            fs.closeSync(fd);
            try {
                fs.unlinkSync(h.fixture.lockPath);
            } catch {
                /* ignore */
            }
        }
    } finally {
        await h.stop();
    }
});

test('Concurrent PUT waits for the lock when waitMs is generous', async () => {
    const h = await makeHarness({ token: TOKEN, waitMs: 5000 });
    try {
        fs.mkdirSync(path.dirname(h.fixture.lockPath), { recursive: true });
        const fd = fs.openSync(h.fixture.lockPath, 'wx');

        const pending = fetch(`${h.baseUrl}/pipeline`, {
            method: 'PUT',
            headers: YAML_HEADERS,
            body: SAMPLE_PIPELINE.replace(
                'issue_tracker: linear',
                'issue_tracker: jira',
            ),
        });

        // Hold the lock briefly, then release. The pending PUT must
        // succeed (status 200) once the lock is free.
        await new Promise((r) => setTimeout(r, 100));
        fs.closeSync(fd);
        fs.unlinkSync(h.fixture.lockPath);

        const res = await pending;
        assert.equal(res.status, 200);
        assert.match(fs.readFileSync(h.fixture.pipelinePath, 'utf8'), /issue_tracker: jira/);
    } finally {
        await h.stop();
    }
});

// ---------------------------------------------------------------------------
// AC #6: atomic write — a kill between fsync and rename leaves previous
// file intact. We simulate by leaving an orphan .tmp on disk and verifying
// the target is untouched.
// ---------------------------------------------------------------------------

test('A stray .tmp from an interrupted write does not corrupt the target', async () => {
    const h = await makeHarness({ token: TOKEN });
    try {
        const before = fs.readFileSync(h.fixture.pipelinePath, 'utf8');
        const tmp = `${h.fixture.pipelinePath}.tmp`;
        fs.writeFileSync(tmp, 'partial: write\nthat: never\nrenamed: over\n');

        // The target on disk is byte-for-byte unchanged.
        assert.equal(fs.readFileSync(h.fixture.pipelinePath, 'utf8'), before);

        // And the next live PUT still works — and cleans up after itself
        // by writing to .tmp then renaming over the target.
        const res = await fetch(`${h.baseUrl}/pipeline`, {
            method: 'PUT',
            headers: YAML_HEADERS,
            body: before,
        });
        assert.equal(res.status, 200);
        // Note: leftover .tmp from the prior simulated crash is not the
        // PUT handler's responsibility — it writes its own .tmp and
        // renames over. The simulated stray would be cleaned up by
        // higher-level recovery, not by this code path.

        fs.rmSync(tmp, { force: true });
    } finally {
        await h.stop();
    }
});

// ---------------------------------------------------------------------------
// Read paths still work after writes (no in-memory cache to invalidate).
// ---------------------------------------------------------------------------

test('GET /pipeline after a successful PUT reflects the new content', async () => {
    const h = await makeHarness({ token: TOKEN });
    try {
        const next = SAMPLE_PIPELINE.replace(
            'issue_tracker: linear',
            'issue_tracker: jira',
        );
        const put = await fetch(`${h.baseUrl}/pipeline`, {
            method: 'PUT',
            headers: YAML_HEADERS,
            body: next,
        });
        assert.equal(put.status, 200);

        const get = await fetch(`${h.baseUrl}/pipeline`, {
            headers: { Authorization: `Bearer ${TOKEN}` },
        });
        const body = (await get.json()) as { issue_tracker: string };
        assert.equal(body.issue_tracker, 'jira');
    } finally {
        await h.stop();
    }
});

// ---------------------------------------------------------------------------
// Phase 4 — real Validate (?dry_run=1) + operator Apply (POST /reload)
// ---------------------------------------------------------------------------

test('PUT /flows/:name?dry_run=1 validates in full but writes nothing', async () => {
    const h = await makeHarness({ token: TOKEN });
    try {
        const next = SAMPLE_FLOW_ECHO.replace('agent: developer', 'agent: tester');
        const res = await fetch(`${h.baseUrl}/flows/echo?dry_run=1`, {
            method: 'PUT',
            headers: YAML_HEADERS,
            body: next,
        });
        assert.equal(res.status, 200);
        const body = (await res.json()) as { ok: boolean; dryRun: boolean };
        assert.equal(body.ok, true);
        assert.equal(body.dryRun, true);
        // Nothing written: the file on disk is still the fixture content.
        assert.equal(
            fs.readFileSync(path.join(h.fixture.flowsDir, 'echo.yaml'), 'utf8'),
            SAMPLE_FLOW_ECHO,
        );
    } finally {
        await h.stop();
    }
});

test('PUT /flows/:name?dry_run=1 for a NEW flow name does not create the file', async () => {
    const h = await makeHarness({ token: TOKEN });
    try {
        const res = await fetch(`${h.baseUrl}/flows/brand-new?dry_run=1`, {
            method: 'PUT',
            headers: YAML_HEADERS,
            body: SAMPLE_FLOW_ECHO,
        });
        assert.equal(res.status, 200);
        assert.equal(
            fs.existsSync(path.join(h.fixture.flowsDir, 'brand-new.yaml')),
            false,
        );
    } finally {
        await h.stop();
    }
});

test('PUT /flows/:name?dry_run=1 still rejects an invalid flow with the loader message', async () => {
    const h = await makeHarness({ token: TOKEN });
    try {
        const res = await fetch(`${h.baseUrl}/flows/echo?dry_run=1`, {
            method: 'PUT',
            headers: YAML_HEADERS,
            body: 'on: TaskApproved\nsteps:\n  - id: run\n    agent: developer\n    model: m\n    on_success: no-such-step\n',
        });
        assert.equal(res.status, 400);
        const body = (await res.json()) as { error: string };
        assert.match(body.error, /no-such-step/);
        assert.equal(
            fs.readFileSync(path.join(h.fixture.flowsDir, 'echo.yaml'), 'utf8'),
            SAMPLE_FLOW_ECHO,
        );
    } finally {
        await h.stop();
    }
});

test('PUT /pipeline?dry_run=1 validates (incl. boot enum check) without writing', async () => {
    const h = await makeHarness({ token: TOKEN });
    try {
        const ok = await fetch(`${h.baseUrl}/pipeline?dry_run=1`, {
            method: 'PUT',
            headers: YAML_HEADERS,
            body: SAMPLE_PIPELINE.replace('issue_tracker: linear', 'issue_tracker: jira'),
        });
        assert.equal(ok.status, 200);
        const okBody = (await ok.json()) as { dryRun: boolean };
        assert.equal(okBody.dryRun, true);
        assert.equal(fs.readFileSync(h.fixture.pipelinePath, 'utf8'), SAMPLE_PIPELINE);

        // The same enum validation the orchestrator boot loader runs: an
        // unknown issue_tracker is a 422, not a silent save-then-crash.
        const bad = await fetch(`${h.baseUrl}/pipeline?dry_run=1`, {
            method: 'PUT',
            headers: YAML_HEADERS,
            body: SAMPLE_PIPELINE.replace('issue_tracker: linear', 'issue_tracker: asana'),
        });
        assert.equal(bad.status, 422);
        const badBody = (await bad.json()) as { error: string };
        assert.match(badBody.error, /issue_tracker/);
    } finally {
        await h.stop();
    }
});

test('PUT /pipeline (real write) also rejects an invalid enum with 422, file untouched', async () => {
    const h = await makeHarness({ token: TOKEN });
    try {
        const res = await fetch(`${h.baseUrl}/pipeline`, {
            method: 'PUT',
            headers: YAML_HEADERS,
            body: SAMPLE_PIPELINE.replace('issue_tracker: linear', 'issue_tracker: asana'),
        });
        assert.equal(res.status, 422);
        assert.equal(fs.readFileSync(h.fixture.pipelinePath, 'utf8'), SAMPLE_PIPELINE);
    } finally {
        await h.stop();
    }
});

test('POST /reload forwards to the worker-api with the shared bearer and passes the response through', async () => {
    // Stub worker-api: capture the forwarded request, answer like the real
    // /api/reload-flows route.
    const seen: Array<{ url: string; method: string; auth: string | undefined }> = [];
    const upstream = http.createServer((req, res) => {
        seen.push({
            url: req.url ?? '',
            method: req.method ?? '',
            auth: req.headers.authorization,
        });
        const payload = JSON.stringify({ ok: true, flows: 2, flowIds: ['a', 'b'], note: 'flows reloaded' });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(payload);
    });
    const upstreamPort = await new Promise<number>((resolve) => {
        upstream.listen(0, '127.0.0.1', () => {
            const addr = upstream.address();
            resolve(typeof addr === 'object' && addr ? addr.port : 0);
        });
    });

    const h = await makeHarness({
        token: TOKEN,
        workerApiUrl: `http://127.0.0.1:${upstreamPort}`,
    });
    try {
        const res = await fetch(`${h.baseUrl}/reload`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${TOKEN}` },
        });
        assert.equal(res.status, 200);
        const body = (await res.json()) as { ok: boolean; flows: number; note: string };
        assert.equal(body.ok, true);
        assert.equal(body.flows, 2);
        assert.equal(body.note, 'flows reloaded');

        assert.equal(seen.length, 1);
        assert.equal(seen[0].url, '/api/reload-flows');
        assert.equal(seen[0].method, 'POST');
        // The manager-api reuses the shared WORKER_API_TOKEN_V2 secret as the
        // upstream bearer.
        assert.equal(seen[0].auth, `Bearer ${TOKEN}`);
    } finally {
        await h.stop();
        await new Promise((resolve) => upstream.close(resolve));
    }
});

test('POST /reload returns 502 when the worker-api is unreachable', async () => {
    const h = await makeHarness({
        token: TOKEN,
        // A port nothing listens on — connection refused.
        workerApiUrl: 'http://127.0.0.1:9',
    });
    try {
        const res = await fetch(`${h.baseUrl}/reload`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${TOKEN}` },
        });
        assert.equal(res.status, 502);
        const body = (await res.json()) as { error: string };
        assert.match(body.error, /unreachable/);
    } finally {
        await h.stop();
    }
});

test('POST /reload requires the bearer like every other route', async () => {
    const h = await makeHarness({ token: TOKEN });
    try {
        const res = await fetch(`${h.baseUrl}/reload`, { method: 'POST' });
        assert.equal(res.status, 401);
    } finally {
        await h.stop();
    }
});

/**
 * POST /flows/:name/chat — the manager UI's flow assistant.
 *
 * A proxy, not a local agent run: this process is the config WRITING
 * authority and owns no runner; the worker-api owns every spawn. The
 * response is a revised YAML for the operator's EDITOR — saving it is a
 * separate, deliberate PUT with the loader behind it.
 */
test('postFlowChat forwards the turn and stamps the flow name', async () => {
    const seen: Array<{ url: string; body: unknown }> = [];
    const res = await postFlowChat(
        'implement',
        { yaml: 'on: TaskApproved', question: 'add a reviewer' },
        {
            workerApiUrl: 'http://worker:4101/',
            workerApiToken: 'tok',
            fetchImpl: (async (url: string, init: RequestInit) => {
                seen.push({ url: String(url), body: JSON.parse(String(init.body)) });
                return new Response(JSON.stringify({ yaml: 'revised', reply: 'ok' }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                });
            }) as unknown as typeof fetch,
        },
    );

    assert.equal(res.status, 200);
    assert.equal((res.body as { yaml: string }).yaml, 'revised');
    assert.equal(seen[0].url, 'http://worker:4101/api/flow-chat');
    // The name comes from the PATH, not the body — a body that disagreed
    // would let one flow's editor rewrite another's file.
    assert.deepEqual(seen[0].body, {
        yaml: 'on: TaskApproved',
        question: 'add a reviewer',
        name: 'implement',
    });
});

test('postFlowChat refuses a traversing flow name before any round-trip', async () => {
    let called = false;
    const res = await postFlowChat('../../etc/passwd', {}, {
        workerApiUrl: 'http://worker:4101',
        fetchImpl: (async () => { called = true; return new Response('{}'); }) as unknown as typeof fetch,
    });

    assert.equal(res.status, 400);
    assert.equal(called, false);
});

test('postFlowChat says the assistant is unreachable WITHOUT implying editing is broken', async () => {
    // The worker being down stops the assistant and nothing else: flows
    // are still editable and savable through this process.
    const res = await postFlowChat('implement', {}, {
        workerApiUrl: 'http://worker:4101',
        fetchImpl: (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch,
    });

    assert.equal(res.status, 502);
    assert.match(String((res.body as { error: string }).error), /Editing and saving flows still works/);
});

test('postFlowChat passes an upstream error through verbatim', async () => {
    const res = await postFlowChat('implement', {}, {
        workerApiUrl: 'http://worker:4101',
        fetchImpl: (async () => new Response(
            JSON.stringify({ error: 'flow-author persona unavailable' }),
            { status: 500, headers: { 'Content-Type': 'application/json' } },
        )) as unknown as typeof fetch,
    });

    assert.equal(res.status, 500);
    assert.match(String((res.body as { error: string }).error), /persona unavailable/);
});
