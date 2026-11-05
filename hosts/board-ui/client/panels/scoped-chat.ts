/**
 * Scoped chat pane — the right-hand side of the plan / design / report
 * split view. A lean, mountable chat surface bound to ONE artifact-scoped
 * session: thread, composer, NDJSON streaming, and confirm chips for the
 * scoped proposal kinds. Deliberately NOT the full chat modal (no session
 * sidebar, no project/repo pickers) — the scope pins all of that.
 *
 * The host passes `sendCommand` so a confirmed proposal dispatches the
 * same commands the board's own buttons use:
 *   plan-update        → RecordPlanRevision (new plan revision, folds live)
 *   requirement-update → UpdateRequirement
 *   task               → CreateTask into the scoped plan (approval-gated)
 *   task-update        → EditTask / SetTaskInstructions
 *   plan-repo          → SetPlanRepo
 * Everything else renders as information with a "use the main chat" note.
 *
 * Which of those a given scope offers is {@link describeProposalChip} —
 * pure, and the one part of this module worth testing directly, since
 * every other path to it runs through a live session.
 *
 * `createPlan` is the second host seam, and it exists because creating a
 * plan is NOT a command: it is CreatePlan plus a session link plus a
 * GeneratePlan POST (board.ts `submitChatProposal`). Without it a task
 * proposal could only ever be added to an already-open plan, so a design
 * chat — which has no plan to add to — rendered every proposal as a dead
 * chip reading "confirm it from the main chat window". The operator had
 * to re-ask the question in a thread that had none of the context, which
 * is the opposite of what a scoped chat is for.
 */

import { stripProposalBlocks } from '../chat-body';
import { chatStopUrl, isOperatorStop } from '../chat-stop';

/** What a scoped pane is pinned to. `report` scopes to the task that produced it. */
export type ScopedChatScopeKind = 'plan' | 'requirement' | 'report';

/**
 * The fields `createPlan` needs off a task proposal. Structural rather
 * than the full proposal so the host callback cannot quietly start
 * depending on parser internals.
 */
export interface ScopedPlanProposal {
    readonly title: string;
    readonly type: string;
    readonly description: string;
    readonly projectId?: string;
    readonly repoId?: string;
}

export interface ScopedChatOptions {
    readonly apiBase: string;
    readonly scopeKind: ScopedChatScopeKind;
    readonly scopeId: string;
    readonly projectId: string;
    readonly repoId: string | null;
    readonly title: string;
    readonly sendCommand: (command: {
        type: string;
        actor: string;
        issuedAt: number;
        payload: Record<string, unknown>;
    }) => Promise<void>;
    /**
     * Create a plan from a task proposal and run the planner.
     *
     * Resolves `true` when the plan was created. `false` means the host
     * already told the operator why it failed (it toasts), so the chip
     * resets its button WITHOUT a second error message.
     *
     * Optional: a host that does not supply it gets the old behaviour —
     * the chip says so rather than offering a button that does nothing.
     */
    readonly createPlan?: (args: {
        sessionId: string;
        proposal: ScopedPlanProposal;
    }) => Promise<boolean>;
    readonly onError: (message: string) => void;
}

interface PaneProposal {
    readonly kind: string;
    readonly [key: string]: unknown;
}

/**
 * Build the `CreateTask` payload for a task proposal confirmed in a
 * plan-scoped pane.
 *
 * Exported for tests: this pane's confirm handler is otherwise only
 * reachable through a real DOM, and the bug it exists to prevent was a
 * MISSING field — invisible in every rendering of the chip and only
 * observable in the dispatched command.
 *
 * `Repo:` on the proposal targets a repo other than the plan's. Dropping
 * it left `tasks.repo_id` unset, so per-task worktree resolution fell
 * back to the plan's `metadata.targetRepo` and the task ran against the
 * plan's repo instead — silently, because the confirm chip never showed
 * a target either way.
 *
 * Absent repo means OMIT the key, not send an empty one: the fallback to
 * the plan's repo is correct when the agent did not name one, and `''`
 * would defeat the `typeof … && length > 0` guard the handler uses.
 */
export function buildScopedTaskCommandPayload(
    proposal: PaneProposal,
    planId: string,
): Record<string, unknown> {
    const type = String(proposal.type ?? 'investigate');
    const repoId = scopedProposalRepo(proposal);
    return {
        planId,
        taskType: type,
        flowId: type,
        title: String(proposal.title ?? ''),
        description: String(proposal.description ?? ''),
        ...(repoId !== null ? { repoId } : {}),
    };
}

/**
 * Narrow a task proposal to the fields the plan-creating host callback
 * reads.
 *
 * `Project:` and `Repo:` are forwarded when present and OMITTED when
 * not, because the host treats absent and empty differently: an absent
 * project means "the pane's project", while an empty string would be
 * looked up as a project id and fail the proposal. Same reasoning as
 * {@link buildScopedTaskCommandPayload}, and the same class of bug — a
 * dropped `Repo:` is invisible in the chip and only shows up once the
 * work is running against the wrong clone.
 */
export function buildScopedPlanProposal(proposal: PaneProposal): ScopedPlanProposal {
    const repoId = scopedProposalRepo(proposal);
    const rawProject = typeof proposal.projectId === 'string' ? proposal.projectId.trim() : '';
    return {
        title: String(proposal.title ?? ''),
        type: String(proposal.type ?? 'implement'),
        description: String(proposal.description ?? ''),
        ...(rawProject.length > 0 ? { projectId: rawProject } : {}),
        ...(repoId !== null ? { repoId } : {}),
    };
}

/** The proposal's `Repo:` target, or null when it named none. */
export function scopedProposalRepo(proposal: PaneProposal): string | null {
    const raw = typeof proposal.repoId === 'string' ? proposal.repoId.trim() : '';
    return raw.length > 0 ? raw : null;
}

/**
 * The composer hint per scope. It is the only place the pane says what
 * the operator can ask for, so each one names an action that scope can
 * actually complete — a report chat that invited plan edits would be
 * advertising a chip it never renders.
 */
const SCOPE_PLACEHOLDERS: Readonly<Record<ScopedChatScopeKind, string>> = {
    plan: 'Ask about this plan, or ask for a change ("tighten task 2\'s scope", "add an investigate task for …")',
    requirement: 'Ask about this design, or ask for a change to its description',
    report: 'Ask about this report ("why is that the root cause?"), or ask for a plan to act on it',
};

export interface ScopedChatHandle {
    readonly destroy: () => void;
}

/**
 * What a confirmed chip action DOES. Ids rather than closures so the
 * decision below stays pure and testable — the closures need a live
 * command dispatcher and a session id, which is why this matrix was only
 * reachable through a network round-trip and went untested for so long.
 */
export type ChipActionId =
    | 'plan-revision'
    | 'requirement-update'
    | 'create-task'
    | 'create-plan'
    | 'set-plan-repo'
    | 'task-update';

export interface ChipActionSpec {
    readonly id: ChipActionId;
    readonly label: string;
}

/** The rendered form of a proposal: what it says, and how it can be accepted. */
export interface ChipDescriptor {
    readonly head: string;
    readonly body: string;
    /** Empty means "shown as information" — the chip renders no buttons. */
    readonly actions: readonly ChipActionSpec[];
}

/**
 * Decide how a proposal appears in a scoped pane.
 *
 * This is THE (kind × scope) matrix, and it is the bug this module keeps
 * having: every branch used to be guarded on a specific scope, so a task
 * proposal in a design scope matched nothing and fell through to "confirm
 * it from the main chat window" — a dead chip, with the operator sent to
 * a thread that had none of the context they had just built up.
 *
 * `canCreatePlan` is whether the host supplied a `createPlan` seam. A
 * host without one must not be offered the button.
 */
export function describeProposalChip(
    proposal: PaneProposal,
    scopeKind: ScopedChatScopeKind,
    canCreatePlan: boolean,
): ChipDescriptor {
    const actions: ChipActionSpec[] = [];

    if (proposal.kind === 'plan-update' && scopeKind === 'plan') {
        actions.push({ id: 'plan-revision', label: 'Apply — new plan revision' });
        return {
            head: `✏️ Plan update: ${String(proposal.summary ?? '')}`,
            body: String(proposal.body ?? ''),
            actions,
        };
    }

    if (proposal.kind === 'requirement-update' && scopeKind === 'requirement') {
        actions.push({ id: 'requirement-update', label: 'Apply update' });
        return {
            head: '✏️ Design update',
            body: String(proposal.description ?? ''),
            actions,
        };
    }

    if (proposal.kind === 'task') {
        const type = String(proposal.type ?? 'investigate');
        // `Repo:` on the proposal block. The agent sets it to target a
        // repo other than the scope's, and this pane used to drop it on
        // the floor: the CreateTask payload carried planId/type/title/
        // description and nothing else, so `tasks.repo_id` stayed unset
        // and worktree resolution fell back to the plan's
        // `metadata.targetRepo`. The task then ran against the plan's
        // repo while the chip said nothing.
        const repoId = scopedProposalRepo(proposal);
        // In a PLAN scope the proposal is genuinely ambiguous — part of
        // THIS plan, or separate work — and only the operator knows
        // which, so both are offered rather than one being guessed.
        // "Add task" comes first: it is the common case and the one the
        // scope implies. Naming the target repo in the label matters
        // because a cross-repo task is the case worth a second look.
        if (scopeKind === 'plan') {
            actions.push({
                id: 'create-task',
                label: repoId !== null
                    ? `Add task to this plan (${repoId})`
                    : 'Add task to this plan',
            });
        }
        // Creating a plan is the ONLY route for a design or report scope,
        // which have no plan to add to.
        if (canCreatePlan) {
            actions.push({
                id: 'create-plan',
                label: scopeKind === 'plan'
                    ? 'Create as a separate plan'
                    : 'Create plan & start',
            });
        }
        return {
            head: `📋 New ${type} task: ${String(proposal.title ?? '')}`
                + (repoId !== null ? ` → ${repoId}` : ''),
            body: String(proposal.description ?? ''),
            actions,
        };
    }

    if (proposal.kind === 'plan-repo' && scopeKind === 'plan') {
        // The scope fills planId server-side, but a model that named a
        // different plan must not silently re-point THIS one.
        const planId = typeof proposal.planId === 'string' && proposal.planId.length > 0
            ? proposal.planId
            : null;
        const repoId = typeof proposal.repoId === 'string' ? proposal.repoId : '';
        actions.push({
            id: 'set-plan-repo',
            label: repoId.length > 0 ? `Point plan at ${repoId}` : 'Clear target repo',
        });
        return {
            head: repoId.length > 0
                ? `📦 Target repo for ${planId ?? 'this plan'}: ${repoId}`
                : `📦 Clear the target repo for ${planId ?? 'this plan'}`,
            body: 'Tasks in this plan that carry no repo of their own will run here.',
            actions,
        };
    }

    if (proposal.kind === 'task-update' && typeof proposal.taskId === 'string') {
        // Editing a task by id needs no scope — the plan pane's own
        // placeholder invites it ("tighten task 2's scope"), and a report
        // chat can legitimately refine the task it is discussing.
        const title = typeof proposal.title === 'string' ? proposal.title : null;
        const description = typeof proposal.description === 'string'
            ? proposal.description
            : null;
        const instructions = typeof proposal.instructions === 'string'
            ? proposal.instructions
            : null;
        actions.push({ id: 'task-update', label: 'Apply task update' });
        return {
            head: `✏️ Update task ${proposal.taskId}`,
            body: [
                title !== null ? `Title: ${title}` : '',
                description !== null ? `Description:\n${description}` : '',
                instructions !== null ? `Instructions:\n${instructions}` : '',
            ].filter((part) => part.length > 0).join('\n\n'),
            actions,
        };
    }

    return {
        head: `Proposal (${proposal.kind}) — confirm it from the main chat window.`,
        body: '',
        actions: [],
    };
}

export function mountScopedChatPane(
    container: HTMLElement,
    opts: ScopedChatOptions,
): ScopedChatHandle {
    container.classList.add('scoped-chat');

    const threadEl = document.createElement('div');
    threadEl.className = 'scoped-chat__thread';
    container.appendChild(threadEl);

    const composer = document.createElement('form');
    composer.className = 'scoped-chat__composer';
    const input = document.createElement('textarea');
    input.className = 'scoped-chat__input';
    input.rows = 3;
    input.placeholder = SCOPE_PLACEHOLDERS[opts.scopeKind];
    composer.appendChild(input);
    const sendBtn = document.createElement('button');
    sendBtn.type = 'submit';
    sendBtn.className = 'scoped-chat__send';
    sendBtn.textContent = 'Send';
    composer.appendChild(sendBtn);
    container.appendChild(composer);

    let sessionId: string | null = null;
    let destroyed = false;
    let sending = false;

    // Abort handle for the in-flight streaming read. The main chat modal
    // has had one from the start; this pane did not, so a design chat had
    // no way to stop an agent that was off down the wrong path — the only
    // options were wait it out or close the modal, and closing left the
    // `claude` process running with nobody reading it.
    let activeAbort: AbortController | null = null;

    /**
     * Flip the one composer button between Send and Stop.
     *
     * One button rather than two: the pane is the narrow half of a split
     * modal, and a disabled Send next to a Stop is two controls where the
     * operator only ever wants whichever one applies. `type` changes with
     * it so a Stop click cannot submit the form.
     */
    const setComposerBusy = (busy: boolean): void => {
        sendBtn.type = busy ? 'button' : 'submit';
        sendBtn.textContent = busy ? 'Stop' : 'Send';
        sendBtn.classList.toggle('scoped-chat__send--stop', busy);
        sendBtn.disabled = false;
    };

    /**
     * Stop the running turn: abort our read FIRST so the composer comes
     * back immediately even if the POST is slow, then tell the worker to
     * kill the process. Best-effort on the POST — the abort already tore
     * down this side, and the worker's disconnect handler is the backstop.
     */
    const stopActiveRun = async (): Promise<void> => {
        const sid = sessionId;
        if (activeAbort !== null) {
            activeAbort.abort();
            activeAbort = null;
        }
        if (sid === null) return;
        try {
            await fetch(
                chatStopUrl(opts.apiBase, sid),
                { method: 'POST' },
            );
        } catch {
            /* best-effort; the abort already tore down our side */
        }
    };

    const scrollDown = (): void => {
        threadEl.scrollTop = threadEl.scrollHeight;
    };

    const addBubble = (role: string, text: string): HTMLElement => {
        const el = document.createElement('div');
        el.className = `scoped-chat__msg scoped-chat__msg--${role}`;
        el.textContent = text;
        threadEl.appendChild(el);
        scrollDown();
        return el;
    };

    /**
     * Run a confirmed chip action. Separate from the decision above so
     * the (kind × scope) matrix stays pure; this half needs the command
     * dispatcher, the session id and the host's plan-creating seam.
     *
     * Resolving `false` means "not applied, and the operator has already
     * been told why" — the host toasts its own failures.
     */
    const runChipAction = async (
        id: ChipActionId,
        proposal: PaneProposal,
    ): Promise<boolean | void> => {
        switch (id) {
            case 'plan-revision':
                return opts.sendCommand({
                    type: 'RecordPlanRevision',
                    actor: 'operator',
                    issuedAt: Date.now(),
                    payload: {
                        planId: String(proposal.planId ?? opts.scopeId),
                        content: String(proposal.body ?? ''),
                        summary: String(proposal.summary ?? ''),
                    },
                });
            case 'requirement-update':
                return opts.sendCommand({
                    type: 'UpdateRequirement',
                    actor: 'operator',
                    issuedAt: Date.now(),
                    payload: {
                        requirementId: String(proposal.requirementId ?? opts.scopeId),
                        description: String(proposal.description ?? ''),
                    },
                });
            case 'create-task':
                return opts.sendCommand({
                    type: 'CreateTask',
                    actor: 'operator',
                    issuedAt: Date.now(),
                    payload: buildScopedTaskCommandPayload(proposal, opts.scopeId),
                });
            case 'create-plan': {
                const createPlan = opts.createPlan;
                if (!createPlan) return false;
                if (sessionId === null) {
                    throw new Error('Chat session not ready — send a message first.');
                }
                return createPlan({
                    sessionId,
                    proposal: buildScopedPlanProposal(proposal),
                });
            }
            case 'set-plan-repo': {
                const planId = typeof proposal.planId === 'string' && proposal.planId.length > 0
                    ? proposal.planId
                    : opts.scopeId;
                return opts.sendCommand({
                    type: 'SetPlanRepo',
                    actor: 'operator',
                    issuedAt: Date.now(),
                    payload: {
                        planId,
                        repoId: typeof proposal.repoId === 'string' ? proposal.repoId : '',
                    },
                });
            }
            case 'task-update': {
                // Two commands because the fields live in two places:
                // title/description are task columns, instructions is the
                // operator note the agent reads at spawn. Send only what
                // the proposal named.
                const taskId = String(proposal.taskId ?? '');
                const title = typeof proposal.title === 'string' ? proposal.title : null;
                const description = typeof proposal.description === 'string'
                    ? proposal.description
                    : null;
                const instructions = typeof proposal.instructions === 'string'
                    ? proposal.instructions
                    : null;
                if (title !== null || description !== null) {
                    await opts.sendCommand({
                        type: 'EditTask',
                        actor: 'operator',
                        issuedAt: Date.now(),
                        payload: {
                            taskId,
                            ...(title !== null ? { title } : {}),
                            ...(description !== null ? { description } : {}),
                        },
                    });
                }
                if (instructions !== null) {
                    await opts.sendCommand({
                        type: 'SetTaskInstructions',
                        actor: 'operator',
                        issuedAt: Date.now(),
                        payload: { taskId, instructions },
                    });
                }
                return undefined;
            }
        }
    };

    const addProposalChip = (proposal: PaneProposal): void => {
        const spec = describeProposalChip(proposal, opts.scopeKind, Boolean(opts.createPlan));

        const chip = document.createElement('div');
        chip.className = 'scoped-chat__proposal';
        const head = document.createElement('div');
        head.className = 'scoped-chat__proposal-head';
        head.textContent = spec.head;
        chip.appendChild(head);

        if (spec.body.length > 0) {
            const bodyPreview = document.createElement('pre');
            bodyPreview.className = 'scoped-chat__proposal-body';
            bodyPreview.textContent = spec.body;
            chip.appendChild(bodyPreview);
        }

        if (spec.actions.length > 0) {
            const row = document.createElement('div');
            row.className = 'scoped-chat__proposal-actions';
            const buttons: HTMLButtonElement[] = [];
            for (const action of spec.actions) {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'scoped-chat__confirm';
                btn.textContent = action.label;
                btn.addEventListener('click', async () => {
                    // Disable EVERY button on the chip, not just this one:
                    // the alternatives are mutually exclusive readings of
                    // the same proposal, and a click across two of them
                    // would both add the task and create a plan for it.
                    for (const b of buttons) b.disabled = true;
                    btn.textContent = 'Applying…';
                    try {
                        const applied = await runChipAction(action.id, proposal);
                        if (applied === false) {
                            // Host already surfaced the reason; re-arm quietly.
                            for (const b of buttons) b.disabled = false;
                            btn.textContent = action.label;
                            return;
                        }
                        btn.textContent = '✓ Applied';
                        chip.classList.add('scoped-chat__proposal--applied');
                        // Leave the alternatives disabled — the proposal
                        // has been acted on.
                    } catch (err) {
                        for (const b of buttons) b.disabled = false;
                        btn.textContent = action.label;
                        opts.onError(err instanceof Error ? err.message : String(err));
                    }
                });
                buttons.push(btn);
                row.appendChild(btn);
            }
            chip.appendChild(row);
        }

        threadEl.appendChild(chip);
        scrollDown();
    };

    const loadHistory = async (): Promise<void> => {
        if (!sessionId) return;
        try {
            const res = await fetch(
                `${opts.apiBase}/api/chat/sessions/${encodeURIComponent(sessionId)}`,
            );
            if (!res.ok) return;
            const body = (await res.json()) as {
                messages?: Array<{ role?: string; body?: string; metadata?: { proposals?: PaneProposal[] } | null }>;
            };
            threadEl.replaceChildren();
            for (const m of body.messages ?? []) {
                // Proposal blocks render as cards below; showing them as
                // prose too made every proposed task arrive twice.
                const shown = typeof m.body === 'string'
                    ? stripProposalBlocks(m.body)
                    : '';
                if (shown.length > 0) {
                    addBubble(typeof m.role === 'string' ? m.role : 'assistant', shown);
                }
                const proposals = m.metadata?.proposals;
                if (Array.isArray(proposals)) {
                    for (const p of proposals) addProposalChip(p);
                }
            }
        } catch { /* worker unreachable — composer still works after retry */ }
    };

    const ensureSession = async (): Promise<boolean> => {
        if (sessionId) return true;
        try {
            const res = await fetch(`${opts.apiBase}/api/chat/sessions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    projectId: opts.projectId,
                    ...(opts.repoId ? { repoId: opts.repoId } : {}),
                    title: opts.title,
                    scopeKind: opts.scopeKind,
                    scopeId: opts.scopeId,
                }),
            });
            if (!res.ok) {
                const text = await res.text().catch(() => '');
                opts.onError(`Chat session failed (HTTP ${res.status}): ${text.slice(0, 200)}`);
                return false;
            }
            const body = (await res.json()) as { session?: { id?: string } };
            sessionId = typeof body.session?.id === 'string' ? body.session.id : null;
            if (sessionId) await loadHistory();
            return sessionId !== null;
        } catch (err) {
            opts.onError(err instanceof Error ? err.message : String(err));
            return false;
        }
    };

    const send = async (): Promise<void> => {
        const content = input.value.trim();
        if (content.length === 0 || sending) return;
        if (!(await ensureSession()) || !sessionId) return;
        sending = true;
        // The Send button BECOMES Stop for the duration of the turn,
        // rather than greying out. Same affordance as the main chat modal,
        // and it is the one control the operator wants while an agent is
        // producing something they can already tell is wrong.
        setComposerBusy(true);
        input.value = '';
        addBubble('user', content);
        // Visible progress: a pulsing "agent is working" row that lives
        // until the first streamed chunk (or the turn ends) — long
        // thinking phases previously looked like nothing was happening.
        const workingEl = document.createElement('div');
        workingEl.className = 'scoped-chat__working';
        workingEl.textContent = '🤖 Agent is working';
        threadEl.appendChild(workingEl);
        scrollDown();
        const clearWorking = (): void => {
            workingEl.remove();
        };
        const streamEl = addBubble('assistant', '…');
        streamEl.textContent = '';
        try {
            const abort = new AbortController();
            activeAbort = abort;
            const res = await fetch(
                `${opts.apiBase}/api/chat/sessions/${encodeURIComponent(sessionId)}/messages`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ content }),
                    signal: abort.signal,
                },
            );
            if (!res.ok || !res.body) {
                const text = await res.text().catch(() => '');
                streamEl.textContent = `(error: HTTP ${res.status} ${text.slice(0, 200)})`;
                return;
            }
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buf = '';
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                buf += decoder.decode(value, { stream: true });
                for (;;) {
                    const nl = buf.indexOf('\n');
                    if (nl < 0) break;
                    const line = buf.slice(0, nl);
                    buf = buf.slice(nl + 1);
                    if (!line.trim()) continue;
                    let frame: Record<string, unknown>;
                    try {
                        frame = JSON.parse(line) as Record<string, unknown>;
                    } catch {
                        continue;
                    }
                    if (frame.type === 'chunk' && typeof frame.text === 'string') {
                        clearWorking();
                        streamEl.textContent += frame.text;
                        scrollDown();
                    } else if (frame.type === 'done') {
                        clearWorking();
                        const message = frame.message as { body?: string } | undefined;
                        if (message?.body) {
                            // The streamed chunks showed the raw block as it
                            // was written; the final body drops it so only
                            // the card remains.
                            const shown = stripProposalBlocks(message.body);
                            streamEl.textContent = shown;
                            streamEl.hidden = shown.length === 0;
                        }
                        const proposals = frame.proposals;
                        if (Array.isArray(proposals)) {
                            for (const p of proposals as PaneProposal[]) addProposalChip(p);
                        }
                        const warnings = frame.proposalWarnings;
                        if (Array.isArray(warnings)) {
                            for (const w of warnings as string[]) addBubble('system', w);
                        }
                    } else if (frame.type === 'error') {
                        streamEl.textContent += `\n(error: ${String(frame.message ?? 'unknown')})`;
                    }
                }
            }
        } catch (err) {
            // An AbortError is the operator clicking Stop, not a failure.
            // Keep whatever streamed before the stop and mark it, so the
            // thread reads as a truncated answer rather than a broken one.
            if (isOperatorStop(err)) {
                streamEl.textContent = `${streamEl.textContent ?? ''}\n(stopped)`.trim();
            } else {
                streamEl.textContent += `\n(${err instanceof Error ? err.message : String(err)})`;
            }
        } finally {
            clearWorking();
            activeAbort = null;
            sending = false;
            setComposerBusy(false);
            scrollDown();
        }
    };

    composer.addEventListener('submit', (e) => {
        e.preventDefault();
        void send();
    });
    // Mid-turn the same button is Stop. A click listener rather than a
    // swapped-out element so the button keeps its place and focus.
    sendBtn.addEventListener('click', (e) => {
        if (!sending) return;
        e.preventDefault();
        void stopActiveRun();
    });
    // Enter sends (Shift+Enter inserts a newline). The Send button stays.
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            void send();
        }
    });

    void ensureSession();

    return {
        destroy(): void {
            if (destroyed) return;
            destroyed = true;
            // Closing the modal (or toggling the chat pane shut) while a
            // turn is running used to leave the `claude` process alive
            // with nobody reading it — the DOM went away, the run did
            // not. Same shape as the runner's reaper bug. Tear the turn
            // down explicitly.
            if (sending || activeAbort !== null) void stopActiveRun();
            container.classList.remove('scoped-chat');
            container.replaceChildren();
        },
    };
}
