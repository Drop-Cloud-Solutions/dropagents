/**
 * Post-decompose impact check — ADVISORY sibling of the deletion-reference
 * pass (`./deletion-reference-deps`).
 *
 * Field incidents: the architect/decomposer's task list missed a file that
 * also needed changing (a consumer of a modified type, a test fixture, a
 * DI registration in another project), and the miss only surfaced as a
 * broken build deep in a task's worktree. The deletion pass already FAILS
 * a decompose whose deletions leave dangling references; modifications are
 * a weaker signal — a modified type is legitimately referenced in many
 * places that need no edit — so this pass never fails the decompose.
 * Instead it computes "files that reference a type this plan modifies but
 * that no task touches" and the caller surfaces them as warnings on the
 * plan (Rule 1: never fail silently — but don't cry wolf either, hence
 * advisory).
 *
 * Ranking: cross-directory references first. A reference from another
 * top-level directory is usually another PROJECT (another .csproj) — the
 * couplings the decomposer misses most — while same-directory references
 * are usually the cohesive cluster the task already owns mentally.
 *
 * Heuristic caveats mirror the deletion pass: text search misses
 * reflection/string references and over-reports comment mentions. That is
 * acceptable for an advisory list the operator eyeballs before approving
 * tasks; the fix for a real miss is one click away (plan "Add task").
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { Logger } from '../../../core/ports/Logger';
import {
    MAX_FILE_BYTES,
    declaredTypeNames,
    escapeRegExp,
    indexSourceFiles,
    listSourceFiles,
    realPath,
    stringList,
} from './deletion-reference-deps';

export interface ImpactWarning {
    /** Repo-relative path a task modifies. */
    readonly changedFile: string;
    /** The declared type whose references were scanned. */
    readonly typeName: string;
    /** Repo-relative path that references it and no task touches. */
    readonly referencingFile: string;
}

/** Upper bound on warnings persisted/rendered — beyond this the list is
 *  noise, and the count in the summary line carries the signal instead. */
export const IMPACT_WARNING_CAP = 12;

/** Types per modified file worth scanning — a file declaring more than
 *  this is a grab-bag whose type list would explode the pattern set. */
const MAX_TYPES_PER_FILE = 8;

interface TaskFileSets {
    readonly modifies: readonly string[];
    readonly touched: ReadonlySet<string>;
}

function collectTaskFiles(
    tasks: ReadonlyArray<Record<string, unknown>>,
): TaskFileSets {
    const modifies = new Set<string>();
    const touched = new Set<string>();
    for (const task of tasks) {
        const ctx = (task.context ?? {}) as {
            files_to_create?: unknown;
            files_to_modify?: unknown;
            files_to_delete?: unknown;
        };
        for (const f of stringList(ctx.files_to_modify)) {
            modifies.add(f);
            touched.add(f);
        }
        for (const f of stringList(ctx.files_to_create)) touched.add(f);
        for (const f of stringList(ctx.files_to_delete)) touched.add(f);
    }
    return { modifies: [...modifies], touched };
}

/** Top-level path segment — the cross-directory ranking key. */
function topDir(relPath: string): string {
    const idx = relPath.indexOf('/');
    return idx === -1 ? '' : relPath.slice(0, idx);
}

/**
 * Scan the plan's repo clone for files that reference a type declared in
 * a `files_to_modify` entry while being touched by NO task in the plan.
 * Returns warnings ranked cross-directory-first, deduped per
 * (changedFile, referencingFile) pair, capped at
 * {@link IMPACT_WARNING_CAP} — plus the uncapped total so the caller's
 * summary can say "and N more".
 */
export function computeImpactWarnings(
    repoPath: string,
    tasks: ReadonlyArray<Record<string, unknown>>,
    logger?: Logger,
): { warnings: ImpactWarning[]; total: number } {
    const { modifies, touched } = collectTaskFiles(tasks);
    if (modifies.length === 0) return { warnings: [], total: 0 };

    // typeName → the modified file that declares it. First declarer wins;
    // a duplicate type name across two modified files changes nothing
    // about which OTHER files reference it.
    // Real on-disk spellings keyed by normalized path: `modifies` entries are
    // lowercased comparison keys, which are not valid paths on a
    // case-sensitive filesystem (see declaredTypeNames).
    const index = indexSourceFiles(repoPath);
    const typeToFile = new Map<string, string>();
    for (const rel of modifies) {
        const names = declaredTypeNames(repoPath, rel, index).slice(0, MAX_TYPES_PER_FILE);
        for (const name of names) {
            if (!typeToFile.has(name)) typeToFile.set(name, rel);
        }
    }
    if (typeToFile.size === 0) return { warnings: [], total: 0 };

    const patterns = new Map<string, RegExp>();
    for (const name of typeToFile.keys()) {
        patterns.set(name, new RegExp(`\\b${escapeRegExp(name)}\\b`, 'i'));
    }

    const all: ImpactWarning[] = [];
    const seen = new Set<string>();
    for (const relPath of listSourceFiles(repoPath)) {
        if (touched.has(relPath)) continue;
        let content: string;
        try {
            const abs = path.join(repoPath, realPath(relPath, index));
            const stat = fs.statSync(abs);
            if (stat.size > MAX_FILE_BYTES) continue;
            content = fs.readFileSync(abs, 'utf8');
        } catch {
            continue;
        }
        for (const [typeName, changedFile] of typeToFile) {
            const re = patterns.get(typeName);
            if (!re || !re.test(content)) continue;
            const key = `${changedFile}|${relPath}`;
            if (seen.has(key)) continue;
            seen.add(key);
            all.push({ changedFile, typeName, referencingFile: relPath });
        }
    }

    // Cross-directory references outrank same-directory ones; within a
    // bucket keep deterministic path order so re-decomposes with the same
    // task list produce the same warning list.
    all.sort((a, b) => {
        const aCross = topDir(a.referencingFile) !== topDir(a.changedFile) ? 0 : 1;
        const bCross = topDir(b.referencingFile) !== topDir(b.changedFile) ? 0 : 1;
        if (aCross !== bCross) return aCross - bCross;
        return a.referencingFile.localeCompare(b.referencingFile)
            || a.changedFile.localeCompare(b.changedFile);
    });

    if (all.length > 0) {
        logger?.info('impact-check: scan complete', {
            modifiedFiles: modifies.length,
            typesScanned: typeToFile.size,
            warnings: all.length,
        });
    }
    return { warnings: all.slice(0, IMPACT_WARNING_CAP), total: all.length };
}

/** One-line operator summary for logs / status surfaces. */
export function formatImpactSummary(total: number): string {
    if (total === 0) return 'impact check: no untouched references to modified types';
    return (
        `impact check: ${total} file(s) reference types this plan modifies `
        + 'but are not touched by any task — review whether they need a task '
        + '(plan modal → Add task)'
    );
}
