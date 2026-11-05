/**
 * The decomposer's `test.commands` must reach TASK.md.
 *
 * They did not. `PlanDecomposedTask` carried title, type, description,
 * dependencies, goal, acceptance criteria and file lists — no `test` — so
 * the block was validated by the decomposer contract and then dropped.
 * Meanwhile `tester.CLAUDE.md` tells the agent to read "the test
 * commands" from TASK.md, which had never contained any. The tester
 * therefore inferred a command, and what it inferred for a PowerShell
 * repo was the whole suite: run on the tester step, and again on every
 * `on_failure: develop` loop.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import {
    extractDecomposerTasks,
    renderTicketSections,
    type TaskTicketDetails,
} from './handlers';

function sections(details: TaskTicketDetails): string {
    return renderTicketSections(details, '##').join('\n');
}

test('test commands are rendered into the ticket sections', () => {
    const out = sections({
        testCommands: ['Invoke-Pester -Path tests/ExampleNaming.Tests.ps1'],
    });

    assert.match(out, /## Test commands/);
    assert.match(out, /Invoke-Pester -Path tests\/ExampleNaming\.Tests\.ps1/);
});

test('the section tells the agent NOT to widen them', () => {
    // Without this the agent reads a narrow command as a starting point
    // and runs the suite "to be safe" — which is the behaviour the whole
    // change exists to stop.
    const out = sections({ testCommands: ['dotnet test Foo.csproj --filter X'] });
    assert.match(out, /scoped to what it/i);
    assert.match(out, /do not widen them to the whole suite/i);
});

test('several commands all survive, in order', () => {
    const out = sections({
        testCommands: ['dotnet build --no-restore', 'dotnet test Foo.csproj'],
    });
    assert.ok(out.indexOf('dotnet build') < out.indexOf('dotnet test'));
});

test('no commands renders no section at all', () => {
    // scaffold / refactor tasks get `"test": null`; an empty heading
    // would read as "this task has no tests" rather than "not applicable".
    assert.doesNotMatch(sections({ goal: 'g' }), /Test commands/);
    assert.doesNotMatch(sections({ testCommands: [] }), /Test commands/);
});

test('test commands sit alongside the other ticket sections', () => {
    // TASK.md order matters: the agent reads top-down, and verification
    // belongs after the work is described.
    const out = sections({
        goal: 'Ship it',
        acceptanceCriteria: ['works'],
        testCommands: ['Invoke-Pester -Path tests/A.Tests.ps1'],
    });

    assert.ok(out.indexOf('Acceptance criteria') < out.indexOf('Test commands'));
});

// --- the lift, against raw decomposer output ------------------------

function decomposerDoc(testBlock: unknown): unknown {
    return {
        plan: {
            id: 'p-1',
            title: 'T',
            description: 'd',
            tasks: [{
                id: 'task-001',
                title: 'Fix the naming module',
                type: 'implement',
                dependencies: [],
                context: {
                    description: 'brief',
                    acceptance_criteria: ['works'],
                },
                test: testBlock,
            }],
        },
    };
}

test('test.commands is lifted off the decomposer output', () => {
    // The half that was missing: the block was validated and dropped, so
    // nothing downstream could render what it never received.
    const [task] = extractDecomposerTasks(decomposerDoc({
        commands: ['Invoke-Pester -Path tests/ExampleNaming.Tests.ps1'],
        coverage_threshold: 90,
    }));

    assert.deepEqual(task!.testCommands, ['Invoke-Pester -Path tests/ExampleNaming.Tests.ps1']);
});

test('"test": null is absent, not empty — scaffold and refactor use it', () => {
    const [task] = extractDecomposerTasks(decomposerDoc(null));
    assert.equal(task!.testCommands, undefined);
});

test('a test block with no commands array is tolerated', () => {
    // LLM output is hostile input: a malformed block must not throw and
    // must not fabricate a command.
    for (const block of [{}, { commands: 'not an array' }, { commands: [] }, 'string']) {
        const [task] = extractDecomposerTasks(decomposerDoc(block));
        assert.equal(task!.testCommands, undefined, JSON.stringify(block));
    }
});

test('non-string entries are dropped rather than stringified', () => {
    const [task] = extractDecomposerTasks(decomposerDoc({
        commands: ['dotnet test Foo.csproj', 42, null, '  ', 'dotnet build'],
    }));
    assert.deepEqual(task!.testCommands, ['dotnet test Foo.csproj', 'dotnet build']);
});

test('lifting the test block leaves the other ticket fields alone', () => {
    const [task] = extractDecomposerTasks(decomposerDoc({ commands: ['x'] }));
    assert.equal(task!.description, 'brief');
    assert.deepEqual(task!.acceptanceCriteria, ['works']);
});
