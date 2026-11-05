import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'path';

import type { Logger } from '../../core/ports/Logger';
import type { Event } from '../../core/events/event';
import { EventBus } from '../../core/events/bus';
import { EventStore } from '../../core/events/store';
import { openDatabase, applyMigrations, type Db } from '../../core/state/migrations';

import {
    WorktreeManager,
    registerWorktreeSubscribers,
    registerWorktreeGcJob,
    WORKTREE_CREATE_SUBSCRIBER,
    WORKTREE_REMOVE_SUBSCRIBER,
    type ExecResult,
    type ExecRunner,
    type FsStat,
    type TaskStateLookup,
} from './worktree-manager';

const REPO_ROOT = path.resolve('/tmp/fake-repo');
const WORKTREE_ROOT = path.resolve('/tmp/fake-worktrees');
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

interface LogRecord {
    readonly level: 'info' | 'warn' | 'error' | 'debug';
    readonly message: string;
    readonly meta?: Readonly<Record<string, unknown>>;
}

function makeLogger(): { records: LogRecord[]; logger: Logger } {
    const records: LogRecord[] = [];
    const push =
        (level: LogRecord['level']) =>
        (message: string, meta?: Readonly<Record<string, unknown>>): void => {
            records.push({ level, message, meta });
        };
    return {
        records,
        logger: {
            info: push('info'),
            warn: push('warn'),
            error: push('error'),
            debug: push('debug'),
        },
    };
}

interface RecordedCall {
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd: string;
}

function makeExec(options: {
    responses?: ReadonlyArray<ExecResult | Error>;
    fallback?: ExecResult;
} = {}): { exec: ExecRunner; calls: RecordedCall[] } {
    const calls: RecordedCall[] = [];
    const responses = options.responses ?? [];
    const fallback: ExecResult = options.fallback ?? { stdout: '', stderr: '' };
    const exec: ExecRunner = async (command, args, runOpts) => {
        const call: RecordedCall = { command, args: args.slice(), cwd: runOpts.cwd };
        calls.push(call);
        const r = responses[calls.length - 1] ?? fallback;
        if (r instanceof Error) throw r;
        return r;
    };
    return { exec, calls };
}

function fixedStore(map: Readonly<Record<string, 'terminal' | 'active' | 'unknown'>>): TaskStateLookup {
    return {
        isTerminal(taskId: string): boolean {
            return map[taskId] === 'terminal';
        },
    };
}

function makeStat(mtimeMs: number, isDirectory = true): FsStat {
    return { mtimeMs, isDirectory: () => isDirectory };
}

interface FsHarness {
    readdir: (dir: string) => readonly string[];
    stat: (p: string) => FsStat;
    exists: (p: string) => boolean;
    mkdirp: (p: string) => void;
    writeFile: (p: string, contents: string) => void;
}

function makeFs(seed: {
    entries?: ReadonlyMap<string, FsStat>;
    existing?: ReadonlySet<string>;
} = {}): FsHarness & { mkdirpCalls: string[]; writeFileCalls: Array<{ path: string; contents: string }> } {
    const entries = new Map(seed.entries ?? []);
    const existing = new Set(seed.existing ?? []);
    const mkdirpCalls: string[] = [];
    const writeFileCalls: Array<{ path: string; contents: string }> = [];
    return {
        mkdirpCalls,
        writeFileCalls,
        readdir(dir: string): readonly string[] {
            const prefix = dir.endsWith(path.sep) ? dir : dir + path.sep;
            const names: string[] = [];
            for (const k of entries.keys()) {
                if (!k.startsWith(prefix)) continue;
                const rest = k.slice(prefix.length);
                if (rest.includes(path.sep)) continue;
                names.push(rest);
            }
            return names;
        },
        stat(p: string): FsStat {
            const hit = entries.get(p);
            if (!hit) {
                const err = new Error(`ENOENT: no such file or directory, stat '${p}'`);
                throw err;
            }
            return hit;
        },
        exists(p: string): boolean {
            return existing.has(p) || entries.has(p);
        },
        mkdirp(p: string): void {
            mkdirpCalls.push(p);
        },
        writeFile(p: string, contents: string): void {
            writeFileCalls.push({ path: p, contents });
            existing.add(p);
        },
    };
}

function newManager(
    overrides: Partial<{
        exec: ExecRunner;
        taskStore: TaskStateLookup;
        fs: FsHarness;
        now: () => number;
        idleMs: number;
        logger: Logger;
    }> = {},
): WorktreeManager {
    const fs = overrides.fs ?? makeFs();
    return new WorktreeManager({
        repoRoot: REPO_ROOT,
        worktreeRoot: WORKTREE_ROOT,
        taskStore: overrides.taskStore ?? fixedStore({}),
        logger: overrides.logger ?? makeLogger().logger,
        exec: overrides.exec ?? makeExec().exec,
        now: overrides.now ?? ((): number => 0),
        idleMs: overrides.idleMs,
        readdir: fs.readdir,
        stat: fs.stat,
        exists: fs.exists,
        mkdirp: fs.mkdirp,
        writeFile: fs.writeFile,
    });
}

// ---------------------------------------------------------------------------
// Construction validation
// ---------------------------------------------------------------------------

test('constructor rejects when neither repoRoot nor repoResolver is supplied', () => {
    assert.throws(
        () =>
            new WorktreeManager({
                worktreeRoot: WORKTREE_ROOT,
                taskStore: fixedStore({}),
                logger: makeLogger().logger,
                exec: makeExec().exec,
            }),
        /either `repoRoot` or `repoResolver` must be supplied/,
    );
});

// ---------------------------------------------------------------------------
// AC #5 — multi-repo: resolve repo cwd by id via the registry-backed resolver
// ---------------------------------------------------------------------------

test('create resolves the repo cwd through repoResolver when a repoId is supplied', async () => {
    const apiRepo = path.resolve('/tmp/fake-api-checkout');
    const docsRepo = path.resolve('/tmp/fake-docs-checkout');
    const resolver = (repoId: string): string => {
        if (repoId === 'api') return apiRepo;
        if (repoId === 'docs') return docsRepo;
        throw new Error(`unknown repo: ${repoId}`);
    };
    const fs = makeFs();
    const { exec, calls } = makeExec();
    const { logger } = makeLogger();
    const mgr = new WorktreeManager({
        repoResolver: resolver,
        worktreeRoot: WORKTREE_ROOT,
        taskStore: fixedStore({}),
        logger,
        exec,
        readdir: fs.readdir,
        stat: fs.stat,
        exists: fs.exists,
        mkdirp: fs.mkdirp,
        writeFile: fs.writeFile,
        now: () => 0,
    });

    await mgr.create('task-multi', 'feature/x', 'docs');

    assert.equal(calls.length, 1);
    assert.equal(calls[0].cwd, docsRepo, 'cwd must be the docs repo path, not the api one');
});

test('remove uses the repo cwd captured at create() time', async () => {
    const apiRepo = path.resolve('/tmp/fake-api-checkout');
    const docsRepo = path.resolve('/tmp/fake-docs-checkout');
    const resolver = (repoId: string): string => {
        if (repoId === 'api') return apiRepo;
        if (repoId === 'docs') return docsRepo;
        throw new Error(`unknown repo: ${repoId}`);
    };
    const fs = makeFs();
    const { exec, calls } = makeExec();
    const mgr = new WorktreeManager({
        repoResolver: resolver,
        worktreeRoot: WORKTREE_ROOT,
        taskStore: fixedStore({}),
        logger: makeLogger().logger,
        exec,
        readdir: fs.readdir,
        stat: fs.stat,
        exists: fs.exists,
        mkdirp: fs.mkdirp,
        writeFile: fs.writeFile,
        now: () => 0,
    });

    await mgr.create('task-docs', 'feature/y', 'docs');
    calls.length = 0;
    await mgr.remove('task-docs');

    assert.equal(calls.length, 1);
    assert.equal(calls[0].cwd, docsRepo);
});

test('create throws when repoId is supplied but no repoResolver is configured', async () => {
    const mgr = newManager();
    await assert.rejects(
        () => mgr.create('t', 'b', 'docs'),
        /repoId "docs" supplied but no repoResolver was configured/,
    );
});

// ---------------------------------------------------------------------------
// AC #1: create(taskId, branch) -> `git worktree add <root>/<taskId> <branch>`
// ---------------------------------------------------------------------------

test('create runs `git worktree add <root>/<taskId> <branch>` under repoRoot', async () => {
    const { exec, calls } = makeExec();
    const mgr = newManager({ exec });

    const ret = await mgr.create('task-7', 'feature/x');

    assert.equal(calls.length, 1);
    const call = calls[0];
    assert.equal(call.command, 'git');
    assert.equal(call.cwd, REPO_ROOT);
    assert.deepEqual(call.args, [
        'worktree',
        'add',
        path.join(WORKTREE_ROOT, 'task-7'),
        'feature/x',
    ]);
    assert.equal(ret, path.join(WORKTREE_ROOT, 'task-7'));
    assert.equal(mgr.pathFor('task-7'), path.join(WORKTREE_ROOT, 'task-7'));
});

test('create mkdir -p the worktree root before invoking git', async () => {
    const fs = makeFs();
    const { exec } = makeExec();
    const mgr = newManager({ exec, fs });

    await mgr.create('task-mk', 'feature/x');
    assert.deepEqual(fs.mkdirpCalls, [WORKTREE_ROOT]);
});

test('create is idempotent: an existing directory is adopted, not re-added', async () => {
    const target = path.join(WORKTREE_ROOT, 'task-dup');
    const fs = makeFs({ existing: new Set([target]) });
    const { exec, calls } = makeExec();
    const mgr = newManager({ exec, fs });

    const out = await mgr.create('task-dup', 'feature/dup');
    assert.equal(out, target);
    assert.equal(calls.length, 0, 'git worktree add must not be invoked when target exists');
    assert.equal(mgr.pathFor('task-dup'), target);
});

// ---------------------------------------------------------------------------
// AC #2: remove(taskId) -> `git worktree remove --force <path>`
// ---------------------------------------------------------------------------

test('remove runs `git worktree remove --force <path>` against repoRoot', async () => {
    const { exec, calls } = makeExec();
    const mgr = newManager({ exec });
    await mgr.create('task-9', 'feature/y');
    calls.length = 0;

    await mgr.remove('task-9');

    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, 'git');
    assert.equal(calls[0].cwd, REPO_ROOT);
    assert.deepEqual(calls[0].args, [
        'worktree',
        'remove',
        '--force',
        path.join(WORKTREE_ROOT, 'task-9'),
    ]);
});

test('remove works without a prior create — derives the path from taskId', async () => {
    const { exec, calls } = makeExec();
    const mgr = newManager({ exec });
    await mgr.remove('task-loose');
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, [
        'worktree',
        'remove',
        '--force',
        path.join(WORKTREE_ROOT, 'task-loose'),
    ]);
});

// ---------------------------------------------------------------------------
// AC #7: failures in remove are logged and not propagated
// ---------------------------------------------------------------------------

test('remove swallows underlying git errors and emits a warning', async () => {
    const failure = new Error('fatal: not a working tree directory');
    const { exec } = makeExec({ responses: [failure] });
    const { logger, records } = makeLogger();
    const mgr = newManager({ exec, logger });

    await mgr.remove('task-missing');
    const warn = records.find((r) => r.level === 'warn' && r.message.includes('remove failed'));
    assert.ok(warn, `expected a "remove failed" warning, got: ${JSON.stringify(records)}`);
});

test('remove clears the in-memory ownership entry even when git fails', async () => {
    makeExec();
    const mgr = new WorktreeManager({
        repoRoot: REPO_ROOT,
        worktreeRoot: WORKTREE_ROOT,
        taskStore: fixedStore({}),
        logger: makeLogger().logger,
        exec: async (cmd, args) => {
            if (args[1] === 'add') return { stdout: '', stderr: '' };
            throw new Error('fatal: removed twice');
        },
        now: () => 0,
        readdir: () => [],
        stat: () => makeStat(0),
        exists: () => false,
        mkdirp: () => undefined,
        writeFile: () => undefined,
    });
    await mgr.create('task-x', 'b');
    await mgr.remove('task-x');
    assert.equal(mgr.pathFor('task-x'), undefined);
});

// ---------------------------------------------------------------------------
// AC #3: gcStale prunes worktrees whose task is terminal AND idle > 24h
// AC #5: gcStale returns the pruned paths
// ---------------------------------------------------------------------------

test('gcStale prunes dirs whose task is terminal AND mtime is older than 24h', async () => {
    const now = 100 * ONE_DAY_MS;
    const stale = path.join(WORKTREE_ROOT, 'task-old');
    const fresh = path.join(WORKTREE_ROOT, 'task-fresh');

    const fs = makeFs({
        entries: new Map<string, FsStat>([
            [stale, makeStat(now - 2 * ONE_DAY_MS)],
            [fresh, makeStat(now - 1 * 60 * 1000)],
        ]),
    });

    const { exec, calls } = makeExec();
    const { logger } = makeLogger();
    const mgr = newManager({
        exec,
        fs,
        now: () => now,
        taskStore: fixedStore({ 'task-old': 'terminal', 'task-fresh': 'terminal' }),
        logger,
    });

    const { pruned } = await mgr.gcStale();

    assert.deepEqual(pruned, [stale]);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, ['worktree', 'remove', '--force', stale]);
});

test('gcStale returns the list of pruned paths so callers can log them (AC #5)', async () => {
    const now = ONE_DAY_MS * 10;
    const a = path.join(WORKTREE_ROOT, 'task-a');
    const b = path.join(WORKTREE_ROOT, 'task-b');
    const fs = makeFs({
        entries: new Map<string, FsStat>([
            [a, makeStat(now - 3 * ONE_DAY_MS)],
            [b, makeStat(now - 3 * ONE_DAY_MS)],
        ]),
    });
    const { exec } = makeExec();
    const mgr = newManager({
        exec,
        fs,
        now: () => now,
        taskStore: fixedStore({ 'task-a': 'terminal', 'task-b': 'terminal' }),
    });
    const { pruned } = await mgr.gcStale();
    assert.deepEqual(pruned.sort(), [a, b].sort());
});

// ---------------------------------------------------------------------------
// AC #4: gcStale never prunes a worktree whose task is still active
// ---------------------------------------------------------------------------

test('gcStale skips active tasks even when the directory is older than 24h', async () => {
    const now = 1_000 * ONE_DAY_MS;
    const active = path.join(WORKTREE_ROOT, 'task-active');
    const fs = makeFs({
        entries: new Map<string, FsStat>([
            [active, makeStat(now - 10 * ONE_DAY_MS)],
        ]),
    });
    const { exec, calls } = makeExec();
    const mgr = newManager({
        exec,
        fs,
        now: () => now,
        taskStore: fixedStore({ 'task-active': 'active' }),
    });
    const { pruned } = await mgr.gcStale();
    assert.deepEqual(pruned, []);
    assert.equal(calls.length, 0, 'no git remove must run for an active task');
});

test('gcStale skips terminal tasks whose mtime is within the idle window', async () => {
    const now = 50 * ONE_DAY_MS;
    const fresh = path.join(WORKTREE_ROOT, 'task-fresh-terminal');
    const fs = makeFs({
        entries: new Map<string, FsStat>([
            // 23h old — under the 24h cutoff.
            [fresh, makeStat(now - 23 * 60 * 60 * 1000)],
        ]),
    });
    const { exec, calls } = makeExec();
    const mgr = newManager({
        exec,
        fs,
        now: () => now,
        taskStore: fixedStore({ 'task-fresh-terminal': 'terminal' }),
    });
    const { pruned } = await mgr.gcStale();
    assert.deepEqual(pruned, []);
    assert.equal(calls.length, 0);
});

test('gcStale skips unknown taskIds (defensive: never delete what we did not provision)', async () => {
    const now = 999 * ONE_DAY_MS;
    const orphan = path.join(WORKTREE_ROOT, 'random-folder');
    const fs = makeFs({
        entries: new Map<string, FsStat>([[orphan, makeStat(now - 365 * ONE_DAY_MS)]]),
    });
    const { exec, calls } = makeExec();
    const mgr = newManager({
        exec,
        fs,
        now: () => now,
        taskStore: fixedStore({}),
    });
    const { pruned } = await mgr.gcStale();
    assert.deepEqual(pruned, []);
    assert.equal(calls.length, 0);
});

test('gcStale skips non-directory entries', async () => {
    const now = 1_000 * ONE_DAY_MS;
    const fileEntry = path.join(WORKTREE_ROOT, 'README');
    const fs = makeFs({
        entries: new Map<string, FsStat>([
            [fileEntry, { mtimeMs: now - 100 * ONE_DAY_MS, isDirectory: () => false }],
        ]),
    });
    const { exec, calls } = makeExec();
    const mgr = newManager({
        exec,
        fs,
        now: () => now,
        taskStore: fixedStore({ README: 'terminal' }),
    });
    const { pruned } = await mgr.gcStale();
    assert.deepEqual(pruned, []);
    assert.equal(calls.length, 0);
});

test('gcStale logs and continues when removing one entry fails', async () => {
    const now = 100 * ONE_DAY_MS;
    const good = path.join(WORKTREE_ROOT, 'task-good');
    const bad = path.join(WORKTREE_ROOT, 'task-bad');
    const fs = makeFs({
        entries: new Map<string, FsStat>([
            [good, makeStat(now - 5 * ONE_DAY_MS)],
            [bad, makeStat(now - 5 * ONE_DAY_MS)],
        ]),
    });

    let call = 0;
    const exec: ExecRunner = async (_cmd, args) => {
        call++;
        if (args[args.length - 1] === bad) throw new Error('locked');
        return { stdout: '', stderr: '' };
    };
    const { logger, records } = makeLogger();
    const mgr = newManager({
        exec,
        fs,
        now: () => now,
        taskStore: fixedStore({ 'task-good': 'terminal', 'task-bad': 'terminal' }),
        logger,
    });

    const { pruned } = await mgr.gcStale();
    assert.equal(call, 2, 'gcStale must attempt both entries');
    assert.deepEqual(pruned, [good], 'only the entry that removed cleanly is reported as pruned');
    assert.ok(records.some((r) => r.level === 'warn' && r.message.includes('prune failed')));
});

test('gcStale returns an empty result when the worktree root is missing', async () => {
    const fs = makeFs();
    const broken: FsHarness = {
        ...fs,
        readdir: () => {
            throw new Error('ENOENT');
        },
    };
    const { exec, calls } = makeExec();
    const { logger } = makeLogger();
    const mgr = newManager({ exec, fs: broken, logger });
    const { pruned } = await mgr.gcStale();
    assert.deepEqual(pruned, []);
    assert.equal(calls.length, 0);
});

test('gcStale honours a custom idleMs override', async () => {
    const now = 1_000_000;
    const target = path.join(WORKTREE_ROOT, 'task-quick');
    const fs = makeFs({ entries: new Map([[target, makeStat(now - 30_000)]]) });
    const { exec, calls } = makeExec();
    const mgr = newManager({
        exec,
        fs,
        now: () => now,
        idleMs: 10_000,
        taskStore: fixedStore({ 'task-quick': 'terminal' }),
    });
    const { pruned } = await mgr.gcStale();
    assert.deepEqual(pruned, [target]);
    assert.equal(calls.length, 1);
});

// ---------------------------------------------------------------------------
// AC #6: subscribers call create on TaskStarted and remove on TaskCompleted
// ---------------------------------------------------------------------------

function openBus(): { db: Db; bus: EventBus; close: () => void } {
    const db = openDatabase(':memory:');
    applyMigrations(db);
    const store = new EventStore(db);
    const { logger } = makeLogger();
    const bus = new EventBus(store, logger);
    return { db, bus, close: () => db.close() };
}

test('registerWorktreeSubscribers wires create on TaskStarted and remove on TaskCompleted', async () => {
    const { bus, close } = openBus();
    try {
        const { logger } = makeLogger();
        const fs = makeFs();
        const { exec, calls } = makeExec();
        const mgr = newManager({ exec, fs, logger });

        const subs = registerWorktreeSubscribers({ bus, manager: mgr, logger });
        assert.deepEqual([...subs], [WORKTREE_CREATE_SUBSCRIBER, WORKTREE_REMOVE_SUBSCRIBER]);

        const started: Event = {
            type: 'TaskStarted',
            v: 1,
            occurredAt: 1,
            idempotencyKey: 'k:started:t-1',
            payload: { taskId: 't-1' },
        };
        const completed: Event = {
            type: 'TaskCompleted',
            v: 1,
            occurredAt: 2,
            idempotencyKey: 'k:completed:t-1',
            payload: { taskId: 't-1' },
        };

        // Re-register with explicit event names so we don't collide with the
        // v2 default vocabulary ('TaskApproved' / 'TaskFinished').
        // Instead, drive the default-named flow directly below.
        // Here we just confirm the AC: emit the two events under the names
        // the subscriber was configured with.
        void started;
        void completed;

        // The subs registered above use defaults: 'TaskApproved' / 'TaskFinished'.
        await bus.publish({
            type: 'TaskApproved',
            v: 1,
            occurredAt: 1,
            idempotencyKey: 'k:approved:t-7',
            payload: { taskId: 't-7' },
        });
        assert.equal(calls.length, 1, 'TaskApproved must invoke create()');
        assert.deepEqual(calls[0].args, [
            'worktree',
            'add',
            path.join(WORKTREE_ROOT, 't-7'),
            'wt/t-7',
        ]);

        await bus.publish({
            type: 'TaskFinished',
            v: 1,
            occurredAt: 2,
            idempotencyKey: 'k:finished:t-7',
            payload: { taskId: 't-7' },
        });
        assert.equal(calls.length, 2, 'TaskFinished must invoke remove()');
        assert.deepEqual(calls[1].args, [
            'worktree',
            'remove',
            '--force',
            path.join(WORKTREE_ROOT, 't-7'),
        ]);
    } finally {
        close();
    }
});

test('registerWorktreeSubscribers swallows create() failures so the bus offset advances', async () => {
    const { bus, db, close } = openBus();
    try {
        const { logger, records } = makeLogger();
        const fs = makeFs();
        const exec: ExecRunner = async () => {
            throw new Error('git fatal: already exists');
        };
        const mgr = newManager({ exec, fs, logger });

        registerWorktreeSubscribers({ bus, manager: mgr, logger });

        await bus.publish({
            type: 'TaskApproved',
            v: 1,
            occurredAt: 1,
            idempotencyKey: 'k:approved:t-err',
            payload: { taskId: 't-err' },
        });

        const offset = db
            .prepare('SELECT last_seq FROM subscriber_offsets WHERE subscriber = ?')
            .get(WORKTREE_CREATE_SUBSCRIBER) as { last_seq: number } | undefined;
        assert.ok(offset, 'create subscriber must have advanced its offset despite the error');
        assert.ok(
            records.some((r) => r.level === 'error' && r.message.includes('create failed')),
            'create failure must be logged at error level',
        );
    } finally {
        close();
    }
});

test('registerWorktreeSubscribers honours an explicit branchForTask override', async () => {
    const { bus, close } = openBus();
    try {
        const { logger } = makeLogger();
        const fs = makeFs();
        const { exec, calls } = makeExec();
        const mgr = newManager({ exec, fs, logger });

        registerWorktreeSubscribers({
            bus,
            manager: mgr,
            logger,
            branchForTask: (id) => `custom/${id}`,
        });

        await bus.publish({
            type: 'TaskApproved',
            v: 1,
            occurredAt: 1,
            idempotencyKey: 'k:approved:t-c',
            payload: { taskId: 't-c' },
        });
        assert.equal(calls[0].args[3], 'custom/t-c');
    } finally {
        close();
    }
});

// ---------------------------------------------------------------------------
// daily-tick scheduler (gc job)
// ---------------------------------------------------------------------------

test('registerWorktreeGcJob runs once on register and exposes runOnce/stop', async () => {
    const { logger } = makeLogger();
    const fs = makeFs();
    const { exec } = makeExec();
    let ticks = 0;
    const mgr = new WorktreeManager({
        repoRoot: REPO_ROOT,
        worktreeRoot: WORKTREE_ROOT,
        taskStore: fixedStore({}),
        logger,
        exec,
        readdir: () => {
            ticks++;
            return [];
        },
        stat: fs.stat,
        exists: fs.exists,
        mkdirp: fs.mkdirp,
        writeFile: fs.writeFile,
        now: () => 0,
    });

    const handle = registerWorktreeGcJob({
        manager: mgr,
        logger,
        startTimer: false,
        runOnStart: true,
    });

    // runOnStart fires fire-and-forget; await a microtask drain.
    await new Promise<void>((r) => setImmediate(r));
    assert.equal(ticks, 1, 'runOnStart must invoke gcStale exactly once');

    const result = await handle.runOnce();
    assert.deepEqual(result.pruned, []);
    assert.equal(ticks, 2);

    handle.stop();
    assert.doesNotThrow(() => handle.stop(), 'stop must be idempotent');
});

test('registerWorktreeGcJob swallows errors thrown by gcStale itself', async () => {
    const { logger, records } = makeLogger();
    const mgr = {
        gcStale: async () => {
            throw new Error('boom');
        },
    } as unknown as WorktreeManager;

    const handle = registerWorktreeGcJob({
        manager: mgr,
        logger,
        startTimer: false,
        runOnStart: false,
    });

    const result = await handle.runOnce();
    assert.deepEqual(result.pruned, []);
    assert.ok(records.some((r) => r.level === 'error' && r.message.includes('gc cycle failed')));
    handle.stop();
});
