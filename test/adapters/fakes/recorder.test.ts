/**
 * Unit tests for the shared `Recorder` utility used by the fake adapters.
 *
 * Dual-runner discovery: the repo's `npm test` runs node:test (see
 * package.json#scripts.test → `node --test --import tsx`); the review
 * pipeline runs `npx vitest run` on changed files. The shim below picks
 * the right `test()` at module load so both runners discover the same
 * suite from a single source file — without ever statically importing
 * from `vitest`, which would crash under `node --test`. See
 * vitest.config.ts for the matching `globals: true` setting.
 */
import assert from 'node:assert/strict';

import { Recorder, type RecordedCall } from '../../../adapters/fakes/recorder';

// ---------------------------------------------------------------------------
// Dual-runner test() shim
// ---------------------------------------------------------------------------

type TestFn = (name: string, fn: () => void | Promise<void>) => void;

const test: TestFn = (((): TestFn => {
  if (process.env.VITEST) {
    const gt = (globalThis as { test?: TestFn }).test;
    if (typeof gt !== 'function') {
      throw new Error(
        'recorder.test.ts: VITEST=true but globalThis.test is missing — '
          + 'ensure vitest.config.ts sets test.globals = true',
      );
    }
    return gt;
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
  const nt = require('node:test') as { test: TestFn };
  return nt.test;
})());

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fixedClock(start = 1_700_000_000_000): () => number {
  let t = start;
  return () => t++;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('Recorder.append stores adapter, method, args and a timestamp', () => {
  const recorder = new Recorder({ clock: fixedClock(1_700_000_000_000) });

  recorder.append('IssueTracker', 'createIssue', { title: 'hi' });

  const entries = recorder.entries();
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0], {
    adapter: 'IssueTracker',
    method: 'createIssue',
    args: { title: 'hi' },
    timestamp: 1_700_000_000_000
  } satisfies RecordedCall);
});

test('Recorder.entries returns a snapshot — external mutation must not bleed back', () => {
  const recorder = new Recorder({ clock: fixedClock() });
  recorder.append('A', 'm1', null);
  recorder.append('A', 'm2', null);

  const entries = recorder.entries();
  entries.pop();

  assert.equal(recorder.entries().length, 2);
});

test('Recorder.entries / findCalls return calls in append order', () => {
  const recorder = new Recorder({ clock: fixedClock() });
  recorder.append('A', 'first', 1);
  recorder.append('B', 'second', 2);
  recorder.append('A', 'third', 3);

  const all = recorder.entries();
  assert.deepEqual(
    all.map((c) => c.method),
    ['first', 'second', 'third']
  );

  const byAdapter = recorder.findCalls({ adapter: 'A' });
  assert.deepEqual(
    byAdapter.map((c) => c.method),
    ['first', 'third']
  );
});

test('Recorder.findCalls filters by adapter', () => {
  const recorder = new Recorder({ clock: fixedClock() });
  recorder.append('A', 'm', null);
  recorder.append('B', 'm', null);
  recorder.append('A', 'm', null);

  const result = recorder.findCalls({ adapter: 'A' });
  assert.equal(result.length, 2);
  assert.ok(result.every((c) => c.adapter === 'A'));
});

test('Recorder.findCalls filters by method', () => {
  const recorder = new Recorder({ clock: fixedClock() });
  recorder.append('A', 'createIssue', null);
  recorder.append('A', 'closeIssue', null);
  recorder.append('B', 'createIssue', null);

  const result = recorder.findCalls({ method: 'createIssue' });
  assert.equal(result.length, 2);
  assert.ok(result.every((c) => c.method === 'createIssue'));
});

test('Recorder.findCalls combines adapter and method filters', () => {
  const recorder = new Recorder({ clock: fixedClock() });
  recorder.append('A', 'createIssue', 1);
  recorder.append('A', 'closeIssue', 2);
  recorder.append('B', 'createIssue', 3);

  const result = recorder.findCalls({ adapter: 'A', method: 'createIssue' });
  assert.equal(result.length, 1);
  assert.equal(result[0].args, 1);
});

test('Recorder.findCalls with no filter returns every call in order', () => {
  const recorder = new Recorder({ clock: fixedClock() });
  recorder.append('A', 'm1', null);
  recorder.append('B', 'm2', null);

  const result = recorder.findCalls();
  assert.equal(result.length, 2);
  assert.equal(result[0].adapter, 'A');
  assert.equal(result[1].adapter, 'B');
});

test('Recorder.reset empties the entries', () => {
  const recorder = new Recorder({ clock: fixedClock() });
  recorder.append('A', 'm', null);
  recorder.append('B', 'm', null);
  assert.equal(recorder.entries().length, 2);

  recorder.reset();

  assert.equal(recorder.entries().length, 0);
  assert.deepEqual(recorder.findCalls({ adapter: 'A' }), []);
});

test('Recorder records subsequent appends after reset', () => {
  const recorder = new Recorder({ clock: fixedClock() });
  recorder.append('A', 'm', null);
  recorder.reset();
  recorder.append('B', 'm', null);

  const entries = recorder.entries();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].adapter, 'B');
});

test('Recorder uses Date.now by default when no clock injected', () => {
  const before = Date.now();
  const recorder = new Recorder();
  recorder.append('A', 'm', null);
  const after = Date.now();

  const [entry] = recorder.entries();
  assert.ok(entry.timestamp >= before && entry.timestamp <= after);
});
