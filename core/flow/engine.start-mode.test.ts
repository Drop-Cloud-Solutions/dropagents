/**
 * AP-IFG-002 / AP-VP-007: start_mode tests.
 *
 * AP-VP-007 collapsed the engine's `start_mode` branches into the per-step
 * approval gate. The engine no longer reads `start_mode` to gate first-step
 * dispatch; the loader still parses and validates the field so YAML stays
 * forward/backwards compatible.
 *
 *   1. `start_mode: 'auto'` — TaskCreated dispatches when the first step's
 *      effective approval resolves to `'auto'`.
 *   2. `start_mode: 'approval-required'` is informational now: the engine
 *      routes TaskCreated through the approval gate, so an agent first step
 *      (which defaults to `'auto'`) dispatches on TaskCreated. See
 *      `engine.approval-gate.test.ts` for the parking case where the
 *      step's `approval` is set explicitly to `'required'`.
 *   3. legacy (start_mode absent) — same: gate-driven dispatch.
 * Plus the loader rejection path for unknown start_mode values.
 *
 * Dual-runner discovery
 * ---------------------
 * The repo's own test command (`npm test` → `node --test --import tsx`,
 * see package.json) uses Node's built-in `node:test` runner. The review
 * pipeline however runs `npx vitest run` on the changed test file. A
 * file written against only one of those APIs gets reported as
 * "no tests" by the other and the pipeline rejects the run. The shim
 * below mirrors `hosts/orchestrator/handlers.lineage.test.ts` — it
 * picks vitest's `globalThis.test` when `process.env.VITEST` is set
 * and otherwise falls back to `node:test`'s `test()` via `require`.
 */

import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { openDatabase, applyMigrations, type Db } from '../state/migrations';
import { EventStore } from '../events/store';
import { EventBus } from '../events/bus';
import { CommandBus } from '../commands/bus';
import type { Command } from '../commands/command';
import type { Event } from '../events/event';
import type { Logger } from '../ports/Logger';
import { loadFlow } from './loader';
import type { FlowDefinition } from './types';
import {
    FlowEngine,
    FlowEvents,
    FlowCommands,
    type StartAgentPayload,
} from './engine';

// ---------------------------------------------------------------------------
// Dual-runner test() shim — see file header for rationale.
//
// Vitest v4 forbids `require('vitest')` from CJS modules, and tsc compiles
// this file to CJS per the project's tsconfig. A static `import { test }
// from 'vitest'` therefore also breaks under `node --test`. The workaround
// is to rely on vitest's `globals: true` config (see ../../vitest.config.ts)
// which puts `test` on `globalThis` inside vitest workers; outside vitest
// we fall back to `node:test`'s `test()` via plain `require`.
// ---------------------------------------------------------------------------

type TestFn = (name: string, fn: () => void | Promise<void>) => void;

const test: TestFn = (((): TestFn => {
    if (process.env.VITEST) {
        const gt = (globalThis as { test?: TestFn }).test;
        if (typeof gt !== 'function') {
            throw new Error(
                'engine.start-mode.test.ts: VITEST=true but globalThis.test is missing — '
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

class SilentLogger implements Logger {
    info(): void {}
    warn(): void {}
    error(): void {}
    debug(): void {}
}

function freshDb(): Db {
    const db = openDatabase(':memory:');
    applyMigrations(db);
    return db;
}

let evCounter = 0;
function makeEvent(type: string, payload: unknown): Event {
    evCounter++;
    return {
        type,
        v: 1,
        occurredAt: 1_700_000_000_000,
        idempotencyKey: `sm-${process.pid}-${evCounter}`,
        payload,
    };
}

function seedTask(db: Db, taskId: string): void {
    const planId = `plan-${taskId}`;
    db.prepare(
        'INSERT INTO plans(id, project_id, status, created_at) VALUES (?, ?, ?, ?)',
    ).run(planId, 'proj-1', 'approved', 1_700_000_000_000);
    db.prepare(
        'INSERT INTO tasks(id, plan_id, type, status) VALUES (?, ?, ?, ?)',
    ).run(taskId, planId, 'feature', 'created');
}

interface Harness {
    db: Db;
    bus: EventBus;
    commands: Command[];
    engine: FlowEngine;
}

function recorder(commands: Command[]): (cmd: Command) => Promise<Event[]> {
    return async (cmd) => {
        commands.push(cmd);
        return [];
    };
}

function makeHarness(flows: ReadonlyMap<string, FlowDefinition>): Harness {
    const db = freshDb();
    const logger = new SilentLogger();
    const store = new EventStore(db);
    const bus = new EventBus(store, logger);
    const cmdBus = new CommandBus<unknown>(bus, () => undefined);
    const commands: Command[] = [];
    cmdBus.register(FlowCommands.START_AGENT, recorder(commands));
    cmdBus.register(FlowCommands.FINISH_TASK, recorder(commands));
    cmdBus.register(FlowCommands.FAIL_TASK, recorder(commands));
    cmdBus.register(FlowCommands.REQUEST_INVESTIGATION, recorder(commands));
    const engine = FlowEngine.start(bus, cmdBus, flows, { db, logger });
    return { db, bus, commands, engine };
}

function startAgents(commands: ReadonlyArray<Command>): StartAgentPayload[] {
    return commands
        .filter((c) => c.type === FlowCommands.START_AGENT)
        .map((c) => c.payload as StartAgentPayload);
}

const FIRST_STEP = {
    id: 'develop',
    agent: 'developer',
    model: 'claude-sonnet-4-6',
    on_success: 'emit:TaskFinished',
} as const;

const AUTO_FLOW: FlowDefinition = {
    on: 'TaskCreated',
    start_mode: 'auto',
    steps: [FIRST_STEP],
};

const APPROVAL_FLOW: FlowDefinition = {
    on: 'TaskApproved',
    start_mode: 'approval-required',
    steps: [FIRST_STEP],
};

const LEGACY_FLOW: FlowDefinition = {
    on: 'TaskApproved',
    steps: [FIRST_STEP],
};

function tmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'ap-ifg-002-start-mode-'));
}

function writeYaml(dir: string, name: string, content: string): string {
    const full = path.join(dir, name);
    fs.writeFileSync(full, content, 'utf8');
    return full;
}

// ---------------------------------------------------------------------------
// 1. start_mode: 'auto' — TaskCreated dispatches the first step
// ---------------------------------------------------------------------------

test('start_mode: auto — TaskCreated dispatches the first step', async () => {
    const flows = new Map<string, FlowDefinition>([['auto-flow', AUTO_FLOW]]);
    const { db, bus, commands, engine } = makeHarness(flows);
    try {
        seedTask(db, 'task-auto');
        await bus.publish(
            makeEvent(FlowEvents.TASK_CREATED, {
                taskId: 'task-auto',
                flowId: 'auto-flow',
            }),
        );

        const starts = startAgents(commands);
        assert.equal(
            starts.length,
            1,
            'auto start_mode must dispatch StartAgent on TaskCreated',
        );
        assert.equal(starts[0].taskId, 'task-auto');
        assert.equal(starts[0].stepId, FIRST_STEP.id);
        assert.equal(starts[0].agent, FIRST_STEP.agent);
        assert.equal(starts[0].model, FIRST_STEP.model);

        const fs = db
            .prepare(
                'SELECT current_step FROM flow_state WHERE task_id = ?',
            )
            .get('task-auto') as { current_step: string } | undefined;
        assert.equal(
            fs?.current_step,
            FIRST_STEP.id,
            'flow_state.current_step must be persisted after the auto dispatch',
        );

        engine.stop();
    } finally {
        db.close();
    }
});

test('start_mode: auto — subsequent TaskApproved does NOT re-dispatch', async () => {
    const flows = new Map<string, FlowDefinition>([['auto-flow', AUTO_FLOW]]);
    const { db, bus, commands, engine } = makeHarness(flows);
    try {
        seedTask(db, 'task-auto-approve');
        await bus.publish(
            makeEvent(FlowEvents.TASK_CREATED, {
                taskId: 'task-auto-approve',
                flowId: 'auto-flow',
            }),
        );
        const afterCreated = startAgents(commands).length;
        assert.equal(afterCreated, 1, 'precondition: TaskCreated dispatched once');

        // A late TaskApproved (e.g. from an operator who still hit Approve)
        // must be a no-op for an auto flow — a duplicate StartAgent would
        // start two agents racing on the same task.
        await bus.publish(
            makeEvent(FlowEvents.TASK_APPROVED, {
                taskId: 'task-auto-approve',
                flowId: 'auto-flow',
            }),
        );

        assert.equal(
            startAgents(commands).length,
            afterCreated,
            'TaskApproved must not double-dispatch an auto flow',
        );

        engine.stop();
    } finally {
        db.close();
    }
});

// ---------------------------------------------------------------------------
// 2. start_mode: 'approval-required' — engine no longer reads start_mode,
//    so the per-step approval gate is the single decider. With the default
//    `approval='auto'` resolution for an agent step, TaskCreated dispatches
//    regardless of the start_mode label on the flow (AP-VP-007).
// ---------------------------------------------------------------------------

test('start_mode: approval-required is ignored — agent first step (gate=auto) still dispatches on TaskCreated', async () => {
    const flows = new Map<string, FlowDefinition>([
        ['approval-flow', APPROVAL_FLOW],
    ]);
    const { db, bus, commands, engine } = makeHarness(flows);
    try {
        seedTask(db, 'task-approval');
        await bus.publish(
            makeEvent(FlowEvents.TASK_CREATED, {
                taskId: 'task-approval',
                flowId: 'approval-flow',
            }),
        );

        const starts = startAgents(commands);
        assert.equal(
            starts.length,
            1,
            'agent steps default to approval=auto via the gate; start_mode is no longer consulted',
        );
        assert.equal(starts[0].stepId, FIRST_STEP.id);

        engine.stop();
    } finally {
        db.close();
    }
});

// ---------------------------------------------------------------------------
// 3. legacy (start_mode absent) — same behaviour: the step's resolved
//    approval value (not start_mode) drives dispatch (AP-VP-007).
// ---------------------------------------------------------------------------

test('legacy (no start_mode) — agent first step (gate=auto) dispatches on TaskCreated', async () => {
    const flows = new Map<string, FlowDefinition>([['legacy-flow', LEGACY_FLOW]]);
    const { db, bus, commands, engine } = makeHarness(flows);
    try {
        seedTask(db, 'task-legacy');
        await bus.publish(
            makeEvent(FlowEvents.TASK_CREATED, {
                taskId: 'task-legacy',
                flowId: 'legacy-flow',
            }),
        );

        const starts = startAgents(commands);
        assert.equal(
            starts.length,
            1,
            'legacy flows route through the approval gate; agent steps default to auto',
        );
        assert.equal(starts[0].stepId, FIRST_STEP.id);

        engine.stop();
    } finally {
        db.close();
    }
});

// ---------------------------------------------------------------------------
// 4. Loader: rejection path for unknown start_mode values
// ---------------------------------------------------------------------------

test('loadFlow rejects start_mode values outside the closed union', () => {
    const dir = tmpDir();
    const file = writeYaml(
        dir,
        'bad-start-mode.yaml',
        `on: TaskCreated
start_mode: eventually
steps:
  - id: s
    agent: developer
    model: m
    on_success: emit:done
`,
    );
    assert.throws(
        () => loadFlow(file),
        (err: unknown) =>
            err instanceof Error &&
            err.message.includes(file) &&
            /start_mode/.test(err.message) &&
            /"auto"/.test(err.message) &&
            /"approval-required"/.test(err.message),
    );
});

test('loadFlow accepts start_mode: auto and exposes it on FlowDefinition', () => {
    const dir = tmpDir();
    const file = writeYaml(
        dir,
        'auto.yaml',
        `on: TaskCreated
start_mode: auto
steps:
  - id: s
    agent: developer
    model: m
    on_success: emit:done
`,
    );
    const flow = loadFlow(file);
    assert.equal(flow.start_mode, 'auto');
});

test('loadFlow accepts start_mode: approval-required and exposes it on FlowDefinition', () => {
    const dir = tmpDir();
    const file = writeYaml(
        dir,
        'approval.yaml',
        `on: TaskApproved
start_mode: approval-required
steps:
  - id: s
    agent: developer
    model: m
    on_success: emit:done
`,
    );
    const flow = loadFlow(file);
    assert.equal(flow.start_mode, 'approval-required');
});

test('loadFlow leaves start_mode undefined when the field is absent (legacy)', () => {
    const dir = tmpDir();
    const file = writeYaml(
        dir,
        'legacy.yaml',
        `on: TaskApproved
steps:
  - id: s
    agent: developer
    model: m
    on_success: emit:done
`,
    );
    const flow = loadFlow(file);
    assert.equal(flow.start_mode, undefined);
});
