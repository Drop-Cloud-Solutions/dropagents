/**
 * Ollama runner: the env overlay, the model aliasing, and the two things
 * that would fail confusingly if they were wrong.
 *
 * Operator request: "both, cloud first" — one adapter serving Ollama
 * Cloud and a local daemon through their Anthropic-compatible
 * `/v1/messages` endpoint.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type * as child_process from 'node:child_process';

import type { Event } from '../../core/events/event';
import type { SpawnImpl } from '../claude-cli/ClaudeCliRunner';
import {
    OLLAMA_CLI_CLOUD_SUFFIX,
    OLLAMA_CLOUD_BASE_URL,
    OLLAMA_DEFAULT_BASE_URL,
    OLLAMA_DISABLED_TRAFFIC_ENV,
    OLLAMA_PLACEHOLDER_TOKEN,
    OllamaRunner,
    type OllamaRunnerOptions,
    assessContextBudget,
    buildOllamaEnv,
    estimateTokens,
    stripCliCloudSuffix,
} from './OllamaRunner';

const BASE: NodeJS.ProcessEnv = { PATH: '/usr/bin' };

function envFor(over: Partial<Parameters<typeof buildOllamaEnv>[0]> = {}): NodeJS.ProcessEnv {
    return buildOllamaEnv({
        baseUrl: OLLAMA_CLOUD_BASE_URL,
        token: 'tok-abc',
        model: 'gemma4:cloud',
        smallModel: 'gemma4:cloud',
        base: BASE,
        ...over,
    });
}

// --- auth: the detail that silently 401s if reversed -------------------

test('the token goes on ANTHROPIC_AUTH_TOKEN, never ANTHROPIC_API_KEY', () => {
    // The cloud endpoint does not accept `x-api-key` alone. The claude
    // CLI sends x-api-key for ANTHROPIC_API_KEY and Bearer for
    // ANTHROPIC_AUTH_TOKEN, so only the latter authenticates here.
    const env = envFor();
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'tok-abc');
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
});

test("an inherited Anthropic key is REMOVED, not passed to Ollama", () => {
    // A worker configured for claude-cli has a real Anthropic key in its
    // environment. Inherited into a run pointed at ollama.com, the CLI
    // would attach it as x-api-key to a third party on every request.
    // Ollama ignoring it for auth is not the same as not receiving it.
    const env = envFor({
        base: { ...BASE, ANTHROPIC_API_KEY: 'sk-ant-real-key' },
    });
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.ok(
        !Object.values(env).includes('sk-ant-real-key'),
        'the inherited key must not survive anywhere in the overlay',
    );
});

test('an inherited base URL or token does NOT win', () => {
    // DeepSeek's overlay uses set-if-missing, which would let a leftover
    // ANTHROPIC_BASE_URL from another provider silently redirect an
    // Ollama-routed role — and that looks like Ollama serving someone
    // else's model.
    const env = envFor({
        base: {
            ...BASE,
            ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
            ANTHROPIC_AUTH_TOKEN: 'someone-elses-token',
        },
    });
    assert.equal(env.ANTHROPIC_BASE_URL, OLLAMA_CLOUD_BASE_URL);
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'tok-abc');
});

// --- model aliasing ---------------------------------------------------

test('every model alias the CLI resolves internally points at a real tag', () => {
    // Claude Code asks for opus / sonnet / haiku / subagent by name. Any
    // one left unmapped 404s at Ollama mid-run — typically when it spawns
    // a subagent, which is the worst moment to discover it.
    const env = envFor({ model: 'qwen3-coder:30b', smallModel: 'qwen3:4b' });
    assert.equal(env.ANTHROPIC_MODEL, 'qwen3-coder:30b');
    assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'qwen3-coder:30b');
    assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'qwen3-coder:30b');
    assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'qwen3:4b');
    assert.equal(env.CLAUDE_CODE_SUBAGENT_MODEL, 'qwen3:4b');
});

// --- the unsupported-endpoint trio ------------------------------------

test('the endpoints Ollama does not serve are disabled', () => {
    // count_tokens and the telemetry paths 404, and on the local daemon
    // that has been reported to degrade into 500s and an unresponsive
    // server (ollama/ollama#13949).
    const env = envFor();
    for (const [key, value] of Object.entries(OLLAMA_DISABLED_TRAFFIC_ENV)) {
        assert.equal(env[key], value, `${key} must be set`);
    }
});

test('effort is passed through rather than clamped', () => {
    // Ollama accepts thinking + output_config.effort; a model without
    // thinking ignores them. DeepSeek clamps because it rejects
    // low/medium outright — Ollama has no such restriction, so a
    // leftover CLAUDE_EFFORT must survive untouched.
    const env = envFor({ base: { ...BASE, CLAUDE_EFFORT: 'medium' } });
    assert.equal(env.CLAUDE_EFFORT, 'medium');
});

// --- local vs cloud ---------------------------------------------------

test('the local daemon gets a placeholder token', () => {
    // It does not validate keys, and sending something keeps the CLI from
    // reaching for an inherited credential.
    const env = envFor({
        baseUrl: OLLAMA_DEFAULT_BASE_URL,
        token: OLLAMA_PLACEHOLDER_TOKEN,
    });
    assert.equal(env.ANTHROPIC_BASE_URL, 'http://localhost:11434');
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'ollama');
});

// --- the context-window guard -----------------------------------------

test('a prompt that fits is reported as fitting', () => {
    const v = assessContextBudget({ prompt: 'x'.repeat(400), contextTokens: 8192 });
    assert.equal(v.overBudget, false);
    assert.equal(v.estimatedTokens, 100);
});

test('an oversized prompt names the real hazard, not just a number', () => {
    // Ollama drops the FRONT and answers anyway, and the front of every
    // task prompt here is the workspace-boundary block. The message has
    // to say that, because "prompt too long" reads as a quality problem
    // rather than a safety one.
    const v = assessContextBudget({
        prompt: 'x'.repeat(200_000),
        contextTokens: 4096,
        role: 'developer',
    });
    assert.equal(v.overBudget, true);
    assert.match(v.message, /drops the FRONT/);
    assert.match(v.message, /workspace-boundary block/);
    assert.match(v.message, /OLLAMA_CONTEXT_LENGTH/);
    assert.match(v.message, /developer/);
});

test('the budget leaves headroom rather than filling the window', () => {
    // 80%: the estimate is crude and the reply shares the window.
    const contextTokens = 1000;
    const justUnder = assessContextBudget({
        prompt: 'x'.repeat(4 * 800),
        contextTokens,
    });
    const justOver = assessContextBudget({
        prompt: 'x'.repeat(4 * 801),
        contextTokens,
    });
    assert.equal(justUnder.overBudget, false);
    assert.equal(justOver.overBudget, true);
});

test('estimateTokens is a four-chars-per-token approximation', () => {
    assert.equal(estimateTokens(''), 0);
    assert.equal(estimateTokens('abcd'), 1);
    assert.equal(estimateTokens('abcde'), 2);
});

// --- spec adjustment --------------------------------------------------

/**
 * Child-process stand-in, same shape the DeepSeek runner's tests use:
 * real streams, because the runner writes the prompt to stdin and
 * subscribes to stdout.
 */
function fakeChild(): EventEmitter & {
    pid: number | undefined;
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
} {
    const child = new EventEmitter() as EventEmitter & {
        pid: number | undefined;
        stdin: PassThrough;
        stdout: PassThrough;
        stderr: PassThrough;
    };
    child.pid = 4242;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    return child;
}

/** Records what the inner runner was asked to spawn, env included. */
function captureRunner(
    baseEnv?: NodeJS.ProcessEnv,
    extra?: Partial<OllamaRunnerOptions>,
): {
    readonly runner: OllamaRunner;
    readonly commands: Array<{
        cmd: string;
        args: readonly string[];
        env: NodeJS.ProcessEnv;
    }>;
    readonly errors: string[];
    readonly warnings: string[];
} {
    const commands: Array<{
        cmd: string;
        args: readonly string[];
        env: NodeJS.ProcessEnv;
    }> = [];
    const errors: string[] = [];
    const warnings: string[] = [];
    const spawnImpl: SpawnImpl = ((
        cmd: string,
        args: readonly string[],
        opts: child_process.SpawnOptions,
    ) => {
        commands.push({
            cmd,
            args,
            env: (opts?.env ?? {}) as NodeJS.ProcessEnv,
        });
        return fakeChild() as unknown as ReturnType<SpawnImpl>;
    }) as SpawnImpl;
    const runner = new OllamaRunner({
        bus: { publish: async (_e: Event): Promise<unknown> => undefined },
        model: 'qwen3-coder:30b',
        contextTokens: 8192,
        logger: {
            info: (): void => {},
            warn: (m: string): void => { warnings.push(m); },
            error: (m: string): void => { errors.push(m); },
            debug: (): void => {},
        },
        ...(baseEnv !== undefined ? { env: (): NodeJS.ProcessEnv => baseEnv } : {}),
        spawnImpl,
        ...(extra ?? {}),
    });
    return { runner, commands, errors, warnings };
}

/**
 * Only this adapter's warnings. The inner `ClaudeCliRunner` warns too
 * (the "NO repo — empty scratch cwd" line, since these specs carry no
 * worktree), and counting its lines as ours would make the assertions
 * below pass or fail for reasons that have nothing to do with models.
 */
const ollamaWarnings = (lines: readonly string[]): string[] =>
    lines.filter((line) => line.startsWith('ollama'));

test('through the real runner, an inherited Anthropic key never reaches the CLI', () => {
    // The pure overlay is covered above; this proves the wiring, which is
    // where a `setIfMissing` style mistake would actually bite.
    const { runner, commands } = captureRunner({
        PATH: '/usr/bin',
        ANTHROPIC_API_KEY: 'sk-ant-real-key',
        ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
    });
    runner.start({ role: 'developer', prompt: 'hi' });
    const env = commands[0]?.env ?? {};
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.equal(env.ANTHROPIC_BASE_URL, OLLAMA_DEFAULT_BASE_URL);
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, OLLAMA_PLACEHOLDER_TOKEN);
    assert.ok(!Object.values(env).includes('sk-ant-real-key'));
});

test('a claude-* model id from pipeline.yaml is dropped before spawn', () => {
    // Ollama's registry has never heard of `claude-opus-5`; passing it
    // through 404s. Dropping it lets the configured Ollama tag apply.
    const { runner, commands } = captureRunner();
    runner.start({
        role: 'developer',
        prompt: 'hi',
        metadata: { model: 'claude-opus-5', taskId: 'T-1' },
    });
    const spawned = commands[0];
    assert.ok(spawned, 'the inner runner spawned');
    assert.ok(
        !spawned.args.includes('claude-opus-5'),
        `claude-* id reached the CLI: ${spawned.args.join(' ')}`,
    );
});

test('an Ollama tag in the spec is left alone', () => {
    const { runner, commands } = captureRunner();
    runner.start({
        role: 'developer',
        prompt: 'hi',
        metadata: { model: 'devstral:24b', taskId: 'T-1' },
    });
    assert.ok(
        commands[0]?.args.includes('devstral:24b'),
        `expected the operator tag to survive: ${commands[0]?.args.join(' ')}`,
    );
});

// --- the `:cloud` suffix ----------------------------------------------
//
// Field report: the operator picked `ollama-cloud` + `mistral-large-4:cloud`
// in the Agents panel and the agent came back with "There's an issue with
// the selected model (mistral-large-4:cloud). It may not exist or you may
// not have access to it."
//
// It exists and they have access. `:cloud` is what ollama.com DISPLAYS and
// what `ollama run` wants; the hosted API serves bare names — a live
// https://ollama.com/api/tags at the time of writing lists
// `mistral-large-4`, `gemma4:31b`, `glm-5.3` and NOT one name containing
// `:cloud`. Two naming conventions for the same model, and the website
// shows the one the API rejects.

test('stripCliCloudSuffix translates a website tag to an API name', () => {
    assert.equal(stripCliCloudSuffix('mistral-large-4:cloud'), 'mistral-large-4');
    assert.equal(stripCliCloudSuffix('gemma4:cloud'), 'gemma4');
    // Names the API actually serves are untouched, including ones with a
    // size tag that merely looks like a suffix.
    assert.equal(stripCliCloudSuffix('gemma4:31b'), 'gemma4:31b');
    assert.equal(stripCliCloudSuffix('mistral-large-4'), 'mistral-large-4');
    assert.equal(stripCliCloudSuffix('qwen3-coder:30b'), 'qwen3-coder:30b');
    // Only a real suffix: `:cloudy` is somebody's tag, not our convention.
    assert.equal(stripCliCloudSuffix('weird:cloudy'), 'weird:cloudy');
    assert.equal(OLLAMA_CLI_CLOUD_SUFFIX, ':cloud');
});

test('the Agents-panel model reaches the cloud CLI without the :cloud suffix', () => {
    // THE field bug. The Agents panel is the door the operator's own
    // choice comes through, so it is the one that has to translate.
    const { runner, commands, warnings } = captureRunner(undefined, {
        cloud: true,
        baseUrl: OLLAMA_CLOUD_BASE_URL,
        apiKey: 'key-1',
        resolveDefaultModel: (role) =>
            (role === 'doc-writer' ? 'mistral-large-4:cloud' : undefined),
    });
    runner.start({ role: 'doc-writer', prompt: 'write it up' });
    const args = commands[0]?.args ?? [];
    assert.ok(
        args.includes('mistral-large-4'),
        `expected the hosted name on the command line: ${args.join(' ')}`,
    );
    assert.ok(
        !args.includes('mistral-large-4:cloud'),
        `the CLI form must not reach the hosted API: ${args.join(' ')}`,
    );
    // Not silent: the panel still shows the tag they picked, so the log
    // has to explain the difference and name both forms.
    const reported = ollamaWarnings(warnings);
    assert.equal(reported.length, 1, 'reported exactly once');
    assert.match(reported[0], /mistral-large-4:cloud/);
    assert.match(reported[0], /mistral-large-4"/);
    assert.match(reported[0], /ollama\.com\/api\/tags/);
});

test('a :cloud tag survives on the LOCAL provider', () => {
    // On a local daemon `:cloud` is not a typo, it is the tag that makes
    // the daemon proxy upstream. Stripping it there would switch the role
    // to a local model of the same name, or to nothing at all.
    const { runner, commands, warnings } = captureRunner(undefined, {
        model: 'mistral-large-4:cloud',
        resolveDefaultModel: () => 'mistral-large-4:cloud',
    });
    runner.start({ role: 'doc-writer', prompt: 'hi' });
    const spawned = commands[0];
    assert.ok(
        spawned?.args.includes('mistral-large-4:cloud'),
        `expected the local proxy tag intact: ${spawned?.args.join(' ')}`,
    );
    assert.equal(spawned?.env.ANTHROPIC_MODEL, 'mistral-large-4:cloud');
    assert.deepEqual(
        ollamaWarnings(warnings),
        [],
        'nothing to report on the local provider',
    );
});

test('the cloud overlay carries hosted names for every model alias', () => {
    // The env aliases matter as much as --model: a mid-run subagent spawn
    // resolves ANTHROPIC_DEFAULT_HAIKU_MODEL / CLAUDE_CODE_SUBAGENT_MODEL,
    // and a :cloud name there 404s at the worst possible moment.
    const { runner, commands } = captureRunner(undefined, {
        cloud: true,
        baseUrl: OLLAMA_CLOUD_BASE_URL,
        apiKey: 'key-1',
        model: 'mistral-large-4:cloud',
        smallModel: 'gemma4:cloud',
    });
    runner.start({ role: 'developer', prompt: 'hi' });
    const env = commands[0]?.env ?? {};
    assert.equal(env.ANTHROPIC_MODEL, 'mistral-large-4');
    assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'mistral-large-4');
    assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'mistral-large-4');
    assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'gemma4');
    assert.equal(env.CLAUDE_CODE_SUBAGENT_MODEL, 'gemma4');
    assert.ok(
        !Object.values(env).some((v) => typeof v === 'string' && v.endsWith(':cloud')),
        'no CLI-form tag anywhere in the overlay',
    );
});

test('a :cloud tag from a flow step is REWRITTEN, not dropped', () => {
    // The claude-* path drops the id so the configured tag applies. Doing
    // that here would quietly run the global model instead of the one the
    // step named — a silent substitution, which is worse than a 404.
    const { runner, commands } = captureRunner(undefined, {
        cloud: true,
        baseUrl: OLLAMA_CLOUD_BASE_URL,
        apiKey: 'key-1',
        model: 'gemma4:31b',
    });
    runner.start({
        role: 'developer',
        prompt: 'hi',
        metadata: { model: 'mistral-large-4:cloud', taskId: 'T-1' },
    });
    const args = commands[0]?.args ?? [];
    assert.ok(
        args.includes('mistral-large-4'),
        `the step's model must still apply: ${args.join(' ')}`,
    );
    assert.ok(!args.includes('gemma4:31b'), 'must not fall back to the global tag');
});

test('a claude-* id is still dropped on the cloud provider', () => {
    // The two corrections in adjustSpec are independent; this pins that
    // adding the second did not shadow the first.
    const { runner, commands } = captureRunner(undefined, {
        cloud: true,
        baseUrl: OLLAMA_CLOUD_BASE_URL,
        apiKey: 'key-1',
    });
    runner.start({
        role: 'developer',
        prompt: 'hi',
        metadata: { model: 'claude-opus-5', taskId: 'T-1' },
    });
    assert.ok(!(commands[0]?.args ?? []).includes('claude-opus-5'));
});

test('an over-budget prompt is reported at error level before spawning', () => {
    const { runner, errors } = captureRunner();
    runner.start({ role: 'tester', prompt: 'x'.repeat(200_000) });
    assert.equal(errors.length, 1, 'exactly one loud report');
    assert.match(errors[0], /drops the FRONT/);
});
