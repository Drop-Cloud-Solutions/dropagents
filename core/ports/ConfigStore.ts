/**
 * Port: tenant-scoped configuration store for pipeline rows
 * (agent prompts, workflows, agent model bindings, project config).
 *
 * The port is intentionally backend-agnostic: it speaks in `ConfigRow`s
 * keyed by a closed `ConfigRowKind` plus a free-form `rowKey` string,
 * and carries an opaque `etag` for optimistic concurrency. Adapters
 * (filesystem, Azure Table + Blob overflow, dual-write) implement this
 * surface; nothing here may reference Azure SDK types.
 *
 * The closed `ConfigRowKind` union is load-bearing: it caps the set of
 * row kinds the pipeline can store, so adding a new kind is a deliberate
 * port change rather than an adapter convention.
 *
 * Concurrency contract: `upsert` and `delete` take the etag the caller
 * observed at read time. If the row has moved on since, the adapter
 * throws `ConcurrencyError` carrying the conflicting etag so the caller
 * can re-read and retry.
 */

/** Closed set of row kinds the config store accepts. */
export type ConfigRowKind =
  | 'AgentPrompts'
  | 'Workflows'
  | 'AgentModels'
  | 'ProjectConfig'
  /**
   * Operator-editable runtime settings (Management UI Phase 5, plan §7a).
   * One row per env-style key from the curated registry in
   * `core/config/settings-registry.ts`; `body` is the raw value string.
   * Overlaid onto `process.env` at host boot — the store wins over `.env`.
   */
  | 'Settings';

/**
 * A row stored under (`kind`, `rowKey`). `body` is the adapter-opaque
 * payload (typically JSON or YAML); `metadata` is a small string→string
 * map for adapter-visible tags. `etag` is opaque to callers.
 */
export interface ConfigRow {
  readonly kind: ConfigRowKind;
  readonly rowKey: string;
  readonly body: string;
  readonly metadata: Readonly<Record<string, string>>;
  readonly etag: string;
  readonly updatedAt: Date;
}

/** Inputs to an upsert. `etag` is required for updates; omit for creates. */
export interface ConfigRowUpsert {
  readonly kind: ConfigRowKind;
  readonly rowKey: string;
  readonly body: string;
  readonly metadata?: Readonly<Record<string, string>>;
  /**
   * Etag observed at read time. Omit when creating a new row; supply
   * when overwriting an existing one. A mismatch throws `ConcurrencyError`.
   */
  readonly etag?: string;
}

/**
 * Thrown by `upsert` / `delete` when the caller's etag does not match
 * the row's current etag. Carries the etag the adapter saw on the
 * server so the caller can diff/log without re-reading.
 */
export class ConcurrencyError extends Error {
  readonly conflictingEtag: string;

  constructor(message: string, conflictingEtag: string) {
    super(message);
    this.name = 'ConcurrencyError';
    this.conflictingEtag = conflictingEtag;
  }
}

export interface ConfigStore {
  /**
   * Return the row at (`kind`, `rowKey`) or `null` if it does not exist.
   * `signal` lets the caller cancel a slow adapter call.
   */
  get(
    kind: ConfigRowKind,
    rowKey: string,
    signal?: AbortSignal,
  ): Promise<ConfigRow | null>;

  /**
   * Create or replace a row. If `spec.etag` is supplied it must match
   * the current row's etag, otherwise `ConcurrencyError` is thrown.
   * Returns the row as stored, including the new etag and updatedAt.
   */
  upsert(spec: ConfigRowUpsert, signal?: AbortSignal): Promise<ConfigRow>;

  /**
   * Delete the row at (`kind`, `rowKey`). The caller's `etag` must
   * match the current row's etag or `ConcurrencyError` is thrown.
   */
  delete(
    kind: ConfigRowKind,
    rowKey: string,
    etag: string,
    signal?: AbortSignal,
  ): Promise<void>;

  /**
   * Stream every row of the given `kind` for the configured tenant.
   * Order is adapter-defined. Callers may break out of the iteration
   * early; the adapter must release any underlying resources when the
   * iterator is closed (e.g. via `for await` early exit).
   */
  list(kind: ConfigRowKind, signal?: AbortSignal): AsyncIterable<ConfigRow>;
}
