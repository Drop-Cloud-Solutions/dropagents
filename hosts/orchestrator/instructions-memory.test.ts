/**
 * `interrupt-restart` — the third agent-memory source that was declared in
 * the enum and never written by anything.
 *
 * The operator stops a task, types instructions for the next run, and
 * restarts it. `tasks.instructions` reaches THAT task's next prompt and
 * nothing else, so the correction was invisible to every future plan for
 * the same project.
 *
 * The line drawn here matters as much as the recording: instructions
 * written BEFORE the first run are task scope, not a correction. Filing
 * every up-front brief as "prior operator feedback" would drown the real
 * corrections in the planner's prompt.
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { CommandBus } from '../../core/commands/bus';
import { EventBus } from '../../core/events/bus';
import { EventStore } from '../../core/events/store';
import { applyMigrations, openDatabase, type Db } from '../../core/state/migrations';
import type { AgentHandle, AgentRunner, AgentSpec, IdGen, Logger } from '../../core/ports';
import { TaskOpsCommands } from '../../core/commands';
import { AgentMemoryStore, type AgentMemoryEntry } from '../../core/projects/agent-memory';

import { registerCommandHandlers, type LifecycleAgentContext } from './handlers';

type TestFn = (name: string, fn: () => void | Promise<void>) => void;

const test: TestFn = (((): TestFn => {
    if (process.env.VITEST) {
        const gt = (globalThis as { test?: TestFn }).test;
        if (typeof gt !== 'function') {
            throw new Error('instructions-memory.test.ts: VITEST=true but globalThis.test is missing');
        }
        return gt;
    }
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    const nt = require('node:test') as { test: TestFn };
    return nt.test;
})());

class SilentLogger implements Logger {
    info(): void {}
    warn(): void {}
    error(): void {}
    debug(): void {}
}

class NoopRunner implements AgentRunner {
    start(spec: AgentSpec): AgentHandle {
        return { id: 'agent-1', spec };
    }
    async interrupt(): Promise<void> {}
}

interface Harness {
    readonly db: Db;
    readonly cmdBus: CommandBus<unknown>;
    readonly memory: AgentMemoryStore;
    readonly cleanup: () => void;
}

function makeHarness(): Harness {
    const db = openDatabase(':memory:');
    applyMigrations(db);
    const logger = new SilentLogger();
    const bus = new EventBus(new EventStore(db), logger);
    const cmdBus = new CommandBus<unknown>(bus, () => undefined);
    const projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'instr-memory-'));
    const memory = new AgentMemoryStore(projectsRoot);
    const idGen: IdGen = { newId: (): string => 'task-1' };
    registerCommandHandlers(cmdBus, {
        clock: () => 1_700_000_000_000,
        idGen,
        logger,
        defaultFlowId: 'echo',
        defaultProjectId: 'proj-test',
        defaultTaskType: 'echo',
        agentRunner: new NoopRunner(),
        registerAgent: () => undefined,
        deferAgentStart: (run): void => run(),
        agentMemory: memory,
        lifecycleAgents: new Map<string, LifecycleAgentContext>(),
        db,
    });
    return {
        db,
        cmdBus,
        memory,
        cleanup: (): void => {
            db.close();
            fs.rmSync(projectsRoot, { recursive: true, force: true });
        },
    };
}

/** Seed a task; `ran` adds the `agent_runs` row that means "has run". */
function seedTask(db: Db, taskId: string, ran: boolean): void {
    db.prepare(
        "INSERT OR IGNORE INTO plans(id, project_id, status, created_at) VALUES ('pl-1', 'proj-1', 'active', 1)",
    ).run();
    db.prepare(
        `INSERT INTO tasks(id, plan_id, type, status, title)
         VALUES (?, 'pl-1', 'implement', 'pending', 'Add the widget')`,
    ).run(taskId);
    if (ran) {
        db.prepare(
            `INSERT INTO agent_runs(id, task_id, role, status, started_at)
             VALUES (?, ?, 'developer', 'finished', 1)`,
        ).run(`run-${taskId}`, taskId);
    }
}

async function setInstructions(h: Harness, taskId: string, instructions: string): Promise<void> {
    await h.cmdBus.send({
        type: TaskOpsCommands.SET_TASK_INSTRUCTIONS,
        actor: 'operator',
        issuedAt: 1,
        payload: { taskId, instructions },
    } as never);
}

test('instructions on a task that ALREADY RAN are filed as interrupt-restart memory', async () => {
    const h = makeHarness();
    try {
        seedTask(h.db, 'T-1', true);

        await setInstructions(h, 'T-1', 'Keep the existing public API — callers depend on it.');

        const entries = h.memory.read('proj-1');
        assert.equal(entries.length, 1);
        const entry = entries[0] as AgentMemoryEntry;
        assert.equal(entry.source, 'interrupt-restart');
        assert.equal(entry.taskIdentifier, 'T-1');
        assert.equal(entry.taskTitle, 'Add the widget');
        assert.equal(entry.feedback, 'Keep the existing public API — callers depend on it.');
    } finally {
        h.cleanup();
    }
});

test('instructions written BEFORE the first run are NOT memory', async () => {
    // Task scope, not a correction. Recording these would bury the real
    // corrections under every up-front brief the operator ever typed.
    const h = makeHarness();
    try {
        seedTask(h.db, 'T-2', false);

        await setInstructions(h, 'T-2', 'Use the repository pattern here.');

        assert.deepEqual(h.memory.read('proj-1'), []);
    } finally {
        h.cleanup();
    }
});

test('clearing instructions records nothing', async () => {
    // An empty string is the documented way to CLEAR them; an empty
    // memory entry would be advice about nothing.
    const h = makeHarness();
    try {
        seedTask(h.db, 'T-3', true);

        await setInstructions(h, 'T-3', '   ');

        assert.deepEqual(h.memory.read('proj-1'), []);
    } finally {
        h.cleanup();
    }
});

test('the TaskInstructionsSet event is emitted either way', async () => {
    // The memory write is a side effect of the command, never a gate on
    // it: the operator's instructions must reach the task regardless.
    const h = makeHarness();
    try {
        seedTask(h.db, 'T-4', true);

        await setInstructions(h, 'T-4', 'Do it differently.');

        const rows = h.db
            .prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'TaskInstructionsSet'")
            .get() as { n: number };
        assert.equal(rows.n, 1);
    } finally {
        h.cleanup();
    }
});

test('an unknown task still emits the event and records no memory', async () => {
    const h = makeHarness();
    try {
        await setInstructions(h, 'T-missing', 'anything');

        assert.deepEqual(h.memory.read('proj-1'), []);
        const rows = h.db
            .prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'TaskInstructionsSet'")
            .get() as { n: number };
        assert.equal(rows.n, 1);
    } finally {
        h.cleanup();
    }
});
