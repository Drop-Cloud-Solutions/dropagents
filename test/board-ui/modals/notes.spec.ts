/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Unit tests for the AP-IFF-011 notes modal.
 *
 * Coverage maps directly to the task's five acceptance criteria:
 *   1. Notes list renders from the projection store.
 *   2. Create / edit / delete dispatch CreateNote / UpdateNote /
 *      DeleteNote respectively.
 *   3. Promote-to-plan dispatches CreatePlan with the note body.
 *   4. Promote-to-investigation dispatches CreateInvestigation.
 *   5. (this file) — every flow above is exercised end-to-end through
 *      the same `init()` mount so they regress as a unit.
 *
 * DOM strategy — hand-rolled shim. The existing chrome widgets
 * (`hosts/board-ui/client/chrome/sidebar.spec.ts`,
 * `hosts/board-ui/client/chrome/overlay-manager.spec.ts`) all roll
 * their own shim rather than pulling in jsdom — see the sidebar spec's
 * header for the full rationale. This file follows the same shape so a
 * reviewer can diff it side-by-side.
 *
 * Dual-runner test() shim — mirrors `sidebar.spec.ts` so this file runs
 * under both `node --test --import tsx` (the repo's `npm test`) and
 * vitest (the review pipeline's `npx vitest run` path).
 */
import * as assert from 'node:assert/strict';

import type { Command } from '../../../core/commands/command';
import { BoardUiCommands } from '../../../hosts/board-ui/commands';
import type {
    CreateInvestigationPayload,
    CreateNotePayload,
    CreatePlanPayload,
    DeleteNotePayload,
    UpdateNotePayload,
} from '../../../hosts/board-ui/commands';
import {
    DELETE_NOTE_CONFIRM_MESSAGE,
    derivePromotedPlanTitle,
    init,
    PROMOTED_TITLE_MAX,
    type NotesConfirm,
    type NotesDocument,
    type NotesElement,
    type NotesEvent,
    type NotesModalContext,
    type NotesModalState,
    type NotesModalStore,
} from '../../../hosts/board-ui/client/modals/notes';

// ---------------------------------------------------------------------------
// Dual-runner test() shim
// ---------------------------------------------------------------------------

type TestFn = (name: string, fn: () => void | Promise<void>) => void;

const test: TestFn = (((): TestFn => {
    if (process.env.VITEST) {
        const gt = (globalThis as { test?: TestFn }).test;
        if (typeof gt !== 'function') {
            throw new Error(
                'notes.spec.ts: VITEST=true but globalThis.test is missing — '
                    + 'ensure vitest.config.ts sets test.globals = true',
            );
        }
        return gt;
    }
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    const nt = require('node:test') as { test: TestFn };
    return nt.test;
})());

// ---------------------------------------------------------------------------
// Minimal DOM shim
// ---------------------------------------------------------------------------

interface ShimElement extends NotesElement {
    tagName: string;
    attributes: Map<string, string>;
    children: ShimElement[];
    dispatched: NotesEvent[];
    onclick?: () => void;
    oninput?: (event: { target: { value: string } }) => void;
}

function makeShimElement(tagName: string): ShimElement {
    const attrs = new Map<string, string>();
    const children: ShimElement[] = [];
    const dispatched: NotesEvent[] = [];
    const el: ShimElement = {
        tagName,
        className: '',
        textContent: null,
        value: undefined,
        hidden: false,
        attributes: attrs,
        children,
        dispatched,
        setAttribute(name: string, value: string): void {
            attrs.set(name, value);
        },
        appendChild(child: NotesElement): NotesElement {
            children.push(child as ShimElement);
            return child;
        },
        replaceChildren(...next: NotesElement[]): void {
            children.length = 0;
            for (const c of next) children.push(c as ShimElement);
        },
        dispatchEvent(event: NotesEvent): boolean {
            dispatched.push(event);
            return true;
        },
    };
    return el;
}

function makeShimDocument(): NotesDocument {
    return {
        createElement(tagName: string): NotesElement {
            return makeShimElement(tagName);
        },
    };
}

function makeShimRoot(): ShimElement {
    return makeShimElement('section');
}

// ---------------------------------------------------------------------------
// Store fake — single subscriber, manual `set()` for re-render
// ---------------------------------------------------------------------------

interface FakeStore extends NotesModalStore {
    set(next: NotesModalState): void;
    listenerCount(): number;
}

function makeFakeStore(initial: NotesModalState): FakeStore {
    let current = initial;
    const listeners = new Set<(state: NotesModalState) => void>();
    return {
        getState: () => current,
        subscribe(listener) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        set(next) {
            current = next;
            for (const l of listeners) l(current);
        },
        listenerCount() {
            return listeners.size;
        },
    };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function projectCtx(): NotesModalContext {
    return { targetType: 'project', targetId: 'proj-1', projectId: 'proj-1' };
}

function taskCtx(): NotesModalContext {
    return {
        targetType: 'task',
        targetId: 'task-42',
        projectId: 'proj-1',
        taskId: 'task-42',
    };
}

function stateWith(
    notes: ReadonlyArray<{ id: string; body: string }>,
    context: NotesModalContext = projectCtx(),
): NotesModalState {
    return { notes, context };
}

interface ConfirmCall {
    readonly message: string;
}

interface ConfirmRecorder {
    readonly fn: NotesConfirm;
    readonly calls: ConfirmCall[];
    /** Override the next return value; reverts to the harness default after one call. */
    setNext(answer: boolean): void;
}

function makeConfirmRecorder(defaultAnswer: boolean): ConfirmRecorder {
    const calls: ConfirmCall[] = [];
    let pending: boolean | null = null;
    return {
        calls,
        setNext(answer: boolean): void {
            pending = answer;
        },
        fn(message: string): boolean {
            calls.push({ message });
            if (pending !== null) {
                const a = pending;
                pending = null;
                return a;
            }
            return defaultAnswer;
        },
    };
}

interface Harness {
    root: ShimElement;
    store: FakeStore;
    dispatched: Command<unknown>[];
    ids: string[];
    nextId: () => void;
    clockNow: number;
    confirm: ConfirmRecorder;
}

function makeHarness(
    state: NotesModalState,
    options: {
        actor?: string;
        ids?: string[];
        /** Default return value for the injected confirm stub. Defaults to true. */
        confirmAnswer?: boolean;
    } = {},
): Harness {
    const root = makeShimRoot();
    const store = makeFakeStore(state);
    const dispatched: Command<unknown>[] = [];
    const ids = (options.ids ?? ['gen-1', 'gen-2', 'gen-3']).slice();
    const issued: string[] = [];
    const confirm = makeConfirmRecorder(options.confirmAnswer ?? true);
    const handle = init(root, store, {
        doc: makeShimDocument(),
        dispatch: (cmd) => {
            dispatched.push(cmd);
        },
        clock: () => 1_700_000_000_000,
        idGen: {
            newId(): string {
                const next = ids.shift();
                if (next === undefined) {
                    throw new Error('notes.spec: idGen pool exhausted');
                }
                issued.push(next);
                return next;
            },
        },
        actor: options.actor ?? 'operator:tester',
        confirm: confirm.fn,
    });
    // Tests don't need the handle externally — the recorder captures
    // everything we assert on. We keep the reference alive on the
    // harness so the GC doesn't tear down the subscription early.
    (root as ShimElement & { __handle?: unknown }).__handle = handle;
    return {
        root,
        store,
        dispatched,
        ids: issued,
        nextId: () => undefined,
        clockNow: 1_700_000_000_000,
        confirm,
    };
}

// ---------------------------------------------------------------------------
// Tree-walking helpers
// ---------------------------------------------------------------------------

function findFirst(
    root: ShimElement,
    predicate: (el: ShimElement) => boolean,
): ShimElement | null {
    if (predicate(root)) return root;
    for (const c of root.children) {
        const hit = findFirst(c, predicate);
        if (hit) return hit;
    }
    return null;
}

function findAll(
    root: ShimElement,
    predicate: (el: ShimElement) => boolean,
): ShimElement[] {
    const out: ShimElement[] = [];
    const walk = (n: ShimElement): void => {
        if (predicate(n)) out.push(n);
        for (const c of n.children) walk(c);
    };
    walk(root);
    return out;
}

function noteRow(root: ShimElement, noteId: string): ShimElement {
    const row = findFirst(root, (el) => el.attributes.get('data-note-id') === noteId);
    if (!row) throw new Error(`no note row for "${noteId}"`);
    return row;
}

function buttonInside(
    parent: ShimElement,
    action: string,
): ShimElement {
    const btn = findFirst(parent, (el) => el.attributes.get('data-action') === action);
    if (!btn) throw new Error(`no "${action}" button inside row`);
    return btn;
}

function createInput(root: ShimElement): ShimElement {
    const el = findFirst(root, (el) =>
        el.attributes.has('data-notes-modal-create-input'),
    );
    if (!el) throw new Error('no create-input rendered');
    return el;
}

function editInput(row: ShimElement): ShimElement {
    const el = findFirst(row, (el) =>
        el.attributes.has('data-notes-modal-edit-input'),
    );
    if (!el) throw new Error('no edit-input rendered');
    return el;
}

function click(el: ShimElement): void {
    if (!el.onclick) throw new Error(`clicked element <${el.tagName}> has no onclick`);
    el.onclick();
}

function type(el: ShimElement, value: string): void {
    if (!el.oninput) throw new Error(`typed into <${el.tagName}> but no oninput`);
    el.oninput({ target: { value } });
}

// ---------------------------------------------------------------------------
// AC #1 — render notes from projection store
// ---------------------------------------------------------------------------

test('init: first render mounts one row per note in the projection store', () => {
    const h = makeHarness(
        stateWith([
            { id: 'n-1', body: 'first note' },
            { id: 'n-2', body: 'second note' },
        ]),
    );
    const rows = findAll(h.root, (el) => el.attributes.has('data-notes-modal-row'));
    assert.equal(rows.length, 2);
    assert.deepEqual(
        rows.map((r) => r.attributes.get('data-note-id')),
        ['n-1', 'n-2'],
    );
    const bodies = findAll(h.root, (el) =>
        el.attributes.has('data-notes-modal-body'),
    ).map((b) => b.textContent);
    assert.deepEqual(bodies, ['first note', 'second note']);
});

test('init: empty notes list renders the empty-state placeholder', () => {
    const h = makeHarness(stateWith([]));
    const empty = findFirst(h.root, (el) => el.attributes.has('data-empty'));
    assert.ok(empty, 'expected an empty-state row');
    assert.equal(empty!.textContent, 'No notes yet');
});

test('store updates trigger a re-render of the notes list', () => {
    const h = makeHarness(stateWith([{ id: 'n-1', body: 'one' }]));
    assert.equal(
        findAll(h.root, (el) => el.attributes.has('data-notes-modal-row')).length,
        1,
    );
    h.store.set(
        stateWith([
            { id: 'n-1', body: 'one' },
            { id: 'n-2', body: 'two' },
            { id: 'n-3', body: 'three' },
        ]),
    );
    const rows = findAll(h.root, (el) =>
        el.attributes.has('data-notes-modal-row'),
    );
    assert.equal(rows.length, 3);
});

// ---------------------------------------------------------------------------
// AC #2 — create / edit / delete dispatch the right commands
// ---------------------------------------------------------------------------

test('create form dispatches CreateNote with target context + idGen-supplied noteId', () => {
    const h = makeHarness(stateWith([], projectCtx()), { ids: ['note-id-1'] });
    type(createInput(h.root), 'remember this');
    const submit = findFirst(
        h.root,
        (el) => el.attributes.get('data-action') === 'create-note',
    );
    assert.ok(submit, 'expected a create-note button');
    click(submit!);

    assert.equal(h.dispatched.length, 1);
    const cmd = h.dispatched[0] as Command<CreateNotePayload>;
    assert.equal(cmd.type, BoardUiCommands.CREATE_NOTE);
    assert.equal(cmd.actor, 'operator:tester');
    assert.equal(cmd.issuedAt, 1_700_000_000_000);
    assert.deepEqual(cmd.payload, {
        noteId: 'note-id-1',
        targetType: 'project',
        targetId: 'proj-1',
        body: 'remember this',
    });
});

test('create form ignores submissions when the draft is empty / whitespace-only', () => {
    const h = makeHarness(stateWith([], projectCtx()));
    const submit = findFirst(
        h.root,
        (el) => el.attributes.get('data-action') === 'create-note',
    )!;

    click(submit);
    assert.equal(h.dispatched.length, 0, 'empty draft must not dispatch');

    type(createInput(h.root), '   \n\t  ');
    click(submit);
    assert.equal(h.dispatched.length, 0, 'whitespace-only draft must not dispatch');
});

test('edit flow dispatches UpdateNote with the trimmed body and the original noteId', () => {
    const h = makeHarness(
        stateWith([
            { id: 'n-1', body: 'original' },
            { id: 'n-2', body: 'untouched' },
        ]),
    );
    const row = noteRow(h.root, 'n-1');
    click(buttonInside(row, 'edit-note'));

    // After click the row re-renders into edit mode — re-resolve it.
    const editingRow = noteRow(h.root, 'n-1');
    type(editInput(editingRow), '  revised body   ');
    click(buttonInside(editingRow, 'save-note'));

    assert.equal(h.dispatched.length, 1);
    const cmd = h.dispatched[0] as Command<UpdateNotePayload>;
    assert.equal(cmd.type, BoardUiCommands.UPDATE_NOTE);
    assert.deepEqual(cmd.payload, { noteId: 'n-1', body: 'revised body' });

    // Editor closes on save — the second row was never touched.
    assert.equal(
        findAll(h.root, (el) => el.attributes.has('data-notes-modal-edit-input')).length,
        0,
        'save closes the editor',
    );
});

test('cancel-edit aborts without dispatching anything', () => {
    const h = makeHarness(stateWith([{ id: 'n-1', body: 'original' }]));
    const row = noteRow(h.root, 'n-1');
    click(buttonInside(row, 'edit-note'));
    const editing = noteRow(h.root, 'n-1');
    type(editInput(editing), 'will be discarded');
    click(buttonInside(editing, 'cancel-edit'));

    assert.equal(h.dispatched.length, 0);
    assert.equal(
        findAll(h.root, (el) => el.attributes.has('data-notes-modal-edit-input')).length,
        0,
        'cancel exits edit mode',
    );
});

test('delete flow dispatches DeleteNote with the note id when confirmation is granted', () => {
    const h = makeHarness(
        stateWith([
            { id: 'n-1', body: 'keep' },
            { id: 'n-2', body: 'drop' },
        ]),
        { confirmAnswer: true },
    );
    click(buttonInside(noteRow(h.root, 'n-2'), 'delete-note'));

    // Operator was prompted exactly once with the documented copy.
    assert.equal(h.confirm.calls.length, 1, 'operator must be prompted before delete');
    assert.equal(h.confirm.calls[0].message, DELETE_NOTE_CONFIRM_MESSAGE);

    assert.equal(h.dispatched.length, 1);
    const cmd = h.dispatched[0] as Command<DeleteNotePayload>;
    assert.equal(cmd.type, BoardUiCommands.DELETE_NOTE);
    assert.deepEqual(cmd.payload, { noteId: 'n-2' });
});

test('delete flow dispatches nothing when the operator declines confirmation', () => {
    const h = makeHarness(
        stateWith([
            { id: 'n-1', body: 'keep' },
            { id: 'n-2', body: 'almost-deleted' },
        ]),
        { confirmAnswer: false },
    );
    click(buttonInside(noteRow(h.root, 'n-2'), 'delete-note'));

    // The operator was asked, but answered no — no command must hit the bus.
    assert.equal(h.confirm.calls.length, 1, 'operator must be prompted before delete');
    assert.equal(h.confirm.calls[0].message, DELETE_NOTE_CONFIRM_MESSAGE);
    assert.equal(h.dispatched.length, 0, 'declined confirmation must NOT dispatch DeleteNote');

    // Sanity-check: the note row is still on screen because nothing
    // changed in the projection store either.
    const stillThere = findFirst(
        h.root,
        (el) => el.attributes.get('data-note-id') === 'n-2',
    );
    assert.ok(stillThere, 'declined delete must leave the row in place');
});

test('delete flow re-prompts and dispatches when a previously declined delete is retried', () => {
    const h = makeHarness(
        stateWith([{ id: 'n-1', body: 'persistent operator' }]),
        { confirmAnswer: false },
    );
    const deleteBtn = buttonInside(noteRow(h.root, 'n-1'), 'delete-note');

    // First click — declined.
    click(deleteBtn);
    assert.equal(h.dispatched.length, 0);

    // Operator retries; this time they confirm.
    h.confirm.setNext(true);
    click(deleteBtn);

    assert.equal(h.confirm.calls.length, 2, 'each delete click prompts independently');
    assert.equal(h.dispatched.length, 1);
    const cmd = h.dispatched[0] as Command<DeleteNotePayload>;
    assert.equal(cmd.type, BoardUiCommands.DELETE_NOTE);
    assert.deepEqual(cmd.payload, { noteId: 'n-1' });
});

// ---------------------------------------------------------------------------
// AC #3 — promote-to-plan
// ---------------------------------------------------------------------------

test('promote-to-plan dispatches CreatePlan with derived title, full body, and projectId', () => {
    const h = makeHarness(
        stateWith(
            [
                { id: 'n-1', body: '## Roll out caching\nDetails about the rollout plan.' },
            ],
            projectCtx(),
        ),
        { ids: ['plan-id-1'] },
    );
    click(buttonInside(noteRow(h.root, 'n-1'), 'promote-to-plan'));

    assert.equal(h.dispatched.length, 1);
    const cmd = h.dispatched[0] as Command<CreatePlanPayload>;
    assert.equal(cmd.type, BoardUiCommands.CREATE_PLAN);
    assert.equal(cmd.actor, 'operator:tester');
    assert.deepEqual(cmd.payload, {
        planId: 'plan-id-1',
        projectId: 'proj-1',
        title: 'Roll out caching',
        body: '## Roll out caching\nDetails about the rollout plan.',
    });
});

test('derivePromotedPlanTitle: strips heading markers, trims, truncates with ellipsis, falls back to default', () => {
    assert.equal(derivePromotedPlanTitle('hello'), 'hello');
    assert.equal(derivePromotedPlanTitle('## Plan title\nrest'), 'Plan title');
    assert.equal(derivePromotedPlanTitle('   \n  Second line is title  \n'), 'Second line is title');
    assert.equal(derivePromotedPlanTitle(''), 'Promoted note');
    assert.equal(derivePromotedPlanTitle('\n\n   \n'), 'Promoted note');
    const long = 'a'.repeat(PROMOTED_TITLE_MAX + 50);
    const truncated = derivePromotedPlanTitle(long);
    assert.equal(truncated.length, PROMOTED_TITLE_MAX);
    assert.ok(truncated.endsWith('…'));
});

// ---------------------------------------------------------------------------
// AC #4 — promote-to-investigation
// ---------------------------------------------------------------------------

test('promote-to-investigation dispatches CreateInvestigation with the note body as question', () => {
    const h = makeHarness(
        stateWith(
            [{ id: 'n-1', body: 'Why does ingestion stall at 90%?' }],
            taskCtx(),
        ),
    );
    click(buttonInside(noteRow(h.root, 'n-1'), 'promote-to-investigation'));

    assert.equal(h.dispatched.length, 1);
    const cmd = h.dispatched[0] as Command<CreateInvestigationPayload>;
    assert.equal(cmd.type, BoardUiCommands.CREATE_INVESTIGATION);
    assert.deepEqual(cmd.payload, {
        taskId: 'task-42',
        question: 'Why does ingestion stall at 90%?',
    });
});

test('promote-to-investigation button is hidden when context has no taskId', () => {
    const h = makeHarness(
        stateWith([{ id: 'n-1', body: 'project-scoped note' }], projectCtx()),
    );
    const row = noteRow(h.root, 'n-1');
    const btn = findFirst(
        row,
        (el) => el.attributes.get('data-action') === 'promote-to-investigation',
    );
    assert.equal(btn, null, 'no promote-to-investigation button at project scope');
});

// ---------------------------------------------------------------------------
// Subscription lifecycle
// ---------------------------------------------------------------------------

test('destroy() unsubscribes from the store and stops reacting to updates', () => {
    const root = makeShimRoot();
    const store = makeFakeStore(stateWith([{ id: 'n-1', body: 'one' }]));
    const handle = init(root, store, {
        doc: makeShimDocument(),
        dispatch: () => undefined,
        clock: () => 0,
        idGen: { newId: () => 'never-used' },
        actor: 'operator:tester',
        confirm: () => true,
    });
    assert.equal(store.listenerCount(), 1);

    handle.destroy();
    assert.equal(store.listenerCount(), 0);

    store.set(
        stateWith([
            { id: 'n-1', body: 'one' },
            { id: 'n-2', body: 'two' },
        ]),
    );
    assert.equal(
        findAll(root, (el) => el.attributes.has('data-notes-modal-row')).length,
        1,
        'post-destroy update must not re-render',
    );
});
