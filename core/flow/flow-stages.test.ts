import { test } from 'node:test';
import assert from 'node:assert/strict';

import { deriveFlowStages } from './flow-stages';
import type { FlowDefinition, FlowStep } from './types';

/**
 * Minimal FlowDefinition builder. `deriveFlowStages` only reads `flow.steps`
 * (and, per step, `id` + `agent`), so the fixtures keep just enough shape to
 * be structurally valid — `on_success` is required on every step.
 */
function flowOf(steps: ReadonlyArray<Pick<FlowStep, 'id' | 'agent'>>): FlowDefinition {
  return {
    on: 'TaskApproved',
    start_mode: 'auto',
    steps: steps.map((s) => ({
      id: s.id,
      agent: s.agent,
      model: 'none',
      on_success: 'emit:TaskFinished',
    })),
  };
}

test('single-step deploy-azure derives one agent chip', () => {
  // config/flows/deploy-azure.yaml — a lone `deployer` step.
  const flow = flowOf([{ id: 'deploy', agent: 'deployer' }]);

  assert.deepEqual(deriveFlowStages(flow), [
    { stepId: 'deploy', agent: 'deployer', label: 'Deployer', kind: 'agent' },
  ]);
});

test('document flow (no tester) derives write → review → gate → commit → merge', () => {
  // config/flows/document.yaml — doc-writer chain, no tester step.
  const flow = flowOf([
    { id: 'write', agent: 'doc-writer' },
    { id: 'review', agent: 'reviewer' },
    { id: 'human-review', agent: 'worktree-diff-review' },
    { id: 'commit', agent: 'committer' },
    { id: 'merge', agent: 'wait-merged' },
  ]);

  assert.deepEqual(deriveFlowStages(flow), [
    { stepId: 'write', agent: 'doc-writer', label: 'Doc Writer', kind: 'agent' },
    { stepId: 'review', agent: 'reviewer', label: 'Reviewer', kind: 'agent' },
    {
      stepId: 'human-review',
      agent: 'worktree-diff-review',
      label: 'Worktree Diff Review',
      kind: 'agent',
    },
    { stepId: 'commit', agent: 'committer', label: 'Committer', kind: 'agent' },
    { stepId: 'merge', agent: 'wait-merged', label: 'Merge', kind: 'gate' },
  ]);

  // The document flow has no tester step — assert none was invented.
  assert.equal(
    deriveFlowStages(flow).some((s) => s.agent === 'tester'),
    false,
  );
});

test('investigate flow derives a single investigator chip', () => {
  // config/flows/investigate.yaml — one investigator step.
  const flow = flowOf([{ id: 'investigator', agent: 'investigator' }]);

  assert.deepEqual(deriveFlowStages(flow), [
    {
      stepId: 'investigator',
      agent: 'investigator',
      label: 'Investigator',
      kind: 'agent',
    },
  ]);
});

test('full implement chain: dev → review → test → commit → merge', () => {
  // config/flows/implement.yaml — the classic four-role chain plus the
  // worktree-diff-review gate and the wait-merged merge gate.
  const flow = flowOf([
    { id: 'develop', agent: 'developer' },
    { id: 'review', agent: 'reviewer' },
    { id: 'test', agent: 'tester' },
    { id: 'human-review', agent: 'worktree-diff-review' },
    { id: 'commit', agent: 'committer' },
    { id: 'merge', agent: 'wait-merged' },
  ]);

  const stages = deriveFlowStages(flow);

  assert.deepEqual(
    stages.map((s) => s.stepId),
    ['develop', 'review', 'test', 'human-review', 'commit', 'merge'],
  );
  assert.deepEqual(
    stages.map((s) => s.label),
    ['Developer', 'Reviewer', 'Tester', 'Worktree Diff Review', 'Committer', 'Merge'],
  );
  // The trailing wait-merged step is the only operator gate in the chain.
  assert.deepEqual(
    stages.map((s) => s.kind),
    ['agent', 'agent', 'agent', 'agent', 'agent', 'gate'],
  );
});

test('every gate kind classifies as kind=gate; merge/pr.merge read "Merge"', () => {
  const flow = flowOf([
    { id: 's1', agent: 'wait-action' },
    { id: 's2', agent: 'wait-merged' },
    { id: 's3', agent: 'merge' },
    { id: 's4', agent: 'pr.open' },
    { id: 's5', agent: 'pr.merge' },
  ]);

  assert.deepEqual(deriveFlowStages(flow), [
    { stepId: 's1', agent: 'wait-action', label: 'Action', kind: 'gate' },
    { stepId: 's2', agent: 'wait-merged', label: 'Merge', kind: 'gate' },
    { stepId: 's3', agent: 'merge', label: 'Merge', kind: 'gate' },
    { stepId: 's4', agent: 'pr.open', label: 'Commit', kind: 'gate' },
    { stepId: 's5', agent: 'pr.merge', label: 'Merge', kind: 'gate' },
  ]);
});

test('deploy-verifier title-cases the hyphenated role', () => {
  const flow = flowOf([{ id: 'verify', agent: 'deploy-verifier' }]);
  assert.equal(deriveFlowStages(flow)[0].label, 'Deploy Verifier');
});

test('report-only / context-update pass-throughs classify as kind=agent', () => {
  const flow = flowOf([
    { id: 'r', agent: 'report-only' },
    { id: 'c', agent: 'context-update' },
  ]);

  assert.deepEqual(deriveFlowStages(flow), [
    { stepId: 'r', agent: 'report-only', label: 'Report', kind: 'agent' },
    {
      stepId: 'c',
      agent: 'context-update',
      label: 'Context update',
      kind: 'agent',
    },
  ]);
});

test('deriveFlowStages is pure: does not mutate the input flow', () => {
  const flow = flowOf([{ id: 'develop', agent: 'developer' }]);
  const snapshot = JSON.stringify(flow);

  deriveFlowStages(flow);

  assert.equal(JSON.stringify(flow), snapshot);
});

test('deriveFlowStages returns one stage per step in declaration order', () => {
  const flow = flowOf([
    { id: 'a', agent: 'developer' },
    { id: 'b', agent: 'reviewer' },
    { id: 'c', agent: 'tester' },
  ]);

  const stages = deriveFlowStages(flow);
  assert.equal(stages.length, flow.steps.length);
  assert.deepEqual(stages.map((s) => s.stepId), ['a', 'b', 'c']);
});
