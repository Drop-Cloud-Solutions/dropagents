/**
 * AP-IFG-018 manager-board editor tests.
 *
 * Covers the API-layer contract of the project, agent, and model-override
 * editors. The vanilla-JS `manager.js` exports a `makeApi()` factory that
 * the browser bootstrap and these tests share — so a UI button binding
 * `submitProjectForm` → `api.createProject(...)` is verified here by
 * asserting that `createProject` issues the expected fetch.
 *
 * DOM-level integration is left to manual smoke testing of the served
 * page; this repo runs `node --test --import tsx` and pulls in neither
 * `jsdom` nor `happy-dom`, so DOM-driven assertions would need a hand-
 * rolled fake. The API-layer contract is the part the manager-api side
 * of AP-IFG-017 also pins (`hosts/manager-api/routes.parity.test.ts`),
 * so this file is the matching client-side half of that contract.
 *
 * Path note: the task brief lists `hosts/manager-board/web/`; the on-
 * disk asset directory is `hosts/manager-board/public/` (hard-coded in
 * `server.ts`). The test file lives at the brief-specified path and
 * imports from `../public/manager.js`. Renaming the asset directory is
 * out of scope.
 *
 * Dual-runner discovery: see `hosts/board-ui/commands.test.ts` for the
 * full rationale. The shim below picks `test()` from `node:test` under
 * `node --test --import tsx` and from `globalThis` under vitest.
 */
import * as assert from 'node:assert/strict';

// eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
const managerModule = require('../public/manager.js') as {
    makeApi: (opts?: { fetch?: FetchLike }) => ApiSurface;
    extractError: (body: unknown) => string | null;
    extractList: (body: unknown, keys: readonly string[]) => unknown[];
    groupAgentsByRole: (agents: unknown[]) => {
        byRole: Record<string, { active: AgentRecord; shadowed: AgentRecord[] }>;
        orphans: AgentRecord[];
    };
    computeEffective: (
        agent: AgentRecord | null,
        info: RoleInfo | null,
        fallbacks: { fallbackProvider?: string | null; fallbackModel?: string | null } | null
    ) => {
        model: { value: string; source: string };
        provider: { value: string; source: string };
        persona: { value: string; source: string };
    };
};

interface AgentRecord {
    readonly agentId?: string;
    readonly name?: string | null;
    readonly role?: string | null;
    readonly provider?: string | null;
    readonly model?: string | null;
    readonly prompt?: string | null;
    readonly updatedAt?: number | null;
}

interface RoleInfo {
    readonly role: string;
    readonly defaultModel?: string | null;
    readonly personaFile?: boolean;
    readonly envProvider?: string | null;
    readonly envModel?: string | null;
}

// ---------------------------------------------------------------------------
// Dual-runner test() shim
// ---------------------------------------------------------------------------

type TestFn = (name: string, fn: () => void | Promise<void>) => void;

const test: TestFn = (((): TestFn => {
    if (process.env.VITEST) {
        const gt = (globalThis as { test?: TestFn }).test;
        if (typeof gt !== 'function') {
            throw new Error(
                'editors.test.ts: VITEST=true but globalThis.test is missing — '
                    + 'ensure vitest.config.ts sets test.globals = true'
            );
        }
        return gt;
    }
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    const nt = require('node:test') as { test: TestFn };
    return nt.test;
})());

// ---------------------------------------------------------------------------
// Fake fetch
// ---------------------------------------------------------------------------

interface FetchCall {
    readonly url: string;
    readonly method: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string | undefined;
}

interface FakeResponse {
    readonly status?: number;
    readonly body?: unknown;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

interface ApiSurface {
    listProjects(): Promise<{ ok: boolean; status: number; body: unknown }>;
    createProject(payload: unknown): Promise<{ ok: boolean; status: number; body: unknown }>;
    updateProject(
        id: string,
        payload: unknown
    ): Promise<{ ok: boolean; status: number; body: unknown }>;
    archiveProject(id: string): Promise<{ ok: boolean; status: number; body: unknown }>;
    listAgents(): Promise<{ ok: boolean; status: number; body: unknown }>;
    createAgent(payload: unknown): Promise<{ ok: boolean; status: number; body: unknown }>;
    updateAgent(
        id: string,
        payload: unknown
    ): Promise<{ ok: boolean; status: number; body: unknown }>;
    deleteAgent(id: string): Promise<{ ok: boolean; status: number; body: unknown }>;
    getAgentProviders(): Promise<{ ok: boolean; status: number; body: unknown }>;
    getAgentRoles(): Promise<{ ok: boolean; status: number; body: unknown }>;
    getStepKinds(): Promise<{ ok: boolean; status: number; body: unknown }>;
    getAgentModel(role: string): Promise<{ ok: boolean; status: number; body: unknown }>;
    setAgentModel(
        role: string,
        model: string,
        etag?: string
    ): Promise<{ ok: boolean; status: number; body: unknown }>;
    putPipelineYaml(
        yaml: string,
        dryRun?: boolean
    ): Promise<{ ok: boolean; status: number; body: unknown }>;
    putFlowYaml(
        name: string,
        yaml: string,
        dryRun?: boolean
    ): Promise<{ ok: boolean; status: number; body: unknown }>;
    applyConfig(): Promise<{ ok: boolean; status: number; body: unknown }>;
    listSettings(): Promise<{ ok: boolean; status: number; body: unknown }>;
    putSetting(
        key: string,
        value: string,
        etag?: string
    ): Promise<{ ok: boolean; status: number; body: unknown }>;
    deleteSetting(key: string): Promise<{ ok: boolean; status: number; body: unknown }>;
    getAgentMd(role: string): Promise<{ ok: boolean; status: number; body: unknown }>;
    putAgentMd(
        role: string,
        content: string
    ): Promise<{ ok: boolean; status: number; body: unknown }>;
    generateAgentMd(
        role: string,
        purpose: string
    ): Promise<{ ok: boolean; status: number; body: unknown }>;
    regenerateAgentMd(
        role: string,
        instructions: string
    ): Promise<{ ok: boolean; status: number; body: unknown }>;
    getProjectContextMd(
        projectId: string
    ): Promise<{ ok: boolean; status: number; body: unknown }>;
    putProjectContextMd(
        projectId: string,
        content: string,
        etag?: string
    ): Promise<{ ok: boolean; status: number; body: unknown }>;
}

interface FakeFetchHandle {
    readonly fetch: FetchLike;
    readonly calls: FetchCall[];
    /**
     * Set the response for the next request (or all subsequent requests,
     * if `persist` is true). Defaults: 200 + empty JSON.
     */
    queue(response: FakeResponse): void;
}

function makeFakeFetch(): FakeFetchHandle {
    const calls: FetchCall[] = [];
    const queued: FakeResponse[] = [];
    const defaultResponse: FakeResponse = { status: 200, body: { ok: true } };

    function normaliseHeaders(init?: RequestInit): Readonly<Record<string, string>> {
        const out: Record<string, string> = {};
        const h = init?.headers;
        if (!h) return out;
        if (h instanceof Headers) {
            h.forEach((v, k) => {
                out[k.toLowerCase()] = v;
            });
        } else if (Array.isArray(h)) {
            for (const [k, v] of h as Array<[string, string]>) out[k.toLowerCase()] = v;
        } else {
            for (const [k, v] of Object.entries(h as Record<string, string>))
                out[k.toLowerCase()] = v;
        }
        return out;
    }

    function bodyToString(init?: RequestInit): string | undefined {
        if (!init || init.body === undefined || init.body === null) return undefined;
        if (typeof init.body === 'string') return init.body;
        // Tests only pass strings; reject anything else loudly so a future
        // call with a non-string body doesn't silently lose information.
        throw new Error('fake fetch only supports string bodies in this test harness');
    }

    const fetch: FetchLike = async (url, init): Promise<Response> => {
        calls.push({
            url: String(url),
            method: (init?.method ?? 'GET').toUpperCase(),
            headers: normaliseHeaders(init),
            body: bodyToString(init)
        });
        const r = queued.shift() ?? defaultResponse;
        const status = r.status ?? 200;
        const payload = r.body === undefined ? null : r.body;
        const text = payload === null ? '' : JSON.stringify(payload);
        return new Response(text, {
            status,
            headers: { 'Content-Type': 'application/json' }
        });
    };

    return {
        fetch,
        calls,
        queue(response: FakeResponse): void {
            queued.push(response);
        }
    };
}

// ---------------------------------------------------------------------------
// makeApi() — module export sanity
// ---------------------------------------------------------------------------

test('manager.js exports makeApi from CommonJS', () => {
    assert.equal(typeof managerModule.makeApi, 'function');
});

test('makeApi returns the editor surface used by the UI bootstrap', () => {
    const api = managerModule.makeApi({ fetch: () => Promise.resolve(new Response('{}')) });
    const surface = [
        'listProjects',
        'createProject',
        'updateProject',
        'archiveProject',
        'listAgents',
        'createAgent',
        'updateAgent',
        'deleteAgent',
        'getAgentProviders',
        'getAgentRoles',
        'getStepKinds',
        'getAgentModel',
        'setAgentModel',
        'getAgentMd',
        'putAgentMd',
        'generateAgentMd',
        'regenerateAgentMd',
        'getProjectContextMd',
        'putProjectContextMd'
    ];
    for (const fn of surface) {
        assert.equal(
            typeof (api as unknown as Record<string, unknown>)[fn],
            'function',
            `makeApi() must expose ${fn}`
        );
    }
});

// ---------------------------------------------------------------------------
// Projects: AC #1 + AC #4 + AC #5 + AC #6 (project create)
// ---------------------------------------------------------------------------

test('createProject POSTs JSON to /api/projects with the form payload', async () => {
    const fake = makeFakeFetch();
    fake.queue({
        status: 202,
        body: { ok: true, events: [{ type: 'ProjectCreated', seq: 1 }] }
    });
    const api = managerModule.makeApi({ fetch: fake.fetch });

    const res = await api.createProject({ name: 'Demo', description: 'd' });

    assert.equal(fake.calls.length, 1);
    const call = fake.calls[0];
    assert.equal(call.url, '/api/projects');
    assert.equal(call.method, 'POST');
    assert.equal(call.headers['content-type'], 'application/json');
    assert.deepEqual(JSON.parse(call.body ?? ''), { name: 'Demo', description: 'd' });
    assert.equal(res.ok, true);
    assert.equal(res.status, 202);
});

test('updateProject merges projectId from the URL and PUTs JSON', async () => {
    const fake = makeFakeFetch();
    fake.queue({ status: 202, body: { ok: true } });
    const api = managerModule.makeApi({ fetch: fake.fetch });

    await api.updateProject('proj-7', { description: 'renamed' });

    const call = fake.calls[0];
    assert.equal(call.url, '/api/projects/proj-7');
    assert.equal(call.method, 'PUT');
    assert.deepEqual(JSON.parse(call.body ?? ''), { description: 'renamed' });
});

test('archiveProject DELETEs /api/projects/:projectId without a body', async () => {
    const fake = makeFakeFetch();
    fake.queue({ status: 202, body: { ok: true } });
    const api = managerModule.makeApi({ fetch: fake.fetch });

    await api.archiveProject('proj-9');

    const call = fake.calls[0];
    assert.equal(call.url, '/api/projects/proj-9');
    assert.equal(call.method, 'DELETE');
    assert.equal(call.body, undefined);
});

test('listProjects surfaces a 404 from manager-api without throwing', async () => {
    const fake = makeFakeFetch();
    fake.queue({ status: 404, body: { error: 'not found' } });
    const api = managerModule.makeApi({ fetch: fake.fetch });

    const res = await api.listProjects();

    assert.equal(res.ok, false);
    assert.equal(res.status, 404);
    assert.equal(managerModule.extractError(res.body), 'not found');
});

// ---------------------------------------------------------------------------
// Agents: AC #2 + AC #6 (agent create)
// ---------------------------------------------------------------------------

test('createAgent POSTs to /api/agents with provider + model + role', async () => {
    const fake = makeFakeFetch();
    fake.queue({
        status: 202,
        body: { ok: true, events: [{ type: 'AgentCreated', seq: 1 }] }
    });
    const api = managerModule.makeApi({ fetch: fake.fetch });

    await api.createAgent({
        name: 'docs-bot',
        role: 'doc-writer',
        provider: 'claude-cli',
        model: 'claude-sonnet-4-6'
    });

    const call = fake.calls[0];
    assert.equal(call.url, '/api/agents');
    assert.equal(call.method, 'POST');
    assert.equal(call.headers['content-type'], 'application/json');
    assert.deepEqual(JSON.parse(call.body ?? ''), {
        name: 'docs-bot',
        role: 'doc-writer',
        provider: 'claude-cli',
        model: 'claude-sonnet-4-6'
    });
});

test('updateAgent PUTs /api/agents/:agentId with the patched fields', async () => {
    const fake = makeFakeFetch();
    fake.queue({ status: 202, body: { ok: true } });
    const api = managerModule.makeApi({ fetch: fake.fetch });

    await api.updateAgent('a-1', { model: 'claude-haiku-4-5' });

    const call = fake.calls[0];
    assert.equal(call.url, '/api/agents/a-1');
    assert.equal(call.method, 'PUT');
    assert.deepEqual(JSON.parse(call.body ?? ''), { model: 'claude-haiku-4-5' });
});

test('deleteAgent DELETEs /api/agents/:agentId', async () => {
    const fake = makeFakeFetch();
    fake.queue({ status: 202, body: { ok: true } });
    const api = managerModule.makeApi({ fetch: fake.fetch });

    await api.deleteAgent('a-9');

    const call = fake.calls[0];
    assert.equal(call.url, '/api/agents/a-9');
    assert.equal(call.method, 'DELETE');
});

test('getAgentProviders feeds the agent-form dropdown via /api/agent-providers', async () => {
    const fake = makeFakeFetch();
    fake.queue({
        status: 200,
        body: { providers: ['claude-cli', 'anthropic-api', 'foundry'] }
    });
    const api = managerModule.makeApi({ fetch: fake.fetch });

    const res = await api.getAgentProviders();

    assert.equal(fake.calls[0].url, '/api/agent-providers');
    assert.equal(fake.calls[0].method, 'GET');
    assert.equal(res.ok, true);
    assert.deepEqual(
        managerModule.extractList(res.body, ['providers']),
        ['claude-cli', 'anthropic-api', 'foundry']
    );
});

// ---------------------------------------------------------------------------
// Model overrides: AC #3 + AC #6 (model override change)
// ---------------------------------------------------------------------------

test('getAgentModel reads /api/agent-models/:role and surfaces the default fallback', async () => {
    const fake = makeFakeFetch();
    fake.queue({
        status: 200,
        body: { role: 'developer', model: 'claude-opus-4-7', source: 'default' }
    });
    const api = managerModule.makeApi({ fetch: fake.fetch });

    const res = await api.getAgentModel('developer');

    assert.equal(fake.calls[0].url, '/api/agent-models/developer');
    assert.equal(fake.calls[0].method, 'GET');
    const body = res.body as { source: string; model: string };
    assert.equal(body.source, 'default');
    assert.equal(body.model, 'claude-opus-4-7');
});

test('setAgentModel PUTs the override and the role re-loads as override on next GET', async () => {
    const fake = makeFakeFetch();
    fake.queue({
        status: 200,
        body: { role: 'developer', model: 'claude-haiku-4-5', source: 'override', etag: 'e-1' }
    });
    fake.queue({
        status: 200,
        body: { role: 'developer', model: 'claude-haiku-4-5', source: 'override', etag: 'e-1' }
    });
    const api = managerModule.makeApi({ fetch: fake.fetch });

    const put = await api.setAgentModel('developer', 'claude-haiku-4-5');

    const putCall = fake.calls[0];
    assert.equal(putCall.url, '/api/agent-models/developer');
    assert.equal(putCall.method, 'PUT');
    assert.equal(putCall.headers['content-type'], 'application/json');
    assert.deepEqual(JSON.parse(putCall.body ?? ''), { model: 'claude-haiku-4-5' });
    assert.equal(put.ok, true);

    // AC #5: after the mutation the list re-renders by re-fetching the role.
    const after = await api.getAgentModel('developer');
    assert.equal(fake.calls[1].method, 'GET');
    const afterBody = after.body as { source: string; model: string };
    assert.equal(afterBody.source, 'override');
    assert.equal(afterBody.model, 'claude-haiku-4-5');
});

test('setAgentModel forwards the etag for optimistic concurrency', async () => {
    const fake = makeFakeFetch();
    fake.queue({ status: 200, body: { ok: true } });
    const api = managerModule.makeApi({ fetch: fake.fetch });

    await api.setAgentModel('reviewer', 'claude-sonnet-4-6', 'etag-42');

    assert.deepEqual(JSON.parse(fake.calls[0].body ?? ''), {
        model: 'claude-sonnet-4-6',
        etag: 'etag-42'
    });
});

test('setAgentModel surfaces 409 ConcurrencyError without throwing', async () => {
    const fake = makeFakeFetch();
    fake.queue({
        status: 409,
        body: { error: 'etag mismatch for AgentModels/developer', conflictingEtag: 'real-etag' }
    });
    const api = managerModule.makeApi({ fetch: fake.fetch });

    const res = await api.setAgentModel('developer', 'claude-haiku-4-5', 'stale');

    assert.equal(res.ok, false);
    assert.equal(res.status, 409);
    assert.equal(managerModule.extractError(res.body), 'etag mismatch for AgentModels/developer');
});

// ---------------------------------------------------------------------------
// Persona MD files: agents/<role>.CLAUDE.md editor
// ---------------------------------------------------------------------------

test('getAgentMd reads /api/agent-md/:role and surfaces the exists flag', async () => {
    const fake = makeFakeFetch();
    fake.queue({
        status: 200,
        body: { role: 'publisher', exists: false, path: 'agents/publisher.CLAUDE.md', content: '' }
    });
    const api = managerModule.makeApi({ fetch: fake.fetch });

    const res = await api.getAgentMd('publisher');

    assert.equal(fake.calls[0].url, '/api/agent-md/publisher');
    assert.equal(fake.calls[0].method, 'GET');
    const body = res.body as { exists: boolean; path: string };
    assert.equal(body.exists, false);
    assert.equal(body.path, 'agents/publisher.CLAUDE.md');
});

test('putAgentMd PUTs the content as JSON', async () => {
    const fake = makeFakeFetch();
    fake.queue({ status: 200, body: { role: 'tester', ok: true } });
    const api = managerModule.makeApi({ fetch: fake.fetch });

    const res = await api.putAgentMd('tester', '# ROLE: Tester Agent\n');

    const call = fake.calls[0];
    assert.equal(call.url, '/api/agent-md/tester');
    assert.equal(call.method, 'PUT');
    assert.equal(call.headers['content-type'], 'application/json');
    assert.deepEqual(JSON.parse(call.body ?? ''), { content: '# ROLE: Tester Agent\n' });
    assert.equal(res.ok, true);
});

test('generateAgentMd POSTs the purpose to /generate and returns the draft', async () => {
    const fake = makeFakeFetch();
    fake.queue({ status: 200, body: { role: 'publisher', content: '# ROLE: Publisher Agent\n' } });
    const api = managerModule.makeApi({ fetch: fake.fetch });

    const res = await api.generateAgentMd('publisher', 'publishes release notes');

    const call = fake.calls[0];
    assert.equal(call.url, '/api/agent-md/publisher/generate');
    assert.equal(call.method, 'POST');
    assert.deepEqual(JSON.parse(call.body ?? ''), { purpose: 'publishes release notes' });
    const body = res.body as { content: string };
    assert.equal(body.content, '# ROLE: Publisher Agent\n');
});

test('regenerateAgentMd POSTs instructions to /generate (revise mode)', async () => {
    const fake = makeFakeFetch();
    fake.queue({ status: 200, body: { role: 'reviewer', content: '# ROLE: Reviewer Agent\n' } });
    const api = managerModule.makeApi({ fetch: fake.fetch });

    await api.regenerateAgentMd('reviewer', 'also score severity');

    const call = fake.calls[0];
    assert.equal(call.url, '/api/agent-md/reviewer/generate');
    assert.equal(call.method, 'POST');
    assert.deepEqual(JSON.parse(call.body ?? ''), { instructions: 'also score severity' });
});

// ---------------------------------------------------------------------------
// Role enumeration drives the override list (AC #3): GET /api/step-kinds
// ---------------------------------------------------------------------------

test('getStepKinds populates the override list with the closed role enum', async () => {
    const fake = makeFakeFetch();
    fake.queue({
        status: 200,
        body: { step_kinds: ['developer', 'reviewer', 'tester', 'doc-writer'] }
    });
    const api = managerModule.makeApi({ fetch: fake.fetch });

    const res = await api.getStepKinds();
    assert.equal(fake.calls[0].url, '/api/step-kinds');
    const list = managerModule.extractList(res.body, ['step_kinds']) as string[];
    assert.ok(list.includes('developer'));
    assert.ok(list.includes('reviewer'));
});

// ---------------------------------------------------------------------------
// Helpers (snapshot guards — the UI relies on these stable shapes)
// ---------------------------------------------------------------------------

test('extractList tolerates an array body and a wrapped { projects } body', () => {
    assert.deepEqual(managerModule.extractList(['a', 'b'], ['projects']), ['a', 'b']);
    assert.deepEqual(
        managerModule.extractList({ projects: ['x'] }, ['projects', 'items']),
        ['x']
    );
    assert.deepEqual(
        managerModule.extractList({ items: ['y'] }, ['projects', 'items']),
        ['y']
    );
    assert.deepEqual(managerModule.extractList({}, ['projects']), []);
});

test('extractError surfaces { error } strings and ignores everything else', () => {
    assert.equal(managerModule.extractError({ error: 'oops' }), 'oops');
    assert.equal(managerModule.extractError({}), null);
    assert.equal(managerModule.extractError('plain string'), null);
    assert.equal(managerModule.extractError(null), null);
});

// ---------------------------------------------------------------------------
// Agents control center (Option B, Phase 3) — getAgentRoles + pure helpers
// ---------------------------------------------------------------------------

test('getAgentRoles reads /api/agent-roles', async () => {
    const fake = makeFakeFetch();
    fake.queue({
        status: 200,
        body: {
            roles: [{ role: 'developer', defaultModel: 'claude-opus-4-8', personaFile: true }],
            fallbackProvider: 'claude-cli',
            fallbackModel: 'claude-opus-4-8'
        }
    });
    const api = managerModule.makeApi({ fetch: fake.fetch });
    const res = await api.getAgentRoles();
    assert.equal(fake.calls[0].url, '/api/agent-roles');
    assert.equal(fake.calls[0].method, 'GET');
    assert.equal(res.ok, true);
    const body = res.body as { roles: Array<{ role: string }> };
    assert.equal(body.roles[0].role, 'developer');
});

test('groupAgentsByRole picks the newest record per role (resolver parity) and shadows the rest', () => {
    const grouped = managerModule.groupAgentsByRole([
        { agentId: 'a-old', role: 'developer', updatedAt: 1000 },
        { agentId: 'a-new', role: 'developer', updatedAt: 2000 },
        { agentId: 'a-solo', role: 'reviewer', updatedAt: 500 },
        { agentId: 'a-orphan', role: null, updatedAt: 100 }
    ]);
    assert.equal(grouped.byRole.developer.active.agentId, 'a-new');
    assert.deepEqual(
        grouped.byRole.developer.shadowed.map((a) => a.agentId),
        ['a-old']
    );
    assert.equal(grouped.byRole.reviewer.active.agentId, 'a-solo');
    assert.deepEqual(
        grouped.orphans.map((a) => a.agentId),
        ['a-orphan']
    );
});

test('computeEffective: Agent fields win, then pipeline default, then env, then runner default', () => {
    const info: RoleInfo = {
        role: 'developer',
        defaultModel: 'claude-opus-4-8',
        personaFile: true,
        envProvider: null,
        envModel: 'env-model'
    };
    const fallbacks = { fallbackProvider: 'claude-cli', fallbackModel: 'claude-opus-4-8' };

    // Fully configured agent — every source is 'agent'.
    const full = managerModule.computeEffective(
        { model: 'my-model', provider: 'cursor-cli', prompt: 'be terse' },
        info,
        fallbacks
    );
    assert.deepEqual(full.model, { value: 'my-model', source: 'agent' });
    assert.deepEqual(full.provider, { value: 'cursor-cli', source: 'agent' });
    assert.equal(full.persona.source, 'agent');

    // Empty strings mean INHERIT — same as no agent fields at all. With the
    // provider resolving to claude-cli, the model follows the pipeline chain.
    const inherit = managerModule.computeEffective(
        { model: '', provider: '', prompt: '' },
        info,
        fallbacks
    );
    assert.deepEqual(inherit.model, { value: 'claude-opus-4-8', source: 'pipeline' });
    assert.deepEqual(inherit.provider, { value: 'claude-cli', source: 'env-fallback' });
    assert.deepEqual(inherit.persona, { value: 'developer.CLAUDE.md', source: 'file' });

    // No agent record, no role info at all — the runner's own defaults.
    const bare = managerModule.computeEffective(null, null, null);
    assert.deepEqual(bare.model, { value: '(fake runner)', source: 'provider-default' });
    assert.deepEqual(bare.provider, { value: 'fake', source: 'env-fallback' });
    assert.equal(bare.persona.source, 'runner-default');
});

test('computeEffective falls back to default_models.developer before env for the model', () => {
    const res = managerModule.computeEffective(
        null,
        { role: 'architect', defaultModel: null, personaFile: true, envModel: 'env-model' },
        { fallbackProvider: 'claude-cli', fallbackModel: 'claude-opus-4-8' }
    );
    // Mirrors ClaudeCliRunner.resolveModel: defaultModels[role] →
    // defaultModels.developer → CLAUDE_MODEL_<ROLE>/CLAUDE_MODEL.
    assert.deepEqual(res.model, { value: 'claude-opus-4-8', source: 'pipeline-developer' });
});

test('computeEffective does not claim a claude model for deepseek/cursor-routed roles', () => {
    // deepseek/cursor-cli runners resolve their own defaults and never see
    // pipeline default_models — the chip must not show a claude id there.
    const info: RoleInfo = {
        role: 'reviewer',
        defaultModel: 'claude-sonnet-5',
        personaFile: true,
        envProvider: 'deepseek',
        envModel: null
    };
    const viaEnv = managerModule.computeEffective(null, info, {
        fallbackProvider: 'claude-cli',
        fallbackModel: 'claude-opus-4-8'
    });
    assert.deepEqual(viaEnv.provider, { value: 'deepseek', source: 'env' });
    assert.deepEqual(viaEnv.model, { value: '(deepseek default)', source: 'provider-default' });

    // ...but an explicit Agent.model still wins even on deepseek/cursor
    // (resolveDefaultModel is honoured by every runner).
    const viaAgent = managerModule.computeEffective(
        { model: 'deepseek-v4-pro', provider: 'cursor-cli' },
        info,
        { fallbackProvider: 'claude-cli', fallbackModel: null }
    );
    assert.deepEqual(viaAgent.model, { value: 'deepseek-v4-pro', source: 'agent' });
});

test("computeEffective treats Agent.model 'none' as inherit, like the runners", () => {
    const res = managerModule.computeEffective(
        { model: 'none', provider: 'claude-cli' },
        { role: 'developer', defaultModel: 'claude-opus-4-8', personaFile: true },
        { fallbackProvider: 'claude-cli', fallbackModel: 'claude-opus-4-8' }
    );
    // ClaudeCliRunner/CursorCliRunner skip the 'none' sentinel from the
    // agent record and fall through to the role default.
    assert.deepEqual(res.model, { value: 'claude-opus-4-8', source: 'pipeline' });
});

test('computeEffective resolves env overrides for roles outside the vocabulary via top-level maps', () => {
    // A role that exists only as an agent record has info=null; the top-level
    // envProviders/envModels maps (scanned exactly like the orchestrator
    // reads them) must still apply.
    const res = managerModule.computeEffective(
        { role: 'security-auditor', model: '', provider: '' },
        null,
        {
            fallbackProvider: 'claude-cli',
            fallbackModel: null,
            envProviders: { 'security-auditor': 'claude-cli' },
            envModels: { 'SECURITY-AUDITOR': 'claude-opus-4-8' },
            envModel: null
        } as never
    );
    assert.deepEqual(res.provider, { value: 'claude-cli', source: 'env' });
    assert.deepEqual(res.model, { value: 'claude-opus-4-8', source: 'env' });
});

test('groupAgentsByRole is safe for roles named after Object.prototype members', () => {
    const grouped = managerModule.groupAgentsByRole([
        { agentId: 'a-1', role: 'toString', updatedAt: 100 },
        { agentId: 'a-2', role: '__proto__', updatedAt: 200 },
        { agentId: 'a-3', role: 'constructor', updatedAt: 300 }
    ]);
    assert.equal(grouped.byRole['toString'].active.agentId, 'a-1');
    assert.equal(grouped.byRole['__proto__'].active.agentId, 'a-2');
    assert.equal(grouped.byRole['constructor'].active.agentId, 'a-3');
    assert.equal(grouped.orphans.length, 0);
});

// ---------------------------------------------------------------------------
// Phase 4 — Validate as dry run + operator Apply
// ---------------------------------------------------------------------------

test('putFlowYaml appends ?dry_run=1 when validating and omits it when saving', async () => {
    const fake = makeFakeFetch();
    const api = managerModule.makeApi({ fetch: fake.fetch });

    await api.putFlowYaml('implement', 'on: TaskApproved\n', true);
    await api.putFlowYaml('implement', 'on: TaskApproved\n', false);
    await api.putPipelineYaml('issue_tracker: linear\n', true);

    assert.equal(fake.calls[0].url, '/api/flows/implement?dry_run=1');
    assert.equal(fake.calls[0].method, 'PUT');
    assert.equal(fake.calls[1].url, '/api/flows/implement');
    assert.equal(fake.calls[2].url, '/api/pipeline?dry_run=1');
});

test('applyConfig POSTs /api/reload and surfaces the orchestrator response', async () => {
    const fake = makeFakeFetch();
    fake.queue({
        status: 200,
        body: { ok: true, flows: 12, note: 'flows reloaded' }
    });
    const api = managerModule.makeApi({ fetch: fake.fetch });

    const res = await api.applyConfig();
    assert.equal(fake.calls[0].url, '/api/reload');
    assert.equal(fake.calls[0].method, 'POST');
    assert.equal(res.ok, true);
    const body = res.body as { flows: number; note: string };
    assert.equal(body.flows, 12);
    assert.equal(body.note, 'flows reloaded');
});

// ---------------------------------------------------------------------------
// Phase 5 — Settings API surface (secrets stay write-only on the wire)
// ---------------------------------------------------------------------------

test('listSettings reads /api/settings', async () => {
    const fake = makeFakeFetch();
    fake.queue({
        status: 200,
        body: {
            settings: [
                {
                    key: 'LINEAR_API_KEY',
                    label: 'Linear API key',
                    category: 'Integrations',
                    secret: true,
                    source: 'override',
                    set: true,
                    etag: 'e-1'
                }
            ],
            note: 'restart to apply'
        }
    });
    const api = managerModule.makeApi({ fetch: fake.fetch });
    const res = await api.listSettings();
    assert.equal(fake.calls[0].url, '/api/settings');
    assert.equal(res.ok, true);
    const body = res.body as { settings: Array<{ key: string; value?: string }> };
    assert.equal(body.settings[0].key, 'LINEAR_API_KEY');
    assert.equal('value' in body.settings[0], false, 'secret carries no value on the wire');
});

test('putSetting PUTs {value, etag} and deleteSetting sends a body-less DELETE', async () => {
    const fake = makeFakeFetch();
    const api = managerModule.makeApi({ fetch: fake.fetch });

    await api.putSetting('GIT_COMMIT_NAME', 'Pipeline Bot', 'e-9');
    await api.putSetting('DEEPSEEK_API_KEY', 'sk-x');
    await api.deleteSetting('GIT_COMMIT_NAME');

    assert.equal(fake.calls[0].url, '/api/settings/GIT_COMMIT_NAME');
    assert.equal(fake.calls[0].method, 'PUT');
    assert.deepEqual(JSON.parse(fake.calls[0].body ?? '{}'), {
        value: 'Pipeline Bot',
        etag: 'e-9'
    });
    assert.deepEqual(JSON.parse(fake.calls[1].body ?? '{}'), { value: 'sk-x' });
    assert.equal(fake.calls[2].url, '/api/settings/GIT_COMMIT_NAME');
    assert.equal(fake.calls[2].method, 'DELETE');
    assert.equal(fake.calls[2].body, undefined);
});

// ---------------------------------------------------------------------------
// Project architecture context (ConfigStore ProjectConfig.metadata.context_md)
//
// Reaches the planner / decomposer / architect as the `# Project context`
// prompt block. Before this existed the file had no reader and no writer.
// ---------------------------------------------------------------------------

test('getProjectContextMd reads /api/projects/:id/context-md', async () => {
    const fake = makeFakeFetch();
    fake.queue({
        status: 200,
        body: { projectId: 'shop', exists: true, content: '# Architecture', etag: 'e1' }
    });
    const api = managerModule.makeApi({ fetch: fake.fetch });

    const res = await api.getProjectContextMd('shop');

    assert.equal(fake.calls[0].url, '/api/projects/shop/context-md');
    assert.equal(fake.calls[0].method, 'GET');
    assert.equal((res.body as { content: string }).content, '# Architecture');
});

test('putProjectContextMd round-trips the etag so a concurrent save 409s', async () => {
    // Without the etag the second editor silently overwrites the first.
    const fake = makeFakeFetch();
    fake.queue({ status: 200, body: { projectId: 'shop', ok: true, etag: 'e2' } });
    const api = managerModule.makeApi({ fetch: fake.fetch });

    const res = await api.putProjectContextMd('shop', '# New context', 'e1');

    const call = fake.calls[0];
    assert.equal(call.url, '/api/projects/shop/context-md');
    assert.equal(call.method, 'PUT');
    assert.equal(call.headers['content-type'], 'application/json');
    assert.deepEqual(JSON.parse(call.body ?? ''), {
        content: '# New context',
        etag: 'e1'
    });
    assert.equal(res.ok, true);
});

test('putProjectContextMd omits the etag on a first write', async () => {
    const fake = makeFakeFetch();
    fake.queue({ status: 200, body: { ok: true } });
    const api = managerModule.makeApi({ fetch: fake.fetch });

    await api.putProjectContextMd('shop', '# First', '');

    assert.deepEqual(JSON.parse(fake.calls[0].body ?? ''), { content: '# First' });
});

test('project ids are URL-encoded on both verbs', async () => {
    const fake = makeFakeFetch();
    fake.queue({ status: 200, body: {} });
    fake.queue({ status: 200, body: {} });
    const api = managerModule.makeApi({ fetch: fake.fetch });

    await api.getProjectContextMd('drop cloud/solutions');
    await api.putProjectContextMd('drop cloud/solutions', 'x');

    assert.equal(fake.calls[0].url, '/api/projects/drop%20cloud%2Fsolutions/context-md');
    assert.equal(fake.calls[1].url, '/api/projects/drop%20cloud%2Fsolutions/context-md');
});
