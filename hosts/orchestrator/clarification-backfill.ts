/**
 * One-shot backfill of `task_clarifications` from the event log.
 *
 * The projection that populates the table was added after the fact, and
 * `projection-tasks` is long past those events' offsets — so without
 * this, every answer an operator gave before the upgrade stays
 * invisible to the reviewer, including one on a task that is running
 * right now. Re-answering is not an option: the task already resumed.
 *
 * Runs at boot, replaying only the four event types involved. Every
 * insert is `INSERT OR IGNORE` keyed on the source event seq, so this
 * is idempotent — a second boot adds nothing.
 *
 * Recovering the QUESTION is the reason this walks the log in order
 * rather than querying answers alone: `tasks.parked_question` was
 * cleared when the task resumed, but the `TaskParked` /
 * `ClarificationRequested` event that carried the question is still in
 * the log, immediately before the answer.
 */

import type { Db } from '../../core/state/migrations';
import type { Logger } from '../../core/ports/Logger';

const SOURCE_TYPES = [
    'TaskParked',
    'ClarificationRequested',
    'TaskResumed',
    'ClarificationAnswered',
] as const;

interface EventRow {
    readonly seq: number;
    readonly type: string;
    readonly occurred_at: number;
    readonly payload: string;
}

/**
 * @returns how many clarification rows were inserted.
 */
export function backfillClarifications(db: Db, logger: Logger): number {
    let rows: EventRow[];
    try {
        rows = db
            .prepare(
                `SELECT seq, type, occurred_at, payload FROM events
                  WHERE type IN (${SOURCE_TYPES.map(() => '?').join(', ')})
                  ORDER BY seq ASC`,
            )
            .all(...SOURCE_TYPES) as EventRow[];
    } catch (err) {
        logger.warn('clarification-backfill: event scan failed (skipping)', {
            error: err instanceof Error ? err.message : String(err),
        });
        return 0;
    }

    const insert = db.prepare(
        `INSERT OR IGNORE INTO task_clarifications
             (event_seq, task_id, question, answer, answered_at)
         VALUES (?, ?, ?, ?, ?)`,
    );
    // taskId -> the question from the most recent park before this point.
    const pendingQuestion = new Map<string, string>();
    let inserted = 0;

    for (const row of rows) {
        let payload: Record<string, unknown>;
        try {
            payload = JSON.parse(row.payload) as Record<string, unknown>;
        } catch {
            continue;
        }
        const taskId = typeof payload.taskId === 'string' ? payload.taskId : null;
        if (!taskId) continue;

        if (row.type === 'TaskParked' || row.type === 'ClarificationRequested') {
            const question = typeof payload.question === 'string'
                ? payload.question.trim()
                : '';
            if (question.length > 0) pendingQuestion.set(taskId, question);
            continue;
        }

        // TaskResumed only counts as an answer when the operator
        // approved AND supplied one; ClarificationAnswered is always one.
        if (row.type === 'TaskResumed' && payload.decision !== 'approve') {
            // A rejection ends the park too — its feedback lives on
            // tasks.feedback, and the stale question must not attach to
            // some later answer.
            pendingQuestion.delete(taskId);
            continue;
        }
        const answer = typeof payload.answer === 'string' ? payload.answer.trim() : '';
        if (answer.length === 0) continue;

        try {
            const res = insert.run(
                row.seq,
                taskId,
                pendingQuestion.get(taskId) ?? null,
                answer,
                row.occurred_at,
            );
            if (res.changes > 0) inserted += 1;
        } catch (err) {
            logger.warn('clarification-backfill: insert failed (continuing)', {
                seq: row.seq,
                taskId,
                error: err instanceof Error ? err.message : String(err),
            });
        }
        pendingQuestion.delete(taskId);
    }

    if (inserted > 0) {
        logger.info(
            'clarification-backfill: recovered operator answers from the event log',
            { inserted, scanned: rows.length },
        );
    }
    return inserted;
}
