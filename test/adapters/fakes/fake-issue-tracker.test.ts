/**
 * Unit tests for FakeIssueTracker — the recorder hook (AP-VP6-004).
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

import {
  FAKE_ISSUE_TRACKER_ADAPTER,
  FakeIssueTracker
} from '../../../adapters/fakes/FakeIssueTracker';
import { Recorder } from '../../../adapters/fakes/recorder';

// ---------------------------------------------------------------------------
// Dual-runner test() shim
// ---------------------------------------------------------------------------

type TestFn = (name: string, fn: () => void | Promise<void>) => void;

const test: TestFn = (((): TestFn => {
  if (process.env.VITEST) {
    const gt = (globalThis as { test?: TestFn }).test;
    if (typeof gt !== 'function') {
      throw new Error(
        'fake-issue-tracker.test.ts: VITEST=true but globalThis.test is missing — '
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
// With-recorder path
// ---------------------------------------------------------------------------

test('FakeIssueTracker records every public method when a recorder is supplied', async () => {
  const recorder = new Recorder({ clock: fixedClock() });
  const tracker = new FakeIssueTracker({ recorder });

  const project = await tracker.createProject({ name: 'Phase 0' });
  const issue = await tracker.createIssue({ title: 'echo', projectId: project.id });
  await tracker.closeIssue(issue.id, 'shipped');
  await tracker.skipIssue('issue-other', 'duplicate');
  await tracker.postCommentToIssue(issue.id, 'progress update');

  const entries = recorder.entries();
  assert.equal(entries.length, 5);
  assert.ok(entries.every((e) => e.adapter === FAKE_ISSUE_TRACKER_ADAPTER));
  assert.deepEqual(
    entries.map((e) => e.method),
    ['createProject', 'createIssue', 'closeIssue', 'skipIssue', 'postCommentToIssue']
  );
});

test('FakeIssueTracker recorded args carry the original method arguments', async () => {
  const recorder = new Recorder({ clock: fixedClock() });
  const tracker = new FakeIssueTracker({ recorder });

  await tracker.createProject({ name: 'P', description: 'd', key: 'PRJ' });
  await tracker.createIssue({
    title: 'T',
    description: 'desc',
    projectId: 'fake-project-1',
    labels: ['a', 'b']
  });
  await tracker.closeIssue('fake-issue-1', 'done');
  await tracker.skipIssue('fake-issue-2', 'dupe');
  await tracker.postCommentToIssue('fake-issue-1', 'hello');

  const [createProject, createIssue, closeIssue, skipIssue, postComment] =
    recorder.findCalls({ adapter: FAKE_ISSUE_TRACKER_ADAPTER });

  assert.deepEqual(createProject.args, {
    spec: { name: 'P', description: 'd', key: 'PRJ' }
  });
  assert.deepEqual(createIssue.args, {
    spec: {
      title: 'T',
      description: 'desc',
      projectId: 'fake-project-1',
      labels: ['a', 'b']
    }
  });
  assert.deepEqual(closeIssue.args, { id: 'fake-issue-1', summary: 'done' });
  assert.deepEqual(skipIssue.args, { id: 'fake-issue-2', reason: 'dupe' });
  assert.deepEqual(postComment.args, { issueId: 'fake-issue-1', body: 'hello' });
});

test('FakeIssueTracker recorded args are JSON-serializable', async () => {
  const recorder = new Recorder({ clock: fixedClock() });
  const tracker = new FakeIssueTracker({ recorder });

  await tracker.createIssue({ title: 'T', projectId: 'p1' });
  await tracker.closeIssue('i1', 's');

  for (const entry of recorder.entries()) {
    // round-tripping through JSON proves the args are serializable —
    // a requirement for the parity-smoke harness that writes records to disk.
    const roundTripped = JSON.parse(JSON.stringify(entry.args));
    assert.deepEqual(roundTripped, entry.args);
  }
});

// ---------------------------------------------------------------------------
// Without-recorder path
// ---------------------------------------------------------------------------

test('FakeIssueTracker without a recorder preserves return contracts', async () => {
  const tracker = new FakeIssueTracker();

  const project = await tracker.createProject({ name: 'Phase 0' });
  assert.equal(project.id, 'fake-project-1');
  assert.equal(project.name, 'Phase 0');

  const issue = await tracker.createIssue({ title: 'echo', projectId: project.id });
  assert.equal(issue.id, 'fake-issue-1');
  assert.equal(issue.title, 'echo');

  assert.equal(await tracker.closeIssue(issue.id, 'done'), undefined);
  assert.equal(await tracker.skipIssue('other', 'dupe'), undefined);
  assert.equal(await tracker.postCommentToIssue(issue.id, 'hi'), undefined);
});

test('FakeIssueTracker without a recorder still populates getCalls() unchanged', async () => {
  const tracker = new FakeIssueTracker();

  const project = await tracker.createProject({ name: 'P' });
  const issue = await tracker.createIssue({ title: 'T', projectId: project.id });
  await tracker.closeIssue(issue.id, 'done');
  await tracker.skipIssue('other', 'dupe');
  await tracker.postCommentToIssue(issue.id, 'hi');

  const calls = tracker.getCalls();
  assert.equal(calls.length, 5);
  assert.deepEqual(
    calls.map((c) => c.kind),
    ['createProject', 'createIssue', 'closeIssue', 'skipIssue', 'postCommentToIssue']
  );
});

test('FakeIssueTracker with a recorder leaves getCalls() unchanged', async () => {
  const recorder = new Recorder({ clock: fixedClock() });
  const tracker = new FakeIssueTracker({ recorder });

  await tracker.createProject({ name: 'P' });
  await tracker.createIssue({ title: 'T', projectId: 'fake-project-1' });

  // both observation surfaces stay in lockstep — recorder is additive, not a replacement
  assert.equal(recorder.entries().length, 2);
  assert.equal(tracker.getCalls().length, 2);
});
