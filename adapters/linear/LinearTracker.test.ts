import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { openDatabase, applyMigrations, type Db } from '../../core/state/migrations';
import { EventStore } from '../../core/events/store';
import { EventBus } from '../../core/events/bus';
import type { Event, StoredEvent } from '../../core/events/event';
import type { IssueRef, IssueTracker, ProjectRef } from '../../core/ports';
import type { Logger } from '../../core/ports/Logger';

import { createLinearClient, LinearApiError, type LinearClient } from './client';
import { LinearTracker, LINEAR_SYSTEM, type ExternalRefsWriter } from './LinearTracker';
import { LinearStateBootstrap, PIPELINE_LABEL_SEED } from './LinearStateBootstrap';
import {
  LINEAR_SUBSCRIBER,
  LinearEvents,
  registerLinearSubscriber,
  type ExternalRefsReader
} from './subscriber';
import { HUMAN_LABELS } from '../../core/projects/issue-status';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

class FakeLogger implements Logger {
  readonly entries: Array<{ level: string; message: string; meta?: Readonly<Record<string, unknown>> }> = [];
  info(m: string, meta?: Readonly<Record<string, unknown>>): void {
    this.entries.push({ level: 'info', message: m, meta });
  }
  warn(m: string, meta?: Readonly<Record<string, unknown>>): void {
    this.entries.push({ level: 'warn', message: m, meta });
  }
  error(m: string, meta?: Readonly<Record<string, unknown>>): void {
    this.entries.push({ level: 'error', message: m, meta });
  }
  debug(m: string, meta?: Readonly<Record<string, unknown>>): void {
    this.entries.push({ level: 'debug', message: m, meta });
  }
}

interface StubCall {
  readonly query: string;
  readonly variables: Readonly<Record<string, unknown>>;
}

type StubResponder = (call: StubCall) => unknown | Promise<unknown>;

class StubLinearClient implements LinearClient {
  readonly calls: StubCall[] = [];
  constructor(private readonly responder: StubResponder) {}
  async request<T>(query: string, opts: { variables?: Readonly<Record<string, unknown>> } = {}): Promise<T> {
    const call: StubCall = { query, variables: opts.variables ?? {} };
    this.calls.push(call);
    const result = await this.responder(call);
    return result as T;
  }
}

class MemoryExternalRefs implements ExternalRefsWriter, ExternalRefsReader {
  readonly rows = new Map<string, string>();
  write(localId: string, externalId: string): void {
    this.rows.set(localId, externalId);
  }
  read(localId: string): string | undefined {
    return this.rows.get(localId);
  }
}

function matchMutation(query: string, name: string): boolean {
  // Mutations are written as `mutation <Name>(...)` — match the operation
  // name without depending on exact whitespace.
  const re = new RegExp(`mutation\\s+${name}\\b`);
  return re.test(query);
}

function freshDb(): Db {
  const db = openDatabase(':memory:');
  applyMigrations(db);
  return db;
}

// ---------------------------------------------------------------------------
// AC #1: implements IssueTracker port verbatim — no in-flight surface
// ---------------------------------------------------------------------------

test('LinearTracker only exposes the four terminal IssueTracker methods', () => {
  const tracker = new LinearTracker({
    client: new StubLinearClient(() => ({})),
    externalRefs: new MemoryExternalRefs(),
    getTeamId: () => 'team-1'
  });

  // Compile-time: assignable to IssueTracker. Runtime: every required
  // method is present and callable on the instance.
  const asPort: IssueTracker = tracker;
  assert.equal(typeof asPort.createProject, 'function');
  assert.equal(typeof asPort.createIssue, 'function');
  assert.equal(typeof asPort.closeIssue, 'function');
  assert.equal(typeof asPort.skipIssue, 'function');

  const forbidden = [
    'setInProgress',
    'startIssue',
    'updateStatus',
    'updateState',
    'setLabels',
    'addLabels',
    'moveToColumn',
    'transition',
    'progressIssue'
  ];
  for (const name of forbidden) {
    assert.equal(
      (tracker as unknown as Record<string, unknown>)[name],
      undefined,
      `LinearTracker must not expose in-flight method "${name}"`
    );
  }
});

// ---------------------------------------------------------------------------
// AC #2: createProject — Linear mutation + external_refs row
// ---------------------------------------------------------------------------

test('createProject calls projectCreate, links the initiative, and records external_refs', async () => {
  const refs = new MemoryExternalRefs();
  const client = new StubLinearClient((call) => {
    if (matchMutation(call.query, 'CreateProject')) {
      return { projectCreate: { success: true, project: { id: 'lin-proj-1', name: 'Plan 1' } } };
    }
    if (matchMutation(call.query, 'LinkProject')) {
      return { initiativeToProjectCreate: { success: true } };
    }
    throw new Error(`unexpected query: ${call.query}`);
  });

  const tracker = new LinearTracker({
    client,
    externalRefs: refs,
    getTeamId: () => 'team-1',
    getInitiativeId: () => 'init-1'
  });

  const ref = await tracker.createProject({
    name: 'Plan 1',
    description: 'desc',
    key: 'plan-local-1'
  });

  assert.deepEqual(ref, { id: 'lin-proj-1', name: 'Plan 1' });

  // Mutation 1: projectCreate with the supplied team + name + description.
  assert.ok(matchMutation(client.calls[0].query, 'CreateProject'));
  const createInput = client.calls[0].variables.input as Record<string, unknown>;
  assert.equal(createInput.name, 'Plan 1');
  assert.deepEqual(createInput.teamIds, ['team-1']);
  assert.equal(createInput.description, 'desc');

  // Mutation 2: initiative link issued separately, because ProjectCreateInput
  // has no initiativeId field on Linear's schema.
  assert.ok(matchMutation(client.calls[1].query, 'LinkProject'));
  const linkInput = client.calls[1].variables.input as Record<string, unknown>;
  assert.deepEqual(linkInput, { initiativeId: 'init-1', projectId: 'lin-proj-1' });

  // AC #2: external_refs row written under system='linear'. The MemoryExternalRefs
  // is scoped to the Linear adapter, so a recorded mapping IS the linear-system row.
  assert.equal(refs.read('plan-local-1'), 'lin-proj-1');
  assert.equal(LINEAR_SYSTEM, 'linear');
});

test('createProject truncates descriptions longer than 255 characters', async () => {
  const refs = new MemoryExternalRefs();
  const long = 'x'.repeat(400);
  const client = new StubLinearClient((call) => {
    if (matchMutation(call.query, 'CreateProject')) {
      return { projectCreate: { success: true, project: { id: 'p', name: 'n' } } };
    }
    throw new Error(`unexpected query: ${call.query}`);
  });
  const tracker = new LinearTracker({
    client,
    externalRefs: refs,
    getTeamId: () => 'team-1'
  });
  await tracker.createProject({ name: 'n', description: long, key: 'k' });
  const desc = (client.calls[0].variables.input as { description: string }).description;
  assert.equal(desc.length, 255);
  assert.ok(desc.endsWith('...'));
});

test('createProject throws when the LINEAR_TEAM_ID getter returns undefined', async () => {
  const tracker = new LinearTracker({
    client: new StubLinearClient(() => ({})),
    externalRefs: new MemoryExternalRefs(),
    getTeamId: () => undefined
  });
  await assert.rejects(() => tracker.createProject({ name: 'x' }), /LINEAR_TEAM_ID/);
});

// ---------------------------------------------------------------------------
// AC #1 (createIssue) — issueCreate mutation surface
// ---------------------------------------------------------------------------

test('createIssue calls issueCreate with team + project + title and returns the ref', async () => {
  const client = new StubLinearClient((call) => {
    if (matchMutation(call.query, 'CreateIssue')) {
      return { issueCreate: { success: true, issue: { id: 'lin-iss-1', title: 'echo' } } };
    }
    throw new Error(`unexpected query: ${call.query}`);
  });
  const tracker = new LinearTracker({
    client,
    externalRefs: new MemoryExternalRefs(),
    getTeamId: () => 'team-1'
  });

  const ref = await tracker.createIssue({
    title: 'echo',
    projectId: 'lin-proj-1',
    labels: ['pipeline:type:implement']
  });

  assert.deepEqual(ref, { id: 'lin-iss-1', title: 'echo' });
  assert.ok(matchMutation(client.calls[0].query, 'CreateIssue'));
  const input = client.calls[0].variables.input as Record<string, unknown>;
  assert.equal(input.teamId, 'team-1');
  assert.equal(input.projectId, 'lin-proj-1');
  assert.equal(input.title, 'echo');
  assert.deepEqual(input.labelIds, ['pipeline:type:implement']);
});

// ---------------------------------------------------------------------------
// AC #3: closeIssue — Done state + appended summary in description
// ---------------------------------------------------------------------------

test('closeIssue resolves Done, fetches description, then appends summary on issueUpdate', async () => {
  const client = new StubLinearClient((call) => {
    if (call.query.includes('TeamStates')) {
      return {
        team: {
          states: {
            nodes: [
              { id: 'state-backlog', name: 'Backlog', type: 'backlog' },
              { id: 'state-done', name: 'Done', type: 'completed' },
              { id: 'state-cancel', name: 'Cancelled', type: 'canceled' }
            ]
          }
        }
      };
    }
    if (call.query.includes('IssueDescription')) {
      return { issue: { description: 'original description' } };
    }
    if (matchMutation(call.query, 'CloseIssue')) {
      return { issueUpdate: { success: true } };
    }
    throw new Error(`unexpected query: ${call.query}`);
  });
  const tracker = new LinearTracker({
    client,
    externalRefs: new MemoryExternalRefs(),
    getTeamId: () => 'team-1'
  });

  await tracker.closeIssue('lin-iss-1', 'shipped — PR https://example.invalid/pr/7');

  const closeCall = client.calls.find((c) => matchMutation(c.query, 'CloseIssue'));
  assert.ok(closeCall, 'CloseIssue mutation must have been issued');
  const input = closeCall.variables.input as { stateId: string; description: string };
  assert.equal(input.stateId, 'state-done');
  // Appended — original kept, summary on the tail.
  assert.ok(input.description.startsWith('original description'));
  assert.ok(input.description.includes('shipped — PR https://example.invalid/pr/7'));
});

// ---------------------------------------------------------------------------
// AC #4: skipIssue — Cancelled state + comment with reason
// ---------------------------------------------------------------------------

test('skipIssue updates state to Cancelled and writes a comment with the reason', async () => {
  const client = new StubLinearClient((call) => {
    if (call.query.includes('TeamStates')) {
      return {
        team: {
          states: {
            nodes: [
              { id: 'state-done', name: 'Done', type: 'completed' },
              { id: 'state-cancel', name: 'Cancelled', type: 'canceled' }
            ]
          }
        }
      };
    }
    if (matchMutation(call.query, 'SkipIssue')) {
      return { issueUpdate: { success: true } };
    }
    if (matchMutation(call.query, 'SkipReason')) {
      return { commentCreate: { success: true } };
    }
    throw new Error(`unexpected query: ${call.query}`);
  });
  const tracker = new LinearTracker({
    client,
    externalRefs: new MemoryExternalRefs(),
    getTeamId: () => 'team-1'
  });

  await tracker.skipIssue('lin-iss-1', 'duplicate of TASK-7');

  const skipCall = client.calls.find((c) => matchMutation(c.query, 'SkipIssue'));
  assert.ok(skipCall);
  const updateInput = skipCall.variables.input as { stateId: string };
  assert.equal(updateInput.stateId, 'state-cancel');

  const commentCall = client.calls.find((c) => matchMutation(c.query, 'SkipReason'));
  assert.ok(commentCall);
  const commentInput = commentCall.variables.input as { issueId: string; body: string };
  assert.equal(commentInput.issueId, 'lin-iss-1');
  assert.equal(commentInput.body, 'duplicate of TASK-7');
});

// ---------------------------------------------------------------------------
// AC #6: client retries up to 3 times with exponential backoff on transient
//        failure, then surfaces the error so the subscriber can publish
//        LinearWriteFailed.
// ---------------------------------------------------------------------------

test('client retries transient HTTP 5xx up to maxAttempts and succeeds on the third try', async () => {
  let calls = 0;
  const responses: Array<Response> = [
    new Response('boom', { status: 503 }),
    new Response('boom', { status: 503 }),
    new Response(JSON.stringify({ data: { ok: true } }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  ];
  const fetchImpl = (async () => {
    return responses[calls++];
  }) as unknown as typeof fetch;

  const sleeps: number[] = [];
  const client = createLinearClient({
    fetchImpl,
    getApiKey: () => 'test-key',
    maxAttempts: 3,
    backoffBaseMs: 10,
    sleep: async (ms) => {
      sleeps.push(ms);
    }
  });

  const result = await client.request<{ ok: boolean }>('query Q { ok }');
  assert.deepEqual(result, { ok: true });
  assert.equal(calls, 3, 'fetch must be invoked 3 times');
  // Exponential backoff: 10 then 20.
  assert.deepEqual(sleeps, [10, 20]);
});

test('client throws after exhausting maxAttempts on persistent transient failure', async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return new Response('still bad', { status: 503 });
  }) as unknown as typeof fetch;

  const client = createLinearClient({
    fetchImpl,
    getApiKey: () => 'test-key',
    maxAttempts: 3,
    backoffBaseMs: 1,
    sleep: async () => undefined
  });

  await assert.rejects(() => client.request('q'), (err: unknown) => {
    return err instanceof LinearApiError && err.status === 503;
  });
  assert.equal(calls, 3);
});

test('client fails fast on HTTP 4xx without consuming the retry budget', async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return new Response('bad request', { status: 400 });
  }) as unknown as typeof fetch;

  const client = createLinearClient({
    fetchImpl,
    getApiKey: () => 'test-key',
    maxAttempts: 3,
    backoffBaseMs: 1,
    sleep: async () => undefined
  });

  await assert.rejects(() => client.request('q'), /HTTP 400/);
  assert.equal(calls, 1);
});

test('client reads LINEAR_API_KEY at call time (not at construction)', async () => {
  let captured: string | undefined;
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    captured = (init.headers as Record<string, string>).Authorization;
    return new Response(JSON.stringify({ data: { ok: true } }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  }) as unknown as typeof fetch;

  let current = 'first-key';
  const client = createLinearClient({
    fetchImpl,
    getApiKey: () => current,
    maxAttempts: 1
  });

  // Rotate the key BETWEEN client construction and the first request.
  current = 'second-key';
  await client.request('q');
  assert.equal(captured, 'second-key');
});

// ---------------------------------------------------------------------------
// Subscriber AC #5: 'linear-tracker' translates lifecycle events
// ---------------------------------------------------------------------------

interface RecordingTracker extends IssueTracker {
  readonly calls: Array<
    | { kind: 'createProject'; spec: unknown; result: ProjectRef }
    | { kind: 'createIssue'; spec: unknown; result: IssueRef }
    | { kind: 'closeIssue'; id: string; summary: string }
    | { kind: 'skipIssue'; id: string; reason: string }
    | { kind: 'postCommentToIssue'; issueId: string; body: string }
  >;
}

function makeRecordingTracker(overrides: Partial<IssueTracker> = {}): RecordingTracker {
  const calls: RecordingTracker['calls'] = [];
  let p = 0;
  let i = 0;
  const tracker: RecordingTracker = {
    calls,
    async createProject(spec) {
      const result: ProjectRef = { id: `lin-proj-${++p}`, name: spec.name };
      calls.push({ kind: 'createProject', spec, result });
      return result;
    },
    async createIssue(spec) {
      const result: IssueRef = { id: `lin-iss-${++i}`, title: spec.title };
      calls.push({ kind: 'createIssue', spec, result });
      return result;
    },
    async closeIssue(id, summary) {
      calls.push({ kind: 'closeIssue', id, summary });
    },
    async skipIssue(id, reason) {
      calls.push({ kind: 'skipIssue', id, reason });
    },
    async postCommentToIssue(issueId, body) {
      calls.push({ kind: 'postCommentToIssue', issueId, body });
    },
    ...overrides
  };
  return tracker;
}

function publishEvent(bus: EventBus, type: string, payload: unknown, key?: string): Promise<StoredEvent> {
  const event: Event = {
    type,
    v: 1,
    occurredAt: 1_700_000_000_000,
    idempotencyKey: key ?? `${type}:${Math.random().toString(36).slice(2)}`,
    payload
  };
  return bus.publish(event);
}

test("subscriber 'linear-tracker' translates all four lifecycle events to adapter calls", async () => {
  const db = freshDb();
  try {
    const bus = new EventBus(new EventStore(db), new FakeLogger());
    const refs = new MemoryExternalRefs();
    const tracker = makeRecordingTracker();

    const unsubscribe = registerLinearSubscriber({
      bus,
      tracker,
      externalRefs: refs,
      clock: () => 1_700_000_000_000
    });

    await publishEvent(bus, LinearEvents.PLAN_APPROVED, {
      planId: 'plan-1',
      name: 'Plan One',
      description: 'desc'
    });
    // Tracker's real createProject writes the plan→linear mapping; the
    // recording tracker doesn't, so populate refs manually to mirror what
    // production would have observed after the create succeeded.
    refs.write('plan-1', tracker.calls[0].kind === 'createProject' ? tracker.calls[0].result.id : '');

    await publishEvent(bus, LinearEvents.TASK_CREATED, {
      taskId: 'task-1',
      planId: 'plan-1',
      type: 'echo',
      title: 'echo task'
    });
    await publishEvent(bus, LinearEvents.TASK_FINISHED, {
      taskId: 'task-1',
      summary: { text: 'shipped', prUrl: 'https://example.invalid/pr/1' }
    });
    await publishEvent(bus, LinearEvents.TASK_SKIPPED, {
      taskId: 'task-1',
      reason: 'no-op'
    });

    unsubscribe();

    const kinds = tracker.calls.map((c) => c.kind);
    assert.deepEqual(kinds, ['createProject', 'createIssue', 'closeIssue', 'skipIssue']);

    const createIssue = tracker.calls[1];
    assert.equal(createIssue.kind, 'createIssue');
    if (createIssue.kind === 'createIssue') {
      const spec = createIssue.spec as { projectId: string; title: string };
      assert.equal(spec.projectId, 'lin-proj-1');
      assert.equal(spec.title, 'echo task');
    }

    const closeCall = tracker.calls[2];
    assert.equal(closeCall.kind, 'closeIssue');
    if (closeCall.kind === 'closeIssue') {
      assert.equal(closeCall.id, 'lin-iss-1');
      assert.ok(closeCall.summary.includes('shipped'));
      assert.ok(closeCall.summary.includes('https://example.invalid/pr/1'));
    }

    const skipCall = tracker.calls[3];
    assert.equal(skipCall.kind, 'skipIssue');
    if (skipCall.kind === 'skipIssue') {
      assert.equal(skipCall.id, 'lin-iss-1');
      assert.equal(skipCall.reason, 'no-op');
    }

    // task-1 must be mapped after TaskCreated handling.
    assert.equal(refs.read('task-1'), 'lin-iss-1');
  } finally {
    db.close();
  }
});

test('subscriber registers under the named offset "linear-tracker" so replay works on restart', async () => {
  const db = freshDb();
  try {
    const bus = new EventBus(new EventStore(db), new FakeLogger());
    const refs = new MemoryExternalRefs();
    const tracker = makeRecordingTracker();

    registerLinearSubscriber({
      bus,
      tracker,
      externalRefs: refs,
      clock: () => 1_700_000_000_000
    });

    const stored = await publishEvent(bus, LinearEvents.PLAN_APPROVED, { planId: 'plan-X', name: 'X' });
    // Offset must advance to the stored event's seq under the named subscriber.
    const row = db
      .prepare('SELECT last_seq FROM subscriber_offsets WHERE subscriber = ?')
      .get(LINEAR_SUBSCRIBER) as { last_seq: number } | undefined;
    assert.ok(row, 'subscriber_offsets row must exist for linear-tracker');
    assert.equal(row.last_seq, stored.seq);
  } finally {
    db.close();
  }
});

test('subscriber publishes LinearWriteFailed when the adapter throws and does not stall the offset', async () => {
  const db = freshDb();
  try {
    const bus = new EventBus(new EventStore(db), new FakeLogger());
    const refs = new MemoryExternalRefs();
    const tracker = makeRecordingTracker({
      async createProject(): Promise<ProjectRef> {
        throw new LinearApiError('Linear HTTP 500: kaboom', { status: 500, transient: true });
      }
    });

    const logger = new FakeLogger();
    registerLinearSubscriber({
      bus,
      tracker,
      externalRefs: refs,
      clock: () => 1_700_000_000_000,
      logger
    });

    const planEvent = await publishEvent(
      bus,
      LinearEvents.PLAN_APPROVED,
      { planId: 'plan-fail', name: 'fail' },
      'plan-approved-fail-1'
    );

    // The store now holds both the source event and the LinearWriteFailed
    // event the subscriber published in response.
    const store = new EventStore(db);
    const events = store.readAfter(0, 50);
    const failed = events.find((e) => e.type === LinearEvents.LINEAR_WRITE_FAILED);
    assert.ok(failed, 'LinearWriteFailed must be published when the adapter throws');
    assert.equal((failed.payload as { sourceEventSeq: number }).sourceEventSeq, planEvent.seq);
    assert.match(String((failed.payload as { error: string }).error), /Linear HTTP 500/);

    // Offset must still advance — we suppressed the throw so the loop
    // doesn't re-fire the same failing event on every replay.
    const offset = store.getSubscriberOffset(LINEAR_SUBSCRIBER);
    assert.ok(offset >= planEvent.seq);

    // Failure also logged.
    assert.ok(logger.entries.some((e) => e.level === 'error' && /write failed/.test(e.message)));
  } finally {
    db.close();
  }
});

test('subscriber skips PlanApproved when a Linear project is already mapped (idempotent on replay)', async () => {
  const db = freshDb();
  try {
    const bus = new EventBus(new EventStore(db), new FakeLogger());
    const refs = new MemoryExternalRefs();
    refs.write('plan-existing', 'lin-proj-existing');
    const tracker = makeRecordingTracker();

    registerLinearSubscriber({
      bus,
      tracker,
      externalRefs: refs,
      clock: () => 1_700_000_000_000
    });

    await publishEvent(bus, LinearEvents.PLAN_APPROVED, { planId: 'plan-existing', name: 'X' });
    assert.equal(tracker.calls.length, 0, 'tracker.createProject must not run twice for the same plan');
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// Track 4 — Status sync surface (readIssueStatus / writeHumanStatus)
// ---------------------------------------------------------------------------

function bootstrapResponse(call: StubCall): unknown | undefined {
  if (call.query.includes('TeamStates')) {
    return {
      team: { states: { nodes: [{ id: 's-bk', name: 'Backlog', type: 'backlog' }] } }
    };
  }
  if (call.query.includes('TeamLabels')) {
    return {
      team: {
        labels: {
          nodes: PIPELINE_LABEL_SEED.map((name, i) => ({ id: `lab-${i}`, name }))
        }
      }
    };
  }
  return undefined;
}

test('readIssueStatus parses labels + workflow state through the core derivation', async () => {
  const client = new StubLinearClient((call) => {
    if (call.query.includes('IssueStatus')) {
      return {
        issue: {
          state: { type: 'started' },
          labels: { nodes: [{ name: 'pipeline:stage:test' }] }
        }
      };
    }
    throw new Error(`unexpected query: ${call.query}`);
  });
  const tracker = new LinearTracker({
    client,
    externalRefs: new MemoryExternalRefs(),
    getTeamId: () => 'team-1'
  });
  const derived = await tracker.readIssueStatus('lin-iss-1');
  assert.ok(derived);
  assert.equal(derived!.status, 'testing');
  assert.equal(derived!.human_status, 'testing');
});

test('readIssueStatus returns null for v1-era cut-list issues (silently ignored)', async () => {
  for (const taskType of ['swagger', 'deploy-nuget', 'bump-package-reference']) {
    const client = new StubLinearClient((call) => {
      if (call.query.includes('IssueStatus')) {
        return {
          issue: {
            state: { type: 'started' },
            labels: { nodes: [{ name: `pipeline:type:${taskType}` }, { name: 'pipeline:stage:dev' }] }
          }
        };
      }
      throw new Error(`unexpected query: ${call.query}`);
    });
    const tracker = new LinearTracker({
      client,
      externalRefs: new MemoryExternalRefs(),
      getTeamId: () => 'team-1'
    });
    const out = await tracker.readIssueStatus('lin-iss-cut');
    assert.equal(out, null, `cut-list type "${taskType}" must yield null`);
  }
});

test('writeHumanStatus(ready_for_action) issues an IssueUpdate adding pipeline:human:ready_for_action by id', async () => {
  let updateInput: Record<string, unknown> | undefined;
  const client = new StubLinearClient((call) => {
    const boot = bootstrapResponse(call);
    if (boot !== undefined) return boot;
    if (call.query.includes('IssueLabelIds')) {
      // Issue starts with two unrelated labels — labelIds payload must keep them.
      return { issue: { labels: { nodes: [{ id: 'pre-1' }, { id: 'pre-2' }] } } };
    }
    if (matchMutation(call.query, 'SetHumanStatus')) {
      updateInput = call.variables.input as Record<string, unknown>;
      return { issueUpdate: { success: true } };
    }
    throw new Error(`unexpected query: ${call.query}`);
  });
  const bootstrap = new LinearStateBootstrap({
    client,
    getTeamId: () => 'team-1'
  });
  const tracker = new LinearTracker({
    client,
    externalRefs: new MemoryExternalRefs(),
    getTeamId: () => 'team-1',
    bootstrap
  });

  await tracker.writeHumanStatus('lin-iss-99', 'ready_for_action');
  assert.ok(updateInput, 'IssueUpdate mutation must have been issued');
  const labelIds = updateInput!.labelIds as ReadonlyArray<string>;
  // Pre-existing labels preserved and the ready_for_action label appended.
  assert.ok(labelIds.includes('pre-1'));
  assert.ok(labelIds.includes('pre-2'));
  const expectedId = `lab-${PIPELINE_LABEL_SEED.indexOf(HUMAN_LABELS.READY_FOR_ACTION)}`;
  assert.ok(
    labelIds.includes(expectedId),
    'ready_for_action label id must be appended'
  );
});

test('writeHumanStatus is a no-op for stage-derived statuses (no Linear call issued)', async () => {
  const client = new StubLinearClient(() => {
    throw new Error('writeHumanStatus must not call Linear for stage-driven statuses');
  });
  const tracker = new LinearTracker({
    client,
    externalRefs: new MemoryExternalRefs(),
    getTeamId: () => 'team-1'
  });
  await tracker.writeHumanStatus('lin-iss-1', 'in_progress');
  assert.equal(client.calls.length, 0);
});

test('writeHumanStatus throws a descriptive error when bootstrap is missing', async () => {
  const tracker = new LinearTracker({
    client: new StubLinearClient(() => ({})),
    externalRefs: new MemoryExternalRefs(),
    getTeamId: () => 'team-1'
    // bootstrap intentionally omitted
  });
  await assert.rejects(
    () => tracker.writeHumanStatus('lin-iss-1', 'ready_for_action'),
    /requires options\.bootstrap/
  );
});

// ---------------------------------------------------------------------------
// Track 4 — blockedByIssueIds pagination (10k complexity budget)
// ---------------------------------------------------------------------------

test('listProjectBlockers paginates issues via pageInfo.endCursor and uses a capped inner connection', async () => {
  const pages = [
    {
      pageInfo: { hasNextPage: true, endCursor: 'cur-1' },
      nodes: [
        { id: 'i1', relations: { nodes: [{ type: 'blocks', relatedIssue: { id: 'i2' } }] } },
        { id: 'i2', relations: { nodes: [] } }
      ]
    },
    {
      pageInfo: { hasNextPage: true, endCursor: 'cur-2' },
      nodes: [
        { id: 'i3', relations: { nodes: [{ type: 'blocks', relatedIssue: { id: 'i4' } }] } }
      ]
    },
    {
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: [
        { id: 'i4', relations: { nodes: [{ type: 'related', relatedIssue: { id: 'i1' } }] } }
      ]
    }
  ];
  let pageIdx = 0;
  const client = new StubLinearClient((call) => {
    if (call.query.includes('Blockers')) {
      const after = (call.variables as { after: string | null }).after;
      // First call has after=null; later calls follow the prior endCursor.
      if (pageIdx === 0) assert.equal(after, null);
      else if (pageIdx === 1) assert.equal(after, 'cur-1');
      else if (pageIdx === 2) assert.equal(after, 'cur-2');
      const page = pages[pageIdx++];
      // Sanity: pageSize/innerCap baked into the query string keeps complexity
      // bounded — they must be present so a future refactor can't accidentally
      // request unbounded connections.
      assert.match(call.query, /issues\(first:\s*\d+/);
      assert.match(call.query, /relations\(first:\s*\d+/);
      return { project: { issues: page } };
    }
    throw new Error(`unexpected query: ${call.query}`);
  });
  const tracker = new LinearTracker({
    client,
    externalRefs: new MemoryExternalRefs(),
    getTeamId: () => 'team-1'
  });
  const edges = await tracker.listProjectBlockers('lin-proj-1');
  // Only `blocks` edges count — the `related` row on i4 is ignored.
  assert.deepEqual(
    edges.map((e) => `${e.blocker}->${e.blocked}`).sort(),
    ['i1->i2', 'i3->i4']
  );
  assert.equal(pageIdx, 3, 'all three pages must be consumed');
});

// ---------------------------------------------------------------------------
// Track 4 — subscriber: TaskParked → writeHumanStatus(ready_for_action)
// ---------------------------------------------------------------------------

function makeStatusSync(): {
  readonly calls: Array<{ id: string; status: string }>;
  readonly sync: import('../../core/ports').IssueStatusSync;
} {
  const calls: Array<{ id: string; status: string }> = [];
  return {
    calls,
    sync: {
      async readIssueStatus() {
        return null;
      },
      async writeHumanStatus(id, status) {
        calls.push({ id, status });
      }
    }
  };
}

test('subscriber flips pipeline:human:ready_for_action on TaskParked regardless of reason', async () => {
  for (const reason of ['clarification', 'wait-action', 'wait-merged'] as const) {
    const db = freshDb();
    try {
      const bus = new EventBus(new EventStore(db), new FakeLogger());
      const refs = new MemoryExternalRefs();
      refs.write('task-parked', 'lin-iss-parked');
      const tracker = makeRecordingTracker();
      const status = makeStatusSync();

      registerLinearSubscriber({
        bus,
        tracker,
        externalRefs: refs,
        clock: () => 1_700_000_000_000,
        statusSync: status.sync
      });

      await publishEvent(bus, LinearEvents.TASK_PARKED, {
        taskId: 'task-parked',
        stepId: 'develop',
        reason
      });

      assert.equal(status.calls.length, 1, `reason=${reason} must trigger one flip`);
      assert.equal(status.calls[0].id, 'lin-iss-parked');
      assert.equal(status.calls[0].status, 'ready_for_action');
    } finally {
      db.close();
    }
  }
});

test('subscriber skips TaskParked when no Linear issue is mapped yet (publishes write-failed)', async () => {
  const db = freshDb();
  try {
    const bus = new EventBus(new EventStore(db), new FakeLogger());
    const refs = new MemoryExternalRefs();
    const tracker = makeRecordingTracker();
    const status = makeStatusSync();

    registerLinearSubscriber({
      bus,
      tracker,
      externalRefs: refs,
      clock: () => 1_700_000_000_000,
      statusSync: status.sync
    });

    await publishEvent(bus, LinearEvents.TASK_PARKED, {
      taskId: 'task-no-mapping',
      reason: 'clarification'
    });

    assert.equal(status.calls.length, 0);
    const store = new EventStore(db);
    const failed = store
      .readAfter(0, 50)
      .find((e) => e.type === LinearEvents.LINEAR_WRITE_FAILED);
    assert.ok(failed, 'an unmapped TaskParked must publish LinearWriteFailed');
  } finally {
    db.close();
  }
});

test('subscriber omits the TaskParked subscription entirely when statusSync is unset', async () => {
  const db = freshDb();
  try {
    const bus = new EventBus(new EventStore(db), new FakeLogger());
    const refs = new MemoryExternalRefs();
    refs.write('task-parked-2', 'lin-iss-2');
    const tracker = makeRecordingTracker();

    registerLinearSubscriber({
      bus,
      tracker,
      externalRefs: refs,
      clock: () => 1_700_000_000_000
      // statusSync intentionally unset.
    });

    await publishEvent(bus, LinearEvents.TASK_PARKED, {
      taskId: 'task-parked-2',
      reason: 'clarification'
    });
    // Nothing should have been recorded — tracker only sees lifecycle events.
    assert.equal(tracker.calls.length, 0);
  } finally {
    db.close();
  }
});
