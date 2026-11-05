/**
 * SQLite-backed projection over the Repo lifecycle events
 * (`RepoRegistered`, `RepoUpdated`, `RepoArchived`, `RepoEnsured`,
 * `RepoEnsureFailed`, `RepoSynced`, `RepoSyncFailed`).
 *
 * Backing table: `repos` (defined in
 * `core/state/migrations/011_repos_table.sql`). One row per repoId,
 * soft-deleted via `archived_at`. The Repos modal reads through this
 * projection; the planner's pre-spawn refresh resolves the primary
 * repo's url + branch + ensured_path out of the same row.
 *
 * Idempotency:
 *   - Registered → UPSERT keyed on `repo_id`. The conflict branch
 *     refreshes name/url/branch only when the incoming event is
 *     strictly newer than the stored `updated_at`.
 *   - Updated / Archived / Ensured / Synced — all gated on
 *     `@occurredAt > COALESCE(updated_at, 0)` so a replayed event
 *     never moves state backwards.
 *
 * Idempotency at the bus layer is provided by the per-subscriber
 * offset tracking; combined with the WHERE-clause guard above,
 * `replayMissed(REPO_PROJECTION_SUBSCRIBER)` after a restart yields a
 * snapshot bit-for-bit equal to a fresh fold.
 */

import type { EventBus } from '../../core/events/bus';
import type {
    Event,
    RepoArchivedPayload,
    RepoEnsureFailedPayload,
    RepoEnsuredPayload,
    RepoLifecyclePayload,
    RepoSyncFailedPayload,
    RepoSyncedPayload,
    StoredEvent,
} from '../../core/events/event';
import {
    isRepoArchived,
    isRepoEnsureFailed,
    isRepoEnsured,
    isRepoRegistered,
    isRepoSyncFailed,
    isRepoSynced,
    isRepoUpdated,
} from '../../core/events/event';
import type { Logger } from '../../core/ports/Logger';
import type { Db } from '../../core/state/migrations';

export const REPO_PROJECTION_SUBSCRIBER = 'repo-projection-store';

export const REPO_PROJECTION_EVENT_TYPES = {
    REGISTERED: 'RepoRegistered',
    UPDATED: 'RepoUpdated',
    ARCHIVED: 'RepoArchived',
    ENSURED: 'RepoEnsured',
    ENSURE_FAILED: 'RepoEnsureFailed',
    SYNCED: 'RepoSynced',
    SYNC_FAILED: 'RepoSyncFailed',
} as const;

/**
 * Read-side row shape. `lastSyncStatus` is one of:
 *   - 'ok'             — last clone/sync succeeded
 *   - 'clone-failed'   — initial clone failed
 *   - 'sync-failed'    — fetch+reset on a previously-cloned repo failed
 *   - null             — never synced
 */
export interface RepoRecord {
    readonly repoId: string;
    readonly name: string;
    readonly url: string;
    readonly defaultBranch: string;
    readonly ensuredPath: string | null;
    readonly lastSyncedAt: number | null;
    readonly lastSyncStatus: 'ok' | 'clone-failed' | 'sync-failed' | null;
    readonly lastSyncError: string | null;
    readonly archivedAt: number | null;
    readonly updatedAt: number;
    /**
     * Declared GitHub account this repo is reached with (migration
     * 037), or null for the machine's ambient `gh` identity.
     */
    readonly githubAccount: string | null;
}

interface RepoRow {
    repo_id: string;
    name: string;
    url: string;
    default_branch: string;
    ensured_path: string | null;
    last_synced_at: number | null;
    last_sync_status: string | null;
    last_sync_error: string | null;
    archived_at: number | null;
    updated_at: number;
    github_account: string | null;
}

function rowToRecord(row: RepoRow): RepoRecord {
    const status = row.last_sync_status;
    return {
        repoId: row.repo_id,
        name: row.name,
        url: row.url,
        defaultBranch: row.default_branch,
        ensuredPath: row.ensured_path,
        lastSyncedAt: row.last_synced_at,
        lastSyncStatus:
            status === 'ok' || status === 'clone-failed' || status === 'sync-failed'
                ? status
                : null,
        lastSyncError: row.last_sync_error,
        archivedAt: row.archived_at,
        updatedAt: row.updated_at,
        githubAccount: row.github_account,
    };
}

export class RepoProjectionStore {
    private readonly registerStmt;
    private readonly updateStmt;
    private readonly archiveStmt;
    private readonly ensuredStmt;
    private readonly ensureFailedStmt;
    private readonly syncedStmt;
    private readonly syncFailedStmt;
    private readonly getByIdStmt;
    private readonly listActiveStmt;
    private readonly logger?: Logger;

    constructor(private readonly db: Db, bus?: EventBus, logger?: Logger) {
        this.logger = logger;

        // Registered: insert a fresh row keyed on repo_id. If the same
        // id is already present (replay, duplicate Register), refresh
        // name/url/branch only when the incoming event is strictly
        // newer than the stored updated_at. Cleared sync status stays
        // intact — a re-register doesn't invalidate a successful clone.
        this.registerStmt = db.prepare(
            `INSERT INTO repos(
                repo_id, name, url, default_branch, ensured_path,
                last_synced_at, last_sync_status, last_sync_error,
                archived_at, updated_at, github_account
             )
             VALUES (
                @repoId, @name, @url, @defaultBranch, NULL,
                NULL, NULL, NULL,
                NULL, @occurredAt, @githubAccount
             )
             ON CONFLICT(repo_id) DO UPDATE SET
                 name           = excluded.name,
                 url            = excluded.url,
                 default_branch = excluded.default_branch,
                 -- A re-register un-archives so the operator can
                 -- "undo" an accidental archive without losing the
                 -- ensured_path / sync history.
                 archived_at    = NULL,
                 updated_at     = excluded.updated_at,
                 -- COALESCE on the INCOMING side: a re-register that
                 -- names no account keeps the mapping the operator
                 -- already set, so refreshing a repo does not quietly
                 -- return it to the ambient identity.
                 github_account = COALESCE(excluded.github_account, repos.github_account)
             WHERE excluded.updated_at > repos.updated_at`,
        );

        // Updated: COALESCE preserves stored fields when the payload
        // omits them. Monotonicity gate makes replays a no-op.
        this.updateStmt = db.prepare(
            `UPDATE repos
                SET name           = COALESCE(NULLIF(@name, ''), name),
                    url            = COALESCE(NULLIF(@url, ''), url),
                    default_branch = COALESCE(@defaultBranch, default_branch),
                    -- The empty string is how an Update CLEARS the
                    -- mapping (back to the ambient identity), while an
                    -- omitted field leaves it alone. Without that
                    -- distinction there is no way to un-map a repo.
                    github_account = CASE
                        WHEN @githubAccount IS NULL THEN github_account
                        WHEN @githubAccount = '' THEN NULL
                        ELSE @githubAccount
                    END,
                    updated_at     = @occurredAt
              WHERE repo_id = @repoId
                AND @occurredAt > COALESCE(updated_at, 0)`,
        );

        this.archiveStmt = db.prepare(
            `UPDATE repos
                SET archived_at = @occurredAt,
                    updated_at  = @occurredAt
              WHERE repo_id = @repoId
                AND @occurredAt > COALESCE(updated_at, 0)`,
        );

        this.ensuredStmt = db.prepare(
            `UPDATE repos
                SET ensured_path     = @ensuredPath,
                    last_synced_at   = @at,
                    last_sync_status = 'ok',
                    last_sync_error  = NULL,
                    updated_at       = @at
              WHERE repo_id = @repoId
                AND @at > COALESCE(updated_at, 0)`,
        );

        this.ensureFailedStmt = db.prepare(
            `UPDATE repos
                SET last_synced_at   = @at,
                    last_sync_status = 'clone-failed',
                    last_sync_error  = @error,
                    updated_at       = @at
              WHERE repo_id = @repoId
                AND @at > COALESCE(updated_at, 0)`,
        );

        this.syncedStmt = db.prepare(
            `UPDATE repos
                SET last_synced_at   = @at,
                    last_sync_status = 'ok',
                    last_sync_error  = NULL,
                    updated_at       = @at
              WHERE repo_id = @repoId
                AND @at > COALESCE(updated_at, 0)`,
        );

        this.syncFailedStmt = db.prepare(
            `UPDATE repos
                SET last_synced_at   = @at,
                    last_sync_status = 'sync-failed',
                    last_sync_error  = @error,
                    updated_at       = @at
              WHERE repo_id = @repoId
                AND @at > COALESCE(updated_at, 0)`,
        );

        this.getByIdStmt = db.prepare(
            `SELECT repo_id, name, url, default_branch, ensured_path,
                    last_synced_at, last_sync_status, last_sync_error,
                    archived_at, updated_at, github_account
               FROM repos
              WHERE repo_id = ?`,
        );

        this.listActiveStmt = db.prepare(
            `SELECT repo_id, name, url, default_branch, ensured_path,
                    last_synced_at, last_sync_status, last_sync_error,
                    archived_at, updated_at, github_account
               FROM repos
              WHERE archived_at IS NULL
              ORDER BY name COLLATE NOCASE ASC`,
        );

        if (bus) {
            const sub = { subscriber: REPO_PROJECTION_SUBSCRIBER };
            bus.subscribe<RepoLifecyclePayload>(
                REPO_PROJECTION_EVENT_TYPES.REGISTERED,
                (event) => this.onRegistered(event),
                sub,
            );
            bus.subscribe<RepoLifecyclePayload>(
                REPO_PROJECTION_EVENT_TYPES.UPDATED,
                (event) => this.onUpdated(event),
                sub,
            );
            bus.subscribe<RepoArchivedPayload>(
                REPO_PROJECTION_EVENT_TYPES.ARCHIVED,
                (event) => this.onArchived(event),
                sub,
            );
            bus.subscribe<RepoEnsuredPayload>(
                REPO_PROJECTION_EVENT_TYPES.ENSURED,
                (event) => this.onEnsured(event),
                sub,
            );
            bus.subscribe<RepoEnsureFailedPayload>(
                REPO_PROJECTION_EVENT_TYPES.ENSURE_FAILED,
                (event) => this.onEnsureFailed(event),
                sub,
            );
            bus.subscribe<RepoSyncedPayload>(
                REPO_PROJECTION_EVENT_TYPES.SYNCED,
                (event) => this.onSynced(event),
                sub,
            );
            bus.subscribe<RepoSyncFailedPayload>(
                REPO_PROJECTION_EVENT_TYPES.SYNC_FAILED,
                (event) => this.onSyncFailed(event),
                sub,
            );
        }
    }

    /** Test seam — drive the projection without an EventBus. */
    fold(event: Event | StoredEvent): void {
        if (isRepoRegistered(event)) return this.onRegistered(event);
        if (isRepoUpdated(event)) return this.onUpdated(event);
        if (isRepoArchived(event)) return this.onArchived(event);
        if (isRepoEnsured(event)) return this.onEnsured(event);
        if (isRepoEnsureFailed(event)) return this.onEnsureFailed(event);
        if (isRepoSynced(event)) return this.onSynced(event);
        if (isRepoSyncFailed(event)) return this.onSyncFailed(event);
    }

    /** Exact-match lookup. Returns null for unknown or archived ids
     *  iff `includeArchived` is omitted. */
    get(repoId: string, options: { includeArchived?: boolean } = {}): RepoRecord | null {
        const row = this.getByIdStmt.get(repoId) as RepoRow | undefined;
        if (!row) return null;
        if (!options.includeArchived && row.archived_at !== null) return null;
        return rowToRecord(row);
    }

    /** Active rows (archived_at IS NULL), name-sorted. */
    listActive(): RepoRecord[] {
        const rows = this.listActiveStmt.all() as RepoRow[];
        return rows.map(rowToRecord);
    }

    private onRegistered(event: { payload: RepoLifecyclePayload; occurredAt: number }): void {
        const p = event.payload;
        if (!p || typeof p.repoId !== 'string' || p.repoId.length === 0) return;
        const info = this.registerStmt.run({
            repoId: p.repoId,
            name: p.name,
            url: p.url,
            defaultBranch: p.defaultBranch ?? 'main',
            occurredAt: event.occurredAt,
            // null, not undefined: better-sqlite3 rejects an
            // undefined bound value outright. Null is also the
            // meaning we want - the ambient gh identity.
            githubAccount: p.githubAccount ?? null,
        });
        this.logger?.info('repo-projection: RepoRegistered applied', {
            repoId: p.repoId,
            changes: info.changes,
        });
    }

    private onUpdated(event: { payload: RepoLifecyclePayload; occurredAt: number }): void {
        const p = event.payload;
        if (!p || typeof p.repoId !== 'string' || p.repoId.length === 0) return;
        this.updateStmt.run({
            repoId: p.repoId,
            name: p.name ?? '',
            url: p.url ?? '',
            defaultBranch: p.defaultBranch ?? null,
            occurredAt: event.occurredAt,
            // Undefined (field omitted) leaves the mapping alone;
            // '' is how the operator clears it. The statement's CASE
            // keeps those two apart, so null here must mean "omitted".
            githubAccount: p.githubAccount ?? null,
        });
    }

    private onArchived(event: { payload: RepoArchivedPayload; occurredAt: number }): void {
        const p = event.payload;
        if (!p || typeof p.repoId !== 'string' || p.repoId.length === 0) return;
        this.archiveStmt.run({ repoId: p.repoId, occurredAt: event.occurredAt });
    }

    private onEnsured(event: { payload: RepoEnsuredPayload; occurredAt: number }): void {
        const p = event.payload;
        if (!p || typeof p.repoId !== 'string' || p.repoId.length === 0) return;
        this.ensuredStmt.run({
            repoId: p.repoId,
            ensuredPath: p.ensuredPath,
            at: typeof p.at === 'number' ? p.at : event.occurredAt,
        });
    }

    private onEnsureFailed(event: {
        payload: RepoEnsureFailedPayload;
        occurredAt: number;
    }): void {
        const p = event.payload;
        if (!p || typeof p.repoId !== 'string' || p.repoId.length === 0) return;
        this.ensureFailedStmt.run({
            repoId: p.repoId,
            error: p.error ?? '',
            at: typeof p.at === 'number' ? p.at : event.occurredAt,
        });
    }

    private onSynced(event: { payload: RepoSyncedPayload; occurredAt: number }): void {
        const p = event.payload;
        if (!p || typeof p.repoId !== 'string' || p.repoId.length === 0) return;
        this.syncedStmt.run({
            repoId: p.repoId,
            at: typeof p.at === 'number' ? p.at : event.occurredAt,
        });
    }

    private onSyncFailed(event: { payload: RepoSyncFailedPayload; occurredAt: number }): void {
        const p = event.payload;
        if (!p || typeof p.repoId !== 'string' || p.repoId.length === 0) return;
        this.syncFailedStmt.run({
            repoId: p.repoId,
            error: p.error ?? '',
            at: typeof p.at === 'number' ? p.at : event.occurredAt,
        });
    }
}
