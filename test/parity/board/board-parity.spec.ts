import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';

import { test, expect, type Page, type Response } from '@playwright/test';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

/**
 * Board parity harness — re-pinned by AP-IFV-007.
 *
 * The v2 board (`hosts/board-ui`) has converged on v1's section-list
 * layout (AP-PAO-007 / 008 / 010 / 012). AP-IFV-007 tightens the
 * convergence ceiling from the earlier 5% (loose enough to absorb the
 * v1↔v2 rendering gap) to **1%** and re-pins the baselines under
 * `test/parity/baselines/v1-*.png` against the polished v2 UI itself.
 * The `v1-*` filenames are retained for git-history continuity — the
 * pixels they hold are now v2 captures, not v1 captures.
 *
 * Each baseline corresponds to a per-slug v2 state driven by a
 * different subset of the shared fixture (see `BASELINE_SLUGS` below).
 * Driving distinct v2 states keeps the three baselines meaningfully
 * different rather than three copies of the same screenshot.
 *
 * -----------------------------------------------------------------
 * Baseline capture protocol
 * -----------------------------------------------------------------
 *
 *  - Source          : `hosts/board-ui` at the same commit the spec
 *                      runs against — the spec self-pins, so capture
 *                      and assertion are always against the same v2.
 *  - Fresh state     : the spec boots its OWN stub SSE server that
 *                      replays a synthetic event sequence compiled
 *                      from `board-project.json`. No operator-specific
 *                      projects, no real Linear data, no real DB.
 *  - Viewport size   : 1440 × 1024 (see `VIEWPORT` below). Capture and
 *                      assertion share the viewport so the pixelmatch
 *                      common-box is the full image.
 *  - Browser         : Chromium (Playwright's bundled build), default
 *                      device profile.
 *  - How to capture  : `PARITY_BOARD_UPDATE=1 npm run parity:board` —
 *                      runs this spec in capture mode, which writes
 *                      `v1-<slug>.png` instead of asserting. The
 *                      out-of-band capture entrypoint
 *                      `test/parity/baselines/capture-v1-baselines.ts`
 *                      remains for code-only mode and keeps the same
 *                      slug union (`board` / `plan-card` / `task-card`)
 *                      so parity-smoke can pin the contract without
 *                      booting Playwright.
 *
 * -----------------------------------------------------------------
 * Skip / require semantics for the v1-smoke half of this spec
 * -----------------------------------------------------------------
 *
 *  - `PARITY_BOARD_V1_DIR` unset → v1-smoke SKIPPED (clean default).
 *  - `PARITY_BOARD_REQUIRE_V1=1` + no v1 dir → v1-smoke fails hard.
 *  - `PARITY_BOARD_V1_DIR` set → boots v1 from `<dir>/board` and runs.
 *
 * The screenshot-diff half does NOT need a v1 source checkout because
 * the baseline PNGs are checked-in artefacts.
 */

const VIEWPORT = { width: 1440, height: 1024 } as const;

// ---------- paths ----------

const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'board-project.json');
const V2_BOARD_DIR = path.resolve(__dirname, '..', '..', '..', 'hosts', 'board-ui');
const V1_BASELINES_DIR = path.resolve(__dirname, '..', 'baselines');

/**
 * The slug list this spec pins, as a plain string array. Lives separately
 * from `BASELINE_SLUGS` (the per-slug column-filter definitions) so the
 * parity-smoke board-parity round-trip can pin the slug contract without
 * importing this Playwright-only module — the smoke harness greps for
 * the literal `V1_BASELINE_SLUGS` declaration and confirms it matches
 * the capture script's `Slug` union. Keep this list, `BASELINE_SLUGS`
 * below, and `test/parity/baselines/capture-v1-baselines.ts`'s `Slug`
 * union in lockstep.
 */
const V1_BASELINE_SLUGS: ReadonlyArray<string> = ['board', 'plan-card', 'task-card'];

/**
 * Per-slug baseline definitions. Each slug drives the v2 board into a
 * distinct operator-recognisable state by filtering the shared fixture's
 * task list before compiling the SSE event stream, then pins the
 * resulting screenshot at `test/parity/baselines/v1-<slug>.png`.
 *
 *   - `board`     — every column populated, exercises the full section
 *                   list with multi-task plans.
 *   - `plan-card` — single plan with a small task fan-out, exercises
 *                   plan-card chrome (title row, status label, attention
 *                   marker, multi-task body).
 *   - `task-card` — single in-progress task, exercises task-card chrome
 *                   (chip row, stepper, per-tag affordances).
 *
 * Adding a new operator-recognisable state requires a new entry here
 * (and a re-capture via `PARITY_BOARD_UPDATE=1 npm run parity:board`).
 */
interface BaselineSlug {
    readonly slug: string;
    readonly columns: ReadonlyArray<Column>;
}
const BASELINE_SLUGS: ReadonlyArray<BaselineSlug> = [
    { slug: 'board',     columns: ['created', 'approved', 'in_progress', 'review', 'test', 'commit', 'merge'] },
    { slug: 'plan-card', columns: ['in_progress', 'review', 'commit'] },
    { slug: 'task-card', columns: ['in_progress'] },
];

// Sanity check at module load: V1_BASELINE_SLUGS (pinned by parity-smoke)
// and BASELINE_SLUGS (consumed by the diff loop below) must declare the
// same slug set. A mismatch means one side was edited without the other
// and the parity-smoke contract would silently drift from the runtime
// loop. The runtime check fails loud instead.
{
    const a = new Set<string>(V1_BASELINE_SLUGS);
    const b = new Set<string>(BASELINE_SLUGS.map((s) => s.slug));
    if (a.size !== b.size || ![...a].every((s) => b.has(s))) {
        throw new Error(
            `board-parity.spec.ts: V1_BASELINE_SLUGS [${[...a].join(', ')}] and ` +
                `BASELINE_SLUGS [${[...b].join(', ')}] disagree; keep them in lockstep ` +
                `with capture-v1-baselines.ts's Slug union.`,
        );
    }
}

/**
 * AP-IFV-007 — Tight pixel-diff convergence ceiling: differing-pixels
 * over total-pixels must stay below this ratio per baseline. 0.01 (1 %)
 * is tight enough that any real layout regression trips the assertion
 * while still absorbing the sub-pixel anti-alias jitter Chromium emits
 * between identically-driven renders. Relax to 0.02 if a future browser
 * upgrade pushes the jitter band over 0.01 — document the empirical
 * decision inline if so.
 *
 * Exposed under the name `PIXEL_DIFF_THRESHOLD` so the parity-smoke
 * board-parity round-trip can pin the ceiling without importing this
 * Playwright-only module. The smoke harness greps for
 * `PIXEL_DIFF_THRESHOLD = <number>` and rejects anything above 0.05
 * (AC #2 of AP-PAO-018).
 */
const PIXEL_DIFF_THRESHOLD = 0.01;
const MAX_DIFF_PIXEL_RATIO = PIXEL_DIFF_THRESHOLD;

const V1_DIR_ENV = 'PARITY_BOARD_V1_DIR';
const REQUIRE_V1_ENV = 'PARITY_BOARD_REQUIRE_V1';
const UPDATE_BASELINES_ENV = 'PARITY_BOARD_UPDATE';

// ---------- fixture / event compilation ----------

type Column =
    | 'created'
    | 'approved'
    | 'in_progress'
    | 'review'
    | 'test'
    | 'commit'
    | 'merge';

interface BoardFixture {
    readonly plan: { readonly planId: string; readonly projectId: string; readonly title: string };
    readonly tasks: ReadonlyArray<{
        readonly taskId: string;
        readonly type: string;
        readonly title: string;
        readonly column: Column;
    }>;
}

interface BoardEvent {
    readonly seq: number;
    readonly type: string;
    readonly payload: Record<string, unknown>;
}

const ROLE_BY_COLUMN: Readonly<Partial<Record<Column, string>>> = {
    in_progress: 'developer',
    review: 'reviewer',
    test: 'tester',
    commit: 'committer',
    merge: 'merger',
};

function readFixture(): BoardFixture {
    const raw = fs.readFileSync(FIXTURE_PATH, 'utf8');
    return JSON.parse(raw) as BoardFixture;
}

function compileEvents(fx: BoardFixture, allow?: ReadonlySet<Column>): BoardEvent[] {
    const events: BoardEvent[] = [];
    let seq = 1;
    const push = (type: string, payload: Record<string, unknown>): void => {
        events.push({ seq: seq++, type, payload });
    };

    push('PlanApproved', { planId: fx.plan.planId, projectId: fx.plan.projectId });

    for (const task of fx.tasks) {
        if (allow && !allow.has(task.column)) continue;
        push('TaskCreated', {
            taskId: task.taskId,
            planId: fx.plan.planId,
            type: task.type,
            flowId: task.type,
        });
        if (task.column === 'created') continue;
        push('TaskApproved', { taskId: task.taskId, flowId: task.type });
        if (task.column === 'approved') continue;
        const role = ROLE_BY_COLUMN[task.column];
        if (!role) continue;
        push('AgentStarted', { taskId: task.taskId, agent: role });
    }
    return events;
}

// ---------- per-board static + SSE server ----------

interface BoardServerHandle {
    readonly url: string;
    stop(): Promise<void>;
}

async function startBoardServer(
    boardDir: string,
    events: ReadonlyArray<BoardEvent>,
): Promise<BoardServerHandle> {
    const entry = fs.existsSync(path.join(boardDir, 'index.html'))
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
            for (const ev of events) {
                res.write(`data: ${JSON.stringify(ev)}\n\n`);
            }
            liveResponses.add(res);
            res.on('close', () => liveResponses.delete(res));
            return;
        }

        if (pathname === '/commands') {
            res.writeHead(202, { 'Content-Type': 'application/json' });
            res.end('{}');
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

        const filePath = path.join(boardDir, requested);
        const rel = path.relative(boardDir, filePath);
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
                reject(new Error('startBoardServer: listen returned no address'));
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

// ---------- response assertions ----------

/**
 * Assert that the navigation `Response` returned by `page.goto` is a
 * 200 and that the response body contains the marker substring. AC #5
 * of AP-PAO-018 requires every API call this spec drives to assert
 * **both** status code AND response body — `page.goto` is the only
 * external request the spec issues directly, so this helper centralises
 * the assertion shape.
 */
async function assertOkAndBody(
    response: Response | null,
    label: string,
    bodyMarker: string,
): Promise<void> {
    expect(response, `${label}: page.goto returned no response`).not.toBeNull();
    const status = response!.status();
    expect(status, `${label}: status code`).toBe(200);
    const body = await response!.text();
    expect(
        body.includes(bodyMarker),
        `${label}: body should contain "${bodyMarker}"`,
    ).toBe(true);
}

// ---------- pixel diff helper ----------

interface DiffResult {
    readonly pixels: number;
    readonly total: number;
    readonly ratio: number;
}

/**
 * Pixel-diff `actual` against the PNG at `baselinePath` and return the
 * diff as `{ pixels, total, ratio }`. The common-box trim keeps the
 * comparison defined when a viewport mismatch would otherwise zero out
 * the diff — both this spec and `capture-v1-baselines.ts` capture at
 * the same `VIEWPORT.width × VIEWPORT.height` so the common box is the
 * full image in practice.
 */
function diffAgainstBaseline(actual: Buffer, baselinePath: string): DiffResult {
    const baseline = PNG.sync.read(fs.readFileSync(baselinePath));
    const taken = PNG.sync.read(actual);
    const width = Math.min(baseline.width, taken.width);
    const height = Math.min(baseline.height, taken.height);
    if (width === 0 || height === 0) {
        throw new Error(
            `pixel diff: empty common box for baseline ${baselinePath}`,
        );
    }
    const diff = new PNG({ width, height });
    const pixels = pixelmatch(
        baseline.data,
        taken.data,
        diff.data,
        width,
        height,
        { threshold: 0.1 },
    );
    const total = width * height;
    return { pixels, total, ratio: pixels / total };
}

// ---------- v2 readiness ----------

/**
 * Wait for the v2 section-list shell to be present. AP-PAO-007 replaced
 * the legacy seven-column Kanban with the section-list scaffold; that
 * scaffold renders synchronously from `index.html` so this wait is
 * essentially a "the page loaded" guard rather than a polling loop.
 * No hardcoded delays — the wait resolves the moment the predicate is
 * true and the test fails fast if it isn't true within 10s.
 */
async function waitForV2Shell(page: Page): Promise<void> {
    await page.waitForFunction(
        () => {
            return (
                !!document.querySelector('.sidebar') &&
                !!document.getElementById('overlay-root') &&
                !!document.getElementById('toast-root') &&
                !!document.querySelector('[data-section-list]') &&
                document.querySelectorAll('[data-section]').length >= 5
            );
        },
        undefined,
        { timeout: 10_000 },
    );
}

// ---------- runner guard ----------

/**
 * `@playwright/test`'s `test.describe` throws at module load when the
 * file is imported by a non-Playwright runner. The orchestrator's
 * task-test sweep feeds Playwright specs to `npm test`
 * (`node --test --import tsx`); wrapping `describe` lets that import
 * register zero tests and exit cleanly instead of crashing at load.
 * Only the specific "did not expect test.describe()" message is
 * swallowed — any other error still surfaces.
 */
function describeIfPlaywright(name: string, fn: () => void): void {
    try {
        test.describe(name, fn);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/test\.describe\(\)/.test(msg)) return;
        throw err;
    }
}

// ---------- the tests ----------

const v1Dir = process.env[V1_DIR_ENV];
const requireV1 = process.env[REQUIRE_V1_ENV] === '1';

describeIfPlaywright('board parity', () => {
    /**
     * v1-smoke: the operator pointed `PARITY_BOARD_V1_DIR` at a real
     * v1 board folder. Seeds its own SSE event payload + boots its own
     * static server; tears both down on the way out so the next test
     * starts from a clean slate.
     */
    test('v1 board source is reachable and serves its sidebar shell', async ({
        page,
    }) => {
        test.skip(
            !v1Dir && !requireV1,
            `${V1_DIR_ENV} unset — skipping v1-side smoke (set ${REQUIRE_V1_ENV}=1 to fail instead).`,
        );
        expect(
            v1Dir,
            `${V1_DIR_ENV} must be set (or ${REQUIRE_V1_ENV} cleared) for this test to run`,
        ).toBeTruthy();
        const v1BoardDir = path.join(v1Dir!, 'board');
        expect(
            fs.existsSync(v1BoardDir),
            `v1 board dir not found at ${v1BoardDir}`,
        ).toBe(true);

        const fixture = readFixture();
        const events = compileEvents(fixture);

        await page.setViewportSize({ width: VIEWPORT.width, height: VIEWPORT.height });

        const v1Server = await startBoardServer(v1BoardDir, events);
        try {
            const response = await page.goto(`${v1Server.url}/`, {
                waitUntil: 'domcontentloaded',
            });
            await assertOkAndBody(response, 'v1 board.html', 'sidebar');
            const v1HasSidebar = await page.evaluate(
                () => !!document.querySelector('.sidebar'),
            );
            expect(v1HasSidebar, 'v1 board renders its .sidebar shell').toBe(true);
        } finally {
            await v1Server.stop();
        }
    });

    /**
     * Pixel-diff: per slug, drive the v2 board into a distinct state
     * with a filtered subset of the shared fixture, screenshot the
     * result, and assert the diff ratio against `v1-<slug>.png` is
     * below `MAX_DIFF_PIXEL_RATIO` (1 %). When `PARITY_BOARD_UPDATE=1`
     * is set, the spec writes the screenshots to the baseline paths
     * instead of asserting — that's the re-pin codepath. The baseline
     * PNGs are checked-in artefacts so this test runs without any v1
     * source checkout.
     */
    test('v2 board screenshot converges with every re-pinned baseline within 1% pixel diff', async ({
        page,
    }) => {
        const updateBaselines = process.env[UPDATE_BASELINES_ENV] === '1';
        const fixture = readFixture();

        await page.setViewportSize({ width: VIEWPORT.width, height: VIEWPORT.height });

        // Pre-flight: when asserting (not capturing) every baseline must
        // already exist on disk. The error message points at the capture
        // command so a missing baseline is fixable in one step.
        if (!updateBaselines) {
            for (const { slug } of BASELINE_SLUGS) {
                const baselinePath = path.join(V1_BASELINES_DIR, `v1-${slug}.png`);
                expect(
                    fs.existsSync(baselinePath),
                    `expected baseline at ${baselinePath} — capture with ` +
                        `\`${UPDATE_BASELINES_ENV}=1 npm run parity:board\``,
                ).toBe(true);
            }
        }

        for (const { slug, columns } of BASELINE_SLUGS) {
            const allow = new Set<Column>(columns);
            const events = compileEvents(fixture, allow);
            const v2Server = await startBoardServer(V2_BOARD_DIR, events);
            let v2Screenshot: Buffer;
            try {
                const response = await page.goto(`${v2Server.url}/`, {
                    waitUntil: 'domcontentloaded',
                });
                await assertOkAndBody(response, `v2 index.html (${slug})`, 'section-list');
                await waitForV2Shell(page);
                v2Screenshot = await page.screenshot({ fullPage: false });
            } finally {
                await v2Server.stop();
            }

            const baselinePath = path.join(V1_BASELINES_DIR, `v1-${slug}.png`);
            if (updateBaselines) {
                fs.writeFileSync(baselinePath, v2Screenshot);
                continue;
            }

            const diff = diffAgainstBaseline(v2Screenshot, baselinePath);
            expect(
                diff.ratio,
                `v2 vs baseline "${slug}": diff ratio ${diff.ratio.toFixed(4)} ` +
                    `(${diff.pixels}/${diff.total} px) must be < ${MAX_DIFF_PIXEL_RATIO}`,
            ).toBeLessThan(MAX_DIFF_PIXEL_RATIO);
        }
    });
});
