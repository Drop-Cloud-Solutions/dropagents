/**
 * Board-UI DOM parity-smoke driver (AP-IFB-009).
 *
 * Aggregates the per-surface assertions in this folder into a single
 * round-trip entry point that `scripts/parity-smoke.ts` registers in
 * its `ROUND_TRIPS` array. Each assertion module owns one acceptance
 * criterion:
 *
 *   - {@link assertPlanCardSlots} — AC #2 (plan-card slots)
 *   - {@link assertProjectModalFields} — AC #3 (new/edit project fields)
 *   - {@link assertWorkerLogOpensViaOverlayManager},
 *     {@link assertReviewReportOpensViaOverlayManager} — AC #4 (overlay manager)
 *
 * The harness does not change the V1 baseline pin (AC #5) — every
 * assertion runs against the V2 implementation in this repo and
 * targets the operator-facing DOM contract the V1 baseline already
 * exposes. The `REFERENCE_BASELINE` file stays read-only here.
 *
 * AC #6 ("all new assertions pass against the implementation produced
 * by task-001 through task-008") is enforced by `runBoardUiDomParity`
 * returning normally — a single failure is escalated as a thrown
 * `BoardUiParityFailure` and the parity-smoke harness exits non-zero.
 */

export { PLAN_CARD_SAMPLE, assertPlanCardSlots } from './plan-card-assertions';
export {
    assertEditProjectModalFields,
    assertNewProjectModalFields,
    assertProjectModalFields,
    createRecorderOverlayManager,
} from './project-modal-assertions';
export {
    assertReviewReportOpensViaOverlayManager,
    assertWorkerLogOpensViaOverlayManager,
} from './overlay-launcher-assertions';

import { assertPlanCardSlots } from './plan-card-assertions';
import { assertProjectModalFields } from './project-modal-assertions';
import {
    assertReviewReportOpensViaOverlayManager,
    assertWorkerLogOpensViaOverlayManager,
} from './overlay-launcher-assertions';

/**
 * Run every board-UI DOM parity assertion in sequence. Returns `void`
 * on success; throws on the first failing assertion. The parity-smoke
 * harness catches the throw and reports the failure with the offending
 * round-trip name so the operator sees which surface regressed.
 */
export async function runBoardUiDomParity(): Promise<void> {
    // NOTE: `assertTaskCardSlots` was removed with `web/board-task-cards.ts`.
    // It asserted DOM slots on a typed task-card renderer the shipped
    // board never used (board.ts renders from #task-card-template), so it
    // was green regardless of what the operator actually saw. Deleting it
    // removes false confidence, not coverage — task-card behaviour is
    // covered by hosts/board-ui/board.test.ts and report-availability.test.ts.
    assertPlanCardSlots();
    assertProjectModalFields();
    await assertWorkerLogOpensViaOverlayManager();
    assertReviewReportOpensViaOverlayManager();
}
