/**
 * AzureConfigStore unit tests.
 *
 * In-process fakes for `TableClientLike` / `BlobContainerClientLike` stand
 * in for the Azure SDK — the goal of these tests is the adapter's wire
 * format and concurrency semantics, NOT a real round-trip (Azurite-backed
 * integration tests live in task-008).
 *
 * Test coverage maps to the acceptance criteria in TASK.md as:
 *
 *   AC #1 Table names              → "table names map exactly to ..." test
 *   AC #2 PartitionKey = tenant    → "upsert sets PartitionKey to tenant" test
 *   AC #3 30 KiB overflow          → "body ≤ threshold ..." +
 *                                    "body > threshold spills to blob ..." +
 *                                    "threshold is measured in UTF-8 bytes" tests
 *   AC #4 412 → ConcurrencyError   → "upsert with stale etag ..." +
 *                                    "delete with stale etag ..." tests
 *   AC #5 404 → null               → "get returns null on 404" test
 *   AC #6 ProjectConfig context.md → "ProjectConfig persists context_md ..." +
 *                                    "ProjectConfig spills oversized ..." tests
 *   AC #8 Mock-based unit tests    → this file (no real Azure clients)
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import type { ConfigStore } from '../../core/ports';
import { ConcurrencyError } from '../../core/ports';

import {
  AzureConfigStore,
  TABLE_NAMES,
  blobRefFor,
  type AzureConfigStoreClients,
  type BlobContainerClientLike,
  type BlockBlobClientLike,
  type ConditionalEtagOptions,
  type TableClientLike,
  type TableEntityRecord,
} from './AzureConfigStore';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface RecordedCall {
  readonly op:
    | 'getEntity'
    | 'upsertEntity'
    | 'updateEntity'
    | 'deleteEntity'
    | 'listEntities';
  readonly args: Readonly<Record<string, unknown>>;
}

class FakeTableClient implements TableClientLike {
  readonly calls: RecordedCall[] = [];
  private readonly entities = new Map<string, TableEntityRecord>();
  private nextEtagSeq = 1;

  // Knobs for negative-path tests.
  raise404OnGet = false;
  raise412OnUpdate = false;
  raise412OnDelete = false;
  serverEtagOnConflict = 'W/"server-conflict"';

  private key(partitionKey: string, rowKey: string): string {
    return `${partitionKey}|${rowKey}`;
  }

  async getEntity(partitionKey: string, rowKey: string): Promise<TableEntityRecord> {
    this.calls.push({ op: 'getEntity', args: { partitionKey, rowKey } });
    if (this.raise404OnGet) {
      throw makeRestError(404);
    }
    const e = this.entities.get(this.key(partitionKey, rowKey));
    if (!e) throw makeRestError(404);
    return { ...e };
  }

  async upsertEntity(
    entity: TableEntityRecord,
    mode?: 'Replace' | 'Merge',
  ): Promise<{ etag: string }> {
    this.calls.push({ op: 'upsertEntity', args: { entity: cloneEntity(entity), mode } });
    const etag = this.mintEtag();
    this.entities.set(this.key(entity.partitionKey, entity.rowKey), {
      ...entity,
      etag,
    });
    return { etag };
  }

  async updateEntity(
    entity: TableEntityRecord,
    mode: 'Replace' | 'Merge',
    options?: ConditionalEtagOptions,
  ): Promise<{ etag: string }> {
    this.calls.push({
      op: 'updateEntity',
      args: { entity: cloneEntity(entity), mode, options },
    });
    if (this.raise412OnUpdate) {
      throw makeRestError(412, this.serverEtagOnConflict);
    }
    const etag = this.mintEtag();
    this.entities.set(this.key(entity.partitionKey, entity.rowKey), {
      ...entity,
      etag,
    });
    return { etag };
  }

  async deleteEntity(
    partitionKey: string,
    rowKey: string,
    options?: ConditionalEtagOptions,
  ): Promise<void> {
    this.calls.push({
      op: 'deleteEntity',
      args: { partitionKey, rowKey, options },
    });
    if (this.raise412OnDelete) {
      throw makeRestError(412, this.serverEtagOnConflict);
    }
    this.entities.delete(this.key(partitionKey, rowKey));
  }

  async *listEntities(options?: {
    queryOptions?: { filter?: string };
  }): AsyncIterable<TableEntityRecord> {
    this.calls.push({ op: 'listEntities', args: { options: options ?? {} } });
    for (const e of this.entities.values()) {
      yield { ...e };
    }
  }

  private mintEtag(): string {
    const n = this.nextEtagSeq++;
    return `W/"datetime'2026-01-01T00:00:00.${String(n).padStart(7, '0')}Z'"`;
  }
}

class FakeBlockBlobClient implements BlockBlobClientLike {
  data = '';
  uploadCalls = 0;
  async upload(data: string, contentLength: number): Promise<unknown> {
    this.uploadCalls++;
    this.data = data;
    assert.equal(contentLength, Buffer.byteLength(data, 'utf8'));
    return {};
  }
  async download(): Promise<{ readableStreamBody?: NodeJS.ReadableStream }> {
    const data = this.data;
    async function* gen(): AsyncGenerator<Buffer> {
      yield Buffer.from(data, 'utf8');
    }
    return { readableStreamBody: gen() as unknown as NodeJS.ReadableStream };
  }
}

class FakeContainerClient implements BlobContainerClientLike {
  readonly blobs = new Map<string, FakeBlockBlobClient>();
  createIfNotExistsCalls = 0;
  async createIfNotExists(): Promise<unknown> {
    this.createIfNotExistsCalls++;
    return {};
  }
  getBlockBlobClient(blobName: string): BlockBlobClientLike {
    let c = this.blobs.get(blobName);
    if (!c) {
      c = new FakeBlockBlobClient();
      this.blobs.set(blobName, c);
    }
    return c;
  }
}

interface FakeBundle {
  readonly clients: AzureConfigStoreClients;
  readonly tables: Map<string, FakeTableClient>;
  readonly container: FakeContainerClient;
}

function makeFakeClients(): FakeBundle {
  const tables = new Map<string, FakeTableClient>();
  const container = new FakeContainerClient();
  const clients: AzureConfigStoreClients = {
    getTableClient(name: string): TableClientLike {
      let t = tables.get(name);
      if (!t) {
        t = new FakeTableClient();
        tables.set(name, t);
      }
      return t;
    },
    getContainerClient(): BlobContainerClientLike {
      return container;
    },
  };
  return { clients, tables, container };
}

function cloneEntity(entity: TableEntityRecord): TableEntityRecord {
  return { ...entity };
}

/**
 * Build a RestError-shaped object that mirrors what `@azure/core-rest-pipeline`
 * throws — `statusCode` plus `response.headers.get('etag')`.
 */
function makeRestError(statusCode: number, etag?: string): Error {
  const err = new Error(`RestError ${statusCode}`) as Error & {
    statusCode: number;
    response: {
      status: number;
      headers: { get: (name: string) => string | undefined };
    };
  };
  err.name = 'RestError';
  err.statusCode = statusCode;
  err.response = {
    status: statusCode,
    headers: {
      get(name: string): string | undefined {
        if (name.toLowerCase() === 'etag' && etag !== undefined) return etag;
        return undefined;
      },
    },
  };
  return err;
}

function lastEntityArg(table: FakeTableClient): TableEntityRecord {
  const last = table.calls[table.calls.length - 1];
  assert.ok(last, 'expected at least one call');
  const entity = (last.args as { entity?: TableEntityRecord }).entity;
  assert.ok(entity, `last call ${last.op} did not carry an entity`);
  return entity as TableEntityRecord;
}

// ---------------------------------------------------------------------------
// AC #1 — Table names
// ---------------------------------------------------------------------------

test('TABLE_NAMES maps the five ConfigRowKinds to the exact wire names', () => {
  // These names are load-bearing: the v1 TypeScript pipeline targets the
  // same table names against the same storage account. Do not rename.
  // (Settings is v2-only — no v1 counterpart to coordinate with.)
  assert.equal(TABLE_NAMES.AgentPrompts, 'AgentPrompts');
  assert.equal(TABLE_NAMES.Workflows, 'Workflows');
  assert.equal(TABLE_NAMES.AgentModels, 'AgentModels');
  assert.equal(TABLE_NAMES.ProjectConfig, 'ProjectConfig');
  assert.equal(TABLE_NAMES.Settings, 'Settings');
  assert.deepEqual(
    Object.keys(TABLE_NAMES).sort(),
    ['AgentModels', 'AgentPrompts', 'ProjectConfig', 'Settings', 'Workflows'],
  );
});

test('upsert addresses the table corresponding to the row kind', async () => {
  const { clients, tables } = makeFakeClients();
  const store = new AzureConfigStore(clients, { tenant: 't', backendKind: 'azure' });

  await store.upsert({ kind: 'AgentPrompts', rowKey: 'r', body: 'a' });
  await store.upsert({ kind: 'Workflows', rowKey: 'r', body: 'a' });
  await store.upsert({ kind: 'AgentModels', rowKey: 'r', body: 'a' });
  await store.upsert({ kind: 'ProjectConfig', rowKey: 'r', body: 'a' });

  assert.ok(tables.has('AgentPrompts'));
  assert.ok(tables.has('Workflows'));
  assert.ok(tables.has('AgentModels'));
  assert.ok(tables.has('ProjectConfig'));
  assert.equal(tables.size, 4);
});

// ---------------------------------------------------------------------------
// AC #2 — PartitionKey is the tenant
// ---------------------------------------------------------------------------

test('upsert sets partitionKey to options.tenant for every kind', async () => {
  const { clients, tables } = makeFakeClients();
  const store = new AzureConfigStore(clients, {
    tenant: 'acme-tenant',
    backendKind: 'azure',
  });

  for (const kind of ['AgentPrompts', 'Workflows', 'AgentModels', 'ProjectConfig'] as const) {
    await store.upsert({ kind, rowKey: `row-${kind}`, body: '{}' });
    const table = tables.get(TABLE_NAMES[kind]);
    assert.ok(table);
    const entity = lastEntityArg(table);
    assert.equal(entity.partitionKey, 'acme-tenant');
    assert.equal(entity.rowKey, `row-${kind}`);
  }
});

test('delete passes the tenant as partitionKey and the caller etag as If-Match', async () => {
  const { clients, tables } = makeFakeClients();
  const store = new AzureConfigStore(clients, { tenant: 'tenant-x', backendKind: 'azure' });

  // Seed a row so the delete reaches deleteEntity.
  await store.upsert({ kind: 'Workflows', rowKey: 'flow-1', body: 'a' });
  const table = tables.get('Workflows');
  assert.ok(table);

  await store.delete('Workflows', 'flow-1', 'W/"caller-etag"');
  const deleteCall = table.calls.find((c) => c.op === 'deleteEntity');
  assert.ok(deleteCall);
  assert.equal((deleteCall.args as { partitionKey: string }).partitionKey, 'tenant-x');
  assert.equal((deleteCall.args as { rowKey: string }).rowKey, 'flow-1');
  assert.equal(
    (deleteCall.args as { options: ConditionalEtagOptions }).options.etag,
    'W/"caller-etag"',
  );
});

test('list filters by PartitionKey = tenant', async () => {
  const { clients, tables } = makeFakeClients();
  const store = new AzureConfigStore(clients, { tenant: 'acme', backendKind: 'azure' });

  // Force the table to exist by writing one row.
  await store.upsert({ kind: 'AgentPrompts', rowKey: 'r', body: 'a' });

  const collected = [];
  for await (const row of store.list('AgentPrompts')) {
    collected.push(row);
  }
  const table = tables.get('AgentPrompts');
  assert.ok(table);
  const listCall = table.calls.find((c) => c.op === 'listEntities');
  assert.ok(listCall);
  const filter = (
    listCall.args as { options: { queryOptions?: { filter?: string } } }
  ).options.queryOptions?.filter;
  assert.equal(filter, "PartitionKey eq 'acme'");
  assert.equal(collected.length, 1);
});

// ---------------------------------------------------------------------------
// AC #3 — 30 KiB overflow threshold + blob-ref formatting
// ---------------------------------------------------------------------------

test('body at or below the threshold stays inline; no blob is created', async () => {
  const { clients, tables, container } = makeFakeClients();
  const store = new AzureConfigStore(clients, {
    tenant: 't',
    backendKind: 'azure',
    overflowThresholdBytes: 100,
  });
  // Exactly at the threshold — must NOT spill. The contract is "above
  // threshold spills", which makes 100 bytes for a 100-byte threshold inline.
  const atLimit = 'x'.repeat(100);
  await store.upsert({ kind: 'AgentPrompts', rowKey: 'k', body: atLimit });

  const table = tables.get('AgentPrompts');
  assert.ok(table);
  const entity = lastEntityArg(table);
  assert.equal(entity.body, atLimit);
  assert.equal(entity.blob_ref, undefined);
  assert.equal(container.blobs.size, 0);
  assert.equal(container.createIfNotExistsCalls, 0);
});

test('body above the threshold spills to <tenant>/<table>/<rowKey> with empty body column', async () => {
  const { clients, tables, container } = makeFakeClients();
  const store = new AzureConfigStore(clients, {
    tenant: 'acme',
    backendKind: 'azure',
    overflowThresholdBytes: 100,
  });
  const big = 'a'.repeat(500);
  await store.upsert({ kind: 'Workflows', rowKey: 'flow/main', body: big });

  // Row carries the marker, not the body.
  const table = tables.get('Workflows');
  assert.ok(table);
  const entity = lastEntityArg(table);
  assert.equal(entity.body, '');
  assert.equal(entity.blob_ref, 'acme/Workflows/flow/main');
  assert.equal(entity.blob_ref, blobRefFor('acme', 'Workflows', 'flow/main'));

  // Blob carries the body, and the container was provisioned lazily once.
  const blob = container.blobs.get('acme/Workflows/flow/main') as
    | FakeBlockBlobClient
    | undefined;
  assert.ok(blob);
  assert.equal(blob.data, big);
  assert.equal(blob.uploadCalls, 1);
  assert.equal(container.createIfNotExistsCalls, 1);
});

test('overflow threshold defaults to 30 KiB measured in UTF-8 bytes', async () => {
  const { clients, container } = makeFakeClients();
  const store = new AzureConfigStore(clients, { tenant: 't', backendKind: 'azure' });

  // 30 KiB exactly — must not spill (above-threshold rule).
  const exact = 'a'.repeat(30720);
  assert.equal(Buffer.byteLength(exact, 'utf8'), 30720);
  await store.upsert({ kind: 'AgentPrompts', rowKey: 'small', body: exact });
  assert.equal(container.blobs.size, 0);

  // One byte over — must spill.
  const over = 'a'.repeat(30721);
  await store.upsert({ kind: 'AgentPrompts', rowKey: 'large', body: over });
  assert.equal(container.blobs.size, 1);
  assert.ok(container.blobs.has('t/AgentPrompts/large'));
});

test('threshold is byte-based not character-based: multi-byte chars push small strings over', async () => {
  const { clients, tables, container } = makeFakeClients();
  const store = new AzureConfigStore(clients, {
    tenant: 't',
    backendKind: 'azure',
    overflowThresholdBytes: 10,
  });
  // U+1F600 (😀) is 4 UTF-8 bytes per codepoint. Five of them = 20 bytes,
  // well over the 10-byte threshold even though the JS string length is 10.
  const emoji = '\u{1F600}'.repeat(5);
  assert.equal(Buffer.byteLength(emoji, 'utf8'), 20);

  await store.upsert({ kind: 'AgentModels', rowKey: 'r', body: emoji });
  const table = tables.get('AgentModels');
  assert.ok(table);
  const entity = lastEntityArg(table);
  assert.equal(entity.body, '');
  assert.equal(entity.blob_ref, 't/AgentModels/r');
  assert.equal(container.blobs.get('t/AgentModels/r')?.data, emoji);
});

test('blobRefFor formats <tenant>/<table>/<rowKey> verbatim', () => {
  assert.equal(blobRefFor('acme', 'AgentPrompts', 'developer/system'), 'acme/AgentPrompts/developer/system');
  assert.equal(blobRefFor('t', 'ProjectConfig', 'proj-1'), 't/ProjectConfig/proj-1');
});

// ---------------------------------------------------------------------------
// AC #4 — RequestFailed(412) → ConcurrencyError with server ETag
// ---------------------------------------------------------------------------

test('upsert without etag uses upsertEntity (unconditional replace)', async () => {
  const { clients, tables } = makeFakeClients();
  const store = new AzureConfigStore(clients, { tenant: 't', backendKind: 'azure' });
  await store.upsert({ kind: 'AgentPrompts', rowKey: 'k', body: 'a' });
  const table = tables.get('AgentPrompts');
  assert.ok(table);
  const ops = table.calls.map((c) => c.op);
  assert.deepEqual(ops, ['upsertEntity']);
});

test('upsert with etag uses updateEntity and a 412 maps to ConcurrencyError carrying the server etag', async () => {
  const { clients, tables } = makeFakeClients();
  const store = new AzureConfigStore(clients, { tenant: 't', backendKind: 'azure' });

  // Seed the row so updateEntity is the next op.
  await store.upsert({ kind: 'AgentPrompts', rowKey: 'k', body: 'a' });
  const table = tables.get('AgentPrompts');
  assert.ok(table);
  table.raise412OnUpdate = true;
  table.serverEtagOnConflict = 'W/"server-current"';

  await assert.rejects(
    () =>
      store.upsert({
        kind: 'AgentPrompts',
        rowKey: 'k',
        body: 'b',
        etag: 'W/"stale-caller"',
      }),
    (err: unknown) =>
      err instanceof ConcurrencyError && err.conflictingEtag === 'W/"server-current"',
  );

  // The caller's etag was passed through to updateEntity (If-Match).
  const updateCall = table.calls.find((c) => c.op === 'updateEntity');
  assert.ok(updateCall);
  const options = (updateCall.args as { options: ConditionalEtagOptions }).options;
  assert.equal(options.etag, 'W/"stale-caller"');
});

test('delete with stale etag maps RequestFailed(412) to ConcurrencyError', async () => {
  const { clients, tables } = makeFakeClients();
  const store = new AzureConfigStore(clients, { tenant: 't', backendKind: 'azure' });

  await store.upsert({ kind: 'Workflows', rowKey: 'k', body: 'a' });
  const table = tables.get('Workflows');
  assert.ok(table);
  table.raise412OnDelete = true;
  table.serverEtagOnConflict = 'W/"server-9"';

  await assert.rejects(
    () => store.delete('Workflows', 'k', 'W/"stale"'),
    (err: unknown) =>
      err instanceof ConcurrencyError && err.conflictingEtag === 'W/"server-9"',
  );
});

test('non-412 errors propagate unchanged (e.g. 500 from updateEntity)', async () => {
  const { clients, tables } = makeFakeClients();
  const store = new AzureConfigStore(clients, { tenant: 't', backendKind: 'azure' });

  await store.upsert({ kind: 'AgentPrompts', rowKey: 'k', body: 'a' });
  const table = tables.get('AgentPrompts');
  assert.ok(table);

  // Replace the updateEntity behavior to throw a 500.
  const original = table.updateEntity.bind(table);
  table.updateEntity = async (): Promise<{ etag: string }> => {
    throw makeRestError(500);
  };
  try {
    await assert.rejects(
      () =>
        store.upsert({
          kind: 'AgentPrompts',
          rowKey: 'k',
          body: 'b',
          etag: 'W/"any"',
        }),
      (err: unknown) =>
        err instanceof Error &&
        !(err instanceof ConcurrencyError) &&
        /RestError 500/.test(err.message),
    );
  } finally {
    table.updateEntity = original;
  }
});

// ---------------------------------------------------------------------------
// AC #5 — 404 → null on get
// ---------------------------------------------------------------------------

test('get returns null when the table client throws a 404 RestError', async () => {
  const { clients, tables } = makeFakeClients();
  // Pre-create the table client and arm the 404 knob.
  const empty = clients.getTableClient('AgentPrompts') as FakeTableClient;
  empty.raise404OnGet = true;

  const store = new AzureConfigStore(clients, { tenant: 't', backendKind: 'azure' });
  const got = await store.get('AgentPrompts', 'nonexistent');
  assert.equal(got, null);
  assert.equal(tables.get('AgentPrompts')?.calls.find((c) => c.op === 'getEntity')?.args.rowKey, 'nonexistent');
});

test('get for a row that simply does not exist returns null too', async () => {
  const { clients } = makeFakeClients();
  const store = new AzureConfigStore(clients, { tenant: 't', backendKind: 'azure' });
  // Nothing seeded — the fake throws RestError 404 on miss.
  assert.equal(await store.get('AgentPrompts', 'missing'), null);
});

// ---------------------------------------------------------------------------
// AC #6 — ProjectConfig: project.json (body) + context.md (sibling column)
// ---------------------------------------------------------------------------

test('ProjectConfig persists project.json in body and context.md in a sibling column', async () => {
  const { clients, tables } = makeFakeClients();
  const store = new AzureConfigStore(clients, { tenant: 'acme', backendKind: 'azure' });

  await store.upsert({
    kind: 'ProjectConfig',
    rowKey: 'proj-1',
    body: '{"name":"proj-1"}',
    metadata: { context_md: '# Hello', schema: 'v1' },
  });

  const table = tables.get('ProjectConfig');
  assert.ok(table);
  const entity = lastEntityArg(table);
  assert.equal(entity.body, '{"name":"proj-1"}');
  assert.equal(entity.context_md, '# Hello');
  assert.equal(entity.context_md_blob_ref, undefined);

  // Remaining metadata keys are kept in metadata_json (context_md is
  // promoted to its own column so it doesn't show up here).
  const metaJson = JSON.parse(entity.metadata_json as string) as Record<string, string>;
  assert.deepEqual(metaJson, { schema: 'v1' });
});

test('ProjectConfig spills oversized context.md to its own blob path', async () => {
  const { clients, tables, container } = makeFakeClients();
  const store = new AzureConfigStore(clients, {
    tenant: 'acme',
    backendKind: 'azure',
    overflowThresholdBytes: 50,
  });
  const longCtx = 'x'.repeat(200);

  await store.upsert({
    kind: 'ProjectConfig',
    rowKey: 'proj-1',
    body: '{}',
    metadata: { context_md: longCtx },
  });

  const table = tables.get('ProjectConfig');
  assert.ok(table);
  const entity = lastEntityArg(table);
  assert.equal(entity.body, '{}');
  assert.equal(entity.context_md, '');
  assert.equal(entity.context_md_blob_ref, 'acme/ProjectConfig/proj-1.context_md');
  const blob = container.blobs.get('acme/ProjectConfig/proj-1.context_md');
  assert.ok(blob);
  assert.equal(blob.data, longCtx);
});

test('ProjectConfig round-trips body + context.md through get (inline path)', async () => {
  const { clients } = makeFakeClients();
  const store = new AzureConfigStore(clients, { tenant: 'acme', backendKind: 'azure' });
  await store.upsert({
    kind: 'ProjectConfig',
    rowKey: 'proj-1',
    body: '{"name":"proj-1"}',
    metadata: { context_md: '# ctx', schema: 'v1' },
  });
  const back = await store.get('ProjectConfig', 'proj-1');
  assert.ok(back);
  assert.equal(back.body, '{"name":"proj-1"}');
  assert.equal(back.metadata.context_md, '# ctx');
  assert.equal(back.metadata.schema, 'v1');
});

test('ProjectConfig round-trips body + context.md through get (overflow path)', async () => {
  const { clients } = makeFakeClients();
  const store = new AzureConfigStore(clients, {
    tenant: 'acme',
    backendKind: 'azure',
    overflowThresholdBytes: 20,
  });
  const body = 'a'.repeat(100);
  const ctx = 'b'.repeat(200);
  await store.upsert({
    kind: 'ProjectConfig',
    rowKey: 'proj-1',
    body,
    metadata: { context_md: ctx },
  });
  const back = await store.get('ProjectConfig', 'proj-1');
  assert.ok(back);
  assert.equal(back.body, body);
  assert.equal(back.metadata.context_md, ctx);
});

// ---------------------------------------------------------------------------
// ETag pass-through and ConfigStore-port assignability
// ---------------------------------------------------------------------------

test('upsert returns the new etag from the table client verbatim', async () => {
  const { clients, tables } = makeFakeClients();
  const store = new AzureConfigStore(clients, { tenant: 't', backendKind: 'azure' });
  const row = await store.upsert({ kind: 'AgentPrompts', rowKey: 'k', body: 'a' });
  const table = tables.get('AgentPrompts');
  assert.ok(table);
  // Reach into the fake to confirm the etag we returned matches what the
  // table client minted — the adapter must not rewrap it.
  const stored = await table.getEntity('t', 'k');
  assert.equal(row.etag, stored.etag);
  assert.ok(row.etag.startsWith('W/"'));
});

test('AzureConfigStore is assignable to the ConfigStore port', () => {
  const { clients } = makeFakeClients();
  // Compile-time check: this assignment fails if the surface drifts.
  const store: ConfigStore = new AzureConfigStore(clients, {
    tenant: 't',
    backendKind: 'azure',
  });
  assert.equal(typeof store.get, 'function');
  assert.equal(typeof store.upsert, 'function');
  assert.equal(typeof store.delete, 'function');
  assert.equal(typeof store.list, 'function');
});

test('constructor rejects an empty tenant', () => {
  const { clients } = makeFakeClients();
  assert.throws(
    () => new AzureConfigStore(clients, { tenant: '', backendKind: 'azure' }),
    /tenant/,
  );
});
