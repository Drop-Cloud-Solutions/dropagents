import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import type { Command } from '../commands/command';

import {
    RequirementEvents,
    buildFanOutBriefs,
    createApproveArchitectureHandler,
    createRegenerateArchitectureHandler,
    createSubmitRequirementHandler,
    createUpdateRequirementHandler,
    extractDesignDoc,
    isSubmitRequirementPayload,
    isUpdateRequirementPayload,
    parseArchitectureProposal,
    validateArchitectureProposal,
    type ArchitectureProposedPayload,
} from './index';

function cmd<T>(payload: T, actor = 'operator'): Command<T> {
    return { type: 't', actor, issuedAt: 0, payload };
}

// Handlers ignore the second `state` arg; pass undefined like the plan tests.
const S = undefined;

const deps = { clock: () => 1234 };

function validProposal(): Record<string, unknown> {
    return {
        requirementId: 'REQ-1',
        revision: 1,
        designDocPath: 'requirements/REQ-1/design.md',
        contracts: [
            {
                contractId: 'x-available-v1',
                kind: 'event',
                name: 'XAvailable',
                producer: 'system-a',
                consumers: ['system-b'],
                summary: 'A publishes X',
                schemaRef: 'requirements/REQ-1/contracts/x-available-v1.schema.json',
                backwardCompatible: true,
            },
        ],
        subBriefs: [
            {
                systemId: 'system-a',
                title: 'Publish XAvailable',
                brief: 'Publish the XAvailable event per contract.',
                produces: ['x-available-v1'],
                consumes: [],
            },
            {
                systemId: 'system-b',
                title: 'Consume XAvailable',
                brief: 'Subscribe and expose GET /x.',
                produces: [],
                consumes: ['x-available-v1'],
            },
        ],
        rollout: [
            { systemId: 'system-b', deployAfter: ['system-a'], reason: 'consumer after producer' },
        ],
    };
}

test('isSubmitRequirementPayload accepts valid, rejects missing fields', () => {
    assert.equal(
        isSubmitRequirementPayload({ requirementId: 'r', title: 't', description: 'd' }),
        true,
    );
    assert.equal(isSubmitRequirementPayload({ title: 't', description: 'd' }), false);
    assert.equal(isSubmitRequirementPayload({ requirementId: 'r', title: '', description: 'd' }), false);
});

test('SubmitRequirement handler emits RequirementSubmitted revision 1', async () => {
    const h = createSubmitRequirementHandler(deps);
    const [ev] = await h(cmd({ requirementId: 'REQ-9', title: 'T', description: 'D' }), S);
    assert.equal(ev.type, RequirementEvents.REQUIREMENT_SUBMITTED);
    assert.equal(ev.idempotencyKey, 'SubmitRequirement:REQ-9:r1');
    const p = ev.payload as { revision: number; actor: string; title: string };
    assert.equal(p.revision, 1);
    assert.equal(p.actor, 'operator');
    assert.equal(p.title, 'T');
});

test('Regenerate handler emits RequirementSubmitted with the given revision + feedback', async () => {
    const h = createRegenerateArchitectureHandler(deps);
    const [ev] = await h(cmd({ requirementId: 'REQ-9', revision: 3, feedback: 'redo B' }), S);
    assert.equal(ev.type, RequirementEvents.REQUIREMENT_SUBMITTED);
    assert.equal(ev.idempotencyKey, 'SubmitRequirement:REQ-9:r3');
    const p = ev.payload as { revision: number; feedback: string };
    assert.equal(p.revision, 3);
    assert.equal(p.feedback, 'redo B');
});

test('Approve handler emits ArchitectureApproved', async () => {
    const h = createApproveArchitectureHandler(deps);
    const [ev] = await h(cmd({ requirementId: 'REQ-9', revision: 2 }), S);
    assert.equal(ev.type, RequirementEvents.ARCHITECTURE_APPROVED);
    assert.equal(ev.idempotencyKey, 'ApproveArchitecture:REQ-9:r2');
});

test('validateArchitectureProposal accepts a well-formed proposal', () => {
    const res = validateArchitectureProposal(validProposal(), { requirementId: 'REQ-1' });
    assert.equal(res.ok, true);
    if (res.ok) {
        assert.equal(res.value.subBriefs.length, 2);
        assert.equal(res.value.contracts[0].contractId, 'x-available-v1');
    }
});

test('validateArchitectureProposal rejects structural + integrity violations', () => {
    const bad = (mut: (p: Record<string, unknown>) => void): string => {
        const p = validProposal();
        mut(p);
        const r = validateArchitectureProposal(p);
        assert.equal(r.ok, false);
        return r.ok ? '' : r.error;
    };
    assert.match(bad((p) => delete p.designDocPath), /designDocPath/);
    assert.match(bad((p) => { (p.subBriefs as Array<Record<string, unknown>>)[0].produces = ['nope-v1']; }), /unknown contractId/);
    assert.match(bad((p) => { p.subBriefs = []; }), /non-empty/);
    assert.match(bad((p) => { (p.contracts as Array<Record<string, unknown>>)[0].kind = 'weird'; }), /kind/);
    assert.match(bad((p) => { (p.contracts as Array<Record<string, unknown>>)[0].contractId = 'Bad_Id'; }), /slug/);
    // rollout referencing an unknown system
    assert.match(bad((p) => { (p.rollout as Array<Record<string, unknown>>)[0].deployAfter = ['ghost']; }), /unknown system/);
    // self deploy-edge
    assert.match(bad((p) => { (p.rollout as Array<Record<string, unknown>>)[0].deployAfter = ['system-b']; }), /self deploy-edge/);
    // banned dev-ordering field on a sub-brief
    assert.match(bad((p) => { (p.subBriefs as Array<Record<string, unknown>>)[1].dependsOn = ['system-a']; }), /independent/);
});

test('parseArchitectureProposal extracts from a fenced json block', () => {
    const text = 'Here is the design.\n\n```json\n' + JSON.stringify(validProposal()) + '\n```\n';
    const r = parseArchitectureProposal(text, { requirementId: 'REQ-1', actor: 'architect' });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.value.actor, 'architect');
});

test('parseArchitectureProposal handles raw JSON and reports errors', () => {
    assert.equal(parseArchitectureProposal(JSON.stringify(validProposal())).ok, true);
    assert.equal(parseArchitectureProposal('no json here').ok, false);
    assert.equal(parseArchitectureProposal('just **prose** and no object').ok, false);
    // The orchestrator's known requirementId overrides whatever the model wrote.
    const overridden = parseArchitectureProposal(JSON.stringify(validProposal()), {
        requirementId: 'REQ-OTHER',
    });
    assert.equal(overridden.ok, true);
    if (overridden.ok) assert.equal(overridden.value.requirementId, 'REQ-OTHER');
});

test('parseArchitectureProposal is robust to narration + markdown around the JSON', () => {
    // Design markdown (with a stray {…} that is NOT the proposal) + narration,
    // then the real proposal in a fenced block. The parser must skip the decoy
    // and pick the object that validates.
    const text = [
        '**Request analysis:** here is the cross-system design.',
        '',
        '```mermaid',
        'flowchart TD',
        '  A --> B',
        '```',
        '',
        'A stray object: { "note": "not the proposal" }',
        '',
        'Here is the proposal:',
        '',
        '```json',
        JSON.stringify(validProposal(), null, 2),
        '```',
        '',
        'Let me know if you want changes.',
    ].join('\n');
    const res = parseArchitectureProposal(text, { requirementId: 'REQ-1' });
    assert.equal(res.ok, true);
    if (res.ok) assert.equal(res.value.subBriefs.length, 2);
});

test('extractDesignDoc returns the markdown before the json proposal block', () => {
    const text = '# Design\n\nSome prose with a ```mermaid\nflowchart TD\n``` diagram.\n\n```json\n{"a":1}\n```\n';
    assert.equal(
        extractDesignDoc(text),
        '# Design\n\nSome prose with a ```mermaid\nflowchart TD\n``` diagram.',
    );
    // No json block → the whole trimmed text.
    assert.equal(extractDesignDoc('  just prose  '), 'just prose');
    assert.equal(extractDesignDoc(''), '');
});

test('buildFanOutBriefs makes one brief per system, tagged with the requirement', () => {
    const proposal = (validateArchitectureProposal(validProposal()) as {
        ok: true;
        value: ArchitectureProposedPayload;
    }).value;
    let n = 0;
    const briefs = buildFanOutBriefs(proposal, () => `brief-${++n}`);
    assert.equal(briefs.length, 2);
    assert.deepEqual(briefs.map((b) => b.projectId), ['system-a', 'system-b']);
    assert.equal(briefs[0].requirementId, 'REQ-1');
    assert.equal(briefs[0].briefId, 'brief-1');
    assert.equal(briefs[0].content, 'Publish the XAvailable event per contract.');
});

// ----- UpdateRequirement (edit-when-idle) -------------------------------

test('isUpdateRequirementPayload requires an id plus at least one field', () => {
    assert.equal(isUpdateRequirementPayload({ requirementId: 'REQ-1', title: 'T' }), true);
    assert.equal(isUpdateRequirementPayload({ requirementId: 'REQ-1', description: '' }), true);
    assert.equal(
        isUpdateRequirementPayload({ requirementId: 'REQ-1', title: 'T', description: 'D' }),
        true,
    );
    // No-op update is a caller bug.
    assert.equal(isUpdateRequirementPayload({ requirementId: 'REQ-1' }), false);
    // Title, when present, must be a real label.
    assert.equal(isUpdateRequirementPayload({ requirementId: 'REQ-1', title: '' }), false);
    assert.equal(isUpdateRequirementPayload({ title: 'T', description: 'D' }), false);
});

test('UpdateRequirement emits RequirementUpdated when the requirement is idle', async () => {
    const h = createUpdateRequirementHandler({
        clock: () => 1234,
        getRequirementStatus: () => 'proposed',
    });
    const events = await h(
        {
            type: 't', actor: 'operator', issuedAt: 99,
            payload: {
                requirementId: 'REQ-1', title: 'New title', description: 'New text',
            },
        },
        S,
    );
    assert.equal(events.length, 1);
    assert.equal(events[0].type, RequirementEvents.REQUIREMENT_UPDATED);
    assert.equal(events[0].idempotencyKey, 'UpdateRequirement:REQ-1:99');
    const p = events[0].payload as { title?: string; description?: string; actor: string };
    assert.equal(p.title, 'New title');
    assert.equal(p.description, 'New text');
    assert.equal(p.actor, 'operator');
});

test('UpdateRequirement is rejected while the architect is RUNNING', async () => {
    const h = createUpdateRequirementHandler({
        clock: () => 1234,
        getRequirementStatus: () => 'architecting',
    });
    await assert.rejects(
        h(cmd({ requirementId: 'REQ-1', title: 'New' }), S),
        /architect is running/,
    );
});

test('UpdateRequirement rejects unknown and archived requirements', async () => {
    const unknown = createUpdateRequirementHandler({
        clock: () => 1,
        getRequirementStatus: () => undefined,
    });
    await assert.rejects(
        unknown(cmd({ requirementId: 'REQ-GONE', title: 'X' }), S),
        /unknown requirement/,
    );
    const archived = createUpdateRequirementHandler({
        clock: () => 1,
        getRequirementStatus: () => 'archived',
    });
    await assert.rejects(
        archived(cmd({ requirementId: 'REQ-1', title: 'X' }), S),
        /archived/,
    );
});

test('UpdateRequirement without a status guard still validates the payload', async () => {
    // Hosts that register the handler without the projection (tests, tools)
    // keep payload validation; only the running-guard is skipped.
    const h = createUpdateRequirementHandler({ clock: () => 1 });
    const events = await h(cmd({ requirementId: 'REQ-1', description: 'D2' }), S);
    assert.equal(events[0].type, RequirementEvents.REQUIREMENT_UPDATED);
    await assert.rejects(h(cmd({ requirementId: 'REQ-1' }), S), /invalid payload/);
});

test('SubmitRequirement threads projectId onto RequirementSubmitted (and validates it)', async () => {
    assert.equal(
        isSubmitRequirementPayload({ requirementId: 'R', title: 'T', description: '', projectId: 'workshop' }),
        true,
    );
    assert.equal(
        isSubmitRequirementPayload({ requirementId: 'R', title: 'T', description: '', projectId: '' }),
        false,
        'empty projectId is a caller bug',
    );
    const h = createSubmitRequirementHandler(deps);
    const events = await h(
        cmd({ requirementId: 'REQ-P', title: 'T', description: 'D', projectId: 'workshop' }),
        S,
    );
    assert.equal(
        (events[0].payload as { projectId?: string }).projectId,
        'workshop',
    );
});
