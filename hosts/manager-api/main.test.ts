import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { Logger } from '../../core/ports/Logger';

import { DEFAULT_PORT, start } from './main';

const SAMPLE_PIPELINE = `issue_tracker: linear
agent_runner: claude-cli
source_control: git-cli
chat_gateway: telegram
default_models:
  developer: claude-opus-4-7
  reviewer: claude-sonnet-4-6
default_flows:
  echo: echo.yaml
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
    cleanup(): void;
}

function makeFixture(): Fixture {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-api-'));
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
        cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
    };
}

interface Harness {
    readonly baseUrl: string;
    readonly fixture: Fixture;
    stop(): Promise<void>;
}

async function makeHarness(opts: { token?: string } = {}): Promise<Harness> {
    const fixture = makeFixture();
    const handle = await start({
        port: 0,
        host: '127.0.0.1',
        authToken: opts.token,
        configDir: fixture.dir,
        // Isolated temp sqlite DB per harness so the CQRS composition
        // root (projections + command bus) does not touch the shared
        // orchestrator state file. `applyMigrations` stands the schema up
        // from empty on first open.
        dbPath: path.join(fixture.dir, 'state.db'),
        logger: new SilentLogger(),
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

test('GET /health returns { ok: true } without auth', async () => {
    const h = await makeHarness({ token: TOKEN });
    try {
        const res = await fetch(`${h.baseUrl}/health`);
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { ok: true });
    } finally {
        await h.stop();
    }
});

test('GET /pipeline without bearer token returns 401', async () => {
    const h = await makeHarness({ token: TOKEN });
    try {
        const res = await fetch(`${h.baseUrl}/pipeline`);
        assert.equal(res.status, 401);
        assert.equal(res.headers.get('www-authenticate'), 'Bearer');
    } finally {
        await h.stop();
    }
});

test('GET /pipeline with wrong token returns 401', async () => {
    const h = await makeHarness({ token: TOKEN });
    try {
        const res = await fetch(`${h.baseUrl}/pipeline`, {
            headers: { Authorization: 'Bearer wrong' },
        });
        assert.equal(res.status, 401);
    } finally {
        await h.stop();
    }
});

test('GET /pipeline returns parsed pipeline.yaml as JSON', async () => {
    const h = await makeHarness({ token: TOKEN });
    try {
        const res = await fetch(`${h.baseUrl}/pipeline`, {
            headers: { Authorization: `Bearer ${TOKEN}` },
        });
        assert.equal(res.status, 200);
        const body = (await res.json()) as Record<string, unknown>;
        assert.equal(body.issue_tracker, 'linear');
        assert.equal(body.agent_runner, 'claude-cli');
        assert.deepEqual(body.default_models, {
            developer: 'claude-opus-4-7',
            reviewer: 'claude-sonnet-4-6',
        });
    } finally {
        await h.stop();
    }
});

test('GET /pipeline re-reads from disk on every request (no cache)', async () => {
    const h = await makeHarness({ token: TOKEN });
    try {
        const first = await (
            await fetch(`${h.baseUrl}/pipeline`, {
                headers: { Authorization: `Bearer ${TOKEN}` },
            })
        ).json();
        assert.equal((first as { issue_tracker: string }).issue_tracker, 'linear');

        fs.writeFileSync(
            h.fixture.pipelinePath,
            SAMPLE_PIPELINE.replace('issue_tracker: linear', 'issue_tracker: jira'),
            'utf8',
        );

        const second = await (
            await fetch(`${h.baseUrl}/pipeline`, {
                headers: { Authorization: `Bearer ${TOKEN}` },
            })
        ).json();
        assert.equal((second as { issue_tracker: string }).issue_tracker, 'jira');
    } finally {
        await h.stop();
    }
});

test('GET /flows returns the list of flow names from config/flows/', async () => {
    const h = await makeHarness({ token: TOKEN });
    try {
        const res = await fetch(`${h.baseUrl}/flows`, {
            headers: { Authorization: `Bearer ${TOKEN}` },
        });
        assert.equal(res.status, 200);
        const body = (await res.json()) as { flows: string[] };
        assert.deepEqual(body.flows, ['code-review', 'echo']);
    } finally {
        await h.stop();
    }
});

test('GET /flows/:name returns the raw YAML and the parsed flow', async () => {
    // The envelope (`{ name, raw, flow, error }`) exists so a flow the
    // loader REJECTS can still be opened and repaired in the editor —
    // it used to throw out of the handler as a 500 — and so the editor
    // can show the file's own bytes instead of a parse-then-dump that
    // strips its comments. See flows-route.read.test.ts.
    const h = await makeHarness({ token: TOKEN });
    try {
        const res = await fetch(`${h.baseUrl}/flows/echo`, {
            headers: { Authorization: `Bearer ${TOKEN}` },
        });
        assert.equal(res.status, 200);
        const body = (await res.json()) as {
            name: string;
            raw: string;
            error: string | null;
            flow: { on: string; steps: { id: string }[] };
        };
        assert.equal(body.name, 'echo');
        assert.equal(body.error, null);
        assert.match(body.raw, /steps:/, 'the file text, for the editor');
        assert.equal(body.flow.on, 'TaskApproved');
        assert.equal(body.flow.steps.length, 1);
        assert.equal(body.flow.steps[0].id, 'run');
    } finally {
        await h.stop();
    }
});

test('GET /flows/:name returns 404 for a missing flow', async () => {
    const h = await makeHarness({ token: TOKEN });
    try {
        const res = await fetch(`${h.baseUrl}/flows/does-not-exist`, {
            headers: { Authorization: `Bearer ${TOKEN}` },
        });
        assert.equal(res.status, 404);
    } finally {
        await h.stop();
    }
});

test('GET /flows/:name rejects path-traversal-style names with 404', async () => {
    const h = await makeHarness({ token: TOKEN });
    try {
        const res = await fetch(`${h.baseUrl}/flows/${encodeURIComponent('../pipeline')}`, {
            headers: { Authorization: `Bearer ${TOKEN}` },
        });
        assert.equal(res.status, 404);
    } finally {
        await h.stop();
    }
});

test('GET /models returns the default_models block from pipeline.yaml', async () => {
    const h = await makeHarness({ token: TOKEN });
    try {
        const res = await fetch(`${h.baseUrl}/models`, {
            headers: { Authorization: `Bearer ${TOKEN}` },
        });
        assert.equal(res.status, 200);
        const body = (await res.json()) as Record<string, string>;
        assert.deepEqual(body, {
            developer: 'claude-opus-4-7',
            reviewer: 'claude-sonnet-4-6',
        });
    } finally {
        await h.stop();
    }
});

test('Unknown route returns 404 (with valid auth)', async () => {
    const h = await makeHarness({ token: TOKEN });
    try {
        const res = await fetch(`${h.baseUrl}/unknown`, {
            headers: { Authorization: `Bearer ${TOKEN}` },
        });
        assert.equal(res.status, 404);
    } finally {
        await h.stop();
    }
});

test('Non-GET methods are rejected with 405', async () => {
    const h = await makeHarness({ token: TOKEN });
    try {
        const res = await fetch(`${h.baseUrl}/health`, { method: 'POST' });
        assert.equal(res.status, 405);
    } finally {
        await h.stop();
    }
});

// ---------------------------------------------------------------------------
// P-SM-004 — newly wired CQRS + parity routes
// ---------------------------------------------------------------------------

test('GET /step-kinds returns the static step-kind enum', async () => {
    const h = await makeHarness({ token: TOKEN });
    try {
        const res = await fetch(`${h.baseUrl}/step-kinds`, {
            headers: { Authorization: `Bearer ${TOKEN}` },
        });
        assert.equal(res.status, 200);
        const body = (await res.json()) as { step_kinds: string[] };
        assert.ok(Array.isArray(body.step_kinds));
        assert.ok(body.step_kinds.includes('developer'));
    } finally {
        await h.stop();
    }
});

test('GET /repo-tiers returns the static repo-tier enum', async () => {
    const h = await makeHarness({ token: TOKEN });
    try {
        const res = await fetch(`${h.baseUrl}/repo-tiers`, {
            headers: { Authorization: `Bearer ${TOKEN}` },
        });
        assert.equal(res.status, 200);
        const body = (await res.json()) as { repo_tiers: string[] };
        assert.ok(Array.isArray(body.repo_tiers));
        assert.ok(body.repo_tiers.includes('api'));
    } finally {
        await h.stop();
    }
});

test('GET /agent-providers returns the static provider enum', async () => {
    const h = await makeHarness({ token: TOKEN });
    try {
        const res = await fetch(`${h.baseUrl}/agent-providers`, {
            headers: { Authorization: `Bearer ${TOKEN}` },
        });
        assert.equal(res.status, 200);
        const body = (await res.json()) as { providers: string[] };
        assert.ok(Array.isArray(body.providers));
        assert.ok(body.providers.includes('claude-cli'));
    } finally {
        await h.stop();
    }
});

test('GET /projects returns 200 with a projects array', async () => {
    const h = await makeHarness({ token: TOKEN });
    try {
        const res = await fetch(`${h.baseUrl}/projects`, {
            headers: { Authorization: `Bearer ${TOKEN}` },
        });
        assert.equal(res.status, 200);
        const body = (await res.json()) as { projects: unknown[] };
        assert.ok(Array.isArray(body.projects));
    } finally {
        await h.stop();
    }
});

test('GET /agents returns 200 with an agents array', async () => {
    const h = await makeHarness({ token: TOKEN });
    try {
        const res = await fetch(`${h.baseUrl}/agents`, {
            headers: { Authorization: `Bearer ${TOKEN}` },
        });
        assert.equal(res.status, 200);
        const body = (await res.json()) as { agents: unknown[] };
        assert.ok(Array.isArray(body.agents));
    } finally {
        await h.stop();
    }
});

test('POST /projects is accepted (202) and dispatches CreateProject', async () => {
    const h = await makeHarness({ token: TOKEN });
    try {
        const res = await fetch(`${h.baseUrl}/projects`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${TOKEN}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ name: 'Wiring Test Project' }),
        });
        assert.equal(res.status, 202);
    } finally {
        await h.stop();
    }
});

test('POST /agents is accepted (202) and dispatches CreateAgent', async () => {
    const h = await makeHarness({ token: TOKEN });
    try {
        const res = await fetch(`${h.baseUrl}/agents`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${TOKEN}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                name: 'Test Reviewer',
                role: 'reviewer',
                provider: 'claude-cli',
                model: 'claude-sonnet-4-6',
            }),
        });
        assert.equal(res.status, 202);
    } finally {
        await h.stop();
    }
});

test('DELETE /projects/:projectId is routed (not 404/405)', async () => {
    const h = await makeHarness({ token: TOKEN });
    try {
        const res = await fetch(`${h.baseUrl}/projects/some-project`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${TOKEN}` },
        });
        assert.notEqual(res.status, 404);
        assert.notEqual(res.status, 405);
    } finally {
        await h.stop();
    }
});

test('DELETE /agents/:agentId is routed (not 404/405)', async () => {
    const h = await makeHarness({ token: TOKEN });
    try {
        const res = await fetch(`${h.baseUrl}/agents/some-agent`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${TOKEN}` },
        });
        assert.notEqual(res.status, 404);
        assert.notEqual(res.status, 405);
    } finally {
        await h.stop();
    }
});

test('POST /agents round-trips into GET /agents via the projection', async () => {
    const h = await makeHarness({ token: TOKEN });
    try {
        const create = await fetch(`${h.baseUrl}/agents`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${TOKEN}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                name: 'Roundtrip Agent',
                role: 'tester',
                provider: 'claude-cli',
                model: 'claude-haiku-4-5',
            }),
        });
        assert.equal(create.status, 202);

        const list = await fetch(`${h.baseUrl}/agents`, {
            headers: { Authorization: `Bearer ${TOKEN}` },
        });
        assert.equal(list.status, 200);
        const body = (await list.json()) as { agents: Array<{ name: string | null }> };
        assert.ok(body.agents.some((a) => a.name === 'Roundtrip Agent'));
    } finally {
        await h.stop();
    }
});

test('DEFAULT_PORT is 4102 (distinct from worker-api 4101 and v1 manager 3002)', () => {
    assert.equal(DEFAULT_PORT, 4102);
});

test('Endpoints work unauthenticated when no token is configured', async () => {
    // `start()` falls back to `process.env.WORKER_API_TOKEN_V2` when no
    // `authToken` option is given, so this test must clear the ambient env
    // var (it may be set in the operator's shell/.env) to actually exercise
    // the unauthenticated path rather than depending on the outer shell.
    const savedToken = process.env.WORKER_API_TOKEN_V2;
    delete process.env.WORKER_API_TOKEN_V2;
    try {
        const h = await makeHarness({ token: undefined });
        try {
            const pipeline = await fetch(`${h.baseUrl}/pipeline`);
            assert.equal(pipeline.status, 200);
            const flows = await fetch(`${h.baseUrl}/flows`);
            assert.equal(flows.status, 200);
        } finally {
            await h.stop();
        }
    } finally {
        if (savedToken === undefined) {
            delete process.env.WORKER_API_TOKEN_V2;
        } else {
            process.env.WORKER_API_TOKEN_V2 = savedToken;
        }
    }
});
