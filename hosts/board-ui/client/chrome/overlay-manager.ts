/**
 * Overlay manager (AP-IFF-002).
 *
 * Owns the lifecycle of stacked modal overlays mounted under
 * `#overlay-root` (introduced by AP-IFF-001). The manager:
 *
 *  - keeps an array-based stack of overlay handles in open order,
 *  - flips `aria-hidden` on the registered element so assistive
 *    technology hides closed overlays and reveals open ones,
 *  - captures the previously-focused element on open and restores it on
 *    close so keyboard users land back where they started,
 *  - binds a SINGLE document-level `keydown` listener that closes only
 *    the topmost overlay when Escape is pressed — outer overlays
 *    remain open until they're explicitly the top of the stack.
 *
 * No framework dependency: plain TypeScript class compiled into the
 * board bundle. The `OverlayDocument` / `OverlayElement` interfaces are
 * narrow structural shapes so the unit tests can drive the manager with
 * a hand-rolled DOM shim — mirrors the testability pattern already in
 * use under `hosts/board-ui/web/stage-bar.ts`.
 */

// ---------------------------------------------------------------------------
// Structural DOM interfaces
// ---------------------------------------------------------------------------

/**
 * Anything the manager treats as "the thing currently holding focus".
 * `focus` is optional so non-focusable elements (text nodes, body) can
 * sit at the top of the document without breaking the manager — the
 * call site uses optional chaining when restoring focus.
 */
export interface OverlayFocusable {
    focus?(): void;
}

/**
 * Minimal element surface the manager touches. The real DOM's
 * `HTMLElement` satisfies this structurally; the test shim implements
 * it directly.
 */
export interface OverlayElement {
    setAttribute(name: string, value: string): void;
}

/**
 * Structural shape of a `keydown` `KeyboardEvent`. `defaultPrevented`
 * lets the manager cooperate with other Escape handlers that have
 * already claimed the event (e.g. an inline autocomplete inside the
 * overlay).
 */
export interface OverlayKeyboardEvent {
    readonly key: string;
    readonly defaultPrevented: boolean;
    preventDefault(): void;
}

export type OverlayKeydownListener = (event: OverlayKeyboardEvent) => void;

/**
 * The document subset the manager consumes. Keeping this narrow means
 * we don't pull `lib: ["dom"]` into `tsconfig.json` for a single widget.
 */
export interface OverlayDocument {
    readonly activeElement: OverlayFocusable | null;
    addEventListener(type: 'keydown', listener: OverlayKeydownListener): void;
    removeEventListener(type: 'keydown', listener: OverlayKeydownListener): void;
}

/**
 * One entry in the overlay stack. Exposed via {@link OverlayManager.getStack}
 * so the operator UI can introspect what is currently open (e.g. to
 * skip rendering a fresh focus trap when a nested overlay already
 * owns focus).
 */
export interface OverlayHandle {
    readonly id: string;
    readonly element: OverlayElement;
    readonly previouslyFocused: OverlayFocusable | null;
}

// ---------------------------------------------------------------------------
// Document resolution
// ---------------------------------------------------------------------------

interface MaybeGlobalDocument {
    document?: OverlayDocument;
}

function resolveDocument(doc: OverlayDocument | undefined): OverlayDocument {
    if (doc) return doc;
    const candidate = (globalThis as MaybeGlobalDocument).document;
    if (!candidate) {
        throw new Error(
            'overlay-manager: no document available — pass one explicitly when '
                + 'constructing outside a browser context.',
        );
    }
    return candidate;
}

// ---------------------------------------------------------------------------
// OverlayManager
// ---------------------------------------------------------------------------

export class OverlayManager {
    private readonly doc: OverlayDocument;
    private readonly stack: OverlayHandle[] = [];

    /**
     * Stable handler reference so `addEventListener` /
     * `removeEventListener` reliably pair up. The listener intentionally
     * bails out when another handler has already called
     * `preventDefault()` so the manager doesn't trample on overlay-local
     * Escape behaviour.
     */
    private readonly onKeydown: OverlayKeydownListener = (event) => {
        if (event.key !== 'Escape') return;
        if (event.defaultPrevented) return;
        const top = this.stack[this.stack.length - 1];
        if (!top) return;
        event.preventDefault();
        this.closeOverlay(top.id);
    };

    constructor(doc?: OverlayDocument) {
        this.doc = resolveDocument(doc);
        this.doc.addEventListener('keydown', this.onKeydown);
    }

    /**
     * Register an overlay element and push it onto the stack. The
     * element receives `aria-hidden="false"`; the previously-focused
     * element is captured for later restoration. Re-opening an already
     * open overlay is a programming error — the caller must close
     * first.
     */
    openOverlay(id: string, element: OverlayElement): OverlayHandle {
        if (this.stack.some((entry) => entry.id === id)) {
            throw new Error(`overlay-manager: overlay "${id}" is already open`);
        }
        const previouslyFocused = this.doc.activeElement;
        element.setAttribute('aria-hidden', 'false');
        const handle: OverlayHandle = { id, element, previouslyFocused };
        this.stack.push(handle);
        return handle;
    }

    /**
     * Remove the overlay with the given id from the stack. Sets
     * `aria-hidden="true"` on the element and calls `.focus()` on the
     * captured `previouslyFocused` reference (when one exists and is
     * focusable). A no-op when the id is not currently registered, so
     * callers can issue close requests defensively.
     */
    closeOverlay(id: string): void {
        const idx = this.stack.findIndex((entry) => entry.id === id);
        if (idx === -1) return;
        const [entry] = this.stack.splice(idx, 1);
        entry.element.setAttribute('aria-hidden', 'true');
        entry.previouslyFocused?.focus?.();
    }

    /**
     * Close every overlay in reverse (top-to-bottom) order. Used at
     * route transitions and when the operator nukes a plan card — any
     * dangling overlay attached to the removed task must come down so
     * its `aria-hidden="true"` invariant is preserved.
     */
    closeAll(): void {
        while (this.stack.length > 0) {
            const top = this.stack[this.stack.length - 1];
            this.closeOverlay(top.id);
        }
    }

    /**
     * Snapshot of the current stack. Returned as a fresh array so
     * callers cannot mutate internal state — observers should treat
     * the entries as read-only.
     */
    getStack(): ReadonlyArray<OverlayHandle> {
        return this.stack.slice();
    }

    /**
     * Detach the document listener and drop all entries. Tests call
     * this between cases so a stray Escape from one case can't trigger
     * a closeOverlay in the next. Production code keeps the singleton
     * alive for the lifetime of the board bundle and never disposes.
     */
    dispose(): void {
        this.doc.removeEventListener('keydown', this.onKeydown);
        this.stack.length = 0;
    }
}

// ---------------------------------------------------------------------------
// Singleton accessor
// ---------------------------------------------------------------------------

let singleton: OverlayManager | null = null;

/**
 * Lazily construct (and cache) the process-wide manager bound to the
 * ambient `globalThis.document`. Importing this module in a non-browser
 * context (e.g. a test bootstrap that constructs its own manager with a
 * shim document) is safe because resolution is deferred until first
 * call.
 */
export function getOverlayManager(): OverlayManager {
    if (!singleton) singleton = new OverlayManager();
    return singleton;
}
