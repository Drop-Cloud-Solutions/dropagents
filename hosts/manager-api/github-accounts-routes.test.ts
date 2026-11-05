/**
 * Manager-api routes for the GitHub account registry.
 *
 * Operator request: a second GitHub account, both usable at once, for
 * repositories the first cannot reach — managed through the manager UI
 * rather than by hand-editing YAML.
 *
 * Two properties are structural rather than cosmetic:
 *
 *  1. **The write lands in the PROFILE, never in the tracked repo.** A
 *     `gh_config_dir` is a machine-specific path; writing it into
 *     `config/pipeline.yaml` is exactly what made manager-UI saves
 *     collide with `git pull`. The route delegates to `putPipeline`,
 *     whose profile-layer behaviour this file pins again from the
 *     account angle — a later refactor that bypassed it would be silent.
 *  2. **Test goes through the same door the pipeline will.** `gh` with
 *     `GH_CONFIG_DIR` in the CHILD env, not `gh auth switch`. Switching
 *     mutates global state and this pipeline runs tasks concurrently, so
 *     two accounts would race; a Test that authenticated some other way
 *     could pass while the real thing failed.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as yaml from 'js-yaml';

import {
    getGithubAccounts,
    putGithubAccounts,
    testGithubAccount,
    type GitHubAccountTestResult,
    type GitHubAccountsBody,
} from './github-accounts-routes';

const REAL_REPO = path.resolve(__dirname, '..', '..');

interface Fx {
    readonly repo: string;
    readonly configDir: string;
    readonly home: string;
    readonly ghDir: string;
    snapshot(): Map<string, string>;
    cleanup(): void;
}

function fixture(): Fx {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gha-repo-'));
    const configDir = path.join(repo, 'config');
    fs.mkdirSync(path.join(configDir, 'flows'), { recursive: true });
    fs.copyFileSync(
        path.join(REAL_REPO, 'config', 'pipeline.yaml'),
        path.join(configDir, 'pipeline.yaml'),
    );
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gha-home-'));
    // A real directory to stand in for one the operator ran
    // `gh auth login` into.
    const ghDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gha-ghdir-'));

    const snapshot = (): Map<string, string> => {
        const out = new Map<string, string>();
        const walk = (dir: string): void => {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                const p = path.join(dir, e.name);
                if (e.isDirectory()) walk(p);
                else {
                    out.set(
                        path.relative(repo, p),
                        crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'),
                    );
                }
            }
        };
        walk(repo);
        return out;
    };
    return {
        repo,
        configDir,
        home,
        ghDir,
        snapshot,
        cleanup: (): void => {
            for (const d of [repo, home, ghDir]) {
                fs.rmSync(d, { recursive: true, force: true });
            }
        },
    };
}

function opts(fx: Fx): { configDir: string; profileHome: string; lockPath: string } {
    return {
        configDir: fx.configDir,
        profileHome: fx.home,
        lockPath: path.join(os.tmpdir(), `gha-lock-${path.basename(fx.home)}`),
    };
}

function body(fx: Fx, accounts: unknown): string {
    return JSON.stringify({ accounts });
}

function oneAccount(fx: Fx, over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        id: 'sidekick',
        ghConfigDir: fx.ghDir,
        commitName: 'Sidekick Bot',
        commitEmail: 'bot@example.com',
        ...over,
    };
}

function read(fx: Fx): GitHubAccountsBody {
    const res = getGithubAccounts(opts(fx));
    assert.equal(res.status, 200);
    return res.body as GitHubAccountsBody;
}

/** The profile's pipeline.yaml override, or null when there is none. */
function profileDoc(fx: Fx): Record<string, unknown> | null {
    const file = path.join(fx.home, 'pipeline.yaml');
    if (!fs.existsSync(file)) return null;
    return yaml.load(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
}

// --- reads ------------------------------------------------------------

test('a pipeline with no accounts reads as an empty list', () => {
    const fx = fixture();
    try {
        assert.deepEqual(read(fx).accounts, []);
        assert.deepEqual(read(fx).problems, []);
    } finally {
        fx.cleanup();
    }
});

test('a saved account reads back, with its config dir checked on disk', async () => {
    const fx = fixture();
    try {
        const saved = await putGithubAccounts(opts(fx), body(fx, [oneAccount(fx)]));
        assert.equal(saved.status, 200);

        const [account] = read(fx).accounts;
        assert.equal(account?.id, 'sidekick');
        assert.equal(account?.commitEmail, 'bot@example.com');
        assert.equal(account?.configDirExists, true, 'the fixture dir exists');
    } finally {
        fx.cleanup();
    }
});

test('a config dir that does not exist is reported as missing, not hidden', async () => {
    // False here is a certain problem; the operator sees it without
    // having to run the Test.
    const fx = fixture();
    try {
        await putGithubAccounts(
            opts(fx),
            body(fx, [oneAccount(fx, { ghConfigDir: path.join(fx.repo, 'nope') })]),
        );
        assert.equal(read(fx).accounts[0]?.configDirExists, false);
    } finally {
        fx.cleanup();
    }
});

// --- the write must not touch the repo --------------------------------

test('saving accounts leaves the REPO byte-identical', async () => {
    // The rule this exists to keep: the running app never writes a
    // tracked file. A gh_config_dir is a machine path and belongs in the
    // profile.
    const fx = fixture();
    try {
        const before = fx.snapshot();
        const res = await putGithubAccounts(opts(fx), body(fx, [oneAccount(fx)]));
        assert.equal(res.status, 200);

        assert.deepEqual(fx.snapshot(), before, 'no repo file changed');
        assert.ok(profileDoc(fx), 'the profile got the override instead');
    } finally {
        fx.cleanup();
    }
});

test('only the accounts block lands in the profile override', async () => {
    // writeProfilePipeline diffs against the repo default, so keys the
    // operator never changed keep following upstream.
    const fx = fixture();
    try {
        await putGithubAccounts(opts(fx), body(fx, [oneAccount(fx)]));

        const doc = profileDoc(fx)!;
        assert.deepEqual(Object.keys(doc), ['github_accounts']);
        const block = doc.github_accounts as Record<string, Record<string, string>>;
        assert.equal(block.sidekick?.gh_config_dir, fx.ghDir);
        assert.equal(block.sidekick?.commit_name, 'Sidekick Bot');
    } finally {
        fx.cleanup();
    }
});

test('removing the last account resets the override rather than writing an empty block', async () => {
    const fx = fixture();
    try {
        await putGithubAccounts(opts(fx), body(fx, [oneAccount(fx)]));
        assert.ok(profileDoc(fx));

        const res = await putGithubAccounts(opts(fx), body(fx, []));
        assert.equal(res.status, 200);
        assert.equal(profileDoc(fx), null, 'the profile file is gone, not `{}`');
        assert.deepEqual(read(fx).accounts, []);
    } finally {
        fx.cleanup();
    }
});

test('two accounts both persist', async () => {
    const fx = fixture();
    try {
        await putGithubAccounts(opts(fx), body(fx, [
            oneAccount(fx, { id: 'dropcs', commitEmail: 'a@b.c' }),
            oneAccount(fx, { id: 'sidekick' }),
        ]));
        assert.deepEqual(read(fx).accounts.map((a) => a.id), ['dropcs', 'sidekick']);
    } finally {
        fx.cleanup();
    }
});

test('dry_run validates and writes nothing', async () => {
    const fx = fixture();
    try {
        const res = await putGithubAccounts(opts(fx), body(fx, [oneAccount(fx)]), true);
        assert.equal(res.status, 200);
        assert.equal(profileDoc(fx), null);
    } finally {
        fx.cleanup();
    }
});

// --- refusals ---------------------------------------------------------

test('a non-JSON body is refused', async () => {
    const fx = fixture();
    try {
        assert.equal((await putGithubAccounts(opts(fx), 'not json')).status, 400);
        assert.equal((await putGithubAccounts(opts(fx), '{"nope":1}')).status, 400);
    } finally {
        fx.cleanup();
    }
});

test('a missing field is refused and names the field', async () => {
    const fx = fixture();
    try {
        const res = await putGithubAccounts(opts(fx), body(fx, [
            { id: 'x', ghConfigDir: fx.ghDir },
        ]));
        assert.equal(res.status, 422);
        assert.match(String((res.body as { error: string }).error), /commit_name/);
        assert.equal(profileDoc(fx), null, 'nothing written');
    } finally {
        fx.cleanup();
    }
});

test('a duplicate id is refused rather than silently collapsing', async () => {
    // Two entries with one id become ONE key when written as a YAML
    // mapping, so one of the operator's accounts would simply vanish.
    const fx = fixture();
    try {
        const res = await putGithubAccounts(opts(fx), body(fx, [
            oneAccount(fx, { id: 'same' }),
            oneAccount(fx, { id: 'same', commitEmail: 'other@x.y' }),
        ]));
        assert.equal(res.status, 422);
        assert.match(String((res.body as { error: string }).error), /duplicate account id "same"/);
    } finally {
        fx.cleanup();
    }
});

test('an unusable id is refused by the SHARED parser, not a second rule', async () => {
    // The route and the orchestrator must agree on what is acceptable;
    // re-validating through parseGitHubAccounts is how they stay agreed.
    const fx = fixture();
    try {
        const res = await putGithubAccounts(opts(fx), body(fx, [
            oneAccount(fx, { id: '../escape' }),
        ]));
        assert.equal(res.status, 422);
        assert.match(String((res.body as { error: string }).error), /not a usable account id/);
    } finally {
        fx.cleanup();
    }
});

// --- the Test route ---------------------------------------------------

test('Test runs gh with GH_CONFIG_DIR and reports the login', async () => {
    const fx = fixture();
    try {
        await putGithubAccounts(opts(fx), body(fx, [oneAccount(fx)]));
        const calls: Array<{ args: readonly string[]; env: Record<string, string> }> = [];

        const res = await testGithubAccount(opts(fx), {
            exec: async (args, env) => {
                calls.push({ args, env: { ...env } });
                return { stdout: 'sidekick-bot\n', stderr: '', code: 0 };
            },
        }, 'sidekick');

        const result = res.body as GitHubAccountTestResult;
        assert.equal(result.ok, true);
        assert.equal(result.login, 'sidekick-bot');
        // The whole point: the identity travels in the CHILD env.
        assert.equal(calls[0]?.env.GH_CONFIG_DIR, fx.ghDir);
        assert.deepEqual(calls[0]?.args, ['api', 'user', '--jq', '.login']);
    } finally {
        fx.cleanup();
    }
});

test('Test never shells out to `gh auth switch`', async () => {
    // Switching is global mutable state; concurrent tasks on two
    // accounts would race and the last switch would win for both.
    const fx = fixture();
    try {
        await putGithubAccounts(opts(fx), body(fx, [oneAccount(fx)]));
        const seen: string[][] = [];
        await testGithubAccount(opts(fx), {
            exec: async (args) => {
                seen.push([...args]);
                return { stdout: 'x', stderr: '', code: 0 };
            },
        }, 'sidekick');

        for (const args of seen) {
            assert.ok(!args.includes('switch'), args.join(' '));
            assert.ok(!args.includes('login'), args.join(' '));
        }
    } finally {
        fx.cleanup();
    }
});

test('a failing gh reports WHY, and suggests the likely cause', async () => {
    // A directory that exists because someone created it but was never
    // logged into is the common case, and the message should say so.
    const fx = fixture();
    try {
        await putGithubAccounts(opts(fx), body(fx, [oneAccount(fx)]));
        const res = await testGithubAccount(opts(fx), {
            exec: async () => ({ stdout: '', stderr: 'gh: not logged in', code: 1 }),
        }, 'sidekick');

        const result = res.body as GitHubAccountTestResult;
        assert.equal(result.ok, false);
        assert.match(result.error ?? '', /not logged in/);
        assert.match(result.error ?? '', /gh auth login/);
        assert.match(result.error ?? '', /GH_CONFIG_DIR/);
    } finally {
        fx.cleanup();
    }
});

test('a missing config dir is caught WITHOUT running gh', async () => {
    // Cheap check first: no point paying a network round trip to learn
    // the directory is not there.
    const fx = fixture();
    try {
        await putGithubAccounts(
            opts(fx),
            body(fx, [oneAccount(fx, { ghConfigDir: path.join(fx.repo, 'nope') })]),
        );
        let ran = false;
        const res = await testGithubAccount(opts(fx), {
            exec: async () => { ran = true; return { stdout: '', stderr: '', code: 0 }; },
        }, 'sidekick');

        assert.equal(ran, false, 'gh was not invoked');
        const result = res.body as GitHubAccountTestResult;
        assert.equal(result.ok, false);
        assert.match(result.error ?? '', /does not exist/);
    } finally {
        fx.cleanup();
    }
});

test('a thrown exec is reported, not propagated', async () => {
    // `gh` missing from PATH throws; the panel must show it rather than
    // the route 500ing.
    const fx = fixture();
    try {
        await putGithubAccounts(opts(fx), body(fx, [oneAccount(fx)]));
        const res = await testGithubAccount(opts(fx), {
            exec: async () => { throw new Error('`gh` not found on PATH'); },
        }, 'sidekick');

        assert.equal(res.status, 200);
        const result = res.body as GitHubAccountTestResult;
        assert.equal(result.ok, false);
        assert.match(result.error ?? '', /not found on PATH/);
    } finally {
        fx.cleanup();
    }
});

test('testing an unknown account is a 404', async () => {
    const fx = fixture();
    try {
        const res = await testGithubAccount(opts(fx), {
            exec: async () => ({ stdout: '', stderr: '', code: 0 }),
        }, 'nope');
        assert.equal(res.status, 404);
    } finally {
        fx.cleanup();
    }
});

