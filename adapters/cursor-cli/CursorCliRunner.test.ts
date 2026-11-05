import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import * as child_process from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { Event } from '../../core/events/event';

import { CursorCliRunner, type EventPublisher, type SpawnImpl } from './CursorCliRunner';

// ---------------------------------------------------------------------------
// Test doubles
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
        cwd: string | undefined;
    }>;
    children: FakeChild[];
}

function spawnHarness(): SpawnHarness {
    const calls: SpawnHarness['args'] = [];
    const children: FakeChild[] = [];
    const spawnImpl: SpawnImpl = ((
        cmd: string,
        a: readonly string[],
        opts: child_process.SpawnOptions,
    ) => {
        calls.push({
            cmd,
            args: a,
            env: (opts?.env ?? {}) as NodeJS.ProcessEnv,
            cwd: typeof opts?.cwd === 'string' ? opts.cwd : undefined,
        });
        const c = fakeChild();
        children.push(c);
        return c as unknown as ReturnType<SpawnImpl>;
    }) as SpawnImpl;
    return { spawnImpl, args: calls, children };
}

function tmpDir(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function flush(): Promise<void> {
    for (let i = 0; i < 5; i++) await Promise.resolve();
}

// ---------------------------------------------------------------------------
// Spawn args
// ---------------------------------------------------------------------------

test('buildSpawnArgs uses the agent binary with the locked cursor flag set', () => {
    const harness = spawnHarness();
    const cwd = tmpDir('cursor-cwd-');
    const runner = new CursorCliRunner({
        bus: recordingPublisher(),
        env: () => ({}),
        spawnImpl: harness.spawnImpl,
        sidecarDir: tmpDir('cursor-sidecar-'),
    });
    runner.start({ role: 'developer', prompt: 'hello', cwd });

    assert.equal(harness.args.length, 1);
    const call = harness.args[0];
    assert.equal(call.cmd, 'agent');
    assert.ok(call.args.includes('--print'));
    assert.ok(call.args.includes('--stream-partial-output'));
    assert.ok(call.args.includes('--force'));
    assert.ok(call.args.includes('--trust'));
    assert.ok(call.args.includes('--approve-mcps'));
    const fmtIdx = call.args.indexOf('--output-format');
    assert.equal(call.args[fmtIdx + 1], 'stream-json');
    const wsIdx = call.args.indexOf('--workspace');
    assert.equal(call.args[wsIdx + 1], cwd);
});

test('CURSOR_CMD overrides the binary name', () => {
    const harness = spawnHarness();
    const runner = new CursorCliRunner({
        bus: recordingPublisher(),
        env: () => ({ CURSOR_CMD: 'cursor-agent' }),
        spawnImpl: harness.spawnImpl,
        sidecarDir: tmpDir('cursor-sidecar-'),
    });
    runner.start({ role: 'developer', prompt: 'hi', cwd: tmpDir('cwd-') });
    assert.equal(harness.args[0].cmd, 'cursor-agent');
});

test('no --effort arg is passed (reasoning lives in the model id on cursor)', () => {
    const harness = spawnHarness();
    const runner = new CursorCliRunner({
        bus: recordingPublisher(),
        env: () => ({ CLAUDE_EFFORT_DEVELOPER: 'high' }),
        spawnImpl: harness.spawnImpl,
        sidecarDir: tmpDir('cursor-sidecar-'),
    });
    runner.start({
        role: 'developer',
        prompt: 'hi',
        cwd: tmpDir('cwd-'),
        metadata: { effort: 'high' },
    });
    assert.equal(harness.args[0].args.includes('--effort'), false);
});

// ---------------------------------------------------------------------------
// Bootstrap prompt — short, references TASK.md and the role
// ---------------------------------------------------------------------------

test('bootstrap prompt is short and references TASK.md and the role', () => {
    const harness = spawnHarness();
    const runner = new CursorCliRunner({
        bus: recordingPublisher(),
        env: () => ({}),
        spawnImpl: harness.spawnImpl,
        sidecarDir: tmpDir('cursor-sidecar-'),
    });
    runner.start({ role: 'reviewer', prompt: 'ignored-by-cursor', cwd: tmpDir('cwd-') });
    const positional = harness.args[0].args[harness.args[0].args.length - 1];
    assert.ok(positional.length < 1024, 'bootstrap must stay well under cmd.exe argv limit');
    assert.ok(positional.includes('reviewer'));
    assert.ok(positional.includes('TASK.md'));
    assert.ok(positional.includes('NEEDS_HUMAN_INPUT'));
});

// ---------------------------------------------------------------------------
// TASK.md hand-off — operator prompt is appended to TASK.md in the worktree
// ---------------------------------------------------------------------------

test('start appends spec.prompt to TASK.md in the worktree', () => {
    const harness = spawnHarness();
    const cwd = tmpDir('cursor-cwd-');
    fs.writeFileSync(path.join(cwd, 'TASK.md'), '# Existing task description\n', 'utf8');
    const runner = new CursorCliRunner({
        bus: recordingPublisher(),
        env: () => ({}),
        spawnImpl: harness.spawnImpl,
        sidecarDir: tmpDir('cursor-sidecar-'),
    });
    runner.start({
        role: 'developer',
        prompt: 'You are a developer. Implement the change described above.',
        cwd,
    });
    const final = fs.readFileSync(path.join(cwd, 'TASK.md'), 'utf8');
    assert.ok(final.startsWith('# Existing task description'));
    assert.ok(final.includes('Implement the change'));
});

test('start works even when TASK.md does not pre-exist (creates it)', () => {
    const harness = spawnHarness();
    const cwd = tmpDir('cursor-cwd-');
    const runner = new CursorCliRunner({
        bus: recordingPublisher(),
        env: () => ({}),
        spawnImpl: harness.spawnImpl,
        sidecarDir: tmpDir('cursor-sidecar-'),
    });
    runner.start({ role: 'developer', prompt: 'hi', cwd });
    assert.ok(fs.existsSync(path.join(cwd, 'TASK.md')));
});

// ---------------------------------------------------------------------------
// Model resolution
// ---------------------------------------------------------------------------

test('--model defaults to composer-2.5 when nothing else is configured', () => {
    const harness = spawnHarness();
    const runner = new CursorCliRunner({
        bus: recordingPublisher(),
        env: () => ({}),
        spawnImpl: harness.spawnImpl,
        sidecarDir: tmpDir('cursor-sidecar-'),
    });
    runner.start({ role: 'tester', prompt: 'hi', cwd: tmpDir('cwd-') });
    const args = harness.args[0].args;
    const modelIdx = args.indexOf('--model');
    assert.equal(args[modelIdx + 1], 'composer-2.5');
});

test('CURSOR_MODEL_<ROLE> wins over CURSOR_MODEL and the default', () => {
    const harness = spawnHarness();
    const runner = new CursorCliRunner({
        bus: recordingPublisher(),
        env: () => ({
            CURSOR_MODEL: 'composer-2.5',
            CURSOR_MODEL_DEVELOPER: 'sonnet-4-thinking',
        }),
        spawnImpl: harness.spawnImpl,
        sidecarDir: tmpDir('cursor-sidecar-'),
    });
    runner.start({ role: 'developer', prompt: 'hi', cwd: tmpDir('cwd-') });
    const args = harness.args[0].args;
    const modelIdx = args.indexOf('--model');
    assert.equal(args[modelIdx + 1], 'sonnet-4-thinking');
});

test('claude-* model ids in metadata are dropped so the cursor default applies', () => {
    const harness = spawnHarness();
    const runner = new CursorCliRunner({
        bus: recordingPublisher(),
        env: () => ({}),
        spawnImpl: harness.spawnImpl,
        sidecarDir: tmpDir('cursor-sidecar-'),
    });
    runner.start({
        role: 'developer',
        prompt: 'hi',
        cwd: tmpDir('cwd-'),
        metadata: { model: 'claude-opus-4-7' },
    });
    const args = harness.args[0].args;
    const modelIdx = args.indexOf('--model');
    assert.equal(args[modelIdx + 1], 'composer-2.5');
});

test('a non-claude metadata.model passes through unchanged', () => {
    const harness = spawnHarness();
    const runner = new CursorCliRunner({
        bus: recordingPublisher(),
        env: () => ({}),
        spawnImpl: harness.spawnImpl,
        sidecarDir: tmpDir('cursor-sidecar-'),
    });
    runner.start({
        role: 'developer',
        prompt: 'hi',
        cwd: tmpDir('cwd-'),
        metadata: { model: 'sonnet-4-thinking' },
    });
    const args = harness.args[0].args;
    const modelIdx = args.indexOf('--model');
    assert.equal(args[modelIdx + 1], 'sonnet-4-thinking');
});

// ---------------------------------------------------------------------------
// Lifecycle events — AgentStarted, AgentProgress, AgentFinished
// ---------------------------------------------------------------------------

test('start publishes AgentStarted synchronously with role + pid + metadata', async () => {
    const bus = recordingPublisher();
    const harness = spawnHarness();
    const runner = new CursorCliRunner({
        bus,
        env: () => ({}),
        spawnImpl: harness.spawnImpl,
        sidecarDir: tmpDir('cursor-sidecar-'),
    });
    runner.start({
        role: 'developer',
        prompt: 'hi',
        cwd: tmpDir('cwd-'),
        metadata: { planId: 'plan-7' },
    });
    await flush();
    const started = bus.events.find((e) => e.type === 'AgentStarted');
    assert.ok(started, 'AgentStarted must have been published');
    const payload = started.payload as Record<string, unknown>;
    assert.equal(payload.role, 'developer');
    assert.equal(payload.pid, 4242);
    assert.deepEqual(payload.metadata, { planId: 'plan-7' });
});

test('assistant text chunks become AgentProgress, success result becomes AgentFinished', async () => {
    const bus = recordingPublisher();
    const harness = spawnHarness();
    const runner = new CursorCliRunner({
        bus,
        env: () => ({}),
        spawnImpl: harness.spawnImpl,
        sidecarDir: tmpDir('cursor-sidecar-'),
    });
    runner.start({ role: 'developer', prompt: 'hi', cwd: tmpDir('cwd-') });

    const child = harness.children[0];
    const assistantLine = JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Hello operator.' }] },
        session_id: 'sess-1',
    });
    const resultLine = JSON.stringify({
        type: 'result',
        subtype: 'success',
        result: 'Hello operator.',
        session_id: 'sess-1',
    });
    child.stdout.write(`${assistantLine}\n${resultLine}\n`);
    child.emit('close', 0, null);
    await flush();
    await flush();

    const progress = bus.events.find((e) => e.type === 'AgentProgress');
    assert.ok(progress, 'AgentProgress should have been published');
    const finished = bus.events.find((e) => e.type === 'AgentFinished');
    assert.ok(finished, 'AgentFinished should have been published');
    assert.equal(
        (finished.payload as { content?: string }).content,
        'Hello operator.',
    );
});

// ---------------------------------------------------------------------------
// Kill semantics — sidecar marker + interruptById
// ---------------------------------------------------------------------------

test('interrupt writes the killed sidecar file and resolves quietly on unknown ids', async () => {
    const sidecarDir = tmpDir('cursor-sidecar-');
    const harness = spawnHarness();
    const runner = new CursorCliRunner({
        bus: recordingPublisher(),
        env: () => ({}),
        spawnImpl: harness.spawnImpl,
        sidecarDir,
        killer: async () => {
            /* no-op for the test */
        },
    });
    const handle = runner.start({
        role: 'developer',
        prompt: 'hi',
        cwd: tmpDir('cwd-'),
    });
    await runner.interrupt(handle);
    const sidecarPath = runner.killedSidecarPath(handle.id);
    assert.ok(fs.existsSync(sidecarPath));

    // Unknown id is a quiet no-op (matches ClaudeCliRunner.interruptById).
    await runner.interruptById('not-a-real-id');
});
