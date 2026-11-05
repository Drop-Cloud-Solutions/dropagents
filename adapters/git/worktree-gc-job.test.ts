/**
 * Unit tests for the worktree-gc-job adapter.
 *
 * Dual-runner discovery (see e.g. `adapters/telegram/notification-ledger.test.ts`):
 *
 * - `npm test` runs `node --test --import tsx`, which uses Node's
 *   built-in `node:test` registry.
 * - The review pipeline runs `npx vitest run` on changed test files,
 *   which expects vitest's `test()` to register suites.
 *
 * A static `import` from `'vitest'` crashes under `node --test`. The
 * shim below routes to `globalThis.test` when running inside vitest
 * (`vitest.config.ts` sets `globals: true`) and to `require('node:test')`
 * everywhere else.
 */

import assert from 'node:assert/strict';
import * as path from 'path';

import type { EventBus } from '../../core/events/bus';
import type { Logger } from '../../core/ports/Logger';

import {
    WorktreeManager,
    type ExecRunner,
    type FsStat,
    type TaskStateLookup,
} from './worktree-manager';
import { register } from './worktree-gc-job';

type TestFn = (name: string, fn: () => void | Promise<void>) => void;

const test: TestFn = (((): TestFn => {
    if (process.env.VITEST) {
        const gt = (globalThis as { test?: TestFn }).test;
        if (typeof gt !== 'function') {
            throw new Error(
                'worktree-gc-job.test.ts: VITEST=true but globalThis.test is missing — '
                    + 'ensure vitest.config.ts sets test.globals = true',
            );
        }
        return gt;
    }
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    const nt = require('node:test') as { test: TestFn };
    return nt.test;
})());

const FAKE_BUS = {} as EventBus;
const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

interface LogEntry {
    readonly level: 'info' | 'warn' | 'error' | 'debug';
    readonly msg: string;
    readonly meta?: Readonly<Record<string, unknown>>;
}

function makeLogger(): { records: LogEntry[]; logger: Logger } {
    const records: LogEntry[] = [];
    const push =
        (level: LogEntry['level']) =>
        (msg: string, meta?: Readonly<Record<string, unknown>>): void => {
            records.push({ level, msg, meta });
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

interface CapturedInterval {
    readonly ms: number;
    readonly fn: () => void;
    unreffed: boolean;
}

/**
 * Stub `globalThis.setInterval` / `clearInterval` so a test can observe
 * the delay and tick callback that `register()` schedules, without ever
 * actually firing on the real event loop. The fake handle is a plain
 * marker the matching `clearInterval` recognises by identity.
 */
function withFakeInterval<T>(
    fn: (captured: { calls: CapturedInterval[] }) => T,
): T {
    const originalSet = global.setInterval;
    const originalClear = global.clearInterval;
    const calls: CapturedInterval[] = [];
    const fakeHandles = new WeakSet<object>();

    (global as { setInterval: unknown }).setInterval = ((
        cb: () => void,
        ms: number,
    ): NodeJS.Timeout => {
        const entry: CapturedInterval = { ms, fn: cb, unreffed: false };
        calls.push(entry);
        const handle: Partial<NodeJS.Timeout> & {
            __entry: CapturedInterval;
        } = {
            __entry: entry,
            ref(): NodeJS.Timeout {
                return handle as NodeJS.Timeout;
            },
            unref(): NodeJS.Timeout {
                entry.unreffed = true;
                return handle as NodeJS.Timeout;
            },
            hasRef(): boolean {
                return !entry.unreffed;
            },
            refresh(): NodeJS.Timeout {
                return handle as NodeJS.Timeout;
            },
        };
        fakeHandles.add(handle as object);
        return handle as NodeJS.Timeout;
    }) as typeof setInterval;

    (global as { clearInterval: unknown }).clearInterval = ((
        h: NodeJS.Timeout | undefined,
    ): void => {
        if (h !== undefined && typeof h === 'object' && fakeHandles.has(h as object)) {
            return;
        }
        return originalClear(h);
    }) as typeof clearInterval;

    try {
        return fn({ calls });
    } finally {
        global.setInterval = originalSet;
        global.clearInterval = originalClear;
    }
}

function fakeManager(gcStale: () => Promise<{ pruned: string[] }>): WorktreeManager {
    return { gcStale } as unknown as WorktreeManager;
}

// ---------------------------------------------------------------------------
// AC: registration registers a 6h tick (default) and is configurable via env
// ---------------------------------------------------------------------------

test('register schedules a 6 hour tick by default', () => {
    const prev = process.env.WORKTREE_GC_TICK_HOURS;
    delete process.env.WORKTREE_GC_TICK_HOURS;
    try {
        withFakeInterval(({ calls }) => {
            const { logger } = makeLogger();
            const handle = register(
                FAKE_BUS,
                fakeManager(async () => ({ pruned: [] })),
                logger,
                { runOnStart: false },
            );
            try {
                assert.equal(calls.length, 1, 'setInterval must be called exactly once');
                assert.equal(calls[0].ms, SIX_HOURS_MS, 'default tick must be 6h');
                assert.equal(calls[0].unreffed, true, 'timer must be .unref()ed');
            } finally {
                handle.stop();
            }
        });
    } finally {
        if (prev === undefined) delete process.env.WORKTREE_GC_TICK_HOURS;
        else process.env.WORKTREE_GC_TICK_HOURS = prev;
    }
});

test('WORKTREE_GC_TICK_HOURS env override is honoured', () => {
    const prev = process.env.WORKTREE_GC_TICK_HOURS;
    process.env.WORKTREE_GC_TICK_HOURS = '2';
    try {
        withFakeInterval(({ calls }) => {
            const { logger } = makeLogger();
            const handle = register(
                FAKE_BUS,
                fakeManager(async () => ({ pruned: [] })),
                logger,
                { runOnStart: false },
            );
            try {
                assert.equal(calls[0].ms, 2 * 60 * 60 * 1000);
            } finally {
                handle.stop();
            }
        });
    } finally {
        if (prev === undefined) delete process.env.WORKTREE_GC_TICK_HOURS;
        else process.env.WORKTREE_GC_TICK_HOURS = prev;
    }
});

test('explicit tickIntervalMs option overrides env and default', () => {
    const prev = process.env.WORKTREE_GC_TICK_HOURS;
    process.env.WORKTREE_GC_TICK_HOURS = '12';
    try {
        withFakeInterval(({ calls }) => {
            const { logger } = makeLogger();
            const handle = register(
                FAKE_BUS,
                fakeManager(async () => ({ pruned: [] })),
                logger,
                { runOnStart: false, tickIntervalMs: 1234 },
            );
            try {
                assert.equal(calls[0].ms, 1234);
            } finally {
                handle.stop();
            }
        });
    } finally {
        if (prev === undefined) delete process.env.WORKTREE_GC_TICK_HOURS;
        else process.env.WORKTREE_GC_TICK_HOURS = prev;
    }
});

// ---------------------------------------------------------------------------
// AC: the tick callback invokes manager.gcStale
// ---------------------------------------------------------------------------

test('the scheduled tick callback invokes manager.gcStale', async () => {
    await withFakeInterval(async ({ calls }) => {
        let gcCalls = 0;
        const { logger } = makeLogger();
        const handle = register(
            FAKE_BUS,
            fakeManager(async () => {
                gcCalls++;
                return { pruned: [] };
            }),
            logger,
            { runOnStart: false },
        );
        try {
            assert.equal(calls.length, 1);
            // Drive the tick directly — what the real interval would do.
            calls[0].fn();
            // Microtask drain so the fire-and-forget runOnce settles.
            await new Promise<void>((r) => setImmediate(r));
            assert.equal(gcCalls, 1, 'tick must invoke gcStale exactly once');
        } finally {
            handle.stop();
        }
    });
});

test('runOnStart=true fires an initial gcStale cycle', async () => {
    await withFakeInterval(async () => {
        let gcCalls = 0;
        const { logger } = makeLogger();
        const handle = register(
            FAKE_BUS,
            fakeManager(async () => {
                gcCalls++;
                return { pruned: [] };
            }),
            logger,
            { runOnStart: true, startTimer: false },
        );
        try {
            await new Promise<void>((r) => setImmediate(r));
            assert.equal(gcCalls, 1, 'runOnStart=true must fire one cycle');
        } finally {
            handle.stop();
        }
    });
});

// ---------------------------------------------------------------------------
// AC: active-task worktrees are skipped (delegated to WorktreeManager).
//
// The job's responsibility is to call gcStale; the active-task skip is
// the manager's responsibility via its TaskStateLookup. This test wires
// a real WorktreeManager with two seeded directories — one whose task is
// active, one whose task is terminal — and asserts only the terminal
// directory ends up pruned and only that directory was passed to git.
// ---------------------------------------------------------------------------

test('active-task worktrees are skipped during the gc tick', async () => {
    const repoRoot = path.resolve('/tmp/fake-repo');
    const worktreeRoot = path.resolve('/tmp/fake-worktrees');
    const idleMs = 1_000;
    const nowMs = 10_000;
    const oldMtime = nowMs - idleMs - 1;

    const execTargets: string[] = [];
    const exec: ExecRunner = async (_cmd, args) => {
        execTargets.push(args[args.length - 1]);
        return { stdout: '', stderr: '' };
    };

    const taskStore: TaskStateLookup = {
        isTerminal: (taskId): boolean => taskId === 'done-task',
    };

    const stat: (p: string) => FsStat = () => ({
        mtimeMs: oldMtime,
        isDirectory: (): boolean => true,
    });

    const { logger } = makeLogger();
    const mgr = new WorktreeManager({
        repoRoot,
        worktreeRoot,
        taskStore,
        logger,
        exec,
        idleMs,
        now: () => nowMs,
        readdir: () => ['active-task', 'done-task'],
        stat,
        exists: () => false,
        mkdirp: () => {},
        writeFile: () => {},
    });

    await withFakeInterval(async () => {
        const { logger: jobLogger } = makeLogger();
        const handle = register(FAKE_BUS, mgr, jobLogger, {
            runOnStart: false,
            startTimer: false,
        });
        try {
            const result = await handle.runOnce();
            assert.deepEqual(
                result.pruned.map((p) => path.basename(p)),
                ['done-task'],
                'only the terminal-task worktree must be pruned',
            );
            assert.deepEqual(
                execTargets.map((p) => path.basename(p)),
                ['done-task'],
                'git worktree remove must only be invoked for the terminal task',
            );
        } finally {
            handle.stop();
        }
    });
});

// ---------------------------------------------------------------------------
// AC: job survives gcStale throwing — logs and continues on the next tick
// ---------------------------------------------------------------------------

test('runOnce swallows errors thrown by gcStale and logs via logger.error', async () => {
    const { records, logger } = makeLogger();
    const mgr = fakeManager(async () => {
        throw new Error('boom');
    });
    await withFakeInterval(async () => {
        const handle = register(FAKE_BUS, mgr, logger, {
            runOnStart: false,
            startTimer: false,
        });
        try {
            const result = await handle.runOnce();
            assert.deepEqual(result.pruned, [], 'failed cycle returns empty pruned set');
            const errors = records.filter((r) => r.level === 'error');
            assert.ok(
                errors.some((r) => r.msg.includes('worktree-gc-job')),
                `expected a worktree-gc-job error log, got: ${JSON.stringify(records)}`,
            );
        } finally {
            handle.stop();
        }
    });
});

test('a failed tick does not cancel future ticks', async () => {
    let calls = 0;
    const mgr = fakeManager(async () => {
        calls++;
        if (calls === 1) throw new Error('first cycle fails');
        return { pruned: [] };
    });
    await withFakeInterval(async ({ calls: intervals }) => {
        const { logger } = makeLogger();
        const handle = register(FAKE_BUS, mgr, logger, { runOnStart: false });
        try {
            assert.equal(intervals.length, 1);
            // First tick throws inside gcStale.
            intervals[0].fn();
            await new Promise<void>((r) => setImmediate(r));
            // Second tick succeeds — the interval was never cleared.
            intervals[0].fn();
            await new Promise<void>((r) => setImmediate(r));
            assert.equal(calls, 2, 'gcStale must be invoked on the second tick');
        } finally {
            handle.stop();
        }
    });
});

// ---------------------------------------------------------------------------
// Handle hygiene: stop() is idempotent
// ---------------------------------------------------------------------------

test('handle.stop is idempotent', () => {
    withFakeInterval(() => {
        const { logger } = makeLogger();
        const handle = register(
            FAKE_BUS,
            fakeManager(async () => ({ pruned: [] })),
            logger,
            { runOnStart: false },
        );
        handle.stop();
        assert.doesNotThrow(() => handle.stop());
    });
});
