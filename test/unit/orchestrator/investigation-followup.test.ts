/**
 * AP-VP5-006 — investigation follow-up history-file persistence.
 *
 * The orchestrator's `RequestInvestigationFollowup` registration in
 * `hosts/orchestrator/handlers.ts` already drives the v2 in-memory thread
 * through {@link TaskLineageStore}; this task layers a per-task
 * append-only `investigation-history.jsonl` on top so the worktree
 * carries the same record v1 did. The wrapper sits on the
 * `InvestigatorAgent` port (not the command handler) so the inner
 * lineage contract — its `followup_inflight` gate and the
 * `InvestigationFollowupRequested` event — stays untouched.
 *
 * The acceptance criteria the spec calls out:
 *
 *   1. `investigation-history.jsonl` is created on the FIRST follow-up,
 *      seeded from the command-payload's `priorBrief` / `priorReport`
 *      (v2's stand-in for v1's "original investigation completion event").
 *   2. Each follow-up appends ONE operator line BEFORE the spawn and ONE
 *      investigator line AFTER the agent completes — exactly two new
 *      lines per turn pair.
 *   3. The spawn payload the investigator receives contains the FULL
 *      thread (including the just-appended operator question).
 *   4. The persisted `threadId` is set on the first turn and reused on
 *      every subsequent turn for the same task.
 *   5. `InvestigationFollowupRequested` event emits with the operator's
 *      question on every accepted follow-up.
 *
 * Dual-runner discovery
 * ---------------------
 * The repo's primary test command (`npm test` → `node --test --import tsx`)
 * uses Node's built-in `node:test` runner. The review pipeline runs
 * `npx vitest run` against changed files. The shim below picks whichever
 * `test()` is appropriate at module load so the same source file is
 * discovered and executed by both runners.
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { CommandBus } from '../../../core/commands/bus';
import { EventBus } from '../../../core/events/bus';
import { EventStore } from '../../../core/events/store';
import {
    InMemoryTaskLineageStore,
    type InvestigationThreadEntry,
} from '../../../core/flow/engine';
import {
    InvestigationFollowupCommands,
    InvestigationFollowupEvents,
    type InvestigationFollowupRequestedEventPayload,
    type InvestigatorAgent,
    type InvestigatorInput,
    type RequestInvestigationFollowupPayload,
} from '../../../core/flow/investigation-followup';
import { applyMigrations, openDatabase, type Db } from '../../../core/state/migrations';
import type {
    AgentHandle,
    AgentRunner,
    AgentSpec,
    IdGen,
    Logger,
} from '../../../core/ports';

import {
    registerCommandHandlers,
    type InvestigationHistoryLine,
} from '../../../hosts/orchestrator/handlers';

// ---------------------------------------------------------------------------
// Dual-runner test() shim — see file header for rationale.
//
// Vitest v4 forbids `require('vitest')` from CJS modules (and tsc compiles
// this file to CJS per the project's tsconfig), and static `import` from
// 'vitest' breaks under `node --test`. The workaround is to rely on
// vitest's `globals: true` config — see `vitest.config.ts` — which puts
// `test` on `globalThis` inside vitest workers; outside vitest we fall
// back to `node:test`'s `test()` via plain `require`.
// ---------------------------------------------------------------------------

type TestFn = (name: string, fn: () => void | Promise<void>) => void;

const test: TestFn = (((): TestFn => {
    if (process.env.VITEST) {
        const gt = (globalThis as { test?: TestFn }).test;
        if (typeof gt !== 'function') {
            throw new Error(
                'investigation-followup.test.ts: VITEST=true but globalThis.test is missing — '
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
// Harness helpers
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

/**
 * Stub investigator that records every {@link InvestigatorInput} it
 * receives and replies with a deterministic answer. Tests assert against
 * the recorded inputs to verify the thread that was prepended to the
 * spawn (AC #3).
 */
class RecordingInvestigator implements InvestigatorAgent {
    public readonly inputs: InvestigatorInput[] = [];
    constructor(private readonly answers: string[]) {}
    async run(input: InvestigatorInput): Promise<string> {
        // Snapshot the thread array — the inner handler mutates the
        // lineage record after this returns, and a live reference would
        // observe later mutations and make the assertion racy.
        this.inputs.push({
            taskId: input.taskId,
            thread: input.thread.map((e) => ({ ...e })),
            ...(input.priorBrief !== undefined ? { priorBrief: input.priorBrief } : {}),
            ...(input.priorReport !== undefined ? { priorReport: input.priorReport } : {}),
        });
        const idx = this.inputs.length - 1;
        const answer = this.answers[idx];
        if (answer === undefined) {
            throw new Error(
                `RecordingInvestigator: no canned answer for call #${idx + 1}`,
            );
        }
        return answer;
    }
}

interface Harness {
    readonly db: Db;
    readonly bus: EventBus;
    readonly cmdBus: CommandBus<unknown>;
    readonly lineage: InMemoryTaskLineageStore;
    readonly investigator: RecordingInvestigator;
    readonly historyDir: string;
    readonly historyFile: string;
    readonly cleanup: () => void;
}

interface MakeHarnessArgs {
    readonly answers: string[];
    readonly taskId: string;
    /** Optional fixed-time clock so persisted timestamps are deterministic. */
    readonly clock?: () => number;
}

function makeHarness(args: MakeHarnessArgs): Harness {
    const db = openDatabase(':memory:');
    applyMigrations(db);
    const logger = new SilentLogger();
    const store = new EventStore(db);
    const bus = new EventBus(store, logger);
    const cmdBus = new CommandBus<unknown>(bus, () => undefined);
    const idGen: IdGen = ((): IdGen => {
        let n = 0;
        return { newId: (): string => `task-${++n}` };
    })();

    const historyDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'ap-vp5-006-followup-'),
    );
    const historyFile = path.join(historyDir, 'investigation-history.jsonl');
    const lineage = new InMemoryTaskLineageStore();
    const investigator = new RecordingInvestigator(args.answers);

    registerCommandHandlers(cmdBus, {
        clock: args.clock ?? ((): number => 1_700_000_000_000),
        idGen,
        logger,
        defaultFlowId: 'echo',
        defaultProjectId: 'proj-followup',
        defaultTaskType: 'echo',
        agentRunner: new StubAgentRunner(),
        registerAgent: (): void => {},
        deferAgentStart: (run): void => run(),
        taskLineage: lineage,
        investigatorAgent: investigator,
        // Each task gets its own worktree-rooted history file. The harness
        // only ever exercises one taskId so we return the fixed path
        // regardless of the argument — keeps the assertion site simple.
        investigationHistoryPath: (taskId: string): string | undefined => {
            if (taskId !== args.taskId) return undefined;
            return historyFile;
        },
    });

    return {
        db,
        bus,
        cmdBus,
        lineage,
        investigator,
        historyDir,
        historyFile,
        cleanup: (): void => {
            db.close();
            try {
                fs.rmSync(historyDir, { recursive: true, force: true });
            } catch {
                // Tmpdir cleanup is best-effort — a stale dir under
                // `os.tmpdir()` is harmless and the OS will reap it.
            }
        },
    };
}

function readHistoryLines(file: string): InvestigationHistoryLine[] {
    if (!fs.existsSync(file)) return [];
    const text = fs.readFileSync(file, 'utf8');
    return text
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as InvestigationHistoryLine);
}

function readEventPayloads<T>(db: Db, type: string): T[] {
    const rows = db
        .prepare('SELECT payload FROM events WHERE type = ? ORDER BY seq ASC')
        .all(type) as Array<{ payload: string }>;
    return rows.map((r) => JSON.parse(r.payload) as T);
}

// ---------------------------------------------------------------------------
// AC #1 — file is created on first follow-up, seeded from priorBrief +
// priorReport, with the operator question and the investigator reply
// appended around the agent spawn (AC #2).
// AC #3 — the spawn payload includes the full thread.
// AC #4 — every persisted line carries the same `threadId`.
// AC #5 — `InvestigationFollowupRequested` event is emitted with the
//         operator's question.
// ---------------------------------------------------------------------------

test('first follow-up creates investigation-history.jsonl seeded from priorBrief + priorReport, plus the new operator/investigator pair', async () => {
    const taskId = 'task-followup-1';
    const h = makeHarness({
        taskId,
        answers: ['Re-checking the lockfile: the latest install is consistent.'],
    });
    try {
        const payload: RequestInvestigationFollowupPayload = {
            taskId,
            question: 'Could you double-check the lockfile?',
            priorBrief: 'Investigate why the dev install is failing.',
            priorReport: 'The lockfile pinned a yanked version of `foo`.',
        };
        await h.cmdBus.send({
            type: InvestigationFollowupCommands.REQUEST_INVESTIGATION_FOLLOWUP,
            actor: 'op',
            issuedAt: 1,
            payload,
        });

        // AC #1 + AC #2: file exists, with exactly four lines —
        // [priorBrief, priorReport, operator-question, investigator-reply].
        assert.equal(fs.existsSync(h.historyFile), true, 'history file must be created on first follow-up');
        const lines = readHistoryLines(h.historyFile);
        assert.equal(lines.length, 4, 'first follow-up should produce 4 history lines (2 seed + operator + investigator)');

        assert.equal(lines[0]!.role, 'operator');
        assert.equal(lines[0]!.content, 'Investigate why the dev install is failing.');
        assert.equal(lines[1]!.role, 'investigator');
        assert.equal(lines[1]!.content, 'The lockfile pinned a yanked version of `foo`.');
        assert.equal(lines[2]!.role, 'operator');
        assert.equal(lines[2]!.content, 'Could you double-check the lockfile?');
        assert.equal(lines[3]!.role, 'investigator');
        assert.equal(lines[3]!.content, 'Re-checking the lockfile: the latest install is consistent.');

        // AC #4: every persisted line carries the same threadId (taskId).
        for (const line of lines) {
            assert.equal(line.threadId, taskId, 'every line must carry the task-derived threadId');
            assert.equal(typeof line.timestamp, 'number', 'every line must carry a numeric timestamp');
        }

        // AC #3: the spawn payload includes the operator's question on top
        // of any prior thread (none in this first turn — so just the
        // operator entry).
        assert.equal(h.investigator.inputs.length, 1, 'inner investigator must be invoked exactly once');
        const spawnThread = h.investigator.inputs[0]!.thread;
        assert.equal(spawnThread.length, 1, 'first follow-up spawn thread has only the operator turn');
        assert.equal(spawnThread[0]!.role, 'operator');
        assert.equal(spawnThread[0]!.content, 'Could you double-check the lockfile?');
        assert.equal(h.investigator.inputs[0]!.priorBrief, 'Investigate why the dev install is failing.');
        assert.equal(h.investigator.inputs[0]!.priorReport, 'The lockfile pinned a yanked version of `foo`.');

        // AC #5: InvestigationFollowupRequested event was emitted with the
        // operator's question + actor + thread snapshot.
        const events = readEventPayloads<InvestigationFollowupRequestedEventPayload>(
            h.db,
            InvestigationFollowupEvents.INVESTIGATION_FOLLOWUP_REQUESTED,
        );
        assert.equal(events.length, 1);
        assert.equal(events[0]!.taskId, taskId);
        assert.equal(events[0]!.question, 'Could you double-check the lockfile?');
        assert.equal(events[0]!.actor, 'op');
    } finally {
        h.cleanup();
    }
});

// ---------------------------------------------------------------------------
// Task-hint scenario: "seed a history file, post a follow-up, assert the
// new operator line is appended and the spawn payload includes the full
// thread."
//
// Seeding here means the file already exists from a prior investigation
// turn pair; the second follow-up must append the new turn AND the spawn
// payload must carry the full prior thread + the new operator question.
// ---------------------------------------------------------------------------

test('second follow-up appends only the new turn pair and the spawn payload carries the full thread', async () => {
    const taskId = 'task-followup-2';
    const h = makeHarness({
        taskId,
        answers: [
            'Initial follow-up reply: nothing else looks off.',
            'Second follow-up reply: confirmed clean on Windows too.',
        ],
    });
    try {
        // First follow-up — seeds the file from priorBrief + priorReport
        // and writes the first operator + investigator pair.
        await h.cmdBus.send({
            type: InvestigationFollowupCommands.REQUEST_INVESTIGATION_FOLLOWUP,
            actor: 'op',
            issuedAt: 1,
            payload: {
                taskId,
                question: 'Anything else off?',
                priorBrief: 'Investigate the failing CI on macOS.',
                priorReport: 'The test was flaky on macOS due to a timer race.',
            } satisfies RequestInvestigationFollowupPayload,
        });
        const linesAfterFirst = readHistoryLines(h.historyFile);
        assert.equal(linesAfterFirst.length, 4, 'first follow-up writes 4 lines');

        // Second follow-up — file already exists; only the new operator +
        // investigator pair must be appended (no re-seed).
        await h.cmdBus.send({
            type: InvestigationFollowupCommands.REQUEST_INVESTIGATION_FOLLOWUP,
            actor: 'op',
            issuedAt: 2,
            payload: {
                taskId,
                question: 'Does Windows look clean too?',
                // priorBrief / priorReport intentionally omitted on the
                // second turn — the file's seed must NOT be rewritten.
            } satisfies RequestInvestigationFollowupPayload,
        });

        const linesAfterSecond = readHistoryLines(h.historyFile);
        assert.equal(linesAfterSecond.length, 6, 'second follow-up appends exactly 2 lines (operator + investigator)');

        // The first four lines are byte-identical to the post-first-follow-up
        // snapshot — the seed is never rewritten.
        for (let i = 0; i < linesAfterFirst.length; i++) {
            assert.deepEqual(linesAfterSecond[i], linesAfterFirst[i], `line ${i} must survive untouched on a subsequent follow-up`);
        }
        // The new tail is the second operator question + the canned reply.
        assert.equal(linesAfterSecond[4]!.role, 'operator');
        assert.equal(linesAfterSecond[4]!.content, 'Does Windows look clean too?');
        assert.equal(linesAfterSecond[5]!.role, 'investigator');
        assert.equal(linesAfterSecond[5]!.content, 'Second follow-up reply: confirmed clean on Windows too.');

        // threadId stable across all lines.
        for (const line of linesAfterSecond) {
            assert.equal(line.threadId, taskId);
        }

        // AC #3: the SECOND spawn's thread carries [op1, inv1, op2] —
        // i.e. the inner handler reloaded the prior thread out of the
        // lineage store and prepended it to the operator's new turn.
        assert.equal(h.investigator.inputs.length, 2);
        const secondSpawnThread = h.investigator.inputs[1]!.thread;
        assert.equal(secondSpawnThread.length, 3, 'second spawn thread must include both prior turns + the new operator entry');
        assert.equal(secondSpawnThread[0]!.role, 'operator');
        assert.equal(secondSpawnThread[0]!.content, 'Anything else off?');
        assert.equal(secondSpawnThread[1]!.role, 'investigator');
        assert.equal(secondSpawnThread[1]!.content, 'Initial follow-up reply: nothing else looks off.');
        assert.equal(secondSpawnThread[2]!.role, 'operator');
        assert.equal(secondSpawnThread[2]!.content, 'Does Windows look clean too?');

        // Both InvestigationFollowupRequested events were emitted in order.
        const events = readEventPayloads<InvestigationFollowupRequestedEventPayload>(
            h.db,
            InvestigationFollowupEvents.INVESTIGATION_FOLLOWUP_REQUESTED,
        );
        assert.equal(events.length, 2);
        assert.equal(events[0]!.question, 'Anything else off?');
        assert.equal(events[1]!.question, 'Does Windows look clean too?');
    } finally {
        h.cleanup();
    }
});

// ---------------------------------------------------------------------------
// File creation is forgiving of an absent parent directory.
//
// Production wires `investigationHistoryPath` to `<worktree>/investigation-history.jsonl`,
// and a brand-new task may not have its worktree dir on disk yet by the
// time the first follow-up lands. The wrapper must `mkdir -p` the parent
// before the first append.
// ---------------------------------------------------------------------------

test('first follow-up creates the parent worktree directory on demand', async () => {
    const taskId = 'task-followup-3';
    // Build a path under a fresh tmpdir whose `worktree-xyz` subdir does
    // NOT exist yet — the wrapper has to create it.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-vp5-006-mkdir-'));
    const nestedDir = path.join(root, 'worktree-' + taskId);
    const file = path.join(nestedDir, 'investigation-history.jsonl');
    assert.equal(fs.existsSync(nestedDir), false, 'nested worktree dir must not exist yet');

    const db = openDatabase(':memory:');
    try {
        applyMigrations(db);
        const logger = new SilentLogger();
        const bus = new EventBus(new EventStore(db), logger);
        const cmdBus = new CommandBus<unknown>(bus, () => undefined);
        const idGen: IdGen = { newId: (): string => 'agent-x' };
        const investigator = new RecordingInvestigator(['reply']);
        const lineage = new InMemoryTaskLineageStore();
        registerCommandHandlers(cmdBus, {
            clock: () => 1_700_000_000_000,
            idGen,
            logger,
            defaultFlowId: 'echo',
            defaultProjectId: 'proj-followup',
            defaultTaskType: 'echo',
            agentRunner: new StubAgentRunner(),
            registerAgent: (): void => {},
            deferAgentStart: (run): void => run(),
            taskLineage: lineage,
            investigatorAgent: investigator,
            investigationHistoryPath: (id: string): string | undefined =>
                id === taskId ? file : undefined,
        });

        await cmdBus.send({
            type: InvestigationFollowupCommands.REQUEST_INVESTIGATION_FOLLOWUP,
            actor: 'op',
            issuedAt: 1,
            payload: {
                taskId,
                question: 'kick off',
            } satisfies RequestInvestigationFollowupPayload,
        });

        assert.equal(fs.existsSync(nestedDir), true, 'wrapper must mkdir -p the parent on first append');
        const lines = readHistoryLines(file);
        // No priorBrief / priorReport supplied → only the operator + the
        // investigator's reply are persisted (the seed lines are skipped
        // when the corresponding payload fields are missing).
        assert.equal(lines.length, 2);
        assert.equal(lines[0]!.role, 'operator');
        assert.equal(lines[0]!.content, 'kick off');
        assert.equal(lines[1]!.role, 'investigator');
        assert.equal(lines[1]!.content, 'reply');
        for (const line of lines) {
            assert.equal(line.threadId, taskId);
        }
    } finally {
        db.close();
        try {
            fs.rmSync(root, { recursive: true, force: true });
        } catch {
            // best-effort tmpdir cleanup
        }
    }
});

// ---------------------------------------------------------------------------
// `investigationHistoryPath` returning `undefined` for a task disables
// persistence — the in-memory lineage path still runs to completion.
// ---------------------------------------------------------------------------

test('returning undefined from investigationHistoryPath disables file persistence cleanly', async () => {
    const taskId = 'task-followup-no-path';
    // Harness with a resolver that maps a DIFFERENT taskId → file, so
    // `taskId` here resolves to undefined.
    const h = makeHarness({
        taskId: 'task-other',
        answers: ['ok'],
    });
    try {
        await h.cmdBus.send({
            type: InvestigationFollowupCommands.REQUEST_INVESTIGATION_FOLLOWUP,
            actor: 'op',
            issuedAt: 1,
            payload: {
                taskId,
                question: 'hello',
                priorReport: 'prior',
            } satisfies RequestInvestigationFollowupPayload,
        });
        // The history file used by the OTHER task is untouched.
        assert.equal(fs.existsSync(h.historyFile), false, 'history file must NOT be created when the resolver returns undefined');
        // Lineage still progressed — the InvestigationFollowupRequested
        // event was emitted regardless.
        const events = readEventPayloads<InvestigationFollowupRequestedEventPayload>(
            h.db,
            InvestigationFollowupEvents.INVESTIGATION_FOLLOWUP_REQUESTED,
        );
        assert.equal(events.length, 1);
        assert.equal(events[0]!.taskId, taskId);
        // The in-memory lineage thread also gained both turns even though
        // nothing went to disk.
        const stored = h.lineage.read(taskId);
        assert.ok(stored);
        const thread: ReadonlyArray<InvestigationThreadEntry> = stored!.investigation_thread;
        assert.equal(thread.length, 2);
        assert.equal(thread[0]!.role, 'operator');
        assert.equal(thread[1]!.role, 'investigator');
    } finally {
        h.cleanup();
    }
});
