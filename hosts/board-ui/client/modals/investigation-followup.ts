/**
 * Investigation follow-up modal (AP-VP5-011).
 *
 * Lets the operator inspect an investigation's full thread (operator +
 * investigator turns, chronological) and post a follow-up question that
 * re-engages the investigator agent.
 *
 *   - The thread loads through an injected {@link ThreadFetcher} that the
 *     host wires to `GET /tasks/:id/investigation-thread` on the
 *     worker-api (added by this same task — see
 *     `hosts/worker-api/routes/tasks.ts`). The modal owns the
 *     fetch-then-render orchestration but never speaks HTTP itself; tests
 *     hand in a recording fake.
 *   - Submit dispatches `AskInvestigationFollowup` through an injected
 *     {@link FollowupDispatcher}. On a resolved dispatch the textarea is
 *     cleared and the thread is re-fetched so the operator sees their new
 *     turn (and the investigator's answer, when it lands) without a manual
 *     reload.
 *   - Close lifecycle matches the clarify modal: a Close button + an
 *     idempotent {@link FollowupModalHandle.close}. Escape is handled by
 *     the overlay-manager that wraps the modal in production; the manager
 *     calls back into `close()` via the `onClose` option.
 *
 * Renderer shape: structural DOM types (mirrors clarify / investigate
 * modal pattern) so unit tests run without jsdom.
 */

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

/**
 * One entry in the investigation thread. Matches
 * `core/flow/engine.ts#InvestigationThreadEntry` verbatim — kept as a
 * local copy so the modal does not depend on the engine module.
 */
export interface FollowupThreadEntry {
    readonly role: string;
    readonly content: string;
    readonly timestamp: number;
}

/** Payload dispatched on Ask. Mirrors the worker-api POST body. */
export interface AskInvestigationFollowupPayload {
    readonly taskId: string;
    readonly question: string;
}

export interface AskInvestigationFollowupCommand {
    readonly type: 'AskInvestigationFollowup';
    readonly payload: AskInvestigationFollowupPayload;
}

// ---------------------------------------------------------------------------
// Injected ports
// ---------------------------------------------------------------------------

/**
 * Read-side port. Production wires this to a fetch against
 * `GET /tasks/:id/investigation-thread` (proxied by the board server);
 * tests pass a recorder that returns canned threads so the render path is
 * inspectable without standing up an HTTP server.
 */
export type ThreadFetcher = (
    taskId: string,
) => Promise<ReadonlyArray<FollowupThreadEntry>>;

/**
 * Write-side port. Production wires this to a POST against
 * `/tasks/:id/investigation-followup`; tests pass a recorder that
 * captures every dispatched command for assertion.
 */
export type FollowupDispatcher = (
    command: AskInvestigationFollowupCommand,
) => void | Promise<void>;

// ---------------------------------------------------------------------------
// Toast port — mirrors the clarify modal's shape so production can pass
// the chrome `showToast` directly.
// ---------------------------------------------------------------------------

export type FollowupToastKind = 'info' | 'success' | 'error';

export interface FollowupToastOptions {
    readonly message: string;
    readonly kind?: FollowupToastKind;
}

export interface FollowupToastPort {
    showToast(opts: FollowupToastOptions): void;
}

// ---------------------------------------------------------------------------
// Structural DOM types — keep tests jsdom-free
// ---------------------------------------------------------------------------

export interface FollowupElement {
    className: string;
    textContent: string | null;
    value?: string;
    hidden?: boolean;
    setAttribute(name: string, value: string): void;
    appendChild(child: FollowupElement): FollowupElement;
    replaceChildren?(...children: FollowupElement[]): void;
    remove(): void;
    focus?(): void;
}

export interface FollowupDocument {
    createElement(tagName: string): FollowupElement;
}

interface FollowupElementWithEvents extends FollowupElement {
    onclick?: () => void;
    onsubmit?: (event?: { preventDefault?: () => void }) => void;
}

interface MaybeGlobalDocument {
    document?: unknown;
}

function resolveDocument(doc: FollowupDocument | undefined): FollowupDocument {
    if (doc) return doc;
    const candidate = (globalThis as MaybeGlobalDocument).document as
        | FollowupDocument
        | undefined;
    if (!candidate) {
        throw new Error(
            'investigation-followup-modal: no document available — pass one '
                + 'explicitly when opening outside a browser context.',
        );
    }
    return candidate;
}

function resolveParent(
    parent: FollowupElement | undefined,
    doc: FollowupDocument,
): FollowupElement {
    if (parent) return parent;
    const body = (doc as { body?: FollowupElement }).body
        ?? ((globalThis as MaybeGlobalDocument).document as
            | { body?: FollowupElement }
            | undefined)?.body;
    if (!body) {
        throw new Error(
            'investigation-followup-modal: no parent element supplied and the '
                + 'document has no body — pass `deps.parent` explicitly.',
        );
    }
    return body;
}

function attachClick(el: FollowupElement, handler: () => void): void {
    (el as FollowupElementWithEvents).onclick = handler;
}

function removeChildren(el: FollowupElement): void {
    // Prefer the native `replaceChildren` when the element exposes it
    // (the real DOM does); fall back to repeated `remove` on each child
    // for the structural test shim. We can't reach inside the shim's
    // private children array from here, so the shim must provide
    // `replaceChildren` itself — the helper below is a no-op for shims
    // that don't, which is harmless because the test shim used in
    // unit tests does implement it.
    el.replaceChildren?.();
}

// ---------------------------------------------------------------------------
// Public surface — labels + test ids
// ---------------------------------------------------------------------------

export const FOLLOWUP_OVERLAY_CLASS = 'overlay followup-overlay';
export const FOLLOWUP_PANEL_CLASS = 'panel followup-panel';
export const FOLLOWUP_THREAD_CLASS = 'followup-thread';
export const FOLLOWUP_TURN_CLASS = 'followup-turn';
export const FOLLOWUP_EMPTY_CLASS = 'followup-thread-empty';
export const FOLLOWUP_FORM_CLASS = 'followup-form';
export const FOLLOWUP_TEXTAREA_CLASS = 'followup-question';
export const FOLLOWUP_ASK_CLASS = 'btn btn-approve followup-ask';
export const FOLLOWUP_CLOSE_CLASS = 'btn btn-skip followup-close';

export const FOLLOWUP_OVERLAY_TESTID = 'followup-overlay';
export const FOLLOWUP_THREAD_TESTID = 'followup-thread';
export const FOLLOWUP_EMPTY_TESTID = 'followup-thread-empty';
export const FOLLOWUP_TURN_TESTID = 'followup-turn';
export const FOLLOWUP_TEXTAREA_TESTID = 'followup-question';
export const FOLLOWUP_ASK_TESTID = 'followup-ask';
export const FOLLOWUP_CLOSE_TESTID = 'followup-close';

export const FOLLOWUP_DEFAULT_PLACEHOLDER =
    'Type your follow-up question…';
export const FOLLOWUP_ASK_LABEL = 'Ask';
export const FOLLOWUP_CLOSE_LABEL = 'Close';
export const FOLLOWUP_EMPTY_MESSAGE = 'no follow-ups yet';

export const FOLLOWUP_TOAST_SUCCESS_MESSAGE = 'Follow-up sent.';
export const FOLLOWUP_TOAST_ERROR_MESSAGE =
    'Failed to send follow-up. Try again.';
export const FOLLOWUP_TOAST_FETCH_ERROR_MESSAGE =
    'Failed to load investigation thread.';

// ---------------------------------------------------------------------------
// Options + handle
// ---------------------------------------------------------------------------

export interface FollowupModalOptions {
    readonly taskId: string;
    readonly fetchThread: ThreadFetcher;
    readonly dispatcher: FollowupDispatcher;
    /**
     * Optional close hook. Fired both when the operator clicks Close and
     * when the overlay-manager closes the modal via Escape. Not fired on
     * a failed Ask — the modal stays open so the operator can retry.
     */
    readonly onClose?: () => void;
    /** Optional dialog title — defaults to a label keyed on the task id. */
    readonly title?: string;
    readonly placeholder?: string;
    readonly toast?: FollowupToastPort;
    /**
     * Optional formatter for the per-turn timestamp. Defaults to
     * `new Date(ts).toISOString()` so the rendered label is timezone-free
     * and stable across environments. Production may pass a localised
     * formatter; tests pin the default for deterministic snapshots.
     */
    readonly formatTimestamp?: (timestampMs: number) => string;
}

export interface FollowupModalDeps {
    readonly doc?: FollowupDocument;
    readonly parent?: FollowupElement;
}

export interface FollowupModalHandle {
    readonly overlay: FollowupElement;
    readonly panel: FollowupElement;
    readonly threadContainer: FollowupElement;
    readonly form: FollowupElement;
    readonly textarea: FollowupElement;
    readonly askButton: FollowupElement;
    readonly closeButton: FollowupElement;
    /**
     * The thread snapshot last rendered. Updates after every successful
     * fetch (initial load + post-Ask refresh). Exposed so tests can
     * assert that re-fetch ran without scraping the DOM.
     */
    readonly currentThread: () => ReadonlyArray<FollowupThreadEntry>;
    /**
     * Programmatic Ask. Trims the textarea value and:
     *  - returns `false` (re-focuses the textarea) on empty input — no
     *    dispatch, no fetch;
     *  - awaits the dispatcher. On resolve, clears the textarea, refetches
     *    the thread, fires a success toast, returns `true`;
     *  - on reject, fires an error toast and leaves the modal open with
     *    the textarea intact (re-focused) so the operator can retry
     *    without retyping.
     */
    ask(): Promise<boolean>;
    /**
     * Programmatic re-fetch. Replaces the rendered thread with the
     * resolved value; on failure fires an error toast and leaves the
     * previously-rendered thread in place. Returns `true` on success.
     */
    refresh(): Promise<boolean>;
    close(): void;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

function defaultFormatTimestamp(ts: number): string {
    return new Date(ts).toISOString();
}

function resolveToast(toast: FollowupToastPort | undefined): FollowupToastPort {
    if (toast) return toast;
    return {
        // Silent no-op fallback so the modal can still operate in Node
        // test contexts that don't inject a toast port.
        showToast(): void {
            /* no-op */
        },
    };
}

function renderTurn(
    doc: FollowupDocument,
    entry: FollowupThreadEntry,
    formatTimestamp: (ts: number) => string,
    index: number,
): FollowupElement {
    const turn = doc.createElement('li');
    turn.className = `${FOLLOWUP_TURN_CLASS} ${FOLLOWUP_TURN_CLASS}--${entry.role}`;
    turn.setAttribute('data-testid', FOLLOWUP_TURN_TESTID);
    turn.setAttribute('data-turn-index', String(index));
    turn.setAttribute('data-role', entry.role);
    turn.setAttribute('data-timestamp', String(entry.timestamp));

    const header = doc.createElement('div');
    header.className = 'followup-turn-header';
    turn.appendChild(header);

    const roleEl = doc.createElement('span');
    roleEl.className = 'followup-turn-role';
    roleEl.setAttribute('data-followup-turn-role', '');
    roleEl.textContent = entry.role;
    header.appendChild(roleEl);

    const tsEl = doc.createElement('time');
    tsEl.className = 'followup-turn-timestamp';
    tsEl.setAttribute('data-followup-turn-timestamp', '');
    tsEl.setAttribute('datetime', new Date(entry.timestamp).toISOString());
    tsEl.textContent = formatTimestamp(entry.timestamp);
    header.appendChild(tsEl);

    const body = doc.createElement('div');
    body.className = 'followup-turn-content';
    body.setAttribute('data-followup-turn-content', '');
    body.textContent = entry.content;
    turn.appendChild(body);

    return turn;
}

function renderThread(
    doc: FollowupDocument,
    container: FollowupElement,
    thread: ReadonlyArray<FollowupThreadEntry>,
    formatTimestamp: (ts: number) => string,
): void {
    removeChildren(container);
    if (thread.length === 0) {
        const empty = doc.createElement('p');
        empty.className = FOLLOWUP_EMPTY_CLASS;
        empty.setAttribute('data-testid', FOLLOWUP_EMPTY_TESTID);
        empty.textContent = FOLLOWUP_EMPTY_MESSAGE;
        container.appendChild(empty);
        return;
    }
    const list = doc.createElement('ol');
    list.className = 'followup-turn-list';
    list.setAttribute('data-followup-turn-list', '');
    for (let i = 0; i < thread.length; i++) {
        list.appendChild(renderTurn(doc, thread[i], formatTimestamp, i));
    }
    container.appendChild(list);
}

/**
 * Mount the investigation follow-up modal under `deps.parent` (default
 * `document.body`). The container renders the empty-thread placeholder
 * synchronously; the caller is responsible for `await handle.refresh()`
 * to load the real thread. Keeping the initial fetch out of `open` lets
 * the host (and tests) await it deterministically — there's no implicit
 * fire-and-forget request the caller has to race.
 */
export function openInvestigationFollowupModal(
    options: FollowupModalOptions,
    deps?: FollowupModalDeps,
): FollowupModalHandle {
    const doc = resolveDocument(deps?.doc);
    const parent = resolveParent(deps?.parent, doc);
    const toast = resolveToast(options.toast);
    const formatTimestamp = options.formatTimestamp ?? defaultFormatTimestamp;

    const overlay = doc.createElement('div');
    overlay.className = FOLLOWUP_OVERLAY_CLASS;
    overlay.setAttribute('data-testid', FOLLOWUP_OVERLAY_TESTID);
    overlay.setAttribute('data-task-id', options.taskId);
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute(
        'aria-labelledby',
        `followup-title-${options.taskId}`,
    );

    const panel = doc.createElement('div');
    panel.className = FOLLOWUP_PANEL_CLASS;
    overlay.appendChild(panel);

    const titleEl = doc.createElement('h3');
    titleEl.className = 'followup-title';
    titleEl.setAttribute('id', `followup-title-${options.taskId}`);
    titleEl.textContent =
        options.title ?? `Investigation follow-up — ${options.taskId}`;
    panel.appendChild(titleEl);

    const threadContainer = doc.createElement('div');
    threadContainer.className = FOLLOWUP_THREAD_CLASS;
    threadContainer.setAttribute('data-testid', FOLLOWUP_THREAD_TESTID);
    panel.appendChild(threadContainer);

    // Initial paint with an empty placeholder. The first refresh()
    // replaces it once the fetcher resolves.
    renderThread(doc, threadContainer, [], formatTimestamp);

    const form = doc.createElement('form');
    form.className = FOLLOWUP_FORM_CLASS;
    form.setAttribute('data-followup-form', '');
    panel.appendChild(form);

    const textarea = doc.createElement('textarea');
    textarea.className = FOLLOWUP_TEXTAREA_CLASS;
    textarea.setAttribute('data-testid', FOLLOWUP_TEXTAREA_TESTID);
    // 10 rows + the CSS min-height: follow-up questions are usually a
    // paragraph with context, not a one-liner — 4 rows forced the
    // operator to compose in a peephole.
    textarea.setAttribute('rows', '10');
    textarea.setAttribute(
        'placeholder',
        options.placeholder ?? FOLLOWUP_DEFAULT_PLACEHOLDER,
    );
    textarea.setAttribute('aria-label', 'Follow-up question');
    textarea.value = '';
    form.appendChild(textarea);

    const buttonRow = doc.createElement('div');
    buttonRow.className = 'btn-row followup-actions';
    form.appendChild(buttonRow);

    const askButton = doc.createElement('button');
    askButton.className = FOLLOWUP_ASK_CLASS;
    askButton.setAttribute('type', 'button');
    askButton.setAttribute('data-testid', FOLLOWUP_ASK_TESTID);
    askButton.textContent = FOLLOWUP_ASK_LABEL;
    buttonRow.appendChild(askButton);

    const closeButton = doc.createElement('button');
    closeButton.className = FOLLOWUP_CLOSE_CLASS;
    closeButton.setAttribute('type', 'button');
    closeButton.setAttribute('data-testid', FOLLOWUP_CLOSE_TESTID);
    closeButton.textContent = FOLLOWUP_CLOSE_LABEL;
    buttonRow.appendChild(closeButton);

    parent.appendChild(overlay);

    let closed = false;
    let lastThread: ReadonlyArray<FollowupThreadEntry> = [];

    const close = (): void => {
        if (closed) return;
        closed = true;
        overlay.remove();
        options.onClose?.();
    };

    const refresh = async (): Promise<boolean> => {
        if (closed) return false;
        try {
            const next = await options.fetchThread(options.taskId);
            if (closed) return false;
            lastThread = next;
            renderThread(doc, threadContainer, next, formatTimestamp);
            return true;
        } catch {
            toast.showToast({
                message: FOLLOWUP_TOAST_FETCH_ERROR_MESSAGE,
                kind: 'error',
            });
            return false;
        }
    };

    const ask = async (): Promise<boolean> => {
        if (closed) return false;
        const trimmed = (textarea.value ?? '').trim();
        if (!trimmed) {
            textarea.focus?.();
            return false;
        }
        try {
            await options.dispatcher({
                type: 'AskInvestigationFollowup',
                payload: { taskId: options.taskId, question: trimmed },
            });
        } catch {
            toast.showToast({
                message: FOLLOWUP_TOAST_ERROR_MESSAGE,
                kind: 'error',
            });
            textarea.focus?.();
            return false;
        }
        if (closed) return true;
        textarea.value = '';
        toast.showToast({
            message: FOLLOWUP_TOAST_SUCCESS_MESSAGE,
            kind: 'success',
        });
        await refresh();
        return true;
    };

    attachClick(askButton, () => {
        void ask();
    });
    attachClick(closeButton, () => {
        close();
    });

    // Pre-focus the textarea so the operator can start typing as soon
    // as the overlay opens.
    textarea.focus?.();

    return {
        overlay,
        panel,
        threadContainer,
        form,
        textarea,
        askButton,
        closeButton,
        currentThread: (): ReadonlyArray<FollowupThreadEntry> => lastThread,
        ask,
        refresh,
        close,
    };
}
