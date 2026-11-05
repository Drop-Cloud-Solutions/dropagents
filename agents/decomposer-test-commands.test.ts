/**
 * The decomposer's test-command guidance has to stay useful on any stack,
 * and the stack-specific templates have to travel with their pack.
 *
 * Field report: deployment tasks felt slow out of proportion to their
 * size. One cause was that the persona's ONLY test template was .NET
 * (`dotnet build` + `dotnet test --filter`), with zero mentions of
 * PowerShell or Pester — so for a `deployment` task the command was
 * whatever the brief author happened to write, and what got written was
 * `Invoke-Pester -Path tests`: the whole test suite, for a change to
 * one module, run on the tester step and again on every
 * `on_failure: develop` loop.
 *
 * Core now carries the PRINCIPLE (scope the command; the repo's CLAUDE.md
 * wins) and the dotnet-azure pack carries the .NET and Pester TEMPLATES.
 * Both halves are asserted here: a core persona that names a stack, or a
 * pack that loses a template, is the same defect in a new place.
 *
 * These assertions are deliberately about the SHAPE of the guidance, not
 * its wording — they should survive an edit that improves the prose and
 * fail one that removes a stack or reinstates the whole-suite default.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..');

const PERSONA = fs.readFileSync(
    path.join(__dirname, 'decomposer.CLAUDE.md'),
    'utf8',
);

const PACK_EXTEND = fs.readFileSync(
    path.join(REPO_ROOT, 'packs', 'dotnet-azure', 'agents', 'decomposer.extend.md'),
    'utf8',
);

/** Just the "Step 9 — Fill test block" section of the core persona. */
function testBlockSection(): string {
    const start = PERSONA.indexOf('### Step 9');
    const end = PERSONA.indexOf('### Step 10', start);
    assert.ok(start >= 0 && end > start, 'Step 9 section must exist');
    return PERSONA.slice(start, end);
}

test('scoping the command to the change is stated as the rule in core', () => {
    // The specific templates age and belong to a pack; the principle is
    // what generalises to the next stack someone adds.
    const section = testBlockSection();
    assert.match(section, /Scope the command to what the task changed/i);
    assert.match(section, /never the repo-wide default/i);
});

test('the repo CLAUDE.md is named as the authority over any template', () => {
    // Per-repo commands are documented there and beat anything generic.
    assert.match(testBlockSection(), /CLAUDE\.md/);
});

test('core Step 9 names no stack', () => {
    // The whole point of the pack split: a pipeline with no pack enabled
    // must not be told to run `dotnet test`.
    const section = testBlockSection();
    for (const stack of [/dotnet/i, /Invoke-Pester/i, /xunit/i, /csproj/i]) {
        assert.doesNotMatch(section, stack, `core Step 9 must not name ${stack}`);
    }
});

test('the pack still documents both stack templates', () => {
    assert.match(PACK_EXTEND, /dotnet test/, '.NET template documented');
    assert.match(PACK_EXTEND, /Invoke-Pester/, 'PowerShell template documented');
});

test('the pack Pester template names ONE test file, not the tests directory', () => {
    // `-Path tests` runs the whole suite; naming the file is the point.
    assert.match(PACK_EXTEND, /Invoke-Pester -Path tests\/\{TestFile\}\.Tests\.ps1/);
    // And it must say so explicitly, since the template alone reads as a
    // placeholder someone could fill with the directory.
    assert.match(PACK_EXTEND, /NOT[\s\S]{0,40}-Path tests/);
});

test('the pack warns off -Output Detailed', () => {
    // One line per test into the agent's context, twice per task.
    assert.match(PACK_EXTEND, /-Output Detailed/);
});
