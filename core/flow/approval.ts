/**
 * AP-VP-003: evaluate the approval gate for a flow step.
 *
 * Pure function over three inputs — no IO, no module state. Resolution
 * order, highest precedence first:
 *
 *   1. `projectOverrides[step.id]` — per-project override keyed by step id.
 *   2. `step.approval`             — the value declared on the step itself.
 *   3. `defaults[step.kind]`       — the built-in default for the step kind.
 *
 * When none of the first two are present, the step's `agent` field is
 * looked up in `defaults` (the kind table is keyed by the literal `agent`
 * value — see {@link BUILT_IN_APPROVAL_DEFAULTS} and
 * {@link ApprovalDefaultKind} in `types.ts`). A missing entry there is a
 * programmer error: every step kind that reaches this function must have
 * been registered in the defaults table. {@link UnknownStepKindError} is
 * thrown so the caller fails fast rather than silently defaulting.
 */

import type {
  ApprovalDefaultKind,
  FlowStep,
  FlowStepApproval,
} from './types';
import { BUILT_IN_APPROVAL_DEFAULTS } from './types';

/**
 * Thrown when a step's `agent` (treated as the step kind) is not present
 * in the approval defaults table. The offending kind is captured on the
 * error so callers can surface it without re-parsing the message.
 */
export class UnknownStepKindError extends Error {
  override readonly name = 'UnknownStepKindError';
  readonly stepKind: string;

  constructor(stepKind: string) {
    super(
      `evaluateApproval: step kind "${stepKind}" is not registered in BUILT_IN_APPROVAL_DEFAULTS`,
    );
    this.stepKind = stepKind;
  }
}

export function evaluateApproval(
  step: FlowStep,
  projectOverrides: Record<string, FlowStepApproval> | undefined,
  defaults: typeof BUILT_IN_APPROVAL_DEFAULTS,
): FlowStepApproval {
  if (projectOverrides !== undefined) {
    const override = projectOverrides[step.id];
    if (override !== undefined) return override;
  }

  if (step.approval !== undefined) return step.approval;

  const kind = step.agent as ApprovalDefaultKind;
  const fallback = (defaults as Record<string, FlowStepApproval | undefined>)[
    kind
  ];
  if (fallback === undefined) {
    throw new UnknownStepKindError(step.agent);
  }
  return fallback;
}
