import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CycleDetectedError,
  eligibleTasks,
  snapshotFromStore,
  type TaskGraphSnapshot,
} from './scheduler';
import type {
  SchedulableTask,
  TaskDepStatus,
  TaskDependency,
  TaskDependencyStore,
} from '../ports/TaskDependencyStore';

function snap(
  tasks: SchedulableTask[],
  deps: TaskDependency[] = [],
): TaskGraphSnapshot {
  return { tasks, dependencies: deps };
}

test('a lone unparked task with no deps is eligible', () => {
  const result = eligibleTasks(snap([{ id: 't1', parkedReason: null }]));
  assert.deepEqual(result, ['t1']);
});

test('a task with all deps merged is eligible', () => {
  const result = eligibleTasks(
    snap(
      [
        { id: 't1', parkedReason: null },
        { id: 't2', parkedReason: null },
      ],
      [{ taskId: 't2', dependsOnTaskId: 't1', status: 'merged' }],
    ),
  );
  assert.deepEqual(result.sort(), ['t1', 't2']);
});

test('a task with one pending dep is gated out', () => {
  const result = eligibleTasks(
    snap(
      [
        { id: 't1', parkedReason: null },
        { id: 't2', parkedReason: null },
      ],
      [{ taskId: 't2', dependsOnTaskId: 't1', status: 'pending' }],
    ),
  );
  assert.deepEqual(result, ['t1']);
});

test('a task with mixed merged+pending deps is gated out', () => {
  const result = eligibleTasks(
    snap(
      [
        { id: 'a', parkedReason: null },
        { id: 'b', parkedReason: null },
        { id: 'c', parkedReason: null },
      ],
      [
        { taskId: 'c', dependsOnTaskId: 'a', status: 'merged' },
        { taskId: 'c', dependsOnTaskId: 'b', status: 'pending' },
      ],
    ),
  );
  assert.deepEqual(result.sort(), ['a', 'b']);
});

test('a parked task is excluded even when all deps are merged', () => {
  const result = eligibleTasks(
    snap(
      [
        { id: 't1', parkedReason: null },
        { id: 't2', parkedReason: 'wait-action' },
      ],
      [{ taskId: 't2', dependsOnTaskId: 't1', status: 'merged' }],
    ),
  );
  assert.deepEqual(result, ['t1']);
});

test('parked_reason of empty string is treated as not parked', () => {
  // Defensive: some adapters may normalise NULL → '' on read. eligibleTasks
  // must not treat that as parked, otherwise a working task disappears.
  const result = eligibleTasks(snap([{ id: 't1', parkedReason: '' }]));
  assert.deepEqual(result, ['t1']);
});

test('multi-hop chain: only the head is eligible until edges flip to merged', () => {
  const tasks: SchedulableTask[] = [
    { id: 'a', parkedReason: null },
    { id: 'b', parkedReason: null },
    { id: 'c', parkedReason: null },
  ];

  const initial: TaskDependency[] = [
    { taskId: 'b', dependsOnTaskId: 'a', status: 'pending' },
    { taskId: 'c', dependsOnTaskId: 'b', status: 'pending' },
  ];
  assert.deepEqual(eligibleTasks(snap(tasks, initial)).sort(), ['a']);

  const afterAMerged: TaskDependency[] = [
    { taskId: 'b', dependsOnTaskId: 'a', status: 'merged' },
    { taskId: 'c', dependsOnTaskId: 'b', status: 'pending' },
  ];
  assert.deepEqual(eligibleTasks(snap(tasks, afterAMerged)).sort(), ['a', 'b']);

  const afterBMerged: TaskDependency[] = [
    { taskId: 'b', dependsOnTaskId: 'a', status: 'merged' },
    { taskId: 'c', dependsOnTaskId: 'b', status: 'merged' },
  ];
  assert.deepEqual(eligibleTasks(snap(tasks, afterBMerged)).sort(), [
    'a',
    'b',
    'c',
  ]);
});

test('multi-hop chain with the middle node parked stalls downstream', () => {
  // a -> b -> c, with b parked. Even after a merges into b, b stays
  // parked, so b is excluded; and because the b->c edge is still pending,
  // c is also gated out. Only a survives.
  const tasks: SchedulableTask[] = [
    { id: 'a', parkedReason: null },
    { id: 'b', parkedReason: 'wait-action' },
    { id: 'c', parkedReason: null },
  ];
  const deps: TaskDependency[] = [
    { taskId: 'b', dependsOnTaskId: 'a', status: 'merged' },
    { taskId: 'c', dependsOnTaskId: 'b', status: 'pending' },
  ];
  assert.deepEqual(eligibleTasks(snap(tasks, deps)), ['a']);
});

test('cycle in the dep graph throws CycleDetectedError', () => {
  const tasks: SchedulableTask[] = [
    { id: 'a', parkedReason: null },
    { id: 'b', parkedReason: null },
    { id: 'c', parkedReason: null },
  ];
  const deps: TaskDependency[] = [
    { taskId: 'a', dependsOnTaskId: 'b', status: 'pending' },
    { taskId: 'b', dependsOnTaskId: 'c', status: 'pending' },
    { taskId: 'c', dependsOnTaskId: 'a', status: 'pending' },
  ];
  let caught: unknown;
  try {
    eligibleTasks(snap(tasks, deps));
  } catch (err) {
    caught = err;
  }
  assert.ok(
    caught instanceof CycleDetectedError,
    `expected CycleDetectedError, got ${(caught as Error | undefined)?.constructor.name}`,
  );
  const cycle = (caught as CycleDetectedError).cycle;
  // The reported cycle starts and ends at the same node.
  assert.equal(cycle[0], cycle[cycle.length - 1]);
  // It contains every node on the cycle.
  for (const id of ['a', 'b', 'c']) {
    assert.ok(cycle.includes(id), `cycle should include ${id}, got ${cycle.join(',')}`);
  }
});

test('self-dependency is detected as a cycle', () => {
  const tasks: SchedulableTask[] = [{ id: 'a', parkedReason: null }];
  const deps: TaskDependency[] = [
    { taskId: 'a', dependsOnTaskId: 'a', status: 'pending' },
  ];
  assert.throws(
    () => eligibleTasks(snap(tasks, deps)),
    (err: unknown) => err instanceof CycleDetectedError,
  );
});

test('cycle detection does not false-positive on a diamond DAG', () => {
  // a -> b, a -> c, b -> d, c -> d. Two paths to d, but no cycle.
  const tasks: SchedulableTask[] = [
    { id: 'a', parkedReason: null },
    { id: 'b', parkedReason: null },
    { id: 'c', parkedReason: null },
    { id: 'd', parkedReason: null },
  ];
  const deps: TaskDependency[] = [
    { taskId: 'b', dependsOnTaskId: 'a', status: 'merged' },
    { taskId: 'c', dependsOnTaskId: 'a', status: 'merged' },
    { taskId: 'd', dependsOnTaskId: 'b', status: 'merged' },
    { taskId: 'd', dependsOnTaskId: 'c', status: 'merged' },
  ];
  assert.doesNotThrow(() => eligibleTasks(snap(tasks, deps)));
  assert.deepEqual(eligibleTasks(snap(tasks, deps)).sort(), ['a', 'b', 'c', 'd']);
});

test('scheduler does not special-case bump-package-reference task ids', () => {
  // v2 cut list excludes bump-package-reference. The scheduler must not
  // look at task type at all — a task whose id literally contains the
  // string is treated like any other.
  const tasks: SchedulableTask[] = [
    { id: 'bump-package-reference-1', parkedReason: 'wait-action' },
    { id: 'bump-package-reference-2', parkedReason: null },
    { id: 'normal', parkedReason: null },
  ];
  const result = eligibleTasks(snap(tasks));
  assert.deepEqual(result.sort(), ['bump-package-reference-2', 'normal']);
});

test('snapshotFromStore composes a snapshot the scheduler accepts', () => {
  const store: TaskDependencyStore = {
    addDependency: () => {
      throw new Error('not used');
    },
    setDependencyStatus: () => {
      throw new Error('not used');
    },
    listDependencies: () => [
      { taskId: 'b', dependsOnTaskId: 'a', status: 'merged' as TaskDepStatus },
    ],
    listSchedulableTasks: () => [
      { id: 'a', parkedReason: null },
      { id: 'b', parkedReason: null },
    ],
    parkTask: () => {
      throw new Error('not used');
    },
    unparkTask: () => {
      throw new Error('not used');
    },
  };
  const snapshot = snapshotFromStore(store);
  assert.deepEqual(eligibleTasks(snapshot).sort(), ['a', 'b']);
});
