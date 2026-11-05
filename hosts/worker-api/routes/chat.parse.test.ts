import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    CORE_PROPOSAL_VOCABULARY,
    parseTaskProposals,
    parseProposals,
    parseProposalsDetailed,
    composeTurnPrompt,
    buildTranscriptBlock,
    vocabularyFromCatalog,
    type TaskTypeVocabulary,
} from './chat';
import { loadLayeredFlows } from '../../../core/flow/loader';
import { TaskTypeCatalog } from '../../../core/flow/task-types';
import { stripProposalBlocks } from '../../board-ui/client/chat-body';
import type { ChatMessage } from '../../../adapters/state/SqliteChatSessionStore';

function msg(role: 'user' | 'assistant' | 'system', body: string): ChatMessage {
    return { id: 'm', sessionId: 's', role, body, createdAt: 0 } as unknown as ChatMessage;
}

test('parses a fenced PROPOSE_TASK block', () => {
    const text = [
        'Sure, I can set that up. Here is what I propose:',
        '',
        '```',
        'PROPOSE_TASK',
        'Title: Add ILogger to OrderService',
        'Type: implement',
        'Description: Inject ILogger<OrderService> via the constructor and',
        'log at info on each public method. Acceptance: existing tests pass.',
        '```',
    ].join('\n');
    const proposals = parseTaskProposals(text);
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0].title, 'Add ILogger to OrderService');
    assert.equal(proposals[0].type, 'implement');
    assert.match(proposals[0].description, /Inject ILogger/);
    assert.match(proposals[0].description, /Acceptance: existing tests pass\./);
});

test('parses an unfenced PROPOSE_TASK block', () => {
    const text = [
        'Proposing:',
        'PROPOSE_TASK',
        'Title: Refactor the queue reader',
        'Type: refactor',
        'Description: Extract the polling loop into its own class.',
    ].join('\n');
    const proposals = parseTaskProposals(text);
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0].type, 'refactor');
    assert.equal(proposals[0].description, 'Extract the polling loop into its own class.');
});

test('PROPOSE_TASK Project:/Repo: fields target another project', () => {
    const text = [
        'This is really a framework bug - proposing it there:',
        '',
        'PROPOSE_TASK',
        'Title: Fix null branch id in CrudRepository',
        'Type: implement',
        'Project: infrastructure',
        'Repo: infrastructure',
        'Description: GetQueryable drops the branch filter when id is null.',
    ].join(String.fromCharCode(10));
    const proposals = parseTaskProposals(text);
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0].projectId, 'infrastructure');
    assert.equal(proposals[0].repoId, 'infrastructure');
    assert.match(proposals[0].description, /branch filter/);
});

test('PROPOSE_TASK without Project/Repo leaves the fields absent', () => {
    const proposals = parseTaskProposals(
        ['PROPOSE_TASK', 'Title: T', 'Description: D'].join(String.fromCharCode(10)),
    );
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0].projectId, undefined);
    assert.equal(proposals[0].repoId, undefined);
});

test('normalises an unknown type to implement', () => {
    const text = [
        'PROPOSE_TASK',
        'Title: Do a thing',
        'Type: wat',
        'Description: stuff',
    ].join('\n');
    const proposals = parseTaskProposals(text);
    assert.equal(proposals[0].type, 'implement');
});

test('returns empty for a plain answer with no block', () => {
    assert.deepEqual(
        parseTaskProposals('The OrderService lives in src/orders/OrderService.ts.'),
        [],
    );
});

test('drops a block with no title', () => {
    const text = ['PROPOSE_TASK', 'Type: implement', 'Description: orphan'].join('\n');
    assert.deepEqual(parseTaskProposals(text), []);
});

test('parses two PROPOSE_TASK blocks', () => {
    const text = [
        'PROPOSE_TASK',
        'Title: First',
        'Type: implement',
        'Description: one',
        '',
        'PROPOSE_TASK',
        'Title: Second',
        'Type: document',
        'Description: two',
    ].join('\n');
    const proposals = parseTaskProposals(text);
    assert.equal(proposals.length, 2);
    assert.equal(proposals[0].title, 'First');
    assert.equal(proposals[1].title, 'Second');
    assert.equal(proposals[1].type, 'document');
});

test('task proposals carry kind="task"', () => {
    const proposals = parseProposals(
        ['PROPOSE_TASK', 'Title: T', 'Type: implement', 'Description: d'].join('\n'),
    );
    assert.equal(proposals[0].kind, 'task');
});

test('accepts investigate as a task type', () => {
    const proposals = parseTaskProposals(
        ['PROPOSE_TASK', 'Title: Why is X slow', 'Type: investigate', 'Description: dig in'].join('\n'),
    );
    assert.equal(proposals[0].type, 'investigate');
});

test('parses a PROPOSE_PROJECT_UPDATE with a description', () => {
    const text = [
        '```',
        'PROPOSE_PROJECT_UPDATE',
        'Description: The shop orders domain.',
        '```',
    ].join('\n');
    const proposals = parseProposals(text);
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0].kind, 'project-update');
    const p = proposals[0] as { kind: 'project-update'; description: string };
    assert.equal(p.description, 'The shop orders domain.');
});

test('drops a project-update block with no description', () => {
    const proposals = parseProposals(
        ['PROPOSE_PROJECT_UPDATE', 'Nonsense: x'].join('\n'),
    );
    assert.deepEqual(proposals, []);
});

test('parses a PROPOSE_ACTION (merge) block', () => {
    const text = [
        'It looks ready. Want me to merge it?',
        '```',
        'PROPOSE_ACTION',
        'Action: merge',
        'Task: T-CSFH-002',
        '```',
    ].join('\n');
    const proposals = parseProposals(text);
    assert.equal(proposals.length, 1);
    const p = proposals[0] as { kind: string; action?: string; taskId?: string };
    assert.equal(p.kind, 'action');
    assert.equal(p.action, 'merge');
    assert.equal(p.taskId, 'T-CSFH-002');
});

test('PROPOSE_ACTION normalises case and accepts all four actions', () => {
    for (const action of ['merge', 'approve', 'retry', 'dismiss']) {
        const text = ['PROPOSE_ACTION', `Action: ${action.toUpperCase()}`, 'Task: T-1'].join('\n');
        const proposals = parseProposals(text);
        assert.equal(proposals.length, 1, `${action} should parse`);
        assert.equal((proposals[0] as { action: string }).action, action);
    }
});

test('drops a PROPOSE_ACTION with an unknown action or missing task', () => {
    assert.deepEqual(
        parseProposals(['PROPOSE_ACTION', 'Action: explode', 'Task: T-1'].join('\n')),
        [],
    );
    assert.deepEqual(
        parseProposals(['PROPOSE_ACTION', 'Action: merge'].join('\n')),
        [],
    );
});

test('a create-intent PROPOSE_ACTION with a Title is salvaged into a task proposal', () => {
    const text = [
        'PROPOSE_ACTION',
        'Action: create_task',
        'Title: Add RoleId filter to allowance list',
        'Type: planner',
        'Description: filter the loan allowance list API by RoleId',
    ].join('\n');
    const { proposals, warnings } = parseProposalsDetailed(text);
    assert.equal(warnings.length, 0);
    assert.equal(proposals.length, 1);
    assert.deepEqual(proposals[0], {
        kind: 'task',
        title: 'Add RoleId filter to allowance list',
        type: 'implement', // 'planner' synonym normalises to implement
        description: 'filter the loan allowance list API by RoleId',
    });
});

test('dropped blocks produce actionable warnings instead of vanishing', () => {
    const unknownAction = parseProposalsDetailed(
        ['PROPOSE_ACTION', 'Action: explode', 'Task: T-1'].join('\n'),
    );
    assert.equal(unknownAction.proposals.length, 0);
    assert.equal(unknownAction.warnings.length, 1);
    assert.match(unknownAction.warnings[0] ?? '', /PROPOSE_TASK/);

    const missingTask = parseProposalsDetailed(
        ['PROPOSE_ACTION', 'Action: merge'].join('\n'),
    );
    assert.equal(missingTask.warnings.length, 1);
    assert.match(missingTask.warnings[0] ?? '', /Task:/);

    const missingTitle = parseProposalsDetailed(
        ['PROPOSE_TASK', 'Type: implement', 'Description: x'].join('\n'),
    );
    assert.equal(missingTitle.warnings.length, 1);
    assert.match(missingTitle.warnings[0] ?? '', /Title/);

    const clean = parseProposalsDetailed(
        ['PROPOSE_TASK', 'Title: ok', 'Description: y'].join('\n'),
    );
    assert.equal(clean.warnings.length, 0);
    assert.equal(clean.proposals.length, 1);
});

test('the field-observed block shape parses: fence-glued marker, lowercase fields, kind:/body:|', () => {
    // Byte-shape of the block a live chat agent actually emitted (and
    // the parser silently ignored): marker glued to the opening fence,
    // lowercase field names, kind: instead of Type:, YAML body: |.
    const text = [
        'Yes — re-emitting the create proposal now.',
        '',
        '```PROPOSE_ACTION',
        'action: create_task',
        'kind: plan',
        'title: Add per-season order-anchored discount calculation',
        'body: |',
        '  Add a per-Period setting that switches discount anchoring',
        '  from per-product DateDelivered to per-order DateAdded.',
        '```',
    ].join('\n');
    const { proposals, warnings } = parseProposalsDetailed(text);
    assert.equal(warnings.length, 0);
    assert.equal(proposals.length, 1);
    const p = proposals[0] as { kind: string; title: string; type: string; description: string };
    assert.equal(p.kind, 'task');
    assert.equal(p.title, 'Add per-season order-anchored discount calculation');
    assert.equal(p.type, 'implement'); // kind: plan → planner flow
    assert.ok(p.description.includes('per-Period setting'));
    assert.ok(!p.description.startsWith('|'), 'YAML pipe marker must not leak into the brief');
});

test('task type synonyms normalise (feature/plan/docs/research)', () => {
    const cases: Array<[string, string]> = [
        ['feature', 'implement'],
        ['plan', 'implement'],
        ['docs', 'document'],
        ['research', 'investigate'],
        ['tests', 'integration-test'],
    ];
    for (const [raw, expected] of cases) {
        const text = ['PROPOSE_TASK', 'Title: t', `Type: ${raw}`].join('\n');
        const p = parseProposals(text)[0] as { type: string };
        assert.equal(p.type, expected, raw);
    }
});

test('PROPOSE_CONFIG_CHANGE parses targets, verbatim body, and agent fields', () => {
    const flowChange = parseProposalsDetailed([
        'PROPOSE_CONFIG_CHANGE',
        'Target: flow:implement',
        'Summary: add a docs step',
        'Body:',
        'on: TaskApproved',
        'steps:',
        '  - id: develop',
    ].join('\n'));
    assert.equal(flowChange.warnings.length, 0);
    assert.deepEqual(flowChange.proposals[0], {
        kind: 'config',
        target: 'flow:implement',
        summary: 'add a docs step',
        body: 'on: TaskApproved\nsteps:\n  - id: develop',
    });

    const agentChange = parseProposalsDetailed([
        'PROPOSE_CONFIG_CHANGE',
        'Target: agent:reviewer',
        'Summary: pin reviewer to opus',
        'Model: claude-opus-4-8',
    ].join('\n'));
    assert.equal(agentChange.warnings.length, 0);
    const a = agentChange.proposals[0] as { kind: string; model?: string };
    assert.equal(a.kind, 'config');
    assert.equal(a.model, 'claude-opus-4-8');

    // Secret settings may omit the Body — the operator enters the value.
    const secretSetting = parseProposalsDetailed([
        'PROPOSE_CONFIG_CHANGE',
        'Target: setting:LINEAR_API_KEY',
        'Summary: set the Linear key',
    ].join('\n'));
    assert.equal(secretSetting.warnings.length, 0);
    assert.equal(secretSetting.proposals.length, 1);
});

test('PROPOSE_CONFIG_CHANGE rejects bad targets / missing body with warnings', () => {
    const badTarget = parseProposalsDetailed([
        'PROPOSE_CONFIG_CHANGE',
        'Target: database:main',
        'Body:',
        'x',
    ].join('\n'));
    assert.equal(badTarget.proposals.length, 0);
    assert.match(badTarget.warnings[0] ?? '', /not one of/);

    const missingBody = parseProposalsDetailed([
        'PROPOSE_CONFIG_CHANGE',
        'Target: flow:implement',
        'Summary: s',
    ].join('\n'));
    assert.equal(missingBody.proposals.length, 0);
    assert.match(missingBody.warnings[0] ?? '', /COMPLETE new file content/);

    const agentNoFields = parseProposalsDetailed([
        'PROPOSE_CONFIG_CHANGE',
        'Target: agent:reviewer',
    ].join('\n'));
    assert.equal(agentNoFields.proposals.length, 0);
    assert.match(agentNoFields.warnings[0] ?? '', /Model.*Provider/);
});

test('parseProposals returns task + project-update together in order', () => {
    const text = [
        'PROPOSE_TASK',
        'Title: First',
        'Type: implement',
        'Description: one',
        '',
        'PROPOSE_PROJECT_UPDATE',
        'Description: a better project description',
    ].join('\n');
    const proposals = parseProposals(text);
    assert.equal(proposals.length, 2);
    assert.equal(proposals[0].kind, 'task');
    assert.equal(proposals[1].kind, 'project-update');
});

// composeTurnPrompt: the live board state must travel over stdin (not
// argv), so it is folded into the prompt sent to claude rather than the
// --append-system-prompt slot. These guard that contract.

test('composeTurnPrompt with no state returns the raw message', () => {
    assert.equal(composeTurnPrompt('what is the status?', ''), 'what is the status?');
    assert.equal(composeTurnPrompt('hi', '   \n  '), 'hi');
});

// buildTranscriptBlock + composeTurnPrompt memory: the agent must be able
// to refer back to earlier turns even though claude --resume is unreliable
// across headless spawns — the stored chat_messages are the source of truth.

test('buildTranscriptBlock returns empty for no messages', () => {
    assert.equal(buildTranscriptBlock([]), '');
});

test('buildTranscriptBlock labels roles and keeps chronological order', () => {
    const out = buildTranscriptBlock([
        msg('user', 'how do I fix the login bug?'),
        msg('assistant', 'I propose adding a null check in AuthService.'),
        msg('system', 'Plan P-1 decomposed into 3 tasks.'),
    ]);
    assert.match(out, /Operator: how do I fix the login bug\?/);
    assert.match(out, /You \(assistant\): I propose adding a null check/);
    assert.match(out, /\[note\]: Plan P-1 decomposed/);
    // chronological: the first question precedes the assistant reply.
    assert.ok(out.indexOf('how do I fix') < out.indexOf('null check'));
});

test('composeTurnPrompt carries the transcript so a referred-back proposal survives', () => {
    const transcript = buildTranscriptBlock([
        msg('user', 'first question about the cache'),
        msg('assistant', 'PROPOSE_TASK\nTitle: Add cache eviction\nType: implement'),
    ]);
    const out = composeTurnPrompt('what about that fix you proposed?', '', transcript);
    assert.match(out, /<conversation-so-far>/);
    assert.match(out, /Add cache eviction/);
    assert.match(out, /what about that fix you proposed\?/);
    // The transcript precedes the new operator message.
    assert.ok(out.indexOf('Add cache eviction') < out.indexOf('what about that fix'));
});

test('composeTurnPrompt with neither state nor transcript returns the raw message', () => {
    assert.equal(composeTurnPrompt('hi', '', ''), 'hi');
});

test('composeTurnPrompt embeds the state block before the message', () => {
    const state = '# Current pipeline state\nTasks:\n- T-AATD-002 [implement] running';
    const out = composeTurnPrompt('merge my last task', state);
    assert.match(out, /<pipeline-state>/);
    assert.match(out, /T-AATD-002/);
    assert.match(out, /<\/pipeline-state>/);
    // The operator's message comes after the state preamble.
    assert.ok(
        out.indexOf('T-AATD-002') < out.indexOf('merge my last task'),
        'state must precede the operator message',
    );
});

// ---------------------------------------------------------------------------
// Structural guard: the board send path must delegate the WHOLE turn to the
// shared ChatService (runTurnStreaming on the `board` channel) instead of
// carrying a private inline copy of the claude runtime. A cosmetic
// "delegation" that renamed or left the old runClaudeStreaming /
// defaultClaudeRunner / parseStreamJson in place would silently let the board
// and Telegram surfaces drift on the read-only posture and interrupt
// semantics — so we inspect the route source directly (fs.readFileSync), where
// neither an unchanged inline runtime nor a passing parser test can fool a
// reviewer or tester.
// ---------------------------------------------------------------------------

const CHAT_ROUTE_SOURCE = fs.readFileSync(path.join(__dirname, 'chat.ts'), 'utf8');

test('the send path invokes runTurnStreaming with channelId === sessionId (per session)', () => {
    // The whole turn runs through the shared service, keyed by THIS chat
    // session — not a shared 'board' constant. The chat-service seed only
    // applies when a channel row is first created, so one global 'board'
    // channel permanently pinned every later chat to whatever cwd the FIRST
    // board session ever had; the operator's project/repo selection was
    // silently ignored (field case: agent answering "rooted in
    // dropagents" with the products repo selected).
    assert.match(
        CHAT_ROUTE_SOURCE,
        /runTurnStreaming\(\s*\{\s*channelId:\s*sessionId/,
        'handleSendMessage must call chatService.runTurnStreaming with channelId: sessionId',
    );
    // The shared 'board' constant must NOT come back as the channel key.
    assert.ok(
        !/channelId:\s*BOARD_CHANNEL_ID/.test(CHAT_ROUTE_SOURCE),
        'the shared BOARD_CHANNEL_ID must not be used as the channel key',
    );
});

test('the route no longer declares an inline claude runtime', () => {
    // These three were the duplicated runtime the shared service now owns.
    // Their total absence (declarations AND references) proves the delegation
    // is real, not a rename over an unchanged inline copy.
    for (const banned of ['runClaudeStreaming', 'defaultClaudeRunner', 'parseStreamJson']) {
        assert.ok(
            !CHAT_ROUTE_SOURCE.includes(banned),
            `routes/chat.ts must not reference ${banned} — the inline runtime is deleted`,
        );
    }
});

/** The vocabulary the host builds from core + the dotnet-azure pack. */
function installedVocabulary(): TaskTypeVocabulary {
    const repo = path.resolve(__dirname, '..', '..', '..');
    return vocabularyFromCatalog(
        TaskTypeCatalog.fromFlows(
            loadLayeredFlows([
                path.join(repo, 'config', 'flows'),
                path.join(repo, 'packs', 'dotnet-azure', 'flows'),
            ]),
        ),
    );
}

test('diagnose-azure is proposable with its synonyms when the pack is on', () => {
    // `diagnose-azure` belongs to the dotnet-azure pack, so it reaches the
    // parser through the install's vocabulary rather than a set compiled
    // into core. The host passes exactly this.
    const vocab = installedVocabulary();
    const direct = parseTaskProposals(
        ['PROPOSE_TASK', 'Title: Check prd for 500s', 'Type: diagnose-azure', 'Description: D'].join(
            String.fromCharCode(10),
        ),
        vocab,
    );
    assert.equal(direct[0]!.type, 'diagnose-azure');
    for (const word of ['diagnose', 'diagnosis', 'diagnostics']) {
        const synonym = parseTaskProposals(
            ['PROPOSE_TASK', 'Title: T', `Type: ${word}`, 'Description: D'].join(String.fromCharCode(10)),
            vocab,
        );
        assert.equal(synonym[0]!.type, 'diagnose-azure', `"${word}" must mean diagnose-azure`);
    }
});

test('with no pack, a pack type falls back rather than being proposable', () => {
    // Core alone must not accept a type it does not ship. `implement` is
    // the documented fallback for an unknown type — the point is that core
    // names no stack type, not that diagnose-azure stops existing.
    const coreOnly = parseTaskProposals(
        ['PROPOSE_TASK', 'Title: T', 'Type: diagnose-azure', 'Description: D'].join(String.fromCharCode(10)),
    );
    assert.equal(coreOnly[0]!.type, 'implement');
});

test('the flow-declared vocabulary reproduces the old hardcoded tables exactly', () => {
    // The regression this guards: `chat_proposable` / `synonyms` now live on
    // the flows, and a declaration drifting from what chat used to accept
    // would silently change which proposals the operator can confirm.
    // These are the two tables that used to sit in chat.ts verbatim.
    const vocab = installedVocabulary();
    assert.deepEqual([...vocab.types].sort(), [
        'diagnose-azure', 'document', 'implement', 'integration-test', 'investigate', 'refactor',
    ]);
    assert.deepEqual(Object.fromEntries([...vocab.synonyms].sort()), {
        audit: 'investigate',
        bug: 'implement',
        diagnose: 'diagnose-azure',
        diagnosis: 'diagnose-azure',
        diagnostics: 'diagnose-azure',
        docs: 'document',
        documentation: 'document',
        feature: 'implement',
        fix: 'implement',
        investigation: 'investigate',
        plan: 'implement',
        planner: 'implement',
        research: 'investigate',
        test: 'integration-test',
        tests: 'integration-test',
    });

    // Core's fallback is the same minus the pack's contributions.
    assert.deepEqual([...CORE_PROPOSAL_VOCABULARY.types].sort(), [
        'document', 'implement', 'integration-test', 'investigate', 'refactor',
    ]);
    assert.equal(CORE_PROPOSAL_VOCABULARY.synonyms.has('diagnose'), false);
});

test('PROPOSE_CONFIG_CHANGE accepts a project-context target with a dotted id', () => {
    // Real project ids look like `example.platform`. A target regex
    // without `.` in its class rejects every one of them, and the
    // operator sees a "not a valid target" warning they cannot act on.
    const text = [
        'PROPOSE_CONFIG_CHANGE',
        'Target: project-context:example.platform',
        'Summary: record the new integrations repo',
        'Body:',
        '# Example Platform',
        '',
        'Four repos. `corelib` publishes the function host package.',
    ].join('\n');

    const { proposals, warnings } = parseProposalsDetailed(text);
    assert.deepEqual(warnings, []);
    assert.equal(proposals.length, 1);
    const p = proposals[0] as { kind: string; target: string; body?: string };
    assert.equal(p.kind, 'config');
    assert.equal(p.target, 'project-context:example.platform');
    // The body must survive verbatim — it replaces the stored text in full.
    assert.ok(p.body?.includes('`corelib` publishes'));
});

test('PROPOSE_CONFIG_CHANGE requires a body for a project-context target', () => {
    // Without this the block parses to an empty content, and an empty
    // content is how the manager-api route CLEARS a context.
    const { proposals, warnings } = parseProposalsDetailed([
        'PROPOSE_CONFIG_CHANGE',
        'Target: project-context:example.platform',
        'Summary: no body at all',
    ].join('\n'));

    assert.equal(proposals.length, 0);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /COMPLETE new file content/);
});

/**
 * Field request: "the chat agent should also be able to update existing
 * tasks." Before this the agent's only options were PROPOSE_TASK (creates
 * a whole new plan) and PROPOSE_ACTION (merge/approve/retry/dismiss), so
 * "tighten that task's scope" had no channel at all.
 */
const LF = String.fromCharCode(10);

test('parses a PROPOSE_TASK_UPDATE block with all three fields', () => {
    const { proposals, warnings } = parseProposalsDetailed([
        'I can narrow that down.',
        '',
        '```',
        'PROPOSE_TASK_UPDATE',
        'Task: T-ABCD-003',
        'Title: Add ILogger to OrderService only',
        'Description: Inject ILogger<OrderService> and log the failure path.',
        'Leave the retry policy alone.',
        'Instructions: Keep the existing public API — callers depend on it.',
        '```',
    ].join(LF));

    assert.deepEqual(warnings, []);
    assert.deepEqual(proposals[0], {
        kind: 'task-update',
        taskId: 'T-ABCD-003',
        title: 'Add ILogger to OrderService only',
        // Multi-line: the continuation line belongs to Description, and
        // `Instructions:` — a new field header — ends it.
        description: 'Inject ILogger<OrderService> and log the failure path.'
            + LF + 'Leave the retry policy alone.',
        instructions: 'Keep the existing public API — callers depend on it.',
    });
});

test('a PROPOSE_TASK_UPDATE naming only instructions leaves the other fields absent', () => {
    // An omitted field must be OMITTED, not empty: the board sends only
    // the keys present, and an empty string would blank the real column.
    const { proposals } = parseProposalsDetailed([
        'PROPOSE_TASK_UPDATE',
        'Task: T-ABCD-003',
        'Instructions: Ask before touching the migration files.',
    ].join(LF));

    assert.deepEqual(proposals[0], {
        kind: 'task-update',
        taskId: 'T-ABCD-003',
        instructions: 'Ask before touching the migration files.',
    });
});

test('a PROPOSE_TASK_UPDATE without a Task id warns instead of vanishing', () => {
    const { proposals, warnings } = parseProposalsDetailed([
        'PROPOSE_TASK_UPDATE',
        'Title: something',
    ].join(LF));

    assert.equal(proposals.length, 0);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /Task: field is/);
});

test('a PROPOSE_TASK_UPDATE that changes nothing warns instead of vanishing', () => {
    // A no-op block would otherwise render a confirm chip that applies
    // nothing — worse than an error, because it looks like it worked.
    const { proposals, warnings } = parseProposalsDetailed([
        'PROPOSE_TASK_UPDATE',
        'Task: T-ABCD-003',
    ].join(LF));

    assert.equal(proposals.length, 0);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /T-ABCD-003/);
    assert.match(warnings[0], /changed nothing/);
});

test('a task-update block is stripped from the prose body', () => {
    // The board renders the reply text and the confirm card. A block the
    // stripper does not know shows up as both — the duplication the
    // operator already reported once for PROPOSE_TASK.
    const body = [
        'Narrowing the scope:',
        'PROPOSE_TASK_UPDATE',
        'Task: T-ABCD-003',
        'Title: Narrower title',
    ].join(LF);
    assert.equal(stripProposalBlocks(body).trim(), 'Narrowing the scope:');
});

/**
 * "Allow chat agents to set the target repo for a plan." The plan's
 * `metadata.targetRepo` picks the worktree for every task under it that
 * carries no repo of its own, and the agent — which has just read the plan
 * and the workspace catalog — is often the one who notices it points at the
 * wrong codebase.
 */
test('parses a PROPOSE_PLAN_REPO block', () => {
    const { proposals, warnings } = parseProposalsDetailed([
        'That plan describes catalog work but targets shop.',
        '',
        '```',
        'PROPOSE_PLAN_REPO',
        'Plan: pl-1234',
        'Repo: catalog',
        '```',
    ].join(LF));

    assert.deepEqual(warnings, []);
    assert.deepEqual(proposals[0], {
        kind: 'plan-repo',
        planId: 'pl-1234',
        repoId: 'catalog',
    });
});

test('`Repo: none` CLEARS the target repo rather than being treated as a repo id', () => {
    const { proposals } = parseProposalsDetailed([
        'PROPOSE_PLAN_REPO',
        'Plan: pl-1234',
        'Repo: none',
    ].join(LF));

    assert.deepEqual(proposals[0], { kind: 'plan-repo', planId: 'pl-1234', repoId: '' });
});

test('a plan-scoped block may omit Plan: — the session scope fills it', () => {
    // Omitting the key entirely (rather than sending '') matters: the
    // worker only fills a MISSING planId from the scope.
    const { proposals } = parseProposalsDetailed([
        'PROPOSE_PLAN_REPO',
        'Repo: catalog',
    ].join(LF));

    assert.deepEqual(proposals[0], { kind: 'plan-repo', repoId: 'catalog' });
});

test('a PROPOSE_PLAN_REPO with no Repo: line warns instead of vanishing', () => {
    // Distinguishing "clear it" from "the field is missing" is the whole
    // point — a missing field is a malformed block, not an intent.
    const { proposals, warnings } = parseProposalsDetailed([
        'PROPOSE_PLAN_REPO',
        'Plan: pl-1234',
    ].join(LF));

    assert.equal(proposals.length, 0);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /Repo: field is/);
    assert.match(warnings[0], /none/);
});

test('a plan-repo block is stripped from the prose body', () => {
    const body = [
        'That plan is aimed at the wrong repo:',
        'PROPOSE_PLAN_REPO',
        'Plan: pl-1234',
        'Repo: catalog',
    ].join(LF);
    assert.equal(stripProposalBlocks(body).trim(), 'That plan is aimed at the wrong repo:');
});

/**
 * Field request: "the chat agent for the planner and architecture design
 * only creates 1 task at a time. It should be able to create multiple by
 * showing multiple task cards with each an apply button."
 *
 * The parser and both chat surfaces already handled N proposals — the cap
 * was the persona ("emit at most one proposal block per reply"). These
 * pin the parsing behaviour the relaxed rule now depends on, because a
 * multi-block reply has a failure mode a single-block one does not: one
 * block's multi-line Description running on into the next block.
 */
test('several PROPOSE_TASK blocks in one reply parse as several proposals', () => {
    const { proposals, warnings } = parseProposalsDetailed([
        'Three pieces of work fall out of this:',
        '',
        '```',
        'PROPOSE_TASK',
        'Title: Add the ILogger',
        'Type: implement',
        'Description: Inject ILogger<OrderService>.',
        'Log the failure path too.',
        '```',
        '',
        '```',
        'PROPOSE_TASK',
        'Title: Cover it with tests',
        'Type: integration-test',
        'Description: Assert the failure path logs.',
        '```',
    ].join(LF));

    assert.deepEqual(warnings, []);
    assert.equal(proposals.length, 2);
    assert.deepEqual(proposals[0], {
        kind: 'task',
        title: 'Add the ILogger',
        type: 'implement',
        // The continuation line belongs to THIS block and stops at its fence.
        description: 'Inject ILogger<OrderService>.' + LF + 'Log the failure path too.',
    });
    assert.deepEqual(proposals[1], {
        kind: 'task',
        title: 'Cover it with tests',
        type: 'integration-test',
        description: 'Assert the failure path logs.',
    });
});

test('an unfenced block ENDS at the next marker rather than swallowing it', () => {
    // The dangerous shape: Description reads to the end of its block, so
    // without the marker acting as a terminator the first task would
    // absorb the second and the operator would get one card.
    const { proposals } = parseProposalsDetailed([
        'PROPOSE_TASK',
        'Title: First',
        'Type: implement',
        'Description: Do the first thing.',
        'PROPOSE_TASK',
        'Title: Second',
        'Type: document',
        'Description: Do the second thing.',
    ].join(LF));

    assert.equal(proposals.length, 2);
    assert.equal(
        (proposals[0] as { description: string }).description,
        'Do the first thing.',
        'the first description must not run into the second block',
    );
    assert.equal((proposals[1] as { title: string }).title, 'Second');
});

test('mixed proposal kinds in one reply all survive', () => {
    // "implement it, then point the plan at the right repo" is one reply
    // with two different block types.
    const { proposals } = parseProposalsDetailed([
        'PROPOSE_TASK',
        'Title: Add the widget',
        'Type: implement',
        'Description: Build it.',
        'PROPOSE_PLAN_REPO',
        'Plan: pl-1234',
        'Repo: catalog',
    ].join(LF));

    assert.equal(proposals.length, 2);
    assert.equal(proposals[0].kind, 'task');
    assert.equal(proposals[1].kind, 'plan-repo');
});

test('one malformed block does not take the good ones down with it', () => {
    // Partial success with a visible warning beats dropping the whole
    // reply because the model fumbled one field.
    const { proposals, warnings } = parseProposalsDetailed([
        'PROPOSE_TASK',
        'Title: Good one',
        'Type: implement',
        'Description: Fine.',
        'PROPOSE_PLAN_REPO',
        'Plan: pl-1234',
        'PROPOSE_TASK',
        'Title: Also good',
        'Type: document',
        'Description: Also fine.',
    ].join(LF));

    assert.equal(proposals.length, 2);
    assert.equal((proposals[0] as { title: string }).title, 'Good one');
    assert.equal((proposals[1] as { title: string }).title, 'Also good');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /Repo: field is/);
});

test('every block is stripped from the prose body, not just the first', () => {
    // The stripper walks marker to marker; a missed one renders the raw
    // block as prose next to its own card.
    const body = [
        'Two things:',
        'PROPOSE_TASK',
        'Title: First',
        'Type: implement',
        'Description: One.',
        'PROPOSE_TASK',
        'Title: Second',
        'Type: document',
        'Description: Two.',
    ].join(LF);
    assert.equal(stripProposalBlocks(body).trim(), 'Two things:');
});
