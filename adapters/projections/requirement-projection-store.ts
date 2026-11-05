/**
 * Architect Tier (Phase 2) — projection store folding the requirement
 * lifecycle events into the `requirements` + child tables (migration 023).
 *
 * Shape parallels `plan-projection-store.ts`: the constructor wires named
 * subscriptions against the `EventBus` so a host can `replayMissed(
 * REQUIREMENT_PROJECTION_SUBSCRIBER)` after a restart, and per-row state lives
 * in SQLite with a monotonic `updated_at` guard so a replay is a no-op.
 *
 * Folds:
 *   - RequirementSubmitted  → upsert the requirement (status='architecting',
 *                             revision); title/description only on the first
 *                             revision (regenerate carries them empty).
 *   - RequirementUpdated    → content-only title/description edit (operator,
 *                             idle requirement); status/revision untouched.
 *   - ArchitectureProposed  → status='proposed' + design_doc_path; REPLACE the
 *                             requirement's contracts / sub-briefs / rollout
 *                             (the latest revision supersedes).
 *   - ArchitectureApproved  → status='approved'.
 *   - RequirementArchived   → stamp archived_at.
 *   - BriefSubmitted (with requirementId) → insert a requirement_plans row
 *                             (fan-out linkage).
 */

import type { EventBus } from '../../core/events/bus';
import type { StoredEvent } from '../../core/events/event';
import type { Db } from '../../core/state/migrations';
import type { Logger } from '../../core/ports/Logger';
import type {
    ArchitectureApprovedPayload,
    ArchitectureProposedPayload,
    RequirementArchivedPayload,
    RequirementSubmittedPayload,
    RequirementUpdatedPayload,
} from '../../core/requirements';
import type { BriefSubmittedEventPayload } from '../../core/commands';

export const REQUIREMENT_PROJECTION_SUBSCRIBER = 'requirement-projection-store';

export const REQUIREMENT_PROJECTION_EVENT_TYPES = {
    SUBMITTED: 'RequirementSubmitted',
    UPDATED: 'RequirementUpdated',
    PROPOSED: 'ArchitectureProposed',
    APPROVED: 'ArchitectureApproved',
    ARCHIVED: 'RequirementArchived',
    BRIEF_SUBMITTED: 'BriefSubmitted',
    // Fan-out verification gate (design-verifier agent).
    VERIFY_STARTED: 'DesignVerificationStarted',
    VERIFY_PASSED: 'DesignVerificationPassed',
    VERIFY_FAILED: 'DesignVerificationFailed',
    FAN_OUT_AUTHORIZED: 'FanOutAuthorized',
} as const;

export interface RequirementRow {
    readonly requirementId: string;
    readonly title: string;
    readonly description: string;
    /** Board project the fan-out lands sub-plans under (nullable). */
    readonly projectId: string | null;
    readonly status: string;
    readonly revision: number;
    readonly designDocPath: string | null;
    /** NULL | 'verifying' | 'passed' | 'failed' | 'overridden' */
    readonly verificationStatus: string | null;
    /** JSON blob: { findings: [{systemId,severity,finding}], error?, summary? } */
    readonly verificationFindings: string | null;
    readonly createdAt: number;
    readonly updatedAt: number;
    readonly archivedAt: number | null;
}

export class RequirementProjectionStore {
    private readonly submitStmt;
    private readonly updateStmt;
    private readonly proposeStmt;
    private readonly approveStmt;
    private readonly archiveStmt;
    private readonly verifyStmt;
    private readonly delContracts;
    private readonly delConsumers;
    private readonly delSubbriefs;
    private readonly delRollout;
    private readonly insContract;
    private readonly insConsumer;
    private readonly insSubbrief;
    private readonly insRollout;
    private readonly insPlanLink;
    private readonly replaceProposal: (p: ArchitectureProposedPayload, at: number) => void;
    private readonly logger?: Logger;

    constructor(private readonly db: Db, bus: EventBus, logger?: Logger) {
        this.logger = logger;

        // Upsert on submit. On the first revision insert title/description; on
        // a regenerate (revision > 1, empty title/description) keep the stored
        // values via COALESCE-of-nonempty. Monotonic guard on updated_at.
        this.submitStmt = db.prepare(
            `INSERT INTO requirements(
                 requirement_id, title, description, project_id, status, revision, created_at, updated_at)
             VALUES (@id, @title, @description, @projectId, 'architecting', @revision, @at, @at)
             ON CONFLICT(requirement_id) DO UPDATE SET
                 title       = CASE WHEN excluded.title <> '' THEN excluded.title ELSE requirements.title END,
                 description = CASE WHEN excluded.description <> '' THEN excluded.description ELSE requirements.description END,
                 project_id  = COALESCE(excluded.project_id, requirements.project_id),
                 status      = 'architecting',
                 revision    = excluded.revision,
                 updated_at  = excluded.updated_at
             WHERE excluded.updated_at >= requirements.updated_at`,
        );

        // Content-only edit: set exactly the supplied fields, leave
        // status/revision alone. `@title`/`@description` are null when the
        // event omitted them; empty-string description is a legal clear
        // (mirrors SubmitRequirement, where description may be empty).
        this.updateStmt = db.prepare(
            `UPDATE requirements
                SET title       = CASE WHEN @title IS NOT NULL THEN @title ELSE title END,
                    description = CASE WHEN @description IS NOT NULL THEN @description ELSE description END,
                    updated_at  = @at
              WHERE requirement_id = @id AND @at >= COALESCE(updated_at, 0)`,
        );

        this.proposeStmt = db.prepare(
            `UPDATE requirements
                SET status = 'proposed', revision = @revision,
                    design_doc_path = @designDocPath,
                    design_md = COALESCE(@designMd, design_md),
                    updated_at = @at
              WHERE requirement_id = @id AND @at >= COALESCE(updated_at, 0)`,
        );
        this.approveStmt = db.prepare(
            `UPDATE requirements
                SET status = 'approved', updated_at = @at
              WHERE requirement_id = @id AND @at >= COALESCE(updated_at, 0)`,
        );
        this.archiveStmt = db.prepare(
            `UPDATE requirements
                SET archived_at = @at, updated_at = @at
              WHERE requirement_id = @id AND @at >= COALESCE(updated_at, 0)`,
        );
        // Fan-out verification gate: one statement covers all four events —
        // status transitions plus the findings blob (null clears it).
        // No monotonic guard on updated_at: verification events always
        // FOLLOW the approve that started them, and a retry legitimately
        // rewrites the state.
        this.verifyStmt = db.prepare(
            `UPDATE requirements
                SET verification_status = @status,
                    verification_findings = @findings,
                    updated_at = @at
              WHERE requirement_id = @id`,
        );

        this.delContracts = db.prepare('DELETE FROM requirement_contracts WHERE requirement_id = ?');
        this.delConsumers = db.prepare('DELETE FROM requirement_contract_consumers WHERE requirement_id = ?');
        this.delSubbriefs = db.prepare('DELETE FROM requirement_subbriefs WHERE requirement_id = ?');
        this.delRollout = db.prepare('DELETE FROM requirement_rollout WHERE requirement_id = ?');

        this.insContract = db.prepare(
            `INSERT OR REPLACE INTO requirement_contracts(
                 requirement_id, contract_id, kind, name, producer_system,
                 summary, schema_ref, backward_compatible)
             VALUES (@rid, @cid, @kind, @name, @producer, @summary, @schemaRef, @bc)`,
        );
        this.insConsumer = db.prepare(
            `INSERT OR REPLACE INTO requirement_contract_consumers(requirement_id, contract_id, system_id)
             VALUES (@rid, @cid, @sid)`,
        );
        this.insSubbrief = db.prepare(
            `INSERT OR REPLACE INTO requirement_subbriefs(
                 requirement_id, system_id, title, brief, produces, consumes)
             VALUES (@rid, @sid, @title, @brief, @produces, @consumes)`,
        );
        this.insRollout = db.prepare(
            `INSERT OR REPLACE INTO requirement_rollout(requirement_id, system_id, deploy_after, reason)
             VALUES (@rid, @sid, @after, @reason)`,
        );
        this.insPlanLink = db.prepare(
            `INSERT OR IGNORE INTO requirement_plans(requirement_id, brief_id, system_id, plan_id)
             VALUES (@rid, @briefId, @sid, NULL)`,
        );

        // Replace all of a requirement's proposal-derived rows in one tx.
        this.replaceProposal = db.transaction(
            (p: ArchitectureProposedPayload, _at: number) => {
                this.delContracts.run(p.requirementId);
                this.delConsumers.run(p.requirementId);
                this.delSubbriefs.run(p.requirementId);
                this.delRollout.run(p.requirementId);
                for (const c of p.contracts) {
                    this.insContract.run({
                        rid: p.requirementId, cid: c.contractId, kind: c.kind,
                        name: c.name, producer: c.producer, summary: c.summary,
                        schemaRef: c.schemaRef, bc: c.backwardCompatible ? 1 : 0,
                    });
                    for (const sid of c.consumers) {
                        this.insConsumer.run({ rid: p.requirementId, cid: c.contractId, sid });
                    }
                }
                for (const s of p.subBriefs) {
                    this.insSubbrief.run({
                        rid: p.requirementId, sid: s.systemId, title: s.title,
                        brief: s.brief, produces: JSON.stringify(s.produces),
                        consumes: JSON.stringify(s.consumes),
                    });
                }
                for (const r of p.rollout) {
                    for (const after of r.deployAfter) {
                        this.insRollout.run({
                            rid: p.requirementId, sid: r.systemId, after, reason: r.reason,
                        });
                    }
                }
            },
        );

        bus.subscribe<RequirementSubmittedPayload>(
            REQUIREMENT_PROJECTION_EVENT_TYPES.SUBMITTED,
            (e) => this.onSubmitted(e),
            { subscriber: REQUIREMENT_PROJECTION_SUBSCRIBER },
        );
        bus.subscribe<RequirementUpdatedPayload>(
            REQUIREMENT_PROJECTION_EVENT_TYPES.UPDATED,
            (e) => this.onUpdated(e),
            { subscriber: REQUIREMENT_PROJECTION_SUBSCRIBER },
        );
        bus.subscribe<ArchitectureProposedPayload>(
            REQUIREMENT_PROJECTION_EVENT_TYPES.PROPOSED,
            (e) => this.onProposed(e),
            { subscriber: REQUIREMENT_PROJECTION_SUBSCRIBER },
        );
        bus.subscribe<ArchitectureApprovedPayload>(
            REQUIREMENT_PROJECTION_EVENT_TYPES.APPROVED,
            (e) => this.onApproved(e),
            { subscriber: REQUIREMENT_PROJECTION_SUBSCRIBER },
        );
        bus.subscribe<RequirementArchivedPayload>(
            REQUIREMENT_PROJECTION_EVENT_TYPES.ARCHIVED,
            (e) => this.onArchived(e),
            { subscriber: REQUIREMENT_PROJECTION_SUBSCRIBER },
        );
        bus.subscribe<BriefSubmittedEventPayload>(
            REQUIREMENT_PROJECTION_EVENT_TYPES.BRIEF_SUBMITTED,
            (e) => this.onBriefSubmitted(e),
            { subscriber: REQUIREMENT_PROJECTION_SUBSCRIBER },
        );
        bus.subscribe<{ requirementId?: string }>(
            REQUIREMENT_PROJECTION_EVENT_TYPES.VERIFY_STARTED,
            (e) => this.onVerification(e, 'verifying', null),
            { subscriber: REQUIREMENT_PROJECTION_SUBSCRIBER },
        );
        bus.subscribe<{ requirementId?: string; summary?: string }>(
            REQUIREMENT_PROJECTION_EVENT_TYPES.VERIFY_PASSED,
            (e) => this.onVerification(e, 'passed', {
                findings: [],
                ...(typeof e.payload?.summary === 'string' ? { summary: e.payload.summary } : {}),
            }),
            { subscriber: REQUIREMENT_PROJECTION_SUBSCRIBER },
        );
        bus.subscribe<{
            requirementId?: string;
            findings?: unknown;
            error?: string;
            summary?: string;
        }>(
            REQUIREMENT_PROJECTION_EVENT_TYPES.VERIFY_FAILED,
            (e) => this.onVerification(e, 'failed', {
                findings: Array.isArray(e.payload?.findings) ? e.payload.findings : [],
                ...(typeof e.payload?.error === 'string' ? { error: e.payload.error } : {}),
                ...(typeof e.payload?.summary === 'string' ? { summary: e.payload.summary } : {}),
            }),
            { subscriber: REQUIREMENT_PROJECTION_SUBSCRIBER },
        );
        bus.subscribe<{ requirementId?: string; source?: string }>(
            REQUIREMENT_PROJECTION_EVENT_TYPES.FAN_OUT_AUTHORIZED,
            (e) => {
                // A verifier pass already wrote 'passed'; only the operator
                // override needs recording (keeps the findings visible so
                // the card can show WHAT was overridden).
                if (e.payload?.source !== 'operator-override') return;
                const requirementId = e.payload?.requirementId;
                if (typeof requirementId !== 'string' || requirementId.length === 0) return;
                const current = this.get(requirementId);
                this.verifyStmt.run({
                    id: requirementId,
                    status: 'overridden',
                    findings: current?.verificationFindings ?? null,
                    at: e.occurredAt,
                });
            },
            { subscriber: REQUIREMENT_PROJECTION_SUBSCRIBER },
        );
    }

    private onVerification(
        event: StoredEvent & { payload: { requirementId?: string } },
        status: string,
        blob: Record<string, unknown> | null,
    ): void {
        const requirementId = event.payload?.requirementId;
        if (typeof requirementId !== 'string' || requirementId.length === 0) return;
        this.verifyStmt.run({
            id: requirementId,
            status,
            findings: blob === null ? null : JSON.stringify(blob),
            at: event.occurredAt,
        });
    }

    private onSubmitted(event: StoredEvent & { payload: RequirementSubmittedPayload }): void {
        const p = event.payload;
        if (typeof p?.requirementId !== 'string' || p.requirementId.length === 0) return;
        // A (re)submission supersedes any recorded verification state — the
        // failed-verification findings must not survive into (or re-hydrate
        // during) the new architect run.
        this.verifyStmt.run({
            id: p.requirementId,
            status: null,
            findings: null,
            at: event.occurredAt,
        });
        this.submitStmt.run({
            id: p.requirementId,
            title: typeof p.title === 'string' ? p.title : '',
            description: typeof p.description === 'string' ? p.description : '',
            projectId:
                typeof p.projectId === 'string' && p.projectId.length > 0
                    ? p.projectId
                    : null,
            revision: typeof p.revision === 'number' ? p.revision : 1,
            at: event.occurredAt,
        });
    }

    private onUpdated(event: StoredEvent & { payload: RequirementUpdatedPayload }): void {
        const p = event.payload;
        if (typeof p?.requirementId !== 'string' || p.requirementId.length === 0) return;
        this.updateStmt.run({
            id: p.requirementId,
            title: typeof p.title === 'string' && p.title.length > 0 ? p.title : null,
            description: typeof p.description === 'string' ? p.description : null,
            at: event.occurredAt,
        });
    }

    private onProposed(event: StoredEvent & { payload: ArchitectureProposedPayload }): void {
        const p = event.payload;
        if (typeof p?.requirementId !== 'string' || p.requirementId.length === 0) return;
        this.proposeStmt.run({
            id: p.requirementId,
            revision: typeof p.revision === 'number' ? p.revision : 1,
            designDocPath: typeof p.designDocPath === 'string' ? p.designDocPath : null,
            designMd: typeof p.designDoc === 'string' ? p.designDoc : null,
            at: event.occurredAt,
        });
        try {
            this.replaceProposal(p, event.occurredAt);
        } catch (err) {
            this.logger?.warn('requirement-projection: proposal replace failed', {
                requirementId: p.requirementId,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    private onApproved(event: StoredEvent & { payload: ArchitectureApprovedPayload }): void {
        const id = event.payload?.requirementId;
        if (typeof id !== 'string' || id.length === 0) return;
        this.approveStmt.run({ id, at: event.occurredAt });
    }

    private onArchived(event: StoredEvent & { payload: RequirementArchivedPayload }): void {
        const id = event.payload?.requirementId;
        if (typeof id !== 'string' || id.length === 0) return;
        this.archiveStmt.run({ id, at: event.occurredAt });
    }

    private onBriefSubmitted(event: StoredEvent & { payload: BriefSubmittedEventPayload }): void {
        const p = event.payload;
        if (typeof p?.requirementId !== 'string' || p.requirementId.length === 0) return;
        if (typeof p.briefId !== 'string' || p.briefId.length === 0) return;
        this.insPlanLink.run({
            rid: p.requirementId,
            briefId: p.briefId,
            // Prefer the explicit systemId (repo id) — projectId is the BOARD
            // project since the fan-out landed plans under real projects.
            sid: typeof (p as { systemId?: unknown }).systemId === 'string'
                ? (p as { systemId: string }).systemId
                : typeof p.projectId === 'string' ? p.projectId : '',
        });
    }

    // ----- read surface (board API) -----

    listActive(): RequirementRow[] {
        return (this.db
            .prepare('SELECT * FROM requirements WHERE archived_at IS NULL ORDER BY updated_at DESC')
            .all() as RawRow[]).map(mapRow);
    }

    get(requirementId: string): RequirementRow | null {
        const r = this.db
            .prepare('SELECT * FROM requirements WHERE requirement_id = ?')
            .get(requirementId) as RawRow | undefined;
        return r ? mapRow(r) : null;
    }

    /** The stored design-doc Markdown, or null. */
    getDesignDoc(requirementId: string): string | null {
        const r = this.db
            .prepare('SELECT design_md FROM requirements WHERE requirement_id = ?')
            .get(requirementId) as { design_md: string | null } | undefined;
        return r?.design_md ?? null;
    }

    contractsFor(requirementId: string): unknown[] {
        return this.db
            .prepare('SELECT * FROM requirement_contracts WHERE requirement_id = ? ORDER BY contract_id')
            .all(requirementId);
    }

    subBriefsFor(requirementId: string): unknown[] {
        return this.db
            .prepare('SELECT * FROM requirement_subbriefs WHERE requirement_id = ? ORDER BY system_id')
            .all(requirementId);
    }

    rolloutFor(requirementId: string): unknown[] {
        return this.db
            .prepare('SELECT * FROM requirement_rollout WHERE requirement_id = ?')
            .all(requirementId);
    }

    plansFor(requirementId: string): unknown[] {
        return this.db
            .prepare('SELECT * FROM requirement_plans WHERE requirement_id = ? ORDER BY system_id')
            .all(requirementId);
    }
}

interface RawRow {
    requirement_id: string;
    title: string;
    description: string;
    project_id: string | null;
    status: string;
    revision: number;
    design_doc_path: string | null;
    verification_status: string | null;
    verification_findings: string | null;
    created_at: number;
    updated_at: number;
    archived_at: number | null;
}

function mapRow(r: RawRow): RequirementRow {
    return {
        requirementId: r.requirement_id,
        title: r.title,
        description: r.description,
        projectId: r.project_id ?? null,
        status: r.status,
        revision: r.revision,
        designDocPath: r.design_doc_path,
        verificationStatus: r.verification_status ?? null,
        verificationFindings: r.verification_findings ?? null,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        archivedAt: r.archived_at,
    };
}
