import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { Event } from '../../core/events/event';

import {
  ClaudeCliRunner,
  type EventPublisher,
  type SpawnImpl,
} from './ClaudeCliRunner';

// ---------------------------------------------------------------------------
// Test doubles — mirror the harness from ClaudeCliRunner.test.ts so the two
// suites stay readable side-by-side. Kept local rather than exported to avoid
// coupling unrelated test files.
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

function fakeChild(pid: number | undefined = 4242): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = pid;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  return child;
}

interface SpawnHarness {
  spawnImpl: SpawnImpl;
  spawned: FakeChild[];
}

function spawnHarness(): SpawnHarness {
  const spawned: FakeChild[] = [];
  const spawnImpl: SpawnImpl = (() => {
    const c = fakeChild();
    spawned.push(c);
    return c as unknown as ReturnType<SpawnImpl>;
  }) as SpawnImpl;
  return { spawnImpl, spawned };
}

function tmpSidecarDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'claude-cli-runner-interruptbyid-test-'));
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

// ---------------------------------------------------------------------------
// AC #1, #2: interruptById resolves the handle and delegates to interrupt()
// ---------------------------------------------------------------------------

test('interruptById resolves the runId to the active handle and kills the matching pid', async () => {
  const bus = recordingPublisher();
  const harness = spawnHarness();
  const killed: number[] = [];

  const runner = new ClaudeCliRunner({
    bus,
    spawnImpl: harness.spawnImpl,
    sidecarDir: tmpSidecarDir(),
    env: () => ({}),
    killer: (pid) => {
      killed.push(pid);
    },
  });

  const handle = runner.start({ role: 'echo', prompt: 'hi' });
  await flush();

  await runner.interruptById(handle.id);

  assert.deepEqual(killed, [4242], 'killer should fire exactly once with the spawned pid');

  // Sidecar is the proof that interrupt(handle) ran — it's written before the
  // kill. If interruptById had skipped the delegation, no sidecar would exist.
  const sidecar = runner.killedSidecarPath(handle.id);
  assert.equal(fs.existsSync(sidecar), true, 'interrupt path should have written the sidecar');
});

// ---------------------------------------------------------------------------
// AC #3: idempotency — a second interruptById call must not throw or re-kill
// ---------------------------------------------------------------------------

test('interruptById is idempotent: the second call for the same runId is a no-op', async () => {
  const bus = recordingPublisher();
  const harness = spawnHarness();
  let killCalls = 0;

  const runner = new ClaudeCliRunner({
    bus,
    spawnImpl: harness.spawnImpl,
    sidecarDir: tmpSidecarDir(),
    env: () => ({}),
    killer: () => {
      killCalls++;
    },
  });

  const handle = runner.start({ role: 'echo', prompt: 'hi' });
  await flush();

  await runner.interruptById(handle.id);
  // Second call before close fires — the run is still in the active map but
  // already flagged killed. The `run.killed` guard inside interrupt() owns
  // idempotency; interruptById must not duplicate it.
  await assert.doesNotReject(() => runner.interruptById(handle.id));

  assert.equal(killCalls, 1, 'killer should only fire once across two interruptById calls');
});

test('interruptById after the child has already exited is a no-op (run removed from active map)', async () => {
  const bus = recordingPublisher();
  const harness = spawnHarness();
  let killCalls = 0;

  const runner = new ClaudeCliRunner({
    bus,
    spawnImpl: harness.spawnImpl,
    sidecarDir: tmpSidecarDir(),
    env: () => ({}),
    killer: () => {
      killCalls++;
    },
  });

  const handle = runner.start({ role: 'echo', prompt: 'hi' });
  const child = harness.spawned[0];
  child.stdout.end();
  child.emit('close', 0, null);
  await flush();
  await flush();

  await assert.doesNotReject(() => runner.interruptById(handle.id));
  assert.equal(killCalls, 0, 'killer must not run after the child has already exited');
});

// ---------------------------------------------------------------------------
// AC #4: unknown runId behaves identically to interrupt() on an unknown handle
// ---------------------------------------------------------------------------

test('interruptById on an unknown runId is a silent no-op (matches interrupt() on unknown handle)', async () => {
  const bus = recordingPublisher();
  const harness = spawnHarness();
  let killCalls = 0;

  const runner = new ClaudeCliRunner({
    bus,
    spawnImpl: harness.spawnImpl,
    sidecarDir: tmpSidecarDir(),
    env: () => ({}),
    killer: () => {
      killCalls++;
    },
  });

  await assert.doesNotReject(() => runner.interruptById('does-not-exist'));
  assert.equal(killCalls, 0);
  assert.equal(bus.events.length, 0, 'no events should be emitted for an unknown runId');
});

test('interruptById picks the right handle when several runs are active concurrently', async () => {
  const bus = recordingPublisher();
  const harness = spawnHarness();
  const killed: number[] = [];

  // Synthetic ids so the test reads naturally; pid differs per spawn so we can
  // assert the runner reached the correct child.
  let nextPid = 1000;
  const customSpawn: SpawnImpl = (() => {
    const c = fakeChild(nextPid++);
    harness.spawned.push(c);
    return c as unknown as ReturnType<SpawnImpl>;
  }) as SpawnImpl;

  let counter = 0;
  const runner = new ClaudeCliRunner({
    bus,
    spawnImpl: customSpawn,
    sidecarDir: tmpSidecarDir(),
    env: () => ({}),
    newId: () => `run-${++counter}`,
    killer: (pid) => {
      killed.push(pid);
    },
  });

  const a = runner.start({ role: 'echo', prompt: 'a' });
  const b = runner.start({ role: 'echo', prompt: 'b' });
  const c = runner.start({ role: 'echo', prompt: 'c' });
  await flush();

  await runner.interruptById(b.id);

  assert.deepEqual(killed, [b.pid], 'only the run matching the supplied runId should be killed');
  assert.notEqual(b.pid, a.pid);
  assert.notEqual(b.pid, c.pid);
});
