/**
 * Ollama agent runner — cloud and local, one adapter.
 *
 * Composition over reimplementation, exactly as the DeepSeek adapter
 * does it: Ollama serves a subset of the Anthropic Messages API at
 * `/v1/messages` (https://docs.ollama.com/api/anthropic-compatibility),
 * so the `claude` CLI talks to it directly when pointed at the right
 * base URL and token. Stream parsing, lifecycle events, sidecar kill and
 * the `interruptById` contract all come from `ClaudeCliRunner` unchanged.
 *
 * Supported through that endpoint, per Ollama's docs: messages,
 * streaming, multi-turn, system prompts, tools (`tool_use` /
 * `tool_result`), base64 vision, and thinking blocks with
 * `output_config.effort`. Not supported: `/v1/messages/count_tokens`,
 * batches, `tool_choice`, prompt caching, citations, URL images, and
 * streaming `error` events.
 *
 * ## Why the auth header is the one detail to get right
 *
 * The Ollama cloud endpoint does NOT accept `x-api-key` alone — it wants
 * `Authorization: Bearer`. The `claude` CLI sends `x-api-key` for
 * `ANTHROPIC_API_KEY` and Bearer for `ANTHROPIC_AUTH_TOKEN`, so this
 * overlay sets the latter. Getting it the other way round produces a 401
 * against a perfectly configured server.
 *
 * ## And why `ANTHROPIC_API_KEY` is actively REMOVED
 *
 * A worker configured for claude-cli very likely has a real Anthropic
 * key in its environment. Inherited into a run pointed at `ollama.com`,
 * the CLI would attach that key as `x-api-key` to every request to a
 * third party. Ollama ignores it for authentication, which is not the
 * same as not receiving it. So the overlay deletes it rather than
 * leaving it to chance — the repo's rule is that a secret never appears
 * anywhere it was not meant for.
 *
 * (The DeepSeek adapter has the same exposure for the same reason: it
 * layers `ANTHROPIC_AUTH_TOKEN` on and leaves `ANTHROPIC_API_KEY`
 * alone. Flagged rather than changed here — that adapter's env handling
 * is someone's working setup.)
 *
 * ## The unsupported-endpoint env trio
 *
 * Claude Code probes `/v1/messages/count_tokens?beta=true` and its
 * telemetry endpoints; Ollama 404s all of them. On the local server that
 * has been reported to degrade into 500s and an unresponsive daemon
 * (ollama/ollama#13949, open across 0.15.2 → 0.32.14). The three
 * DISABLE_* keys below stop the pipeline making those calls at all. They
 * are set here rather than left to operator discipline because the
 * failure they prevent is a wedged worker mid-task.
 *
 * ## Models are REQUIRED, never guessed
 *
 * There is no canonical Ollama model to default to: the tag has to be
 * one the operator actually pulled (local) or one the cloud serves, and
 * inventing a plausible-looking tag would 404 at spawn. So the factory
 * refuses to build this provider without `OLLAMA_MODEL`, the same way
 * the DeepSeek branch refuses without an API key, and `claude-*` ids
 * arriving from `pipeline.yaml default_models` are stripped so they
 * cannot reach a model registry that has never heard of them.
 *
 * ## The `:cloud` suffix is a CLI convention, not a model name
 *
 * ollama.com shows every hosted model as `<name>:cloud` — that is what
 * `ollama run` and the desktop app want, and therefore what an operator
 * copies off the website. The hosted API serves no such name: its
 * `/api/tags` lists `mistral-large-4`, `gemma4:31b`, `glm-5.3`, and the
 * docs say to use "the name returned by this list". `:cloud` is how the
 * LOCAL daemon says "proxy this one upstream", so it is right for the
 * `ollama` provider and wrong for `ollama-cloud` — where it produces
 * "that model may not exist or you may not have access to it", which
 * reads like a billing problem and is really a naming convention.
 *
 * So the cloud flavour rewrites it, at every door a tag arrives through,
 * and says in the log that it did. See {@link stripCliCloudSuffix}.
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

/** Local daemon default (`ollama serve`). */
export const OLLAMA_DEFAULT_BASE_URL = 'http://localhost:11434';

/** Hosted default. The Anthropic-compatible path lives under this root. */
export const OLLAMA_CLOUD_BASE_URL = 'https://ollama.com';

/**
 * Token sent when none is configured. The local daemon does not validate
 * keys, so a placeholder is correct there — and sending *something*
 * keeps the CLI from falling back to an inherited credential.
 */
export const OLLAMA_PLACEHOLDER_TOKEN = 'ollama';

/**
 * Keys that stop Claude Code calling endpoints Ollama does not serve.
 * See the header note on ollama/ollama#13949.
 */
export const OLLAMA_DISABLED_TRAFFIC_ENV: Readonly<Record<string, string>> = {
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
};

/**
 * The suffix the Ollama CLI, desktop app and website use for a hosted
 * model. Not part of any name the hosted API serves.
 */
export const OLLAMA_CLI_CLOUD_SUFFIX = ':cloud';

/**
 * Translate a tag copied off ollama.com into the name the hosted API
 * actually serves: `mistral-large-4:cloud` → `mistral-large-4`.
 *
 * Only ever applied to the cloud flavour. On a local daemon `:cloud` is
 * meaningful — it is the tag that makes the daemon proxy upstream — so
 * stripping it there would switch a role from a hosted model to a local
 * one of the same name, or to nothing at all.
 */
export function stripCliCloudSuffix(tag: string): string {
    return tag.endsWith(OLLAMA_CLI_CLOUD_SUFFIX)
        ? tag.slice(0, -OLLAMA_CLI_CLOUD_SUFFIX.length)
        : tag;
}

export interface OllamaRunnerOptions
    extends Omit<ClaudeCliRunnerOptions, 'defaultModels'> {
    /**
     * The model tag every role falls back to — `qwen3-coder:30b`,
     * `gemma4:cloud`, … Required: see the header on why nothing is
     * guessed.
     */
    readonly model: string;
    /**
     * Base URL of the Ollama server. Defaults to the local daemon;
     * the cloud row passes {@link OLLAMA_CLOUD_BASE_URL}.
     */
    readonly baseUrl?: string;
    /**
     * True for the `ollama-cloud` provider. Separate from
     * {@link baseUrl} on purpose: an operator may point the cloud
     * provider at a gateway or proxy, so it is the PROVIDER, not the
     * host name, that decides whether `:cloud` tags are a CLI-ism to
     * rewrite. See {@link stripCliCloudSuffix}.
     */
    readonly cloud?: boolean;
    /**
     * API key. Required by the cloud endpoint, ignored by the local
     * daemon (which gets {@link OLLAMA_PLACEHOLDER_TOKEN} instead).
     * Write-only: it is never logged, and only its presence is reported.
     */
    readonly apiKey?: string;
    /**
     * Smaller/faster tag for the roles Claude Code resolves as "haiku"
     * and for its own subagents. Defaults to {@link model}, so a single
     * configured tag serves everything.
     */
    readonly smallModel?: string;
    /** Role → model tag overrides (`OLLAMA_MODEL_<ROLE>`). */
    readonly defaultModels?: Readonly<Record<string, string>>;
    /**
     * The server's configured context window in tokens
     * (`OLLAMA_CONTEXT_LENGTH` on the daemon), when the operator has
     * told us. Enables the prompt-budget check — see
     * {@link assessContextBudget} for why that check exists at all.
     */
    readonly contextTokens?: number;
}

/**
 * Rough prompt size in tokens. Deliberately crude — this guards against
 * being an order of magnitude over the window, not against being 5%
 * over, and a real tokeniser would be a dependency for no extra safety.
 */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

export interface ContextBudgetVerdict {
    readonly estimatedTokens: number;
    readonly contextTokens: number;
    /** True when the prompt cannot fit and the front WILL be dropped. */
    readonly overBudget: boolean;
    readonly message: string;
}

/**
 * Compare a prompt against the server's context window.
 *
 * Ollama does not reject an oversized prompt: it drops tokens from the
 * FRONT, keeps the tail and returns a normal 200. In this pipeline the
 * front of every task prompt is
 * `# !!! WORKSPACE BOUNDARIES — read this first !!!`, placed first on
 * purpose so the agent fixes its cwd and forbidden paths before reading
 * any persona or repo CLAUDE.md. Truncation therefore does not merely
 * degrade an answer — it silently removes the rail that keeps agents out
 * of the operator's personal checkouts and out of the shared clones.
 *
 * Reported at 80% of the window rather than 100%: the estimate is crude
 * and the reply shares the window with the prompt.
 */
export function assessContextBudget(input: {
    readonly prompt: string;
    readonly contextTokens: number;
    readonly role?: string;
}): ContextBudgetVerdict {
    const estimatedTokens = estimateTokens(input.prompt);
    const usable = Math.floor(input.contextTokens * 0.8);
    const overBudget = estimatedTokens > usable;
    const where = input.role ? ` for role "${input.role}"` : '';
    return {
        estimatedTokens,
        contextTokens: input.contextTokens,
        overBudget,
        message: overBudget
            ? `ollama: prompt${where} is ~${estimatedTokens} tokens against a`
                + ` ${input.contextTokens}-token context window. Ollama drops the`
                + ' FRONT of an oversized prompt and answers anyway, so the agent'
                + ' would run without its workspace-boundary block. Raise'
                + ' OLLAMA_CONTEXT_LENGTH on the server (and OLLAMA_CONTEXT_TOKENS'
                + ' here to match), or route this role to another provider.'
            : `ollama: prompt${where} ~${estimatedTokens} tokens of`
                + ` ${input.contextTokens} available.`,
    };
}

/**
 * Public `AgentRunner` for Ollama. The inner `ClaudeCliRunner` is
 * exposed so the orchestrator can wire its killer to the same
 * `interruptById` / sidecar contract — the spawned process is still
 * `claude`.
 */
export class OllamaRunner implements AgentRunner {
    readonly inner: ClaudeCliRunner;
    private readonly logger: Logger | undefined;
    private readonly contextTokens: number | undefined;
    private readonly cloud: boolean;
    /** Tags already reported as rewritten, so a per-spawn path logs once. */
    private readonly warnedCloudTags = new Set<string>();

    constructor(options: OllamaRunnerOptions) {
        this.logger = options.logger;
        this.contextTokens = options.contextTokens;
        this.cloud = options.cloud ?? false;

        const baseUrl = options.baseUrl ?? OLLAMA_DEFAULT_BASE_URL;
        const model = this.hostedTag(options.model, 'OLLAMA_MODEL');
        const smallModel = options.smallModel !== undefined
            ? this.hostedTag(options.smallModel, 'OLLAMA_SMALL_MODEL')
            : model;
        const token = options.apiKey && options.apiKey.length > 0
            ? options.apiKey
            : OLLAMA_PLACEHOLDER_TOKEN;

        // Key NAME only — never the value (repo rule), and the presence
        // flag is what an operator needs to debug a 401.
        this.logger?.info('ollama: runner configured', {
            baseUrl,
            model,
            smallModel,
            apiKey: options.apiKey && options.apiKey.length > 0
                ? 'OLLAMA_API_KEY (set)'
                : 'OLLAMA_API_KEY (unset — placeholder token)',
            contextTokens: options.contextTokens ?? null,
        });

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
            defaultModels: this.hostedTags(
                options.defaultModels ?? {},
                'OLLAMA_MODEL_<ROLE>',
            ),
            // Agents-panel per-role model override, consulted above the
            // env defaults and below an explicit flow step `model:`.
            // Wrapped rather than passed through: this is the door the
            // operator's own choice arrives through, so it is the one
            // that most needs the `:cloud` translation.
            ...(options.resolveDefaultModel !== undefined
                ? {
                    resolveDefaultModel: (role: string): string | undefined => {
                        const resolved = options.resolveDefaultModel!(role);
                        return typeof resolved === 'string' && resolved.length > 0
                            ? this.hostedTag(
                                resolved,
                                `the Agents panel record for "${role}"`,
                            )
                            : resolved;
                    },
                }
                : {}),
            env: (): NodeJS.ProcessEnv =>
                buildOllamaEnv({
                    baseUrl,
                    token,
                    model,
                    smallModel,
                    base: options.env?.() ?? process.env,
                }),
        };
        this.inner = new ClaudeCliRunner(innerOptions);
    }

    start(spec: AgentSpec): AgentHandle {
        if (this.contextTokens !== undefined && this.contextTokens > 0) {
            const verdict = assessContextBudget({
                prompt: spec.prompt,
                contextTokens: this.contextTokens,
                ...(spec.role ? { role: spec.role } : {}),
            });
            // Loud, with the numbers, because the alternative is an agent
            // that answers confidently from a prompt it only half read.
            // Advisory for now: the runner has no way to park a task, and
            // refusing to return a handle here would break the caller's
            // bookkeeping. The orchestrator-side gate is the follow-up.
            if (verdict.overBudget) this.logger?.error(verdict.message);
            else this.logger?.debug(verdict.message);
        }
        return this.inner.start(this.adjustSpec(spec));
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

    /**
     * The hosted-API form of one tag, with a note in the log when it
     * differs. A no-op for the local provider.
     *
     * Rewriting rather than refusing: `mistral-large-4:cloud` is not a
     * typo, it is the name ollama.com prints for a model the operator
     * genuinely selected, so the intent is unambiguous and the only
     * question is which naming convention reaches the wire. Parking a
     * task over a suffix would be theatre. Logged rather than silent,
     * because the Agents panel still shows the tag they picked.
     */
    private hostedTag(tag: string, source: string): string {
        if (!this.cloud) return tag;
        const hosted = stripCliCloudSuffix(tag);
        if (hosted === tag) return tag;
        if (!this.warnedCloudTags.has(tag)) {
            this.warnedCloudTags.add(tag);
            this.logger?.warn(
                `ollama-cloud: using model "${hosted}" for "${tag}" (from`
                + ` ${source}). The "${OLLAMA_CLI_CLOUD_SUFFIX}" suffix is an`
                + ' Ollama CLI and website convention; the hosted API serves the'
                + ' bare names listed by https://ollama.com/api/tags and rejects'
                + ' the suffixed form as a model you have no access to.',
            );
        }
        return hosted;
    }

    /** {@link hostedTag} across a role → tag map. */
    private hostedTags(
        models: Readonly<Record<string, string>>,
        source: string,
    ): Record<string, string> {
        const out: Record<string, string> = {};
        for (const [role, tag] of Object.entries(models)) {
            out[role] = this.hostedTag(tag, `${source} for "${role}"`);
        }
        return out;
    }

    /**
     * Fix up the per-spawn model id before it reaches the inner runner.
     *
     * Two corrections, both of a model string this runner cannot serve:
     *
     * `claude-*` ids are DROPPED. `pipeline.yaml default_models` and a
     * flow step's `model:` are written for the Anthropic ids; Ollama's
     * registry has never heard of them and would 404. Dropping the key
     * lets the resolution chain fall through to the configured tag.
     *
     * A `:cloud` suffix on the cloud provider is REWRITTEN, not dropped
     * (see {@link hostedTag}): dropping it would fall back to the global
     * tag and quietly run a different model than the step named.
     */
    private adjustSpec(spec: AgentSpec): AgentSpec {
        const original = spec.metadata ?? {};
        const rawModel = original.model;
        if (typeof rawModel !== 'string' || rawModel.length === 0) return spec;

        if (rawModel.startsWith('claude-')) {
            this.logger?.warn(
                `ollama: dropping claude-* model "${rawModel}" from spec.metadata so`
                + ' the configured Ollama tag applies. Set OLLAMA_MODEL_<ROLE> or'
                + ' pipeline.yaml default_models to an Ollama tag to pin one.',
            );
            const metadata = { ...original };
            delete metadata.model;
            return { ...spec, metadata };
        }

        const hosted = this.hostedTag(rawModel, 'the flow step or task record');
        if (hosted === rawModel) return spec;
        return { ...spec, metadata: { ...original, model: hosted } };
    }
}

/**
 * The env overlay handed to the `claude` CLI.
 *
 * Unlike the DeepSeek adapter's `setIfMissing` approach, the routing keys
 * here are set UNCONDITIONALLY. An inherited `ANTHROPIC_BASE_URL` from a
 * claude-cli or DeepSeek setup would otherwise silently redirect an
 * Ollama-routed role to a different provider — which looks like Ollama
 * returning someone else's model.
 */
export function buildOllamaEnv(input: {
    readonly baseUrl: string;
    readonly token: string;
    readonly model: string;
    readonly smallModel: string;
    readonly base: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
    const out: NodeJS.ProcessEnv = { ...input.base };

    // Bearer, not x-api-key: the cloud endpoint rejects the latter.
    out.ANTHROPIC_BASE_URL = input.baseUrl;
    out.ANTHROPIC_AUTH_TOKEN = input.token;

    // The operator's real Anthropic key must not travel to an Ollama
    // server. See the header note.
    delete out.ANTHROPIC_API_KEY;

    // Claude Code asks for its own aliases internally (opus / sonnet /
    // haiku / subagent). Every one has to resolve to a tag Ollama serves,
    // or a mid-run subagent spawn 404s on a model nobody configured.
    out.ANTHROPIC_MODEL = input.model;
    out.ANTHROPIC_DEFAULT_OPUS_MODEL = input.model;
    out.ANTHROPIC_DEFAULT_SONNET_MODEL = input.model;
    out.ANTHROPIC_DEFAULT_HAIKU_MODEL = input.smallModel;
    out.CLAUDE_CODE_SUBAGENT_MODEL = input.smallModel;

    for (const [key, value] of Object.entries(OLLAMA_DISABLED_TRAFFIC_ENV)) {
        out[key] = value;
    }

    // Effort is passed through untouched: Ollama accepts `thinking` and
    // `output_config.effort`, and a model without thinking ignores them.
    // (DeepSeek clamps instead, because it rejects low/medium outright.)
    return out;
}
