/**
 * Keeping per-RUN prose off per-CHUNK events.
 *
 * Field measurement that motivated this (worker, 2026-11-03,
 * `npm run db:report`): of 679.5 MB of event payload, `AgentProgress`
 * was 585.8 MB over 120011 rows — 5.0 KB a row, for chunks that are
 * text deltas of tens of bytes. The remainder was the spec metadata
 * republished on every delta.
 *
 * The property under test is narrow and load-bearing: the routing keys
 * a subscriber needs survive, the kilobyte-scale context fields do not,
 * and the dropped VALUES never appear anywhere (including the log).
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import {
    STREAM_METADATA_MAX_VALUE_BYTES,
    slimStreamMetadata,
} from './stream-metadata';

/** A realistic spec metadata object, with the two fat fields. */
const AGENT_MEMORY = 'operator feedback: '.repeat(400); // ~7.6 KB
const REJECT_FEEDBACK = 'CHANGES REQUIRED: '.repeat(300); // ~5.4 KB
const metadata = {
    taskId: 'T-PKG-005',
    stepId: 'commit',
    planId: 'plan-1700000000000-abcd',
    kind: 'task',
    model: 'claude-opus-5',
    effort: 'high',
    targetRepo: 'webshop',
    agentMemory: AGENT_MEMORY,
    rejectFeedback: REJECT_FEEDBACK,
};

test('the routing keys survive and the prose does not', () => {
    const { metadata: slim, dropped } = slimStreamMetadata(metadata);
    assert.ok(slim);
    // Everything a subscriber routes a chunk BY. `kind` and `planId` in
    // particular: they are the board's planner/decomposer run
    // discrimination, and dropping them would silently stop the
    // Show-agent stream from finding its row.
    assert.deepEqual(Object.keys(slim!).sort(), [
        'effort', 'kind', 'model', 'planId', 'stepId', 'targetRepo', 'taskId',
    ]);
    assert.deepEqual([...dropped].sort(), ['agentMemory', 'rejectFeedback']);
});

test('the dropped VALUES appear nowhere in the result', () => {
    // `dropped` is key names by design: one value is an agent-memory
    // block and the other is operator feedback. A caller logs this.
    const result = slimStreamMetadata(metadata);
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes('operator feedback:'), 'agent memory leaked');
    assert.ok(!serialized.includes('CHANGES REQUIRED:'), 'reject feedback leaked');
});

test('the saving is the whole point, so measure it', () => {
    const before = JSON.stringify(metadata).length;
    const after = JSON.stringify(slimStreamMetadata(metadata).metadata).length;
    assert.ok(
        after < before / 20,
        `expected a >20x reduction, got ${before} -> ${after} bytes`,
    );
    // 120011 rows carried the fat version on the field worker.
    assert.ok((before - after) * 120011 / 1024 / 1024 > 400, 'sanity: hundreds of MB');
});

test('a value exactly at the cap is kept; one byte over is dropped', () => {
    const at = 'x'.repeat(STREAM_METADATA_MAX_VALUE_BYTES);
    const over = 'x'.repeat(STREAM_METADATA_MAX_VALUE_BYTES + 1);
    const { metadata: slim, dropped } = slimStreamMetadata({ at, over });
    assert.deepEqual(Object.keys(slim ?? {}), ['at']);
    assert.deepEqual(dropped, ['over']);
});

test('undefined metadata stays undefined rather than becoming {}', () => {
    // The callers spread the result into an event payload and omit the
    // key when it is undefined; returning {} would publish an empty
    // `metadata` object on every chunk instead of no key at all.
    const result = slimStreamMetadata(undefined);
    assert.equal(result.metadata, undefined);
    assert.deepEqual(result.dropped, []);
});

test('metadata that is ENTIRELY oversized yields undefined, not {}', () => {
    const result = slimStreamMetadata({ agentMemory: AGENT_MEMORY });
    assert.equal(result.metadata, undefined);
    assert.deepEqual(result.dropped, ['agentMemory']);
});

test('an undefined entry is skipped without being reported as dropped', () => {
    const result = slimStreamMetadata({ taskId: 'T-1', model: undefined });
    assert.deepEqual(result.metadata, { taskId: 'T-1' });
    assert.deepEqual(result.dropped, [], 'absent is not the same as too big');
});

test('non-string values are measured serialized, not stringified loosely', () => {
    const result = slimStreamMetadata({
        count: 42,
        flag: true,
        small: { a: 1 },
        big: Array.from({ length: 400 }, (_, i) => `item-${i}`),
    });
    assert.deepEqual(Object.keys(result.metadata ?? {}).sort(), ['count', 'flag', 'small']);
    assert.deepEqual(result.dropped, ['big']);
});

test('a value that cannot be serialized is dropped, not thrown on', () => {
    // A cycle would break the publish anyway; losing it from a
    // per-chunk event is the cheaper failure, and it must not take the
    // whole run's event stream down with it.
    const cyclic: Record<string, unknown> = { taskId: 'T-1' };
    cyclic.self = cyclic;
    let result;
    assert.doesNotThrow(() => {
        result = slimStreamMetadata(cyclic);
    });
    assert.deepEqual(result!.metadata, { taskId: 'T-1' });
    assert.deepEqual(result!.dropped, ['self']);
});
