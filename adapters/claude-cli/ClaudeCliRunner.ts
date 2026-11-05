import * as child_process from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Readable, Writable } from 'node:stream';

import type { AgentHandle, AgentRunner, AgentSpec, Logger } from '../../core/ports';
import { slimStreamMetadata } from '../../core/agents/stream-metadata';
import type { Event } from '../../core/events/event';

import { StreamParser, type ParsedStreamEvent } from './streamParser';
import {
  promptDumpPath,
  renderPromptDump,
  shouldDumpPrompt,
  type PromptDumpWriter,
} from './prompt-dump';

/**
 * Real filesystem write for `PIPELINE_DUMP_PROMPTS`, creating the dump
 * directory on demand. Swapped out in tests so the policy can be
 * asserted without touching disk.
 */
const defaultPromptDumpWriter: PromptDumpWriter = (filePath, contents): void => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, 'utf8');
};

/**
 * Minimal publisher contract — same shape FakeAgentRunner uses, so the real
 * EventBus from core/events/bus.ts satisfies it without any glue.
 */
export interface EventPublisher {
  publish(event: Event): Promise<unknown>;
}

/**
 * Subset of `child_process.spawn` we depend on. Tests inject a fake that
 * returns an EventEmitter-backed stand-in so no real `claude` process is
 * needed.
 */
export type SpawnImpl = (
  command: string,
  args: readonly string[],
  options: child_process.SpawnOptions,
) => child_process.ChildProcessByStdio<Writable | null, Readable | null, Readable | null>;

/** Platform-aware kill hook. Defaults to taskkill on Windows, SIGTERM elsewhere. */
export type Killer = (pid: number) => void | Promise<void>;

export interface ClaudeCliAgentHandle extends AgentHandle {
  /** PID assigned by the OS to the spawned `claude` process. May be undefined
   *  for the brief window between spawn and OS scheduling, or after a sync
   *  spawn failure. */
  readonly pid: number | undefined;
}

export interface ClaudeCliRunnerOptions {
  readonly bus: EventPublisher;
  readonly logger?: Logger;
  /** Source of "now" for emitted events. Defaults to Date.now. */
  readonly clock?: () => number;
  /** Override the synthetic agent-id generator. Defaults to `claude-cli-N`. */
  readonly newId?: () => string;
  /** Snapshot of env to read CLAUDE_* vars from. Defaults to process.env at
   *  call time (NOT module load — see comment in resolveEnv). */
  readonly env?: () => NodeJS.ProcessEnv;
  /** Override child_process.spawn. Tests inject a stub. */
  readonly spawnImpl?: SpawnImpl;
  /** Override the kill mechanism. Tests assert ordering against the sidecar. */
  readonly killer?: Killer;
  /** Directory to write `.killed` sidecar markers into. Defaults to a tmp
   *  subdir; the orchestrator host can pin it to its workspace. */
  readonly sidecarDir?: string;
  /** How many trailing bytes of stderr to attach to AgentFailed. */
  readonly stderrTailBytes?: number;
  /**
   * Directory an agent runs in when its spec resolves NO repo. Defaults
   * to an empty tmp subdir. See {@link ClaudeCliRunner.resolveCwd} — the
   * one thing it must never be is the orchestrator's own process cwd.
   */
  readonly noRepoCwd?: string;
  /**
   * Milliseconds the CLI gets to exit after its terminal `result`
   * frame before the runner kills the process tree. Tests shrink it;
   * production uses the 30s default.
   */
  readonly reapGraceMs?: number;
  /**
   * Per-role model defaults, normally sourced from pipeline.yaml's
   * `default_models` map (e.g. `{ developer: 'claude-opus-4-7', reviewer:
   * 'claude-sonnet-4-6' }`). The runner resolves the `--model` arg for each
   * spawn by looking up `defaultModels[spec.role]`, falling back to
   * `defaultModels.developer` when the role-specific entry is unset. The
   * legacy `CLAUDE_MODEL` env var is consulted last so single-machine
   * developer setups keep working without a pipeline.yaml in scope.
   */
  readonly defaultModels?: Readonly<Record<string, string>>;
  /**
   * Directory `PIPELINE_DUMP_PROMPTS` writes into. Defaults to a tmp
   * subdir — deliberately OUTSIDE any repo, so an enabled dump can never
   * drop files into a working tree. `PIPELINE_DUMP_PROMPTS_DIR`
   * overrides it per run.
   */
  readonly promptDumpDir?: string;
  /** Override the dump write. Tests inject a recorder instead of hitting disk. */
  readonly promptDumpWriter?: PromptDumpWriter;
  /**
   * Optional per-role model override consulted BEFORE `defaultModels` — the
   * live per-agent model set through the management UI (Agents panel, Option B).
   * Returns undefined for a role with no override, falling through to
   * `defaultModels` / env exactly as before. A callback (not a static map) so
   * the orchestrator reads the shared agents table at spawn time — UI edits
   * apply on the next spawn without reconstructing the runner. An explicit
   * flow `step.model` still wins over this (precedence B-model-A).
   */
  readonly resolveDefaultModel?: (role: string) => string | undefined;
}

type ChildProc = child_process.ChildProcessByStdio<
  Writable | null,
  Readable | null,
  Readable | null
>;

interface ActiveRun {
  readonly proc: ChildProc;
  readonly handle: ClaudeCliAgentHandle;
  killed: boolean;
  finished: boolean;
  /** Grace timer armed when the CLI reports its terminal `result` frame. */
  reapTimer?: ReturnType<typeof setTimeout>;
}

/**
 * Mutable per-run state shared between `start` and the stream/lifecycle
 * helpers. Kept private to this module — exposed only so the helpers can
 * thread a single object instead of half a dozen parameters.
 */
interface RunContext {
  readonly id: string;
  readonly role: string;
  readonly run: ActiveRun;
  readonly parser: StreamParser;
  /**
   * AgentSpec.metadata snapshotted at run-start time. Republished on
   * every Agent* event so downstream subscribers (board projection,
   * planner-status reader) can correlate `agentId` back to a plan /
   * task without having to maintain their own agentId → metadata
   * table. Optional because some callers (decomposer, ad-hoc test
   * harness) start a run without metadata.
   */
  readonly metadata?: Readonly<Record<string, unknown>>;
  /**
   * {@link metadata} with the oversized entries removed, for the
   * per-CHUNK events. Computed once per run and cached: `ctx.metadata`
   * never changes and a run emits thousands of chunks.
   */
  streamMetaTail?: { readonly metadata?: Readonly<Record<string, unknown>> };
  /** Serialises publishes so events reach the bus in causal order even
   *  though `publish` is async. Each helper rebinds it via `.then(...)`. */
  publishQueue: Promise<unknown>;
  progressSeq: number;
  questionSeq: number;
  stderrBuf: string;
  /**
   * AP-VP4-010: accumulator for every assistant-text chunk the parser
   * surfaces over a run. Republished verbatim on AgentFinished as
   * `content` so downstream subscribers (planner / decomposer dispatch)
   * can extract the rendered markdown body or JSON payload without having
   * to re-derive it from the per-chunk AgentProgress stream.
   */
  bodyBuf: string;
  /**
   * Monotonic counter for AgentActivity publishes (parser-surfaced
   * tool frames + stderr lines). Independent of progressSeq so a
   * subscriber filtering on one kind doesn't see gaps from the other.
   */
  activitySeq: number;
  /**
   * Trailing partial line buffered from stderr. stderr chunks arrive
   * mid-line; we hold the tail until the next newline so each
   * AgentActivity carries a complete log line. Drained when stderr
   * closes (proc 'close' event).
   */
  stderrLineBuf: string;
}

const DEFAULT_STDERR_TAIL = 2048;

/**
 * How long the CLI gets to exit after its terminal `result` frame
 * before the runner kills the process tree. Generous on purpose: a
 * normal exit is immediate, and the only thing this window buys is
 * letting a slow-but-healthy teardown (MCP servers closing) finish on
 * its own rather than being killed for being unhurried.
 */
const DEFAULT_REAP_GRACE_MS = 30_000;

/**
 * Pull a non-empty string field out of `spec.metadata`. Used to extract the
 * per-call `model` / `effort` overrides the orchestrator threads through
 * from the FlowStep. Any non-string or empty value is treated as absent so
 * a caller passing `metadata: { model: undefined }` (or an int by mistake)
 * falls through to the next layer instead of being routed to the CLI as
 * `--model undefined`.
 */
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
 * Spawns the `claude` CLI per AgentSpec and republishes its stream-json output
 * onto the EventBus as AgentStarted / AgentProgress / AgentQuestion /
 * AgentFinished / AgentFailed.
 *
 * `start(spec)` is synchronous: it spawns the child, fires AgentStarted, and
 * returns the handle. Lifecycle events flow over the bus, NOT through the
 * handle, matching the AgentRunner port contract.
 *
 * `interrupt(handle)` writes a `.killed` sidecar marker BEFORE invoking the
 * platform kill — so the close handler can distinguish "operator pressed
 * stop" from "the CLI crashed". On Windows where SIGTERM is meaningless for
 * cmd-spawned processes, the sidecar is the only reliable signal.
 */
export class ClaudeCliRunner implements AgentRunner {
  private readonly bus: EventPublisher;
  private readonly logger: Logger | undefined;
  private readonly clock: () => number;
  private readonly newId: () => string;
  private readonly readEnv: () => NodeJS.ProcessEnv;
  private readonly spawnImpl: SpawnImpl;
  private readonly killer: Killer;
  private readonly sidecarDir: string;
  private readonly noRepoCwd: string;
  private readonly stderrTailBytes: number;
  /** Grace after the terminal frame before the child is killed. */
  private readonly reapGraceMs: number;
  private readonly defaultModels: Readonly<Record<string, string>>;
  private readonly promptDumpDir: string;
  private readonly promptDumpWriter: PromptDumpWriter;
  private readonly resolveDefaultModel?: (role: string) => string | undefined;

  private readonly active = new Map<string, ActiveRun>();
  private counter = 0;

  constructor(options: ClaudeCliRunnerOptions) {
    this.bus = options.bus;
    this.logger = options.logger;
    this.clock = options.clock ?? ((): number => Date.now());
    // Suffix every generated agent id with the runner's birth time +
    // pid so a worker restart can't collide with the previous session's
    // ids. The events table has `UNIQUE(idempotency_key)` and the
    // runner derives its keys from the agent id (e.g.
    // `claude-cli:AgentStarted:claude-cli-1`). A bare counter would
    // mint `claude-cli-1` again on every boot, and INSERT OR IGNORE
    // would silently drop the new lifecycle events as duplicates of
    // the prior session's. Embedding the instance signature keeps the
    // keys unique across restarts without losing the human-readable
    // monotonic suffix.
    const instanceSig = `${Date.now().toString(36)}-${process.pid}`;
    this.newId = options.newId ?? ((): string => `claude-cli-${instanceSig}-${++this.counter}`);
    this.readEnv = options.env ?? ((): NodeJS.ProcessEnv => process.env);
    this.spawnImpl = options.spawnImpl ?? (child_process.spawn as unknown as SpawnImpl);
    this.killer = options.killer ?? defaultKiller;
    this.sidecarDir =
      options.sidecarDir ?? path.join(os.tmpdir(), 'dropagents', 'agent-killed');
    this.noRepoCwd =
      options.noRepoCwd ?? path.join(os.tmpdir(), 'dropagents', 'agent-no-repo');
    this.stderrTailBytes = options.stderrTailBytes ?? DEFAULT_STDERR_TAIL;
    this.reapGraceMs = options.reapGraceMs ?? DEFAULT_REAP_GRACE_MS;
    this.defaultModels = options.defaultModels ?? {};
    this.resolveDefaultModel = options.resolveDefaultModel;
    this.promptDumpDir =
      options.promptDumpDir ?? path.join(os.tmpdir(), 'dropagents', 'prompts');
    this.promptDumpWriter = options.promptDumpWriter ?? defaultPromptDumpWriter;
  }

  /**
   * Write the composed prompt to disk when `PIPELINE_DUMP_PROMPTS` names
   * this role. See `prompt-dump.ts` for why: the prompt is otherwise
   * unrecoverable after the run, which makes an API-level rejection
   * impossible to diagnose.
   *
   * Best-effort in every direction. A dump that cannot be written logs a
   * warning and the spawn proceeds — this is a debugging aid, and losing
   * the real run to it would be a worse bug than the one it is here to
   * help find. The path is logged at INFO because a knob whose output
   * you cannot locate is not much of a knob.
   */
  private dumpPromptIfEnabled(
    env: NodeJS.ProcessEnv,
    spec: AgentSpec,
    id: string,
    model: string,
    effort: string,
    cwd: string,
  ): void {
    try {
      if (!shouldDumpPrompt(env.PIPELINE_DUMP_PROMPTS, spec.role)) return;
      const dir = typeof env.PIPELINE_DUMP_PROMPTS_DIR === 'string'
        && env.PIPELINE_DUMP_PROMPTS_DIR.trim().length > 0
        ? env.PIPELINE_DUMP_PROMPTS_DIR.trim()
        : this.promptDumpDir;
      const meta = (spec.metadata ?? {}) as Record<string, unknown>;
      const str = (v: unknown): string | undefined =>
        typeof v === 'string' && v.length > 0 ? v : undefined;
      const ctx = {
        agentId: id,
        role: spec.role,
        model,
        effort,
        cwd,
        at: this.clock(),
        planId: str(meta.planId),
        taskId: str(meta.taskId),
        kind: str(meta.kind),
      };
      const file = promptDumpPath(dir, ctx);
      this.promptDumpWriter(file, renderPromptDump(ctx, spec.prompt));
      this.logger?.info('claude-cli: prompt dumped (PIPELINE_DUMP_PROMPTS)', {
        agentId: id,
        role: spec.role,
        file,
        promptChars: spec.prompt.length,
      });
    } catch (err) {
      this.logger?.warn('claude-cli: prompt dump failed — the spawn continues', {
        agentId: id,
        role: spec.role,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * The directory the child actually runs in.
   *
   * A spec with no `cwd` used to be passed straight to `spawn`, and
   * `spawn({cwd: undefined})` INHERITS the parent's working directory —
   * which for every agent is the orchestrator's own checkout of this
   * repo. So "no repo resolved" did not mean "no repo": it meant "run
   * against dropagents". Agents duly investigated and edited the
   * pipeline's own source instead of the task's repo, and claude's
   * CLAUDE.md discovery walked up from there into the operator's
   * personal repo tree — the exact failure the workspace-boundary block
   * exists to prevent.
   *
   * A repo-less spawn is legitimate for some roles (a planner on a plan
   * whose targetRepo isn't registered yet, a scaffolder for a repo that
   * does not exist), so this refuses to guess a repo rather than
   * refusing to run: the child gets an EMPTY directory containing no
   * source and no CLAUDE.md, and the warning names the agent so the
   * operator can see it happened.
   */
  private resolveCwd(id: string, spec: AgentSpec): string {
    if (typeof spec.cwd === 'string' && spec.cwd.length > 0) return spec.cwd;
    try {
      fs.mkdirSync(this.noRepoCwd, { recursive: true });
    } catch (err) {
      // Best-effort: an unwritable tmp is not a reason to fall back to
      // inheriting the orchestrator's cwd — that is the bug. spawn will
      // surface the bad-path error on its own.
      this.logger?.warn('claude-cli: could not create the no-repo cwd', {
        agentId: id,
        dir: this.noRepoCwd,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    this.logger?.warn('claude-cli: spawning with NO repo — using an empty scratch cwd', {
      agentId: id,
      role: spec.role,
      cwd: this.noRepoCwd,
    });
    return this.noRepoCwd;
  }

  start(spec: AgentSpec): ClaudeCliAgentHandle {
    const id = this.newId();
    const env = this.readEnv();
    const { cmd, args, model, effort } = this.buildSpawnArgs(env, spec);
    const cwd = this.resolveCwd(id, spec);

    // Windows: npm-installed CLIs ship as `<name>.cmd` shims that
    // child_process.spawn refuses to execute directly (EINVAL). Setting
    // `shell: true` routes the call through cmd.exe (or /bin/sh on
    // POSIX), which resolves `.cmd` shims correctly. Safe here because
    // every arg in `args` is a well-known constant (no operator-supplied
    // strings); the prompt itself goes over stdin, not argv, so there's
    // nothing for the shell to interpret.
    // Spawn parameters at INFO so a machine-specific failure ("The
    // system cannot find the path specified.", stale CLAUDE_CMD, PATH
    // drift under a service account) is diagnosable from the worker
    // log alone. `args` are well-known constants; the prompt goes over
    // stdin and is never logged.
    this.logger?.info('claude-cli: spawning', {
      agentId: id,
      role: spec.role,
      cmd,
      cwd,
      args: args.join(' '),
    });
    const proc = this.spawnImpl(cmd, args, {
      cwd,
      // spec.env last: it carries the task repo's GitHub account, and
      // it has to win over an ambient GH_CONFIG_DIR or GIT_AUTHOR_*
      // inherited from the worker process.
      env: { ...env, ...(spec.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });

    const handle: ClaudeCliAgentHandle = { id, spec, pid: proc.pid };

    // Synchronously kick off AgentStarted so the bus receives it before any
    // stdout-driven publish queued below. `metadata` is forwarded
    // verbatim from the AgentSpec so subscribers can correlate the
    // run with its lifecycle context (planId / kind / etc) without a
    // side-channel lookup table.
    const startedPublish = this.publish(
      'AgentStarted',
      `claude-cli:AgentStarted:${id}`,
      {
        agentId: id,
        role: spec.role,
        pid: proc.pid,
        // Resolved model/effort — what this run ACTUALLY uses after the
        // step/agent-record/pipeline/env fallback chain. Surfaced so the
        // board can tag cards with the agent that ran (crucial when
        // triaging a bad run: which model produced this?).
        model,
        effort,
        ...(spec.metadata !== undefined ? { metadata: spec.metadata } : {}),
      },
    );

    // Before stdin, not after: a prompt the API rejects must still be on
    // disk, and a child that dies instantly would otherwise take the one
    // copy of it with them.
    this.dumpPromptIfEnabled(env, spec, id, model, effort, cwd);

    this.writePromptToStdin(proc, spec.prompt, id);

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
    // Sidecar is written BEFORE the kill so the close handler — which races
    // the kill on Windows — can read it and treat the exit as operator-driven.
    this.writeKilledSidecar(handle.id, pid);

    if (pid === undefined) return;
    try {
      await this.killer(pid);
    } catch (err) {
      this.logger?.warn('claude-cli kill failed', {
        agentId: handle.id,
        pid,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Bridge for the `AgentRunKiller` port (`kill(runId)` shape) — resolves
   * `runId` against the active-runs map and delegates to `interrupt(handle)`.
   * Idempotency and the unknown-id no-op are inherited from `interrupt`:
   * a stale or unknown `runId` returns silently, and a second call after
   * the run has been killed is a no-op via the `run.killed` guard.
   */
  async interruptById(runId: string): Promise<void> {
    const run = this.active.get(runId);
    if (!run) return;
    await this.interrupt(run.handle);
  }

  /** Absolute path of the sidecar this runner would write for `agentId`. */
  killedSidecarPath(agentId: string): string {
    return path.join(this.sidecarDir, `${agentId}.killed`);
  }

  // -------------------------------------------------------------------------
  // spawn helpers
  // -------------------------------------------------------------------------

  private buildSpawnArgs(
    env: NodeJS.ProcessEnv,
    spec: AgentSpec,
  ): { cmd: string; args: string[]; model: string; effort: string } {
    const cmd = env.CLAUDE_CMD || 'claude';
    const model = this.resolveModel(env, spec);
    const effort = this.resolveEffort(env, spec);
    const args = [
      '--print',
      '--output-format',
      'stream-json',
      // Stream text deltas as they generate. Without this the CLI only
      // prints an assistant frame when the WHOLE message is complete —
      // an architect's multi-minute final design doc rendered as dead
      // silence ("looks finished, still shows Stop agent") and then
      // appeared all at once. StreamParser surfaces the deltas as live
      // progress chunks and suppresses the duplicate text when the
      // complete envelope follows.
      '--include-partial-messages',
      '--verbose',
      '--dangerously-skip-permissions',
      '--model',
      model,
      '--effort',
      effort,
    ];
    return { cmd, args, model, effort };
  }

  /**
   * Resolution order for the `--model` argument:
   *
   *   1. `spec.metadata.model`            — explicit per-call override
   *                                         threaded from `FlowStep.model`
   *                                         by the orchestrator. Wins over
   *                                         any constructor or env default.
   *   2. `defaultModels[role]`            — explicit per-role mapping from
   *                                         pipeline.yaml's `default_models`.
   *   3. `defaultModels.developer`        — every role falls back to the
   *                                         developer model when its specific
   *                                         entry is unset, so a fresh
   *                                         config that only declares
   *                                         `developer` still routes every
   *                                         agent to a real model id.
   *   4. `env.CLAUDE_MODEL_<ROLE>`        — per-role env-var override
   *                                         (e.g. `CLAUDE_MODEL_DEVELOPER`).
   *                                         Resolved at call time so a
   *                                         late-loaded `worker/.env` wins
   *                                         over cached module state.
   *   5. `env.CLAUDE_MODEL`               — legacy single-var override, kept
   *                                         so existing developer setups
   *                                         without a pipeline.yaml in scope
   *                                         continue to work.
   *   6. `'claude-sonnet-4-6'`            — hardcoded last-resort default.
   */
  private resolveModel(env: NodeJS.ProcessEnv, spec: AgentSpec): string {
    const explicit = readMetadataString(spec, 'model');
    // `model: none` is the YAML sentinel for non-LLM lifecycle / parking
    // steps (commit-approval, deploy-ready, …). Those step kinds never
    // reach a spawn, but a flow that accidentally tags an agent step
    // with `model: none` would otherwise hand the literal string to
    // claude CLI, which rejects it with "There's an issue with the
    // selected model (none)". Treat it as "no explicit model" and fall
    // through to the role / env defaults instead of crashing.
    if (explicit && explicit !== 'none') return explicit;
    // Agent record (management UI) — the live per-role model, above the
    // pipeline.yaml defaults but below an explicit flow step.model.
    const fromAgent = this.resolveDefaultModel?.(spec.role);
    if (fromAgent && fromAgent !== 'none') return fromAgent;
    const fromRole = this.defaultModels[spec.role];
    if (fromRole) return fromRole;
    const fromDeveloper = this.defaultModels.developer;
    if (fromDeveloper) return fromDeveloper;
    const roleKey = `CLAUDE_MODEL_${spec.role.toUpperCase()}`;
    return env[roleKey] || env.CLAUDE_MODEL || 'claude-sonnet-4-6';
  }

  /**
   * Resolution order for the `--effort` argument. Mirrors the model
   * resolution shape — explicit per-call override wins, then per-role env,
   * then the legacy single-var, then the hardcoded `'medium'` default.
   *
   *   1. `spec.metadata.effort`           — explicit per-call override.
   *   2. `env.CLAUDE_EFFORT_<ROLE>`       — per-role env-var override.
   *   3. `env.CLAUDE_EFFORT`              — single-var fallback.
   *   4. `env.CLAUDE_EFFORT_DEFAULT`      — legacy alias kept for back-compat
   *                                         with the documented `.env.example`.
   *   5. `'medium'`                       — hardcoded default.
   */
  private resolveEffort(env: NodeJS.ProcessEnv, spec: AgentSpec): string {
    const explicit = readMetadataString(spec, 'effort');
    if (explicit) return explicit;
    const roleKey = `CLAUDE_EFFORT_${spec.role.toUpperCase()}`;
    return (
      env[roleKey] ||
      env.CLAUDE_EFFORT ||
      env.CLAUDE_EFFORT_DEFAULT ||
      'medium'
    );
  }

  private writePromptToStdin(proc: ChildProc, prompt: string, id: string): void {
    // The CLI runs in -p mode with the prompt over stdin (argv is capped at
    // ~8 KB by cmd.exe). If the prompt never arrives the child waits 3s,
    // prints "no stdin data received", and dies with "Input must be
    // provided..." — an opaque failure the operator can't map back to a
    // cause (field incident: an architect re-run, the fattest prompt in
    // the system). Every branch here therefore logs loudly with the
    // prompt size, and on any write problem the child is killed at once
    // so the failure is immediate and attributable instead of a 3s stall.
    if (!proc.stdin) {
      this.logger?.error(
        'claude-cli: child has no stdin pipe — prompt cannot be delivered, killing spawn',
        { agentId: id, promptChars: prompt.length },
      );
      if (typeof proc.pid === 'number') void this.killer(proc.pid);
      return;
    }
    if (prompt.length === 0) {
      this.logger?.error(
        'claude-cli: EMPTY prompt for spawn — refusing to start a promptless run',
        { agentId: id },
      );
      if (typeof proc.pid === 'number') void this.killer(proc.pid);
      return;
    }
    // Async write errors (EPIPE when the child dies instantly — e.g. a bad
    // CLAUDE_CMD) surface on the stream, not the .end() call. Without this
    // handler they are an uncaught exception that kills the WORKER.
    proc.stdin.on('error', (err: Error) => {
      this.logger?.warn('claude-cli: stdin stream error (child likely exited early)', {
        agentId: id,
        promptChars: prompt.length,
        error: err.message,
      });
    });
    try {
      proc.stdin.end(prompt);
      this.logger?.debug?.('claude-cli: prompt written to stdin', {
        agentId: id,
        promptChars: prompt.length,
      });
    } catch (err) {
      this.logger?.error('claude-cli: stdin write failed — killing spawn', {
        agentId: id,
        promptChars: prompt.length,
        error: err instanceof Error ? err.message : String(err),
      });
      try {
        proc.stdin.destroy();
      } catch { /* already gone */ }
      if (typeof proc.pid === 'number') void this.killer(proc.pid);
    }
  }

  // -------------------------------------------------------------------------
  // stream attachment helpers
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
      // Also publish per-line so the Show-agent stream surfaces
      // stderr as it arrives. `stderrLineBuf` holds the trailing
      // partial line so multi-chunk lines collapse to one publish.
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
   * Metadata for a per-CHUNK event: the routing keys, without the
   * per-RUN prose.
   *
   * On the field worker `AgentProgress` was 86% of the whole event
   * log's payload bytes — 585.8 MB over 120011 rows, 5.0 KB each — for
   * chunks that are text DELTAS of tens of bytes. The rest was the spec
   * metadata republished on every delta, dominated by the agent-memory
   * block and the previous step's reject feedback. See
   * `core/agents/stream-metadata.ts` for why the filter is a size cap.
   *
   * Cached on the context: the input is fixed for the life of the run.
   */
  private streamMetaTail(
    ctx: RunContext,
  ): { readonly metadata?: Readonly<Record<string, unknown>> } {
    const cached = ctx.streamMetaTail;
    if (cached !== undefined) return cached;
    const slimmed = slimStreamMetadata(ctx.metadata);
    if (slimmed.dropped.length > 0) {
      // Key NAMES only — the values are an agent-memory block and
      // operator feedback. Once per run, not once per chunk.
      this.logger?.debug(
        'claude-cli: oversized metadata kept off the per-chunk events',
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
        `claude-cli:AgentActivity:${ctx.id}:${++ctx.activitySeq}`,
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
      // Drain any trailing stderr fragment that didn't end with a
      // newline before the close event arrived — otherwise the last
      // line of a panic/abort message goes missing from the stream.
      if (ctx.stderrLineBuf.length > 0) {
        const tail = ctx.stderrLineBuf.trimEnd();
        ctx.stderrLineBuf = '';
        if (tail.length > 0) this.enqueueStderrLine(ctx, tail);
      }
      ctx.publishQueue = ctx.publishQueue.then(() => this.publishClose(ctx, code, signal));
    });
  }

  // -------------------------------------------------------------------------
  // publish helpers (everything below this line touches `this.bus`)
  // -------------------------------------------------------------------------

  private enqueueParsed(ctx: RunContext, events: ParsedStreamEvent[]): void {
    for (const ev of events) {
      ctx.publishQueue = ctx.publishQueue.then(() => this.publishParsed(ctx, ev));
    }
  }

  private publishParsed(
    ctx: RunContext,
    ev: ParsedStreamEvent,
  ): Promise<unknown> | undefined {
    // Two tails on purpose. The progress / question / activity branches
    // below fire thousands of times per run and take the slimmed one;
    // the terminal `AgentFinished` at the bottom fires ONCE and keeps
    // the full metadata, because that is where subscribers legitimately
    // read the richer fields.
    const streamTail = this.streamMetaTail(ctx);
    const metaTail = ctx.metadata !== undefined ? { metadata: ctx.metadata } : {};
    if (ev.kind === 'progress') {
      // AP-VP4-010: capture the assistant text so AgentFinished can carry
      // the rendered body. Concatenation is cheap relative to the publish
      // queue and a multi-megabyte planner draft is still well under the
      // bus's worst-case payload size.
      ctx.bodyBuf += ev.chunk;
      return this.publish(
        'AgentProgress',
        `claude-cli:AgentProgress:${ctx.id}:${++ctx.progressSeq}`,
        { agentId: ctx.id, role: ev.role, chunk: ev.chunk, ...streamTail },
      );
    }
    if (ev.kind === 'question') {
      return this.publish(
        'AgentQuestion',
        `claude-cli:AgentQuestion:${ctx.id}:${++ctx.questionSeq}`,
        { agentId: ctx.id, question: ev.question, ...streamTail },
      );
    }
    if (ev.kind === 'activity') {
      // Tool frames + session init + thinking blocks + user echoes.
      // Surfaced as AgentActivity so the Show-agent stream conveys
      // what claude was doing between assistant messages. `extra`
      // carries the additional context that doesn't fit on the
      // detail line — tool input args, full thinking text — which
      // the renderer can collapse into an expandable block.
      return this.publish(
        'AgentActivity',
        `claude-cli:AgentActivity:${ctx.id}:${++ctx.activitySeq}`,
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
    // The CLI has reported its terminal `result` frame, so the flow can
    // advance now rather than waiting on process teardown. But the child
    // is still alive at this point, and nothing used to make sure it ever
    // died: `publishClose` only runs if the process exits on its own.
    //
    // Field case: a task ran to completion — reviewer verdict consumed,
    // tester, committer, merge, done — while the reviewer's `claude`
    // process was still up. The pipeline had moved on; the process had
    // not. A CLI that never exits (MCP server teardown wedged, a tool
    // still open) leaks for the lifetime of the worker, holding its
    // worktree and its share of the machine.
    this.armReap(ctx);
    return this.publish('AgentFinished', `claude-cli:AgentFinished:${ctx.id}`, {
      agentId: ctx.id,
      role: ctx.role,
      outcome: ev.outcome,
      content: ctx.bodyBuf,
      // The terminal frame's own error text on a non-success outcome.
      // Without it a subscriber has only the subtype, and
      // `error_during_execution` does not tell an operator that the API
      // refused the prompt.
      ...(ev.detail !== undefined ? { error: ev.detail } : {}),
      ...metaTail,
    });
  }

  /**
   * Give the CLI a grace period to exit after its terminal frame, then
   * kill the process tree.
   *
   * Not an interrupt: `run.killed` stays false, so if the close lands
   * first it is still classified on its exit code, and a reaped run is
   * never reported to the operator as "stopped". The AgentFinished event
   * has already gone out either way — `finished` is set before this — so
   * reaping changes no outcome, it only stops the leak.
   */
  private armReap(ctx: RunContext): void {
    const run = ctx.run;
    if (run.reapTimer !== undefined) return;
    run.reapTimer = setTimeout(() => {
      run.reapTimer = undefined;
      // Close already ran — nothing to reap.
      if (!this.active.has(ctx.id)) return;
      const pid = run.proc.pid;
      this.logger?.warn(
        'claude-cli: agent reported success but its process is still alive — killing',
        { agentId: ctx.id, role: ctx.role, pid: pid ?? null, graceMs: this.reapGraceMs },
      );
      if (pid === undefined) return;
      try {
        void this.killer(pid);
      } catch (err) {
        this.logger?.warn('claude-cli: reap kill failed', {
          agentId: ctx.id,
          pid,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }, this.reapGraceMs);
    // Never hold the process open on this timer alone.
    (run.reapTimer as unknown as { unref?: () => void }).unref?.();
  }

  private publishSpawnError(ctx: RunContext, err: Error): Promise<unknown> | undefined {
    if (ctx.run.finished) return undefined;
    ctx.run.finished = true;
    const metaTail = ctx.metadata !== undefined ? { metadata: ctx.metadata } : {};
    return this.publish('AgentFailed', `claude-cli:AgentFailed:${ctx.id}`, {
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
    if (ctx.run.reapTimer !== undefined) {
      clearTimeout(ctx.run.reapTimer);
      ctx.run.reapTimer = undefined;
    }
    if (ctx.run.finished) return undefined;
    ctx.run.finished = true;
    const metaTail = ctx.metadata !== undefined ? { metadata: ctx.metadata } : {};
    if (ctx.run.killed) {
      return this.publish('AgentFinished', `claude-cli:AgentFinished:${ctx.id}`, {
        agentId: ctx.id,
        role: ctx.role,
        outcome: 'interrupted',
        content: ctx.bodyBuf,
        ...metaTail,
      });
    }
    if (code === 0) {
      return this.publish('AgentFinished', `claude-cli:AgentFinished:${ctx.id}`, {
        agentId: ctx.id,
        role: ctx.role,
        outcome: 'success',
        content: ctx.bodyBuf,
        ...metaTail,
      });
    }
    return this.publish('AgentFailed', `claude-cli:AgentFailed:${ctx.id}`, {
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
