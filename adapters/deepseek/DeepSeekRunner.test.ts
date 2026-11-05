import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import * as child_process from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { Event } from '../../core/events/event';
import type { EventPublisher, SpawnImpl } from '../claude-cli/ClaudeCliRunner';

import {
    DeepSeekRunner,
    DEEPSEEK_MODEL_PRO,
    DEEPSEEK_MODEL_FLASH,
    DEEPSEEK_DEFAULT_BASE_URL,
    buildDeepSeekEnv,
} from './DeepSeekRunner';

// ---------------------------------------------------------------------------
// Test doubles — same shape `ClaudeCliRunner.test.ts` uses.
// ---------------------------------------------------------------------------

function recordingPublisher(): EventPublisher & { events: Event[] } {
    const events: Event[] = [];
    return {
        events,
        async publish(event: Event): Promise<unknown> {
            events.push(event);
            return { seq: events.length, ...event };
        },
    };
}

interface FakeChild extends EventEmitter {
    pid: number | undefined;
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
}

function fakeChild(): FakeChild {
    const child = new EventEmitter() as FakeChild;
    child.pid = 4242;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    return child;
}

interface SpawnHarness {
    spawnImpl: SpawnImpl;
    args: Array<{
        cmd: string;
        args: readonly string[];
        env: NodeJS.ProcessEnv;
    }>;
}

function spawnHarness(): SpawnHarness {
    const calls: SpawnHarness['args'] = [];
    const spawnImpl: SpawnImpl = ((
        cmd: string,
        a: readonly string[],
        opts: child_process.SpawnOptions,
    ) => {
        calls.push({
            cmd,
            args: a,
            env: (opts?.env ?? {}) as NodeJS.ProcessEnv,
        });
        return fakeChild() as unknown as ReturnType<SpawnImpl>;
    }) as SpawnImpl;
    return { spawnImpl, args: calls };
}

function tmpSidecarDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'deepseek-runner-test-'));
}

// ---------------------------------------------------------------------------
// buildDeepSeekEnv — overlay shape
// ---------------------------------------------------------------------------

test('buildDeepSeekEnv layers the eight DeepSeek keys on top of the base env', () => {
    const env = buildDeepSeekEnv({
        apiKey: 'sk-test',
        baseUrl: DEEPSEEK_DEFAULT_BASE_URL,
        defaultEffort: 'max',
        base: { PATH: '/usr/bin' },
    });
    assert.equal(env.PATH, '/usr/bin');
    assert.equal(env.ANTHROPIC_BASE_URL, DEEPSEEK_DEFAULT_BASE_URL);
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'sk-test');
    assert.equal(env.ANTHROPIC_MODEL, DEEPSEEK_MODEL_PRO);
    assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, DEEPSEEK_MODEL_PRO);
    assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, DEEPSEEK_MODEL_PRO);
    assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, DEEPSEEK_MODEL_FLASH);
    assert.equal(env.CLAUDE_CODE_SUBAGENT_MODEL, DEEPSEEK_MODEL_FLASH);
    assert.equal(env.CLAUDE_CODE_EFFORT_LEVEL, 'max');
});

test('buildDeepSeekEnv removes an inherited ANTHROPIC_API_KEY', () => {
    // ANTHROPIC_API_KEY is a documented setting here and the claude-cli
    // runner snapshots it on every spawn, so a worker that also uses
    // claude-cli has it set. Without this deletion the CLI would attach
    // the operator's own Anthropic key as `x-api-key` to every DeepSeek
    // request. DeepSeek ignoring it for auth is not the same as not
    // receiving it.
    const env = buildDeepSeekEnv({
        apiKey: 'sk-deepseek',
        baseUrl: DEEPSEEK_DEFAULT_BASE_URL,
        defaultEffort: 'max',
        base: { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'sk-ant-real-key' },
    });
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.ok(
        !Object.values(env).includes('sk-ant-real-key'),
        'the inherited key must not survive anywhere in the overlay',
    );
    // The DeepSeek credential still goes on the Bearer-header variable.
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'sk-deepseek');
});

test('buildDeepSeekEnv preserves an operator-supplied ANTHROPIC_BASE_URL', () => {
    const env = buildDeepSeekEnv({
        apiKey: 'sk-test',
        baseUrl: DEEPSEEK_DEFAULT_BASE_URL,
        defaultEffort: 'max',
        base: { ANTHROPIC_BASE_URL: 'http://localhost:9999/anthropic' },
    });
    assert.equal(env.ANTHROPIC_BASE_URL, 'http://localhost:9999/anthropic');
    // The other keys still get the DeepSeek defaults.
    assert.equal(env.ANTHROPIC_MODEL, DEEPSEEK_MODEL_PRO);
});

test('buildDeepSeekEnv clamps CLAUDE_EFFORT* env vars to DeepSeek-allowed values', () => {
    const env = buildDeepSeekEnv({
        apiKey: 'sk-test',
        baseUrl: DEEPSEEK_DEFAULT_BASE_URL,
        defaultEffort: 'max',
        base: {
            CLAUDE_EFFORT_DEFAULT: 'medium',
            CLAUDE_EFFORT: 'low',
            CLAUDE_EFFORT_DEVELOPER: 'medium',
            CLAUDE_EFFORT_REVIEWER: 'high',
        },
    });
    assert.equal(env.CLAUDE_EFFORT_DEFAULT, 'max');
    assert.equal(env.CLAUDE_EFFORT, 'max');
    assert.equal(env.CLAUDE_EFFORT_DEVELOPER, 'max');
    assert.equal(env.CLAUDE_EFFORT_REVIEWER, 'high');
});

// ---------------------------------------------------------------------------
// DeepSeekRunner — spawn-env wiring + role model defaults + effort clamp
// ---------------------------------------------------------------------------

test('DeepSeekRunner spawns the claude CLI with the DeepSeek env overlay', () => {
    const harness = spawnHarness();
    const sidecarDir = tmpSidecarDir();
    const runner = new DeepSeekRunner({
        bus: recordingPublisher(),
        apiKey: 'sk-test',
        env: () => ({ PATH: '/usr/bin' }),
        spawnImpl: harness.spawnImpl,
        sidecarDir,
    });
    runner.start({ role: 'developer', prompt: 'hi' });
    assert.equal(harness.args.length, 1);
    const spawnedEnv = harness.args[0].env;
    assert.equal(spawnedEnv.ANTHROPIC_BASE_URL, DEEPSEEK_DEFAULT_BASE_URL);
    assert.equal(spawnedEnv.ANTHROPIC_AUTH_TOKEN, 'sk-test');
    assert.equal(spawnedEnv.CLAUDE_CODE_EFFORT_LEVEL, 'max');
});

test('DeepSeekRunner does not hand the operator Anthropic key to the CLI', () => {
    // The overlay is covered above; this proves the wiring, which is
    // where the leak actually happened - the runner reads process.env
    // through its `env` seam and the result is what the child gets.
    const harness = spawnHarness();
    const sidecarDir = tmpSidecarDir();
    const runner = new DeepSeekRunner({
        bus: recordingPublisher(),
        apiKey: 'sk-deepseek',
        env: () => ({
            PATH: '/usr/bin',
            ANTHROPIC_API_KEY: 'sk-ant-real-key',
        }),
        spawnImpl: harness.spawnImpl,
        sidecarDir,
    });
    runner.start({ role: 'developer', prompt: 'hi' });
    const spawnedEnv = harness.args[0].env;
    assert.equal(spawnedEnv.ANTHROPIC_API_KEY, undefined);
    assert.ok(!Object.values(spawnedEnv).includes('sk-ant-real-key'));
    assert.equal(spawnedEnv.ANTHROPIC_AUTH_TOKEN, 'sk-deepseek');
});

test('DeepSeekRunner picks the deepseek role default model for unknown roles', () => {
    const harness = spawnHarness();
    const sidecarDir = tmpSidecarDir();
    const runner = new DeepSeekRunner({
        bus: recordingPublisher(),
        apiKey: 'sk-test',
        env: () => ({}),
        spawnImpl: harness.spawnImpl,
        sidecarDir,
    });
    runner.start({ role: 'developer', prompt: 'hi' });
    const args = harness.args[0].args;
    const modelIdx = args.indexOf('--model');
    assert.notEqual(modelIdx, -1);
    assert.equal(args[modelIdx + 1], DEEPSEEK_MODEL_PRO);
});

test('DeepSeekRunner honours operator role overrides via defaultModels', () => {
    const harness = spawnHarness();
    const sidecarDir = tmpSidecarDir();
    const runner = new DeepSeekRunner({
        bus: recordingPublisher(),
        apiKey: 'sk-test',
        defaultModels: { developer: 'deepseek-v4-flash' },
        env: () => ({}),
        spawnImpl: harness.spawnImpl,
        sidecarDir,
    });
    runner.start({ role: 'developer', prompt: 'hi' });
    const args = harness.args[0].args;
    const modelIdx = args.indexOf('--model');
    assert.equal(args[modelIdx + 1], 'deepseek-v4-flash');
});

test('DeepSeekRunner clamps a FlowStep-supplied effort to a DeepSeek-allowed value', () => {
    const harness = spawnHarness();
    const sidecarDir = tmpSidecarDir();
    const runner = new DeepSeekRunner({
        bus: recordingPublisher(),
        apiKey: 'sk-test',
        env: () => ({}),
        spawnImpl: harness.spawnImpl,
        sidecarDir,
    });
    runner.start({
        role: 'developer',
        prompt: 'hi',
        metadata: { effort: 'medium' },
    });
    const args = harness.args[0].args;
    const effortIdx = args.indexOf('--effort');
    assert.notEqual(effortIdx, -1);
    assert.equal(args[effortIdx + 1], 'high');
});

test('DeepSeekRunner passes high/max effort through unchanged', () => {
    const harness = spawnHarness();
    const sidecarDir = tmpSidecarDir();
    const runner = new DeepSeekRunner({
        bus: recordingPublisher(),
        apiKey: 'sk-test',
        env: () => ({}),
        spawnImpl: harness.spawnImpl,
        sidecarDir,
    });
    runner.start({
        role: 'developer',
        prompt: 'hi',
        metadata: { effort: 'max' },
    });
    const args = harness.args[0].args;
    const effortIdx = args.indexOf('--effort');
    assert.equal(args[effortIdx + 1], 'max');
});

test('DeepSeekRunner strips a claude-* model id so the DeepSeek role default applies', () => {
    const harness = spawnHarness();
    const sidecarDir = tmpSidecarDir();
    const runner = new DeepSeekRunner({
        bus: recordingPublisher(),
        apiKey: 'sk-test',
        env: () => ({}),
        spawnImpl: harness.spawnImpl,
        sidecarDir,
    });
    runner.start({
        role: 'developer',
        prompt: 'hi',
        metadata: { model: 'claude-opus-4-7' },
    });
    const args = harness.args[0].args;
    const modelIdx = args.indexOf('--model');
    assert.equal(args[modelIdx + 1], DEEPSEEK_MODEL_PRO);
});

test('DeepSeekRunner lets a deepseek-* model id pass through unchanged', () => {
    const harness = spawnHarness();
    const sidecarDir = tmpSidecarDir();
    const runner = new DeepSeekRunner({
        bus: recordingPublisher(),
        apiKey: 'sk-test',
        env: () => ({}),
        spawnImpl: harness.spawnImpl,
        sidecarDir,
    });
    runner.start({
        role: 'developer',
        prompt: 'hi',
        metadata: { model: DEEPSEEK_MODEL_FLASH },
    });
    const args = harness.args[0].args;
    const modelIdx = args.indexOf('--model');
    assert.equal(args[modelIdx + 1], DEEPSEEK_MODEL_FLASH);
});

test('DeepSeekRunner exposes the inner ClaudeCliRunner for the killer port', () => {
    const sidecarDir = tmpSidecarDir();
    const runner = new DeepSeekRunner({
        bus: recordingPublisher(),
        apiKey: 'sk-test',
        env: () => ({}),
        spawnImpl: spawnHarness().spawnImpl,
        sidecarDir,
    });
    assert.equal(typeof runner.inner.interruptById, 'function');
    assert.equal(typeof runner.killedSidecarPath('foo'), 'string');
});
