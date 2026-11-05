/**
 * AP-IFG-017 manager-api v1-parity route tests.
 *
 * Dual-runner discovery (see `hosts/board-ui/commands.test.ts` for the
 * full rationale): the repo runs `node --test --import tsx` locally and
 * `npx vitest run` in the review pipeline. We pick the right `test()` at
 * load time without statically importing `vitest`, which would crash
 * under `node:test`.
 *
 * The tests exercise the route handlers directly rather than over HTTP.
 * The HTTP plumbing in `main.ts` is covered by `main.test.ts`; this
 * file's contract is the route-function semantics — fallback to
 * pipeline.yaml, persistence through the state port, command emission
 * via the CommandBus — so an in-process call gives sharper assertions
 * than a fetch round-trip.
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { CommandBus } from '../../core/commands/bus';
import { EventBus } from '../../core/events/bus';
import { EventStore } from '../../core/events/store';
import { applyMigrations, openDatabase, type Db } from '../../core/state/migrations';
import {
    ConcurrencyError,
    type ConfigRow,
    type ConfigRowKind,
    type ConfigRowUpsert,
    type ConfigStore,
} from '../../core/ports/ConfigStore';
import type { IdGen } from '../../core/ports/IdGen';
import type { Logger } from '../../core/ports/Logger';
import type { StoredEvent } from '../../core/events/event';

import {
    BoardUiEvents,
    registerBoardUiCommands,
    type ProjectArchivedPayload,
    type ProjectCreatedPayload,
    type ProjectUpdatedPayload,
} from '../board-ui/commands';

import { FsConfigStore } from '../../adapters/fs-config-store/FsConfigStore';

import { SELECTABLE_AGENT_PROVIDER_IDS } from '../../core/agents/providers';
import {
    AGENT_PROVIDERS,
    deleteAgent,
    deleteProject,
    deleteSetting,
    getAgentModel,
    getAgentProviders,
    getAgentRoles,
    getRepoTiers,
    getSettings,
    getStepKinds,
    isCreateAgentPayload,
    isDeleteAgentPayload,
    isUpdateAgentPayload,
    ManagerApiCommands,
    ManagerApiEvents,
    postAgent,
    postProject,
    putAgent,
    putAgentModel,
    putProject,
    putSetting,
    registerManagerApiCommands,
    REPO_TIERS,
    STEP_KINDS,
    type AgentCreatedPayload,
    type AgentDeletedPayload,
    type AgentUpdatedPayload,
} from './routes';

// ---------------------------------------------------------------------------
// Dual-runner test() shim
// ---------------------------------------------------------------------------

type TestFn = (name: string, fn: () => void | Promise<void>) => void;

const test: TestFn = (((): TestFn => {
    if (process.env.VITEST) {
        const gt = (globalThis as { test?: TestFn }).test;
        if (typeof gt !== 'function') {
            throw new Error(
                'routes.parity.test.ts: VITEST=true but globalThis.test is missing — '
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
// Fixtures
// ---------------------------------------------------------------------------

const SAMPLE_PIPELINE = `issue_tracker: linear
agent_runner: claude-cli
default_models:
  developer: claude-opus-4-7
  reviewer: claude-sonnet-4-6
worktree_root: .pipeline-workspace/v2
`;

interface ConfigFixture {
    readonly configDir: string;
    cleanup(): void;
}

function makeConfigFixture(pipeline: string = SAMPLE_PIPELINE): ConfigFixture {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-api-parity-'));
    fs.writeFileSync(path.join(configDir, 'pipeline.yaml'), pipeline, 'utf8');
    return {
        configDir,
        cleanup: () => fs.rmSync(configDir, { recursive: true, force: true }),
    };
}

class SilentLogger implements Logger {
    info(): void {}
    warn(): void {}
    error(): void {}
    debug(): void {}
}

function fakeIdGen(prefix = 'gen'): IdGen {
    let n = 0;
    return { newId: (): string => `${prefix}-${++n}` };
}

function fixedClock(start = 1_700_000_000_000): () => number {
    let t = start;
    return (): number => t++;
}

/**
 * In-memory ConfigStore stub. The FsConfigStore is exercised in its own
 * suite; here we only need correct semantics for `get` / `upsert` plus
 * the `etag` round-trip so the route handler's translation surface is
 * the thing under test, not the adapter wiring.
 */
class MemoryConfigStore implements ConfigStore {
    private rows = new Map<string, ConfigRow>();
    private etagCounter = 0;

    private key(kind: ConfigRowKind, rowKey: string): string {
        return `${kind}::${rowKey}`;
    }

    get(kind: ConfigRowKind, rowKey: string): Promise<ConfigRow | null> {
        return Promise.resolve(this.rows.get(this.key(kind, rowKey)) ?? null);
    }

    upsert(spec: ConfigRowUpsert): Promise<ConfigRow> {
        const key = this.key(spec.kind, spec.rowKey);
        const existing = this.rows.get(key);
        if (existing && spec.etag !== undefined && existing.etag !== spec.etag) {
            return Promise.reject(
                new ConcurrencyError(
                    `etag mismatch for ${spec.kind}/${spec.rowKey}`,
                    existing.etag,
                ),
            );
        }
        if (existing && spec.etag === undefined) {
            return Promise.reject(
                new ConcurrencyError(
                    `row exists; etag required for ${spec.kind}/${spec.rowKey}`,
                    existing.etag,
                ),
            );
        }
        const next: ConfigRow = {
            kind: spec.kind,
            rowKey: spec.rowKey,
            body: spec.body,
            metadata: spec.metadata ?? {},
            etag: `etag-${++this.etagCounter}`,
            updatedAt: new Date(),
        };
        this.rows.set(key, next);
        return Promise.resolve(next);
    }

    delete(): Promise<void> {
        return Promise.resolve();
    }

    async *list(): AsyncIterable<ConfigRow> {
        // not exercised by these routes
    }

    /** Seed a row directly (skips concurrency); used by tests that need a pre-existing override. */
    seed(kind: ConfigRowKind, rowKey: string, body: string): ConfigRow {
        const row: ConfigRow = {
            kind,
            rowKey,
            body,
            metadata: {},
            etag: `etag-${++this.etagCounter}`,
            updatedAt: new Date(),
        };
        this.rows.set(this.key(kind, rowKey), row);
        return row;
    }
}

interface CommandHarness {
    readonly bus: CommandBus<unknown>;
    readonly recorded: StoredEvent[];
    readonly db: Db;
}

function freshDb(): Db {
    const db = openDatabase(':memory:');
    applyMigrations(db);
    return db;
}

function buildCommandHarness(): CommandHarness {
    const db = freshDb();
    const store = new EventStore(db);
    const events = new EventBus(store, new SilentLogger());
    const bus = new CommandBus<unknown>(events, () => undefined);
    const recorded: StoredEvent[] = [];
    events.subscribeAll((e) => {
        recorded.push(e);
    });
    const deps = {
        clock: fixedClock(),
        idGen: fakeIdGen(),
        runner: { kill: (): void => undefined },
        logger: new SilentLogger(),
    };
    registerBoardUiCommands(bus, deps);
    registerManagerApiCommands(bus, deps);
    return { bus, recorded, db };
}

// ---------------------------------------------------------------------------
// AC #3 + AC #4 + AC #5: static enums
// ---------------------------------------------------------------------------

test('GET /step-kinds returns the closed enum', () => {
    const res = getStepKinds();
    assert.equal(res.status, 200);
    const body = res.body as { step_kinds: string[] };
    assert.deepEqual(body.step_kinds, [...STEP_KINDS]);
    // Snapshot guard — drift here breaks the operator UI's step picker.
    assert.ok(body.step_kinds.includes('developer'));
    assert.ok(body.step_kinds.includes('wait-action'));
    assert.ok(body.step_kinds.includes('merge'));
});

test('GET /repo-tiers returns the documented closed enum', () => {
    const res = getRepoTiers();
    assert.equal(res.status, 200);
    const body = res.body as { repo_tiers: string[] };
    assert.deepEqual(
        body.repo_tiers.slice().sort(),
        ['api', 'app', 'frontend-lib', 'infra', 'shared'],
    );
    assert.deepEqual(body.repo_tiers, [...REPO_TIERS]);
});

test('GET /agent-providers returns the registered LLM providers', () => {
    const res = getAgentProviders();
    assert.equal(res.status, 200);
    const body = res.body as { providers: string[] };
    assert.deepEqual(body.providers, [...AGENT_PROVIDERS]);
    // The provider enum matches the orchestrator's real RunnerKinds so an
    // Agent's provider names a backend the role router can dispatch to.
    //
    // Checked against the shared registry, not three hand-written
    // `includes` calls: those pinned the names that already existed, so a
    // provider added to the orchestrator and forgotten in this host still
    // passed - the one direction the test was there to catch. The
    // orchestrator-side half of the agreement lives in
    // `hosts/orchestrator/provider-registry.test.ts`.
    assert.deepEqual(body.providers, [...SELECTABLE_AGENT_PROVIDER_IDS]);
});

// ---------------------------------------------------------------------------
// GET /agent-roles — role vocabulary + per-role fallback config (Phase 3)
// ---------------------------------------------------------------------------

interface AgentRolesFixture extends ConfigFixture {
    readonly agentsDir: string;
}

function makeAgentRolesFixture(personaRoles: readonly string[]): AgentRolesFixture {
    const fx = makeConfigFixture();
    const agentsDir = path.join(fx.configDir, 'agents');
    fs.mkdirSync(agentsDir);
    for (const role of personaRoles) {
        fs.writeFileSync(path.join(agentsDir, `${role}.CLAUDE.md`), `# ${role}\n`, 'utf8');
    }
    return { ...fx, agentsDir };
}

test('GET /agent-roles returns the union of default_models keys and persona files, sorted', () => {
    const fx = makeAgentRolesFixture(['architect', 'developer', 'doc-writer']);
    try {
        const res = getAgentRoles({ configDir: fx.configDir, agentsDir: fx.agentsDir, env: {} });
        assert.equal(res.status, 200);
        const body = res.body as {
            roles: Array<{ role: string; defaultModel: string | null; personaFile: boolean }>;
        };
        assert.deepEqual(
            body.roles.map((r) => r.role),
            ['architect', 'developer', 'doc-writer', 'reviewer'],
        );
        const byRole = new Map(body.roles.map((r) => [r.role, r]));
        // developer is in BOTH sources: pipeline default + persona file.
        assert.equal(byRole.get('developer')!.defaultModel, 'claude-opus-4-7');
        assert.equal(byRole.get('developer')!.personaFile, true);
        // architect only has a persona file.
        assert.equal(byRole.get('architect')!.defaultModel, null);
        assert.equal(byRole.get('architect')!.personaFile, true);
        // reviewer only appears in default_models.
        assert.equal(byRole.get('reviewer')!.defaultModel, 'claude-sonnet-4-6');
        assert.equal(byRole.get('reviewer')!.personaFile, false);
    } finally {
        fx.cleanup();
    }
});

test('GET /agent-roles surfaces env fallbacks with the orchestrator role→env-var mapping', () => {
    const fx = makeAgentRolesFixture(['doc-writer']);
    try {
        const res = getAgentRoles({
            configDir: fx.configDir,
            agentsDir: fx.agentsDir,
            env: {
                // hyphens are PRESERVED in the env key (role.toUpperCase()),
                // mirroring the orchestrator's readRoleAdapterOverrides.
                'AGENT_RUNNER_DOC-WRITER': 'deepseek',
                AGENT_RUNNER_DEVELOPER: 'not-a-runner', // unrecognised → ignored
                // the orchestrator lowercases the SUFFIX of any AGENT_RUNNER_*
                // key, so non-uppercase keys and out-of-vocabulary roles are
                // honoured at runtime — the endpoint must surface them too.
                AGENT_RUNNER_tester: 'cursor-cli',
                'AGENT_RUNNER_SECURITY-AUDITOR': 'cursor-cli',
                AGENT_RUNNER: 'claude-cli',
                'CLAUDE_MODEL_DOC-WRITER': 'deepseek-chat-v4',
            },
        });
        assert.equal(res.status, 200);
        const body = res.body as {
            roles: Array<{
                role: string;
                envProvider: string | null;
                envModel: string | null;
            }>;
            envProviders: Record<string, string>;
            envModels: Record<string, string>;
            envModel: string | null;
            fallbackProvider: string;
            fallbackModel: string | null;
        };
        const byRole = new Map(body.roles.map((r) => [r.role, r]));
        assert.equal(byRole.get('doc-writer')!.envProvider, 'deepseek');
        assert.equal(byRole.get('doc-writer')!.envModel, 'deepseek-chat-v4');
        assert.equal(byRole.get('developer')!.envProvider, null, 'unrecognised kind ignored');
        assert.equal(byRole.get('developer')!.envModel, null);
        // Top-level maps cover roles OUTSIDE the vocabulary (agent-record-only
        // roles) and mirror the orchestrator's scan-and-lowercase mapping.
        assert.equal(body.envProviders['security-auditor'], 'cursor-cli');
        assert.equal(body.envProviders['tester'], 'cursor-cli', 'lowercase env key honoured');
        assert.equal(body.envModels['DOC-WRITER'], 'deepseek-chat-v4');
        assert.equal(body.envModel, null);
        assert.equal(body.fallbackProvider, 'claude-cli');
        assert.equal(body.fallbackModel, 'claude-opus-4-7', 'default_models.developer');
    } finally {
        fx.cleanup();
    }
});

test('GET /agent-roles degrades to default_models keys when the agents dir is missing', () => {
    const fx = makeConfigFixture();
    try {
        const res = getAgentRoles({
            configDir: fx.configDir,
            agentsDir: path.join(fx.configDir, 'no-such-dir'),
            env: {},
        });
        assert.equal(res.status, 200);
        const body = res.body as { roles: Array<{ role: string; personaFile: boolean }> };
        assert.deepEqual(
            body.roles.map((r) => r.role),
            ['developer', 'reviewer'],
        );
        assert.ok(body.roles.every((r) => r.personaFile === false));
    } finally {
        fx.cleanup();
    }
});

test('GET /agent-roles falls back to fake when AGENT_RUNNER is unset (orchestrator default)', () => {
    const fx = makeAgentRolesFixture([]);
    try {
        const res = getAgentRoles({ configDir: fx.configDir, agentsDir: fx.agentsDir, env: {} });
        const body = res.body as { fallbackProvider: string };
        assert.equal(body.fallbackProvider, 'fake');
    } finally {
        fx.cleanup();
    }
});

// ---------------------------------------------------------------------------
// AC #1: GET /agent-models/:role returns the current override or the default
// ---------------------------------------------------------------------------

test('GET /agent-models/:role falls back to default_models when no override is set', async () => {
    const fx = makeConfigFixture();
    try {
        const store = new MemoryConfigStore();
        const res = await getAgentModel(
            { configDir: fx.configDir, configStore: store },
            'developer',
        );
        assert.equal(res.status, 200);
        assert.deepEqual(res.body, {
            role: 'developer',
            model: 'claude-opus-4-7',
            source: 'default',
        });
    } finally {
        fx.cleanup();
    }
});

test('GET /agent-models/:role returns the override when the state port has one', async () => {
    const fx = makeConfigFixture();
    try {
        const store = new MemoryConfigStore();
        const seeded = store.seed(
            'AgentModels',
            'developer',
            JSON.stringify({ model: 'claude-haiku-4-5' }),
        );
        const res = await getAgentModel(
            { configDir: fx.configDir, configStore: store },
            'developer',
        );
        assert.equal(res.status, 200);
        assert.deepEqual(res.body, {
            role: 'developer',
            model: 'claude-haiku-4-5',
            source: 'override',
            etag: seeded.etag,
        });
    } finally {
        fx.cleanup();
    }
});

test('GET /agent-models/:role tolerates a legacy plain-string row body', async () => {
    const fx = makeConfigFixture();
    try {
        const store = new MemoryConfigStore();
        store.seed('AgentModels', 'reviewer', 'claude-opus-4-7');
        const res = await getAgentModel(
            { configDir: fx.configDir, configStore: store },
            'reviewer',
        );
        const body = res.body as { model: string; source: string };
        assert.equal(body.model, 'claude-opus-4-7');
        assert.equal(body.source, 'override');
    } finally {
        fx.cleanup();
    }
});

test('GET /agent-models/:role returns model: null when neither override nor default exists', async () => {
    const fx = makeConfigFixture();
    try {
        const store = new MemoryConfigStore();
        const res = await getAgentModel(
            { configDir: fx.configDir, configStore: store },
            'never-heard-of-this-role',
        );
        assert.equal(res.status, 200);
        assert.deepEqual(res.body, {
            role: 'never-heard-of-this-role',
            model: null,
            source: 'unset',
        });
    } finally {
        fx.cleanup();
    }
});

test('GET /agent-models/:role with a disallowed role name returns 404', async () => {
    const fx = makeConfigFixture();
    try {
        const store = new MemoryConfigStore();
        const res = await getAgentModel(
            { configDir: fx.configDir, configStore: store },
            '../etc/passwd',
        );
        assert.equal(res.status, 404);
    } finally {
        fx.cleanup();
    }
});

// ---------------------------------------------------------------------------
// AC #2: PUT /agent-models/:role persists the override via state port
// ---------------------------------------------------------------------------

test('PUT /agent-models/:role persists the override and the next GET reflects it', async () => {
    const fx = makeConfigFixture();
    try {
        const store = new MemoryConfigStore();
        const put = await putAgentModel(
            { configDir: fx.configDir, configStore: store },
            'developer',
            JSON.stringify({ model: 'claude-haiku-4-5' }),
            'application/json',
        );
        assert.equal(put.status, 200);
        const putBody = put.body as { role: string; model: string; source: string; etag: string };
        assert.equal(putBody.model, 'claude-haiku-4-5');
        assert.equal(putBody.source, 'override');
        assert.ok(putBody.etag.length > 0);

        const get = await getAgentModel(
            { configDir: fx.configDir, configStore: store },
            'developer',
        );
        const getBody = get.body as { model: string; source: string };
        assert.equal(getBody.model, 'claude-haiku-4-5');
        assert.equal(getBody.source, 'override');
    } finally {
        fx.cleanup();
    }
});

test('PUT /agent-models/:role rejects a missing model field with 422', async () => {
    const fx = makeConfigFixture();
    try {
        const store = new MemoryConfigStore();
        const res = await putAgentModel(
            { configDir: fx.configDir, configStore: store },
            'developer',
            JSON.stringify({}),
            'application/json',
        );
        assert.equal(res.status, 422);
    } finally {
        fx.cleanup();
    }
});

test('PUT /agent-models/:role with the wrong Content-Type returns 415', async () => {
    const fx = makeConfigFixture();
    try {
        const store = new MemoryConfigStore();
        const res = await putAgentModel(
            { configDir: fx.configDir, configStore: store },
            'developer',
            JSON.stringify({ model: 'x' }),
            'text/yaml',
        );
        assert.equal(res.status, 415);
    } finally {
        fx.cleanup();
    }
});

test('PUT /agent-models/:role surfaces ConcurrencyError as HTTP 409', async () => {
    const fx = makeConfigFixture();
    try {
        const store = new MemoryConfigStore();
        const seeded = store.seed(
            'AgentModels',
            'developer',
            JSON.stringify({ model: 'claude-opus-4-7' }),
        );
        const res = await putAgentModel(
            { configDir: fx.configDir, configStore: store },
            'developer',
            JSON.stringify({ model: 'claude-haiku-4-5', etag: 'stale' }),
            'application/json',
        );
        assert.equal(res.status, 409);
        const body = res.body as { conflictingEtag: string };
        assert.equal(body.conflictingEtag, seeded.etag);
    } finally {
        fx.cleanup();
    }
});

// ---------------------------------------------------------------------------
// AC #6: Projects CRUD delegates to AP-IFG-008 commands
// ---------------------------------------------------------------------------

test('POST /projects emits ProjectCreated via the board-ui CreateProject command', async () => {
    const h = buildCommandHarness();
    const res = await postProject(
        { commandBus: h.bus, clock: () => 1, actor: 'op' },
        JSON.stringify({ name: 'Demo', description: 'd' }),
        'application/json',
    );
    assert.equal(res.status, 202);
    const created = h.recorded.find((e) => e.type === BoardUiEvents.PROJECT_CREATED);
    assert.ok(created, 'expected ProjectCreated event');
    const payload = created!.payload as ProjectCreatedPayload;
    assert.equal(payload.name, 'Demo');
    assert.equal(payload.actor, 'op');
});

test('PUT /projects/:projectId emits ProjectUpdated with the URL projectId merged in', async () => {
    const h = buildCommandHarness();
    const res = await putProject(
        { commandBus: h.bus, clock: () => 2, actor: 'op' },
        'proj-7',
        JSON.stringify({ description: 'renamed' }),
        'application/json',
    );
    assert.equal(res.status, 202);
    const updated = h.recorded.find((e) => e.type === BoardUiEvents.PROJECT_UPDATED);
    assert.ok(updated, 'expected ProjectUpdated event');
    const payload = updated!.payload as ProjectUpdatedPayload;
    assert.equal(payload.projectId, 'proj-7');
    assert.equal(payload.description, 'renamed');
});

test('DELETE /projects/:projectId emits ProjectArchived (v1 never hard-deleted)', async () => {
    const h = buildCommandHarness();
    const res = await deleteProject(
        { commandBus: h.bus, clock: () => 3, actor: 'op' },
        'proj-9',
    );
    assert.equal(res.status, 202);
    const archived = h.recorded.find((e) => e.type === BoardUiEvents.PROJECT_ARCHIVED);
    assert.ok(archived, 'expected ProjectArchived event');
    const payload = archived!.payload as ProjectArchivedPayload;
    assert.equal(payload.projectId, 'proj-9');
});

test('POST /projects rejects malformed JSON with 422', async () => {
    const h = buildCommandHarness();
    const res = await postProject(
        { commandBus: h.bus, clock: () => 1, actor: 'op' },
        'not-json',
        'application/json',
    );
    assert.equal(res.status, 422);
});

// ---------------------------------------------------------------------------
// AC #7: Agents CRUD emits AgentCreated / AgentUpdated / AgentDeleted
// ---------------------------------------------------------------------------

test('POST /agents emits AgentCreated through the new CreateAgent command', async () => {
    const h = buildCommandHarness();
    const res = await postAgent(
        { commandBus: h.bus, clock: () => 1, actor: 'op' },
        JSON.stringify({
            name: 'docs-bot',
            role: 'doc-writer',
            provider: 'claude-cli',
            model: 'claude-sonnet-4-6',
        }),
        'application/json',
    );
    assert.equal(res.status, 202);
    const created = h.recorded.find((e) => e.type === ManagerApiEvents.AGENT_CREATED);
    assert.ok(created, 'expected AgentCreated event');
    const payload = created!.payload as AgentCreatedPayload;
    assert.equal(payload.agentId, 'gen-1');
    assert.equal(payload.name, 'docs-bot');
    assert.equal(payload.role, 'doc-writer');
    assert.equal(payload.provider, 'claude-cli');
    assert.equal(payload.model, 'claude-sonnet-4-6');
    assert.equal(payload.actor, 'op');
    assert.equal(created!.idempotencyKey, 'CreateAgent:gen-1');
});

test('POST /agents rejects an unknown provider with 422', async () => {
    const h = buildCommandHarness();
    const res = await postAgent(
        { commandBus: h.bus, clock: () => 1, actor: 'op' },
        JSON.stringify({
            name: 'x',
            role: 'developer',
            provider: 'openai',
            model: 'gpt-4',
        }),
        'application/json',
    );
    assert.equal(res.status, 422);
    const cancelled = h.recorded.filter((e) => e.type === ManagerApiEvents.AGENT_CREATED);
    assert.equal(cancelled.length, 0);
});

test('PUT /agents/:agentId emits AgentUpdated and merges the URL agentId in', async () => {
    const h = buildCommandHarness();
    const res = await putAgent(
        { commandBus: h.bus, clock: () => 1, actor: 'op' },
        'a-1',
        JSON.stringify({ model: 'claude-haiku-4-5' }),
        'application/json',
    );
    assert.equal(res.status, 202);
    const updated = h.recorded.find((e) => e.type === ManagerApiEvents.AGENT_UPDATED);
    assert.ok(updated, 'expected AgentUpdated event');
    const payload = updated!.payload as AgentUpdatedPayload;
    assert.equal(payload.agentId, 'a-1');
    assert.equal(payload.model, 'claude-haiku-4-5');
    // unspecified fields must NOT appear in the event payload — subscribers
    // rely on `'name' in payload` as the "field is set" signal.
    assert.equal(Object.prototype.hasOwnProperty.call(payload, 'name'), false);
});

test('DELETE /agents/:agentId emits AgentDeleted with a deterministic idempotency key', async () => {
    const h = buildCommandHarness();
    const res = await deleteAgent(
        { commandBus: h.bus, clock: () => 1, actor: 'op' },
        'a-9',
    );
    assert.equal(res.status, 202);
    const deleted = h.recorded.find((e) => e.type === ManagerApiEvents.AGENT_DELETED);
    assert.ok(deleted, 'expected AgentDeleted event');
    const payload = deleted!.payload as AgentDeletedPayload;
    assert.equal(payload.agentId, 'a-9');
    assert.equal(deleted!.idempotencyKey, 'DeleteAgent:a-9');
});

test('duplicate DELETE /agents/:agentId collapses to the same stored seq (idempotent)', async () => {
    const h = buildCommandHarness();
    const a = await deleteAgent({ commandBus: h.bus, clock: () => 1, actor: 'op' }, 'a-dup');
    const b = await deleteAgent({ commandBus: h.bus, clock: () => 2, actor: 'op' }, 'a-dup');
    assert.equal(a.status, 202);
    assert.equal(b.status, 202);
    // The EventStore UNIQUE constraint on idempotency_key returns the
    // original seq on the second append, so the second send sees the
    // same seq the first one did.
    const deleted = h.recorded.filter((e) => e.type === ManagerApiEvents.AGENT_DELETED);
    assert.equal(deleted.length, 2, 'subscribeAll fires per publish regardless of dedup');
    assert.equal(deleted[0].seq, deleted[1].seq, 'event store de-duped by idempotency key');
});

// ---------------------------------------------------------------------------
// Validator snapshot guards — caught by board-ui in code review when these
// drift, so we pin them here to surface drift in this module's own suite.
// ---------------------------------------------------------------------------

test('isCreateAgentPayload accepts a complete payload', () => {
    assert.equal(
        isCreateAgentPayload({
            name: 'x',
            role: 'developer',
            provider: 'claude-cli',
            model: 'claude-opus-4-7',
        }),
        true,
    );
});

test('isCreateAgentPayload rejects an unknown provider', () => {
    assert.equal(
        isCreateAgentPayload({
            name: 'x',
            role: 'developer',
            provider: 'unknown',
            model: 'x',
        }),
        false,
    );
});

test('isCreateAgentPayload accepts inherit semantics — no model, empty provider (Option B)', () => {
    // model/provider absent or '' = "no override": the resolver falls
    // through to pipeline default_models / AGENT_RUNNER_<ROLE>.
    assert.equal(isCreateAgentPayload({ name: 'x', role: 'developer' }), true);
    assert.equal(
        isCreateAgentPayload({ name: 'x', role: 'developer', provider: '', model: '' }),
        true,
    );
});

test('isUpdateAgentPayload accepts an empty provider (clears the override)', () => {
    assert.equal(isUpdateAgentPayload({ agentId: 'a', provider: '' }), true);
    assert.equal(isUpdateAgentPayload({ agentId: 'a', provider: 'openai' }), false);
});

test('POST /agents with inherit fields emits AgentCreated carrying the empty markers', async () => {
    const h = buildCommandHarness();
    const res = await postAgent(
        { commandBus: h.bus, clock: () => 1, actor: 'op' },
        JSON.stringify({ name: 'dev', role: 'developer', provider: '', model: '', prompt: '' }),
        'application/json',
    );
    assert.equal(res.status, 202);
    const created = h.recorded.find((e) => e.type === ManagerApiEvents.AGENT_CREATED);
    assert.ok(created, 'expected AgentCreated event');
    const payload = created!.payload as AgentCreatedPayload;
    // '' survives into the event (only undefined is compacted away): the
    // projection stores it and the orchestrator resolver treats '' as
    // "no override" at every consumption site.
    assert.equal(payload.provider, '');
    assert.equal(payload.model, '');
});

test('isUpdateAgentPayload requires agentId', () => {
    assert.equal(isUpdateAgentPayload({ name: 'x' }), false);
    assert.equal(isUpdateAgentPayload({ agentId: 'a', name: 'x' }), true);
});

test('isDeleteAgentPayload requires agentId', () => {
    assert.equal(isDeleteAgentPayload({}), false);
    assert.equal(isDeleteAgentPayload({ agentId: 'a' }), true);
});

test('ManagerApiCommands exposes all three command types', () => {
    assert.deepEqual(
        new Set(Object.values(ManagerApiCommands)),
        new Set(['CreateAgent', 'UpdateAgent', 'DeleteAgent']),
    );
});

// ---------------------------------------------------------------------------
// Phase 5 — Settings routes (secrets write-only) + project-file seeding
// ---------------------------------------------------------------------------

function makeSettingsStore(): { store: FsConfigStore; cleanup(): void } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-api-settings-'));
    return {
        store: new FsConfigStore({ backendKind: 'fs', tenant: 'test', fsRootPath: dir }),
        cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
    };
}

test('GET /settings lists the curated registry with sources and NEVER echoes secret values', async () => {
    const { store, cleanup } = makeSettingsStore();
    try {
        await store.upsert({
            kind: 'Settings',
            rowKey: 'LINEAR_API_KEY',
            body: 'lin_secret_stored',
            metadata: {},
        });
        const res = await getSettings({
            configStore: store,
            env: { GIT_COMMIT_NAME: 'Env Bot', JIRA_API_TOKEN: 'jira_secret_env' },
        });
        assert.equal(res.status, 200);
        const body = res.body as {
            settings: Array<{
                key: string;
                secret: boolean;
                source: string;
                set: boolean;
                value?: string | null;
                etag?: string;
            }>;
        };
        const byKey = new Map(body.settings.map((s) => [s.key, s]));

        const linear = byKey.get('LINEAR_API_KEY')!;
        assert.equal(linear.source, 'override');
        assert.equal(linear.set, true);
        assert.equal('value' in linear, false, 'secret value must not be echoed');
        assert.ok(linear.etag, 'override rows carry an etag for concurrency');

        const jira = byKey.get('JIRA_API_TOKEN')!;
        assert.equal(jira.source, 'env');
        assert.equal('value' in jira, false, 'env-provided secrets not echoed either');

        const gitName = byKey.get('GIT_COMMIT_NAME')!;
        assert.equal(gitName.source, 'env');
        assert.equal(gitName.value, 'Env Bot', 'non-secrets show their value');

        const unset = byKey.get('DEEPSEEK_API_KEY')!;
        assert.equal(unset.source, 'unset');
        assert.equal(unset.set, false);

        // Belt-and-braces: no secret material anywhere in the response.
        const serialized = JSON.stringify(res.body);
        assert.ok(!serialized.includes('lin_secret_stored'));
        assert.ok(!serialized.includes('jira_secret_env'));
    } finally {
        cleanup();
    }
});

test('PUT /settings/:key stores a value; secrets are not echoed back; unknown keys 404', async () => {
    const { store, cleanup } = makeSettingsStore();
    try {
        const secret = await putSetting(
            { configStore: store, env: {} },
            'DEEPSEEK_API_KEY',
            JSON.stringify({ value: 'ds_secret_value' }),
            'application/json',
        );
        assert.equal(secret.status, 200);
        const secretBody = secret.body as { key: string; source: string; value?: string };
        assert.equal(secretBody.source, 'override');
        assert.equal('value' in secretBody, false, 'secret PUT response omits the value');
        const row = await store.get('Settings', 'DEEPSEEK_API_KEY');
        assert.equal(row?.body, 'ds_secret_value');

        const plain = await putSetting(
            { configStore: store, env: {} },
            'GIT_COMMIT_NAME',
            JSON.stringify({ value: 'Pipeline Bot' }),
            'application/json',
        );
        assert.equal((plain.body as { value?: string }).value, 'Pipeline Bot');

        // Bootstrap-only keys are NOT writable — 404, nothing stored.
        const forbidden = await putSetting(
            { configStore: store, env: {} },
            'WORKER_API_TOKEN_V2',
            JSON.stringify({ value: 'nope' }),
            'application/json',
        );
        assert.equal(forbidden.status, 404);
        assert.equal(await store.get('Settings', 'WORKER_API_TOKEN_V2'), null);

        // Empty value is a 422 (DELETE is the way to clear).
        const empty = await putSetting(
            { configStore: store, env: {} },
            'GIT_COMMIT_NAME',
            JSON.stringify({ value: '' }),
            'application/json',
        );
        assert.equal(empty.status, 422);
    } finally {
        cleanup();
    }
});

test('DELETE /settings/:key removes the override and reports the post-delete source', async () => {
    const { store, cleanup } = makeSettingsStore();
    try {
        await store.upsert({
            kind: 'Settings',
            rowKey: 'GIT_COMMIT_NAME',
            body: 'Stored Bot',
            metadata: {},
        });
        const res = await deleteSetting(
            { configStore: store, env: { GIT_COMMIT_NAME: 'Env Bot' } },
            'GIT_COMMIT_NAME',
        );
        assert.equal(res.status, 200);
        assert.equal((res.body as { source: string }).source, 'env');
        assert.equal(await store.get('Settings', 'GIT_COMMIT_NAME'), null);

        // Idempotent: no override left -> still 200, source reflects reality.
        const again = await deleteSetting({ configStore: store, env: {} }, 'GIT_COMMIT_NAME');
        assert.equal(again.status, 200);
        assert.equal((again.body as { source: string }).source, 'unset');
    } finally {
        cleanup();
    }
});

// (Removed: the four project-file seeding tests.)
//
// `seedProjectFile` wrote `config/projects/<id>/project.json` for the
// file-based registry. Project configuration is worker state now — it
// lives on the `projects` row, the registry reads that row, and the
// files are gone. There is nothing left to seed, merge-update, or
// traversal-guard on that path.
