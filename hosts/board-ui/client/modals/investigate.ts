/**
 * Investigate modal (AP-IFF-012).
 *
 * Mounts inside an overlay element registered with the AP-IFF-002 overlay
 * manager and surfaces two operator workflows on a single panel:
 *
 *   1. A "create" form (taskId + question) that dispatches
 *      `CreateInvestigation` (BoardUiCommands.CREATE_INVESTIGATION). The
 *      orchestrator translates that into an `InvestigationRequested`
 *      event and spawns the investigator agent.
 *
 *   2. A list of open investigations — the (taskId, reportId) pairs the
 *      investigator agent has already answered — each with two triage
 *      actions:
 *        - Implement → dispatches `ImplementFromInvestigation`
 *          (InvestigationCommands.IMPLEMENT_FROM_INVESTIGATION). The
 *          orchestrator scaffolds a follow-up task whose plan body is
 *          the report's markdown.
 *        - Dismiss   → dispatches `DismissInvestigation`
 *          (InvestigationCommands.DISMISS_INVESTIGATION). The optional
 *          reason input on the row is forwarded onto the command.
 *
 * Architecture
 * ------------
 * The module is a leaf in the operator-data flow, mirroring AP-IFF-003's
 * sidebar chrome: it owns the view, never the action. State comes from a
 * projection store (`InvestigateStore`) read through its `getState` /
 * `subscribe` pair; commands go out through a single injected dispatcher
 * (`CommandDispatcher`) so production can wire it to `POST /commands` and
 * tests can hand-roll a recorder.
 *
 * DOM types are structural so unit tests run without jsdom — same shim
 * pattern as `hosts/board-ui/client/chrome/sidebar.ts`. The browser passes
 * its real `document`; tests pass a minimal shim element + document.
 */

import {
    BoardUiCommands,
    type CreateInvestigationPayload,
} from '../../commands';
import {
    InvestigationCommands,
    type DismissInvestigationPayload,
    type ImplementFromInvestigationPayload,
} from '../../../../core/commands';

// ---------------------------------------------------------------------------
// Projection record shapes
// ---------------------------------------------------------------------------

/**
 * One row in the modal's "open investigations" list. The investigator
 * agent emits an `InvestigationCompleted` event keyed by `(taskId,
 * reportId)`; that pair is the natural identifier for the triage
 * actions because both `ImplementFromInvestigation` and
 * `DismissInvestigation` consume exactly those two fields.
 *
 * `question` is the original prompt the operator submitted on
 * `CreateInvestigation` — surfaced so the row carries enough context to
 * triage without opening the report. `taskTitle` is optional: when the
 * projection has the source task's display title (it usually does)
 * the modal shows it as a secondary label; otherwise the row falls back
 * to the raw `taskId`.
 */
export interface OpenInvestigation {
    readonly taskId: string;
    readonly reportId: string;
    readonly question: string;
    readonly taskTitle?: string;
}

/**
 * Slice of projection state the modal consumes. The host store is free
 * to carry additional fields — the modal reads only this one.
 */
export interface InvestigateStoreState {
    readonly openInvestigations: ReadonlyArray<OpenInvestigation>;
}

/**
 * Minimal projection-store contract. The board.js projection store
 * satisfies this structurally — no shared symbol required.
 */
export interface InvestigateStore {
    getState(): InvestigateStoreState;
    subscribe(listener: (state: InvestigateStoreState) => void): () => void;
}

// ---------------------------------------------------------------------------
// Command dispatcher port
// ---------------------------------------------------------------------------

/**
 * Payload union the modal can dispatch. Kept as a discriminated structure
 * (command type → payload type) so the production dispatcher can route by
 * `type` without inspecting the shape, and tests can assert the
 * (type, payload) pair the modal emitted for each operator action.
 */
export type InvestigateCommand =
    | { readonly type: typeof BoardUiCommands.CREATE_INVESTIGATION; readonly payload: CreateInvestigationPayload }
    | { readonly type: typeof InvestigationCommands.IMPLEMENT_FROM_INVESTIGATION; readonly payload: ImplementFromInvestigationPayload }
    | { readonly type: typeof InvestigationCommands.DISMISS_INVESTIGATION; readonly payload: DismissInvestigationPayload };

/**
 * Single side-effect port the modal uses to publish operator actions.
 * Production wires this to the board's `POST /commands` proxy; tests
 * inject a recorder so the dispatched (type, payload) tuples are
 * inspectable.
 *
 * The dispatcher returns a promise so the modal can await it inside
 * click/submit handlers and surface a success or failure toast — the
 * operator otherwise has no signal that a triage action landed.
 */
export type CommandDispatcher = (command: InvestigateCommand) => Promise<void> | void;

// ---------------------------------------------------------------------------
// Toast port
// ---------------------------------------------------------------------------

/**
 * Kind taxonomy the modal uses when raising operator-visible toasts.
 * Matches the AP-IFF-004 `ToastKind` so production can pass the chrome
 * `showToast` function directly without an adapter.
 */
export type InvestigateToastKind = 'info' | 'error' | 'success';

export interface InvestigateToastOptions {
    readonly message: string;
    readonly kind?: InvestigateToastKind;
}

/**
 * Operator-visible feedback port. Production wires this to the
 * AP-IFF-004 `showToast` from `../chrome/toast`; tests inject a
 * recorder to assert the success/failure toast for each triage action.
 *
 * Kept structurally compatible with `showToast`'s signature so the host
 * can `import { showToast } from '../chrome/toast'` and pass it directly
 * — the second `doc` arg of `showToast` is optional and the modal never
 * supplies it.
 */
export type ShowToast = (opts: InvestigateToastOptions) => void;

/**
 * Centralised copy for the six toast outcomes the modal can raise. Kept
 * as a const map (not inlined) so a future i18n layer can swap the
 * strings in one place without rewriting the handlers.
 */
const TOAST_COPY = {
    createSuccess: 'Investigation created',
    createFailure: 'Failed to create investigation',
    implementSuccess: 'Investigation queued for implementation',
    implementFailure: 'Failed to implement investigation',
    dismissSuccess: 'Investigation dismissed',
    dismissFailure: 'Failed to dismiss investigation',
} as const;

// ---------------------------------------------------------------------------
// Structural DOM types — keep tests jsdom-free
// ---------------------------------------------------------------------------

export interface InvestigateElement {
    className: string;
    textContent: string | null;
    value: string;
    setAttribute(name: string, value: string): void;
    appendChild(child: InvestigateElement): InvestigateElement;
    replaceChildren(...children: InvestigateElement[]): void;
}

export interface InvestigateDocument {
    createElement(tagName: string): InvestigateElement;
}

interface InvestigateElementWithEvents extends InvestigateElement {
    onclick?: () => void | Promise<void>;
    onsubmit?: (event: { preventDefault?: () => void }) => void | Promise<void>;
}

interface MaybeGlobalDocument {
    document?: InvestigateDocument;
}

function resolveDocument(doc: InvestigateDocument | undefined): InvestigateDocument {
    if (doc) return doc;
    const candidate = (globalThis as MaybeGlobalDocument).document;
    if (!candidate) {
        throw new Error(
            'investigate-modal: no document available — pass one explicitly when '
                + 'rendering outside a browser context.',
        );
    }
    return candidate;
}

function attachClick(
    el: InvestigateElement,
    handler: () => void | Promise<void>,
): void {
    (el as InvestigateElementWithEvents).onclick = handler;
}

function attachSubmit(
    el: InvestigateElement,
    handler: (event: { preventDefault?: () => void }) => void | Promise<void>,
): void {
    (el as InvestigateElementWithEvents).onsubmit = handler;
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

interface RenderContext {
    readonly doc: InvestigateDocument;
    readonly root: InvestigateElement;
    readonly dispatch: CommandDispatcher;
    readonly showToast?: ShowToast;
}

/**
 * Dispatch `cmd`, then raise a success or failure toast through the
 * injected port. Each operator action (Create / Implement / Dismiss)
 * routes through here so the toast wiring lives in one place — sync
 * throws and rejected promises both fall into the `failure` branch.
 *
 * Returns the underlying promise so callers (the click/submit handlers)
 * can be `await`-ed by tests; in the browser the handler return value
 * is ignored, which is the documented behaviour for `onclick`/`onsubmit`.
 */
async function dispatchAndToast(
    ctx: RenderContext,
    cmd: InvestigateCommand,
    successMsg: string,
    failureMsg: string,
): Promise<void> {
    try {
        await ctx.dispatch(cmd);
        ctx.showToast?.({ message: successMsg, kind: 'success' });
    } catch {
        ctx.showToast?.({ message: failureMsg, kind: 'error' });
    }
}

function renderCreateForm(ctx: RenderContext): InvestigateElement {
    const form = ctx.doc.createElement('form');
    form.className = 'investigate-create-form';
    form.setAttribute('data-investigate-create-form', '');

    const taskInput = ctx.doc.createElement('input');
    taskInput.setAttribute('type', 'text');
    taskInput.setAttribute('name', 'taskId');
    taskInput.setAttribute('data-investigate-task-id', '');
    taskInput.setAttribute('placeholder', 'Task id');
    form.appendChild(taskInput);

    const questionInput = ctx.doc.createElement('textarea');
    questionInput.setAttribute('name', 'question');
    questionInput.setAttribute('data-investigate-question', '');
    questionInput.setAttribute('placeholder', 'What should the investigator agent answer?');
    form.appendChild(questionInput);

    const submit = ctx.doc.createElement('button');
    submit.setAttribute('type', 'submit');
    submit.setAttribute('data-investigate-create-submit', '');
    submit.textContent = 'Create investigation';
    form.appendChild(submit);

    attachSubmit(form, async (event) => {
        event.preventDefault?.();
        const taskId = taskInput.value.trim();
        const question = questionInput.value.trim();
        if (taskId.length === 0 || question.length === 0) return;
        // Reset before await so the form is immediately ready for the
        // next submission. The operator may want to fire several
        // investigations in a row without re-typing the task id;
        // clearing question only is the less-surprising default.
        questionInput.value = '';
        await dispatchAndToast(
            ctx,
            {
                type: BoardUiCommands.CREATE_INVESTIGATION,
                payload: { taskId, question },
            },
            TOAST_COPY.createSuccess,
            TOAST_COPY.createFailure,
        );
    });

    return form;
}

function renderInvestigationRow(
    ctx: RenderContext,
    inv: OpenInvestigation,
): InvestigateElement {
    const row = ctx.doc.createElement('li');
    row.className = 'investigate-row';
    row.setAttribute('data-investigate-row', '');
    row.setAttribute('data-task-id', inv.taskId);
    row.setAttribute('data-report-id', inv.reportId);

    const title = ctx.doc.createElement('div');
    title.className = 'investigate-row-title';
    title.setAttribute('data-investigate-row-title', '');
    title.textContent = inv.taskTitle ?? inv.taskId;
    row.appendChild(title);

    const question = ctx.doc.createElement('div');
    question.className = 'investigate-row-question';
    question.setAttribute('data-investigate-row-question', '');
    question.textContent = inv.question;
    row.appendChild(question);

    const reasonInput = ctx.doc.createElement('input');
    reasonInput.setAttribute('type', 'text');
    reasonInput.setAttribute('name', 'reason');
    reasonInput.setAttribute('data-investigate-row-reason', '');
    reasonInput.setAttribute('placeholder', 'Dismiss reason (optional)');
    row.appendChild(reasonInput);

    const implementBtn = ctx.doc.createElement('button');
    implementBtn.setAttribute('type', 'button');
    implementBtn.setAttribute('data-investigate-implement', '');
    implementBtn.textContent = 'Implement';
    attachClick(implementBtn, async () => {
        await dispatchAndToast(
            ctx,
            {
                type: InvestigationCommands.IMPLEMENT_FROM_INVESTIGATION,
                payload: { taskId: inv.taskId, reportId: inv.reportId },
            },
            TOAST_COPY.implementSuccess,
            TOAST_COPY.implementFailure,
        );
    });
    row.appendChild(implementBtn);

    const dismissBtn = ctx.doc.createElement('button');
    dismissBtn.setAttribute('type', 'button');
    dismissBtn.setAttribute('data-investigate-dismiss', '');
    dismissBtn.textContent = 'Dismiss';
    attachClick(dismissBtn, async () => {
        const reason = reasonInput.value.trim();
        const payload: DismissInvestigationPayload = reason.length > 0
            ? { taskId: inv.taskId, reportId: inv.reportId, reason }
            : { taskId: inv.taskId, reportId: inv.reportId };
        await dispatchAndToast(
            ctx,
            {
                type: InvestigationCommands.DISMISS_INVESTIGATION,
                payload,
            },
            TOAST_COPY.dismissSuccess,
            TOAST_COPY.dismissFailure,
        );
    });
    row.appendChild(dismissBtn);

    return row;
}

function renderInvestigationList(
    ctx: RenderContext,
    openInvestigations: ReadonlyArray<OpenInvestigation>,
): InvestigateElement {
    const list = ctx.doc.createElement('ul');
    list.className = 'investigate-list';
    list.setAttribute('data-investigate-list', '');

    if (openInvestigations.length === 0) {
        const empty = ctx.doc.createElement('li');
        empty.className = 'investigate-list-empty';
        empty.setAttribute('data-empty', '');
        empty.textContent = 'No open investigations';
        list.appendChild(empty);
        return list;
    }

    for (const inv of openInvestigations) {
        list.appendChild(renderInvestigationRow(ctx, inv));
    }
    return list;
}

// ---------------------------------------------------------------------------
// Public init / handle
// ---------------------------------------------------------------------------

export interface InvestigateDeps {
    readonly doc?: InvestigateDocument;
    /**
     * Operator-visible feedback port. Optional so unit tests that only
     * care about dispatch wiring can omit it; production wires this to
     * the AP-IFF-004 `showToast` so each Create / Implement / Dismiss
     * action surfaces a success or failure toast.
     */
    readonly showToast?: ShowToast;
}

export interface InvestigateHandle {
    /** Re-render against the store's current state. Idempotent. */
    render(): void;
    /** Detach the store subscription. Leaves the last-rendered DOM in place. */
    destroy(): void;
}

/**
 * Mount the investigate modal inside `root`, subscribe to `store`, and
 * route operator actions through `dispatch`. Returns a handle the host
 * can use to force a re-render or detach.
 *
 * The first render runs synchronously before `init` returns so the
 * overlay is fully populated by the time the overlay manager flips
 * `aria-hidden` to false.
 */
export function init(
    root: InvestigateElement,
    store: InvestigateStore,
    dispatch: CommandDispatcher,
    deps?: InvestigateDeps,
): InvestigateHandle {
    const doc = resolveDocument(deps?.doc);
    const ctx: RenderContext = { doc, root, dispatch, showToast: deps?.showToast };

    const renderOnce = (state: InvestigateStoreState): void => {
        const form = renderCreateForm(ctx);
        const list = renderInvestigationList(ctx, state.openInvestigations);
        // AP-IFV-005: wrap the form+list in a shared `.modal-chrome__body`
        // slot so the investigate modal scrolls + pads like the rest of
        // the modal family when board.ts mounts it under
        // `.modal modal--investigate`.
        const body = ctx.doc.createElement('div');
        body.className = 'modal-chrome__body';
        body.setAttribute('data-modal-chrome-body', '');
        body.appendChild(form);
        body.appendChild(list);
        root.replaceChildren(body);
    };

    // First paint — synchronous so the overlay is fully populated by the
    // time `init` returns.
    renderOnce(store.getState());

    const unsubscribe = store.subscribe((next) => {
        renderOnce(next);
    });

    let detached = false;

    return {
        render(): void {
            if (detached) return;
            renderOnce(store.getState());
        },
        destroy(): void {
            if (detached) return;
            detached = true;
            unsubscribe();
        },
    };
}
