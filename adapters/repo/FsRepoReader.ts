/**
 * AP-VP4-003 — production `RepoReader` adapter backed by the local filesystem.
 *
 * Walks the working tree at {@link RepoSpec.repoPath} and assembles the three
 * fields the planner / decomposer prompts depend on:
 *
 *   - `claudeMd`: contents of `CLAUDE.md` at the repo root, or `null` when the
 *     file is absent. The file is treated as optional context — missing is
 *     normal, not an error.
 *   - `tree`: repo-relative file paths in deterministic lex order, capped at
 *     {@link RepoSpec.fileCap} (default 500). Vendor / build / VCS directories
 *     are never traversed so the tree stays focused on source files. POSIX
 *     forward-slash separators are used throughout so paths flowing into
 *     prompts and `sampleFiles` keys are portable across hosts.
 *   - `sampleFiles`: for each glob in `sampleGlobs` (default
 *     `['Program.cs', '**\/*.csproj', 'CLAUDE.md']`), every file in `tree`
 *     whose path matches has its contents included. A single file larger than
 *     32 KB is truncated to the first 32 KB plus a trailing
 *     "… (truncated)" marker so the prompt context stays bounded.
 *
 * The adapter is intentionally thin: no caching, no watching, no concurrent
 * directory reads. Plans are assembled infrequently, the tree cap keeps the
 * worst case bounded, and a synchronous-feeling depth-first walk is much
 * easier to reason about (and to test) than parallel readdir fanout.
 */

import * as fs from 'fs/promises';
import * as nodePath from 'path';

import type { Logger } from '../../core/ports/Logger';
import type {
    RepoReader,
    RepoReadResult,
    RepoSpec,
} from '../../core/ports/RepoReader';

/** Default upper bound on `tree` length when the caller does not override. */
const DEFAULT_FILE_CAP = 500;

/**
 * Default sample globs when neither the spec nor the reader's options name
 * any. Stack-neutral: the stack packs add their own (the dotnet-azure pack:
 * `Program.cs`, `**\/*.csproj`) through the reader's `defaultSampleGlobs`.
 */
const DEFAULT_SAMPLE_GLOBS: ReadonlyArray<string> = ['CLAUDE.md'];

/**
 * Directories that are never descended into. These are dependency caches,
 * VCS metadata, build output, and framework scratch directories — none of
 * them belong in a planner prompt and walking them can dominate runtime on
 * repos with large `node_modules`.
 */
const IGNORED_DIRS: ReadonlySet<string> = new Set([
    'node_modules',
    '.git',
    'dist',
    'build',
    'bin',
    'obj',
    '.next',
    'coverage',
]);

/** Per-file truncation threshold for `sampleFiles` contents. */
const MAX_SAMPLE_BYTES = 32 * 1024;

/** Marker appended to truncated sample files. */
const TRUNCATION_MARKER = '\n… (truncated)';

export interface FsRepoReaderOptions {
    /**
     * Structured logger. Required so operators can see when a repo read
     * begins (with the resolved cap) and which directories were skipped
     * because `readdir` failed — both are otherwise invisible from outside
     * the adapter.
     */
    readonly logger: Logger;
    /**
     * Sample globs used when a spec names none. The host passes core's
     * (`CLAUDE.md`) plus whatever the enabled stack packs add.
     */
    readonly defaultSampleGlobs?: ReadonlyArray<string>;
}

export class FsRepoReader implements RepoReader {
    private readonly logger: Logger;
    private readonly defaultSampleGlobs: ReadonlyArray<string>;

    constructor(options: FsRepoReaderOptions) {
        this.logger = options.logger;
        this.defaultSampleGlobs = options.defaultSampleGlobs ?? DEFAULT_SAMPLE_GLOBS;
    }

    async read(spec: RepoSpec): Promise<RepoReadResult> {
        const fileCap =
            typeof spec.fileCap === 'number' && spec.fileCap >= 0
                ? spec.fileCap
                : DEFAULT_FILE_CAP;
        const sampleGlobs = spec.sampleGlobs ?? this.defaultSampleGlobs;

        this.logger.info('FsRepoReader.read', {
            repoPath: spec.repoPath,
            fileCap,
        });

        const tree = await collectTree(spec.repoPath, fileCap, this.logger);
        const claudeMd = await readClaudeMd(spec.repoPath);
        const sampleFiles = await collectSampleFiles(
            spec.repoPath,
            tree,
            sampleGlobs,
        );

        return { claudeMd, tree, sampleFiles };
    }
}

/**
 * Depth-first walk producing repo-relative POSIX paths in sorted order.
 *
 * Entries at each level are sorted before recursion so the traversal order
 * is fully determined by the on-disk names — two runs against the same
 * working tree yield identical output. Once `cap` entries have been
 * collected the walk short-circuits; the resulting prefix is the lex-first
 * `cap` paths, which makes the cap reproducible too.
 *
 * Note: under JS string comparison `'a' < 'a/x' < 'a.txt'` (because `'/'`
 * sorts after `'.'`), so the depth-first emission order is NOT identical
 * to sorting all final paths globally. We deliberately keep the
 * depth-first ordering — it groups every directory's contents together,
 * which is much more readable in a prompt context than a globally sorted
 * flat list — and we document the order as "lex within each directory".
 */
async function collectTree(
    repoPath: string,
    cap: number,
    logger: Logger,
): Promise<string[]> {
    const out: string[] = [];
    if (cap === 0) return out;
    await walkDir(repoPath, '', out, cap, logger);
    return out;
}

async function walkDir(
    repoRoot: string,
    relDir: string,
    out: string[],
    cap: number,
    logger: Logger,
): Promise<void> {
    if (out.length >= cap) return;

    const absDir = relDir === '' ? repoRoot : nodePath.join(repoRoot, relDir);

    let entries;
    try {
        entries = await fs.readdir(absDir, { withFileTypes: true });
    } catch (err) {
        // A directory we cannot read (permission denied, race with deletion)
        // is treated as empty. Bubbling the error would make a single broken
        // permission set break planning across the whole repo. We still log
        // the failure so operators can see why the tree is missing files.
        logger.warn('FsRepoReader.walkDir: readdir failed', {
            dir: absDir,
            relDir,
            error: errorMessage(err),
        });
        return;
    }

    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    for (const entry of entries) {
        if (out.length >= cap) return;
        const childRel = relDir === '' ? entry.name : `${relDir}/${entry.name}`;
        if (entry.isDirectory()) {
            if (IGNORED_DIRS.has(entry.name)) continue;
            await walkDir(repoRoot, childRel, out, cap, logger);
        } else if (entry.isFile()) {
            out.push(childRel);
        }
        // Symlinks and other entry kinds are skipped deliberately: a symlink
        // into `node_modules` would re-introduce the directory we just
        // ignored, and a broken symlink would surface as a confusing read
        // error in `sampleFiles`.
    }
}

/**
 * Read `CLAUDE.md` from the repo root. Returns `null` when the file is
 * missing — that's the documented "optional context" behaviour. Any other
 * read error (permission denied, etc.) is propagated; the caller benefits
 * from a clear failure rather than silently empty context.
 */
async function readClaudeMd(repoPath: string): Promise<string | null> {
    const claudeMdPath = nodePath.join(repoPath, 'CLAUDE.md');
    try {
        return await fs.readFile(claudeMdPath, 'utf8');
    } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
    }
}

function isNotFound(err: unknown): boolean {
    return (
        typeof err === 'object' &&
        err !== null &&
        (err as { code?: unknown }).code === 'ENOENT'
    );
}

function errorMessage(err: unknown): string {
    if (err instanceof Error) return err.message;
    return String(err);
}

async function collectSampleFiles(
    repoPath: string,
    tree: ReadonlyArray<string>,
    sampleGlobs: ReadonlyArray<string>,
): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    if (sampleGlobs.length === 0) return out;

    const matchers = sampleGlobs.map(globToRegExp);

    for (const rel of tree) {
        if (!matchers.some((re) => re.test(rel))) continue;
        out[rel] = await readSample(nodePath.join(repoPath, rel));
    }

    return out;
}

/**
 * Read a sample file, truncating to the first {@link MAX_SAMPLE_BYTES} bytes
 * when oversized. Truncation operates on the UTF-8 byte buffer (not the
 * decoded string) so the cap is predictable regardless of how wide the
 * file's characters happen to be. The trailing marker is appended only
 * when truncation actually happened.
 *
 * Truncating mid-codepoint can yield a partial UTF-8 sequence; the
 * `fatal: false` decoder default substitutes a replacement character
 * rather than throwing — acceptable for prompt context where exact byte
 * fidelity is not required.
 */
async function readSample(absPath: string): Promise<string> {
    const buf = await fs.readFile(absPath);
    if (buf.length <= MAX_SAMPLE_BYTES) {
        return buf.toString('utf8');
    }
    const head = buf.subarray(0, MAX_SAMPLE_BYTES).toString('utf8');
    return head + TRUNCATION_MARKER;
}

/**
 * Translate a minimal glob (the subset documented for `sampleGlobs`) into
 * an anchored regular expression that matches POSIX-style relative paths.
 *
 * Supported syntax:
 *   - `*`  — any run of characters except `/`
 *   - `?`  — a single character except `/`
 *   - `**` — any sequence of characters including `/`
 *   - `**\/` (i.e. `**` followed by `/`) — zero or more leading directories,
 *     so `**\/*.csproj` matches `foo.csproj` at the root as well as
 *     `a/b/foo.csproj`.
 *
 * Everything else is treated as a literal (regex metacharacters are
 * escaped). This is intentionally smaller than full POSIX glob: the
 * documented default globs are the spec, and a 30-line matcher is easier
 * to audit than pulling in a glob dependency.
 */
export function globToRegExp(glob: string): RegExp {
    let pattern = '';
    let i = 0;
    const escape = /[.+^${}()|[\]\\]/;
    while (i < glob.length) {
        const c = glob[i];
        if (c === '*' && glob[i + 1] === '*') {
            i += 2;
            if (glob[i] === '/') {
                i += 1;
                // **/ → optionally a path prefix; makes `**/foo` match
                // `foo` at the root too.
                pattern += '(?:.*/)?';
            } else {
                pattern += '.*';
            }
        } else if (c === '*') {
            pattern += '[^/]*';
            i += 1;
        } else if (c === '?') {
            pattern += '[^/]';
            i += 1;
        } else if (escape.test(c)) {
            pattern += '\\' + c;
            i += 1;
        } else {
            pattern += c;
            i += 1;
        }
    }
    return new RegExp('^' + pattern + '$');
}
