import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { applyMigrations, openDatabase, type Db } from '../../core/state/migrations';
import { EventBus } from '../../core/events/bus';
import { EventStore } from '../../core/events/store';
import type { Event } from '../../core/events/event';
import type { Logger } from '../../core/ports/Logger';
import {
    REQUIREMENT_PROJECTION_EVENT_TYPES as T,
    RequirementProjectionStore,
} from './requirement-projection-store';

class SilentLogger implements Logger {
    info(): void {}
    warn(): void {}
    debug(): void {}
    error(): void {}
}

function makeHarness(): { db: Db; bus: EventBus; store: RequirementProjectionStore } {
    const db = openDatabase(':memory:');
    applyMigrations(db);
    const bus = new EventBus(new EventStore(db), new SilentLogger());
    const store = new RequirementProjectionStore(db, bus, new SilentLogger());
    return { db, bus, store };
}

function ev(type: string, payload: unknown, occurredAt: number, key: string): Event {
    return { type, v: 1, occurredAt, idempotencyKey: key, payload };
}

function submitted(id: string, revision: number, title: string, desc: string, at: number): Event {
    return ev(T.SUBMITTED, {
        requirementId: id, title, description: desc, actor: 'op', revision,
    }, at, `SubmitRequirement:${id}:r${revision}`);
}

function proposed(id: string, revision: number, at: number): Event {
    return ev(T.PROPOSED, {
        requirementId: id, actor: 'architect', revision,
        designDocPath: `requirements/${id}/design.md`,
        contracts: [{
            contractId: 'x-available-v1', kind: 'event', name: 'XAvailable',
            producer: 'system-a', consumers: ['system-b'], summary: 's',
            schemaRef: `requirements/${id}/contracts/x-available-v1.schema.json`,
            backwardCompatible: true,
        }],
        subBriefs: [
            { systemId: 'system-a', title: 'A', brief: 'publish', produces: ['x-available-v1'], consumes: [] },
            { systemId: 'system-b', title: 'B', brief: 'consume', produces: [], consumes: ['x-available-v1'] },
        ],
        rollout: [{ systemId: 'system-b', deployAfter: ['system-a'], reason: 'r' }],
    }, at, `ArchitectureProposed:${id}:r${revision}`);
}

test('RequirementSubmitted upserts the requirement (architecting, rev 1)', async () => {
    const { bus, store } = makeHarness();
    await bus.publish(submitted('REQ-1', 1, 'Expose X in B', 'desc', 100));
    const r = store.get('REQ-1');
    assert.equal(r?.status, 'architecting');
    assert.equal(r?.revision, 1);
    assert.equal(r?.title, 'Expose X in B');
    assert.equal(r?.description, 'desc');
});

test('ArchitectureProposed sets proposed + replaces contracts/subbriefs/rollout', async () => {
    const { bus, store } = makeHarness();
    await bus.publish(submitted('REQ-2', 1, 'T', 'D', 100));
    await bus.publish(proposed('REQ-2', 1, 200));
    const r = store.get('REQ-2');
    assert.equal(r?.status, 'proposed');
    assert.equal(r?.designDocPath, 'requirements/REQ-2/design.md');
    assert.equal(store.contractsFor('REQ-2').length, 1);
    assert.equal(store.subBriefsFor('REQ-2').length, 2);
    assert.equal(store.rolloutFor('REQ-2').length, 1);
});

test('a new proposal revision replaces the prior contracts/subbriefs', async () => {
    const { bus, store } = makeHarness();
    await bus.publish(submitted('REQ-3', 1, 'T', 'D', 100));
    await bus.publish(proposed('REQ-3', 1, 200));
    // Revision 2 with a single sub-brief + no contracts.
    await bus.publish(ev(T.PROPOSED, {
        requirementId: 'REQ-3', actor: 'architect', revision: 2,
        designDocPath: 'requirements/REQ-3/design.md',
        contracts: [],
        subBriefs: [{ systemId: 'system-a', title: 'A', brief: 'b', produces: [], consumes: [] }],
        rollout: [],
    }, 300, 'ArchitectureProposed:REQ-3:r2'));
    assert.equal(store.get('REQ-3')?.revision, 2);
    assert.equal(store.contractsFor('REQ-3').length, 0);
    assert.equal(store.subBriefsFor('REQ-3').length, 1);
});

test('regenerate (empty title) preserves the stored title/description', async () => {
    const { bus, store } = makeHarness();
    await bus.publish(submitted('REQ-4', 1, 'Original', 'Orig desc', 100));
    // Regenerate emits RequirementSubmitted rev 2 with empty title/description.
    await bus.publish(submitted('REQ-4', 2, '', '', 200));
    const r = store.get('REQ-4');
    assert.equal(r?.revision, 2);
    assert.equal(r?.title, 'Original');
    assert.equal(r?.description, 'Orig desc');
});

test('ArchitectureApproved flips status; BriefSubmitted links child briefs', async () => {
    const { bus, store } = makeHarness();
    await bus.publish(submitted('REQ-5', 1, 'T', 'D', 100));
    await bus.publish(proposed('REQ-5', 1, 200));
    await bus.publish(ev(T.APPROVED, { requirementId: 'REQ-5', actor: 'op', revision: 1 }, 300,
        'ApproveArchitecture:REQ-5:r1'));
    assert.equal(store.get('REQ-5')?.status, 'approved');
    await bus.publish(ev(T.BRIEF_SUBMITTED, {
        briefId: 'b1', projectId: 'system-a', content: 'c', actor: 'op', requirementId: 'REQ-5',
    }, 400, 'SubmitBrief:b1'));
    await bus.publish(ev(T.BRIEF_SUBMITTED, {
        briefId: 'b2', projectId: 'system-b', content: 'c', actor: 'op', requirementId: 'REQ-5',
    }, 401, 'SubmitBrief:b2'));
    assert.equal(store.plansFor('REQ-5').length, 2);
    // A brief with no requirementId does not link.
    await bus.publish(ev(T.BRIEF_SUBMITTED, {
        briefId: 'b3', projectId: 'other', content: 'c', actor: 'op',
    }, 402, 'SubmitBrief:b3'));
    assert.equal(store.plansFor('REQ-5').length, 2);
});

test('archive hides the requirement from listActive; replay is a no-op', async () => {
    const { bus, store } = makeHarness();
    await bus.publish(submitted('REQ-6', 1, 'T', 'D', 100));
    // Replaying the same submit event must not create a duplicate.
    await bus.publish(submitted('REQ-6', 1, 'T', 'D', 100));
    assert.equal(store.listActive().length, 1);
    await bus.publish(ev(T.ARCHIVED, { requirementId: 'REQ-6', actor: 'op' }, 500,
        'ArchiveRequirement:REQ-6'));
    assert.equal(store.listActive().length, 0);
    assert.equal(store.get('REQ-6')?.archivedAt, 500);
});

// ---------------------------------------------------------------------------
// RequirementUpdated — content-only edit (edit-when-idle)
// ---------------------------------------------------------------------------

test('RequirementUpdated edits title/description without touching status or revision', async () => {
    const { bus, store } = makeHarness();
    await bus.publish(submitted('REQ-U1', 1, 'Old title', 'Old text', 100));
    await bus.publish(proposed('REQ-U1', 1, 200));

    await bus.publish(ev(T.UPDATED, {
        requirementId: 'REQ-U1', actor: 'operator',
        title: 'New title', description: 'New business text',
    }, 300, 'UpdateRequirement:REQ-U1:300'));

    const row = store.get('REQ-U1');
    assert.equal(row?.title, 'New title');
    assert.equal(row?.description, 'New business text');
    assert.equal(row?.status, 'proposed', 'status untouched');
    assert.equal(row?.revision, 1, 'revision untouched');
});

test('RequirementUpdated with only a description keeps the stored title (and vice versa)', async () => {
    const { bus, store } = makeHarness();
    await bus.publish(submitted('REQ-U2', 1, 'Keep me', 'Old text', 100));

    await bus.publish(ev(T.UPDATED, {
        requirementId: 'REQ-U2', actor: 'operator', description: 'Only text changed',
    }, 200, 'UpdateRequirement:REQ-U2:200'));
    let row = store.get('REQ-U2');
    assert.equal(row?.title, 'Keep me');
    assert.equal(row?.description, 'Only text changed');

    await bus.publish(ev(T.UPDATED, {
        requirementId: 'REQ-U2', actor: 'operator', title: 'Only title changed',
    }, 300, 'UpdateRequirement:REQ-U2:300'));
    row = store.get('REQ-U2');
    assert.equal(row?.title, 'Only title changed');
    assert.equal(row?.description, 'Only text changed');

    // Empty-string description is a legal clear (mirrors SubmitRequirement).
    await bus.publish(ev(T.UPDATED, {
        requirementId: 'REQ-U2', actor: 'operator', description: '',
    }, 400, 'UpdateRequirement:REQ-U2:400'));
    assert.equal(store.get('REQ-U2')?.description, '');
});

test('RequirementSubmitted stores project_id; regenerate (no project) keeps it', async () => {
    const { bus, store } = makeHarness();
    await bus.publish(ev(T.SUBMITTED, {
        requirementId: 'REQ-P1', title: 'T', description: 'D', actor: 'op',
        revision: 1, projectId: 'workshop',
    }, 100, 'SubmitRequirement:REQ-P1:r1'));
    assert.equal(store.get('REQ-P1')?.projectId, 'workshop');

    // Regenerate re-uses RequirementSubmitted with empty title/desc and no
    // projectId — the stored project must survive (COALESCE).
    await bus.publish(ev(T.SUBMITTED, {
        requirementId: 'REQ-P1', title: '', description: '', actor: 'op', revision: 2,
    }, 200, 'SubmitRequirement:REQ-P1:r2'));
    assert.equal(store.get('REQ-P1')?.projectId, 'workshop');
    assert.equal(store.get('REQ-P1')?.revision, 2);
});

test('BriefSubmitted plan link prefers systemId over the (board) projectId', async () => {
    const { bus, store } = makeHarness();
    await bus.publish(submitted('REQ-P2', 1, 'T', 'D', 100));
    await bus.publish(ev('BriefSubmitted', {
        briefId: 'REQ-P2--workshop-tailorqueue',
        projectId: 'workshop', // board project, NOT the system
        systemId: 'workshop-tailorqueue',
        content: 'brief', actor: 'architect', requirementId: 'REQ-P2',
    }, 200, 'SubmitBrief:REQ-P2--workshop-tailorqueue'));
    const links = store.plansFor('REQ-P2') as Array<{ system_id: string }>;
    assert.equal(links.length, 1);
    assert.equal(links[0].system_id, 'workshop-tailorqueue');
});
