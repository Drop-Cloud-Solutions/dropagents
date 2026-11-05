/**
 * DeepSeek agent runner.
 *
 * Composition over reimplementation: DeepSeek ships an Anthropic-protocol
 * shim at `https://api.deepseek.com/anthropic`, so the existing `claude`
 * CLI talks to it directly when pointed at the right base URL + auth
 * token. We wrap a `ClaudeCliRunner` and overlay the
 * `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_MODEL` /
 * `CLAUDE_CODE_EFFORT_LEVEL` env keys the DeepSeek docs require
 * (https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code)
 * — every other concern (stream parsing, lifecycle event publish,
 * sidecar-based kill, killer port) reuses the claude-cli machinery
 * unchanged. Tool use, AgentProgress framing, AgentFinished content,
 * and CancelAgentRun all keep their semantics.
 *
 * Resolution of model + effort is delegated to the inner runner. The
 * wrapper layers a DeepSeek-specific role → model default map and clamps
 * effort to DeepSeek's only two supported values (`high` | `max`) before
 * the spec hits the inner runner — `low` / `medium` round up to `high`
 * with a warning. This keeps existing pipeline.yaml `default_models` and
 * `CLAUDE_EFFORT_<ROLE>` overrides honoured while preventing a
 * pre-DeepSeek flow file from spawning agents with an effort the
 * provider will reject.
 */

import type {
    AgentHandle,
    AgentRunner,
    AgentSpec,
    Logger,
} from '../../core/ports';
import {
    ClaudeCliRunner,
    type ClaudeCliRunnerOptions,
    type EventPublisher,
} from '../claude-cli/ClaudeCliRunner';

/** Canonical DeepSeek base URL (Anthropic-protocol shim). */
export const DEEPSEEK_DEFAULT_BASE_URL = 'https://api.deepseek.com/anthropic';

/** DeepSeek's two model ids, per the chat-completion API docs. */
export const DEEPSEEK_MODEL_PRO = 'deepseek-v4-pro';
export const DEEPSEEK_MODEL_FLASH = 'deepseek-v4-flash';

/**
 * Role → model defaults applied when nothing more specific (FlowStep
 * `model`, `defaultModels` override, env var) was set. Heavy / reasoning
 * roles get pro; cheaper tail-end roles get flash.
 */
export const DEEPSEEK_ROLE_DEFAULTS: Readonly<Record<string, string>> = {
    developer: DEEPSEEK_MODEL_PRO,
    reviewer: DEEPSEEK_MODEL_PRO,
    planner: DEEPSEEK_MODEL_PRO,
    decomposer: DEEPSEEK_MODEL_PRO,
    tester: DEEPSEEK_MODEL_FLASH,
    committer: DEEPSEEK_MODEL_FLASH,
};

/** DeepSeek accepts only these two effort values. */
const DEEPSEEK_ALLOWED_EFFORTS = new Set(['high', 'max']);

export interface DeepSeekRunnerOptions
    extends Omit<ClaudeCliRunnerOptions, 'defaultModels'> {
    /** DeepSeek API key. Forwarded as `ANTHROPIC_AUTH_TOKEN`. */
    readonly apiKey: string;
    /** Override the base URL (e.g. for a test fixture). Defaults to the
     *  public DeepSeek Anthropic shim. */
    readonly baseUrl?: string;
    /** Default effort when no role-specific value is set. Clamped to
     *  `high` | `max`; anything else rounds up to `high`. Defaults to
     *  `max` so heavy roles get DeepSeek's deepest reasoning by default. */
    readonly defaultEffort?: string;
    /**
     * Role → model override map. Same shape and precedence the inner
     * `ClaudeCliRunner` uses; the deepseek role defaults are unioned
     * underneath so a partial map (e.g. just `developer`) still works.
     */
    readonly defaultModels?: Readonly<Record<string, string>>;
}

/**
 * Public `AgentRunner` for DeepSeek. The inner `ClaudeCliRunner` is
 * exposed as a read-only field so the orchestrator host can wire its
 * `AgentRunKiller` adapter directly — the kill path goes through the
 * same `interruptById` / sidecar contract claude-cli uses.
 */
export class DeepSeekRunner implements AgentRunner {
    readonly inner: ClaudeCliRunner;
    private readonly logger: Logger | undefined;
    private readonly defaultEffort: string;

    constructor(options: DeepSeekRunnerOptions) {
        this.logger = options.logger;
        this.defaultEffort = clampEffort(
            options.defaultEffort ?? 'max',
            this.logger,
            'DEEPSEEK_EFFORT_DEFAULT',
        );

        const baseUrl = options.baseUrl ?? DEEPSEEK_DEFAULT_BASE_URL;
        const defaultModels: Readonly<Record<string, string>> = {
            ...DEEPSEEK_ROLE_DEFAULTS,
            ...(options.defaultModels ?? {}),
        };
        const innerOptions: ClaudeCliRunnerOptions = {
            bus: options.bus as EventPublisher,
            ...(options.logger !== undefined ? { logger: options.logger } : {}),
            ...(options.clock !== undefined ? { clock: options.clock } : {}),
            ...(options.newId !== undefined ? { newId: options.newId } : {}),
            ...(options.spawnImpl !== undefined
                ? { spawnImpl: options.spawnImpl }
                : {}),
            ...(options.killer !== undefined ? { killer: options.killer } : {}),
            ...(options.sidecarDir !== undefined
                ? { sidecarDir: options.sidecarDir }
                : {}),
            ...(options.stderrTailBytes !== undefined
                ? { stderrTailBytes: options.stderrTailBytes }
                : {}),
            defaultModels,
            // Option B: per-role model override (Agents panel) also applies to
            // DeepSeek runs — the inner ClaudeCliRunner consults it above the
            // deepseek role defaults but below an explicit flow step.model.
            ...(options.resolveDefaultModel !== undefined
                ? { resolveDefaultModel: options.resolveDefaultModel }
                : {}),
            env: (): NodeJS.ProcessEnv =>
                buildDeepSeekEnv({
                    apiKey: options.apiKey,
                    baseUrl,
                    defaultEffort: this.defaultEffort,
                    base: options.env?.() ?? process.env,
                }),
        };
        this.inner = new ClaudeCliRunner(innerOptions);
    }

    start(spec: AgentSpec): AgentHandle {
        // Clamp any FlowStep-supplied `effort` to a DeepSeek-allowed
        // value before it reaches the inner runner. We can't intercept
        // the env-var resolution path inside ClaudeCliRunner without
        // editing it, but we can ensure the metadata branch (which
        // wins precedence) carries a safe value. Env-var-sourced
        // effort is already clamped via `buildDeepSeekEnv`.
        const adjusted = this.adjustSpec(spec);
        return this.inner.start(adjusted);
    }

    async interrupt(handle: AgentHandle): Promise<void> {
        await this.inner.interrupt(handle);
    }

    /** Bridges the same port `ClaudeCliAgentRunKiller` consumes. */
    async interruptById(runId: string): Promise<void> {
        await this.inner.interruptById(runId);
    }

    killedSidecarPath(agentId: string): string {
        return this.inner.killedSidecarPath(agentId);
    }

    private adjustSpec(spec: AgentSpec): AgentSpec {
        const original = spec.metadata ?? {};
        let metadata: Record<string, unknown> | null = null;

        // Strip claude-* model ids stamped on by pipeline.yaml's
        // `default_models` (or a per-FlowStep `model:`). The Anthropic
        // shim on DeepSeek does not alias `claude-opus-4-7` /
        // `claude-sonnet-4-6` server-side — the literal id reaches its
        // model registry and 404s. Removing the metadata key lets the
        // inner runner's resolution chain fall through to the DeepSeek
        // role defaults (`deepseek-v4-pro` / `deepseek-v4-flash`).
        // Operator-supplied DeepSeek model ids (anything not starting
        // with `claude-`) pass through unchanged.
        const rawModel = original.model;
        if (typeof rawModel === 'string' && rawModel.startsWith('claude-')) {
            this.logger?.warn(
                `deepseek: dropping claude-* model "${rawModel}" from spec.metadata so the DeepSeek role default applies. Set DEEPSEEK_MODEL_<ROLE> or pipeline.yaml default_models to a deepseek-v4-* id to pin a specific model.`,
            );
            metadata = { ...original };
            delete metadata.model;
        }

        const rawEffort = original.effort;
        if (typeof rawEffort === 'string' && rawEffort.length > 0) {
            const clamped = clampEffort(
                rawEffort,
                this.logger,
                'spec.metadata.effort',
            );
            if (clamped !== rawEffort) {
                metadata = { ...(metadata ?? original), effort: clamped };
            }
        }

        if (metadata === null) return spec;
        return { ...spec, metadata };
    }
}

/**
 * Produce the env block the inner `ClaudeCliRunner` should see when it
 * spawns the `claude` CLI. The eight DeepSeek keys are layered on top
 * of the caller-supplied base so a pre-set value (e.g. an operator
 * temporarily aiming `ANTHROPIC_BASE_URL` somewhere else) is preserved
 * — useful for proxy / sidecar setups. `CLAUDE_EFFORT_DEFAULT` is also
 * clamped so the inner runner's effort-resolution chain can't fall back
 * to a value DeepSeek will reject.
 */
export function buildDeepSeekEnv(input: {
    readonly apiKey: string;
    readonly baseUrl: string;
    readonly defaultEffort: string;
    readonly base: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
    const out: NodeJS.ProcessEnv = { ...input.base };
    setIfMissing(out, 'ANTHROPIC_BASE_URL', input.baseUrl);
    setIfMissing(out, 'ANTHROPIC_AUTH_TOKEN', input.apiKey);

    // The operator's own Anthropic key must not travel to DeepSeek.
    //
    // `ANTHROPIC_API_KEY` is a documented setting in this install
    // (.env.example, the Settings UI) and `ClaudeCliRunner` snapshots it
    // from process.env on every spawn, so a worker configured for
    // claude-cli has it set. Inherited into a run pointed at
    // api.deepseek.com, the CLI attaches it as `x-api-key` to a third
    // party on every request. DeepSeek authenticates from
    // ANTHROPIC_AUTH_TOKEN above and ignores the key for auth, which is
    // not the same as not receiving it.
    //
    // Deleted rather than left to `setIfMissing`: there is no reading of
    // this value that belongs in a DeepSeek request, so it is removed
    // unconditionally. (The same deletion, with the longer rationale,
    // lives in `adapters/ollama/OllamaRunner.ts`.)
    delete out.ANTHROPIC_API_KEY;
    setIfMissing(out, 'ANTHROPIC_MODEL', DEEPSEEK_MODEL_PRO);
    setIfMissing(out, 'ANTHROPIC_DEFAULT_OPUS_MODEL', DEEPSEEK_MODEL_PRO);
    setIfMissing(out, 'ANTHROPIC_DEFAULT_SONNET_MODEL', DEEPSEEK_MODEL_PRO);
    setIfMissing(out, 'ANTHROPIC_DEFAULT_HAIKU_MODEL', DEEPSEEK_MODEL_FLASH);
    setIfMissing(out, 'CLAUDE_CODE_SUBAGENT_MODEL', DEEPSEEK_MODEL_FLASH);
    setIfMissing(out, 'CLAUDE_CODE_EFFORT_LEVEL', input.defaultEffort);
    // Clamp the inner runner's role / global effort fallback so a
    // CLAUDE_EFFORT=medium left over from a claude-cli setup does not
    // produce a `--effort medium` arg DeepSeek refuses.
    clampEffortEnvVar(out, 'CLAUDE_EFFORT_DEFAULT', input.defaultEffort);
    clampEffortEnvVar(out, 'CLAUDE_EFFORT', input.defaultEffort);
    for (const key of Object.keys(out)) {
        if (!key.startsWith('CLAUDE_EFFORT_')) continue;
        if (key === 'CLAUDE_EFFORT_DEFAULT') continue;
        clampEffortEnvVar(out, key, input.defaultEffort);
    }
    return out;
}

function clampEffort(
    value: string,
    logger: Logger | undefined,
    source: string,
): string {
    const normalized = value.toLowerCase();
    if (DEEPSEEK_ALLOWED_EFFORTS.has(normalized)) return normalized;
    logger?.warn(
        `deepseek: effort "${value}" from ${source} is not supported (allowed: high|max); rounding up to "high".`,
    );
    return 'high';
}

function clampEffortEnvVar(
    env: NodeJS.ProcessEnv,
    key: string,
    fallback: string,
): void {
    const raw = env[key];
    if (typeof raw !== 'string' || raw.length === 0) return;
    const normalized = raw.toLowerCase();
    if (DEEPSEEK_ALLOWED_EFFORTS.has(normalized)) {
        env[key] = normalized;
        return;
    }
    env[key] = fallback;
}

function setIfMissing(
    env: NodeJS.ProcessEnv,
    key: string,
    value: string,
): void {
    if (typeof env[key] === 'string' && (env[key] as string).length > 0) return;
    env[key] = value;
}
