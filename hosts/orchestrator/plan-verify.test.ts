/**
 * Option C — plan-level verify gate appended after decompose.
 *
 *   1. A code-writing decomposition gains ONE `verify-plan` task that
 *      depends on EVERY other task, with the union of touched files in
 *      its description.
 *   2. Non-code plans (document / investigate / review) get no gate.
 *   3. A decomposer-emitted `verify-plan` task suppresses the append
 *      (no duplicate gates).
 *   4. Empty task lists stay empty.
 *   5. The raw id carries no trailing digits, so the rename pass slots
 *      the gate in as the plan's next positional sequence number.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import * as path from 'node:path';

import { loadLayeredFlows } from '../../core/flow/loader';
import { TaskTypeCatalog } from '../../core/flow/task-types';
import { appendPlanVerifyTask as append } from './handlers';

const REPO = path.resolve(__dirname, '..', '..');
/** The code-writing set as the orchestrator derives it (`task_type.writes_code`). */
const CODE_WRITING = TaskTypeCatalog.fromFlows(loadLayeredFlows([
    path.join(REPO, 'config', 'flows'),
    path.join(REPO, 'packs', 'dotnet-azure', 'flows'),
])).writesCode();

function appendPlanVerifyTask<T extends { id: string; type: string; title: string; dependencies: readonly string[] }>(
    tasks: ReadonlyArray<T>,
): ReturnType<typeof append<T>> {
    return append(tasks, CODE_WRITING);
}

interface FlatTask {
    readonly id: string;
    readonly title: string;
    readonly type: string;
    readonly description: string;
    readonly dependencies: readonly string[];
    readonly filesToModify?: readonly string[];
    readonly filesToCreate?: readonly string[];
}

function task(id: string, type: string, files?: readonly string[]): FlatTask {
    return {
        id,
        title: `Task ${id}`,
        type,
        description: 'body',
        dependencies: [],
        ...(files ? { filesToModify: files } : {}),
    };
}

test('code-writing plan gains a verify-plan task depending on all others', () => {
    const out = appendPlanVerifyTask([
        task('task-001', 'implement', ['src/A.cs']),
        task('task-002', 'refactor', ['src/B.cs']),
        task('task-003', 'document'),
    ]);
    assert.equal(out.length, 4);
    const verify = out[3]!;
    assert.equal(verify.type, 'verify-plan');
    assert.equal(verify.id, 'task-plan-verify');
    assert.ok(!/\d$/.test(verify.id), 'no trailing digits — rename uses position');
    assert.deepEqual(verify.dependencies, ['task-001', 'task-002', 'task-003']);
    const desc = (verify as { description: string }).description;
    assert.ok(desc.includes('src/A.cs'));
    assert.ok(desc.includes('src/B.cs'));
    assert.ok(desc.includes('Do NOT write or modify code'));
});

test('non-code plans get no verify gate', () => {
    const out = appendPlanVerifyTask([
        task('task-001', 'document'),
        task('task-002', 'investigate'),
        task('task-003', 'review-codebase'),
    ]);
    assert.equal(out.length, 3);
    assert.ok(!out.some((t) => t.type === 'verify-plan'));
});

test('a decomposer-emitted verify-plan suppresses the append', () => {
    const out = appendPlanVerifyTask([
        task('task-001', 'implement', ['src/A.cs']),
        task('task-002', 'verify-plan'),
    ]);
    assert.equal(out.length, 2);
});

test('empty decomposition stays empty', () => {
    assert.deepEqual(appendPlanVerifyTask([]), []);
});

test('gate carries ticket fields (goal + acceptance criteria)', () => {
    const out = appendPlanVerifyTask([task('task-001', 'implement', ['src/A.cs'])]);
    const verify = out[1] as {
        goal?: string;
        acceptanceCriteria?: readonly string[];
    };
    assert.ok(typeof verify.goal === 'string' && verify.goal.length > 0);
    assert.ok(Array.isArray(verify.acceptanceCriteria) && verify.acceptanceCriteria.length >= 2);
});
