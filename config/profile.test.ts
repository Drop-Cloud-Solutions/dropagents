/**
 * The operator profile: personal config layered over the repo defaults.
 *
 * The failure this exists to end: the manager UI saved persona, flow and
 * pipeline.yaml edits straight into tracked repo files, so every UI edit
 * was a future `git pull` conflict — and a stale 49 KB Agents-panel DB copy
 * of the decomposer persona silently shadowed every later improvement to
 * the file. These tests pin the precedence that replaces that.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    PROFILE_MARKER,
    SHARED_BLOCK_MARKER,
    LayeredConfigError,
    ProfileHomeError,
    activateProfile,
    activeProfileHome,
    composePersona,
    configStoreRootDefaults,
    customisationInfo,
    deepMerge,
    defaultProfileHome,
    flowLayerDirs,
    forgetCustomisation,
    insertBeforeSharedBlock,
    isInside,
    readLayeredPipelineDoc,
    recordCustomisation,
    resolveConfigFile,
    resolvePersona,
    resolveProfileHome,
} from './profile';

const PERSONA = [
    '# ROLE: Planner',
    '',
    'Plan things.',
    '',
    SHARED_BLOCK_MARKER,
    '## Escape hatch: NEEDS_HUMAN_INPUT',
    'Ask when stuck.',
    '',
].join('\n');

function tmp(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), `profile-${prefix}-`));
}

function layout(): { repo: string; agents: string; config: string; home: string; cleanup: () => void } {
    const repo = tmp('repo');
    const agents = path.join(repo, 'agents');
    const config = path.join(repo, 'config');
    fs.mkdirSync(agents, { recursive: true });
    fs.mkdirSync(path.join(config, 'flows'), { recursive: true });
    fs.writeFileSync(path.join(agents, 'planner.CLAUDE.md'), PERSONA);
    const home = tmp('home');
    return {
        repo,
        agents,
        config,
        home,
        cleanup: (): void => {
            fs.rmSync(repo, { recursive: true, force: true });
            fs.rmSync(home, { recursive: true, force: true });
        },
    };
}

function write(file: string, content: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
}

// ---------------------------------------------------------------------------
// Home resolution
// ---------------------------------------------------------------------------

test('no PIPELINE_HOME resolves to ~/.dropagents', () => {
    assert.equal(resolveProfileHome(undefined, { homedir: () => '/u/me' }), path.join('/u/me', '.dropagents'));
    assert.equal(resolveProfileHome('   ', { homedir: () => '/u/me' }), defaultProfileHome(() => '/u/me'));
});

test('a relative PIPELINE_HOME is refused — hosts start from different cwds', () => {
    assert.throws(() => resolveProfileHome('profile'), ProfileHomeError);
    assert.throws(() => resolveProfileHome('./profile'), /absolute path/);
});

test('a PIPELINE_HOME inside the repo is refused — writes would land in the checkout', () => {
    const repo = path.resolve(os.tmpdir(), 'some-repo');
    assert.throws(
        () => resolveProfileHome(path.join(repo, 'my-profile'), { repoRoot: repo }),
        /outside the repository/,
    );
    assert.throws(() => resolveProfileHome(repo, { repoRoot: repo }), /outside the repository/);
    const outside = path.resolve(os.tmpdir(), 'elsewhere');
    assert.equal(resolveProfileHome(outside, { repoRoot: repo }), outside);
});

test('isInside is case-insensitive on Windows and not fooled by a shared prefix', () => {
    const parent = path.resolve(os.tmpdir(), 'repo');
    assert.equal(isInside(path.join(parent, 'x'), parent), true);
    assert.equal(isInside(`${parent}-sibling`, parent), false, 'repo-sibling is not inside repo');
    if (process.platform === 'win32') {
        assert.equal(isInside(path.join(parent.toUpperCase(), 'x'), parent), true);
    }
});

test('no profile is active until a host activates one', () => {
    // Library code must never pick PIPELINE_HOME up from the environment:
    // tests would then read the operator's personal personas.
    assert.equal(activeProfileHome(), undefined);
});

// ---------------------------------------------------------------------------
// Personas
// ---------------------------------------------------------------------------

test('with no profile the repo persona is used', () => {
    const l = layout();
    try {
        const r = resolvePersona('planner', { home: null, repoAgentsDir: l.agents });
        assert.equal(r?.source, 'repo');
        assert.equal(r?.text, PERSONA);
    } finally { l.cleanup(); }
});

test('a profile persona replaces the repo persona', () => {
    const l = layout();
    try {
        write(path.join(l.home, 'agents', 'planner.CLAUDE.md'), '# ROLE: My planner\n');
        const r = resolvePersona('planner', { home: l.home, repoAgentsDir: l.agents });
        assert.equal(r?.source, 'profile');
        assert.equal(r?.text, '# ROLE: My planner\n');
    } finally { l.cleanup(); }
});

test('the legacy DB prompt still wins over the repo file BEFORE profile init', () => {
    // Upgrading must change nothing until the operator has exported their
    // Agents-panel prompts into files.
    const l = layout();
    try {
        const r = resolvePersona('planner', {
            home: l.home,
            repoAgentsDir: l.agents,
            legacyOverride: '# ROLE: DB copy\n',
        });
        assert.equal(r?.source, 'legacy-db');
        assert.equal(r?.text, '# ROLE: DB copy\n');
    } finally { l.cleanup(); }
});

test('after profile init the legacy DB prompt is ignored — files only', () => {
    const l = layout();
    try {
        write(path.join(l.home, PROFILE_MARKER), '{}');
        const r = resolvePersona('planner', {
            home: l.home,
            repoAgentsDir: l.agents,
            legacyOverride: '# ROLE: stale DB copy\n',
        });
        assert.equal(r?.source, 'repo', 'the hidden-override failure mode must be gone');
        assert.equal(r?.text, PERSONA);
    } finally { l.cleanup(); }
});

test('a profile persona beats the legacy DB prompt even before init', () => {
    // An Agents-panel save now writes a profile file; the old DB row must
    // not shadow the operator's newer edit.
    const l = layout();
    try {
        write(path.join(l.home, 'agents', 'planner.CLAUDE.md'), '# ROLE: newer file\n');
        const r = resolvePersona('planner', {
            home: l.home,
            repoAgentsDir: l.agents,
            legacyOverride: '# ROLE: older DB copy\n',
        });
        assert.equal(r?.source, 'profile');
    } finally { l.cleanup(); }
});

test('an .extend.md is spliced in BEFORE the shared escape-hatch block', () => {
    const l = layout();
    try {
        write(path.join(l.home, 'agents', 'planner.extend.md'), '## Our stack\n\nUse .NET.\n');
        const r = resolvePersona('planner', { home: l.home, repoAgentsDir: l.agents });
        const text = r?.text ?? '';
        assert.equal(r?.source, 'repo', 'extending keeps the repo base');
        assert.equal(r?.extensions.length, 1);
        const ext = text.indexOf('## Our stack');
        const hatch = text.indexOf(SHARED_BLOCK_MARKER);
        assert.ok(ext > 0 && hatch > ext, 'the escape hatch must stay the LAST section');
        assert.ok(text.indexOf('Plan things.') < ext, 'the base persona comes first');
    } finally { l.cleanup(); }
});

test('an empty .extend.md changes nothing', () => {
    const l = layout();
    try {
        write(path.join(l.home, 'agents', 'planner.extend.md'), '   \n');
        assert.equal(composePersona('planner', { home: l.home, repoAgentsDir: l.agents }), PERSONA);
    } finally { l.cleanup(); }
});

test('insertBeforeSharedBlock appends when the base has no block', () => {
    assert.equal(insertBeforeSharedBlock('# A\n', ['## B']), '# A\n\n## B\n');
});

test('a role name that is not a plain identifier never reads a file', () => {
    const l = layout();
    try {
        write(path.join(l.home, 'secret.CLAUDE.md'), 'TOP SECRET');
        assert.equal(resolvePersona('../secret', { home: path.join(l.home, 'agents') }), null);
        assert.equal(resolvePersona('a/b', { home: l.home, repoAgentsDir: l.agents }), null);
    } finally { l.cleanup(); }
});

test('the active profile is used when no home is passed', () => {
    const l = layout();
    try {
        write(path.join(l.home, 'agents', 'planner.CLAUDE.md'), '# ROLE: active profile\n');
        activateProfile(l.home);
        assert.equal(composePersona('planner', { repoAgentsDir: l.agents }), '# ROLE: active profile\n');
    } finally {
        activateProfile(undefined);
        l.cleanup();
    }
});

// ---------------------------------------------------------------------------
// pipeline.yaml
// ---------------------------------------------------------------------------

test('deepMerge: mappings merge, scalars and lists replace', () => {
    assert.deepEqual(
        deepMerge(
            { a: 1, m: { x: 1, y: 2 }, list: [1, 2] },
            { m: { y: 3, z: 4 }, list: [9], b: 2 },
        ),
        { a: 1, m: { x: 1, y: 3, z: 4 }, list: [9], b: 2 },
    );
});

test('the profile pipeline.yaml is deep-merged over the repo default', () => {
    const l = layout();
    try {
        write(path.join(l.config, 'pipeline.yaml'), 'issue_tracker: none\ndefault_models:\n  developer: a\n');
        write(path.join(l.home, 'pipeline.yaml'), 'issue_tracker: linear\ndefault_models:\n  planner: b\n');
        const r = readLayeredPipelineDoc({ repoConfigDir: l.config, home: l.home });
        assert.deepEqual(r.doc, {
            issue_tracker: 'linear',
            default_models: { developer: 'a', planner: 'b' },
        });
        assert.equal(r.profilePath, path.join(l.home, 'pipeline.yaml'));
    } finally { l.cleanup(); }
});

test('a missing repo pipeline.yaml is tolerated when the profile has one', () => {
    const l = layout();
    try {
        write(path.join(l.home, 'pipeline.yaml'), 'issue_tracker: linear\n');
        assert.deepEqual(
            readLayeredPipelineDoc({ repoConfigDir: l.config, home: l.home }).doc,
            { issue_tracker: 'linear' },
        );
    } finally { l.cleanup(); }
});

test('a malformed profile pipeline.yaml throws, naming the file — never a silent fallback', () => {
    const l = layout();
    try {
        write(path.join(l.config, 'pipeline.yaml'), 'issue_tracker: none\n');
        write(path.join(l.home, 'pipeline.yaml'), 'issue_tracker: [unclosed\n');
        assert.throws(
            () => readLayeredPipelineDoc({ repoConfigDir: l.config, home: l.home }),
            (err: unknown) => err instanceof LayeredConfigError
                && err.reason === 'malformed'
                && err.file === path.join(l.home, 'pipeline.yaml'),
        );
    } finally { l.cleanup(); }
});

// ---------------------------------------------------------------------------
// Flows, whole-file config, settings store
// ---------------------------------------------------------------------------

test('flow layers: repo first, profile only when its folder exists', () => {
    const l = layout();
    try {
        assert.deepEqual(flowLayerDirs({ repoConfigDir: l.config, home: l.home }), [path.join(l.config, 'flows')]);
        fs.mkdirSync(path.join(l.home, 'flows'));
        assert.deepEqual(
            flowLayerDirs({ repoConfigDir: l.config, home: l.home }),
            [path.join(l.config, 'flows'), path.join(l.home, 'flows')],
        );
    } finally { l.cleanup(); }
});

test('a profile schedules.yaml replaces the repo one', () => {
    const l = layout();
    try {
        write(path.join(l.config, 'schedules.yaml'), '[]\n');
        assert.equal(resolveConfigFile('schedules.yaml', { repoConfigDir: l.config, home: l.home }).source, 'repo');
        write(path.join(l.home, 'schedules.yaml'), '[]\n');
        assert.equal(resolveConfigFile('schedules.yaml', { repoConfigDir: l.config, home: l.home }).source, 'profile');
    } finally { l.cleanup(); }
});

test('the Settings store moves into the profile only once it is initialised', () => {
    // Before init the legacy location stays, so upgrading never makes
    // saved settings vanish.
    const l = layout();
    try {
        assert.deepEqual(configStoreRootDefaults(l.home), {});
        write(path.join(l.home, PROFILE_MARKER), '{}');
        assert.deepEqual(configStoreRootDefaults(l.home), { fsRootPath: l.home });
        assert.deepEqual(configStoreRootDefaults(undefined), {});
    } finally { l.cleanup(); }
});

// ---------------------------------------------------------------------------
// Drift: the default changed after you customised it
// ---------------------------------------------------------------------------

test('customisationInfo flags a default that moved after the customisation', () => {
    const l = layout();
    try {
        const rel = 'agents/planner.CLAUDE.md';
        assert.deepEqual(customisationInfo(l.home, rel, PERSONA), { customised: false, defaultChanged: false });

        write(path.join(l.home, 'agents', 'planner.CLAUDE.md'), '# mine\n');
        recordCustomisation(l.home, rel, PERSONA);
        assert.deepEqual(customisationInfo(l.home, rel, PERSONA), { customised: true, defaultChanged: false });
        assert.deepEqual(
            customisationInfo(l.home, rel, `${PERSONA}\nnew upstream rule\n`),
            { customised: true, defaultChanged: true },
            'otherwise an override silently hides every upstream fix',
        );

        forgetCustomisation(l.home, rel);
        assert.equal(customisationInfo(l.home, rel, `${PERSONA}x`).defaultChanged, false, 'no record, no alarm');
    } finally { l.cleanup(); }
});
