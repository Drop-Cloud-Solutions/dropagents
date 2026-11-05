/**
 * Unit tests for the Telegram allow-list parser.
 *
 * Dual-runner discovery (same shim as
 * `adapters/telegram/notification-ledger.test.ts`):
 *
 * - `npm test` runs `node --test --import tsx`, which uses Node's
 *   built-in `node:test` registry.
 * - The review pipeline runs `npx vitest run` on changed test files,
 *   which expects vitest's `test()` to register suites.
 *
 * A static `import` from `'vitest'` crashes under `node --test` (vitest
 * v4 forbids `require('vitest')` from CJS, which is what tsc emits for
 * this project). The shim below routes to `globalThis.test` when running
 * inside vitest (vitest.config.ts sets `globals: true`) and to
 * `require('node:test')` everywhere else.
 *
 * The contract this file pins down is re-verified from the outside in
 * task-013, so any change to the wording of acceptance criteria should
 * land in both places.
 */
import assert from 'node:assert/strict';

import {
    describeMode,
    isAllowed,
    parseAllowList,
} from '../../../adapters/telegram/allow-list';

type TestFn = (name: string, fn: () => void | Promise<void>) => void;

const test: TestFn = (((): TestFn => {
    if (process.env.VITEST) {
        const gt = (globalThis as { test?: TestFn }).test;
        if (typeof gt !== 'function') {
            throw new Error(
                'allow-list.test.ts: VITEST=true but globalThis.test is missing — '
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
// AC 1, 2: unset / empty / whitespace → deny-all
// ---------------------------------------------------------------------------

test('parseAllowList(undefined) returns mode "deny-all" with empty ids and no warnings', () => {
    const parsed = parseAllowList(undefined);
    assert.equal(parsed.mode, 'deny-all');
    assert.equal(parsed.ids.size, 0);
    assert.deepEqual(parsed.warnings, []);
});

test('parseAllowList(null) returns mode "deny-all"', () => {
    // null guards against callers that normalise missing env vars to null
    // (process.env strictly returns string | undefined, but defensive).
    const parsed = parseAllowList(null);
    assert.equal(parsed.mode, 'deny-all');
    assert.equal(parsed.ids.size, 0);
});

test('parseAllowList("") returns mode "deny-all"', () => {
    const parsed = parseAllowList('');
    assert.equal(parsed.mode, 'deny-all');
    assert.equal(parsed.ids.size, 0);
    assert.deepEqual(parsed.warnings, []);
});

test('parseAllowList("   ") (whitespace-only) returns mode "deny-all"', () => {
    const parsed = parseAllowList('   ');
    assert.equal(parsed.mode, 'deny-all');
    assert.equal(parsed.ids.size, 0);
    assert.deepEqual(parsed.warnings, []);
});

test('parseAllowList("\\t\\n  \\t") (mixed whitespace) returns mode "deny-all"', () => {
    const parsed = parseAllowList('\t\n  \t');
    assert.equal(parsed.mode, 'deny-all');
    assert.equal(parsed.ids.size, 0);
});

// ---------------------------------------------------------------------------
// AC 3: single + multiple IDs
// ---------------------------------------------------------------------------

test('parseAllowList("123") returns mode "allow-list" with the set { 123 }', () => {
    const parsed = parseAllowList('123');
    assert.equal(parsed.mode, 'allow-list');
    assert.deepEqual(Array.from(parsed.ids).sort(), [123]);
    assert.deepEqual(parsed.warnings, []);
});

test('parseAllowList("123,456") returns mode "allow-list" with { 123, 456 }', () => {
    const parsed = parseAllowList('123,456');
    assert.equal(parsed.mode, 'allow-list');
    assert.equal(parsed.ids.has(123), true);
    assert.equal(parsed.ids.has(456), true);
    assert.equal(parsed.ids.size, 2);
    assert.deepEqual(parsed.warnings, []);
});

test('parseAllowList trims whitespace around tokens', () => {
    const parsed = parseAllowList('  123 ,  456  ,789');
    assert.equal(parsed.mode, 'allow-list');
    assert.deepEqual(Array.from(parsed.ids).sort((a, b) => a - b), [123, 456, 789]);
    assert.deepEqual(parsed.warnings, []);
});

test('parseAllowList collapses duplicate IDs into a single entry without warning', () => {
    const parsed = parseAllowList('123,123,456');
    assert.equal(parsed.mode, 'allow-list');
    assert.equal(parsed.ids.size, 2);
    assert.equal(parsed.ids.has(123), true);
    assert.equal(parsed.ids.has(456), true);
    assert.deepEqual(parsed.warnings, []);
});

test('parseAllowList accepts a single user ID with leading/trailing whitespace', () => {
    const parsed = parseAllowList('  42  ');
    assert.equal(parsed.mode, 'allow-list');
    assert.deepEqual(Array.from(parsed.ids), [42]);
});

// ---------------------------------------------------------------------------
// AC 4: non-numeric tokens dropped to warnings; mixed garbage
// ---------------------------------------------------------------------------

test('parseAllowList("123, abc, 456") drops "abc" to warnings and keeps { 123, 456 }', () => {
    const parsed = parseAllowList('123, abc, 456');
    assert.equal(parsed.mode, 'allow-list');
    assert.equal(parsed.ids.has(123), true);
    assert.equal(parsed.ids.has(456), true);
    assert.equal(parsed.ids.size, 2);
    assert.equal(parsed.warnings.length, 1);
    assert.match(parsed.warnings[0], /abc/);
});

test('parseAllowList records one warning per non-numeric token', () => {
    const parsed = parseAllowList('123,abc,def,456,ghi');
    assert.equal(parsed.mode, 'allow-list');
    assert.equal(parsed.ids.size, 2);
    assert.equal(parsed.warnings.length, 3);
    assert.match(parsed.warnings.join(' | '), /abc/);
    assert.match(parsed.warnings.join(' | '), /def/);
    assert.match(parsed.warnings.join(' | '), /ghi/);
});

test('parseAllowList drops non-integer numeric-looking tokens (decimal, scientific, hex)', () => {
    const parsed = parseAllowList('1.5,1e3,0x10,123');
    assert.equal(parsed.mode, 'allow-list');
    // Only "123" survives — the others are not strict integer tokens.
    assert.deepEqual(Array.from(parsed.ids), [123]);
    assert.equal(parsed.warnings.length, 3);
});

test('parseAllowList drops negative integers as non-numeric', () => {
    // Telegram user IDs are positive. A "-1" token would have been a typo
    // or an attempt to abuse the parser; treat as garbage.
    const parsed = parseAllowList('-1,123');
    assert.equal(parsed.mode, 'allow-list');
    assert.deepEqual(Array.from(parsed.ids), [123]);
    assert.equal(parsed.warnings.length, 1);
    assert.match(parsed.warnings[0], /-1/);
});

test('parseAllowList silently skips empty tokens from stray/trailing commas', () => {
    const parsed = parseAllowList('123,,456,');
    assert.equal(parsed.mode, 'allow-list');
    assert.equal(parsed.ids.size, 2);
    assert.equal(parsed.ids.has(123), true);
    assert.equal(parsed.ids.has(456), true);
    // Stray commas are a typo, not garbage worth flagging.
    assert.deepEqual(parsed.warnings, []);
});

test('parseAllowList in pure-garbage mode still returns mode "allow-list" with empty ids', () => {
    // The presence of any non-whitespace input takes us out of deny-all
    // into a (possibly empty) allow-list — denying everyone is then a
    // consequence of an empty set, not the deny-all sentinel. This keeps
    // the deny-all branch reserved for genuinely-unset config.
    const parsed = parseAllowList('abc, def');
    assert.equal(parsed.mode, 'allow-list');
    assert.equal(parsed.ids.size, 0);
    assert.equal(parsed.warnings.length, 2);
});

// ---------------------------------------------------------------------------
// AC 5, 6: isAllowed semantics
// ---------------------------------------------------------------------------

test('isAllowed returns false in deny-all mode regardless of userId', () => {
    const parsed = parseAllowList(undefined);
    assert.equal(isAllowed(parsed, 123), false);
    assert.equal(isAllowed(parsed, 0), false);
    assert.equal(isAllowed(parsed, 999_999_999), false);
});

test('isAllowed returns false for an ID not in the allow-list', () => {
    assert.equal(isAllowed(parseAllowList('123'), 456), false);
});

test('isAllowed returns true for an ID in the allow-list', () => {
    assert.equal(isAllowed(parseAllowList('123'), 123), true);
});

test('isAllowed returns true for any ID in a multi-entry allow-list', () => {
    const parsed = parseAllowList('123,456,789');
    assert.equal(isAllowed(parsed, 123), true);
    assert.equal(isAllowed(parsed, 456), true);
    assert.equal(isAllowed(parsed, 789), true);
    assert.equal(isAllowed(parsed, 100), false);
});

test('isAllowed is false against an allow-list that parsed to zero IDs (pure garbage input)', () => {
    // Setting TELEGRAM_ALLOWED_USER_IDS="abc" should not let anyone in,
    // even though the mode is technically "allow-list".
    const parsed = parseAllowList('abc');
    assert.equal(isAllowed(parsed, 123), false);
});

// ---------------------------------------------------------------------------
// describeMode helper
// ---------------------------------------------------------------------------

test('describeMode reports deny-all for an unset env var', () => {
    assert.equal(describeMode(parseAllowList(undefined)), 'deny-all (no users allowed)');
});

test('describeMode reports the singular "user ID" form for a one-entry list', () => {
    assert.equal(describeMode(parseAllowList('123')), 'allow-list (1 user ID: 123)');
});

test('describeMode reports the plural form and lists IDs for a multi-entry list', () => {
    assert.equal(
        describeMode(parseAllowList('123,456')),
        'allow-list (2 user IDs: 123, 456)',
    );
});
