/**
 * Dual-runner discovery (see `adapters/git/worktree-gc-job.test.ts`):
 *
 * - `npm test` runs `node --test --import tsx`, i.e. Node's `node:test`.
 * - The review pipeline runs `npx vitest run` on changed test files.
 *
 * A static `import { test } from 'vitest'` breaks the first of those, and
 * that is exactly what this file used to carry — so it never ran under
 * `npm test` at all, and `npx tsx --test` on it died on the import. The
 * shim routes to `globalThis.test` under vitest (`vitest.config.ts` sets
 * `globals: true`) and to `node:test` everywhere else.
 */
type TestFn = (name: string, fn: () => void | Promise<void>) => void;

const test: TestFn = (((): TestFn => {
    if (process.env.VITEST) {
        const gt = (globalThis as { test?: TestFn }).test;
        if (typeof gt !== 'function') {
            throw new Error(
                'index.test.ts: VITEST=true but globalThis.test is missing — '
                    + 'ensure vitest.config.ts sets test.globals = true',
            );
        }
        return gt;
    }
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    const nt = require('node:test') as { test: TestFn };
    return nt.test;
})());

type DescribeFn = (name: string, fn: () => void) => void;

const describe: DescribeFn = (((): DescribeFn => {
    if (process.env.VITEST) {
        const gd = (globalThis as { describe?: DescribeFn }).describe;
        if (typeof gd === 'function') return gd;
    }
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    const nt = require('node:test') as { describe: DescribeFn };
    return nt.describe;
})());
import * as assert from 'node:assert/strict';

import {
    PlanOpsCommands,
    ProjectOpsCommands,
    TaskOpsCommands,
    isApprovalOverride,
    isArchivePlanPayload,
    isDeletePlanPayload,
    isRetryTaskPayload,
    isSkipTaskPayload,
    isUpdateProjectApprovalOverridePayload,
    type ApprovalOverride,
    type ArchivePlanPayload,
    type DeletePlanPayload,
    type RetryTaskPayload,
    type SkipTaskPayload,
    type UpdateProjectApprovalOverridePayload,
} from './index';

describe('command-symbol identifiers', () => {
    test('TaskOpsCommands declares the SkipTask + RetryTask wire symbols', () => {
        assert.strictEqual(TaskOpsCommands.SKIP_TASK, 'SkipTask');
        assert.strictEqual(TaskOpsCommands.RETRY_TASK, 'RetryTask');
    });

    test('PlanOpsCommands declares the ArchivePlan + DeletePlan wire symbols', () => {
        assert.strictEqual(PlanOpsCommands.ARCHIVE_PLAN, 'ArchivePlan');
        assert.strictEqual(PlanOpsCommands.DELETE_PLAN, 'DeletePlan');
    });

    test('ProjectOpsCommands declares the UpdateProjectApprovalOverride wire symbol', () => {
        assert.strictEqual(
            ProjectOpsCommands.UPDATE_PROJECT_APPROVAL_OVERRIDE,
            'UpdateProjectApprovalOverride',
        );
    });
});

describe('task-op payloads — { taskId }', () => {
    test('isSkipTaskPayload accepts { taskId: non-empty string }', () => {
        const p: SkipTaskPayload = { taskId: 't-1' };
        assert.strictEqual(isSkipTaskPayload(p), true);
    });

    test('isSkipTaskPayload rejects missing/empty/wrong-typed taskId and non-objects', () => {
        assert.strictEqual(isSkipTaskPayload({}), false);
        assert.strictEqual(isSkipTaskPayload({ taskId: '' }), false);
        assert.strictEqual(isSkipTaskPayload({ taskId: 7 }), false);
        assert.strictEqual(isSkipTaskPayload(null), false);
        assert.strictEqual(isSkipTaskPayload(undefined), false);
        assert.strictEqual(isSkipTaskPayload('t-1'), false);
    });

    test('isRetryTaskPayload accepts { taskId: non-empty string }', () => {
        const p: RetryTaskPayload = { taskId: 't-9' };
        assert.strictEqual(isRetryTaskPayload(p), true);
    });

    test('isRetryTaskPayload rejects missing/empty/wrong-typed taskId and non-objects', () => {
        assert.strictEqual(isRetryTaskPayload({}), false);
        assert.strictEqual(isRetryTaskPayload({ taskId: '' }), false);
        assert.strictEqual(isRetryTaskPayload({ taskId: 0 }), false);
        assert.strictEqual(isRetryTaskPayload(null), false);
    });
});

describe('plan-op payloads — { planId }', () => {
    test('isArchivePlanPayload accepts { planId: non-empty string }', () => {
        const p: ArchivePlanPayload = { planId: 'plan-1' };
        assert.strictEqual(isArchivePlanPayload(p), true);
    });

    test('isArchivePlanPayload rejects missing/empty/wrong-typed planId and non-objects', () => {
        assert.strictEqual(isArchivePlanPayload({}), false);
        assert.strictEqual(isArchivePlanPayload({ planId: '' }), false);
        assert.strictEqual(isArchivePlanPayload({ planId: 42 }), false);
        assert.strictEqual(isArchivePlanPayload(null), false);
    });

    test('isDeletePlanPayload accepts { planId: non-empty string }', () => {
        const p: DeletePlanPayload = { planId: 'plan-2' };
        assert.strictEqual(isDeletePlanPayload(p), true);
    });

    test('isDeletePlanPayload rejects missing/empty/wrong-typed planId and non-objects', () => {
        assert.strictEqual(isDeletePlanPayload({}), false);
        assert.strictEqual(isDeletePlanPayload({ planId: '' }), false);
        assert.strictEqual(isDeletePlanPayload({ planId: ['x'] }), false);
        assert.strictEqual(isDeletePlanPayload(undefined), false);
    });
});

describe('approval-override shape — keyed { flowName: { stepId: tri-state } }', () => {
    test('isApprovalOverride accepts empty map', () => {
        assert.strictEqual(isApprovalOverride({}), true);
    });

    test('isApprovalOverride accepts a fully-typed nested override', () => {
        const override: ApprovalOverride = {
            'review-flow': { 'approve-plan': 'auto', 'commit-gate': 'required' },
            'deploy-flow': { 'wait-deploy': 'default' },
        };
        assert.strictEqual(isApprovalOverride(override), true);
    });

    test('isApprovalOverride rejects unknown leaf values', () => {
        assert.strictEqual(isApprovalOverride({ flow: { step: 'maybe' } }), false);
    });

    test('isApprovalOverride rejects non-string leaf values', () => {
        assert.strictEqual(isApprovalOverride({ flow: { step: 1 } }), false);
        assert.strictEqual(isApprovalOverride({ flow: { step: null } }), false);
        assert.strictEqual(isApprovalOverride({ flow: { step: undefined } }), false);
    });

    test('isApprovalOverride rejects non-object inner maps', () => {
        assert.strictEqual(isApprovalOverride({ flow: 'auto' }), false);
        assert.strictEqual(isApprovalOverride({ flow: null }), false);
        assert.strictEqual(isApprovalOverride({ flow: ['auto'] }), false);
    });

    test('isApprovalOverride rejects arrays and non-objects at the top level', () => {
        assert.strictEqual(isApprovalOverride([]), false);
        assert.strictEqual(isApprovalOverride(null), false);
        assert.strictEqual(isApprovalOverride('auto'), false);
    });
});

describe('UpdateProjectApprovalOverride payload', () => {
    test('isUpdateProjectApprovalOverridePayload accepts projectId + valid override', () => {
        const p: UpdateProjectApprovalOverridePayload = {
            projectId: 'proj-A',
            approvalOverride: {
                'review-flow': { 'approve-plan': 'auto' },
            },
        };
        assert.strictEqual(isUpdateProjectApprovalOverridePayload(p), true);
    });

    test('isUpdateProjectApprovalOverridePayload accepts an empty override map', () => {
        assert.strictEqual(
            isUpdateProjectApprovalOverridePayload({
                projectId: 'proj-A',
                approvalOverride: {},
            }),
            true,
        );
    });

    test('isUpdateProjectApprovalOverridePayload rejects missing/empty projectId', () => {
        assert.strictEqual(
            isUpdateProjectApprovalOverridePayload({ approvalOverride: {} }),
            false,
        );
        assert.strictEqual(
            isUpdateProjectApprovalOverridePayload({
                projectId: '',
                approvalOverride: {},
            }),
            false,
        );
        assert.strictEqual(
            isUpdateProjectApprovalOverridePayload({
                projectId: 9,
                approvalOverride: {},
            }),
            false,
        );
    });

    test('isUpdateProjectApprovalOverridePayload rejects a malformed approvalOverride', () => {
        assert.strictEqual(
            isUpdateProjectApprovalOverridePayload({
                projectId: 'proj-A',
                approvalOverride: { flow: { step: 'bogus' } },
            }),
            false,
        );
        assert.strictEqual(
            isUpdateProjectApprovalOverridePayload({
                projectId: 'proj-A',
                approvalOverride: null,
            }),
            false,
        );
    });

    test('isUpdateProjectApprovalOverridePayload rejects non-objects', () => {
        assert.strictEqual(isUpdateProjectApprovalOverridePayload(null), false);
        assert.strictEqual(isUpdateProjectApprovalOverridePayload('proj-A'), false);
    });
});

describe('structural type checks', () => {
    test('payload interfaces compile to the documented shapes', () => {
        // These assignments fail to compile if the interface shapes drift from
        // the AP-PAO-001 brief — that is the contract this test is asserting.
        const skip: SkipTaskPayload = { taskId: 't' };
        const retry: RetryTaskPayload = { taskId: 't' };
        const archive: ArchivePlanPayload = { planId: 'p' };
        const del: DeletePlanPayload = { planId: 'p' };
        const upd: UpdateProjectApprovalOverridePayload = {
            projectId: 'proj-A',
            approvalOverride: {
                f: { s: 'auto' },
                g: { s: 'required' },
                h: { s: 'default' },
            },
        };
        assert.ok(skip.taskId);
        assert.ok(retry.taskId);
        assert.ok(archive.planId);
        assert.ok(del.planId);
        assert.ok(upd.projectId);
        assert.strictEqual(upd.approvalOverride['f']['s'], 'auto');
    });
});
