import type { AgentRunKiller } from '../../hosts/board-ui/commands';

/**
 * Production `AgentRunKiller` for the `AGENT_RUNNER=cli` configuration. The
 * board's `CancelAgentRun` handler holds a runId and needs to signal the
 * matching live `claude` process; `ClaudeCliRunner.interruptById` already
 * owns the runId → handle resolution, sidecar write, and platform-aware
 * kill. This adapter is the thin port-shaped wrapper that lets the handler
 * depend on the `AgentRunKiller` interface rather than the concrete runner.
 *
 * Idempotency (unknown runId, double-kill) is inherited verbatim from
 * `interruptById` — keeping this wrapper branch-free means there is exactly
 * one place to reason about cancellation semantics.
 */
export interface ClaudeCliInterruptable {
  interruptById(runId: string): Promise<void>;
}

export class ClaudeCliAgentRunKiller implements AgentRunKiller {
  constructor(private readonly runner: ClaudeCliInterruptable) {}

  async kill(runId: string): Promise<void> {
    await this.runner.interruptById(runId);
  }
}
