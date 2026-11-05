/**
 * Policy: a persona may only cite prompt blocks the pipeline can emit.
 *
 * This failure keeps recurring and is invisible from either side alone:
 *
 *   - the reviewer was told "operator feedback overrides the ticket, look for
 *     `# Feedback to address`" — a block only ever threaded to the step being
 *     resumed, so the reviewer never saw one;
 *   - the decomposer was told the package-graph chain block is the "source of
 *     truth" for bump chains — and `assembleLifecyclePrompt` never appended it;
 *   - the developer's rule 3 (marked "a hard requirement") pointed at a
 *     `HUMAN FEEDBACK` section. The task-agent prompt emits `# Feedback to
 *     address`; `# Human feedback` exists only on the LIFECYCLE prompt, which
 *     a developer never receives.
 *
 * An agent instructed to read a block that never arrives does not error — it
 * improvises, and the operator sees a confident wrong answer. So: every
 * backticked `# Heading` reference in a persona must correspond to a block
 * some prompt builder actually produces.
 *
 * The convention this relies on is that personas cite blocks in backticks.
 * Write `# Feedback to address` (backticked) when naming a block, and prose
 * headings of the persona's own document stay unquoted — those are the
 * persona's structure, not a reference to the prompt.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { applyMigrations, openDatabase } from '../../core/state/migrations';
import { assembleTaskAgentPrompt, readTaskAgentContext } from './handlers';
import { shippedPersonaFiles } from '../../config/profile';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const AGENTS_DIR = path.join(REPO_ROOT, 'agents');

/**
 * Every block the pipeline can put in front of an agent, across the
 * task-agent prompt, the lifecycle prompt, TASK.md, and the chat
 * assistant's context.
 *
 * Hand-maintained ON PURPOSE — scraping the emission logic would silently
 * shrink whenever a builder was refactored, which is the failure this test
 * exists to catch.
 *
 * The list can therefore rot the other way: an entry could outlive the block
 * it names. The behavioural test below covers that for the three blocks it
 * actually costs something to get wrong (the operator-input trio). The rest
 * are only load-bearing when a persona cites them, and the first test is what
 * makes a citation meaningful.
 */
const EMITTED_BLOCKS: readonly string[] = [
    '# !!! WORKSPACE BOUNDARIES — read this first !!!',
    '# Acceptance criteria',
    '# Approved architecture design',
    '# Approved implementation plan',
    '# Attachments',
    '# Brief',
    '# Configuration (for PROPOSE_CONFIG_CHANGE proposals)',
    '# Conventions',
    '# Current pipeline state (live, as of this message)',
    // Migration 038: the task's deliverable output folder.
    '# Deliverable files',
    '# Feedback to address',
    '# File impact',
    '# Follow-up question',
    '# Goal',
    '# Human clarification',
    '# Human feedback',
    '# Implement the findings below',
    '# Investigation answer',
    '# NuGet package graph (workspace)',
    '# Operator instructions',
    '# Plan',
    '# Plan attachments',
    '# Previous design + fan-out (adjust minimally — do not redesign)',
    '# Previous implementation plan',
    '# Prior investigation report',
    '# Project context',
    '# Project context (current)',
    '# Proposed fan-out (one plan per system)',
    '# Repository context',
    '# Rollout order',
    '# Scoped plan context',
    '# Scoped requirement context',
    '# Task',
    // What the tasks this one depends on reported, and when they
    // finished. The deploy-verifier is the persona that needs it: it is
    // forbidden from deriving the published version, so the upstream
    // publisher's own report is its only legitimate source. Proven
    // emitted by the end-to-end test in `upstream-outputs.test.ts`.
    '# Upstream task output',
];

/**
 * Backticked `# ...` strings that are NOT references to a prompt block: the
 * doc-writer lists markdown constructs it should WRITE, alongside `## Section`
 * and fenced-code examples. Citing output structure is legitimate; it just
 * isn't an input contract.
 */
const OUTPUT_STRUCTURE_CITATIONS: ReadonlySet<string> = new Set([
    '# Top-level heading',
]);


/** Core and pack personas alike — a pack persona cites blocks too. */
function personaFiles(): string[] {
    return shippedPersonaFiles();
}

/**
 * Compare headings on their words, not their punctuation. A persona citing
 * `# !!! WORKSPACE BOUNDARIES !!!` means the block emitted as
 * `# !!! WORKSPACE BOUNDARIES — read this first !!!`; failing that would make
 * this a test about em-dashes rather than about missing blocks.
 */
function stem(heading: string): string {
    return heading
        .replace(/^#+/, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

/** Backticked `# ...` references — how a persona cites a prompt block. */
function citedBlocks(content: string): string[] {
    const out: string[] = [];
    const re = /`(#\s[^`\n]+)`/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) out.push(m[1]!.trim());
    return out;
}

test('every prompt block a persona cites is one the pipeline actually emits', () => {
    const failures: string[] = [];
    for (const file of personaFiles()) {
        const role = path.basename(file, '.CLAUDE.md');
        const content = fs.readFileSync(file, 'utf8');
        for (const cited of citedBlocks(content)) {
            if (OUTPUT_STRUCTURE_CITATIONS.has(cited)) continue;
            // Prefix match on the word stem: a persona may cite
            // `# NuGet package graph` for `# NuGet package graph (workspace)`.
            const c = stem(cited);
            const known = EMITTED_BLOCKS.some((b) => {
                const e = stem(b);
                return e === c || e.startsWith(c) || c.startsWith(e);
            });
            if (!known) failures.push(`${role}: cites "${cited}", which nothing emits`);
        }
    }
    assert.deepEqual(
        failures,
        [],
        'a persona told to read a block that never arrives improvises instead of failing:\n'
        + failures.join('\n'),
    );
});

test('the three operator-input blocks really are emitted, not just allow-listed', () => {
    // The other direction: a persona promise is only worth anything if the
    // block actually arrives. This RUNS the real builder rather than scanning
    // its source — a source scan kept matching the builder's own doc comments
    // ("Render the `# Operator instructions` block…"), so it passed every
    // sabotage and could not have failed. Executing the builder can.
    //
    // Scoped to the three blocks the personas above now promise, because those
    // are the ones a wrong answer gets rejected over.
    const db = openDatabase(':memory:');
    try {
        applyMigrations(db);
        db.prepare(
            `INSERT INTO tasks(id, plan_id, type, status, title, description, instructions, feedback)
             VALUES ('T-1', 'plan-x', 'implement', 'in_progress', 'T', 'D',
                     'OPERATOR-INSTRUCTION-MARKER', 'REJECT-FEEDBACK-MARKER')`,
        ).run();
        db.prepare(
            `INSERT INTO task_clarifications(event_seq, task_id, question, answer, answered_at)
             VALUES (1, 'T-1', 'Q?', 'CLARIFICATION-ANSWER-MARKER', 1)`,
        ).run();

        const ctx = readTaskAgentContext(db, 'developer', 'T-1', 'develop');
        assert.ok(ctx, 'context must resolve');
        const prompt = assembleTaskAgentPrompt(ctx!);

        for (const [heading, marker] of [
            ['# Operator instructions', 'OPERATOR-INSTRUCTION-MARKER'],
            ['# Feedback to address', 'REJECT-FEEDBACK-MARKER'],
            ['# Human clarification', 'CLARIFICATION-ANSWER-MARKER'],
        ] as const) {
            assert.ok(
                new RegExp(`^${heading}$`, 'm').test(prompt),
                `the prompt must emit ${heading} — every gate persona names it`,
            );
            assert.ok(prompt.includes(marker), `${heading} must carry its content`);
        }
    } finally {
        db.close();
    }
});

test('the developer names the blocks it is actually given', () => {
    // Regression pin for the specific defect: rule 3 cited a `HUMAN FEEDBACK`
    // section that the task-agent prompt never produces, while the three
    // blocks that DO carry operator input went unnamed.
    const developer = fs.readFileSync(path.join(AGENTS_DIR, 'developer.CLAUDE.md'), 'utf8');
    for (const block of [
        '`# Operator instructions`',
        '`# Feedback to address`',
        '`# Human clarification`',
    ]) {
        assert.ok(
            developer.includes(block),
            `the developer persona must name ${block} — it is handed one`,
        );
    }
    assert.ok(
        !/HUMAN FEEDBACK/.test(developer),
        'HUMAN FEEDBACK is not a block this pipeline emits to a task agent',
    );
});

test('the gate roles agree on which blocks carry operator input', () => {
    // The developer applies the operator's decision; the reviewer and tester
    // judge the result. If they disagree about where that decision lives, the
    // gate rejects work for following it — the field case that started this.
    for (const role of ['reviewer', 'tester']) {
        const content = fs.readFileSync(path.join(AGENTS_DIR, `${role}.CLAUDE.md`), 'utf8');
        for (const block of [
            '`# Operator instructions`',
            '`# Feedback to address`',
            '`# Human clarification`',
        ]) {
            assert.ok(
                content.includes(block),
                `${role} must recognise ${block} as operator input that outranks the ticket`,
            );
        }
    }
});
