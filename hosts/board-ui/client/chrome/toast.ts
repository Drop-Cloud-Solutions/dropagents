/**
 * AP-IFF-004 — toast queue (chrome layer).
 *
 * Public API
 * ----------
 * - {@link showToast} renders a transient `.toast` element into the
 *   `#toast-root` mount point shipped by AP-IFF-001 (`index.html`) and
 *   schedules its own dismissal after `ttlMs` (default 4000).
 *
 * Animation lifecycle
 * -------------------
 * The v1 chrome ships a `.toast` rule with `transform: translateY(60px)
 * opacity: 0 transition: all 0.3s ease`, plus a `.toast.show` rule that
 * resets the transform/opacity. To make the slide-in transition fire
 * (rather than snap into place), the toast is appended in its
 * pre-transition state and `show` is added on the next task tick via
 * `setTimeout(..., 0)`. To make the slide-out fire, `show` is removed
 * `TOAST_SLIDE_MS` before `el.remove()` so the transform/opacity
 * transition has time to play out before the node leaves the DOM.
 * For very short TTLs (≤ {@link TOAST_SLIDE_MS}) the slide-out is
 * skipped — there isn't enough time for it to be visually meaningful
 * and we'd rather honour the caller's TTL.
 *
 * Queue semantics
 * ---------------
 * Each call appends a fresh `.toast` element to `#toast-root`. Because
 * `appendChild` preserves insertion order and CSS lays the root out as
 * a vertical flex column, two toasts shown back-to-back stack
 * top-to-bottom in the order they were requested — i.e. a FIFO queue,
 * not a single-slot replacement. Per-toast TTL is owned by the toast
 * itself: every call schedules its own `setTimeout`, so a 1 s toast
 * fired immediately before a 5 s toast disappears first and leaves the
 * second one untouched.
 *
 * Renderer shape
 * --------------
 * Mirrors the {@link RenderDocument} / {@link RenderElement} approach
 * used by `hosts/board-ui/web/stage-bar.ts`: the function takes a
 * narrowly-typed document handle so unit tests can drive it with a
 * hand-rolled DOM shim and the module stays free of a hard
 * `lib: ["dom"]` dependency in `tsconfig.json`. Real browsers satisfy
 * the shape structurally — `document` and the elements it returns
 * implement the surface used here without further adaptation.
 */

/** Kind taxonomy. Drives the CSS modifier class + ARIA role. */
export type ToastKind = 'info' | 'error' | 'success';

/** Options accepted by {@link showToast}. */
export interface ShowToastOptions {
    readonly message: string;
    readonly kind?: ToastKind;
    readonly ttlMs?: number;
}

/**
 * Minimal element surface the module touches. Real `HTMLElement`
 * satisfies this; tests pass a hand-rolled shim.
 */
export interface ToastElement {
    className: string;
    textContent: string | null;
    setAttribute(name: string, value: string): void;
    remove(): void;
    appendChild(child: ToastElement): ToastElement;
}

/** Minimal document surface the module touches. */
export interface ToastDocument {
    getElementById(id: string): ToastElement | null;
    createElement(tagName: string): ToastElement;
}

/** Default time-to-live for a toast when the caller does not override it. */
export const DEFAULT_TOAST_TTL_MS = 4000;

/** DOM id of the mount target in `index.html`. */
export const TOAST_ROOT_ID = 'toast-root';

/** Base CSS class applied to every toast. */
export const TOAST_CLASS = 'toast';

/** Visibility-toggle class — pairs with the `.toast.show` rule in `board.css`. */
export const SHOW_CLASS = 'show';

/**
 * Slide transition duration in ms. Mirrors `transition: all 0.3s ease`
 * on `.toast` in `hosts/board-ui/board.css`. Used to schedule `show`
 * removal far enough ahead of `el.remove()` for the slide-out to play.
 */
export const TOAST_SLIDE_MS = 300;

/** Kind → CSS modifier class. */
export const KIND_CLASS: Readonly<Record<ToastKind, string>> = {
    info: 'toast--info',
    error: 'toast--error',
    success: 'toast--success',
};

interface MaybeGlobalDocument {
    document?: ToastDocument;
}

function resolveDocument(doc: ToastDocument | undefined): ToastDocument {
    if (doc) return doc;
    const candidate = (globalThis as MaybeGlobalDocument).document;
    if (!candidate) {
        throw new Error(
            'toast: no document available — pass one explicitly when calling '
                + 'outside a browser context.',
        );
    }
    return candidate;
}

/**
 * Render a transient toast notification.
 *
 * The toast is appended to `#toast-root` in its pre-transition state,
 * upgraded to `.toast.show` on the next tick (so the v1 slide-in
 * transition fires), then walked back through the same states on
 * dismissal: `show` removed `TOAST_SLIDE_MS` before `ttlMs` so the
 * slide-out plays, and `el.remove()` at exactly `ttlMs`. Returns the
 * freshly-created `.toast` node — callers that want to dismiss the
 * toast early can call `.remove()` on it directly. Returns `null` when
 * `#toast-root` is not present in the document (e.g. the board chrome
 * failed to mount); the caller can swallow that safely because there
 * is nowhere to render to.
 *
 * @param opts  Toast payload — `message` is required, `kind` defaults
 *              to `'info'`, `ttlMs` defaults to {@link DEFAULT_TOAST_TTL_MS}.
 * @param doc   Optional document handle for tests; defaults to
 *              `globalThis.document`.
 */
export function showToast(
    opts: ShowToastOptions,
    doc?: ToastDocument,
): ToastElement | null {
    const d = resolveDocument(doc);
    const root = d.getElementById(TOAST_ROOT_ID);
    if (!root) return null;

    const kind: ToastKind = opts.kind ?? 'info';
    const ttlMs = opts.ttlMs ?? DEFAULT_TOAST_TTL_MS;

    const baseClass = `${TOAST_CLASS} ${KIND_CLASS[kind]}`;
    const shownClass = `${baseClass} ${SHOW_CLASS}`;

    const el = d.createElement('div');
    el.className = baseClass;
    el.setAttribute('data-kind', kind);
    el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    el.textContent = opts.message;

    root.appendChild(el);

    // Defer adding `show` to the next tick so the browser commits the
    // mounted element with its pre-transition styles first; otherwise
    // the slide-in collapses to an instant snap.
    setTimeout(() => {
        el.className = shownClass;
    }, 0);

    // Slide-out: drop `show` early enough that the 300 ms transition
    // finishes by the time we actually remove the node. Skip when the
    // ttl is too short to leave room for the animation.
    if (ttlMs > TOAST_SLIDE_MS) {
        setTimeout(() => {
            el.className = baseClass;
        }, ttlMs - TOAST_SLIDE_MS);
    }

    setTimeout(() => {
        el.remove();
    }, ttlMs);

    return el;
}
