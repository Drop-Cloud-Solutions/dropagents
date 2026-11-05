/**
 * Agent-auth health — classifier + proactive status.
 *
 *   1. classifyAuthFailure matches the known auth signatures and returns
 *      a stable label; ordinary failures (incl. text merely containing
 *      "unauthorized" prose) do NOT trip it.
 *   2. readAgentAuthStatus: env override → ok; credentials expiry maps to
 *      ok / expiring-soon / expired; missing or unparseable file →
 *      unknown. Token material never appears in the result.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { classifyAuthFailure, readAgentAuthStatus } from './auth-status';

test('classifyAuthFailure matches the known auth signatures', () => {
    assert.equal(classifyAuthFailure('Error: Invalid API key · Fix external API key'), 'invalid API key');
    assert.equal(classifyAuthFailure('OAuth token has expired. Please obtain a new token'), 'OAuth token expired');
    assert.equal(classifyAuthFailure('token has expired · please run /login'), 'OAuth token expired');
    assert.equal(classifyAuthFailure('Please run /login to authenticate'), 'CLI not logged in');
    assert.equal(classifyAuthFailure('{"type":"error","error":{"type":"authentication_error"}}'), 'authentication error');
    assert.equal(classifyAuthFailure('HTTP 401 Unauthorized from api.anthropic.com'), 'HTTP 401 unauthorized');
});

test('classifyAuthFailure stays quiet on ordinary failures', () => {
    assert.equal(classifyAuthFailure('TypeError: cannot read properties of undefined'), null);
    assert.equal(classifyAuthFailure('tests failed: expected 200 got 500'), null);
    // Prose containing "unauthorized" without a 401 must not trip a
    // worker-wide auth alarm.
    assert.equal(classifyAuthFailure('the endpoint returns unauthorized for guests by design'), null);
    assert.equal(classifyAuthFailure(''), null);
    assert.equal(classifyAuthFailure(undefined), null);
});

function writeCreds(expiresAt: number | undefined): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-status-'));
    const p = path.join(dir, '.credentials.json');
    fs.writeFileSync(
        p,
        JSON.stringify({
            claudeAiOauth: {
                accessToken: 'sk-test-NEVER-ECHO',
                ...(expiresAt !== undefined ? { expiresAt } : {}),
            },
        }),
        'utf8',
    );
    return p;
}

const NOW = 1_800_000_000_000;

test('env override reports ok regardless of the credentials file', () => {
    const credPath = writeCreds(NOW - 1000); // expired on disk
    try {
        const s = readAgentAuthStatus({
            credentialsPath: credPath,
            env: { CLAUDE_CODE_OAUTH_TOKEN: 'tok' } as NodeJS.ProcessEnv,
            now: () => NOW,
        });
        assert.equal(s.status, 'ok');
        assert.equal(s.source, 'env-override');
    } finally {
        fs.rmSync(path.dirname(credPath), { recursive: true, force: true });
    }
});

test('expired credentials → expired, with a human delta and no token material', () => {
    const credPath = writeCreds(NOW - 2 * 3_600_000);
    try {
        const s = readAgentAuthStatus({
            credentialsPath: credPath,
            env: {} as NodeJS.ProcessEnv,
            now: () => NOW,
        });
        assert.equal(s.status, 'expired');
        assert.equal(s.source, 'oauth-credentials');
        assert.ok(s.detail.includes('expired'));
        assert.ok(!JSON.stringify(s).includes('sk-test'), 'token material must never leak');
    } finally {
        fs.rmSync(path.dirname(credPath), { recursive: true, force: true });
    }
});

test('near-expiry credentials → expiring-soon; far expiry → ok', () => {
    const soonPath = writeCreds(NOW + 3_600_000); // 1h
    const farPath = writeCreds(NOW + 30 * 86_400_000); // 30d
    try {
        assert.equal(
            readAgentAuthStatus({ credentialsPath: soonPath, env: {} as NodeJS.ProcessEnv, now: () => NOW }).status,
            'expiring-soon',
        );
        assert.equal(
            readAgentAuthStatus({ credentialsPath: farPath, env: {} as NodeJS.ProcessEnv, now: () => NOW }).status,
            'ok',
        );
    } finally {
        fs.rmSync(path.dirname(soonPath), { recursive: true, force: true });
        fs.rmSync(path.dirname(farPath), { recursive: true, force: true });
    }
});

test('missing file → unknown/none; file without expiry → unknown/oauth', () => {
    const missing = readAgentAuthStatus({
        credentialsPath: path.join(os.tmpdir(), 'does-not-exist', '.credentials.json'),
        env: {} as NodeJS.ProcessEnv,
        now: () => NOW,
    });
    assert.equal(missing.status, 'unknown');
    assert.equal(missing.source, 'none');

    const noExpiry = writeCreds(undefined);
    try {
        const s = readAgentAuthStatus({
            credentialsPath: noExpiry,
            env: {} as NodeJS.ProcessEnv,
            now: () => NOW,
        });
        assert.equal(s.status, 'unknown');
        assert.equal(s.source, 'oauth-credentials');
    } finally {
        fs.rmSync(path.dirname(noExpiry), { recursive: true, force: true });
    }
});
