/**
 * AP-VP6-001 unit tests for the repo-root pipeline.yaml adapter-selection
 * loader (core/config/pipeline-config.ts).
 *
 * Covers the five acceptance criteria:
 *   1. Repo-root pipeline.yaml declares issue_tracker and chat_gateway
 *      with documented defaults (verified by parsing the bundled file).
 *   2. The loader exports an AdapterSelection type and resolves an
 *      `adapterSelection` field on the loaded config (camelCase
 *      projection).
 *   3. Loading a config with issue_tracker="bogus" throws a typed
 *      PipelineConfigError naming the field and the allowed values.
 *   4. Loading a config that omits both fields succeeds and resolves to
 *      { issueTracker: 'fake', chatGateway: 'fake' }.
 *   5. This file — defaults, valid values, invalid values, typed
 *      projection shape.
 *
 * Dual-runner discovery (matches the pattern used by
 * test/unit/orchestrator/notes-handler.test.ts): `npm test` runs
 * node:test; the review pipeline runs vitest on changed files. The shim
 * picks the right `test()` at module load so both runners discover the
 * same suite from a single source file.
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    DEFAULT_CHAT_GATEWAY,
    DEFAULT_ISSUE_TRACKER,
    loadPipelineConfig,
    parsePipelineConfig,
    PipelineConfigError,
    type AdapterSelection,
    type ChatGatewaySelection,
    type IssueTrackerSelection,
} from '../../core/config/pipeline-config';

// ---------------------------------------------------------------------------
// Dual-runner test() shim
// ---------------------------------------------------------------------------

type TestFn = (name: string, fn: () => void | Promise<void>) => void;

const test: TestFn = (((): TestFn => {
    if (process.env.VITEST) {
        const gt = (globalThis as { test?: TestFn }).test;
        if (typeof gt !== 'function') {
            throw new Error(
                'pipeline-config.test.ts: VITEST=true but globalThis.test is missing — '
                    + 'ensure vitest.config.ts sets test.globals = true',
            );
        }
        return gt;
    }
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    const nt = require('node:test') as { test: TestFn };
    return nt.test;
})());

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const REPO_ROOT_PIPELINE_YAML = path.join(REPO_ROOT, 'pipeline.yaml');

function writeTempYaml(contents: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-vp6-001-pipeline-cfg-'));
    const filePath = path.join(dir, 'pipeline.yaml');
    fs.writeFileSync(filePath, contents, 'utf8');
    return filePath;
}

// ---------------------------------------------------------------------------
// AC #4 / AC #5 — defaults
// ---------------------------------------------------------------------------

test('parsePipelineConfig: empty document resolves to fake/fake defaults', () => {
    const cfg = parsePipelineConfig('<empty>', null);
    assert.equal(cfg.issue_tracker, 'fake');
    assert.equal(cfg.chat_gateway, 'fake');
    assert.deepEqual(cfg.adapterSelection, { issueTracker: 'fake', chatGateway: 'fake' });
});

test('parsePipelineConfig: omitting both fields resolves to { issueTracker: fake, chatGateway: fake }', () => {
    const cfg = parsePipelineConfig('<mem>', { unrelated: 'value' });
    assert.equal(cfg.issue_tracker, 'fake');
    assert.equal(cfg.chat_gateway, 'fake');
    assert.deepEqual(cfg.adapterSelection, { issueTracker: 'fake', chatGateway: 'fake' });
});

test('DEFAULT_ISSUE_TRACKER and DEFAULT_CHAT_GATEWAY are both "fake"', () => {
    assert.equal(DEFAULT_ISSUE_TRACKER, 'fake');
    assert.equal(DEFAULT_CHAT_GATEWAY, 'fake');
});

// ---------------------------------------------------------------------------
// AC #5 — valid values
// ---------------------------------------------------------------------------

test('parsePipelineConfig: accepts issue_tracker="linear" and chat_gateway="telegram"', () => {
    const cfg = parsePipelineConfig('<mem>', {
        issue_tracker: 'linear',
        chat_gateway: 'telegram',
    });
    assert.equal(cfg.issue_tracker, 'linear');
    assert.equal(cfg.chat_gateway, 'telegram');
    assert.deepEqual(cfg.adapterSelection, {
        issueTracker: 'linear',
        chatGateway: 'telegram',
    });
});

test('parsePipelineConfig: accepts issue_tracker="fake" and chat_gateway="fake" explicitly', () => {
    const cfg = parsePipelineConfig('<mem>', {
        issue_tracker: 'fake',
        chat_gateway: 'fake',
    });
    assert.equal(cfg.issue_tracker, 'fake');
    assert.equal(cfg.chat_gateway, 'fake');
});

test('parsePipelineConfig: accepts mixed valid values (linear + fake)', () => {
    const cfg = parsePipelineConfig('<mem>', {
        issue_tracker: 'linear',
        chat_gateway: 'fake',
    });
    assert.deepEqual(cfg.adapterSelection, {
        issueTracker: 'linear',
        chatGateway: 'fake',
    });
});

// ---------------------------------------------------------------------------
// AC #3 — invalid values reject with typed error naming field + allowed set
// ---------------------------------------------------------------------------

test('parsePipelineConfig: issue_tracker="bogus" throws PipelineConfigError naming field and allowed values', () => {
    let caught: unknown;
    try {
        parsePipelineConfig('/tmp/pipeline.yaml', { issue_tracker: 'bogus' });
    } catch (err) {
        caught = err;
    }
    assert.ok(caught instanceof PipelineConfigError, 'expected PipelineConfigError');
    const err = caught as PipelineConfigError;
    assert.equal(err.field, 'issue_tracker');
    assert.match(err.message, /issue_tracker/);
    assert.match(err.message, /"bogus"/);
    assert.match(err.message, /"linear"/);
    assert.match(err.message, /"fake"/);
    assert.match(err.message, /\/tmp\/pipeline\.yaml/);
});

test('parsePipelineConfig: chat_gateway="slack" throws PipelineConfigError naming field and allowed values', () => {
    let caught: unknown;
    try {
        parsePipelineConfig('/tmp/pipeline.yaml', { chat_gateway: 'slack' });
    } catch (err) {
        caught = err;
    }
    assert.ok(caught instanceof PipelineConfigError, 'expected PipelineConfigError');
    const err = caught as PipelineConfigError;
    assert.equal(err.field, 'chat_gateway');
    assert.match(err.message, /chat_gateway/);
    assert.match(err.message, /"slack"/);
    assert.match(err.message, /"telegram"/);
    assert.match(err.message, /"fake"/);
});

test('parsePipelineConfig: non-string issue_tracker (number) is rejected — no silent coercion', () => {
    let caught: unknown;
    try {
        parsePipelineConfig('<mem>', { issue_tracker: 42 });
    } catch (err) {
        caught = err;
    }
    assert.ok(caught instanceof PipelineConfigError);
    const err = caught as PipelineConfigError;
    assert.equal(err.field, 'issue_tracker');
    assert.match(err.message, /must be a string/);
});

test('parsePipelineConfig: rejects non-mapping document root', () => {
    let caught: unknown;
    try {
        parsePipelineConfig('<mem>', ['issue_tracker', 'linear']);
    } catch (err) {
        caught = err;
    }
    assert.ok(caught instanceof PipelineConfigError);
    assert.match((caught as Error).message, /root must be a YAML mapping/);
});

// ---------------------------------------------------------------------------
// AC #2 — typed projection shape
// ---------------------------------------------------------------------------

test('parsePipelineConfig: adapterSelection projection is camelCase and exposes only the two adapter keys', () => {
    const cfg = parsePipelineConfig('<mem>', {
        issue_tracker: 'linear',
        chat_gateway: 'telegram',
    });
    const sel: AdapterSelection = cfg.adapterSelection;
    assert.deepEqual(Object.keys(sel).sort(), ['chatGateway', 'issueTracker']);
    const issueTracker: IssueTrackerSelection = sel.issueTracker;
    const chatGateway: ChatGatewaySelection = sel.chatGateway;
    assert.equal(issueTracker, 'linear');
    assert.equal(chatGateway, 'telegram');
});

test('parsePipelineConfig: raw mapping is preserved alongside the typed projection', () => {
    const cfg = parsePipelineConfig('<mem>', {
        issue_tracker: 'linear',
        chat_gateway: 'telegram',
        worktree_root: '.pipeline-workspace/v2',
    });
    assert.equal(cfg.raw.worktree_root, '.pipeline-workspace/v2');
});

// ---------------------------------------------------------------------------
// AC #1 — repo-root pipeline.yaml declares the keys with documented defaults
// ---------------------------------------------------------------------------

test('repo-root pipeline.yaml exists and parses with the documented adapter selection', () => {
    assert.ok(
        fs.existsSync(REPO_ROOT_PIPELINE_YAML),
        `expected pipeline.yaml at repo root: ${REPO_ROOT_PIPELINE_YAML}`,
    );
    const cfg = loadPipelineConfig(REPO_ROOT_PIPELINE_YAML);
    assert.ok(
        (['linear', 'fake'] as const).includes(cfg.adapterSelection.issueTracker),
        `issue_tracker resolved to invalid value: ${cfg.adapterSelection.issueTracker}`,
    );
    assert.ok(
        (['telegram', 'fake'] as const).includes(cfg.adapterSelection.chatGateway),
        `chat_gateway resolved to invalid value: ${cfg.adapterSelection.chatGateway}`,
    );
});

test('repo-root pipeline.yaml documents the deny-by-default TELEGRAM_ALLOWED_USER_IDS semantic in its header', () => {
    const contents = fs.readFileSync(REPO_ROOT_PIPELINE_YAML, 'utf8');
    assert.match(
        contents,
        /TELEGRAM_ALLOWED_USER_IDS/,
        'pipeline.yaml header must reference TELEGRAM_ALLOWED_USER_IDS',
    );
    assert.match(
        contents,
        /unset|empty/i,
        'pipeline.yaml header must document the unset/empty behaviour',
    );
    assert.match(
        contents,
        /deny|no inbound|dropped|denied/i,
        'pipeline.yaml header must document the deny-by-default semantic',
    );
});

// ---------------------------------------------------------------------------
// loadPipelineConfig wraps file IO and YAML errors in PipelineConfigError
// ---------------------------------------------------------------------------

test('loadPipelineConfig: missing file throws PipelineConfigError that names the path', () => {
    let caught: unknown;
    try {
        loadPipelineConfig('/definitely/not/a/real/path/pipeline.yaml');
    } catch (err) {
        caught = err;
    }
    assert.ok(caught instanceof PipelineConfigError);
    assert.match((caught as Error).message, /\/definitely\/not\/a\/real\/path\/pipeline\.yaml/);
    assert.match((caught as Error).message, /cannot read file/);
});

test('loadPipelineConfig: malformed YAML throws PipelineConfigError that names the path', () => {
    const filePath = writeTempYaml('issue_tracker: [unterminated\n');
    let caught: unknown;
    try {
        loadPipelineConfig(filePath);
    } catch (err) {
        caught = err;
    }
    assert.ok(caught instanceof PipelineConfigError);
    assert.match((caught as Error).message, /malformed YAML/);
});

test('loadPipelineConfig: end-to-end on a temp file with both fields declared', () => {
    const filePath = writeTempYaml('issue_tracker: linear\nchat_gateway: telegram\n');
    const cfg = loadPipelineConfig(filePath);
    assert.deepEqual(cfg.adapterSelection, {
        issueTracker: 'linear',
        chatGateway: 'telegram',
    });
});

test('loadPipelineConfig: end-to-end on a temp file that omits both fields → fake/fake', () => {
    const filePath = writeTempYaml('# no adapter selection keys\nworktree_root: /tmp/wt\n');
    const cfg = loadPipelineConfig(filePath);
    assert.deepEqual(cfg.adapterSelection, {
        issueTracker: 'fake',
        chatGateway: 'fake',
    });
});
