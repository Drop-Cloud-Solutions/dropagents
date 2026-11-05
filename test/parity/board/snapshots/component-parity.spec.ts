import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';

import { test, expect, type Page } from '@playwright/test';

/**
 * Component snapshot harness (AP-IFV-006).
 *
 * Complements the full-page diff in `../board-parity.spec.ts` by pinning
 * the **per-component** rendering — card chrome at each operator-facing
 * status, the per-task pipeline stepper at each stage, and every modal
 * in its default open state. Where `board-parity.spec.ts` answers
 * "does the whole v2 board converge with v1?", this spec answers "did
 * any specific card / stepper / modal regress?" and gives the operator
 * a precise per-snapshot diff when one did.
 *
 * Setup mirrors `board-parity.spec.ts`:
 *   - boots an isolated 127.0.0.1 static server that serves the
 *     hosts/board-ui/ assets (index.html, board.css, board.js) plus a
 *     no-op SSE `/events` stream and a 202 `/commands` POST sink. No
 *     live worker / Linear / database is touched.
 *   - loads index.html at viewport 1440×1024 (same as the page-parity
 *     spec so chrome geometry stays comparable between the two harnesses).
 *   - per test, `page.evaluate(...)` reaches into the page, wipes the
 *     `<main>` body, mounts a single component built from a synthetic
 *     project fixture, then `expect(locator).toHaveScreenshot(...)`
 *     pins the resulting pixels.
 *
 * Tolerance — `MAX_DIFF_PIXEL_RATIO = 0.005` (0.5 %). Tight enough that
 * a real layout regression trips the assertion; loose enough to absorb
 * anti-alias / sub-pixel jitter between captures on the same browser.
 *
 * Baselines live alongside this file under
 * `component-parity.spec.ts-snapshots/<test-slug>-chromium.png`
 * (Playwright's default `pathTemplate`) so they are automatically
 * placed under `test/parity/board/snapshots/`. Generate / refresh
 * with:
 *
 *     npx playwright test \
 *       --config=test/parity/board/playwright.config.ts \
 *       --update-snapshots \
 *       test/parity/board/snapshots/component-parity.spec.ts
 *
 * Module-load guard — `describeIfPlaywright` mirrors the existing
 * board-parity spec. `npm test` runs `node --test --import tsx` which
 * also imports `.spec.ts` files; `@playwright/test`'s `test.describe`
 * throws at module load when imported by a non-Playwright runner. The
 * guard swallows that one specific error so this file registers zero
 * tests under `node --test` and lets the runner exit cleanly (AC #6).
 */

// ---------- viewport / tolerance --------------------------------------

const VIEWPORT = { width: 1440, height: 1024 } as const;
const MAX_DIFF_PIXEL_RATIO = 0.005;

// ---------- repo paths -------------------------------------------------

const BOARD_UI_DIR = path.resolve(
    __dirname,
    '..',
    '..',
    '..',
    '..',
    'hosts',
    'board-ui',
);

// ---------- static / SSE / commands server ----------------------------
//
// Vendored from `board-parity.spec.ts` — same minimal HTTP stub but with
// the SSE stream collapsed to an "open and idle" handler since the
// per-component tests mount their fixtures via `page.evaluate` rather
// than by replaying a domain-event sequence. The board.js bundle still
// needs `/events` to respond (otherwise it logs to the console and
// retries forever) and `/commands` to 202 (otherwise any action-button
// click that survives `evaluate` errors out).

interface SnapshotServerHandle {
    readonly url: string;
    stop(): Promise<void>;
}

async function startSnapshotServer(): Promise<SnapshotServerHandle> {
    const entry = fs.existsSync(path.join(BOARD_UI_DIR, 'index.html'))
        ? 'index.html'
        : 'board.html';
    const allowed = new Set([entry, 'board.js', 'board.css']);
    const liveResponses = new Set<http.ServerResponse>();

    const server = http.createServer((req, res) => {
        const pathname = (req.url ?? '/').split('?', 1)[0];

        if (pathname === '/events') {
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                Connection: 'keep-alive',
            });
            res.write(': snapshot-harness — no events\n\n');
            liveResponses.add(res);
            res.on('close', () => liveResponses.delete(res));
            return;
        }

        if (pathname === '/commands') {
            res.writeHead(202, { 'Content-Type': 'application/json' });
            res.end('{}');
            return;
        }

        // The board.js bundle hits `/api/projects` on startup. Return an
        // empty list so the sidebar renders its empty-state shell rather
        // than spinning on a pending fetch.
        if (pathname === '/api/projects') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('[]');
            return;
        }

        if (pathname === '/context-updates/pending') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('[]');
            return;
        }

        if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.writeHead(405);
            res.end();
            return;
        }

        const requested = pathname === '/' ? entry : pathname.replace(/^\/+/, '');
        if (!allowed.has(requested)) {
            res.writeHead(404);
            res.end();
            return;
        }

        const filePath = path.join(BOARD_UI_DIR, requested);
        const rel = path.relative(BOARD_UI_DIR, filePath);
        if (rel.startsWith('..') || path.isAbsolute(rel)) {
            res.writeHead(404);
            res.end();
            return;
        }

        fs.readFile(filePath, (err, data) => {
            if (err) {
                res.writeHead(404);
                res.end();
                return;
            }
            const ext = path.extname(requested).toLowerCase();
            const ct =
                ext === '.html'
                    ? 'text/html; charset=utf-8'
                    : ext === '.js'
                      ? 'application/javascript; charset=utf-8'
                      : ext === '.css'
                        ? 'text/css; charset=utf-8'
                        : 'application/octet-stream';
            res.writeHead(200, { 'Content-Type': ct });
            res.end(data);
        });
    });

    const port = await new Promise<number>((resolve, reject) => {
        const onError = (err: Error): void => reject(err);
        server.once('error', onError);
        server.listen(0, '127.0.0.1', () => {
            server.removeListener('error', onError);
            const addr = server.address();
            if (!addr || typeof addr === 'string') {
                reject(new Error('startSnapshotServer: listen returned no address'));
                return;
            }
            resolve(addr.port);
        });
    });

    return {
        url: `http://127.0.0.1:${port}`,
        async stop(): Promise<void> {
            for (const res of liveResponses) {
                try {
                    res.end();
                    res.destroy();
                } catch {
                    /* already closed */
                }
            }
            liveResponses.clear();
            const closeAll = (
                server as { closeAllConnections?: () => void }
            ).closeAllConnections;
            if (typeof closeAll === 'function') {
                closeAll.call(server);
            }
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
}

// ---------- runner guard ----------------------------------------------

function describeIfPlaywright(name: string, fn: () => void): void {
    try {
        test.describe(name, fn);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/test\.describe\(\)/.test(msg)) return;
        throw err;
    }
}

// ---------- synthetic project fixture ---------------------------------
//
// One synthetic plan + one task per snapshot dimension. Kept inline (and
// stringified into page.evaluate calls) so the spec is self-contained
// per the AP-IFV-006 brief — "Files to create" lists only this spec.

interface SyntheticTask {
    readonly taskId: string;
    readonly title: string;
    readonly type: string;
    readonly planId: string;
    /** human-status the card should advertise (drives the column placement + tag chip). */
    readonly status: string;
    /** Parked reason / question when the card is in an attention state. */
    readonly parkedReason?: 'clarification' | 'approval' | 'wait-action' | 'wait-merged';
    readonly parkedQuestion?: string;
    /** Failed stage when the status is failed:<stage>. */
    readonly failedStage?: 'dev' | 'review' | 'test' | 'commit';
}

// Card statuses enumerated by the AP-IFV-006 brief. Each entry resolves
// to one screenshot under
// `component-parity.spec.ts-snapshots/card-<slug>-chromium.png`.
const CARD_STATUSES: ReadonlyArray<SyntheticTask> = [
    {
        taskId: 'T-CREATED',
        title: 'Synthetic created task',
        type: 'implement',
        planId: 'demo-plan',
        status: 'created',
    },
    {
        taskId: 'T-INPROG',
        title: 'Synthetic in-progress task',
        type: 'implement',
        planId: 'demo-plan',
        status: 'in_progress',
    },
    {
        taskId: 'T-REVIEW',
        title: 'Synthetic ready-for-review task',
        type: 'implement',
        planId: 'demo-plan',
        status: 'ready_for_review',
    },
    {
        taskId: 'T-COMMIT',
        title: 'Synthetic ready-to-commit task',
        type: 'implement',
        planId: 'demo-plan',
        status: 'ready_to_commit',
    },
    {
        taskId: 'T-ACTION',
        title: 'Synthetic ready-for-action task',
        type: 'implement',
        planId: 'demo-plan',
        status: 'ready_for_action',
        parkedReason: 'wait-action',
    },
    {
        taskId: 'T-MERGE',
        title: 'Synthetic ready-to-merge task',
        type: 'implement',
        planId: 'demo-plan',
        status: 'ready_to_merge',
    },
    {
        taskId: 'T-CLARIFY',
        title: 'Synthetic awaiting-clarification task',
        type: 'implement',
        planId: 'demo-plan',
        status: 'awaiting_clarification',
        parkedReason: 'clarification',
        parkedQuestion: 'Which provider should we default to?',
    },
    {
        taskId: 'T-FAIL-DEV',
        title: 'Synthetic failed:dev task',
        type: 'implement',
        planId: 'demo-plan',
        status: 'failed',
        failedStage: 'dev',
    },
    {
        taskId: 'T-FAIL-REV',
        title: 'Synthetic failed:review task',
        type: 'implement',
        planId: 'demo-plan',
        status: 'failed',
        failedStage: 'review',
    },
    {
        taskId: 'T-FAIL-TEST',
        title: 'Synthetic failed:test task',
        type: 'implement',
        planId: 'demo-plan',
        status: 'failed',
        failedStage: 'test',
    },
    {
        taskId: 'T-FAIL-COMMIT',
        title: 'Synthetic failed:commit task',
        type: 'implement',
        planId: 'demo-plan',
        status: 'failed',
        failedStage: 'commit',
    },
];

// One screenshot per pipeline stage carrying the `active` highlight, plus
// an `all-done` and a `failed:test` variant so the spec covers every
// `stage-cell--<state>` style the stepper module emits.
interface StepperSnapshot {
    readonly slug: string;
    /** dev/review/test/commit/investigator + their state. */
    readonly states: Readonly<Record<string, 'pending' | 'active' | 'done' | 'failed' | 'skipped'>>;
    readonly taskType: 'implement' | 'integration-test' | 'investigate';
}
const STEPPER_STAGES: ReadonlyArray<StepperSnapshot> = [
    {
        slug: 'dev-active',
        taskType: 'implement',
        states: { dev: 'active', review: 'pending', test: 'pending', commit: 'pending' },
    },
    {
        slug: 'review-active',
        taskType: 'implement',
        states: { dev: 'done', review: 'active', test: 'pending', commit: 'pending' },
    },
    {
        slug: 'test-active',
        taskType: 'implement',
        states: { dev: 'done', review: 'done', test: 'active', commit: 'pending' },
    },
    {
        slug: 'commit-active',
        taskType: 'implement',
        states: { dev: 'done', review: 'done', test: 'done', commit: 'active' },
    },
    {
        slug: 'all-done',
        taskType: 'implement',
        states: { dev: 'done', review: 'done', test: 'done', commit: 'done' },
    },
    {
        slug: 'failed-test',
        taskType: 'implement',
        states: { dev: 'done', review: 'done', test: 'failed', commit: 'pending' },
    },
    {
        slug: 'investigator-active',
        taskType: 'investigate',
        states: {
            dev: 'skipped',
            review: 'skipped',
            test: 'skipped',
            commit: 'skipped',
            investigator: 'active',
        },
    },
];

// Modal kinds covered by the AP-IFV-006 brief. The DOM mirrors the
// modal modules under `hosts/board-ui/client/modals/` and
// `hosts/board-ui/modals/` — the same overlay+panel chrome that each
// module produces at runtime, with the modal-specific body filled in
// so the snapshot pins the full default-open render rather than just
// the shared `.modal-chrome` rails.
interface ModalSnapshot {
    readonly slug: string;
    readonly overlayClass: string;
    readonly panelClass: string;
    readonly title: string;
    /** Body builder — receives a `body` element to populate inside the panel. */
    readonly body: string;
    /** Footer button labels — rendered in the standard right-aligned row. */
    readonly buttons: ReadonlyArray<string>;
    /** Optional extra width modifier (e.g. `modal--diff-review`). */
    readonly extraPanelClass?: string;
}

const TEXTAREA_PLACEHOLDER = 'Type your answer here…';
const MODALS: ReadonlyArray<ModalSnapshot> = [
    {
        slug: 'clarify',
        overlayClass: 'overlay clarify-overlay modal-chrome__overlay',
        panelClass: 'panel clarify-panel modal-chrome',
        title: 'Clarification needed',
        body: `
            <p class="clarify-question">Which provider should we default to?</p>
            <textarea class="clarify-answer modal-textarea" rows="5"
                placeholder="${TEXTAREA_PLACEHOLDER}"></textarea>
            <label class="clarify-remember">
                <input type="checkbox" />
                <span class="clarify-remember-label">Remember this decision</span>
            </label>
        `,
        buttons: ['Cancel', 'Submit'],
    },
    {
        slug: 'reject',
        overlayClass: 'overlay reject-overlay modal-chrome__overlay',
        panelClass: 'overlay-panel reject-panel modal-chrome',
        title: 'Reject plan',
        body: `
            <label class="modal-label" for="reject-reason">Reason</label>
            <textarea id="reject-reason" class="reject-reason modal-textarea"
                rows="6" placeholder="Why is this being rejected?"></textarea>
        `,
        buttons: ['Cancel', 'Reject'],
    },
    {
        slug: 'reject-feedback',
        overlayClass: 'overlay reject-feedback-overlay modal-chrome__overlay',
        panelClass: 'panel reject-feedback-panel modal-chrome',
        title: 'Send feedback',
        body: `
            <p class="modal-message">Tell the agent what to fix before retrying.</p>
            <textarea class="reject-feedback-text modal-textarea" rows="6"
                placeholder="Feedback for the agent…"></textarea>
        `,
        buttons: ['Cancel', 'Send feedback'],
    },
    {
        slug: 'diff-review',
        overlayClass: 'overlay diff-review-overlay modal-chrome__overlay',
        panelClass: 'modal modal--diff-review modal-chrome',
        title: 'Review diff',
        body: `
            <pre class="diff-review-body" data-testid="diff-review-body">--- a/example.ts
+++ b/example.ts
@@ -1,3 +1,4 @@
 export function add(a: number, b: number): number {
-    return a + b;
+    // AP-IFV-006 — example diff for snapshot.
+    return a + b + 0;
 }</pre>
        `,
        buttons: ['Close', 'Reject', 'Approve'],
    },
    {
        slug: 'interrupt-retry',
        overlayClass: 'overlay interrupt-retry-overlay modal-chrome__overlay',
        panelClass: 'modal modal--interrupt-retry modal-chrome',
        title: 'Interrupt & retry',
        body: `
            <p class="modal-message">
                Stop the current agent and restart this task with new guidance?
            </p>
            <label class="modal-label" for="interrupt-feedback">Feedback (optional)</label>
            <textarea id="interrupt-feedback" class="interrupt-feedback modal-textarea"
                rows="5" placeholder="What should the agent do differently?"></textarea>
        `,
        buttons: ['Cancel', 'Interrupt & retry'],
    },
    {
        slug: 'investigate',
        overlayClass: 'overlay investigate-overlay modal-chrome__overlay',
        panelClass: 'modal modal--investigate modal-chrome',
        title: 'Start investigation',
        body: `
            <label class="modal-label" for="invest-question">Question</label>
            <textarea id="invest-question" class="investigate-question modal-textarea"
                rows="5" placeholder="What should the investigator look into?"></textarea>
        `,
        buttons: ['Cancel', 'Start investigation'],
    },
    {
        slug: 'investigation-followup',
        overlayClass: 'overlay followup-overlay modal-chrome__overlay',
        panelClass: 'panel followup-panel modal-chrome',
        title: 'Ask a follow-up',
        body: `
            <p class="modal-message">
                Send a follow-up question to the investigator.
            </p>
            <textarea class="followup-question modal-textarea" rows="5"
                placeholder="Type your follow-up…"></textarea>
        `,
        buttons: ['Cancel', 'Ask'],
    },
    {
        slug: 'review-report',
        overlayClass: 'overlay review-report-overlay modal-chrome__overlay',
        panelClass: 'modal modal--review-report modal-chrome',
        title: 'Review report',
        body: `
            <pre class="rr-report-content">
Reviewer notes
==============

* All ACs satisfied
* Minor: prefer const-assertions on the COLUMN tuple
* No regressions vs the previous baseline
            </pre>
            <textarea class="rr-reason modal-textarea" rows="4"
                placeholder="Dismiss reason (optional)"></textarea>
        `,
        buttons: ['Close', 'Dismiss', 'Implement'],
    },
    {
        slug: 'worker-log',
        overlayClass: 'overlay worker-log-overlay modal-chrome__overlay',
        panelClass: 'modal modal--worker-log modal-chrome',
        title: 'Worker log',
        body: `
            <pre class="worker-log-body" data-testid="worker-log-body">[2026-05-18T10:00:00.000Z] orchestrator: started
[2026-05-18T10:00:01.234Z] worker-api: listening on :4101
[2026-05-18T10:00:02.345Z] tracker: bootstrap complete (12 plans, 47 tasks)
[2026-05-18T10:00:03.456Z] chat-bot: telegram poller paused (no token)</pre>
        `,
        buttons: ['Close'],
    },
    {
        slug: 'notes-modal',
        overlayClass: 'overlay notes-overlay modal-chrome__overlay',
        panelClass: 'modal modal--notes modal-chrome',
        title: 'Project notes',
        body: `
            <textarea class="notes-textarea modal-textarea" rows="10"
                placeholder="Notes for this project…">Synthetic project notes for AP-IFV-006 snapshot.</textarea>
        `,
        buttons: ['Cancel', 'Save'],
    },
    {
        slug: 'new-project',
        overlayClass: 'overlay new-project-overlay modal-chrome__overlay',
        panelClass: 'modal modal--new-project modal-chrome',
        title: 'New project',
        body: `
            <div class="form-row">
                <label class="form-label">Project title</label>
                <input type="text" placeholder="e.g. Shop" />
                <input type="text" placeholder="LDP" maxlength="4" />
            </div>
            <div class="form-row">
                <label class="form-label">Project ID (slug)</label>
                <input type="text" placeholder="shop" />
            </div>
            <div class="form-row">
                <label class="form-label">Description</label>
                <textarea placeholder="Brief description of the project"></textarea>
            </div>
            <div class="form-row">
                <label class="form-label">Color</label>
                <div class="color-swatches" role="radiogroup" aria-label="Project color">
                    <button type="button" class="color-swatch" style="background:#7c6af7"></button>
                    <button type="button" class="color-swatch" style="background:#38bdf8"></button>
                    <button type="button" class="color-swatch" style="background:#34d399"></button>
                    <button type="button" class="color-swatch" style="background:#fbbf24"></button>
                    <button type="button" class="color-swatch" style="background:#f87171"></button>
                    <button type="button" class="color-swatch" style="background:#c084fc"></button>
                    <button type="button" class="color-swatch" style="background:#fb923c"></button>
                </div>
            </div>
        `,
        buttons: ['Cancel', 'Create project'],
    },
    {
        slug: 'edit-project',
        overlayClass: 'overlay edit-project-overlay modal-chrome__overlay',
        panelClass: 'modal modal--edit-project modal-chrome',
        title: 'Edit project',
        body: `
            <div class="form-row">
                <label class="form-label">Project title</label>
                <input type="text" value="Pipeline Bot" />
                <input type="text" value="DCP" maxlength="4" />
            </div>
            <div class="form-row">
                <label class="form-label">Project ID (slug)</label>
                <input type="text" value="ai-pipeline" />
            </div>
            <div class="form-row">
                <label class="form-label">Description</label>
                <textarea>Multi-agent development pipeline.</textarea>
            </div>
            <div class="form-row">
                <label class="form-label">Color</label>
                <div class="color-swatches" role="radiogroup" aria-label="Project color">
                    <button type="button" class="color-swatch" style="background:#7c6af7"></button>
                    <button type="button" class="color-swatch" style="background:#38bdf8"></button>
                </div>
            </div>
        `,
        buttons: ['Cancel', 'Save changes'],
    },
    {
        slug: 'new-plan',
        overlayClass: 'overlay new-plan-overlay modal-chrome__overlay',
        panelClass: 'modal modal--new-plan modal-chrome',
        title: 'New plan',
        body: `
            <div class="form-row">
                <label class="form-label">Plan title</label>
                <input type="text" placeholder="One-line description of the plan" />
            </div>
            <div class="form-row">
                <label class="form-label">Goal</label>
                <textarea placeholder="What is this plan trying to achieve?" rows="5"></textarea>
            </div>
            <div class="form-row">
                <label class="form-label">Constraints (optional)</label>
                <textarea placeholder="Anything the planner should avoid?" rows="3"></textarea>
            </div>
        `,
        buttons: ['Cancel', 'Create plan'],
    },
];

// Notes panel (not a modal but covered by the brief). Rendered as a
// side panel rather than an overlay; same chrome rails minus the
// backdrop blur.
const NOTES_PANEL: ModalSnapshot = {
    slug: 'notes-panel',
    overlayClass: 'overlay notes-panel-overlay modal-chrome__overlay',
    panelClass: 'panel notes-panel modal-chrome',
    title: 'Notes',
    body: `
        <ul class="notes-list">
            <li class="notes-entry">
                <header class="notes-entry-header">
                    <span class="notes-entry-author">operator</span>
                    <span class="notes-entry-time">10:23</span>
                </header>
                <p class="notes-entry-body">Keep the stepper visible while the agent is working.</p>
            </li>
            <li class="notes-entry">
                <header class="notes-entry-header">
                    <span class="notes-entry-author">reviewer</span>
                    <span class="notes-entry-time">10:31</span>
                </header>
                <p class="notes-entry-body">Approved; minor lint fix only.</p>
            </li>
        </ul>
        <textarea class="notes-input modal-textarea" rows="3"
            placeholder="Add a note…"></textarea>
    `,
    buttons: ['Close', 'Post note'],
};

// ---------- in-page mount helpers (executed via page.evaluate) --------

/**
 * `mountSnapshotShell` clears the board chrome and installs a fresh
 * `[data-snapshot-root]` container the per-component mount helpers
 * write into. Each test calls this first so a previous snapshot's DOM
 * can never leak into the next capture.
 */
async function mountSnapshotShell(page: Page): Promise<void> {
    await page.evaluate(() => {
        const overlayRoot = document.getElementById('overlay-root');
        if (overlayRoot) overlayRoot.replaceChildren();
        const toastRoot = document.getElementById('toast-root');
        if (toastRoot) toastRoot.replaceChildren();
        const main = document.querySelector('main.main');
        if (!main) throw new Error('snapshot-harness: missing main shell');
        main.replaceChildren();
        const root = document.createElement('div');
        root.setAttribute('data-snapshot-root', '');
        root.style.padding = '24px';
        root.style.background = 'var(--bg)';
        main.appendChild(root);
    });
}

/**
 * Mount a single task card built from the synthetic fixture, clone the
 * shared `#task-card-template`, then populate the slots `board.ts`
 * usually fills. Status drives a `data-task-status` attribute on the
 * card so per-status CSS hooks (chips, accent colours) apply identically
 * to the live render path.
 */
async function mountCard(page: Page, task: SyntheticTask): Promise<void> {
    await page.evaluate((t) => {
        const root = document.querySelector('[data-snapshot-root]');
        if (!root) throw new Error('snapshot-harness: snapshot root missing');
        const tmpl = document.getElementById('task-card-template') as HTMLTemplateElement | null;
        if (!tmpl) throw new Error('snapshot-harness: task-card-template missing');
        const frag = tmpl.content.cloneNode(true) as DocumentFragment;
        const card = frag.querySelector('[data-task-card]') as HTMLElement | null;
        if (!card) throw new Error('snapshot-harness: card root missing in template');
        card.setAttribute('data-task-status', t.status);
        if (t.failedStage) card.setAttribute('data-failed-stage', t.failedStage);
        if (t.parkedReason) {
            card.classList.add('parked');
            card.classList.add(`parked--${t.parkedReason}`);
        }
        const set = (sel: string, text: string): void => {
            const el = frag.querySelector(sel) as HTMLElement | null;
            if (el) el.textContent = text;
        };
        set('[data-task-id]', t.taskId);
        set('[data-task-type]', t.type);
        set('[data-task-plan]', t.planId);
        set('[data-task-title]', t.title);
        const parkedChip = frag.querySelector('[data-parked-chip]') as HTMLElement | null;
        if (parkedChip && t.parkedReason) {
            parkedChip.hidden = false;
            parkedChip.className = `parked-chip parked-chip--${t.parkedReason}`;
            parkedChip.textContent =
                t.parkedReason === 'clarification' ? 'Needs answer'
                : t.parkedReason === 'wait-action' ? 'Awaiting action'
                : t.parkedReason === 'wait-merged' ? 'Awaiting merge'
                : 'Parked';
            if (t.parkedQuestion) parkedChip.title = t.parkedQuestion;
        }
        const stageBar = frag.querySelector('[data-stage-bar]') as HTMLElement | null;
        if (stageBar) {
            const stages: ReadonlyArray<{ id: string; label: string; state: string }> = [
                { id: 'dev', label: 'Developer', state: t.failedStage === 'dev' ? 'failed' : (t.status === 'in_progress' ? 'active' : 'done') },
                { id: 'review', label: 'Reviewer', state: t.failedStage === 'review' ? 'failed' : (t.status === 'ready_for_review' ? 'active' : (t.status === 'created' || t.status === 'in_progress' ? 'pending' : 'done')) },
                { id: 'test', label: 'Tester', state: t.failedStage === 'test' ? 'failed' : (['ready_to_commit', 'ready_for_action', 'ready_to_merge'].includes(t.status) ? 'done' : 'pending') },
                { id: 'commit', label: 'Commit', state: t.failedStage === 'commit' ? 'failed' : (t.status === 'ready_to_commit' ? 'active' : (['ready_for_action', 'ready_to_merge'].includes(t.status) ? 'done' : 'pending')) },
            ];
            for (const s of stages) {
                const li = document.createElement('li');
                li.className = `stage-cell stage-cell--${s.state}`;
                li.setAttribute('data-stage', s.id);
                li.setAttribute('data-state', s.state);
                li.title = s.label;
                li.textContent = s.label;
                stageBar.appendChild(li);
            }
        }
        root.appendChild(frag);
    }, task);
}

/**
 * Mount a standalone stepper (no surrounding card chrome) so the
 * snapshot pins the stepper's own per-state styling — `stage-cell--active`,
 * `stage-cell--done`, `stage-cell--failed`, `stage-cell--skipped` — in
 * isolation from card-level layout.
 */
async function mountStepper(page: Page, snap: StepperSnapshot): Promise<void> {
    await page.evaluate((s) => {
        const root = document.querySelector('[data-snapshot-root]');
        if (!root) throw new Error('snapshot-harness: snapshot root missing');
        const wrap = document.createElement('div');
        wrap.className = 'task-card snapshot-stepper-host';
        wrap.style.maxWidth = '480px';
        wrap.style.padding = '16px';
        wrap.style.background = 'var(--bg2)';
        wrap.style.border = '1px solid var(--border)';
        wrap.style.borderRadius = '8px';
        const ol = document.createElement('ol');
        ol.className = 'stage-bar';
        ol.setAttribute('data-stage-bar', '');
        ol.setAttribute('aria-label', 'Pipeline stage');
        if (s.taskType) ol.setAttribute('data-task-type', s.taskType);
        const labels: Record<string, string> = {
            dev: 'Developer',
            review: 'Reviewer',
            test: 'Tester',
            commit: 'Commit',
            investigator: 'Investigator',
        };
        const order = s.taskType === 'investigate'
            ? ['investigator']
            : ['dev', 'review', 'test', 'commit'];
        for (const id of order) {
            const state = s.states[id] ?? 'pending';
            const li = document.createElement('li');
            li.className = `stage-cell stage-cell--${state}`;
            li.setAttribute('data-stage', id);
            li.setAttribute('data-state', state);
            li.title = labels[id] ?? id;
            li.textContent = labels[id] ?? id;
            ol.appendChild(li);
        }
        wrap.appendChild(ol);
        root.appendChild(wrap);
    }, snap);
}

/**
 * Mount a modal default-open render. The overlay+panel chrome mirrors
 * the runtime module's class composition (see the `MODALS` table for
 * the per-modal overlay / panel class strings); the body html is
 * trusted because every entry is authored in this file. The mount
 * lives inside the snapshot root rather than `#overlay-root` so the
 * screenshot frame is the panel itself — that keeps the diff scoped to
 * the modal's rendering and ignores the full-viewport backdrop.
 */
async function mountModal(page: Page, m: ModalSnapshot): Promise<void> {
    await page.evaluate((modal) => {
        const root = document.querySelector('[data-snapshot-root]');
        if (!root) throw new Error('snapshot-harness: snapshot root missing');
        const overlay = document.createElement('div');
        overlay.className = modal.overlayClass;
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');
        overlay.setAttribute('data-snapshot-modal', modal.slug);
        // Force the overlay to a constrained box (rather than fixed/inset:0)
        // so the screenshot frame doesn't bleed across the viewport.
        overlay.style.position = 'static';
        overlay.style.display = 'flex';
        overlay.style.alignItems = 'center';
        overlay.style.justifyContent = 'center';
        overlay.style.padding = '24px';

        const panel = document.createElement('div');
        panel.className = modal.panelClass + (modal.extraPanelClass ? ' ' + modal.extraPanelClass : '');
        panel.style.maxHeight = 'none';

        const header = document.createElement('header');
        header.className = 'modal-chrome__header';
        const title = document.createElement('h3');
        title.className = 'modal-chrome__title';
        title.textContent = modal.title;
        header.appendChild(title);
        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.className = 'modal-chrome__close';
        closeBtn.setAttribute('aria-label', 'Close');
        closeBtn.textContent = '×';
        header.appendChild(closeBtn);
        panel.appendChild(header);

        const body = document.createElement('div');
        body.className = 'modal-chrome__body modal-body';
        body.innerHTML = modal.body;
        panel.appendChild(body);

        const footer = document.createElement('footer');
        footer.className = 'modal-chrome__footer';
        for (let i = 0; i < modal.buttons.length; i++) {
            const btn = document.createElement('button');
            btn.type = 'button';
            // First button is the secondary action (Cancel / Close); last
            // is the primary action. Matches the v1 button-row convention.
            btn.className = i === modal.buttons.length - 1
                ? 'btn btn-approve'
                : 'btn btn-skip';
            btn.textContent = modal.buttons[i];
            footer.appendChild(btn);
        }
        panel.appendChild(footer);

        overlay.appendChild(panel);
        root.appendChild(overlay);
    }, m);
}

// ---------- shell readiness -------------------------------------------

async function waitForShell(page: Page): Promise<void> {
    await page.waitForFunction(
        () => !!document.querySelector('main.main')
            && !!document.getElementById('overlay-root')
            && !!document.getElementById('task-card-template'),
        undefined,
        { timeout: 10_000 },
    );
}

// ---------- the tests -------------------------------------------------

describeIfPlaywright('component snapshot harness (AP-IFV-006)', () => {
    let server: SnapshotServerHandle | null = null;

    test.beforeAll(async () => {
        server = await startSnapshotServer();
    });
    test.afterAll(async () => {
        if (server) await server.stop();
        server = null;
    });

    test.beforeEach(async ({ page }) => {
        if (!server) throw new Error('snapshot-harness: server not started');
        await page.setViewportSize({ width: VIEWPORT.width, height: VIEWPORT.height });
        const response = await page.goto(`${server.url}/`, {
            waitUntil: 'domcontentloaded',
        });
        expect(response, 'page.goto returned no response').not.toBeNull();
        expect(response!.status(), 'index.html status').toBe(200);
        await waitForShell(page);
        await mountSnapshotShell(page);
    });

    for (const task of CARD_STATUSES) {
        const slug = task.failedStage
            ? `card-failed-${task.failedStage}`
            : `card-${task.status.replace(/_/g, '-')}`;
        test(`card snapshot — ${slug}`, async ({ page }) => {
            await mountCard(page, task);
            const card = page.locator('[data-task-card]');
            await expect(card).toBeVisible();
            await expect(card).toHaveScreenshot(`${slug}.png`, {
                maxDiffPixelRatio: MAX_DIFF_PIXEL_RATIO,
            });
        });
    }

    for (const snap of STEPPER_STAGES) {
        test(`stepper snapshot — ${snap.slug}`, async ({ page }) => {
            await mountStepper(page, snap);
            const stepper = page.locator('.snapshot-stepper-host');
            await expect(stepper).toBeVisible();
            await expect(stepper).toHaveScreenshot(`stepper-${snap.slug}.png`, {
                maxDiffPixelRatio: MAX_DIFF_PIXEL_RATIO,
            });
        });
    }

    for (const modal of [...MODALS, NOTES_PANEL]) {
        test(`modal snapshot — ${modal.slug}`, async ({ page }) => {
            await mountModal(page, modal);
            const panel = page.locator(`[data-snapshot-modal="${modal.slug}"] .modal-chrome`);
            await expect(panel).toBeVisible();
            await expect(panel).toHaveScreenshot(`modal-${modal.slug}.png`, {
                maxDiffPixelRatio: MAX_DIFF_PIXEL_RATIO,
            });
        });
    }
});
