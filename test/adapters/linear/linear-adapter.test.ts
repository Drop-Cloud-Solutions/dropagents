/**
 * Unit tests for the AP-VP6 Linear adapter (`adapters/linear/linear-adapter.ts`).
 *
 * Dual-runner discovery: the repo's `npm test` invokes node:test (see
 * `package.json#scripts.test`); the review pipeline runs `npx vitest run`
 * against changed files. The shim below resolves the correct `test()`
 * registration function at module load so both runners discover this
 * suite from a single source file — without ever statically importing
 * from `vitest`, which would crash under `node --test`.
 *
 * Coverage targets the four AP-VP6-009 acceptance criteria:
 *
 *   1. createIssue posts a GraphQL `issueCreate` mutation with the
 *      configured `teamId` and stamps a `task:<id>` label so subsequent
 *      lookups can resolve back.
 *   2. updateStatusLabel removes every prior `pipeline:human:*` label
 *      BEFORE adding the new one (single human_status visible at a time).
 *   3. comment posts a GraphQL mutation that creates a comment on the
 *      issue (operation name `IssueCommentCreate`, field `commentCreate`).
 *   4. getIssueByTaskId resolves to `null` — never throws — when no
 *      matching issue exists.
 *
 * All tests run against an injected fake `fetch`; no live Linear calls.
 */
import assert from 'node:assert/strict';

import { LinearAdapter } from '../../../adapters/linear/linear-adapter';

// ---------------------------------------------------------------------------
// Dual-runner test() shim
// ---------------------------------------------------------------------------

type TestFn = (name: string, fn: () => void | Promise<void>) => void;

const test: TestFn = ((): TestFn => {
  if (process.env.VITEST) {
    const gt = (globalThis as { test?: TestFn }).test;
    if (typeof gt !== 'function') {
      throw new Error(
        'linear-adapter.test.ts: VITEST=true but globalThis.test is missing — '
          + 'ensure vitest.config.ts sets test.globals = true',
      );
    }
    return gt;
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
  const nt = require('node:test') as { test: TestFn };
  return nt.test;
})();

// ---------------------------------------------------------------------------
// Fake fetch
// ---------------------------------------------------------------------------

interface FetchCall {
  readonly url: string;
  readonly query: string;
  readonly variables: Readonly<Record<string, unknown>>;
  readonly authorization: string | undefined;
}

type Responder = (call: FetchCall) => unknown;

function makeFakeFetch(responder: Responder): {
  fetch: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const fetchImpl: typeof fetch = (async (input: unknown, init: unknown) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : String(input);
    const reqInit = (init ?? {}) as { body?: string; headers?: Record<string, string> };
    const body = JSON.parse(reqInit.body ?? '{}') as {
      query: string;
      variables?: Record<string, unknown>;
    };
    const headers = reqInit.headers ?? {};
    const call: FetchCall = {
      url,
      query: body.query,
      variables: body.variables ?? {},
      authorization: headers.Authorization ?? headers.authorization,
    };
    calls.push(call);
    const data = responder(call);
    return new Response(JSON.stringify({ data }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, calls };
}

function matchOp(query: string, name: string): boolean {
  // Match the GraphQL operation declaration (`mutation Foo(...)` or
  // `query Foo(...)`) without depending on exact whitespace.
  return new RegExp(`(?:mutation|query)\\s+${name}\\b`).test(query);
}

function matchField(query: string, name: string): boolean {
  return new RegExp(`\\b${name}\\s*\\(`).test(query);
}

// ---------------------------------------------------------------------------
// AC #1: createIssue posts issueCreate, stamps a task:<id> label
// ---------------------------------------------------------------------------

test('createIssue posts issueCreate with teamId and a task:<id> label', async () => {
  const { fetch, calls } = makeFakeFetch((call) => {
    if (matchOp(call.query, 'FindIssueLabel')) {
      // task:<id> label does not yet exist on the team
      return { issueLabels: { nodes: [] } };
    }
    if (matchOp(call.query, 'IssueLabelCreate')) {
      return {
        issueLabelCreate: {
          success: true,
          issueLabel: { id: 'label-task-T1', name: 'task:T1' },
        },
      };
    }
    if (matchOp(call.query, 'IssueCreate')) {
      return {
        issueCreate: { success: true, issue: { id: 'issue-1', title: 'Echo' } },
      };
    }
    throw new Error(`unexpected query: ${call.query}`);
  });

  const adapter = new LinearAdapter({
    apiKey: 'lin_api_secret',
    teamId: 'team-abc',
    fetch,
  });

  const ref = await adapter.createIssue({
    taskId: 'T1',
    title: 'Echo',
    description: 'desc',
  });

  assert.deepEqual(ref, { id: 'issue-1', title: 'Echo' });

  // Linear accepts the raw key — no "Bearer " prefix.
  for (const c of calls) {
    assert.equal(c.authorization, 'lin_api_secret');
    assert.equal(c.url, 'https://api.linear.app/graphql');
  }

  // Issue created under the configured team, carrying the task label.
  const issueCreate = calls.find((c) => matchOp(c.query, 'IssueCreate'));
  assert.ok(issueCreate, 'expected an IssueCreate call');
  const input = (issueCreate!.variables as { input: Record<string, unknown> }).input;
  assert.equal(input.teamId, 'team-abc');
  assert.equal(input.title, 'Echo');
  assert.equal(input.description, 'desc');
  assert.deepEqual(input.labelIds, ['label-task-T1']);
});

// ---------------------------------------------------------------------------
// AC #3: updateStatusLabel removes any prior pipeline:human:* label first
// ---------------------------------------------------------------------------

test('updateStatusLabel removes prior pipeline:human:* labels before adding the new one', async () => {
  const events: string[] = [];
  const { fetch } = makeFakeFetch((call) => {
    if (matchOp(call.query, 'FindIssueLabel')) {
      const name = (call.variables as { name: string }).name;
      // target label already exists; no create needed
      if (name === 'pipeline:human:ready_to_merge') {
        events.push(`find:${name}`);
        return {
          issueLabels: {
            nodes: [{ id: 'label-target', name }],
          },
        };
      }
      return { issueLabels: { nodes: [] } };
    }
    if (matchOp(call.query, 'IssueLabels')) {
      events.push('fetch-labels');
      return {
        issue: {
          labels: {
            nodes: [
              { id: 'label-prior', name: 'pipeline:human:approved' },
              { id: 'label-unrelated', name: 'kind:bug' },
            ],
          },
        },
      };
    }
    if (matchOp(call.query, 'IssueRemoveLabel')) {
      const v = call.variables as { id: string; labelId: string };
      events.push(`remove:${v.labelId}`);
      return { issueRemoveLabel: { success: true } };
    }
    if (matchOp(call.query, 'IssueAddLabel')) {
      const v = call.variables as { id: string; labelId: string };
      events.push(`add:${v.labelId}`);
      return { issueAddLabel: { success: true } };
    }
    throw new Error(`unexpected query: ${call.query}`);
  });

  const adapter = new LinearAdapter({
    apiKey: 'k',
    teamId: 'team-abc',
    fetch,
  });

  await adapter.updateStatusLabel(
    { id: 'issue-1', title: 'Echo' },
    'ready_to_merge',
  );

  // Order matters: the prior pipeline:human:* label must be removed BEFORE
  // the target is added, so a single human_status is visible on the issue
  // at any instant.
  assert.deepEqual(events, [
    'find:pipeline:human:ready_to_merge',
    'fetch-labels',
    'remove:label-prior',
    'add:label-target',
  ]);
});

test('updateStatusLabel leaves non-pipeline:human:* labels alone', async () => {
  const removed: string[] = [];
  const { fetch } = makeFakeFetch((call) => {
    if (matchOp(call.query, 'FindIssueLabel')) {
      return {
        issueLabels: {
          nodes: [{ id: 'label-target', name: 'pipeline:human:ready_for_action' }],
        },
      };
    }
    if (matchOp(call.query, 'IssueLabels')) {
      return {
        issue: {
          labels: {
            nodes: [
              { id: 'kind-bug', name: 'kind:bug' },
              { id: 'priority-high', name: 'priority:high' },
            ],
          },
        },
      };
    }
    if (matchOp(call.query, 'IssueRemoveLabel')) {
      removed.push((call.variables as { labelId: string }).labelId);
      return { issueRemoveLabel: { success: true } };
    }
    if (matchOp(call.query, 'IssueAddLabel')) {
      return { issueAddLabel: { success: true } };
    }
    throw new Error(`unexpected query: ${call.query}`);
  });

  const adapter = new LinearAdapter({ apiKey: 'k', teamId: 't', fetch });
  await adapter.updateStatusLabel(
    { id: 'issue-1', title: 'Echo' },
    'ready_for_action',
  );

  assert.deepEqual(removed, []);
});

// ---------------------------------------------------------------------------
// AC #4: comment posts a commentCreate mutation
// ---------------------------------------------------------------------------

test('comment posts a GraphQL issueCommentCreate mutation with the body', async () => {
  const { fetch, calls } = makeFakeFetch((call) => {
    if (matchOp(call.query, 'IssueCommentCreate')) {
      return { commentCreate: { success: true } };
    }
    throw new Error(`unexpected query: ${call.query}`);
  });

  const adapter = new LinearAdapter({ apiKey: 'k', teamId: 't', fetch });
  await adapter.comment({ id: 'issue-7', title: 'Echo' }, 'hello world');

  assert.equal(calls.length, 1);
  const c = calls[0];
  assert.ok(matchOp(c.query, 'IssueCommentCreate'));
  assert.ok(matchField(c.query, 'commentCreate'));
  const input = (c.variables as { input: { issueId: string; body: string } }).input;
  assert.deepEqual(input, { issueId: 'issue-7', body: 'hello world' });
});

// ---------------------------------------------------------------------------
// AC #5: getIssueByTaskId resolves to null on miss — no throw
// ---------------------------------------------------------------------------

test('getIssueByTaskId returns null when no matching issue exists', async () => {
  const { fetch, calls } = makeFakeFetch((call) => {
    if (matchOp(call.query, 'IssueByTaskLabel')) {
      return { issues: { nodes: [] } };
    }
    throw new Error(`unexpected query: ${call.query}`);
  });

  const adapter = new LinearAdapter({ apiKey: 'k', teamId: 't', fetch });
  const result = await adapter.getIssueByTaskId('does-not-exist');

  assert.equal(result, null);
  // Lookup must use the task:<id> label filter so a single label-only query
  // stays well below Linear's 10k complexity budget.
  assert.equal(calls.length, 1);
  assert.equal(
    (calls[0].variables as { name: string }).name,
    'task:does-not-exist',
  );
});

test('getIssueByTaskId returns the IssueRef when a match exists', async () => {
  const { fetch } = makeFakeFetch((call) => {
    if (matchOp(call.query, 'IssueByTaskLabel')) {
      return { issues: { nodes: [{ id: 'issue-9', title: 'Echo' }] } };
    }
    throw new Error(`unexpected query: ${call.query}`);
  });

  const adapter = new LinearAdapter({ apiKey: 'k', teamId: 't', fetch });
  const result = await adapter.getIssueByTaskId('T42');

  assert.deepEqual(result, { id: 'issue-9', title: 'Echo' });
});

// ---------------------------------------------------------------------------
// Transport / error handling
// ---------------------------------------------------------------------------

test('GraphQL errors propagate as a thrown Error', async () => {
  const fetchImpl: typeof fetch = (async () =>
    new Response(
      JSON.stringify({ errors: [{ message: 'oops' }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )) as unknown as typeof fetch;

  const adapter = new LinearAdapter({ apiKey: 'k', teamId: 't', fetch: fetchImpl });
  await assert.rejects(
    adapter.comment({ id: 'i', title: 't' }, 'x'),
    /Linear GraphQL error/,
  );
});

test('non-2xx HTTP responses propagate as a thrown Error', async () => {
  const fetchImpl: typeof fetch = (async () =>
    new Response('boom', { status: 500 })) as unknown as typeof fetch;

  const adapter = new LinearAdapter({ apiKey: 'k', teamId: 't', fetch: fetchImpl });
  await assert.rejects(
    adapter.getIssueByTaskId('T1'),
    /Linear HTTP 500/,
  );
});
