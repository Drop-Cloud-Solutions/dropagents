import type { Db } from '../state/migrations';
import type { Event, StoredEvent } from './event';

/**
 * Internal row shape, mirroring the snake_case columns of the events table.
 */
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

/**
 * SQLite-backed append-only event log with per-subscriber replay offsets.
 *
 * Backed by the `events` and `subscriber_offsets` tables defined in
 * core/state/migrations/001_initial.sql. `seq` is canonical ordering;
 * duplicate `idempotency_key` values are silently de-duped to the
 * originally assigned seq (UNIQUE constraint at the schema level).
 */
export class EventStore {
    constructor(private readonly db: Db) {}

    /**
     * Append an event and return its assigned seq.
     *
     * If an event with the same `idempotencyKey` was previously appended,
     * no new row is created and the original seq is returned. The whole
     * insert+lookup runs inside a single transaction so the lookup cannot
     * race against a concurrent insert of the same key.
     */
    append(event: Event): number {
        const tx = this.db.transaction((): number => {
            const insert = this.db.prepare(
                `INSERT OR IGNORE INTO events(type, v, occurred_at, idempotency_key, payload)
                 VALUES (?, ?, ?, ?, ?)`,
            );
            const info = insert.run(
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
                .prepare('SELECT seq FROM events WHERE idempotency_key = ?')
                .get(event.idempotencyKey) as { seq: number } | undefined;

            if (!existing) {
                throw new Error(
                    `append: idempotency_key="${event.idempotencyKey}" was ignored on insert but not found on lookup`,
                );
            }
            return existing.seq;
        });

        return tx();
    }

    /**
     * Read events with seq strictly greater than `seq`, ordered ASC, up to
     * `limit` rows. Returns an empty array when no further events exist.
     */
    readAfter(seq: number, limit: number): StoredEvent[] {
        const rows = this.db
            .prepare(
                `SELECT seq, type, v, occurred_at, idempotency_key, payload
                 FROM events
                 WHERE seq > ?
                 ORDER BY seq ASC
                 LIMIT ?`,
            )
            .all(seq, limit) as EventRow[];
        return rows.map(rowToEvent);
    }

    /** Highest seq in the log, or 0 when empty. Used by replay to snapshot
     *  a stable upper bound before scanning. */
    maxSeq(): number {
        const row = this.db
            .prepare('SELECT MAX(seq) AS m FROM events')
            .get() as { m: number | null };
        return row.m ?? 0;
    }

    /**
     * Read events for boot replay: seq in (afterSeq, upToSeq], ordered ASC,
     * up to `limit` rows, excluding `excludeTypes` (high-volume streaming
     * telemetry nobody folds historically). The exclusion happens in SQL so
     * a log that is 80% telemetry costs proportionally less to replay.
     */
    readForReplay(
        afterSeq: number,
        upToSeq: number,
        limit: number,
        excludeTypes: readonly string[],
    ): StoredEvent[] {
        const placeholders = excludeTypes.map(() => '?').join(', ');
        const typeClause = excludeTypes.length > 0
            ? `AND type NOT IN (${placeholders})`
            : '';
        const rows = this.db
            .prepare(
                `SELECT seq, type, v, occurred_at, idempotency_key, payload
                 FROM events
                 WHERE seq > ? AND seq <= ? ${typeClause}
                 ORDER BY seq ASC
                 LIMIT ?`,
            )
            .all(afterSeq, upToSeq, ...excludeTypes, limit) as EventRow[];
        return rows.map(rowToEvent);
    }

    /**
     * Returns the last seq this subscriber has acknowledged, or 0 if the
     * subscriber has never been recorded.
     */
    getSubscriberOffset(name: string): number {
        const row = this.db
            .prepare('SELECT last_seq FROM subscriber_offsets WHERE subscriber = ?')
            .get(name) as { last_seq: number } | undefined;
        return row?.last_seq ?? 0;
    }

    /**
     * Move the subscriber offset forward to `seq`. The offset is monotonic:
     * calls with a `seq` not strictly greater than the current value are
     * rejected (no row change) and `false` is returned. Returns `true` when
     * the offset was advanced (including the initial insert from 0).
     */
    advanceSubscriberOffset(name: string, seq: number): boolean {
        const result = this.db
            .prepare(
                `INSERT INTO subscriber_offsets(subscriber, last_seq) VALUES (?, ?)
                 ON CONFLICT(subscriber) DO UPDATE SET last_seq = excluded.last_seq
                 WHERE excluded.last_seq > subscriber_offsets.last_seq`,
            )
            .run(name, seq);
        return result.changes > 0;
    }
}
