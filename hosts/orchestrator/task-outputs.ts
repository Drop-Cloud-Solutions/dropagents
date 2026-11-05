/**
 * Task OUTPUT files — the deliverables a task produces, harvested so the
 * operator can download them from the task that made them.
 *
 * Field report: "I had a task create output, once a document and once a
 * csv file with results after checking, the document was added to the
 * repo, the csv file to the scratch folder. Both is fine, but I'd like the
 * output to be downloadable from the task once it finished."
 *
 * The live case was task L-CSFM-001, whose report ended with:
 *
 *   The CSV is at `C:\Drop-AI\Source\scratch\L-CSFM-001\...csv`.
 *
 * That folder is not a pipeline convention — the agent invented it. The
 * `# !!! WORKSPACE BOUNDARIES` block tells an agent "every legal path
 * begins with the workspace root", so writing a sibling of `repos/` was
 * within the letter of its instructions, and the pipeline had no idea the
 * file existed. A prose path in a report is not a deliverable: the
 * operator cannot click it, and nothing outside that one worker's disk can
 * reach it.
 *
 * So the pipeline declares the location instead of leaving the agent to
 * improvise one: `<workspaceRoot>/task-output/<taskId>/`. It is named in
 * the prompt as the place deliverables go, it sits OUTSIDE the worktree
 * (so nothing here is ever staged into the task's commit, and a post-merge
 * worktree removal cannot take the files with it), and everything found in
 * it is copied into the attachment store as a `kind: 'output'` attachment
 * on the task — which already has a download route, a board card and a
 * blob store behind it.
 *
 * This module is pure: a filesystem seam in, descriptors out. The copying
 * and the command dispatch live in the orchestrator.
 */

import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import * as path from 'node:path';

/** Folder under the workspace root that holds every task's outputs. */
export const TASK_OUTPUTS_DIRNAME = 'task-output';

/**
 * Hard ceiling per file, matching the operator upload limit in the
 * attachments route. A task that writes a 2GB dump has not produced a
 * deliverable, and the blob store is not a place to find out.
 */
export const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

/**
 * Ceiling on how many files one task contributes. A runaway loop that
 * writes a file per row would otherwise fill the blob store and the
 * board's card list. The cap is reported, never silently applied.
 */
export const MAX_OUTPUT_FILES = 25;

/** Deepest nesting walked inside the output folder. */
const MAX_DEPTH = 4;

export const taskOutputsRoot = (workspaceRoot: string): string =>
    path.join(workspaceRoot, TASK_OUTPUTS_DIRNAME);

export const taskOutputDir = (root: string, taskId: string): string =>
    path.join(root, taskId);

/** One harvestable file. */
export interface CollectedOutput {
    /** Path relative to the task's output dir, POSIX-separated. */
    readonly relPath: string;
    /** Absolute path on disk, for reading the bytes. */
    readonly absPath: string;
    /** Download name — the basename. */
    readonly fileName: string;
    readonly sizeBytes: number;
    readonly contentType: string;
}

/** A file deliberately left behind, and why. The operator gets told. */
export interface SkippedOutput {
    readonly relPath: string;
    readonly reason: 'too-large' | 'empty' | 'too-many' | 'unreadable';
    readonly sizeBytes?: number;
}

export interface CollectResult {
    readonly files: readonly CollectedOutput[];
    readonly skipped: readonly SkippedOutput[];
}

/** Narrow filesystem seam so the walk is testable without a temp dir. */
export interface OutputFs {
    readdirSync(dir: string): Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    statSync(p: string): { size: number };
    existsSync(p: string): boolean;
}

const defaultFs: OutputFs = {
    readdirSync: (dir) => fs.readdirSync(dir, { withFileTypes: true }),
    statSync: (p) => fs.statSync(p),
    existsSync: (p) => fs.existsSync(p),
};

/**
 * Content type by extension. Deliberately small: these are the types the
 * attachments route knows how to serve inline, plus the data formats a
 * reconciliation task actually emits. Anything else downloads as a binary
 * attachment, which is the right outcome for a .zip or a .db — unknown is
 * not a reason to drop a deliverable on the floor.
 */
const TYPE_BY_EXT: Readonly<Record<string, string>> = {
    '.csv': 'text/csv',
    '.tsv': 'text/tab-separated-values',
    '.json': 'application/json',
    '.md': 'text/markdown',
    '.markdown': 'text/markdown',
    '.txt': 'text/plain',
    '.log': 'text/plain',
    '.html': 'text/plain', // served as text, never as a renderable document
    '.xml': 'text/plain',
    '.yaml': 'text/plain',
    '.yml': 'text/plain',
    '.sql': 'text/plain',
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.doc': 'application/msword',
    '.docx':
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx':
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.ppt': 'application/vnd.ms-powerpoint',
    '.pptx':
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

export function outputContentType(fileName: string): string {
    return TYPE_BY_EXT[path.extname(fileName).toLowerCase()]
        ?? 'application/octet-stream';
}

/**
 * Walk a task's output directory.
 *
 * A missing directory is the normal case (most tasks produce no files) and
 * returns empty — not an error. Everything else that cannot be collected
 * comes back in `skipped` with a reason, because a deliverable that
 * vanished without a word is the bug this feature exists to fix.
 */
export function collectTaskOutputs(
    dir: string,
    opts?: {
        readonly fsImpl?: OutputFs;
        readonly maxBytes?: number;
        readonly maxFiles?: number;
    },
): CollectResult {
    const io = opts?.fsImpl ?? defaultFs;
    const maxBytes = opts?.maxBytes ?? MAX_OUTPUT_BYTES;
    const maxFiles = opts?.maxFiles ?? MAX_OUTPUT_FILES;

    if (!io.existsSync(dir)) return { files: [], skipped: [] };

    const files: CollectedOutput[] = [];
    const skipped: SkippedOutput[] = [];

    const walk = (current: string, rel: string, depth: number): void => {
        let entries: ReturnType<OutputFs['readdirSync']>;
        try {
            entries = io.readdirSync(current);
        } catch {
            skipped.push({ relPath: rel === '' ? '.' : rel, reason: 'unreadable' });
            return;
        }
        // Stable order so two harvests of the same directory produce the
        // same list, and the board's card order does not shuffle.
        const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of sorted) {
            // Dotfiles are tooling residue (.DS_Store, .gitkeep, editor
            // swap files), never a deliverable the operator asked for.
            if (entry.name.startsWith('.')) continue;
            const abs = path.join(current, entry.name);
            const relPath = rel === '' ? entry.name : `${rel}/${entry.name}`;
            if (entry.isDirectory()) {
                if (depth >= MAX_DEPTH) continue;
                walk(abs, relPath, depth + 1);
                continue;
            }
            if (!entry.isFile()) continue;
            let size: number;
            try {
                size = io.statSync(abs).size;
            } catch {
                skipped.push({ relPath, reason: 'unreadable' });
                continue;
            }
            if (size === 0) {
                skipped.push({ relPath, reason: 'empty', sizeBytes: 0 });
                continue;
            }
            if (size > maxBytes) {
                skipped.push({ relPath, reason: 'too-large', sizeBytes: size });
                continue;
            }
            if (files.length >= maxFiles) {
                skipped.push({ relPath, reason: 'too-many', sizeBytes: size });
                continue;
            }
            files.push({
                relPath,
                absPath: abs,
                fileName: entry.name,
                sizeBytes: size,
                contentType: outputContentType(entry.name),
            });
        }
    };

    walk(dir, '', 0);
    return { files, skipped };
}

/**
 * Idempotency key for recording one harvested output.
 *
 * Keyed on (task, relative path, content hash) so the same file found by
 * the next step's harvest is deduped by the event store rather than
 * landing again on every step — while a file the agent REWROTE between
 * steps has a different hash and is recorded as the new version it is.
 *
 * A per-task or per-path key would have swallowed the rewrite; this is the
 * trap `DecomposePlan` fell into, documented in CLAUDE.md.
 */
export function outputIdempotencyKey(
    taskId: string,
    relPath: string,
    bytes: Buffer,
): string {
    const hash = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16);
    return `TaskOutput:${taskId}:${relPath}:${hash}`;
}

/** One line per skipped file, for the operator-facing warning. */
export function describeSkippedOutputs(
    skipped: readonly SkippedOutput[],
): string {
    return skipped
        .map((s) => {
            switch (s.reason) {
                case 'too-large':
                    return `${s.relPath} (${Math.round((s.sizeBytes ?? 0) / 1024)}KB — over the `
                        + `${Math.round(MAX_OUTPUT_BYTES / (1024 * 1024))}MB limit)`;
                case 'empty':
                    return `${s.relPath} (empty)`;
                case 'too-many':
                    return `${s.relPath} (past the ${MAX_OUTPUT_FILES}-file limit)`;
                default:
                    return `${s.relPath} (unreadable)`;
            }
        })
        .join(', ');
}
