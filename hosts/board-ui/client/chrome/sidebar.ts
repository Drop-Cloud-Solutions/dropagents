/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Sidebar chrome module (AP-IFF-003).
 *
 * Owns the `.sidebar` element of the operator board: renders the project
 * list, the pending-projections badge, the SSE live-dot, and the
 * Worker-log launcher button. State is read from a projection store
 * (the canonical one lives in `hosts/board-ui/board.js`), and the
 * sidebar re-renders reactively whenever the store notifies its
 * subscribers.
 *
 * Architectural contract
 * ----------------------
 * - The host calls `init(root, store)` once. The returned handle owns
 *   the store subscription and the rendered DOM. Calling `destroy()`
 *   detaches the subscription so the module is GC-safe.
 * - User actions emit DOM CustomEvents on `root` rather than calling
 *   back into the store. The host listens for:
 *     - `select:project` (detail = projectId)
 *     - `open:worker-log` (no detail)
 *     - `open:new-project` (no detail) — only fires from the empty-state
 *       CTA when the projection reports zero projects (AP-PAO-017).
 *   This keeps the sidebar a leaf in the data flow: it owns the view,
 *   never the action.
 * - DOM types are structural so unit tests can drive the module with a
 *   minimal shim (no jsdom). The browser passes its real `document` and
 *   `HTMLElement`; tests pass the {@link SidebarElement} / {@link
 *   SidebarDocument} shims.
 * - The live-dot reflects an EventSource `readyState`-style number
 *   (`0` connecting, `1` open, `2` closed). The store flips this when
 *   the SSE source transitions, and the next render swaps the
 *   `data-state` attribute accordingly — no internal poll.
 */

// ---------------------------------------------------------------------------
// Projection shapes (mirror the subset of board.js state the sidebar reads)
// ---------------------------------------------------------------------------

export interface SidebarProject {
    readonly id: string;
    readonly name: string;
}

/**
 * Snapshot of the slice of projection state the sidebar consumes. The
 * store is free to carry additional fields — the sidebar reads only
 * these three.
 */
export interface SidebarStoreState {
    readonly projects: ReadonlyArray<SidebarProject>;
    readonly pendingProjections: number;
    /**
     * Mirrors `EventSource.readyState` semantics:
     *   0 — CONNECTING (live-dot pulses amber)
     *   1 — OPEN       (live-dot solid green)
     *   2 — CLOSED     (live-dot grey)
     * Any other numeric value falls back to `closed` so a degraded
     * store cannot crash the renderer.
     */
    readonly sseReadyState: number;
}

/**
 * Minimal projection-store contract. The board.js store satisfies this
 * structurally — no shared symbol required. Tests pass a hand-rolled
 * fake.
 */
export interface SidebarStore {
    getState(): SidebarStoreState;
    subscribe(listener: (state: SidebarStoreState) => void): () => void;
}

// ---------------------------------------------------------------------------
// Structural DOM types — keep tests jsdom-free
// ---------------------------------------------------------------------------

export interface SidebarEvent {
    readonly type: string;
    readonly detail?: unknown;
    readonly bubbles?: boolean;
}

export interface SidebarElement {
    className: string;
    textContent: string | null;
    hidden: boolean;
    setAttribute(name: string, value: string): void;
    appendChild(child: SidebarElement): SidebarElement;
    replaceChildren(...children: SidebarElement[]): void;
    dispatchEvent(event: SidebarEvent): boolean;
}

export interface SidebarDocument {
    createElement(tagName: string): SidebarElement;
}

interface SidebarElementWithEvents extends SidebarElement {
    onclick?: () => void;
}

interface MaybeGlobalDocument {
    document?: SidebarDocument;
    CustomEvent?: new (type: string, init?: { detail?: unknown; bubbles?: boolean }) => SidebarEvent;
}

function resolveDocument(doc: SidebarDocument | undefined): SidebarDocument {
    if (doc) return doc;
    const candidate = (globalThis as MaybeGlobalDocument).document;
    if (!candidate) {
        throw new Error(
            'sidebar: no document available — pass one explicitly when '
                + 'rendering outside a browser context.',
        );
    }
    return candidate;
}

function resolveCustomEvent(
    factory: SidebarDeps['createCustomEvent'] | undefined,
): (type: string, init: { detail?: unknown; bubbles?: boolean }) => SidebarEvent {
    if (factory) return factory;
    const ctor = (globalThis as MaybeGlobalDocument).CustomEvent;
    if (ctor) {
        return (type, init) => new ctor(type, init);
    }
    // Plain-object fallback — fine for tests; the dispatch path only
    // requires `type` and `detail`.
    return (type, init) => ({ type, detail: init.detail, bubbles: init.bubbles });
}

function attachClick(el: SidebarElement, handler: () => void): void {
    (el as SidebarElementWithEvents).onclick = handler;
}

// ---------------------------------------------------------------------------
// Live-dot derivation — readyState → CSS state token
// ---------------------------------------------------------------------------

/** Stable token written into `data-state` on the live-dot. */
export type LiveDotState = 'connecting' | 'open' | 'closed';

/**
 * Pure derivation from an `EventSource.readyState`-style number to the
 * three-state token the live-dot uses. Exported so tests can pin the
 * mapping directly.
 */
export function deriveLiveDotState(readyState: number): LiveDotState {
    if (readyState === 1) return 'open';
    if (readyState === 0) return 'connecting';
    return 'closed';
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

interface RenderContext {
    readonly doc: SidebarDocument;
    readonly root: SidebarElement;
    readonly dispatch: (type: string, detail?: unknown) => void;
}

function renderProjectList(
    ctx: RenderContext,
    projects: ReadonlyArray<SidebarProject>,
): SidebarElement {
    const list = ctx.doc.createElement('ul');
    list.className = 'sidebar-project-list';
    list.setAttribute('data-sidebar-project-list', '');

    if (projects.length === 0) {
        const empty = ctx.doc.createElement('li');
        empty.className = 'sidebar-project-list-empty';
        empty.setAttribute('data-empty', '');
        empty.textContent = 'No projects';
        list.appendChild(empty);

        // AP-PAO-017: surface a primary CTA in the empty state so the
        // operator can bootstrap their first project without hunting for
        // the header-level Create button. The CTA emits `open:new-project`;
        // the host wires that to the AP-PAO-014 new-project modal.
        //
        // Visual prominence comes from `.sidebar-new-project-cta` in
        // board.css, which wires the button to `var(--accent)` /
        // `var(--accent-hover)` — the same primary-action tokens the
        // existing `button[data-action='approve']` selector consumes
        // (board.css:287). The wrapping `.sidebar-project-list-cta` row
        // centers the button within the empty list.
        const ctaRow = ctx.doc.createElement('li');
        ctaRow.className = 'sidebar-project-list-cta';
        ctaRow.setAttribute('data-sidebar-new-project-cta-row', '');
        const cta = ctx.doc.createElement('button');
        cta.className = 'sidebar-new-project-cta';
        cta.setAttribute('type', 'button');
        cta.setAttribute('data-action', 'open-new-project');
        cta.setAttribute('data-sidebar-new-project-cta', '');
        cta.textContent = '+ New project';
        attachClick(cta, () => ctx.dispatch('open:new-project'));
        ctaRow.appendChild(cta);
        list.appendChild(ctaRow);
        return list;
    }

    for (const project of projects) {
        const row = ctx.doc.createElement('li');
        row.className = 'sidebar-project-row';
        row.setAttribute('data-sidebar-project-row', '');
        row.setAttribute('data-project-id', project.id);
        row.setAttribute('role', 'button');
        row.setAttribute('tabindex', '0');

        const name = ctx.doc.createElement('span');
        name.className = 'sidebar-project-name';
        name.setAttribute('data-sidebar-project-name', '');
        name.textContent = project.name;
        row.appendChild(name);

        attachClick(row, () => ctx.dispatch('select:project', project.id));

        list.appendChild(row);
    }

    return list;
}

function renderBadge(
    ctx: RenderContext,
    pendingProjections: number,
): SidebarElement {
    const badge = ctx.doc.createElement('span');
    badge.className = 'sidebar-pending-badge';
    badge.setAttribute('data-sidebar-pending-badge', '');
    badge.setAttribute('aria-live', 'polite');
    if (pendingProjections <= 0) {
        badge.hidden = true;
        badge.setAttribute('hidden', 'hidden');
        badge.textContent = '';
        return badge;
    }
    badge.hidden = false;
    badge.textContent = `${pendingProjections} pending`;
    badge.setAttribute('data-pending-count', String(pendingProjections));
    return badge;
}

function renderLiveDot(
    ctx: RenderContext,
    sseReadyState: number,
): SidebarElement {
    const dot = ctx.doc.createElement('span');
    const state = deriveLiveDotState(sseReadyState);
    dot.className = `sidebar-live-dot sidebar-live-dot--${state}`;
    dot.setAttribute('data-sidebar-live-dot', '');
    dot.setAttribute('data-state', state);
    dot.setAttribute('aria-label', `SSE ${state}`);
    dot.setAttribute('role', 'status');
    return dot;
}

function renderWorkerLogButton(ctx: RenderContext): SidebarElement {
    const btn = ctx.doc.createElement('button');
    btn.setAttribute('type', 'button');
    btn.setAttribute('data-action', 'open-worker-log');
    btn.setAttribute('data-sidebar-worker-log', '');
    btn.className = 'sidebar-worker-log-button';
    btn.textContent = 'Worker log';
    attachClick(btn, () => ctx.dispatch('open:worker-log'));
    return btn;
}

function renderStatusBar(
    ctx: RenderContext,
    state: SidebarStoreState,
): SidebarElement {
    const bar = ctx.doc.createElement('div');
    bar.className = 'sidebar-status';
    bar.setAttribute('data-sidebar-status', '');
    bar.appendChild(renderLiveDot(ctx, state.sseReadyState));
    bar.appendChild(renderBadge(ctx, state.pendingProjections));
    bar.appendChild(renderWorkerLogButton(ctx));
    return bar;
}

// ---------------------------------------------------------------------------
// Public init / handle
// ---------------------------------------------------------------------------

export interface SidebarDeps {
    readonly doc?: SidebarDocument;
    /**
     * Optional CustomEvent factory. Browsers expose `CustomEvent`
     * globally; tests pass a plain-object factory so the shim element's
     * `dispatchEvent` records something inspectable.
     */
    readonly createCustomEvent?: (
        type: string,
        init: { detail?: unknown; bubbles?: boolean },
    ) => SidebarEvent;
}

export interface SidebarHandle {
    /** Re-render against the store's current state. Idempotent. */
    render(): void;
    /** Detach the store subscription. Leaves the last-rendered DOM in place. */
    destroy(): void;
}

/**
 * Mount the sidebar inside `root` and subscribe to `store`. Returns a
 * handle the host can use to force a re-render or detach.
 *
 * The first render runs synchronously before `init` returns so callers
 * don't see an empty `.sidebar` element after mount. Subsequent
 * renders are driven by the store's `subscribe` callback.
 */
export function init(
    root: SidebarElement,
    store: SidebarStore,
    deps?: SidebarDeps,
): SidebarHandle {
    const doc = resolveDocument(deps?.doc);
    const customEventFactory = resolveCustomEvent(deps?.createCustomEvent);

    const dispatch = (type: string, detail?: unknown): void => {
        const event = customEventFactory(type, { detail, bubbles: true });
        root.dispatchEvent(event);
    };

    const ctx: RenderContext = { doc, root, dispatch };

    const renderOnce = (state: SidebarStoreState): void => {
        const status = renderStatusBar(ctx, state);
        const list = renderProjectList(ctx, state.projects);
        root.replaceChildren(status, list);
    };

    // First paint — synchronous so the host sees a populated sidebar
    // immediately after `init` resolves.
    renderOnce(store.getState());

    const unsubscribe = store.subscribe((next) => {
        renderOnce(next);
    });

    let detached = false;

    return {
        render(): void {
            if (detached) return;
            renderOnce(store.getState());
        },
        destroy(): void {
            if (detached) return;
            detached = true;
            unsubscribe();
        },
    };
}
