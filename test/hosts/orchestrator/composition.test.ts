/**
 * AP-VP6-011 — unit tests for the orchestrator composition root.
 *
 * Covers the issue-tracker selections against both chat_gateway values.
 * The chat gateway is always the in-memory v6 fake now — the production
 * Telegram path is wired directly in worker-api boot (P-CPTO-011), so the
 * former `chat_gateway: 'telegram'` composition branch is gone. Also
 * covers the missing-credential failure mode for the linear branch.
 *
 * Dual-runner discovery shim matches the convention used by every other
 * AP-VP6 unit test in this repo: `npm test` resolves to `node --test`,
 * and the review pipeline uses `vitest run`. The shim picks the right
 * `test()` at module load so both runners discover the suite from one
 * file (vitest.config.ts has `globals: true`).
 */
import assert from 'node:assert/strict';

import {
    CompositionError,
    FakeChatGatewayV6,
    FakeIssueTrackerV6,
    composeAdapters,
    type CompositionInputs,
} from '../../../hosts/orchestrator/composition';
import { LinearAdapter } from '../../../adapters/linear/linear-adapter';
import { GitHubPrAdapter } from '../../../adapters/github/github-pr-adapter';
import { Recorder } from '../../../adapters/fakes/recorder';
import type { InboundChatCommand } from '../../../core/ports/chat-gateway';
import type { Logger } from '../../../core/ports/Logger';

// ---------------------------------------------------------------------------
// Dual-runner test() shim
// ---------------------------------------------------------------------------

type TestFn = (name: string, fn: () => void | Promise<void>) => void;

const test: TestFn = (((): TestFn => {
    if (process.env.VITEST) {
        const gt = (globalThis as { test?: TestFn }).test;
        if (typeof gt !== 'function') {
            throw new Error(
                'composition.test.ts: VITEST=true but globalThis.test is missing — '
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
// Helpers
// ---------------------------------------------------------------------------

function silentLogger(): Logger {
    return {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
        debug: () => undefined,
    };
}

function noopHandler(_cmd: InboundChatCommand): void {
    return undefined;
}

function inputsWith(
    overrides: Partial<CompositionInputs> & Pick<CompositionInputs, 'selection'>,
): CompositionInputs {
    return {
        env: {},
        logger: silentLogger(),
        onInboundCommand: noopHandler,
        gitHostCwd: '/tmp',
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// Four selection combinations
// ---------------------------------------------------------------------------

test('composeAdapters: linear tracker + telegram selection wires the real tracker and the fake chat gateway', () => {
    const result = composeAdapters(
        inputsWith({
            selection: { issueTracker: 'linear', chatGateway: 'telegram' },
            env: {
                LINEAR_API_KEY: 'lk_test',
                LINEAR_TEAM_ID: 'team-1',
            },
        }),
    );

    assert.ok(result.issueTracker instanceof LinearAdapter);
    // chat_gateway: 'telegram' no longer builds a real adapter here — the
    // production TelegramGateway is constructed in worker-api boot.
    assert.ok(result.chatGateway instanceof FakeChatGatewayV6);
    assert.ok(result.gitHost instanceof GitHubPrAdapter);
    assert.ok(result.recorder instanceof Recorder);
});

test('composeAdapters: linear + fake wires the v6 fake chat gateway only', () => {
    const result = composeAdapters(
        inputsWith({
            selection: { issueTracker: 'linear', chatGateway: 'fake' },
            env: {
                LINEAR_API_KEY: 'lk_test',
                LINEAR_TEAM_ID: 'team-1',
            },
        }),
    );

    assert.ok(result.issueTracker instanceof LinearAdapter);
    assert.ok(result.chatGateway instanceof FakeChatGatewayV6);
    assert.ok(result.gitHost instanceof GitHubPrAdapter);
});

test('composeAdapters: fake tracker + telegram selection wires both v6 fakes', () => {
    const result = composeAdapters(
        inputsWith({
            selection: { issueTracker: 'fake', chatGateway: 'telegram' },
        }),
    );

    assert.ok(result.issueTracker instanceof FakeIssueTrackerV6);
    assert.ok(result.chatGateway instanceof FakeChatGatewayV6);
    assert.ok(result.gitHost instanceof GitHubPrAdapter);
});

test('composeAdapters: fake + fake wires both v6 fakes against a shared recorder', async () => {
    const result = composeAdapters(
        inputsWith({
            selection: { issueTracker: 'fake', chatGateway: 'fake' },
        }),
    );

    assert.ok(result.issueTracker instanceof FakeIssueTrackerV6);
    assert.ok(result.chatGateway instanceof FakeChatGatewayV6);

    // Drive one call against each fake and verify the SAME recorder
    // received both entries — proves the shared-recorder wiring (AC #2).
    await result.issueTracker.createIssue({ taskId: 't1', title: 'echo' });
    await result.chatGateway.notify({ kind: 'task-failed', taskId: 't1' });

    const entries = result.recorder.entries();
    const adapters = new Set(entries.map((e) => e.adapter));
    assert.ok(adapters.has('fake-issue-tracker-v6'));
    assert.ok(adapters.has('fake-chat-gateway-v6'));
});

// ---------------------------------------------------------------------------
// Shared-recorder injection
// ---------------------------------------------------------------------------

test('composeAdapters: caller-supplied recorder is reused for both fakes', async () => {
    const recorder = new Recorder();
    const result = composeAdapters(
        inputsWith({
            selection: { issueTracker: 'fake', chatGateway: 'fake' },
            recorder,
        }),
    );

    assert.equal(result.recorder, recorder);

    await result.issueTracker.createIssue({ taskId: 't2', title: 't' });
    await result.chatGateway.notify({
        kind: 'plan-ready',
        taskId: 't2',
    });

    const methodCalls = recorder
        .entries()
        .filter((e) => e.method === 'createIssue' || e.method === 'notify');
    assert.equal(methodCalls.length, 2);
});

// ---------------------------------------------------------------------------
// Inbound handler wiring (AC: "fake-driven tests can simulate commands")
// ---------------------------------------------------------------------------

test('composeAdapters: fake chat gateway delivers inbound commands to the supplied handler', () => {
    const received: InboundChatCommand[] = [];
    const result = composeAdapters(
        inputsWith({
            selection: { issueTracker: 'fake', chatGateway: 'fake' },
            onInboundCommand: (cmd) => {
                received.push(cmd);
            },
        }),
    );

    assert.ok(result.chatGateway instanceof FakeChatGatewayV6);
    const fake = result.chatGateway as FakeChatGatewayV6;
    fake.simulateInbound({ kind: 'approve', taskId: 't3', actor: '42' });

    assert.deepEqual(received, [
        { kind: 'approve', taskId: 't3', actor: '42' },
    ]);
});

// ---------------------------------------------------------------------------
// Missing-credential failures (AC #4)
// ---------------------------------------------------------------------------

test('composeAdapters: linear selection without LINEAR_API_KEY throws CompositionError', () => {
    assert.throws(
        () =>
            composeAdapters(
                inputsWith({
                    selection: { issueTracker: 'linear', chatGateway: 'fake' },
                    env: { LINEAR_TEAM_ID: 'team-1' },
                }),
            ),
        (err: unknown) =>
            err instanceof CompositionError
            && err.selection === 'linear'
            && err.envVar === 'LINEAR_API_KEY',
    );
});

test('composeAdapters: empty / whitespace credential is treated as missing', () => {
    assert.throws(
        () =>
            composeAdapters(
                inputsWith({
                    selection: { issueTracker: 'linear', chatGateway: 'fake' },
                    env: { LINEAR_API_KEY: '   ', LINEAR_TEAM_ID: 'team-1' },
                }),
            ),
        (err: unknown) =>
            err instanceof CompositionError && err.envVar === 'LINEAR_API_KEY',
    );
});
