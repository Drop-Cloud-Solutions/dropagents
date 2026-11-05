/**
 * Unit tests for the per-task `.agent-stream.jsonl` touch behaviour added
 * to `WorktreeManager.create`. The board's SSE tail attaches to that file
 * as soon as a worktree appears, so the runner must not be the thing that
 * creates it — touching an empty file from `create()` eliminates the race
 * where the tail opens before the runner's first stdout line and misses
 * lines until a poll cycle catches up.
 *
 * Each test runs in an isolated `os.tmpdir()` directory. The exec runner
 * is stubbed to mirror `git worktree add` / `remove --force` against the
 * real filesystem (create / recursive-rmdir of the target path) so the
 * "create → file exists, empty → remove → file gone" assertion chain
 * touches actual disk state rather than an in-memory harness.
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { Logger } from '../../core/ports/Logger';
import {
    AGENT_STREAM_FILENAME,
    WorktreeManager,
    type ExecRunner,
    type ExecResult,
    type TaskStateLookup,
} from './worktree-manager';

const NOOP_TASK_STORE: TaskStateLookup = { isTerminal: (): boolean => false };

function makeLogger(): Logger {
    const noop = (): void => undefined;
    return { info: noop, warn: noop, error: noop, debug: noop };
}

function makeTempRoots(): { repoRoot: string; worktreeRoot: string; cleanup: () => void } {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-mgr-stream-repo-'));
    const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-mgr-stream-wt-'));
    return {
        repoRoot,
        worktreeRoot,
        cleanup: (): void => {
            fs.rmSync(repoRoot, { recursive: true, force: true });
            fs.rmSync(worktreeRoot, { recursive: true, force: true });
        },
    };
}

/**
 * Stub exec that mirrors the real `git worktree` side-effects we care
 * about for these tests: `add <target> <branch>` creates the target
 * directory; `remove --force <target>` recursively deletes it. Every
 * other invocation is treated as a no-op success.
 */
function fsBackedExec(): ExecRunner {
    return async (_command, args): Promise<ExecResult> => {
        if (args[0] === 'worktree' && args[1] === 'add') {
            const target = args[2];
            fs.mkdirSync(target, { recursive: true });
            return { stdout: '', stderr: '' };
        }
        if (args[0] === 'worktree' && args[1] === 'remove') {
            // last arg is the target; ignore --force flag position.
            const target = args[args.length - 1];
            fs.rmSync(target, { recursive: true, force: true });
            return { stdout: '', stderr: '' };
        }
        return { stdout: '', stderr: '' };
    };
}

function newManager(repoRoot: string, worktreeRoot: string): WorktreeManager {
    return new WorktreeManager({
        repoRoot,
        worktreeRoot,
        taskStore: NOOP_TASK_STORE,
        logger: makeLogger(),
        exec: fsBackedExec(),
    });
}

// ---------------------------------------------------------------------------
// AC #1: create() touches an empty .agent-stream.jsonl after `git worktree
// add` returns, before the agent runner is spawned.
// ---------------------------------------------------------------------------

test('create touches an empty .agent-stream.jsonl at the worktree root', async () => {
    const { repoRoot, worktreeRoot, cleanup } = makeTempRoots();
    try {
        const mgr = newManager(repoRoot, worktreeRoot);
        const target = await mgr.create('task-touch', 'feature/touch');

        const streamPath = path.join(target, AGENT_STREAM_FILENAME);
        assert.equal(
            fs.existsSync(streamPath),
            true,
            '.agent-stream.jsonl must exist immediately after create()',
        );
        const st = fs.statSync(streamPath);
        assert.equal(st.isFile(), true);
        assert.equal(st.size, 0, 'touched stream file must be zero-byte');
    } finally {
        cleanup();
    }
});

// ---------------------------------------------------------------------------
// AC #2: create() is idempotent — re-running on an existing worktree must
// not truncate a populated stream file. This is the crash-recovery path
// where the orchestrator replays TaskApproved against a worktree the
// previous run already populated.
// ---------------------------------------------------------------------------

test('create on an existing worktree leaves a populated stream file untouched', async () => {
    const { repoRoot, worktreeRoot, cleanup } = makeTempRoots();
    try {
        const mgr = newManager(repoRoot, worktreeRoot);

        // Pre-seed the worktree directory and a populated stream file, as
        // would survive an orchestrator restart mid-run.
        const target = mgr.worktreePathFor('task-replay');
        fs.mkdirSync(target, { recursive: true });
        const streamPath = path.join(target, AGENT_STREAM_FILENAME);
        const populated = '{"type":"AgentStarted","role":"developer"}\n';
        fs.writeFileSync(streamPath, populated);

        const out = await mgr.create('task-replay', 'feature/replay');
        assert.equal(out, target);
        assert.equal(
            fs.readFileSync(streamPath, 'utf8'),
            populated,
            'adopted worktree must keep the existing stream contents',
        );
    } finally {
        cleanup();
    }
});

// ---------------------------------------------------------------------------
// AC #3: remove() cleans up the stream file along with the rest of the
// worktree. This is existing behaviour (`git worktree remove --force`
// drops the directory) — the test pins it so a future refactor cannot
// regress the cleanup contract.
// ---------------------------------------------------------------------------

test('remove deletes the worktree directory, including the touched stream file', async () => {
    const { repoRoot, worktreeRoot, cleanup } = makeTempRoots();
    try {
        const mgr = newManager(repoRoot, worktreeRoot);
        const target = await mgr.create('task-cleanup', 'feature/cleanup');
        const streamPath = path.join(target, AGENT_STREAM_FILENAME);
        assert.equal(fs.existsSync(streamPath), true);

        await mgr.remove('task-cleanup');

        assert.equal(
            fs.existsSync(streamPath),
            false,
            '.agent-stream.jsonl must be gone after remove',
        );
        assert.equal(
            fs.existsSync(target),
            false,
            'worktree directory must be gone after remove',
        );
    } finally {
        cleanup();
    }
});
