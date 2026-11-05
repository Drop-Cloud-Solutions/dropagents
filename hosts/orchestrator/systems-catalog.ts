/**
 * Systems catalog — the cross-system context block fed to the architect agent
 * (Architect Tier, Phase 1). It answers "which systems exist, what repos back
 * them, and what does each roughly do" so the architect can route a business
 * requirement to the right producer/consumer systems.
 *
 * A SYSTEM IS ONE REPO. That is the load-bearing fact, and it used to be
 * wrong: the catalog listed a system per PROJECT with its repos nested
 * inside, while the fan-out reads `systemId` as a REPO id to pick each
 * plan's target repo (`main.ts`: "the systemId, which is a repo id no
 * project view knows"). Two meanings, one field.
 *
 * What that cost (REQ-1786956418797, five identical rejections): the
 * `workshop` project owns 19 repos, so the catalog offered exactly ONE
 * system. The architect — told to emit one sub-brief per affected system —
 * designed work across three repos, had one slot to put it in, wrote one
 * repo's worth and dropped the rest. The design-verifier read the design,
 * counted three units of work and one brief, and failed it. Correctly, and
 * every time: regenerating cannot fix a structural constraint. Worse, the
 * one brief it did emit carried `systemId: "workshop"`, and no repo of
 * that name exists — so `metadata.targetRepo` would not have resolved
 * either, and the tasks would have had no worktree.
 *
 * The reason it went unnoticed for so long: the `shop` project happens
 * to contain a repo also called `shop`, so there the project id
 * resolved as a repo id by coincidence.
 *
 * Projects have not gone away — they are the GROUPING, rendered as a
 * heading so the architect still knows which repos belong to one product.
 * They are simply not fan-out targets.
 *
 * This module is PURE: it renders a Markdown block from plain data. The
 * orchestrator assembles the {@link SystemCatalogEntry} list from the
 * project registry (`core/projects/registry.ts`) + the repo projection
 * (`listActive()`), then passes it here. Keeping the renderer pure lets
 * `systems-catalog.test.ts` exercise it with no registry, store, or
 * filesystem — the same split used by `plan-dep-graph.ts`.
 */

export interface SystemCatalogRepo {
    readonly repoId: string;
    readonly name: string;
    /** One-paragraph capability summary (e.g. the repo's CLAUDE.md lead). */
    readonly summary?: string;
    /** Absolute clone path, when the architect is allowed to read it. */
    readonly path?: string;
}

export interface SystemCatalogEntry {
    /**
     * The system's stable id — a REPO id. The fan-out resolves each
     * sub-brief's `systemId` to that repo to set the plan's target repo,
     * so an id here that is not a registered repo produces plans whose
     * tasks have nowhere to run.
     */
    readonly systemId: string;
    readonly name: string;
    /**
     * The repo backing this system. One entry — kept as a list because the
     * renderer shows its summary and path, and because a system with no
     * resolvable repo is a state worth rendering rather than hiding.
     */
    readonly repos: readonly SystemCatalogRepo[];
    /** Owning project, when the repo belongs to one. Grouping only. */
    readonly projectId?: string;
    readonly projectName?: string;
}

/** Systems with no owning project are grouped under this heading. */
const UNGROUPED = 'Unassigned repos';

/**
 * Render the systems catalog as a Markdown block for the architect prompt.
 * Output is deterministic (groups and systems sorted by name) so prompt
 * text — and tests — are stable regardless of input ordering.
 */
export function renderSystemsCatalogBlock(
    systems: readonly SystemCatalogEntry[],
): string {
    const lines: string[] = ['# Systems catalog'];
    lines.push('');
    lines.push(
        'Each SYSTEM below is one repo, and `systemId` is what a sub-brief '
            + 'targets: the fan-out turns every sub-brief into its own plan '
            + 'against that repo. Systems are grouped by the project they '
            + 'belong to, so you can see which repos make up one product.',
    );
    lines.push('');
    lines.push(
        'Work that spans several repos of the SAME project therefore needs '
            + 'ONE SUB-BRIEF PER REPO — the project itself is not a target, '
            + 'and its id is not a valid `systemId`.',
    );

    if (systems.length === 0) {
        lines.push('');
        lines.push('(no systems configured)');
        return lines.join('\n');
    }

    // Group by project for display. The group key keeps ungrouped repos
    // together at a stable position rather than scattering them.
    const groups = new Map<string, { label: string; entries: SystemCatalogEntry[] }>();
    for (const system of systems) {
        const label = system.projectName ?? system.projectId ?? UNGROUPED;
        const key = system.projectId ?? UNGROUPED;
        const g = groups.get(key) ?? { label, entries: [] };
        g.entries.push(system);
        groups.set(key, g);
    }

    const sortedGroups = [...groups.values()].sort((a, b) =>
        a.label.localeCompare(b.label),
    );
    for (const group of sortedGroups) {
        lines.push('');
        lines.push(`## Project: ${group.label}`);
        const sorted = [...group.entries].sort((a, b) => a.name.localeCompare(b.name));
        for (const system of sorted) {
            lines.push('');
            lines.push(`### ${system.name} (systemId: ${system.systemId})`);
            if (system.repos.length === 0) {
                lines.push('(no repo resolved — do NOT target this system)');
                continue;
            }
            const sortedRepos = [...system.repos].sort((a, b) =>
                a.name.localeCompare(b.name),
            );
            for (const repo of sortedRepos) {
                const summary = repo.summary?.trim();
                const head = summary
                    ? `- ${repo.name} (repoId: ${repo.repoId}) — ${summary}`
                    : `- ${repo.name} (repoId: ${repo.repoId})`;
                lines.push(head);
                const p = repo.path?.trim();
                if (p) lines.push(`  path: ${p}`);
            }
        }
    }
    return lines.join('\n');
}
