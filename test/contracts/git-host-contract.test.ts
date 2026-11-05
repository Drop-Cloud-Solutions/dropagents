/**
 * Contract test for {@link GitHostPort} (AP-VP6-014).
 *
 * Validates the port's structural contract against the concrete
 * `GitHubPrAdapter` implementation. Any adapter we later add (octokit-
 * native, GitLab, ...) should be runnable against the same suite by
 * swapping the `makeAdapter` factory.
 *
 * Two layers:
 *
 *   1. Mocked-exec layer (always runs) — drives `GitHubPrAdapter`
 *      through an injected `GhExecRunner` that replays canned stdout /
 *      stderr. Exercises every success path plus all four
 *      `GitHostError` kinds: `AuthMissing`, `BranchNotPushed`,
 *      `MergeConflict`, `RequiredChecksBlocking`.
 *
 *   2. Real-adapter smoke layer (gated on `GH_TEST_REPO` env) — clones
 *      the configured throwaway repository, pushes a trivial branch,
 *      opens a PR with `openPr`, comments via `commentOnPr`, and
 *      squash-merges via `mergePr`. Cleans up the temp clone and the
 *      throwaway branch on the remote regardless of outcome. Skipped
 *      with a placeholder test when `GH_TEST_REPO` (and ideally
 *      `GH_TOKEN` so gh can authenticate non-interactively) are unset.
 *
 * Runner: `npx vitest run test/contracts/git-host-contract.test.ts`.
 * The dual-runner shim below also makes the file discoverable by the
 * repo's primary `node --test --import tsx` runner — both runners pick
 * the same `test()` registration without statically importing from
 * `vitest`. See `test/adapters/github/github-pr-adapter.test.ts` for
 * the same shim used elsewhere in the repo.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

import {
  GitHubPrAdapter,
  type GhExecResult,
  type GhExecRunner,
} from '../../adapters/github/github-pr-adapter';
import type {
  GitHostError,
  GitHostPort,
  PrRef,
} from '../../core/ports/git-host';

// ---------------------------------------------------------------------------
// Dual-runner test() shim — see header. Mirrors the pattern in
// test/adapters/github/github-pr-adapter.test.ts so the file works under
// both `npx vitest run` and `node --test --import tsx`.
// ---------------------------------------------------------------------------

type TestFn = (name: string, fn: () => void | Promise<void>) => void;

const test: TestFn = (((): TestFn => {
  if (process.env.VITEST) {
    const gt = (globalThis as { test?: TestFn }).test;
    if (typeof gt !== 'function') {
      throw new Error(
        'git-host-contract.test.ts: VITEST=true but globalThis.test is missing — '
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
// Mocked-exec helpers
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
    calls.push({ command, args: args.slice(), cwd: runOpts.cwd });
    return (
      responses[calls.length - 1] ?? { stdout: '', stderr: '', exitCode: 0 }
    );
  };
  return { exec, calls };
}

function ok(stdout: string, stderr = ''): GhExecResult {
  return { stdout, stderr, exitCode: 0 };
}

function fail(stderr: string, exitCode = 1, stdout = ''): GhExecResult {
  return { stdout, stderr, exitCode };
}

const FAKE_CWD = path.resolve('/tmp/git-host-contract-fake-worktree');

/**
 * Factory under test. Swap this to run the same suite against a future
 * adapter — the contract is defined in terms of `GitHostPort`, not
 * `GitHubPrAdapter`.
 */
function makeAdapter(exec: GhExecRunner, cwd: string = FAKE_CWD): GitHostPort {
  return new GitHubPrAdapter({ cwd, exec });
}

/**
 * Run `fn` and capture either its resolved value or whatever it threw —
 * never both. Callers narrow on `.thrown` to assert error shape, and on
 * `.value` to assert success shape, without nesting try/catch in the
 * test body.
 */
async function settle<T>(
  fn: () => Promise<T>,
): Promise<{ value: T | undefined; thrown: unknown }> {
  try {
    return { value: await fn(), thrown: undefined };
  } catch (err) {
    return { value: undefined, thrown: err };
  }
}

function isGitHostError(value: unknown): value is GitHostError {
  return (
    typeof value === 'object'
    && value !== null
    && 'kind' in value
    && typeof (value as { kind: unknown }).kind === 'string'
  );
}

// ---------------------------------------------------------------------------
// Mocked-exec contract — success paths
// ---------------------------------------------------------------------------

test('contract: openPr success returns a typed PrRef and does not throw', async () => {
  const { exec, calls } = makeExec([
    ok(
      'Creating pull request for feature/x into main in example/shop\n'
        + 'https://github.com/example/shop/pull/4242\n',
    ),
  ]);
  const adapter = makeAdapter(exec);

  const settled = await settle(() =>
    adapter.openPr({
      title: 'Feature X',
      body: 'body',
      head: 'feature/x',
      base: 'main',
    }),
  );

  assert.equal(
    settled.thrown,
    undefined,
    'openPr success path must not throw',
  );
  const ref = settled.value as PrRef;
  assert.equal(typeof ref.number, 'number');
  assert.equal(typeof ref.url, 'string');
  assert.equal(ref.number, 4242);
  assert.equal(ref.url, 'https://github.com/example/shop/pull/4242');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'gh');
});

test('contract: commentOnPr success is observable as a recorded gh call', async () => {
  const { exec, calls } = makeExec([ok('')]);
  const adapter = makeAdapter(exec);
  const ref: PrRef = {
    number: 17,
    url: 'https://github.com/example/shop/pull/17',
  };

  const settled = await settle(() => adapter.commentOnPr(ref, 'LGTM'));

  assert.equal(
    settled.thrown,
    undefined,
    'commentOnPr success path must not throw',
  );
  assert.equal(settled.value, undefined, 'commentOnPr resolves to void');
  assert.equal(calls.length, 1, 'comment must be observable as one gh call');
  assert.deepEqual(calls[0].args, [
    'pr',
    'comment',
    '17',
    '--body',
    'LGTM',
  ]);
});

test('contract: mergePr success returns a typed result (void) and does not throw', async () => {
  const { exec, calls } = makeExec([ok('Squashed and merged.\n')]);
  const adapter = makeAdapter(exec);
  const ref: PrRef = {
    number: 17,
    url: 'https://github.com/example/shop/pull/17',
  };

  const settled = await settle(() => adapter.mergePr(ref, { method: 'squash' }));

  assert.equal(
    settled.thrown,
    undefined,
    'mergePr success path must not throw',
  );
  assert.equal(settled.value, undefined, 'mergePr resolves to void on success');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args[0], 'pr');
  assert.equal(calls[0].args[1], 'merge');
});

// ---------------------------------------------------------------------------
// Mocked-exec contract — all four typed GitHostError kinds (AC 1, AC 4)
// ---------------------------------------------------------------------------

test('contract: openPr on an unpushed branch surfaces a typed BranchNotPushed error', async () => {
  const { exec } = makeExec([
    fail(
      'fatal: The current branch feature/orphan has no upstream branch.\n'
        + 'To push the current branch and set the remote as upstream, use\n',
    ),
  ]);
  const adapter = makeAdapter(exec);

  const settled = await settle(() =>
    adapter.openPr({
      title: 'orphan',
      head: 'feature/orphan',
      base: 'main',
    }),
  );

  assert.equal(settled.value, undefined, 'failure path must not return a value');
  assert.ok(
    isGitHostError(settled.thrown),
    'thrown value must satisfy GitHostError (have a string `kind`)',
  );
  assert.ok(
    !(settled.thrown instanceof Error),
    'GitHostError is a structural value — not an Error subclass — so callers can switch on `kind` without instanceof',
  );
  const err = settled.thrown as GitHostError;
  assert.equal(err.kind, 'BranchNotPushed');
  if (err.kind === 'BranchNotPushed') {
    assert.equal(err.branch, 'feature/orphan');
    assert.match(err.message, /no upstream branch/);
  }
});

test('contract: mergePr on a conflicting branch surfaces a typed MergeConflict error', async () => {
  const { exec } = makeExec([
    fail('X Pull request has merge conflicts that must be resolved.\n'),
  ]);
  const adapter = makeAdapter(exec);
  const ref: PrRef = {
    number: 91,
    url: 'https://github.com/example/shop/pull/91',
  };

  const settled = await settle(() => adapter.mergePr(ref, { method: 'squash' }));

  assert.equal(settled.value, undefined);
  assert.ok(isGitHostError(settled.thrown));
  assert.ok(!(settled.thrown instanceof Error));
  const err = settled.thrown as GitHostError;
  assert.equal(err.kind, 'MergeConflict');
  if (err.kind === 'MergeConflict') {
    assert.equal(err.prNumber, 91);
    assert.match(err.message, /merge conflict/i);
  }
});

test('contract: mergePr on a required-checks-blocked branch surfaces RequiredChecksBlocking', async () => {
  const { exec } = makeExec([
    fail(
      'X Pull request is not mergeable\n'
        + 'Required status checks have not passed:\n'
        + '- ci/build\n'
        + '- ci/lint\n',
    ),
  ]);
  const adapter = makeAdapter(exec);
  const ref: PrRef = {
    number: 314,
    url: 'https://github.com/example/shop/pull/314',
  };

  const settled = await settle(() => adapter.mergePr(ref, { method: 'squash' }));

  assert.equal(settled.value, undefined);
  assert.ok(isGitHostError(settled.thrown));
  assert.ok(!(settled.thrown instanceof Error));
  const err = settled.thrown as GitHostError;
  assert.equal(err.kind, 'RequiredChecksBlocking');
  if (err.kind === 'RequiredChecksBlocking') {
    assert.equal(err.prNumber, 314);
    assert.deepEqual([...err.failingChecks], ['ci/build', 'ci/lint']);
    assert.match(err.message, /Required status checks/);
  }
});

test('contract: missing gh auth surfaces AuthMissing on any port operation', async () => {
  const { exec } = makeExec([
    fail('gh: To use GitHub CLI, please run: gh auth login\n'),
  ]);
  const adapter = makeAdapter(exec);

  const settled = await settle(() =>
    adapter.commentOnPr(
      { number: 1, url: 'https://github.com/example/shop/pull/1' },
      'hi',
    ),
  );

  assert.equal(settled.value, undefined);
  assert.ok(isGitHostError(settled.thrown));
  assert.ok(!(settled.thrown instanceof Error));
  const err = settled.thrown as GitHostError;
  assert.equal(err.kind, 'AuthMissing');
  if (err.kind === 'AuthMissing') {
    assert.match(err.message, /gh auth login/);
  }
});

// ---------------------------------------------------------------------------
// Real-adapter smoke (AC 2, AC 3) — gated on GH_TEST_REPO
// ---------------------------------------------------------------------------

const realRepo = process.env.GH_TEST_REPO?.trim();
const realToken = process.env.GH_TOKEN?.trim();

if (!realRepo || !realToken) {
  test('real-adapter smoke: skipped (set GH_TEST_REPO and GH_TOKEN to enable)', () => {
    assert.ok(
      true,
      'GH_TEST_REPO / GH_TOKEN unset — real-adapter smoke is gated off (AC 2).',
    );
  });
} else {
  test('real-adapter smoke: opens + squash-merges a throwaway branch on GH_TEST_REPO', async () => {
    const execFileP = promisify(execFile);
    const branch = `ap-vp6-014-smoke-${Date.now()}-${process.pid}`;
    const tempRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'git-host-contract-'),
    );
    const cloneDir = path.join(tempRoot, 'repo');
    let openedPr: PrRef | undefined;

    /**
     * Clean up *everything* this test created — temp clone, local
     * branch, remote branch — regardless of which step failed. The
     * remote branch deletion uses `gh api` so it works even when
     * the squash-merge already collapsed the branch (GitHub auto-
     * deletes only when the repo setting is on; we should not assume
     * it is).
     */
    const cleanup = async (): Promise<void> => {
      if (openedPr) {
        try {
          await execFileP('gh', ['pr', 'close', String(openedPr.number)], {
            cwd: cloneDir,
          });
        } catch {
          // PR may already be merged — ignore.
        }
      }
      try {
        await execFileP(
          'gh',
          [
            'api',
            '-X',
            'DELETE',
            `repos/${realRepo}/git/refs/heads/${branch}`,
          ],
          { cwd: cloneDir },
        );
      } catch {
        // Remote branch may already be gone — ignore.
      }
      try {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      } catch {
        // Best-effort.
      }
    };

    try {
      await execFileP('gh', ['repo', 'clone', realRepo, cloneDir]);
      await execFileP(
        'git',
        ['config', 'user.email', 'ap-vp6-014-smoke@example.test'],
        { cwd: cloneDir },
      );
      await execFileP(
        'git',
        ['config', 'user.name', 'AP-VP6-014 Smoke'],
        { cwd: cloneDir },
      );
      await execFileP('git', ['checkout', '-b', branch], { cwd: cloneDir });

      const stamp = path.join(cloneDir, `.ap-vp6-014-${Date.now()}.txt`);
      fs.writeFileSync(stamp, 'ap-vp6-014 contract smoke\n', 'utf8');
      await execFileP('git', ['add', path.basename(stamp)], { cwd: cloneDir });
      await execFileP(
        'git',
        ['commit', '-m', `chore(test): ap-vp6-014 contract smoke ${branch}`],
        { cwd: cloneDir },
      );
      await execFileP('git', ['push', '-u', 'origin', branch], {
        cwd: cloneDir,
      });

      // Resolve the default branch off the remote so we don't assume `main`.
      const { stdout: baseStdout } = await execFileP(
        'gh',
        [
          'repo',
          'view',
          realRepo,
          '--json',
          'defaultBranchRef',
          '--jq',
          '.defaultBranchRef.name',
        ],
        { cwd: cloneDir },
      );
      const base = baseStdout.trim() || 'main';

      const adapter: GitHostPort = new GitHubPrAdapter({ cwd: cloneDir });

      openedPr = await adapter.openPr({
        title: `[ap-vp6-014-smoke] ${branch}`,
        body: 'Automated GitHostPort contract smoke. Safe to ignore.',
        head: branch,
        base,
      });
      assert.equal(typeof openedPr.number, 'number');
      assert.match(openedPr.url, /\/pull\/\d+$/);

      await adapter.commentOnPr(
        openedPr,
        'ap-vp6-014 contract smoke comment',
      );

      await adapter.mergePr(openedPr, { method: 'squash' });
    } finally {
      await cleanup();
    }
  });
}
