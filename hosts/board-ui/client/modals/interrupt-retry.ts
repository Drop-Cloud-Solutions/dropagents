/**
 * Interrupt + retry modal (AP-IFF-014).
 *
 * Operator-facing two-step modal for stopping a stuck task and re-queueing
 * it with explicit feedback:
 *
 *   Step 1 — "Confirm interrupt": a single confirm button on a short
 *            "are you sure" panel. Pressing it dispatches an
 *            {@link BoardUiCommands.INTERRUPT_TASK} command. On success
 *            the modal advances to step 2; on failure the modal stays on
 *            step 1 so the operator can retry or cancel.
 *
 *   Step 2 — "Retry with feedback": a textarea bound to a `feedback`
 *            string plus a "Retry" button. Pressing Retry dispatches an
 *            {@link BoardUiCommands.EDIT_TASK} command carrying the
 *            operator's feedback in the `description` slot (the only
 *            free-form field on `UpdateTaskPayload`). The orchestrator
 *            interprets a fresh description on an interrupted task as a
 *            request to reset status and rerun — that logic lives in the
 *            orchestrator and is out of scope for this widget.
 *
 *   Cancel — at either step, "Cancel" tears down the modal without
 *            dispatching anything (AC #3). After step 1's dispatch has
 *            already fired, cancelling step 2 is still a no-op for
 *            dispatch — the interrupt has already happened.
 *
 * Toast feedback (AC #4)
 * ----------------------
 * Every dispatch outcome is surfaced through the AP-IFF-004 toast queue:
 * a success toast on resolve, an error toast on reject. The dispatcher's
 * own rejection reason is appended to the error message so the operator
 * sees the same string the worker-api log captured. Both toasts are
 * scheduled through the injected `toast` port so unit tests can record
 * them without standing up a real `#toast-root`.
 *
 * Architectural contract
 * ----------------------
 * - The module is a leaf widget: it never calls a transport directly.
 *   The {@link InterruptRetryDeps.dispatch} port is given by the host
 *   (production wires it to `CommandBus.send`; tests pass an in-memory
 *   recorder).
 * - DOM access goes through narrow structural types ({@link ModalDocument},
 *   {@link ModalElement}) so the tests stay jsdom-free, matching the
 *   pattern already established by `hosts/board-ui/client/chrome/*`.
 * - Overlay lifecycle is delegated to {@link OverlayManagerLike} (the
 *   structural subset of AP-IFF-002's `OverlayManager` the modal uses).
 *   The modal opens its overlay on mount and closes it on cancel or on
 *   completing step 2 successfully.
 */

import { BoardUiCommands } from '../../commands';
import type { InterruptTaskPayload, UpdateTaskPayload } from '../../commands';

import type { Command } from '../../../../core/commands/command';

// ---------------------------------------------------------------------------
// Structural DOM types (no `lib: ["dom"]` dependency)
// ---------------------------------------------------------------------------

export interface ModalElement {
    className: string;
    textContent: string | null;
    hidden: boolean;
    setAttribute(name: string, value: string): void;
    appendChild(child: ModalElement): ModalElement;
    replaceChildren(...children: ModalElement[]): void;
    remove(): void;
}

export interface ModalDocument {
    getElementById(id: string): ModalElement | null;
    createElement(tagName: string): ModalElement;
}

// ---------------------------------------------------------------------------
// Injected ports
// ---------------------------------------------------------------------------

/**
 * The structural subset of `OverlayManager` (AP-IFF-002) the modal
 * consumes. Production passes the real singleton; tests pass a recorder.
 */
export interface OverlayManagerLike {
    openOverlay(id: string, element: ModalElement): unknown;
    closeOverlay(id: string): void;
}

/** Shape of the AP-IFF-004 toast call the modal makes. */
export interface ShowToastOpts {
    readonly message: string;
    readonly kind?: 'info' | 'error' | 'success';
}
export type ShowToastFn = (opts: ShowToastOpts) => void;

/**
 * Generic dispatch port. The handle awaits the returned promise; a
 * rejection is treated as a failed dispatch and surfaces an error
 * toast without advancing the modal.
 */
export type DispatchFn = (command: Command<unknown>) => Promise<unknown>;

export interface InterruptRetryDeps {
    readonly dispatch: DispatchFn;
    readonly toast: ShowToastFn;
    readonly overlay: OverlayManagerLike;
    readonly actor: string;
    /** Defaults to `() => Date.now()`. Tests pin a fixed value. */
    readonly clock?: () => number;
    /**
     * Optional document handle for tests. Defaults to `globalThis.document`
     * when running in a browser. The renderer never touches the global
     * directly so callers in non-browser contexts can pass a shim.
     */
    readonly doc?: ModalDocument;
    /**
     * Optional mount target. Defaults to `#overlay-root` (the structural
     * mount point shipped by AP-IFF-001 / `index.html`). When present,
     * the modal element is appended on open and removed on close.
     */
    readonly mountId?: string;
}

export interface InterruptRetryOptions {
    readonly taskId: string;
    /**
     * Optional id used for the overlay registration. Defaults to
     * `interrupt-retry:<taskId>` so concurrent modals across different
     * tasks don't collide on the overlay stack.
     */
    readonly overlayId?: string;
}

// ---------------------------------------------------------------------------
// Handle
// ---------------------------------------------------------------------------

export type InterruptRetryStep = 'interrupt' | 'retry' | 'closed';

export interface InterruptRetryHandle {
    /** Current step. Read-only snapshot — mutating it does nothing. */
    readonly step: InterruptRetryStep;
    /** The rendered modal root. Exposed so tests can introspect the tree. */
    readonly element: ModalElement;
    /** Mutate the staged feedback string. Step 2 reads it on retry. */
    setFeedback(value: string): void;
    /** Current staged feedback. */
    readonly feedback: string;
    /**
     * Drive the primary button. On step 1: dispatches InterruptTask and,
     * on success, advances to step 2. On step 2: dispatches EditTask
     * with the staged feedback and, on success, closes the modal.
     *
     * Returns a promise that resolves once the dispatch settles, success
     * or failure. The promise NEVER rejects — toast feedback already
     * surfaced the error to the operator.
     */
    confirm(): Promise<void>;
    /** Close without dispatching. Safe to call from any step. */
    cancel(): void;
}

// ---------------------------------------------------------------------------
// Document / mount-target resolution
// ---------------------------------------------------------------------------

interface MaybeGlobalDocument {
    document?: ModalDocument;
}

function resolveDocument(doc: ModalDocument | undefined): ModalDocument {
    if (doc) return doc;
    const candidate = (globalThis as MaybeGlobalDocument).document;
    if (!candidate) {
        throw new Error(
            'interrupt-retry: no document available — pass one explicitly when '
                + 'rendering outside a browser context.',
        );
    }
    return candidate;
}

// Click-handler attachment — the structural element type stays free of
// `onclick` so non-DOM shims aren't forced to model it. The cast is
// localised here so the production HTMLElement (which DOES expose
// onclick) keeps working.
interface ElementWithEvents extends ModalElement {
    onclick?: () => void;
    oninput?: (value: string) => void;
}

function attachClick(el: ModalElement, handler: () => void): void {
    (el as ElementWithEvents).onclick = handler;
}

function attachInput(el: ModalElement, handler: (value: string) => void): void {
    (el as ElementWithEvents).oninput = handler;
}

// ---------------------------------------------------------------------------
// Public mount function
// ---------------------------------------------------------------------------

export const DEFAULT_MOUNT_ID = 'overlay-root';

/**
 * Mount the interrupt-retry modal for `taskId`. Returns a handle the
 * caller can use to drive the modal programmatically; the modal is
 * already attached to the DOM and registered with the overlay manager
 * when this function returns.
 */
export function openInterruptRetryModal(
    options: InterruptRetryOptions,
    deps: InterruptRetryDeps,
): InterruptRetryHandle {
    const doc = resolveDocument(deps.doc);
    const clock = deps.clock ?? ((): number => Date.now());
    const overlayId = options.overlayId ?? `interrupt-retry:${options.taskId}`;
    const mountId = deps.mountId ?? DEFAULT_MOUNT_ID;

    // ----- internal mutable state ----------------------------------------
    let step: InterruptRetryStep = 'interrupt';
    let feedback = '';
    let inFlight = false;
    let closed = false;

    // ----- DOM scaffolding -----------------------------------------------
    const root = doc.createElement('div');
    root.className = 'modal modal--interrupt-retry modal-chrome';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-labelledby', `interrupt-retry-title-${options.taskId}`);
    root.setAttribute('data-modal', 'interrupt-retry');
    root.setAttribute('data-task-id', options.taskId);

    const body = doc.createElement('div');
    body.className = 'modal-body modal-chrome__body';
    root.appendChild(body);

    // ----- step renderers -------------------------------------------------
    const renderInterruptStep = (): void => {
        root.setAttribute('data-step', 'interrupt');

        const title = doc.createElement('h2');
        title.className = 'modal-title';
        title.setAttribute('id', `interrupt-retry-title-${options.taskId}`);
        title.textContent = 'Interrupt task?';

        const msg = doc.createElement('p');
        msg.className = 'modal-message';
        msg.textContent
            = 'Stop the running agent for this task. You will be able to '
                + 'add feedback and retry on the next step.';

        const actions = doc.createElement('div');
        actions.className = 'modal-actions modal-chrome__footer';

        const cancelBtn = doc.createElement('button');
        cancelBtn.className = 'modal-button modal-button--cancel';
        cancelBtn.setAttribute('type', 'button');
        cancelBtn.setAttribute('data-action', 'cancel');
        cancelBtn.textContent = 'Cancel';
        attachClick(cancelBtn, () => handle.cancel());

        const confirmBtn = doc.createElement('button');
        confirmBtn.className = 'modal-button modal-button--confirm';
        confirmBtn.setAttribute('type', 'button');
        confirmBtn.setAttribute('data-action', 'confirm-interrupt');
        confirmBtn.textContent = 'Interrupt';
        attachClick(confirmBtn, () => {
            // Fire-and-record: the promise resolves into toasts; tests
            // that want to await it call `handle.confirm()` directly.
            void handle.confirm();
        });

        actions.appendChild(cancelBtn);
        actions.appendChild(confirmBtn);

        body.replaceChildren(title, msg, actions);
    };

    const renderRetryStep = (): void => {
        root.setAttribute('data-step', 'retry');

        const title = doc.createElement('h2');
        title.className = 'modal-title';
        title.setAttribute('id', `interrupt-retry-title-${options.taskId}`);
        title.textContent = 'Retry with feedback';

        const label = doc.createElement('label');
        label.className = 'modal-label';
        label.setAttribute('for', `interrupt-retry-feedback-${options.taskId}`);
        label.textContent
            = 'Describe what went wrong or what the agent should do '
                + 'differently. This becomes the task description for the '
                + 'rerun.';

        const textarea = doc.createElement('textarea');
        textarea.className = 'modal-textarea';
        textarea.setAttribute('id', `interrupt-retry-feedback-${options.taskId}`);
        textarea.setAttribute('data-field', 'feedback');
        textarea.setAttribute('rows', '6');
        textarea.textContent = feedback;
        attachInput(textarea, (value) => {
            feedback = value;
        });

        const actions = doc.createElement('div');
        actions.className = 'modal-actions modal-chrome__footer';

        const cancelBtn = doc.createElement('button');
        cancelBtn.className = 'modal-button modal-button--cancel';
        cancelBtn.setAttribute('type', 'button');
        cancelBtn.setAttribute('data-action', 'cancel');
        cancelBtn.textContent = 'Cancel';
        attachClick(cancelBtn, () => handle.cancel());

        const retryBtn = doc.createElement('button');
        retryBtn.className = 'modal-button modal-button--confirm';
        retryBtn.setAttribute('type', 'button');
        retryBtn.setAttribute('data-action', 'confirm-retry');
        retryBtn.textContent = 'Retry';
        attachClick(retryBtn, () => {
            void handle.confirm();
        });

        actions.appendChild(cancelBtn);
        actions.appendChild(retryBtn);

        body.replaceChildren(title, label, textarea, actions);
    };

    // ----- dispatch helpers ----------------------------------------------
    const buildInterruptCommand = (): Command<InterruptTaskPayload> => ({
        type: BoardUiCommands.INTERRUPT_TASK,
        actor: deps.actor,
        issuedAt: clock(),
        payload: { taskId: options.taskId },
    });

    const buildUpdateCommand = (): Command<UpdateTaskPayload> => ({
        type: BoardUiCommands.EDIT_TASK,
        actor: deps.actor,
        issuedAt: clock(),
        payload: { taskId: options.taskId, description: feedback },
    });

    const fail = (verb: string, err: unknown): void => {
        const detail = err instanceof Error ? err.message : String(err);
        deps.toast({
            message: `Failed to ${verb} task: ${detail}`,
            kind: 'error',
        });
    };

    // ----- mount + register ----------------------------------------------
    const mount = doc.getElementById(mountId);
    if (mount) {
        mount.appendChild(root);
    }
    deps.overlay.openOverlay(overlayId, root);
    renderInterruptStep();

    // ----- handle --------------------------------------------------------
    const handle: InterruptRetryHandle = {
        get step(): InterruptRetryStep {
            return step;
        },
        get feedback(): string {
            return feedback;
        },
        element: root,
        setFeedback(value: string): void {
            feedback = value;
        },
        cancel(): void {
            if (closed) return;
            closed = true;
            step = 'closed';
            deps.overlay.closeOverlay(overlayId);
            root.remove();
        },
        async confirm(): Promise<void> {
            if (closed) return;
            // Guard against double-clicks while a dispatch is in flight.
            // A second confirm during the same step would re-dispatch the
            // same command — the orchestrator's idempotency key would
            // collapse it server-side but the operator would still see two
            // toasts. Easier to just block.
            if (inFlight) return;
            inFlight = true;
            try {
                if (step === 'interrupt') {
                    try {
                        await deps.dispatch(buildInterruptCommand());
                        deps.toast({
                            message: 'Task interrupted. Add feedback to retry.',
                            kind: 'success',
                        });
                        step = 'retry';
                        renderRetryStep();
                    } catch (err) {
                        fail('interrupt', err);
                    }
                } else if (step === 'retry') {
                    try {
                        await deps.dispatch(buildUpdateCommand());
                        deps.toast({
                            message: 'Task queued for retry with your feedback.',
                            kind: 'success',
                        });
                        closed = true;
                        step = 'closed';
                        deps.overlay.closeOverlay(overlayId);
                        root.remove();
                    } catch (err) {
                        fail('retry', err);
                    }
                }
            } finally {
                inFlight = false;
            }
        },
    };

    return handle;
}
