/**
 * Port: outbound operator notifications across chat / web-UI / future
 * surfaces (Telegram, Slack, in-board toasts, …).
 *
 * The pipeline emits a small, fixed vocabulary of lifecycle events
 * (PlanReady, CommitReady, PrReady, DeployReady, InvestigationDone,
 * ContextUpdated, WorkerError) and the orchestrator host wires one or
 * more {@link NotificationPort} adapters that translate those events
 * into operator-visible messages. The port deliberately speaks in the
 * pipeline's own event vocabulary rather than a transport-shaped one:
 *
 *   - adapters never need to know about Telegram chat ids or Slack
 *     webhooks at the port boundary;
 *   - hosts never need to know which channel the notification will
 *     ultimately land on.
 *
 * The seven kinds enumerated here mirror the v1 chat-notify icon set in
 * `pipeline/worker/chat-notify.ts`, so a future Slack / web-UI adapter
 * stays parity-compatible with the v1 surface without touching the
 * existing TelegramGateway.
 *
 * # Inline keyboards
 *
 * Keyboard wiring (Approve / Skip / Retry / View PR …) is the concern of
 * the action-router track (AP-IFG-015), not this port. Adapters are free
 * to render their own action affordances based on `kind` + payload, but
 * the port does not prescribe them.
 */

/**
 * The closed set of notification kinds the pipeline emits. Names match
 * the PascalCase event types published on the EventBus so an adapter
 * implementation can subscribe by name and route through `send` with a
 * single dispatch table.
 */
export const NotificationKinds = {
  PLAN_READY:          'PlanReady',
  COMMIT_READY:        'CommitReady',
  PR_READY:            'PrReady',
  DEPLOY_READY:        'DeployReady',
  INVESTIGATION_DONE:  'InvestigationDone',
  CONTEXT_UPDATED:     'ContextUpdated',
  WORKER_ERROR:        'WorkerError',
} as const;

export type NotificationKind =
  (typeof NotificationKinds)[keyof typeof NotificationKinds];

/** Every {@link NotificationKind} as a readonly tuple — handy for iterating
 *  in adapter constructors that want to wire one subscriber per kind. */
export const ALL_NOTIFICATION_KINDS: readonly NotificationKind[] = [
  NotificationKinds.PLAN_READY,
  NotificationKinds.COMMIT_READY,
  NotificationKinds.PR_READY,
  NotificationKinds.DEPLOY_READY,
  NotificationKinds.INVESTIGATION_DONE,
  NotificationKinds.CONTEXT_UPDATED,
  NotificationKinds.WORKER_ERROR,
];

/**
 * Loose payload accepted by {@link NotificationPort.send}. Fields are all
 * optional so an adapter can render best-effort text even when only a
 * subset of context is available; adapters MUST tolerate missing fields
 * and fall back to a sensible default (typically the kind-specific
 * title) rather than throwing.
 *
 * The field set is the union across all kinds; per-kind contracts:
 *
 *   - `PlanReady`         : `planId` is conventional but not required;
 *                           `title` / `body` describe the proposed plan.
 *   - `CommitReady`       : `taskId` identifies the task awaiting commit.
 *   - `PrReady`           : `taskId` + `url` (the PR url) and optional
 *                           `prNumber`.
 *   - `DeployReady`       : `taskId`, `deployKind`, `deployTarget`.
 *   - `InvestigationDone` : `taskId` + `body` (the investigator's report).
 *   - `ContextUpdated`    : `taskId` + `prNumber` (the CLAUDE.md PR).
 *   - `WorkerError`       : `error` / `stack` describing the failure. No
 *                           `taskId` when the error is process-global.
 */
export interface NotificationPayload {
  readonly taskId?: string;
  readonly planId?: string;
  readonly title?: string;
  readonly body?: string;
  readonly url?: string;
  readonly prNumber?: number;
  readonly deployKind?: string;
  readonly deployTarget?: string;
  readonly error?: string;
  readonly stack?: string;
}

/**
 * Outbound notification port. A `send` call is fire-and-forget from the
 * caller's perspective — the adapter is responsible for transport-level
 * retries, no-op-on-misconfig, and any rate-limiting it needs. The
 * returned promise resolves once the adapter has done its best-effort
 * delivery (or short-circuited because the transport is unconfigured);
 * it does NOT model end-to-end delivery confirmation.
 */
export interface NotificationPort {
  send(kind: NotificationKind, payload: NotificationPayload): Promise<void>;
}
