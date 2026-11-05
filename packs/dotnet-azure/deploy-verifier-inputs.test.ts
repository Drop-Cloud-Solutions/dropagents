/**
 * The deploy-verifier must only claim inputs the pipeline actually sends.
 *
 * Field report: "the verify publish to feed task pretty much always
 * fails, it comes with a question ... Without the completion timestamp
 * and stdout showing what version was pushed, I cannot verify recency."
 *
 * The persona's `# Inputs (from TASK.md)` section listed the upstream
 * task's completion timestamp and a "stdout tail (last 1500 chars of what
 * the script printed)", and its Forbidden section ruled out deriving the
 * version any other way. Both were fiction: nothing in the pipeline wrote
 * either one into a prompt, so the only move left to a compliant agent
 * was NEEDS_HUMAN_INPUT — which is exactly what it did, run after run.
 *
 * A persona that names an input is a CONTRACT with the prompt builder.
 * This test is the only place the two sides are checked against each
 * other: a rename on either side, or a new "and you will also receive X",
 * fails here instead of in production three deploys later.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    renderUpstreamOutputsBlock,
    type UpstreamTaskOutput,
} from '../../hosts/orchestrator/upstream-outputs';

const PERSONA = fs.readFileSync(
    path.join(__dirname, 'agents', 'deploy-verifier.CLAUDE.md'),
    'utf8',
);

/**
 * The persona with every run of whitespace collapsed.
 *
 * Prose wraps, and the file is CRLF: a sentence this test cares about is
 * split across lines in the source. Matching the flattened form asserts
 * the WORDS are there without pinning where the author broke the line.
 */
const flatten = (text: string): string => text.replace(/\s+/g, ' ');
const FLAT = flatten(PERSONA);

/** A rendered block, to compare the persona's promises against. */
function sampleBlock(): string {
    const outputs: readonly UpstreamTaskOutput[] = [{
        taskId: 'T-1',
        type: 'deploy-nuget',
        title: 'Publish Example.Pkg NuGet package',
        status: 'done',
        steps: [{
            stepId: 'publish',
            role: 'publisher',
            status: 'complete',
            finishedAt: Date.UTC(2026, 9, 30, 9, 54, 51),
            report: '**ALL PUBLISHED**\n- **Version:** 0.0.78',
            truncated: false,
        }],
        omittedSteps: [],
    }];
    return renderUpstreamOutputsBlock(outputs);
}

test('the persona points at the block the prompt builder emits', () => {
    const heading = '# Upstream task output';
    assert.ok(
        sampleBlock().startsWith(heading),
        'the renderer must emit that exact heading',
    );
    assert.ok(
        FLAT.includes('`# Upstream task output`'),
        'the persona must name the block it is handed',
    );
});

test('the persona no longer claims a stdout tail it is not given', () => {
    // The pipeline sends the upstream AGENT's report, not the script's
    // stdout. Promising stdout invited the agent to look for something
    // that was never there and ask when it could not find it.
    const inputsSection = flatten(PERSONA.slice(
        PERSONA.indexOf('# Inputs'),
        PERSONA.indexOf('# Azure authentication'),
    ));
    assert.ok(inputsSection.length > 0, 'the Inputs section still exists');
    assert.doesNotMatch(
        inputsSection,
        /stdout tail \(last \d+ chars/,
        'the "stdout tail (last N chars)" input never existed',
    );
    assert.match(
        inputsSection,
        /# Upstream task output/,
        'and the real source is named in its place',
    );
});

test('the completion timestamp is sourced from the block, not from nowhere', () => {
    // Every recipe compares a target timestamp against `completed_at`.
    // That value has to be traceable to something the agent was handed.
    assert.match(
        FLAT,
        /the `completed` value on the deploy step in `# Upstream task output`/,
        'the Azure recipe must say where completed_at comes from',
    );
    assert.match(
        FLAT,
        /Compare the timestamp to the deploy step's `completed` value/,
        'and so must the NuGet recency check',
    );
    assert.ok(
        sampleBlock().includes('completed 2026-10-30T09:54:51.000Z'),
        'the block must actually carry a comparable ISO timestamp',
    );
});

test('the version still may NOT be derived — only its source changed', () => {
    // The rule that made this failure visible is the right rule. It stays.
    assert.match(FLAT, /Never compute the expected version/);
    assert.match(
        FLAT,
        /never derived/,
        'the Forbidden section must still forbid deriving the version',
    );
    assert.match(
        FLAT,
        /the pushed version is read from the `# Upstream task output` block/,
        'pointing at the block as the authority',
    );
});

test('asking the operator for an input it was handed is forbidden', () => {
    // Without this the persona can comply with every other rule and still
    // park the task out of habit.
    assert.match(
        FLAT,
        /Asking the operator for the completion timestamp or the pushed version/,
    );
});

test('a lost report is INCONCLUSIVE, and the persona uses the block wording', () => {
    // The renderer emits "no report captured for this step" when the
    // pipeline lost the text. The persona has to recognise that string
    // and not read it as "the publisher printed nothing".
    const lost: readonly UpstreamTaskOutput[] = [{
        taskId: 'T-1',
        type: 'deploy-nuget',
        title: null,
        status: 'done',
        steps: [{
            stepId: 'publish',
            role: 'publisher',
            status: 'complete',
            finishedAt: 1,
            report: null,
            truncated: false,
        }],
        omittedSteps: [],
    }];
    const rendered = renderUpstreamOutputsBlock(lost);
    assert.match(rendered, /no report captured for this step/);
    assert.ok(
        FLAT.includes('no report captured for this step'),
        'the persona must quote the renderer wording it has to act on',
    );
    const at = FLAT.indexOf('no report captured for this step');
    assert.match(
        FLAT.slice(at, at + 400),
        /INCONCLUSIVE/,
        'and that case must map to INCONCLUSIVE',
    );
});
