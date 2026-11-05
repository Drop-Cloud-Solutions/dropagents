/**
 * Which executable runs a given script, per platform.
 *
 * Split from `ScriptRunner.test.ts` deliberately: that suite spawns real
 * `cmd.exe` fixtures and skips off Windows, so it can never cover the
 * non-Windows branches. This one is a pure table check and runs
 * everywhere, both directions.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveSpawn } from './ScriptRunner';

test('.ps1 runs under powershell.exe on Windows, pwsh elsewhere', () => {
    // PowerShell 7+ is the only edition off Windows and its binary is
    // `pwsh`; `powershell.exe` does not exist there. The workspace repos
    // ship Deploy/*.ps1, so this branch is load-bearing for deploys.
    const win = resolveSpawn('Deploy/deploy_api.ps1', ['-environment', 'stg'], 'win32');
    assert.equal(win.command, 'powershell.exe');

    for (const platform of ['darwin', 'linux'] as const) {
        const out = resolveSpawn('Deploy/deploy_api.ps1', ['-environment', 'stg'], platform);
        assert.equal(out.command, 'pwsh');
        // Same flags either way — including -ExecutionPolicy Bypass, which
        // pwsh accepts and ignores on platforms that have no policy store.
        assert.deepEqual(out.args, [
            '-NoProfile',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            'Deploy/deploy_api.ps1',
            '-environment',
            'stg',
        ]);
    }
});

test('.PS1 is matched case-insensitively', () => {
    assert.equal(resolveSpawn('Deploy/DEPLOY.PS1', [], 'darwin').command, 'pwsh');
});

test('.cmd/.bat is refused off Windows with a message naming the cause', () => {
    // The old code fell through to spawn(scriptPath), which surfaced as a
    // bare ENOENT/EACCES — indistinguishable from a missing file, and it
    // sends whoever debugs it looking in the wrong place.
    for (const ext of ['.cmd', '.bat']) {
        assert.throws(
            () => resolveSpawn(`fixtures/build${ext}`, [], 'linux'),
            (err: Error) => {
                assert.match(err.message, /require Windows/);
                assert.match(err.message, new RegExp(`build\\${ext}`));
                assert.match(err.message, /linux/);
                return true;
            },
        );
    }
});

test('.cmd still routes through cmd.exe on Windows', () => {
    const out = resolveSpawn('fixtures/build.cmd', ['x'], 'win32');
    assert.equal(out.command, 'cmd.exe');
    assert.deepEqual(out.args, ['/d', '/s', '/c', 'fixtures/build.cmd', 'x']);
});

test('anything else is handed to the OS unchanged, on every platform', () => {
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
        const out = resolveSpawn('scripts/build.sh', ['--fast'], platform);
        assert.equal(out.command, 'scripts/build.sh');
        assert.deepEqual(out.args, ['--fast']);
    }
});

test('the returned args are a copy — a caller cannot mutate the input', () => {
    const args = ['--fast'];
    const out = resolveSpawn('scripts/build.sh', args, 'darwin');
    assert.notEqual(out.args, args);
});
