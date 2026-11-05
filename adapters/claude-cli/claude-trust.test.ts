import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { ensureClaudeWorkspaceTrust } from './claude-trust';

function tmpCfg(contents?: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-trust-'));
    const p = path.join(dir, '.claude.json');
    if (contents !== undefined) fs.writeFileSync(p, contents, 'utf8');
    return p;
}

function read(p: string): { projects?: Record<string, { hasTrustDialogAccepted?: boolean }> } {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
}

test('sets hasTrustDialogAccepted for the clone (both slash forms) and preserves other state', async () => {
    const cfg = tmpCfg(JSON.stringify({
        projects: {
            'C:/Drop-AI/Source/repos/infrastructure': { history: ['x'] },
        },
        someGlobal: 42,
    }));
    await ensureClaudeWorkspaceTrust(['C:\\Drop-AI\\Source\\repos\\infrastructure'], undefined, cfg);
    const out = read(cfg);
    assert.equal((out as { someGlobal?: number }).someGlobal, 42);
    // Backslash form recorded:
    assert.equal(out.projects!['C:\\Drop-AI\\Source\\repos\\infrastructure'].hasTrustDialogAccepted, true);
    // Forward-slash form recorded + pre-existing field preserved:
    const fwd = out.projects!['C:/Drop-AI/Source/repos/infrastructure'];
    assert.equal(fwd.hasTrustDialogAccepted, true);
    assert.deepEqual((fwd as { history?: string[] }).history, ['x']);
});

test('creates a project entry when none exists', async () => {
    const cfg = tmpCfg(JSON.stringify({ projects: {} }));
    await ensureClaudeWorkspaceTrust(['C:/Drop-AI/Source/repos/corelib'], undefined, cfg);
    assert.equal(read(cfg).projects!['C:/Drop-AI/Source/repos/corelib'].hasTrustDialogAccepted, true);
});

test('is idempotent — already-trusted config is left valid', async () => {
    const cfg = tmpCfg(JSON.stringify({
        projects: { 'C:/r': { hasTrustDialogAccepted: true } },
    }));
    await ensureClaudeWorkspaceTrust(['C:/r'], undefined, cfg);
    assert.equal(read(cfg).projects!['C:/r'].hasTrustDialogAccepted, true);
});

test('missing config is a no-op (does not create the file)', async () => {
    const cfg = tmpCfg(); // not written
    await ensureClaudeWorkspaceTrust(['C:/r'], undefined, cfg);
    assert.equal(fs.existsSync(cfg), false);
});

test('unparseable config is left untouched', async () => {
    const cfg = tmpCfg('{ not json');
    await ensureClaudeWorkspaceTrust(['C:/r'], undefined, cfg);
    assert.equal(fs.readFileSync(cfg, 'utf8'), '{ not json');
});

test('empty clone list is a no-op', async () => {
    const cfg = tmpCfg(JSON.stringify({ projects: {} }));
    await ensureClaudeWorkspaceTrust([], undefined, cfg);
    assert.deepEqual(read(cfg).projects, {});
});
