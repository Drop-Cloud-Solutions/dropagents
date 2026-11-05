/**
 * The guard that decides whether an unauthenticated control plane may
 * listen on a network address.
 *
 * Written while preparing this repo for a public release. The boards
 * already warned on a non-loopback bind and the defaults were already
 * loopback — but they run as Windows services, where a `console.warn`
 * reaches nobody. These pin the two halves that matter: a safe default
 * cannot be lost to a config copy-paste, and an operator who opts in
 * deliberately still gets told what they took on.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import {
    LOOPBACK_HOSTS,
    decideRemoteBind,
    isFlagEnabled,
    isLoopbackHost,
} from './bind-guard';

const EXPOSES = 'its proxy adds your worker-api token to every forwarded request.';

const decide = (host: string, flag?: string) =>
    decideRemoteBind({
        service: 'board-ui',
        host,
        allowFlagName: 'BOARD_UI_ALLOW_REMOTE',
        allowFlagValue: flag,
        exposes: EXPOSES,
    });

test('every loopback spelling binds silently', () => {
    for (const host of LOOPBACK_HOSTS) {
        const d = decide(host);
        assert.equal(d.allowed, true, `${host} must be allowed`);
        assert.equal(d.message, '', `${host} must not warn`);
    }
    // The default path, and the overwhelmingly common one: no flag, no
    // noise, no refusal.
    assert.deepEqual(decide('127.0.0.1'), { allowed: true, message: '' });
});

test('host matching ignores case and surrounding whitespace', () => {
    assert.ok(isLoopbackHost('LOCALHOST'));
    assert.ok(isLoopbackHost('  127.0.0.1  '));
    assert.ok(isLoopbackHost('::1'));
});

test('a non-loopback bind without the flag is REFUSED', () => {
    for (const host of ['0.0.0.0', '192.0.2.10', '192.168.1.10', '::']) {
        const d = decide(host);
        assert.equal(d.allowed, false, `${host} must be refused`);
        assert.match(d.message, /REFUSING to bind/);
    }
});

test('the refusal names the host, the flag, the risk, and a safe way out', () => {
    // A refusal that does not say how to proceed just gets worked around
    // with the first thing that silences it.
    const { message } = decide('0.0.0.0');
    assert.match(message, /"0\.0\.0\.0"/, 'names the offending host');
    assert.match(message, /BOARD_UI_ALLOW_REMOTE=1/, 'names the opt-in');
    assert.match(message, /dangerously-skip-permissions/, 'names the real stake');
    assert.match(message, /SSH tunnel/, 'offers the safe alternative');
    assert.ok(message.includes(EXPOSES), 'names what this port grants');
});

test('the flag allows the bind but does NOT silence it', () => {
    // Opting in knowingly is not a reason to go quiet: the warning is
    // what a later reader of the logs needs.
    // 192.0.2.0/24 is RFC 5737 TEST-NET-1, a documentation range, so this
    // test cannot quietly become a record of real infrastructure.
    const d = decide('192.0.2.10', '1');
    assert.equal(d.allowed, true);
    assert.match(d.message, /UNAUTHENTICATED/);
    assert.match(d.message, /192\.0\.2\.10/);
    assert.match(d.message, /Tailscale|VPN|reverse proxy/);
    assert.doesNotMatch(d.message, /REFUSING/);
});

test('the flag is only honoured on an affirmative value', () => {
    for (const yes of ['1', 'true', 'TRUE', 'yes', 'on', ' on ']) {
        assert.equal(isFlagEnabled(yes), true, `${yes} should enable`);
        assert.equal(decide('0.0.0.0', yes).allowed, true);
    }
    // `0`/`false`/empty must not enable it — a half-set flag is a
    // likelier mistake than a deliberate exposure.
    for (const no of [undefined, '', '  ', '0', 'false', 'no', 'off', 'maybe']) {
        assert.equal(isFlagEnabled(no), false, `${no} should NOT enable`);
        assert.equal(decide('0.0.0.0', no).allowed, false);
    }
});

test('the flag cannot expose a loopback bind by accident either way', () => {
    // Setting the flag on a loopback host is a no-op, not a warning:
    // nothing is exposed, so there is nothing to say.
    assert.deepEqual(decide('127.0.0.1', '1'), { allowed: true, message: '' });
});
