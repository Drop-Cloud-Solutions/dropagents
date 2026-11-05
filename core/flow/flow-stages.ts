/**
 * Flow-stage descriptor (P-TOTS-001).
 *
 * A {@link FlowDefinition} already carries the authoritative ordered list of
 * steps a task will run — but that shape is engine-facing (`on_success`
 * targets, `model`, `approval`) and not something a UI surface can render
 * directly. `deriveFlowStages` projects a flow down to the minimal,
 * display-oriented descriptor a stage strip needs: for each step, the
 * `stepId`, the `agent`, a human-readable `label`, and a `kind` that tells a
 * caller whether the step is real agent work or an operator gate.
 *
 * The point is to replace hardcoded stage bars (the fixed
 * `Developer › Reviewer › Tester › Commit` four-chip strip) with something
 * derived from the flow a task actually runs — so a `document` flow with no
 * tester, a single-step `deploy-azure`, or a lone `investigate` chip each
 * render their own steps instead of a one-size-fits-all bar.
 *
 * Architectural contract
 * ----------------------
 * - **Pure.** Same {@link FlowDefinition} in → same {@link FlowStage}[] out.
 *   No I/O: it never reads the filesystem, loads YAML, or touches globals.
 * - **Non-mutating.** The input flow and its steps are never modified; the
 *   result is a freshly-built array of fresh objects.
 * - **Order-preserving.** Stages come out in `flow.steps` declaration order,
 *   one stage per step — including operator gates. Callers that want to hide
 *   gates from a step strip filter `kind === 'gate'` themselves; this
 *   function never drops a step.
 */

import {
  FLOW_STEP_KINDS,
  PR_GATEWAY_STEP_KINDS,
} from './types';
import type { FlowDefinition } from './types';

/** Per-step display kind. */
export type FlowStageKind = 'agent' | 'gate';

/**
 * Display-oriented projection of a single {@link FlowStep}.
 *
 * - `stepId` / `agent` are copied verbatim from the source step.
 * - `label` is a human-readable title (agent roles title-cased, gate/pass-
 *   through kinds resolved through {@link STEP_LABELS}).
 * - `kind` is `'gate'` for the operator-gated step kinds and `'agent'` for
 *   every free-form agent role and pass-through step.
 */
export interface FlowStage {
  readonly stepId: string;
  readonly agent: string;
  readonly label: string;
  readonly kind: FlowStageKind;
}

/**
 * Operator-gated step kinds. These are the steps where the flow either parks
 * the task pending an operator action (`wait-action`, `wait-merged`) or hands
 * off to the PR gateway (`pr.open`, `pr.merge`, and its `merge` alias). Built
 * from the shared {@link FLOW_STEP_KINDS} / {@link PR_GATEWAY_STEP_KINDS}
 * constants rather than re-listing literals so a rename upstream flows through
 * here for free.
 */
const GATE_AGENTS: ReadonlySet<string> = new Set<string>([
  FLOW_STEP_KINDS.WAIT_ACTION,
  FLOW_STEP_KINDS.WAIT_MERGED,
  FLOW_STEP_KINDS.MERGE,
  // Auto variants render as gates too: no agent works at these steps —
  // they're the same decision points with the operator taken out.
  FLOW_STEP_KINDS.COMMIT_AUTO,
  FLOW_STEP_KINDS.MERGE_AUTO,
  PR_GATEWAY_STEP_KINDS.OPEN,
  PR_GATEWAY_STEP_KINDS.MERGE,
]);

/**
 * Display labels for the known non-agent step kinds. Agent roles are NOT
 * listed here — they fall through to the title-case derivation in
 * {@link labelForAgent}. `commit` is included as a convenience alias so a
 * step that surfaces the committer/PR-open verb reads "Commit" regardless of
 * whether the flow named the step `commit` or dispatched via `pr.open`.
 */
const STEP_LABELS: Readonly<Record<string, string>> = {
  [FLOW_STEP_KINDS.WAIT_ACTION]: 'Action',
  [FLOW_STEP_KINDS.WAIT_MERGED]: 'Merge',
  [FLOW_STEP_KINDS.MERGE]: 'Merge',
  [FLOW_STEP_KINDS.REPORT_ONLY]: 'Report',
  [FLOW_STEP_KINDS.CONTEXT_UPDATE]: 'Context update',
  [PR_GATEWAY_STEP_KINDS.OPEN]: 'Commit',
  [PR_GATEWAY_STEP_KINDS.MERGE]: 'Merge',
  [FLOW_STEP_KINDS.COMMIT_AUTO]: 'Commit (auto)',
  [FLOW_STEP_KINDS.MERGE_AUTO]: 'Merge (auto)',
  commit: 'Commit',
};

/** True when the step's `agent` value is one of the operator-gated kinds. */
function classifyKind(agent: string): FlowStageKind {
  return GATE_AGENTS.has(agent) ? 'gate' : 'agent';
}

/**
 * Title-case a free-form agent role for display: split on hyphens, capitalise
 * each word, join with a space. `developer` → `Developer`,
 * `deploy-verifier` → `Deploy Verifier`.
 */
function labelForAgent(agent: string): string {
  return agent
    .split('-')
    .filter((word) => word.length > 0)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/** Resolve the display label for a step's `agent` value. */
function labelFor(agent: string): string {
  const known = STEP_LABELS[agent];
  if (known) return known;
  return labelForAgent(agent);
}

/**
 * Project a {@link FlowDefinition} to its ordered {@link FlowStage} list.
 *
 * One stage per step, in declaration order, including operator gates. Pure and
 * non-mutating — see the module contract above.
 */
export function deriveFlowStages(flow: FlowDefinition): FlowStage[] {
  return flow.steps.map((step) => ({
    stepId: step.id,
    agent: step.agent,
    label: labelFor(step.agent),
    kind: classifyKind(step.agent),
  }));
}
