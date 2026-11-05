/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Notes modal (AP-IFF-011).
 *
 * Owns the `.notes-modal` element of the operator board. Renders the
 * list of notes attached to a target entity (a project, a plan, or a
 * task), and offers the operator five flows:
 *
 *   1. Create a new note               → dispatches `CreateNote`
 *   2. Edit an existing note           → dispatches `UpdateNote`
 *   3. Delete a note                   → dispatches `DeleteNote`
 *   4. Promote a note to a plan        → dispatches `CreatePlan`
 *   5. Promote a note to an investigation → dispatches `CreateInvestigation`
 *
 * Architectural contract
 * ----------------------
 * - **Read** side is the projection store (mirrors the sidebar pattern in
 *   `client/chrome/sidebar.ts`). The modal consumes a structural
 *   {@link NotesModalStore} that yields a `notes` array plus the modal's
 *   target context. The host wires the canonical board.js store to this
 *   shape — the modal never imports a concrete store.
 * - **Write** side is the command bus. The modal builds typed `Command`
 *   envelopes and hands them to a `dispatch` function (production wires
 *   `CommandBus.send`; tests pass a recorder). The modal NEVER mutates
 *   state directly — the projections subscribe to the events the bus
 *   publishes, and Linear sync lives in the orchestrator's event
 *   handlers, NOT here (per task brief).
 * - DOM types are structural so unit tests can drive the module with a
 *   minimal shim. Production code passes the real `document` /
 *   `HTMLElement`; tests pass {@link NotesElement} / {@link NotesDocument}
 *   shims, identical in spirit to `client/chrome/sidebar.ts`.
 * - The modal owns its **local UI state** (the create-form draft, which
 *   note is currently in edit mode, the edit draft) inside a closure
 *   over `init`. Store-driven re-renders preserve that state so an
 *   incoming projection update doesn't wipe the operator's half-typed
 *   note.
 *
 * Promote-action payload shape
 * ----------------------------
 * - `CreatePlan` requires a `projectId` and a `title`. The modal pulls
 *   `projectId` from the active context (so a project-level note
 *   promotes to a plan under that project; a plan-level or task-level
 *   note promotes under its owning project). The title is derived from
 *   the note body — first non-empty line, trimmed and capped at 80
 *   chars — and the full note body lands in `body` so the resulting
 *   plan carries the original verbatim.
 * - `CreateInvestigation` requires a `taskId`. The button is hidden when
 *   the modal's context does not expose one (project-level and
 *   plan-level notes). When visible, it dispatches with `question` set
 *   to the full note body.
 *
 * Idempotency
 * -----------
 * The modal never invents `noteId` values on edit/delete — those flow
 * through the store. For *create* and *promote-to-plan*, the modal
 * supplies a client-generated id so the command handler can use it as
 * the idempotency key (a double-click in the create form thus produces
 * a single `NoteCreated`/`PlanCreated`). The injected `idGen` is the
 * same port already used by the orchestrator and the board-ui command
 * handlers (`core/ports/IdGen.ts`).
 */

import type { Command } from '../../../../core/commands/command';
import type { IdGen } from '../../../../core/ports/IdGen';
import type {
    CreateInvestigationPayload,
    CreateNotePayload,
    CreatePlanPayload,
    DeleteNotePayload,
    NoteTargetType,
    UpdateNotePayload,
} from '../../commands';
import { BoardUiCommands } from '../../commands';

// ---------------------------------------------------------------------------
// Projection-store contract (read side)
// ---------------------------------------------------------------------------

/**
 * The minimum shape the modal needs from each note. The projection may
 * carry extra fields (timestamps, actor, target metadata) — those are
 * fine, the modal simply ignores them.
 */
export interface NotesModalNote {
    readonly id: string;
    readonly body: string;
}

/**
 * Scope the modal is currently rendering for. The host computes this
 * once per open and the store keeps it stable for the modal's lifetime
 * (replacing the value on the store flushes the modal's local edit
 * state — same semantics the host already uses when closing+reopening
 * a modal under a different target).
 *
 * `projectId` is mandatory because *every* note ultimately rolls up to
 * a project — even a plan-level note has a parent project the
 * promote-to-plan flow needs to address. `taskId` is optional and is
 * the toggle that decides whether `Promote to investigation` is visible.
 */
export interface NotesModalContext {
    readonly targetType: NoteTargetType;
    readonly targetId: string;
    readonly projectId: string;
    /** Only set for task-scoped notes — gates the promote-to-investigation button. */
    readonly taskId?: string;
}

export interface NotesModalState {
    readonly notes: ReadonlyArray<NotesModalNote>;
    readonly context: NotesModalContext;
}

/**
 * Minimal projection-store contract. The board.js store satisfies this
 * structurally — no shared symbol required. Tests pass a hand-rolled
 * fake.
 */
export interface NotesModalStore {
    getState(): NotesModalState;
    subscribe(listener: (state: NotesModalState) => void): () => void;
}

// ---------------------------------------------------------------------------
// Structural DOM types — keep tests jsdom-free
// ---------------------------------------------------------------------------

export interface NotesEvent {
    readonly type: string;
    readonly detail?: unknown;
    readonly bubbles?: boolean;
}

export interface NotesElement {
    className: string;
    textContent: string | null;
    value?: string;
    hidden: boolean;
    setAttribute(name: string, value: string): void;
    appendChild(child: NotesElement): NotesElement;
    replaceChildren(...children: NotesElement[]): void;
    dispatchEvent(event: NotesEvent): boolean;
}

export interface NotesDocument {
    createElement(tagName: string): NotesElement;
}

interface NotesElementWithEvents extends NotesElement {
    onclick?: () => void;
    oninput?: (event: { target: { value: string } }) => void;
}

interface MaybeGlobalDocument {
    document?: NotesDocument;
}

function resolveDocument(doc: NotesDocument | undefined): NotesDocument {
    if (doc) return doc;
    const candidate = (globalThis as MaybeGlobalDocument).document;
    if (!candidate) {
        throw new Error(
            'notes-modal: no document available — pass one explicitly when '
                + 'rendering outside a browser context.',
        );
    }
    return candidate;
}

// ---------------------------------------------------------------------------
// Confirmation prompt — see NotesModalDeps.confirm
// ---------------------------------------------------------------------------

/**
 * Synchronous yes/no prompt. Production wires `window.confirm` (or the
 * board's confirmation modal); tests inject a stub. The contract is
 * deliberately synchronous so the delete handler can decide whether to
 * dispatch in the same tick as the click — keeping the dispatch path
 * branch-free for replay tooling.
 */
export type NotesConfirm = (message: string) => boolean;

interface MaybeGlobalConfirm {
    confirm?: (message?: string) => boolean;
}

function resolveConfirm(c: NotesConfirm | undefined): NotesConfirm {
    if (c) return c;
    const g = (globalThis as MaybeGlobalConfirm).confirm;
    if (typeof g === 'function') {
        return (message) => g.call(globalThis, message);
    }
    throw new Error(
        'notes-modal: no confirm() available — pass one explicitly when '
            + 'rendering outside a browser context.',
    );
}

/** Operator-facing copy for the delete-note confirmation prompt. */
export const DELETE_NOTE_CONFIRM_MESSAGE =
    'Delete this note? This cannot be undone.';

function attachClick(el: NotesElement, handler: () => void): void {
    (el as NotesElementWithEvents).onclick = handler;
}

function attachInput(
    el: NotesElement,
    handler: (value: string) => void,
): void {
    (el as NotesElementWithEvents).oninput = (event) => {
        handler(event.target.value);
    };
}

// ---------------------------------------------------------------------------
// Title derivation — exported so tests can pin the contract directly
// ---------------------------------------------------------------------------

/** Hard cap for derived plan titles. Anything longer is truncated with ellipsis. */
export const PROMOTED_TITLE_MAX = 80;

/**
 * Pull a plan-ready title out of a note body. The rules:
 *   1. Take the first non-empty line, trimmed.
 *   2. Strip any leading markdown header markers (`#`, `##`, …) so a
 *      note that starts with `## Foo` produces a `Foo` title rather
 *      than leaking the hashes.
 *   3. Truncate to {@link PROMOTED_TITLE_MAX} chars, suffixing `…` when
 *      truncation actually drops content.
 *   4. Fall back to `'Promoted note'` when the body has no non-empty
 *      line at all (defensive — the modal blocks empty creates upstream).
 */
export function derivePromotedPlanTitle(body: string): string {
    const lines = body.split(/\r?\n/);
    for (const raw of lines) {
        const trimmed = raw.replace(/^#+\s*/, '').trim();
        if (trimmed.length === 0) continue;
        if (trimmed.length <= PROMOTED_TITLE_MAX) return trimmed;
        return `${trimmed.slice(0, PROMOTED_TITLE_MAX - 1)}…`;
    }
    return 'Promoted note';
}

// ---------------------------------------------------------------------------
// Dispatch contract (write side)
// ---------------------------------------------------------------------------

/**
 * Thin handle over the command bus. Production wires
 * `(cmd) => commandBus.send(cmd)`. Tests pass a recorder that pushes
 * the command into an array so assertions can read the payload back.
 *
 * The modal awaits the returned Promise so it can swallow failures
 * locally (a future iteration will surface them via the toast queue —
 * out of scope for AP-IFF-011 per the brief). It never awaits between
 * building the command and dispatching: the command is built
 * synchronously off DOM-event state, then handed to the bus.
 */
export type NotesDispatch = (
    command: Command<unknown>,
) => void | Promise<unknown>;

// ---------------------------------------------------------------------------
// Init dependencies + handle
// ---------------------------------------------------------------------------

export interface NotesModalDeps {
    readonly doc?: NotesDocument;
    /** Bus dispatch — production: `commandBus.send`. Tests: a recorder. */
    readonly dispatch: NotesDispatch;
    /** Used for command timestamps (`Command.issuedAt`). */
    readonly clock: () => number;
    /**
     * Generates fresh ids for `CreateNote.noteId` and
     * `CreatePlan.planId`. The same `IdGen` port the orchestrator uses.
     */
    readonly idGen: IdGen;
    /**
     * Identifies the issuer of every command the modal builds. Either a
     * fixed string (`'operator:<user>'`) or a getter so the host can
     * surface the live operator id without re-mounting the modal.
     */
    readonly actor: string | (() => string);
    /**
     * Operator-confirmation prompt for destructive actions (currently
     * just delete-note). Returning `false` aborts the dispatch — no
     * `DeleteNote` command is built and no projection mutation happens.
     * Production wires `window.confirm`; tests inject a stub. Optional
     * here so the host can fall back to the browser's built-in
     * `globalThis.confirm` without explicit wiring, but the modal will
     * refuse to mount outside a browser if neither is available.
     */
    readonly confirm?: NotesConfirm;
}

export interface NotesModalHandle {
    /** Re-render against the store's current state. Idempotent. */
    render(): void;
    /** Detach the store subscription. Leaves the last-rendered DOM in place. */
    destroy(): void;
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

interface LocalUiState {
    /** id of the note currently in edit mode, `null` when none. */
    editingNoteId: string | null;
    /** Working copy of the editing note's body. */
    editDraft: string;
    /** Working copy of the create form. */
    createDraft: string;
}

interface RenderContext {
    readonly doc: NotesDocument;
    readonly root: NotesElement;
    readonly local: LocalUiState;
    readonly state: NotesModalState;
    /** Re-render against the store's *current* state — picks up local UI edits. */
    readonly rerender: () => void;
    readonly onCreate: (body: string) => void;
    readonly onUpdate: (noteId: string, body: string) => void;
    readonly onDelete: (noteId: string) => void;
    readonly onPromotePlan: (note: NotesModalNote) => void;
    readonly onPromoteInvestigation: (note: NotesModalNote) => void;
}

function renderNoteRow(
    ctx: RenderContext,
    note: NotesModalNote,
): NotesElement {
    const li = ctx.doc.createElement('li');
    li.className = 'notes-modal-row';
    li.setAttribute('data-notes-modal-row', '');
    li.setAttribute('data-note-id', note.id);

    const isEditing = ctx.local.editingNoteId === note.id;

    if (isEditing) {
        const ta = ctx.doc.createElement('textarea');
        ta.className = 'notes-modal-edit-input';
        ta.setAttribute('data-notes-modal-edit-input', '');
        ta.value = ctx.local.editDraft;
        attachInput(ta, (value) => {
            ctx.local.editDraft = value;
        });
        li.appendChild(ta);

        const save = ctx.doc.createElement('button');
        save.setAttribute('type', 'button');
        save.setAttribute('data-action', 'save-note');
        save.className = 'notes-modal-action notes-modal-action--save';
        save.textContent = 'Save';
        attachClick(save, () => {
            const body = ctx.local.editDraft.trim();
            if (body.length === 0) return;
            ctx.onUpdate(note.id, body);
        });
        li.appendChild(save);

        const cancel = ctx.doc.createElement('button');
        cancel.setAttribute('type', 'button');
        cancel.setAttribute('data-action', 'cancel-edit');
        cancel.className = 'notes-modal-action notes-modal-action--cancel';
        cancel.textContent = 'Cancel';
        attachClick(cancel, () => {
            ctx.local.editingNoteId = null;
            ctx.local.editDraft = '';
            ctx.rerender();
        });
        li.appendChild(cancel);

        return li;
    }

    const body = ctx.doc.createElement('div');
    body.className = 'notes-modal-body';
    body.setAttribute('data-notes-modal-body', '');
    body.textContent = note.body;
    li.appendChild(body);

    const edit = ctx.doc.createElement('button');
    edit.setAttribute('type', 'button');
    edit.setAttribute('data-action', 'edit-note');
    edit.className = 'notes-modal-action notes-modal-action--edit';
    edit.textContent = 'Edit';
    attachClick(edit, () => {
        ctx.local.editingNoteId = note.id;
        ctx.local.editDraft = note.body;
        ctx.rerender();
    });
    li.appendChild(edit);

    const del = ctx.doc.createElement('button');
    del.setAttribute('type', 'button');
    del.setAttribute('data-action', 'delete-note');
    del.className = 'notes-modal-action notes-modal-action--delete';
    del.textContent = 'Delete';
    attachClick(del, () => ctx.onDelete(note.id));
    li.appendChild(del);

    const promotePlan = ctx.doc.createElement('button');
    promotePlan.setAttribute('type', 'button');
    promotePlan.setAttribute('data-action', 'promote-to-plan');
    promotePlan.className = 'notes-modal-action notes-modal-action--promote-plan';
    promotePlan.textContent = 'Promote to plan';
    attachClick(promotePlan, () => ctx.onPromotePlan(note));
    li.appendChild(promotePlan);

    if (ctx.state.context.taskId !== undefined) {
        const promoteInv = ctx.doc.createElement('button');
        promoteInv.setAttribute('type', 'button');
        promoteInv.setAttribute('data-action', 'promote-to-investigation');
        promoteInv.className =
            'notes-modal-action notes-modal-action--promote-investigation';
        promoteInv.textContent = 'Promote to investigation';
        attachClick(promoteInv, () => ctx.onPromoteInvestigation(note));
        li.appendChild(promoteInv);
    }

    return li;
}

function renderNotesList(ctx: RenderContext): NotesElement {
    const list = ctx.doc.createElement('ul');
    list.className = 'notes-modal-list';
    list.setAttribute('data-notes-modal-list', '');

    if (ctx.state.notes.length === 0) {
        const empty = ctx.doc.createElement('li');
        empty.className = 'notes-modal-empty';
        empty.setAttribute('data-empty', '');
        empty.textContent = 'No notes yet';
        list.appendChild(empty);
        return list;
    }

    for (const note of ctx.state.notes) {
        list.appendChild(renderNoteRow(ctx, note));
    }
    return list;
}

function renderCreateForm(ctx: RenderContext): NotesElement {
    const form = ctx.doc.createElement('div');
    form.className = 'notes-modal-create';
    form.setAttribute('data-notes-modal-create', '');

    const ta = ctx.doc.createElement('textarea');
    ta.className = 'notes-modal-create-input';
    ta.setAttribute('data-notes-modal-create-input', '');
    ta.setAttribute('placeholder', 'Add a note…');
    ta.value = ctx.local.createDraft;
    attachInput(ta, (value) => {
        ctx.local.createDraft = value;
    });
    form.appendChild(ta);

    const submit = ctx.doc.createElement('button');
    submit.setAttribute('type', 'button');
    submit.setAttribute('data-action', 'create-note');
    submit.className = 'notes-modal-action notes-modal-action--create';
    submit.textContent = 'Add note';
    attachClick(submit, () => {
        const body = ctx.local.createDraft.trim();
        if (body.length === 0) return;
        ctx.onCreate(body);
    });
    form.appendChild(submit);
    return form;
}

// ---------------------------------------------------------------------------
// Public init
// ---------------------------------------------------------------------------

/**
 * Mount the notes modal inside `root` and subscribe to `store`. Returns
 * a handle the host can use to force a re-render or detach. The first
 * render runs synchronously so callers don't see an empty `.notes-modal`
 * element after mount.
 */
export function init(
    root: NotesElement,
    store: NotesModalStore,
    deps: NotesModalDeps,
): NotesModalHandle {
    const doc = resolveDocument(deps.doc);
    const confirm = resolveConfirm(deps.confirm);

    const local: LocalUiState = {
        editingNoteId: null,
        editDraft: '',
        createDraft: '',
    };

    const resolveActor = (): string =>
        typeof deps.actor === 'function' ? deps.actor() : deps.actor;

    const send = <TPayload>(type: string, payload: TPayload): void | Promise<unknown> => {
        const command: Command<TPayload> = {
            type,
            actor: resolveActor(),
            issuedAt: deps.clock(),
            payload,
        };
        return deps.dispatch(command);
    };

    let renderOnce: (state: NotesModalState) => void = () => {
        /* assigned below */
    };

    const handleCreate = (body: string): void => {
        const state = store.getState();
        const payload: CreateNotePayload = {
            noteId: deps.idGen.newId(),
            targetType: state.context.targetType,
            targetId: state.context.targetId,
            body,
        };
        void send(BoardUiCommands.CREATE_NOTE, payload);
        local.createDraft = '';
        renderOnce(state);
    };

    const handleUpdate = (noteId: string, body: string): void => {
        const payload: UpdateNotePayload = { noteId, body };
        void send(BoardUiCommands.UPDATE_NOTE, payload);
        local.editingNoteId = null;
        local.editDraft = '';
        renderOnce(store.getState());
    };

    const handleDelete = (noteId: string): void => {
        // Operator confirmation gate — a single misclick must NOT
        // destroy a note. See AP-IFF-011 reviewer feedback.
        if (!confirm(DELETE_NOTE_CONFIRM_MESSAGE)) return;
        const payload: DeleteNotePayload = { noteId };
        void send(BoardUiCommands.DELETE_NOTE, payload);
        if (local.editingNoteId === noteId) {
            local.editingNoteId = null;
            local.editDraft = '';
            renderOnce(store.getState());
        }
    };

    const handlePromotePlan = (note: NotesModalNote): void => {
        const state = store.getState();
        const payload: CreatePlanPayload = {
            planId: deps.idGen.newId(),
            projectId: state.context.projectId,
            title: derivePromotedPlanTitle(note.body),
            body: note.body,
        };
        void send(BoardUiCommands.CREATE_PLAN, payload);
    };

    const handlePromoteInvestigation = (note: NotesModalNote): void => {
        const state = store.getState();
        const taskId = state.context.taskId;
        if (taskId === undefined) {
            // The button is hidden in this case; the guard exists to
            // keep the type-narrowing honest if a future caller forces
            // the action via the host bus.
            return;
        }
        const payload: CreateInvestigationPayload = {
            taskId,
            question: note.body,
        };
        void send(BoardUiCommands.CREATE_INVESTIGATION, payload);
    };

    const rerender = (): void => {
        renderOnce(store.getState());
    };

    renderOnce = (state: NotesModalState): void => {
        const ctx: RenderContext = {
            doc,
            root,
            local,
            state,
            rerender,
            onCreate: handleCreate,
            onUpdate: handleUpdate,
            onDelete: handleDelete,
            onPromotePlan: handlePromotePlan,
            onPromoteInvestigation: handlePromoteInvestigation,
        };
        // AP-IFV-005: wrap the create-form + list in a shared
        // `.modal-chrome__body` slot so the notes modal scrolls + pads
        // like the rest of the modal family when board.ts mounts it
        // under `.modal modal--notes`.
        const body = doc.createElement('div');
        body.className = 'modal-chrome__body';
        body.setAttribute('data-modal-chrome-body', '');
        body.appendChild(renderCreateForm(ctx));
        body.appendChild(renderNotesList(ctx));
        root.replaceChildren(body);
    };

    // First paint — synchronous so the host sees a populated modal
    // immediately after `init` resolves.
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
