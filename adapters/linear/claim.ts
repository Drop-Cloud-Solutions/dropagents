/**
 * Phase 3 cutover safety net: enforce the `external_refs.claim_owner` lockout
 * so a single Linear project is never driven by both the v1 and v2 pipelines
 * at the same time.
 *
 * The contract:
 *
 *   createProject inserts a row with claim_owner='v2'. If a row already
 *   exists for the same project_id and it is owned by anything other than
 *   'v2', the call rejects with `ClaimConflict` — the Linear mutation is
 *   NEVER issued in that case.
 *
 *   createIssue / closeIssue / skipIssue read the project's claim_owner
 *   before any network call and reject with `ClaimConflict` if it is not
 *   'v2'. The check is pre-flight on purpose: failing fast keeps a v1-owned
 *   project from accumulating partial v2 writes while the operator scrambles
 *   to revoke the claim.
 *
 *   Once a row is owned by 'v2' the claim is sticky — it is cleared ONLY by
 *   the admin-only `removeClaim` helper exported below. This helper is
 *   intentionally NOT registered against the public command surface; callers
 *   that want to revoke a claim have to go through an operator script.
 */
import type { Event } from '../../core/events/event';

export type ClaimOwner = 'v1' | 'v2';

export const V1_CLAIM: ClaimOwner = 'v1';
export const V2_CLAIM: ClaimOwner = 'v2';

/**
 * Event type emitted when a claim mismatch causes the tracker to abort a
 * write. Reuses the existing `LinearWriteFailed` slot so consumers that
 * already listen for write failures (alerting, oncall dashboards) pick it
 * up without a new subscription.
 */
export const LINEAR_WRITE_FAILED_EVENT = 'LinearWriteFailed';

/** Operations that can produce a `ClaimConflict`. */
export type ClaimCheckOperation =
  | 'createProject'
  | 'createIssue'
  | 'closeIssue'
  | 'skipIssue'
  | 'writeHumanStatus';

/**
 * Thrown when a Linear write is blocked because the project's
 * `external_refs.claim_owner` does not match the expected owner.
 *
 * `projectId` is the identifier used to look up the claim — this may be a
 * local plan id (createProject) or a Linear external id (createIssue /
 * closeIssue / skipIssue), depending on the call site. `claimOwner` is the
 * conflicting value read from the row (or `'<none>'` when no row exists).
 */
export class ClaimConflict extends Error {
  override readonly name = 'ClaimConflict';
  readonly projectId: string;
  readonly claimOwner: string;
  readonly expectedOwner: ClaimOwner;

  constructor(projectId: string, claimOwner: string, expectedOwner: ClaimOwner = V2_CLAIM) {
    super(
      `ClaimConflict: project "${projectId}" is claimed by "${claimOwner}", expected "${expectedOwner}"`
    );
    this.projectId = projectId;
    this.claimOwner = claimOwner;
    this.expectedOwner = expectedOwner;
  }
}

/**
 * Read/write surface over the `external_refs.claim_owner` column, scoped to
 * Linear-system rows. The interface keeps three distinct read methods rather
 * than one polymorphic one so the call site at each tracker method is
 * obvious from the type signature.
 */
export interface ClaimStore {
  /** Look up claim_owner for the project row keyed by its local id. */
  readByProjectLocalId(localId: string): string | undefined;
  /** Look up claim_owner for the project row whose external_id matches. */
  readByProjectExternalId(externalId: string): string | undefined;
  /**
   * Resolve a Linear issue's external_id back to its owning project's
   * claim_owner. The store implementation is responsible for the join
   * (issue row → project row).
   */
  readByIssueExternalId(externalId: string): string | undefined;
  /** Set claim_owner for the project row keyed by local id. */
  writeProjectClaim(localId: string, owner: ClaimOwner): void;
  /** Admin-only: clear claim_owner for the project row. */
  removeProjectClaim(localId: string): void;
}

export interface ClaimConflictPayload {
  readonly operation: ClaimCheckOperation;
  readonly projectId: string;
  readonly claimOwner: string;
  readonly expectedOwner: ClaimOwner;
  readonly error: string;
}

/**
 * Optional sink the tracker calls when a ClaimConflict is detected, so the
 * conflict propagates onto the event bus as a structured payload. The
 * subscriber's generic catch-all still publishes a `LinearWriteFailed` from
 * the re-thrown error; this sink exists so callers that want the rich
 * `{ projectId, claimOwner, expectedOwner }` shape can wire it up.
 */
export type PublishClaimConflict = (
  payload: ClaimConflictPayload
) => void | Promise<void>;

/**
 * Build a `LinearWriteFailed` Event carrying the structured claim-conflict
 * payload. Idempotency key is deterministic on (operation, projectId,
 * claimOwner) so replays of the same conflict de-dup at the event store.
 */
export function buildClaimConflictEvent(
  payload: ClaimConflictPayload,
  occurredAt: number
): Event {
  return {
    type: LINEAR_WRITE_FAILED_EVENT,
    v: 1,
    occurredAt,
    idempotencyKey: `claim-conflict:${payload.operation}:${payload.projectId}:${payload.claimOwner}`,
    payload
  };
}

/**
 * Verify the project identified by `projectLocalId` is owned by v2. Throws
 * `ClaimConflict` when the row is missing or owned by anything else.
 */
export function assertClaimByProjectLocalId(
  store: ClaimStore,
  projectLocalId: string
): void {
  throwIfMismatch(projectLocalId, store.readByProjectLocalId(projectLocalId));
}

/** Same as `assertClaimByProjectLocalId` but looks up by Linear external id. */
export function assertClaimByProjectExternalId(
  store: ClaimStore,
  projectExternalId: string
): void {
  throwIfMismatch(projectExternalId, store.readByProjectExternalId(projectExternalId));
}

/** Same as the above, keyed by a Linear issue's external id. */
export function assertClaimByIssueExternalId(
  store: ClaimStore,
  issueExternalId: string
): void {
  throwIfMismatch(issueExternalId, store.readByIssueExternalId(issueExternalId));
}

/**
 * Acquire the v2 claim for `projectLocalId`. No-op when the row is already
 * owned by v2; throws `ClaimConflict` when the row is owned by anything
 * else. A missing row is created with claim_owner='v2'.
 */
export function claimProjectForV2(store: ClaimStore, projectLocalId: string): void {
  const existing = store.readByProjectLocalId(projectLocalId);
  if (existing !== undefined && existing !== V2_CLAIM) {
    throw new ClaimConflict(projectLocalId, existing);
  }
  store.writeProjectClaim(projectLocalId, V2_CLAIM);
}

/**
 * Admin-only: clear the claim row. NOT registered as a command on the
 * public CommandBus — callers must invoke this directly from an operator
 * script. The brief calls this out explicitly because exposing a public
 * "RemoveClaim" command would re-open the v1/v2 race the claim_owner
 * column was added to close.
 */
export function removeClaim(store: ClaimStore, projectLocalId: string): void {
  store.removeProjectClaim(projectLocalId);
}

function throwIfMismatch(projectId: string, owner: string | undefined): void {
  if (owner === undefined) {
    throw new ClaimConflict(projectId, '<none>');
  }
  if (owner !== V2_CLAIM) {
    throw new ClaimConflict(projectId, owner);
  }
}
