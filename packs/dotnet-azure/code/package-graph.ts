/**
 * Workspace NuGet package graph — publishers, consumers, and the required
 * publish/bump chain, scanned from the repo clones on disk.
 *
 * Field incident: an architect fan-out missed the NuGet deployment chain —
 * a plan modified a package-publishing repo, and no plan published the
 * package or bumped its consumers, so downstream development ran against
 * stale references. The decomposer persona has referenced a "package graph
 * block" for months, but nothing ever BUILT one — the agents were asked to
 * reason about cross-repo package flow with no data. This module is that
 * data source.
 *
 * Detection follows the workspace conventions (see the workspace
 * CLAUDE.md):
 *   - PUBLISHER: a project directory containing `nuget_package_publish.ps1`
 *     (every publishable project ships one). Package id = `<PackageId>` from
 *     the sibling `.csproj` when present, else the `.csproj` basename.
 *   - CONSUMER: any other repo whose `.csproj` has a
 *     `<PackageReference Include="<id>">` naming a published id.
 *
 * The scan walks every registered repo's ensured clone (skipping
 * bin/obj/.git/node_modules) — cheap enough per call for the workspace's
 * repo count, but cached with a short TTL because it runs per agent spawn.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { Logger } from '../../../core/ports/Logger';

const SKIP_DIRS = new Set(['.git', 'bin', 'obj', 'node_modules', 'packages', '.vs', 'artifacts', 'testresults']);
const PUBLISH_SCRIPT = 'nuget_package_publish.ps1';

export interface PackagePublisher {
    readonly repoId: string;
    readonly packageId: string;
    /** Repo-relative directory of the publishable project. */
    readonly projectDir: string;
}

export interface PackageConsumer {
    readonly repoId: string;
    /** Repo-relative csproj that references the package. */
    readonly csproj: string;
}

export interface PackageGraph {
    readonly publishers: readonly PackagePublisher[];
    /** packageId → consuming repos (deduped, never includes the publisher). */
    readonly consumers: ReadonlyMap<string, readonly PackageConsumer[]>;
}

export interface RepoOnDisk {
    readonly repoId: string;
    readonly path: string;
}

function walkCsprojAndScripts(root: string): { csprojs: string[]; scriptDirs: Set<string> } {
    const csprojs: string[] = [];
    const scriptDirs = new Set<string>();
    const walk = (dir: string, rel: string): void => {
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const e of entries) {
            const childRel = rel === '' ? e.name : `${rel}/${e.name}`;
            if (e.isDirectory()) {
                if (SKIP_DIRS.has(e.name.toLowerCase())) continue;
                walk(path.join(dir, e.name), childRel);
            } else if (e.isFile()) {
                if (e.name.toLowerCase().endsWith('.csproj')) csprojs.push(childRel);
                else if (e.name.toLowerCase() === PUBLISH_SCRIPT) scriptDirs.add(rel);
            }
        }
    };
    walk(root, '');
    return { csprojs, scriptDirs };
}

function readFileSafe(p: string): string {
    try {
        return fs.readFileSync(p, 'utf8');
    } catch {
        return '';
    }
}

/** Build the graph by scanning every repo clone. Pure-ish (fs reads only). */
export function buildPackageGraph(
    repos: ReadonlyArray<RepoOnDisk>,
    logger?: Logger,
): PackageGraph {
    interface RepoScan {
        readonly repoId: string;
        readonly root: string;
        readonly csprojs: string[];
        readonly scriptDirs: Set<string>;
    }
    const scans: RepoScan[] = repos.map((r) => ({
        repoId: r.repoId,
        root: r.path,
        ...walkCsprojAndScripts(r.path),
    }));

    // Pass 1 — publishers: csproj whose directory ships the publish script.
    const publishers: PackagePublisher[] = [];
    for (const scan of scans) {
        for (const rel of scan.csprojs) {
            const dir = path.dirname(rel).replace(/\\/g, '/');
            const dirKey = dir === '.' ? '' : dir;
            if (!scan.scriptDirs.has(dirKey)) continue;
            const content = readFileSafe(path.join(scan.root, rel));
            const idMatch = /<PackageId>\s*([^<\s]+)\s*<\/PackageId>/i.exec(content);
            const packageId = idMatch?.[1] ?? path.basename(rel).replace(/\.csproj$/i, '');
            publishers.push({ repoId: scan.repoId, packageId, projectDir: dirKey });
        }
    }
    if (publishers.length === 0) return { publishers, consumers: new Map() };

    // Pass 2 — consumers: PackageReference to any published id, in OTHER repos.
    const byIdLower = new Map(publishers.map((p) => [p.packageId.toLowerCase(), p]));
    const consumers = new Map<string, PackageConsumer[]>();
    for (const scan of scans) {
        for (const rel of scan.csprojs) {
            const content = readFileSafe(path.join(scan.root, rel));
            for (const m of content.matchAll(/<PackageReference\s+Include="([^"]+)"/gi)) {
                const pub = byIdLower.get(m[1]!.toLowerCase());
                if (!pub || pub.repoId === scan.repoId) continue;
                const list = consumers.get(pub.packageId) ?? [];
                if (!list.some((c) => c.repoId === scan.repoId && c.csproj === rel)) {
                    list.push({ repoId: scan.repoId, csproj: rel });
                    consumers.set(pub.packageId, list);
                }
            }
        }
    }
    logger?.info('package-graph: scan complete', {
        repos: repos.length,
        publishers: publishers.length,
        consumedPackages: consumers.size,
    });
    return { publishers, consumers };
}

/**
 * Render the prompt block the design-side agents (architect,
 * design-verifier, planner, decomposer) receive. Publishers with no
 * cross-repo consumers are listed compactly; ones WITH consumers carry
 * the required chain spelled out — this is the sentence that was always
 * assumed to exist and never did.
 */
export function renderPackageGraphBlock(graph: PackageGraph): string {
    if (graph.publishers.length === 0) return '';
    const lines: string[] = [
        '# NuGet package graph (workspace)',
        '',
        'Cross-repo dependency model: consumers pin published package VERSIONS,',
        'so changing a publisher\'s source is NOT enough — until the package is',
        'published and every consumer\'s reference is bumped, consumers build',
        'against the OLD code. Whenever work modifies a publisher below that has',
        'consumers, the plan set MUST include, in order: (1) the publisher\'s code',
        'change, (2) publish the package (deploy-nuget), (3) bump the reference',
        'in EVERY consuming repo that needs the new behaviour',
        '(bump-package-reference), before/with the consumer-side work.',
        '',
    ];
    const sorted = [...graph.publishers].sort(
        (a, b) => a.packageId.localeCompare(b.packageId),
    );
    for (const pub of sorted) {
        const cons = graph.consumers.get(pub.packageId) ?? [];
        if (cons.length === 0) {
            lines.push(`- ${pub.packageId} — published by repo ${pub.repoId} (no cross-repo consumers)`);
            continue;
        }
        const repoIds = [...new Set(cons.map((c) => c.repoId))].sort();
        lines.push(
            `- ${pub.packageId} — published by repo ${pub.repoId} (${pub.projectDir || '.'}); `
            + `consumed by: ${repoIds.join(', ')}`,
        );
    }
    return lines.join('\n');
}

/**
 * TTL-cached provider suitable for per-spawn injection. The scan reads
 * every csproj in every clone — fine occasionally, wasteful per spawn.
 */
export function makePackageGraphBlockProvider(
    listRepos: () => ReadonlyArray<RepoOnDisk>,
    opts?: { readonly ttlMs?: number; readonly logger?: Logger; readonly now?: () => number },
): () => string {
    const ttl = opts?.ttlMs ?? 10 * 60 * 1000;
    const now = opts?.now ?? Date.now;
    let cachedAt = -Infinity;
    let cached = '';
    return (): string => {
        const t = now();
        if (t - cachedAt < ttl) return cached;
        try {
            cached = renderPackageGraphBlock(buildPackageGraph(listRepos(), opts?.logger));
        } catch (err) {
            opts?.logger?.warn('package-graph: scan failed — agents run without the block', {
                error: err instanceof Error ? err.message : String(err),
            });
            cached = '';
        }
        cachedAt = t;
        return cached;
    };
}
