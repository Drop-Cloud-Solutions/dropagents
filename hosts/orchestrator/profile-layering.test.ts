/**
 * End to end through a real Orchestrator: an active operator profile's
 * flows, pipeline.yaml keys and personas all take effect — and a broken
 * profile stops boot instead of silently running the defaults.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { activateProfile } from '../../config/profile';
import { CommandBus } from '../../core/commands/bus';
import { EventBus } from '../../core/events/bus';
import { EventStore } from '../../core/events/store';
import { applyMigrations, openDatabase } from '../../core/state/migrations';
import type { AgentHandle, AgentRunner, AgentSpec, Logger } from '../../core/ports';

import { Orchestrator } from './main';
import { registerCommandHandlers, registerPlanLifecycleAgentHandlers, type LifecycleAgentContext } from './handlers';
import type { StackHooks } from '../../core/ports/StackHooks';

const FLOWS_DIR = path.resolve(__dirname, '..', '..', 'config', 'flows');

class SilentLogger implements Logger {
    info(): void {}
    warn(): void {}
    error(): void {}
    debug(): void {}
}

function withProfile<T>(fn: (home: string) => Promise<T>): Promise<T> {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-profile-'));
    activateProfile(home);
    return fn(home).finally(() => {
        activateProfile(undefined);
        fs.rmSync(home, { recursive: true, force: true });
    });
}

function orchestrator(): Orchestrator {
    return new Orchestrator({ dbPath: ':memory:', flowsDir: FLOWS_DIR, logger: new SilentLogger() });
}

const PROFILE_FLOW = [
    'on: TaskApproved',
    'start_mode: auto',
    'steps:',
    '  - id: mine',
    '    agent: echo',
    '    model: none',
    '    on_success: emit:TaskFinished',
    '',
].join('\n');

test('a profile flow is loaded at boot, and one saved after boot arrives on reload', async () => {
    await withProfile(async (home) => {
        fs.mkdirSync(path.join(home, 'flows'));
        fs.writeFileSync(path.join(home, 'flows', 'my-flow.yaml'), PROFILE_FLOW);
        const orch = orchestrator();
        await orch.start();
        try {
            assert.ok(orch.getFlows().has('my-flow'), 'profile flow loaded at boot');
            assert.ok(orch.getFlows().has('implement'), 'repo flows still there');

            // The manager UI saves a second one while the worker runs; Apply
            // (reload) must pick it up without a restart.
            fs.writeFileSync(path.join(home, 'flows', 'later.yaml'), PROFILE_FLOW);
            const { flowIds } = orch.reloadFlows();
            assert.ok(flowIds.includes('later'));
        } finally {
            await orch.stop();
        }
    });
});

test('a malformed profile pipeline.yaml stops boot, naming the file', async () => {
    // Falling back to defaults here would run a configuration the operator
    // never wrote — the silent-failure class this codebase keeps paying for.
    await withProfile(async (home) => {
        fs.writeFileSync(path.join(home, 'pipeline.yaml'), 'issue_tracker: [unclosed\n');
        const orch = orchestrator();
        await assert.rejects(() => orch.start(), (err: Error) => err.message.includes(path.join(home, 'pipeline.yaml')));
        await orch.stop().catch(() => undefined);
    });
});

test('an invalid value in the profile pipeline.yaml is rejected like one in the repo file', async () => {
    await withProfile(async (home) => {
        fs.writeFileSync(path.join(home, 'pipeline.yaml'), 'issue_tracker: carrier-pigeon\n');
        const orch = orchestrator();
        await assert.rejects(() => orch.start(), /issue_tracker/);
        await orch.stop().catch(() => undefined);
    });
});

test('the agents are handed the profile persona, extension included', async () => {
    await withProfile(async (home) => {
        fs.mkdirSync(path.join(home, 'agents'));
        fs.writeFileSync(path.join(home, 'agents', 'decomposer.extend.md'), '## Our house rules\n\nPROFILE-EXTENSION-MARKER\n');

        const db = openDatabase(':memory:');
        applyMigrations(db);
        const logger = new SilentLogger();
        const bus = new EventBus(new EventStore(db), logger);
        const cmdBus = new CommandBus<unknown>(bus, () => undefined);
        const specs: AgentSpec[] = [];
        const runner: AgentRunner = {
            start(spec: AgentSpec): AgentHandle {
                specs.push(spec);
                return { id: `agent-${specs.length}`, spec };
            },
            async interrupt(): Promise<void> {},
        };
        registerCommandHandlers(cmdBus, {
            clock: () => 1,
            idGen: { newId: (): string => 'x' },
            logger,
            defaultFlowId: 'echo',
            defaultProjectId: 'p',
            defaultTaskType: 'echo',
            agentRunner: runner,
            registerAgent: (): void => {},
            deferAgentStart: (run): void => run(),
        });
        try {
            await cmdBus.send({
                type: 'DecomposePlan',
                actor: 'operator',
                issuedAt: 1,
                payload: { planId: 'plan-x', projectId: 'p', approvedContent: 'THE PLAN', conventions: {} },
            });
            const prompt = specs[0]?.prompt ?? '';
            assert.match(prompt, /PROFILE-EXTENSION-MARKER/);
            assert.match(prompt, /# ROLE: Decomposer Agent/, 'the repo base persona is kept when extending');
            assert.ok(
                prompt.indexOf('PROFILE-EXTENSION-MARKER') < prompt.indexOf('<!-- BEGIN include: _shared/clarification-block.md -->'),
                'the escape hatch stays last',
            );
        } finally {
            db.close();
        }
    });
});

// ---------------------------------------------------------------------------
// Stack packs
// ---------------------------------------------------------------------------

test('with the dotnet-azure pack on, its task types exist; off, they do not', async () => {
    await withProfile(async (home) => {
        activateProfile(home, { packs: ['dotnet-azure'] });
        const on = orchestrator();
        await on.start();
        try {
            assert.ok(on.getFlows().has('deploy-nuget'), 'pack flows are loaded');
            assert.ok(on.taskTypes().decomposable().has('deploy-nuget'), 'and the decomposer may emit them');
            assert.ok(on.taskTypes().sharedDeployWorktree().has('deploy-azure'));
        } finally {
            await on.stop();
        }

        activateProfile(home, { packs: [] });
        const off = orchestrator();
        await off.start();
        try {
            assert.equal(off.getFlows().has('deploy-nuget'), false);
            assert.equal(off.taskTypes().decomposable().has('deploy-nuget'), false,
                'a type nothing could start must not be emittable');
            assert.ok(off.taskTypes().decomposable().has('implement'));
        } finally {
            await off.stop();
        }
    });
});

test('an unknown pack stops boot, naming the packs that exist', async () => {
    await withProfile(async (home) => {
        activateProfile(home, { packs: ['no-such-pack'] });
        const orch = orchestrator();
        await assert.rejects(() => orch.start(), /unknown pack "no-such-pack".*dotnet-azure/);
        await orch.stop().catch(() => undefined);
    });
});

// The decompose checks run only through the enabled packs' hooks.

const JSON_OUTPUT = JSON.stringify({
    plan: {
        id: 'plan-h',
        title: 'P',
        description: 'd',
        tasks: [{
            id: 'task-001',
            title: 'Remove the old thing',
            type: 'implement',
            status: 'pending',
            agent: 'developer',
            dependencies: [],
            context: { description: 'Delete it.', files_to_delete: ['src/Old.cs'] },
        }],
    },
});

async function decomposeWith(hooks: StackHooks[] | undefined): Promise<Array<{ type: string; payload: Record<string, unknown> }>> {
    const db = openDatabase(':memory:');
    applyMigrations(db);
    const logger = new SilentLogger();
    const bus = new EventBus(new EventStore(db), logger);
    const lifecycleAgents = new Map<string, LifecycleAgentContext>();
    registerPlanLifecycleAgentHandlers(bus, {
        clock: () => 1,
        logger,
        agentRunner: { start: (spec: AgentSpec): AgentHandle => ({ id: 'a', spec }), interrupt: async () => {} },
        registerAgent: () => {},
        deferAgentStart: (run) => run(),
        lifecycleAgents,
        db,
        resolveRepoSpec: async () => ({ repoPath: os.tmpdir() }),
        ...(hooks !== undefined ? { stackHooks: hooks } : {}),
    });
    lifecycleAgents.set('agent-1', { kind: 'decomposer', planId: 'plan-h', projectId: 'p' });
    await bus.publish({
        type: 'AgentFinished', v: 1, occurredAt: 1, idempotencyKey: 'f1',
        payload: { agentId: 'agent-1', role: 'decomposer', outcome: 'success', content: JSON_OUTPUT },
    });
    const rows = db.prepare('SELECT type, payload FROM events ORDER BY seq').all() as Array<{ type: string; payload: string }>;
    db.close();
    return rows.map((r) => ({ type: r.type, payload: JSON.parse(r.payload) as Record<string, unknown> }));
}

test('a pack\'s deletion check can fail a decomposition, with its own message', async () => {
    const events = await decomposeWith([{
        packId: 'test-pack',
        scanDeletions: () => ({ edges: new Map(), failure: 'src/Old.cs is still referenced by src/Uses.cs' }),
    }]);
    const failed = events.find((e) => e.type === 'PlanDecomposeFailed');
    assert.ok(failed, 'the hook blocked the decomposition');
    assert.match(String(failed.payload.error), /still referenced by src\/Uses\.cs/);
});

test('with no pack enabled no language check runs — core does not guess at C#', async () => {
    const events = await decomposeWith(undefined);
    assert.equal(events.some((e) => e.type === 'PlanDecomposeFailed'), false);
    assert.ok(events.some((e) => e.type === 'PlanDecomposed'));
});
