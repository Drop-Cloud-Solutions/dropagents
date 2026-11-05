/**
 * Per-project notes panel (AP-VP5-013).
 *
 * Sits inside the project sidebar (alongside / below the project
 * details) and exposes the per-project notes the AP-VP5-007 orchestrator
 * handler stores in `core/projects/<projectId>/notes.md`. Talks to the
 * AP-VP5-009 worker-api routes:
 *
 *   GET    /projects/:projectId/notes
 *   POST   /projects/:projectId/notes
 *   PUT    /projects/:projectId/notes/:noteId
 *   DELETE /projects/:projectId/notes/:noteId
 *   POST   /projects/:projectId/notes/:noteId/promote
 *   POST   /projects/:projectId/notes/:noteId/convert
 *
 * Differences from the AP-IFF-011 task-scoped notes *modal*:
 *
 *   - This is a sidebar **panel**, not an overlay, so it never registers
 *     with the overlay-manager — it just renders inside whichever root
 *     element the host hands it.
 *   - It writes through the worker-api HTTP surface directly (the
 *     command bus already lives behind that surface; the panel doesn't
 *     need to participate in the in-browser command sink the modal
 *     uses).
 *   - Per-note markdown is rendered with the existing helper used by
 *     plan cards. The helper is injected so unit tests can verify it
 *     was invoked without needing real DOM `Node`s.
 *
 * Renderer shape mirrors the AP-IFF-011 modal: structural DOM types so
 * unit tests drive the module with a hand-rolled shim (no jsdom). All
 * destructive actions go through a synchronous {@link NotesPanelConfirm}
 * port so a single misclick cannot delete / promote / convert a note —
 * production wires `window.confirm`, tests inject a stub.
 *
 * The panel keeps its own *local UI state* (which note is in edit mode,
 * the edit-draft body, the create-form draft, whether the composer is
 * open) so a re-render triggered by a load(): {} response does not wipe
 * the operator's half-typed note. Network errors funnel through the
 * optional {@link NotesPanelDeps.onError} hook; the panel itself never
 * throws past the `Promise` boundary.
 */

// ---------------------------------------------------------------------------
// Public types — note shape + structural DOM surface
// ---------------------------------------------------------------------------

/** Minimum note shape the panel needs. Extra fields on the wire are ignored. */
export interface NotesPanelNote {
    readonly noteId: string;
    readonly content: string;
}

/** Subset of `Response` the panel touches. Tests pass a hand-rolled fake. */
export interface NotesPanelResponse {
    readonly ok: boolean;
    readonly status: number;
    json(): Promise<unknown>;
}

export interface NotesPanelFetchInit {
    readonly method?: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: string;
}

/** Minimal `fetch`-like port. Production wires the browser global. */
export type NotesPanelFetch = (
    url: string,
    init?: NotesPanelFetchInit,
) => Promise<NotesPanelResponse>;

/**
 * Synchronous yes/no prompt. Matches the AP-IFF-011 modal's
 * `NotesConfirm` contract so the two share confirmation-gate semantics:
 * a `false` return aborts the dispatch in the same tick as the click.
 */
export type NotesPanelConfirm = (message: string) => boolean;

/**
 * Markdown → DOM helper. The board's `renderMarkdown` (used by plan
 * cards) returns `Node[]` against the live DOM; this port reshapes the
 * contract over the structural element surface so tests can inject a
 * shim that just records the input. The host wires the production
 * helper by adapting its `Node[]` output into the structural surface.
 */
export type NotesPanelRenderMarkdown = (
    text: string,
) => ReadonlyArray<NotesPanelElement>;

export interface NotesPanelElement {
    className: string;
    textContent: string | null;
    value?: string;
    hidden: boolean;
    setAttribute(name: string, value: string): void;
    appendChild(child: NotesPanelElement): NotesPanelElement;
    replaceChildren(...children: NotesPanelElement[]): void;
}

export interface NotesPanelDocument {
    createElement(tagName: string): NotesPanelElement;
}

interface NotesPanelElementWithEvents extends NotesPanelElement {
    onclick?: () => void;
    oninput?: (event: { target: { value: string } }) => void;
}

interface MaybeGlobalDocument {
    document?: NotesPanelDocument;
}

interface MaybeGlobalConfirm {
    confirm?: (message?: string) => boolean;
}

function resolveDocument(doc: NotesPanelDocument | undefined): NotesPanelDocument {
    if (doc) return doc;
    const candidate = (globalThis as MaybeGlobalDocument).document;
    if (!candidate) {
        throw new Error(
            'notes-panel: no document available — pass one explicitly when '
                + 'rendering outside a browser context.',
        );
    }
    return candidate;
}

function resolveConfirm(c: NotesPanelConfirm | undefined): NotesPanelConfirm {
    if (c) return c;
    const g = (globalThis as MaybeGlobalConfirm).confirm;
    if (typeof g === 'function') {
        return (message): boolean => g.call(globalThis, message);
    }
    throw new Error(
        'notes-panel: no confirm() available — pass one explicitly when '
            + 'rendering outside a browser context.',
    );
}

function attachClick(el: NotesPanelElement, handler: () => void): void {
    (el as NotesPanelElementWithEvents).onclick = handler;
}

function attachInput(
    el: NotesPanelElement,
    handler: (value: string) => void,
): void {
    (el as NotesPanelElementWithEvents).oninput = (event): void => {
        handler(event.target.value);
    };
}

// ---------------------------------------------------------------------------
// Operator-facing confirmation copy
// ---------------------------------------------------------------------------

/** Delete-note confirmation prompt copy. Exported for direct test pinning. */
export const DELETE_CONFIRM_MESSAGE =
    'Delete this note? This cannot be undone.';

/** Promote-to-plan confirmation prompt copy. */
export const PROMOTE_CONFIRM_MESSAGE =
    'Promote this note to a plan? A new plan will be drafted from the note body.';

/** Convert-to-investigation confirmation prompt copy. */
export const CONVERT_CONFIRM_MESSAGE =
    'Convert this note to an investigation? A new investigation will be opened from the note body.';

// ---------------------------------------------------------------------------
// Init dependencies + handle
// ---------------------------------------------------------------------------

export interface NotesPanelDeps {
    /** `fetch`-like port used for every HTTP call. */
    readonly fetch: NotesPanelFetch;
    /** Markdown → element[] helper. Same surface as the plan-card renderer. */
    readonly renderMarkdown: NotesPanelRenderMarkdown;
    /** Document for `createElement`. Defaults to `globalThis.document`. */
    readonly doc?: NotesPanelDocument;
    /**
     * Operator confirmation prompt for destructive actions (delete,
     * promote, convert). Returning `false` aborts the action and no
     * network request is made. Defaults to `globalThis.confirm`.
     */
    readonly confirm?: NotesPanelConfirm;
    /**
     * Worker-api base URL. Defaults to the empty string, which matches
     * the board page's same-origin proxy convention (the board server
     * forwards `/projects/...` to the worker for us).
     */
    readonly apiBase?: string;
    /** Actor string sent on every write. Defaults to `'operator'`. */
    readonly actor?: string;
    /**
     * Optional sink for network / HTTP errors. The panel never throws —
     * callers that want toast / log surfaces wire this hook.
     */
    readonly onError?: (err: Error) => void;
}

export interface NotesPanelHandle {
    /** Fetch + render against the current projectId. Idempotent. */
    load(): Promise<void>;
    /**
     * Re-render against the in-memory note list. Use when only local UI
     * state (composer open/close, edit-mode toggle) has changed — no
     * network round-trip required.
     */
    render(): void;
    /**
     * Swap the active projectId. Clears local UI state, drops the
     * cached notes, and triggers a fresh `load()`.
     */
    setProjectId(projectId: string): Promise<void>;
    /** Tear down: clears the root and forgets local UI state. */
    destroy(): void;
}

// ---------------------------------------------------------------------------
// Local UI state
// ---------------------------------------------------------------------------

interface LocalUiState {
    /** `null` when the composer is collapsed. */
    composer:
        | {
              readonly open: true;
              titleDraft: string;
              contentDraft: string;
          }
        | { readonly open: false };
    /** id of the note currently in edit mode; `null` otherwise. */
    editingNoteId: string | null;
    /** Working copy of the in-edit note body. */
    editDraft: string;
}

function freshLocalState(): LocalUiState {
    return {
        composer: { open: false },
        editingNoteId: null,
        editDraft: '',
    };
}

// ---------------------------------------------------------------------------
// HTTP helpers — pure, no DOM
// ---------------------------------------------------------------------------

interface ListResponseShape {
    readonly notes: ReadonlyArray<NotesPanelNote>;
}

function isListResponse(value: unknown): value is ListResponseShape {
    if (typeof value !== 'object' || value === null) return false;
    const candidate = (value as { notes?: unknown }).notes;
    if (!Array.isArray(candidate)) return false;
    return candidate.every(
        (n) =>
            typeof n === 'object'
            && n !== null
            && typeof (n as { noteId?: unknown }).noteId === 'string'
            && typeof (n as { content?: unknown }).content === 'string',
    );
}

function buildPath(
    apiBase: string,
    projectId: string,
    noteId?: string,
    action?: 'promote' | 'convert',
): string {
    const prefix = apiBase.replace(/\/+$/, '');
    let path = `/projects/${encodeURIComponent(projectId)}/notes`;
    if (noteId !== undefined) path += `/${encodeURIComponent(noteId)}`;
    if (action !== undefined) path += `/${action}`;
    return `${prefix}${path}`;
}

function jsonInit(
    method: string,
    body?: Record<string, unknown>,
): NotesPanelFetchInit {
    const init: NotesPanelFetchInit = {
        method,
        headers: { 'Content-Type': 'application/json' },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    };
    return init;
}

// ---------------------------------------------------------------------------
// Public init
// ---------------------------------------------------------------------------

/**
 * Mount the notes panel inside `root` for `projectId`. Returns a handle
 * the host can use to drive the panel after mount. The first render
 * paints an empty list synchronously so the host sees a populated
 * `.notes-panel` element immediately; the host then calls `handle.load()`
 * to fetch the real list. The panel does NOT auto-load inside `init`
 * because that gives the host no `Promise` to await on (the initial GET
 * would race the next render) — both the production host and the unit
 * tests follow `init(...)` with an explicit `await handle.load()`.
 */
export function init(
    root: NotesPanelElement,
    projectId: string,
    deps: NotesPanelDeps,
): NotesPanelHandle {
    const doc = resolveDocument(deps.doc);
    const confirm = resolveConfirm(deps.confirm);
    const apiBase = deps.apiBase ?? '';
    const actor = deps.actor ?? 'operator';

    let activeProjectId = projectId;
    let notes: ReadonlyArray<NotesPanelNote> = [];
    let local = freshLocalState();
    let detached = false;

    const reportError = (err: unknown): void => {
        if (!deps.onError) return;
        deps.onError(err instanceof Error ? err : new Error(String(err)));
    };

    // --- render ---------------------------------------------------------

    const renderRow = (note: NotesPanelNote): NotesPanelElement => {
        const li = doc.createElement('li');
        li.className = 'notes-panel-row';
        li.setAttribute('data-notes-panel-row', '');
        li.setAttribute('data-note-id', note.noteId);

        const isEditing = local.editingNoteId === note.noteId;
        if (isEditing) {
            const ta = doc.createElement('textarea');
            ta.className = 'notes-panel-edit-input';
            ta.setAttribute('data-notes-panel-edit-input', '');
            ta.value = local.editDraft;
            attachInput(ta, (value) => {
                local.editDraft = value;
            });
            li.appendChild(ta);

            const save = doc.createElement('button');
            save.setAttribute('type', 'button');
            save.setAttribute('data-action', 'save-note');
            save.className = 'notes-panel-action notes-panel-action--save';
            save.textContent = 'Save';
            attachClick(save, () => {
                void onSaveEdit(note.noteId);
            });
            li.appendChild(save);

            const cancel = doc.createElement('button');
            cancel.setAttribute('type', 'button');
            cancel.setAttribute('data-action', 'cancel-edit');
            cancel.className = 'notes-panel-action notes-panel-action--cancel';
            cancel.textContent = 'Cancel';
            attachClick(cancel, () => {
                local.editingNoteId = null;
                local.editDraft = '';
                render();
            });
            li.appendChild(cancel);
            return li;
        }

        const body = doc.createElement('div');
        body.className = 'notes-panel-body';
        body.setAttribute('data-notes-panel-body', '');
        // Markdown helper produces an array of structural elements — the
        // panel just stitches them in. Falls back to plain text via the
        // helper's own contract when the input has no markdown.
        const rendered = deps.renderMarkdown(note.content);
        body.replaceChildren(...rendered);
        li.appendChild(body);

        const actions: ReadonlyArray<{
            action: string;
            label: string;
            cls: string;
            handler: () => void;
        }> = [
            {
                action: 'edit-note',
                label: 'Edit',
                cls: 'edit',
                handler: () => {
                    local.editingNoteId = note.noteId;
                    local.editDraft = note.content;
                    render();
                },
            },
            {
                action: 'delete-note',
                label: 'Delete',
                cls: 'delete',
                handler: () => {
                    void onDelete(note.noteId);
                },
            },
            {
                action: 'promote-to-plan',
                label: 'Promote to plan',
                cls: 'promote-plan',
                handler: () => {
                    void onPromote(note.noteId);
                },
            },
            {
                action: 'convert-to-investigation',
                label: 'Convert to investigation',
                cls: 'convert-investigation',
                handler: () => {
                    void onConvert(note.noteId);
                },
            },
        ];
        for (const a of actions) {
            const btn = doc.createElement('button');
            btn.setAttribute('type', 'button');
            btn.setAttribute('data-action', a.action);
            btn.className = `notes-panel-action notes-panel-action--${a.cls}`;
            btn.textContent = a.label;
            attachClick(btn, a.handler);
            li.appendChild(btn);
        }
        return li;
    };

    const renderList = (): NotesPanelElement => {
        const list = doc.createElement('ul');
        list.className = 'notes-panel-list';
        list.setAttribute('data-notes-panel-list', '');
        if (notes.length === 0) {
            const empty = doc.createElement('li');
            empty.className = 'notes-panel-empty';
            empty.setAttribute('data-empty', '');
            empty.textContent = 'No notes yet';
            list.appendChild(empty);
            return list;
        }
        for (const note of notes) {
            list.appendChild(renderRow(note));
        }
        return list;
    };

    const renderHeader = (): NotesPanelElement => {
        const header = doc.createElement('div');
        header.className = 'notes-panel-header';
        header.setAttribute('data-notes-panel-header', '');

        const title = doc.createElement('h3');
        title.className = 'notes-panel-title';
        title.textContent = 'Notes';
        header.appendChild(title);

        const newBtn = doc.createElement('button');
        newBtn.setAttribute('type', 'button');
        newBtn.setAttribute('data-action', 'new-note');
        newBtn.className = 'notes-panel-action notes-panel-action--new';
        newBtn.textContent = 'New note';
        // Hide the trigger while the composer is open so the operator
        // can't stack a second composer on top of the first.
        newBtn.hidden = local.composer.open;
        attachClick(newBtn, () => {
            local.composer = { open: true, titleDraft: '', contentDraft: '' };
            render();
        });
        header.appendChild(newBtn);
        return header;
    };

    const renderComposer = (): NotesPanelElement | null => {
        if (!local.composer.open) return null;
        const composer = local.composer;
        const wrap = doc.createElement('div');
        wrap.className = 'notes-panel-composer';
        wrap.setAttribute('data-notes-panel-composer', '');

        const titleInput = doc.createElement('input');
        titleInput.className = 'notes-panel-composer-title';
        titleInput.setAttribute('data-notes-panel-composer-title', '');
        titleInput.setAttribute('placeholder', 'Title (optional)');
        titleInput.value = composer.titleDraft;
        attachInput(titleInput, (value) => {
            composer.titleDraft = value;
        });
        wrap.appendChild(titleInput);

        const contentInput = doc.createElement('textarea');
        contentInput.className = 'notes-panel-composer-content';
        contentInput.setAttribute('data-notes-panel-composer-content', '');
        contentInput.setAttribute('placeholder', 'Note (markdown)…');
        contentInput.value = composer.contentDraft;
        attachInput(contentInput, (value) => {
            composer.contentDraft = value;
        });
        wrap.appendChild(contentInput);

        const save = doc.createElement('button');
        save.setAttribute('type', 'button');
        save.setAttribute('data-action', 'save-new-note');
        save.className = 'notes-panel-action notes-panel-action--save';
        save.textContent = 'Save';
        attachClick(save, () => {
            void onCreate();
        });
        wrap.appendChild(save);

        const cancel = doc.createElement('button');
        cancel.setAttribute('type', 'button');
        cancel.setAttribute('data-action', 'cancel-new-note');
        cancel.className = 'notes-panel-action notes-panel-action--cancel';
        cancel.textContent = 'Cancel';
        attachClick(cancel, () => {
            local.composer = { open: false };
            render();
        });
        wrap.appendChild(cancel);
        return wrap;
    };

    const render = (): void => {
        if (detached) return;
        const children: NotesPanelElement[] = [renderHeader()];
        const composer = renderComposer();
        if (composer) children.push(composer);
        children.push(renderList());
        root.replaceChildren(...children);
    };

    // --- write handlers --------------------------------------------------

    const onCreate = async (): Promise<void> => {
        if (!local.composer.open) return;
        const composer = local.composer;
        const content = composer.contentDraft.trim();
        if (content.length === 0) return;
        const body: Record<string, unknown> = { content, actor };
        const title = composer.titleDraft.trim();
        if (title.length > 0) body.title = title;
        const url = buildPath(apiBase, activeProjectId);
        try {
            const res = await deps.fetch(url, jsonInit('POST', body));
            if (!res.ok) {
                reportError(new Error(`POST notes failed: ${res.status}`));
                return;
            }
        } catch (err) {
            reportError(err);
            return;
        }
        local.composer = { open: false };
        await load();
    };

    const onSaveEdit = async (noteId: string): Promise<void> => {
        const content = local.editDraft.trim();
        if (content.length === 0) return;
        const url = buildPath(apiBase, activeProjectId, noteId);
        try {
            const res = await deps.fetch(url, jsonInit('PUT', { content, actor }));
            if (!res.ok) {
                reportError(new Error(`PUT notes/${noteId} failed: ${res.status}`));
                return;
            }
        } catch (err) {
            reportError(err);
            return;
        }
        local.editingNoteId = null;
        local.editDraft = '';
        await load();
    };

    const onDelete = async (noteId: string): Promise<void> => {
        if (!confirm(DELETE_CONFIRM_MESSAGE)) return;
        const url = buildPath(apiBase, activeProjectId, noteId);
        try {
            const res = await deps.fetch(url, jsonInit('DELETE', { actor }));
            if (!res.ok) {
                reportError(new Error(`DELETE notes/${noteId} failed: ${res.status}`));
                return;
            }
        } catch (err) {
            reportError(err);
            return;
        }
        if (local.editingNoteId === noteId) {
            local.editingNoteId = null;
            local.editDraft = '';
        }
        await load();
    };

    const onPromote = async (noteId: string): Promise<void> => {
        if (!confirm(PROMOTE_CONFIRM_MESSAGE)) return;
        const url = buildPath(apiBase, activeProjectId, noteId, 'promote');
        try {
            const res = await deps.fetch(url, jsonInit('POST', { actor }));
            if (!res.ok) {
                reportError(
                    new Error(`POST notes/${noteId}/promote failed: ${res.status}`),
                );
            }
        } catch (err) {
            reportError(err);
        }
    };

    const onConvert = async (noteId: string): Promise<void> => {
        if (!confirm(CONVERT_CONFIRM_MESSAGE)) return;
        const url = buildPath(apiBase, activeProjectId, noteId, 'convert');
        try {
            const res = await deps.fetch(url, jsonInit('POST', { actor }));
            if (!res.ok) {
                reportError(
                    new Error(`POST notes/${noteId}/convert failed: ${res.status}`),
                );
            }
        } catch (err) {
            reportError(err);
        }
    };

    // --- read -----------------------------------------------------------

    const load = async (): Promise<void> => {
        if (detached) return;
        const url = buildPath(apiBase, activeProjectId);
        try {
            const res = await deps.fetch(url, { method: 'GET' });
            if (!res.ok) {
                reportError(new Error(`GET notes failed: ${res.status}`));
                notes = [];
                render();
                return;
            }
            const body = await res.json();
            if (!isListResponse(body)) {
                reportError(new Error('GET notes returned unexpected shape'));
                notes = [];
                render();
                return;
            }
            notes = body.notes.slice();
        } catch (err) {
            reportError(err);
            notes = [];
        }
        render();
    };

    // First paint — synchronous + empty so the host sees the panel
    // chrome immediately. The caller (host or test) follows up with
    // `handle.load()` to fill it in; see the JSDoc above `init` for the
    // rationale on NOT auto-loading inside `init` itself.
    render();

    return {
        load,
        render,
        async setProjectId(next: string): Promise<void> {
            if (next === activeProjectId) return;
            activeProjectId = next;
            notes = [];
            local = freshLocalState();
            await load();
        },
        destroy(): void {
            if (detached) return;
            detached = true;
            local = freshLocalState();
            notes = [];
            root.replaceChildren();
        },
    };
}
