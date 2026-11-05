/**
 * A task proposed in a plan-scoped chat must keep its target repo.
 *
 * Field case: chatting in the plan modal, the agent proposed a task for a
 * specific repo (`Repo:` on the block) and the created task ran against
 * the PLAN's repo instead. The parser carried `repoId` all the way to the
 * confirm chip; the chip's `CreateTask` payload then listed
 * planId/taskType/flowId/title/description and stopped. With
 * `tasks.repo_id` unset, per-task worktree resolution falls back to the
 * plan's `metadata.targetRepo` — so the task silently ran in the wrong
 * repo, and nothing on screen had ever named a target either way.
 *
 * The payload build is exported precisely so this is testable: the bug
 * was a MISSING field, invisible in every rendering, observable only in
 * the dispatched command.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import {
    buildScopedTaskCommandPayload,
    scopedProposalRepo,
} from './scoped-chat';

const proposal = (extra: Record<string, unknown> = {}): {
    kind: string;
    [key: string]: unknown;
} => ({
    kind: 'task',
    type: 'implement',
    title: 'Add the roleId filter',
    description: 'Filter allowances by roleId.',
    ...extra,
});

test('a proposal naming a repo puts it on the command', () => {
    const payload = buildScopedTaskCommandPayload(
        proposal({ repoId: 'corelib' }),
        'plan-7',
    );
    assert.equal(payload.repoId, 'corelib');
    assert.equal(payload.planId, 'plan-7', 'the task still joins the scoped plan');
    assert.equal(payload.taskType, 'implement');
    assert.equal(payload.flowId, 'implement');
});

test('a proposal naming no repo OMITS the key entirely', () => {
    // Not `repoId: ''` — the CreateTask handler guards on
    // `typeof … === 'string' && length > 0`, so an empty string would be
    // dropped anyway, but omitting says what is meant: fall back to the
    // plan's targetRepo.
    const payload = buildScopedTaskCommandPayload(proposal(), 'plan-7');
    assert.ok(!('repoId' in payload), 'absent repo must not appear as a key');
});

test('a blank or whitespace repo is treated as absent', () => {
    for (const raw of ['', '   ', '\t']) {
        const payload = buildScopedTaskCommandPayload(proposal({ repoId: raw }), 'plan-7');
        assert.ok(!('repoId' in payload), JSON.stringify(raw));
    }
});

test('a repo id is trimmed', () => {
    const payload = buildScopedTaskCommandPayload(
        proposal({ repoId: '  catalog  ' }),
        'plan-7',
    );
    assert.equal(payload.repoId, 'catalog');
});

test('a non-string repo is ignored rather than stringified', () => {
    // LLM output is hostile input: `Repo: 42` must not become the repo id
    // "42" and send the task to a repo that does not exist.
    for (const raw of [42, null, undefined, {}, ['a']]) {
        const payload = buildScopedTaskCommandPayload(proposal({ repoId: raw }), 'plan-7');
        assert.ok(!('repoId' in payload), JSON.stringify(raw ?? null));
    }
});

test('missing title/description degrade to empty strings, not "undefined"', () => {
    const payload = buildScopedTaskCommandPayload({ kind: 'task' }, 'plan-7');
    assert.equal(payload.title, '');
    assert.equal(payload.description, '');
    // The pane's own default when the agent omitted Type.
    assert.equal(payload.taskType, 'investigate');
    assert.equal(payload.flowId, 'investigate');
});

test('scopedProposalRepo is the single source for the chip and the payload', () => {
    // The chip label and the command must never disagree about the
    // target — that disagreement is what made the original bug invisible.
    assert.equal(scopedProposalRepo(proposal({ repoId: 'corelib' })), 'corelib');
    assert.equal(scopedProposalRepo(proposal()), null);
    const named = proposal({ repoId: 'corelib' });
    assert.equal(
        buildScopedTaskCommandPayload(named, 'p').repoId,
        scopedProposalRepo(named),
    );
});
