/**
 * Env layering: shell > profile secrets.env > profile settings.env > repo .env.
 *
 * The repo `.env` stays supported because it is how every host finds a
 * profile that is not at the default location — a service running under a
 * system account resolves `~` to the SYSTEM profile, not the operator's.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { loadEnvLayers } from './loadDotenv';

function setup(): { repo: string; home: string; cleanup: () => void } {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'env-repo-'));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'env-home-'));
    return {
        repo,
        home,
        cleanup: (): void => {
            fs.rmSync(repo, { recursive: true, force: true });
            fs.rmSync(home, { recursive: true, force: true });
        },
    };
}

test('precedence: shell > secrets.env > settings.env > repo .env', () => {
    const s = setup();
    try {
        fs.writeFileSync(path.join(s.repo, '.env'), [
            `PIPELINE_HOME=${s.home}`,
            'A=repo', 'B=repo', 'C=repo', 'D=repo',
        ].join('\n'));
        fs.writeFileSync(path.join(s.home, 'settings.env'), 'B=settings\nC=settings\nD=settings\n');
        fs.writeFileSync(path.join(s.home, 'secrets.env'), 'C=secrets\nD=secrets\n');
        const env: NodeJS.ProcessEnv = { D: 'shell' };

        const r = loadEnvLayers({ env, repoEnvPath: path.join(s.repo, '.env'), repoRoot: s.repo });

        assert.equal(r.home, s.home);
        assert.equal(env.A, 'repo');
        assert.equal(env.B, 'settings');
        assert.equal(env.C, 'secrets');
        assert.equal(env.D, 'shell', 'the shell / service environment always wins');
        assert.equal(env.PIPELINE_HOME, s.home);
        assert.ok(!r.applied.includes('D'));
    } finally { s.cleanup(); }
});

test('the shell PIPELINE_HOME beats the repo .env one', () => {
    const s = setup();
    try {
        const other = fs.mkdtempSync(path.join(os.tmpdir(), 'env-other-'));
        fs.writeFileSync(path.join(s.repo, '.env'), `PIPELINE_HOME=${s.home}\n`);
        fs.writeFileSync(path.join(other, 'settings.env'), 'FROM=other\n');
        const env: NodeJS.ProcessEnv = { PIPELINE_HOME: other };
        const r = loadEnvLayers({ env, repoEnvPath: path.join(s.repo, '.env'), repoRoot: s.repo });
        assert.equal(r.home, other);
        assert.equal(env.FROM, 'other');
        fs.rmSync(other, { recursive: true, force: true });
    } finally { s.cleanup(); }
});

test('no PIPELINE_HOME anywhere falls back to ~/.dropagents', () => {
    const s = setup();
    try {
        const env: NodeJS.ProcessEnv = {};
        const r = loadEnvLayers({
            env,
            repoEnvPath: path.join(s.repo, '.env'),
            homedir: () => s.home,
            repoRoot: s.repo,
        });
        assert.equal(r.home, path.join(s.home, '.dropagents'));
    } finally { s.cleanup(); }
});

test('missing files are skipped — a fresh checkout boots with no setup', () => {
    const s = setup();
    try {
        const env: NodeJS.ProcessEnv = { PIPELINE_HOME: s.home };
        const r = loadEnvLayers({ env, repoEnvPath: path.join(s.repo, 'nope.env'), repoRoot: s.repo });
        assert.deepEqual(r.applied, []);
    } finally { s.cleanup(); }
});
