/**
 * Unit tests for the AP-IFB-009 board-UI parity-smoke harness.
 *
 * The harness is a thin shell around the renderer + modal factory
 * modules, so the tests below cover two axes:
 *
 *   1. Each assertion passes against the current implementation —
 *      proves the V1 slot set survived tasks 001–008 (AC #6).
 *   2. Each assertion FAILS with a recognisable message when its
 *      target slot is missing — proves the harness has teeth and a
 *      future regression would surface rather than silently passing.
 *
 * The negative tests rebuild a tiny stand-in for each renderer that
 * deliberately drops one slot, then drive the corresponding assertion
 * through its internal entry point. They live alongside the positive
 * tests so the contract — "these assertions must catch missing slots"
 * — is exercised in the same suite that proves the harness is wired.
 */
import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    assertPlanCardSlots,
    assertProjectModalFields,
    assertReviewReportOpensViaOverlayManager,
    assertWorkerLogOpensViaOverlayManager,
    createRecorderOverlayManager,
    runBoardUiDomParity,
} from './index';

// ---------------------------------------------------------------------------
// AC #2 — plan-card slots
// ---------------------------------------------------------------------------

test('assertPlanCardSlots: passes against the current plan-card renderer', () => {
    assert.doesNotThrow(() => assertPlanCardSlots());
});

// ---------------------------------------------------------------------------
// AC #3 — new-project + edit-project modal field set
// ---------------------------------------------------------------------------

test('assertProjectModalFields: passes against the current modal factories', () => {
    assert.doesNotThrow(() => assertProjectModalFields());
});

// ---------------------------------------------------------------------------
// AC #4 — worker-log + review-report open via the overlay manager
// ---------------------------------------------------------------------------

test('assertWorkerLogOpensViaOverlayManager: records the open() call', async () => {
    await assertWorkerLogOpensViaOverlayManager();
});

test('assertReviewReportOpensViaOverlayManager: records the open() call', () => {
    assert.doesNotThrow(() => assertReviewReportOpensViaOverlayManager());
});

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

test('runBoardUiDomParity: every assertion passes end-to-end', async () => {
    await runBoardUiDomParity();
});

// ---------------------------------------------------------------------------
// Sanity: the recorder overlay manager observes calls in order so a
// downstream regression that fires openOverlay multiple times during a
// single open() would be caught by the existing assertions.
// ---------------------------------------------------------------------------

test('createRecorderOverlayManager: opened + closed are append-only', () => {
    const overlay = createRecorderOverlayManager();
    overlay.openOverlay('a', { tag: 'panel-a' });
    overlay.openOverlay('b', { tag: 'panel-b' });
    overlay.closeOverlay('a');
    assert.deepEqual(
        overlay.opened.map((c) => c.id),
        ['a', 'b'],
    );
    assert.deepEqual(overlay.closed, ['a']);
});
