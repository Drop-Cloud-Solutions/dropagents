import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { AgentHandle, AgentRunner, AgentSpec } from '../../core/ports';

import {
    RoleRoutingAgentRunner,
    type RoutableRunner,
} from './RoleRoutingAgentRunner';

// ---------------------------------------------------------------------------
// Test double — minimal RoutableRunner that records every call so each test
// can assert which inner adapter the router dispatched to.
// ---------------------------------------------------------------------------

interface RecordingRunner extends RoutableRunner {
    readonly label: string;
    readonly starts: AgentSpec[];
    readonly interrupts: AgentHandle[];
    readonly interruptByIds: string[];
}

function recordingRunner(label: string): RecordingRunner {
    const starts: AgentSpec[] = [];
    const interrupts: AgentHandle[] = [];
    const interruptByIds: string[] = [];
    let counter = 0;
    const inner: AgentRunner = {
        start(spec: AgentSpec): AgentHandle {
            starts.push(spec);
            return { id: `${label}-${++counter}`, spec };
        },
        async interrupt(handle: AgentHandle): Promise<void> {
            interrupts.push(handle);
        },
    };
    const runner: RecordingRunner = {
        label,
        starts,
        interrupts,
        interruptByIds,
        start: inner.start.bind(inner),
        interrupt: inner.interrupt.bind(inner),
        async interruptById(runId: string): Promise<void> {
            interruptByIds.push(runId);
        },
        killedSidecarPath(agentId: string): string {
            return `/tmp/${label}/${agentId}.killed`;
        },
    };
    return runner;
}

function makeSpec(role: string): AgentSpec {
    return { role, prompt: 'hi' };
}

// ---------------------------------------------------------------------------
// start() — routing by role
// ---------------------------------------------------------------------------

test('start dispatches to the role-mapped adapter when the role is overridden', () => {
    const developer = recordingRunner('developer-adapter');
    const tester = recordingRunner('tester-adapter');
    const fallback = recordingRunner('fallback-adapter');
    const router = new RoleRoutingAgentRunner({
        byRole: new Map([
            ['developer', developer],
            ['tester', tester],
        ]),
        fallback,
    });

    router.start(makeSpec('developer'));
    router.start(makeSpec('tester'));

    assert.equal(developer.starts.length, 1);
    assert.equal(tester.starts.length, 1);
    assert.equal(fallback.starts.length, 0);
});

test('start falls back to the fallback adapter for any role not in the override map', () => {
    const developer = recordingRunner('developer-adapter');
    const fallback = recordingRunner('fallback-adapter');
    const router = new RoleRoutingAgentRunner({
        byRole: new Map([['developer', developer]]),
        fallback,
    });

    router.start(makeSpec('reviewer'));
    router.start(makeSpec('committer'));
    router.start(makeSpec('developer'));

    assert.deepEqual(
        fallback.starts.map((s) => s.role),
        ['reviewer', 'committer'],
    );
    assert.deepEqual(developer.starts.map((s) => s.role), ['developer']);
});

// ---------------------------------------------------------------------------
// start() — routing by provider (management UI, Option B)
// ---------------------------------------------------------------------------

test('an Agent provider (resolveProvider + byProvider) wins over byRole and fallback', () => {
    const claude = recordingRunner('claude-cli');
    const deepseek = recordingRunner('deepseek');
    const roleDev = recordingRunner('role-developer');
    const fallback = recordingRunner('fallback');
    const router = new RoleRoutingAgentRunner({
        byRole: new Map([['developer', roleDev]]),
        byProvider: new Map([['claude-cli', claude], ['deepseek', deepseek]]),
        resolveProvider: (role) => (role === 'developer' ? 'deepseek' : undefined),
        fallback,
    });

    router.start(makeSpec('developer'));
    assert.equal(deepseek.starts.length, 1, 'Agent provider deepseek wins over byRole');
    assert.equal(roleDev.starts.length, 0);
    assert.equal(fallback.starts.length, 0);
});

test('a provider with no built runner falls through to byRole / fallback', () => {
    const roleDev = recordingRunner('role-developer');
    const fallback = recordingRunner('fallback');
    const router = new RoleRoutingAgentRunner({
        byRole: new Map([['developer', roleDev]]),
        byProvider: new Map([['claude-cli', recordingRunner('claude-cli')]]),
        // Agent says cursor-cli, but no cursor runner was built (creds missing).
        resolveProvider: () => 'cursor-cli',
        fallback,
    });

    router.start(makeSpec('developer'));
    router.start(makeSpec('reviewer'));
    assert.deepEqual(roleDev.starts.map((s) => s.role), ['developer']);
    assert.deepEqual(fallback.starts.map((s) => s.role), ['reviewer']);
});

test('no resolveProvider → behaves exactly like the role/fallback router', () => {
    const roleDev = recordingRunner('role-developer');
    const fallback = recordingRunner('fallback');
    const router = new RoleRoutingAgentRunner({
        byRole: new Map([['developer', roleDev]]),
        byProvider: new Map([['claude-cli', recordingRunner('claude-cli')]]),
        fallback,
    });
    router.start(makeSpec('developer'));
    router.start(makeSpec('reviewer'));
    assert.deepEqual(roleDev.starts.map((s) => s.role), ['developer']);
    assert.deepEqual(fallback.starts.map((s) => s.role), ['reviewer']);
});

// ---------------------------------------------------------------------------
// interruptById() / interrupt() — fan-out to every inner adapter
// ---------------------------------------------------------------------------

test('interruptById fans out to every distinct inner adapter once', async () => {
    const developer = recordingRunner('developer-adapter');
    const tester = recordingRunner('tester-adapter');
    const fallback = recordingRunner('fallback-adapter');
    const router = new RoleRoutingAgentRunner({
        byRole: new Map([
            ['developer', developer],
            ['tester', tester],
        ]),
        fallback,
    });

    await router.interruptById('developer-adapter-1');

    assert.deepEqual(developer.interruptByIds, ['developer-adapter-1']);
    assert.deepEqual(tester.interruptByIds, ['developer-adapter-1']);
    assert.deepEqual(fallback.interruptByIds, ['developer-adapter-1']);
});

test('interruptById deduplicates when the same adapter is mapped to multiple roles', async () => {
    // Realistic: AGENT_RUNNER_DEVELOPER=claude-cli + AGENT_RUNNER_REVIEWER=claude-cli
    // both resolve to the SAME ClaudeCliRunner instance — the router must not
    // call its interruptById twice.
    const shared = recordingRunner('shared-claude-cli');
    const fallback = recordingRunner('fallback');
    const router = new RoleRoutingAgentRunner({
        byRole: new Map([
            ['developer', shared],
            ['reviewer', shared],
        ]),
        fallback,
    });

    await router.interruptById('claude-cli-1');

    assert.deepEqual(shared.interruptByIds, ['claude-cli-1']);
    assert.deepEqual(fallback.interruptByIds, ['claude-cli-1']);
});

test('interrupt fans out to every inner adapter, surviving a thrower', async () => {
    const developer = recordingRunner('developer-adapter');
    const tester: RoutableRunner = {
        start(spec: AgentSpec): AgentHandle {
            return { id: 'tester-1', spec };
        },
        async interrupt(): Promise<void> {
            throw new Error('boom');
        },
        async interruptById(): Promise<void> {},
        killedSidecarPath(agentId: string): string {
            return `/tmp/tester/${agentId}.killed`;
        },
    };
    const fallback = recordingRunner('fallback-adapter');
    const router = new RoleRoutingAgentRunner({
        byRole: new Map([
            ['developer', developer],
            ['tester', tester],
        ]),
        fallback,
        logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    });

    const handle: AgentHandle = { id: 'developer-adapter-1', spec: makeSpec('developer') };
    await router.interrupt(handle);

    assert.deepEqual(developer.interrupts, [handle]);
    assert.deepEqual(fallback.interrupts, [handle]);
});
