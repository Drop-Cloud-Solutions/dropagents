import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import type { Command } from './command';
import {
    InMemoryPlanGenerationGate,
    PlanLifecycleCommands,
    PlanLifecycleEvents,
    createDecomposePlanHandler,
    createGeneratePlanHandler,
    createSubmitBriefHandler,
    isDecomposePlanPayload,
    isGeneratePlanPayload,
    isPlanConventions,
    isSubmitBriefPayload,
    type BriefSubmittedEventPayload,
    type DecomposePlanPayload,
    type GeneratePlanPayload,
    type PlanConventions,
    type PlanDecomposedEventPayload,
    type PlanGeneratedEventPayload,
    type SubmitBriefPayload,
} from './index';

function makeCommand<TPayload>(
    type: string,
    payload: TPayload,
    actor = 'operator-1',
): Command<TPayload> {
    return { type, actor, issuedAt: 1_700_000_000_000, payload };
}

// ---------------------------------------------------------------------------
// Payload validation
// ---------------------------------------------------------------------------

test('isPlanConventions accepts an empty object and any subset of string fields', () => {
    assert.equal(isPlanConventions({}), true);
    assert.equal(isPlanConventions({ namespace_root: 'core' }), true);
    assert.equal(
        isPlanConventions({
            namespace_root: 'core',
            test_framework: 'vitest',
            branch_pattern: 'feature/{slug}',
            commit_pattern: '{type}({scope}): {subject}',
        }),
        true,
    );
});

test('isPlanConventions rejects non-string fields, arrays, and non-objects', () => {
    assert.equal(isPlanConventions({ namespace_root: 7 }), false);
    assert.equal(isPlanConventions([]), false);
    assert.equal(isPlanConventions(null), false);
    assert.equal(isPlanConventions('core'), false);
});

test('isSubmitBriefPayload requires briefId + projectId + content (string)', () => {
    assert.equal(
        isSubmitBriefPayload({ briefId: 'b1', projectId: 'p1', content: 'do X' }),
        true,
    );
    assert.equal(isSubmitBriefPayload({ briefId: '', projectId: 'p', content: '' }), false);
    assert.equal(isSubmitBriefPayload({ briefId: 'b', projectId: 'p' }), false);
    assert.equal(isSubmitBriefPayload(null), false);
});

test('isSubmitBriefPayload accepts optional repoId + conventions', () => {
    assert.equal(
        isSubmitBriefPayload({
            briefId: 'b1',
            projectId: 'p1',
            content: 'do X',
            repoId: 'pipeline',
            conventions: { namespace_root: 'core', test_framework: 'vitest' },
        }),
        true,
    );
    assert.equal(
        isSubmitBriefPayload({
            briefId: 'b1',
            projectId: 'p1',
            content: 'do X',
            conventions: {},
        }),
        true,
    );
});

test('isSubmitBriefPayload rejects empty repoId and malformed conventions', () => {
    assert.equal(
        isSubmitBriefPayload({ briefId: 'b', projectId: 'p', content: '', repoId: '' }),
        false,
    );
    assert.equal(
        isSubmitBriefPayload({
            briefId: 'b',
            projectId: 'p',
            content: '',
            conventions: { test_framework: 5 },
        }),
        false,
    );
});

test('isGeneratePlanPayload requires planId + projectId + revision (positive integer)', () => {
    assert.equal(
        isGeneratePlanPayload({ planId: 'p', projectId: 'pr', revision: 1 }),
        true,
    );
    assert.equal(
        isGeneratePlanPayload({ planId: 'p', projectId: 'pr', revision: 3, briefId: 'b' }),
        true,
    );
    // No revision at all → invalid.
    assert.equal(isGeneratePlanPayload({ planId: 'p', projectId: 'pr' }), false);
    // Non-integer or non-positive revisions are rejected.
    assert.equal(
        isGeneratePlanPayload({ planId: 'p', projectId: 'pr', revision: 0 }),
        false,
    );
    assert.equal(
        isGeneratePlanPayload({ planId: 'p', projectId: 'pr', revision: 1.5 }),
        false,
    );
    assert.equal(
        isGeneratePlanPayload({ planId: 'p', projectId: 'pr', revision: '1' }),
        false,
    );
    assert.equal(isGeneratePlanPayload({ planId: '', projectId: 'pr', revision: 1 }), false);
    assert.equal(
        isGeneratePlanPayload({ planId: 'p', projectId: 'pr', revision: 1, briefId: 7 }),
        false,
    );
});

test('isGeneratePlanPayload accepts optional feedback + previousContent strings', () => {
    assert.equal(
        isGeneratePlanPayload({
            planId: 'p',
            projectId: 'pr',
            revision: 2,
            feedback: 'tighten scope',
            previousContent: '# Draft 1',
        }),
        true,
    );
    assert.equal(
        isGeneratePlanPayload({ planId: 'p', projectId: 'pr', revision: 2, feedback: 7 }),
        false,
    );
    assert.equal(
        isGeneratePlanPayload({
            planId: 'p',
            projectId: 'pr',
            revision: 2,
            previousContent: 9,
        }),
        false,
    );
});

test('isDecomposePlanPayload requires planId + projectId + approvedContent + conventions', () => {
    assert.equal(
        isDecomposePlanPayload({
            planId: 'p',
            projectId: 'pr',
            approvedContent: '# Approved',
            conventions: {},
        }),
        true,
    );
    assert.equal(
        isDecomposePlanPayload({ planId: 'p', projectId: 'pr', conventions: {} }),
        false,
    );
    assert.equal(
        isDecomposePlanPayload({ planId: 'p', projectId: 'pr', approvedContent: '# A' }),
        false,
    );
    assert.equal(
        isDecomposePlanPayload({
            planId: 'p',
            projectId: 'pr',
            approvedContent: '# A',
            conventions: { namespace_root: 9 },
        }),
        false,
    );
});

// ---------------------------------------------------------------------------
// SubmitBrief handler
// ---------------------------------------------------------------------------

test('SubmitBrief handler emits one BriefSubmitted event with deterministic key', async () => {
    const handler = createSubmitBriefHandler({ clock: () => 1_700_000_001_000 });
    const events = await handler(
        makeCommand<SubmitBriefPayload>(
            PlanLifecycleCommands.SUBMIT_BRIEF,
            { briefId: 'brief-1', projectId: 'proj-A', content: 'Build it' },
        ),
        undefined,
    );

    assert.equal(events.length, 1);
    const [event] = events;
    assert.equal(event.type, PlanLifecycleEvents.BRIEF_SUBMITTED);
    assert.equal(event.idempotencyKey, 'SubmitBrief:brief-1');
    assert.equal(event.occurredAt, 1_700_000_001_000);
    const payload = event.payload as BriefSubmittedEventPayload;
    assert.equal(payload.briefId, 'brief-1');
    assert.equal(payload.projectId, 'proj-A');
    assert.equal(payload.content, 'Build it');
    assert.equal(payload.actor, 'operator-1');
    assert.ok(
        !('repoId' in (payload as unknown as Record<string, unknown>)),
        'repoId must not appear when omitted',
    );
    assert.ok(
        !('conventions' in (payload as unknown as Record<string, unknown>)),
        'conventions must not appear when omitted',
    );
});

test('SubmitBrief handler threads repoId + conventions onto the event payload', async () => {
    const handler = createSubmitBriefHandler({ clock: () => 1_700_000_001_000 });
    const conventions: PlanConventions = {
        namespace_root: 'core',
        test_framework: 'vitest',
    };
    const events = await handler(
        makeCommand<SubmitBriefPayload>(
            PlanLifecycleCommands.SUBMIT_BRIEF,
            {
                briefId: 'brief-2',
                projectId: 'proj-A',
                content: 'Build it',
                repoId: 'pipeline',
                conventions,
            },
        ),
        undefined,
    );
    const payload = events[0].payload as BriefSubmittedEventPayload;
    assert.equal(payload.repoId, 'pipeline');
    assert.deepEqual(payload.conventions, conventions);
});

test('SubmitBrief handler rejects an invalid payload', async () => {
    const handler = createSubmitBriefHandler({ clock: () => 0 });
    await assert.rejects(
        handler(
            { type: 'SubmitBrief', actor: 'op', issuedAt: 0, payload: { briefId: '', projectId: '', content: '' } as SubmitBriefPayload },
            undefined,
        ),
        /invalid payload/,
    );
});

// ---------------------------------------------------------------------------
// GeneratePlan handler
// ---------------------------------------------------------------------------

test('GeneratePlan handler emits PlanGenerated with planId/projectId/actor and (optionally) briefId', async () => {
    const handler = createGeneratePlanHandler({ clock: () => 1_700_000_002_000 });
    const events = await handler(
        makeCommand<GeneratePlanPayload>(
            PlanLifecycleCommands.GENERATE_PLAN,
            { planId: 'plan-9', projectId: 'proj-A', briefId: 'brief-1', revision: 1 },
        ),
        undefined,
    );
    assert.equal(events.length, 1);
    const event = events[0];
    assert.equal(event.type, PlanLifecycleEvents.PLAN_GENERATED);
    // Idempotency key includes the revision so a follow-up generation
    // lands as a distinct event rather than de-duping against the first
    // draft.
    assert.equal(event.idempotencyKey, 'GeneratePlan:plan-9:r1');
    const payload = event.payload as PlanGeneratedEventPayload;
    assert.equal(payload.planId, 'plan-9');
    assert.equal(payload.briefId, 'brief-1');
    assert.equal(payload.revision, 1);
    assert.ok(
        !('previousRevision' in (payload as unknown as Record<string, unknown>)),
        'previousRevision absent on revision 1',
    );
});

test('GeneratePlan handler omits briefId from the event payload when none was supplied', async () => {
    const handler = createGeneratePlanHandler({ clock: () => 1_700_000_002_000 });
    const events = await handler(
        makeCommand<GeneratePlanPayload>(
            PlanLifecycleCommands.GENERATE_PLAN,
            { planId: 'plan-9', projectId: 'proj-A', revision: 1 },
        ),
        undefined,
    );
    const payload = events[0].payload as Record<string, unknown>;
    assert.ok(!('briefId' in payload), 'briefId must not be present when not supplied');
});

test('GeneratePlan handler rejects a payload with no revision', async () => {
    const handler = createGeneratePlanHandler({ clock: () => 0 });
    await assert.rejects(
        handler(
            {
                type: 'GeneratePlan',
                actor: 'op',
                issuedAt: 0,
                // Cast through unknown — the test deliberately constructs an
                // invalid payload to exercise the bus-side validator.
                payload: { planId: 'p', projectId: 'pr' } as unknown as GeneratePlanPayload,
            },
            undefined,
        ),
        /invalid payload/,
    );
});

test('GeneratePlan handler threads revision through to the event payload + idempotency key', async () => {
    const handler = createGeneratePlanHandler({ clock: () => 1_700_000_002_000 });
    const events = await handler(
        makeCommand<GeneratePlanPayload>(
            PlanLifecycleCommands.GENERATE_PLAN,
            { planId: 'plan-9', projectId: 'proj-A', revision: 3 },
        ),
        undefined,
    );
    const event = events[0];
    assert.equal(event.idempotencyKey, 'GeneratePlan:plan-9:r3');
    const payload = event.payload as PlanGeneratedEventPayload;
    assert.equal(payload.revision, 3);
    // previousRevision is derived from the command's revision so the gate
    // subscriber can correlate revisions without joining against the
    // previous event.
    assert.equal(payload.previousRevision, 2);
});

test('GeneratePlan handler threads operator feedback through to the event payload', async () => {
    const handler = createGeneratePlanHandler({ clock: () => 1_700_000_002_000 });
    const events = await handler(
        makeCommand<GeneratePlanPayload>(
            PlanLifecycleCommands.GENERATE_PLAN,
            {
                planId: 'plan-9',
                projectId: 'proj-A',
                revision: 2,
                feedback: 'tighten the scope',
                previousContent: '# Plan v1\n...',
            },
        ),
        undefined,
    );
    const payload = events[0].payload as PlanGeneratedEventPayload;
    assert.equal(payload.feedback, 'tighten the scope');
    assert.equal(payload.revision, 2);
    assert.equal(payload.previousRevision, 1);
    // previousContent feeds the planner prompt; it is intentionally NOT
    // copied onto the persisted event payload (the previous PlanGenerated
    // event already carries that body).
    assert.ok(
        !('previousContent' in (payload as unknown as Record<string, unknown>)),
        'previousContent must not leak onto the event payload',
    );
});

// ---------------------------------------------------------------------------
// DecomposePlan handler
// ---------------------------------------------------------------------------

// The key is PER DISPATCH, not per plan — `DecomposePlan:<planId>:<ts>`.
// This test asserted the per-plan form until the field incident that
// changed it: `events` has UNIQUE(idempotency_key), so a retry after a
// failed decomposition was silently swallowed and the decompose-status
// card stayed pinned on the first attempt's error forever. The test was
// never updated, so it sat red and nobody read it.
const decomposeCommand = (): Command<DecomposePlanPayload> =>
    makeCommand<DecomposePlanPayload>(
        PlanLifecycleCommands.DECOMPOSE_PLAN,
        {
            planId: 'plan-9',
            projectId: 'proj-A',
            approvedContent: '# Approved plan',
            conventions: {},
        },
    );

test('DecomposePlan handler emits PlanDecomposed keyed on the dispatch time', async () => {
    const handler = createDecomposePlanHandler({ clock: () => 1_700_000_003_000 });
    const events = await handler(decomposeCommand(), undefined);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, PlanLifecycleEvents.PLAN_DECOMPOSED);
    assert.equal(events[0].idempotencyKey, 'DecomposePlan:plan-9:1700000003000');
    assert.equal(events[0].occurredAt, 1_700_000_003_000);
    const payload = events[0].payload as PlanDecomposedEventPayload;
    assert.equal(payload.planId, 'plan-9');
    assert.equal(payload.actor, 'operator-1');
});

test('a re-decompose of the SAME plan gets its own key, so the retry lands', async () => {
    // The invariant the incident was about. Two dispatches, same plan,
    // different keys — otherwise the store dedups the second away.
    const first = await createDecomposePlanHandler({ clock: () => 1_700_000_003_000 })(
        decomposeCommand(), undefined,
    );
    const second = await createDecomposePlanHandler({ clock: () => 1_700_000_009_000 })(
        decomposeCommand(), undefined,
    );
    assert.notEqual(first[0].idempotencyKey, second[0].idempotencyKey);
});

test('DecomposePlan handler threads conventions through to the event payload', async () => {
    const handler = createDecomposePlanHandler({ clock: () => 1_700_000_003_000 });
    const conventions: PlanConventions = {
        namespace_root: 'core',
        branch_pattern: 'feature/{slug}',
    };
    const events = await handler(
        makeCommand<DecomposePlanPayload>(
            PlanLifecycleCommands.DECOMPOSE_PLAN,
            {
                planId: 'plan-9',
                projectId: 'proj-A',
                approvedContent: '# Approved plan',
                conventions,
            },
        ),
        undefined,
    );
    const payload = events[0].payload as PlanDecomposedEventPayload;
    assert.deepEqual(payload.conventions, conventions);
});

test('DecomposePlan handler rejects a payload with no approvedContent', async () => {
    const handler = createDecomposePlanHandler({ clock: () => 0 });
    await assert.rejects(
        handler(
            {
                type: 'DecomposePlan',
                actor: 'op',
                issuedAt: 0,
                payload: {
                    planId: 'p',
                    projectId: 'pr',
                    conventions: {},
                } as unknown as DecomposePlanPayload,
            },
            undefined,
        ),
        /invalid payload/,
    );
});

// ---------------------------------------------------------------------------
// InMemoryPlanGenerationGate (consumed by ApprovePlan)
// ---------------------------------------------------------------------------

test('InMemoryPlanGenerationGate gates by planId — recording is idempotent', () => {
    const gate = new InMemoryPlanGenerationGate();
    assert.equal(gate.has('plan-1'), false);
    gate.record('plan-1');
    assert.equal(gate.has('plan-1'), true);
    // Recording again is a no-op (Set semantics).
    gate.record('plan-1');
    assert.equal(gate.has('plan-1'), true);
    assert.equal(gate.has('plan-2'), false);
});
