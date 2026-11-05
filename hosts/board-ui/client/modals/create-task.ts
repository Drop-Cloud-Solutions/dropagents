// IMPORTANT: any change here requires `npm run build:board` before it is visible in the board.js bundle.
/**
 * Create-task modal (AP-FP-006).
 *
 * Operator-facing overlay for creating a new task. Mirrors the
 * structural-DOM + lifecycle approach of {@link ./new-plan} (no jsdom
 * in tests; the renderer touches a narrow {@link ModalDocument} /
 * {@link ModalElement} surface) but stays single-step: there is no
 * planner poll, no review screen, no projection subscription.
 *
 * DOM shape
 * ---------
 *   <div class="modal-overlay" data-create-task-overlay>           ← backdrop, closes on click
 *     <div class="modal-card new-plan-modal modal-chrome"          ← centered card (chrome
 *          data-create-task-card                                     classes lifted from
 *          role="dialog" aria-modal="true">                          new-plan.ts for visual
 *       <h3 id="create-task-title">New task</h3>                     parity)
 *       <input data-input="title" />
 *       <textarea data-input="body" />
 *       <button data-action="cancel">Cancel</button>
 *       <button data-action="submit">Create task</button>
 *     </div>
 *   </div>
 *
 * Lifecycle
 * ---------
 * - ESC: closes via an injected {@link KeydownPort}. Production wires
 *   this to `document.addEventListener('keydown', ...)`; tests pass a
 *   fake so they can synthesise key presses without jsdom.
 * - Click-outside: the overlay's `onclick` closes when the click target
 *   is the overlay itself; clicks bubbling up from the card carry a
 *   non-overlay target and are ignored. Tests drive both branches by
 *   invoking `overlay.onclick({ target })` directly with the appropriate
 *   target.
 * - Submit: POSTs `{ title, body?, projectId?, planId? }` as JSON to
 *   `${apiBase}${tasksPath}` (default `${apiBase}/tasks`) via an
 *   injected {@link FetchFn}. On a non-OK status the modal stays open
 *   and surfaces a toast; on success the modal closes and the optional
 *   `onSubmit` callback fires with the payload.
 *
 * TODO(AP-FP-006): the worker-api does NOT currently expose a POST
 * `/tasks` create endpoint — `hosts/worker-api/routes/tasks.ts` only
 * handles parked-task action verbs (clarify / reject /
 * investigation-followup). Per the AP-FP-006 operator clarification
 * the submit POSTs a placeholder URL so the modal wiring is stable;
 * landing this for real needs a companion backend task that adds the
 * create-task command + worker-api route. Once that lands, point the
 * `tasksPath` option at the real path (and update the AP-FP-006 wiring
 * in board.ts to inject the worker-api base + auth).
 */

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

/** Stable identifier for the create-task overlay panel, mirroring
 *  {@link ./new-plan.NEW_PLAN_OVERLAY_ID}. */
export const CREATE_TASK_OVERLAY_ID = 'create-task';

/** DOM id of the default mount target. Matches AP-IFF-001 `#overlay-root`. */
export const OVERLAY_ROOT_ID = 'overlay-root';

/** Default path appended to `apiBase` for the create-task POST. */
export const DEFAULT_TASKS_PATH = '/tasks';

// ---------------------------------------------------------------------------
// Structural DOM types — kept narrow so tests can drive the renderer
// without spinning up jsdom (same approach as new-plan.ts / new-project.ts).
// ---------------------------------------------------------------------------

export interface ModalEvent {
    preventDefault?(): void;
    /** The element the synthetic click "happened on". The overlay handler
     *  uses this to distinguish a backdrop click (target === overlay)
     *  from a bubbled click that originated in the card. */
    target?: unknown;
}

export interface ModalElement {
    className: string;
    textContent: string | null;
    value?: string;
    setAttribute(name: string, value: string): void;
    appendChild(child: ModalElement): ModalElement;
    replaceChildren(...children: ModalElement[]): void;
    remove(): void;
}

export interface ModalDocument {
    getElementById(id: string): ModalElement | null;
    createElement(tagName: string): ModalElement;
}

interface ModalElementWithEvents extends ModalElement {
    onclick?: (event?: ModalEvent) => void;
    onsubmit?: (event?: ModalEvent) => void;
    oninput?: () => void;
}

// ---------------------------------------------------------------------------
// Keydown port — narrow wrapper around document.addEventListener('keydown')
// ---------------------------------------------------------------------------

export interface CreateTaskKeydown {
    readonly key: string;
}

export type CreateTaskKeydownUnsub = () => void;

export interface KeydownPort {
    /** Register a key listener. Returns an unsubscribe handle that the
     *  modal calls during close() so listeners do not leak across opens. */
    addListener(handler: (event: CreateTaskKeydown) => void): CreateTaskKeydownUnsub;
}

// ---------------------------------------------------------------------------
// Fetch port — production wires to globalThis.fetch; tests pass a fake.
// ---------------------------------------------------------------------------

export interface FetchResponseLike {
    readonly ok: boolean;
    readonly status: number;
    text?(): Promise<string>;
    json?(): Promise<unknown>;
}

export interface FetchRequestInit {
    readonly method: string;
    readonly headers?: Record<string, string>;
    readonly body?: string;
}

export type FetchFn = (url: string, init: FetchRequestInit) => Promise<FetchResponseLike>;

// ---------------------------------------------------------------------------
// Toast port — structural subset of the AP-IFF-004 toast queue.
// ---------------------------------------------------------------------------

export type ToastKind = 'info' | 'error' | 'success';

export interface ToastInput {
    readonly message: string;
    readonly kind?: ToastKind;
}

export type ShowToastFn = (input: ToastInput) => void;

// ---------------------------------------------------------------------------
// Submit payload + factory options
// ---------------------------------------------------------------------------

export interface CreateTaskSubmitPayload {
    readonly title: string;
    readonly body?: string;
    readonly projectId?: string;
    readonly planId?: string;
}

export interface CreateTaskOptions {
    /** Forwarded into the submit payload when set. */
    readonly projectId?: string;
    /** Forwarded into the submit payload when set. */
    readonly planId?: string;
    /** Base URL prefix for the worker-api proxy. Defaults to empty
     *  (same-origin board fetch — the production board adapter strips
     *  trailing slashes the same way, mirroring board.js's API_BASE). */
    readonly apiBase?: string;
    /** Path appended to {@link CreateTaskOptions.apiBase} for the POST.
     *  Defaults to {@link DEFAULT_TASKS_PATH}. Override once the real
     *  create-task endpoint lands. */
    readonly tasksPath?: string;
    readonly doc?: ModalDocument;
    /** Optional mount root. Defaults to `#overlay-root`. */
    readonly mountRoot?: ModalElement;
    readonly fetch?: FetchFn;
    readonly keydown?: KeydownPort;
    readonly showToast?: ShowToastFn;
    /** Called after the modal closes for any reason (ESC, click-outside,
     *  cancel button, successful submit, programmatic close). */
    readonly onClose?: () => void;
    /** Called with the final POSTed payload after a successful submit.
     *  Tests assert this to confirm the dispatch payload independently
     *  of the fetch URL/body. */
    readonly onSubmit?: (payload: CreateTaskSubmitPayload) => void;
}

export interface CreateTaskModalHandle {
    /** Detach the panel and release listeners. Idempotent. */
    close(): void;
    /** Programmatically submit the form. Used by tests and by the
     *  bound `Create task` button. */
    submit(payload: { readonly title: string; readonly body?: string }): Promise<void>;
    /** True while the panel is mounted. */
    isOpen(): boolean;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

function resolveDoc(d: ModalDocument | undefined): ModalDocument {
    if (d) return d;
    const candidate = (globalThis as { document?: ModalDocument }).document;
    if (!candidate) {
        throw new Error(
            'create-task modal: no document available — pass one explicitly when '
                + 'rendering outside a browser context.',
        );
    }
    return candidate;
}

interface DomLike {
    addEventListener?: (type: string, handler: (ev: { key: string }) => void) => void;
    removeEventListener?: (type: string, handler: (ev: { key: string }) => void) => void;
}

function defaultKeydownPort(): KeydownPort {
    return {
        addListener(handler): CreateTaskKeydownUnsub {
            const dom = (globalThis as { document?: DomLike }).document;
            if (!dom?.addEventListener) return (): void => undefined;
            const wrap = (ev: { key: string }): void => handler({ key: ev.key });
            dom.addEventListener('keydown', wrap);
            return (): void => {
                dom.removeEventListener?.('keydown', wrap);
            };
        },
    };
}

function defaultFetch(): FetchFn {
    return (url, init): Promise<FetchResponseLike> => {
        const f = (globalThis as { fetch?: FetchFn }).fetch;
        if (typeof f !== 'function') {
            return Promise.reject(
                new Error('create-task modal: no fetch available — pass one explicitly.'),
            );
        }
        return f(url, init);
    };
}

// ---------------------------------------------------------------------------
// Single public entry point
// ---------------------------------------------------------------------------

export function openCreateTaskModal(opts: CreateTaskOptions = {}): CreateTaskModalHandle {
    const doc = resolveDoc(opts.doc);
    const keydown = opts.keydown ?? defaultKeydownPort();
    const fetchFn = opts.fetch ?? defaultFetch();
    const apiBase = (opts.apiBase ?? '').replace(/\/+$/, '');
    const tasksPath = opts.tasksPath ?? DEFAULT_TASKS_PATH;

    const mountRoot = opts.mountRoot ?? doc.getElementById(OVERLAY_ROOT_ID);
    if (!mountRoot) {
        throw new Error(
            `create-task modal: mount root "#${OVERLAY_ROOT_ID}" not found and no `
                + 'mountRoot option supplied.',
        );
    }

    let mounted = true;
    let titleInput: ModalElementWithEvents | null = null;
    let bodyInput: ModalElementWithEvents | null = null;

    const overlay = doc.createElement('div') as ModalElementWithEvents;
    overlay.className = 'modal-overlay';
    overlay.setAttribute('data-create-task-overlay', '');
    overlay.setAttribute('data-overlay-id', CREATE_TASK_OVERLAY_ID);
    overlay.setAttribute('role', 'presentation');

    const card = doc.createElement('div') as ModalElementWithEvents;
    // .modal-card carries the cross-modal structural marker the AP-FP-006
    // acceptance criteria pin on; the trailing `new-plan-modal modal-chrome`
    // classes apply the same visual chrome new-plan.ts uses so the two
    // modals look consistent without forking the stylesheet.
    card.className = 'modal-card new-plan-modal modal-chrome';
    card.setAttribute('data-create-task-card', '');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-labelledby', 'create-task-title');

    overlay.onclick = (ev): void => {
        // Only treat the click as a backdrop dismiss when the target IS
        // the overlay itself. In a real browser the click bubbles up from
        // the card with `event.target === cardEl`; the shim tests drive
        // both branches by passing the appropriate `target`.
        if (ev && 'target' in ev && ev.target !== undefined && ev.target !== overlay) return;
        close();
    };
    // The card's onclick is intentionally a no-op rather than absent —
    // it gives the production browser path a hook to call
    // `event.stopPropagation()` if the project later upgrades to a
    // typed-event surface. With the current () => void shape it just
    // documents that clicks inside the card should not close the modal.
    card.onclick = (): void => undefined;

    overlay.appendChild(card);
    mountRoot.appendChild(overlay);

    buildForm();

    const keydownUnsub = keydown.addListener((event) => {
        if (event.key === 'Escape') close();
    });

    function buildForm(): void {
        const heading = doc.createElement('h3');
        heading.setAttribute('id', 'create-task-title');
        heading.textContent = 'New task';
        card.appendChild(heading);

        titleInput = doc.createElement('input') as ModalElementWithEvents;
        titleInput.setAttribute('type', 'text');
        titleInput.setAttribute('data-input', 'title');
        titleInput.setAttribute('aria-label', 'Task title');
        titleInput.value = '';
        card.appendChild(titleInput);

        bodyInput = doc.createElement('textarea') as ModalElementWithEvents;
        bodyInput.setAttribute('data-input', 'body');
        bodyInput.setAttribute('aria-label', 'Task description');
        bodyInput.value = '';
        card.appendChild(bodyInput);

        const cancel = doc.createElement('button') as ModalElementWithEvents;
        cancel.setAttribute('type', 'button');
        cancel.setAttribute('data-action', 'cancel');
        cancel.className = 'np-button';
        cancel.textContent = 'Cancel';
        cancel.onclick = (): void => close();
        card.appendChild(cancel);

        const submitBtn = doc.createElement('button') as ModalElementWithEvents;
        submitBtn.setAttribute('type', 'button');
        submitBtn.setAttribute('data-action', 'submit');
        submitBtn.className = 'np-button';
        submitBtn.textContent = 'Create task';
        submitBtn.onclick = (): void => {
            const title = titleInput?.value ?? '';
            const body = bodyInput?.value ?? '';
            void submit({ title, body });
        };
        card.appendChild(submitBtn);
    }

    async function submit(payload: {
        readonly title: string;
        readonly body?: string;
    }): Promise<void> {
        if (!mounted) return;
        const title = (payload.title ?? '').trim();
        if (title.length === 0) {
            opts.showToast?.({ message: 'Title is required', kind: 'error' });
            return;
        }
        const body = payload.body ?? '';
        const fullPayload: CreateTaskSubmitPayload = {
            title,
            ...(body.length > 0 ? { body } : {}),
            ...(opts.projectId !== undefined ? { projectId: opts.projectId } : {}),
            ...(opts.planId !== undefined ? { planId: opts.planId } : {}),
        };
        const url = `${apiBase}${tasksPath}`;
        let res: FetchResponseLike;
        try {
            res = await fetchFn(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(fullPayload),
            });
        } catch (err) {
            if (!mounted) return;
            const message = err instanceof Error && err.message
                ? err.message
                : 'Create task failed';
            opts.showToast?.({ message, kind: 'error' });
            return;
        }
        if (!mounted) return;
        if (!res.ok) {
            opts.showToast?.({
                message: `Create task failed (${res.status})`,
                kind: 'error',
            });
            return;
        }
        opts.onSubmit?.(fullPayload);
        close();
    }

    function close(): void {
        if (!mounted) return;
        mounted = false;
        keydownUnsub();
        overlay.remove();
        opts.onClose?.();
    }

    return {
        close,
        submit,
        isOpen(): boolean {
            return mounted;
        },
    };
}
