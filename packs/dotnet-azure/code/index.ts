/**
 * The dotnet-azure pack's StackHooks: the NuGet package graph for the
 * design agents, and the C#/Razor deletion and impact checks run on every
 * decomposition. All three were hardwired into the orchestrator before
 * packs existed; they are unchanged here, only moved behind the port.
 */
import type { StackHooks } from '../../../core/ports/StackHooks';
import type { Logger } from '../../../core/ports/Logger';

import { computeDeletionReferenceDeps, formatUncoveredReferences } from './deletion-reference-deps';
import { computeImpactWarnings, formatImpactSummary } from './impact-check';
import { makePackageGraphBlockProvider, type RepoOnDisk } from './package-graph';

export interface DotnetAzureHookDeps {
    /** Workspace clones on disk — the package graph scans their .csproj files. */
    readonly listRepos: () => ReadonlyArray<RepoOnDisk>;
    readonly logger: Logger;
}

export function createDotnetAzureHooks(deps: DotnetAzureHookDeps): StackHooks {
    const packageGraphBlock = makePackageGraphBlockProvider(deps.listRepos, { logger: deps.logger });
    return {
        packId: 'dotnet-azure',
        designContextBlock: packageGraphBlock,
        scanDeletions(repoPath, tasks, logger) {
            const scan = computeDeletionReferenceDeps(repoPath, tasks, logger);
            return {
                edges: scan.edges,
                ...(scan.uncovered.length > 0
                    ? { failure: formatUncoveredReferences(scan.uncovered) }
                    : {}),
            };
        },
        scanImpact(repoPath, tasks, logger) {
            const impact = computeImpactWarnings(repoPath, tasks, logger);
            return { warnings: impact.warnings, total: impact.total, summary: formatImpactSummary(impact.total) };
        },
        repoSampleGlobs: ['Program.cs', '**/*.csproj'],
    };
}
