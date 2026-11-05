/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * AP-VP5-013 unit tests for the per-project notes panel.
 *
 * Covers every acceptance criterion the brief calls out:
 *   1. Panel loads notes via GET /projects/:projectId/notes on mount.
 *   2. Each note renders Edit, Delete, Promote, Convert buttons.
 *   3. 'New note' opens an inline composer that POSTs on save.
 *   4. Promote AND Convert require operator confirmation before
 *      dispatching.
 *   5. Delete also requires confirmation (and dispatches the DELETE
 *      with the noteId).
 *   6. Renders the empty-list placeholder + the populated-list rows.
 *   7. Inline edit flow swaps body for a textarea and Save dispatches a
 *      PUT containing the trimmed content.
 *
 * Dual-runner test() shim (matches the AP-IFF-011 modal test): the repo's
 * `npm test` runs node:test; the review pipeline runs vitest on changed
 * files. The shim picks the right `test()` at module load so both
 * runners discover the same suite from a single source file.
 *
 * DOM strategy — hand-rolled shim. Matches `test/board-ui/modals/notes.spec.ts`
 * so a reviewer can diff the two side-by-side; jsdom would be overkill
 * for a structural-DOM module.
 */
import * as assert from 'node:assert/strict';

import {
    CONVERT_CONFIRM_MESSAGE,
    DELETE_CONFIRM_MESSAGE,
    init,
    PROMOTE_CONFIRM_MESSAGE,
    type NotesPanelConfirm,
    type NotesPanelDocument,
    type NotesPanelElement,
    type NotesPanelFetch,
    type NotesPanelFetchInit,
    type NotesPanelNote,
    type NotesPanelRenderMarkdown,
    type NotesPanelResponse,
} from '../../../hosts/board-ui/panels/notes';

// ---------------------------------------------------------------------------
// Dual-runner test() shim
// ---------------------------------------------------------------------------

type TestFn = (name: string, fn: () => void | Promise<void>) => void;

const test: TestFn = (((): TestFn => {
    if (process.env.VITEST) {
        const gt = (globalThis as { test?: TestFn }).test;
        if (typeof gt !== 'function') {
            throw new Error(
                'notes-panel.test.ts: VITEST=true but globalThis.test is missing — '
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
// Minimal DOM shim — mirrors test/board-ui/modals/notes.spec.ts
// ---------------------------------------------------------------------------

interface ShimElement extends NotesPanelElement {
    tagName: string;
    attributes: Map<string, string>;
    children: ShimElement[];
    onclick?: () => void;
    oninput?: (event: { target: { value: string } }) => void;
}

function makeShimElement(tagName: string): ShimElement {
    const attrs = new Map<string, string>();
    const children: ShimElement[] = [];
    const el: ShimElement = {
        tagName,
        className: '',
        textContent: null,
        value: undefined,
        hidden: false,
        attributes: attrs,
        children,
        setAttribute(name: string, value: string): void {
            attrs.set(name, value);
        },
        appendChild(child: NotesPanelElement): NotesPanelElement {
            children.push(child as ShimElement);
            return child;
        },
        replaceChildren(...next: NotesPanelElement[]): void {
            children.length = 0;
            for (const c of next) children.push(c as ShimElement);
        },
    };
    return el;
}

function makeShimDocument(): NotesPanelDocument {
    return {
        createElement(tagName: string): NotesPanelElement {
            return makeShimElement(tagName);
        },
    };
}

function makeShimRoot(): ShimElement {
    return makeShimElement('section');
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

function findButton(root: ShimElement, action: string): ShimElement {
    const btn = findFirst(root, (el) => el.attributes.get('data-action') === action);
    if (!btn) throw new Error(`no "${action}" button rendered`);
    return btn;
}

function noteRow(root: ShimElement, noteId: string): ShimElement {
    const row = findFirst(root, (el) => el.attributes.get('data-note-id') === noteId);
    if (!row) throw new Error(`no note row for "${noteId}"`);
    return row;
}

function buttonInside(parent: ShimElement, action: string): ShimElement {
    const btn = findFirst(parent, (el) => el.attributes.get('data-action') === action);
    if (!btn) throw new Error(`no "${action}" button inside row`);
    return btn;
}

function click(el: ShimElement): void {
    if (!el.onclick) throw new Error(`<${el.tagName}> has no onclick handler`);
    el.onclick();
}

function type(el: ShimElement, value: string): void {
    if (!el.oninput) throw new Error(`<${el.tagName}> has no oninput handler`);
    el.oninput({ target: { value } });
}

// ---------------------------------------------------------------------------
// Network fake — programmable response queue + a request recorder
// ---------------------------------------------------------------------------

interface FetchCall {
    readonly url: string;
    readonly method: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: unknown;
}

type Responder = () => Promise<NotesPanelResponse>;

interface FakeFetch {
    readonly fn: NotesPanelFetch;
    readonly calls: FetchCall[];
    /**
     * Push a JSON response that the next matching request will receive.
     * Routes are matched by `${METHOD} ${path-suffix}` so the test can
     * pin a specific endpoint without caring about the apiBase prefix.
     */
    queue(route: string, status: number, body?: unknown): void;
    /** Push a response shared by every still-unmatched call. */
    queueDefault(status: number, body?: unknown): void;
}

function makeFakeFetch(): FakeFetch {
    const calls: FetchCall[] = [];
    const queued = new Map<string, Responder[]>();
    let defaultResponder: Responder | null = null;
    const okJson = (status: number, body: unknown): Responder => async (): Promise<NotesPanelResponse> => ({
        ok: status >= 200 && status < 300,
        status,
        async json(): Promise<unknown> {
            return body;
        },
    });
    return {
        calls,
        queue(route, status, body): void {
            const existing = queued.get(route) ?? [];
            existing.push(okJson(status, body));
            queued.set(route, existing);
        },
        queueDefault(status, body): void {
            defaultResponder = okJson(status, body);
        },
        async fn(url: string, init?: NotesPanelFetchInit): Promise<NotesPanelResponse> {
            const method = init?.method ?? 'GET';
            const path = url.replace(/^[^/]*:?\/\/[^/]*/, '');
            const route = `${method} ${path}`;
            let parsedBody: unknown = undefined;
            if (typeof init?.body === 'string' && init.body.length > 0) {
                try {
                    parsedBody = JSON.parse(init.body);
                } catch {
                    parsedBody = init.body;
                }
            }
            calls.push({
                url,
                method,
                headers: { ...(init?.headers ?? {}) },
                body: parsedBody,
            });
            const pool = queued.get(route);
            if (pool && pool.length > 0) {
                return pool.shift()!();
            }
            if (defaultResponder) return defaultResponder();
            throw new Error(`fake fetch: no response queued for ${route}`);
        },
    };
}

// ---------------------------------------------------------------------------
// Confirm recorder
// ---------------------------------------------------------------------------

interface ConfirmRecorder {
    readonly fn: NotesPanelConfirm;
    readonly calls: string[];
    setNext(answer: boolean): void;
}

function makeConfirmRecorder(defaultAnswer: boolean): ConfirmRecorder {
    const calls: string[] = [];
    let pending: boolean | null = null;
    return {
        calls,
        setNext(answer: boolean): void {
            pending = answer;
        },
        fn(message: string): boolean {
            calls.push(message);
            if (pending !== null) {
                const a = pending;
                pending = null;
                return a;
            }
            return defaultAnswer;
        },
    };
}

// ---------------------------------------------------------------------------
// Markdown helper recorder — verifies the plan-card renderer was invoked
// ---------------------------------------------------------------------------

interface MarkdownRecorder {
    readonly fn: NotesPanelRenderMarkdown;
    readonly calls: string[];
}

function makeMarkdownRecorder(doc: NotesPanelDocument): MarkdownRecorder {
    const calls: string[] = [];
    return {
        calls,
        fn(text: string): ReadonlyArray<NotesPanelElement> {
            calls.push(text);
            const el = doc.createElement('div');
            el.className = 'markdown-stub';
            el.setAttribute('data-markdown-stub', '');
            el.textContent = text;
            return [el];
        },
    };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Harness {
    root: ShimElement;
    fetch: FakeFetch;
    confirm: ConfirmRecorder;
    markdown: MarkdownRecorder;
    errors: Error[];
    handle: ReturnType<typeof init>;
}

interface HarnessOptions {
    initialNotes?: ReadonlyArray<NotesPanelNote>;
    confirmAnswer?: boolean;
    projectId?: string;
    skipInitialLoad?: boolean;
}

async function makeHarness(options: HarnessOptions = {}): Promise<Harness> {
    const doc = makeShimDocument();
    const root = makeShimRoot();
    const fakeFetch = makeFakeFetch();
    const confirm = makeConfirmRecorder(options.confirmAnswer ?? true);
    const markdown = makeMarkdownRecorder(doc);
    const errors: Error[] = [];
    const initial = options.initialNotes ?? [];
    fakeFetch.queue(
        `GET /projects/${options.projectId ?? 'proj-1'}/notes`,
        200,
        { notes: initial },
    );
    const handle = init(root, options.projectId ?? 'proj-1', {
        doc,
        fetch: fakeFetch.fn,
        renderMarkdown: markdown.fn,
        confirm: confirm.fn,
        actor: 'operator:tester',
        onError: (e) => errors.push(e),
    });
    if (!options.skipInitialLoad) {
        // Initial load is fire-and-forget inside init(); wait for it so
        // tests don't race the first render.
        await handle.load();
    }
    return { root, fetch: fakeFetch, confirm, markdown, errors, handle };
}

// ---------------------------------------------------------------------------
// AC #1 + #6 — GET on mount, empty + populated rendering
// ---------------------------------------------------------------------------

test('init + load: GETs /projects/:projectId/notes once on mount', async () => {
    const h = await makeHarness({ initialNotes: [] });
    const getCalls = h.fetch.calls.filter(
        (c) => c.method === 'GET' && c.url.endsWith('/projects/proj-1/notes'),
    );
    // init() paints empty chrome synchronously; the host (here the
    // harness) follows up with `handle.load()` to perform the GET — one
    // request per mount, no double-fetch races.
    assert.equal(getCalls.length, 1, `expected exactly one GET on mount, saw ${getCalls.length}`);
});

test('renders the empty-list placeholder when no notes are returned', async () => {
    const h = await makeHarness({ initialNotes: [] });
    const empty = findFirst(h.root, (el) => el.attributes.has('data-empty'));
    assert.ok(empty, 'expected an empty-state row');
    assert.equal(empty!.textContent, 'No notes yet');
});

test('renders one row per note in the GET response (populated list)', async () => {
    const h = await makeHarness({
        initialNotes: [
            { noteId: 'n-1', content: '# first' },
            { noteId: 'n-2', content: 'second body' },
        ],
    });
    const rows = findAll(h.root, (el) => el.attributes.has('data-notes-panel-row'));
    assert.equal(rows.length, 2);
    assert.deepEqual(
        rows.map((r) => r.attributes.get('data-note-id')),
        ['n-1', 'n-2'],
    );
    // Markdown helper was invoked once per note with the note body.
    assert.deepEqual(h.markdown.calls, ['# first', 'second body']);
    // And every note row carries the four action buttons (AC #2).
    for (const row of rows) {
        for (const action of [
            'edit-note',
            'delete-note',
            'promote-to-plan',
            'convert-to-investigation',
        ]) {
            assert.ok(
                findFirst(row, (el) => el.attributes.get('data-action') === action),
                `row ${row.attributes.get('data-note-id')} missing ${action}`,
            );
        }
    }
});

// ---------------------------------------------------------------------------
// AC #3 — New-note composer → POST
// ---------------------------------------------------------------------------

test('new-note button opens the inline composer (title + content fields)', async () => {
    const h = await makeHarness({ initialNotes: [] });
    assert.equal(
        findFirst(h.root, (el) => el.attributes.has('data-notes-panel-composer')),
        null,
        'composer should not be open before the click',
    );
    click(findButton(h.root, 'new-note'));
    const composer = findFirst(h.root, (el) =>
        el.attributes.has('data-notes-panel-composer'),
    );
    assert.ok(composer, 'composer must render after new-note click');
    assert.ok(
        findFirst(composer!, (el) =>
            el.attributes.has('data-notes-panel-composer-title'),
        ),
        'composer must expose a title field',
    );
    assert.ok(
        findFirst(composer!, (el) =>
            el.attributes.has('data-notes-panel-composer-content'),
        ),
        'composer must expose a content field',
    );
});

test('composer Save dispatches POST /projects/:projectId/notes with title + content', async () => {
    const h = await makeHarness({ initialNotes: [] });
    click(findButton(h.root, 'new-note'));
    const composer = findFirst(h.root, (el) =>
        el.attributes.has('data-notes-panel-composer'),
    )!;
    type(
        findFirst(composer, (el) =>
            el.attributes.has('data-notes-panel-composer-title'),
        )!,
        'My title',
    );
    type(
        findFirst(composer, (el) =>
            el.attributes.has('data-notes-panel-composer-content'),
        )!,
        'Note body here',
    );

    // Queue the POST response + the follow-up GET that load() re-fires.
    h.fetch.queue('POST /projects/proj-1/notes', 202, {
        accepted: true,
        noteId: 'new-id',
    });
    h.fetch.queue('GET /projects/proj-1/notes', 200, {
        notes: [{ noteId: 'new-id', content: 'Note body here' }],
    });

    click(buttonInside(composer, 'save-new-note'));
    // Let the async fetch chain settle.
    await new Promise<void>((r) => setTimeout(r, 0));
    await new Promise<void>((r) => setTimeout(r, 0));

    const postCall = h.fetch.calls.find(
        (c) =>
            c.method === 'POST'
            && c.url.endsWith('/projects/proj-1/notes')
            && !c.url.includes('/promote')
            && !c.url.includes('/convert'),
    );
    assert.ok(postCall, 'expected a POST to /projects/proj-1/notes');
    assert.deepEqual(postCall!.body, {
        content: 'Note body here',
        actor: 'operator:tester',
        title: 'My title',
    });
    // load() re-fired after the POST resolves — composer collapsed.
    assert.equal(
        findFirst(h.root, (el) => el.attributes.has('data-notes-panel-composer')),
        null,
        'composer collapses after a successful save',
    );
});

test('composer Save ignores whitespace-only content (no POST)', async () => {
    const h = await makeHarness({ initialNotes: [] });
    click(findButton(h.root, 'new-note'));
    const composer = findFirst(h.root, (el) =>
        el.attributes.has('data-notes-panel-composer'),
    )!;
    type(
        findFirst(composer, (el) =>
            el.attributes.has('data-notes-panel-composer-content'),
        )!,
        '   \n  \t  ',
    );
    const before = h.fetch.calls.length;
    click(buttonInside(composer, 'save-new-note'));
    await new Promise<void>((r) => setTimeout(r, 0));
    assert.equal(h.fetch.calls.length, before, 'whitespace-only must not POST');
});

// ---------------------------------------------------------------------------
// AC #7 — inline edit → PUT
// ---------------------------------------------------------------------------

test('edit flow dispatches PUT /projects/:projectId/notes/:noteId with trimmed content', async () => {
    const h = await makeHarness({
        initialNotes: [{ noteId: 'n-1', content: 'original' }],
    });
    click(buttonInside(noteRow(h.root, 'n-1'), 'edit-note'));
    // After click, the row re-renders with a textarea instead of a body.
    const editingRow = noteRow(h.root, 'n-1');
    const editInput = findFirst(editingRow, (el) =>
        el.attributes.has('data-notes-panel-edit-input'),
    );
    assert.ok(editInput, 'edit textarea must mount');
    type(editInput!, '   revised body   ');

    h.fetch.queue('PUT /projects/proj-1/notes/n-1', 202, {
        accepted: true,
        noteId: 'n-1',
    });
    h.fetch.queue('GET /projects/proj-1/notes', 200, {
        notes: [{ noteId: 'n-1', content: 'revised body' }],
    });
    click(buttonInside(editingRow, 'save-note'));
    await new Promise<void>((r) => setTimeout(r, 0));
    await new Promise<void>((r) => setTimeout(r, 0));

    const putCall = h.fetch.calls.find(
        (c) => c.method === 'PUT' && c.url.endsWith('/projects/proj-1/notes/n-1'),
    );
    assert.ok(putCall, 'expected a PUT to /projects/proj-1/notes/n-1');
    assert.deepEqual(putCall!.body, {
        content: 'revised body',
        actor: 'operator:tester',
    });
    // Editor closed after save — no edit-input left in the tree.
    assert.equal(
        findAll(h.root, (el) => el.attributes.has('data-notes-panel-edit-input')).length,
        0,
        'edit textarea is torn down after save',
    );
});

test('edit Cancel exits edit mode without dispatching anything', async () => {
    const h = await makeHarness({
        initialNotes: [{ noteId: 'n-1', content: 'original' }],
    });
    click(buttonInside(noteRow(h.root, 'n-1'), 'edit-note'));
    const editingRow = noteRow(h.root, 'n-1');
    type(
        findFirst(editingRow, (el) =>
            el.attributes.has('data-notes-panel-edit-input'),
        )!,
        'discarded',
    );
    const before = h.fetch.calls.length;
    click(buttonInside(editingRow, 'cancel-edit'));
    assert.equal(h.fetch.calls.length, before, 'cancel-edit must not call fetch');
    assert.equal(
        findAll(h.root, (el) => el.attributes.has('data-notes-panel-edit-input')).length,
        0,
        'cancel exits edit mode',
    );
});

// ---------------------------------------------------------------------------
// AC #5 — delete with confirmation
// ---------------------------------------------------------------------------

test('delete flow dispatches DELETE after the operator confirms', async () => {
    const h = await makeHarness({
        initialNotes: [{ noteId: 'n-1', content: 'doomed' }],
        confirmAnswer: true,
    });
    h.fetch.queue('DELETE /projects/proj-1/notes/n-1', 202, {
        accepted: true,
        noteId: 'n-1',
    });
    h.fetch.queue('GET /projects/proj-1/notes', 200, { notes: [] });
    click(buttonInside(noteRow(h.root, 'n-1'), 'delete-note'));
    await new Promise<void>((r) => setTimeout(r, 0));
    await new Promise<void>((r) => setTimeout(r, 0));

    assert.deepEqual(h.confirm.calls, [DELETE_CONFIRM_MESSAGE]);
    const del = h.fetch.calls.find(
        (c) => c.method === 'DELETE' && c.url.endsWith('/projects/proj-1/notes/n-1'),
    );
    assert.ok(del, 'expected a DELETE to /projects/proj-1/notes/n-1');
    assert.deepEqual(del!.body, { actor: 'operator:tester' });
});

test('delete flow aborts (no fetch) when the operator declines the confirm', async () => {
    const h = await makeHarness({
        initialNotes: [{ noteId: 'n-1', content: 'safe' }],
        confirmAnswer: false,
    });
    const before = h.fetch.calls.length;
    click(buttonInside(noteRow(h.root, 'n-1'), 'delete-note'));
    await new Promise<void>((r) => setTimeout(r, 0));
    assert.deepEqual(h.confirm.calls, [DELETE_CONFIRM_MESSAGE]);
    assert.equal(
        h.fetch.calls.length,
        before,
        'declined confirm must NOT issue a DELETE',
    );
    // Row is still in the tree because nothing changed.
    assert.ok(
        findFirst(h.root, (el) => el.attributes.get('data-note-id') === 'n-1'),
        'declined delete leaves the row in place',
    );
});

// ---------------------------------------------------------------------------
// AC #4 — promote / convert with confirmation
// ---------------------------------------------------------------------------

test('promote-to-plan dispatches POST /promote after the operator confirms', async () => {
    const h = await makeHarness({
        initialNotes: [{ noteId: 'n-1', content: 'plan-worthy' }],
        confirmAnswer: true,
    });
    h.fetch.queue('POST /projects/proj-1/notes/n-1/promote', 202, {
        accepted: true,
        noteId: 'n-1',
    });
    click(buttonInside(noteRow(h.root, 'n-1'), 'promote-to-plan'));
    await new Promise<void>((r) => setTimeout(r, 0));

    assert.deepEqual(h.confirm.calls, [PROMOTE_CONFIRM_MESSAGE]);
    const post = h.fetch.calls.find(
        (c) =>
            c.method === 'POST'
            && c.url.endsWith('/projects/proj-1/notes/n-1/promote'),
    );
    assert.ok(post, 'expected POST to /projects/proj-1/notes/n-1/promote');
    assert.deepEqual(post!.body, { actor: 'operator:tester' });
});

test('promote-to-plan aborts when the operator declines confirmation', async () => {
    const h = await makeHarness({
        initialNotes: [{ noteId: 'n-1', content: 'plan-worthy' }],
        confirmAnswer: false,
    });
    const before = h.fetch.calls.length;
    click(buttonInside(noteRow(h.root, 'n-1'), 'promote-to-plan'));
    await new Promise<void>((r) => setTimeout(r, 0));
    assert.deepEqual(h.confirm.calls, [PROMOTE_CONFIRM_MESSAGE]);
    assert.equal(
        h.fetch.calls.length,
        before,
        'declined confirm must NOT issue a promote POST',
    );
});

test('convert-to-investigation dispatches POST /convert after the operator confirms', async () => {
    const h = await makeHarness({
        initialNotes: [{ noteId: 'n-1', content: 'why is X slow?' }],
        confirmAnswer: true,
    });
    h.fetch.queue('POST /projects/proj-1/notes/n-1/convert', 202, {
        accepted: true,
        noteId: 'n-1',
    });
    click(buttonInside(noteRow(h.root, 'n-1'), 'convert-to-investigation'));
    await new Promise<void>((r) => setTimeout(r, 0));

    assert.deepEqual(h.confirm.calls, [CONVERT_CONFIRM_MESSAGE]);
    const post = h.fetch.calls.find(
        (c) =>
            c.method === 'POST'
            && c.url.endsWith('/projects/proj-1/notes/n-1/convert'),
    );
    assert.ok(post, 'expected POST to /projects/proj-1/notes/n-1/convert');
    assert.deepEqual(post!.body, { actor: 'operator:tester' });
});

test('convert-to-investigation aborts when the operator declines confirmation', async () => {
    const h = await makeHarness({
        initialNotes: [{ noteId: 'n-1', content: 'why?' }],
        confirmAnswer: false,
    });
    const before = h.fetch.calls.length;
    click(buttonInside(noteRow(h.root, 'n-1'), 'convert-to-investigation'));
    await new Promise<void>((r) => setTimeout(r, 0));
    assert.deepEqual(h.confirm.calls, [CONVERT_CONFIRM_MESSAGE]);
    assert.equal(
        h.fetch.calls.length,
        before,
        'declined confirm must NOT issue a convert POST',
    );
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

test('destroy() clears the root and stops responding to subsequent loads', async () => {
    const h = await makeHarness({
        initialNotes: [{ noteId: 'n-1', content: 'one' }],
    });
    assert.ok(h.root.children.length > 0, 'panel should have rendered children');
    h.handle.destroy();
    assert.equal(h.root.children.length, 0, 'destroy clears the panel root');

    // A post-destroy load() is a no-op — it does not refill the tree.
    h.fetch.queue('GET /projects/proj-1/notes', 200, {
        notes: [{ noteId: 'n-2', content: 'two' }],
    });
    await h.handle.load();
    assert.equal(
        h.root.children.length,
        0,
        'post-destroy load must NOT re-render',
    );
});

test('GET error surfaces through onError and leaves the empty state on screen', async () => {
    // skipInitialLoad so we can queue a 500 instead of the harness's default 200.
    const doc = makeShimDocument();
    const root = makeShimRoot();
    const fakeFetch = makeFakeFetch();
    const confirm = makeConfirmRecorder(true);
    const markdown = makeMarkdownRecorder(doc);
    const errors: Error[] = [];
    fakeFetch.queue('GET /projects/proj-1/notes', 500, { error: 'boom' });
    const handle = init(root, 'proj-1', {
        doc,
        fetch: fakeFetch.fn,
        renderMarkdown: markdown.fn,
        confirm: confirm.fn,
        actor: 'operator:tester',
        onError: (e) => errors.push(e),
    });
    await handle.load();
    assert.ok(
        errors.some((e) => /GET notes failed: 500/.test(e.message)),
        `expected an onError call describing the 500, saw ${errors.map((e) => e.message).join(', ')}`,
    );
    const empty = findFirst(root, (el) => el.attributes.has('data-empty'));
    assert.ok(empty, 'empty-state placeholder survives a failed GET');
});
