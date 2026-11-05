import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import * as path from 'node:path';

import { loadLayeredFlows } from '../flow/loader';
import { TaskTypeCatalog } from '../flow/task-types';
import { normalizeDecomposerOutput, validateDecomposerOutput as validate } from './validate';

const REPO = path.resolve(__dirname, '..', '..');
const CORE_FLOWS = path.join(REPO, 'config', 'flows');
const PACK_FLOWS = path.join(REPO, 'packs', 'dotnet-azure', 'flows');

/**
 * The allowed set as the orchestrator derives it: from the loaded flows'
 * `task_type.decomposable`. Core + the dotnet-azure pack here, so these
 * tests cover every type the repo ships.
 */
const ALLOWED_TASK_TYPES = TaskTypeCatalog.fromFlows(loadLayeredFlows([CORE_FLOWS, PACK_FLOWS])).decomposable();
const CORE_ONLY = TaskTypeCatalog.fromFlows(loadLayeredFlows([CORE_FLOWS])).decomposable();

function validateDecomposerOutput(value: unknown): ReturnType<typeof validate> {
    return validate(value, ALLOWED_TASK_TYPES);
}

function doc(taskOverrides: Record<string, unknown>): unknown {
    return {
        plan: {
            id: 'plan-1',
            title: 'A plan',
            description: 'desc',
            tasks: [
                {
                    id: 'task-001',
                    title: 'First',
                    type: 'implement',
                    status: 'pending',
                    dependencies: [],
                    agent: { role: 'developer' },
                    context: { description: 'do the thing' },
                    ...taskOverrides,
                },
            ],
        },
    };
}

test('a well-formed document validates', () => {
    assert.equal(validateDecomposerOutput(doc({})).ok, true);
});

test('a string agent fails validation but normalizes to { role }', () => {
    const bad = doc({ agent: 'developer' });
    assert.equal(validateDecomposerOutput(bad).ok, false);

    normalizeDecomposerOutput(bad);
    const task = (bad as { plan: { tasks: Array<{ agent: unknown }> } }).plan.tasks[0];
    assert.deepEqual(task.agent, { role: 'developer' });
    assert.equal(validateDecomposerOutput(bad).ok, true);
});

test('a missing agent normalizes to {} and validates', () => {
    const bad = doc({});
    delete (bad as { plan: { tasks: Array<Record<string, unknown>> } }).plan.tasks[0].agent;
    assert.equal(validateDecomposerOutput(bad).ok, false);

    normalizeDecomposerOutput(bad);
    const task = (bad as { plan: { tasks: Array<{ agent: unknown }> } }).plan.tasks[0];
    assert.deepEqual(task.agent, {});
    assert.equal(validateDecomposerOutput(bad).ok, true);
});

test('a string context normalizes to { description }', () => {
    const bad = doc({ context: 'just the description' });
    normalizeDecomposerOutput(bad);
    const task = (bad as { plan: { tasks: Array<{ context: unknown }> } }).plan.tasks[0];
    assert.deepEqual(task.context, { description: 'just the description' });
    assert.equal(validateDecomposerOutput(bad).ok, true);
});

test('normalize leaves a genuinely broken doc still failing', () => {
    // Missing title is not something normalize touches — it must still fail.
    const bad = doc({ title: '' });
    normalizeDecomposerOutput(bad);
    const result = validateDecomposerOutput(bad);
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /title/);
});

test('normalize tolerates non-object input without throwing', () => {
    assert.equal(normalizeDecomposerOutput(null), null);
    assert.equal(normalizeDecomposerOutput('x'), 'x');
    assert.deepEqual(normalizeDecomposerOutput({ plan: { tasks: 'nope' } }), {
        plan: { tasks: 'nope' },
    });
});

// ---------------------------------------------------------------------------
// The allowed-type set is the RUNTIME gate
// ---------------------------------------------------------------------------
//
// Field case: `update-project-context` was added to the decomposer's
// persona and given a `config/flows/update-project-context.yaml`, and the
// flow policy test was updated to match — but not this set. A real
// decomposition emitted the type and the whole plan was rejected with
// `plan.tasks[12].type "update-project-context" is not in the allowed
// set`, while every test still passed. Three copies of one list, and the
// only one that runs in production was the one left behind.

test('update-project-context is accepted — the decomposer may emit it', () => {
    assert.equal(
        validateDecomposerOutput(doc({ type: 'update-project-context' })).ok,
        true,
    );
});

test('every allowed type actually validates', () => {
    // Cheap, and it turns "someone added a string to the set" into a
    // checked claim rather than a hope.
    for (const type of ALLOWED_TASK_TYPES) {
        const res = validateDecomposerOutput(doc({ type }));
        assert.equal(res.ok, true, `${type}: ${res.error ?? ''}`);
    }
});

test('an unknown type is still rejected, and the message names it', () => {
    // The set is a gate, not decoration: a hallucinated type must fail
    // loudly rather than produce a task with no flow.
    const res = validateDecomposerOutput(doc({ type: 'refactor-everything' }));
    assert.equal(res.ok, false);
    assert.match(String(res.error), /refactor-everything/);
    assert.match(String(res.error), /not in the allowed set/);
});

test('the allowed set follows the loaded flows: a pack type is rejected when the pack is off', () => {
    // With the pack off its flows are not loaded, so the decomposer must
    // not be able to create a task nothing could ever start.
    const res = validate(doc({ type: 'deploy-nuget' }), CORE_ONLY);
    assert.equal(res.ok, false);
    assert.match(String(res.error), /deploy-nuget/);
    assert.match(String(res.error), /\(.*implement.*\)/, 'names the allowed set so it does not look like a typo');
    assert.equal(validate(doc({ type: 'deploy-nuget' }), ALLOWED_TASK_TYPES).ok, true);
});
