/**
 * Adapter: per-task git worktree manager.
 *
 * Wraps `git worktree add` / `git worktree remove --force` and tracks
 * ownership by `taskId`. Worktrees live at `<worktreeRoot>/<taskId>` so
 * the directory name is the join key against the task store — gcStale
 * walks the worktree root and prunes directories whose owning task is
 * terminal AND whose mtime is older than the idle threshold (24h by
 * default). A worktree whose task is still active is never pruned.
 *
 * Designed to be wired into the orchestrator's lifecycle:
 *
 *   TaskStarted (TaskApproved)   -> create(taskId, branch)
 *   TaskCompleted (TaskFinished) -> remove(taskId)
 *   daily tick                   -> gcStale()
 *
 * `remove()` swallows + logs underlying errors so a missing or already-
 * removed directory never propagates an exception back up the lifecycle.
 */
import { execFile, type ExecFileException } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import type { EventBus } from '../../core/events/bus';
import type { Logger } from '../../core/ports/Logger';

export interface ExecResult {
    readonly stdout: string;
    readonly stderr: string;
}

export type ExecRunner = (
    command: string,
    args: readonly string[],
    options: { readonly cwd: string },
) => Promise<ExecResult>;

/**
 * Read-side view of the task store the manager consults during gcStale.
 *
 * `isTerminal` must return `true` only when the task is known to be in a
 * terminal state (e.g. done, dismissed, failed-final). Unknown taskIds
 * must return `false` so an unrecognised directory is never pruned by
 * accident — operators recover from a corrupt or partially-migrated
 * store rather than losing a worktree the system did not own.
 */
export interface TaskStateLookup {
    isTerminal(taskId: string): boolean;
}

export interface FsStat {
    readonly mtimeMs: number;
    isDirectory(): boolean;
}

/**
 * Resolves a `repoId` to the absolute filesystem path of its working tree.
 * Wired in production from `RepoFetcher.resolvePath(projectId, repoId)`; the
 * manager itself stays decoupled from the registry so unit tests can inject
 * a literal-map lookup.
 */
export type RepoResolver = (repoId: string) => string;

export interface WorktreeManagerOptions {
    /**
     * Default git checkout — the cwd for `git worktree` invocations when
     * `create()` / `remove()` is called without an explicit `repoId`. Kept
     * as the single-repo fast path; multi-repo callers pass `repoId` and let
     * the resolver pick.
     */
    readonly repoRoot?: string;
    /**
     * Multi-repo lookup: given a `repoId` from the registry, return the
     * absolute path of its working tree. Required when `create()` /
     * `remove()` are invoked with an explicit `repoId`; optional otherwise.
     * The host wires this from `RepoFetcher.resolvePath`.
     */
    readonly repoResolver?: RepoResolver;
    /**
     * Root directory under which per-task worktrees live. Matches the
     * `worktree_root:` key in `config/pipeline.yaml` (default
     * `.pipeline-workspace/v2`).
     */
    readonly worktreeRoot: string;
    readonly taskStore: TaskStateLookup;
    readonly logger: Logger;
    /** Injectable command runner. Defaults to a child_process.execFile wrapper. */
    readonly exec?: ExecRunner;
    /** Git binary. Defaults to `'git'`. */
    readonly gitBin?: string;
    /** Idle threshold in ms; default 24h. */
    readonly idleMs?: number;
    /** Clock override for tests. Defaults to `Date.now`. */
    readonly now?: () => number;
    /** Directory listing — defaults to `fs.readdirSync`. */
    readonly readdir?: (dir: string) => readonly string[];
    /** Stat function — defaults to `fs.statSync`. */
    readonly stat?: (p: string) => FsStat;
    /** Existence check — defaults to `fs.existsSync`. */
    readonly exists?: (p: string) => boolean;
    /** Recursive mkdir — defaults to `fs.mkdirSync(p, { recursive: true })`. */
    readonly mkdirp?: (p: string) => void;
    /** File writer — defaults to `fs.writeFileSync(p, contents)`. */
    readonly writeFile?: (p: string, contents: string) => void;
}

/**
 * Per-task agent SSE stream the board tails. `create()` touches an empty
 * one at the worktree root immediately after `git worktree add` so the SSE
 * tail does not race the runner — without this, the runner creates the
 * file lazily on its first stdout line and any lines emitted before the
 * board consumer opens the tail are missed.
 */
export const AGENT_STREAM_FILENAME = '.agent-stream.jsonl';

const DEFAULT_IDLE_MS = 24 * 60 * 60 * 1000;
const MAX_BUFFER = 64 * 1024 * 1024;

function defaultExec(): ExecRunner {
    return (command, args, options) =>
        new Promise<ExecResult>((resolve, reject) => {
            execFile(
                command,
                args.slice(),
                { cwd: options.cwd, encoding: 'utf8', maxBuffer: MAX_BUFFER },
                (err, stdout, stderr) => {
                    const out = typeof stdout === 'string' ? stdout : String(stdout ?? '');
                    const errOut = typeof stderr === 'string' ? stderr : String(stderr ?? '');
                    if (err) {
                        const code = (err as ExecFileException).code;
                        const exit = typeof code === 'number' ? code : Number(code) || 1;
                        const detail = (errOut.trim() || out.trim() || '').slice(0, 400);
                        reject(
                            new Error(
                                `worktree-manager: \`${command} ${args.join(' ')}\` exit ${exit}${
                                    detail ? `: ${detail}` : ''
                                }`,
                            ),
                        );
                        return;
                    }
                    resolve({ stdout: out, stderr: errOut });
                },
            );
        });
}

export class WorktreeManager {
    private readonly repoRoot?: string;
    private readonly repoResolver?: RepoResolver;
    private readonly worktreeRoot: string;
    private readonly taskStore: TaskStateLookup;
    private readonly logger: Logger;
    private readonly exec: ExecRunner;
    private readonly gitBin: string;
    private readonly idleMs: number;
    private readonly nowFn: () => number;
    private readonly readdir: (dir: string) => readonly string[];
    private readonly stat: (p: string) => FsStat;
    private readonly exists: (p: string) => boolean;
    private readonly mkdirp: (p: string) => void;
    private readonly writeFile: (p: string, contents: string) => void;

    /**
     * In-memory taskId -> ownership record. The repo cwd is captured at
     * `create()` time so `remove()` runs against the same checkout the
     * worktree was added in — without it, a multi-repo host that resolved a
     * different repo since create would target the wrong git directory.
     */
    private readonly owners = new Map<string, { readonly target: string; readonly repoCwd: string }>();

    constructor(options: WorktreeManagerOptions) {
        if (options.repoRoot === undefined && options.repoResolver === undefined) {
            throw new Error(
                'WorktreeManager: either `repoRoot` or `repoResolver` must be supplied',
            );
        }
        this.repoRoot = options.repoRoot;
        this.repoResolver = options.repoResolver;
        this.worktreeRoot = options.worktreeRoot;
        this.taskStore = options.taskStore;
        this.logger = options.logger;
        this.exec = options.exec ?? defaultExec();
        this.gitBin = options.gitBin ?? 'git';
        this.idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
        this.nowFn = options.now ?? ((): number => Date.now());
        this.readdir = options.readdir ?? ((dir): readonly string[] => fs.readdirSync(dir));
        this.stat = options.stat ?? ((p): FsStat => fs.statSync(p));
        this.exists = options.exists ?? ((p): boolean => fs.existsSync(p));
        this.mkdirp =
            options.mkdirp ??
            ((p): void => {
                fs.mkdirSync(p, { recursive: true });
            });
        this.writeFile =
            options.writeFile ??
            ((p, contents): void => {
                fs.writeFileSync(p, contents);
            });
    }

    /** Filesystem path this manager would use for `taskId`. */
    worktreePathFor(taskId: string): string {
        return path.join(this.worktreeRoot, taskId);
    }

    /** Current recorded path for `taskId`, or `undefined` if not tracked. */
    pathFor(taskId: string): string | undefined {
        return this.owners.get(taskId)?.target;
    }

    /**
     * Resolve the repo cwd `git worktree` should run in for a given `repoId`.
     * When `repoId` is omitted the manager falls back to its default
     * `repoRoot`. Throws when neither is available — that's an operator
     * misconfiguration (e.g. multi-repo wiring missing on a multi-repo task).
     */
    private resolveRepoCwd(repoId: string | undefined): string {
        if (repoId !== undefined) {
            if (!this.repoResolver) {
                throw new Error(
                    `WorktreeManager: repoId "${repoId}" supplied but no repoResolver was configured`,
                );
            }
            return this.repoResolver(repoId);
        }
        if (this.repoRoot === undefined) {
            throw new Error(
                'WorktreeManager: no repoId supplied and no default repoRoot configured',
            );
        }
        return this.repoRoot;
    }

    /**
     * `git worktree add <worktreeRoot>/<taskId> <branch>` in the repo named
     * by `repoId` (or the default `repoRoot` when omitted).
     *
     * Idempotent: if the target directory already exists (replay after
     * restart, duplicate TaskStarted, or a manual recovery) the existing
     * directory is adopted instead of re-running `git worktree add`,
     * which would otherwise fail with "already exists".
     */
    async create(taskId: string, branch: string, repoId?: string): Promise<string> {
        const target = this.worktreePathFor(taskId);
        const repoCwd = this.resolveRepoCwd(repoId);
        this.mkdirp(this.worktreeRoot);
        if (this.exists(target)) {
            this.owners.set(taskId, { target, repoCwd });
            this.logger.info('worktree-manager: adopting existing worktree', {
                taskId,
                path: target,
                branch,
                repoId,
            });
            this.ensureStreamFile(target);
            return target;
        }
        await this.exec(
            this.gitBin,
            ['worktree', 'add', target, branch],
            { cwd: repoCwd },
        );
        this.owners.set(taskId, { target, repoCwd });
        this.logger.info('worktree-manager: created worktree', {
            taskId,
            path: target,
            branch,
            repoId,
        });
        this.ensureStreamFile(target);
        return target;
    }

    /**
     * Touch an empty `.agent-stream.jsonl` at the worktree root so the
     * board's SSE tail attaches to a real file before the agent runner
     * starts producing lines. Idempotent on a populated file: if the
     * stream already exists (e.g. crash-recovery adopting a worktree from
     * a previous run) we leave its contents alone so nothing the runner
     * already wrote is lost.
     */
    private ensureStreamFile(worktree: string): void {
        const streamPath = path.join(worktree, AGENT_STREAM_FILENAME);
        if (this.exists(streamPath)) return;
        this.writeFile(streamPath, '');
    }

    /**
     * `git worktree remove --force <path>`. The `--force` flag drops the
     * worktree even when files are dirty (AC #2). Failures (e.g. directory
     * missing, lock conflict) are logged and not propagated (AC #7).
     *
     * The repo cwd is taken from the ownership record captured at create()
     * time. When `remove()` is called for a task the manager never saw
     * (recovery, manual cleanup) the caller may pass `repoId` directly;
     * otherwise the default `repoRoot` is used.
     */
    async remove(taskId: string, repoId?: string): Promise<void> {
        const owner = this.owners.get(taskId);
        const target = owner?.target ?? this.worktreePathFor(taskId);
        const repoCwd = owner?.repoCwd ?? this.resolveRepoCwd(repoId);
        try {
            await this.exec(
                this.gitBin,
                ['worktree', 'remove', '--force', target],
                { cwd: repoCwd },
            );
            this.logger.info('worktree-manager: removed worktree', {
                taskId,
                path: target,
            });
        } catch (err) {
            this.logger.warn('worktree-manager: remove failed', {
                taskId,
                path: target,
                error: err instanceof Error ? err.message : String(err),
            });
        } finally {
            this.owners.delete(taskId);
        }
    }

    /**
     * Walk `worktreeRoot`, treat each directory name as a candidate taskId,
     * and prune those whose owning task is terminal AND whose mtime is older
     * than `idleMs` (default 24h).
     *
     * Skips entries whose task is still active (AC #4) and entries the
     * task store does not recognise (defensive: never delete a worktree
     * the system did not provision).
     */
    async gcStale(): Promise<{ pruned: string[] }> {
        const pruned: string[] = [];
        let names: readonly string[];
        try {
            names = this.readdir(this.worktreeRoot);
        } catch (err) {
            this.logger.warn('worktree-manager: gcStale could not list root', {
                worktreeRoot: this.worktreeRoot,
                error: err instanceof Error ? err.message : String(err),
            });
            return { pruned };
        }

        const cutoff = this.nowFn() - this.idleMs;

        for (const name of names) {
            const full = path.join(this.worktreeRoot, name);
            let st: FsStat;
            try {
                st = this.stat(full);
            } catch (err) {
                this.logger.warn('worktree-manager: gcStale could not stat entry', {
                    path: full,
                    error: err instanceof Error ? err.message : String(err),
                });
                continue;
            }
            if (!st.isDirectory()) continue;
            if (!this.taskStore.isTerminal(name)) continue;
            if (st.mtimeMs > cutoff) continue;

            const owner = this.owners.get(name);
            const repoCwd = owner?.repoCwd ?? this.repoRoot;
            if (!repoCwd) {
                this.logger.warn(
                    'worktree-manager: prune skipped — no repo cwd available',
                    { taskId: name, path: full },
                );
                continue;
            }

            try {
                await this.exec(
                    this.gitBin,
                    ['worktree', 'remove', '--force', full],
                    { cwd: repoCwd },
                );
                this.owners.delete(name);
                pruned.push(full);
                this.logger.info('worktree-manager: pruned stale worktree', {
                    taskId: name,
                    path: full,
                });
            } catch (err) {
                this.logger.warn('worktree-manager: prune failed', {
                    taskId: name,
                    path: full,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        }
        return { pruned };
    }
}

// ---------------------------------------------------------------------------
// Subscriber wiring — used by the orchestrator host. Kept in this module so
// the manager and its lifecycle wiring evolve together.
// ---------------------------------------------------------------------------

export const WORKTREE_CREATE_SUBSCRIBER = 'worktree-create';
export const WORKTREE_REMOVE_SUBSCRIBER = 'worktree-remove';
export const WORKTREE_GC_SUBSCRIBER = 'worktree-gc';

/**
 * Default lifecycle event names the orchestrator uses. The brief calls
 * them `TaskStarted` / `TaskCompleted`; the v2 event vocabulary exposes
 * them as `TaskApproved` (the moment the flow engine begins driving the
 * task) and `TaskFinished` (the terminal `emit:` from the flow's final
 * step).
 */
export const DEFAULT_STARTED_EVENT = 'TaskApproved';
export const DEFAULT_COMPLETED_EVENT = 'TaskFinished';

export interface WorktreeSubscriberOptions {
    readonly bus: EventBus;
    readonly manager: WorktreeManager;
    readonly logger: Logger;
    /** Override event names. Defaults: 'TaskApproved' / 'TaskFinished'. */
    readonly startedEvent?: string;
    readonly completedEvent?: string;
    /**
     * Branch-name derivation from a taskId. Default: `wt/<taskId>`.
     * The v2 task lifecycle does not currently carry a branch on its
     * approval event, so the host picks a deterministic name from the
     * taskId. Callers that have a richer payload can substitute.
     */
    readonly branchForTask?: (taskId: string) => string;
}

/**
 * Attach `create` on `TaskStarted` and `remove` on `TaskCompleted` to the
 * supplied bus. Returns the list of named subscribers it registered so the
 * host can include them in `replayMissed` on boot.
 */
export function registerWorktreeSubscribers(
    options: WorktreeSubscriberOptions,
): readonly string[] {
    const startedEvent = options.startedEvent ?? DEFAULT_STARTED_EVENT;
    const completedEvent = options.completedEvent ?? DEFAULT_COMPLETED_EVENT;
    const branchForTask =
        options.branchForTask ?? ((taskId: string): string => `wt/${taskId}`);

    options.bus.subscribe<{ readonly taskId: string; readonly repoId?: string }>(
        startedEvent,
        async (event) => {
            const taskId = event.payload.taskId;
            try {
                await options.manager.create(
                    taskId,
                    branchForTask(taskId),
                    event.payload.repoId,
                );
            } catch (err) {
                options.logger.error('worktree-manager: create failed on TaskStarted', {
                    taskId,
                    repoId: event.payload.repoId,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        },
        { subscriber: WORKTREE_CREATE_SUBSCRIBER },
    );

    options.bus.subscribe<{ readonly taskId: string; readonly repoId?: string }>(
        completedEvent,
        async (event) => {
            // remove() already swallows + logs its own errors (AC #7);
            // wrap defensively so even a programmer error inside the
            // manager cannot stall the subscriber's offset.
            try {
                await options.manager.remove(
                    event.payload.taskId,
                    event.payload.repoId,
                );
            } catch (err) {
                options.logger.error('worktree-manager: remove threw on TaskCompleted', {
                    taskId: event.payload.taskId,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        },
        { subscriber: WORKTREE_REMOVE_SUBSCRIBER },
    );

    return [WORKTREE_CREATE_SUBSCRIBER, WORKTREE_REMOVE_SUBSCRIBER];
}

export interface WorktreeGcJobOptions {
    readonly manager: WorktreeManager;
    readonly logger: Logger;
    /** Tick period in ms. Defaults to 24h. */
    readonly tickIntervalMs?: number;
    /** Run a cycle immediately on register. Defaults to `true`. */
    readonly runOnStart?: boolean;
    /** Start the recurring timer. Defaults to `true`; tests pass `false`. */
    readonly startTimer?: boolean;
}

export interface WorktreeGcJobHandle {
    /** Run one gcStale cycle. Never throws. */
    runOnce(): Promise<{ pruned: string[] }>;
    /** Cancel the recurring timer. Idempotent. */
    stop(): void;
}

const DEFAULT_GC_TICK_MS = 24 * 60 * 60 * 1000;

/**
 * Register the daily gcStale job. Mirrors the `snapshot-job` registration
 * shape so the host wiring is consistent across daily background tasks.
 */
export function registerWorktreeGcJob(
    options: WorktreeGcJobOptions,
): WorktreeGcJobHandle {
    const tickIntervalMs = options.tickIntervalMs ?? DEFAULT_GC_TICK_MS;
    const runOnStart = options.runOnStart ?? true;
    const startTimer = options.startTimer ?? true;

    const runOnce = async (): Promise<{ pruned: string[] }> => {
        try {
            const result = await options.manager.gcStale();
            if (result.pruned.length > 0) {
                options.logger.info('worktree-manager: gc cycle complete', {
                    prunedCount: result.pruned.length,
                    pruned: result.pruned,
                });
            }
            return result;
        } catch (err) {
            options.logger.error('worktree-manager: gc cycle failed', {
                error: err instanceof Error ? err.message : String(err),
            });
            return { pruned: [] };
        }
    };

    let timer: NodeJS.Timeout | undefined;
    if (startTimer) {
        timer = setInterval(() => {
            void runOnce();
        }, tickIntervalMs);
        if (typeof timer.unref === 'function') timer.unref();
    }

    if (runOnStart) {
        void runOnce();
    }

    return {
        runOnce,
        stop(): void {
            if (timer !== undefined) {
                clearInterval(timer);
                timer = undefined;
            }
        },
    };
}
