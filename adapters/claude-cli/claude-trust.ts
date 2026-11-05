/**
 * Pre-trust pipeline workspace clones in Claude Code's user config so the
 * headless `claude` agents don't warn `Ignoring N permissions.allow entries
 * from .claude/settings.local.json: this workspace has not been trusted`.
 *
 * Claude Code gates a folder's project-level `.claude/settings.local.json`
 * (its `permissions.allow` list) behind a one-time interactive "trust this
 * folder?" dialog, recorded in `~/.claude.json` as
 * `projects["<path>"].hasTrustDialogAccepted`. The pipeline clones each repo
 * into `<workspace>/repos/<id>` headlessly — no human ever opens the trust
 * dialog there — so every such clone stays untrusted and every agent run in
 * it emits the warning. (The ignored allow entries are moot anyway: agents
 * run with `--dangerously-skip-permissions`, which bypasses the permission
 * system entirely — so this only silences noise.)
 *
 * We set the trust flag for the clone paths the pipeline owns. Strictly
 * best-effort: a missing / unparseable / unwritable `~/.claude.json` is
 * logged and skipped — never fatal. Writes are serialized in-process (a
 * promise chain) so two concurrent repo-ensures can't clobber each other's
 * read-modify-write, and committed via a temp-file + atomic rename so a
 * crash mid-write can't truncate the operator's config. (A concurrent write
 * by a live `claude` process is still theoretically possible; the atomic
 * rename keeps the file valid, at worst losing one of claude's own updates —
 * acceptable for a best-effort trust flag.)
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { Logger } from '../../core/ports/Logger';

let writeChain: Promise<void> = Promise.resolve();

/**
 * Mark each clone path trusted in `~/.claude.json`. Idempotent — a no-op
 * write is skipped when every path is already trusted. Resolves when the
 * (serialized) write completes; never rejects.
 */
export function ensureClaudeWorkspaceTrust(
    clonePaths: readonly string[],
    logger?: Logger,
    configPath?: string,
): Promise<void> {
    writeChain = writeChain
        .then(() => applyTrust(clonePaths, logger, configPath))
        .catch(() => undefined);
    return writeChain;
}

async function applyTrust(
    clonePaths: readonly string[],
    logger: Logger | undefined,
    configPath: string | undefined,
): Promise<void> {
    const paths = clonePaths.filter((p) => typeof p === 'string' && p.length > 0);
    if (paths.length === 0) return;

    const cfgPath = configPath ?? path.join(os.homedir(), '.claude.json');
    let raw: string;
    try {
        raw = await fs.promises.readFile(cfgPath, 'utf8');
    } catch {
        // No config yet (claude never run here). Nothing to trust against —
        // claude creates the file on first agent run; the next backfill
        // pass picks the clones up.
        return;
    }

    let cfg: { projects?: Record<string, unknown> };
    try {
        cfg = JSON.parse(raw) as { projects?: Record<string, unknown> };
    } catch (err) {
        logger?.warn('claude-trust: ~/.claude.json unparseable; skipping', {
            error: err instanceof Error ? err.message : String(err),
        });
        return;
    }
    if (!cfg || typeof cfg !== 'object') return;
    const projects = (cfg.projects && typeof cfg.projects === 'object')
        ? cfg.projects
        : (cfg.projects = {});

    let changed = false;
    for (const p of paths) {
        // Claude keys projects by the cwd it was launched with; on Windows
        // that can be either backslash or forward-slash form depending on
        // the caller. Trust BOTH so we match whichever claude records.
        for (const key of new Set([p, p.replace(/\\/g, '/')])) {
            const cur = projects[key];
            const entry = (cur && typeof cur === 'object')
                ? cur as Record<string, unknown>
                : {};
            if (entry.hasTrustDialogAccepted !== true) {
                entry.hasTrustDialogAccepted = true;
                projects[key] = entry;
                changed = true;
            }
        }
    }
    if (!changed) return;

    const tmp = `${cfgPath}.pipeline-trust-${process.pid}.tmp`;
    try {
        await fs.promises.writeFile(tmp, JSON.stringify(cfg, null, 2), 'utf8');
        await fs.promises.rename(tmp, cfgPath);
        logger?.info('claude-trust: marked workspace clones trusted', {
            count: paths.length,
        });
    } catch (err) {
        logger?.warn('claude-trust: failed to write ~/.claude.json (continuing)', {
            error: err instanceof Error ? err.message : String(err),
        });
        try { await fs.promises.rm(tmp, { force: true }); } catch { /* swallow */ }
    }
}

/**
 * Directories that make up a pipeline workspace, for trust purposes.
 */
export interface WorkspaceTrustRoots {
    /** `<workspace>/repos` — the parent of every workspace clone. */
    readonly reposRoot?: string | undefined;
    /** `<workspace>/worktrees` — the parent of every per-task worktree. */
    readonly worktreeRoot?: string | undefined;
    /** Anything else the caller knows agents run in. */
    readonly extra?: readonly string[] | undefined;
}

/** Injectable directory reader, so the expansion is testable. */
export interface TrustFsLike {
    readonly readdirSync: (dir: string) => readonly string[];
    readonly isDirectory: (p: string) => boolean;
}

/**
 * Expand workspace roots to the concrete directories agents are launched
 * in.
 *
 * Claude Code keys trust by the EXACT cwd, in
 * `~/.claude.json → projects["<path>"].hasTrustDialogAccepted`, with no
 * inheritance from a parent and no wildcard. Trusting `<workspace>/repos`
 * therefore does nothing for `<workspace>/repos/<id>` — every directory an
 * agent might start in needs its own entry.
 *
 * So this returns each root AND its immediate children:
 *
 *  - the roots themselves, because a repo-less run is launched at the
 *    repos root (a diagnosis may span clones) and `gh repo create` runs
 *    there too;
 *  - `repos/<id>`, every clone on disk — read from the filesystem rather
 *    than the projection so a clone whose `ensured_path` went stale, or
 *    one the projection never recorded, is still covered;
 *  - `worktrees/<taskId>`, where task agents actually run. These were the
 *    real gap: a fresh worktree per task means a directory no human has
 *    ever opened, so every task agent saw the untrusted warning.
 *
 * IMMEDIATE children only, never recursive. Both layouts are exactly one
 * level deep, and a recursive walk would add every source folder of every
 * repo to the operator's config — thousands of entries, in a file Claude
 * Code itself rewrites.
 *
 * Missing or unreadable roots contribute nothing: a workspace that has
 * not cloned anything yet is normal, not an error.
 */
export function workspaceTrustPaths(
    roots: WorkspaceTrustRoots,
    fsLike?: TrustFsLike,
): string[] {
    const io: TrustFsLike = fsLike ?? {
        readdirSync: (dir) => fs.readdirSync(dir),
        isDirectory: (p) => {
            try {
                return fs.statSync(p).isDirectory();
            } catch {
                return false;
            }
        },
    };
    const out: string[] = [];
    const add = (p: string | undefined): void => {
        if (typeof p === 'string' && p.length > 0 && !out.includes(p)) out.push(p);
    };

    for (const root of [roots.reposRoot, roots.worktreeRoot]) {
        if (typeof root !== 'string' || root.length === 0) continue;
        add(root);
        let entries: readonly string[];
        try {
            entries = io.readdirSync(root);
        } catch {
            // Not created yet, or not readable. Nothing to expand.
            continue;
        }
        for (const name of entries) {
            const child = path.join(root, name);
            if (io.isDirectory(child)) add(child);
        }
    }
    for (const p of roots.extra ?? []) add(p);
    return out;
}
