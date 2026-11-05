/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Context-update curator panel (AP-IFG-022).
 *
 * Drives the operator-facing surface that surfaces every task currently
 * parked at the `context-update-curator` step (task-006). The panel
 * mirrors the pattern established by `./board-crud.ts` — pure controller
 * + pure renderer, both injectable so the unit tests do not pull in jsdom.
 *
 * The controller hits three new endpoints exposed by
 * `hosts/board-ui/server.ts`:
 *
 *   GET  /context-updates/pending                  — proxied to worker-api
 *   POST /tasks/:tid/context-update/run            — RunContextUpdate command
 *   POST /tasks/:tid/context-update/skip           — SkipContextUpdate command
 *
 * After every Run / Skip dispatch the pending list is refetched so a
 * successful action drops the row even without an inbound SSE event. The
 * existing event stream still flows into `board.js` untouched — this
 * module is layered alongside the SSE projection, not on top of it.
 *
 * The browser-side mirror lives in `hosts/board-ui/board.js`. If you
 * change a derivation here, change the .js mirror too — the test target
 * is this `.ts` file (see `./context-updates.test.ts`).
 */

// ---------------------------------------------------------------------------
// Projection shapes (mirror the worker-api response body)
// ---------------------------------------------------------------------------

/**
 * One row in the pending CLAUDE.md PR list. `summary` is the
 * curator-generated short description of the proposed diff (operator's
 * primary triage signal); `prNumber` and `planId` are surfaced when the
 * worker-api has them so the operator can cross-link without leaving the
 * board.
 */
export interface PendingContextUpdate {
    readonly taskId: string;
    readonly summary: string;
    readonly planId?: string;
    readonly prNumber?: number;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface ContextUpdatesState {
    readonly pending: ReadonlyArray<PendingContextUpdate>;
    /** Populated by a failed load so the renderer can surface the message
     *  next to the panel rather than hiding the failure in a console.warn. */
    readonly loadError: string | null;
    /**
     * Per-task dispatch errors keyed by `taskId`. Cleared when a dispatch
     * succeeds for that task (or when the panel reloads).
     */
    readonly dispatchErrors: Readonly<Record<string, string>>;
    /**
     * Tasks whose run / skip dispatch is in flight, keyed by `taskId`. The
     * renderer disables both buttons for in-flight rows so an
     * impatient double-click cannot send two commands for the same task.
     */
    readonly inFlight: ReadonlyArray<string>;
}

export function initialContextUpdatesState(): ContextUpdatesState {
    return {
        pending: [],
        loadError: null,
        dispatchErrors: {},
        inFlight: [],
    };
}

// ---------------------------------------------------------------------------
// FetchLike — structural subset of the browser fetch
// ---------------------------------------------------------------------------

export interface FetchResponseLike {
    readonly ok: boolean;
    readonly status: number;
    json(): Promise<unknown>;
}

export interface FetchRequestInit {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
}

export type FetchLike = (
    input: string,
    init?: FetchRequestInit,
) => Promise<FetchResponseLike>;

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

export interface ContextUpdatesDeps {
    readonly fetch: FetchLike;
    readonly apiBase?: string;
    readonly onChange?: (state: ContextUpdatesState) => void;
    readonly logger?: { warn: (message: string, ...args: unknown[]) => void };
}

export interface ContextUpdatesController {
    state(): ContextUpdatesState;
    loadPending(): Promise<void>;
    runUpdate(taskId: string): Promise<void>;
    skipUpdate(taskId: string): Promise<void>;
}

/**
 * Build the panel controller. Single mutable `state` cell that every
 * method swaps atomically; `onChange` is invoked on every transition so
 * the caller can re-render without polling `state()`.
 */
export function createContextUpdatesController(
    deps: ContextUpdatesDeps,
): ContextUpdatesController {
    const apiBase = (deps.apiBase ?? '').replace(/\/+$/, '');
    let current: ContextUpdatesState = initialContextUpdatesState();

    const setState = (next: ContextUpdatesState): void => {
        current = next;
        deps.onChange?.(current);
    };

    const readErrorMessage = async (res: FetchResponseLike): Promise<string> => {
        try {
            const body = (await res.json()) as {
                error?: unknown;
                message?: unknown;
            };
            if (body && typeof body.error === 'string' && body.error) return body.error;
            if (body && typeof body.message === 'string' && body.message) {
                return body.message;
            }
        } catch {
            // fall through
        }
        return `Request failed (HTTP ${res.status})`;
    };

    const loadPending = async (): Promise<void> => {
        let res: FetchResponseLike;
        try {
            res = await deps.fetch(`${apiBase}/context-updates/pending`, {
                method: 'GET',
            });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            deps.logger?.warn('context-updates: GET /context-updates/pending threw', message);
            setState({ ...current, loadError: message });
            return;
        }
        if (!res.ok) {
            const message = await readErrorMessage(res);
            deps.logger?.warn('context-updates: GET /context-updates/pending failed', res.status);
            setState({ ...current, loadError: message });
            return;
        }
        const json = (await res.json()) as {
            pending?: ReadonlyArray<PendingContextUpdate>;
        };
        const pending: ReadonlyArray<PendingContextUpdate> =
            json && Array.isArray(json.pending) ? json.pending : [];
        setState({ ...current, pending, loadError: null });
    };

    const dispatch = async (
        method: string,
        path: string,
        taskId: string,
    ): Promise<void> => {
        // Mark in-flight + clear any stale per-task error before the
        // round-trip. The renderer disables the row's buttons while the
        // task id is in `inFlight`.
        const nextErrors = { ...current.dispatchErrors };
        delete nextErrors[taskId];
        setState({
            ...current,
            dispatchErrors: nextErrors,
            inFlight: [...current.inFlight, taskId],
        });

        let res: FetchResponseLike;
        try {
            res = await deps.fetch(`${apiBase}${path}`, { method });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            deps.logger?.warn(`context-updates: ${method} ${path} threw`, message);
            setState({
                ...current,
                dispatchErrors: { ...current.dispatchErrors, [taskId]: message },
                inFlight: current.inFlight.filter((id) => id !== taskId),
            });
            return;
        }
        if (!res.ok) {
            const message = await readErrorMessage(res);
            deps.logger?.warn(`context-updates: ${method} ${path} failed`, res.status);
            setState({
                ...current,
                dispatchErrors: { ...current.dispatchErrors, [taskId]: message },
                inFlight: current.inFlight.filter((id) => id !== taskId),
            });
            return;
        }
        setState({
            ...current,
            inFlight: current.inFlight.filter((id) => id !== taskId),
        });
        // Refetch so the row disappears even before the inbound event
        // arrives. The new GET resets `loadError`.
        await loadPending();
    };

    const runUpdate = (taskId: string): Promise<void> =>
        dispatch('POST', `/tasks/${encodeURIComponent(taskId)}/context-update/run`, taskId);

    const skipUpdate = (taskId: string): Promise<void> =>
        dispatch('POST', `/tasks/${encodeURIComponent(taskId)}/context-update/skip`, taskId);

    return {
        state: () => current,
        loadPending,
        runUpdate,
        skipUpdate,
    };
}

// ---------------------------------------------------------------------------
// Renderer — pure function over ContextUpdatesState
// ---------------------------------------------------------------------------

export interface RenderElement {
    className: string;
    textContent: string | null;
    title: string;
    hidden: boolean;
    setAttribute(name: string, value: string): void;
    appendChild(child: RenderElement): RenderElement;
}

export interface RenderDocument {
    createElement(tagName: string): RenderElement;
}

interface RenderElementWithEvents extends RenderElement {
    onclick?: () => void;
    disabled?: boolean;
}

export interface ContextUpdateHandlers {
    readonly onRun: (taskId: string) => void;
    readonly onSkip: (taskId: string) => void;
}

interface MaybeGlobalDocument {
    document?: RenderDocument;
}

function resolveDocument(doc: RenderDocument | undefined): RenderDocument {
    if (doc) return doc;
    const candidate = (globalThis as MaybeGlobalDocument).document;
    if (!candidate) {
        throw new Error(
            'context-updates: no document available — pass one explicitly '
                + 'when rendering outside a browser context.',
        );
    }
    return candidate;
}

function attachClick(el: RenderElement, handler: () => void): void {
    (el as RenderElementWithEvents).onclick = handler;
}

function makeButton(
    doc: RenderDocument,
    label: string,
    action: string,
    onClick: () => void,
    disabled: boolean,
): RenderElement {
    const btn = doc.createElement('button');
    btn.setAttribute('type', 'button');
    btn.setAttribute('data-action', action);
    btn.textContent = label;
    if (disabled) {
        (btn as RenderElementWithEvents).disabled = true;
        btn.setAttribute('disabled', 'disabled');
        btn.setAttribute('aria-busy', 'true');
    }
    attachClick(btn, onClick);
    return btn;
}

/**
 * Render the pending CLAUDE.md PR list. Returns the root `<ul>` ready to
 * be appended to a host slot. DOM shape (stable for board.css + tests):
 *
 *   <ul class="context-updates" data-context-updates>
 *     <li class="context-update-row" data-task-id="...">
 *       <span class="context-update-summary">…</span>
 *       <span class="context-update-pr">PR #N</span>?         (optional)
 *       <span class="context-update-plan">plan-id</span>?     (optional)
 *       <button data-action="run-context-update">Run</button>
 *       <button data-action="skip-context-update">Skip</button>
 *       <span class="form-error" data-error-for="dispatch">…</span>? (optional)
 *     </li>
 *     …
 *     <li class="context-updates-empty" data-empty>No pending context updates</li>?
 *     <li class="context-updates-error" data-error-for="load">…</li>?
 *   </ul>
 */
export function renderPendingList(
    state: ContextUpdatesState,
    handlers: ContextUpdateHandlers,
    doc?: RenderDocument,
): RenderElement {
    const d = resolveDocument(doc);
    const root = d.createElement('ul');
    root.className = 'context-updates';
    root.setAttribute('data-context-updates', '');

    const inFlight = new Set(state.inFlight);

    if (state.loadError) {
        const slot = d.createElement('li');
        slot.className = 'context-updates-error';
        slot.setAttribute('data-error-for', 'load');
        slot.setAttribute('role', 'alert');
        slot.textContent = state.loadError;
        root.appendChild(slot);
    }

    if (state.pending.length === 0 && !state.loadError) {
        const empty = d.createElement('li');
        empty.className = 'context-updates-empty';
        empty.setAttribute('data-empty', '');
        empty.textContent = 'No pending context updates';
        root.appendChild(empty);
        return root;
    }

    for (const entry of state.pending) {
        const row = d.createElement('li');
        row.className = 'context-update-row';
        row.setAttribute('data-context-update-row', '');
        row.setAttribute('data-task-id', entry.taskId);

        const summary = d.createElement('span');
        summary.className = 'context-update-summary';
        summary.setAttribute('data-context-update-summary', '');
        summary.textContent = entry.summary;
        row.appendChild(summary);

        if (typeof entry.prNumber === 'number' && entry.prNumber > 0) {
            const pr = d.createElement('span');
            pr.className = 'context-update-pr';
            pr.setAttribute('data-context-update-pr', '');
            pr.textContent = `PR #${entry.prNumber}`;
            row.appendChild(pr);
        }
        if (entry.planId) {
            const plan = d.createElement('span');
            plan.className = 'context-update-plan';
            plan.setAttribute('data-context-update-plan', '');
            plan.textContent = entry.planId;
            row.appendChild(plan);
        }

        const busy = inFlight.has(entry.taskId);
        row.appendChild(
            makeButton(d, 'Run', 'run-context-update', () => handlers.onRun(entry.taskId), busy),
        );
        row.appendChild(
            makeButton(d, 'Skip', 'skip-context-update', () => handlers.onSkip(entry.taskId), busy),
        );

        const dispatchError = state.dispatchErrors[entry.taskId];
        if (dispatchError) {
            const slot = d.createElement('span');
            slot.className = 'form-error';
            slot.setAttribute('data-error-for', 'dispatch');
            slot.setAttribute('data-task-id', entry.taskId);
            slot.setAttribute('role', 'alert');
            slot.textContent = dispatchError;
            row.appendChild(slot);
        }

        root.appendChild(row);
    }

    return root;
}
