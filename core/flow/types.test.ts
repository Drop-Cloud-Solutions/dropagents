import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BUILT_IN_APPROVAL_DEFAULTS,
  FLOW_STEP_APPROVALS,
  FLOW_STEP_KINDS,
  PR_GATEWAY_STEP_KINDS,
  isFlowStepApproval,
} from './types';
import type {
  ApprovalDefaultKind,
  FlowStep,
  FlowStepApproval,
  FlowStepKind,
} from './types';

test('FlowStep.approval is optional and narrows to "auto" | "required"', () => {
  const auto: FlowStep = {
    id: 'a',
    agent: 'developer',
    model: 'claude-sonnet-4-6',
    on_success: 'emit:task.done',
    approval: 'auto',
  };
  const required: FlowStep = {
    id: 'b',
    agent: 'wait-action',
    model: '-',
    on_success: 'emit:task.done',
    approval: 'required',
  };
  const absent: FlowStep = {
    id: 'c',
    agent: 'developer',
    model: 'claude-sonnet-4-6',
    on_success: 'emit:task.done',
  };

  assert.equal(auto.approval, 'auto');
  assert.equal(required.approval, 'required');
  assert.equal(absent.approval, undefined);

  const bad: FlowStep = {
    id: 'd',
    agent: 'developer',
    model: 'claude-sonnet-4-6',
    on_success: 'emit:task.done',
    // @ts-expect-error — approval must be one of the closed union members
    approval: 'maybe',
  };
  void bad;
});

test('FLOW_STEP_APPROVALS exposes exactly "auto" and "required"', () => {
  assert.equal(FLOW_STEP_APPROVALS.AUTO, 'auto');
  assert.equal(FLOW_STEP_APPROVALS.REQUIRED, 'required');
  assert.deepEqual(
    new Set(Object.values(FLOW_STEP_APPROVALS)),
    new Set(['auto', 'required']),
  );
});

test('isFlowStepApproval narrows arbitrary strings to the closed union', () => {
  assert.equal(isFlowStepApproval('auto'), true);
  assert.equal(isFlowStepApproval('required'), true);
  assert.equal(isFlowStepApproval('maybe'), false);
  assert.equal(isFlowStepApproval(''), false);

  const raw: string = 'auto';
  if (isFlowStepApproval(raw)) {
    const narrowed: FlowStepApproval = raw;
    assert.equal(narrowed, 'auto');
  } else {
    assert.fail('expected "auto" to narrow');
  }
});

test('PR_GATEWAY_STEP_KINDS exposes exactly "pr.open" and "pr.merge"', () => {
  assert.equal(PR_GATEWAY_STEP_KINDS.OPEN, 'pr.open');
  assert.equal(PR_GATEWAY_STEP_KINDS.MERGE, 'pr.merge');
  assert.deepEqual(
    new Set(Object.values(PR_GATEWAY_STEP_KINDS)),
    new Set(['pr.open', 'pr.merge']),
  );
});

test('BUILT_IN_APPROVAL_DEFAULTS is exhaustive over every FLOW_STEP_KINDS member', () => {
  const declared = new Set<string>(Object.values(FLOW_STEP_KINDS));
  const defaulted = new Set<string>(Object.keys(BUILT_IN_APPROVAL_DEFAULTS));

  for (const kind of declared) {
    assert.ok(
      defaulted.has(kind),
      `FLOW_STEP_KINDS member "${kind}" missing a default in BUILT_IN_APPROVAL_DEFAULTS`,
    );
  }
});

test('BUILT_IN_APPROVAL_DEFAULTS covers the PR-gateway step kinds', () => {
  const defaulted = new Set<string>(Object.keys(BUILT_IN_APPROVAL_DEFAULTS));
  for (const kind of Object.values(PR_GATEWAY_STEP_KINDS)) {
    assert.ok(
      defaulted.has(kind),
      `PR-gateway step kind "${kind}" missing a default in BUILT_IN_APPROVAL_DEFAULTS`,
    );
  }
});

test('BUILT_IN_APPROVAL_DEFAULTS keys are exactly the ApprovalDefaultKind union', () => {
  const declared = new Set<string>([
    ...Object.values(FLOW_STEP_KINDS),
    ...Object.values(PR_GATEWAY_STEP_KINDS),
  ]);
  const defaulted = new Set<string>(Object.keys(BUILT_IN_APPROVAL_DEFAULTS));
  assert.deepEqual(
    defaulted,
    declared,
    'BUILT_IN_APPROVAL_DEFAULTS must cover FLOW_STEP_KINDS + PR_GATEWAY_STEP_KINDS exactly — no extras, no gaps',
  );
});

test('BUILT_IN_APPROVAL_DEFAULTS values are members of FlowStepApproval', () => {
  for (const [kind, approval] of Object.entries(BUILT_IN_APPROVAL_DEFAULTS)) {
    assert.equal(
      isFlowStepApproval(approval),
      true,
      `default for "${kind}" must be a FlowStepApproval (got "${approval}")`,
    );
  }
});

test('BUILT_IN_APPROVAL_DEFAULTS matches the AP-VP-001 plan', () => {
  // Required gates — operator interaction expected.
  assert.equal(BUILT_IN_APPROVAL_DEFAULTS['wait-action'], 'required');
  assert.equal(BUILT_IN_APPROVAL_DEFAULTS['pr.open'], 'required');
  assert.equal(BUILT_IN_APPROVAL_DEFAULTS['pr.merge'], 'required');
  // `merge` is the agent-prompt-shaped alias for `pr.merge`; same gate.
  assert.equal(BUILT_IN_APPROVAL_DEFAULTS['merge'], 'required');

  // Auto gates — no operator interaction needed.
  assert.equal(BUILT_IN_APPROVAL_DEFAULTS['run-script'], 'auto');
  assert.equal(BUILT_IN_APPROVAL_DEFAULTS['verify'], 'auto');
  assert.equal(BUILT_IN_APPROVAL_DEFAULTS['context-update'], 'auto');
  assert.equal(BUILT_IN_APPROVAL_DEFAULTS['report-only'], 'auto');
});

test('BUILT_IN_APPROVAL_DEFAULTS rejects unknown keys at the type level', () => {
  // The Record<ApprovalDefaultKind, …> annotation means only members of
  // FLOW_STEP_KINDS or PR_GATEWAY_STEP_KINDS are accepted as keys.
  // Anything else is a compile error.
  // @ts-expect-error — "totally-made-up" is not an ApprovalDefaultKind member
  const unknownKey = BUILT_IN_APPROVAL_DEFAULTS['totally-made-up'];
  // @ts-expect-error — "developer" (an agent role) is not an ApprovalDefaultKind member
  const unknownKey2 = BUILT_IN_APPROVAL_DEFAULTS['developer'];
  void unknownKey;
  void unknownKey2;

  // Runtime lookup still works (Record is structurally a plain object),
  // but the runtime value is undefined — demonstrating the table does
  // not silently default unknown kinds.
  assert.equal(
    (BUILT_IN_APPROVAL_DEFAULTS as Record<string, FlowStepApproval | undefined>)[
      'totally-made-up'
    ],
    undefined,
  );
});

test('FlowStepKind narrows to FLOW_STEP_KINDS values only', () => {
  const wait: FlowStepKind = FLOW_STEP_KINDS.WAIT_ACTION;
  assert.equal(wait, 'wait-action');

  // @ts-expect-error — arbitrary strings are not assignable to FlowStepKind
  const bogus: FlowStepKind = 'pr.open';
  void bogus;
});

test('ApprovalDefaultKind narrows to FLOW_STEP_KINDS ∪ PR_GATEWAY_STEP_KINDS only', () => {
  const k1: ApprovalDefaultKind = FLOW_STEP_KINDS.WAIT_ACTION;
  const k2: ApprovalDefaultKind = PR_GATEWAY_STEP_KINDS.OPEN;
  assert.equal(k1, 'wait-action');
  assert.equal(k2, 'pr.open');

  // @ts-expect-error — arbitrary strings are not assignable to ApprovalDefaultKind
  const bogus: ApprovalDefaultKind = 'developer';
  void bogus;
});
