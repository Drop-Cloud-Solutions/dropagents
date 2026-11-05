/**
 * Clarify modal (AP-IFF-015).
 *
 * Single-form modal that lets the operator answer an agent's
 * NEEDS_HUMAN_INPUT prompt. Mirrors v1's clarify-task form layout
 * (overlay shell, textarea, Submit / Cancel buttons) but speaks the
 * v2 command vocabulary: Submit dispatches an `UpdateTask` command
 * carrying a `clarification` field — the same shape the v1 PATCH body
 * used for free-text answers — instead of the v1 `/clarify` HTTP
 * endpoint.
 *
 * Public API
 * ----------
 * - {@link openClarifyModal} builds the overlay + form, appends it to
 *   the supplied parent (defaults to `globalThis.document.body`), and
 *   returns a {@link ClarifyModalHandle}. The handle exposes the
 *   underlying elements plus programmatic `submit()` / `cancel()` /
 *   `close()` actions so the host can drive the modal from keyboard
 *   shortcuts or tests without going through the DOM.
 *
 * Empty-textarea contract (AC #3)
 * -------------------------------
 * Submit trims the textarea value. If the trimmed string is empty the
 * dispatch is suppressed, the modal stays open, and focus is returned
 * to the textarea so the operator can complete their answer. Cancel is
 * unaffected by the textarea contents — the operator can always bail.
 *
 * Toast feedback (reviewer feedback, attempt #2)
 * ----------------------------------------------
 * Submit surfaces dispatch outcomes through the chrome toast queue so
 * the operator gets passive confirmation without watching the board
 * refresh:
 *   - dispatch resolves → a `success` toast fires, then the modal
 *     closes and `onClose` runs;
 *   - dispatch rejects → an `error` toast fires and the modal stays
 *     open so the operator can edit + retry without retyping. The
 *     textarea is re-focused on failure to make retry painless.
 * The toast port is injected as an option so unit tests can record
 * calls without a jsdom-style document. Production defaults to the
 * `chrome/toast.ts` `showToast` function; tests pass a recording fake.
 *
 * Renderer shape
 * --------------
 * Follows the {@link ClarifyDocument} / {@link ClarifyElement}
 * structural-types pattern used elsewhere in `hosts/board-ui/client/`
 * (see `chrome/overlay-manager.ts`, `chrome/toast.ts`). The browser's
 * `document` + `HTMLElement` satisfy these interfaces structurally;
 * unit tests pass a hand-rolled shim so the module needs no jsdom
 * dependency.
 */

import {
    showToast as defaultShowToast,
    type ShowToastOptions,
} from '../chrome/toast';

// ---------------------------------------------------------------------------
// Command shape — locally defined so the modal module stays decoupled
// from the board-ui CommandBus typings. The dispatcher port lets the host
// wire this to a CommandBus, an HTTP shim, or a recording fake.
// ---------------------------------------------------------------------------

/**
 * Payload dispatched on Submit. The `clarification` field carries the
 * operator's free-text answer verbatim (already trimmed). Matches the
 * v1 free-text branch of `submitClarify` where `answer` held the
 * textarea value and `answer_key` was `"Other"`.
 */
export interface ClarifyUpdatePayload {
    readonly taskId: string;
    readonly clarification: string;
}

/** Wire shape of the command emitted on Submit. */
export interface ClarifyCommand {
    readonly type: 'UpdateTask';
    readonly payload: ClarifyUpdatePayload;
}

/**
 * Side-effect port for Submit. Production wires this to the board-ui
 * CommandBus; tests pass a fake that records each dispatched command
 * so the test can assert payload shape + call count.
 */
export interface ClarifyDispatcher {
    dispatch(command: ClarifyCommand): void | Promise<void>;
}

/**
 * Side-effect port for operator feedback toasts. Production wires this
 * to {@link defaultShowToast}; tests inject a recording fake so the
 * module stays jsdom-free. Mirrors the `showToast` shape from
 * `chrome/toast.ts` — the modal only needs the call surface, not the
 * returned element.
 */
export interface ClarifyToastPort {
    showToast(opts: ShowToastOptions): void;
}

// ---------------------------------------------------------------------------
// Structural DOM types — keep the module jsdom-free
// ---------------------------------------------------------------------------

/**
 * Minimal element surface the modal touches. Real `HTMLElement`
 * satisfies this; the test shim implements it directly. `value` is
 * only meaningful on the textarea node — other elements ignore reads
 * and writes.
 */
export interface ClarifyElement {
    className: string;
    textContent: string | null;
    /**
     * Optional — only meaningful on form-control nodes (textarea /
     * input). Modelled as optional so a structural `HTMLElement` from
     * the real DOM satisfies this shape without an explicit cast.
     */
    value?: string;
    hidden?: boolean;
    setAttribute(name: string, value: string): void;
    appendChild(child: ClarifyElement): ClarifyElement;
    remove(): void;
    focus?(): void;
}

/** Minimal document surface the modal touches. */
export interface ClarifyDocument {
    createElement(tagName: string): ClarifyElement;
}

interface ClarifyElementWithEvents extends ClarifyElement {
    onclick?: () => void;
    onsubmit?: (event?: { preventDefault?: () => void }) => void;
}

interface MaybeGlobalDocument {
    document?: ClarifyDocument & { body?: ClarifyElement };
}

function resolveDocument(doc: ClarifyDocument | undefined): ClarifyDocument {
    if (doc) return doc;
    const candidate = (globalThis as MaybeGlobalDocument).document;
    if (!candidate) {
        throw new Error(
            'clarify-modal: no document available — pass one explicitly when '
                + 'opening outside a browser context.',
        );
    }
    return candidate;
}

function resolveParent(
    parent: ClarifyElement | undefined,
    doc: ClarifyDocument,
): ClarifyElement {
    if (parent) return parent;
    const body = (doc as { body?: ClarifyElement }).body
        ?? (globalThis as MaybeGlobalDocument).document?.body;
    if (!body) {
        throw new Error(
            'clarify-modal: no parent element supplied and the document has no '
                + 'body — pass `deps.parent` explicitly.',
        );
    }
    return body;
}

function attachClick(el: ClarifyElement, handler: () => void): void {
    (el as ClarifyElementWithEvents).onclick = handler;
}

/**
 * Default toast port: forwards to the chrome `showToast` only when a
 * `globalThis.document` exists. The guard keeps the modal usable in
 * Node test contexts that don't inject a toast port — the dispatch
 * still resolves, the toast attempt is just a silent no-op instead of
 * a crash. Production browsers always have `document`, so the guard
 * never fires there.
 */
function resolveToast(toast: ClarifyToastPort | undefined): ClarifyToastPort {
    if (toast) return toast;
    return {
        showToast(opts: ShowToastOptions): void {
            if (!(globalThis as MaybeGlobalDocument).document) return;
            defaultShowToast(opts);
        },
    };
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/** CSS class hooks — exported so tests + stylesheets can pin them. */
export const CLARIFY_OVERLAY_CLASS = 'overlay clarify-overlay modal-chrome__overlay';
export const CLARIFY_PANEL_CLASS = 'panel clarify-panel modal-chrome';
export const CLARIFY_FORM_CLASS = 'clarify-form';
export const CLARIFY_TEXTAREA_CLASS = 'clarify-answer';
export const CLARIFY_SUBMIT_CLASS = 'btn btn-approve clarify-submit';
export const CLARIFY_CANCEL_CLASS = 'btn btn-skip clarify-cancel';

/** Data attributes — stable hooks for query-by-selector + a11y tests. */
export const CLARIFY_OVERLAY_TESTID = 'clarify-overlay';
export const CLARIFY_TEXTAREA_TESTID = 'clarify-answer';
export const CLARIFY_SUBMIT_TESTID = 'clarify-submit';
export const CLARIFY_CANCEL_TESTID = 'clarify-cancel';

/** Default placeholder + button labels — mirror the v1 wording. */
export const CLARIFY_DEFAULT_PLACEHOLDER =
    'Type your answer here…';
export const CLARIFY_SUBMIT_LABEL = 'Submit';
export const CLARIFY_CANCEL_LABEL = 'Cancel';

/** Toast copy fired on the Submit success / failure paths. */
export const CLARIFY_TOAST_SUCCESS_MESSAGE = 'Clarification sent.';
export const CLARIFY_TOAST_ERROR_MESSAGE =
    'Failed to send clarification. Try again.';

export interface ClarifyModalOptions {
    /** Target task whose `NEEDS_HUMAN_INPUT` block we're answering. */
    readonly taskId: string;
    /** Side-effect port — receives the `UpdateTask` command on Submit. */
    readonly dispatcher: ClarifyDispatcher;
    /**
     * Optional callback fired after the modal closes — both on Submit
     * (after dispatch resolves) and on Cancel. The host uses this to
     * trigger a board refresh or update its overlay-manager stack.
     */
    readonly onClose?: () => void;
    /**
     * Optional dialog title — defaults to a label keyed on the task id
     * so the operator can tell which card the question came from when
     * multiple clarify modals were opened back-to-back.
     */
    readonly title?: string;
    /**
     * Optional question text — typically the parsed `Question:` line
     * from the agent's NEEDS_HUMAN_INPUT block. Rendered above the
     * textarea so the operator has context while answering.
     */
    readonly question?: string;
    /** Textarea placeholder — defaults to {@link CLARIFY_DEFAULT_PLACEHOLDER}. */
    readonly placeholder?: string;
    /**
     * Optional toast port. Production omits this and falls through to
     * the chrome `showToast` import; tests pass a recording fake to
     * assert success / error toast firing without standing up a
     * jsdom-style document.
     */
    readonly toast?: ClarifyToastPort;
}

export interface ClarifyModalDeps {
    readonly doc?: ClarifyDocument;
    /**
     * Optional mount target — defaults to `document.body`. Tests pass a
     * shim element so the rendered tree is observable.
     */
    readonly parent?: ClarifyElement;
}

export interface ClarifyModalHandle {
    /** The overlay shell — the outermost node mounted under `parent`. */
    readonly overlay: ClarifyElement;
    /** The panel inside the overlay holding the form. */
    readonly panel: ClarifyElement;
    /** The form element wrapping the textarea + button row. */
    readonly form: ClarifyElement;
    /** The textarea holding the operator's answer. */
    readonly textarea: ClarifyElement;
    /** Submit button — `Submit` label, dispatches on click. */
    readonly submitButton: ClarifyElement;
    /** Cancel button — `Cancel` label, closes without dispatching. */
    readonly cancelButton: ClarifyElement;
    /**
     * Programmatic Submit. Trims the textarea value and:
     *  - returns `false` (and re-focuses the textarea) when the trimmed
     *    value is empty — no dispatch, no close, no toast;
     *  - awaits `dispatcher.dispatch({...})`. If it resolves, fires a
     *    success toast, closes the modal, and returns `true`;
     *  - if the dispatch rejects, fires an error toast, leaves the
     *    modal open (re-focuses the textarea) so the operator can edit
     *    and retry without retyping, and returns `false`.
     */
    submit(): Promise<boolean>;
    /** Programmatic Cancel — closes the modal without dispatching. */
    cancel(): void;
    /**
     * Remove the overlay from the DOM. Idempotent — calling close()
     * twice (Submit then Esc, for example) is a no-op the second time.
     */
    close(): void;
}

/**
 * Mount the clarify modal under `deps.parent` (default
 * `document.body`) and return a handle the host can use to drive it.
 *
 * The form is created in the open / pre-focused state — the textarea's
 * `focus()` is called synchronously before `openClarifyModal` returns
 * so keyboard users land in the answer field immediately. Submit /
 * Cancel are wired to the {@link ClarifyModalHandle.submit} and
 * {@link ClarifyModalHandle.cancel} methods so DOM clicks and
 * programmatic invocations follow the same code path.
 */
export function openClarifyModal(
    options: ClarifyModalOptions,
    deps?: ClarifyModalDeps,
): ClarifyModalHandle {
    const doc = resolveDocument(deps?.doc);
    const parent = resolveParent(deps?.parent, doc);
    const toast = resolveToast(options.toast);

    const overlay = doc.createElement('div');
    overlay.className = CLARIFY_OVERLAY_CLASS;
    overlay.setAttribute('data-testid', CLARIFY_OVERLAY_TESTID);
    overlay.setAttribute('data-task-id', options.taskId);
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', `clarify-title-${options.taskId}`);

    const panel = doc.createElement('div');
    panel.className = CLARIFY_PANEL_CLASS;
    overlay.appendChild(panel);

    const titleEl = doc.createElement('h3');
    titleEl.className = 'clarify-title';
    titleEl.setAttribute('id', `clarify-title-${options.taskId}`);
    titleEl.textContent = options.title ?? `Answer agent — ${options.taskId}`;
    panel.appendChild(titleEl);

    if (options.question && options.question.trim()) {
        const questionEl = doc.createElement('p');
        questionEl.className = 'clarify-question';
        questionEl.setAttribute('data-testid', 'clarify-question');
        questionEl.textContent = options.question;
        panel.appendChild(questionEl);
    }

    const form = doc.createElement('form');
    form.className = CLARIFY_FORM_CLASS;
    form.setAttribute('data-testid', 'clarify-form');
    panel.appendChild(form);

    const textarea = doc.createElement('textarea');
    textarea.className = CLARIFY_TEXTAREA_CLASS;
    textarea.setAttribute('data-testid', CLARIFY_TEXTAREA_TESTID);
    textarea.setAttribute('rows', '6');
    textarea.setAttribute(
        'placeholder',
        options.placeholder ?? CLARIFY_DEFAULT_PLACEHOLDER,
    );
    textarea.setAttribute('aria-label', 'Clarification answer');
    textarea.value = '';
    form.appendChild(textarea);

    const buttonRow = doc.createElement('div');
    buttonRow.className = 'btn-row clarify-actions';
    form.appendChild(buttonRow);

    const submitButton = doc.createElement('button');
    submitButton.className = CLARIFY_SUBMIT_CLASS;
    submitButton.setAttribute('type', 'button');
    submitButton.setAttribute('data-testid', CLARIFY_SUBMIT_TESTID);
    submitButton.textContent = CLARIFY_SUBMIT_LABEL;
    buttonRow.appendChild(submitButton);

    const cancelButton = doc.createElement('button');
    cancelButton.className = CLARIFY_CANCEL_CLASS;
    cancelButton.setAttribute('type', 'button');
    cancelButton.setAttribute('data-testid', CLARIFY_CANCEL_TESTID);
    cancelButton.textContent = CLARIFY_CANCEL_LABEL;
    buttonRow.appendChild(cancelButton);

    parent.appendChild(overlay);

    let closed = false;

    const close = (): void => {
        if (closed) return;
        closed = true;
        overlay.remove();
    };

    const cancel = (): void => {
        if (closed) return;
        close();
        options.onClose?.();
    };

    const submit = async (): Promise<boolean> => {
        if (closed) return false;
        const trimmed = (textarea.value ?? '').trim();
        if (!trimmed) {
            textarea.focus?.();
            return false;
        }
        try {
            await options.dispatcher.dispatch({
                type: 'UpdateTask',
                payload: {
                    taskId: options.taskId,
                    clarification: trimmed,
                },
            });
        } catch {
            // Dispatch failed — keep the modal open so the operator can
            // retry without retyping. Surface the failure via toast.
            toast.showToast({
                message: CLARIFY_TOAST_ERROR_MESSAGE,
                kind: 'error',
            });
            textarea.focus?.();
            return false;
        }
        toast.showToast({
            message: CLARIFY_TOAST_SUCCESS_MESSAGE,
            kind: 'success',
        });
        close();
        options.onClose?.();
        return true;
    };

    attachClick(submitButton, () => {
        // Fire-and-forget — the click handler can't await without
        // becoming async, which would change the onclick signature
        // browsers and the test shim share. `submit()` itself
        // catches dispatcher rejections and routes them to the error
        // toast, so the returned promise should never reject here.
        void submit();
    });

    attachClick(cancelButton, () => {
        cancel();
    });

    // Pre-focus the textarea so keyboard users start typing immediately.
    textarea.focus?.();

    return {
        overlay,
        panel,
        form,
        textarea,
        submitButton,
        cancelButton,
        submit,
        cancel,
        close,
    };
}
