import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { computeFileOverlapDependencies } from './handlers';

function task(id: string, create: string[] = [], modify: string[] = []): Record<string, unknown> {
    return {
        id,
        context: { files_to_create: create, files_to_modify: modify },
    };
}

test('a later task that modifies the same file depends on the earlier one', () => {
    const deps = computeFileOverlapDependencies([
        task('task-001', [], ['src/Foo.cs', 'test/FooTests.cs']),
        task('task-002', [], ['test/FooTests.cs']),
    ]);
    assert.deepEqual(deps.get('task-002'), ['task-001']);
    assert.equal(deps.has('task-001'), false);
});

test('create vs modify of the same file counts as an overlap', () => {
    const deps = computeFileOverlapDependencies([
        task('task-001', ['src/New.cs']),
        task('task-002', [], ['src/New.cs']),
    ]);
    assert.deepEqual(deps.get('task-002'), ['task-001']);
});

test('a task depends on ALL earlier overlapping tasks', () => {
    const deps = computeFileOverlapDependencies([
        task('task-001', [], ['shared/Reg.cs']),
        task('task-002', [], ['shared/Reg.cs']),
        task('task-003', [], ['shared/Reg.cs']),
    ]);
    assert.deepEqual(deps.get('task-002'), ['task-001']);
    assert.deepEqual(deps.get('task-003'), ['task-001', 'task-002']);
});

test('no overlap → no dependency', () => {
    const deps = computeFileOverlapDependencies([
        task('task-001', [], ['a.cs']),
        task('task-002', [], ['b.cs']),
    ]);
    assert.equal(deps.size, 0);
});

test('path normalisation: case + slashes + leading ./', () => {
    const deps = computeFileOverlapDependencies([
        task('task-001', [], ['Src\\Foo.cs']),
        task('task-002', [], ['./src/foo.cs']),
    ]);
    assert.deepEqual(deps.get('task-002'), ['task-001']);
});

test('tasks with no declared files produce no edges', () => {
    const deps = computeFileOverlapDependencies([
        { id: 'task-001', context: {} },
        { id: 'task-002', context: {} },
    ]);
    assert.equal(deps.size, 0);
});

test('edges only point backward — the result is acyclic', () => {
    // Even with a tangle of shared files, every edge goes to a
    // lower index, so there can be no cycle.
    const deps = computeFileOverlapDependencies([
        task('task-001', [], ['x', 'y']),
        task('task-002', [], ['y', 'z']),
        task('task-003', [], ['z', 'x']),
    ]);
    // 002 overlaps 001 on y; 003 overlaps 001 on x and 002 on z.
    assert.deepEqual(deps.get('task-002'), ['task-001']);
    assert.deepEqual(deps.get('task-003'), ['task-001', 'task-002']);
    // No task depends on a later one.
    for (const [taskId, upstreams] of deps) {
        const n = Number(taskId.split('-')[1]);
        for (const up of upstreams) {
            assert.ok(Number(up.split('-')[1]) < n, `${taskId} -> ${up} must point backward`);
        }
    }
});

/**
 * Field report: "the changes to CLAUDE.md are not taken into consideration
 * when creating the tasks and the dependencies, causing a lot of merge
 * conflicts."
 *
 * Developer rule 7 tells EVERY agent to keep the repo's CLAUDE.md current
 * — a new module, a changed build step, a new framework — so several
 * tasks in one plan edit the same few sections. The decomposer never
 * listed it (it cannot know which agent will decide to), so the overlap
 * scan saw no shared file, left the tasks parallel, and the branches
 * collided at merge.
 */
function claudeMdTask(id: string, modify: string[] = []): Record<string, unknown> {
    return {
        id,
        context: { files_to_modify: modify, updates_claude_md: true },
    };
}

test('two tasks that both update CLAUDE.md are chained', () => {
    const deps = computeFileOverlapDependencies([
        claudeMdTask('task-001', ['src/A.cs']),
        claudeMdTask('task-002', ['src/B.cs']),
    ]);

    // Different source files, so nothing else would have linked them.
    assert.deepEqual(deps.get('task-002'), ['task-001']);
});

test('tasks that do NOT touch CLAUDE.md keep running in parallel', () => {
    // The cost of getting this wrong is the whole plan serialised, so the
    // flag has to mean something.
    const deps = computeFileOverlapDependencies([
        task('task-001', [], ['src/A.cs']),
        task('task-002', [], ['src/B.cs']),
    ]);

    assert.equal(deps.size, 0);
});

test('a flagged task does not chain to an unflagged one', () => {
    const deps = computeFileOverlapDependencies([
        task('task-001', [], ['src/A.cs']),
        claudeMdTask('task-002', ['src/B.cs']),
    ]);

    assert.equal(deps.has('task-002'), false);
});

test('the flag and a literal CLAUDE.md path collapse to the same file', () => {
    // A plan that spells the path out must chain with one that only sets
    // the flag — otherwise the two spellings look like two files.
    const deps = computeFileOverlapDependencies([
        task('task-001', [], ['CLAUDE.md']),
        claudeMdTask('task-002'),
    ]);

    assert.deepEqual(deps.get('task-002'), ['task-001']);
});

test('path spellings of the repo-root CLAUDE.md are one file', () => {
    const deps = computeFileOverlapDependencies([
        task('task-001', [], ['CLAUDE.md']),
        task('task-002', [], ['./CLAUDE.md']),
        task('task-003', [], ['/claude.md']),
    ]);

    assert.deepEqual(deps.get('task-002'), ['task-001']);
    assert.deepEqual(deps.get('task-003'), ['task-001', 'task-002']);
});

test('a NESTED CLAUDE.md is a different file and does not chain', () => {
    // `docs/CLAUDE.md` is genuinely not the repo-root one; collapsing it
    // would serialise tasks that never touch the same bytes.
    const deps = computeFileOverlapDependencies([
        task('task-001', [], ['CLAUDE.md']),
        task('task-002', [], ['docs/CLAUDE.md']),
    ]);

    assert.equal(deps.has('task-002'), false);
});

test('a falsy or absent flag is not treated as set', () => {
    for (const value of [false, undefined, null, 'true', 1]) {
        const deps = computeFileOverlapDependencies([
            { id: 'task-001', context: { updates_claude_md: true } },
            { id: 'task-002', context: { updates_claude_md: value } },
        ]);
        assert.equal(
            deps.has('task-002'),
            false,
            `updates_claude_md=${JSON.stringify(value)} must not chain`,
        );
    }
});
