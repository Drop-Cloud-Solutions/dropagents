/**
 * SQLite projection for attachment metadata (migration 021).
 *
 * Folds `AttachmentAdded` / `AttachmentRemoved` events into the
 * `attachments` table. Read by three surfaces:
 *   1. the worker-api attachments router (list / download / delete),
 *   2. the board (boot hydration of a modal's attachment list), and
 *   3. the orchestrator's TASK.md builder + decomposer prompt, which copy
 *      a task's / plan's attachments into the agent's context.
 *
 * The raw bytes live behind {@link
 * '../../core/ports/AttachmentBlobStore'.AttachmentBlobStore}; this store
 * only ever touches metadata.
 */

import type Database from 'better-sqlite3';

/**
 * What an attachment hangs off.
 *
 * 'requirement' is the architect tier: files the operator pins to a
 * requirement as input for the DESIGN, read by the architect and the
 * design-verifier. They are not inherited by the plans the fan-out
 * creates - a requirement attachment is design input, and the
 * implementing agents get the design, not its sources.
 */
export type AttachmentOwnerType = 'task' | 'plan' | 'requirement';

/**
 * Which DIRECTION an attachment points (migration 038).
 *
 * 'input' is a file the operator pinned on for the agents to read.
 * 'output' is a file a task PRODUCED — a findings CSV, a generated
 * document — harvested from the task's output folder so the operator can
 * download it from the finished task.
 *
 * The distinction is not cosmetic: `materializeTaskAttachments` copies a
 * task's attachments into the next step's worktree, and the committer
 * stages what it finds there. An output that came back as an input would
 * be committed into the repo.
 */
export type AttachmentKind = 'input' | 'output';

export interface Attachment {
    readonly id: string;
    readonly ownerType: AttachmentOwnerType;
    readonly ownerId: string;
    readonly fileName: string;
    readonly contentType: string;
    readonly sizeBytes: number;
    /** Opaque blob-store key (the on-disk relative path today). */
    readonly storageKey: string;
    readonly caption: string | null;
    readonly createdAt: number;
    /**
     * Migration 038. Optional on the way IN so every existing caller
     * (and every test that predates outputs) still compiles; `add`
     * defaults it to 'input', which is what those callers all meant.
     */
    readonly kind?: AttachmentKind;
}

interface AttachmentRow {
    id: string;
    owner_type: string;
    owner_id: string;
    file_name: string;
    content_type: string;
    size_bytes: number;
    storage_path: string;
    caption: string | null;
    created_at: number;
    /**
     * Migration 038. Typed nullable although the column is NOT NULL with
     * a DEFAULT - the reader stays correct if the constraint is ever
     * relaxed, and a hand-written row cannot break it.
     */
    kind: string | null;
}

export class SqliteAttachmentStore {
    private readonly insertStmt: Database.Statement<unknown[]>;
    private readonly deleteStmt: Database.Statement<unknown[]>;
    private readonly getStmt: Database.Statement<unknown[]>;
    private readonly listForStmt: Database.Statement<unknown[]>;
    private readonly listKindStmt: Database.Statement<unknown[]>;

    constructor(private readonly db: Database.Database) {
        this.insertStmt = db.prepare(
            `INSERT OR REPLACE INTO attachments
                (id, owner_type, owner_id, file_name, content_type,
                 size_bytes, storage_path, caption, created_at, kind)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        this.deleteStmt = db.prepare(`DELETE FROM attachments WHERE id = ?`);
        this.getStmt = db.prepare(`SELECT * FROM attachments WHERE id = ?`);
        this.listForStmt = db.prepare(
            `SELECT * FROM attachments
              WHERE owner_type = ? AND owner_id = ?
              ORDER BY created_at ASC, id ASC`,
        );
        // Kind-filtered variant. Migration 038 backfills every existing
        // row to 'input', so there are no NULLs to find today; COALESCE
        // is here rather than in the caller so that if one ever appears,
        // it reads as the operator upload it must be instead of
        // disappearing from the list.
        this.listKindStmt = db.prepare(
            `SELECT * FROM attachments
              WHERE owner_type = ? AND owner_id = ?
                AND COALESCE(kind, 'input') = ?
              ORDER BY created_at ASC, id ASC`,
        );
    }

    /** Insert (or overwrite) an attachment row. Idempotent on id. */
    add(attachment: Attachment): void {
        this.insertStmt.run(
            attachment.id,
            attachment.ownerType,
            attachment.ownerId,
            attachment.fileName,
            attachment.contentType,
            attachment.sizeBytes,
            attachment.storageKey,
            attachment.caption,
            attachment.createdAt,
            attachment.kind ?? 'input',
        );
    }

    /** Remove an attachment row by id. No-op when the id is unknown. */
    remove(id: string): void {
        this.deleteStmt.run(id);
    }

    /** Single attachment by id, or null when absent. */
    get(id: string): Attachment | null {
        const row = this.getStmt.get(id) as AttachmentRow | undefined;
        return row ? rowToAttachment(row) : null;
    }

    /**
     * Every attachment for an owner, oldest first.
     *
     * `kind` narrows to inputs or outputs (migration 038). Omitting it
     * returns BOTH, which is almost never what a caller wants now that
     * outputs exist — pass it explicitly.
     */
    listFor(
        ownerType: AttachmentOwnerType,
        ownerId: string,
        kind?: AttachmentKind,
    ): Attachment[] {
        const rows = (kind === undefined
            ? this.listForStmt.all(ownerType, ownerId)
            : this.listKindStmt.all(ownerType, ownerId, kind)) as AttachmentRow[];
        return rows.map(rowToAttachment);
    }
}

/**
 * Narrow the stored kind, defaulting to 'input'.
 *
 * Anything unrecognised - including a NULL the NOT NULL constraint should
 * make impossible - reads as an input, which is the safe direction for a
 * MISSING value: every row that predates migration 038 was an operator
 * upload. (The unsafe direction is the other one: an output mislabelled
 * as an input gets copied into a worktree and committed.)
 */
function toKind(raw: string | null): AttachmentKind {
    return raw === 'output' ? 'output' : 'input';
}

/** Narrow the stored text, defaulting to the oldest owner type. */
function toOwnerType(raw: string): AttachmentOwnerType {
    if (raw === 'plan' || raw === 'requirement') return raw;
    return 'task';
}

function rowToAttachment(row: AttachmentRow): Attachment {
    return {
        id: row.id,
        // Narrowed through a function rather than a nested ternary: the
        // old `=== 'plan' ? 'plan' : 'task'` silently relabelled every
        // owner type it had not been told about, so a requirement row
        // would have come back claiming to be a task.
        ownerType: toOwnerType(row.owner_type),
        ownerId: row.owner_id,
        fileName: row.file_name,
        contentType: row.content_type,
        sizeBytes: row.size_bytes,
        storageKey: row.storage_path,
        caption: row.caption,
        createdAt: row.created_at,
        kind: toKind(row.kind),
    };
}
