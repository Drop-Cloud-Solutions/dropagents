/**
 * Deletion-reference dependency inference for decomposer task lists.
 *
 * The file-overlap pass (`computeFileOverlapDependencies`) only links
 * tasks that WRITE the same path. Deletions break a subtler contract:
 * task A deletes `OrderPaidEvent.cs` while task B owns the files that
 * still reference the deleted type — no shared path, no edge, so A can
 * run first (or in parallel), fail to compile, and its developer
 * "fixes" the build by mauling B's files.
 *
 * The scan only considers deletions of C#/Razor-family SOURCE files
 * (`SCAN_EXTENSIONS`). A deleted .bicep / .ps1 / .json / .yaml file
 * declares no C# type, so putting its basename into the search would
 * only produce noise: `main.bicep` matched the literal `<main>` tag in
 * a Razor layout and failed an otherwise-fine infra decomposition. Such
 * deletions still count as deleted (a deleted file is never scanned as
 * a referencing file), they just contribute no type names and hence no
 * edges and no uncovered references.
 *
 * This pass makes deletions first-class:
 *
 *   1. For every C#/Razor-family file in a task's
 *      `context.files_to_delete`, read the file in the plan's repo clone
 *      and extract the type names it declares (class / interface /
 *      record / struct / enum; fallback: the file's basename).
 *   2. Scan the clone for other source files referencing those names.
 *   3. Every referencing file that ANOTHER task writes (create / modify
 *      / delete) yields an inferred edge: the deletion task must run
 *      AFTER that task. Cycle-safe: an edge that would close a loop
 *      against the declared/overlap graph is skipped with a warning
 *      (over-serialisation is acceptable, deadlock is not).
 *   4. Referencing files that NO task touches are returned as
 *      `uncovered` — the decomposition is incoherent (deleting the file
 *      would break the build and nobody fixes it), and the caller fails
 *      the decompose with a precise message instead of letting the
 *      interference play out in worktrees.
 *
 * Text search is a heuristic: reflection/string references are missed,
 * and a comment mentioning the type can over-link (harmless — it only
 * serialises two tasks) or over-report an uncovered reference (visible
 * — the failure message names the exact file, and the decomposer's
 * retry sees it as feedback).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { Logger } from '../../../core/ports/Logger';

/** Directories never worth scanning for source references. */
const SKIP_DIRS = new Set([
    '.git', 'bin', 'obj', 'node_modules', 'dist', '.vs', 'packages',
    'testresults', '.idea', 'artifacts',
]);

/** Source extensions that can reference a C#/Razor type. */
const SCAN_EXTENSIONS = new Set(['.cs', '.razor', '.cshtml', '.xaml', '.csproj']);

export const MAX_FILE_BYTES = 1_000_000;

const TYPE_DECL_RE =
    /\b(?:class|interface|record|struct|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/g;

/**
 * Basenames too generic to search for. The fallback exists for files whose
 * class name IS the file name (.razor components); for these it produces a
 * word that appears in half the repo for unrelated reasons — `Program.cs`
 * with top-level statements declares nothing, and searching for "program"
 * flagged every file with the word in a comment. No name beats a noisy one:
 * a missed edge over-parallelises, a false uncovered reference kills the
 * whole decomposition.
 */
const GENERIC_BASENAMES = new Set([
    'main', 'index', 'program', 'startup', 'app', 'test', 'tests',
    'base', 'common', 'shared', 'utils', 'helpers', 'constants',
]);

export interface UncoveredReference {
    /** Repo-relative path the task wants to delete. */
    readonly deletedFile: string;
    /** The declared type (or basename) still referenced elsewhere. */
    readonly typeName: string;
    /** Repo-relative path that references it and no task touches. */
    readonly referencingFile: string;
}

export interface DeletionReferenceScan {
    /** taskId → ids of tasks its deletions must wait for. */
    readonly edges: ReadonlyMap<string, readonly string[]>;
    /** References to deleted types that no task in the plan updates. */
    readonly uncovered: readonly UncoveredReference[];
}

const EMPTY_SCAN: DeletionReferenceScan = { edges: new Map(), uncovered: [] };

export function normalizePath(p: unknown): string {
    if (typeof p !== 'string') return '';
    return p.trim().replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
}

export function stringList(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value
        .map((v) => normalizePath(v))
        .filter((v) => v.length > 0);
}

interface TaskFiles {
    readonly id: string;
    readonly deletes: readonly string[];
    readonly writes: ReadonlySet<string>;
    readonly declaredDeps: readonly string[];
}

function readTaskFiles(task: Record<string, unknown>): TaskFiles {
    const ctx = (task.context ?? {}) as {
        files_to_create?: unknown;
        files_to_modify?: unknown;
        files_to_delete?: unknown;
    };
    const deletes = stringList(ctx.files_to_delete);
    const writes = new Set<string>([
        ...stringList(ctx.files_to_create),
        ...stringList(ctx.files_to_modify),
        ...deletes,
    ]);
    const declaredDeps = Array.isArray(task.dependencies)
        ? (task.dependencies as unknown[]).filter((d): d is string => typeof d === 'string')
        : [];
    return { id: String(task.id), deletes, writes, declaredDeps };
}

export function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Type names a deleted file removes from the codebase. Reads the file
 * from the clone; a file that doesn't exist there contributes nothing
 * (nothing can reference it yet). Falls back to the basename when the
 * file exists but declares nothing recognisable (e.g. a .razor
 * component, whose class name IS the file name) — unless that basename
 * is too generic to search for ({@link GENERIC_BASENAMES}).
 */
export function declaredTypeNames(
    repoPath: string,
    relPath: string,
    index?: SourceFileIndex,
): string[] {
    // `relPath` arrives LOWERCASED (normalizePath), because it is used as a
    // comparison key against other normalized paths. A lowercased path is not
    // a usable filesystem path on a case-sensitive filesystem: on Linux
    // statSync throws ENOENT, the catch below returns [], and the whole scan
    // silently finds nothing — both decompose guards became no-ops on CI while
    // passing on Windows (NTFS resolves either case). Resolve back to the real
    // on-disk spelling via the walk index before touching the filesystem.
    const abs = path.join(repoPath, realPath(relPath, index));
    let content: string;
    try {
        const stat = fs.statSync(abs);
        if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return [];
        content = fs.readFileSync(abs, 'utf8');
    } catch {
        return [];
    }
    const names = new Set<string>();
    for (const m of content.matchAll(TYPE_DECL_RE)) {
        if (m[1] !== undefined) names.add(m[1]);
    }
    if (names.size === 0) {
        const base = path.basename(relPath).replace(/\.[^.]+$/, '').replace(/\.[^.]+$/, '');
        if (base.length >= 3 && !GENERIC_BASENAMES.has(base.toLowerCase())) names.add(base);
    }
    return [...names];
}

/**
 * Normalized (lowercased) key → the file's REAL on-disk relative path.
 *
 * Two different things are needed from a path here and conflating them is
 * what broke on Linux: a case-insensitive KEY for comparing against the
 * decomposer's declared paths, and the exact on-disk spelling for reading
 * the file. This index carries both.
 */
export type SourceFileIndex = ReadonlyMap<string, string>;

/**
 * Resolve a normalized path key back to its real on-disk spelling. Falls
 * back to the key itself when no index is supplied or the file was not seen
 * by the walk — on a case-insensitive filesystem that still works, and on a
 * case-sensitive one a miss means the file genuinely is not there.
 */
export function realPath(relPath: string, index?: SourceFileIndex): string {
    const real = index?.get(relPath) ?? relPath;
    return real.split('/').join(path.sep);
}

/**
 * Walk the clone building {@link SourceFileIndex}: normalized key → real
 * relative path, for every scannable source file.
 */
export function indexSourceFiles(repoPath: string): SourceFileIndex {
    const index = new Map<string, string>();
    const walk = (dir: string, rel: string): void => {
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const e of entries) {
            if (e.isDirectory()) {
                if (SKIP_DIRS.has(e.name.toLowerCase())) continue;
                walk(path.join(dir, e.name), rel === '' ? e.name : `${rel}/${e.name}`);
            } else if (e.isFile()) {
                const ext = path.extname(e.name).toLowerCase();
                if (SCAN_EXTENSIONS.has(ext)) {
                    const real = rel === '' ? e.name : `${rel}/${e.name}`;
                    // First spelling wins: on a case-sensitive filesystem two
                    // files can share a normalized key, and picking either is
                    // better than dropping both.
                    const key = normalizePath(real);
                    if (!index.has(key)) index.set(key, real);
                }
            }
        }
    };
    walk(repoPath, '');
    return index;
}

/** Walk the clone yielding repo-relative (normalized) source file paths. */
export function listSourceFiles(repoPath: string): string[] {
    const out: string[] = [];
    const walk = (dir: string, rel: string): void => {
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const e of entries) {
            if (e.isDirectory()) {
                if (SKIP_DIRS.has(e.name.toLowerCase())) continue;
                walk(path.join(dir, e.name), rel === '' ? e.name : `${rel}/${e.name}`);
            } else if (e.isFile()) {
                const ext = path.extname(e.name).toLowerCase();
                if (SCAN_EXTENSIONS.has(ext)) {
                    out.push(normalizePath(rel === '' ? e.name : `${rel}/${e.name}`));
                }
            }
        }
    };
    walk(repoPath, '');
    return out;
}

/** Does `from` transitively depend on `to` in the current graph? */
function reaches(
    dependsOn: ReadonlyMap<string, ReadonlySet<string>>,
    from: string,
    to: string,
): boolean {
    const seen = new Set<string>();
    const stack = [from];
    while (stack.length > 0) {
        const cur = stack.pop() as string;
        if (cur === to) return true;
        if (seen.has(cur)) continue;
        seen.add(cur);
        for (const next of dependsOn.get(cur) ?? []) stack.push(next);
    }
    return false;
}

/**
 * Run the deletion-reference scan. `tasks` is the RAW decomposer task
 * list (`plan.tasks`), pre-rename — ids here are the decomposer's own
 * (`task-001`), which the caller's rename pass rewrites uniformly for
 * declared, overlap and deletion edges alike.
 */
export function computeDeletionReferenceDeps(
    repoPath: string,
    tasks: ReadonlyArray<Record<string, unknown>>,
    logger?: Logger,
): DeletionReferenceScan {
    const files = tasks.map(readTaskFiles);
    if (!files.some((t) => t.deletes.length > 0)) return EMPTY_SCAN;

    // Real on-disk spellings for every scannable file, keyed by normalized
    // path. Declared paths are lowercased keys, so every filesystem read below
    // goes through this index (see declaredTypeNames for why).
    const index = indexSourceFiles(repoPath);

    // taskId → the type names its deletions remove.
    const deletionTypes = new Map<string, Map<string, string>>(); // id → typeName → deletedFile
    const allDeleted = new Set<string>();
    for (const t of files) {
        for (const del of t.deletes) {
            // Every deletion counts as deleted regardless of extension, so a
            // deleted file is never scanned as a referencing file below.
            allDeleted.add(del);
            // ...but only C#/Razor-family sources can declare a type worth
            // searching for. A .bicep / .ps1 / .json deletion contributes no
            // names, hence no edges and no uncovered references.
            if (!SCAN_EXTENSIONS.has(path.extname(del).toLowerCase())) continue;
            for (const name of declaredTypeNames(repoPath, del, index)) {
                let bucket = deletionTypes.get(t.id);
                if (!bucket) {
                    bucket = new Map();
                    deletionTypes.set(t.id, bucket);
                }
                if (!bucket.has(name)) bucket.set(name, del);
            }
        }
    }
    if (deletionTypes.size === 0) return EMPTY_SCAN;

    const patterns = new Map<string, RegExp>();
    for (const bucket of deletionTypes.values()) {
        for (const name of bucket.keys()) {
            if (!patterns.has(name)) {
                // Case-insensitive: basename-derived names arrive lowercased
                // via path normalization; C# type references are case-exact
                // but an occasional over-match only adds a harmless edge.
                patterns.set(name, new RegExp(`\\b${escapeRegExp(name)}\\b`, 'i'));
            }
        }
    }

    // Dependency graph as it stands (declared edges) for cycle checks.
    const dependsOn = new Map<string, Set<string>>();
    for (const t of files) dependsOn.set(t.id, new Set(t.declaredDeps));

    const edges = new Map<string, string[]>();
    const uncovered: UncoveredReference[] = [];
    const seenUncovered = new Set<string>();

    for (const relPath of listSourceFiles(repoPath)) {
        // A file that is itself deleted takes its references with it.
        if (allDeleted.has(relPath)) continue;
        let content: string;
        try {
            const abs = path.join(repoPath, realPath(relPath, index));
            const stat = fs.statSync(abs);
            if (stat.size > MAX_FILE_BYTES) continue;
            content = fs.readFileSync(abs, 'utf8');
        } catch {
            continue;
        }
        for (const [taskId, bucket] of deletionTypes) {
            const self = files.find((t) => t.id === taskId);
            for (const [typeName, deletedFile] of bucket) {
                const re = patterns.get(typeName);
                if (!re || !re.test(content)) continue;
                if (self?.writes.has(relPath)) continue; // deletion task fixes it itself
                const coveredBy = files.filter(
                    (t) => t.id !== taskId && t.writes.has(relPath),
                );
                if (coveredBy.length === 0) {
                    const key = `${deletedFile}|${relPath}`;
                    if (!seenUncovered.has(key)) {
                        seenUncovered.add(key);
                        uncovered.push({ deletedFile, typeName, referencingFile: relPath });
                    }
                    continue;
                }
                for (const t of coveredBy) {
                    // Adding "deletion depends on t" must not close a cycle
                    // (t may already depend on the deletion task, directly
                    // or transitively). Skip + warn: over-parallelism plus
                    // a log line beats a deadlocked dependency gate.
                    if (reaches(dependsOn, t.id, taskId)) {
                        logger?.warn(
                            'deletion-reference-deps: edge skipped to avoid dependency cycle',
                            { deletionTask: taskId, wouldDependOn: t.id, file: relPath },
                        );
                        continue;
                    }
                    const list = edges.get(taskId) ?? [];
                    if (!list.includes(t.id)) {
                        list.push(t.id);
                        edges.set(taskId, list);
                        dependsOn.get(taskId)?.add(t.id);
                    }
                }
            }
        }
    }

    if (edges.size > 0 || uncovered.length > 0) {
        logger?.info('deletion-reference-deps: scan complete', {
            deletionTasks: deletionTypes.size,
            inferredEdges: [...edges.values()].reduce((n, l) => n + l.length, 0),
            uncoveredReferences: uncovered.length,
        });
    }
    return { edges, uncovered };
}

/**
 * Human/agent-facing message for a failed scan — precise enough for the
 * operator to act on and for the decomposer's retry (it arrives as
 * feedback via agent memory) to fix the split.
 */
export function formatUncoveredReferences(
    uncovered: readonly UncoveredReference[],
    cap = 5,
): string {
    const shown = uncovered.slice(0, cap).map(
        (u) =>
            `${u.deletedFile} (type ${u.typeName}) is still referenced by `
            + `${u.referencingFile}, which no task updates`,
    );
    const more = uncovered.length > cap ? `; and ${uncovered.length - cap} more` : '';
    return (
        'decomposition deletes files whose references are never updated: '
        + shown.join('; ')
        + more
        + ' — extend a task to remove these references (or fold the deletion '
        + 'into the task that removes the last reference)'
    );
}
