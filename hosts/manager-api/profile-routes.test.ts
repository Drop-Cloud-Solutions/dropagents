/**
 * The manager API is the single config-writing authority, and with a
 * profile active it must NEVER write a tracked repo file.
 *
 * Field failure this ends: persona, flow and pipeline.yaml saves from the
 * manager UI landed in `agents/` and `config/` inside the checkout, so
 * every UI edit was a future `git pull` conflict and a fresh clone on
 * another machine lost them all.
 *
 * Every test runs against a throwaway fake repo, snapshotted before and
 * compared after — a regression that writes the repo again fails here,
 * against a temp dir, instead of dirtying a real checkout.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import * as yaml from 'js-yaml';

import type { CommandBus } from '../../core/commands/bus';
import { PROFILE_MARKER } from '../../config/profile';
import { resolvePacks } from '../../config/packs';
import {
    acknowledgeDefault,
    getAgentMd,
    getFlow,
    getPipeline,
    getProfileStatus,
    listFlows,
    postAgent,
    putAgent,
    putAgentMd,
    putFlow,
    putPipeline,
    resetAgentMd,
    resetFlow,
    resetPipeline,
} from './routes';

const REAL_REPO = path.resolve(__dirname, '..', '..');

const PERSONA = [
    '# ROLE: Planner',
    '',
    'Plan the work.',
    '',
    '## Escape hatch: NEEDS_HUMAN_INPUT',
    '',
    'NEEDS_HUMAN_INPUT',
    'Question: ...',
    '',
].join('\n');

interface Fx {
    readonly repo: string;
    readonly configDir: string;
    readonly agentsDir: string;
    readonly home: string;
    snapshot(): Map<string, string>;
    cleanup(): void;
}

function fixture(): Fx {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'mgr-repo-'));
    const configDir = path.join(repo, 'config');
    const agentsDir = path.join(repo, 'agents');
    fs.mkdirSync(path.join(configDir, 'flows'), { recursive: true });
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.copyFileSync(path.join(REAL_REPO, 'config', 'pipeline.yaml'), path.join(configDir, 'pipeline.yaml'));
    fs.copyFileSync(path.join(REAL_REPO, 'config', 'flows', 'echo.yaml'), path.join(configDir, 'flows', 'echo.yaml'));
    fs.writeFileSync(path.join(agentsDir, 'planner.CLAUDE.md'), PERSONA);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mgr-home-'));

    const snapshot = (): Map<string, string> => {
        const out = new Map<string, string>();
        const walk = (dir: string): void => {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                const p = path.join(dir, e.name);
                if (e.isDirectory()) walk(p);
                else out.set(path.relative(repo, p), crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'));
            }
        };
        walk(repo);
        return out;
    };
    return {
        repo, configDir, agentsDir, home, snapshot,
        cleanup: (): void => {
            fs.rmSync(repo, { recursive: true, force: true });
            fs.rmSync(home, { recursive: true, force: true });
        },
    };
}

/** Lock file lives outside both trees so it can never count as a repo write. */
function writeOpts(fx: Fx): { configDir: string; profileHome: string; lockPath: string } {
    return { configDir: fx.configDir, profileHome: fx.home, lockPath: path.join(os.tmpdir(), `mgr-lock-${path.basename(fx.home)}`) };
}

function mdOpts(fx: Fx): { configDir: string; agentsDir: string; profileHome: string } {
    return { configDir: fx.configDir, agentsDir: fx.agentsDir, profileHome: fx.home };
}

const JSON_CT = 'application/json';

test('EVERY write route leaves the repo byte-identical when a profile is active', async () => {
    const fx = fixture();
    try {
        const before = fx.snapshot();

        assert.equal(putAgentMd(mdOpts(fx), 'planner', JSON.stringify({ content: `${PERSONA}\nMine.\n` }), JSON_CT).status, 200);
        assert.equal(putAgentMd(mdOpts(fx), 'newrole', JSON.stringify({ content: '# ROLE: New\n\nDo it.\n' }), JSON_CT).status, 200);
        const flow = fs.readFileSync(path.join(fx.configDir, 'flows', 'echo.yaml'), 'utf8').replace('agent: echo', 'agent: planner');
        assert.equal((await putFlow(writeOpts(fx), 'echo', flow, 'text/yaml')).status, 200);
        assert.equal((await putFlow(writeOpts(fx), 'mine', flow, 'text/yaml')).status, 200);
        const pipeline = getPipeline(writeOpts(fx)).body as Record<string, unknown>;
        assert.equal((await putPipeline(writeOpts(fx), yaml.dump({ ...pipeline, issue_tracker: 'jira' }), 'text/yaml')).status, 200);
        resetAgentMd(mdOpts(fx), 'planner');
        resetFlow(writeOpts(fx), 'echo');
        resetPipeline(writeOpts(fx));

        assert.deepEqual(fx.snapshot(), before, 'a manager write touched the repo — the pull-conflict bug is back');
    } finally { fx.cleanup(); }
});

// ---------------------------------------------------------------------------
// Personas
// ---------------------------------------------------------------------------

test('a persona save lands in the profile and GET reports it as customised', () => {
    const fx = fixture();
    try {
        const content = `${PERSONA}\nOur conventions.\n`;
        const put = putAgentMd(mdOpts(fx), 'planner', JSON.stringify({ content }), JSON_CT);
        assert.equal(put.status, 200);
        assert.equal(fs.readFileSync(path.join(fx.home, 'agents', 'planner.CLAUDE.md'), 'utf8'), content);

        const got = getAgentMd(mdOpts(fx), 'planner').body as Record<string, unknown>;
        assert.equal(got.content, content);
        assert.equal(got.source, 'profile');
        assert.equal(got.customised, true);
        assert.equal(got.hasDefault, true);
        assert.equal(got.defaultChanged, false);
    } finally { fx.cleanup(); }
});

test('the escape-hatch guard applies to a FIRST customisation too', () => {
    // The profile has no copy yet, so the guard must compare against the
    // repo default the role runs today — not against "nothing".
    const fx = fixture();
    try {
        const res = putAgentMd(mdOpts(fx), 'planner', JSON.stringify({ content: '# ROLE: Planner\n\nNo hatch here.\n' }), JSON_CT);
        assert.equal(res.status, 422);
        assert.equal(fs.existsSync(path.join(fx.home, 'agents', 'planner.CLAUDE.md')), false);
    } finally { fx.cleanup(); }
});

test('Reset drops the profile copy; resetting again says there is nothing to reset', () => {
    const fx = fixture();
    try {
        putAgentMd(mdOpts(fx), 'planner', JSON.stringify({ content: `${PERSONA}x\n` }), JSON_CT);
        assert.equal(resetAgentMd(mdOpts(fx), 'planner').status, 200);
        const got = getAgentMd(mdOpts(fx), 'planner').body as Record<string, unknown>;
        assert.equal(got.source, 'default');
        assert.equal(got.content, PERSONA);
        assert.equal(resetAgentMd(mdOpts(fx), 'planner').status, 409);
    } finally { fx.cleanup(); }
});

// ---------------------------------------------------------------------------
// Flows
// ---------------------------------------------------------------------------

test('a flow save overrides the default by name; list is the union; Reset restores it', async () => {
    const fx = fixture();
    try {
        const flow = fs.readFileSync(path.join(fx.configDir, 'flows', 'echo.yaml'), 'utf8').replace('agent: echo', 'agent: planner');
        assert.equal((await putFlow(writeOpts(fx), 'echo', flow, 'text/yaml')).status, 200);
        assert.equal((await putFlow(writeOpts(fx), 'mine', flow, 'text/yaml')).status, 200);

        const echo = readFlowBody(fx, 'echo');
        assert.equal(echo.steps[0]?.agent, 'planner', 'the profile copy wins');
        assert.deepEqual((listFlows(writeOpts(fx)).body as { flows: string[] }).flows, ['echo', 'mine']);

        assert.equal(resetFlow(writeOpts(fx), 'echo').status, 200);
        const back = readFlowBody(fx, 'echo');
        assert.equal(back.steps[0]?.agent, 'echo');
    } finally { fx.cleanup(); }
});

/**
 * The parsed flow out of `GET /flows/:name`, which serves an envelope
 * (`{ name, raw, flow, error }`) so a flow the loader rejects can still
 * be opened and repaired in the editor.
 */
function readFlowBody(
    fx: ReturnType<typeof fixture>,
    name: string,
): { steps: Array<{ agent: string }> } {
    const body = getFlow(writeOpts(fx), name).body as {
        flow: { steps: Array<{ agent: string }> } | null;
        error: string | null;
    };
    assert.equal(body.error, null, `${name} should load cleanly`);
    assert.ok(body.flow, `${name} should parse`);
    return body.flow!;
}

test('an invalid flow is rejected and nothing is written anywhere', async () => {
    const fx = fixture();
    try {
        const before = fx.snapshot();
        const res = await putFlow(writeOpts(fx), 'echo', 'on: [unclosed\n', 'text/yaml');
        assert.equal(res.status, 400);
        assert.equal(fs.existsSync(path.join(fx.home, 'flows', 'echo.yaml')), false);
        assert.deepEqual(fx.snapshot(), before);
    } finally { fx.cleanup(); }
});

// ---------------------------------------------------------------------------
// pipeline.yaml: only the difference is stored
// ---------------------------------------------------------------------------

test('a pipeline save stores ONLY the keys that differ from the default', async () => {
    // Storing the whole submitted document would freeze every key, so an
    // upstream change to a key the operator never touched could never
    // reach them.
    const fx = fixture();
    try {
        const effective = getPipeline(writeOpts(fx)).body as Record<string, unknown>;
        const submitted = {
            ...effective,
            issue_tracker: 'jira',
            default_models: { ...(effective.default_models as object), planner: 'claude-opus-4-8' },
        };
        assert.equal((await putPipeline(writeOpts(fx), yaml.dump(submitted), 'text/yaml')).status, 200);

        const stored = yaml.load(fs.readFileSync(path.join(fx.home, 'pipeline.yaml'), 'utf8'));
        assert.deepEqual(stored, { issue_tracker: 'jira', default_models: { planner: 'claude-opus-4-8' } });
        const merged = getPipeline(writeOpts(fx)).body as Record<string, unknown>;
        assert.equal(merged.issue_tracker, 'jira');
        assert.equal((merged.default_models as Record<string, unknown>).developer, (effective.default_models as Record<string, unknown>).developer);
    } finally { fx.cleanup(); }
});

test('saving the defaults back removes the profile pipeline.yaml', async () => {
    const fx = fixture();
    try {
        const effective = getPipeline(writeOpts(fx)).body as Record<string, unknown>;
        await putPipeline(writeOpts(fx), yaml.dump({ ...effective, issue_tracker: 'jira' }), 'text/yaml');
        assert.equal(fs.existsSync(path.join(fx.home, 'pipeline.yaml')), true);
        const res = await putPipeline(writeOpts(fx), yaml.dump(effective), 'text/yaml');
        assert.equal(res.status, 200);
        assert.equal(fs.existsSync(path.join(fx.home, 'pipeline.yaml')), false);
    } finally { fx.cleanup(); }
});

test('dropping a key the default sets is refused, naming it — it would silently reappear', async () => {
    const fx = fixture();
    try {
        const effective = { ...(getPipeline(writeOpts(fx)).body as Record<string, unknown>) };
        delete effective.chat_gateway;
        const res = await putPipeline(writeOpts(fx), yaml.dump(effective), 'text/yaml');
        assert.equal(res.status, 422);
        assert.match(String((res.body as { error: string }).error), /"chat_gateway"/);
    } finally { fx.cleanup(); }
});

// ---------------------------------------------------------------------------
// Status + drift
// ---------------------------------------------------------------------------

test('GET /profile flags a default that changed after you customised it; acknowledge clears it', () => {
    const fx = fixture();
    try {
        putAgentMd(mdOpts(fx), 'planner', JSON.stringify({ content: `${PERSONA}\nMine.\n` }), JSON_CT);
        const statusOf = (): Record<string, { customised: boolean; defaultChanged: boolean }> =>
            (getProfileStatus({ ...mdOpts(fx) }).body as { agents: Record<string, { customised: boolean; defaultChanged: boolean }> }).agents;
        assert.deepEqual(
            { ...statusOf().planner },
            { customised: true, defaultChanged: false, hasDefault: true },
        );

        // Upstream improves the default after the operator customised it.
        fs.appendFileSync(path.join(fx.agentsDir, 'planner.CLAUDE.md'), '\nNew upstream rule.\n');
        assert.equal(statusOf().planner?.defaultChanged, true);

        const ack = acknowledgeDefault(mdOpts(fx), JSON.stringify({ path: 'agents/planner.CLAUDE.md' }), JSON_CT);
        assert.equal(ack.status, 200);
        assert.equal(statusOf().planner?.defaultChanged, false);

        // Saving the override again must NOT count as having read the new default.
        fs.appendFileSync(path.join(fx.agentsDir, 'planner.CLAUDE.md'), '\nAnother rule.\n');
        putAgentMd(mdOpts(fx), 'planner', JSON.stringify({ content: `${PERSONA}\nMine v2.\n` }), JSON_CT);
        assert.equal(statusOf().planner?.defaultChanged, true);
    } finally { fx.cleanup(); }
});

test('acknowledge only accepts known profile paths', () => {
    const fx = fixture();
    try {
        for (const bad of ['../../etc/passwd', 'agents/../x.CLAUDE.md', 'secrets.env']) {
            const res = acknowledgeDefault(mdOpts(fx), JSON.stringify({ path: bad }), JSON_CT);
            assert.equal(res.status, 422, bad);
        }
    } finally { fx.cleanup(); }
});

test('GET /profile without a profile reports inactive', () => {
    const fx = fixture();
    try {
        assert.deepEqual(getProfileStatus({ configDir: fx.configDir }).body, { active: false, home: null, initialised: false });
    } finally { fx.cleanup(); }
});

// ---------------------------------------------------------------------------
// Agents panel: DB prompts retired after init
// ---------------------------------------------------------------------------

function recordingBus(): { bus: CommandBus<unknown>; sent: Array<{ type: string; payload: Record<string, unknown> }> } {
    const sent: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const bus = {
        send: async (cmd: { type: string; payload: Record<string, unknown> }) => {
            sent.push({ type: cmd.type, payload: cmd.payload });
            return [];
        },
    } as unknown as CommandBus<unknown>;
    return { bus, sent };
}

test('after init an agent save drops the prompt and says so; before init it passes through', async () => {
    const fx = fixture();
    try {
        const { bus, sent } = recordingBus();
        const opts = { commandBus: bus, clock: () => 1, actor: 'operator', profileHome: fx.home };
        const body = JSON.stringify({ name: 'p', role: 'planner', model: 'm', prompt: '# ROLE: typed in the panel\n' });

        const before = await postAgent(opts, body, JSON_CT);
        assert.equal(sent[0]?.payload.prompt, '# ROLE: typed in the panel\n', 'uninitialised: legacy behaviour');
        assert.equal((before.body as Record<string, unknown>).notice, undefined);

        fs.writeFileSync(path.join(fx.home, PROFILE_MARKER), '{}');
        const after = await putAgent(opts, 'agent-1', body, JSON_CT);
        assert.equal('prompt' in (sent[1]?.payload ?? {}), false, 'the DB prompt is retired');
        assert.equal(sent[1]?.payload.model, 'm', 'a model change still goes through');
        assert.match(String((after.body as Record<string, unknown>).notice), /personas are files in your profile/);

        await putAgent(opts, 'agent-1', JSON.stringify({ name: 'p', role: 'planner', prompt: '' }), JSON_CT);
    } finally { fx.cleanup(); }
});

// ---------------------------------------------------------------------------
// Stack packs: a pack's files are the "built-in default" for what it ships
// ---------------------------------------------------------------------------

const DOTNET = resolvePacks(['dotnet-azure']);

test('with a pack enabled its flows and personas are listed and readable', () => {
    const fx = fixture();
    try {
        const opts = { ...writeOpts(fx), packs: DOTNET };
        const flows = (listFlows(opts).body as { flows: string[] }).flows;
        assert.ok(flows.includes('deploy-nuget'), 'pack flows are listed');
        assert.ok(flows.includes('echo'), 'core flows still are');
        assert.equal(getFlow(opts, 'deploy-nuget').status, 200);
        assert.equal(getFlow(writeOpts(fx), 'deploy-nuget').status, 404, 'pack off: not there');

        const md = getAgentMd({ ...mdOpts(fx), packs: DOTNET }, 'publisher').body as Record<string, unknown>;
        assert.equal(md.exists, true);
        assert.equal(md.source, 'default', 'the pack copy is the built-in default');
        assert.match(String(md.content), /publish/i);
    } finally { fx.cleanup(); }
});

test('customising a pack flow lands in the profile; Reset returns to the pack version', async () => {
    const fx = fixture();
    try {
        const opts = { ...writeOpts(fx), packs: DOTNET };
        const packFlow = fs.readFileSync(path.join(DOTNET[0]!.flowsDir, 'deploy-azure.yaml'), 'utf8');
        const mine = packFlow.replace('label: "Deploy to Azure"', 'label: "Deploy (mine)"');
        assert.notEqual(mine, packFlow, 'fixture edit applied');
        assert.equal((await putFlow(opts, 'deploy-azure', mine, 'text/yaml')).status, 200);
        assert.ok(fs.existsSync(path.join(fx.home, 'flows', 'deploy-azure.yaml')));
        assert.equal(
            fs.readFileSync(path.join(DOTNET[0]!.flowsDir, 'deploy-azure.yaml'), 'utf8'),
            packFlow,
            'the pack file itself is never written',
        );
        const status = (getProfileStatus(opts).body as { flows: Record<string, { customised: boolean; hasDefault: boolean }> }).flows;
        assert.equal(status['deploy-azure']?.customised, true);
        assert.equal(status['deploy-azure']?.hasDefault, true, 'the pack file counts as the default');

        assert.equal(resetFlow(opts, 'deploy-azure').status, 200);
        assert.equal(fs.existsSync(path.join(fx.home, 'flows', 'deploy-azure.yaml')), false);
    } finally { fx.cleanup(); }
});

test('GET /profile lists pack personas and the enabled packs', () => {
    const fx = fixture();
    try {
        const body = getProfileStatus({ ...mdOpts(fx), packs: DOTNET }).body as {
            packs: Array<{ id: string }>;
            agents: Record<string, unknown>;
        };
        assert.deepEqual(body.packs.map((p) => p.id), ['dotnet-azure']);
        assert.ok('publisher' in body.agents);
    } finally { fx.cleanup(); }
});

test('a pipeline.yaml naming an unknown pack is refused before it can stop the next boot', async () => {
    const fx = fixture();
    try {
        const effective = getPipeline(writeOpts(fx)).body as Record<string, unknown>;
        const res = await putPipeline(writeOpts(fx), yaml.dump({ ...effective, packs: ['no-such-pack'] }), 'text/yaml');
        assert.equal(res.status, 422);
        assert.match(String((res.body as { error: string }).error), /unknown pack "no-such-pack"/);
        assert.equal(fs.existsSync(path.join(fx.home, 'pipeline.yaml')), false);

        const ok = await putPipeline(writeOpts(fx), yaml.dump({ ...effective, packs: ['dotnet-azure'] }), 'text/yaml');
        assert.equal(ok.status, 200);
        assert.deepEqual(yaml.load(fs.readFileSync(path.join(fx.home, 'pipeline.yaml'), 'utf8')), { packs: ['dotnet-azure'] });
    } finally { fx.cleanup(); }
});
