/**
 * Persona integrity — the guard on the one route both editing surfaces
 * write through (`PUT /agent-md/:role`: the manager UI's editor, and
 * chat's `persona:<role>` apply).
 *
 * Field incident these encode: the planner and decomposer were saved
 * truncated mid-sentence. The decomposer lost its output template — the
 * JSON contract `core/decomposer/task.schema.json` is derived from — and
 * both lost the NEEDS_HUMAN_INPUT escape hatch, so neither agent could
 * park for a clarification at all. Nothing noticed for days.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    findDroppedEscapeHatch,
    findTruncation,
    spliceTruncatedGeneration,
} from './persona-integrity';
import { shippedPersonaFiles } from '../../config/profile';

const AGENTS_DIR = path.resolve(__dirname, '..', '..', 'agents');

// ---------------------------------------------------------------------------
// No false positives — the whole repo must pass
// ---------------------------------------------------------------------------

test('every persona in the repo (core and packs) passes the truncation check', () => {
    // The guard blocks saves. If it rejects any file that legitimately
    // exists today, it is too strict and would block real edits.
    const files = shippedPersonaFiles();
    assert.ok(files.length >= 15, 'expected the persona set to be found');
    for (const f of files) {
        const content = fs.readFileSync(f, 'utf8');
        const problem = findTruncation(content);
        assert.equal(problem, null, `${path.basename(f)} must not be flagged: ${problem?.message ?? ''}`);
    }
    const shared = fs.readFileSync(
        path.join(AGENTS_DIR, '_shared', 'clarification-block.md'),
        'utf8',
    );
    assert.equal(findTruncation(shared), null, 'the shared block must not be flagged');
});

test('no persona carries double-encoded characters', () => {
    // 270 sequences of these had accumulated across 12 personas: an em dash
    // written as "â€”", an arrow as "â†’". They reach the model verbatim, and
    // a naive ASCII sweep that clips one corrupts the heading around it.
    // "â" has no legitimate use in these prompts, so it is the sharp test.
    const offenders = [...shippedPersonaFiles(), path.join(AGENTS_DIR, '_shared', 'clarification-block.md')]
        .filter((f) => fs.readFileSync(f, 'utf8').includes('â'))
        .map((f) => path.basename(f));
    assert.deepEqual(
        offenders,
        [],
        'double-encoded text is back — re-run the repair rather than hand-editing',
    );
});

test('a persona that embeds the shared block carries the include markers', () => {
    // `insertBeforeSharedBlock` anchors on the BEGIN marker. Without it a
    // pack's or the profile's `<role>.extend.md` is appended at the END of
    // the file — AFTER the escape hatch, which is supposed to be the last
    // thing the agent reads. The architect shipped exactly that way.
    const missing: string[] = [];
    for (const f of shippedPersonaFiles()) {
        const content = fs.readFileSync(f, 'utf8');
        if (!content.includes('## Escape hatch: NEEDS_HUMAN_INPUT')) continue;
        for (const marker of ['BEGIN include:', 'END include:']) {
            if (!content.includes(`<!-- ${marker} _shared/clarification-block.md -->`)) {
                missing.push(`${path.basename(f)} (${marker.replace(' include:', '')})`);
            }
        }
    }
    assert.deepEqual(missing, [], 'additions would splice after the escape hatch');
});

/** Personas that never carried the escape hatch (read-only or non-task roles). */
const NO_HATCH = new Set(['chat', 'design-verifier', 'flow-author']);

test('every persona embeds the shared escape-hatch block byte-for-byte', () => {
    // CLAUDE.md has always said the block "must stay byte-identical in every
    // persona" — this is the first test that holds anyone to it, and it now
    // spans pack personas too, which live outside agents/. A drifted copy is
    // a different contract: clarification-parser matches the marker, and an
    // agent told the rules slightly differently asks slightly differently.
    const shared = fs
        .readFileSync(path.join(AGENTS_DIR, '_shared', 'clarification-block.md'), 'utf8')
        .replace(/\r\n/g, '\n')
        .trim();
    for (const f of shippedPersonaFiles()) {
        const role = path.basename(f, '.CLAUDE.md');
        const content = fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
        if (NO_HATCH.has(role)) {
            assert.ok(!content.includes('NEEDS_HUMAN_INPUT'), `${role}: listed as hatch-less but has one — update NO_HATCH`);
            continue;
        }
        assert.ok(content.includes(shared), `${role}: the escape-hatch block is missing or drifted from _shared/clarification-block.md`);
    }
});

// ---------------------------------------------------------------------------
// The real truncations
// ---------------------------------------------------------------------------

test('the decomposer cut ("**Tool allowlists by role:**") is caught', () => {
    const problem = findTruncation(
        ['# ROLE: Decomposer', '', 'Some prose.', '', '**Tool allowlists by role:**'].join('\n'),
    );
    assert.equal(problem?.code, 'dangling-lead-in');
    assert.match(problem!.message, /Tool allowlists by role/);
    assert.match(problem!.message, /Nothing was saved/);
});

test('the planner cut (a sentence ending "Example:") is caught', () => {
    const problem = findTruncation('# ROLE: Planner\n\nMark new files with `(new)`. Example:');
    assert.equal(problem?.code, 'dangling-lead-in');
});

test('an unclosed code fence is caught', () => {
    const problem = findTruncation('# ROLE: X\n\n```\nsome code that never closes\n');
    assert.equal(problem?.code, 'unclosed-code-fence');
});

test('a trailing heading with no body is caught', () => {
    assert.equal(
        findTruncation('# ROLE: X\n\nProse.\n\n## Output template')?.code,
        'dangling-heading',
    );
});

// ---------------------------------------------------------------------------
// Legitimate endings must NOT be rejected
// ---------------------------------------------------------------------------

test('ordinary endings are accepted', () => {
    for (const ending of [
        '# ROLE: X\n\nEnds on a plain sentence.',
        '# ROLE: X\n\n- ends on a bullet\n- like this one',
        '# ROLE: X\n\n| a | b |\n|---|---|\n| 1 | 2 |',
        '# ROLE: X\n\n```\nfenced\n```',
        '# ROLE: X\n\nEnds with a question?',
        '# ROLE: X\n\nEnds with a URL: see https://example.com/docs',
    ]) {
        assert.equal(
            findTruncation(ending),
            null,
            `must not reject: ${JSON.stringify(ending.slice(-40))}`,
        );
    }
});

test('CRLF content is handled like LF', () => {
    assert.equal(findTruncation('# ROLE: X\r\n\r\nDone.\r\n'), null);
    assert.equal(
        findTruncation('# ROLE: X\r\n\r\n**Lead-in:**\r\n')?.code,
        'dangling-lead-in',
    );
});

// ---------------------------------------------------------------------------
// Escape-hatch regression
// ---------------------------------------------------------------------------

test('replacing a persona that HAS the escape hatch with one that lacks it is refused', () => {
    const problem = findDroppedEscapeHatch(
        '# ROLE: X\n\n## Escape hatch: NEEDS_HUMAN_INPUT\nstuff',
        '# ROLE: X\n\nrewritten without it',
    );
    assert.equal(problem?.code, 'escape-hatch-dropped');
    assert.match(problem!.message, /cannot ask the operator a question/);
});

test('personas that never had the hatch (chat, design-verifier) stay editable', () => {
    // A blanket "must contain NEEDS_HUMAN_INPUT" rule would block these
    // two legitimately-hatchless personas on every save.
    assert.equal(findDroppedEscapeHatch('# ROLE: Chat\n\nno hatch here', '# ROLE: Chat\n\nedited'), null);
    assert.equal(findDroppedEscapeHatch(null, '# ROLE: New\n\nbrand new file'), null);
});

test('keeping the hatch is accepted', () => {
    const withHatch = '# ROLE: X\n\n## Escape hatch: NEEDS_HUMAN_INPUT\nstuff';
    assert.equal(findDroppedEscapeHatch(withHatch, withHatch + '\nmore'), null);
});

// ---------------------------------------------------------------------------
// Truncation rescue
// ---------------------------------------------------------------------------

const CURRENT = [
    '# ROLE: Decomposer',
    '',
    'Old intro.',
    '',
    '**Tool allowlists by role:**',
    '',
    '```',
    'developer -> ["Bash"]',
    '```',
    '',
    '## Output template',
    '',
    'Emit this JSON.',
].join('\n');

test('a generation cut at a line present in the current file is spliced whole', () => {
    const generated = [
        '# ROLE: Decomposer',
        '',
        'Rewritten intro, much better.',
        '',
        '**Tool allowlists by role:**',
    ].join('\n');

    const out = spliceTruncatedGeneration(generated, CURRENT);
    assert.ok(out, 'the seam is unambiguous — it must splice');
    assert.equal(out!.resumedAfter, '**Tool allowlists by role:**');
    assert.equal(out!.carriedLines, 8);
    assert.match(out!.content, /Rewritten intro, much better\./);
    assert.match(out!.content, /## Output template/, 'the lost tail is restored');
    assert.equal(
        out!.content.match(/\*\*Tool allowlists by role:\*\*/g)?.length,
        1,
        'the anchor line must not be duplicated at the seam',
    );
    assert.equal(findTruncation(out!.content), null, 'the spliced result is complete');
});

test('an ambiguous anchor refuses to splice rather than guess', () => {
    const twice = ['# ROLE: X', 'repeated', 'middle', 'repeated', 'tail'].join('\n');
    assert.equal(spliceTruncatedGeneration('# ROLE: X\nrepeated', twice), null);
});

test('an anchor absent from the current file refuses to splice', () => {
    assert.equal(
        spliceTruncatedGeneration('# ROLE: X\nsomething the old file never said', CURRENT),
        null,
    );
});

test('a generation that reached the end of the file has nothing to splice', () => {
    assert.equal(spliceTruncatedGeneration(CURRENT, CURRENT), null);
});
