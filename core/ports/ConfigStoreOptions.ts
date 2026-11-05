/**
 * Options that select and parameterise the `ConfigStore` adapter.
 *
 * The options are intentionally a pure data shape — env-var binding
 * (PIPELINE_STORE_BACKEND, PIPELINE_STORE_TENANT, AZURE_STORAGE_ACCOUNT_URL,
 * PIPELINE_STORE_OVERFLOW_THRESHOLD_BYTES, PIPELINE_STORE_OVERFLOW_CONTAINER)
 * is the composition root's job, not this port's. Defining the shape here
 * keeps adapters honest about which knobs they may read.
 */

/**
 * Which backend the composition root should wire up.
 *
 * - `fs`    — filesystem-backed store, used in dev and tests.
 * - `dual`  — write-through to both fs and azure; used during migrations
 *             and for shadow-mode verification.
 * - `azure` — Azure Table Storage with Blob overflow for oversized rows.
 */
export type ConfigStoreBackendKind = 'fs' | 'dual' | 'azure';

/** Default overflow threshold (30 KiB) — rows larger than this spill to blob. */
export const DEFAULT_OVERFLOW_THRESHOLD_BYTES = 30720;

/** Default blob container name for overflow payloads. */
export const DEFAULT_OVERFLOW_CONTAINER_NAME = 'pipeline-store-overflow';

export interface ConfigStoreOptions {
  /**
   * Tenant identifier. Every row read or written goes through the
   * adapter scoped to this tenant — there is no cross-tenant API.
   * Required.
   */
  readonly tenant: string;

  /** Selects the adapter to wire up. Required. */
  readonly backendKind: ConfigStoreBackendKind;

  /**
   * Account URL for the Azure Table + Blob services. Required when
   * `backendKind` is `azure` or `dual`; ignored for `fs`.
   */
  readonly azureStorageAccountUrl?: string;

  /**
   * Row body size, in bytes, above which the Azure adapter spills the
   * body into the overflow blob container. Optional; defaults to
   * `DEFAULT_OVERFLOW_THRESHOLD_BYTES`.
   */
  readonly overflowThresholdBytes?: number;

  /**
   * Blob container name used for spilled bodies. Optional; defaults to
   * `DEFAULT_OVERFLOW_CONTAINER_NAME`.
   */
  readonly overflowContainerName?: string;

  /**
   * Filesystem root used by the `fs` adapter. The adapter writes
   * `worker/agents/`, `shared/.cache/`, and `projects/` under this
   * directory — see `FsConfigStore` for the full layout. Optional; the
   * adapter falls back to `process.cwd()` when unset, which is convenient
   * for tests but should be explicit in production wiring. Ignored when
   * `backendKind` is `azure`.
   */
  readonly fsRootPath?: string;
}
