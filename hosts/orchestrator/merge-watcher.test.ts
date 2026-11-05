/**
 * The other half of `--auto`: noticing that the queued merge landed.
 *
 * `gh pr merge --auto` returns as soon as GitHub ACCEPTS the request.
 * The merge happens later. If nothing watches, the task stays parked at
 * wait-merged for a PR that merged twenty minutes ago, and the clone's
 * `origin/<default>` never advances — so a dependent task unblocked by
 * that merge branches off pre-merge code and the developer reports "the
 * upstream task didn't merge".
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import {
    parsePrState,
    resolveAutoMergePollMs,
    resolveAutoMergeTimeoutMs,
    watchEnqueuedMerge,
    type WatchEnqueuedMergeDeps,
} from './merge-watcher';

const silent = {
    info: (): void => undefined,
    warn: (): void => undefined,
    error: (): void => undefined,
    debug: (): void => undefined,
};

/**
 * Drives the loop on a fake clock: `sleep` advances `now`, so a
 * one-hour timeout is exercised in microseconds and the test never
 * actually waits.
 */
function harness(views: Array<string | Error>): {
    deps: WatchEnqueuedMergeDeps;
    merged: number;
    gaveUp: string[];
    polls: number;
    state: { now: number };
} {
    const state = { now: 1_000 };
    const out = {
        merged: 0,
        gaveUp: [] as string[],
        polls: 0,
        state,
        deps: {} as WatchEnqueuedMergeDeps,
    };
    out.deps = {
        taskId: 'T-1',
        prNumber: 42,
        logger: silent as unknown as WatchEnqueuedMergeDeps['logger'],
        now: () => state.now,
        pollMs: 60_000,
        timeoutMs: 600_000, // 10 polls
        sleep: async (ms) => { state.now += ms; },
        viewPr: async () => {
            const next = views[Math.min(out.polls, views.length - 1)];
            out.polls += 1;
            if (next instanceof Error) throw next;
            return next ?? '{"state":"OPEN","mergedAt":null}';
        },
        onMerged: async () => { out.merged += 1; },
        onGaveUp: async (detail) => { out.gaveUp.push(detail); },
    };
    return out;
}

const OPEN = '{"state":"OPEN","mergedAt":null}';
const MERGED = '{"state":"MERGED","mergedAt":"2026-10-13T09:00:00Z"}';
const CLOSED = '{"state":"CLOSED","mergedAt":null}';

// --- parsing ----------------------------------------------------------

test('a merged PR is read from mergedAt', () => {
    assert.equal(parsePrState(MERGED), 'MERGED');
});

test('a squash merge with a null mergedAt still reads as merged', () => {
    // gh has reported MERGED with no timestamp; the state field is the
    // backstop so such a merge is not polled forever.
    assert.equal(parsePrState('{"state":"MERGED","mergedAt":null}'), 'MERGED');
});

test('an open and a closed PR are distinguished', () => {
    assert.equal(parsePrState(OPEN), 'OPEN');
    assert.equal(parsePrState(CLOSED), 'CLOSED');
});

test('a banner or BOM ahead of the JSON does not break the read', () => {
    // gh prints login and deprecation notices to stdout, and Windows
    // adds a BOM often enough to matter.
    const bom = '﻿';
    assert.equal(
        parsePrState(`${bom}A new release of gh is available!\n${MERGED}`),
        'MERGED',
    );
});

test('UNPARSEABLE output reads as OPEN, never as merged', () => {
    // The dangerous direction: treating garbage as MERGED would finish
    // a task whose PR never landed. Keep polling instead.
    for (const junk of ['', 'not json', '{', 'null', '[]', '{"state":']) {
        assert.equal(parsePrState(junk), 'OPEN', junk);
    }
});

test('an unknown state reads as OPEN', () => {
    assert.equal(parsePrState('{"state":"DRAFT","mergedAt":null}'), 'OPEN');
});

// --- the loop ---------------------------------------------------------

test('a merge that lands on the third poll finishes the task', async () => {
    const h = harness([OPEN, OPEN, MERGED]);
    assert.equal(await watchEnqueuedMerge(h.deps), 'merged');
    assert.equal(h.merged, 1);
    assert.deepEqual(h.gaveUp, [], 'a landed merge is not a give-up');
    assert.equal(h.polls, 3);
});

test('the PR is checked AFTER a wait, not immediately', async () => {
    // `gh pr merge --auto` has only just returned; GitHub cannot
    // possibly have merged yet, so an instant first check is a wasted
    // API call on every single task.
    const h = harness([MERGED]);
    await watchEnqueuedMerge(h.deps);
    assert.equal(h.state.now, 1_000 + 60_000, 'exactly one poll interval elapsed');
});

test('a PR closed without merging gives up at once', async () => {
    // It will never merge on its own; polling for an hour would just
    // delay telling the operator.
    const h = harness([CLOSED]);
    assert.equal(await watchEnqueuedMerge(h.deps), 'closed');
    assert.equal(h.merged, 0);
    assert.equal(h.gaveUp.length, 1);
    assert.match(h.gaveUp[0]!, /closed without merging/i);
});

test('the deadline ends the watch LOUDLY', async () => {
    // Never fail silently: the task stays parked, so the operator has
    // to be told the pipeline stopped waiting.
    const h = harness([OPEN]);
    assert.equal(await watchEnqueuedMerge(h.deps), 'timeout');
    assert.equal(h.merged, 0);
    assert.equal(h.gaveUp.length, 1);
    assert.match(h.gaveUp[0]!, /10 minutes/);
    assert.match(h.gaveUp[0]!, /still queued with GitHub/i);
});

test('the watch does not outlive its timeout', async () => {
    const h = harness([OPEN]);
    await watchEnqueuedMerge(h.deps);
    assert.ok(h.polls <= 11, `polled ${h.polls} times for a 10-poll window`);
});

// --- hostile conditions -----------------------------------------------

test('a failing `gh pr view` is transient, not fatal', async () => {
    // A token hiccup or a rate limit must not abandon a merge that is
    // about to land.
    const h = harness([new Error('gh: API rate limit exceeded'), OPEN, MERGED]);
    assert.equal(await watchEnqueuedMerge(h.deps), 'merged');
    assert.equal(h.merged, 1);
});

test('persistent view failures still end at the deadline, and say so', async () => {
    const h = harness([new Error('gh: Bad credentials (HTTP 401)')]);
    assert.equal(await watchEnqueuedMerge(h.deps), 'timeout');
    assert.match(h.gaveUp[0]!, /could not be read/);
});

test('onMerged runs exactly once', async () => {
    // It publishes TaskResumed; twice would drive the task through its
    // completion twice.
    const h = harness([MERGED, MERGED, MERGED]);
    await watchEnqueuedMerge(h.deps);
    assert.equal(h.merged, 1);
});

// --- the knobs --------------------------------------------------------

test('the poll default is a minute and cannot be set to a spin', async () => {
    assert.equal(resolveAutoMergePollMs({}), 60_000);
    assert.equal(resolveAutoMergePollMs({ PIPELINE_AUTO_MERGE_POLL_SECONDS: '15' }), 15_000);
    for (const bad of ['0', '-5', '1', 'abc', '']) {
        assert.equal(
            resolveAutoMergePollMs({ PIPELINE_AUTO_MERGE_POLL_SECONDS: bad }),
            60_000,
            bad,
        );
    }
});

test('the timeout default is an hour', async () => {
    assert.equal(resolveAutoMergeTimeoutMs({}), 60 * 60_000);
    assert.equal(
        resolveAutoMergeTimeoutMs({ PIPELINE_AUTO_MERGE_TIMEOUT_MINUTES: '15' }),
        15 * 60_000,
    );
    for (const bad of ['0', '-1', 'abc', '']) {
        assert.equal(
            resolveAutoMergeTimeoutMs({ PIPELINE_AUTO_MERGE_TIMEOUT_MINUTES: bad }),
            60 * 60_000,
            bad,
        );
    }
});
