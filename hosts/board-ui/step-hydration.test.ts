/**
 * Field report: after a refresh every stage chip on the main board shows
 * the not-started colour, while the same cards inside a plan modal are
 * right.
 *
 * Boot hydration fired one `GET /api/tasks/:id/step-summaries` per task in
 * the `/api/tasks` payload — 1,385 of them at once on a real board, over a
 * link with a ~250ms floor — and awaited the whole set behind a single
 * `Promise.all` before the render that paints the colours. The browser
 * runs ~6 per origin, so the rest queued; the board painted blank and
 * stayed blank for as long as the tail took, and a request that failed was
 * skipped with no retry.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import {
    hydrateInBatches,
    STEP_HYDRATION_CONCURRENCY,
    tasksNeedingStepHydration,
} from './step-hydration';

test('boot hydration asks only for tasks the board paints chips for', () => {
    // The measured shape: ~60 active of 1,385. Fetching the closed ones on
    // every page load is the entire cost with none of the benefit — their
    // chips are not rendered until a plan modal opens.
    const ids = tasksNeedingStepHydration([
        { taskId: 'T-run', status: 'in_progress' },
        { taskId: 'T-parked', status: 'approved', parkedReason: 'approval' },
        { taskId: 'T-failed', status: 'failed' },
        { taskId: 'T-new', status: 'created' },
        { taskId: 'T-done', status: 'done' },
        { taskId: 'T-skipped', status: 'skipped' },
        { taskId: 'T-archived', status: 'archived' },
    ]);

    assert.deepEqual(ids, ['T-run', 'T-parked', 'T-failed', 'T-new']);
});

test('a failed task is still hydrated — it is the one that wants the operator', () => {
    // Same reasoning as the board's active-task filter: failed is not
    // terminal for a surface whose job is "what needs me".
    assert.deepEqual(
        tasksNeedingStepHydration([{ taskId: 'T-1', status: 'failed' }]),
        ['T-1'],
    );
});

test('rows with no usable id are dropped rather than fetched', () => {
    assert.deepEqual(
        tasksNeedingStepHydration([
            { taskId: '', status: 'created' },
            { taskId: 'T-ok', status: 'created' },
        ]),
        ['T-ok'],
    );
});

test('a missing status is treated as open, not closed', () => {
    // Guessing "closed" would silently drop a live task's chips.
    assert.deepEqual(
        tasksNeedingStepHydration([{ taskId: 'T-1' }]),
        ['T-1'],
    );
});

test('batches are bounded — nothing fires beyond the limit at once', async () => {
    let inFlight = 0;
    let peak = 0;
    const ids = Array.from({ length: 25 }, (_u, i) => `T-${i}`);

    await hydrateInBatches(
        ids,
        async () => {
            inFlight += 1;
            peak = Math.max(peak, inFlight);
            await new Promise((r) => setTimeout(r, 1));
            inFlight -= 1;
        },
        () => undefined,
        4,
    );

    assert.equal(peak, 4, `expected at most 4 concurrent, saw ${peak}`);
});

test('every id is still fetched, in order, across batches', async () => {
    const seen: string[] = [];
    const ids = ['a', 'b', 'c', 'd', 'e'];

    await hydrateInBatches(ids, async (id) => { seen.push(id); }, () => undefined, 2);

    assert.deepEqual(seen.sort(), [...ids].sort());
    assert.equal(seen.length, 5);
});

test('the render callback fires PER BATCH, not once at the end', async () => {
    // The visible half of the bug: one render after the last request meant
    // the board sat with blank chips for the whole tail. Rendering per
    // batch fills them in progressively.
    let renders = 0;
    await hydrateInBatches(
        Array.from({ length: 10 }, (_u, i) => `T-${i}`),
        async () => undefined,
        () => { renders += 1; },
        3,
    );

    assert.equal(renders, 4, '10 ids at 3 per batch = 4 batches');
});

test('one failing fetch does not abort the rest', async () => {
    // A rejected request used to be skipped silently with no retry,
    // leaving that task blank for the session. It must at least not take
    // the other batches down with it.
    const done: string[] = [];
    await hydrateInBatches(
        ['a', 'b', 'c', 'd'],
        async (id) => {
            if (id === 'b') throw new Error('network');
            done.push(id);
        },
        () => undefined,
        2,
    );

    assert.deepEqual(done.sort(), ['a', 'c', 'd']);
});

test('an empty list does no work and renders nothing', async () => {
    let renders = 0;
    await hydrateInBatches([], async () => undefined, () => { renders += 1; });
    assert.equal(renders, 0);
});

test('the concurrency default matches the browser per-origin cap', () => {
    // A higher number just builds a queue the code cannot see.
    assert.equal(STEP_HYDRATION_CONCURRENCY, 6);
});
