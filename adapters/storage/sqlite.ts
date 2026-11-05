/**
 * Project-scoped SQLite storage adapter.
 *
 * Schema lives under `adapters/storage/migrations/`. 0001 bootstraps the
 * three tables this adapter owns — event_log, subscriber_offsets, claims —
 * and 0002 namespaces every row with a `project_id` column. Existing rows
 * (only meaningful when an operator is upgrading a v1-era DB in place) are
 * backfilled with the single `DEFAULT_PROJECT_ID` known at migration time.
 *
 * The runtime API is the {@link ProjectScopedStore} class. Every public
 * method takes a `projectId` and rejects blank/missing values — that
 * enforcement, combined with the schema-level NOT NULL constraint, is the
 * mechanism that prevents row cross-contamination across projects.
 */
import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';

import type { Event, StoredEvent } from '../../core/events/event';

export type Db = Database.Database;

const DEFAULT_MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const PLACEHOLDER = '{{DEFAULT_PROJECT_ID}}';

export interface OpenSqliteStoreOptions {
    /** Override the migrations directory. Defaults to `adapters/storage/migrations/`. */
    readonly migrationsDir?: string;
    /**
     * Backfill value for the project_id columns introduced in migration
     * 0002. When unset, the runner falls back to `process.env.DEFAULT_PROJECT_ID`.
     * If neither is provided AND migration 0002 still needs to run, the
     * adapter throws — silently picking an empty string would corrupt the
     * NOT NULL invariant.
     */
    readonly defaultProjectId?: string;
}

/**
 * Open (or create) a project-scoped storage DB and apply all pending
 * migrations under {@link OpenSqliteStoreOptions.migrationsDir}. WAL +
 * foreign_keys are enabled to match the conventions used by the v1
 * core/state DB.
 */
export function openSqliteStore(
    dbPath: string,
    options: OpenSqliteStoreOptions = {},
): Db {
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    applyStorageMigrations(db, options);
    return db;
}

/**
 * Apply every pending migration file in lexicographic order. Each migration
 * runs inside its own transaction together with the ledger insert, so a
 * mid-migration crash leaves the DB in its pre-migration state. Idempotent.
 *
 * The `{{DEFAULT_PROJECT_ID}}` placeholder is substituted with the resolved
 * default project id before execution. The value is single-quote-escaped for
 * safe SQL literal use.
 */
export function applyStorageMigrations(
    db: Db,
    options: OpenSqliteStoreOptions = {},
): string[] {
    const migrationsDir = options.migrationsDir ?? DEFAULT_MIGRATIONS_DIR;
    const defaultProjectId = resolveDefaultProjectId(options.defaultProjectId);

    db.exec(
        `CREATE TABLE IF NOT EXISTS __storage_migrations (
            version    TEXT    NOT NULL PRIMARY KEY,
            applied_at INTEGER NOT NULL
        )`,
    );

    const files = fs
        .readdirSync(migrationsDir)
        .filter((f) => f.endsWith('.sql'))
        .sort();

    const isApplied = db.prepare(
        'SELECT 1 FROM __storage_migrations WHERE version = ?',
    );
    const recordApplied = db.prepare(
        'INSERT INTO __storage_migrations(version, applied_at) VALUES (?, ?)',
    );

    const applied: string[] = [];
    for (const file of files) {
        if (isApplied.get(file)) continue;

        let sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
        if (sql.includes(PLACEHOLDER)) {
            if (defaultProjectId === undefined) {
                throw new Error(
                    `applyStorageMigrations: ${file} references ${PLACEHOLDER} but no defaultProjectId was supplied and DEFAULT_PROJECT_ID is not set in the environment`,
                );
            }
            sql = sql.split(PLACEHOLDER).join(escapeSqlLiteral(defaultProjectId));
        }

        const run = db.transaction(() => {
            db.exec(sql);
            recordApplied.run(file, Date.now());
        });
        run();
        applied.push(file);
    }

    return applied;
}

function resolveDefaultProjectId(explicit: string | undefined): string | undefined {
    if (explicit !== undefined) {
        const trimmed = explicit.trim();
        if (trimmed === '') {
            throw new Error(
                'applyStorageMigrations: defaultProjectId option must not be empty',
            );
        }
        return trimmed;
    }
    const raw = process.env.DEFAULT_PROJECT_ID;
    if (raw === undefined) return undefined;
    const trimmed = raw.trim();
    return trimmed === '' ? undefined : trimmed;
}

function escapeSqlLiteral(s: string): string {
    return s.replace(/'/g, "''");
}

// ---------------------------------------------------------------------------
// ProjectScopedStore
// ---------------------------------------------------------------------------

interface EventRow {
    seq: number;
    type: string;
    v: number;
    occurred_at: number;
    idempotency_key: string;
    payload: string;
}

function rowToEvent(row: EventRow): StoredEvent {
    return {
        seq: row.seq,
        type: row.type,
        v: row.v,
        occurredAt: row.occurred_at,
        idempotencyKey: row.idempotency_key,
        payload: JSON.parse(row.payload),
    };
}

export class MissingProjectIdError extends Error {
    override readonly name = 'MissingProjectIdError';
    constructor(operation: string) {
        super(`MissingProjectIdError: ${operation} requires a non-empty projectId`);
    }
}

/**
 * Project-aware read/write surface over the storage adapter's tables.
 *
 * Every method takes `projectId` as its first argument. Blank or non-string
 * project ids throw {@link MissingProjectIdError} synchronously — the
 * NOT NULL schema constraint is the second line of defence, but failing in
 * application code gives a much better error than a SQLite constraint
 * violation 12 frames deep.
 */
export class ProjectScopedStore {
    constructor(private readonly db: Db) {}

    /**
     * Append an event scoped to `projectId`. Returns the assigned seq.
     *
     * Idempotency: a duplicate `idempotencyKey` returns the original seq
     * without inserting a new row. The lookup that resolves a de-dup runs
     * inside the same transaction as the insert so concurrent producers
     * can't race past the unique constraint.
     */
    appendEvent(projectId: string, event: Event): number {
        requireProjectId(projectId, 'appendEvent');

        const tx = this.db.transaction((): number => {
            const info = this.db
                .prepare(
                    `INSERT OR IGNORE INTO event_log
                        (project_id, type, v, occurred_at, idempotency_key, payload)
                     VALUES (?, ?, ?, ?, ?, ?)`,
                )
                .run(
                    projectId,
                    event.type,
                    event.v,
                    event.occurredAt,
                    event.idempotencyKey,
                    JSON.stringify(event.payload),
                );

            if (info.changes > 0) {
                return Number(info.lastInsertRowid);
            }

            const existing = this.db
                .prepare(
                    'SELECT seq, project_id FROM event_log WHERE idempotency_key = ?',
                )
                .get(event.idempotencyKey) as
                | { seq: number; project_id: string }
                | undefined;

            if (!existing) {
                throw new Error(
                    `appendEvent: idempotency_key="${event.idempotencyKey}" was ignored on insert but not found on lookup`,
                );
            }
            // Cross-project idempotency-key collision is a programmer error
            // rather than a silent merge — fail loudly so the producer
            // sees they've reused an id across projects.
            if (existing.project_id !== projectId) {
                throw new Error(
                    `appendEvent: idempotencyKey="${event.idempotencyKey}" is already used by project "${existing.project_id}", cannot reuse in project "${projectId}"`,
                );
            }
            return existing.seq;
        });

        return tx();
    }

    /**
     * Return events for `projectId` with seq strictly greater than `seq`,
     * ASC ordered, up to `limit` rows. Events for other projects are not
     * visible — that's the whole point of the project_id column.
     */
    readAfter(projectId: string, seq: number, limit: number): StoredEvent[] {
        requireProjectId(projectId, 'readAfter');

        const rows = this.db
            .prepare(
                `SELECT seq, type, v, occurred_at, idempotency_key, payload
                 FROM event_log
                 WHERE project_id = ? AND seq > ?
                 ORDER BY seq ASC
                 LIMIT ?`,
            )
            .all(projectId, seq, limit) as EventRow[];
        return rows.map(rowToEvent);
    }

    /** Last seq this `(projectId, subscriber)` pair has acknowledged, or 0. */
    getSubscriberOffset(projectId: string, subscriber: string): number {
        requireProjectId(projectId, 'getSubscriberOffset');
        requireString(subscriber, 'getSubscriberOffset', 'subscriber');

        const row = this.db
            .prepare(
                `SELECT last_seq FROM subscriber_offsets
                 WHERE project_id = ? AND subscriber = ?`,
            )
            .get(projectId, subscriber) as { last_seq: number } | undefined;
        return row?.last_seq ?? 0;
    }

    /**
     * Monotonically advance the per-project subscriber offset. Calls with a
     * `seq` not strictly greater than the current value are no-ops and
     * return false. Returns true on the initial insert and on every forward
     * move thereafter.
     */
    advanceSubscriberOffset(
        projectId: string,
        subscriber: string,
        seq: number,
    ): boolean {
        requireProjectId(projectId, 'advanceSubscriberOffset');
        requireString(subscriber, 'advanceSubscriberOffset', 'subscriber');

        const result = this.db
            .prepare(
                `INSERT INTO subscriber_offsets(project_id, subscriber, last_seq)
                 VALUES (?, ?, ?)
                 ON CONFLICT(project_id, subscriber) DO UPDATE
                     SET last_seq = excluded.last_seq
                     WHERE excluded.last_seq > subscriber_offsets.last_seq`,
            )
            .run(projectId, subscriber, seq);
        return result.changes > 0;
    }

    /**
     * Acquire a claim on `subject` for `owner` inside `projectId`. Returns
     * true when the claim was newly created, false when an existing claim
     * already exists. Use {@link readClaim} to inspect the owner of an
     * existing claim and decide what to do about it.
     */
    putClaim(
        projectId: string,
        subject: string,
        owner: string,
        createdAt: number,
    ): boolean {
        requireProjectId(projectId, 'putClaim');
        requireString(subject, 'putClaim', 'subject');
        requireString(owner, 'putClaim', 'owner');

        const result = this.db
            .prepare(
                `INSERT OR IGNORE INTO claims(project_id, subject, owner, created_at)
                 VALUES (?, ?, ?, ?)`,
            )
            .run(projectId, subject, owner, createdAt);
        return result.changes > 0;
    }

    /** Return the claim owner for `(projectId, subject)`, or undefined. */
    readClaim(projectId: string, subject: string): string | undefined {
        requireProjectId(projectId, 'readClaim');
        requireString(subject, 'readClaim', 'subject');

        const row = this.db
            .prepare(
                `SELECT owner FROM claims
                 WHERE project_id = ? AND subject = ?`,
            )
            .get(projectId, subject) as { owner: string } | undefined;
        return row?.owner;
    }

    /** Remove the claim for `(projectId, subject)`. Returns true if a row was deleted. */
    removeClaim(projectId: string, subject: string): boolean {
        requireProjectId(projectId, 'removeClaim');
        requireString(subject, 'removeClaim', 'subject');

        const result = this.db
            .prepare(
                `DELETE FROM claims WHERE project_id = ? AND subject = ?`,
            )
            .run(projectId, subject);
        return result.changes > 0;
    }
}

function requireProjectId(projectId: unknown, operation: string): asserts projectId is string {
    if (typeof projectId !== 'string' || projectId.trim() === '') {
        throw new MissingProjectIdError(operation);
    }
}

function requireString(v: unknown, operation: string, field: string): asserts v is string {
    if (typeof v !== 'string' || v.trim() === '') {
        throw new Error(`${operation}: ${field} must be a non-empty string`);
    }
}
