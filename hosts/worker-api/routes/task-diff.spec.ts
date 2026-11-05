import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import {
    createTaskDiffHandler,
    createTaskDiffRouter,
    parseUnifiedDiff,
    type GitDiffInvoker,
    type ReadTaskWorktree,
} from './task-diff';

/**
 * Two-file unified diff fixture covering the three line kinds.
 *
 *   - `src/foo.ts`: in-place edit (context + del + add + add + context).
 *   - `src/bar.ts`: brand-new file with `--- /dev/null` source side.
 *
 * Embedded as a string so the parser exercises the same byte sequence
 * git emits, including the `\\ No newline at end of file` sentinel and
 * the trailing newline `git diff` always writes.
 */
const MULTI_FILE_FIXTURE =
    'diff --git a/src/foo.ts b/src/foo.ts\n' +
    'index e69de29..b6fc4c6 100644\n' +
    '--- a/src/foo.ts\n' +
    '+++ b/src/foo.ts\n' +
    '@@ -1,3 +1,4 @@\n' +
    ' alpha\n' +
    '-bravo\n' +
    '+bravo-edited\n' +
    '+charlie\n' +
    ' delta\n' +
    'diff --git a/src/bar.ts b/src/bar.ts\n' +
    'new file mode 100644\n' +
    'index 0000000..d800886\n' +
    '--- /dev/null\n' +
    '+++ b/src/bar.ts\n' +
    '@@ -0,0 +1,2 @@\n' +
    '+hello\n' +
    '+world\n';

test('parseUnifiedDiff classifies add, delete, and context lines (AC #3)', () => {
    const files = parseUnifiedDiff(MULTI_FILE_FIXTURE);
    assert.equal(files.length, 2);
    const foo = files[0];
    assert.equal(foo.path, 'src/foo.ts');
    assert.equal(foo.hunks.length, 1);
    assert.equal(foo.hunks[0].header, '@@ -1,3 +1,4 @@');
    assert.deepEqual(
        foo.hunks[0].lines,
        [
            { kind: 'ctx', text: 'alpha' },
            { kind: 'del', text: 'bravo' },
            { kind: 'add', text: 'bravo-edited' },
            { kind: 'add', text: 'charlie' },
            { kind: 'ctx', text: 'delta' },
        ],
    );
});

test('parseUnifiedDiff splits hunks across files in a multi-file fixture (AC #4)', () => {
    const files = parseUnifiedDiff(MULTI_FILE_FIXTURE);
    assert.deepEqual(
        files.map((f) => f.path),
        ['src/foo.ts', 'src/bar.ts'],
    );
    const bar = files[1];
    assert.equal(bar.hunks.length, 1);
    assert.equal(bar.hunks[0].header, '@@ -0,0 +1,2 @@');
    assert.deepEqual(
        bar.hunks[0].lines,
        [
            { kind: 'add', text: 'hello' },
            { kind: 'add', text: 'world' },
        ],
    );
});

test('parseUnifiedDiff supports multiple hunks within a single file', () => {
    const raw =
        'diff --git a/x.ts b/x.ts\n' +
        'index 1111111..2222222 100644\n' +
        '--- a/x.ts\n' +
        '+++ b/x.ts\n' +
        '@@ -1,2 +1,2 @@\n' +
        '-old-one\n' +
        '+new-one\n' +
        ' same\n' +
        '@@ -20,2 +20,2 @@ function tail()\n' +
        ' before\n' +
        '-removed\n' +
        '+added\n';
    const files = parseUnifiedDiff(raw);
    assert.equal(files.length, 1);
    assert.equal(files[0].hunks.length, 2);
    assert.equal(files[0].hunks[0].header, '@@ -1,2 +1,2 @@');
    assert.equal(
        files[0].hunks[1].header,
        '@@ -20,2 +20,2 @@ function tail()',
    );
    assert.deepEqual(
        files[0].hunks[1].lines.map((l) => l.kind),
        ['ctx', 'del', 'add'],
    );
});

test('parseUnifiedDiff returns an empty array on empty input', () => {
    assert.deepEqual(parseUnifiedDiff(''), []);
});

test('parseUnifiedDiff ignores the "\\ No newline at end of file" sentinel', () => {
    const raw =
        'diff --git a/x b/x\n' +
        '--- a/x\n' +
        '+++ b/x\n' +
        '@@ -1 +1 @@\n' +
        '-old\n' +
        '\\ No newline at end of file\n' +
        '+new\n' +
        '\\ No newline at end of file\n';
    const files = parseUnifiedDiff(raw);
    assert.equal(files.length, 1);
    assert.deepEqual(
        files[0].hunks[0].lines,
        [
            { kind: 'del', text: 'old' },
            { kind: 'add', text: 'new' },
        ],
    );
});

test('parseUnifiedDiff handles plain `diff -u` output without a git header', () => {
    // Fallback path: when there's no `diff --git` line the `+++ b/<p>`
    // line names the file. The board doesn't generate this shape today,
    // but third-party diffs piped through the same parser shouldn't be
    // silently dropped.
    const raw =
        '--- a/y.ts\n' +
        '+++ b/y.ts\n' +
        '@@ -1 +1 @@\n' +
        '-was\n' +
        '+is\n';
    const files = parseUnifiedDiff(raw);
    assert.equal(files.length, 1);
    assert.equal(files[0].path, 'y.ts');
    assert.deepEqual(
        files[0].hunks[0].lines,
        [
            { kind: 'del', text: 'was' },
            { kind: 'add', text: 'is' },
        ],
    );
});

test('handler returns 404 (null) when the task has no worktree (AC #2)', async () => {
    const readTaskWorktree: ReadTaskWorktree = async () => null;
    const gitDiff: GitDiffInvoker = async () => {
        throw new Error('git should not be invoked when worktree is absent');
    };
    const handler = createTaskDiffHandler({ readTaskWorktree, gitDiff });
    const body = await handler({ pid: 'p', planId: 'pl', taskId: 't' });
    assert.equal(body, null);
});

test('handler returns parsed hunks for an existing task with a worktree (AC #1)', async () => {
    const recorded: {
        readArgs: [string, string, string] | null;
        gitArg: string | null;
    } = { readArgs: null, gitArg: null };

    const readTaskWorktree: ReadTaskWorktree = async (pid, planId, taskId) => {
        recorded.readArgs = [pid, planId, taskId];
        return '/tmp/worktrees/task-7';
    };
    const gitDiff: GitDiffInvoker = async (path) => {
        recorded.gitArg = path;
        return MULTI_FILE_FIXTURE;
    };

    const handler = createTaskDiffHandler({ readTaskWorktree, gitDiff });
    const body = await handler({
        pid: 'proj',
        planId: 'plan-1',
        taskId: 'task-7',
    });

    assert.deepEqual(recorded.readArgs, ['proj', 'plan-1', 'task-7']);
    assert.equal(recorded.gitArg, '/tmp/worktrees/task-7');
    if (body === null) {
        throw new Error('expected handler to return a body for an existing task');
    }
    assert.equal(body.files.length, 2);
    assert.equal(body.files[0].path, 'src/foo.ts');
    assert.equal(body.files[1].path, 'src/bar.ts');
    // Spot-check that the structure went through the parser end-to-end
    // rather than being passed through as raw text.
    assert.equal(body.files[0].hunks[0].lines[0].kind, 'ctx');
});

test('handler propagates errors from the git invoker', async () => {
    const readTaskWorktree: ReadTaskWorktree = async () => '/worktree';
    const gitDiff: GitDiffInvoker = async () => {
        throw new Error('git: not a git repository');
    };
    const handler = createTaskDiffHandler({ readTaskWorktree, gitDiff });
    await assert.rejects(
        handler({ pid: 'p', planId: 'pl', taskId: 't' }),
        /not a git repository/,
    );
});

/**
 * Minimal `Db` stand-in for the router: `createReadTaskWorktree` only
 * ever calls `db.prepare(sql).get(taskId)`. We record that lookup key
 * and always report "no worktree" (undefined row → 404), so the real
 * git invoker is never reached. Cast through `unknown` because we
 * implement only the two members the route touches.
 */
function fakeDb(record: { lookupKey: string | null }): {
    prepare(sql: string): { get(key: string): unknown };
} {
    return {
        prepare(_sql: string) {
            return {
                get(key: string) {
                    record.lookupKey = key;
                    return undefined;
                },
            };
        },
    };
}

/** Fake `res` capturing the status code passed to `writeHead`. */
function fakeRes(record: { status: number | null }): {
    writeHead(status: number, headers?: unknown): void;
    end(body?: unknown): void;
} {
    return {
        writeHead(status: number) {
            record.status = status;
        },
        end() {
            /* body ignored */
        },
    };
}

test('router decodes a %2B-encoded task-id segment before the worktree lookup (AC #3, #5)', async () => {
    const record: { lookupKey: string | null } = { lookupKey: null };
    const resRecord: { status: number | null } = { status: null };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const router = createTaskDiffRouter({ db: fakeDb(record) as any });
    const req = {
        url: '/api/projects/proj/plans/plan-1/tasks/P-AR%2BW-001/diff',
        method: 'GET',
    };
    const res = fakeRes(resRecord);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const matched = router.handle(req as any, res as any);
    assert.equal(matched, true);
    // Let the async handler promise settle before asserting.
    await new Promise((resolve) => setImmediate(resolve));

    // The lookup must see the DECODED id, not the raw `P-AR%2BW-001`.
    assert.equal(record.lookupKey, 'P-AR+W-001');
    assert.equal(resRecord.status, 404);
});

test('router leaves an unreserved task-id unchanged through decode (AC #4)', async () => {
    const record: { lookupKey: string | null } = { lookupKey: null };
    const resRecord: { status: number | null } = { status: null };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const router = createTaskDiffRouter({ db: fakeDb(record) as any });
    const req = {
        url: '/api/projects/proj/plans/plan-1/tasks/P-CPTO-009/diff',
        method: 'GET',
    };
    const res = fakeRes(resRecord);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    router.handle(req as any, res as any);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(record.lookupKey, 'P-CPTO-009');
    assert.equal(resRecord.status, 404);
});
