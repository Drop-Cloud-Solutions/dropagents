import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';

import {
  GhPullRequestGateway,
  PrGatewayError,
  type GhExecRunner,
  type PrGatewayExecResult,
} from './pr-gateway';

interface RecordedCall {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
}

interface RecorderOptions {
  readonly responses?: ReadonlyArray<
    PrGatewayExecResult | Error | ((call: RecordedCall) => PrGatewayExecResult | Error)
  >;
  readonly defaultResult?: PrGatewayExecResult;
}

function makeRecorder(options: RecorderOptions = {}): {
  exec: GhExecRunner;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const responses = options.responses ?? [];
  const fallback: PrGatewayExecResult =
    options.defaultResult ?? { stdout: '', stderr: '' };

  const exec: GhExecRunner = async (command, args, runOpts) => {
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

const CWD = path.resolve('/tmp/fake-worktree');

function newGateway(
  exec: GhExecRunner,
  overrides: Partial<{
    env: NodeJS.ProcessEnv | (() => NodeJS.ProcessEnv);
    remote: string;
    gitBin: string;
  }> = {},
): GhPullRequestGateway {
  return new GhPullRequestGateway({
    cwd: CWD,
    exec,
    env: overrides.env,
    remote: overrides.remote,
    gitBin: overrides.gitBin,
  });
}

// ---------------------------------------------------------------------------
// push
// ---------------------------------------------------------------------------

test('push runs `git push -u origin <branch>` in the configured cwd', async () => {
  const { exec, calls } = makeRecorder();
  const gw = newGateway(exec);

  await gw.push('feature/x');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'git');
  assert.equal(calls[0].cwd, CWD);
  assert.deepEqual(calls[0].args, ['push', '-u', 'origin', 'feature/x']);
});

test('push respects an overridden remote name', async () => {
  const { exec, calls } = makeRecorder();
  const gw = newGateway(exec, { remote: 'fork' });

  await gw.push('feature/y');

  assert.deepEqual(calls[0].args, ['push', '-u', 'fork', 'feature/y']);
});

test('push respects an overridden git binary', async () => {
  const { exec, calls } = makeRecorder();
  const gw = newGateway(exec, { gitBin: '/usr/local/bin/git' });

  await gw.push('feature/z');

  assert.equal(calls[0].command, '/usr/local/bin/git');
});

// ---------------------------------------------------------------------------
// openPullRequest
// ---------------------------------------------------------------------------

test('openPullRequest invokes `gh pr create` and parses number + url from stdout', async () => {
  const { exec, calls } = makeRecorder({
    responses: [
      {
        stdout:
          'Creating pull request for feature/pr into main in example/repo\n' +
          'https://github.com/example/repo/pull/42\n',
        stderr: '',
      },
    ],
  });
  const gw = newGateway(exec);

  const pr = await gw.openPullRequest({
    title: 'Feature PR',
    body: 'Body text',
    head: 'feature/pr',
    base: 'main',
  });

  assert.equal(pr.url, 'https://github.com/example/repo/pull/42');
  assert.equal(pr.number, 42);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'gh');
  assert.equal(calls[0].cwd, CWD);
  assert.deepEqual(calls[0].args, [
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
    responses: [{ stdout: 'https://github.com/o/r/pull/7\n', stderr: '' }],
  });
  const gw = newGateway(exec);

  await gw.openPullRequest({ title: 't', head: 'feature/no-body', base: 'main' });

  const args = calls[0].args;
  const bodyIdx = args.indexOf('--body');
  assert.notEqual(bodyIdx, -1);
  assert.equal(args[bodyIdx + 1], '');
});

test('openPullRequest throws a descriptive error if gh output has no PR URL', async () => {
  const { exec } = makeRecorder({
    responses: [{ stdout: 'something unexpected\n', stderr: '' }],
  });
  const gw = newGateway(exec);

  await assert.rejects(
    () =>
      gw.openPullRequest({ title: 't', head: 'feature/bad', base: 'main' }),
    /could not parse a pull-request URL/,
  );
});

// ---------------------------------------------------------------------------
// mergePullRequest
// ---------------------------------------------------------------------------

test('mergePullRequest with squash sends `gh pr merge <n> --squash`', async () => {
  const { exec, calls } = makeRecorder();
  const gw = newGateway(exec);

  await gw.mergePullRequest(99, { method: 'squash' });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'gh');
  assert.deepEqual(calls[0].args, ['pr', 'merge', '99', '--squash']);
});

test('mergePullRequest with merge sends `--merge`', async () => {
  const { exec, calls } = makeRecorder();
  const gw = newGateway(exec);

  await gw.mergePullRequest(12, { method: 'merge' });

  assert.deepEqual(calls[0].args, ['pr', 'merge', '12', '--merge']);
});

test('mergePullRequest with rebase sends `--rebase`', async () => {
  const { exec, calls } = makeRecorder();
  const gw = newGateway(exec);

  await gw.mergePullRequest(3, { method: 'rebase' });

  assert.deepEqual(calls[0].args, ['pr', 'merge', '3', '--rebase']);
});

// ---------------------------------------------------------------------------
// addComment
// ---------------------------------------------------------------------------

test('addComment invokes `gh pr comment <n> --body <body>`', async () => {
  const { exec, calls } = makeRecorder();
  const gw = newGateway(exec);

  await gw.addComment(7, 'LGTM with caveats');

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, [
    'pr',
    'comment',
    '7',
    '--body',
    'LGTM with caveats',
  ]);
});

// ---------------------------------------------------------------------------
// GH_PATH resolution
// ---------------------------------------------------------------------------

test('gh binary defaults to plain "gh" when GH_PATH is unset', async () => {
  const { exec, calls } = makeRecorder();
  const gw = newGateway(exec, { env: {} });

  await gw.addComment(1, 'x');

  assert.equal(calls[0].command, 'gh');
});

test('gh binary resolves from GH_PATH env var', async () => {
  const { exec, calls } = makeRecorder();
  const gw = newGateway(exec, {
    env: { GH_PATH: 'C:\\tools\\gh\\bin\\gh.exe' },
  });

  await gw.addComment(1, 'x');

  assert.equal(calls[0].command, 'C:\\tools\\gh\\bin\\gh.exe');
});

test('GH_PATH is read at call time (function env source reflects later changes)', async () => {
  const { exec, calls } = makeRecorder();
  const env: NodeJS.ProcessEnv = {};
  const gw = newGateway(exec, { env: () => env });

  await gw.addComment(1, 'first');
  assert.equal(calls[0].command, 'gh');

  env.GH_PATH = '/opt/gh/bin/gh';
  await gw.addComment(2, 'second');
  assert.equal(calls[1].command, '/opt/gh/bin/gh');
});

// ---------------------------------------------------------------------------
// Error surface: non-zero exit → typed PrGatewayError with stderr captured
// ---------------------------------------------------------------------------

test('a failing gh invocation surfaces as PrGatewayError carrying stderr', async () => {
  const failure = new PrGatewayError(
    'gh',
    ['pr', 'create'],
    1,
    '',
    'gh: HTTP 401 Bad credentials\n',
  );
  const { exec } = makeRecorder({ responses: [failure] });
  const gw = newGateway(exec);

  await assert.rejects(
    () =>
      gw.openPullRequest({ title: 't', head: 'feature/x', base: 'main' }),
    (err: unknown) => {
      assert.ok(err instanceof PrGatewayError);
      assert.equal(err.command, 'gh');
      assert.equal(err.exitCode, 1);
      assert.match(err.stderr, /401 Bad credentials/);
      assert.match(err.message, /exit 1/);
      assert.match(err.message, /Bad credentials/);
      return true;
    },
  );
});

test('a failing git push surfaces as PrGatewayError', async () => {
  const failure = new PrGatewayError(
    'git',
    ['push', '-u', 'origin', 'feature/x'],
    128,
    '',
    'fatal: unable to access remote\n',
  );
  const { exec } = makeRecorder({ responses: [failure] });
  const gw = newGateway(exec);

  await assert.rejects(
    () => gw.push('feature/x'),
    (err: unknown) => {
      assert.ok(err instanceof PrGatewayError);
      assert.equal(err.command, 'git');
      assert.equal(err.exitCode, 128);
      assert.match(err.stderr, /unable to access remote/);
      return true;
    },
  );
});
