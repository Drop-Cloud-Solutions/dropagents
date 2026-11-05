/**
 * Per-RUN metadata must not ride on per-CHUNK events.
 *
 * Field measurement (worker, 2026-11-03, `npm run db:report`): of
 * 679.5 MB of event payload, `AgentProgress` was 585.8 MB over 120011
 * rows — 5.0 KB a row for chunks that are text deltas of tens of bytes.
 * `publishParsed` spread the whole `AgentSpec.metadata` onto every
 * delta, and the two heavy entries are per-RUN context: the rendered
 * agent-memory block (which only ever grows) and the previous step's
 * full reject feedback.
 *
 * The pure filter is covered in `core/agents/stream-metadata.test.ts`.
 * These pin the WIRING, which is where it actually bit: the right tail
 * on the right event. A test of the filter alone would have passed
 * throughout the period that produced those 585.8 MB.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import type { Event } from '../../core/events/event';

import {
  ClaudeCliRunner,
  type EventPublisher,
  type SpawnImpl,
} from './ClaudeCliRunner';

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

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) await new Promise(setImmediate);
};

const AGENT_MEMORY = 'operator said: always bump the patch version. '.repeat(200);
const REJECT_FEEDBACK = 'CHANGES REQUIRED: the test is wrong. '.repeat(200);

/** Spec metadata as a real task dispatch builds it. */
const METADATA = {
  taskId: 'T-PKG-005',
  stepId: 'commit',
  planId: 'plan-1700000000000-abcd',
  kind: 'task',
  model: 'claude-opus-5',
  agentMemory: AGENT_MEMORY,
  rejectFeedback: REJECT_FEEDBACK,
};

async function runWithMetadata(): Promise<Event[]> {
  const bus = recordingPublisher();
  const children: FakeChild[] = [];
  const spawnImpl: SpawnImpl = (() => {
    const c = fakeChild();
    children.push(c);
    return c as unknown as ReturnType<SpawnImpl>;
  }) as SpawnImpl;

  const runner = new ClaudeCliRunner({
    bus,
    spawnImpl,
    env: () => ({}),
  });
  runner.start({ role: 'committer', prompt: 'commit it', metadata: METADATA });
  await flush();
  const child = children[0]!;

  // Two assistant text blocks and a tool frame, then the terminal
  // result — the shape of any real run.
  child.stdout.write(
    JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'reading TASK.md' }] },
    }) + '\n',
  );
  child.stdout.write(
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', name: 'Bash', input: { command: 'git status' } }],
      },
    }) + '\n',
  );
  child.stdout.write(
    JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'committing now' }] },
    }) + '\n',
  );
  child.stdout.write(
    JSON.stringify({ type: 'result', subtype: 'success', result: 'done' }) + '\n',
  );
  child.stdout.end();
  await flush();
  return bus.events;
}

const metaOf = (event: Event | undefined): Record<string, unknown> =>
  ((event?.payload as Record<string, unknown> | undefined)?.metadata
    ?? {}) as Record<string, unknown>;

test('AgentProgress carries the routing keys but not the per-run prose', async () => {
  const events = await runWithMetadata();
  const progress = events.filter((e) => e.type === 'AgentProgress');
  assert.ok(progress.length >= 2, `expected progress events, got ${progress.length}`);

  for (const event of progress) {
    const md = metaOf(event);
    // The keys subscribers route a chunk by. `kind` + `planId` are the
    // board's planner/decomposer discrimination — dropping those would
    // silently detach the Show-agent stream from its row.
    assert.equal(md.taskId, 'T-PKG-005');
    assert.equal(md.stepId, 'commit');
    assert.equal(md.planId, 'plan-1700000000000-abcd');
    assert.equal(md.kind, 'task');
    assert.equal(md.model, 'claude-opus-5');
    // The 5 KB a row.
    assert.equal(md.agentMemory, undefined, 'agent memory rode on a chunk');
    assert.equal(md.rejectFeedback, undefined, 'reject feedback rode on a chunk');
    assert.ok(
      !JSON.stringify(event.payload).includes('operator said:'),
      'the agent-memory text reached a per-chunk event',
    );
  }
});

test('AgentActivity is slimmed too — tool frames are just as frequent', async () => {
  const events = await runWithMetadata();
  const activity = events.filter((e) => e.type === 'AgentActivity');
  assert.ok(activity.length >= 1, 'expected at least one tool frame');
  for (const event of activity) {
    assert.equal(metaOf(event).agentMemory, undefined);
    assert.equal(metaOf(event).rejectFeedback, undefined);
    assert.equal(metaOf(event).taskId, 'T-PKG-005', 'routing key must survive');
  }
});

test('AgentFinished keeps the FULL metadata', async () => {
  // The terminal event fires once per run, and subscribers legitimately
  // read the richer fields off it. Slimming everything indiscriminately
  // would have been the easy mistake here.
  const events = await runWithMetadata();
  const finished = events.find((e) => e.type === 'AgentFinished');
  assert.ok(finished, 'the run must still finish');
  const md = metaOf(finished);
  assert.equal(md.agentMemory, AGENT_MEMORY, 'agent memory must survive on the terminal event');
  assert.equal(md.rejectFeedback, REJECT_FEEDBACK);
  assert.equal(md.taskId, 'T-PKG-005');
});

test('AgentStarted keeps the FULL metadata', async () => {
  const events = await runWithMetadata();
  const started = events.find((e) => e.type === 'AgentStarted');
  assert.ok(started);
  assert.equal(metaOf(started).agentMemory, AGENT_MEMORY);
});

test('the saving across one run is most of the bytes', async () => {
  const events = await runWithMetadata();
  const bytes = (types: readonly string[]): number => events
    .filter((e) => types.includes(e.type))
    .reduce((sum, e) => sum + JSON.stringify(e.payload).length, 0);

  const streamed = bytes(['AgentProgress', 'AgentActivity', 'AgentQuestion']);
  const fatPerEvent = JSON.stringify(METADATA).length;
  const streamedCount = events.filter((e) =>
    ['AgentProgress', 'AgentActivity', 'AgentQuestion'].includes(e.type)).length;
  // What the old code would have published for the same run.
  const wouldHaveBeen = streamed + fatPerEvent * streamedCount;
  assert.ok(
    streamed < wouldHaveBeen / 5,
    `expected a >5x cut on the streamed events, got ${wouldHaveBeen} -> ${streamed}`,
  );
});

test('a run with no metadata publishes no metadata key at all', async () => {
  // Slimming must not turn "no metadata" into `metadata: {}` on every
  // chunk — that would ADD bytes to the exact events this is about.
  const bus = recordingPublisher();
  const children: FakeChild[] = [];
  const spawnImpl: SpawnImpl = (() => {
    const c = fakeChild();
    children.push(c);
    return c as unknown as ReturnType<SpawnImpl>;
  }) as SpawnImpl;
  const runner = new ClaudeCliRunner({ bus, spawnImpl, env: () => ({}) });
  runner.start({ role: 'echo', prompt: 'hi' });
  await flush();
  const child = children[0]!;
  child.stdout.write(
    JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'hello' }] },
    }) + '\n',
  );
  child.stdout.write(
    JSON.stringify({ type: 'result', subtype: 'success', result: 'ok' }) + '\n',
  );
  child.stdout.end();
  await flush();

  for (const event of bus.events.filter((e) => e.type === 'AgentProgress')) {
    assert.ok(
      !Object.prototype.hasOwnProperty.call(event.payload as object, 'metadata'),
      'an empty metadata object was published on a chunk',
    );
  }
});
