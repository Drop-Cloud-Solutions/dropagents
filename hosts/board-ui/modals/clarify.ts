/**
 * Clarify modal (AP-VP5-010).
 *
 * Operator-facing modal that answers an agent's `NEEDS_HUMAN_INPUT`
 * prompt by POSTing to `/tasks/:id/clarify` with a `{ answer, remember }`
 * payload. The agent emits its question (and optionally a list of
 * choices) as part of the clarification sidecar; the board hands those
 * to {@link openClarifyModal} which surfaces:
 *
 *   - the question text,
 *   - radio buttons for each choice (when the agent supplied them),
 *   - a free-text textarea (always — covers the "Other" branch when
 *     choices were offered, and is the only input when they weren't),
 *   - a `Remember this decision` checkbox (default unchecked — the
 *     operator opts in to memorising the answer, never the other way
 *     around),
 *   - Submit / Cancel buttons.
 *
 * Submit resolves the operator's answer in priority order: a non-empty
 * textarea wins (covers free-text + "I selected a choice but typed a
 * clarification on top"), otherwise the currently-selected radio wins.
 * If neither yields a non-empty string, Submit is suppressed and the
 * textarea receives focus so the operator can complete their input.
 *
 * Lifecycle (AC #5)
 * -----------------
 * The modal mirrors the open/close conventions in
 * `hosts/board-ui/client/modals/*` plus two operator-facing escape
 * hatches the task brief calls out:
 *   - Escape key → cancel (no dispatch),
 *   - click outside the panel (overlay backdrop) → cancel.
 * Both hooks are installed by `openClarifyModal` and torn down on
 * close, regardless of whether the close came from Submit success,
 * Cancel, Escape, or backdrop click.
 *
 * Degrade-gracefully contract (AC #4)
 * -----------------------------------
 * `choices` is `string[] | undefined` in the public surface, but the
 * agent's emitted JSON is not strongly typed — it can arrive as `null`,
 * a non-array, an array containing non-strings, or simply be missing.
 * {@link normaliseChoices} folds every malformed shape down to "render
 * the free-text textarea only" instead of throwing or crashing the
 * board on a bad payload.
 *
 * Renderer shape
 * --------------
 * Follows the structural-DOM pattern used elsewhere in board-ui (see
 * `client/modals/clarify.ts`, `client/modals/reject.ts`). The module
 * touches a minimal {@link ClarifyDocument} / {@link ClarifyElement}
 * surface so unit tests can drive it with a hand-rolled shim and the
 * real browser's `document` + `HTMLElement` satisfy it structurally.
 */

// ---------------------------------------------------------------------------
// Public constants — CSS hooks + copy. Exported so stylesheets and
// tests can pin them without restating the strings.
// ---------------------------------------------------------------------------

export const CLARIFY_OVERLAY_CLASS = 'overlay clarify-overlay';
export const CLARIFY_PANEL_CLASS = 'panel clarify-panel';
export const CLARIFY_FORM_CLASS = 'clarify-form';
export const CLARIFY_QUESTION_CLASS = 'clarify-question';
export const CLARIFY_CHOICES_CLASS = 'clarify-choices';
export const CLARIFY_CHOICE_CLASS = 'clarify-choice';
export const CLARIFY_TEXTAREA_CLASS = 'clarify-answer';
export const CLARIFY_REMEMBER_CLASS = 'clarify-remember';
export const CLARIFY_SUBMIT_CLASS = 'btn btn-approve clarify-submit';
export const CLARIFY_CANCEL_CLASS = 'btn btn-skip clarify-cancel';

export const CLARIFY_OVERLAY_TESTID = 'clarify-overlay';
export const CLARIFY_PANEL_TESTID = 'clarify-panel';
export const CLARIFY_QUESTION_TESTID = 'clarify-question';
export const CLARIFY_CHOICES_TESTID = 'clarify-choices';
export const CLARIFY_TEXTAREA_TESTID = 'clarify-answer';
export const CLARIFY_REMEMBER_TESTID = 'clarify-remember';
export const CLARIFY_SUBMIT_TESTID = 'clarify-submit';
export const CLARIFY_CANCEL_TESTID = 'clarify-cancel';

export const CLARIFY_DEFAULT_PLACEHOLDER = 'Type your answer here…';
export const CLARIFY_SUBMIT_LABEL = 'Submit';
export const CLARIFY_CANCEL_LABEL = 'Cancel';
export const CLARIFY_REMEMBER_LABEL = 'Remember this decision';

export const CLARIFY_ERROR_CLASS = 'clarify-error';
export const CLARIFY_ERROR_TESTID = 'clarify-error';
/** Shown when the POST never reached the server at all. */
export const CLARIFY_NETWORK_ERROR_MESSAGE =
    'Could not reach the server. Your answer is still here — try again.';

/** Stable name of the radio-button group used to enforce single-select. */
export const CLARIFY_CHOICE_GROUP = 'clarify-choice';

// ---------------------------------------------------------------------------
// Structural DOM types — keep the module jsdom-free
// ---------------------------------------------------------------------------

/**
 * Listener registered through {@link ClarifyDocument.addEventListener}.
 * Only the `key` field is consumed (escape-to-close), so the type stays
 * minimal — the real `KeyboardEvent` satisfies this structurally.
 */
export interface ClarifyKeyboardEvent {
    readonly key: string;
}

export type ClarifyKeyListener = (event: ClarifyKeyboardEvent) => void;

/**
 * Minimal element surface the modal touches. The real `HTMLElement`
 * satisfies this; the test shim implements it directly. Form-control
 * fields (textarea / input) read + write `value` and `checked`; other
 * nodes ignore those slots. `onclick` is the click handler hook used by
 * buttons and the overlay backdrop.
 */
export interface ClarifyElement {
    className: string;
    textContent: string | null;
    value?: string;
    checked?: boolean;
    hidden?: boolean;
    setAttribute(name: string, value: string): void;
    appendChild(child: ClarifyElement): ClarifyElement;
    remove(): void;
    focus?(): void;
    onclick?: ((event?: ClarifyMouseEvent) => void) | null;
}

/**
 * Mouse-event surface — the overlay backdrop handler reads `target` to
 * distinguish a click on the panel (do nothing) from a click on the
 * overlay backdrop (cancel). Real DOM `MouseEvent` satisfies this.
 */
export interface ClarifyMouseEvent {
    readonly target?: unknown;
}

/**
 * Minimal document surface. `createElement` for building the modal
 * tree; `addEventListener` / `removeEventListener` for the
 * escape-to-close hook (registered on document because the operator
 * can be focused anywhere inside the panel when they press Esc).
 */
export interface ClarifyDocument {
    createElement(tagName: string): ClarifyElement;
    addEventListener(type: 'keydown', listener: ClarifyKeyListener): void;
    removeEventListener(type: 'keydown', listener: ClarifyKeyListener): void;
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

// ---------------------------------------------------------------------------
// Fetch port — keeps the module HTTP-client agnostic
// ---------------------------------------------------------------------------

/**
 * Minimal response surface — only `status` and `ok` are consumed. The
 * real `fetch` Response satisfies this structurally; tests pass an
 * object literal so they don't depend on a Response polyfill.
 */
export interface ClarifyFetchResponse {
    readonly ok: boolean;
    readonly status: number;
    /**
     * Optional body reader. The real `fetch` Response has it; the test
     * shims may not, so every caller must tolerate its absence. Used only
     * to quote the server's own explanation back to the operator on a
     * failed Submit — a bare status number does not tell them whether to
     * retry, reload, or restart the worker.
     */
    text?: () => Promise<string>;
}

export interface ClarifyFetchInit {
    readonly method?: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: string;
}

/**
 * HTTP port for Submit. Production wires this to the global `fetch`;
 * tests pass a recording fake. The port is async-returning so the
 * modal can wait for the server's 202 before closing — Submit on a
 * non-2xx leaves the modal open so the operator can retry without
 * retyping (mirrors the reject-modal contract).
 */
export type ClarifyFetch = (
    url: string,
    init?: ClarifyFetchInit,
) => Promise<ClarifyFetchResponse>;

function defaultFetch(): ClarifyFetch {
    const f = (globalThis as { fetch?: ClarifyFetch }).fetch;
    if (typeof f !== 'function') {
        throw new Error(
            'clarify-modal: no global fetch available — pass `deps.fetch` '
                + 'explicitly when opening outside a browser context.',
        );
    }
    return f;
}

/**
 * Breadcrumb for a failed Submit. The in-modal line is for the operator;
 * this is for whoever they paste a console log to.
 */
function logFailure(url: string, detail: unknown): void {
    const console = (globalThis as { console?: { warn?: (...a: unknown[]) => void } }).console;
    console?.warn?.('clarify-modal: submit failed', url, detail);
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export interface ClarifyModalOptions {
    /** Target task whose `NEEDS_HUMAN_INPUT` block we're answering. */
    readonly taskId: string;
    /**
     * Question text — typically the parsed `Question:` line from the
     * agent's `NEEDS_HUMAN_INPUT` block. Rendered above the choices /
     * textarea so the operator has context while answering.
     */
    readonly question: string;
    /**
     * Optional choice list. When supplied and non-empty, rendered as
     * radio buttons above the free-text textarea so the operator can
     * pick one in a single click. Malformed values (non-array, null,
     * array of non-strings) degrade silently to the free-text-only
     * variant — see {@link normaliseChoices}.
     */
    readonly choices?: ReadonlyArray<string> | unknown;
    /**
     * Optional callback fired after the modal closes — both on Submit
     * success and on Cancel / Escape / backdrop click. The host wires
     * this to a board refresh so the task card picks up the resolved
     * clarification.
     */
    readonly onClose?: () => void;
    /** Textarea placeholder — defaults to {@link CLARIFY_DEFAULT_PLACEHOLDER}. */
    readonly placeholder?: string;
    /**
     * Base URL prefix for the POST. Defaults to empty string so the
     * request goes to a same-origin `/tasks/:id/clarify` path; the
     * board proxy resolves the actual worker-api host. Tests supply
     * a fake base so the recorded URL is deterministic.
     */
    readonly apiBase?: string;
    /**
     * Path POSTed on Submit, appended to {@link apiBase}. Defaults to
     * `/tasks/:taskId/clarify`.
     *
     * The override exists because the decomposer asks questions too, and a
     * decomposer run is plan-scoped: its answer goes to
     * `/plans/:planId/decomposer-answer`. Everything else about answering —
     * the question text, the radio options, free text, Remember, the
     * keep-open-on-failure retry — is identical, so the surface is shared
     * rather than forked. Callers using the override pass the plan id as
     * {@link taskId}; it is only used for DOM ids and the `data-task-id`
     * hook, never for the URL.
     */
    readonly submitPath?: string;
    /**
     * Called when Submit fails, so the host can raise a toast on top of the
     * in-modal line. Optional — the modal is already self-explanatory
     * without it.
     */
    readonly onError?: (info: { readonly message: string; readonly status?: number }) => void;
}

export interface ClarifyModalDeps {
    readonly doc?: ClarifyDocument;
    /** Optional mount target — defaults to `document.body`. */
    readonly parent?: ClarifyElement;
    /** Optional HTTP port — defaults to `globalThis.fetch`. */
    readonly fetch?: ClarifyFetch;
}

export interface ClarifyModalHandle {
    /** The overlay shell — outermost node mounted under `parent`. */
    readonly overlay: ClarifyElement;
    /** The panel inside the overlay holding the form. */
    readonly panel: ClarifyElement;
    /** The form element wrapping question / choices / textarea / buttons. */
    readonly form: ClarifyElement;
    /**
     * The free-text textarea. Always present, even when choices were
     * rendered above it (covers the "Other / clarification" branch).
     */
    readonly textarea: ClarifyElement;
    /** The "Remember this decision" checkbox — default unchecked. */
    readonly rememberCheckbox: ClarifyElement;
    /**
     * Choice radio buttons in render order. Empty when choices were
     * absent or malformed (see {@link normaliseChoices}).
     */
    readonly choiceInputs: ReadonlyArray<ClarifyElement>;
    /** Submit button — primary action. */
    readonly submitButton: ClarifyElement;
    /** Cancel button — closes the modal without dispatching. */
    readonly cancelButton: ClarifyElement;
    /**
     * Programmatic Submit. Resolves the answer in priority order
     * (textarea > selected radio); if neither yields a non-empty value
     * the textarea is re-focused and `false` is returned. POSTs the
     * `{ answer, remember }` payload to `/tasks/:id/clarify`; closes
     * the modal on 2xx and returns `true`. On a non-2xx response or a
     * network error the modal stays open and `false` is returned so
     * the operator can edit + retry.
     */
    submit(): Promise<boolean>;
    /** Programmatic Cancel — closes the modal without dispatching. */
    cancel(): void;
    /**
     * Tear the overlay down. Idempotent — calling close() twice
     * (Submit then Esc, for example) is a no-op the second time.
     */
    close(): void;
}

// ---------------------------------------------------------------------------
// Choice normalisation
// ---------------------------------------------------------------------------

/**
 * Fold the agent-supplied `choices` value into a clean `string[]`.
 * Returns an empty array — which the renderer treats as "free-text
 * only" — for every malformed shape: `undefined`, `null`, non-array,
 * array containing non-strings, array of all-whitespace strings.
 *
 * This is the AC #4 degrade-gracefully gate: a bad payload from the
 * agent must never crash the modal, only collapse it to the
 * free-text variant.
 */
export function normaliseChoices(input: unknown): string[] {
    if (!Array.isArray(input)) return [];
    const out: string[] = [];
    for (const item of input) {
        if (typeof item !== 'string') return [];
        const trimmed = item.trim();
        if (trimmed.length === 0) continue;
        out.push(item);
    }
    return out;
}

// ---------------------------------------------------------------------------
// openClarifyModal
// ---------------------------------------------------------------------------

/**
 * Mount the clarify modal under `deps.parent` (default
 * `document.body`) and return a handle the host can use to drive it
 * programmatically.
 *
 * The textarea is pre-focused synchronously before the function
 * returns so keyboard users land in the answer field immediately;
 * escape-to-close and backdrop-to-close are wired during construction
 * and torn down on close so a closed modal stops eating keystrokes.
 */
export function openClarifyModal(
    options: ClarifyModalOptions,
    deps?: ClarifyModalDeps,
): ClarifyModalHandle {
    const doc = resolveDocument(deps?.doc);
    const parent = resolveParent(deps?.parent, doc);
    const fetchFn = deps?.fetch ?? defaultFetch();
    const choices = normaliseChoices(options.choices);
    const apiBase = options.apiBase ?? '';

    const overlay = doc.createElement('div');
    overlay.className = CLARIFY_OVERLAY_CLASS;
    overlay.setAttribute('data-testid', CLARIFY_OVERLAY_TESTID);
    overlay.setAttribute('data-task-id', options.taskId);
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute(
        'aria-labelledby',
        `clarify-question-${options.taskId}`,
    );

    const panel = doc.createElement('div');
    panel.className = CLARIFY_PANEL_CLASS;
    panel.setAttribute('data-testid', CLARIFY_PANEL_TESTID);
    overlay.appendChild(panel);

    const form = doc.createElement('form');
    form.className = CLARIFY_FORM_CLASS;
    form.setAttribute('data-testid', 'clarify-form');
    panel.appendChild(form);

    const questionEl = doc.createElement('p');
    questionEl.className = CLARIFY_QUESTION_CLASS;
    questionEl.setAttribute('id', `clarify-question-${options.taskId}`);
    questionEl.setAttribute('data-testid', CLARIFY_QUESTION_TESTID);
    questionEl.textContent = options.question;
    form.appendChild(questionEl);

    const choiceInputs: ClarifyElement[] = [];
    if (choices.length > 0) {
        const choicesWrap = doc.createElement('div');
        choicesWrap.className = CLARIFY_CHOICES_CLASS;
        choicesWrap.setAttribute('data-testid', CLARIFY_CHOICES_TESTID);
        choicesWrap.setAttribute('role', 'radiogroup');
        choicesWrap.setAttribute('aria-label', 'Pick an answer');
        form.appendChild(choicesWrap);

        for (let i = 0; i < choices.length; i++) {
            const choice = choices[i];
            const label = doc.createElement('label');
            label.className = CLARIFY_CHOICE_CLASS;
            label.setAttribute('data-choice-index', String(i));

            const radio = doc.createElement('input');
            radio.setAttribute('type', 'radio');
            radio.setAttribute('name', CLARIFY_CHOICE_GROUP);
            radio.setAttribute('value', choice);
            radio.setAttribute(
                'data-testid',
                `clarify-choice-${String(i)}`,
            );
            radio.value = choice;
            radio.checked = false;
            label.appendChild(radio);

            const text = doc.createElement('span');
            text.className = 'clarify-choice-label';
            text.textContent = choice;
            label.appendChild(text);

            choicesWrap.appendChild(label);
            choiceInputs.push(radio);
        }
    }

    const textarea = doc.createElement('textarea');
    textarea.className = CLARIFY_TEXTAREA_CLASS;
    textarea.setAttribute('data-testid', CLARIFY_TEXTAREA_TESTID);
    textarea.setAttribute('rows', '5');
    textarea.setAttribute(
        'placeholder',
        options.placeholder ?? CLARIFY_DEFAULT_PLACEHOLDER,
    );
    textarea.setAttribute('aria-label', 'Clarification answer');
    textarea.value = '';
    form.appendChild(textarea);

    // Remember-this-decision checkbox. Wrapped in a label so a click on
    // the text toggles the box (matches the v1 board behaviour).
    const rememberWrap = doc.createElement('label');
    rememberWrap.className = CLARIFY_REMEMBER_CLASS;
    form.appendChild(rememberWrap);

    const rememberCheckbox = doc.createElement('input');
    rememberCheckbox.setAttribute('type', 'checkbox');
    rememberCheckbox.setAttribute('data-testid', CLARIFY_REMEMBER_TESTID);
    rememberCheckbox.setAttribute('aria-label', CLARIFY_REMEMBER_LABEL);
    // AC #2: must default to unchecked. The operator opts in to
    // memorising the answer; we never assume consent.
    rememberCheckbox.checked = false;
    rememberWrap.appendChild(rememberCheckbox);

    const rememberText = doc.createElement('span');
    rememberText.className = 'clarify-remember-label';
    rememberText.textContent = CLARIFY_REMEMBER_LABEL;
    rememberWrap.appendChild(rememberText);

    // Failure line. Submit used to fail INVISIBLY: a non-2xx or a network
    // error only re-focused the textarea, so a 404 (worker without the
    // route), a 409 (question already answered) and a 500 were all
    // indistinguishable from a dead button. Field report: "nothing happens
    // when I click submit". The modal now says what went wrong, in place.
    const errorEl = doc.createElement('p');
    errorEl.className = CLARIFY_ERROR_CLASS;
    errorEl.setAttribute('data-testid', CLARIFY_ERROR_TESTID);
    errorEl.setAttribute('role', 'alert');
    errorEl.textContent = '';
    errorEl.hidden = true;
    form.appendChild(errorEl);

    const buttonRow = doc.createElement('div');
    buttonRow.className = 'btn-row clarify-actions';
    form.appendChild(buttonRow);

    const cancelButton = doc.createElement('button');
    cancelButton.className = CLARIFY_CANCEL_CLASS;
    cancelButton.setAttribute('type', 'button');
    cancelButton.setAttribute('data-testid', CLARIFY_CANCEL_TESTID);
    cancelButton.textContent = CLARIFY_CANCEL_LABEL;
    buttonRow.appendChild(cancelButton);

    const submitButton = doc.createElement('button');
    submitButton.className = CLARIFY_SUBMIT_CLASS;
    submitButton.setAttribute('type', 'button');
    submitButton.setAttribute('data-testid', CLARIFY_SUBMIT_TESTID);
    submitButton.textContent = CLARIFY_SUBMIT_LABEL;
    buttonRow.appendChild(submitButton);

    parent.appendChild(overlay);

    let closed = false;
    let keyListener: ClarifyKeyListener | null = null;

    const close = (): void => {
        if (closed) return;
        closed = true;
        if (keyListener) {
            doc.removeEventListener('keydown', keyListener);
            keyListener = null;
        }
        overlay.remove();
    };

    const cancel = (): void => {
        if (closed) return;
        close();
        options.onClose?.();
    };

    const resolveAnswer = (): string | null => {
        const typed = (textarea.value ?? '').trim();
        if (typed.length > 0) return typed;
        for (const radio of choiceInputs) {
            if (radio.checked === true) {
                const v = (radio.value ?? '').trim();
                if (v.length > 0) return v;
            }
        }
        return null;
    };

    /** Show `message` on the modal, and route it out to the host's toast. */
    const showError = (message: string, status?: number): void => {
        errorEl.textContent = message;
        errorEl.hidden = false;
        options.onError?.({ message, ...(status !== undefined ? { status } : {}) });
        textarea.focus?.();
    };

    const clearError = (): void => {
        errorEl.textContent = '';
        errorEl.hidden = true;
    };

    /**
     * Quote the server's own explanation when it sent one. The worker
     * answers failures as `{ error, message }`, and the message is the part
     * that tells the operator what to DO — "no unanswered decomposer
     * question on plan X" means reload, not retry.
     */
    const describeFailure = async (response: ClarifyFetchResponse): Promise<string> => {
        const status = response.status;
        let detail = '';
        try {
            const raw = await response.text?.();
            if (typeof raw === 'string' && raw.trim().length > 0) {
                try {
                    const parsed = JSON.parse(raw) as { message?: unknown; error?: unknown };
                    const m = typeof parsed.message === 'string' ? parsed.message : '';
                    const e = typeof parsed.error === 'string' ? parsed.error : '';
                    detail = m || e;
                } catch {
                    detail = raw.trim().slice(0, 300);
                }
            }
        } catch {
            // Body already consumed or unreadable — the status still tells
            // the operator something, so carry on with that alone.
        }
        // 404 is the one status whose fix is not guessable from the number,
        // and it has a specific cause worth naming: this page is newer than
        // the processes serving it.
        //
        // `board.js` is a static file, so a git pull updates the UI with no
        // restart — but the board server's proxy allowlist
        // (`matchesProxyPath`) and the worker-api's routers are both
        // in-process. A new endpoint therefore 404s at the board server
        // until IT restarts, with a fully working-looking page in front of
        // it. Naming both processes costs a clause and saves the guess.
        const hint = status === 404
            ? ' This endpoint is unknown to the server — the page is newer than the'
                + ' processes serving it. Restart the board-ui and worker-api, then retry.'
            : '';
        return `Could not send your answer (HTTP ${String(status)}).`
            + (detail ? ` ${detail}` : '')
            + hint;
    };

    const submit = async (): Promise<boolean> => {
        if (closed) return false;
        clearError();
        const answer = resolveAnswer();
        if (answer === null) {
            showError('Type an answer or pick an option first.');
            return false;
        }
        const remember = rememberCheckbox.checked === true;
        const url = `${apiBase}${
            options.submitPath
            ?? `/tasks/${encodeURIComponent(options.taskId)}/clarify`
        }`;
        let response: ClarifyFetchResponse;
        try {
            response = await fetchFn(url, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ answer, remember }),
            });
        } catch (err) {
            // Network error — keep the modal open so the operator can
            // retry without retyping, but SAY so.
            logFailure(url, err);
            showError(CLARIFY_NETWORK_ERROR_MESSAGE);
            return false;
        }
        // AC #3 — close on 202 (and any other 2xx the worker might
        // return). A non-2xx (rate-limited, server error) leaves the
        // modal open; the operator can edit + retry.
        if (!response.ok) {
            const message = await describeFailure(response);
            logFailure(url, message);
            showError(message, response.status);
            return false;
        }
        close();
        options.onClose?.();
        return true;
    };

    submitButton.onclick = (): void => {
        // Fire-and-forget — the click handler can't await without
        // changing the onclick signature that browsers + the test
        // shim share. `submit()` itself catches fetch rejections.
        void submit();
    };
    cancelButton.onclick = (): void => {
        cancel();
    };

    // Backdrop-to-close (AC #5). Clicks on the panel bubble up to the
    // overlay; the target check distinguishes a click on the panel
    // (do nothing) from a click on the backdrop (cancel). Tests
    // supply `event.target === overlay` to drive the close path.
    overlay.onclick = (event): void => {
        if (event && event.target !== overlay) return;
        cancel();
    };
    // Stop clicks inside the panel from bubbling to the overlay
    // handler in the production browser. The test shim ignores
    // `onclick` bubbling so this is a no-op there, but it keeps the
    // real DOM behaviour aligned with the test contract.
    panel.onclick = (event): void => {
        // Empty handler installs a click target on the panel so the
        // browser fires the overlay's onclick with `event.target ===
        // panel` (not the overlay) when the user clicks inside the
        // panel. The backdrop-to-close check above then short-circuits.
        void event;
    };

    // Escape-to-close (AC #5). Registered on document so the operator
    // can press Esc with focus anywhere inside the modal.
    keyListener = (event: ClarifyKeyboardEvent): void => {
        if (event.key === 'Escape') {
            cancel();
        }
    };
    doc.addEventListener('keydown', keyListener);

    // Pre-focus the textarea so keyboard users start typing immediately.
    textarea.focus?.();

    return {
        overlay,
        panel,
        form,
        textarea,
        rememberCheckbox,
        choiceInputs,
        submitButton,
        cancelButton,
        submit,
        cancel,
        close,
    };
}
