import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import {
    HUMAN_LABELS,
    HUMAN_STATUSES,
    V1_CUT_LIST_TASK_TYPES,
    deriveStatusFromIssue,
    humanStatusLabel,
    isCutListIssue,
    type IssueLike,
} from './issue-status';

function issue(
    type: IssueLike['state']['type'],
    labelNames: ReadonlyArray<string>,
): IssueLike {
    return {
        state: { type },
        labels: labelNames.map((name) => ({ name })),
    };
}

// AC #1: vocabulary
test('HUMAN_STATUSES includes ready_for_action and the full v1 set', () => {
    for (const expected of [
        'created',
        'approved',
        'in_progress',
        'review',
        'testing',
        'ready_to_commit',
        'ready_for_action',
        'ready_to_merge',
        'done',
    ]) {
        assert.ok(
            (HUMAN_STATUSES as ReadonlyArray<string>).includes(expected),
            `human_status "${expected}" must be canonical`,
        );
    }
});

test('humanStatusLabel maps ready_for_action to pipeline:human:ready_for_action', () => {
    assert.equal(
        humanStatusLabel('ready_for_action'),
        HUMAN_LABELS.READY_FOR_ACTION,
    );
});

test('humanStatusLabel returns undefined for stage-derived statuses (no human-flag label)', () => {
    assert.equal(humanStatusLabel('in_progress'), undefined);
    assert.equal(humanStatusLabel('review'), undefined);
    assert.equal(humanStatusLabel('ready_to_commit'), undefined);
    assert.equal(humanStatusLabel('ready_to_merge'), undefined);
});

// AC #2 (vocabulary lives in core) is structural — proven by these imports
// resolving from core/projects/issue-status.ts.

test('deriveStatusFromIssue: backlog issue → status=pending, human_status=created', () => {
    const out = deriveStatusFromIssue(issue('backlog', []));
    assert.equal(out.status, 'pending');
    assert.equal(out.human_status, 'created');
    assert.equal(out.failed_stage, undefined);
});

test('deriveStatusFromIssue: unstarted + pipeline:human:approved → approved', () => {
    const out = deriveStatusFromIssue(
        issue('unstarted', [HUMAN_LABELS.APPROVED]),
    );
    assert.equal(out.human_status, 'approved');
});

test('deriveStatusFromIssue: started + pipeline:stage:test → testing', () => {
    const out = deriveStatusFromIssue(
        issue('started', ['pipeline:stage:test']),
    );
    assert.equal(out.status, 'testing');
    assert.equal(out.human_status, 'testing');
});

test('deriveStatusFromIssue: ready_for_action label trumps stage label', () => {
    const out = deriveStatusFromIssue(
        issue('started', [
            'pipeline:stage:dev',
            HUMAN_LABELS.READY_FOR_ACTION,
        ]),
    );
    // status comes from the stage, human_status from the parked flag.
    assert.equal(out.status, 'in_progress');
    assert.equal(out.human_status, 'ready_for_action');
});

test('deriveStatusFromIssue: failed-stage label surfaces failed status + stage', () => {
    const out = deriveStatusFromIssue(
        issue('started', ['pipeline:failed-stage:test', 'pipeline:stage:test']),
    );
    assert.equal(out.status, 'failed');
    assert.equal(out.failed_stage, 'test');
});

test('deriveStatusFromIssue: completed without merged label → ready_to_merge', () => {
    const out = deriveStatusFromIssue(issue('completed', []));
    assert.equal(out.status, 'done');
    assert.equal(out.human_status, 'ready_to_merge');
});

test('deriveStatusFromIssue: completed + merged label → done', () => {
    const out = deriveStatusFromIssue(
        issue('completed', [HUMAN_LABELS.MERGED]),
    );
    assert.equal(out.status, 'done');
    assert.equal(out.human_status, 'done');
});

// AC #6 — cut-list filter
test('isCutListIssue returns true for v1-era task types (swagger / deploy-nuget / bump-package-reference)', () => {
    for (const taskType of V1_CUT_LIST_TASK_TYPES) {
        const i = issue('backlog', [`pipeline:type:${taskType}`]);
        assert.equal(
            isCutListIssue(i),
            true,
            `pipeline:type:${taskType} must be on the cut-list`,
        );
    }
});

test('isCutListIssue returns false for v2 task types', () => {
    for (const taskType of ['scaffold', 'implement', 'refactor']) {
        const i = issue('backlog', [`pipeline:type:${taskType}`]);
        assert.equal(
            isCutListIssue(i),
            false,
            `pipeline:type:${taskType} must NOT be cut-listed`,
        );
    }
});

test('isCutListIssue returns false when no type label is present', () => {
    // A legacy issue without a `pipeline:type:*` label cannot be silently
    // dropped — we'd erase project history we don't own.
    assert.equal(isCutListIssue(issue('started', [])), false);
});

// AC #8 — human_status round-trip via labels
test('round-trip: writing pipeline:human:ready_for_action and re-deriving yields ready_for_action', () => {
    const labelName = humanStatusLabel('ready_for_action');
    assert.ok(labelName);
    const out = deriveStatusFromIssue(
        issue('started', ['pipeline:stage:dev', labelName!]),
    );
    assert.equal(out.human_status, 'ready_for_action');
});
