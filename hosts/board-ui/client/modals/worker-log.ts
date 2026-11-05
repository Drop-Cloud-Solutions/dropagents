/**
 * Worker-log viewer modal (AP-IFF-018).
 *
 * Operator-facing tail of the worker log, mounted inside an overlay
 * registered with the AP-IFF-002 overlay manager. The modal:
 *
 *   1. On open, fetches `GET /api/worker-log/snapshot?level=<level>`
 *      and renders each returned line into the log body. AC #1.
 *   2. After the snapshot resolves, opens
 *      `GET /api/worker-log/tail?level=<level>` as an SSE stream and
 *      appends each `data:` frame to the body so the operator sees a
 *      live tail. AC #2.
 *   3. Exposes a level-filter dropdown (info / warn / error / all);
 *      switching levels closes the current SSE connection, re-fetches
 *      the snapshot at the new level, and re-opens the SSE tail. AC #3.
 *   4. On `close()` the SSE connection is torn down and the overlay
 *      is unregistered. AC #4.
 *
 * Routes are proxied through the board-ui server's `PROXY_PATHS` set
 * (`hosts/board-ui/server.ts`) so the browser hits same-origin URLs and
 * the worker-api token never crosses to the client. The matching
 * `/api/worker-log/{snapshot,tail}` worker-api responders shipped in
 * AP-IFF-017.
 *
 * Testability mirrors the AP-IFF-010 diff-review modal: structural DOM
 * types keep the spec jsdom-free, and both `fetch` and the EventSource
 * factory are injected via narrow ports so unit tests can record calls
 * without standing up real transports.
 */

// ---------------------------------------------------------------------------
// Public level vocabulary
// ---------------------------------------------------------------------------

/**
 * Levels surfaced by the filter chip. Mirrors the closed set accepted by
 * the worker-api `/api/worker-log/{snapshot,tail}` routes — see
 * `hosts/worker-api/routes/worker-log-tail.ts`. `null` means "no filter"
 * (the route returns every line); the dropdown maps that to its "all"
 * option.
 */
export const WORKER_LOG_LEVELS = ['info', 'warn', 'error'] as const;
export type WorkerLogLevel = (typeof WORKER_LOG_LEVELS)[number];

// ---------------------------------------------------------------------------
// Route + overlay identifiers
// ---------------------------------------------------------------------------

/** Overlay-manager id the modal registers under. Exposed for the host. */
export const WORKER_LOG_OVERLAY_ID = 'worker-log';

/** Same-origin path the snapshot fetch hits. Proxied to the worker-api. */
export const WORKER_LOG_SNAPSHOT_PATH = '/api/worker-log/snapshot';

/** Same-origin path the SSE tail hits. Proxied to the worker-api. */
export const WORKER_LOG_TAIL_PATH = '/api/worker-log/tail';

// ---------------------------------------------------------------------------
// Structural DOM types — keep tests jsdom-free
// ---------------------------------------------------------------------------

/**
 * Minimal element surface the modal touches. Real `HTMLElement`
 * satisfies this structurally; tests pass a hand-rolled shim. `value`
 * is the `<select>` slot the level dropdown reads on change; `onchange`
 * is its event hook.
 */
export interface WorkerLogElement {
    className: string;
    textContent: string | null;
    value: string;
    setAttribute(name: string, value: string): void;
    appendChild(child: WorkerLogElement): WorkerLogElement;
    replaceChildren(...children: WorkerLogElement[]): void;
    /**
     * Detach the element from its parent. The overlay-manager only flips
     * `aria-hidden`; CSS in `board.css` keys off `.hidden` rather than
     * `[aria-hidden]`, so without removing the DOM node the modal stays
     * on screen even after `closeOverlay` runs. Matches the convention
     * used by `new-project.ts` and `clarify.ts` close paths.
     */
    remove(): void;
    /**
     * Scroll position fields used to jump the operator to the latest
     * entries after the snapshot lands and to detect whether the live
     * tail should sticky-scroll on each SSE-delivered line.
     * `scrollTop` is settable on the real `HTMLElement`; the height
     * fields are read-only. All three are optional on the structural
     * shim so existing tests don't have to implement them.
     */
    scrollTop?: number;
    readonly scrollHeight?: number;
    readonly clientHeight?: number;
}

export interface WorkerLogDocument {
    createElement(tagName: string): WorkerLogElement;
}

interface WorkerLogElementWithEvents extends WorkerLogElement {
    onchange?: () => void | Promise<void>;
    onclick?: () => void;
}

// ---------------------------------------------------------------------------
// Overlay-manager port
// ---------------------------------------------------------------------------

/**
 * Narrow view of {@link OverlayManager}. The real manager from
 * `client/chrome/overlay-manager.ts` satisfies this structurally —
 * tests pass a recorder fake.
 */
export interface WorkerLogOverlayManager {
    openOverlay(id: string, element: unknown): unknown;
    closeOverlay(id: string): void;
}

// ---------------------------------------------------------------------------
// Fetch port
// ---------------------------------------------------------------------------

/** Browser `fetch`-shaped response port. */
export interface WorkerLogFetchResponse {
    readonly ok: boolean;
    readonly status: number;
    json(): Promise<unknown>;
}

export type WorkerLogFetch = (
    url: string,
    init?: { readonly method?: string; readonly signal?: unknown },
) => Promise<WorkerLogFetchResponse>;

// ---------------------------------------------------------------------------
// EventSource port
// ---------------------------------------------------------------------------

/**
 * The slice of `EventSource` the modal touches. Browsers ship a richer
 * surface but the modal only needs onmessage / onerror / close — keeping
 * the seam narrow lets tests drive `onmessage` synchronously without
 * modelling the full DOM type.
 *
 * `onmessage` receives the same shape `EventSource` would deliver
 * (`{ data: string }`); `onerror` carries no shape requirement because
 * the modal never inspects the event payload.
 */
export interface WorkerLogEventSourceLike {
    onmessage: ((event: { readonly data: string }) => void) | null;
    onerror: ((event: unknown) => void) | null;
    close(): void;
}

/**
 * Factory that returns an EventSource bound to `url`. Production passes
 * `(url) => new EventSource(url)`; tests pass a recorder that captures
 * the url + exposes the handle for synchronous onmessage delivery.
 */
export type WorkerLogEventSourceFactory = (
    url: string,
) => WorkerLogEventSourceLike;

// ---------------------------------------------------------------------------
// Document resolution
// ---------------------------------------------------------------------------

interface MaybeGlobalDocument {
    document?: WorkerLogDocument;
}

function resolveDocument(doc: WorkerLogDocument | undefined): WorkerLogDocument {
    if (doc) return doc;
    const candidate = (globalThis as MaybeGlobalDocument).document;
    if (!candidate) {
        throw new Error(
            'worker-log: no document available — pass one explicitly when '
                + 'rendering outside a browser context.',
        );
    }
    return candidate;
}

function attachChange(
    el: WorkerLogElement,
    handler: () => void | Promise<void>,
): void {
    (el as WorkerLogElementWithEvents).onchange = handler;
}

function attachClick(el: WorkerLogElement, handler: () => void): void {
    (el as WorkerLogElementWithEvents).onclick = handler;
}

// ---------------------------------------------------------------------------
// URL builders — exported so tests pin the route shape
// ---------------------------------------------------------------------------

/**
 * Build the snapshot URL for `level`. `null` means "no filter" (omit
 * the query param entirely); the three documented levels are encoded
 * verbatim because they're already URL-safe.
 */
export function buildSnapshotUrl(level: WorkerLogLevel | null): string {
    if (level === null) return WORKER_LOG_SNAPSHOT_PATH;
    return `${WORKER_LOG_SNAPSHOT_PATH}?level=${level}`;
}

/** Build the SSE tail URL for `level`. Same encoding rules as the snapshot. */
export function buildTailUrl(level: WorkerLogLevel | null): string {
    if (level === null) return WORKER_LOG_TAIL_PATH;
    return `${WORKER_LOG_TAIL_PATH}?level=${level}`;
}

// ---------------------------------------------------------------------------
// Snapshot payload
// ---------------------------------------------------------------------------

interface SnapshotBody {
    readonly lines: ReadonlyArray<string>;
}

function coerceSnapshot(body: unknown): SnapshotBody {
    if (body && typeof body === 'object' && Array.isArray((body as SnapshotBody).lines)) {
        const lines = (body as SnapshotBody).lines.filter(
            (l): l is string => typeof l === 'string',
        );
        return { lines };
    }
    return { lines: [] };
}

// ---------------------------------------------------------------------------
// Public deps + handle
// ---------------------------------------------------------------------------

export interface WorkerLogDeps {
    /** Overlay root element. Pushed onto the overlay stack on open. */
    readonly element: WorkerLogElement;
    readonly overlayManager: WorkerLogOverlayManager;
    readonly fetch: WorkerLogFetch;
    readonly createEventSource: WorkerLogEventSourceFactory;
    readonly doc?: WorkerLogDocument;
    /**
     * Initial filter level. Defaults to `null` ("all levels") so the
     * operator sees the unfiltered tail until they pick a level — the
     * brief calls out the three filter values but doesn't pin a default,
     * and showing everything is the safer initial state for an incident
     * triage tool.
     */
    readonly initialLevel?: WorkerLogLevel | null;
}

export interface WorkerLogHandle {
    /**
     * Close the overlay and tear down the active SSE connection.
     * Idempotent — calling it twice is a no-op the second time. AC #4.
     */
    close(): void;
    /**
     * Switch the active filter level. Closes the current SSE
     * connection, re-fetches the snapshot, then re-opens the SSE tail
     * at the new level. Resolves once the fetch + reconnect settle.
     * AC #3.
     */
    setLevel(level: WorkerLogLevel | null): Promise<void>;
    /** Promise resolved once the initial snapshot fetch + SSE open settles. */
    readonly loaded: Promise<void>;
    /** The currently active level (`null` means "all"). */
    readonly currentLevel: WorkerLogLevel | null;
}

// ---------------------------------------------------------------------------
// Renderer state
// ---------------------------------------------------------------------------

interface RenderState {
    levelSelect: WorkerLogElement | null;
    logBody: WorkerLogElement | null;
    status: WorkerLogElement | null;
}

function emptyRenderState(): RenderState {
    return { levelSelect: null, logBody: null, status: null };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export function openWorkerLog(deps: WorkerLogDeps): WorkerLogHandle {
    const doc = resolveDocument(deps.doc);
    const root = deps.element;
    root.className = 'modal modal--worker-log modal-chrome';
    root.setAttribute('data-modal', 'worker-log');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', 'Worker log');

    deps.overlayManager.openOverlay(WORKER_LOG_OVERLAY_ID, root);

    let closed = false;
    let currentLevel: WorkerLogLevel | null = deps.initialLevel ?? null;
    let activeEventSource: WorkerLogEventSourceLike | null = null;
    const state = emptyRenderState();

    // --- chrome rendering ----------------------------------------------------
    renderChrome();

    const close = (): void => {
        if (closed) return;
        closed = true;
        teardownEventSource();
        deps.overlayManager.closeOverlay(WORKER_LOG_OVERLAY_ID);
        root.remove();
    };

    const teardownEventSource = (): void => {
        if (activeEventSource) {
            activeEventSource.onmessage = null;
            activeEventSource.onerror = null;
            activeEventSource.close();
            activeEventSource = null;
        }
    };

    /**
     * Threshold (px) within which we consider the operator to be "at
     * the bottom" of the log body. New SSE-delivered lines auto-scroll
     * past this window so the live tail keeps moving; if the operator
     * scrolls higher than this to read a past entry, new lines append
     * silently without yanking the viewport.
     */
    const STICKY_BOTTOM_THRESHOLD_PX = 48;

    const isNearBottom = (): boolean => {
        const body = state.logBody;
        if (
            !body
            || typeof body.scrollTop !== 'number'
            || typeof body.scrollHeight !== 'number'
            || typeof body.clientHeight !== 'number'
        ) {
            // Without scroll metrics we assume yes — keeps the prod
            // path sticky-by-default and lets the test shim opt out
            // by leaving the fields undefined.
            return true;
        }
        return (
            body.scrollHeight - body.clientHeight - body.scrollTop
            < STICKY_BOTTOM_THRESHOLD_PX
        );
    };

    const appendLine = (line: string): void => {
        if (closed || !state.logBody) return;
        const stickyBeforeAppend = isNearBottom();
        const entry = doc.createElement('div');
        entry.className = 'worker-log-line';
        entry.setAttribute('data-worker-log-line', '');
        entry.textContent = line;
        state.logBody.appendChild(entry);
        // Sticky-tail: SSE frames keep the viewport at the latest
        // entry unless the operator has scrolled up to read history.
        // Without this, a busy worker.log floods scrollHeight while
        // scrollTop stays pinned at the snapshot's end position —
        // which lands "half-way" once new entries arrive.
        if (stickyBeforeAppend) jumpToEnd();
    };

    const jumpToEnd = (): void => {
        const body = state.logBody;
        if (!body) return;
        if (
            body.scrollHeight !== undefined
            && typeof body.scrollTop === 'number'
        ) {
            body.scrollTop = body.scrollHeight;
        }
    };

    const replaceLines = (lines: ReadonlyArray<string>): void => {
        if (!state.logBody) return;
        const next: WorkerLogElement[] = [];
        for (const line of lines) {
            const entry = doc.createElement('div');
            entry.className = 'worker-log-line';
            entry.setAttribute('data-worker-log-line', '');
            entry.textContent = line;
            next.push(entry);
        }
        state.logBody.replaceChildren(...next);
        // Jump to the latest entries. Multiple passes because the
        // body's `scrollHeight` is not stable immediately after
        // `replaceChildren`: web-font loading, monospace-glyph
        // measurement, and the flex parent's own layout pass can
        // each grow scrollHeight after we read it. A naive single
        // `scrollTop = scrollHeight` lands "half-way" because we
        // captured the under-measured height.
        //
        // Pass 1 (sync)         — snaps to bottom against whatever
        //                          height the synchronous-layout read
        //                          returns; covers warm reopens
        //                          where layout is already correct.
        // Pass 2 (microtask)    — runs after every queued
        //                          assignment in the current task
        //                          (e.g. setStatus) but before any
        //                          rendering.
        // Pass 3 (rAF)          — fires before the next paint, with
        //                          the body's layout fully resolved.
        // Pass 4 (timeout ~120ms) — catches font-load reflows that
        //                          happen after the first paint.
        jumpToEnd();
        const g = globalThis as {
            requestAnimationFrame?: (cb: () => void) => unknown;
        };
        queueMicrotask(() => jumpToEnd());
        if (typeof g.requestAnimationFrame === 'function') {
            g.requestAnimationFrame(() => jumpToEnd());
        }
        setTimeout(() => jumpToEnd(), 120);
    };

    const setStatus = (text: string, kind: 'info' | 'error'): void => {
        if (!state.status) return;
        state.status.className = `worker-log-status worker-log-status--${kind}`;
        state.status.setAttribute('data-worker-log-status', kind);
        state.status.textContent = text;
    };

    // --- fetch + connect ----------------------------------------------------
    const fetchSnapshot = async (level: WorkerLogLevel | null): Promise<void> => {
        setStatus('Loading…', 'info');
        let response: WorkerLogFetchResponse;
        try {
            response = await deps.fetch(buildSnapshotUrl(level));
        } catch (err) {
            replaceLines([]);
            setStatus(
                err instanceof Error
                    ? `Failed to load worker log: ${err.message}`
                    : 'Failed to load worker log',
                'error',
            );
            return;
        }
        if (closed) return;
        if (!response.ok) {
            replaceLines([]);
            setStatus(`Failed to load worker log (HTTP ${response.status})`, 'error');
            return;
        }
        let body: unknown;
        try {
            body = await response.json();
        } catch (err) {
            replaceLines([]);
            setStatus(
                err instanceof Error
                    ? `Invalid worker-log response: ${err.message}`
                    : 'Invalid worker-log response',
                'error',
            );
            return;
        }
        if (closed) return;
        const snap = coerceSnapshot(body);
        replaceLines(snap.lines);
        setStatus(
            snap.lines.length === 0 ? 'No log entries.' : 'Live tail…',
            'info',
        );
    };

    const openTail = (level: WorkerLogLevel | null): void => {
        if (closed) return;
        teardownEventSource();
        const es = deps.createEventSource(buildTailUrl(level));
        activeEventSource = es;
        es.onmessage = (event): void => {
            if (closed || activeEventSource !== es) return;
            if (typeof event.data !== 'string' || event.data.length === 0) return;
            appendLine(event.data);
        };
        es.onerror = (): void => {
            if (closed || activeEventSource !== es) return;
            // Surface a soft warning — the production EventSource will
            // auto-reconnect on its own, so we don't tear the modal
            // down. AC #2 keeps the renderer responsive to whatever
            // frames eventually arrive.
            setStatus('Live tail disconnected — retrying…', 'error');
        };
    };

    // --- level changes -------------------------------------------------------
    const applyLevel = async (level: WorkerLogLevel | null): Promise<void> => {
        if (closed) return;
        currentLevel = level;
        teardownEventSource();
        await fetchSnapshot(level);
        if (closed) return;
        openTail(level);
    };

    const setLevel = async (level: WorkerLogLevel | null): Promise<void> => {
        if (closed) return;
        if (level === currentLevel) return;
        if (state.levelSelect) {
            state.levelSelect.value = level ?? '';
        }
        await applyLevel(level);
    };

    // --- chrome --------------------------------------------------------------
    function renderChrome(): void {
        const header = doc.createElement('header');
        header.className = 'worker-log-header modal-chrome__header';
        header.setAttribute('data-worker-log-header', '');

        const title = doc.createElement('h2');
        title.className = 'worker-log-title';
        title.textContent = 'Worker log';
        header.appendChild(title);

        const filterLabel = doc.createElement('label');
        filterLabel.className = 'worker-log-filter-label';
        filterLabel.setAttribute('for', 'worker-log-level');
        filterLabel.textContent = 'Level';
        header.appendChild(filterLabel);

        const select = doc.createElement('select');
        select.className = 'worker-log-filter';
        select.setAttribute('id', 'worker-log-level');
        select.setAttribute('data-worker-log-filter', '');

        const allOpt = doc.createElement('option');
        allOpt.setAttribute('value', '');
        allOpt.textContent = 'All';
        select.appendChild(allOpt);
        for (const lvl of WORKER_LOG_LEVELS) {
            const opt = doc.createElement('option');
            opt.setAttribute('value', lvl);
            opt.textContent = lvl;
            select.appendChild(opt);
        }
        select.value = currentLevel ?? '';
        attachChange(select, () => {
            // Read the selected value through the structural `value`
            // slot, normalise the empty string to `null`, and route
            // through `setLevel` so the change path is identical to a
            // programmatic call. AC #3.
            const raw = select.value;
            const next: WorkerLogLevel | null
                = raw === ''
                    ? null
                    : (WORKER_LOG_LEVELS as ReadonlyArray<string>).includes(raw)
                        ? (raw as WorkerLogLevel)
                        : null;
            return setLevel(next);
        });
        header.appendChild(select);
        state.levelSelect = select;

        const closeBtn = doc.createElement('button');
        closeBtn.className = 'worker-log-close modal-chrome__close';
        closeBtn.setAttribute('type', 'button');
        closeBtn.setAttribute('data-action', 'close');
        closeBtn.textContent = 'Close';
        attachClick(closeBtn, () => close());
        header.appendChild(closeBtn);

        const status = doc.createElement('div');
        status.className = 'worker-log-status worker-log-status--info';
        status.setAttribute('data-worker-log-status', 'info');
        status.textContent = '';
        state.status = status;

        const body = doc.createElement('div');
        body.className = 'worker-log-body modal-chrome__body';
        body.setAttribute('data-worker-log-body', '');
        state.logBody = body;

        root.replaceChildren(header, status, body);
    }

    // --- initial load --------------------------------------------------------
    const loaded = (async (): Promise<void> => {
        await fetchSnapshot(currentLevel);
        if (closed) return;
        openTail(currentLevel);
    })();

    return {
        close,
        setLevel,
        loaded,
        get currentLevel(): WorkerLogLevel | null {
            return currentLevel;
        },
    };
}
