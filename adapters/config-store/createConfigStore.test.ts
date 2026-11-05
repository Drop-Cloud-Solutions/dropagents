/**
 * Unit tests for `createConfigStore` — the composition-root factory that
 * picks the `ConfigStore` adapter based on `ConfigStoreOptions.backendKind`.
 *
 * Coverage (AC #8): a single parameterised test verifies each `BackendKind`
 * value resolves to the correct concrete `ConfigStore` implementation type.
 * The companion test for `resolveConfigStoreOptions` covers AC #2's env-var
 * overlay rule (PIPELINE_STORE_* wins over the yaml section) and AC #7
 * (yaml-only default of `backendKind=fs`), since both behaviours are
 * load-bearing for the factory and would be invisible from a type-only
 * assertion.
 *
 * The Azure factory is stubbed so the suite never touches `@azure/identity`
 * or `DefaultAzureCredential` — the production wiring is exercised by the
 * `AzureConfigStore` adapter's own tests, not here.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import {
  AzureConfigStore,
  type AzureConfigStoreClients,
  type BlobContainerClientLike,
  type TableClientLike,
  type TableEntityRecord,
} from '../azure/AzureConfigStore';
import { DualConfigStore } from '../dual-config-store/DualConfigStore';
import { FsConfigStore } from '../fs-config-store/FsConfigStore';

import type {
  ConfigStoreBackendKind,
  ConfigStoreOptions,
  Logger,
} from '../../core/ports';

import {
  DEFAULT_CONFIG_STORE_TENANT,
  createConfigStore,
  resolveConfigStoreOptions,
} from './createConfigStore';

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

const silentLogger: Logger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};

/**
 * Stub Azure clients — the factory under test only checks the returned
 * type, so the clients never have to do anything. They just have to
 * satisfy the structural `AzureConfigStoreClients` interface so the
 * `AzureConfigStore` constructor accepts them.
 */
function stubAzureClients(): AzureConfigStoreClients {
  const tableClient: TableClientLike = {
    async getEntity(): Promise<TableEntityRecord> {
      throw new Error('not used in this test');
    },
    async upsertEntity(): Promise<{ etag: string }> {
      throw new Error('not used in this test');
    },
    async updateEntity(): Promise<{ etag: string }> {
      throw new Error('not used in this test');
    },
    async deleteEntity(): Promise<void> {
      throw new Error('not used in this test');
    },
    listEntities(): AsyncIterable<TableEntityRecord> {
      return (async function* () {})();
    },
  };
  const containerClient: BlobContainerClientLike = {
    async createIfNotExists(): Promise<unknown> {
      return undefined;
    },
    getBlockBlobClient() {
      throw new Error('not used in this test');
    },
  };
  return {
    getTableClient: () => tableClient,
    getContainerClient: () => containerClient,
  };
}

function stubAzureFactory(): (options: ConfigStoreOptions) => AzureConfigStore {
  return (options) => new AzureConfigStore(stubAzureClients(), options);
}

function baseOptions(
  backendKind: ConfigStoreBackendKind,
): ConfigStoreOptions {
  return {
    tenant: 'unit',
    backendKind,
    azureStorageAccountUrl: 'https://example.table.core.windows.net',
  };
}

// ---------------------------------------------------------------------------
// AC #8 — every BackendKind resolves to the expected concrete type
// ---------------------------------------------------------------------------

test('createConfigStore: each BackendKind resolves to the matching IConfigStore implementation', () => {
  const azureFactory = stubAzureFactory();

  const fsWiring = createConfigStore(baseOptions('fs'), {
    logger: silentLogger,
    azureFactory,
  });
  assert.ok(
    fsWiring.configStore instanceof FsConfigStore,
    `fs backend must resolve to FsConfigStore (got ${fsWiring.configStore.constructor.name})`,
  );
  assert.equal(fsWiring.fs, undefined, 'fs mode does not expose keyed fs ref');
  assert.equal(fsWiring.azure, undefined, 'fs mode does not expose keyed azure ref');

  const azureWiring = createConfigStore(baseOptions('azure'), {
    logger: silentLogger,
    azureFactory,
  });
  assert.ok(
    azureWiring.configStore instanceof AzureConfigStore,
    `azure backend must resolve to AzureConfigStore (got ${azureWiring.configStore.constructor.name})`,
  );

  const dualWiring = createConfigStore(baseOptions('dual'), {
    logger: silentLogger,
    azureFactory,
  });
  assert.ok(
    dualWiring.configStore instanceof DualConfigStore,
    `dual backend must resolve to DualConfigStore (got ${dualWiring.configStore.constructor.name})`,
  );
  // Dual mode exposes the inner adapters so the host can register them as
  // keyed services (analogue of the C# brief).
  assert.ok(
    dualWiring.fs instanceof FsConfigStore,
    'dual mode must expose the inner FsConfigStore as a keyed dependency',
  );
  assert.ok(
    dualWiring.azure instanceof AzureConfigStore,
    'dual mode must expose the inner AzureConfigStore as a keyed dependency',
  );
});

// ---------------------------------------------------------------------------
// AC #2 — env-var overlay wins over the yaml section
// ---------------------------------------------------------------------------

test('resolveConfigStoreOptions: PIPELINE_STORE_BACKEND env var overrides yaml backend_kind', () => {
  const options = resolveConfigStoreOptions(
    { backend_kind: 'fs', tenant: 'from-yaml' },
    { PIPELINE_STORE_BACKEND: 'dual', PIPELINE_STORE_TENANT: 'from-env' },
  );
  assert.equal(options.backendKind, 'dual');
  assert.equal(options.tenant, 'from-env');
});

// ---------------------------------------------------------------------------
// AC #7 — yaml-only default is backendKind=fs with tenant fallback
// ---------------------------------------------------------------------------

test('resolveConfigStoreOptions: yaml-only with no env defaults to backendKind=fs', () => {
  const options = resolveConfigStoreOptions(undefined, {});
  assert.equal(options.backendKind, 'fs');
  assert.equal(options.tenant, DEFAULT_CONFIG_STORE_TENANT);
});

test('resolveConfigStoreOptions: rejects unknown backend values', () => {
  assert.throws(
    () => resolveConfigStoreOptions(undefined, { PIPELINE_STORE_BACKEND: 'bogus' }),
    /unknown backend "bogus"/,
  );
});
