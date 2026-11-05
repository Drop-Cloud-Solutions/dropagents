/**
 * Migration core — drains every row out of a source `ConfigStore` (typically
 * the local `FsConfigStore`) and writes it into a target `ConfigStore`
 * (typically the production `AzureConfigStore`) with create-only semantics.
 *
 * TypeScript analogue of the .NET `Pipeline.Tools.MigrateConfig` brief in
 * TASK.md. Backend-agnostic so unit tests can pass two mocks and exercise the
 * counting, skip, and failure paths without touching the filesystem or the
 * Azure SDK.
 *
 * Create-only semantics:
 *
 *   The brief says "call AzureConfigStore.UpsertAsync with ETag empty
 *   (If-None-Match: * semantics) and treat ConcurrencyException as
 *   'already migrated, skip'". The TS `AzureConfigStore.upsert` does not
 *   enforce If-None-Match server-side when no etag is supplied (it falls
 *   through to an unconditional `upsertEntity` so an existing row would be
 *   overwritten on every re-run, defeating AC #7's "re-run produces skipped
 *   >= 1"). The migration enforces create-only at the application layer: a
 *   target `get` precedes every write, and a hit is counted as `skipped`
 *   without issuing the upsert. A real `ConcurrencyError` thrown by the
 *   target (e.g. a write-race between two concurrent migrations) is still
 *   caught and counted as `skipped` per the brief.
 */
import {
  ConcurrencyError,
  type ConfigRowKind,
  type ConfigStore,
  type Logger,
} from '../../core/ports';

/** Every row kind the pipeline understands — drives the per-kind summary. */
export const ROW_KINDS: readonly ConfigRowKind[] = [
  'AgentPrompts',
  'Workflows',
  'AgentModels',
  'ProjectConfig',
  'Settings',
] as const;

export interface KindCounts {
  created: number;
  skipped: number;
  failed: number;
}

export type MigrateSummary = Readonly<Record<ConfigRowKind, KindCounts>>;

export interface MigrateDeps {
  /** Read side. The brief points this at `FsConfigStore`. */
  readonly source: ConfigStore;
  /** Write side. The brief points this at `AzureConfigStore`. */
  readonly target: ConfigStore;
  readonly logger: Logger;
}

/**
 * Drain `source.list(kind)` for every `ConfigRowKind` and create the row in
 * `target`. Existing target rows are counted as `skipped`; unexpected errors
 * are counted as `failed` and logged. The function never throws on a per-row
 * failure — the summary is the single source of truth for the exit code.
 */
export async function migrate(deps: MigrateDeps): Promise<MigrateSummary> {
  const summary: MigrateSummary = {
    AgentPrompts: { created: 0, skipped: 0, failed: 0 },
    Workflows: { created: 0, skipped: 0, failed: 0 },
    AgentModels: { created: 0, skipped: 0, failed: 0 },
    ProjectConfig: { created: 0, skipped: 0, failed: 0 },
    Settings: { created: 0, skipped: 0, failed: 0 },
  };

  for (const kind of ROW_KINDS) {
    for await (const row of deps.source.list(kind)) {
      try {
        const existing = await deps.target.get(kind, row.rowKey);
        if (existing) {
          summary[kind].skipped++;
          deps.logger.info('migrate-config: target already has row; skipping', {
            kind,
            rowKey: row.rowKey,
          });
          continue;
        }
        await deps.target.upsert({
          kind: row.kind,
          rowKey: row.rowKey,
          body: row.body,
          metadata: row.metadata,
        });
        summary[kind].created++;
      } catch (err) {
        if (err instanceof ConcurrencyError) {
          // Race with a concurrent migrator (or a future create-only Azure
          // upsert that actually returns 409): treat as "already migrated".
          summary[kind].skipped++;
          deps.logger.info('migrate-config: ConcurrencyError treated as skip', {
            kind,
            rowKey: row.rowKey,
          });
          continue;
        }
        summary[kind].failed++;
        deps.logger.error('migrate-config: row migration failed', {
          kind,
          rowKey: row.rowKey,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return summary;
}

/** Format the summary as one line per row kind for stdout. */
export function formatSummary(summary: MigrateSummary): string[] {
  return ROW_KINDS.map((k) => {
    const c = summary[k];
    return `${k}: ${c.created} created, ${c.skipped} skipped, ${c.failed} failed`;
  });
}

/** Sum the `failed` column across every row kind — drives the exit code. */
export function totalFailed(summary: MigrateSummary): number {
  return ROW_KINDS.reduce((sum, k) => sum + summary[k].failed, 0);
}
