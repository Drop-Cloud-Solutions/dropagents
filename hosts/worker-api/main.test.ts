/**
 * AP-VP7-004 — integration test for the worker-api composition root.
 *
 * Boots the host end-to-end against an in-memory orchestrator, seeds an
 * event into the log + a row into the parked-tasks projection, and asserts
 * that `GET /health` returns the full AP-VP7-003 body shape with values
 * sourced from the wired HealthSignals readers (adapters from pipeline.yaml,
 * lastEventAt from the events table, parkedTasks from
 * `parked_tasks_projection`). One additional case exercises the
 * `healthSignals` injection seam to confirm the readers are routed end-to-end
 * — a regression on either the wiring or the body shape would fail this.
 */

import { test as nodeTest } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Dual-runner test registration — see hosts/worker-api/health.test.ts for
// the same shim. Vitest puts `test` on globalThis; `node --test` exports
// it from `node:test`.
type TestFn = (name: string, fn: () => void | Promise<void>) => void;
const test: TestFn = (globalThis as { test?: TestFn }).test ?? nodeTest;

import Database from 'better-sqlite3';

import type { Logger } from '../../core/ports/Logger';
import type { Db } from '../../core/state/migrations';
import { FakeChatGateway } from '../../adapters/fakes/FakeChatGateway';

import {
    start,
    selectAndStartChatGateway,
    makeResolvePrNumber,
    type ChatGatewaySelection,
    type HealthSignals,
    type StartableChatGateway,
    type WorkerApiHandle,
} from './main';
import type { HealthCheckBody } from './health';
import { activateProfile } from '../../config/profile';

/** Hermetic chat-gateway selection injected into boot tests so an ambient
 *  TELEGRAM_BOT_TOKEN can never start a real long-poll loop. */
function fakeChatGatewaySelection(): ChatGatewaySelection {
    return {
        kind: 'fake',
        gateway: new FakeChatGateway(),
        started: false,
        stop: async (): Promise<void> => {},
    };
}

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FLOWS_DIR = path.join(REPO_ROOT, 'config', 'flows');

class SilentLogger implements Logger {
    info(): void {}
    warn(): void {}
    error(): void {}
    debug(): void {}
}

interface HostFixture {
    readonly handle: WorkerApiHandle;
    readonly tempDir: string;
    close(): Promise<void>;
}

/**
 * Spin up a worker-api host bound to a random port against an in-memory
 * orchestrator DB. Writes a minimal pipeline.yaml into `tempDir` so the
 * /health adapters reader has a real file to load — without it the host
 * would log a warning and report an empty adapters map, masking the
 * wiring we want to exercise.
 */
async function bootHost(args: {
    pipelineYaml: string;
    healthSignals?: HealthSignals;
}): Promise<HostFixture> {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-api-test-'));
    const yamlPath = path.join(tempDir, 'pipeline.yaml');
    fs.writeFileSync(yamlPath, args.pipelineYaml, 'utf8');

    const logger = new SilentLogger();
    const handle = await start({
        port: 0,
        host: '127.0.0.1',
        logger,
        pipelineConfigPath: yamlPath,
        // Keep boot hermetic: never construct/start a real TelegramGateway even
        // when this machine has TELEGRAM_BOT_TOKEN set and the yaml says
        // `chat_gateway: telegram`. Selection-logic branches are covered by the
        // dedicated unit tests below.
        chatGatewaySelection: fakeChatGatewaySelection(),
        ...(args.healthSignals !== undefined
            ? { healthSignals: args.healthSignals }
            : {}),
        orchestrator: {
            dbPath: ':memory:',
            flowsDir: FLOWS_DIR,
            pipelineConfigPath: yamlPath,
            logger,
        },
    });

    return {
        handle,
        tempDir,
        async close(): Promise<void> {
            await handle.stop();
            fs.rmSync(tempDir, { recursive: true, force: true });
        },
    };
}

function insertEvent(
    handle: WorkerApiHandle,
    occurredAtMs: number,
    idempotencyKey: string,
): void {
    handle.orchestrator
        .getDb()
        .prepare(
            `INSERT INTO events(type, v, occurred_at, idempotency_key, payload)
             VALUES ('Test', 1, ?, ?, '{}')`,
        )
        .run(occurredAtMs, idempotencyKey);
}

function insertParkedTask(
    handle: WorkerApiHandle,
    taskId: string,
    parkedAtMs: number,
): void {
    handle.orchestrator
        .getDb()
        .prepare(
            `INSERT INTO parked_tasks_projection(task_id, plan_id, parked_at, reason)
             VALUES (?, NULL, ?, 'test')`,
        )
        .run(taskId, parkedAtMs);
}

test('AP-VP7-004: GET /health returns the wired HealthSignals body (AC #1–#4, #6)', async () => {
    // Two events: lastEventAt must reflect the later occurredAt.
    const earlyTs = Date.UTC(2026, 4, 18, 8, 0, 0); // 2026-05-18T08:00:00Z
    const laterTs = Date.UTC(2026, 4, 18, 9, 30, 0); // 2026-05-18T09:30:00Z

    const fx = await bootHost({
        pipelineYaml: [
            'issue_tracker: linear',
            'agent_runner: claude-cli',
            'source_control: git-cli',
            'chat_gateway: telegram',
            'issue_tracker_shadow: none',
            '',
        ].join('\n'),
    });
    try {
        insertEvent(fx.handle, earlyTs, 'evt-early');
        insertEvent(fx.handle, laterTs, 'evt-late');
        insertParkedTask(fx.handle, 'task-A', laterTs);
        insertParkedTask(fx.handle, 'task-B', laterTs);

        const res = await fetch(`http://127.0.0.1:${fx.handle.port}/health`);
        assert.equal(res.status, 200, 'health route must respond 200');
        const body = (await res.json()) as HealthCheckBody;

        assert.equal(body.ok, true);
        assert.equal(typeof body.uptime, 'number');

        // AC #2 — adapters reader returns { wired: true } for every non-fake
        // adapter named by pipeline.yaml.
        assert.deepEqual(body.adapters, {
            issue_tracker: { wired: true },
            agent_runner: { wired: true },
            source_control: { wired: true },
            chat_gateway: { wired: true },
        });

        // AC #3 — lastEventAt is the MAX(seq).ts row as ISO-8601.
        assert.equal(body.lastEventAt, new Date(laterTs).toISOString());

        // AC #4 — parkedTasks delegates to getParkedTaskCount().
        assert.equal(body.parkedTasks, 2);

        // Sanity: none of the readers reported degraded.
        assert.deepEqual(body.degraded, {
            adapters: false,
            lastEventAt: false,
            parkedTasks: false,
        });
    } finally {
        await fx.close();
    }
});

test('AP-VP7-004: lastEventAt is null when the events table is empty (AC #3)', async () => {
    const fx = await bootHost({
        pipelineYaml: 'issue_tracker: linear\n',
    });
    try {
        const res = await fetch(`http://127.0.0.1:${fx.handle.port}/health`);
        const body = (await res.json()) as HealthCheckBody;
        assert.equal(body.lastEventAt, null);
        assert.equal(body.parkedTasks, 0);
    } finally {
        await fx.close();
    }
});

test('AP-VP7-004: fake-marked adapters drop out of the wired map (AC #2)', async () => {
    const fx = await bootHost({
        pipelineYaml: [
            'issue_tracker: linear',
            'agent_runner: fake',
            // source_control + chat_gateway omitted entirely — equivalent to fake.
            'issue_tracker_shadow: none',
            '',
        ].join('\n'),
    });
    try {
        const res = await fetch(`http://127.0.0.1:${fx.handle.port}/health`);
        const body = (await res.json()) as HealthCheckBody;
        assert.deepEqual(body.adapters, { issue_tracker: { wired: true } });
    } finally {
        await fx.close();
    }
});

test('AP-VP7-004: healthSignals seam routes readers end-to-end (AC #5 — no module state)', async () => {
    // Distinct readers, distinct return values — proves the host hands the
    // exact aggregate it was given to createWorkerApiHealthCheck rather than
    // reaching for a shared singleton.
    let adaptersCalls = 0;
    let parkedCalls = 0;
    const signals: HealthSignals = {
        getAdapterStatuses: (): Record<string, { wired: boolean }> => {
            adaptersCalls++;
            return { 'unit-test-adapter': { wired: true } };
        },
        getLastEventAt: (): string => '2026-05-18T12:34:56.000Z',
        getParkedTaskCount: (): number => {
            parkedCalls++;
            return 42;
        },
    };

    const fx = await bootHost({
        pipelineYaml: 'issue_tracker: linear\n', // not consulted — signals override
        healthSignals: signals,
    });
    try {
        const res = await fetch(`http://127.0.0.1:${fx.handle.port}/health`);
        const body = (await res.json()) as HealthCheckBody;
        assert.deepEqual(body.adapters, {
            'unit-test-adapter': { wired: true },
        });
        assert.equal(body.lastEventAt, '2026-05-18T12:34:56.000Z');
        assert.equal(body.parkedTasks, 42);
        assert.ok(adaptersCalls >= 1, 'adapters reader must have fired');
        assert.ok(parkedCalls >= 1, 'parkedTasks reader must have fired');
    } finally {
        await fx.close();
    }
});

// ---------------------------------------------------------------------------
// P-CPTO-011 — chat-gateway selection logic
// ---------------------------------------------------------------------------

/** Logger that captures warn() messages so the missing-token branch can assert
 *  a visible warning was emitted (and that it names only the key). */
class WarnCapturingLogger implements Logger {
    readonly warnings: string[] = [];
    info(): void {}
    warn(message: string): void {
        this.warnings.push(message);
    }
    error(): void {}
    debug(): void {}
}

/** Startable gateway double recording build + start + stop. */
function recordingGateway(): StartableChatGateway & {
    starts: number;
    stops: number;
} {
    const rec = {
        starts: 0,
        stops: 0,
        async notify(): Promise<void> {},
        async start(): Promise<void> {
            rec.starts++;
        },
        async stop(): Promise<void> {
            rec.stops++;
        },
    };
    return rec;
}

test('P-CPTO-011: chat_gateway=telegram + token constructs and starts the gateway', async () => {
    const gateway = recordingGateway();
    let built = 0;
    const logger = new SilentLogger();

    const selection = await selectAndStartChatGateway({
        chatGatewayName: 'telegram',
        tokenPresent: true,
        logger,
        buildTelegramGateway: (): StartableChatGateway => {
            built++;
            return gateway;
        },
    });

    assert.equal(selection.kind, 'telegram');
    assert.equal(selection.started, true);
    assert.equal(built, 1, 'the gateway must be constructed exactly once');
    assert.equal(gateway.starts, 1, 'start() must have fired');
    assert.equal(selection.gateway, gateway, 'the selected gateway is the built one');

    await selection.stop();
    assert.equal(gateway.stops, 1, 'stop() routes through to the gateway');
});

test('P-CPTO-011: chat_gateway=telegram WITHOUT token warns and falls back to fake', async () => {
    const logger = new WarnCapturingLogger();
    let built = 0;

    const selection = await selectAndStartChatGateway({
        chatGatewayName: 'telegram',
        tokenPresent: false,
        logger,
        buildTelegramGateway: (): StartableChatGateway => {
            built++;
            throw new Error('the token-less telegram path must not build a gateway');
        },
    });

    assert.equal(selection.kind, 'fake');
    assert.equal(selection.started, false);
    assert.equal(built, 0, 'no gateway may be constructed without a token');
    assert.equal(logger.warnings.length, 1, 'the missing token must surface a warning');
    assert.match(
        logger.warnings[0],
        /TELEGRAM_BOT_TOKEN/,
        'the warning names the env key so the operator knows what to set',
    );
    // Secret hygiene: the warning names the key only, never a token VALUE.
    assert.doesNotMatch(logger.warnings[0], /TELEGRAM_BOT_TOKEN[=:]\S/);

    // The fallback fake still satisfies the ChatGateway port (no-op notify).
    await selection.gateway.notify('123', 'hi');
    await selection.stop();
});

test('P-CPTO-011: default (non-telegram) chat_gateway selects the fake, dark', async () => {
    const logger = new SilentLogger();
    let built = 0;

    for (const name of ['fake', 'slack', undefined, 42]) {
        const selection = await selectAndStartChatGateway({
            chatGatewayName: name,
            // Token present but the selection isn't telegram — must stay fake.
            tokenPresent: true,
            logger,
            buildTelegramGateway: (): StartableChatGateway => {
                built++;
                throw new Error('non-telegram selection must not build a gateway');
            },
        });
        assert.equal(selection.kind, 'fake', `chat_gateway=${String(name)} → fake`);
        assert.equal(selection.started, false);
        await selection.stop();
    }
    assert.equal(built, 0, 'the default path never constructs a Telegram gateway');
});

test('P-CPTO-011: makeResolvePrNumber reads task_worktrees.pr_number', () => {
    const db = new Database(':memory:') as unknown as Db;
    db.exec(`
        CREATE TABLE task_worktrees (
            task_id    TEXT NOT NULL PRIMARY KEY,
            repo_id    TEXT NOT NULL,
            branch     TEXT NOT NULL,
            path       TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            pushed_at  INTEGER,
            pr_url     TEXT,
            pr_number  INTEGER
        );
    `);
    db.prepare(
        `INSERT INTO task_worktrees(task_id, repo_id, branch, path, created_at, pr_number)
         VALUES (?, 'repo-1', 'task/t-1', '/tmp/wt', 1, ?)`,
    ).run('t-1', 42);
    db.prepare(
        `INSERT INTO task_worktrees(task_id, repo_id, branch, path, created_at, pr_number)
         VALUES (?, 'repo-1', 'task/t-2', '/tmp/wt2', 1, NULL)`,
    ).run('t-2');

    const resolve = makeResolvePrNumber(db);
    assert.equal(resolve('t-1'), 42, 'returns the recorded PR number');
    assert.equal(resolve('t-2'), undefined, 'no PR yet → undefined');
    assert.equal(resolve('missing'), undefined, 'unknown task → undefined');
});

// ---------------------------------------------------------------------------
// P-CPTO-011 — real boot wiring (no chatGatewaySelection override)
//
// Every other boot test injects `chatGatewaySelection` to stay hermetic, which
// means the actual glue inside `start()` — reading `chat_gateway` from
// pipeline.yaml via `readChatGatewayName`, reading `TELEGRAM_BOT_TOKEN` via
// `getTelegramBotToken`, and feeding both into `selectAndStartChatGateway` —
// is never exercised end-to-end. These two cases cover that wiring directly,
// using ONLY branches that are safe without a real bot token (no network
// call): the missing-token fallback and the non-telegram default. The
// token-present branch (which would start a real long-poll loop) stays
// covered by the pure `selectAndStartChatGateway` unit test above.
// ---------------------------------------------------------------------------

async function bootHostWithoutGatewayOverride(pipelineYaml: string): Promise<{
    handle: WorkerApiHandle;
    tempDir: string;
    logger: WarnCapturingLogger;
}> {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-api-test-'));
    const yamlPath = path.join(tempDir, 'pipeline.yaml');
    fs.writeFileSync(yamlPath, pipelineYaml, 'utf8');
    const logger = new WarnCapturingLogger();

    const handle = await start({
        port: 0,
        host: '127.0.0.1',
        logger,
        pipelineConfigPath: yamlPath,
        orchestrator: {
            dbPath: ':memory:',
            flowsDir: FLOWS_DIR,
            pipelineConfigPath: yamlPath,
            logger,
        },
    });

    return { handle, tempDir, logger };
}

test('P-CPTO-011: real boot wiring — chat_gateway=telegram without a token warns and stays dark', async () => {
    const savedToken = process.env.TELEGRAM_BOT_TOKEN;
    const savedTokenV2 = process.env.TELEGRAM_BOT_TOKEN_V2;
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_BOT_TOKEN_V2;

    let fx: Awaited<ReturnType<typeof bootHostWithoutGatewayOverride>> | undefined;
    try {
        fx = await bootHostWithoutGatewayOverride(
            [
                'issue_tracker: linear',
                'chat_gateway: telegram',
                'issue_tracker_shadow: none',
                '',
            ].join('\n'),
        );

        assert.ok(
            fx.logger.warnings.some((w) => /TELEGRAM_BOT_TOKEN/.test(w)),
            'boot must warn that chat_gateway=telegram has no token, via the real wiring path',
        );
        assert.ok(
            fx.logger.warnings.every((w) => !/TELEGRAM_BOT_TOKEN[=:]\S/.test(w)),
            'the warning must never include a token value',
        );
    } finally {
        if (fx) {
            await fx.handle.stop();
            fs.rmSync(fx.tempDir, { recursive: true, force: true });
        }
        if (savedToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
        else process.env.TELEGRAM_BOT_TOKEN = savedToken;
        if (savedTokenV2 === undefined) delete process.env.TELEGRAM_BOT_TOKEN_V2;
        else process.env.TELEGRAM_BOT_TOKEN_V2 = savedTokenV2;
    }
});

test('P-CPTO-011: real boot wiring — non-telegram chat_gateway boots with no warning, fake stays dark', async () => {
    const savedToken = process.env.TELEGRAM_BOT_TOKEN;
    process.env.TELEGRAM_BOT_TOKEN = 'a-fake-token-value';

    let fx: Awaited<ReturnType<typeof bootHostWithoutGatewayOverride>> | undefined;
    try {
        fx = await bootHostWithoutGatewayOverride(
            [
                'issue_tracker: linear',
                'chat_gateway: fake',
                'issue_tracker_shadow: none',
                '',
            ].join('\n'),
        );

        assert.ok(
            fx.logger.warnings.every((w) => !/TELEGRAM_BOT_TOKEN/.test(w)),
            'the default/non-telegram path must never warn about the Telegram token, ' +
                'even with one present',
        );
    } finally {
        if (fx) {
            await fx.handle.stop();
            fs.rmSync(fx.tempDir, { recursive: true, force: true });
        }
        if (savedToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
        else process.env.TELEGRAM_BOT_TOKEN = savedToken;
    }
});

// ---------------------------------------------------------------------------
// GET /api/task-types — the board's menus, from the live flows + packs
// ---------------------------------------------------------------------------

async function taskTypesWith(packs: readonly string[]): Promise<{
    addTask: Array<{ id: string }>;
    archetypes: Array<{ id: string }>;
}> {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-task-types-'));
    activateProfile(home, { packs });
    const fx = await bootHost({ pipelineYaml: 'issue_tracker: linear\n' });
    try {
        const token = process.env.WORKER_API_TOKEN_V2;
        const res = await fetch(`http://127.0.0.1:${fx.handle.port}/api/task-types`, {
            ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
        });
        assert.equal(res.status, 200);
        return (await res.json()) as { addTask: Array<{ id: string }>; archetypes: Array<{ id: string }> };
    } finally {
        await fx.close();
        activateProfile(undefined);
        fs.rmSync(home, { recursive: true, force: true });
    }
}

test('GET /api/task-types offers the pack\'s types and plan types only when the pack is on', async () => {
    // The board's Add-task menu used to be a hardcoded list, so it could
    // offer a type with no loaded flow — a task created that way sat
    // unstartable. It now reflects exactly what this install can run.
    const on = await taskTypesWith(['dotnet-azure']);
    assert.ok(on.addTask.some((t) => t.id === 'deploy-nuget'));
    assert.ok(on.archetypes.some((a) => a.id === 'deploy-only'));

    const off = await taskTypesWith([]);
    assert.equal(off.addTask.some((t) => t.id === 'deploy-nuget'), false);
    assert.equal(off.archetypes.some((a) => a.id === 'deploy-only'), false);
    assert.ok(off.addTask.some((t) => t.id === 'implement'));
    assert.deepEqual(off.archetypes.map((a) => a.id), ['feature', 'documentation', 'review-codebase', 'investigate']);
});
