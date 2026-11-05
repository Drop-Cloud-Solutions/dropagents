import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';

import { loadFlow } from '../../core/flow/loader';
import type { Event } from '../../core/events/event';

import { FakeAgentRunner, type EventPublisher } from './FakeAgentRunner';
import { FakeChatGateway } from './FakeChatGateway';
import { FakeIssueTracker } from './FakeIssueTracker';
import { FakeSourceControl } from './FakeSourceControl';

function recordingPublisher(): EventPublisher & { events: Event[] } {
  const events: Event[] = [];
  return {
    events,
    async publish(event: Event): Promise<unknown> {
      events.push(event);
      return { seq: events.length, ...event };
    }
  };
}

// ---------------------------------------------------------------------------
// echo.yaml — AC #1 + AC #6
// ---------------------------------------------------------------------------

test('config/flows/echo.yaml loads via loadFlow and matches the AC shape', () => {
  const file = path.resolve(__dirname, '../../config/flows/echo.yaml');
  const flow = loadFlow(file);

  assert.equal(flow.on, 'TaskApproved');
  assert.equal(flow.steps.length, 1);

  const [step] = flow.steps;
  assert.equal(step.id, 'echo');
  assert.equal(step.agent, 'echo');
  assert.equal(step.model, 'none');
  assert.equal(step.on_success, 'emit:TaskFinished');
});

// ---------------------------------------------------------------------------
// FakeIssueTracker — AC #2
// ---------------------------------------------------------------------------

test('FakeIssueTracker records every call in getCalls()', async () => {
  const tracker = new FakeIssueTracker();

  const project = await tracker.createProject({ name: 'Phase 0' });
  const issue = await tracker.createIssue({
    title: 'echo round-trip',
    projectId: project.id
  });
  await tracker.closeIssue(issue.id, 'shipped');
  await tracker.skipIssue('issue-other', 'duplicate');

  const calls = tracker.getCalls();
  assert.equal(calls.length, 4);
  assert.equal(calls[0].kind, 'createProject');
  assert.equal(calls[1].kind, 'createIssue');
  assert.equal(calls[2].kind, 'closeIssue');
  assert.equal(calls[3].kind, 'skipIssue');

  // getCalls returns a snapshot — mutating the returned array must not
  // affect later reads.
  (calls as unknown as unknown[]).pop();
  assert.equal(tracker.getCalls().length, 4);
});

// ---------------------------------------------------------------------------
// FakeAgentRunner — AC #3
// ---------------------------------------------------------------------------

test('FakeAgentRunner.start publishes AgentStarted then AgentFinished and returns a handle', async () => {
  const bus = recordingPublisher();
  const runner = new FakeAgentRunner({ bus, clock: () => 1700000000000 });

  const handle = runner.start({ role: 'echo', prompt: 'hi' });

  assert.equal(typeof handle.id, 'string');
  assert.equal(handle.spec.role, 'echo');

  await runner.flush();

  assert.equal(bus.events.length, 2);
  assert.equal(bus.events[0].type, 'AgentStarted');
  assert.equal(bus.events[1].type, 'AgentFinished');
  assert.equal(bus.events[0].occurredAt, 1700000000000);
  assert.notEqual(bus.events[0].idempotencyKey, bus.events[1].idempotencyKey);
});

// ---------------------------------------------------------------------------
// FakeChatGateway — AC #4
// ---------------------------------------------------------------------------

test('FakeChatGateway.notify is a no-op', async () => {
  const gateway = new FakeChatGateway();
  const result = await gateway.notify('any-channel', 'any-message');
  assert.equal(result, undefined);
});

// ---------------------------------------------------------------------------
// FakeSourceControl — AC #5
// ---------------------------------------------------------------------------

test('FakeSourceControl methods return synthetic identifiers', async () => {
  const sc = new FakeSourceControl();

  await sc.createBranch('feature/x');

  const c1 = await sc.commit({ message: 'first' });
  const c2 = await sc.commit({ message: 'second' });
  assert.match(c1.sha, /^fake-sha-/);
  assert.notEqual(c1.sha, c2.sha);

  const pr = await sc.openPullRequest({ title: 't', head: 'feature/x', base: 'main' });
  assert.equal(pr.number, 1);
  assert.equal(pr.id, 'fake-pr-1');
  assert.equal(pr.url, 'https://fake.invalid/pull/1');

  const diff = await sc.getDiff();
  assert.equal(diff, '');
});
