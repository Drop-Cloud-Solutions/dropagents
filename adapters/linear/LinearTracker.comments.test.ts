/**
 * AP-IFG-019: tests for LinearTracker.postCommentToIssue.
 *
 * Dual-runner discovery
 * ---------------------
 * The repo's `npm test` script runs `node --test --import tsx`, but the
 * review pipeline runs `npx vitest run` against the changed test file. A
 * file written against only one of those APIs gets reported as "no tests"
 * by the other and the pipeline rejects the run. The shim below mirrors
 * `core/flow/engine.start-mode.test.ts` — it picks vitest's
 * `globalThis.test` when `process.env.VITEST` is set and otherwise falls
 * back to `node:test`'s `test()` via `require`. Vitest v4 forbids
 * `require('vitest')` from CJS modules and tsc compiles this file to CJS
 * per the project's tsconfig, so a static `import { test } from 'vitest'`
 * also breaks under `node --test`.
 */

import * as assert from 'node:assert/strict';

import { IssueTrackerError } from '../../core/ports';

import { LinearApiError, type LinearClient } from './client';
import { LinearTracker, type ExternalRefsWriter } from './LinearTracker';

// ---------------------------------------------------------------------------
// Dual-runner test() shim — see file header for rationale.
// ---------------------------------------------------------------------------

type TestFn = (name: string, fn: () => void | Promise<void>) => void;

const test: TestFn = (((): TestFn => {
  if (process.env.VITEST) {
    const gt = (globalThis as { test?: TestFn }).test;
    if (typeof gt !== 'function') {
      throw new Error(
        'LinearTracker.comments.test.ts: VITEST=true but globalThis.test is missing — '
          + 'ensure vitest.config.ts sets test.globals = true'
      );
    }
    return gt;
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
  const nt = require('node:test') as { test: TestFn };
  return nt.test;
})());

// ---------------------------------------------------------------------------
// Test helpers — mirror the minimal shape used by LinearTracker.test.ts so
// the comments suite stays self-contained.
// ---------------------------------------------------------------------------

interface StubCall {
  readonly query: string;
  readonly variables: Readonly<Record<string, unknown>>;
}

type StubResponder = (call: StubCall) => unknown | Promise<unknown>;

class StubLinearClient implements LinearClient {
  readonly calls: StubCall[] = [];
  constructor(private readonly responder: StubResponder) {}
  async request<T>(
    query: string,
    opts: { variables?: Readonly<Record<string, unknown>> } = {}
  ): Promise<T> {
    const call: StubCall = { query, variables: opts.variables ?? {} };
    this.calls.push(call);
    const result = await this.responder(call);
    return result as T;
  }
}

class MemoryExternalRefs implements ExternalRefsWriter {
  write(): void {
    /* noop for these tests */
  }
}

function matchMutation(query: string, name: string): boolean {
  return new RegExp(`mutation\\s+${name}\\b`).test(query);
}

function makeTracker(client: LinearClient): LinearTracker {
  return new LinearTracker({
    client,
    externalRefs: new MemoryExternalRefs(),
    getTeamId: () => 'team-1'
  });
}

// ---------------------------------------------------------------------------
// AC #2 — happy path: postCommentToIssue invokes commentCreate with the
// caller's issueId + body verbatim, and returns void on success.
// ---------------------------------------------------------------------------

test('postCommentToIssue posts the body via commentCreate', async () => {
  const client = new StubLinearClient((call) => {
    if (matchMutation(call.query, 'PostComment')) {
      return { commentCreate: { success: true } };
    }
    throw new Error(`unexpected query: ${call.query}`);
  });
  const tracker = makeTracker(client);

  const result = await tracker.postCommentToIssue('lin-iss-42', 'progress: 50%');
  assert.equal(result, undefined);

  assert.equal(client.calls.length, 1);
  assert.ok(matchMutation(client.calls[0].query, 'PostComment'));
  const input = client.calls[0].variables.input as { issueId: string; body: string };
  assert.equal(input.issueId, 'lin-iss-42');
  assert.equal(input.body, 'progress: 50%');
});

// ---------------------------------------------------------------------------
// Idempotency contract — the brief calls this out explicitly: same body
// posted twice produces two comments by design (v1 behaviour). The adapter
// must not dedupe internally.
// ---------------------------------------------------------------------------

test('postCommentToIssue does not dedupe — same body twice yields two commentCreate calls', async () => {
  let invocations = 0;
  const client = new StubLinearClient((call) => {
    if (matchMutation(call.query, 'PostComment')) {
      invocations += 1;
      return { commentCreate: { success: true } };
    }
    throw new Error(`unexpected query: ${call.query}`);
  });
  const tracker = makeTracker(client);

  await tracker.postCommentToIssue('lin-iss-1', 'same body');
  await tracker.postCommentToIssue('lin-iss-1', 'same body');
  assert.equal(invocations, 2);
});

// ---------------------------------------------------------------------------
// AC #3 — error wrapping: LinearApiError thrown by the transport is wrapped
// in IssueTrackerError before it crosses the port boundary. The original
// error is preserved on `.cause` so adapter-level diagnostics survive.
// ---------------------------------------------------------------------------

test('postCommentToIssue wraps LinearApiError in IssueTrackerError', async () => {
  const upstream = new LinearApiError('Linear HTTP 500: kaboom', {
    status: 500,
    transient: true
  });
  const client = new StubLinearClient(() => {
    throw upstream;
  });
  const tracker = makeTracker(client);

  await assert.rejects(
    () => tracker.postCommentToIssue('lin-iss-1', 'body'),
    (err: unknown) => {
      assert.ok(err instanceof IssueTrackerError);
      assert.ok(!(err instanceof LinearApiError));
      assert.match((err as Error).message, /Linear commentCreate failed/);
      assert.match((err as Error).message, /kaboom/);
      assert.strictEqual((err as IssueTrackerError).cause, upstream);
      return true;
    }
  );
});

// Non-Linear errors (programmer error, unexpected transport throw) pass
// through unchanged so we don't accidentally swallow the stack trace by
// wrapping every failure.
test('postCommentToIssue rethrows non-LinearApiError unchanged', async () => {
  const upstream = new Error('boom');
  const client = new StubLinearClient(() => {
    throw upstream;
  });
  const tracker = makeTracker(client);

  await assert.rejects(
    () => tracker.postCommentToIssue('lin-iss-1', 'body'),
    (err: unknown) => err === upstream
  );
});

// A GraphQL-level `success: false` response is not a transport error but
// still indicates the comment never landed; surface it as
// IssueTrackerError so callers see a single domain type.
test('postCommentToIssue raises IssueTrackerError when commentCreate.success is false', async () => {
  const client = new StubLinearClient((call) => {
    if (matchMutation(call.query, 'PostComment')) {
      return { commentCreate: { success: false } };
    }
    throw new Error(`unexpected query: ${call.query}`);
  });
  const tracker = makeTracker(client);

  await assert.rejects(
    () => tracker.postCommentToIssue('lin-iss-1', 'body'),
    (err: unknown) =>
      err instanceof IssueTrackerError && /did not succeed/.test((err as Error).message)
  );
});
