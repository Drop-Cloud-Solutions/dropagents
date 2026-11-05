/**
 * A-fix (missed-file class): the decomposer must see the ORIGINAL brief
 * alongside the approved plan. For requirement-fanned plans the brief
 * carries the full architecture design, so losing it meant the decomposer
 * only ever saw the planner's re-summarisation and cross-system details
 * were unrecoverable.
 *
 *   1. DECOMPOSE_PLAN spawns the decomposer with a `# Brief` section
 *      containing getBriefContent's text, plus the approved plan.
 *   2. When no brief resolves (legacy plans), the prompt has no empty
 *      `# Brief` heading — the section is omitted entirely.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { CommandBus } from '../../core/commands/bus';
import { EventBus } from '../../core/events/bus';
import { EventStore } from '../../core/events/store';
import { applyMigrations, openDatabase, type Db } from '../../core/state/migrations';
import type { AgentHandle, AgentRunner, AgentSpec, IdGen, Logger } from '../../core/ports';

import { registerCommandHandlers } from './handlers';

class SilentLogger implements Logger {
    info(): void {}
    warn(): void {}
    error(): void {}
    debug(): void {}
}

class CapturingRunner implements AgentRunner {
    readonly specs: AgentSpec[] = [];
    private counter = 0;
    start(spec: AgentSpec): AgentHandle {
        this.specs.push(spec);
        this.counter += 1;
        return { id: `agent-${this.counter}`, spec };
    }
    async interrupt(): Promise<void> {}
}

function makeHarness(briefContent?: string): {
    db: Db;
    cmdBus: CommandBus<unknown>;
    runner: CapturingRunner;
    cleanup: () => void;
} {
    const db = openDatabase(':memory:');
    applyMigrations(db);
    const logger = new SilentLogger();
    const store = new EventStore(db);
    const bus = new EventBus(store, logger);
    const cmdBus = new CommandBus<unknown>(bus, () => undefined);
    const idGen: IdGen = { newId: (): string => 'task-x' };
    const runner = new CapturingRunner();

    registerCommandHandlers(cmdBus, {
        clock: () => 1_700_000_000_000,
        idGen,
        logger,
        defaultFlowId: 'echo',
        defaultProjectId: 'proj-brief',
        defaultTaskType: 'echo',
        agentRunner: runner,
        registerAgent: (): void => {},
        deferAgentStart: (run): void => run(),
        ...(briefContent !== undefined
            ? { getBriefContent: (): string => briefContent }
            : {}),
    });

    return { db, cmdBus, runner, cleanup: (): void => { db.close(); } };
}

test('DECOMPOSE_PLAN threads the stored brief into the decomposer prompt', async () => {
    const h = makeHarness('ORIGINAL BRIEF + FULL ARCHITECTURE DESIGN');
    try {
        await h.cmdBus.send({
            type: 'DecomposePlan',
            actor: 'operator',
            issuedAt: 1,
            payload: {
                planId: 'plan-b',
                projectId: 'proj-brief',
                approvedContent: 'THE APPROVED PLAN BODY',
                conventions: {},
            },
        });
        assert.equal(h.runner.specs.length, 1);
        const prompt = h.runner.specs[0]!.prompt ?? '';
        assert.ok(prompt.includes('# Brief'), 'prompt must contain a # Brief section');
        assert.ok(prompt.includes('ORIGINAL BRIEF + FULL ARCHITECTURE DESIGN'));
        assert.ok(prompt.includes('# Approved implementation plan'));
        assert.ok(prompt.includes('THE APPROVED PLAN BODY'));
        // Anchor on newline-prefixed headings: the persona file itself
        // mentions "## Approved implementation plan" inline, which a bare
        // indexOf would match first.
        assert.ok(
            prompt.indexOf('\n# Brief') < prompt.indexOf('\n# Approved implementation plan'),
            'brief renders before the approved plan',
        );
    } finally {
        h.cleanup();
    }
});

test('DECOMPOSE_PLAN without a resolvable brief omits the # Brief section', async () => {
    const h = makeHarness(undefined);
    try {
        await h.cmdBus.send({
            type: 'DecomposePlan',
            actor: 'operator',
            issuedAt: 1,
            payload: {
                planId: 'plan-legacy',
                projectId: 'proj-brief',
                approvedContent: 'PLAN ONLY',
                conventions: {},
            },
        });
        assert.equal(h.runner.specs.length, 1);
        const prompt = h.runner.specs[0]!.prompt ?? '';
        // Newline-anchored: the decomposer persona mentions "`# Brief`"
        // inline, which a bare includes() would false-positive on.
        assert.ok(!prompt.includes('\n# Brief'), 'no empty # Brief heading');
        assert.ok(prompt.includes('PLAN ONLY'));
    } finally {
        h.cleanup();
    }
});
