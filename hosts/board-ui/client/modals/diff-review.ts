/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Diff-review modal (AP-IFF-010).
 *
 * Renders the parsed worktree diff for a single task inside an overlay
 * the operator can navigate hunk-by-hunk and either Approve (dispatches
 * an `UpdateTask` command) or Reject (hands off to the reject modal
 * wired by the host).
 *
 * Architectural contract
 * ----------------------
 * - The host calls {@link openDiffReview} with an overlay container
 *   element, the task coordinates (project / plan / task / flow ids),
 *   and a small set of DI'd ports. The function pushes the container
 *   onto the {@link OverlayManager} stack via
 *   `openOverlay('diff-review', element)` and returns a handle the
 *   caller can use to close the overlay programmatically.
 * - The diff is fetched from
 *   `GET /api/projects/:pid/plans/:planId/tasks/:taskId/diff` — the
 *   route added to the board-ui proxy in the same task, served by the
 *   parsed-hunk responder from AP-IFF-009. Parsing happens upstream;
 *   the modal renders the structured payload as-is.
 * - Hunks are rendered into a flat list ordered by file then by
 *   appearance. The prev/next buttons walk that list, mark the active
 *   hunk with `data-active="true"`, and call `scrollIntoView()` when
 *   the underlying DOM exposes it (no-op under the test shim).
 * - Approve dispatches `{ type: 'UpdateTask', payload: { taskId,
 *   flowId?, status: 'approved' } }` through the injected
 *   {@link DispatchCommand} port. The status transition advances the
 *   task past review; the worker-side handler is the source of truth
 *   for the actual workflow movement — this surface only emits the
 *   intent.
 * - Reject closes the diff-review overlay and invokes the host's
 *   {@link DiffReviewDeps.onReject} callback. The reject modal lives
 *   in a separate module; wiring belongs to the host.
 * - DOM types are structural so unit tests can drive the module with a
 *   minimal shim — mirrors the testability pattern already in use under
 *   `hosts/board-ui/client/chrome/sidebar.ts` and `overlay-manager.ts`.
 */

// ---------------------------------------------------------------------------
// Diff payload shapes — mirror the worker-api task-diff responder
// ---------------------------------------------------------------------------

export type DiffLineKind = 'add' | 'del' | 'ctx';

export interface DiffLine {
    readonly kind: DiffLineKind;
    readonly text: string;
}

export interface DiffHunk {
    readonly header: string;
    readonly lines: ReadonlyArray<DiffLine>;
}

export interface DiffFile {
    readonly path: string;
    readonly hunks: ReadonlyArray<DiffHunk>;
}

export interface TaskDiffResponse {
    readonly files: ReadonlyArray<DiffFile>;
}

// ---------------------------------------------------------------------------
// Structural DOM types — keep tests jsdom-free
// ---------------------------------------------------------------------------

export interface DiffReviewElement {
    className: string;
    textContent: string | null;
    setAttribute(name: string, value: string): void;
    removeAttribute?(name: string): void;
    appendChild(child: DiffReviewElement): DiffReviewElement;
    replaceChildren(...children: DiffReviewElement[]): void;
    scrollIntoView?(arg?: unknown): void;
}

export interface DiffReviewDocument {
    createElement(tagName: string): DiffReviewElement;
}

interface DiffReviewElementWithEvents extends DiffReviewElement {
    onclick?: () => void;
}

// ---------------------------------------------------------------------------
// Overlay-manager surface the modal calls into
// ---------------------------------------------------------------------------

/**
 * Narrow view of {@link OverlayManager} the modal needs. The real
 * manager from `client/chrome/overlay-manager.ts` satisfies this
 * structurally — both `openOverlay` and `closeOverlay` are also
 * available there. Keeping the seam narrow lets tests pass a recorder
 * fake without pulling the manager into the test setup.
 */
export interface DiffReviewOverlayManager {
    openOverlay(id: string, element: unknown): unknown;
    closeOverlay(id: string): void;
}

// ---------------------------------------------------------------------------
// Fetch / dispatch ports
// ---------------------------------------------------------------------------

/**
 * Browser `fetch`-shaped port. Only the bits the modal exercises are
 * required so tests can return plain objects without modelling the full
 * Response surface.
 */
export interface DiffReviewFetchResponse {
    readonly ok: boolean;
    readonly status: number;
    json(): Promise<unknown>;
}

export type DiffReviewFetch = (
    url: string,
    init?: { readonly method?: string; readonly signal?: unknown },
) => Promise<DiffReviewFetchResponse>;

/** Command envelope dispatched on Approve. */
export interface DiffReviewCommand {
    readonly type: string;
    readonly actor: string;
    readonly issuedAt: number;
    readonly payload: Readonly<Record<string, unknown>>;
}

export type DispatchCommand = (command: DiffReviewCommand) => void;

// ---------------------------------------------------------------------------
// Public options + handle
// ---------------------------------------------------------------------------

export interface DiffReviewParams {
    readonly projectId: string;
    readonly planId: string;
    readonly taskId: string;
    readonly flowId?: string;
}

export interface DiffReviewDeps {
    readonly element: DiffReviewElement;
    readonly overlayManager: DiffReviewOverlayManager;
    readonly fetch: DiffReviewFetch;
    readonly dispatch: DispatchCommand;
    readonly onReject: (params: DiffReviewParams) => void;
    readonly doc?: DiffReviewDocument;
    readonly now?: () => number;
    readonly actor?: string;
    /**
     * Status value to send on Approve. Defaults to `'approved'` — the
     * `human_status` term that moves a reviewed task into the next
     * column. Exposed for parity with the v1 board's
     * `ApproveTask`/`UpdateTask` payloads when downstream tests need a
     * different transition.
     */
    readonly approveStatus?: string;
    /**
     * Switch the modal into the pre-commit human-review flow. When set:
     *   - the footer renders a feedback textarea + Approve + Request
     *     changes buttons (Request changes stays disabled until the
     *     textarea has non-whitespace content);
     *   - the built-in `UpdateTask` dispatch is suppressed and the
     *     supplied {@link onHumanReviewApprove} / {@link onHumanReviewReject}
     *     callbacks own the operator's decision instead;
     *   - {@link onReject} is still available as a hard close hook but
     *     is never invoked from this mode's reject button.
     * Default is the legacy review flow (Approve = UpdateTask, Reject
     * delegates to {@link onReject}).
     */
    readonly humanReviewMode?: boolean;
    /** Called when the operator clicks Approve in human-review mode. */
    readonly onHumanReviewApprove?: (params: DiffReviewParams) => void;
    /** Called when the operator clicks Request changes in human-review
     *  mode. `feedback` is the textarea's trimmed value; the modal
     *  guarantees it is non-empty (the button stays disabled otherwise). */
    readonly onHumanReviewReject?: (
        params: DiffReviewParams,
        feedback: string,
    ) => void;
}

export interface DiffReviewHandle {
    /** Close the overlay and detach the modal. Idempotent. */
    close(): void;
    /** Promise resolved once the initial fetch + render has settled. */
    readonly loaded: Promise<void>;
}

export const DIFF_REVIEW_OVERLAY_ID = 'diff-review';
export const DEFAULT_APPROVE_STATUS = 'approved';
export const UPDATE_TASK_COMMAND = 'UpdateTask';

// ---------------------------------------------------------------------------
// Document resolution
// ---------------------------------------------------------------------------

interface MaybeGlobalDocument {
    document?: DiffReviewDocument;
}

function resolveDocument(doc: DiffReviewDocument | undefined): DiffReviewDocument {
    if (doc) return doc;
    const candidate = (globalThis as MaybeGlobalDocument).document;
    if (!candidate) {
        throw new Error(
            'diff-review: no document available — pass one explicitly when '
                + 'rendering outside a browser context.',
        );
    }
    return candidate;
}

function attachClick(el: DiffReviewElement, handler: () => void): void {
    (el as DiffReviewElementWithEvents).onclick = handler;
}

// ---------------------------------------------------------------------------
// URL builder — exported so tests can pin the route shape
// ---------------------------------------------------------------------------

/**
 * Build the diff route URL for the proxied worker-api endpoint. Each
 * id is `encodeURIComponent`-ed so colons and other reserved chars in
 * Linear-style ids don't break path matching upstream.
 */
export function buildDiffUrl(params: DiffReviewParams): string {
    const pid = encodeURIComponent(params.projectId);
    const planId = encodeURIComponent(params.planId);
    const taskId = encodeURIComponent(params.taskId);
    return `/api/projects/${pid}/plans/${planId}/tasks/${taskId}/diff`;
}

// ---------------------------------------------------------------------------
// Renderer state
// ---------------------------------------------------------------------------

interface HunkEntry {
    readonly fileIndex: number;
    readonly hunkIndex: number;
    readonly element: DiffReviewElement;
}

interface RenderState {
    hunks: HunkEntry[];
    activeIndex: number;
    prevBtn: DiffReviewElement | null;
    nextBtn: DiffReviewElement | null;
    counter: DiffReviewElement | null;
    /** Index of the file currently shown in the right pane. */
    selectedFileIndex: number;
    /** Container references so file-list clicks can update the right
     *  pane without re-rendering the entire modal body. */
    fileListEl: DiffReviewElement | null;
    bodyContentEl: DiffReviewElement | null;
    /** The diff response — held so file-list clicks can re-render the
     *  body against the right file without re-fetching. */
    diff: TaskDiffResponse | null;
}

function emptyRenderState(): RenderState {
    return {
        hunks: [],
        activeIndex: 0,
        prevBtn: null,
        nextBtn: null,
        counter: null,
        selectedFileIndex: 0,
        fileListEl: null,
        bodyContentEl: null,
        diff: null,
    };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export function openDiffReview(
    params: DiffReviewParams,
    deps: DiffReviewDeps,
): DiffReviewHandle {
    const doc = resolveDocument(deps.doc);
    const now = deps.now ?? Date.now;
    const actor = deps.actor ?? 'operator';
    const approveStatus = deps.approveStatus ?? DEFAULT_APPROVE_STATUS;

    const root = deps.element;
    root.className = 'modal modal--diff-review modal-chrome';
    root.setAttribute('data-modal', 'diff-review');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', 'Review diff');
    root.setAttribute('data-task-id', params.taskId);

    deps.overlayManager.openOverlay(DIFF_REVIEW_OVERLAY_ID, root);

    let closed = false;
    const close = (): void => {
        if (closed) return;
        closed = true;
        deps.overlayManager.closeOverlay(DIFF_REVIEW_OVERLAY_ID);
        // Remove the root element from the DOM. The overlay manager
        // sets `aria-hidden="true"` on close but does not detach the
        // node — without an explicit removal the modal stays visible
        // after Approve / Request changes / Close. Use the standard
        // `.remove()` DOM method when available; the test shim's
        // element doesn't implement it, so the optional-call guard
        // keeps the spec suite green.
        const r = root as unknown as { remove?: () => void };
        try { r.remove?.(); } catch { /* best-effort */ }
    };

    const state = emptyRenderState();

    const loaded = (async (): Promise<void> => {
        renderLoading(root, doc);
        let response: DiffReviewFetchResponse;
        try {
            response = await deps.fetch(buildDiffUrl(params));
        } catch (err) {
            renderError(
                root,
                doc,
                err instanceof Error ? err.message : 'network error',
                () => close(),
            );
            return;
        }
        if (!response.ok) {
            renderError(
                root,
                doc,
                `Failed to load diff (HTTP ${response.status})`,
                () => close(),
            );
            return;
        }
        let body: unknown;
        try {
            body = await response.json();
        } catch (err) {
            renderError(
                root,
                doc,
                err instanceof Error ? err.message : 'invalid response body',
                () => close(),
            );
            return;
        }
        const diff = coerceDiffResponse(body);
        const humanReviewMode = deps.humanReviewMode === true;
        renderDiff(root, doc, diff, state, {
            humanReviewMode,
            onClose: (): void => close(),
            onApprove: (): void => {
                if (humanReviewMode) {
                    deps.onHumanReviewApprove?.(params);
                    close();
                    return;
                }
                deps.dispatch({
                    type: UPDATE_TASK_COMMAND,
                    actor,
                    issuedAt: now(),
                    payload: stripUndefined({
                        taskId: params.taskId,
                        flowId: params.flowId,
                        status: approveStatus,
                    }),
                });
                close();
            },
            onReject: (): void => {
                if (humanReviewMode) {
                    // Reject in human-review mode is wired via
                    // onSubmitFeedback inside the footer renderer; this
                    // top-level onReject only fires for the legacy flow.
                    return;
                }
                close();
                deps.onReject(params);
            },
            onSubmitFeedback: (feedback: string): void => {
                if (!humanReviewMode) return;
                deps.onHumanReviewReject?.(params, feedback);
                close();
            },
        });
    })();

    return {
        close,
        loaded,
    };
}

// ---------------------------------------------------------------------------
// Loading / error views
// ---------------------------------------------------------------------------

function renderLoading(root: DiffReviewElement, doc: DiffReviewDocument): void {
    const wrap = doc.createElement('div');
    wrap.className = 'diff-review-loading';
    wrap.setAttribute('data-diff-review-loading', '');
    wrap.textContent = 'Loading diff…';
    root.replaceChildren(wrap);
}

function renderError(
    root: DiffReviewElement,
    doc: DiffReviewDocument,
    message: string,
    onDismiss: () => void,
): void {
    const wrap = doc.createElement('div');
    wrap.className = 'diff-review-error';
    wrap.setAttribute('data-diff-review-error', '');

    const text = doc.createElement('p');
    text.className = 'diff-review-error-message';
    text.textContent = message;
    wrap.appendChild(text);

    const dismiss = doc.createElement('button');
    dismiss.setAttribute('type', 'button');
    dismiss.setAttribute('data-action', 'dismiss');
    dismiss.className = 'diff-review-error-dismiss';
    dismiss.textContent = 'Close';
    attachClick(dismiss, onDismiss);
    wrap.appendChild(dismiss);

    root.replaceChildren(wrap);
}

// ---------------------------------------------------------------------------
// Diff renderer
// ---------------------------------------------------------------------------

interface RenderHandlers {
    readonly onApprove: () => void;
    readonly onReject: () => void;
    /** Close the modal without dispatching anything — bound to the
     *  header's × button. */
    readonly onClose: () => void;
    /** Toggle the pre-commit human-review footer. */
    readonly humanReviewMode?: boolean;
    /** Called with the textarea's trimmed value when the operator
     *  clicks Request changes in human-review mode. */
    readonly onSubmitFeedback?: (feedback: string) => void;
}

function renderDiff(
    root: DiffReviewElement,
    doc: DiffReviewDocument,
    diff: TaskDiffResponse,
    state: RenderState,
    handlers: RenderHandlers,
): void {
    const header = renderHeader(doc, state, handlers);
    const body = renderBody(doc, diff, state);
    const footer = renderFooter(doc, handlers);
    root.replaceChildren(header, body, footer);
    updateHunkChrome(state);
}

function renderHeader(
    doc: DiffReviewDocument,
    state: RenderState,
    _handlers: RenderHandlers,
): DiffReviewElement {
    const head = doc.createElement('header');
    head.className = 'diff-review-header diff-hunk-nav modal-chrome__header';
    head.setAttribute('data-diff-hunk-nav', '');

    const title = doc.createElement('h2');
    title.className = 'diff-review-title';
    title.textContent = _handlers.humanReviewMode
        ? 'Review changes before commit'
        : 'Review diff';
    head.appendChild(title);

    const counter = doc.createElement('span');
    counter.className = 'diff-review-hunk-counter';
    counter.setAttribute('data-diff-hunk-counter', '');
    head.appendChild(counter);
    state.counter = counter;

    const prev = doc.createElement('button');
    prev.setAttribute('type', 'button');
    prev.setAttribute('data-action', 'prev-hunk');
    prev.className = 'diff-review-nav-button diff-review-nav-button--prev';
    prev.textContent = 'Prev hunk';
    attachClick(prev, () => navigate(state, -1));
    head.appendChild(prev);
    state.prevBtn = prev;

    const next = doc.createElement('button');
    next.setAttribute('type', 'button');
    next.setAttribute('data-action', 'next-hunk');
    next.className = 'diff-review-nav-button diff-review-nav-button--next';
    next.textContent = 'Next hunk';
    attachClick(next, () => navigate(state, 1));
    head.appendChild(next);
    state.nextBtn = next;

    // Close (×) — dismisses the modal without dispatching anything.
    // Provided so the operator can step away from the review without
    // making a decision; bound through to the modal's `close()` which
    // also removes the root element from the DOM.
    const close = doc.createElement('button');
    close.setAttribute('type', 'button');
    close.setAttribute('data-action', 'close');
    close.setAttribute('aria-label', 'Close review');
    close.className = 'diff-review-close';
    close.textContent = '×';
    attachClick(close, _handlers.onClose);
    head.appendChild(close);

    return head;
}

function renderBody(
    doc: DiffReviewDocument,
    diff: TaskDiffResponse,
    state: RenderState,
): DiffReviewElement {
    const body = doc.createElement('section');
    body.className = 'diff-review-body modal-chrome__body diff-review-body--two-pane';
    body.setAttribute('data-diff-review-body', '');

    state.hunks = [];
    state.diff = diff;

    if (diff.files.length === 0) {
        const empty = doc.createElement('div');
        empty.className = 'diff-review-empty';
        empty.setAttribute('data-diff-review-empty', '');
        empty.textContent = 'No changes to review.';
        body.appendChild(empty);
        return body;
    }

    // Two-pane layout: file list on the left, selected-file content on
    // the right. Mirrors the v1 board's review modal — the operator
    // scans the list, clicks a file, sees the full file in context with
    // +/- markers on the changed lines.
    if (state.selectedFileIndex >= diff.files.length) {
        state.selectedFileIndex = 0;
    }

    const fileList = doc.createElement('aside');
    fileList.className = 'diff-review-file-list';
    fileList.setAttribute('data-diff-review-file-list', '');
    state.fileListEl = fileList;
    renderFileList(doc, fileList, diff, state);
    body.appendChild(fileList);

    const right = doc.createElement('div');
    right.className = 'diff-review-file-content';
    right.setAttribute('data-diff-review-file-content', '');
    state.bodyContentEl = right;
    renderSelectedFile(doc, right, diff, state);
    body.appendChild(right);

    return body;
}

/**
 * Render the left-pane file picker. Each row shows the file path and
 * a tiny status hint (additions/deletions counted from the hunk lines).
 * The currently-selected row gets a visual highlight; clicking another
 * row swaps the right pane.
 */
function renderFileList(
    doc: DiffReviewDocument,
    list: DiffReviewElement,
    diff: TaskDiffResponse,
    state: RenderState,
): void {
    const items: DiffReviewElement[] = [];
    diff.files.forEach((file, fileIndex) => {
        const item = doc.createElement('button');
        item.setAttribute('type', 'button');
        item.setAttribute('data-diff-file-row', '');
        item.setAttribute('data-file-index', String(fileIndex));
        item.className = 'diff-review-file-row'
            + (fileIndex === state.selectedFileIndex ? ' diff-review-file-row--selected' : '');

        const pathEl = doc.createElement('span');
        pathEl.className = 'diff-review-file-row__path';
        pathEl.textContent = file.path;
        item.appendChild(pathEl);

        const counts = countAddDel(file);
        const stats = doc.createElement('span');
        stats.className = 'diff-review-file-row__stats';
        const add = doc.createElement('span');
        add.className = 'diff-review-file-row__add';
        add.textContent = `+${counts.adds}`;
        stats.appendChild(add);
        const del = doc.createElement('span');
        del.className = 'diff-review-file-row__del';
        del.textContent = `−${counts.dels}`;
        stats.appendChild(del);
        item.appendChild(stats);

        attachClick(item, () => {
            state.selectedFileIndex = fileIndex;
            // Re-render both panes so the highlight flips and the right
            // side swaps to the new file.
            const listEl = state.fileListEl;
            const rightEl = state.bodyContentEl;
            if (listEl && state.diff) {
                renderFileList(doc, listEl, state.diff, state);
            }
            if (rightEl && state.diff) {
                renderSelectedFile(doc, rightEl, state.diff, state);
            }
        });
        items.push(item);
    });
    list.replaceChildren(...items);
}

/**
 * Render the currently-selected file's full content into the right
 * pane: file header + every line of the unified diff, colour-coded by
 * `+`/`-`/space. Unchanged lines render as plain context so the
 * operator can read the change inside the file's surrounding code
 * (the server uses `--unified=10000` so every file's patch carries
 * the whole file by default).
 */
function renderSelectedFile(
    doc: DiffReviewDocument,
    container: DiffReviewElement,
    diff: TaskDiffResponse,
    state: RenderState,
): void {
    state.hunks = [];
    const file = diff.files[state.selectedFileIndex];
    if (!file) {
        container.replaceChildren();
        return;
    }

    const fileEl = doc.createElement('article');
    fileEl.className = 'diff-review-file';
    fileEl.setAttribute('data-diff-file', '');
    fileEl.setAttribute('data-file-path', file.path);

    const fileHeader = doc.createElement('h3');
    fileHeader.className = 'diff-review-file-header';
    fileHeader.setAttribute('data-diff-file-header', '');
    fileHeader.textContent = file.path;
    fileEl.appendChild(fileHeader);

    file.hunks.forEach((hunk, hunkIndex) => {
        const hunkEl = doc.createElement('div');
        hunkEl.className = 'diff-review-hunk';
        hunkEl.setAttribute('data-diff-hunk', '');
        hunkEl.setAttribute('data-file-index', String(state.selectedFileIndex));
        hunkEl.setAttribute('data-hunk-index', String(hunkIndex));

        const header = doc.createElement('div');
        header.className = 'diff-review-hunk-header';
        header.setAttribute('data-diff-hunk-header', '');
        header.textContent = hunk.header;
        hunkEl.appendChild(header);

        const lines = doc.createElement('pre');
        lines.className = 'diff-review-hunk-lines';
        lines.setAttribute('data-diff-hunk-lines', '');
        for (const line of hunk.lines) {
            const lineEl = doc.createElement('span');
            lineEl.className = `diff-review-line diff-review-line--${line.kind}`;
            lineEl.setAttribute('data-diff-line-kind', line.kind);
            lineEl.textContent =
                (line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' ')
                + line.text;
            lines.appendChild(lineEl);
        }
        hunkEl.appendChild(lines);

        fileEl.appendChild(hunkEl);
        state.hunks.push({
            fileIndex: state.selectedFileIndex,
            hunkIndex,
            element: hunkEl,
        });
    });

    container.replaceChildren(fileEl);
}

function countAddDel(file: DiffFile): { adds: number; dels: number } {
    let adds = 0;
    let dels = 0;
    for (const hunk of file.hunks) {
        for (const line of hunk.lines) {
            if (line.kind === 'add') adds += 1;
            else if (line.kind === 'del') dels += 1;
        }
    }
    return { adds, dels };
}

function renderFooter(
    doc: DiffReviewDocument,
    handlers: RenderHandlers,
): DiffReviewElement {
    const foot = doc.createElement('footer');
    foot.className = 'diff-review-footer modal-chrome__footer';
    foot.setAttribute('data-diff-review-footer', '');

    if (handlers.humanReviewMode) {
        // Pre-commit human-review footer: feedback textarea (required
        // for Request changes) + Approve + Request changes buttons.
        // Operator must type a non-whitespace feedback note before the
        // Request changes button activates; Approve advances through
        // on_success unconditionally.
        const textarea = doc.createElement('textarea');
        textarea.className = 'diff-review-feedback';
        textarea.setAttribute('data-action', 'feedback');
        textarea.setAttribute(
            'placeholder',
            'Required to request changes — describe what needs to change.',
        );
        (textarea as unknown as { rows: number }).rows = 3;
        foot.appendChild(textarea);

        const buttonRow = doc.createElement('div');
        buttonRow.className = 'diff-review-action-row';
        foot.appendChild(buttonRow);

        const reject = doc.createElement('button');
        reject.setAttribute('type', 'button');
        reject.setAttribute('data-action', 'request-changes');
        reject.className =
            'diff-review-action diff-review-action--reject diff-review-action--request-changes';
        reject.textContent = 'Request changes';
        (reject as unknown as { disabled: boolean }).disabled = true;
        reject.setAttribute(
            'title',
            'Type feedback above to enable Request changes.',
        );
        buttonRow.appendChild(reject);

        const approve = doc.createElement('button');
        approve.setAttribute('type', 'button');
        approve.setAttribute('data-action', 'approve');
        approve.className = 'diff-review-action diff-review-action--approve';
        approve.textContent = 'Approve';
        attachClick(approve, handlers.onApprove);
        buttonRow.appendChild(approve);

        // Wire the textarea ↔ Request changes gating. The element's
        // typing surface is intentionally loose (`unknown as ...`)
        // because the test-friendly DiffReviewElement shape doesn't
        // expose oninput / value — production runs in a real DOM
        // where those properties exist.
        const ta = textarea as unknown as {
            value: string;
            oninput: (() => void) | null;
        };
        const setDisabled = (disabled: boolean): void => {
            (reject as unknown as { disabled: boolean }).disabled = disabled;
        };
        ta.oninput = (): void => {
            const text = (ta.value ?? '').trim();
            setDisabled(text.length === 0);
        };
        attachClick(reject, () => {
            const text = (ta.value ?? '').trim();
            if (text.length === 0) return;
            handlers.onSubmitFeedback?.(text);
        });

        return foot;
    }

    const reject = doc.createElement('button');
    reject.setAttribute('type', 'button');
    reject.setAttribute('data-action', 'reject');
    reject.className = 'diff-review-action diff-review-action--reject';
    reject.textContent = 'Reject';
    attachClick(reject, handlers.onReject);
    foot.appendChild(reject);

    const approve = doc.createElement('button');
    approve.setAttribute('type', 'button');
    approve.setAttribute('data-action', 'approve');
    approve.className = 'diff-review-action diff-review-action--approve';
    approve.textContent = 'Approve';
    attachClick(approve, handlers.onApprove);
    foot.appendChild(approve);

    return foot;
}

// ---------------------------------------------------------------------------
// Hunk navigation
// ---------------------------------------------------------------------------

function navigate(state: RenderState, delta: number): void {
    if (state.hunks.length === 0) return;
    const last = state.hunks.length - 1;
    let next = state.activeIndex + delta;
    if (next < 0) next = 0;
    if (next > last) next = last;
    if (next === state.activeIndex) {
        // Re-scroll even on a no-op so a repeated click still parks the
        // current hunk at the viewport edge. The unit-test shim ignores
        // scrollIntoView; production browsers honour it.
        scrollToActive(state);
        return;
    }
    state.activeIndex = next;
    updateHunkChrome(state);
}

function updateHunkChrome(state: RenderState): void {
    state.hunks.forEach((entry, idx) => {
        const isActive = idx === state.activeIndex;
        entry.element.setAttribute('data-active', isActive ? 'true' : 'false');
    });
    if (state.counter) {
        if (state.hunks.length === 0) {
            state.counter.textContent = '0 / 0 hunks';
        } else {
            state.counter.textContent = `${state.activeIndex + 1} / ${state.hunks.length} hunks`;
        }
    }
    if (state.prevBtn) {
        const atStart = state.hunks.length === 0 || state.activeIndex <= 0;
        state.prevBtn.setAttribute('aria-disabled', atStart ? 'true' : 'false');
    }
    if (state.nextBtn) {
        const atEnd =
            state.hunks.length === 0 || state.activeIndex >= state.hunks.length - 1;
        state.nextBtn.setAttribute('aria-disabled', atEnd ? 'true' : 'false');
    }
    scrollToActive(state);
}

function scrollToActive(state: RenderState): void {
    const entry = state.hunks[state.activeIndex];
    if (!entry) return;
    const el = entry.element;
    if (typeof el.scrollIntoView === 'function') {
        el.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
}

// ---------------------------------------------------------------------------
// Response coercion — defensive parsing for the proxied payload
// ---------------------------------------------------------------------------

function coerceDiffResponse(value: unknown): TaskDiffResponse {
    if (!value || typeof value !== 'object') return { files: [] };
    const v = value as { files?: unknown };
    if (!Array.isArray(v.files)) return { files: [] };
    const files: DiffFile[] = [];
    for (const f of v.files) {
        if (!f || typeof f !== 'object') continue;
        const file = f as { path?: unknown; hunks?: unknown };
        if (typeof file.path !== 'string') continue;
        if (!Array.isArray(file.hunks)) continue;
        const hunks: DiffHunk[] = [];
        for (const h of file.hunks) {
            if (!h || typeof h !== 'object') continue;
            const hunk = h as { header?: unknown; lines?: unknown };
            if (typeof hunk.header !== 'string') continue;
            if (!Array.isArray(hunk.lines)) continue;
            const lines: DiffLine[] = [];
            for (const l of hunk.lines) {
                if (!l || typeof l !== 'object') continue;
                const line = l as { kind?: unknown; text?: unknown };
                if (line.kind !== 'add' && line.kind !== 'del' && line.kind !== 'ctx') {
                    continue;
                }
                if (typeof line.text !== 'string') continue;
                lines.push({ kind: line.kind, text: line.text });
            }
            hunks.push({ header: hunk.header, lines });
        }
        files.push({ path: file.path, hunks });
    }
    return { files };
}

function stripUndefined<T extends Record<string, unknown>>(record: T): Partial<T> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(record)) {
        if (v !== undefined) out[k] = v;
    }
    return out as Partial<T>;
}
