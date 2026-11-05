/**
 * Stack packs: loading, validation, and how they layer into personas and
 * flows. The failure class packs must not introduce is the silent drop —
 * an unknown or missing pack quietly removing task types whose tasks then
 * sit unstartable — so every "not found" here is an error that names what
 * does exist.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { parsePipelineConfig } from '../core/flow/pipeline-config';
import { PackError, listPacks, loadPack, resolvePacks } from './packs';
import {
    PROFILE_MARKER,
    activateProfile,
    activePacks,
    composePersona,
    defaultPersonaFile,
    flowLayerDirs,
    profileUpgradeProblem,
    resolvePersona,
} from './profile';

function tmp(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), `packs-${prefix}-`));
}

function write(file: string, content: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
}

function packFixture(): { packsDir: string; cleanup: () => void } {
    const packsDir = tmp('dir');
    write(path.join(packsDir, 'alpha', 'pack.yaml'), [
        'id: alpha',
        'label: Alpha stack',
        'archetypes:',
        '  - id: ship-it',
        '    label: Ship it',
        '',
    ].join('\n'));
    write(path.join(packsDir, 'beta', 'pack.yaml'), 'id: beta\n');
    fs.mkdirSync(path.join(packsDir, 'not-a-pack'));
    return { packsDir, cleanup: () => fs.rmSync(packsDir, { recursive: true, force: true }) };
}

// ---------------------------------------------------------------------------
// loading
// ---------------------------------------------------------------------------

test('listPacks finds folders with a pack.yaml, and only those', () => {
    const f = packFixture();
    try {
        assert.deepEqual(listPacks(f.packsDir), ['alpha', 'beta']);
    } finally { f.cleanup(); }
});

test('loadPack reads the manifest, its archetypes and its folders', () => {
    const f = packFixture();
    try {
        const alpha = loadPack('alpha', f.packsDir);
        assert.equal(alpha.label, 'Alpha stack');
        assert.deepEqual(alpha.archetypes, [{ id: 'ship-it', label: 'Ship it' }]);
        assert.equal(alpha.flowsDir, path.join(f.packsDir, 'alpha', 'flows'));
        assert.equal(loadPack('beta', f.packsDir).label, 'beta', 'label defaults to the id');
    } finally { f.cleanup(); }
});

test('an unknown pack is an error that names the packs that exist', () => {
    const f = packFixture();
    try {
        assert.throws(() => loadPack('gamma', f.packsDir), (err: Error) =>
            err instanceof PackError && /unknown pack "gamma"/.test(err.message) && /alpha, beta/.test(err.message));
    } finally { f.cleanup(); }
});

test('a manifest whose id does not match its folder is refused', () => {
    const f = packFixture();
    try {
        write(path.join(f.packsDir, 'beta', 'pack.yaml'), 'id: alpha\n');
        assert.throws(() => loadPack('beta', f.packsDir), /does not match its folder/);
    } finally { f.cleanup(); }
});

test('role traits are validated strictly — a typo cannot read as "absent"', () => {
    // Same reasoning as a flow's `task_type:` block. These traits are
    // exactly the ones whose absence is SILENT: without `report`,
    // ImplementFromInvestigation finds no report and says nothing; without
    // `outcome`, a failed deploy parses as success. So a misspelt key is an
    // error naming what is allowed, never a default.
    const f = packFixture();
    const manifest = path.join(f.packsDir, 'beta', 'pack.yaml');
    const withRoles = (body: string): void => write(manifest, `id: beta\n${body}`);
    try {
        withRoles('roles: not-a-list\n');
        assert.throws(() => loadPack('beta', f.packsDir), /"roles" must be a list/);

        withRoles('roles:\n  - id: deployer\n    reprot: true\n');
        assert.throws(() => loadPack('beta', f.packsDir), /unknown field "roles\[\]\.reprot"/);

        withRoles('roles:\n  - id: deployer\n  - id: deployer\n');
        assert.throws(() => loadPack('beta', f.packsDir), /role "deployer" is listed twice/);

        withRoles('roles:\n  - id: deployer\n    report: "yes"\n');
        assert.throws(() => loadPack('beta', f.packsDir), /must be true or false/);

        withRoles('roles:\n  - id: deployer\n    outcome:\n      require_verdict: true\n');
        assert.throws(() => loadPack('beta', f.packsDir), /declares no markers/);

        withRoles('roles:\n  - id: deployer\n    outcome:\n      success: [""]\n');
        assert.throws(() => loadPack('beta', f.packsDir), /list of non-empty strings/);

        withRoles('roles:\n  - id: deployer\n    outcome:\n      sucess: ["DEPLOYED"]\n');
        assert.throws(() => loadPack('beta', f.packsDir), /unknown field "roles\[deployer\]\.outcome\.sucess"/);

        withRoles('roles:\n  - id: "bad id!"\n');
        assert.throws(() => loadPack('beta', f.packsDir), /needs an id of/);
    } finally { f.cleanup(); }
});

test('a manifest with no roles block is fine — most packs have none', () => {
    const f = packFixture();
    try {
        assert.deepEqual(loadPack('beta', f.packsDir).roles, []);
        assert.deepEqual(loadPack('alpha', f.packsDir).roles, []);
    } finally { f.cleanup(); }
});

test('resolvePacks: absent = none; duplicates and non-lists are refused', () => {
    const f = packFixture();
    try {
        assert.deepEqual(resolvePacks(undefined, f.packsDir), []);
        assert.deepEqual(resolvePacks(['beta', 'alpha'], f.packsDir).map((p) => p.id), ['beta', 'alpha'], 'order kept');
        assert.throws(() => resolvePacks(['alpha', 'alpha'], f.packsDir), /listed twice/);
        assert.throws(() => resolvePacks('alpha', f.packsDir), /must be a list/);
    } finally { f.cleanup(); }
});

test('the shipped dotnet-azure pack loads and adds its two plan archetypes', () => {
    const pack = loadPack('dotnet-azure');
    assert.deepEqual(pack.archetypes.map((a) => a.id), ['deploy-only', 'review-azure']);
    assert.ok(fs.existsSync(path.join(pack.flowsDir, 'deploy-nuget.yaml')));
    assert.ok(fs.existsSync(path.join(pack.agentsDir, 'publisher.CLAUDE.md')));
});

test('the shipped pack declares the role traits core used to hardcode', () => {
    // All four were literals inside core: two verdict-marker tables in
    // core/flow/agent-outcome.ts, and two role names in the board's report
    // gate and the ImplementFromInvestigation SQL. Core must not name a
    // stack's roles, so the manifest carries them — and these assertions
    // are what pins the markers to the behaviour core used to implement.
    const roles = new Map(loadPack('dotnet-azure').roles.map((r) => [r.id, r]));
    assert.deepEqual([...roles.keys()].sort(), [
        'azure-diagnostician', 'azure-reviewer', 'deploy-verifier', 'deployer',
    ]);

    assert.deepEqual(roles.get('deployer')?.outcome, {
        success: ['DEPLOYED'], failure: ['DEPLOY FAILED'], requireVerdict: true,
    });
    assert.deepEqual(roles.get('deploy-verifier')?.outcome, {
        success: ['VERIFIED:'], failure: ['STALE:', 'INCONCLUSIVE:'], requireVerdict: true,
    });
    // require_verdict is the T-DOA-001/002 guard: for a deploy, SILENCE
    // must not read as success.
    assert.equal(roles.get('deploy-verifier')?.outcome?.requireVerdict, true);

    // The read-only Azure roles produce reports and mandate no verdict.
    assert.equal(roles.get('azure-reviewer')?.report, true);
    assert.equal(roles.get('azure-diagnostician')?.report, true);
    assert.equal(roles.get('azure-reviewer')?.outcome, undefined);
    assert.equal(roles.get('deployer')?.report, false, 'a deploy is not a report');
});

test('pipeline.yaml: `packs` must be a list of ids', () => {
    assert.doesNotThrow(() => parsePipelineConfig('p.yaml', { packs: ['dotnet-azure'] }));
    assert.doesNotThrow(() => parsePipelineConfig('p.yaml', { packs: [] }));
    assert.throws(() => parsePipelineConfig('p.yaml', { packs: 'dotnet-azure' }), /packs/);
    assert.throws(() => parsePipelineConfig('p.yaml', { packs: [1] }), /packs/);
});

// ---------------------------------------------------------------------------
// layering: personas and flows
// ---------------------------------------------------------------------------

const HATCH = '<!-- BEGIN include: _shared/clarification-block.md -->\n## Escape hatch\n';

function layerFixture(): {
    repoAgents: string; packsDir: string; home: string; cleanup: () => void;
} {
    const repoAgents = tmp('repo-agents');
    write(path.join(repoAgents, 'developer.CLAUDE.md'), `# ROLE: Developer\n\nCore rules.\n\n${HATCH}`);
    const packsDir = tmp('packs');
    write(path.join(packsDir, 'stack', 'pack.yaml'), 'id: stack\n');
    write(path.join(packsDir, 'stack', 'agents', 'publisher.CLAUDE.md'), `# ROLE: Publisher\n\n${HATCH}`);
    write(path.join(packsDir, 'stack', 'agents', 'developer.extend.md'), '## Stack rules\n\nPACK-EXTENSION\n');
    write(path.join(packsDir, 'stack', 'flows', 'ship.yaml'), 'on: TaskApproved\n');
    const home = tmp('home');
    return {
        repoAgents, packsDir, home,
        cleanup: (): void => {
            for (const d of [repoAgents, packsDir, home]) fs.rmSync(d, { recursive: true, force: true });
        },
    };
}

test('a pack ships whole personas for roles core does not have', () => {
    const l = layerFixture();
    try {
        const packs = resolvePacks(['stack'], l.packsDir);
        const r = resolvePersona('publisher', { home: null, repoAgentsDir: l.repoAgents, packs });
        assert.equal(r?.source, 'pack');
        assert.equal(defaultPersonaFile('publisher', { repoAgentsDir: l.repoAgents, packs }).source, 'pack');
        assert.equal(resolvePersona('publisher', { home: null, repoAgentsDir: l.repoAgents, packs: [] }), null,
            'pack off: the role has no persona');
    } finally { l.cleanup(); }
});

test('pack extension first, then the profile\'s — both ahead of the escape hatch', () => {
    const l = layerFixture();
    try {
        write(path.join(l.home, 'agents', 'developer.extend.md'), '## House rules\n\nPROFILE-EXTENSION\n');
        const packs = resolvePacks(['stack'], l.packsDir);
        const text = composePersona('developer', { home: l.home, repoAgentsDir: l.repoAgents, packs }) ?? '';
        const core = text.indexOf('Core rules.');
        const pack = text.indexOf('PACK-EXTENSION');
        const own = text.indexOf('PROFILE-EXTENSION');
        const hatch = text.indexOf('<!-- BEGIN include');
        assert.ok(core < pack && pack < own && own < hatch, 'order: core, pack, profile, escape hatch');
    } finally { l.cleanup(); }
});

test('flow layers are repo, then packs, then the profile', () => {
    const l = layerFixture();
    try {
        fs.mkdirSync(path.join(l.home, 'flows'));
        const repoConfig = tmp('repo-config');
        const packs = resolvePacks(['stack'], l.packsDir);
        assert.deepEqual(flowLayerDirs({ repoConfigDir: repoConfig, home: l.home, packs }), [
            path.join(repoConfig, 'flows'),
            path.join(l.packsDir, 'stack', 'flows'),
            path.join(l.home, 'flows'),
        ]);
        fs.rmSync(repoConfig, { recursive: true, force: true });
    } finally { l.cleanup(); }
});

test('the active packs come from the effective pipeline.yaml, and an override pins them', () => {
    const home = tmp('active');
    try {
        activateProfile(home);
        assert.deepEqual(activePacks(), [], 'repo default: no packs');
        write(path.join(home, 'pipeline.yaml'), 'packs:\n  - dotnet-azure\n');
        activateProfile(home);
        assert.deepEqual(activePacks().map((p) => p.id), ['dotnet-azure']);
        activateProfile(home, { packs: [] });
        assert.deepEqual(activePacks(), []);
        write(path.join(home, 'pipeline.yaml'), 'packs:\n  - no-such-pack\n');
        activateProfile(home);
        assert.throws(() => activePacks(), /unknown pack "no-such-pack"/);
    } finally {
        activateProfile(undefined);
        fs.rmSync(home, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// upgrade guard
// ---------------------------------------------------------------------------

test('a pre-pack (v1) profile with no `packs:` key is refused with the fix', () => {
    // Loading it would silently drop every stack task type.
    const home = tmp('v1');
    try {
        write(path.join(home, PROFILE_MARKER), JSON.stringify({ version: 1 }));
        write(path.join(home, 'pipeline.yaml'), 'issue_tracker: linear\n');
        const problem = profileUpgradeProblem(home) ?? '';
        assert.match(problem, /created before stack packs existed/);
        assert.match(problem, /- dotnet-azure/, 'the message carries the exact fix');

        write(path.join(home, 'pipeline.yaml'), 'issue_tracker: linear\npacks: []\n');
        assert.equal(profileUpgradeProblem(home), null, 'an explicit `packs:` — even empty — settles it');
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('v2 profiles, uninitialised profiles and no profile pass the guard', () => {
    const home = tmp('v2');
    try {
        assert.equal(profileUpgradeProblem(undefined), null);
        assert.equal(profileUpgradeProblem(home), null, 'not initialised');
        write(path.join(home, PROFILE_MARKER), JSON.stringify({ version: 2 }));
        assert.equal(profileUpgradeProblem(home), null);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
