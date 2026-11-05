/**
 * Pure client-side reducer for the board's Requirements lane (Architect Tier,
 * Phase 2). Folds the requirement lifecycle SSE events into the in-memory row
 * the board renders. Lifted out of `board.ts` (which has browser side effects)
 * so `requirements-projection.test.ts` can exercise it under `node:test` — the
 * same split used by `task-projection.ts` / `plan-dep-graph.ts`.
 */

export interface RequirementRow {
    requirementId: string;
    title: string;
    description: string;
    /** Board project the requirement (and its fanned-out plans) belongs to. */
    projectId: string | null;
    /** submitted → architecting → proposed → approved → archived */
    status: string;
    revision: number;
    archived: boolean;
    /** When the requirement was archived (drives the recency window of the
     *  Archived-requirements section). Null while active. */
    archivedAt: number | null;
    /** Fan-out verification gate: null | 'verifying' | 'passed' | 'failed'
     *  | 'overridden'. */
    verificationStatus: string | null;
    /** Findings from a failed verification: {systemId, severity, finding}[] */
    verificationFindings: Array<{
        systemId: string | null;
        severity: string;
        finding: string;
    }>;
    /** Agent-level verification error (auth, unparseable verdict). */
    verificationError: string | null;
}

/** Event type strings, mirrored from `core/requirements` RequirementEvents. */
export const REQUIREMENT_EVENT_TYPES = {
    SUBMITTED: 'RequirementSubmitted',
    UPDATED: 'RequirementUpdated',
    PROPOSED: 'ArchitectureProposed',
    APPROVED: 'ArchitectureApproved',
    ARCHIVED: 'RequirementArchived',
    VERIFY_STARTED: 'DesignVerificationStarted',
    VERIFY_PASSED: 'DesignVerificationPassed',
    VERIFY_FAILED: 'DesignVerificationFailed',
    FAN_OUT_AUTHORIZED: 'FanOutAuthorized',
} as const;

function str(v: unknown, fallback = ''): string {
    return typeof v === 'string' ? v : fallback;
}

function ensureRow(
    map: Map<string, RequirementRow>,
    requirementId: string,
): RequirementRow {
    let row = map.get(requirementId);
    if (!row) {
        row = {
            requirementId,
            title: '',
            description: '',
            projectId: null,
            status: 'submitted',
            revision: 1,
            archived: false,
            archivedAt: null,
            verificationStatus: null,
            verificationFindings: [],
            verificationError: null,
        };
        map.set(requirementId, row);
    }
    return row;
}

/**
 * Apply one requirement lifecycle event to the map. Returns the affected row
 * (or null when the payload has no usable requirementId). Idempotent —
 * re-applying the same event yields the same row.
 */
export function applyRequirementEvent(
    map: Map<string, RequirementRow>,
    type: string,
    payload: Record<string, unknown>,
    occurredAt?: number,
): RequirementRow | null {
    const requirementId = str(payload?.requirementId);
    if (requirementId.length === 0) return null;

    switch (type) {
        case REQUIREMENT_EVENT_TYPES.SUBMITTED: {
            const row = ensureRow(map, requirementId);
            // Regenerate carries empty title/description — keep what we have.
            const title = str(payload.title);
            const description = str(payload.description);
            if (title) row.title = title;
            if (description) row.description = description;
            // Regenerate resubmits carry no projectId — keep the stored one.
            const projectId = str(payload.projectId);
            if (projectId) row.projectId = projectId;
            row.status = 'architecting';
            if (typeof payload.revision === 'number') row.revision = payload.revision;
            // A (re)submission supersedes any recorded verification state —
            // without this the failed-verification findings + decision
            // buttons kept rendering while the re-run architect was already
            // designing revision N+1.
            row.verificationStatus = null;
            row.verificationFindings = [];
            row.verificationError = null;
            return row;
        }
        case REQUIREMENT_EVENT_TYPES.UPDATED: {
            // Content-only edit (idle requirement) — status/revision untouched.
            const row = ensureRow(map, requirementId);
            const title = str(payload.title);
            if (title) row.title = title;
            if (typeof payload.description === 'string') row.description = payload.description;
            return row;
        }
        case REQUIREMENT_EVENT_TYPES.PROPOSED: {
            const row = ensureRow(map, requirementId);
            row.status = 'proposed';
            if (typeof payload.revision === 'number') row.revision = payload.revision;
            return row;
        }
        case REQUIREMENT_EVENT_TYPES.APPROVED: {
            const row = ensureRow(map, requirementId);
            row.status = 'approved';
            return row;
        }
        case REQUIREMENT_EVENT_TYPES.VERIFY_STARTED: {
            const row = ensureRow(map, requirementId);
            row.verificationStatus = 'verifying';
            row.verificationFindings = [];
            row.verificationError = null;
            return row;
        }
        case REQUIREMENT_EVENT_TYPES.VERIFY_PASSED: {
            const row = ensureRow(map, requirementId);
            row.verificationStatus = 'passed';
            row.verificationFindings = [];
            row.verificationError = null;
            return row;
        }
        case REQUIREMENT_EVENT_TYPES.VERIFY_FAILED: {
            const row = ensureRow(map, requirementId);
            row.verificationStatus = 'failed';
            row.verificationFindings = Array.isArray(payload.findings)
                ? (payload.findings as Array<Record<string, unknown>>)
                    .filter((f) => f && typeof f.finding === 'string')
                    .map((f) => ({
                        systemId: typeof f.systemId === 'string' ? f.systemId : null,
                        severity: typeof f.severity === 'string' ? f.severity : 'warning',
                        finding: f.finding as string,
                    }))
                : [];
            row.verificationError = str(payload.error) || null;
            return row;
        }
        case REQUIREMENT_EVENT_TYPES.FAN_OUT_AUTHORIZED: {
            const row = ensureRow(map, requirementId);
            if (payload.source === 'operator-override') {
                row.verificationStatus = 'overridden';
            }
            return row;
        }
        case REQUIREMENT_EVENT_TYPES.ARCHIVED: {
            const row = ensureRow(map, requirementId);
            row.archived = true;
            // Event time drives the archived-section recency window; a
            // replay keeps the original timestamp, a live event without
            // one falls back to "now".
            if (row.archivedAt === null) {
                row.archivedAt =
                    typeof occurredAt === 'number' ? occurredAt : Date.now();
            }
            return row;
        }
        default:
            return null;
    }
}
