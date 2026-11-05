/**
 * Composition-root factory for the `ConfigStore` port.
 *
 * TypeScript analogue of the .NET extension method called out in TASK.md
 * (`ConfigStoreServiceCollectionExtensions.AddConfigStore`). The job is
 * identical: resolve `ConfigStoreOptions` from configuration (yaml +
 * `PIPELINE_STORE_*` env-var overlay) and return the concrete adapter that
 * matches `options.backendKind`.
 *
 * Backend selection (mirrors AC #2–#5):
 *
 *   - `fs`    → `new FsConfigStore(options)`.
 *   - `azure` → `createAzureConfigStore(options)` (lazy-loads `@azure/identity`,
 *               `@azure/data-tables`, `@azure/storage-blob` and uses
 *               `DefaultAzureCredential`).
 *   - `dual`  → `new DualConfigStore({ fs, azure, logger })` where `fs` and
 *               `azure` are the same concrete adapters produced for the
 *               single-backend modes. This is the TS equivalent of the
 *               C# brief's "register FsConfigStore and AzureConfigStore as
 *               keyed services so DualConfigStore can resolve them
 *               through DI": the two inner stores are constructed
 *               eagerly from the same options object, exposed on the
 *               returned wiring so a host can resolve them by name.
 *
 * The Azure factory is injectable (`deps.azureFactory`) so unit tests can
 * substitute a stub that does not touch the Azure SDK or credentials.
 */
import {
  AzureConfigStore,
  createAzureConfigStore,
} from '../azure/AzureConfigStore';
import { DualConfigStore } from '../dual-config-store/DualConfigStore';
import { FsConfigStore } from '../fs-config-store/FsConfigStore';

import {
  DEFAULT_OVERFLOW_CONTAINER_NAME,
  DEFAULT_OVERFLOW_THRESHOLD_BYTES,
  type ConfigStore,
  type ConfigStoreBackendKind,
  type ConfigStoreOptions,
  type Logger,
} from '../../core/ports';

/**
 * Shape of the `config_store:` section in `config/pipeline.yaml`. The keys
 * intentionally use snake_case to match the rest of the file; the resolver
 * maps them onto the camelCase `ConfigStoreOptions`. Every key is optional
 * — defaults come from the env vars or `ConfigStoreOptions` constants.
 */
export interface ConfigStoreYamlSection {
  readonly backend_kind?: ConfigStoreBackendKind;
  readonly tenant?: string;
  readonly azure_storage_account_url?: string;
  readonly fs_root_path?: string;
  readonly overflow_threshold_bytes?: number;
  readonly overflow_container_name?: string;
}

/** Default tenant identifier used when neither yaml nor env supplies one. */
export const DEFAULT_CONFIG_STORE_TENANT = 'default';

/** Set of valid `ConfigStoreBackendKind` values, used for env-var validation. */
const VALID_BACKEND_KINDS: ReadonlySet<string> = new Set<ConfigStoreBackendKind>([
  'fs',
  'azure',
  'dual',
]);

/**
 * Overlay `PIPELINE_STORE_*` env vars on top of the yaml section and return a
 * fully-formed `ConfigStoreOptions`. Env vars win on every key; this matches
 * AC #2 ("backend selection is driven by ConfigStoreOptions.BackendKind
 * bound from configuration + PIPELINE_STORE_BACKEND env var") and the
 * "overlaid with PIPELINE_STORE_* environment variables" hint.
 */
export function resolveConfigStoreOptions(
  yaml: ConfigStoreYamlSection | undefined,
  env: NodeJS.ProcessEnv = process.env,
  /**
   * Fallback for `fs_root_path` when pipeline.yaml sets none. The hosts pass
   * the initialised operator profile, so the Settings panel's values live
   * with the rest of the operator's config instead of in the process cwd
   * (usually the checkout, where a fresh clone silently loses them). The
   * orchestrator and the manager-api must agree on it — they share the
   * store — which is why both derive it the same way.
   */
  defaults: { readonly fsRootPath?: string } = {},
): ConfigStoreOptions {
  const rawBackend = env.PIPELINE_STORE_BACKEND ?? yaml?.backend_kind ?? 'fs';
  if (!VALID_BACKEND_KINDS.has(rawBackend)) {
    throw new Error(
      `ConfigStore: unknown backend "${rawBackend}". Expected one of: fs, azure, dual.`,
    );
  }
  const backendKind = rawBackend as ConfigStoreBackendKind;

  const tenant =
    env.PIPELINE_STORE_TENANT ?? yaml?.tenant ?? DEFAULT_CONFIG_STORE_TENANT;

  const azureStorageAccountUrl =
    env.AZURE_STORAGE_ACCOUNT_URL ?? yaml?.azure_storage_account_url;

  const overflowThresholdBytes = parsePositiveInt(
    env.PIPELINE_STORE_OVERFLOW_THRESHOLD_BYTES,
    yaml?.overflow_threshold_bytes,
    DEFAULT_OVERFLOW_THRESHOLD_BYTES,
    'PIPELINE_STORE_OVERFLOW_THRESHOLD_BYTES',
  );

  const overflowContainerName =
    env.PIPELINE_STORE_OVERFLOW_CONTAINER ??
    yaml?.overflow_container_name ??
    DEFAULT_OVERFLOW_CONTAINER_NAME;

  return {
    tenant,
    backendKind,
    azureStorageAccountUrl,
    overflowThresholdBytes,
    overflowContainerName,
    fsRootPath: yaml?.fs_root_path ?? defaults.fsRootPath,
  };
}

function parsePositiveInt(
  envValue: string | undefined,
  yamlValue: number | undefined,
  fallback: number,
  envName: string,
): number {
  if (envValue !== undefined && envValue !== '') {
    const parsed = Number.parseInt(envValue, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(
        `ConfigStore: ${envName}="${envValue}" must be a positive integer.`,
      );
    }
    return parsed;
  }
  if (typeof yamlValue === 'number' && yamlValue > 0) return yamlValue;
  return fallback;
}

export interface ConfigStoreWiringDeps {
  /** Logger forwarded to `DualConfigStore` for swallowed-Azure-failure warnings. */
  readonly logger: Logger;
  /**
   * Test seam — factory that constructs an `AzureConfigStore` from
   * `ConfigStoreOptions`. Defaults to the production wiring
   * (`createAzureConfigStore`) which lazy-loads the Azure SDK and uses
   * `DefaultAzureCredential`. Unit tests pass in a stub so the suite
   * never touches credentials or the SDK.
   */
  readonly azureFactory?: (options: ConfigStoreOptions) => AzureConfigStore;
}

/**
 * Wiring bundle returned by `createConfigStore`. `configStore` is the
 * adapter the host should register as the singleton `ConfigStore`; `fs`
 * and `azure` carry the concrete inner adapters when running in `dual`
 * mode so the host can resolve them by name (analogue of the C# "keyed
 * services" registration). Both inner refs are `undefined` outside dual
 * mode.
 */
export interface ConfigStoreWiring {
  readonly configStore: ConfigStore;
  readonly fs?: FsConfigStore;
  readonly azure?: AzureConfigStore;
}

/**
 * Construct the `ConfigStore` adapter the host should use, selected by
 * `options.backendKind`. See module-level doc for the per-mode rules and
 * AC mapping.
 */
export function createConfigStore(
  options: ConfigStoreOptions,
  deps: ConfigStoreWiringDeps,
): ConfigStoreWiring {
  const makeAzure = deps.azureFactory ?? createAzureConfigStore;
  switch (options.backendKind) {
    case 'fs':
      return { configStore: new FsConfigStore(options) };
    case 'azure':
      return { configStore: makeAzure(options) };
    case 'dual': {
      const fs = new FsConfigStore(options);
      const azure = makeAzure(options);
      const dual = new DualConfigStore({ fs, azure, logger: deps.logger });
      return { configStore: dual, fs, azure };
    }
    default: {
      // Exhaustiveness guard — `backendKind` is a closed union, but a
      // misconfigured caller (e.g. options assembled outside
      // `resolveConfigStoreOptions`) can still land here. Fail loud
      // rather than silently default.
      const _exhaustive: never = options.backendKind;
      throw new Error(
        `ConfigStore: unsupported backendKind "${_exhaustive as string}".`,
      );
    }
  }
}
