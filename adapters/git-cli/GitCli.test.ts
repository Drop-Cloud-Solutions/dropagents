import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';

import {
  GitCli,
  GitCliError,
  V2_WORKTREE_PREFIX,
  type ExecResult,
  type ExecRunner,
} from './GitCli';

interface RecordedCall {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
}

interface RecorderOptions {
  /**
   * Per-call response. Either a static result, an Error to reject with, or
   * a function that receives the recorded call. Looked up by call index;
   * any call beyond the configured list falls back to `defaultResult`.
   */
  readonly responses?: ReadonlyArray<
    ExecResult | Error | ((call: RecordedCall) => ExecResult | Error)
  >;
  readonly defaultResult?: ExecResult;
}

function makeRecorder(options: RecorderOptions = {}): {
  exec: ExecRunner;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const responses = options.responses ?? [];
  const fallback: ExecResult = options.defaultResult ?? { stdout: '', stderr: '' };

  const exec: ExecRunner = async (command, args, runOpts) => {
    const call: RecordedCall = { command, args: args.slice(), cwd: runOpts.cwd };
    calls.push(call);
    const response = responses[calls.length - 1];
    const resolved =
      typeof response === 'function' ? response(call) : response ?? fallback;
    if (resolved instanceof Error) throw resolved;
    return resolved;
  };

  return { exec, calls };
}

const REPO_ROOT = path.resolve('/tmp/fake-repo');
const WORKTREE_ROOT = path.resolve('/tmp/fake-worktrees');

function newGitCli(exec: ExecRunner, overrides: Partial<{
  env: NodeJS.ProcessEnv;
  defaultBase: string;
}> = {}): GitCli {
  return new GitCli({
    repoRoot: REPO_ROOT,
    worktreeRoot: WORKTREE_ROOT,
    defaultBase: overrides.defaultBase,
    env: overrides.env ?? { GIT_COMMIT_NAME: 'Bot', GIT_COMMIT_EMAIL: 'bot@example.invalid' },
    exec,
  });
}

// ---------------------------------------------------------------------------
// AC #2: createBranch creates a worktree under <worktreeRoot>/v2/<branch>
// ---------------------------------------------------------------------------

test('createBranch invokes `git worktree add -b <name> <v2-path>` under repoRoot', async () => {
  const { exec, calls } = makeRecorder();
  const git = newGitCli(exec);

  await git.createBranch('feature/x');

  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call.command, 'git');
  assert.equal(call.cwd, REPO_ROOT);
  assert.deepEqual(call.args.slice(0, 4), ['worktree', 'add', '-b', 'feature/x']);

  // AC #2: the worktree path must be under <worktreeRoot>/v2/.
  const worktreePath = call.args[4];
  const expected = path.join(WORKTREE_ROOT, V2_WORKTREE_PREFIX, 'feature-x');
  assert.equal(worktreePath, expected);
  assert.ok(
    worktreePath.split(path.sep).includes(V2_WORKTREE_PREFIX),
    `worktree path ${worktreePath} must contain the v2/ prefix`,
  );

  assert.equal(git.getBranch(), 'feature/x');
  assert.equal(git.getWorktreePath(), expected);
});

test('createBranch passes the optional from-ref as the final argument', async () => {
  const { exec, calls } = makeRecorder();
  const git = newGitCli(exec);

  await git.createBranch('feature/y', 'origin/main');

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, [
    'worktree',
    'add',
    '-b',
    'feature/y',
    path.join(WORKTREE_ROOT, V2_WORKTREE_PREFIX, 'feature-y'),
    'origin/main',
  ]);
});

test('worktreePathFor returns a v2-prefixed path without mutating state', () => {
  const { exec } = makeRecorder();
  const git = newGitCli(exec);

  const computed = git.worktreePathFor('feature/z');
  assert.equal(computed, path.join(WORKTREE_ROOT, V2_WORKTREE_PREFIX, 'feature-z'));
  assert.equal(git.getWorktreePath(), undefined);
});

// ---------------------------------------------------------------------------
// AC #3: commit writes worktree-local user.name/email from env, then commits
// ---------------------------------------------------------------------------

test('commit writes worktree-local user.name/email from env before `git commit`', async () => {
  const { exec, calls } = makeRecorder({
    responses: [
      { stdout: '', stderr: '' }, // worktree add
      { stdout: '', stderr: '' }, // config user.name
      { stdout: '', stderr: '' }, // config user.email
      { stdout: '', stderr: '' }, // add -A
      { stdout: '', stderr: '' }, // commit
      { stdout: 'deadbeefcafebabe\n', stderr: '' }, // rev-parse
    ],
  });
  const git = newGitCli(exec, {
    env: { GIT_COMMIT_NAME: 'Pipeline Bot', GIT_COMMIT_EMAIL: 'bot@example.invalid' },
  });

  await git.createBranch('feature/commit');
  const ref = await git.commit({ message: 'feat: do the thing' });

  assert.equal(ref.sha, 'deadbeefcafebabe');

  const worktree = git.getWorktreePath()!;
  const commitCalls = calls.slice(1);

  assert.deepEqual(commitCalls[0].args, [
    'config',
    '--local',
    'user.name',
    'Pipeline Bot',
  ]);
  assert.equal(commitCalls[0].cwd, worktree);

  assert.deepEqual(commitCalls[1].args, [
    'config',
    '--local',
    'user.email',
    'bot@example.invalid',
  ]);
  assert.equal(commitCalls[1].cwd, worktree);

  assert.deepEqual(commitCalls[2].args, ['add', '-A']);
  assert.deepEqual(commitCalls[3].args, ['commit', '-m', 'feat: do the thing']);
  assert.deepEqual(commitCalls[4].args, ['rev-parse', 'HEAD']);

  for (const c of commitCalls) assert.equal(c.cwd, worktree);
});

test('commit with an explicit file list runs `git add -- <files>` instead of `add -A`', async () => {
  const { exec, calls } = makeRecorder({
    responses: [
      { stdout: '', stderr: '' }, // worktree add
      { stdout: '', stderr: '' }, // config user.name
      { stdout: '', stderr: '' }, // config user.email
      { stdout: '', stderr: '' }, // add --
      { stdout: '', stderr: '' }, // commit
      { stdout: 'abc123\n', stderr: '' }, // rev-parse
    ],
  });
  const git = newGitCli(exec);

  await git.createBranch('feature/files');
  await git.commit({ message: 'fix: scoped', files: ['a.ts', 'b.ts'] });

  const addCall = calls[3];
  assert.deepEqual(addCall.args, ['add', '--', 'a.ts', 'b.ts']);
});

test('commit throws if GIT_COMMIT_NAME or GIT_COMMIT_EMAIL is missing', async () => {
  const { exec } = makeRecorder();
  const git = newGitCli(exec, { env: { GIT_COMMIT_NAME: 'only-name' } });
  await git.createBranch('feature/no-email');

  await assert.rejects(
    () => git.commit({ message: 'x' }),
    /GIT_COMMIT_NAME and GIT_COMMIT_EMAIL/,
  );
});

test('commit reads env at call time (function source picks up later changes)', async () => {
  const { exec, calls } = makeRecorder({
    responses: [
      { stdout: '', stderr: '' }, // worktree add
      { stdout: '', stderr: '' }, // config user.name
      { stdout: '', stderr: '' }, // config user.email
      { stdout: '', stderr: '' }, // add -A
      { stdout: '', stderr: '' }, // commit
      { stdout: 'sha\n', stderr: '' }, // rev-parse
    ],
  });

  const env: NodeJS.ProcessEnv = {};
  const git = new GitCli({
    repoRoot: REPO_ROOT,
    worktreeRoot: WORKTREE_ROOT,
    exec,
    env: () => env,
  });

  await git.createBranch('feature/late-env');
  env.GIT_COMMIT_NAME = 'Late Bot';
  env.GIT_COMMIT_EMAIL = 'late@example.invalid';

  await git.commit({ message: 'late' });
  assert.deepEqual(calls[1].args, ['config', '--local', 'user.name', 'Late Bot']);
  assert.deepEqual(calls[2].args, ['config', '--local', 'user.email', 'late@example.invalid']);
});

test('commit fails when invoked before createBranch', async () => {
  const { exec } = makeRecorder();
  const git = newGitCli(exec);
  await assert.rejects(() => git.commit({ message: 'x' }), /no active worktree/);
});

// ---------------------------------------------------------------------------
// AC #4: openPullRequest calls gh pr create and returns the parsed URL
// ---------------------------------------------------------------------------

test('openPullRequest invokes `gh pr create` and parses the PR URL from stdout', async () => {
  const { exec, calls } = makeRecorder({
    responses: [
      { stdout: '', stderr: '' }, // worktree add
      {
        stdout:
          'Creating pull request for feature/pr into main in example/repo\n' +
          'https://github.com/example/repo/pull/42\n',
        stderr: '',
      },
    ],
  });
  const git = newGitCli(exec);
  await git.createBranch('feature/pr');

  const pr = await git.openPullRequest({
    title: 'Feature PR',
    body: 'Body text',
    head: 'feature/pr',
    base: 'main',
  });

  assert.equal(pr.url, 'https://github.com/example/repo/pull/42');
  assert.equal(pr.number, 42);
  assert.equal(pr.id, pr.url);

  const ghCall = calls[1];
  assert.equal(ghCall.command, 'gh');
  assert.equal(ghCall.cwd, git.getWorktreePath());
  assert.deepEqual(ghCall.args, [
    'pr',
    'create',
    '--head',
    'feature/pr',
    '--base',
    'main',
    '--title',
    'Feature PR',
    '--body',
    'Body text',
  ]);
});

test('openPullRequest sends an empty --body when none is supplied', async () => {
  const { exec, calls } = makeRecorder({
    responses: [
      { stdout: '', stderr: '' }, // worktree add
      { stdout: 'https://github.com/o/r/pull/7\n', stderr: '' },
    ],
  });
  const git = newGitCli(exec);
  await git.createBranch('feature/no-body');

  await git.openPullRequest({ title: 't', head: 'feature/no-body', base: 'main' });
  const args = calls[1].args;
  const bodyIdx = args.indexOf('--body');
  assert.notEqual(bodyIdx, -1);
  assert.equal(args[bodyIdx + 1], '');
});

test('openPullRequest throws a descriptive error if gh output has no PR URL', async () => {
  const { exec } = makeRecorder({
    responses: [
      { stdout: '', stderr: '' }, // worktree add
      { stdout: 'something unexpected\n', stderr: '' },
    ],
  });
  const git = newGitCli(exec);
  await git.createBranch('feature/bad-output');

  await assert.rejects(
    () =>
      git.openPullRequest({ title: 't', head: 'feature/bad-output', base: 'main' }),
    /could not parse a pull-request URL/,
  );
});

// ---------------------------------------------------------------------------
// AC #5: getDiff returns the unified diff between branch and base
// ---------------------------------------------------------------------------

test('getDiff returns stdout from `git diff base...head` against the worktree', async () => {
  const diffText = 'diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b\n';
  const { exec, calls } = makeRecorder({
    responses: [
      { stdout: '', stderr: '' }, // worktree add
      { stdout: diffText, stderr: '' },
    ],
  });
  const git = newGitCli(exec, { defaultBase: 'main' });
  await git.createBranch('feature/diff');

  const out = await git.getDiff();
  assert.equal(out, diffText);

  const diffCall = calls[1];
  assert.equal(diffCall.command, 'git');
  assert.equal(diffCall.cwd, git.getWorktreePath());
  assert.deepEqual(diffCall.args, ['diff', 'main...HEAD']);
});

test('getDiff respects explicit base/head options', async () => {
  const { exec, calls } = makeRecorder({
    responses: [
      { stdout: '', stderr: '' }, // worktree add
      { stdout: '', stderr: '' }, // diff
    ],
  });
  const git = newGitCli(exec);
  await git.createBranch('feature/explicit-diff');

  await git.getDiff({ base: 'origin/master', head: 'feature/explicit-diff' });
  assert.deepEqual(calls[1].args, ['diff', 'origin/master...feature/explicit-diff']);
});

// ---------------------------------------------------------------------------
// AC #6: Failures throw GitCliError with command, args, exit code
// ---------------------------------------------------------------------------

test('a failing git invocation surfaces as GitCliError with command/args/exitCode', async () => {
  const failure = new GitCliError(
    'git',
    ['worktree', 'add', '-b', 'feature/boom', '/tmp/x'],
    128,
    '',
    "fatal: 'feature/boom' is already checked out\n",
  );
  const { exec } = makeRecorder({ responses: [failure] });
  const git = newGitCli(exec);

  await assert.rejects(
    () => git.createBranch('feature/boom'),
    (err: unknown) => {
      assert.ok(err instanceof GitCliError);
      assert.equal(err.command, 'git');
      assert.equal(err.exitCode, 128);
      assert.deepEqual(err.args, [
        'worktree',
        'add',
        '-b',
        'feature/boom',
        '/tmp/x',
      ]);
      assert.match(err.message, /exit 128/);
      assert.match(err.message, /already checked out/);
      return true;
    },
  );
});

test('a failing gh invocation propagates the underlying GitCliError', async () => {
  const ghFailure = new GitCliError(
    'gh',
    ['pr', 'create'],
    1,
    '',
    'gh: HTTP 401 Bad credentials\n',
  );
  const { exec } = makeRecorder({
    responses: [{ stdout: '', stderr: '' }, ghFailure],
  });
  const git = newGitCli(exec);
  await git.createBranch('feature/gh-fail');

  await assert.rejects(
    () =>
      git.openPullRequest({ title: 't', head: 'feature/gh-fail', base: 'main' }),
    (err: unknown) => {
      assert.ok(err instanceof GitCliError);
      assert.equal(err.command, 'gh');
      assert.equal(err.exitCode, 1);
      return true;
    },
  );
});
