/**
 * Unit tests for `FsConfigStore`. Each test gets a fresh temp directory
 * under the OS tmp root and tears it down in `finally`, so tests are
 * independent and a failure mid-flight does not leak files between runs.
 *
 * Test category: Unit. The AC trait notation is C# / xUnit-specific; in
 * Node these are plain `node:test` tests run via `npm test`.
 */
import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { ConcurrencyError, type ConfigRow } from '../../core/ports/ConfigStore';
import { FsConfigStore } from './FsConfigStore';

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fs-config-store-'));
}

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

function newStore(root: string): FsConfigStore {
  return new FsConfigStore({ tenant: 'unit', backendKind: 'fs', fsRootPath: root });
}

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

async function collect(iter: AsyncIterable<ConfigRow>): Promise<ConfigRow[]> {
  const out: ConfigRow[] = [];
  for await (const row of iter) out.push(row);
  return out;
}

// ---------------------------------------------------------------------------
// AC #1, #2, #4: AgentPrompts round-trip + on-disk layout + deterministic etag
// ---------------------------------------------------------------------------

test('AgentPrompts: round-trip writes worker/agents/<rowKey>.CLAUDE.md and etag is sha256(body)', async () => {
  const root = tempRoot();
  try {
    const store = newStore(root);
    const body = '# Developer prompt\n\nBe terse.';
    const upserted = await store.upsert({ kind: 'AgentPrompts', rowKey: 'developer', body });

    assert.equal(upserted.etag, sha256(body));
    assert.equal(upserted.body, body);
    assert.deepEqual(upserted.metadata, {});

    // The on-disk file lives at the documented path so other tooling can
    // continue to read it directly.
    const filePath = path.join(root, 'worker', 'agents', 'developer.CLAUDE.md');
    assert.equal(fs.readFileSync(filePath, 'utf8'), body);

    const round = await store.get('AgentPrompts', 'developer');
    assert.ok(round);
    assert.equal(round!.body, body);
    assert.equal(round!.etag, upserted.etag);
    assert.equal(round!.kind, 'AgentPrompts');
    assert.ok(round!.updatedAt instanceof Date);
  } finally {
    cleanup(root);
  }
});

// ---------------------------------------------------------------------------
// AC #2: etag changes when the body changes
// ---------------------------------------------------------------------------

test('etag changes when the body changes (so callers detect concurrent writes)', async () => {
  const root = tempRoot();
  try {
    const store = newStore(root);
    const first = await store.upsert({ kind: 'AgentPrompts', rowKey: 'r', body: 'one' });
    const second = await store.upsert({
      kind: 'AgentPrompts',
      rowKey: 'r',
      body: 'two',
      etag: first.etag
    });
    assert.notEqual(first.etag, second.etag);
    assert.equal(second.etag, sha256('two'));
  } finally {
    cleanup(root);
  }
});

// ---------------------------------------------------------------------------
// AC #3: stale etag throws; empty etag on existing row also throws
// ---------------------------------------------------------------------------

test('upsert with a stale etag throws ConcurrencyError carrying the current etag', async () => {
  const root = tempRoot();
  try {
    const store = newStore(root);
    const created = await store.upsert({ kind: 'AgentPrompts', rowKey: 'r', body: 'v1' });
    await assert.rejects(
      () =>
        store.upsert({
          kind: 'AgentPrompts',
          rowKey: 'r',
          body: 'v2',
          etag: 'definitely-not-the-real-etag'
        }),
      (err: unknown) =>
        err instanceof ConcurrencyError && err.conflictingEtag === created.etag
    );

    // Row body is unchanged on disk after the failed upsert.
    const row = await store.get('AgentPrompts', 'r');
    assert.equal(row!.body, 'v1');
  } finally {
    cleanup(root);
  }
});

test('upsert with no etag on an existing row throws (If-None-Match: * semantics)', async () => {
  const root = tempRoot();
  try {
    const store = newStore(root);
    await store.upsert({ kind: 'Workflows', rowKey: 'wf-1', body: '{"v":1}' });
    await assert.rejects(
      () => store.upsert({ kind: 'Workflows', rowKey: 'wf-1', body: '{"v":2}' }),
      (err: unknown) => err instanceof ConcurrencyError
    );
  } finally {
    cleanup(root);
  }
});

// ---------------------------------------------------------------------------
// AC #1, #3: missing row returns null for every kind
// ---------------------------------------------------------------------------

test('get returns null for missing rows across all four kinds', async () => {
  const root = tempRoot();
  try {
    const store = newStore(root);
    assert.equal(await store.get('AgentPrompts', 'missing'), null);
    assert.equal(await store.get('Workflows', 'missing'), null);
    assert.equal(await store.get('AgentModels', 'missing'), null);
    assert.equal(await store.get('ProjectConfig', 'missing'), null);
  } finally {
    cleanup(root);
  }
});

// ---------------------------------------------------------------------------
// AC #1, #5: Workflows + AgentModels share a single JSON file each
// ---------------------------------------------------------------------------

test('Workflows: multiple rows live in shared/.cache/workflows.json keyed by rowKey', async () => {
  const root = tempRoot();
  try {
    const store = newStore(root);
    await store.upsert({ kind: 'Workflows', rowKey: 'echo', body: '{"steps":[]}' });
    await store.upsert({
      kind: 'Workflows',
      rowKey: 'review',
      body: '{"steps":["dev","review"]}',
      metadata: { owner: 'platform' }
    });

    const filePath = path.join(root, 'shared', '.cache', 'workflows.json');
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    assert.deepEqual(Object.keys(raw).sort(), ['echo', 'review']);

    const review = await store.get('Workflows', 'review');
    assert.ok(review);
    assert.equal(review!.body, '{"steps":["dev","review"]}');
    assert.equal(review!.metadata.owner, 'platform');
    assert.equal(review!.etag, sha256('{"steps":["dev","review"]}'));
  } finally {
    cleanup(root);
  }
});

test('AgentModels: stored at shared/.cache/agent-models.json with the same shape as workflows', async () => {
  const root = tempRoot();
  try {
    const store = newStore(root);
    await store.upsert({ kind: 'AgentModels', rowKey: 'developer', body: 'claude-opus-4-7' });
    const filePath = path.join(root, 'shared', '.cache', 'agent-models.json');
    assert.ok(fs.existsSync(filePath));
    const row = await store.get('AgentModels', 'developer');
    assert.equal(row!.body, 'claude-opus-4-7');
    assert.equal(row!.kind, 'AgentModels');
  } finally {
    cleanup(root);
  }
});

// ---------------------------------------------------------------------------
// AC #1, #7: list enumerates every kind
// ---------------------------------------------------------------------------

test('list enumerates rows for every kind', async () => {
  const root = tempRoot();
  try {
    const store = newStore(root);

    await store.upsert({ kind: 'AgentPrompts', rowKey: 'dev', body: 'p1' });
    await store.upsert({ kind: 'AgentPrompts', rowKey: 'review', body: 'p2' });

    await store.upsert({ kind: 'Workflows', rowKey: 'echo', body: 'b1' });
    await store.upsert({ kind: 'Workflows', rowKey: 'fix', body: 'b2' });

    await store.upsert({ kind: 'AgentModels', rowKey: 'dev', body: 'm1' });

    await store.upsert({
      kind: 'ProjectConfig',
      rowKey: 'ai-pipeline',
      body: '{"name":"ai-pipeline"}'
    });
    await store.upsert({
      kind: 'ProjectConfig',
      rowKey: 'other',
      body: '{"name":"other"}'
    });

    const prompts = (await collect(store.list('AgentPrompts'))).map((r) => r.rowKey).sort();
    assert.deepEqual(prompts, ['dev', 'review']);

    const wfs = (await collect(store.list('Workflows'))).map((r) => r.rowKey).sort();
    assert.deepEqual(wfs, ['echo', 'fix']);

    const models = (await collect(store.list('AgentModels'))).map((r) => r.rowKey).sort();
    assert.deepEqual(models, ['dev']);

    const projects = (await collect(store.list('ProjectConfig'))).map((r) => r.rowKey).sort();
    assert.deepEqual(projects, ['ai-pipeline', 'other']);
  } finally {
    cleanup(root);
  }
});

test('list returns nothing when the backing directory or file does not exist', async () => {
  const root = tempRoot();
  try {
    const store = newStore(root);
    assert.deepEqual(await collect(store.list('AgentPrompts')), []);
    assert.deepEqual(await collect(store.list('Workflows')), []);
    assert.deepEqual(await collect(store.list('ProjectConfig')), []);
  } finally {
    cleanup(root);
  }
});

// ---------------------------------------------------------------------------
// AC #6: ProjectConfig round-trips project.json + context.md via metadata
// ---------------------------------------------------------------------------

test('ProjectConfig: body lands in projects/<key>/project.json and context.md round-trips via metadata', async () => {
  const root = tempRoot();
  try {
    const store = newStore(root);
    const projectJson = '{"name":"ai-pipeline","repos":[]}';
    const contextMd = '# ai-pipeline context\n\nLines of guidance for agents.';

    const upserted = await store.upsert({
      kind: 'ProjectConfig',
      rowKey: 'ai-pipeline',
      body: projectJson,
      metadata: { context_md: contextMd }
    });
    assert.equal(upserted.metadata.context_md, contextMd);

    // Disk shape matches the documented layout.
    const projectFile = path.join(root, 'projects', 'ai-pipeline', 'project.json');
    const ctxFile = path.join(root, 'projects', 'ai-pipeline', 'context.md');
    assert.equal(fs.readFileSync(projectFile, 'utf8'), projectJson);
    assert.equal(fs.readFileSync(ctxFile, 'utf8'), contextMd);

    const round = await store.get('ProjectConfig', 'ai-pipeline');
    assert.ok(round);
    assert.equal(round!.body, projectJson);
    assert.equal(round!.metadata.context_md, contextMd);
    assert.equal(round!.etag, sha256(projectJson));
  } finally {
    cleanup(root);
  }
});

test('ProjectConfig without context.md exposes empty metadata', async () => {
  const root = tempRoot();
  try {
    const store = newStore(root);
    await store.upsert({ kind: 'ProjectConfig', rowKey: 'p', body: '{"name":"p"}' });
    const row = await store.get('ProjectConfig', 'p');
    assert.ok(row);
    assert.deepEqual(row!.metadata, {});
  } finally {
    cleanup(root);
  }
});

// ---------------------------------------------------------------------------
// AC #8 (implicit): sub-30 KiB bodies round-trip cleanly. The 30 KiB
// overflow threshold belongs to the azure adapter; the fs adapter has no
// such limit, but the unit test guards against accidental truncation.
// ---------------------------------------------------------------------------

test('sub-30 KiB body round-trips without truncation or corruption', async () => {
  const root = tempRoot();
  try {
    const store = newStore(root);
    // 25 KiB of recognisable content — well under the 30720-byte threshold.
    const body = 'A'.repeat(25 * 1024);
    const upserted = await store.upsert({
      kind: 'Workflows',
      rowKey: 'big',
      body
    });
    const round = await store.get('Workflows', 'big');
    assert.equal(round!.body.length, body.length);
    assert.equal(round!.body, body);
    assert.equal(round!.etag, upserted.etag);
    assert.equal(round!.etag, sha256(body));
  } finally {
    cleanup(root);
  }
});

// ---------------------------------------------------------------------------
// Delete semantics — etag-conditional, idempotent on missing
// ---------------------------------------------------------------------------

test('delete with a matching etag removes the row; subsequent delete is a no-op', async () => {
  const root = tempRoot();
  try {
    const store = newStore(root);
    const created = await store.upsert({ kind: 'AgentModels', rowKey: 'm', body: 'x' });
    await store.delete('AgentModels', 'm', created.etag);
    assert.equal(await store.get('AgentModels', 'm'), null);
    // Second delete on a missing row must not throw — idempotent.
    await store.delete('AgentModels', 'm', created.etag);
  } finally {
    cleanup(root);
  }
});

test('delete with a stale etag throws ConcurrencyError and leaves the row in place', async () => {
  const root = tempRoot();
  try {
    const store = newStore(root);
    await store.upsert({ kind: 'AgentPrompts', rowKey: 'r', body: 'v1' });
    await assert.rejects(
      () => store.delete('AgentPrompts', 'r', 'wrong'),
      (err: unknown) => err instanceof ConcurrencyError
    );
    const row = await store.get('AgentPrompts', 'r');
    assert.ok(row);
    assert.equal(row!.body, 'v1');
  } finally {
    cleanup(root);
  }
});
