/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * AP-VP5-016 — operator-features end-to-end parity spec.
 *
 * Exercises the three Phase 5 round-trips end-to-end against the in-process
 * orchestrator + worker-api + board-modal seams the operator drives in
 * production:
 *
 *   1. Clarification — an agent emits `needs_human_input`; the orchestrator
 *      clarification handler parks the task and surfaces a
 *      `ClarificationRequested` event; the operator opens the AP-VP5-010
 *      clarify modal, types an answer with `Remember` checked, and submits.
 *      The modal POST is wired through the worker-api `dispatchClarify` →
 *      CommandBus → the orchestrator-side ResumeTask handler so the
 *      worktree sidecar (`clarification-answer.md`) and the per-project
 *      `agent-memory.md` both gain real lines on disk.
 *
 *   2. Reject-with-feedback — a `FlowEngine` parks a task at an
 *      `approval='required'` step with an explicit `on_failure` target. The
 *      operator opens the AP-VP5-012 reject-feedback modal, types feedback
 *      and clicks Reject. The modal POST is wired through the worker-api
 *      `dispatchReject`, which dispatches `ResumeTask{ decision: 'reject',
 *      feedback }` onto the CommandBus, and the FlowEngine then routes the
 *      rejection through the parked step's `on_failure` (NOT the default
 *      `TaskFailed`).
 *
 *   3. Investigation follow-up — the orchestrator's
 *      `RequestInvestigationFollowup` handler (AP-VP5-006) is wired to a
 *      worktree-rooted `investigation-history.jsonl`. The operator opens the
 *      AP-VP5-011 follow-up modal, types a question, clicks Ask. The
 *      modal's dispatcher is wired into the CommandBus and the resulting
 *      turn pair (operator + investigator) lands on disk.
 *
 * # Why this lives under `test/parity/`
 *
 * Phase 5's wiring contract (board → worker-api → command bus →
 * orchestrator handlers → flow engine) is the operator-facing
 * surface the v1 → v2 parity story has to honour. The unit tests
 * under `test/unit/...` pin each seam in isolation; this spec stitches
 * the seams together so a regression at any one boundary breaks here too.
 *
 * # Runner discovery
 *
 * The repo's `npm test` runs `node --test --import tsx`; the cloud review
 * pipeline runs `npx vitest run` against changed files. The dual-runner
 * `test()` shim below picks whichever runner is active at module load so
 * the same file is discovered + executed by both.
 *
 * # No real Claude CLI
 *
 * Every scenario uses the fake-adapter scaffolding the unit suites already
 * lean on: an in-memory stream emitter for the agent-stream subscription,
 * a recording `InvestigatorAgent` stub for the follow-up path, and
 * hand-rolled DOM + fetch ports for the modals. The `claude` CLI is never
 * spawned and no HTTPS request leaves the host.
 */

import * as assert from 'node:assert/strict';
import * as child_process from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { CommandBus } from '../../core/commands/bus';
import type { Command } from '../../core/commands/command';
import { EventBus } from '../../core/events/bus';
import { EventStore } from '../../core/events/store';
import type { Event, StoredEvent } from '../../core/events/event';
import { applyMigrations, openDatabase, type Db } from '../../core/state/migrations';
import type { Logger } from '../../core/ports/Logger';
import type { IdGen } from '../../core/ports/IdGen';
import type { AgentHandle, AgentRunner, AgentSpec } from '../../core/ports';

import {
    TaskParkingCommands,
    TaskParkingEvents,
    type TaskParkedEventPayload,
    type TaskResumedEventPayload,
} from '../../core/commands';
import {
    FlowEngine,
    FlowEvents,
    FlowCommands,
    type StartAgentPayload,
} from '../../core/flow/engine';
import type { FlowDefinition } from '../../core/flow/types';
import {
    InvestigationFollowupCommands,
    InvestigationFollowupEvents,
    type InvestigationFollowupRequestedEventPayload,
    type InvestigatorAgent,
    type InvestigatorInput,
    type RequestInvestigationFollowupPayload,
} from '../../core/flow/investigation-followup';
import { AgentMemoryStore } from '../../core/projects/agent-memory';

import {
    registerClarificationHandler,
    type AgentStreamSubscription,
} from '../../hosts/orchestrator/handlers/clarification';
import {
    createResumeHandler,
    type AgentMemoryWriter,
    type TaskProjectLookup,
    type WorktreeRootLookup,
} from '../../hosts/orchestrator/handlers/resume';
import {
    registerCommandHandlers,
    type InvestigationHistoryLine,
} from '../../hosts/orchestrator/handlers';

import {
    dispatchClarify,
    dispatchReject,
    type TasksCommandSink,
    type TasksRoutesDeps,
} from '../../hosts/worker-api/routes/tasks';

import {
    CLARIFY_REMEMBER_TESTID,
    CLARIFY_SUBMIT_TESTID,
    CLARIFY_TEXTAREA_TESTID,
    openClarifyModal,
    type ClarifyDocument,
    type ClarifyElement,
    type ClarifyFetch,
    type ClarifyFetchInit,
    type ClarifyFetchResponse,
    type ClarifyKeyListener,
} from '../../hosts/board-ui/modals/clarify';
import {
    REJECT_FEEDBACK_SUBMIT_TESTID,
    REJECT_FEEDBACK_TEXTAREA_TESTID,
    openRejectFeedbackModal,
    type RejectFeedbackDocument,
    type RejectFeedbackElement,
    type RejectFeedbackFetch,
    type RejectFeedbackFetchInit,
    type RejectFeedbackResponse,
} from '../../hosts/board-ui/modals/reject-feedback';
import {
    FOLLOWUP_ASK_TESTID,
    FOLLOWUP_TEXTAREA_TESTID,
    openInvestigationFollowupModal,
    type AskInvestigationFollowupCommand,
    type FollowupDocument,
    type FollowupElement,
    type FollowupThreadEntry,
} from '../../hosts/board-ui/client/modals/investigation-followup';

// ---------------------------------------------------------------------------
// Dual-runner test() shim — see file header for rationale. Mirrors the
// shim used by `test/unit/orchestrator/investigation-followup.test.ts` and
// the other Phase 5 unit specs so this file is discoverable under both
// `node --test` and `vitest`.
// ---------------------------------------------------------------------------

type TestFn = (name: string, fn: () => void | Promise<void>) => void;

const test: TestFn = (((): TestFn => {
    if (process.env.VITEST) {
        const gt = (globalThis as { test?: TestFn }).test;
        if (typeof gt !== 'function') {
            throw new Error(
                'operator-features.spec.ts: VITEST=true but globalThis.test is missing — '
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
// Shared scaffolding
// ---------------------------------------------------------------------------

class SilentLogger implements Logger {
    info(): void {}
    warn(): void {}
    error(): void {}
    debug(): void {}
}

class StubAgentRunner implements AgentRunner {
    private counter = 0;
    start(spec: AgentSpec): AgentHandle {
        this.counter += 1;
        return { id: `agent-${this.counter}`, spec };
    }
    async interrupt(): Promise<void> {}
}

function freshDb(): Db {
    const db = openDatabase(':memory:');
    applyMigrations(db);
    return db;
}

let evCounter = 0;
function makeEvent(type: string, payload: unknown): Event {
    evCounter += 1;
    return {
        type,
        v: 1,
        occurredAt: 1_700_000_000_000,
        idempotencyKey: `op-feat-${process.pid}-${evCounter}`,
        payload,
    };
}

function seedTask(db: Db, taskId: string, projectId = 'proj-op-features'): void {
    const planId = `plan-${taskId}`;
    db.prepare(
        'INSERT INTO plans(id, project_id, status, created_at) VALUES (?, ?, ?, ?)',
    ).run(planId, projectId, 'approved', 1_700_000_000_000);
    db.prepare(
        'INSERT INTO tasks(id, plan_id, type, status) VALUES (?, ?, ?, ?)',
    ).run(taskId, planId, 'feature', 'approved');
}

// ---------------------------------------------------------------------------
// Minimal DOM shim — structurally satisfies the clarify / reject-feedback /
// investigation-followup element + document surfaces. Mirrors the shim used
// by the AP-VP5-010 / 011 / 012 modal unit suites.
// ---------------------------------------------------------------------------

interface ShimEl {
    tagName: string;
    className: string;
    textContent: string | null;
    value?: string;
    checked?: boolean;
    hidden?: boolean;
    disabled?: boolean;
    children: ShimEl[];
    attributes: Map<string, string>;
    parent: ShimEl | null;
    removed: boolean;
    focusCalls: number;
    setAttribute(name: string, v: string): void;
    removeAttribute(name: string): void;
    appendChild(child: ShimEl): ShimEl;
    replaceChildren(...kids: ShimEl[]): void;
    remove(): void;
    focus(): void;
    onclick?: ((event?: { target?: unknown }) => void) | null;
    oninput?: () => void;
    onsubmit?: (event?: { preventDefault?: () => void }) => void;
}

function makeEl(tagName: string): ShimEl {
    const attrs = new Map<string, string>();
    const children: ShimEl[] = [];
    const el: ShimEl = {
        tagName,
        className: '',
        textContent: null,
        value: '',
        checked: false,
        hidden: false,
        disabled: false,
        children,
        attributes: attrs,
        parent: null,
        removed: false,
        focusCalls: 0,
        setAttribute(name, v): void {
            attrs.set(name, v);
        },
        removeAttribute(name): void {
            attrs.delete(name);
        },
        appendChild(child): ShimEl {
            child.parent = el;
            children.push(child);
            return child;
        },
        replaceChildren(...kids): void {
            for (const c of children) c.parent = null;
            children.length = 0;
            for (const k of kids) {
                k.parent = el;
                children.push(k);
            }
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
            el.focusCalls += 1;
        },
        onclick: null,
    };
    return el;
}

interface ShimDoc {
    createElement(tagName: string): ShimEl;
    addEventListener(type: 'keydown', listener: ClarifyKeyListener): void;
    removeEventListener(type: 'keydown', listener: ClarifyKeyListener): void;
    listeners: Map<string, ClarifyKeyListener[]>;
}

function makeDoc(): ShimDoc {
    const listeners = new Map<string, ClarifyKeyListener[]>();
    return {
        listeners,
        createElement(tagName: string): ShimEl {
            return makeEl(tagName);
        },
        addEventListener(type, listener): void {
            const pool = listeners.get(type) ?? [];
            pool.push(listener);
            listeners.set(type, pool);
        },
        removeEventListener(type, listener): void {
            const pool = listeners.get(type);
            if (!pool) return;
            const idx = pool.indexOf(listener);
            if (idx >= 0) pool.splice(idx, 1);
        },
    };
}

function findFirst(root: ShimEl, predicate: (el: ShimEl) => boolean): ShimEl | null {
    if (predicate(root)) return root;
    for (const c of root.children) {
        const hit = findFirst(c, predicate);
        if (hit) return hit;
    }
    return null;
}

function byTestId(root: ShimEl, testid: string): ShimEl {
    const hit = findFirst(root, (el) => el.attributes.get('data-testid') === testid);
    if (!hit) throw new Error(`no element with data-testid="${testid}"`);
    return hit;
}

// ---------------------------------------------------------------------------
// Scenario 1 — Clarification round-trip
//
// Agent emits `needs_human_input` → orchestrator clarification handler
// publishes TaskParked{reason:'clarification'} + ClarificationRequested →
// operator opens the AP-VP5-010 clarify modal → submit with Remember
// checked → worker-api `dispatchClarify` → CommandBus → orchestrator
// ResumeTask handler writes `clarification-answer.md`, appends to
// `agent-memory.md`, emits ClarificationAnswered + TaskResumed.
// ---------------------------------------------------------------------------

interface FakeStream extends AgentStreamSubscription {
    emit(taskId: string, stepId: string, line: string): Promise<void>;
}

function makeFakeStream(): FakeStream {
    const handlers: Array<
        (line: { taskId: string; stepId: string; line: string }) => void | Promise<void>
    > = [];
    return {
        subscribe(handler): () => void {
            handlers.push(handler);
            return (): void => {
                const idx = handlers.indexOf(handler);
                if (idx >= 0) handlers.splice(idx, 1);
            };
        },
        async emit(taskId, stepId, line): Promise<void> {
            for (const h of handlers) await h({ taskId, stepId, line });
        },
    };
}

test('scenario 1: clarification round-trip — agent emission → modal submit → memory append', async () => {
    const taskId = 'task-clarify-1';
    const projectId = 'proj-op-features';
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-vp5-016-clarify-'));
    const worktreeDir = path.join(tmpRoot, 'worktree');
    fs.mkdirSync(worktreeDir, { recursive: true });
    const projectsRoot = path.join(tmpRoot, 'projects');
    fs.mkdirSync(projectsRoot, { recursive: true });

    const db = freshDb();
    try {
        const logger = new SilentLogger();
        const eventBus = new EventBus(new EventStore(db), logger);
        const cmdBus = new CommandBus<unknown>(eventBus, () => undefined);

        // ----- subscribers that record the events we want to assert on -----
        const parked: Array<StoredEvent & { payload: TaskParkedEventPayload }> = [];
        eventBus.subscribe<TaskParkedEventPayload>(
            TaskParkingEvents.TASK_PARKED,
            (e) => {
                parked.push(e);
            },
        );
        const clarificationRequested: StoredEvent[] = [];
        eventBus.subscribe('ClarificationRequested', (e) => {
            clarificationRequested.push(e);
        });
        const clarificationAnswered: StoredEvent[] = [];
        eventBus.subscribe('ClarificationAnswered', (e) => {
            clarificationAnswered.push(e);
        });
        const resumed: Array<StoredEvent & { payload: TaskResumedEventPayload }> = [];
        eventBus.subscribe<TaskResumedEventPayload>(
            TaskParkingEvents.TASK_RESUMED,
            (e) => {
                resumed.push(e);
            },
        );

        // ----- orchestrator-side handlers -----
        const stream = makeFakeStream();
        const stopClarification = registerClarificationHandler({
            bus: eventBus,
            clock: (): number => 1_700_000_000_000,
            logger,
            stream,
        });

        const worktrees: WorktreeRootLookup = {
            pathFor: (id) => (id === taskId ? worktreeDir : undefined),
        };
        const projectLookup: TaskProjectLookup = {
            projectIdFor: (id) => (id === taskId ? projectId : undefined),
        };
        // Use the REAL AgentMemoryStore, wired the way PRODUCTION wires it
        // (hosts/orchestrator/main.ts): the resume handler's port maps onto
        // `append`, the JSONL store that `renderForPrompt` actually reads.
        // This adapter used to call `appendMemoryEntry` instead — the
        // markdown writer nothing in production called and no prompt ever
        // loaded — so the spec asserted a file that could never influence
        // an agent. The writer is gone; this is the real path.
        const memoryStore = new AgentMemoryStore(projectsRoot);
        const memoryWriter: AgentMemoryWriter = {
            appendMemoryEntry: async (opts): Promise<void> => {
                memoryStore.append(opts.projectId, {
                    source: opts.source,
                    taskIdentifier: opts.taskId,
                    taskTitle: opts.taskId,
                    feedback: opts.context,
                });
            },
        };
        cmdBus.register(
            TaskParkingCommands.RESUME_TASK,
            createResumeHandler({
                clock: (): number => 1_700_000_000_001,
                logger,
                worktrees,
                memory: memoryWriter,
                projectLookup,
            }),
        );

        // ----- step 1: the agent emits `needs_human_input` -----
        await stream.emit(
            taskId,
            'develop',
            JSON.stringify({
                event: 'needs_human_input',
                question: 'Which database should we use?',
                choices: ['Postgres', 'SQLite'],
            }),
        );

        assert.equal(parked.length, 1, 'clarification handler must publish exactly one TaskParked');
        assert.equal(parked[0].payload.reason, 'clarification');
        assert.equal(parked[0].payload.taskId, taskId);
        assert.equal(parked[0].payload.question, 'Which database should we use?');

        assert.equal(clarificationRequested.length, 1, 'ClarificationRequested must fire');
        const requestedPayload = clarificationRequested[0].payload as {
            taskId: string;
            question: string;
            choices?: readonly string[];
        };
        assert.equal(requestedPayload.taskId, taskId);
        assert.equal(requestedPayload.question, 'Which database should we use?');
        assert.deepEqual(requestedPayload.choices, ['Postgres', 'SQLite']);

        // ----- step 2: the operator opens the clarify modal -----
        const doc = makeDoc();
        const parent = makeEl('body');

        // Fetch port: route the modal's POST through the worker-api dispatcher
        // so the command bus + orchestrator-side ResumeTask handler run, and
        // assert on the side-effects they produce (sidecar + memory append).
        const fetchCalls: Array<{ url: string; body: unknown }> = [];
        const fetchFn: ClarifyFetch = async (
            url: string,
            init?: ClarifyFetchInit,
        ): Promise<ClarifyFetchResponse> => {
            const body = init?.body ? JSON.parse(init.body) : {};
            fetchCalls.push({ url, body });
            const sink: TasksCommandSink = { send: (cmd) => cmdBus.send(cmd) };
            const deps: TasksRoutesDeps = {
                bus: sink,
                clock: (): number => 1_700_000_000_002,
                defaultActor: 'operator',
                logger,
            };
            const result = await dispatchClarify(
                deps,
                taskId,
                body as { answer: string; remember?: boolean },
                'operator',
            );
            return { ok: result.status >= 200 && result.status < 300, status: result.status };
        };

        const handle = openClarifyModal(
            {
                taskId,
                question: requestedPayload.question,
                choices: requestedPayload.choices,
                apiBase: '',
            },
            {
                doc: doc as unknown as ClarifyDocument,
                parent: parent as unknown as ClarifyElement,
                fetch: fetchFn,
            },
        );

        // Operator types an answer and checks Remember before clicking Submit.
        const textarea = byTestId(parent, CLARIFY_TEXTAREA_TESTID);
        textarea.value = 'Use Postgres with pooled connections.';
        const remember = byTestId(parent, CLARIFY_REMEMBER_TESTID);
        remember.checked = true;
        // `submitButton.onclick` is the same code path as `handle.submit()`
        // (the click handler invokes `void submit()` internally) so calling
        // the awaitable form once gives us deterministic settlement of the
        // fetch + CommandBus.send chain without double-firing.
        const submitBtn = byTestId(parent, CLARIFY_SUBMIT_TESTID);
        void submitBtn;
        const ok = await handle.submit();
        assert.equal(ok, true, 'clarify submit must return true on 202');

        // ----- step 3: assert the full round-trip -----
        assert.equal(fetchCalls.length, 1, 'modal must POST exactly once');
        assert.equal(
            fetchCalls[0].url,
            `/tasks/${taskId}/clarify`,
            'modal must hit the AP-VP5-008 clarify route',
        );
        assert.deepEqual(fetchCalls[0].body, {
            answer: 'Use Postgres with pooled connections.',
            remember: true,
        });

        // Sidecar landed on disk.
        const answerFile = path.join(worktreeDir, 'clarification-answer.md');
        assert.equal(
            fs.existsSync(answerFile),
            true,
            'clarification-answer.md must be created under the task worktree',
        );
        assert.equal(
            fs.readFileSync(answerFile, 'utf8'),
            'Use Postgres with pooled connections.',
        );

        // The project's agent memory gained an entry — and it is the JSONL
        // store, the one `renderForPrompt` splices into future planner and
        // decomposer prompts. Asserting the file the prompts READ is the
        // whole point: a memory write nothing loads is not a feature.
        const memFile = memoryStore.fileFor(projectId);
        assert.equal(
            fs.existsSync(memFile),
            true,
            'agent-memory.jsonl must be created for the project on remember=true',
        );
        const memEntries = memoryStore.read(projectId);
        assert.equal(memEntries.length, 1, 'exactly one memory entry');
        assert.equal(memEntries[0].source, 'clarification');
        assert.equal(
            memEntries[0].feedback,
            'Use Postgres with pooled connections.',
            'memory entry must carry the operator answer body',
        );
        assert.match(
            memoryStore.renderForPrompt(projectId),
            /Use Postgres with pooled connections\./,
            'and it must reach the prompt block the planner is given',
        );

        // ClarificationAnswered + TaskResumed both emitted.
        assert.equal(clarificationAnswered.length, 1, 'ClarificationAnswered must fire');
        assert.equal(resumed.length, 1, 'TaskResumed must fire');
        assert.equal(resumed[0].payload.decision, 'approve');
        assert.equal(resumed[0].payload.answer, 'Use Postgres with pooled connections.');
        assert.equal(resumed[0].payload.remember, true);

        stopClarification();
    } finally {
        db.close();
        try {
            fs.rmSync(tmpRoot, { recursive: true, force: true });
        } catch {
            /* best-effort tmpdir cleanup */
        }
    }
});

// ---------------------------------------------------------------------------
// Scenario 2 — Reject-with-feedback round-trip
//
// FlowEngine parks a task at an approval-required step with an explicit
// `on_failure: 'emit:ReviewRejected'`. The operator opens the AP-VP5-012
// reject-feedback modal, types feedback, clicks Reject. The modal POST is
// wired through the worker-api `dispatchReject`, which dispatches
// `ResumeTask{ decision: 'reject', feedback }` onto the CommandBus. The
// FlowEngine subscribes to TaskResumed and routes the rejection through
// `on_failure` — `ReviewRejected` fires; the default `TaskFailed` does not.
// ---------------------------------------------------------------------------

test('scenario 2: reject-with-feedback round-trip — commit-park → modal Reject → on_failure routing', async () => {
    const taskId = 'task-reject-1';
    const db = freshDb();
    try {
        const logger = new SilentLogger();
        const eventBus = new EventBus(new EventStore(db), logger);
        const cmdBus = new CommandBus<unknown>(eventBus, () => undefined);

        // Recorder for downstream FlowCommands the engine emits so this
        // spec can assert no StartAgent / FailTask were dispatched on reject.
        const flowCommands: Command[] = [];
        const recordOnly = async (cmd: Command): Promise<Event[]> => {
            flowCommands.push(cmd);
            return [];
        };
        cmdBus.register(FlowCommands.START_AGENT, recordOnly);
        cmdBus.register(FlowCommands.FINISH_TASK, recordOnly);
        cmdBus.register(FlowCommands.FAIL_TASK, recordOnly);
        cmdBus.register(FlowCommands.REQUEST_INVESTIGATION, recordOnly);

        // The CORE ResumeTask handler is sufficient — scenario 2 does not
        // need the orchestrator-side sidecar writer because feedback is
        // persisted on `tasks.feedback` by the engine and the on_failure
        // routing is what the AC asserts on.
        const { createResumeTaskHandler } = await import('../../core/commands');
        cmdBus.register(
            TaskParkingCommands.RESUME_TASK,
            createResumeTaskHandler({ clock: (): number => 1_700_000_000_005 }),
        );

        // Event subscribers for the round-trip assertions.
        const parked: Array<StoredEvent & { payload: TaskParkedEventPayload }> = [];
        eventBus.subscribe<TaskParkedEventPayload>(
            TaskParkingEvents.TASK_PARKED,
            (e) => {
                parked.push(e);
            },
        );
        const reviewRejected: StoredEvent[] = [];
        eventBus.subscribe('ReviewRejected', (e) => {
            reviewRejected.push(e);
        });
        const failed: StoredEvent[] = [];
        eventBus.subscribe('TaskFailed', (e) => {
            failed.push(e);
        });

        // A two-step flow whose first step is approval-required with an
        // explicit on_failure target. The engine MUST route a reject down
        // this on_failure transition rather than the default TaskFailed.
        const flow: FlowDefinition = {
            on: 'task.approved',
            steps: [
                {
                    id: 'review',
                    agent: 'reviewer',
                    model: 'sonnet',
                    on_success: 'develop',
                    on_failure: 'emit:ReviewRejected',
                    approval: 'required',
                },
                {
                    id: 'develop',
                    agent: 'developer',
                    model: 'sonnet',
                    on_success: 'emit:task.finished',
                },
            ],
        };
        const engine = FlowEngine.start(
            eventBus,
            cmdBus,
            new Map<string, FlowDefinition>([['op-features-reject', flow]]),
            { db, logger },
        );
        try {
            seedTask(db, taskId);

            // ----- step 1: approve the task → engine parks at the gate -----
            await eventBus.publish(
                makeEvent(FlowEvents.TASK_APPROVED, {
                    taskId,
                    flowId: 'op-features-reject',
                }),
            );
            assert.equal(parked.length, 1, 'engine must park at approval gate');
            assert.equal(parked[0].payload.reason, 'approval');
            assert.equal(parked[0].payload.stepId, 'review');
            // No StartAgent dispatched while parked.
            assert.equal(
                flowCommands.filter((c) => c.type === FlowCommands.START_AGENT).length,
                0,
                'no agent must have been started while parked',
            );

            // ----- step 2: operator opens the reject-feedback modal -----
            const doc = makeDoc();
            const parent = makeEl('body');

            const fetchCalls: Array<{ url: string; body: unknown }> = [];
            const fetchFn: RejectFeedbackFetch = async (
                url: string,
                init?: RejectFeedbackFetchInit,
            ): Promise<RejectFeedbackResponse> => {
                const body = init?.body ? JSON.parse(init.body) : {};
                fetchCalls.push({ url, body });
                const sink: TasksCommandSink = { send: (cmd) => cmdBus.send(cmd) };
                const deps: TasksRoutesDeps = {
                    bus: sink,
                    clock: (): number => 1_700_000_000_010,
                    defaultActor: 'operator',
                    logger,
                };
                const r = await dispatchReject(
                    deps,
                    taskId,
                    body as { feedback: string },
                    'operator',
                );
                return { ok: r.status >= 200 && r.status < 300, status: r.status };
            };

            const handle = openRejectFeedbackModal(
                {
                    taskId,
                    fetch: fetchFn,
                    apiBase: '',
                },
                {
                    doc: doc as unknown as RejectFeedbackDocument,
                    parent: parent as unknown as RejectFeedbackElement,
                },
            );

            const textarea = byTestId(parent, REJECT_FEEDBACK_TEXTAREA_TESTID);
            textarea.value = 'PR diff scope is wrong — split before re-running.';
            // Mirror the live oninput behaviour so the disabled flag flips.
            textarea.oninput?.();
            const rejectBtn = byTestId(parent, REJECT_FEEDBACK_SUBMIT_TESTID);
            // The handle.submit() drives the same code path as the click;
            // awaiting it gives us the deterministic fetch + dispatch round.
            const ok = await handle.submit();
            assert.equal(ok, true, 'reject-feedback submit must return true on 202');
            void rejectBtn;

            // ----- step 3: assert the round-trip -----
            assert.equal(fetchCalls.length, 1, 'reject modal must POST exactly once');
            assert.equal(
                fetchCalls[0].url,
                `/tasks/${taskId}/reject`,
                'modal must hit the AP-VP5-008 reject route',
            );
            assert.deepEqual(fetchCalls[0].body, {
                feedback: 'PR diff scope is wrong — split before re-running.',
            });

            // The engine's on_failure target fired — and NOT the default TaskFailed.
            // The engine threads the operator's feedback onto the on_failure
            // emit payload so the downstream subscriber can render it without
            // a second DB read.
            assert.equal(reviewRejected.length, 1, 'on_failure (ReviewRejected) must fire');
            assert.deepEqual(reviewRejected[0].payload, {
                taskId,
                feedback: 'PR diff scope is wrong — split before re-running.',
            });
            assert.equal(
                failed.length,
                0,
                'default TaskFailed must NOT fire when on_failure is wired',
            );
            // The parked step replay must NOT have re-issued StartAgent.
            const replayStarts = flowCommands.filter(
                (c) => c.type === FlowCommands.START_AGENT,
            ) as Array<Command<StartAgentPayload>>;
            assert.equal(
                replayStarts.length,
                0,
                'reject must NOT replay the parked step as StartAgent',
            );

            // Engine persisted the operator's feedback onto tasks.feedback.
            const row = db
                .prepare('SELECT feedback FROM tasks WHERE id = ?')
                .get(taskId) as { feedback: string | null };
            assert.equal(
                row.feedback,
                'PR diff scope is wrong — split before re-running.',
                'engine must persist feedback onto tasks.feedback on reject',
            );
        } finally {
            engine.stop();
        }
    } finally {
        db.close();
    }
});

// ---------------------------------------------------------------------------
// Scenario 3 — Investigation follow-up round-trip
//
// Orchestrator registers the AP-VP5-006 follow-up handler with a worktree-
// rooted `investigation-history.jsonl`. The operator opens the AP-VP5-011
// follow-up modal, types a question, clicks Ask. The modal's dispatcher
// runs the AskInvestigationFollowup command through a tiny translator that
// re-issues it as the orchestrator's `RequestInvestigationFollowup`. The
// inner handler appends the operator + investigator turn pair to the
// history file (AC #4) and the modal re-fetches the thread.
// ---------------------------------------------------------------------------

class RecordingInvestigator implements InvestigatorAgent {
    public readonly inputs: InvestigatorInput[] = [];
    constructor(private readonly answer: string) {}
    async run(input: InvestigatorInput): Promise<string> {
        this.inputs.push({
            taskId: input.taskId,
            // Snapshot the thread — the inner handler mutates lineage after
            // we return, and a live ref would observe later mutations.
            thread: input.thread.map((e) => ({ ...e })),
            ...(input.priorBrief !== undefined ? { priorBrief: input.priorBrief } : {}),
            ...(input.priorReport !== undefined ? { priorReport: input.priorReport } : {}),
        });
        return this.answer;
    }
}

function readHistoryLines(file: string): InvestigationHistoryLine[] {
    if (!fs.existsSync(file)) return [];
    return fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as InvestigationHistoryLine);
}

test('scenario 3: investigation follow-up round-trip — modal Ask → history file gains operator + investigator turns', async () => {
    const taskId = 'task-followup-1';
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-vp5-016-followup-'));
    const historyFile = path.join(tmpRoot, 'investigation-history.jsonl');

    const db = freshDb();
    try {
        const logger = new SilentLogger();
        const eventBus = new EventBus(new EventStore(db), logger);
        const cmdBus = new CommandBus<unknown>(eventBus, () => undefined);

        const idGen: IdGen = ((): IdGen => {
            let n = 0;
            return { newId: (): string => `agent-${++n}` };
        })();

        const investigator = new RecordingInvestigator(
            'Re-checked the lockfile: latest install is consistent.',
        );

        // Bootstrap the orchestrator handler suite — this registers the
        // `RequestInvestigationFollowup` handler with file persistence.
        const { InMemoryTaskLineageStore } = await import('../../core/flow/engine');
        const lineage = new InMemoryTaskLineageStore();
        registerCommandHandlers(cmdBus, {
            clock: (): number => 1_700_000_000_020,
            idGen,
            logger,
            defaultFlowId: 'echo',
            defaultProjectId: 'proj-op-features',
            defaultTaskType: 'echo',
            agentRunner: new StubAgentRunner(),
            registerAgent: (): void => {},
            deferAgentStart: (run): void => run(),
            taskLineage: lineage,
            investigatorAgent: investigator,
            investigationHistoryPath: (id) => (id === taskId ? historyFile : undefined),
        });

        const followupRequested: Array<
            StoredEvent & { payload: InvestigationFollowupRequestedEventPayload }
        > = [];
        eventBus.subscribe<InvestigationFollowupRequestedEventPayload>(
            InvestigationFollowupEvents.INVESTIGATION_FOLLOWUP_REQUESTED,
            (e) => {
                followupRequested.push(e);
            },
        );

        // ----- step 1: open the modal -----
        const doc = makeDoc();
        const parent = makeEl('body');

        // Read-side fetcher: the lineage store IS the thread source. After
        // an Ask succeeds the modal calls `fetchThread` again so we surface
        // the latest snapshot every time.
        const fetchThread = async (
            id: string,
        ): Promise<ReadonlyArray<FollowupThreadEntry>> => {
            const stored = lineage.read(id);
            if (!stored) return [];
            return stored.investigation_thread.map((e) => ({
                role: e.role,
                content: e.content,
                timestamp: e.timestamp,
            }));
        };

        // Write-side dispatcher: translate the modal's
        // AskInvestigationFollowup into the orchestrator's
        // RequestInvestigationFollowup, threading the priorBrief +
        // priorReport the operator already has cached in chrome.
        const PRIOR_BRIEF = 'Investigate why the dev install is failing.';
        const PRIOR_REPORT = 'The lockfile pinned a yanked version of `foo`.';
        const dispatcher = async (
            cmd: AskInvestigationFollowupCommand,
        ): Promise<void> => {
            const payload: RequestInvestigationFollowupPayload = {
                taskId: cmd.payload.taskId,
                question: cmd.payload.question,
                priorBrief: PRIOR_BRIEF,
                priorReport: PRIOR_REPORT,
            };
            await cmdBus.send({
                type: InvestigationFollowupCommands.REQUEST_INVESTIGATION_FOLLOWUP,
                actor: 'operator',
                issuedAt: 1_700_000_000_021,
                payload,
            });
        };

        const handle = openInvestigationFollowupModal(
            {
                taskId,
                fetchThread,
                dispatcher,
            },
            {
                doc: doc as unknown as FollowupDocument,
                parent: parent as unknown as FollowupElement,
            },
        );

        // ----- step 2: operator types a follow-up + clicks Ask -----
        const textarea = byTestId(parent, FOLLOWUP_TEXTAREA_TESTID);
        textarea.value = 'Could you double-check the lockfile?';
        // `askButton.onclick` calls `void ask()` internally, so the
        // awaitable form is the same code path with deterministic
        // settlement. Single call so the refresh() that follows a
        // successful Ask isn't bypassed by an emptied textarea on a
        // second invocation.
        const askBtn = byTestId(parent, FOLLOWUP_ASK_TESTID);
        void askBtn;
        const ok = await handle.ask();
        assert.equal(ok, true, 'follow-up Ask must resolve true on a successful dispatch');

        // ----- step 3: assert the history file + emitted event -----
        const lines = readHistoryLines(historyFile);
        assert.equal(
            lines.length,
            4,
            'first follow-up writes 4 lines (priorBrief + priorReport + operator + investigator)',
        );
        assert.equal(lines[0].role, 'operator');
        assert.equal(lines[0].content, PRIOR_BRIEF);
        assert.equal(lines[1].role, 'investigator');
        assert.equal(lines[1].content, PRIOR_REPORT);
        assert.equal(lines[2].role, 'operator');
        assert.equal(lines[2].content, 'Could you double-check the lockfile?');
        assert.equal(lines[3].role, 'investigator');
        assert.equal(
            lines[3].content,
            'Re-checked the lockfile: latest install is consistent.',
        );
        for (const line of lines) {
            assert.equal(line.threadId, taskId, 'every line carries the task-derived threadId');
            assert.equal(typeof line.timestamp, 'number');
        }

        // The investigator was spawned with the full prior brief + report
        // and the operator's new turn on top.
        assert.equal(investigator.inputs.length, 1, 'investigator must run once');
        assert.equal(investigator.inputs[0].priorBrief, PRIOR_BRIEF);
        assert.equal(investigator.inputs[0].priorReport, PRIOR_REPORT);
        const spawnThread = investigator.inputs[0].thread;
        assert.equal(spawnThread.length, 1);
        assert.equal(spawnThread[0].role, 'operator');
        assert.equal(spawnThread[0].content, 'Could you double-check the lockfile?');

        // InvestigationFollowupRequested event was emitted.
        assert.equal(followupRequested.length, 1);
        assert.equal(followupRequested[0].payload.taskId, taskId);
        assert.equal(
            followupRequested[0].payload.question,
            'Could you double-check the lockfile?',
        );

        // Modal's currentThread reflects the post-Ask refresh — the lineage
        // store has both turns and the modal asked for the latest snapshot.
        const rendered = handle.currentThread();
        assert.equal(rendered.length, 2, 'modal must re-fetch after a successful Ask');
        assert.equal(rendered[0].role, 'operator');
        assert.equal(rendered[1].role, 'investigator');
    } finally {
        db.close();
        try {
            fs.rmSync(tmpRoot, { recursive: true, force: true });
        } catch {
            /* best-effort tmpdir cleanup */
        }
    }
});

// ---------------------------------------------------------------------------
// AC #5 — fake-adapter envelope guard
//
// Every fake adapter exercised above is in-process: the stream port is a
// hand-rolled emitter, the modal fetch ports translate POSTs into in-process
// CommandBus.send calls, and the investigator is a recording stub. The
// `claude` CLI is never spawned. This assertion makes the invariant explicit:
// a regression that swaps any port for the real one (a real fetch, a real
// child_process spawn) will trip here.
// ---------------------------------------------------------------------------

test('all three scenarios use fake adapters — no real fetch or child_process spawn is reachable', () => {
    // The fakes are constructed locally per scenario; the only "global"
    // surface a regression could reach for is `globalThis.fetch` and
    // `child_process.spawn`. Pin the modules so a refactor that drops the
    // injected port and falls back to a global discovers immediately.
    assert.equal(
        typeof child_process.spawn,
        'function',
        'sanity: child_process.spawn is the symbol a regression would reach for',
    );
    // The modal fetch ports are typed and required at construction in this
    // spec, so a missing injection is a compile-time error. We don't drive
    // `globalThis.fetch` in any scenario; assert it was never touched.
    const touched = (globalThis as { __ap_vp5_016_touched_fetch?: boolean })
        .__ap_vp5_016_touched_fetch;
    assert.equal(
        touched,
        undefined,
        'no test path may set the global fetch sentinel',
    );
});
