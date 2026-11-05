import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import {
    REQUIREMENT_EVENT_TYPES as T,
    applyRequirementEvent,
    type RequirementRow,
} from './requirements-projection';

function fresh(): Map<string, RequirementRow> {
    return new Map();
}

test('RequirementSubmitted creates a row in architecting', () => {
    const m = fresh();
    applyRequirementEvent(m, T.SUBMITTED, {
        requirementId: 'REQ-1', title: 'Expose X', description: 'd', revision: 1,
    });
    const r = m.get('REQ-1');
    assert.equal(r?.status, 'architecting');
    assert.equal(r?.title, 'Expose X');
    assert.equal(r?.revision, 1);
    assert.equal(r?.archived, false);
});

test('ArchitectureProposed → proposed; Approved → approved', () => {
    const m = fresh();
    applyRequirementEvent(m, T.SUBMITTED, { requirementId: 'REQ-2', title: 't', description: 'd', revision: 1 });
    applyRequirementEvent(m, T.PROPOSED, { requirementId: 'REQ-2', revision: 1 });
    assert.equal(m.get('REQ-2')?.status, 'proposed');
    applyRequirementEvent(m, T.APPROVED, { requirementId: 'REQ-2' });
    assert.equal(m.get('REQ-2')?.status, 'approved');
});

test('regenerate (empty title) preserves the stored title', () => {
    const m = fresh();
    applyRequirementEvent(m, T.SUBMITTED, { requirementId: 'REQ-3', title: 'Original', description: 'D', revision: 1 });
    applyRequirementEvent(m, T.SUBMITTED, { requirementId: 'REQ-3', title: '', description: '', revision: 2 });
    const r = m.get('REQ-3');
    assert.equal(r?.title, 'Original');
    assert.equal(r?.revision, 2);
    assert.equal(r?.status, 'architecting');
});

test('archive flags the row; unknown/idempotent handling', () => {
    const m = fresh();
    applyRequirementEvent(m, T.SUBMITTED, { requirementId: 'REQ-4', title: 't', description: 'd', revision: 1 });
    applyRequirementEvent(m, T.ARCHIVED, { requirementId: 'REQ-4' });
    assert.equal(m.get('REQ-4')?.archived, true);
    // Missing requirementId → no-op.
    assert.equal(applyRequirementEvent(m, T.SUBMITTED, {}), null);
    // Unknown type → no-op.
    assert.equal(applyRequirementEvent(m, 'Nope', { requirementId: 'REQ-4' }), null);
});

test('RequirementUpdated edits title/description, leaves status/revision alone', () => {
    const m = new Map<string, RequirementRow>();
    applyRequirementEvent(m, T.SUBMITTED, { requirementId: 'REQ-9', title: 'Old', description: 'Old text', revision: 1 });
    applyRequirementEvent(m, T.PROPOSED, { requirementId: 'REQ-9', revision: 1 });

    applyRequirementEvent(m, T.UPDATED, { requirementId: 'REQ-9', title: 'New', description: 'New text' });
    const row = m.get('REQ-9')!;
    assert.equal(row.title, 'New');
    assert.equal(row.description, 'New text');
    assert.equal(row.status, 'proposed');
    assert.equal(row.revision, 1);

    // Description-only edit keeps the title; empty description clears.
    applyRequirementEvent(m, T.UPDATED, { requirementId: 'REQ-9', description: '' });
    assert.equal(m.get('REQ-9')!.title, 'New');
    assert.equal(m.get('REQ-9')!.description, '');
});

test('RequirementSubmitted folds projectId; a regenerate resubmit keeps it', () => {
    const m = new Map<string, RequirementRow>();
    applyRequirementEvent(m, T.SUBMITTED, {
        requirementId: 'REQ-PJ', title: 'T', description: 'D', revision: 1,
        projectId: 'workshop',
    });
    assert.equal(m.get('REQ-PJ')!.projectId, 'workshop');

    // Regenerate: empty title/description AND no projectId — all preserved.
    applyRequirementEvent(m, T.SUBMITTED, {
        requirementId: 'REQ-PJ', title: '', description: '', revision: 2,
    });
    assert.equal(m.get('REQ-PJ')!.projectId, 'workshop');

    // Legacy requirement without a project stays null.
    applyRequirementEvent(m, T.SUBMITTED, {
        requirementId: 'REQ-NOPJ', title: 'T', description: 'D', revision: 1,
    });
    assert.equal(m.get('REQ-NOPJ')!.projectId, null);
});

test('RequirementArchived stamps archivedAt from the event time (first archive wins)', () => {
    const m = new Map<string, RequirementRow>();
    applyRequirementEvent(m, T.SUBMITTED, {
        requirementId: 'REQ-AR', title: 'T', description: 'D', revision: 1,
    });
    assert.equal(m.get('REQ-AR')!.archived, false);
    assert.equal(m.get('REQ-AR')!.archivedAt, null);

    applyRequirementEvent(m, T.ARCHIVED, { requirementId: 'REQ-AR' }, 1_700_000_000_000);
    assert.equal(m.get('REQ-AR')!.archived, true);
    assert.equal(m.get('REQ-AR')!.archivedAt, 1_700_000_000_000);

    // Replaying the archive (or a duplicate event) keeps the original stamp.
    applyRequirementEvent(m, T.ARCHIVED, { requirementId: 'REQ-AR' }, 1_800_000_000_000);
    assert.equal(m.get('REQ-AR')!.archivedAt, 1_700_000_000_000);
});

test('RequirementArchived without an event time falls back to a live timestamp', () => {
    const m = new Map<string, RequirementRow>();
    applyRequirementEvent(m, T.ARCHIVED, { requirementId: 'REQ-AR2' });
    const at = m.get('REQ-AR2')!.archivedAt;
    assert.ok(typeof at === 'number' && at > 0);
});

test('a resubmission (regenerate) clears the failed-verification state', () => {
    const m = new Map<string, RequirementRow>();
    applyRequirementEvent(m, T.SUBMITTED, {
        requirementId: 'REQ-RV', title: 'T', description: 'D', revision: 1,
    });
    applyRequirementEvent(m, T.VERIFY_FAILED, {
        requirementId: 'REQ-RV',
        revision: 1,
        findings: [{ systemId: 'catalog', severity: 'blocker', finding: 'missing X' }],
    });
    assert.equal(m.get('REQ-RV')!.verificationStatus, 'failed');
    assert.equal(m.get('REQ-RV')!.verificationFindings.length, 1);

    // "Re-run architect with findings" → RegenerateArchitecture →
    // RequirementSubmitted r2. The findings block must vanish — the new
    // architect run supersedes the old verdict.
    applyRequirementEvent(m, T.SUBMITTED, {
        requirementId: 'REQ-RV', title: '', description: '', revision: 2,
    });
    const row = m.get('REQ-RV')!;
    assert.equal(row.verificationStatus, null);
    assert.deepEqual(row.verificationFindings, []);
    assert.equal(row.verificationError, null);
    assert.equal(row.status, 'architecting');
});
