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
import { StreamParser, parseLine } from './streamParser';

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
  args: { cmd: string; args: readonly string[] }[];
}

function spawnHarness(makeChild: (() => FakeChild) | undefined = undefined): SpawnHarness {
  const spawned: FakeChild[] = [];
  const args: { cmd: string; args: readonly string[] }[] = [];
  const spawnImpl: SpawnImpl = ((cmd: string, a: readonly string[]) => {
    args.push({ cmd, args: a });
    const c = makeChild ? makeChild() : fakeChild();
    spawned.push(c);
    return c as unknown as ReturnType<SpawnImpl>;
  }) as SpawnImpl;
  return { spawnImpl, spawned, args };
}

function tmpSidecarDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'claude-cli-runner-test-'));
}

// Drain any queued microtasks so async publishes resolve.
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

// ---------------------------------------------------------------------------
// streamParser — AC #3, AC #4, AC #5 (line parsing for each marker)
// ---------------------------------------------------------------------------

test('parseLine maps an assistant text envelope to a progress event', () => {
  const ev = parseLine(
    JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
    }),
  );
  assert.deepEqual(ev, [{ kind: 'progress', role: 'assistant', chunk: 'hello' }]);
});

test('parseLine maps a question envelope to a question event', () => {
  const ev = parseLine(JSON.stringify({ type: 'question', text: 'approve?' }));
  assert.deepEqual(ev, [{ kind: 'question', question: 'approve?' }]);
});

test('parseLine maps a result envelope to a finished event with its subtype as outcome', () => {
  const ev = parseLine(
    JSON.stringify({ type: 'result', subtype: 'success', result: 'done' }),
  );
  assert.deepEqual(ev, [{ kind: 'finished', outcome: 'success' }]);
});

test('parseLine returns [] for empty / non-JSON / unknown / suppressed envelopes', () => {
  assert.deepEqual(parseLine(''), []);
  assert.deepEqual(parseLine('   '), []);
  assert.deepEqual(parseLine('not json'), []);
  // Truly unknown envelope types are dropped.
  assert.deepEqual(parseLine(JSON.stringify({ type: 'unknown_envelope' })), []);
  // Claude Code emits `task_progress` / `task_started` heartbeats
  // several times a second while a tool is in flight — pure noise.
  // Parser only emits system events for subtype === 'init'.
  assert.deepEqual(
    parseLine(JSON.stringify({ type: 'system', subtype: 'task_progress' })),
    [],
  );
  assert.deepEqual(
    parseLine(JSON.stringify({ type: 'system', subtype: 'task_started' })),
    [],
  );
  // `user` envelopes are claude's internal echo of tool results back
  // to the assistant — redundant with the preceding tool_result event.
  assert.deepEqual(
    parseLine(JSON.stringify({ type: 'user', message: {} })),
    [],
  );
});

test('parseLine surfaces system init / tool_result as activity events', () => {
  assert.deepEqual(
    parseLine(
      JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: 'abc-12345678',
        model: 'claude-opus-4-7',
      }),
    ),
    [
      {
        kind: 'activity',
        category: 'system',
        detail: 'session started · model: claude-opus-4-7 · 12345678',
      },
    ],
  );
  // tool_result carries the head of the content on `detail` and the
  // full body on `extra` so the renderer can collapse-expand it.
  const toolResult = parseLine(
    JSON.stringify({ type: 'tool_result', content: 'On branch master' }),
  );
  assert.equal(toolResult.length, 1);
  assert.equal(toolResult[0].kind, 'activity');
  if (toolResult[0].kind === 'activity') {
    assert.equal(toolResult[0].category, 'tool_result');
    assert.equal(toolResult[0].detail, 'On branch master');
    assert.equal(toolResult[0].extra, 'On branch master');
  }
});

test('parseLine splits assistant envelopes into per-block events', () => {
  // Real shape claude emits: assistant turn with a tool_use block
  // (and optionally thinking + text blocks). The parser explodes
  // these into separate activity / progress events.
  const events = parseLine(
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: 'Let me check the repo first' },
          {
            type: 'tool_use',
            name: 'bash',
            input: { command: 'git status' },
          },
          { type: 'text', text: 'Looking at the codebase…' },
        ],
      },
    }),
  );
  assert.equal(events.length, 3);
  // thinking block → activity with thinking detail + extra
  assert.equal(events[0].kind, 'activity');
  if (events[0].kind === 'activity') {
    assert.equal(events[0].category, 'thinking');
    assert.equal(events[0].detail, 'Let me check the repo first');
    assert.equal(events[0].extra, 'Let me check the repo first');
  }
  // tool_use block → activity with tool name + input
  assert.equal(events[1].kind, 'activity');
  if (events[1].kind === 'activity') {
    assert.equal(events[1].category, 'tool_use');
    assert.equal(events[1].detail, 'bash: git status');
    assert.ok(events[1].extra && events[1].extra.includes('git status'));
  }
  // text block → progress (same as before)
  assert.deepEqual(events[2], {
    kind: 'progress',
    role: 'assistant',
    chunk: 'Looking at the codebase…',
  });
});

test('StreamParser buffers partial lines across pushes', () => {
  const parser = new StreamParser();
  const chunk1 = '{"type":"assistant","content":[{"type":"text","text":"hi"}]}\n{"type":"qu';
  const chunk2 = 'estion","text":"ok?"}\n';
  const a = parser.push(chunk1);
  const b = parser.push(chunk2);
  assert.deepEqual(a, [{ kind: 'progress', role: 'assistant', chunk: 'hi' }]);
  assert.deepEqual(b, [{ kind: 'question', question: 'ok?' }]);
});

// --- partial-message streaming (--include-partial-messages) ---------------
//
// Field case: the architect's final design doc is ONE huge assistant
// message; without deltas the operator stream went silent for minutes and
// then everything appeared at once. Deltas surface live; the complete
// envelope that follows must not double-render the text.

test('StreamParser surfaces text_delta stream events as live progress chunks', () => {
  const parser = new StreamParser();
  const events = parser.push(
    '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hel"}}}\n'
    + '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"lo"}}}\n',
  );
  assert.deepEqual(events, [
    { kind: 'progress', role: 'assistant', chunk: 'Hel' },
    { kind: 'progress', role: 'assistant', chunk: 'lo' },
  ]);
});

test('StreamParser suppresses the duplicate text of the complete envelope after deltas', () => {
  const parser = new StreamParser();
  parser.push(
    '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}}\n',
  );
  const events = parser.push(
    '{"type":"assistant","message":{"content":['
    + '{"type":"text","text":"Hello"},'
    + '{"type":"tool_use","name":"Read","input":{"file_path":"x"}}'
    + ']}}\n',
  );
  // Text chunk dropped (already streamed); the tool_use activity survives.
  assert.equal(events.some((e) => e.kind === 'progress'), false);
  assert.equal(events.some((e) => e.kind === 'activity'), true);

  // A LATER assistant envelope with no preceding deltas renders normally
  // (the suppression flag reset after one envelope).
  const later = parser.push(
    '{"type":"assistant","message":{"content":[{"type":"text","text":"plain"}]}}\n',
  );
  assert.deepEqual(
    later.filter((e) => e.kind === 'progress'),
    [{ kind: 'progress', role: 'assistant', chunk: 'plain' }],
  );
});

test('StreamParser ignores non-text stream events; result still finishes', () => {
  const parser = new StreamParser();
  const noise = parser.push(
    '{"type":"stream_event","event":{"type":"message_start"}}\n'
    + '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"hm"}}}\n'
    + '{"type":"stream_event","event":{"type":"message_stop"}}\n',
  );
  assert.deepEqual(noise, []);
  assert.deepEqual(
    parser.push('{"type":"result","subtype":"success","result":"x"}\n'),
    [{ kind: 'finished', outcome: 'success' }],
  );
});

test('spawn args include --include-partial-messages', () => {
  const harness = spawnHarness();
  const runner = new ClaudeCliRunner({
    bus: recordingPublisher(),
    spawnImpl: harness.spawnImpl,
    sidecarDir: tmpSidecarDir(),
  });
  runner.start({ role: 'architect', prompt: 'p' });
  assert.ok(harness.args[0]!.args.includes('--include-partial-messages'));
});

test('StreamParser.flush drains a final non-newline-terminated tail', () => {
  const parser = new StreamParser();
  parser.push('{"type":"result","subtype":"success"');
  const drained = parser.flush();
  assert.equal(drained.length, 0); // incomplete JSON ignored
  parser.push('{"type":"result","subtype":"success","result":"x"}');
  assert.deepEqual(parser.flush(), [{ kind: 'finished', outcome: 'success' }]);
});

// ---------------------------------------------------------------------------
// AgentStarted ordering — AC #2
// ---------------------------------------------------------------------------

test('start synchronously enqueues AgentStarted before the handle is returned', async () => {
  const bus = recordingPublisher();
  const harness = spawnHarness();
  const runner = new ClaudeCliRunner({
    bus,
    spawnImpl: harness.spawnImpl,
    sidecarDir: tmpSidecarDir(),
    env: () => ({}),
  });

  const handle = runner.start({ role: 'echo', prompt: 'hi' });

  // The publish call inside start runs synchronously up to its first await,
  // so the recording bus has already captured AgentStarted by the time start
  // returns — even before any microtask flush.
  assert.equal(bus.events.length, 1);
  assert.equal(bus.events[0].type, 'AgentStarted');
  const payload = bus.events[0].payload as { agentId: string; role: string; pid: number };
  assert.equal(payload.agentId, handle.id);
  assert.equal(payload.role, 'echo');
  assert.equal(payload.pid, handle.pid);
  assert.equal(handle.pid, 4242);
});

test('start writes the spec.prompt to the child stdin', async () => {
  const bus = recordingPublisher();
  const harness = spawnHarness();
  const runner = new ClaudeCliRunner({
    bus,
    spawnImpl: harness.spawnImpl,
    sidecarDir: tmpSidecarDir(),
    env: () => ({}),
  });

  runner.start({ role: 'developer', prompt: 'do the thing' });
  await flush();

  const written = harness.spawned[0].stdin.read();
  assert.equal(written?.toString(), 'do the thing');
});

test('start resolves CLAUDE_MODEL and CLAUDE_EFFORT_<ROLE> from env at call time', () => {
  const bus = recordingPublisher();
  const harness = spawnHarness();
  const env: NodeJS.ProcessEnv = {};
  const runner = new ClaudeCliRunner({
    bus,
    spawnImpl: harness.spawnImpl,
    sidecarDir: tmpSidecarDir(),
    env: () => env,
  });

  env.CLAUDE_MODEL = 'claude-opus-4-7';
  env.CLAUDE_EFFORT_DEVELOPER = 'high';
  runner.start({ role: 'developer', prompt: 'p' });

  const args = harness.args[0].args;
  assert.ok(args.includes('claude-opus-4-7'), 'model arg picked up from env');
  assert.ok(args.includes('high'), 'effort arg picked up from CLAUDE_EFFORT_DEVELOPER');
});

// ---------------------------------------------------------------------------
// Role-keyed model routing — default_models[role] → developer → env → default
// ---------------------------------------------------------------------------

/** Pull the value the runner passed after `--model` for the latest spawn. */
function modelArg(harness: SpawnHarness, index = 0): string {
  const args = harness.args[index].args;
  const i = args.indexOf('--model');
  assert.ok(i >= 0 && i + 1 < args.length, '--model arg missing');
  return args[i + 1];
}

test('role-routing matrix: developer + reviewer + tester each take their default_models[role] entry', () => {
  const defaultModels = {
    developer: 'claude-opus-4-7',
    reviewer: 'claude-sonnet-4-6',
    tester: 'claude-haiku-4-5',
  };
  const cases: Array<{ role: string; expected: string }> = [
    { role: 'developer', expected: 'claude-opus-4-7' },
    { role: 'reviewer', expected: 'claude-sonnet-4-6' },
    { role: 'tester', expected: 'claude-haiku-4-5' },
  ];
  for (const { role, expected } of cases) {
    const bus = recordingPublisher();
    const harness = spawnHarness();
    const runner = new ClaudeCliRunner({
      bus,
      spawnImpl: harness.spawnImpl,
      sidecarDir: tmpSidecarDir(),
      env: () => ({}),
      defaultModels,
    });
    runner.start({ role, prompt: 'p' });
    assert.equal(
      modelArg(harness),
      expected,
      `role ${role} should pick defaultModels[${role}]`,
    );
  }
});

test('role-routing matrix: reviewer falls back to default_models.developer when default_models.reviewer is unset', () => {
  const bus = recordingPublisher();
  const harness = spawnHarness();
  const runner = new ClaudeCliRunner({
    bus,
    spawnImpl: harness.spawnImpl,
    sidecarDir: tmpSidecarDir(),
    env: () => ({}),
    defaultModels: { developer: 'claude-opus-4-7' },
  });

  runner.start({ role: 'reviewer', prompt: 'p' });
  assert.equal(modelArg(harness), 'claude-opus-4-7');
});

test('resolveDefaultModel (Agent record) wins over default_models[role]', () => {
  const bus = recordingPublisher();
  const harness = spawnHarness();
  const runner = new ClaudeCliRunner({
    bus,
    spawnImpl: harness.spawnImpl,
    sidecarDir: tmpSidecarDir(),
    env: () => ({}),
    defaultModels: { reviewer: 'claude-sonnet-4-6' },
    resolveDefaultModel: (role) => (role === 'reviewer' ? 'claude-sonnet-5' : undefined),
  });
  runner.start({ role: 'reviewer', prompt: 'p' });
  assert.equal(modelArg(harness), 'claude-sonnet-5');
});

test('explicit spec.metadata.model still wins over the Agent record (B-model-A precedence)', () => {
  const bus = recordingPublisher();
  const harness = spawnHarness();
  const runner = new ClaudeCliRunner({
    bus,
    spawnImpl: harness.spawnImpl,
    sidecarDir: tmpSidecarDir(),
    env: () => ({}),
    defaultModels: { reviewer: 'claude-sonnet-4-6' },
    resolveDefaultModel: () => 'claude-sonnet-5',
  });
  runner.start({ role: 'reviewer', prompt: 'p', metadata: { model: 'claude-opus-4-8' } });
  assert.equal(modelArg(harness), 'claude-opus-4-8');
});

test('resolveDefaultModel returning undefined falls through to default_models', () => {
  const bus = recordingPublisher();
  const harness = spawnHarness();
  const runner = new ClaudeCliRunner({
    bus,
    spawnImpl: harness.spawnImpl,
    sidecarDir: tmpSidecarDir(),
    env: () => ({}),
    defaultModels: { reviewer: 'claude-sonnet-4-6' },
    resolveDefaultModel: () => undefined,
  });
  runner.start({ role: 'reviewer', prompt: 'p' });
  assert.equal(modelArg(harness), 'claude-sonnet-4-6');
});

test('role-routing matrix: any role with no entry falls back to default_models.developer', () => {
  const bus = recordingPublisher();
  const harness = spawnHarness();
  const runner = new ClaudeCliRunner({
    bus,
    spawnImpl: harness.spawnImpl,
    sidecarDir: tmpSidecarDir(),
    env: () => ({}),
    defaultModels: { developer: 'claude-opus-4-7' },
  });

  runner.start({ role: 'tester', prompt: 'p' });
  runner.start({ role: 'doc-writer', prompt: 'p' });

  assert.equal(modelArg(harness, 0), 'claude-opus-4-7');
  assert.equal(modelArg(harness, 1), 'claude-opus-4-7');
});

test('role-routing matrix: default_models[role] beats env.CLAUDE_MODEL', () => {
  const bus = recordingPublisher();
  const harness = spawnHarness();
  const runner = new ClaudeCliRunner({
    bus,
    spawnImpl: harness.spawnImpl,
    sidecarDir: tmpSidecarDir(),
    env: () => ({ CLAUDE_MODEL: 'env-loser' }),
    defaultModels: { reviewer: 'claude-sonnet-4-6' },
  });

  runner.start({ role: 'reviewer', prompt: 'p' });
  assert.equal(modelArg(harness), 'claude-sonnet-4-6');
});

test('role-routing matrix: env.CLAUDE_MODEL applies only when default_models is empty', () => {
  const bus = recordingPublisher();
  const harness = spawnHarness();
  const runner = new ClaudeCliRunner({
    bus,
    spawnImpl: harness.spawnImpl,
    sidecarDir: tmpSidecarDir(),
    env: () => ({ CLAUDE_MODEL: 'claude-env-set' }),
    // defaultModels omitted entirely
  });

  runner.start({ role: 'reviewer', prompt: 'p' });
  assert.equal(modelArg(harness), 'claude-env-set');
});

test('role-routing matrix: hardcoded default is used when no model source resolves', () => {
  const bus = recordingPublisher();
  const harness = spawnHarness();
  const runner = new ClaudeCliRunner({
    bus,
    spawnImpl: harness.spawnImpl,
    sidecarDir: tmpSidecarDir(),
    env: () => ({}),
  });

  runner.start({ role: 'reviewer', prompt: 'p' });
  assert.equal(modelArg(harness), 'claude-sonnet-4-6');
});

// ---------------------------------------------------------------------------
// Stream → bus republish — AC #3, AC #4, AC #5
// ---------------------------------------------------------------------------

test('assistant / question / result lines republish as AgentProgress / AgentQuestion / AgentFinished', async () => {
  const bus = recordingPublisher();
  const harness = spawnHarness();
  const runner = new ClaudeCliRunner({
    bus,
    spawnImpl: harness.spawnImpl,
    sidecarDir: tmpSidecarDir(),
    env: () => ({}),
  });

  runner.start({ role: 'echo', prompt: 'hi' });
  const child = harness.spawned[0];

  child.stdout.write(
    JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'thinking...' }] },
    }) + '\n',
  );
  child.stdout.write(JSON.stringify({ type: 'question', text: 'continue?' }) + '\n');
  child.stdout.write(
    JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' }) + '\n',
  );
  child.stdout.end();
  child.emit('close', 0, null);

  await flush();
  await flush();

  const types = bus.events.map((e) => e.type);
  assert.deepEqual(types, [
    'AgentStarted',
    'AgentProgress',
    'AgentQuestion',
    'AgentFinished',
  ]);

  const progress = bus.events[1].payload as { role: string; chunk: string };
  assert.equal(progress.role, 'assistant');
  assert.equal(progress.chunk, 'thinking...');

  const question = bus.events[2].payload as { question: string };
  assert.equal(question.question, 'continue?');

  const finished = bus.events[3].payload as { outcome: string };
  assert.equal(finished.outcome, 'success');
});

// ---------------------------------------------------------------------------
// AgentFailed on non-zero exit — AC #6
// ---------------------------------------------------------------------------

test('non-zero exit publishes AgentFailed with the captured tail of stderr', async () => {
  const bus = recordingPublisher();
  const harness = spawnHarness();
  const runner = new ClaudeCliRunner({
    bus,
    spawnImpl: harness.spawnImpl,
    sidecarDir: tmpSidecarDir(),
    env: () => ({}),
    stderrTailBytes: 32,
  });

  runner.start({ role: 'echo', prompt: 'hi' });
  const child = harness.spawned[0];

  child.stderr.write('first chunk of stderr noise\n');
  child.stderr.write('FATAL: model exploded\n');
  child.stderr.end();
  child.stdout.end();
  child.emit('close', 7, null);

  await flush();
  await flush();

  const failed = bus.events.find((e) => e.type === 'AgentFailed');
  assert.ok(failed, 'AgentFailed should have been published');
  const payload = failed!.payload as { exitCode: number; stderrTail: string };
  assert.equal(payload.exitCode, 7);
  assert.ok(
    payload.stderrTail.includes('FATAL: model exploded'),
    `stderr tail should retain the most recent bytes, got: ${payload.stderrTail}`,
  );
  // No AgentFinished should have fired alongside the failure.
  assert.equal(bus.events.find((e) => e.type === 'AgentFinished'), undefined);
});

// ---------------------------------------------------------------------------
// interrupt() writes the sidecar BEFORE killing — AC #7
// ---------------------------------------------------------------------------

test('interrupt writes the .killed sidecar file before invoking the killer', async () => {
  const bus = recordingPublisher();
  const harness = spawnHarness();
  const sidecarDir = tmpSidecarDir();

  const observed: { sidecarExisted: boolean; pid: number }[] = [];
  let runnerRef: ClaudeCliRunner | null = null;

  const runner = new ClaudeCliRunner({
    bus,
    spawnImpl: harness.spawnImpl,
    sidecarDir,
    env: () => ({}),
    killer: (pid) => {
      // Capture state at the moment kill is called. The sidecar must already
      // exist on disk by this point — that's the whole purpose of the marker.
      const sidecar = runnerRef!.killedSidecarPath(handleRef!.id);
      observed.push({ sidecarExisted: fs.existsSync(sidecar), pid });
    },
  });
  runnerRef = runner;

  const handleRef = runner.start({ role: 'echo', prompt: 'hi' });
  await flush();

  await runner.interrupt(handleRef);

  assert.equal(observed.length, 1, 'killer should have been called exactly once');
  assert.equal(observed[0].sidecarExisted, true, 'sidecar must exist before kill runs');
  assert.equal(observed[0].pid, 4242);

  // And the file is still there post-call.
  const sidecar = runner.killedSidecarPath(handleRef.id);
  assert.equal(fs.existsSync(sidecar), true);
  const contents = JSON.parse(fs.readFileSync(sidecar, 'utf8')) as {
    pid: number;
    killedAt: number;
  };
  assert.equal(contents.pid, 4242);
  assert.equal(typeof contents.killedAt, 'number');
});

test('interrupt is idempotent on an already-exited handle', async () => {
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

  // Process already exited and was removed from the active map.
  await runner.interrupt(handle);
  assert.equal(killCalls, 0);
});

test('interrupt followed by exit publishes AgentFinished with outcome=interrupted', async () => {
  const bus = recordingPublisher();
  const harness = spawnHarness();
  const runner = new ClaudeCliRunner({
    bus,
    spawnImpl: harness.spawnImpl,
    sidecarDir: tmpSidecarDir(),
    env: () => ({}),
    killer: () => {
      /* no-op */
    },
  });

  const handle = runner.start({ role: 'echo', prompt: 'hi' });
  await flush();
  const child = harness.spawned[0];

  await runner.interrupt(handle);
  child.stdout.end();
  child.emit('close', null, 'SIGTERM');
  await flush();
  await flush();

  const finished = bus.events.find((e) => e.type === 'AgentFinished');
  assert.ok(finished, 'AgentFinished should be emitted on operator-driven exit');
  assert.equal((finished!.payload as { outcome: string }).outcome, 'interrupted');
  assert.equal(bus.events.find((e) => e.type === 'AgentFailed'), undefined);
});

// ---------------------------------------------------------------------------
// AP-VP-011: per-call model/effort overrides + per-role env-var resolution.
//
// Resolution order asserted below:
//
//   model:  spec.metadata.model
//             → defaultModels[role] / defaultModels.developer  (covered above)
//             → env.CLAUDE_MODEL_<ROLE>
//             → env.CLAUDE_MODEL
//             → hardcoded 'claude-sonnet-4-6'                  (covered above)
//
//   effort: spec.metadata.effort
//             → env.CLAUDE_EFFORT_<ROLE>
//             → env.CLAUDE_EFFORT
//             → env.CLAUDE_EFFORT_DEFAULT (legacy alias)
//             → hardcoded 'medium'
//
// All env reads happen at call time, so mutating process.env (or the
// injected env-getter snapshot) between calls must flip the resolved
// argument on the very next spawn.
// ---------------------------------------------------------------------------

/** Pull the value the runner passed after `--effort` for the latest spawn. */
function effortArg(harness: SpawnHarness, index = 0): string {
  const args = harness.args[index].args;
  const i = args.indexOf('--effort');
  assert.ok(i >= 0 && i + 1 < args.length, '--effort arg missing');
  return args[i + 1];
}

test('spec.metadata.model wins over CLAUDE_MODEL_<ROLE> and CLAUDE_MODEL env vars', () => {
  const bus = recordingPublisher();
  const harness = spawnHarness();
  const runner = new ClaudeCliRunner({
    bus,
    spawnImpl: harness.spawnImpl,
    sidecarDir: tmpSidecarDir(),
    env: () => ({
      CLAUDE_MODEL_DEVELOPER: 'env-role-loser',
      CLAUDE_MODEL: 'env-global-loser',
    }),
  });

  runner.start({
    role: 'developer',
    prompt: 'p',
    metadata: { model: 'claude-from-step' },
  });

  assert.equal(modelArg(harness), 'claude-from-step');
});

test('spec.metadata.effort wins over CLAUDE_EFFORT_<ROLE> and CLAUDE_EFFORT env vars', () => {
  const bus = recordingPublisher();
  const harness = spawnHarness();
  const runner = new ClaudeCliRunner({
    bus,
    spawnImpl: harness.spawnImpl,
    sidecarDir: tmpSidecarDir(),
    env: () => ({
      CLAUDE_EFFORT_DEVELOPER: 'env-role-loser',
      CLAUDE_EFFORT: 'env-global-loser',
    }),
  });

  runner.start({
    role: 'developer',
    prompt: 'p',
    metadata: { effort: 'low' },
  });

  assert.equal(effortArg(harness), 'low');
});

test('CLAUDE_MODEL_<ROLE> wins over CLAUDE_MODEL when no explicit override is passed', () => {
  const bus = recordingPublisher();
  const harness = spawnHarness();
  const runner = new ClaudeCliRunner({
    bus,
    spawnImpl: harness.spawnImpl,
    sidecarDir: tmpSidecarDir(),
    env: () => ({
      CLAUDE_MODEL_DEVELOPER: 'claude-role-specific',
      CLAUDE_MODEL: 'claude-global',
    }),
  });

  runner.start({ role: 'developer', prompt: 'p' });

  assert.equal(modelArg(harness), 'claude-role-specific');
});

test('CLAUDE_EFFORT wins over CLAUDE_EFFORT_DEFAULT when CLAUDE_EFFORT_<ROLE> is unset', () => {
  const bus = recordingPublisher();
  const harness = spawnHarness();
  const runner = new ClaudeCliRunner({
    bus,
    spawnImpl: harness.spawnImpl,
    sidecarDir: tmpSidecarDir(),
    env: () => ({
      CLAUDE_EFFORT: 'medium-explicit',
      CLAUDE_EFFORT_DEFAULT: 'legacy-default-loser',
    }),
  });

  runner.start({ role: 'reviewer', prompt: 'p' });

  assert.equal(effortArg(harness), 'medium-explicit');
});

test('role string is upper-cased for the CLAUDE_MODEL_<ROLE> / CLAUDE_EFFORT_<ROLE> env lookups', () => {
  const bus = recordingPublisher();
  const harness = spawnHarness();
  // Spec passes the role in mixed case. The env vars are upper-cased.
  // If the runner did NOT upper-case the role, neither var would match
  // and resolution would fall through to CLAUDE_MODEL / CLAUDE_EFFORT.
  const runner = new ClaudeCliRunner({
    bus,
    spawnImpl: harness.spawnImpl,
    sidecarDir: tmpSidecarDir(),
    env: () => ({
      CLAUDE_MODEL_DEVELOPER: 'role-cased-model',
      CLAUDE_EFFORT_DEVELOPER: 'role-cased-effort',
      CLAUDE_MODEL: 'wrong-fallback-model',
      CLAUDE_EFFORT: 'wrong-fallback-effort',
    }),
  });

  runner.start({ role: 'developer', prompt: 'p' });
  assert.equal(modelArg(harness), 'role-cased-model');
  assert.equal(effortArg(harness), 'role-cased-effort');

  // Lower-case role token in the spec — same env, must still hit the
  // upper-cased key (i.e. the runner upper-cased before lookup).
  runner.start({ role: 'Developer', prompt: 'p' });
  assert.equal(modelArg(harness, 1), 'role-cased-model');
  assert.equal(effortArg(harness, 1), 'role-cased-effort');
});

test('env reads happen at call time — mutating process.env between three consecutive calls flips each resolved model', () => {
  const bus = recordingPublisher();
  const harness = spawnHarness();
  // Default `env: () => process.env` snapshot is used here so we exercise
  // the real call-time read path (the resolveEnv contract in the runner).
  const runner = new ClaudeCliRunner({
    bus,
    spawnImpl: harness.spawnImpl,
    sidecarDir: tmpSidecarDir(),
  });

  // Snapshot + clear the vars this test owns so the assertions are not
  // contaminated by whatever the shell exported.
  const prior = {
    CLAUDE_MODEL: process.env.CLAUDE_MODEL,
    CLAUDE_MODEL_DEVELOPER: process.env.CLAUDE_MODEL_DEVELOPER,
    CLAUDE_EFFORT: process.env.CLAUDE_EFFORT,
    CLAUDE_EFFORT_DEVELOPER: process.env.CLAUDE_EFFORT_DEVELOPER,
    CLAUDE_EFFORT_DEFAULT: process.env.CLAUDE_EFFORT_DEFAULT,
  };
  delete process.env.CLAUDE_MODEL;
  delete process.env.CLAUDE_MODEL_DEVELOPER;
  delete process.env.CLAUDE_EFFORT;
  delete process.env.CLAUDE_EFFORT_DEVELOPER;
  delete process.env.CLAUDE_EFFORT_DEFAULT;

  try {
    // Call 1: only CLAUDE_MODEL is set — the runner should pick it up.
    process.env.CLAUDE_MODEL = 'global-model-v1';
    runner.start({ role: 'developer', prompt: 'p' });
    assert.equal(modelArg(harness, 0), 'global-model-v1');

    // Call 2: a per-role override appears in process.env BETWEEN calls.
    // Because env is read at call time (not module load, not constructor),
    // this call must resolve to the role-keyed value even though the
    // global is still set.
    process.env.CLAUDE_MODEL_DEVELOPER = 'role-model-v2';
    runner.start({ role: 'developer', prompt: 'p' });
    assert.equal(modelArg(harness, 1), 'role-model-v2');

    // Call 3: an explicit per-call override beats both env vars. The two
    // env vars are still set — but spec.metadata.model wins.
    runner.start({
      role: 'developer',
      prompt: 'p',
      metadata: { model: 'explicit-call-arg-v3' },
    });
    assert.equal(modelArg(harness, 2), 'explicit-call-arg-v3');
  } finally {
    // Restore caller env so we don't leak into adjacent tests.
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('env reads happen at call time — mutating process.env between three consecutive calls flips each resolved effort', () => {
  const bus = recordingPublisher();
  const harness = spawnHarness();
  const runner = new ClaudeCliRunner({
    bus,
    spawnImpl: harness.spawnImpl,
    sidecarDir: tmpSidecarDir(),
  });

  const prior = {
    CLAUDE_EFFORT: process.env.CLAUDE_EFFORT,
    CLAUDE_EFFORT_REVIEWER: process.env.CLAUDE_EFFORT_REVIEWER,
    CLAUDE_EFFORT_DEFAULT: process.env.CLAUDE_EFFORT_DEFAULT,
  };
  delete process.env.CLAUDE_EFFORT;
  delete process.env.CLAUDE_EFFORT_REVIEWER;
  delete process.env.CLAUDE_EFFORT_DEFAULT;

  try {
    // Call 1: only CLAUDE_EFFORT (global) is set.
    process.env.CLAUDE_EFFORT = 'effort-global-v1';
    runner.start({ role: 'reviewer', prompt: 'p' });
    assert.equal(effortArg(harness, 0), 'effort-global-v1');

    // Call 2: CLAUDE_EFFORT_REVIEWER appears between calls — wins over
    // the global because env reads run at call time.
    process.env.CLAUDE_EFFORT_REVIEWER = 'effort-role-v2';
    runner.start({ role: 'reviewer', prompt: 'p' });
    assert.equal(effortArg(harness, 1), 'effort-role-v2');

    // Call 3: explicit per-call override beats both.
    runner.start({
      role: 'reviewer',
      prompt: 'p',
      metadata: { effort: 'effort-call-v3' },
    });
    assert.equal(effortArg(harness, 2), 'effort-call-v3');
  } finally {
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('non-string metadata.model / metadata.effort is ignored and falls through to env-var resolution', () => {
  const bus = recordingPublisher();
  const harness = spawnHarness();
  const runner = new ClaudeCliRunner({
    bus,
    spawnImpl: harness.spawnImpl,
    sidecarDir: tmpSidecarDir(),
    env: () => ({
      CLAUDE_MODEL_DEVELOPER: 'fallback-model',
      CLAUDE_EFFORT_DEVELOPER: 'fallback-effort',
    }),
  });

  // Empty strings, numbers, and undefined are all rejected — the runner
  // must not pass `--model undefined` (or `--model ''`) downstream because
  // the CLI would treat that as a literal model id.
  runner.start({
    role: 'developer',
    prompt: 'p',
    metadata: { model: '', effort: 42 },
  });
  assert.equal(modelArg(harness, 0), 'fallback-model');
  assert.equal(effortArg(harness, 0), 'fallback-effort');

  runner.start({
    role: 'developer',
    prompt: 'p',
    metadata: { model: undefined, effort: undefined },
  });
  assert.equal(modelArg(harness, 1), 'fallback-model');
  assert.equal(effortArg(harness, 1), 'fallback-effort');
});

test('an empty prompt kills the spawn instead of starting a promptless run', () => {
  // Field incident: a child that receives no stdin waits 3s, warns
  // "no stdin data received", and dies with an opaque "Input must be
  // provided..." — the runner must fail fast and loudly instead.
  const bus = recordingPublisher();
  const harness = spawnHarness();
  const killed: number[] = [];
  const runner = new ClaudeCliRunner({
    bus,
    spawnImpl: harness.spawnImpl,
    sidecarDir: tmpSidecarDir(),
    env: () => ({}),
    killer: (pid) => { killed.push(pid); },
  });

  runner.start({ role: 'architect', prompt: '' });

  assert.deepEqual(killed, [4242], 'promptless child must be killed immediately');
});

test('an async stdin stream error is logged, not an uncaught crash', async () => {
  const bus = recordingPublisher();
  const harness = spawnHarness();
  const warns: string[] = [];
  const runner = new ClaudeCliRunner({
    bus,
    spawnImpl: harness.spawnImpl,
    sidecarDir: tmpSidecarDir(),
    env: () => ({}),
    logger: {
      info: () => {},
      debug: () => {},
      error: () => {},
      warn: (msg: string) => { warns.push(msg); },
    },
  });

  runner.start({ role: 'developer', prompt: 'do the thing' });
  // Simulate the child dying before consuming stdin (EPIPE shape).
  harness.spawned[0].stdin.emit('error', new Error('EPIPE'));
  await flush();

  assert.ok(
    warns.some((w) => w.includes('stdin stream error')),
    `expected a stdin stream warning, got: ${warns.join(' | ')}`,
  );
});
