import { test } from 'node:test';
import assert from 'node:assert/strict';

import { UnknownStepKindError, evaluateApproval } from './approval';
import {
  BUILT_IN_APPROVAL_DEFAULTS,
  FLOW_STEP_APPROVALS,
  FLOW_STEP_KINDS,
} from './types';
import type { FlowStep, FlowStepApproval } from './types';

function buildStep(overrides: Partial<FlowStep> = {}): FlowStep {
  return {
    id: 'step-1',
    agent: FLOW_STEP_KINDS.WAIT_ACTION,
    model: '-',
    on_success: 'emit:task.done',
    ...overrides,
  };
}

test('project override wins over step.approval and the defaults table', () => {
  const step = buildStep({
    id: 'commit-gate',
    agent: FLOW_STEP_KINDS.WAIT_ACTION, // default = required
    approval: FLOW_STEP_APPROVALS.REQUIRED,
  });
  const overrides: Record<string, FlowStepApproval> = {
    'commit-gate': FLOW_STEP_APPROVALS.AUTO,
  };

  assert.equal(
    evaluateApproval(step, overrides, BUILT_IN_APPROVAL_DEFAULTS),
    'auto',
  );
});

test('step.approval wins over the defaults table when no override applies', () => {
  const step = buildStep({
    id: 'pr-open',
    agent: 'pr.open', // default = required
    approval: FLOW_STEP_APPROVALS.AUTO,
  });

  // No projectOverrides at all.
  assert.equal(
    evaluateApproval(step, undefined, BUILT_IN_APPROVAL_DEFAULTS),
    'auto',
  );

  // Overrides present, but keyed by a different step id — must not match.
  assert.equal(
    evaluateApproval(
      step,
      { 'some-other-step': FLOW_STEP_APPROVALS.REQUIRED },
      BUILT_IN_APPROVAL_DEFAULTS,
    ),
    'auto',
  );
});

test('defaults table is consulted when neither override nor step.approval is set', () => {
  // wait-action defaults to 'required'.
  const required = buildStep({
    id: 'park',
    agent: FLOW_STEP_KINDS.WAIT_ACTION,
  });
  assert.equal(
    evaluateApproval(required, undefined, BUILT_IN_APPROVAL_DEFAULTS),
    'required',
  );

  // verify defaults to 'auto'.
  const auto = buildStep({
    id: 'check',
    agent: FLOW_STEP_KINDS.VERIFY,
  });
  assert.equal(
    evaluateApproval(auto, undefined, BUILT_IN_APPROVAL_DEFAULTS),
    'auto',
  );

  // An empty overrides object is treated the same as undefined.
  assert.equal(
    evaluateApproval(required, {}, BUILT_IN_APPROVAL_DEFAULTS),
    'required',
  );
});

test('unknown step kind throws UnknownStepKindError naming the offending kind', () => {
  const step = buildStep({
    id: 'rogue',
    agent: 'developer', // free-form agent role, not in the defaults table
  });

  assert.throws(
    () => evaluateApproval(step, undefined, BUILT_IN_APPROVAL_DEFAULTS),
    (err: unknown) => {
      assert.ok(err instanceof UnknownStepKindError);
      assert.equal(err.name, 'UnknownStepKindError');
      assert.equal(err.stepKind, 'developer');
      assert.match(err.message, /developer/);
      return true;
    },
  );
});

test('override resolution prefers override even when override is "required" and step is "auto"', () => {
  // Mirror of the first test in the opposite direction — guards against an
  // implementation that only treats 'auto' as a meaningful override.
  const step = buildStep({
    id: 'tightened',
    agent: FLOW_STEP_KINDS.VERIFY, // default = auto
    approval: FLOW_STEP_APPROVALS.AUTO,
  });
  const overrides: Record<string, FlowStepApproval> = {
    tightened: FLOW_STEP_APPROVALS.REQUIRED,
  };

  assert.equal(
    evaluateApproval(step, overrides, BUILT_IN_APPROVAL_DEFAULTS),
    'required',
  );
});

test('evaluateApproval does not mutate its inputs', () => {
  const step = buildStep({ id: 'imm', agent: FLOW_STEP_KINDS.WAIT_ACTION });
  const overrides: Record<string, FlowStepApproval> = {
    imm: FLOW_STEP_APPROVALS.AUTO,
  };
  const stepBefore = JSON.stringify(step);
  const overridesBefore = JSON.stringify(overrides);
  const defaultsBefore = JSON.stringify(BUILT_IN_APPROVAL_DEFAULTS);

  evaluateApproval(step, overrides, BUILT_IN_APPROVAL_DEFAULTS);

  assert.equal(JSON.stringify(step), stepBefore);
  assert.equal(JSON.stringify(overrides), overridesBefore);
  assert.equal(JSON.stringify(BUILT_IN_APPROVAL_DEFAULTS), defaultsBefore);
});
