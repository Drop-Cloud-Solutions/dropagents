/**
 * View-report availability.
 *
 *   1. Only report-producing task types qualify — a code task never
 *      shows View report, even though its `review` step has a summary
 *      (the old lookup matched that step id role-agnostically).
 *   2. A report-producing type with nothing recorded does NOT qualify:
 *      the button used to open a "no report recorded" placeholder.
 *   3. Projection report (InvestigationCompleted) or a recorded report
 *      step both qualify; the newest non-empty summary wins.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import {
    REPORT_TASK_TYPES,
    hasReadableReport,
    pickReportStep,
    setReportTaskTypes,
    taskTypeProducesReport,
} from './report-availability';

test('core report types qualify before hydration lands', () => {
    // The set seeds with core's own types so the button is right on first
    // paint; GET /api/task-types then replaces it. Core no longer names
    // any pack's types — that is the whole point of the split.
    for (const t of ['investigate', 'review-codebase', 'code-review']) {
        assert.equal(taskTypeProducesReport(t), true, `${t} produces a report`);
    }
    for (const t of ['implement', 'refactor', 'document', 'deploy-azure', 'test-only', 'echo', '', null]) {
        assert.equal(taskTypeProducesReport(t), false, `${String(t)} must not`);
    }
});

test("hydration adds the enabled packs' report types", () => {
    const original = [...REPORT_TASK_TYPES];
    try {
        setReportTaskTypes([...original, 'review-azure', 'diagnose-azure']);
        assert.equal(taskTypeProducesReport('diagnose-azure'), true);
        assert.equal(taskTypeProducesReport('review-azure'), true);
        assert.equal(taskTypeProducesReport('implement'), false, 'hydration does not widen to code types');
    } finally {
        setReportTaskTypes(original);
    }
});

test('an empty or unusable payload never blanks the gate', () => {
    // A failed /api/task-types must not silently switch every View-report
    // button off — losing an affordance without a word is the failure mode
    // this module exists to prevent.
    const before = [...REPORT_TASK_TYPES].sort();
    setReportTaskTypes([]);
    assert.deepEqual([...REPORT_TASK_TYPES].sort(), before);
    setReportTaskTypes(['', '   '.trim()]);
    assert.deepEqual([...REPORT_TASK_TYPES].sort(), before);
});

test("a code task's reviewer summary is NOT a report", () => {
    // The regression this guards: an implement flow has a step literally
    // named `review` run by the reviewer, and the old role-agnostic
    // step-id match surfaced it as an investigation report — Implement
    // would then act on a reviewer's notes.
    const steps = [
        { stepId: 'develop', role: 'developer', summary: 'wrote code', finishedAt: 1 },
        { stepId: 'review', role: 'reviewer', summary: 'APPROVED — looks good', finishedAt: 2 },
    ];
    assert.equal(
        hasReadableReport({ type: 'implement', hasProjectionReport: false, steps }),
        false,
    );
});

test('a report-producing type with nothing recorded does not qualify', () => {
    assert.equal(
        hasReadableReport({ type: 'investigate', hasProjectionReport: false, steps: [] }),
        false,
    );
    assert.equal(
        hasReadableReport({ type: 'diagnose-azure', hasProjectionReport: false, steps: undefined }),
        false,
    );
    // A recorded step with an EMPTY summary is still nothing to read.
    assert.equal(
        hasReadableReport({
            type: 'investigate',
            hasProjectionReport: false,
            steps: [{ stepId: 'investigator', role: 'investigator', summary: '', finishedAt: 3 }],
        }),
        false,
    );
});

test('projection report or a recorded report step qualifies', () => {
    assert.equal(
        hasReadableReport({ type: 'investigate', hasProjectionReport: true, steps: [] }),
        true,
        'InvestigationCompleted alone is enough',
    );
    // A pack's report types reach the board by hydration, so set them the
    // way the board would before asserting on them.
    const original = [...REPORT_TASK_TYPES];
    try {
        setReportTaskTypes([...original, 'review-azure', 'diagnose-azure']);
        assert.equal(
            hasReadableReport({
                type: 'diagnose-azure',
                hasProjectionReport: false,
                steps: [{ stepId: 'diagnose', role: 'azure-diagnostician', summary: '# Diagnosis', finishedAt: 5 }],
            }),
            true,
            'the STEP ID carries it — core needs no pack role name',
        );
        assert.equal(
            hasReadableReport({
                type: 'review-azure',
                hasProjectionReport: false,
                steps: [{ stepId: 'review', role: 'azure-reviewer', summary: 'findings', finishedAt: 5 }],
            }),
            true,
        );
    } finally {
        setReportTaskTypes(original);
    }
});

test('pickReportStep returns the newest non-empty summary', () => {
    const picked = pickReportStep([
        { stepId: 'investigator', role: 'investigator', summary: 'old', finishedAt: 1 },
        { stepId: 'investigator', role: 'investigator', summary: 'newest', finishedAt: 9 },
        { stepId: 'investigator', role: 'investigator', summary: '', finishedAt: 99 },
    ]);
    assert.equal(picked?.summary, 'newest');
});
