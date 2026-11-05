/**
 * The chat agent's view of the project context.
 *
 * It lives in `projects.context_md`, not on disk, so the agent's
 * Read/Grep/Glob tools cannot reach it — before this it would answer
 * architecture questions from the repo trees alone while the operator's
 * own description of how those trees fit together sat unread.
 *
 * The subtle requirement is the TRUNCATION one. The agent may be asked to
 * rewrite this text, and a rewrite built from a partial copy silently
 * deletes whatever was cropped, so past the cap the block has to forbid a
 * replacement outright rather than just show less.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { applyMigrations, openDatabase, type Db } from '../../core/state/migrations';
import { buildPipelineStateBlock } from './chat-service';

const PID = 'example.platform';

function makeDb(contextMd: string | null): Db {
    const db = openDatabase(':memory:');
    applyMigrations(db);
    db.prepare(
        `INSERT INTO projects(id, name, metadata, context_md, archived_at, updated_at)
         VALUES (?, 'Example Platform', '{}', ?, NULL, 1)`,
    ).run(PID, contextMd);
    return db;
}

test('the stored context is quoted into the state block', () => {
    const context = '# Example Platform\n\nFour repos. `corelib` publishes the function host package.';
    const db = makeDb(context);
    try {
        const block = buildPipelineStateBlock(db, PID);
        assert.match(block, /# Project context \(projects\.context_md, this project\)/);
        assert.ok(block.includes(context), 'the context itself must be present, verbatim');
    } finally {
        db.close();
    }
});

test('the block names the exact target the agent needs to change it', () => {
    // A target the agent has to guess is a target it gets wrong, and the
    // proposal is then dropped with a parse warning.
    const db = makeDb('# Example Platform\n\nSomething true about the repos.');
    try {
        const block = buildPipelineStateBlock(db, PID);
        assert.ok(block.includes(`project-context:${PID}`));
        assert.match(block, /COMPLETE new markdown/);
    } finally {
        db.close();
    }
});

test('an unset context says so, and invites recording one', () => {
    // Silence would read as "the pipeline failed to give me the context",
    // which is the one thing that must not be ambiguous before a rewrite.
    for (const empty of [null, '', '   \n ']) {
        const db = makeDb(empty);
        try {
            const block = buildPipelineStateBlock(db, PID);
            assert.match(block, /Not set for this project/);
            assert.ok(block.includes(`project-context:${PID}`));
        } finally {
            db.close();
        }
    }
});

test('an oversized context is cut AND a replacement is forbidden', () => {
    const huge = `# Big\n\n${'x'.repeat(20_000)}`;
    const db = makeDb(huge);
    try {
        const block = buildPipelineStateBlock(db, PID);
        assert.ok(block.length < huge.length, 'must not quote the whole thing');
        assert.match(block, /only the first/);
        // The load-bearing half: seeing less must stop it proposing, not
        // just make its answers thinner.
        assert.match(block, /do NOT propose a replacement/);
    } finally {
        db.close();
    }
});

test('a project-less session gets no context block rather than a wrong one', () => {
    const db = makeDb('# Example Platform\n\nreal content here');
    try {
        const block = buildPipelineStateBlock(db, '');
        assert.doesNotMatch(block, /# Project context/);
    } finally {
        db.close();
    }
});

test('an unknown project id degrades to the not-set wording, not a crash', () => {
    const db = makeDb('# Example Platform\n\nreal content here');
    try {
        const block = buildPipelineStateBlock(db, 'no-such-project');
        assert.match(block, /Not set for this project/);
    } finally {
        db.close();
    }
});
