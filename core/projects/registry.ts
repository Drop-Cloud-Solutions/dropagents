/**
 * ProjectRegistry — the operator-defined catalogue of projects this pipeline
 * drives. One project = one Linear team + one GitHub owner + an independent
 * credential bundle, indexed by `id` for O(1) lookup.
 *
 * The source is the `projects` projection — `fromDb(db)`.
 *
 * It used to be `config/projects/<id>/project.json`. Project configuration
 * is WORKER state: two machines legitimately run different projects, with
 * different repos and different settings, so it is not application source
 * and does not belong in the git repo. The files were also a half-truth —
 * only the manager-api ever wrote one, so a project created from the board
 * had none at all and silently ran with no repos, no credential mapping
 * and no approval overrides.
 *
 * Credentials stay indirect: the record declares which env var names hold
 * each secret and the registry resolves them at `get()` time, so real
 * tokens live only in the environment.
 */

import type { FlowDefinition } from '../flow/types';
import type { Db } from '../state/migrations';

export interface ProjectCredentials {
    readonly linearApiKey?: string;
    readonly jiraEmail?: string;
    readonly jiraApiToken?: string;
    readonly gitHubToken?: string;
}

/**
 * A single repository entry on a project. v2 supports many repos per project
 * (api + frontend-lib + docs, etc.) — the host's `RepoFetcher` resolves each
 * entry to an on-disk path and auto-clones missing checkouts.
 *
 * `path` is an explicit absolute override for the local checkout location.
 * It takes precedence over the conventional `PIPELINE_WORKSPACE/<project>/<repo>`
 * layout, but is itself overridden by a `config/repo-paths.json` entry — see
 * `adapters/repo/RepoFetcher.ts` for the full resolution order.
 */
export interface RepoSpec {
    readonly id: string;
    /** Explicit clone URL. Optional — `RepoFetcher` falls back to `https://github.com/<owner>/<name>`. */
    readonly url?: string;
    /** GitHub org / owner override. Defaults to the project's `gitHubOwner`. */
    readonly owner?: string;
    /** GitHub repository name override. Defaults to `id`. */
    readonly name?: string;
    /** Absolute filesystem path override. Mid-priority — see `RepoFetcher.resolvePath`. */
    readonly path?: string;
    /** Optional default branch — used by tooling that needs a known main branch name. */
    readonly defaultBranch?: string;
}

export interface Project {
    readonly id: string;
    readonly name: string;
    readonly credentials: ProjectCredentials;
    readonly linearTeamId?: string;
    readonly jiraProjectKey?: string;
    readonly gitHubOwner?: string;
    /**
     * Repositories declared for this project. Empty when the project does
     * not yet declare any (legacy single-repo projects, or scaffold-only
     * projects whose repo list will be populated by a follow-up task).
     */
    readonly repos: ReadonlyArray<RepoSpec>;
    /**
     * Per-flow, per-step approval overrides loaded from the project's
     * metadata. Defaults to `{}` when the key is
     * absent so engine callers can pass it straight into approval evaluation
     * without checking for `undefined`. See {@link ApprovalOverride} for the
     * nested shape.
     */
    readonly approvalOverride: ApprovalOverride;
    /**
     * Project-level seed values for the new-plan modal's conventions form.
     * Field names match the per-plan `conventions` block so the modal can
     * copy the object straight across without remapping. Undefined when the
     * `planDefaults` key is absent from the project's metadata.
     */
    readonly planDefaults?: PlanDefaults;
}

/**
 * Seed values for a plan's conventions block. All fields are optional — a
 * project may declare any subset (e.g. only `namespace_root`) and the
 * remaining fields stay undefined. Field names are snake_case to match the
 * JSON shape so the new-plan modal (task-013) can copy the object across to
 * a plan's `conventions` block without renaming keys.
 */
export interface PlanDefaults {
    readonly namespace_root?: string;
    readonly test_framework?: string;
    readonly branch_pattern?: string;
    readonly commit_pattern?: string;
}

/**
 * Per-flow, per-step approval policy overrides. A flow name maps to an object
 * of step IDs, each carrying one of three literal modes:
 *
 *  - `auto` — approve without operator interaction
 *  - `required` — always pause for operator approval
 *  - `default` — fall back to the flow's built-in policy
 *
 * Stored under `metadata.approvalOverride` on the project row. Optional: a
 * project with no overrides simply has no key, and readers treat that as
 * `{}`.
 */
export const APPROVAL_OVERRIDE_VALUES = ['auto', 'required', 'default'] as const;
export type ApprovalOverrideValue = (typeof APPROVAL_OVERRIDE_VALUES)[number];
export type ApprovalOverride = {
    readonly [flowName: string]: { readonly [stepId: string]: ApprovalOverrideValue };
};

/**
 * Thrown by `updateApprovalOverride` when the input shape violates the
 * schema. `fieldPath` points at the offending leaf so callers can build a
 * precise operator-facing error (e.g. `commit.lint`).
 */
export class InvalidApprovalOverrideError extends Error {
    override readonly name = 'InvalidApprovalOverrideError';
    readonly fieldPath: string;
    constructor(message: string, fieldPath: string) {
        super(`InvalidApprovalOverrideError: ${message} (at "${fieldPath}")`);
        this.fieldPath = fieldPath;
    }
}

interface ProjectRecord {
    readonly id: string;
    readonly name: string;
    readonly linearTeamId?: string;
    readonly jiraProjectKey?: string;
    readonly gitHubOwner?: string;
    readonly repos: ReadonlyArray<RepoSpec>;
    readonly credentialEnv: {
        readonly linearApiKey?: string;
        readonly jiraEmail?: string;
        readonly jiraApiToken?: string;
        readonly gitHubToken?: string;
    };
    readonly planDefaults?: PlanDefaults;
}

/**
 * One stale-override warning surfaced from
 * {@link ProjectRegistry.warnUnknownOverrideSteps}. The structured shape lets
 * non-log consumers (the enriched /health body, future board badges) display
 * the same gap auditably without parsing free-form log text.
 *
 * `reason` is the human-readable explanation — the same suffix the
 * `console.warn` already emits, minus the class-name prefix. Operator-facing,
 * stable enough to render directly.
 */
export interface ApprovalOverrideWarning {
    readonly projectId: string;
    readonly flowName: string;
    readonly stepId: string;
    readonly reason: string;
}

export class ProjectRegistry {
    /**
     * Stale-override warnings recorded by every call to
     * {@link warnUnknownOverrideSteps}. Keyed by `${projectId}|${flowName}|${stepId}`
     * so re-validating the same flow does not multiply the surface. Bounded
     * by the number of distinct stale step ids declared across project
     * files on disk — small.
     */
    private readonly approvalOverrideWarnings = new Map<string, ApprovalOverrideWarning>();

    private constructor(
        private readonly byId: ReadonlyMap<string, ProjectRecord>,
        private readonly db: Db,
    ) {}

    /**
     * Build the registry from the `projects` projection.
     *
     * Archived projects are excluded: an archived project must not drive a
     * flow, and `get()` throwing `UnknownProjectError` for one is exactly
     * how the engine already treats a project it does not know.
     *
     * Rows are read once per call — the orchestrator rebuilds on
     * `ProjectUpdated` rather than holding a stale snapshot for the life of
     * the process, which is what the file-loaded registry did.
     */
    static fromDb(db: Db): ProjectRegistry {
        const rows = db
            .prepare(
                `SELECT id, name, metadata FROM projects
                  WHERE archived_at IS NULL`,
            )
            .all() as Array<{ id: string; name: string | null; metadata: string | null }>;

        const byId = new Map<string, ProjectRecord>();
        for (const row of rows) {
            if (typeof row.id !== 'string' || row.id.length === 0) continue;
            byId.set(row.id, projectRecordFromRow(row));
        }
        return new ProjectRegistry(byId, db);
    }

    /**
     * Look up a project by id. Throws `UnknownProjectError` when no such
     * project is registered — callers that need a soft check should use
     * `has(id)` first.
     */
    get(projectId: string): Project {
        const record = this.byId.get(projectId);
        if (!record) {
            throw new UnknownProjectError(projectId);
        }
        return {
            id: record.id,
            name: record.name,
            linearTeamId: record.linearTeamId,
            jiraProjectKey: record.jiraProjectKey,
            gitHubOwner: record.gitHubOwner,
            repos: record.repos,
            credentials: resolveCredentials(record.credentialEnv),
            approvalOverride: this.getApprovalOverride(record.id),
            planDefaults: record.planDefaults,
        };
    }

    has(projectId: string): boolean {
        return this.byId.has(projectId);
    }

    list(): Project[] {
        const out: Project[] = [];
        for (const id of this.byId.keys()) {
            out.push(this.get(id));
        }
        return out;
    }

    ids(): string[] {
        return Array.from(this.byId.keys());
    }

    /**
     * Read the `approval_override` field straight off disk. Re-reads on every
     * call so a previous `updateApprovalOverride` is immediately visible
     * without forcing the caller to rebuild the registry.
     *
     * Missing field — common case for a freshly-scaffolded project — returns
     * `{}` instead of throwing. The override field is genuinely optional;
     * callers should not have to special-case its absence.
     */
    getApprovalOverride(projectId: string): ApprovalOverride {
        if (!this.byId.has(projectId)) throw new UnknownProjectError(projectId);
        // Read-through rather than from `byId`, so an override written
        // since this registry was built is immediately visible.
        const raw = readMetadataKey(this.db, projectId, 'approvalOverride');
        if (raw === undefined || raw === null) return {};
        if (typeof raw !== 'object' || Array.isArray(raw)) return {};
        return raw as ApprovalOverride;
    }

    /**
     * VALIDATION ONLY — the command handler calls this before emitting, so
     * an unknown project or a malformed override aborts the dispatch
     * rather than polluting the event log.
     *
     * It deliberately does not write. The row belongs to the projection
     * that folds `ProjectApprovalOverrideUpdated`; writing here would
     * leave state a replay could not reproduce. (This used to rewrite
     * `project.json` in place — that file is gone.)
     */
    updateApprovalOverride(projectId: string, override: ApprovalOverride): void {
        if (!this.byId.has(projectId)) throw new UnknownProjectError(projectId);
        validateApprovalOverride(override);
    }

    /**
     * Emit a `console.warn` for every override step id that is not declared
     * on `flow`. Silent no-op overrides bit v1 plenty of times — the engine
     * treats an unknown step id as a miss and the operator's "always
     * auto-approve" appears to do nothing without any visible reason. Warning
     * here makes the gap auditable from worker logs.
     *
     * Does not throw on unknown step ids — that is the whole point. Throws
     * `UnknownProjectError` only when the project itself is not registered.
     */
    warnUnknownOverrideSteps(projectId: string, flow: FlowDefinition): void {
        if (!this.byId.has(projectId)) throw new UnknownProjectError(projectId);
        const override = this.getApprovalOverride(projectId);
        const knownStepIds = new Set(flow.steps.map((s) => s.id));
        for (const [flowName, steps] of Object.entries(override)) {
            if (steps === null || typeof steps !== 'object') continue;
            for (const stepId of Object.keys(steps as Record<string, unknown>)) {
                if (!knownStepIds.has(stepId)) {
                    const reason =
                        `approval_override references step id "${stepId}" under flow "${flowName}" but the supplied flow has no such step — this override will silently no-op until the flow declares "${stepId}".`;
                    console.warn(
                        `ProjectRegistry.warnUnknownOverrideSteps: project "${projectId}" ${reason}`,
                    );
                    this.approvalOverrideWarnings.set(
                        `${projectId}|${flowName}|${stepId}`,
                        { projectId, flowName, stepId, reason },
                    );
                }
            }
        }
    }

    /**
     * Snapshot of every stale-override warning seen so far by
     * {@link warnUnknownOverrideSteps}. The same data the existing
     * `console.warn` carries, but in a structured shape the enriched
     * /health body (and future operator surfaces) can render directly.
     *
     * Returns a fresh array on every call so callers may mutate or sort
     * it without affecting the registry's internal state. Empty when no
     * stale entries have been recorded — the common case once project
     * files match their flow definitions.
     */
    getApprovalOverrideWarnings(): ApprovalOverrideWarning[] {
        return Array.from(this.approvalOverrideWarnings.values());
    }
}

export class UnknownProjectError extends Error {
    override readonly name = 'UnknownProjectError';
    readonly projectId: string;
    constructor(projectId: string) {
        super(`UnknownProjectError: no project registered with id "${projectId}"`);
        this.projectId = projectId;
    }
}

/**
 * Build a record from a `projects` row. Deliberately TOLERANT where
 * `parseProjectFile` is strict: a malformed file aborted boot because an
 * operator had hand-edited it and needed telling. A row is written by our
 * own command handlers, and refusing to boot over one bad blob would take
 * the whole worker down for a single project. Unusable fields fall back to
 * their empty value instead, and the project still resolves.
 */
function projectRecordFromRow(row: {
    id: string;
    name: string | null;
    metadata: string | null;
}): ProjectRecord {
    const meta = parseMetadataBlob(row.metadata);
    const credentialEnv = isPlainObj(meta.credentialEnv) ? meta.credentialEnv : {};
    return {
        id: row.id,
        name: typeof row.name === 'string' && row.name.length > 0 ? row.name : row.id,
        ...(typeof meta.linearTeamId === 'string'
            ? { linearTeamId: meta.linearTeamId }
            : {}),
        ...(typeof meta.jiraProjectKey === 'string'
            ? { jiraProjectKey: meta.jiraProjectKey }
            : {}),
        ...(typeof meta.gitHubOwner === 'string'
            ? { gitHubOwner: meta.gitHubOwner }
            : {}),
        repos: parseReposLoose(meta.repos),
        credentialEnv: {
            ...(typeof credentialEnv.linearApiKey === 'string'
                ? { linearApiKey: credentialEnv.linearApiKey }
                : {}),
            ...(typeof credentialEnv.jiraEmail === 'string'
                ? { jiraEmail: credentialEnv.jiraEmail }
                : {}),
            ...(typeof credentialEnv.jiraApiToken === 'string'
                ? { jiraApiToken: credentialEnv.jiraApiToken }
                : {}),
            ...(typeof credentialEnv.gitHubToken === 'string'
                ? { gitHubToken: credentialEnv.gitHubToken }
                : {}),
        },
        ...(isPlainObj(meta.planDefaults)
            ? { planDefaults: meta.planDefaults as PlanDefaults }
            : {}),
    };
}

function isPlainObj(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseMetadataBlob(raw: string | null): Record<string, unknown> {
    if (typeof raw !== 'string' || raw.length === 0) return {};
    try {
        const parsed = JSON.parse(raw) as unknown;
        return isPlainObj(parsed) ? parsed : {};
    } catch {
        return {};
    }
}

/**
 * Repo entries as stored by the board's project modal. Only `id` is
 * required; an entry without one is dropped rather than failing the whole
 * project, because it can only mean a half-filled row in the UI.
 */
function parseReposLoose(v: unknown): ReadonlyArray<RepoSpec> {
    if (!Array.isArray(v)) return [];
    const out: RepoSpec[] = [];
    for (const entry of v) {
        if (!isPlainObj(entry)) continue;
        const id = entry.id;
        if (typeof id !== 'string' || id.length === 0) continue;
        out.push({
            id,
            ...(typeof entry.url === 'string' ? { url: entry.url } : {}),
            ...(typeof entry.owner === 'string' ? { owner: entry.owner } : {}),
            ...(typeof entry.name === 'string' ? { name: entry.name } : {}),
            ...(typeof entry.path === 'string' ? { path: entry.path } : {}),
            ...(typeof entry.defaultBranch === 'string'
                ? { defaultBranch: entry.defaultBranch }
                : {}),
        });
    }
    return out;
}

/** Live read of one key from a project row's metadata blob. */
function readMetadataKey(db: Db, projectId: string, key: string): unknown {
    const row = db
        .prepare('SELECT metadata FROM projects WHERE id = ?')
        .get(projectId) as { metadata: string | null } | undefined;
    if (!row) return undefined;
    return parseMetadataBlob(row.metadata)[key];
}

function resolveCredentials(envMap: ProjectRecord['credentialEnv']): ProjectCredentials {
    return {
        linearApiKey: readEnv(envMap.linearApiKey),
        jiraEmail: readEnv(envMap.jiraEmail),
        jiraApiToken: readEnv(envMap.jiraApiToken),
        gitHubToken: readEnv(envMap.gitHubToken),
    };
}

function readEnv(name: string | undefined): string | undefined {
    if (!name) return undefined;
    const raw = process.env[name];
    if (raw === undefined) return undefined;
    const trimmed = raw.trim();
    return trimmed === '' ? undefined : trimmed;
}

function validateApprovalOverride(override: unknown): asserts override is ApprovalOverride {
    if (override === null || typeof override !== 'object' || Array.isArray(override)) {
        throw new InvalidApprovalOverrideError(
            'approval_override must be a plain object keyed by flow name',
            '',
        );
    }
    const allowed = new Set<string>(APPROVAL_OVERRIDE_VALUES);
    for (const [flowName, steps] of Object.entries(override as Record<string, unknown>)) {
        if (steps === null || typeof steps !== 'object' || Array.isArray(steps)) {
            throw new InvalidApprovalOverrideError(
                `flow override must be a plain object keyed by step id`,
                flowName,
            );
        }
        for (const [stepId, value] of Object.entries(steps as Record<string, unknown>)) {
            if (typeof value !== 'string' || !allowed.has(value)) {
                throw new InvalidApprovalOverrideError(
                    `value must be one of ${APPROVAL_OVERRIDE_VALUES.join(' | ')}; got ${JSON.stringify(value)}`,
                    `${flowName}.${stepId}`,
                );
            }
        }
    }
}
