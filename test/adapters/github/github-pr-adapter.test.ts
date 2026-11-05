/**
 * Unit tests for `GitHubPrAdapter` — the typed-error `gh` CLI adapter
 * for the AP-VP6 `GitHostPort`.
 *
 * Dual-runner discovery: the repo's `npm test` runs node:test
 * (`node --test --import tsx`); the review pipeline runs `npx vitest run`
 * against changed test files. The shim below picks the right `test()`
 * at module load so both runners discover the same suite from a single
 * source file — without ever statically importing from `vitest`, which
 * would crash under `node --test`. See vitest.config.ts for the
 * matching `globals: true` setting and recorder.test.ts for the
 * pattern's first use.
 */
import assert from 'node:assert/strict';
import * as path from 'path';

import {
  GitHubPrAdapter,
  type GhExecResult,
  type GhExecRunner,
} from '../../../adapters/github/github-pr-adapter';
import type { GitHostPort } from '../../../core/ports/git-host';

// ---------------------------------------------------------------------------
// Dual-runner test() shim
// ---------------------------------------------------------------------------

type TestFn = (name: string, fn: () => void | Promise<void>) => void;

const test: TestFn = (((): TestFn => {
  if (process.env.VITEST) {
    const gt = (globalThis as { test?: TestFn }).test;
    if (typeof gt !== 'function') {
      throw new Error(
        'github-pr-adapter.test.ts: VITEST=true but globalThis.test is missing — '
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
// Helpers
// ---------------------------------------------------------------------------

interface RecordedCall {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
}

function makeExec(
  responses: ReadonlyArray<GhExecResult>,
): { exec: GhExecRunner; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const exec: GhExecRunner = async (command, args, runOpts) => {
    const call: RecordedCall = {
      command,
      args: args.slice(),
      cwd: runOpts.cwd,
    };
    calls.push(call);
    const response = responses[calls.length - 1] ?? {
      stdout: '',
      stderr: '',
      exitCode: 0,
    };
    return response;
  };
  return { exec, calls };
}

const CWD = path.resolve('/tmp/fake-worktree');

function ok(stdout: string, stderr = ''): GhExecResult {
  return { stdout, stderr, exitCode: 0 };
}

function fail(stderr: string, exitCode = 1, stdout = ''): GhExecResult {
  return { stdout, stderr, exitCode };
}

// Compile-time assertion: GitHubPrAdapter satisfies GitHostPort without
// any `as any` casts (AC 1). The unused-let pragma keeps the runtime
// noise to zero while still forcing the structural check.
type _AssertsGitHostPort =
  GitHubPrAdapter extends GitHostPort ? true : never;
const _portCheck: _AssertsGitHostPort = true;
void _portCheck;

// ---------------------------------------------------------------------------
// openPr — success + BranchNotPushed mapping (AC 3)
// ---------------------------------------------------------------------------

test('openPr success parses number + url and forwards spec to gh pr create', async () => {
  const { exec, calls } = makeExec([
    ok(
      'Creating pull request for feature/x into main in example/repo\n'
        + 'https://github.com/example/repo/pull/77\n',
    ),
  ]);
  const adapter = new GitHubPrAdapter({ cwd: CWD, exec });

  const ref = await adapter.openPr({
    title: 'Feature X',
    body: 'detail',
    head: 'feature/x',
    base: 'main',
  });

  assert.deepEqual(ref, {
    number: 77,
    url: 'https://github.com/example/repo/pull/77',
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'gh');
  assert.equal(calls[0].cwd, CWD);
  assert.deepEqual(calls[0].args, [
    'pr',
    'create',
    '--head',
    'feature/x',
    '--base',
    'main',
    '--title',
    'Feature X',
    '--body',
    'detail',
  ]);
});

test('openPr maps "no upstream" stderr to BranchNotPushed (AC 3)', async () => {
  const { exec } = makeExec([
    fail(
      'fatal: The current branch feature/orphan has no upstream branch.\n'
        + 'To push the current branch and set the remote as upstream, use\n',
    ),
  ]);
  const adapter = new GitHubPrAdapter({ cwd: CWD, exec });

  await assert.rejects(
    () =>
      adapter.openPr({
        title: 't',
        head: 'feature/orphan',
        base: 'main',
      }),
    (err: unknown) => {
      assert.ok(err && typeof err === 'object' && 'kind' in err);
      const e = err as { kind: string; branch?: string; message: string };
      assert.equal(e.kind, 'BranchNotPushed');
      assert.equal(e.branch, 'feature/orphan');
      assert.match(e.message, /no upstream branch/);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// commentOnPr — success + AuthMissing mapping
// ---------------------------------------------------------------------------

test('commentOnPr success sends `gh pr comment <n> --body <body>`', async () => {
  const { exec, calls } = makeExec([ok('')]);
  const adapter = new GitHubPrAdapter({ cwd: CWD, exec });

  await adapter.commentOnPr(
    { number: 12, url: 'https://github.com/o/r/pull/12' },
    'LGTM',
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'gh');
  assert.deepEqual(calls[0].args, [
    'pr',
    'comment',
    '12',
    '--body',
    'LGTM',
  ]);
});

test('commentOnPr maps auth-missing stderr to AuthMissing', async () => {
  const { exec } = makeExec([
    fail('gh: To use GitHub CLI, please run: gh auth login\n'),
  ]);
  const adapter = new GitHubPrAdapter({ cwd: CWD, exec });

  await assert.rejects(
    () =>
      adapter.commentOnPr(
        { number: 12, url: 'https://github.com/o/r/pull/12' },
        'x',
      ),
    (err: unknown) => {
      assert.ok(err && typeof err === 'object' && 'kind' in err);
      const e = err as { kind: string; message: string };
      assert.equal(e.kind, 'AuthMissing');
      assert.match(e.message, /gh auth login/);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// mergePr — success uses --squash (AC 5) + RequiredChecks / MergeConflict (AC 4)
// ---------------------------------------------------------------------------

test('mergePr success always uses --squash regardless of options.method (AC 5)', async () => {
  const { exec, calls } = makeExec([ok('Squashed and merged.\n'), ok('')]);
  const adapter = new GitHubPrAdapter({ cwd: CWD, exec });
  const ref = { number: 4, url: 'https://github.com/o/r/pull/4' };

  // squash explicitly
  await adapter.mergePr(ref, { method: 'squash' });
  assert.deepEqual(calls[0].args, ['pr', 'merge', '4', '--squash']);

  // merge requested — adapter still squashes (AP-VP6-010 contract)
  await adapter.mergePr(ref, { method: 'merge' });
  assert.deepEqual(calls[1].args, ['pr', 'merge', '4', '--squash']);
});

test('mergePr maps "required status checks" stderr to RequiredChecksBlocking (AC 4)', async () => {
  const { exec } = makeExec([
    fail(
      'X Pull request is not mergeable\n'
        + 'Required status checks have not passed:\n'
        + '- ci/build\n'
        + '- ci/lint\n',
    ),
  ]);
  const adapter = new GitHubPrAdapter({ cwd: CWD, exec });

  await assert.rejects(
    () =>
      adapter.mergePr(
        { number: 42, url: 'https://github.com/o/r/pull/42' },
        { method: 'squash' },
      ),
    (err: unknown) => {
      assert.ok(err && typeof err === 'object' && 'kind' in err);
      const e = err as {
        kind: string;
        prNumber: number;
        failingChecks: readonly string[];
        message: string;
      };
      assert.equal(e.kind, 'RequiredChecksBlocking');
      assert.equal(e.prNumber, 42);
      assert.deepEqual([...e.failingChecks], ['ci/build', 'ci/lint']);
      assert.match(e.message, /Required status checks/);
      return true;
    },
  );
});

test('mergePr maps merge-conflict stderr to MergeConflict (AC 4)', async () => {
  const { exec } = makeExec([
    fail('X Pull request has merge conflicts that must be resolved.\n'),
  ]);
  const adapter = new GitHubPrAdapter({ cwd: CWD, exec });

  await assert.rejects(
    () =>
      adapter.mergePr(
        { number: 9, url: 'https://github.com/o/r/pull/9' },
        { method: 'squash' },
      ),
    (err: unknown) => {
      assert.ok(err && typeof err === 'object' && 'kind' in err);
      const e = err as { kind: string; prNumber: number; message: string };
      assert.equal(e.kind, 'MergeConflict');
      assert.equal(e.prNumber, 9);
      assert.match(e.message, /merge conflict/i);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// GH_PATH / unmapped-stderr behaviour
// ---------------------------------------------------------------------------

test('GH_PATH env var overrides the gh binary at call time', async () => {
  const { exec, calls } = makeExec([ok('https://github.com/o/r/pull/1\n')]);
  const adapter = new GitHubPrAdapter({
    cwd: CWD,
    exec,
    env: { GH_PATH: 'C:\\tools\\gh\\bin\\gh.exe' },
  });

  await adapter.openPr({ title: 't', head: 'h', base: 'main' });

  assert.equal(calls[0].command, 'C:\\tools\\gh\\bin\\gh.exe');
});

test('unmapped gh stderr surfaces as a plain Error preserving the raw text', async () => {
  const { exec } = makeExec([fail('something totally unexpected went wrong\n')]);
  const adapter = new GitHubPrAdapter({ cwd: CWD, exec });

  await assert.rejects(
    () =>
      adapter.commentOnPr(
        { number: 1, url: 'https://github.com/o/r/pull/1' },
        'x',
      ),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(!('kind' in err));
      assert.match(err.message, /unmapped stderr/);
      assert.match(err.message, /something totally unexpected/);
      return true;
    },
  );
});
