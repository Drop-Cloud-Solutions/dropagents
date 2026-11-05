/**
 * AP-VP-015 — Approve / Reject UI for approval-parked tasks.
 *
 * Two coupled surfaces ship in this task: a stepId-aware tag derivation
 * for (`parkedReason='approval'`, `current_step_id`) and the inline
 * Approve/Reject controls the board card renders when that state hits
 * the projection. The tests below pin both.
 *
 * The pure tag mapping lives in `./task-tags` (`approvalStepTag` +
 * the parked-reason branch inside `deriveTaskTags`); the rendering
 * wiring lives in `./board.ts` and pulls in browser-only modules at
 * top level, so — mirroring the established pattern in
 * `board.test.ts` — the rendering surface is asserted via a source
 * read rather than a live import. Both surfaces are exercised against
 * the same three v1-vocab stepId fixtures the AP-VP-015 plan calls
 * out (`pr.open` / `pr.merge` / `wait-action`) plus the safe-default
 * fallthrough for an unknown stepId.
 *
 * Dual-runner discovery mirrors `board.test.ts` and `commands.test.ts`:
 * the suite must execute under both vitest (used by the cloud review
 * pipeline) and Node's built-in `node:test` runner (used by `npm test`).
 */
import * as assert from 'node:assert/strict';

import { approvalStepTag, deriveTaskTags, type TaskTag } from './task-tags';

// ---------------------------------------------------------------------------
// Dual-runner test() shim — see commands.test.ts for the rationale.
// ---------------------------------------------------------------------------

type TestFn = (name: string, fn: () => void | Promise<void>) => void;

const test: TestFn = (((): TestFn => {
    if (process.env.VITEST) {
        const gt = (globalThis as { test?: TestFn }).test;
        if (typeof gt !== 'function') {
            throw new Error(
                'board.approval.test.ts: VITEST=true but globalThis.test is missing — '
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
// Fixture matrix — the four (parkedReason='approval', stepId) cases the
// AP-VP-015 plan pins.
// ---------------------------------------------------------------------------

interface ApprovalFixture {
    readonly label: string;
    readonly stepId: string | null;
    readonly expectedTag: TaskTag;
}

const APPROVAL_FIXTURES: ReadonlyArray<ApprovalFixture> = [
    { label: 'pr.open', stepId: 'pr.open', expectedTag: 'ready_to_commit' },
    { label: 'pr.merge', stepId: 'pr.merge', expectedTag: 'ready_to_merge' },
    { label: 'wait-action', stepId: 'wait-action', expectedTag: 'ready_for_action' },
    // Safe-default branch — any stepId outside the table maps to
    // ready_for_action so the operator still sees the Approve/Reject row
    // under a familiar v1 banner.
    {
        label: 'unknown-step (fallback)',
        stepId: 'context-update',
        expectedTag: 'ready_for_action',
    },
];

// ---------------------------------------------------------------------------
// approvalStepTag — pure stepId → v1 tag table
// ---------------------------------------------------------------------------

for (const f of APPROVAL_FIXTURES) {
    test(`approvalStepTag: stepId=${f.label} → ${f.expectedTag}`, () => {
        assert.equal(approvalStepTag(f.stepId), f.expectedTag);
    });
}

test('approvalStepTag: null / undefined / "" → ready_for_action (safe default)', () => {
    assert.equal(approvalStepTag(null), 'ready_for_action');
    assert.equal(approvalStepTag(undefined), 'ready_for_action');
    assert.equal(approvalStepTag(''), 'ready_for_action');
});

// ---------------------------------------------------------------------------
// deriveTaskTags — parkedReason='approval' branch picks up the stepId tag
// ---------------------------------------------------------------------------

for (const f of APPROVAL_FIXTURES) {
    test(`deriveTaskTags: parkedReason='approval' + stepId=${f.label} → ${f.expectedTag}`, () => {
        const tags = deriveTaskTags({
            parkedReason: 'approval',
            current_step_id: f.stepId ?? undefined,
        });
        assert.ok(
            tags.includes(f.expectedTag),
            `expected ${f.expectedTag} in [${tags.join(', ')}]`,
        );
        // Approval parks must NOT borrow the clarification overlay —
        // the action row diverges (Approve/Reject vs. Answer/Cancel).
        assert.ok(!tags.includes('awaiting_clarification'));
    });
}

test('deriveTaskTags: parkedReason=approval without stepId → ready_for_action (safe default)', () => {
    const tags = deriveTaskTags({ parkedReason: 'approval' });
    assert.ok(tags.includes('ready_for_action'));
    assert.ok(!tags.includes('awaiting_clarification'));
});

test('deriveTaskTags: parkedReason=approval does not double up when human_status already matches', () => {
    // Engine writes both `human_status: 'ready_to_commit'` (via the
    // existing v1 vocab map) and parks on `pr.open` simultaneously.
    // The tag should appear exactly once.
    const tags = deriveTaskTags({
        human_status: 'ready_to_commit',
        parkedReason: 'approval',
        current_step_id: 'pr.open',
    });
    assert.equal(
        tags.filter((t) => t === 'ready_to_commit').length,
        1,
        'ready_to_commit appears exactly once',
    );
});

// ---------------------------------------------------------------------------
// Rendering wiring — board.ts asserts via source-read
//
// `board.ts` cannot be imported under the unit-test runners because its
// top-level wires up an EventSource, document queries, and the overlay
// manager singleton. The existing `board.test.ts` already uses the
// fs+regex pattern to pin the re-export contract; the same technique
// works for the AP-VP-015 rendering surface — we match against the
// distinctive markers each control writes into the source so a refactor
// that drops one will break the test.
// ---------------------------------------------------------------------------

async function readBoardSource(): Promise<string> {
    const fs = await import('node:fs');
    const path = await import('node:path');
    return fs.readFileSync(path.join(__dirname, 'board.ts'), 'utf8');
}

test('board.ts renders Approve + Reject controls for parked-for-approval cards', async () => {
    const src = await readBoardSource();
    // The renderer must be reachable from the per-card loop.
    assert.match(
        src,
        /renderApprovalControls\s*\(\s*frag\s*,\s*task\s*\)/,
        'renderApprovalControls must be called from renderTasks',
    );
    // Guard the renderer body against accidentally firing for non-approval parks.
    assert.match(
        src,
        /function\s+renderApprovalControls[\s\S]*?task\.parkedReason\s*!==\s*'approval'/,
        'renderApprovalControls must early-return when parkedReason !== "approval"',
    );
    // Approve button.
    assert.match(src, /['"]data-action['"]\s*,\s*['"]approval-approve['"]/);
    assert.match(src, /approveBtn\.textContent\s*=\s*'Approve'/);
    // Reject button.
    assert.match(src, /['"]data-action['"]\s*,\s*['"]approval-reject['"]/);
    assert.match(src, /rejectBtn\.textContent\s*=\s*'Reject'/);
});

test('board.ts: Reject reveals an INLINE feedback textarea (no modal)', async () => {
    const src = await readBoardSource();
    // Inline textarea, not a modal.
    assert.match(src, /createElement\('textarea'\)/);
    assert.match(src, /['"]data-approval-feedback['"]/);
    assert.match(src, /['"]data-approval-reject-panel['"]/);
    // The reject path inside the approval renderer must NOT route
    // through the modal entry point — that is reserved for the
    // committer-stage reject flow.
    const renderBody = src.match(
        /function\s+renderApprovalControls[\s\S]*?\n\}/,
    );
    assert.ok(renderBody, 'renderApprovalControls function body not found');
    assert.doesNotMatch(
        renderBody![0],
        /openRejectModal|openRejectForTask/,
        'approval reject must be inline — no modal call inside renderApprovalControls',
    );
});

test('board.ts: Approve dispatches ResumeTask with decision="approve" and no feedback', async () => {
    const src = await readBoardSource();
    const onApprove = src.match(/function\s+onApproveParked[\s\S]*?\n\}/);
    assert.ok(onApprove, 'onApproveParked not found');
    assert.match(onApprove![0], /type:\s*'ResumeTask'/);
    assert.match(onApprove![0], /decision:\s*'approve'/);
    assert.doesNotMatch(
        onApprove![0],
        /feedback/,
        'approve dispatch must not carry feedback',
    );
});

test('board.ts: Reject submit dispatches ResumeTask with decision="reject" and the feedback string', async () => {
    const src = await readBoardSource();
    const onReject = src.match(/function\s+onRejectParked[\s\S]*?\n\}/);
    assert.ok(onReject, 'onRejectParked not found');
    assert.match(onReject![0], /type:\s*'ResumeTask'/);
    assert.match(onReject![0], /decision:\s*'reject'/);
    // The feedback parameter must thread onto the payload.
    assert.match(onReject![0], /feedback/);
});

// ---------------------------------------------------------------------------
// AP-VP-015 attempt #2 — reviewer feedback. The previous implementation
// guarded the "Submit rejection" click handler with an empty-string check
// that focused the textarea and returned without dispatching. That was
// inconsistent with ResumeTaskPayload (where `feedback` is optional) and
// blocked rejections that don't need a reason. The guard must be gone and
// Submit must dispatch regardless of textarea content.
// ---------------------------------------------------------------------------
test('board.ts: Submit rejection dispatches even with empty feedback (no early-return guard)', async () => {
    const src = await readBoardSource();
    const renderBody = src.match(
        /function\s+renderApprovalControls[\s\S]*?\n\}/,
    );
    assert.ok(renderBody, 'renderApprovalControls function body not found');
    // Locate the submit-button click handler body.
    const submitHandler = renderBody![0].match(
        /submitBtn\.addEventListener\(\s*'click'\s*,\s*\(\)\s*=>\s*\{[\s\S]*?\}\s*\)\s*;/,
    );
    assert.ok(submitHandler, 'submit-rejection click handler not found');
    // The reviewer-rejected guard pattern must NOT reappear.
    assert.doesNotMatch(
        submitHandler![0],
        /if\s*\(\s*!\s*reason\s*\)/,
        'submit handler must not short-circuit on empty feedback',
    );
    assert.doesNotMatch(
        submitHandler![0],
        /feedback\.focus\s*\(\s*\)\s*;\s*\n?\s*return\s*;/,
        'submit handler must not focus + return on empty feedback',
    );
    // Submit must always reach onRejectParked.
    assert.match(
        submitHandler![0],
        /onRejectParked\s*\(\s*task\s*,\s*reason\s*\)/,
        'submit handler must always invoke onRejectParked',
    );
});

test('board.ts: onRejectParked threads any feedback value (incl. empty string) onto the ResumeTask payload', async () => {
    // Sanity check that the wiring downstream of the now-guardless submit
    // handler does not introduce its own empty-feedback short-circuit:
    // `feedback` must end up on the payload verbatim (the engine + payload
    // validator both accept `feedback?: string`, so '' is valid).
    const src = await readBoardSource();
    const onReject = src.match(/function\s+onRejectParked[\s\S]*?\n\}/);
    assert.ok(onReject, 'onRejectParked not found');
    // The function signature must accept feedback as a plain string (no
    // `feedback?:` / default-value pattern that would silently rewrite ''
    // to something else before dispatch).
    assert.match(
        onReject![0],
        /function\s+onRejectParked\s*\(\s*task\s*:\s*TaskRow\s*,\s*feedback\s*:\s*string\s*\)/,
    );
    // And the payload field is set to the parameter, not to a non-empty
    // derived value.
    assert.match(onReject![0], /feedback(\s*:\s*feedback)?\s*[,}]/);
    assert.doesNotMatch(
        onReject![0],
        /if\s*\(\s*!\s*feedback\s*\)/,
        'onRejectParked must not branch on empty feedback',
    );
});

test('board.ts: TaskParked captures stepId; TaskResumed/AgentStarted clear it', async () => {
    const src = await readBoardSource();
    // stepId carried onto the projection.
    assert.match(
        src,
        /t\.parkedStepId\s*=\s*\n?\s*typeof\s+payload\.stepId\s*===\s*'string'\s*\?\s*payload\.stepId\s*:\s*null/s,
        'TaskParked must persist payload.stepId onto the TaskRow projection',
    );
    // Both clear sites — TaskResumed and AgentStarted — null out parkedStepId.
    const clearSites = src.match(/t\.parkedStepId\s*=\s*null/g) ?? [];
    assert.ok(
        clearSites.length >= 2,
        `expected ≥2 parkedStepId clear sites, found ${clearSites.length}`,
    );
});

test('board.ts: parked-approval cards hide the legacy blind Resume button', async () => {
    // The template-supplied [data-resume-action] button dispatches a
    // blind ResumeTask{decision:'approve'} — for approval parks the
    // operator must instead see the explicit Approve/Reject row, so the
    // legacy button must be hidden alongside the new controls.
    //
    // The gate has since grown to cover every park reason that owns a
    // dedicated affordance (approval, wait-merged, clarification,
    // worktree-diff-review, waiting-deps), so this asserts the CURRENT
    // shape — `ownedByOtherUi` including 'approval' — instead of the
    // original two-term literal, which had silently rotted into a
    // permanently-failing pin.
    const src = await readBoardSource();
    assert.match(src, /resumeBtn\.hidden\s*=\s*!parkedReason\s*\|\|\s*ownedByOtherUi/);
    const gate = /const ownedByOtherUi[\s\S]{0,900}?;/.exec(src);
    assert.ok(gate, 'expected an ownedByOtherUi definition guarding Resume');
    assert.match(gate[0], /'approval'/, 'approval parks must own their own Approve/Reject row');
});

// ---------------------------------------------------------------------------
// Per-fixture board rendering — three stepIds × {tag, buttons} (AC #6)
// ---------------------------------------------------------------------------

/**
 * Compact "render a fixture" smoke: derive the tag (the rendered card's
 * status banner) and re-confirm the source-level wiring for the
 * Approve / Reject row from one place. Splitting these into per-fixture
 * tests keeps the regression output readable when a single mapping
 * silently changes.
 */
for (const f of APPROVAL_FIXTURES.slice(0, 3)) {
    test(`fixture: parkedReason=approval + stepId=${f.label} renders tag ${f.expectedTag} and Approve/Reject controls`, async () => {
        const tags = deriveTaskTags({
            parkedReason: 'approval',
            current_step_id: f.stepId ?? undefined,
        });
        assert.ok(
            tags.includes(f.expectedTag),
            `card tag for ${f.label}: expected ${f.expectedTag} in [${tags.join(', ')}]`,
        );
        const src = await readBoardSource();
        assert.match(src, /['"]data-action['"]\s*,\s*['"]approval-approve['"]/);
        assert.match(src, /['"]data-action['"]\s*,\s*['"]approval-reject['"]/);
        assert.match(src, /['"]data-approval-feedback['"]/);
    });
}
