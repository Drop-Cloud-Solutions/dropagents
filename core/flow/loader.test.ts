import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { loadFlow, loadAllFlows, reloadAllFlowsInto } from './loader';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ap-nvp-008-flow-'));
}

function writeYaml(root: string, name: string, content: string): string {
  const full = path.join(root, name);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
  return full;
}

const VALID_FEATURE_FLOW = `
on: task.created
when: task.type == "feature"
steps:
  - id: plan
    agent: planner
    model: claude-opus-4-7
    on_success: develop
    on_failure: emit:task.failed
  - id: develop
    agent: developer
    model: claude-sonnet-4-6
    on_success: emit:task.developed
    on_question: plan
    on_failure: emit:task.failed
`;

test('loadFlow parses a valid flow into FlowDefinition with on/when/steps', () => {
  const dir = tmpDir();
  const file = writeYaml(dir, 'feature.yaml', VALID_FEATURE_FLOW);

  const flow = loadFlow(file);

  assert.equal(flow.on, 'task.created');
  assert.equal(flow.when, 'task.type == "feature"');
  assert.equal(flow.steps.length, 2);

  const [plan, develop] = flow.steps;
  assert.equal(plan.id, 'plan');
  assert.equal(plan.agent, 'planner');
  assert.equal(plan.model, 'claude-opus-4-7');
  assert.equal(plan.on_success, 'develop');
  assert.equal(plan.on_failure, 'emit:task.failed');
  assert.equal(plan.on_question, undefined);

  assert.equal(develop.id, 'develop');
  assert.equal(develop.on_success, 'emit:task.developed');
  assert.equal(develop.on_question, 'plan');
});

test('loadFlow accepts a flow without the optional when predicate', () => {
  const dir = tmpDir();
  const file = writeYaml(
    dir,
    'no-when.yaml',
    `on: task.created
steps:
  - id: only
    agent: dev
    model: m
    on_success: emit:done
`
  );
  const flow = loadFlow(file);
  assert.equal(flow.when, undefined);
  assert.equal(flow.on, 'task.created');
});

test('missing required field "on" is rejected with the file path in the message', () => {
  const dir = tmpDir();
  const file = writeYaml(
    dir,
    'no-on.yaml',
    `steps:
  - id: a
    agent: dev
    model: m
    on_success: emit:done
`
  );
  assert.throws(
    () => loadFlow(file),
    (err: unknown) =>
      err instanceof Error &&
      err.message.includes(file) &&
      /"on"/.test(err.message)
  );
});

test('a step missing its agent field is rejected naming the failing field', () => {
  const dir = tmpDir();
  const file = writeYaml(
    dir,
    'no-agent.yaml',
    `on: x
steps:
  - id: a
    model: m
    on_success: emit:done
`
  );
  assert.throws(
    () => loadFlow(file),
    (err: unknown) =>
      err instanceof Error &&
      err.message.includes(file) &&
      /agent/.test(err.message)
  );
});

test('malformed YAML is rejected with an error that includes the file path', () => {
  const dir = tmpDir();
  const file = writeYaml(dir, 'broken.yaml', 'on: x\nsteps: [unclosed\n  - bad: : :\n');
  assert.throws(
    () => loadFlow(file),
    (err: unknown) => err instanceof Error && err.message.includes(file)
  );
});

test('on_success that references an unknown step id is rejected at load time', () => {
  const dir = tmpDir();
  const file = writeYaml(
    dir,
    'dangle.yaml',
    `on: x
steps:
  - id: a
    agent: dev
    model: m
    on_success: nowhere
`
  );
  assert.throws(
    () => loadFlow(file),
    (err: unknown) =>
      err instanceof Error &&
      err.message.includes(file) &&
      /unknown step id "nowhere"/.test(err.message)
  );
});

test('a step unreachable from the entry step is rejected', () => {
  const dir = tmpDir();
  const file = writeYaml(
    dir,
    'unreach.yaml',
    `on: x
steps:
  - id: entry
    agent: dev
    model: m
    on_success: emit:done
  - id: orphan
    agent: dev
    model: m
    on_success: emit:done
`
  );
  assert.throws(
    () => loadFlow(file),
    (err: unknown) =>
      err instanceof Error && /unreachable.*orphan/.test(err.message)
  );
});

test('duplicate step ids inside a flow are rejected', () => {
  const dir = tmpDir();
  const file = writeYaml(
    dir,
    'dup.yaml',
    `on: x
steps:
  - id: a
    agent: dev
    model: m
    on_success: emit:done
  - id: a
    agent: dev
    model: m
    on_success: emit:done
`
  );
  assert.throws(
    () => loadFlow(file),
    (err: unknown) => err instanceof Error && /duplicate step id "a"/.test(err.message)
  );
});

test('loadAllFlows returns a Map keyed by file path relative to root (no extension)', () => {
  const dir = tmpDir();
  const okStep = `
  - id: s
    agent: dev
    model: m
    on_success: emit:done`;

  writeYaml(dir, 'one.yaml', `on: a\nsteps:${okStep}\n`);
  writeYaml(dir, 'two.yaml', `on: b\nsteps:${okStep}\n`);
  writeYaml(dir, path.join('sub', 'three.yaml'), `on: c\nsteps:${okStep}\n`);

  const flows = loadAllFlows(dir);

  assert.equal(flows.size, 3);
  assert.ok(flows.has('one'));
  assert.ok(flows.has('two'));
  assert.ok(flows.has('sub/three'));
  assert.equal(flows.get('one')?.on, 'a');
  assert.equal(flows.get('two')?.on, 'b');
  assert.equal(flows.get('sub/three')?.on, 'c');
});

test('loadAllFlows surfaces a per-file error including the offending path', () => {
  const dir = tmpDir();
  writeYaml(
    dir,
    'good.yaml',
    `on: a
steps:
  - id: s
    agent: dev
    model: m
    on_success: emit:done
`
  );
  const badPath = writeYaml(dir, 'bad.yaml', `on: a\nsteps: []\n`);

  assert.throws(
    () => loadAllFlows(dir),
    (err: unknown) =>
      err instanceof Error &&
      err.message.includes(badPath) &&
      /steps/.test(err.message)
  );
});

test('loadFlow accepts approval: required and approval: auto on a step', () => {
  const dir = tmpDir();
  const file = writeYaml(
    dir,
    'approval-ok.yaml',
    `on: x
steps:
  - id: gate
    agent: developer
    model: m
    approval: required
    on_success: ship
  - id: ship
    agent: developer
    model: m
    approval: auto
    on_success: emit:done
`
  );
  const flow = loadFlow(file);
  assert.equal(flow.steps[0].approval, 'required');
  assert.equal(flow.steps[1].approval, 'auto');
});

test('loadFlow rejects an unknown approval value with flow path, step id, and bad value', () => {
  const dir = tmpDir();
  const file = writeYaml(
    dir,
    'approval-bad.yaml',
    `on: x
steps:
  - id: gate
    agent: developer
    model: m
    approval: maybe
    on_success: emit:done
`
  );
  assert.throws(
    () => loadFlow(file),
    (err: unknown) =>
      err instanceof Error &&
      err.message.includes(file) &&
      /step "gate"\.approval/.test(err.message) &&
      /"maybe"/.test(err.message)
  );
});

test('loadFlow leaves step.approval undefined when the YAML omits the field', () => {
  const dir = tmpDir();
  const file = writeYaml(
    dir,
    'approval-omit.yaml',
    `on: x
steps:
  - id: only
    agent: developer
    model: m
    on_success: emit:done
`
  );
  const flow = loadFlow(file);
  assert.equal(flow.steps[0].approval, undefined);
  assert.ok(!('approval' in flow.steps[0]) || flow.steps[0].approval === undefined);
});

// ---------------------------------------------------------------------------
// reloadAllFlowsInto — hot-reload (Management UI Phase 4 "Apply")
// ---------------------------------------------------------------------------

test('reloadAllFlowsInto swaps the SAME map instance to the fresh on-disk state', () => {
  const dir = tmpDir();
  writeYaml(dir, 'feature.yaml', VALID_FEATURE_FLOW);
  const flows = loadAllFlows(dir);
  assert.deepEqual([...flows.keys()], ['feature']);

  // Operator edits: feature changes shape, echo is new.
  writeYaml(
    dir,
    'feature.yaml',
    `
on: task.created
steps:
  - id: only
    agent: developer
    model: none
    on_success: emit:task.finished
`
  );
  writeYaml(
    dir,
    'echo.yaml',
    `
on: task.created
steps:
  - id: run
    agent: echo
    model: none
    on_success: emit:task.finished
`
  );

  const result = reloadAllFlowsInto(flows, dir);

  // Same Map object (the engine holds it by reference) now carries the
  // fresh definitions.
  assert.deepEqual(result.flowIds.sort(), ['echo', 'feature']);
  assert.deepEqual([...flows.keys()].sort(), ['echo', 'feature']);
  assert.equal(flows.get('feature')?.steps.length, 1);
  assert.equal(flows.get('feature')?.steps[0].id, 'only');
});

test('reloadAllFlowsInto leaves the running map untouched when a flow on disk is invalid', () => {
  const dir = tmpDir();
  writeYaml(dir, 'feature.yaml', VALID_FEATURE_FLOW);
  const flows = loadAllFlows(dir);
  const before = flows.get('feature');

  // Break the file on disk: unknown on_success target fails the loader.
  writeYaml(
    dir,
    'feature.yaml',
    `
on: task.created
steps:
  - id: plan
    agent: planner
    model: none
    on_success: no-such-step
`
  );

  assert.throws(() => reloadAllFlowsInto(flows, dir));
  // Atomicity: the reload loads into a fresh map first, so the running
  // definitions are still the pre-edit ones.
  assert.equal(flows.get('feature'), before);
  assert.equal(flows.size, 1);
});

test('reloadAllFlowsInto drops flows whose files were deleted', () => {
  const dir = tmpDir();
  writeYaml(dir, 'feature.yaml', VALID_FEATURE_FLOW);
  writeYaml(
    dir,
    'echo.yaml',
    `
on: task.created
steps:
  - id: run
    agent: echo
    model: none
    on_success: emit:task.finished
`
  );
  const flows = loadAllFlows(dir);
  assert.equal(flows.size, 2);

  fs.rmSync(path.join(dir, 'echo.yaml'));
  reloadAllFlowsInto(flows, dir);

  assert.deepEqual([...flows.keys()], ['feature']);
});
