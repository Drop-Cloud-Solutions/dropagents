/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * AP-VP5-014 — board.ts ⇄ Phase 5 modal/panel wiring smoke tests.
 *
 * Phase 5 introduced four new operator surfaces — AP-VP5-010 clarify
 * modal, AP-VP5-011 investigation follow-up modal, AP-VP5-012
 * reject-feedback modal, AP-VP5-013 per-project notes panel — and
 * board.ts is the seam that wires each one onto the right card-level
 * affordance. The wiring contract is:
 *
 *   1. Cards with `parkedReason === 'clarification'` render an Answer
 *      button (action id `answer-clarification`) that opens the
 *      AP-VP5-010 clarify modal (the `modals/clarify.ts` surface, not
 *      the legacy `client/modals/clarify.ts` one).
 *   2. Commit-approval cards (`parkedReason === 'approval'` AND
 *      `parkedStepId === 'pr.open'`) route their Reject button to the
 *      AP-VP5-012 reject-feedback modal instead of the AP-VP-015
 *      inline panel.
 *   3. Investigation cards (`type === 'investigate'`) with a non-empty
 *      thread render an `Ask follow-up` button (action id
 *      `ask-investigation-followup`) that opens the AP-VP5-011
 *      investigation follow-up modal.
 *   4. Selecting a project mounts the AP-VP5-013 notes panel in the
 *      sidebar against that project's id, and re-selecting another
 *      project hands the panel over via `setProjectId(...)` instead of
 *      rebuilding the DOM.
 *
 * board.ts has top-level browser side-effects (overlay manager
 * construction, document queries, EventSource handshake) so we can't
 * `import()` it from Node test runners. Instead we follow the
 * `board.test.ts` precedent — read the source on disk and assert the
 * wiring patterns with surgical regexes. That keeps the test fast,
 * dependency-free, and pins exactly the wiring contract the task brief
 * calls out without standing up a jsdom shell.
 *
 * Dual-runner test() shim — mirrors `board.test.ts` so the same suite
 * runs under both `node:test` (npm test) and vitest (the cloud review
 * pipeline).
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Dual-runner test() shim
// ---------------------------------------------------------------------------

type TestFn = (name: string, fn: () => void | Promise<void>) => void;

const test: TestFn = (((): TestFn => {
    if (process.env.VITEST) {
        const gt = (globalThis as { test?: TestFn }).test;
        if (typeof gt !== 'function') {
            throw new Error(
                'board-phase5-wiring.test.ts: VITEST=true but globalThis.test '
                    + 'is missing — ensure vitest.config.ts sets test.globals = true',
            );
        }
        return gt;
    }
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    const nt = require('node:test') as { test: TestFn };
    return nt.test;
})());

// ---------------------------------------------------------------------------
// Load board.ts source once for the whole suite
// ---------------------------------------------------------------------------

const BOARD_TS_PATH = path.resolve(
    __dirname,
    '../../../hosts/board-ui/board.ts',
);

function readBoardSource(): string {
    return fs.readFileSync(BOARD_TS_PATH, 'utf8');
}

const boardSource = readBoardSource();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Assert a regex matches the source; embed the pattern in the failure msg. */
function assertMatch(re: RegExp, label: string): void {
    if (!re.test(boardSource)) {
        throw new Error(
            `board.ts is missing the ${label} wiring; expected pattern: ${re}`,
        );
    }
}

/**
 * Extract the body of a function declaration named `name` from board.ts
 * by counting matching braces from its `function name(` opener. We need
 * the body to scope per-function pattern checks — a regex against the
 * whole file would let unrelated branches in other functions pass the
 * assertion by accident.
 */
function extractFunctionBody(source: string, name: string): string {
    const headerRe = new RegExp(`function\\s+${name}\\b[^{]*\\{`);
    const match = headerRe.exec(source);
    if (!match) {
        throw new Error(`board.ts: could not locate function ${name}`);
    }
    const openIdx = match.index + match[0].length - 1;
    let depth = 0;
    for (let i = openIdx; i < source.length; i++) {
        const ch = source[i];
        if (ch === '{') depth++;
        else if (ch === '}') {
            depth--;
            if (depth === 0) {
                return source.slice(openIdx, i + 1);
            }
        }
    }
    throw new Error(
        `board.ts: function ${name} body is unbalanced (no closing brace)`,
    );
}

// ---------------------------------------------------------------------------
// Import contract — all four Phase 5 surfaces are imported
// ---------------------------------------------------------------------------

test('board.ts imports the AP-VP5-010 clarify modal (modals/clarify)', () => {
    assertMatch(
        /from\s+['"]\.\/modals\/clarify['"]/,
        'AP-VP5-010 clarify-modal import',
    );
    // The new import must use an alias so it doesn't clash with the
    // legacy `openClarifyModal` import from client/modals/clarify.
    assertMatch(
        /openClarifyModal\s+as\s+\w+\s*\}\s*from\s+['"]\.\/modals\/clarify['"]/,
        'AP-VP5-010 alias import',
    );
});

test('board.ts imports the AP-VP5-012 reject-feedback modal', () => {
    assertMatch(
        /openRejectFeedbackModal[^;]*from\s+['"]\.\/modals\/reject-feedback['"]/s,
        'reject-feedback modal import',
    );
});

test('board.ts imports the AP-VP5-013 notes panel', () => {
    assertMatch(
        /from\s+['"]\.\/panels\/notes['"]/,
        'notes-panel import',
    );
});

test('board.ts imports the AP-VP5-011 investigation-followup modal', () => {
    assertMatch(
        /openInvestigationFollowupModal[^;]*from\s+['"]\.\/client\/modals\/investigation-followup['"]/s,
        'investigation-followup modal import',
    );
});

// ---------------------------------------------------------------------------
// Entry point #1 — Answer button on parked-clarification cards
// ---------------------------------------------------------------------------

test('parked-clarification cards render an Answer button', () => {
    const body = extractFunctionBody(boardSource, 'injectTaskCardModalTriggers');
    // The Answer button must be conditional on parkedReason === 'clarification'
    // (we don't want every card growing a stray Answer button) and must
    // hand the action id `answer-clarification` to onTaskAction.
    assert.match(
        body,
        /parkedReason\s*===\s*['"]clarification['"]/,
        'Answer button gate (parkedReason === clarification) missing',
    );
    assert.match(
        body,
        /addBtn\(\s*['"]Answer['"]\s*,\s*['"]answer-clarification['"]\s*\)/,
        'Answer button addBtn call missing',
    );
});

test('answer-clarification action opens the Phase 5 clarify modal', () => {
    const body = extractFunctionBody(boardSource, 'onTaskAction');
    // Look for the action case and verify it calls the new opener.
    assert.match(
        body,
        /case\s+['"]answer-clarification['"]:[\s\S]*?openClarificationAnswer\s*\(\s*task\s*\)/,
        'answer-clarification action does not route to openClarificationAnswer',
    );

    // openClarificationAnswer must use the aliased AP-VP5-010 modal, not
    // the legacy AP-IFF-015 one. Find the alias from the import line and
    // assert the opener body invokes it.
    const aliasMatch =
        /openClarifyModal\s+as\s+(\w+)\s*\}\s*from\s+['"]\.\/modals\/clarify['"]/.exec(
            boardSource,
        );
    assert.ok(aliasMatch, 'Phase 5 clarify alias import not found');
    const aliasName = aliasMatch![1];
    const openerBody = extractFunctionBody(boardSource, 'openClarificationAnswer');
    assert.ok(
        openerBody.includes(`${aliasName}(`),
        `openClarificationAnswer should call the Phase 5 alias ${aliasName}(...)`,
    );
    // The modal needs the task's parked question + the captured choices.
    assert.match(
        openerBody,
        /parkedQuestion/,
        'openClarificationAnswer must pass parkedQuestion',
    );
    assert.match(
        openerBody,
        /clarificationChoices\.get\(\s*task\.taskId\s*\)/,
        'openClarificationAnswer must pass the captured choices',
    );
});

// ---------------------------------------------------------------------------
// Entry point #2 — Commit-approval Reject routes to the modal
// ---------------------------------------------------------------------------

test('commit-approval Reject opens the reject-feedback modal', () => {
    const body = extractFunctionBody(boardSource, 'renderApprovalControls');
    // The wiring contract: detect commit-approval via parkedStepId
    // === 'pr.open' and route the Reject button to the new modal.
    assert.match(
        body,
        /parkedStepId\s*===\s*['"]pr\.open['"]/,
        'commit-approval gate (parkedStepId === pr.open) missing',
    );
    assert.match(
        body,
        /openCommitRejectFeedback\s*\(\s*task\s*\)/,
        'commit-approval Reject does not route to openCommitRejectFeedback',
    );

    // The opener itself must invoke the AP-VP5-012 modal entry point.
    const openerBody = extractFunctionBody(
        boardSource,
        'openCommitRejectFeedback',
    );
    assert.match(
        openerBody,
        /openRejectFeedbackModal\s*\(/,
        'openCommitRejectFeedback must call openRejectFeedbackModal',
    );
});

test('non-commit approval parks keep the AP-VP-015 inline reject panel', () => {
    // For non-commit approval parks (wait-action, pr.merge) the inline
    // textarea panel must still be wired so the inline-feedback flow
    // doesn't regress. The function returns early after appending the
    // wrap for the commit-approval branch and continues with the panel
    // construction below for the rest.
    const body = extractFunctionBody(boardSource, 'renderApprovalControls');
    assert.match(
        body,
        /approval-reject-panel/,
        'inline approval-reject-panel construction missing',
    );
    assert.match(
        body,
        /approval-feedback/,
        'inline approval-feedback textarea missing',
    );
});

// ---------------------------------------------------------------------------
// Entry point #3 — Ask follow-up button for investigation cards with thread
// ---------------------------------------------------------------------------

test('investigation cards with a thread render an Ask follow-up button', () => {
    const body = extractFunctionBody(boardSource, 'injectTaskCardModalTriggers');
    // Gate must require type === 'investigate' AND a non-empty thread —
    // a cleared thread shouldn't surface the button.
    assert.match(
        body,
        /task\.type\s*===\s*['"]investigate['"]/,
        'investigate type gate missing',
    );
    assert.match(
        body,
        /investigation_thread[\s\S]{0,200}?length\s*>\s*0/,
        'investigation_thread length gate missing',
    );
    assert.match(
        body,
        /addBtn\(\s*['"]Ask follow-up['"]\s*,\s*['"]ask-investigation-followup['"]\s*\)/,
        'Ask follow-up addBtn call missing',
    );
});

test('ask-investigation-followup action opens the AP-VP5-011 modal', () => {
    const body = extractFunctionBody(boardSource, 'onTaskAction');
    assert.match(
        body,
        /case\s+['"]ask-investigation-followup['"]:[\s\S]*?openInvestigationFollowup\s*\(\s*task\s*\)/,
        'ask-investigation-followup action does not route to openInvestigationFollowup',
    );
    const openerBody = extractFunctionBody(
        boardSource,
        'openInvestigationFollowup',
    );
    assert.match(
        openerBody,
        /openInvestigationFollowupModal\s*\(/,
        'openInvestigationFollowup must call openInvestigationFollowupModal',
    );
    // The opener must pre-load the thread so the operator doesn't see an
    // empty modal on first paint.
    assert.match(
        openerBody,
        /handle\.refresh\(\)/,
        'openInvestigationFollowup must trigger an initial refresh',
    );
});

// ---------------------------------------------------------------------------
// Entry point #4 — Notes panel mounts in the project sidebar
// ---------------------------------------------------------------------------

test('selecting a project mounts the notes panel in the sidebar', () => {
    const onSelectBody = extractFunctionBody(boardSource, 'onSelectProject');
    assert.match(
        onSelectBody,
        /mountNotesPanelForProject\s*\(\s*projectId\s*\)/,
        'onSelectProject does not call mountNotesPanelForProject',
    );

    const mountBody = extractFunctionBody(
        boardSource,
        'mountNotesPanelForProject',
    );
    // First mount: call initNotesPanel against the synthesised host.
    assert.match(
        mountBody,
        /initNotesPanel\s*\(/,
        'mountNotesPanelForProject must initialise the notes panel',
    );
    // Re-mount: re-target the existing handle via setProjectId so we
    // don't rebuild the DOM on every project switch.
    assert.match(
        mountBody,
        /notesPanelHandle\.setProjectId\s*\(\s*projectId\s*\)/,
        'mountNotesPanelForProject must re-target via setProjectId on re-select',
    );
});

test('notes panel host slots into the sidebar above the plans section', () => {
    const ensureBody = extractFunctionBody(boardSource, 'ensureNotesPanelHost');
    // The DOM we synthesise carries the v1 sidebar section conventions
    // (h2 header + container with aria-live) and gets inserted before
    // the existing #plans-section so it lands above the plan tree.
    assert.match(
        ensureBody,
        /aside\.sidebar/,
        'ensureNotesPanelHost must query the sidebar element',
    );
    assert.match(
        ensureBody,
        /#plans-section/,
        'ensureNotesPanelHost must position relative to #plans-section',
    );
    assert.match(
        ensureBody,
        /notes-panel-container/,
        'ensureNotesPanelHost must create the notes-panel-container slot',
    );
});

// ---------------------------------------------------------------------------
// CSS contract — the four Phase 5 surfaces have rules in board.css
// ---------------------------------------------------------------------------

const BOARD_CSS_PATH = path.resolve(
    __dirname,
    '../../../hosts/board-ui/board.css',
);
const boardCss = fs.readFileSync(BOARD_CSS_PATH, 'utf8');

test('board.css carries rules for the AP-VP5-010 clarify modal', () => {
    assert.match(boardCss, /\.clarify-panel\b/);
    assert.match(boardCss, /\.clarify-question\b/);
    assert.match(boardCss, /\.clarify-answer\b/);
    assert.match(boardCss, /\.clarify-remember\b/);
});

test('board.css carries rules for the AP-VP5-011 follow-up modal', () => {
    assert.match(boardCss, /\.followup-panel\b/);
    assert.match(boardCss, /\.followup-thread\b/);
    assert.match(boardCss, /\.followup-turn\b/);
});

test('board.css carries rules for the AP-VP5-012 reject-feedback modal', () => {
    assert.match(boardCss, /\.reject-feedback-panel\b/);
    assert.match(boardCss, /\.reject-feedback-textarea\b/);
});

test('board.css carries rules for the AP-VP5-013 notes panel', () => {
    assert.match(boardCss, /\.notes-panel-row\b/);
    assert.match(boardCss, /\.notes-panel-composer\b/);
    assert.match(boardCss, /\.notes-panel-action\b/);
    // The sidebar notes section uses the v1 sidebar density tokens
    // (10px/16px padding, border-bottom).
    assert.match(boardCss, /\.sidebar\s+\.notes\b/);
});

// ---------------------------------------------------------------------------
// Defensive: the legacy AP-IFF-015 clarify path must still exist so the
// chat-bot's `case 'clarify'` fallback in onTaskAction keeps resolving.
// AP-VP5-014 is additive — it must not remove the old surface.
// ---------------------------------------------------------------------------

test('legacy AP-IFF-015 openClarify is still wired (additive change)', () => {
    const onActionBody = extractFunctionBody(boardSource, 'onTaskAction');
    assert.match(
        onActionBody,
        /case\s+['"]clarify['"]:[\s\S]*?openClarify\s*\(\s*task\s*\)/,
        'legacy clarify case removed by accident',
    );
});

// ---------------------------------------------------------------------------
// Defensive: clarification choices side-store is wired to the
// ClarificationRequested event so the Answer modal sees the agent's
// enumerated options.
// ---------------------------------------------------------------------------

test('ClarificationRequested populates the clarification-choices store', () => {
    const applyBody = extractFunctionBody(boardSource, 'applyEvent');
    assert.match(
        applyBody,
        /case\s+['"]ClarificationRequested['"]/,
        'ClarificationRequested case missing from applyEvent',
    );
    assert.match(
        applyBody,
        /clarificationChoices\.set\(/,
        'ClarificationRequested handler must populate clarificationChoices',
    );
    // The choices are scoped to a single park — TaskResumed must drop
    // them so a follow-on park doesn't inherit stale options.
    assert.match(
        applyBody,
        /clarificationChoices\.delete\(/,
        'TaskResumed (or TaskDeleted) must clear clarificationChoices',
    );
});
