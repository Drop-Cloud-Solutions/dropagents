import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { commitDesignDoc, type ExecResult } from './design-doc-committer';

interface Recorded {
    cmd: string;
    args: string[];
    env?: Readonly<Record<string, string>> | undefined;
}

function harness(opts: { changes: boolean; failOn?: string }) {
    const calls: Recorded[] = [];
    const writes: Array<{ file: string; data: string }> = [];
    const exec = async (
        cmd: string,
        args: readonly string[],
        options: { readonly cwd: string; readonly env?: Readonly<Record<string, string>> },
    ): Promise<ExecResult> => {
        calls.push({ cmd, args: [...args], env: options.env });
        if (opts.failOn && args.includes(opts.failOn)) {
            throw new Error(`boom on ${opts.failOn}`);
        }
        // `git diff --cached --quiet` throws (exit 1) when there ARE changes.
        if (args[0] === 'diff' && args.includes('--quiet')) {
            if (opts.changes) throw new Error('exit 1');
            return { stdout: '', stderr: '' };
        }
        return { stdout: '', stderr: '' };
    };
    const deps = {
        exec,
        mkdir: async (): Promise<void> => undefined,
        writeFile: async (file: string, data: string): Promise<void> => {
            writes.push({ file, data });
        },
        env: { GIT_COMMIT_NAME: 'Bot', GIT_COMMIT_EMAIL: 'bot@x.io' } as NodeJS.ProcessEnv,
    };
    return { calls, writes, deps };
}

test('writes design.md + rollout.md and commits + pushes when there are changes', async () => {
    const { calls, writes, deps } = harness({ changes: true });
    const ok = await commitDesignDoc(
        { repoPath: '/repo', requirementId: 'REQ-1', designDoc: '# Design', rollout: 'deploy A first', defaultBranch: 'main' },
        deps,
    );
    assert.equal(ok, true);
    assert.ok(writes.some((w) => w.file.endsWith('design.md') && w.data === '# Design'));
    assert.ok(writes.some((w) => w.file.endsWith('rollout.md')));
    const flat = calls.map((c) => `${c.cmd} ${c.args.join(' ')}`);
    assert.ok(flat.some((c) => c.startsWith('git add -- requirements/REQ-1')));
    assert.ok(flat.some((c) => c.includes('commit -m architecture: design for REQ-1')));
    assert.ok(flat.some((c) => c.includes('push origin HEAD:main')));
});

test('no-op (no commit) when nothing is staged', async () => {
    const { calls, deps } = harness({ changes: false });
    const ok = await commitDesignDoc(
        { repoPath: '/repo', requirementId: 'REQ-2', designDoc: 'x', defaultBranch: 'main' },
        deps,
    );
    assert.equal(ok, false);
    assert.ok(!calls.some((c) => c.args[0] === 'commit'));
    assert.ok(!calls.some((c) => c.args[0] === 'push'));
});

test('is best-effort — a git failure returns false without throwing', async () => {
    const { deps } = harness({ changes: true, failOn: 'push' });
    const ok = await commitDesignDoc(
        { repoPath: '/repo', requirementId: 'REQ-3', designDoc: 'x', defaultBranch: 'main' },
        deps,
    );
    assert.equal(ok, false);
});

test('omits rollout.md when no rollout content is given', async () => {
    const { writes, deps } = harness({ changes: true });
    await commitDesignDoc(
        { repoPath: '/repo', requirementId: 'REQ-4', designDoc: 'x', defaultBranch: 'main' },
        deps,
    );
    assert.ok(!writes.some((w) => w.file.endsWith('rollout.md')));
});

// --- the GitHub account -----------------------------------------------
//
// The architecture repo need not live on the machine's ambient GitHub
// account. Because this whole path is best-effort, a credential failure
// is a log line nobody reads and the design doc silently never lands —
// so the push has to carry the account the repo is mapped to.

test('the push carries the architecture repo\'s GitHub account', async () => {
    const { calls, deps } = harness({ changes: true });
    await commitDesignDoc(
        {
            repoPath: '/repo',
            requirementId: 'REQ-9',
            designDoc: 'x',
            defaultBranch: 'main',
            githubEnv: { GH_CONFIG_DIR: 'C:/gh/work' },
        },
        deps,
    );
    const push = calls.find((c) => c.args[0] === 'push');
    assert.ok(push, 'the push must happen');
    assert.deepEqual(push.env, { GH_CONFIG_DIR: 'C:/gh/work' });
});

test('the LOCAL git calls stay on the ambient environment', async () => {
    // add / diff / config / commit never reach the network. Running them
    // under another account's gh config dir would buy nothing, and
    // `git config --local` in particular must keep editing this clone.
    const { calls, deps } = harness({ changes: true });
    await commitDesignDoc(
        {
            repoPath: '/repo',
            requirementId: 'REQ-9',
            designDoc: 'x',
            defaultBranch: 'main',
            githubEnv: { GH_CONFIG_DIR: 'C:/gh/work' },
        },
        deps,
    );
    for (const call of calls.filter((c) => c.args[0] !== 'push')) {
        assert.equal(
            call.env,
            undefined,
            `${call.cmd} ${call.args.join(' ')} should run ambient`,
        );
    }
});

test('no account configured leaves the push ambient', async () => {
    // An unmapped repo must behave exactly as before accounts existed,
    // rather than being handed an empty-but-present environment.
    const { calls, deps } = harness({ changes: true });
    await commitDesignDoc(
        { repoPath: '/repo', requirementId: 'REQ-9', designDoc: 'x', defaultBranch: 'main' },
        deps,
    );
    assert.equal(calls.find((c) => c.args[0] === 'push')?.env, undefined);
});

test('an EMPTY overlay is treated as no account at all', async () => {
    // `githubEnvForRepoId` returns {} for an unmapped repo, and that has
    // to mean "ambient", not "spawn with an explicit empty env".
    const { calls, deps } = harness({ changes: true });
    await commitDesignDoc(
        {
            repoPath: '/repo',
            requirementId: 'REQ-9',
            designDoc: 'x',
            defaultBranch: 'main',
            githubEnv: {},
        },
        deps,
    );
    assert.equal(calls.find((c) => c.args[0] === 'push')?.env, undefined);
});
