/**
 * Reject modal (AP-IFF-016).
 *
 * The operator-facing "reject with reason" prompt the board surfaces when
 * a reviewer-stage task needs to be sent back to the developer agent
 * with feedback. Mirrors the v1 board's `#reject-overlay` contract:
 *
 *   1. A `<textarea>` for the reason.
 *   2. A primary `Reject` button that requires a non-empty reason.
 *   3. A secondary `Cancel` button that closes without dispatching.
 *
 * Dispatch shape — matches the v1 board's commit-reject payload, lifted
 * onto the v2 CommandBus envelope used elsewhere in board-ui:
 *
 *   { type: 'UpdateTask', payload: { taskId, status: 'rejected', reason } }
 *
 * Architectural contract
 * ----------------------
 * - `openRejectModal(opts)` builds the modal DOM synchronously and
 *   returns a handle. The caller is responsible for mounting `handle.root`
 *   into `#overlay-root` and (where appropriate) registering it with the
 *   overlay-manager from {@link ../chrome/overlay-manager}. Keeping the
 *   mount step external means tests can drive the handle without a real
 *   `#overlay-root` element and the production wiring can stack the modal
 *   on top of whatever overlay is already open.
 * - `submit()` is the single source of truth for "operator hit Reject":
 *   the click handler calls it, and tests call it directly. It refuses
 *   to dispatch when the textarea is blank (whitespace-only counts as
 *   blank) and re-focuses the input so the operator sees where to type.
 * - `cancel()` is symmetric for the Cancel button — invokes `onClose`
 *   but never dispatches.
 * - DOM surfaces are structural so unit tests can drive the module with
 *   a hand-rolled shim, mirroring the pattern already established by
 *   `hosts/board-ui/client/chrome/sidebar.ts` and `.../toast.ts`. The
 *   real browser's `document` / `HTMLElement` satisfy the shape without
 *   adaptation.
 */

// ---------------------------------------------------------------------------
// Command shape — the modal's only side effect
// ---------------------------------------------------------------------------

/**
 * Command type emitted by the modal.
 *
 * This was `UpdateTask` with `{status:'rejected', reason}`, and
 * `UpdateTaskPayload` accepts neither field — the handler destructures
 * `taskId`, `investigation_thread`, `followup_inflight` and drops the
 * rest. So a reject emitted `TaskUpdated{taskId}`, a no-op: the task sat
 * on the board unchanged, no Retry appeared because nothing marked it
 * failed, and the operator's reason was never written anywhere. Three
 * reported symptoms, one silently discarded payload.
 *
 * `task.fail` is the flow engine's own fail path — the same command
 * `scripts/interrupt-task.ts` uses. It writes TaskFailed, which the
 * projection folds to status 'failed' (that is what surfaces Retry) and
 * whose `reason` is stored on `tasks.feedback`, so the retry re-runs the
 * agent with the rejection as `# Feedback to address`.
 */
export const REJECT_COMMAND_TYPE = 'task.fail' as const;

/** Retained for callers that label the operation; not sent on the wire. */
export const REJECT_STATUS = 'rejected' as const;

/**
 * Payload the modal hands to {@link RejectModalDeps.dispatch} — the
 * engine's FailTaskPayload shape.
 */
export interface RejectTaskPayload {
    readonly taskId: string;
    readonly reason: string;
}

export interface RejectTaskCommand {
    readonly type: typeof REJECT_COMMAND_TYPE;
    readonly payload: RejectTaskPayload;
}

// ---------------------------------------------------------------------------
// Structural DOM types — keep tests jsdom-free
// ---------------------------------------------------------------------------

/**
 * Minimal element surface the modal touches. Real `HTMLElement`
 * satisfies this structurally; `value` is the `<textarea>` slot and
 * `onclick` is the click handler the buttons rely on.
 */
export interface RejectModalElement {
    className: string;
    textContent: string | null;
    value: string;
    setAttribute(name: string, value: string): void;
    appendChild(child: RejectModalElement): RejectModalElement;
    focus?(): void;
    onclick?: () => void;
}

/** Minimal document surface — only `createElement` is needed. */
export interface RejectModalDocument {
    createElement(tagName: string): RejectModalElement;
}

interface MaybeGlobalDocument {
    document?: RejectModalDocument;
}

function resolveDocument(doc: RejectModalDocument | undefined): RejectModalDocument {
    if (doc) return doc;
    const candidate = (globalThis as MaybeGlobalDocument).document;
    if (!candidate) {
        throw new Error(
            'reject-modal: no document available — pass one explicitly when '
                + 'constructing outside a browser context.',
        );
    }
    return candidate;
}

// ---------------------------------------------------------------------------
// Public deps + handle
// ---------------------------------------------------------------------------

export interface RejectModalDeps {
    /** Document handle. Defaults to `globalThis.document` when omitted. */
    readonly doc?: RejectModalDocument;
    /**
     * Dispatcher invoked on a valid submit. Returning a promise is
     * supported so production wiring can await the command bus before
     * closing; tests pass a synchronous recorder.
     */
    readonly dispatch: (cmd: RejectTaskCommand) => void | Promise<void>;
    /**
     * Optional close hook. Invoked on cancel and after a successful
     * submit. The production host typically routes this through the
     * overlay-manager's `closeOverlay(id)` so the modal element gets
     * `aria-hidden="true"` and previously-focused element is restored.
     */
    readonly onClose?: () => void;
}

export interface RejectModalHandle {
    /** Root element — caller mounts this into `#overlay-root`. */
    readonly root: RejectModalElement;
    /** The textarea the operator types into. Exposed for focus tests. */
    readonly reasonInput: RejectModalElement;
    /** The primary Reject button. */
    readonly submitButton: RejectModalElement;
    /** The secondary Cancel button. */
    readonly cancelButton: RejectModalElement;
    /**
     * Programmatic submit. Returns the dispatched command on success,
     * or `null` when the reason is blank (operator must type something).
     * Production click handlers go through this; tests call it directly.
     */
    submit(): Promise<RejectTaskCommand | null>;
    /** Programmatic cancel — invokes `onClose`, never dispatches. */
    cancel(): void;
}

// ---------------------------------------------------------------------------
// Open
// ---------------------------------------------------------------------------

export interface OpenRejectModalOptions extends RejectModalDeps {
    /** The task being rejected. Stamped into every dispatched command. */
    readonly taskId: string;
}

/**
 * Build the reject modal DOM and wire its buttons. The caller is
 * responsible for appending `handle.root` into the page and (typically)
 * registering it with the overlay-manager. Returns synchronously.
 */
export function openRejectModal(opts: OpenRejectModalOptions): RejectModalHandle {
    const doc = resolveDocument(opts.doc);
    const { taskId, dispatch, onClose } = opts;

    const root = doc.createElement('div');
    root.className = 'overlay reject-overlay modal-chrome__overlay';
    root.setAttribute('data-reject-modal', '');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-labelledby', 'reject-modal-title');
    root.setAttribute('data-task-id', taskId);

    const panel = doc.createElement('div');
    panel.className = 'overlay-panel reject-panel modal-chrome';
    root.appendChild(panel);

    const title = doc.createElement('h2');
    title.className = 'reject-title';
    title.setAttribute('id', 'reject-modal-title');
    title.textContent = 'Reject task';
    panel.appendChild(title);

    const help = doc.createElement('p');
    help.className = 'reject-help';
    help.textContent = 'Tell the developer agent what to change. The agent restarts with your feedback.';
    panel.appendChild(help);

    const reasonInput = doc.createElement('textarea');
    reasonInput.className = 'reject-reason';
    reasonInput.setAttribute('data-reject-reason', '');
    reasonInput.setAttribute('aria-label', 'Reason for rejecting');
    reasonInput.setAttribute('rows', '5');
    panel.appendChild(reasonInput);

    const actions = doc.createElement('div');
    actions.className = 'reject-actions';
    panel.appendChild(actions);

    const cancelButton = doc.createElement('button');
    cancelButton.className = 'btn btn-secondary reject-cancel';
    cancelButton.setAttribute('type', 'button');
    cancelButton.setAttribute('data-reject-cancel', '');
    cancelButton.textContent = 'Cancel';
    actions.appendChild(cancelButton);

    const submitButton = doc.createElement('button');
    submitButton.className = 'btn btn-reject reject-submit';
    submitButton.setAttribute('type', 'button');
    submitButton.setAttribute('data-reject-submit', '');
    submitButton.textContent = 'Reject';
    actions.appendChild(submitButton);

    let closed = false;

    const close = (): void => {
        if (closed) return;
        closed = true;
        onClose?.();
    };

    const submit = async (): Promise<RejectTaskCommand | null> => {
        if (closed) return null;
        const reason = (reasonInput.value ?? '').trim();
        if (!reason) {
            // Blank reason blocks submit (AC #3). Re-focus the textarea
            // so the operator immediately sees where to type — matches
            // the v1 board's openRejectModal behaviour.
            reasonInput.focus?.();
            return null;
        }
        const cmd: RejectTaskCommand = {
            type: REJECT_COMMAND_TYPE,
            payload: { taskId, reason },
        };
        await dispatch(cmd);
        close();
        return cmd;
    };

    const cancel = (): void => {
        if (closed) return;
        close();
    };

    submitButton.onclick = (): void => {
        void submit();
    };
    cancelButton.onclick = cancel;

    return { root, reasonInput, submitButton, cancelButton, submit, cancel };
}
