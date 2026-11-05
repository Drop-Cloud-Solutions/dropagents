/**
 * `profile init`: copy this machine's personal config into the profile,
 * so the repo defaults can become generic without changing what runs.
 *
 * The contract that matters most: it never guesses which of two diverging
 * personas you meant. A role whose Agents-panel DB prompt differs from the
 * file blocks the write until you decide — the decomposer's DB copy was a
 * July snapshot missing three later sections, and silently picking either
 * side would have changed the agent without anyone noticing.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import Database from 'better-sqlite3';
import * as dotenv from 'dotenv';

import { applyMigrations, openDatabase } from '../core/state/migrations';
import { CUSTOMISED_INDEX, PROFILE_MARKER, isProfileInitialised } from '../config/profile';
import {
    classifyEnvKey,
    comparePrompt,
    planProfileInit,
    quoteEnv,
    readLegacyPrompts,
    writePlan,
    type InitInputs,
} from './profile-init';

const HATCH = '## Escape hatch\n\nNEEDS_HUMAN_INPUT\n';

function repoFixture(): { repo: string; home: string; cleanup: () => void } {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'init-repo-'));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'init-home-'));
    fs.mkdirSync(path.join(repo, 'agents'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'config', 'flows'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'agents', 'planner.CLAUDE.md'), `# ROLE: Planner\n\n## A\n\n${HATCH}`);
    fs.writeFileSync(path.join(repo, 'agents', 'developer.CLAUDE.md'), `# ROLE: Developer\n\n${HATCH}`);
    fs.writeFileSync(path.join(repo, 'config', 'pipeline.yaml'), 'issue_tracker: linear\nchat_gateway: telegram\n');
    fs.writeFileSync(path.join(repo, 'config', 'flows', 'implement.yaml'), 'on: TaskApproved\n');
    return {
        repo,
        home,
        cleanup: (): void => {
            fs.rmSync(repo, { recursive: true, force: true });
            fs.rmSync(home, { recursive: true, force: true });
        },
    };
}

function inputs(repo: string, home: string, extra: Partial<InitInputs> = {}): InitInputs {
    return {
        repoRoot: repo,
        home,
        legacyPrompts: {},
        repoEnv: {},
        now: new Date('2026-09-11T10:00:00Z'),
        ...extra,
    };
}

const relOf = (plan: { files: ReadonlyArray<{ rel: string }> }): string[] => plan.files.map((f) => f.rel);

// ---------------------------------------------------------------------------
// env classification + quoting
// ---------------------------------------------------------------------------

test('secrets and machine paths go to secrets.env; everything else to settings.env', () => {
    for (const k of ['LINEAR_API_KEY', 'TELEGRAM_BOT_TOKEN', 'WORKER_API_TOKEN_V2', 'JIRA_API_TOKEN',
        'AZURE_STORAGE_CONNECTION_STRING', 'TELEGRAM_CHAT_ID', 'GITHUB_PAT', 'ANTHROPIC_API_KEY', 'CURSOR_API_KEY']) {
        assert.equal(classifyEnvKey(k), 'secret', k);
    }
    for (const k of ['PIPELINE_WORKSPACE_ROOT', 'PIPELINE_STATE_DB', 'LOG_FILE', 'WORKER_API_HOST', 'CLAUDE_CMD']) {
        assert.equal(classifyEnvKey(k), 'machine', k);
    }
    for (const k of ['CLAUDE_MODEL', 'CLAUDE_EFFORT_DEVELOPER', 'AGENT_RUNNER', 'SCHEDULES_ENABLED']) {
        assert.equal(classifyEnvKey(k), 'setting', k);
    }
    assert.equal(classifyEnvKey('PIPELINE_HOME'), 'bootstrap', 'stays in the repo .env — it is how hosts find the profile');
});

test('quoteEnv round-trips through dotenv — including Windows paths', () => {
    for (const value of [
        'plain',
        'C:\\Drop-AI\\Source',
        'has spaces',
        'with # hash',
        "it's quoted",
        'say "hi"',
        'both \' and "',
        '',
    ]) {
        const parsed = dotenv.parse(`K=${quoteEnv(value)}\n`);
        assert.equal(parsed.K, value, `round-trip of ${JSON.stringify(value)}`);
    }
});

// ---------------------------------------------------------------------------
// planning
// ---------------------------------------------------------------------------

test('every repo persona and today\'s pipeline.yaml are snapshotted; flows are NOT copied', () => {
    const f = repoFixture();
    try {
        const plan = planProfileInit(inputs(f.repo, f.home), {});
        const rels = relOf(plan);
        assert.ok(rels.includes('agents/planner.CLAUDE.md'));
        assert.ok(rels.includes('agents/developer.CLAUDE.md'));
        assert.ok(rels.includes('pipeline.yaml'));
        assert.ok(!rels.some((r) => r.startsWith('flows/')), 'a profile copy of every flow would hide every later fix');
        assert.ok(rels.includes(PROFILE_MARKER));
        assert.deepEqual(plan.undecided, []);
    } finally { f.cleanup(); }
});

test('a DB prompt that differs from the file blocks the write until decided', () => {
    const f = repoFixture();
    try {
        const legacy = { planner: { prompt: `# ROLE: Planner (July)\n\n## Old section\n\n${HATCH}`, updatedAt: 1 } };
        const plan = planProfileInit(inputs(f.repo, f.home, { legacyPrompts: legacy }), {});
        assert.deepEqual(plan.undecided, ['planner']);
        assert.ok(!relOf(plan).includes('agents/planner.CLAUDE.md'), 'never guess between two personas');

        const cmp = plan.comparisons[0]!;
        assert.deepEqual(cmp.headingsOnlyInDb, ['# ROLE: Planner (July)', '## Old section']);
        assert.deepEqual(cmp.headingsOnlyInFile, ['# ROLE: Planner', '## A']);
    } finally { f.cleanup(); }
});

test('--keep-db writes the DB copy; --use-file writes the file', () => {
    const f = repoFixture();
    try {
        const dbCopy = `# ROLE: Planner (mine)\n\n${HATCH}`;
        const legacy = { planner: { prompt: dbCopy, updatedAt: 1 } };
        const keep = planProfileInit(inputs(f.repo, f.home, { legacyPrompts: legacy }), { planner: 'db' });
        assert.equal(keep.files.find((x) => x.rel === 'agents/planner.CLAUDE.md')?.content, dbCopy);

        const file = planProfileInit(inputs(f.repo, f.home, { legacyPrompts: legacy }), { planner: 'file' });
        assert.match(file.files.find((x) => x.rel === 'agents/planner.CLAUDE.md')?.content ?? '', /^# ROLE: Planner\n/);
    } finally { f.cleanup(); }
});

test('a DB prompt identical to the file needs no decision', () => {
    const f = repoFixture();
    try {
        const same = fs.readFileSync(path.join(f.repo, 'agents', 'planner.CLAUDE.md'), 'utf8');
        const plan = planProfileInit(inputs(f.repo, f.home, { legacyPrompts: { planner: { prompt: same, updatedAt: 1 } } }), {});
        assert.deepEqual(plan.undecided, []);
        assert.equal(plan.comparisons[0]?.identical, true);
    } finally { f.cleanup(); }
});

test('a DB copy with no escape hatch is flagged', () => {
    const cmp = comparePrompt('decomposer', { prompt: '# ROLE: D\n', updatedAt: null }, `# ROLE: D\n\n${HATCH}`);
    assert.equal(cmp.dbHasEscapeHatch, false);
});

test('the repo .env is split, PIPELINE_HOME stays behind, and secrets are gitignored', () => {
    const f = repoFixture();
    try {
        const plan = planProfileInit(inputs(f.repo, f.home, {
            repoEnv: { PIPELINE_HOME: 'C:\\P', LINEAR_API_KEY: 'lin_x', CLAUDE_MODEL: 'claude-opus-4-8', PIPELINE_WORKSPACE_ROOT: 'C:\\Drop-AI\\Source' },
        }), {});
        assert.deepEqual(plan.env.secrets, ['LINEAR_API_KEY', 'PIPELINE_WORKSPACE_ROOT']);
        assert.deepEqual(plan.env.settings, ['CLAUDE_MODEL']);
        const secrets = dotenv.parse(plan.files.find((x) => x.rel === 'secrets.env')?.content ?? '');
        assert.equal(secrets.PIPELINE_WORKSPACE_ROOT, 'C:\\Drop-AI\\Source');
        const gitignore = plan.files.find((x) => x.rel === '.gitignore')?.content ?? '';
        for (const line of ['secrets.env', 'shared/', 'state/']) {
            assert.ok(gitignore.split('\n').includes(line), `.gitignore must exclude ${line}`);
        }
        assert.ok(!plan.files.some((x) => x.content.includes('PIPELINE_HOME=')));
    } finally { f.cleanup(); }
});

test('the Settings-panel store is carried over when present', () => {
    const f = repoFixture();
    try {
        fs.mkdirSync(path.join(f.repo, 'shared', '.cache'), { recursive: true });
        fs.writeFileSync(path.join(f.repo, 'shared', '.cache', 'settings.json'), '{"X":{"body":"1"}}');
        const plan = planProfileInit(inputs(f.repo, f.home), {});
        assert.ok(relOf(plan).includes('shared/.cache/settings.json'));
    } finally { f.cleanup(); }
});

// ---------------------------------------------------------------------------
// writing + DB reading
// ---------------------------------------------------------------------------

test('writePlan initialises the profile and records the defaults it copied from', () => {
    const f = repoFixture();
    try {
        const plan = planProfileInit(inputs(f.repo, f.home), {});
        writePlan(plan, new Date('2026-09-11T10:00:00Z'));
        assert.equal(isProfileInitialised(f.home), true);
        const index = JSON.parse(fs.readFileSync(path.join(f.home, CUSTOMISED_INDEX), 'utf8')) as Record<string, { defaultSha256: string | null }>;
        assert.ok(index['agents/planner.CLAUDE.md']?.defaultSha256, 'drift detection needs the baseline');
        assert.ok(index['pipeline.yaml']?.defaultSha256);
    } finally { f.cleanup(); }
});

test('readLegacyPrompts picks the NEWEST active row per role, like the resolver', () => {
    // An older row with a prompt must not win over a newer row without one:
    // the orchestrator reads the newest row, so an empty newest row means
    // no DB override is in force today.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'init-db-'));
    const dbPath = path.join(dir, 'state.db');
    try {
        const db = openDatabase(dbPath);
        applyMigrations(db);
        db.close();
        const w = new Database(dbPath);
        const ins = w.prepare('INSERT INTO agents(agent_id, name, role, prompt, deleted_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
        ins.run('a1', 'p', 'planner', '# old planner prompt', null, 1);
        ins.run('a2', 'p', 'planner', '', null, 2);
        ins.run('a3', 'd', 'decomposer', '# decomposer prompt', null, 5);
        ins.run('a4', 'd', 'decomposer', '# deleted newer', 9, 9);
        w.close();

        const got = readLegacyPrompts(dbPath);
        assert.deepEqual(Object.keys(got), ['decomposer']);
        assert.equal(got.decomposer?.prompt, '# decomposer prompt');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('a missing database simply means no DB prompts', () => {
    assert.deepEqual(readLegacyPrompts(path.join(os.tmpdir(), 'definitely-missing-db.sqlite')), {});
});
