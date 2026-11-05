/**
 * Port: run a script (shell, batch, PowerShell, python, ...) once and
 * capture its stdio to files on disk.
 *
 * The port is deliberately minimal — a single `run` verb. Everything else
 * (event emission, retry policy, scheduling, projection of the run into
 * a board card) is the orchestrator's job. Keeping the adapter IO-only
 * means the same `ScriptRunner` can be reused by any caller that wants
 * "run a script and tell me the exit code + where the output went".
 *
 * stdout and stderr are NOT returned in-memory. The adapter writes them
 * to two separate files under a per-run directory it owns; this matches
 * v1's convention of letting the board tail the files via SSE and avoids
 * buffering megabytes of script output in the orchestrator's heap.
 */

export interface ScriptRunResult {
  /**
   * The process's exit code as reported by the OS. `-1` is used to
   * signal "terminated by signal with no numeric code" (Node's
   * `close` event delivers `code: null` in that case). Adapters MUST
   * never return `null` here — callers should be able to compare
   * `exitCode === 0` without a typeof check.
   */
  readonly exitCode: number;
  /** Absolute path of the file containing the run's stdout bytes. */
  readonly stdoutPath: string;
  /** Absolute path of the file containing the run's stderr bytes. */
  readonly stderrPath: string;
}

export interface ScriptRunner {
  /**
   * Run `scriptPath` with `args` in `cwd`, threading `env` to the
   * spawned process. Resolves once the process has exited and stdout +
   * stderr have been fully flushed to disk.
   *
   * The promise rejects only when the script could not be started at
   * all (e.g. spawn `ENOENT`). A script that runs to completion with a
   * non-zero exit code resolves normally — the exit code is part of
   * the result, not an error condition.
   */
  run(
    scriptPath: string,
    args: readonly string[],
    cwd: string,
    env: Readonly<Record<string, string>>,
  ): Promise<ScriptRunResult>;
}
