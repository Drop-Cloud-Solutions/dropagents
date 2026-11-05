/**
 * Review-report modal (AP-IFB-007).
 *
 * Operator-facing modal that surfaces the reviewer agent's report on a
 * task that finished the Review stage and exposes the three V1 actions
 * — Close, Dismiss, and Implement. Ports the V1 review-report markup
 * (pipeline/board/board.html:91-105) and the matching dismiss/implement
 * handlers in pipeline/board/board.js onto the AP-IFF-002 overlay
 * manager and the AP-IFG-008 command sink, mirroring the lifecycle shape
 * of {@link ./new-plan} and {@link ./new-project}.
 *
 * State machine (simpler than new-plan — no decomposer poll, no review
 * step; closer to {@link ./new-project} but action-keyed so the in-
 * flight state tracks which button the operator pressed):
 *
 *   rr-ready      — report visible, three buttons. Close detaches the
 *                   overlay; Dismiss and Implement advance to
 *                   rr-submitting with the matching `action` field.
 *   rr-submitting — command in flight. Spinner is rendered. On resolve
 *                   transitions to rr-done; on reject transitions to
 *                   rr-error and surfaces a toast.
 *   rr-done       — success state with a close button.
 *   rr-error      — failure state with a close button and the error
 *                   message inline.
 *
 * Integration
 * -----------
 * - Mounting: the modal is registered with the AP-IFF-002 overlay
 *   manager via `overlayManager.openOverlay('review-report', el)` on
 *   open and `closeOverlay('review-report')` on close. The panel
 *   element is appended under `#overlay-root` when the host does not
 *   supply a custom mount.
 * - Toasts: dispatch failures funnel through the AP-IFF-004 `showToast`
 *   queue via {@link ReviewReportDeps.showToast}.
 * - Commands: Dismiss and Implement go through a
 *   {@link ReviewReportCommandSink} port. The shape mirrors the
 *   investigate modal's `ImplementFromInvestigation` /
 *   `DismissInvestigation` semantics — both actions take a `taskId` and
 *   `reportId`, and Dismiss carries an optional `reason` so the V1
 *   "dismiss with note" flow survives. Production wires this to POSTs
 *   against the board's `/commands/*` proxy in task-008 when the per-
 *   card "View report" button gets hooked up; tests pass a fake.
 *
 * Renderer shape
 * --------------
 * Follows the structural-DOM pattern used by new-plan.ts /
 * new-project.ts — the module touches a narrow {@link ModalDocument} /
 * {@link ModalElement} surface so unit tests drive it with a hand-
 * rolled shim, no jsdom.
 *
 * The modal builds its DOM dynamically; index.html registers a
 * `<template id="review-report-modal-template">` element with the V1-
 * style static markup as a parallel registration point (matching the
 * task-card-template / plan-card-template / new-project-modal-template
 * precedent).
 */

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

/** Stable id pushed onto the overlay-manager stack. */
export const REVIEW_REPORT_OVERLAY_ID = 'review-report';

/** DOM id of the default mount target. Matches AP-IFF-001 `#overlay-root`. */
export const OVERLAY_ROOT_ID = 'overlay-root';

/** DOM id of the `<template>` element registered in `index.html`. */
export const REVIEW_REPORT_TEMPLATE_ID = 'review-report-modal-template';

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

export type ReviewReportAction = 'dismiss' | 'implement';

export type ReviewReportStateKind =
    | 'rr-ready'
    | 'rr-submitting'
    | 'rr-done'
    | 'rr-error';

export interface ReviewReportReady {
    readonly kind: 'rr-ready';
    readonly taskId: string;
    readonly reportId: string;
    readonly content: string;
    readonly title?: string;
}

export interface ReviewReportSubmitting {
    readonly kind: 'rr-submitting';
    readonly taskId: string;
    readonly reportId: string;
    readonly action: ReviewReportAction;
}

export interface ReviewReportDone {
    readonly kind: 'rr-done';
    readonly taskId: string;
    readonly reportId: string;
    readonly action: ReviewReportAction;
}

export interface ReviewReportError {
    readonly kind: 'rr-error';
    readonly taskId: string;
    readonly reportId: string;
    readonly action: ReviewReportAction;
    readonly message: string;
}

export type ReviewReportState =
    | ReviewReportReady
    | ReviewReportSubmitting
    | ReviewReportDone
    | ReviewReportError;

// ---------------------------------------------------------------------------
// Command-sink port surfaces
// ---------------------------------------------------------------------------

export interface DismissReportInput {
    readonly taskId: string;
    readonly reportId: string;
    /** V1 parity: optional free-text note carried alongside the dismissal. */
    readonly reason?: string;
}

export interface ImplementReportInput {
    readonly taskId: string;
    readonly reportId: string;
}

/**
 * Port over the board command bus. Production wires this to POSTs
 * against the board's `/commands/*` proxy (per the V1 dismiss/implement
 * handlers in pipeline/board/board.js); tests pass a fake.
 */
export interface ReviewReportCommandSink {
    dismissReport(input: DismissReportInput): Promise<void>;
    implementReport(input: ImplementReportInput): Promise<void>;
}

// ---------------------------------------------------------------------------
// Toast + overlay-manager surfaces
// ---------------------------------------------------------------------------

export type ToastKind = 'info' | 'error' | 'success';

export interface ToastInput {
    readonly message: string;
    readonly kind?: ToastKind;
}

export type ShowToastFn = (input: ToastInput) => void;

/**
 * Minimal overlay-manager surface the modal needs. The real
 * `OverlayManager` (AP-IFF-002) satisfies this structurally.
 */
export interface OverlayManagerLike {
    openOverlay(id: string, element: unknown): unknown;
    closeOverlay(id: string): void;
}

// ---------------------------------------------------------------------------
// Structural DOM types — keep tests jsdom-free
// ---------------------------------------------------------------------------

export interface ModalEvent {
    preventDefault?(): void;
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
    onclick?: () => void;
    oninput?: () => void;
}

interface MaybeGlobalDocument {
    document?: ModalDocument;
}

function resolveDocument(doc: ModalDocument | undefined): ModalDocument {
    if (doc) return doc;
    const candidate = (globalThis as MaybeGlobalDocument).document;
    if (!candidate) {
        throw new Error(
            'review-report modal: no document available — pass one explicitly when '
                + 'rendering outside a browser context.',
        );
    }
    return candidate;
}

// ---------------------------------------------------------------------------
// Deps + handle
// ---------------------------------------------------------------------------

/** What a mounted report chat pane hands back so the modal can tear it down. */
export interface ReviewReportChatHandle {
    readonly destroy: () => void;
}

export interface ReviewReportChatContext {
    readonly taskId: string;
    readonly projectId: string;
    readonly title: string;
}

export interface ReviewReportDeps {
    readonly overlayManager: OverlayManagerLike;
    readonly commands: ReviewReportCommandSink;
    readonly showToast: ShowToastFn;
    readonly doc?: ModalDocument;
    /** Optional mount root. Defaults to `#overlay-root`. */
    readonly mountRoot?: ModalElement;
    /**
     * Mount a chat pane bound to this report into `container`.
     *
     * Injected rather than imported so this module stays DOM-structural
     * and jsdom-free: the pane needs a real HTMLElement, the host has
     * one. Absent (or with no `projectId` on the open input) the Chat
     * button is not rendered at all — an inert button on a modal is
     * worse than no button.
     */
    readonly mountChat?: (
        container: ModalElement,
        ctx: ReviewReportChatContext,
    ) => ReviewReportChatHandle;
}

export interface ReviewReportOpenInput {
    readonly taskId: string;
    readonly reportId: string;
    /** Report body — markdown / plain text. Rendered inside a `<pre>`. */
    readonly content: string;
    /** Optional heading override. Defaults to "Review report". */
    readonly title?: string;
    /**
     * Owning project. Required for the chat pane (a chat session cannot
     * be created without one); its absence hides the Chat button rather
     * than failing at session-create time.
     */
    readonly projectId?: string;
}

export interface ReviewReportModalHandle {
    /**
     * Open the modal with the supplied report content. Idempotent:
     * re-opening tears down the previous panel before mounting a fresh
     * one and resets state to rr-ready.
     */
    open(input: ReviewReportOpenInput): void;
    /** Close the modal, detach the overlay, and clear state. */
    close(): void;
    /** Snapshot of the current state. `null` when closed. */
    getState(): ReviewReportState | null;
    /**
     * Dispatch DismissReport through the command sink. Transitions
     * rr-ready → rr-submitting → (rr-done | rr-error). Optional reason
     * mirrors the V1 "dismiss with note" flow.
     */
    dismiss(input?: { readonly reason?: string }): Promise<void>;
    /**
     * Dispatch ImplementReport through the command sink. Transitions
     * rr-ready → rr-submitting → (rr-done | rr-error).
     */
    implement(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createReviewReportModal(deps: ReviewReportDeps): ReviewReportModalHandle {
    const doc = resolveDocument(deps.doc);

    let panel: ModalElement | null = null;
    let state: ReviewReportState | null = null;
    /**
     * Token incremented on every state transition (including close).
     * Async callbacks captured before a transition compare against this
     * when they resolve so a stale dismiss/implement result doesn't
     * leak into the next state.
     */
    let token = 0;

    // Form-input ref — the optional dismiss-reason textarea. Lives
    // outside the renderer so the operator's draft survives across the
    // rr-ready re-renders that don't replace the form (none today, but
    // matches the new-project.ts convention so future churn stays safe).
    let reasonInput: ModalElementWithEvents | null = null;

    // Chat pane state. Held in the closure rather than in ReviewReportState
    // because the pane must SURVIVE state transitions: dismissing or
    // implementing re-renders the body, and a pane rebuilt mid-turn would
    // drop the operator's thread and orphan the streaming read. `render()`
    // re-attaches this exact node instead of recreating it.
    let chatPane: ModalElement | null = null;
    let chatHandle: ReviewReportChatHandle | null = null;
    let chatProjectId: string | null = null;
    let chatTitle = 'Review report';

    function teardownChat(): void {
        if (chatHandle !== null) {
            chatHandle.destroy();
            chatHandle = null;
        }
        if (chatPane !== null) {
            chatPane.remove();
            chatPane = null;
        }
        if (panel !== null) panel.className = 'review-report-modal modal-chrome';
    }

    function toggleChat(ctx: ReviewReportChatContext): void {
        if (panel === null || !deps.mountChat) return;
        if (chatPane !== null) {
            teardownChat();
            return;
        }
        const pane = doc.createElement('div');
        pane.className = 'rr-chat-pane';
        // Appended directly rather than via render() so an in-progress
        // dismiss-reason draft is not wiped just by opening the chat.
        panel.appendChild(pane);
        panel.className = 'review-report-modal modal-chrome review-report-modal--split';
        chatPane = pane;
        try {
            chatHandle = deps.mountChat(pane, ctx);
        } catch (err) {
            // A pane that failed to mount must not leave a split layout
            // with an empty column and no way back.
            teardownChat();
            deps.showToast({
                message: `Report chat unavailable: ${
                    err instanceof Error ? err.message : String(err)
                }`,
                kind: 'error',
            });
        }
    }

    function setState(next: ReviewReportState | null): void {
        token++;
        state = next;
        render();
    }

    function toError(
        taskId: string,
        reportId: string,
        action: ReviewReportAction,
        message: string,
    ): void {
        deps.showToast({ message, kind: 'error' });
        setState({ kind: 'rr-error', taskId, reportId, action, message });
    }

    function resolveMountRoot(): ModalElement {
        if (deps.mountRoot) return deps.mountRoot;
        const root = doc.getElementById(OVERLAY_ROOT_ID);
        if (!root) {
            throw new Error(
                `review-report modal: mount root "#${OVERLAY_ROOT_ID}" not found and no `
                    + 'mountRoot dependency supplied.',
            );
        }
        return root;
    }

    // ---------------------------------------------------------------------
    // Public API
    // ---------------------------------------------------------------------

    function open(input: ReviewReportOpenInput): void {
        if (typeof input.taskId !== 'string' || input.taskId.length === 0) {
            throw new Error('review-report modal: open() requires a non-empty taskId.');
        }
        if (typeof input.reportId !== 'string' || input.reportId.length === 0) {
            throw new Error('review-report modal: open() requires a non-empty reportId.');
        }
        // Re-opening: tear down the previous panel before mounting a fresh
        // one so the overlay-manager stack stays consistent (no duplicate id).
        if (panel !== null) {
            doClose();
        }
        chatProjectId = typeof input.projectId === 'string' && input.projectId.length > 0
            ? input.projectId
            : null;
        chatTitle = input.title ?? 'Review report';
        const root = resolveMountRoot();
        panel = doc.createElement('div');
        panel.className = 'review-report-modal modal-chrome';
        panel.setAttribute('data-review-report-modal', '');
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-modal', 'true');
        panel.setAttribute('aria-labelledby', 'review-report-title');
        root.appendChild(panel);
        deps.overlayManager.openOverlay(REVIEW_REPORT_OVERLAY_ID, panel);
        setState({
            kind: 'rr-ready',
            taskId: input.taskId,
            reportId: input.reportId,
            content: input.content,
            title: input.title,
        });
    }

    function doClose(): void {
        token++;
        // Before the panel goes: destroying the pane aborts its in-flight
        // turn and tells the worker to stop the agent. Closing the modal
        // otherwise left a `claude` process running with nobody reading it.
        teardownChat();
        if (panel !== null) {
            deps.overlayManager.closeOverlay(REVIEW_REPORT_OVERLAY_ID);
            panel.remove();
            panel = null;
        }
        state = null;
        reasonInput = null;
    }

    function close(): void {
        doClose();
    }

    function getState(): ReviewReportState | null {
        return state;
    }

    async function dismiss(input?: { readonly reason?: string }): Promise<void> {
        if (!state || state.kind !== 'rr-ready') {
            throw new Error(
                `review-report modal: dismiss() requires rr-ready state, got "${state?.kind ?? 'closed'}".`,
            );
        }
        const { taskId, reportId } = state;
        // Pull a reason from the rendered textarea when the caller did
        // not supply one explicitly — mirrors the new-project DOM-read
        // pattern so click handlers and direct test calls behave the same.
        const fromInput = (reasonInput?.value ?? '').trim();
        const reason = (input?.reason ?? fromInput) || undefined;
        setState({ kind: 'rr-submitting', taskId, reportId, action: 'dismiss' });
        const localToken = token;
        try {
            await deps.commands.dismissReport({ taskId, reportId, reason });
            if (localToken !== token) return; // closed / advanced during await
            setState({ kind: 'rr-done', taskId, reportId, action: 'dismiss' });
        } catch (err) {
            if (localToken !== token) return;
            toError(taskId, reportId, 'dismiss', errorMessage(err, 'Dismiss report failed'));
        }
    }

    async function implement(): Promise<void> {
        if (!state || state.kind !== 'rr-ready') {
            throw new Error(
                `review-report modal: implement() requires rr-ready state, got "${state?.kind ?? 'closed'}".`,
            );
        }
        const { taskId, reportId } = state;
        setState({ kind: 'rr-submitting', taskId, reportId, action: 'implement' });
        const localToken = token;
        try {
            await deps.commands.implementReport({ taskId, reportId });
            if (localToken !== token) return;
            setState({ kind: 'rr-done', taskId, reportId, action: 'implement' });
        } catch (err) {
            if (localToken !== token) return;
            toError(taskId, reportId, 'implement', errorMessage(err, 'Implement report failed'));
        }
    }

    // ---------------------------------------------------------------------
    // Renderer
    // ---------------------------------------------------------------------

    function render(): void {
        if (panel === null || state === null) return;
        panel.setAttribute('data-state', state.kind);
        const view = (() => {
            switch (state.kind) {
                case 'rr-ready':
                    return renderReady(state);
                case 'rr-submitting':
                    return renderSubmitting(state);
                case 'rr-done':
                    return renderDone(state);
                case 'rr-error':
                    return renderError(state);
            }
        })();
        // Re-attach (not rebuild) the chat pane: replaceChildren moves the
        // SAME node, so the thread, its listeners and any in-flight stream
        // survive a dismiss/implement transition.
        if (chatPane !== null) {
            panel.replaceChildren(view, chatPane);
        } else {
            panel.replaceChildren(view);
        }
    }

    function makeButton(label: string, action: string, onClick: () => void): ModalElement {
        const btn = doc.createElement('button') as ModalElementWithEvents;
        btn.setAttribute('type', 'button');
        btn.setAttribute('data-action', action);
        btn.className = 'rr-button';
        btn.textContent = label;
        btn.onclick = onClick;
        return btn;
    }

    function renderReady(s: ReviewReportReady): ModalElement {
        // Drop the previous reason-input ref before re-rendering — a fresh
        // rr-ready paint replaces the textarea, so any old reference would
        // dangle.
        reasonInput = null;

        const wrap = doc.createElement('section');
        wrap.className = 'rr-state rr-state--ready';
        wrap.setAttribute('data-state-body', 'rr-ready');
        wrap.setAttribute('data-task-id', s.taskId);
        wrap.setAttribute('data-report-id', s.reportId);

        const heading = doc.createElement('h3');
        heading.setAttribute('id', 'review-report-title');
        heading.textContent = s.title ?? 'Review report';
        wrap.appendChild(heading);

        const content = doc.createElement('pre');
        content.className = 'rr-report-content';
        content.setAttribute('data-report-content', '');
        content.textContent = s.content;
        wrap.appendChild(content);

        // A placeholder body means there is nothing to act ON: the
        // reportId is synthetic (`task:<id>`) and Implement/Dismiss would
        // fail server-side ("no report ..."). Render Close only, so the
        // modal never offers actions that cannot work. Callers normally
        // gate the View-report button on report existence; this is the
        // last line of defence for direct opens.
        const actionable = !s.reportId.startsWith('task:');

        const footer = doc.createElement('div');
        footer.className = 'rr-footer';
        if (actionable) {
            const reasonEl = doc.createElement('textarea') as ModalElementWithEvents;
            reasonEl.className = 'rr-reason';
            reasonEl.setAttribute('data-input', 'reason');
            reasonEl.setAttribute('aria-label', 'Dismiss reason (optional)');
            reasonEl.setAttribute('placeholder', 'Dismiss reason (optional)');
            reasonEl.value = '';
            reasonInput = reasonEl;
            wrap.appendChild(reasonEl);
        }
        footer.appendChild(
            makeButton('Close', 'close', () => {
                close();
            }),
        );
        // Chat about the report. Gated on the same `actionable` flag as
        // Implement/Dismiss: a synthetic `task:` reportId means there is
        // no report, and a chat whose scope context resolves to nothing
        // would answer about the project at large while appearing to read
        // the report on screen.
        if (actionable && deps.mountChat && chatProjectId !== null) {
            const projectId = chatProjectId;
            footer.appendChild(
                makeButton('💬 Chat', 'chat', () => {
                    toggleChat({ taskId: s.taskId, projectId, title: chatTitle });
                }),
            );
        }
        if (actionable) {
            footer.appendChild(
                makeButton('Dismiss', 'dismiss', () => {
                    void dismiss();
                }),
            );
            footer.appendChild(
                makeButton('Implement', 'implement', () => {
                    void implement();
                }),
            );
        }
        wrap.appendChild(footer);
        return wrap;
    }

    function renderSubmitting(s: ReviewReportSubmitting): ModalElement {
        const wrap = doc.createElement('section');
        wrap.className = 'rr-state rr-state--submitting';
        wrap.setAttribute('data-state-body', 'rr-submitting');
        wrap.setAttribute('data-task-id', s.taskId);
        wrap.setAttribute('data-report-id', s.reportId);
        wrap.setAttribute('data-action', s.action);

        const msg = doc.createElement('p');
        msg.textContent
            = s.action === 'implement' ? 'Queuing implementation…' : 'Dismissing report…';
        wrap.appendChild(msg);

        const spinner = doc.createElement('div');
        spinner.className = 'rr-spinner';
        spinner.setAttribute('role', 'status');
        spinner.setAttribute('aria-live', 'polite');
        spinner.textContent = 'Working…';
        wrap.appendChild(spinner);
        return wrap;
    }

    function renderDone(s: ReviewReportDone): ModalElement {
        const wrap = doc.createElement('section');
        wrap.className = 'rr-state rr-state--done';
        wrap.setAttribute('data-state-body', 'rr-done');
        wrap.setAttribute('data-task-id', s.taskId);
        wrap.setAttribute('data-report-id', s.reportId);
        wrap.setAttribute('data-action', s.action);

        const msg = doc.createElement('p');
        msg.textContent
            = s.action === 'implement'
                ? 'Implementation queued.'
                : 'Report dismissed.';
        wrap.appendChild(msg);

        wrap.appendChild(
            makeButton('Close', 'close', () => {
                close();
            }),
        );
        return wrap;
    }

    function renderError(s: ReviewReportError): ModalElement {
        const wrap = doc.createElement('section');
        wrap.className = 'rr-state rr-state--error';
        wrap.setAttribute('data-state-body', 'rr-error');
        wrap.setAttribute('data-task-id', s.taskId);
        wrap.setAttribute('data-report-id', s.reportId);
        wrap.setAttribute('data-action', s.action);

        const msg = doc.createElement('p');
        msg.setAttribute('data-error-message', '');
        msg.setAttribute('role', 'alert');
        msg.textContent = s.message;
        wrap.appendChild(msg);

        wrap.appendChild(
            makeButton('Close', 'close', () => {
                close();
            }),
        );
        return wrap;
    }

    function errorMessage(err: unknown, fallback: string): string {
        if (err instanceof Error && err.message) return err.message;
        if (typeof err === 'string' && err.length > 0) return err;
        return fallback;
    }

    return {
        open,
        close,
        getState,
        dismiss,
        implement,
    };
}
