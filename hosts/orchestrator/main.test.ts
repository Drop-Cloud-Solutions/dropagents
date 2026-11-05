/**
 * Orchestrator composition-root integration tests.
 *
 * Dual-runner discovery
 * ---------------------
 * `npm test` runs `node --test --import tsx`. The review pipeline runs
 * `npx vitest run hosts/orchestrator/main.test.ts`, so this file must be
 * discoverable by both runners from a single source. The shim below mirrors
 * `adapters/auto-transitions/AutoTransitionJob.test.ts` and
 * `adapters/escalation/EscalationFileWriter.test.ts`: when `VITEST` is set
 * we pick vitest's `globalThis.test` (`vitest.config.ts` enables
 * `globals: true`), otherwise we fall back to `node:test`'s `test()` via
 * plain `require`. Vitest v4 forbids `require('vitest')` from CJS modules
 * — and tsc compiles this file to CJS per the project's tsconfig — so a
 * static `import { test } from 'vitest'` also breaks under `node --test`.
 */

import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { applyMigrations, openDatabase, type Db } from '../../core/state/migrations';
import type { Logger } from '../../core/ports';
import type { Event } from '../../core/events/event';

import { Orchestrator, isTaskTerminalForGc } from './main';
import { Commands, Events } from './handlers';
import { PlanLifecycleCommands } from '../../core/commands';
import { SNAPSHOT_JOB_SUBSCRIBER } from '../../adapters/storage/snapshot-job';
import { ESCALATION_FILE_WRITER_SUBSCRIBER } from '../../adapters/escalation/EscalationFileWriter';
import { WORKTREE_GC_JOB_SUBSCRIBER } from '../../adapters/git/worktree-gc-job';
import {
    AUTO_TRANSITIONS_SUBSCRIBER,
    type AutoTransitionPlanMetadata,
    type PlanMetadataStore,
} from '../../adapters/auto-transitions/AutoTransitionJob';
import { WorktreeManager, type TaskStateLookup } from '../../adapters/git/worktree-manager';

// ---------------------------------------------------------------------------
// Dual-runner test() shim — see file header for rationale.
// ---------------------------------------------------------------------------

type TestFn = (name: string, fn: () => void | Promise<void>) => void;

const test: TestFn = (((): TestFn => {
    if (process.env.VITEST) {
        const gt = (globalThis as { test?: TestFn }).test;
        if (typeof gt !== 'function') {
            throw new Error(
                'main.test.ts: VITEST=true but globalThis.test is missing — '
                    + 'ensure vitest.config.ts sets test.globals = true',
            );
        }
        return gt;
    }
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    const nt = require('node:test') as { test: TestFn };
    return nt.test;
})());

const FLOWS_DIR = path.resolve(__dirname, '..', '..', 'config', 'flows');
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_REFERENCE_BASELINE = path.join(REPO_ROOT, 'REFERENCE_BASELINE');

const IN_MEMORY_DB = ':memory:';

class SilentLogger implements Logger {
    info(): void {}
    warn(): void {}
    error(): void {}
    debug(): void {}
}

interface WarnEntry {
    readonly message: string;
    readonly meta: unknown;
}

class RecordingLogger implements Logger {
    readonly warns: WarnEntry[] = [];
    info(): void {}
    warn(message: string, meta?: unknown): void {
        this.warns.push({ message, meta });
    }
    error(): void {}
    debug(): void {}
}

function makeOrchestrator(): Orchestrator {
    return new Orchestrator({
        dbPath: IN_MEMORY_DB,
        flowsDir: FLOWS_DIR,
        logger: new SilentLogger(),
        idGen: (() => {
            let counter = 0;
            return { newId: (): string => `task-${++counter}` };
        })(),
    });
}

test('start applies migrations and re-applying on the same DB is a no-op (idempotent)', async () => {
    const orch = makeOrchestrator();
    await orch.start();
    try {
        const db = orch.getDb();

        const ledger1 = (
            db.prepare('SELECT version FROM __migrations ORDER BY version').all() as {
                version: string;
            }[]
        ).map((r) => r.version);

        assert.ok(ledger1.length > 0, 'expected at least one migration to be applied on start');

        // Re-applying migrations on the live DB must add no new ledger rows.
        const reApplied = applyMigrations(db);
        assert.deepEqual(reApplied, [], 'second applyMigrations must be a no-op');

        const ledger2 = (
            db.prepare('SELECT version FROM __migrations ORDER BY version').all() as {
                version: string;
            }[]
        ).map((r) => r.version);
        assert.deepEqual(ledger2, ledger1, 'migration ledger must be unchanged after re-apply');
    } finally {
        await orch.stop();
    }
});

test('ApprovePlan command produces the full PlanApproved -> ... -> TaskFinished trail', async () => {
    const orch = makeOrchestrator();
    await orch.start();
    try {
        // Plan gate: GeneratePlan must precede ApprovePlan (AP-IFW-003).
        await orch.getCommandBus().send({
            type: PlanLifecycleCommands.GENERATE_PLAN,
            actor: 'integration-test',
            issuedAt: 1_700_000_000_000,
            payload: { planId: 'plan-1', projectId: 'proj-1', revision: 1 },
        });
        await orch.getCommandBus().send({
            type: Commands.APPROVE_PLAN,
            actor: 'integration-test',
            issuedAt: 1_700_000_000_000,
            payload: { planId: 'plan-1', projectId: 'proj-1' },
        });

        // Drain async agent-runner publishes (AgentStarted/AgentFinished and
        // their downstream bridge → engine → emit:TaskFinished cascade).
        await orch.flush();

        const types = (
            orch
                .getDb()
                .prepare('SELECT type FROM events ORDER BY seq ASC')
                .all() as { type: string }[]
        ).map((r) => r.type);

        const expectedSequence = [
            Events.PLAN_APPROVED,
            Events.TASK_CREATED,
            Events.TASK_APPROVED,
            'AgentStarted',
            'AgentFinished',
            'TaskFinished',
        ];

        let cursor = -1;
        for (const expected of expectedSequence) {
            const idx = types.indexOf(expected, cursor + 1);
            assert.ok(
                idx > cursor,
                `expected "${expected}" after position ${cursor}, got log: ${types.join(', ')}`,
            );
            cursor = idx;
        }

        // Plan and task projections must have populated their tables — the
        // flow engine relies on the FK from flow_state(task_id) -> tasks(id).
        const plan = orch.getDb().prepare('SELECT id FROM plans WHERE id = ?').get('plan-1');
        assert.ok(plan, 'plans projection must have inserted plan-1');

        const tasks = orch
            .getDb()
            .prepare('SELECT id, plan_id, flow_id FROM tasks')
            .all() as { id: string; plan_id: string; flow_id: string | null }[];
        assert.equal(tasks.length, 1, 'exactly one task should have been created');
        assert.equal(tasks[0].plan_id, 'plan-1');
        assert.equal(tasks[0].flow_id, 'echo');
    } finally {
        await orch.stop();
    }
});

test('individual command handlers publish exactly the matching domain event', async () => {
    const orch = makeOrchestrator();
    await orch.start();
    try {
        const cmdBus = orch.getCommandBus();
        const db = orch.getDb();

        const before = (
            db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }
        ).n;

        // Sending ApprovePlan triggers the projection + the cascade. We only
        // care here that PlanApproved is in the resulting event set with the
        // correct payload — the cascade tests live above.
        await cmdBus.send({
            type: PlanLifecycleCommands.GENERATE_PLAN,
            actor: 'unit-test',
            issuedAt: 1_700_000_000_000,
            payload: { planId: 'plan-handlers', projectId: 'proj-1', revision: 1 },
        });
        await cmdBus.send({
            type: Commands.APPROVE_PLAN,
            actor: 'unit-test',
            issuedAt: 1_700_000_000_000,
            payload: { planId: 'plan-handlers', projectId: 'proj-1' },
        });
        await orch.flush();

        const allTypes = (
            db
                .prepare('SELECT type, payload FROM events WHERE seq > ? ORDER BY seq')
                .all(before) as { type: string; payload: string }[]
        );

        const planApproved = allTypes.find((r) => r.type === Events.PLAN_APPROVED);
        assert.ok(planApproved, 'PlanApproved must appear after ApprovePlan');
        const planPayload = JSON.parse(planApproved!.payload) as {
            planId: string;
            projectId: string;
            actor: string;
        };
        assert.equal(planPayload.planId, 'plan-handlers');
        assert.equal(planPayload.projectId, 'proj-1');
        assert.equal(planPayload.actor, 'unit-test');

        const taskCreated = allTypes.find((r) => r.type === Events.TASK_CREATED);
        assert.ok(taskCreated, 'TaskCreated must appear after the cascade');
        const tcPayload = JSON.parse(taskCreated!.payload) as {
            planId: string;
            flowId: string;
        };
        assert.equal(tcPayload.planId, 'plan-handlers');
        assert.equal(tcPayload.flowId, 'echo');

        const taskApproved = allTypes.find((r) => r.type === Events.TASK_APPROVED);
        assert.ok(taskApproved, 'TaskApproved must appear after the cascade');
    } finally {
        await orch.stop();
    }
});

test('stop() closes the SQLite handle cleanly', async () => {
    const orch = makeOrchestrator();
    await orch.start();

    const db = orch.getDb();
    assert.equal(db.open, true, 'db must be open after start');

    await orch.stop();
    assert.equal(db.open, false, 'db must be closed after stop');

    // Calling stop a second time must be a no-op rather than throwing.
    await orch.stop();
});

test('committed REFERENCE_BASELINE is a 40-char hex commit SHA on a single line', () => {
    const raw = fs.readFileSync(DEFAULT_REFERENCE_BASELINE, 'utf8');
    const lines = raw.split(/\r?\n/).filter((line) => line.length > 0);
    assert.equal(lines.length, 1, 'REFERENCE_BASELINE must contain exactly one non-empty line');
    assert.match(lines[0], /^[0-9a-fA-F]{40}$/, 'REFERENCE_BASELINE must be a 40-char hex SHA');
});

test('start warns when REFERENCE_BASELINE is missing', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-ref-'));
    const missingPath = path.join(tmp, 'REFERENCE_BASELINE');
    const logger = new RecordingLogger();
    const orch = new Orchestrator({
        dbPath: IN_MEMORY_DB,
        flowsDir: FLOWS_DIR,
        referenceBaselinePath: missingPath,
        logger,
    });
    try {
        await orch.start();
        const hit = logger.warns.find((w) => w.message.includes('REFERENCE_BASELINE missing'));
        assert.ok(hit, `expected a "REFERENCE_BASELINE missing" warning, got: ${JSON.stringify(logger.warns)}`);
    } finally {
        await orch.stop();
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('start warns when REFERENCE_BASELINE is malformed', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-ref-'));
    const badPath = path.join(tmp, 'REFERENCE_BASELINE');
    fs.writeFileSync(badPath, 'not-a-sha\n', 'utf8');
    const logger = new RecordingLogger();
    const orch = new Orchestrator({
        dbPath: IN_MEMORY_DB,
        flowsDir: FLOWS_DIR,
        referenceBaselinePath: badPath,
        logger,
    });
    try {
        await orch.start();
        const hit = logger.warns.find((w) => w.message.includes('REFERENCE_BASELINE malformed'));
        assert.ok(hit, `expected a "REFERENCE_BASELINE malformed" warning, got: ${JSON.stringify(logger.warns)}`);
    } finally {
        await orch.stop();
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('start does not warn when REFERENCE_BASELINE is a valid 40-char hex SHA', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-ref-'));
    const goodPath = path.join(tmp, 'REFERENCE_BASELINE');
    fs.writeFileSync(goodPath, 'b50868495fb778dc3058e15c2501cba410a59dac\n', 'utf8');
    const logger = new RecordingLogger();
    const orch = new Orchestrator({
        dbPath: IN_MEMORY_DB,
        flowsDir: FLOWS_DIR,
        referenceBaselinePath: goodPath,
        logger,
    });
    try {
        await orch.start();
        const refWarns = logger.warns.filter((w) => w.message.includes('REFERENCE_BASELINE'));
        assert.deepEqual(
            refWarns,
            [],
            `expected no REFERENCE_BASELINE warnings, got: ${JSON.stringify(refWarns)}`,
        );
    } finally {
        await orch.stop();
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('loading the orchestrator with no env vars or supplied adapters succeeds', async () => {
    // The acceptance criterion explicitly calls out Phase 0 fakes: the host
    // must wire itself up without any real adapters configured.
    const orch = new Orchestrator({
        dbPath: IN_MEMORY_DB,
        flowsDir: FLOWS_DIR,
        logger: new SilentLogger(),
    });
    await orch.start();
    try {
        const adapters = orch.getAdapters();
        assert.ok(adapters.agentRunner, 'agentRunner fake must be wired');
        assert.ok(adapters.issueTracker, 'issueTracker fake must be wired');
        assert.ok(adapters.chatGateway, 'chatGateway fake must be wired');
        assert.ok(adapters.sourceControl, 'sourceControl fake must be wired');
    } finally {
        await orch.stop();
    }
});

// ---------------------------------------------------------------------------
// AP-VP7-008 — Phase 7 subscriber registration
// ---------------------------------------------------------------------------

/**
 * Minimal `WorktreeManager` stand-in for tests that only need the
 * Phase-7 worktree-gc-job to find a manager to call. The Phase-7 job
 * invokes `gcStale()` on a recurring tick; runOnStart fires it once
 * synchronously on register. The stub returns an empty pruned list
 * so the cycle is a no-op.
 */
function makeStubWorktreeManager(): WorktreeManager {
    const taskStore: TaskStateLookup = { isTerminal: (): boolean => false };
    const manager = new WorktreeManager({
        repoRoot: REPO_ROOT,
        worktreeRoot: path.join(os.tmpdir(), 'orch-phase7-wt-test-stub'),
        taskStore,
        logger: new SilentLogger(),
    });
    // The default gcStale walks the filesystem; tests don't need it to do
    // anything beyond returning empty so the runOnStart cycle is a no-op.
    (manager as unknown as { gcStale: () => Promise<{ pruned: string[] }> }).gcStale =
        async (): Promise<{ pruned: string[] }> => ({ pruned: [] });
    return manager;
}

class StubPlanMetadataStore implements PlanMetadataStore {
    private readonly byPlan = new Map<string, AutoTransitionPlanMetadata>();
    set(planId: string, meta: AutoTransitionPlanMetadata): void {
        this.byPlan.set(planId, meta);
    }
    readMetadata(planId: string): AutoTransitionPlanMetadata | undefined {
        return this.byPlan.get(planId);
    }
}

test('Phase 7 wiring: snapshot-job + EscalationFileWriter + worktree-gc-job + AutoTransitionJob are registered', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-phase7-'));
    const workspace = path.join(tmp, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });

    const prevSnap = process.env.SNAPSHOTS_ENABLED;
    process.env.SNAPSHOTS_ENABLED = 'true';

    const orch = new Orchestrator({
        dbPath: IN_MEMORY_DB,
        flowsDir: FLOWS_DIR,
        logger: new SilentLogger(),
        workspace,
        adapters: {
            worktreeManager: makeStubWorktreeManager(),
            planMetadataStore: new StubPlanMetadataStore(),
        },
    });

    try {
        await orch.start();
        const wired = orch.getRegisteredSubscriberNames();
        for (const expected of [
            SNAPSHOT_JOB_SUBSCRIBER,
            ESCALATION_FILE_WRITER_SUBSCRIBER,
            WORKTREE_GC_JOB_SUBSCRIBER,
            AUTO_TRANSITIONS_SUBSCRIBER,
        ]) {
            assert.ok(
                wired.includes(expected),
                `expected subscriber "${expected}" to be wired; got: ${wired.join(', ')}`,
            );
        }
    } finally {
        await orch.stop();
        if (prevSnap === undefined) {
            delete process.env.SNAPSHOTS_ENABLED;
        } else {
            process.env.SNAPSHOTS_ENABLED = prevSnap;
        }
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('Phase 7 wiring: TaskFailed{finalAttempt:true} writes an escalation file under <workspace>/<projectId>/escalations/', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-phase7-esc-'));
    const workspace = path.join(tmp, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });

    const orch = new Orchestrator({
        dbPath: IN_MEMORY_DB,
        flowsDir: FLOWS_DIR,
        logger: new SilentLogger(),
        workspace,
    });

    try {
        await orch.start();

        const taskId = 'task-escalate-1';
        const projectId = 'proj-1';
        const event: Event = {
            type: 'TaskFailed',
            v: 1,
            occurredAt: 1_700_000_000_000,
            idempotencyKey: `test:TaskFailed:${taskId}`,
            payload: {
                taskId,
                projectId,
                planId: 'plan-1',
                failed_stage: 'develop',
                finalAttempt: true,
                error: 'agent returned non-zero exit code',
                retryHistory: [
                    { attempt: 1, failed_stage: 'develop', error: 'transient', at: 1 },
                    { attempt: 2, failed_stage: 'develop', error: 'final', at: 2 },
                ],
            },
        };

        await orch.getEventBus().publish(event);

        const expectedFile = path.join(
            workspace,
            projectId,
            'escalations',
            `plan.escalation-${taskId}.md`,
        );
        assert.equal(
            fs.existsSync(expectedFile),
            true,
            `expected escalation file at ${expectedFile}`,
        );
        const body = fs.readFileSync(expectedFile, 'utf8');
        assert.match(body, new RegExp(`# Escalation: ${taskId}`));
        assert.match(body, /agent returned non-zero exit code/);
    } finally {
        await orch.stop();
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('Phase 7 wiring: TaskFailed without finalAttempt does NOT write an escalation file', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-phase7-esc-noop-'));
    const workspace = path.join(tmp, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });

    const orch = new Orchestrator({
        dbPath: IN_MEMORY_DB,
        flowsDir: FLOWS_DIR,
        logger: new SilentLogger(),
        workspace,
    });

    try {
        await orch.start();
        const taskId = 'task-no-escalate';
        await orch.getEventBus().publish({
            type: 'TaskFailed',
            v: 1,
            occurredAt: 1_700_000_000_000,
            idempotencyKey: `test:TaskFailed:${taskId}`,
            payload: {
                taskId,
                projectId: 'proj-1',
                failed_stage: 'develop',
                // finalAttempt omitted -> writer must skip
            },
        });
        const escalationsDir = path.join(workspace, 'proj-1', 'escalations');
        assert.equal(
            fs.existsSync(escalationsDir),
            false,
            'escalations dir must not exist when finalAttempt is absent',
        );
    } finally {
        await orch.stop();
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// P-MSWA-002 — cascade worktree cleanup on plan archive/delete, final-failed
// tasks, and the gc backstop.
// ---------------------------------------------------------------------------

/** Insert a task row (plan_id + status) directly into the projection. */
function seedTaskRow(db: Db, id: string, planId: string, status: string): void {
    db.prepare(
        `INSERT INTO tasks(id, plan_id, type, status) VALUES (?, ?, 'implement', ?)`,
    ).run(id, planId, status);
}

/**
 * Insert a `task_worktrees` row whose on-disk path is `wtPath`. When
 * `wtPath` names a real directory, `removeOnDisk`'s fs.rm fallback (no
 * `resolveRepoPath` resolves the fake repo id) will delete it — which is
 * how the final-failed test observes the removal.
 */
function seedWorktreeRow(db: Db, taskId: string, wtPath: string): void {
    db.prepare(
        `INSERT INTO task_worktrees(task_id, repo_id, branch, path, created_at)
         VALUES (?, 'unresolved-repo', ?, ?, 1)`,
    ).run(taskId, `task/${taskId}`, wtPath);
}

function worktreeRowExists(db: Db, taskId: string): boolean {
    return (
        db
            .prepare('SELECT task_id FROM task_worktrees WHERE task_id = ?')
            .get(taskId) !== undefined
    );
}

test('PlanArchived cascades removeAllForPlan — drops every worktree row under the plan, leaves other plans untouched', async () => {
    const orch = makeOrchestrator();
    await orch.start();
    try {
        const db = orch.getDb();
        seedTaskRow(db, 'pa-t1', 'plan-A', 'in_progress');
        seedTaskRow(db, 'pa-t2', 'plan-A', 'in_progress');
        seedTaskRow(db, 'pa-t3', 'plan-B', 'in_progress');
        seedWorktreeRow(db, 'pa-t1', 'C:/nonexistent/wt/pa-t1');
        seedWorktreeRow(db, 'pa-t2', 'C:/nonexistent/wt/pa-t2');
        seedWorktreeRow(db, 'pa-t3', 'C:/nonexistent/wt/pa-t3');

        await orch.getEventBus().publish({
            type: 'PlanArchived',
            v: 1,
            occurredAt: 1_700_000_000_000,
            idempotencyKey: 'test:PlanArchived:plan-A',
            payload: { planId: 'plan-A' },
        });

        assert.equal(worktreeRowExists(db, 'pa-t1'), false);
        assert.equal(worktreeRowExists(db, 'pa-t2'), false);
        assert.equal(worktreeRowExists(db, 'pa-t3'), true);
    } finally {
        await orch.stop();
    }
});

test('PlanDeleted cascades removeAllForPlan — drops the deleted plan\'s worktree rows', async () => {
    const orch = makeOrchestrator();
    await orch.start();
    try {
        const db = orch.getDb();
        seedTaskRow(db, 'pd-t1', 'plan-D', 'in_progress');
        seedTaskRow(db, 'pd-t2', 'plan-D', 'in_progress');
        seedWorktreeRow(db, 'pd-t1', 'C:/nonexistent/wt/pd-t1');
        seedWorktreeRow(db, 'pd-t2', 'C:/nonexistent/wt/pd-t2');

        await orch.getEventBus().publish({
            type: 'PlanDeleted',
            v: 1,
            occurredAt: 1_700_000_000_000,
            idempotencyKey: 'test:PlanDeleted:plan-D',
            payload: { planId: 'plan-D' },
        });

        assert.equal(worktreeRowExists(db, 'pd-t1'), false);
        assert.equal(worktreeRowExists(db, 'pd-t2'), false);
    } finally {
        await orch.stop();
    }
});

test('plan-worktree-cleanup subscriber is registered under its own name (so boot replayMissed covers archive/delete that happened while down)', async () => {
    const orch = makeOrchestrator();
    await orch.start();
    try {
        const wired = orch.getRegisteredSubscriberNames();
        assert.ok(
            wired.includes('plan-worktree-cleanup'),
            `expected 'plan-worktree-cleanup' in registered subscribers; got: ${wired.join(', ')}`,
        );
    } finally {
        await orch.stop();
    }
});

test('TaskFailed{finalAttempt:true} removes the task worktree on disk; a mid-retry failure keeps it', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-final-fail-'));
    const finalDir = path.join(tmp, 'wt-final');
    const retryDir = path.join(tmp, 'wt-retry');
    fs.mkdirSync(finalDir, { recursive: true });
    fs.mkdirSync(retryDir, { recursive: true });
    fs.writeFileSync(path.join(finalDir, 'wip.txt'), 'work');
    fs.writeFileSync(path.join(retryDir, 'wip.txt'), 'work');

    const orch = makeOrchestrator();
    await orch.start();
    try {
        const db = orch.getDb();
        seedTaskRow(db, 'ff-final', 'plan-F', 'in_progress');
        seedTaskRow(db, 'ff-retry', 'plan-F', 'in_progress');
        seedWorktreeRow(db, 'ff-final', finalDir);
        seedWorktreeRow(db, 'ff-retry', retryDir);

        // Terminal failure — worktree must be reclaimed immediately.
        await orch.getEventBus().publish({
            type: 'TaskFailed',
            v: 1,
            occurredAt: 1_700_000_000_000,
            idempotencyKey: 'test:TaskFailed:ff-final',
            payload: { taskId: 'ff-final', failed_stage: 'develop', finalAttempt: true },
        });

        // Mid-retry failure — worktree WIP must be preserved.
        await orch.getEventBus().publish({
            type: 'TaskFailed',
            v: 1,
            occurredAt: 1_700_000_000_001,
            idempotencyKey: 'test:TaskFailed:ff-retry',
            payload: { taskId: 'ff-retry', failed_stage: 'develop' },
        });

        assert.equal(
            fs.existsSync(finalDir),
            false,
            'finalAttempt:true must remove the worktree directory',
        );
        assert.equal(
            fs.existsSync(retryDir),
            true,
            'a failure without finalAttempt must keep the worktree for inspection',
        );
    } finally {
        await orch.stop();
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('isTaskTerminalForGc: skipped + plan-orphaned tasks count as terminal; active tasks and unknown ids do not', () => {
    const db = openDatabase(IN_MEMORY_DB);
    applyMigrations(db);

    // Plans: one live, one archived (PlanArchived AND PlanDeleted both stamp
    // archived_at, so a non-null value models either).
    db.prepare(
        `INSERT INTO sidebar_plans(plan_id, pid, archived_at, updated_at)
         VALUES ('plan-live', 'p', NULL, 1)`,
    ).run();
    db.prepare(
        `INSERT INTO sidebar_plans(plan_id, pid, archived_at, updated_at)
         VALUES ('plan-archived', 'p', 123, 1)`,
    ).run();

    seedTaskRow(db, 'g-done', 'plan-live', 'done');
    seedTaskRow(db, 'g-dismissed', 'plan-live', 'dismissed');
    seedTaskRow(db, 'g-skipped', 'plan-live', 'skipped');
    seedTaskRow(db, 'g-failed', 'plan-live', 'failed');
    seedTaskRow(db, 'g-active', 'plan-live', 'in_progress');
    seedTaskRow(db, 'g-orphan', 'plan-archived', 'in_progress');

    assert.equal(isTaskTerminalForGc(db, 'g-done'), true);
    assert.equal(isTaskTerminalForGc(db, 'g-dismissed'), true);
    // 'skipped' — the status the TaskSkipped projection writes; the fix
    // adds it to TERMINAL_TASK_STATUSES.
    assert.equal(isTaskTerminalForGc(db, 'g-skipped'), true);
    assert.equal(isTaskTerminalForGc(db, 'g-failed'), true);
    // Active task under a live plan — NOT terminal.
    assert.equal(isTaskTerminalForGc(db, 'g-active'), false);
    // Active task whose owning plan is archived/deleted — terminal via the
    // plan lookup, even though its own status is non-terminal.
    assert.equal(isTaskTerminalForGc(db, 'g-orphan'), true);
    // Unknown task id — never terminal (never prune an unrecognised dir).
    assert.equal(isTaskTerminalForGc(db, 'no-such-task'), false);

    db.close();
});

test('gcStale reclaims a skipped worktree and a plan-orphaned worktree, but leaves an active task alone', async () => {
    const db = openDatabase(IN_MEMORY_DB);
    applyMigrations(db);
    db.prepare(
        `INSERT INTO sidebar_plans(plan_id, pid, archived_at, updated_at)
         VALUES ('plan-live', 'p', NULL, 1)`,
    ).run();
    db.prepare(
        `INSERT INTO sidebar_plans(plan_id, pid, archived_at, updated_at)
         VALUES ('plan-archived', 'p', 123, 1)`,
    ).run();
    seedTaskRow(db, 'wt-skipped', 'plan-live', 'skipped');
    seedTaskRow(db, 'wt-active', 'plan-live', 'in_progress');
    seedTaskRow(db, 'wt-orphan', 'plan-archived', 'in_progress');

    const names = ['wt-skipped', 'wt-active', 'wt-orphan'];
    const removed: string[] = [];
    const manager = new WorktreeManager({
        repoRoot: path.join(os.tmpdir(), 'gc-repo'),
        worktreeRoot: path.join(os.tmpdir(), 'gc-wt'),
        taskStore: { isTerminal: (id: string): boolean => isTaskTerminalForGc(db, id) },
        logger: new SilentLogger(),
        readdir: (): readonly string[] => names,
        stat: () => ({ mtimeMs: 0, isDirectory: (): boolean => true }),
        exists: (): boolean => true,
        // now well past the idle cutoff so every terminal dir is eligible.
        now: (): number => 1_000_000_000_000,
        idleMs: 1000,
        exec: async (_cmd, args): Promise<{ stdout: string; stderr: string }> => {
            removed.push(args[args.length - 1]);
            return { stdout: '', stderr: '' };
        },
    });

    const { pruned } = await manager.gcStale();

    assert.equal(pruned.length, 2, `expected 2 pruned, got: ${pruned.join(', ')}`);
    assert.ok(pruned.some((p) => p.includes('wt-skipped')), 'skipped worktree must be reclaimed');
    assert.ok(pruned.some((p) => p.includes('wt-orphan')), 'plan-orphaned worktree must be reclaimed');
    assert.ok(!pruned.some((p) => p.includes('wt-active')), 'active task worktree must survive');
    assert.equal(removed.length, 2);

    db.close();
});

test('clarification park keeps parked_choices; other parks null them (reload regression)', async () => {
    // ClarificationRequested (writes choices) is published BEFORE the
    // TaskParked of the same question cycle. The TaskParked fold used to
    // null parked_choices unconditionally, wiping what just landed — the
    // board then showed the question with no radio options after a
    // reload (field incident).
    const orch = makeOrchestrator();
    await orch.start();
    try {
        const db = orch.getDb();
        const bus = orch.getEventBus();
        db.prepare(
            "INSERT INTO plans(id, project_id, status, created_at) VALUES ('pl-clar', 'p', 'active', 1)",
        ).run();
        db.prepare(
            "INSERT INTO tasks(id, plan_id, type, status) VALUES ('T-CLAR', 'pl-clar', 'implement', 'in-progress')",
        ).run();

        await bus.publish({
            type: 'ClarificationRequested',
            v: 1,
            occurredAt: 1,
            idempotencyKey: 'clar-test:choices',
            payload: {
                taskId: 'T-CLAR',
                question: 'Which side wins?',
                choices: ['A) keep paging', 'B) keep cache'],
            },
        });
        await bus.publish({
            type: 'TaskParked',
            v: 1,
            occurredAt: 2,
            idempotencyKey: 'clar-test:parked',
            payload: {
                taskId: 'T-CLAR',
                stepId: 'develop',
                reason: 'clarification',
                question: 'Which side wins?',
            },
        });
        const row = db
            .prepare('SELECT parked_reason, parked_question, parked_choices FROM tasks WHERE id = ?')
            .get('T-CLAR') as { parked_reason: string; parked_question: string; parked_choices: string | null };
        assert.equal(row.parked_reason, 'clarification');
        assert.equal(row.parked_question, 'Which side wins?');
        assert.ok(row.parked_choices, 'choices must survive the TaskParked fold');
        assert.deepEqual(JSON.parse(row.parked_choices!), ['A) keep paging', 'B) keep cache']);

        // A later NON-clarification park clears the stale choices.
        await bus.publish({
            type: 'TaskParked',
            v: 1,
            occurredAt: 3,
            idempotencyKey: 'clar-test:approval',
            payload: { taskId: 'T-CLAR', stepId: 'commit', reason: 'approval' },
        });
        const cleared = db
            .prepare('SELECT parked_choices FROM tasks WHERE id = ?')
            .get('T-CLAR') as { parked_choices: string | null };
        assert.equal(cleared.parked_choices, null);
    } finally {
        await orch.stop();
    }
});

test('merge-conflict resolver is ATTACHED after start (regression: it never subscribed)', async () => {
    // It was attached from attachProjections(), which runs BEFORE
    // registerHandlers() materialises `taskWorktreeStore` — so its
    // `if (!this.taskWorktreeStore) return;` guard fired on every boot and
    // the resolver silently never subscribed. Every PR conflict then fell
    // through to the plain "merge failed" error (operator report: "the
    // merge-conflict agent doesn't do anything").
    //
    // Proven here through the resolver's own no-git failure path: a
    // conflict for a task with no worktree record must park the task with
    // an operator question. If the subscriber is missing, nothing happens.
    const orch = makeOrchestrator();
    await orch.start();
    try {
        const db = orch.getDb();
        const bus = orch.getEventBus();
        db.prepare(
            "INSERT INTO plans(id, project_id, status, created_at) VALUES ('pl-mc', 'p', 'active', 1)",
        ).run();
        db.prepare(
            "INSERT INTO tasks(id, plan_id, type, status) VALUES ('T-MC', 'pl-mc', 'implement', 'in-progress')",
        ).run();

        await bus.publish({
            type: 'MergeConflictDetected',
            v: 1,
            occurredAt: 1,
            idempotencyKey: 'mc-attach-test',
            payload: { taskId: 'T-MC', reason: 'GraphQL: Pull request is not mergeable' },
        });

        const parked = db
            .prepare("SELECT payload FROM events WHERE type = 'TaskParked' ORDER BY seq DESC LIMIT 1")
            .get() as { payload: string } | undefined;
        assert.ok(parked, 'resolver must react to MergeConflictDetected');
        const payload = JSON.parse(parked!.payload) as {
            taskId: string;
            reason: string;
            notifyChat?: boolean;
        };
        assert.equal(payload.taskId, 'T-MC');
        assert.equal(payload.reason, 'clarification');
        assert.equal(payload.notifyChat, true, 'operator must be told, not left guessing');
    } finally {
        await orch.stop();
    }
});

test('tasks of a never-approved plan PERSIST (FK regression: deploy-only plans lost their tasks)', async () => {
    // `tasks.plan_id` REFERENCES plans(id) with foreign_keys ON, and the
    // plans row used to be written only on PlanApproved. A non-feature
    // archetype (deploy-only / document / review-* / investigate) never
    // emits PlanApproved — GeneratePlan spawns the decomposer directly —
    // so every task INSERT failed the FK, the bus swallowed the throw,
    // and the operator saw tasks live (in-memory SSE) that were gone on
    // refresh, with the plan classified back to Draft.
    // Field case: plan "deploy the orderapp" (planType deploy-only).
    const orch = makeOrchestrator();
    await orch.start();
    try {
        const db = orch.getDb();
        const bus = orch.getEventBus();

        await bus.publish({
            type: 'PlanCreated',
            v: 1,
            occurredAt: 10,
            idempotencyKey: 'fk-test:plan-created',
            payload: {
                planId: 'plan-deploy-only',
                projectId: 'shop',
                title: 'deploy the orderapp',
                metadata: { planType: 'deploy-only' },
            },
        });
        await bus.publish({
            type: 'TaskCreated',
            v: 1,
            occurredAt: 11,
            idempotencyKey: 'fk-test:task-created',
            payload: {
                taskId: 'L-DEP-001',
                planId: 'plan-deploy-only',
                type: 'deploy-azure',
                flowId: 'deploy-azure',
                title: 'Deploy OrderApp to stg',
            },
        });

        const task = db
            .prepare('SELECT id, plan_id, type FROM tasks WHERE id = ?')
            .get('L-DEP-001') as { id: string; plan_id: string; type: string } | undefined;
        assert.ok(task, 'the task must survive a refresh — no PlanApproved was ever emitted');
        assert.equal(task!.plan_id, 'plan-deploy-only');
        assert.equal(task!.type, 'deploy-azure');

        // The parent row exists, so /api/tasks joins and the plan stops
        // classifying as Draft.
        const plan = db
            .prepare('SELECT id, project_id FROM plans WHERE id = ?')
            .get('plan-deploy-only') as { id: string; project_id: string } | undefined;
        assert.ok(plan, 'PlanCreated must materialise the parent row');
        assert.equal(plan!.project_id, 'shop');
    } finally {
        await orch.stop();
    }
});

test('a task whose plan row is missing entirely still persists (defensive ensure)', async () => {
    // No PlanCreated at all — e.g. an event stream that predates the fold
    // above, or a future path that skips it. The task projection ensures
    // the parent row itself rather than losing the task.
    const orch = makeOrchestrator();
    await orch.start();
    try {
        const db = orch.getDb();
        const bus = orch.getEventBus();
        db.prepare(
            `INSERT INTO sidebar_plans(plan_id, pid, name, updated_at)
             VALUES ('plan-orphan', 'proj-x', 'orphan plan', 1)`,
        ).run();

        await bus.publish({
            type: 'TaskCreated',
            v: 1,
            occurredAt: 12,
            idempotencyKey: 'fk-test:orphan-task',
            payload: {
                taskId: 'L-ORP-001',
                planId: 'plan-orphan',
                type: 'implement',
                flowId: 'implement',
            },
        });

        assert.ok(
            db.prepare('SELECT id FROM tasks WHERE id = ?').get('L-ORP-001'),
            'the task must not be dropped by the FK',
        );
        const plan = db
            .prepare('SELECT project_id FROM plans WHERE id = ?')
            .get('plan-orphan') as { project_id: string } | undefined;
        assert.equal(plan?.project_id, 'proj-x', 'project recovered from sidebar_plans');
    } finally {
        await orch.stop();
    }
});


test('live-only subscribers report and clear their downtime backlog at boot', async () => {
    // They deliberately do NOT replay - replaying would re-spawn verifier
    // and resolver agents for historical events - but their offsets must
    // not silently carry the gap: it hid events published while the worker
    // was down and dragged /health's lag gauge to a meaningless number.
    // Needs a FILE db so state survives the restart.
    const fs = await import('node:fs');
    const os = await import('node:os');
    const pathMod = await import('node:path');
    const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'live-only-'));
    const dbPath = pathMod.join(dir, 'state.db');
    try {
        const first = new Orchestrator({
            dbPath,
            flowsDir: FLOWS_DIR,
            logger: new SilentLogger(),
        });
        await first.start();
        const db = first.getDb();
        for (let i = 0; i < 40; i++) {
            db.prepare(
                `INSERT INTO events(type, v, occurred_at, idempotency_key, payload)
                 VALUES ('Noise', 1, ?, ?, '{}')`,
            ).run(i, `live-only-test:${i}`);
        }
        db.prepare(
            `INSERT OR REPLACE INTO subscriber_offsets(subscriber, last_seq)
             VALUES ('auto-merge', 2)`,
        ).run();
        const maxSeq = (db.prepare('SELECT MAX(seq) AS m FROM events')
            .get() as { m: number }).m;
        assert.ok(maxSeq > 2, 'precondition: the log is ahead of the stale offset');
        await first.stop();

        const warned: Array<Record<string, unknown>> = [];
        const second = new Orchestrator({
            dbPath,
            flowsDir: FLOWS_DIR,
            logger: {
                info: (): void => {},
                debug: (): void => {},
                error: (): void => {},
                warn: (message: string, ctx?: Record<string, unknown>): void => {
                    if (message.includes('live-only subscriber skipped')) {
                        warned.push({ message, ...(ctx ?? {}) });
                    }
                },
            },
        });
        await second.start();
        try {
            const hit = warned.find((w) => w.subscriber === 'auto-merge');
            assert.ok(hit, `the skipped backlog must be reported, got: ${JSON.stringify(warned)}`);
            assert.equal(hit!.skipped, maxSeq - 2, 'the gap size is named');

            const after = second.getDb()
                .prepare("SELECT last_seq FROM subscriber_offsets WHERE subscriber = 'auto-merge'")
                .get() as { last_seq: number };
            assert.ok(
                after.last_seq >= maxSeq,
                'the offset is advanced past the reported gap, not left to drag the gauge',
            );
        } finally {
            await second.stop();
        }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('ClarificationAnswered is persisted with its question so later steps can read it', async () => {
    // The operator's answer used to live only on the StartAgent context
    // of the ONE step the engine resumed. The reviewer, dispatched
    // afterwards, was never told — and rejected work that followed the
    // operator's own decision (field case). The fold below is what makes
    // the answer durable for the whole task.
    const orch = makeOrchestrator();
    await orch.start();
    try {
        const db = orch.getDb();
        const bus = orch.getEventBus();
        db.prepare(
            "INSERT INTO plans(id, project_id, status, created_at) VALUES ('pl-c', 'p', 'active', 1)",
        ).run();
        db.prepare(
            `INSERT INTO tasks(id, plan_id, type, status, parked_question)
             VALUES ('T-CL', 'pl-c', 'implement', 'in-progress',
                     'The ticket says bump the version — bump anyway?')`,
        ).run();

        await bus.publish({
            type: 'ClarificationAnswered',
            v: 1,
            occurredAt: 7,
            idempotencyKey: 'clarify-answered-test',
            payload: {
                taskId: 'T-CL',
                answer: 'No. Leave the version alone.',
                remember: false,
                answeredAt: 7,
            },
        });

        const row = db
            .prepare('SELECT question, answer FROM task_clarifications WHERE task_id = ?')
            .get('T-CL') as { question: string | null; answer: string } | undefined;
        assert.ok(row, 'the answer must outlive the step that asked');
        assert.equal(row!.answer, 'No. Leave the version alone.');
        assert.match(
            row!.question ?? '',
            /bump anyway/,
            'a bare answer means nothing without its question',
        );
    } finally {
        await orch.stop();
    }
});

test('a decomposer question and its answer are projected as one durable row', async () => {
    // The board paints the Answer button off this row, and
    // AnswerDecomposerQuestion re-checks it at dispatch time. Without the
    // projection the question lives only in the tab that saw the SSE event:
    // a reload lost it, and the plan sat un-startable with nothing to click.
    const orch = makeOrchestrator();
    await orch.start();
    try {
        const db = orch.getDb();
        const bus = orch.getEventBus();

        await bus.publish({
            type: 'PlanDecomposeQuestionRaised',
            v: 1,
            occurredAt: 10,
            idempotencyKey: 'dq-raised-1',
            payload: {
                planId: 'pl-dq',
                projectId: 'p',
                question: 'Orders API or a new Billing API?',
                options: [
                    { key: 'A', label: 'Extend Orders' },
                    { key: 'B', label: 'New Billing API' },
                ],
                raw: 'NEEDS_HUMAN_INPUT\nQuestion: ...',
                askedAt: 10,
            },
        });

        const pending = db
            .prepare(
                `SELECT question, options, answer FROM decomposer_clarifications
                  WHERE plan_id = ?`,
            )
            .get('pl-dq') as
                { question: string; options: string | null; answer: string | null } | undefined;
        assert.ok(pending, 'the question must be durable');
        assert.match(pending!.question, /Billing API/);
        assert.equal(pending!.answer, null, 'pending until answered');
        assert.match(pending!.options ?? '', /Extend Orders/);

        await bus.publish({
            type: 'PlanDecomposeQuestionAnswered',
            v: 1,
            occurredAt: 20,
            idempotencyKey: 'dq-answered-1',
            payload: {
                planId: 'pl-dq',
                projectId: 'p',
                question: 'Orders API or a new Billing API?',
                answer: 'B) New Billing API',
                answeredAt: 20,
            },
        });

        const rows = db
            .prepare(
                `SELECT question, answer, answered_at FROM decomposer_clarifications
                  WHERE plan_id = ? ORDER BY event_seq`,
            )
            .all('pl-dq') as ReadonlyArray<
                { question: string; answer: string | null; answered_at: number | null }
            >;
        assert.equal(rows.length, 1, 'the answer updates the question row, it does not add one');
        assert.equal(rows[0]!.answer, 'B) New Billing API');
        assert.equal(rows[0]!.answered_at, 20);
    } finally {
        await orch.stop();
    }
});

test('a second decomposer answer lands on the older open question, not the newer', async () => {
    // Questions are answered in the order they were asked. Targeting the
    // NEWEST open row would strand the older one unanswered forever — and
    // "the newest row with a NULL answer" is exactly what the Answer button
    // and the command handler read, so the stranded row would keep the
    // button on screen for a question already dealt with.
    const orch = makeOrchestrator();
    await orch.start();
    try {
        const db = orch.getDb();
        const bus = orch.getEventBus();
        for (const [i, q] of ['First?', 'Second?'].entries()) {
            await bus.publish({
                type: 'PlanDecomposeQuestionRaised',
                v: 1,
                occurredAt: 10 + i,
                idempotencyKey: `dq-multi-raised-${String(i)}`,
                payload: {
                    planId: 'pl-dq2',
                    projectId: 'p',
                    question: q,
                    options: [],
                    raw: q,
                    askedAt: 10 + i,
                },
            });
        }
        await bus.publish({
            type: 'PlanDecomposeQuestionAnswered',
            v: 1,
            occurredAt: 30,
            idempotencyKey: 'dq-multi-answered-0',
            payload: {
                planId: 'pl-dq2',
                projectId: 'p',
                question: 'First?',
                answer: 'answer to the first',
                answeredAt: 30,
            },
        });

        const rows = db
            .prepare(
                `SELECT question, answer FROM decomposer_clarifications
                  WHERE plan_id = ? ORDER BY event_seq`,
            )
            .all('pl-dq2') as ReadonlyArray<{ question: string; answer: string | null }>;
        assert.equal(rows.length, 2);
        assert.equal(rows[0]!.question, 'First?');
        assert.equal(rows[0]!.answer, 'answer to the first');
        assert.equal(rows[1]!.answer, null, 'the later question stays open');
    } finally {
        await orch.stop();
    }
});

test('a blank clarification answer is not stored', async () => {
    const orch = makeOrchestrator();
    await orch.start();
    try {
        const db = orch.getDb();
        const bus = orch.getEventBus();
        db.prepare(
            "INSERT INTO plans(id, project_id, status, created_at) VALUES ('pl-c2', 'p', 'active', 1)",
        ).run();
        db.prepare(
            "INSERT INTO tasks(id, plan_id, type, status) VALUES ('T-CL2', 'pl-c2', 'implement', 'in-progress')",
        ).run();

        await bus.publish({
            type: 'ClarificationAnswered',
            v: 1,
            occurredAt: 8,
            idempotencyKey: 'clarify-blank-test',
            payload: { taskId: 'T-CL2', answer: '   ', remember: false, answeredAt: 8 },
        });

        const count = db
            .prepare('SELECT COUNT(*) AS n FROM task_clarifications WHERE task_id = ?')
            .get('T-CL2') as { n: number };
        assert.equal(count.n, 0, 'an empty answer is not a decision');
    } finally {
        await orch.stop();
    }
});

test('the operator answer arrives as TaskResumed — the event the board path actually publishes', async () => {
    // The board's Answer button POSTs /tasks/:id/clarify, which
    // dispatches ResumeTask{decision:'approve', answer}. The registered
    // handler is core's createResumeTaskHandler, which emits ONLY
    // TaskResumed — `handlers/resume.ts` (the one that emits
    // ClarificationAnswered) is not registered anywhere in production.
    // Folding the wrong event is why the first attempt at this fix
    // changed nothing in the field.
    const orch = makeOrchestrator();
    await orch.start();
    try {
        const db = orch.getDb();
        const bus = orch.getEventBus();
        db.prepare(
            "INSERT INTO plans(id, project_id, status, created_at) VALUES ('pl-r', 'p', 'active', 1)",
        ).run();
        db.prepare(
            `INSERT INTO tasks(id, plan_id, type, status, parked_reason, parked_question)
             VALUES ('T-R', 'pl-r', 'implement', 'in-progress', 'clarification',
                     'Bump the version even though it is already current?')`,
        ).run();

        await bus.publish({
            type: 'TaskResumed',
            v: 1,
            occurredAt: 11,
            idempotencyKey: 'resume-answer-test',
            payload: {
                taskId: 'T-R',
                actor: 'operator',
                decision: 'approve',
                answer: 'No. Leave the version alone.',
            },
        });

        const row = db
            .prepare('SELECT question, answer FROM task_clarifications WHERE task_id = ?')
            .get('T-R') as { question: string | null; answer: string } | undefined;
        assert.ok(row, 'the answer must be captured from TaskResumed');
        assert.equal(row!.answer, 'No. Leave the version alone.');
        assert.match(
            row!.question ?? '',
            /already current/,
            'the question must be read BEFORE the resume clears parked_question',
        );
    } finally {
        await orch.stop();
    }
});

test('an approval-gate resume and a rejection are not recorded as clarifications', async () => {
    const orch = makeOrchestrator();
    await orch.start();
    try {
        const db = orch.getDb();
        const bus = orch.getEventBus();
        db.prepare(
            "INSERT INTO plans(id, project_id, status, created_at) VALUES ('pl-r2', 'p', 'active', 1)",
        ).run();
        db.prepare(
            "INSERT INTO tasks(id, plan_id, type, status) VALUES ('T-R2', 'pl-r2', 'implement', 'in-progress')",
        ).run();

        // Plain approval click: no answer at all.
        await bus.publish({
            type: 'TaskResumed',
            v: 1,
            occurredAt: 12,
            idempotencyKey: 'resume-gate-test',
            payload: { taskId: 'T-R2', actor: 'operator', decision: 'approve' },
        });
        // Rejection: feedback rides tasks.feedback, not this table.
        await bus.publish({
            type: 'TaskResumed',
            v: 1,
            occurredAt: 13,
            idempotencyKey: 'resume-reject-test',
            payload: {
                taskId: 'T-R2',
                actor: 'operator',
                decision: 'reject',
                feedback: 'undo the version bump',
            },
        });

        const count = db
            .prepare('SELECT COUNT(*) AS n FROM task_clarifications WHERE task_id = ?')
            .get('T-R2') as { n: number };
        assert.equal(count.n, 0);
    } finally {
        await orch.stop();
    }
});

// ---------------------------------------------------------------------------
// ResumeTask side effects, through the REAL command registration.
//
// `handlers/resume.ts` existed with full unit coverage but nothing ever
// registered it — registerCommandHandlers bound RESUME_TASK to core's
// plain handler. Three features were dead as a result: the
// ClarificationAnswered event, the worktree sidecar the clarification
// protocol doc documents, and the board's "remember this answer"
// checkbox. These tests drive the wiring, which is what was missing.
// ---------------------------------------------------------------------------

async function seedParkedTask(orch: Orchestrator, taskId: string): Promise<void> {
    const db = orch.getDb();
    db.prepare(
        "INSERT OR IGNORE INTO plans(id, project_id, status, created_at) VALUES ('pl-w', 'proj-w', 'active', 1)",
    ).run();
    db.prepare(
        `INSERT INTO tasks(id, plan_id, type, status, title, parked_reason, parked_question)
         VALUES (?, 'pl-w', 'implement', 'in-progress', 'Bump handler', 'clarification',
                 'Bump the version even though it is current?')`,
    ).run(taskId);
}

test('answering a parked task emits ClarificationAnswered through the registered handler', async () => {
    const orch = makeOrchestrator();
    await orch.start();
    try {
        await seedParkedTask(orch, 'T-W1');
        await orch.getCommandBus().send({
            type: 'ResumeTask',
            actor: 'operator',
            issuedAt: 1,
            payload: {
                taskId: 'T-W1',
                decision: 'approve',
                answer: 'No. Leave the version alone.',
            },
        });

        const types = (
            orch.getDb()
                .prepare('SELECT type FROM events ORDER BY seq')
                .all() as Array<{ type: string }>
        ).map((r) => r.type);
        assert.ok(
            types.includes('ClarificationAnswered'),
            `expected ClarificationAnswered, got ${JSON.stringify(types)}`,
        );
        assert.ok(types.includes('TaskResumed'), 'the resume itself must still happen');
    } finally {
        await orch.stop();
    }
});

test('the answer is written to the task worktree as clarification-answer.md', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-sidecar-'));
    const orch = makeOrchestrator();
    await orch.start();
    try {
        await seedParkedTask(orch, 'T-W2');
        // Register a worktree for the task the way ensureWorktree would.
        orch.getDb()
            .prepare(
                `INSERT INTO task_worktrees(task_id, repo_id, branch, path, created_at)
                 VALUES ('T-W2', 'repo-a', 'task/T-W2', ?, 1)`,
            )
            .run(dir);

        await orch.getCommandBus().send({
            type: 'ResumeTask',
            actor: 'operator',
            issuedAt: 1,
            payload: {
                taskId: 'T-W2',
                decision: 'approve',
                answer: 'No. Leave the version alone.',
            },
        });

        const sidecar = path.join(dir, 'clarification-answer.md');
        assert.ok(fs.existsSync(sidecar), 'a file-first agent reads this next to TASK.md');
        assert.equal(fs.readFileSync(sidecar, 'utf8'), 'No. Leave the version alone.');
    } finally {
        await orch.stop();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('a rejection writes feedback.md to the worktree', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-feedback-'));
    const orch = makeOrchestrator();
    await orch.start();
    try {
        await seedParkedTask(orch, 'T-W3');
        orch.getDb()
            .prepare(
                `INSERT INTO task_worktrees(task_id, repo_id, branch, path, created_at)
                 VALUES ('T-W3', 'repo-a', 'task/T-W3', ?, 1)`,
            )
            .run(dir);

        await orch.getCommandBus().send({
            type: 'ResumeTask',
            actor: 'operator',
            issuedAt: 1,
            payload: { taskId: 'T-W3', decision: 'reject', feedback: 'undo the version bump' },
        });

        assert.equal(
            fs.readFileSync(path.join(dir, 'feedback.md'), 'utf8'),
            'undo the version bump',
        );
    } finally {
        await orch.stop();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('remember=true appends the Q and the A to the project agent memory', async () => {
    const projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-memory-'));
    const orch = new Orchestrator({
        dbPath: IN_MEMORY_DB,
        flowsDir: FLOWS_DIR,
        logger: new SilentLogger(),
        projectsRoot,
        idGen: { newId: (): string => 'task-x' },
    });
    await orch.start();
    try {
        await seedParkedTask(orch, 'T-W4');
        await orch.getCommandBus().send({
            type: 'ResumeTask',
            actor: 'operator',
            issuedAt: 1,
            payload: {
                taskId: 'T-W4',
                decision: 'approve',
                answer: 'Leave the version alone.',
                remember: true,
            },
        });

        const file = path.join(projectsRoot, 'proj-w', 'agent-memory.jsonl');
        assert.ok(fs.existsSync(file), 'the remember checkbox must reach project memory');
        const entry = JSON.parse(fs.readFileSync(file, 'utf8').trim()) as {
            source: string;
            taskIdentifier: string;
            feedback: string;
        };
        assert.equal(entry.source, 'clarification');
        assert.equal(entry.taskIdentifier, 'T-W4');
        assert.match(entry.feedback, /Q: Bump the version even though it is current\?/);
        assert.match(entry.feedback, /A: Leave the version alone\./);
    } finally {
        await orch.stop();
        fs.rmSync(projectsRoot, { recursive: true, force: true });
    }
});

test('remember=false leaves the project memory untouched', async () => {
    const projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-memory-off-'));
    const orch = new Orchestrator({
        dbPath: IN_MEMORY_DB,
        flowsDir: FLOWS_DIR,
        logger: new SilentLogger(),
        projectsRoot,
        idGen: { newId: (): string => 'task-x' },
    });
    await orch.start();
    try {
        await seedParkedTask(orch, 'T-W5');
        await orch.getCommandBus().send({
            type: 'ResumeTask',
            actor: 'operator',
            issuedAt: 1,
            payload: { taskId: 'T-W5', decision: 'approve', answer: 'just this once' },
        });
        assert.equal(
            fs.existsSync(path.join(projectsRoot, 'proj-w', 'agent-memory.jsonl')),
            false,
        );
    } finally {
        await orch.stop();
        fs.rmSync(projectsRoot, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// Task-id collisions between plans (field case: plan-1786543915236-elif).
//
// The task id is `<projectAbbr>-<planAbbr>-<seq>`, and the plan abbr is
// initials-minus-stopwords — so "deploy products api to staging" and
// "deploy products api to stg" BOTH derive DPAS. The second plan's tasks
// then mint ids owned by the first.
//
// What that cost: the TaskCreated projection saw the id already present,
// took its re-decompose branch, and reset the OLD plan's rows without
// touching `plan_id`. The operator's new plan ended up with zero tasks —
// a Draft card showing only their brief — while the deploy that actually
// ran was recorded against a plan archived three weeks earlier.
// ---------------------------------------------------------------------------

test('a TaskCreated for an id owned by another plan REPOINTS it, loudly', async () => {
    const errors: Array<Record<string, unknown>> = [];
    const orch = new Orchestrator({
        dbPath: IN_MEMORY_DB,
        flowsDir: FLOWS_DIR,
        idGen: { newId: (): string => 'task-x' },
        logger: {
            info: (): void => {},
            debug: (): void => {},
            warn: (): void => {},
            error: (message: string, ctx?: Record<string, unknown>): void => {
                if (message.includes('collides with another plan')) {
                    errors.push({ message, ...(ctx ?? {}) });
                }
            },
        },
    });
    await orch.start();
    try {
        const db = orch.getDb();
        const bus = orch.getEventBus();
        for (const planId of ['plan-old', 'plan-new']) {
            db.prepare(
                "INSERT INTO plans(id, project_id, status, created_at) VALUES (?, 'p', 'active', 1)",
            ).run(planId);
            db.prepare(
                `INSERT INTO sidebar_plans(plan_id, pid, name, status, updated_at)
                 VALUES (?, 'p', ?, 'active', 1)`,
            ).run(planId, planId);
        }
        // The old plan's task, exactly as the first decomposition left it.
        db.prepare(
            `INSERT INTO tasks(id, plan_id, type, status)
             VALUES ('L-DPAS-001', 'plan-old', 'deploy-azure', 'done')`,
        ).run();

        await bus.publish({
            type: 'TaskCreated',
            v: 1,
            occurredAt: 10,
            idempotencyKey: 'collide-1',
            payload: {
                taskId: 'L-DPAS-001',
                planId: 'plan-new',
                type: 'deploy-azure',
                title: 'Deploy products api to stg',
            },
        });

        const row = db
            .prepare('SELECT plan_id, status FROM tasks WHERE id = ?')
            .get('L-DPAS-001') as { plan_id: string; status: string };
        assert.equal(
            row.plan_id,
            'plan-new',
            'the task must belong to the plan that just created it',
        );
        // Not asserting the final status: TaskCreated cascades into
        // approve/dispatch, which owns it from here. What this fold owns
        // is WHICH PLAN the row belongs to.
        assert.equal(errors.length, 1, 'a silent hijack is what caused the field case');
        assert.equal(errors[0]!.previousPlanId, 'plan-old');
    } finally {
        await orch.stop();
    }
});

test('re-decomposing the SAME plan keeps its tasks and logs nothing', async () => {
    const orch = makeOrchestrator();
    await orch.start();
    try {
        const db = orch.getDb();
        const bus = orch.getEventBus();
        db.prepare(
            "INSERT INTO plans(id, project_id, status, created_at) VALUES ('pl-same', 'p', 'active', 1)",
        ).run();
        db.prepare(
            `INSERT INTO tasks(id, plan_id, type, status)
             VALUES ('L-SAME-001', 'pl-same', 'implement', 'done')`,
        ).run();

        await bus.publish({
            type: 'TaskCreated',
            v: 1,
            occurredAt: 10,
            idempotencyKey: 'same-1',
            payload: {
                taskId: 'L-SAME-001',
                planId: 'pl-same',
                type: 'implement',
                title: 'Second attempt',
            },
        });

        const row = db
            .prepare('SELECT plan_id, title FROM tasks WHERE id = ?')
            .get('L-SAME-001') as { plan_id: string; title: string };
        assert.equal(row.plan_id, 'pl-same', 'the plan keeps its own task');
        assert.equal(row.title, 'Second attempt', 'content refreshes on re-decompose');
    } finally {
        await orch.stop();
    }
});

test('TaskFieldsUpdated is folded DURABLY, and a partial edit leaves the other column alone', async () => {
    // Field bug, found while adding chat-driven task edits: nothing on the
    // worker side subscribed to TaskFieldsUpdated. The board folded it in
    // memory only, so an edit looked applied until the next reload — and
    // it never reached the agent at all, since the spawn prompt reads
    // tasks.title/tasks.description. That silently defeated the
    // interrupt-retry modal's feedback box too, which dispatches
    // EditTask{description}.
    const orch = makeOrchestrator();
    await orch.start();
    try {
        const db = orch.getDb();
        const bus = orch.getEventBus();
        db.prepare(
            "INSERT INTO plans(id, project_id, status, created_at) VALUES ('pl-edit', 'p', 'active', 1)",
        ).run();
        db.prepare(
            "INSERT INTO tasks(id, plan_id, type, status, title, description)"
            + " VALUES ('T-EDIT', 'pl-edit', 'implement', 'pending', 'Old title', 'Old body')",
        ).run();

        await bus.publish({
            type: 'TaskFieldsUpdated',
            v: 1,
            occurredAt: 1,
            idempotencyKey: 'edit-test:both',
            payload: { taskId: 'T-EDIT', title: 'New title', description: 'New body' },
        });
        const both = db
            .prepare('SELECT title, description FROM tasks WHERE id = ?')
            .get('T-EDIT') as { title: string; description: string };
        assert.equal(both.title, 'New title');
        assert.equal(both.description, 'New body');

        // Instructions-only / title-only edits are the common shape from
        // the chat agent. An absent field must NOT null the column.
        await bus.publish({
            type: 'TaskFieldsUpdated',
            v: 1,
            occurredAt: 2,
            idempotencyKey: 'edit-test:title-only',
            payload: { taskId: 'T-EDIT', title: 'Newer title' },
        });
        const partial = db
            .prepare('SELECT title, description FROM tasks WHERE id = ?')
            .get('T-EDIT') as { title: string; description: string };
        assert.equal(partial.title, 'Newer title');
        assert.equal(partial.description, 'New body', 'an omitted field must survive');
    } finally {
        await orch.stop();
    }
});
