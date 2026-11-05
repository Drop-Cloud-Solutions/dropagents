/**
 * Tests for the Phase 3 v1/v2 claim guard.
 *
 * Two layers covered here:
 *   1. The pure helpers in ./claim.ts (ClaimConflict shape, assert/claim/
 *      remove helpers, event builder).
 *   2. LinearTracker integration — every operation honours the claim store,
 *      claim_owner='v2' permits all four operations, and conflicts skip the
 *      Linear network call entirely.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import type { LinearClient, LinearRequestOptions } from './client';
import { LinearTracker, type ExternalRefsWriter } from './LinearTracker';
import {
  ClaimConflict,
  LINEAR_WRITE_FAILED_EVENT,
  V1_CLAIM,
  V2_CLAIM,
  assertClaimByIssueExternalId,
  assertClaimByProjectExternalId,
  assertClaimByProjectLocalId,
  buildClaimConflictEvent,
  claimProjectForV2,
  removeClaim,
  type ClaimConflictPayload,
  type ClaimStore
} from './claim';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface StubCall {
  readonly query: string;
  readonly variables: Readonly<Record<string, unknown>>;
}
type StubResponder = (call: StubCall) => unknown | Promise<unknown>;

class StubLinearClient implements LinearClient {
  readonly calls: StubCall[] = [];
  constructor(private readonly responder: StubResponder) {}
  async request<T>(query: string, opts: LinearRequestOptions = {}): Promise<T> {
    const call: StubCall = { query, variables: opts.variables ?? {} };
    this.calls.push(call);
    return (await this.responder(call)) as T;
  }
}

class MemoryExternalRefs implements ExternalRefsWriter {
  readonly rows = new Map<string, string>();
  write(localId: string, externalId: string): void {
    this.rows.set(localId, externalId);
  }
}

/**
 * In-memory ClaimStore. Tracks `local_id → claim_owner` and the
 * `external_id → local_id` reverse index so the three lookup methods on
 * `ClaimStore` can be satisfied without a real SQLite join. Issue→project
 * resolution is registered explicitly via `mapIssueToProject` so tests can
 * mirror whatever state the production join would have produced.
 */
class MemoryClaimStore implements ClaimStore {
  readonly claims = new Map<string, string>();
  readonly externalToLocal = new Map<string, string>();
  readonly issueToProjectLocal = new Map<string, string>();

  seedProject(localId: string, externalId: string, owner: string): void {
    this.claims.set(localId, owner);
    this.externalToLocal.set(externalId, localId);
  }

  mapIssueToProject(issueExternalId: string, projectLocalId: string): void {
    this.issueToProjectLocal.set(issueExternalId, projectLocalId);
  }

  readByProjectLocalId(localId: string): string | undefined {
    return this.claims.get(localId);
  }
  readByProjectExternalId(externalId: string): string | undefined {
    const localId = this.externalToLocal.get(externalId);
    return localId ? this.claims.get(localId) : undefined;
  }
  readByIssueExternalId(externalId: string): string | undefined {
    const localId = this.issueToProjectLocal.get(externalId);
    return localId ? this.claims.get(localId) : undefined;
  }
  writeProjectClaim(localId: string, owner: 'v1' | 'v2'): void {
    this.claims.set(localId, owner);
  }
  removeProjectClaim(localId: string): void {
    this.claims.delete(localId);
  }
}

function matchMutation(query: string, name: string): boolean {
  return new RegExp(`mutation\\s+${name}\\b`).test(query);
}

function trackerWith(
  client: LinearClient,
  claimStore: ClaimStore,
  onClaimConflict?: (p: ClaimConflictPayload) => void
): { tracker: LinearTracker; refs: MemoryExternalRefs } {
  const refs = new MemoryExternalRefs();
  const tracker = new LinearTracker({
    client,
    externalRefs: refs,
    getTeamId: () => 'team-1',
    workflowStates: async () => ({ done: 'state-done', cancelled: 'state-cancel' }),
    claimStore,
    onClaimConflict
  });
  return { tracker, refs };
}

// ---------------------------------------------------------------------------
// ClaimConflict shape
// ---------------------------------------------------------------------------

test('ClaimConflict carries projectId, claimOwner, expectedOwner and a descriptive message', () => {
  const err = new ClaimConflict('plan-1', 'v1');
  assert.equal(err.name, 'ClaimConflict');
  assert.equal(err.projectId, 'plan-1');
  assert.equal(err.claimOwner, 'v1');
  assert.equal(err.expectedOwner, V2_CLAIM);
  assert.match(err.message, /plan-1/);
  assert.match(err.message, /v1/);
  assert.match(err.message, /v2/);
});

test('ClaimConflict is an Error instance (catchable via instanceof Error)', () => {
  const err = new ClaimConflict('p', 'v1');
  assert.ok(err instanceof Error);
  assert.ok(err instanceof ClaimConflict);
});

// ---------------------------------------------------------------------------
// Helper functions over ClaimStore
// ---------------------------------------------------------------------------

test('assertClaimByProjectLocalId — passes on v2, throws on v1, throws on missing row', () => {
  const store = new MemoryClaimStore();
  store.seedProject('plan-v2', 'lin-v2', V2_CLAIM);
  store.seedProject('plan-v1', 'lin-v1', V1_CLAIM);

  // v2 — no throw.
  assert.doesNotThrow(() => assertClaimByProjectLocalId(store, 'plan-v2'));

  // v1 — ClaimConflict with the conflicting owner.
  assert.throws(
    () => assertClaimByProjectLocalId(store, 'plan-v1'),
    (err: unknown) => err instanceof ClaimConflict && err.claimOwner === 'v1'
  );

  // Missing — ClaimConflict, owner reported as '<none>' so the diagnostic
  // is unambiguous (vs. a generic "not found" elsewhere in the system).
  assert.throws(
    () => assertClaimByProjectLocalId(store, 'plan-unknown'),
    (err: unknown) => err instanceof ClaimConflict && err.claimOwner === '<none>'
  );
});

test('assertClaimByProjectExternalId and assertClaimByIssueExternalId honour the same v2/v1/missing rules', () => {
  const store = new MemoryClaimStore();
  store.seedProject('plan-v2', 'lin-proj-v2', V2_CLAIM);
  store.seedProject('plan-v1', 'lin-proj-v1', V1_CLAIM);
  store.mapIssueToProject('lin-iss-v2', 'plan-v2');
  store.mapIssueToProject('lin-iss-v1', 'plan-v1');

  // by-project-external-id
  assert.doesNotThrow(() => assertClaimByProjectExternalId(store, 'lin-proj-v2'));
  assert.throws(() => assertClaimByProjectExternalId(store, 'lin-proj-v1'), ClaimConflict);
  assert.throws(() => assertClaimByProjectExternalId(store, 'lin-proj-unknown'), ClaimConflict);

  // by-issue-external-id
  assert.doesNotThrow(() => assertClaimByIssueExternalId(store, 'lin-iss-v2'));
  assert.throws(() => assertClaimByIssueExternalId(store, 'lin-iss-v1'), ClaimConflict);
  assert.throws(() => assertClaimByIssueExternalId(store, 'lin-iss-unknown'), ClaimConflict);
});

test('claimProjectForV2 writes the v2 row when missing, is idempotent for v2, and throws for v1', () => {
  const store = new MemoryClaimStore();

  claimProjectForV2(store, 'plan-fresh');
  assert.equal(store.readByProjectLocalId('plan-fresh'), V2_CLAIM);

  // Idempotent: calling again does not throw.
  claimProjectForV2(store, 'plan-fresh');
  assert.equal(store.readByProjectLocalId('plan-fresh'), V2_CLAIM);

  // Conflicting owner: claimProjectForV2 must refuse to overwrite.
  store.seedProject('plan-v1', 'lin-v1', V1_CLAIM);
  assert.throws(
    () => claimProjectForV2(store, 'plan-v1'),
    (err: unknown) => err instanceof ClaimConflict && err.claimOwner === 'v1'
  );
  assert.equal(store.readByProjectLocalId('plan-v1'), V1_CLAIM, 'v1 claim must not be overwritten');
});

test('removeClaim clears the claim row (admin-only helper, not a public command)', () => {
  const store = new MemoryClaimStore();
  claimProjectForV2(store, 'plan-1');
  removeClaim(store, 'plan-1');
  assert.equal(store.readByProjectLocalId('plan-1'), undefined);
});

test('buildClaimConflictEvent emits a LinearWriteFailed event with a deterministic idempotency key', () => {
  const payload: ClaimConflictPayload = {
    operation: 'createProject',
    projectId: 'plan-1',
    claimOwner: 'v1',
    expectedOwner: V2_CLAIM,
    error: 'ClaimConflict: project "plan-1" is claimed by "v1", expected "v2"'
  };
  const event = buildClaimConflictEvent(payload, 1_700_000_000_000);
  assert.equal(event.type, LINEAR_WRITE_FAILED_EVENT);
  assert.equal(event.occurredAt, 1_700_000_000_000);
  assert.equal(event.idempotencyKey, 'claim-conflict:createProject:plan-1:v1');
  assert.deepEqual(event.payload, payload);

  // Same input → same key, so a replay collapses at the event store.
  const again = buildClaimConflictEvent(payload, 1_700_000_000_001);
  assert.equal(again.idempotencyKey, event.idempotencyKey);
});

// ---------------------------------------------------------------------------
// LinearTracker integration — AC #1, #2, #3, #4, #5
// ---------------------------------------------------------------------------

test('createProject on a fresh (unclaimed) project succeeds, links the initiative, and writes claim_owner=v2 (AC #1)', async () => {
  const claimStore = new MemoryClaimStore();
  const client = new StubLinearClient((call) => {
    if (matchMutation(call.query, 'CreateProject')) {
      return { projectCreate: { success: true, project: { id: 'lin-proj-1', name: 'Plan 1' } } };
    }
    throw new Error(`unexpected query: ${call.query}`);
  });

  const { tracker, refs } = trackerWith(client, claimStore);
  const ref = await tracker.createProject({ name: 'Plan 1', key: 'plan-local-1' });

  assert.deepEqual(ref, { id: 'lin-proj-1', name: 'Plan 1' });
  // external_refs row written + claim_owner='v2' set on it.
  assert.equal(refs.rows.get('plan-local-1'), 'lin-proj-1');
  assert.equal(claimStore.readByProjectLocalId('plan-local-1'), V2_CLAIM);
});

test('createProject against a v1-claimed row throws ClaimConflict, publishes LinearWriteFailed payload, and issues NO Linear mutation (AC #2 + #4)', async () => {
  const claimStore = new MemoryClaimStore();
  claimStore.seedProject('plan-shared', 'lin-proj-shared', V1_CLAIM);

  const published: ClaimConflictPayload[] = [];
  const client = new StubLinearClient(() => {
    throw new Error('Linear network must not be touched when the claim is held by v1');
  });
  const { tracker } = trackerWith(client, claimStore, (p) => {
    published.push(p);
  });

  await assert.rejects(
    () => tracker.createProject({ name: 'Plan', key: 'plan-shared' }),
    (err: unknown) =>
      err instanceof ClaimConflict &&
      err.projectId === 'plan-shared' &&
      err.claimOwner === 'v1' &&
      err.expectedOwner === V2_CLAIM
  );

  // Network call was skipped — pre-flight rejection is a hard requirement.
  assert.equal(client.calls.length, 0);

  // AC #4: structured conflict propagates with project_id + conflicting claim_owner.
  assert.equal(published.length, 1);
  assert.deepEqual(published[0], {
    operation: 'createProject',
    projectId: 'plan-shared',
    claimOwner: 'v1',
    expectedOwner: V2_CLAIM,
    error: 'ClaimConflict: project "plan-shared" is claimed by "v1", expected "v2"'
  });

  // The v1 claim must remain intact — we never overwrite a conflicting owner.
  assert.equal(claimStore.readByProjectLocalId('plan-shared'), V1_CLAIM);
});

test('createProject is a no-op safety-wise when the v2 claim already exists (re-create is permitted)', async () => {
  const claimStore = new MemoryClaimStore();
  claimStore.seedProject('plan-1', 'lin-proj-1', V2_CLAIM);

  const client = new StubLinearClient((call) => {
    if (matchMutation(call.query, 'CreateProject')) {
      return { projectCreate: { success: true, project: { id: 'lin-proj-2', name: 'Plan 1' } } };
    }
    throw new Error(`unexpected query: ${call.query}`);
  });
  const { tracker } = trackerWith(client, claimStore);

  // Pre-existing v2 claim must not be a conflict — the Linear mutation runs.
  await assert.doesNotReject(() => tracker.createProject({ name: 'Plan 1', key: 'plan-1' }));
  assert.equal(client.calls.length, 1);
  // Claim is reaffirmed as v2 (still v2 afterwards).
  assert.equal(claimStore.readByProjectLocalId('plan-1'), V2_CLAIM);
});

test('createIssue / closeIssue / skipIssue check claim_owner BEFORE any Linear network call and throw ClaimConflict on v1 (AC #3)', async () => {
  const claimStore = new MemoryClaimStore();
  claimStore.seedProject('plan-v1', 'lin-proj-v1', V1_CLAIM);
  claimStore.mapIssueToProject('lin-iss-v1', 'plan-v1');

  const published: ClaimConflictPayload[] = [];
  const client = new StubLinearClient(() => {
    throw new Error('Linear network must not be touched when the claim is held by v1');
  });
  const { tracker } = trackerWith(client, claimStore, (p) => {
    published.push(p);
  });

  await assert.rejects(
    () =>
      tracker.createIssue({
        title: 'echo',
        projectId: 'lin-proj-v1',
        labels: []
      }),
    ClaimConflict
  );
  await assert.rejects(() => tracker.closeIssue('lin-iss-v1', 'done'), ClaimConflict);
  await assert.rejects(() => tracker.skipIssue('lin-iss-v1', 'no-op'), ClaimConflict);

  // All three failed pre-flight: no Linear traffic at all.
  assert.equal(client.calls.length, 0);

  // Each conflict yielded a structured payload tagged with its operation.
  assert.deepEqual(
    published.map((p) => p.operation),
    ['createIssue', 'closeIssue', 'skipIssue']
  );
  for (const p of published) {
    assert.equal(p.claimOwner, 'v1');
    assert.equal(p.expectedOwner, V2_CLAIM);
  }
});

test('createIssue / closeIssue / skipIssue all succeed when the project is owned by v2 (AC #5)', async () => {
  const claimStore = new MemoryClaimStore();
  claimStore.seedProject('plan-v2', 'lin-proj-v2', V2_CLAIM);
  claimStore.mapIssueToProject('lin-iss-v2', 'plan-v2');

  const client = new StubLinearClient((call) => {
    if (matchMutation(call.query, 'CreateIssue')) {
      return { issueCreate: { success: true, issue: { id: 'lin-iss-v2', title: 'echo' } } };
    }
    if (call.query.includes('IssueDescription')) {
      return { issue: { description: '' } };
    }
    if (matchMutation(call.query, 'CloseIssue')) {
      return { issueUpdate: { success: true } };
    }
    if (matchMutation(call.query, 'SkipIssue')) {
      return { issueUpdate: { success: true } };
    }
    if (matchMutation(call.query, 'SkipReason')) {
      return { commentCreate: { success: true } };
    }
    if (matchMutation(call.query, 'CreateProject')) {
      return { projectCreate: { success: true, project: { id: 'lin-proj-v2-2', name: 'X' } } };
    }
    throw new Error(`unexpected query: ${call.query}`);
  });
  const { tracker } = trackerWith(client, claimStore);

  // All four terminal operations pass — createProject re-affirm + three issue ops.
  await tracker.createProject({ name: 'X', key: 'plan-v2' });
  const created = await tracker.createIssue({
    title: 'echo',
    projectId: 'lin-proj-v2',
    labels: []
  });
  assert.equal(created.id, 'lin-iss-v2');
  await tracker.closeIssue('lin-iss-v2', 'done');
  await tracker.skipIssue('lin-iss-v2', 'no-op');

  // Sanity check: the underlying Linear calls actually ran.
  const opsSeen = client.calls.map((c) => {
    if (matchMutation(c.query, 'CreateProject')) return 'CreateProject';
    if (matchMutation(c.query, 'CreateIssue')) return 'CreateIssue';
    if (matchMutation(c.query, 'CloseIssue')) return 'CloseIssue';
    if (matchMutation(c.query, 'SkipIssue')) return 'SkipIssue';
    if (matchMutation(c.query, 'SkipReason')) return 'SkipReason';
    if (c.query.includes('IssueDescription')) return 'IssueDescription';
    return 'other';
  });
  assert.ok(opsSeen.includes('CreateProject'));
  assert.ok(opsSeen.includes('CreateIssue'));
  assert.ok(opsSeen.includes('CloseIssue'));
  assert.ok(opsSeen.includes('SkipIssue'));
});

test('createIssue rejects when no project row exists at all (missing claim is treated as conflict)', async () => {
  const claimStore = new MemoryClaimStore();
  // No seedProject call — the lookup will return undefined.
  const client = new StubLinearClient(() => {
    throw new Error('network must not be touched');
  });
  const { tracker } = trackerWith(client, claimStore);

  await assert.rejects(
    () => tracker.createIssue({ title: 't', projectId: 'lin-proj-unknown', labels: [] }),
    (err: unknown) => err instanceof ClaimConflict && err.claimOwner === '<none>'
  );
  assert.equal(client.calls.length, 0);
});

test('claim guard is fully bypassed when no claimStore is configured (back-compat path)', async () => {
  // Tracker without claimStore — pre-Phase-3 wirings keep working.
  const refs = new MemoryExternalRefs();
  const client = new StubLinearClient((call) => {
    if (matchMutation(call.query, 'CreateProject')) {
      return { projectCreate: { success: true, project: { id: 'p', name: 'n' } } };
    }
    if (matchMutation(call.query, 'CreateIssue')) {
      return { issueCreate: { success: true, issue: { id: 'i', title: 'n' } } };
    }
    throw new Error(`unexpected query: ${call.query}`);
  });
  const tracker = new LinearTracker({
    client,
    externalRefs: refs,
    getTeamId: () => 'team-1'
  });

  // Neither call must throw, even with no claim store at all.
  await tracker.createProject({ name: 'n', key: 'k' });
  await tracker.createIssue({ title: 'n', projectId: 'p', labels: [] });
});
