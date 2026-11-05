import type { AgentHandle, AgentRunner, AgentSpec } from '../../core/ports';
import type { Event } from '../../core/events/event';

/**
 * Fake AgentRunner used by Phase 0 bootstrap and integration tests.
 *
 * `start` returns an AgentHandle synchronously (as the port requires) and
 * fires `AgentStarted` followed by `AgentFinished` on the injected bus.
 * The two publishes are chained so they hit the event log in order; the
 * caller can `await flush()` to observe quiescence in tests.
 *
 * The dependency is typed as the minimal `EventPublisher` interface rather
 * than the full EventBus so tests can inject a lightweight stub. The real
 * EventBus from core/events/bus.ts satisfies this shape.
 */

export interface EventPublisher {
  publish(event: Event): Promise<unknown>;
}

export interface FakeAgentRunnerOptions {
  readonly bus: EventPublisher;
  /** Source of "now" for the published events. Defaults to Date.now. */
  readonly clock?: () => number;
  /**
   * Override the synthetic agent-id generator. Default produces
   * `fake-agent-1`, `fake-agent-2`, ... in start-order.
   */
  readonly newId?: () => string;
}

export class FakeAgentRunner implements AgentRunner {
  private readonly bus: EventPublisher;
  private readonly clock: () => number;
  private readonly newId: () => string;
  private readonly pending = new Set<Promise<unknown>>();
  private counter = 0;

  constructor(options: FakeAgentRunnerOptions) {
    this.bus = options.bus;
    this.clock = options.clock ?? ((): number => Date.now());
    this.newId = options.newId ?? ((): string => `fake-agent-${++this.counter}`);
  }

  start(spec: AgentSpec): AgentHandle {
    const handle: AgentHandle = { id: this.newId(), spec };
    const started = this.publish('AgentStarted', handle);
    const finished = started.then(() => this.publish('AgentFinished', handle));
    this.track(started);
    this.track(finished);
    return handle;
  }

  async interrupt(_handle: AgentHandle): Promise<void> {
    // Fake: nothing to cancel. The port requires idempotent completion.
  }

  /**
   * `ClaudeCliInterruptable`-shaped no-op so the fake can sit behind the
   * `RoleRoutingAgentRunner` alongside real adapters. The router fans
   * `interruptById` out across every inner adapter; the fake never owns
   * a live process, so the call resolves silently.
   */
  async interruptById(_runId: string): Promise<void> {
    // No-op: nothing to interrupt.
  }

  /**
   * Await every event publish initiated by `start` so far. Tests use this
   * to flush the synchronous-return / async-publish gap before asserting.
   */
  async flush(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.all(Array.from(this.pending));
    }
  }

  private publish(type: string, handle: AgentHandle): Promise<unknown> {
    return this.bus.publish({
      type,
      v: 1,
      occurredAt: this.clock(),
      idempotencyKey: `fake-agent:${type}:${handle.id}`,
      // Mirror ClaudeCliRunner's metadata propagation so the board's
      // applyPlannerEvent can correlate fake-runner events back to a
      // planId. Without this, the planner-running badge never shows
      // when AGENT_RUNNER is unset (default = fake) and the operator
      // sees the modal close with no visible UI feedback.
      payload: {
        agentId: handle.id,
        role: handle.spec.role,
        ...(handle.spec.metadata !== undefined
          ? { metadata: handle.spec.metadata }
          : {}),
      }
    });
  }

  private track(promise: Promise<unknown>): void {
    this.pending.add(promise);
    promise.finally(() => this.pending.delete(promise));
  }
}
