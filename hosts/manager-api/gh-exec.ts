/**
 * Run `gh` as a specific GitHub account, for the manager UI's Test
 * button.
 *
 * The account's identity comes from `GH_CONFIG_DIR` in the CHILD's
 * environment — the same mechanism the orchestrator will use when it
 * spawns `gh` for a task. Testing through the same door the real thing
 * uses is the point: a Test that authenticated some other way could pass
 * while the pipeline still failed.
 *
 * Deliberately NOT `gh auth switch`: that mutates global state, and the
 * pipeline runs tasks concurrently, so two tasks on different accounts
 * would race and whichever switched last would win for both. A per-child
 * environment cannot race — and neither can this check interfere with a
 * task running at the same moment.
 */
import * as child_process from 'child_process';

/** Seconds before a hung `gh` is abandoned. */
const TIMEOUT_MS = 10_000;

export interface GhRunResult {
    readonly stdout: string;
    readonly stderr: string;
    readonly code: number;
}

/**
 * Execute `gh <args>` with `env` overlaid on the parent environment.
 *
 * Resolves rather than rejects on a non-zero exit, because for this
 * caller a failure IS the answer — "not logged in" is what the operator
 * asked to find out. Only a spawn that never produced a result throws.
 *
 * The overlay is applied over `process.env` rather than replacing it:
 * `gh` still needs PATH, and on Windows SystemRoot and friends.
 */
export function runGhForAccount(
    args: readonly string[],
    env: Readonly<Record<string, string>>,
): Promise<GhRunResult> {
    const bin = process.env.GH_PATH && process.env.GH_PATH.length > 0
        ? process.env.GH_PATH
        : 'gh';
    return new Promise((resolve, reject) => {
        child_process.execFile(
            bin,
            [...args],
            {
                env: { ...process.env, ...env },
                timeout: TIMEOUT_MS,
                windowsHide: true,
                encoding: 'utf8',
            },
            (err, stdout, stderr) => {
                const out = typeof stdout === 'string' ? stdout : '';
                const errOut = typeof stderr === 'string' ? stderr : '';
                if (err) {
                    const code = typeof (err as { code?: unknown }).code === 'number'
                        ? (err as { code: number }).code
                        : 1;
                    // ENOENT means `gh` is not installed or not on the
                    // manager-api's PATH — a different problem from "not
                    // logged in", and one the operator must be told
                    // plainly rather than shown as an auth failure.
                    if ((err as { code?: unknown }).code === 'ENOENT') {
                        reject(new Error(
                            `\`${bin}\` not found on PATH — install the GitHub CLI, `
                            + 'or set GH_PATH to its full path.',
                        ));
                        return;
                    }
                    resolve({ stdout: out, stderr: errOut, code });
                    return;
                }
                resolve({ stdout: out, stderr: errOut, code: 0 });
            },
        );
    });
}
