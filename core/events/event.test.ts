import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
    isPlanArchived,
    isPlanDecomposed,
    isPlanDeleted,
    isPlanGenerated,
    isProjectApprovalOverrideUpdated,
    isTaskRetried,
    isTaskSkipped,
    type Event,
    type KnownEvent,
    type PlanArchived,
    type PlanDecomposed,
    type PlanDecomposedPayload,
    type PlanDeleted,
    type PlanGenerated,
    type PlanGeneratedPayload,
    type ProjectApprovalOverrideUpdated,
    type TaskRetried,
    type TaskSkipped,
} from './event';

/**
 * AP-PAO-002 — discriminated-union narrowing tests.
 *
 * Each block constructs the typed variant explicitly, widens it through
 * the `Event` union, then narrows it back via the exported type
 * predicate. The narrowed reference is the one the test asserts against,
 * so a regression in the discriminated typing (mismatched literal,
 * widened payload, missing predicate) surfaces as a TypeScript compile
 * error rather than a runtime miss.
 *
 * The `KnownEvent` switch at the bottom additionally exercises exhaustive
 * narrowing without the `UnknownEvent` catch-all in scope: each branch
 * pins to a specific variant and the `assertNever` default guards us
 * against forgetting to wire a new variant into the union.
 */

function baseEnvelope(): Pick<Event, 'v' | 'occurredAt' | 'idempotencyKey'> {
    return {
        v: 1,
        occurredAt: 1_700_000_000_000,
        idempotencyKey: `k-${process.pid}-${Math.random().toString(36).slice(2)}`,
    };
}

test('TaskSkipped narrows to { taskId: string } via isTaskSkipped', () => {
    const original: TaskSkipped = {
        ...baseEnvelope(),
        type: 'TaskSkipped',
        payload: { taskId: 'task-1' },
    };
    const event: Event = original;

    assert.ok(isTaskSkipped(event), 'predicate must accept the TaskSkipped variant');
    if (!isTaskSkipped(event)) return; // type narrow for the rest of the test

    assert.equal(event.type, 'TaskSkipped');
    assert.equal(event.payload.taskId, 'task-1');
});

test('TaskRetried narrows to { taskId: string } via isTaskRetried', () => {
    const original: TaskRetried = {
        ...baseEnvelope(),
        type: 'TaskRetried',
        payload: { taskId: 'task-2' },
    };
    const event: Event = original;

    assert.ok(isTaskRetried(event), 'predicate must accept the TaskRetried variant');
    if (!isTaskRetried(event)) return;

    assert.equal(event.type, 'TaskRetried');
    assert.equal(event.payload.taskId, 'task-2');
});

test('PlanArchived narrows to { planId: string } via isPlanArchived', () => {
    const original: PlanArchived = {
        ...baseEnvelope(),
        type: 'PlanArchived',
        payload: { planId: 'plan-1' },
    };
    const event: Event = original;

    assert.ok(isPlanArchived(event), 'predicate must accept the PlanArchived variant');
    if (!isPlanArchived(event)) return;

    assert.equal(event.type, 'PlanArchived');
    assert.equal(event.payload.planId, 'plan-1');
});

test('PlanDeleted narrows to { planId: string } via isPlanDeleted', () => {
    const original: PlanDeleted = {
        ...baseEnvelope(),
        type: 'PlanDeleted',
        payload: { planId: 'plan-2' },
    };
    const event: Event = original;

    assert.ok(isPlanDeleted(event), 'predicate must accept the PlanDeleted variant');
    if (!isPlanDeleted(event)) return;

    assert.equal(event.type, 'PlanDeleted');
    assert.equal(event.payload.planId, 'plan-2');
});

test('ProjectApprovalOverrideUpdated narrows to { projectId, approvalOverride }', () => {
    const original: ProjectApprovalOverrideUpdated = {
        ...baseEnvelope(),
        type: 'ProjectApprovalOverrideUpdated',
        payload: { projectId: 'proj-1', approvalOverride: 'approve' },
    };
    const event: Event = original;

    assert.ok(isProjectApprovalOverrideUpdated(event));
    if (!isProjectApprovalOverrideUpdated(event)) return;

    assert.equal(event.type, 'ProjectApprovalOverrideUpdated');
    assert.equal(event.payload.projectId, 'proj-1');
    assert.equal(event.payload.approvalOverride, 'approve');

    // `null` clears the override — exercise that branch too.
    const cleared: ProjectApprovalOverrideUpdated = {
        ...original,
        idempotencyKey: `${original.idempotencyKey}-cleared`,
        payload: { projectId: 'proj-1', approvalOverride: null },
    };
    assert.equal(cleared.payload.approvalOverride, null);
});

test('predicates reject events whose type does not match', () => {
    const skipped: TaskSkipped = {
        ...baseEnvelope(),
        type: 'TaskSkipped',
        payload: { taskId: 'task-1' },
    };

    assert.equal(isTaskRetried(skipped), false);
    assert.equal(isPlanArchived(skipped), false);
    assert.equal(isPlanDeleted(skipped), false);
    assert.equal(isProjectApprovalOverrideUpdated(skipped), false);
    assert.equal(isPlanGenerated(skipped), false);
    assert.equal(isPlanDecomposed(skipped), false);
});

// ---------------------------------------------------------------------------
// AP-VP4-001 — PlanGenerated / PlanDecomposed payload extensions
// ---------------------------------------------------------------------------

test('PlanGenerated narrows to the extended payload via isPlanGenerated', () => {
    const original: PlanGenerated = {
        ...baseEnvelope(),
        type: 'PlanGenerated',
        payload: {
            planId: 'plan-7',
            revision: 2,
            content: '# Plan body v2',
            feedback: 'tighten scope',
            previousRevision: 1,
        },
    };
    const event: Event = original;

    assert.ok(isPlanGenerated(event), 'predicate must accept the PlanGenerated variant');
    if (!isPlanGenerated(event)) return;

    assert.equal(event.type, 'PlanGenerated');
    assert.equal(event.payload.planId, 'plan-7');
    assert.equal(event.payload.revision, 2);
    assert.equal(event.payload.content, '# Plan body v2');
    assert.equal(event.payload.feedback, 'tighten scope');
    assert.equal(event.payload.previousRevision, 1);
});

test('PlanGenerated round-trips through JSON including optional fields', () => {
    const event: PlanGenerated = {
        ...baseEnvelope(),
        type: 'PlanGenerated',
        payload: {
            planId: 'plan-7',
            revision: 3,
            content: 'plan body',
            feedback: 'add tests',
            previousRevision: 2,
        },
    };

    const decoded = JSON.parse(JSON.stringify(event)) as PlanGenerated;
    assert.deepEqual(decoded, event);
    // Field-by-field guard: a regression that re-orders or coerces a
    // value would still equal-deep against itself, so check the
    // load-bearing fields explicitly.
    assert.equal(decoded.payload.revision, 3);
    assert.equal(decoded.payload.previousRevision, 2);
    assert.equal(decoded.payload.feedback, 'add tests');
});

test('PlanGenerated round-trips when optional fields are omitted on a fresh emission', () => {
    const event: PlanGenerated = {
        ...baseEnvelope(),
        type: 'PlanGenerated',
        payload: {
            planId: 'plan-7',
            revision: 1,
            content: 'first draft',
        },
    };

    const decoded = JSON.parse(JSON.stringify(event)) as PlanGenerated;
    assert.deepEqual(decoded, event);
    assert.equal(decoded.payload.revision, 1);
    assert.equal('feedback' in decoded.payload, false);
    assert.equal('previousRevision' in decoded.payload, false);
});

test('old-shape PlanGenerated without revision still deserialises (revision === undefined)', () => {
    // Pre-extension shape persisted in the event store before AP-VP4-001.
    // The producer used the legacy `{ planId, projectId, briefId?, actor }`
    // payload and never set `revision` / `content`. The chosen default for
    // the absent revision is `undefined`; consumers that need a number
    // treat that as the implicit initial revision (1).
    const legacyJson = JSON.stringify({
        type: 'PlanGenerated',
        v: 1,
        occurredAt: 1_700_000_000_000,
        idempotencyKey: 'GeneratePlan:plan-legacy',
        payload: {
            planId: 'plan-legacy',
            projectId: 'proj-A',
            briefId: 'brief-1',
            actor: 'operator-1',
        },
    });

    const decoded = JSON.parse(legacyJson) as PlanGenerated;
    assert.ok(isPlanGenerated(decoded));
    if (!isPlanGenerated(decoded)) return;

    assert.equal(decoded.payload.planId, 'plan-legacy');
    assert.equal(decoded.payload.revision, undefined);
    assert.equal(decoded.payload.content, undefined);
    assert.equal(decoded.payload.feedback, undefined);
    assert.equal(decoded.payload.previousRevision, undefined);
    // Pre-extension audit fields survive verbatim — proof that the
    // new payload shape is a superset, not a replacement.
    assert.equal(decoded.payload.projectId, 'proj-A');
    assert.equal(decoded.payload.briefId, 'brief-1');
    assert.equal(decoded.payload.actor, 'operator-1');
});

test('PlanDecomposed narrows to the extended payload via isPlanDecomposed', () => {
    const original: PlanDecomposed = {
        ...baseEnvelope(),
        type: 'PlanDecomposed',
        payload: {
            planId: 'plan-7',
            tasks: [
                {
                    id: 'task-1',
                    title: 'Write the thing',
                    type: 'implement',
                    dependencies: [],
                    description: 'do the work',
                },
                {
                    id: 'task-2',
                    title: 'Test the thing',
                    type: 'test',
                    dependencies: ['task-1'],
                    description: 'verify the work',
                    archetype: 'unit-tests',
                },
            ],
        },
    };
    const event: Event = original;

    assert.ok(isPlanDecomposed(event), 'predicate must accept the PlanDecomposed variant');
    if (!isPlanDecomposed(event)) return;

    assert.equal(event.type, 'PlanDecomposed');
    assert.equal(event.payload.planId, 'plan-7');
    assert.equal(event.payload.tasks?.length, 2);
    const second = event.payload.tasks?.[1];
    assert.equal(second?.id, 'task-2');
    assert.deepEqual(second?.dependencies, ['task-1']);
    assert.equal(second?.archetype, 'unit-tests');
});

test('PlanDecomposed round-trips through JSON preserving task ordering and optional archetype', () => {
    const tasks: PlanDecomposedPayload['tasks'] = [
        {
            id: 't-1',
            title: 'a',
            type: 'implement',
            dependencies: [],
            description: 'first',
        },
        {
            id: 't-2',
            title: 'b',
            type: 'test',
            dependencies: ['t-1'],
            description: 'second',
            archetype: 'integration',
        },
    ];
    const event: PlanDecomposed = {
        ...baseEnvelope(),
        type: 'PlanDecomposed',
        payload: { planId: 'plan-7', tasks },
    };

    const decoded = JSON.parse(JSON.stringify(event)) as PlanDecomposed;
    assert.deepEqual(decoded, event);
    assert.equal(decoded.payload.tasks?.[0]?.archetype, undefined);
    assert.equal(decoded.payload.tasks?.[1]?.archetype, 'integration');
    assert.deepEqual(decoded.payload.tasks?.[1]?.dependencies, ['t-1']);
});

test('old-shape PlanDecomposed without tasks still deserialises (tasks === undefined)', () => {
    const legacyJson = JSON.stringify({
        type: 'PlanDecomposed',
        v: 1,
        occurredAt: 1_700_000_000_000,
        idempotencyKey: 'DecomposePlan:plan-legacy',
        payload: {
            planId: 'plan-legacy',
            projectId: 'proj-A',
            actor: 'operator-1',
        },
    });

    const decoded = JSON.parse(legacyJson) as PlanDecomposed;
    assert.ok(isPlanDecomposed(decoded));
    if (!isPlanDecomposed(decoded)) return;

    assert.equal(decoded.payload.planId, 'plan-legacy');
    assert.equal(decoded.payload.tasks, undefined);
    assert.equal(decoded.payload.projectId, 'proj-A');
    assert.equal(decoded.payload.actor, 'operator-1');
});

test('PlanGeneratedPayload accepts the legacy emitter shape as a structural assignment', () => {
    // Sanity check: the new payload type is a superset of the
    // pre-extension `{ planId, projectId, briefId?, actor }` shape used
    // by the GeneratePlan handler in core/commands/index.ts. If this
    // assignment compiles, that handler keeps type-checking unchanged.
    const legacy = {
        planId: 'plan-legacy',
        projectId: 'proj-A',
        briefId: 'brief-1',
        actor: 'operator-1',
    } as const;
    const widened: PlanGeneratedPayload = legacy;
    assert.equal(widened.planId, 'plan-legacy');
});

test('KnownEvent supports exhaustive narrowing in a switch', () => {
    function discriminator(event: KnownEvent): string {
        switch (event.type) {
            case 'TaskSkipped':
                return `skipped:${event.payload.taskId}`;
            case 'TaskRetried':
                return `retried:${event.payload.taskId}`;
            case 'PlanArchived':
                return `archived:${event.payload.planId}`;
            case 'PlanUnarchived':
                return `unarchived:${event.payload.planId}`;
            case 'PlanDeleted':
                return `deleted:${event.payload.planId}`;
            case 'ProjectApprovalOverrideUpdated':
                return `override:${event.payload.projectId}:${event.payload.approvalOverride}`;
            case 'PlanGenerated':
                return `generated:${event.payload.planId}:${event.payload.revision ?? 1}`;
            case 'PlanDecomposed':
                return `decomposed:${event.payload.planId}:${event.payload.tasks?.length ?? 0}`;
            case 'ClarificationRequested':
                return `clarification-req:${event.payload.taskId}`;
            case 'ClarificationAnswered':
                return `clarification-ans:${event.payload.taskId}:${event.payload.remember}`;
            case 'InvestigationFollowupAsked':
                return `followup:${event.payload.taskId}:${event.payload.threadId}`;
            case 'NoteCreated':
                return `note-new:${event.payload.projectId}:${event.payload.noteId}`;
            case 'NoteUpdated':
                return `note-upd:${event.payload.projectId}:${event.payload.noteId}`;
            case 'NoteDeleted':
                return `note-del:${event.payload.projectId}:${event.payload.noteId}`;
            case 'RepoRegistered':
                return `repo-reg:${event.payload.repoId}`;
            case 'RepoUpdated':
                return `repo-upd:${event.payload.repoId}`;
            case 'RepoArchived':
                return `repo-arc:${event.payload.repoId}`;
            case 'RepoEnsured':
                return `repo-ens:${event.payload.repoId}:${event.payload.at}`;
            case 'RepoEnsureFailed':
                return `repo-enf:${event.payload.repoId}:${event.payload.at}`;
            case 'RepoSynced':
                return `repo-syn:${event.payload.repoId}:${event.payload.at}`;
            case 'RepoSyncFailed':
                return `repo-sfa:${event.payload.repoId}:${event.payload.at}`;
            default: {
                const exhaustive: never = event;
                return exhaustive;
            }
        }
    }

    const events: KnownEvent[] = [
        { ...baseEnvelope(), type: 'TaskSkipped', payload: { taskId: 't1' } },
        { ...baseEnvelope(), type: 'TaskRetried', payload: { taskId: 't2' } },
        { ...baseEnvelope(), type: 'PlanArchived', payload: { planId: 'p1' } },
        { ...baseEnvelope(), type: 'PlanUnarchived', payload: { planId: 'p1' } },
        { ...baseEnvelope(), type: 'PlanDeleted', payload: { planId: 'p2' } },
        {
            ...baseEnvelope(),
            type: 'ProjectApprovalOverrideUpdated',
            payload: { projectId: 'proj-9', approvalOverride: 'reject' },
        },
        {
            ...baseEnvelope(),
            type: 'PlanGenerated',
            payload: { planId: 'p3', revision: 2, content: 'body' },
        },
        {
            ...baseEnvelope(),
            type: 'PlanDecomposed',
            payload: {
                planId: 'p4',
                tasks: [
                    {
                        id: 't',
                        title: 'a',
                        type: 'implement',
                        dependencies: [],
                        description: 'x',
                    },
                ],
            },
        },
        {
            ...baseEnvelope(),
            type: 'ClarificationRequested',
            payload: { taskId: 't-c1', question: 'env?', askedAt: 1 },
        },
        {
            ...baseEnvelope(),
            type: 'ClarificationAnswered',
            payload: {
                taskId: 't-c1',
                answer: 'staging',
                remember: true,
                answeredAt: 2,
            },
        },
        {
            ...baseEnvelope(),
            type: 'InvestigationFollowupAsked',
            payload: {
                taskId: 't-f1',
                threadId: 'thr-1',
                question: '?',
                askedAt: 3,
            },
        },
        {
            ...baseEnvelope(),
            type: 'NoteCreated',
            payload: { projectId: 'proj-A', noteId: 'n1', timestamp: 4 },
        },
        {
            ...baseEnvelope(),
            type: 'NoteUpdated',
            payload: { projectId: 'proj-A', noteId: 'n1', timestamp: 5 },
        },
        {
            ...baseEnvelope(),
            type: 'NoteDeleted',
            payload: { projectId: 'proj-A', noteId: 'n1', timestamp: 6 },
        },
    ];

    assert.deepEqual(events.map(discriminator), [
        'skipped:t1',
        'retried:t2',
        'archived:p1',
        'unarchived:p1',
        'deleted:p2',
        'override:proj-9:reject',
        'generated:p3:2',
        'decomposed:p4:1',
        'clarification-req:t-c1',
        'clarification-ans:t-c1:true',
        'followup:t-f1:thr-1',
        'note-new:proj-A:n1',
        'note-upd:proj-A:n1',
        'note-del:proj-A:n1',
    ]);
});
