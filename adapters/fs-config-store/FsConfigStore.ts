/**
 * FsConfigStore — filesystem adapter for the `ConfigStore` port.
 *
 * Layout under `options.fsRootPath` (defaults to `process.cwd()`):
 *
 *   worker/agents/<rowKey>.CLAUDE.md             AgentPrompts (one file per row)
 *   shared/.cache/workflows.json                 Workflows    (single JSON, keyed by rowKey)
 *   shared/.cache/agent-models.json              AgentModels  (single JSON, keyed by rowKey)
 *   shared/.cache/settings.json                  Settings     (single JSON, keyed by rowKey)
 *   projects/<rowKey>/project.json               ProjectConfig body
 *   projects/<rowKey>/context.md                 ProjectConfig metadata['context_md']
 *
 * Concurrency model:
 *
 *   - `etag` is sha256(body), recomputed on every read so a body edit
 *     produces a fresh etag without bookkeeping.
 *   - `upsert` without an etag means "create-only" (If-None-Match: *).
 *     If a row already exists the call throws `ConcurrencyError`.
 *   - `upsert` with an etag must match the current sha256; mismatch (or
 *     missing row) throws `ConcurrencyError`.
 *   - Per-file in-process locking serialises read-modify-write on the
 *     shared JSON files so two concurrent upserts cannot lose one of the
 *     rows by interleaving load/save. Cross-process locking is out of
 *     scope — this adapter is for dev and tests; the azure adapter owns
 *     the cross-process story.
 */
import { createHash } from 'crypto';
import * as fs from 'fs/promises';
import type { Stats } from 'fs';
import * as path from 'path';

import {
  ConcurrencyError,
  type ConfigRow,
  type ConfigRowKind,
  type ConfigRowUpsert,
  type ConfigStore
} from '../../core/ports/ConfigStore';
import type { ConfigStoreOptions } from '../../core/ports/ConfigStoreOptions';

const AGENT_PROMPTS_DIR = path.join('worker', 'agents');
const AGENT_PROMPT_SUFFIX = '.CLAUDE.md';
const SHARED_CACHE_DIR = path.join('shared', '.cache');
const WORKFLOWS_FILE = 'workflows.json';
const AGENT_MODELS_FILE = 'agent-models.json';
const SETTINGS_FILE = 'settings.json';
const PROJECTS_DIR = 'projects';
const PROJECT_JSON = 'project.json';
const CONTEXT_MD = 'context.md';
const CONTEXT_MD_KEY = 'context_md';

interface SharedEntry {
  body: string;
  metadata?: Record<string, string>;
  updatedAt: string;
}

type SharedFile = Record<string, SharedEntry>;

export class FsConfigStore implements ConfigStore {
  private readonly root: string;
  /**
   * Per-file lock chain. Keying on absolute file path serialises
   * read-modify-write on the same file while leaving unrelated files
   * free to run concurrently.
   */
  private readonly locks = new Map<string, Promise<void>>();

  constructor(options: ConfigStoreOptions) {
    this.root = options.fsRootPath ?? process.cwd();
  }

  async get(
    kind: ConfigRowKind,
    rowKey: string,
    signal?: AbortSignal
  ): Promise<ConfigRow | null> {
    throwIfAborted(signal);
    switch (kind) {
      case 'AgentPrompts':
        return this.getAgentPrompt(rowKey);
      case 'Workflows':
        return this.getSharedRow('Workflows', rowKey, this.workflowsPath());
      case 'AgentModels':
        return this.getSharedRow('AgentModels', rowKey, this.agentModelsPath());
      case 'Settings':
        return this.getSharedRow('Settings', rowKey, this.settingsPath());
      case 'ProjectConfig':
        return this.getProjectConfig(rowKey);
    }
  }

  async upsert(spec: ConfigRowUpsert, signal?: AbortSignal): Promise<ConfigRow> {
    throwIfAborted(signal);
    switch (spec.kind) {
      case 'AgentPrompts':
        return this.upsertAgentPrompt(spec);
      case 'Workflows':
        return this.upsertSharedRow(spec, this.workflowsPath());
      case 'AgentModels':
        return this.upsertSharedRow(spec, this.agentModelsPath());
      case 'Settings':
        return this.upsertSharedRow(spec, this.settingsPath());
      case 'ProjectConfig':
        return this.upsertProjectConfig(spec);
    }
  }

  async delete(
    kind: ConfigRowKind,
    rowKey: string,
    etag: string,
    signal?: AbortSignal
  ): Promise<void> {
    throwIfAborted(signal);
    switch (kind) {
      case 'AgentPrompts':
        return this.deleteAgentPrompt(rowKey, etag);
      case 'Workflows':
        return this.deleteSharedRow(rowKey, etag, this.workflowsPath());
      case 'AgentModels':
        return this.deleteSharedRow(rowKey, etag, this.agentModelsPath());
      case 'Settings':
        return this.deleteSharedRow(rowKey, etag, this.settingsPath());
      case 'ProjectConfig':
        return this.deleteProjectConfig(rowKey, etag);
    }
  }

  async *list(kind: ConfigRowKind, signal?: AbortSignal): AsyncIterable<ConfigRow> {
    throwIfAborted(signal);
    switch (kind) {
      case 'AgentPrompts':
        yield* this.listAgentPrompts(signal);
        return;
      case 'Workflows':
        yield* this.listShared('Workflows', this.workflowsPath(), signal);
        return;
      case 'AgentModels':
        yield* this.listShared('AgentModels', this.agentModelsPath(), signal);
        return;
      case 'Settings':
        yield* this.listShared('Settings', this.settingsPath(), signal);
        return;
      case 'ProjectConfig':
        yield* this.listProjectConfigs(signal);
        return;
    }
  }

  // ---------------------------------------------------------------------------
  // AgentPrompts — one file per row at worker/agents/<rowKey>.CLAUDE.md
  // ---------------------------------------------------------------------------

  private agentPromptPath(rowKey: string): string {
    return path.join(this.root, AGENT_PROMPTS_DIR, `${rowKey}${AGENT_PROMPT_SUFFIX}`);
  }

  private async getAgentPrompt(rowKey: string): Promise<ConfigRow | null> {
    const file = this.agentPromptPath(rowKey);
    const stat = await safeStat(file);
    if (!stat) return null;
    const body = await fs.readFile(file, 'utf8');
    return {
      kind: 'AgentPrompts',
      rowKey,
      body,
      metadata: {},
      etag: sha256(body),
      updatedAt: stat.mtime
    };
  }

  private async upsertAgentPrompt(spec: ConfigRowUpsert): Promise<ConfigRow> {
    const file = this.agentPromptPath(spec.rowKey);
    return this.withLock(file, async () => {
      const existing = await this.getAgentPrompt(spec.rowKey);
      this.checkEtag(spec.rowKey, existing, spec.etag);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, spec.body, 'utf8');
      const stat = await fs.stat(file);
      return {
        kind: 'AgentPrompts',
        rowKey: spec.rowKey,
        body: spec.body,
        metadata: {},
        etag: sha256(spec.body),
        updatedAt: stat.mtime
      };
    });
  }

  private async deleteAgentPrompt(rowKey: string, etag: string): Promise<void> {
    const file = this.agentPromptPath(rowKey);
    await this.withLock(file, async () => {
      const existing = await this.getAgentPrompt(rowKey);
      if (!existing) return;
      if (existing.etag !== etag) {
        throw new ConcurrencyError(
          `AgentPrompts row "${rowKey}" etag mismatch`,
          existing.etag
        );
      }
      await fs.unlink(file);
    });
  }

  private async *listAgentPrompts(signal?: AbortSignal): AsyncIterable<ConfigRow> {
    const dir = path.join(this.root, AGENT_PROMPTS_DIR);
    const entries = await safeReaddir(dir);
    for (const name of entries) {
      throwIfAborted(signal);
      if (!name.endsWith(AGENT_PROMPT_SUFFIX)) continue;
      const rowKey = name.slice(0, -AGENT_PROMPT_SUFFIX.length);
      const row = await this.getAgentPrompt(rowKey);
      if (row) yield row;
    }
  }

  // ---------------------------------------------------------------------------
  // Workflows / AgentModels — single JSON file, keyed by rowKey
  // ---------------------------------------------------------------------------

  private workflowsPath(): string {
    return path.join(this.root, SHARED_CACHE_DIR, WORKFLOWS_FILE);
  }

  private agentModelsPath(): string {
    return path.join(this.root, SHARED_CACHE_DIR, AGENT_MODELS_FILE);
  }

  private settingsPath(): string {
    return path.join(this.root, SHARED_CACHE_DIR, SETTINGS_FILE);
  }

  private async readSharedFile(file: string): Promise<SharedFile> {
    try {
      const raw = await fs.readFile(file, 'utf8');
      return JSON.parse(raw) as SharedFile;
    } catch (err) {
      if (isNotFound(err)) return {};
      throw err;
    }
  }

  private sharedEntryToRow(
    kind: ConfigRowKind,
    rowKey: string,
    entry: SharedEntry
  ): ConfigRow {
    return {
      kind,
      rowKey,
      body: entry.body,
      metadata: entry.metadata ? { ...entry.metadata } : {},
      etag: sha256(entry.body),
      updatedAt: new Date(entry.updatedAt)
    };
  }

  private async getSharedRow(
    kind: ConfigRowKind,
    rowKey: string,
    file: string
  ): Promise<ConfigRow | null> {
    const data = await this.readSharedFile(file);
    const entry = data[rowKey];
    if (!entry) return null;
    return this.sharedEntryToRow(kind, rowKey, entry);
  }

  private async upsertSharedRow(
    spec: ConfigRowUpsert,
    file: string
  ): Promise<ConfigRow> {
    return this.withLock(file, async () => {
      const data = await this.readSharedFile(file);
      const existing = data[spec.rowKey];
      const existingRow = existing
        ? this.sharedEntryToRow(spec.kind, spec.rowKey, existing)
        : null;
      this.checkEtag(spec.rowKey, existingRow, spec.etag);
      const entry: SharedEntry = {
        body: spec.body,
        updatedAt: new Date().toISOString()
      };
      if (spec.metadata && Object.keys(spec.metadata).length > 0) {
        entry.metadata = { ...spec.metadata };
      }
      data[spec.rowKey] = entry;
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, JSON.stringify(data, null, 2), 'utf8');
      return this.sharedEntryToRow(spec.kind, spec.rowKey, entry);
    });
  }

  private async deleteSharedRow(
    rowKey: string,
    etag: string,
    file: string
  ): Promise<void> {
    await this.withLock(file, async () => {
      const data = await this.readSharedFile(file);
      const entry = data[rowKey];
      if (!entry) return;
      const currentEtag = sha256(entry.body);
      if (currentEtag !== etag) {
        throw new ConcurrencyError(
          `row "${rowKey}" etag mismatch`,
          currentEtag
        );
      }
      delete data[rowKey];
      await fs.writeFile(file, JSON.stringify(data, null, 2), 'utf8');
    });
  }

  private async *listShared(
    kind: ConfigRowKind,
    file: string,
    signal?: AbortSignal
  ): AsyncIterable<ConfigRow> {
    const data = await this.readSharedFile(file);
    for (const [rowKey, entry] of Object.entries(data)) {
      throwIfAborted(signal);
      yield this.sharedEntryToRow(kind, rowKey, entry);
    }
  }

  // ---------------------------------------------------------------------------
  // ProjectConfig — projects/<rowKey>/project.json plus optional context.md
  // ---------------------------------------------------------------------------

  private projectDir(rowKey: string): string {
    return path.join(this.root, PROJECTS_DIR, rowKey);
  }

  private projectJsonPath(rowKey: string): string {
    return path.join(this.projectDir(rowKey), PROJECT_JSON);
  }

  private contextMdPath(rowKey: string): string {
    return path.join(this.projectDir(rowKey), CONTEXT_MD);
  }

  private async getProjectConfig(rowKey: string): Promise<ConfigRow | null> {
    const jsonFile = this.projectJsonPath(rowKey);
    const stat = await safeStat(jsonFile);
    if (!stat) return null;
    const body = await fs.readFile(jsonFile, 'utf8');
    const metadata: Record<string, string> = {};
    const ctxFile = this.contextMdPath(rowKey);
    const ctxStat = await safeStat(ctxFile);
    if (ctxStat) {
      metadata[CONTEXT_MD_KEY] = await fs.readFile(ctxFile, 'utf8');
    }
    return {
      kind: 'ProjectConfig',
      rowKey,
      body,
      metadata,
      etag: sha256(body),
      updatedAt: stat.mtime
    };
  }

  private async upsertProjectConfig(spec: ConfigRowUpsert): Promise<ConfigRow> {
    const dir = this.projectDir(spec.rowKey);
    const jsonFile = this.projectJsonPath(spec.rowKey);
    return this.withLock(jsonFile, async () => {
      const existing = await this.getProjectConfig(spec.rowKey);
      this.checkEtag(spec.rowKey, existing, spec.etag);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(jsonFile, spec.body, 'utf8');
      const ctxFile = this.contextMdPath(spec.rowKey);
      const ctx = spec.metadata?.[CONTEXT_MD_KEY];
      const metadata: Record<string, string> = {};
      if (typeof ctx === 'string') {
        await fs.writeFile(ctxFile, ctx, 'utf8');
        metadata[CONTEXT_MD_KEY] = ctx;
      } else {
        // Caller did not supply context_md — clear any stale file so the
        // metadata round-trip matches what was upserted.
        try {
          await fs.unlink(ctxFile);
        } catch (err) {
          if (!isNotFound(err)) throw err;
        }
      }
      const stat = await fs.stat(jsonFile);
      return {
        kind: 'ProjectConfig',
        rowKey: spec.rowKey,
        body: spec.body,
        metadata,
        etag: sha256(spec.body),
        updatedAt: stat.mtime
      };
    });
  }

  private async deleteProjectConfig(rowKey: string, etag: string): Promise<void> {
    const jsonFile = this.projectJsonPath(rowKey);
    await this.withLock(jsonFile, async () => {
      const existing = await this.getProjectConfig(rowKey);
      if (!existing) return;
      if (existing.etag !== etag) {
        throw new ConcurrencyError(
          `ProjectConfig row "${rowKey}" etag mismatch`,
          existing.etag
        );
      }
      await fs.rm(this.projectDir(rowKey), { recursive: true, force: true });
    });
  }

  private async *listProjectConfigs(signal?: AbortSignal): AsyncIterable<ConfigRow> {
    const dir = path.join(this.root, PROJECTS_DIR);
    const entries = await safeReaddir(dir);
    for (const name of entries) {
      throwIfAborted(signal);
      const row = await this.getProjectConfig(name);
      if (row) yield row;
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Enforce the etag contract:
   *   - No/empty caller etag → must be a fresh row.
   *   - Non-empty caller etag → row must exist with that exact etag.
   */
  private checkEtag(rowKey: string, existing: ConfigRow | null, etag?: string): void {
    if (!etag) {
      if (existing) {
        throw new ConcurrencyError(
          `row "${rowKey}" already exists; supply its etag to overwrite`,
          existing.etag
        );
      }
      return;
    }
    if (!existing) {
      throw new ConcurrencyError(
        `row "${rowKey}" not found; cannot apply etag-conditional update`,
        ''
      );
    }
    if (existing.etag !== etag) {
      throw new ConcurrencyError(
        `row "${rowKey}" etag mismatch`,
        existing.etag
      );
    }
  }

  private async withLock<T>(file: string, op: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(file) ?? Promise.resolve();
    // Use `.then(op, op)` so a previous waiter's failure does not poison
    // the chain — we still run, the previous caller still sees its own
    // rejection.
    const run = prev.then(op, op);
    this.locks.set(
      file,
      run.then(
        () => undefined,
        () => undefined
      )
    );
    return run;
  }
}

function sha256(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

async function safeStat(file: string): Promise<Stats | null> {
  try {
    return await fs.stat(file);
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch (err) {
    if (isNotFound(err)) return [];
    throw err;
  }
}

function isNotFound(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const reason = signal.reason;
    if (reason instanceof Error) throw reason;
    throw new Error('aborted');
  }
}
