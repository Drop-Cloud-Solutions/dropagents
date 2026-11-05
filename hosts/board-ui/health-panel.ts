/**
 * Board-UI health panel renderer (AP-VP7-009).
 *
 * Surfaces the three AP-VP7-003 fields off the worker-api /health body —
 * the adapter list, the last-event timestamp, and the parked-task count —
 * as three rows in a small panel the operator can keep open next to the
 * board. Each row degrades independently: when its source field is
 * unreachable (the worker-api flagged it `degraded`) or carries the
 * fallback sentinel (`{}` / `null` / `0`), the row renders an em-dash and
 * a 'degraded' badge instead of zero or empty content. That keeps the
 * panel useful as a liveness check even when one underlying reader is
 * broken — the other rows still render their real values.
 *
 * The worker-log launcher continues to point at `/api/worker-log/tail`
 * (proxied through {@link ../board-ui/server#PROXY_PATHS}) — the modal in
 * `client/modals/worker-log.ts` is wired against that route and this file
 * does not change it. {@link WORKER_LOG_TAIL_PATH} is re-exported here so
 * a test can pin the constant without reaching into the modal module.
 *
 * Testability: the renderer takes injectable narrow DOM types and a
 * `now` clock so the unit tests can drive it with a hand-rolled shim and
 * a deterministic clock — no jsdom dependency.
 */

// ---------------------------------------------------------------------------
// Health body — narrowed view of `HealthCheckBody`
// ---------------------------------------------------------------------------

/**
 * Minimal view of the worker-api /health body the panel needs. The full
 * shape is owned by `hosts/worker-api/health.ts` (`HealthCheckBody`);
 * this interface only pins the AP-VP7-003 fields plus the matching
 * `degraded` flags so the renderer can stay decoupled from the rest of
 * the body (e.g. `pendingProjections`, which is rendered elsewhere).
 *
 * Every field is optional: a malformed or partial body must not crash
 * the panel. Missing values fall through to the per-row degraded path.
 */
export interface HealthBody {
    readonly adapters?: Readonly<Record<string, { readonly wired: boolean }>>;
    readonly lastEventAt?: string | null;
    readonly parkedTasks?: number;
    readonly degraded?: {
        readonly adapters?: boolean;
        readonly lastEventAt?: boolean;
        readonly parkedTasks?: boolean;
    };
}

// ---------------------------------------------------------------------------
// Worker-log routes — re-exported for smoke assertion (AC #3)
// ---------------------------------------------------------------------------

/** Same-origin path the worker-log SSE tail hits. Unchanged by this task. */
export const WORKER_LOG_TAIL_PATH = '/api/worker-log/tail';

// ---------------------------------------------------------------------------
// Narrow DOM surface — no `lib: ["dom"]` requirement
// ---------------------------------------------------------------------------

export interface HealthElement {
    className: string;
    textContent: string | null;
    setAttribute(name: string, value: string): void;
    appendChild(child: HealthElement): HealthElement;
}

export interface HealthDocument {
    createElement(tagName: string): HealthElement;
}

interface MaybeGlobalDocument {
    document?: HealthDocument;
}

function resolveDocument(doc: HealthDocument | undefined): HealthDocument {
    if (doc) return doc;
    const candidate = (globalThis as MaybeGlobalDocument).document;
    if (!candidate) {
        throw new Error(
            'health-panel: no document available — pass one explicitly '
                + 'when rendering outside a browser context.',
        );
    }
    return candidate;
}

// ---------------------------------------------------------------------------
// Em-dash + helpers
// ---------------------------------------------------------------------------

/** Em-dash character used for every degraded slot. AC #2. */
export const DEGRADED_TEXT = '—';

function setDegradedAttrs(row: HealthElement): void {
    row.setAttribute('data-degraded', 'true');
}

function appendBadge(row: HealthElement, doc: HealthDocument): void {
    const badge = doc.createElement('span');
    badge.className = 'health-panel-badge health-panel-badge--degraded';
    badge.setAttribute('data-health-badge', 'degraded');
    badge.textContent = 'degraded';
    row.appendChild(badge);
}

// ---------------------------------------------------------------------------
// Adapter list
// ---------------------------------------------------------------------------

interface AdapterEntry {
    readonly name: string;
    readonly wired: boolean;
}

function adapterEntries(
    adapters: HealthBody['adapters'],
): ReadonlyArray<AdapterEntry> {
    if (!adapters) return [];
    const out: AdapterEntry[] = [];
    for (const [name, val] of Object.entries(adapters)) {
        const wired = !!(val && typeof val === 'object' && (val as { wired?: unknown }).wired === true);
        out.push({ name, wired });
    }
    // Stable order so tests don't have to reason about Object.entries
    // iteration order across V8 versions.
    out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return out;
}

function renderAdapterList(
    body: HealthBody,
    doc: HealthDocument,
): HealthElement {
    const row = doc.createElement('div');
    row.className = 'health-panel-row health-panel-row--adapters';
    row.setAttribute('data-health-row', 'adapters');

    const label = doc.createElement('span');
    label.className = 'health-panel-label';
    label.textContent = 'Adapters';
    row.appendChild(label);

    const adapters = adapterEntries(body.adapters);
    const explicitDegraded = body.degraded?.adapters === true;
    const empty = adapters.length === 0;

    if (explicitDegraded || empty) {
        setDegradedAttrs(row);
        const value = doc.createElement('span');
        value.className = 'health-panel-value';
        value.textContent = DEGRADED_TEXT;
        row.appendChild(value);
        appendBadge(row, doc);
        return row;
    }

    const list = doc.createElement('ul');
    list.className = 'health-panel-adapter-list';
    list.setAttribute('data-adapter-list', 'true');
    for (const entry of adapters) {
        const item = doc.createElement('li');
        item.className = 'health-panel-adapter';
        item.setAttribute('data-adapter-name', entry.name);
        item.setAttribute('data-adapter-wired', entry.wired ? 'true' : 'false');

        const name = doc.createElement('span');
        name.className = 'health-panel-adapter-name';
        name.textContent = entry.name;
        item.appendChild(name);

        const indicator = doc.createElement('span');
        indicator.className = `health-panel-adapter-status health-panel-adapter-status--${entry.wired ? 'wired' : 'unwired'}`;
        indicator.setAttribute('data-wired', entry.wired ? 'true' : 'false');
        indicator.textContent = entry.wired ? 'wired' : 'unwired';
        item.appendChild(indicator);

        list.appendChild(item);
    }
    row.appendChild(list);
    return row;
}

// ---------------------------------------------------------------------------
// Last-event timestamp
// ---------------------------------------------------------------------------

/**
 * Format an ISO-8601 timestamp as a short "X ago" string relative to
 * `now`. Returns `null` when the timestamp can't be parsed — the caller
 * folds that into the degraded branch.
 *
 * The thresholds match v1's worker-log relative-time helper:
 *   < 60s   → `<n>s ago`
 *   < 60m   → `<n>m ago`
 *   < 24h   → `<n>h ago`
 *   else    → `<n>d ago`
 *
 * Future timestamps (clock skew) render as `just now` rather than a
 * negative number — operators reading the panel never need to reason
 * about a "-3s ago" anomaly.
 */
export function formatRelativeTimestamp(
    iso: string,
    now: Date,
): string | null {
    const ts = Date.parse(iso);
    if (!Number.isFinite(ts)) return null;
    const deltaSec = Math.floor((now.getTime() - ts) / 1000);
    if (deltaSec < 5) return 'just now';
    if (deltaSec < 60) return `${deltaSec}s ago`;
    const deltaMin = Math.floor(deltaSec / 60);
    if (deltaMin < 60) return `${deltaMin}m ago`;
    const deltaHr = Math.floor(deltaMin / 60);
    if (deltaHr < 24) return `${deltaHr}h ago`;
    const deltaDay = Math.floor(deltaHr / 24);
    return `${deltaDay}d ago`;
}

function renderLastEventAt(
    body: HealthBody,
    doc: HealthDocument,
    now: Date,
): HealthElement {
    const row = doc.createElement('div');
    row.className = 'health-panel-row health-panel-row--last-event';
    row.setAttribute('data-health-row', 'lastEventAt');

    const label = doc.createElement('span');
    label.className = 'health-panel-label';
    label.textContent = 'Last event';
    row.appendChild(label);

    const value = doc.createElement('span');
    value.className = 'health-panel-value';
    row.appendChild(value);

    const explicitDegraded = body.degraded?.lastEventAt === true;
    const raw = body.lastEventAt;
    const formatted =
        typeof raw === 'string' && raw.length > 0
            ? formatRelativeTimestamp(raw, now)
            : null;

    if (explicitDegraded || formatted === null) {
        setDegradedAttrs(row);
        value.textContent = DEGRADED_TEXT;
        appendBadge(row, doc);
        return row;
    }

    value.setAttribute('data-last-event-iso', raw as string);
    value.textContent = formatted;
    return row;
}

// ---------------------------------------------------------------------------
// Parked-task count
// ---------------------------------------------------------------------------

function renderParkedTasks(
    body: HealthBody,
    doc: HealthDocument,
): HealthElement {
    const row = doc.createElement('div');
    row.className = 'health-panel-row health-panel-row--parked';
    row.setAttribute('data-health-row', 'parkedTasks');

    const label = doc.createElement('span');
    label.className = 'health-panel-label';
    label.textContent = 'Parked tasks';
    row.appendChild(label);

    const value = doc.createElement('span');
    value.className = 'health-panel-value';
    row.appendChild(value);

    const explicitDegraded = body.degraded?.parkedTasks === true;
    const raw = body.parkedTasks;
    const valid =
        typeof raw === 'number' && Number.isFinite(raw) && raw >= 0;

    if (explicitDegraded || !valid) {
        setDegradedAttrs(row);
        value.textContent = DEGRADED_TEXT;
        appendBadge(row, doc);
        return row;
    }

    value.setAttribute('data-parked-count', String(raw));
    value.textContent = String(raw);
    return row;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export interface RenderHealthPanelOptions {
    readonly doc?: HealthDocument;
    /** Injected clock for the relative-time formatter. Defaults to `new Date()`. */
    readonly now?: Date;
}

/**
 * Render the three-row health panel for a `/health` response body.
 * Returns a freshly-constructed root `<section>` element — the caller
 * mounts it wherever the panel lives in the board layout. Pure: same
 * (body, now) → same DOM. Never throws on a degraded / partial body;
 * each row degrades independently.
 *
 * DOM shape (stable hooks for CSS + tests):
 *
 *   <section class="health-panel" data-health-panel>
 *     <div class="health-panel-row health-panel-row--adapters"
 *          data-health-row="adapters">…</div>
 *     <div class="health-panel-row health-panel-row--last-event"
 *          data-health-row="lastEventAt">…</div>
 *     <div class="health-panel-row health-panel-row--parked"
 *          data-health-row="parkedTasks">…</div>
 *   </section>
 */
export function renderHealthPanel(
    body: HealthBody,
    options: RenderHealthPanelOptions = {},
): HealthElement {
    const doc = resolveDocument(options.doc);
    const now = options.now ?? new Date();

    const root = doc.createElement('section');
    root.className = 'health-panel';
    root.setAttribute('data-health-panel', 'true');

    root.appendChild(renderAdapterList(body, doc));
    root.appendChild(renderLastEventAt(body, doc, now));
    root.appendChild(renderParkedTasks(body, doc));

    return root;
}
