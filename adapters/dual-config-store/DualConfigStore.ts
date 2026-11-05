/**
 * DualConfigStore — `ConfigStore` adapter that wraps an `fs` adapter and an
 * `azure` adapter for cutover/shadow-mode safety.
 *
 * Semantics (Fs is source of truth; Azure is a best-effort mirror):
 *
 *   - `upsert` writes to Fs first. If the Fs write throws (e.g. a
 *     `ConcurrencyError`), the error propagates and Azure is left untouched.
 *     If the Fs write succeeds, the same payload is forwarded to Azure
 *     without its etag (Fs and Azure have independent concurrency stamps,
 *     so the caller's etag belongs to Fs only). Any Azure failure is logged
 *     at Warning and swallowed — dual mode is for cutover safety and Fs is
 *     already authoritative, so a noisy Azure side must not roll back the
 *     Fs write.
 *
 *   - `delete` mirrors the same order: Fs first with the supplied etag (so
 *     concurrency is enforced against the source of truth), then Azure
 *     best-effort. Azure deletes are issued without the caller's etag — see
 *     `upsert` note above — and any failure is logged at Warning and
 *     swallowed.
 *
 *   - `get` reads Fs first. If Fs has the row, it is returned without
 *     consulting Azure. If Fs returns `null`, the call falls back to Azure;
 *     on a hit, the row is write-through cached into Fs so subsequent reads
 *     stay local. The returned row's etag always originates from Fs (either
 *     because Fs had the row already, or because the write-through made Fs
 *     the source of the etag). If the write-through itself fails (e.g.
 *     because a concurrent write populated Fs first), the warning is logged
 *     and the Azure row is returned unchanged.
 *
 *   - `list` unions both adapters' rows, deduplicated by `rowKey`, with the
 *     Fs version preferred when both contain the same key. Azure-only rows
 *     are write-through cached into Fs so the returned row's etag is the
 *     Fs etag, preserving AC #6 (ETag returned to callers always originates
 *     from Fs). Best-effort: a write-through failure during list does not
 *     break the iteration; the Azure row is yielded as a fallback and the
 *     event is logged.
 *
 * The adapter is intentionally agnostic about which concrete `ConfigStore`
 * implementations are injected — both sides simply have to satisfy the port.
 * That is what makes the unit tests possible without spinning up either Fs
 * or Azure resources.
 */
import type {
  ConfigRow,
  ConfigRowKind,
  ConfigRowUpsert,
  ConfigStore,
  Logger,
} from '../../core/ports';

export interface DualConfigStoreDeps {
  /** Source of truth: every read/write touches this first. */
  readonly fs: ConfigStore;
  /** Best-effort mirror: written after Fs, read only on Fs miss. */
  readonly azure: ConfigStore;
  /** Logger used for swallowed-Azure-failure warnings. */
  readonly logger: Logger;
}

export class DualConfigStore implements ConfigStore {
  private readonly fs: ConfigStore;
  private readonly azure: ConfigStore;
  private readonly logger: Logger;

  constructor(deps: DualConfigStoreDeps) {
    this.fs = deps.fs;
    this.azure = deps.azure;
    this.logger = deps.logger;
  }

  async get(
    kind: ConfigRowKind,
    rowKey: string,
    signal?: AbortSignal,
  ): Promise<ConfigRow | null> {
    const local = await this.fs.get(kind, rowKey, signal);
    if (local) return local;

    const remote = await this.azure.get(kind, rowKey, signal);
    if (!remote) return null;

    // Write-through so subsequent reads stay local AND the returned etag
    // originates from Fs (AC #6).
    try {
      const cached = await this.fs.upsert(
        {
          kind: remote.kind,
          rowKey: remote.rowKey,
          body: remote.body,
          metadata: remote.metadata,
        },
        signal,
      );
      return cached;
    } catch (err) {
      this.logger.warn('DualConfigStore: write-through to Fs failed on Get fallback', {
        kind,
        rowKey,
        error: errorMessage(err),
      });
      return remote;
    }
  }

  async upsert(spec: ConfigRowUpsert, signal?: AbortSignal): Promise<ConfigRow> {
    // Fs first — concurrency is enforced against the source of truth. If
    // this throws (ConcurrencyError or otherwise), the caller observes it
    // and Azure is left untouched.
    const local = await this.fs.upsert(spec, signal);

    // Best-effort mirror. The caller's etag belongs to Fs; Azure has its
    // own independent etag stamp, so we deliberately drop it on forward.
    try {
      await this.azure.upsert(
        {
          kind: spec.kind,
          rowKey: spec.rowKey,
          body: spec.body,
          metadata: spec.metadata,
        },
        signal,
      );
    } catch (err) {
      this.logger.warn('DualConfigStore: Azure upsert failed; Fs is authoritative', {
        kind: spec.kind,
        rowKey: spec.rowKey,
        error: errorMessage(err),
      });
    }

    return local;
  }

  async delete(
    kind: ConfigRowKind,
    rowKey: string,
    etag: string,
    signal?: AbortSignal,
  ): Promise<void> {
    // Fs first so the caller's etag actually gates the deletion against
    // the source of truth.
    await this.fs.delete(kind, rowKey, etag, signal);

    // Azure mirror: the caller's etag does not apply to Azure (independent
    // stamps), so we read Azure's current etag and use it. If Azure already
    // does not have the row, treat as a no-op.
    try {
      const remote = await this.azure.get(kind, rowKey, signal);
      if (remote) {
        await this.azure.delete(kind, rowKey, remote.etag, signal);
      }
    } catch (err) {
      this.logger.warn('DualConfigStore: Azure delete failed; Fs is authoritative', {
        kind,
        rowKey,
        error: errorMessage(err),
      });
    }
  }

  async *list(
    kind: ConfigRowKind,
    signal?: AbortSignal,
  ): AsyncIterable<ConfigRow> {
    // Drain Fs into a map keyed by rowKey so Azure-only rows can be filled
    // in afterwards without losing the Fs-preferred ordering / version.
    const fsRows = new Map<string, ConfigRow>();
    for await (const row of this.fs.list(kind, signal)) {
      fsRows.set(row.rowKey, row);
      yield row;
    }

    for await (const remote of this.azure.list(kind, signal)) {
      if (fsRows.has(remote.rowKey)) continue;

      // Azure-only row — write-through so the yielded etag is Fs-side.
      try {
        const cached = await this.fs.upsert(
          {
            kind: remote.kind,
            rowKey: remote.rowKey,
            body: remote.body,
            metadata: remote.metadata,
          },
          signal,
        );
        fsRows.set(cached.rowKey, cached);
        yield cached;
      } catch (err) {
        this.logger.warn(
          'DualConfigStore: write-through to Fs failed during List; yielding Azure row',
          {
            kind,
            rowKey: remote.rowKey,
            error: errorMessage(err),
          },
        );
        yield remote;
      }
    }
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
