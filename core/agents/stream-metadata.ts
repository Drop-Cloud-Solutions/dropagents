/**
 * What spec metadata is allowed to ride on a HIGH-FREQUENCY agent event.
 *
 * Field measurement (worker, 2026-11-03) that motivated this:
 *
 *   payload         679.5 MB over 213093 events
 *   AgentProgress   585.8 MB over 120011 rows — 5.0 KB average
 *
 * 86% of the entire event log's payload bytes was `AgentProgress`, at
 * 5 KB a row. An `AgentProgress` chunk is a text DELTA — tens of bytes.
 * The other ~4.9 KB was `ctx.metadata`, republished verbatim on every
 * single chunk: `metadata.agentMemory` (the whole rendered agent-memory
 * block) and `metadata.rejectFeedback` (the full text of the previous
 * step's rejection). On an earlier field DB those two were 92% of the
 * bytes in the largest progress rows.
 *
 * Both are per-RUN context. Repeating them per CHUNK multiplied them by
 * the number of assistant deltas in a run, and the agent-memory block
 * only ever grows, so the multiplier grows with it.
 *
 * ## Why a size cap rather than a key allowlist
 *
 * Everything a subscriber actually routes a chunk BY is a short
 * identifier — `kind`, `planId`, `taskId`, `stepId`, `model`. The only
 * metadata the stream consumers read at all are `kind` and `planId`
 * (the board's planner/decomposer run discrimination). So a cap on
 * VALUE SIZE keeps every routing key and drops exactly the prose.
 *
 * The decisive advantage over a list of banned keys is that it does not
 * drift: the next fat context field someone threads onto a spec is
 * excluded the day it is added, with no one having to remember this
 * file exists. A list of names would have to be updated by the person
 * least likely to be thinking about event-log size.
 *
 * Full metadata still rides on the LIFECYCLE events (`AgentStarted`,
 * `AgentFinished`, `AgentFailed`) — a handful per run, where the
 * richer fields are legitimately read and the cost is bounded.
 */

/**
 * Longest serialized value that may ride on a per-chunk event.
 *
 * 512 bytes is far above any identifier (a GUID-ish task id is ~16, a
 * model name ~24) and far below the prose fields this exists to stop
 * (an agent-memory block is kilobytes by construction).
 */
export const STREAM_METADATA_MAX_VALUE_BYTES = 512;

export interface SlimmedStreamMetadata {
    /**
     * The metadata to attach, or `undefined` when there is nothing left
     * to attach — so the caller can omit the key entirely rather than
     * publish an empty object.
     */
    readonly metadata: Readonly<Record<string, unknown>> | undefined;
    /** Names of the dropped keys, for a one-line log. Never their values. */
    readonly dropped: readonly string[];
}

/**
 * Keep the small entries, drop the big ones, and report which went.
 *
 * Reports the dropped KEY NAMES only. The values are the reason this
 * function exists — one is an agent-memory block and one is operator
 * feedback — and the house rule is that prose does not get echoed into
 * logs just because it was inconvenient.
 */
export function slimStreamMetadata(
    metadata: Readonly<Record<string, unknown>> | undefined,
    maxValueBytes: number = STREAM_METADATA_MAX_VALUE_BYTES,
): SlimmedStreamMetadata {
    if (metadata === undefined) return { metadata: undefined, dropped: [] };

    const kept: Record<string, unknown> = {};
    const dropped: string[] = [];
    for (const [key, value] of Object.entries(metadata)) {
        if (value === undefined) continue;
        if (measure(value) > maxValueBytes) dropped.push(key);
        else kept[key] = value;
    }
    return {
        metadata: Object.keys(kept).length > 0 ? kept : undefined,
        dropped,
    };
}

/**
 * Serialized size of one value.
 *
 * A value that cannot be serialized (a cycle, a BigInt) is treated as
 * oversized: it would break the publish anyway, and dropping it from a
 * per-chunk event is the cheaper failure.
 */
function measure(value: unknown): number {
    if (typeof value === 'string') return value.length;
    try {
        return JSON.stringify(value)?.length ?? 0;
    } catch {
        return Number.POSITIVE_INFINITY;
    }
}
