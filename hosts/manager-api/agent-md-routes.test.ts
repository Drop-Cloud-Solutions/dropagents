/**
 * Agent persona MD routes — GET/PUT /agent-md/:role and
 * POST /agent-md/:role/generate. Pure handler-level tests against a
 * temp agents dir; the generate route's LLM call is injected via the
 * `generate` seam so no CLI is spawned.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { getAgentMd, putAgentMd, generateAgentMd } from './routes';

function makeDirs(): { configDir: string; agentsDir: string; cleanup(): void } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-md-'));
    const configDir = path.join(root, 'config');
    const agentsDir = path.join(root, 'agents');
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(agentsDir, { recursive: true });
    return {
        configDir,
        agentsDir,
        cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
    };
}

test('GET returns exists:false + empty content for a role without a file', () => {
    const fx = makeDirs();
    try {
        const res = getAgentMd({ configDir: fx.configDir, agentsDir: fx.agentsDir }, 'publisher');
        assert.equal(res.status, 200);
        const body = res.body as { exists: boolean; content: string; path: string };
        assert.equal(body.exists, false);
        assert.equal(body.content, '');
        assert.equal(body.path, 'agents/publisher.CLAUDE.md');
    } finally {
        fx.cleanup();
    }
});

test('GET returns the file content when it exists', () => {
    const fx = makeDirs();
    try {
        fs.writeFileSync(path.join(fx.agentsDir, 'developer.CLAUDE.md'), '# ROLE: Developer\n');
        const res = getAgentMd({ configDir: fx.configDir, agentsDir: fx.agentsDir }, 'developer');
        const body = res.body as { exists: boolean; content: string };
        assert.equal(body.exists, true);
        assert.equal(body.content, '# ROLE: Developer\n');
    } finally {
        fx.cleanup();
    }
});

test('GET/PUT reject path-traversal role names with 404', () => {
    const fx = makeDirs();
    try {
        for (const bad of ['../evil', 'a/b', 'a\\b', '.hidden', 'x.CLAUDE']) {
            assert.equal(
                getAgentMd({ configDir: fx.configDir, agentsDir: fx.agentsDir }, bad).status,
                404,
                bad,
            );
            assert.equal(
                putAgentMd(
                    { configDir: fx.configDir, agentsDir: fx.agentsDir },
                    bad,
                    JSON.stringify({ content: 'x' }),
                    'application/json',
                ).status,
                404,
                bad,
            );
        }
    } finally {
        fx.cleanup();
    }
});

test('PUT writes the file (creating the dir) and appends a trailing newline', () => {
    const fx = makeDirs();
    try {
        fs.rmSync(fx.agentsDir, { recursive: true, force: true });
        // Body line included deliberately: the integrity gate treats a
        // file that ends on a heading as cut off mid-write. This test is
        // about the write path (mkdir + trailing newline), so give it
        // content a real persona would have.
        const res = putAgentMd(
            { configDir: fx.configDir, agentsDir: fx.agentsDir },
            'tester',
            JSON.stringify({ content: '# ROLE: Tester Agent\n\nYou run the tests.' }),
            'application/json',
        );
        assert.equal(res.status, 200);
        const onDisk = fs.readFileSync(path.join(fx.agentsDir, 'tester.CLAUDE.md'), 'utf8');
        assert.equal(onDisk, '# ROLE: Tester Agent\n\nYou run the tests.\n');
    } finally {
        fx.cleanup();
    }
});

test('PUT rejects empty content with 422', () => {
    const fx = makeDirs();
    try {
        const res = putAgentMd(
            { configDir: fx.configDir, agentsDir: fx.agentsDir },
            'tester',
            JSON.stringify({ content: '   ' }),
            'application/json',
        );
        assert.equal(res.status, 422);
    } finally {
        fx.cleanup();
    }
});

test('generate returns the drafted content WITHOUT writing, escape hatch appended', async () => {
    const fx = makeDirs();
    try {
        fs.mkdirSync(path.join(fx.agentsDir, '_shared'), { recursive: true });
        fs.writeFileSync(
            path.join(fx.agentsDir, '_shared', 'clarification-block.md'),
            '## Escape hatch: NEEDS_HUMAN_INPUT\n\ncanonical block\n',
        );
        let seenPrompt = '';
        const res = await generateAgentMd(
            {
                configDir: fx.configDir,
                agentsDir: fx.agentsDir,
                generate: async (prompt) => {
                    seenPrompt = prompt;
                    return '# ROLE: Publisher Agent\n\nDoes publishing.';
                },
            },
            'publisher',
            JSON.stringify({ purpose: 'publishes release notes to the portal' }),
            'application/json',
        );
        assert.equal(res.status, 200);
        const body = res.body as { content: string };
        assert.ok(body.content.startsWith('# ROLE: Publisher Agent'));
        assert.ok(body.content.includes('NEEDS_HUMAN_INPUT'), 'canonical block appended');
        assert.ok(seenPrompt.includes('publishes release notes to the portal'));
        assert.ok(seenPrompt.includes('agents/publisher.CLAUDE.md'));
        // Review-before-save: generation must not have written the file.
        assert.equal(fs.existsSync(path.join(fx.agentsDir, 'publisher.CLAUDE.md')), false);
    } finally {
        fx.cleanup();
    }
});

test('generate strips an accidental outer markdown fence', async () => {
    const fx = makeDirs();
    try {
        const res = await generateAgentMd(
            {
                configDir: fx.configDir,
                agentsDir: fx.agentsDir,
                generate: async () =>
                    '```markdown\n# ROLE: X Agent\n\nNEEDS_HUMAN_INPUT already here.\n```',
            },
            'x-agent',
            JSON.stringify({ purpose: 'whatever' }),
            'application/json',
        );
        const body = res.body as { content: string };
        assert.ok(body.content.startsWith('# ROLE: X Agent'));
        assert.ok(!body.content.includes('```'));
    } finally {
        fx.cleanup();
    }
});

test('generate with {instructions} revises: prompt carries current file + instructions', async () => {
    const fx = makeDirs();
    try {
        fs.writeFileSync(
            path.join(fx.agentsDir, 'reviewer.CLAUDE.md'),
            '# ROLE: Reviewer Agent\n\nReviews diffs.\n\nNEEDS_HUMAN_INPUT block here.\n',
        );
        let seenPrompt = '';
        const res = await generateAgentMd(
            {
                configDir: fx.configDir,
                agentsDir: fx.agentsDir,
                generate: async (prompt) => {
                    seenPrompt = prompt;
                    return '# ROLE: Reviewer Agent\n\nReviews diffs AND scores severity.\n\nNEEDS_HUMAN_INPUT block here.';
                },
            },
            'reviewer',
            JSON.stringify({ instructions: 'also score each finding by severity' }),
            'application/json',
        );
        assert.equal(res.status, 200);
        assert.ok(seenPrompt.includes('Reviews diffs.'), 'prompt must carry the current file');
        assert.ok(seenPrompt.includes('also score each finding by severity'));
        assert.ok(seenPrompt.includes('This is a revision'));
        const body = res.body as { content: string };
        assert.ok(body.content.includes('scores severity'));
        // Still review-before-save: the file on disk is untouched.
        const onDisk = fs.readFileSync(path.join(fx.agentsDir, 'reviewer.CLAUDE.md'), 'utf8');
        assert.ok(onDisk.includes('Reviews diffs.\n'));
        assert.ok(!onDisk.includes('scores severity'));
    } finally {
        fx.cleanup();
    }
});

test('generate with {instructions} but no existing file returns 422', async () => {
    const fx = makeDirs();
    try {
        const res = await generateAgentMd(
            { configDir: fx.configDir, agentsDir: fx.agentsDir, generate: async () => 'x' },
            'ghost',
            JSON.stringify({ instructions: 'change something' }),
            'application/json',
        );
        assert.equal(res.status, 422);
        assert.match(String((res.body as { error: string }).error), /no agents\/ghost/);
    } finally {
        fx.cleanup();
    }
});

test('generate maps a generator failure to 502 and empty purpose to 422', async () => {
    const fx = makeDirs();
    try {
        const failed = await generateAgentMd(
            {
                configDir: fx.configDir,
                agentsDir: fx.agentsDir,
                generate: async () => {
                    throw new Error('CLI unavailable');
                },
            },
            'x',
            JSON.stringify({ purpose: 'p' }),
            'application/json',
        );
        assert.equal(failed.status, 502);

        const empty = await generateAgentMd(
            { configDir: fx.configDir, agentsDir: fx.agentsDir, generate: async () => 'x' },
            'x',
            JSON.stringify({ purpose: '  ' }),
            'application/json',
        );
        assert.equal(empty.status, 422);
    } finally {
        fx.cleanup();
    }
});

test('generate salvages a conversational preamble before the # ROLE: heading', async () => {
    const fx = makeDirs();
    try {
        const res = await generateAgentMd(
            {
                configDir: fx.configDir,
                agentsDir: fx.agentsDir,
                generate: async () =>
                    'Sure — here is the revised persona file you asked for:\n\n'
                    + '# ROLE: Decomposer Agent\n\nNEEDS_HUMAN_INPUT stays.',
            },
            'decomposer',
            JSON.stringify({ purpose: 'p' }),
            'application/json',
        );
        assert.equal(res.status, 200);
        const body = res.body as { content: string };
        assert.ok(body.content.startsWith('# ROLE: Decomposer Agent'));
        assert.ok(!body.content.includes('Sure — here is'));
    } finally {
        fx.cleanup();
    }
});

test('generate returns 502 when the reply is not a persona file at all', async () => {
    // Field case: a non-file reply landed verbatim in the MD editor and the
    // operator was left staring at text that "was not the md file anymore".
    const fx = makeDirs();
    try {
        const res = await generateAgentMd(
            {
                configDir: fx.configDir,
                agentsDir: fx.agentsDir,
                generate: async () =>
                    'I would suggest making the decomposer stricter about deletion rules.',
            },
            'decomposer',
            JSON.stringify({ purpose: 'p' }),
            'application/json',
        );
        assert.equal(res.status, 502);
        const body = res.body as { error: string };
        assert.ok(body.error.includes('did not return a persona file'));
        assert.ok(body.error.includes('I would suggest'));
    } finally {
        fx.cleanup();
    }
});

// ---------------------------------------------------------------------------
// Integrity gate — a half-written persona must not replace a good one.
//
// Both editing surfaces write through PUT: the manager UI's MD editor and
// chat's `persona:<role>` apply (chat-config-apply). Field incident: the
// planner and decomposer were saved truncated mid-sentence, losing the
// decomposer's output template and BOTH files' escape hatch.
// ---------------------------------------------------------------------------

const GOOD_PERSONA = [
    '# ROLE: Publisher Agent',
    '',
    'You publish NuGet packages.',
    '',
    '## Escape hatch: NEEDS_HUMAN_INPUT',
    '',
    'Emit NEEDS_HUMAN_INPUT when blocked.',
].join('\n');

function put(fx: { configDir: string; agentsDir: string }, content: string) {
    return putAgentMd(
        { configDir: fx.configDir, agentsDir: fx.agentsDir },
        'publisher',
        JSON.stringify({ content }),
        'application/json',
    );
}

test('PUT rejects content that stops on a dangling lead-in, leaving the file untouched', () => {
    const fx = makeDirs();
    try {
        const file = path.join(fx.agentsDir, 'publisher.CLAUDE.md');
        fs.writeFileSync(file, GOOD_PERSONA);

        const res = put(fx, '# ROLE: Publisher Agent\n\nRewritten.\n\n**Tool allowlists by role:**');
        assert.equal(res.status, 422);
        assert.equal((res.body as { code?: string }).code, 'dangling-lead-in');
        assert.equal(
            fs.readFileSync(file, 'utf8'),
            GOOD_PERSONA,
            'a rejected save must not have touched the existing persona',
        );
    } finally {
        fx.cleanup();
    }
});

test('PUT rejects content that drops an escape hatch the current file has', () => {
    const fx = makeDirs();
    try {
        const file = path.join(fx.agentsDir, 'publisher.CLAUDE.md');
        fs.writeFileSync(file, GOOD_PERSONA);

        const res = put(fx, '# ROLE: Publisher Agent\n\nA complete rewrite, but no hatch.');
        assert.equal(res.status, 422);
        assert.equal((res.body as { code?: string }).code, 'escape-hatch-dropped');
        assert.equal(fs.readFileSync(file, 'utf8'), GOOD_PERSONA);
    } finally {
        fx.cleanup();
    }
});

test('PUT still accepts a complete persona', () => {
    const fx = makeDirs();
    try {
        const file = path.join(fx.agentsDir, 'publisher.CLAUDE.md');
        fs.writeFileSync(file, GOOD_PERSONA);

        const next = GOOD_PERSONA.replace('You publish NuGet packages.', 'You publish packages, carefully.');
        assert.equal(put(fx, next).status, 200);
        assert.match(fs.readFileSync(file, 'utf8'), /carefully/);
    } finally {
        fx.cleanup();
    }
});

test('PUT accepts a brand-new persona with no escape hatch (chat / design-verifier shape)', () => {
    const fx = makeDirs();
    try {
        const res = put(fx, '# ROLE: Publisher Agent\n\nBrand new, no hatch needed.');
        assert.equal(res.status, 200);
    } finally {
        fx.cleanup();
    }
});

test('generate splices a truncated draft back to full length and says it did', async () => {
    const fx = makeDirs();
    try {
        const current = [
            '# ROLE: Publisher Agent',
            '',
            'Old intro.',
            '',
            '**Tool allowlists by role:**',
            '',
            '```',
            'publisher -> ["Bash"]',
            '```',
            '',
            '## Escape hatch: NEEDS_HUMAN_INPUT',
            '',
            'Emit NEEDS_HUMAN_INPUT when blocked.',
        ].join('\n');
        fs.writeFileSync(path.join(fx.agentsDir, 'publisher.CLAUDE.md'), current);

        const res = await generateAgentMd(
            {
                configDir: fx.configDir,
                agentsDir: fx.agentsDir,
                // The model hits its output cap mid-document and exits 0.
                generate: async (): Promise<string> =>
                    '# ROLE: Publisher Agent\n\nNew, better intro.\n\n**Tool allowlists by role:**',
            },
            'publisher',
            JSON.stringify({ instructions: 'tighten the intro' }),
            'application/json',
        );

        assert.equal(res.status, 200);
        const body = res.body as { content: string; notice?: string };
        assert.match(body.content, /New, better intro\./, "the operator's revision survives");
        assert.match(body.content, /## Escape hatch/, 'the lost tail is carried over');
        assert.ok(body.notice, 'a silent repair is how a bad seam ships unread');
        assert.match(body.notice!, /stopped early/);
        // …and the result is now saveable through the gate.
        assert.equal(put(fx, body.content).status, 200);
    } finally {
        fx.cleanup();
    }
});

test('generate refuses a truncated draft it cannot splice', async () => {
    const fx = makeDirs();
    try {
        fs.writeFileSync(path.join(fx.agentsDir, 'publisher.CLAUDE.md'), GOOD_PERSONA);
        const res = await generateAgentMd(
            {
                configDir: fx.configDir,
                agentsDir: fx.agentsDir,
                // Cut at a line that appears nowhere in the current file.
                generate: async (): Promise<string> =>
                    '# ROLE: Publisher Agent\n\nSomething entirely new:',
            },
            'publisher',
            JSON.stringify({ instructions: 'rewrite it' }),
            'application/json',
        );
        assert.equal(res.status, 502);
        assert.match((res.body as { error: string }).error, /incomplete/);
    } finally {
        fx.cleanup();
    }
});
