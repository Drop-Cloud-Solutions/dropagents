/**
 * Chat modal — Phase 1 read-only Q&A surface.
 *
 * The modal owns a session list (left rail) and a message thread
 * (right pane) with an input box at the bottom. New sessions pick the
 * project + workspace repo; conversational memory is delegated to
 * claude-cli's `--resume <id>` mechanism, which the worker-api handles
 * transparently — the modal just sends the user message and renders
 * the assistant reply.
 *
 * No streaming yet (Phase 1.5) — each turn is a single round-trip
 * POST that resolves with the final assistant text. A small "typing"
 * indicator surfaces while the request is in flight.
 */

import { stripProposalBlocks } from '../chat-body';
import { chatStopUrl, isOperatorStop } from '../chat-stop';
import type { OverlayManager } from '../chrome/overlay-manager';

export const CHAT_OVERLAY_ID = 'chat';

/** Wire shape returned by `GET /api/chat/sessions/:id`. */
export interface ChatSession {
    readonly id: string;
    readonly projectId: string;
    readonly repoId: string | null;
    readonly cliSession: string | null;
    readonly cwd: string;
    readonly title: string | null;
    readonly mode: 'read-only' | 'scratch-edit';
    readonly branch: string | null;
    readonly prUrl: string | null;
    readonly prNumber: number | null;
    readonly createdAt: number;
    readonly updatedAt: number;
}

export interface TaskProposal {
    readonly kind: 'task';
    readonly title: string;
    readonly type: string;
    readonly description: string;
}

export interface ProjectUpdateProposal {
    readonly kind: 'project-update';
    readonly description: string;
}

export type TaskActionKind = 'merge' | 'approve' | 'retry' | 'dismiss';

export interface ActionProposal {
    readonly kind: 'action';
    readonly action: TaskActionKind;
    readonly taskId: string;
}

export interface ConfigChangeProposal {
    readonly kind: 'config';
    readonly target: string;
    readonly summary: string;
    readonly body?: string;
    readonly model?: string;
    readonly provider?: string;
}

/**
 * An edit to an EXISTING task — as opposed to {@link TaskProposal}, which
 * creates a new plan. Every field is optional but the parser guarantees at
 * least one is present, so a card always has something to show.
 */
export interface TaskUpdateProposal {
    readonly kind: 'task-update';
    readonly taskId: string;
    readonly title?: string;
    readonly description?: string;
    readonly instructions?: string;
}

/**
 * Re-point a plan at a different repo. `planId` is required here — the
 * main chat window has no scoped plan to fall back to, so the worker's
 * scope fill never runs for it.
 */
export interface PlanRepoProposal {
    readonly kind: 'plan-repo';
    readonly planId?: string;
    readonly repoId: string;
}

/**
 * Proposals that only a SCOPED pane can apply (plan modal / design
 * modal), listed here because the main chat window can still be asked to
 * RENDER them: scoped sessions appear in its session sidebar, so opening
 * a plan or design thread here replays chips of these kinds.
 *
 * They were missing from this union, and the renderer's final `else`
 * assumed {@link ActionProposal} — so `proposal.action.charAt(0)` threw
 * on `undefined` and the TypeError aborted the whole thread render,
 * leaving the operator with a blank conversation. That made the "use the
 * main chat window" workaround fail on exactly the threads it was the
 * workaround for.
 */
export interface PlanUpdateProposal {
    readonly kind: 'plan-update';
    readonly planId?: string;
    readonly summary?: string;
    readonly body?: string;
}

export interface RequirementUpdateProposal {
    readonly kind: 'requirement-update';
    readonly requirementId?: string;
    readonly description?: string;
}

export type Proposal =
    | TaskProposal
    | ProjectUpdateProposal
    | ActionProposal
    | ConfigChangeProposal
    | TaskUpdateProposal
    | PlanRepoProposal
    | PlanUpdateProposal
    | RequirementUpdateProposal;

/** Inline action attached to a `system` progress note (approve/merge). */
export interface NoteAction {
    readonly kind: 'approve' | 'merge';
    readonly taskId: string;
    readonly label: string;
}

export interface ChatMessage {
    readonly seq: number;
    readonly sessionId: string;
    readonly role: 'user' | 'assistant' | 'system';
    readonly body: string;
    readonly createdAt: number;
    /**
     * Server-persisted extras: `proposals` on assistant rows;
     * `action` on system progress notes (the board attaches it so the
     * note renders an Approve / Merge button).
     */
    readonly metadata?: {
        proposals?: Proposal[];
        action?: NoteAction;
    } | null;
}

export interface ChatProject {
    readonly id: string;
    readonly name: string;
}

export interface ChatRepo {
    readonly id: string;
    readonly name: string;
}

/** Arguments handed to the host to turn a task proposal into a plan. */
export interface SubmitBriefArgs {
    readonly sessionId: string;
    readonly projectId: string;
    readonly repoId: string | null;
    readonly proposal: TaskProposal;
}

/** Arguments for applying a project-update proposal. */
export interface UpdateProjectArgs {
    readonly projectId: string;
    readonly proposal: ProjectUpdateProposal;
}

/** Arguments for a task action (progress-note button or action proposal). */
export interface TaskActionArgs {
    readonly action: TaskActionKind;
    readonly taskId: string;
}

/**
 * Module-level handle to the currently-open chat modal so the board's
 * SSE event loop can push pipeline progress into the active thread.
 * Set on open, cleared on close. `notifyChatProgress(sessionId)`
 * triggers a message reload if that session is the one on screen.
 */
let liveChatModal: {
    sessionId: () => string | null;
    reload: () => void;
} | null = null;

export function notifyChatProgress(sessionId: string): void {
    if (liveChatModal && liveChatModal.sessionId() === sessionId) {
        liveChatModal.reload();
    }
}

export interface OpenChatModalOptions {
    readonly overlayManager: OverlayManager;
    readonly listProjects: () => readonly ChatProject[];
    readonly listRepos: () => readonly ChatRepo[];
    readonly currentProjectId: string | null;
    /** API base — same `${WORKER_API_BASE}` the board's sendCommand uses. */
    readonly apiBase: string;
    readonly renderMarkdown?: (text: string) => readonly Node[];
    /**
     * Confirm a task proposal into the real pipeline. The host wires
     * this to a SubmitBrief dispatch (same path the board's New-plan
     * modal uses). Resolves true on success so the card can show a
     * "submitted" state.
     */
    readonly submitBrief: (args: SubmitBriefArgs) => Promise<boolean>;
    /** Apply a project-update proposal (PATCH /api/projects/:id). */
    readonly updateProject: (args: UpdateProjectArgs) => Promise<boolean>;
    /** Apply a confirmed config-change proposal (POST /api/chat/config-apply). */
    readonly applyConfigChange: (args: {
        sessionId: string;
        proposal: ConfigChangeProposal;
    }) => Promise<boolean>;
    /**
     * Run an operator task action (Approve / Merge PR) from a progress
     * note's inline button. Resolves true on success.
     */
    readonly runTaskAction: (args: TaskActionArgs) => Promise<boolean>;
    /**
     * Apply a confirmed edit to an existing task. The host dispatches
     * `EditTask` for title/description and `SetTaskInstructions` for
     * instructions. Resolves true on success.
     */
    readonly updateTask: (args: TaskUpdateArgs) => Promise<boolean>;
    /**
     * Re-point a plan at a different repo (dispatches `SetPlanRepo`).
     * Resolves true on success.
     */
    readonly setPlanRepo: (args: { planId: string; repoId: string }) => Promise<boolean>;
}

/** Arguments for applying a task-update proposal. */
export interface TaskUpdateArgs {
    readonly taskId: string;
    readonly title?: string;
    readonly description?: string;
    readonly instructions?: string;
}

interface State {
    activeSessionId: string | null;
    activeSession: ChatSession | null;
    sessions: ChatSession[];
    messages: ChatMessage[];
    selectedProjectId: string;
    selectedRepoId: string | null;
    /** Surfaced in the thread pane when a session fails to load. */
    loadError: string | null;
    sending: boolean;
    /** Keys (`${seq}:${idx}`) of proposals the operator already confirmed. */
    submittedProposals: Set<string>;
}

export function openChatModal(opts: OpenChatModalOptions): void {
    const root = ensureOverlayRoot();
    const existing = root.querySelector('[data-chat-modal-overlay]');
    if (existing) existing.remove();

    const backdrop = document.createElement('div');
    backdrop.className = 'modal-chrome__overlay';
    backdrop.setAttribute('data-chat-modal-overlay', '');
    backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) close();
    });

    const panel = document.createElement('div');
    panel.className = 'chat-modal modal-chrome';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-labelledby', 'chat-modal-title');

    const header = document.createElement('div');
    header.className = 'modal-chrome__header';
    const title = document.createElement('h3');
    title.id = 'chat-modal-title';
    title.className = 'modal-chrome__title';
    title.textContent = 'Chat';
    header.appendChild(title);
    const closeBtn = document.createElement('button');
    closeBtn.className = 'modal-chrome__close';
    closeBtn.type = 'button';
    closeBtn.textContent = 'Close';
    closeBtn.addEventListener('click', close);
    header.appendChild(closeBtn);
    panel.appendChild(header);

    const body = document.createElement('div');
    body.className = 'chat-modal__body';
    panel.appendChild(body);

    const sidebar = document.createElement('div');
    sidebar.className = 'chat-modal__sidebar';
    body.appendChild(sidebar);

    const thread = document.createElement('div');
    thread.className = 'chat-modal__thread';
    body.appendChild(thread);

    backdrop.appendChild(panel);
    root.appendChild(backdrop);

    try {
        opts.overlayManager.openOverlay(CHAT_OVERLAY_ID, panel);
    } catch {
        // Stale registration — close before opening so subsequent
        // clicks still work even if a previous open path threw.
        opts.overlayManager.closeOverlay(CHAT_OVERLAY_ID);
        opts.overlayManager.openOverlay(CHAT_OVERLAY_ID, panel);
    }

    const state: State = {
        activeSessionId: null,
        activeSession: null,
        sessions: [],
        messages: [],
        selectedProjectId: opts.currentProjectId ?? '',
        selectedRepoId: null,
        loadError: null,
        sending: false,
        submittedProposals: new Set<string>(),
    };

    // Abort controller for the in-flight streaming fetch. Set when a
    // turn starts, cleared when it ends. `stopActiveRun` aborts it AND
    // tells the server to kill the process.
    let activeAbort: AbortController | null = null;

    async function stopActiveRun(): Promise<void> {
        const sid = state.activeSessionId;
        // Abort the local read first so the UI flips back to the input
        // immediately, even if the stop POST is slow.
        if (activeAbort !== null) {
            activeAbort.abort();
            activeAbort = null;
        }
        if (sid !== null) {
            try {
                await fetch(
                    chatStopUrl(opts.apiBase, sid),
                    { method: 'POST' },
                );
            } catch {
                // Best-effort — the abort already tore down our side;
                // the server's disconnect handler also kills the proc.
            }
        }
    }

    function close(): void {
        streamCatchupToken += 1; // cancel any in-flight catch-up poll
        opts.overlayManager.closeOverlay(CHAT_OVERLAY_ID);
        backdrop.remove();
        if (liveChatModal === handleRef) liveChatModal = null;
    }

    // Reload the active session's messages from the server — used by
    // the board's progress hook so pipeline milestones (posted as
    // `system` notes) appear in the open thread. Skips while a turn is
    // streaming so an in-flight assistant message isn't clobbered
    // mid-stream; the next non-streaming reload picks the note up.
    async function reloadActiveMessages(): Promise<void> {
        const id = state.activeSessionId;
        if (id === null || state.sending) return;
        try {
            const res = await fetch(
                `${opts.apiBase}/api/chat/sessions/${encodeURIComponent(id)}`,
            );
            if (!res.ok) return;
            const json = await res.json() as { messages?: ChatMessage[] };
            if (Array.isArray(json.messages)) {
                state.messages = json.messages;
                renderThread();
            }
        } catch {
            // Quiet — a transient reload failure just delays the note.
        }
    }

    const handleRef = {
        sessionId: (): string | null => state.activeSessionId,
        reload: (): void => { void reloadActiveMessages(); },
    };
    liveChatModal = handleRef;

    function renderSidebar(): void {
        sidebar.replaceChildren();

        // New-chat form. Always visible above the session list so the
        // operator can spin up a new conversation without finding a
        // hidden affordance.
        const formBox = document.createElement('div');
        formBox.className = 'chat-modal__new';
        const formTitle = document.createElement('h4');
        formTitle.textContent = 'New chat';
        formBox.appendChild(formTitle);

        const projectSelect = document.createElement('select');
        projectSelect.className = 'chat-modal__select';
        const projects = opts.listProjects();
        for (const p of projects) {
            const opt = document.createElement('option');
            opt.value = p.id;
            opt.textContent = p.name;
            if (p.id === state.selectedProjectId) opt.selected = true;
            projectSelect.appendChild(opt);
        }
        if (state.selectedProjectId === '' && projects.length > 0) {
            state.selectedProjectId = projects[0].id;
            projectSelect.value = state.selectedProjectId;
        }
        projectSelect.addEventListener('change', () => {
            state.selectedProjectId = projectSelect.value;
            void refreshSessions();
        });
        formBox.appendChild(labelled('Project', projectSelect));

        const repoSelect = document.createElement('select');
        repoSelect.className = 'chat-modal__select';
        const noRepoOpt = document.createElement('option');
        noRepoOpt.value = '';
        noRepoOpt.textContent = '(none)';
        repoSelect.appendChild(noRepoOpt);
        for (const r of opts.listRepos()) {
            const opt = document.createElement('option');
            opt.value = r.id;
            opt.textContent = r.name;
            repoSelect.appendChild(opt);
        }
        repoSelect.value = state.selectedRepoId ?? '';
        repoSelect.addEventListener('change', () => {
            state.selectedRepoId = repoSelect.value === '' ? null : repoSelect.value;
        });
        formBox.appendChild(labelled('Repo', repoSelect));

        const startBtn = document.createElement('button');
        startBtn.type = 'button';
        startBtn.className = 'chat-modal__new-btn';
        startBtn.textContent = 'Start chat';
        startBtn.addEventListener('click', () => {
            void createSession();
        });
        formBox.appendChild(startBtn);

        sidebar.appendChild(formBox);

        // Past sessions for the selected project.
        const listTitle = document.createElement('h4');
        listTitle.textContent = 'Recent chats';
        sidebar.appendChild(listTitle);

        const list = document.createElement('ul');
        list.className = 'chat-modal__session-list';
        if (state.sessions.length === 0) {
            const empty = document.createElement('li');
            empty.className = 'chat-modal__empty';
            empty.textContent = '(no chats yet for this project)';
            list.appendChild(empty);
        } else {
            for (const s of state.sessions) {
                const li = document.createElement('li');
                li.className = 'chat-modal__session';
                if (s.id === state.activeSessionId) {
                    li.classList.add('chat-modal__session--active');
                }
                const titleSpan = document.createElement('span');
                titleSpan.className = 'chat-modal__session-title';
                titleSpan.textContent = s.title ?? '(untitled)';
                li.appendChild(titleSpan);
                const meta = document.createElement('span');
                meta.className = 'chat-modal__session-meta';
                meta.textContent = new Date(s.updatedAt).toLocaleString();
                li.appendChild(meta);
                li.addEventListener('click', () => {
                    void loadSession(s.id);
                });
                list.appendChild(li);
            }
        }
        sidebar.appendChild(list);
    }

    function renderProposalCard(
        seq: number,
        idx: number,
        proposal: Proposal,
    ): HTMLElement {
        const key = `${seq}:${idx}`;
        const card = document.createElement('div');
        card.className = 'chat-modal__proposal';
        const submitted = state.submittedProposals.has(key);

        const head = document.createElement('div');
        head.className = 'chat-modal__proposal-head';
        const typeBadge = document.createElement('span');
        typeBadge.className = 'chat-modal__proposal-type';
        const titleEl = document.createElement('span');
        titleEl.className = 'chat-modal__proposal-title';

        let confirmLabel: string;
        let confirmedLabel: string;
        let descText = '';
        /** False for kinds this window cannot apply — card renders buttonless. */
        let confirmable = true;
        if (proposal.kind === 'task') {
            typeBadge.textContent = proposal.type;
            titleEl.textContent = proposal.title;
            descText = proposal.description;
            confirmLabel = 'Create plan & start';
            confirmedLabel = 'Plan created ✓';
        } else if (proposal.kind === 'project-update') {
            typeBadge.textContent = 'project';
            titleEl.textContent = 'Update project description';
            descText = proposal.description;
            confirmLabel = 'Apply update';
            confirmedLabel = 'Applied ✓';
        } else if (proposal.kind === 'config') {
            typeBadge.textContent = 'config';
            titleEl.textContent = `${proposal.target} — ${proposal.summary}`;
            // Show the full replacement content so the operator reviews
            // exactly what will land on disk before confirming.
            descText = proposal.body
                ?? [proposal.model ? `model: ${proposal.model}` : '',
                    proposal.provider ? `provider: ${proposal.provider}` : '']
                    .filter((x) => x.length > 0)
                    .join('\n');
            confirmLabel = 'Apply config change';
            confirmedLabel = 'Applied ✓';
        } else if (proposal.kind === 'plan-repo') {
            typeBadge.textContent = 'repo';
            titleEl.textContent = proposal.repoId.length > 0
                ? `Point plan ${proposal.planId ?? '(unnamed)'} at ${proposal.repoId}`
                : `Clear the target repo on plan ${proposal.planId ?? '(unnamed)'}`;
            descText
                = 'Tasks in this plan that carry no repo of their own will run here.';
            confirmLabel = 'Apply target repo';
            confirmedLabel = 'Applied ✓';
        } else if (proposal.kind === 'task-update') {
            typeBadge.textContent = 'edit';
            titleEl.textContent = `Update ${proposal.taskId}`;
            // Label each field: the operator is confirming a diff, and
            // "Description" vs "Instructions" changes what the agent reads.
            descText = [
                proposal.title ? `Title: ${proposal.title}` : '',
                proposal.description ? `Description:\n${proposal.description}` : '',
                proposal.instructions ? `Instructions:\n${proposal.instructions}` : '',
            ].filter((part) => part.length > 0).join('\n\n');
            confirmLabel = 'Apply task update';
            confirmedLabel = 'Updated ✓';
        } else if (proposal.kind === 'action') {
            const verb = proposal.action.charAt(0).toUpperCase() + proposal.action.slice(1);
            typeBadge.textContent = proposal.action;
            titleEl.textContent = `${verb} ${proposal.taskId}`;
            confirmLabel = proposal.action === 'merge' ? 'Merge PR' : verb;
            confirmedLabel = 'Done ✓';
        } else {
            // A scoped-pane proposal (plan-update / requirement-update) or
            // a kind this build does not know. Render it as INFORMATION
            // with no button: this window has no plan or design in scope
            // to apply it to, and the branch must never assume a shape —
            // reading a field off the wrong kind is what made the whole
            // thread fail to render.
            const kind = (proposal as { kind?: unknown }).kind;
            typeBadge.textContent = typeof kind === 'string' ? kind : 'proposal';
            titleEl.textContent = 'Open the plan or design to apply this';
            descText = summariseForeignProposal(proposal);
            confirmable = false;
            // Never shown (the card returns before its button), but the
            // compiler cannot correlate them with `confirmable`.
            confirmLabel = '';
            confirmedLabel = '';
        }
        head.appendChild(typeBadge);
        head.appendChild(titleEl);
        card.appendChild(head);

        if (descText.length > 0) {
            const desc = document.createElement('div');
            desc.className = 'chat-modal__proposal-desc';
            desc.textContent = descText;
            card.appendChild(desc);
        }

        if (!confirmable) return card;

        const actions = document.createElement('div');
        actions.className = 'chat-modal__proposal-actions';
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'chat-modal__proposal-btn';
        btn.textContent = submitted ? confirmedLabel : confirmLabel;
        btn.disabled = submitted;
        btn.addEventListener('click', () => {
            void confirmProposal(key, proposal, btn, confirmLabel, confirmedLabel);
        });
        actions.appendChild(btn);
        card.appendChild(actions);
        return card;
    }

    /**
     * Body text for a proposal this window cannot apply. Reads only
     * optional fields, defensively — the caller has already established
     * that it does NOT know this shape.
     */
    function summariseForeignProposal(proposal: Proposal): string {
        const p = proposal as unknown as Record<string, unknown>;
        for (const field of ['summary', 'description', 'body', 'title']) {
            const v = p[field];
            if (typeof v === 'string' && v.trim().length > 0) return v;
        }
        return '';
    }

    async function confirmProposal(
        key: string,
        proposal: Proposal,
        btn: HTMLButtonElement,
        confirmLabel: string,
        confirmedLabel: string,
    ): Promise<void> {
        if (state.activeSession === null) return;
        btn.disabled = true;
        btn.textContent = 'Working…';
        let ok = false;
        try {
            if (proposal.kind === 'task') {
                ok = await opts.submitBrief({
                    sessionId: state.activeSession.id,
                    projectId: state.activeSession.projectId,
                    repoId: state.activeSession.repoId,
                    proposal,
                });
            } else if (proposal.kind === 'project-update') {
                ok = await opts.updateProject({
                    projectId: state.activeSession.projectId,
                    proposal,
                });
            } else if (proposal.kind === 'config') {
                ok = await opts.applyConfigChange({
                    sessionId: state.activeSession.id,
                    proposal,
                });
            } else if (proposal.kind === 'plan-repo') {
                // No plan id means the model never named one and there is
                // no scope to fill it from. Refuse rather than guessing
                // which plan the operator meant.
                ok = typeof proposal.planId === 'string' && proposal.planId.length > 0
                    ? await opts.setPlanRepo({
                        planId: proposal.planId,
                        repoId: proposal.repoId,
                    })
                    : false;
            } else if (proposal.kind === 'task-update') {
                ok = await opts.updateTask({
                    taskId: proposal.taskId,
                    ...(proposal.title !== undefined ? { title: proposal.title } : {}),
                    ...(proposal.description !== undefined
                        ? { description: proposal.description }
                        : {}),
                    ...(proposal.instructions !== undefined
                        ? { instructions: proposal.instructions }
                        : {}),
                });
            } else if (proposal.kind === 'action') {
                ok = await opts.runTaskAction({
                    action: proposal.action,
                    taskId: proposal.taskId,
                });
            } else {
                // Scoped-only kind. renderProposalCard gives these no
                // button, so this is unreachable through the UI — it is
                // here so the branch cannot silently read `action` off a
                // shape that has none, which is exactly how the renderer
                // came to throw.
                ok = false;
            }
        } catch {
            ok = false;
        }
        if (ok) {
            state.submittedProposals.add(key);
            btn.textContent = confirmedLabel;
        } else {
            btn.disabled = false;
            btn.textContent = confirmLabel;
        }
        renderThread();
    }

    async function runNoteAction(
        seq: number,
        action: NoteAction,
        btn: HTMLButtonElement,
    ): Promise<void> {
        btn.disabled = true;
        btn.textContent = 'Working…';
        let ok = false;
        try {
            ok = await opts.runTaskAction({
                action: action.kind,
                taskId: action.taskId,
            });
        } catch {
            ok = false;
        }
        if (ok) {
            // Mark consumed so the button doesn't re-render on the next
            // progress reload. Reuse the submittedProposals set with a
            // `note:` prefix to avoid a second state field.
            state.submittedProposals.add(`note:${seq}`);
        } else {
            btn.disabled = false;
            btn.textContent = action.label;
        }
        renderThread();
    }

    function renderThread(): void {
        thread.replaceChildren();

        if (state.activeSessionId === null) {
            const blank = document.createElement('div');
            blank.className = 'chat-modal__blank';
            blank.textContent = 'Pick a chat from the left, or start a new one.';
            thread.appendChild(blank);
            return;
        }

        // A load failure gets SAID, not swallowed into an empty pane.
        if (state.loadError !== null) {
            const err = document.createElement('div');
            err.className = 'chat-modal__blank';
            err.textContent = state.loadError;
            thread.appendChild(err);
            return;
        }

        const messages = document.createElement('div');
        messages.className = 'chat-modal__messages';
        for (const msg of state.messages) {
            // System notes (pipeline progress posted by the board) read
            // as a centred status line, not a chat bubble. When the note
            // carries an `action` (a task ready to approve/merge), it
            // also renders an inline button that runs that operator
            // action without leaving the chat.
            if (msg.role === 'system') {
                const note = document.createElement('div');
                note.className = 'chat-modal__note';
                const text = document.createElement('span');
                text.textContent = msg.body;
                note.appendChild(text);
                const action = msg.metadata?.action;
                if (action && !state.submittedProposals.has(`note:${msg.seq}`)) {
                    const actBtn = document.createElement('button');
                    actBtn.type = 'button';
                    actBtn.className = 'chat-modal__note-action';
                    actBtn.textContent = action.label;
                    actBtn.addEventListener('click', () => {
                        void runNoteAction(msg.seq, action, actBtn);
                    });
                    note.appendChild(actBtn);
                }
                messages.appendChild(note);
                continue;
            }
            const row = document.createElement('div');
            row.className = `chat-modal__message chat-modal__message--${msg.role}`;
            const roleLabel = document.createElement('div');
            roleLabel.className = 'chat-modal__role';
            roleLabel.textContent = msg.role === 'user' ? 'You' : 'Claude';
            row.appendChild(roleLabel);
            const bodyEl = document.createElement('div');
            bodyEl.className = 'chat-modal__body-text';
            // Empty assistant body during streaming → show a thinking
            // indicator so the operator knows the spawn succeeded and
            // the first chunk just hasn't landed yet. Once the first
            // chunk arrives the body is non-empty and renders normally.
            // Proposal blocks get their own card below — rendering them
            // as prose as well delivered every proposed task twice: the
            // full Description as text, then a card repeating it with the
            // button. Assistant text only; an operator who literally typed
            // a PROPOSE_ block should see what they typed.
            const shownBody = msg.role === 'assistant'
                ? stripProposalBlocks(msg.body)
                : msg.body;
            if (msg.role === 'assistant' && msg.body.length === 0) {
                row.classList.add('chat-modal__message--pending');
                bodyEl.textContent = 'Thinking…';
                row.appendChild(bodyEl);
            } else if (shownBody.length === 0) {
                // The whole reply was the proposal. The card says it all.
            } else if (opts.renderMarkdown && msg.role === 'assistant') {
                for (const node of opts.renderMarkdown(shownBody)) {
                    bodyEl.appendChild(node);
                }
                row.appendChild(bodyEl);
            } else {
                bodyEl.textContent = shownBody;
                row.appendChild(bodyEl);
            }

            // Proposal cards — one per PROPOSE_TASK block the agent
            // emitted. Each carries a "Create plan & start" button that
            // confirms the proposal into the real pipeline.
            const proposals = msg.metadata?.proposals;
            if (Array.isArray(proposals) && proposals.length > 0) {
                proposals.forEach((proposal, idx) => {
                    row.appendChild(renderProposalCard(msg.seq, idx, proposal));
                });
            }
            messages.appendChild(row);
        }
        thread.appendChild(messages);

        const inputRow = document.createElement('form');
        inputRow.className = 'chat-modal__input-row';
        const textarea = document.createElement('textarea');
        textarea.className = 'chat-modal__input';
        // Ten rows on open: the operator's asks here are usually a
        // paragraph or a pasted error, not one line, and a 3-row box made
        // them compose through a keyhole. The CSS keeps `resize: vertical`
        // so it can still be dragged either way.
        textarea.rows = 10;
        textarea.placeholder = state.sending
            ? 'Waiting on Claude…'
            : 'Ask Claude about the code…';
        textarea.disabled = state.sending;
        // Enter sends (Shift+Enter inserts a newline; Ctrl/Cmd+Enter still
        // works for muscle memory). The Send button stays alongside.
        textarea.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send(textarea.value);
            }
        });
        if (state.sending) {
            // While a turn is in flight the Send button becomes Stop —
            // clicking it tells the server to kill the claude process
            // and aborts the local stream read so the UI updates
            // immediately.
            const stopBtn = document.createElement('button');
            stopBtn.type = 'button';
            stopBtn.className = 'chat-modal__send-btn chat-modal__stop-btn';
            stopBtn.textContent = 'Stop';
            stopBtn.addEventListener('click', () => {
                void stopActiveRun();
            });
            inputRow.appendChild(textarea);
            inputRow.appendChild(stopBtn);
        } else {
            const submitBtn = document.createElement('button');
            submitBtn.type = 'submit';
            submitBtn.className = 'chat-modal__send-btn';
            submitBtn.textContent = 'Send';
            inputRow.addEventListener('submit', (e) => {
                e.preventDefault();
                void send(textarea.value);
            });
            inputRow.appendChild(textarea);
            inputRow.appendChild(submitBtn);
        }
        thread.appendChild(inputRow);

        // Scroll to bottom after rendering so the latest exchange is
        // visible without manual scrolling. queueMicrotask defers until
        // layout finishes.
        queueMicrotask(() => {
            messages.scrollTop = messages.scrollHeight;
        });
    }

    function rerender(): void {
        renderSidebar();
        renderThread();
    }

    async function refreshSessions(): Promise<void> {
        if (state.selectedProjectId === '') {
            state.sessions = [];
            renderSidebar();
            return;
        }
        try {
            const url = `${opts.apiBase}/api/chat/sessions?projectId=${encodeURIComponent(state.selectedProjectId)}`;
            const res = await fetch(url);
            if (!res.ok) {
                state.sessions = [];
                renderSidebar();
                return;
            }
            const json = await res.json() as { sessions?: ChatSession[] };
            state.sessions = Array.isArray(json.sessions) ? json.sessions : [];
        } catch {
            state.sessions = [];
        }
        renderSidebar();
        // Nothing selected yet (modal just opened / project switched):
        // open the most recent session by default instead of an empty
        // pane — sessions come back updated_at DESC, so [0] is the one
        // the operator most likely wants back (e.g. the chat they closed
        // mid-response).
        if (state.activeSessionId === null && state.sessions.length > 0) {
            void loadSession(state.sessions[0].id);
        }
    }

    async function loadSession(id: string): Promise<void> {
        try {
            const res = await fetch(`${opts.apiBase}/api/chat/sessions/${encodeURIComponent(id)}`);
            if (!res.ok) {
                // Never silent: a failed load used to leave the pane blank
                // with no explanation, so a 404 read as "the board is
                // broken" (field case: Telegram-seeded sessions 404'd on
                // an encoding bug and clicking them did nothing).
                state.activeSessionId = id;
                state.activeSession = null;
                state.messages = [];
                state.loadError = `Could not open this chat (HTTP ${res.status}).`;
                rerender();
                return;
            }
            state.loadError = null;
            const json = await res.json() as {
                session?: ChatSession;
                messages?: ChatMessage[];
                streaming?: boolean;
            };
            if (!json.session) return;
            state.activeSessionId = json.session.id;
            state.activeSession = json.session;
            state.messages = Array.isArray(json.messages) ? json.messages : [];
            state.loadError = null;
            // A turn is in flight server-side (this modal was reopened
            // mid-response). The reply only persists when the turn ends,
            // so show the working state and poll until it lands — without
            // this the thread silently never updates (field incident).
            if (json.streaming === true) {
                state.sending = true;
                startStreamCatchup(id);
            } else {
                state.sending = false;
            }
            rerender();
        } catch (err) {
            state.loadError = `Could not open this chat: ${
                err instanceof Error ? err.message : String(err)
            }`;
            rerender();
        }
    }

    // Poll an in-flight session until its turn completes, then show the
    // persisted reply. Token-guarded so switching sessions (or a new
    // catch-up) cancels the previous loop.
    let streamCatchupToken = 0;
    function startStreamCatchup(id: string): void {
        const token = ++streamCatchupToken;
        const poll = async (): Promise<void> => {
            await new Promise((r) => setTimeout(r, 2000));
            if (token !== streamCatchupToken || state.activeSessionId !== id) return;
            try {
                const res = await fetch(
                    `${opts.apiBase}/api/chat/sessions/${encodeURIComponent(id)}`,
                );
                if (res.ok) {
                    const json = await res.json() as {
                        messages?: ChatMessage[];
                        streaming?: boolean;
                    };
                    if (token !== streamCatchupToken || state.activeSessionId !== id) return;
                    if (json.streaming !== true) {
                        state.messages = Array.isArray(json.messages) ? json.messages : [];
                        state.sending = false;
                        rerender();
                        return;
                    }
                }
            } catch {
                // Transient — keep polling.
            }
            void poll();
        };
        void poll();
    }

    async function createSession(): Promise<void> {
        if (state.selectedProjectId === '') return;
        try {
            const res = await fetch(`${opts.apiBase}/api/chat/sessions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    projectId: state.selectedProjectId,
                    ...(state.selectedRepoId !== null
                        ? { repoId: state.selectedRepoId }
                        : {}),
                }),
            });
            if (!res.ok) {
                const detail = await res.text().catch(() => '');
                // eslint-disable-next-line no-alert
                window.alert(`Could not start chat: ${detail || res.status}`);
                return;
            }
            const json = await res.json() as { session?: ChatSession };
            if (!json.session) return;
            state.activeSessionId = json.session.id;
            state.activeSession = json.session;
            state.messages = [];
            await refreshSessions();
            rerender();
        } catch (err) {
            // eslint-disable-next-line no-alert
            window.alert(`Could not start chat: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    async function send(content: string): Promise<void> {
        const trimmed = content.trim();
        if (trimmed.length === 0 || state.activeSessionId === null) return;
        const sessionAtSend = state.activeSessionId;
        // Optimistic user message render.
        state.messages = [
            ...state.messages,
            {
                seq: -Date.now(),
                sessionId: sessionAtSend,
                role: 'user',
                body: trimmed,
                createdAt: Date.now(),
            },
        ];
        // Insert a placeholder assistant message that grows as chunks
        // arrive. Negative seq keeps it distinguishable from server
        // rows until the final `done` frame replaces it.
        const pendingSeq = -Date.now() - 1;
        const pending: ChatMessage = {
            seq: pendingSeq,
            sessionId: sessionAtSend,
            role: 'assistant',
            body: '',
            createdAt: Date.now(),
        };
        state.messages.push(pending);
        state.sending = true;
        renderThread();

        const abort = new AbortController();
        activeAbort = abort;
        let errored = false;
        try {
            const res = await fetch(
                `${opts.apiBase}/api/chat/sessions/${encodeURIComponent(sessionAtSend)}/messages`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ content: trimmed }),
                    signal: abort.signal,
                },
            );
            const contentType = res.headers.get('Content-Type') ?? '';
            if (!res.ok) {
                const detail = await res.text().catch(() => '');
                replacePending(`(error: ${detail || res.status})`);
                errored = true;
            } else if (contentType.includes('application/json')) {
                // Server fell back to buffered (test harness path).
                const json = await res.json() as { message?: ChatMessage };
                if (json.message) replacePendingWithMessage(json.message);
            } else {
                // Streaming NDJSON. Read the body as chunks, split on
                // newline, dispatch each frame.
                const reader = res.body?.getReader();
                if (!reader) {
                    replacePending('(error: streaming unsupported by this browser)');
                    errored = true;
                } else {
                    const decoder = new TextDecoder();
                    let buffer = '';
                    let liveText = '';
                    let finalMessage: ChatMessage | null = null;
                    while (true) {
                        const { value, done } = await reader.read();
                        if (done) break;
                        buffer += decoder.decode(value, { stream: true });
                        let nl = buffer.indexOf('\n');
                        while (nl >= 0) {
                            const line = buffer.slice(0, nl).trim();
                            buffer = buffer.slice(nl + 1);
                            if (line.length > 0) {
                                const dispatch = dispatchFrame(line, liveText);
                                if (dispatch !== null) {
                                    if (dispatch.kind === 'chunk') {
                                        liveText = dispatch.liveText;
                                    } else if (dispatch.kind === 'done') {
                                        finalMessage = dispatch.message;
                                    } else if (dispatch.kind === 'error') {
                                        replacePending(`(error: ${dispatch.message})`);
                                        errored = true;
                                    }
                                }
                            }
                            nl = buffer.indexOf('\n');
                        }
                    }
                    if (!errored) {
                        if (finalMessage !== null) {
                            replacePendingWithMessage(finalMessage);
                        } else if (liveText.length > 0) {
                            // No `done` frame arrived but we got some
                            // assistant text — keep what we showed.
                            replacePending(liveText);
                        }
                    }
                }
            }
        } catch (err) {
            // An AbortError is the operator clicking Stop — not a
            // failure. Mark the pending message stopped (keep whatever
            // streamed so far) rather than overwriting it with an error.
            const isAbort = isOperatorStop(err);
            if (isAbort) {
                markPendingStopped();
            } else {
                replacePending(`(error: ${err instanceof Error ? err.message : String(err)})`);
                errored = true;
            }
        }
        if (activeAbort === abort) activeAbort = null;
        state.sending = false;
        renderThread();
        // The session list's updated_at changes once the assistant
        // replies — refresh so the active chat moves to the top.
        void refreshSessions();

        function markPendingStopped(): void {
            const idx = state.messages.findIndex((m) => m.seq === pendingSeq);
            if (idx < 0) return;
            const current = state.messages[idx].body;
            state.messages[idx] = {
                ...state.messages[idx],
                body: current.length > 0
                    ? `${current}\n\n_(stopped)_`
                    : '_(stopped)_',
            };
            renderThread();
        }

        function replacePending(text: string): void {
            const idx = state.messages.findIndex((m) => m.seq === pendingSeq);
            if (idx >= 0) {
                state.messages[idx] = { ...state.messages[idx], body: text };
            }
            renderThread();
        }
        function replacePendingWithMessage(msg: ChatMessage): void {
            const idx = state.messages.findIndex((m) => m.seq === pendingSeq);
            if (idx >= 0) state.messages[idx] = msg;
            renderThread();
        }
        function dispatchFrame(
            line: string,
            liveText: string,
        ): { kind: 'chunk'; liveText: string }
        | { kind: 'done'; message: ChatMessage }
        | { kind: 'error'; message: string }
        | null {
            let parsed: Record<string, unknown>;
            try {
                parsed = JSON.parse(line) as Record<string, unknown>;
            } catch {
                return null;
            }
            const type = parsed.type;
            if (type === 'chunk' && typeof parsed.text === 'string') {
                const next = liveText + parsed.text;
                replacePending(next);
                return { kind: 'chunk', liveText: next };
            }
            if (type === 'done' && parsed.message
                && typeof parsed.message === 'object') {
                return { kind: 'done', message: parsed.message as ChatMessage };
            }
            if (type === 'error') {
                const msg = typeof parsed.message === 'string' && parsed.message.length > 0
                    ? parsed.message
                    : 'unknown error';
                return { kind: 'error', message: msg };
            }
            return null;
        }
    }

    rerender();
    void refreshSessions();
}

function labelled(label: string, control: HTMLElement): HTMLElement {
    const wrap = document.createElement('label');
    wrap.className = 'chat-modal__field';
    const span = document.createElement('span');
    span.className = 'chat-modal__field-label';
    span.textContent = label;
    wrap.appendChild(span);
    wrap.appendChild(control);
    return wrap;
}

function ensureOverlayRoot(): HTMLElement {
    let root = document.getElementById('overlay-root');
    if (!root) {
        root = document.createElement('div');
        root.id = 'overlay-root';
        document.body.appendChild(root);
    }
    return root;
}
