/**
 * Adapter: child_process.spawn-backed implementation of the
 * {@link ScriptRunner} port.
 *
 * Each `run` allocates a per-run directory beneath the configured
 * workspace root (default: `<cwd>/.pipeline-workspace/v2/scripts/`)
 * and pipes the spawned process's stdout / stderr into
 * `stdout.log` and `stderr.log` inside that directory. The paths are
 * returned in the result so the orchestrator (or a board SSE tailer)
 * can read or stream them after the run finishes.
 *
 * The adapter is intentionally IO-only:
 *   - it does NOT emit ScriptFinished or any other event;
 *   - it does NOT mutate task state;
 *   - it does NOT register the run anywhere global.
 *
 * Emitting ScriptFinished is the orchestrator's job — it owns the
 * event-bus binding and gets to decide how the run result projects
 * into the flow engine. Keeping the adapter pure lets unit tests
 * drive it without a bus and lets future callers (e.g. an ad-hoc
 * script CLI) reuse it without dragging in the engine.
 *
 * Platform handling:
 *   - `.ps1` fixtures are spawned via PowerShell with `-NoProfile
 *     -ExecutionPolicy Bypass -File <script>` so the operator does
 *     not have to flip the machine-wide execution policy. The host is
 *     `powershell.exe` on Windows and `pwsh` (PowerShell 7+, the only
 *     edition that exists there) elsewhere — the workspace repos this
 *     drives ship `Deploy/*.ps1` and `nuget_package_publish.ps1`, so a
 *     non-Windows worker still has to run them.
 *   - `.cmd` / `.bat` fixtures are spawned through `cmd.exe /d /c`
 *     because cmd does not honour a bare `spawn(scriptPath)` on
 *     Windows the way it does on POSIX. Off Windows they are refused
 *     outright rather than handed to `spawn` — a batch file is not
 *     executable there, and the resulting ENOENT/EACCES says nothing
 *     about the real cause.
 *   - Anything else is handed directly to `spawn` and the OS decides
 *     (e.g. a `.sh` with a shebang on POSIX, or a native binary).
 */

import * as child_process from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { ScriptRunner, ScriptRunResult } from '../../core/ports/ScriptRunner';

/**
 * Subset of `child_process.spawn` the adapter depends on. Tests inject
 * a stub here instead of patching the module-level binding.
 */
export type SpawnImpl = typeof child_process.spawn;

export interface ChildProcessScriptRunnerOptions {
  /**
   * Root directory under which per-run output directories are
   * created. Each run gets its own subdirectory named after `runId`.
   * Defaults to `<process.cwd()>/.pipeline-workspace/v2/scripts`,
   * matching the layout documented in the project context.
   */
  readonly workspaceRoot?: string;
  /**
   * Source of run IDs. Each call to `run` invokes this exactly once
   * to obtain the subdirectory name. Defaults to a monotonically
   * increasing timestamped id (`run-<epochMs>-<counter>`) so the
   * adapter is usable with no DI in production while still being
   * trivially deterministic in tests.
   */
  readonly newRunId?: () => string;
  /** Injectable `spawn`. Defaults to `child_process.spawn`. */
  readonly spawnImpl?: SpawnImpl;
}

/** Result of {@link resolveSpawn} — what to actually hand to `spawn`. */
interface ResolvedSpawn {
  readonly command: string;
  readonly args: readonly string[];
}

/**
 * Resolve the executable + argv `spawn` should be invoked with for a
 * given `scriptPath`. The mapping mirrors what the orchestrator's
 * `claude-runner.ts` does for `.ps1` scripts on Windows.
 *
 * `platform` is a parameter so the table can be tested on either OS
 * without patching `process.platform`.
 *
 * Throws for a script the platform cannot run at all. The alternative —
 * falling through to `spawn('deploy.ps1')` — surfaces as a bare ENOENT
 * or EACCES that reads like a missing file, sending whoever debugs it
 * looking for the wrong problem.
 */
export function resolveSpawn(
  scriptPath: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
): ResolvedSpawn {
  const ext = path.extname(scriptPath).toLowerCase();
  const onWindows = platform === 'win32';
  if (ext === '.ps1') {
    return {
      // Windows PowerShell 5.1 ships in the box as `powershell.exe`;
      // every other platform only has PowerShell 7+, whose executable
      // is `pwsh`. Same flags either way.
      command: onWindows ? 'powershell.exe' : 'pwsh',
      args: [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        scriptPath,
        ...args,
      ],
    };
  }
  if (ext === '.cmd' || ext === '.bat') {
    if (!onWindows) {
      throw new Error(
        `Cannot run ${path.basename(scriptPath)} on ${platform}: `
        + '.cmd/.bat scripts require Windows.',
      );
    }
    return { command: 'cmd.exe', args: ['/d', '/s', '/c', scriptPath, ...args] };
  }
  return { command: scriptPath, args: args.slice() };
}

export class ChildProcessScriptRunner implements ScriptRunner {
  private readonly workspaceRoot: string;
  private readonly newRunId: () => string;
  private readonly spawnImpl: SpawnImpl;
  private counter = 0;

  constructor(options: ChildProcessScriptRunnerOptions = {}) {
    this.workspaceRoot =
      options.workspaceRoot ??
      path.join(process.cwd(), '.pipeline-workspace', 'v2', 'scripts');
    this.newRunId =
      options.newRunId ?? ((): string => `run-${Date.now()}-${++this.counter}`);
    this.spawnImpl = options.spawnImpl ?? child_process.spawn;
  }

  async run(
    scriptPath: string,
    args: readonly string[],
    cwd: string,
    env: Readonly<Record<string, string>>,
  ): Promise<ScriptRunResult> {
    const runId = this.newRunId();
    const runDir = path.join(this.workspaceRoot, runId);
    fs.mkdirSync(runDir, { recursive: true });

    const stdoutPath = path.join(runDir, 'stdout.log');
    const stderrPath = path.join(runDir, 'stderr.log');

    // Resolve BEFORE opening the log streams: an unrunnable script type
    // (a .cmd off Windows) throws here, and there is no point leaving two
    // open file descriptors behind for a child that never spawns. The
    // rejection matches the spawn-error path — no exit code was produced.
    const { command, args: spawnArgs } = resolveSpawn(scriptPath, args);

    const stdoutFile = fs.createWriteStream(stdoutPath);
    const stderrFile = fs.createWriteStream(stderrPath);

    return new Promise<ScriptRunResult>((resolve, reject) => {
      let settled = false;

      // Counts what we still need to see before resolving on a clean
      // exit: the `close` event from the child, plus the `close` event
      // from each output file stream (the latter fires once the
      // underlying fd has been flushed and closed by `pipe`'s auto-end).
      let pendingCloses = 3;
      let exitCode = -1;

      const tryResolve = (): void => {
        if (settled || pendingCloses > 0) return;
        settled = true;
        resolve({ exitCode, stdoutPath, stderrPath });
      };

      const failFast = (err: Error): void => {
        if (settled) return;
        settled = true;
        // Stop piping; let the OS reap the file descriptors. We do not
        // wait for the file streams to flush in the error path because
        // there is no exitCode to pair them with.
        stdoutFile.destroy();
        stderrFile.destroy();
        reject(err);
      };

      stdoutFile.once('close', () => {
        pendingCloses -= 1;
        tryResolve();
      });
      stderrFile.once('close', () => {
        pendingCloses -= 1;
        tryResolve();
      });

      const child = this.spawnImpl(command, spawnArgs.slice(), {
        cwd,
        env: { ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });

      child.stdout?.pipe(stdoutFile);
      child.stderr?.pipe(stderrFile);

      child.on('error', (err: Error) => {
        // Spawn itself failed (binary missing, permission denied, ...).
        // The promise rejects — the run never produced an exit code,
        // so there is nothing meaningful to return.
        failFast(err);
      });

      child.on('close', (code: number | null) => {
        // Node delivers `code: null` when the process was killed by a
        // signal with no numeric exit. The port contract is `number`,
        // so we collapse that to -1.
        exitCode = typeof code === 'number' ? code : -1;
        pendingCloses -= 1;
        tryResolve();
      });
    });
  }
}
