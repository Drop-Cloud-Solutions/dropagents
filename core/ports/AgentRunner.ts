/**
 * Port: spawn and interrupt long-running agent processes (Claude CLI,
 * Anthropic API, local LLM, ...).
 *
 * `start` is **synchronous** in its return: it allocates and returns an
 * `AgentHandle` immediately so the caller can record/cancel the run.
 * Lifecycle events — `AgentStarted`, `AgentProgress`, `AgentQuestion`,
 * `AgentFinished` — flow over the pipeline's event bus, NOT through the
 * returned handle and NOT through callbacks on this interface. That keeps
 * the adapter ignorant of who is listening and lets multiple subscribers
 * react to the same agent lifecycle.
 *
 * `interrupt` is async because cancelling a process (SIGTERM + drain,
 * HTTP abort + flush, ...) may legitimately take time.
 */

/** Inputs needed to start an agent run. */
export interface AgentSpec {
  /** Role label (developer, reviewer, tester, planner, ...). */
  readonly role: string;
  /** The prompt / instructions the agent should run with. */
  readonly prompt: string;
  /** Optional working directory the agent should consider its cwd. */
  readonly cwd?: string;
  /**
   * Extra environment for the agent process, overlaid on the parent.
   *
   * Exists because agents run git and gh THEMSELVES - the committer
   * commits, the scaffolder clones and creates repos - so there is no
   * pipeline call site to pass an identity or a credential to. The
   * orchestrator puts the task repo's GitHub-account overlay here and
   * the agent's own git/gh calls pick it up: `GH_CONFIG_DIR` for gh,
   * `GIT_AUTHOR_*` / `GIT_COMMITTER_*` for the commit identity, and the
   * `GIT_CONFIG_*` credential helper for pushes.
   *
   * Empty / absent for an unmapped repo, which leaves the agent on the
   * machine's ambient identity.
   */
  readonly env?: Readonly<Record<string, string>>;
  /** Free-form adapter-readable metadata (model, effort, env, ...). */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * Handle returned by `start`. Opaque to the caller apart from `id`;
 * adapters may attach private fields by extending this type internally.
 */
export interface AgentHandle {
  readonly id: string;
  readonly spec: AgentSpec;
}

export interface AgentRunner {
  /**
   * Begin an agent run and return a handle synchronously. Subscribe to
   * the event bus for lifecycle events — this method does not surface
   * them.
   */
  start(spec: AgentSpec): AgentHandle;

  /**
   * Interrupt a running agent. Idempotent: calling `interrupt` on a
   * handle whose underlying process has already exited must resolve
   * without error.
   */
  interrupt(handle: AgentHandle): Promise<void>;
}
