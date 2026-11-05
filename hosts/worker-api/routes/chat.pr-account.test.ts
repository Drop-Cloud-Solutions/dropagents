/**
 * Which of a scratch-edit chat's git/gh calls carry the repo's GitHub
 * account.
 *
 * Field report: an auto-merge failed with "Repository not found" on a
 * repo that plainly exists. GitHub deliberately does not leak the
 * existence of a repo an identity cannot see, so a WRONG CREDENTIAL and
 * a DELETED REPO produce the same message. The cause was a remote git
 * call running as the machine's ambient identity instead of the account
 * the repo is mapped to — and `Open PR` from a chat session had the same
 * two unthreaded calls: the branch push and `gh pr create`.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { commitDesignDoc } from '../../../adapters/architect/design-doc-committer';
import { commitAndOpenPr } from './chat';

interface Call {
    readonly cmd: string;
    readonly argv: readonly string[];
    readonly env: Readonly<Record<string, string>> | undefined;
}

/**
 * Records every spawn. `dirty` drives the branch between committing
 * pending work and PR-ing an already-committed branch (the operator can
 * ask Claude to commit inline during the chat).
 */
function harness(opts: { dirty?: boolean } = {}): {
    calls: Call[];
    run: (
        cmd: string,
        argv: readonly string[],
        cwd: string,
        env?: Readonly<Record<string, string>>,
    ) => Promise<string>;
} {
    const calls: Call[] = [];
    const run = async (
        cmd: string,
        argv: readonly string[],
        _cwd: string,
        env?: Readonly<Record<string, string>>,
    ): Promise<string> => {
        calls.push({ cmd, argv: [...argv], env });
        if (argv[0] === 'status') {
            return opts.dirty === false ? '' : ' M src/Program.cs\n';
        }
        if (cmd !== 'git') {
            return 'https://github.com/acme/shop/pull/42\n';
        }
        return '';
    };
    return { calls, run };
}

const BASE = {
    worktreePath: 'C:/ws/chat-worktrees/S-1',
    repoPath: 'C:/ws/repos/shop',
    branch: 'chat/S-1',
    title: 'Fix the thing',
    description: 'From a chat session.',
};

const ACCOUNT = { GH_CONFIG_DIR: 'C:/gh/work', GIT_AUTHOR_NAME: 'Work Bot' };

const find = (calls: Call[], cmd: string, head: string): Call | undefined =>
    calls.find((c) => c.cmd === cmd && c.argv[0] === head);

// --- the remote calls -------------------------------------------------

test('the branch push carries the account', async () => {
    const h = harness();
    await commitAndOpenPr({ ...BASE, githubEnv: ACCOUNT, run: h.run });

    const push = find(h.calls, 'git', 'push');
    assert.ok(push, 'the branch must be pushed');
    assert.deepEqual(push.env, ACCOUNT);
});

test('`gh pr create` carries the account', async () => {
    // Separate from the push on purpose: gh authenticates through
    // GH_CONFIG_DIR while git authenticates through the credential
    // helper, so threading one does nothing for the other.
    const h = harness();
    await commitAndOpenPr({ ...BASE, githubEnv: ACCOUNT, run: h.run });

    const create = h.calls.find((c) => c.argv[0] === 'pr' && c.argv[1] === 'create');
    assert.ok(create, 'the PR must be opened');
    assert.deepEqual(create.env, ACCOUNT);
});

// --- the local ones ---------------------------------------------------

test('the local git calls stay on the ambient environment', async () => {
    // status / add / commit never reach the network.
    const h = harness();
    await commitAndOpenPr({ ...BASE, githubEnv: ACCOUNT, run: h.run });

    const local = h.calls.filter((c) => c.cmd === 'git' && c.argv[0] !== 'push');
    assert.ok(local.length > 0, 'there are local calls to check');
    for (const call of local) {
        assert.equal(
            call.env,
            undefined,
            `git ${call.argv.join(' ')} should run ambient`,
        );
    }
});

test('the HEAD check on an already-committed branch stays ambient', async () => {
    // The other branch through the function: no pending changes, so it
    // verifies HEAD instead of committing. Still a local call.
    const h = harness({ dirty: false });
    await commitAndOpenPr({ ...BASE, githubEnv: ACCOUNT, run: h.run });

    const revParse = find(h.calls, 'git', 'rev-parse');
    assert.ok(revParse, 'an already-committed branch is verified, not committed');
    assert.equal(revParse.env, undefined);
    assert.equal(find(h.calls, 'git', 'commit'), undefined, 'no empty commit');
    assert.deepEqual(find(h.calls, 'git', 'push')?.env, ACCOUNT, 'still pushed as the account');
});

// --- degrading --------------------------------------------------------

test('no account configured leaves every call ambient', async () => {
    // An unmapped repo behaves exactly as before accounts existed.
    const h = harness();
    await commitAndOpenPr({ ...BASE, run: h.run });

    assert.ok(
        h.calls.every((c) => c.env === undefined),
        'an absent account must not change any spawn environment',
    );
});

test('the account is never silently swapped for another one', async () => {
    // `githubEnvForRepo` returns {} for an unmapped repo rather than
    // some other configured account: a push cannot be taken back.
    const h = harness();
    await commitAndOpenPr({ ...BASE, githubEnv: {}, run: h.run });

    assert.deepEqual(find(h.calls, 'git', 'push')?.env, {});
});

// --- the shared contract ----------------------------------------------

test('every remote-touching surface takes an account overlay', async () => {
    // The threading has been done one call site at a time and each gap
    // cost a field incident, so this asserts the surfaces together
    // rather than trusting each to be remembered.
    //
    // DeployWorktreeStore and TaskWorktreeStore are covered by their own
    // files; these two are the ones that had no coverage at all.
    const chat = harness();
    await commitAndOpenPr({ ...BASE, githubEnv: ACCOUNT, run: chat.run });
    assert.deepEqual(find(chat.calls, 'git', 'push')?.env, ACCOUNT, 'chat PR');

    const archCalls: Array<{ argv: readonly string[]; env?: Readonly<Record<string, string>> }> = [];
    await commitDesignDoc(
        {
            repoPath: 'C:/ws/repos/architecture',
            requirementId: 'REQ-1',
            designDoc: '# Design',
            defaultBranch: 'main',
            githubEnv: ACCOUNT,
        },
        {
            mkdir: async (): Promise<void> => undefined,
            writeFile: async (): Promise<void> => undefined,
            exec: async (_cmd, argv, options) => {
                archCalls.push({ argv, env: options.env });
                // `diff --cached --quiet` throws when there ARE changes.
                if (argv[0] === 'diff') throw new Error('exit 1');
                return { stdout: '', stderr: '' };
            },
        },
    );
    assert.deepEqual(
        archCalls.find((c) => c.argv[0] === 'push')?.env,
        ACCOUNT,
        'architecture design-doc push',
    );
});
