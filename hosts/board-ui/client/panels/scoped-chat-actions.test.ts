/**
 * Which proposals a scoped chat pane can ACT on, per scope.
 *
 * Field report: "I can't create the plan from the chat agent in a plan or
 * architecture design — it does make a proposal but I have to go to the
 * main chat window to actually start it."
 *
 * Two separate holes produced that one symptom:
 *
 *  1. Every branch of the chip renderer was guarded on a specific scope,
 *     and the `task` branch required `scopeKind === 'plan'`. In a design
 *     (requirement) chat a task proposal therefore matched NOTHING and
 *     fell through to a fallback that renders a head line and no button:
 *     "Proposal (task) — confirm it from the main chat window." The
 *     proposal was visible and impossible to apply.
 *  2. Even in a plan scope, a task proposal only ever offered "Add task
 *     to this plan". Creating a plan is not a command — it is CreatePlan
 *     plus a chat-session link plus a GeneratePlan POST — so the pane,
 *     which is handed only a command dispatcher, had no path to it at
 *     all. That path existed solely in the main chat window.
 *
 * This matrix is now a pure function precisely so it can be asserted
 * here. Everything else in the pane reaches it through a created session
 * and a streamed NDJSON turn, which is why the dead branch shipped
 * untested in the first place.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import {
    describeProposalChip,
    type ChipActionId,
    type ScopedChatScopeKind,
} from './scoped-chat';

function ids(
    proposal: Record<string, unknown> & { kind: string },
    scopeKind: ScopedChatScopeKind,
    canCreatePlan = true,
): ChipActionId[] {
    return describeProposalChip(proposal, scopeKind, canCreatePlan)
        .actions.map((a) => a.id);
}

const taskProposal = {
    kind: 'task',
    type: 'implement',
    title: 'Add the roleId filter',
    description: 'Filter allowances by roleId.',
};

// --- the reported bug ------------------------------------------------

test('a task proposal in a DESIGN chat can create a plan', () => {
    // Was: no actions at all, and a chip telling the operator to go
    // somewhere else.
    assert.deepEqual(ids(taskProposal, 'requirement'), ['create-plan']);
});

test('a task proposal in a REPORT chat can create a plan', () => {
    // The whole point of chatting with an investigation report: turn a
    // finding into work without retyping it into another window.
    assert.deepEqual(ids(taskProposal, 'report'), ['create-plan']);
});

test('a task proposal in a PLAN chat offers BOTH readings', () => {
    // Genuinely ambiguous — part of this plan, or separate work. Only the
    // operator knows, so neither is guessed.
    assert.deepEqual(ids(taskProposal, 'plan'), ['create-task', 'create-plan']);
});

test('adding to the open plan is offered first in a plan scope', () => {
    // It is the common case and the one the scope implies; button order
    // is the only steer the pane gives.
    const [first] = describeProposalChip(taskProposal, 'plan', true).actions;
    assert.equal(first?.id, 'create-task');
});

test('no chip ever tells the operator to go to the main window for a task', () => {
    for (const scope of ['plan', 'requirement', 'report'] as const) {
        const spec = describeProposalChip(taskProposal, scope, true);
        assert.ok(spec.actions.length > 0, `${scope} must be able to act`);
        assert.doesNotMatch(spec.head, /main chat window/i, scope);
    }
});

// --- the host seam ---------------------------------------------------

test('a host with no createPlan seam is not offered the button', () => {
    // An inert button is worse than none: it reads as a broken feature
    // rather than an absent one.
    assert.deepEqual(ids(taskProposal, 'plan', false), ['create-task']);
    assert.deepEqual(ids(taskProposal, 'requirement', false), []);
});

test('with no seam and no plan to join, the chip says where to go', () => {
    // The old fallback text is still correct in the one case it now
    // covers — a host that genuinely cannot create a plan.
    const spec = describeProposalChip(taskProposal, 'requirement', false);
    assert.equal(spec.actions.length, 0);
    assert.match(spec.head, /New implement task/);
});

// --- the existing scope-specific kinds still behave ------------------

test('plan-update applies only in a plan scope', () => {
    const p = { kind: 'plan-update', summary: 's', body: 'b' };
    assert.deepEqual(ids(p, 'plan'), ['plan-revision']);
    for (const scope of ['requirement', 'report'] as const) {
        assert.deepEqual(ids(p, scope), [], scope);
        assert.match(describeProposalChip(p, scope, true).head, /main chat window/);
    }
});

test('requirement-update applies only in a design scope', () => {
    const p = { kind: 'requirement-update', description: 'd' };
    assert.deepEqual(ids(p, 'requirement'), ['requirement-update']);
    assert.deepEqual(ids(p, 'plan'), []);
    assert.deepEqual(ids(p, 'report'), []);
});

test('plan-repo applies only in a plan scope', () => {
    const p = { kind: 'plan-repo', repoId: 'corelib' };
    assert.deepEqual(ids(p, 'plan'), ['set-plan-repo']);
    assert.deepEqual(ids(p, 'report'), []);
});

test('task-update needs a taskId, not a scope', () => {
    // Scope-independent by design: it names its own target, and a report
    // chat can legitimately refine the task it is discussing.
    const p = { kind: 'task-update', taskId: 'L-ABC-001', title: 'Tighter title' };
    for (const scope of ['plan', 'requirement', 'report'] as const) {
        assert.deepEqual(ids(p, scope), ['task-update'], scope);
    }
    // Without a taskId there is nothing to edit — no button.
    assert.deepEqual(ids({ kind: 'task-update', title: 'x' }, 'plan'), []);
});

test('an unknown kind is information, never a button', () => {
    const spec = describeProposalChip({ kind: 'config', target: 'pipeline' }, 'plan', true);
    assert.deepEqual(spec.actions, []);
    assert.match(spec.head, /Proposal \(config\)/);
});

// --- what the chip SAYS ----------------------------------------------

test('a cross-repo task names the repo in the head and the button', () => {
    // The case worth a second look before confirming, and it used to be
    // invisible on both.
    const spec = describeProposalChip(
        { ...taskProposal, repoId: 'corelib' },
        'plan',
        true,
    );
    assert.match(spec.head, /→ corelib/);
    assert.match(spec.actions[0]!.label, /corelib/);
});

test('the create-plan label distinguishes the two plan-scope readings', () => {
    const inPlan = describeProposalChip(taskProposal, 'plan', true).actions;
    assert.match(inPlan[1]!.label, /separate plan/i);
    // With no plan in scope there is nothing to be separate FROM.
    const inDesign = describeProposalChip(taskProposal, 'requirement', true).actions;
    assert.match(inDesign[0]!.label, /Create plan/i);
});

test('the body preview carries the proposal description', () => {
    for (const scope of ['plan', 'requirement', 'report'] as const) {
        assert.equal(
            describeProposalChip(taskProposal, scope, true).body,
            'Filter allowances by roleId.',
            scope,
        );
    }
});
