/**
 * The agent-provider vocabulary: which LLM backends a role can be routed
 * through, in ONE place.
 *
 * It was in eight. Adding a provider meant editing all of them, and
 * missing one failed quietly in a different way each time:
 *
 *   - `type RunnerKind`, `readRunnerKind`, the inline `!==` chain inside
 *     `readRoleAdapterOverrides`, `VALID_PROVIDERS` and the
 *     `buildRunnerByKind` branches (hosts/orchestrator/main.ts);
 *   - `AGENT_PROVIDERS` and `normalizeRunnerKind`
 *     (hosts/manager-api/routes.ts), whose own comment already said they
 *     "MUST match the orchestrator's RunnerKind values";
 *   - and two byte-identical env readers differing only in a prefix
 *     string (`DEEPSEEK_MODEL_` / `CURSOR_MODEL_`).
 *
 * Miss `readRunnerKind` and `AGENT_RUNNER=<new>` resolves to `fake` — an
 * agent that starts, does nothing, and reports success. Miss the manager
 * list and the provider cannot be selected in the Agents panel though the
 * runtime supports it. This is the same drift the task-type lists had
 * before `core/flow/task-types.ts` derived them from the flows, and the
 * same remedy: one source, everything else reads it.
 *
 * ## Why `selectable` rather than two lists
 *
 * `fake` is deliberately asymmetric and BOTH halves are correct:
 * `AGENT_RUNNER=fake` must keep working (it is the default when nothing
 * is configured, and the parity tests rely on it), while `fake` must stay
 * out of the Agents-panel dropdown — an operator picking it would route a
 * role to a runner that fabricates output. Four of the eight sites
 * included it and two excluded it on purpose. A bare array of ids would
 * have had to break one of those; the flag keeps both exact.
 *
 * ## Why this lives in core
 *
 * It is pure data: no adapter imports, no SDKs, nothing that knows a
 * `DeepSeekRunner` exists. Both hosts already depend on `core/`, and the
 * alternative — one host importing the other's constant — is the
 * arrangement that produced the drift. CONSTRUCTING a runner stays in the
 * orchestrator (Rule 2: core defines the vocabulary, adapters implement
 * it), which is why `buildRunnerByKind` keeps one branch per provider.
 *
 * ## Deliberately minimal
 *
 * Only `id`, `selectable` and `settingsKeys`, because only those have a
 * consumer. A `label` for the UI (which renders raw ids) would be
 * exactly the declared-and-unwritten wiring that has cost this project
 * days before. `settingsKeys` earned its place the hard way: shipping a
 * provider with no manager-UI settings is a bug that reached the
 * operator. Add a field when the code that reads it lands.
 */

/** One routable backend. */
export interface AgentProviderDescriptor {
    /** Wire value: `AGENT_RUNNER`, `AGENT_RUNNER_<ROLE>`, Agent.provider. */
    readonly id: string;
    /**
     * Whether an operator may choose it for a role (Agents panel, and the
     * `/api/agent-providers` list that populates it). False for `fake`.
     */
    readonly selectable: boolean;
    /**
     * The env keys an operator configures this provider with — its
     * credential, endpoint and model knobs.
     *
     * Field report: "I don't see settings for ollama in the manager ui."
     * Ollama shipped fully ROUTABLE — it appeared in the Agents-panel
     * dropdown, because that list derives from this registry — while none
     * of its keys were in `core/config/settings-registry.ts`, so there
     * was nowhere in the UI to put the API key or the model tag. Routable
     * and configurable were two separate lists with nothing tying them.
     *
     * This field ties them: a test asserts every key named here is an
     * editable setting, so a provider cannot ship routable but
     * unconfigurable. Listed for the UI's sake, not read to build
     * anything — the factory still reads env directly, because it needs
     * the VALUES and their per-provider meaning.
     */
    readonly settingsKeys: readonly string[];
}

/**
 * Every provider the pipeline can route to.
 *
 * ORDER IS THE API ORDER: `/api/agent-providers` serves the selectable
 * ids in this sequence, so appending keeps existing clients stable.
 * A new provider is one row here plus one factory branch in
 * `buildRunnerByKind` — and the factory's exhaustiveness check turns a
 * forgotten branch into a typecheck failure rather than a silent
 * fallback to `fake`.
 */
export const AGENT_PROVIDER_DESCRIPTORS = [
    {
        id: 'claude-cli',
        selectable: true,
        settingsKeys: ['CLAUDE_CMD', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'],
    },
    {
        id: 'deepseek',
        selectable: true,
        settingsKeys: ['DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL'],
    },
    {
        id: 'cursor-cli',
        selectable: true,
        settingsKeys: ['CURSOR_API_KEY', 'CURSOR_CMD'],
    },
    // Ollama, through its Anthropic-compatible `/v1/messages` endpoint.
    // Two rows, one adapter: they differ only in the default base URL
    // and whether a key is required, and keeping them separate is what
    // lets per-role routing send one role to the cloud and another to a
    // local model (the base URL belongs to the runner instance, not to
    // the spawn spec).
    {
        id: 'ollama-cloud',
        selectable: true,
        settingsKeys: [
            'OLLAMA_API_KEY',
            'OLLAMA_MODEL',
            'OLLAMA_SMALL_MODEL',
            'OLLAMA_CLOUD_BASE_URL',
        ],
    },
    {
        id: 'ollama',
        selectable: true,
        settingsKeys: [
            'OLLAMA_MODEL',
            'OLLAMA_SMALL_MODEL',
            'OLLAMA_BASE_URL',
            'OLLAMA_CONTEXT_TOKENS',
        ],
    },
    // Not selectable: the in-process fake. Still a legal AGENT_RUNNER
    // value, and the default when nothing is configured. Nothing to
    // configure, hence no settings keys.
    { id: 'fake', selectable: false, settingsKeys: [] },
] as const satisfies readonly AgentProviderDescriptor[];

/** Any provider id, `fake` included. */
export type AgentProviderId = (typeof AGENT_PROVIDER_DESCRIPTORS)[number]['id'];

/**
 * The ids an operator may pick for a role. Narrower than
 * {@link AgentProviderId} on purpose: an Agent record validated against
 * this cannot name `fake`.
 */
export type SelectableAgentProviderId = Extract<
    (typeof AGENT_PROVIDER_DESCRIPTORS)[number],
    { readonly selectable: true }
>['id'];

/**
 * What an unset / unrecognised `AGENT_RUNNER` resolves to at runtime.
 * Unchanged from the pre-registry behaviour, and relied on by every
 * install that has never configured a provider.
 */
export const DEFAULT_AGENT_PROVIDER: AgentProviderId = 'fake';

export const AGENT_PROVIDER_IDS: readonly AgentProviderId[] =
    AGENT_PROVIDER_DESCRIPTORS.map((p) => p.id);

export const SELECTABLE_AGENT_PROVIDER_IDS: readonly SelectableAgentProviderId[] =
    AGENT_PROVIDER_DESCRIPTORS
        .filter((p): p is Extract<typeof p, { readonly selectable: true }> => p.selectable)
        .map((p) => p.id);

/**
 * Canonicalise a wire value, or `null` when it names no provider.
 *
 * Trims and lowercases, which both former parsers did — an operator who
 * writes `AGENT_RUNNER=" Claude-CLI "` in a .env file gets what they
 * meant. Returning `null` rather than a default keeps the two different
 * fallbacks at their call sites: the orchestrator needs a concrete kind
 * ({@link DEFAULT_AGENT_PROVIDER}), while the manager API reports "no
 * override" and must not invent one.
 */
export function normalizeProviderId(
    raw: string | undefined | null,
): AgentProviderId | null {
    const k = (raw ?? '').trim().toLowerCase();
    if (k.length === 0) return null;
    return (AGENT_PROVIDER_IDS as readonly string[]).includes(k)
        ? (k as AgentProviderId)
        : null;
}

/** Type guard over the full vocabulary (exact match, no normalisation). */
export function isAgentProviderId(value: unknown): value is AgentProviderId {
    return typeof value === 'string'
        && (AGENT_PROVIDER_IDS as readonly string[]).includes(value);
}

/**
 * Type guard over the OPERATOR-SELECTABLE subset — what an Agent
 * record's `provider` field is validated against.
 */
export function isSelectableProviderId(
    value: unknown,
): value is SelectableAgentProviderId {
    return typeof value === 'string'
        && (SELECTABLE_AGENT_PROVIDER_IDS as readonly string[]).includes(value);
}
