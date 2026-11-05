/**
 * Task-type facts live on the flows (`task_type:`) and everything else is
 * derived — the decomposer's allowed set, the code-writing set, the shared
 * deploy worktree set, the board's Add-task menu. These tests pin both
 * halves: the loader refuses a declaration it cannot trust, and the
 * catalog reproduces exactly what the hand-maintained lists used to say.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { loadFlow, loadLayeredFlows } from './loader';
import { TaskTypeCatalog } from './task-types';

const REPO = path.resolve(__dirname, '..', '..');
const CORE = path.join(REPO, 'config', 'flows');
const PACK = path.join(REPO, 'packs', 'dotnet-azure', 'flows');

function flowWith(taskType: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-type-'));
    const file = path.join(dir, 'x.yaml');
    fs.writeFileSync(file, [
        'on: TaskApproved',
        'start_mode: auto',
        taskType,
        'steps:',
        '  - id: work',
        '    agent: developer',
        '    model: none',
        '    on_success: emit:TaskFinished',
        '',
    ].join('\n'));
    return file;
}

// ---------------------------------------------------------------------------
// loader
// ---------------------------------------------------------------------------

test('a task_type block loads with defaults for what it omits', () => {
    const flow = loadFlow(flowWith('task_type:\n  decomposable: true'));
    assert.deepEqual(flow.task_type, {
        decomposable: true, writes_code: false, worktree: 'task', add_task: false,
        produces_report: false, chat_proposable: false, synonyms: [],
    });
});

test('a misspelt task_type key is refused — it would read as "false" and silently drop the type', () => {
    assert.throws(() => loadFlow(flowWith('task_type:\n  writes-code: true')), /unknown field "task_type.writes-code"/);
});

test('task_type values are type-checked', () => {
    assert.throws(() => loadFlow(flowWith('task_type:\n  decomposable: "yes"')), /must be true or false/);
    assert.throws(() => loadFlow(flowWith('task_type:\n  worktree: shared')), /"task", "shared-deploy" or "workspace-root"/);
    assert.throws(() => loadFlow(flowWith('task_type:\n  label: ""')), /non-empty string/);
});

test('a flow without task_type is not a task type', () => {
    const catalog = TaskTypeCatalog.fromFlows(loadLayeredFlows([CORE]));
    assert.equal(catalog.get('merge'), undefined, 'sub-flows never appear as types');
});

// ---------------------------------------------------------------------------
// catalog = the old lists, exactly
// ---------------------------------------------------------------------------

const ALL = TaskTypeCatalog.fromFlows(loadLayeredFlows([CORE, PACK]));

test('decomposable = the old ALLOWED_TASK_TYPES', () => {
    assert.deepEqual([...ALL.decomposable()].sort(), [
        'bump-package-reference', 'deploy-azure', 'deploy-nuget', 'deploy-verify', 'document',
        'implement', 'integration-test', 'investigate', 'refactor', 'review-azure',
        'review-codebase', 'scaffold', 'scaffold-repo', 'swagger', 'update-project-context',
    ]);
});

test('writes-code = the old CODE_WRITING_TASK_TYPES', () => {
    assert.deepEqual([...ALL.writesCode()].sort(), [
        'bump-package-reference', 'implement', 'integration-test', 'refactor', 'scaffold',
        'scaffold-repo', 'swagger',
    ]);
});

test('shared-deploy worktree = the old SHARED_DEPLOY_WORKTREE_TASK_TYPES', () => {
    assert.deepEqual([...ALL.sharedDeployWorktree()].sort(), ['deploy-azure', 'deploy-verify']);
});

test('workspace-root worktree = the old hardcoded diagnose-azure branch', () => {
    // main.ts used to name the type outright: `if (row.type ===
    // 'diagnose-azure') return { repoPath: DEFAULT_REPOS_ROOT }`. Core
    // cannot know a pack's type ids, so the flow declares where it runs.
    assert.deepEqual([...ALL.workspaceRootWorktree()].sort(), ['diagnose-azure']);
    const core = TaskTypeCatalog.fromFlows(loadLayeredFlows([CORE]));
    assert.equal(core.workspaceRootWorktree().size, 0, 'no core type runs repo-less');
});

test('produces-report = the old REPORT_TASK_TYPES', () => {
    // The board's View-report gate was a hardcoded set that named two pack
    // types (review-azure, diagnose-azure) inside core.
    assert.deepEqual([...ALL.producesReport()].sort(), [
        'code-review', 'diagnose-azure', 'investigate', 'review-azure', 'review-codebase',
    ]);
    const core = TaskTypeCatalog.fromFlows(loadLayeredFlows([CORE]));
    assert.deepEqual([...core.producesReport()].sort(), [
        'code-review', 'investigate', 'review-codebase',
    ]);
});

test('the Add-task menu offers the same 15 types, code-changing work first', () => {
    const opts = ALL.addTaskOptions();
    assert.equal(opts.length, 15);
    assert.deepEqual(new Set(opts.map((o) => o.id)), new Set([
        'implement', 'refactor', 'integration-test', 'test-only', 'verify-plan', 'document',
        'investigate', 'swagger', 'bump-package-reference', 'deploy-nuget', 'deploy-azure',
        'deploy-verify', 'review-codebase', 'review-azure', 'diagnose-azure',
    ]));
    const firstNonCode = opts.findIndex((o) => !ALL.get(o.id)?.writesCode);
    assert.ok(opts.slice(firstNonCode).every((o) => !ALL.get(o.id)?.writesCode), 'code-changing types come first');
    assert.equal(ALL.get('implement')?.label, 'Implement (develop → review → test → commit)');
});

test('core alone offers no stack types', () => {
    const core = TaskTypeCatalog.fromFlows(loadLayeredFlows([CORE]));
    for (const stack of ['deploy-nuget', 'deploy-azure', 'deploy-verify', 'bump-package-reference', 'review-azure', 'diagnose-azure']) {
        assert.equal(core.get(stack), undefined, `${stack} must come from the pack`);
    }
    assert.ok(core.decomposable().has('implement'));
});

// The endpoint half of this contract lives in
// hosts/worker-api/routes/task-types.test.ts: asserting it from here meant
// `core/` importing from `hosts/`, the one direction the architecture
// forbids (and `import/no-restricted-paths` rejects).
