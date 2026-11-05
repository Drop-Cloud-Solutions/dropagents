import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

import * as yaml from 'js-yaml';

import { loadAllFlows, loadFlow } from '../../core/flow/loader';
import { TaskTypeCatalog } from '../../core/flow/task-types';
import { LIFECYCLE_STEP_KINDS } from '../../core/flow/engine';
import type { FlowDefinition, FlowStep } from '../../core/flow/types';
import { listPacks, loadPack } from '../packs';

const FLOWS_DIR = __dirname;
const REPO = path.resolve(__dirname, '..', '..');

/** Every flow directory the repo ships: core, then each pack's. */
const FLOW_SOURCES: ReadonlyArray<{ readonly name: string; readonly dir: string }> = [
  { name: 'core', dir: FLOWS_DIR },
  ...listPacks().map((id) => ({ name: `pack ${id}`, dir: loadPack(id).flowsDir })),
];
const EMIT_PREFIX = 'emit:';

function targetsOf(step: FlowStep): string[] {
  const out = [step.on_success];
  if (step.on_question !== undefined) out.push(step.on_question);
  if (step.on_failure !== undefined) out.push(step.on_failure);
  return out;
}

function assertNoDanglingRefs(id: string, flow: FlowDefinition): void {
  const stepIds = new Set(flow.steps.map((s) => s.id));
  for (const step of flow.steps) {
    for (const target of targetsOf(step)) {
      if (target.startsWith(EMIT_PREFIX)) {
        assert.ok(
          target.length > EMIT_PREFIX.length,
          `${id}: step "${step.id}" has an empty emit target`,
        );
        continue;
      }
      assert.ok(
        stepIds.has(target),
        `${id}: step "${step.id}" target "${target}" does not resolve to a known step id`,
      );
    }
  }
}

test('flow-load smoke: every core and pack flow loads and has no dangling refs', () => {
  assert.ok(loadAllFlows(FLOWS_DIR).size >= 4, 'expected at least 4 core flows');
  for (const source of FLOW_SOURCES) {
    for (const [id, flow] of loadAllFlows(source.dir)) {
      assert.ok(flow.steps.length > 0, `${source.name} ${id}: flow must have at least one step`);
      assertNoDanglingRefs(`${source.name} ${id}`, flow);
    }
  }
});

// "Every decomposer task type has a flow" used to be tested here against a
// copy of the validator's list, because a type without a flow leaves its
// task silently unstartable (field case: bump-package-reference task
// L-LNCB-006 stuck forever). It now holds by construction — the allowed set
// IS the loaded flows' `task_type.decomposable` (core/flow/task-types.ts) —
// so the checks below guard the declarations themselves instead.

test('a task-type flow that filters on task.type names its OWN type', () => {
  // A flow copied to a new file and not re-pointed would declare task type
  // X while only ever firing for Y: tasks of X would sit unstartable.
  for (const source of FLOW_SOURCES) {
    for (const [id, flow] of loadAllFlows(source.dir)) {
      if (!flow.task_type || flow.when === undefined) continue;
      const m = /task\.type\s*==\s*"([^"]+)"/.exec(flow.when);
      if (!m) continue;
      assert.equal(m[1], id, `${source.name} ${id}.yaml: when: tests task.type "${m[1]}", not its own id`);
    }
  }
});

test('a pack flow only uses agents core already knows or the pack itself ships', () => {
  // Roles used by core flows (personas and engine step kinds alike) are
  // known-good; anything else a pack flow names must be a persona the pack
  // ships, or its tasks would spawn an agent with no instructions.
  const coreRoles = new Set<string>(Object.values(LIFECYCLE_STEP_KINDS));
  for (const flow of loadAllFlows(FLOWS_DIR).values()) {
    for (const step of flow.steps) coreRoles.add(step.agent);
  }
  for (const f of fs.readdirSync(path.join(REPO, 'agents'))) {
    const m = /^(.+)\.CLAUDE\.md$/.exec(f);
    if (m) coreRoles.add(m[1]!);
  }
  for (const id of listPacks()) {
    const pack = loadPack(id);
    const shipped = new Set(
      (fs.existsSync(pack.agentsDir) ? fs.readdirSync(pack.agentsDir) : [])
        .map((f) => /^(.+)\.CLAUDE\.md$/.exec(f)?.[1])
        .filter((r): r is string => r !== undefined),
    );
    for (const [flowId, flow] of loadAllFlows(pack.flowsDir)) {
      for (const step of flow.steps) {
        if (step.agent.includes('.')) continue; // gateway steps (pr.open, pr.merge)
        assert.ok(
          coreRoles.has(step.agent) || shipped.has(step.agent),
          `pack ${id}: ${flowId}.yaml step "${step.id}" uses agent "${step.agent}", which neither core nor the pack provides`,
        );
      }
    }
  }
});

test('the verify-plan flow stays available from the Add-task menu', () => {
  // No longer auto-appended to decompositions, so the menu is its only
  // entry point.
  const catalog = TaskTypeCatalog.fromFlows(loadAllFlows(FLOWS_DIR));
  assert.equal(catalog.get('verify-plan')?.addTask, true);
});

// AP-IFG-003 — every shipped flow must declare start_mode explicitly so the
// loader's legacy "absent → approval-required" fallback never silently applies
// to a checked-in YAML. (The fallback exists only for backwards compatibility
// with off-tree flows; the audit's job is to make the in-repo flows mechanical.)
test('AP-IFG-003: every core and pack flow declares an explicit start_mode', () => {
  for (const source of FLOW_SOURCES) {
    for (const [id, flow] of loadAllFlows(source.dir)) {
      assert.notEqual(
        flow.start_mode,
        undefined,
        `${source.name} ${id}: must declare start_mode explicitly (auto | approval-required)`,
      );
    }
  }
});

test('scaffold.yaml drives developer -> reviewer -> tester -> human-review -> committer -> merge-auto', () => {
  const flow = loadFlow(path.join(FLOWS_DIR, 'scaffold.yaml'));

  assert.equal(flow.on, 'TaskApproved');
  assert.equal(flow.when, 'task.type == "scaffold"');

  const agents = flow.steps.map((s) => s.agent);
  assert.deepEqual(agents, [
    'developer',
    'reviewer',
    'tester',
    'worktree-diff-review',
    'committer',
    'merge-auto',
  ]);

  // Each step's on_success advances to the next step in order; the
  // terminal `merge-auto` (auto-merged PR) resumes straight to TaskFinished.
  for (let i = 0; i < flow.steps.length - 1; i += 1) {
    assert.equal(flow.steps[i].on_success, flow.steps[i + 1].id);
  }
  assert.equal(
    flow.steps[flow.steps.length - 1].on_success,
    'emit:TaskFinished',
  );
});

test('code-review.yaml drives a single reviewer step with verdict emits', () => {
  const flow = loadFlow(path.join(FLOWS_DIR, 'code-review.yaml'));

  assert.equal(flow.on, 'TaskApproved');
  assert.equal(flow.when, 'task.type == "code-review"');
  assert.equal(flow.steps.length, 1);

  const [only] = flow.steps;
  assert.equal(only.agent, 'reviewer');
  // Policy pin (B-model-A): the review step carries NO per-step model so the
  // role default applies — the agent record in the manager UI, else the
  // single `default_models.developer` default. Re-pinning a model here would
  // silently take the step away from operator control.
  assert.equal(only.model, 'none');
  assert.equal(only.on_success, 'emit:ReviewApproved');
  assert.equal(only.on_failure, 'emit:ReviewRejected');
});

test('code-review.yaml declares all three review events in order: requested → (approved | rejected)', () => {
  const flow = loadFlow(path.join(FLOWS_DIR, 'code-review.yaml'));
  const [step] = flow.steps;

  // ReviewRequested is declared on the entry step so the engine publishes it
  // before invoking the reviewer agent — i.e. it sits *before* the verdict
  // transitions, not after.
  assert.equal(step.params?.['pre_emit'], 'ReviewRequested');

  // The verdict transitions are exactly the approved/rejected emits — no
  // other terminal events in this flow.
  const emits = [step.on_success, step.on_failure].filter(
    (t): t is string => typeof t === 'string' && t.startsWith(EMIT_PREFIX),
  );
  assert.deepEqual(emits, ['emit:ReviewApproved', 'emit:ReviewRejected']);
});

test('document.yaml drives doc-writer -> reviewer -> human-review -> committer -> merge-auto', () => {
  const flow = loadFlow(path.join(FLOWS_DIR, 'document.yaml'));

  assert.equal(flow.on, 'TaskApproved');
  assert.equal(flow.when, 'task.type == "document"');

  const agents = flow.steps.map((s) => s.agent);
  assert.deepEqual(agents, [
    'doc-writer',
    'reviewer',
    'worktree-diff-review',
    'committer',
    'merge-auto',
  ]);

  for (let i = 0; i < flow.steps.length - 1; i += 1) {
    assert.equal(flow.steps[i].on_success, flow.steps[i + 1].id);
  }
  assert.equal(
    flow.steps[flow.steps.length - 1].on_success,
    'emit:TaskFinished',
  );
});

test('test-only.yaml drives a single tester step then emits TaskFinished', () => {
  const flow = loadFlow(path.join(FLOWS_DIR, 'test-only.yaml'));

  assert.equal(flow.on, 'TaskApproved');
  assert.equal(flow.when, 'task.type == "test-only"');
  assert.equal(flow.steps.length, 1);

  const [only] = flow.steps;
  assert.equal(only.agent, 'tester');
  // This asserted a DELIBERATE per-step pin until the operator collapsed
  // model config to one default plus per-agent overrides in the manager UI.
  // No flow step pins anything now — see `no flow step pins a model` below,
  // the policy this assertion used to contradict.
  assert.equal(only.model, 'none');
  assert.equal(only.on_success, 'emit:TaskFinished');
});

test('every step in every config/flows flow has a resolvable on_success target', () => {
  const flows = loadAllFlows(FLOWS_DIR);
  for (const [id, flow] of flows) {
    const stepIds = new Set(flow.steps.map((s) => s.id));
    for (const step of flow.steps) {
      const target = step.on_success;
      const ok =
        target.startsWith(EMIT_PREFIX) ? target.length > EMIT_PREFIX.length : stepIds.has(target);
      assert.ok(
        ok,
        `${id}: step "${step.id}" on_success "${target}" did not resolve`,
      );
    }
  }
});

test('every emit: target in every flow lands on an event something consumes', () => {
  // Field case T-DOA-002: deploy-verify.yaml's on_failure emitted
  // `DeployVerifyFailed`, an event with NO subscriber anywhere — a
  // verifier reporting STALE:/INCONCLUSIVE: routed into the void and the
  // task just went quiet. This guard makes that class of dangling route
  // a test failure instead of a silent field incident.
  const ROOT = path.join(__dirname, '..', '..');

  // Events consumed by the ENGINE itself rather than a named subscriber.
  const ENGINE_TERMINALS = new Set(['TaskFinished', 'TaskFailed']);
  // Documented exception: the worktree-diff-review LIFECYCLE flow (a
  // standalone `on: TaskCreated` surface) emits this for a downstream
  // commit flow that v2 never wired — the shipped implement/refactor/…
  // flows use a worktree-diff-review STEP instead, which resumes in
  // place. Left as-is deliberately; not a new dangling route.
  const KNOWN_UNCONSUMED = new Set(['WorktreeDiffApproved']);

  const sourceDirs = ['core', 'hosts', 'adapters'];
  const sources: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue;
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.ts')) continue;
      if (entry.name.includes('.test.') || entry.name.includes('.spec.')) continue;
      sources.push(fs.readFileSync(full, 'utf8'));
    }
  };
  for (const d of sourceDirs) walk(path.join(ROOT, d));

  const flows = loadAllFlows(FLOWS_DIR);
  for (const [id, flow] of flows) {
    for (const step of flow.steps) {
      for (const target of [step.on_success, step.on_failure]) {
        if (!target || !target.startsWith(EMIT_PREFIX)) continue;
        const event = target.slice(EMIT_PREFIX.length).trim();
        if (ENGINE_TERMINALS.has(event) || KNOWN_UNCONSUMED.has(event)) continue;
        const consumed = sources.some(
          (src) => src.includes(`'${event}'`) || src.includes(`"${event}"`),
        );
        assert.ok(
          consumed,
          `${id}: step "${step.id}" emits "${event}", which no runtime source consumes — `
            + 'either subscribe to it or route somewhere real',
        );
      }
    }
  }
});

test('a quality-gate step that has a producing predecessor must route failure back to it', () => {
  // Field case DF-BRBS-014 (document task, Example Platform): the
  // reviewer rejected the doc-writer's changes, but document.yaml's
  // `review` step declared no on_failure — so the rejection hit the
  // engine's default terminal and FAILED the task instead of sending
  // the doc-writer back round with the feedback. Every flow that has a
  // producing step followed by a reviewer/tester gate must close that
  // loop, or a rejection silently ends the task.
  const GATE_AGENTS = new Set(['reviewer', 'tester']);
  const flows = loadAllFlows(FLOWS_DIR);
  for (const [id, flow] of flows) {
    flow.steps.forEach((step, idx) => {
      if (!GATE_AGENTS.has(step.agent)) return;
      // Only meaningful when something upstream produced the work — a
      // flow whose FIRST step is the tester (test-only, verify-plan,
      // integration-test) has nowhere to route back to, and failing the
      // task is the correct terminal there.
      if (idx === 0) return;
      assert.ok(
        step.on_failure,
        `${id}: quality-gate step "${step.id}" (${step.agent}) has no on_failure — `
          + 'a rejection would fail the task instead of returning to the producing step',
      );
    });
  }
});

// ---------------------------------------------------------------------------
// One model for every role, with one named exception.
//
// Per-step pins had accumulated across 15 flows (haiku for committers,
// sonnet for testers, an opus-4-8 that outlived its model id). Each was a
// reasonable local call and together they made "which model ran this?"
// unanswerable without reading five files. The operator collapsed them: a
// single `default_models.developer` that every role inherits, and Fable for
// the architect.
//
// A new pin is not forbidden — it just has to be a decision someone makes
// here, rather than one that accretes.
// ---------------------------------------------------------------------------

test('no flow step pins a model — every step inherits', () => {
  const offenders: string[] = [];
  for (const [id, flow] of loadAllFlows(FLOWS_DIR)) {
    for (const step of flow.steps) {
      const model = step.model;
      if (model === undefined || model === 'none') continue;
      offenders.push(`${id}:${step.id} pins "${model}"`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'these steps pin a model instead of inheriting:\n'
    + offenders.join('\n')
    + '\nPer-role models belong on the agent in the manager UI, not here.',
  );
});

test('pipeline.yaml declares exactly one default model', () => {
  // The other half of the rule. A second entry here would reintroduce the
  // per-role layer the flows were just cleared of, and put the answer to
  // "which model ran this?" back into three files.
  const raw = fs.readFileSync(
    path.join(FLOWS_DIR, '..', 'pipeline.yaml'),
    'utf8',
  );
  const parsed = yaml.load(raw) as { default_models?: Record<string, unknown> };
  const models = parsed.default_models ?? {};
  assert.deepEqual(
    Object.keys(models),
    ['developer'],
    'default_models must hold ONLY the global default (the `developer` key '
    + '— see the comment in pipeline.yaml). Per-role overrides go on the '
    + 'agent record in the manager UI.',
  );
  assert.equal(models.developer, 'claude-opus-5');
});

test('scaffold-repo is a single step — it has no worktree to review or commit', () => {
  // Field case L-ADNS-001: the flow carried scaffold → review →
  // human-review → commit → merge, copied from scaffold.yaml. The
  // repo-scaffolder creates the GitHub repo and pushes the first commit
  // directly to the default branch, so there IS no per-task worktree —
  // every later step was unreachable. `human-review` parked on the diff
  // modal, which answered `404 task or worktree not found`, leaving the
  // operator with only Mark complete or Cancel on work that was already
  // done and pushed.
  const flow = loadFlow(path.join(FLOWS_DIR, 'scaffold-repo.yaml'));

  assert.equal(flow.steps.length, 1, 'a second step would have no worktree to act on');
  const [only] = flow.steps;
  assert.equal(only.agent, 'repo-scaffolder');
  assert.equal(only.on_success, 'emit:TaskFinished');
  assert.equal(only.on_failure, 'emit:TaskFailed');
  // Creating a GitHub repo is the one irreversible act here.
  assert.equal(only.approval, 'required');

  // Named explicitly: these are the steps that cannot work for this type.
  const agents = flow.steps.map((s) => s.agent);
  for (const forbidden of ['worktree-diff-review', 'committer', 'merge-auto']) {
    assert.ok(
      !agents.includes(forbidden),
      `${forbidden} needs a worktree; a scaffold-repo task never has one`,
    );
  }
});
