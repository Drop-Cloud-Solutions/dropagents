import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { Logger } from '../../core/ports/Logger';
import { FLOW_STEP_APPROVALS } from '../../core/flow/types';

import { start } from './main';

/**
 * AP-VP-014 — PUT /flows/:name approval validation.
 *
 * The route delegates validation to the core flow loader (loadAllFlows
 * against a temp directory mirroring the live flows dir), so the closed
 * union for `approval` lives once in `core/flow/types.ts` and the route
 * just translates the loader's thrown error into a 400 response. These
 * tests pin that behaviour from the HTTP boundary:
 *
 *   - accept paths: missing approval, `auto`, `required` → 200
 *   - reject paths: a typo, a wrong type → 400 with a message that
 *     names the offending step id and the rejected value
 */

const SAMPLE_PIPELINE = `issue_tracker: linear
agent_runner: claude-cli
source_control: git-cli
chat_gateway: telegram
default_models:
  developer: claude-opus-4-7
worktree_root: .pipeline-workspace/v2
`;

class SilentLogger implements Logger {
    info(): void {}
    warn(): void {}
    error(): void {}
    debug(): void {}
}

interface Fixture {
    readonly dir: string;
    readonly flowsDir: string;
    readonly lockPath: string;
    cleanup(): void;
}

function makeFixture(): Fixture {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-api-approval-'));
    const flowsDir = path.join(dir, 'flows');
    fs.mkdirSync(flowsDir);
    fs.writeFileSync(path.join(dir, 'pipeline.yaml'), SAMPLE_PIPELINE, 'utf8');
    return {
        dir,
        flowsDir,
        lockPath: path.join(dir, '.locks', 'manager-api.lock'),
        cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
    };
}

interface Harness {
    readonly baseUrl: string;
    readonly fixture: Fixture;
    stop(): Promise<void>;
}

async function makeHarness(): Promise<Harness> {
    const fixture = makeFixture();
    const handle = await start({
        port: 0,
        host: '127.0.0.1',
        authToken: TOKEN,
        configDir: fixture.dir,
        logger: new SilentLogger(),
        write: { lockPath: fixture.lockPath, lock: {} },
    });
    return {
        baseUrl: `http://127.0.0.1:${handle.port}`,
        fixture,
        async stop(): Promise<void> {
            await handle.stop();
            fixture.cleanup();
        },
    };
}

const TOKEN = 'test-token';
const YAML_HEADERS = { 'Content-Type': 'text/yaml', Authorization: `Bearer ${TOKEN}` };

function bodyWithApproval(approvalLine: string): string {
    return `on: TaskApproved
steps:
  - id: gate
    agent: developer
    model: claude-opus-4-7
    on_success: emit:Done
${approvalLine}`;
}

// ---------------------------------------------------------------------------
// Accept: missing approval (back-compat — engine falls back to defaults)
// ---------------------------------------------------------------------------

test('PUT /flows/:name accepts a step with no approval field (200)', async () => {
    const h = await makeHarness();
    try {
        const body = bodyWithApproval('');
        const res = await fetch(`${h.baseUrl}/flows/no-approval`, {
            method: 'PUT',
            headers: YAML_HEADERS,
            body,
        });
        assert.equal(res.status, 200);
        const target = path.join(h.fixture.flowsDir, 'no-approval.yaml');
        assert.equal(fs.readFileSync(target, 'utf8'), body);
    } finally {
        await h.stop();
    }
});

// ---------------------------------------------------------------------------
// Accept: every value in the closed FlowStepApproval union
// ---------------------------------------------------------------------------

for (const value of Object.values(FLOW_STEP_APPROVALS)) {
    test(`PUT /flows/:name accepts approval="${value}" (200)`, async () => {
        const h = await makeHarness();
        try {
            const body = bodyWithApproval(`    approval: ${value}\n`);
            const flowName = `approval-${value}`;
            const res = await fetch(`${h.baseUrl}/flows/${flowName}`, {
                method: 'PUT',
                headers: YAML_HEADERS,
                body,
            });
            assert.equal(res.status, 200);
            const target = path.join(h.fixture.flowsDir, `${flowName}.yaml`);
            assert.equal(fs.readFileSync(target, 'utf8'), body);
        } finally {
            await h.stop();
        }
    });
}

// ---------------------------------------------------------------------------
// Reject: typos (case-sensitive lowercase-only)
// ---------------------------------------------------------------------------

test('PUT /flows/:name rejects approval typo "Auto" with 400 naming the step + value', async () => {
    const h = await makeHarness();
    try {
        const before = fs.readdirSync(h.fixture.flowsDir).sort();
        const body = bodyWithApproval('    approval: Auto\n');
        const res = await fetch(`${h.baseUrl}/flows/typo-auto`, {
            method: 'PUT',
            headers: YAML_HEADERS,
            body,
        });
        assert.equal(res.status, 400);
        const json = (await res.json()) as { error: string };
        // Message must name both the offending step id and the rejected value.
        assert.match(json.error, /gate/);
        assert.match(json.error, /Auto/);
        assert.match(json.error, /approval/);
        // No file written.
        assert.deepEqual(fs.readdirSync(h.fixture.flowsDir).sort(), before);
    } finally {
        await h.stop();
    }
});

test('PUT /flows/:name rejects approval typo "REQUIRED" (uppercase) with 400', async () => {
    const h = await makeHarness();
    try {
        const body = bodyWithApproval('    approval: REQUIRED\n');
        const res = await fetch(`${h.baseUrl}/flows/typo-upper`, {
            method: 'PUT',
            headers: YAML_HEADERS,
            body,
        });
        assert.equal(res.status, 400);
        const json = (await res.json()) as { error: string };
        assert.match(json.error, /gate/);
        assert.match(json.error, /REQUIRED/);
    } finally {
        await h.stop();
    }
});

test('PUT /flows/:name rejects an unknown approval string with 400', async () => {
    const h = await makeHarness();
    try {
        const body = bodyWithApproval('    approval: maybe\n');
        const res = await fetch(`${h.baseUrl}/flows/typo-unknown`, {
            method: 'PUT',
            headers: YAML_HEADERS,
            body,
        });
        assert.equal(res.status, 400);
        const json = (await res.json()) as { error: string };
        assert.match(json.error, /gate/);
        assert.match(json.error, /maybe/);
    } finally {
        await h.stop();
    }
});

// ---------------------------------------------------------------------------
// Reject: wrong type (number / boolean — js-yaml parses these as non-strings)
// ---------------------------------------------------------------------------

test('PUT /flows/:name rejects a numeric approval value with 400', async () => {
    const h = await makeHarness();
    try {
        const body = bodyWithApproval('    approval: 1\n');
        const res = await fetch(`${h.baseUrl}/flows/wrong-type-number`, {
            method: 'PUT',
            headers: YAML_HEADERS,
            body,
        });
        assert.equal(res.status, 400);
        const json = (await res.json()) as { error: string };
        assert.match(json.error, /gate/);
        assert.match(json.error, /approval/);
    } finally {
        await h.stop();
    }
});

test('PUT /flows/:name rejects a boolean approval value with 400', async () => {
    const h = await makeHarness();
    try {
        const body = bodyWithApproval('    approval: true\n');
        const res = await fetch(`${h.baseUrl}/flows/wrong-type-bool`, {
            method: 'PUT',
            headers: YAML_HEADERS,
            body,
        });
        assert.equal(res.status, 400);
        const json = (await res.json()) as { error: string };
        assert.match(json.error, /gate/);
        assert.match(json.error, /approval/);
    } finally {
        await h.stop();
    }
});
