/**
 * Board-UI command vocabulary tests (AP-IFG-008).
 *
 * Dual-runner discovery
 * ---------------------
 * The repo's own test command (`npm test` → `node --test --import tsx`,
 * see package.json) uses Node's built-in `node:test` runner. The review
 * pipeline however runs `npx vitest run` on the changed test file. A
 * file written against only one of those APIs gets reported as
 * "no tests" by the other and the pipeline rejects the run.
 *
 * The shim below picks the right `test()` at module load: vitest sets
 * `process.env.VITEST=true` in its worker, so we route through vitest's
 * API there (via `globalThis.test`, enabled by `test.globals = true` in
 * vitest.config.ts) and through `node:test`'s API everywhere else. Both
 * runners therefore discover and execute the same suite from a single
 * source file.
 *
 * Vitest v4 forbids `require('vitest')` from CJS modules (see
 * node_modules/vitest/index.cjs:1), and tsc compiles this file to CJS
 * per the project's tsconfig — so a static `import` from 'vitest' would
 * also break under `node --test`. The `globalThis`-based fallback is the
 * only shape that survives both runners.
 *
 * `assert` stays on `node:assert/strict`: it is part of Node's standard
 * library and works identically under both runners, so there is no need
 * to swap to `expect()`.
 */
import * as assert from 'node:assert/strict';

import { NoopAgentRunKiller } from '../../adapters/claude-cli/NoopAgentRunKiller';
import { CommandBus } from '../../core/commands/bus';
import { EventBus } from '../../core/events/bus';
import { EventStore } from '../../core/events/store';
import { applyMigrations, openDatabase, type Db } from '../../core/state/migrations';
import type { Command } from '../../core/commands/command';
import type { StoredEvent } from '../../core/events/event';
import type { IdGen } from '../../core/ports/IdGen';
import type { Logger } from '../../core/ports/Logger';

import {
    BOARD_UI_COMMAND_ROUTES,
    BoardUiCommands,
    BoardUiEvents,
    registerBoardUiCommands,
    type AgentRunCancelledPayload,
    type AgentRunKiller,
    type ArchiveProjectPayload,
    type CancelAgentRunPayload,
    type CreateInvestigationPayload,
    type CreateNotePayload,
    type CreatePlanPayload,
    type CreateProjectPayload,
    type DeleteNotePayload,
    type DeletePlanPayload,
    type DeleteTaskPayload,
    type InvestigationRequestedPayload,
    type NoteCreatedPayload,
    type NoteDeletedPayload,
    type NoteUpdatedPayload,
    type PlanCreatedPayload,
    type PlanDeletedPayload,
    type PlanUpdatedPayload,
    type ProjectArchivedPayload,
    type ProjectCreatedPayload,
    type ProjectUpdatedPayload,
    type TaskDeletedPayload,
    type TaskFieldsUpdatedPayload,
    type UpdateNotePayload,
    type UpdatePlanPayload,
    type UpdateProjectPayload,
    type UpdateTaskPayload,
} from './commands';
import {
    PlanOpsCommands,
    ProjectOpsCommands,
    TaskOpsCommands,
} from '../../core/commands';

// ---------------------------------------------------------------------------
// Dual-runner test() shim — see file header for rationale.
// ---------------------------------------------------------------------------

type TestFn = (name: string, fn: () => void | Promise<void>) => void;

const test: TestFn = (((): TestFn => {
    if (process.env.VITEST) {
        const gt = (globalThis as { test?: TestFn }).test;
        if (typeof gt !== 'function') {
            throw new Error(
                'commands.test.ts: VITEST=true but globalThis.test is missing — '
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
// Harness
// ---------------------------------------------------------------------------

class TestLogger implements Logger {
    info(): void {}
    warn(): void {}
    debug(): void {}
    error(): void {}
}

interface LogEntry {
    readonly level: 'info' | 'warn' | 'error' | 'debug';
    readonly message: string;
    readonly meta?: Readonly<Record<string, unknown>>;
}

class RecordingLogger implements Logger {
    readonly entries: LogEntry[] = [];
    info(message: string, meta?: Readonly<Record<string, unknown>>): void {
        this.entries.push({ level: 'info', message, meta });
    }
    warn(message: string, meta?: Readonly<Record<string, unknown>>): void {
        this.entries.push({ level: 'warn', message, meta });
    }
    error(message: string, meta?: Readonly<Record<string, unknown>>): void {
        this.entries.push({ level: 'error', message, meta });
    }
    debug(message: string, meta?: Readonly<Record<string, unknown>>): void {
        this.entries.push({ level: 'debug', message, meta });
    }
}

function fakeIdGen(prefix = 'gen'): IdGen {
    let n = 0;
    return { newId: (): string => `${prefix}-${++n}` };
}

function fixedClock(start = 1_700_000_000_000): () => number {
    let t = start;
    return (): number => t++;
}

class RecordingKiller implements AgentRunKiller {
    readonly killed: string[] = [];
    private throwOnNext: Error | undefined;

    kill(runId: string): Promise<void> {
        this.killed.push(runId);
        if (this.throwOnNext) {
            const err = this.throwOnNext;
            this.throwOnNext = undefined;
            return Promise.reject(err);
        }
        return Promise.resolve();
    }

    failNext(err: Error): void {
        this.throwOnNext = err;
    }
}

interface Harness {
    readonly bus: CommandBus<unknown>;
    readonly recorded: StoredEvent[];
    readonly killer: RecordingKiller;
    readonly db: Db;
    readonly logger: RecordingLogger;
}

function freshDb(): Db {
    const db = openDatabase(':memory:');
    applyMigrations(db);
    return db;
}

function buildHarness(): Harness {
    const db = freshDb();
    const store = new EventStore(db);
    const events = new EventBus(store, new TestLogger());
    const cmdBus = new CommandBus<unknown>(events, () => undefined);
    const recorded: StoredEvent[] = [];
    events.subscribeAll((e) => {
        recorded.push(e);
    });
    const killer = new RecordingKiller();
    const logger = new RecordingLogger();
    registerBoardUiCommands(cmdBus, {
        clock: fixedClock(),
        idGen: fakeIdGen(),
        runner: killer,
        logger,
    });
    return { bus: cmdBus, recorded, killer, db, logger };
}

function makeCommand<TPayload>(
    type: string,
    payload: TPayload,
    actor = 'operator-1',
    issuedAt = 1_700_000_000_000,
): Command<TPayload> {
    return { type, actor, issuedAt, payload };
}

// ---------------------------------------------------------------------------
// AC #1 — every command type is exported (snapshot guard)
// ---------------------------------------------------------------------------

test('BoardUiCommands exports all command types', () => {
    const expected = new Set([
        'CreateProject',
        'UpdateProject',
        // Project architecture context. Separate from UpdateProject
        // because it writes its own column (migration 034) rather than
        // the metadata blob, and because renaming a project must not
        // round-trip a page of markdown.
        'UpdateProjectContext',
        'ArchiveProject',
        'CreatePlan',
        'UpdatePlan',
        'DeletePlan',
        'EditTask',
        'DeleteTask',
        'CreateInvestigation',
        'CreateNote',
        'UpdateNote',
        'DeleteNote',
        'CancelAgentRun',
        // AP-IFF-013 — taskId-keyed interrupt; handler lives in the
        // worker-api host (filesystem side effect) and is not wired by
        // `registerBoardUiCommands` in this module.
        'InterruptTask',
    ]);
    const actual = new Set(Object.values(BoardUiCommands));
    assert.deepEqual(actual, expected);
});

test('BOARD_UI_COMMAND_ROUTES exposes a route entry per command', () => {
    const routeCommandTypes = new Set(
        Object.values(BOARD_UI_COMMAND_ROUTES).map((r) => r.commandType),
    );
    // AP-PAO-005 expanded the table with task/plan/project-ops symbols from
    // core/commands, so the route set is now a superset of BoardUiCommands.
    for (const commandType of Object.values(BoardUiCommands)) {
        assert.ok(
            routeCommandTypes.has(commandType),
            `missing route entry for ${commandType}`,
        );
    }
});

// ---------------------------------------------------------------------------
// AP-PAO-005 — task/plan/project-ops command symbols resolve to a non-empty
// route definition each. The wire symbols live in core/commands so the
// orchestrator host can register matching handlers against the same strings.
// ---------------------------------------------------------------------------

test('BOARD_UI_COMMAND_ROUTES resolves the AP-PAO-005 task-ops commands', () => {
    const byType = new Map(
        Object.values(BOARD_UI_COMMAND_ROUTES).map((r) => [r.commandType, r]),
    );
    for (const commandType of [
        TaskOpsCommands.SKIP_TASK,
        TaskOpsCommands.RETRY_TASK,
        PlanOpsCommands.ARCHIVE_PLAN,
        PlanOpsCommands.DELETE_PLAN,
        ProjectOpsCommands.UPDATE_PROJECT_APPROVAL_OVERRIDE,
    ]) {
        const route = byType.get(commandType);
        assert.ok(route, `missing route entry for ${commandType}`);
        const r = route as { commandType: string; validate: unknown };
        assert.equal(typeof r.commandType, 'string');
        assert.ok(r.commandType.length > 0);
        assert.equal(typeof r.validate, 'function');
    }
});

// ---------------------------------------------------------------------------
// AC #2 + AC #5 — every handler is registered AND emits a domain event
// ---------------------------------------------------------------------------

test('CreateProject emits ProjectCreated with generated id when none supplied', async () => {
    const h = buildHarness();
    const stored = await h.bus.send(
        makeCommand<CreateProjectPayload>(BoardUiCommands.CREATE_PROJECT, {
            name: 'Demo',
            description: 'hello',
        }),
    );
    assert.equal(stored.length, 1);
    assert.equal(stored[0].type, BoardUiEvents.PROJECT_CREATED);
    const payload = stored[0].payload as ProjectCreatedPayload;
    assert.equal(payload.projectId, 'gen-1');
    assert.equal(payload.name, 'Demo');
    assert.equal(payload.description, 'hello');
    assert.equal(payload.actor, 'operator-1');
    assert.equal(stored[0].idempotencyKey, 'CreateProject:gen-1');
});

test('CreateProject honours a caller-supplied projectId', async () => {
    const h = buildHarness();
    const stored = await h.bus.send(
        makeCommand<CreateProjectPayload>(BoardUiCommands.CREATE_PROJECT, {
            projectId: 'proj-fixed',
            name: 'Pinned',
        }),
    );
    const payload = stored[0].payload as ProjectCreatedPayload;
    assert.equal(payload.projectId, 'proj-fixed');
    assert.equal(stored[0].idempotencyKey, 'CreateProject:proj-fixed');
});

test('CreateProject omits description from the event payload when not supplied', async () => {
    const h = buildHarness();
    const stored = await h.bus.send(
        makeCommand<CreateProjectPayload>(BoardUiCommands.CREATE_PROJECT, {
            name: 'No desc',
        }),
    );
    const payload = stored[0].payload as Record<string, unknown>;
    assert.equal(Object.prototype.hasOwnProperty.call(payload, 'description'), false);
});

test('UpdateProject emits ProjectUpdated carrying only the supplied fields', async () => {
    const h = buildHarness();
    const stored = await h.bus.send(
        makeCommand<UpdateProjectPayload>(BoardUiCommands.UPDATE_PROJECT, {
            projectId: 'p-1',
            description: 'changed',
        }),
    );
    assert.equal(stored[0].type, BoardUiEvents.PROJECT_UPDATED);
    const payload = stored[0].payload as ProjectUpdatedPayload &
        Record<string, unknown>;
    assert.equal(payload.description, 'changed');
    assert.equal(Object.prototype.hasOwnProperty.call(payload, 'name'), false);
});

test('ArchiveProject emits ProjectArchived with a deterministic idempotency key', async () => {
    const h = buildHarness();
    const stored = await h.bus.send(
        makeCommand<ArchiveProjectPayload>(BoardUiCommands.ARCHIVE_PROJECT, {
            projectId: 'p-1',
        }),
    );
    assert.equal(stored[0].type, BoardUiEvents.PROJECT_ARCHIVED);
    const payload = stored[0].payload as ProjectArchivedPayload;
    assert.equal(payload.projectId, 'p-1');
    assert.equal(payload.actor, 'operator-1');
    assert.equal(stored[0].idempotencyKey, 'ArchiveProject:p-1');
});

test('CreatePlan emits PlanCreated and synthesises an id when missing', async () => {
    const h = buildHarness();
    const stored = await h.bus.send(
        makeCommand<CreatePlanPayload>(BoardUiCommands.CREATE_PLAN, {
            projectId: 'p-1',
            title: 'Sprint 4',
            body: '# goals',
        }),
    );
    assert.equal(stored[0].type, BoardUiEvents.PLAN_CREATED);
    const payload = stored[0].payload as PlanCreatedPayload;
    assert.equal(payload.planId, 'gen-1');
    assert.equal(payload.projectId, 'p-1');
    assert.equal(payload.title, 'Sprint 4');
    assert.equal(payload.body, '# goals');
});

test('UpdatePlan emits PlanUpdated', async () => {
    const h = buildHarness();
    const stored = await h.bus.send(
        makeCommand<UpdatePlanPayload>(BoardUiCommands.UPDATE_PLAN, {
            planId: 'pl-1',
            title: 'renamed',
        }),
    );
    assert.equal(stored[0].type, BoardUiEvents.PLAN_UPDATED);
    const payload = stored[0].payload as PlanUpdatedPayload;
    assert.equal(payload.planId, 'pl-1');
    assert.equal(payload.title, 'renamed');
});

test('DeletePlan emits PlanDeleted', async () => {
    const h = buildHarness();
    const stored = await h.bus.send(
        makeCommand<DeletePlanPayload>(BoardUiCommands.DELETE_PLAN, {
            planId: 'pl-9',
        }),
    );
    assert.equal(stored[0].type, BoardUiEvents.PLAN_DELETED);
    const payload = stored[0].payload as PlanDeletedPayload;
    assert.equal(payload.planId, 'pl-9');
    assert.equal(stored[0].idempotencyKey, 'DeletePlan:pl-9');
});

test('EditTask emits TaskFieldsUpdated (aliased away from the lineage TaskUpdated)', async () => {
    const h = buildHarness();
    const stored = await h.bus.send(
        makeCommand<UpdateTaskPayload>(BoardUiCommands.EDIT_TASK, {
            taskId: 't-1',
            title: 'tweak',
            type: 'implement',
        }),
    );
    assert.equal(stored[0].type, BoardUiEvents.TASK_FIELDS_UPDATED);
    const payload = stored[0].payload as TaskFieldsUpdatedPayload;
    assert.equal(payload.taskId, 't-1');
    assert.equal(payload.title, 'tweak');
    assert.equal(payload.type, 'implement');
});

test('DeleteTask emits TaskDeleted', async () => {
    const h = buildHarness();
    const stored = await h.bus.send(
        makeCommand<DeleteTaskPayload>(BoardUiCommands.DELETE_TASK, {
            taskId: 't-1',
        }),
    );
    assert.equal(stored[0].type, BoardUiEvents.TASK_DELETED);
    const payload = stored[0].payload as TaskDeletedPayload;
    assert.equal(payload.taskId, 't-1');
});

test('CreateInvestigation emits InvestigationRequested with a generated investigationId', async () => {
    const h = buildHarness();
    const stored = await h.bus.send(
        makeCommand<CreateInvestigationPayload>(BoardUiCommands.CREATE_INVESTIGATION, {
            taskId: 't-2',
            question: 'why?',
        }),
    );
    assert.equal(stored[0].type, BoardUiEvents.INVESTIGATION_REQUESTED);
    const payload = stored[0].payload as InvestigationRequestedPayload;
    assert.equal(payload.investigationId, 'gen-1');
    assert.equal(payload.taskId, 't-2');
    assert.equal(payload.question, 'why?');
    assert.equal(stored[0].idempotencyKey, 'CreateInvestigation:gen-1');
});

test('CreateNote emits NoteCreated and synthesises an id when missing', async () => {
    const h = buildHarness();
    const stored = await h.bus.send(
        makeCommand<CreateNotePayload>(BoardUiCommands.CREATE_NOTE, {
            targetType: 'task',
            targetId: 't-1',
            body: 'hand-off note',
        }),
    );
    assert.equal(stored[0].type, BoardUiEvents.NOTE_CREATED);
    const payload = stored[0].payload as NoteCreatedPayload;
    assert.equal(payload.noteId, 'gen-1');
    assert.equal(payload.targetType, 'task');
    assert.equal(payload.targetId, 't-1');
    assert.equal(payload.body, 'hand-off note');
});

test('UpdateNote emits NoteUpdated', async () => {
    const h = buildHarness();
    const stored = await h.bus.send(
        makeCommand<UpdateNotePayload>(BoardUiCommands.UPDATE_NOTE, {
            noteId: 'n-1',
            body: 'revised',
        }),
    );
    assert.equal(stored[0].type, BoardUiEvents.NOTE_UPDATED);
    const payload = stored[0].payload as NoteUpdatedPayload;
    assert.equal(payload.noteId, 'n-1');
    assert.equal(payload.body, 'revised');
});

test('DeleteNote emits NoteDeleted', async () => {
    const h = buildHarness();
    const stored = await h.bus.send(
        makeCommand<DeleteNotePayload>(BoardUiCommands.DELETE_NOTE, {
            noteId: 'n-1',
        }),
    );
    assert.equal(stored[0].type, BoardUiEvents.NOTE_DELETED);
    const payload = stored[0].payload as NoteDeletedPayload;
    assert.equal(payload.noteId, 'n-1');
});

// ---------------------------------------------------------------------------
// AC #4 — CancelAgentRun calls runner.kill(runId) AND emits AgentRunCancelled
// ---------------------------------------------------------------------------

test('CancelAgentRun delegates to runner.kill(runId) and emits AgentRunCancelled', async () => {
    const h = buildHarness();
    const stored = await h.bus.send(
        makeCommand<CancelAgentRunPayload>(BoardUiCommands.CANCEL_AGENT_RUN, {
            runId: 'run-7',
            reason: 'wrong direction',
        }),
    );
    assert.deepEqual(h.killer.killed, ['run-7']);
    assert.equal(stored[0].type, BoardUiEvents.AGENT_RUN_CANCELLED);
    const payload = stored[0].payload as AgentRunCancelledPayload;
    assert.equal(payload.runId, 'run-7');
    assert.equal(payload.reason, 'wrong direction');
    assert.equal(payload.actor, 'operator-1');
});

test('CancelAgentRun omits reason from the event payload when none was supplied', async () => {
    const h = buildHarness();
    const stored = await h.bus.send(
        makeCommand<CancelAgentRunPayload>(BoardUiCommands.CANCEL_AGENT_RUN, {
            runId: 'run-9',
        }),
    );
    const payload = stored[0].payload as Record<string, unknown>;
    assert.equal(Object.prototype.hasOwnProperty.call(payload, 'reason'), false);
});

test('CancelAgentRun propagates a runner failure and does NOT emit the cancellation event', async () => {
    const h = buildHarness();
    h.killer.failNext(new Error('kill failed'));
    await assert.rejects(
        h.bus.send(
            makeCommand<CancelAgentRunPayload>(BoardUiCommands.CANCEL_AGENT_RUN, {
                runId: 'run-doomed',
            }),
        ),
        /kill failed/,
    );
    assert.deepEqual(h.killer.killed, ['run-doomed']);
    const cancelled = h.recorded.filter(
        (e) => e.type === BoardUiEvents.AGENT_RUN_CANCELLED,
    );
    assert.equal(cancelled.length, 0);
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

test('handlers reject malformed payloads with a descriptive error', async () => {
    const h = buildHarness();
    await assert.rejects(
        h.bus.send(
            makeCommand<CreateProjectPayload>(
                BoardUiCommands.CREATE_PROJECT,
                { name: '' } as CreateProjectPayload,
            ),
        ),
        /invalid payload/i,
    );
    await assert.rejects(
        h.bus.send(
            makeCommand<UpdateTaskPayload>(
                BoardUiCommands.EDIT_TASK,
                { taskId: '' } as UpdateTaskPayload,
            ),
        ),
        /invalid payload/i,
    );
    await assert.rejects(
        h.bus.send(
            makeCommand<CancelAgentRunPayload>(
                BoardUiCommands.CANCEL_AGENT_RUN,
                { runId: 1 as unknown as string } as CancelAgentRunPayload,
            ),
        ),
        /invalid payload/i,
    );
});

test('CreateNote rejects an unknown targetType', async () => {
    const h = buildHarness();
    await assert.rejects(
        h.bus.send(
            makeCommand<CreateNotePayload>(
                BoardUiCommands.CREATE_NOTE,
                {
                    targetType: 'bogus' as unknown as 'task',
                    targetId: 't-1',
                    body: 'x',
                } as CreateNotePayload,
            ),
        ),
        /invalid payload/i,
    );
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

test('duplicate ArchiveProject dispatches collapse to a single stored event', async () => {
    const h = buildHarness();
    const first = await h.bus.send(
        makeCommand<ArchiveProjectPayload>(BoardUiCommands.ARCHIVE_PROJECT, {
            projectId: 'p-dup',
        }),
    );
    const second = await h.bus.send(
        makeCommand<ArchiveProjectPayload>(BoardUiCommands.ARCHIVE_PROJECT, {
            projectId: 'p-dup',
        }),
    );
    assert.equal(first[0].seq, second[0].seq, 'event store de-duped by idempotency key');
});

// ---------------------------------------------------------------------------
// Logging — reviewer feedback (AP-IFG-008): every handler logs entry + rejection
// ---------------------------------------------------------------------------

test('handlers emit an info-level entry log carrying {type, actor, idempotencyKey}', async () => {
    const h = buildHarness();
    await h.bus.send(
        makeCommand<CreateProjectPayload>(BoardUiCommands.CREATE_PROJECT, {
            projectId: 'p-log-1',
            name: 'Logged',
        }),
    );
    const infos = h.logger.entries.filter((e) => e.level === 'info');
    assert.ok(infos.length >= 1, 'expected at least one info-level entry log');
    const entry = infos.find(
        (e) => e.meta?.type === BoardUiCommands.CREATE_PROJECT,
    );
    assert.ok(entry, 'entry log for CreateProject not found');
    assert.equal(entry?.meta?.actor, 'operator-1');
    assert.equal(entry?.meta?.idempotencyKey, 'CreateProject:p-log-1');
});

test('handlers emit a warn-level rejection log on invalid payload', async () => {
    const h = buildHarness();
    await assert.rejects(
        h.bus.send(
            makeCommand<CreateProjectPayload>(
                BoardUiCommands.CREATE_PROJECT,
                { name: '' } as CreateProjectPayload,
            ),
        ),
        /invalid payload/i,
    );
    const warns = h.logger.entries.filter((e) => e.level === 'warn');
    assert.ok(warns.length >= 1, 'expected at least one rejection (warn) log');
    const rejected = warns.find(
        (e) =>
            e.meta?.type === BoardUiCommands.CREATE_PROJECT &&
            /rejected/i.test(e.message),
    );
    assert.ok(rejected, 'rejection log for CreateProject not found');
    assert.equal(rejected?.meta?.actor, 'operator-1');
});

test('CancelAgentRun runner failure produces an error-level rejection log', async () => {
    const h = buildHarness();
    h.killer.failNext(new Error('kill failed'));
    await assert.rejects(
        h.bus.send(
            makeCommand<CancelAgentRunPayload>(BoardUiCommands.CANCEL_AGENT_RUN, {
                runId: 'run-doomed-2',
            }),
        ),
        /kill failed/,
    );
    const errors = h.logger.entries.filter((e) => e.level === 'error');
    assert.ok(errors.length >= 1, 'expected at least one error-level rejection log');
    const failure = errors.find(
        (e) =>
            e.meta?.type === BoardUiCommands.CANCEL_AGENT_RUN &&
            e.meta?.runId === 'run-doomed-2',
    );
    assert.ok(failure, 'runner-failure log for CancelAgentRun not found');
    assert.equal(failure?.meta?.error, 'kill failed');
});

// ---------------------------------------------------------------------------
// AP-IFE-004 — CancelAgentRun resolves cleanly under the no-op killer path
//
// When the orchestrator boots with AGENT_RUNNER=fake (the default), the
// host wires `NoopAgentRunKiller` into `registerBoardUiCommands` because
// there is no live `claude` process to signal. The handler still has to
// resolve and emit `AgentRunCancelled` so subscribers do not stall waiting
// for a signal that will never arrive.
// ---------------------------------------------------------------------------

test('CancelAgentRun resolves cleanly when NoopAgentRunKiller is wired', async () => {
    const db = freshDb();
    const store = new EventStore(db);
    const events = new EventBus(store, new TestLogger());
    const cmdBus = new CommandBus<unknown>(events, () => undefined);
    const recorded: StoredEvent[] = [];
    events.subscribeAll((e) => {
        recorded.push(e);
    });
    const logger = new RecordingLogger();
    registerBoardUiCommands(cmdBus, {
        clock: fixedClock(),
        idGen: fakeIdGen(),
        runner: new NoopAgentRunKiller({ logger }),
        logger,
    });

    const stored = await cmdBus.send(
        makeCommand<CancelAgentRunPayload>(BoardUiCommands.CANCEL_AGENT_RUN, {
            runId: 'noop-run',
            reason: 'fake runner, nothing to signal',
        }),
    );

    assert.equal(stored.length, 1);
    assert.equal(stored[0].type, BoardUiEvents.AGENT_RUN_CANCELLED);
    const payload = stored[0].payload as AgentRunCancelledPayload;
    assert.equal(payload.runId, 'noop-run');
    assert.equal(payload.reason, 'fake runner, nothing to signal');
    assert.equal(payload.actor, 'operator-1');
    const cancelled = recorded.filter(
        (e) => e.type === BoardUiEvents.AGENT_RUN_CANCELLED,
    );
    assert.equal(cancelled.length, 1, 'exactly one cancellation event reached the bus');
});


/** A complete context, and one cut off mid-thought. */
const CONTEXT_MD = ['# Ctx', '', 'Two APIs.'].join('\n');
const TRUNCATED_MD = ['# Arch', '', '**Key systems:**'].join('\n');

test('UpdateProjectContext emits ProjectContextUpdated with the markdown', async () => {
    const h = buildHarness();
    await h.bus.send(
        makeCommand(BoardUiCommands.UPDATE_PROJECT_CONTEXT, {
            projectId: 'p1',
            context: CONTEXT_MD,
        }),
    );
    const event = h.recorded.find(
        (e) => e.type === BoardUiEvents.PROJECT_CONTEXT_UPDATED,
    );
    assert.ok(event, 'the command must emit its event');
    assert.deepEqual(event!.payload, {
        projectId: 'p1',
        context: CONTEXT_MD,
    });
});

test('an empty context is accepted — it clears the project context', async () => {
    const h = buildHarness();
    await h.bus.send(
        makeCommand(BoardUiCommands.UPDATE_PROJECT_CONTEXT, {
            projectId: 'p1',
            context: '',
        }),
    );
    assert.ok(
        h.recorded.some((e) => e.type === BoardUiEvents.PROJECT_CONTEXT_UPDATED),
    );
});

test('UpdateProjectContext refuses content that stops mid-thought', async () => {
    // The guard lives in the HANDLER, not only on the manager-api route:
    // POST /commands/update-project-context reaches the same handler and
    // would otherwise bypass it.
    const h = buildHarness();
    await assert.rejects(
        () => h.bus.send(
            makeCommand(BoardUiCommands.UPDATE_PROJECT_CONTEXT, {
                projectId: 'p1',
                context: TRUNCATED_MD,
            }),
        ),
        /dangling-lead-in/,
    );
    assert.equal(
        h.recorded.filter((e) => e.type === BoardUiEvents.PROJECT_CONTEXT_UPDATED).length,
        0,
        'nothing may be emitted',
    );
});

test('UpdateProjectContext rejects a missing context field', async () => {
    // Absent must not be read as "clear it" — a malformed request would
    // wipe the context.
    const h = buildHarness();
    await assert.rejects(
        () => h.bus.send(
            makeCommand(BoardUiCommands.UPDATE_PROJECT_CONTEXT, { projectId: 'p1' }),
        ),
    );
    assert.equal(
        h.recorded.filter((e) => e.type === BoardUiEvents.PROJECT_CONTEXT_UPDATED).length,
        0,
    );
});
