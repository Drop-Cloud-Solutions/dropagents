import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

const PIPELINE_YAML = path.join(__dirname, 'pipeline.yaml');
const FLOWS_DIR = path.join(__dirname, 'flows');

interface PipelineConfig {
    issue_tracker: string;
    agent_runner: string;
    source_control: string;
    chat_gateway: string;
    default_models: Record<string, string>;
    default_flows: Record<string, string>;
    worktree_root: string;
}

function loadConfig(): PipelineConfig {
    const raw = fs.readFileSync(PIPELINE_YAML, 'utf8');
    return yaml.load(raw) as PipelineConfig;
}

test('pipeline.yaml declares every required top-level key', () => {
    const cfg = loadConfig();
    const required = [
        'issue_tracker',
        'agent_runner',
        'source_control',
        'chat_gateway',
        'default_models',
        'default_flows',
        'worktree_root',
    ] as const;
    for (const key of required) {
        assert.ok(
            Object.prototype.hasOwnProperty.call(cfg, key),
            `pipeline.yaml missing required key: ${key}`,
        );
    }
});

test('pipeline.yaml selects the documented adapter implementations', () => {
    const cfg = loadConfig();
    assert.equal(cfg.issue_tracker, 'linear');
    assert.equal(cfg.agent_runner, 'claude-cli');
    assert.equal(cfg.source_control, 'git-cli');
    assert.equal(cfg.chat_gateway, 'telegram');
});

test('pipeline.yaml worktree_root defaults to .pipeline-workspace/v2', () => {
    const cfg = loadConfig();
    assert.equal(cfg.worktree_root, '.pipeline-workspace/v2');
});

test('pipeline.yaml declares ONE default model and no per-role entries', () => {
    // Policy (operator's call): a single global default lives here and
    // every per-role choice lives on the Agents-panel record, so the
    // model for a role is changed in one place from the UI rather than
    // by editing YAML and redeploying. `developer` is just the key the
    // runner uses to NAME that global fallback — see resolveModel step 3
    // — not a developer-only setting. A per-role key reappearing here
    // would silently outrank nothing but still confuse the next reader
    // about where model config lives.
    const cfg = loadConfig();
    assert.deepEqual(
        Object.keys(cfg.default_models),
        ['developer'],
        'per-role models belong on the Agents panel, not in pipeline.yaml',
    );
    assert.match(
        cfg.default_models.developer,
        /^claude-/,
        `default_models.developer="${cfg.default_models.developer}" must be a claude-* model id`,
    );
});

test('pipeline.yaml default_flows resolves every entry to an existing flow file', () => {
    const cfg = loadConfig();
    const entries = Object.entries(cfg.default_flows);
    assert.ok(entries.length > 0, 'default_flows must declare at least one task type');
    for (const [taskType, flowFile] of entries) {
        assert.match(
            flowFile,
            /\.ya?ml$/,
            `default_flows.${taskType}="${flowFile}" must be a YAML filename`,
        );
        const resolved = path.join(FLOWS_DIR, flowFile);
        assert.ok(
            fs.existsSync(resolved),
            `default_flows.${taskType} points at "${flowFile}" but config/flows/${flowFile} does not exist`,
        );
    }
});
