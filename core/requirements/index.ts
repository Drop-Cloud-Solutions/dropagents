/**
 * Architect Tier — requirement lifecycle domain (Phase 2).
 *
 * A **requirement** is the top-level initiative: a business ask that the
 * architect agent turns into a cross-system design + a set of INDEPENDENT
 * per-system sub-briefs, which fan out into ordinary plans. This module owns
 * the pure domain core — commands, events, payload shapes + validators, the
 * command handlers, the parser for the architect agent's structured output,
 * and the pure fan-out builder. It has NO host/DB/agent dependencies so it is
 * trivially unit-testable (see `index.test.ts`).
 *
 * Lifecycle:
 *
 *   SubmitRequirement      → RequirementSubmitted(revision=1)   → spawn architect
 *   RegenerateArchitecture → RequirementSubmitted(revision=N)   → re-spawn architect
 *   (architect finishes)   → ArchitectureProposed              (orchestrator emits,
 *                                                                parsed from agent output)
 *   ApproveArchitecture    → ArchitectureApproved              → fan out sub-briefs
 *   ArchiveRequirement     → RequirementArchived
 *
 * The only cross-system ordering the architect may express is `rollout`
 * (deploy order). Sub-briefs carry NO development dependency — that
 * independence is a structural invariant of {@link ArchitectSubBrief} and is
 * re-checked in {@link validateArchitectureProposal}.
 */

import type { Event } from '../events/event';
import type { CommandHandler } from '../commands/bus';
import type { Command } from '../commands/command';
import type { SubmitBriefPayload } from '../commands';

export const RequirementCommands = {
    SUBMIT_REQUIREMENT: 'SubmitRequirement',
    UPDATE_REQUIREMENT: 'UpdateRequirement',
    APPROVE_ARCHITECTURE: 'ApproveArchitecture',
    REGENERATE_ARCHITECTURE: 'RegenerateArchitecture',
    ARCHIVE_REQUIREMENT: 'ArchiveRequirement',
    /** "Implement anyway" on a failed design verification — authorizes the
     *  fan-out despite findings. */
    PROCEED_FAN_OUT: 'ProceedFanOut',
    /** Re-run the design-verifier (after an agent error, or just to
     *  re-check). */
    RETRY_VERIFICATION: 'RetryVerification',
} as const;

export const RequirementEvents = {
    REQUIREMENT_SUBMITTED: 'RequirementSubmitted',
    REQUIREMENT_UPDATED: 'RequirementUpdated',
    ARCHITECTURE_PROPOSED: 'ArchitectureProposed',
    ARCHITECTURE_APPROVED: 'ArchitectureApproved',
    REQUIREMENT_ARCHIVED: 'RequirementArchived',
    // --- fan-out verification gate ------------------------------------
    // ArchitectureApproved no longer fans out directly. The design-
    // verifier agent audits the proposal (sub-briefs vs the full design)
    // first; plans are only created when FAN_OUT_AUTHORIZED lands —
    // published by the verifier on a pass, or by the operator's
    // ProceedFanOut ("Implement anyway") override.
    DESIGN_VERIFICATION_STARTED: 'DesignVerificationStarted',
    DESIGN_VERIFICATION_PASSED: 'DesignVerificationPassed',
    DESIGN_VERIFICATION_FAILED: 'DesignVerificationFailed',
    FAN_OUT_AUTHORIZED: 'FanOutAuthorized',
} as const;

// ----- design-verification payloads -------------------------------------

export interface DesignVerificationFinding {
    /** System/slice the finding targets; null for cross-plan findings. */
    readonly systemId: string | null;
    readonly severity: 'blocker' | 'warning';
    readonly finding: string;
}

export interface DesignVerificationStartedPayload {
    readonly requirementId: string;
    readonly revision: number;
}

export interface DesignVerificationPassedPayload {
    readonly requirementId: string;
    readonly revision: number;
    readonly summary?: string;
}

export interface DesignVerificationFailedPayload {
    readonly requirementId: string;
    readonly revision: number;
    readonly findings: readonly DesignVerificationFinding[];
    /** Set when the verifier AGENT errored (auth, invalid JSON) rather
     *  than producing a fail verdict — findings is then empty. */
    readonly error?: string;
    readonly summary?: string;
}

export interface FanOutAuthorizedPayload {
    readonly requirementId: string;
    readonly revision: number;
    readonly source: 'verification' | 'operator-override';
    readonly actor?: string;
}

export interface ProceedFanOutPayload {
    readonly requirementId: string;
    readonly revision: number;
}

export interface RetryVerificationPayload {
    readonly requirementId: string;
    readonly revision: number;
}

// ----- command payloads ------------------------------------------------

export interface SubmitRequirementPayload {
    readonly requirementId: string;
    readonly title: string;
    readonly description: string;
    /**
     * Board project the requirement belongs to. Every fanned-out sub-plan
     * lands under THIS project (the systems only pick each plan's target
     * repo), so the plans show up in the board's project views and follow
     * the normal plan lifecycle. Optional: the fan-out falls back to
     * DEFAULT_PROJECT_ID when unset.
     */
    readonly projectId?: string;
    readonly attachmentIds?: readonly string[];
}

/**
 * Content-only edit of a requirement that is NOT currently being
 * architected. Deliberately does NOT re-spawn the architect — the operator
 * edits the text first and re-runs explicitly (Regenerate) when ready, so
 * an edit can never race a live run into two concurrent architects.
 */
export interface UpdateRequirementPayload {
    readonly requirementId: string;
    /** New short label; omitted = keep the stored title. */
    readonly title?: string;
    /** New business-request text; omitted = keep the stored description. */
    readonly description?: string;
}

export interface RegenerateArchitecturePayload {
    readonly requirementId: string;
    /** Next revision to produce (caller supplies it, like GeneratePlan). */
    readonly revision: number;
    readonly feedback: string;
}

export interface ApproveArchitecturePayload {
    readonly requirementId: string;
    /** Revision being approved — the one the operator is looking at. */
    readonly revision: number;
}

export interface ArchiveRequirementPayload {
    readonly requirementId: string;
}

// ----- event payloads --------------------------------------------------

export interface RequirementSubmittedPayload {
    readonly requirementId: string;
    readonly title: string;
    readonly description: string;
    /** Board project the fan-out lands the sub-plans under. */
    readonly projectId?: string;
    readonly actor: string;
    /** 1 on first submit; increments on each RegenerateArchitecture. */
    readonly revision: number;
    readonly attachmentIds?: readonly string[];
    /** Operator feedback threaded through on a regenerate (revision > 1). */
    readonly feedback?: string;
}

export type ContractKind = 'event' | 'api' | 'message' | 'nuget-dto';

export interface ArchitectContract {
    readonly contractId: string;
    readonly kind: ContractKind;
    readonly name: string;
    readonly producer: string;
    readonly consumers: readonly string[];
    readonly summary: string;
    readonly schemaRef: string;
    readonly backwardCompatible: boolean;
}

/**
 * One system's slice of the work. Intentionally carries NO development
 * ordering ("after"/"dependsOn") — every sub-brief is independently
 * buildable and mergeable. Cross-system ordering lives only in
 * {@link RolloutStep}.
 */
export interface ArchitectSubBrief {
    readonly systemId: string;
    readonly title: string;
    readonly brief: string;
    readonly produces: readonly string[];
    readonly consumes: readonly string[];
}

export interface RolloutStep {
    readonly systemId: string;
    /** systemIds that must be DEPLOYED before this one goes live. */
    readonly deployAfter: readonly string[];
    readonly reason: string;
}

export interface ArchitectureProposedPayload {
    readonly requirementId: string;
    readonly actor: string;
    readonly revision: number;
    readonly designDocPath: string;
    readonly contracts: readonly ArchitectContract[];
    readonly subBriefs: readonly ArchitectSubBrief[];
    readonly rollout: readonly RolloutStep[];
    readonly contextImpact?: 'none' | 'possible' | 'likely';
    /**
     * The design document Markdown (with inline Mermaid diagrams) — the
     * narrative the architect emitted BEFORE the JSON proposal block. Set by
     * the orchestrator from the agent's raw output (not part of the JSON the
     * architect writes). The board renders it; a follow-on step commits it.
     */
    readonly designDoc?: string;
}

export interface ArchitectureApprovedPayload {
    readonly requirementId: string;
    readonly actor: string;
    readonly revision: number;
}

export interface RequirementArchivedPayload {
    readonly requirementId: string;
    readonly actor: string;
}

export interface RequirementUpdatedPayload {
    readonly requirementId: string;
    readonly actor: string;
    readonly title?: string;
    readonly description?: string;
}

// ----- command payload validators --------------------------------------

function nonEmptyString(v: unknown): v is string {
    return typeof v === 'string' && v.length > 0;
}

function stringArray(v: unknown): v is string[] {
    return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

export function isSubmitRequirementPayload(
    value: unknown,
): value is SubmitRequirementPayload {
    if (!value || typeof value !== 'object') return false;
    const v = value as Record<string, unknown>;
    if (!nonEmptyString(v.requirementId)) return false;
    if (!nonEmptyString(v.title)) return false;
    if (typeof v.description !== 'string') return false;
    if (v.projectId !== undefined && !nonEmptyString(v.projectId)) return false;
    if (v.attachmentIds !== undefined && !stringArray(v.attachmentIds)) return false;
    return true;
}

export function isUpdateRequirementPayload(
    value: unknown,
): value is UpdateRequirementPayload {
    if (!value || typeof value !== 'object') return false;
    const v = value as Record<string, unknown>;
    if (!nonEmptyString(v.requirementId)) return false;
    // title, when present, must be a real label; description may be any
    // string (mirrors SubmitRequirement, where empty description is legal).
    if (v.title !== undefined && !nonEmptyString(v.title)) return false;
    if (v.description !== undefined && typeof v.description !== 'string') return false;
    // A no-op update is a caller bug — require at least one field.
    if (v.title === undefined && v.description === undefined) return false;
    return true;
}

export function isRegenerateArchitecturePayload(
    value: unknown,
): value is RegenerateArchitecturePayload {
    if (!value || typeof value !== 'object') return false;
    const v = value as Record<string, unknown>;
    if (!nonEmptyString(v.requirementId)) return false;
    if (typeof v.revision !== 'number' || !Number.isInteger(v.revision) || v.revision < 2) {
        return false;
    }
    if (typeof v.feedback !== 'string') return false;
    return true;
}

export function isApproveArchitecturePayload(
    value: unknown,
): value is ApproveArchitecturePayload {
    if (!value || typeof value !== 'object') return false;
    const v = value as Record<string, unknown>;
    if (!nonEmptyString(v.requirementId)) return false;
    if (typeof v.revision !== 'number' || !Number.isInteger(v.revision) || v.revision < 1) {
        return false;
    }
    return true;
}

export function isArchiveRequirementPayload(
    value: unknown,
): value is ArchiveRequirementPayload {
    if (!value || typeof value !== 'object') return false;
    return nonEmptyString((value as Record<string, unknown>).requirementId);
}

// ----- architect output: validate + parse ------------------------------

const CONTRACT_KINDS: ReadonlySet<string> = new Set([
    'event',
    'api',
    'message',
    'nuget-dto',
]);
const CONTRACT_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

export type ArchitectureValidation =
    | { readonly ok: true; readonly value: ArchitectureProposedPayload }
    | { readonly ok: false; readonly error: string };

/**
 * Validate a parsed architect proposal object against the pinned wire format
 * (design doc §6). Enforces the independence invariant (sub-briefs have no
 * ordering) and referential integrity (every produced/consumed contractId is
 * declared; rollout only references known systems and never a self-edge).
 */
export function validateArchitectureProposal(
    value: unknown,
    expected?: { requirementId?: string; actor?: string; revision?: number },
): ArchitectureValidation {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return { ok: false, error: 'proposal is not an object' };
    }
    const v = value as Record<string, unknown>;
    // The orchestrator knows the requirementId + revision it spawned the
    // architect for, so prefer those (the model echoing them is error-prone) —
    // override rather than failing on a mismatch.
    const requirementId = (expected?.requirementId && expected.requirementId.length > 0)
        ? expected.requirementId
        : (nonEmptyString(v.requirementId) ? v.requirementId : null);
    if (requirementId === null) {
        return { ok: false, error: 'requirementId missing' };
    }
    const revision = (typeof v.revision === 'number' && Number.isInteger(v.revision) && v.revision >= 1)
        ? v.revision
        : (expected?.revision ?? 1);
    if (!nonEmptyString(v.designDocPath)) {
        return { ok: false, error: 'designDocPath missing' };
    }
    if (!Array.isArray(v.contracts)) {
        return { ok: false, error: 'contracts must be an array' };
    }
    const contractIds = new Set<string>();
    for (const [i, c] of (v.contracts as unknown[]).entries()) {
        const err = validateContract(c, i);
        if (err) return { ok: false, error: err };
        contractIds.add((c as ArchitectContract).contractId);
    }
    if (!Array.isArray(v.subBriefs) || v.subBriefs.length === 0) {
        return { ok: false, error: 'subBriefs must be a non-empty array' };
    }
    const systemIds = new Set<string>();
    for (const [i, s] of (v.subBriefs as unknown[]).entries()) {
        const err = validateSubBrief(s, i, contractIds);
        if (err) return { ok: false, error: err };
        systemIds.add((s as ArchitectSubBrief).systemId);
    }
    if (v.rollout !== undefined && !Array.isArray(v.rollout)) {
        return { ok: false, error: 'rollout must be an array' };
    }
    for (const [i, r] of ((v.rollout as unknown[]) ?? []).entries()) {
        const err = validateRolloutStep(r, i, systemIds);
        if (err) return { ok: false, error: err };
    }
    if (v.contextImpact !== undefined
        && !['none', 'possible', 'likely'].includes(v.contextImpact as string)) {
        return { ok: false, error: 'contextImpact must be none|possible|likely' };
    }

    const proposal: ArchitectureProposedPayload = {
        requirementId,
        actor: expected?.actor ?? 'architect',
        revision,
        designDocPath: v.designDocPath,
        contracts: v.contracts as ArchitectContract[],
        subBriefs: v.subBriefs as ArchitectSubBrief[],
        rollout: ((v.rollout as RolloutStep[]) ?? []),
        ...(v.contextImpact !== undefined
            ? { contextImpact: v.contextImpact as 'none' | 'possible' | 'likely' }
            : {}),
    };
    return { ok: true, value: proposal };
}

function validateContract(c: unknown, i: number): string | null {
    if (!c || typeof c !== 'object') return `contracts[${i}] is not an object`;
    const x = c as Record<string, unknown>;
    if (!nonEmptyString(x.contractId) || !CONTRACT_ID_RE.test(x.contractId)) {
        return `contracts[${i}].contractId must be a lowercase slug`;
    }
    if (!CONTRACT_KINDS.has(x.kind as string)) {
        return `contracts[${i}].kind must be one of event|api|message|nuget-dto`;
    }
    if (!nonEmptyString(x.name)) return `contracts[${i}].name missing`;
    if (!nonEmptyString(x.producer)) return `contracts[${i}].producer missing`;
    if (!stringArray(x.consumers)) return `contracts[${i}].consumers must be string[]`;
    if (typeof x.summary !== 'string') return `contracts[${i}].summary missing`;
    if (!nonEmptyString(x.schemaRef)) return `contracts[${i}].schemaRef missing`;
    if (typeof x.backwardCompatible !== 'boolean') {
        return `contracts[${i}].backwardCompatible must be boolean`;
    }
    return null;
}

function validateSubBrief(
    s: unknown,
    i: number,
    contractIds: ReadonlySet<string>,
): string | null {
    if (!s || typeof s !== 'object') return `subBriefs[${i}] is not an object`;
    const x = s as Record<string, unknown>;
    if (!nonEmptyString(x.systemId)) return `subBriefs[${i}].systemId missing`;
    if (!nonEmptyString(x.title)) return `subBriefs[${i}].title missing`;
    if (!nonEmptyString(x.brief)) return `subBriefs[${i}].brief missing`;
    if (!stringArray(x.produces)) return `subBriefs[${i}].produces must be string[]`;
    if (!stringArray(x.consumes)) return `subBriefs[${i}].consumes must be string[]`;
    for (const id of [...x.produces, ...x.consumes] as string[]) {
        if (!contractIds.has(id)) {
            return `subBriefs[${i}] references unknown contractId "${id}"`;
        }
    }
    // Independence invariant: no development-ordering fields are permitted.
    for (const banned of ['dependsOn', 'after', 'blockedBy']) {
        if (banned in x) {
            return `subBriefs[${i}] must not declare "${banned}" — development is independent`;
        }
    }
    return null;
}

function validateRolloutStep(
    r: unknown,
    i: number,
    systemIds: ReadonlySet<string>,
): string | null {
    if (!r || typeof r !== 'object') return `rollout[${i}] is not an object`;
    const x = r as Record<string, unknown>;
    if (!nonEmptyString(x.systemId)) return `rollout[${i}].systemId missing`;
    if (!systemIds.has(x.systemId)) {
        return `rollout[${i}].systemId "${x.systemId}" is not one of the sub-brief systems`;
    }
    if (!stringArray(x.deployAfter)) return `rollout[${i}].deployAfter must be string[]`;
    if (typeof x.reason !== 'string') return `rollout[${i}].reason missing`;
    for (const dep of x.deployAfter as string[]) {
        if (dep === x.systemId) return `rollout[${i}] has a self deploy-edge`;
        if (!systemIds.has(dep)) {
            return `rollout[${i}].deployAfter references unknown system "${dep}"`;
        }
    }
    return null;
}

/**
 * Extract + validate the architect agent's structured proposal from its final
 * message. Robust to narration / markdown around the JSON (the model rarely
 * emits a single clean fenced block): it collects candidate JSON objects from
 * fenced blocks + every brace-balanced span, and returns the first that BOTH
 * parses and validates. Mirrors the decomposer's forgiving extraction.
 */
export function parseArchitectureProposal(
    text: string,
    expected?: { requirementId?: string; actor?: string; revision?: number },
): ArchitectureValidation {
    if (typeof text !== 'string' || text.trim().length === 0) {
        return { ok: false, error: 'architect produced no output' };
    }
    const candidates = jsonCandidates(text);
    if (candidates.length === 0) {
        return { ok: false, error: 'no JSON object found in architect output' };
    }
    let lastError = 'architect output did not contain a valid proposal';
    for (const cand of candidates) {
        let parsed: unknown;
        try {
            parsed = JSON.parse(cand);
        } catch (err) {
            lastError = `architect output is not valid JSON: ${err instanceof Error ? err.message : String(err)}`;
            continue;
        }
        const res = validateArchitectureProposal(parsed, expected);
        if (res.ok) return res;
        lastError = res.error;
    }
    return { ok: false, error: lastError };
}

/**
 * The design-document Markdown the architect emitted — everything BEFORE the
 * trailing ```json proposal block. Returns the whole trimmed text when no
 * fenced json block is present.
 */
export function extractDesignDoc(text: string): string {
    if (typeof text !== 'string') return '';
    const idx = text.toLowerCase().lastIndexOf('```json');
    const head = idx >= 0 ? text.slice(0, idx) : text;
    return head.trim();
}

/**
 * Candidate JSON strings from the architect output, best-first: the last
 * brace-balanced object inside each fenced ```json / ``` block, then every
 * top-level brace-balanced {…} span in the whole text, LAST first (the
 * proposal follows the design Markdown). Deduped, order-preserving.
 */
function jsonCandidates(text: string): string[] {
    const cands: string[] = [];
    const fenceRe = /```(?:json)?\s*\n([\s\S]*?)```/gi;
    let m: RegExpExecArray | null;
    while ((m = fenceRe.exec(text)) !== null) {
        const objs = scanAllBalancedObjects(m[1]);
        if (objs.length > 0) cands.push(objs[objs.length - 1]);
    }
    const all = scanAllBalancedObjects(text);
    for (let k = all.length - 1; k >= 0; k -= 1) cands.push(all[k]);
    return [...new Set(cands)];
}

/**
 * Every top-level brace-balanced {…} substring in `text`, respecting string
 * literals + escapes. Ported from the decomposer's `scanBalancedObject` but
 * returning ALL objects so a proposal that follows the design Markdown is
 * reachable.
 */
function scanAllBalancedObjects(text: string): string[] {
    const out: string[] = [];
    let i = 0;
    while (i < text.length) {
        if (text[i] !== '{') { i += 1; continue; }
        let depth = 0;
        let inString = false;
        let escaped = false;
        let closed = false;
        let j = i;
        for (; j < text.length; j += 1) {
            const ch = text[j];
            if (inString) {
                if (escaped) escaped = false;
                else if (ch === '\\') escaped = true;
                else if (ch === '"') inString = false;
                continue;
            }
            if (ch === '"') { inString = true; continue; }
            if (ch === '{') depth += 1;
            else if (ch === '}') {
                depth -= 1;
                if (depth === 0) { out.push(text.slice(i, j + 1)); closed = true; break; }
            }
        }
        i = closed ? j + 1 : i + 1;
    }
    return out;
}

// ----- command handlers ------------------------------------------------

export interface RequirementLifecycleDeps {
    readonly clock: () => number;
}

export function createSubmitRequirementHandler(
    deps: RequirementLifecycleDeps,
): CommandHandler<Command<SubmitRequirementPayload>> {
    return async (cmd) => {
        if (!isSubmitRequirementPayload(cmd.payload)) {
            throw new Error('SubmitRequirement: invalid payload');
        }
        const { requirementId, title, description, projectId, attachmentIds } = cmd.payload;
        const payload: RequirementSubmittedPayload = {
            requirementId,
            title,
            description,
            ...(projectId !== undefined ? { projectId } : {}),
            actor: cmd.actor,
            revision: 1,
        };
        if (attachmentIds !== undefined) {
            (payload as { attachmentIds: readonly string[] }).attachmentIds = attachmentIds;
        }
        return [event(RequirementEvents.REQUIREMENT_SUBMITTED,
            `${RequirementCommands.SUBMIT_REQUIREMENT}:${requirementId}:r1`, payload, deps)];
    };
}

export interface UpdateRequirementDeps extends RequirementLifecycleDeps {
    /**
     * Current projection status for a requirement (`submitted` /
     * `architecting` / `proposed` / `approved` / `archived`), or undefined
     * when the id is unknown. Injected by the host so the handler can
     * reject an edit while the architect is RUNNING — the run's prompt was
     * built from the old text, so a mid-run edit would silently produce a
     * design for a request nobody can see any more.
     */
    readonly getRequirementStatus?: (requirementId: string) => string | undefined;
}

export function createUpdateRequirementHandler(
    deps: UpdateRequirementDeps,
): CommandHandler<Command<UpdateRequirementPayload>> {
    return async (cmd) => {
        if (!isUpdateRequirementPayload(cmd.payload)) {
            throw new Error('UpdateRequirement: invalid payload');
        }
        const { requirementId, title, description } = cmd.payload;
        if (deps.getRequirementStatus) {
            const status = deps.getRequirementStatus(requirementId);
            if (status === undefined) {
                throw new Error(`UpdateRequirement: unknown requirement "${requirementId}"`);
            }
            if (status === 'architecting') {
                throw new Error(
                    'UpdateRequirement: the architect is running for this requirement — '
                    + 'wait for it to finish (or re-run it afterwards with the new text)',
                );
            }
            if (status === 'archived') {
                throw new Error('UpdateRequirement: requirement is archived');
            }
        }
        const payload: RequirementUpdatedPayload = {
            requirementId,
            actor: cmd.actor,
            ...(title !== undefined ? { title } : {}),
            ...(description !== undefined ? { description } : {}),
        };
        // issuedAt in the key: unlike submit/approve (one-shot per revision),
        // edits legitimately repeat.
        return [event(RequirementEvents.REQUIREMENT_UPDATED,
            `${RequirementCommands.UPDATE_REQUIREMENT}:${requirementId}:${cmd.issuedAt}`, payload, deps)];
    };
}

export function createRegenerateArchitectureHandler(
    deps: RequirementLifecycleDeps,
): CommandHandler<Command<RegenerateArchitecturePayload>> {
    return async (cmd) => {
        if (!isRegenerateArchitecturePayload(cmd.payload)) {
            throw new Error('RegenerateArchitecture: invalid payload');
        }
        const { requirementId, revision, feedback } = cmd.payload;
        // Re-uses RequirementSubmitted so the orchestrator spawns the architect
        // through one path; the revision + feedback drive the re-design.
        const payload: RequirementSubmittedPayload = {
            requirementId,
            // title/description are carried on the projection already; the
            // orchestrator reads them from there for the re-spawn.
            title: '',
            description: '',
            actor: cmd.actor,
            revision,
            feedback,
        };
        return [event(RequirementEvents.REQUIREMENT_SUBMITTED,
            `${RequirementCommands.SUBMIT_REQUIREMENT}:${requirementId}:r${revision}`, payload, deps)];
    };
}

export function createApproveArchitectureHandler(
    deps: RequirementLifecycleDeps,
): CommandHandler<Command<ApproveArchitecturePayload>> {
    return async (cmd) => {
        if (!isApproveArchitecturePayload(cmd.payload)) {
            throw new Error('ApproveArchitecture: invalid payload');
        }
        const { requirementId, revision } = cmd.payload;
        const payload: ArchitectureApprovedPayload = {
            requirementId,
            actor: cmd.actor,
            revision,
        };
        return [event(RequirementEvents.ARCHITECTURE_APPROVED,
            `${RequirementCommands.APPROVE_ARCHITECTURE}:${requirementId}:r${revision}`, payload, deps)];
    };
}

function isRequirementRevisionPayload(
    v: unknown,
): v is { requirementId: string; revision: number } {
    if (!v || typeof v !== 'object') return false;
    const p = v as { requirementId?: unknown; revision?: unknown };
    return (
        typeof p.requirementId === 'string'
        && p.requirementId.length > 0
        && typeof p.revision === 'number'
        && Number.isFinite(p.revision)
    );
}

/**
 * "Implement anyway": the operator overrides a failed (or errored) design
 * verification and authorizes the fan-out. Emits the same
 * `FanOutAuthorized` event the verifier emits on a pass, tagged
 * `operator-override` so the projection/UI can show that the gate was
 * bypassed. issuedAt in the key: a re-click after a regenerate cycle must
 * land as a fresh event.
 */
export function createProceedFanOutHandler(
    deps: RequirementLifecycleDeps,
): CommandHandler<Command<ProceedFanOutPayload>> {
    return async (cmd) => {
        if (!isRequirementRevisionPayload(cmd.payload)) {
            throw new Error('ProceedFanOut: invalid payload (requirementId + revision required)');
        }
        const { requirementId, revision } = cmd.payload;
        const payload: FanOutAuthorizedPayload = {
            requirementId,
            revision,
            source: 'operator-override',
            actor: cmd.actor,
        };
        return [event(RequirementEvents.FAN_OUT_AUTHORIZED,
            `${RequirementCommands.PROCEED_FAN_OUT}:${requirementId}:${cmd.issuedAt}`,
            payload, deps)];
    };
}

/**
 * Re-run the design verification (after an agent error, or on demand).
 * Emits DesignVerificationStarted; the orchestrator's subscriber spawns
 * the verifier off that event — the same single spawn path the
 * ArchitectureApproved trigger uses.
 */
export function createRetryVerificationHandler(
    deps: RequirementLifecycleDeps,
): CommandHandler<Command<RetryVerificationPayload>> {
    return async (cmd) => {
        if (!isRequirementRevisionPayload(cmd.payload)) {
            throw new Error('RetryVerification: invalid payload (requirementId + revision required)');
        }
        const { requirementId, revision } = cmd.payload;
        const payload: DesignVerificationStartedPayload = { requirementId, revision };
        return [event(RequirementEvents.DESIGN_VERIFICATION_STARTED,
            `${RequirementCommands.RETRY_VERIFICATION}:${requirementId}:${cmd.issuedAt}`,
            payload, deps)];
    };
}

export function createArchiveRequirementHandler(
    deps: RequirementLifecycleDeps,
): CommandHandler<Command<ArchiveRequirementPayload>> {
    return async (cmd) => {
        if (!isArchiveRequirementPayload(cmd.payload)) {
            throw new Error('ArchiveRequirement: invalid payload');
        }
        const { requirementId } = cmd.payload;
        const payload: RequirementArchivedPayload = { requirementId, actor: cmd.actor };
        return [event(RequirementEvents.REQUIREMENT_ARCHIVED,
            `${RequirementCommands.ARCHIVE_REQUIREMENT}:${requirementId}`, payload, deps)];
    };
}

function event(
    type: string,
    idempotencyKey: string,
    payload: unknown,
    deps: RequirementLifecycleDeps,
): Event {
    return { type, v: 1, occurredAt: deps.clock(), idempotencyKey, payload } as Event;
}

// ----- fan-out ---------------------------------------------------------

/**
 * Turn an approved proposal into one {@link SubmitBriefPayload} per system —
 * the Phase-2 fan-out. Each brief is tagged with the requirementId so the
 * child plan links back, and its `projectId` is the sub-brief's systemId. No
 * ordering is emitted; every plan proceeds independently.
 */
export function buildFanOutBriefs(
    proposal: ArchitectureProposedPayload,
    genBriefId: () => string,
): SubmitBriefPayload[] {
    return proposal.subBriefs.map((sb) => ({
        briefId: genBriefId(),
        projectId: sb.systemId,
        content: sb.brief,
        requirementId: proposal.requirementId,
    }));
}
