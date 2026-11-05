import type { Logger } from '../../core/ports/Logger';
import type { AgentRunKiller } from '../../hosts/board-ui/commands';

/**
 * Fallback `AgentRunKiller` for the `AGENT_RUNNER=fake` (and any non-cli)
 * configuration. When the orchestrator is wired without a live `claude`
 * process there is nothing to signal, but `CancelAgentRun` still needs an
 * adapter to bind against — emitting `AgentRunCancelled` requires the
 * runner contract to be satisfied even in dev/test setups.
 *
 * `kill(runId)` is a true no-op: it touches no filesystem, no network, no
 * processes. If a logger is supplied, a single `debug` line is emitted per
 * call so operators tailing the log can confirm the no-op path was taken
 * rather than wondering whether the cancellation reached the runner at all.
 */
export interface NoopAgentRunKillerOptions {
  readonly logger?: Logger;
}

export class NoopAgentRunKiller implements AgentRunKiller {
  private readonly logger: Logger | undefined;

  constructor(options: NoopAgentRunKillerOptions = {}) {
    this.logger = options.logger;
  }

  async kill(runId: string): Promise<void> {
    this.logger?.debug('NoopAgentRunKiller.kill (no-op)', { runId });
  }
}
