/**
 * Unit tests for the Telegram slash-command router (AP-VP6-006).
 *
 * Dual-runner discovery (same shim as
 * `test/adapters/telegram/allow-list.test.ts`):
 *
 * - `npm test` runs `node --test --import tsx`, which uses Node's built-in
 *   `node:test` registry.
 * - The review pipeline runs `npx vitest run` on changed test files, which
 *   expects vitest's `test()` to register suites.
 *
 * A static `import` from `'vitest'` crashes under `node --test` (vitest v4
 * forbids `require('vitest')` from CJS, which is what tsc emits for this
 * project). The shim routes to `globalThis.test` when running inside
 * vitest (vitest.config.ts sets `globals: true`) and to
 * `require('node:test')` everywhere else.
 */
import assert from 'node:assert/strict';

import { parseCommand } from '../../../adapters/telegram/command-router';

type TestFn = (name: string, fn: () => void | Promise<void>) => void;

const test: TestFn = (((): TestFn => {
    if (process.env.VITEST) {
        const gt = (globalThis as { test?: TestFn }).test;
        if (typeof gt !== 'function') {
            throw new Error(
                'command-router.test.ts: VITEST=true but globalThis.test is missing — '
                    + 'ensure vitest.config.ts sets test.globals = true',
            );
        }
        return gt;
    }
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    const nt = require('node:test') as { test: TestFn };
    return nt.test;
})());

// ---------------------------------------------------------------------------
// AC 1: /approve → ResumeTask{ decision: 'approve' }
// ---------------------------------------------------------------------------

test("parseCommand('/approve') returns ResumeTask with decision 'approve'", () => {
    const parsed = parseCommand('/approve');
    assert.deepEqual(parsed, { kind: 'ResumeTask', decision: 'approve' });
});

test("parseCommand('/approve') tolerates trailing whitespace", () => {
    const parsed = parseCommand('  /approve   ');
    assert.deepEqual(parsed, { kind: 'ResumeTask', decision: 'approve' });
});

test("parseCommand('/Approve') is case-insensitive on the verb", () => {
    const parsed = parseCommand('/Approve');
    assert.deepEqual(parsed, { kind: 'ResumeTask', decision: 'approve' });
});

// ---------------------------------------------------------------------------
// AC 2: /reject [feedback] → ResumeTask{ decision: 'reject', feedback? }
// ---------------------------------------------------------------------------

test("parseCommand('/reject too noisy') returns ResumeTask with decision 'reject' and feedback 'too noisy'", () => {
    const parsed = parseCommand('/reject too noisy');
    assert.deepEqual(parsed, {
        kind: 'ResumeTask',
        decision: 'reject',
        feedback: 'too noisy',
    });
});

test("parseCommand('/reject') with no feedback omits the feedback field", () => {
    const parsed = parseCommand('/reject');
    assert.deepEqual(parsed, { kind: 'ResumeTask', decision: 'reject' });
});

test("parseCommand('/reject   ') with whitespace-only feedback omits the field", () => {
    const parsed = parseCommand('/reject   ');
    assert.deepEqual(parsed, { kind: 'ResumeTask', decision: 'reject' });
});

test("parseCommand joins multi-word /reject arguments into a single string", () => {
    const parsed = parseCommand('/reject please retry with the staging credentials');
    assert.deepEqual(parsed, {
        kind: 'ResumeTask',
        decision: 'reject',
        feedback: 'please retry with the staging credentials',
    });
});

// ---------------------------------------------------------------------------
// AC 3: /clarify <answer> → ResumeTask{ answer }
// ---------------------------------------------------------------------------

test("parseCommand('/clarify use the existing label') returns ResumeTask with answer 'use the existing label'", () => {
    const parsed = parseCommand('/clarify use the existing label');
    assert.deepEqual(parsed, {
        kind: 'ResumeTask',
        decision: 'approve',
        answer: 'use the existing label',
    });
});

test("parseCommand joins multi-word /clarify arguments into a single answer string", () => {
    const parsed = parseCommand('/clarify option A with the lower retry budget');
    assert.deepEqual(parsed, {
        kind: 'ResumeTask',
        decision: 'approve',
        answer: 'option A with the lower retry budget',
    });
});

test("parseCommand('/clarify') with no answer returns unrecognized", () => {
    // A clarification with no answer body is meaningless — the operator
    // must supply text. Fall through to unrecognized so the adapter can
    // prompt them to retry.
    const parsed = parseCommand('/clarify');
    assert.equal(parsed.kind, 'unrecognized');
});

// ---------------------------------------------------------------------------
// AC 4: /skip, /retry, /cancel → SkipTask, RetryTask, CancelTask
// ---------------------------------------------------------------------------

test("parseCommand('/skip') returns SkipTask", () => {
    const parsed = parseCommand('/skip');
    assert.deepEqual(parsed, { kind: 'SkipTask' });
});

test("parseCommand('/retry') returns RetryTask", () => {
    const parsed = parseCommand('/retry');
    assert.deepEqual(parsed, { kind: 'RetryTask' });
});

test("parseCommand('/cancel') returns CancelTask", () => {
    const parsed = parseCommand('/cancel');
    assert.deepEqual(parsed, { kind: 'CancelTask' });
});

test("parseCommand ignores trailing arguments on /skip, /retry, /cancel", () => {
    // The bus payloads carry only taskId — any trailing operator text is
    // dropped. Tested explicitly so a stray comment after /skip doesn't
    // mutate into a different command kind.
    assert.deepEqual(parseCommand('/skip foo bar'), { kind: 'SkipTask' });
    assert.deepEqual(parseCommand('/retry now'), { kind: 'RetryTask' });
    assert.deepEqual(parseCommand('/cancel please'), { kind: 'CancelTask' });
});

// ---------------------------------------------------------------------------
// AC 5: unknown commands → { kind: 'unrecognized', raw }
// ---------------------------------------------------------------------------

test("parseCommand('/garbage') returns unrecognized with raw preserved", () => {
    const parsed = parseCommand('/garbage');
    assert.deepEqual(parsed, { kind: 'unrecognized', raw: '/garbage' });
});

test("parseCommand(non-slash text) returns unrecognized", () => {
    const parsed = parseCommand('hello bot');
    assert.deepEqual(parsed, { kind: 'unrecognized', raw: 'hello bot' });
});

test("parseCommand('') returns unrecognized", () => {
    const parsed = parseCommand('');
    assert.deepEqual(parsed, { kind: 'unrecognized', raw: '' });
});

test("parseCommand('   ') (whitespace only) returns unrecognized", () => {
    const parsed = parseCommand('   ');
    assert.deepEqual(parsed, { kind: 'unrecognized', raw: '   ' });
});
