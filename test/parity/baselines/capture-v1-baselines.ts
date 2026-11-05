/* eslint-disable no-console */
/**
 * Re-pin helper for the v1 board screenshot baselines consumed by
 * `test/parity/board/board-parity.spec.ts` (AP-PAO-018).
 *
 * The spec drives the v2 board (`hosts/board-ui`) at viewport
 * 1440 × 1024 and asserts a pixel-diff ratio below 5% against each
 * baseline. To stay reproducible, this script captures every PNG from
 * a stub v1 board boot — no operator-specific projects, no real Linear
 * data, no real DB. The full protocol (v1 commit SHA, viewport, etc.)
 * is documented at the top of the spec file; keep these two in sync.
 *
 * Three operator-recognisable v1 states are pinned:
 *
 *   - `v1-board.png`     — populated project with several plans + tasks
 *                          spread across the section list. Exercises the
 *                          overall board chrome.
 *   - `v1-plan-card.png` — single plan section in focus, exercising the
 *                          plan-card chrome (plan title, status label,
 *                          attention marker, multi-task body).
 *   - `v1-task-card.png` — single in-progress task in focus, exercising
 *                          task-card chrome (multi-tag chip row, stepper,
 *                          per-tag action affordances).
 *
 * Boot model:
 *   - Stub HTTP server serves the v1 board's `board.html` / `board.css`
 *     / `board.js` from a sibling `<repo-parent>/pipeline/board`
 *     checkout (override with `PARITY_V1_DIR=<repo-parent>`).
 *   - Three GET endpoints v1's `loadAll` relies on are stubbed:
 *       - GET /api/workflows           → minimal workflow registry
 *       - GET /api/projects            → slug-specific fixture
 *       - GET /context-updates/pending → []
 *   - `setSlug()` swaps the active fixture before Playwright navigates,
 *     so each PNG sees a fresh `/api/projects` payload.
 */

import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';

import { chromium, type Page } from 'playwright';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const DEFAULT_V1_DIR = process.env.PARITY_V1_DIR ?? path.resolve(
    REPO_ROOT,
    '..',
    'pipeline',
);
const V1_BOARD_DIR = path.join(DEFAULT_V1_DIR, 'board');
const OUT_DIR = __dirname;
const VIEWPORT = { width: 1440, height: 1024 } as const;

type Slug = 'board' | 'plan-card' | 'task-card';

interface Fixture {
    readonly projects: ReadonlyArray<unknown>;
}

const WORKFLOWS = {
    workflows: {
        scaffold: {
            id: 'scaffold',
            steps: [
                { id: 'approve', kind: 'approval', approvalBefore: true },
                { id: 'develop', kind: 'agent', agentRole: 'developer' },
                { id: 'review', kind: 'agent', agentRole: 'reviewer' },
                { id: 'test', kind: 'agent', agentRole: 'tester' },
                { id: 'approve-commit', kind: 'approval', approvalBefore: true },
                { id: 'commit', kind: 'auto-commit' },
                { id: 'merge', kind: 'wait-merged' },
            ],
        },
        implement: {
            id: 'implement',
            steps: [
                { id: 'approve', kind: 'approval', approvalBefore: true },
                { id: 'develop', kind: 'agent', agentRole: 'developer' },
                { id: 'review', kind: 'agent', agentRole: 'reviewer' },
                { id: 'test', kind: 'agent', agentRole: 'tester' },
                { id: 'approve-commit', kind: 'approval', approvalBefore: true },
                { id: 'commit', kind: 'auto-commit' },
                { id: 'merge', kind: 'wait-merged' },
            ],
        },
    },
} as const;

function project(stateProjectExtra: Record<string, unknown>): Fixture {
    return {
        projects: [
            {
                id: 'shop',
                title: 'Shop',
                color: '#7c6af7',
                abbr: 'LDP',
                description: 'Sample target repo',
                _attention: false,
                archived: [],
                plans: [],
                ...stateProjectExtra,
            },
            {
                id: 'ai-pipeline',
                title: 'AI Pipeline',
                color: '#38bdf8',
                abbr: 'AIP',
                description: 'Pipeline self-development project',
                _attention: false,
                archived: [],
                plans: [],
            },
        ],
    };
}

// ---- per-slug fixtures ---------------------------------------------------

const BOARD_FIXTURE: Fixture = project({
    plans: [
        {
            _file: 'plan-active-001',
            _draft: false,
            _attention: false,
            plan: {
                id: 'plan-active-001',
                title: 'Migrate notification SQL filter to SentAt',
                repo_id: 'shop',
                tech_stack: ['C#', '.NET', 'SQL'],
                status: 'in_progress',
                tasks: [
                    {
                        id: 'task-001',
                        identifier: 'LDP-101',
                        type: 'implement',
                        title: 'Swap NotificationDate → SentAt in repo filter',
                        status: 'in_progress',
                        human_status: 'in_progress',
                        current_step_index: 1,
                        current_step_id: 'develop',
                        current_step_status: 'running',
                        meta: { log: [] },
                    },
                    {
                        id: 'task-002',
                        identifier: 'LDP-102',
                        type: 'implement',
                        title: 'Update notification migration tests',
                        status: 'in_progress',
                        human_status: 'review',
                        current_step_index: 2,
                        current_step_id: 'review',
                        current_step_status: 'running',
                        meta: { log: [] },
                    },
                ],
            },
        },
        {
            _file: 'plan-commit-002',
            _draft: false,
            _attention: true,
            plan: {
                id: 'plan-commit-002',
                title: 'Tighten notification reminder cron',
                repo_id: 'shop',
                tech_stack: ['C#', '.NET'],
                status: 'in_progress',
                tasks: [
                    {
                        id: 'task-001',
                        identifier: 'LDP-201',
                        type: 'implement',
                        title: 'Reduce reminder cron from 6h to 30m in prod config',
                        status: 'in_progress',
                        human_status: 'ready_to_commit',
                        current_step_index: 4,
                        current_step_id: 'approve-commit',
                        current_step_status: 'awaiting_approval',
                        meta: { log: [] },
                    },
                ],
            },
        },
        {
            _file: 'plan-draft-003',
            _draft: true,
            _attention: false,
            _active_agent: { op: 'decompose' },
            plan: {
                id: 'plan-draft-003',
                title: 'Wire repo-fetch fallback through worker-api',
                repo_id: 'shop',
                tech_stack: ['Node', 'TypeScript'],
                implementation_plan_status: 'ready',
                implementation_plan: '## summary\n…',
                tasks: [],
            },
        },
    ],
});

const PLAN_CARD_FIXTURE: Fixture = project({
    plans: [
        {
            _file: 'plan-focus-001',
            _draft: false,
            _attention: true,
            plan: {
                id: 'plan-focus-001',
                title: 'Switch shop logger to FileLogger rotation',
                repo_id: 'shop',
                tech_stack: ['C#', '.NET'],
                status: 'in_progress',
                tasks: [
                    {
                        id: 'task-001',
                        identifier: 'LDP-301',
                        type: 'implement',
                        title: 'Wire 2MB rotation into FileLogger',
                        status: 'in_progress',
                        human_status: 'ready_to_merge',
                        current_step_index: 6,
                        current_step_id: 'merge',
                        current_step_status: 'awaiting_approval',
                        meta: { log: [] },
                    },
                    {
                        id: 'task-002',
                        identifier: 'LDP-302',
                        type: 'implement',
                        title: 'Backfill FileLogger rotation tests',
                        status: 'in_progress',
                        human_status: 'ready_to_commit',
                        current_step_index: 4,
                        current_step_id: 'approve-commit',
                        current_step_status: 'awaiting_approval',
                        meta: { log: [] },
                    },
                ],
            },
        },
    ],
});

const TASK_CARD_FIXTURE: Fixture = project({
    plans: [
        {
            _file: 'plan-focus-002',
            _draft: false,
            _attention: false,
            plan: {
                id: 'plan-focus-002',
                title: 'Extract notification cursor helper',
                repo_id: 'shop',
                tech_stack: ['C#', '.NET'],
                status: 'in_progress',
                tasks: [
                    {
                        id: 'task-001',
                        identifier: 'LDP-401',
                        type: 'refactor',
                        title: 'Pull cursor logic into NotificationCursor',
                        status: 'in_progress',
                        human_status: 'in_progress',
                        current_step_index: 1,
                        current_step_id: 'develop',
                        current_step_status: 'running',
                        tags: ['refactor', 'in_progress'],
                        meta: { log: [] },
                    },
                ],
            },
        },
    ],
});

const FIXTURES: Readonly<Record<Slug, Fixture>> = {
    'board': BOARD_FIXTURE,
    'plan-card': PLAN_CARD_FIXTURE,
    'task-card': TASK_CARD_FIXTURE,
};

interface ServerHandle {
    readonly url: string;
    setSlug(slug: Slug): void;
    stop(): Promise<void>;
}

function startStubServer(): Promise<ServerHandle> {
    let activeSlug: Slug = 'board';
    const allowed = new Set(['board.html', 'board.js', 'board.css']);
    const server = http.createServer((req, res) => {
        const pathname = (req.url ?? '/').split('?', 1)[0];
        const method = req.method ?? 'GET';

        if (method === 'POST' && pathname === '/__set_slug') {
            const chunks: Buffer[] = [];
            req.on('data', (chunk: Buffer) => chunks.push(chunk));
            req.on('end', () => {
                try {
                    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                    if (typeof body?.slug === 'string' && body.slug in FIXTURES) {
                        activeSlug = body.slug as Slug;
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ ok: true, slug: activeSlug }));
                        return;
                    }
                } catch {
                    /* fall through */
                }
                res.writeHead(400);
                res.end();
            });
            return;
        }

        if (method === 'GET' && pathname === '/api/workflows') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(WORKFLOWS));
            return;
        }

        if (method === 'GET' && pathname === '/api/projects') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(FIXTURES[activeSlug]));
            return;
        }

        if (method === 'GET' && pathname === '/context-updates/pending') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('[]');
            return;
        }

        if (method !== 'GET') {
            res.writeHead(405);
            res.end();
            return;
        }

        const requested = pathname === '/' ? 'board.html' : pathname.replace(/^\/+/, '');
        if (!allowed.has(requested)) {
            res.writeHead(404);
            res.end();
            return;
        }
        const filePath = path.join(V1_BOARD_DIR, requested);
        const rel = path.relative(V1_BOARD_DIR, filePath);
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

    return new Promise<ServerHandle>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address();
            if (!addr || typeof addr === 'string') {
                reject(new Error('stub server: no address'));
                return;
            }
            resolve({
                url: `http://127.0.0.1:${addr.port}`,
                setSlug(slug: Slug): void {
                    activeSlug = slug;
                },
                stop(): Promise<void> {
                    return new Promise((r) => server.close(() => r()));
                },
            });
        });
    });
}

async function waitForReady(page: Page): Promise<void> {
    // Sidebar projects must have rendered. Then drive selectProject()
    // so v1 mounts the active project's plan section list; the
    // capture-time wait holds until the main body is non-empty rather
    // than sleeping for a fixed duration.
    await page.waitForFunction(() => {
        const projects = document.getElementById('sidebar-projects');
        return !!projects && projects.children.length > 0;
    }, { timeout: 10_000 });
    await page.evaluate(() => {
        const fn = (globalThis as { selectProject?: (id: string) => void }).selectProject;
        if (typeof fn === 'function') fn('shop');
    });
    await page.waitForFunction(() => {
        const main = document.getElementById('main-body');
        return !!main && main.children.length > 0;
    }, { timeout: 10_000 });
    // Block on web-font readiness instead of a fixed `waitForTimeout` —
    // fonts shifting after the screenshot is the only race we'd be
    // sleeping for, and `document.fonts.ready` resolves the moment the
    // last face is loaded (or immediately if none are pending).
    await page.evaluate(async () => {
        const ready = (document as Document & { fonts?: { ready?: Promise<unknown> } })
            .fonts?.ready;
        if (ready) await ready;
    });
}

async function main(): Promise<void> {
    if (!fs.existsSync(path.join(V1_BOARD_DIR, 'board.html'))) {
        console.error(
            `capture-v1-baselines: v1 board not found at ${V1_BOARD_DIR}. ` +
                `Set PARITY_V1_DIR to the parent of pipeline/board.`,
        );
        process.exit(1);
    }
    const server = await startStubServer();
    console.log(`capture-v1-baselines: stub board at ${server.url}`);
    const browser = await chromium.launch();
    try {
        const slugs: ReadonlyArray<Slug> = ['board', 'plan-card', 'task-card'];
        for (const slug of slugs) {
            server.setSlug(slug);
            const page = await browser.newPage({ viewport: VIEWPORT });
            try {
                await page.goto(`${server.url}/`, { waitUntil: 'domcontentloaded' });
                await waitForReady(page);
                const outPath = path.join(OUT_DIR, `v1-${slug}.png`);
                await page.screenshot({ path: outPath, fullPage: false });
                console.log(`capture-v1-baselines: wrote ${outPath}`);
            } finally {
                await page.close();
            }
        }
    } finally {
        await browser.close();
        await server.stop();
    }
}

if (require.main === module) {
    main().catch((err) => {
        console.error('capture-v1-baselines: fatal', err);
        process.exit(1);
    });
}
