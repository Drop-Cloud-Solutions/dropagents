/**
 * Unit tests for the Linear adapter's `deriveStatusFromIssue` port.
 *
 * Dual-runner discovery (same shim as
 * `test/adapters/telegram/allow-list.test.ts`): vitest's `globalThis.test`
 * when `VITEST=1` is set; Node's `node:test` otherwise. A static `import`
 * from `'vitest'` would crash under `node --test` (vitest v4 forbids
 * `require('vitest')` from CJS), so we resolve the registration function
 * at runtime.
 *
 * Coverage targets every status branch listed in task-008:
 *   created, approved, in_progress, ready_for_review, ready_to_commit,
 *   ready_to_merge, ready_for_action, awaiting_clarification, done,
 *   plus one failed:<stage>.
 */
import assert from 'node:assert/strict';

import {
    deriveStatusFromIssue,
    type LinearIssueLike,
    type LinearIssueStateType,
} from '../../../adapters/linear/derive-status';

type TestFn = (name: string, fn: () => void | Promise<void>) => void;

const test: TestFn = ((): TestFn => {
    if (process.env.VITEST) {
        const gt = (globalThis as { test?: TestFn }).test;
        if (typeof gt !== 'function') {
            throw new Error(
                'derive-status.test.ts: VITEST=true but globalThis.test is missing — '
                    + 'ensure vitest.config.ts sets test.globals = true',
            );
        }
        return gt;
    }
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    const nt = require('node:test') as { test: TestFn };
    return nt.test;
})();

function issue(
    type: LinearIssueStateType,
    labelNames: ReadonlyArray<string>,
): LinearIssueLike {
    return {
        state: { type },
        labels: labelNames.map((name) => ({ name })),
    };
}

// ---------------------------------------------------------------------------
// AC #2: missing labels default to created
// ---------------------------------------------------------------------------

test('deriveStatusFromIssue: backlog + no labels → status=pending, human_status=created', () => {
    const out = deriveStatusFromIssue(issue('backlog', []));
    assert.equal(out.status, 'pending');
    assert.equal(out.human_status, 'created');
    assert.equal(out.failed_stage, undefined);
});

test('deriveStatusFromIssue: unstarted + no human-approved label → human_status=created', () => {
    const out = deriveStatusFromIssue(issue('unstarted', []));
    assert.equal(out.status, 'pending');
    assert.equal(out.human_status, 'created');
});

// ---------------------------------------------------------------------------
// AC #1: ten enumerated label combinations
// ---------------------------------------------------------------------------

test('unstarted + pipeline:human:approved → human_status=approved', () => {
    const out = deriveStatusFromIssue(
        issue('unstarted', ['pipeline:human:approved']),
    );
    assert.equal(out.status, 'pending');
    assert.equal(out.human_status, 'approved');
});

test('started + pipeline:stage:dev → status=in_progress', () => {
    const out = deriveStatusFromIssue(issue('started', ['pipeline:stage:dev']));
    assert.equal(out.status, 'in_progress');
    assert.equal(out.human_status, 'approved');
});

test('started + pipeline:stage:review → human_status=ready_for_review', () => {
    const out = deriveStatusFromIssue(
        issue('started', ['pipeline:stage:review']),
    );
    assert.equal(out.status, 'review');
    assert.equal(out.human_status, 'ready_for_review');
});

test('started + pipeline:stage:commit → human_status=ready_to_commit', () => {
    const out = deriveStatusFromIssue(
        issue('started', ['pipeline:stage:commit']),
    );
    assert.equal(out.status, 'pending');
    assert.equal(out.human_status, 'ready_to_commit');
});

test('started + pipeline:stage:ready-to-merge → human_status=ready_to_merge', () => {
    const out = deriveStatusFromIssue(
        issue('started', ['pipeline:stage:ready-to-merge']),
    );
    assert.equal(out.status, 'done');
    assert.equal(out.human_status, 'ready_to_merge');
});

test('started + pipeline:stage:action → human_status=ready_for_action', () => {
    const out = deriveStatusFromIssue(
        issue('started', ['pipeline:stage:action']),
    );
    assert.equal(out.status, 'pending');
    assert.equal(out.human_status, 'ready_for_action');
});

test('started + pipeline:stage:awaiting-clarification → human_status=awaiting_clarification', () => {
    const out = deriveStatusFromIssue(
        issue('started', ['pipeline:stage:awaiting-clarification']),
    );
    assert.equal(out.status, 'pending');
    assert.equal(out.human_status, 'awaiting_clarification');
});

test('completed + pipeline:human:merged → human_status=done', () => {
    const out = deriveStatusFromIssue(
        issue('completed', ['pipeline:human:merged']),
    );
    assert.equal(out.status, 'done');
    assert.equal(out.human_status, 'done');
});

// ---------------------------------------------------------------------------
// AC #3: failed-stage detection extracts the stage suffix
// ---------------------------------------------------------------------------

test('pipeline:failed-stage:test → status=failed, failed_stage=test', () => {
    const out = deriveStatusFromIssue(
        issue('started', [
            'pipeline:failed-stage:test',
            'pipeline:stage:test',
        ]),
    );
    assert.equal(out.status, 'failed');
    assert.equal(out.failed_stage, 'test');
    // human_status retains the stage-derived value so the operator can see
    // where the task was when it failed.
    assert.equal(out.human_status, 'ready_for_test');
});

// ---------------------------------------------------------------------------
// Additional branch coverage (kept here so a refactor that drops a branch
// fails loudly).
// ---------------------------------------------------------------------------

test('started + pipeline:stage:test → status=testing, human_status=ready_for_test', () => {
    const out = deriveStatusFromIssue(
        issue('started', ['pipeline:stage:test']),
    );
    assert.equal(out.status, 'testing');
    assert.equal(out.human_status, 'ready_for_test');
});

test('completed without merged label → human_status=ready_to_merge', () => {
    const out = deriveStatusFromIssue(issue('completed', []));
    assert.equal(out.status, 'done');
    assert.equal(out.human_status, 'ready_to_merge');
});

test('canceled → status=skipped, human_status=done', () => {
    const out = deriveStatusFromIssue(issue('canceled', []));
    assert.equal(out.status, 'skipped');
    assert.equal(out.human_status, 'done');
});

test('started + no stage label → falls back to in_progress / approved', () => {
    const out = deriveStatusFromIssue(issue('started', []));
    assert.equal(out.status, 'in_progress');
    assert.equal(out.human_status, 'approved');
});

test('failed-stage label takes precedence over completed state for status', () => {
    const out = deriveStatusFromIssue(
        issue('completed', ['pipeline:failed-stage:commit']),
    );
    assert.equal(out.status, 'failed');
    assert.equal(out.failed_stage, 'commit');
});

test('only the first failed-stage label is reported (dev > review > test > commit)', () => {
    const out = deriveStatusFromIssue(
        issue('started', [
            'pipeline:failed-stage:review',
            'pipeline:failed-stage:test',
        ]),
    );
    assert.equal(out.failed_stage, 'review');
});

// AC #4: helper is pure — no I/O, no API calls. Proven structurally by the
// import surface above (only types + the function). The test below also
// asserts the input object is not mutated.
test('deriveStatusFromIssue does not mutate its input', () => {
    const input = issue('started', ['pipeline:stage:dev']);
    const snapshot = JSON.stringify(input);
    deriveStatusFromIssue(input);
    assert.equal(JSON.stringify(input), snapshot);
});
