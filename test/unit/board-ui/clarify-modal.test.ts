/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * AP-VP5-010 unit tests for the board clarify modal.
 *
 * Coverage matches the task brief's acceptance criteria + the three
 * renderer shapes called out at the bottom of the description:
 *
 *   AC #1 — renders question, optional choice radios, free-text textarea;
 *   AC #2 — `Remember this decision` checkbox defaults to unchecked;
 *   AC #3 — Submit POSTs `{ answer, remember }` to /tasks/:id/clarify
 *           and closes the modal on a 202 (no close on non-2xx);
 *   AC #4 — malformed choices (non-array, null, mixed) degrade silently
 *           to the free-text-only variant;
 *   AC #5 — Cancel + Escape close the modal without dispatching, and
 *           backdrop-click follows the same path.
 *
 * Renderer-shape tests (brief: "question only; question + choices;
 * question + malformed choices") are covered by the three first blocks
 * — same test surface, just different input shapes.
 *
 * Dual-runner test() shim — mirrors `notes-panel.test.ts`. The repo's
 * `npm test` runs node:test; the review pipeline runs vitest on changed
 * files. The shim picks the right `test()` at module load so both
 * runners discover the same suite from a single file.
 *
 * DOM strategy — hand-rolled shim. jsdom is not in the project's
 * dependency graph and the rest of the board-ui modal suite (see
 * `test/board-ui/modals/clarify.spec.ts`) uses the same approach.
 */
import * as assert from 'node:assert/strict';

import {
    CLARIFY_CANCEL_TESTID,
    CLARIFY_CHOICES_TESTID,
    CLARIFY_OVERLAY_TESTID,
    CLARIFY_QUESTION_TESTID,
    CLARIFY_REMEMBER_TESTID,
    CLARIFY_SUBMIT_TESTID,
    CLARIFY_TEXTAREA_TESTID,
    CLARIFY_ERROR_TESTID,
    CLARIFY_NETWORK_ERROR_MESSAGE,
    normaliseChoices,
    openClarifyModal,
    type ClarifyDocument,
    type ClarifyElement,
    type ClarifyFetch,
    type ClarifyFetchInit,
    type ClarifyFetchResponse,
    type ClarifyKeyListener,
} from '../../../hosts/board-ui/modals/clarify';

// ---------------------------------------------------------------------------
// Dual-runner test() shim
// ---------------------------------------------------------------------------

type TestFn = (name: string, fn: () => void | Promise<void>) => void;

const test: TestFn = (((): TestFn => {
    if (process.env.VITEST) {
        const gt = (globalThis as { test?: TestFn }).test;
        if (typeof gt !== 'function') {
            throw new Error(
                'clarify-modal.test.ts: VITEST=true but globalThis.test is missing — '
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

interface ShimElement extends ClarifyElement {
    readonly tagName: string;
    readonly children: ShimElement[];
    readonly attributes: Map<string, string>;
    parent: ShimElement | null;
    removed: boolean;
    focusCalls: number;
}

function makeShimElement(tagName: string): ShimElement {
    const attrs = new Map<string, string>();
    const children: ShimElement[] = [];
    const el: ShimElement = {
        tagName,
        className: '',
        textContent: null,
        value: '',
        checked: false,
        hidden: false,
        children,
        attributes: attrs,
        parent: null,
        removed: false,
        focusCalls: 0,
        setAttribute(name: string, v: string): void {
            attrs.set(name, v);
        },
        appendChild(child: ClarifyElement): ClarifyElement {
            const c = child as ShimElement;
            c.parent = el;
            children.push(c);
            return c;
        },
        remove(): void {
            el.removed = true;
            if (el.parent) {
                const idx = el.parent.children.indexOf(el);
                if (idx >= 0) el.parent.children.splice(idx, 1);
                el.parent = null;
            }
        },
        focus(): void {
            el.focusCalls++;
        },
        onclick: undefined,
    };
    return el;
}

interface ShimDocument extends ClarifyDocument {
    readonly listeners: Map<string, ClarifyKeyListener[]>;
    readonly created: ShimElement[];
}

function makeShimDocument(): ShimDocument {
    const listeners = new Map<string, ClarifyKeyListener[]>();
    const created: ShimElement[] = [];
    return {
        listeners,
        created,
        createElement(tagName: string): ClarifyElement {
            const el = makeShimElement(tagName);
            created.push(el);
            return el;
        },
        addEventListener(type: 'keydown', listener: ClarifyKeyListener): void {
            const pool = listeners.get(type) ?? [];
            pool.push(listener);
            listeners.set(type, pool);
        },
        removeEventListener(type: 'keydown', listener: ClarifyKeyListener): void {
            const pool = listeners.get(type);
            if (!pool) return;
            const idx = pool.indexOf(listener);
            if (idx >= 0) pool.splice(idx, 1);
        },
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

function byTestId(root: ShimElement, testid: string): ShimElement {
    const hit = findFirst(root, (el) => el.attributes.get('data-testid') === testid);
    if (!hit) throw new Error(`no element with data-testid="${testid}"`);
    return hit;
}

function maybeByTestId(root: ShimElement, testid: string): ShimElement | null {
    return findFirst(root, (el) => el.attributes.get('data-testid') === testid);
}

// ---------------------------------------------------------------------------
// Fetch fake
// ---------------------------------------------------------------------------

interface FetchCall {
    readonly url: string;
    readonly method: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: unknown;
}

interface FakeFetch {
    readonly fn: ClarifyFetch;
    readonly calls: FetchCall[];
    queue(response: ClarifyFetchResponse | Error): void;
}

function makeFakeFetch(defaultStatus = 202): FakeFetch {
    const calls: FetchCall[] = [];
    const queue: Array<ClarifyFetchResponse | Error> = [];
    return {
        calls,
        queue(response): void {
            queue.push(response);
        },
        async fn(url: string, init?: ClarifyFetchInit): Promise<ClarifyFetchResponse> {
            const method = init?.method ?? 'GET';
            let body: unknown = undefined;
            if (typeof init?.body === 'string' && init.body.length > 0) {
                try {
                    body = JSON.parse(init.body);
                } catch {
                    body = init.body;
                }
            }
            calls.push({ url, method, headers: { ...(init?.headers ?? {}) }, body });
            const next = queue.shift();
            if (next instanceof Error) throw next;
            if (next) return next;
            return { ok: defaultStatus >= 200 && defaultStatus < 300, status: defaultStatus };
        },
    };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface HarnessOptions {
    taskId?: string;
    question?: string;
    choices?: unknown;
    onClose?: () => void;
    /** Override the POST path — see the decomposer Answer test below. */
    submitPath?: string;
}

interface ErrorCall {
    readonly message: string;
    readonly status?: number;
}

interface Harness {
    doc: ShimDocument;
    parent: ShimElement;
    fetch: FakeFetch;
    handle: ReturnType<typeof openClarifyModal>;
    errorCalls: ErrorCall[];
    onCloseCalls: number;
}

function makeHarness(options: HarnessOptions = {}): Harness {
    const doc = makeShimDocument();
    const parent = makeShimElement('body');
    const fetchFake = makeFakeFetch();
    const errorCalls: ErrorCall[] = [];
    let onCloseCalls = 0;
    const handle = openClarifyModal(
        {
            taskId: options.taskId ?? 'task-1',
            question: options.question ?? 'Which database should we use?',
            choices: 'choices' in options ? options.choices : undefined,
            onClose: () => {
                onCloseCalls++;
                options.onClose?.();
            },
            apiBase: 'http://worker.test',
            onError: (info) => { errorCalls.push(info); },
            ...(options.submitPath !== undefined
                ? { submitPath: options.submitPath }
                : {}),
        },
        { doc, parent, fetch: fetchFake.fn },
    );
    return {
        doc,
        parent,
        fetch: fetchFake,
        handle,
        errorCalls,
        get onCloseCalls() {
            return onCloseCalls;
        },
    } as unknown as Harness;
}

function overlay(h: Harness): ShimElement {
    return h.handle.overlay as unknown as ShimElement;
}

// ---------------------------------------------------------------------------
// AC #1 — renderer (question only)
// ---------------------------------------------------------------------------

test('renders the question, textarea, and submit/cancel buttons (question only)', () => {
    const h = makeHarness();
    const ov = overlay(h);

    // Overlay was mounted under the supplied parent and carries the
    // task id for tests + a11y consumers.
    assert.equal(ov.attributes.get('data-testid'), CLARIFY_OVERLAY_TESTID);
    assert.equal(ov.attributes.get('data-task-id'), 'task-1');
    assert.equal(h.parent.children[0], ov, 'overlay must be mounted under parent');

    const q = byTestId(ov, CLARIFY_QUESTION_TESTID);
    assert.equal(q.textContent, 'Which database should we use?');

    // Free-text textarea is always present, regardless of choices.
    assert.ok(byTestId(ov, CLARIFY_TEXTAREA_TESTID));
    // Submit + Cancel are wired.
    assert.ok(byTestId(ov, CLARIFY_SUBMIT_TESTID));
    assert.ok(byTestId(ov, CLARIFY_CANCEL_TESTID));
    // No choice group rendered when choices were not supplied.
    assert.equal(maybeByTestId(ov, CLARIFY_CHOICES_TESTID), null);
});

test('pre-focuses the textarea on open so keyboard users land in the answer field', () => {
    const h = makeHarness();
    const ta = byTestId(overlay(h), CLARIFY_TEXTAREA_TESTID);
    assert.equal(ta.focusCalls, 1);
});

// ---------------------------------------------------------------------------
// AC #1 — renderer (question + choices)
// ---------------------------------------------------------------------------

test('renders one radio per choice when the agent supplied a string[]', () => {
    const h = makeHarness({ choices: ['Postgres', 'SQLite', 'CockroachDB'] });
    const ov = overlay(h);
    const group = byTestId(ov, CLARIFY_CHOICES_TESTID);
    assert.equal(group.attributes.get('role'), 'radiogroup');
    const radios = findAll(group, (el) => el.tagName === 'input' && el.attributes.get('type') === 'radio');
    assert.equal(radios.length, 3);
    assert.deepEqual(
        radios.map((r) => r.attributes.get('value')),
        ['Postgres', 'SQLite', 'CockroachDB'],
    );
    // Radios are all unchecked at render — operator must opt in.
    for (const r of radios) {
        assert.equal(r.checked, false);
        assert.equal(r.attributes.get('name'), 'clarify-choice');
    }
    // Handle exposes the radios for programmatic interaction.
    assert.equal(h.handle.choiceInputs.length, 3);
});

// ---------------------------------------------------------------------------
// AC #4 — malformed-choices degrade-gracefully
// ---------------------------------------------------------------------------

test('normaliseChoices folds malformed shapes to []', () => {
    assert.deepEqual(normaliseChoices(undefined), []);
    assert.deepEqual(normaliseChoices(null), []);
    // Non-array — including a stringly-typed JSON blob the agent might emit by accident.
    assert.deepEqual(normaliseChoices('Postgres,SQLite'), []);
    assert.deepEqual(normaliseChoices(42), []);
    assert.deepEqual(normaliseChoices({ a: 1 }), []);
    // Array containing a non-string — the whole list is rejected.
    assert.deepEqual(normaliseChoices(['ok', 42, 'also ok']), []);
    // Array of all-whitespace strings collapses to []; valid mix keeps the strings.
    assert.deepEqual(normaliseChoices(['   ', '\t']), []);
    assert.deepEqual(normaliseChoices(['Postgres', '  SQLite  ']), ['Postgres', '  SQLite  ']);
});

test('renders free-text-only when choices is null (malformed payload)', () => {
    const h = makeHarness({ choices: null });
    const ov = overlay(h);
    // No choice group, but the textarea is still there.
    assert.equal(maybeByTestId(ov, CLARIFY_CHOICES_TESTID), null);
    assert.ok(byTestId(ov, CLARIFY_TEXTAREA_TESTID));
    assert.equal(h.handle.choiceInputs.length, 0);
});

test('renders free-text-only when choices is a non-array (malformed payload)', () => {
    const h = makeHarness({ choices: 'Postgres,SQLite' });
    const ov = overlay(h);
    assert.equal(maybeByTestId(ov, CLARIFY_CHOICES_TESTID), null);
    assert.ok(byTestId(ov, CLARIFY_TEXTAREA_TESTID));
    assert.equal(h.handle.choiceInputs.length, 0);
});

test('renders free-text-only when choices contains a non-string (malformed payload)', () => {
    const h = makeHarness({ choices: ['Postgres', 42, 'SQLite'] });
    const ov = overlay(h);
    assert.equal(maybeByTestId(ov, CLARIFY_CHOICES_TESTID), null);
    assert.equal(h.handle.choiceInputs.length, 0);
});

// ---------------------------------------------------------------------------
// AC #2 — Remember-this-decision defaults to unchecked
// ---------------------------------------------------------------------------

test("'Remember this decision' checkbox defaults to unchecked", () => {
    const h = makeHarness();
    const cb = byTestId(overlay(h), CLARIFY_REMEMBER_TESTID);
    assert.equal(cb.attributes.get('type'), 'checkbox');
    assert.equal(cb.checked, false);
    assert.equal(h.handle.rememberCheckbox.checked, false);
});

// ---------------------------------------------------------------------------
// AC #3 — Submit POSTs `{ answer, remember }` and closes on 202
// ---------------------------------------------------------------------------

test('Submit POSTs { answer, remember } to /tasks/:id/clarify and closes on 202', async () => {
    const h = makeHarness({ taskId: 'task-42' });
    h.handle.textarea.value = 'Use Postgres with pooled connections.';
    h.handle.rememberCheckbox.checked = true;

    h.fetch.queue({ ok: true, status: 202 });
    const ok = await h.handle.submit();
    assert.equal(ok, true);

    assert.equal(h.fetch.calls.length, 1);
    const call = h.fetch.calls[0];
    assert.equal(call.method, 'POST');
    assert.equal(call.url, 'http://worker.test/tasks/task-42/clarify');
    assert.equal(call.headers['content-type'], 'application/json');
    assert.deepEqual(call.body, {
        answer: 'Use Postgres with pooled connections.',
        remember: true,
    });

    // Modal was removed on success and onClose fired.
    assert.equal(overlay(h).removed, true);
    assert.equal(h.onCloseCalls, 1);
});

test('submitPath redirects the POST — the decomposer Answer button reuses this modal', async () => {
    // A decomposer question is plan-scoped: there is no task to resume, so
    // the answer goes to /plans/:planId/decomposer-answer. Everything else
    // about answering is identical, which is why the surface is shared
    // rather than forked — and why the default must stay untouched.
    const h = makeHarness({
        taskId: 'plan-abc',
        submitPath: '/plans/plan-abc/decomposer-answer',
    });
    h.handle.textarea.value = 'Stand up a new Billing API.';

    h.fetch.queue({ ok: true, status: 202 });
    assert.equal(await h.handle.submit(), true);

    assert.equal(h.fetch.calls.length, 1);
    assert.equal(
        h.fetch.calls[0].url,
        'http://worker.test/plans/plan-abc/decomposer-answer',
    );
    assert.deepEqual(h.fetch.calls[0].body, {
        answer: 'Stand up a new Billing API.',
        remember: false,
    });
});

test('Submit POSTs remember:false when the operator left the checkbox alone', async () => {
    const h = makeHarness();
    h.handle.textarea.value = 'free-text answer';
    h.fetch.queue({ ok: true, status: 202 });
    await h.handle.submit();
    assert.deepEqual(h.fetch.calls[0].body, {
        answer: 'free-text answer',
        remember: false,
    });
});

test("Submit prefers a selected radio's value when textarea is empty", async () => {
    const h = makeHarness({ choices: ['Postgres', 'SQLite'] });
    h.handle.choiceInputs[1].checked = true;
    h.fetch.queue({ ok: true, status: 202 });
    await h.handle.submit();
    assert.equal(h.fetch.calls.length, 1);
    assert.deepEqual(h.fetch.calls[0].body, { answer: 'SQLite', remember: false });
});

test("Submit prefers textarea content over a selected radio when both are present", async () => {
    const h = makeHarness({ choices: ['Postgres', 'SQLite'] });
    h.handle.choiceInputs[0].checked = true;
    h.handle.textarea.value = '   custom answer  ';
    h.fetch.queue({ ok: true, status: 202 });
    await h.handle.submit();
    // Trimmed textarea wins.
    assert.deepEqual(h.fetch.calls[0].body, { answer: 'custom answer', remember: false });
});

test('Submit refuses to dispatch when neither textarea nor any radio has a value', async () => {
    const h = makeHarness({ choices: ['Postgres', 'SQLite'] });
    const ok = await h.handle.submit();
    assert.equal(ok, false);
    assert.equal(h.fetch.calls.length, 0);
    // Modal stays open; textarea is re-focused so the operator sees where to type.
    assert.equal(overlay(h).removed, false);
    assert.ok((h.handle.textarea as ShimElement).focusCalls >= 2);
});

test('Submit keeps the modal open on a non-2xx response so the operator can retry', async () => {
    const h = makeHarness();
    h.handle.textarea.value = 'answer';
    h.fetch.queue({ ok: false, status: 500 });
    const ok = await h.handle.submit();
    assert.equal(ok, false);
    assert.equal(overlay(h).removed, false);
    assert.equal(h.onCloseCalls, 0);
});

test('Submit keeps the modal open on a network error so the operator can retry', async () => {
    const h = makeHarness();
    h.handle.textarea.value = 'answer';
    h.fetch.queue(new Error('network down'));
    const ok = await h.handle.submit();
    assert.equal(ok, false);
    assert.equal(overlay(h).removed, false);
});

// ---------------------------------------------------------------------------
// AC #5 — Cancel + Escape + backdrop click close without dispatching
// ---------------------------------------------------------------------------

test('Cancel closes the modal and never POSTs', () => {
    const h = makeHarness();
    h.handle.textarea.value = 'would-be answer';
    const cancelBtn = byTestId(overlay(h), CLARIFY_CANCEL_TESTID);
    cancelBtn.onclick?.();
    assert.equal(overlay(h).removed, true);
    assert.equal(h.fetch.calls.length, 0);
    assert.equal(h.onCloseCalls, 1);
});

test('Escape key cancels the modal (no POST, onClose fires)', () => {
    const h = makeHarness();
    h.handle.textarea.value = 'answer';
    const listeners = h.doc.listeners.get('keydown') ?? [];
    assert.equal(listeners.length, 1, 'keydown listener must be registered on open');
    listeners[0]({ key: 'Escape' });
    assert.equal(overlay(h).removed, true);
    assert.equal(h.fetch.calls.length, 0);
    assert.equal(h.onCloseCalls, 1);
    // Listener was torn down on close.
    assert.equal((h.doc.listeners.get('keydown') ?? []).length, 0);
});

test('Non-Escape keys do not close the modal', () => {
    const h = makeHarness();
    const listeners = h.doc.listeners.get('keydown') ?? [];
    listeners[0]({ key: 'Enter' });
    listeners[0]({ key: 'a' });
    assert.equal(overlay(h).removed, false);
    assert.equal(h.onCloseCalls, 0);
});

test('Clicking the overlay backdrop cancels the modal', () => {
    const h = makeHarness();
    const ov = overlay(h);
    // target === overlay simulates the operator clicking the backdrop.
    ov.onclick?.({ target: ov });
    assert.equal(ov.removed, true);
    assert.equal(h.fetch.calls.length, 0);
    assert.equal(h.onCloseCalls, 1);
});

test('Clicking inside the panel does NOT cancel the modal', () => {
    const h = makeHarness();
    const ov = overlay(h);
    const panel = byTestId(ov, 'clarify-panel');
    // target === panel simulates a click inside the panel bubbling up.
    ov.onclick?.({ target: panel });
    assert.equal(ov.removed, false);
    assert.equal(h.onCloseCalls, 0);
});

test('close() is idempotent — calling twice does not double-fire onClose', () => {
    const h = makeHarness();
    h.handle.cancel();
    h.handle.cancel();
    h.handle.close();
    assert.equal(h.onCloseCalls, 1);
});

// ---------------------------------------------------------------------------
// Submit failures are VISIBLE
//
// Field report: "nothing happens when I click submit". Submit used to
// swallow every failure — a non-2xx and a network error each did nothing
// but re-focus the textarea, so a 404 (worker running an older build), a
// 409 (question already answered) and a 500 were indistinguishable from a
// dead button. There was no way for an operator to tell us which one they
// were hitting, and no way for them to act on it.
// ---------------------------------------------------------------------------

test('a non-2xx says so in the modal, quoting the server message', async () => {
    const h = makeHarness();
    h.handle.textarea.value = 'use the billing repo';
    h.fetch.queue({
        ok: false,
        status: 409,
        text: async () => JSON.stringify({
            error: 'answer rejected',
            message: 'no unanswered decomposer question on plan plan-1',
        }),
    });

    assert.equal(await h.handle.submit(), false);

    const err = byTestId(overlay(h), CLARIFY_ERROR_TESTID);
    assert.equal(err.hidden, false, 'the failure line must be shown');
    assert.match(err.textContent ?? '', /HTTP 409/);
    assert.match(
        err.textContent ?? '',
        /no unanswered decomposer question/,
        "the server's own message is what tells the operator to reload rather than retry",
    );
    assert.equal(h.errorCalls.length, 1, 'the host is told, so it can toast');
    assert.equal(h.errorCalls[0].status, 409);
    // Still open, answer intact — retry must not cost a retype.
    assert.equal(overlay(h).removed, false);
    assert.equal(h.handle.textarea.value, 'use the billing repo');
    assert.equal(h.onCloseCalls, 0);
});

test('a 404 names the likely cause — a worker older than the page', async () => {
    const h = makeHarness({ submitPath: '/plans/plan-1/decomposer-answer' });
    h.handle.textarea.value = 'B';
    h.fetch.queue({ ok: false, status: 404, text: async () => '' });

    assert.equal(await h.handle.submit(), false);
    const text = byTestId(overlay(h), CLARIFY_ERROR_TESTID).textContent ?? '';
    assert.match(text, /HTTP 404/);
    assert.match(
        text,
        /older build|restart/i,
        'a bare 404 on a brand-new endpoint is unactionable without the hint',
    );
});

test('a network error says so instead of failing silently', async () => {
    const h = makeHarness();
    h.handle.textarea.value = 'an answer';
    h.fetch.queue(new Error('ECONNREFUSED'));

    assert.equal(await h.handle.submit(), false);
    assert.equal(
        byTestId(overlay(h), CLARIFY_ERROR_TESTID).textContent,
        CLARIFY_NETWORK_ERROR_MESSAGE,
    );
    assert.equal(h.errorCalls.length, 1);
    assert.equal(h.errorCalls[0].status, undefined, 'no status on a request that never landed');
});

test('an empty Submit explains itself rather than just moving the cursor', async () => {
    const h = makeHarness();
    assert.equal(await h.handle.submit(), false);
    assert.equal(h.fetch.calls.length, 0, 'still no dispatch');
    assert.match(
        byTestId(overlay(h), CLARIFY_ERROR_TESTID).textContent ?? '',
        /Type an answer or pick an option/,
    );
});

test('a response with no text() reader still reports the status', async () => {
    // The shim (and any non-fetch port) may not implement text(). The
    // status alone must still reach the operator.
    const h = makeHarness();
    h.handle.textarea.value = 'x';
    h.fetch.queue({ ok: false, status: 500 });

    assert.equal(await h.handle.submit(), false);
    assert.match(byTestId(overlay(h), CLARIFY_ERROR_TESTID).textContent ?? '', /HTTP 500/);
});

test('the error line clears on a retry that succeeds, and the modal closes', async () => {
    const h = makeHarness();
    h.handle.textarea.value = 'an answer';
    h.fetch.queue({ ok: false, status: 500 });
    await h.handle.submit();
    assert.equal(byTestId(overlay(h), CLARIFY_ERROR_TESTID).hidden, false);

    h.fetch.queue({ ok: true, status: 202 });
    assert.equal(await h.handle.submit(), true);
    assert.equal(overlay(h).removed, true);
    assert.equal(h.onCloseCalls, 1);
});

test('the error element is hidden on a freshly opened modal', () => {
    const h = makeHarness();
    assert.equal(byTestId(overlay(h), CLARIFY_ERROR_TESTID).hidden, true);
    assert.equal(byTestId(overlay(h), CLARIFY_ERROR_TESTID).textContent, '');
});
