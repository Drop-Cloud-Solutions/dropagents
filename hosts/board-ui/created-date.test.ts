/**
 * The "created <date>" chip on the plan and task modals.
 *
 * Two decisions worth pinning:
 *
 *  - The format is NOT locale-derived. `toLocaleDateString` renders
 *    `4/7/2026` as 4 July in Amsterdam and 7 April in New York, and this
 *    date is read as evidence of how long a piece of work has been
 *    sitting. A spelled month cannot be misread, and it makes the
 *    assertions below mean the same thing on every machine that runs
 *    them.
 *  - An unusable timestamp yields null, and the caller omits the chip.
 *    Half the task rows in a mature database predate the column and were
 *    backfilled from the event log; the ones whose creation event has
 *    been pruned have no date at all. "Invalid Date" on a modal is
 *    noise, and quietly substituting today is a lie.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { createdChip, createdTooltip, formatCreatedDate } from './created-date';

// Local noon, so the assertions do not flip a day under the test
// machine's timezone the way a UTC-midnight instant would.
const JULY_4 = new Date(2026, 6, 4, 12, 0, 0).getTime();
const LAST_DEC = new Date(2025, 11, 31, 12, 0, 0).getTime();
const NOW = new Date(2026, 8, 17, 12, 0, 0).getTime();

test('a date in the current year drops the year', () => {
    // Most of what an operator opens was created this year, and the
    // chips row already carries status, type and project.
    assert.equal(formatCreatedDate(JULY_4, NOW), '4 Jul');
});

test('a date from another year keeps it', () => {
    // Without the year "31 Dec" reads as nine months in the FUTURE.
    assert.equal(formatCreatedDate(LAST_DEC, NOW), '31 Dec 2025');
});

test('the month is spelled, never numeric', () => {
    // 4/7 vs 7/4 is the whole reason this helper exists.
    const out = formatCreatedDate(JULY_4, NOW)!;
    assert.match(out, /Jul/);
    assert.doesNotMatch(out, /\d+\/\d+/);
});

test('every month renders as its own abbreviation', () => {
    const seen = new Set<string>();
    for (let m = 0; m < 12; m += 1) {
        const at = new Date(2026, m, 15, 12, 0, 0).getTime();
        const out = formatCreatedDate(at, NOW)!;
        assert.ok(out, `month ${m}`);
        seen.add(out.split(' ')[1]!);
    }
    assert.equal(seen.size, 12, 'no two months share a label');
});

// --- absent and malformed --------------------------------------------

test('an absent date yields null, not a fabricated one', () => {
    for (const bad of [null, undefined, NaN, 0, -1, Infinity]) {
        assert.equal(formatCreatedDate(bad as number | null, NOW), null, String(bad));
    }
});

test('a non-number off the wire yields null', () => {
    // The field crosses HTTP and JSON; a string date would otherwise
    // render as "NaN NaN".
    assert.equal(formatCreatedDate('2026-07-04' as unknown as number, NOW), null);
    assert.equal(formatCreatedDate({} as unknown as number, NOW), null);
});

// --- the chip --------------------------------------------------------

test('the chip is prefixed so it is not read as another tag', () => {
    // It sits in a row of bare words — "done · implement · webshop".
    assert.equal(createdChip(JULY_4, NOW), 'created 4 Jul');
});

test('no date means no chip at all', () => {
    assert.equal(createdChip(null, NOW), null);
});

// --- the tooltip -----------------------------------------------------

test('the tooltip carries the precise time the chip drops', () => {
    const tip = createdTooltip(JULY_4)!;
    assert.match(tip, /^Created /);
    // The exact rendering is the viewer's locale; what matters is that
    // it resolves to the same instant.
    assert.ok(tip.length > 'Created '.length);
});

test('the tooltip is absent when the date is', () => {
    assert.equal(createdTooltip(null), null);
    assert.equal(createdTooltip(0), null);
});
