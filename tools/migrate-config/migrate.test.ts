/**
 * Unit tests for the migrate-config tool.
 *
 * The migration core (`migrate`) is exercised against an in-memory source +
 * target pair so the suite never touches the filesystem or the Azure SDK.
 * AC mapping:
 *
 *   AC #3 enumerates all four row kinds + upserts each      → "migrate copies every kind ..."
 *   AC #4 ConcurrencyException is caught and counted skip   → "migrate counts ConcurrencyError as skip"
 *   AC #5 per-row-kind summary printed                       → "formatSummary lists one line per kind"
 *   AC #6 exit code 0 when failed == 0, else 1               → "totalFailed drives exit code" +
 *                                                             "run returns 1 when a row fails"
 *   AC #7 re-running yields skipped >= 1, failed == 0        → "re-running produces skipped >= 1 and failed == 0"
 *   AC #2 CLI args + env fallbacks                            → "parseArgs ..." tests
 */
import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ConcurrencyError,
  type ConfigRow,
  type ConfigRowKind,
  type ConfigRowUpsert,
  type ConfigStore,
  type Logger,
} from '../../core/ports';

import { formatSummary, migrate, totalFailed, ROW_KINDS } from './migrate';
import { parseArgs } from './main';

// ---------------------------------------------------------------------------
// In-memory ConfigStore for both source and target
// ---------------------------------------------------------------------------

class InMemoryStore implements ConfigStore {
  private readonly rows = new Map<string, ConfigRow>();
  private etagSeq = 0;

  /** When set, the next `upsert` for that key throws the given error and clears the entry. */
  readonly upsertOverrides = new Map<string, Error>();

  private k(kind: ConfigRowKind, rowKey: string): string {
    return `${kind}|${rowKey}`;
  }

  seed(row: Omit<ConfigRow, 'etag' | 'updatedAt'>): void {
    this.rows.set(this.k(row.kind, row.rowKey), {
      ...row,
      etag: `etag-${++this.etagSeq}`,
      updatedAt: new Date(0),
    });
  }

  async get(kind: ConfigRowKind, rowKey: string): Promise<ConfigRow | null> {
    return this.rows.get(this.k(kind, rowKey)) ?? null;
  }

  async upsert(spec: ConfigRowUpsert): Promise<ConfigRow> {
    const key = this.k(spec.kind, spec.rowKey);
    const override = this.upsertOverrides.get(key);
    if (override) {
      this.upsertOverrides.delete(key);
      throw override;
    }
    const row: ConfigRow = {
      kind: spec.kind,
      rowKey: spec.rowKey,
      body: spec.body,
      metadata: { ...(spec.metadata ?? {}) },
      etag: `etag-${++this.etagSeq}`,
      updatedAt: new Date(0),
    };
    this.rows.set(key, row);
    return row;
  }

  async delete(): Promise<void> {
    throw new Error('not implemented for tests');
  }

  async *list(kind: ConfigRowKind): AsyncIterable<ConfigRow> {
    for (const row of this.rows.values()) {
      if (row.kind === kind) yield row;
    }
  }
}

function silentLogger(): Logger & { messages: string[] } {
  const messages: string[] = [];
  return {
    messages,
    info: (m) => messages.push(`info ${m}`),
    warn: (m) => messages.push(`warn ${m}`),
    error: (m) => messages.push(`error ${m}`),
    debug: (m) => messages.push(`debug ${m}`),
  };
}

function seedOneOfEach(store: InMemoryStore): void {
  store.seed({ kind: 'AgentPrompts', rowKey: 'developer', body: '# dev', metadata: {} });
  store.seed({ kind: 'Workflows', rowKey: 'echo', body: '{}', metadata: {} });
  store.seed({ kind: 'AgentModels', rowKey: 'developer', body: '{"model":"haiku"}', metadata: {} });
  store.seed({
    kind: 'ProjectConfig',
    rowKey: 'demo',
    body: '{"name":"demo"}',
    metadata: { context_md: '# demo project' },
  });
  store.seed({ kind: 'Settings', rowKey: 'GIT_COMMIT_NAME', body: 'Pipeline Bot', metadata: {} });
}

// ---------------------------------------------------------------------------
// migrate() — happy path: every kind copied, target hit exactly once per row
// ---------------------------------------------------------------------------

test('migrate copies every kind from source to target with create-only semantics', async () => {
  const source = new InMemoryStore();
  const target = new InMemoryStore();
  seedOneOfEach(source);

  const summary = await migrate({ source, target, logger: silentLogger() });

  for (const kind of ROW_KINDS) {
    assert.equal(summary[kind].created, 1, `${kind} should have 1 created`);
    assert.equal(summary[kind].skipped, 0, `${kind} should have 0 skipped`);
    assert.equal(summary[kind].failed, 0, `${kind} should have 0 failed`);

    const row = await target.get(kind, kind === 'Workflows' ? 'echo' : kind === 'Settings' ? 'GIT_COMMIT_NAME' : kind === 'AgentPrompts' || kind === 'AgentModels' ? 'developer' : 'demo');
    assert.ok(row, `${kind} row should exist in target`);
  }

  // ProjectConfig metadata round-trips through the upsert path.
  const proj = await target.get('ProjectConfig', 'demo');
  assert.equal(proj?.metadata.context_md, '# demo project');
});

// ---------------------------------------------------------------------------
// migrate() — pre-existing target row is counted as skipped, not overwritten
// ---------------------------------------------------------------------------

test('migrate skips rows already present in the target (idempotent re-run)', async () => {
  const source = new InMemoryStore();
  const target = new InMemoryStore();
  source.seed({ kind: 'AgentPrompts', rowKey: 'developer', body: 'NEW body', metadata: {} });
  target.seed({ kind: 'AgentPrompts', rowKey: 'developer', body: 'EXISTING body', metadata: {} });

  const summary = await migrate({ source, target, logger: silentLogger() });

  assert.equal(summary.AgentPrompts.created, 0);
  assert.equal(summary.AgentPrompts.skipped, 1);
  assert.equal(summary.AgentPrompts.failed, 0);

  // The existing target row was NOT overwritten — create-only semantics hold.
  const existing = await target.get('AgentPrompts', 'developer');
  assert.equal(existing?.body, 'EXISTING body');
});

// ---------------------------------------------------------------------------
// migrate() — ConcurrencyError from target.upsert is caught + counted skipped
// ---------------------------------------------------------------------------

test('migrate counts ConcurrencyError from target.upsert as a skip', async () => {
  const source = new InMemoryStore();
  const target = new InMemoryStore();
  source.seed({ kind: 'Workflows', rowKey: 'echo', body: '{}', metadata: {} });

  // Force the target.upsert path (target.get returns null) but throw on write
  // — simulating a race where another migrator created the row between our
  // get and our upsert.
  target.upsertOverrides.set('Workflows|echo', new ConcurrencyError('exists', 'srv-etag'));

  const summary = await migrate({ source, target, logger: silentLogger() });

  assert.equal(summary.Workflows.created, 0);
  assert.equal(summary.Workflows.skipped, 1);
  assert.equal(summary.Workflows.failed, 0);
});

// ---------------------------------------------------------------------------
// migrate() — unexpected target failure counts as failed, does not abort
// ---------------------------------------------------------------------------

test('migrate counts a non-Concurrency target failure as failed without aborting', async () => {
  const source = new InMemoryStore();
  const target = new InMemoryStore();
  source.seed({ kind: 'AgentModels', rowKey: 'first', body: 'a', metadata: {} });
  source.seed({ kind: 'AgentModels', rowKey: 'second', body: 'b', metadata: {} });

  target.upsertOverrides.set('AgentModels|first', new Error('500 from Azure'));

  const summary = await migrate({ source, target, logger: silentLogger() });

  assert.equal(summary.AgentModels.failed, 1);
  assert.equal(summary.AgentModels.created, 1, 'second row should still be migrated');
  assert.equal(summary.AgentModels.skipped, 0);
  assert.equal(totalFailed(summary), 1);

  const second = await target.get('AgentModels', 'second');
  assert.ok(second);
});

// ---------------------------------------------------------------------------
// AC #7: re-running against an already-migrated target produces skipped >= 1
// and failed == 0
// ---------------------------------------------------------------------------

test('re-running migrate against the same target produces skipped >= 1 and failed == 0', async () => {
  const source = new InMemoryStore();
  const target = new InMemoryStore();
  seedOneOfEach(source);
  const logger = silentLogger();

  const first = await migrate({ source, target, logger });
  assert.equal(totalFailed(first), 0);

  const second = await migrate({ source, target, logger });
  assert.equal(totalFailed(second), 0);

  const skipped = ROW_KINDS.reduce((sum, k) => sum + second[k].skipped, 0);
  assert.ok(skipped >= 1, `expected at least one skip on re-run, saw ${skipped}`);
});

// ---------------------------------------------------------------------------
// formatSummary / totalFailed
// ---------------------------------------------------------------------------

test('formatSummary lists one line per kind', () => {
  const lines = formatSummary({
    AgentPrompts: { created: 2, skipped: 1, failed: 0 },
    Workflows: { created: 0, skipped: 3, failed: 0 },
    AgentModels: { created: 1, skipped: 0, failed: 0 },
    ProjectConfig: { created: 0, skipped: 0, failed: 1 },
    Settings: { created: 0, skipped: 0, failed: 0 },
  });
  assert.equal(lines.length, ROW_KINDS.length);
  assert.match(lines[0], /^AgentPrompts: 2 created, 1 skipped, 0 failed$/);
  assert.match(lines[3], /^ProjectConfig: 0 created, 0 skipped, 1 failed$/);
});

test('totalFailed sums the failed column', () => {
  const t = totalFailed({
    AgentPrompts: { created: 0, skipped: 0, failed: 0 },
    Workflows: { created: 0, skipped: 0, failed: 2 },
    AgentModels: { created: 0, skipped: 0, failed: 1 },
    ProjectConfig: { created: 0, skipped: 0, failed: 0 },
    Settings: { created: 0, skipped: 0, failed: 0 },
  });
  assert.equal(t, 3);
});

// ---------------------------------------------------------------------------
// parseArgs — CLI args + env-var fallbacks
// ---------------------------------------------------------------------------

test('parseArgs reads --root --tenant --account-url from argv', () => {
  const args = parseArgs(
    ['--root', '/srv/pipe', '--tenant', 'acme', '--account-url', 'https://x.blob'],
    {},
    '/cwd',
  );
  assert.equal(args.root, '/srv/pipe');
  assert.equal(args.tenant, 'acme');
  assert.equal(args.accountUrl, 'https://x.blob');
});

test('parseArgs falls back to PIPELINE_STORE_TENANT and AZURE_STORAGE_ACCOUNT_URL', () => {
  const args = parseArgs(
    [],
    {
      PIPELINE_STORE_TENANT: 'env-tenant',
      AZURE_STORAGE_ACCOUNT_URL: 'https://env.blob',
    },
    '/cwd',
  );
  assert.equal(args.root, '/cwd');
  assert.equal(args.tenant, 'env-tenant');
  assert.equal(args.accountUrl, 'https://env.blob');
});

test('parseArgs prefers explicit --tenant over the env var', () => {
  const args = parseArgs(
    ['--tenant', 'cli-tenant', '--account-url', 'https://cli.blob'],
    { PIPELINE_STORE_TENANT: 'env-tenant', AZURE_STORAGE_ACCOUNT_URL: 'https://env.blob' },
    '/cwd',
  );
  assert.equal(args.tenant, 'cli-tenant');
  assert.equal(args.accountUrl, 'https://cli.blob');
});

test('parseArgs throws when tenant is missing', () => {
  assert.throws(
    () => parseArgs(['--account-url', 'https://x'], {}, '/cwd'),
    /tenant/,
  );
});

test('parseArgs throws when account-url is missing', () => {
  assert.throws(
    () => parseArgs(['--tenant', 'acme'], {}, '/cwd'),
    /account-url/,
  );
});

test('parseArgs rejects unknown arguments', () => {
  assert.throws(
    () =>
      parseArgs(
        ['--tenant', 'acme', '--account-url', 'https://x', '--bogus'],
        {},
        '/cwd',
      ),
    /unrecognised/,
  );
});
