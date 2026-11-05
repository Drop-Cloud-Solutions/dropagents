/**
 * `PIPELINE_DUMP_PROMPTS` — the knob that makes a rejected prompt
 * inspectable.
 *
 * Background: the composed prompt goes over stdin, never argv, and is
 * deliberately never logged — only `promptChars`. So when the decomposer
 * started failing on one model with "safeguards flagged this message"
 * while the same plan succeeded on another, there was no way to see the
 * bytes that were refused. The personas are constant across runs; the
 * brief, the project context, the operator memory and up to 32 KiB
 * apiece of repository source are not.
 *
 * Two properties carry the weight here:
 *  - it is OFF unless asked for, and a role list means a role list (a
 *    busy worker turned fully on writes every task prompt too);
 *  - the prompt is reproduced VERBATIM after the delimiter, because a
 *    bisect against a re-rendered approximation proves nothing.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';

import {
    promptDumpFileName,
    promptDumpPath,
    PROMPT_DUMP_DELIMITER,
    renderPromptDump,
    shouldDumpPrompt,
} from './prompt-dump';

// --- the gate --------------------------------------------------------

test('unset means OFF', () => {
    // The default has to be off: a dump is the whole prompt, including
    // repository source and the operator's accumulated feedback.
    assert.equal(shouldDumpPrompt(undefined, 'decomposer'), false);
});

test('the usual falsy spellings are all OFF', () => {
    for (const raw of ['', '   ', '0', 'false', 'off', 'no', 'FALSE', ' Off ']) {
        assert.equal(shouldDumpPrompt(raw, 'decomposer'), false, JSON.stringify(raw));
    }
});

test('the usual truthy spellings dump every role', () => {
    for (const raw of ['1', 'true', 'on', 'yes', 'all', '*', ' TRUE ']) {
        for (const role of ['decomposer', 'developer', 'tester']) {
            assert.equal(shouldDumpPrompt(raw, role), true, `${raw} / ${role}`);
        }
    }
});

test('a role list dumps only those roles', () => {
    // The point of the list: the question is almost always about one
    // role, and "all" on a busy worker buries it in task prompts.
    const raw = 'decomposer,planner';
    assert.equal(shouldDumpPrompt(raw, 'decomposer'), true);
    assert.equal(shouldDumpPrompt(raw, 'planner'), true);
    assert.equal(shouldDumpPrompt(raw, 'developer'), false);
    assert.equal(shouldDumpPrompt(raw, 'reviewer'), false);
});

test('a role list tolerates spacing and case', () => {
    const raw = ' Decomposer , PLANNER ';
    assert.equal(shouldDumpPrompt(raw, 'decomposer'), true);
    assert.equal(shouldDumpPrompt(raw, 'Planner'), true);
    assert.equal(shouldDumpPrompt(raw, 'developer'), false);
});

test('a role that merely CONTAINS a listed name is not matched', () => {
    // Substring matching would turn `planner` into a switch for
    // `plan-reviewer` too.
    assert.equal(shouldDumpPrompt('plan', 'planner'), false);
    assert.equal(shouldDumpPrompt('planner', 'plan'), false);
});

// --- the file name ---------------------------------------------------

test('the name is chronological, and safe on NTFS', () => {
    // A colon in a Windows filename is read as an alternate data stream
    // and the write fails outright — so the ISO timestamp cannot go in raw.
    const name = promptDumpFileName({
        at: Date.UTC(2026, 8, 16, 12, 34, 56, 789),
        role: 'decomposer',
        agentId: 'claude-cli-abc-1',
    });
    assert.doesNotMatch(name, /[:*?"<>|]/);
    assert.match(name, /^2026-09-16T12-34-56-789Z-decomposer-claude-cli-abc-1\.prompt\.md$/);
});

test('a hostile role or agent id cannot escape the dump directory', () => {
    const file = promptDumpPath('/dumps', {
        agentId: '../../etc/passwd',
        role: '../..',
        model: 'm',
        effort: 'medium',
        cwd: '/repo',
        at: 0,
    });
    assert.equal(path.dirname(path.resolve(file)), path.resolve('/dumps'));
    assert.doesNotMatch(path.basename(file), /\.\./);
});

test('two runs in the same millisecond still get distinct files', () => {
    // The agent id is the disambiguator; without it a burst would
    // overwrite the very run being investigated.
    const at = 1_700_000_000_000;
    const a = promptDumpFileName({ at, role: 'decomposer', agentId: 'agent-1' });
    const b = promptDumpFileName({ at, role: 'decomposer', agentId: 'agent-2' });
    assert.notEqual(a, b);
});

// --- the contents ----------------------------------------------------

const ctx = {
    agentId: 'claude-cli-1',
    role: 'decomposer',
    model: 'claude-opus-5',
    effort: 'medium',
    cwd: 'C:/repos/webshop',
    at: Date.UTC(2026, 8, 16, 10, 0, 0),
};

test('the prompt is reproduced byte-for-byte after the delimiter', () => {
    // The whole point: what is on disk must be what was sent, or a
    // bisect against it proves nothing.
    const prompt = '# ROLE\r\nline\ttab\n\n  trailing spaces   \n```json\n{"a":1}\n```\n';
    const out = renderPromptDump(ctx, prompt);

    const marker = `${PROMPT_DUMP_DELIMITER}\n`;
    const body = out.slice(out.indexOf(marker) + marker.length);
    assert.equal(body, prompt);
});

test('the header records what the run actually used', () => {
    // "Which model produced this?" is the first question asked of a bad
    // run, and the resolved model is not otherwise in the file.
    const out = renderPromptDump(ctx, 'p');
    assert.match(out, /agentId:\s+claude-cli-1/);
    assert.match(out, /role:\s+decomposer/);
    assert.match(out, /model:\s+claude-opus-5/);
    assert.match(out, /effort:\s+medium/);
    assert.match(out, /promptChars: 1/);
});

test('correlation ids are recorded when present and omitted when not', () => {
    const withIds = renderPromptDump({ ...ctx, planId: 'id-123', kind: 'decompose' }, 'p');
    assert.match(withIds, /planId:\s+id-123/);
    assert.match(withIds, /kind:\s+decompose/);
    assert.doesNotMatch(withIds, /taskId:/);

    assert.doesNotMatch(renderPromptDump(ctx, 'p'), /planId:/);
});

test('an empty prompt still produces a readable dump', () => {
    // A promptless spawn is a real failure mode the runner guards
    // against; the dump should show it rather than throw.
    const out = renderPromptDump(ctx, '');
    assert.match(out, /promptChars: 0/);
    assert.ok(out.endsWith(`${PROMPT_DUMP_DELIMITER}\n`));
});

test('the header is delimited so a script can strip it exactly', () => {
    // Documented recovery: sed '1,/^===== PROMPT BEGINS/d' <file>
    const out = renderPromptDump(ctx, 'BODY');
    const lines = out.split('\n');
    const idx = lines.findIndex((l) => l.startsWith('===== PROMPT BEGINS'));
    assert.ok(idx > 0, 'delimiter present');
    assert.equal(lines.slice(idx + 1).join('\n'), 'BODY');
});
