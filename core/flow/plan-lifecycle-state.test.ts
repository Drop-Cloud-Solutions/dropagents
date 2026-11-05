import { test } from 'node:test';
import assert from 'node:assert/strict';

import { initialState, step } from './plan-lifecycle';
import type { EventInput, State } from './plan-lifecycle';

// ---------------------------------------------------------------------------
// Happy path: brief -> planning -> awaiting-approval -> decomposing -> ready
// ---------------------------------------------------------------------------

test('happy path walks brief -> planning -> awaiting-approval -> decomposing -> ready', () => {
  let state: State = initialState;
  assert.deepEqual(state, { kind: 'brief' });

  state = step(state, { type: 'BriefSubmitted' });
  assert.deepEqual(state, { kind: 'planning', revision: 1 });

  state = step(state, { type: 'PlanGenerated' });
  assert.deepEqual(state, { kind: 'awaiting-approval', revision: 1 });

  state = step(state, { type: 'DecomposePlan' });
  assert.deepEqual(state, { kind: 'decomposing', revision: 1 });

  state = step(state, { type: 'PlanDecomposed' });
  assert.deepEqual(state, { kind: 'ready' });
});

// ---------------------------------------------------------------------------
// Regenerate loop: awaiting-approval -> planning with revision incremented
// ---------------------------------------------------------------------------

test('GeneratePlan from awaiting-approval re-enters planning with revision incremented', () => {
  const state: State = { kind: 'awaiting-approval', revision: 1 };
  const next = step(state, { type: 'GeneratePlan' });
  assert.deepEqual(next, { kind: 'planning', revision: 2 });
});

test('regenerate loop preserves revision monotonicity across multiple cycles', () => {
  let state: State = { kind: 'planning', revision: 1 };

  // r1: plan -> approve modal -> regenerate -> r2
  state = step(state, { type: 'PlanGenerated' });
  state = step(state, { type: 'GeneratePlan' });
  assert.deepEqual(state, { kind: 'planning', revision: 2 });

  // r2: plan -> approve modal -> regenerate -> r3
  state = step(state, { type: 'PlanGenerated' });
  state = step(state, { type: 'GeneratePlan' });
  assert.deepEqual(state, { kind: 'planning', revision: 3 });

  // r3: plan -> approve modal -> decompose preserves revision
  state = step(state, { type: 'PlanGenerated' });
  state = step(state, { type: 'DecomposePlan' });
  assert.deepEqual(state, { kind: 'decomposing', revision: 3 });
});

// ---------------------------------------------------------------------------
// Failure recovery: PlanDecomposeFailed sends decomposing back to
// awaiting-approval so the modal can offer Regenerate.
// ---------------------------------------------------------------------------

test('PlanDecomposeFailed from decomposing returns to awaiting-approval with same revision', () => {
  const state: State = { kind: 'decomposing', revision: 2 };
  const next = step(state, { type: 'PlanDecomposeFailed' });
  assert.deepEqual(next, { kind: 'awaiting-approval', revision: 2 });
});

test('after a failed decompose the operator can regenerate, bumping revision', () => {
  let state: State = { kind: 'decomposing', revision: 2 };
  state = step(state, { type: 'PlanDecomposeFailed' });
  assert.deepEqual(state, { kind: 'awaiting-approval', revision: 2 });

  // Operator picks Regenerate from the recovery modal.
  state = step(state, { type: 'GeneratePlan' });
  assert.deepEqual(state, { kind: 'planning', revision: 3 });
});

test('after a failed decompose the operator can re-approve the same revision', () => {
  let state: State = { kind: 'decomposing', revision: 4 };
  state = step(state, { type: 'PlanDecomposeFailed' });
  state = step(state, { type: 'DecomposePlan' });
  assert.deepEqual(state, { kind: 'decomposing', revision: 4 });
});

// ---------------------------------------------------------------------------
// Out-of-order / unknown events are ignored (no throw, identity return).
// ---------------------------------------------------------------------------

test('events that have no defined transition leave the state unchanged', () => {
  const cases: ReadonlyArray<{ from: State; event: EventInput }> = [
    { from: { kind: 'brief' }, event: { type: 'PlanGenerated' } },
    { from: { kind: 'brief' }, event: { type: 'DecomposePlan' } },
    { from: { kind: 'brief' }, event: { type: 'PlanDecomposed' } },
    { from: { kind: 'brief' }, event: { type: 'PlanDecomposeFailed' } },
    { from: { kind: 'brief' }, event: { type: 'GeneratePlan' } },
    { from: { kind: 'planning', revision: 1 }, event: { type: 'BriefSubmitted' } },
    { from: { kind: 'planning', revision: 1 }, event: { type: 'DecomposePlan' } },
    { from: { kind: 'planning', revision: 1 }, event: { type: 'PlanDecomposed' } },
    { from: { kind: 'planning', revision: 1 }, event: { type: 'PlanDecomposeFailed' } },
    { from: { kind: 'planning', revision: 1 }, event: { type: 'GeneratePlan' } },
    { from: { kind: 'awaiting-approval', revision: 1 }, event: { type: 'BriefSubmitted' } },
    { from: { kind: 'awaiting-approval', revision: 1 }, event: { type: 'PlanGenerated' } },
    { from: { kind: 'awaiting-approval', revision: 1 }, event: { type: 'PlanDecomposed' } },
    { from: { kind: 'awaiting-approval', revision: 1 }, event: { type: 'PlanDecomposeFailed' } },
    { from: { kind: 'decomposing', revision: 1 }, event: { type: 'BriefSubmitted' } },
    { from: { kind: 'decomposing', revision: 1 }, event: { type: 'PlanGenerated' } },
    { from: { kind: 'decomposing', revision: 1 }, event: { type: 'GeneratePlan' } },
    { from: { kind: 'decomposing', revision: 1 }, event: { type: 'DecomposePlan' } },
    { from: { kind: 'ready' }, event: { type: 'BriefSubmitted' } },
    { from: { kind: 'ready' }, event: { type: 'PlanGenerated' } },
    { from: { kind: 'ready' }, event: { type: 'GeneratePlan' } },
    { from: { kind: 'ready' }, event: { type: 'DecomposePlan' } },
    { from: { kind: 'ready' }, event: { type: 'PlanDecomposed' } },
    { from: { kind: 'ready' }, event: { type: 'PlanDecomposeFailed' } },
  ];

  for (const { from, event } of cases) {
    assert.deepEqual(
      step(from, event),
      from,
      `step(${JSON.stringify(from)}, ${JSON.stringify(event)}) must return identity state`,
    );
  }
});

// ---------------------------------------------------------------------------
// Purity: same (state, event) always returns deep-equal next state, and the
// input state object is never mutated.
// ---------------------------------------------------------------------------

test('step() is pure — same inputs return deep-equal outputs across repeated calls', () => {
  const inputs: ReadonlyArray<{ state: State; event: EventInput }> = [
    { state: { kind: 'brief' }, event: { type: 'BriefSubmitted' } },
    { state: { kind: 'planning', revision: 5 }, event: { type: 'PlanGenerated' } },
    { state: { kind: 'awaiting-approval', revision: 7 }, event: { type: 'GeneratePlan' } },
    { state: { kind: 'awaiting-approval', revision: 7 }, event: { type: 'DecomposePlan' } },
    { state: { kind: 'decomposing', revision: 9 }, event: { type: 'PlanDecomposed' } },
    { state: { kind: 'decomposing', revision: 9 }, event: { type: 'PlanDecomposeFailed' } },
  ];

  for (const { state, event } of inputs) {
    const first = step(state, event);
    const second = step(state, event);
    const third = step(state, event);
    assert.deepEqual(first, second);
    assert.deepEqual(second, third);
  }
});

test('step() does not mutate the input state', () => {
  const before: State = { kind: 'awaiting-approval', revision: 3 };
  const snapshot = JSON.parse(JSON.stringify(before)) as State;
  step(before, { type: 'GeneratePlan' });
  step(before, { type: 'DecomposePlan' });
  assert.deepEqual(before, snapshot);
});

// ---------------------------------------------------------------------------
// initialState is the documented entry point and matches the `brief` shape.
// ---------------------------------------------------------------------------

test('initialState equals { kind: "brief" }', () => {
  assert.deepEqual(initialState, { kind: 'brief' });
});
