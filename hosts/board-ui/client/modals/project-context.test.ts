/**
 * Project architecture context modal.
 *
 * The two behaviours worth pinning are about the operator understanding
 * what they are editing: the hint has to name who reads the file, and a
 * rejected save has to show the REASON (the 422 from the truncation
 * guard, the 409 from a concurrent save) rather than a generic failure.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import {
    PROJECT_CONTEXT_HINT,
    PROJECT_CONTEXT_OVERLAY_ID,
    createProjectContextModal,
    type ProjectContextFetchResult,
} from './project-context';

// --- minimal DOM ---------------------------------------------------------
//
// The repo pulls in neither jsdom nor happy-dom (see editors.test.ts), so
// the modal takes an injectable `doc` and this is the smallest fake that
// satisfies what it touches.

interface FakeEl {
    tagName: string;
    className: string;
    textContent: string;
    value: string;
    rows: number;
    type: string;
    spellcheck: boolean;
    disabled: boolean;
    children: FakeEl[];
    attrs: Record<string, string>;
    listeners: Record<string, Array<() => void>>;
    appendChild(child: FakeEl): FakeEl;
    append(...children: FakeEl[]): void;
    setAttribute(k: string, v: string): void;
    addEventListener(ev: string, cb: () => void): void;
    removeEventListener?(): void;
    remove(): void;
    focus(): void;
}

function makeEl(tagName: string): FakeEl {
    const el: FakeEl = {
        tagName,
        className: '',
        textContent: '',
        value: '',
        rows: 0,
        type: '',
        spellcheck: true,
        disabled: false,
        children: [],
        attrs: {},
        listeners: {},
        appendChild(child): FakeEl {
            el.children.push(child);
            return child;
        },
        append(...children): void {
            for (const c of children) el.children.push(c);
        },
        setAttribute(k, v): void {
            el.attrs[k] = v;
        },
        addEventListener(ev, cb): void {
            (el.listeners[ev] ??= []).push(cb);
        },
        remove(): void {},
        focus(): void {},
    };
    return el;
}

function makeDoc(): { doc: Document; body: FakeEl } {
    const body = makeEl('body');
    const doc = {
        createElement: (tag: string): FakeEl => makeEl(tag),
        body,
        documentElement: body,
    };
    return { doc: doc as unknown as Document, body };
}

/** Depth-first search for the first element matching a predicate. */
function find(root: FakeEl, pred: (el: FakeEl) => boolean): FakeEl | null {
    for (const child of root.children) {
        if (pred(child)) return child;
        const hit = find(child, pred);
        if (hit) return hit;
    }
    return null;
}

function byTestId(root: FakeEl, id: string): FakeEl | null {
    return find(root, (el) => el.attrs['data-testid'] === id);
}

function ok(body: ProjectContextFetchResult['body']): ProjectContextFetchResult {
    return { ok: true, status: 200, body };
}

test('the hint names who reads the file', () => {
    // An operator typing into an unexplained box cannot judge what belongs
    // in it — and a wrong guess lands in three agents' prompts.
    assert.match(PROJECT_CONTEXT_HINT, /planner, decomposer and\s+architect/);
    assert.match(PROJECT_CONTEXT_HINT, /never as\s+instructions/);
});

test('open loads the stored content into the editor', async () => {
    const { doc, body } = makeDoc();
    const opened: string[] = [];
    const modal = createProjectContextModal({
        doc,
        load: async () => ok({ content: '# Architecture\n\nTwo APIs.', etag: 'e1' }),
        save: async () => ok({}),
        openOverlay: (id) => opened.push(id),
        closeOverlay: () => {},
    });

    await modal.open({ projectId: 'shop', projectName: 'Shop' });

    assert.deepEqual(opened, [PROJECT_CONTEXT_OVERLAY_ID]);
    const input = byTestId(body, 'project-context-input');
    assert.ok(input, 'the editor must be mounted');
    assert.equal(input!.value, '# Architecture\n\nTwo APIs.');
    assert.equal(input!.disabled, false);
    const title = find(body, (el) => el.className.includes('project-context__title'));
    assert.match(title!.textContent, /Shop/);
});

test('an empty context invites the operator to write one', async () => {
    const { doc, body } = makeDoc();
    const modal = createProjectContextModal({
        doc,
        load: async () => ok({ content: '', etag: '' }),
        save: async () => ok({}),
        openOverlay: () => {},
        closeOverlay: () => {},
    });
    await modal.open({ projectId: 'p' });
    const status = find(body, (el) => el.className.includes('project-context__status'));
    assert.match(status!.textContent, /No context yet/);
});

test('save round-trips the etag it loaded', async () => {
    const { doc, body } = makeDoc();
    const saves: Array<{ projectId: string; content: string; etag: string }> = [];
    const modal = createProjectContextModal({
        doc,
        load: async () => ok({ content: 'old', etag: 'e1' }),
        save: async (projectId, content, etag) => {
            saves.push({ projectId, content, etag });
            return ok({ etag: 'e2' });
        },
        openOverlay: () => {},
        closeOverlay: () => {},
    });
    await modal.open({ projectId: 'shop' });

    const input = byTestId(body, 'project-context-input')!;
    input.value = '# New\n\nEdited.';
    const saveBtn = byTestId(body, 'project-context-save')!;
    saveBtn.listeners.click![0]!();
    await new Promise((r) => setImmediate(r));

    assert.deepEqual(saves, [
        { projectId: 'shop', content: '# New\n\nEdited.', etag: 'e1' },
    ]);
});

test('a rejected save shows the reason, not a generic failure', async () => {
    // The 422 body is the integrity guard explaining that nothing was
    // saved and why; swallowing it would leave the operator guessing.
    const { doc, body } = makeDoc();
    const modal = createProjectContextModal({
        doc,
        load: async () => ok({ content: 'old', etag: 'e1' }),
        save: async () => ({
            ok: false,
            status: 422,
            body: {
                error: 'The content ends on "**Key systems:**", which introduces '
                    + 'something that never arrives.',
                code: 'dangling-lead-in',
            },
        }),
        openOverlay: () => {},
        closeOverlay: () => {},
    });
    await modal.open({ projectId: 'p' });

    byTestId(body, 'project-context-save')!.listeners.click![0]!();
    await new Promise((r) => setImmediate(r));

    const status = find(body, (el) => el.className.includes('project-context__status'))!;
    assert.match(status.textContent, /never arrives/);
    assert.match(status.className, /--error/);
});

test('a failed load explains itself and leaves the editor disabled', async () => {
    const { doc, body } = makeDoc();
    const modal = createProjectContextModal({
        doc,
        load: async () => ({
            ok: false,
            status: 502,
            body: { error: 'manager-api unreachable: ECONNREFUSED' },
        }),
        save: async () => ok({}),
        openOverlay: () => {},
        closeOverlay: () => {},
    });
    await modal.open({ projectId: 'p' });

    const status = find(body, (el) => el.className.includes('project-context__status'))!;
    assert.match(status.textContent, /manager-api unreachable/);
    assert.equal(byTestId(body, 'project-context-input')!.disabled, true);
    assert.equal(
        byTestId(body, 'project-context-save')!.disabled,
        true,
        'saving over a context that failed to load would blank it',
    );
});

test('close releases the overlay', async () => {
    const { doc, body } = makeDoc();
    const closed: string[] = [];
    const modal = createProjectContextModal({
        doc,
        load: async () => ok({ content: 'x', etag: '' }),
        save: async () => ok({}),
        openOverlay: () => {},
        closeOverlay: (id) => closed.push(id),
    });
    await modal.open({ projectId: 'p' });

    const closeBtn = find(body, (el) => el.textContent === 'Close')!;
    closeBtn.listeners.click![0]!();
    assert.deepEqual(closed, [PROJECT_CONTEXT_OVERLAY_ID]);
});
