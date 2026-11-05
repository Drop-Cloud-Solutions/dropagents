/**
 * Unit tests for `DualConfigStore`.
 *
 * Both inner stores are replaced with hand-rolled mock `ConfigStore`s that
 * record every call (the TypeScript / `node:test` analogue of the NSubstitute
 * mocks called out in TASK.md). No filesystem and no Azure SDK is involved,
 * so the suite exercises the dual-write semantics in isolation.
 *
 * Coverage maps to acceptance criteria:
 *
 *   AC #1 Writes Fs first then Azure                  → "upsert writes Fs ..." +
 *                                                       "delete writes Fs ..." tests
 *   AC #2 Azure failures logged at Warning, swallowed → "upsert logs and swallows ..." +
 *                                                       "delete logs and swallows ..." tests
 *   AC #3 Get returns Fs row without consulting Azure → "get returns Fs row ..." test
 *   AC #4 Get falls back + write-through to Fs        → "get falls back to Azure ..." test
 *   AC #5 List unions deduplicated by rowKey, Fs wins → "list unions Fs and Azure ..." test
 *   AC #6 ETag returned to callers originates from Fs → "etag from get/list/upsert ..." tests
 *   AC #7 Tests use mock IConfigStores                 → this file
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import {
  ConcurrencyError,
  type ConfigRow,
  type ConfigRowKind,
  type ConfigRowUpsert,
  type ConfigStore,
  type Logger,
} from '../../core/ports';

import { DualConfigStore } from './DualConfigStore';

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

interface RecordedCall {
  readonly target: 'fs' | 'azure';
  readonly op: 'get' | 'upsert' | 'delete' | 'list';
  readonly args: Readonly<Record<string, unknown>>;
}

class MockConfigStore implements ConfigStore {
  /** Backing store of rows keyed by `${kind}|${rowKey}`. */
  private readonly rows = new Map<string, ConfigRow>();
  /** Per-instance etag counter so etags are deterministic + adapter-distinct. */
  private etagSeq = 0;

  constructor(
    private readonly tag: 'fs' | 'azure',
    /** Shared call ledger so tests can assert call ordering across both mocks. */
    private readonly ledger: RecordedCall[],
  ) {}

  /** Knobs the tests toggle to simulate failures from a specific operation. */
  failOn: Partial<Record<'get' | 'upsert' | 'delete' | 'list', Error>> = {};

  private key(kind: ConfigRowKind, rowKey: string): string {
    return `${kind}|${rowKey}`;
  }

  /** Direct seed used by tests to plant rows without going through `upsert`. */
  seed(row: ConfigRow): void {
    this.rows.set(this.key(row.kind, row.rowKey), row);
  }

  private mintEtag(): string {
    return `${this.tag}-etag-${++this.etagSeq}`;
  }

  async get(kind: ConfigRowKind, rowKey: string): Promise<ConfigRow | null> {
    this.ledger.push({ target: this.tag, op: 'get', args: { kind, rowKey } });
    if (this.failOn.get) throw this.failOn.get;
    return this.rows.get(this.key(kind, rowKey)) ?? null;
  }

  async upsert(spec: ConfigRowUpsert): Promise<ConfigRow> {
    this.ledger.push({ target: this.tag, op: 'upsert', args: { spec } });
    if (this.failOn.upsert) throw this.failOn.upsert;
    const row: ConfigRow = {
      kind: spec.kind,
      rowKey: spec.rowKey,
      body: spec.body,
      metadata: spec.metadata ? { ...spec.metadata } : {},
      etag: this.mintEtag(),
      updatedAt: new Date(0),
    };
    this.rows.set(this.key(spec.kind, spec.rowKey), row);
    return row;
  }

  async delete(kind: ConfigRowKind, rowKey: string, etag: string): Promise<void> {
    this.ledger.push({ target: this.tag, op: 'delete', args: { kind, rowKey, etag } });
    if (this.failOn.delete) throw this.failOn.delete;
    this.rows.delete(this.key(kind, rowKey));
  }

  async *list(kind: ConfigRowKind): AsyncIterable<ConfigRow> {
    this.ledger.push({ target: this.tag, op: 'list', args: { kind } });
    if (this.failOn.list) throw this.failOn.list;
    for (const row of this.rows.values()) {
      if (row.kind === kind) yield row;
    }
  }
}

interface RecordedLog {
  readonly level: 'info' | 'warn' | 'error' | 'debug';
  readonly message: string;
  readonly meta?: Readonly<Record<string, unknown>>;
}

class RecordingLogger implements Logger {
  readonly entries: RecordedLog[] = [];
  info(message: string, meta?: Readonly<Record<string, unknown>>): void {
    this.entries.push({ level: 'info', message, meta });
  }
  warn(message: string, meta?: Readonly<Record<string, unknown>>): void {
    this.entries.push({ level: 'warn', message, meta });
  }
  error(message: string, meta?: Readonly<Record<string, unknown>>): void {
    this.entries.push({ level: 'error', message, meta });
  }
  debug(message: string, meta?: Readonly<Record<string, unknown>>): void {
    this.entries.push({ level: 'debug', message, meta });
  }
}

interface Harness {
  readonly store: DualConfigStore;
  readonly fs: MockConfigStore;
  readonly azure: MockConfigStore;
  readonly logger: RecordingLogger;
  readonly ledger: RecordedCall[];
}

function makeHarness(): Harness {
  const ledger: RecordedCall[] = [];
  const fs = new MockConfigStore('fs', ledger);
  const azure = new MockConfigStore('azure', ledger);
  const logger = new RecordingLogger();
  const store = new DualConfigStore({ fs, azure, logger });
  return { store, fs, azure, logger, ledger };
}

function row(
  tag: 'fs' | 'azure',
  kind: ConfigRowKind,
  rowKey: string,
  body: string,
  etagSuffix: string,
): ConfigRow {
  return {
    kind,
    rowKey,
    body,
    metadata: {},
    etag: `${tag}-seed-${etagSuffix}`,
    updatedAt: new Date(0),
  };
}

async function collect(iter: AsyncIterable<ConfigRow>): Promise<ConfigRow[]> {
  const out: ConfigRow[] = [];
  for await (const r of iter) out.push(r);
  return out;
}

function opSequence(ledger: RecordedCall[]): string[] {
  return ledger.map((c) => `${c.target}.${c.op}`);
}

// ---------------------------------------------------------------------------
// AC #1: writes go to Fs first, then Azure (both upsert and delete)
// ---------------------------------------------------------------------------

test('upsert writes Fs first then Azure on the happy path', async () => {
  const { store, fs, azure, ledger } = makeHarness();

  const result = await store.upsert({
    kind: 'AgentPrompts',
    rowKey: 'developer',
    body: 'be terse',
  });

  // Ordering: Fs upsert must be observed before Azure upsert.
  assert.deepEqual(opSequence(ledger), ['fs.upsert', 'azure.upsert']);

  // Both stores received the same body.
  const fsRow = await fs.get('AgentPrompts', 'developer');
  const azRow = await azure.get('AgentPrompts', 'developer');
  assert.ok(fsRow && azRow);
  assert.equal(fsRow!.body, 'be terse');
  assert.equal(azRow!.body, 'be terse');

  // AC #6: the returned etag is the Fs-side etag.
  assert.ok(result.etag.startsWith('fs-etag-'));
});

test('delete writes Fs first then Azure on the happy path', async () => {
  const { store, fs, azure, ledger } = makeHarness();
  fs.seed(row('fs', 'Workflows', 'w', '{}', '1'));
  azure.seed(row('azure', 'Workflows', 'w', '{}', '1'));

  await store.delete('Workflows', 'w', 'fs-seed-1');

  // Sequence: fs.delete → azure.get (to discover its etag) → azure.delete.
  assert.deepEqual(opSequence(ledger), ['fs.delete', 'azure.get', 'azure.delete']);

  assert.equal(await fs.get('Workflows', 'w'), null);
  assert.equal(await azure.get('Workflows', 'w'), null);
});

// ---------------------------------------------------------------------------
// AC #2: Azure failures during writes are logged at Warning and not propagated
// ---------------------------------------------------------------------------

test('upsert logs and swallows an Azure failure, returning the Fs row', async () => {
  const { store, fs, azure, logger } = makeHarness();
  azure.failOn.upsert = new Error('azure tables 503');

  // Must not throw.
  const result = await store.upsert({
    kind: 'AgentModels',
    rowKey: 'developer',
    body: 'claude-opus-4-7',
  });

  // Fs side is durable.
  const fsRow = await fs.get('AgentModels', 'developer');
  assert.ok(fsRow);
  assert.equal(fsRow!.body, 'claude-opus-4-7');

  // Returned row is the Fs row (AC #6 — etag from Fs).
  assert.ok(result.etag.startsWith('fs-etag-'));

  // The Azure failure surfaced as a single Warning carrying enough context
  // to diagnose without leaking the underlying error type.
  const warns = logger.entries.filter((e) => e.level === 'warn');
  assert.equal(warns.length, 1);
  assert.match(warns[0]!.message, /Azure upsert failed/);
  assert.equal(warns[0]!.meta?.kind, 'AgentModels');
  assert.equal(warns[0]!.meta?.rowKey, 'developer');
  assert.equal(warns[0]!.meta?.error, 'azure tables 503');
});

test('delete logs and swallows an Azure failure, leaving Fs deleted', async () => {
  const { store, fs, azure, logger } = makeHarness();
  fs.seed(row('fs', 'AgentPrompts', 'r', 'v1', '1'));
  azure.seed(row('azure', 'AgentPrompts', 'r', 'v1', '1'));
  azure.failOn.delete = new Error('azure tables 503');

  // Must not throw.
  await store.delete('AgentPrompts', 'r', 'fs-seed-1');

  // Fs side is gone.
  assert.equal(await fs.get('AgentPrompts', 'r'), null);

  // Single Warning describing the swallowed Azure failure.
  const warns = logger.entries.filter((e) => e.level === 'warn');
  assert.equal(warns.length, 1);
  assert.match(warns[0]!.message, /Azure delete failed/);
});

test('upsert propagates Fs failures without touching Azure', async () => {
  const { store, fs, azure, ledger } = makeHarness();
  fs.failOn.upsert = new ConcurrencyError('row exists', 'fs-current-etag');

  await assert.rejects(
    () => store.upsert({ kind: 'Workflows', rowKey: 'w', body: '{}' }),
    (err: unknown) => err instanceof ConcurrencyError,
  );

  // Azure must never have been called because Fs is the source of truth.
  assert.deepEqual(opSequence(ledger), ['fs.upsert']);
  assert.equal(await azure.get('Workflows', 'w'), null);
});

// ---------------------------------------------------------------------------
// AC #3: get returns the Fs row when present without consulting Azure
// ---------------------------------------------------------------------------

test('get returns the Fs row when present without consulting Azure', async () => {
  const { store, fs, azure, ledger } = makeHarness();
  fs.seed(row('fs', 'AgentPrompts', 'p', 'local-body', '1'));
  azure.seed(row('azure', 'AgentPrompts', 'p', 'remote-body', '1'));

  const out = await store.get('AgentPrompts', 'p');

  assert.ok(out);
  assert.equal(out!.body, 'local-body');
  // AC #6: etag originates from Fs.
  assert.equal(out!.etag, 'fs-seed-1');
  // AC #3: Azure was not consulted.
  assert.deepEqual(opSequence(ledger), ['fs.get']);
});

// ---------------------------------------------------------------------------
// AC #4: get falls back to Azure and write-through caches into Fs
// ---------------------------------------------------------------------------

test('get falls back to Azure on Fs miss and write-through caches the row in Fs', async () => {
  const { store, azure, ledger } = makeHarness();
  azure.seed(row('azure', 'Workflows', 'wf', 'remote-only', '1'));

  const out = await store.get('Workflows', 'wf');

  assert.ok(out);
  assert.equal(out!.body, 'remote-only');
  // AC #6: returned etag is the Fs etag minted by the write-through upsert,
  // NOT the original Azure-side etag.
  assert.ok(out!.etag.startsWith('fs-etag-'));
  assert.notEqual(out!.etag, 'azure-seed-1');

  // Sequence: fs.get (miss) → azure.get (hit) → fs.upsert (write-through).
  assert.deepEqual(opSequence(ledger), ['fs.get', 'azure.get', 'fs.upsert']);

  // The row is now cached locally so subsequent reads do not consult Azure.
  ledger.length = 0;
  const cached = await store.get('Workflows', 'wf');
  assert.ok(cached);
  assert.equal(cached!.body, 'remote-only');
  assert.deepEqual(opSequence(ledger), ['fs.get']);
});

test('get returns null when neither Fs nor Azure has the row', async () => {
  const { store, ledger } = makeHarness();
  const out = await store.get('AgentPrompts', 'nope');
  assert.equal(out, null);
  assert.deepEqual(opSequence(ledger), ['fs.get', 'azure.get']);
});

// ---------------------------------------------------------------------------
// AC #5: list unions both adapters' results deduplicated by rowKey, Fs preferred
// ---------------------------------------------------------------------------

test('list unions Fs and Azure deduplicated by rowKey, preferring the Fs version', async () => {
  const { store, fs, azure } = makeHarness();

  // Three rows in Fs (one overlaps with Azure).
  fs.seed(row('fs', 'AgentPrompts', 'dev', 'fs-dev', '1'));
  fs.seed(row('fs', 'AgentPrompts', 'review', 'fs-review', '2'));

  // Two rows in Azure, one of which (`dev`) overlaps with Fs.
  azure.seed(row('azure', 'AgentPrompts', 'dev', 'azure-dev-stale', '1'));
  azure.seed(row('azure', 'AgentPrompts', 'tester', 'azure-tester', '2'));

  const rows = await collect(store.list('AgentPrompts'));

  // Three distinct rowKeys, no duplicates.
  const byKey = new Map(rows.map((r) => [r.rowKey, r]));
  assert.equal(byKey.size, 3);
  assert.deepEqual([...byKey.keys()].sort(), ['dev', 'review', 'tester']);

  // Overlap resolves to the Fs version (its body wins).
  assert.equal(byKey.get('dev')!.body, 'fs-dev');
  // AC #6: the overlapping row's etag is the Fs etag, not the Azure one.
  assert.equal(byKey.get('dev')!.etag, 'fs-seed-1');

  // The Azure-only row was write-through cached into Fs so its returned
  // etag also originates from Fs (AC #6).
  const testerRow = byKey.get('tester')!;
  assert.equal(testerRow.body, 'azure-tester');
  assert.ok(testerRow.etag.startsWith('fs-etag-'));

  // After listing, the Azure-only row is materialised in Fs.
  const cached = await fs.get('AgentPrompts', 'tester');
  assert.ok(cached);
  assert.equal(cached!.body, 'azure-tester');
});

// ---------------------------------------------------------------------------
// AC #6: ETag returned to callers always originates from Fs — checked alongside
// each of the dedicated upsert/get/list tests above, plus this aggregated
// belt-and-braces check covering every surface in one place.
// ---------------------------------------------------------------------------

test('etag from get/list/upsert always originates from Fs', async () => {
  const { store, fs, azure } = makeHarness();

  // 1. upsert
  const u = await store.upsert({ kind: 'AgentModels', rowKey: 'a', body: 'm1' });
  assert.ok(u.etag.startsWith('fs-etag-'));

  // 2. get hit on Fs
  fs.seed(row('fs', 'AgentModels', 'b', 'm2', 'X'));
  const localHit = await store.get('AgentModels', 'b');
  assert.equal(localHit!.etag, 'fs-seed-X');

  // 3. get fallback to Azure → write-through → Fs etag
  azure.seed(row('azure', 'AgentModels', 'c', 'm3', '1'));
  const remoteHit = await store.get('AgentModels', 'c');
  assert.ok(remoteHit!.etag.startsWith('fs-etag-'));
  assert.notEqual(remoteHit!.etag, 'azure-seed-1');

  // 4. list — overlapping AND Azure-only both yield Fs etags.
  azure.seed(row('azure', 'AgentModels', 'a', 'azure-shadow', '1'));
  azure.seed(row('azure', 'AgentModels', 'd', 'm4', '2'));
  const all = await collect(store.list('AgentModels'));
  for (const r of all) {
    assert.ok(
      r.etag.startsWith('fs-'),
      `row ${r.rowKey} should carry an Fs-side etag but had ${r.etag}`,
    );
  }
});
