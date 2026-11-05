/**
 * Per-repo deploy worktrees.
 *
 * Contract asserted here:
 *   - first deploy CREATES a detached checkout at origin/<default>;
 *   - a later deploy REUSES it (fetch + reset), never `worktree add`,
 *     and never a command that would delete untracked build output —
 *     the warm obj/bin cache is the whole reason this exists;
 *   - two concurrent deploys of one repo never share the directory:
 *     the second gets `null` (= use a per-task worktree);
 *   - the holder is released once its task goes terminal;
 *   - any git failure degrades to `null` instead of blocking a deploy.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { DeployWorktreeStore, deployWorktreeDirName } from './deploy-worktrees';
import type { Logger } from '../../core/ports/Logger';

interface LogLine {
    readonly level: string;
    readonly message: string;
    readonly meta?: Readonly<Record<string, unknown>>;
}

function makeLogger(sink: LogLine[]): Logger {
    return {
        info: (message, meta): void => { sink.push({ level: 'info', message, meta }); },
        warn: (message, meta): void => { sink.push({ level: 'warn', message, meta }); },
        error: (message, meta): void => { sink.push({ level: 'error', message, meta }); },
        debug: (message, meta): void => { sink.push({ level: 'debug', message, meta }); },
    };
}

interface Harness {
    readonly root: string;
    readonly repoPath: string;
    readonly calls: string[][];
    /** The env overlay each call in `calls` was given, same order. */
    readonly envs: Array<Record<string, string> | undefined>;
    readonly logs: LogLine[];
    readonly store: DeployWorktreeStore;
    cleanup(): void;
}

/**
 * Fake git that emulates just enough for the paths under test:
 * `worktree add` materialises the directory, `rev-parse --git-dir`
 * succeeds for a directory that exists. `failOn` makes one subcommand
 * throw so the degrade path can be driven.
 */
function makeHarness(options: {
    inFlight?: (taskId: string) => boolean;
    failOn?: string;
    status?: string;
    githubEnvForRepo?: (repoId: string) => Record<string, string>;
} = {}): Harness {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-wt-'));
    const repoPath = path.join(root, 'clone');
    fs.mkdirSync(repoPath, { recursive: true });
    const calls: string[][] = [];
    const envs: Array<Record<string, string> | undefined> = [];
    const logs: LogLine[] = [];

    const store = new DeployWorktreeStore({
        worktreeRoot: path.join(root, 'worktrees'),
        logger: makeLogger(logs),
        isTaskInFlight: options.inFlight ?? ((): boolean => false),
        defaultBranchFor: async (): Promise<string> => 'main',
        ...(options.githubEnvForRepo
            ? { githubEnvForRepo: options.githubEnvForRepo }
            : {}),
        runGit: async (args, cwd, env) => {
            calls.push([...args]);
            envs.push(env as Record<string, string> | undefined);
            const sub = args.join(' ');
            if (options.failOn && sub.startsWith(options.failOn)) {
                throw new Error(`git ${sub} exited 128: boom`);
            }
            if (args[0] === 'worktree' && args[1] === 'add') {
                fs.mkdirSync(args[3]!, { recursive: true });
                return { stdout: '', stderr: '' };
            }
            if (args[0] === 'rev-parse') {
                if (!fs.existsSync(cwd)) throw new Error('not a git repository');
                return { stdout: path.join(cwd, '.git'), stderr: '' };
            }
            if (args[0] === 'status') {
                return { stdout: options.status ?? '', stderr: '' };
            }
            return { stdout: '', stderr: '' };
        },
    });

    return {
        root,
        repoPath,
        calls,
        envs,
        logs,
        store,
        cleanup: (): void => { fs.rmSync(root, { recursive: true, force: true }); },
    };
}

const sub = (calls: string[][], head: string): string[][] =>
    calls.filter((c) => c.join(' ').startsWith(head));

// ---------------------------------------------------------------------------

test('first deploy creates a DETACHED worktree at the origin tip', async () => {
    const h = makeHarness();
    try {
        const got = await h.store.acquire('T-1', 'shop', h.repoPath);
        assert.equal(got, h.store.pathFor('shop'));
        assert.ok(fs.existsSync(got!), 'the worktree directory should exist');

        const adds = sub(h.calls, 'worktree add');
        assert.equal(adds.length, 1);
        assert.deepEqual(adds[0], [
            'worktree', 'add', '--detach', got!, 'origin/main',
        ]);
    } finally {
        h.cleanup();
    }
});

test('a later deploy REUSES the worktree — fetch + reset, no re-add', async () => {
    const h = makeHarness();
    try {
        await h.store.acquire('T-1', 'shop', h.repoPath);
        h.calls.length = 0;

        const got = await h.store.acquire('T-2', 'shop', h.repoPath);
        assert.equal(got, h.store.pathFor('shop'));
        assert.equal(sub(h.calls, 'worktree add').length, 0, 'must not re-create');
        assert.equal(sub(h.calls, 'fetch origin').length, 1);
        assert.deepEqual(sub(h.calls, 'reset')[0], ['reset', '--hard', 'origin/main']);
    } finally {
        h.cleanup();
    }
});

test('the reuse path never runs a command that deletes untracked build output', async () => {
    // The warm obj/ + bin/ cache IS the feature. `git clean` (any form)
    // or a `-x`/`-d` flag would silently undo it and turn every deploy
    // back into a cold rebuild.
    const h = makeHarness();
    try {
        await h.store.acquire('T-1', 'shop', h.repoPath);
        await h.store.acquire('T-2', 'shop', h.repoPath);
        for (const call of h.calls) {
            assert.notEqual(call[0], 'clean', `unexpected: git ${call.join(' ')}`);
        }
    } finally {
        h.cleanup();
    }
});

test('discarded tracked changes are logged before the reset', async () => {
    const h = makeHarness({ status: ' M Deploy/deploy-ldoa.ps1\n?? obj/project.assets.json\n' });
    try {
        await h.store.acquire('T-1', 'shop', h.repoPath);
        await h.store.acquire('T-2', 'shop', h.repoPath);

        const warned = h.logs.find((l) => l.message.includes('discarding local changes'));
        assert.ok(warned, 'a discarded edit must not vanish silently');
        assert.deepEqual(warned!.meta?.files, ['Deploy/deploy-ldoa.ps1']);
        assert.equal(warned!.meta?.totalChanged, 1, 'untracked output is not a "change"');
    } finally {
        h.cleanup();
    }
});

test('a second deploy of the SAME repo while one is in flight falls back', async () => {
    const inFlight = new Set(['T-1']);
    const h = makeHarness({ inFlight: (id) => inFlight.has(id) });
    try {
        assert.ok(await h.store.acquire('T-1', 'shop', h.repoPath));
        h.calls.length = 0;

        const second = await h.store.acquire('T-2', 'shop', h.repoPath);
        assert.equal(second, null, 'concurrent deploys must not share one directory');
        assert.equal(h.calls.length, 0, 'the busy check should short-circuit before git');

        // …and once T-1 is terminal the directory is free again.
        inFlight.delete('T-1');
        assert.equal(
            await h.store.acquire('T-2', 'shop', h.repoPath),
            h.store.pathFor('shop'),
        );
    } finally {
        h.cleanup();
    }
});

test('a different repo is never blocked by a busy one', async () => {
    const h = makeHarness({ inFlight: () => true });
    try {
        await h.store.acquire('T-1', 'shop', h.repoPath);
        const other = await h.store.acquire('T-2', 'workshop', h.repoPath);
        assert.equal(other, h.store.pathFor('workshop'));
        assert.notEqual(h.store.pathFor('shop'), h.store.pathFor('workshop'));
    } finally {
        h.cleanup();
    }
});

test('a git failure degrades to the per-task worktree instead of blocking the deploy', async () => {
    const h = makeHarness({ failOn: 'worktree add' });
    try {
        assert.equal(await h.store.acquire('T-1', 'shop', h.repoPath), null);
        const warned = h.logs.find((l) => l.level === 'warn');
        assert.ok(warned, 'the degrade must be visible in the log');
        assert.match(String(warned!.meta?.error), /exited 128/);
    } finally {
        h.cleanup();
    }
});

test('a broken checkout is rebuilt rather than deployed from', async () => {
    const h = makeHarness();
    try {
        const target = h.store.pathFor('shop');
        // A directory git no longer recognises: rev-parse is faked to
        // fail for a path that does not exist, so create it AFTER the
        // probe would run by leaving the parent in place only.
        fs.mkdirSync(target, { recursive: true });
        fs.writeFileSync(path.join(target, 'stale.txt'), 'x', 'utf8');

        // rev-parse succeeds for an existing dir in the fake, so drive
        // the broken case explicitly through a failing probe.
        const broken = new DeployWorktreeStore({
            worktreeRoot: path.join(h.root, 'worktrees'),
            logger: makeLogger(h.logs),
            isTaskInFlight: (): boolean => false,
            defaultBranchFor: async (): Promise<string> => 'main',
            runGit: async (args) => {
                h.calls.push([...args]);
                if (args[0] === 'rev-parse') throw new Error('not a git repository');
                if (args[0] === 'worktree' && args[1] === 'add') {
                    fs.mkdirSync(args[3]!, { recursive: true });
                }
                return { stdout: '', stderr: '' };
            },
        });

        const got = await broken.acquire('T-1', 'shop', h.repoPath);
        assert.equal(got, target);
        assert.equal(
            fs.existsSync(path.join(target, 'stale.txt')),
            false,
            'the junk directory should have been wiped before re-adding',
        );
        assert.ok(h.logs.some((l) => l.message.includes('broken .git metadata')));
    } finally {
        h.cleanup();
    }
});

test('repo ids that need sanitising stay distinct', () => {
    assert.equal(deployWorktreeDirName('shop'), 'shop');
    assert.notEqual(
        deployWorktreeDirName('drop/loans'),
        deployWorktreeDirName('drop:loans'),
    );
    for (const id of ['drop/loans', 'a b', '../escape', '']) {
        const name = deployWorktreeDirName(id);
        assert.equal(name, path.basename(name), `${id} must stay a single segment`);
        assert.ok(name.length > 0);
        assert.doesNotMatch(name, /\.\./);
    }
});

// ---------------------------------------------------------------------------
// Sidecar exclusion (task-worktrees).
//
// Wiring the ResumeTask handler means `clarification-answer.md` and
// `feedback.md` now land at the worktree root. The committer decides
// what to stage from `git status`, so an un-excluded sidecar would ride
// into the task's commit and PR — the exact reason TASK.md is excluded.
// ---------------------------------------------------------------------------

test('the ResumeTask sidecars are excluded from git alongside TASK.md', async () => {
    const fsMod = await import('node:fs');
    const pathMod = await import('node:path');
    const src = fsMod.readFileSync(
        pathMod.join(__dirname, 'task-worktrees.ts'),
        'utf8',
    );
    const start = src.indexOf('const patterns = [');
    assert.notEqual(start, -1, 'the exclude pattern list must exist');
    const block = src.slice(start, src.indexOf(']', start));
    for (const pattern of [
        'TASK.md',
        'WORKSPACE_RULES.md',
        '/attachments/',
        'clarification-answer.md',
        'feedback.md',
    ]) {
        assert.ok(
            block.includes(`'${pattern}'`),
            `${pattern} must be excluded or the committer can stage it`,
        );
    }
});

// --- the GitHub account -----------------------------------------------
//
// Field report: the auto-merge failed with "Repository not found" on a
// repo that exists, because the git call ran as the machine's ambient
// identity instead of the account the repo is mapped to. GitHub does
// not leak the existence of a repo an identity cannot see, so the wrong
// credential and a deleted repo produce the SAME message — which is why
// every remote-touching call has to carry the account, including the
// ones inside a worktree store.

test('the reuse fetch carries the repo\'s GitHub account', async () => {
    const h = makeHarness({
        githubEnvForRepo: (repoId) => ({ GH_CONFIG_DIR: `C:/gh/${repoId}` }),
    });
    try {
        await h.store.acquire('T-1', 'shop', h.repoPath);
        h.calls.length = 0;
        h.envs.length = 0;

        await h.store.acquire('T-2', 'shop', h.repoPath);

        const i = h.calls.findIndex((c) => c.join(' ') === 'fetch origin');
        assert.notEqual(i, -1, 'the reuse path must fetch');
        assert.deepEqual(h.envs[i], { GH_CONFIG_DIR: 'C:/gh/shop' });
    } finally {
        h.cleanup();
    }
});

test('the overlay is keyed by repoId, not by the holding task', async () => {
    // A deploy worktree is shared per repo and successive deploys come
    // from different tasks. Keying on the task would hand the second
    // deploy a lookup the store cannot do.
    const seen: string[] = [];
    const h = makeHarness({
        githubEnvForRepo: (repoId) => {
            seen.push(repoId);
            return { GH_CONFIG_DIR: 'C:/gh/a' };
        },
    });
    try {
        await h.store.acquire('T-1', 'shop', h.repoPath);
        await h.store.acquire('T-2', 'shop', h.repoPath);
        assert.deepEqual(seen, ['shop'], 'resolved by repo, once per fetch');
    } finally {
        h.cleanup();
    }
});

test('the purely LOCAL commands are not given an account', async () => {
    // status / reset / rev-parse never reach the network. Passing an
    // overlay there would spawn them under a different HOME for no
    // reason, and `reset --hard` in particular must stay unaffected by
    // credential configuration.
    const h = makeHarness({
        githubEnvForRepo: () => ({ GH_CONFIG_DIR: 'C:/gh/a' }),
        status: ' M src/Program.cs\n',
    });
    try {
        await h.store.acquire('T-1', 'shop', h.repoPath);
        await h.store.acquire('T-2', 'shop', h.repoPath);

        for (const [i, call] of h.calls.entries()) {
            const head = call[0]!;
            if (head === 'fetch') continue;
            assert.equal(
                h.envs[i],
                undefined,
                `${call.join(' ')} should run ambient`,
            );
        }
    } finally {
        h.cleanup();
    }
});

test('no resolver configured leaves every call ambient', async () => {
    // Nobody has declared an account: behave exactly as before accounts
    // existed, rather than inventing an empty-but-present environment.
    const h = makeHarness();
    try {
        await h.store.acquire('T-1', 'shop', h.repoPath);
        await h.store.acquire('T-2', 'shop', h.repoPath);
        assert.ok(
            h.envs.every((e) => e === undefined),
            'an absent resolver must not change the spawn environment',
        );
    } finally {
        h.cleanup();
    }
});
