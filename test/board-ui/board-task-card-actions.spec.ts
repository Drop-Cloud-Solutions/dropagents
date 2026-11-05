/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Source-level wiring tests for the AP-IFB-008 task-card affordances.
 *
 * The new wiring all lives in `hosts/board-ui/board.ts`, which talks
 * directly to `document` / `window` / `EventSource` and is not easily
 * unit-tested without jsdom. Other board.ts wiring tasks (AP-IFG-022 /
 * AP-IFB-005 etc.) pair structural source assertions in `test/board-ui/`
 * with end-to-end coverage in `test/parity/board/board-parity.spec.ts`,
 * which boots Playwright against the real bundle — this file follows the
 * same pattern.
 *
 * AC coverage:
 *   AC #1 — Worker-log launcher binding exists in board.ts and the
 *           launcher button exists in index.html.
 *   AC #2 — `injectTaskCardModalTriggers` registers "Show agent" + "View
 *           report" buttons with the expected data-action values.
 *   AC #3 — Show-agent routes through `onShowAgent`, which expands the
 *           inline `[data-agent-stream]` slot.
 *   AC #4 — View-report routes through `openReviewReportForTask`, which
 *           opens the AP-IFB-007 review-report modal via
 *           `createReviewReportModal`.
 *   AC #5 — The two actions are dispatched by a single columns-level
 *           delegated click listener — not a per-card listener — and the
 *           per-card binding loop explicitly skips them.
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Dual-runner test() shim (matches the other board-ui specs)
// ---------------------------------------------------------------------------

type TestFn = (name: string, fn: () => void | Promise<void>) => void;

const test: TestFn = (((): TestFn => {
    if (process.env.VITEST) {
        const gt = (globalThis as { test?: TestFn }).test;
        if (typeof gt !== 'function') {
            throw new Error(
                'board-task-card-actions.spec.ts: VITEST=true but globalThis.test is '
                    + 'missing — ensure vitest.config.ts sets test.globals = true',
            );
        }
        return gt;
    }
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    const nt = require('node:test') as { test: TestFn };
    return nt.test;
})());

// ---------------------------------------------------------------------------
// Source loaders
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function readBoardSource(): string {
    // Normalise CRLF → LF so the regexes below stay terse on Windows
    // checkouts (the repo is Windows-first; board.ts ships with CRLF).
    return fs
        .readFileSync(path.join(REPO_ROOT, 'hosts', 'board-ui', 'board.ts'), 'utf8')
        .replace(/\r\n/g, '\n');
}

function readIndexHtml(): string {
    return fs
        .readFileSync(path.join(REPO_ROOT, 'hosts', 'board-ui', 'index.html'), 'utf8')
        .replace(/\r\n/g, '\n');
}

// ---------------------------------------------------------------------------
// AC #1 — worker-log launcher
// ---------------------------------------------------------------------------

test('AC #1 — index.html exposes the worker-log launcher button', () => {
    const html = readIndexHtml();
    assert.match(
        html,
        /id="worker-log-launcher"/,
        'expected a #worker-log-launcher element in the sidebar footer',
    );
});

test('AC #1 — board.ts binds the worker-log launcher click to openWorkerLogModal', () => {
    const src = readBoardSource();
    // The launcher lookup + listener live near the bottom of board.ts.
    assert.match(
        src,
        /getElementById\('worker-log-launcher'\)/,
        'expected board.ts to resolve the worker-log-launcher element',
    );
    assert.match(
        src,
        /workerLogLauncher\.addEventListener\('click'[\s\S]*?openWorkerLogModal\(\)/,
        'expected the launcher click handler to call openWorkerLogModal()',
    );
    // openWorkerLogModal dispatches through the AP-IFF-018 entry point.
    assert.match(
        src,
        /openWorkerLog\(\{[\s\S]*?overlayManager: overlayManager/,
        'expected openWorkerLogModal to forward the overlay-manager singleton '
            + 'into the AP-IFF-018 openWorkerLog factory',
    );
});

// ---------------------------------------------------------------------------
// AC #2 — Show agent + View report buttons are injected per card
// ---------------------------------------------------------------------------

test('AC #2 — injectTaskCardModalTriggers adds Show agent + View report buttons', () => {
    const src = readBoardSource();
    const injectMatch = src.match(
        /function injectTaskCardModalTriggers\([\s\S]*?\n\}\n/,
    );
    assert.ok(
        injectMatch,
        'expected an injectTaskCardModalTriggers() function in board.ts',
    );
    const body = injectMatch[0];
    assert.match(
        body,
        /addBtn\('Show agent', 'show-agent'\)/,
        'expected a Show agent button with data-action="show-agent" to be injected',
    );
    assert.match(
        body,
        /addBtn\('View report', 'view-report'\)/,
        'expected a View report button with data-action="view-report" to be injected',
    );
});

// ---------------------------------------------------------------------------
// AC #3 — Show agent routes through onShowAgent (task-agent modal)
// ---------------------------------------------------------------------------

test('AC #3 — onShowAgent opens the task-agent modal for the clicked task', () => {
    const src = readBoardSource();
    const fnMatch = src.match(/function onShowAgent\([\s\S]*?\n\}\n/);
    assert.ok(fnMatch, 'expected an onShowAgent() function in board.ts');
    const body = fnMatch[0];
    // Scoped to the CLICKED task — a modal opened for the wrong id shows
    // another agent's feed, which is worse than showing none.
    assert.match(
        body,
        /openShowTaskAgentModal\(task\.taskId\)/,
        'expected onShowAgent to open the task-agent modal for task.taskId',
    );
    // No "and does NOT touch [data-agent-stream]" assertion here on
    // purpose: onShowAgent's own comment explains that the inline slot is
    // no longer rendered, so a source scan for that string matches the
    // documentation and fails on correct code. A negative assertion over
    // source text cannot tell a use from a mention.
});

// ---------------------------------------------------------------------------
// AC #4 — View report opens the AP-IFB-007 review-report modal
// ---------------------------------------------------------------------------

test('AC #4 — board.ts wires View report through the review-report modal factory', () => {
    const src = readBoardSource();
    assert.match(
        src,
        /import\s*\{[\s\S]*?createReviewReportModal[\s\S]*?\}\s*from\s*'\.\/client\/modals\/review-report'/,
        'expected board.ts to import createReviewReportModal',
    );
    assert.match(
        src,
        /function openReviewReportForTask\(/,
        'expected an openReviewReportForTask() opener in board.ts',
    );
    const fnMatch = src.match(
        /function openReviewReportForTask\([\s\S]*?\n\}\n/,
    );
    assert.ok(fnMatch, 'openReviewReportForTask body should be readable');
    const body = fnMatch[0];
    assert.match(
        body,
        /getReviewReportModal\(\)/,
        'expected openReviewReportForTask to call getReviewReportModal()',
    );
    assert.match(
        body,
        /handle\.open\(\{[\s\S]*?taskId: task\.taskId/,
        'expected the opener to pass the task id through to the modal',
    );
    assert.match(
        body,
        /investigationReports\.get\(task\.taskId\)/,
        'expected the opener to source report content from the investigationReports map',
    );

    // The lazy modal factory wires both report-action commands.
    const factoryMatch = src.match(
        /function getReviewReportModal\([\s\S]*?\n\}\n/,
    );
    assert.ok(factoryMatch, 'expected a getReviewReportModal() factory');
    const factory = factoryMatch[0];
    assert.match(
        factory,
        /createReviewReportModal\(\{/,
        'expected getReviewReportModal to instantiate the AP-IFB-007 modal',
    );
    assert.match(
        factory,
        /dismissReport[\s\S]*?\/commands\/dismiss-investigation/,
        'expected dismissReport to POST to /commands/dismiss-investigation',
    );
    assert.match(
        factory,
        /implementReport[\s\S]*?\/commands\/implement-from-investigation/,
        'expected implementReport to POST to /commands/implement-from-investigation',
    );
});

// ---------------------------------------------------------------------------
// AC #5 — event delegation, not per-card listeners
// ---------------------------------------------------------------------------

test('AC #5 — one delegated listener dispatches show-agent + view-report', () => {
    const src = readBoardSource();
    // Body-level, not section-level: task cards also render inside the plan
    // modal, an overlay outside any section container, and a section-scoped
    // listener left these two actions dead there.
    assert.match(
        src,
        /const taskActionsRoot = document\.body;/,
        'expected board.ts to delegate task-card actions at body level',
    );
    const listenerMatch = src.match(
        /taskActionsRoot\.addEventListener\('click'[\s\S]*?\n\}\);\n/,
    );
    assert.ok(
        listenerMatch,
        'expected a taskActionsRoot click listener for delegated task-card actions',
    );
    const listener = listenerMatch[0];
    assert.match(
        listener,
        /button\[data-action\]/,
        'expected the delegation to scope to <button data-action> targets',
    );
    assert.match(
        listener,
        /action !== 'show-agent' && action !== 'view-report'/,
        'expected the delegation to filter on show-agent + view-report',
    );
    assert.match(
        listener,
        /\[data-task-card\]/,
        'expected the delegation to walk up to the [data-task-card] ancestor',
    );
    assert.match(
        listener,
        /tasks\.get\(taskId\)/,
        'expected the delegation to resolve the task projection by id',
    );
    assert.match(
        listener,
        /onShowAgent\(task\)/,
        'expected show-agent clicks to dispatch through onShowAgent',
    );
    assert.match(
        listener,
        /openReviewReportForTask\(task\)/,
        'expected view-report clicks to dispatch through openReviewReportForTask',
    );
});

test('AC #5 — per-card listener loop skips show-agent + view-report', () => {
    const src = readBoardSource();
    // The render-time loop attaches per-card click listeners; the new
    // actions must short-circuit that loop so the delegated listener is
    // the only handler.
    const loopMatch = src.match(
        /frag\.querySelectorAll\('button\[data-action\]'\)\.forEach\([\s\S]*?\}\);\n/,
    );
    assert.ok(
        loopMatch,
        'expected the per-card data-action binding loop to still exist',
    );
    const loop = loopMatch[0];
    assert.match(
        loop,
        /action === 'show-agent' \|\| action === 'view-report'/,
        'expected the per-card binding loop to skip the delegated actions',
    );
});

test('AC #5 — followup chip Show agent button has no per-card listener', () => {
    const src = readBoardSource();
    // The followup chip used to addEventListener('click', () => onShowAgent(task))
    // — task-008 removes that so the delegation owns every Show agent click.
    const chipMatch = src.match(
        /function renderFollowupChip\([\s\S]*?\n\}\n/,
    );
    assert.ok(chipMatch, 'expected a renderFollowupChip() function');
    const chip = chipMatch[0];
    // The chip still builds a button with data-action="show-agent" so the
    // delegation can pick it up by class-of-target.
    assert.match(
        chip,
        /showBtn\.setAttribute\('data-action', 'show-agent'\)/,
        'expected the followup chip to keep its data-action="show-agent" button',
    );
    // …but it must NOT register a direct click listener on that button.
    assert.doesNotMatch(
        chip,
        /showBtn\.addEventListener\(/,
        'expected the followup chip to delegate the Show agent click, not '
            + 'register its own listener',
    );
});
