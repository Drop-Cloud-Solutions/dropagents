/**
 * Who gets the project context as an EDITABLE block.
 *
 * `project-context-writer` is asked to replace the stored text in full, so
 * it has to see all of it — a "replacement" written without the current
 * copy destroys whatever it did not know about. Every other task role gets
 * nothing: they work inside one worktree, and none of them has any
 * business rewriting the operator's cross-repo description.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { applyMigrations, openDatabase, type Db } from '../../core/state/migrations';
import {
    PROJECT_CONTEXT_EDITOR_ROLES,
    assembleTaskAgentPrompt,
    readTaskAgentContext,
} from './handlers';

const CONTEXT = '# Shop\n\nFour repos; `shop.orders` owns the domain.';

function makeDb(contextMd: string | null = CONTEXT): Db {
    const db = openDatabase(':memory:');
    applyMigrations(db);
    db.prepare(
        `INSERT INTO projects(id, name, metadata, context_md, archived_at, updated_at)
         VALUES ('shop', 'Shop', '{}', ?, NULL, 1)`,
    ).run(contextMd);
    db.prepare(
        "INSERT INTO plans(id, project_id, status, created_at) VALUES ('p1','shop','active',1)",
    ).run();
    db.prepare(
        `INSERT INTO sidebar_plans(plan_id, pid, name, status, updated_at)
         VALUES ('p1', 'shop', 'Add the integrations repo', 'active', 1)`,
    ).run();
    db.prepare(
        `INSERT INTO tasks(id, plan_id, type, status, title, description)
         VALUES ('L-ATIR-004', 'p1', 'update-project-context', 'approved',
                 'Update the project context', 'The integrations repo is new.')`,
    ).run();
    return db;
}

test('the writer role receives the current context, under an editing heading', () => {
    const db = makeDb();
    try {
        const ctx = readTaskAgentContext(db, 'project-context-writer', 'L-ATIR-004', 'write-context');
        assert.ok(ctx, 'context must resolve');
        assert.equal(ctx!.projectId, 'shop');
        const prompt = assembleTaskAgentPrompt(ctx!);
        assert.match(prompt, /# Project context \(current\)/);
        assert.ok(prompt.includes(CONTEXT), 'the stored text must be present verbatim');
        // The framing has to differ from the design-side block, which
        // tells its readers the context is background and not to be acted
        // on — the opposite of this role's job.
        assert.match(prompt, /REPLACES it in full/);
    } finally {
        db.close();
    }
});

test('an empty context still emits the block, saying it is empty', () => {
    // A silently absent block reads as "the pipeline failed to hand me
    // the current text", and that ambiguity is the one thing that must
    // not precede a full replacement.
    for (const empty of [null, '']) {
        const db = makeDb(empty);
        try {
            const ctx = readTaskAgentContext(db, 'project-context-writer', 'L-ATIR-004', 'write-context');
            const prompt = assembleTaskAgentPrompt(ctx!);
            assert.match(prompt, /# Project context \(current\)/);
            assert.match(prompt, /no context recorded yet/);
        } finally {
            db.close();
        }
    }
});

test('other task roles get no context block at all', () => {
    const db = makeDb();
    try {
        for (const role of ['developer', 'reviewer', 'tester', 'committer', 'doc-writer']) {
            const ctx = readTaskAgentContext(db, role, 'L-ATIR-004', 'develop');
            assert.equal(ctx!.projectContextBlock, undefined, role);
            assert.doesNotMatch(assembleTaskAgentPrompt(ctx!), /# Project context/, role);
        }
    } finally {
        db.close();
    }
});

test('the editor allow-list is a deliberate list, not an accident', () => {
    // Adding a name here is a decision to trust that role with an
    // overwrite of operator-authored prose. Pin it so the decision has to
    // be made rather than drifted into.
    assert.deepEqual([...PROJECT_CONTEXT_EDITOR_ROLES], ['project-context-writer']);
});

test('projectId still resolves for a role that gets no context block', () => {
    const db = makeDb();
    try {
        const ctx = readTaskAgentContext(db, 'developer', 'L-ATIR-004', 'develop');
        assert.equal(ctx!.projectId, 'shop');
    } finally {
        db.close();
    }
});
