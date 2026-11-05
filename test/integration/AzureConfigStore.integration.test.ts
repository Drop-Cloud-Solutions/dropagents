/**
 * Azurite-backed integration tests for AzureConfigStore.
 *
 * Maps to TASK.md (task-008) acceptance criteria:
 *
 *   AC #1 — five scenarios covered          → the five top-level `it(...)` blocks below
 *   AC #2 — Testcontainers + Azurite        → AzuriteFixture spins up the image
 *   AC #3 — unique tenant GUID per test     → freshTenant() called in each `it`
 *   AC #4 — large body lands in <tenant>/<table>/<rowKey>; blob_ref set
 *                                            → "large body round-trip ..." test
 *   AC #5 — second Upsert throws Concurrency Error (not RequestFailed)
 *                                            → "etag conflict ..." test
 *   AC #6 — different tenant's ListAsync excludes the seeded row
 *                                            → "list isolates by tenant ..." test
 *   AC #7 — [Trait("Integration")] + skip when Docker unavailable
 *                                            → "integration:" name prefix + Docker probe
 *   AC #8 — clean up Azurite state on completion
 *                                            → `afterEach` wipeTenant() + `after` stop()
 *
 * Production code still uses DefaultAzureCredential — Azurite's shared-key
 * connection string is constructed only inside AzuriteFixture, never in the
 * adapter under test.
 */

import { after, before, afterEach, describe, it, type TestContext } from 'node:test';
import * as assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import {
  AzureConfigStore,
  TABLE_NAMES,
  blobRefFor,
} from '../../adapters/azure/AzureConfigStore';
import {
  ConcurrencyError,
  DEFAULT_OVERFLOW_CONTAINER_NAME,
  DEFAULT_OVERFLOW_THRESHOLD_BYTES,
} from '../../core/ports';
import type { ConfigRow, ConfigRowKind } from '../../core/ports';

import { AzuriteFixture, type AzuriteFixtureClients } from './AzuriteFixture';

// Test-wide timeout: image pull on first run can take a while.
const SUITE_TIMEOUT_MS = 5 * 60 * 1000;
const PER_TEST_TIMEOUT_MS = 90 * 1000;

const ALL_KINDS: readonly ConfigRowKind[] = [
  'AgentPrompts',
  'Workflows',
  'AgentModels',
  'ProjectConfig',
];

describe(
  'integration: AzureConfigStore against Azurite',
  { timeout: SUITE_TIMEOUT_MS },
  () => {
    const fixture = new AzuriteFixture();
    let fixtureReady = false;
    let skipReason: string | null = null;
    let bundle: AzuriteFixtureClients | null = null;
    const seededTenants = new Set<string>();

    before(async () => {
      if (!AzuriteFixture.isDockerAvailable()) {
        skipReason =
          'Docker is not available on this host — skipping Azurite-backed integration tests.';
        return;
      }
      try {
        await fixture.start();
        await fixture.prepareTablesAndContainer();
        bundle = fixture.buildClients();
        fixtureReady = true;
      } catch (err) {
        // If Testcontainers can't pull/start Azurite (e.g. offline, no network
        // to mcr.microsoft.com), treat the same as Docker-unavailable: skip
        // rather than fail the suite. AC #7 says "skipped, not failed".
        skipReason = `Azurite container failed to start: ${
          err instanceof Error ? err.message : String(err)
        }`;
      }
    });

    afterEach(async () => {
      if (!fixtureReady) return;
      // Tenant-scoped cleanup — other tests' tenants (if any are running
      // concurrently in another file) keep their rows.
      for (const tenant of seededTenants) {
        await fixture.wipeTenant(tenant);
      }
      seededTenants.clear();
    });

    after(async () => {
      await fixture.stop();
    });

    function freshTenant(label: string): string {
      const t = `t-${label}-${randomUUID()}`;
      seededTenants.add(t);
      return t;
    }

    function makeStore(tenant: string): AzureConfigStore {
      assert.ok(bundle, 'fixture clients not built — before() failed?');
      return new AzureConfigStore(bundle.clients, {
        tenant,
        backendKind: 'azure',
      });
    }

    function gateSkip(t: TestContext): boolean {
      if (skipReason) {
        t.skip(skipReason);
        return true;
      }
      return false;
    }

    // ----------------------------------------------------------------------
    // AC #1.1 — small-body round-trip for each ConfigRowKind
    // ----------------------------------------------------------------------

    it(
      'small body round-trip writes a row column and reads identical bytes for every ConfigRowKind',
      { timeout: PER_TEST_TIMEOUT_MS },
      async (t) => {
        if (gateSkip(t)) return;
        const tenant = freshTenant('small');
        const store = makeStore(tenant);

        const seeded: Record<string, ConfigRow> = {};
        for (const kind of ALL_KINDS) {
          const body =
            kind === 'ProjectConfig'
              ? JSON.stringify({ name: 'proj-1', kind })
              : `body for ${kind}: ${randomUUID()}`;
          const metadata: Record<string, string> =
            kind === 'ProjectConfig'
              ? { context_md: '# tiny ctx', schema: 'v1' }
              : { tag: kind };
          const row = await store.upsert({
            kind,
            rowKey: `rk-${kind}`,
            body,
            metadata,
          });
          seeded[kind] = row;

          // Sanity: returned etag was minted by the service (non-empty).
          assert.ok(row.etag.length > 0, `${kind}: expected non-empty etag from upsert`);
        }

        // Independent read confirms identical bytes for each row.
        for (const kind of ALL_KINDS) {
          const back = await store.get(kind, `rk-${kind}`);
          assert.ok(back, `${kind}: expected row to exist after upsert`);
          assert.equal(back.body, seeded[kind].body, `${kind}: body must round-trip identically`);
          if (kind === 'ProjectConfig') {
            assert.equal(back.metadata.context_md, '# tiny ctx');
            assert.equal(back.metadata.schema, 'v1');
          } else {
            assert.equal(back.metadata.tag, kind);
          }
        }

        // Side-channel verification: the row's `body` column carries the
        // inline bytes (no blob marker) for a small payload.
        for (const kind of ALL_KINDS) {
          const tc = bundle!.clients.getTableClient(TABLE_NAMES[kind]);
          const entity = await tc.getEntity(tenant, `rk-${kind}`);
          assert.equal(
            entity.blob_ref ?? '',
            '',
            `${kind}: small body must not set blob_ref`,
          );
          assert.equal(typeof entity.body, 'string');
        }
      },
    );

    // ----------------------------------------------------------------------
    // AC #1.2 — large body (>30 KiB) round-trip stores in overflow blob
    // ----------------------------------------------------------------------

    it(
      'large body (>30 KiB) round-trip stores the body in <tenant>/<table>/<rowKey> with blob_ref set',
      { timeout: PER_TEST_TIMEOUT_MS },
      async (t) => {
        if (gateSkip(t)) return;
        const tenant = freshTenant('large');
        const store = makeStore(tenant);

        // 40 KiB — comfortably above the 30 KiB default threshold.
        const big = 'B'.repeat(DEFAULT_OVERFLOW_THRESHOLD_BYTES + 10_240);
        const kind: ConfigRowKind = 'Workflows';
        const rowKey = 'flow-large';

        await store.upsert({ kind, rowKey, body: big });

        // The row carries an empty body and the blob_ref marker.
        const tc = bundle!.clients.getTableClient(TABLE_NAMES[kind]);
        const entity = await tc.getEntity(tenant, rowKey);
        const expectedBlobRef = blobRefFor(tenant, TABLE_NAMES[kind], rowKey);
        assert.equal(entity.body, '', 'row body must be empty when content spilled to blob');
        assert.equal(
          entity.blob_ref,
          expectedBlobRef,
          'row must carry blob_ref pointing at <tenant>/<table>/<rowKey>',
        );

        // Directly probe Azurite to confirm the blob exists at the expected
        // path with the body bytes.
        const blob = bundle!.containerClient.getBlockBlobClient(expectedBlobRef);
        assert.ok(await blob.exists(), `expected overflow blob ${expectedBlobRef} to exist`);

        const stream = (await blob.download()).readableStreamBody;
        assert.ok(stream, 'expected a readableStreamBody on download');
        const downloaded = await streamToString(stream!);
        assert.equal(downloaded, big, 'blob bytes must equal the original body');

        // The adapter's read path follows the marker transparently.
        const back = await store.get(kind, rowKey);
        assert.ok(back);
        assert.equal(back.body, big, 'adapter read must return the original body verbatim');
      },
    );

    // ----------------------------------------------------------------------
    // AC #1.3 — ETag conflict: second Upsert raises ConcurrencyError
    // ----------------------------------------------------------------------

    it(
      'etag conflict: two clients read the same row, both Upsert; the second receives ConcurrencyError',
      { timeout: PER_TEST_TIMEOUT_MS },
      async (t) => {
        if (gateSkip(t)) return;
        const tenant = freshTenant('etag');
        // Two independent stores backed by the same emulator — simulates two
        // workers racing on the same row.
        const storeA = makeStore(tenant);
        const storeB = makeStore(tenant);

        const kind: ConfigRowKind = 'AgentPrompts';
        const rowKey = 'developer/system';

        // Seed and then have both clients read the same etag.
        await storeA.upsert({ kind, rowKey, body: 'v0' });
        const readA = await storeA.get(kind, rowKey);
        const readB = await storeB.get(kind, rowKey);
        assert.ok(readA && readB);
        assert.equal(readA.etag, readB.etag, 'both clients must observe the same etag');

        // A wins.
        const updated = await storeA.upsert({
          kind,
          rowKey,
          body: 'v1 from A',
          etag: readA.etag,
        });
        assert.notEqual(updated.etag, readA.etag, 'successful upsert must advance the etag');

        // B's stale upsert must throw ConcurrencyError SPECIFICALLY — not the
        // raw Azure.RequestFailed equivalent (in TS: a RestError). AC #5.
        let thrown: unknown;
        try {
          await storeB.upsert({
            kind,
            rowKey,
            body: 'v1 from B',
            etag: readB.etag,
          });
        } catch (err) {
          thrown = err;
        }
        assert.ok(thrown, 'expected stale-etag upsert to throw');
        assert.ok(
          thrown instanceof ConcurrencyError,
          `expected ConcurrencyError, got ${
            thrown instanceof Error ? thrown.name : typeof thrown
          }: ${thrown instanceof Error ? thrown.message : String(thrown)}`,
        );
        assert.ok(
          thrown.conflictingEtag.length > 0,
          'ConcurrencyError must carry the server-current etag',
        );

        // Sanity: the row reflects A's update, not B's.
        const final = await storeA.get(kind, rowKey);
        assert.ok(final);
        assert.equal(final.body, 'v1 from A');
      },
    );

    // ----------------------------------------------------------------------
    // AC #1.4 — Delete removes both the row and the overflow blob
    // ----------------------------------------------------------------------

    it(
      'delete removes both the row and the overflow blob when the row spilled',
      { timeout: PER_TEST_TIMEOUT_MS },
      async (t) => {
        if (gateSkip(t)) return;
        const tenant = freshTenant('delete');
        const store = makeStore(tenant);

        const kind: ConfigRowKind = 'AgentModels';
        const rowKey = 'gpt-foo';
        const big = 'D'.repeat(DEFAULT_OVERFLOW_THRESHOLD_BYTES + 4_096);

        const row = await store.upsert({ kind, rowKey, body: big });
        const blobRef = blobRefFor(tenant, TABLE_NAMES[kind], rowKey);

        // Pre-condition: the blob exists.
        const blob = bundle!.containerClient.getBlockBlobClient(blobRef);
        assert.ok(await blob.exists(), 'overflow blob must exist before delete');

        await store.delete(kind, rowKey, row.etag);

        // Row gone.
        assert.equal(await store.get(kind, rowKey), null, 'row must be absent after delete');

        // Blob gone.
        assert.equal(
          await blob.exists(),
          false,
          'overflow blob must be removed alongside the row',
        );
      },
    );

    // ----------------------------------------------------------------------
    // AC #1.5 — list enumerates all rows for the tenant; cross-tenant isolation
    // ----------------------------------------------------------------------

    it(
      'list enumerates rows for the tenant and excludes rows belonging to a different tenant partition',
      { timeout: PER_TEST_TIMEOUT_MS },
      async (t) => {
        if (gateSkip(t)) return;

        const tenantA = freshTenant('listA');
        const tenantB = freshTenant('listB');
        const storeA = makeStore(tenantA);
        const storeB = makeStore(tenantB);

        const kind: ConfigRowKind = 'Workflows';

        // Seed A with three rows; seed B with two unrelated rows so we can
        // assert isolation in both directions.
        const aKeys = ['a/one', 'a/two', 'a/three'];
        const bKeys = ['b/alpha', 'b/beta'];
        for (const k of aKeys) {
          await storeA.upsert({ kind, rowKey: k, body: `A:${k}` });
        }
        for (const k of bKeys) {
          await storeB.upsert({ kind, rowKey: k, body: `B:${k}` });
        }

        const collect = async (s: AzureConfigStore): Promise<ConfigRow[]> => {
          const acc: ConfigRow[] = [];
          for await (const row of s.list(kind)) acc.push(row);
          return acc;
        };

        const seenA = await collect(storeA);
        const seenB = await collect(storeB);

        assert.deepEqual(
          seenA.map((r) => r.rowKey).sort(),
          [...aKeys].sort(),
          'tenantA.list must return exactly tenantA rows',
        );
        assert.deepEqual(
          seenB.map((r) => r.rowKey).sort(),
          [...bKeys].sort(),
          'tenantB.list must return exactly tenantB rows',
        );

        // Cross-tenant isolation: no row from A leaks into B and vice versa.
        for (const row of seenA) {
          assert.equal(row.body.startsWith('A:'), true);
        }
        for (const row of seenB) {
          assert.equal(row.body.startsWith('B:'), true);
        }
      },
    );

    // ----------------------------------------------------------------------
    // AC #8 — fixture-level smoke check: the overflow container is the one
    // the adapter wrote to, not some sibling container with the same prefix.
    // ----------------------------------------------------------------------

    it(
      'overflow container under test is the default `pipeline-store-overflow` container',
      async (t) => {
        if (gateSkip(t)) return;
        assert.equal(bundle!.overflowContainerName, DEFAULT_OVERFLOW_CONTAINER_NAME);
      },
    );
  },
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function streamToString(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8'));
  }
  return Buffer.concat(chunks).toString('utf8');
}
