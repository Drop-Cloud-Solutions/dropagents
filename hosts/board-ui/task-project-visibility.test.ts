/**
 * A live-folded task must be as visible as a hydrated one.
 *
 * Field case (plan-impl-L-WQNA-001-1786960596143): the operator added two
 * tasks from the plan-modal chat. Both were created — Telegram announced
 * each with its id, and `/api/tasks` returns them against the plan — but
 * neither appeared on the board or in the plan modal, so the Add-task
 * click read as a no-op. A hard refresh made them appear.
 *
 * That difference IS the bug. `TaskCreated` carries
 * `{taskId, planId, type, flowId}` and no project, so the live fold
 * produced `projectId: null`. `/api/tasks` derives one via
 * `LEFT JOIN sidebar_plans sp ON sp.plan_id = t.plan_id`. With a project
 * selected in the sidebar, `isVisibleForCurrentProject(null)` is false —
 * an unknown project reads as "not mine" — so the live row was filtered
 * out and the hydrated row was not.
 *
 * Fixed on both sides: `CreateTask` stamps the project, and the board
 * resolves a task's project THROUGH ITS PLAN when the row lacks one. The
 * second is what makes this robust — several other publishers emit
 * TaskCreated, and the plan is the authority regardless.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

/** The board's filter, verbatim. */
function isVisibleForCurrentProject(
    selected: string | null,
    projectId: string | null | undefined,
): boolean {
    if (selected === null || selected === '') return true;
    if (typeof projectId !== 'string' || projectId.length === 0) return false;
    return projectId === selected;
}

/** The board's resolver, verbatim. */
function projectIdForTask(
    plans: Map<string, { projectId: string }>,
    task: { projectId?: string | null; planId?: string | null },
): string | null {
    if (typeof task.projectId === 'string' && task.projectId.length > 0) {
        return task.projectId;
    }
    const planId = task.planId;
    if (typeof planId !== 'string' || planId.length === 0) return null;
    return plans.get(planId)?.projectId ?? null;
}

const PLAN = 'plan-impl-L-WQNA-001-1786960596143';
const plans = new Map([[PLAN, { projectId: 'shop' }]]);

test('a live TaskCreated row resolves its project through the plan', () => {
    // Exactly what the SSE fold produces: no projectId on the payload.
    const live = { taskId: 'L-IFLW-004', planId: PLAN, projectId: null };
    assert.equal(projectIdForTask(plans, live), 'shop');
    assert.equal(
        isVisibleForCurrentProject('shop', projectIdForTask(plans, live)),
        true,
        'the task must be visible without waiting for a reload',
    );
});

test('without the resolver the live row is filtered out — the reported bug', () => {
    // Guards the regression rather than the fix: if someone reverts to
    // passing `t.projectId` straight in, this is what happens.
    const live = { taskId: 'L-IFLW-004', planId: PLAN, projectId: null };
    assert.equal(isVisibleForCurrentProject('shop', live.projectId), false);
});

test('a hydrated row keeps its own project, resolver or not', () => {
    const hydrated = { taskId: 'L-IFLW-004', planId: PLAN, projectId: 'shop' };
    assert.equal(projectIdForTask(plans, hydrated), 'shop');
    assert.equal(
        isVisibleForCurrentProject('shop', projectIdForTask(plans, hydrated)),
        true,
    );
});

test('live and hydrated rows agree — which is the whole point', () => {
    const live = { taskId: 'T', planId: PLAN, projectId: null };
    const hydrated = { taskId: 'T', planId: PLAN, projectId: 'shop' };
    assert.equal(projectIdForTask(plans, live), projectIdForTask(plans, hydrated));
});

test('a task on another project is still filtered out', () => {
    // The filter has to keep working — resolving through the plan must
    // not turn into "show everything".
    const other = { taskId: 'T-1', planId: 'plan-other', projectId: null };
    const withPlans = new Map([...plans, ['plan-other', { projectId: 'workshop' }]]);
    assert.equal(projectIdForTask(withPlans, other), 'workshop');
    assert.equal(
        isVisibleForCurrentProject('shop', projectIdForTask(withPlans, other)),
        false,
    );
});

test('an unknown plan still resolves to null, and "All projects" shows it', () => {
    // A task whose plan has not arrived yet (SSE ordering) stays hidden
    // under a selection — correct, it may belong elsewhere — but must not
    // vanish when no project is selected.
    const orphan = { taskId: 'T-2', planId: 'plan-not-loaded', projectId: null };
    assert.equal(projectIdForTask(plans, orphan), null);
    assert.equal(isVisibleForCurrentProject('shop', projectIdForTask(plans, orphan)), false);
    assert.equal(isVisibleForCurrentProject(null, projectIdForTask(plans, orphan)), true);
});
