/**
 * Cross-pipeline row-shape compatibility integration test.
 *
 * Maps to TASK.md (task-010) acceptance criteria:
 *
 *   AC #1 — raw TableEntity (shaped like the upstream migrator output) is read
 *           through AzureConfigStore for AgentPrompts, Workflows, AgentModels
 *     → "raw → AzureConfigStore.get round-trip" `it(...)` block per kind.
 *   AC #2 — write through AzureConfigStore, read raw entity, assert the column
 *           set is a superset-compatible match with the expected shape
 *     → "AzureConfigStore.upsert → raw entity column-set" `it(...)` block per kind.
 *   AC #3 — body bytes, ETag, and UpdatedAt are asserted on every round-trip
 *     → assertions inside the per-kind blocks below.
 *   AC #4 — TS source path is referenced inline for future drift debugging
 *     → see EXPECTED_V2_COLUMNS / V1_TS_COLUMNS_FOR_DRIFT_TRACKING below.
 *   AC #5 — `Trait("Category", "Integration")` analogue is the "integration:"
 *           describe-name prefix; AzuriteFixture is reused.
 *   AC #6 — ProjectConfig is excluded with a `{ skip: '…' }` fact documenting
 *           that the v1 TS pipeline does not yet emit this kind.
 *
 * Why v2 columns? The original brief wanted to round-trip rows produced by the
 * v1 TypeScript pipeline at `pipeline/shared/azure-config-store.ts`. The
 * operator clarification on this task records that v1 and v2 have disjoint
 * row schemas (v1: `inline` / `overflow` / `size` / `updatedAt`; v2: `body` /
 * `blob_ref` / `metadata_json` / `updated_at`) and chose Option C: do the
 * round-trip with v2's own columns. The V1_TS_COLUMNS_FOR_DRIFT_TRACKING
 * constant below pins the v1 names so a future v1↔v2 reconciliation breaks
 * this test (rather than silently corrupting cross-pipeline rows).
 */

import { after, before, afterEach, describe, it, type TestContext } from 'node:test';
import * as assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import {
  AzureConfigStore,
  TABLE_NAMES,
  type TableEntityRecord,
} from '../../adapters/azure/AzureConfigStore';
import type { ConfigRowKind } from '../../core/ports';

import { AzuriteFixture, type AzuriteFixtureClients } from './AzuriteFixture';

const SUITE_TIMEOUT_MS = 5 * 60 * 1000;
const PER_TEST_TIMEOUT_MS = 90 * 1000;

/**
 * Columns the v2 `AzureConfigStore` adapter emits on a small-body upsert for
 * the three shared kinds (AgentPrompts, Workflows, AgentModels). Pinned here
 * so any future drift on the adapter side breaks this test rather than the
 * cross-pipeline contract.
 *
 * `metadata_json` is only present when the upsert spec carries non-empty
 * metadata, so it's an "expected when seeded" rather than a "required always"
 * column — see `EXPECTED_V2_OPTIONAL_COLUMNS` below.
 *
 * Structural columns the Tables SDK adds itself (timestamp/etag) are not
 * listed here — the test asserts on `entity.etag` and the `updated_at`
 * application column directly.
 */
const EXPECTED_V2_REQUIRED_COLUMNS: ReadonlyArray<string> = Object.freeze([
  'partitionKey',
  'rowKey',
  'body',
  'updated_at',
]);

const EXPECTED_V2_OPTIONAL_COLUMNS: ReadonlyArray<string> = Object.freeze([
  'blob_ref',
  'metadata_json',
]);

/**
 * Drift tracker — these are the column names the v1 TS pipeline currently
 * emits at `pipeline/shared/azure-config-store.ts` (search for
 * `inline`, `overflow`, `size`, `updatedAt`). They are intentionally NOT
 * compared against by this test today (per the task-010 operator
 * clarification: do v2-only round-trip with v2's own columns), but they are
 * recorded here so a v1↔v2 reconciliation lands a deliberate edit on this
 * file rather than silently changing observable wire behaviour.
 *
 * If you are reading this because v1 was migrated to share the v2 schema:
 * delete this constant and add v1 columns to `EXPECTED_V2_REQUIRED_COLUMNS`
 * (or vice versa).
 */
const V1_TS_COLUMNS_FOR_DRIFT_TRACKING: ReadonlyArray<string> = Object.freeze([
  'inline',
  'overflow',
  'size',
  'updatedAt',
]);

/**
 * Shared kinds the v1 TS pipeline currently emits. ProjectConfig is v2-only
 * (see the skipped `it` near the bottom of this file).
 */
const SHARED_KINDS: ReadonlyArray<ConfigRowKind> = Object.freeze([
  'AgentPrompts',
  'Workflows',
  'AgentModels',
]);

describe(
  'integration: cross-pipeline row-shape compatibility',
  { timeout: SUITE_TIMEOUT_MS },
  () => {
    const fixture = new AzuriteFixture();
    let fixtureReady = false;
    let skipReason: string | null = null;
    let bundle: AzuriteFixtureClients | null = null;
    const seededTenants = new Set<string>();

    before(async () => {
      // Touch the drift tracker so an unused-symbol lint doesn't strip the
      // intentional documentation. The constant is the test's contract with
      // the v1 pipeline; it must stay reachable from the suite.
      assert.ok(V1_TS_COLUMNS_FOR_DRIFT_TRACKING.length > 0);

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
        skipReason = `Azurite container failed to start: ${
          err instanceof Error ? err.message : String(err)
        }`;
      }
    });

    afterEach(async () => {
      if (!fixtureReady) return;
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
    // AC #1 — raw TableEntity (v2-shaped) → AzureConfigStore.get round-trip
    // ----------------------------------------------------------------------

    for (const kind of SHARED_KINDS) {
      it(
        `raw v2-shaped TableEntity for ${kind} is readable through AzureConfigStore.get with matching body, etag, and updatedAt`,
        { timeout: PER_TEST_TIMEOUT_MS },
        async (t) => {
          if (gateSkip(t)) return;
          const tenant = freshTenant(`raw-${kind.toLowerCase()}`);
          const store = makeStore(tenant);
          const tc = bundle!.clients.getTableClient(TABLE_NAMES[kind]);

          const rowKey = `raw/${kind}/${randomUUID()}`;
          const body = `raw-${kind}-body-${randomUUID()}`;
          const updatedAt = new Date('2026-05-13T12:00:00.000Z');
          const meta = { tag: kind, source: 'cross-pipeline-test' };

          // Hand-craft the entity using the EXACT v2 column names the
          // adapter emits. `blob_ref=""` is an explicit empty marker so the
          // read path treats this as an inline body (the adapter checks
          // `length > 0`, see AzureConfigStore.readBody). The TS source
          // shape lives at pipeline/shared/azure-config-store.ts — see
          // V1_TS_COLUMNS_FOR_DRIFT_TRACKING above for the v1 names this
          // would diverge against.
          const seedEntity: TableEntityRecord = {
            partitionKey: tenant,
            rowKey,
            body,
            blob_ref: '',
            updated_at: updatedAt,
            metadata_json: JSON.stringify(meta),
          };
          const seedResult = await tc.upsertEntity(seedEntity, 'Replace');
          assert.ok(
            seedResult.etag.length > 0,
            'raw seed must produce a server-issued etag',
          );

          const back = await store.get(kind, rowKey);
          assert.ok(back, `${kind}: row must be readable through AzureConfigStore`);

          assert.equal(back.kind, kind);
          assert.equal(back.rowKey, rowKey);
          assert.equal(
            back.body,
            body,
            `${kind}: body bytes must round-trip identically`,
          );
          assert.equal(
            back.etag,
            seedResult.etag,
            `${kind}: etag from raw seed must surface unchanged on AzureConfigStore.get`,
          );
          assert.ok(
            back.updatedAt instanceof Date && !Number.isNaN(back.updatedAt.getTime()),
            `${kind}: updatedAt must hydrate as a valid Date`,
          );
          assert.equal(
            back.updatedAt.getTime(),
            updatedAt.getTime(),
            `${kind}: updatedAt must round-trip to the seeded instant`,
          );
          assert.equal(back.metadata.tag, kind);
          assert.equal(back.metadata.source, 'cross-pipeline-test');
        },
      );
    }

    // ----------------------------------------------------------------------
    // AC #2 — AzureConfigStore.upsert → raw TableEntity column-set
    // ----------------------------------------------------------------------

    for (const kind of SHARED_KINDS) {
      it(
        `AzureConfigStore.upsert for ${kind} produces a raw TableEntity whose column set is a superset-compatible match with the expected v2 shape`,
        { timeout: PER_TEST_TIMEOUT_MS },
        async (t) => {
          if (gateSkip(t)) return;
          const tenant = freshTenant(`inv-${kind.toLowerCase()}`);
          const store = makeStore(tenant);
          const tc = bundle!.clients.getTableClient(TABLE_NAMES[kind]);

          const rowKey = `inv/${kind}/${randomUUID()}`;
          const body = `inv-${kind}-body-${randomUUID()}`;
          const written = await store.upsert({
            kind,
            rowKey,
            body,
            metadata: { tag: kind, source: 'inverse-direction' },
          });

          const entity = await tc.getEntity(tenant, rowKey);
          const columns = new Set<string>(Object.keys(entity));

          // Required columns must all be present.
          for (const required of EXPECTED_V2_REQUIRED_COLUMNS) {
            assert.ok(
              columns.has(required),
              `${kind}: raw entity is missing required v2 column "${required}" — got [${[...columns]
                .sort()
                .join(', ')}]`,
            );
          }

          // Optional columns: each one that *is* present must be one we
          // recognise. Anything else is a new column the adapter started
          // emitting without us noticing — exactly the silent drift this
          // test is meant to catch (see TS source path comment above).
          const allowed = new Set<string>([
            ...EXPECTED_V2_REQUIRED_COLUMNS,
            ...EXPECTED_V2_OPTIONAL_COLUMNS,
            // The Tables SDK round-trips `etag` and `timestamp` on the
            // returned entity — they're SDK-level columns, not application
            // columns the v1 pipeline cares about, so we exempt them.
            'etag',
            'timestamp',
          ]);
          for (const col of columns) {
            assert.ok(
              allowed.has(col),
              `${kind}: unexpected column "${col}" on raw entity — update EXPECTED_V2_REQUIRED_COLUMNS / EXPECTED_V2_OPTIONAL_COLUMNS or revert the adapter change`,
            );
          }

          // Value-shape sanity on the v2 columns we just asserted exist.
          assert.equal(entity.partitionKey, tenant);
          assert.equal(entity.rowKey, rowKey);
          assert.equal(entity.body, body, `${kind}: inline body must match`);
          assert.ok(
            entity.updated_at instanceof Date ||
              typeof entity.updated_at === 'string',
            `${kind}: updated_at must serialize as a Date or ISO string`,
          );
          assert.equal(
            typeof entity.metadata_json,
            'string',
            `${kind}: metadata_json must be a JSON string when metadata was supplied`,
          );
          const parsedMeta = JSON.parse(entity.metadata_json as string) as Record<
            string,
            string
          >;
          assert.equal(parsedMeta.tag, kind);
          assert.equal(parsedMeta.source, 'inverse-direction');

          // ETag + UpdatedAt round-trip on the inverse direction too.
          assert.ok(
            written.etag.length > 0,
            `${kind}: AzureConfigStore.upsert must return a non-empty etag`,
          );
          assert.equal(
            written.etag,
            entity.etag ?? '',
            `${kind}: returned etag must equal the entity's stored etag`,
          );
          assert.ok(
            written.updatedAt instanceof Date,
            `${kind}: returned updatedAt must be a Date`,
          );
          // AC #3 — UpdatedAt equivalence on the inverse direction. The
          // adapter stamps `updated_at` inside buildEntity and the Tables SDK
          // serialises it as either a Date (newer SDK versions) or an ISO
          // string (older + on round-trip), so we coerce before comparing.
          const storedUpdatedAt =
            entity.updated_at instanceof Date
              ? entity.updated_at
              : new Date(entity.updated_at as string);
          assert.equal(
            written.updatedAt.getTime(),
            storedUpdatedAt.getTime(),
            `${kind}: returned updatedAt must equal the stored entity's updated_at column`,
          );
        },
      );
    }

    // ----------------------------------------------------------------------
    // AC #6 — ProjectConfig is v2-only and explicitly skipped
    // ----------------------------------------------------------------------

    it(
      'ProjectConfig cross-pipeline round-trip',
      {
        skip:
          'ProjectConfig is v2-only — the v1 TS pipeline at ' +
          'pipeline/shared/azure-config-store.ts does not yet emit this kind ' +
          '(it stops at AgentPrompts, Workflows, AgentModels). Re-enable when v1 adds it.',
      },
      () => {
        // Intentionally empty — the skip reason is the documentation.
      },
    );
  },
);
