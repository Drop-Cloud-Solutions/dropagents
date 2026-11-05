/**
 * AP-VP4-012 — planner / decomposer default-model wiring.
 *
 * Confirms two things end-to-end:
 *
 *   1. config/pipeline.yaml exposes exactly ONE operator-editable model id
 *      (the global default), and no per-role pin for planner/decomposer.
 *      Per-role models moved to the Agents panel.
 *
 *   2. ClaudeCliRunner — fed the YAML's default_models map — resolves the
 *      `--model` arg for `planner` and `decomposer` roles from that global
 *      default, and lets an Agents-panel record outrank it, without any
 *      further code change. The existing role-routing matrix
 *      (developer/reviewer/tester/doc-writer) is covered in
 *      adapters/claude-cli/ClaudeCliRunner.test.ts; this file only adds the
 *      two new roles so a future regression on either side surfaces here.
 *
 * Environment-override behaviour:
 *
 *   - For `--model`, the resolution order (see ClaudeCliRunner.resolveModel)
 *     places defaultModels[role] AHEAD of env.CLAUDE_MODEL_<ROLE>. The env
 *     var is consulted as a fallback when no YAML default is in scope (e.g.
 *     a developer running the runner without a pipeline.yaml). The test
 *     below confirms that fallback path for the `planner` role.
 *
 *   - For `--effort`, there is no YAML default; CLAUDE_EFFORT_<ROLE>
 *     overrides the hardcoded 'medium' fallback. The test below confirms
 *     both CLAUDE_EFFORT_PLANNER and CLAUDE_EFFORT_DECOMPOSER take effect
 *     per the AP-VP4-012 brief.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import * as yaml from 'js-yaml';

import {
    ClaudeCliRunner,
    type EventPublisher,
    type SpawnImpl,
} from '../adapters/claude-cli/ClaudeCliRunner';
import type { Event } from '../core/events/event';

const PIPELINE_YAML = path.join(__dirname, 'pipeline.yaml');

interface PipelineYaml {
    default_models: Record<string, string>;
}

function loadDefaultModels(): Record<string, string> {
    const raw = fs.readFileSync(PIPELINE_YAML, 'utf8');
    const doc = yaml.load(raw) as PipelineYaml;
    return doc.default_models;
}

// ---------------------------------------------------------------------------
// Local spawn harness — mirrors the one in ClaudeCliRunner.test.ts but kept
// inline so this file stays self-contained and doesn't pull a runner-test
// helper into the config layer.
// ---------------------------------------------------------------------------

function recordingPublisher(): EventPublisher {
    return {
        async publish(_event: Event): Promise<unknown> {
            return undefined;
        },
    };
}

interface FakeChild extends EventEmitter {
    pid: number | undefined;
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
}

function fakeChild(): FakeChild {
    const child = new EventEmitter() as FakeChild;
    child.pid = 4242;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    return child;
}

interface SpawnHarness {
    spawnImpl: SpawnImpl;
    args: { cmd: string; args: readonly string[] }[];
}

function spawnHarness(): SpawnHarness {
    const args: { cmd: string; args: readonly string[] }[] = [];
    const spawnImpl: SpawnImpl = ((cmd: string, a: readonly string[]) => {
        args.push({ cmd, args: a });
        return fakeChild() as unknown as ReturnType<SpawnImpl>;
    }) as SpawnImpl;
    return { spawnImpl, args };
}

function tmpSidecarDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'planner-decomposer-test-'));
}

function argValue(harness: SpawnHarness, flag: string, index = 0): string {
    const args = harness.args[index].args;
    const i = args.indexOf(flag);
    assert.ok(i >= 0 && i + 1 < args.length, `${flag} arg missing`);
    return args[i + 1];
}

// ---------------------------------------------------------------------------
// (1) YAML loader exposes planner + decomposer with the documented model ids
// ---------------------------------------------------------------------------

// Value-agnostic on purpose: the operator edits the id in pipeline.yaml,
// so the suite asserts the key is present + non-empty and that the runner
// resolves to whatever the YAML says — not a pinned id that goes stale on
// the next model bump.
test('pipeline.yaml exposes a non-empty global default model', () => {
    const models = loadDefaultModels();
    assert.equal(typeof models.developer, 'string');
    assert.ok(models.developer.length > 0);
});

test('pipeline.yaml does NOT pin planner or decomposer', () => {
    // Both roles used to have their own YAML entry. They were removed
    // when per-role models moved to the Agents panel; asserting their
    // ABSENCE is what keeps the fallback path below load-bearing rather
    // than dead code that merely looks covered.
    const models = loadDefaultModels();
    assert.equal(models.planner, undefined);
    assert.equal(models.decomposer, undefined);
});

// ---------------------------------------------------------------------------
// (2) ClaudeCliRunner resolves both roles from the YAML without any further
//     code change — now via the global fallback rather than a per-role key.
// ---------------------------------------------------------------------------

for (const role of ['planner', 'decomposer'] as const) {
    test(`ClaudeCliRunner falls back to the global default for ${role}`, () => {
        const models = loadDefaultModels();
        const harness = spawnHarness();
        const runner = new ClaudeCliRunner({
            bus: recordingPublisher(),
            spawnImpl: harness.spawnImpl,
            sidecarDir: tmpSidecarDir(),
            env: () => ({}),
            defaultModels: models,
        });

        runner.start({ role, prompt: 'p' });
        assert.equal(argValue(harness, '--model'), models.developer);
    });

    test(`an Agents-panel record outranks the global default for ${role}`, () => {
        // This is the seam the operator actually uses to give a role its
        // own model now that the YAML no longer carries one.
        const harness = spawnHarness();
        const runner = new ClaudeCliRunner({
            bus: recordingPublisher(),
            spawnImpl: harness.spawnImpl,
            sidecarDir: tmpSidecarDir(),
            env: () => ({}),
            defaultModels: loadDefaultModels(),
            resolveDefaultModel: (r) => (r === role ? 'claude-from-panel' : undefined),
        });

        runner.start({ role, prompt: 'p' });
        assert.equal(argValue(harness, '--model'), 'claude-from-panel');
    });
}

// ---------------------------------------------------------------------------
// (3) Environment-override behaviour for planner / decomposer.
//
// `--model`: CLAUDE_MODEL_<ROLE> takes effect when no YAML default scopes
// the role. This is the path a developer hits running the runner without
// a pipeline.yaml in scope.
//
// `--effort`: CLAUDE_EFFORT_<ROLE> takes precedence over the hardcoded
// 'medium' default for both roles (there is no YAML default for effort).
// ---------------------------------------------------------------------------

test('CLAUDE_MODEL_PLANNER overrides the hardcoded fallback when default_models is empty', () => {
    const harness = spawnHarness();
    const runner = new ClaudeCliRunner({
        bus: recordingPublisher(),
        spawnImpl: harness.spawnImpl,
        sidecarDir: tmpSidecarDir(),
        env: () => ({ CLAUDE_MODEL_PLANNER: 'claude-env-planner' }),
        // defaultModels omitted entirely — env var is the only model source.
    });

    runner.start({ role: 'planner', prompt: 'p' });
    assert.equal(argValue(harness, '--model'), 'claude-env-planner');
});

test('CLAUDE_EFFORT_PLANNER overrides the hardcoded "medium" effort default', () => {
    const harness = spawnHarness();
    const runner = new ClaudeCliRunner({
        bus: recordingPublisher(),
        spawnImpl: harness.spawnImpl,
        sidecarDir: tmpSidecarDir(),
        env: () => ({ CLAUDE_EFFORT_PLANNER: 'high' }),
        defaultModels: loadDefaultModels(),
    });

    runner.start({ role: 'planner', prompt: 'p' });
    assert.equal(argValue(harness, '--effort'), 'high');
});

test('CLAUDE_EFFORT_DECOMPOSER overrides the hardcoded "medium" effort default', () => {
    const harness = spawnHarness();
    const runner = new ClaudeCliRunner({
        bus: recordingPublisher(),
        spawnImpl: harness.spawnImpl,
        sidecarDir: tmpSidecarDir(),
        env: () => ({ CLAUDE_EFFORT_DECOMPOSER: 'low' }),
        defaultModels: loadDefaultModels(),
    });

    runner.start({ role: 'decomposer', prompt: 'p' });
    assert.equal(argValue(harness, '--effort'), 'low');
});
