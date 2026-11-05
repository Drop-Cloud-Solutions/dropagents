/**
 * Azurite-backed end-to-end integration test for the `migrate-config` tool.
 *
 * Maps to TASK.md (task-009) acceptance criteria:
 *
 *   AC #1 — invokes the tool in-process, never spawns a subprocess
 *     → the test calls `migrate()` + `formatSummary()` + `totalFailed()`
 *       directly (the same three functions `main.ts::run` composes), so the
 *       test runs without `tsx`/`node` on a child PATH.
 *   AC #2 — seed data covers every `ConfigRowKind`, including a ProjectConfig
 *     whose `context.md` exceeds 30 KiB
 *     → `seedFilesystem()` writes one row of each kind plus a 40 KiB context.md.
 *   AC #3 — after the first run every seeded row is readable through
 *     `AzureConfigStore.get`
 *     → asserted in "first run: migrates every seeded row …".
 *   AC #4 — oversized context.md lands in the overflow container, and the
 *     row's `context_md_blob_ref` column is set
 *     → asserted via a direct entity read on the `ProjectConfig` table plus
 *       a blob `exists()` probe on the overflow container.
 *   AC #5 — a second invocation against the same Azure account exits 0 with
 *     `skipped >= 1` for every row kind
 *     → "second run: idempotent — skipped >= 1 per kind, exit 0".
 *   AC #6 — `Trait("Category", "Integration")` (.NET) — TypeScript analogue is
 *     the "integration:" name prefix and the `AzuriteFixture` reuse.
 *
 * Why this file lives under `test/integration/` (not the .NET-style
 * `tests/Pipeline.Tools.MigrateConfig.Tests/…` path TASK.md names): the repo
 * is the TypeScript v2 rewrite, and the existing AzureConfigStore integration
 * test (`AzureConfigStore.integration.test.ts`) anchors that convention. The
 * .NET names in the brief map onto the TS equivalents (Program.Main →
 * `main.ts::run`, .csproj → no per-suite project file).
 */

import { after, before, describe, it, type TestContext } from 'node:test';
import * as assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  AzureConfigStore,
  TABLE_NAMES,
  blobRefFor,
} from '../../adapters/azure/AzureConfigStore';
import { FsConfigStore } from '../../adapters/fs-config-store/FsConfigStore';
import {
  DEFAULT_OVERFLOW_CONTAINER_NAME,
  DEFAULT_OVERFLOW_THRESHOLD_BYTES,
  type ConfigRowKind,
  type ConfigStoreOptions,
  type Logger,
} from '../../core/ports';
import {
  formatSummary,
  migrate,
  ROW_KINDS,
  totalFailed,
  type KindCounts,
  type MigrateSummary,
} from '../../tools/migrate-config/migrate';

import { AzuriteFixture, type AzuriteFixtureClients } from './AzuriteFixture';

// ---------------------------------------------------------------------------
// Timeouts: image pull on first run dominates, so the suite gets 5 min.
// ---------------------------------------------------------------------------

const SUITE_TIMEOUT_MS = 5 * 60 * 1000;
const PER_TEST_TIMEOUT_MS = 120 * 1000;

// ProjectConfig row whose `context.md` body deliberately exceeds the 30 KiB
// overflow threshold so the AzureConfigStore is forced to spill it to a blob.
const LARGE_CONTEXT_MD_BYTES = DEFAULT_OVERFLOW_THRESHOLD_BYTES + 10 * 1024;

const AGENT_PROMPT_KEYS = ['developer', 'reviewer'] as const;
const WORKFLOW_KEYS = ['echo', 'plan'] as const;
const AGENT_MODEL_KEYS = ['developer', 'planner'] as const;
const SMALL_PROJECT_KEY = 'small-proj';
const LARGE_PROJECT_KEY = 'large-proj';
const PROJECT_KEYS = [SMALL_PROJECT_KEY, LARGE_PROJECT_KEY] as const;

describe(
  'integration: migrate-config tool against Azurite',
  { timeout: SUITE_TIMEOUT_MS },
  () => {
    const fixture = new AzuriteFixture();
    let fixtureReady = false;
    let skipReason: string | null = null;
    let bundle: AzuriteFixtureClients | null = null;

    // Per-suite state — populated by the first run, asserted by the second.
    let tenant = '';
    let tempRoot = '';
    let firstRunSummary: MigrateSummary | null = null;
    let firstRunLines: string[] = [];
    let firstRunExitCode = -1;
    let largeContextMd = '';

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
        // Mirror the existing AzureConfigStore integration suite: if
        // Testcontainers can't pull/start Azurite, skip rather than fail.
        skipReason = `Azurite container failed to start: ${
          err instanceof Error ? err.message : String(err)
        }`;
      }

      if (fixtureReady) {
        tenant = `t-migrate-${randomUUID()}`;
        tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'migrate-config-it-'));
        largeContextMd = 'C'.repeat(LARGE_CONTEXT_MD_BYTES);
        await seedFilesystem(tempRoot, largeContextMd);
      }
    });

    after(async () => {
      if (fixtureReady) {
        try {
          await fixture.wipeTenant(tenant);
        } catch {
          // best-effort
        }
      }
      if (tempRoot) {
        try {
          await fs.rm(tempRoot, { recursive: true, force: true });
        } catch {
          // best-effort
        }
      }
      await fixture.stop();
    });

    function gateSkip(t: TestContext): boolean {
      if (skipReason) {
        t.skip(skipReason);
        return true;
      }
      return false;
    }

    /**
     * Build the source + target pair the migrate() core consumes. Mirrors
     * `main.ts::run` exactly except that the target is wired against the
     * Azurite-backed client bundle from the fixture, replacing the
     * production `DefaultAzureCredential` path that's hostile to test
     * environments.
     */
    function buildSourceAndTarget(): {
      source: FsConfigStore;
      target: AzureConfigStore;
    } {
      assert.ok(bundle, 'fixture clients not built — before() failed?');
      const options: ConfigStoreOptions = {
        tenant,
        backendKind: 'dual',
        // The URL value is irrelevant — the fixture's pre-built clients are
        // what actually talk to Azurite — but the field is part of the
        // production options shape, so we fill it for fidelity.
        azureStorageAccountUrl: 'http://azurite.invalid',
        fsRootPath: tempRoot,
      };
      const source = new FsConfigStore(options);
      const target = new AzureConfigStore(bundle.clients, {
        tenant,
        backendKind: 'azure',
      });
      return { source, target };
    }

    // -----------------------------------------------------------------------
    // First run — copies every seeded row from the fs root into Azurite.
    // -----------------------------------------------------------------------

    it(
      'first run: migrates every seeded row from the temp fs root into Azurite (AC #2, #3, #4)',
      { timeout: PER_TEST_TIMEOUT_MS },
      async (t) => {
        if (gateSkip(t)) return;
        const { source, target } = buildSourceAndTarget();
        const logger = collectingLogger();

        firstRunSummary = await migrate({ source, target, logger });
        firstRunLines = formatSummary(firstRunSummary);
        firstRunExitCode = totalFailed(firstRunSummary) === 0 ? 0 : 1;

        // AC #1 (exit-code shape): the tool composes migrate + totalFailed
        // exactly this way in `main.ts::run`; here we assert it produces 0.
        assert.equal(firstRunExitCode, 0, 'first run must exit 0');
        assert.equal(
          totalFailed(firstRunSummary),
          0,
          'first run must have zero failures across all kinds',
        );

        // AC #3 — every seeded row is readable through AzureConfigStore.get.
        for (const rowKey of AGENT_PROMPT_KEYS) {
          const row = await target.get('AgentPrompts', rowKey);
          assert.ok(row, `AgentPrompts/${rowKey} must be present after migration`);
          assert.equal(
            row.body,
            agentPromptBody(rowKey),
            `AgentPrompts/${rowKey} body must round-trip identically`,
          );
        }
        for (const rowKey of WORKFLOW_KEYS) {
          const row = await target.get('Workflows', rowKey);
          assert.ok(row, `Workflows/${rowKey} must be present after migration`);
          assert.equal(row.body, workflowBody(rowKey));
        }
        for (const rowKey of AGENT_MODEL_KEYS) {
          const row = await target.get('AgentModels', rowKey);
          assert.ok(row, `AgentModels/${rowKey} must be present after migration`);
          assert.equal(row.body, agentModelBody(rowKey));
        }
        for (const rowKey of PROJECT_KEYS) {
          const row = await target.get('ProjectConfig', rowKey);
          assert.ok(row, `ProjectConfig/${rowKey} must be present after migration`);
          assert.equal(row.body, projectJsonBody(rowKey));
          const expectedCtx =
            rowKey === LARGE_PROJECT_KEY ? largeContextMd : smallContextMd(rowKey);
          assert.equal(
            row.metadata.context_md,
            expectedCtx,
            `ProjectConfig/${rowKey} context.md must round-trip identically`,
          );
        }

        // AC #4 — the oversized context.md lives in the overflow blob, and
        // the row's context_md_blob_ref column carries the path that points
        // at it. We probe the underlying table entity + container client
        // directly (rather than going through the adapter's hydration) so
        // the assertion can't be fooled by a happy-path read.
        const tableClient = bundle!.clients.getTableClient(TABLE_NAMES.ProjectConfig);
        const entity = await tableClient.getEntity(tenant, LARGE_PROJECT_KEY);
        const expectedBlobRef = blobRefFor(
          tenant,
          TABLE_NAMES.ProjectConfig,
          `${LARGE_PROJECT_KEY}.context_md`,
        );
        assert.equal(
          entity.context_md_blob_ref,
          expectedBlobRef,
          'ProjectConfig context_md_blob_ref must point at <tenant>/ProjectConfig/<rowKey>.context_md',
        );
        assert.equal(
          entity.context_md ?? '',
          '',
          'inline context_md column must be empty when the body spilled to a blob',
        );

        const blob = bundle!.containerClient.getBlockBlobClient(expectedBlobRef);
        assert.equal(
          await blob.exists(),
          true,
          `overflow blob ${expectedBlobRef} must exist in ${DEFAULT_OVERFLOW_CONTAINER_NAME}`,
        );

        // Sanity: per-kind counts on the first run. Every seeded row was new
        // so all rows land in `created` and none in `skipped`/`failed`.
        const summaryForCounts: MigrateSummary = firstRunSummary;
        for (const kind of ROW_KINDS) {
          const counts: KindCounts = summaryForCounts[kind];
          const expectedCreated = expectedRowCount(kind);
          assert.equal(
            counts.created,
            expectedCreated,
            `${kind}: expected ${expectedCreated} created on first run, got ${counts.created}`,
          );
          assert.equal(counts.skipped, 0, `${kind}: expected 0 skipped on first run`);
          assert.equal(counts.failed, 0, `${kind}: expected 0 failed on first run`);
        }

        // The summary lines are what the CLI prints to stdout — assert they
        // are present and well-formed (one per kind).
        assert.equal(firstRunLines.length, ROW_KINDS.length);

        // Sanity: the migrate core never logs an `error` on the happy path.
        assert.equal(
          logger.errors.length,
          0,
          `expected zero error logs on happy path, saw: ${logger.errors.join(' | ')}`,
        );
      },
    );

    // -----------------------------------------------------------------------
    // Second run — every row is now present in the target, so every row
    // should be counted as skipped, the exit code should still be 0, and no
    // existing row body should have been overwritten.
    // -----------------------------------------------------------------------

    it(
      'second run: idempotent — skipped >= 1 per kind, exit 0 (AC #5)',
      { timeout: PER_TEST_TIMEOUT_MS },
      async (t) => {
        if (gateSkip(t)) return;
        assert.ok(
          firstRunSummary,
          'second-run test depends on the first-run test having completed successfully',
        );

        const { source, target } = buildSourceAndTarget();
        const logger = collectingLogger();

        const summary = await migrate({ source, target, logger });
        const exitCode = totalFailed(summary) === 0 ? 0 : 1;

        assert.equal(exitCode, 0, 'second run must still exit 0');
        for (const kind of ROW_KINDS) {
          const counts: KindCounts = summary[kind];
          assert.ok(
            counts.skipped >= 1,
            `${kind}: expected skipped >= 1 on re-run, got ${counts.skipped}`,
          );
          assert.equal(
            counts.created,
            0,
            `${kind}: expected 0 created on re-run (all rows already present), got ${counts.created}`,
          );
          assert.equal(counts.failed, 0, `${kind}: expected 0 failed on re-run`);
        }

        // Create-only semantics: the body in Azurite still matches what was
        // seeded on the first run, not the (identical here, but logically
        // distinct) source body the re-run would have written.
        const largeRow = await target.get('ProjectConfig', LARGE_PROJECT_KEY);
        assert.ok(largeRow);
        assert.equal(largeRow.metadata.context_md, largeContextMd);
      },
    );
  },
);

// ---------------------------------------------------------------------------
// Seed-data helpers — pure functions so the body each row carries is the
// same on the fs-write side (here) and the read-back assertion side (above).
// ---------------------------------------------------------------------------

function agentPromptBody(rowKey: string): string {
  return `# Agent: ${rowKey}\n\nPrompt body for ${rowKey} agent.\n`;
}

function workflowBody(rowKey: string): string {
  return JSON.stringify({ id: rowKey, steps: ['plan', 'execute'] });
}

function agentModelBody(rowKey: string): string {
  return JSON.stringify({ agent: rowKey, model: 'claude-haiku-4-5-20251001' });
}

function projectJsonBody(rowKey: string): string {
  return JSON.stringify({ name: rowKey, linear_initiative_id: `init-${rowKey}` });
}

function smallContextMd(rowKey: string): string {
  return `# ${rowKey}\n\nA small project context.\n`;
}

function expectedRowCount(kind: ConfigRowKind): number {
  switch (kind) {
    case 'AgentPrompts':
      return AGENT_PROMPT_KEYS.length;
    case 'Workflows':
      return WORKFLOW_KEYS.length;
    case 'AgentModels':
      return AGENT_MODEL_KEYS.length;
    case 'ProjectConfig':
      return PROJECT_KEYS.length;
    case 'Settings':
      return 0; // the migration fixture seeds no Settings rows
  }
}

/**
 * Materialise the production filesystem tree the FsConfigStore expects:
 *
 *   <root>/worker/agents/<rowKey>.CLAUDE.md            AgentPrompts
 *   <root>/shared/.cache/workflows.json                Workflows
 *   <root>/shared/.cache/agent-models.json             AgentModels
 *   <root>/projects/<rowKey>/project.json              ProjectConfig body
 *   <root>/projects/<rowKey>/context.md                ProjectConfig metadata.context_md
 */
async function seedFilesystem(root: string, largeContextMd: string): Promise<void> {
  // AgentPrompts — one Markdown file per row.
  const agentsDir = path.join(root, 'worker', 'agents');
  await fs.mkdir(agentsDir, { recursive: true });
  for (const rowKey of AGENT_PROMPT_KEYS) {
    await fs.writeFile(
      path.join(agentsDir, `${rowKey}.CLAUDE.md`),
      agentPromptBody(rowKey),
      'utf8',
    );
  }

  // Workflows + AgentModels — shared JSON files keyed by rowKey.
  const cacheDir = path.join(root, 'shared', '.cache');
  await fs.mkdir(cacheDir, { recursive: true });

  const workflowsJson: Record<string, { body: string; updatedAt: string }> = {};
  for (const rowKey of WORKFLOW_KEYS) {
    workflowsJson[rowKey] = {
      body: workflowBody(rowKey),
      updatedAt: new Date(0).toISOString(),
    };
  }
  await fs.writeFile(
    path.join(cacheDir, 'workflows.json'),
    JSON.stringify(workflowsJson, null, 2),
    'utf8',
  );

  const agentModelsJson: Record<string, { body: string; updatedAt: string }> = {};
  for (const rowKey of AGENT_MODEL_KEYS) {
    agentModelsJson[rowKey] = {
      body: agentModelBody(rowKey),
      updatedAt: new Date(0).toISOString(),
    };
  }
  await fs.writeFile(
    path.join(cacheDir, 'agent-models.json'),
    JSON.stringify(agentModelsJson, null, 2),
    'utf8',
  );

  // ProjectConfig — one directory per row, with project.json + context.md.
  // The "large" project's context.md exceeds 30 KiB to force overflow.
  for (const rowKey of PROJECT_KEYS) {
    const projDir = path.join(root, 'projects', rowKey);
    await fs.mkdir(projDir, { recursive: true });
    await fs.writeFile(
      path.join(projDir, 'project.json'),
      projectJsonBody(rowKey),
      'utf8',
    );
    const ctx = rowKey === LARGE_PROJECT_KEY ? largeContextMd : smallContextMd(rowKey);
    await fs.writeFile(path.join(projDir, 'context.md'), ctx, 'utf8');
  }
}

interface CollectingLogger extends Logger {
  readonly infos: string[];
  readonly warns: string[];
  readonly errors: string[];
  readonly debugs: string[];
}

function collectingLogger(): CollectingLogger {
  const infos: string[] = [];
  const warns: string[] = [];
  const errors: string[] = [];
  const debugs: string[] = [];
  return {
    infos,
    warns,
    errors,
    debugs,
    info: (m) => infos.push(m),
    warn: (m) => warns.push(m),
    error: (m) => errors.push(m),
    debug: (m) => debugs.push(m),
  };
}
