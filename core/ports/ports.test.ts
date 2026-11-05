/**
 * tsd-style compile checks for the seven port interfaces.
 *
 * These tests have two layers:
 *
 *   1. **Type-level (load-bearing).** Each `const sample: PortType = { ... }`
 *      asserts that the literal shape satisfies the interface. If a port's
 *      surface changes incompatibly, `tsc --noEmit` fails on this file
 *      regardless of whether the runtime test passes.
 *
 *   2. **Runtime (sanity).** The `node:test` cases just confirm the sample
 *      objects expose the methods they claim. The transpile loader (tsx)
 *      does not type-check at test time, so the type guarantees come from
 *      `npm run typecheck`, not from `npm test`.
 *
 * The IssueTracker case additionally has a *negative* type assertion:
 * the interface MUST NOT carry any of the in-flight status-mutation
 * method names. That's the structural guarantee called out in TASK.md.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type {
  IssueTracker,
  ChatGateway,
  InboundMessage,
  ClarificationReplyCorrelator,
  AgentRunner,
  AgentHandle,
  AgentSpec,
  SourceControl,
  Clock,
  IdGen,
  Logger,
  ConfigStore,
  ConfigRow,
  ConfigRowKind,
  ConfigStoreOptions,
  ConfigStoreBackendKind,
} from './index';
import {
  ConcurrencyError,
  DEFAULT_OVERFLOW_THRESHOLD_BYTES,
  DEFAULT_OVERFLOW_CONTAINER_NAME,
} from './index';

// ---------------------------------------------------------------------------
// Compile-time helpers: a tiny `Expect<true>` so wrong type-level conditions
// become red squiggles instead of silent test passes.
// ---------------------------------------------------------------------------

type Expect<T extends true> = T;
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;

// ---------------------------------------------------------------------------
// IssueTracker — terminal operations only.
// ---------------------------------------------------------------------------

const issueTrackerSample: IssueTracker = {
  async createProject(p) {
    return { id: 'proj-1', name: p.name };
  },
  async createIssue(i) {
    return { id: 'issue-1', title: i.title };
  },
  async closeIssue(_id, _summary) {
    /* terminal */
  },
  async skipIssue(_id, _reason) {
    /* terminal */
  },
  async postCommentToIssue(_issueId, _body) {
    /* terminal */
  },
};

// Negative assertion: none of these method names may appear on the
// IssueTracker interface. If anyone adds `setInProgress` / `updateStatus`
// / etc. to the port, this type-level check fails to compile.
type ForbiddenIssueTrackerKeys =
  | 'setInProgress'
  | 'updateStatus'
  | 'setStatus'
  | 'markInProgress'
  | 'moveToColumn'
  | 'setLabels'
  | 'transition';

type _IssueTrackerHasNoForbiddenKeys = Expect<
  Equals<Extract<keyof IssueTracker, ForbiddenIssueTrackerKeys>, never>
>;

// Positive assertion: the interface has exactly the terminal lifecycle
// methods plus the postCommentToIssue side-channel. `postCommentToIssue`
// does not drive a state transition; it's a write-only comment surface
// the caller drives explicitly. Keeping it in this list rather than
// renaming the test makes the boundary explicit.
type _IssueTrackerKeysAreTerminalOnly = Expect<
  Equals<
    keyof IssueTracker,
    'createProject' | 'createIssue' | 'closeIssue' | 'skipIssue' | 'postCommentToIssue'
  >
>;

test('IssueTracker exposes the four terminal operations only', () => {
  assert.equal(typeof issueTrackerSample.createProject, 'function');
  assert.equal(typeof issueTrackerSample.createIssue, 'function');
  assert.equal(typeof issueTrackerSample.closeIssue, 'function');
  assert.equal(typeof issueTrackerSample.skipIssue, 'function');
  assert.equal(typeof issueTrackerSample.postCommentToIssue, 'function');

  // Runtime mirror of the type-level negative assertion. Even though the
  // interface forbids them, a non-conforming adapter could in principle
  // attach extra methods; this guards against that drift at the sample
  // level for documentation purposes.
  for (const forbidden of [
    'setInProgress',
    'updateStatus',
    'setStatus',
    'markInProgress',
    'moveToColumn',
    'setLabels',
    'transition',
  ]) {
    assert.equal(
      (issueTrackerSample as unknown as Record<string, unknown>)[forbidden],
      undefined,
      `IssueTracker must not expose ${forbidden}`,
    );
  }
});

// ---------------------------------------------------------------------------
// ChatGateway — outbound notify; inbound modeled by sibling types.
// ---------------------------------------------------------------------------

const chatGatewaySample: ChatGateway = {
  async notify(_channel, _message) {
    /* outbound */
  },
};

// `ChatGateway` itself is still notify-only. Inbound is modeled by the
// sibling InboundMessage / ClarificationReplyCorrelator types — the adapter
// pushes inbound traffic into the command bus directly, the orchestrator
// does not poll the port.
type _ChatGatewayIsNotifyOnly = Expect<Equals<keyof ChatGateway, 'notify'>>;

const inboundMessageSample: InboundMessage = {
  messageId: 100,
  chatId: 42,
  senderId: 42,
  text: 'hello',
  replyToMessageId: 99,
};

const correlatorSample: ClarificationReplyCorrelator = {
  recordQuestion(_taskId, _chatId, _messageId) {},
  lookupByQuestionMessageId(_chatId, _messageId) {
    return undefined;
  },
  clearForTask(_taskId) {},
};

test('ChatGateway exposes only outbound notify', () => {
  assert.equal(typeof chatGatewaySample.notify, 'function');
});

test('InboundMessage and ClarificationReplyCorrelator are loadable', () => {
  assert.equal(inboundMessageSample.text, 'hello');
  assert.equal(typeof correlatorSample.recordQuestion, 'function');
  assert.equal(typeof correlatorSample.lookupByQuestionMessageId, 'function');
  assert.equal(typeof correlatorSample.clearForTask, 'function');
});

// ---------------------------------------------------------------------------
// AgentRunner — start is sync-return, interrupt is async.
// ---------------------------------------------------------------------------

const agentRunnerSample: AgentRunner = {
  start(spec): AgentHandle {
    return { id: 'agent-1', spec };
  },
  async interrupt(_handle) {
    /* async cleanup */
  },
};

// start(spec) must return AgentHandle synchronously (not Promise<AgentHandle>).
type _AgentRunnerStartIsSync = Expect<
  Equals<ReturnType<AgentRunner['start']>, AgentHandle>
>;

// interrupt must return a Promise.
type _AgentRunnerInterruptIsAsync = Expect<
  Equals<ReturnType<AgentRunner['interrupt']>, Promise<void>>
>;

test('AgentRunner.start returns AgentHandle synchronously; interrupt is async', () => {
  const spec: AgentSpec = { role: 'developer', prompt: 'do work' };
  const handle = agentRunnerSample.start(spec);

  // Synchronous return: handle is a plain object, not a Promise.
  assert.equal(typeof handle, 'object');
  assert.notEqual(handle, null);
  assert.notEqual(typeof (handle as unknown as Promise<unknown>).then, 'function');
  assert.equal(handle.id, 'agent-1');
  assert.equal(handle.spec, spec);

  // interrupt returns a thenable.
  const interrupted = agentRunnerSample.interrupt(handle);
  assert.equal(typeof interrupted.then, 'function');
});

// ---------------------------------------------------------------------------
// SourceControl — branch / commit / openPR / getDiff.
// ---------------------------------------------------------------------------

const sourceControlSample: SourceControl = {
  async createBranch(_name, _from) {
    /* noop */
  },
  async commit(spec) {
    return { sha: `sha-of-${spec.message.length}` };
  },
  async openPullRequest(spec) {
    return { id: 'pr-1', number: 1, url: `https://example.invalid/${spec.head}` };
  },
  async getDiff(_options) {
    return '';
  },
};

type _SourceControlKeys = Expect<
  Equals<keyof SourceControl, 'createBranch' | 'commit' | 'openPullRequest' | 'getDiff'>
>;

test('SourceControl exposes createBranch, commit, openPullRequest, getDiff', () => {
  assert.equal(typeof sourceControlSample.createBranch, 'function');
  assert.equal(typeof sourceControlSample.commit, 'function');
  assert.equal(typeof sourceControlSample.openPullRequest, 'function');
  assert.equal(typeof sourceControlSample.getDiff, 'function');
});

// ---------------------------------------------------------------------------
// Clock, IdGen, Logger — minimal surfaces.
// ---------------------------------------------------------------------------

const clockSample: Clock = {
  now() {
    return new Date(0);
  },
};

type _ClockIsNowOnly = Expect<Equals<keyof Clock, 'now'>>;

test('Clock exposes only now()', () => {
  assert.ok(clockSample.now() instanceof Date);
});

const idGenSample: IdGen = {
  newId() {
    return 'id-1';
  },
};

type _IdGenIsNewIdOnly = Expect<Equals<keyof IdGen, 'newId'>>;

test('IdGen exposes only newId()', () => {
  assert.equal(typeof idGenSample.newId(), 'string');
});

const loggerSample: Logger = {
  info(_message, _meta) {
    /* noop */
  },
  warn(_message, _meta) {
    /* noop */
  },
  error(_message, _meta) {
    /* noop */
  },
  debug(_message, _meta) {
    /* noop */
  },
};

type _LoggerKeysAreFourLevels = Expect<
  Equals<keyof Logger, 'info' | 'warn' | 'error' | 'debug'>
>;

test('Logger exposes info/warn/error/debug', () => {
  assert.equal(typeof loggerSample.info, 'function');
  assert.equal(typeof loggerSample.warn, 'function');
  assert.equal(typeof loggerSample.error, 'function');
  assert.equal(typeof loggerSample.debug, 'function');
});

// ---------------------------------------------------------------------------
// ConfigStore — async get/upsert/delete/list keyed by closed ConfigRowKind,
// with an opaque ETag for optimistic concurrency.
// ---------------------------------------------------------------------------

const configRowSample: ConfigRow = {
  kind: 'AgentPrompts',
  rowKey: 'developer/system',
  body: '{}',
  metadata: { schema: 'v1' },
  etag: 'W/"0x0"',
  updatedAt: new Date(0),
};

const configStoreSample: ConfigStore = {
  async get(_kind, _rowKey, _signal) {
    return configRowSample;
  },
  async upsert(spec, _signal) {
    return { ...configRowSample, kind: spec.kind, rowKey: spec.rowKey, body: spec.body };
  },
  async delete(_kind, _rowKey, _etag, _signal) {
    /* noop */
  },
  async *list(_kind, _signal) {
    yield configRowSample;
  },
};

type _ConfigStoreKeys = Expect<
  Equals<keyof ConfigStore, 'get' | 'upsert' | 'delete' | 'list'>
>;

// Closed union: the five documented kinds, nothing more.
type _ConfigRowKindIsClosed = Expect<
  Equals<
    ConfigRowKind,
    'AgentPrompts' | 'Workflows' | 'AgentModels' | 'ProjectConfig' | 'Settings'
  >
>;

// Backend kind is the three documented values.
type _ConfigStoreBackendKindIsClosed = Expect<
  Equals<ConfigStoreBackendKind, 'fs' | 'dual' | 'azure'>
>;

test('ConfigStore exposes get/upsert/delete/list', () => {
  assert.equal(typeof configStoreSample.get, 'function');
  assert.equal(typeof configStoreSample.upsert, 'function');
  assert.equal(typeof configStoreSample.delete, 'function');
  assert.equal(typeof configStoreSample.list, 'function');
});

test('ConfigStore.list returns an async iterable', async () => {
  const rows: ConfigRow[] = [];
  for await (const row of configStoreSample.list('AgentPrompts')) {
    rows.push(row);
  }
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'AgentPrompts');
});

test('ConcurrencyError carries the conflicting etag', () => {
  const err = new ConcurrencyError('etag mismatch', 'W/"0x1"');
  assert.ok(err instanceof Error);
  assert.equal(err.name, 'ConcurrencyError');
  assert.equal(err.conflictingEtag, 'W/"0x1"');
});

// ConfigStoreOptions: tenant + backendKind required, the rest optional.
const configStoreOptionsSample: ConfigStoreOptions = {
  tenant: 'acme',
  backendKind: 'fs',
};

const configStoreOptionsAzureSample: ConfigStoreOptions = {
  tenant: 'acme',
  backendKind: 'azure',
  azureStorageAccountUrl: 'https://example.invalid',
  overflowThresholdBytes: 30720,
  overflowContainerName: 'pipeline-store-overflow',
};

test('ConfigStoreOptions accepts minimal and fully-populated shapes', () => {
  assert.equal(configStoreOptionsSample.tenant, 'acme');
  assert.equal(configStoreOptionsSample.backendKind, 'fs');
  assert.equal(configStoreOptionsAzureSample.backendKind, 'azure');
  assert.equal(
    configStoreOptionsAzureSample.overflowContainerName,
    'pipeline-store-overflow',
  );
});

test('ConfigStore overflow defaults match the documented constants', () => {
  assert.equal(DEFAULT_OVERFLOW_THRESHOLD_BYTES, 30720);
  assert.equal(DEFAULT_OVERFLOW_CONTAINER_NAME, 'pipeline-store-overflow');
});
