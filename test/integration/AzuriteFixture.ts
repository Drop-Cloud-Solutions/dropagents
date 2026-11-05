/**
 * AzuriteFixture — Testcontainers-driven Azurite instance for integration
 * tests of the AzureConfigStore.
 *
 * The fixture is a thin wrapper around the well-known `azure-storage/azurite`
 * image; it exposes the table service (10002) and blob service (10000) on
 * randomly mapped host ports so multiple test files can run in parallel
 * without colliding. Production code still uses `DefaultAzureCredential` —
 * the Azurite shared-key path lives ONLY in tests.
 *
 * Usage:
 *
 *   const fixture = new AzuriteFixture();
 *   await fixture.start();
 *   const { clients, tableServiceClient, containerClient } =
 *     fixture.buildClients();
 *   await fixture.prepareTablesAndContainer();
 *   // … run tests …
 *   await fixture.stop();
 *
 * The static `isDockerAvailable()` probe lets tests skip cleanly when the
 * host has no Docker daemon, which matches AC #7: skipped, not failed.
 */

import { spawnSync } from 'node:child_process';

import type {
  AzureConfigStoreClients,
  BlobContainerClientLike,
  TableClientLike,
} from '../../adapters/azure/AzureConfigStore';
import { TABLE_NAMES } from '../../adapters/azure/AzureConfigStore';
import { DEFAULT_OVERFLOW_CONTAINER_NAME } from '../../core/ports';

// ---------------------------------------------------------------------------
// Lazy SDK loaders. The three dependencies (`testcontainers`, the two Azure
// SDKs) are deliberately required at call time rather than module load time
// so that `isDockerAvailable()` can return `false` and let tests skip cleanly
// even on hosts where these packages were never installed (e.g. a quick
// `tsc --noEmit` lint that doesn't run `npm install` first).
// ---------------------------------------------------------------------------

interface StartedContainer {
  getHost(): string;
  getMappedPort(port: number): number;
  stop(): Promise<unknown>;
}

interface GenericContainerLike {
  withExposedPorts(...ports: number[]): GenericContainerLike;
  withStartupTimeout(ms: number): GenericContainerLike;
  start(): Promise<StartedContainer>;
}

interface TestcontainersModule {
  GenericContainer: new (image: string) => GenericContainerLike;
}

interface DataTablesModule {
  TableClient: {
    fromConnectionString(connStr: string, tableName: string): TableClientLikeReal;
  };
  TableServiceClient: {
    fromConnectionString(connStr: string): TableServiceClientLikeReal;
  };
}

interface StorageBlobModule {
  BlobServiceClient: {
    fromConnectionString(connStr: string): BlobServiceClientLikeReal;
  };
}

function loadTestcontainers(): TestcontainersModule {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('testcontainers') as TestcontainersModule;
}
function loadDataTables(): DataTablesModule {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('@azure/data-tables') as DataTablesModule;
}
function loadStorageBlob(): StorageBlobModule {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('@azure/storage-blob') as StorageBlobModule;
}

// ---------------------------------------------------------------------------
// Azure SDK shapes used directly by the fixture (clients we own & manage).
// ---------------------------------------------------------------------------

interface TableClientLikeReal extends TableClientLike {
  createTable(): Promise<unknown>;
  deleteTable(): Promise<unknown>;
}

interface TableServiceClientLikeReal {
  createTable(name: string): Promise<unknown>;
  deleteTable(name: string): Promise<unknown>;
}

export interface BlockBlobClientLikeReal {
  upload(data: string, contentLength: number): Promise<unknown>;
  download(): Promise<{ readableStreamBody?: NodeJS.ReadableStream }>;
  deleteIfExists(): Promise<unknown>;
  exists(): Promise<boolean>;
}

export interface ContainerClientLikeReal {
  createIfNotExists(): Promise<unknown>;
  deleteIfExists(): Promise<unknown>;
  getBlockBlobClient(name: string): BlockBlobClientLikeReal;
  listBlobsFlat(options?: { prefix?: string }): AsyncIterable<{ name: string }>;
}

interface BlobServiceClientLikeReal {
  getContainerClient(name: string): ContainerClientLikeReal;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Azurite's documented well-known account name + key. These are deliberately
 * NOT secrets: the image ships with them baked in. They're documented at
 * https://learn.microsoft.com/azure/storage/common/storage-use-azurite — do
 * not use them outside the test fixture.
 */
const AZURITE_ACCOUNT_NAME = 'devstoreaccount1';
const AZURITE_ACCOUNT_KEY =
  'Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSV6t5Vg47XJL2u2WnRZTSnLBC/9aGNz4xPjWlqXJSnJjQQ==';

const AZURITE_IMAGE = 'mcr.microsoft.com/azure-storage/azurite';
const AZURITE_BLOB_PORT = 10000;
const AZURITE_TABLE_PORT = 10002;
const STARTUP_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

export interface AzuriteFixtureClients {
  /** Adapter-facing client bundle (the structural interface AzureConfigStore consumes). */
  readonly clients: AzureConfigStoreClients;
  /** Service-level table client (for create/drop in test setup/teardown). */
  readonly tableServiceClient: TableServiceClientLikeReal;
  /** Service-level blob client (for low-level blob assertions in tests). */
  readonly blobServiceClient: BlobServiceClientLikeReal;
  /** Overflow container client — same container the adapter writes through. */
  readonly containerClient: ContainerClientLikeReal;
  /** Name of the overflow container — useful for path assertions. */
  readonly overflowContainerName: string;
}

export class AzuriteFixture {
  private container: StartedContainer | null = null;
  private connectionString: string | null = null;

  /**
   * Probe whether Docker is reachable on the host. Returns false when:
   *   - `docker` is not on PATH
   *   - `docker info` returns a non-zero exit (daemon not running, etc.)
   *
   * The probe is short (1.5s) so it doesn't add noticeable delay when
   * Docker isn't installed.
   */
  static isDockerAvailable(): boolean {
    try {
      const res = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], {
        timeout: 1_500,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return res.status === 0 && (res.stdout ?? '').trim().length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Launch Azurite. The image exposes blob/queue/table by default; we only
   * publish the two ports we use. The Testcontainers default wait strategy
   * (listening port) is sufficient — Azurite starts in well under 10s.
   */
  async start(): Promise<void> {
    if (this.container) return;
    // Default wait strategy in testcontainers-node v10 already waits for the
    // exposed ports to be listening — Azurite binds blob/table within a few
    // seconds of container start, so we don't need a custom log-message check.
    const tc = loadTestcontainers();
    const container = await new tc.GenericContainer(AZURITE_IMAGE)
      .withExposedPorts(AZURITE_BLOB_PORT, AZURITE_TABLE_PORT)
      .withStartupTimeout(STARTUP_TIMEOUT_MS)
      .start();

    this.container = container;
    const host = container.getHost();
    const blobPort = container.getMappedPort(AZURITE_BLOB_PORT);
    const tablePort = container.getMappedPort(AZURITE_TABLE_PORT);
    // The Azurite path scheme is `http://host:port/<account>`; the SDKs
    // accept a connection string with explicit endpoints rather than the
    // production-style `<account>.<service>.core.windows.net` host pattern.
    this.connectionString =
      `DefaultEndpointsProtocol=http;` +
      `AccountName=${AZURITE_ACCOUNT_NAME};` +
      `AccountKey=${AZURITE_ACCOUNT_KEY};` +
      `BlobEndpoint=http://${host}:${blobPort}/${AZURITE_ACCOUNT_NAME};` +
      `TableEndpoint=http://${host}:${tablePort}/${AZURITE_ACCOUNT_NAME};`;
  }

  /** Stop and remove the Azurite container. Safe to call when never started. */
  async stop(): Promise<void> {
    const c = this.container;
    if (!c) return;
    this.container = null;
    this.connectionString = null;
    try {
      await c.stop();
    } catch {
      // Best-effort — a test failure shouldn't be masked by a slow Docker.
    }
  }

  /** Connection string used by the SDK clients. Throws if `start()` hasn't run. */
  getConnectionString(): string {
    if (!this.connectionString) {
      throw new Error('AzuriteFixture: call start() before getConnectionString()');
    }
    return this.connectionString;
  }

  /**
   * Build a fresh client bundle pointed at the running Azurite. Tests that
   * want to simulate "two clients reading the same row" call this twice and
   * get independent SDK instances backed by the same emulator.
   */
  buildClients(
    overflowContainerName: string = DEFAULT_OVERFLOW_CONTAINER_NAME,
  ): AzuriteFixtureClients {
    const connStr = this.getConnectionString();
    const dt = loadDataTables();
    const sb = loadStorageBlob();

    const tableServiceClient = dt.TableServiceClient.fromConnectionString(connStr);
    const blobServiceClient = sb.BlobServiceClient.fromConnectionString(connStr);
    const containerClient = blobServiceClient.getContainerClient(overflowContainerName);

    const tableClients = new Map<string, TableClientLike>();
    const clients: AzureConfigStoreClients = {
      getTableClient(name: string): TableClientLike {
        let c = tableClients.get(name);
        if (!c) {
          c = dt.TableClient.fromConnectionString(connStr, name) as TableClientLike;
          tableClients.set(name, c);
        }
        return c;
      },
      getContainerClient(): BlobContainerClientLike {
        return containerClient as unknown as BlobContainerClientLike;
      },
    };

    return {
      clients,
      tableServiceClient,
      blobServiceClient,
      containerClient,
      overflowContainerName,
    };
  }

  /**
   * Create all four `ConfigRowKind` tables and the overflow container.
   *
   * Azurite returns 409 (TableAlreadyExists) on a second create — we ignore
   * that so the fixture is idempotent across rerun-style tests. The container
   * client's `createIfNotExists` already has the right idempotent semantics.
   */
  async prepareTablesAndContainer(
    overflowContainerName: string = DEFAULT_OVERFLOW_CONTAINER_NAME,
  ): Promise<void> {
    const connStr = this.getConnectionString();
    const dt = loadDataTables();
    const sb = loadStorageBlob();
    const tableService = dt.TableServiceClient.fromConnectionString(connStr);
    for (const tableName of Object.values(TABLE_NAMES)) {
      try {
        await tableService.createTable(tableName);
      } catch (err) {
        // 409 — table already exists. Anything else propagates.
        if (extractStatusCode(err) !== 409) throw err;
      }
    }
    const blobService = sb.BlobServiceClient.fromConnectionString(connStr);
    await blobService.getContainerClient(overflowContainerName).createIfNotExists();
  }

  /**
   * Drop every row in the four tables that belongs to `tenant`, and delete
   * every blob under `<tenant>/` in the overflow container. Tenant-scoped so
   * parallel tests that use different tenants don't trample each other.
   */
  async wipeTenant(
    tenant: string,
    overflowContainerName: string = DEFAULT_OVERFLOW_CONTAINER_NAME,
  ): Promise<void> {
    if (!this.connectionString) return;
    const dt = loadDataTables();
    const sb = loadStorageBlob();

    // Drop rows: list by PartitionKey and delete each. OData escape: '' for '.
    const safeTenant = tenant.replace(/'/g, "''");
    for (const tableName of Object.values(TABLE_NAMES)) {
      try {
        const tc = dt.TableClient.fromConnectionString(
          this.connectionString,
          tableName,
        ) as TableClientLikeReal;
        const filter = `PartitionKey eq '${safeTenant}'`;
        // Collect keys first; some SDK paged iterators dislike concurrent
        // mutation of the underlying partition while iterating.
        const keys: Array<{ p: string; r: string }> = [];
        for await (const e of tc.listEntities({ queryOptions: { filter } })) {
          keys.push({ p: e.partitionKey, r: e.rowKey });
        }
        for (const { p, r } of keys) {
          try {
            await tc.deleteEntity(p, r);
          } catch {
            // Best-effort cleanup
          }
        }
      } catch {
        // Table may not exist on a partial failure — skip.
      }
    }

    // Drop blobs under <tenant>/.
    try {
      const blobService = sb.BlobServiceClient.fromConnectionString(this.connectionString);
      const container = blobService.getContainerClient(overflowContainerName);
      for await (const blob of container.listBlobsFlat({ prefix: `${tenant}/` })) {
        try {
          await container.getBlockBlobClient(blob.name).deleteIfExists();
        } catch {
          // best-effort
        }
      }
    } catch {
      // Container may not exist — fine.
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractStatusCode(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const obj = err as Record<string, unknown>;
  if (typeof obj.statusCode === 'number') return obj.statusCode;
  const response = obj.response as Record<string, unknown> | undefined;
  if (response && typeof response.status === 'number') return response.status;
  return undefined;
}
