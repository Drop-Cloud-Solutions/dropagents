/**
 * AzureConfigStore — `ConfigStore` adapter backed by Azure Table Storage with
 * Azure Blob overflow for oversized payloads.
 *
 * Wire format (so the v1 TypeScript pipeline can coexist against the same
 * storage account):
 *
 *   - One table per `ConfigRowKind`, named EXACTLY `AgentPrompts`,
 *     `Workflows`, `AgentModels`, `ProjectConfig` (see `TABLE_NAMES`).
 *   - `partitionKey` is `options.tenant`; `rowKey` is the caller's `rowKey`.
 *   - `body` (string) carries the row body when it fits under
 *     `overflowThresholdBytes` (UTF-8 byte length, default 30 KiB).
 *   - When the body is too large the adapter uploads it to the overflow
 *     blob container at `<tenant>/<table>/<rowKey>`, stores `body=""` in the
 *     row, and writes the blob path to `blob_ref`. On read, the marker is
 *     followed transparently.
 *   - `ProjectConfig` rows additionally persist `metadata.context_md` into a
 *     sibling `context_md` column (with its own `context_md_blob_ref`
 *     overflow path under `<tenant>/ProjectConfig/<rowKey>.context_md`).
 *   - Any remaining `metadata` keys are stored as a single JSON-encoded
 *     `metadata_json` column so the round-trip is lossless.
 *
 * Concurrency:
 *
 *   - `upsert` without an etag uses `upsertEntity` (unconditional replace).
 *   - `upsert` with an etag uses `updateEntity` with the conditional `etag`
 *     and maps an `If-Match` failure (HTTP 412) to `ConcurrencyError`
 *     carrying the server-returned ETag.
 *   - `delete` always passes the caller's etag through to `deleteEntity`,
 *     and on successful row delete it then evicts any overflow blob(s) the
 *     row referenced (`blob_ref`, `context_md_blob_ref`) — best-effort, so a
 *     stranded blob never blocks the row delete from succeeding.
 *   - `get` maps HTTP 404 to `null` (rather than rethrowing) so callers can
 *     distinguish "absent" from "transient failure".
 *
 * Authentication uses `DefaultAzureCredential` so the same client works for
 * service-principal env vars (CI / nssm services) and for managed identities
 * (Azure-hosted workers). Connection-string constructors are deliberately
 * not supported — see `createAzureConfigStore`.
 *
 * Testability:
 *
 *   The class itself depends only on the structural `TableClientLike` and
 *   `BlobContainerClientLike` interfaces declared here, so unit tests can
 *   inject in-process fakes without pulling the Azure SDK. The production
 *   wiring (`createAzureConfigStore`) lazy-loads `@azure/identity`,
 *   `@azure/data-tables`, and `@azure/storage-blob` via `require` so the
 *   unit-test path never executes that code.
 */

import type {
  ConfigRow,
  ConfigRowKind,
  ConfigRowUpsert,
  ConfigStore,
  ConfigStoreOptions,
} from '../../core/ports';
import {
  ConcurrencyError,
  DEFAULT_OVERFLOW_CONTAINER_NAME,
  DEFAULT_OVERFLOW_THRESHOLD_BYTES,
} from '../../core/ports';

// ---------------------------------------------------------------------------
// Wire-format constants
// ---------------------------------------------------------------------------

/**
 * Mapping from the closed `ConfigRowKind` union to the EXACT Azure Table
 * names used on storage. Frozen so adding a new kind is a deliberate port +
 * adapter change rather than a typo-prone literal in a switch.
 *
 * The v1 TS pipeline targets the same names; do not "tidy" these to e.g.
 * `agent_prompts` without coordinating with v1.
 */
export const TABLE_NAMES: Readonly<Record<ConfigRowKind, string>> = Object.freeze({
  AgentPrompts: 'AgentPrompts',
  Workflows: 'Workflows',
  AgentModels: 'AgentModels',
  ProjectConfig: 'ProjectConfig',
  Settings: 'Settings',
});

/** Metadata key on `ProjectConfig` rows that carries the project's context.md. */
const CONTEXT_MD_KEY = 'context_md';

/** Column names on the underlying table rows. */
const BODY_COLUMN = 'body';
const BODY_BLOB_REF_COLUMN = 'blob_ref';
const CONTEXT_MD_COLUMN = 'context_md';
const CONTEXT_MD_BLOB_REF_COLUMN = 'context_md_blob_ref';
const META_JSON_COLUMN = 'metadata_json';
const UPDATED_AT_COLUMN = 'updated_at';

// ---------------------------------------------------------------------------
// Structural Azure-SDK-like interfaces (so tests need no Azure SDK install)
// ---------------------------------------------------------------------------

/**
 * Shape of a row going to / coming from the Azure Tables SDK. The SDK
 * carries `partitionKey` / `rowKey` (camelCase) and reads `etag` back on the
 * returned entity. Extra columns (`body`, `blob_ref`, …) are arbitrary
 * keys on the same object.
 */
export interface TableEntityRecord {
  partitionKey: string;
  rowKey: string;
  etag?: string;
  [column: string]: unknown;
}

/** Options for conditional table operations — narrows to `etag` only. */
export interface ConditionalEtagOptions {
  readonly etag?: string;
}

/**
 * Subset of `@azure/data-tables` `TableClient` used by the adapter.
 *
 * The real SDK exposes more, but the unit tests inject fakes against
 * this interface. The factory at the bottom of the file casts the real
 * `TableClient` to this type — every method below has a same-named
 * counterpart on the SDK with a compatible signature.
 */
export interface TableClientLike {
  getEntity(partitionKey: string, rowKey: string): Promise<TableEntityRecord>;
  upsertEntity(entity: TableEntityRecord, mode?: 'Replace' | 'Merge'): Promise<{ etag: string }>;
  updateEntity(
    entity: TableEntityRecord,
    mode: 'Replace' | 'Merge',
    options?: ConditionalEtagOptions,
  ): Promise<{ etag: string }>;
  deleteEntity(
    partitionKey: string,
    rowKey: string,
    options?: ConditionalEtagOptions,
  ): Promise<void>;
  listEntities(options?: { queryOptions?: { filter?: string } }): AsyncIterable<TableEntityRecord>;
}

/** Subset of `@azure/storage-blob` `BlockBlobClient` used by the adapter. */
export interface BlockBlobClientLike {
  upload(data: string, contentLength: number): Promise<unknown>;
  download(): Promise<{ readableStreamBody?: NodeJS.ReadableStream }>;
  // Optional so the existing in-process fakes don't need to implement it.
  // The real `@azure/storage-blob` `BlockBlobClient` provides this method,
  // and `delete` uses it to evict overflow bodies after the row is gone.
  deleteIfExists?(): Promise<unknown>;
}

/** Subset of `@azure/storage-blob` `ContainerClient` used by the adapter. */
export interface BlobContainerClientLike {
  createIfNotExists(): Promise<unknown>;
  getBlockBlobClient(blobName: string): BlockBlobClientLike;
}

/**
 * Client factory bundle injected into `AzureConfigStore`. The production
 * wiring (`createAzureConfigStore`) implements this with real Azure SDK
 * clients authenticated via `DefaultAzureCredential`; tests pass in
 * deterministic in-memory fakes.
 */
export interface AzureConfigStoreClients {
  getTableClient(tableName: string): TableClientLike;
  getContainerClient(): BlobContainerClientLike;
}

// ---------------------------------------------------------------------------
// Public path helper
// ---------------------------------------------------------------------------

/**
 * Format of the overflow blob path: `<tenant>/<table>/<rowKey>`.
 *
 * Exported so callers (and tests) can compute the path without re-deriving
 * the convention. The path is intentionally hierarchical so a tenant's
 * overflow content sorts together under a single virtual directory in any
 * Azure portal view.
 */
export function blobRefFor(tenant: string, tableName: string, rowKey: string): string {
  return `${tenant}/${tableName}/${rowKey}`;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class AzureConfigStore implements ConfigStore {
  private readonly tenant: string;
  private readonly overflowThresholdBytes: number;
  private overflowContainerReady = false;

  constructor(
    private readonly clients: AzureConfigStoreClients,
    options: ConfigStoreOptions,
  ) {
    if (!options.tenant) {
      throw new Error('AzureConfigStore requires a non-empty tenant');
    }
    this.tenant = options.tenant;
    this.overflowThresholdBytes =
      options.overflowThresholdBytes ?? DEFAULT_OVERFLOW_THRESHOLD_BYTES;
  }

  async get(kind: ConfigRowKind, rowKey: string): Promise<ConfigRow | null> {
    const table = this.clients.getTableClient(TABLE_NAMES[kind]);
    let entity: TableEntityRecord;
    try {
      entity = await table.getEntity(this.tenant, rowKey);
    } catch (err) {
      if (statusCodeOf(err) === 404) return null;
      throw err;
    }
    return this.hydrateRow(kind, entity);
  }

  async upsert(spec: ConfigRowUpsert): Promise<ConfigRow> {
    const table = this.clients.getTableClient(TABLE_NAMES[spec.kind]);
    const entity = await this.buildEntity(spec);

    try {
      let result: { etag: string };
      if (spec.etag !== undefined) {
        // Conditional replace: the SDK sends `If-Match: <etag>` and the
        // service answers 412 on mismatch.
        result = await table.updateEntity(entity, 'Replace', { etag: spec.etag });
      } else {
        // No etag supplied → unconditional upsert. Matches the port's
        // "Create or replace" wording when the caller has not observed a
        // prior etag.
        result = await table.upsertEntity(entity, 'Replace');
      }
      const updatedAt = entity[UPDATED_AT_COLUMN] as Date;
      return {
        kind: spec.kind,
        rowKey: spec.rowKey,
        body: spec.body,
        metadata: { ...(spec.metadata ?? {}) },
        etag: result.etag,
        updatedAt,
      };
    } catch (err) {
      if (statusCodeOf(err) === 412) {
        throw new ConcurrencyError(
          `etag mismatch on upsert of ${spec.kind}/${spec.rowKey}`,
          extractServerEtag(err) ?? '',
        );
      }
      throw err;
    }
  }

  async delete(kind: ConfigRowKind, rowKey: string, etag: string): Promise<void> {
    const table = this.clients.getTableClient(TABLE_NAMES[kind]);

    // Peek at the row first so we can evict any overflow blob(s) after the
    // row delete succeeds. A 404 here is fine — the conditional delete below
    // will surface the right error to the caller.
    const blobRefsToEvict: string[] = [];
    try {
      const existing = await table.getEntity(this.tenant, rowKey);
      const bodyRef = existing[BODY_BLOB_REF_COLUMN];
      if (typeof bodyRef === 'string' && bodyRef.length > 0) {
        blobRefsToEvict.push(bodyRef);
      }
      const ctxRef = existing[CONTEXT_MD_BLOB_REF_COLUMN];
      if (typeof ctxRef === 'string' && ctxRef.length > 0) {
        blobRefsToEvict.push(ctxRef);
      }
    } catch (err) {
      if (statusCodeOf(err) !== 404) throw err;
    }

    try {
      await table.deleteEntity(this.tenant, rowKey, { etag });
    } catch (err) {
      if (statusCodeOf(err) === 412) {
        throw new ConcurrencyError(
          `etag mismatch on delete of ${kind}/${rowKey}`,
          extractServerEtag(err) ?? '',
        );
      }
      throw err;
    }

    // Row is gone — drop the overflow blobs. Best-effort: a stranded blob is
    // far less harmful than failing the whole delete after the row went, and
    // re-running the delete (now a 404) wouldn't help anyway.
    if (blobRefsToEvict.length === 0) return;
    const container = this.clients.getContainerClient();
    for (const ref of blobRefsToEvict) {
      try {
        const blob = container.getBlockBlobClient(ref);
        if (typeof blob.deleteIfExists === 'function') {
          await blob.deleteIfExists();
        }
      } catch {
        // Swallow: the row delete has already succeeded.
      }
    }
  }

  async *list(kind: ConfigRowKind): AsyncIterable<ConfigRow> {
    const table = this.clients.getTableClient(TABLE_NAMES[kind]);
    // OData filter — escape single quotes by doubling per the Tables grammar.
    const safeTenant = this.tenant.replace(/'/g, "''");
    const filter = `PartitionKey eq '${safeTenant}'`;
    for await (const entity of table.listEntities({ queryOptions: { filter } })) {
      yield await this.hydrateRow(kind, entity);
    }
  }

  // -------------------------------------------------------------------------
  // internal: build a wire-format entity from a `ConfigRowUpsert`
  // -------------------------------------------------------------------------

  private async buildEntity(spec: ConfigRowUpsert): Promise<TableEntityRecord> {
    const tableName = TABLE_NAMES[spec.kind];
    const entity: TableEntityRecord = {
      partitionKey: this.tenant,
      rowKey: spec.rowKey,
      [UPDATED_AT_COLUMN]: new Date(),
    };

    const bodyBytes = Buffer.byteLength(spec.body, 'utf8');
    if (bodyBytes > this.overflowThresholdBytes) {
      const blobName = blobRefFor(this.tenant, tableName, spec.rowKey);
      await this.uploadOverflowBlob(blobName, spec.body);
      entity[BODY_COLUMN] = '';
      entity[BODY_BLOB_REF_COLUMN] = blobName;
    } else {
      entity[BODY_COLUMN] = spec.body;
    }

    if (spec.kind === 'ProjectConfig') {
      const contextMd = spec.metadata?.[CONTEXT_MD_KEY];
      if (contextMd !== undefined) {
        const ctxBytes = Buffer.byteLength(contextMd, 'utf8');
        if (ctxBytes > this.overflowThresholdBytes) {
          const blobName = blobRefFor(
            this.tenant,
            tableName,
            `${spec.rowKey}.${CONTEXT_MD_KEY}`,
          );
          await this.uploadOverflowBlob(blobName, contextMd);
          entity[CONTEXT_MD_COLUMN] = '';
          entity[CONTEXT_MD_BLOB_REF_COLUMN] = blobName;
        } else {
          entity[CONTEXT_MD_COLUMN] = contextMd;
        }
      }
    }

    // Remaining metadata is JSON-blobbed so the round-trip is lossless
    // without us having to invent per-key column conventions. context_md on
    // ProjectConfig is excluded because it already has its own columns.
    const remaining: Record<string, string> = {};
    if (spec.metadata) {
      for (const [k, v] of Object.entries(spec.metadata)) {
        if (spec.kind === 'ProjectConfig' && k === CONTEXT_MD_KEY) continue;
        remaining[k] = v;
      }
    }
    if (Object.keys(remaining).length > 0) {
      entity[META_JSON_COLUMN] = JSON.stringify(remaining);
    }

    return entity;
  }

  private async uploadOverflowBlob(blobName: string, body: string): Promise<void> {
    const container = this.clients.getContainerClient();
    if (!this.overflowContainerReady) {
      // Lazy create. Idempotent on the server side; first call wins per process.
      await container.createIfNotExists();
      this.overflowContainerReady = true;
    }
    const blob = container.getBlockBlobClient(blobName);
    const bytes = Buffer.byteLength(body, 'utf8');
    await blob.upload(body, bytes);
  }

  // -------------------------------------------------------------------------
  // internal: turn a wire-format entity back into a `ConfigRow`
  // -------------------------------------------------------------------------

  private async hydrateRow(kind: ConfigRowKind, entity: TableEntityRecord): Promise<ConfigRow> {
    const body = await this.readBody(entity);
    const metadata = await this.readMetadata(kind, entity);
    const updatedAt = coerceDate(entity[UPDATED_AT_COLUMN]);
    return {
      kind,
      rowKey: entity.rowKey,
      body,
      metadata,
      etag: entity.etag ?? '',
      updatedAt,
    };
  }

  private async readBody(entity: TableEntityRecord): Promise<string> {
    const blobRef = entity[BODY_BLOB_REF_COLUMN];
    if (typeof blobRef === 'string' && blobRef.length > 0) {
      return this.downloadOverflowBlob(blobRef);
    }
    const inline = entity[BODY_COLUMN];
    return typeof inline === 'string' ? inline : '';
  }

  private async readMetadata(
    kind: ConfigRowKind,
    entity: TableEntityRecord,
  ): Promise<Record<string, string>> {
    const metadata: Record<string, string> = {};
    const metaJson = entity[META_JSON_COLUMN];
    if (typeof metaJson === 'string' && metaJson.length > 0) {
      try {
        const parsed = JSON.parse(metaJson) as Record<string, unknown>;
        for (const [k, v] of Object.entries(parsed)) {
          metadata[k] = String(v);
        }
      } catch {
        // A malformed metadata column shouldn't poison the whole row read.
        // The blob_ref / body / etag still come through.
      }
    }

    if (kind === 'ProjectConfig') {
      const ctxBlobRef = entity[CONTEXT_MD_BLOB_REF_COLUMN];
      if (typeof ctxBlobRef === 'string' && ctxBlobRef.length > 0) {
        metadata[CONTEXT_MD_KEY] = await this.downloadOverflowBlob(ctxBlobRef);
      } else {
        const inline = entity[CONTEXT_MD_COLUMN];
        if (typeof inline === 'string') {
          metadata[CONTEXT_MD_KEY] = inline;
        }
      }
    }

    return metadata;
  }

  private async downloadOverflowBlob(blobName: string): Promise<string> {
    const container = this.clients.getContainerClient();
    const blob = container.getBlockBlobClient(blobName);
    const resp = await blob.download();
    if (!resp.readableStreamBody) return '';
    return streamToString(resp.readableStreamBody);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Pull the HTTP status code off whatever the Azure SDK threw. RestError
 * surfaces it as `.statusCode`, but some wrappers stash it under
 * `.response.status` — accept both so we don't miss a 412 / 404 due to
 * a shape change.
 */
function statusCodeOf(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const obj = err as Record<string, unknown>;
  if (typeof obj.statusCode === 'number') return obj.statusCode;
  const response = obj.response as Record<string, unknown> | undefined;
  if (response && typeof response.status === 'number') return response.status;
  return undefined;
}

/**
 * Extract the current server-side ETag out of a 412 response. The Azure
 * Tables service echoes the row's current ETag in the response headers,
 * which the SDK exposes as either a `.get(name)` method (real `HttpHeaders`)
 * or a plain object (some test doubles).
 */
function extractServerEtag(err: unknown): string | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const obj = err as Record<string, unknown>;
  const response = obj.response as Record<string, unknown> | undefined;
  const headers = response?.headers as unknown;
  if (headers && typeof (headers as { get?: (n: string) => unknown }).get === 'function') {
    const got = (headers as { get: (n: string) => unknown }).get('etag');
    if (typeof got === 'string') return got;
  }
  if (headers && typeof headers === 'object') {
    const map = headers as Record<string, string>;
    return map.etag ?? map.ETag ?? map.Etag;
  }
  const details = obj.details as Record<string, unknown> | undefined;
  if (details && typeof details.etag === 'string') return details.etag;
  return undefined;
}

function coerceDate(value: unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value === 'string' || typeof value === 'number') return new Date(value);
  return new Date(0);
}

async function streamToString(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8'));
  }
  return Buffer.concat(chunks).toString('utf8');
}

// ---------------------------------------------------------------------------
// Production wiring: DefaultAzureCredential + real Azure SDK clients.
// ---------------------------------------------------------------------------

/**
 * Wire an `AzureConfigStore` against the real Azure SDK using
 * `DefaultAzureCredential`. The credential chain transparently picks up:
 *
 *   - `AZURE_CLIENT_ID` / `AZURE_TENANT_ID` / `AZURE_CLIENT_SECRET` env vars
 *     (CI and nssm-hosted services)
 *   - Managed Identity (Azure-hosted workers)
 *   - Azure CLI / VS Code / IDE credentials (developer laptops)
 *
 * `connection string` constructors are intentionally NOT supported — see
 * AC #7 in TASK.md. The composition root should `throw` rather than fall
 * back to a connection string.
 *
 * The Azure SDK modules are loaded via `require` so unit tests that
 * construct `AzureConfigStore` directly do not pull `@azure/identity`,
 * `@azure/data-tables`, or `@azure/storage-blob` into the test runtime.
 */
export function createAzureConfigStore(options: ConfigStoreOptions): AzureConfigStore {
  if (!options.azureStorageAccountUrl) {
    throw new Error(
      'AzureConfigStore requires options.azureStorageAccountUrl ' +
        '(e.g. https://<account>.table.core.windows.net)',
    );
  }
  const containerName =
    options.overflowContainerName ?? DEFAULT_OVERFLOW_CONTAINER_NAME;

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const azureIdentity = require('@azure/identity');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const dataTables = require('@azure/data-tables');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const storageBlob = require('@azure/storage-blob');

  const credential = new azureIdentity.DefaultAzureCredential();

  // Azure Storage exposes the four services under sibling sub-domains:
  // <acct>.table.core.windows.net vs <acct>.blob.core.windows.net. Accept
  // either as the configured account URL and rewrite the host for the
  // service we need.
  const tableServiceUrl = options.azureStorageAccountUrl.replace('.blob.', '.table.');
  const blobServiceUrl = options.azureStorageAccountUrl.replace('.table.', '.blob.');

  const blobServiceClient = new storageBlob.BlobServiceClient(blobServiceUrl, credential);
  const containerClient = blobServiceClient.getContainerClient(containerName);

  const tableClients = new Map<string, TableClientLike>();
  const clients: AzureConfigStoreClients = {
    getTableClient(name: string): TableClientLike {
      let c = tableClients.get(name);
      if (!c) {
        c = new dataTables.TableClient(tableServiceUrl, name, credential) as TableClientLike;
        tableClients.set(name, c);
      }
      return c;
    },
    getContainerClient(): BlobContainerClientLike {
      return containerClient as BlobContainerClientLike;
    },
  };

  return new AzureConfigStore(clients, options);
}
