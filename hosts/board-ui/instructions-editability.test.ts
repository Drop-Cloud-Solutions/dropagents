/**
 * Reported: "I stopped a developer because I saw something should be
 * different, and now I have no way to give it instructions. I want to add
 * instructions to a halted task the same way I can before it starts, then
 * restart it."
 *
 * The gate was `taskHasStarted()` — any recorded step run locked the
 * field. Stopping an agent parks the task at `wait-action` WITH step runs,
 * so the box was read-only at exactly the moment it mattered, above a note
 * telling the operator to add instructions before the task runs.
 *
 * A halted task is the case where an edit genuinely applies:
 * `readTaskAgentContext` reads `tasks.instructions` fresh on every spawn,
 * so Retry re-runs the agent with them.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import {
    canEditTaskInstructions,
    instructionsApplyToRerun,
} from './instructions-editability';

test('a stopped agent leaves the instructions editable', () => {
    // The exact reported state: interrupt parks at wait-action, the
    // status stays mid-flow, and step runs exist.
    assert.equal(
        canEditTaskInstructions({
            status: 'in_progress',
            parkedReason: 'wait-action',
            hasStepRuns: true,
        }),
        true,
    );
});

test('a task that never started is editable, as before', () => {
    assert.equal(canEditTaskInstructions({ status: 'created', hasStepRuns: false }), true);
    assert.equal(canEditTaskInstructions({ status: 'approved', hasStepRuns: false }), true);
    assert.equal(canEditTaskInstructions({}), true);
});

test('a failed task is editable — Retry re-runs with them', () => {
    assert.equal(canEditTaskInstructions({ status: 'failed', hasStepRuns: true }), true);
});

test('every park is editable, whatever it is waiting on', () => {
    for (const reason of [
        'approval', 'clarification', 'worktree-diff-review',
        'wait-action', 'wait-merged', 'waiting-deps',
    ]) {
        assert.equal(
            canEditTaskInstructions({
                status: 'in_progress', parkedReason: reason, hasStepRuns: true,
            }),
            true,
            reason,
        );
    }
});

test('a RUNNING agent still locks the field', () => {
    // The original rule's real concern, and it survives: an agent holding
    // the brief would not see the edit, so offering it would be a lie.
    for (const status of ['in_progress', 'review', 'test', 'commit', 'merge']) {
        assert.equal(
            canEditTaskInstructions({ status, parkedReason: null, hasStepRuns: true }),
            false,
            status,
        );
    }
});

test('a terminal task is read-only — nothing will read them again', () => {
    for (const status of ['done', 'skipped', 'archived']) {
        assert.equal(canEditTaskInstructions({ status, hasStepRuns: true }), false, status);
        // Terminal beats a stale parkedReason left on the row.
        assert.equal(
            canEditTaskInstructions({ status, parkedReason: 'wait-action', hasStepRuns: true }),
            false,
            status + ' + stale park',
        );
    }
});

test('the copy distinguishes a first run from a re-run', () => {
    // "Added before it starts" on a task the operator just stopped reads
    // as "too late for this one" — the opposite of what happens.
    assert.equal(instructionsApplyToRerun({ status: 'created', hasStepRuns: false }), false);
    assert.equal(
        instructionsApplyToRerun({
            status: 'in_progress', parkedReason: 'wait-action', hasStepRuns: true,
        }),
        true,
    );
    assert.equal(instructionsApplyToRerun({ status: 'failed', hasStepRuns: false }), true);
});
