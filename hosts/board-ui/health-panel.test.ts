/**
 * Unit tests for the AP-VP7-009 board-ui health panel renderer.
 *
 * Coverage (per the task brief AC list)
 * -------------------------------------
 * - AC #1 Happy path: a fully-populated /health body renders three rows
 *   — adapter list (name + wired indicator), formatted last-event
 *   timestamp, parked-task count.
 * - AC #2 Fully-degraded body: every row falls back to the em-dash +
 *   'degraded' badge, no exception escapes the renderer.
 * - AC #2 Partial-degradation body: the degraded row falls back to the
 *   em-dash, the other two rows still render their real values.
 * - AC #3 Smoke assertion that the exported worker-log tail constant
 *   still points at `/api/worker-log/tail` so any accidental rename of
 *   that route trips a unit test before it ships.
 *
 * Dual-runner discovery — same shim used by `stage-bar.test.ts` /
 * `edit-project.test.ts`. The orchestrator runs `npx vitest run` against
 * changed test files; `npm test` runs the same source under
 * `node --test`. The shim picks the right `test()` at runtime by sniffing
 * `process.env.VITEST`.
 */
import * as assert from 'node:assert/strict';

import {
    DEGRADED_TEXT,
    formatRelativeTimestamp,
    renderHealthPanel,
    WORKER_LOG_TAIL_PATH,
    type HealthBody,
    type HealthDocument,
    type HealthElement,
} from './health-panel';

// ---------------------------------------------------------------------------
// Dual-runner test() shim
// ---------------------------------------------------------------------------

type TestFn = (name: string, fn: () => void | Promise<void>) => void;

const test: TestFn = (((): TestFn => {
    if (process.env.VITEST) {
        const gt = (globalThis as { test?: TestFn }).test;
        if (typeof gt !== 'function') {
            throw new Error(
                'health-panel.test.ts: VITEST=true but globalThis.test is missing — '
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
// Minimal DOM shim
// ---------------------------------------------------------------------------

interface ShimElement extends HealthElement {
    readonly tagName: string;
    readonly children: ShimElement[];
    readonly attributes: Map<string, string>;
}

function makeShimDocument(): HealthDocument {
    function makeElement(tagName: string): ShimElement {
        const attrs = new Map<string, string>();
        const children: ShimElement[] = [];
        const el: ShimElement = {
            tagName,
            className: '',
            textContent: null,
            children,
            attributes: attrs,
            setAttribute(name: string, value: string): void {
                attrs.set(name, value);
            },
            appendChild(child: HealthElement): HealthElement {
                children.push(child as ShimElement);
                return child;
            },
        };
        return el;
    }
    return {
        createElement(tagName: string): HealthElement {
            return makeElement(tagName);
        },
    };
}

function asShim(el: HealthElement): ShimElement {
    return el as ShimElement;
}

function findAll(
    root: ShimElement,
    predicate: (el: ShimElement) => boolean,
    out: ShimElement[] = [],
): ShimElement[] {
    if (predicate(root)) out.push(root);
    for (const c of root.children) findAll(c, predicate, out);
    return out;
}

function findFirst(
    root: ShimElement,
    predicate: (el: ShimElement) => boolean,
): ShimElement | null {
    if (predicate(root)) return root;
    for (const c of root.children) {
        const hit = findFirst(c, predicate);
        if (hit) return hit;
    }
    return null;
}

function rowByName(root: ShimElement, name: string): ShimElement {
    const row = findFirst(
        root,
        (n) => n.attributes.get('data-health-row') === name,
    );
    if (!row) throw new Error(`row not found: data-health-row="${name}"`);
    return row;
}

// ---------------------------------------------------------------------------
// Fixture bodies
// ---------------------------------------------------------------------------

const FIXED_NOW = new Date('2026-05-18T12:00:30Z');

function happyBody(): HealthBody {
    return {
        adapters: {
            github: { wired: true },
            linear: { wired: true },
            telegram: { wired: false },
        },
        // 90 seconds before FIXED_NOW → "1m ago"
        lastEventAt: '2026-05-18T11:59:00Z',
        parkedTasks: 3,
        degraded: {
            adapters: false,
            lastEventAt: false,
            parkedTasks: false,
        },
    };
}

function fullyDegradedBody(): HealthBody {
    return {
        adapters: {},
        lastEventAt: null,
        parkedTasks: 0,
        degraded: {
            adapters: true,
            lastEventAt: true,
            parkedTasks: true,
        },
    };
}

function partiallyDegradedBody(): HealthBody {
    return {
        adapters: {
            github: { wired: true },
        },
        lastEventAt: null,
        parkedTasks: 5,
        degraded: {
            adapters: false,
            lastEventAt: true,
            parkedTasks: false,
        },
    };
}

// ---------------------------------------------------------------------------
// AC #1 — happy path
// ---------------------------------------------------------------------------

test('happy path: renders the three rows with real values', () => {
    const doc = makeShimDocument();
    const root = asShim(renderHealthPanel(happyBody(), { doc, now: FIXED_NOW }));

    assert.equal(root.tagName, 'section');
    assert.equal(root.attributes.get('data-health-panel'), 'true');

    // Three rows in the documented order.
    const rows = root.children;
    assert.equal(rows.length, 3);
    assert.equal(rows[0].attributes.get('data-health-row'), 'adapters');
    assert.equal(rows[1].attributes.get('data-health-row'), 'lastEventAt');
    assert.equal(rows[2].attributes.get('data-health-row'), 'parkedTasks');

    // Adapter list: sorted alphabetically, each with name + wired indicator.
    const adapterItems = findAll(
        rowByName(root, 'adapters'),
        (n) => n.attributes.has('data-adapter-name'),
    );
    assert.equal(adapterItems.length, 3);
    assert.equal(adapterItems[0].attributes.get('data-adapter-name'), 'github');
    assert.equal(adapterItems[0].attributes.get('data-adapter-wired'), 'true');
    assert.equal(adapterItems[1].attributes.get('data-adapter-name'), 'linear');
    assert.equal(adapterItems[1].attributes.get('data-adapter-wired'), 'true');
    assert.equal(adapterItems[2].attributes.get('data-adapter-name'), 'telegram');
    assert.equal(adapterItems[2].attributes.get('data-adapter-wired'), 'false');

    // No degraded marker on any row.
    for (const row of rows) {
        assert.notEqual(row.attributes.get('data-degraded'), 'true');
    }

    // Last-event row carries the formatted "1m ago" + the raw ISO.
    const lastEvent = rowByName(root, 'lastEventAt');
    const lastValue = findFirst(
        lastEvent,
        (n) => n.attributes.has('data-last-event-iso'),
    );
    assert.ok(lastValue, 'expected a value element with data-last-event-iso');
    assert.equal(
        lastValue!.attributes.get('data-last-event-iso'),
        '2026-05-18T11:59:00Z',
    );
    assert.equal(lastValue!.textContent, '1m ago');

    // Parked row shows the integer count.
    const parked = rowByName(root, 'parkedTasks');
    const parkedValue = findFirst(parked, (n) => n.attributes.has('data-parked-count'));
    assert.ok(parkedValue, 'expected a value element with data-parked-count');
    assert.equal(parkedValue!.attributes.get('data-parked-count'), '3');
    assert.equal(parkedValue!.textContent, '3');
});

// ---------------------------------------------------------------------------
// AC #2 — fully degraded body
// ---------------------------------------------------------------------------

test('fully degraded: every row shows em-dash + degraded badge, no crash', () => {
    const doc = makeShimDocument();
    const root = asShim(
        renderHealthPanel(fullyDegradedBody(), { doc, now: FIXED_NOW }),
    );

    for (const name of ['adapters', 'lastEventAt', 'parkedTasks']) {
        const row = rowByName(root, name);
        assert.equal(
            row.attributes.get('data-degraded'),
            'true',
            `row ${name} should be marked degraded`,
        );
        // Every degraded row carries an em-dash in its value text and a
        // 'degraded' badge sibling.
        const valueWithDash = findFirst(row, (n) => n.textContent === DEGRADED_TEXT);
        assert.ok(valueWithDash, `row ${name} missing em-dash value`);
        const badge = findFirst(
            row,
            (n) => n.attributes.get('data-health-badge') === 'degraded',
        );
        assert.ok(badge, `row ${name} missing degraded badge`);
        assert.equal(badge!.textContent, 'degraded');
    }
});

test('fully degraded with no `degraded` block: empty/null/0 still degrades each row', () => {
    // A body that omits the explicit `degraded` flags entirely (e.g. an
    // older worker-api). The renderer must infer degradation from the
    // sentinel values themselves so a stale server doesn't paint zero
    // counts and an empty adapter list as "healthy".
    const doc = makeShimDocument();
    const body: HealthBody = {
        adapters: {},
        lastEventAt: null,
        // parkedTasks: undefined — explicitly missing
    };
    const root = asShim(renderHealthPanel(body, { doc, now: FIXED_NOW }));

    for (const name of ['adapters', 'lastEventAt', 'parkedTasks']) {
        const row = rowByName(root, name);
        assert.equal(
            row.attributes.get('data-degraded'),
            'true',
            `row ${name} should be degraded by sentinel inference`,
        );
    }
});

// ---------------------------------------------------------------------------
// AC #2 — partial degradation
// ---------------------------------------------------------------------------

test('partial degradation: only the flagged row degrades; others render real values', () => {
    const doc = makeShimDocument();
    const root = asShim(
        renderHealthPanel(partiallyDegradedBody(), { doc, now: FIXED_NOW }),
    );

    // Adapters: still wired, NOT degraded.
    const adaptersRow = rowByName(root, 'adapters');
    assert.notEqual(adaptersRow.attributes.get('data-degraded'), 'true');
    const adapterItems = findAll(adaptersRow, (n) =>
        n.attributes.has('data-adapter-name'),
    );
    assert.equal(adapterItems.length, 1);
    assert.equal(adapterItems[0].attributes.get('data-adapter-name'), 'github');

    // Last-event: explicitly degraded → em-dash + badge.
    const lastEvent = rowByName(root, 'lastEventAt');
    assert.equal(lastEvent.attributes.get('data-degraded'), 'true');
    const lastDash = findFirst(lastEvent, (n) => n.textContent === DEGRADED_TEXT);
    assert.ok(lastDash, 'last-event row should carry an em-dash value');
    const lastBadge = findFirst(
        lastEvent,
        (n) => n.attributes.get('data-health-badge') === 'degraded',
    );
    assert.ok(lastBadge, 'last-event row should carry a degraded badge');

    // Parked: real count, NOT degraded.
    const parked = rowByName(root, 'parkedTasks');
    assert.notEqual(parked.attributes.get('data-degraded'), 'true');
    const parkedValue = findFirst(parked, (n) => n.attributes.has('data-parked-count'));
    assert.equal(parkedValue!.attributes.get('data-parked-count'), '5');
    assert.equal(parkedValue!.textContent, '5');
});

// ---------------------------------------------------------------------------
// Relative-time formatter — pinned thresholds
// ---------------------------------------------------------------------------

test('formatRelativeTimestamp: pins the seconds/minutes/hours/days thresholds', () => {
    const now = new Date('2026-05-18T12:00:00Z');
    assert.equal(
        formatRelativeTimestamp('2026-05-18T11:59:30Z', now),
        '30s ago',
    );
    assert.equal(
        formatRelativeTimestamp('2026-05-18T11:55:00Z', now),
        '5m ago',
    );
    assert.equal(
        formatRelativeTimestamp('2026-05-18T10:00:00Z', now),
        '2h ago',
    );
    assert.equal(
        formatRelativeTimestamp('2026-05-15T12:00:00Z', now),
        '3d ago',
    );
});

test('formatRelativeTimestamp: future timestamps render as `just now`, garbage returns null', () => {
    const now = new Date('2026-05-18T12:00:00Z');
    assert.equal(
        formatRelativeTimestamp('2026-05-18T12:00:30Z', now),
        'just now',
    );
    assert.equal(formatRelativeTimestamp('not-a-date', now), null);
});

// ---------------------------------------------------------------------------
// AC #3 — worker-log tail route smoke assertion
// ---------------------------------------------------------------------------

test('worker-log tail route is still /api/worker-log/tail (smoke)', () => {
    // The health-panel feature explicitly does not change the worker-log
    // modal route. If somebody renames the proxied path in server.ts
    // without updating the modal, this assertion (and the matching
    // re-export from health-panel.ts) keep the contract pinned.
    assert.equal(WORKER_LOG_TAIL_PATH, '/api/worker-log/tail');
});
