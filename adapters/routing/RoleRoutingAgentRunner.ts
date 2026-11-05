/**
 * Routing AgentRunner — dispatches `start(spec)` to one of N inner
 * adapters based on `spec.role`. Lets an operator run different agents
 * through different backends (e.g. Claude Opus for the developer,
 * DeepSeek v4 Pro for the reviewer + tester) without a code change in
 * the orchestrator host: see `initAgentRunner` in
 * `hosts/orchestrator/main.ts` for how `AGENT_RUNNER_<ROLE>` env vars
 * become the role → adapter map.
 *
 * Kill semantics
 * --------------
 * `interrupt(handle)` and `interruptById(runId)` fan out to every inner
 * adapter. Each adapter's `interruptById` is already idempotent on an
 * unknown id (returns silently if the run isn't in its `active` map),
 * so the fan-out is safe and order-independent. We don't maintain a
 * separate handle→adapter table because the cost of N tiny lookups
 * dwarfs the cost of a misrouted kill ever happening — and a Map would
 * need clearing on AgentFinished, which is bus-driven and not visible
 * to the router.
 *
 * Sidecar path
 * ------------
 * `killedSidecarPath(agentId)` returns the path of the first adapter
 * that actually has a sidecar file on disk for `agentId`; if none does,
 * it falls back to the supplied fallback adapter's path. The
 * orchestrator's killed-sidecar reader uses this to detect operator-
 * driven exits, so accuracy here only matters when a sidecar was in
 * fact written — every other case is a benign default.
 */

import * as fs from 'node:fs';

import type { AgentHandle, AgentRunner, AgentSpec, Logger } from '../../core/ports';

/**
 * The subset of `ClaudeCliRunner` (and `DeepSeekRunner`) that the
 * `AgentRunKiller` adapter consumes. Declared locally to avoid a hard
 * dependency on `adapters/claude-cli/ClaudeCliAgentRunKiller` here.
 */
export interface InterruptableById {
    interruptById(runId: string): Promise<void>;
    killedSidecarPath(agentId: string): string;
}

/** Concrete inner adapter the router can route to. */
export type RoutableRunner = AgentRunner & InterruptableById;

export interface RoleRoutingAgentRunnerOptions {
    /**
     * Per-role adapter map. Keys are role labels exactly as they appear
     * on `AgentSpec.role` (`'developer'`, `'tester'`, etc.). Roles not
     * in this map fall through to `fallback`.
     */
    readonly byRole: ReadonlyMap<string, RoutableRunner>;
    /**
     * Adapter used for any role missing from `byRole`. Matches
     * single-adapter semantics — the operator still gets a working
     * runner for every role even when only a subset is overridden.
     */
    readonly fallback: RoutableRunner;
    /**
     * Management UI (Option B): runners keyed by PROVIDER name (a RunnerKind:
     * `claude-cli` / `deepseek` / `cursor-cli`). When {@link resolveProvider}
     * returns a provider present here, it wins over `byRole` — so an operator
     * can set a role's backend in the Agents panel without an env var. Only
     * providers whose runner could be built (creds present) appear.
     */
    readonly byProvider?: ReadonlyMap<string, RoutableRunner>;
    /**
     * Per-role provider override (from the Agents panel), consulted at
     * dispatch time so an edit applies on the next spawn. Undefined = fall
     * through to `byRole` / `fallback`.
     */
    readonly resolveProvider?: (role: string) => string | undefined;
    readonly logger?: Logger;
}

export class RoleRoutingAgentRunner implements AgentRunner, InterruptableById {
    private readonly byRole: ReadonlyMap<string, RoutableRunner>;
    private readonly byProvider: ReadonlyMap<string, RoutableRunner> | undefined;
    private readonly resolveProvider: ((role: string) => string | undefined) | undefined;
    private readonly fallback: RoutableRunner;
    private readonly logger: Logger | undefined;

    constructor(options: RoleRoutingAgentRunnerOptions) {
        this.byRole = options.byRole;
        this.byProvider = options.byProvider;
        this.resolveProvider = options.resolveProvider;
        this.fallback = options.fallback;
        this.logger = options.logger;
    }

    start(spec: AgentSpec): AgentHandle {
        // Management UI (Option B): an Agent's provider wins — route to that
        // provider's runner when one was built. Falls to the env-driven
        // per-role map, then the fallback.
        const provider = this.resolveProvider?.(spec.role);
        const byProviderHit = provider ? this.byProvider?.get(provider) : undefined;
        const runner = byProviderHit ?? this.byRole.get(spec.role) ?? this.fallback;
        return runner.start(spec);
    }

    async interrupt(handle: AgentHandle): Promise<void> {
        await Promise.all(
            this.allRunners().map(async (r) => {
                try {
                    await r.interrupt(handle);
                } catch (err) {
                    this.logger?.warn('role-routing: inner interrupt threw', {
                        agentId: handle.id,
                        error: err instanceof Error ? err.message : String(err),
                    });
                }
            }),
        );
    }

    async interruptById(runId: string): Promise<void> {
        await Promise.all(
            this.allRunners().map(async (r) => {
                try {
                    await r.interruptById(runId);
                } catch (err) {
                    this.logger?.warn('role-routing: inner interruptById threw', {
                        runId,
                        error: err instanceof Error ? err.message : String(err),
                    });
                }
            }),
        );
    }

    killedSidecarPath(agentId: string): string {
        for (const runner of this.allRunners()) {
            const candidate = runner.killedSidecarPath(agentId);
            try {
                if (fs.existsSync(candidate)) return candidate;
            } catch {
                // ignore — fall through to the fallback path
            }
        }
        return this.fallback.killedSidecarPath(agentId);
    }

    private allRunners(): RoutableRunner[] {
        const set = new Set<RoutableRunner>();
        set.add(this.fallback);
        for (const r of this.byRole.values()) set.add(r);
        for (const r of this.byProvider?.values() ?? []) set.add(r);
        return Array.from(set);
    }
}
