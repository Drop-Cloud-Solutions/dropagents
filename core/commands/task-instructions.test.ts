import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { TaskOpsCommands, isSetTaskInstructionsPayload } from './index';

test('SET_TASK_INSTRUCTIONS command name is stable', () => {
    assert.equal(TaskOpsCommands.SET_TASK_INSTRUCTIONS, 'SetTaskInstructions');
});

test('isSetTaskInstructionsPayload accepts a taskId + string instructions', () => {
    assert.equal(
        isSetTaskInstructionsPayload({ taskId: 'T-1', instructions: 'do it' }),
        true,
    );
    // Empty string is valid — it clears the instructions.
    assert.equal(
        isSetTaskInstructionsPayload({ taskId: 'T-1', instructions: '' }),
        true,
    );
});

test('isSetTaskInstructionsPayload rejects bad shapes', () => {
    assert.equal(isSetTaskInstructionsPayload({}), false);
    assert.equal(isSetTaskInstructionsPayload({ taskId: 'T-1' }), false);
    assert.equal(isSetTaskInstructionsPayload({ taskId: '', instructions: 'x' }), false);
    assert.equal(isSetTaskInstructionsPayload({ taskId: 'T-1', instructions: 5 }), false);
    assert.equal(isSetTaskInstructionsPayload(null), false);
});
