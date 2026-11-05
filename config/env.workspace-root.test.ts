/**
 * The workspace-root fallback must be platform-shaped.
 *
 * Three hosts each used to inline `C:\Drop-AI\Source` as their default.
 * On a non-Windows box that is not an error — it is a legal relative
 * directory name, so the worker would happily mkdir a folder literally
 * called `C:\Drop-AI\Source` inside its cwd and clone every repo into
 * it. The bug only shows up much later, as agents editing files that
 * are not where anyone thinks they are.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';

import { defaultWorkspaceRoot, getWorkspaceRoot } from './env';

const home = (): string => '/Users/op';

test('Windows keeps the deployed layout verbatim', () => {
    // The live worker is already laid out under this path — changing it
    // would strand every clone and worktree it owns.
    assert.equal(defaultWorkspaceRoot('win32', home), 'C:\\Drop-AI\\Source');
});

test('POSIX platforms get a home-rooted path, not a drive letter', () => {
    for (const platform of ['darwin', 'linux'] as const) {
        const root = defaultWorkspaceRoot(platform, home);
        assert.equal(root, path.join('/Users/op', 'Drop-AI', 'Source'));
        assert.ok(!root.includes('C:'), `${platform} must not inherit a drive letter`);
    }
});

test('the POSIX default sits outside the conventional checkout tree', () => {
    // The whole point of the root: walking UP from a worktree must not
    // pass through anything the operator owns. `~/source/repos` is the
    // tree we are protecting, so the default must not be under it.
    const root = defaultWorkspaceRoot('darwin', home);
    assert.ok(!root.startsWith(path.join('/Users/op', 'source')));
    assert.ok(!root.startsWith(path.join('/Users/op', 'Documents')));
});

test('PIPELINE_WORKSPACE_ROOT wins, trimmed', () => {
    const prev = process.env.PIPELINE_WORKSPACE_ROOT;
    try {
        process.env.PIPELINE_WORKSPACE_ROOT = '  /srv/pipeline  ';
        assert.equal(getWorkspaceRoot(), '/srv/pipeline');
    } finally {
        if (prev === undefined) delete process.env.PIPELINE_WORKSPACE_ROOT;
        else process.env.PIPELINE_WORKSPACE_ROOT = prev;
    }
});

test('a blank override falls back rather than yielding an empty root', () => {
    // An empty root would resolve every path against the process cwd —
    // silently placing worktrees inside whatever directory the service
    // happened to start in.
    const prev = process.env.PIPELINE_WORKSPACE_ROOT;
    try {
        process.env.PIPELINE_WORKSPACE_ROOT = '   ';
        assert.equal(getWorkspaceRoot(), defaultWorkspaceRoot());
    } finally {
        if (prev === undefined) delete process.env.PIPELINE_WORKSPACE_ROOT;
        else process.env.PIPELINE_WORKSPACE_ROOT = prev;
    }
});
