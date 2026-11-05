/**
 * GET /api/projects/:pid/plans/:planId/tasks/:taskId/diff (AP-IFF-009).
 *
 * Returns the worktree diff for a single task as a parsed structure —
 * `{ files: [{ path, hunks: [{ header, lines: [{ kind, text }] }] }] }`
 * — rather than raw unified-diff text. The board renders the structure
 * directly; keeping the parse on the worker side means every UI client
 * (and any future MCP/CLI consumer) sees the same hunk shape.
 *
 * Source of truth: the projection store names the task's worktree
 * directory; `git diff` runs in that directory and the unified output is
 * fed to {@link parseUnifiedDiff}. Both lookups are injected through
 * dependency seams so unit tests can drive the handler with a fixture
 * diff string and a fake task store — no real git child process and no
 * SQLite needed in the test path.
 *
 * 404 contract: a task with no worktree (cancelled before scaffold,
 * pruned after merge, or unknown id) is indistinguishable at this layer
 * — the {@link ReadTaskWorktree} port returns `null` for all three and
 * the handler surfaces that as `null` for the HTTP layer to translate.
 */

/** The three line shapes a unified-diff hunk can carry. */
export type DiffLineKind = 'add' | 'del' | 'ctx';

export interface DiffLine {
    readonly kind: DiffLineKind;
    /** Line content with the leading +/-/space marker stripped. */
    readonly text: string;
}

export interface DiffHunk {
    /** The raw `@@ -a,b +c,d @@` header line, including any function context suffix. */
    readonly header: string;
    readonly lines: ReadonlyArray<DiffLine>;
}

export interface DiffFile {
    /** Post-image path (`b/<path>` side of the git header). */
    readonly path: string;
    readonly hunks: ReadonlyArray<DiffHunk>;
}

export interface TaskDiffResponse {
    readonly files: ReadonlyArray<DiffFile>;
}

/**
 * Resolve the worktree directory recorded against a task in the
 * projection store. Returns `null` when the task is unknown OR has no
 * worktree attached — both outcomes map to 404 at the HTTP boundary
 * (AC #2), so the port does not bother distinguishing them.
 */
export type ReadTaskWorktree = (
    projectId: string,
    planId: string,
    taskId: string,
) => Promise<string | null>;

/**
 * Run `git diff` inside the supplied worktree directory and return the
 * raw unified-diff text. Production wires this to a child-process
 * spawn; tests substitute a fixture string so the parser and handler
 * are exercised without forking git.
 */
export type GitDiffInvoker = (worktreePath: string) => Promise<string>;

export interface TaskDiffRouteDeps {
    readonly readTaskWorktree: ReadTaskWorktree;
    readonly gitDiff: GitDiffInvoker;
}

export interface TaskDiffParams {
    readonly pid: string;
    readonly planId: string;
    readonly taskId: string;
}

/**
 * Build the route handler. Returns `null` to signal 404 (no worktree)
 * and a {@link TaskDiffResponse} on success; thrown errors bubble up
 * so the HTTP layer can surface them as 500 the same way the
 * board-ui projection routes do.
 */
export function createTaskDiffHandler(
    deps: TaskDiffRouteDeps,
): (params: TaskDiffParams) => Promise<TaskDiffResponse | null> {
    return async (params): Promise<TaskDiffResponse | null> => {
        const worktree = await deps.readTaskWorktree(
            params.pid,
            params.planId,
            params.taskId,
        );
        if (worktree === null) return null;
        const raw = await deps.gitDiff(worktree);
        const files = parseUnifiedDiff(raw).filter(
            (f) => !PIPELINE_SCAFFOLD_PATHS.has(f.path),
        );
        return { files };
    };
}

/**
 * Parse unified-diff text into a per-file / per-hunk structure.
 *
 * Recognised boundaries:
 *   - `diff --git a/<x> b/<y>` — start of a new file; `<y>` becomes the
 *     reported path. The post-image side is used so renamed files
 *     report their new name (the board cares about the destination,
 *     not the source).
 *   - `+++ b/<path>` — fallback when the input is plain `diff -u`
 *     output without the git header (e.g. `git diff --no-prefix` is
 *     not in use here but third-party diffs may flow through).
 *   - `@@ ... @@` — start of a hunk inside the current file.
 *
 * Inside a hunk every line is classified by its leading marker:
 *   `+` → add, `-` → del, ` ` (space) → ctx. Truly empty lines and
 *   `\\ No newline at end of file` sentinels are dropped — neither
 *   carries content the renderer should display.
 *
 * The parser is intentionally permissive: malformed metadata between
 * files (e.g. an unexpected `index` line ordering) does not abort the
 * walk, it just gets skipped. The worst-case outcome on garbage input
 * is an empty files array, never a thrown exception — `git diff`
 * output evolves across versions and this surface should not break
 * the board when a new metadata line shows up.
 */
export function parseUnifiedDiff(raw: string): ReadonlyArray<DiffFile> {
    if (raw.length === 0) return [];
    const lines = raw.split('\n');
    const files: DiffFile[] = [];

    let fileBuffer: { path: string; hunks: DiffHunk[] } | null = null;
    let hunkBuffer: { header: string; lines: DiffLine[] } | null = null;

    const flushHunk = (): void => {
        if (fileBuffer !== null && hunkBuffer !== null) {
            fileBuffer.hunks.push({
                header: hunkBuffer.header,
                lines: hunkBuffer.lines,
            });
        }
        hunkBuffer = null;
    };
    const flushFile = (): void => {
        flushHunk();
        if (fileBuffer !== null) {
            files.push({ path: fileBuffer.path, hunks: fileBuffer.hunks });
        }
        fileBuffer = null;
    };

    for (const line of lines) {
        if (line.startsWith('diff --git ')) {
            flushFile();
            fileBuffer = { path: extractGitDiffPath(line), hunks: [] };
            continue;
        }
        if (line.startsWith('+++ ')) {
            // Honour `+++ b/<path>` only when no `diff --git` already
            // named the file; otherwise the git header wins.
            if (fileBuffer === null) {
                fileBuffer = { path: extractPlusPath(line), hunks: [] };
            }
            continue;
        }
        if (
            line.startsWith('--- ') ||
            line.startsWith('index ') ||
            line.startsWith('new file mode') ||
            line.startsWith('deleted file mode') ||
            line.startsWith('similarity index') ||
            line.startsWith('dissimilarity index') ||
            line.startsWith('rename ') ||
            line.startsWith('copy ') ||
            line.startsWith('old mode') ||
            line.startsWith('new mode') ||
            line.startsWith('Binary files')
        ) {
            continue;
        }
        if (line.startsWith('@@')) {
            flushHunk();
            if (fileBuffer === null) continue; // hunk without file — ignore
            hunkBuffer = { header: line, lines: [] };
            continue;
        }
        if (hunkBuffer === null) continue;
        if (line.length === 0) continue; // trailing newline from split
        if (line.startsWith('\\')) continue; // `\ No newline at end of file`
        const marker = line.charAt(0);
        if (marker === '+') {
            hunkBuffer.lines.push({ kind: 'add', text: line.slice(1) });
        } else if (marker === '-') {
            hunkBuffer.lines.push({ kind: 'del', text: line.slice(1) });
        } else if (marker === ' ') {
            hunkBuffer.lines.push({ kind: 'ctx', text: line.slice(1) });
        }
        // Any other marker inside a hunk is unrecognised — drop it
        // rather than misclassify as context.
    }
    flushFile();
    return files;
}

/**
 * Pull the post-image path out of a `diff --git a/<x> b/<y>` header.
 * Falls back to the entire suffix when the regex doesn't match — that
 * happens for paths containing spaces (git quotes them) which the
 * board can still render verbatim while we cope with more interesting
 * cases later.
 */
function extractGitDiffPath(line: string): string {
    const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (m !== null) return m[2];
    return line.slice('diff --git '.length);
}

function extractPlusPath(line: string): string {
    if (line.startsWith('+++ b/')) return line.slice('+++ b/'.length);
    return line.slice('+++ '.length);
}

// ---------------------------------------------------------------------------
// HTTP wrapper + production git invoker
// ---------------------------------------------------------------------------

import * as http from 'node:http';
import { spawn } from 'node:child_process';

import type { Db } from '../../../core/state/migrations';
import type { Logger } from '../../../core/ports/Logger';

/** `/api/projects/:pid/plans/:planId/tasks/:taskId/diff` */
export const TASK_DIFF_ROUTE_PATTERN =
    /^\/api\/projects\/([^/]+)\/plans\/([^/]+)\/tasks\/([^/]+)\/diff\/?$/;

export interface TaskDiffRouter {
    handle(req: http.IncomingMessage, res: http.ServerResponse): boolean;
}

export interface TaskDiffRouteWiringDeps {
    readonly db: Db;
    readonly logger?: Logger;
}

/**
 * Production `GitDiffInvoker`: diffs the worktree against the MERGE-BASE
 * of the base branch and HEAD — i.e. the task branch's fork point — so
 * the modal shows exactly what this task will push. Diffing against the
 * base branch's TIP (the old `git diff origin/main`) polluted the review
 * whenever a sibling task merged first: its landed changes appeared as
 * deletions in every task branched before the merge. The base ref is
 * resolved from `origin/HEAD` (falling back through origin/main /
 * origin/master) rather than hardcoding `main`, and both staged and
 * unstaged tracked changes still show. Untracked files are appended as
 * pseudo-`diff --git` additions against `/dev/null`, as before.
 */
export function createGitDiffInvoker(logger?: Logger): GitDiffInvoker {
    return async (worktreePath: string): Promise<string> => {
        // --unified=10000 ≈ full-file context. Reviewers want to see
        // every line of every changed file with `+`/`-` markers on the
        // edits and plain space prefixes on the surrounding code, so
        // the change reads in context rather than as isolated hunks.
        // 10000 lines of context exceeds every realistic file size in
        // this codebase; git silently caps at the file length.
        const diffTarget = await resolveDiffBase(worktreePath, logger);
        const tracked = await (diffTarget !== null
            ? runGit(
                ['diff', '--unified=10000', '--no-color', diffTarget],
                worktreePath,
                logger,
            )
            : Promise.reject(new Error('no base ref'))
        ).catch(async () => {
            // Fallback: no usable base ref (fresh worktree, detached
            // HEAD, etc.). Plain `git diff` surfaces unstaged
            // working-tree edits — better than nothing.
            return runGit(['diff', '--unified=10000', '--no-color'], worktreePath, logger);
        });
        const untrackedRaw = await runGit(
            ['ls-files', '--others', '--exclude-standard'],
            worktreePath,
            logger,
        ).catch(() => '');
        const untrackedBlocks: string[] = [];
        for (const path of untrackedRaw.split('\n')) {
            const p = path.trim();
            if (p.length === 0) continue;
            const block = await synthesizeAddBlock(worktreePath, p).catch(() => null);
            if (block !== null) untrackedBlocks.push(block);
        }
        return `${tracked}${untrackedBlocks.length > 0 ? '\n' + untrackedBlocks.join('\n') : ''}`;
    };
}

/**
 * Resolve the commit the review diff should compare against: the
 * merge-base of the repo's base branch and HEAD (the fork point). The
 * base branch comes from `origin/HEAD` when the clone recorded it,
 * else the first of origin/main / origin/master that exists. Returns
 * the merge-base SHA, the base ref itself when merge-base fails (e.g.
 * unrelated histories), or null when no base ref exists at all.
 */
async function resolveDiffBase(
    worktreePath: string,
    logger?: Logger,
): Promise<string | null> {
    let baseRef: string | null = null;
    const symbolic = await runGit(
        ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
        worktreePath,
        logger,
    ).catch(() => '');
    const symbolicTrimmed = symbolic.trim();
    if (symbolicTrimmed.length > 0) {
        baseRef = symbolicTrimmed;
    } else {
        for (const candidate of ['origin/main', 'origin/master']) {
            const ok = await runGit(
                ['rev-parse', '--verify', '--quiet', candidate],
                worktreePath,
                logger,
            ).catch(() => '');
            if (ok.trim().length > 0) {
                baseRef = candidate;
                break;
            }
        }
    }
    if (baseRef === null) return null;
    const mergeBase = await runGit(
        ['merge-base', baseRef, 'HEAD'],
        worktreePath,
        logger,
    ).catch(() => '');
    const sha = mergeBase.trim();
    return sha.length > 0 ? sha : baseRef;
}

/**
 * Files the orchestrator writes into the worktree as scaffolding for
 * the agent's run (TASK.md carries the task description + workspace
 * boundary block; WORKSPACE_RULES.md carries just the boundary block).
 * They are not part of the operator's intent and would clutter the
 * review modal — drop them from the diff response before rendering.
 */
const PIPELINE_SCAFFOLD_PATHS: ReadonlySet<string> = new Set([
    'TASK.md',
    'WORKSPACE_RULES.md',
]);

/** Read an untracked file off disk and synthesize a `diff --git` block
 *  shaped like the output of `git diff --no-index /dev/null <file>`,
 *  so the same parser handles untracked-file additions transparently. */
async function synthesizeAddBlock(
    worktreePath: string,
    relPath: string,
): Promise<string> {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const abs = path.join(worktreePath, relPath);
    let body: string;
    try {
        body = await fs.readFile(abs, 'utf8');
    } catch {
        return '';
    }
    const lines = body.split('\n');
    // Strip trailing blank from `split('\n')` on a file ending with '\n'.
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    const addedLines = lines.map((l) => `+${l}`).join('\n');
    const lineCount = lines.length;
    return (
        `diff --git a/${relPath} b/${relPath}\n` +
        `new file mode 100644\n` +
        `--- /dev/null\n` +
        `+++ b/${relPath}\n` +
        `@@ -0,0 +1,${lineCount} @@\n` +
        `${addedLines}`
    );
}

async function runGit(
    args: readonly string[],
    cwd: string,
    logger?: Logger,
): Promise<string> {
    return new Promise((resolve, reject) => {
        const onWindows = process.platform === 'win32';
        const child = spawn('git', args, {
            cwd,
            stdio: ['ignore', 'pipe', 'pipe'],
            shell: onWindows,
        });
        let stdout = '';
        let stderr = '';
        child.stdout?.on('data', (d: Buffer) => { stdout += d.toString('utf8'); });
        child.stderr?.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
        child.on('error', (err) => reject(err));
        child.on('close', (code) => {
            if (code === 0) {
                resolve(stdout);
                return;
            }
            logger?.warn('task-diff: git command failed', {
                args: args.join(' '),
                cwd,
                exitCode: code,
                stderr: stderr.trim().slice(0, 400),
            });
            reject(new Error(
                `git ${args.join(' ')} exited ${code}: ${stderr.trim().slice(0, 200)}`,
            ));
        });
    });
}

/** Production `ReadTaskWorktree`: pulls `task_worktrees.path` for the
 *  given taskId. The projectId / planId arguments are accepted for
 *  parity with the port shape but the worktree lookup keys only on
 *  taskId (the row is per-task and unique). */
export function createReadTaskWorktree(db: Db): ReadTaskWorktree {
    const stmt = db.prepare('SELECT path FROM task_worktrees WHERE task_id = ?');
    return async (_projectId, _planId, taskId): Promise<string | null> => {
        const row = stmt.get(taskId) as { path?: string } | undefined;
        if (!row || typeof row.path !== 'string' || row.path.length === 0) {
            return null;
        }
        return row.path;
    };
}

/**
 * Decode a URL path segment, falling back to the raw segment if it
 * carries malformed percent-encoding. The board encodes each id
 * segment with `encodeURIComponent`, so a task id with a reserved
 * char (e.g. `P-AR+W-001` → `P-AR%2BW-001`) must be decoded before it
 * can match the RAW id stored in `task_worktrees.task_id`. A bad `%`
 * would make `decodeURIComponent` throw a URIError; catching it keeps a
 * garbage segment from turning into a 500 (it just won't match).
 */
function safeDecode(segment: string): string {
    try {
        return decodeURIComponent(segment);
    } catch {
        return segment;
    }
}

/**
 * Wire the route handler into an HTTP router shaped like the other
 * worker-api routers (`handle(req, res) → boolean`). Mounted in
 * `hosts/worker-api/main.ts` and proxied through by the board-ui
 * server (the path pattern already lives in its proxy list).
 */
export function createTaskDiffRouter(
    deps: TaskDiffRouteWiringDeps,
): TaskDiffRouter {
    const handler = createTaskDiffHandler({
        readTaskWorktree: createReadTaskWorktree(deps.db),
        gitDiff: createGitDiffInvoker(deps.logger),
    });
    return {
        handle(req, res): boolean {
            const url = req.url ?? '/';
            const pathname = url.split('?', 1)[0];
            const match = TASK_DIFF_ROUTE_PATTERN.exec(pathname);
            if (!match) return false;
            const method = req.method ?? 'GET';
            if (method !== 'GET') {
                respond(res, 405, { error: 'method not allowed' }, { Allow: 'GET' });
                return true;
            }
            const [, pidRaw, planIdRaw, taskIdRaw] = match;
            const pid = safeDecode(pidRaw);
            const planId = safeDecode(planIdRaw);
            const taskId = safeDecode(taskIdRaw);
            void handler({ pid, planId, taskId })
                .then((result) => {
                    if (result === null) {
                        respond(res, 404, { error: 'task or worktree not found' });
                        return;
                    }
                    respond(res, 200, result);
                })
                .catch((err) => {
                    const message = err instanceof Error ? err.message : String(err);
                    deps.logger?.error('task-diff: handler threw', {
                        pid,
                        planId,
                        taskId,
                        error: message,
                    });
                    // "not a git repository" comes from a checkout
                    // whose `.git` pointer references a metadata
                    // directory that's been wiped. The worktree is
                    // orphaned — the next agent spawn for this task
                    // will auto-repair via `ensureWorktree`'s
                    // metadata-validity check, but until then `git
                    // diff` can't read anything. Surface a clearer
                    // hint so the operator knows what to do (Restart
                    // the task), instead of dumping the raw git
                    // error.
                    if (message.includes('not a git repository')) {
                        respond(res, 500, {
                            error: 'worktree is broken',
                            message:
                                'The worktree for this task is corrupt (.git metadata is missing). '
                                + 'Click Restart on the task — the next agent spawn will rebuild the '
                                + 'worktree from origin/<default>.',
                        });
                        return;
                    }
                    respond(res, 500, { error: 'task diff failed', message });
                });
            return true;
        },
    };
}

function respond(
    res: http.ServerResponse,
    status: number,
    body: unknown,
    extraHeaders: Readonly<Record<string, string>> = {},
): void {
    res.writeHead(status, {
        'Content-Type': 'application/json',
        ...extraHeaders,
    });
    res.end(JSON.stringify(body));
}
