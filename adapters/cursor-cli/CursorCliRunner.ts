/**
 * Cursor `agent` CLI runner.
 *
 * Mirrors `ClaudeCliRunner`: spawns the binary, republishes its
 * `--output-format stream-json` envelope onto the EventBus as
 * `AgentStarted` / `AgentProgress` / `AgentQuestion` / `AgentFinished` /
 * `AgentFailed`. Cursor's stream shape is structurally identical to
 * Claude's (verified against `agent -p say hi --output-format
 * stream-json`), so we reuse the existing `StreamParser` from
 * `adapters/claude-cli` verbatim — no parallel parser, no parallel
 * envelope handling.
 *
 * Two things this runner does that `ClaudeCliRunner` does not:
 *
 *   1. **Prompt hand-off.** Cursor's CLI takes the prompt as a
 *      positional argv. On Windows, the cmd.exe argv limit is 8191
 *      characters, and our agent prompts (persona + role + retry
 *      feedback + TASK.md content) routinely exceed that. We work
 *      around it by appending the operator's prompt to `TASK.md`
 *      inside the worktree (the orchestrator's writeTaskMd already
 *      seeded the file with the task description and context) and
 *      handing the agent a short bootstrap argv that says "read
 *      TASK.md and execute it as the <role> agent". TASK.md is the
 *      single hand-off surface; the agent reads everything from disk.
 *
 *   2. **No `--effort` flag.** Reasoning effort lives inside the
 *      model id on Cursor (`sonnet-4` vs `sonnet-4-thinking`), so the
 *      runner drops the entire effort-resolution machinery from
 *      `ClaudeCliRunner`. Operators pin reasoning via the model id.
 *
 * Kill semantics, sidecar marker file, `interruptById` contract,
 * idempotency-key shape, agent-id minting, stderr tail buffering, and
 * lifecycle event timing all match `ClaudeCliRunner` so the
 * `ClaudeCliAgentRunKiller` adapter and `RoleRoutingAgentRunner` slot
 * around this runner without any glue.
 */

import * as child_process from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Readable, Writable } from 'node:stream';

import type { AgentHandle, AgentRunner, AgentSpec, Logger } from '../../core/ports';
import { slimStreamMetadata } from '../../core/agents/stream-metadata';
import type { Event } from '../../core/events/event';

import { StreamParser, type ParsedStreamEvent } from '../claude-cli/streamParser';

/** Minimal publisher contract — same shape `ClaudeCliRunner` uses. */
export interface EventPublisher {
  publish(event: Event): Promise<unknown>;
}

/** Subset of `child_process.spawn` we depend on — tests inject a stub. */
export type SpawnImpl = (
  command: string,
  args: readonly string[],
  options: child_process.SpawnOptions,
) => child_process.ChildProcessByStdio<Writable | null, Readable | null, Readable | null>;

/** Platform-aware kill hook. Defaults to taskkill on Windows, SIGTERM elsewhere. */
export type Killer = (pid: number) => void | Promise<void>;

export interface CursorCliAgentHandle extends AgentHandle {
  /** PID assigned by the OS to the spawned `agent` process. */
  readonly pid: number | undefined;
}

export interface CursorCliRunnerOptions {
  readonly bus: EventPublisher;
  readonly logger?: Logger;
  readonly clock?: () => number;
  readonly newId?: () => string;
  readonly env?: () => NodeJS.ProcessEnv;
  readonly spawnImpl?: SpawnImpl;
  readonly killer?: Killer;
  readonly sidecarDir?: string;
  readonly stderrTailBytes?: number;
  /**
   * Per-role model defaults. Same precedence the inner runner uses:
   * `defaultModels[role]` → `defaultModels.developer` → env →
   * `defaultModel`. Operators populate this from
   * `CURSOR_MODEL_<ROLE>` env vars.
   */
  readonly defaultModels?: Readonly<Record<string, string>>;
  /** Global fallback when no per-role default applies. Defaults to
   *  `composer-2.5`. Operators override via `CURSOR_MODEL`. */
  readonly defaultModel?: string;
  /** Option B: per-role model override (Agents panel), consulted above the
   *  cursor role defaults but below an explicit flow step.model. */
  readonly resolveDefaultModel?: (role: string) => string | undefined;
}

type ChildProc = child_process.ChildProcessByStdio<
  Writable | null,
  Readable | null,
  Readable | null
>;

interface ActiveRun {
  readonly proc: ChildProc;
  readonly handle: CursorCliAgentHandle;
  killed: boolean;
  finished: boolean;
}

interface RunContext {
  readonly id: string;
  readonly role: string;
  readonly run: ActiveRun;
  readonly parser: StreamParser;
  readonly metadata?: Readonly<Record<string, unknown>>;
  /** Slimmed {@link metadata} for the per-chunk events, cached per run. */
  streamMetaTail?: { readonly metadata?: Readonly<Record<string, unknown>> };
  publishQueue: Promise<unknown>;
  progressSeq: number;
  questionSeq: number;
  stderrBuf: string;
  bodyBuf: string;
  activitySeq: number;
  stderrLineBuf: string;
}

const DEFAULT_STDERR_TAIL = 2048;
const DEFAULT_MODEL = 'composer-2.5';

const TASK_MD_FILENAME = 'TASK.md';
const TASK_MD_DIVIDER = '\n\n<!-- cursor-cli-runner: appended operator instructions -->\n';

function readMetadataString(spec: AgentSpec, key: string): string | undefined {
  const raw = spec.metadata?.[key];
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

function defaultKiller(pid: number): void {
  if (process.platform === 'win32') {
    child_process.execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore' });
  } else {
    process.kill(pid, 'SIGTERM');
  }
}

/**
 * Spawns the `agent` CLI per `AgentSpec` and republishes its
 * stream-json output onto the EventBus. Lifecycle events flow over the
 * bus (NOT through the handle) — same contract as `ClaudeCliRunner`.
 */
export class CursorCliRunner implements AgentRunner {
  private readonly bus: EventPublisher;
  private readonly logger: Logger | undefined;
  private readonly clock: () => number;
  private readonly newId: () => string;
  private readonly readEnv: () => NodeJS.ProcessEnv;
  private readonly spawnImpl: SpawnImpl;
  private readonly killer: Killer;
  private readonly sidecarDir: string;
  private readonly stderrTailBytes: number;
  private readonly defaultModels: Readonly<Record<string, string>>;
  private readonly resolveDefaultModel?: (role: string) => string | undefined;
  private readonly defaultModel: string;

  private readonly active = new Map<string, ActiveRun>();
  private counter = 0;

  constructor(options: CursorCliRunnerOptions) {
    this.bus = options.bus;
    this.logger = options.logger;
    this.clock = options.clock ?? ((): number => Date.now());
    const instanceSig = `${Date.now().toString(36)}-${process.pid}`;
    this.newId =
      options.newId ?? ((): string => `cursor-cli-${instanceSig}-${++this.counter}`);
    this.readEnv = options.env ?? ((): NodeJS.ProcessEnv => process.env);
    this.spawnImpl = options.spawnImpl ?? (child_process.spawn as unknown as SpawnImpl);
    this.killer = options.killer ?? defaultKiller;
    this.sidecarDir =
      options.sidecarDir ?? path.join(os.tmpdir(), 'dropagents', 'agent-killed');
    this.stderrTailBytes = options.stderrTailBytes ?? DEFAULT_STDERR_TAIL;
    this.defaultModels = options.defaultModels ?? {};
    this.resolveDefaultModel = options.resolveDefaultModel;
    this.defaultModel = options.defaultModel ?? DEFAULT_MODEL;
  }

  start(spec: AgentSpec): CursorCliAgentHandle {
    const id = this.newId();
    const env = this.readEnv();

    // Hand the full operator prompt over via TASK.md before spawning —
    // see the class docstring for the rationale. Best-effort: a write
    // failure logs a warning and we still spawn (the bootstrap prompt
    // will reference TASK.md and the agent will fail gracefully if
    // the file is incomplete).
    this.appendPromptToTaskMd(spec, id);

    const { cmd, args } = this.buildSpawnArgs(env, spec);

    const proc = this.spawnImpl(cmd, args, {
      cwd: spec.cwd,
      env: { ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });

    const handle: CursorCliAgentHandle = { id, spec, pid: proc.pid };

    const startedPublish = this.publish(
      'AgentStarted',
      `cursor-cli:AgentStarted:${id}`,
      {
        agentId: id,
        role: spec.role,
        pid: proc.pid,
        ...(spec.metadata !== undefined ? { metadata: spec.metadata } : {}),
      },
    );

    // Cursor reads the prompt from argv, not stdin. We still close
    // stdin so the child doesn't hang waiting for input that never
    // arrives.
    try { proc.stdin?.end(); } catch { /* best-effort */ }

    const run: ActiveRun = { proc, handle, killed: false, finished: false };
    this.active.set(id, run);

    const ctx: RunContext = {
      id,
      role: spec.role,
      run,
      parser: new StreamParser(),
      metadata: spec.metadata,
      publishQueue: startedPublish,
      progressSeq: 0,
      questionSeq: 0,
      stderrBuf: '',
      bodyBuf: '',
      activitySeq: 0,
      stderrLineBuf: '',
    };

    this.attachStdout(proc, ctx);
    this.attachStderr(proc, ctx);
    this.attachLifecycle(proc, ctx);

    return handle;
  }

  async interrupt(handle: AgentHandle): Promise<void> {
    const run = this.active.get(handle.id);
    if (!run) return;
    if (run.killed) return;
    run.killed = true;
    const pid = run.proc.pid;
    this.writeKilledSidecar(handle.id, pid);
    if (pid === undefined) return;
    try {
      await this.killer(pid);
    } catch (err) {
      this.logger?.warn('cursor-cli kill failed', {
        agentId: handle.id,
        pid,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async interruptById(runId: string): Promise<void> {
    const run = this.active.get(runId);
    if (!run) return;
    await this.interrupt(run.handle);
  }

  killedSidecarPath(agentId: string): string {
    return path.join(this.sidecarDir, `${agentId}.killed`);
  }

  // -------------------------------------------------------------------------
  // spawn helpers
  // -------------------------------------------------------------------------

  private buildSpawnArgs(
    env: NodeJS.ProcessEnv,
    spec: AgentSpec,
  ): { cmd: string; args: string[] } {
    const cmd = env.CURSOR_CMD || 'agent';
    const model = this.resolveModel(env, spec);
    const bootstrap = this.buildBootstrapPrompt(spec);
    const args: string[] = [
      '--print',
      '--output-format', 'stream-json',
      '--stream-partial-output',
      '--model', model,
      '--force',
      '--trust',
      '--approve-mcps',
    ];
    if (spec.cwd) {
      args.push('--workspace', spec.cwd);
    }
    // Positional prompt — Cursor reads instructions from argv. We
    // intentionally keep this short (< 1 KB) so cmd.exe's 8191-char
    // argv limit is never a concern; the bulk of the role / persona /
    // task context lives in TASK.md inside the worktree.
    args.push(bootstrap);
    return { cmd, args };
  }

  /**
   * Short bootstrap prompt the agent reads as its positional argv.
   * Sized to stay well under the Windows argv limit; the agent reads
   * everything else from TASK.md in the worktree.
   */
  private buildBootstrapPrompt(spec: AgentSpec): string {
    return (
      `You are the ${spec.role} agent in an automated pipeline. ` +
      `Read TASK.md in the current workspace (the working directory) and execute the task ` +
      `exactly as that file specifies — its contents include the role-specific instructions, ` +
      `acceptance criteria, conventions, and any retry feedback. ` +
      `Strictly follow your role's output conventions: ` +
      `reviewer must emit "APPROVED" or "CHANGES REQUIRED:" followed by the changes; ` +
      `tester must emit "ALL TESTS PASSED" or "TESTS FAILED:" followed by the failures; ` +
      `developer / committer should produce concise output describing what was done. ` +
      `If TASK.md is missing or ambiguous, output "NEEDS_HUMAN_INPUT:" followed by your question.`
    );
  }

  /**
   * Resolution order for `--model`:
   *   1. `spec.metadata.model` — explicit per-call override; `claude-*`
   *      ids are stripped so a pipeline.yaml left over from a Claude
   *      run does not reach the Cursor CLI literally.
   *   2. `defaultModels[role]` — pipeline.yaml `default_models`.
   *   3. `defaultModels.developer` — every role falls back to the
   *      developer entry.
   *   4. `env.CURSOR_MODEL_<ROLE>` — per-role env override.
   *   5. `env.CURSOR_MODEL` — single-var override.
   *   6. `this.defaultModel` (constructor; defaults to `composer-2.5`).
   */
  private resolveModel(env: NodeJS.ProcessEnv, spec: AgentSpec): string {
    const explicit = readMetadataString(spec, 'model');
    if (explicit && explicit !== 'none' && !explicit.startsWith('claude-')) {
      return explicit;
    }
    const fromAgent = this.resolveDefaultModel?.(spec.role);
    if (fromAgent && fromAgent !== 'none') return fromAgent;
    const fromRole = this.defaultModels[spec.role];
    if (fromRole) return fromRole;
    const fromDeveloper = this.defaultModels.developer;
    if (fromDeveloper) return fromDeveloper;
    const roleKey = `CURSOR_MODEL_${spec.role.toUpperCase()}`;
    return env[roleKey] || env.CURSOR_MODEL || this.defaultModel;
  }

  /**
   * Append `spec.prompt` to TASK.md in the worktree so the agent can
   * read it from disk. The orchestrator's writeTaskMd already wrote
   * the task description + plan context into the file before this
   * step; we add a divider + the operator's per-step prompt (which
   * carries role, retry feedback, etc.) so a single file is the
   * complete hand-off surface.
   *
   * Best-effort. A write failure logs and continues — the agent's
   * fallback is the bootstrap argv, which still points it at TASK.md.
   */
  private appendPromptToTaskMd(spec: AgentSpec, agentId: string): void {
    if (!spec.cwd || spec.cwd.length === 0) return;
    if (!spec.prompt || spec.prompt.length === 0) return;
    const target = path.join(spec.cwd, TASK_MD_FILENAME);
    try {
      fs.mkdirSync(spec.cwd, { recursive: true });
      const block = `${TASK_MD_DIVIDER}${spec.prompt.trimEnd()}\n`;
      fs.appendFileSync(target, block, 'utf8');
    } catch (err) {
      this.logger?.warn('cursor-cli: TASK.md append failed', {
        agentId,
        path: target,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // -------------------------------------------------------------------------
  // stream attachment helpers — identical to ClaudeCliRunner; the stream
  // envelope shape is the same, so the parser machinery transplants
  // verbatim apart from the idempotency-key prefix swap.
  // -------------------------------------------------------------------------

  private attachStdout(proc: ChildProc, ctx: RunContext): void {
    proc.stdout?.on('data', (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      this.enqueueParsed(ctx, ctx.parser.push(text));
    });
  }

  private attachStderr(proc: ChildProc, ctx: RunContext): void {
    proc.stderr?.on('data', (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      ctx.stderrBuf = (ctx.stderrBuf + text).slice(-this.stderrTailBytes);
      ctx.stderrLineBuf += text;
      for (;;) {
        const nl = ctx.stderrLineBuf.indexOf('\n');
        if (nl < 0) break;
        const line = ctx.stderrLineBuf.slice(0, nl).trimEnd();
        ctx.stderrLineBuf = ctx.stderrLineBuf.slice(nl + 1);
        if (line.length === 0) continue;
        this.enqueueStderrLine(ctx, line);
      }
    });
  }

  /**
   * Metadata for a per-CHUNK event. Same reasoning as the claude-cli
   * runner's: the full spec metadata on every text delta is what made
   * `AgentProgress` 86% of the field event log's payload bytes. See
   * `core/agents/stream-metadata.ts`.
   */
  private streamMetaTail(
    ctx: RunContext,
  ): { readonly metadata?: Readonly<Record<string, unknown>> } {
    const cached = ctx.streamMetaTail;
    if (cached !== undefined) return cached;
    const slimmed = slimStreamMetadata(ctx.metadata);
    if (slimmed.dropped.length > 0) {
      // Key names only, once per run.
      this.logger?.debug(
        'cursor-cli: oversized metadata kept off the per-chunk events',
        { agentId: ctx.id, role: ctx.role, keys: slimmed.dropped.join(', ') },
      );
    }
    const tail = slimmed.metadata !== undefined ? { metadata: slimmed.metadata } : {};
    ctx.streamMetaTail = tail;
    return tail;
  }

  private enqueueStderrLine(ctx: RunContext, line: string): void {
    const metaTail = this.streamMetaTail(ctx);
    ctx.publishQueue = ctx.publishQueue.then(() =>
      this.publish(
        'AgentActivity',
        `cursor-cli:AgentActivity:${ctx.id}:${++ctx.activitySeq}`,
        {
          agentId: ctx.id,
          category: 'stderr',
          detail: line.length > 240 ? line.slice(0, 240) + '…' : line,
          ...metaTail,
        },
      ),
    );
  }

  private attachLifecycle(proc: ChildProc, ctx: RunContext): void {
    proc.on('error', (err: Error) => {
      ctx.publishQueue = ctx.publishQueue.then(() => this.publishSpawnError(ctx, err));
    });
    proc.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      this.enqueueParsed(ctx, ctx.parser.flush());
      if (ctx.stderrLineBuf.length > 0) {
        const tail = ctx.stderrLineBuf.trimEnd();
        ctx.stderrLineBuf = '';
        if (tail.length > 0) this.enqueueStderrLine(ctx, tail);
      }
      ctx.publishQueue = ctx.publishQueue.then(() => this.publishClose(ctx, code, signal));
    });
  }

  private enqueueParsed(ctx: RunContext, events: ParsedStreamEvent[]): void {
    for (const ev of events) {
      ctx.publishQueue = ctx.publishQueue.then(() => this.publishParsed(ctx, ev));
    }
  }

  private publishParsed(
    ctx: RunContext,
    ev: ParsedStreamEvent,
  ): Promise<unknown> | undefined {
    // Slimmed for the per-chunk branches; full for the terminal
    // `AgentFinished` at the bottom, which fires once per run.
    const streamTail = this.streamMetaTail(ctx);
    const metaTail = ctx.metadata !== undefined ? { metadata: ctx.metadata } : {};
    if (ev.kind === 'progress') {
      ctx.bodyBuf += ev.chunk;
      return this.publish(
        'AgentProgress',
        `cursor-cli:AgentProgress:${ctx.id}:${++ctx.progressSeq}`,
        { agentId: ctx.id, role: ev.role, chunk: ev.chunk, ...streamTail },
      );
    }
    if (ev.kind === 'question') {
      return this.publish(
        'AgentQuestion',
        `cursor-cli:AgentQuestion:${ctx.id}:${++ctx.questionSeq}`,
        { agentId: ctx.id, question: ev.question, ...streamTail },
      );
    }
    if (ev.kind === 'activity') {
      return this.publish(
        'AgentActivity',
        `cursor-cli:AgentActivity:${ctx.id}:${++ctx.activitySeq}`,
        {
          agentId: ctx.id,
          category: ev.category,
          detail: ev.detail,
          ...(ev.extra !== undefined ? { extra: ev.extra } : {}),
          ...streamTail,
        },
      );
    }
    if (ctx.run.finished) return undefined;
    ctx.run.finished = true;
    return this.publish('AgentFinished', `cursor-cli:AgentFinished:${ctx.id}`, {
      agentId: ctx.id,
      role: ctx.role,
      outcome: ev.outcome,
      content: ctx.bodyBuf,
      ...metaTail,
    });
  }

  private publishSpawnError(ctx: RunContext, err: Error): Promise<unknown> | undefined {
    if (ctx.run.finished) return undefined;
    ctx.run.finished = true;
    const metaTail = ctx.metadata !== undefined ? { metadata: ctx.metadata } : {};
    return this.publish('AgentFailed', `cursor-cli:AgentFailed:${ctx.id}`, {
      agentId: ctx.id,
      role: ctx.role,
      exitCode: null,
      stderrTail: err.message,
      ...metaTail,
    });
  }

  private publishClose(
    ctx: RunContext,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): Promise<unknown> | undefined {
    this.active.delete(ctx.id);
    if (ctx.run.finished) return undefined;
    ctx.run.finished = true;
    const metaTail = ctx.metadata !== undefined ? { metadata: ctx.metadata } : {};
    if (ctx.run.killed) {
      return this.publish('AgentFinished', `cursor-cli:AgentFinished:${ctx.id}`, {
        agentId: ctx.id,
        role: ctx.role,
        outcome: 'interrupted',
        content: ctx.bodyBuf,
        ...metaTail,
      });
    }
    if (code === 0) {
      return this.publish('AgentFinished', `cursor-cli:AgentFinished:${ctx.id}`, {
        agentId: ctx.id,
        role: ctx.role,
        outcome: 'success',
        content: ctx.bodyBuf,
        ...metaTail,
      });
    }
    return this.publish('AgentFailed', `cursor-cli:AgentFailed:${ctx.id}`, {
      agentId: ctx.id,
      role: ctx.role,
      exitCode: code,
      signal,
      stderrTail: ctx.stderrBuf,
      ...metaTail,
    });
  }

  private writeKilledSidecar(agentId: string, pid: number | undefined): void {
    const file = this.killedSidecarPath(agentId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ pid: pid ?? null, killedAt: this.clock() }));
  }

  private publish(
    type: string,
    idempotencyKey: string,
    payload: Record<string, unknown>,
  ): Promise<unknown> {
    return this.bus.publish({
      type,
      v: 1,
      occurredAt: this.clock(),
      idempotencyKey,
      payload,
    });
  }
}
