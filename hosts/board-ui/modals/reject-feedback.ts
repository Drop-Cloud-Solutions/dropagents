/**
 * Reject-feedback modal (AP-VP5-012).
 *
 * The minimal "why are you rejecting?" prompt the operator sees when they
 * click Reject on a commit-approval card. The modal is intentionally tiny:
 *
 *   1. A `<textarea>` for the feedback.
 *   2. A primary Reject button — disabled until the textarea has
 *      non-whitespace content.
 *   3. A secondary Cancel button.
 *
 * On Reject the modal POSTs to the AP-VP5-008 endpoint
 * `POST /tasks/:id/reject` with body `{ feedback }`. The worker-api dispatches
 * `ResumeTask{ taskId, decision: 'reject', feedback }` onto the command bus
 * and answers 202; the modal closes on that status code. A non-202 response
 * leaves the modal open so the operator can retry without retyping (the
 * optional `onError` hook lets the host surface a toast).
 *
 * Renderer shape — structural DOM types so unit tests drive the module with
 * a hand-rolled shim. Mirrors the pattern in
 * `hosts/board-ui/client/modals/clarify.ts` and `hosts/board-ui/panels/notes.ts`.
 *
 * Cancel + Escape both close the modal without dispatching. The Escape
 * handler is wired through an injectable `keyTarget` port so the modal can
 * subscribe to a real `document` in the browser, a hand-rolled fake in
 * tests, or skip the subscription entirely when neither is supplied — in
 * which case the host can drive Escape through {@link RejectFeedbackHandle.handleKeydown}.
 */

// ---------------------------------------------------------------------------
// HTTP port — minimal fetch surface the modal touches
// ---------------------------------------------------------------------------

export interface RejectFeedbackResponse {
    readonly ok: boolean;
    readonly status: number;
}

export interface RejectFeedbackFetchInit {
    readonly method?: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: string;
}

export type RejectFeedbackFetch = (
    url: string,
    init?: RejectFeedbackFetchInit,
) => Promise<RejectFeedbackResponse>;

// ---------------------------------------------------------------------------
// Structural DOM types — keep tests jsdom-free
// ---------------------------------------------------------------------------

export interface RejectFeedbackElement {
    className: string;
    textContent: string | null;
    /** Form-control value slot. Only meaningful on the textarea. */
    value?: string;
    /** Mirrors the HTMLButtonElement `disabled` property. */
    disabled?: boolean;
    setAttribute(name: string, value: string): void;
    removeAttribute(name: string): void;
    appendChild(child: RejectFeedbackElement): RejectFeedbackElement;
    remove(): void;
    focus?(): void;
}

interface RejectFeedbackElementWithEvents extends RejectFeedbackElement {
    onclick?: () => void;
    oninput?: () => void;
}

export interface RejectFeedbackDocument {
    createElement(tagName: string): RejectFeedbackElement;
}

interface MaybeGlobalDocument {
    document?: RejectFeedbackDocument & { body?: RejectFeedbackElement };
}

function resolveDocument(doc: RejectFeedbackDocument | undefined): RejectFeedbackDocument {
    if (doc) return doc;
    const candidate = (globalThis as MaybeGlobalDocument).document;
    if (!candidate) {
        throw new Error(
            'reject-feedback modal: no document available — pass one explicitly when '
                + 'opening outside a browser context.',
        );
    }
    return candidate;
}

function resolveParent(
    parent: RejectFeedbackElement | undefined,
    doc: RejectFeedbackDocument,
): RejectFeedbackElement {
    if (parent) return parent;
    const body = (doc as { body?: RejectFeedbackElement }).body
        ?? (globalThis as MaybeGlobalDocument).document?.body;
    if (!body) {
        throw new Error(
            'reject-feedback modal: no parent element supplied and the document has no '
                + 'body — pass `parent` explicitly.',
        );
    }
    return body;
}

// ---------------------------------------------------------------------------
// Key-event port — Escape closes the modal
// ---------------------------------------------------------------------------

export interface RejectFeedbackKeyEvent {
    readonly key: string;
    preventDefault?(): void;
}

export type RejectFeedbackKeyListener = (event: RejectFeedbackKeyEvent) => void;

/**
 * Minimal `EventTarget` surface the modal subscribes to for Escape. The
 * browser `document` satisfies this structurally; tests pass a hand-rolled
 * fake that records `addEventListener` calls so the suite can fire a
 * synthetic Escape and assert the modal closed without going through
 * `document` directly.
 */
export interface RejectFeedbackKeyTarget {
    addEventListener(type: 'keydown', listener: RejectFeedbackKeyListener): void;
    removeEventListener(type: 'keydown', listener: RejectFeedbackKeyListener): void;
}

function resolveKeyTarget(
    target: RejectFeedbackKeyTarget | undefined,
): RejectFeedbackKeyTarget | null {
    if (target) return target;
    const doc = (globalThis as { document?: unknown }).document;
    if (
        doc
        && typeof (doc as RejectFeedbackKeyTarget).addEventListener === 'function'
        && typeof (doc as RejectFeedbackKeyTarget).removeEventListener === 'function'
    ) {
        return doc as RejectFeedbackKeyTarget;
    }
    return null;
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/** CSS class hooks — exported so stylesheets and tests can pin them. */
export const REJECT_FEEDBACK_OVERLAY_CLASS = 'overlay reject-feedback-overlay';
export const REJECT_FEEDBACK_PANEL_CLASS = 'panel reject-feedback-panel';
export const REJECT_FEEDBACK_TEXTAREA_CLASS = 'reject-feedback-textarea';
export const REJECT_FEEDBACK_SUBMIT_CLASS = 'btn btn-reject reject-feedback-submit';
export const REJECT_FEEDBACK_CANCEL_CLASS = 'btn btn-skip reject-feedback-cancel';

/** `data-testid` hooks for query-by-selector + a11y tests. */
export const REJECT_FEEDBACK_OVERLAY_TESTID = 'reject-feedback-overlay';
export const REJECT_FEEDBACK_TEXTAREA_TESTID = 'reject-feedback-textarea';
export const REJECT_FEEDBACK_SUBMIT_TESTID = 'reject-feedback-submit';
export const REJECT_FEEDBACK_CANCEL_TESTID = 'reject-feedback-cancel';

/** Default copy — the task brief pins the placeholder text. */
export const REJECT_FEEDBACK_PLACEHOLDER =
    'Why are you rejecting? The developer will see this.';
export const REJECT_FEEDBACK_SUBMIT_LABEL = 'Reject';
export const REJECT_FEEDBACK_CANCEL_LABEL = 'Cancel';
export const REJECT_FEEDBACK_TITLE = 'Reject task';

/** Status the worker-api answers when a reject is accepted. */
export const REJECT_FEEDBACK_ACCEPTED_STATUS = 202;

export interface RejectFeedbackOptions {
    /** Target task being rejected. */
    readonly taskId: string;
    /** `fetch`-like port used to POST `/tasks/:id/reject`. */
    readonly fetch: RejectFeedbackFetch;
    /**
     * Optional prefix prepended to the request URL. Defaults to '' so the
     * POST hits `/tasks/:id/reject` directly — the board proxy mounts the
     * worker-api at the same origin in production. Hosts that need to
     * speak to an absolute URL pass that prefix in (e.g. for staging).
     */
    readonly apiBase?: string;
    /** Fired after the modal closes — both on success and on Cancel/Escape. */
    readonly onClose?: () => void;
    /**
     * Fired when the POST resolves with a non-202 status or rejects. The
     * modal stays open so the operator can retry without retyping; the
     * host typically routes this to the chrome toast queue.
     */
    readonly onError?: (info: { readonly status?: number; readonly error?: unknown }) => void;
}

export interface RejectFeedbackDeps {
    readonly doc?: RejectFeedbackDocument;
    /** Mount target — defaults to `document.body`. */
    readonly parent?: RejectFeedbackElement;
    /**
     * Key-event source for the Escape-to-cancel handler. Defaults to the
     * `globalThis.document` when one is available; otherwise the modal
     * silently skips the subscription and the host can drive Escape via
     * {@link RejectFeedbackHandle.handleKeydown}.
     */
    readonly keyTarget?: RejectFeedbackKeyTarget;
}

export interface RejectFeedbackHandle {
    readonly root: RejectFeedbackElement;
    readonly textarea: RejectFeedbackElement;
    readonly rejectButton: RejectFeedbackElement;
    readonly cancelButton: RejectFeedbackElement;
    /**
     * Programmatic Reject. Returns `true` when a 202 came back and the
     * modal closed; `false` otherwise (empty textarea, non-202, or fetch
     * rejection). The button click handler funnels through this.
     */
    submit(): Promise<boolean>;
    /** Programmatic Cancel — closes without dispatching. */
    cancel(): void;
    /**
     * Direct key-event entry point. Production callers can wire a real
     * `keydown` listener to this; the modal also installs its own
     * listener when {@link RejectFeedbackDeps.keyTarget} resolves.
     */
    handleKeydown(event: RejectFeedbackKeyEvent): void;
    /** Idempotent close — removes the overlay and unsubscribes Escape. */
    close(): void;
}

/**
 * Mount the reject-feedback modal under `deps.parent` (default
 * `document.body`) and return a handle the host can drive. The textarea is
 * pre-focused synchronously so keyboard users start typing immediately.
 */
export function openRejectFeedbackModal(
    options: RejectFeedbackOptions,
    deps?: RejectFeedbackDeps,
): RejectFeedbackHandle {
    const doc = resolveDocument(deps?.doc);
    const parent = resolveParent(deps?.parent, doc);
    const keyTarget = resolveKeyTarget(deps?.keyTarget);

    const overlay = doc.createElement('div');
    overlay.className = REJECT_FEEDBACK_OVERLAY_CLASS;
    overlay.setAttribute('data-testid', REJECT_FEEDBACK_OVERLAY_TESTID);
    overlay.setAttribute('data-task-id', options.taskId);
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', `reject-feedback-title-${options.taskId}`);

    const panel = doc.createElement('div');
    panel.className = REJECT_FEEDBACK_PANEL_CLASS;
    overlay.appendChild(panel);

    const title = doc.createElement('h3');
    title.className = 'reject-feedback-title';
    title.setAttribute('id', `reject-feedback-title-${options.taskId}`);
    title.textContent = REJECT_FEEDBACK_TITLE;
    panel.appendChild(title);

    const textarea = doc.createElement('textarea') as RejectFeedbackElementWithEvents;
    textarea.className = REJECT_FEEDBACK_TEXTAREA_CLASS;
    textarea.setAttribute('data-testid', REJECT_FEEDBACK_TEXTAREA_TESTID);
    textarea.setAttribute('rows', '5');
    textarea.setAttribute('placeholder', REJECT_FEEDBACK_PLACEHOLDER);
    textarea.setAttribute('aria-label', 'Reject feedback');
    textarea.value = '';
    panel.appendChild(textarea);

    const buttonRow = doc.createElement('div');
    buttonRow.className = 'btn-row reject-feedback-actions';
    panel.appendChild(buttonRow);

    const cancelButton = doc.createElement('button') as RejectFeedbackElementWithEvents;
    cancelButton.className = REJECT_FEEDBACK_CANCEL_CLASS;
    cancelButton.setAttribute('type', 'button');
    cancelButton.setAttribute('data-testid', REJECT_FEEDBACK_CANCEL_TESTID);
    cancelButton.textContent = REJECT_FEEDBACK_CANCEL_LABEL;
    buttonRow.appendChild(cancelButton);

    const rejectButton = doc.createElement('button') as RejectFeedbackElementWithEvents;
    rejectButton.className = REJECT_FEEDBACK_SUBMIT_CLASS;
    rejectButton.setAttribute('type', 'button');
    rejectButton.setAttribute('data-testid', REJECT_FEEDBACK_SUBMIT_TESTID);
    rejectButton.textContent = REJECT_FEEDBACK_SUBMIT_LABEL;
    // AC #2 — start disabled; the textarea oninput flips this off once the
    // operator types non-whitespace content.
    rejectButton.disabled = true;
    rejectButton.setAttribute('disabled', '');
    buttonRow.appendChild(rejectButton);

    parent.appendChild(overlay);

    let closed = false;
    let inFlight = false;

    const apiBase = options.apiBase ?? '';
    const url = `${apiBase}/tasks/${encodeURIComponent(options.taskId)}/reject`;

    const isBlank = (): boolean => ((textarea.value ?? '').trim().length === 0);

    const syncRejectDisabled = (): void => {
        const disable = isBlank() || inFlight;
        rejectButton.disabled = disable;
        if (disable) {
            rejectButton.setAttribute('disabled', '');
        } else {
            rejectButton.removeAttribute('disabled');
        }
    };

    textarea.oninput = (): void => {
        syncRejectDisabled();
    };

    const keyListener: RejectFeedbackKeyListener = (event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault?.();
        cancel();
    };

    const detachKeyListener = (): void => {
        if (keyTarget) {
            keyTarget.removeEventListener('keydown', keyListener);
        }
    };

    const close = (): void => {
        if (closed) return;
        closed = true;
        detachKeyListener();
        overlay.remove();
    };

    function cancel(): void {
        if (closed) return;
        close();
        options.onClose?.();
    }

    const submit = async (): Promise<boolean> => {
        if (closed || inFlight) return false;
        // AC #5 — empty/whitespace feedback never POSTs. Guard at the modal
        // level so a keyboard activation that bypasses the disabled button
        // (or a programmatic submit call) still no-ops.
        if (isBlank()) {
            textarea.focus?.();
            return false;
        }
        const feedback = (textarea.value ?? '').trim();
        inFlight = true;
        syncRejectDisabled();
        let response: RejectFeedbackResponse;
        try {
            response = await options.fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ feedback }),
            });
        } catch (error) {
            inFlight = false;
            if (!closed) {
                syncRejectDisabled();
                textarea.focus?.();
                options.onError?.({ error });
            }
            return false;
        }
        inFlight = false;
        if (closed) {
            // Operator cancelled / Escaped during the in-flight POST. The
            // onClose hook already fired from cancel(); don't double-fire.
            return response.status === REJECT_FEEDBACK_ACCEPTED_STATUS;
        }
        if (response.status !== REJECT_FEEDBACK_ACCEPTED_STATUS) {
            syncRejectDisabled();
            textarea.focus?.();
            options.onError?.({ status: response.status });
            return false;
        }
        close();
        options.onClose?.();
        return true;
    };

    const handleKeydown = (event: RejectFeedbackKeyEvent): void => {
        keyListener(event);
    };

    rejectButton.onclick = (): void => {
        void submit();
    };
    cancelButton.onclick = (): void => {
        cancel();
    };

    if (keyTarget) {
        keyTarget.addEventListener('keydown', keyListener);
    }

    textarea.focus?.();

    return {
        root: overlay,
        textarea,
        rejectButton,
        cancelButton,
        submit,
        cancel,
        handleKeydown,
        close,
    };
}
