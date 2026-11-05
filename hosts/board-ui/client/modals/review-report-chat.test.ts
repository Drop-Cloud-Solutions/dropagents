/**
 * Chatting with an investigation / review report.
 *
 * The operator asked for what plans and architecture designs already
 * have: a conversation pinned to the artifact on screen. A report is the
 * case where it matters most — it is the end of a task, and the only
 * thing to DO with a finding is turn it into work.
 *
 * The load-bearing property here is that the pane SURVIVES a state
 * transition. This modal re-renders its whole body on dismiss/implement
 * (`panel.replaceChildren(view)`), so a pane mounted inside that body
 * would be rebuilt mid-conversation: thread gone, streaming read
 * orphaned, agent still running with nobody listening. The pane is held
 * in the closure and RE-ATTACHED by the renderer instead.
 *
 * Trait category: Unit — no jsdom, no network. The renderer runs against
 * a hand-rolled ModalDocument shim, matching create-task.test.ts.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import {
    createReviewReportModal,
    type ModalDocument,
    type ModalElement,
    type ReviewReportChatContext,
} from './review-report';

// --- document shim ---------------------------------------------------

interface FakeElement extends ModalElement {
    readonly tag: string;
    readonly attrs: Map<string, string>;
    readonly children: FakeElement[];
    parent: FakeElement | null;
    onclick?: () => void;
}

function makeDoc(): { doc: ModalDocument; root: FakeElement } {
    const create = (tag: string): FakeElement => {
        const el: FakeElement = {
            tag,
            className: '',
            textContent: '',
            attrs: new Map(),
            children: [],
            parent: null,
            setAttribute(name, value) { el.attrs.set(name, value); },
            appendChild(child) {
                const c = child as FakeElement;
                c.parent = el;
                el.children.push(c);
                return child;
            },
            replaceChildren(...children) {
                for (const c of el.children) c.parent = null;
                el.children.length = 0;
                for (const c of children) {
                    const f = c as FakeElement;
                    f.parent = el;
                    el.children.push(f);
                }
            },
            remove() {
                const p = el.parent;
                if (!p) return;
                const i = p.children.indexOf(el);
                if (i >= 0) p.children.splice(i, 1);
                el.parent = null;
            },
        };
        return el;
    };
    const root = create('div');
    return {
        root,
        doc: {
            createElement: create,
            getElementById: () => root,
        },
    };
}

function descendants(el: FakeElement): FakeElement[] {
    return el.children.flatMap((c) => [c, ...descendants(c)]);
}

function findByAction(root: FakeElement, action: string): FakeElement | undefined {
    return descendants(root).find((e) => e.attrs.get('data-action') === action);
}

// --- harness ---------------------------------------------------------

function harness(opts: { withChat?: boolean } = {}) {
    const { doc, root } = makeDoc();
    const mounts: ReviewReportChatContext[] = [];
    let destroys = 0;
    const modal = createReviewReportModal({
        overlayManager: { openOverlay: () => undefined, closeOverlay: () => undefined },
        commands: {
            dismissReport: async () => undefined,
            implementReport: async () => undefined,
        },
        showToast: () => undefined,
        doc,
        ...(opts.withChat === false ? {} : {
            mountChat: (_container, ctx) => {
                mounts.push(ctx);
                return { destroy: () => { destroys += 1; } };
            },
        }),
    });
    return {
        modal,
        root,
        mounts,
        destroyCount: (): number => destroys,
        panel: (): FakeElement => root.children[0]!,
    };
}

const REPORT = {
    taskId: 'L-ABCD-001',
    reportId: '42',
    content: '# Findings\nThe cache key omits the tenant id.',
    title: 'Review report — L-ABCD-001',
    projectId: 'webshop',
};

// --- the button ------------------------------------------------------

test('a report with a project offers a Chat button', () => {
    const h = harness();
    h.modal.open(REPORT);
    assert.ok(findByAction(h.panel(), 'chat'), 'Chat button rendered');
});

test('a placeholder report offers NO chat', () => {
    // `task:<id>` means nothing was ever recorded. Its scope context
    // resolves to nothing server-side, so the agent would answer about
    // the project at large while appearing to read the report on screen.
    const h = harness();
    h.modal.open({ ...REPORT, reportId: `task:${REPORT.taskId}` });
    assert.equal(findByAction(h.panel(), 'chat'), undefined);
    // …and the same gate still hides Implement/Dismiss.
    assert.equal(findByAction(h.panel(), 'implement'), undefined);
});

test('a report with no resolvable project offers NO chat', () => {
    // A chat session cannot be created without one. Better no button
    // than one that 400s after the click.
    const h = harness();
    const { projectId: _drop, ...noProject } = REPORT;
    h.modal.open(noProject);
    assert.equal(findByAction(h.panel(), 'chat'), undefined);
});

test('a host that wires no chat seam gets no button', () => {
    const h = harness({ withChat: false });
    h.modal.open(REPORT);
    assert.equal(findByAction(h.panel(), 'chat'), undefined);
});

// --- mounting --------------------------------------------------------

test('clicking Chat mounts a pane scoped to the report task', () => {
    const h = harness();
    h.modal.open(REPORT);
    findByAction(h.panel(), 'chat')!.onclick!();

    assert.equal(h.mounts.length, 1);
    assert.equal(h.mounts[0]!.taskId, 'L-ABCD-001', 'scoped to the TASK, not the reportId');
    assert.equal(h.mounts[0]!.projectId, 'webshop');
    assert.ok(
        descendants(h.panel()).some((e) => e.className === 'rr-chat-pane'),
        'pane in the panel',
    );
    assert.match(h.panel().className, /review-report-modal--split/);
});

test('clicking Chat again tears the pane down', () => {
    const h = harness();
    h.modal.open(REPORT);
    const btn = findByAction(h.panel(), 'chat')!;
    btn.onclick!();
    btn.onclick!();

    assert.equal(h.destroyCount(), 1, 'the pane was destroyed, not just hidden');
    assert.equal(
        descendants(h.panel()).filter((e) => e.className === 'rr-chat-pane').length,
        0,
    );
    assert.doesNotMatch(h.panel().className, /--split/, 'split layout reverted');
});

// --- the load-bearing property ---------------------------------------

test('the pane SURVIVES a dismiss/implement re-render', async () => {
    // The body is rebuilt on every state transition. A pane rebuilt with
    // it would drop the operator's thread and leave the agent running
    // with nobody reading it.
    const h = harness();
    h.modal.open(REPORT);
    findByAction(h.panel(), 'chat')!.onclick!();
    const paneBefore = descendants(h.panel()).find((e) => e.className === 'rr-chat-pane');

    await h.modal.dismiss({ reason: 'not now' });

    const paneAfter = descendants(h.panel()).find((e) => e.className === 'rr-chat-pane');
    assert.ok(paneAfter, 'pane still attached after the transition');
    assert.equal(paneAfter, paneBefore, 'the SAME node — re-attached, not rebuilt');
    assert.equal(h.destroyCount(), 0, 'never torn down');
    assert.equal(h.mounts.length, 1, 'never re-mounted');
});

test('closing the modal destroys the pane', () => {
    // Otherwise the stream keeps reading and the worker keeps a `claude`
    // process alive for a modal that is gone.
    const h = harness();
    h.modal.open(REPORT);
    findByAction(h.panel(), 'chat')!.onclick!();
    h.modal.close();
    assert.equal(h.destroyCount(), 1);
});

test('re-opening the modal starts without a pane', () => {
    const h = harness();
    h.modal.open(REPORT);
    findByAction(h.panel(), 'chat')!.onclick!();
    h.modal.open({ ...REPORT, taskId: 'L-WXYZ-009' });

    assert.equal(h.destroyCount(), 1, 'previous pane torn down');
    assert.equal(
        descendants(h.panel()).filter((e) => e.className === 'rr-chat-pane').length,
        0,
    );
    // And the new report's chat is scoped to the NEW task.
    findByAction(h.panel(), 'chat')!.onclick!();
    assert.equal(h.mounts[1]!.taskId, 'L-WXYZ-009');
});

test('a pane that fails to mount leaves no half-open split', () => {
    // A split layout with an empty column and no way back is worse than
    // the error.
    const { doc, root } = makeDoc();
    const modal = createReviewReportModal({
        overlayManager: { openOverlay: () => undefined, closeOverlay: () => undefined },
        commands: {
            dismissReport: async () => undefined,
            implementReport: async () => undefined,
        },
        showToast: () => undefined,
        doc,
        mountChat: () => { throw new Error('worker unreachable'); },
    });
    modal.open(REPORT);
    const panel = root.children[0]! as FakeElement;
    findByAction(panel, 'chat')!.onclick!();

    assert.equal(
        descendants(panel).filter((e) => e.className === 'rr-chat-pane').length,
        0,
        'pane removed',
    );
    assert.doesNotMatch(panel.className, /--split/);
});
