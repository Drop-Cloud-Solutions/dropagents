import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { openDatabase, applyMigrations, type Db } from '../../core/state/migrations';
import { EventStore } from '../../core/events/store';
import { EventBus } from '../../core/events/bus';
import type { Event, StoredEvent } from '../../core/events/event';
import type { IssueRef, IssueTracker, ProjectRef } from '../../core/ports';
import type { Logger } from '../../core/ports/Logger';

import { Orchestrator } from '../../hosts/orchestrator/main';
import { Commands } from '../../hosts/orchestrator/handlers';
import { PlanLifecycleCommands } from '../../core/commands';

import { createJiraClient, JiraApiError, type JiraClient } from './client';
import { JiraTracker, JIRA_SYSTEM, NotImplementedError } from './JiraTracker';
import {
  JIRA_SHADOW_SUBSCRIBER,
  JiraShadowEvents,
  createFileShadowDiffLog,
  registerJiraShadowSubscriber,
  type JiraExternalRefs,
  type ShadowDiffEntry,
  type ShadowDiffLog
} from './subscriber';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

class SilentLogger implements Logger {
  info(): void {}
  warn(): void {}
  error(): void {}
  debug(): void {}
}

class RecordingLogger implements Logger {
  readonly entries: Array<{ level: string; message: string; meta?: unknown }> = [];
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
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly body: unknown;
}

type StubResponder = (call: StubCall) => unknown | Promise<unknown>;

class StubJiraClient implements JiraClient {
  readonly calls: StubCall[] = [];
  constructor(private readonly responder: StubResponder) {}
  async post<T>(p: string, body: unknown): Promise<T> {
    const call: StubCall = { method: 'POST', path: p, body };
    this.calls.push(call);
    return (await this.responder(call)) as T;
  }
  async get<T>(p: string): Promise<T> {
    const call: StubCall = { method: 'GET', path: p, body: undefined };
    this.calls.push(call);
    return (await this.responder(call)) as T;
  }
}

class MemoryRefs implements JiraExternalRefs {
  readonly rows = new Map<string, string>();
  read(localId: string): string | undefined {
    return this.rows.get(localId);
  }
  write(localId: string, externalId: string): void {
    this.rows.set(localId, externalId);
  }
}

class MemoryShadowDiffLog implements ShadowDiffLog {
  readonly entries: ShadowDiffEntry[] = [];
  write(entry: ShadowDiffEntry): void {
    this.entries.push(entry);
  }
}

function freshDb(): Db {
  const db = openDatabase(':memory:');
  applyMigrations(db);
  return db;
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

// ---------------------------------------------------------------------------
// AC #1: createProject — Jira project create + external_refs row
// ---------------------------------------------------------------------------

test('createProject POSTs to /rest/api/3/project and records the external_refs mapping', async () => {
  const refs = new MemoryRefs();
  const client = new StubJiraClient((call) => {
    if (call.method === 'POST' && call.path === '/rest/api/3/project') {
      return { id: '10001', key: 'PLANLOCAL1', name: 'Plan One' };
    }
    throw new Error(`unexpected call: ${call.method} ${call.path}`);
  });

  const tracker = new JiraTracker({
    client,
    externalRefs: refs,
    projectTemplateKey: 'com.pyxis.greenhopper.jira:gh-scrum-template',
    getProjectLeadAccountId: () => 'lead-acct-xyz'
  });

  const ref = await tracker.createProject({
    name: 'Plan One',
    description: 'desc',
    key: 'plan-local-1'
  });

  assert.deepEqual(ref, { id: '10001', name: 'Plan One' });

  // Single project-create call against the v3 endpoint with the expected fields.
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].method, 'POST');
  assert.equal(client.calls[0].path, '/rest/api/3/project');
  const body = client.calls[0].body as Record<string, unknown>;
  assert.equal(body.name, 'Plan One');
  assert.equal(body.projectTypeKey, 'software');
  assert.equal(body.description, 'desc');
  assert.equal(body.projectTemplateKey, 'com.pyxis.greenhopper.jira:gh-scrum-template');
  assert.equal(body.leadAccountId, 'lead-acct-xyz');
  // Project key normalized: uppercase letter lead, ≤10 chars, alphanumeric/underscore only.
  assert.equal(body.key, 'PLANLOCAL1');

  // local→Jira mapping persisted under system='jira' (recorded via the writer).
  assert.equal(refs.read('plan-local-1'), '10001');
  assert.equal(JIRA_SYSTEM, 'jira');
});

// ---------------------------------------------------------------------------
// AC #1: createIssue — Jira v3 issue create with ADF description
// ---------------------------------------------------------------------------

test('createIssue POSTs to /rest/api/3/issue with project, summary, issuetype and ADF description', async () => {
  const client = new StubJiraClient((call) => {
    if (call.method === 'POST' && call.path === '/rest/api/3/issue') {
      return { id: '20001', key: 'PROJ-1' };
    }
    throw new Error(`unexpected call: ${call.method} ${call.path}`);
  });
  const tracker = new JiraTracker({ client });

  const ref = await tracker.createIssue({
    title: 'echo',
    description: 'a long body',
    projectId: '10001',
    labels: ['pipeline:type:implement']
  });

  assert.deepEqual(ref, { id: '20001', title: 'echo' });
  const body = client.calls[0].body as { fields: Record<string, unknown> };
  assert.deepEqual(body.fields.project, { id: '10001' });
  assert.equal(body.fields.summary, 'echo');
  assert.deepEqual(body.fields.issuetype, { name: 'Task' });
  assert.deepEqual(body.fields.labels, ['pipeline:type:implement']);

  // Description is wrapped in an Atlassian Document Format paragraph — Jira
  // Cloud v3 rejects raw strings.
  const adf = body.fields.description as { type: string; content: Array<{ content: Array<{ text: string }> }> };
  assert.equal(adf.type, 'doc');
  assert.equal(adf.content[0].content[0].text, 'a long body');
});

// ---------------------------------------------------------------------------
// AC #1: closeIssue — pick "Done" transition, transition + comment
// ---------------------------------------------------------------------------

test('closeIssue queries transitions, picks the Done one, and posts a comment with the summary', async () => {
  const client = new StubJiraClient((call) => {
    if (call.method === 'GET' && call.path === '/rest/api/3/issue/20001/transitions') {
      return {
        transitions: [
          { id: '11', name: 'In Progress', to: { name: 'In Progress', statusCategory: { key: 'indeterminate' } } },
          { id: '21', name: 'Done', to: { name: 'Done', statusCategory: { key: 'done' } } }
        ]
      };
    }
    if (call.method === 'POST' && call.path === '/rest/api/3/issue/20001/transitions') {
      return undefined;
    }
    if (call.method === 'POST' && call.path === '/rest/api/3/issue/20001/comment') {
      return { id: 'cmt-1' };
    }
    throw new Error(`unexpected call: ${call.method} ${call.path}`);
  });
  const tracker = new JiraTracker({ client });

  await tracker.closeIssue('20001', 'shipped — PR https://example.invalid/pr/7');

  // Order: GET transitions → POST transition → POST comment
  assert.equal(client.calls.length, 3);
  assert.equal(client.calls[0].method, 'GET');
  assert.equal(client.calls[1].method, 'POST');
  assert.equal(client.calls[1].path, '/rest/api/3/issue/20001/transitions');
  assert.deepEqual(client.calls[1].body, { transition: { id: '21' } });

  const commentBody = client.calls[2].body as { body: { content: Array<{ content: Array<{ text: string }> }> } };
  assert.equal(commentBody.body.content[0].content[0].text, 'shipped — PR https://example.invalid/pr/7');
});

test('closeIssue throws when no Done transition is available so the shadow subscriber catches it', async () => {
  const client = new StubJiraClient((call) => {
    if (call.method === 'GET') {
      return { transitions: [{ id: '11', name: 'In Progress', to: { name: 'In Progress', statusCategory: { key: 'indeterminate' } } }] };
    }
    throw new Error(`unexpected call: ${call.method} ${call.path}`);
  });
  const tracker = new JiraTracker({ client });
  await assert.rejects(() => tracker.closeIssue('20001', 's'), /no transition to a Done state/);
});

// ---------------------------------------------------------------------------
// AC #2: skipIssue throws NotImplementedError — abstraction leak surfaced
// ---------------------------------------------------------------------------

test('skipIssue throws NotImplementedError', async () => {
  const tracker = new JiraTracker({
    client: new StubJiraClient(() => ({}))
  });
  await assert.rejects(
    () => tracker.skipIssue('20001', 'duplicate'),
    (err: unknown) => err instanceof NotImplementedError && err.method === 'skipIssue'
  );
});

test('JiraTracker is assignable to the IssueTracker port and exposes only the four terminal methods', () => {
  const tracker = new JiraTracker({ client: new StubJiraClient(() => ({})) });
  const asPort: IssueTracker = tracker;
  assert.equal(typeof asPort.createProject, 'function');
  assert.equal(typeof asPort.createIssue, 'function');
  assert.equal(typeof asPort.closeIssue, 'function');
  assert.equal(typeof asPort.skipIssue, 'function');
  for (const forbidden of ['setInProgress', 'startIssue', 'updateStatus', 'transition']) {
    assert.equal(
      (tracker as unknown as Record<string, unknown>)[forbidden],
      undefined,
      `JiraTracker must not expose in-flight method "${forbidden}"`
    );
  }
});

// ---------------------------------------------------------------------------
// Client: reads creds at call time + Basic auth header
// ---------------------------------------------------------------------------

test('Jira client sends HTTP Basic auth and reads JIRA_BASE_URL/JIRA_EMAIL/JIRA_API_TOKEN at call time', async () => {
  let captured: { url: string; auth: string | null } | undefined;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    captured = {
      url: String(url),
      auth: (init.headers as Record<string, string>).Authorization ?? null
    };
    return new Response(JSON.stringify({ id: '1', key: 'X' }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  }) as unknown as typeof fetch;

  let baseUrl = 'https://wrong.example.invalid';
  let email = 'wrong@example.invalid';
  let token = 'wrong-token';
  const client = createJiraClient({
    fetchImpl,
    getBaseUrl: () => baseUrl,
    getEmail: () => email,
    getApiToken: () => token
  });

  // Rotate the creds AFTER construction to prove call-time resolution.
  baseUrl = 'https://right.example.invalid';
  email = 'me@example.invalid';
  token = 'right-token';

  await client.post('/rest/api/3/project', { name: 'X' });
  assert.ok(captured);
  const c = captured as { url: string; auth: string | null };
  assert.equal(c.url, 'https://right.example.invalid/rest/api/3/project');
  const expected = 'Basic ' + Buffer.from('me@example.invalid:right-token').toString('base64');
  assert.equal(c.auth, expected);
});

test('Jira client throws JiraApiError with status on 4xx', async () => {
  const fetchImpl = (async () => new Response('nope', { status: 403 })) as unknown as typeof fetch;
  const client = createJiraClient({
    fetchImpl,
    getBaseUrl: () => 'https://x.example.invalid',
    getEmail: () => 'e',
    getApiToken: () => 't'
  });
  await assert.rejects(
    () => client.get('/rest/api/3/project/10001/transitions'),
    (err: unknown) => err instanceof JiraApiError && err.status === 403
  );
});

// ---------------------------------------------------------------------------
// AC #3 + #4: shadow subscriber — never blocks; failures land in diff log
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
      const result: ProjectRef = { id: `jira-proj-${++p}`, name: spec.name };
      calls.push({ kind: 'createProject', spec, result });
      return result;
    },
    async createIssue(spec) {
      const result: IssueRef = { id: `jira-iss-${++i}`, title: spec.title };
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

test('jira-shadow subscriber translates the four lifecycle events to Jira tracker calls', async () => {
  const db = freshDb();
  try {
    const bus = new EventBus(new EventStore(db), new SilentLogger());
    const refs = new MemoryRefs();
    const tracker = makeRecordingTracker();
    const diff = new MemoryShadowDiffLog();

    registerJiraShadowSubscriber({
      bus,
      tracker,
      externalRefs: refs,
      shadowDiffLog: diff,
      clock: () => 1_700_000_000_000
    });

    await publishEvent(bus, JiraShadowEvents.PLAN_APPROVED, { planId: 'plan-1', name: 'Plan One' });
    await publishEvent(bus, JiraShadowEvents.TASK_CREATED, {
      taskId: 'task-1',
      planId: 'plan-1',
      title: 'echo task'
    });
    await publishEvent(bus, JiraShadowEvents.TASK_FINISHED, {
      taskId: 'task-1',
      summary: { text: 'shipped', prUrl: 'https://example.invalid/pr/1' }
    });

    const kinds = tracker.calls.map((c) => c.kind);
    assert.deepEqual(kinds, ['createProject', 'createIssue', 'closeIssue']);
    assert.equal(refs.read('plan-1'), 'jira-proj-1');
    assert.equal(refs.read('task-1'), 'jira-iss-1');

    const closeCall = tracker.calls[2];
    assert.equal(closeCall.kind, 'closeIssue');
    if (closeCall.kind === 'closeIssue') {
      assert.equal(closeCall.id, 'jira-iss-1');
      assert.ok(closeCall.summary.includes('shipped'));
      assert.ok(closeCall.summary.includes('https://example.invalid/pr/1'));
    }

    // Happy path leaves the diff log empty.
    assert.equal(diff.entries.length, 0);
  } finally {
    db.close();
  }
});

test('shadow failures are caught, written to the diff log, and do not propagate (offset still advances)', async () => {
  const db = freshDb();
  try {
    const bus = new EventBus(new EventStore(db), new SilentLogger());
    const refs = new MemoryRefs();
    const diff = new MemoryShadowDiffLog();

    const tracker = makeRecordingTracker({
      async createProject(): Promise<ProjectRef> {
        throw new JiraApiError('Jira HTTP 500: kaboom', 500);
      }
    });

    const logger = new RecordingLogger();
    registerJiraShadowSubscriber({
      bus,
      tracker,
      externalRefs: refs,
      shadowDiffLog: diff,
      clock: () => 1_700_000_000_001,
      logger
    });

    // A throwing handler must NOT cause publish to reject. If publish were
    // to throw, the event store could end up out of sync with downstream
    // bookkeeping — and more importantly the AC says shadow failures must
    // never block the event chain.
    const stored = await publishEvent(
      bus,
      JiraShadowEvents.PLAN_APPROVED,
      { planId: 'plan-fail', name: 'fail' },
      'plan-approved-jira-fail-1'
    );

    // Diff log captured the failure with the source event's seq + the error.
    assert.equal(diff.entries.length, 1);
    assert.equal(diff.entries[0].sourceEventSeq, stored.seq);
    assert.equal(diff.entries[0].operation, 'createProject');
    assert.equal(diff.entries[0].localId, 'plan-fail');
    assert.match(diff.entries[0].error, /Jira HTTP 500/);

    // Critically: NO "JiraWriteFailed"-style event was published. Linear
    // remains authoritative; a Jira outage does not show up on the bus.
    const events = new EventStore(db).readAfter(0, 50);
    const failureEvents = events.filter((e) => /Failed/i.test(e.type) && e.type !== 'PlanApproved');
    assert.deepEqual(failureEvents, [], 'shadow subscriber must NOT publish failure events');

    // Subscriber offset advances despite the swallowed throw, otherwise
    // restart would replay the same failing event indefinitely.
    const offset = new EventStore(db).getSubscriberOffset(JIRA_SHADOW_SUBSCRIBER);
    assert.ok(offset >= stored.seq);

    // And it was logged as a warn (not an error — Linear is authoritative).
    assert.ok(logger.entries.some((e) => e.level === 'warn' && /jira-shadow/.test(e.message)));
  } finally {
    db.close();
  }
});

test('TaskSkipped routes through the subscriber, skipIssue throws NotImplemented, diff log captures it', async () => {
  const db = freshDb();
  try {
    const bus = new EventBus(new EventStore(db), new SilentLogger());
    const refs = new MemoryRefs();
    refs.write('task-skip', 'jira-iss-skip');  // pre-resolve so the handler reaches skipIssue.
    const diff = new MemoryShadowDiffLog();

    // Use the real JiraTracker — its skipIssue actually throws.
    const tracker = new JiraTracker({ client: new StubJiraClient(() => ({})) });

    registerJiraShadowSubscriber({
      bus,
      tracker,
      externalRefs: refs,
      shadowDiffLog: diff,
      clock: () => 1_700_000_000_002
    });

    const stored = await publishEvent(
      bus,
      JiraShadowEvents.TASK_SKIPPED,
      { taskId: 'task-skip', reason: 'dup' },
      'task-skipped-1'
    );

    assert.equal(diff.entries.length, 1);
    assert.equal(diff.entries[0].operation, 'skipIssue');
    assert.equal(diff.entries[0].sourceEventSeq, stored.seq);
    assert.match(diff.entries[0].error, /not implemented/);
  } finally {
    db.close();
  }
});

test('jira-shadow subscriber runs AFTER linear-tracker (Node EventEmitter dispatches in registration order)', async () => {
  const db = freshDb();
  try {
    const bus = new EventBus(new EventStore(db), new SilentLogger());
    const order: string[] = [];

    // Stand-in for `linear-tracker` — registered FIRST.
    bus.subscribe(
      JiraShadowEvents.PLAN_APPROVED,
      async () => {
        order.push('linear-tracker');
      },
      { subscriber: 'linear-tracker' }
    );

    // jira-shadow registered SECOND — so it must run after.
    registerJiraShadowSubscriber({
      bus,
      tracker: makeRecordingTracker({
        async createProject(spec) {
          order.push('jira-shadow');
          return { id: 'j1', name: spec.name };
        }
      }),
      externalRefs: new MemoryRefs(),
      shadowDiffLog: new MemoryShadowDiffLog(),
      clock: () => 1_700_000_000_003
    });

    await publishEvent(bus, JiraShadowEvents.PLAN_APPROVED, { planId: 'plan-order', name: 'X' });
    assert.deepEqual(order, ['linear-tracker', 'jira-shadow']);
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// AC #4 (file path): default shadow-diff log writes to the documented path
// ---------------------------------------------------------------------------

test('createFileShadowDiffLog appends one JSON object per line, creating the parent dir on first write', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jira-shadow-diff-'));
  try {
    const filePath = path.join(tmpDir, 'nested', '.cache', 'jira-shadow-diff.log');
    const sink = createFileShadowDiffLog(filePath);
    sink.write({
      at: 1,
      sourceEventType: 'PlanApproved',
      sourceEventSeq: 7,
      operation: 'createProject',
      localId: 'plan-x',
      error: 'boom'
    });
    sink.write({
      at: 2,
      sourceEventType: 'TaskCreated',
      sourceEventSeq: 8,
      operation: 'createIssue',
      localId: 'task-x',
      error: 'boom2'
    });
    const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    const first = JSON.parse(lines[0]) as ShadowDiffEntry;
    assert.equal(first.operation, 'createProject');
    assert.equal(first.localId, 'plan-x');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AC #5: Feature flag — orchestrator wires subscriber only when flag === 'jira'
// ---------------------------------------------------------------------------

function writePipelineYaml(dir: string, contents: string): string {
  const file = path.join(dir, 'pipeline.yaml');
  fs.writeFileSync(file, contents, 'utf8');
  return file;
}

test('orchestrator does NOT register jira-shadow when issue_tracker_shadow is "none"', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jira-shadow-flag-off-'));
  try {
    const cfg = writePipelineYaml(
      tmpDir,
      [
        'issue_tracker: linear',
        'agent_runner: claude-cli',
        'source_control: git-cli',
        'chat_gateway: telegram',
        'issue_tracker_shadow: none',
        'default_models: { developer: claude-opus-4-7 }',
        'default_flows: { echo: echo.yaml }',
        'worktree_root: .pipeline-workspace/v2'
      ].join('\n')
    );
    const orch = new Orchestrator({
      dbPath: ':memory:',
      flowsDir: path.resolve(__dirname, '..', '..', 'config', 'flows'),
      logger: new SilentLogger(),
      pipelineConfigPath: cfg,
      idGen: (() => {
        let n = 0;
        return { newId: (): string => `task-${++n}` };
      })()
    });
    await orch.start();
    try {
      // Plan gate (AP-IFW-003): GeneratePlan precedes ApprovePlan.
      await orch.getCommandBus().send({
        type: PlanLifecycleCommands.GENERATE_PLAN,
        actor: 'test',
        issuedAt: 1_700_000_000_000,
        payload: { planId: 'plan-off', projectId: 'proj-off', revision: 1 }
      });
      await orch.getCommandBus().send({
        type: Commands.APPROVE_PLAN,
        actor: 'test',
        issuedAt: 1_700_000_000_000,
        payload: { planId: 'plan-off' }
      });
      await orch.flush();

      const row = orch
        .getDb()
        .prepare('SELECT last_seq FROM subscriber_offsets WHERE subscriber = ?')
        .get(JIRA_SHADOW_SUBSCRIBER) as { last_seq: number } | undefined;
      assert.equal(row, undefined, 'jira-shadow subscriber must not be registered when flag is "none"');
    } finally {
      await orch.stop();
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('orchestrator wires jira-shadow when issue_tracker_shadow: jira and routes lifecycle events to the injected tracker', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jira-shadow-flag-on-'));
  try {
    const cfg = writePipelineYaml(
      tmpDir,
      [
        'issue_tracker: linear',
        'agent_runner: claude-cli',
        'source_control: git-cli',
        'chat_gateway: telegram',
        'issue_tracker_shadow: jira',
        'default_models: { developer: claude-opus-4-7 }',
        'default_flows: { echo: echo.yaml }',
        'worktree_root: .pipeline-workspace/v2'
      ].join('\n')
    );
    const tracker = makeRecordingTracker();
    const diff = new MemoryShadowDiffLog();

    const orch = new Orchestrator({
      dbPath: ':memory:',
      flowsDir: path.resolve(__dirname, '..', '..', 'config', 'flows'),
      logger: new SilentLogger(),
      pipelineConfigPath: cfg,
      idGen: (() => {
        let n = 0;
        return { newId: (): string => `task-${++n}` };
      })(),
      adapters: {
        jiraIssueTracker: tracker,
        jiraShadowDiffLog: diff
      }
    });
    await orch.start();
    try {
      // Plan gate (AP-IFW-003): GeneratePlan precedes ApprovePlan.
      await orch.getCommandBus().send({
        type: PlanLifecycleCommands.GENERATE_PLAN,
        actor: 'test',
        issuedAt: 1_700_000_000_000,
        payload: { planId: 'plan-on', projectId: 'proj-on', revision: 1 }
      });
      await orch.getCommandBus().send({
        type: Commands.APPROVE_PLAN,
        actor: 'test',
        issuedAt: 1_700_000_000_000,
        payload: { planId: 'plan-on', projectId: 'proj-on' }
      });
      await orch.flush();

      // Subscriber offset row was created — proves registration happened.
      const row = orch
        .getDb()
        .prepare('SELECT last_seq FROM subscriber_offsets WHERE subscriber = ?')
        .get(JIRA_SHADOW_SUBSCRIBER) as { last_seq: number } | undefined;
      assert.ok(row, 'jira-shadow subscriber must be registered when flag is "jira"');
      assert.ok((row as { last_seq: number }).last_seq > 0);

      // Tracker received createProject (from PlanApproved) and createIssue
      // (from TaskCreated). The fake AgentRunner emits the rest of the
      // lifecycle (TaskFinished) too, depending on the default flow — at
      // minimum we expect the project + issue creates.
      const kinds = tracker.calls.map((c) => c.kind);
      assert.ok(kinds.includes('createProject'), 'createProject must have run');
      assert.ok(kinds.includes('createIssue'), 'createIssue must have run');

      // external_refs was populated under system='jira'.
      const refRow = orch
        .getDb()
        .prepare(`SELECT external_id FROM external_refs WHERE local_id = ? AND system = 'jira'`)
        .get('plan-on') as { external_id: string } | undefined;
      assert.ok(refRow, 'jira external_ref row for plan-on must exist');
    } finally {
      await orch.stop();
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
